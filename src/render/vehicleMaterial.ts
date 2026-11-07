// 車・列車・人の材質。MeshStandardMaterial に、部品ごとのつや・金属感（頂点属性 aPbr）と、
// 夜の灯り、人の歩く動きを足す。環境マップ（scene.environment）がないときは、空の色で映り込みを作る
import * as THREE from 'three';
import { shared } from './materials';

// 夜の明るさ（0..1）と、歩く動きの時間（秒）。CarLayer が毎フレーム変える
export const vehicleUniforms = {
  uNightK: { value: 0 },
  uWalk: { value: 0 },
};

// 人の服・肌・髪の色（インスタンスの乱数で選ぶ）
const lin = (hs: number[]) => hs.map((h) => new THREE.Color(h));
const PANTS = lin([0x1f2a3d, 0x2b2b2e, 0x3a4a63, 0x6b6156, 0xc9bfa8, 0x4a4f57, 0x161719, 0x7d8794]);
const SKIN = lin([0xf1cfb4, 0xe8bf9c, 0xd9a882, 0xc28e66, 0x9a6a48, 0xf5d9c4]);
const HAIR = lin([0x1a1714, 0x2a211b, 0x3d2c20, 0x5a4330, 0x8a8580, 0x14120f, 0x6b4a2e]);

export function createVehicleMaterial(walk = false) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNightK = vehicleUniforms.uNightK;
    sh.uniforms.uWalk = vehicleUniforms.uWalk;
    sh.uniforms.uSkyTop = shared.uSkyTop;
    sh.uniforms.uSkyHz = shared.uSkyHz;
    sh.uniforms.uNight = shared.uNight;
    sh.uniforms.uPants = { value: PANTS };
    sh.uniforms.uSkin = { value: SKIN };
    sh.uniforms.uHair = { value: HAIR };
    let v = sh.vertexShader;
    v = v.replace(
      '#include <common>',
      `#include <common>
      attribute vec4 aPbr;
      varying vec4 vPbr;
      uniform float uWalk;
      uniform vec3 uPants[8];
      uniform vec3 uSkin[6];
      uniform vec3 uHair[7];
      #ifdef WALK
      attribute vec2 aLimb;
      #endif`,
    );
    // 色：aPbr.z = 1 は車体の色（インスタンスの色を掛ける）、2〜4 は人のズボン・肌・髪
    v = v.replace(
      '#include <color_vertex>',
      `vColor = vec4(color, 1.0);
      vPbr = aPbr;
      #ifdef USE_INSTANCING_COLOR
        float pm = aPbr.z;
        if (pm > 0.5 && pm < 1.5) vColor.rgb *= instanceColor.rgb;
        else if (pm > 1.5) {
          // 人ごとの乱数：背の高さ（行列の大きさ）から作る
          float sd = fract(length(instanceMatrix[1].xyz) * 61.7);
          if (pm < 2.5) vColor.rgb = uPants[int(fract(sd * 7.13) * 8.0)];
          else if (pm < 3.5) vColor.rgb = uSkin[int(fract(sd * 3.71) * 6.0)];
          else vColor.rgb = uHair[int(fract(sd * 5.37) * 7.0)];
        }
      #endif`,
    );
    // 歩く：脚と腕を、股・肩を中心に前後に振る。体も少し上下する
    v = v.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef WALK
      {
        float sd = fract(length(instanceMatrix[1].xyz) * 61.7);
        float ph = uWalk * 6.6 + sd * 6.283;
        float a = sin(ph) * 0.32 * aLimb.x;
        vec2 yz = vec2(transformed.y - aLimb.y, transformed.z);
        float ca = cos(a), sa = sin(a);
        if (aLimb.x != 0.0) transformed.yz = vec2(aLimb.y + yz.x * ca - yz.y * sa, yz.x * sa + yz.y * ca);
        transformed.y += abs(cos(ph)) * 0.035;
      }
      #endif`,
    );
    sh.vertexShader = v;
    let f = sh.fragmentShader;
    f = f.replace(
      '#include <common>',
      `#include <common>
      varying vec4 vPbr;
      uniform float uNightK, uNight;
      uniform vec3 uSkyTop, uSkyHz;
      // 環境マップがないときの映り込み：空のグラデーションと暗い地面。ざらつくほどぼやける
      vec3 vehSky(vec3 r, float rough) {
        float b = 0.08 + rough * 0.6;
        vec3 sky = mix(uSkyHz, uSkyTop, smoothstep(0.0, 0.65, r.y));
        vec3 gnd = uSkyHz * 0.16 + vec3(0.03);
        return mix(gnd, sky, smoothstep(-b, b * 0.6, r.y)) * (1.0 - 0.75 * uNight);
      }`,
    );
    f = f.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;');
    f = f.replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;');
    // 灯り：1 = 前照灯（昼も少し光る）、2 = 尾灯、3 = 表示板・行灯、4 = 窓（夜は車内の明かり）
    f = f.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float ek = vPbr.w;
        if (ek > 0.5) {
          if (ek < 1.5) totalEmissiveRadiance += diffuseColor.rgb * (0.12 + 3.2 * uNightK);
          else if (ek < 2.5) totalEmissiveRadiance += diffuseColor.rgb * (0.04 + 2.6 * uNightK);
          else if (ek < 3.5) totalEmissiveRadiance += diffuseColor.rgb * (0.25 + 1.8 * uNightK);
          else totalEmissiveRadiance += vec3(1.0, 0.9, 0.72) * 0.55 * uNightK;
        }
        // 夜でも車体が真っ黒にならないように、少しだけ持ち上げる（街灯の明かりの代わり）
        totalEmissiveRadiance += (diffuseColor.rgb * 0.06 + vec3(0.012, 0.013, 0.016)) * uNightK;
      }`,
    );
    f = f.replace(
      '#include <lights_fragment_maps>',
      `#include <lights_fragment_maps>
      #if defined( RE_IndirectSpecular ) && !defined( USE_ENVMAP )
        // ガラスは映り込みを強めに（暗い車内に空が映る）
        radiance += vehSky(inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix), material.roughness) * (vPbr.x < 0.06 ? 1.9 : 0.85);
      #endif`,
    );
    sh.fragmentShader = f;
  };
  m.customProgramCacheKey = () => (walk ? 'vehicle-walk' : 'vehicle');
  if (walk) m.defines = { WALK: '' };
  return m;
}
