import { it } from 'vitest';
import { World } from '../src/sim/world';
import { RailLayer } from '../src/render/railLayer';
it('diag', () => {
  const w = World.create({ name: 't', seed: 4242, style: 'river', difficulty: 0, sandbox: true });
  const g = w.g;
  // 川をまたぐ横の行を探す
  const found: number[][] = [];
  console.log("start"); for (let y = 10; y < g.n - 10 && found.length < 6; y += 3)
    for (let x = 4; x < g.n - 34; x += 2) {
      const L = 28; let wet = 0;
      for (let k = 0; k <= L; k++) if (g.isWater(x + k, y)) wet++;
      if (wet < 4 || wet > 14 || g.isWater(x, y) || g.isWater(x + L, y)) continue;
      found.push([x, y, L]); break;
    }
  for (const [x, y, L] of found.slice(0, 3)) {
    const r = w.exec({ t: 'road', x0: x, y0: y, x1: x + L, y1: y, road: 8 });
    const r2 = w.exec({ t: 'transit', x0: x, y0: y + 2, x1: x + L, y1: y + 2, kind: 'erail' } as any);
    console.log(x, y, r.ok, r.msg, r2.ok, r2.msg);
    const row = (yy: number, f: (i: number) => number) => Array.from({ length: L + 1 }, (_, k) => f(yy * g.n + x + k).toFixed(1)).join(' ');
    console.log('ground', row(y, (i) => g.cellH(i % g.n, y)));
    console.log('water ', row(y, (i) => (g.isWater(i % g.n, y) ? 1 : 0)));
    console.log('upH   ', row(y, (i) => g.upH[i]));
    console.log('road  ', row(y, (i) => g.road[i]));
    console.log('ground2', row(y + 2, (i) => g.cellH(i % g.n, y + 2)));
    console.log('erail ', row(y + 2, (i) => (g.erail[i] ? RailLayer.lineH(g, 'erail', i) : 0)));
  }
});
