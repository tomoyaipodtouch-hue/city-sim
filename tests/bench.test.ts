// 計算の速さを測る（BENCH=1 のときだけ動かす）
import { describe, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType, ZoneType } from '../src/sim/defs';

const on = !!(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.BENCH;
describe.skipIf(!on)('bench', () => {
  it('dense city traffic', { timeout: 600000 }, () => {
    const w = World.create({ name: 'b', seed: 4242, style: 'river', difficulty: 0, sandbox: true });
    const g = w.g;
    const size = 37;
    let best = [0, 0], bs = 1e9;
    for (let y = 4; y < g.n - size - 4; y += 2) for (let x = 4; x < g.n - size - 4; x += 2) {
      let wt = 0, lo = 1e9, hi = -1e9;
      for (let yy = y; yy < y + size; yy++) for (let xx = x; xx < x + size; xx++) { if (g.isWater(xx, yy)) wt++; lo = Math.min(lo, g.cellMinH(xx, yy)); hi = Math.max(hi, g.cellMaxH(xx, yy)); }
      const s = wt * 100 + (hi - lo); if (s < bs) { bs = s; best = [x, y]; }
    }
    const [ox, oy] = best;
    const run = (c: Parameters<World["exec"]>[0]) => { const r = w.exec(c); if (!r.ok) console.log("fail", c.t, r.msg); return r; };
    for (let k = 0; k <= 36; k += 6) run({ t: 'road', x0: ox + k, y0: oy, x1: ox + k, y1: oy + 36, road: k % 12 ? RoadType.Street : RoadType.Avenue });
    for (let k = 0; k <= 36; k += 6) run({ t: 'road', x0: ox, y0: oy + k, x1: ox + 36, y1: oy + k, road: RoadType.Road });
    run({ t: 'road', x0: ox + 18, y0: oy + 36, x1: ox + 18, y1: g.n - 1, road: RoadType.Road });
    run({ t: 'zone', x0: ox + 1, y0: oy + 1, x1: ox + 35, y1: oy + 16, zone: ZoneType.C, den: 2 });
    run({ t: 'zone', x0: ox + 1, y0: oy + 19, x1: ox + 23, y1: oy + 35, zone: ZoneType.R, den: 2 });
    run({ t: 'zone', x0: ox + 25, y0: oy + 19, x1: ox + 35, y1: oy + 35, zone: ZoneType.I, den: 1 });
    for (const [x, y] of [[ox - 6, oy + 2], [ox - 6, oy + 26], [ox + 38, oy + 2]]) run({ t: 'plop', id: 'coal', x, y });
    run({ t: "pline", x0: ox - 3, y0: oy + 4, x1: ox + 1, y1: oy + 4 }); run({ t: "pline", x0: ox - 3, y0: oy + 28, x1: ox + 1, y1: oy + 28 });
    for (let k = 0; k < 6; k++) run({ t: 'plop', id: 'pump', x: ox + 1 + k * 6, y: oy + 37 });
    let zc = 0, rc = 0; for (let i = 0; i < g.n * g.n; i++) { if (g.zone[i]) zc++; if (g.road[i]) rc++; } console.log("zones", zc, "roads", rc, ox, oy);
    const proto = Object.getPrototypeOf(w);
    let tt = 0, calls = 0;
    const f = proto.updateTraffic;
    (w as unknown as Record<string, unknown>).updateTraffic = function (this: World, ...a: unknown[]) { const t = performance.now(); f.apply(this, a); tt += performance.now() - t; calls++; };
    for (let y = 1; y <= 6; y++) {
      tt = 0; calls = 0;
      const t0 = performance.now();
      for (let d = 0; d < 360; d++) w.stepDay();
      const s = w.stats;
      console.log(`dem=${s.demandRCI.map((v: number) => v.toFixed(2))} pow=${s.powerDemand}/${s.powerSupply} wat=${s.waterDemand}/${s.waterSupply} bld=${w.buildings.size}`);
      console.log(`y${y} pop=${s.population} jobs=${s.jobs} emp=${s.employed} commute=${s.avgCommute.toFixed(1)} share=${JSON.stringify(s.modeShare)} traffic=${(tt / calls).toFixed(1)}ms/call total=${((performance.now() - t0) / 12).toFixed(1)}ms/month`);
    }
  });
});
describe.skipIf(!on)('bench2', () => {
  it('test city traffic profile', { timeout: 600000 }, async () => {
    const w = World.create({ name: 'テスト', seed: 12345, style: 'river', difficulty: 1, sandbox: false });
    const src = await import('./helpers');
    src.buildTestCity(w);
    const proto = Object.getPrototypeOf(w);
    let tt = 0, calls = 0;
    const f = proto.updateTraffic;
    (w as unknown as Record<string, unknown>).updateTraffic = function (this: World, ...a: unknown[]) { const t0 = performance.now(); f.apply(this, a); tt += performance.now() - t0; calls++; };
    for (let y = 1; y <= 10; y++) {
      tt = 0; calls = 0;
      for (let d = 0; d < 360; d++) w.stepDay();
      const s = w.stats;

      console.log(`Y${y} pop=${s.population} jobs=${s.jobs} emp=${s.employed} commute=${s.avgCommute.toFixed(1)} traffic=${(tt / calls).toFixed(1)}ms`);
    }
  });
});
describe.skipIf(!on)('bench3', () => {
  it('256 map', { timeout: 600000 }, async () => {
    const { buildTestCity } = await import('./helpers');
    const t0 = performance.now();
    const w = World.create({ name: 'b', seed: 12345, style: 'river', difficulty: 1, sandbox: false, n: 256 });
    console.log(`create 256: ${(performance.now() - t0).toFixed(0)}ms`);
    buildTestCity(w);
    const times: Record<string, number> = {};
    const proto = Object.getPrototypeOf(w);
    for (const k of Object.getOwnPropertyNames(proto)) {
      const f = proto[k];
      if (typeof f !== 'function' || k === 'constructor' || k === 'stepDay' || k === 'monthly') continue;
      (w as unknown as Record<string, unknown>)[k] = function (this: World, ...a: unknown[]) { const t = performance.now(); const r = f.apply(this, a); times[k] = (times[k] || 0) + performance.now() - t; return r; };
    }
    for (let y = 1; y <= 5; y++) {
      const t1 = performance.now();
      for (let d = 0; d < 360; d++) w.stepDay();
      if (y === 5) console.log(JSON.stringify(Object.entries(times).filter(([, v]) => v > 20).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / 60)])));
      console.log(`Z${y} pop=${w.stats.population} ${((performance.now() - t1) / 12).toFixed(1)}ms/month`);
    }
  });
});
