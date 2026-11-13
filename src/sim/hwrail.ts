// 高架の高速道路（都市高速・高架高速道路）が、高架鉄道をまたぐ所の高さ
//
// 高架鉄道の床版は地面から 8m（LINES.erail.lift）、架線柱の門型の上端はさらに 6.6m 上にある（railLayer）。
// 高速道路はふつう地面から 9〜10m なので、そのままでは線路とぶつかる。交差するマスの前後だけ、
// 高速道路を持ち上げて（約 10% の坂）、線路の上を越える。鉄道の高さは変えない。
//
// 必要な高さ（路面 = upH + ROAD_LIFT、桁の下面 = 路面 - HW_STRUCT）：
//   桁の下面 ≥ 鉄道の床版 + 架線柱の上端（6.6m）+ 余裕（0.5m）
//   → upH ≥ 鉄道の床版 + HWR_CLEAR（8.43m）。レールの上面（床版 + 0.36m）から桁の下面まで 6.74m
//
// 高速鉄道（hsr.ts）：高架橋（地面から 18m）は、ふつうの高さの高速道路ならその下をくぐる。近くの交差の坂などで
// くぐれない所や、地上・坂の区間の線路は、高速道路を架線柱の上端（床版から 7.0m、hsrLayer）の上まで持ち上げて越える。
//   upH ≥ 高速鉄道の床版（hsrPoly の高さ）+ HWH_CLEAR（8.83m）
// 交差どうしが近く、坂を下りてまた上る間が短いときは、間を高い方の交差の高さで埋め、次の交差を越えてから下りる（間でへこまない）。
//
// 高さは、交差の前後のマスの upH だけで表す（保存データは今までの配列のまま）。上げるだけなので、何回くり返しても同じ結果になる
import { Grid, ORAMP_LEN, ORAMP_ON, ORAMP_PARTNER } from './grid';
import { CELL, DX, DY, WATER_LEVEL, dirOf, isDiag, opp } from './constants';
import { LINES, ROADS, RoadType, isUrbanElevated } from './defs';
import { rampLineH } from './railRamp';
import { hsrChains, hsrDeckH, hsrPoly, HSRF_STATION, HSR_CLEAR, HSR_GIRDER, HSR_HALF } from './hsr';

export const ERAIL_CATENARY = 6.6; // 鉄道の床版から架線柱の上端まで（railLayer の架線柱の門型）
export const ERAIL_RAIL_TOP = 0.36; // 鉄道の床版からレールの上面まで
export const HW_STRUCT = 1.63; // 都市高速の路面から桁の下面まで（床版の縁 0.38m + 桁 1.25m。roadLayer の FAS + VIA_MAIN.depth）
export const HW_ROAD_LIFT = 0.3; // upH から路面まで（roadLayer の ROAD_LIFT）
export const HWR_MARGIN = 0.5; // 架線柱の上端と桁の下面の間の余裕
export const HWR_CLEAR = ERAIL_CATENARY + HWR_MARGIN + HW_STRUCT - HW_ROAD_LIFT; // 鉄道の床版から必要な upH まで（8.43m）
export const HWR_GRADE = 0.1; // 坂の勾配（10%）
const CREST = 2 * CELL; // 頂上と坂の下の、勾配がなめらかに変わる長さ（m）
const SOFT = (HWR_GRADE * CREST) / 2; // 坂の下のなめらかな曲がりの幅（高さ、m）
const MERGE_SLACK = 3 * CELL; // 近くの交差の坂をつなげる、下りと上りの坂の長さに足す余裕（m）
const MAX_STEPS = 48; // 交差から高速道路に沿って調べるマスの数
export const HSR_CATENARY = 7.0; // 高速鉄道の床版から架線柱の上端まで（hsrLayer の架線柱）
export const HWH_CLEAR = HSR_CATENARY + HWR_MARGIN + HW_STRUCT - HW_ROAD_LIFT; // 高速鉄道の床版から必要な upH まで（8.83m）
export const HWR_HSR_UNDER = true; // 高速鉄道の高架の下をくぐれる所は、くぐる（false にすると、いつも上を越える）
const RAIL_HALF = 5.35; // 鉄道の線路の中心から架線柱の外側まで（m）
const HW_HALF = 3.0; // 高速道路の中心から桁の下面の縁まで（m）

export const HWR_MSG_PARALLEL = '高架鉄道の真上に沿っては引けません（交差だけできます）';
export const HWR_MSG_PARALLEL_RAIL = '高架の高速道路の真下に沿っては引けません（交差だけできます）';
export const HWR_MSG_STATION = '高架鉄道の駅の上は通せません';
export const HWR_MSG_RAMP = '高速の坂を作る場所がありません（ランプやジャンクションが近すぎます）';
export const HWR_MSG_END = '高速の坂を作る場所がありません（高速道路の端が近すぎます）';
export const HWR_MSG_HSR_PARALLEL = '高速鉄道の線路に沿っては引けません（交差だけできます）';
export const HWR_MSG_HSR_STATION = '高速鉄道の駅の近くは、高速道路で越えられません';

// 線路の上を越える高架の高速道路の種類
export const isElevHighway = (t: number) => isUrbanElevated(t) || t === RoadType.Highway;

const nbr = (g: Grid, c: number, d: number) => {
  const x = (c % g.n) + DX[d], y = ((c / g.n) | 0) + DY[d];
  return g.inb(x, y) ? y * g.n + x : -1;
};
const bits = (m: number) => {
  const out: number[] = [];
  for (let d = 0; d < 8; d++) if (m & (1 << d)) out.push(d);
  return out;
};
const stepLen = (d: number) => (isDiag(d) ? CELL * Math.SQRT2 : CELL);

// 高架鉄道の床版の高さ（マスの中心）。RailLayer.lineH(g, 'erail', i) と同じ
export function erailDeckH(g: Grid, i: number): number {
  const n = g.n;
  // 地上の鉄道と高架鉄道を結ぶ坂の高架の部分は、坂の高さ
  if (g.rramp[i]) return rampLineH(g, i);
  const ground = Math.max(g.cellH(i % n, (i / n) | 0), WATER_LEVEL);
  if (g.isWater(i % n, (i / n) | 0)) {
    const mask = g.erail;
    const ends: { h: number; d: number }[] = [];
    for (let d0 = 0; d0 < 8 && ends.length < 2; d0++) {
      if (!(mask[i] & (1 << d0))) continue;
      let cur = i, dir = d0, dist = 0;
      for (let step = 0; step < 64; step++) {
        const x = (cur % n) + DX[dir], y = ((cur / n) | 0) + DY[dir];
        if (!g.inb(x, y)) break;
        const j = y * n + x;
        if (!mask[j]) break;
        dist += dir & 1 ? 1.41 : 1;
        cur = j;
        if (!g.isWater(x, y)) { ends.push({ h: g.cellH(x, y), d: dist }); break; }
        if (!(mask[j] & (1 << dir))) {
          let nd = -1;
          for (let k = 0; k < 8; k++) if (mask[j] & (1 << k) && k !== ((dir + 4) & 7)) { nd = k; break; }
          if (nd < 0) break;
          dir = nd;
        }
      }
    }
    const banks = ends.length >= 2 ? ends[0].h + (ends[1].h - ends[0].h) * (ends[0].d / (ends[0].d + ends[1].d)) : ends.length === 1 ? ends[0].h : null;
    if (banks !== null) return Math.max(ground, banks) + LINES.erail.lift;
  }
  return ground + LINES.erail.lift;
}

// 交差の場所での鉄道の床版の高さ（線路に沿った隣のマスとの中間までの、いちばん高い所）
function railTopAt(g: Grid, c: number) {
  const h0 = erailDeckH(g, c);
  let h = h0;
  for (const d of bits(g.erail[c])) {
    const j = nbr(g, c, d);
    if (j >= 0 && g.erail[j]) h = Math.max(h, (h0 + erailDeckH(g, j)) / 2);
  }
  return h;
}

// 高速道路のマスの「ふつうの」高さ（地面 + 高さ）。坂の下をなめらかにするときの目安
function natH(g: Grid, c: number) {
  const n = g.n;
  return Math.max(g.cellH(c % n, (c / n) | 0), WATER_LEVEL) + (ROADS[g.up[c]]?.lift ?? 9);
}

export interface HwRailCross {
  kind: 'erail' | 'hsr'; // 交差する線路（高架鉄道か、高速鉄道）
  cells: number[]; // 交差する高速道路のマス（ふつうは1つ。斜めどうしがマスの角で交わるときは2つ）
  rail: number[]; // 交差する線路のマス
  need: number; // 交差の所で必要な upH
  ok: boolean;
  reason: string;
  bad: number[]; // 問題のあるマス
  target: Map<number, number>; // 上げるマス → 新しい upH
}

// 上げてはいけない（坂にできない）マス：ランプの分かれ目、ジャンクションの近く、重ねランプの区間
function blockedCells(g: Grid): Set<number> {
  const n = g.n, N = n * n;
  const out = new Set<number>();
  for (let c = 0; c < N; c++) {
    if (g.jct[c]) {
      const x = c % n, y = (c / n) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (g.inb(x + dx, y + dy)) out.add(g.idx(x + dx, y + dy));
    }
    const v = g.oramp[c];
    if (v & ORAMP_ON) {
      const a = v & 7;
      for (let k = 0; k <= ORAMP_LEN; k++) {
        const x = (c % n) + DX[a] * k, y = ((c / n) | 0) + DY[a] * k;
        if (!g.inb(x, y)) continue;
        out.add(g.idx(x, y));
        if (v & ORAMP_PARTNER) {
          const sx = x + DX[(a + 2) & 7], sy = y + DY[(a + 2) & 7];
          if (g.inb(sx, sy)) out.add(g.idx(sx, sy));
        }
      }
    }
  }
  return out;
}

// 坂の形：交差の中心からの距離 t（m）で、頂上の高さから下がる量。頂上はなめらかに丸め（CREST）、その先は 10%
const drop = (t: number) => (t <= 0 ? 0 : t <= CREST ? (HWR_GRADE * t * t) / (2 * CREST) : HWR_GRADE * (t - CREST / 2));
// drop の逆：高さ dh 下がるのに必要な距離（m）
const reach = (dh: number) => (dh <= 0 ? 0 : dh <= (HWR_GRADE * CREST) / 2 ? Math.sqrt((2 * CREST * dh) / HWR_GRADE) : dh / HWR_GRADE + CREST / 2);
// 坂の下をなめらかにする（ふつうの高さ nat と、坂 r のなめらかな最大。r が十分低ければ r + SOFT/4 のまま）
const soft = (r: number, nat: number) => {
  const D = r - nat;
  const sp = D >= SOFT ? D : D <= -SOFT ? 0 : ((D + SOFT) * (D + SOFT)) / (4 * SOFT);
  return Math.max(r, Math.min(nat + sp, r + SOFT / 4));
};

// ---------------- 高速鉄道の線路の高さ（hsrLayer と同じ hsrPoly） ----------------
interface HsrCell { lo: number; hi: number; tx: number; tz: number } // マスにかかる床版のいちばん低い・高い所と、線路の向き
function hsrDeckCells(g: Grid): Map<number, HsrCell> {
  const out = new Map<number, HsrCell>();
  if (!g.hsr.some((v) => v !== 0)) return out;
  for (const ch of hsrChains(g)) {
    if (ch.cells.length < 2) continue;
    const P = hsrPoly(g, ch.cells, undefined, ch.pre, ch.post, ch.loop);
    for (let j = 0; j + 1 < P.n; j++) {
      const dx = P.x[j + 1] - P.x[j], dz = P.z[j + 1] - P.z[j], L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const m = Math.max(1, Math.ceil(L / 4));
      for (let q = 0; q <= m; q++) {
        const t = q / m, x = P.x[j] + dx * t, z = P.z[j] + dz * t, h = P.h[j] + (P.h[j + 1] - P.h[j]) * t;
        const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
        if (!g.inb(cx, cz)) continue;
        const c = g.idx(cx, cz);
        const e = out.get(c);
        if (!e) out.set(c, { lo: h, hi: h, tx: dx / L, tz: dz / L });
        else { e.lo = Math.min(e.lo, h); e.hi = Math.max(e.hi, h); }
      }
    }
  }
  return out;
}

// ---------------- 交差の候補 ----------------
interface Cand {
  kind: 'erail' | 'hsr';
  cells: number[];
  rail: number[];
  need: number;
  fails: [string, number[]][]; // 交差のマスそのものの問題（駅、沿って走る、ランプの分かれ目など）
  lo: number; // 高速鉄道：床版のいちばん低い所（下をくぐれるか）
  skew: boolean; // 高速鉄道：斜めに交わる（床版が隣のマスにもかかる）
}

const plainOf = (g: Grid, blocked: Set<number>) => (c: number) => bits(g.conn1[c]).length === 2 && !blocked.has(c);

// 交わる角度（度、0〜90）。高速道路の向き hb と、線路の向き（ベクトル）
function crossAngle(hb: number[], vx: number, vz: number) {
  let ang = 90;
  for (const a of hb) {
    const l = Math.hypot(DX[a], DY[a]);
    const cos = Math.abs((DX[a] * vx + DY[a] * vz) / (l * Math.hypot(vx, vz)));
    ang = Math.min(ang, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
  }
  return ang;
}
// 線路の下を通る長さ E だけ、頂上の丸みで下がる分（half = 線路の中心から外側まで）
function crestAdd(hb: number[], ang: number, half: number) {
  const th = (Math.max(ang, 30) * Math.PI) / 180;
  const E = half / Math.sin(th) + HW_HALF / Math.tan(th);
  const L = hb.some(isDiag) ? CELL * Math.SQRT2 : CELL;
  return (drop(L) * Math.min(E, L)) / L;
}

function erailCand(g: Grid, cells: number[], rail: number[], plain: (c: number) => boolean): Cand {
  const fails: [string, number[]][] = [];
  let need: number;
  if (cells.length === 2) {
    need = (erailDeckH(g, rail[0]) + erailDeckH(g, rail[1])) / 2 + HWR_CLEAR;
    if (rail.some((r) => g.estn[r])) fails.push([HWR_MSG_STATION, cells]);
  } else {
    const c = cells[0];
    const hb = bits(g.conn1[c]), rb = bits(g.erail[c]);
    if (g.erail[c] & g.conn1[c]) fails.push([HWR_MSG_PARALLEL, [c]]);
    // 駅のホーム（交差のマスと、線路に沿った隣のマス）の上は通さない
    if (g.estn[c] || rb.some((d) => { const j = nbr(g, c, d); return j >= 0 && g.estn[j] !== 0; })) fails.push([HWR_MSG_STATION, [c]]);
    // 交わる角度（45° か 90°）
    let ang = 90;
    for (const a of hb) for (const r of rb) {
      const k = Math.abs(a - r) % 4;
      const deg = Math.min(k, 4 - k) * 45;
      if (deg > 0) ang = Math.min(ang, deg);
    }
    need = railTopAt(g, c) + HWR_CLEAR + crestAdd(hb, ang, RAIL_HALF);
  }
  for (const c of cells) if (!plain(c)) fails.push([bits(g.conn1[c]).length < 2 ? HWR_MSG_END : HWR_MSG_RAMP, [c]]);
  return { kind: 'erail', cells, rail, need, fails, lo: Infinity, skew: false };
}

function hsrCand(g: Grid, cells: number[], rail: number[], lo: number, hi: number, vx: number, vz: number, plain: (c: number) => boolean): Cand {
  const fails: [string, number[]][] = [];
  const n = g.n;
  const hb = cells.length === 1 ? bits(g.conn1[cells[0]]) : [];
  let need: number, skew: boolean;
  if (cells.length === 2) {
    need = hi + HWH_CLEAR;
    skew = false;
  } else {
    const c = cells[0];
    const ang = crossAngle(hb, vx, vz);
    // 線路に沿って走る（30° より浅く交わる）のは、交差ではない
    if ((g.hsr[c] & g.conn1[c]) || ang < 30) fails.push([HWR_MSG_HSR_PARALLEL, [c]]);
    need = hi + HWH_CLEAR + crestAdd(hb, ang, HSR_HALF);
    skew = ang < 80;
  }
  // 駅の近く（駅の床版の高さに合わせて線路の高さが変わる）は越えない
  for (const c of cells) {
    const x = c % n, y = (c / n) | 0;
    let near = false;
    for (let dy = -4; dy <= 4 && !near; dy++) for (let dx = -4; dx <= 4; dx++) if (g.inb(x + dx, y + dy) && g.hsrf[g.idx(x + dx, y + dy)] & HSRF_STATION) { near = true; break; }
    if (near) { fails.push([HWR_MSG_HSR_STATION, [c]]); break; }
  }
  for (const c of cells) if (!plain(c)) fails.push([bits(g.conn1[c]).length < 2 ? HWR_MSG_END : HWR_MSG_RAMP, [c]]);
  return { kind: 'hsr', cells, rail, need, fails, lo, skew };
}

// 高速道路と線路が交差する所の候補をすべて探す
function findCands(g: Grid, blocked: Set<number>): { erail: Cand[]; hsr: Cand[] } {
  const n = g.n, N = n * n;
  const erail: Cand[] = [], hsr: Cand[] = [];
  const plain = plainOf(g, blocked);
  const hwy = (c: number) => c >= 0 && isElevHighway(g.up[c]);
  let deck: Map<number, HsrCell> | null = null;
  const anyHsr = g.hsr.some((v) => v !== 0);
  for (let c = 0; c < N; c++) {
    if (!hwy(c)) continue;
    // マスを共有する交差
    if (g.erail[c]) erail.push(erailCand(g, [c], [c], plain));
    if (anyHsr) {
      const e = (deck ??= hsrDeckCells(g)).get(c);
      if (e) hsr.push(hsrCand(g, [c], [c], e.lo, e.hi, e.tx, e.tz, plain));
    }
    // 斜めどうしがマスの角で交わる交差（高速道路の c → j と、線路の a → b）
    for (const d of [1, 3]) {
      if (!(g.conn1[c] & (1 << d))) continue;
      const j = nbr(g, c, d);
      if (!hwy(j) || !(g.conn1[j] & (1 << opp(d)))) continue;
      const x = c % n, y = (c / n) | 0;
      const a = y * n + x + DX[d], b = (y + DY[d]) * n + x;
      const dd = dirOf(-DX[d], DY[d]);
      if (g.erail[a] & (1 << dd)) erail.push(erailCand(g, [c, j], [a, b], plain));
      if (g.hsr[a] & (1 << dd)) {
        const m = (deck ??= hsrDeckCells(g));
        const ea = m.get(a), eb = m.get(b);
        const ground = (i: number) => hsrDeckH(g, i);
        const lo = Math.min(ea?.lo ?? ground(a), eb?.lo ?? ground(b)), hi = Math.max(ea?.hi ?? ground(a), eb?.hi ?? ground(b));
        hsr.push(hsrCand(g, [c, j], [a, b], lo, hi, 0, 0, plain));
      }
    }
  }
  return { erail, hsr };
}

// 高速鉄道の高架の下を、高さ h の高速道路がくぐれるか
const fitsUnder = (x: Cand, h: number) => HWR_HSR_UNDER && h + HW_ROAD_LIFT + HSR_CLEAR <= x.lo - HSR_GIRDER;

// ---------------- 坂の計画 ----------------
interface Step { c: number; t: number; nat: number; end: boolean; plain: boolean }

// 交差 x の坂を、高速道路に沿って両側へ計画する。owners = 交差のマス → 交差（近くの交差と坂をつなげるため）
function planRamps(g: Grid, x: Cand, plain: (c: number) => boolean, owners: Map<number, Cand[]>): HwRailCross {
  const res: HwRailCross = { kind: x.kind, cells: x.cells, rail: x.rail, need: x.need, ok: true, reason: '', bad: [], target: new Map() };
  const fail = (reason: string, bad: number[]) => {
    if (res.ok) res.reason = reason;
    res.ok = false;
    for (const b of bad) if (!res.bad.includes(b)) res.bad.push(b);
  };
  for (const [r, b] of x.fails) fail(r, b);
  if (!res.ok) return res;
  const setT = (c: number, h: number) => {
    if (h > g.upH[c] + 0.01) res.target.set(c, Math.max(res.target.get(c) ?? 0, h));
  };
  const need = x.need;
  for (const c of x.cells) setT(c, need);
  // 交差のマスから、高速道路に沿って両側へ
  const starts: [number, number][] = [];
  if (x.cells.length === 2) {
    const [c, j] = x.cells;
    const dcj = bits(g.conn1[c]).find((d) => nbr(g, c, d) === j)!;
    for (const [s, back] of [[c, dcj], [j, opp(dcj)]] as const) {
      const fwd = bits(g.conn1[s]).find((d) => d !== back);
      if (fwd !== undefined) starts.push([s, fwd]);
    }
  } else for (const d of bits(g.conn1[x.cells[0]])) starts.push([x.cells[0], d]);
  const nat0 = natH(g, x.cells[0]);
  for (const [s, d0] of starts) {
    // 高速道路の道すじ（本線の続く所まで）
    const path: Step[] = [];
    let cur = s, d = d0, t = 0;
    let tail: { cur: number; j: number; d: number } | null = null; // 高速道路の端（地上に降りる、ランプにつながる）
    for (let step = 0; step < MAX_STEPS; step++) {
      const j = nbr(g, cur, d);
      if (j < 0) break; // マップの端：その先は同じ高さで続く
      const joined = isElevHighway(g.up[j]) && (g.conn1[j] & (1 << opp(d))) !== 0;
      if (!joined) { tail = { cur, j, d }; break; }
      t += stepLen(d);
      const end = bits(g.conn1[j]).length === 1;
      const pl = !end && plain(j);
      path.push({ c: j, t, nat: natH(g, j), end, plain: pl });
      if (!pl) break;
      d = bits(g.conn1[j]).find((k) => k !== opp(d))!;
      cur = j;
    }
    // 近くの交差：坂を下りてまた上る間が短ければ、高い方の交差の高さのまま次の交差までのばし、その先で下りる（間でへこまない）。
    // 低い方の交差からは、ふつうの坂（高い方の交差の坂が上を覆う）
    let shift = 0;
    for (let k = 0; k < path.length && path[k].plain; k++) {
      const other = owners.get(path[k].c)?.find((o) => o !== x && !o.cells.some((c) => x.cells.includes(c)));
      if (!other) continue;
      if (need >= other.need && path[k].t <= reach(need - nat0) + reach(other.need - path[k].nat) + MERGE_SLACK) shift = path[k].t;
      break;
    }
    let done = false;
    for (let k = 0; k < path.length; k++) {
      const p = path[k];
      const r = need - drop(p.t - shift);
      const want = soft(r, p.nat);
      const need2 = want > g.upH[p.c] + 0.01;
      if (p.end) { if (need2) fail(HWR_MSG_END, [p.c]); done = true; break; }
      if (!p.plain) { if (need2) fail(HWR_MSG_RAMP, [p.c]); done = true; break; }
      if (need2) setT(p.c, want);
      else if (r < p.nat - SOFT) { done = true; break; }
    }
    // 高速道路の端（地上に降りる、行き止まり、ランプにつながる）：その手前を上げていればだめ
    if (!done && tail) {
      const raisedCur = (res.target.get(tail.cur) ?? -Infinity) > g.upH[tail.cur] + 0.01;
      if (raisedCur) fail(g.up[tail.j] && g.conn1[tail.j] & (1 << opp(tail.d)) ? HWR_MSG_RAMP : HWR_MSG_END, [tail.cur]);
    }
  }
  return res;
}

// すべての交差の坂を計画する。高速鉄道の高架は、くぐれる所はくぐり（高速道路はそのまま）、
// 近くの交差の坂などでくぐれない所は、高速鉄道の上を越える（架線柱の上まで持ち上げる）
function planAll(g: Grid): { list: HwRailCross[]; raise: Map<number, number> } {
  const blocked = blockedCells(g);
  const plain = plainOf(g, blocked);
  const { erail, hsr } = findCands(g, blocked);
  const hAt = (raise: Map<number, number>, c: number) => Math.max(g.upH[c], raise.get(c) ?? -Infinity);
  // くぐる高さ：交差のマス（斜めに交わるときは、床版がかかる隣のマスも）
  const underCells = (x: Cand) => {
    if (!x.skew) return x.cells;
    const out = [...x.cells];
    for (const c of x.cells) for (const d of bits(g.conn1[c])) { const j = nbr(g, c, d); if (j >= 0 && isElevHighway(g.up[j])) out.push(j); }
    return out;
  };
  const over = new Set<Cand>(hsr.filter((x) => !underCells(x).every((c) => fitsUnder(x, g.upH[c]))));
  let list: HwRailCross[] = [];
  let raise = new Map<number, number>();
  for (let iter = 0; iter < 10; iter++) {
    const act = [...erail, ...hsr.filter((x) => over.has(x))];
    const owners = new Map<number, Cand[]>();
    for (const x of act) if (!x.fails.length) for (const c of x.cells) owners.set(c, [...(owners.get(c) ?? []), x]);
    list = act.map((x) => planRamps(g, x, plain, owners));
    raise = new Map();
    for (const x of list) if (x.ok) for (const [c, h] of x.target) raise.set(c, Math.max(raise.get(c) ?? 0, h));
    // 持ち上げた高速道路が、くぐる予定の高速鉄道の高架にぶつかるなら、その高架も上を越える
    let flipped = false;
    for (const x of hsr) if (!over.has(x) && !underCells(x).every((c) => fitsUnder(x, hAt(raise, c)))) { over.add(x); flipped = true; }
    if (!flipped) break;
  }
  return { list, raise };
}

// 高速道路と線路（高架鉄道・高速鉄道）が交差する所をすべて探し、それぞれの坂の高さを計画する
export function hwRailCrossings(g: Grid): HwRailCross[] {
  return planAll(g).list;
}

// 交差の所の高速道路を、必要な高さまで上げる（坂を作れない交差はそのまま）。戻り値：上げられなかった交差
export function levelHighwaysOverRail(g: Grid): HwRailCross[] {
  const { list, raise } = planAll(g);
  for (const [c, h] of raise) if (h > g.upH[c]) g.upH[c] = h;
  return list.filter((x) => !x.ok);
}

const crossKey = (x: HwRailCross) => `${x.kind}:${x.cells.join(',')}`;

// 計画の確かめ：変更を加えた grid（複製）で、touch のマスに関わる交差がすべて坂を作れるか。
// before（変更の前の grid）を渡すと、変更の前は問題のなかった交差が、変更のせいで坂を作れなくなる場合もだめにする
export function checkHwRail(g: Grid, touch: Set<number>, before?: Grid): { ok: boolean; reason: string; bad: number[] } {
  const bad: number[] = [];
  let reason = '';
  const xs = hwRailCrossings(g).filter((x) => !x.ok);
  const old = before && xs.length ? new Set(hwRailCrossings(before).filter((x) => !x.ok).map(crossKey)) : null;
  for (const x of xs) {
    const touched = x.cells.some((c) => touch.has(c)) || x.rail.some((c) => touch.has(c));
    if (!touched && !(old && !old.has(crossKey(x)))) continue;
    reason = reason || x.reason;
    bad.push(...x.bad);
  }
  return { ok: bad.length === 0, reason, bad };
}

// 高架鉄道の、敷地のある駅のホームのマス（駅のまわりの線路）
export function erailStationCells(g: Grid, list: Iterable<{ type: string; x: number; y: number; w: number; h: number }>): Set<number> {
  const out = new Set<number>();
  for (const b of list) {
    if (b.type !== 'el_station') continue;
    for (let y = b.y - 1; y <= b.y + b.h; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) if (g.inb(x, y) && g.erail[g.idx(x, y)]) out.add(g.idx(x, y));
  }
  for (let i = 0; i < g.estn.length; i++) if (g.estn[i]) out.add(i);
  return out;
}

// 高架の高速道路の計画が、敷地のある高架駅のホーム（と、線路に沿ったその隣のマス）の上を通るか
export function stationUnder(g: Grid, plan: { lanes: { cells: number[]; levels: number[] }[] }, list: Iterable<{ type: string; x: number; y: number; w: number; h: number }>): boolean {
  const cells = plan.lanes.flatMap((l) => l.cells.filter((c, k) => l.levels[k] === 1 && g.erail[c]));
  if (!cells.length) return false;
  const st = erailStationCells(g, list);
  return cells.some((c) => st.has(c) || bits(g.erail[c]).some((d) => st.has(nbr(g, c, d))));
}
