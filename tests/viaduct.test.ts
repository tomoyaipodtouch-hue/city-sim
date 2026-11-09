// 高架の高速道路・高架鉄道が川を渡るとき、水の上で路面が沈まないこと
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { RailLayer } from '../src/render/railLayer';

// 南北に流れる川（格子点 x = 20..26 が水）。両岸は高さ 6
function riverNS(n = 48) {
  const w = new World(n);
  w.g.heights.fill(6);
  w.funds = 1e9;
  for (let vy = 0; vy <= n; vy++) for (let vx = 20; vx <= 26; vx++) w.g.setVh(vx, vy, -3);
  return w;
}

// 行 y の x0..x1 の高さを、水の上と岸（陸）に分けて返す
function profile(w: World, y: number, x0: number, x1: number, h: (i: number) => number) {
  const g = w.g, wet: number[] = [], dry: number[] = [];
  for (let x = x0; x <= x1; x++) (g.isWater(x, y) ? wet : dry).push(h(g.idx(x, y)));
  return { wet, dry };
}

describe('viaducts over water', () => {
  for (const road of [RoadType.UrbanHighway, RoadType.UrbanHighway1W, RoadType.Highway]) {
    it(`elevated highway ${road} keeps the bank deck height over the river`, () => {
      const w = riverNS();
      const r = w.exec({ t: 'road', x0: 6, y0: 24, x1: 40, y1: 24, road });
      expect(r.ok, r.msg).toBe(true);
      const g = w.g;
      const { wet, dry } = profile(w, 24, 12, 34, (i) => g.upH[i]);
      expect(wet.length).toBeGreaterThan(3);
      // 水の上が岸の路面より低くならない
      expect(Math.min(...wet)).toBeGreaterThanOrEqual(Math.min(...dry) - 0.01);
    });
  }

  it('old saves with a sunken highway deck over water are raised on load', () => {
    const w = riverNS();
    expect(w.exec({ t: 'road', x0: 6, y0: 24, x1: 40, y1: 24, road: RoadType.UrbanHighway }).ok).toBe(true);
    const g = w.g;
    // 以前の版の高さ（水面 + 高さ）を再現する
    for (let x = 0; x < g.n; x++) if (g.isWater(x, 24) && g.up[g.idx(x, 24)]) g.upH[g.idx(x, 24)] = 9;
    const w2 = World.load(w.serialize());
    const { wet, dry } = profile(w2, 24, 12, 34, (i) => w2.g.upH[i]);
    expect(Math.min(...wet)).toBeGreaterThanOrEqual(Math.min(...dry) - 0.01);
  });

  it('elevated rail keeps the bank height over the river', () => {
    const w = riverNS();
    const r = w.exec({ t: 'transit', x0: 6, y0: 24, x1: 40, y1: 24, kind: 'erail' });
    expect(r.ok, r.msg).toBe(true);
    const { wet, dry } = profile(w, 24, 12, 34, (i) => RailLayer.lineH(w.g, 'erail', i));
    expect(Math.min(...wet)).toBeGreaterThanOrEqual(Math.min(...dry) - 0.01);
  });
});
