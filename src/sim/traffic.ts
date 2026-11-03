// 通勤の交通シミュレーション
// SC4 と同じく、住宅から職場まで所要時間が最短の経路を探し、道路ごとの交通量を集計する。
// 住人は建物単位、さらに出発する道路マス単位にまとめて計算する。
import { Grid } from './grid';
import { CELL, DX, DY, isDiag } from './constants';
import { ROADS } from './defs';

export const MAX_COMMUTE_MIN = 80;
const EXTERNAL_PENALTY_MIN = 14; // 隣の都市へ行くときの追加時間
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
  cell: number; // 出発する道路マス
  workers: number;
  buildings: { id: number; workers: number }[];
}

export interface Destination {
  id: number;
  free: number;
}

export interface CommuteResult {
  volume: Float32Array; // 道路マスごとの1日の交通量
  employed: Map<number, number>; // 住宅ID → 職のある人数
  commute: Map<number, number>; // 住宅ID → 平均通勤時間（分）
  filled: Map<number, number>; // 職場ID → 働く人数
  externalWorkers: number; // 隣の都市へ通勤する人数
  avgCommute: number;
}

// 道路マスの移動時間（分）。congestion は前回の混雑度（1以上）。
export function edgeMinutes(g: Grid, from: number, d: number, congestion: Float32Array) {
  const def = ROADS[g.road[from]] || ROADS[1];
  const len = isDiag(d) ? CELL * 1.414 : CELL;
  const base = len / ((def.speedKmh * 1000) / 60);
  return base * congestion[from];
}

export function assignCommute(
  g: Grid,
  origins: Origin[],
  jobsAt: Map<number, Destination[]>, // 道路マス → そこに面した職場
  externalJobs: number,
  congestion: Float32Array,
  random: () => number,
): CommuteResult {
  const n = g.n, N = n * n;
  const EXT = N; // 仮想ノード：隣の都市
  const volume = new Float32Array(N);
  const employed = new Map<number, number>();
  const commute = new Map<number, number>();
  const filled = new Map<number, number>();
  const dist = new Float32Array(N + 1);
  const prev = new Int32Array(N + 1);
  const stamp = new Int32Array(N + 1);
  const done = new Int32Array(N + 1);
  const heap = new MinHeap();
  let gen = 0;
  let extFree = externalJobs;
  let externalWorkers = 0;
  // 同じ職場が複数の道路マスに面している場合があるので、空き数は職場単位で共有する
  const freeById = new Map<number, Destination>();
  for (const list of jobsAt.values()) for (const d of list) freeById.set(d.id, d);
  let totalFree = extFree;
  for (const d of freeById.values()) totalFree += d.free;

  // 出発地の順番をランダムにする（公平にするため）
  const order = origins.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const isEdge = (i: number) => {
    const x = i % n, y = (i / n) | 0;
    return x === 0 || y === 0 || x === n - 1 || y === n - 1;
  };

  let sumTime = 0, sumTrips = 0;

  for (const o of order) {
    let remaining = o.workers;
    let got = 0, timeAcc = 0;
    if (remaining <= 0) continue;
    if (totalFree <= 0) {
      for (const b of o.buildings) {
        employed.set(b.id, 0);
        commute.set(b.id, 0);
      }
      continue;
    }
    gen++;
    heap.clear();
    dist[o.cell] = START_OVERHEAD_MIN;
    prev[o.cell] = -1;
    stamp[o.cell] = gen;
    heap.push(START_OVERHEAD_MIN, o.cell);
    while (heap.size && remaining > 0) {
      const t = heap.topKey();
      const u = heap.pop();
      if (done[u] === gen) continue;
      done[u] = gen;
      if (t > MAX_COMMUTE_MIN) break;

      // 目的地の判定
      let take = 0;
      if (u === EXT) {
        take = Math.min(remaining, extFree);
        extFree -= take;
        externalWorkers += take;
      } else {
        const list = jobsAt.get(u);
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
        while (c >= 0) {
          volume[c] += take;
          c = prev[c];
        }
        if (totalFree <= 0) break;
      }
      if (u === EXT) continue;

      // 隣へ広げる
      const m = g.conn[u];
      if (m) {
        const x = u % n, y = (u / n) | 0;
        let deg = 0;
        for (let d = 0; d < 8; d++) if (m & (1 << d)) deg++;
        const junction = deg >= 3 ? 0.12 * congestion[u] : 0;
        for (let d = 0; d < 8; d++) {
          if (!(m & (1 << d))) continue;
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const v = ny * n + nx;
          if (!g.road[v]) continue;
          const nt = t + edgeMinutes(g, u, d, congestion) + junction;
          if (stamp[v] !== gen || nt < dist[v]) {
            stamp[v] = gen;
            dist[v] = nt;
            prev[v] = u;
            heap.push(nt, v);
          }
        }
      }
      if (extFree > 0 && isEdge(u)) {
        const nt = t + EXTERNAL_PENALTY_MIN;
        if (stamp[EXT] !== gen || nt < dist[EXT]) {
          stamp[EXT] = gen;
          dist[EXT] = nt;
          prev[EXT] = u;
          heap.push(nt, EXT);
        }
      }
    }
    // 建物ごとに配分
    const ratio = o.workers > 0 ? got / o.workers : 0;
    const avg = got > 0 ? timeAcc / got : 0;
    for (const b of o.buildings) {
      employed.set(b.id, b.workers * ratio);
      commute.set(b.id, avg);
    }
    sumTime += timeAcc;
    sumTrips += got;
  }
  return { volume, employed, commute, filled, externalWorkers, avgCommute: sumTrips ? sumTime / sumTrips : 0 };
}

// 混雑度（BPR 関数）
export function congestionFactor(volume: number, capacity: number) {
  const r = volume / capacity;
  return Math.min(8, 1 + 0.15 * r * r * r * r);
}
