import { it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
it('dbg', () => {
  for (const [lt, ht] of [[RoadType.Avenue, RoadType.UrbanHighway], [RoadType.Road, RoadType.UrbanHighway], [RoadType.OneWay, RoadType.UrbanHighway1W]]) {
    const w = new World(48); w.g.heights.fill(6); w.funds = 1e9;
    console.log(lt, ht, w.exec({ t: 'road', x0: 4, y0: 20, x1: 40, y1: 20, road: lt }).msg, w.exec({ t: 'road', x0: 4, y0: 20, x1: 40, y1: 20, road: ht }).msg);
    const g = w.g;
    for (let y = 18; y <= 22; y++) { let s = ''; for (let x = 2; x <= 10; x++) { const i = g.idx(x, y); s += `${g.road[i]}/${g.conn[i].toString(16)}/${g.flow[i].toString(16)}|${g.up[i]}/${g.conn1[i].toString(16)}/${g.flow1[i].toString(16)}/${g.upH[i].toFixed(1)}  `; } console.log(y, s); }
  }
});
