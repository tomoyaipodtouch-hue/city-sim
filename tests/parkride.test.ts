// パーク&ライド（駅まで車で行き、電車に乗りかえる）と、混雑・駐車のコスト
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType, ZoneType } from '../src/sim/defs';
import { assignTrips, buildJunctions, buildRoadGraph, buildTransitModel, LAYER, Origin, parkingMinutes, perceivedCongestion } from '../src/sim/traffic';

// 東西にまっすぐな街路（y=10, x=2..60）と、その北を並んで走る鉄道（y=8, x=30..58）。
// 駅は西 (30,9)・東 (58,9) で、どちらも街路と線路に接する
function corridor() {
  const w = new World(64);
  w.g.heights.fill(10);
  w.funds = 1e8;
  w.sandbox = true;
  const ok = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) throw new Error(`${c.t}: ${r.msg}`);
  };
  ok({ t: 'road', x0: 2, y0: 10, x1: 60, y1: 10, road: RoadType.Street });
  ok({ t: 'transit', x0: 30, y0: 8, x1: 58, y1: 8, kind: 'rail' });
  const g = w.g, N = g.n * g.n;
  const stations = [
    { kind: 'rail' as const, roadCells: [g.idx(30, 10)], lineCells: [g.idx(30, 8)] },
    { kind: 'rail' as const, roadCells: [g.idx(58, 10)], lineCells: [g.idx(58, 8)] },
  ];
  const J = buildJunctions(g, new Float32Array(2 * N));
  const dest = g.idx(58, 10);
  const run = (o: { carPenalty?: number; cong?: number; carArrive?: number; parkRide?: boolean; transit?: boolean }) => {
    const cong = new Float32Array(2 * N).fill(1);
    // 駅より東の街路だけ混む
    if (o.cong) for (let x = 31; x <= 60; x++) cong[g.idx(x, 10)] = o.cong;
    const carArrive = new Float32Array(N);
    if (o.carArrive) carArrive[dest] = o.carArrive;
    const origin: Origin = { cell: g.idx(2, 10), trips: 100, carPenalty: o.carPenalty ?? 0, buildings: [{ id: 9, trips: 100 }] };
    const tm = o.transit === false ? undefined : buildTransitModel(g, stations);
    return assignTrips(g, [origin], new Map([[dest, [{ id: 1, free: 100 }]]]), cong, J, () => 0.5,
      { externalCap: 0, maxMinutes: 80, weight: 1, parkRide: o.parkRide ?? true, carArrive }, tm, buildRoadGraph(g, cong, J));
  };
  return { g, N, run };
}

describe('park & ride', () => {
  it('drivers stay in their car on a free road', () => {
    const { run } = corridor();
    const r = run({});
    expect(r.filled.get(1)).toBe(100);
    expect(r.modes.car).toBe(100);
    expect(r.modes.parkRide).toBe(0);
  });

  it('on a congested road, drivers park at the station and take the train', () => {
    const { g, N, run } = corridor();
    const r = run({ cong: 6 });
    expect(r.filled.get(1)).toBe(100);
    expect(r.modes.transit).toBe(100);
    expect(r.modes.parkRide).toBe(100);
    expect(r.modes.car).toBe(0);
    // 車の交通量は駅まで（駅より東の街路には車が来ない）。電車には乗客がいる
    expect(r.volume[g.idx(10, 10)]).toBe(100);
    expect(r.volume[g.idx(30, 10)]).toBe(100);
    expect(r.volume[g.idx(40, 10)]).toBe(0);
    expect(r.volume[LAYER.rail * N + g.idx(44, 8)]).toBe(100);
    // パーク&ライドを使えない（買い物・貨物）なら、混んでいても車のまま
    const r2 = run({ cong: 6, parkRide: false });
    expect(r2.modes.car).toBe(100);
    expect(r2.modes.parkRide).toBe(0);
  });

  it('people without a car cannot park & ride', () => {
    const { g, run } = corridor();
    const r = run({ cong: 6, carPenalty: 999 });
    expect(r.modes.parkRide).toBe(0);
    expect(r.modes.car).toBe(0);
    // 駅まで歩いて電車に乗る
    expect(r.modes.transit).toBe(100);
    expect(r.volume[g.idx(10, 10)]).toBe(0);
  });

  it('parking cost at a dense destination moves drivers to transit', () => {
    const { run } = corridor();
    expect(run({ carArrive: 0 }).modes.car).toBe(100);
    const r = run({ carArrive: parkingMinutes(2, 1) });
    expect(r.modes.car).toBe(0);
    expect(r.modes.parkRide).toBe(100);
    // 公共交通がなければ、駐車に時間がかかっても車で行く
    const r2 = run({ carArrive: parkingMinutes(2, 1), transit: false });
    expect(r2.modes.car).toBe(100);
    expect(r2.avgTime).toBeGreaterThan(run({ transit: false }).avgTime + 9);
  });

  it('parking takes longer in the high-rise core; heavy congestion feels worse than it is', () => {
    expect(parkingMinutes(0, 0)).toBeLessThan(parkingMinutes(1, 0));
    expect(parkingMinutes(1, 0)).toBeLessThan(parkingMinutes(2, 0));
    expect(parkingMinutes(2, 1)).toBeGreaterThanOrEqual(8);
    expect(perceivedCongestion(1.2)).toBe(1);
    expect(perceivedCongestion(4)).toBeGreaterThan(1.5);
    expect(perceivedCongestion(8)).toBeLessThanOrEqual(1.8);
  });
});

// 高層ビル街（オフィスと高層住宅）と、西に離れた郊外の住宅地。車の道路は南を大きく遠回りし、鉄道はまっすぐ結ぶ
function suburbCity(stations: boolean) {
  const w = new World(128);
  w.g.heights.fill(10);
  w.funds = 1e8;
  w.sandbox = true;
  const ok = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) throw new Error(`${c.t}: ${r.msg}`);
  };
  const ox = 80, oy = 12;
  for (let k = 0; k <= 36; k += 6) ok({ t: 'road', x0: ox + k, y0: oy, x1: ox + k, y1: oy + 36, road: k % 12 ? RoadType.Street : RoadType.Avenue });
  for (let k = 0; k <= 36; k += 6) ok({ t: 'road', x0: ox, y0: oy + k, x1: ox + 36, y1: oy + k, road: RoadType.Road });
  ok({ t: 'zone', x0: ox + 1, y0: oy + 1, x1: ox + 35, y1: oy + 16, zone: ZoneType.C, den: 2 });
  ok({ t: 'zone', x0: ox + 1, y0: oy + 19, x1: ox + 23, y1: oy + 35, zone: ZoneType.R, den: 2 });
  ok({ t: 'zone', x0: ox + 25, y0: oy + 19, x1: ox + 35, y1: oy + 35, zone: ZoneType.I, den: 1 });
  // 郊外
  for (let k = 0; k <= 24; k += 4) ok({ t: 'road', x0: 4, y0: 12 + k, x1: 28, y1: 12 + k, road: RoadType.Street });
  for (let k = 0; k <= 24; k += 4) ok({ t: 'road', x0: 4 + k, y0: 12, x1: 4 + k, y1: 36, road: RoadType.Street });
  ok({ t: 'zone', x0: 5, y0: 13, x1: 27, y1: 35, zone: ZoneType.R, den: 1 });
  // 遠回りの道路
  ok({ t: 'road', x0: 16, y0: 36, x1: 16, y1: 110, road: RoadType.Road });
  ok({ t: 'road', x0: 16, y0: 110, x1: 98, y1: 110, road: RoadType.Road });
  ok({ t: 'road', x0: 98, y0: 110, x1: 98, y1: oy + 36, road: RoadType.Road });
  // 鉄道（郊外の駅は住宅地から少し離れていて、歩くと遠い）
  ok({ t: 'road', x0: 28, y0: 12, x1: 42, y1: 12, road: RoadType.Street });
  ok({ t: 'transit', x0: 30, y0: 9, x1: 110, y1: 9, kind: 'rail' });
  if (stations) {
    ok({ t: 'plop', id: 'station', x: 40, y: 10 });
    ok({ t: 'plop', id: 'station', x: 98, y: 10 });
  }
  for (const [x, y] of [[ox - 6, oy + 2], [ox - 6, oy + 26]]) ok({ t: 'plop', id: 'coal', x, y });
  ok({ t: 'pline', x0: ox - 3, y0: oy + 4, x1: ox + 1, y1: oy + 4 });
  ok({ t: 'pline', x0: ox - 3, y0: oy + 28, x1: ox + 1, y1: oy + 28 });
  ok({ t: 'pline', x0: 28, y0: 30, x1: ox - 6, y1: 30 });
  for (let k = 0; k < 6; k++) ok({ t: 'plop', id: 'pump', x: ox + 1 + k * 6, y: oy + 37 });
  return w;
}

describe('park & ride in a city', () => {
  it('suburban commuters drive to the station and ride into the core', { timeout: 120000 }, () => {
    const avg = (stations: boolean) => {
      const w = suburbCity(stations);
      const sum = { car: 0, transit: 0, walk: 0, parkRide: 0 };
      let k = 0;
      for (let m = 1; m <= 36; m++) {
        for (let d = 0; d < 30; d++) w.stepDay();
        if (m <= 6) continue;
        const s = w.modeShare;
        sum.car += s.car; sum.transit += s.transit; sum.walk += s.walk; sum.parkRide += s.parkRide ?? 0;
        k++;
      }
      return { car: sum.car / k, transit: sum.transit / k, walk: sum.walk / k, parkRide: sum.parkRide / k, pop: w.stats.population };
    };
    const without = avg(false), withSt = avg(true);
    console.log(`park&ride city: without stations ${JSON.stringify(without)} / with stations ${JSON.stringify(withSt)}`);
    expect(without.parkRide).toBe(0);
    expect(withSt.pop).toBeGreaterThan(4000);
    expect(withSt.parkRide).toBeGreaterThan(0.02);
    expect(withSt.transit).toBeGreaterThan(without.transit + 0.05);
    expect(withSt.car).toBeLessThan(without.car);
  });
});
