// マテリアル（建物の窓はシェーダーで描く）
import * as THREE from 'three';

export const shared = {
  uNight: { value: 0 },
};

export function createBuildingMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = shared.uNight;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aUvm;
        attribute float aPat;
        varying vec2 vUvm;
        varying float vPat;
        varying vec3 vWp;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vUvm = aUvm;
        vPat = aPat;
        vWp = (modelMatrix * vec4(position, 1.0)).xyz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        varying vec2 vUvm;
        varying float vPat;
        varying vec3 vWp;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        // 窓のマスク: (u, v) はメートル、sp=間隔、ww=窓の幅、fh=階高、wh=窓の高さ、sill=窓の下端
        float winMask(vec2 uv, float sp, float ww, float fh, float wh, float sill){
          vec2 f = vec2(mod(uv.x, sp), mod(uv.y, fh));
          float x0 = (sp - ww) * 0.5;
          return step(x0, f.x) * step(f.x, x0 + ww) * step(sill, f.y) * step(f.y, sill + wh);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float pat = floor(vPat + 0.5);
        float aband = 0.0;
        if (pat > 9.5) { pat -= 10.0; aband = 1.0; }
        float win = 0.0;
        float lit = 0.0;
        vec2 uv = vUvm;
        vec2 cellId = vec2(0.0);
        if (pat > 0.5) {
          if (pat < 1.5) { // 住宅
            win = winMask(uv, 3.6, 1.3, 3.0, 1.3, 0.9);
            cellId = floor(vec2(uv.x / 3.6, uv.y / 3.0));
          } else if (pat < 2.5) { // 店舗: 1階はショーウィンドウ
            if (uv.y < 3.6) {
              float f = mod(uv.x, 2.4);
              win = step(0.12, f) * step(f, 2.28) * step(0.35, uv.y) * step(uv.y, 2.9);
              cellId = vec2(floor(uv.x / 2.4), 0.0);
            } else {
              win = winMask(uv - vec2(0.0, 0.6), 3.0, 1.4, 3.0, 1.5, 0.9);
              cellId = floor(vec2(uv.x / 3.0, (uv.y - 0.6) / 3.0));
            }
          } else if (pat < 3.5) { // オフィス
            win = winMask(uv, 1.6, 1.35, 3.4, 2.2, 0.7);
            cellId = floor(vec2(uv.x / 1.6, uv.y / 3.4));
          } else if (pat < 4.5) { // 工場: 高い位置の横長窓
            float f = mod(uv.y, 7.0);
            win = step(4.2, f) * step(f, 5.6) * step(0.5, mod(uv.x, 4.0)) * step(mod(uv.x, 4.0), 3.5);
            cellId = floor(vec2(uv.x / 4.0, uv.y / 7.0));
          } else if (pat < 5.5) { // 集合住宅
            win = winMask(uv, 2.8, 1.5, 3.0, 1.5, 0.9);
            cellId = floor(vec2(uv.x / 2.8, uv.y / 3.0));
          } else { // 搬入口
            float f = mod(uv.x, 6.0);
            float door = step(1.0, f) * step(f, 5.0) * step(uv.y, 4.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45, 0.47, 0.5), door);
            win = 0.0;
          }
          float r = h21(cellId + floor(vWp.xz * 0.05));
          vec3 glass = mix(vec3(0.13, 0.17, 0.23), vec3(0.32, 0.4, 0.5), r * 0.6);
          // 空き家は窓が暗く、板でふさがれている
          if (aband > 0.5) glass = r > 0.5 ? vec3(0.28, 0.2, 0.12) : vec3(0.04);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
          lit = win * step(0.45, r) * (1.0 - aband);
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
