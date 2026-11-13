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
// 高さは、交差の前後のマスの upH だけで表す（保存データは今までの配列のまま）。上げるだけなので、何回くり返しても同じ結果になる
import { Grid, ORAMP_LEN, ORAMP_ON, ORAMP_PARTNER } from './grid';
import { CELL, DX, DY, WATER_LEVEL, dirOf, isDiag, opp } from './constants';
import { LINES, ROADS, RoadType, isUrbanElevated } from './defs';
import { rampLineH } from './railRamp';
import { hsrDeckH, isHsrElevated, HSR_CLEAR, HSR_GIRDER } from './hsr';

export const ERAIL_CATENARY = 6.6; // 鉄道の床版から架線柱の上端まで（railLayer の架線柱の門型）
export const ERAIL_RAIL_TOP = 0.36; // 鉄道の床版からレールの上面まで
export const HW_STRUCT = 1.63; // 都市高速の路面から桁の下面まで（床版の縁 0.38m + 桁 1.25m。roadLayer の FAS + VIA_MAIN.depth）
export const HW_ROAD_LIFT = 0.3; // upH から路面まで（roadLayer の ROAD_LIFT）
export const HWR_MARGIN = 0.5; // 架線柱の上端と桁の下面の間の余裕
export const HWR_CLEAR = ERAIL_CATENARY + HWR_MARGIN + HW_STRUCT - HW_ROAD_LIFT; // 鉄道の床版から必要な upH まで（8.43m）
export const HWR_GRADE = 0.1; // 坂の勾配（10%）
const CREST = 2 * CELL; // 頂上と坂の下の、勾配がなめらかに変わる長さ（m）
const SOFT = (HWR_GRADE * CREST) / 2; // 坂の下のなめらかな曲がりの幅（高さ、m）
const RAIL_HALF = 5.35; // 鉄道の線路の中心から架線柱の外側まで（m）
const HW_HALF = 3.0; // 高速道路の中心から桁の下面の縁まで（m）

export const HWR_MSG_PARALLEL = '高架鉄道の真上に沿っては引けません（交差だけできます）';
export const HWR_MSG_PARALLEL_RAIL = '高架の高速道路の真下に沿っては引けません（交差だけできます）';
export const HWR_MSG_STATION = '高架鉄道の駅の上は通せません';
export const HWR_MSG_RAMP = '高速の坂を作る場所がありません（ランプやジャンクションが近すぎます）';
export const HWR_MSG_END = '高速の坂を作る場所がありません（高速道路の端が近すぎます）';
export const HWR_MSG_HSR = '高速鉄道の高架が上にあるので、高速道路を持ち上げられません';

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
// 坂の下をなめらかにする（ふつうの高さ nat と、坂 r のなめらかな最大。r が十分低ければ r + SOFT/4 のまま）
const soft = (r: number, nat: number) => {
  const D = r - nat;
  const sp = D >= SOFT ? D : D <= -SOFT ? 0 : ((D + SOFT) * (D + SOFT)) / (4 * SOFT);
  return Math.max(r, Math.min(nat + sp, r + SOFT / 4));
};

// 高速道路と高架鉄道が交差する所をすべて探し、それぞれの坂の高さを計画する
export function hwRailCrossings(g: Grid): HwRailCross[] {
  const n = g.n, N = n * n;
  const out: HwRailCross[] = [];
  let blocked: Set<number> | null = null;
  const hwy = (c: number) => c >= 0 && isElevHighway(g.up[c]);
  for (let c = 0; c < N; c++) {
    if (!hwy(c)) continue;
    // マスを共有する交差
    if (g.erail[c]) out.push(plan(g, [c], [c], (blocked ??= blockedCells(g))));
    // 斜めどうしがマスの角で交わる交差（高速道路の c → j と、線路の a → b）
    for (const d of [1, 3]) {
      if (!(g.conn1[c] & (1 << d))) continue;
      const j = nbr(g, c, d);
      if (!hwy(j) || !(g.conn1[j] & (1 << opp(d)))) continue;
      const x = c % n, y = (c / n) | 0;
      const a = y * n + x + DX[d], b = (y + DY[d]) * n + x;
      const dd = dirOf(-DX[d], DY[d]);
      if (g.erail[a] & (1 << dd)) out.push(plan(g, [c, j], [a, b], (blocked ??= blockedCells(g))));
    }
  }
  return out;
}

function plan(g: Grid, cells: number[], rail: number[], blocked: Set<number>): HwRailCross {
  const res: HwRailCross = { cells, rail, need: 0, ok: true, reason: '', bad: [], target: new Map() };
  const fail = (reason: string, bad: number[]) => {
    if (res.ok) res.reason = reason;
    res.ok = false;
    for (const b of bad) if (!res.bad.includes(b)) res.bad.push(b);
  };
  const corner = cells.length === 2;
  // 交差の高さ
  let need: number;
  if (corner) {
    need = (erailDeckH(g, rail[0]) + erailDeckH(g, rail[1])) / 2 + HWR_CLEAR;
    if (rail.some((r) => g.estn[r])) fail(HWR_MSG_STATION, cells);
  } else {
    const c = cells[0];
    const hb = bits(g.conn1[c]), rb = bits(g.erail[c]);
    if (g.erail[c] & g.conn1[c]) fail(HWR_MSG_PARALLEL, [c]);
    // 駅のホーム（交差のマスと、線路に沿った隣のマス）の上は通さない
    if (g.estn[c] || rb.some((d) => { const j = nbr(g, c, d); return j >= 0 && g.estn[j] !== 0; })) fail(HWR_MSG_STATION, [c]);
    // 交わる角度（45° か 90°）。高速道路の下を線路が通る長さ E だけ、頂上の丸みで下がる分を足す
    let ang = 90;
    for (const a of hb) for (const r of rb) {
      const k = Math.abs(a - r) % 4;
      const deg = Math.min(k, 4 - k) * 45;
      if (deg > 0) ang = Math.min(ang, deg);
    }
    const th = (ang * Math.PI) / 180;
    const E = RAIL_HALF / Math.sin(th) + HW_HALF / Math.tan(th);
    const L = hb.some(isDiag) ? CELL * Math.SQRT2 : CELL;
    need = railTopAt(g, c) + HWR_CLEAR + (drop(L) * Math.min(E, L)) / L;
  }
  res.need = need;
  // 交差のマスは、まっすぐか曲がりの本線（分かれ目やランプのないマス）でないといけない
  const plain = (c: number) => bits(g.conn1[c]).length === 2 && !blocked.has(c);
  for (const c of cells) if (!plain(c)) fail(bits(g.conn1[c]).length < 2 ? HWR_MSG_END : HWR_MSG_RAMP, [c]);
  if (!res.ok) return res;
  const setT = (c: number, h: number) => {
    if (h > g.upH[c] + 0.01) res.target.set(c, Math.max(res.target.get(c) ?? 0, h));
  };
  for (const c of cells) setT(c, need);
  // 持ち上げた高速道路の上に高速鉄道の高架があると、ぶつかる
  for (const c of cells) if (isHsrElevated(g, c) && need + HW_ROAD_LIFT + HSR_CLEAR > hsrDeckH(g, c) - HSR_GIRDER) fail(HWR_MSG_HSR, [c]);
  // 交差のマスから、高速道路に沿って両側へ
  const starts: [number, number][] = [];
  if (corner) {
    const [c, j] = cells;
    const dcj = bits(g.conn1[c]).find((d) => nbr(g, c, d) === j)!;
    for (const [s, back] of [[c, dcj], [j, opp(dcj)]] as const) {
      const fwd = bits(g.conn1[s]).find((d) => d !== back);
      if (fwd !== undefined) starts.push([s, fwd]);
    }
  } else for (const d of bits(g.conn1[cells[0]])) starts.push([cells[0], d]);
  for (const [s, d0] of starts) {
    let cur = s, d = d0, t = 0;
    for (let step = 0; step < 48; step++) {
      t += stepLen(d);
      const r = need - drop(t);
      const j = nbr(g, cur, d);
      const raisedCur = (res.target.get(cur) ?? -Infinity) > g.upH[cur] + 0.01;
      if (j < 0) break; // マップの端：その先は同じ高さで続く
      const joined = isElevHighway(g.up[j]) && (g.conn1[j] & (1 << opp(d))) !== 0;
      if (!joined) {
        // 高速道路の端（地上に降りる、行き止まり、ランプにつながる）：その手前を上げていればだめ
        if (raisedCur) fail(g.up[j] && g.conn1[j] & (1 << opp(d)) ? HWR_MSG_RAMP : HWR_MSG_END, [cur]);
        break;
      }
      const nat = natH(g, j);
      const want = soft(r, nat);
      const need2 = want > g.upH[j] + 0.01;
      if (bits(g.conn1[j]).length === 1) {
        // 行き止まりの端
        if (need2) fail(HWR_MSG_END, [j]);
        break;
      }
      if (!plain(j)) {
        if (need2) fail(HWR_MSG_RAMP, [j]);
        break;
      }
      if (need2) setT(j, want);
      else if (r < nat - SOFT) break;
      if (need2 && isHsrElevated(g, j) && want + HW_ROAD_LIFT + HSR_CLEAR > hsrDeckH(g, j) - HSR_GIRDER) fail(HWR_MSG_HSR, [j]);
      const nb2 = bits(g.conn1[j]).find((k) => k !== opp(d))!;
      cur = j;
      d = nb2;
    }
  }
  return res;
}

// 交差の所の高速道路を、必要な高さまで上げる（坂を作れない交差はそのまま）。戻り値：上げられなかった交差
export function levelHighwaysOverRail(g: Grid): HwRailCross[] {
  const all = hwRailCrossings(g);
  const raise = new Map<number, number>();
  for (const x of all) if (x.ok) for (const [c, h] of x.target) raise.set(c, Math.max(raise.get(c) ?? 0, h));
  for (const [c, h] of raise) if (h > g.upH[c]) g.upH[c] = h;
  return all.filter((x) => !x.ok);
}

// 計画の確かめ：変更を加えた grid（複製）で、touch のマスに関わる交差がすべて坂を作れるか
export function checkHwRail(g: Grid, touch: Set<number>): { ok: boolean; reason: string; bad: number[] } {
  const bad: number[] = [];
  let reason = '';
  for (const x of hwRailCrossings(g)) {
    if (x.ok || !(x.cells.some((c) => touch.has(c)) || x.rail.some((c) => touch.has(c)))) continue;
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
