// 高速鉄道：線路を引く（カーブ・急な曲がり）、駅（ターミナル駅・中間駅・折り返し）、隣の都市からの乗客、街の中の移動、
// 乗り換え、運賃、騒音と防音壁、保存と読み込み、取り壊しの階層
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { CIVIC, HSR_FARE, HSR_THROUGH_COST, LINES, RoadType, ZoneType } from '../src/sim/defs';
import { CELL } from '../src/sim/constants';
import { planLine, planTransitLine, planBulldoze, normRect, planZone } from '../src/sim/plan';
import {
  hsrDeckH,
  HSRF_COVER, HSRF_GROUND, HSRF_STATION, HSR_MSG_SHARP, HSR_MSG_SHORT, HSR_T, hsrBarrier, hsrChains, hsrNoise, hsrPoly, hsrRoutes, planHsrStation,
} from '../src/sim/hsr';
import { HsrOps, HSR_DWELL, trainLen } from '../src/sim/hsrOps';
import { HSR_NOISE_LV } from '../src/sim/world';
import { assignTrips, buildJunctions, buildRoadGraph, LAYER, Origin } from '../src/sim/traffic';
import { checkHwRail, HWH_CLEAR, levelHighwaysOverRail } from '../src/sim/hwrail';

type Cmd = Parameters<World['exec']>[0];
function flat(n = 96, h = 6) {
  const w = new World(n);
  w.g.heights.fill(h);
  w.funds = 1e9;
  return w;
}
const ok = (w: World, c: Cmd) => {
  const r = w.exec(c);
  expect(r.ok, `${JSON.stringify(c)}: ${r.msg}`).toBe(true);
  return r;
};
const fail = (w: World, c: Cmd) => {
  const r = w.exec(c);
  expect(r.ok, JSON.stringify(c)).toBe(false);
  return r.msg ?? '';
};
const hsrLine = (w: World, x0: number, y0: number, x1: number, y1: number, ground = false): Cmd => ({ t: 'transit', x0, y0, x1, y1, kind: 'hsr', ...(ground ? { ground: true } : {}) });
const stations = (w: World) => [...w.buildings.values()].filter((b) => b.type === 'hsr_station');

// 東西の線路（y = 40）の途中と端に駅。駅の南の長い辺に道路
function lineWithStations(opts: { toEdge: boolean; through: boolean }) {
  const w = flat();
  ok(w, hsrLine(w, opts.toEdge ? 0 : 6, 40, 80, 40));
  // 駅の南（y = 43）に道路。駅の線路は駅の 2 列目（row 1）なので、駅は y = 39..42
  ok(w, { t: 'road', x0: 60, y0: 43, x1: 92, y1: 43, road: RoadType.Road });
  ok(w, { t: 'plop', id: 'hsr_station', x: 76, y: 40 }); // 線路の端（x = 80）にかかる：ターミナル駅
  if (opts.through) {
    ok(w, { t: 'road', x0: 20, y0: 43, x1: 50, y1: 43, road: RoadType.Road });
    ok(w, { t: 'plop', id: 'hsr_station', x: 36, y: 40 }); // 線路の途中：中間駅
  }
  return w;
}

describe('HSR track drawing', () => {
  it('draws a straight elevated line like other lines, at about 3x the elevated-rail cost', () => {
    const w = flat();
    const funds = w.funds;
    const r = ok(w, hsrLine(w, 10, 20, 60, 20));
    expect(LINES.hsr.cost).toBeCloseTo(LINES.erail.cost * 3, 5);
    expect(r.cost).toBe(51 * LINES.hsr.cost);
    expect(funds - w.funds).toBe(r.cost);
    const g = w.g;
    expect(g.hsr[g.idx(30, 20)]).toBe((1 << 0) | (1 << 4));
    expect(g.hsrf[g.idx(30, 20)] & HSRF_GROUND).toBe(0);
  });

  it('smooths a 45° bend into a large-radius curve and keeps buildings out of the curve', () => {
    const w = flat();
    // 東へ 20 マス、そこから南東へ 14 マス（planLine は直線 → 斜めの順）
    ok(w, hsrLine(w, 10, 20, 44, 34));
    const g = w.g;
    const ch = hsrChains(g);
    expect(ch.length).toBe(1);
    const P = hsrPoly(g, ch[0].cells);
    // 曲線の部分がある。点ごとの向きの変わり方は小さく（なめらか）、曲がりの半径は大きい
    expect([...P.arc].some((a) => a === 1)).toBe(true);
    let maxTurn = 0, minR = Infinity;
    for (let k = 1; k + 1 < P.n; k++) {
      const ax = P.x[k] - P.x[k - 1], az = P.z[k] - P.z[k - 1], bx = P.x[k + 1] - P.x[k], bz = P.z[k + 1] - P.z[k];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
      maxTurn = Math.max(maxTurn, turn);
      if (turn > 1e-4) minR = Math.min(minR, ((la + lb) / 2) / turn);
    }
    expect(maxTurn).toBeLessThan((6 * Math.PI) / 180);
    expect(minR).toBeGreaterThan(150);
    // 全体で 45° 曲がる
    const a0 = Math.atan2(P.z[1] - P.z[0], P.x[1] - P.x[0]), a1 = Math.atan2(P.z[P.n - 1] - P.z[P.n - 2], P.x[P.n - 1] - P.x[P.n - 2]);
    expect(a1 - a0).toBeCloseTo(Math.PI / 4, 2);
    // カーブの内側のマスには印がつき、ゾーンや建物を置けない
    const cover = [...g.hsrf.keys()].filter((i) => g.hsrf[i] & HSRF_COVER);
    expect(cover.length).toBeGreaterThan(0);
    const c = cover[0];
    const z = planZone(g, normRect(c % g.n, (c / g.n) | 0, c % g.n, (c / g.n) | 0, g.n), ZoneType.R, 0);
    expect(z.cells.length).toBe(0);
  });

  it('refuses sharp (90°) turns and bends that are too close together, with a reason', () => {
    const w = flat();
    ok(w, hsrLine(w, 10, 20, 40, 20));
    // 線路の端から直角に曲がる
    expect(fail(w, hsrLine(w, 40, 20, 40, 50))).toBe(HSR_MSG_SHARP);
    // 曲がったあとのまっすぐな区間が短すぎる（斜め 20 マス → 東 2 マス）
    const w2 = flat();
    const msg = fail(w2, hsrLine(w2, 10, 10, 32, 30));
    expect(msg).toBe(HSR_MSG_SHORT);
    // プレビューの計画も同じ理由
    const p = planTransitLine(w2.g, planLine(w2.g, 10, 10, 32, 30), 'hsr');
    expect(p.ok).toBe(false);
    expect(p.reason).toBe(HSR_MSG_SHORT);
    // 接線の長さは 5 マス
    expect(HSR_T).toBe(5 * CELL);
  });

  it('ground track only outside town and never across roads', () => {
    const w = flat();
    ok(w, hsrLine(w, 5, 10, 60, 10, true));
    expect(w.g.hsrf[w.g.idx(20, 10)] & HSRF_GROUND).toBe(HSRF_GROUND);
    ok(w, { t: 'road', x0: 30, y0: 30, x1: 30, y1: 60, road: RoadType.Road });
    expect(fail(w, hsrLine(w, 5, 40, 60, 40, true))).toMatch(/道路/);
    ok(w, { t: 'zone', x0: 40, y0: 50, x1: 50, y1: 55, zone: ZoneType.R, den: 0 });
    expect(fail(w, hsrLine(w, 35, 52, 60, 52, true))).toMatch(/街の外/);
    // 高架なら道路の上も、街の中も引ける
    ok(w, hsrLine(w, 5, 40, 60, 40));
    // 道路は地上の高速鉄道を横切れない
    expect(fail(w, { t: 'road', x0: 20, y0: 5, x1: 20, y1: 15, road: RoadType.Road })).toMatch(/高速鉄道/);
  });

  it('an elevated highway raised over elevated rail climbs over a nearby HSR viaduct (both orders)', () => {
    // 高架鉄道（y = 40）をまたぐ都市高速（x = 40）。そのすぐ横（y = 44）に高速鉄道の高架：高速道路は両方の上を越え、間でへこまない
    const check = (w: ReturnType<typeof flat>) => {
      const g = w.g;
      const h = (y: number) => g.upH[g.idx(40, y)];
      expect(h(44) - hsrDeckH(g, g.idx(40, 44))).toBeGreaterThanOrEqual(HWH_CLEAR - 1e-6);
      for (let y = 40; y < 44; y++) expect(h(y + 1)).toBeGreaterThanOrEqual(h(y) - 1e-6);
      expect(levelHighwaysOverRail(g)).toEqual([]);
      const before = Array.from(g.upH);
      levelHighwaysOverRail(g);
      expect(Array.from(g.upH)).toEqual(before);
    };
    const w = flat();
    ok(w, { t: 'transit', x0: 5, y0: 40, x1: 80, y1: 40, kind: 'erail' });
    ok(w, hsrLine(w, 5, 44, 80, 44));
    ok(w, { t: 'road', x0: 40, y0: 5, x1: 40, y1: 85, road: RoadType.UrbanHighway });
    check(w);
    // 逆の順：持ち上がった都市高速の上にも高速鉄道を通せる（高速道路をさらに持ち上げる）
    const w2 = flat();
    ok(w2, { t: 'transit', x0: 5, y0: 40, x1: 80, y1: 40, kind: 'erail' });
    ok(w2, { t: 'road', x0: 40, y0: 5, x1: 40, y1: 85, road: RoadType.UrbanHighway });
    ok(w2, hsrLine(w2, 5, 44, 80, 44));
    check(w2);
    // 坂から離れた所では、高速道路は高速鉄道の高架の下をくぐる（そのままの高さ）
    const h70 = w2.g.upH[w2.g.idx(40, 70)];
    ok(w2, hsrLine(w2, 5, 70, 80, 70));
    expect(w2.g.upH[w2.g.idx(40, 70)]).toBe(h70);
    expect(checkHwRail(w2.g, new Set()).ok).toBe(true);
  });
});

describe('HSR stations', () => {
  it('a station at the line end is a terminal (§300,000), mid-line a through station (§100,000)', () => {
    const w = flat();
    ok(w, hsrLine(w, 0, 40, 80, 40));
    ok(w, { t: 'road', x0: 20, y0: 43, x1: 92, y1: 43, road: RoadType.Road });
    const f0 = w.funds;
    const t = ok(w, { t: 'plop', id: 'hsr_station', x: 76, y: 40 });
    expect(t.cost).toBe(CIVIC.hsr_station.cost);
    expect(f0 - w.funds).toBe(300000);
    const f1 = w.funds;
    const m = ok(w, { t: 'plop', id: 'hsr_station', x: 36, y: 40 });
    expect(m.cost).toBe(HSR_THROUGH_COST);
    expect(f1 - w.funds).toBe(100000);
    const [a, b] = stations(w).sort((p, q) => p.x - q.x);
    expect(a.hsr!.out).toEqual([true, true]);
    expect(b.hsr!.out.filter(Boolean).length).toBe(1);
    expect(a.note).toMatch(/中間駅/);
    expect(b.note).toMatch(/ターミナル駅/);
    // 駅は 14×4。線路は駅の端から端まで（ターミナル駅は線路を駅の奥まで延ばす）
    expect(b.w * b.h).toBe(56);
    const g = w.g;
    for (let x = b.x; x < b.x + b.w; x++) expect(g.hsrf[g.idx(x, 40)] & HSRF_STATION).toBe(HSRF_STATION);
    expect(g.hsr[g.idx(b.x + b.w - 1, 40)]).toBe(1 << 4); // 行き止まり（車止め）
    // 駅の向きは線路で決まる（回せない）
    expect(w.exec({ t: 'rotate', id: a.id }).ok).toBe(false);
  });

  it('needs straight HSR track and a road', () => {
    const w = flat();
    expect(planHsrStation(w.g, 40, 40).ok).toBe(false);
    ok(w, hsrLine(w, 0, 40, 80, 40));
    const p = planHsrStation(w.g, 40, 40);
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/道路/);
  });

  it('trains reverse at terminals; at a through station local trains stop and express trains pass', () => {
    const w = lineWithStations({ toEdge: true, through: true });
    const ops = new HsrOps();
    const N = w.g.n * w.g.n;
    ops.build(w.g, stations(w), new Float32Array(N).fill(3000));
    expect(ops.routes.length).toBe(1);
    const r = ops.routes[0];
    expect(r.endA).toBe('edge');
    expect(r.endB).toBe('end');
    expect(r.stops.map((s) => s.term)).toEqual([false, true]);
    expect(ops.trains.length).toBeGreaterThanOrEqual(2);
    // 6〜8 両（8 両 = 約 204m で、224m のホームに収まる）
    for (const t of ops.trains) expect(t.cars).toBeGreaterThanOrEqual(6), expect(t.cars).toBeLessThanOrEqual(8);
    expect(trainLen(8)).toBeLessThanOrEqual(14 * CELL);
    const seen = new Map<number, { reversed: boolean; stoppedMid: boolean; passedMid: boolean; express: boolean }>();
    const mid = r.stops[0];
    let outside = 0;
    for (let k = 0; k < 20 * 60 * 10; k++) {
      const before = new Map(ops.trains.map((t) => [t.id, t.dir]));
      ops.step(0.1);
      for (const t of ops.trains) {
        const e = seen.get(t.id) ?? { reversed: false, stoppedMid: false, passedMid: false, express: t.express };
        if (before.has(t.id) && before.get(t.id) !== t.dir) e.reversed = true;
        const inMid = t.s - (t.dir * trainLen(t.cars)) / 2 > mid.s0 && t.s - (t.dir * trainLen(t.cars)) / 2 < mid.s1;
        if (inMid && t.dwell > 0) e.stoppedMid = true;
        // 止まっている列車は、先頭も最後尾もホームの中
        if (t.dwell > 0 && t.last >= 0) {
          const st = r.stops[t.last], tail = t.s - t.dir * trainLen(t.cars);
          const lo = Math.min(t.s, tail), hi = Math.max(t.s, tail);
          if (lo < st.s0 - 0.5 || hi > st.s1 + 0.5) outside++;
        }
        if (inMid && t.dwell <= 0 && t.v > 30) e.passedMid = true;
        seen.set(t.id, e);
      }
    }
    expect(outside).toBe(0);
    const all = [...seen.values()];
    expect(all.some((e) => e.reversed)).toBe(true);
    expect(all.some((e) => !e.express && e.stoppedMid)).toBe(true);
    expect(all.some((e) => e.express && e.passedMid && !e.stoppedMid)).toBe(true);
    expect(all.every((e) => !(e.express && e.stoppedMid))).toBe(true);
    // 止まる列車は、ホームのある外側の線路へ移る（通過する列車は本線のまま）
    const loc = ops.trains.find((t) => !t.express)!;
    loc.next = 0;
    loc.platN = loc.dir;
    expect(Math.abs(ops.laneOffset(loc, (mid.s0 + mid.s1) / 2))).toBeCloseTo(7.5, 3);
    const ex = ops.trains.find((t) => t.express)!;
    expect(Math.abs(ops.laneOffset(ex, (mid.s0 + mid.s1) / 2))).toBeCloseTo(2.5, 3);
    expect(HSR_DWELL).toBeGreaterThan(0);
  });

  it('routes run between line ends; a line with two terminals runs trains both ways', () => {
    const w = flat();
    ok(w, hsrLine(w, 6, 40, 80, 40));
    ok(w, { t: 'road', x0: 0, y0: 43, x1: 95, y1: 43, road: RoadType.Road });
    ok(w, { t: 'plop', id: 'hsr_station', x: 76, y: 40 });
    ok(w, { t: 'plop', id: 'hsr_station', x: 10, y: 40 });
    const R = hsrRoutes(w.g);
    expect(R.length).toBe(1);
    expect([R[0].endA, R[0].endB]).toEqual(['end', 'end']);
    expect(stations(w).every((b) => /ターミナル駅/.test(b.note ?? ''))).toBe(true);
  });
});

// 西の街（住宅）と東の街（仕事）。2 つの街は道路でつながっておらず、高速鉄道だけでつながる
function twoTowns(toEdge: boolean) {
  const w = flat(96, 6);
  w.sandbox = true;
  ok(w, hsrLine(w, toEdge ? 0 : 4, 40, toEdge ? 95 : 90, 40));
  for (const [x0, x1] of [[6, 34], [62, 90]]) {
    for (let y = 43; y <= 61; y += 6) ok(w, { t: 'road', x0, y0: y, x1, y1: y, road: RoadType.Road });
    for (let x = x0; x <= x1; x += 7) ok(w, { t: 'road', x0: x, y0: 43, x1: x, y1: 61, road: RoadType.Street });
  }
  ok(w, { t: 'plop', id: 'hsr_station', x: 20, y: 40 });
  ok(w, { t: 'plop', id: 'hsr_station', x: 76, y: 40 });
  ok(w, { t: 'zone', x0: 7, y0: 44, x1: 33, y1: 60, zone: ZoneType.R, den: 1 });
  ok(w, { t: 'zone', x0: 63, y0: 44, x1: 89, y1: 60, zone: ZoneType.C, den: 1 });
  // 電気と水（どちらの街にも）
  ok(w, { t: 'plop', id: 'nuclear', x: 48, y: 80 });
  ok(w, { t: 'pline', x0: 45, y0: 80, x1: 20, y1: 80 });
  ok(w, { t: 'pline', x0: 20, y0: 79, x1: 20, y1: 60 });
  ok(w, { t: 'pline', x0: 51, y0: 80, x1: 76, y1: 80 });
  ok(w, { t: 'pline', x0: 76, y0: 79, x1: 76, y1: 60 });
  for (const [x0, x1] of [[6, 34], [62, 90]]) {
    ok(w, { t: 'road', x0: x0, y0: 61, x1: x0, y1: 66, road: RoadType.Road });
    ok(w, { t: 'road', x0: x0, y0: 66, x1: x1 - 12, y1: 66, road: RoadType.Street });
    for (let k = 0; k < 6; k++) w.exec({ t: 'plop', id: 'pump', x: x0 + 2 + k * 3, y: 67 });
  }
  return w;
}
function grow(w: World, days: number) {
  for (let d = 0; d < days; d++) {
    for (const k of ['R1', 'R2', 'CS1', 'CS2', 'CO2'] as const) w.demand[k] = Math.max(w.demand[k], 0.9);
    w.stepDay();
  }
}

describe('HSR in the city simulation', () => {
  it('lines reaching the map edge bring passengers from other cities and raise commercial demand', () => {
    const wE = lineWithStations({ toEdge: true, through: false });
    const wN = lineWithStations({ toEdge: false, through: false });
    for (const w of [wE, wN]) for (let d = 0; d < 30; d++) w.stepDay();
    expect(wE.hsrStats.edge).toBe(true);
    expect(wE.hsrStats.visitors).toBeGreaterThan(0);
    expect(wE.hsrStats.tourists).toBeGreaterThan(0);
    expect(wN.hsrStats.visitors).toBe(0);
    expect((wE as unknown as { hsrBoost: number }).hsrBoost).toBeGreaterThan(0);
    expect((wN as unknown as { hsrBoost: number }).hsrBoost).toBe(0);
    // 乗客は、マップの端から駅までの線路に数える
    const g = wE.g, N = g.n * g.n;
    expect(wE.maps.riders.length).toBe(6 * N);
    expect(wE.maps.riders[5 * N + g.idx(30, 40)]).toBeGreaterThan(0);
    expect(wN.maps.riders[5 * N + g.idx(30, 40)]).toBe(0);
  });

  it('with two stations, residents ride HSR to jobs across the map; fares are collected', () => {
    const w = twoTowns(false);
    grow(w, 300);
    const g = w.g, N = g.n * g.n;
    expect(w.population()).toBeGreaterThan(200);
    expect((w as unknown as { hsrResidents: number }).hsrResidents).toBeGreaterThan(20);
    // 2 つの駅のあいだの線路に乗客がいる
    expect(w.maps.riders[5 * N + g.idx(50, 40)]).toBeGreaterThan(10);
    // 運賃（高速鉄道の乗客 × HSR_FARE）と、線路・駅の維持費
    expect(w.hsrStats.income).toBe(Math.round(w.hsrStats.riders * HSR_FARE));
    expect(w.stats.incomeBreakdown['高速鉄道']).toBeGreaterThan(0);
    expect(w.stats.expenseBreakdown['高速鉄道']).toBeGreaterThan(CIVIC.hsr_station.upkeep * 2 - 1);
    // 駅のまわりの地価が上がる
    const near = w.maps.landValue[g.idx(27, 46)], far = w.maps.landValue[g.idx(27, 85)];
    expect(near).toBeGreaterThan(far);
  });

  it('revenue covers costs when ridership is high (map edge + busy line)', () => {
    const w = lineWithStations({ toEdge: true, through: true });
    for (let d = 0; d < 60; d++) w.stepDay();
    const s = w.hsrStats;
    expect(s.income).toBe(Math.round(s.riders * HSR_FARE));
    expect(s.expense).toBeGreaterThan(0);
    // 小さな街（乗客は隣の都市からだけ）は赤字
    expect(s.income).toBeLessThan(s.expense);
  });

  it('transfers: an elevated-rail station next to the HSR station is linked by a walkway in the transit graph', () => {
    const w = flat();
    ok(w, hsrLine(w, 4, 40, 90, 40));
    ok(w, { t: 'road', x0: 2, y0: 43, x1: 93, y1: 43, road: RoadType.Road });
    ok(w, { t: 'plop', id: 'hsr_station', x: 76, y: 40 });
    ok(w, { t: 'plop', id: 'hsr_station', x: 10, y: 40 });
    // 西の駅の北（y = 38 より北）に高架鉄道と駅（駅の敷地が高速鉄道の駅に接する）。高架鉄道は北の住宅地へ
    ok(w, { t: 'road', x0: 2, y0: 35, x1: 30, y1: 35, road: RoadType.Road });
    ok(w, { t: 'transit', x0: 12, y0: 37, x1: 12, y1: 5, kind: 'erail' });
    ok(w, { t: 'road', x0: 2, y0: 6, x1: 30, y1: 6, road: RoadType.Road });
    ok(w, { t: 'plop', id: 'el_station', x: 13, y: 36 });
    ok(w, { t: 'plop', id: 'el_station', x: 13, y: 7 });
    for (let d = 0; d < 30; d++) w.stepDay();
    const tm = w.transitModel!;
    const g = w.g, N = g.n * g.n;
    expect(tm.lineLinks.size).toBeGreaterThan(0);
    // 北の住宅地（高架鉄道の駅）から、東の駅の前の仕事へ：高架鉄道 → 乗り換え → 高速鉄道
    const J = buildJunctions(g, new Float32Array(2 * N));
    const cong = new Float32Array(2 * N).fill(1);
    const origin: Origin = { cell: g.idx(14, 6), trips: 50, carPenalty: 999, buildings: [{ id: 99, trips: 50 }] };
    const dest = g.idx(82, 43);
    const r = assignTrips(g, [origin], new Map([[dest, [{ id: 1, free: 50 }]]]), cong, J, () => 0.5, { externalCap: 0, maxMinutes: 80, weight: 1 }, tm, buildRoadGraph(g, cong, J));
    expect(r.filled.get(1)).toBe(50);
    expect(r.modes.hsr).toBe(50);
    expect(r.volume[LAYER.erail * N + g.idx(12, 20)]).toBeGreaterThan(0);
    expect(r.volume[LAYER.hsr * N + g.idx(50, 40)]).toBeGreaterThan(0);
    expect(stations(w).find((b) => b.x < 40)!.note).toMatch(/乗り換え 1 路線/);
  });

  it('noise lowers land value along the line; automatic barriers next to homes reduce it', () => {
    const w = flat();
    ok(w, hsrLine(w, 5, 30, 90, 30));
    const g = w.g, N = g.n * g.n;
    const quiet = hsrNoise(g, 0.5, new Float32Array(N));
    expect(hsrBarrier(g, g.idx(40, 30))).toBe(false);
    ok(w, { t: 'road', x0: 30, y0: 33, x1: 50, y1: 33, road: RoadType.Road });
    ok(w, { t: 'zone', x0: 30, y0: 31, x1: 50, y1: 32, zone: ZoneType.R, den: 0 });
    expect(hsrBarrier(g, g.idx(40, 30))).toBe(true);
    expect(hsrBarrier(g, g.idx(80, 30))).toBe(false);
    const withBarrier = hsrNoise(g, 0.5, new Float32Array(N));
    expect(withBarrier[g.idx(40, 32)]).toBeLessThan(quiet[g.idx(40, 32)] * 0.5);
    expect(withBarrier[g.idx(80, 32)]).toBeCloseTo(quiet[g.idx(80, 32)], 5);
    // 地価：線路沿い（防音壁なし）は、離れた所より下がる
    for (let d = 0; d < 30; d++) w.stepDay();
    const lv = w.maps.landValue;
    expect(lv[g.idx(80, 31)]).toBeLessThan(lv[g.idx(80, 50)]);
    expect(w.maps.noise[g.idx(80, 31)]).toBeGreaterThan(0);
    expect(HSR_NOISE_LV).toBeLessThan(0.2); // 少しだけ
  });
});

describe('HSR save/load and bulldoze layers', () => {
  it('saves and loads track, flags and stations; old saves without HSR arrays still load', () => {
    const w = lineWithStations({ toEdge: true, through: true });
    ok(w, hsrLine(w, 10, 70, 40, 70, true));
    const d = w.serialize();
    expect(d.hsr).toBeDefined();
    const w2 = World.load(JSON.parse(JSON.stringify({ ...d, hsr: undefined, hsrf: undefined })) as typeof d);
    expect([...w2.g.hsr].some(Boolean)).toBe(false);
    const w3 = World.load(d);
    expect([...w3.g.hsr]).toEqual([...w.g.hsr]);
    expect([...w3.g.hsrf]).toEqual([...w.g.hsrf]);
    const s = stations(w3).sort((a, b) => a.x - b.x);
    expect(s.length).toBe(2);
    expect(s[0].hsr!.out).toEqual([true, true]);
    for (let k = 0; k < 30; k++) w3.stepDay();
    expect(w3.hsrStats.stations).toBe(2);
  });

  it('elevated HSR (and its station) is in the 高架 layer, ground HSR in the 地上 layer', () => {
    const w = lineWithStations({ toEdge: false, through: false });
    ok(w, hsrLine(w, 10, 70, 60, 70, true));
    const g = w.g;
    const info = (id: number) => w.buildings.get(id);
    const rect = normRect(0, 0, g.n - 1, g.n - 1, g.n);
    const pg = planBulldoze(g, rect, info, 'ground'), pu = planBulldoze(g, rect, info, 'up');
    expect(pg.transit).toContain(g.idx(30, 70));
    expect(pg.transit).not.toContain(g.idx(30, 40));
    expect(pu.transit).toContain(g.idx(30, 40));
    expect(pu.transit).not.toContain(g.idx(30, 70));
    const stn = stations(w)[0];
    expect(pu.buildings).toContain(stn.id);
    expect(pg.buildings).not.toContain(stn.id);
    // 地上を壊しても高架は残る
    ok(w, { t: 'bulldoze', x0: 0, y0: 0, x1: g.n - 1, y1: g.n - 1, layer: 'ground' });
    expect(g.hsr[g.idx(30, 70)]).toBe(0);
    expect(g.hsr[g.idx(30, 40)]).not.toBe(0);
    expect(stations(w).length).toBe(1);
    ok(w, { t: 'bulldoze', x0: 0, y0: 38, x1: g.n - 1, y1: 42, layer: 'up' });
    expect(g.hsr[g.idx(30, 40)]).toBe(0);
    expect(stations(w).length).toBe(0);
    expect([...g.hsrf].some((f) => f & HSRF_STATION)).toBe(false);
  });
});
