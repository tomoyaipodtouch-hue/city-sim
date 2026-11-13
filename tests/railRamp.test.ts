// 地上の鉄道と高架鉄道を結ぶ坂：引き方（両方向）、断り（まっすぐな場所が足りない・踏切）、乗り換えなしの乗車、保存と読み込み、取り壊し
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { normRect, planBulldoze, planLine, planTransitLine } from '../src/sim/plan';
import { assignTrips, buildJunctions, buildRoadGraph, LAYER, Origin } from '../src/sim/traffic';
import {
  allRamps, isRampHigh, isRampLow, rampK, rampLift, rampLineH, RAMP_LEN, RAMP_MSG_ROAD, RAMP_MSG_SHORT, RAMP_MSG_STATION, RAMP_PORTAL,
} from '../src/sim/railRamp';
import { erailDeckH, HWR_CLEAR } from '../src/sim/hwrail';

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
const line = (kind: 'rail' | 'erail', x0: number, y0: number, x1: number, y1: number): Cmd => ({ t: 'transit', x0, y0, x1, y1, kind });
const E = 1 << 0, W = 1 << 4;

// 列車の一筆書き：rail・erail の 2 層のノード（層 × N + マス）を、つなぎ目で乗り移りながらたどる
function walkService(w: World, start: number, startKind: 'rail' | 'erail') {
  const g = w.g, n = g.n, N = n * n;
  const seen = new Set<number>();
  const st = [(startKind === 'rail' ? 0 : N) + start];
  while (st.length) {
    const v = st.pop()!;
    if (seen.has(v)) continue;
    seen.add(v);
    const L = v >= N ? 1 : 0, c = v - L * N, mask = L ? g.erail : g.rail;
    for (let d = 0; d < 8; d++) {
      if (!(mask[c] & (1 << d))) continue;
      const x = (c % n) + [1, 1, 0, -1, -1, -1, 0, 1][d], y = ((c / n) | 0) + [0, 1, 1, 1, 0, -1, -1, -1][d];
      if (g.inb(x, y)) st.push(L * N + y * n + x);
    }
    if (g.rramp[c] && rampK(g, c) === RAMP_PORTAL) st.push((1 - L) * N + c);
  }
  return seen;
}

describe('rail ⇔ elevated rail ramp: drawing', () => {
  it('a ground line extended by elevated rail turns the joint into a straight ramp; one service runs end to end', () => {
    const w = flat();
    ok(w, line('rail', 10, 40, 30, 40));
    const r = ok(w, line('erail', 30, 40, 60, 40));
    const g = w.g, at = (x: number) => g.idx(x, 40);
    const ramps = allRamps(g);
    expect(ramps.length).toBe(1);
    expect(ramps[0].cells).toEqual(Array.from({ length: RAMP_LEN }, (_, k) => at(30 + k)));
    expect(ramps[0].dir).toBe(0);
    // 下の部分は地上の線路、上の部分は高架の線路、つなぎ目は両方（それぞれ行き止まりの形）
    const P = 30 + RAMP_PORTAL;
    expect(g.rail[at(30)]).toBe(E | W);
    expect(g.erail[at(30)]).toBe(0);
    expect(g.rail[at(P)]).toBe(W);
    expect(g.erail[at(P)]).toBe(E);
    expect(g.rail[at(P + 1)]).toBe(0);
    expect(g.erail[at(P + 1)]).toBe(E | W);
    expect(g.erail[at(30 + RAMP_LEN)]).toBe(E | W);
    expect(g.erail[at(60)]).toBe(W);
    // 高さは一定の勾配で、地上から高架まで上がる
    const hs = ramps[0].cells.map((c) => rampLineH(g, c));
    for (let k = 1; k < hs.length; k++) expect(hs[k] - hs[k - 1]).toBeCloseTo(hs[1] - hs[0], 5);
    expect(rampLift(0)).toBeLessThan(1);
    expect(rampLift(RAMP_LEN - 1)).toBeGreaterThan(7);
    expect(erailDeckH(g, at(P + 2))).toBeCloseTo(rampLineH(g, at(P + 2)), 5);
    // 費用：坂のマスは坂の値段
    expect(r.cost).toBeGreaterThan(0);
    // 1本の列車が、地上の端から高架の端まで走れる
    const svc = walkService(w, at(10), 'rail');
    const N = g.n * g.n;
    expect(svc.has(N + at(60))).toBe(true);
    expect(svc.has(at(10))).toBe(true);
  });

  it('the reverse also works: an elevated line extended by ground rail ramps down', () => {
    const w = flat();
    ok(w, line('erail', 60, 40, 40, 40));
    ok(w, line('rail', 40, 40, 10, 40));
    const g = w.g, at = (x: number) => g.idx(x, 40);
    const ramps = allRamps(g);
    expect(ramps.length).toBe(1);
    // 坂は西（地上）から東（高架）へ上る。いちばん上のマスがつなぎ目（もとの高架の端）
    expect(ramps[0].dir).toBe(0);
    expect(ramps[0].cells[RAMP_LEN - 1]).toBe(at(40));
    expect(ramps[0].cells[0]).toBe(at(40 - RAMP_LEN + 1));
    expect(g.rail[at(40)]).toBe(0);
    expect(g.erail[at(40)]).toBe(E | W);
    const svc = walkService(w, at(60), 'erail');
    expect(svc.has(at(10))).toBe(true);
    // 坂の下の端から、地上の線路をまっすぐ続けられる。坂の途中にはつなげない
    const w2 = flat();
    ok(w2, line('erail', 60, 40, 40, 40));
    ok(w2, line('rail', 40, 40, 29, 40));
    ok(w2, line('rail', 29, 40, 15, 40));
    expect(fail(w2, line('rail', 33, 40, 33, 20))).toMatch(/坂の途中/);
  });

  it('elevated in the middle: drawing a viaduct between two ground line ends makes a ramp at each end', () => {
    const w = flat();
    ok(w, line('rail', 5, 40, 20, 40));
    ok(w, line('rail', 60, 40, 80, 40));
    ok(w, line('erail', 20, 40, 60, 40));
    expect(allRamps(w.g).length).toBe(2);
    const g = w.g, N = g.n * g.n;
    const svc = walkService(w, g.idx(5, 40), 'rail');
    expect(svc.has(g.idx(80, 40))).toBe(true);
    expect(svc.has(N + g.idx(40, 40))).toBe(true);
  });

  it('refuses when there is not enough straight length (short line, early curve, wrong direction)', () => {
    const w = flat();
    ok(w, line('rail', 10, 40, 30, 40));
    // 短すぎる
    expect(fail(w, line('erail', 30, 40, 36, 40))).toBe(RAMP_MSG_SHORT);
    // すぐ曲がる（planLine は直線 → 斜め：東へ 4 マスのあと斜め）
    expect(fail(w, line('erail', 30, 40, 50, 56))).toBe(RAMP_MSG_SHORT);
    // 地上の線路と逆の向き（線路の上を戻る）も、まっすぐ続かないので断る
    expect(fail(w, line('erail', 30, 40, 30, 70))).toBe(RAMP_MSG_SHORT);
    expect(allRamps(w.g).length).toBe(0);
    expect(w.g.erail.some(Boolean)).toBe(false);
  });

  it('refuses a level crossing in the low part of the ramp, but lets roads cross the elevated part', () => {
    const w = flat();
    ok(w, line('rail', 10, 40, 30, 40));
    // 坂の低い所（x = 33）に道路が交差している（踏切）
    ok(w, { t: 'road', x0: 33, y0: 30, x1: 33, y1: 50, road: RoadType.Road });
    expect(fail(w, line('erail', 30, 40, 60, 40))).toBe(RAMP_MSG_ROAD);
    const plan = planTransitLine(w.g, planLine(w.g, 30, 40, 60, 40), 'erail');
    expect(plan.bad.has(w.g.idx(33, 40))).toBe(true);
    // 高い所（つなぎ目より上）を道路が横切るのはよい
    const w2 = flat();
    ok(w2, line('rail', 10, 40, 30, 40));
    ok(w2, { t: 'road', x0: 40, y0: 30, x1: 40, y1: 50, road: RoadType.Road });
    ok(w2, line('erail', 30, 40, 60, 40));
    expect(isRampHigh(w2.g, w2.g.idx(40, 40))).toBe(true);
    // あとから道路を引くとき：低い所は踏切を作れない、高い所の下はくぐれる
    expect(fail(w2, { t: 'road', x0: 34, y0: 30, x1: 34, y1: 50, road: RoadType.Road })).toBe(RAMP_MSG_ROAD);
    ok(w2, { t: 'road', x0: 41, y0: 30, x1: 41, y1: 50, road: RoadType.Road });
  });

  it('stations cannot sit next to the ramp, and ramps are not built next to stations', () => {
    const w = flat();
    ok(w, line('rail', 10, 40, 30, 40));
    ok(w, line('erail', 30, 40, 60, 40));
    ok(w, { t: 'road', x0: 30, y0: 43, x1: 50, y1: 43, road: RoadType.Road });
    expect(fail(w, { t: 'plop', id: 'station', x: 32, y: 41 })).toBe(RAMP_MSG_STATION);
    const w2 = flat();
    ok(w2, line('rail', 10, 40, 30, 40));
    ok(w2, { t: 'road', x0: 20, y0: 43, x1: 50, y1: 43, road: RoadType.Road });
    ok(w2, { t: 'plop', id: 'station', x: 28, y: 41 });
    expect(fail(w2, line('erail', 30, 40, 60, 40))).toBe(RAMP_MSG_STATION);
  });
});

// 西に地上の線路と地上の駅、東に高架鉄道と高架の駅。あいだは坂。駅のまわりの道路は、つながっていない
function throughLine() {
  const w = flat();
  ok(w, line('rail', 4, 40, 34, 40));
  ok(w, line('erail', 34, 40, 90, 40));
  ok(w, { t: 'road', x0: 2, y0: 43, x1: 20, y1: 43, road: RoadType.Road });
  ok(w, { t: 'plop', id: 'station', x: 10, y: 41 });
  ok(w, { t: 'road', x0: 70, y0: 43, x1: 92, y1: 43, road: RoadType.Road });
  ok(w, { t: 'plop', id: 'el_station', x: 80, y: 41 });
  return w;
}

describe('rail ⇔ elevated rail ramp: passengers', () => {
  it('passengers ride from a ground station to an elevated station without a transfer', () => {
    const w = throughLine();
    for (let d = 0; d < 30; d++) w.stepDay();
    const tm = w.transitModel!;
    const g = w.g, N = g.n * g.n;
    const J = buildJunctions(g, new Float32Array(2 * N));
    const cong = new Float32Array(2 * N).fill(1);
    const origin: Origin = { cell: g.idx(6, 43), trips: 40, carPenalty: 999, buildings: [{ id: 99, trips: 40 }] };
    const dest = g.idx(88, 43);
    const r = assignTrips(g, [origin], new Map([[dest, [{ id: 1, free: 40 }]]]), cong, J, () => 0.5, { externalCap: 0, maxMinutes: 80, weight: 1 }, tm, buildRoadGraph(g, cong, J));
    expect(r.filled.get(1)).toBe(40);
    expect(r.modes.transit).toBe(40);
    // 地上の線路・坂・高架の線路の全部を通る。坂のまわりで歩いていない（徒歩の層を通らない）
    expect(r.volume[LAYER.rail * N + g.idx(20, 40)]).toBeGreaterThan(0);
    expect(r.volume[LAYER.rail * N + g.idx(36, 40)]).toBeGreaterThan(0);
    expect(r.volume[LAYER.erail * N + g.idx(44, 40)]).toBeGreaterThan(0);
    expect(r.volume[LAYER.erail * N + g.idx(60, 40)]).toBeGreaterThan(0);
    for (let x = 20; x < 70; x++) for (const dy of [-1, 0, 1]) expect(r.volume[LAYER.walk * N + g.idx(x, 40 + dy)]).toBe(0);
    // 坂がなければ（線路が離れていれば）行けない
    const w2 = flat();
    ok(w2, line('rail', 4, 40, 34, 40));
    ok(w2, line('erail', 36, 40, 90, 40));
    ok(w2, { t: 'road', x0: 2, y0: 43, x1: 20, y1: 43, road: RoadType.Road });
    ok(w2, { t: 'plop', id: 'station', x: 10, y: 41 });
    ok(w2, { t: 'road', x0: 70, y0: 43, x1: 92, y1: 43, road: RoadType.Road });
    ok(w2, { t: 'plop', id: 'el_station', x: 80, y: 41 });
    for (let d = 0; d < 30; d++) w2.stepDay();
    const r2 = assignTrips(w2.g, [origin], new Map([[dest, [{ id: 1, free: 40 }]]]), cong, J, () => 0.5, { externalCap: 0, maxMinutes: 80, weight: 1 }, w2.transitModel!, buildRoadGraph(w2.g, cong, J));
    expect(r2.filled.get(1) ?? 0).toBe(0);
  });
});

describe('rail ⇔ elevated rail ramp: save/load and bulldoze', () => {
  it('saves and loads the ramp; old saves without the ramp array still load', () => {
    const w = throughLine();
    const d = w.serialize();
    expect(d.rramp).toBeDefined();
    const w2 = World.load(d);
    expect([...w2.g.rramp]).toEqual([...w.g.rramp]);
    expect([...w2.g.rail]).toEqual([...w.g.rail]);
    expect([...w2.g.erail]).toEqual([...w.g.erail]);
    expect(allRamps(w2.g).length).toBe(1);
    for (let k = 0; k < 3; k++) w2.stepDay();
    // 古い保存データ（坂の配列がない）
    const old = flat();
    ok(old, line('rail', 10, 40, 30, 40));
    ok(old, line('erail', 50, 30, 50, 60));
    const od = { ...old.serialize() };
    delete od.rramp;
    const w3 = World.load(od);
    expect(w3.g.rramp.some(Boolean)).toBe(false);
    expect([...w3.g.rail]).toEqual([...old.g.rail]);
    expect([...w3.g.erail]).toEqual([...old.g.erail]);
  });

  it('bulldoze: the low part is 地上, the high part 高架; removing either removes the whole ramp', () => {
    const w = flat();
    ok(w, line('rail', 10, 40, 30, 40));
    ok(w, line('erail', 30, 40, 60, 40));
    const g = w.g, at = (x: number) => g.idx(x, 40);
    const info = (id: number) => w.buildings.get(id);
    expect(isRampLow(g, at(32))).toBe(true);
    expect(isRampHigh(g, at(32))).toBe(false);
    // 低い所だけを囲む：地上なら坂全体、高架には何もない
    const low = normRect(31, 40, 33, 40, g.n);
    const pg = planBulldoze(g, low, info, 'ground');
    expect(pg.transit).toContain(at(41));
    expect(planBulldoze(g, low, info, 'up').transit.length).toBe(0);
    // 高い所だけを囲む：高架なら坂全体、地上には何もない
    const high = normRect(39, 40, 40, 40, g.n);
    expect(planBulldoze(g, high, info, 'ground').transit.length).toBe(0);
    expect(planBulldoze(g, high, info, 'up').transit).toContain(at(31));
    // 高い所を高架で取り壊す：坂はなくなり、前後の線路は残る（坂の側のつながりは外れる）
    ok(w, { t: 'bulldoze', x0: 39, y0: 40, x1: 40, y1: 40, layer: 'up' });
    expect(allRamps(g).length).toBe(0);
    for (let x = 30; x < 30 + RAMP_LEN; x++) {
      expect(g.rail[at(x)]).toBe(0);
      expect(g.erail[at(x)]).toBe(0);
      expect(g.rramp[at(x)]).toBe(0);
    }
    expect(g.rail[at(29)]).toBe(W);
    expect(g.erail[at(30 + RAMP_LEN)]).toBe(E);
    // 地上で低い所を取り壊しても同じ
    const w2 = flat();
    ok(w2, line('rail', 10, 40, 30, 40));
    ok(w2, line('erail', 30, 40, 60, 40));
    ok(w2, { t: 'bulldoze', x0: 32, y0: 40, x1: 32, y1: 40, layer: 'ground' });
    expect(allRamps(w2.g).length).toBe(0);
    expect(w2.g.erail[w2.g.idx(45, 40)]).toBe(E | W);
    // 坂の高架の下の道路は、地上だけ取り壊せる（坂は残る）
    const w3 = flat();
    ok(w3, line('rail', 10, 40, 30, 40));
    ok(w3, line('erail', 30, 40, 60, 40));
    ok(w3, { t: 'road', x0: 40, y0: 30, x1: 40, y1: 50, road: RoadType.Road });
    ok(w3, { t: 'bulldoze', x0: 40, y0: 30, x1: 40, y1: 50, layer: 'ground' });
    expect(allRamps(w3.g).length).toBe(1);
    expect(w3.g.road[w3.g.idx(40, 40)]).toBe(0);
  });
});

describe('rail ⇔ elevated rail ramp: elevated highways', () => {
  it('an elevated highway crossing the high part is raised only as much as the lower deck needs; the low part is refused', () => {
    const w = flat();
    ok(w, line('rail', 10, 40, 30, 40));
    ok(w, line('erail', 30, 40, 60, 40));
    const g = w.g;
    // 高い所（x = 40）を南北にまたぐ
    ok(w, { t: 'road', x0: 40, y0: 10, x1: 40, y1: 70, road: RoadType.UrbanHighway });
    const c = g.idx(40, 40);
    expect(g.upH[c] - erailDeckH(g, c)).toBeGreaterThanOrEqual(HWR_CLEAR - 1e-6);
    // 坂の床版は、ふつうの高架鉄道より低いので、ふつうの高架鉄道をまたぐときより低い
    const w2 = flat();
    ok(w2, line('erail', 10, 40, 60, 40));
    ok(w2, { t: 'road', x0: 40, y0: 10, x1: 40, y1: 70, road: RoadType.UrbanHighway });
    expect(g.upH[c]).toBeLessThan(w2.g.upH[c]);
    // 低い所（盛土の上）には高架の道路を通せない
    expect(fail(w, { t: 'road', x0: 33, y0: 10, x1: 33, y1: 70, road: RoadType.UrbanHighway })).toMatch(/坂/);
  });
});
