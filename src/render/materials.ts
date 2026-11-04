// マテリアル（建物の窓はシェーダーで描く）
import * as THREE from 'three';
import { detailTexture, MAT_TILE_M } from './textures';

export const shared = {
  uNight: { value: 0 },
};

export function createBuildingMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = shared.uNight;
    sh.uniforms.uDetail = { value: detailTexture() };
    sh.uniforms.uTile = { value: MAT_TILE_M };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aUvm;
        attribute float aPat;
        attribute float aMat;
        varying float vMat;
        varying vec2 vUvm;
        varying float vPat;
        varying vec3 vWp;
        varying float vNy;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vUvm = aUvm;
        vPat = aPat;
        vMat = aMat;
        vNy = normal.y;
        vWp = (modelMatrix * vec4(position, 1.0)).xyz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform highp sampler2DArray uDetail;
        uniform float uTile[10];
        varying float vMat;
        varying vec2 vUvm;
        varying float vPat;
        varying vec3 vWp;
        varying float vNy;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        // a..b の範囲なら 1（ふちはなめらかにして、ギザギザとちらつきを抑える）
        float box1(float a, float b, float x, float w){ return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }
        // 窓のマスク: (u, v) はメートル、sp=間隔、ww=窓の幅、fh=階高、wh=窓の高さ、sill=窓の下端
        float winMask(vec2 uv, float sp, float ww, float fh, float wh, float sill){
          vec2 f = vec2(mod(uv.x, sp), mod(uv.y, fh));
          float x0 = (sp - ww) * 0.5;
          vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
          return box1(x0, x0 + ww, f.x, w.x) * box1(sill, sill + wh, f.y, w.y);
        }
        // 窓の上側の影（壁の奥にあるように見せる）
        float winTopShade(vec2 uv, float fh, float wh, float sill){
          float fy = mod(uv.y, fh);
          return smoothstep(sill + wh - 0.35, sill + wh, fy);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // 素材の模様（レンガ、コンクリート、屋上など）。壁は面の座標、上を向いた面は世界の座標で貼る
        float mat = floor(vMat + 0.5);
        if (mat > 0.5) {
          vec2 tuv = vNy > 0.2 ? vWp.xz : (abs(vUvm.x) + abs(vUvm.y) > 0.0001 ? vUvm : vec2(vWp.x + vWp.z, vWp.y));
          float det = texture(uDetail, vec3(tuv / uTile[int(mat)], mat - 1.0)).r * 1.6;
          diffuseColor.rgb *= mix(1.0, det, 0.9);
        }
        float pat = floor(vPat + 0.5);
        float aband = 0.0;
        if (pat > 9.5) { pat -= 10.0; aband = 1.0; }
        float win = 0.0;
        float lit = 0.0;
        vec2 uv = vUvm;
        vec2 cellId = vec2(0.0);
        float frame = 0.0;
        float shade = 0.0;
        if (pat > 0.5) {
          if (pat < 1.5) { // 住宅
            win = winMask(uv, 3.6, 1.3, 3.0, 1.3, 0.9);
            frame = winMask(uv + vec2(0.0, 0.12), 3.6, 1.6, 3.0, 1.55, 0.9) - win;
            shade = winTopShade(uv, 3.0, 1.3, 0.9);
            cellId = floor(vec2(uv.x / 3.6, uv.y / 3.0));
          } else if (pat < 2.5) { // 店舗: 1階はショーウィンドウ
            if (uv.y < 3.6) {
              float f = mod(uv.x, 2.4);
              vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
              win = box1(0.12, 2.28, f, w.x) * box1(0.35, 2.9, uv.y, w.y);
              cellId = vec2(floor(uv.x / 2.4), 0.0);
            } else {
              win = winMask(uv - vec2(0.0, 0.6), 3.0, 1.4, 3.0, 1.5, 0.9);
              frame = winMask(uv - vec2(0.0, 0.48), 3.0, 1.7, 3.0, 1.75, 0.9) - win;
              cellId = floor(vec2(uv.x / 3.0, (uv.y - 0.6) / 3.0));
            }
          } else if (pat < 3.5) { // オフィス
            win = winMask(uv, 1.6, 1.35, 3.4, 2.2, 0.7);
            shade = winTopShade(uv, 3.4, 2.2, 0.7) * 0.6;
            cellId = floor(vec2(uv.x / 1.6, uv.y / 3.4));
          } else if (pat < 4.5) { // 工場: 高い位置の横長窓
            float f = mod(uv.y, 7.0);
            vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
            win = box1(4.2, 5.6, f, w.y) * box1(0.5, 3.5, mod(uv.x, 4.0), w.x);
            cellId = floor(vec2(uv.x / 4.0, uv.y / 7.0));
          } else if (pat < 5.5) { // 集合住宅
            win = winMask(uv, 2.8, 1.5, 3.0, 1.5, 0.9);
            frame = winMask(uv + vec2(0.0, 0.12), 2.8, 1.8, 3.0, 1.75, 0.9) - win;
            shade = winTopShade(uv, 3.0, 1.5, 0.9);
            cellId = floor(vec2(uv.x / 2.8, uv.y / 3.0));
          } else { // 搬入口
            float f = mod(uv.x, 6.0);
            float door = step(1.0, f) * step(f, 5.0) * step(uv.y, 4.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45, 0.47, 0.5), door);
            win = 0.0;
          }
          float r = h21(cellId + floor(vWp.xz * 0.05));
          vec3 glass = mix(vec3(0.13, 0.17, 0.23), vec3(0.32, 0.4, 0.5), r * 0.6);
          // 空の映り込み（上の階ほど明るく、窓ごとに少し違う）
          float refl = (0.16 + 0.14 * r + 0.12 * smoothstep(0.0, 60.0, vWp.y)) * (1.0 - uNight);
          glass = mix(glass, vec3(0.6, 0.7, 0.82), refl);
          // 空き家は窓が暗く、板でふさがれている
          if (aband > 0.5) glass = r > 0.5 ? vec3(0.28, 0.2, 0.12) : vec3(0.04);
          glass *= 1.0 - shade * 0.45;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.85, 0.82), clamp(frame, 0.0, 1.0) * 0.55 * (1.0 - aband));
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
          lit = win * step(0.45, r) * (1.0 - aband);
        }
        if (vNy < 0.5) {
          float ao = mix(0.68, 1.0, smoothstep(0.0, 5.0, vUvm.y));
          diffuseColor.rgb *= ao;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.82, 0.5) * lit * uNight * 0.9;`,
      );
  };
  return m;
}
