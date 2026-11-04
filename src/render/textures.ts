// 建物の素材の模様（プログラムで描く）。色は頂点の色を使い、ここでは明るさの細かい変化だけを持つ。
// 各模様は 256×256 の灰色の画像で、160 が「そのままの明るさ」。テクスチャ配列の1枚ずつに入れる。
import * as THREE from 'three';

export const MAT = {
  none: 0,
  brick: 1,
  concrete: 2,
  plaster: 3,
  siding: 4,
  metal: 5,
  membrane: 6,
  gravel: 7,
  shingle: 8,
  ground: 9,
} as const;
// 模様1枚の大きさ（m）
export const MAT_TILE_M = [1, 2.4, 6, 4, 2.4, 4, 8, 4, 3, 8];
const S = 256;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 繰り返しのつなぎ目が出ない、なめらかなノイズ（周期 S）
function valueNoise(r: () => number, cells: number) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * cells, fy = (y / S) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (a: number, b: number) => g[((b + cells) % cells) * cells + ((a + cells) % cells)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      out[y * S + x] = a + (b - a) * sy;
    }
  return out;
}

function fbm(seed: number, octaves: [number, number][]) {
  const r = rng(seed);
  const out = new Float32Array(S * S);
  for (const [cells, amp] of octaves) {
    const n = valueNoise(r, cells);
    for (let i = 0; i < out.length; i++) out[i] += (n[i] - 0.5) * amp;
  }
  return out;
}

type Painter = (x: number, y: number) => number; // 0..255

function layer(paint: Painter): Uint8Array {
  const d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const v = Math.max(0, Math.min(255, Math.round(paint(x, y))));
      const k = (y * S + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = v;
      d[k + 3] = 255;
    }
  return d;
}

function makeLayers(): Uint8Array[] {
  const fine = fbm(11, [[64, 18], [128, 10]]);
  const blot = fbm(12, [[4, 26], [8, 16], [16, 8]]);
  const L: Uint8Array[] = [];
  // レンガ（2.4m 四方に 32 段、10 個）
  {
    const r = rng(21);
    const rows = 32, perRow = 10, bh = S / rows, bw = S / perRow;
    const tone = new Float32Array(rows * perRow * 2).map(() => (r() - 0.5) * 46);
    L.push(layer((x, y) => {
      const row = Math.floor(y / bh);
      const off = row % 2 ? bw / 2 : 0;
      const xx = (x + off) % S;
      const col = Math.floor(xx / bw);
      const mortar = y % bh < 1.3 || xx % bw < 1.3;
      if (mortar) return 196 + fine[y * S + x] * 0.6;
      return 150 + tone[row * perRow * 2 + col] + fine[y * S + x] + blot[y * S + x] * 0.5;
    }));
  }
  // コンクリートの板（6m 四方に 2×2 枚）と雨だれ
  {
    const r = rng(31);
    const tone = [0, 0, 0, 0].map(() => (r() - 0.5) * 16);
    const streak = fbm(32, [[32, 30]]);
    L.push(layer((x, y) => {
      const px = Math.floor(x / 128), py = Math.floor(y / 128);
      if (x % 128 < 2 || y % 128 < 2) return 112;
      const s = streak[x] * 0.5 * (1 - (y % 128) / 128); // 縦の雨だれ（上ほど濃い）
      return 160 + tone[py * 2 + px] + fine[y * S + x] * 0.5 + blot[y * S + x] * 0.6 - Math.abs(s);
    }));
  }
  // しっくい（細かいざらつきとむら）
  L.push(layer((x, y) => 160 + fine[y * S + x] * 0.8 + blot[y * S + x] * 0.8));
  // 横張りの外壁（2.4m に 12 枚。板の下側に影）
  L.push(layer((x, y) => {
    const t = (y % (S / 12)) / (S / 12);
    const shade = t > 0.88 ? -42 : (0.5 - t) * 14;
    return 162 + shade + fine[y * S + x] * 0.35 + blot[y * S + x] * 0.4;
  }));
  // 波板の金属（縦のうね）
  L.push(layer((x, y) => 160 + Math.sin((x / S) * Math.PI * 2 * 8) * 18 + fine[y * S + x] * 0.3 + blot[y * S + x] * 0.7));
  // 屋上の防水シート（2m ごとの継ぎ目、むら、補修のあと）
  {
    const r = rng(61);
    const patches: [number, number, number, number][] = [];
    for (let k = 0; k < 6; k++) patches.push([r() * S, r() * S, 10 + r() * 30, 8 + r() * 20]);
    L.push(layer((x, y) => {
      let v = 168 + blot[y * S + x] * 1.1 + fine[y * S + x] * 0.35;
      if (x % 64 < 1.5 || y % 64 < 1.5) v -= 26;
      for (const [px, py, w, h] of patches) if (x > px && x < px + w && y > py && y < py + h) v -= 14;
      return v;
    }));
  }
  // 砂利の屋上
  {
    const r = rng(71);
    const speck = new Float32Array(S * S).map(() => (r() - 0.5) * 70);
    L.push(layer((x, y) => 160 + speck[y * S + x] + blot[y * S + x] * 0.8));
  }
  // 屋根板（段ごとに半分ずらしたタブ）
  {
    const r = rng(81);
    const rows = 16, tabs = 12, rh = S / rows, tw = S / tabs;
    const tone = new Float32Array(rows * tabs * 2).map(() => (r() - 0.5) * 36);
    L.push(layer((x, y) => {
      const row = Math.floor(y / rh);
      const xx = (x + (row % 2 ? tw / 2 : 0)) % S;
      const col = Math.floor(xx / tw);
      const t = (y % rh) / rh;
      if (xx % tw < 1.2) return 104;
      return 156 + tone[row * tabs * 2 + col] + (t > 0.82 ? -40 : (0.5 - t) * 18) + fine[y * S + x] * 0.4;
    }));
  }
  // 地面（芝生・舗装のむら）
  L.push(layer((x, y) => 160 + fine[y * S + x] * 0.7 + blot[y * S + x] * 1.0));
  return L;
}

let tex: THREE.DataArrayTexture | null = null;
export function detailTexture(): THREE.DataArrayTexture {
  if (tex) return tex;
  const layers = makeLayers();
  const data = new Uint8Array(S * S * 4 * layers.length);
  layers.forEach((l, i) => data.set(l, i * S * S * 4));
  tex = new THREE.DataArrayTexture(data, S, S, layers.length);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
