// 地面の質感：頂点の色に、いくつもの大きさのむら（草の色合い、土の見えるところ、細かい草の粒）を重ねる。
// 大きさの違うノイズを、向きを変えて重ねるので、繰り返しの模様は見えない。遠くではミップマップで自然に平らになる
import * as THREE from 'three';
import { surfaceNoise, SURF_GLSL } from './surfaceNoise';
import { AO_DECL, aoExpr, aoUniforms } from './ao';

export function createGroundMaterial(params: THREE.MeshLambertMaterialParameters = {}, ao = true) {
  const m = new THREE.MeshLambertMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSurf = { value: surfaceNoise() };
    Object.assign(sh.uniforms, aoUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGw;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGw;\n' + SURF_GLSL + AO_DECL)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 p = vGw.xz;
          // 大きさと向きの違う4段のノイズ
          vec4 nL = texture2D(uSurf, p * (1.0 / 733.0) + vec2(0.13, 0.71));
          vec4 nM = texture2D(uSurf, mat2(0.8, -0.6, 0.6, 0.8) * p * (1.0 / 151.0));
          vec4 nS = texture2D(uSurf, mat2(0.28, 0.96, -0.96, 0.28) * p * (1.0 / 31.0) + 0.37);
          vec4 nF = texture2D(uSurf, mat2(0.6, 0.8, -0.8, 0.6) * p * (1.0 / 5.3));
          vec3 c = diffuseColor.rgb;
          float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
          float grassy = clamp((c.g - max(c.r, c.b)) * 14.0, 0.0, 1.0); // 緑の地面
          // ---- 草地 ----
          float macro = nL.a * 0.6 + nM.g * 0.4;
          float mid = nS.g;
          // 少しだけ落ち着いた、自然な緑に（彩度を少し下げる）
          vec3 g = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 0.86) * vec3(0.95, 0.94, 0.97);
          // 乾いた草（黄色っぽい）と、しげった草（深い緑）
          float dry = smoothstep(0.48, 0.78, macro + (mid - 0.5) * 0.6);
          float lush = smoothstep(0.55, 0.2, nM.a + (mid - 0.5) * 0.6);
          g *= mix(vec3(1.0), vec3(1.2, 1.07, 0.7), dry * 0.8);
          g *= mix(vec3(1.0), vec3(0.72, 0.88, 0.76), lush * 0.65);
          // 草むらの明るさのむら（中くらい、細かい）
          g *= 0.8 + 0.4 * mid;
          g *= 0.84 + 0.32 * nF.g;
          g *= 0.9 + 0.2 * nF.r;
          // 土が見えるところ（すり減った草地、小道のようなところ）
          float dirtN = nS.a * 0.5 + nM.a * 0.35 + nF.g * 0.15;
          float dirt = smoothstep(0.73, 0.8, dirtN);
          vec3 soil = vec3(0.15, 0.115, 0.075) * (0.8 + 0.4 * nF.r) * (0.85 + 0.3 * nS.g);
          g = mix(g, soil, dirt * 0.6);
          // 土のまわりは草がまばら（黄色っぽい）
          g = mix(g, g * vec3(1.1, 1.02, 0.78), smoothstep(0.62, 0.74, dirtN) * (1.0 - dirt) * 0.5);
          // ---- 砂・岩・川底（緑でない地面）：粒とむら、岩はひびの線 ----
          vec3 o = c * (0.86 + 0.28 * mid) * (0.9 + 0.2 * nF.r);
          float rocky = clamp(1.0 - sat * 9.0, 0.0, 1.0) * (1.0 - grassy);
          o *= 1.0 - nS.b * 0.35 * rocky;
          c = mix(o, g, grassy);
          diffuseColor.rgb = c${ao ? ' * ' + aoExpr('vGw', 0.42) : ''};
        }`,
      );
  };
  m.customProgramCacheKey = () => `ground2-${ao ? 1 : 0}`;
  return m;
}
