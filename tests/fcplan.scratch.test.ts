import { it } from 'vitest';
import { Grid } from '../src/sim/grid';
import { AIRPORT_SPECS, airportLayout, airportPorts, makeFrame, placeCentre, footprintAt, type AirportSize } from '../src/sim/airport';
import { forecourtPlan, landGrid } from '../src/sim/forecourt';
it('plan all', () => {
  const n = 128;
  const lines: string[] = [];
  for (const size of [1, 2, 3] as AirportSize[]) for (let rot = 0; rot < 8; rot++) for (const level of [0, 1] as const) {
    const spec = AIRPORT_SPECS[size], L = airportLayout(size);
    const [cx, cz] = placeCentre(n, spec, rot, 64, 64);
    const fp = footprintAt(n, spec, rot, cx, cz), f = makeFrame(spec, rot, cx, cz), lot = new Set(fp.cells);
    const P = airportPorts(n, f, L, fp.cells, (i) => lot.has(i));
    const plan = forecourtPlan(n, f, L, fp.cells, (i) => lot.has(i), P.gate!, level);
    const G = landGrid(n, f, L);
    const pc = (i: number) => G.centre(i).map((v) => v.toFixed(0)).join(',');
    lines.push(`size ${size} rot ${rot} lv ${level}: ${plan.ok ? 'OK' : 'FAIL ' + plan.reason} lines ${JSON.stringify(plan.lines)} cells ${plan.cells.length} bad ${plan.bad.slice(0, 4).map(pc).join(' ')}`);
    if (process.env.V && size === Number(process.env.V) && rot === Number(process.env.R ?? 2) && level === 1)
      for (const p of plan.paths) lines.push(`  ${p.name} ${p.cells.map((i, k) => pc(i) + (p.lv[k] ? '^' + p.h[k].toFixed(0) : '')).join(' ')}`);
  }
  console.log(lines.join('\n'));
});
