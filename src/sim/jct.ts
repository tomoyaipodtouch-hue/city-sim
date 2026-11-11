// ---- 都市高速どうしのジャンクション（JCT） ----
// 2本の都市高速を引いたあと、交わる（または合わさる）マスをタップすると、形ごとのランプを自動で作る。
//
// 形：
//   tee     … T字・Y字：片方の都市高速が、もう片方に突き当たって合わさる。左右への移りかえはランプで直結する
//   semi    … 十字・準直結型：右折は外側の小さなランプ、左折は本線の右から分かれて立体交差でまたぐランプ。ループなし
//   clover  … 十字・クローバー型（集散路つき）：左折はループ。ループの出入りの織り込みは、本線の横の集散路で行う
//   turbine … 十字・タービン型：左折のランプが、交差点のまわりをうず巻くように回る
//
// 道路の階層は2つ（地上 = 0、上空 = 1）しかない。立体交差は次の決まりで作る。
//   ・本線どうしは、交差点で必ず別の階層にする。同じ階層で交わっているときは、片方の本線を交差点の前後だけ
//     もう一方の階層へ移す（地上どうしは片方を高架へ持ち上げ、高架どうしは片方を地上へ下ろす）
//   ・ランプは、マスごとに「地上（高さ 0）」か「上空（高さ = 1.5m × 段）」のどちらかを通る。
//     上空のランプは、低い所（6m 未満）では下の地上のマスが空いていないといけない。6m 以上なら地上の道路やランプをまたげる。
//     地上のランプは、上空にあるものの下を 6m 以上あけてくぐれる
//   ・ランプの道筋は「マス・向き・高さの段」の最短経路で探す（向きは 1マスに 45° まで、高さは 1マスに 1段まで）。
//     これで、3つ目の階層がいる場所はよけて回り道を探す。見つからなければ、置けない理由と赤いマスを見せる
//
// 渋滞を起こしにくくする決まり：
//   ・本線から分かれるのは交差点の手前だけ、合流は交差点の先だけ（先に分岐・後で合流）。ランプどうしも、
//     分かれたランプが合わさることはあっても、合わさったあとに分かれることはない（織り込みなし。クローバー型は集散路の上だけ）
//   ・合流は本線の横を LACC マス並んで走ってから入る（長い加速車線）
//   ・ランプのマスは jct の印をつけ、ふつうのランプより容量と速さを大きくする（交通シミュレーション）
import { Grid } from './grid';
import { DX, DY, isDiag, opp } from './constants';
import { ROADS, RoadType, isHighway } from './defs';
import { hasSurfaceLine } from './plan';
import { isUrbanHighway, urbanTurnOk } from './traffic';

export type JctForm = 'tee' | 'semi' | 'clover' | 'turbine';
export const JCT_FORMS: JctForm[] = ['tee', 'semi', 'clover', 'turbine'];
export const JCT_NAMES: Record<JctForm, string> = {
  tee: 'T字・Y字',
  semi: '十字・準直結型',
  clover: '十字・クローバー型',
  turbine: '十字・タービン型',
};

export const JCT_HSTEP = 1.5; // ランプの高さの1段（m）。1マスに1段まで（約 9%）
export const JCT_CLEAR = 6; // 立体交差で下をあける高さ（m）
const HMAX = 8; // ランプの高さの段の上限（12m）
const NH = HMAX + 1;
const RB = 21; // 探す範囲（交差点から何マスまで）
const LDEC = 2; // 本線から分かれたあと、本線の横を並んで走るマス数（減速車線）
const LACC = 3; // 合流の前に、本線の横を並んで走るマス数（加速車線）
const ARM_MIN = 10; // 本線がまっすぐ続いていないといけない長さ（マス）
const MOVE_F = 1; // 本線を別の階層へ移すとき、交差点の前後で高さがそろう長さ（マス）
const MOVE_S = 6; // 本線を別の階層へ移すときの坂の長さ（マス）
const JCT_CELL_COST = 120;
const JCT_BASE_COST = 8000;

// 階層を移したときの本線の種類（高架 ⇔ 地上）
const TWIN: Record<number, number> = {
  [RoadType.UrbanHighway]: RoadType.UrbanGroundHighway,
  [RoadType.UrbanGroundHighway]: RoadType.UrbanHighway,
  [RoadType.UrbanHighway1W]: RoadType.UrbanGroundHighway1W,
  [RoadType.UrbanGroundHighway1W]: RoadType.UrbanHighway1W,
};
const isUrbanAny = (t: number) => t === RoadType.UrbanHighway || t === RoadType.UrbanGroundHighway || t === RoadType.UrbanHighway1W || t === RoadType.UrbanGroundHighway1W;

export interface JctPlan {
  ok: boolean;
  reason: string;
  cost: number;
  cells: number[]; // プレビューで見せるマス（ランプと、階層を移す本線）
  bad: Set<number>; // 置けない理由のマス（赤）
  out: Grid | null; // できあがりの地図（applyJct で写す）
  note?: string;
}

// ---------------- 地図の小さな道具 ----------------
const bit = (d: number) => 1 << (d & 7);
const conn = (g: Grid, c: number, L: number) => (L ? g.conn1[c] : g.conn[c]);
const typeAt = (g: Grid, c: number, L: number) => (L ? g.up[c] : g.road[c]);
function stepC(g: Grid, c: number, d: number, k = 1) {
  const n = g.n, x = (c % n) + DX[d & 7] * k, y = ((c / n) | 0) + DY[d & 7] * k;
  return g.inb(x, y) ? y * n + x : -1;
}
const gr = (g: Grid, c: number) => g.cellH(c % g.n, (c / g.n) | 0);
const popc = (m: number) => { let k = 0; for (; m; m &= m - 1) k++; return k; };
// 2つのマスを、それぞれの階層でつなぐ（fwd = a → b の流れ、back = b → a の流れ）
function setLink(g: Grid, a: number, la: number, b: number, lb: number, d: number, fwd: boolean, back: boolean) {
  if (la) g.conn1[a] |= bit(d); else g.conn[a] |= bit(d);
  if (lb) g.conn1[b] |= bit(opp(d)); else g.conn[b] |= bit(opp(d));
  if (fwd) { if (la) g.flow1[a] |= bit(d); else g.flow[a] |= bit(d); }
  if (back) { if (lb) g.flow1[b] |= bit(opp(d)); else g.flow[b] |= bit(opp(d)); }
}
function clearBits(g: Grid, c: number, L: number, m: number) {
  if (L) { g.conn1[c] &= ~m; g.flow1[c] &= ~m; } else { g.conn[c] &= ~m; g.flow[c] &= ~m; }
}
function dropNode(g: Grid, c: number, L: number) {
  if (L) { g.up[c] = 0; g.conn1[c] = 0; g.flow1[c] = 0; g.upH[c] = 0; g.jct[c] &= ~2; }
  else { g.road[c] = 0; g.conn[c] = 0; g.flow[c] = 0; g.jct[c] &= ~1; }
}
// 斜めのつながりが、同じ階層の逆向きの斜めのつながりと交差するか
function crossesDiag(g: Grid, c: number, d: number, L: number) {
  if (!isDiag(d)) return false;
  const n = g.n, x = c % n, y = (c / n) | 0;
  const ax = x + DX[d], ay = y, bx = x, by = y + DY[d];
  if (!g.inb(ax, ay) || !g.inb(bx, by)) return false;
  const dd = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => DX[k] === bx - ax && DY[k] === by - ay)!;
  return (conn(g, ay * n + ax, L) & bit(dd)) !== 0;
}
// 曲がりの大きさ（45° 単位、0..4）
const turnAbs = (a: number, b: number) => { const t = (b - a + 8) & 7; return t > 4 ? 8 - t : t; };

// ---------------- 交わる場所を見つける ----------------
interface Line { cells: number[]; lv: number[] }
interface Arm { id: number; hw: number; dir: number; line: Line; inb: boolean; outb: boolean; usable: number }
interface Hw { type: number; origin: number; level: number; arms: Arm[] }
interface Junction { kind: 'x' | 't'; hws: Hw[]; arms: Arm[]; shared: boolean; branchHw: number }

function traceArm(g: Grid, origin: number, L: number, dir: number, maxK: number): { line: Line; usable: number } {
  const cells = [origin], lv = [L];
  let c = origin, l = L, usable = maxK;
  for (let k = 1; k <= maxK; k++) {
    if (!(conn(g, c, l) & bit(dir))) { usable = k - 1; break; }
    const j = stepC(g, c, dir);
    if (j < 0) { usable = k - 1; break; }
    const l2 = g.arriveLevel(l, j, dir);
    if (!isHighway(typeAt(g, j, l2))) { usable = k - 1; break; }
    cells.push(j);
    lv.push(l2);
    // 本線のほかのつながり（ランプや別の道路）があるマスより先は使わない
    if (conn(g, j, l2) & ~(bit(dir) | bit(opp(dir)))) { usable = k - 1; break; }
    c = j;
    l = l2;
  }
  return { line: { cells, lv }, usable: Math.min(usable, cells.length - 1) };
}

function makeHw(g: Grid, hwIdx: number, origin: number, L: number, dirs: number[], arms: Arm[]): Hw {
  const hw: Hw = { type: typeAt(g, origin, L), origin, level: L, arms: [] };
  for (const d of dirs) {
    const { line, usable } = traceArm(g, origin, L, d, RB);
    const fl = (c: number, l: number) => (l ? g.flow1[c] : g.flow[c]);
    const inb = line.cells.length > 1 && (fl(line.cells[1], line.lv[1]) & bit(opp(d))) !== 0;
    const outb = line.cells.length > 1 && (fl(line.cells[0], line.lv[0]) & bit(d)) !== 0;
    const a: Arm = { id: arms.length, hw: hwIdx, dir: d, line, inb, outb, usable };
    if (line.cells.length > 1) hw.type = typeAt(g, line.cells[1], line.lv[1]);
    arms.push(a);
    hw.arms.push(a);
  }
  return hw;
}

function detect(g: Grid, x: number, y: number): Junction | { reason: string; cells: number[] } {
  const n = g.n;
  const near: { c: number; L: number; r: number }[] = [];
  for (let r = 0; r <= 2; r++)
    for (let yy = y - r; yy <= y + r; yy++)
      for (let xx = x - r; xx <= x + r; xx++) {
        if (Math.max(Math.abs(xx - x), Math.abs(yy - y)) !== r || !g.inb(xx, yy)) continue;
        const c = yy * n + xx;
        for (const L of [0, 1]) if (isHighway(typeAt(g, c, L))) near.push({ c, L, r });
      }
  if (!near.length) return { reason: '都市高速どうしが交わる・合わさるマスをタップしてください', cells: [g.idx(x, y)] };
  // 同じ階層で3方向以上につながるマス（同じ階層の十字・T字）
  for (const { c, L } of near) {
    const m = conn(g, c, L);
    if (popc(m) < 3) continue;
    const pairs: number[] = [], singles: number[] = [];
    for (let d = 0; d < 8; d++) {
      if (!(m & bit(d))) continue;
      if (m & bit(opp(d))) { if (d < 4) pairs.push(d); } else singles.push(d);
    }
    const arms: Arm[] = [];
    if (pairs.length === 2 && singles.length === 0) {
      const hws = [makeHw(g, 0, c, L, [pairs[0], pairs[0] + 4], arms), makeHw(g, 1, c, L, [pairs[1], pairs[1] + 4], arms)];
      return { kind: 'x', hws, arms, shared: true, branchHw: -1 };
    }
    if (pairs.length === 1 && singles.length === 1) {
      const hws = [makeHw(g, 0, c, L, [pairs[0], pairs[0] + 4], arms), makeHw(g, 1, c, L, [singles[0]], arms)];
      return { kind: 't', hws, arms, shared: true, branchHw: 1 };
    }
    return { reason: '3本より多くの道が集まる場所や、曲がり角にはジャンクションを作れません', cells: [c] };
  }
  // 別の階層で交わる2本（同じマスで重なる、または斜めどうしがマスの角で交わる）
  const lineDir = (c: number, L: number) => {
    const m = conn(g, c, L);
    for (let d = 0; d < 4; d++) if (m & bit(d) && m & bit(d + 4)) return d;
    return -1;
  };
  let best: { a: { c: number; L: number; d: number }; b: { c: number; L: number; d: number }; s: number } | null = null;
  const lines = near.map((q) => ({ ...q, d: lineDir(q.c, q.L) })).filter((q) => q.d >= 0);
  for (const a of lines)
    for (const b of lines) {
      if (a.L !== 0 || b.L !== 1 || (a.d & 3) === (b.d & 3)) continue;
      // 中心線どうしの交点
      const ax = (a.c % n) + 0.5, ay = ((a.c / n) | 0) + 0.5, bx = (b.c % n) + 0.5, by = ((b.c / n) | 0) + 0.5;
      const ux = DX[a.d], uy = DY[a.d], vx = DX[b.d], vy = DY[b.d];
      const det = ux * -vy - uy * -vx;
      if (Math.abs(det) < 1e-6) continue;
      const rx = bx - ax, ry = by - ay;
      const s = (rx * -vy - ry * -vx) / det, t = (ux * ry - uy * rx) / det;
      if (Math.abs(s) > 0.6 || Math.abs(t) > 0.6) continue;
      const score = Math.abs(s) + Math.abs(t) + 0.01 * (Math.abs(ax - x - 0.5) + Math.abs(ay - y - 0.5));
      if (!best || score < best.s) best = { a, b, s: score };
    }
  if (best) {
    const arms: Arm[] = [];
    const hws = [makeHw(g, 0, best.a.c, 0, [best.a.d, best.a.d + 4], arms), makeHw(g, 1, best.b.c, 1, [best.b.d, best.b.d + 4], arms)];
    return { kind: 'x', hws, arms, shared: best.a.c === best.b.c, branchHw: -1 };
  }
  return { reason: '都市高速どうしが交わる・合わさるマスをタップしてください', cells: [g.idx(x, y)] };
}

// ---------------- 本線を別の階層へ移す ----------------
// hw の、交差点の前後の本線を newL の階層へ移す（地上 → 高架：坂を含めて持ち上げる。高架 → 地上：交差点の前後だけ下ろし、その先は坂）
function moveHw(w: Grid, J: Junction, hwIdx: number, bad: Set<number>): boolean {
  const hw = J.hws[hwIdx];
  const oldL = hw.level, newL = 1 - oldL;
  const raise = newL === 1;
  const K = raise ? MOVE_F + MOVE_S : MOVE_F;
  const lift = ROADS[raise ? TWIN[hw.type] ?? hw.type : hw.type]?.lift ?? 9;
  let ok = true;
  const startK = J.kind === 't' && hwIdx === J.branchHw ? 1 : 0;
  // 移せるか
  for (const a of hw.arms) {
    if (a.usable < K + 2) { for (const c of a.line.cells) bad.add(c); ok = false; continue; }
    for (let k = startK; k <= (raise ? K : K + MOVE_S); k++) {
      const c = a.line.cells[k];
      if (k <= K && a.line.lv[k] !== oldL) { bad.add(c); ok = false; continue; }
      const x = c % w.n, y = (c / w.n) | 0;
      if (raise) {
        if (w.up[c] || w.erail[c] || w.mono[c] || w.bldg[c]) { bad.add(c); ok = false; }
      } else if (k <= K) {
        if (w.road[c] || w.bldg[c] || w.isWater(x, y) || hasSurfaceLine(w, c)) { bad.add(c); ok = false; }
      } else {
        // 下ろした先の坂：低い所の下には何もないこと
        const h = (k - K) * JCT_HSTEP;
        if (h < Math.min(JCT_CLEAR, w.upH[c] - gr(w, c)) && (w.road[c] || hasSurfaceLine(w, c))) { bad.add(c); ok = false; }
      }
    }
  }
  if (!ok) return false;
  // 移す前の流れ（arm の外向き dir の、k → k+1 と k+1 → k）
  const fl = (c: number, l: number) => (l ? w.flow1[c] : w.flow[c]);
  const moved: { arm: Arm; flows: [boolean, boolean][] }[] = [];
  for (const a of hw.arms) {
    const flows: [boolean, boolean][] = [];
    for (let k = 0; k <= K; k++) {
      const c0 = a.line.cells[k], c1 = a.line.cells[k + 1];
      flows.push([(fl(c0, a.line.lv[k]) & bit(a.dir)) !== 0, (fl(c1, a.line.lv[k + 1]) & bit(opp(a.dir))) !== 0]);
    }
    moved.push({ arm: a, flows });
  }
  // 古い階層から外す
  for (const { arm: a } of moved)
    for (let k = startK; k <= K; k++) {
      const c = a.line.cells[k];
      if (k === 0) {
        clearBits(w, c, oldL, bit(a.dir));
        if (!conn(w, c, oldL)) dropNode(w, c, oldL);
      } else dropNode(w, c, oldL);
    }
  // 新しい階層に置く
  const newType = TWIN[hw.type] ?? hw.type;
  for (const { arm: a, flows } of moved) {
    for (let k = startK; k <= K; k++) {
      const c = a.line.cells[k];
      if (newL) {
        w.up[c] = newType;
        w.upH[c] = gr(w, c) + Math.min(lift, (K + 1 - k) * JCT_HSTEP);
      } else w.road[c] = newType;
      w.zone[c] = 0; w.zden[c] = 0; w.tree[c] = 0;
      a.line.lv[k] = newL;
    }
    for (let k = startK; k <= K; k++) {
      const c0 = a.line.cells[k], c1 = a.line.cells[k + 1];
      const [f, b] = flows[k];
      setLink(w, c0, newL, c1, k + 1 <= K ? newL : oldL, a.dir, f, b);
    }
    if (!raise)
      for (let k = K + 1; k <= K + MOVE_S && k < a.line.cells.length; k++) {
        const c = a.line.cells[k];
        if (a.line.lv[k] === 1) w.upH[c] = Math.min(w.upH[c], gr(w, c) + (k - K) * JCT_HSTEP);
      }
  }
  hw.level = newL;
  return true;
}

// ---------------- ランプの道筋を探す ----------------
interface RNode { c: number; L: number; hs: number; ins: number[]; outs: number[]; S: number; T: number; cd: number; cdDst: number; s: number; inDir: number; outDir: number }
interface Mv { from: Arm; to: Arm; kind: 'R' | 'L' | 'CD' | 'loop' | 'outer' }
interface Ends { dRange: [number, number]; dPref: number; mRange: [number, number]; mPref: number; fresh: boolean; fork: boolean; join: boolean; shape: number; slack?: number }

type PNode = { c: number; L: number; hs: number }

class Router {
  w: Grid;
  n: number;
  N: number;
  bx0: number; by0: number; B: number;
  nodes = new Map<number, RNode>(); // ランプのノード（L * N + c）
  attached = new Set<number>(); // ランプが分かれる・合わさる本線のマス
  ox: number; oy: number;
  dist: Float32Array; prev: Int32Array; stamp: Int32Array; gen = 0;
  hcache: Float32Array;
  constructor(w: Grid, ox: number, oy: number) {
    this.w = w;
    this.n = w.n;
    this.N = w.n * w.n;
    this.ox = ox; this.oy = oy;
    this.B = 2 * RB + 1;
    this.bx0 = Math.round(ox) - RB;
    this.by0 = Math.round(oy) - RB;
    const S = this.B * this.B * 16 * NH;
    this.dist = new Float32Array(S);
    this.prev = new Int32Array(S);
    this.stamp = new Int32Array(S);
    this.hcache = new Float32Array(this.B * this.B);
  }
  local(c: number) {
    const x = (c % this.n) - this.bx0, y = ((c / this.n) | 0) - this.by0;
    return x < 0 || y < 0 || x >= this.B || y >= this.B ? -1 : y * this.B + x;
  }
  global(lc: number) { return (this.by0 + ((lc / this.B) | 0)) * this.n + this.bx0 + (lc % this.B); }
  // マス c に、高さの段 hs（0 = 地上）でランプを置けるか
  okState(c: number, hs: number) {
    const w = this.w, x = c % this.n, y = (c / this.n) | 0;
    if (w.bldg[c]) return false;
    if (hs === 0) {
      if (w.road[c] || hasSurfaceLine(w, c) || w.isWater(x, y)) return false;
      if (w.up[c] && w.upH[c] - gr(w, c) < JCT_CLEAR) return false;
      return true;
    }
    if (w.up[c] || w.erail[c] || w.mono[c]) return false;
    if (hs * JCT_HSTEP < JCT_CLEAR && (w.road[c] || hasSurfaceLine(w, c) || w.isWater(x, y))) return false;
    return true;
  }
  // c から向き d で隣のマスへ、階層 la → lb で進めるか（階層の決まりと、斜めのすり抜け）
  okStep(c: number, la: number, d: number, lb: number) {
    const w = this.w, j = stepC(w, c, d);
    if (j < 0) return false;
    if (lb === 1 && w.conn[j] & bit(opp(d))) return false;
    if (lb === 0 && la === 1 && w.conn1[j] & bit(opp(d))) return false;
    if (isDiag(d)) {
      if (crossesDiag(w, c, d, lb) || (lb !== la && crossesDiag(w, c, d, la))) return false;
      const a = stepC(w, c, d - 1), b = stepC(w, c, d + 1);
      // 斜めに進むときの両隣（縦横）が、同じ階層でどちらもふさがっていればすり抜けない
      const occ = (q: number) => q >= 0 && (lb ? w.up[q] !== 0 : w.road[q] !== 0);
      if (occ(a) && occ(b)) return false;
    }
    return true;
  }
  hmOf(c: number, L: number) {
    if (!L) return 0;
    return Math.max(1, Math.min(HMAX, Math.round((this.w.upH[c] - gr(this.w, c)) / JCT_HSTEP)));
  }
  // 本線の arm の k 番目のマスの、ランプ側の横のマスと高さ
  // 分岐：本線のマス k から右前へ。合流：右後ろのマスから本線のマス k へ
  divergeAt(A: Arm, k: number): PNode[] | null {
    const w = this.w, line = A.line;
    if (k - LDEC < 2 || k > A.usable - 1) return null;
    const m = line.cells[k], Lm = line.lv[k], f = opp(A.dir);
    if (this.attached.has(m) || conn(w, m, Lm) & ~(bit(A.dir) | bit(opp(A.dir)))) return null;
    const dd = (f + 1) & 7;
    const out: PNode[] = [{ c: m, L: Lm, hs: this.hmOf(m, Lm) }];
    let c = stepC(w, m, dd), d = dd;
    for (let j = 0; j < LDEC; j++) {
      if (c < 0) return null;
      const bm = line.cells[k - 1 - j], hm = this.hmOf(bm, line.lv[k - 1 - j]);
      const L = hm ? 1 : 0;
      const p = out[out.length - 1];
      if (!this.okState(c, hm) || !this.okStep(p.c, p.L, d, L)) return null;
      out.push({ c, L, hs: hm });
      d = f;
      c = stepC(w, c, f);
    }
    return out;
  }
  mergeAt(B: Arm, k: number): PNode[] | null {
    const w = this.w, line = B.line;
    if (k - LACC < 2 || k > B.usable - 1) return null;
    const m = line.cells[k], Lm = line.lv[k], f = B.dir;
    if (this.attached.has(m) || conn(w, m, Lm) & ~(bit(B.dir) | bit(opp(B.dir)))) return null;
    const dm = (f + 7) & 7;
    const out: PNode[] = [];
    let c = stepC(w, m, opp(dm));
    for (let j = 0; j < LACC; j++) {
      if (c < 0) return null;
      const bm = line.cells[k - 1 - j], hm = this.hmOf(bm, line.lv[k - 1 - j]);
      if (!this.okState(c, hm)) return null;
      out.unshift({ c, L: hm ? 1 : 0, hs: hm });
      c = stepC(w, c, opp(f));
    }
    out.push({ c: m, L: Lm, hs: this.hmOf(m, Lm) });
    for (let j = 0; j + 1 < out.length; j++) {
      const d = j + 1 === out.length - 1 ? dm : f;
      if (!this.okStep(out[j].c, out[j].L, d, out[j + 1].L)) return null;
    }
    return out;
  }
  key(c: number, L: number) { return L * this.N + c; }

  // 1本のランプを探して置く。成功すれば true
  route(mv: Mv, E: Ends, srcId: number, dstId: number, cdOpts?: { forkOk: (p: RNode) => boolean; joinOk: (q: RNode) => boolean; markCd?: boolean }): boolean {
    const w = this.w, B = this.B, gen = ++this.gen;
    const { dist, prev, stamp } = this;
    // 進んでよい向き：分かれる向きから合わさる向きまで、曲がる側に回る弧（とその両側に slack）。ループは作らない（クローバー型のループは別）
    let headMask = 0xff;
    if (mv.kind !== 'loop') {
      const f = opp(mv.from.dir), t = mv.to.dir, sl = E.slack ?? 1;
      const sg = mv.kind === 'CD' ? 0 : turnKindOf(f, t) === 1 ? 1 : -1;
      headMask = 0;
      if (sg === 0) for (let k = -sl; k <= sl; k++) headMask |= bit(f + 8 + k);
      else {
        const span = ((t - f) * sg + 8) & 7;
        for (let k = -sl; k <= span + sl; k++) headMask |= bit(f + 16 + k * sg);
      }
    }
    // 状態：マス・向き・直前に曲がったか（続けては曲がらない = カーブの半径が小さくなりすぎない）・高さの段
    const SID = (lc: number, d: number, hs: number, t = 0) => ((lc * 8 + d) * 2 + t) * NH + hs;
    // 出発点：本線から新しく分かれる、または同じ本線から来るランプから分かれる
    interface Start { lc: number; d: number; hs: number; g0: number; prefix: PNode[]; fork: boolean }
    const starts: Start[] = [];
    if (E.fresh && mv.from.inb)
      for (let k = E.dRange[0]; k <= E.dRange[1]; k++) {
        const P = this.divergeAt(mv.from, k);
        if (!P) continue;
        const last = P[P.length - 1], lc = this.local(last.c);
        if (lc < 0) continue;
        starts.push({ lc, d: opp(mv.from.dir), hs: last.hs, g0: 0.3 * Math.abs(k - E.dPref), prefix: P, fork: false });
      }
    if (E.fork || cdOpts)
      for (const p of this.nodes.values()) {
        const ok = cdOpts ? p.cd >= 0 && cdOpts.forkOk(p) : p.cd < 0 && p.S === bit(srcId) && !(p.T & bit(dstId));
        if (!ok || p.outs.length !== 1 || p.ins.length !== 1) continue;
        for (const nd of [(p.outDir + 7) & 7, (p.outDir + 1) & 7]) {
          if (turnAbs(p.inDir, nd) > 1) continue;
          const j = stepC(w, p.c, nd), lc = j >= 0 ? this.local(j) : -1;
          if (lc < 0) continue;
          if (!(headMask & bit(nd))) continue;
          for (let hs = Math.max(0, p.hs - 1); hs <= Math.min(HMAX, p.hs + 1); hs++) {
            const L = hs ? 1 : 0;
            if (!this.okState(j, hs) || !this.okStep(p.c, p.L, nd, L)) continue;
            starts.push({ lc, d: nd, hs, g0: 1.5, prefix: [{ c: p.c, L: p.L, hs: p.hs }, { c: j, L, hs }], fork: true });
          }
        }
      }
    if (!starts.length) return false;
    // 行き先：本線へ新しく合流する（加速車線の始まりのマス）、または同じ本線へ行くランプに合わさる
    interface Goal { hsMin: number; hsMax: number; f: number; suffix: PNode[]; g1: number }
    const goals = new Map<number, Goal[]>(); // 局所のマス → 行き先
    const goalCells: number[] = [];
    if (E.fresh && mv.to.outb)
      for (let k = E.mRange[0]; k <= E.mRange[1]; k++) {
        const P = this.mergeAt(mv.to, k);
        if (!P) continue;
        const first = P[0], lc = this.local(first.c);
        if (lc < 0) continue;
        const L = first.L;
        const gl: Goal = { hsMin: L ? Math.max(1, first.hs - 1) : 0, hsMax: L ? first.hs + 1 : 1, f: mv.to.dir, suffix: P, g1: 0.3 * Math.abs(k - E.mPref) };
        (goals.get(lc) ?? goals.set(lc, []).get(lc)!).push(gl);
        goalCells.push(first.c);
      }
    const joins = new Map<number, RNode>(); // 合わさる先のノード（マス → ノード）
    if (E.join || cdOpts)
      for (const q of this.nodes.values()) {
        const ok = cdOpts ? q.cd >= 0 && cdOpts.joinOk(q) : q.cd < 0 && q.T === bit(dstId) && !(q.S & bit(srcId));
        if (!ok || q.outs.length !== 1 || q.ins.length !== 1) continue;
        joins.set(q.c, q);
        goalCells.push(q.c);
      }
    if (!goalCells.length) return false;
    // 推定の残りの長さ（いちばん近い行き先までのまっすぐな長さ）
    const hc = this.hcache.fill(-1);
    const gx = goalCells.map((c) => c % this.n), gy = goalCells.map((c) => (c / this.n) | 0);
    const H = (lc: number) => {
      if (hc[lc] >= 0) return hc[lc];
      const x = this.bx0 + (lc % B), y = this.by0 + ((lc / B) | 0);
      let m = Infinity;
      for (let q = 0; q < gx.length; q++) m = Math.min(m, Math.hypot(gx[q] - x, gy[q] - y));
      return (hc[lc] = Math.max(0, m - 1));
    };
    const heap = new Heap();
    for (let q = 0; q < starts.length; q++) {
      const s = starts[q], id = SID(s.lc, s.d, s.hs, s.fork ? 1 : 0);
      if (stamp[id] === gen && dist[id] <= s.g0) continue;
      stamp[id] = gen;
      dist[id] = s.g0;
      prev[id] = -1 - q;
      heap.push(s.g0 + H(s.lc), id);
    }
    let best = Infinity, bestId = -1, bestGoal: Goal | null = null, bestJoin: { q: RNode; nd: number } | null = null;
    const shapeR = 6.5;
    let iter = 0;
    while (heap.size) {
      const fk = heap.topKey();
      if (fk >= best) break;
      const id = heap.pop();
      if (++iter > 400000) break;
      const g0 = dist[id];
      const hs = id % NH, tr = Math.floor(id / NH) & 1, d = Math.floor(id / NH / 2) & 7, lc = Math.floor(id / NH / 16);
      if (g0 + H(lc) < fk - 1e-4) continue;
      const c = this.global(lc), L = hs ? 1 : 0;
      // 本線への合流の始まりのマス
      const gl = goals.get(lc);
      if (gl)
        for (const G of gl) {
          if (hs < G.hsMin || hs > G.hsMax || turnAbs(d, G.f) > 1 || (tr && d !== G.f)) continue;
          if ((hs ? 1 : 0) !== G.suffix[0].L) continue;
          const tot = g0 + G.g1 + LACC;
          if (tot < best) { best = tot; bestId = id; bestGoal = G; bestJoin = null; }
        }
      for (const nd of tr ? [d] : [(d + 7) & 7, d, (d + 1) & 7]) {
        if (!(headMask & bit(nd))) continue;
        const j = stepC(w, c, nd);
        if (j < 0) continue;
        const lj = this.local(j);
        if (lj < 0) continue;
        const len = isDiag(nd) ? 1.414 : 1;
        // ランプに合わさる
        const q = joins.get(j);
        if (q && nd !== q.inDir && turnAbs(nd, q.outDir) <= 1 && (nd === d || nd === q.outDir) && Math.abs(q.hs - hs) <= 1 && this.okStep(c, L, nd, q.L) && !(q.L === 0 && hs > 1)) {
          const tot = g0 + len + 1;
          if (tot < best) { best = tot; bestId = id; bestJoin = { q, nd }; bestGoal = null; }
        }
        for (let h2 = Math.max(0, hs - 1); h2 <= Math.min(HMAX, hs + 1); h2++) {
          const L2 = h2 ? 1 : 0;
          if (!this.okState(j, h2) || !this.okStep(c, L, nd, L2)) continue;
          let cost = len + (nd !== d ? 0.3 : 0) + (h2 !== hs ? 0.12 : 0) + (h2 ? 0.01 : 0);
          // 交差点から遠いほど少し高くつく（ランプを本線のそばに寄せて、ジャンクションを小さくまとめる）
          {
            const x = (j % this.n) + 0.5 - this.ox, y = ((j / this.n) | 0) + 0.5 - this.oy;
            cost += 0.025 * Math.hypot(x, y) * len;
          }
          if (E.shape) {
            const x = (j % this.n) + 0.5 - this.ox, y = ((j / this.n) | 0) + 0.5 - this.oy;
            cost += E.shape * Math.abs(Math.hypot(x, y) - shapeR) * len;
          }
          const nid = SID(lj, nd, h2, nd !== d ? 1 : 0), ng = g0 + cost;
          if (stamp[nid] === gen && dist[nid] <= ng) continue;
          stamp[nid] = gen;
          dist[nid] = ng;
          prev[nid] = id;
          heap.push(ng + H(lj), nid);
        }
      }
    }
    if (bestId < 0) return false;
    // 道筋をたどる
    const mid: PNode[] = [];
    let cur = bestId, sIdx = -1;
    for (;;) {
      const hs = cur % NH, lc = Math.floor(cur / NH / 16);
      mid.push({ c: this.global(lc), L: hs ? 1 : 0, hs });
      const p = prev[cur];
      if (p < 0) { sIdx = -1 - p; break; }
      cur = p;
    }
    mid.reverse();
    const st = starts[sIdx];
    const chain: PNode[] = [...st.prefix.slice(0, -1), ...mid];
    if (bestGoal) chain.push(...bestGoal.suffix.slice(1));
    else if (bestJoin) chain.push({ c: bestJoin.q.c, L: bestJoin.q.L, hs: bestJoin.q.hs });
    // 同じマスを2回通らない（高い所でまたぐのは別）
    const seen = new Map<number, PNode>();
    for (let k = 1; k + 1 < chain.length; k++) {
      const p = chain[k], o = seen.get(p.c);
      if (o && !(Math.min(o.hs, p.hs) === 0 && Math.max(o.hs, p.hs) * JCT_HSTEP >= JCT_CLEAR)) return false;
      seen.set(p.c, p);
    }
    this.commit(chain, mv, srcId, dstId, st.fork, bestJoin !== null, cdOpts?.markCd ?? false);
    return true;
  }

  commit(chain: PNode[], mv: Mv, srcId: number, dstId: number, forked: boolean, joined: boolean, markCd: boolean) {
    const w = this.w;
    const last = chain.length - 1;
    const dirs: number[] = [];
    for (let k = 0; k < last; k++) {
      const a = chain[k].c, b = chain[k + 1].c, n = this.n;
      dirs.push([0, 1, 2, 3, 4, 5, 6, 7].find((d) => DX[d] === (b % n) - (a % n) && DY[d] === ((b / n) | 0) - ((a / n) | 0))!);
    }
    if (!forked) this.attached.add(chain[0].c);
    if (!joined) this.attached.add(chain[last].c);
    const fl = mv.from.dir; // CD の進み具合の向き：分かれる本線の進む向き = opp(from.dir)
    const ux = DX[opp(fl)], uy = DY[opp(fl)], ul = Math.hypot(ux, uy);
    for (let k = 1; k < last; k++) {
      const p = chain[k];
      if (p.L) {
        w.up[p.c] = RoadType.Ramp;
        w.upH[p.c] = gr(w, p.c) + p.hs * JCT_HSTEP;
        w.jct[p.c] |= 2;
      } else {
        w.road[p.c] = RoadType.Ramp;
        w.jct[p.c] |= 1;
      }
      w.zone[p.c] = 0; w.zden[p.c] = 0; w.tree[p.c] = 0;
      const x = (p.c % this.n) + 0.5 - this.ox, y = ((p.c / this.n) | 0) + 0.5 - this.oy;
      this.nodes.set(this.key(p.c, p.L), {
        c: p.c, L: p.L, hs: p.hs, ins: [], outs: [], S: bit(srcId), T: bit(dstId), cd: markCd ? srcId : -1, cdDst: markCd ? dstId : -1,
        s: (x * ux + y * uy) / ul, inDir: dirs[k - 1], outDir: dirs[k],
      });
    }
    for (let k = 0; k < last; k++) {
      const a = chain[k], b = chain[k + 1];
      setLink(w, a.c, a.L, b.c, b.L, dirs[k], true, false);
      const na = this.nodes.get(this.key(a.c, a.L)), nb = this.nodes.get(this.key(b.c, b.L));
      if (na) na.outs.push(this.key(b.c, b.L));
      if (nb) nb.ins.push(this.key(a.c, a.L));
    }
    // 分かれたランプの上流は、この行き先へも行く。合わさったランプの下流は、この出発点からも来る
    if (forked) {
      const st = [this.key(chain[0].c, chain[0].L)];
      while (st.length) { const q = this.nodes.get(st.pop()!); if (!q || q.T & bit(dstId)) continue; q.T |= bit(dstId); st.push(...q.ins); }
    }
    if (joined) {
      const st = [this.key(chain[last].c, chain[last].L)];
      while (st.length) { const q = this.nodes.get(st.pop()!); if (!q || q.S & bit(srcId)) continue; q.S |= bit(srcId); st.push(...q.outs); }
    }
  }
}

// 二分ヒープ
class Heap {
  k: number[] = [];
  v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const K = this.k, V = this.v;
    let i = K.length;
    K.push(key); V.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p];
      i = p;
    }
    K[i] = key; V[i] = val;
  }
  topKey() { return this.k[0]; }
  pop() {
    const K = this.k, V = this.v, top = V[0];
    const lk = K.pop()!, lv = V.pop()!;
    const n = K.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= lk) break;
        K[i] = K[c]; V[i] = V[c];
        i = c;
      }
      K[i] = lk; V[i] = lv;
    }
    return top;
  }
}

// ---------------- 走れるかの確かめ ----------------
// 経路探索と同じ決まり（Uターンなし、都市高速のランプへの出入りは中央線をまたがない）で、from（ノード）から to へ行けるか
export function jctCanDrive(g: Grid, from: number, inDir: number, to: number, limit = 20000): boolean {
  const isRamp = (v: number) => g.nodeType(v) === RoadType.Ramp;
  const seen = new Set<number>();
  const q: [number, number, number][] = [[from, inDir, 0]];
  seen.add((from * 8 + (inDir & 7)) * 2);
  while (q.length && seen.size < limit) {
    const [u, din, pr] = q.shift()!;
    if (u === to) return true;
    const urbanU = isUrbanHighway(g.nodeType(u));
    g.forEachOut(u, (v, d) => {
      if (din >= 0 && ((d - din + 8) & 7) === 4) return;
      if (urbanU && (isRamp(v) || pr) && !urbanTurnOk(din, d)) return;
      const k = (v * 8 + d) * 2 + (isRamp(u) ? 1 : 0);
      if (seen.has(k)) return;
      seen.add(k);
      q.push([v, d, isRamp(u) ? 1 : 0]);
    });
  }
  return false;
}

// ---------------- 計画 ----------------
interface Variant { move: number } // 階層を移す本線（-1 = 移さない）

function endsFor(form: JctForm, kind: Mv['kind'], attempt = 0): Ends {
  // うまく通せないときは、分かれる・合わさる範囲を広げ、ランプどうしの分岐・合流も使う
  const wide = attempt >= 3 ? 4 : 0;
  const E = (d: [number, number], dp: number, m: [number, number], mp: number, fresh = true, fork = true, join = true, shape = 0): Ends =>
    ({ dRange: [d[0], d[1] + wide], dPref: dp, mRange: [m[0], m[1] + wide], mPref: mp, fresh, fork: fork || wide > 0, join: join || wide > 0, shape: wide ? shape / 2 : shape, slack: wide ? 2 : 1 });
  if (form === 'tee') return kind === 'R' ? E([3, 9], 3, [4, 10], 5) : E([3, 11], 4, [4, 12], 5);
  if (form === 'semi') return kind === 'R' ? E([3, 9], 4, [4, 10], 5) : E([4, 12], 5, [5, 12], 6);
  if (form === 'turbine') return kind === 'R' ? E([3, 12], 4, [4, 12], 5, true, false, false) : E([4, 12], 6, [5, 12], 7, true, false, false, 0.8);
  // クローバー型：集散路は本線の遠くから分かれて、遠くで合流する
  if (kind === 'CD') return E([9, 13], 10, [10, 14], 11, true, false, false);
  return E([0, 0], 0, [0, 0], 0, false, false, false);
}

export function planJct(g: Grid, form: JctForm, x: number, y: number): JctPlan {
  const fail = (reason: string, cells: number[] = [], bad?: Set<number>): JctPlan => ({ ok: false, reason, cost: 0, cells, bad: bad ?? new Set(cells), out: null });
  if (!g.inb(x, y)) return fail('マップの外です');
  const J0 = detect(g, x, y);
  if ('reason' in J0) return fail(J0.reason, J0.cells);
  const allArms = J0.hws.flatMap((h) => h.arms);
  for (const h of J0.hws)
    if (!isUrbanAny(h.type)) return fail('ジャンクションは都市高速どうしに作れます（2マス幅の高速道路はクローバー型インターチェンジを使ってください）', allArms.flatMap((a) => a.line.cells.slice(0, 3)));
  if (form === 'tee' && J0.kind === 'x') return fail('ここは十字に交わっています。十字のジャンクションを選んでください', [J0.hws[0].origin]);
  if (form !== 'tee' && J0.kind === 't') return fail('ここはT字・Y字に合わさっています。「T字・Y字」を選んでください', [J0.hws[0].origin]);
  // 本線がまっすぐ続いているか
  const shortCells = new Set<number>();
  for (const a of allArms) if (a.usable < ARM_MIN) for (const c of a.line.cells.slice(1)) shortCells.add(c);
  if (shortCells.size) {
    // 足りない腕の先のマスも赤く（どこまでまっすぐにすればよいかを見せる）
    for (const a of allArms) if (a.usable < ARM_MIN) for (let k = a.line.cells.length; k <= ARM_MIN; k++) { const c = stepC(g, a.line.cells[0], a.dir, k); if (c >= 0) shortCells.add(c); }
    return fail(`交差点の前後 ${ARM_MIN} マスは、都市高速をまっすぐにして、ランプや交差点を置かないでください`, [...shortCells]);
  }
  // 試す順：同じ階層で交わる十字は、どちらかを移す。T字は、移さない → 合わさる側 → 本線
  const variants: Variant[] = J0.kind === 'x' ? (J0.shared && J0.hws[0].level === J0.hws[1].level ? [{ move: 1 }, { move: 0 }] : [{ move: -1 }]) : [{ move: -1 }, { move: 1 }, { move: 0 }];
  let lastBad = new Set<number>(), lastReason = '';
  for (const V of variants) {
    const w = g.clone();
    const J = detect(w, x, y) as Junction;
    const bad = new Set<number>();
    // T字：合わさる側の本線のつながりを外す（ランプでつなぎ直す）
    if (J.kind === 't') {
      const br = J.hws[J.branchHw].arms[0], o = br.line.cells[0], L0 = br.line.lv[0], c1 = br.line.cells[1], L1 = br.line.lv[1];
      clearBits(w, o, L0, bit(br.dir));
      clearBits(w, c1, L1, bit(opp(br.dir)));
    }
    if (V.move >= 0 && !moveHw(w, J, V.move, bad)) {
      lastBad = bad;
      lastReason = '本線を別の高さへ移す場所（赤いマス）に、道路や建物、水があります';
      continue;
    }
    const plan = routeAll(g, w, J, form);
    if (!plan.ok) {
      if (!lastReason || plan.bad.size) { lastBad = plan.bad; lastReason = plan.reason; }
      continue;
    }
    return plan;
  }
  return fail(lastReason || 'ランプを通す広さがありません', [...lastBad], lastBad);
}

function routeAll(g0: Grid, w0: Grid, J: Junction, form: JctForm): JctPlan {
  const bad = new Set<number>();
  const fail = (reason: string): JctPlan => ({ ok: false, reason, cost: 0, cells: [...bad], bad, out: null });
  const arms = J.arms;
  // 乗り換えの一覧
  const mvs: Mv[] = [];
  for (const A of arms)
    for (const B of arms) {
      if (A.hw === B.hw || !A.inb || !B.outb) continue;
      const tk = turnKindOf(opp(A.dir), B.dir);
      if (tk === 0 || tk === 3) continue;
      mvs.push({ from: A, to: B, kind: form === 'clover' ? (tk === 1 ? 'outer' : 'loop') : tk === 1 ? 'R' : 'L' });
    }
  if (!mvs.length) return fail('つなぐ向きがありません（一方通行の向きを確かめてください）');
  const o0 = J.hws[0].origin, o1 = J.hws[1].origin, n = w0.n;
  const ox = ((o0 % n) + (o1 % n)) / 2 + 0.5, oy = (((o0 / n) | 0) + ((o1 / n) | 0)) / 2 + 0.5;
  // 順番：クローバー型は集散路 → ループ → 外側。タービン型は左折から。ほかは右折から
  const order = (m: Mv) => (form === 'turbine' ? (m.kind === 'L' ? 0 : 1) : m.kind === 'loop' ? 0 : m.kind === 'outer' ? 1 : m.kind === 'R' ? 0 : 1);
  let list = mvs.slice().sort((a, b) => order(a) - order(b));
  let failed: Mv | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = w0.clone();
    const R = new Router(w, ox, oy);
    failed = null;
    // クローバー型：先に集散路（同じ本線の、手前の腕 → 先の腕）
    if (form === 'clover') {
      for (const A of arms) {
        if (!A.inb) continue;
        const Bo = arms.find((b) => b.hw === A.hw && b !== A && b.outb);
        if (!Bo) continue;
        const ok = R.route({ from: A, to: Bo, kind: 'CD' }, endsFor(form, 'CD'), A.id, Bo.id, { forkOk: () => false, joinOk: () => false, markCd: true });
        if (!ok) { failed = { from: A, to: Bo, kind: 'CD' }; break; }
      }
      if (failed) { markFail(R, failed, bad); return fail('集散路を通す広さがありません（赤いマスのまわりを空けてください）'); }
    }
    for (const mv of list) {
      let ok: boolean;
      if (form === 'clover') {
        const fromCd = mv.from.id, toCd = mv.to.id;
        if (mv.kind === 'loop')
          ok = R.route(mv, endsFor(form, 'loop'), mv.from.id, mv.to.id, {
            forkOk: (p) => p.cd === fromCd && p.s > 1.2,
            joinOk: (q) => q.cdDst === toCd && q.s < -1.2,
          });
        else {
          // 外側のランプは、ループが合わさるより手前の集散路から分かれ、ループが分かれるより先の集散路に合わさる（織り込みは集散路のループの間だけ）
          const lj = Math.min(Infinity, ...[...R.nodes.values()].filter((q) => q.cd >= 0 && q.cd === fromCd && q.ins.length > 1).map((q) => q.s));
          const lf = Math.max(-Infinity, ...[...R.nodes.values()].filter((q) => q.cd >= 0 && q.cdDst === toCd && q.outs.length > 1).map((q) => q.s));
          ok = R.route(mv, endsFor(form, 'outer'), mv.from.id, mv.to.id, {
            forkOk: (p) => p.cd === fromCd && p.s < Math.min(-1.2, lj - 1),
            joinOk: (q) => q.cdDst === toCd && q.s > Math.max(1.2, lf + 1),
          });
        }
      } else ok = R.route(mv, endsFor(form, mv.kind, attempt), mv.from.id, mv.to.id);
      if (!ok) { failed = mv; break; }
    }
    if (!failed) {
      // T字：合わさる側の本線の、使わなくなった先の部分を外す
      if (J.kind === 't') pruneBranch(w, J.hws[J.branchHw].arms[0], R);
      // すべての乗り換えと本線の直進が走れるか
      const chk = verify(w, J, mvs);
      if (chk) { markFail(R, chk, bad); return fail('ランプがうまくつながりませんでした（場所を変えてみてください）'); }
      const cells: number[] = [];
      let cost = JCT_BASE_COST;
      for (let c = 0; c < w.n * w.n; c++) {
        const changed = w.road[c] !== g0.road[c] || w.up[c] !== g0.up[c];
        if (!changed) continue;
        cells.push(c);
        cost += (w.up[c] === RoadType.Ramp ? 1.5 : 1) * JCT_CELL_COST;
      }
      return { ok: true, reason: '', cost: Math.round(cost), cells, bad, out: w };
    }
    // 失敗したランプを先に探して、もう一度
    list = [failed, ...list.filter((m) => m !== failed)];
  }
  if (failed) {
    const R = new Router(w0, ox, oy);
    markFail(R, failed, bad);
  }
  return fail(failed && (failed.kind === 'L' || failed.kind === 'loop') ? '左折のランプを通す広さがありません（赤いマスのまわりを空けてください）' : 'ランプを通す広さがありません（赤いマスのまわりを空けてください）');
}

function turnKindOf(din: number, dout: number) {
  const diff = (dout - din + 8) & 7;
  if (diff === 0) return 0;
  if (diff === 4) return 3;
  return diff < 4 ? 1 : 2;
}

// 失敗したランプの、分かれる・合わさるあたりのマスを赤く
function markFail(R: Router, mv: Mv, bad: Set<number>) {
  for (const [A, ks] of [[mv.from, [3, 6, 9]], [mv.to, [3, 6, 9]]] as const)
    for (const k of ks) {
      const c = A.line.cells[k];
      if (c === undefined) continue;
      for (const s of [(A.dir + 2) & 7, (A.dir + 6) & 7]) for (const r of [1, 2]) { const j = stepC(R.w, c, s, r); if (j >= 0 && !isHighway(R.w.road[j]) && !isHighway(R.w.up[j])) bad.add(j); }
    }
}

// T字：合わさる側の本線のうち、ランプへ分かれた先・ランプから合わさる手前の、もう走らない部分を外す
function pruneBranch(w: Grid, A: Arm, R: Router) {
  const line = A.line;
  let kd = Infinity, km = Infinity;
  for (let k = 1; k < line.cells.length; k++) {
    if (!R.attached.has(line.cells[k])) continue;
    const c = line.cells[k], L = line.lv[k];
    const m = conn(w, c, L) & ~(bit(A.dir) | bit(opp(A.dir)));
    const fl = L ? w.flow1[c] : w.flow[c];
    if (fl & m) kd = Math.min(kd, k); // 外へ出ていく = ランプへ分かれる
    else km = Math.min(km, k);
  }
  for (let k = 1; k + 1 < line.cells.length && (k < kd || k < km); k++) {
    const a = line.cells[k], La = line.lv[k], b = line.cells[k + 1], Lb = line.lv[k + 1];
    // 内向き（b → a）は分岐（kd）より内側で不要、外向き（a → b）は合流（km）より内側で不要
    const dropIn = k < kd, dropOut = k < km;
    if (dropIn) { if (Lb) w.flow1[b] &= ~bit(opp(A.dir)); else w.flow[b] &= ~bit(opp(A.dir)); }
    if (dropOut) { if (La) w.flow1[a] &= ~bit(A.dir); else w.flow[a] &= ~bit(A.dir); }
    const fa = (La ? w.flow1[a] : w.flow[a]) & bit(A.dir), fb = (Lb ? w.flow1[b] : w.flow[b]) & bit(opp(A.dir));
    if (!fa && !fb) { clearBits(w, a, La, bit(A.dir)); clearBits(w, b, Lb, bit(opp(A.dir))); }
  }
  for (let k = 1; k < line.cells.length && (k < kd || k < km); k++) {
    const c = line.cells[k], L = line.lv[k];
    if (!conn(w, c, L)) dropNode(w, c, L);
  }
}

// すべての乗り換えと、本線の直進が走れるか（走れないものを返す）
function verify(w: Grid, J: Junction, mvs: Mv[]): Mv | null {
  const N = w.n * w.n;
  const far = (A: Arm) => { const k = Math.min(A.usable, A.line.cells.length - 1); return A.line.lv[k] * N + A.line.cells[k]; };
  for (const mv of mvs) if (!jctCanDrive(w, far(mv.from), opp(mv.from.dir), far(mv.to))) return mv;
  for (const h of J.hws) {
    if (h.arms.length !== 2) continue;
    for (const [A, B] of [[h.arms[0], h.arms[1]], [h.arms[1], h.arms[0]]]) {
      if (!A.inb || !B.outb) continue;
      if (!jctCanDrive(w, far(A), opp(A.dir), far(B))) return { from: A, to: B, kind: 'CD' };
    }
  }
  return null;
}

export function applyJct(g: Grid, p: JctPlan) {
  const w = p.out;
  if (!p.ok || !w) return;
  for (const k of ['road', 'conn', 'flow', 'up', 'conn1', 'flow1', 'zone', 'zden', 'tree', 'jct'] as const) g[k].set(w[k]);
  g.upH.set(w.upH);
}
