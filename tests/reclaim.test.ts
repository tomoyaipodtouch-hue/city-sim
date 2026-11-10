// 埋め立てと岸壁
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { QUAY_LAND } from '../src/sim/constants';
import { RoadType, ZoneType } from '../src/sim/defs';

// 東側が海（x >= 40 が水）の 64×64 のマップ
function bay() {
  const w = new World(64);
  const V = 65;
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= 41 ? -5 : 6;
  w.sandbox = true;
  return w;
}

describe('reclaim', () => {
  it('fills water flat and makes the new water edge a quay', () => {
    const w = bay(), g = w.g;
    expect(g.isWater(45, 20)).toBe(true);
    const r = w.exec({ t: 'reclaim', style: 1, x0: 40, y0: 10, x1: 47, y1: 29 });
    expect(r.ok).toBe(true);
    for (let y = 10; y <= 29; y++) for (let x = 41; x <= 47; x++) expect(g.isWater(x, y)).toBe(false);
    expect(g.cellMinH(45, 20)).toBeCloseTo(QUAY_LAND, 5);
    // 海に面した東の端と、北・南の端が岸壁
    expect(g.quay[g.idx(47, 20)]).toBe(1);
    expect(g.quay[g.idx(44, 10)]).toBe(1);
    expect(g.quay[g.idx(44, 29)]).toBe(1);
    // 内側は岸壁ではない
    expect(g.quay[g.idx(44, 20)]).toBe(0);
    expect(g.isWater(48, 20)).toBe(true);
  });

  it('extending a reclaim moves the quay outward', () => {
    const w = bay(), g = w.g;
    w.exec({ t: 'reclaim', style: 1, x0: 40, y0: 10, x1: 45, y1: 20 });
    expect(g.quay[g.idx(45, 15)]).toBe(1);
    w.exec({ t: 'reclaim', style: 1, x0: 46, y0: 10, x1: 49, y1: 20 });
    expect(g.quay[g.idx(45, 15)]).toBe(0);
    expect(g.quay[g.idx(49, 15)]).toBe(1);
  });

  it('a promenade blocks zones and buildings but raises land value', () => {
    const w = bay(), g = w.g;
    w.exec({ t: 'reclaim', style: 2, x0: 40, y0: 10, x1: 45, y1: 29 });
    const i = g.idx(45, 20);
    expect(g.quay[i]).toBe(2);
    w.exec({ t: 'zone', x0: 40, y0: 10, x1: 45, y1: 29, zone: ZoneType.R, den: 0 });
    expect(g.zone[i]).toBe(0);
    expect(g.zone[g.idx(43, 20)]).toBe(ZoneType.R);
    for (let d = 0; d < 40; d++) w.stepDay();
    expect(w.maps.landValue[g.idx(43, 20)]).toBeGreaterThan(w.maps.landValue[g.idx(20, 20)]);
  });

  it('does not touch cells with roads and saves the quay', () => {
    const w = bay(), g = w.g;
    // 水際の道路（その頂点は動かさない）
    w.exec({ t: 'road', x0: 39, y0: 30, x1: 39, y1: 50, road: RoadType.Road });
    const ri = g.idx(39, 40);
    expect(g.road[ri]).toBeTruthy();
    const before = [g.vh(39, 40), g.vh(40, 40), g.vh(39, 41), g.vh(40, 41)];
    w.exec({ t: 'reclaim', style: 1, x0: 36, y0: 36, x1: 50, y1: 44 });
    expect([g.vh(39, 40), g.vh(40, 40), g.vh(39, 41), g.vh(40, 41)]).toEqual(before);
    expect(g.isWater(45, 40)).toBe(false);
    const w2 = World.load(w.serialize()); // 保存は structured clone（型付き配列のまま）
    let a = 0, b = 0;
    for (let k = 0; k < g.n * g.n; k++) { a += g.quay[k]; b += w2.g.quay[k]; }
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a);
  });
});
