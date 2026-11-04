// 建物の足元の陰：建物の高さから、まわりの地面や道路を暗くする量をマスごとに求める（なめらかに補間して使う）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import type { Building } from '../sim/world';

export const aoUniforms = {
  uAO: { value: null as THREE.DataTexture | null },
  uAON: { value: 1 },
};
let data = new Uint8Array(4);

function ensure(n: number) {
  if (aoUniforms.uAON.value === n && aoUniforms.uAO.value) return;
  data = new Uint8Array(n * n);
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  aoUniforms.uAO.value = t;
  aoUniforms.uAON.value = n;
}
ensure(1);

// 建物のおおよその高さ（m）
function heightOf(b: Building) {
  if (b.floors > 0) return b.floors * 3.3 + 4;
  if (b.civic) return 9;
  return b.den > 0 ? 10 : 6;
}

export function updateAO(g: Grid, list: Building[]) {
  const n = g.n;
  ensure(n);
  data.fill(0);
  for (const b of list) {
    if (b.state === 0) continue;
    const H = heightOf(b);
    const R = Math.max(1, Math.min(4, H / 18));
    const strength = Math.min(0.9, 0.35 + H / 60);
    const x0 = Math.floor(b.x - R), x1 = Math.ceil(b.x + b.w + R), y0 = Math.floor(b.y - R), y1 = Math.ceil(b.y + b.h + R);
    for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) {
        // 建物の外周からの距離（マス）
        const dx = Math.max(b.x - (x + 0.5), 0, x + 0.5 - (b.x + b.w)), dy = Math.max(b.y - (y + 0.5), 0, y + 0.5 - (b.y + b.h));
        const d = Math.hypot(dx, dy);
        const v = d <= 0 ? 1 : strength * Math.max(0, 1 - d / (R + 0.5));
        const i = y * n + x;
        const q = Math.round(v * 255);
        if (q > data[i]) data[i] = q;
      }
  }
  aoUniforms.uAO.value!.needsUpdate = true;
}

// マテリアルのシェーダーに、足元の陰を加える（world は世界座標の varying の名前）
export const AO_DECL = 'uniform sampler2D uAO; uniform float uAON;';
export function aoExpr(world: string, strength: number) {
  return `(1.0 - ${strength.toFixed(2)} * texture2D(uAO, (${world}.xz / ${CELL.toFixed(1)}) / uAON).r)`;
}

// ふつうの Lambert マテリアル（道路など）に足元の陰を加える
export function withAO<T extends THREE.Material>(m: T, strength: number): T {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, aoUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAw;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvAw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAw;\n' + AO_DECL)
      .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.rgb *= ${aoExpr('vAw', strength)};`);
  };
  m.customProgramCacheKey = () => `ao-${strength}`;
  return m;
}
