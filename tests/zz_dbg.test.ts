import { it } from 'vitest';
// @ts-ignore
import { appendFileSync, writeFileSync } from 'fs';
import { airportLayout } from '../src/sim/airport';
import { AirOps } from '../src/render/airport/ops';
const LOG = '/tmp/claude-0/-home-user-city-sim/990b9a81-281c-5484-82dd-3e3321840408/scratchpad/dbg.log';
it('dbg', () => {
  writeFileSync(LOG, '');
  const L = airportLayout(2);
  const ops = new AirOps(L, { pos: 2600, neg: 2600 }, 4242);
  ops.open = true; ops.flights = 60; ops.cargoFlights = 8; ops.seed();
  const dump = (t: number, why: string) => appendFileSync(LOG, `\n${t.toFixed(1)} ${why} dir${ops.dir} ` + ops.aircraft.map((a) => `${a.id}:${a.type}:${a.phase}${a.queue ? 'Q' : ''}@${Math.round(a.a)},${Math.round(a.c)} st${a.stand} res[${a.res.map((r) => r.node)}]`).join(' | '));
  let n = 0;
  const since = new Map<object, { ph: string; t: number }>();
  for (let t = 0; t < 3600 && n < 6; t += 0.2) {
    ops.update(0.2, 0.5);
    for (const a of ops.aircraft) { const q = since.get(a); if (!q || q.ph !== a.phase) since.set(a, { ph: a.phase, t }); else if (a.phase === 'ready' && t - q.t > 250 && n < 6 && Math.round(t * 5) % 50 === 0) { dump(t, `ready-wait ${a.id} owner ${[...(ops as any).owner].map((o: number, i: number) => o >= 0 ? i + ':' + o : '').filter(Boolean).join(' ')}`); n++; } }
    const g = ops.aircraft.filter((a) => a.y === 0 && a.phase !== 'approach' && a.phase !== 'takeoff');
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      if (!g[i].moving && !g[j].moving) continue;
      if (Math.hypot(g[i].a - g[j].a, g[i].c - g[j].c) < 20) { dump(t, `overlap ${g[i].id}-${g[j].id}`); n++; }
    }
  }
});
