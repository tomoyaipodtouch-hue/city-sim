import { it } from 'vitest';
import { airportLayout } from '../src/sim/airport';
import { AirOps } from '../src/render/airport/ops';
for (const fifo of [300, 600, 1e9]) it('tp ' + fifo, () => {
  const L = airportLayout(3);
  const ops = new AirOps(L, { pos: 3000, neg: 3000 }, 31);
  (ops as any).fifoT = fifo;
  ops.open = true; ops.flights = 140; ops.cargoFlights = 16; ops.seed();
  const seen = new Map<object, string>();
  let offs = 0, maxReady = 0, maxN = 0;
  for (let i = 0; i < 36000; i++) {
    ops.update(0.2, 0.5);
    maxN = Math.max(maxN, ops.aircraft.length);
    for (const a of ops.aircraft) { if (seen.get(a) !== a.phase) { if (a.phase === 'takeoff') offs++; seen.set(a, a.phase); } if (a.phase === 'ready') maxReady = Math.max(maxReady, a.t); }
  }
  console.log('fifo', fifo, 'takeoffs/2h', offs, 'maxReady', maxReady.toFixed(0), 'maxN', maxN);
});
