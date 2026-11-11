// 重ねランプ（高架の都市高速 ⇔ 真下の一般道）の、描く形と車の道すじ
//
// シミュレーションでは、ランプは本線のノードと ORAMP_LEN マス先の一般道のノードを結ぶ 1本のつながり。
// 描くときは、本線の車線から接するように分かれて高架の横に出て、横を並んで下り、低くなってから
// 下の道路の車線（道の端か、道の真ん中）へ横にずれて降りる。入口は同じ形を逆にたどる。
//
// 座標：s = ランプの始まり（ランプの最初のマスの、上流側の辺）からの、本線に沿った長さ（車の進む向きが +）。
//       o = 本線の中心線からの横の長さ（進む向きの右が +）。
//       q = 「出口として見た長さ」（出口は q = s、入口は q = len - s）。q = 0 が本線の側、q = len が一般道の側
import { Grid } from '../sim/grid';
import { CELL, DX, DY, isDiag } from '../sim/constants';
import { ROADS, RoadType } from '../sim/defs';
import { listORamps, orampGround, orampHw, orampSide, ORampSpec } from '../sim/oramp';

export const OR_HALF = 3.0; // ランプの路面の半分の幅（車線 3.5m と路肩、6m）
export const OR_LANE = 1.75; // ランプの車線の半分の幅
const PAR = 0.25; // 欄干の厚さ
const DIV = 20; // 本線から分かれて、横に出るまでの長さ
const GROUND_RUN = 6; // 一般道の高さで走る長さ（一般道の側の端）
const MOVE = 30; // 高架の横から、一般道の車線へ横にずれる長さ
const EASE = 0.3; // 坂の始まりと終わりの、勾配が変わる部分の割合

export interface ORGeo {
  r: ORampSpec;
  from: number; // ノード
  to: number;
  len: number; // m
  ox: number; // s = 0 の、本線の中心線の上の点
  oz: number;
  ux: number; // 進む向き
  uz: number;
  rx: number; // 右
  rz: number;
  sg: number; // ランプが本線のどちらの横を通るか（+1 = 右）
  hwHalf: number; // 本線の路面の半分の幅
  Lh: number; // 本線の車線の横の位置
  Lb: number; // 高架の横を並んで走るときの横の位置
  Lg: number; // 一般道の車線の横の位置（本線の中心から）
  gOff: number; // 一般道のマスの中心の横の位置（大通りの反対車線なら CELL）
  gLane: number; // 一般道の車線（そのマスの中心から）
  gType: number; // 一般道の種類
  hh: number[]; // 本線の路面の高さ（マスの中心ごと、k = -1..ORAMP_LEN+1）
  gh: number[]; // 一般道の路面の高さ
  cell: number; // 1マスの長さ（斜めは √2 倍）
}

export interface ORPt { x: number; z: number; h: number; tx: number; tz: number; o: number }

const sstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
// 勾配が、はじめと終わりでなめらかに変わる坂（0..1）。中ほどは一定の勾配
export function slope01(t: number) {
  const e = EASE, k = 1 / (2 * e * (1 - e));
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < e) return t * t * k;
  if (t > 1 - e) return 1 - (1 - t) * (1 - t) * k;
  return (t - e / 2) / (1 - e);
}

// 本線の車線の横の位置（車の層と同じ）
function hwLane(t: number, median: boolean, sg: number) {
  const d = ROADS[t];
  if (d.oneWay) return (median ? -1 : 1) * d.width * 0.2;
  return sg * (d.width / 2) * 0.48;
}
// 一般道の、ランプが降りる車線の横の位置（そのマスの中心から）
export function groundLane(t: number, median: boolean) {
  if (t === RoadType.Avenue) return median ? -1.6 : 1.6;
  if (t === RoadType.OneWay) return median ? -2.0 : 2.0;
  return median ? 0 : (ROADS[RoadType.Road].width / 2) * 0.48; // 片側1車線：道の真ん中はセンターラインの上
}

export function orGeo(g: Grid, r: ORampSpec, lift: number): ORGeo | null {
  const n = g.n;
  const hw = orampHw(g, r), gr = orampGround(g, r);
  if (hw.some((c) => c < 0) || gr.some((c) => c < 0)) return null;
  const a = r.a, diag = isDiag(a);
  const ul = diag ? Math.SQRT2 : 1;
  const ux = DX[a] / ul, uz = DY[a] / ul, rx = -uz, rz = ux;
  const cell = CELL * ul;
  const x0 = (hw[0] % n) + 0.5, y0 = ((hw[0] / n) | 0) + 0.5;
  const ox = x0 * CELL - ux * cell * 0.5, oz = y0 * CELL - uz * cell * 0.5;
  const ht = g.up[hw[0]], gt = g.road[gr[0]];
  const sg = orampSide(g, r);
  const hwHalf = (ROADS[ht]?.width ?? 9) / 2;
  const gOff = r.partner ? CELL * (diag ? Math.SQRT2 : 1) : 0;
  const gLane = groundLane(gt, r.median);
  const hh: number[] = [], gh: number[] = [];
  for (let k = -1; k <= hw.length; k++) {
    const kk = Math.max(0, Math.min(hw.length - 1, k));
    const xx = (hw[kk] % n) + DX[a] * (k - kk), yy = ((hw[kk] / n) | 0) + DY[a] * (k - kk);
    const c = g.inb(xx, yy) ? yy * n + xx : hw[kk];
    hh.push((g.up[c] ? g.upH[c] : g.upH[hw[kk]]) + lift);
    const gc = r.partner ? (() => { const px = xx + DX[(a + 2) & 7], py = yy + DY[(a + 2) & 7]; return g.inb(px, py) ? py * n + px : gr[kk]; })() : c;
    gh.push((g.road[gc] ? g.roadH(gc) : g.roadH(gr[kk])) + lift);
  }
  const link = g.orampLink(r.start);
  if (!link) return null;
  return {
    r, from: link[0], to: link[1], len: hw.length > 1 ? (hw.length - 1) * cell : cell, ox, oz, ux, uz, rx, rz, sg, hwHalf,
    Lh: hwLane(ht, r.median, sg), Lb: sg * (hwHalf + PAR + OR_HALF + 0.15), Lg: gOff + gLane, gOff, gLane, gType: gt, hh, gh, cell,
  };
}

// s での本線と一般道の路面の高さ（マスの中心の間を結ぶ）
function interp(G: ORGeo, arr: number[], s: number) {
  const f = Math.max(0, Math.min(arr.length - 1.001, s / G.cell + 0.5)), k = Math.floor(f);
  return arr[k] + (arr[k + 1] - arr[k]) * (f - k);
}
export const orHwH = (G: ORGeo, s: number) => interp(G, G.hh, s);
export const orGroundH = (G: ORGeo, s: number) => interp(G, G.gh, s);
const qOf = (G: ORGeo, s: number) => (G.r.entry ? G.len - s : s);

// 横の位置（q で）
export function orO(G: ORGeo, q: number) {
  const L = G.len;
  const div = sstep(q / DIV);
  const mv = sstep((q - (L - MOVE)) / (MOVE - 2));
  return G.Lh + (G.Lb - G.Lh) * div + (G.Lg - G.Lb) * mv;
}
// 地面からの高さの割合（0 = 本線、1 = 一般道）
export function orT(G: ORGeo, q: number) {
  return slope01(q / (G.len - GROUND_RUN));
}
export function orH(G: ORGeo, s: number) {
  const t = orT(G, qOf(G, s));
  return orHwH(G, s) + (orGroundH(G, s) - orHwH(G, s)) * t;
}
export function orAt(G: ORGeo, s: number, out: ORPt = { x: 0, z: 0, h: 0, tx: 1, tz: 0, o: 0 }): ORPt {
  const q = qOf(G, s);
  const o = orO(G, q);
  const e = 0.05, d = (orO(G, q + e) - orO(G, q - e)) / (2 * e) * (G.r.entry ? -1 : 1);
  out.o = o;
  out.x = G.ox + G.ux * s + G.rx * o;
  out.z = G.oz + G.uz * s + G.rz * o;
  const tx = G.ux + G.rx * d, tz = G.uz + G.rz * d, l = Math.hypot(tx, tz) || 1;
  out.tx = tx / l;
  out.tz = tz / l;
  out.h = orH(G, s);
  return out;
}
// 点の s
export function orS(G: ORGeo, x: number, z: number) {
  return (x - G.ox) * G.ux + (z - G.oz) * G.uz;
}
// 曲線の長さ（車が走る長さ）
export function orLen(G: ORGeo) {
  let acc = 0;
  const P: ORPt = { x: 0, z: 0, h: 0, tx: 1, tz: 0, o: 0 }, Q: ORPt = { ...P };
  orAt(G, 0, P);
  for (let k = 1; k <= 32; k++) {
    orAt(G, (G.len * k) / 32, Q);
    acc += Math.hypot(Q.x - P.x, Q.z - P.z, Q.h - P.h);
    Object.assign(P, Q);
  }
  return acc;
}

export function findORamps(g: Grid, lift: number): ORGeo[] {
  const out: ORGeo[] = [];
  for (const r of listORamps(g)) {
    if (!g.orampLink(r.start)) continue;
    const G = orGeo(g, r, lift);
    if (G) out.push(G);
  }
  return out;
}
export const orKey = (from: number, to: number) => from * 4194304 + to;
