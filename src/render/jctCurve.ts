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
  draw0: number; // 描く範囲（s）
  draw1: number;
}
export interface JMain { node: number; x: number; z: number; ux: number; uz: number; side: number; half: number; h: number }
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
const FSTEP = 4; // ならすときの点の間隔（m）

// 曲率の変化が小さい曲線（自然なスプラインに近い）を、帯の中で求める。pinA..pinZ の外（延長と端の点）は動かさない
function fair(xs: number[], zs: number[], hs: number[], pinA: number, pinZ: number) {
  const m = xs.length;
  const idx: number[] = [];
  for (let i = 0; i < m; i += FSTEP) idx.push(i);
  if (idx[idx.length - 1] !== m - 1) idx.push(m - 1);
  for (const q of [pinA, pinZ]) if (!idx.includes(q)) idx.push(q);
  idx.sort((a, b) => a - b);
  const K = idx.length;
  const ox = idx.map((i) => xs[i]), oz = idx.map((i) => zs[i]), oh = idx.map((i) => hs[i]);
  const pin = idx.map((i) => i <= pinA || i >= pinZ);
  // はじめは少しならした形から
  const g = (a: number[], sig: number) => Array.from(smooth(Float64Array.from(a), sig, true));
  const cx = g(ox, 2), cz = g(oz, 2), ch = g(oh, 3);
  for (let k = 0; k < K; k++) if (pin[k]) { cx[k] = ox[k]; cz[k] = oz[k]; ch[k] = oh[k]; }
  // 4階差分（曲がりの変化）を小さくする。ガウス・ザイデル法で、毎回帯の中へ戻す
  const lam = 0.12;
  for (let it = 0; it < 900; it++) {
    for (let k = 2; k < K - 2; k++) {
      if (pin[k]) continue;
      const fx = cx[k - 2] - 4 * cx[k - 1] + 6 * cx[k] - 4 * cx[k + 1] + cx[k + 2];
      const fz = cz[k - 2] - 4 * cz[k - 1] + 6 * cz[k] - 4 * cz[k + 1] + cz[k + 2];
      const fh = ch[k - 2] - 4 * ch[k - 1] + 6 * ch[k] - 4 * ch[k + 1] + ch[k + 2];
      cx[k] -= lam * fx;
      cz[k] -= lam * fz;
      ch[k] -= lam * fh;
      const dx = cx[k] - ox[k], dz = cz[k] - oz[k], d = Math.hypot(dx, dz);
      if (d > CORR) { cx[k] = ox[k] + (dx * CORR) / d; cz[k] = oz[k] + (dz * CORR) / d; }
      ch[k] = Math.max(oh[k] - H_CORR, Math.min(oh[k] + H_CORR, ch[k]));
    }
  }
  // 1m ごとの点へ（Catmull-Rom）
  const X = new Float64Array(m), Z2 = new Float64Array(m), Hh = new Float64Array(m);
  for (let k = 0; k + 1 < K; k++) {
    const i0 = idx[k], i1 = idx[k + 1];
    const a = Math.max(0, k - 1), b = Math.min(K - 1, k + 2);
    for (let i = i0; i <= i1; i++) {
      const u = (i - i0) / (i1 - i0 || 1), u2 = u * u, u3 = u2 * u;
      const cr = (p0: number, p1: number, p2: number, p3: number) => 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
      X[i] = cr(cx[a], cx[k], cx[k + 1], cx[b]);
      Z2[i] = cr(cz[a], cz[k], cz[k + 1], cz[b]);
      Hh[i] = cr(ch[a], ch[k], ch[k + 1], ch[b]);
    }
  }
  return { X, Z2, Hh };
}

function smooth(a: Float64Array, sig: number, fixedEnds: boolean) {
  const m = a.length, out = new Float64Array(m), W = Math.ceil(sig * 3);
  const wt: number[] = [];
  for (let k = -W; k <= W; k++) wt.push(Math.exp((-k * k) / (2 * sig * sig)));
  for (let i = 0; i < m; i++) {
    let s = 0, ws = 0;
    for (let k = -W; k <= W; k++) {
      const j = i + k;
      if (j < 0 || j >= m) continue;
      s += a[j] * wt[k + W];
      ws += wt[k + W];
    }
    out[i] = s / ws;
  }
  if (fixedEnds) { out[0] = a[0]; out[m - 1] = a[m - 1]; }
  return out;
}

export function findJctChains(g: Grid, lift: number): JChain[] {
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
  if (!mainA) { const p = preds.get(A)?.[0]; tA = p !== undefined && (preds.get(A)?.length ?? 0) === 1 ? dirTo(g, p, A) : d0; }
  if (!mainZ) { const s = succs.get(Z)?.[0]; tZ = s !== undefined && (succs.get(Z)?.length ?? 0) === 1 ? dirTo(g, Z, s) : dl; }
  const unit = (d: number): [number, number] => { const l = Math.hypot(DX[d], DY[d]); return [DX[d] / l, DY[d] / l]; };
  const [ax, az] = unit(tA), [zx, zz] = unit(tZ);
  // 本線の端は、ランプの側（右）へ少しずらす
  const shift = (v: number, ux: number, uz: number, isMain: boolean): [number, number] => {
    const [x, z] = cen(v);
    if (!isMain) return [x, z];
    const t = g.nodeType(v), sh = ROADS[t]?.oneWay ? LANE_SHIFT * 0.6 : LANE_SHIFT;
    return [x - uz * sh, z + ux * sh];
  };
  const pA = shift(A, ax, az, mainA), pZ = shift(Z, zx, zz, mainZ);
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
  const pinA = joinA ? Math.round((at[3] + at[4]) / 2) : at[3];
  const pinZ = forkZ ? Math.round((at[P.length - 5] + at[P.length - 4]) / 2) : at[P.length - 4];
  const { X, Z2, Hh } = fair(xs, zs, hs, pinA, pinZ);
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
    main0: mainA ? mainOf(A, ax, az, 1) : null,
    main1: mainZ ? mainOf(Z, zx, zz, 1) : null,
    fork0: mainA ? -1 : A,
    join1: mainZ ? -1 : Z,
    draw0: bound[0], draw1: bound[bound.length - 1],
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
      const tin = C.main0 ? (dirs[0] + 7) & 7 : -1;
      if (tin >= 0) m.set(jKey(A, tin, dirs[0]), { C, s0: bound[0], s1: bound[1] });
      else for (let din = 0; din < 8; din++) if (!m.has(jKey(A, din, dirs[0]))) m.set(jKey(A, din, dirs[0]), { C, s0: bound[0], s1: bound[1] });
    }
    const Z = nodes[last];
    if (C.draw1 === bound[bound.length - 1]) {
      const tout = C.main1 ? (dirs[last - 1] + 1) & 7 : -1;
      if (tout >= 0) m.set(jKey(Z, dirs[last - 1], tout), { C, s0: bound[last], s1: bound[last + 1] });
      else for (let d = 0; d < 8; d++) if (!m.has(jKey(Z, dirs[last - 1], d))) m.set(jKey(Z, dirs[last - 1], d), { C, s0: bound[last], s1: bound[last + 1] });
    }
  }
  return m;
}
