// 線路の行き止まりでの折り返し：行き止まりの手前に X 字の分岐器（シーサスクロッシング）を置き、
// 着いた列車は分岐器で反対側の線路へ渡ってから止まり、向きを変えて出ていく（右側通行）。
import { Grid } from '../sim/grid';
import { CELL, DX, DY, opp } from '../sim/constants';
import type { LineKind } from '../sim/defs';
import { TRAIN_SPEC } from './vehicles';

export interface Turnback {
  end: number; // 行き止まりのマス
  ex: number; // 列車が止まる点（行き止まりのマスの入口の辺）
  ez: number;
  ux: number; // 行き止まりへ向かう向き（単位ベクトル）
  uz: number;
  d0: number; // 分岐器の始まり（止まる点からの距離、m）
  d1: number; // 分岐器の終わり
}

// 列車の長さから、分岐器の位置を決める（列車がすべて分岐器を渡り切ってから止まるように）
export function turnbackZone(kind: Exclude<LineKind, 'hsr'>): [number, number] {
  const S = TRAIN_SPEC[kind];
  const len = (S.cars - 1) * (S.L + S.gap) + S.L;
  const d1 = len + 8;
  return [d1, d1 + CELL * 1.6];
}

// 線路の行き止まりのうち、手前がまっすぐ十分に続いているもの（マップの端は、隣の都市へ出ていくので除く）
export function findTurnbacks(g: Grid, kind: Exclude<LineKind, 'hsr'>): Map<number, Turnback> {
  const n = g.n, mask = g[kind], out = new Map<number, Turnback>();
  const [d1, d0] = turnbackZone(kind);
  for (let i = 0; i < n * n; i++) {
    const m = mask[i];
    if (!m || m & (m - 1)) continue; // つながりが 1 つだけ
    const x = i % n, y = (i / n) | 0;
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) continue;
    const e = 31 - Math.clz32(m); // 行き止まりから線路の方向
    const step = Math.hypot(DX[e], DY[e]) * CELL;
    const need = Math.ceil((d0 + CELL) / step);
    let ok = true;
    for (let k = 1; k <= need && ok; k++) {
      const cx = x + DX[e] * k, cy = y + DY[e] * k;
      if (!g.inb(cx, cy)) { ok = false; break; }
      const mk = mask[cy * n + cx];
      if (mk !== ((1 << e) | (1 << opp(e)))) ok = false;
    }
    if (!ok) continue;
    const l = Math.hypot(DX[e], DY[e]);
    const ux = -DX[e] / l, uz = -DY[e] / l;
    const ex = (x + 0.5) * CELL + DX[e] * CELL * 0.5, ez = (y + 0.5) * CELL + DY[e] * CELL * 0.5;
    out.set(i, { end: i, ex, ez, ux, uz, d0, d1 });
  }
  return out;
}

// ---- 島式ホームの駅：駅の前後で線路が左右に広がる ----
export const ISLAND_GAP = 5.8; // 島式の駅での、中心から線路までの距離（ふだんは TRACK_GAP）
const ISLAND_TAPER = CELL * 1.3; // 広がる・狭まる区間の長さ
export interface Island {
  ax: number; // ホームの始まり（線路の中心線上）
  az: number;
  ux: number; // 線路の向き
  uz: number;
  len: number; // ホームの長さ
}
// 島式にした駅（まっすぐな区間のもの）
export function findIslands(g: Grid, list: { type: string; x: number; y: number; w: number; h: number }[]): Island[] {
  const n = g.n, out: Island[] = [], seen = new Uint8Array(n * n);
  const groups: number[][] = [];
  for (let i = 0; i < n * n; i++) {
    if (!g.pstyle[i] || !g.erail[i] || seen[i]) continue;
    // つながっている島式のホームのマスを集める（線路沿い）
    const comp: number[] = [], st = [i];
    seen[i] = 1;
    while (st.length) {
      const c = st.pop()!;
      comp.push(c);
      const x = c % n, y = (c / n) | 0;
      for (let d = 0; d < 8; d++) {
        if (!(g.erail[c] & (1 << d))) continue;
        const nx = x + DX[d], ny = y + DY[d];
        if (!g.inb(nx, ny)) continue;
        const j = ny * n + nx;
        if (seen[j] || !g.pstyle[j] || !g.erail[j]) continue;
        seen[j] = 1;
        st.push(j);
      }
    }
    groups.push(comp);
  }
  void list;
  for (const comp of groups) {
    const m = g.erail[comp[0]];
    let d = -1;
    for (let k = 0; k < 4; k++) if (m & (1 << k) && m & (1 << (k + 4))) { d = k; break; }
    if (d < 0) for (let k = 0; k < 8; k++) if (m & (1 << k)) { d = k & 3; break; }
    if (d < 0) continue;
    const l = Math.hypot(DX[d], DY[d]), ux = DX[d] / l, uz = DY[d] / l;
    let t0 = Infinity, t1 = -Infinity, ox = 0, oz = 0;
    const c0 = comp[0], cx0 = ((c0 % n) + 0.5) * CELL, cz0 = (((c0 / n) | 0) + 0.5) * CELL;
    for (const c of comp) {
      const cx = ((c % n) + 0.5) * CELL, cz = (((c / n) | 0) + 0.5) * CELL;
      const t = (cx - cx0) * ux + (cz - cz0) * uz;
      if (t < t0) { t0 = t; ox = cx; oz = cz; }
      t1 = Math.max(t1, t);
    }
    const hl = (CELL * l) / 2;
    out.push({ ax: ox - ux * hl, az: oz - uz * hl, ux, uz, len: t1 - t0 + 2 * hl });
  }
  return out;
}
// その点での「広がり具合」（0 = ふだん、1 = 島式のホームのところ）
export function islandSpread(islands: Island[], x: number, z: number): number {
  let best = 0;
  for (const s of islands) {
    const rx = x - s.ax, rz = z - s.az;
    const t = rx * s.ux + rz * s.uz, perp = Math.abs(rx * -s.uz + rz * s.ux);
    if (perp > 12) continue;
    let v = 0;
    if (t >= 0 && t <= s.len) v = 1;
    else if (t < 0 && t > -ISLAND_TAPER) v = 1 + t / ISLAND_TAPER;
    else if (t > s.len && t < s.len + ISLAND_TAPER) v = 1 - (t - s.len) / ISLAND_TAPER;
    v = v * v * (3 - 2 * v);
    if (v > best) best = v;
  }
  return best;
}
