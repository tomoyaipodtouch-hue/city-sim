import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType, ZoneType } from '../src/sim/defs';
import { planLine } from '../src/sim/plan';

// 水のない平らな場所を探す
function findDryArea(w: World, size: number): [number, number] {
  const g = w.g;
  let best: [number, number] = [0, 0], bestScore = Infinity;
  for (let y = 4; y < g.n - size - 4; y += 4)
    for (let x = 4; x < g.n - size - 4; x += 4) {
      let water = 0, lo = Infinity, hi = -Infinity;
      for (let yy = y; yy < y + size; yy++)
        for (let xx = x; xx < x + size; xx++) {
          if (g.isWater(xx, yy)) water++;
          lo = Math.min(lo, g.cellMinH(xx, yy));
          hi = Math.max(hi, g.cellMaxH(xx, yy));
        }
      const score = water * 100 + (hi - lo);
      if (score < bestScore) { bestScore = score; best = [x, y]; }
    }
  return best;
}

function buildTestCity(w: World) {
  const [ox, oy] = findDryArea(w, 40);
  const log: string[] = [];
  const run = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) log.push(`${c.t}: ${r.msg}`);
    return r;
  };
  // 格子状の道路
  for (let k = 0; k <= 40; k += 6) {
    run({ t: 'road', x0: ox, y0: oy + k, x1: ox + 40, y1: oy + k, road: RoadType.Road });
    run({ t: 'road', x0: ox + k, y0: oy, x1: ox + k, y1: oy + 40, road: RoadType.Street });
  }
  // 隣の都市への道路
  run({ t: 'road', x0: ox + 20, y0: oy + 40, x1: ox + 20, y1: w.g.n - 1, road: RoadType.Road });
  // ゾーン
  run({ t: 'zone', x0: ox + 1, y0: oy + 1, x1: ox + 23, y1: oy + 17, zone: ZoneType.R, den: 0 });
  run({ t: 'zone', x0: ox + 1, y0: oy + 19, x1: ox + 23, y1: oy + 23, zone: ZoneType.C, den: 0 });
  run({ t: 'zone', x0: ox + 25, y0: oy + 25, x1: ox + 39, y1: oy + 39, zone: ZoneType.I, den: 0 });
  run({ t: 'zone', x0: ox + 25, y0: oy + 1, x1: ox + 39, y1: oy + 17, zone: ZoneType.R, den: 0 });
  // 発電所と水道
  run({ t: 'plop', id: 'coal', x: ox + 32, y: oy + 20 });
  run({ t: 'plop', id: 'pump', x: ox + 1, y: oy + 26 });
  run({ t: 'pline', x0: ox + 30, y0: oy + 21, x1: ox + 4, y1: oy + 27 });
  return log;
}

describe('simulation', () => {
  it('plans 8-direction lines', () => {
    const w = new World(32);
    const p = planLine(w.g, 2, 2, 10, 6);
    expect(p.cells.length).toBe(9);
    expect(p.dirs.filter((d) => d % 2 === 1).length).toBe(4);
  });

  it('grows a city over several years', { timeout: 60000 }, () => {
    const w = World.create({ name: 'テスト', seed: 12345, style: 'river', difficulty: 1, sandbox: false });
    const log = buildTestCity(w);
    const times: Record<string, number> = {};
    const proto = Object.getPrototypeOf(w);
    for (const k of ['updateTraffic', 'updatePollutionAndLandValue', 'updateServicesMonthly', 'growthStep', 'updatePower', 'updateWater']) {
      const f = proto[k];
      (w as unknown as Record<string, unknown>)[k] = function (this: World, ...a: unknown[]) { const t = performance.now(); const r = f.apply(this, a); times[k] = (times[k] || 0) + performance.now() - t; return r; };
    }
    const t0 = performance.now();
    const rows: string[] = [];
    for (let m = 1; m <= 120; m++) {
      for (let d = 0; d < 30; d++) w.stepDay();
      if (m % 12 === 0) {
        const s = w.stats;
        rows.push(
          `y${m / 12}: pop=${s.population} jobs=${s.jobs} emp=${s.employed} funds=${s.funds} inc=${s.lastIncome} exp=${s.lastExpense} ` +
            `R=${s.demandRCI[0].toFixed(2)} C=${s.demandRCI[1].toFixed(2)} I=${s.demandRCI[2].toFixed(2)} ` +
            `pow=${s.powerDemand}/${s.powerSupply} water=${s.waterDemand}/${s.waterSupply} commute=${s.avgCommute.toFixed(1)} bld=${w.buildings.size}`,
        );
      }
    }
    const ms = performance.now() - t0;
    console.log(log.join('\n'));
    console.log(rows.join('\n'));
    console.log(`10 years: ${ms.toFixed(0)} ms (${(ms / 120).toFixed(1)} ms/month)`, JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)]))));
    const kinds: Record<string, number> = {};
    for (const b of w.buildings.values()) kinds[b.type] = (kinds[b.type] || 0) + 1;
    console.log(kinds);
    const st: Record<string, number> = {};
    for (const b of w.buildings.values()) if (!b.civic) st[`${b.type}:${b.state}`] = (st[`${b.type}:${b.state}`] || 0) + 1;
    console.log('states', JSON.stringify(st));
    const g = w.g;
    const des: Record<string, number[]> = {};
    for (let i = 0; i < g.n * g.n; i++) if (g.zone[i] && !g.bldg[i]) for (const k of ['CS1', 'ID', 'R1'] as const) (des[k] ??= []).push(w.desirability(k, i));
    console.log('desirability', JSON.stringify(Object.fromEntries(Object.entries(des).map(([k, v]) => [k, (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)]))), 'crime', w.stats.services.crime.toFixed(2), 'garbage', JSON.stringify(w.stats.services.garbage));
    expect(w.stats.population).toBeGreaterThan(500);
    expect(w.stats.waterSupply).toBeGreaterThan(0);
  });
});

describe('stage 2a roads', () => {
  it('one-way roads only allow travel forward', () => {
    const w = new World(32);
    w.g.heights.fill(10);
    w.funds = 1e6;
    const r = w.exec({ t: 'road', x0: 2, y0: 5, x1: 10, y1: 5, road: RoadType.OneWay });
    expect(r.ok).toBe(true);
    const a = w.g.idx(4, 5), b = w.g.idx(5, 5);
    expect(w.g.flow[a] & 1).toBe(1); // 東へ進める
    expect(w.g.flow[b] & (1 << 4)).toBe(0); // 西へは進めない
    expect(w.g.conn[b] & (1 << 4)).not.toBe(0); // 見た目はつながっている
  });

  it('avenues create a parallel opposite lane', () => {
    const w = new World(32);
    w.g.heights.fill(10);
    w.funds = 1e6;
    const r = w.exec({ t: 'road', x0: 2, y0: 10, x1: 12, y1: 10, road: RoadType.Avenue });
    expect(r.ok).toBe(true);
    const south = w.g.idx(6, 10), north = w.g.idx(6, 9);
    expect(w.g.road[south]).toBe(RoadType.Avenue);
    expect(w.g.road[north]).toBe(RoadType.Avenue);
    expect(w.g.flow[south] & 1).toBe(1); // 南側の車線は東向き
    expect(w.g.flow[north] & (1 << 4)).not.toBe(0); // 北側の車線は西向き
    expect(w.g.flow[north] & 1).toBe(0);
  });

  it('builds a bridge across water', () => {
    const w = new World(32);
    const V = 33;
    for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= 12 && x <= 16 ? -4 : 6;
    w.funds = 1e6;
    const bad = w.exec({ t: 'road', x0: 5, y0: 8, x1: 14, y1: 8, road: RoadType.Road });
    expect(bad.ok).toBe(false); // 水の上で終わる
    const r = w.exec({ t: 'road', x0: 5, y0: 8, x1: 22, y1: 8, road: RoadType.Road });
    expect(r.ok).toBe(true);
    expect(w.g.deck[w.g.idx(14, 8)]).toBeGreaterThan(3);
    expect(w.g.road[w.g.idx(14, 8)]).toBe(RoadType.Road);
  });

  it('grows taller buildings in dense zones', { timeout: 60000 }, () => {
    const w = World.create({ name: 'dense', seed: 777, style: 'river', difficulty: 0, sandbox: true });
    buildTestCity(w);
    // 中心部を高密度に指定し直す
    const g = w.g;
    let dense = 0;
    for (let i = 0; i < g.n * g.n; i++) if (g.zone[i] === ZoneType.R || g.zone[i] === ZoneType.C) { g.zden[i] = 2; dense++; }
    expect(dense).toBeGreaterThan(0);
    for (let m = 0; m < 180; m++) for (let d = 0; d < 30; d++) w.stepDay();
    let maxFloors = 0, offices = 0;
    for (const b of w.buildings.values()) {
      maxFloors = Math.max(maxFloors, b.floors);
      if (b.type === 'CO2' || b.type === 'CO3') offices++;
    }
    console.log(`dense: pop=${w.stats.population} jobs=${w.stats.jobs} maxFloors=${maxFloors} offices=${offices} buildings=${w.buildings.size}`);
    expect(maxFloors).toBeGreaterThan(6);
    expect(w.stats.population).toBeGreaterThan(5000);
  });
});

describe('stage 2b highways', () => {
  const flat = () => {
    const w = new World(48);
    w.g.heights.fill(10);
    w.funds = 1e7;
    return w;
  };
  // 2つのノード間で、通れる経路があるか
  const reachable = (w: World, from: number, to: number) => {
    // to が上空のノード番号なら、階層も一致させる
    const seen = new Set<number>([from]);
    const q = [from];
    const N = w.g.n * w.g.n;
    while (q.length) {
      const u = q.pop()!;
      if (to >= N ? u === to : u % N === to) return true;
      w.g.forEachOut(u, (v) => { if (!seen.has(v)) { seen.add(v); q.push(v); } });
    }
    return false;
  };

  it('roads cross a ground highway with an overpass and do not connect to it', () => {
    const w = flat();
    expect(w.exec({ t: 'road', x0: 2, y0: 20, x1: 40, y1: 20, road: RoadType.GroundHighway }).ok).toBe(true);
    const r = w.exec({ t: 'road', x0: 20, y0: 10, x1: 20, y1: 30, road: RoadType.Road });
    expect(r.ok).toBe(true);
    const c = w.g.idx(20, 20);
    expect(w.g.road[c]).toBe(RoadType.GroundHighway);
    expect(w.g.up[c]).toBe(RoadType.Road); // 立体交差
    // 一般道から高速道路には入れない
    const N = w.g.n * w.g.n;
    let entersHighway = false;
    w.g.forEachOut(w.g.idx(20, 18), (v) => { if (v < N && w.g.road[v] === RoadType.GroundHighway) entersHighway = true; });
    expect(entersHighway).toBe(false);
    // 一般道は南北につながっている
    expect(reachable(w, w.g.idx(20, 12), w.g.idx(20, 28))).toBe(true);
  });

  it('a ground highway drawn over an existing road turns the road into an overpass', () => {
    const w = flat();
    expect(w.exec({ t: 'road', x0: 20, y0: 5, x1: 20, y1: 40, road: RoadType.Road }).ok).toBe(true);
    expect(w.exec({ t: 'road', x0: 2, y0: 20, x1: 40, y1: 20, road: RoadType.GroundHighway }).ok).toBe(true);
    expect(w.g.up[w.g.idx(20, 20)]).toBe(RoadType.Road);
    expect(w.g.up[w.g.idx(20, 19)]).toBe(RoadType.Road);
    expect(reachable(w, w.g.idx(20, 6), w.g.idx(20, 38))).toBe(true);
  });

  it('ramps connect roads and highways', () => {
    const w = flat();
    w.exec({ t: 'road', x0: 2, y0: 20, x1: 45, y1: 20, road: RoadType.GroundHighway });
    w.exec({ t: 'road', x0: 10, y0: 21, x1: 10, y1: 35, road: RoadType.Road });
    // 南側の車線（東向き）の横、一般道の隣にランプ
    const r = w.exec({ t: 'ramp', x: 11, y: 21 });
    expect(r.ok).toBe(true);
    expect(reachable(w, w.g.idx(10, 34), w.g.idx(44, 20))).toBe(true); // 一般道 → 高速道路
    expect(reachable(w, w.g.idx(4, 20), w.g.idx(10, 34))).toBe(true); // 高速道路 → 一般道
  });

  it('elevated highways pass over roads and the diamond interchange connects them', () => {
    const w = flat();
    w.exec({ t: 'road', x0: 20, y0: 2, x1: 20, y1: 45, road: RoadType.Street });
    expect(w.exec({ t: 'road', x0: 2, y0: 24, x1: 45, y1: 24, road: RoadType.Highway }).ok).toBe(true);
    const c = w.g.idx(20, 24);
    expect(w.g.road[c]).toBe(RoadType.Street);
    expect(w.g.up[c]).toBe(RoadType.Highway);
    expect(w.g.upH[c]).toBeGreaterThan(15);
    const d = w.exec({ t: 'diamond', x: 30, y: 24 });
    expect(d.ok, d.msg).toBe(true);
    const N = w.g.n * w.g.n;
    // 一般道は 30 列目の y=18..29。南の端から東向きの車線（y=24）へ、北の端へも行ける
    expect(reachable(w, w.g.idx(30, 29), N + w.g.idx(44, 24))).toBe(true);
    expect(reachable(w, N + w.g.idx(4, 24), w.g.idx(30, 18))).toBe(true);
    expect(reachable(w, N + w.g.idx(44, 23), w.g.idx(30, 29))).toBe(true);
  });

  it('turn restrictions block movements', () => {
    const w = flat();
    w.exec({ t: 'road', x0: 5, y0: 20, x1: 35, y1: 20, road: RoadType.Road });
    w.exec({ t: 'road', x0: 20, y0: 5, x1: 20, y1: 35, road: RoadType.Road });
    const c = w.g.idx(20, 20);
    expect(w.exec({ t: 'junction', cell: c, ctl: 3, split: 70, flags: 16 }).ok).toBe(true);
    expect(w.g.ictl[c]).toBe(3);
    expect(w.g.iflags[c]).toBe(16);
  });
});

describe('bulldoze', () => {
  it('removes elevated highways and overpasses', () => {
    const w = new World(48);
    w.g.heights.fill(10);
    w.funds = 1e7;
    w.exec({ t: 'road', x0: 20, y0: 2, x1: 20, y1: 45, road: RoadType.Street });
    w.exec({ t: 'road', x0: 2, y0: 24, x1: 45, y1: 24, road: RoadType.Highway });
    expect(w.g.up[w.g.idx(10, 24)]).toBe(RoadType.Highway);
    const r = w.exec({ t: 'bulldoze', x0: 8, y0: 22, x1: 12, y1: 26 });
    expect(r.ok).toBe(true);
    expect(w.g.up[w.g.idx(10, 24)]).toBe(0);
    expect(w.g.up[w.g.idx(10, 23)]).toBe(0);
    // 隣のマスの接続も消えている
    expect(w.g.conn1[w.g.idx(13, 24)] & (1 << 4)).toBe(0);
  });
});

describe('cloverleaf', () => {
  it('connects all 8 movements between a ground and an elevated highway', () => {
    const w = new World(64);
    w.g.heights.fill(10);
    w.funds = 1e8;
    expect(w.exec({ t: 'road', x0: 1, y0: 32, x1: 62, y1: 32, road: RoadType.GroundHighway }).ok).toBe(true);
    expect(w.exec({ t: 'road', x0: 32, y0: 1, x1: 32, y1: 62, road: RoadType.Highway }).ok).toBe(true);
    const r = w.exec({ t: 'clover', x: 32, y: 32 });
    expect(r.ok, r.msg).toBe(true);
    const g = w.g, N = g.n * g.n;
    // 4つの端（地上の高速道路は地上、高架は上空）
    const reach = (from: number) => {
      const seen = new Set<number>([from]);
      const q = [from];
      while (q.length) {
        const u = q.pop()!;
        g.forEachOut(u, (v) => { if (!seen.has(v)) { seen.add(v); q.push(v); } });
      }
      return seen;
    };
    // 東向き車線（y=32）の西の端から、高架の北の端・南の端の両方へ行ける
    const ewLane = [g.idx(2, 32), g.idx(2, 31)].find((c) => g.flow[c] & 1)!;
    const ns = [g.idx(32, 2), g.idx(33, 2), g.idx(31, 2)].map((c) => N + c).filter((v) => g.up[v - N]);
    const ss = [g.idx(32, 61), g.idx(33, 61), g.idx(31, 61)].map((c) => N + c).filter((v) => g.up[v - N]);
    const seen = reach(ewLane);
    expect(ns.some((v) => seen.has(v))).toBe(true);
    expect(ss.some((v) => seen.has(v))).toBe(true);
  });
});

describe('stage 3a transit', () => {
  it('residents ride the train between distant areas', { timeout: 60000 }, () => {
    const w = new World(96);
    w.g.heights.fill(10);
    w.funds = 1e8;
    w.sandbox = true;
    const ok = (c: Parameters<World['exec']>[0]) => {
      const r = w.exec(c);
      if (!r.ok) throw new Error(`${c.t}: ${r.msg}`);
    };
    // 西の住宅地と東の工業地を、遠回りの道路と、まっすぐな鉄道で結ぶ
    for (const [x0, x1] of [[4, 20], [70, 86]]) {
      for (let k = 0; k <= 16; k += 4) ok({ t: 'road', x0, y0: 40 + k, x1, y1: 40 + k, road: RoadType.Street });
      for (let k = 0; k <= 16; k += 4) ok({ t: 'road', x0: x0 + k, y0: 40, x1: x0 + k, y1: 56, road: RoadType.Street });
    }
    ok({ t: 'road', x0: 4, y0: 56, x1: 4, y1: 90, road: RoadType.Street });
    ok({ t: 'road', x0: 4, y0: 90, x1: 86, y1: 90, road: RoadType.Street });
    ok({ t: 'road', x0: 86, y0: 90, x1: 86, y1: 56, road: RoadType.Street });
    ok({ t: 'zone', x0: 5, y0: 41, x1: 19, y1: 55, zone: ZoneType.R, den: 1 });
    ok({ t: 'zone', x0: 71, y0: 41, x1: 85, y1: 55, zone: ZoneType.I, den: 1 });
    ok({ t: 'transit', x0: 22, y0: 38, x1: 68, y1: 38, kind: 'rail' });
    ok({ t: 'road', x0: 20, y0: 36, x1: 20, y1: 40, road: RoadType.Street });
    ok({ t: 'road', x0: 70, y0: 36, x1: 70, y1: 40, road: RoadType.Street });
    ok({ t: 'plop', id: 'station', x: 21, y: 36 });
    ok({ t: 'plop', id: 'station', x: 68, y: 36 });
    ok({ t: 'plop', id: 'coal', x: 12, y: 70 });
    ok({ t: 'pline', x0: 10, y0: 70, x1: 5, y1: 70 });
    ok({ t: 'plop', id: 'pump', x: 6, y: 60 });
    const t0 = performance.now();
    for (let m = 0; m < 48; m++) for (let d = 0; d < 30; d++) w.stepDay();
    const ms = (performance.now() - t0) / 48;
    const s = w.stats;
    console.log(`transit: pop=${s.population} riders=${s.transitRiders} share=${JSON.stringify(s.modeShare)} ${ms.toFixed(1)} ms/month`);
    expect(s.population).toBeGreaterThan(500);
    expect(s.transitRiders).toBeGreaterThan(20);
  });
});

describe('stage 3b water and air', () => {
  // 西と東の陸地を、南北に流れる川（x=44..51）で分けたマップ
  const island = () => {
    const w = new World(96);
    const V = 97;
    for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= 44 && x <= 52 ? -4 : 8;
    w.sandbox = true;
    return w;
  };
  const ok = (w: World, c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) throw new Error(`${c.t}: ${r.msg}`);
    return r;
  };

  it('car ferries connect land areas across water', { timeout: 60000 }, () => {
    const w = island();
    ok(w, { t: 'road', x0: 10, y0: 40, x1: 40, y1: 40, road: RoadType.Road });
    ok(w, { t: 'road', x0: 56, y0: 40, x1: 86, y1: 40, road: RoadType.Road });
    ok(w, { t: 'zone', x0: 10, y0: 41, x1: 38, y1: 44, zone: ZoneType.R, den: 0 });
    ok(w, { t: 'zone', x0: 58, y0: 41, x1: 86, y1: 44, zone: ZoneType.I, den: 0 });
    ok(w, { t: 'plop', id: 'ferry_c', x: 41, y: 38 });
    ok(w, { t: 'plop', id: 'ferry_c', x: 54, y: 38 });
    for (const x of [20, 70]) {
      ok(w, { t: 'plop', id: 'coal', x, y: 37 });
      ok(w, { t: 'plop', id: 'pump', x: x + 6, y: 38 });
    }
    for (let m = 0; m < 36; m++) for (let d = 0; d < 30; d++) w.stepDay();
    const fb = [...w.buildings.values()].find((b) => b.type === 'ferry_c')!;
    console.log(`ferry: pop=${w.stats.population} employed=${w.stats.employed} note=${fb.note}`);
    expect(fb.note).toContain('航路 1 本');
    expect(w.stats.employed).toBeGreaterThan(50);
  });

  it('a seaport on open water raises industrial demand and takes freight', () => {
    const w = island();
    ok(w, { t: 'road', x0: 10, y0: 40, x1: 40, y1: 40, road: RoadType.Road });
    const before = w.exec({ t: 'plop', id: 'seaport', x: 40, y: 42 });
    expect(before.ok, before.msg).toBe(true);
    for (let m = 0; m < 2; m++) for (let d = 0; d < 30; d++) w.stepDay();
    const port = [...w.buildings.values()].find((b) => b.type === 'seaport')!;
    expect(port.note).toContain('外洋');
  });
});

describe('stage 4a services', () => {
  const town = () => {
    const w = World.create({ name: 's', seed: 12345, style: 'river', difficulty: 0, sandbox: true });
    buildTestCity(w);
    return w;
  };
  const months = (w: World, m: number) => { for (let k = 0; k < m * 30; k++) w.stepDay(); };
  // 道路に接する空き地を探して施設を置く
  const place = (w: World, id: 'police_l' | 'school_e' | 'landfill' | 'clinic') => {
    const g = w.g;
    // 住宅の中心に近い順に空き地を探す
    let sx = 0, sy = 0, c = 0;
    for (const b of w.buildings.values()) if (!b.civic && String(b.type).startsWith('R')) { sx += b.x; sy += b.y; c++; }
    const cx = Math.round(sx / Math.max(1, c)), cy = Math.round(sy / Math.max(1, c));
    const spots: [number, number][] = [];
    for (let y = 2; y < g.n - 2; y++) for (let x = 2; x < g.n - 2; x++) spots.push([x, y]);
    spots.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
    for (const [x, y] of spots) {
      const i = g.idx(x, y);
      if (g.road[i] || g.bldg[i] || g.isWater(x, y)) continue;
      if (w.exec({ t: 'plop', id, x, y }).ok) return true;
    }
    return false;
  };

  it('police lowers crime, schools raise education, landfills handle garbage', { timeout: 120000 }, () => {
    const a = town(), b = town();
    months(a, 24);
    months(b, 24);
    expect(place(b, 'police_l')).toBe(true);
    expect(place(b, 'police_l')).toBe(true);
    expect(place(b, 'school_e')).toBe(true);
    expect(place(b, 'landfill')).toBe(true);
    months(a, 24);
    months(b, 24);
    const sa = a.stats.services, sb = b.stats.services;
    console.log(`services: crime ${sa.crime.toFixed(2)} → ${sb.crime.toFixed(2)}, childEQ ${sa.eq.child.toFixed(0)} → ${sb.eq.child.toFixed(0)}, garbage excess ${sa.garbage.excess} → ${sb.garbage.excess}`);
    expect(sb.crime).toBeLessThan(sa.crime);
    expect(sb.eq.child).toBeGreaterThan(sa.eq.child + 10);
    expect(sb.garbage.excess).toBeLessThan(sa.garbage.excess);
  });

  it('low funding leads to a strike', () => {
    const w = town();
    w.exec({ t: 'funding', dept: 'police', value: 30 });
    months(w, 7);
    expect(w.stats.services.strike.police).toBeGreaterThan(0);
  });
});
