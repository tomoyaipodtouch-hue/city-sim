import { it } from 'vitest';
import { airportLayout } from '../src/sim/airport';
import { AirOps } from '../src/render/airport/ops';
it('dbg', () => {
  const L = airportLayout(3);
  const ops = new AirOps(L, { pos: 3000, neg: 3000 }, 31);
  ops.open = true; ops.flights = 140; ops.cargoFlights = 16; ops.seed();
  const o = ops as any;
  const seen = new Map<object, string>();
  let offs = 0, lands = 0;
  for (let i = 0; i < 12000; i++) { const t = i * 0.2;
    ops.update(0.2, 0.5);
    for (const a of ops.aircraft) { if (seen.get(a) !== a.phase) { if (a.phase === 'takeoff') offs++; if (a.phase === 'rollout') lands++; seen.set(a, a.phase); } }
    if (i % 250 === 0) console.log('t', t.toFixed(0), 'dir', o.dir, 'off', offs, 'land', lands, ops.aircraft.map((a) => `${a.id}:${a.phase}${a.queue ? 'Q' + a.queue : ''}@${a.a.toFixed(0)},${a.c.toFixed(0)}`).filter((x) => !x.includes('park') && !x.includes('ready')).join(' '), 'ready', ops.aircraft.filter((a) => a.phase === 'ready').length);
  }
});
