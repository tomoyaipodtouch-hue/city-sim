// 都市高速のランプ（高速道路の横の1×5マス）の、描く形と車の道すじ
//
// シミュレーションのマスはそのままで、描くときだけ1本のなめらかな曲線にする。
//   本線から接するように分かれ、本線のすぐ横を並んで下り、真ん中のマス（地上）の手前で離れる（入口は逆の順）。
//   高さは、本線の高さから地上まで、両端で勾配 0 のなめらかな形（3次）で下りる。
// 道路の層（描く）と車の層（車の位置）が同じ形を使う。
// 座標：s = 真ん中のマスの中心からの、本線に沿った長さ（車の進む向きが +）。o = 本線の中心からの横の長さ（ランプの側が +）
import { Grid } from '../sim/grid';
import { CELL, DX, DY, dirOf } from '../sim/constants';
import { RoadType, isUrbanElevated, isUrbanGround } from '../sim/defs';

export const UR_HALF = 3.25; // 描くランプの車道の半分の幅（シミュレーションの幅 7.5m より細い 6.5m）
export const UR_END = 56; // 本線から分かれる点（真ん中から 3.5 マス）
const UR_HUG = 8.6; // 本線と並ぶところの横の位置（欄干どうしがほぼ接する）
const UR_DESC = 18; // 分かれてから下り始めるまでの長さ（分かれ目の先端で、本線との段差がほとんどないように）

export interface URamp {
  cells: number[]; // R[-2..2]
  hw: number[]; // H[-3..3]
  level: number; // 1 = 高架
  a: number; // 車の進む向き
  ax: number;
  az: number;
  sx: number; // 本線からランプへの横向き
  sz: number;
  ox: number; // 本線の中心線の上の、s = 0 の点
  oz: number;
  hh: number[]; // 本線の路面の高さ（s = -64, -48, ..., 64）
  gh: number; // 真ん中のマスの路面の高さ
}

const sstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// 本線から分かれた点からの長さ r（0..56）での横の位置
function lateral(r: number) {
  return UR_HUG * sstep(r / 24) + (CELL - UR_HUG) * sstep((r - 24) / 28);
}
// 本線の高さ（s での）
export function urHw(U: URamp, s: number) {
  const f = Math.max(0, Math.min(8, (s + 64) / CELL)), k = Math.min(7, Math.floor(f));
  return U.hh[k] + (U.hh[k + 1] - U.hh[k]) * (f - k);
}
// ランプの路面の高さ
export function urampH(U: URamp, s: number) {
  const r = UR_END - Math.min(UR_END, Math.abs(s));
  const hu = urHw(U, s);
  return hu + (U.gh - hu) * sstep((r - UR_DESC) / (UR_END - UR_DESC));
}
export function urampO(s: number) {
  return lateral(UR_END - Math.min(UR_END, Math.abs(s)));
}

export interface UPt {
  x: number;
  z: number;
  h: number;
  tx: number; // 進む向き（s が増える向き）
  tz: number;
  o: number;
}
export function urampAt(U: URamp, s: number, out: UPt = { x: 0, z: 0, h: 0, tx: 0, tz: 1, o: 0 }) {
  const o = urampO(s);
  const e = 0.05, d = (urampO(s + e) - urampO(s - e)) / (2 * e);
  out.o = o;
  out.x = U.ox + U.ax * s + U.sx * o;
  out.z = U.oz + U.az * s + U.sz * o;
  const tx = U.ax + U.sx * d, tz = U.az + U.sz * d, l = Math.hypot(tx, tz) || 1;
  out.tx = tx / l;
  out.tz = tz / l;
  out.h = urampH(U, s);
  return out;
}
// 点の、ランプの s（本線に沿った位置）
export function urampS(U: URamp, x: number, z: number) {
  return (x - U.ox) * U.ax + (z - U.oz) * U.az;
}

// 地図の上のランプを探す（真ん中のマス R[0] は地上。両端のマスが本線へ斜めにつながる）
export function findURamps(g: Grid, lift: number): URamp[] {
  const n = g.n, N = n * n, out: URamp[] = [];
  const isRamp = (c: number, lv: number) => (lv ? g.up[c] : g.road[c]) === RoadType.Ramp;
  for (let c = 0; c < N; c++) {
    if (g.road[c] !== RoadType.Ramp) continue;
    const x = c % n, y = (c / n) | 0;
    for (const a of [0, 2, 4, 6]) {
      for (const sd of [(a + 2) & 7, (a + 6) & 7]) {
        // sd：ランプから本線への向き
        const at = (k: number, side: number) => {
          const xx = x + DX[a] * k + DX[sd] * side, yy = y + DY[a] * k + DY[sd] * side;
          return g.inb(xx, yy) ? g.idx(xx, yy) : -1;
        };
        const h0 = at(0, 1);
        if (h0 < 0) continue;
        const level = isUrbanElevated(g.up[h0]) ? 1 : isUrbanGround(g.road[h0]) ? 0 : -1;
        if (level < 0) continue;
        const cells = [-2, -1, 0, 1, 2].map((k) => at(k, 0));
        const hw = [-3, -2, -1, 0, 1, 2, 3].map((k) => at(k, 1));
        if (cells.some((q) => q < 0) || hw.some((q) => q < 0)) continue;
        if (!cells.every((q, k) => isRamp(q, level && k !== 2 ? 1 : 0))) continue;
        const ht = level ? g.up[h0] : g.road[h0];
        if (!hw.every((q) => (level ? g.up[q] : g.road[q]) === ht)) continue;
        // 出口：H[-3] → R[-2]、入口：R[2] → H[3]（流れの向きで確かめる）
        const dOut = dirOf(DX[a] - DX[sd], DY[a] - DY[sd]);
        const dIn = dirOf(DX[a] + DX[sd], DY[a] + DY[sd]);
        const fl = level ? g.flow1 : g.flow;
        if (!(fl[hw[0]] & (1 << dOut)) || !(fl[cells[4]] & (1 << dIn))) continue;
        const sx = -DX[sd], sz = -DY[sd];
        const hh: number[] = [];
        for (let k = -4; k <= 4; k++) {
          let q = at(Math.max(-3, Math.min(3, k)), 1);
          const qq = at(k, 1);
          if (qq >= 0 && (level ? g.up[qq] : g.road[qq]) === ht) q = qq;
          hh.push(g.nodeH(level * N + q) + lift);
        }
        out.push({
          cells, hw, level, a, ax: DX[a], az: DY[a], sx, sz,
          ox: (x + 0.5) * CELL - sx * CELL, oz: (y + 0.5) * CELL - sz * CELL,
          hh, gh: g.nodeH(c) + lift,
        });
      }
    }
  }
  return out;
}

// 車の層：マス（ノード・入る向き・出る向き）ごとの、曲線の上の範囲
export interface URSeg {
  U: URamp;
  s0: number; // NaN = 位置はふつうのまま（真ん中のマスで一般道へ曲がる）、高さだけ曲線から
  s1: number;
  lane0: boolean; // 車線の横のずれをなくす（曲線が車の通る線）
}
export const urKey = (node: number, din: number, d: number) => node * 64 + din * 8 + d;
export function urampSegs(g: Grid, list: URamp[]) {
  const N = g.n * g.n, m = new Map<number, URSeg>();
  for (const U of list) {
    const { a, level, cells, hw } = U;
    const sd = dirOf(-U.sx, -U.sz);
    const dOut = dirOf(DX[a] - DX[sd], DY[a] - DY[sd]);
    const dIn = dirOf(DX[a] + DX[sd], DY[a] + DY[sd]);
    const nd = (c: number, k: number) => (level && k !== 2 ? N : 0) + c;
    const put = (node: number, din: number, d: number, s0: number, s1: number, lane0 = true) => m.set(urKey(node, din, d), { U, s0, s1, lane0 });
    put(level * N + hw[0], a, dOut, -UR_END, -40);
    put(nd(cells[0], 0), dOut, a, -40, -24);
    put(nd(cells[1], 1), a, a, -24, -8);
    put(nd(cells[2], 2), a, a, -8, 8);
    put(nd(cells[3], 3), a, a, 8, 24);
    put(nd(cells[4], 4), a, dIn, 24, 40);
    put(level * N + hw[6], dIn, a, 40, UR_END, false);
    // 途中のマスに出てきた車（入る向きと出る向きが同じ）も、そのマスの範囲の曲線の上
    [-40, -24, -8, 8, 24].forEach((s0, k) => {
      if (k === 2) return;
      for (let din = 0; din < 8; din++)
        for (let d = 0; d < 8; d++) {
          const key = urKey(nd(cells[k], k), din, d);
          if (!m.has(key)) m.set(key, { U, s0, s1: s0 + 16, lane0: true });
        }
    });
    // 真ん中のマスで一般道へ出入りする（位置はふつうのまま、高さだけ）
    for (let din = 0; din < 8; din++)
      for (let d = 0; d < 8; d++) {
        const k = urKey(cells[2], din, d);
        if (!m.has(k)) m.set(k, { U, s0: NaN, s1: NaN, lane0: true });
      }
  }
  return m;
}

// 本線から分かれた点から、分かれ目の先端（本線とランプの欄干が並ぶところ）までの長さ
export function urGore(hwHalf: number, par: number) {
  for (let r = 0; r < UR_END; r += 0.25) if (lateral(r) - UR_HALF - par >= hwHalf + par + 0.06) return r;
  return UR_END;
}
// 本線から分かれた点から、ランプの外側の縁が本線の縁の外へ出るところまでの長さ（そこから外側の欄干が本線の欄干に続く）
export function urStart(hwHalf: number) {
  for (let r = 0; r < UR_END; r += 0.25) if (lateral(r) + UR_HALF >= hwHalf + 0.05) return r;
  return UR_END;
}
