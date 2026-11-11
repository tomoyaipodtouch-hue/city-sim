// 貨物（トラック）：幹線道路・高速道路を通り、街路を避ける。荷物の量は街の大きさにあう。港・貨物駅があれば、マップの端へ走るトラックが減る
import { describe, expect, it } from 'vitest';
import { World, BState, FREIGHT_LONG, freightTrips } from '../src/sim/world';
import { addPort, freightCity, growFreightCity } from './helpers';
import { GROW, GrowKind, RoadType, ZoneType } from '../src/sim/defs';
import { assignTrips, buildJunctions, buildRoadGraph, TRUCK_PCE } from '../src/sim/traffic';

describe('trucks prefer arterials', () => {
  // 64×64 の平らな土地。出発地 (16,32) から西のマップの端へ：
  // 近道は街路（y = 32、16 マス）、遠回りは一般道で北へ 22 マス進んで大通り（y = 10）
  const map = () => {
    const w = new World(64);
    w.g.heights.fill(8);
    w.funds = 1e9;
    const ok = (c: Parameters<World['exec']>[0]) => expect(w.exec(c).ok).toBe(true);
    ok({ t: 'road', x0: 0, y0: 32, x1: 16, y1: 32, road: RoadType.Street });
    ok({ t: 'road', x0: 16, y0: 10, x1: 16, y1: 32, road: RoadType.Road });
    ok({ t: 'road', x0: 0, y0: 10, x1: 16, y1: 10, road: RoadType.Avenue });
    return w;
  };
  const route = (truck: boolean) => {
    const w = map(), g = w.g, N = g.n * g.n;
    const cong = new Float32Array(2 * N).fill(1);
    const jn = buildJunctions(g, new Float32Array(2 * N));
    const r = assignTrips(g, [{ cell: g.idx(16, 32), trips: 100, buildings: [{ id: 1, trips: 100 }] }], new Map(), cong, jn, () => 0.5,
      { externalCap: 1e9, externalOnly: true, carOnly: true, maxMinutes: 90, weight: 1, truck }, undefined, buildRoadGraph(g, cong, jn));
    // 大通りは y = 9, 10 の 2 マス幅
    return { street: r.volume[g.idx(8, 32)], avenue: r.volume[g.idx(8, 9)] + r.volume[g.idx(8, 10)], served: r.served.get(1) ?? 0, time: r.avgTime };
  };

  it('cars take the short street, trucks take the avenue', () => {
    const car = route(false), truck = route(true);
    console.log('car', car, 'truck', truck);
    expect(car.street).toBe(100);
    expect(car.avenue).toBe(0);
    expect(truck.street).toBe(0);
    expect(truck.avenue).toBe(100);
    expect(truck.served).toBe(100);
    // 輸送時間は実際の時間（街路の重みは経路を選ぶときだけ）：遠回りの分だけ長いが、重みをかけた時間ではない
    expect(truck.time).toBeGreaterThan(car.time);
    expect(truck.time).toBeLessThan(car.time * 2);
  });
});

let grown: World | null = null;
const city = () => (grown ??= (() => { const w = freightCity(null); growFreightCity(w, 900); return w; })());

describe('freight volume', () => {
  it('stays within a realistic range for the city size', { timeout: 300000 }, () => {
    const w = city(), g = w.g, n = g.n, N = n * n, M = w.maps;
    const ind = [...w.buildings.values()].filter((b) => !b.civic && b.state === BState.Normal && GROW[b.type as GrowKind].zone === ZoneType.I);
    const jobs = ind.reduce((a, b) => a + b.occ, 0);
    expect(ind.length).toBeGreaterThan(20);
    // 1日のトラックは、工業の雇用 1 人あたり 0.05〜0.2 台
    const perJob = w.tripStats.trucks / Math.max(1, jobs);
    // 道路の種類と面している土地ごとの、トラックの台数の割合（貨物の交通量は乗用車換算なので台数に直す）
    const share = (pick: (x: number, y: number, t: number) => boolean) => {
      let tr = 0, fr = 0;
      for (let i = 0; i < N; i++) {
        const t = g.road[i], x = i % n, y = (i / n) | 0;
        if (!t || !pick(x, y, t)) continue;
        tr += M.traffic[i];
        fr += M.freight[i];
      }
      const trucks = fr / TRUCK_PCE;
      return trucks / Math.max(1, tr - fr + trucks);
    };
    const indRoads = share((x, y, t) => x >= 52 && x <= 68 && t !== RoadType.Street);
    const resStreets = share((x, y, t) => x >= 3 && x <= 43 && y > 10 && y < 58 && t === RoadType.Street);
    const served = ind.reduce((a, b) => a + (b.freight ?? 1), 0) / ind.length;
    console.log(`freight: ${w.tripStats.trucks} trucks/day for ${jobs} industrial jobs (${perJob.toFixed(3)}/job), truck share: industrial arterials ${(indRoads * 100).toFixed(1)}%, residential streets ${(resStreets * 100).toFixed(1)}%, served ${served.toFixed(3)}, edge-bound ${w.tripStats.truckExt}`);
    expect(perJob).toBeGreaterThan(0.05);
    expect(perJob).toBeLessThan(0.2);
    expect(indRoads).toBeGreaterThan(0.1);
    expect(indRoads).toBeLessThan(0.35);
    expect(resStreets).toBeLessThan(0.05);
    // 荷物はこれまでどおり運べている
    expect(served).toBeGreaterThan(0.85);
    // 1台あたりの荷物の数え方は建物の種類ごと（倉庫業がいちばん多い）
    expect(freightTrips({ type: 'IL', occ: 100 })).toBeGreaterThan(freightTrips({ type: 'IM', occ: 100 }));
  });

  for (const port of ['seaport', 'freight_st'] as const)
    it(`a ${port} takes long-distance freight off the roads to the map edge`, { timeout: 300000 }, () => {
      // 同じ街で、港・貨物駅を置く前と後の1か月をくらべる
      const w = World.load(city().serialize());
      for (let d = 0; d < 30; d++) w.stepDay();
      const before = { ...w.tripStats };
      const wp = World.load(city().serialize());
      addPort(wp, port);
      for (let d = 0; d < 30; d++) wp.stepDay();
      const after = { ...wp.tripStats };
      console.log(`${port}: edge-bound trucks ${before.truckExt}/${before.trucks} → ${after.truckExt}/${after.trucks}, freight time ${before.freight} → ${after.freight} min`);
      expect(before.truckExt).toBeGreaterThan(before.trucks * 0.95);
      // 遠くへの荷物（FREIGHT_LONG）は港・貨物駅へ。近くの都市への荷物だけがマップの端へ
      expect(after.truckExt).toBeLessThan(after.trucks * (1 - FREIGHT_LONG) + 5);
      expect(after.truckExt).toBeGreaterThan(after.trucks * (1 - FREIGHT_LONG) * 0.8);
      // 荷物はこれまでどおり運べていて、輸送時間は短くなる
      const ind = [...wp.buildings.values()].filter((b) => !b.civic && b.state === BState.Normal && GROW[b.type as GrowKind].zone === ZoneType.I);
      expect(ind.reduce((a, b) => a + (b.freight ?? 1), 0) / ind.length).toBeGreaterThan(0.85);
      expect(after.freight).toBeLessThan(before.freight);
    });
});
