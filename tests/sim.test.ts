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

  it('grows a city over several years', () => {
    const w = World.create({ name: 'テスト', seed: 12345, style: 'river', difficulty: 1, sandbox: false });
    const log = buildTestCity(w);
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
    console.log(`10 years: ${ms.toFixed(0)} ms`);
    const kinds: Record<string, number> = {};
    for (const b of w.buildings.values()) kinds[b.type] = (kinds[b.type] || 0) + 1;
    console.log(kinds);
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

  it('grows taller buildings in dense zones', () => {
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
