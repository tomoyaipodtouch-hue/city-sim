import { it } from 'vitest';
import { AIRPORT_SPECS, airportLayout, airportPorts, makeFrame, placeCentre, footprintAt } from '../src/sim/airport';
import { landGrid } from '../src/sim/forecourt';
it('dbg', () => {
  const n = 128, size = 1, rot = 2;
  const spec = AIRPORT_SPECS[size], L = airportLayout(size);
  const [cx, cz] = placeCentre(n, spec, rot, 64, 64);
  const fp = footprintAt(n, spec, rot, cx, cz), f = makeFrame(spec, rot, cx, cz), lot = new Set(fp.cells);
  const P = airportPorts(n, f, L, fp.cells, (i) => lot.has(i));
  const G = landGrid(n, f, L);
  console.log('gate', G.centre(P.gate!.cell), 'inner', G.centre(P.gate!.inner), cx, cz);
  for (const [a, c] of [[298, 104], [288.6, 81.4], [283, 77]]) console.log(a, c, G.centre(G.cellAt(a, c)));
});
import { rasterize, sampleArc } from '../src/sim/forecourt';
it('dbg2', () => {
  const n = 128, size = 1, rot = 2;
  const spec = AIRPORT_SPECS[size], L = airportLayout(size);
  const [cx, cz] = placeCentre(n, spec, rot, 64, 64);
  const fp = footprintAt(n, spec, rot, cx, cz), f = makeFrame(spec, rot, cx, cz), lot = new Set(fp.cells);
  const P = airportPorts(n, f, L, fp.cells, (i) => lot.has(i));
  const G = landGrid(n, f, L);
  const pts = sampleArc(266, 104, 32, 0, -Math.PI / 2);
  console.log(pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '));
  console.log(rasterize(G, P.gate!.cell, G.cellAt(264, 72), pts).map((i) => G.centre(i).join(',')).join(' '));
});
