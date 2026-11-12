import { it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { DX, DY } from '../src/sim/constants';
const flat = (n = 128) => { const w = new World(n), V = n + 1; for (let i = 0; i < V * V; i++) w.g.heights[i] = 8; w.sandbox = true; w.funds = 1e10; return w; };
function reach(w: World, links: [number, number, number][], from: number, to: number) {
  const L = new Map<number, number[]>();
  for (const [u, v] of links) (L.get(u) ?? L.set(u, []).get(u)!).push(v);
  const seen = new Set([from]), q = [from];
  while (q.length) { const u = q.pop()!; if (u === to) return true; const next: number[] = [...(L.get(u) ?? [])]; w.g.forEachOut(u, (v) => next.push(v)); for (const v of next) if (!seen.has(v)) { seen.add(v); q.push(v); } }
  return false;
}
it('world forecourt', () => {
  for (const size of [1, 2, 3]) for (let rot = 0; rot < 8; rot++) for (const t of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway, RoadType.Road]) {
    const w = flat();
    const r0 = w.exec({ t: 'plop', id: `airport_${size}` as any, x: 64, y: 64, rot });
    const b = [...w.buildings.values()][0];
    const A0 = w.airportAccess(b)!;
    const gc = A0.ports.gate!;
    const r = w.exec({ t: 'road', x0: gc.x + DX[gc.d] * 10, y0: gc.y + DY[gc.d] * 10, x1: gc.x, y1: gc.y, road: t });
    const A = w.airportAccess(b)!;
    const N = w.g.n * w.g.n, far = (t === RoadType.UrbanHighway ? N : 0) + w.g.idx(gc.x + DX[gc.d] * 10, gc.y + DY[gc.d] * 10);
    const inn = reach(w, A.links, far, A.term), out = reach(w, A.links, A.term, far);
    const dep = A.curb.filter((v) => v >= N), arr = A.curb.filter((v) => v < N);
    const rd = dep.length && reach(w, [], far, dep[0]), ra = arr.length && reach(w, [], far, arr[0]);
    console.log(size, rot, t, r0.ok, r.ok, r.msg ?? '', 'fc', b.airFc, 'lv', b.airLevel, 'main', A.main?.kind, 'in', inn, 'out', out, 'dep', dep.length, rd, 'arr', arr.length, ra);
  }
  expect(1).toBe(1);
});
