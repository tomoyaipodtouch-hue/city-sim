// 空港のターミナル前の道路（フォアコート）：街の都市高速と同じ「本物の道路のマス」で作る。
//
// 正門のマス（敷地のすぐ外）で、引いてきた道路（都市高速・一般道）が 2 本のランプに分かれる（Y 字。ジャンクションの T 字・Y 字と同じ形）。
//   入る側：正門から大きなカーブで、ターミナルの前の 1 列目（F）へ。F は 2 層（高架 = 出発の車寄せ、地上 = 到着の車寄せ）の一方通行（2 車線）
//   出る側：外側の列（R、一方通行 2 車線）から、正門へ戻る
// 正門の道路と同じ階（main）の F がそのまま続き、もう一方の階（other）の F へは、F から分かれて坂で上り下りするランプ（D）で入る。
// 西の端で U ターン（大きな半円のランプ）して R へ。もう一方の階の F は、
//   merge：U ターンの手前で坂を上り下りして、U ターンのランプに合わさる（小・中。F と R がとなりの列）
//   stack：同じ階のまま U ターンして R の同じ階を走り、途中で坂を上り下りして R に合わさる（大。F と R の間に列がある）
// 曲がるところはすべてジャンクションのランプのマス（jct の印）。描くとき・車が走るときは、なめらかな曲線になる（render/jctCurve.ts）。
//
// 座標は陸側の座標（land。a = ターミナルに沿う向き、c = 外向き）。マスはこの座標の直線・曲線をマスに置きかえて決める。
// シミュレーション（world.ts）と画面（airport の層・道路の層）の両方で使う
import { CELL, DX, DY, isDiag } from './constants';
import type { AirFrame, AirportLayout, GateCell } from './airport';
import { landToLot, lotToLand, toLocal, toWorld } from './airport';
import { RoadType } from './defs';

export interface FcSpec {
  cF: number; // 1 列目（車寄せ）の c
  cR: number; // 戻りの列の c
  cD: number; // 分かれ道（もう一方の階の F へ上り下りする）の列の c
  aDiv: [number, number]; // F から分かれる a、もう一方の階の F が始まる a
  variant: 'merge' | 'stack';
  cM: number; // merge：U ターンの手前で坂を上り下りする列の c。stack：R から分かれて坂を上り下りする列の c
  aMerge: [number, number]; // merge：もう一方の階の F が終わる a、U ターンに合わさる a。stack：R から分かれる a、R に合わさる a
  aU: number; // U ターンの始まり（F の終わり）の a
  cTop: number; // U ターンのいちばん内側（ターミナルの側）の c。cF と同じなら、F からそのまま半円で R へ
}

export interface FcPath {
  name: string; // 'IN' | 'RET' | 'DIV' | 'U' | 'Uo' | 'MRG' | 'EXT' | 'Fm' | 'Fo' | 'Rm' | 'Ro'
  row: boolean; // 一方通行の都市高速の列（ほかはランプのマス）
  cells: number[];
  lv: number[]; // マスごとの階（0 = 地上、1 = 上空）
  h: number[]; // 地面からの路面の高さ（m）
  type: number; // 列の種類（ランプは RoadType.Ramp）
}
export interface FcPlan {
  ok: boolean;
  reason: string;
  level: 0 | 1; // 正門の階（main）
  H: number; // 高架の高さ（地面から）
  gate: number; // 正門のマス
  paths: FcPath[];
  cells: number[]; // 敷地の中のフォアコートのマス
  // 画面用：列の中心線（land の座標）
  lines: { F: number; R: number; D: number; M: number };
  rows: { name: string; c: number; a0: number; a1: number; lv: number }[]; // 列（a0 > a1 は -a へ進む）
  bad: number[]; // 計画できなかったマス
}

// ---- land の座標とマス ----
export interface LandGrid {
  n: number;
  f: AirFrame;
  L: AirportLayout;
  cellAt(a: number, c: number): number; // land の点を含むマス
  centre(i: number): [number, number]; // マスの中心（land）
  diag: boolean; // land の a の向きが、マスの斜め
  step: number; // 列のマスの間隔（m）
  pitch: number; // となりの列の間隔（m）
}
export function landGrid(n: number, f: AirFrame, L: AirportLayout): LandGrid {
  const cellAt = (a: number, c: number) => {
    const [la, lc] = landToLot(L, a, c), [X, Z] = toWorld(f, la, lc);
    const x = Math.floor(X / CELL), y = Math.floor(Z / CELL);
    return x < 0 || y < 0 || x >= n || y >= n ? -1 : y * n + x;
  };
  const centre = (i: number): [number, number] => {
    const [la, lc] = toLocal(f, ((i % n) + 0.5) * CELL, (((i / n) | 0) + 0.5) * CELL);
    return lotToLand(L, la, lc);
  };
  // land の a の向き（世界）
  const [la0, lc0] = landToLot(L, 0, 0), [la1, lc1] = landToLot(L, 1, 0);
  const [X0, Z0] = toWorld(f, la0, lc0), [X1, Z1] = toWorld(f, la1, lc1);
  const diag = Math.abs(Math.abs(X1 - X0) - Math.abs(Z1 - Z0)) < 0.1;
  return { n, f, L, cellAt, centre, diag, step: diag ? CELL * Math.SQRT2 : CELL, pitch: diag ? CELL * Math.SQRT1_2 : CELL };
}

const dirBetween = (n: number, a: number, b: number) => {
  const dx = (b % n) - (a % n), dy = ((b / n) | 0) - ((a / n) | 0);
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
};
const turnAbs = (a: number, b: number) => { const t = (b - a + 8) & 7; return t > 4 ? 8 - t : t; };

// land の直線（c の一定の列）の上のマス（中心が線から 1m 以内）
function lineCells(G: LandGrid, lot: (i: number) => boolean, c: number, a0: number, a1: number): number[] {
  const out: [number, number][] = [];
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  for (let a = lo - G.step; a <= hi + G.step; a += G.step / 4) {
    const i = G.cellAt(a, c);
    if (i < 0 || !lot(i)) continue;
    const [ca, cc] = G.centre(i);
    if (Math.abs(cc - c) > 1 || ca < lo - 0.5 || ca > hi + 0.5) continue;
    if (!out.some((q) => q[0] === i)) out.push([i, ca]);
  }
  out.sort((p, q) => (a0 <= a1 ? p[1] - q[1] : q[1] - p[1]));
  return out.map((q) => q[0]);
}

// いちばん近い列の c（敷地のマスの中心が並ぶ線）
export function snapLine(G: LandGrid, lot: (i: number) => boolean, cells: number[], c: number): number {
  let best = c, bd = Infinity;
  for (const i of cells) {
    const cc = G.centre(i)[1];
    const d = Math.abs(cc - c);
    if (d < bd) { bd = d; best = cc; }
  }
  void lot;
  return Math.round(best * 100) / 100;
}

// land の折れ線（細かい点）を、始まりのマスから終わりのマスまでの 8 方向のマスの並びにする
export function rasterize(G: LandGrid, start: number, end: number, pts: [number, number][]): number[] {
  const n = G.n;
  const cells = [start];
  let cur = start;
  const walk = (t: number) => {
    for (let guard = 0; cur !== t && guard < 64; guard++) {
      const dx = Math.sign((t % n) - (cur % n)), dy = Math.sign(((t / n) | 0) - ((cur / n) | 0));
      cur += dy * n + dx;
      cells.push(cur);
    }
  };
  // 点の下のマス（マスの境の 1.5m 以内の点は、どちらのマスか決めない）
  const { f, L } = G;
  for (const [a, c] of pts) {
    const [la, lc] = landToLot(L, a, c), [X, Z] = toWorld(f, la, lc);
    const fx = X / CELL - Math.floor(X / CELL), fz = Z / CELL - Math.floor(Z / CELL), m = 1.5 / CELL;
    if (fx < m || fx > 1 - m || fz < m || fz > 1 - m) continue;
    const t = G.cellAt(a, c);
    if (t >= 0) walk(t);
  }
  walk(end);
  // 曲線からの距離
  const dist = (p: [number, number]) => {
    let best = Infinity;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [a0, c0] = pts[k], [a1, c1] = pts[k + 1], va = a1 - a0, vc = c1 - c0, l2 = va * va + vc * vc || 1;
      const u = Math.max(0, Math.min(1, ((p[0] - a0) * va + (p[1] - c0) * vc) / l2));
      best = Math.min(best, Math.hypot(p[0] - a0 - va * u, p[1] - c0 - vc * u));
    }
    return best;
  };
  // 戻り・重なりを除く
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 1; k < cells.length; k++) {
      const j = cells.indexOf(cells[k]);
      if (j < k) { cells.splice(j + 1, k - j); changed = true; break; }
    }
    // 角を切る（となりのとなりが 8 方向のとなりで、斜めに結ぶ線のほうが曲線に近いなら、間のマスを除く）
    for (let k = 1; k + 1 < cells.length && !changed; k++) {
      if (dirBetween(n, cells[k - 1], cells[k + 1]) < 0) continue;
      const A = G.centre(cells[k - 1]), C = G.centre(cells[k + 1]);
      if (dist([(A[0] + C[0]) / 2, (A[1] + C[1]) / 2]) <= dist(G.centre(cells[k])) + 2) { cells.splice(k, 1); changed = true; }
    }
  }
  return cells;
}

// 設計の曲線に沿う、1 マスに 45° までしか曲がらないマスの並び（始まりのマス・向き → 終わりのマス・向き）。
// 曲線からの離れ方と、曲線に沿った進み方のむら（近道）を小さくする最短経路。blocked のマスは通らない
export function routeChain(G: LandGrid, start: number, d0: number, end: number, d1: number, pts: [number, number][], blocked: Set<number>, lot: (i: number) => boolean): number[] | null {
  const n = G.n;
  // 曲線の長さ（点ごと）
  const S = [0];
  for (let k = 1; k < pts.length; k++) S.push(S[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const proj = (p: [number, number]) => {
    let best = Infinity, bs = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [a0, c0] = pts[k], [a1, c1] = pts[k + 1], va = a1 - a0, vc = c1 - c0, l2 = va * va + vc * vc || 1;
      const u = Math.max(0, Math.min(1, ((p[0] - a0) * va + (p[1] - c0) * vc) / l2));
      const d = Math.hypot(p[0] - a0 - va * u, p[1] - c0 - vc * u);
      if (d < best) { best = d; bs = S[k] + (S[k + 1] - S[k]) * u; }
    }
    return [best, bs];
  };
  const info = new Map<number, [number, number]>();
  const get = (i: number) => { let v = info.get(i); if (!v) info.set(i, (v = proj(G.centre(i)) as [number, number])); return v; };
  const key = (i: number, d: number) => i * 8 + d;
  const dist = new Map<number, number>(), prev = new Map<number, number>();
  const open: [number, number][] = [];
  const push = (k: number, c: number) => {
    open.push([c, k]);
    for (let j = open.length - 1; j > 0;) { const p = (j - 1) >> 1; if (open[p][0] <= open[j][0]) break; [open[p], open[j]] = [open[j], open[p]]; j = p; }
  };
  const pop = () => {
    const top = open[0], last = open.pop()!;
    if (open.length) {
      open[0] = last;
      for (let j = 0; ;) { let c = 2 * j + 1; if (c >= open.length) break; if (c + 1 < open.length && open[c + 1][0] < open[c][0]) c++; if (open[c][0] >= open[j][0]) break; [open[c], open[j]] = [open[j], open[c]]; j = c; }
    }
    return top;
  };
  const k0 = key(start, d0);
  dist.set(k0, 0);
  push(k0, 0);
  let goal = -1;
  for (let guard = 0; open.length && guard < 200000; guard++) {
    const [c, k] = pop();
    if (c > (dist.get(k) ?? Infinity)) continue;
    const i = Math.floor(k / 8), din = k & 7;
    if (i === end && turnAbs(din, d1) <= 1 && i !== start) { goal = k; break; }
    const [, si] = get(i);
    for (const dd of [-1, 0, 1]) {
      const d = (din + dd + 8) & 7;
      const x = (i % n) + DX[d], y = ((i / n) | 0) + DY[d];
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const j = y * n + x;
      if (j !== end && (blocked.has(j) || !lot(j) || j === start)) continue;
      const [dj, sj] = get(j);
      if (dj > 22 && j !== end) continue;
      const len = isDiag(d) ? CELL * Math.SQRT2 : CELL;
      const ds = sj - si;
      if (ds < -2) continue; // 後ろへ戻らない
      const cost = 1 + (dj / 6) ** 2 + ((ds - len) / 8) ** 2 + Math.abs(dd) * 0.3;
      const kk = key(j, d), nc = c + cost;
      if (nc < (dist.get(kk) ?? Infinity)) { dist.set(kk, nc); prev.set(kk, k); push(kk, nc); }
    }
  }
  if (goal < 0) return null;
  const out: number[] = [];
  for (let k: number | undefined = goal; k !== undefined; k = prev.get(k)) out.push(Math.floor(k / 8));
  return out.reverse();
}

// なめらかな曲線の点（land）を作る道具
type P2 = [number, number];
export function sampleArc(ca: number, cc: number, r: number, t0: number, t1: number, step = 2): P2[] {
  const k = Math.max(2, Math.ceil((Math.abs(t1 - t0) * r) / step));
  const out: P2[] = [];
  for (let j = 0; j <= k; j++) { const t = t0 + ((t1 - t0) * j) / k; out.push([ca + Math.cos(t) * r, cc + Math.sin(t) * r]); }
  return out;
}
// a0 → a1 へ進みながら、c を c0 から c1 へ（なめらかな S 字）
function sampleS(a0: number, c0: number, a1: number, c1: number, step = 2): P2[] {
  const k = Math.max(2, Math.ceil(Math.abs(a1 - a0) / step));
  const out: P2[] = [];
  for (let j = 0; j <= k; j++) { const u = j / k, e = u * u * (3 - 2 * u); out.push([a0 + (a1 - a0) * u, c0 + (c1 - c0) * e]); }
  return out;
}
function sampleLine(a0: number, c0: number, a1: number, c1: number, step = 2): P2[] {
  const k = Math.max(1, Math.ceil(Math.hypot(a1 - a0, c1 - c0) / step));
  const out: P2[] = [];
  for (let j = 0; j <= k; j++) out.push([a0 + ((a1 - a0) * j) / k, c0 + ((c1 - c0) * j) / k]);
  return out;
}

export const FC_RISE = 2; // 坂の高さの変わり方（m / マス）。ジャンクションのランプと同じ
export const FC_CLEAR = 6; // 立体交差の下の空き（m）

// フォアコートの計画。lot = 敷地のマスか、cells = 敷地のマス、gate = 正門、level = 正門の道路の階、H = 高架の高さ
export function forecourtPlan(n: number, f: AirFrame, L: AirportLayout, cellsLot: number[], lot: (i: number) => boolean, gate: GateCell, level: 0 | 1, H = 9): FcPlan {
  const S = L.fc;
  const G = landGrid(n, f, L);
  const fail = (reason: string, bad: number[] = []): FcPlan => ({ ok: false, reason, level, H, gate: gate.cell, paths: [], cells: [], lines: { F: S.cF, R: S.cR, D: S.cD, M: S.cM }, rows: [], bad });
  const cF = snapLine(G, lot, cellsLot, S.cF), cR = snapLine(G, lot, cellsLot, S.cR);
  const cD = snapLine(G, lot, cellsLot, S.cD), cM = snapLine(G, lot, cellsLot, S.cM);
  const Hm = level ? H : 0, Ho = level ? 0 : H;
  const lvOf = (h: number) => (h > 0.01 ? 1 : 0);
  const paths: FcPath[] = [];
  const rowType = (h: number) => (h > 0.01 ? RoadType.UrbanHighway1W : RoadType.UrbanGroundHighway1W);
  const row = (name: string, c: number, a0: number, a1: number, h: number): FcPath | null => {
    const cells = lineCells(G, lot, c, a0, a1);
    if (cells.length < 2) return null;
    const p: FcPath = { name, row: true, cells, lv: cells.map(() => lvOf(h)), h: cells.map(() => h), type: rowType(h) };
    paths.push(p);
    return p;
  };
  const dirOfPath = (p: FcPath, k: number) => (k + 1 < p.cells.length ? dirBetween(n, p.cells[k], p.cells[k + 1]) : dirBetween(n, p.cells[k - 1], p.cells[k]));
  const inward = (gate.d + 4) & 7;
  // Y 字の分かれ目：正門のマス。門のとなりの敷地のマス（まっすぐ内側と、そこから -a の側へ 45°）がなければ、
  // 門の内側のマス（gate.inner）まで両方向の道路を 1 マスのばして、そこで分かれる
  const nbOf = (i: number, d: number) => { const x = (i % n) + DX[d], y = ((i / n) | 0) + DY[d]; return x < 0 || y < 0 || x >= n || y >= n ? -1 : y * n + x; };
  const sideL = [(inward + 1) & 7, (inward + 7) & 7].map((d) => nbOf(gate.cell, d)).filter((i) => i >= 0).sort((p, q) => G.centre(p)[0] - G.centre(q)[0])[0];
  const atGate = lot(nbOf(gate.cell, inward)) && sideL !== undefined && lot(sideL);
  const Y = atGate ? gate.cell : gate.inner;
  const near = (cells: number[], a: number) => {
    let best = 0, bd = Infinity;
    cells.forEach((i, k) => { const d = Math.abs(G.centre(i)[0] - a); if (d < bd) { bd = d; best = k; } });
    return best;
  };
  // ランプのマスの並び（両端のマスは本線・門・分かれ目のマスで、ランプには含めない）。heights = 両端の高さ
  const used = new Set<number>(); // ランプが通ったマス（ほかのランプは通らない）
  let routeFail = '';
  const chain = (name: string, a: number, da: number, b: number, db: number, pts: P2[], h0: number, h1: number, corr?: number): FcPath => {
    const cells = routeChain(G, a, da, b, db, pts, used, (i) => lot(i) || i === Y) ?? [a, b];
    if (!routeFail && cells.length < 3 && dirBetween(n, a, b) < 0) routeFail = name;
    for (let k = 1; k + 1 < cells.length; k++) used.add(cells[k]);
    const m = cells.length;
    const h = cells.map(() => h0);
    if (h0 !== h1) {
      // 高さを変えるのは、坂の列（corr）の上のマスと、その前後の 1 マス。なければ鎖の真ん中
      const on = cells.map((i, k) => k > 0 && k < m - 1 && corr !== undefined && Math.abs(G.centre(i)[1] - corr) < 1);
      let k0 = on.indexOf(true) - 1, k1 = on.lastIndexOf(true) + 1;
      // 坂の長さ（m）：1 マス（16m）に FC_RISE m まで。斜めのマス（22.6m）は、そのぶん高さを変えられる
      const stepLen = (k: number) => (isDiag(dirBetween(n, cells[k], cells[k + 1])) ? CELL * Math.SQRT2 : CELL);
      const needLen = (Math.abs(h1 - h0) / FC_RISE) * CELL - 0.01;
      const lenOf = (a: number, b: number) => { let t = 0; for (let k = a; k < b; k++) t += stepLen(k); return t; };
      if (k0 < 0) { const mid = (m - 1) / 2; k0 = Math.max(0, Math.floor(mid - 2)); k1 = Math.min(m - 1, k0 + 4); }
      // 坂の列が短いときは、前後のマスへ広げる（上下に重なるところの空きは、あとで確かめる）
      for (let side = 0; lenOf(k0, k1) < needLen && (k0 > 0 || k1 < m - 1); side ^= 1) { if (side ? k1 < m - 1 : k0 === 0) k1++; else k0--; }
      // k0 までは h0、k1 から先は h1、その間は道のりに比例して
      const tot = Math.max(1, lenOf(k0, k1));
      let acc = 0;
      for (let k = 0; k < m; k++) {
        if (k > k0 && k <= k1) acc += stepLen(k - 1);
        const u = k <= k0 ? 0 : k >= k1 ? 1 : acc / tot;
        h[k] = h0 + (h1 - h0) * u;
      }
    }
    const p: FcPath = { name, row: false, cells, lv: h.map(lvOf), h, type: RoadType.Ramp };
    paths.push(p);
    return p;
  };

  // ---- 正門から F へ（入る）・R から正門へ（出る）：中心が門の内側の大きな 4 分の 1 円 ----
  const [ya, ycc] = G.centre(Y);
  if (!atGate) paths.push({ name: 'STEM', row: true, cells: [gate.cell, Y], lv: [lvOf(Hm), lvOf(Hm)], h: [Hm, Hm], type: Hm > 0.01 ? RoadType.UrbanHighway : RoadType.UrbanGroundHighway });
  const rIn = ycc - cF, rOut = ycc - cR;
  if (rIn < CELL || rOut < CELL * 0.8) return fail('正門と車寄せの間が近すぎます', [gate.cell]);
  const aF0 = ya - rIn; // F が始まる a
  const Fm = row('Fm', cF, aF0, S.aU, Hm);
  if (!Fm) return fail('車寄せの列が作れません');
  // 入る：正門の中心から、門の内向き（-c）に進んで左へ曲がり、F の向き（-a）へ
  const inPts: P2[] = [...sampleArc(ya + 2 - rIn, ycc, rIn, 0, -Math.PI / 2)];
  const IN = chain('IN', Y, inward, Fm.cells[0], dirOfPath(Fm, 0), inPts, Hm, Hm);
  // ---- U ターン：F の終わりから、内側（cTop）へ寄せて大きな半円で R へ ----
  const aUend = G.centre(Fm.cells[Fm.cells.length - 1])[0];
  const r = (cR - S.cTop) / 2, cm = S.cTop + r;
  const veer = S.cTop < cF - 0.5 ? Math.max(2 * G.step, (cF - S.cTop) * 2.2) : 0;
  const ac = aUend - veer; // 半円の中心の a
  const uPts: P2[] = [...(veer ? sampleS(aUend, cF, ac, S.cTop) : []), ...sampleArc(ac, cm, r, -Math.PI / 2, -Math.PI * 1.5)];
  // R が始まるマス：半円の下の端（ac, cR）から +a へ
  const RmLine = lineCells(G, lot, cR, ac, ya);
  if (RmLine.length < 4) return fail('戻りの列が作れません');
  // 戻り：R の終わりは、正門への 4 分の 1 円の始まり
  const aR1 = rOut > 20.5 ? ya - 22 - Math.max(32, (rOut - 20) * 1.8) : ya - 2 - rOut;
  const iR0 = near(RmLine, ac + 2), iR1 = near(RmLine, aR1);
  const Rcells = RmLine.slice(iR0, iR1 + 1);
  if (Rcells.length < 3) return fail('戻りの列が短すぎます');
  const Rm: FcPath = { name: 'Rm', row: true, cells: Rcells, lv: Rcells.map(() => lvOf(Hm)), h: Rcells.map(() => Hm), type: rowType(Hm) };
  paths.push(Rm);
  chain('U', Fm.cells[Fm.cells.length - 1], dirOfPath(Fm, Fm.cells.length - 1), Rm.cells[0], dirOfPath(Rm, 0), uPts, Hm, Hm);
  const outPts: P2[] = [];
  {
    // 正門の近くは小さめの半径（入る側と、門のとなりで別のマスを通るように）。R からその高さまでは S 字で寄せる
    const r2 = Math.min(rOut, 20), as = ya - 2 - r2;
    if (rOut > r2 + 0.5) outPts.push(...sampleS(as - Math.max(32, (rOut - r2) * 1.8), cR, as, ycc - r2));
    outPts.push(...sampleArc(as, ycc, r2, -Math.PI / 2, 0));
  }
  chain('RET', Rm.cells[Rm.cells.length - 1], dirOfPath(Rm, Rm.cells.length - 1), Y, gate.d, outPts, Hm, Hm);

  // ---- もう一方の階の F：F から分かれ（D の列で上り下り）、F の真上・真下に入る ----
  const kD0 = near(Fm.cells, S.aDiv[0]);
  const aO0 = S.aDiv[1];
  const FoEnd = S.variant === 'merge' ? S.aMerge[0] : aUend;
  const Fo = row('Fo', cF, aO0, FoEnd, Ho);
  if (!Fo) return fail('もう一方の階の車寄せが作れません');
  {
    const [a1] = G.centre(Fo.cells[0]);
    const sl = Math.max(G.step * 1.5, Math.abs(cD - cF) * 1.8);
    if (cD > cF) {
      // 分かれ道の列が F の外側（F と R の間）：正門から入るランプの途中で分かれる
      // 分かれるマス：坂の列の少し外側の、入るランプのマスから順に、通せるところ
      const ks = IN.cells.map((_, k) => k).filter((k) => k >= 1 && k < IN.cells.length - 1).sort((p, q) => Math.abs(G.centre(IN.cells[p])[1] - (cD + G.pitch)) - Math.abs(G.centre(IN.cells[q])[1] - (cD + G.pitch)));
      let done = false;
      for (const kf of ks) {
        const [af, cf] = G.centre(IN.cells[kf]), [ap, cp] = G.centre(IN.cells[kf - 1]);
        if (af - a1 < 5 * G.step) continue;
        // 入るランプの向きのまま分かれ、なめらかに -a の向きへ（3 次ベジェ曲線）
        const tl = Math.hypot(af - ap, cf - cp) || 1, L1 = Math.max(sl, 40);
        const bz: P2[] = [];
        for (let j = 0; j <= 24; j++) {
          const u = j / 24, v = 1 - u;
          const P1: P2 = [af + ((af - ap) / tl) * L1 * 0.5, cf + ((cf - cp) / tl) * L1 * 0.5], P2_: P2 = [af - L1 + L1 * 0.5, cD];
          bz.push([v * v * v * af + 3 * v * v * u * P1[0] + 3 * v * u * u * P2_[0] + u * u * u * (af - L1), v * v * v * cf + 3 * v * v * u * P1[1] + 3 * v * u * u * P2_[1] + u * u * u * cD]);
        }
        const pts: P2[] = [...bz, ...sampleLine(af - L1, cD, a1 + sl, cD), ...sampleS(a1 + sl, cD, a1, cF)];
        const d0 = dirBetween(n, IN.cells[kf - 1], IN.cells[kf]);
        if (!routeChain(G, IN.cells[kf], d0, Fo.cells[0], dirOfPath(Fo, 0), pts, used, (i) => lot(i) || i === Y)) continue;
        chain('DIV', IN.cells[kf], d0, Fo.cells[0], dirOfPath(Fo, 0), pts, Hm, Ho, cD);
        done = true;
        break;
      }
      if (!done) return fail('分かれ道が作れません');
    } else {
      const [a0] = G.centre(Fm.cells[kD0]);
      const pts: P2[] = [...sampleS(a0, cF, a0 - sl, cD), ...sampleLine(a0 - sl, cD, a1 + sl, cD), ...sampleS(a1 + sl, cD, a1, cF)];
      chain('DIV', Fm.cells[kD0], dirOfPath(Fm, kD0), Fo.cells[0], dirOfPath(Fo, 0), pts, Hm, Ho, cD);
    }
  }
  if (S.variant === 'merge') {
    // U ターンの手前で、坂の列（cM）で上り下りして、U ターンのランプに合わさる
    const U = paths.find((p) => p.name === 'U')!;
    // 合わさるマス：U ターンのランプの、cM の列の上のマス
    let kj = -1;
    for (let k = 1; k < U.cells.length - 1; k++) if (Math.abs(G.centre(U.cells[k])[1] - cM) < 1) { kj = k; break; }
    if (kj < 0) return fail('合流の場所が作れません');
    const [a0] = G.centre(Fo.cells[Fo.cells.length - 1]);
    const [aj] = G.centre(U.cells[kj]);
    const sl = Math.max(G.step * 1.5, Math.abs(cM - cF) * 1.8);
    const pts: P2[] = [...sampleS(a0, cF, a0 - sl, cM), ...sampleLine(a0 - sl, cM, aj, cM)];
    chain('MRG', Fo.cells[Fo.cells.length - 1], dirOfPath(Fo, Fo.cells.length - 1), U.cells[kj], dirOfPath(U, kj), pts, Ho, Hm, cM);
  } else {
    // 同じ階のまま U ターン（同じマスの真上・真下）して R を走り、坂の列（cM）で上り下りして R に合わさる
    const U = paths.find((p) => p.name === 'U')!;
    const Uo: FcPath = { name: 'Uo', row: false, cells: U.cells.slice(), lv: U.cells.map(() => lvOf(Ho)), h: U.cells.map(() => Ho), type: RoadType.Ramp };
    Uo.cells[0] = Fo.cells[Fo.cells.length - 1];
    paths.push(Uo);
    const k0 = near(Rm.cells, S.aMerge[0]), k1 = near(Rm.cells, S.aMerge[1]);
    const RoCells = Rm.cells.slice(0, k0 + 1);
    const Ro: FcPath = { name: 'Ro', row: true, cells: RoCells, lv: RoCells.map(() => lvOf(Ho)), h: RoCells.map(() => Ho), type: rowType(Ho) };
    paths.push(Ro);
    const [a0] = G.centre(Rm.cells[k0]), [a1] = G.centre(Rm.cells[k1]);
    const sl = Math.max(G.step * 1.5, Math.abs(cM - cR) * 1.8);
    const pts: P2[] = [...sampleS(a0, cR, a0 + sl, cM), ...sampleLine(a0 + sl, cM, a1 - sl, cM), ...sampleS(a1 - sl, cM, a1, cR)];
    chain('EXT', Ro.cells[Ro.cells.length - 1], dirOfPath(Ro, Ro.cells.length - 1), Rm.cells[k1], dirOfPath(Rm, k1), pts, Ho, Hm, cM);
  }
  void IN;
  if (routeFail) return fail(`${routeFail} の道すじが作れません`);
  const plan: FcPlan = {
    ok: true, reason: '', level, H, gate: gate.cell, paths, cells: [],
    lines: { F: cF, R: cR, D: cD, M: cM },
    rows: paths.filter((p) => p.row).map((p) => ({ name: p.name, c: G.centre(p.cells[0])[1], a0: G.centre(p.cells[0])[0], a1: G.centre(p.cells[p.cells.length - 1])[0], lv: p.lv[0] })),
    bad: [],
  };
  const all = new Set<number>();
  for (const p of paths) for (const i of p.cells) if (i !== gate.cell) all.add(i);
  plan.cells = [...all];
  const v = validateForecourt(G, plan, lot);
  if (v.length) { plan.ok = false; plan.reason = v[0].why; plan.bad = v.map((q) => q.cell); }
  return plan;
}

// 計画の確かめ：マスが敷地の中、8 方向につながる、1 マスに 45° まで、同じ階で同じマスを 2 回使わない、
// 斜めのつながりが交差しない、上下に重なるところは 6m 以上あく
export function validateForecourt(G: LandGrid, P: FcPlan, lot: (i: number) => boolean): { cell: number; why: string }[] {
  const n = G.n, out: { cell: number; why: string }[] = [];
  const use = new Map<number, string>(); // (マス*2+階) → 使う道
  const hAt = new Map<number, number>();
  // 両端（本線・分かれ目・合わさり目）は、ほかの道と共有する
  for (const p of P.paths) {
    const m = p.cells.length;
    for (let k = 0; k < m; k++) {
      const i = p.cells[k];
      if (i !== P.gate && !lot(i)) out.push({ cell: i, why: `${p.name}: 敷地の外` });
      const end = !p.row && (k === 0 || k === m - 1);
      if (end) continue;
      const key = i * 2 + p.lv[k], o = use.get(key);
      if (o && o !== p.name) out.push({ cell: i, why: `${p.name}: ${o} と同じマス` });
      use.set(key, p.name);
      hAt.set(key, p.h[k]);
      if (k + 1 < m) {
        const d = dirBetween(n, i, p.cells[k + 1]);
        if (d < 0) out.push({ cell: i, why: `${p.name}: つながっていない` });
        if (k > 0) {
          const d0 = dirBetween(n, p.cells[k - 1], i);
          if (d0 >= 0 && d >= 0 && turnAbs(d0, d) > 1) out.push({ cell: i, why: `${p.name}: 45° より急な曲がり` });
        }
        if (Math.abs(p.h[k + 1] - p.h[k]) > (FC_RISE * (d >= 0 && isDiag(d) ? Math.SQRT2 : 1)) + 0.01) out.push({ cell: i, why: `${p.name}: 坂が急すぎる` });
      }
    }
    // ランプの両端の曲がり（ランプの最初・最後の 1 歩も 45° まで。両端は本線のつながりで見る）
    if (!p.row && m >= 3) {
      const a = dirBetween(n, p.cells[0], p.cells[1]), b = dirBetween(n, p.cells[1], p.cells[2]);
      if (a >= 0 && b >= 0 && turnAbs(a, b) > 1) out.push({ cell: p.cells[1], why: `${p.name}: 45° より急な曲がり` });
    }
  }
  // 上下に重なるマス：上空の路面が地上より 6m 以上高い
  for (const [key, name] of use) {
    if (key & 1) continue;
    const i = key >> 1, up = hAt.get(i * 2 + 1);
    if (up !== undefined && up < FC_CLEAR) out.push({ cell: i, why: `${name}: 上の道路が低すぎる（${up.toFixed(1)}m）` });
  }
  // 斜めのつながりの交差（同じ階）
  const links = new Set<number>();
  for (const p of P.paths) for (let k = 0; k + 1 < p.cells.length; k++) {
    const d = dirBetween(n, p.cells[k], p.cells[k + 1]);
    if (d >= 0) links.add((p.cells[k] * 8 + d) * 2 + Math.min(p.lv[k], p.lv[k + 1]));
  }
  for (const p of P.paths) for (let k = 0; k + 1 < p.cells.length; k++) {
    const i = p.cells[k], d = dirBetween(n, i, p.cells[k + 1]);
    if (d < 0 || !isDiag(d)) continue;
    const L = Math.min(p.lv[k], p.lv[k + 1]);
    const x = i % n, y = (i / n) | 0, a = y * n + x + DX[d], b = (y + DY[d]) * n + x;
    const dd = dirBetween(n, a, b);
    if (links.has((a * 8 + dd) * 2 + L) || links.has((b * 8 + ((dd + 4) & 7)) * 2 + L)) out.push({ cell: i, why: `${p.name}: 斜めの道路が交差` });
  }
  return out;
}
