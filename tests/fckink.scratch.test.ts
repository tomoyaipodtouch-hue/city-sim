import { it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { DX, DY } from '../src/sim/constants';
import { findJctChains } from '../src/render/jctCurve';
const flat = (n = 128) => { const w = new World(n), V = n + 1; for (let i = 0; i < V * V; i++) w.g.heights[i] = 8; w.sandbox = true; w.funds = 1e10; return w; };
it('kinks', () => {
  for (const size of [1, 2, 3]) for (let rot = 0; rot < 8; rot++) for (const t of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway]) {
    const w = flat();
    w.exec({ t: 'plop', id: `airport_${size}` as any, x: 64, y: 64, rot });
    const b = [...w.buildings.values()][0];
    const gc = w.airportAccess(b)!.ports.gate!;
    w.exec({ t: 'road', x0: gc.x + DX[gc.d] * 10, y0: gc.y + DY[gc.d] * 10, x1: gc.x, y1: gc.y, road: t });
    const g = w.g, N = g.n * g.n;
    const chains = findJctChains(g, 0.3).filter((C) => C.nodes.some((v) => g.aport[v % N]));
    let worst = 0, minR = Infinity, wn = '';
    for (const C of chains) {
      const m = C.x.length;
      for (let k = 2; k + 2 < m; k++) {
        const a0 = Math.atan2(C.z[k] - C.z[k - 2], C.x[k] - C.x[k - 2]), a1 = Math.atan2(C.z[k + 2] - C.z[k], C.x[k + 2] - C.x[k]);
        let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d;
        const ds = (C.s[k + 2] - C.s[k - 2]) / 2;
        const deg = (d * 180 / Math.PI) / Math.max(0.5, ds);
        if (deg > worst) { worst = deg; wn = `${C.nodes.length} @${k}/${m}`; }
      }
      // 8m 窓の半径
      for (let k = 4; k + 4 < m; k++) {
        const a0 = Math.atan2(C.z[k] - C.z[k - 4], C.x[k] - C.x[k - 4]), a1 = Math.atan2(C.z[k + 4] - C.z[k], C.x[k + 4] - C.x[k]);
        let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d;
        if (d > 1e-3) minR = Math.min(minR, ((C.s[k + 4] - C.s[k - 4]) / 2) / d);
      }
    }
    if (process.env.D) for (const C of chains) {
      let mr = Infinity, at = 0; const m = C.x.length;
      for (let k = 4; k + 4 < m; k++) { const a0 = Math.atan2(C.z[k] - C.z[k - 4], C.x[k] - C.x[k - 4]), a1 = Math.atan2(C.z[k + 4] - C.z[k], C.x[k + 4] - C.x[k]); let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d; if (d > 1e-3) { const r = ((C.s[k + 4] - C.s[k - 4]) / 2) / d; if (r < mr) { mr = r; at = k; } } }
      const cc = (v: number) => { const c = v % N; return `${c % g.n},${(c / g.n) | 0}${v >= N ? '^' : ''}`; };
      const prof: string[] = [];
      for (let k = 4; k + 4 < m; k += 6) { const a0 = Math.atan2(C.z[k] - C.z[k - 4], C.x[k] - C.x[k - 4]), a1 = Math.atan2(C.z[k + 4] - C.z[k], C.x[k + 4] - C.x[k]); let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d; prof.push(d > 1e-3 ? (((C.s[k + 4] - C.s[k - 4]) / 2) / d).toFixed(0) : '-'); }
      if (process.env.P) console.log('     prof', prof.join(' '));
      console.log('   chain', C.nodes.map(cc).join(' '), 'len', C.len.toFixed(0), 'minR', mr.toFixed(1), 'at', at, 'dead', C.dead0, C.dead1, C.solo0, C.solo1);
    }
    console.log(size, rot, t, 'chains', chains.length, 'worst deg/m', worst.toFixed(2), wn, 'minR', minR.toFixed(1));
  }
});
