// 地形の自動生成
import { Grid } from './grid';
import { Rng, hash2 } from './rng';
import { WATER_LEVEL } from './constants';

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smooth(x - xi), ty = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

export function fbm(x: number, y: number, seed: number, oct = 5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

export type MapStyle = 'river' | 'coast' | 'lakes';

export function generateTerrain(g: Grid, seed: number, style: MapStyle) {
  const n = g.n;
  const rng = new Rng(seed);
  const V = n + 1;
  const h = g.heights;
  // 大きなマップでも、山や谷の大きさ（m）は変えない
  const S = n / 128;

  // 基本の起伏
  for (let y = 0; y < V; y++) {
    for (let x = 0; x < V; x++) {
      const u = x / n, v = y / n;
      const base = fbm(u * 3.2 * S, v * 3.2 * S, seed);
      const hills = fbm(u * 7 * S + 10, v * 7 * S + 10, seed + 7, 4);
      let e = (base - 0.45) * 70 + (hills - 0.5) * 18 + 14;
      // マップ中央は少しなだらかに
      const cx = u - 0.5, cy = v - 0.5;
      const centerFlat = Math.max(0, 1 - Math.sqrt(cx * cx + cy * cy) * 2.2 * (S > 1 ? 0.8 : 1));
      e = e * (1 - centerFlat * 0.55) + 12 * centerFlat * 0.55;
      h[y * V + x] = e;
    }
  }

  if (style === 'coast') {
    // 片側を海にする
    const side = rng.int(4);
    for (let y = 0; y < V; y++) {
      for (let x = 0; x < V; x++) {
        const t = [x / n, y / n, 1 - x / n, 1 - y / n][side];
        const wobble = (fbm(x / 18, y / 18, seed + 99, 3) - 0.5) * 0.18;
        const d = (t + wobble / S - 0.22 / S) * S;
        if (d < 0.12) {
          const k = Math.max(0, Math.min(1, d / 0.12));
          h[y * V + x] = h[y * V + x] * smooth(k) + (-14 + d * 60) * (1 - smooth(k));
        }
      }
    }
  }

  if (style === 'river' || style === 'lakes') {
    // 蛇行する川を1本掘る
    const horizontal = rng.next() < 0.5;
    const phase = rng.range(0, Math.PI * 2);
    const amp = rng.range(8, 18);
    const offset = rng.range(0.3, 0.7) * n;
    const width = style === 'river' ? rng.range(3.2, 5) : 2.2;
    for (let y = 0; y < V; y++) {
      for (let x = 0; x < V; x++) {
        const along = horizontal ? x : y;
        const across = horizontal ? y : x;
        const center = offset + Math.sin(along / 19 + phase) * amp + (fbm(along / 30, 3, seed + 5, 2) - 0.5) * 20;
        const dist = Math.abs(across - center);
        const bank = width * 2.6;
        if (dist < bank) {
          const k = dist / bank;
          const riverBed = -5 + k * k * 9;
          const t = smooth(Math.min(1, k * 1.15));
          h[y * V + x] = Math.min(h[y * V + x], riverBed * (1 - t) + h[y * V + x] * t);
        }
      }
    }
  }

  if (style === 'lakes') {
    for (let k = 0; k < Math.round(3 * S * S); k++) {
      const lx = rng.range(0.15, 0.85) * n, ly = rng.range(0.15, 0.85) * n, r = rng.range(5, 10);
      for (let y = 0; y < V; y++) {
        for (let x = 0; x < V; x++) {
          const d = Math.hypot(x - lx, y - ly) / r;
          if (d < 1.6) {
            const t = smooth(Math.min(1, Math.max(0, (d - 0.6) / 1.0)));
            h[y * V + x] = Math.min(h[y * V + x], -5 * (1 - t) + h[y * V + x] * t);
          }
        }
      }
    }
  }

  // なめらかにする（2回）
  const tmp = new Float32Array(h.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < V; y++) {
      for (let x = 0; x < V; x++) {
        let s = 0, c = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox, yy = y + oy;
          if (xx < 0 || yy < 0 || xx >= V || yy >= V) continue;
          const w = ox === 0 && oy === 0 ? 4 : 1;
          s += h[yy * V + xx] * w;
          c += w;
        }
        tmp[y * V + x] = s / c;
      }
    }
    h.set(tmp);
  }

  // 水際はくっきりさせる（浅瀬を減らす）
  for (let i = 0; i < h.length; i++) {
    const e = h[i];
    if (e > WATER_LEVEL - 0.6 && e < WATER_LEVEL + 0.8) h[i] = e < WATER_LEVEL + 0.1 ? WATER_LEVEL - 0.8 : WATER_LEVEL + 0.9;
  }

  // 森
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (g.isWater(x, y)) continue;
      const f = fbm(x / 14 + 50, y / 14 + 50, seed + 3, 3);
      const slope = g.cellMaxH(x, y) - g.cellMinH(x, y);
      let t = 0;
      if (f > 0.62) t = 3;
      else if (f > 0.55) t = 2;
      else if (f > 0.5 || (slope > 4 && f > 0.4)) t = 1;
      else if (hash2(x, y, seed) < 0.04) t = 1;
      g.tree[y * n + x] = t;
    }
  }
}
