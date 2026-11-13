// 高速鉄道（ヨーロッパの高速鉄道のような専用の線路・駅）
//
// 線路は grid.hsr（8方向の接続ビット）と grid.hsrf（マスの印）で表す。
//   HSRF_GROUND  ：地上の線路（ない＝高架。高架が基本で、街の外では地上にも引ける）
//   HSRF_COVER   ：カーブの内側で、線路のマスではないが線路がかかるマス（建物・ゾーンを置けない）。線路から毎回作り直す
//   HSRF_STATION ：駅のホームのマス（駅の敷地の中の線路の列）
//
// 曲がる所は 45° ずつ。曲がる所（線路のマスの向きが変わるマス）は、接線の長さ HSR_T の大きな曲線（2次ベジェ）でなめらかにする。
// 90° 以上の急な曲がりや、曲がる所の前後のまっすぐな区間が短すぎる線は引けない（planHsrLine が理由を返す）。
// 描画（hsrLayer）・列車（hsrTrains）・カーブの内側のマス（recomputeHsrCover）は、どれも同じ hsrPoly で線の形を作る。
import { Grid } from './grid';
import { CELL, DX, DY, WATER_LEVEL, dirOf, opp, isDiag } from './constants';
import { CIVIC, HSR_GROUND_COST, HSR_THROUGH_COST, LINES, RoadType, ZoneType, isHighway, isUrbanElevated } from './defs';
import type { LinePath, PlopPlan } from './plan';

export const HSRF_GROUND = 1;
export const HSRF_COVER = 2;
export const HSRF_STATION = 4;

export const HSR_T = 80; // 45° の曲がりの接線の長さ（m）。半径にすると約 190m
export const HSR_HALF = 7; // 高架橋・盛土の上の幅の半分（m）。カーブの内側のマスを決めるのに使う
export const HSR_LIFT = LINES.hsr.lift; // 高架の線路の床版の高さ（地面から、m）
export const HSR_GROUND_LIFT = 0.9; // 地上の線路（盛土の上）の高さ
export const HSR_RAMP = 170; // 高架と地上のあいだの坂の長さ（m）
export const HSR_TRACK = 2.5; // 複線の、中心から片側の線路まで（m）
export const HSR_PLAT = 7.5; // 駅の副本線（ホームに止まる線路）まで（m）
export const HSR_GIRDER = 2.4; // 床版の上面から桁の下面まで（m）
export const HSR_CLEAR = 4.8; // 高架の線路の下を通る道路の、路面から必要な高さ（m）
export const HSR_STN_LEN = 14; // 駅の長さ（マス）

export const HSR_MSG_SHARP = '急な曲がりは引けません（高速鉄道は 45° ずつ、大きなカーブで曲がります）';
export const HSR_MSG_SHORT = '曲がる所が近すぎます（カーブの前後に約 5 マスのまっすぐな線路が必要です）';
export const HSR_MSG_BRANCH = '分かれ道は、まっすぐな線路から 45° で分かれる形にしてください';
export const HSR_MSG_STATION = '駅の中の線路は、まっすぐにしか引けません';
export const HSR_MSG_STN_CURVE = 'カーブが駅にかかります（駅から少し離して曲げてください）';
export const HSR_MSG_PARALLEL = 'ほかの高架の道路や線路の真上に沿っては引けません（交差だけできます）';

const nbr = (g: Grid, c: number, d: number) => {
  const x = (c % g.n) + DX[d], y = ((c / g.n) | 0) + DY[d];
  return g.inb(x, y) ? y * g.n + x : -1;
};
export const hsrBits = (m: number) => {
  const out: number[] = [];
  for (let d = 0; d < 8; d++) if (m & (1 << d)) out.push(d);
  return out;
};
const stepLen = (d: number) => (isDiag(d) ? CELL * Math.SQRT2 : CELL);
// 出ていく向き a と b の曲がりの大きさ（0 = まっすぐ、1 = 45°、2 以上 = 急）
export const hsrTurn = (a: number, b: number) => {
  const k = (b - opp(a) + 8) & 7;
  return Math.min(k, 8 - k);
};
export const isHsrGround = (g: Grid, i: number) => (g.hsrf[i] & HSRF_GROUND) !== 0;
export const isHsrElevated = (g: Grid, i: number) => g.hsr[i] !== 0 && !(g.hsrf[i] & HSRF_GROUND);
// 地上の線路がかかるマス（線路のマスと、地上のカーブの内側）：道路や線路を横切らせない
export function hsrGroundBlock(g: Grid, i: number) {
  if (g.hsr[i]) return isHsrGround(g, i);
  if (!(g.hsrf[i] & HSRF_COVER)) return false;
  // カーブの内側：となりの線路のマスが地上なら
  const x = i % g.n, y = (i / g.n) | 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (g.inb(x + dx, y + dy) && g.hsr[g.idx(x + dx, y + dy)] && isHsrGround(g, g.idx(x + dx, y + dy))) return true;
  return false;
}
// 高架の線路の床版の高さ（マスの中心の簡単な目安。描画の高さは hsrPoly）
export function hsrDeckH(g: Grid, i: number) {
  const n = g.n;
  return Math.max(g.cellH(i % n, (i / n) | 0), WATER_LEVEL) + (isHsrGround(g, i) ? HSR_GROUND_LIFT : HSR_LIFT);
}

// ---------------- 形のつながり（交差点ごとの形の決まり） ----------------
type MaskOf = (i: number) => number;
// マスの形：'end' 行き止まり、'straight'、'bend'（45°）、'turnout'（まっすぐな線路から 45° で分かれる）、'bad'
export type HsrNode = { kind: 'end' | 'straight' | 'bend' | 'turnout' | 'bad'; reason?: string; branch?: number; back?: number };
export function hsrNodeKind(m: number): HsrNode {
  const b = hsrBits(m);
  if (b.length <= 1) return { kind: 'end' };
  if (b.length === 2) {
    const t = hsrTurn(b[0], b[1]);
    return t === 0 ? { kind: 'straight' } : t === 1 ? { kind: 'bend' } : { kind: 'bad', reason: HSR_MSG_SHARP };
  }
  if (b.length === 3) {
    // まっすぐな 2 本（x と反対）と、どちらかから 45° の 1 本
    for (const x of b) {
      if (!b.includes(opp(x))) continue;
      const br = b.find((d) => d !== x && d !== opp(x))!;
      for (const f of [x, opp(x)]) if (hsrTurn(opp(f), br) === 1) return { kind: 'turnout', branch: br, back: opp(f) };
    }
    return { kind: 'bad', reason: HSR_MSG_BRANCH };
  }
  return { kind: 'bad', reason: HSR_MSG_BRANCH };
}

// 曲がる所 c から向き d へ、次の曲がる所・分かれ道・行き止まり・駅までのまっすぐな長さ（m）を調べる。
// need（m）より短ければ、理由とぶつかったマスを返す
function checkArm(g: Grid, m: MaskOf, c: number, d: number, isStation: (i: number) => boolean): { ok: boolean; reason: string; cell: number } {
  let cur = c, dist = 0;
  for (let step = 0; step < 64; step++) {
    const j = nbr(g, cur, d);
    if (j < 0) return { ok: true, reason: '', cell: cur }; // マップの端：その先へまっすぐ続く
    dist += stepLen(d);
    if (isStation(j)) return { ok: dist - stepLen(d) / 2 >= HSR_T, reason: HSR_MSG_STN_CURVE, cell: j };
    const mj = m(j);
    if (!(mj & (1 << opp(d)))) return { ok: true, reason: '', cell: j };
    const k = hsrNodeKind(mj);
    if (k.kind === 'end') return { ok: dist >= HSR_T, reason: HSR_MSG_SHORT, cell: j };
    if (k.kind === 'bend' || k.kind === 'turnout') return { ok: dist >= 2 * HSR_T, reason: HSR_MSG_SHORT, cell: j };
    if (k.kind === 'bad') return { ok: true, reason: '', cell: j };
    if (dist >= 2 * HSR_T) return { ok: true, reason: '', cell: j };
    cur = j; // まっすぐ：同じ向きに進む
  }
  return { ok: true, reason: '', cell: cur };
}

// 曲がる所の曲線（2次ベジェ）が通るマス（線路のマス以外）。カーブの内側のマス
function arcCells(g: Grid, c: number, din: number, dout: number, isTrack: (i: number) => boolean, out: Set<number>) {
  const n = g.n;
  const vx = ((c % n) + 0.5) * CELL, vz = (((c / n) | 0) + 0.5) * CELL;
  const li = Math.hypot(DX[din], DY[din]), lo = Math.hypot(DX[dout], DY[dout]);
  const ax = vx - (DX[din] / li) * HSR_T, az = vz - (DY[din] / li) * HSR_T;
  const bx = vx + (DX[dout] / lo) * HSR_T, bz = vz + (DY[dout] / lo) * HSR_T;
  for (let k = 0; k <= 24; k++) {
    const t = k / 24, p0 = (1 - t) * (1 - t), p1 = 2 * t * (1 - t), p2 = t * t;
    const x = p0 * ax + p1 * vx + p2 * bx, z = p0 * az + p1 * vz + p2 * bz;
    const tx = 2 * (1 - t) * (vx - ax) + 2 * t * (bx - vx), tz = 2 * (1 - t) * (vz - az) + 2 * t * (bz - vz);
    const tl = Math.hypot(tx, tz) || 1, px = -tz / tl, pz = tx / tl;
    for (const o of [-HSR_HALF, -HSR_HALF / 2, 0, HSR_HALF / 2, HSR_HALF]) {
      const cx = Math.floor((x + px * o) / CELL), cy = Math.floor((z + pz * o) / CELL);
      if (!g.inb(cx, cy)) continue;
      const i = g.idx(cx, cy);
      if (!isTrack(i)) out.add(i);
    }
  }
}

// 線路の曲がる所ごとに、入ってくる向き・出ていく向き（分かれ道は、まっすぐな線路の後ろ → 分かれる線路）
function bendsOf(m: number): [number, number][] {
  const k = hsrNodeKind(m);
  const b = hsrBits(m);
  if (k.kind === 'bend') return [[opp(b[0]), b[1]]];
  if (k.kind === 'turnout') return [[opp(k.back!), k.branch!]];
  return [];
}

// カーブの内側のマスを作り直す（線路が変わるたびに呼ぶ）。カーブの内側のゾーン・木は外す
export function recomputeHsrCover(g: Grid) {
  const N = g.n * g.n;
  const out = new Set<number>();
  for (let i = 0; i < N; i++) {
    g.hsrf[i] &= ~HSRF_COVER;
    if (!g.hsr[i]) g.hsrf[i] &= ~(HSRF_GROUND | HSRF_STATION);
  }
  for (let i = 0; i < N; i++) {
    if (!g.hsr[i]) continue;
    for (const [din, dout] of bendsOf(g.hsr[i])) arcCells(g, i, din, dout, (j) => g.hsr[j] !== 0, out);
  }
  for (const i of out) {
    g.hsrf[i] |= HSRF_COVER;
    g.tree[i] = 0;
    if (!g.road[i] && !g.bldg[i]) { g.zone[i] = 0; g.zden[i] = 0; }
  }
}

// ---------------- 線路を引く計画 ----------------
export interface HsrLinePlan {
  ok: boolean;
  path: LinePath;
  ground: boolean;
  cost: number;
  bad: Set<number>;
  reason: string;
  cover: number[]; // 新しくカーブの内側になるマス
}

export function planHsrLine(g: Grid, path: LinePath, ground: boolean): HsrLinePlan {
  const n = g.n;
  const bad = new Set<number>();
  let reason = '';
  const why = (r: string) => { reason = reason || r; };
  const { cells, dirs } = path;
  // 引いたあとの接続（変わるマスだけ）
  const over = new Map<number, number>();
  for (let k = 0; k < dirs.length; k++) {
    const a = cells[k], b = cells[k + 1];
    over.set(a, (over.get(a) ?? g.hsr[a]) | (1 << dirs[k]));
    over.set(b, (over.get(b) ?? g.hsr[b]) | (1 << opp(dirs[k])));
  }
  const m: MaskOf = (i) => over.get(i) ?? g.hsr[i];
  const level = (i: number) => (g.hsr[i] ? isHsrGround(g, i) : ground);
  let cost = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const x = i % n, y = (i / n) | 0;
    const din = k > 0 ? dirs[k - 1] : -1, dout = k < dirs.length ? dirs[k] : -1;
    const along = (mask: number) => [din, dout].some((dd) => dd >= 0 && (mask & ((1 << dd) | (1 << opp(dd)))) !== 0);
    const len = k > 0 && isDiag(dirs[k - 1]) ? 1.41 : 1;
    if (!g.hsr[i]) cost += (ground ? HSR_GROUND_COST : LINES.hsr.cost) * len;
    const stn = (g.hsrf[i] & HSRF_STATION) !== 0;
    if (g.bldg[i] && !stn) { bad.add(i); why('建物があります。先に取り壊してください'); }
    if (g.aport[i]) { bad.add(i); why('空港の道路には引けません'); }
    if (stn) {
      // 駅の中は、駅の向きのまっすぐな線路だけ
      const ax = hsrBits(g.hsr[i])[0] ?? -1;
      if (ax < 0 || (m(i) & ~((1 << ax) | (1 << opp(ax))))) { bad.add(i); why(HSR_MSG_STATION); }
    }
    if (g.hsrf[i] & HSRF_COVER && !g.hsr[i]) { bad.add(i); why('ほかの高速鉄道のカーブにかかっています'); }
    if (level(i)) {
      // 地上の線路：街の外だけ。道路や線路とは交差できない（踏切は作らない）
      if (g.isWater(x, y)) { bad.add(i); why('地上の線路は水の上に引けません（高架を使ってください）'); }
      if (g.road[i]) { bad.add(i); why('地上の高速鉄道は道路と交差できません（高架にしてください）'); }
      if (g.rail[i]) { bad.add(i); why('地上の高速鉄道は線路と交差できません（高架にしてください）'); }
      if (!g.hsr[i]) {
        let town = g.zone[i] !== 0;
        for (let dy = -1; dy <= 1 && !town; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!g.inb(x + dx, y + dy)) continue;
          const j = g.idx(x + dx, y + dy);
          if (g.bldg[j] && !(g.hsrf[j] & HSRF_STATION) && !stnBody(g, j)) { town = true; break; }
        }
        if (town) { bad.add(i); why('地上の線路は街の外にしか引けません（街の中は高架にしてください）'); }
      }
      if ((g.erail[i] && along(g.erail[i])) || (g.mono[i] && along(g.mono[i])) || (g.up[i] && along(g.conn1[i]))) { bad.add(i); why(HSR_MSG_PARALLEL); }
    } else {
      // 高架：ほかの高架の道路・線路とは交差だけ。下を通る高架の道路が高すぎるときは、その高速道路を上に持ち上げる（hwrail.ts。planTransitLine が確かめる）
      if (g.up[i] && along(g.conn1[i])) { bad.add(i); why(HSR_MSG_PARALLEL); }
      else if (g.up[i] && !isUrbanElevated(g.up[i]) && g.up[i] !== RoadType.Highway && g.upH[i] + 0.3 + HSR_CLEAR > hsrDeckH(g, i) - HSR_GIRDER) { bad.add(i); why('下の高架の道路が高すぎて交差できません'); }
      if ((g.erail[i] && along(g.erail[i])) || (g.mono[i] && along(g.mono[i])) || (g.rail[i] && along(g.rail[i]))) { bad.add(i); why(HSR_MSG_PARALLEL); }
    }
  }
  // 斜めの線路どうしの交差
  for (let k = 0; k < dirs.length; k++) {
    const d = dirs[k];
    if (!isDiag(d)) continue;
    const i = cells[k];
    const x = i % n, y = (i / n) | 0;
    const ax = x + DX[d], ay = y, bx = x, by = y + DY[d];
    if (!g.inb(ax, ay) || !g.inb(bx, by)) continue;
    const dd = (DX[d] > 0) === (DY[d] > 0) ? (DX[d] > 0 ? 3 : 7) : DX[d] > 0 ? 5 : 1;
    if (m(ay * n + ax) & (1 << dd)) { bad.add(i); why('斜めの線路どうしは交差できません'); }
  }
  // 形：曲がりは 45° まで、分かれ道はまっすぐから 45°。曲がる所の前後にまっすぐな区間
  const isStation = (i: number) => (g.hsrf[i] & HSRF_STATION) !== 0;
  const special = new Set<number>();
  for (const i of over.keys()) {
    const k = hsrNodeKind(m(i));
    if (k.kind === 'bad') { bad.add(i); why(k.reason!); continue; }
    if (k.kind === 'bend' || k.kind === 'turnout') {
      if (isStation(i)) { bad.add(i); why(HSR_MSG_STATION); }
      special.add(i);
    }
  }
  // 引いた線の近くにある、前からの曲がる所も調べる（新しい曲がりとの間隔）
  for (const i of over.keys()) {
    const x = i % n, y = (i / n) | 0;
    for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
      if (!g.inb(x + dx, y + dy)) continue;
      const j = g.idx(x + dx, y + dy);
      const k = g.hsr[j] ? hsrNodeKind(m(j)).kind : 'end';
      if (k === 'bend' || k === 'turnout') special.add(j);
    }
  }
  const cover = new Set<number>();
  const isTrack = (i: number) => m(i) !== 0;
  for (const c of special) {
    const k = hsrNodeKind(m(c));
    const arms = k.kind === 'bend' ? hsrBits(m(c)) : [k.back!, k.branch!];
    for (const d of arms) {
      const r = checkArm(g, m, c, d, isStation);
      if (!r.ok) { bad.add(c); why(r.reason); }
    }
    for (const [din, dout] of bendsOf(m(c))) arcCells(g, c, din, dout, isTrack, cover);
  }
  // カーブの内側のマス
  const newCover: number[] = [];
  for (const i of cover) {
    if (g.hsrf[i] & HSRF_COVER) continue;
    newCover.push(i);
    if (g.bldg[i]) { bad.add(i); why(isStation(i) || stnBody(g, i) ? HSR_MSG_STN_CURVE : '建物があります（カーブの内側）'); }
    // 地上のカーブの内側は道路・線路と交差できない
    if (ground && (g.road[i] || g.rail[i])) { bad.add(i); why('地上の高速鉄道は道路と交差できません（高架にしてください）'); }
  }
  return { ok: bad.size === 0 && cells.length > 1, path, ground, cost: Math.round(cost), bad, reason, cover: newCover };
}

// 駅の敷地（ホームの列でないマス）か：となりのホームのマスと同じ建物
function stnBody(g: Grid, i: number) {
  const id = g.bldg[i];
  if (!id) return false;
  const x = i % g.n, y = (i / g.n) | 0;
  for (let r = -3; r <= 3; r++) for (const [dx, dy] of [[r, 0], [0, r]]) {
    if (!g.inb(x + dx, y + dy)) continue;
    const j = g.idx(x + dx, y + dy);
    if (g.bldg[j] === id && g.hsrf[j] & HSRF_STATION) return true;
  }
  return false;
}

export function applyHsrLine(g: Grid, p: HsrLinePlan) {
  const { cells, dirs } = p.path;
  for (const i of cells) {
    if (!g.hsr[i]) {
      if (p.ground) g.hsrf[i] |= HSRF_GROUND;
      else g.hsrf[i] &= ~HSRF_GROUND;
    }
  }
  for (let k = 0; k < dirs.length; k++) {
    g.hsr[cells[k]] |= 1 << dirs[k];
    g.hsr[cells[k + 1]] |= 1 << opp(dirs[k]);
  }
  for (const i of cells) {
    g.tree[i] = 0;
    if (!g.road[i]) { g.zone[i] = 0; g.zden[i] = 0; }
  }
  recomputeHsrCover(g);
}

// マス i の高速鉄道の線路を外す（となりのマスのつながりも）
export function removeHsrAt(g: Grid, i: number) {
  const n = g.n, x = i % n, y = (i / n) | 0;
  for (let d = 0; d < 8; d++) {
    if (!(g.hsr[i] & (1 << d))) continue;
    if (g.inb(x + DX[d], y + DY[d])) g.hsr[(y + DY[d]) * n + x + DX[d]] &= ~(1 << opp(d));
  }
  g.hsr[i] = 0;
  g.hsrf[i] &= ~(HSRF_GROUND | HSRF_STATION);
}

// ---------------- 駅 ----------------
// 駅の向きと線路の列：axis 0 = 東西（14×4）、1 = 南北（4×14）。row = 短い向きの何列目に線路があるか（1 か 2）
export interface HsrStn {
  axis: 0 | 1;
  row: number;
  ground: boolean;
  deck: number; // 線路の床版の高さ（世界の座標、m）
  out: [boolean, boolean]; // 駅の端（a = 0 の側、a = 13 の側）から外へ線路が続いているか
}
export interface HsrStationPlan extends PlopPlan {
  hsr?: HsrStn & { fill: number[] };
}

// 駅のマス：a = 長い向き（0..13）、r = 短い向き（0..3）
export function stnCell(g: Grid, x0: number, y0: number, axis: 0 | 1, a: number, r: number) {
  return axis === 0 ? g.idx(x0 + a, y0 + r) : g.idx(x0 + r, y0 + a);
}
export const stnAxisDir = (axis: 0 | 1) => (axis === 0 ? 0 : 2); // a が増える向き（東・南）

export function planHsrStation(g: Grid, cx: number, cy: number): HsrStationPlan {
  const def = CIVIC.hsr_station;
  let best: HsrStationPlan | null = null, bestScore = Infinity;
  for (const axis of [0, 1] as const) {
    const W = axis === 0 ? HSR_STN_LEN : 4, H = axis === 0 ? 4 : HSR_STN_LEN;
    for (let off = -3; off <= 3; off++) for (const row of [1, 2]) {
      // 線路の列が指の位置（短い向き）から off ずれた所
      const tr = (axis === 0 ? cy : cx) + off;
      const x0 = axis === 0 ? cx - 6 : tr - row, y0 = axis === 0 ? tr - row : cy - 6;
      const x = Math.max(0, Math.min(g.n - W, x0)), y = Math.max(0, Math.min(g.n - H, y0));
      const p = checkStation(g, x, y, axis, row, def.cost);
      // 線路の上に置けるものを優先し、指に近いものを選ぶ
      const score = (p.ok ? 0 : p.hsr ? 1000 : 2000) + Math.abs(off) * 10 + (row === 1 ? 0 : 1);
      if (score < bestScore) { bestScore = score; best = p; }
    }
  }
  return best!;
}

function checkStation(g: Grid, x0: number, y0: number, axis: 0 | 1, row: number, termCost: number): HsrStationPlan {
  const n = g.n, L = HSR_STN_LEN;
  const W = axis === 0 ? L : 4, H = axis === 0 ? 4 : L;
  const cells: number[] = [];
  let reason = '';
  const why = (r: string) => { reason = reason || r; };
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (let yy = y0; yy < y0 + H; yy++) for (let xx = x0; xx < x0 + W; xx++) {
    cells.push(g.idx(xx, yy));
    lo = Math.min(lo, g.cellMinH(xx, yy));
    hi = Math.max(hi, g.cellMaxH(xx, yy));
    sum += g.cellH(xx, yy);
  }
  const base: PlopPlan = { ok: false, id: 'hsr_station', x: x0, y: y0, cells, cost: termCost, reason: '', flatH: sum / cells.length, w: W, h: H };
  const ad = stnAxisDir(axis), axisBits = (1 << ad) | (1 << opp(ad));
  // 線路の列
  const trk: number[] = [];
  for (let a = 0; a < L; a++) trk.push(stnCell(g, x0, y0, axis, a, row));
  const has = trk.map((i) => g.hsr[i] !== 0);
  if (!has.some(Boolean)) return { ...base, reason: '高速鉄道のまっすぐな線路の上に置いてください（線路の端でもよい）' };
  for (const i of trk) if (g.hsr[i] & ~axisBits) why('駅は、まっすぐな線路の上に置いてください（駅の向きと線路の向きが合いません）');
  // 線路は駅の端から入ってくる（駅の中だけで終わっている線路の切れ端には置けない）
  const first = has.indexOf(true), last = has.lastIndexOf(true);
  const inFrom0 = has[0] && (g.hsr[trk[0]] & (1 << opp(ad))) !== 0;
  const inFromL = has[L - 1] && (g.hsr[trk[L - 1]] & (1 << ad)) !== 0;
  if (!inFrom0 && !inFromL && !(first === 0 || last === L - 1)) why('線路の端か途中に、線路の向きに合わせて置いてください');
  // 地上か高架か（前からある線路に合わせる）
  const ground = trk.some((i) => g.hsr[i] && isHsrGround(g, i)) && !trk.some((i) => isHsrElevated(g, i));
  for (const i of cells) {
    const xx = i % n, yy = (i / n) | 0;
    const onTrk = trk.includes(i);
    if (g.bldg[i]) why('建物があります');
    if (g.road[i] || g.up[i]) why('道路があります');
    if (g.rail[i] || g.erail[i] || g.mono[i]) why('ほかの線路があります');
    if (g.aport[i]) why('空港の道路があります');
    if (!onTrk && g.hsr[i]) why('ほかの高速鉄道の線路があります');
    if (g.hsrf[i] & HSRF_COVER && !g.hsr[i]) why('高速鉄道のカーブにかかっています');
    if (g.isWater(xx, yy)) why('水の上には置けません');
    if (g.quay[i] === 2) why('遊歩道があります');
  }
  if (hi - lo > 12) why('地面の傾きが大きすぎます');
  // 道路に接しているか（どちらかの長い辺か、短い辺）
  let road = false;
  for (let yy = y0 - 1; yy <= y0 + H; yy++) for (let xx = x0 - 1; xx <= x0 + W; xx++) {
    if (!g.inb(xx, yy) || (xx >= x0 && xx < x0 + W && yy >= y0 && yy < y0 + H)) continue;
    const t = g.road[g.idx(xx, yy)];
    if (t && !isHighway(t) && t !== RoadType.Ramp) road = true;
  }
  if (!road) why('道路に接するように置いてください');
  // 駅の外の線路：駅のすぐ外にカーブがあると、カーブが駅にかかる
  for (const [end, d] of [[trk[0], opp(ad)], [trk[L - 1], ad]] as const) {
    if (!(g.hsr[end] & (1 << d))) continue;
    let cur = end, dist = 0;
    for (let s = 0; s < 8; s++) {
      const j = nbr(g, cur, d);
      if (j < 0 || !(g.hsr[j] & (1 << opp(d)))) break;
      dist += CELL;
      const k = hsrNodeKind(g.hsr[j]).kind;
      if ((k === 'bend' || k === 'turnout') && dist - CELL / 2 < HSR_T) { why(HSR_MSG_STN_CURVE); break; }
      cur = j;
    }
  }
  const out: [boolean, boolean] = [inFrom0, inFromL];
  const through = out[0] && out[1];
  const fill = trk.filter((i, a) => !has[a] || (a > 0 && !(g.hsr[i] & (1 << opp(ad)))) || (a < L - 1 && !(g.hsr[i] & (1 << ad))));
  const flat = sum / cells.length;
  const deck = Math.max(flat, WATER_LEVEL) + (ground ? HSR_GROUND_LIFT : HSR_LIFT);
  const cost = (through ? HSR_THROUGH_COST : termCost) + Math.round((hi - lo) * W * H * 2);
  return { ...base, ok: !reason, reason, cost, hsr: { axis, row, ground, deck, out, fill } };
}

// 駅を置く：線路の列を駅の端から端まで線路にし、ホームの印をつける
export function applyHsrStation(g: Grid, x0: number, y0: number, s: HsrStn) {
  const ad = stnAxisDir(s.axis);
  for (let a = 0; a < HSR_STN_LEN; a++) {
    const i = stnCell(g, x0, y0, s.axis, a, s.row);
    if (!g.hsr[i]) {
      if (s.ground) g.hsrf[i] |= HSRF_GROUND;
      else g.hsrf[i] &= ~HSRF_GROUND;
    }
    if (a > 0) g.hsr[i] |= 1 << opp(ad);
    if (a < HSR_STN_LEN - 1) g.hsr[i] |= 1 << ad;
    g.hsrf[i] |= HSRF_STATION;
  }
}
// 駅の線路の今の様子（端から外へ続いているか）
export function hsrStationOut(g: Grid, x0: number, y0: number, s: HsrStn): [boolean, boolean] {
  const ad = stnAxisDir(s.axis);
  const a0 = stnCell(g, x0, y0, s.axis, 0, s.row), a1 = stnCell(g, x0, y0, s.axis, HSR_STN_LEN - 1, s.row);
  return [(g.hsr[a0] & (1 << opp(ad))) !== 0, (g.hsr[a1] & (1 << ad)) !== 0];
}
export function hsrStationTrack(g: Grid, b: { x: number; y: number; hsr?: HsrStn }): number[] {
  if (!b.hsr) return [];
  const out: number[] = [];
  for (let a = 0; a < HSR_STN_LEN; a++) {
    const i = stnCell(g, b.x, b.y, b.hsr.axis, a, b.hsr.row);
    if (g.hsr[i]) out.push(i);
  }
  return out;
}

// 駅前広場：高速鉄道の駅の長い辺に接して置く
export function planHsrPlaza(g: Grid, cx: number, cy: number, plain: (W: number, H: number) => PlopPlan): PlopPlan {
  const stnIds = new Set<number>();
  for (let i = 0; i < g.hsrf.length; i++) if (g.hsrf[i] & HSRF_STATION && g.bldg[i]) stnIds.add(g.bldg[i]);
  const touches = (p: PlopPlan) => {
    for (let yy = p.y - 1; yy <= p.y + p.h; yy++) for (let xx = p.x - 1; xx <= p.x + p.w; xx++) {
      if (!g.inb(xx, yy) || (xx >= p.x && xx < p.x + p.w && yy >= p.y && yy < p.y + p.h)) continue;
      const inCorner = (xx < p.x || xx >= p.x + p.w) && (yy < p.y || yy >= p.y + p.h);
      if (!inCorner && stnIds.has(g.bldg[g.idx(xx, yy)])) return true;
    }
    return false;
  };
  const cands = [plain(10, 4), plain(4, 10)];
  const touching = cands.filter(touches);
  for (const p of cands) if (p.ok && !touches(p)) { p.ok = false; p.reason = '高速鉄道の駅の隣に置いてください'; }
  // 駅に接する向きを選ぶ（どちらも置けるなら、長い辺が駅に接する向き）
  const ok = cands.filter((p) => p.ok);
  if (!ok.length) return touching[0] ?? cands[0];
  const long = (p: PlopPlan) => {
    let k = 0;
    for (let yy = p.y - 1; yy <= p.y + p.h; yy++) for (let xx = p.x - 1; xx <= p.x + p.w; xx++) if (g.inb(xx, yy) && stnIds.has(g.bldg[g.idx(xx, yy)])) k++;
    return k;
  };
  return ok.sort((a, b) => long(b) - long(a))[0];
}

// ---------------- 線の形（描画・列車・カーブの内側で共通） ----------------
export interface HsrPoly {
  n: number; // 点の数
  x: Float32Array;
  z: Float32Array;
  s: Float32Array; // 始点からの道のり（m）
  h: Float32Array; // 線路の床版の上面の高さ（m）
  lift: Float32Array; // 床版の地面からの高さ
  arc: Uint8Array; // カーブの上の点
  ci: Int32Array; // 点ごとの、いちばん近いマス（cells の番号）
  cells: number[];
  cellS: Float32Array; // マスの中心の道のり
  len: number;
}

// マスの並び（つながった線路）から、なめらかな線を作る。pre / post = 始点の前・終点の後に、まっすぐ続く向き（分かれ道の曲がりのため。-1 = なし）
export function hsrPoly(g: Grid, cells: number[], pin?: Map<number, number>, pre = -1, post = -1, loop = false): HsrPoly {
  const n = g.n;
  const cx = (i: number) => ((i % n) + 0.5) * CELL, cz = (i: number) => (((i / n) | 0) + 0.5) * CELL;
  // 頂点：端と、向きが変わるマス
  type Vx = { x: number; z: number; k: number; bend: boolean };
  const V: Vx[] = [];
  const dirAt = (k: number) => {
    const a = cells[k], b = cells[k + 1];
    return [cx(b) - cx(a), cz(b) - cz(a)];
  };
  if (pre >= 0) {
    const l = Math.hypot(DX[pre], DY[pre]);
    V.push({ x: cx(cells[0]) - (DX[pre] / l) * 2 * HSR_T, z: cz(cells[0]) - (DY[pre] / l) * 2 * HSR_T, k: -1, bend: false });
  }
  for (let k = 0; k < cells.length; k++) {
    let bend = false;
    if (k > 0 && k < cells.length - 1) {
      const [ax, az] = dirAt(k - 1), [bx, bz] = dirAt(k);
      bend = Math.abs(ax * bz - az * bx) > 1e-6;
    } else if (k === 0 && pre >= 0 && cells.length > 1) {
      const [bx, bz] = dirAt(0);
      bend = Math.abs(DX[pre] * bz - DY[pre] * bx) > 1e-6;
    } else if (k === cells.length - 1 && post >= 0 && cells.length > 1) {
      const [ax, az] = dirAt(k - 1);
      bend = Math.abs(ax * DY[post] - az * DX[post]) > 1e-6;
    }
    if (k === 0 || k === cells.length - 1 || bend) V.push({ x: cx(cells[k]), z: cz(cells[k]), k, bend });
  }
  if (post >= 0) {
    const l = Math.hypot(DX[post], DY[post]), e = cells[cells.length - 1];
    V.push({ x: cx(e) + (DX[post] / l) * 2 * HSR_T, z: cz(e) + (DY[post] / l) * 2 * HSR_T, k: -1, bend: false });
  }
  const X: number[] = [], Z: number[] = [], A: number[] = [];
  const push = (x: number, z: number, arc: boolean) => {
    const m = X.length;
    if (m && Math.abs(X[m - 1] - x) < 1e-3 && Math.abs(Z[m - 1] - z) < 1e-3) return;
    X.push(x); Z.push(z); A.push(arc ? 1 : 0);
  };
  // 頂点ごとの接線の長さ
  const T = V.map((v, i) => {
    if (!v.bend || i === 0 || i === V.length - 1) return 0;
    const lp = Math.hypot(v.x - V[i - 1].x, v.z - V[i - 1].z), ln = Math.hypot(V[i + 1].x - v.x, V[i + 1].z - v.z);
    return Math.min(HSR_T, lp * (V[i - 1].bend ? 0.5 : 1), ln * (V[i + 1].bend ? 0.5 : 1));
  });
  const straight = (x0: number, z0: number, x1: number, z1: number) => {
    const l = Math.hypot(x1 - x0, z1 - z0), m = Math.max(1, Math.ceil(l / 8));
    for (let j = 1; j <= m; j++) push(x0 + ((x1 - x0) * j) / m, z0 + ((z1 - z0) * j) / m, false);
  };
  let px = V[0].x, pz = V[0].z;
  // 分かれ道の前の仮の点からは、曲線の始まりから描く
  const trimHead = pre >= 0;
  if (!trimHead) push(px, pz, false);
  for (let i = 1; i < V.length; i++) {
    const v = V[i];
    if (T[i] > 0) {
      const p = V[i - 1], q = V[i + 1];
      const li = Math.hypot(v.x - p.x, v.z - p.z), lo = Math.hypot(q.x - v.x, q.z - v.z);
      const ax = v.x - ((v.x - p.x) / li) * T[i], az = v.z - ((v.z - p.z) / li) * T[i];
      const bx = v.x + ((q.x - v.x) / lo) * T[i], bz = v.z + ((q.z - v.z) / lo) * T[i];
      if (trimHead && i === 1) push(ax, az, true);
      else straight(px, pz, ax, az);
      const M = 14;
      for (let j = 1; j <= M; j++) {
        const t = j / M, p0 = (1 - t) * (1 - t), p1 = 2 * t * (1 - t), p2 = t * t;
        push(p0 * ax + p1 * v.x + p2 * bx, p0 * az + p1 * v.z + p2 * bz, j < M);
      }
      px = bx; pz = bz;
    } else if (i === V.length - 1 && post >= 0) {
      // 分かれ道の後の仮の点：曲線の終わりまで
      break;
    } else {
      if (trimHead && i === 1) push(px, pz, false);
      straight(px, pz, v.x, v.z);
      px = v.x; pz = v.z;
    }
  }
  if (loop && X.length > 1) push(X[0], Z[0], false);
  const N = X.length;
  const x = Float32Array.from(X), z = Float32Array.from(Z), arc = Uint8Array.from(A);
  const s = new Float32Array(N);
  for (let k = 1; k < N; k++) s[k] = s[k - 1] + Math.hypot(x[k] - x[k - 1], z[k] - z[k - 1]);
  // マスの中心の道のりと、点ごとのいちばん近いマス
  const cellS = new Float32Array(cells.length), ci = new Int32Array(N);
  let p = 0;
  for (let k = 0; k < cells.length; k++) {
    const qx = cx(cells[k]), qz = cz(cells[k]);
    let bd = Infinity;
    for (let j = p; j < N; j++) {
      const d = (x[j] - qx) ** 2 + (z[j] - qz) ** 2;
      if (d <= bd) { bd = d; p = j; } else if (d > bd + 4 * CELL * CELL) break;
    }
    cellS[k] = s[p];
  }
  let c = 0;
  for (let j = 0; j < N; j++) {
    while (c + 1 < cells.length && Math.abs(cellS[c + 1] - s[j]) <= Math.abs(cellS[c] - s[j])) c++;
    ci[j] = c;
  }
  // 高さ：地面（なめらかにする）+ 高架か地上の高さ（坂でつなぐ）。駅の中は駅の床版の高さ
  const gr = new Float32Array(N), lv = new Float32Array(N), h = new Float32Array(N);
  for (let j = 0; j < N; j++) gr[j] = Math.max(g.groundAt(x[j], z[j]), WATER_LEVEL);
  const sm = new Float32Array(N);
  for (let pass = 0; pass < 2; pass++) {
    let a = 0, b = 0, acc = 0;
    for (let j = 0; j < N; j++) {
      while (b < N && s[b] <= s[j] + 32) acc += gr[b++];
      while (s[a] < s[j] - 32) acc -= gr[a++];
      sm[j] = acc / (b - a);
    }
    gr.set(sm);
  }
  const elev = (j: number) => !isHsrGround(g, cells[ci[j]]);
  // 地上の点は、いちばん近い高架の点からの距離で坂にする
  const dist = new Float32Array(N).fill(1e9);
  for (let j = 0; j < N; j++) if (elev(j)) dist[j] = 0; else if (j > 0) dist[j] = dist[j - 1] + (s[j] - s[j - 1]);
  for (let j = N - 2; j >= 0; j--) dist[j] = Math.min(dist[j], dist[j + 1] + (s[j + 1] - s[j]));
  for (let j = 0; j < N; j++) {
    const t = Math.max(0, 1 - dist[j] / HSR_RAMP), e = t * t * (3 - 2 * t);
    lv[j] = HSR_GROUND_LIFT + (HSR_LIFT - HSR_GROUND_LIFT) * e;
    h[j] = gr[j] + lv[j];
  }
  if (pin && pin.size) {
    // 駅の床版の高さに合わせる（駅の前後 60m でなめらかにつなぐ）
    const pv = new Float32Array(N).fill(NaN);
    for (let j = 0; j < N; j++) { const v = pin.get(cells[ci[j]]); if (v !== undefined) pv[j] = v; }
    const near = new Float32Array(N).fill(1e9), nv = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      if (!isNaN(pv[j])) { near[j] = 0; nv[j] = pv[j]; } else if (j > 0 && near[j - 1] < 1e9) { near[j] = near[j - 1] + s[j] - s[j - 1]; nv[j] = nv[j - 1]; }
    }
    for (let j = N - 2; j >= 0; j--) {
      const d = near[j + 1] + s[j + 1] - s[j];
      if (d < near[j]) { near[j] = d; nv[j] = nv[j + 1]; }
    }
    for (let j = 0; j < N; j++) {
      if (near[j] >= 60) continue;
      const t = near[j] / 60, w = 1 - t * t * (3 - 2 * t);
      h[j] = h[j] * (1 - w) + nv[j] * w;
    }
  }
  for (let j = 0; j < N; j++) lv[j] = h[j] - Math.max(g.groundAt(x[j], z[j]), WATER_LEVEL);
  return { n: N, x, z, s, h, lift: lv, arc, ci, cells, cellS, len: N ? s[N - 1] : 0 };
}

// 線の上の道のり s の位置と向き（out に入れる。配列を作らない）
export function hsrAt(p: HsrPoly, s: number, out: { x: number; z: number; h: number; tx: number; tz: number }, hint = 0): number {
  const N = p.n;
  if (N < 2) { out.x = p.x[0] ?? 0; out.z = p.z[0] ?? 0; out.h = p.h[0] ?? 0; out.tx = 1; out.tz = 0; return 0; }
  let k = Math.max(0, Math.min(N - 2, hint));
  if (s < p.s[k] || s > p.s[k + 1]) {
    // 二分探索
    let a = 0, b = N - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (p.s[m] <= s) a = m; else b = m; }
    k = a;
  }
  const l = p.s[k + 1] - p.s[k] || 1;
  const t = Math.max(-2, Math.min(3, (s - p.s[k]) / l));
  const dx = p.x[k + 1] - p.x[k], dz = p.z[k + 1] - p.z[k], dl = Math.hypot(dx, dz) || 1;
  out.x = p.x[k] + dx * t;
  out.z = p.z[k] + dz * t;
  out.h = p.h[k] + (p.h[k + 1] - p.h[k]) * Math.max(0, Math.min(1, t));
  out.tx = dx / dl;
  out.tz = dz / dl;
  return k;
}

// ---------------- つながり（区間と路線） ----------------
// 区間：分かれ道・行き止まりのあいだのマスの並び（描画用）。pre / post は分かれ道の曲がり
export interface HsrChain { cells: number[]; pre: number; post: number; loop: boolean }
export function hsrChains(g: Grid): HsrChain[] {
  const N = g.n * g.n;
  const deg = (i: number) => hsrBits(g.hsr[i]).length;
  const used = new Set<string>();
  const out: HsrChain[] = [];
  const key = (a: number, d: number) => `${a}:${d}`;
  const walk = (start: number, d0: number) => {
    const cells = [start];
    let cur = start, d = d0;
    used.add(key(start, d0));
    for (let step = 0; step < N; step++) {
      const j = nbr(g, cur, d);
      if (j < 0 || !(g.hsr[j] & (1 << opp(d)))) break;
      used.add(key(j, opp(d)));
      cells.push(j);
      if (j === start) break;
      if (deg(j) !== 2) break;
      const nd = hsrBits(g.hsr[j]).find((k) => k !== opp(d))!;
      used.add(key(j, nd));
      cur = j;
      d = nd;
    }
    return cells;
  };
  // 分かれ道からの区間：分かれる線路なら、分かれ道の前の向きを pre にする
  const preOf = (c: number, d: number) => {
    const k = hsrNodeKind(g.hsr[c]);
    return k.kind === 'turnout' && k.branch === d ? opp(k.back!) : -1;
  };
  for (let i = 0; i < N; i++) {
    if (!g.hsr[i] || deg(i) === 2) continue;
    for (const d of hsrBits(g.hsr[i])) {
      if (used.has(key(i, d))) continue;
      const cells = walk(i, d);
      const e = cells[cells.length - 1];
      const pe = cells[cells.length - 2];
      const dl = cells.length > 1 ? dirOf((e % g.n) - (pe % g.n), ((e / g.n) | 0) - ((pe / g.n) | 0)) : -1;
      const post = dl >= 0 ? (() => { const k = hsrNodeKind(g.hsr[e]); return k.kind === 'turnout' && k.branch === opp(dl) ? k.back! : -1; })() : -1;
      out.push({ cells, pre: preOf(i, d), post, loop: false });
    }
  }
  // 輪（分かれ道も行き止まりもない）
  for (let i = 0; i < N; i++) {
    if (!g.hsr[i] || deg(i) !== 2) continue;
    const d = hsrBits(g.hsr[i])[0];
    if (used.has(key(i, d))) continue;
    const cells = walk(i, d);
    out.push({ cells, pre: -1, post: -1, loop: cells[cells.length - 1] === i });
  }
  return out;
}

// 路線：行き止まり（ターミナル駅・マップの端）どうしを結ぶ道すじ（列車が走る）。分かれ道では 45° より急に曲がらない
export interface HsrRoute { cells: number[]; endA: 'edge' | 'end'; endB: 'edge' | 'end'; loop: boolean }
export function hsrRoutes(g: Grid, maxPerComp = 6): HsrRoute[] {
  const n = g.n, N = n * n;
  const comp = new Int32Array(N).fill(-1);
  const ends: number[][] = [];
  const loops: number[] = [];
  let nc = 0;
  for (let i = 0; i < N; i++) {
    if (!g.hsr[i] || comp[i] >= 0) continue;
    const q = [i], list: number[] = [];
    comp[i] = nc;
    while (q.length) {
      const c = q.pop()!;
      if (hsrBits(g.hsr[c]).length === 1) list.push(c);
      for (const d of hsrBits(g.hsr[c])) {
        const j = nbr(g, c, d);
        if (j >= 0 && g.hsr[j] && comp[j] < 0) { comp[j] = nc; q.push(j); }
      }
    }
    ends.push(list);
    if (!list.length) loops.push(i);
    nc++;
  }
  const isEdge = (c: number) => { const x = c % n, y = (c / n) | 0; return x === 0 || y === 0 || x === n - 1 || y === n - 1; };
  const out: HsrRoute[] = [];
  // 状態（マス、入ってきた向き）の幅優先探索
  const path = (a: number, b: number): number[] | null => {
    const d0 = hsrBits(g.hsr[a])[0];
    const prev = new Map<number, number>();
    const startKey = a * 8 + 8; // 仮
    const q: [number, number][] = [];
    const j0 = nbr(g, a, d0);
    if (j0 < 0) return null;
    prev.set(j0 * 8 + d0, startKey);
    q.push([j0, d0]);
    for (let h = 0; h < q.length; h++) {
      const [c, din] = q[h];
      if (c === b) {
        const cells = [c];
        let k = c * 8 + din;
        while (true) { const p = prev.get(k)!; if (p === startKey) break; cells.push((p / 8) | 0); k = p; }
        cells.push(a);
        return cells.reverse();
      }
      for (const d of hsrBits(g.hsr[c])) {
        if (d === opp(din) || hsrTurn(opp(din), d) > 1) continue;
        const j = nbr(g, c, d);
        if (j < 0 || !(g.hsr[j] & (1 << opp(d)))) continue;
        const kk = j * 8 + d;
        if (prev.has(kk)) continue;
        prev.set(kk, c * 8 + din);
        q.push([j, d]);
      }
    }
    return null;
  };
  for (const list of ends) {
    let k = 0;
    for (let i = 0; i < list.length && k < maxPerComp; i++) for (let j = i + 1; j < list.length && k < maxPerComp; j++) {
      const p = path(list[i], list[j]);
      if (!p || p.length < 2) continue;
      out.push({ cells: p, endA: isEdge(list[i]) ? 'edge' : 'end', endB: isEdge(list[j]) ? 'edge' : 'end', loop: false });
      k++;
    }
  }
  for (const s of loops) {
    // 輪：ひと回り
    const cells = [s];
    let cur = s, d = hsrBits(g.hsr[s])[0];
    for (let step = 0; step < N; step++) {
      const j = nbr(g, cur, d);
      if (j < 0 || j === s) break;
      cells.push(j);
      const nd = hsrBits(g.hsr[j]).find((x) => x !== opp(d) && hsrTurn(opp(d), x) <= 1);
      if (nd === undefined) break;
      cur = j;
      d = nd;
    }
    if (cells.length > 4) out.push({ cells: [...cells, s], endA: 'end', endB: 'end', loop: true });
  }
  return out;
}

// マップの端までつながっている高速鉄道のマス
export function hsrReachEdge(g: Grid): Uint8Array {
  const n = g.n;
  const reach = new Uint8Array(n * n);
  const q: number[] = [];
  for (let i = 0; i < n * n; i++) {
    const x = i % n, y = (i / n) | 0;
    if ((x === 0 || y === 0 || x === n - 1 || y === n - 1) && g.hsr[i]) { reach[i] = 1; q.push(i); }
  }
  while (q.length) {
    const c = q.pop()!;
    for (const d of hsrBits(g.hsr[c])) {
      const j = nbr(g, c, d);
      if (j >= 0 && g.hsr[j] && !reach[j]) { reach[j] = 1; q.push(j); }
    }
  }
  return reach;
}

// ---------------- 騒音と防音壁 ----------------
// 防音壁：住宅地（住宅のゾーン）のそばの線路のマス。sides のビット 1 = 線路の右（進む向き d の時計回り側）… ではなく、
// マスごとに「住宅地が 2 マス以内にあるか」で決める（描画は左右それぞれの側を見て決める）
export function hsrBarrier(g: Grid, i: number): boolean {
  if (!g.hsr[i] || g.hsrf[i] & HSRF_STATION) return false;
  const n = g.n, x = i % n, y = (i / n) | 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (!g.inb(x + dx, y + dy)) continue;
    if (g.zone[g.idx(x + dx, y + dy)] === ZoneType.R) return true;
  }
  return false;
}
// 世界の座標 (wx, wz) のそばに住宅地があるか（描画で、防音壁を線路のどちらの側に立てるか決める）
export function resNear(g: Grid, wx: number, wz: number, r = 1): boolean {
  const cx = Math.floor(wx / CELL), cy = Math.floor(wz / CELL);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (!g.inb(cx + dx, cy + dy)) continue;
    if (g.zone[g.idx(cx + dx, cy + dy)] === ZoneType.R) return true;
  }
  return false;
}
export const HSR_NOISE_R = 4; // 騒音の届く範囲（マス）
export const HSR_BARRIER_CUT = 0.35; // 防音壁があると、騒音がこの割合になる
// 線路の騒音（0..1）。列車の本数が多いほど少し大きい（traffic = 0..1）
export function hsrNoise(g: Grid, traffic: number, out: Float32Array) {
  const n = g.n, N = n * n, R = HSR_NOISE_R;
  out.fill(0);
  const base = 0.55 + 0.45 * Math.max(0, Math.min(1, traffic));
  for (let i = 0; i < N; i++) {
    if (!g.hsr[i]) continue;
    const src = base * (hsrBarrier(g, i) ? HSR_BARRIER_CUT : 1) * (g.hsrf[i] & HSRF_STATION ? 0.5 : 1);
    const x = i % n, y = (i / n) | 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (!g.inb(x + dx, y + dy)) continue;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const v = src * (1 - d / (R + 1));
      const j = g.idx(x + dx, y + dy);
      if (v > out[j]) out[j] = v;
    }
  }
  return out;
}
