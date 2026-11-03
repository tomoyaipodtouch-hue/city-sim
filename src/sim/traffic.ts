// 交通シミュレーション
// SC4 と同じく、出発地から目的地まで所要時間が最短の経路を探し、道路ごとの交通量を集計する。
// 住人は建物単位、さらに出発する道路マス単位にまとめて計算する。
// 経路探索のノードは「階層 × マス」（地上と上空）。最後の番号は「隣の都市」。
import { Grid, Ctl, JF } from './grid';
import { CELL, isDiag } from './constants';
import { ROADS, RoadType, isHighway } from './defs';

const START_OVERHEAD_MIN = 2; // 家を出て駐車場まで等

class MinHeap {
  keys: number[] = [];
  vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, v: number) {
    const ks = this.keys, vs = this.vals;
    let i = ks.length;
    ks.push(k);
    vs.push(v);
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
    const lk = ks.pop()!, lv = vs.pop()!;
    const n = ks.length;
    if (n > 0) {
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
    this.keys.length = 0;
    this.vals.length = 0;
  }
}

export interface Origin {
  cell: number; // 出発する道路マス（地上）
  trips: number;
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
    if (!m || isHighway(g.road[i])) continue;
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
  maxMinutes: number;
  weight: number; // 交通量に加えるときの重み（トラックは大きい）
}

export function assignTrips(
  g: Grid,
  origins: Origin[],
  destAt: Map<number, Destination[]>, // 道路マス（地上）→ そこに面した目的地
  congestion: Float32Array,
  junctions: JunctionModel,
  random: () => number,
  opt: TripOptions,
): TripResult {
  const n = g.n, N = n * n, NN = 2 * N;
  const EXT = NN;
  const volume = new Float32Array(NN);
  const served = new Map<number, number>();
  const time = new Map<number, number>();
  const filled = new Map<number, number>();
  const dist = new Float32Array(NN + 1);
  const prev = new Int32Array(NN + 1);
  const inDir = new Int8Array(NN + 1);
  const stamp = new Int32Array(NN + 1);
  const done = new Int32Array(NN + 1);
  const heap = new MinHeap();
  let gen = 0;
  let extFree = opt.externalCap;
  let external = 0;
  // 同じ目的地が複数の道路マスに面している場合があるので、空き数は目的地単位で共有する
  const freeById = new Map<number, Destination>();
  if (!opt.externalOnly) for (const list of destAt.values()) for (const d of list) freeById.set(d.id, d);
  let totalFree = extFree;
  for (const d of freeById.values()) totalFree += d.free;

  // 出発地の順番をランダムにする（公平にするため）
  const order = origins.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const isEdge = (c: number) => {
    const x = c % n, y = (c / n) | 0;
    return x === 0 || y === 0 || x === n - 1 || y === n - 1;
  };
  const extPenalty = (node: number) => (isHighway(g.nodeType(node)) ? 6 : 14);

  let sumTime = 0, sumTrips = 0;

  for (const o of order) {
    let remaining = o.trips;
    let got = 0, timeAcc = 0;
    if (remaining <= 0) continue;
    if (totalFree <= 0) {
      for (const b of o.buildings) {
        served.set(b.id, 0);
        time.set(b.id, 0);
      }
      continue;
    }
    gen++;
    heap.clear();
    dist[o.cell] = START_OVERHEAD_MIN;
    prev[o.cell] = -1;
    inDir[o.cell] = -1;
    stamp[o.cell] = gen;
    heap.push(START_OVERHEAD_MIN, o.cell);
    while (heap.size && remaining > 0) {
      const t = heap.topKey();
      const u = heap.pop();
      if (done[u] === gen) continue;
      done[u] = gen;
      if (t > opt.maxMinutes) break;

      // 目的地の判定
      let take = 0;
      if (u === EXT) {
        take = Math.min(remaining, extFree);
        extFree -= take;
        external += take;
      } else if (u < N && !opt.externalOnly) {
        const list = destAt.get(u);
        if (list) {
          for (const d of list) {
            const dd = freeById.get(d.id)!;
            if (dd.free <= 0) continue;
            const k = Math.min(remaining - take, dd.free);
            dd.free -= k;
            take += k;
            filled.set(d.id, (filled.get(d.id) || 0) + k);
            if (take >= remaining) break;
          }
        }
      }
      if (take > 0) {
        remaining -= take;
        totalFree -= take;
        got += take;
        timeAcc += take * t;
        // 経路に交通量を加える
        let c = u === EXT ? prev[EXT] : u;
        const w = take * opt.weight;
        while (c >= 0) {
          volume[c] += w;
          c = prev[c];
        }
        if (totalFree <= 0) break;
      }
      if (u === EXT) continue;

      // 隣へ広げる
      const cell = u >= N ? u - N : u;
      const din = inDir[u];
      g.forEachOut(u, (v, d) => {
        let jd = 0;
        if (u < N && din >= 0 && junctions.ctl[cell]) {
          jd = junctionDelay(g, junctions, cell, din, d);
          if (jd < 0) return;
        } else if (din >= 0 && ((d - din + 8) & 7) === 4) return; // Uターンはしない
        const nt = t + edgeMinutes(g, u, d, congestion) + jd;
        if (stamp[v] !== gen || nt < dist[v]) {
          stamp[v] = gen;
          dist[v] = nt;
          prev[v] = u;
          inDir[v] = d;
          heap.push(nt, v);
        }
      });
      if (extFree > 0 && isEdge(cell)) {
        const nt = t + extPenalty(u);
        if (stamp[EXT] !== gen || nt < dist[EXT]) {
          stamp[EXT] = gen;
          dist[EXT] = nt;
          prev[EXT] = u;
          heap.push(nt, EXT);
        }
      }
    }
    // 建物ごとに配分
    const ratio = o.trips > 0 ? got / o.trips : 0;
    const avg = got > 0 ? timeAcc / got : 0;
    for (const b of o.buildings) {
      served.set(b.id, b.trips * ratio);
      time.set(b.id, avg);
    }
    sumTime += timeAcc;
    sumTrips += got;
  }
  return { volume, served, time, filled, external, avgTime: sumTrips ? sumTime / sumTrips : 0 };
}

// 混雑度（BPR 関数）
export function congestionFactor(volume: number, capacity: number) {
  const r = volume / capacity;
  return Math.min(8, 1 + 0.15 * r * r * r * r);
}
