// 取り壊しの階層（地上・高架・地下・すべて）
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { DX, DY, opp } from '../src/sim/constants';
import { listORamps } from '../src/sim/oramp';
import { normRect, planBulldoze, BulldozeLayer } from '../src/sim/plan';
import { buildJunctions, buildRoadGraph } from '../src/sim/traffic';

const Y = 20;

function flat(n = 64) {
  const w = new World(n);
  w.g.heights.fill(6);
  w.funds = 1e9;
  return w;
}
const ok = (w: World, c: Parameters<World['exec']>[0]) => {
  const r = w.exec(c);
  expect(r.ok, `${c.t}: ${r.msg}`).toBe(true);
  return r;
};

// 一般道 + その真上の高架の都市高速 + 真下の地下鉄（すべて y = Y の線）
function stack(under = RoadType.Road) {
  const w = flat();
  ok(w, { t: 'road', x0: 4, y0: Y, x1: 58, y1: Y, road: under });
  ok(w, { t: 'road', x0: 4, y0: Y, x1: 58, y1: Y, road: RoadType.UrbanHighway });
  ok(w, { t: 'transit', x0: 4, y0: Y, x1: 58, y1: Y, kind: 'sub' });
  return w;
}

// つながりの印が両側でそろっていて、道路のないマスにつながっていない
function consistent(w: World) {
  const g = w.g, n = g.n;
  const bad: string[] = [];
  for (let c = 0; c < n * n; c++)
    for (const L of [0, 1]) {
      const conn = L ? g.conn1 : g.conn, flow = L ? g.flow1 : g.flow, type = L ? g.up : g.road;
      if (flow[c] & ~conn[c]) bad.push(`flow without conn at ${c}/${L}`);
      if (conn[c] && !type[c]) bad.push(`conn without road at ${c}/${L}`);
      for (let d = 0; d < 8; d++) {
        if (!(conn[c] & (1 << d))) continue;
        const x = (c % n) + DX[d], y = ((c / n) | 0) + DY[d];
        if (!g.inb(x, y)) { bad.push(`edge off map ${c}`); continue; }
        const j = g.idx(x, y), Lj = g.arriveLevel(L, j, d);
        const cj = Lj ? g.conn1 : g.conn, tj = Lj ? g.up : g.road;
        if (!(cj[j] & (1 << opp(d))) || !tj[j]) bad.push(`one-sided link ${c}/${L} -> ${j}/${Lj}`);
      }
    }
  // 経路探索のグラフも作れる
  const N = n * n;
  buildRoadGraph(g, new Float32Array(2 * N).fill(1), buildJunctions(g, new Float32Array(2 * N)));
  return bad;
}

function reach(w: World, from: number, to: number) {
  const g = w.g;
  const seen = new Set([from]), st = [from];
  while (st.length) {
    const u = st.pop()!;
    if (u === to) return true;
    g.forEachOut(u, (v) => { if (!seen.has(v)) { seen.add(v); st.push(v); } });
  }
  return false;
}

const bull = (w: World, layer: BulldozeLayer | undefined, x0 = 28, x1 = 32) => w.exec({ t: 'bulldoze', x0, y0: Y, x1, y1: Y, ...(layer ? { layer } : {}) });

describe('layered bulldoze: road + viaduct + subway', () => {
  const g0 = (w: World, x: number) => w.g.idx(x, Y);

  it('ground (the default) removes only the road below', () => {
    for (const layer of [undefined, 'ground'] as const) {
      const w = stack();
      const g = w.g, N = g.n * g.n;
      const funds = w.funds;
      expect(bull(w, layer).ok).toBe(true);
      expect(w.funds).toBe(funds - 5 * 5);
      for (let x = 28; x <= 32; x++) {
        expect(g.road[g0(w, x)]).toBe(0);
        expect(g.up[g0(w, x)]).toBe(RoadType.UrbanHighway);
        expect(g.sub[g0(w, x)]).not.toBe(0);
      }
      expect(consistent(w)).toEqual([]);
      // 高架はそのまま通れる。下の道路は切れている
      expect(reach(w, N + g0(w, 10), N + g0(w, 50))).toBe(true);
      expect(reach(w, N + g0(w, 50), N + g0(w, 10))).toBe(true);
      expect(g.conn[g0(w, 27)] & 1).toBe(0);
      expect(g.conn1[g0(w, 27)] & 1).not.toBe(0);
    }
  });

  it('elevated removes only the viaduct and keeps the road below connected', () => {
    const w = stack();
    const g = w.g;
    const funds = w.funds;
    expect(bull(w, 'up').ok).toBe(true);
    expect(w.funds).toBe(funds - 20 * 5);
    for (let x = 28; x <= 32; x++) {
      expect(g.up[g0(w, x)]).toBe(0);
      expect(g.road[g0(w, x)]).toBe(RoadType.Road);
      expect(g.sub[g0(w, x)]).not.toBe(0);
    }
    expect(consistent(w)).toEqual([]);
    expect(reach(w, g0(w, 10), g0(w, 50))).toBe(true);
    expect(reach(w, g0(w, 50), g0(w, 10))).toBe(true);
    // 高架の切れた端は、下の道路に降りない
    expect(g.conn1[g0(w, 27)] & 1).toBe(0);
    expect(g.conn[g0(w, 27)] & 1).not.toBe(0);
  });

  it('underground removes only the subway', () => {
    const w = stack();
    const g = w.g, N = g.n * g.n;
    expect(bull(w, 'sub').ok).toBe(true);
    for (let x = 28; x <= 32; x++) {
      expect(g.sub[g0(w, x)]).toBe(0);
      expect(g.road[g0(w, x)]).toBe(RoadType.Road);
      expect(g.up[g0(w, x)]).toBe(RoadType.UrbanHighway);
    }
    expect(g.sub[g0(w, 27)] & 1).toBe(0); // 隣の線路のつながりも外れる
    expect(g.sub[g0(w, 27)] & (1 << 4)).not.toBe(0);
    expect(consistent(w)).toEqual([]);
    expect(reach(w, g0(w, 10), g0(w, 50))).toBe(true);
    expect(reach(w, N + g0(w, 10), N + g0(w, 50))).toBe(true);
  });

  it('all removes everything, as before', () => {
    const w = stack();
    const g = w.g;
    expect(bull(w, 'all').ok).toBe(true);
    for (let x = 28; x <= 32; x++) expect(g.road[g0(w, x)] | g.up[g0(w, x)] | g.sub[g0(w, x)]).toBe(0);
    expect(consistent(w)).toEqual([]);
  });

  it('the plan (preview) lists only the chosen layer', () => {
    const w = stack();
    const g = w.g;
    const r = normRect(28, Y, 32, Y, g.n);
    const info = (id: number) => w.buildings.get(id);
    const p = (l: BulldozeLayer) => planBulldoze(g, r, info, l);
    expect(p('ground').roads.length).toBe(5);
    expect(p('ground').transit.length).toBe(0);
    expect(p('up').roads.length).toBe(5);
    expect(p('up').cost).toBe(100);
    expect(p('sub').roads.length).toBe(0);
    expect(p('sub').transit.length).toBe(5);
    expect(p('all').roads.length).toBe(5);
    expect(p('all').transit.length).toBe(5);
    // 何もない階層
    const w2 = flat();
    ok(w2, { t: 'road', x0: 4, y0: Y, x1: 58, y1: Y, road: RoadType.Road });
    const res = bull(w2, 'up');
    expect(res.ok).toBe(false);
    expect(res.msg).toContain('高架');
  });

  it('removing the viaduct over an avenue drops its overlay ramps and keeps the avenue', () => {
    const w = flat();
    const g = w.g;
    ok(w, { t: 'road', x0: 6, y0: Y, x1: 56, y1: Y, road: RoadType.Avenue });
    ok(w, { t: 'road', x0: 6, y0: Y, x1: 56, y1: Y, road: RoadType.UrbanHighway });
    ok(w, { t: 'oramp', mode: 'set', x: 30, y: Y });
    expect(listORamps(g).length).toBeGreaterThan(0);
    const before = g.road.slice(), conn = g.conn.slice(), flow = g.flow.slice();
    ok(w, { t: 'bulldoze', x0: 20, y0: Y, x1: 40, y1: Y, layer: 'up' });
    expect(listORamps(g).length).toBe(0);
    expect([...g.road]).toEqual([...before]);
    expect([...g.conn]).toEqual([...conn]);
    expect([...g.flow]).toEqual([...flow]);
    expect(consistent(w)).toEqual([]);
  });

  it('removing an elevated urban highway drops the 1x5 ramps hanging off it', () => {
    const w = flat();
    const g = w.g;
    ok(w, { t: 'road', x0: 2, y0: Y, x1: 60, y1: Y, road: RoadType.UrbanHighway });
    ok(w, { t: 'road', x0: 20, y0: Y + 2, x1: 20, y1: 40, road: RoadType.Road });
    ok(w, { t: 'uramp', x: 20, y: Y + 1 });
    expect(g.road[g.idx(20, Y + 1)]).toBe(RoadType.Ramp);
    ok(w, { t: 'bulldoze', x0: 10, y0: Y, x1: 30, y1: Y, layer: 'up' });
    for (let x = 18; x <= 22; x++) expect(g.road[g.idx(x, Y + 1)] | g.up[g.idx(x, Y + 1)]).toBe(0);
    // ランプにつないだ一般道は残る
    expect(g.road[g.idx(20, Y + 2)]).toBe(RoadType.Road);
    expect(consistent(w)).toEqual([]);
  });

  it('removing the road under a wide elevated highway keeps the highway', () => {
    const w = flat();
    const g = w.g, N = g.n * g.n;
    ok(w, { t: 'road', x0: 30, y0: 4, x1: 30, y1: 58, road: RoadType.Road });
    ok(w, { t: 'road', x0: 4, y0: Y, x1: 58, y1: Y, road: RoadType.Highway });
    ok(w, { t: 'bulldoze', x0: 30, y0: Y - 2, x1: 30, y1: Y + 2 });
    expect(g.up[g.idx(30, Y)]).toBe(RoadType.Highway);
    expect(g.road[g.idx(30, Y)]).toBe(0);
    expect(consistent(w)).toEqual([]);
    expect(reach(w, N + g.idx(10, Y), N + g.idx(50, Y))).toBe(true);
  });
});

describe('layered bulldoze: buildings and rail lines', () => {
  it('a building over a subway: ground takes the building, underground takes the line', () => {
    for (const layer of ['ground', 'sub', 'up', 'all'] as const) {
      const w = flat();
      const g = w.g;
      ok(w, { t: 'road', x0: 4, y0: Y, x1: 58, y1: Y, road: RoadType.Road });
      ok(w, { t: 'transit', x0: 4, y0: Y + 1, x1: 58, y1: Y + 1, kind: 'sub' });
      ok(w, { t: 'plop', id: 'park_s', x: 30, y: Y + 1 });
      ok(w, { t: 'pline', x0: 31, y0: Y + 1, x1: 33, y1: Y + 1 });
      const i = g.idx(30, Y + 1);
      const r = w.exec({ t: 'bulldoze', x0: 30, y0: Y + 1, x1: 31, y1: Y + 1, layer });
      expect(r.ok).toBe(layer !== 'up');
      expect(g.bldg[i] !== 0).toBe(layer === 'sub' || layer === 'up');
      expect(g.pline[g.idx(31, Y + 1)] !== 0).toBe(layer === 'sub' || layer === 'up');
      expect(g.sub[i] !== 0).toBe(layer === 'ground' || layer === 'up');
      // 道路はどの階層でも、この範囲にはない
      expect(g.road[g.idx(30, Y)]).toBe(RoadType.Road);
    }
  });

  it('ground rail is ground, elevated rail and monorail are elevated', () => {
    const w = flat();
    const g = w.g;
    ok(w, { t: 'transit', x0: 4, y0: 10, x1: 58, y1: 10, kind: 'rail' });
    ok(w, { t: 'transit', x0: 30, y0: 2, x1: 30, y1: 58, kind: 'erail' });
    ok(w, { t: 'transit', x0: 4, y0: 40, x1: 58, y1: 40, kind: 'mono' });
    ok(w, { t: 'bulldoze', x0: 30, y0: 10, x1: 30, y1: 10, layer: 'ground' });
    expect(g.rail[g.idx(30, 10)]).toBe(0);
    expect(g.erail[g.idx(30, 10)]).not.toBe(0);
    ok(w, { t: 'bulldoze', x0: 30, y0: 40, x1: 30, y1: 40, layer: 'up' });
    expect(g.mono[g.idx(30, 40)]).toBe(0);
    expect(g.erail[g.idx(30, 40)]).toBe(0);
    expect(g.erail[g.idx(30, 10)]).not.toBe(0);
    expect(w.exec({ t: 'bulldoze', x0: 20, y0: 40, x1: 20, y1: 40, layer: 'ground' }).ok).toBe(false);
  });
});
