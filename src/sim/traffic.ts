// 交通シミュレーション
// SC4 と同じく、出発地から目的地まで所要時間が最短の経路を探し、道路ごとの交通量を集計する。
// 住人は建物単位、さらに出発する道路マス単位にまとめて計算する。
// 経路探索のノードは「階層 × マス」（地上と上空）。最後の番号は「隣の都市」。
import { Grid, Ctl, JF } from './grid';
import { CELL, DX, DY, isDiag } from './constants';
import { BUS_WAIT, LINES, LineKind, ROADS, RoadType, isHighway } from './defs';

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

export function assignTrips(
  g: Grid,
  origins: Origin[],
  destAt: Map<number, Destination[]>, // 道路マス（地上）→ そこに面した目的地
  congestion: Float32Array,
  junctions: JunctionModel,
  random: () => number,
  opt: TripOptions,
  transit?: TransitModel,
): TripResult & { modes: ModeStats } {
  const n = g.n, N = n * n, NN = LAYERS * N;
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
  const modes: ModeStats = { car: 0, transit: 0, walk: 0 };
  const useWalk = !opt.carOnly && !!transit;
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
  const lineMask = [null, null, null, null, g.rail, g.erail, g.mono, g.sub] as (Uint8Array | null)[];
  const lineMin = [0, 0, 0, 0, LINES.rail, LINES.erail, LINES.mono, LINES.sub].map((d) => (typeof d === 'number' ? 0 : CELL / ((d.speedKmh * 1000) / 60)));
  const lineWait = [0, 0, 0, 0, LINES.rail.wait, LINES.erail.wait, LINES.mono.wait, LINES.sub.wait];

  let sumTime = 0, sumTrips = 0;
  const relax = (v: number, nt: number, u: number, d: number) => {
    if (stamp[v] !== gen || nt < dist[v]) {
      stamp[v] = gen;
      dist[v] = nt;
      prev[v] = u;
      inDir[v] = d;
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
    // 出発：車（車を持たない人が多いほど、車のコストが高い）と徒歩
    relax(o.cell, START_OVERHEAD_MIN + (o.carPenalty ?? 0), -1, -1);
    if (useWalk && transit!.walkable[o.cell]) relax(LAYER.walk * N + o.cell, 0.5, -1, -1);
    while (heap.size && remaining > 0) {
      const t = heap.topKey();
      const u = heap.pop();
      if (done[u] === gen) continue;
      done[u] = gen;
      if (t > opt.maxMinutes) break;
      const layer = u === EXT ? -1 : Math.floor(u / N);
      const cell = u - layer * N;

      // 目的地の判定（車で着く、または歩いて着く）
      let take = 0;
      if (u === EXT) {
        take = Math.min(remaining, extFree);
        extFree -= take;
        external += take;
      } else if ((layer === 0 || layer === LAYER.walk) && !opt.externalOnly) {
        const list = destAt.get(cell);
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
        // 経路に人数を加え、交通手段を数える
        let c = u === EXT ? prev[EXT] : u;
        const w = take * opt.weight;
        let usedCar = false, usedTransit = false;
        while (c >= 0) {
          volume[c] += w;
          const l = Math.floor(c / N);
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
        g.forEachOut(u, (v, d) => {
          let jd = 0;
          if (u < N && din >= 0 && junctions.ctl[cell]) {
            jd = junctionDelay(g, junctions, cell, din, d);
            if (jd < 0) return;
          } else if (din >= 0 && ((d - din + 8) & 7) === 4) return; // Uターンはしない
          relax(v, t + edgeMinutes(g, u, d, congestion) + jd, u, d);
        });
        if (extFree > 0 && isEdge(cell)) relax(EXT, t + extPenalty(u), u, -1);
        if (transit && u < N) {
          // カーフェリー
          const fl = transit.carLinks.get(u);
          if (fl) for (const [v, m] of fl) relax(v, t + m, u, -1);
          const fe = transit.carToExt.get(u);
          if (fe !== undefined && extFree > 0) relax(EXT, t + fe, u, -1);
        }
        continue;
      }
      const T = transit!;
      const x = cell % n, y = (cell / n) | 0;
      if (layer === LAYER.walk) {
        // 歩く（地上の一般の道路の歩道）
        for (let d = 0; d < 8; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          if (!T.walkable[j] || !(g.conn[cell] & (1 << d))) continue;
          relax(LAYER.walk * N + j, t + (isDiag(d) ? CELL * 1.414 : CELL) / WALK_MPM, u, d);
        }
        if (T.busStop[cell]) relax(LAYER.bus * N + cell, t + BUS_WAIT, u, -1);
        const ferries = T.walkLinks.get(u);
        if (ferries) for (const [v, m] of ferries) relax(v, t + m, u, -1);
        const lines = T.walkToLine.get(u);
        if (lines) for (const ln of lines) relax(ln, t + lineWait[Math.floor(ln / N)], u, -1);
        continue;
      }
      if (layer === LAYER.bus) {
        // バスは車と同じ道路を、少し遅く走る（停留所に止まるため）
        g.forEachOut(cell, (v, d) => {
          if (v >= N) return;
          relax(LAYER.bus * N + v, t + edgeMinutes(g, cell, d, congestion) * 1.35, u, d);
        });
        if (T.busStop[cell]) relax(LAYER.walk * N + cell, t + 0.3, u, -1);
        continue;
      }
      // 鉄道・高架鉄道・モノレール・地下鉄
      const mask = lineMask[layer]![cell];
      for (let d = 0; d < 8; d++) {
        if (!(mask & (1 << d))) continue;
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        relax(layer * N + ny * n + nx, t + lineMin[layer] * (isDiag(d) ? 1.414 : 1), u, d);
      }
      const exits = T.lineToWalk.get(u);
      if (exits) for (const wn of exits) relax(wn, t + 0.5, u, -1);
      // 鉄道・高架鉄道は、マップの端から隣の都市へ行ける
      if (T.railToExt && (layer === LAYER.rail || layer === LAYER.erail) && extFree > 0 && isEdge(cell)) relax(EXT, t + 10, u, -1);
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
