// 新しい空港（小）：置き方（縦横・斜め・海の上・2km マップ）、以前の空港の保存データ、空港駅の乗客、高速道路の直結、
// 航空貨物、収入と維持費、騒音
import { describe, expect, it } from 'vitest';
import { World, BState } from '../src/sim/world';
import { CIVIC, GrowKind, RoadType, ZoneType } from '../src/sim/defs';
import { AIRPORT_SPECS, airportCells, airportLayout, airportPorts, AIR_FEE_FLIGHT, AIR_FEE_PAX, footprintAt, frameOf, makeFrame, planAirport, placeCentre, runwayNumber, toLocal } from '../src/sim/airport';
import { CELL } from '../src/sim/constants';
import { TOOL_GROUPS, allItems } from '../src/ui/menu';

const SPEC = AIRPORT_SPECS[1];
type Cmd = Parameters<World['exec']>[0];
const flat = (n = 128, h = 8, seaFrom = Infinity) => {
  const w = new World(n), V = n + 1;
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= seaFrom ? -6 : h;
  w.sandbox = true;
  w.funds = 1e9;
  return w;
};
const ok = (w: World, c: Cmd) => {
  const r = w.exec(c);
  if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.msg}`);
  return r;
};
// 敷地の外の、敷地に接するマスから外へ 2 マスの一般道を引く（置くには道路に接している必要がある）
function roadBeside(w: World, rot: number, tx: number, ty: number) {
  const g = w.g, n = g.n;
  const [cx, cz] = placeCentre(n, SPEC, rot, tx, ty);
  const fp = footprintAt(n, SPEC, rot, cx, cz);
  const lot = new Set(fp.cells);
  const f = makeFrame(SPEC, rot, cx, cz);
  // 陸側（+c）の真ん中から外へ
  const [px, pz] = [f.cx - f.sin * (f.C / 2 + 8), f.cz + f.cos * (f.C / 2 + 8)];
  let x = Math.floor(px / CELL), y = Math.floor(pz / CELL);
  while (lot.has(y * n + x)) { x += Math.round(-f.sin); y += Math.round(f.cos); }
  const dx = Math.round(-f.sin * 1.4), dy = Math.round(f.cos * 1.4);
  ok(w, { t: 'road', x0: x, y0: y, x1: x + dx * 2, y1: y + dy * 2, road: RoadType.Road });
}

describe('airport placement', () => {
  it('fits all 8 orientations on a 2 km map, with the right footprint', () => {
    for (let rot = 0; rot < 8; rot++) {
      const w = flat();
      roadBeside(w, rot, 64, 64);
      const p = planAirport(w.g, 1, 64, 64, rot);
      expect(p.reason).toBe('');
      expect(p.ok).toBe(true);
      // 敷地の広さ：縦横はちょうど 12×60、斜めは長方形に重なるマス（720 マスより少し多い）
      if (rot % 2 === 0) {
        expect(p.cells.length).toBe(720);
        expect([p.w, p.h].sort((a, b) => a - b)).toEqual([12, 60]);
      } else {
        expect(p.cells.length).toBeGreaterThan(720);
        expect(p.cells.length).toBeLessThan(900);
        expect(Math.max(p.w, p.h)).toBeLessThanOrEqual(53);
      }
      ok(w, { t: 'plop', id: 'airport_1', x: 64, y: 64, rot });
      const b = [...w.buildings.values()].find((q) => q.type === 'airport_1')!;
      expect(b.face).toBe(rot);
      // 敷地のマスにだけ建物の印がつく（斜めの敷地は外の四角の一部）
      const cells = new Set(airportCells(w.g.n, b, SPEC));
      let marked = 0;
      for (let i = 0; i < w.g.bldg.length; i++) if (w.g.bldg[i] === b.id) { marked++; expect(cells.has(i)).toBe(true); }
      expect(marked).toBe(cells.size);
      // 置いたあとの中心は、計画の中心と同じ
      const f = frameOf(b, SPEC);
      expect(f.cx).toBeCloseTo(p.cx, 5);
      expect(f.cz).toBeCloseTo(p.cz, 5);
    }
  });

  it('diagonal footprint covers the rotated runway and the lot is centrally symmetric', () => {
    const n = 128;
    for (const rot of [1, 3, 5, 7]) {
      const [cx, cz] = placeCentre(n, SPEC, rot, 64, 64);
      const fp = footprintAt(n, SPEC, rot, cx, cz);
      const f = makeFrame(SPEC, rot, cx, cz);
      const set = new Set(fp.cells);
      // 敷地の長方形の中の点は、どれも敷地のマスに入る
      for (let a = -f.A / 2 + 1; a <= f.A / 2 - 1; a += 7) for (let c = -f.C / 2 + 1; c <= f.C / 2 - 1; c += 7) {
        const X = a * f.cos - c * f.sin + f.cx, Z = a * f.sin + c * f.cos + f.cz;
        expect(set.has(Math.floor(Z / CELL) * n + Math.floor(X / CELL))).toBe(true);
      }
      for (const i of fp.cells) {
        const x = i % n, y = (i / n) | 0;
        expect(set.has((2 * 64 - y) * n + (2 * 64 - x))).toBe(true);
      }
    }
  });

  it('clamps placement inside the map near the edge (diagonal and axis)', () => {
    for (const rot of [2, 3, 0, 5]) {
      const w = flat();
      const p = planAirport(w.g, 1, 2, 125, rot);
      expect(p.reason).not.toBe('マップに入りきりません');
      for (const i of p.cells) expect(i).toBeLessThan(128 * 128);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y + p.h).toBeLessThanOrEqual(128);
    }
  });

  it('marks blocked cells red with a reason (road, building, slope)', () => {
    const w = flat();
    roadBeside(w, 2, 64, 64);
    // 敷地を横切る道路
    ok(w, { t: 'road', x0: 60, y0: 50, x1: 60, y1: 80, road: RoadType.Street });
    let p = planAirport(w.g, 1, 64, 64, 2);
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('道路があります');
    expect(p.bad.size).toBeGreaterThan(0);
    for (const i of p.bad.keys()) expect(i % 128).toBe(60);
    // 建物
    const w2 = flat();
    roadBeside(w2, 2, 64, 64);
    ok(w2, { t: 'road', x0: 70, y0: 66, x1: 74, y1: 66, road: RoadType.Street });
    ok(w2, { t: 'plop', id: 'park_s', x: 72, y: 65 });
    ok(w2, { t: 'bulldoze', x0: 70, y0: 66, x1: 74, y1: 66 });
    p = planAirport(w2.g, 1, 64, 64, 2);
    expect(p.reason).toContain('建物があります');
    // 急な坂
    const w3 = flat();
    roadBeside(w3, 2, 64, 64);
    for (let vy = 60; vy < 64; vy++) for (let vx = 40; vx < 46; vx++) w3.g.setVh(vx, vy, 60);
    p = planAirport(w3.g, 1, 64, 64, 2);
    expect(p.reason).toContain('傾き');
    expect(p.bad.size).toBeGreaterThan(0);
  });

  it('reclaims sea cells automatically and edges them with quay, at a higher cost', () => {
    // 東の海（x ≥ 80）にはみ出して置く。縦向き（陸側が西）
    const w = flat(128, 8, 80);
    const tx = 84, ty = 64;
    const rot = 4; // 陸側が西、滑走路は南北
    roadBeside(w, rot, tx, ty);
    const p = planAirport(w.g, 1, tx, ty, rot);
    expect(p.reason).toBe('');
    expect(p.fill.length).toBeGreaterThan(100);
    expect(p.quay.length).toBeGreaterThan(20);
    const land = planAirport(flat().g, 1, 64, 64, rot);
    expect(p.cost).toBeGreaterThan(land.cost + p.fill.length * 300);
    ok(w, { t: 'plop', id: 'airport_1', x: tx, y: ty, rot });
    const g = w.g, n = g.n;
    for (const i of p.cells) expect(g.isWater(i % n, (i / n) | 0)).toBe(false);
    // 水に面する敷地のマスが岸壁
    let quays = 0;
    for (const i of p.cells) if (g.quay[i] === 1) quays++;
    expect(quays).toBeGreaterThan(20);
    // 斜めでも海に置ける
    const w2 = flat(128, 8, 80);
    roadBeside(w2, 3, 70, 64);
    const p2 = planAirport(w2.g, 1, 70, 64, 3);
    expect(p2.reason).toBe('');
    expect(p2.fill.length).toBeGreaterThan(50);
    ok(w2, { t: 'plop', id: 'airport_1', x: 70, y: 64, rot: 3 });
  });

  it('runway numbers follow the real heading', () => {
    expect(runwayNumber(1, 0)).toBe('09');
    expect(runwayNumber(-1, 0)).toBe('27');
    expect(runwayNumber(0, -1)).toBe('36');
    expect(runwayNumber(0, 1)).toBe('18');
    expect(runwayNumber(1, -1)).toBe('05');
    expect(runwayNumber(-1, 1)).toBe('23');
  });

  it('station port lies on the landside edge next to the terminal', () => {
    const n = 128, L = airportLayout(1);
    for (const rot of [2, 3]) {
      const [cx, cz] = placeCentre(n, SPEC, rot, 64, 64);
      const fp = footprintAt(n, SPEC, rot, cx, cz), set = new Set(fp.cells), f = makeFrame(SPEC, rot, cx, cz);
      const P = airportPorts(n, f, L, fp.cells, (i) => set.has(i));
      expect(P.stationCells.length).toBeGreaterThan(3);
      expect(P.stationNear.length).toBeGreaterThan(5);
      for (const i of P.stationNear) {
        expect(set.has(i)).toBe(false);
        const [a, c] = toLocal(f, ((i % n) + 0.5) * CELL, (((i / n) | 0) + 0.5) * CELL);
        expect(c).toBeGreaterThan(L.C / 2 - 20);
        expect(Math.abs(a)).toBeLessThan(110);
      }
    }
  });
});

describe('menu and legacy airports', () => {
  it('menu has 空港（小） under 空港 with size on line 2; old airports are gone', () => {
    const tr = TOOL_GROUPS.find((g) => g.id === 'transit')!;
    const sec = tr.sections!.find((s) => s.title === '空港')!;
    expect(sec.items.map((i) => i.tool)).toEqual(['plop:airport_1', 'plop:airport_2']);
    expect(sec.items[1].name).toBe('空港（中）');
    expect(sec.items[1].size).toBe('18×85');
    expect(sec.items[1].cost).toBe(300000);
    expect(sec.items[1].thumb).toEqual({ k: 'airport', size: 2 });
    expect(sec.items[0].name).toBe('空港（小）');
    expect(sec.items[0].size).toBe('12×60');
    expect(sec.items[0].thumb).toEqual({ k: 'airport', size: 1 });
    const all = TOOL_GROUPS.flatMap(allItems).map((i) => i.tool);
    expect(all).not.toContain('plop:airport_s');
    expect(all).not.toContain('plop:airport_l');
  });

  it('a saved city with old airports still loads and runs', () => {
    const w = flat();
    ok(w, { t: 'road', x0: 10, y0: 30, x1: 100, y1: 30, road: RoadType.Road });
    ok(w, { t: 'plop', id: 'airport_s', x: 40, y: 24 });
    ok(w, { t: 'road', x0: 10, y0: 90, x1: 120, y1: 90, road: RoadType.Road });
    ok(w, { t: 'plop', id: 'airport_l', x: 60, y: 81 });
    const data = w.serialize();
    const l = World.load(JSON.parse(JSON.stringify(data, (k, v) => (ArrayBuffer.isView(v) ? { t: v.constructor.name, a: Array.from(v as Uint8Array) } : v)), (k, v) => (v && v.t && v.a ? new (globalThis as unknown as Record<string, new (a: number[]) => unknown>)[v.t](v.a) : v)));
    const types = [...l.buildings.values()].map((b) => b.type).sort();
    expect(types).toEqual(['airport_l', 'airport_s']);
    for (const b of l.buildings.values()) {
      let k = 0;
      for (let i = 0; i < l.g.bldg.length; i++) if (l.g.bldg[i] === b.id) k++;
      expect(k).toBe(b.w * b.h);
    }
    for (let d = 0; d < 65; d++) l.stepDay();
    expect(l.buildings.size).toBe(2);
    expect(CIVIC.airport_s.name).toContain('旧');
  });
});

// ---- 街と空港（シミュレーション） ----
// 128×128 の平らな土地：西に住宅・商業・オフィス（またはハイテク工業）、東に空港（陸側が西、滑走路は南北）。
// 空港の敷地は x 86..97, y 35..94。陸側のすぐ外の列 x = 85：北は道路（y 36..56）、駅の前（y 60..69）は線路、南は高速道路
// opts.rail = 住宅地の駅から空港駅まで高架鉄道。opts.link = false なら線路を駅の 1 列手前で止める。opts.hw = 南から都市高速
interface CityOpts { rail?: boolean; link?: boolean; hw?: boolean | RoadType; airport?: boolean; ih?: boolean; days?: number; size?: 1 | 2; fromSouth?: boolean }
const AX = 91, AY = 64, AROT = 4;
function airCity(o: CityOpts) {
  const w = flat();
  const run = (c: Cmd) => w.exec(c).ok;
  for (let y = 20; y <= 104; y += 6) run({ t: 'road', x0: 4, y0: y, x1: 58, y1: y, road: RoadType.Road });
  for (let x = 4; x <= 58; x += 6) run({ t: 'road', x0: x, y0: 20, x1: x, y1: 104, road: RoadType.Street });
  run({ t: 'road', x0: 0, y0: 62, x1: 4, y1: 62, road: RoadType.Road }); // 隣の都市へ
  if (o.rail && o.fromSouth) {
    // 南から、空港の陸側のふちに沿って北へ（駅の前の紫のマスへ、反対側から入る）：住宅地の駅 → 南の外回り → x = 85 を北へ
    run({ t: 'transit', x0: 10, y0: 59, x1: 70, y1: 59, kind: 'erail' });
    run({ t: 'transit', x0: 70, y0: 59, x1: 70, y1: 112, kind: 'erail' });
    run({ t: 'transit', x0: 70, y0: 112, x1: 85, y1: 112, kind: 'erail' });
    run({ t: 'transit', x0: 85, y0: 112, x1: 85, y1: 60, kind: 'erail' });
    ok(w, { t: 'plop', id: 'el_station', x: 24, y: 57 });
    ok(w, { t: 'plop', id: 'el_station', x: 36, y: 57 });
  } else if (o.rail) {
    const col = o.link === false ? 84 : 85;
    run({ t: 'transit', x0: 10, y0: 59, x1: 84, y1: 59, kind: 'erail' });
    if (col === 85) run({ t: 'transit', x0: 84, y0: 59, x1: 85, y1: 60, kind: 'erail' });
    run({ t: 'transit', x0: col, y0: col === 85 ? 60 : 59, x1: col, y1: 68, kind: 'erail' });
    ok(w, { t: 'plop', id: 'el_station', x: 24, y: 57 });
    ok(w, { t: 'plop', id: 'el_station', x: 36, y: 57 });
  }
  run({ t: 'zone', x0: 5, y0: 21, x1: 39, y1: 103, zone: ZoneType.R, den: 1 });
  run({ t: 'zone', x0: 41, y0: 21, x1: 51, y1: 103, zone: ZoneType.C, den: 2 });
  run({ t: 'zone', x0: 53, y0: 21, x1: 57, y1: 103, zone: o.ih ? ZoneType.I : ZoneType.C, den: 1 });
  // 空港への道路
  run({ t: 'road', x0: 58, y0: 44, x1: 85, y1: 44, road: RoadType.Road });
  run({ t: 'road', x0: 85, y0: 36, x1: 85, y1: 56, road: RoadType.Road });
  // 電気と水
  run({ t: 'road', x0: 4, y0: 104, x1: 4, y1: 118, road: RoadType.Road });
  run({ t: 'road', x0: 4, y0: 118, x1: 60, y1: 118, road: RoadType.Road });
  for (let x = 6; x < 60; x += 4) w.exec({ t: 'plop', id: 'nuclear', x, y: 121 });
  for (let x = 8; x <= 56; x += 3) w.exec({ t: 'plop', id: 'pump', x, y: 116 });
  run({ t: 'pline', x0: 12, y0: 119, x1: 12, y1: 105 });
  // 2 マス幅の高速道路（ふつうの高速道路）は 1 列西から引く（陸側のふちに接する）
  const wide = o.hw === RoadType.Highway || o.hw === RoadType.GroundHighway;
  if (o.hw) run({ t: 'road', x0: wide ? 84 : 85, y0: 72, x1: wide ? 84 : 85, y1: 127, road: o.hw === true ? RoadType.UrbanHighway : o.hw });
  // 空港（中）は 18 マス幅：敷地の西のふちを同じ x = 86 にする
  if (o.airport !== false) ok(w, { t: 'plop', id: o.size === 2 ? 'airport_2' : 'airport_1', x: o.size === 2 ? 94 : AX, y: AY, rot: AROT });
  const kinds: GrowKind[] = o.ih ? ['R1', 'R2', 'CS1', 'CS2', 'CO2', 'IH'] : ['R1', 'R2', 'CS1', 'CS2', 'CO2', 'CO3'];
  const days = o.days ?? 540;
  for (let d = 0; d < days; d++) {
    if (d < days - 60) for (const k of kinds) w.demand[k] = Math.max(w.demand[k], 0.85);
    w.stepDay();
  }
  return w;
}
const airportOf = (w: World) => [...w.buildings.values()].find((b) => b.type === 'airport_1' || b.type === 'airport_2')!;

describe('airport in a city', () => {
  let base: World | null = null;
  const city = () => (base ??= airCity({ rail: true }));

  it('passengers come by rail through the airport station', { timeout: 600000 }, () => {
    const w = city();
    const a = airportOf(w).air!;
    console.log('rail city', { pop: w.population(), air: a });
    expect(a.open).toBe(true);
    expect(a.lines).toContain('erail');
    expect(a.pax).toBeGreaterThan(100);
    expect(a.paxRail).toBeGreaterThan(10);
    // 空港駅のそばの線路に乗客がいる
    const g = w.g, N = g.n * g.n;
    expect(w.maps.riders[2 * N + g.idx(80, 59)]).toBeGreaterThan(5);
    // 線路が駅の 1 マス手前で止まっているときは、空港駅は使われない
    const w2 = airCity({ rail: true, link: false, days: 120 });
    const a2 = airportOf(w2).air!;
    expect(a2.lines).toEqual([]);
    expect(a2.paxRail).toBe(0);
  });

  it('an elevated rail line drawn into the station from either side carries passengers (小 and 中)', { timeout: 900000 }, () => {
    for (const size of [1, 2] as const) {
      const w = airCity({ rail: true, fromSouth: true, size, days: 360 });
      const a = airportOf(w).air!;
      expect(a.lines, `size ${size}`).toContain('erail');
      expect(a.paxRail, `size ${size}`).toBeGreaterThan(5);
    }
    // 中は西からも
    const w = airCity({ rail: true, size: 2, days: 360 });
    expect(airportOf(w).air!.lines).toContain('erail');
    expect(airportOf(w).air!.paxRail).toBeGreaterThan(5);
    // 中は同じ街でも利用者が多い（行き先が多い）
    expect(airportOf(w).air!.pax).toBeGreaterThan(airportOf(airCity({ rail: true, days: 360 })).air!.pax);
  });

  it('flights, revenue and upkeep follow the users', { timeout: 600000 }, () => {
    const w = city();
    const a = airportOf(w).air!;
    expect(a.flights).toBe(Math.ceil(a.pax / SPEC.paxPerFlight));
    expect(w.stats.incomeBreakdown.空港).toBe(a.income);
    expect(w.stats.expenseBreakdown.空港).toBe(SPEC.upkeep);
    // 利用者が多いと黒字（維持費を少し上回る）、少ないと赤字
    const at = (pax: number) => pax * AIR_FEE_PAX + Math.ceil(pax / SPEC.paxPerFlight) * AIR_FEE_FLIGHT;
    expect(at(SPEC.paxCap * 0.7)).toBeGreaterThan(SPEC.upkeep);
    expect(at(SPEC.paxCap * 0.7)).toBeLessThan(SPEC.upkeep * 1.6);
    expect(at(300)).toBeLessThan(SPEC.upkeep);
    // 空港があると商業・オフィスの需要が上がる
    expect((w as unknown as { airportBoost: number }).airportBoost).toBeGreaterThan(SPEC.boost * 0.5 - 1e-9);
  });

  it('noise lowers land value along the runway axis', { timeout: 600000 }, () => {
    const w = city(), g = w.g;
    const b = airportOf(w), f = frameOf(b, SPEC);
    // 滑走路は南北：北の端の先（滑走路の延長線の上）と、同じ距離だけ横にずれた所
    const L = airportLayout(1), r = L.runways[0];
    const at = (a: number, c: number) => {
      const X = a * f.cos - c * f.sin + f.cx, Z = a * f.sin + c * f.cos + f.cz;
      return g.idx(Math.floor(X / CELL), Math.floor(Z / CELL));
    };
    const onAxis = at(r.a1 + 300, r.c), off = at(r.a1 + 300, r.c + 700);
    expect(w.maps.noise[onAxis]).toBeGreaterThan(60);
    expect(w.maps.noise[off]).toBe(0);
    // 空港がないときと比べて地価が下がっている
    const w0 = airCity({ rail: true, airport: false, days: 60 });
    w0.recomputeAll();
    w.recomputeAll();
    expect(w.maps.landValue[onAxis]).toBeLessThan(w0.maps.landValue[onAxis] - 15);
  });
});

describe('highway access and air freight', () => {
  it('an urban highway beside the landside connects directly (elevated, ground, one-way)', { timeout: 600000 }, () => {
    for (const t of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway, RoadType.UrbanHighway1W, RoadType.UrbanGroundHighway1W]) {
      const w = airCity({ hw: t, days: 31 });
      expect(airportOf(w).air!.highway, `road ${t}`).toBe(true);
    }
    const w2 = airCity({ days: 31 });
    expect(airportOf(w2).air!.highway).toBe(false);
  });

  it('an ordinary (wide) highway beside the airport does not link', { timeout: 600000 }, () => {
    for (const t of [RoadType.Highway, RoadType.GroundHighway]) {
      const w = airCity({ hw: t, days: 31 });
      const g = w.g;
      // 高速道路は引けている
      let any = false;
      for (let y = 72; y < 128; y++) for (const x of [84, 85, 86]) if (g.road[g.idx(x, y)] === t || g.up[g.idx(x, y)] === t) any = true;
      expect(any, `road ${t} built`).toBe(true);
      // 敷地のふち（x = 86）のすぐ外（x = 85）にある
      let beside = false;
      for (let y = 72; y < 94; y++) if (g.road[g.idx(85, y)] === t || g.up[g.idx(85, y)] === t) beside = true;
      expect(beside, `road ${t} beside`).toBe(true);
      expect(airportOf(w).air!.highway, `road ${t}`).toBe(false);
    }
  });

  it('a share of high-tech freight flies, so fewer trucks head for the map edge', { timeout: 900000 }, () => {
    const withAir = airCity({ ih: true, days: 420 });
    const ih = [...withAir.buildings.values()].filter((b) => b.type === 'IH' && b.state === BState.Normal);
    console.log('IH buildings', ih.length, withAir.tripStats, airportOf(withAir).air);
    expect(ih.length).toBeGreaterThan(3);
    const a = airportOf(withAir).air!;
    expect(a.freight).toBeGreaterThan(0);
    expect(a.cargoFlights).toBeGreaterThan(0);
    // 同じ街で空港を取り壊すと、マップの端へ向かうトラックが増える
    const before = withAir.tripStats.truckExt;
    const b = airportOf(withAir);
    withAir.exec({ t: 'bulldoze', x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 });
    for (let d = 0; d < 30; d++) withAir.stepDay();
    expect(withAir.tripStats.truckExt).toBeGreaterThan(before);
  });
});
