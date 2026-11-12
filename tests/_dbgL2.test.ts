import { it } from 'vitest';
import { airportLayout } from '../src/sim/airport';
import { AirOps } from '../src/render/airport/ops';
it('dbg2', () => {
  const L = airportLayout(3);
  const ops = new AirOps(L, { pos: 3000, neg: 3000 }, 31);
  ops.open = true; ops.flights = 140; ops.cargoFlights = 16; ops.seed();
  const o = ops as any;
  for (let i = 0; i < 12000; i++) {
    const t = i * 0.2;
    ops.update(0.2, 0.5);
    if (i % 1000 === 0 && t > 900) {
      console.log('t', t, 'moving', ops.aircraft.filter((a) => a.phase !== 'ready' && a.phase !== 'park').map((a) => `${a.id}:${a.phase}@${a.a.toFixed(0)},${a.c.toFixed(0)} res=${a.res.length}`).join(' '));
      for (const ex of ops.aircraft.filter((a) => a.phase === 'ready')) {
        const to = o.taxiOut(ex);
        const bad = new Set<string>();
        for (const id of to.segs) for (const j of [id, ...o.conf[id]]) if (o.segOwner[j] >= 0 && o.segOwner[j] !== ex.id) bad.add(String(o.segOwner[j]));
        const qu = o.queueOut(ex, to);
        console.log('  ready', ex.id, 'st', ex.stand, 't', ex.t.toFixed(0), 'bridge', o.bridge[ex.stand].toFixed(2), 'blk', [...bad].join(','), 'plans', o.hitsPlans(to.segs, ex), 'older', o.olderReady(ex, to.segs), 'queue', qu ? qu.m : null);
      }
      if (t > 7000) break;
    }
  }
});
