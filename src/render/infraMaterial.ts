// 高架の線路・駅・橋のマテリアル（PBR）。不透明のものとガラスの2つにまとめて、線路・駅・橋で同じ作り方を使う。
// 部品ごとの粗さ・金属らしさ・種類は、頂点の属性 aRM に入れる（テクスチャを読まずに分けられて軽い）。
// 種類：0 ふつう、1 コンクリート（むらと雨の筋）、2 ガラス（不透明。空がよく映る）
import * as THREE from 'three';
import { Buf } from './roadLayer';
import { bldQuality, shared } from './materials';
import { surfaceNoise } from './surfaceNoise';

export type Rm = readonly [rough: number, metal: number, kind: number];

// 素材（粗さ、金属らしさ、種類）
export const RM = {
  plain: [0.7, 0, 0],
  concrete: [0.9, 0, 1],
  ballast: [1, 0, 0],
  wood: [0.8, 0, 0],
  rubber: [0.92, 0, 0],
  rail: [0.3, 1, 0], // 磨かれたレールの頭
  steel: [0.42, 0.75, 0], // 亜鉛めっきの鋼（架線柱）
  alu: [0.34, 0.8, 0], // アルミの枠
  wire: [0.4, 0.9, 0],
  cable: [0.36, 0.85, 0], // 橋のケーブル
  paintSteel: [0.44, 0.3, 0], // 塗った鋼（赤いトラスなど）
  whiteSteel: [0.34, 0.25, 0], // 白く塗った鋼（アーチ）
  whiteConc: [0.6, 0, 0], // 白く塗ったコンクリート
  roof: [0.5, 0.1, 0], // 白い金属の大屋根（塗装。建物の金属と同じくらいの粗さで、日の光が白く飛ばないように）
  roofUnder: [0.62, 0, 0],
  panel: [0.4, 0.12, 0], // 塗った金属の板（壁・ホームドア）
  metalRoof: [0.45, 0.55, 0],
  post: [0.4, 0.55, 0],
  tile: [0.68, 0, 1], // ホームの床
  plastic: [0.55, 0, 0],
  gloss: [0.22, 0, 0], // 黒い表示板
  glass: [0.05, 0, 2],
} as const satisfies Record<string, Rm>;

// 色に素材を結びつける（PbrBuf は、この色の頂点にこの素材を付ける）
const REG = new Map<THREE.Color, Rm>();
export function matColor(hex: number, rm: Rm) {
  const c = new THREE.Color(hex);
  REG.set(c, rm);
  return c;
}

// 頂点ごとに素材（aRM）も記録する入れ物
export class PbrBuf extends Buf {
  R: number[] = [];
  v(x: number, y: number, z: number, c: THREE.Color, nx = 0, ny = 1, nz = 0) {
    const r = REG.get(c) ?? RM.plain;
    this.R.push(r[0], r[1], r[2]);
    return super.v(x, y, z, c, nx, ny, nz);
  }
  // 縦の面：表と裏で法線を逆にする（裏から見ても正しく光が当たり、つやが出る）
  wall(ax: number, az: number, ay0: number, ay1: number, bx: number, bz: number, by0: number, by1: number, c: THREE.Color) {
    const l = Math.hypot(bz - az, bx - ax) || 1;
    const nx = (bz - az) / l, nz = -(bx - ax) / l;
    for (const s of [1, -1]) {
      const i0 = this.v(ax, ay0, az, c, nx * s, 0, nz * s), i1 = this.v(bx, by0, bz, c, nx * s, 0, nz * s);
      const i2 = this.v(bx, by1, bz, c, nx * s, 0, nz * s), i3 = this.v(ax, ay1, az, c, nx * s, 0, nz * s);
      if (s > 0) this.I.push(i0, i2, i1, i0, i3, i2);
      else this.I.push(i0, i1, i2, i0, i2, i3);
    }
  }
  geometry(uv = false) {
    const g = super.geometry(uv);
    g.setAttribute('aRM', new THREE.Float32BufferAttribute(this.R, 3));
    return g;
  }
}

// ガラスの板：両面のマテリアルで描くので、縦の面は1枚だけ（2枚重なると濃く見える）
export class GlassBuf extends PbrBuf {
  wall(ax: number, az: number, ay0: number, ay1: number, bx: number, bz: number, by0: number, by1: number, c: THREE.Color) {
    const l = Math.hypot(bz - az, bx - ax) || 1;
    const nx = (bz - az) / l, nz = -(bx - ax) / l;
    const i0 = this.v(ax, ay0, az, c, nx, 0, nz), i1 = this.v(bx, by0, bz, c, nx, 0, nz);
    const i2 = this.v(bx, by1, bz, c, nx, 0, nz), i3 = this.v(ax, ay1, az, c, nx, 0, nz);
    this.I.push(i0, i2, i1, i0, i3, i2);
  }
}

// 映り込む空：環境マップ（なければ式）と、式だけで求める軽いもの（建物のマテリアルと同じ作り方）
const ENV_GLSL = `
uniform vec3 uSkyTop;
uniform vec3 uSkyHz;
uniform vec3 uCity;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uAmbSun;
uniform vec3 uSunDir;
vec3 infEnv(vec3 Rw, float rough){
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_PMREM )
    return textureLod(envMap, envMapRotation * Rw, roughnessToMip(rough)).rgb * envMapIntensity;
  #else
    return Rw.y > 0.0 ? mix(uSkyHz, uSkyTop, pow(Rw.y, 0.6)) : mix(uSkyHz * 0.6, uAmbGround * 3.0, clamp(-Rw.y * 4.0, 0.0, 1.0));
  #endif
}
vec3 infEnvLite(vec3 Rw, float rough){
  float h = Rw.y;
  vec3 sky = mix(uSkyHz, uSkyTop, sqrt(clamp(h, 0.0, 1.0)));
  vec3 gnd = mix(uSkyHz * 0.75, uCity, clamp(-h * 3.3, 0.0, 1.0));
  float w = 0.02 + 0.7 * rough * rough;
  vec3 col = mix(gnd, sky, smoothstep(-w, w, h));
  vec3 amb = mix(uAmbGround, uAmbSky, 0.5 + 0.5 * h) + uAmbSun * pow(0.5 + 0.5 * dot(Rw, uSunDir), 3.0);
  return mix(col, amb, smoothstep(0.35, 1.0, rough));
}`;

// まわりからの光（式）と、映り込みの向き。ガラスは見下ろしていても空が映るよう、上へ持ち上げた向きで読む
const IRR_GLSL = `
  vec3 nWa = inverseTransformDirection(geometryNormal, viewMatrix);
  iblIrradiance += PI * (mix(uAmbGround, uAmbSky, 0.5 + 0.5 * nWa.y) + uAmbSun * pow(0.5 + 0.5 * dot(nWa, uSunDir), 3.0));
  float rr = material.roughness;
  vec3 Rw = inverseTransformDirection(normalize(mix(reflect(-geometryViewDir, geometryNormal), geometryNormal, rr * rr * rr * rr)), viewMatrix);
  vec3 Rs = normalize(vec3(Rw.x, abs(Rw.y) * 0.55 + 0.05, Rw.z));`;

function bindShared(sh: THREE.WebGLProgramParametersWithUniforms) {
  for (const k of ['uSkyTop', 'uSkyHz', 'uCity', 'uAmbSky', 'uAmbGround', 'uAmbSun', 'uSunDir'] as const) sh.uniforms[k] = shared[k];
}

// 不透明のもの（コンクリート、鋼、レール、白い屋根、不透明のガラスなど）
export function createInfraMaterial(params: THREE.MeshStandardMaterialParameters = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, ...params });
  m.onBeforeCompile = (sh) => {
    const hq = bldQuality.hq;
    bindShared(sh);
    sh.uniforms.uSurf = { value: surfaceNoise() };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aRM;\nvarying vec3 vRM;\nvarying vec3 vIw;\nvarying float vINy;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRM = aRM;\nvIw = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvINy = (mat3(modelMatrix) * objectNormal).y;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${hq ? '#define INFRA_HQ' : ''}
        varying vec3 vRM;
        varying vec3 vIw;
        varying float vINy;
        uniform sampler2D uSurf;
        float gRough = 0.7;
        float gKind = 0.0;`,
      )
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + ENV_GLSL)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        gRough = vRM.x;
        gKind = floor(vRM.z + 0.5);
        {
          // コンクリート：広いむらと、縦の面には雨の筋（道路の壁と同じ模様。雨の筋は高画質のときだけ）。
          // 高画質では模様の座標の変化量を分岐の外で求める（分岐の中だとミップマップの選び方が乱れる）。
          // ふつうの画質では、なめらかなむらだけを決まった細かさで読む（変化量を求めないので、コンクリート以外の画素は軽い）
          bool up = abs(vINy) > 0.5;
          vec2 q = up ? vIw.xz : vec2(vIw.x + vIw.z, vIw.y);
          vec2 qM = mat2(0.8, -0.6, 0.6, 0.8) * q * (1.0 / 17.0);
          #ifdef INFRA_HQ
            vec2 mx = dFdx(qM), my = dFdy(qM);
            vec2 qS = vec2(q.x * (1.0 / 9.0), q.y * (1.0 / 60.0)) + 0.6;
            vec2 sx = dFdx(qS), sy = dFdy(qS);
          #endif
          if (gKind > 0.5 && gKind < 1.5) {
            #ifdef INFRA_HQ
              float mo = textureGrad(uSurf, qM, mx, my).g;
            #else
              float mo = textureLod(uSurf, qM, 2.0).g;
            #endif
            diffuseColor.rgb *= 0.9 + 0.2 * mo;
            #ifdef INFRA_HQ
              if (!up) diffuseColor.rgb *= 1.0 - smoothstep(0.5, 0.75, textureGrad(uSurf, qS, sx, sy).g) * 0.14;
            #endif
            // 汚れたところは少しざらざら
            gRough = clamp(gRough + (0.5 - mo) * 0.16, 0.3, 1.0);
          }
          // 不透明のガラス：奥が暗い（映り込みは光の計算で足す）
          if (gKind > 1.5) diffuseColor.rgb *= 0.45;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;')
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        if (gKind > 1.5) {
          // ガラスの反射率（ふつうのガラスより少し強め。遠くからでもガラスに見えるように）
          material.specularColor = vec3(0.09);
          material.specularColorBlended = vec3(0.09);
        }`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `{
        ${IRR_GLSL}
        if (gKind > 1.5) radiance += infEnv(Rs, rr);
        else {
          // ざらついた面ほど、空の映り込みは凹凸や汚れにさえぎられて弱い
          float so = mix(1.0, 0.35, smoothstep(0.45, 0.9, rr));
          #ifdef INFRA_HQ
            radiance += infEnv(Rw, rr) * so;
          #else
            radiance += infEnvLite(Rw, rr) * so;
          #endif
        }
        }`,
      );
  };
  m.customProgramCacheKey = () => 'infra-' + (bldQuality.hq ? 1 : 0);
  return m;
}

// 透明なガラス（防音壁、ホームドア、風よけ）。映り込みは不透明さに関係なく足し、斜めから見るほど映り込みが強く、向こうが見えにくい
export function createInfraGlassMaterial(opacity = 0.4) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    bindShared(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + ENV_GLSL)
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        material.specularColor = vec3(0.07);
        material.specularColorBlended = vec3(0.07);`,
      )
      .replace('#include <lights_fragment_maps>', `{\n${IRR_GLSL}\nradiance += infEnv(Rs, rr);\n}`)
      .replace(
        '#include <opaque_fragment>',
        `{
          float fr = 0.07 + 0.93 * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
          float a = mix(diffuseColor.a, 1.0, fr);
          gl_FragColor = vec4((totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance) / a, a);
        }`,
      );
  };
  m.customProgramCacheKey = () => 'infra-glass';
  return m;
}
