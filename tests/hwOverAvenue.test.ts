// 大通り（一般道）の真上に引いた高架の高速道路は、大通りとつながらない（つなぐのはランプだけ）
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { buildJunctions, buildRoadGraph } from '../src/sim/traffic';

const HWS: [string, RoadType][] = [
  ['urban', RoadType.UrbanHighway],
  ['urban one-way', RoadType.UrbanHighway1W],
  ['wide', RoadType.Highway],
];

function world() {
  const w = new World(64);
  w.g.heights.fill(6);
  w.funds = 1e9;
  return w;
}

// 地上（level 0）と上空（level 1）の間に、経路のつながりがあるか（高架の端が地上へ降りるところ）
function levelLinks(w: World) {
  const g = w.g, N = g.n * g.n;
  const G = buildRoadGraph(g, new Float32Array(2 * N).fill(1), buildJunctions(g, new Float32Array(2 * N)));
  const out: [number, number][] = [];
  for (let u = 0; u < 2 * N; u++)
    for (let e = G.off[u]; e < G.off[u + 1]; e++) {
      const v = G.to[e];
      if (u >= N !== v >= N) out.push([u, v]);
    }
  return out;
}

describe('an elevated highway drawn over an avenue does not join it', () => {
  for (const [name, hw] of HWS)
    for (const order of ['avenue first', 'highway first'] as const)
      for (const diag of [false, true])
        it(`${name}, ${order}, ${diag ? 'diagonal' : 'straight'}`, () => {
          const w = world();
          const g = w.g;
          // 大通りは格子点の座標（中心線）。高速道路はマスの座標で、大通りの片方の車線（または2車線）の上
          const av = diag ? { t: 'road' as const, x0: 8, y0: 8, x1: 50, y1: 50, road: RoadType.Avenue } : { t: 'road' as const, x0: 6, y0: 20, x1: 56, y1: 20, road: RoadType.Avenue };
          const hwc = diag ? { t: 'road' as const, x0: 12, y0: 12, x1: 44, y1: 44, road: hw } : { t: 'road' as const, x0: 10, y0: 20, x1: 50, y1: 20, road: hw };
          const first = order === 'avenue first' ? av : hwc, second = order === 'avenue first' ? hwc : av;
          expect(w.exec(first).ok).toBe(true);
          const r = w.exec(second);
          expect(r.ok, r.msg).toBe(true);
          // 高架が残っていて、大通りも残っている
          expect(g.up.some((t) => t === hw)).toBe(true);
          expect(g.road.some((t) => t === RoadType.Avenue)).toBe(true);
          // 高架の下は、地上の道路が大通りのまま（端を一般道へ降ろして、大通りを切っていない）
          for (let c = 0; c < g.n * g.n; c++) if (g.up[c] === hw) expect(g.road[c] === 0 || g.road[c] === RoadType.Avenue).toBe(true);
          expect(levelLinks(w)).toEqual([]);
        });

  it('a highway ending across a road (T) still joins it at its end', () => {
    const w = world();
    const g = w.g;
    expect(w.exec({ t: 'road', x0: 30, y0: 6, x1: 30, y1: 56, road: RoadType.Avenue }).ok).toBe(true);
    // 大通りの中心線 x=30 → 車線は x=29（北向き/南向き）と x=30。東から来て、手前の車線 x=30 で終わる
    expect(w.exec({ t: 'road', x0: 55, y0: 20, x1: 30, y1: 20, road: RoadType.UrbanHighway }).ok).toBe(true);
    expect(levelLinks(w).length).toBeGreaterThan(0);
    expect(g.road[g.idx(30, 20)]).toBe(RoadType.Avenue);
  });

  it('a highway crossing over an avenue does not join it', () => {
    for (const hw of [RoadType.UrbanHighway, RoadType.Highway]) {
      const w = world();
      expect(w.exec({ t: 'road', x0: 30, y0: 6, x1: 30, y1: 56, road: RoadType.Avenue }).ok).toBe(true);
      expect(w.exec({ t: 'road', x0: 10, y0: 20, x1: 50, y1: 20, road: hw }).ok).toBe(true);
      expect(levelLinks(w)).toEqual([]);
      const w2 = world();
      expect(w2.exec({ t: 'road', x0: 10, y0: 20, x1: 50, y1: 20, road: hw }).ok).toBe(true);
      expect(w2.exec({ t: 'road', x0: 30, y0: 6, x1: 30, y1: 56, road: RoadType.Avenue }).ok).toBe(true);
      expect(levelLinks(w2)).toEqual([]);
    }
  });
});

describe('old saves: a highway end that dropped onto the avenue below is lifted back', () => {
  for (const hw of [RoadType.UrbanHighway, RoadType.UrbanHighway1W])
    it(ROADS_NAME(hw), () => {
      const w = world();
      const g = w.g;
      expect(w.exec({ t: 'road', x0: 6, y0: 20, x1: 56, y1: 20, road: RoadType.Avenue }).ok).toBe(true);
      expect(w.exec({ t: 'road', x0: 10, y0: 20, x1: 50, y1: 20, road: hw }).ok).toBe(true);
      const flow = g.flow.slice(), flow1 = g.flow1.slice(), upH = g.upH.slice();
      // 以前の版の形：端のマス（10,20）と（50,20）は地上の大通りのまま、高架の隣のマスから降りてつながる。両方向なら大通りに逆向きの流れが足される
      for (const [x, b] of [[10, 0], [50, 4]] as const) {
        const c = g.idx(x, 20), p = g.idx(x + (b === 0 ? 1 : -1), 20);
        const out = (g.flow1[p] & (1 << (b ^ 4))) !== 0;
        g.up[c] = 0; g.conn1[c] = 0; g.flow1[c] = 0; g.upH[c] = 0;
        if (hw === RoadType.UrbanHighway) g.flow[c] |= 1 << b;
        else if (out) g.flow[c] &= ~(1 << b);
        g.upH[p] = g.cellH(x, 20) + 1.8;
      }
      expect(levelLinks(w).length).toBeGreaterThan(0);
      const w2 = World.load(structuredClone(w.serialize()));
      expect(levelLinks(w2)).toEqual([]);
      expect([...w2.g.flow]).toEqual([...flow]);
      expect([...w2.g.flow1]).toEqual([...flow1]);
      for (const x of [10, 11, 49, 50]) expect(w2.g.upH[g.idx(x, 20)]).toBeCloseTo(upH[g.idx(x, 20)], 0);
      expect(w2.g.up[g.idx(10, 20)]).toBe(hw);
    });
});

function ROADS_NAME(t: RoadType) {
  return t === RoadType.UrbanHighway ? 'urban two-way' : 'urban one-way';
}
