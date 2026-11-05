// 交通シミュレーション
// SC4 と同じく、出発地から目的地まで所要時間が最短の経路を探し、道路ごとの交通量を集計する。
// 住人は建物単位、さらに出発する道路マス単位にまとめて計算する。
// 経路探索のノードは「階層 × マス」（地上と上空）。最後の番号は「隣の都市」。
import { Grid, Ctl, JF } from './grid';
import { CELL, DX, DY, isDiag } from './constants';
import { BUS_WAIT, LINES, LineKind, ROADS, RoadType, isHighway } from './defs';

const START_OVERHEAD_MIN = 2; // 家を出て駐車場まで等

// 型付き配列の二分ヒープ（キー = 時刻、値 = ノード）
class MinHeap {
  keys = new Float64Array(1024);
  vals = new Int32Array(1024);
  size = 0;
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2), nv = new Int32Array(this.size * 2);
      nk.set(this.keys);
      nv.set(this.vals);
      this.keys = nk;
      this.vals = nv;
    }
    const ks = this.keys, vs = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= k) break;
      ks[i] = ks[p];
      vs[i] = vs[p];
      i = p;
    }
    ks[i] = k;
    vs[i] = v;
  }
  pop(): number {
    const ks = this.keys, vs = this.vals;
    const top = vs[0];
    const n = --this.size;
    if (n > 0) {
      const lk = ks[n], lv = vs[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && ks[c + 1] < ks[c]) c++;
        if (ks[c] >= lk) break;
        ks[i] = ks[c];
        vs[i] = vs[c];
        i = c;
      }
      ks[i] = lk;
      vs[i] = lv;
    }
    return top;
  }
  topKey() {
    return this.keys[0];
  }
  clear() {
    this.size = 0;
  }
}

export interface Origin {
  cell: number; // 出発する道路マス（地上）
  trips: number;
  carPenalty?: number; // 車を使う場合に加える時間（分）。車を持たない人の割合を表す
  buildings: { id: number; trips: number }[];
}

export interface Destination {
  id: number;
  free: number;
}

export interface TripResult {
  volume: Float32Array; // ノードごとの1日の交通量
  served: Map<number, number>; // 出発する建物ID → 目的地に着けた数
  time: Map<number, number>; // 出発する建物ID → 平均所要時間（分）
  filled: Map<number, number>; // 目的地ID → 受け入れた数
  external: number; // 隣の都市へ行った数
  avgTime: number;
}

// ---------------- 交差点 ----------------
export interface JunctionModel {
  ctl: Uint8Array; // 実際に使う制御方式（自動の場合は交通量で決める）
  load: Float32Array; // 交差点の混み具合（交通量 / 交差点の容量）
  deg: Uint8Array;
}

const NODE_CAP: Record<number, number> = {
  [Ctl.None]: 2600,
  [Ctl.Stop]: 2000,
  [Ctl.Signal]: 5200,
  [Ctl.Roundabout]: 4200,
};

// 自動のときの制御方式：交通量が少なければ信号なし、多くなると一時停止、さらに多いと信号
export function autoCtl(vol: number, deg: number, roadType: number) {
  if (deg < 3) return Ctl.None;
  if (vol < 900) return Ctl.None;
  if (vol < 2600 && roadType <= RoadType.Road) return Ctl.Stop;
  return Ctl.Signal;
}

export function buildJunctions(g: Grid, traffic: Float32Array): JunctionModel {
  const N = g.n * g.n;
  const ctl = new Uint8Array(N), load = new Float32Array(N), deg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const m = g.conn[i];
    if (!m || isHighway(g.road[i]) || g.road[i] === RoadType.Ramp) continue;
    let d = 0;
    for (let k = 0; k < 8; k++) if (m & (1 << k)) d++;
    deg[i] = d;
    if (d < 3) continue;
    const c = g.ictl[i] === Ctl.Auto ? autoCtl(traffic[i], d, g.road[i]) : g.ictl[i];
    ctl[i] = c;
    const lanes = g.iflags[i] & (JF.leftLane | JF.rightLane) ? 1.25 : 1;
    load[i] = traffic[i] / ((NODE_CAP[c] ?? 2600) * lanes);
  }
  return { ctl, load, deg };
}

// 曲がり方：0 = 直進, 1 = 右折, 2 = 左折, 3 = Uターン（右側通行、y が下向きの座標）
export function turnKind(din: number, dout: number) {
  const diff = (dout - din + 8) & 7;
  if (diff === 0 || diff === 1 || diff === 7) return diff === 0 ? 0 : diff === 1 ? 1 : 2;
  if (diff === 4) return 3;
  return diff < 4 ? 1 : 2;
}

// 交差点の待ち時間（分）。通れない場合は -1。
export function junctionDelay(g: Grid, j: JunctionModel, cell: number, din: number, dout: number): number {
  const c = j.ctl[cell];
  if (!c) return 0;
  const f = g.iflags[cell];
  const turn = turnKind(din, dout);
  if (turn === 3) return -1;
  if (f & JF.straightOnly && turn !== 0) return -1;
  if (f & JF.noLeft && turn === 2) return -1;
  if (f & JF.noRight && turn === 1) return -1;
  const x = Math.min(0.95, j.load[cell]);
  let delay: number;
  switch (c) {
    case Ctl.Signal: {
      // 進入する向きの青の割合
      const ew = din === 0 || din === 4 ? 1 : din === 2 || din === 6 ? 0 : 0.5;
      const split = g.isplit[cell] / 100;
      const green = Math.max(0.1, ew * split + (1 - ew) * (1 - split));
      const cycle = 1.5;
      delay = (0.5 * cycle * (1 - green) * (1 - green)) / (1 - x * green) + 0.05;
      break;
    }
    case Ctl.Stop:
      delay = 0.15 + 0.8 * x * x;
      break;
    case Ctl.Roundabout:
      delay = 0.06 + 0.6 * x * x * x;
      break;
    default:
      delay = 0.03 + 1.6 * x * x * x;
  }
  // 曲がる車は遅くなる。専用レーンがあれば緩和される
  if (turn === 2) delay *= f & JF.leftLane ? 0.7 : 1.6;
  else if (turn === 1) delay *= f & JF.rightLane ? 0.6 : 1.15;
  return delay;
}

// 道路の移動時間（分）
export function edgeMinutes(g: Grid, from: number, d: number, congestion: Float32Array) {
  const def = ROADS[g.nodeType(from)] || ROADS[1];
  const len = isDiag(d) ? CELL * 1.414 : CELL;
  const base = len / ((def.speedKmh * 1000) / 60);
  return base * congestion[from];
}

export interface TripOptions {
  externalCap: number; // 隣の都市で受け入れられる数
  externalOnly?: boolean; // 目的地は隣の都市だけ（貨物）
  carOnly?: boolean; // 車だけ（貨物）
  maxMinutes: number;
  weight: number; // 交通量に加えるときの重み（トラックは大きい）
}

// ---------------- 公共交通 ----------------
// ノード番号の並び：
//   0..N-1 車（地上）, N..2N-1 車（上空）, 2N 徒歩, 3N バス, 4N 鉄道, 5N 高架鉄道, 6N モノレール, 7N 地下鉄
export const LAYER = { walk: 2, bus: 3, rail: 4, erail: 5, mono: 6, sub: 7 } as const;
export const LINE_LAYER: Record<LineKind, number> = { rail: 4, erail: 5, mono: 6, sub: 7 };
export const LAYERS = 8;
// 歩く速さ（m/分）。実際は 80m/分 くらいだが、人は長く歩くのを嫌うので、半分の速さとして扱う
const WALK_MPM = 40;
const WALK_MAX_MIN = 15; // 1回に歩く時間の上限（体感、分）。600m くらい

export interface TransitModel {
  walkable: Uint8Array; // 歩ける道路のマス（地上の一般の道路）
  busStop: Uint8Array; // バスに乗り降りできる道路のマス
  // 駅：道路のマス（徒歩）⇔ 線路のマス（各線）
  walkToLine: Map<number, number[]>; // 徒歩のノード → 線のノード
  lineToWalk: Map<number, number[]>; // 線のノード → 徒歩のノード
  any: boolean; // 公共交通が1つでもあるか
  walkLinks: Map<number, [number, number][]>; // 旅客フェリー：徒歩のノード → [徒歩のノード, 分]
  carLinks: Map<number, [number, number][]>; // カーフェリー：車のノード → [車のノード, 分]
  carToExt: Map<number, number>; // カーフェリーで隣の都市へ：車のノード → 分
  railToExt: boolean; // 鉄道・高架鉄道がマップの端から隣の都市へ行ける
}

export function buildTransitModel(
  g: Grid,
  stations: { kind: 'bus' | LineKind; roadCells: number[]; lineCells: number[] }[],
): TransitModel {
  const N = g.n * g.n;
  const walkable = new Uint8Array(N), busStop = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = g.road[i];
    if (t && !isHighway(t) && t !== RoadType.Ramp) walkable[i] = 1;
  }
  const walkToLine = new Map<number, number[]>(), lineToWalk = new Map<number, number[]>();
  for (const st of stations) {
    if (st.kind === 'bus') {
      for (const c of st.roadCells) busStop[c] = 1;
      continue;
    }
    const L = LINE_LAYER[st.kind];
    for (const r of st.roadCells) {
      const wn = LAYER.walk * N + r;
      for (const c of st.lineCells) {
        const ln = L * N + c;
        (walkToLine.get(wn) ?? walkToLine.set(wn, []).get(wn)!).push(ln);
        (lineToWalk.get(ln) ?? lineToWalk.set(ln, []).get(ln)!).push(wn);
      }
    }
  }
  return { walkable, busStop, walkToLine, lineToWalk, any: stations.length > 0, walkLinks: new Map(), carLinks: new Map(), carToExt: new Map(), railToExt: true };
}

export interface ModeStats {
  car: number;
  transit: number;
  walk: number;
}

// 車の道路網を、探索しやすい形（隣のノードと所要時間の一覧）にまとめたもの。
// 混雑度と交差点はひと月の間は変わらないので、通勤・買い物・貨物の計算で使い回す。
export interface RoadGraph {
  off: Int32Array; // ノード v の行き先は off[v] .. off[v+1]-1
  to: Int32Array;
  dir: Int8Array;
  min: Float32Array; // 道路の移動時間（分）
  jslot: Int32Array; // 交差点のマス → 待ち時間の表の番号（-1 = 交差点ではない）
  jdel: Float32Array; // [slot*64 + 入ってきた向き*8 + 出ていく向き] の待ち時間（-1 = 通れない）
  edge: Uint8Array; // マップの端のマス
  urban: Uint8Array; // 都市高速（片側1車線）のノード：中央線をまたぐ右左折はできない
  extPen: Float32Array; // 隣の都市へ出るときの時間（ノードごと）
}

export function buildRoadGraph(g: Grid, congestion: Float32Array, junctions: JunctionModel): RoadGraph {
  const n = g.n, N = n * n, M = 2 * N;
  const off = new Int32Array(M + 1);
  const tmpTo: number[] = [], tmpDir: number[] = [], tmpMin: number[] = [];
  for (let u = 0; u < M; u++) {
    off[u] = tmpTo.length;
    if (!g.nodeType(u)) continue;
    g.forEachOut(u, (v, d) => {
      tmpTo.push(v);
      tmpDir.push(d);
      tmpMin.push(edgeMinutes(g, u, d, congestion));
    });
  }
  off[M] = tmpTo.length;
  const jslot = new Int32Array(N).fill(-1);
  const cells: number[] = [];
  for (let i = 0; i < N; i++) if (junctions.ctl[i]) { jslot[i] = cells.length; cells.push(i); }
  const jdel = new Float32Array(cells.length * 64);
  for (let k = 0; k < cells.length; k++)
    for (let din = 0; din < 8; din++) for (let dout = 0; dout < 8; dout++) jdel[k * 64 + din * 8 + dout] = junctionDelay(g, junctions, cells[k], din, dout);
  const edge = new Uint8Array(N);
  for (let k = 0; k < n; k++) edge[k] = edge[(n - 1) * n + k] = edge[k * n] = edge[k * n + n - 1] = 1;
  const extPen = new Float32Array(M);
  for (let v = 0; v < M; v++) extPen[v] = isHighway(g.nodeType(v)) ? 6 : 14;
  const urban = new Uint8Array(M);
  for (let v = 0; v < M; v++) urban[v] = isUrbanHighway(g.nodeType(v)) ? 1 : 0;
  return { off, to: Int32Array.from(tmpTo), dir: Int8Array.from(tmpDir), min: Float32Array.from(tmpMin), jslot, jdel, edge, extPen, urban };
}

// 探索に使う作業用の配列（毎回作り直さない）
let work: { size: number; dist: Float32Array; prev: Int32Array; inDir: Int8Array; walkFrom: Float32Array; stamp: Int32Array; done: Int32Array; gen: number } | null = null;
const heap = new MinHeap();
function getWork(size: number) {
  if (!work || work.size !== size)
    work = { size, dist: new Float32Array(size), prev: new Int32Array(size), inDir: new Int8Array(size), walkFrom: new Float32Array(size), stamp: new Int32Array(size), done: new Int32Array(size), gen: 0 };
  return work;
}

export function assignTrips(
  g: Grid,
  origins: Origin[],
  destAt: Map<number, Destination[]>, // 道路マス（地上）→ そこに面した目的地
  congestion: Float32Array,
  junctions: JunctionModel,
  random: () => number,
  opt: TripOptions,
  transit?: TransitModel,
  graph?: RoadGraph,
): TripResult & { modes: ModeStats } {
  const n = g.n, N = n * n, NN = LAYERS * N;
  const EXT = NN;
  const G = graph ?? buildRoadGraph(g, congestion, junctions);
  const { off, to, dir, min: emin, jslot, jdel } = G;
  const volume = new Float32Array(NN);
  const served = new Map<number, number>();
  const time = new Map<number, number>();
  const filled = new Map<number, number>();
  const W = getWork(NN + 1);
  const { dist, prev, inDir, walkFrom, stamp, done } = W;
  const modes: ModeStats = { car: 0, transit: 0, walk: 0 };
  const useWalk = !opt.carOnly && !!transit;
  let extFree = opt.externalCap;
  let external = 0;
  // 同じ目的地が複数の道路マスに面している場合があるので、空き数は目的地単位で共有する。
  // マス → 目的地の一覧 を配列で引けるようにする
  const freeById = new Map<number, Destination>();
  const destIdx = new Int32Array(N).fill(-1);
  const destLists: Destination[][] = [];
  if (!opt.externalOnly) {
    for (const list of destAt.values()) for (const d of list) if (!freeById.has(d.id)) freeById.set(d.id, { id: d.id, free: d.free });
    for (const [cell, list] of destAt) {
      destIdx[cell] = destLists.length;
      destLists.push(list.map((d) => freeById.get(d.id)!));
    }
  }
  let totalFree = extFree;
  for (const d of freeById.values()) totalFree += d.free;

  // 出発地の順番をランダムにする（公平にするため）
  const order = origins.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const { edge, extPen, urban } = G;
  const lineMask = [null, null, null, null, g.rail, g.erail, g.mono, g.sub] as (Uint8Array | null)[];
  const lineMin = [0, 0, 0, 0, LINES.rail, LINES.erail, LINES.mono, LINES.sub].map((d) => (typeof d === 'number' ? 0 : CELL / ((d.speedKmh * 1000) / 60)));
  const lineWait = [0, 0, 0, 0, LINES.rail.wait, LINES.erail.wait, LINES.mono.wait, LINES.sub.wait];
  const conn = g.conn;
  const WALK_ORTHO = CELL / WALK_MPM, WALK_DIAG = (CELL * 1.414) / WALK_MPM;
  const WALK = LAYER.walk * N, BUS = LAYER.bus * N;

  let gen = W.gen;
  let sumTime = 0, sumTrips = 0;
  const relax = (v: number, nt: number, u: number, d: number, wf: number) => {
    if (stamp[v] !== gen || nt < dist[v]) {
      stamp[v] = gen;
      dist[v] = nt;
      prev[v] = u;
      inDir[v] = d;
      walkFrom[v] = wf;
      heap.push(nt, v);
    }
  };

  for (const o of order) {
    let remaining = o.trips;
    let got = 0, timeAcc = 0;
    if (remaining <= 0) continue;
    if (totalFree <= 0) {
      for (const b of o.buildings) {
        if (!served.has(b.id)) served.set(b.id, 0);
        if (!time.has(b.id)) time.set(b.id, 0);
      }
      continue;
    }
    gen++;
    heap.clear();
    // 車を持たない人は、公共交通がない街では歩いて行ける範囲（30分）だけを探す（計算を軽くするため）
    const maxMin = (o.carPenalty ?? 0) >= 999 && !(transit?.any || transit?.walkLinks.size) ? Math.min(30, opt.maxMinutes) : opt.maxMinutes;
    // 出発：車（車を持たない人が多いほど、車のコストが高い）と徒歩
    const carStart = START_OVERHEAD_MIN + (o.carPenalty ?? 0);
    if (carStart <= maxMin) relax(o.cell, carStart, -1, -1, 0);
    if (useWalk && transit!.walkable[o.cell]) relax(WALK + o.cell, 0.5, -1, -1, 0);
    while (heap.size && remaining > 0) {
      const t = heap.topKey();
      const u = heap.pop();
      if (done[u] === gen) continue;
      done[u] = gen;
      if (t > maxMin) break;
      const layer = u === EXT ? -1 : (u / N) | 0;
      const cell = u - layer * N;

      // 目的地の判定（車で着く、または歩いて着く）
      let take = 0;
      if (u === EXT) {
        take = Math.min(remaining, extFree);
        extFree -= take;
        external += take;
      } else if ((layer === 0 || layer === LAYER.walk) && destIdx[cell] >= 0) {
        for (const dd of destLists[destIdx[cell]]) {
          if (dd.free <= 0) continue;
          const k = Math.min(remaining - take, dd.free);
          dd.free -= k;
          take += k;
          filled.set(dd.id, (filled.get(dd.id) || 0) + k);
          if (take >= remaining) break;
        }
      }
      if (take > 0) {
        remaining -= take;
        totalFree -= take;
        got += take;
        timeAcc += take * t;
        // 経路に人数を加え、交通手段を数える
        let c = u === EXT ? prev[EXT] : u;
        const w = take * opt.weight;
        let usedCar = false, usedTransit = false;
        while (c >= 0) {
          volume[c] += w;
          const l = (c / N) | 0;
          if (l <= 1) usedCar = true;
          else if (l >= LAYER.bus) usedTransit = true;
          c = prev[c];
        }
        if (usedTransit) modes.transit += take;
        else if (usedCar) modes.car += take;
        else modes.walk += take;
        if (totalFree <= 0) break;
      }
      if (u === EXT) continue;

      if (layer <= 1) {
        // 車
        const din = inDir[u];
        const js = layer === 0 && din >= 0 ? jslot[cell] : -1;
        for (let e = off[u], e1 = off[u + 1]; e < e1; e++) {
          const d = dir[e];
          let jd = 0;
          if (js >= 0) {
            jd = jdel[js * 64 + din * 8 + d];
            if (jd < 0) continue;
          } else if (din >= 0 && ((d - din + 8) & 7) === 4) continue; // Uターンはしない
          else if (urban[u] && !urbanTurnOk(din, d)) continue;
          relax(to[e], t + emin[e] + jd, u, d, 0);
        }
        if (extFree > 0 && edge[cell]) relax(EXT, t + extPen[u], u, -1, 0);
        if (transit && u < N) {
          // カーフェリー
          const fl = transit.carLinks.size ? transit.carLinks.get(u) : undefined;
          if (fl) for (const [v, m] of fl) relax(v, t + m, u, -1, 0);
          const fe = transit.carToExt.size ? transit.carToExt.get(u) : undefined;
          if (fe !== undefined && extFree > 0) relax(EXT, t + fe, u, -1, 0);
        }
        continue;
      }
      const T = transit!;
      if (layer === LAYER.walk) {
        // 歩く（地上の一般の道路の歩道）。1回に歩くのは体感で15分まで
        const wf = walkFrom[u];
        if (t - wf < WALK_MAX_MIN) {
          const x = cell % n, y = (cell / n) | 0, m = conn[cell];
          for (let d = 0; d < 8; d++) {
            if (!(m & (1 << d))) continue;
            const nx = x + DX[d], ny = y + DY[d];
            if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
            const j = ny * n + nx;
            if (!T.walkable[j]) continue;
            relax(WALK + j, t + (d & 1 ? WALK_DIAG : WALK_ORTHO), u, d, wf);
          }
        }
        if (T.busStop[cell]) relax(BUS + cell, t + BUS_WAIT, u, -1, 0);
        if (T.walkLinks.size) {
          const ferries = T.walkLinks.get(u);
          if (ferries) for (const [v, m] of ferries) relax(v, t + m, u, -1, t + m);
        }
        if (T.walkToLine.size) {
          const lines = T.walkToLine.get(u);
          if (lines) for (const ln of lines) relax(ln, t + lineWait[(ln / N) | 0], u, -1, 0);
        }
        continue;
      }
      if (layer === LAYER.bus) {
        // バスは車と同じ道路を、少し遅く走る（停留所に止まるため）
        for (let e = off[cell], e1 = off[cell + 1]; e < e1; e++) {
          const v = to[e];
          if (v >= N) continue;
          relax(BUS + v, t + emin[e] * 1.35, u, dir[e], 0);
        }
        if (T.busStop[cell]) relax(WALK + cell, t + 0.3, u, -1, t + 0.3);
        continue;
      }
      // 鉄道・高架鉄道・モノレール・地下鉄
      const mask = lineMask[layer]![cell];
      const x = cell % n, y = (cell / n) | 0;
      for (let d = 0; d < 8; d++) {
        if (!(mask & (1 << d))) continue;
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        relax(layer * N + ny * n + nx, t + lineMin[layer] * (d & 1 ? 1.414 : 1), u, d, 0);
      }
      const exits = T.lineToWalk.get(u);
      if (exits) for (const wn of exits) relax(wn, t + 0.5, u, -1, t + 0.5);
      // 鉄道・高架鉄道は、マップの端から隣の都市へ行ける
      if (T.railToExt && (layer === LAYER.rail || layer === LAYER.erail) && extFree > 0 && edge[cell]) relax(EXT, t + 10, u, -1, 0);
    }
    // 建物ごとに配分（同じ建物が複数の出発グループに入ることがあるので足し合わせる）
    const ratio = o.trips > 0 ? got / o.trips : 0;
    const avg = got > 0 ? timeAcc / got : 0;
    for (const b of o.buildings) {
      const k = b.trips * ratio;
      served.set(b.id, (served.get(b.id) || 0) + k);
      time.set(b.id, (time.get(b.id) || 0) + k * avg);
    }
    sumTime += timeAcc;
    sumTrips += got;
  }
  W.gen = gen;
  // 所要時間は、人数で重みをつけた平均にする
  for (const [id, sum] of time) {
    const k = served.get(id) || 0;
    time.set(id, k > 0 ? sum / k : 0);
  }
  return { volume, served, time, filled, external, avgTime: sumTrips ? sumTime / sumTrips : 0, modes };
}

// 混雑度（BPR 関数）
export function congestionFactor(volume: number, capacity: number) {
  const r = volume / capacity;
  return Math.min(8, 1 + 0.15 * r * r * r * r);
}

export const isUrbanHighway = (t: number) => t === RoadType.UrbanHighway || t === RoadType.UrbanGroundHighway;
// 都市高速の上では、ランプ（斜め）への出入りは左側の車線からの右折だけ（右側通行：中央線をまたがない）
export function urbanTurnOk(din: number, d: number) {
  if (din < 0 || (!(din & 1) && !(d & 1))) return true;
  return turnKind(din, d) === 1;
}
