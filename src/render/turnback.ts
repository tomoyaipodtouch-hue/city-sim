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
export function turnbackZone(kind: LineKind): [number, number] {
  const S = TRAIN_SPEC[kind];
  const len = (S.cars - 1) * (S.L + S.gap) + S.L;
  const d1 = len + 8;
  return [d1, d1 + CELL * 1.6];
}

// 線路の行き止まりのうち、手前がまっすぐ十分に続いているもの（マップの端は、隣の都市へ出ていくので除く）
export function findTurnbacks(g: Grid, kind: LineKind): Map<number, Turnback> {
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
