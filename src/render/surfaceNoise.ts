// 地面と道路の細かい模様に使うノイズ（つなぎ目なしで繰り返す 256×256）。RGBA に4種類を入れる
//   R: 細かい粒（アスファルトの骨材、草の粒）
//   G: 中くらいのなめらかなむら
//   B: ひび割れの細い線（ほとんどは 0）
//   A: 大きくなめらかなまだら（G とは別の模様）
// シェーダーでは、大きさと向きを変えて何段も重ねて使う（繰り返しが見えないように）
import * as THREE from 'three';
import { fbm, rng } from './textures';

const S = 256;

// 0..1 にそろえる（平均 0.5、ばらつきを sd に）
function normalize(a: Float32Array, sd: number) {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  s = Math.sqrt(s / a.length) || 1;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(0, Math.min(1, 0.5 + ((a[i] - m) / s) * sd));
  return out;
}

// 周期 S の値ノイズを、小数の座標で読む（ゆがめた座標でも、つなぎ目が出ない）
function periodicSampler(seed: number, cells: number) {
  const r = rng(seed);
  const g = new Float32Array(cells * cells).map(() => r());
  return (x: number, y: number) => {
    const fx = (x / S) * cells, fy = (y / S) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (a: number, b: number) => g[(((b % cells) + cells) % cells) * cells + (((a % cells) + cells) % cells)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function makeData() {
  const N = S * S;
  // R: 骨材の粒。白いノイズを少しぼかし、明るい小石と暗いすき間を散らす
  const r = rng(501);
  const w = new Float32Array(N).map(() => r() - 0.5);
  const grain = new Float32Array(N);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      grain[i] = w[i] * 1.6 + (w[y * S + ((x + 1) % S)] + w[((y + 1) % S) * S + x] + w[y * S + ((x + S - 1) % S)] + w[((y + S - 1) % S) * S + x]) * 0.35;
    }
  for (let k = 0; k < 2600; k++) {
    const cx = r() * S, cy = r() * S, rad = 0.7 + r() * 1.6, v = r() < 0.6 ? 0.9 + r() * 0.6 : -0.9 - r() * 0.5;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx + (cx % 1) - 0.5, dy + (cy % 1) - 0.5);
        if (d > rad) continue;
        const x = (Math.floor(cx) + dx + S) % S, y = (Math.floor(cy) + dy + S) % S;
        grain[y * S + x] = grain[y * S + x] * 0.3 + v * (1 - (d / rad) * 0.5);
      }
  }
  const R = normalize(grain, 0.17);
  // G: 中くらいのむら
  const G = normalize(fbm(502, [[8, 1], [16, 0.55], [32, 0.3], [64, 0.15]]), 0.17);
  // B: ひび割れ。ボロノイの境目（多角形のひびの網）を、少しゆがめ、ところどころ切って細い線にする
  const B = new Float32Array(N);
  {
    const G = 7, cs = S / G;
    const rr = rng(503);
    const px = new Float32Array(G * G), py = new Float32Array(G * G);
    for (let k = 0; k < G * G; k++) { px[k] = (k % G + 0.15 + rr() * 0.7) * cs; py[k] = (Math.floor(k / G) + 0.15 + rr() * 0.7) * cs; }
    const wx = periodicSampler(505, 8), wy = periodicSampler(506, 8), mask = periodicSampler(507, 4);
    const keep = (a: number, b: number) => {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      let h = Math.imul(lo + 17, 374761393) ^ Math.imul(hi + 31, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296 < 0.62;
    };
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const ux = x + (wx(x, y) - 0.5) * 9, uy = y + (wy(x, y) - 0.5) * 9;
        const cx = Math.floor(ux / cs), cy = Math.floor(uy / cs);
        let d1 = 1e9, d2 = 1e9, i1 = -1, i2 = -1;
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const gx = cx + ox, gy = cy + oy;
            const k = (((gy % G) + G) % G) * G + (((gx % G) + G) % G);
            const qx = px[k] + Math.floor(gx / G) * S, qy = py[k] + Math.floor(gy / G) * S;
            const d = Math.hypot(ux - qx, uy - qy);
            if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = k; } else if (d < d2) { d2 = d; i2 = k; }
          }
        const e = (d2 - d1) * 0.5; // 境目までの距離（画素）
        const line = Math.max(0, 1 - e / 0.9);
        const m = Math.max(0, Math.min(1, (mask(x, y) - 0.3) * 3));
        B[y * S + x] = keep(i1, i2) ? line * m : 0;
      }
  }
  // A: 大きなまだら
  const A = normalize(fbm(508, [[4, 1], [8, 0.5], [16, 0.25]]), 0.19);
  const d = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    d[i * 4] = Math.round(R[i] * 255);
    d[i * 4 + 1] = Math.round(G[i] * 255);
    d[i * 4 + 2] = Math.round(B[i] * 255);
    d[i * 4 + 3] = Math.round(A[i] * 255);
  }
  return d;
}

let tex: THREE.DataTexture | null = null;
export function surfaceNoise(): THREE.DataTexture {
  if (tex) return tex;
  tex = new THREE.DataTexture(makeData(), S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// シェーダーで使う共通の関数
export const SURF_GLSL = `
uniform sampler2D uSurf;
float sHash(vec2 p){ p = fract(p * vec2(127.13, 311.71)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
// a..b の範囲なら 1（ふちは画面の 1 画素ぶんぼかす）
float sBox(float a, float b, float x, float w){ return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }
// 細い線（幅 lw、x=0 が中心）。遠くて線が画素より細くなったら薄くする
float sLine(float x, float lw, float fw){ float w = max(fw, 1e-4); return (1.0 - smoothstep(lw * 0.5 - w * 0.5, lw * 0.5 + w * 0.5, abs(x))) * clamp(lw / w, 0.0, 1.0); }
`;
