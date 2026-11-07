// 建物の素材の模様（プログラムで描く）。色は頂点の色を使い、ここでは明るさの細かい変化だけを持つ。
// 各模様は 256×256 の灰色の画像で、160 が「そのままの明るさ」。テクスチャ配列の1枚ずつに入れる。
// 模様1枚の中に目立つ形を置くと、広い屋根で繰り返しが見えるので、小さな変化を散らす。
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

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 繰り返しのつなぎ目が出ない、なめらかなノイズ（大きさ size、cells 個の格子）
export function valueNoise(r: () => number, cells: number, size = S) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(size * size);
  const at = (a: number, b: number) => g[(((b % cells) + cells) % cells) * cells + (((a % cells) + cells) % cells)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, fy = (y / size) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  return out;
}

export function fbm(seed: number, octaves: [number, number][], size = S) {
  const r = rng(seed);
  const out = new Float32Array(size * size);
  for (const [cells, amp] of octaves) {
    const n = valueNoise(r, cells, size);
    for (let i = 0; i < out.length; i++) out[i] += (n[i] - 0.5) * amp;
  }
  return out;
}

// 小さな点のばらつき（1〜2 画素の粒をぼかしたもの）。-0.5..0.5 くらい
export function grainNoise(seed: number, size = S) {
  const r = rng(seed);
  const w = new Float32Array(size * size).map(() => r() - 0.5);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let s = w[y * size + x] * 2;
      s += w[y * size + ((x + 1) % size)] + w[((y + 1) % size) * size + x];
      out[y * size + x] = s / 2.6;
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

// 平均を 160 にそろえる（模様を変えても、建物の色の明るさが変わらないように）
function recenter(d: Uint8Array) {
  let sum = 0;
  for (let k = 0; k < d.length; k += 4) sum += d[k];
  const shift = 160 - sum / (d.length / 4);
  for (let k = 0; k < d.length; k += 4) {
    const v = Math.max(0, Math.min(255, Math.round(d[k] + shift)));
    d[k] = d[k + 1] = d[k + 2] = v;
  }
  return d;
}

function makeLayers(): Uint8Array[] {
  const fine = fbm(11, [[64, 18], [128, 10]]);
  const blot = fbm(12, [[4, 26], [8, 16], [16, 8]]);
  const grain = grainNoise(13);
  const speck = fbm(14, [[32, 20], [64, 12]]);
  const L: Uint8Array[] = [];
  // レンガ（2.4m 四方に 32 段、10 個）。ところどころ焼き色の濃いレンガ、目地は少し奥まって影になる
  {
    const r = rng(21);
    const rows = 32, perRow = 10, bh = S / rows, bw = S / perRow;
    const tone = new Float32Array(rows * perRow * 2).map(() => {
      const t = (r() - 0.5) * 34;
      return r() < 0.1 ? t - 26 : r() < 0.08 ? t + 18 : t;
    });
    L.push(recenter(layer((x, y) => {
      const row = Math.floor(y / bh);
      const off = row % 2 ? bw / 2 : 0;
      const xx = (x + off) % S;
      const col = Math.floor(xx / bw);
      const fy = y % bh, fx = xx % bw;
      if (fy < 1.3 || fx < 1.3) return 184 + fine[y * S + x] * 0.5 + grain[y * S + x] * 14;
      // 目地のすぐ下は影（奥まった目地）、レンガの角は少し丸く暗い
      const edge = Math.min(fy - 1.3, bh - fy, fx - 1.3, bw - fx);
      const shade = fy < 2.4 ? -14 : edge < 0.9 ? -6 : 0;
      return 150 + tone[row * perRow * 2 + col] + fine[y * S + x] * 0.8 + blot[y * S + x] * 0.45 + grain[y * S + x] * 18 + shade;
    })));
  }
  // コンクリートの板（6m 四方に 2×2 枚）。型枠の穴、板の境目、ごく薄い雨だれ
  {
    const r = rng(31);
    const tone = [0, 0, 0, 0].map(() => (r() - 0.5) * 12);
    const streak = fbm(32, [[32, 30], [64, 12]]);
    L.push(recenter(layer((x, y) => {
      const px = Math.floor(x / 128), py = Math.floor(y / 128);
      const fx = x % 128, fy = y % 128;
      if (fx < 2 || fy < 2) return 118;
      // 型枠の穴（板1枚に 4×4 個）
      const hx = (fx + 16) % 32 - 16, hy = (fy + 16) % 32 - 16;
      const hole = hx * hx + hy * hy < 2.2 ? -34 : 0;
      const s = Math.max(0, streak[x] * 0.45) * (1 - fy / 128); // 縦の雨だれ（上ほど濃い）
      return 160 + tone[py * 2 + px] + fine[y * S + x] * 0.45 + blot[y * S + x] * 0.5 + grain[y * S + x] * 10 - s + hole;
    })));
  }
  // しっくい（吹き付けの細かいざらつきと、ごく弱いむら）
  L.push(recenter(layer((x, y) => 160 + grain[y * S + x] * 16 + speck[y * S + x] * 0.35 + blot[y * S + x] * 0.55)));
  // 横張りの外壁（2.4m に 12 枚。板の下側に影、ところどころ板の継ぎ目）
  {
    const r = rng(41);
    const rows = 12, rh = S / rows;
    const joint = new Float32Array(rows).map(() => r() * S);
    L.push(recenter(layer((x, y) => {
      const row = Math.floor(y / rh);
      const t = (y % rh) / rh;
      const shade = t > 0.88 ? -42 : (0.5 - t) * 14;
      const j = Math.abs(x - joint[row]) < 1 ? -18 : 0;
      return 162 + shade + j + fine[y * S + x] * 0.3 + blot[y * S + x] * 0.35 + grain[y * S + x] * 6;
    })));
  }
  // 金属の外壁（台形のうね。4m に 8 本）と、うっすらした筋
  {
    const streak = fbm(52, [[64, 16]]);
    L.push(recenter(layer((x, y) => {
      const f = ((x / S) * 8) % 1;
      // 台形の断面：平らな山、斜面、平らな谷（斜面は光の当たり方で明るさが変わる）
      const prof = f < 0.18 ? 14 : f < 0.28 ? 14 - ((f - 0.18) / 0.1) * 34 : f < 0.78 ? -6 : f < 0.88 ? -6 + ((f - 0.78) / 0.1) * 26 : 14 + (f - 0.88) * 0;
      return 160 + prof + streak[x] * 0.5 + fine[y * S + x] * 0.25 + blot[y * S + x] * 0.6 + grain[y * S + x] * 5;
    })));
  }
  // 屋上の防水シート（2m ごとの重ね目、水たまりのあと、補修のあと、細かいしみ）
  {
    const r = rng(61);
    const patches: [number, number, number, number][] = [];
    for (let k = 0; k < 5; k++) patches.push([r() * S, r() * S, 8 + r() * 18, 6 + r() * 14]);
    const pond = fbm(62, [[8, 1], [16, 0.5]]);
    L.push(recenter(layer((x, y) => {
      let v = 166 + blot[y * S + x] * 0.7 + fine[y * S + x] * 0.3 + grain[y * S + x] * 7;
      // 重ね目：細い影と、そのとなりの明るい線
      const sx = x % 64;
      if (sx < 1.5) v -= 24;
      else if (sx < 3) v += 8;
      if (y % 128 < 1.2) v -= 14; // 巻きの端の継ぎ目
      // 水たまりのあと：ふちがぼやけた、うすいしみ
      const pv = pond[y * S + x];
      const t = Math.max(0, Math.min(1, (-pv - 0.18) / 0.16));
      v -= t * t * (3 - 2 * t) * 9;
      for (const [px, py, w, h] of patches) {
        const dx = (x - px + S) % S, dy = (y - py + S) % S;
        if (dx < w && dy < h) v += dx < 1 || dy < 1 || dx > w - 1 || dy > h - 1 ? -16 : -8;
      }
      return v + speck[y * S + x] * 0.4;
    })));
  }
  // 砂利の屋上（小石の粒、風で寄ったむら）
  {
    const r = rng(71);
    const stones = new Float32Array(S * S).map(() => (r() - 0.5) * 60);
    const drift = fbm(72, [[16, 1], [32, 0.5]]);
    L.push(recenter(layer((x, y) => {
      const s = (stones[y * S + x] * 2 + stones[y * S + ((x + 1) % S)] + stones[((y + 1) % S) * S + x]) / 3;
      return 160 + s + drift[y * S + x] * 30 + blot[y * S + x] * 0.6;
    })));
  }
  // 屋根板（段ごとに半分ずらしたタブ）。表面の粒と、雨の筋
  {
    const r = rng(81);
    const rows = 16, tabs = 12, rh = S / rows, tw = S / tabs;
    const tone = new Float32Array(rows * tabs * 2).map(() => (r() - 0.5) * 30);
    const streak = fbm(82, [[32, 18]]);
    L.push(recenter(layer((x, y) => {
      const row = Math.floor(y / rh);
      const xx = (x + (row % 2 ? tw / 2 : 0)) % S;
      const col = Math.floor(xx / tw);
      const t = (y % rh) / rh;
      if (xx % tw < 1.2) return 104;
      return 156 + tone[row * tabs * 2 + col] + (t > 0.82 ? -40 : (0.5 - t) * 16) + fine[y * S + x] * 0.35 + grain[y * S + x] * 16 + streak[x] * 0.4;
    })));
  }
  // 地面（敷地の芝生・舗装のむら）
  L.push(recenter(layer((x, y) => 160 + fine[y * S + x] * 0.6 + blot[y * S + x] * 0.9 + grain[y * S + x] * 9)));
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
