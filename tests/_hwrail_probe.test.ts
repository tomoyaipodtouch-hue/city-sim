import { it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
it('probe', () => {
  const mk = () => { const w = new World(48); w.g.heights.fill(6); w.funds = 1e9; return w; };
  let w = mk();
  console.log('hw', w.exec({ t: 'road', x0: 24, y0: 4, x1: 24, y1: 44, road: RoadType.UrbanHighway }));
  console.log('uramp', w.exec({ t: 'uramp', x: 25, y: 31 } as any));
  console.log('rail', w.exec({ t: 'transit', x0: 4, y0: 26, x1: 44, y1: 26, kind: 'erail' }));
  console.log('rail far', w.exec({ t: 'transit', x0: 4, y0: 14, x1: 44, y1: 14, kind: 'erail' }));
  console.log('par', w.exec({ t: 'transit', x0: 24, y0: 5, x1: 24, y1: 10, kind: 'erail' }));
  w = mk();
  console.log('Highway', w.exec({ t: 'road', x0: 24, y0: 4, x1: 24, y1: 44, road: RoadType.Highway }));
  console.log('rail', w.exec({ t: 'transit', x0: 4, y0: 26, x1: 44, y1: 26, kind: 'erail' }));
  const g = w.g;
  for (const x of [23, 24, 25]) { const p = []; for (let y = 16; y < 36; y++) p.push((g.upH[g.idx(x, y)] - 6).toFixed(1)); console.log(x, g.up[g.idx(x, 26)], p.join(' ')); }
  w = mk();
  console.log('Highway diag', w.exec({ t: 'road', x0: 4, y0: 4, x1: 44, y1: 44, road: RoadType.Highway }));
  console.log('rail', w.exec({ t: 'transit', x0: 4, y0: 26, x1: 44, y1: 26, kind: 'erail' }));
  for (let y = 18; y < 34; y++) { const p = []; for (let x = 16; x < 36; x++) { const i = w.g.idx(x, y); p.push(w.g.up[i] ? (w.g.upH[i] - 6).toFixed(1).padStart(4) : '   .'); } console.log(y, p.join(' ')); }
});
