import { it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { planJct, JctForm } from '../src/sim/jct';
import { Grid } from '../src/sim/grid';

function dump(g: Grid, cx: number, cy: number, R = 22) {
  const rows: string[] = [];
  for (let y = cy - R; y <= cy + R; y++) {
    let a = '', b = '';
    for (let x = cx - R; x <= cx + R; x++) {
      const c = g.idx(x, y);
      const r = g.road[c], u = g.up[c];
      a += r === RoadType.Ramp ? 'r' : r ? '#' : '.';
      b += u === RoadType.Ramp ? String(Math.min(9, Math.round((g.upH[c] - g.cellH(x, y)) / 1.5))) : u ? '#' : '.';
    }
    rows.push(a + '   ' + b);
  }
  return rows.join('\n');
}

const cases: [string, number, number, JctForm, boolean][] = (((globalThis as any).process.env.JCASES as string) ?? 'x:9:8:semi').split(',').map((s: string) => {
  const [k, a, b, f, d] = s.split(':');
  return [k, Number(a), Number(b), f as JctForm, d === 'd'];
});

it('dbg', () => {
  for (const [kind, ta, tb, form, diag] of cases) {
    const w = new World(96);
    w.g.heights.fill(10);
    w.funds = 1e9;
    const C = 48;
    let r1, r2;
    if (kind === 'x') {
      r1 = w.exec({ t: 'road', x0: 4, y0: C, x1: 91, y1: C, road: ta });
      r2 = diag ? w.exec({ t: 'road', x0: C - 40, y0: C - 40, x1: C + 40, y1: C + 40, road: tb }) : w.exec({ t: 'road', x0: C, y0: 4, x1: C, y1: 91, road: tb });
    } else {
      r1 = w.exec({ t: 'road', x0: 4, y0: C, x1: 91, y1: C, road: ta });
      r2 = diag ? w.exec({ t: 'road', x0: C + 40, y0: C + 40, x1: C, y1: C, road: tb }) : w.exec({ t: 'road', x0: C, y0: 91, x1: C, y1: C, road: tb });
    }
    const t0 = performance.now();
    const p = planJct(w.g, form, C, C);
    console.log(`${kind} ${ta}x${tb} ${form} diag=${diag} roads ${r1.ok}/${r2.ok} ${r2.msg ?? ''} → ${p.ok} ${p.reason} cost=${p.cost} ${(performance.now() - t0).toFixed(0)}ms`);
    if (p.out) console.log(dump(p.out, C, C));
    else console.log(dump(w.g, C, C, 6), [...p.bad].slice(0, 20).map((c) => [c % 96, (c / 96) | 0]));
  }
});
