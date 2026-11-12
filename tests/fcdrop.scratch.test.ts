import { it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { DX, DY } from '../src/sim/constants';
import { CarLayer } from '../src/render/carLayer';
const sink: any = new Proxy(function () {}, { get: (_t, k) => (k === 'width' || k === 'height' ? 32 : k === Symbol.toPrimitive ? () => 0 : k === 'toString' || k === 'valueOf' ? () => '' : sink), apply: () => sink, set: () => true });
(globalThis as any).document ??= { createElement: () => sink };
it('drop debug', () => {
  const w = new World(128); w.g.heights.fill(8); w.sandbox = true; w.funds = 1e10;
  w.exec({ t: 'plop', id: 'airport_1', x: 64, y: 64, rot: 2 });
  const b = [...w.buildings.values()][0]; const gc = w.airportAccess(b)!.ports.gate!;
  w.exec({ t: 'road', x0: gc.x + DX[gc.d] * 12, y0: gc.y + DY[gc.d] * 12, x1: gc.x, y1: gc.y, road: RoadType.UrbanHighway });
  const g = w.g, N = g.n * g.n;
  const tr = new Float32Array(2 * N);
  for (let v = 0; v < 2 * N; v++) { const ty = g.nodeType(v); if (ty) tr[v] = g.aport[v % N] ? 1500 : 2500; }
  for (let rep = 0; rep < 20; rep++) {
  const L = new CarLayer();
  L.setData(g, tr, new Float32Array(2 * N).fill(1), new Float32Array(2 * N));
  const nm = (v: number) => `${v % N % g.n},${((v % N) / g.n) | 0}${v >= N ? '^' : ''}`;
  const tgt = g.idx(19, 69);
  console.log('cell 73,69 road', g.road[tgt], 'up', g.up[tgt], 'conn', g.conn[tgt].toString(2), 'flow', g.flow[tgt].toString(2), 'jct', g.jct[tgt], 'aport', g.aport[tgt]);
  for (const c of [g.idx(74, 68), g.idx(72, 69), g.idx(74, 69)]) console.log(nm(c), 'road', g.road[c], 'up', g.up[c], 'conn', g.conn[c].toString(2), g.conn1[c].toString(2), 'flow', g.flow[c].toString(2), g.flow1[c].toString(2), 'jct', g.jct[c]);
  for (let k = 0; k < 4000; k++) {
    L.update(1 / 20);
    for (const f of (L as any).cars) for (const c of f.cars) if (g.aport[c.from % N] && (c.wait ?? 0) > 25 && !c._logged) {
      c._logged = 1;
      const lim = c.lim;
      const ch: string[] = [];
      for (let o = c, j = 0; o && j < 12; o = o.lim, j++) ch.push(`${nm(o.from)}>${nm(o.to)} t${o.t.toFixed(2)} L${o.lane} w${(o.wait ?? 0).toFixed(0)} rw${(o.rw ?? 0).toFixed(0)} s${(o.stop ?? 0).toFixed(1)} cs${o.cs?.toFixed?.(0)} v${(o.v ?? 0).toFixed(1)}`);
      console.log('chain', ch.join(' | '));
      console.log('stuck', k, nm(c.from), '->', nm(c.to), 'din', c.din, 'd', c.d, 't', c.t.toFixed(2), 'lane', c.lane, 'stop', c.stop, 'lim', lim ? `${nm(lim.from)}->${nm(lim.to)} t ${lim.t.toFixed(2)} lane ${lim.lane} wait ${lim.wait?.toFixed(1)} stop ${lim.stop}` : null);
    }
  }
  console.log('drops', L.drops, (L as any).dropAt.map(nm).join(' '));
  if (L.drops) break;
  }
});
