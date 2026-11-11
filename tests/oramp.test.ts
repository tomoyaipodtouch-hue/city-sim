// 重ねランプ（高架の都市高速と、真下の一般道を結ぶ短いランプ）
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { DX, DY } from '../src/sim/constants';
import { decodeORamp, listORamps, orampCapScale, orampGround, orampHw, ORAMP_LEN, ORampSpec } from '../src/sim/oramp';
import { buildJunctions, buildRoadGraph } from '../src/sim/traffic';

const E = RoadType.UrbanHighway, E1 = RoadType.UrbanHighway1W;
const Y = 20, T = 30;

// 平らな地図に、下の道路と、その上に同じ線の高架の都市高速を引く
function scene(under: RoadType, hw: RoadType, diag = false, reverse = false) {
  const w = new World(64);
  w.g.heights.fill(6);
  w.funds = 1e9;
  const [x0, y0, x1, y1] = diag ? [8, 8, 52, 52] : [6, Y, 56, Y];
  const [a0, b0, a1, b1] = reverse ? [x1, y1, x0, y0] : [x0, y0, x1, y1];
  expect(w.exec({ t: 'road', x0: a0, y0: b0, x1: a1, y1: b1, road: under }).ok).toBe(true);
  expect(w.exec({ t: 'road', x0: a0, y0: b0, x1: a1, y1: b1, road: hw }).ok).toBe(true);
  return w;
}

// ランプのまわり（tx, ty から 8 マス以内）だけを通って、from から to へ行けるか（本線の端で地上へ降りる道は使わない）
function reach(w: World, from: number, to: number, cx: number, cy: number) {
  const g = w.g, n = g.n, N = n * n;
  const seen = new Set([from]), st = [from];
  while (st.length) {
    const u = st.pop()!;
    if (u === to) return true;
    g.forEachOut(u, (v) => {
      const c = v % N, x = c % n, y = (c / n) | 0;
      if (Math.abs(x - cx) > 8 || Math.abs(y - cy) > 8 || seen.has(v)) return;
      seen.add(v);
      st.push(v);
    });
  }
  return false;
}

// ランプ 1本が、正しい向きにだけつながっているか
function checkRamp(w: World, r: ORampSpec, around = true) {
  const g = w.g, n = g.n, N = n * n;
  const hw = orampHw(g, r), gr = orampGround(g, r);
  const at = (c: number, k: number) => { const x = (c % n) + DX[r.a] * k, y = ((c / n) | 0) + DY[r.a] * k; return y * n + x; };
  const cx = hw[2] % n, cy = (hw[2] / n) | 0;
  // 道路網のつながり（経路探索で使う形）
  const G = buildRoadGraph(g, new Float32Array(2 * N).fill(1), buildJunctions(g, new Float32Array(2 * N)));
  const edge = (u: number, v: number) => { for (let e = G.off[u]; e < G.off[u + 1]; e++) if (G.to[e] === v) return G.dir[e]; return -1; };
  if (r.entry) {
    expect(edge(gr[0], N + hw[ORAMP_LEN])).toBe(r.a);
    expect(edge(N + hw[ORAMP_LEN], gr[0])).toBe(-1);
    // 一般道の手前から、高架の先へ
    if (around) expect(reach(w, at(gr[0], -2), N + at(hw[ORAMP_LEN], 2), cx, cy)).toBe(true);
  } else {
    expect(edge(N + hw[0], gr[ORAMP_LEN])).toBe(r.a);
    expect(edge(gr[ORAMP_LEN], N + hw[0])).toBe(-1);
    if (around) expect(reach(w, N + at(hw[0], -2), at(gr[ORAMP_LEN], 2), cx, cy)).toBe(true);
  }
}

// 重ねランプがなければ、高架と下の道路は、このあたりではつながっていない
function noLinkWithout(w: World, r: ORampSpec) {
  const g = w.g, n = g.n, N = n * n;
  const hw = orampHw(g, r), gr = orampGround(g, r);
  const cx = hw[2] % n, cy = (hw[2] / n) | 0;
  return r.entry ? !reach(w, gr[0], N + hw[ORAMP_LEN], cx, cy) : !reach(w, N + hw[0], gr[ORAMP_LEN], cx, cy);
}

const UNDERS: [string, RoadType, RoadType][] = [
  ['avenue', RoadType.Avenue, E],
  ['road', RoadType.Road, E],
  ['one-way', RoadType.OneWay, E1],
];

describe('overlay ramp: single ramps (exit / entrance × edge / median × road below)', () => {
  for (const [name, under, hw] of UNDERS)
    for (const mode of ['exit', 'entry'] as const)
      for (const median of [false, true])
        it(`${mode}, ${median ? 'median' : 'edge'}, over ${name}`, () => {
          // 片側1車線の本線は、ランプが高架の外側を下りるので、真下の車線へは道の端だけ。道の真ん中は一方通行の本線で試す
          const w = scene(under, median ? E1 : hw);
          const g = w.g;
          // 南側（東行きの車線の側）をタップ
          const r0 = w.exec({ t: 'oramp', mode, x: T, y: Y, fx: T + 0.5, fy: Y + 0.8 });
          expect(r0.ok, r0.msg).toBe(true);
          const list = listORamps(g);
          expect(list.length).toBe(1);
          const r = list[0];
          expect(r.a).toBe(0); // 東行き
          expect(r.entry).toBe(mode === 'entry');
          if (median) expect(w.exec({ t: 'orampSide', start: r.start, median: true }).ok).toBe(true);
          expect(decodeORamp(g, r.start)!.median).toBe(median);
          checkRamp(w, decodeORamp(g, r.start)!);
          // 取り除くと、つながりもなくなる
          g.oramp[r.start] = 0;
          expect(noLinkWithout(w, r)).toBe(true);
        });

  it('two-way highway: the carriageway right below takes only the edge', () => {
    const w = scene(RoadType.Avenue, E);
    expect(w.exec({ t: 'oramp', mode: 'exit', x: T, y: Y, fx: T + 0.5, fy: Y + 0.8 }).ok).toBe(true);
    const r = listORamps(w.g)[0];
    const res = w.exec({ t: 'orampSide', start: r.start, median: true });
    expect(res.ok).toBe(false);
    expect(res.msg).toMatch(/道の端/);
  });

  it('a westbound ramp over an avenue lands on the opposite carriageway (partner cell)', () => {
    const w = scene(RoadType.Avenue, E);
    const r0 = w.exec({ t: 'oramp', mode: 'exit', x: T, y: Y, fx: T + 0.5, fy: Y + 0.2 });
    expect(r0.ok, r0.msg).toBe(true);
    const r = listORamps(w.g)[0];
    expect(r.a).toBe(4);
    expect(r.partner).toBe(true);
    expect(r.median).toBe(true); // 分離帯の上を下りて、追い越し車線へ
    expect(w.exec({ t: 'orampSide', start: r.start, median: false }).ok).toBe(false);
    expect(orampGround(w.g, r)[0]).toBe(w.g.idx(T + 2, Y - 1));
    checkRamp(w, r);
  });

  it('works on a diagonal road under a diagonal viaduct', () => {
    const w = scene(RoadType.Road, E, true);
    const r0 = w.exec({ t: 'oramp', mode: 'exit', x: 30, y: 30, fx: 30.2, fy: 30.8 });
    expect(r0.ok, r0.msg).toBe(true);
    const r = listORamps(w.g)[0];
    expect(r.a & 1).toBe(1);
    checkRamp(w, r);
  });
});

describe('overlay ramp: sets', () => {
  it('two-way highway over an avenue: exit then entrance in both directions', () => {
    const w = scene(RoadType.Avenue, E);
    const res = w.exec({ t: 'oramp', mode: 'set', x: T, y: Y });
    expect(res.ok, res.msg).toBe(true);
    const list = listORamps(w.g);
    expect(list.length).toBe(4);
    for (const a of [0, 4]) {
      const ex = list.find((r) => r.a === a && !r.entry)!, en = list.find((r) => r.a === a && r.entry)!;
      expect(ex && en).toBeTruthy();
      // 出口が手前（上流）、入口が先
      const along = (c: number) => (c % w.g.n) * DX[a];
      expect(along(ex.start)).toBeLessThan(along(en.start));
      checkRamp(w, ex);
      checkRamp(w, en);
    }
    // 全体で 10 マスほど（本線のつなぎ目のマスを含めて 12 マス）
    const xs = list.flatMap((r) => orampHw(w.g, r)).map((c) => c % w.g.n);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(11);
  });

  it('two-way highway over a two-way road', () => {
    const w = scene(RoadType.Road, E);
    expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
    const list = listORamps(w.g);
    expect(list.length).toBe(4);
    for (const r of list) checkRamp(w, r);
  });

  it('one-way highway gets just an exit and an entrance', () => {
    const w = scene(RoadType.OneWay, E1);
    expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
    const list = listORamps(w.g);
    expect(list.length).toBe(2);
    expect(list.every((r) => r.a === 0)).toBe(true);
    for (const r of list) checkRamp(w, r);
  });

  it('two-way highway over a one-way road: only the matching direction', () => {
    const w = scene(RoadType.OneWay, E);
    const res = w.exec({ t: 'oramp', mode: 'set', x: T, y: Y });
    expect(res.ok, res.msg).toBe(true);
    expect(res.msg).toBeTruthy();
    const list = listORamps(w.g);
    expect(list.length).toBe(2);
    expect(list.every((r) => r.a === 0)).toBe(true);
  });

  it('the info tool edits each direction and the landing side', () => {
    const w = scene(RoadType.Avenue, E);
    const g = w.g;
    expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
    const Tc = g.idx(T, Y);
    const count = (a: number, entry: boolean) => listORamps(g).filter((r) => r.a === a && r.entry === entry).length;
    // 東行き：出口だけ
    expect(w.exec({ t: 'orampDir', T: Tc, a0: 0, a: 0, want: 1 }).ok).toBe(true);
    expect([count(0, false), count(0, true), count(4, false), count(4, true)]).toEqual([1, 0, 1, 1]);
    // 西行き：入口だけ
    expect(w.exec({ t: 'orampDir', T: Tc, a0: 0, a: 4, want: 2 }).ok).toBe(true);
    expect([count(0, false), count(0, true), count(4, false), count(4, true)]).toEqual([1, 0, 0, 1]);
    // 西行き：なし、東行き：出口と入口に戻す
    expect(w.exec({ t: 'orampDir', T: Tc, a0: 0, a: 4, want: 0 }).ok).toBe(true);
    expect(w.exec({ t: 'orampDir', T: Tc, a0: 0, a: 0, want: 3 }).ok).toBe(true);
    expect([count(0, false), count(0, true), count(4, false), count(4, true)]).toEqual([1, 1, 0, 0]);
    for (const r of listORamps(g)) checkRamp(w, r);
    for (const r of listORamps(g)) expect(r.median).toBe(false);
  });

  it('the info tool switches the landing side on a one-way highway', () => {
    const w = scene(RoadType.Avenue, E1);
    const g = w.g;
    expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
    const ex = listORamps(g).find((r) => !r.entry)!;
    expect(ex.median).toBe(false);
    expect(w.exec({ t: 'orampSide', start: ex.start, median: true }).ok).toBe(true);
    expect(decodeORamp(g, ex.start)!.median).toBe(true);
    checkRamp(w, decodeORamp(g, ex.start)!);
    // 入口だけにして、また出口を足すと、降りる位置は入口に合わせる
    expect(w.exec({ t: 'orampDir', T: g.idx(T, Y), a0: 0, a: 0, want: 2 }).ok).toBe(true);
    expect(w.exec({ t: 'orampDir', T: g.idx(T, Y), a0: 0, a: 0, want: 3 }).ok).toBe(true);
    expect(listORamps(g).length).toBe(2);
  });
});

describe('overlay ramp: removal, saves and capacity', () => {
  it('bulldozing the highway or the road removes the ramps', () => {
    for (const cell of [T - 2, T + 2]) {
      const w = scene(RoadType.Road, E);
      expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
      expect(w.exec({ t: 'bulldoze', x0: cell, y0: Y, x1: cell, y1: Y }).ok).toBe(true);
      // そのマスにかかっていたランプは消え、残ったランプも正しくつながる
      for (const r of listORamps(w.g)) {
        expect(orampHw(w.g, r)).not.toContain(w.g.idx(cell, Y));
        checkRamp(w, r, false); // 壊したマスの先へは行けないので、ランプのつながりだけ
      }
      expect(listORamps(w.g).length).toBeLessThan(4);
    }
  });

  it('saves keep ramps, and old saves without the array load', () => {
    const w = scene(RoadType.Avenue, E);
    expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
    const save = structuredClone(w.serialize());
    const w2 = World.load(save);
    expect(listORamps(w2.g).length).toBe(4);
    const old = structuredClone(w.serialize()) as unknown as Record<string, unknown>;
    delete old.oramp;
    const w3 = World.load(old as never);
    expect(listORamps(w3.g).length).toBe(0);
  });

  it('narrow roads under a ramp lose capacity, avenues do not', () => {
    const w = scene(RoadType.OneWay, E1);
    expect(w.exec({ t: 'oramp', mode: 'exit', x: T, y: Y }).ok).toBe(true);
    const m = orampCapScale(w.g);
    expect(m.size).toBeGreaterThan(0);
    expect([...m.values()].every((v) => v < 1)).toBe(true);
    const w2 = scene(RoadType.Avenue, E);
    expect(w2.exec({ t: 'oramp', mode: 'exit', x: T, y: Y, fx: T + 0.5, fy: Y + 0.8 }).ok).toBe(true);
    expect(orampCapScale(w2.g).size).toBe(0);
  });
});

describe('overlay ramp: refusals', () => {
  it('needs a viaduct over a local road', () => {
    const w = new World(64);
    w.g.heights.fill(6);
    w.funds = 1e9;
    w.exec({ t: 'road', x0: 6, y0: Y, x1: 56, y1: Y, road: E });
    const r = w.exec({ t: 'oramp', mode: 'set', x: T, y: Y });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/真下/);
  });

  it('refuses near a junction of the road below', () => {
    const w = scene(RoadType.Road, E);
    w.exec({ t: 'road', x0: T + 1, y0: Y - 6, x1: T + 1, y1: Y + 6, road: RoadType.Road });
    const r = w.exec({ t: 'oramp', mode: 'exit', x: T, y: Y, fx: T + 0.5, fy: Y + 0.8 });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/交差点/);
  });

  it('refuses when the road below runs the other way', () => {
    const w = scene(RoadType.OneWay, E1, false, false);
    // 一方通行の本線と逆向きの一方通行
    const w2 = new World(64);
    w2.g.heights.fill(6);
    w2.funds = 1e9;
    w2.exec({ t: 'road', x0: 56, y0: Y, x1: 6, y1: Y, road: RoadType.OneWay });
    w2.exec({ t: 'road', x0: 6, y0: Y, x1: 56, y1: Y, road: E1 });
    const r = w2.exec({ t: 'oramp', mode: 'set', x: T, y: Y });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/向き/);
    expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
  });

  it('refuses overlapping ramps and diagonal avenues', () => {
    const w = scene(RoadType.Road, E);
    expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
    const r = w.exec({ t: 'oramp', mode: 'set', x: T + 1, y: Y });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/重なります|まっすぐ/);
    const w2 = scene(RoadType.Avenue, E, true);
    const r2 = w2.exec({ t: 'oramp', mode: 'set', x: 30, y: 30 });
    expect(r2.ok).toBe(false);
    expect(r2.msg).toMatch(/斜めの大通り/);
  });

  it('refuses near the map edge', () => {
    const w = new World(64);
    w.g.heights.fill(6);
    w.funds = 1e9;
    w.exec({ t: 'road', x0: 0, y0: Y, x1: 20, y1: Y, road: RoadType.Road });
    w.exec({ t: 'road', x0: 0, y0: Y, x1: 20, y1: Y, road: E });
    const r = w.exec({ t: 'oramp', mode: 'set', x: 2, y: Y });
    expect(r.ok).toBe(false);
  });
});

describe('overlay ramp: drawn shape', () => {
  it('descends smoothly (about 15% at most) and meets the highway lane and the road lane', async () => {
    const { findORamps, orAt } = await import('../src/render/oramp');
    for (const [under, hw] of [[RoadType.Avenue, E], [RoadType.Road, E], [RoadType.OneWay, E1]] as const) {
      const w = scene(under, hw);
      expect(w.exec({ t: 'oramp', mode: 'set', x: T, y: Y }).ok).toBe(true);
      const list = findORamps(w.g, 0.3);
      expect(list.length).toBeGreaterThanOrEqual(2);
      for (const G of list) {
        let maxG = 0, maxTurn = 0, prev = orAt(G, 0), prevDir = Math.atan2(prev.tz, prev.tx);
        const p0 = { ...prev };
        for (let k = 1; k <= 160; k++) {
          const p = orAt(G, (G.len * k) / 160);
          const ds = Math.hypot(p.x - prev.x, p.z - prev.z);
          maxG = Math.max(maxG, Math.abs(p.h - prev.h) / ds);
          const dir = Math.atan2(p.tz, p.tx);
          maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(dir - prevDir), Math.cos(dir - prevDir))));
          prev = { ...p };
          prevDir = dir;
        }
        expect(maxG).toBeLessThan(0.17);
        expect(maxTurn).toBeLessThan(0.05); // 0.5m ごとに 3° 未満（角ばった折れ目がない）
        // 本線の側の端は本線の車線、一般道の側の端は一般道の車線
        const hwEnd = G.r.entry ? prev : p0, gEnd = G.r.entry ? p0 : prev;
        expect(Math.abs(hwEnd.o - G.Lh)).toBeLessThan(0.05);
        expect(Math.abs(gEnd.o - G.Lg)).toBeLessThan(0.05);
        expect(hwEnd.h).toBeGreaterThan(gEnd.h + 7);
      }
    }
  });
});
