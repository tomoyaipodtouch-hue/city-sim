// 空港の運航（飛行機の動き）：着陸 → 駐機 → プッシュバック → 離陸がとどこおりなく回る。同時に出す飛行機は上限まで。風向きで滑走路の向きが入れかわる
import { describe, expect, it } from 'vitest';
import { airportLayout } from '../src/sim/airport';
import { AirOps, makePath, samplePath } from '../src/render/airport/ops';

describe('airport operations', () => {
  it('paths have rounded corners and continuous headings', () => {
    const p = makePath([[0, 0], [100, 0], [100, 100]], 20);
    expect(p.len).toBeGreaterThan(180);
    expect(p.len).toBeLessThan(200);
    const o = new Float32Array(4);
    let prev = -1;
    for (let s = 0; s <= p.len; s += 2) {
      samplePath(p, s, o);
      const h = Math.atan2(o[3], o[2]);
      if (prev > -1) expect(Math.abs(h - prev)).toBeLessThan(0.25);
      prev = h;
    }
  });

  it('cycles landings, turnarounds and departures without getting stuck', () => {
    const L = airportLayout(1);
    const ops = new AirOps(L, { pos: 2500, neg: 2500 }, 12345);
    ops.open = true;
    ops.flights = 25;
    ops.cargoFlights = 4;
    ops.seed();
    let flips = 0;
    ops.onDirChange = () => flips++;
    const since = new Map<object, { phase: string; t: number }>();
    let landings = 0, takeoffs = 0, maxN = 0, gse = 0, pax = 0;
    const seen = new Set<object>();
    for (let t = 0; t < 7200; t += 0.1) {
      ops.update(0.1, 0.5);
      maxN = Math.max(maxN, ops.aircraft.length);
      for (const ac of ops.aircraft) {
        const s = since.get(ac);
        if (!s || s.phase !== ac.phase) {
          if (ac.phase === 'rollout') landings++;
          if (ac.phase === 'takeoff') takeoffs++;
          since.set(ac, { phase: ac.phase, t });
        } else if (ac.phase !== 'park') {
          // 駐機のほかは、同じ段階に 4 分より長くとどまらない
          expect(t - s.t, `${ac.phase} stuck`).toBeLessThan(240);
        }
        expect(Number.isFinite(ac.a) && Number.isFinite(ac.c) && Number.isFinite(ac.y)).toBe(true);
        seen.add(ac);
      }
      if (Math.round(t * 10) % 50 === 0) ops.eachGse(t, (type) => { if (type === 'pax') pax++; else gse++; });
    }
    console.log({ landings, takeoffs, maxN, flips, gse, pax, aircraft: seen.size });
    expect(maxN).toBeLessThanOrEqual(L.spec.maxAircraft);
    expect(landings).toBeGreaterThan(15);
    expect(takeoffs).toBeGreaterThan(15);
    expect(flips).toBeGreaterThan(2);
    expect(gse).toBeGreaterThan(100);
    expect(pax).toBeGreaterThan(50);
  });

  it('runs fewer flights late at night and none when closed', () => {
    const L = airportLayout(1);
    const count = (tod: number, open: boolean) => {
      const ops = new AirOps(L, { pos: 2500, neg: 2500 }, 7);
      ops.open = open;
      ops.flights = 25;
      let n = 0;
      const seen = new Set<object>();
      for (let t = 0; t < 3600; t += 0.1) {
        ops.update(0.1, tod);
        for (const ac of ops.aircraft) if (ac.phase === 'approach' && !seen.has(ac)) { seen.add(ac); n++; }
      }
      return n;
    };
    const day = count(0.5, true), night = count(0.1, true);
    expect(day).toBeGreaterThan(night * 2);
    expect(count(0.5, false)).toBe(0);
  });
});
