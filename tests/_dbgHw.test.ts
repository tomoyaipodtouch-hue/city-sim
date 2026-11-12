import { it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { AIRPORT_SPECS, airportLayout, footprintAt, makeFrame, placeCentre, planAirport, highwayNodes } from '../src/sim/airport';
import { CELL } from '../src/sim/constants';
const flat = (n = 128) => { const w = new World(n), V = n + 1; for (let i = 0; i < V * V; i++) w.g.heights[i] = 8; w.sandbox = true; w.funds = 1e10; return w; };
it('hw', () => {
  for (const size of [1, 2] as const) for (let rot = 0; rot < 8; rot++) {
    const w = flat(), n = 128, SPEC = AIRPORT_SPECS[size];
    const [cx, cz] = placeCentre(n, SPEC, rot, 64, 64);
    const f = makeFrame(SPEC, rot, cx, cz);
    const lot = new Set(footprintAt(n, SPEC, rot, cx, cz).cells);
    // local road off the -a end
    let x = Math.floor((f.cx - f.cos * (f.A / 2 + 8)) / CELL), y = Math.floor((f.cz - f.sin * (f.A / 2 + 8)) / CELL);
    while (lot.has(y * n + x)) { x += Math.round(-f.cos); y += Math.round(-f.sin); }
    w.exec({ t: 'road', x0: x, y0: y, x1: x + Math.round(-f.cos * 1.4) * 2, y1: y + Math.round(-f.sin * 1.4) * 2, road: RoadType.Road });
    const p = planAirport(w.g, size, 64, 64, rot);
    const r = w.exec({ t: 'plop', id: size === 1 ? 'airport_1' : 'airport_2', x: 64, y: 64, rot });
    const near = new Set(p.ports.highwayNear);
    // try lines parallel to the a axis at landside offset c = C/2 + d
    const res: string[] = [];
    // perpendicular approach toward the landside centre, ending at the lot edge
    for (const t of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway, RoadType.UrbanHighway1W]) {
      const wq = flat();
      wq.exec({ t: 'road', x0: x, y0: y, x1: x + Math.round(-f.cos * 1.4) * 2, y1: y + Math.round(-f.sin * 1.4) * 2, road: RoadType.Road });
      wq.exec({ t: 'plop', id: size === 1 ? 'airport_1' : 'airport_2', x: 64, y: 64, rot });
      const P = (a: number, c: number) => [Math.floor((a * f.cos - c * f.sin + f.cx) / CELL), Math.floor((a * f.sin + c * f.cos + f.cz) / CELL)];
      const [x0, y0] = P(100, f.C / 2 + 400);
      let [x1, y1] = P(100, f.C / 2 + 4);
      // step back until outside the lot
      const lotq = new Set(footprintAt(n, SPEC, rot, cx, cz).cells);
      let k = 4; while (lotq.has(y1 * n + x1)) { k += 8; [x1, y1] = P(100, f.C / 2 + k); }
      const rr = wq.exec({ t: 'road', x0, y0, x1, y1, road: t });
      res.push(`perp${t}:${rr.ok ? 'ok' : 'FAIL ' + rr.msg} hw=${highwayNodes(wq.g, p.ports).length}`);
    }
    for (const d of [8, 16, 24]) {
      const w2 = World.fromJSON ? null : null; void w2;
      const c = f.C / 2 + d;
      const P = (a: number) => [Math.floor((a * f.cos - c * f.sin + f.cx) / CELL), Math.floor((a * f.sin + c * f.cos + f.cz) / CELL)];
      const [x0, y0] = P(-f.A / 2 - 40), [x1, y1] = P(f.A / 2 + 40);
      const snap = JSON.stringify(w.toJSON ? 0 : 0);
      void snap;
      const rr = w.exec({ t: 'road', x0, y0, x1, y1, road: RoadType.UrbanHighway });
      let cnt = 0, inNear = 0;
      for (let i = 0; i < n * n; i++) if (w.g.up[i] === RoadType.UrbanHighway || w.g.road[i] === RoadType.UrbanHighway) { cnt++; if (near.has(i)) inNear++; }
      res.push(`d${d}:${rr.ok ? 'ok' : 'FAIL ' + rr.msg} cells=${cnt} inNear=${inNear} hwNodes=${highwayNodes(w.g, p.ports).length}`);
      if (inNear) break;
    }
    console.log('size', size, 'rot', rot, 'plop', r.ok, 'near', near.size, res.join(' | '));
  }
});
