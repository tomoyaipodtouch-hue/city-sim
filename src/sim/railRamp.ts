// 地上の鉄道（rail）と高架鉄道（erail）を結ぶ坂。
//
// 地上の線路の端から高架鉄道を引く（または高架鉄道の端から地上の線路を引く）と、つなぎ目の先の
// RAMP_LEN マスのまっすぐな線路が坂になる。坂の下の部分は擁壁にはさまれた盛土（U字の溝）、上の部分は高架橋。
//
// 表し方（保存データは grid.rramp の 1 配列だけ）：
//   grid.rramp[i] = 1 + k + D * 16。k = 坂の中の番号（0 = いちばん下、RAMP_LEN - 1 = いちばん上）、D = 上っていく向き（縦横だけ）
//   k = 0 .. RAMP_PORTAL     ：地上の鉄道の線路（grid.rail）
//   k = RAMP_PORTAL .. 最後  ：高架鉄道の線路（grid.erail）
//   k = RAMP_PORTAL のマス（つなぎ目）は両方の線路を持つ。rail はそこで下へ、erail は上へだけつながる（どちらも行き止まりの形）。
// 列車と乗客は、つなぎ目のマスで rail と erail のあいだを乗り換えなしで行き来する（traffic.ts・carLayer）。
// 線路の高さ（lineH）は、坂のマスでは下から上へ一定の勾配で上がる（rampLineH）。
import { Grid } from './grid';
import { DX, DY, WATER_LEVEL, opp } from './constants';
import { CIVIC, CivicId, LINES } from './defs';

export const RAMP_LEN = 12; // 坂の長さ（マス）。16m × 12 = 192m
export const RAMP_PORTAL = 7; // 地上の線路と高架の線路が入れかわるマス（坂の中の番号）
export const RAMP_BASE = 0.1; // 地上の線路の高さ（地面から。RailLayer.lineH の地上の線路と同じ）
export const RRAMP_CELL_COST = 200; // 坂の 1マスの建設費（擁壁・盛土・高架橋）

export const RAMP_MSG_SHORT = '坂を作るまっすぐな場所が足りません';
export const RAMP_MSG_DIAG = '坂は縦か横のまっすぐな線路にしか作れません';
export const RAMP_MSG_ROAD = '坂の低い所は道路と交差できません（踏切は作れません）';
export const RAMP_MSG_UP = '坂の上には高架の道路を通せません';
export const RAMP_MSG_LINE = '坂の途中には、ほかの線路を引けません';
export const RAMP_MSG_STATION = '坂の線路のそばには駅を置けません';
export const RAMP_MSG_WATER = '坂は水の上には作れません';

export interface RampInfo {
  cells: number[]; // 下から上へ RAMP_LEN マス
  dir: number; // 上っていく向き
}

export const rampK = (g: Grid, i: number) => (g.rramp[i] ? (g.rramp[i] & 15) - 1 : -1);
export const rampDir = (g: Grid, i: number) => g.rramp[i] >> 4;
export const isRamp = (g: Grid, i: number) => g.rramp[i] !== 0;
export const isRampPortal = (g: Grid, i: number) => g.rramp[i] !== 0 && rampK(g, i) === RAMP_PORTAL;
// 坂の低い所（地上の線路の部分。つなぎ目を含む）：道路と交差できない、取り壊しの「地上」
export const isRampLow = (g: Grid, i: number) => g.rramp[i] !== 0 && rampK(g, i) <= RAMP_PORTAL;
// 坂の高い所（高架の部分。つなぎ目を含む）：取り壊しの「高架」
export const isRampHigh = (g: Grid, i: number) => g.rramp[i] !== 0 && rampK(g, i) >= RAMP_PORTAL;

// 地面から線路（床版）までの高さ。k = 坂の中の番号（マスの中心）
export function rampLift(k: number) {
  return RAMP_BASE + ((LINES.erail.lift - RAMP_BASE) * (k + 0.5)) / RAMP_LEN;
}
// 坂の線路の高さ（マスの中心）。RailLayer.lineH と hwrail.erailDeckH が使う
export function rampLineH(g: Grid, i: number) {
  const n = g.n;
  return Math.max(g.cellH(i % n, (i / n) | 0), WATER_LEVEL) + rampLift(rampK(g, i));
}

const step = (g: Grid, c: number, d: number, k = 1) => {
  const x = (c % g.n) + DX[d] * k, y = ((c / g.n) | 0) + DY[d] * k;
  return g.inb(x, y) ? y * g.n + x : -1;
};

// 坂のマスから、その坂全体
export function rampOf(g: Grid, i: number): RampInfo | null {
  if (!g.rramp[i]) return null;
  const k = rampK(g, i), dir = rampDir(g, i);
  const start = step(g, i, opp(dir), k);
  if (start < 0) return null;
  const cells: number[] = [];
  for (let j = 0; j < RAMP_LEN; j++) {
    const c = step(g, start, dir, j);
    if (c < 0) return null;
    cells.push(c);
  }
  return { cells, dir };
}

// すべての坂（いちばん下のマスで数える）
export function allRamps(g: Grid): RampInfo[] {
  const out: RampInfo[] = [];
  for (let i = 0; i < g.rramp.length; i++) if (g.rramp[i] && rampK(g, i) === 0) { const r = rampOf(g, i); if (r) out.push(r); }
  return out;
}

// つなぎ目のマスで、もう一方の線路（rail ⇔ erail）へ乗り移れるか
export function portalPartner(g: Grid, i: number, kind: 'rail' | 'erail'): 'rail' | 'erail' | null {
  if (!isRampPortal(g, i)) return null;
  return kind === 'rail' ? (g.erail[i] ? 'erail' : null) : g.rail[i] ? 'rail' : null;
}

// 坂の線路を置く（下のマスから上る向き dir に RAMP_LEN マス）
export function applyRampTrack(g: Grid, cells: number[], dir: number) {
  const back = opp(dir);
  for (let k = 0; k < RAMP_LEN; k++) {
    const c = cells[k];
    g.rramp[c] = 1 + k + (dir << 4);
    if (k < RAMP_PORTAL) { g.rail[c] |= 1 << dir; g.rail[cells[k + 1]] |= 1 << back; }
    if (k >= RAMP_PORTAL && k + 1 < RAMP_LEN) { g.erail[c] |= 1 << dir; g.erail[cells[k + 1]] |= 1 << back; }
    g.tree[c] = 0;
    if (!g.road[c]) { g.zone[c] = 0; g.zden[c] = 0; }
  }
}

// 坂がこわれていないか（線路の一部が取り壊された・印がずれた）
function intact(g: Grid, r: RampInfo) {
  const { cells, dir } = r, back = opp(dir);
  for (let k = 0; k < RAMP_LEN; k++) {
    const c = cells[k];
    if (rampK(g, c) !== k || rampDir(g, c) !== dir) return false;
    if (k < RAMP_PORTAL && !(g.rail[c] & (1 << dir))) return false;
    if (k > 0 && k <= RAMP_PORTAL && !(g.rail[c] & (1 << back))) return false;
    if (k >= RAMP_PORTAL && k + 1 < RAMP_LEN && !(g.erail[c] & (1 << dir))) return false;
    if (k > RAMP_PORTAL && !(g.erail[c] & (1 << back))) return false;
  }
  return true;
}

// 坂を線路ごと取り除く（坂の前後の線路は残る）
export function removeRamp(g: Grid, r: RampInfo) {
  const n = g.n;
  for (const c of r.cells) {
    g.rramp[c] = 0;
    for (const kind of ['rail', 'erail'] as const) {
      const mask = g[kind];
      for (let d = 0; d < 8; d++) {
        if (!(mask[c] & (1 << d))) continue;
        const x = (c % n) + DX[d], y = ((c / n) | 0) + DY[d];
        if (g.inb(x, y)) mask[y * n + x] &= ~(1 << opp(d));
      }
      mask[c] = 0;
    }
  }
}

// 一部が壊れた坂は、全体を取り除く。取り除いた坂の数を返す
export function pruneBrokenRamps(g: Grid): number {
  let k = 0;
  const seen = new Set<number>();
  for (let i = 0; i < g.rramp.length; i++) {
    if (!g.rramp[i] || seen.has(i)) continue;
    const r = rampOf(g, i);
    if (r) for (const c of r.cells) seen.add(c);
    if (r && intact(g, r)) continue;
    if (r) removeRamp(g, r);
    else g.rramp[i] = 0;
    k++;
  }
  return k;
}

// ---------------- 計画 ----------------
export interface RailRampPlan {
  cells: number[]; // 坂のマス（下から上へ）
  dir: number; // 上る向き
  steps: number[]; // 坂の中の一歩（引く線路の道すじの dirs の番号）。ほかの一歩は、ふつうの線路（引く種類）
}

// 線路の端のマス（つながりが 1 つだけ）なら、そのつながりの向き
const deadEnd = (m: number) => (m && !(m & (m - 1)) ? 31 - Math.clz32(m) : -1);

// 駅（rail・erail）の敷地に接しているマス
function stationNear(g: Grid, i: number, stations: { type: string; x: number; y: number; w: number; h: number }[]) {
  if (g.estn[i]) return true;
  const x = i % g.n, y = (i / g.n) | 0;
  return stations.some((b) => {
    const t = CIVIC[b.type as CivicId]?.transit;
    return (t === 'rail' || t === 'erail') && x >= b.x - 1 && x <= b.x + b.w && y >= b.y - 1 && y <= b.y + b.h;
  });
}

// 引こうとする線路（kind）の端が、もう一方の線路の行き止まりにつながるなら、そこに坂を作る計画。
// 両端とも、もう一方の線路の行き止まりなら、坂を 2 つ作る（地上 → 高架 → 地上）。
// つなぎ目がなければ null。つなぎ目はあるが坂を作れないときは reason と bad
export function planRampJoin(
  g: Grid, path: { cells: number[]; dirs: number[] }, kind: 'rail' | 'erail', stations: { type: string; x: number; y: number; w: number; h: number }[] = [],
): { ramps: RailRampPlan[]; bad: Set<number>; reason: string } | null {
  const other = kind === 'rail' ? g.erail : g.rail;
  const own = g[kind];
  const { cells, dirs } = path;
  if (cells.length < 2) return null;
  const cand = (c: number) => !own[c] && !g.rramp[c] && deadEnd(other[c]) >= 0;
  const ends: boolean[] = [cand(cells[0]), cells.length > 1 && cand(cells[cells.length - 1])];
  if (!ends[0] && !ends[1]) return null;
  const bad = new Set<number>();
  let reason = '';
  const why = (r: string, c: number) => { bad.add(c); reason = reason || r; };
  const ramps: RailRampPlan[] = [];
  const used = new Set<number>();
  const n = g.n;
  for (const atEnd of [false, true]) {
    if (!ends[atEnd ? 1 : 0]) continue;
    // つなぎ目から向けた道すじ
    const pc = atEnd ? cells.slice().reverse() : cells;
    const pd = atEnd ? dirs.slice().reverse().map(opp) : dirs;
    const stepIdx = (k: number) => (atEnd ? dirs.length - 1 - k : k);
    const s = pc[0];
    const D = opp(deadEnd(other[s])); // つなぎ目へ入ってくる向き（坂はこの向きにまっすぐ続く）
    if (D & 1) { why(RAMP_MSG_DIAG, s); continue; }
    let len = 1;
    while (len < RAMP_LEN && len < pc.length && pd[len - 1] === D) len++;
    // 坂のすぐ先も、まっすぐ（坂の端で曲がらない）
    if (len < RAMP_LEN || (pd.length > RAMP_LEN - 1 && pd[RAMP_LEN - 1] !== D)) {
      bad.add(s);
      for (let k = len; k < Math.min(RAMP_LEN + 1, pc.length); k++) bad.add(pc[k]);
      reason = reason || RAMP_MSG_SHORT;
      continue;
    }
    const seg = pc.slice(0, RAMP_LEN);
    if (seg.some((c) => used.has(c))) { why(RAMP_MSG_SHORT, s); continue; }
    for (const c of seg) used.add(c);
    // 高架鉄道を引くときは上り（つなぎ目が坂の下）、地上の線路を引くときは下り（つなぎ目が坂の上）
    const up = kind === 'erail';
    const rc = up ? seg : seg.slice().reverse();
    const dir = up ? D : opp(D);
    rc.forEach((c, k) => {
      const x = c % n, y = (c / n) | 0;
      const joint = c === s;
      if (g.bldg[c]) why('建物があります。先に取り壊してください', c);
      if (g.isWater(x, y)) why(RAMP_MSG_WATER, c);
      if (g.aport[c]) why('空港の道路には引けません（正門のマスで終わらせてください）', c);
      if (g.up[c]) why(RAMP_MSG_UP, c);
      if (k <= RAMP_PORTAL && g.road[c]) why(RAMP_MSG_ROAD, c);
      if (!joint && (g.rail[c] || g.erail[c] || g.mono[c] || g.hsr[c] || g.hsrf[c])) why(RAMP_MSG_LINE, c);
      if (joint && (g.mono[c] || g.hsr[c] || g.hsrf[c])) why(RAMP_MSG_LINE, c);
      if (stationNear(g, c, stations)) why(RAMP_MSG_STATION, c);
    });
    const steps: number[] = [];
    for (let k = 0; k < RAMP_LEN - 1; k++) steps.push(stepIdx(k));
    ramps.push({ cells: rc, dir, steps });
  }
  return { ramps: bad.size ? [] : ramps, bad, reason };
}

// 坂のマスに、ふつうの線路をつなぐ（坂の端から外へまっすぐ続けるのだけよい）。だめなら理由
export function rampTouchReason(g: Grid, kind: string, cell: number, dirsAt: number[]): string {
  if (!g.rramp[cell]) return '';
  const k = rampK(g, cell), D = rampDir(g, cell);
  if (kind === 'rail' && k === 0 && dirsAt.every((d) => d === opp(D))) return '';
  if (kind === 'erail' && k === RAMP_LEN - 1 && dirsAt.every((d) => d === D)) return '';
  return RAMP_MSG_LINE;
}

// 坂の線路の取り壊しの階層：低い所は地上、高い所は高架（つなぎ目は両方）
export function rampInLayer(g: Grid, i: number, layer: 'ground' | 'up' | 'sub' | 'all') {
  if (!g.rramp[i]) return false;
  return layer === 'all' || (layer === 'ground' && isRampLow(g, i)) || (layer === 'up' && isRampHigh(g, i));
}
