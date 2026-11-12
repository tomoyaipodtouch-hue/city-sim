// ジャンクション（都市高速どうし）のランプの、描く形と車の道すじ
//
// シミュレーションのマスはそのままで、描くときだけ、ランプのマスの並び（とその両端の本線・分かれ目のマス）を
// 1本のなめらかな曲線にする。マスの中心を結ぶ折れ線を 1m ごとに区切り、ガウスの重みでならす（曲がり角は半径 30〜40m の
// 曲線になり、曲がり始めは少しずつ曲がる）。両端は本線や幹のランプの向きにそろえて延ばしてからならすので、
// 本線から接するように分かれ、接するように合流する。高さもならして、坂の始まりと終わりをゆるやかにする。
// 道路の層（描く）と車の層（車の位置）が同じ曲線を使う。
import { Grid } from '../sim/grid';
import { CELL, DX, DY } from '../sim/constants';
import { RoadType, ROADS } from '../sim/defs';

export const JR_HALF = 3.0; // 描くランプの車道の半分の幅（1車線 3.25m ＋ 路肩で、欄干の内側 6.0m）
const LANE_SHIFT = 1.9; // 本線から分かれる・合流する点の、本線の中心からランプの側への横のずれ（右の車線の中心あたり）

export interface JChain {
  nodes: number[]; // 端（本線または分かれ目・合わさり目のランプ）＋ 途中のランプ ＋ 端
  x: Float32Array; // 1m ごとの点
  z: Float32Array;
  h: Float32Array;
  s: Float32Array; // 曲線に沿った長さ
  len: number;
  bound: number[]; // マスの境の s（bound[0] = 始めの端のマスの入口、bound[i+1] = nodes[i] と nodes[i+1] の境、最後 = 終わりの端のマスの出口）
  main0: JMain | null; // 始めの端が本線なら、その本線（中心線の点と向き）
  main1: JMain | null;
  fork0: number; // 始めの端が分かれ目のランプなら、そのノード（-1 = ちがう）
  join1: number; // 終わりの端が合わさり目のランプなら、そのノード
  tA: number; // 始めの端の、本線（または幹）の向き
  tZ: number;
  dead0: boolean; // 始めの端で本線が終わる（Y字の分かれ目）。そこではランプの幅を本線の片側の幅から少しずつ広げる
  dead1: boolean;
  // 本線の端に、このランプ 1 本だけがつながる（Y 字ではない。空港の前の道路のように、本線がそのままランプに続く）。
  // そこでは本線の真ん中から、本線の幅で始まる（終わる）
  solo0?: boolean;
  solo1?: boolean;
  lim?: number[]; // Y字の分かれ目の端から 1m ごとの、描く幅の上限
  draw0: number; // 描く範囲（s）
  draw1: number;
}
export interface JMain { node: number; x: number; z: number; ux: number; uz: number; side: number; half: number; h: number }
// 曲線の s での、描く車道の半分の幅（Y字の分かれ目では、本線の片側の幅 → JR_HALF へ 24m で広げる）
export const JR_GROW = 24;
export function jHalf(C: JChain, s: number) {
  const hf = (m: JMain | null, solo?: boolean) => (m ? (solo ? m.half : m.half / 2) : JR_HALF);
  let w = JR_HALF;
  // 広げる長さは、反対の端（描く範囲の終わり）までに広げ終わるように（短い鎖でも、となりの鎖と幅がそろう）
  const span = Math.max(4, C.draw1 - C.draw0);
  const G = Math.min(JR_GROW, span);
  const ease = (t: number) => t * t * (3 - 2 * t);
  if (C.dead0) { const t = Math.max(0, Math.min(1, (s - C.bound[0]) / G)), h = hf(C.main0, C.solo0), v = h + (JR_HALF - h) * ease(t); w = C.solo0 ? v : Math.min(w, v); }
  if (C.dead1) { const t = Math.max(0, Math.min(1, (C.bound[C.bound.length - 1] - s) / G)), h = hf(C.main1, C.solo1), v = h + (JR_HALF - h) * ease(t); w = C.solo1 ? (C.dead0 && C.solo0 ? Math.max(w, v) : v) : Math.min(w, v); }
  // Y字の分かれ目のとなりの曲線と重ならない幅まで
  if (C.lim) {
    const k = Math.round(C.dead0 ? s - C.bound[0] : C.bound[C.bound.length - 1] - s);
    if (k >= 0 && k < C.lim.length) w = Math.min(w, C.lim[k]);
  }
  return w;
}
// Y字の分かれ目の2本の曲線：分かれ目から 1m ごとに、相手の曲線までの距離の半分を、描く幅の上限にする（路面が重ならない）
function limitPair(a: JChain, aStart: boolean, b: JChain, bStart: boolean) {
  const L = JR_GROW + 16;
  const sample = (C: JChain, st: boolean) => {
    const out: JPt[] = [];
    for (let k = 0; k <= L; k++) out.push(jAt(C, st ? C.bound[0] + k : C.bound[C.bound.length - 1] - k));
    return out;
  };
  const pa = sample(a, aStart), pb = sample(b, bStart);
  const lim = (P: JPt[], Q: JPt[]) => P.map((p) => {
    let d = Infinity;
    for (const q of Q) d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
    return Math.max(1.6, d / 2);
  });
  // 分かれ目から離れるほど広がるだけ（ゆらがない）：先のどこよりも広くしない
  const mono = (l: number[]) => { for (let k = l.length - 2; k >= 0; k--) l[k] = Math.min(l[k], l[k + 1]); return l; };
  a.lim = mono(lim(pa, pb));
  b.lim = mono(lim(pb, pa));
}
export interface JPt { x: number; z: number; h: number; tx: number; tz: number }

const isJ = (g: Grid, v: number) => {
  const N = g.n * g.n;
  return v >= N ? g.up[v - N] === RoadType.Ramp && (g.jct[v - N] & 2) !== 0 : g.road[v] === RoadType.Ramp && (g.jct[v] & 1) !== 0;
};
const dirTo = (g: Grid, a: number, b: number) => {
  const n = g.n, N = n * n, ca = a % N, cb = b % N;
  const dx = (cb % n) - (ca % n), dy = ((cb / n) | 0) - ((ca / n) | 0);
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return -1;
};

// 曲線の上の点（s での位置・高さ・向き）
export function jAt(C: JChain, s: number, out: JPt = { x: 0, z: 0, h: 0, tx: 1, tz: 0 }) {
  const m = C.x.length;
  // s は 1m おきに近いので、比で見当をつけてから探す
  let k = Math.max(0, Math.min(m - 2, Math.floor((s / (C.len || 1)) * (m - 1))));
  while (k > 0 && C.s[k] > s) k--;
  while (k < m - 2 && C.s[k + 1] < s) k++;
  const ds = C.s[k + 1] - C.s[k] || 1, u = Math.max(0, Math.min(1, (s - C.s[k]) / ds));
  out.x = C.x[k] + (C.x[k + 1] - C.x[k]) * u;
  out.z = C.z[k] + (C.z[k + 1] - C.z[k]) * u;
  out.h = C.h[k] + (C.h[k + 1] - C.h[k]) * u;
  const tx = C.x[k + 1] - C.x[k], tz = C.z[k + 1] - C.z[k], l = Math.hypot(tx, tz) || 1;
  out.tx = tx / l;
  out.tz = tz / l;
  return out;
}

const CORR = 0.4 * CELL; // 曲線がマスの中心線から離れてよい長さ（となりのマスの道路や柱に重ならない）
const H_CORR = 1.0; // 高さを動かしてよい幅（m）。立体交差の下の空きは 6m より十分に大きい
const FSTEP = 1; // ならすときの点の間隔（m）。1m ごとの点をそのまま解く（間を補う曲線のゆらぎが出ない）

// 曲率の変化が小さい曲線（自然なスプラインに近い）を、帯の中で求める。pinA..pinZ の外（延長と端の点）は動かさない
// wideA / wideZ：Y字の分かれ目の端。そこから DEAD_R m のあいだは帯を広げて（本線の向きから、ランプの向きへ、ゆっくり曲がれるように）
const CORR_DEAD = 0.9 * CELL, DEAD_R = 64;
function fair(xs: number[], zs: number[], hs: number[], pinA: number, pinZ: number, wideA = 0, wideZ = 0) {
  const m = xs.length;
  const idx: number[] = [];
  for (let i = 0; i < m; i += FSTEP) idx.push(i);
  if (idx[idx.length - 1] !== m - 1) idx.push(m - 1);
  // 動かさない点の境（pinA, pinZ）も点にする。近すぎる点は除く（点の間隔がふぞろいだと、曲線がふくらんだり折れたりする）
  for (const q of [pinA, pinZ]) {
    for (let k = idx.length - 1; k >= 0; k--) if (idx[k] !== q && Math.abs(idx[k] - q) < FSTEP * 0.6 && idx[k] !== 0 && idx[k] !== m - 1) idx.splice(k, 1);
    if (!idx.includes(q)) idx.push(q);
  }
  idx.sort((a, b) => a - b);
  const K = idx.length;
  const ox = idx.map((i) => xs[i]), oz = idx.map((i) => zs[i]), oh = idx.map((i) => hs[i]);
  const pin = idx.map((i) => i <= pinA || i >= pinZ);
  // 曲がり（2階差分）の2乗の和が最小の曲線を、帯の中で求める（自然な3次スプラインと同じ形）。
  // 帯からはみ出した点は、帯の縁へ引き寄せる重みをつけて解き直す（数回）
  const crOf = (k: number) => {
    let cr = CORR;
    if (wideA) cr = Math.max(cr, CORR_DEAD * Math.max(0, 1 - (idx[k] - pinA) / wideA));
    if (wideZ) cr = Math.max(cr, CORR_DEAD * Math.max(0, 1 - (pinZ - idx[k]) / wideZ));
    return cr;
  };
  const wt: number[] = pin.map((p) => (p ? 1e6 : 1e-4));
  const tx = ox.slice(), tz = oz.slice();
  let cx = ox.slice(), cz = oz.slice();
  for (let round = 0; round < 10; round++) {
    cx = fairSolve(wt, tx);
    cz = fairSolve(wt, tz);
    let moved = false;
    for (let k = 0; k < K; k++) {
      if (pin[k]) continue;
      const dx = cx[k] - ox[k], dz = cz[k] - oz[k], d = Math.hypot(dx, dz), cr = crOf(k);
      if (d > cr) {
        tx[k] = ox[k] + (dx * cr * 0.98) / d;
        tz[k] = oz[k] + (dz * cr * 0.98) / d;
        wt[k] = Math.min(WCAP, wt[k] < 0.01 ? 0.05 : wt[k] * 2);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 高さも同じ（帯は ±H_CORR）
  const wh: number[] = pin.map((p) => (p ? 1e6 : 1e-4)), th = oh.slice();
  let ch = oh.slice();
  for (let round = 0; round < 10; round++) {
    ch = fairSolve(wh, th);
    let moved = false;
    for (let k = 0; k < K; k++) {
      if (pin[k]) continue;
      if (Math.abs(ch[k] - oh[k]) > H_CORR) {
        th[k] = oh[k] + Math.sign(ch[k] - oh[k]) * H_CORR * 0.98;
        wh[k] = Math.min(1e3, wh[k] < 1 ? 0.5 : wh[k] * 4);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 1m ごとの点へ（3次エルミート）。接線はふつう前後の点から求めるが、動かさない区間との境の点では、動かさない側の向き
  // （本線・幹の向き）にそろえる（そこで折れないように）
  const tan = (c: number[], k: number) => {
    const pk = pin[k];
    if (k === 0) return c[1] - c[0];
    if (k === K - 1) return c[K - 1] - c[K - 2];
    const hPrev = idx[k] - idx[k - 1], hNext = idx[k + 1] - idx[k];
    // 1m あたりの変化
    if (pk && !pin[k + 1]) return (c[k] - c[k - 1]) / hPrev;
    if (pk && !pin[k - 1]) return (c[k + 1] - c[k]) / hNext;
    return (c[k + 1] - c[k - 1]) / (hPrev + hNext);
  };
  const X = new Float64Array(m), Z2 = new Float64Array(m), Hh = new Float64Array(m);
  const tX = cx.map((_, k) => tan(cx, k)), tZ = cz.map((_, k) => tan(cz, k)), tH = ch.map((_, k) => tan(ch, k));
  // 端の点（k = 0, K-1）の接線は1区間の差なので、1m あたりに直す
  for (const k of [0, K - 1]) { const h = k ? idx[K - 1] - idx[K - 2] : idx[1] - idx[0]; tX[k] /= h; tZ[k] /= h; tH[k] /= h; }
  for (let k = 0; k + 1 < K; k++) {
    const i0 = idx[k], i1 = idx[k + 1], h = i1 - i0 || 1;
    for (let i = i0; i <= i1; i++) {
      const u = (i - i0) / h, u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      const herm = (c: number[], t: number[]) => h00 * c[k] + h10 * h * t[k] + h01 * c[k + 1] + h11 * h * t[k + 1];
      X[i] = herm(cx, tX);
      Z2[i] = herm(cz, tZ);
      Hh[i] = herm(ch, tH);
    }
  }
  return { X, Z2, Hh };
}

// (a2·D2ᵀD2 + a3·D3ᵀD3 + diag(w)) x = w t を解く（D2・D3 = 2階・3階差分）。
// 3階差分（曲がり具合の変わり方）を小さくすると、曲がり具合が少しずつ変わる（クロソイドに近い）曲線になる。7重対角の帯つきのガウスの消去法
// 点の間隔 FSTEP に合わせた重み（4m 間隔で FA2 = 0.15、FA3 = 1 と同じなめらかさ）
const FA2 = 0.15 * Math.pow(4 / FSTEP, 4), FA3 = Math.pow(4 / FSTEP, 6), WCAP = 0.6;
function fairSolve(w: number[], t: number[]): number[] {
  const K = t.length, B = 3;
  if (K < 4) return t.slice();
  const A: number[][] = [];
  for (let i = 0; i < K; i++) { const r = new Array(2 * B + 1).fill(0); r[B] = w[i]; A.push(r); }
  const addStencil = (cols: number[], v: number[], a: number) => {
    for (let p = 0; p < cols.length; p++) for (let q = 0; q < cols.length; q++) A[cols[p]][B + cols[q] - cols[p]] += a * v[p] * v[q];
  };
  for (let r = 1; r < K - 1; r++) addStencil([r - 1, r, r + 1], [1, -2, 1], FA2);
  for (let r = 1; r < K - 2; r++) addStencil([r - 1, r, r + 1, r + 2], [-1, 3, -3, 1], FA3);
  const y = t.map((v, i) => v * w[i]);
  for (let i = 0; i < K; i++) {
    const piv = A[i][B];
    for (let j = 1; j <= B && i + j < K; j++) {
      const f = A[i + j][B - j] / piv;
      if (!f) continue;
      for (let c = 0; c <= B; c++) if (i + c < K) A[i + j][B - j + c] -= f * A[i][B + c];
      y[i + j] -= f * y[i];
    }
  }
  const x = new Array<number>(K).fill(0);
  for (let i = K - 1; i >= 0; i--) {
    let sum = y[i];
    for (let c = 1; c <= B && i + c < K; c++) sum -= A[i][B + c] * x[i + c];
    x[i] = sum / A[i][B];
  }
  return x;
}


// 曲線をならす計算は重い（ジャンクション1つで数十 ms）ので、ジャンクションのまわりのマスが変わらないかぎり、前の結果を使う。
// 道路の層・街灯・車の層が同じ盤面で続けて呼ぶので、そのたびに解き直さない。毎月の交通量の更新でも解き直さない
const J_R = 4; // ジャンクションのマスから、形に効くマスの範囲（本線の向き・高さ・つながりを見る）
const jCache = new Map<number, { k1: number; k2: number; n: number; chains: JChain[] }>();
function jctKey(g: Grid): [number, number] {
  const n = g.n, N = n * n;
  let h1 = 2166136261, h2 = 0x9e3779b9;
  const mix = (v: number) => { h1 = Math.imul(h1 ^ v, 16777619); h2 = Math.imul(h2 ^ v, 0x5bd1e995) ^ (h2 >>> 15); };
  const seen = new Uint8Array(N);
  let any = false;
  for (let i = 0; i < N; i++) {
    if (!g.jct[i]) continue;
    any = true;
    const x = i % n, y = (i / n) | 0;
    for (let yy = Math.max(0, y - J_R); yy <= Math.min(n - 1, y + J_R); yy++)
      for (let xx = Math.max(0, x - J_R); xx <= Math.min(n - 1, x + J_R); xx++) seen[yy * n + xx] = 1;
  }
  if (!any) return [0, 0];
  const n1 = n + 1;
  for (let c = 0; c < N; c++) {
    if (!seen[c]) continue;
    const x = c % n, y = (c / n) | 0, v = y * n1 + x;
    mix(c); mix(g.road[c] | (g.up[c] << 8) | (g.jct[c] << 16)); mix(g.conn[c] | (g.conn1[c] << 8) | (g.flow[c] << 16) | (g.flow1[c] << 24));
    mix(Math.round(g.deck[c] * 64)); mix(Math.round(g.lift[c] * 64)); mix(Math.round(g.upH[c] * 64));
    mix(Math.round(g.heights[v] * 64)); mix(Math.round(g.heights[v + 1] * 64)); mix(Math.round(g.heights[v + n1] * 64)); mix(Math.round(g.heights[v + n1 + 1] * 64));
  }
  return [h1 | 1, h2];
}

// 呼ぶ側は、返した鎖を書き換えないこと（同じものを次の呼び出しにも返す）
export function findJctChains(g: Grid, lift: number): JChain[] {
  const [k1, k2] = jctKey(g);
  const hit = jCache.get(lift);
  if (hit && hit.k1 === k1 && hit.k2 === k2 && hit.n === g.n) return hit.chains;
  const chains = k1 === 0 && k2 === 0 ? [] : solveJctChains(g, lift);
  jCache.set(lift, { k1, k2, n: g.n, chains });
  return chains;
}

function solveJctChains(g: Grid, lift: number): JChain[] {
  const n = g.n, N = n * n;
  // ランプのノードと、前後のノード
  const preds = new Map<number, number[]>(), succs = new Map<number, number[]>();
  const J: number[] = [];
  for (let v = 0; v < 2 * N; v++) if (isJ(g, v)) J.push(v);
  if (!J.length) return [];
  const add = (m: Map<number, number[]>, k: number, v: number) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const v of J) {
    g.forEachOut(v, (w) => { add(succs, v, w); add(preds, w, v); });
    // 前のノード（本線から分かれるところ）：まわりのマスの両方の階層から
    const c = v % N, x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (!g.inb(xx, yy)) continue;
      for (const L of [0, 1]) {
        const u = L * N + yy * n + xx;
        if (isJ(g, u)) continue;
        g.forEachOut(u, (w) => { if (w === v) { add(preds, v, u); add(succs, u, v); } });
      }
    }
  }
  const inner = (v: number) => isJ(g, v) && (preds.get(v)?.length ?? 0) === 1 && (succs.get(v)?.length ?? 0) === 1;
  const chains: JChain[] = [];
  const used = new Set<number>();
  // 鎖の始まり：端（本線、または分かれ目・合わさり目のランプ）から、ランプへの1歩
  const startEdges: [number, number][] = [];
  for (const v of J) {
    for (const p of preds.get(v) ?? []) if (!inner(p)) startEdges.push([p, v]);
    // 分かれ目・合わさり目のランプから、そのまま本線へ入る1歩（途中のランプのマスがない鎖）
    if (!inner(v)) for (const w of succs.get(v) ?? []) if (!isJ(g, w)) startEdges.push([v, w]);
  }
  for (const [a, b0] of startEdges) {
    const nodes = [a];
    let b = b0;
    for (let guard = 0; guard < 400; guard++) {
      nodes.push(b);
      if (!inner(b)) break;
      if (used.has(b)) break;
      used.add(b);
      b = succs.get(b)![0];
    }
    if (nodes.length < 2) continue;
    const C = build(g, nodes, lift, preds, succs);
    if (C) chains.push(C);
  }
  // Y字の分かれ目で組になる2本
  const at = new Map<number, [JChain, boolean][]>();
  for (const C of chains) {
    if (C.dead0 && C.main0) (at.get(C.main0.node) ?? at.set(C.main0.node, []).get(C.main0.node)!).push([C, true]);
    if (C.dead1 && C.main1) (at.get(C.main1.node) ?? at.set(C.main1.node, []).get(C.main1.node)!).push([C, false]);
  }
  for (const l of at.values()) if (l.length === 2) limitPair(l[0][0], l[0][1], l[1][0], l[1][1]);
  return chains;
}

function build(g: Grid, nodes: number[], lift: number, preds: Map<number, number[]>, succs: Map<number, number[]>): JChain | null {
  const n = g.n, N = n * n;
  const A = nodes[0], Z = nodes[nodes.length - 1];
  const cen = (v: number): [number, number] => { const c = v % N; return [((c % n) + 0.5) * CELL, (((c / n) | 0) + 0.5) * CELL]; };
  const H = (v: number) => g.nodeH(v) + lift;
  const d0 = dirTo(g, A, nodes[1]), dl = dirTo(g, nodes[nodes.length - 2], Z);
  if (d0 < 0 || dl < 0) return null;
  const mainA = !isJ(g, A), mainZ = !isJ(g, Z);
  // 端の向き：本線なら本線の進む向き（分かれる向きの 45° 左 / 合わさる向きの 45° 右）、分かれ目なら幹の向き
  let tA = (d0 + 7) & 7, tZ = (dl + 1) & 7;
  // 本線の端：本線の進む向き（本線から来る向き・本線へ出ていく向きのうち、ランプの向きと 45° 以内のもの）。
  // T字・Y字の合わさる側の本線の端では、ランプが本線にまっすぐ続くこともある
  const isMainNode = (v: number) => { const t = g.nodeType(v); return t !== RoadType.Ramp && !!ROADS[t]?.highway; };
  const turnAbs = (a: number, b: number) => { const t = (b - a + 8) & 7; return t > 4 ? 8 - t : t; };
  // （まっすぐ続く向きを先に選ぶ）
  if (mainZ) {
    const outs: number[] = [];
    g.forEachOut(Z, (q, d) => { if (isMainNode(q) && turnAbs(dl, d) <= 1) outs.push(d); });
    if (outs.length) tZ = outs.includes(dl) ? dl : outs.includes((dl + 1) & 7) ? (dl + 1) & 7 : outs[0];
  }
  if (mainA) {
    const ins: number[] = [];
    const c = A % N, x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      const px = x - DX[d], py = y - DY[d];
      if (!g.inb(px, py)) continue;
      for (const L of [0, 1]) {
        const p = L * N + py * n + px;
        if (!isMainNode(p) || turnAbs(d, d0) > 1) continue;
        g.forEachOut(p, (q, dd) => { if (q === A && dd === d) ins.push(d); });
      }
    }
    if (ins.length) tA = ins.includes(d0) ? d0 : ins.includes((d0 + 7) & 7) ? (d0 + 7) & 7 : ins[0];
  }
  if (!mainA) { const p = preds.get(A)?.[0]; tA = p !== undefined && (preds.get(A)?.length ?? 0) === 1 ? dirTo(g, p, A) : d0; }
  if (!mainZ) { const s = succs.get(Z)?.[0]; tZ = s !== undefined && (succs.get(Z)?.length ?? 0) === 1 ? dirTo(g, Z, s) : dl; }
  const unit = (d: number): [number, number] => { const l = Math.hypot(DX[d], DY[d]); return [DX[d] / l, DY[d] / l]; };
  const [ax, az] = unit(tA), [zx, zz] = unit(tZ);
  // 本線の端は、ランプの側（右）へ少しずらす
  // 本線がこの端のマスで終わる（T字・Y字の合わさる側の本線の分かれ目：その先・手前がランプ）か
  const endsHere = (v: number, d: number) => {
    const N2 = N, c = v % N2, x = (c % n) + DX[d], y = ((c / n) | 0) + DY[d];
    if (!g.inb(x, y)) return false;
    const j = y * n + x, L = g.arriveLevel(v >= N2 ? 1 : 0, j, d), t2 = L ? g.up[j] : g.road[j];
    const m = v >= N2 ? g.conn1[c] : g.conn[c];
    return !(m & (1 << d)) || t2 === RoadType.Ramp || !ROADS[t2]?.highway;
  };
  const dead0 = mainA && endsHere(A, tA), dead1 = mainZ && endsHere(Z, (tZ + 4) & 7);
  // 本線の端につながるランプが、このランプだけか（Y 字の分かれ目・合わさり目ではない）
  const ramps = (v: number) => (succs.get(v) ?? []).filter((w) => isJ(g, w)).length + (preds.get(v) ?? []).filter((w) => isJ(g, w)).length;
  // （空港の道路だけ。ジャンクションの一方通行の本線の端は、これまでどおり右の車線から分かれる）
  const solo0 = dead0 && ramps(A) === 1 && g.aport[A % N] !== 0, solo1 = dead1 && ramps(Z) === 1 && g.aport[Z % N] !== 0;
  const shift = (v: number, ux: number, uz: number, isMain: boolean, dead: boolean, solo = false): [number, number] => {
    const [x, z] = cen(v);
    if (!isMain) return [x, z];
    const t = g.nodeType(v), half = (ROADS[t]?.width ?? 9) / 2;
    // 分かれ目では、本線の片側の車線の真ん中（2本のランプの内側の縁が、本線の中心で接する）
    const sh = dead ? (solo ? 0 : half / 2) : ROADS[t]?.oneWay ? LANE_SHIFT * 0.6 : LANE_SHIFT;
    return [x - uz * sh, z + ux * sh];
  };
  const pA = shift(A, ax, az, mainA, dead0, solo0), pZ = shift(Z, zx, zz, mainZ, dead1, solo1);
  // 折れ線：前の延長（2マス）、端、途中のマスの中心、端、後ろの延長
  const P: [number, number, number][] = [];
  const hA = H(A), hZ = H(Z);
  // 延長はマスの1歩（斜めは √2 マス）ごと。マスの境（入口・出口）は、車が通るマスの境（斜めはマスの角）と同じ所にする
  for (const k of [2, 1.5, 0.5]) P.push([pA[0] - DX[tA] * CELL * k, pA[1] - DY[tA] * CELL * k, hA]);
  P.push([pA[0], pA[1], hA]);
  for (let i = 1; i < nodes.length - 1; i++) { const [x, z] = cen(nodes[i]); P.push([x, z, H(nodes[i])]); }
  P.push([pZ[0], pZ[1], hZ]);
  for (const k of [0.5, 1.5, 2]) P.push([pZ[0] + DX[tZ] * CELL * k, pZ[1] + DY[tZ] * CELL * k, hZ]);
  // 1m ごとに区切る。元の折れ線の点（端の入口・各ノード・境）の位置を覚えておく
  const xs: number[] = [], zs: number[] = [], hs: number[] = [], at: number[] = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const [x0, z0, h0] = P[i], [x1, z1, h1] = P[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0), m = Math.max(1, Math.round(L));
    at.push(xs.length);
    for (let k = 0; k < m; k++) { const u = k / m; xs.push(x0 + (x1 - x0) * u); zs.push(z0 + (z1 - z0) * u); hs.push(h0 + (h1 - h0) * u); }
  }
  at.push(xs.length);
  xs.push(P[P.length - 1][0]); zs.push(P[P.length - 1][1]); hs.push(P[P.length - 1][2]);
  // 曲がり具合（曲率）がなるべく小さく、少しずつ変わる曲線にする：マスの中心線から ±CORR m の帯の中で、
  // 4m おきの点の「曲がりの変化」を減らすようにくり返し動かす（両端の延長は本線・幹の向きのまま動かさない）。高さも同じ
  // 合わさり目から出ていく幹は、合わさり目のマスの出口まで、分かれ目へ入る幹は、分かれ目のマスの入口から先を動かさない
  // （そのマスは枝の側の曲線で走るので、境の点が枝の曲線と同じ所になるように）
  const joinA = !mainA && (preds.get(A)?.length ?? 0) > 1, forkZ = !mainZ && (succs.get(Z)?.length ?? 0) > 1;
  // 本線の端は、マスの入口（出口）まで動かさない。マスの中では、本線の向きから少しずつ曲がりはじめる（分かれ・合流の始まりがなめらか）
  // （分かれ目のランプも同じ：分かれ目のマスの入口までは幹の向き、マスの中で分かれていく）
  const pinA = joinA ? Math.round((at[3] + at[4]) / 2) : at[2];
  const pinZ = forkZ ? Math.round((at[P.length - 5] + at[P.length - 4]) / 2) : at[P.length - 3];
  // 帯を広げる長さ：Y字の分かれ目は長く、ランプどうしの分かれ目・合わさり目は短く（幹の向きへ、接するように寄っていけるように）
  const forkA = !mainA && (preds.get(A)?.length ?? 0) === 1, joinZ = !mainZ && (succs.get(Z)?.length ?? 0) === 1;
  const { X, Z2, Hh } = fair(xs, zs, hs, pinA, pinZ, dead0 && !solo0 ? DEAD_R : forkA ? 36 : 0, dead1 && !solo1 ? DEAD_R : joinZ ? 36 : 0);
  // 曲線の長さ
  const m = X.length, S = new Float32Array(m);
  for (let k = 1; k < m; k++) S[k] = S[k - 1] + Math.hypot(X[k] - X[k - 1], Z2[k] - Z2[k - 1]);
  // マスの境：端の入口（延長の 0.5 マスの点）、ノードの間の中点、終わりの端の出口
  const bound: number[] = [S[at[2]]];
  for (let i = 3; i < P.length - 4; i++) {
    // P[i] と P[i+1] の中点（元の折れ線の上の区切りの点の真ん中）
    const k = Math.round((at[i] + at[i + 1]) / 2);
    bound.push(S[k]);
  }
  bound.push(S[at[P.length - 3]]);
  const mainOf = (v: number, ux: number, uz: number, sideSign: number): JMain => {
    const [x, z] = cen(v);
    return { node: v, x, z, ux, uz, side: sideSign, half: ROADS[g.nodeType(v)]?.width / 2 || 4.5, h: H(v) };
  };
  const C: JChain = {
    nodes, x: Float32Array.from(X), z: Float32Array.from(Z2), h: Float32Array.from(Hh), s: S, len: S[m - 1], bound,
    tA, tZ,
    main0: mainA ? mainOf(A, ax, az, 1) : null,
    main1: mainZ ? mainOf(Z, zx, zz, 1) : null,
    fork0: mainA ? -1 : A,
    join1: mainZ ? -1 : Z,
    draw0: bound[0], draw1: bound[bound.length - 1], dead0, dead1, solo0, solo1,
  };
  // 始めの端が合わさり目（幹の続き）なら、そのマスは枝の側で描くので、出口から描く。終わりの端が分かれ目なら、入口まで
  if (!mainA && (preds.get(A)?.length ?? 0) > 1) C.draw0 = bound[1];
  if (!mainZ && (succs.get(Z)?.length ?? 0) > 1) C.draw1 = bound[bound.length - 2];
  return C;
}

// 本線の中心線からの横の位置（ランプの側が +）と、本線に沿った位置
export function mainLocal(M: JMain, x: number, z: number) {
  const rx = x - M.x, rz = z - M.z;
  return { a: rx * M.ux + rz * M.uz, o: -rx * M.uz + rz * M.ux };
}

// 車の層：マス（ノード・入る向き・出る向き）ごとの、曲線の上の範囲
export interface JSeg { C: JChain; s0: number; s1: number }
export const jKey = (node: number, din: number, d: number) => node * 64 + din * 8 + d;
export function jctSegs(g: Grid, chains: JChain[]) {
  const m = new Map<number, JSeg>();
  for (const C of chains) {
    const { nodes, bound } = C;
    const last = nodes.length - 1;
    const dirs: number[] = [];
    for (let i = 0; i < last; i++) dirs.push(dirTo(g, nodes[i], nodes[i + 1]));
    // 途中のマス
    for (let i = 1; i < last; i++) {
      const s0 = bound[i], s1 = bound[i + 1];
      m.set(jKey(nodes[i], dirs[i - 1], dirs[i]), { C, s0, s1 });
      // 途中に出てきた車（向きがちがう）も、このマスの範囲
      for (let din = 0; din < 8; din++) for (let d = 0; d < 8; d++) { const k = jKey(nodes[i], din, d); if (!m.has(k)) m.set(k, { C, s0, s1 }); }
    }
    // 始めの端のマス：本線から分かれる、または幹のランプから分かれる枝（合わさり目から出ていく幹は、枝の側で描く）
    const A = nodes[0];
    const aSplit = !isJ(g, A) || C.fork0 >= 0;
    if (aSplit && C.draw0 === bound[0]) {
      const tin = C.main0 ? C.tA : -1;
      if (tin >= 0) m.set(jKey(A, tin, dirs[0]), { C, s0: bound[0], s1: bound[1] });
      else for (let din = 0; din < 8; din++) if (!m.has(jKey(A, din, dirs[0]))) m.set(jKey(A, din, dirs[0]), { C, s0: bound[0], s1: bound[1] });
    }
    const Z = nodes[last];
    if (C.draw1 === bound[bound.length - 1]) {
      const tout = C.main1 ? C.tZ : -1;
      if (tout >= 0) m.set(jKey(Z, dirs[last - 1], tout), { C, s0: bound[last], s1: bound[last + 1] });
      else for (let d = 0; d < 8; d++) if (!m.has(jKey(Z, dirs[last - 1], d))) m.set(jKey(Z, dirs[last - 1], d), { C, s0: bound[last], s1: bound[last + 1] });
    }
  }
  return m;
}
