// 都市高速どうしのジャンクション：形 × 高さの組み合わせ × 縦横・斜めで、計画が通り、すべての乗り換えが走れるか
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { Grid } from '../src/sim/grid';
import { buildJunctions, buildRoadGraph, urbanTurnOk } from '../src/sim/traffic';
import { JctForm, planJct } from '../src/sim/jct';

const G = RoadType.UrbanGroundHighway, E = RoadType.UrbanHighway, G1 = RoadType.UrbanGroundHighway1W, E1 = RoadType.UrbanHighway1W;
const C = 48;

// 経路探索（assignTrips）と同じ道路網・同じ決まり（Uターンなし、都市高速のランプへの出入りは右折か直進だけ）で、from から to へ行けるか
function reachable(g: Grid, from: number, din: number, to: number) {
  const N = g.n * g.n;
  const graph = buildRoadGraph(g, new Float32Array(2 * N).fill(1), buildJunctions(g, new Float32Array(2 * N)));
  const { off, to: tgt, dir, urban } = graph;
  const seen = new Set<number>();
  const q: [number, number, number][] = [[from, din, -1]];
  while (q.length) {
    const [u, di, prev] = q.pop()!;
    if (u === to) return true;
    for (let e = off[u]; e < off[u + 1]; e++) {
      const d = dir[e], v = tgt[e];
      if (di >= 0 && ((d - di + 8) & 7) === 4) continue;
      if (urban[u] === 1 && (urban[v] === 2 || (prev >= 0 && urban[prev] === 2)) && !urbanTurnOk(di, d)) continue;
      const k = (v * 8 + d) * 4 + (urban[u] === 2 ? 1 : 0);
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([v, d, u]);
    }
  }
  return false;
}

// 端のマスのノード（高架なら上空）
const nodeAt = (g: Grid, x: number, y: number) => {
  const c = g.idx(x, y);
  return g.up[c] ? g.n * g.n + c : c;
};

interface End { x: number; y: number; dIn: number; inb: boolean; outb: boolean; hw: number }

// 2本の都市高速を引いて、ジャンクションを作る。返り値：腕の端（交差点から 30 マス）
function build(kind: 'x' | 't', ta: number, tb: number, diagA: boolean, diagB: boolean, form: JctForm) {
  const w = new World(96);
  w.g.heights.fill(10);
  w.funds = 1e9;
  const R = 30;
  // A：東西（または北東の斜め）。B：南北（または南東の斜め）
  const a0: [number, number] = diagA ? [C - R, C + R] : [C - R, C];
  const a1: [number, number] = diagA ? [C + R, C - R] : [C + R, C];
  const b0: [number, number] = diagB ? [C - R, C - R] : [C, C - R];
  const b1: [number, number] = diagB ? [C + R, C + R] : [C, C + R];
  const ok = (r: { ok: boolean; msg?: string }) => expect(r.ok, r.msg).toBe(true);
  ok(w.exec({ t: 'road', x0: a0[0], y0: a0[1], x1: a1[0], y1: a1[1], road: ta }));
  // T字：B は交差点で終わる（南東・南から来て、A に突き当たる）
  if (kind === 't') ok(w.exec({ t: 'road', x0: b1[0], y0: b1[1], x1: C, y1: C, road: tb }));
  else ok(w.exec({ t: 'road', x0: b0[0], y0: b0[1], x1: b1[0], y1: b1[1], road: tb }));
  const plan = planJct(w.g, form, C, C);
  expect(plan.ok, plan.reason).toBe(true);
  const r = w.exec({ t: 'jct', form, x: C, y: C });
  expect(r.ok, r.msg).toBe(true);
  const one = (t: number) => t === G1 || t === E1;
  const dirOf = (p: [number, number], q: [number, number]) => [0, 1, 2, 3, 4, 5, 6, 7].find((d) => [1, 1, 0, -1, -1, -1, 0, 1][d] === Math.sign(q[0] - p[0]) && [0, 1, 1, 1, 0, -1, -1, -1][d] === Math.sign(q[1] - p[1]))!;
  const ends: End[] = [];
  // 引いた向き：a0 → a1、b0 → b1（T字は b1 → 交差点）
  const pushEnds = (p0: [number, number], p1: [number, number], t: number, hw: number, both: boolean) => {
    // 端から2マス内側
    const s0: [number, number] = [p0[0] + Math.sign(p1[0] - p0[0]) * 2, p0[1] + Math.sign(p1[1] - p0[1]) * 2];
    const s1: [number, number] = [p1[0] + Math.sign(p0[0] - p1[0]) * 2, p1[1] + Math.sign(p0[1] - p1[1]) * 2];
    // p0 側の腕：入る向き = p0 → p1。一方通行は p0 → p1 に走る
    ends.push({ x: s0[0], y: s0[1], dIn: dirOf(p0, p1), inb: true, outb: !one(t), hw });
    if (both) ends.push({ x: s1[0], y: s1[1], dIn: dirOf(p1, p0), inb: !one(t), outb: true, hw });
  };
  pushEnds(a0, a1, ta, 0, true);
  if (kind === 't') pushEnds(b1, [C, C], tb, 1, false);
  else pushEnds(b0, b1, tb, 1, true);
  return { w, ends, plan };
}

function checkAll(kind: 'x' | 't', ta: number, tb: number, diagA: boolean, diagB: boolean, form: JctForm) {
  const { w, ends } = build(kind, ta, tb, diagA, diagB, form);
  const g = w.g;
  let checked = 0;
  for (const A of ends)
    for (const B of ends) {
      if (A === B || !A.inb || !B.outb) continue;
      // T字の合わさる側の一方通行：入るだけ（出ていく腕はない）
      if (A.hw === B.hw && (kind === 't' || A.dIn === B.dIn)) {
        // 本線をそのまま走る（逆向きの端どうし）
        if (A.dIn !== (B.dIn + 4) % 8 && A.hw === B.hw && ends.filter((e) => e.hw === A.hw).length === 2) {
          expect(reachable(g, nodeAt(g, A.x, A.y), A.dIn, nodeAt(g, B.x, B.y)), `through ${A.x},${A.y} → ${B.x},${B.y}`).toBe(true);
          checked++;
        }
        continue;
      }
      expect(reachable(g, nodeAt(g, A.x, A.y), A.dIn, nodeAt(g, B.x, B.y)), `${form}: ${A.x},${A.y} → ${B.x},${B.y}`).toBe(true);
      checked++;
    }
  expect(checked).toBeGreaterThan(1);
  // ジャンクションのランプには印がついている（容量と速さが大きい）
  let jr = 0;
  for (let i = 0; i < g.n * g.n; i++) if (g.jct[i]) jr++;
  expect(jr).toBeGreaterThan(10);
  // ランプは信号のある交差点にならない
  const jm = buildJunctions(g, new Float32Array(2 * g.n * g.n).fill(5000));
  for (let i = 0; i < g.n * g.n; i++) if (g.road[i] === RoadType.Ramp) expect(jm.ctl[i]).toBe(0);
}

const LEVELS: [string, number, number][] = [
  ['ground × ground', G, G],
  ['elevated × elevated', E, E],
  ['ground × elevated', G, E],
  ['elevated × ground', E, G],
];
const GEOMS: [string, boolean, boolean][] = [
  ['axis × axis', false, false],
  ['axis × diagonal', false, true],
  ['diagonal × diagonal', true, true],
];

for (const form of ['semi', 'clover', 'turbine'] as JctForm[])
  describe(`junction ${form}`, () => {
    for (const [ln, ta, tb] of LEVELS)
      for (const [gn, da, db] of GEOMS)
        it(`${ln}, ${gn}`, { timeout: 60000 }, () => checkAll('x', ta, tb, da, db, form));
  });

describe('junction tee (T / Y)', () => {
  for (const [ln, ta, tb] of LEVELS)
    for (const [gn, da, db] of GEOMS) it(`${ln}, ${gn}`, { timeout: 60000 }, () => checkAll('t', ta, tb, da, db, 'tee'));
});

describe('junction with one-way urban highways', () => {
  it('semi: one-way ground × two-way elevated', { timeout: 60000 }, () => checkAll('x', G1, E, false, false, 'semi'));
  it('turbine: one-way elevated × one-way ground (diagonal)', { timeout: 60000 }, () => checkAll('x', E1, G1, false, true, 'turbine'));
  it('clover: one-way × one-way, both elevated', { timeout: 60000 }, () => checkAll('x', E1, E1, false, false, 'clover'));
  it('tee: one-way branch merging into a two-way highway', { timeout: 60000 }, () => checkAll('t', G, G1, false, false, 'tee'));
});

describe('junction refusals', () => {
  it('explains a wrong form and blocked cells', () => {
    const w = new World(96);
    w.g.heights.fill(10);
    w.funds = 1e9;
    w.exec({ t: 'road', x0: 18, y0: C, x1: 78, y1: C, road: G });
    w.exec({ t: 'road', x0: C, y0: 18, x1: C, y1: 78, road: E });
    expect(planJct(w.g, 'tee', C, C).ok).toBe(false);
    expect(planJct(w.g, 'tee', C, C).reason).toContain('十字');
    // 本線の横がふさがっている（遠くまで一般道がびっしり）と、赤いマスを見せて断る
    for (let y = C - 20; y <= C + 20; y++) if (Math.abs(y - C) > 0) w.exec({ t: 'road', x0: C - 20, y0: y, x1: C - 1, y1: y, road: RoadType.Street });
    for (let y = C - 20; y <= C + 20; y++) if (Math.abs(y - C) > 0) w.exec({ t: 'road', x0: C + 1, y0: y, x1: C + 20, y1: y, road: RoadType.Street });
    const p = planJct(w.g, 'semi', C, C);
    expect(p.ok).toBe(false);
    expect(p.reason.length).toBeGreaterThan(4);
    expect(p.bad.size).toBeGreaterThan(0);
    // 何もない場所
    expect(planJct(w.g, 'semi', 5, 5).ok).toBe(false);
  });
});
