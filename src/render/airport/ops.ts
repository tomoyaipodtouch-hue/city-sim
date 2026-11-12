// 空港の運航：飛行機の動き（進入 → フレア → 接地 → 減速 → 誘導路 → 駐機スポット → 折り返し → プッシュバック → 誘導路 →
// 停止位置 → 滑走路へ → 離陸滑走 → 上昇 → マップの外へ）、便の出し方（人口・利用者、深夜は少ない）、風向きによる滑走路の向きの入れ替え、
// 駐機中の地上の車両（バス・給油車・荷物の車・トーイングカー）と歩いて乗り降りする人。
// three.js には触らない。位置はすべて空港の敷地の座標（a, c, 高さ）。毎フレームの計算で新しい配列やオブジェクトを作らない。
import type { AirportLayout, StandDef } from '../../sim/airport';
import { AC, ALL_LIVERIES, AcType, CARGO_LIVERY } from './aircraft';
import type { GseType } from './gse';

// ---- 道すじ（折れ線の角を円弧で丸めたもの） ----
export interface Path { a: Float32Array; c: Float32Array; s: Float32Array; len: number }
export function makePath(pts: [number, number][], radius = 0): Path {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    let ux = ax - bx, uy = ay - by, vx = cx - bx, vy = cy - by;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (radius <= 0 || lu < 1e-6 || lv < 1e-6) { out.push(pts[i]); continue; }
    ux /= lu; uy /= lu; vx /= lv; vy /= lv;
    const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy));
    const ang = Math.acos(cos); // 角の内角
    if (ang > Math.PI - 1e-3) { out.push(pts[i]); continue; }
    const t = Math.min(radius / Math.tan(ang / 2), lu * 0.5, lv * 0.5);
    const r = t * Math.tan(ang / 2);
    const p0x = bx + ux * t, p0y = by + uy * t, p1x = bx + vx * t, p1y = by + vy * t;
    // 円弧の中心
    let bxx = ux + vx, byy = uy + vy;
    const lb = Math.hypot(bxx, byy);
    bxx /= lb; byy /= lb;
    const dc = r / Math.sin(ang / 2);
    const ox = bx + bxx * dc, oy = by + byy * dc;
    const a0 = Math.atan2(p0y - oy, p0x - ox);
    let a1 = Math.atan2(p1y - oy, p1x - ox);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    a1 = a0 + da;
    const k = Math.max(3, Math.ceil(Math.abs(da) / 0.12));
    for (let j = 0; j <= k; j++) {
      const a = a0 + (da * j) / k;
      out.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
    }
  }
  out.push(pts[pts.length - 1]);
  const n = out.length;
  const A = new Float32Array(n), Cc = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    A[i] = out[i][0]; Cc[i] = out[i][1];
    if (i) S[i] = S[i - 1] + Math.hypot(A[i] - A[i - 1], Cc[i] - Cc[i - 1]);
  }
  return { a: A, c: Cc, s: S, len: S[n - 1] };
}
// 道すじの上の位置と向き（単位ベクトル）。out = [a, c, ta, tc]
export function samplePath(p: Path, s: number, out: Float32Array) {
  const n = p.s.length;
  if (s <= 0) { out[0] = p.a[0]; out[1] = p.c[0]; seg(p, 0, out); return; }
  if (s >= p.len) { out[0] = p.a[n - 1]; out[1] = p.c[n - 1]; seg(p, n - 2, out); return; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.s[m] <= s) lo = m; else hi = m; }
  const t = (s - p.s[lo]) / Math.max(1e-6, p.s[hi] - p.s[lo]);
  out[0] = p.a[lo] + (p.a[hi] - p.a[lo]) * t;
  out[1] = p.c[lo] + (p.c[hi] - p.c[lo]) * t;
  seg(p, lo, out);
}
function seg(p: Path, i: number, out: Float32Array) {
  const da = p.a[i + 1] - p.a[i], dc = p.c[i + 1] - p.c[i], l = Math.hypot(da, dc) || 1;
  out[2] = da / l; out[3] = dc / l;
}

// ---- 速さの変化（台形：v0 から加速して vmax、減速して v1） ----
export interface Move { path: Path; v0: number; vm: number; v1: number; a1: number; dec: number; t1: number; t2: number; T: number; d1: number; d2: number; vp: number }
// 速さの変化：v0 から vmax まで（上げるときは acc、下げるときは dec）、一定の速さ、最後に v1 まで dec で下げる
export function makeMove(path: Path, v0: number, vmax: number, v1: number, acc: number, dec: number): Move {
  const L = path.len;
  let vp = vmax;
  const d1of = (v: number) => (v >= v0 ? (v * v - v0 * v0) / (2 * acc) : (v0 * v0 - v * v) / (2 * dec));
  const d3of = (v: number) => Math.max(0, (v * v - v1 * v1) / (2 * dec));
  if (d1of(vp) + d3of(vp) > L) {
    // 道が短い：いちばん速いところを下げる（v0 より下がるときは、はじめから下げつづける）
    const up = Math.sqrt(Math.max(0, (2 * acc * dec * L + dec * v0 * v0 + acc * v1 * v1) / (acc + dec)));
    vp = up >= v0 ? up : Math.max(v1, Math.sqrt(Math.max(0, (v0 * v0 + v1 * v1) / 2)));
    vp = Math.max(vp, v1, 0.5);
  }
  const d1 = d1of(vp), d3 = d3of(vp);
  const d2 = Math.max(0, L - d1 - d3);
  const a1 = vp >= v0 ? acc : -dec;
  const t1 = Math.abs(vp - v0) / Math.abs(a1), t2 = t1 + d2 / Math.max(0.1, vp), T = t2 + (vp > v1 ? (vp - v1) / dec : 0);
  return { path, v0, vm: vmax, v1, a1, dec, t1, t2, T, d1, d2, vp };
}
// 時刻 t の道のり
export function moveS(m: Move, t: number): number {
  if (t <= 0) return 0;
  if (t >= m.T) return m.path.len;
  if (t < m.t1) return m.v0 * t + 0.5 * m.a1 * t * t;
  if (t < m.t2) return m.d1 + m.vp * (t - m.t1);
  const u = t - m.t2;
  return Math.min(m.path.len, m.d1 + m.d2 + m.vp * u - 0.5 * m.dec * u * u);
}
export function moveV(m: Move, t: number): number {
  if (t <= 0) return m.v0;
  if (t >= m.T) return m.v1;
  if (t < m.t1) return m.v0 + m.a1 * t;
  if (t < m.t2) return m.vp;
  return Math.max(0, m.vp - m.dec * (t - m.t2));
}

// ---- 地上の車両の行き来（車庫 ⇔ 駐機スポットのそば） ----
export interface Trip { type: GseType; path: Path; t: number; drive: number; stay: number; carts: number; live: boolean; attach: number; oneWay: boolean; ac: Ac | null }

// ---- 飛行機 ----
export type Phase = 'approach' | 'rollout' | 'exit' | 'holdIn' | 'taxiIn' | 'park' | 'ready' | 'push' | 'pushed' | 'taxiOut' | 'holdOut' | 'lineup' | 'takeoff' | 'gone';
// 地上の区間（誘導路の辺・駐機スポットへの引き込み・出口・滑走路への入口）の予約。通る前に押さえ、尾が通りすぎたら放す
interface Res { id: number; path: Path | null; s: number }
export interface Ac {
  id: number;
  type: AcType;
  livery: number; // ALL_LIVERIES の番号
  cargo: boolean;
  stand: number;
  dir: number; // 使っている滑走路の向き（+1 = a が増える向きへ離着陸）
  phase: Phase;
  move: Move | null;
  t: number; // 段階の中の時刻（秒）
  T: number; // 駐機の時間（秒）
  exit: number; // 使う出口（runway.exits の番号）
  res: Res[];
  // 今の姿勢（敷地の座標）
  a: number; c: number; y: number; ha: number; hc: number; pitch: number;
  rev: boolean; // 後ろ向きに動いている（プッシュバック）
  lights: boolean; // 着陸灯をつけている
  moving: boolean;
}

const V_APP = 66, V_TAXI = 11, V_ROT = 66;
const TAKEOFF_ACC = 2.6, CLIMB = 0.15;
const BRIDGE_TIME = 7; // 搭乗橋がのびる・ちぢむ時間（秒）

// 1 つの空港の運航。
// 地上では「区間」を予約して動く：区間どうしの距離が、いちばん大きい機材の大きさ（翼幅・全長）＋余裕より近いものは同時に使えない
// （翼端・機首と尾が重ならない）。出発・着陸は 1 機ずつ交互に地上を動かし、行き先までの区間をまとめて押さえてから動き出す
// （途中で止まらない。止まるのは、滑走路の手前で着陸・離陸を待つときと、駐機スポットだけ）
export class AirOps {
  L: AirportLayout;
  dir = 1;
  aircraft: Ac[] = [];
  trips: Trip[] = [];
  // 入力（シミュレーションの数字）
  flights = 0;
  cargoFlights = 0;
  open = false;
  // 搭乗橋ののび（0 = 縮んでいる、1 = 扉についている）。スポットごと
  bridge: Float32Array;
  private spawnT = 10;
  private flipPending = false;
  private windT = 420;
  private adj: { to: number; w: number; e: number }[][];
  // 区間：誘導路の辺（0..E-1）、スポットへの引き込み、出口、滑走路への入口
  private segPts: [number, number][][] = [];
  private conf: number[][] = [];
  private segOwner!: Int32Array;
  private standSeg: number[] = [];
  private exitSeg: number[] = [];
  private lineSeg: number[] = [];
  private standUsed: (Ac | null)[];
  private rnd: () => number;
  private nextId = 1;
  private out: { neg: number; pos: number };
  private paths = new Map<string, Path>();
  private walk: Path[] = [];
  onDirChange: ((dir: number) => void) | null = null;
  // 進入・上昇のマップの外までの長さ（m）。向き（-1, +1）ごと
  constructor(L: AirportLayout, out: { neg: number; pos: number }, seed: number) {
    this.L = L;
    this.out = out;
    let s = seed >>> 0 || 1;
    this.rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    this.standUsed = L.stands.map(() => null);
    this.bridge = new Float32Array(L.stands.length);
    const N = L.net.nodes.length;
    this.adj = Array.from({ length: N }, () => []);
    L.net.edges.forEach(([i, j], e) => {
      const w = Math.hypot(L.net.nodes[i][0] - L.net.nodes[j][0], L.net.nodes[i][1] - L.net.nodes[j][1]);
      this.adj[i].push({ to: j, w, e });
      this.adj[j].push({ to: i, w, e });
      this.segPts.push([L.net.nodes[i], L.net.nodes[j]]);
    });
    L.stands.forEach((st) => { this.standSeg.push(this.segPts.length); this.segPts.push([L.net.nodes[st.node], [st.a, st.noseC]]); });
    const r = L.runways[0];
    r.exits.forEach((e) => { this.exitSeg.push(this.segPts.length); this.segPts.push(e.pts.slice(1)); });
    for (let k = 0; k < 2; k++) { this.lineSeg.push(this.segPts.length); this.segPts.push([L.net.nodes[r.junction[k]], [r.links[k], r.c + r.width / 2]]); }
    // 同時に使えない区間（区間の間の距離が、いちばん大きい機材の大きさ + 6m より近い）
    let big = 0;
    for (const t of [...L.types, ...L.wideTypes, ...L.cargoTypes]) big = Math.max(big, AC[t].span, AC[t].len);
    const D = big + 6, M = this.segPts.length;
    this.conf = Array.from({ length: M }, () => []);
    for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) if (polyDist(this.segPts[i], this.segPts[j]) < D) { this.conf[i].push(j); this.conf[j].push(i); }
    this.segOwner = new Int32Array(M).fill(-1);
    // 歩いて乗る空港：ターミナルの出口から、前の左の扉（機首が +c のとき左は +a）
    const sv = L.serviceC, pier = L.buildings.find((b) => b.kind === 'pier');
    L.stands.forEach((st) => {
      const typ = this.standType(st);
      this.walk.push(makePath([[st.a + 7, (pier ? pier.r.c0 : sv + 4) + 0.5], [st.a + 7, sv], [st.a + AC[typ].R + 1.4, st.noseC - 4.5]]));
    });
    this.dir = this.rnd() < 0.5 ? 1 : -1;
    this.windT = 300 + this.rnd() * 300;
  }

  // スポットの大きさの目安の機材（地上の車両の止まる場所に使う）
  private standType(st: StandDef): AcType {
    if (st.cargo) return st.wide && this.L.cargoTypes.includes('b787') ? 'b787' : this.L.cargoTypes[0];
    if (st.wide && this.L.wideTypes.length) return this.L.wideTypes[0];
    return this.L.types[0];
  }
  private standC(k: number, type: AcType) {
    return this.L.stands[k].noseC - AC[type].len / 2;
  }
  private node(i: number): [number, number] {
    return this.L.net.nodes[i];
  }

  // 誘導路の網の最短の道（ノードの並び）と、通る辺
  private route(from: number, to: number): { nodes: number[]; edges: number[] } {
    const N = this.adj.length, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), pe = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    dist[from] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < N; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === to) break;
      done[u] = 1;
      for (const { to: v, w, e } of this.adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; pe[v] = e; }
    }
    const nodes: number[] = [], edges: number[] = [];
    for (let v = to; v >= 0; v = prev[v]) { nodes.push(v); if (pe[v] >= 0) edges.push(pe[v]); if (v === from) break; }
    return { nodes: nodes.reverse(), edges: edges.reverse() };
  }
  private pathOf(key: string, make: () => [number, number][], r = 24): Path {
    let p = this.paths.get(key);
    if (!p) this.paths.set(key, (p = makePath(make(), r)));
    return p;
  }
  private runway() {
    return this.L.runways[0];
  }
  private endIdx(dir: number, start: boolean) {
    // 離陸は滑走路の手前の端から（dir > 0 なら a0 の側）
    return (dir > 0) === start ? 0 : 1;
  }
  private appr(dir: number) {
    const r = this.runway(), thr = dir > 0 ? r.a0 : r.a1;
    const inLen = (dir > 0 ? this.out.neg : this.out.pos) - Math.abs(thr);
    return this.pathOf(`appr${dir}`, () => [[thr - dir * inLen, r.c], [thr + dir * r.td, r.c]]);
  }
  private takePath(dir: number) {
    const r = this.runway(), start = r.links[this.endIdx(dir, true)];
    const outLen = (dir > 0 ? this.out.pos : this.out.neg) + Math.abs(start);
    return this.pathOf(`take${dir}`, () => [[start + dir * 40, r.c], [start + dir * (40 + outLen), r.c]]);
  }
  // 着陸機の出口：止まれる距離のある最初の高速脱出誘導路。使えなければ奥の端の取付誘導路
  private chooseExit(dir: number): number {
    const r = this.runway(), thr = dir > 0 ? r.a0 : r.a1, td = thr + dir * r.td;
    let best = -1, bd = Infinity;
    r.exits.forEach((e, k) => {
      if (e.dir !== dir) return;
      const d = (e.a - td) * dir;
      const need = (60 * 60 - e.speed * e.speed) / (2 * 3.0);
      if (d < need) return;
      if (d < bd) { bd = d; best = k; }
    });
    if (best < 0) best = r.exits.findIndex((e) => e.dir === dir && !e.rapid);
    return best;
  }
  private rollPath(dir: number, exit: number) {
    const r = this.runway(), thr = dir > 0 ? r.a0 : r.a1, e = r.exits[exit];
    return this.pathOf(`roll${exit}`, () => [[thr + dir * r.td, r.c], [e.a, r.c]]);
  }
  private exitPath(exit: number) {
    return this.pathOf(`exit${exit}`, () => this.runway().exits[exit].pts, 26);
  }
  // 出口から駐機スポットまで：区間（出口・誘導路の辺・スポットへの引き込み）と、滑走路を出るところから続けて走る道すじ
  private taxiIn(ac: Ac): { segs: number[]; path: Path; fromNode: Path } {
    const e = this.runway().exits[ac.exit], st = this.L.stands[ac.stand];
    const rt = this.route(e.node, st.node);
    const tail: [number, number][] = [];
    for (const n of rt.nodes.slice(1)) tail.push(this.node(n));
    tail.push([st.a, this.standC(ac.stand, ac.type)]);
    const path = this.pathOf(`in${ac.exit}.${ac.stand}.${ac.type}`, () => [...e.pts, ...tail]);
    const fromNode = this.pathOf(`inN${ac.exit}.${ac.stand}.${ac.type}`, () => [this.node(e.node), ...tail]);
    return { segs: [this.exitSeg[ac.exit], ...rt.edges, this.standSeg[ac.stand]], path, fromNode };
  }
  // 出発：プッシュバックの道すじ、待つ場所（平行誘導路の上、停止位置の標示の手前）までの道すじ、滑走路へ入る道すじ
  private taxiOut(ac: Ac): { segs: number[]; push: Path; out: Path; line: Path } {
    const r = this.runway(), k = this.endIdx(ac.dir, true), st = this.L.stands[ac.stand];
    const rt = this.route(st.node, r.junction[k]);
    const nodes = rt.nodes;
    // 押す向き：最初に進むノードの反対側へ尾を振る（機首が進む向きを向いて止まる）
    const [sa, sc] = this.node(st.node);
    const nx = nodes.length > 1 ? this.node(nodes[1]) : [sa - 1, sc];
    const along = Math.abs(nx[0] - sa) > 1;
    const away = along ? -Math.sign(nx[0] - sa) : Math.sign(sa - r.links[k]) || 1;
    const p0: [number, number] = [sa + away * (AC[ac.type].len * 0.5 + 14), sc];
    // 尾を振る側のとなりの辺（押しているあいだ押さえる）
    const extra: number[] = [];
    for (const { to, e } of this.adj[st.node]) { const [ta, tcc] = this.node(to); if (Math.abs(tcc - sc) < 1 && Math.sign(ta - sa) === away) extra.push(e); }
    const key = `${ac.stand}.${ac.type}.${ac.dir}.${away}`;
    const push = this.pathOf(`push${key}`, () => [p0, [sa, sc], [st.a, this.standC(ac.stand, ac.type)]], 6);
    // 待つ場所：交わり（J）の手前、機体の半分 + 25m（滑走路の手前の標示より誘導路の側）
    const J = this.node(nodes[nodes.length - 1]);
    const prev = nodes.length >= 2 ? this.node(nodes[nodes.length - 2]) : p0;
    const dx = J[0] - prev[0], dy = J[1] - prev[1], l = Math.hypot(dx, dy) || 1;
    const q: [number, number] = [J[0] - (dx / l) * Math.min(l * 0.8, AC[ac.type].len / 2 + 25), J[1] - (dy / l) * Math.min(l * 0.8, AC[ac.type].len / 2 + 25)];
    const out = this.pathOf(`out${key}`, () => {
      const pts: [number, number][] = [p0];
      for (const n of nodes.slice(0, -1)) pts.push(this.node(n));
      pts.push(q);
      return pts;
    });
    const line = this.pathOf(`line${key}`, () => [q, J, [r.links[k], r.c], [r.links[k] + ac.dir * 40, r.c]], 18);
    return { segs: [this.standSeg[ac.stand], ...extra, ...rt.edges], push, out, line };
  }

  // ---- 区間の予約 ----
  private segFree(id: number, ac: Ac) {
    const o = this.segOwner[id];
    if (o >= 0 && o !== ac.id) return false;
    for (const j of this.conf[id]) { const q = this.segOwner[j]; if (q >= 0 && q !== ac.id) return false; }
    return true;
  }
  private free(segs: number[], ac: Ac) {
    for (const id of segs) if (!this.segFree(id, ac)) return false;
    return true;
  }
  // 区間を押さえる。path があれば、その道すじの上で区間の終わりを尾が通りすぎたら放す
  private reserve(ac: Ac, segs: number[], path: Path | null) {
    for (const id of segs) {
      const old = ac.res.find((r) => r.id === id);
      const end = this.segPts[id][this.segPts[id].length - 1], beg = this.segPts[id][0];
      const s = path ? Math.max(nearestS(path, end), nearestS(path, beg)) : Infinity;
      if (old) { old.path = path; old.s = s; continue; }
      this.segOwner[id] = ac.id;
      ac.res.push({ id, path, s });
    }
  }
  private releaseAll(ac: Ac, keep: number[] = []) {
    let w = 0;
    for (const r of ac.res) {
      if (keep.includes(r.id)) { ac.res[w++] = r; continue; }
      if (this.segOwner[r.id] === ac.id) this.segOwner[r.id] = -1;
    }
    ac.res.length = w;
  }
  // 尾が区間の終わりを通りすぎたら放す（毎フレーム。配列は作らない）
  private releasePassed(ac: Ac, s: number) {
    const m = ac.move;
    if (!m) return;
    const back = AC[ac.type].len * 0.5 + 8;
    const pos = ac.rev ? m.path.len - s : s;
    let w = 0;
    for (let i = 0; i < ac.res.length; i++) {
      const r = ac.res[i];
      if (r.path === m.path && (ac.rev ? pos < 0 : pos - back > r.s)) { if (this.segOwner[r.id] === ac.id) this.segOwner[r.id] = -1; continue; }
      ac.res[w++] = r;
    }
    ac.res.length = w;
  }

  private anyPhase(p1: Phase, p2: Phase, p3: Phase = p2, p4: Phase = p2, p5: Phase = p2) {
    for (let i = 0; i < this.aircraft.length; i++) { const ph = this.aircraft[i].phase; if (ph === p1 || ph === p2 || ph === p3 || ph === p4 || ph === p5) return true; }
    return false;
  }
  // 地上を動く着陸機がいる（出発機は、これがいなくなるまでスポットで待つ）
  private arrivalActive() {
    return this.anyPhase('approach', 'rollout', 'exit', 'holdIn', 'taxiIn');
  }
  // 出発の流れが動いている（着陸機は、これがいなくなるまで出さない）
  private departureActive() {
    return this.anyPhase('push', 'pushed', 'taxiOut', 'holdOut', 'lineup') || this.anyPhase('ready', 'ready');
  }

  // 便の多さ（0..1）
  busy() {
    const cap = this.L.spec.paxCap / this.L.spec.paxPerFlight;
    return Math.min(1, (this.flights + this.cargoFlights) / Math.max(1, cap));
  }

  // 最初に駐機している飛行機（街を開いたとき、空港が空っぽに見えないように）
  seed() {
    const max = this.L.spec.maxAircraft;
    const k = this.open ? Math.round(1 + this.busy() * (max - 1.6)) : 1;
    for (let q = 0; q < Math.min(k, max - 1); q++) {
      const cargo = this.cargoFlights > 0 && q === 1;
      const st = this.freeStand(cargo);
      if (st < 0) break;
      const ac = this.newAc(cargo, st);
      ac.phase = 'park';
      ac.T = this.turnTime(ac);
      ac.t = this.open ? this.rnd() * ac.T * 0.8 : 0;
      this.placeAtStand(ac);
      this.aircraft.push(ac);
      if (this.L.stands[st].bridge && ac.t > 4 && ac.t < ac.T - 16) this.bridge[st] = 1;
      // 折り返しの途中から：地上の車両も途中から
      if (this.open) {
        const n0 = this.trips.length;
        this.serviceStart(ac);
        for (let j = n0; j < this.trips.length; j++) this.trips[j].t = ac.t;
      }
    }
  }

  private turnTime(ac: Ac) {
    return (ac.cargo ? 95 : 70) + (AC[ac.type].wide ? 30 : 0) + this.rnd() * 30;
  }

  private freeStand(cargo: boolean) {
    const ks: number[] = [];
    this.L.stands.forEach((s, k) => { if (s.cargo === cargo && !this.standUsed[k]) ks.push(k); });
    // 搭乗橋のあるスポットから先に使う
    const br = ks.filter((k) => this.L.stands[k].bridge);
    const pool = br.length && this.rnd() < 0.85 ? br : ks;
    return pool.length ? pool[Math.floor(this.rnd() * pool.length)] : -1;
  }

  private newAc(cargo: boolean, stand: number): Ac {
    const st = this.L.stands[stand], L = this.L;
    let types: AcType[] = cargo ? L.cargoTypes.filter((t) => st.wide || !AC[t].wide) : st.wide && L.wideTypes.length && this.rnd() < 0.55 ? L.wideTypes : L.types;
    if (!types.length) types = [this.standType(st)];
    const type = types[Math.floor(this.rnd() * types.length)];
    const ls: number[] = [];
    ALL_LIVERIES.forEach((l, i) => { if (!!l.cargo === cargo && l.fleet.includes(type)) ls.push(i); });
    const li = ls.length ? ls[Math.floor(this.rnd() * ls.length)] : ALL_LIVERIES.indexOf(CARGO_LIVERY);
    const ac: Ac = { id: this.nextId++, type, livery: li, cargo, stand, dir: this.dir, phase: 'approach', move: null, t: 0, T: 0, exit: -1, res: [], a: 0, c: 0, y: 0, ha: 0, hc: 1, pitch: 0, rev: false, lights: false, moving: false };
    this.standUsed[stand] = ac;
    return ac;
  }

  private placeAtStand(ac: Ac) {
    const st = this.L.stands[ac.stand];
    ac.a = st.a; ac.c = this.standC(ac.stand, ac.type); ac.y = 0; ac.ha = 0; ac.hc = 1; ac.pitch = 0; ac.rev = false; ac.moving = false; ac.lights = false;
  }

  // 滑走路が使われているか（着陸・離陸の飛行機。滑走路は 1 機ずつ）
  private runwayBusy(forArrival: boolean) {
    for (let i = 0; i < this.aircraft.length; i++) {
      const ac = this.aircraft[i];
      if (ac.phase === 'rollout' || ac.phase === 'lineup') return true;
      if (ac.phase === 'exit' && ac.t < 10) return true;
      if (ac.phase === 'taxiIn' && ac.t < 12) return true; // 出口から続けて走るとき、滑走路を出るまで
      if (ac.phase === 'takeoff' && ac.y < 250) return true;
      if (ac.phase === 'approach') {
        if (forArrival) return true;
        // 接地まで 60 秒より近い着陸機がいれば、離陸を待つ（着陸が先）
        if (ac.move && ac.move.T - ac.t < 60) return true;
      }
    }
    return false;
  }

  private nightFactor(tod: number) {
    // 深夜（0 時〜5 時半）は便が少ない
    const h = tod * 24;
    if (h < 5.5) return 0.1;
    if (h < 6.5) return 0.1 + 0.9 * (h - 5.5);
    if (h > 23) return 1 - 0.9 * (h - 23);
    return 1;
  }

  private startMove(ac: Ac, m: Move, phase: Phase) {
    ac.move = m;
    ac.t = 0;
    ac.phase = phase;
  }

  // dt 秒すすめる（tod = 1 日のうちの時刻 0..1）
  update(dt: number, tod: number) {
    if (dt <= 0) return;
    const sp = this.L.spec;
    // 風向きが変わる（滑走路を使う向きを入れかえる）。時刻が来たら、新しい着陸と出発を止めて、動いている飛行機がいなくなるのを待つ
    this.windT -= dt;
    this.flipPending = this.windT <= 0;
    if (this.flipPending) {
      let quiet = true;
      for (let i = 0; i < this.aircraft.length; i++) { const a = this.aircraft[i]; if (!(a.phase === 'park' || a.phase === 'ready' || (a.phase === 'takeoff' && a.y > 300))) quiet = false; }
      if (quiet) {
        this.dir = -this.dir;
        this.windT = 360 + this.rnd() * 420;
        this.flipPending = false;
        this.onDirChange?.(this.dir);
      }
    }
    // 新しい便（着陸）：出発の流れが動いていないときだけ（着陸機は滑走路を出てから止まらずにスポットまで走る）
    const rate = this.open ? this.flights + this.cargoFlights : 0;
    if (rate > 0 && !this.flipPending) {
      this.spawnT -= dt * this.nightFactor(tod);
      if (this.spawnT <= 0) {
        const cargo = this.cargoFlights > 0 && this.rnd() < this.cargoFlights / rate;
        const st = this.freeStand(cargo);
        if (st >= 0 && this.aircraft.length < sp.maxAircraft && !this.runwayBusy(true) && !this.departureActive() && !this.arrivalActive()) {
          const ac = this.newAc(cargo, st);
          ac.dir = this.dir;
          this.startMove(ac, makeMoveCached(this.appr(ac.dir), V_APP, V_APP, V_APP - 6), 'approach');
          ac.lights = true;
          this.aircraft.push(ac);
          const b = this.busy(), base = 160 / Math.sqrt(sp.maxAircraft / 3);
          this.spawnT = (base - base * 0.65 * b) * (0.7 + 0.6 * this.rnd());
        } else this.spawnT = 4;
      }
    }
    for (let i = 0; i < this.aircraft.length; i++) this.step(this.aircraft[i], dt);
    // いなくなった飛行機を外す（配列を作り直さない）
    let w = 0;
    for (let i = 0; i < this.aircraft.length; i++) if (this.aircraft[i].phase !== 'gone') this.aircraft[w++] = this.aircraft[i];
    this.aircraft.length = w;
    // 搭乗橋：駐機して少したったらのび、出発の前に縮む
    for (let k = 0; k < this.bridge.length; k++) {
      if (!this.L.stands[k].bridge) continue;
      const ac = this.standUsed[k];
      const want = ac && ac.phase === 'park' && ac.t > 3 && ac.t < ac.T - 16 ? 1 : 0;
      const v = this.bridge[k] + (want ? dt : -dt) / BRIDGE_TIME;
      this.bridge[k] = Math.max(0, Math.min(1, v));
    }
    // 地上の車両
    for (let i = 0; i < this.trips.length; i++) {
      const tr = this.trips[i];
      if (!tr.live) continue;
      tr.t += dt;
      if (tr.attach < 0 && tr.t > (tr.oneWay ? tr.drive : tr.drive * 2 + tr.stay)) tr.live = false;
    }
  }

  private step(ac: Ac, dt: number) {
    ac.t += dt;
    const done = ac.move ? ac.t >= ac.move.T : false;
    const r = this.runway();
    switch (ac.phase) {
      case 'approach':
        if (done) {
          ac.exit = this.chooseExit(ac.dir);
          const e = r.exits[ac.exit];
          const roll = this.rollPath(ac.dir, ac.exit);
          const v0 = V_APP - 6;
          this.startMove(ac, makeMoveCached(roll, v0, v0, e.speed, 1, Math.max(0.5, (v0 * v0 - e.speed * e.speed) / (2 * roll.len))), 'rollout');
        }
        break;
      case 'rollout':
        if (done) {
          // 滑走路を出てからスポットまで止まらずに走る：出口からスポットまでの区間をまとめて押さえる
          const e = r.exits[ac.exit], ti = this.taxiIn(ac);
          if (this.free(ti.segs, ac)) {
            this.reserve(ac, ti.segs, ti.path);
            this.startMove(ac, makeMoveCached(ti.path, e.speed, V_TAXI, 0, 0.8, e.rapid ? 1.6 : 0.8), 'taxiIn');
          } else {
            // 前の飛行機が出口の先にいる（見えている理由）：出口の先で止まって待つ
            this.startMove(ac, makeMoveCached(this.exitPath(ac.exit), e.speed, e.speed, 0, 1, e.rapid ? 2.2 : 1.2), 'exit');
          }
        }
        break;
      case 'exit':
        if (done) { ac.phase = 'holdIn'; ac.t = 0; ac.lights = false; }
        break;
      case 'holdIn': {
        const ti = this.taxiIn(ac);
        if (this.free(ti.segs, ac)) {
          this.reserve(ac, ti.segs, ti.fromNode);
          this.startMove(ac, makeMoveCached(ti.fromNode, 0, V_TAXI, 0, 0.6, 0.8), 'taxiIn');
        }
        break;
      }
      case 'taxiIn':
        if (ac.t > 6) ac.lights = false;
        if (done) {
          this.releaseAll(ac);
          ac.phase = 'park'; ac.t = 0; ac.T = this.turnTime(ac); ac.move = null;
          this.serviceStart(ac);
        }
        break;
      case 'park':
        if (ac.t > ac.T - 14 && ac.t - dt <= ac.T - 14) this.tugIn(ac);
        if (ac.t >= ac.T) { ac.phase = 'ready'; ac.t = 0; }
        break;
      case 'ready': {
        // 搭乗橋が縮み、着陸機が地上を動いておらず、スポットから停止位置の手前までの区間がすべて空いているとき
        if (this.flipPending || this.bridge[ac.stand] > 0.01 || this.arrivalActive()) break;
        // 先に待っている出発機がいれば、それが先（出発は 1 機ずつ、順番に）
        if (this.anyPhase('push', 'pushed', 'taxiOut', 'holdOut', 'lineup')) break;
        ac.dir = this.dir;
        const to = this.taxiOut(ac);
        if (!this.free(to.segs, ac)) break;
        this.reserve(ac, to.segs.slice(0, 1), null);
        this.reserve(ac, to.segs.slice(1), to.out);
        this.startMove(ac, makeMoveCached(to.push, 0, 1.4, 0, 0.3, 0.3), 'push');
        ac.rev = true;
        this.standUsed[ac.stand] = null;
        break;
      }
      case 'push':
        if (done) { ac.phase = 'pushed'; ac.t = 0; ac.rev = false; this.tugAway(ac); }
        break;
      case 'pushed':
        // トーイングカーが離れるのを待って（4 秒）、自分で走り出す
        if (ac.t > 4) {
          const to = this.taxiOut(ac);
          this.releaseAll(ac, to.segs.slice(1));
          this.startMove(ac, makeMoveCached(to.out, 0, V_TAXI, 0, 0.6, 0.7), 'taxiOut');
        }
        break;
      case 'taxiOut': {
        // 待つ場所に近づいたとき、滑走路が空いていれば止まらずにそのまま滑走路へ入る
        const m = ac.move!;
        if (m.T - ac.t < 9 && !this.runwayBusy(false)) {
          const to = this.taxiOut(ac);
          const v = moveV(m, ac.t), s0 = moveS(m, ac.t);
          const pts: [number, number][] = [[ac.a, ac.c]];
          for (let i = 0; i < m.path.s.length; i++) if (m.path.s[i] > s0 + 1) pts.push([m.path.a[i], m.path.c[i]]);
          for (let i = 1; i < to.line.s.length; i++) pts.push([to.line.a[i], to.line.c[i]]);
          const k = this.endIdx(ac.dir, true);
          this.reserve(ac, [this.lineSeg[k]], null);
          this.startMove(ac, makeMove(makePath(pts, 0), v, Math.max(v, 7), 4, 0.6, 0.8), 'lineup');
          ac.lights = true;
          break;
        }
        if (done) { ac.phase = 'holdOut'; ac.t = 0; }
        break;
      }
      case 'holdOut':
        // 停止位置の標示の手前（平行誘導路の上）で、着陸・離陸が終わるのを待つ
        if (ac.t > 3 && !this.runwayBusy(false)) {
          const to = this.taxiOut(ac), k = this.endIdx(ac.dir, true);
          this.reserve(ac, [this.lineSeg[k]], null);
          this.startMove(ac, makeMoveCached(to.line, 0, 7, 4, 0.6, 0.8), 'lineup');
          ac.lights = true;
        }
        break;
      case 'lineup':
        if (done) { this.releaseAll(ac); this.startMove(ac, makeMoveCached(this.takePath(ac.dir), 4, 88, 88, TAKEOFF_ACC, 1), 'takeoff'); }
        break;
      case 'takeoff':
        if (done) ac.phase = 'gone';
        break;
    }
    this.pose(ac);
    if (ac.moving && ac.res.length && ac.move && ac.phase !== 'push') this.releasePassed(ac, moveS(ac.move, Math.min(ac.t, ac.move.T)));
  }

  // 今の位置と姿勢
  private tmp = new Float32Array(4);
  private pose(ac: Ac) {
    const m = ac.move;
    if (ac.phase === 'park' || ac.phase === 'ready' || ac.phase === 'holdIn' || ac.phase === 'holdOut' || ac.phase === 'pushed' || !m) { ac.moving = false; if (ac.phase !== 'park' && ac.phase !== 'ready') return; this.placeAtStand(ac); return; }
    const t = Math.min(ac.t, m.T);
    const s = moveS(m, t);
    const o = this.tmp;
    samplePath(m.path, ac.rev ? m.path.len - s : s, o);
    ac.a = o[0]; ac.c = o[1];
    // 後ろ向きに進むとき（プッシュバック）は、道すじを逆にたどる。機首は道すじの前の向き
    ac.ha = o[2]; ac.hc = o[3];
    ac.moving = true;
    ac.y = 0;
    ac.pitch = 0;
    const tg = Math.tan((this.L.glide * Math.PI) / 180);
    if (ac.phase === 'approach') {
      // 進入角（小は 5.5° のロンドン・シティ空港のような急な進入）。接地の手前で引き起こす（フレア）
      const d = m.path.len - s;
      ac.y = tg * (d - 40 + 40 * Math.exp(-d / 40));
      ac.pitch = 0.035 + 0.06 * Math.exp(-d / 60);
    } else if (ac.phase === 'takeoff') {
      const v = moveV(m, t), vr = AC[ac.type].wide ? V_ROT + 6 : V_ROT;
      const slo = (vr * vr - 16) / (2 * TAKEOFF_ACC);
      if (s > slo) {
        const x = s - slo, R = 1500, xs = CLIMB * R;
        ac.y = x < xs ? (x * x) / (2 * R) : (xs * xs) / (2 * R) + (x - xs) * CLIMB;
        ac.pitch = Math.min(0.17, 0.05 + x / 600);
      } else if (v > vr - 6) ac.pitch = ((v - (vr - 6)) / 6) * 0.08;
    } else if (ac.phase === 'rollout') {
      ac.pitch = Math.max(0, 0.02 - t * 0.01);
    }
  }

  // 搭乗橋の扉の位置（スポットの飛行機、いなければスポットの目安の機材）。out = [a, c, 床の高さ]
  bridgeDoor(k: number, out: Float32Array) {
    const st = this.L.stands[k], ac = this.standUsed[k];
    const t = ac && (ac.phase === 'park' || ac.phase === 'ready') ? ac.type : this.standType(st);
    const d = AC[t];
    out[0] = st.a + d.R + 0.2; out[1] = st.noseC - d.door[0]; out[2] = d.door[1];
  }

  // ---- 地上の車両 ----
  private trip(type: GseType, path: Path, stay: number, carts = 0, speed = 6): Trip {
    let tr = this.trips.find((q) => !q.live);
    if (!tr) { tr = { type, path, t: 0, drive: 0, stay: 0, carts: 0, live: false, attach: -1, oneWay: false, ac: null }; this.trips.push(tr); }
    tr.type = type; tr.path = path; tr.t = 0; tr.drive = path.len / speed; tr.stay = stay; tr.carts = carts; tr.live = true; tr.attach = -1; tr.oneWay = false; tr.ac = null;
    return tr;
  }
  // 車庫 → 構内道路 → スポットのそば（off = スポットの中心線からの横のずれ、endC = 止まる c）
  private gsePath(k: number, kind: string, off: number, endC: number) {
    const [da, dc] = this.L.depot, sv = this.L.serviceC, st = this.L.stands[k];
    return this.pathOf(`gse.${kind}.${k}`, () => [[da, dc], [da, sv], [st.a + off, sv], [st.a + off, endC]], 7);
  }
  private serviceStart(ac: Ac) {
    const k = ac.stand, st = this.L.stands[k], d = AC[this.standType(st)], cc = st.noseC - d.len / 2;
    this.trip('fuel', this.gsePath(k, 'fuel', -(d.span * 0.28), cc + 2), ac.T * 0.5);
    this.trip('tractor', this.gsePath(k, 'bags', d.R + 4, cc - d.len * 0.22), ac.T - 34, d.wide ? 3 : 2, 5);
    // 搭乗橋のないスポットはバス（歩いて乗る空港では、乗務員と体の不自由な人のバス）
    if (!ac.cargo && !st.bridge) this.trip('bus', this.gsePath(k, 'bus', d.span * 0.42, cc + d.len * 0.18), ac.T * 0.3, 0, 5.5);
  }
  private tugIn(ac: Ac) {
    const st = this.L.stands[ac.stand];
    const tr = this.trip('tug', this.gsePath(ac.stand, 'tug', 0, st.noseC + 4.5), 1e9, 0, 4);
    tr.attach = 1;
    tr.ac = ac;
  }
  private tugAway(ac: Ac) {
    const tr = this.trips.find((q) => q.live && q.ac === ac);
    if (!tr) return;
    tr.ac = null;
    // 押し終えたら、今いる所（機首の前）から車庫へ戻る（出発ごとに 1 回だけ道すじを作る）
    const L = AC[ac.type].len / 2 + 4.2, ta = ac.a + ac.ha * L, tcc = ac.c + ac.hc * L;
    const [da, dc] = this.L.depot, sv = this.L.serviceC;
    const back = makePath([[ta, tcc], [ta + ac.ha * 9, tcc + 12], [ta + ac.ha * 9, sv], [da, sv], [da, dc]], 8);
    tr.path = back; tr.t = 0; tr.drive = back.len / 5; tr.stay = 0; tr.attach = -1; tr.oneWay = true;
  }

  // 地上の車両と歩く人の姿勢を書き出す。emit(type, a, c, ha, hc)
  eachGse(time: number, emit: (t: GseType, a: number, c: number, ha: number, hc: number) => void) {
    const o = this.tmp;
    for (let i = 0; i < this.trips.length; i++) {
      const tr = this.trips[i];
      if (!tr.live) continue;
      // 押しているトーイングカー：飛行機の機首の前
      if (tr.attach >= 0) {
        const ac = tr.ac && tr.ac.phase !== 'gone' ? tr.ac : null;
        if (ac && (ac.phase === 'push' || ac.phase === 'ready' || (ac.phase === 'park' && tr.t >= tr.drive))) {
          const L = AC[ac.type].len / 2 + 4.2;
          emit('tug', ac.a + ac.ha * L, ac.c + ac.hc * L, -ac.ha, -ac.hc);
          continue;
        }
        if (!ac) { tr.live = false; continue; }
      }
      let s: number, rev = false;
      if (tr.oneWay) s = Math.min(1, tr.t / tr.drive) * tr.path.len;
      else if (tr.t < tr.drive) s = (tr.t / tr.drive) * tr.path.len;
      else if (tr.t < tr.drive + tr.stay) s = tr.path.len;
      else { s = tr.path.len - ((tr.t - tr.drive - tr.stay) / tr.drive) * tr.path.len; rev = true; }
      samplePath(tr.path, s, o);
      // 戻りも前向きに走る（向きを逆に）
      const ha = rev ? -o[2] : o[2], hc = rev ? -o[3] : o[3];
      emit(tr.type, o[0], o[1], ha, hc);
      for (let k = 1; k <= tr.carts; k++) {
        samplePath(tr.path, rev ? s + k * 3.7 : s - k * 3.7, o);
        emit('cart', o[0], o[1], rev ? -o[2] : o[2], rev ? -o[3] : o[3]);
      }
    }
    // 歩いて乗り降りする人（搭乗橋のない空港）：降りる（駐機の始め）、乗る（駐機の終わり）
    if (!this.L.walk) return;
    for (let i = 0; i < this.aircraft.length; i++) {
      const ac = this.aircraft[i];
      if (ac.phase !== 'park' || ac.cargo) continue;
      const p = this.walk[ac.stand];
      const t = ac.t, T = ac.T;
      const off = t < 30 ? 8 : T - 38, end = t < 30 ? 26 : T - 16;
      if (t < off || t > end) continue;
      const out = t < 30;
      for (let k = 0; k < 10; k++) {
        const u = (t - off) * 1.3 - k * 2.6;
        if (u < 0 || u > p.len) continue;
        samplePath(p, out ? p.len - u : u, o);
        // 列の中で少し横にずらす
        const side = ((k * 7) % 5 - 2) * 0.35;
        emit('pax', o[0] - o[3] * side, o[1] + o[2] * side, out ? -o[2] : o[2], out ? -o[3] : o[3]);
      }
    }
    void time;
  }
}

// 2 本の折れ線のいちばん近い距離（区間が同時に使えるかを決める）
function polyDist(p: [number, number][], q: [number, number][]): number {
  let best = Infinity;
  const segD = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
    // 線分 ab と cd の距離：交わっていれば 0、そうでなければ端点からもう一方の線分までのいちばん近い距離
    const cr = (o: [number, number], u: [number, number], v: [number, number]) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
    const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    const pd = (pp: [number, number], u: [number, number], v: [number, number]) => {
      const vx = v[0] - u[0], vy = v[1] - u[1], l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((pp[0] - u[0]) * vx + (pp[1] - u[1]) * vy) / l2));
      return Math.hypot(pp[0] - u[0] - vx * t, pp[1] - u[1] - vy * t);
    };
    return Math.min(pd(a, c, d), pd(b, c, d), pd(c, a, b), pd(d, a, b));
  };
  for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) best = Math.min(best, segD(p[i], p[i + 1], q[j], q[j + 1]));
  return best;
}

// 道すじの上で、点にいちばん近いところの道のり
function nearestS(p: Path, q: [number, number]): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < p.s.length; i++) {
    const d = Math.hypot(p.a[i] - q[0], p.c[i] - q[1]);
    if (d < bd) { bd = d; best = p.s[i]; }
  }
  return best;
}

// 同じ道すじと速さの組み合わせは、作った Move を使い回す（離着陸のたびに作らない）
const moveCache = new WeakMap<Path, Map<string, Move>>();
function makeMoveCached(path: Path, v0: number, vmax: number, v1: number, acc = 1, dec = 1): Move {
  let m = moveCache.get(path);
  if (!m) moveCache.set(path, (m = new Map()));
  const key = `${v0},${vmax},${v1},${acc},${dec}`;
  let mv = m.get(key);
  if (!mv) m.set(key, (mv = makeMove(path, v0, vmax, v1, acc, dec)));
  return mv;
}
