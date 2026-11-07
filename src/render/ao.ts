// 建物の足元の陰：建物の高さから、まわりの地面や道路を暗くする量を求める（なめらかに補間して使う）
// 1マスを 2×2 に分けた細かさで持つ。高い建物のあいだ（ビルの谷間）は、両側から空がさえぎられるので重ねて暗くする
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import type { Building } from '../sim/world';

const SUB = 2; // 1マスあたりの分割数

export const aoUniforms = {
  uAO: { value: null as THREE.DataTexture | null },
  uAON: { value: 1 },
};
let data = new Uint8Array(4);
let acc = new Float32Array(4);

function ensure(n: number) {
  if (aoUniforms.uAON.value === n && aoUniforms.uAO.value) return;
  const m = n * SUB;
  data = new Uint8Array(m * m);
  acc = new Float32Array(m * m);
  const t = new THREE.DataTexture(data, m, m, THREE.RedFormat, THREE.UnsignedByteType);
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
  const m = n * SUB;
  // acc には、空の見える割合を掛け合わせていく（1 = よく見える）
  acc.fill(1);
  for (const b of list) {
    if (b.state === 0) continue;
    const H = heightOf(b);
    // 届く範囲（マス）と、すぐそばの暗さ
    const R = Math.max(0.8, Math.min(4.5, H / 16));
    const strength = Math.min(0.9, 0.38 + H / 60);
    const x0 = Math.floor((b.x - R) * SUB), x1 = Math.ceil((b.x + b.w + R) * SUB), y0 = Math.floor((b.y - R) * SUB), y1 = Math.ceil((b.y + b.h + R) * SUB);
    for (let y = Math.max(0, y0); y < Math.min(m, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(m, x1); x++) {
        // 建物の外周からの距離（マス）
        const px = (x + 0.5) / SUB, py = (y + 0.5) / SUB;
        const dx = Math.max(b.x - px, 0, px - (b.x + b.w)), dy = Math.max(b.y - py, 0, py - (b.y + b.h));
        const d = Math.hypot(dx, dy);
        let v = 1;
        if (d > 0) {
          // 近いほど急に暗く、遠くではなめらかに消える
          const f = Math.max(0, 1 - d / R);
          v = strength * f * f * (1.6 - 0.6 * f);
        }
        acc[y * m + x] *= 1 - Math.min(1, v);
      }
  }
  for (let i = 0; i < acc.length; i++) data[i] = Math.round((1 - acc[i]) * 255);
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
