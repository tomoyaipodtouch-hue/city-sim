// 地面の質感：頂点の色に、草のむら・細かいざらつき・広い範囲の色の違い（乾いた草地など）を重ねる
import * as THREE from 'three';
import { detailTexture, MAT } from './textures';

export function createGroundMaterial(params: THREE.MeshLambertMaterialParameters = {}) {
  const m = new THREE.MeshLambertMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: detailTexture() };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGw;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform highp sampler2DArray uDetail;\nvarying vec3 vGw;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 p = vGw.xz;
          float g = ${(MAT.ground - 1).toFixed(1)}, pl = ${(MAT.plaster - 1).toFixed(1)}, gr = ${(MAT.gravel - 1).toFixed(1)};
          float d1 = texture(uDetail, vec3(p / 9.0, g)).r * 1.6;
          float d2 = texture(uDetail, vec3(p / 47.0 + 0.37, g)).r * 1.6;
          float d3 = texture(uDetail, vec3(p / 2.7, gr)).r * 1.6;
          float macro = texture(uDetail, vec3(p / 310.0 + 0.11, pl)).r * 1.6;
          float macro2 = texture(uDetail, vec3(p / 137.0 + 0.53, g)).r * 1.6;
          vec3 c = diffuseColor.rgb;
          c *= mix(1.0, d1, 0.55) * mix(1.0, d2, 0.7) * mix(1.0, d3, 0.18);
          // 乾いた草地（黄色っぽい）と、しげった草地（濃い緑）のまだら
          float dry = clamp((macro - 1.0) * 4.0, 0.0, 1.0);
          float lush = clamp((1.0 - macro2) * 4.0, 0.0, 1.0);
          float grassy = clamp((c.g - max(c.r, c.b)) * 12.0, 0.0, 1.0); // 緑の地面だけに効かせる
          c = mix(c, c * vec3(1.18, 1.06, 0.78), dry * 0.55 * grassy);
          c = mix(c, c * vec3(0.82, 0.95, 0.78), lush * 0.45 * grassy);
          diffuseColor.rgb = c;
        }`,
      );
  };
  return m;
}
