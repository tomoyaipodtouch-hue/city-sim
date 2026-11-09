import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { plantPower, RoadType, ZoneType } from '../src/sim/defs';
import { planLine } from '../src/sim/plan';
import { buildTestCity } from './helpers';
import { assignTrips, buildJunctions, urbanTurnOk } from '../src/sim/traffic';

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

  it('terrain tools raise, lower and level the ground but not under roads', () => {
    const w = new World(32);
    w.g.heights.fill(6);
    w.funds = 1e6;
    w.exec({ t: 'road', x0: 2, y0: 10, x1: 20, y1: 10, road: RoadType.Street });
    const roadH = w.g.vh(10, 10);
    expect(w.exec({ t: 'terrain', op: 'raise', x0: 5, y0: 5, x1: 8, y1: 12 }).ok).toBe(true);
    expect(w.g.vh(6, 6)).toBeCloseTo(9);
    expect(w.g.vh(6, 10)).toBeCloseTo(roadH); // 道路の頂点は動かない
    expect(w.g.vh(11, 6)).toBeGreaterThan(6); // まわりはなだらか
    expect(w.g.vh(11, 6)).toBeLessThan(9);
    // 下げて水にすると、ゾーンがなくなる
    w.exec({ t: 'zone', x0: 20, y0: 20, x1: 22, y1: 22, zone: ZoneType.R, den: 0 });
    for (let k = 0; k < 4; k++) w.exec({ t: 'terrain', op: 'lower', x0: 20, y0: 20, x1: 22, y1: 22 });
    expect(w.g.isWater(21, 21)).toBe(true);
    expect(w.g.zone[w.g.idx(21, 21)]).toBe(0);
    // 平らにする：始点の高さにそろう
    expect(w.exec({ t: 'terrain', op: 'level', x0: 4, y0: 4, x1: 9, y1: 6 }).ok).toBe(true);
    const h0 = w.g.vh(5, 5);
    expect(w.g.vh(9, 5)).toBeCloseTo(h0);
  });

  it('new power plants supply power; wind turbines produce more on high ground', () => {
    const w = new World(48);
    w.g.heights.fill(6);
    w.funds = 1e6;
    for (const [id, x, y] of [['nuclear', 2, 2], ['solar', 10, 2], ['oil', 16, 2], ['wind', 24, 2]] as const) expect(w.exec({ t: 'plop', id, x, y }).ok).toBe(true);
    w.updateStats();
    expect(w.stats.powerSupply).toBe(3600 + 300 + 700 + plantPower('wind', 6));
    expect(plantPower('wind', 40)).toBeGreaterThan(plantPower('wind', 6));
    expect(plantPower('wind', 200)).toBe(64);
  });

  it('long parks turn so their long side faces the road', () => {
    const w = new World(32);
    w.g.heights.fill(6);
    w.funds = 1e6;
    w.exec({ t: 'road', x0: 2, y0: 10, x1: 28, y1: 10, road: RoadType.Street });
    expect(w.exec({ t: 'plop', id: 'greenway', x: 10, y: 11 }).ok).toBe(true);
    const b = [...w.buildings.values()].find((x) => x.type === 'greenway')!;
    expect([b.w, b.h]).toEqual([3, 1]);
    expect(w.exec({ t: 'plop', id: 'sports', x: 20, y: 11 }).ok).toBe(true);
    const s2 = [...w.buildings.values()].find((x) => x.type === 'sports')!;
    expect([s2.w, s2.h]).toEqual([3, 2]);
  });

  it('continuing an avenue does not leave a junction, even if the tap is on the other lane', () => {
    for (const startY of [10, 9]) {
      const w = new World(32);
      w.g.heights.fill(6);
      w.funds = 1e6;
      expect(w.exec({ t: 'road', x0: 2, y0: 10, x1: 10, y1: 10, road: RoadType.Avenue }).ok).toBe(true);
      // 続きを引く（2回目は、わざと反対車線のマスから始める）
      expect(w.exec({ t: 'road', x0: 10, y0: startY, x1: 18, y1: 10, road: RoadType.Avenue }).ok).toBe(true);
      const g = w.g, idx = (x: number, y: number) => g.idx(x, y);
      // 大通りの座標は格子点（なぞった線が中心線）。1本目はマス 2..9、2本目はマス 10..17
      // つなぎ目に、車線どうしの折り返しが残っていない
      for (const x of [9, 10]) {
        expect(g.conn[idx(x, 10)] & (1 << 6)).toBe(0);
        expect(g.conn[idx(x, 9)] & (1 << 2)).toBe(0);
      }
      // 車線は2本だけ（3本目ができていない）
      expect(g.road[idx(14, 8)]).toBe(0);
      expect(g.road[idx(14, 11)]).toBe(0);
      // 向こうの端には折り返しがある
      expect(g.conn[idx(17, 10)] & (1 << 6)).not.toBe(0);
    }
  });

  it('a road drawn from next to a dead end connects to it', () => {
    const w = new World(32);
    w.g.heights.fill(6);
    w.funds = 1e6;
    w.exec({ t: 'road', x0: 2, y0: 10, x1: 10, y1: 10, road: RoadType.Road });
    // 行き止まりの斜め隣から引き始める
    expect(w.exec({ t: 'road', x0: 11, y0: 11, x1: 18, y1: 11, road: RoadType.Road }).ok).toBe(true);
    expect(w.g.conn[w.g.idx(10, 10)]).not.toBe(1 << 4);
  });

  it('urban highways (one lane each way) connect directly to ordinary roads at their ends', () => {
    for (const type of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway]) {
      const w = new World(48);
      w.g.heights.fill(6);
      w.funds = 1e6;
      const g = w.g;
      w.exec({ t: 'road', x0: 4, y0: 10, x1: 4, y1: 30, road: RoadType.Road });
      w.exec({ t: 'road', x0: 40, y0: 10, x1: 40, y1: 30, road: RoadType.Road });
      // 一般道から一般道へ、都市高速を引く（両端は一般道のまま、つながる）
      const r = w.exec({ t: 'road', x0: 4, y0: 20, x1: 40, y1: 20, road: type });
      expect(r.ok).toBe(true);
      expect(g.road[g.idx(4, 20)]).toBe(RoadType.Road);
      expect(g.conn[g.idx(4, 20)] & 1).not.toBe(0);
      // 両方向に通れる（片側1車線）
      const mid = g.idx(22, 20);
      const lvl = type === RoadType.UrbanHighway ? 1 : 0;
      const flow = lvl ? g.flow1[mid] : g.flow[mid];
      expect(flow & 1).not.toBe(0);
      expect(flow & (1 << 4)).not.toBe(0);
      if (lvl) {
        // 高架は真ん中で高く、端に向かって下がる
        expect(g.upH[mid]).toBeGreaterThan(g.upH[g.idx(6, 20)]);
      }
    }
  });

  it('a wide highway ending across a road connects to it, and a road can continue from a highway end', () => {
    const w = new World(48);
    w.g.heights.fill(6);
    w.funds = 1e6;
    const g = w.g;
    w.exec({ t: 'road', x0: 30, y0: 5, x1: 30, y1: 40, road: RoadType.Road });
    expect(w.exec({ t: 'road', x0: 4, y0: 20, x1: 30, y1: 20, road: RoadType.GroundHighway }).ok).toBe(true);
    expect(g.road[g.idx(30, 20)]).toBe(RoadType.Road);
    expect(g.road[g.idx(30, 19)]).toBe(RoadType.Road);
    expect(g.conn[g.idx(30, 20)] & (1 << 4)).not.toBe(0);
    // 高速道路の行き止まりの端から一般道を続ける
    expect(w.exec({ t: 'road', x0: 4, y0: 20, x1: 4, y1: 35, road: RoadType.Road }).ok).toBe(true);
  });

  it('a two-way road continuing from an avenue end links each direction to the right lane', () => {
    const w = new World(32);
    w.g.heights.fill(6);
    w.funds = 1e6;
    const g = w.g, idx = (x: number, y: number) => g.idx(x, y);
    // 大通りの座標は格子点：マス 2..11。東向きの車線は y=10、西向きは y=9
    w.exec({ t: 'road', x0: 2, y0: 10, x1: 12, y1: 10, road: RoadType.Avenue });
    expect(w.exec({ t: 'road', x0: 12, y0: 10, x1: 22, y1: 10, road: RoadType.Road }).ok).toBe(true);
    // 東向き：大通り(11,10) → 道路(12,10)
    expect(g.flow[idx(11, 10)] & (1 << 0)).not.toBe(0);
    // 西向き：道路(12,10) → 大通り(11,9)（斜め）。道路から(11,10)へは入らない
    expect(g.flow[idx(12, 10)] & (1 << 5)).not.toBe(0);
    expect(g.flow[idx(12, 10)] & (1 << 4)).toBe(0);
    // 端の折り返しはない
    expect(g.conn[idx(11, 10)] & (1 << 6)).toBe(0);
  });

  it('two diagonal roads crossing between cells get a junction', () => {
    const w = new World(32);
    w.g.heights.fill(6);
    w.funds = 1e6;
    const g = w.g;
    // ＼ の向き（10,10 → 20,20）と、／ の向き（17,10 → 7,20）。マスの角で交わる
    expect(w.exec({ t: 'road', x0: 10, y0: 10, x1: 20, y1: 20, road: RoadType.Road }).ok).toBe(true);
    const r = w.exec({ t: 'road', x0: 17, y0: 10, x1: 7, y1: 20, road: RoadType.Road });
    expect(r.ok).toBe(true);
    // まっすぐ X 字に交わる（回り道しない）：交わる角の4マスは、斜めにだけつながる
    for (const [x, y] of [[13, 13], [14, 14], [14, 13], [13, 14]]) expect(g.conn[g.idx(x, y)] & 0b01010101).toBe(0);
  });

  it('urban highway ramps (1x5) connect a road at the middle to one direction of the highway', () => {
    for (const type of [RoadType.UrbanGroundHighway, RoadType.UrbanHighway]) {
      const w = new World(48);
      w.g.heights.fill(6);
      w.funds = 1e6;
      const g = w.g;
      expect(w.exec({ t: 'road', x0: 2, y0: 20, x1: 45, y1: 20, road: type }).ok).toBe(true);
      // 南側（東向きの車線の側）に置く。真ん中は (20, 21)。外側の一般道は南へ
      expect(w.exec({ t: 'road', x0: 20, y0: 22, x1: 20, y1: 35, road: RoadType.Road }).ok).toBe(true);
      const r = w.exec({ t: 'uramp', x: 20, y: 21 });
      expect(r.ok).toBe(true);
      // 一般道を後から引いても、真ん中のマスはランプのまま
      expect(g.road[g.idx(20, 21)]).toBe(RoadType.Ramp);
      // 出口：本線(17,20) → (18,21)、入口：(22,21) → 本線(23,20)
      const L = type === RoadType.UrbanHighway ? 1 : 0;
      const f0 = L ? g.flow1 : g.flow;
      expect(f0[g.idx(17, 20)] & (1 << 1)).not.toBe(0);
      const fe = L ? g.flow1 : g.flow;
      expect(fe[g.idx(22, 21)] & (1 << 7)).not.toBe(0);
      // 真ん中から一般道へ
      expect(g.flow[g.idx(20, 21)] & (1 << 2)).not.toBe(0);
      // 北側に置くと、西向きの車線用になる。同じ場所の反対側にも置ける
      expect(w.exec({ t: 'uramp', x: 20, y: 19 }).ok).toBe(true);
      expect(f0[g.idx(23, 20)] & (1 << 5)).not.toBe(0);
      expect(w.exec({ t: 'uramp', x: 30, y: 19 }).ok).toBe(true);
      expect(f0[g.idx(33, 20)] & (1 << 5)).not.toBe(0);
    }
  });

  it('a road drawn later alongside an urban highway ramp connects to its middle', () => {
    for (const type of [RoadType.UrbanGroundHighway, RoadType.UrbanHighway]) {
      const w = new World(48);
      w.g.heights.fill(6);
      w.funds = 1e6;
      const g = w.g;
      expect(w.exec({ t: 'road', x0: 2, y0: 20, x1: 45, y1: 20, road: type }).ok).toBe(true);
      expect(w.exec({ t: 'uramp', x: 20, y: 21 }).ok).toBe(true);
      // ランプの外側に平行な一般道を後から引く
      expect(w.exec({ t: 'road', x0: 5, y0: 22, x1: 40, y1: 22, road: RoadType.Road }).ok).toBe(true);
      expect(g.flow[g.idx(20, 21)] & (1 << 2)).not.toBe(0);
      expect(g.flow[g.idx(20, 22)] & (1 << 6)).not.toBe(0);
      // ランプの端のマスは一般道とつながらない
      expect(g.conn[g.idx(18, 21)] & (1 << 2)).toBe(0);
    }
  });

  it('one-way two-lane urban highways run only in the drawn direction and take ramps on either side', () => {
    for (const type of [RoadType.UrbanGroundHighway1W, RoadType.UrbanHighway1W]) {
      const w = new World(48);
      w.g.heights.fill(6);
      w.funds = 1e6;
      const g = w.g;
      const L = type === RoadType.UrbanHighway1W ? 1 : 0;
      const fl = L ? g.flow1 : g.flow;
      // 東向きに引く
      expect(w.exec({ t: 'road', x0: 2, y0: 20, x1: 45, y1: 20, road: type }).ok).toBe(true);
      expect(fl[g.idx(20, 20)] & 1).not.toBe(0);
      expect(fl[g.idx(20, 20)] & (1 << 4)).toBe(0);
      // 南側にも北側にもランプを置ける（どちらも東向き：西の端が出口、東の端が入口）
      expect(w.exec({ t: 'uramp', x: 15, y: 21 }).ok).toBe(true);
      expect(fl[g.idx(12, 20)] & (1 << 1)).not.toBe(0);
      expect(w.exec({ t: 'uramp', x: 30, y: 19 }).ok).toBe(true);
      expect(fl[g.idx(27, 20)] & (1 << 7)).not.toBe(0);
      // ランプの外側の一般道（後から引く）と、東へ向かう車
      expect(w.exec({ t: 'road', x0: 15, y0: 22, x1: 15, y1: 30, road: RoadType.Road }).ok).toBe(true);
      expect(w.exec({ t: 'road', x0: 30, y0: 18, x1: 30, y1: 10, road: RoadType.Road }).ok).toBe(true);
      const N = g.n * g.n;
      const J = buildJunctions(g, new Float32Array(2 * N));
      const go = (from: number, to: number) => assignTrips(g, [{ cell: from, trips: 10, buildings: [{ id: 9, trips: 10 }] }], new Map([[to, [{ id: 1, free: 10 }]]]), new Float32Array(2 * N).fill(1), J, () => 0.5, { externalCap: 0, maxMinutes: 120, weight: 1 }).filled.get(1);
      expect(go(g.idx(15, 30), g.idx(30, 10))).toBe(10);
      // 逆向き（西へ）には走れない
      expect(go(g.idx(30, 10), g.idx(15, 30))).toBeUndefined();
    }
  });

  it('the skyline peaks at the middle of each high-density district', () => {
    const w = new World(96);
    const g = w.g;
    // 2つの高密度地区（30×30 と 20×20）
    for (const [x0, y0, sz] of [[5, 5, 30], [60, 60, 20]])
      for (let y = y0; y < y0 + sz; y++) for (let x = x0; x < x0 + sz; x++) { g.zone[g.idx(x, y)] = ZoneType.C; g.zden[g.idx(x, y)] = 2; }
    const core = w.coreMap(true);
    // それぞれの地区の真ん中が、端より高い
    expect(core[g.idx(20, 20)]).toBeGreaterThan(core[g.idx(6, 6)] + 0.3);
    expect(core[g.idx(70, 70)]).toBeGreaterThan(core[g.idx(61, 61)] + 0.3);
    // 小さい地区にも、ちゃんと山ができる
    expect(core[g.idx(70, 70)]).toBeGreaterThan(0.7);
  });

  it('offices prefer the middle of a high-density district, shops its edge', () => {
    const w = new World(64);
    const g = w.g;
    for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) { g.zone[g.idx(x, y)] = ZoneType.C; g.zden[g.idx(x, y)] = 2; }
    w.coreMap(true);
    const mid = g.idx(25, 25), edge = g.idx(11, 11);
    const lean = (i: number) => w.desirability('CO3', i) - w.desirability('CS2', i);
    expect(lean(mid)).toBeGreaterThan(lean(edge) + 0.3);
  });

  it('track-only elevated stations go on straight (also diagonal) elevated track over a road', () => {
    for (const diag of [false, true]) {
      const w = new World(48);
      w.g.heights.fill(6);
      w.funds = 1e6;
      const g = w.g;
      const [x0, y0, x1, y1] = diag ? [5, 5, 35, 35] : [5, 20, 40, 20];
      expect(w.exec({ t: 'road', x0, y0, x1, y1, road: RoadType.Road }).ok).toBe(true);
      expect(w.exec({ t: 'transit', x0, y0, x1, y1, kind: 'erail' }).ok).toBe(true);
      const [mx, my] = diag ? [20, 20] : [20, 20];
      const r = w.exec({ t: 'estop', x: mx, y: my });
      expect(r.ok).toBe(true);
      let k = 0;
      for (let i = 0; i < g.n * g.n; i++) if (g.estn[i]) k++;
      expect(k).toBe(4);
      // もう一度タップすると外れる
      expect(w.exec({ t: 'estop', x: mx, y: my }).ok).toBe(true);
      expect(g.estn.some((v) => v)).toBe(false);
      // 線路のないところには置けない
      expect(w.exec({ t: 'estop', x: 2, y: 44 }).ok).toBe(false);
    }
  });

  it('farm zones get one farmhouse per 8x8 tile, without power', () => {
    const w = new World(48);
    w.g.heights.fill(6);
    w.funds = 1e7;
    // 道路の南側に 16×8 の農地（区画 2 つ分）
    expect(w.exec({ t: 'road', x0: 0, y0: 15, x1: 47, y1: 15, road: RoadType.Road }).ok).toBe(true);
    expect(w.exec({ t: 'zone', x0: 16, y0: 16, x1: 31, y1: 23, zone: ZoneType.F, den: 0 }).ok).toBe(true);
    // 人口がいないと需要が出ないので、住宅も少し
    expect(w.exec({ t: 'zone', x0: 0, y0: 10, x1: 30, y1: 14, zone: ZoneType.R, den: 0 }).ok).toBe(true);
    w.demand.IA = 1;
    for (let d = 0; d < 360; d++) { w.demand.IA = 1; w.stepDay(); }
    const farms = [...w.buildings.values()].filter((b) => b.type === 'IA');
    expect(farms.length).toBeGreaterThanOrEqual(1);
    expect(farms.length).toBeLessThanOrEqual(2);
    const tiles = new Set(farms.map((b) => Math.floor(b.x / 8) + ',' + Math.floor(b.y / 8)));
    expect(tiles.size).toBe(farms.length);
  });

  it('buildings can be rotated: square lots by 90 degrees, rectangles by 180', () => {
    const w = new World(48);
    w.g.heights.fill(6);
    w.funds = 1e7;
    expect(w.exec({ t: 'road', x0: 2, y0: 20, x1: 40, y1: 20, road: RoadType.Road }).ok).toBe(true);
    expect(w.exec({ t: 'plop', id: 'library', x: 10, y: 22 }).ok).toBe(true);
    expect(w.exec({ t: 'plop', id: 'police_l', x: 20, y: 22 }).ok).toBe(true);
    const bs = [...w.buildings.values()];
    const sq = bs.find((b) => b.type === 'library')!, rc = bs.find((b) => b.type === 'police_l')!;
    const f0 = sq.face, r0 = rc.face;
    w.exec({ t: 'rotate', id: sq.id });
    expect(sq.face).not.toBe(f0);
    for (let k = 0; k < 3; k++) w.exec({ t: 'rotate', id: sq.id });
    expect(sq.face).toBe(f0);
    w.exec({ t: 'rotate', id: rc.id });
    expect(rc.face).toBe((r0 + 4) & 7);
  });

  it('track-only stations can sit side by side on parallel elevated lines', () => {
    const w = new World(48);
    w.g.heights.fill(6);
    w.funds = 1e7;
    const g = w.g;
    expect(w.exec({ t: 'road', x0: 5, y0: 22, x1: 40, y1: 22, road: RoadType.Road }).ok).toBe(true);
    expect(w.exec({ t: 'transit', x0: 5, y0: 20, x1: 40, y1: 20, kind: 'erail' }).ok).toBe(true);
    expect(w.exec({ t: 'transit', x0: 5, y0: 21, x1: 40, y1: 21, kind: 'erail' }).ok).toBe(true);
    expect(w.exec({ t: 'estop', x: 20, y: 21 }).ok).toBe(true);
    expect(w.exec({ t: 'estop', x: 20, y: 20 }).ok).toBe(true);
    let k = 0;
    for (let i = 0; i < g.n * g.n; i++) if (g.estn[i]) k++;
    expect(k).toBe(8);
    // 同じ線路で重なる駅はだめ
    expect(w.exec({ t: 'estop', x: 23, y: 20 }).ok).toBe(false);
  });

  it('trees can be planted on empty land, but not on roads', () => {
    const w = new World(32);
    w.g.heights.fill(6);
    w.funds = 1e6;
    const g = w.g;
    expect(w.exec({ t: 'road', x0: 2, y0: 10, x1: 20, y1: 10, road: RoadType.Road }).ok).toBe(true);
    const r = w.exec({ t: 'trees', x0: 5, y0: 8, x1: 7, y1: 12 });
    expect(r.ok).toBe(true);
    expect(g.tree[g.idx(6, 9)]).toBe(3);
    expect(g.tree[g.idx(6, 10)]).toBe(0);
    expect(w.exec({ t: 'trees', x0: 5, y0: 8, x1: 7, y1: 12 }).ok).toBe(false);
  });

  it('cars drive through diagonal sections and bends of an urban highway', () => {
    for (const type of [RoadType.UrbanGroundHighway, RoadType.UrbanHighway]) {
      for (const [bx, by] of [[30, 6], [30, 34]]) {
        const w = new World(48);
        w.g.heights.fill(6);
        w.funds = 1e6;
        const g = w.g;
        expect(w.exec({ t: 'road', x0: 3, y0: 14, x1: 3, y1: 26, road: RoadType.Road }).ok).toBe(true);
        expect(w.exec({ t: 'road', x0: 3, y0: 20, x1: 16, y1: 20, road: type }).ok).toBe(true);
        expect(w.exec({ t: 'road', x0: 16, y0: 20, x1: bx, y1: by, road: type }).ok).toBe(true);
        expect(w.exec({ t: 'road', x0: bx, y0: by, x1: 44, y1: by, road: RoadType.Road }).ok).toBe(true);
        const N = g.n * g.n;
        const J = buildJunctions(g, new Float32Array(2 * N));
        const dest = new Map([[g.idx(44, by), [{ id: 1, free: 10 }]]]);
        const r = assignTrips(g, [{ cell: g.idx(3, 15), trips: 10, buildings: [{ id: 9, trips: 10 }] }], dest, new Float32Array(2 * N).fill(1), J, () => 0.5, { externalCap: 0, maxMinutes: 120, weight: 1 });
        expect(r.filled.get(1)).toBe(10);
      }
    }
  });

  it('on urban highways, ramps are entered and left only with right turns (no crossing the center line)', () => {
    // 東向き(0)から南側のランプ(南東 1)へは右折なので可、西向き(4)からは中央線をまたぐので不可
    expect(urbanTurnOk(0, 1)).toBe(true);
    expect(urbanTurnOk(4, 1)).toBe(false);
    // 南側のランプから合流（北東 7）：東向き(0)へは可、西向き(4)へは不可
    expect(urbanTurnOk(7, 0)).toBe(true);
    expect(urbanTurnOk(7, 4)).toBe(false);
    // 北側のランプ（西向き用）：西向き(4)から北西(5)へは可、合流（南西 3）から西(4)へは可
    expect(urbanTurnOk(4, 5)).toBe(true);
    expect(urbanTurnOk(3, 4)).toBe(true);
    expect(urbanTurnOk(3, 0)).toBe(false);
    // まっすぐはいつでも可
    expect(urbanTurnOk(0, 0)).toBe(true);
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
    // 公共サービスのない街なので、犯罪とゴミの影響で伸びは控えめになる
    expect(w.stats.population).toBeGreaterThan(3000);
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

describe('stage 4b governance', () => {
  it('loans add funds and are repaid monthly', () => {
    const w = new World(32);
    w.funds = 1000;
    const r = w.exec({ t: 'loan', amount: 50000 });
    expect(r.ok, r.msg).toBe(true);
    expect(w.funds).toBe(51000);
    const before = w.loans[0].remaining;
    for (let d = 0; d < 30; d++) w.stepDay();
    expect(w.loans[0].remaining).toBeLessThan(before);
    expect(w.stats.expenseBreakdown['借入の返済']).toBeGreaterThan(400);
    expect(w.exec({ t: 'repay', id: w.loans[0].id }).ok).toBe(true);
    expect(w.loans.length).toBe(0);
  });

  it('ordinances need population and change effects', () => {
    const w = new World(32);
    expect(w.exec({ t: 'ordinance', id: 'gambling', on: true }).ok).toBe(false); // 人口が足りない
    expect(w.exec({ t: 'ordinance', id: 'power', on: true }).ok).toBe(false);
  });

  it('rewards need conditions, and the mayor rating is computed', { timeout: 60000 }, () => {
    const w = World.create({ name: 'g', seed: 12345, style: 'river', difficulty: 0, sandbox: false });
    w.funds = 1e7;
    buildTestCity(w);
    const g = w.g;
    let msg = '';
    for (let y = 2; y < g.n - 2 && !msg; y++) for (let x = 2; x < g.n - 2; x++) {
      const r = w.exec({ t: 'plop', id: 'stadium', x, y });
      if (!r.ok && r.msg?.includes('条件')) { msg = r.msg; break; }
    }
    expect(msg).toContain('人口 30,000人');
    for (let m = 0; m < 12; m++) for (let d = 0; d < 30; d++) w.stepDay();
    console.log(`rating: ${w.stats.rating} ${JSON.stringify(w.stats.ratingParts)} advice=${w.stats.advice.length}`);
    expect(w.stats.rating).toBeGreaterThan(0);
    expect(w.stats.advice.length).toBeGreaterThan(3);
  });
});
