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
  expect(jr).toBeGreaterThan(4);
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

// ---- 車の道すじ（carLayer と同じ形）：ジャンクションのランプの曲線と、ふつうのマスの道すじがつながっているか ----
import { findJctChains, jAt, jctSegs, jKey, jHalf } from '../src/render/jctCurve';
import { CELL, DX as DXc, DY as DYc } from '../src/sim/constants';
import { ROADS as RD } from '../src/sim/defs';
import { isUrbanHighway as isUH } from '../src/sim/traffic';

// 車がマス（ノード u、入る向き din、出る向き d）の中の t にいるときの位置（carLayer.place と同じ。ふつうのマスは右の車線の位置）
function carPos(g: Grid, segs: ReturnType<typeof jctSegs>, u: number, din: number, d: number, t: number) {
  const N = g.n * g.n, c = u % N, n = g.n;
  const s = segs.get(jKey(u, din, d));
  if (s) {
    const q = jAt(s.C, s.s0 + (s.s1 - s.s0) * t);
    return { x: q.x, z: q.z, seg: true };
  }
  const cx = ((c % n) + 0.5) * CELL, cz = (((c / n) | 0) + 0.5) * CELL;
  const ax = cx - DXc[din] * CELL * 0.5, az = cz - DYc[din] * CELL * 0.5, bx = cx + DXc[d] * CELL * 0.5, bz = cz + DYc[d] * CELL * 0.5;
  const p0 = (1 - t) * (1 - t), p1 = 2 * t * (1 - t), p2 = t * t;
  let x = p0 * ax + p1 * cx + p2 * bx, z = p0 * az + p1 * cz + p2 * bz;
  const tx = 2 * (1 - t) * (cx - ax) + 2 * t * (bx - cx), tz = 2 * (1 - t) * (cz - az) + 2 * t * (bz - cz), tl = Math.hypot(tx, tz) || 1;
  const def = RD[g.nodeType(u)];
  // 両方向の道路は右の車線（一方通行の2車線は、どちらの車線でもよいので真ん中）
  const lane = def && !def.oneWay ? (def.width / 2) * 0.48 : 0;
  x += (-tz / tl) * lane;
  z += (tx / tl) * lane;
  return { x, z, seg: false };
}

// ジャンクションのまわりで車が通れるすべての「マス → 次のマス」で、道すじが途切れない（跳ばない）か
function carPathGaps(g: Grid) {
  const N = g.n * g.n;
  const segs = jctSegs(g, findJctChains(g, 0));
  const isRamp = (v: number) => g.nodeType(v) === RoadType.Ramp;
  // 入ってくる向き：前のノードからの向き
  const ins = new Map<number, Set<number>>();
  for (let u = 0; u < 2 * N; u++) {
    if (!g.nodeType(u)) continue;
    g.forEachOut(u, (v, d) => { (ins.get(v) ?? ins.set(v, new Set()).get(v)!).add(d); });
  }
  const ok = (u: number, din: number, d: number, v: number, prevRamp: boolean) => {
    if (((d - din + 8) & 7) === 4) return false;
    if (isUH(g.nodeType(u)) && (isRamp(v) || prevRamp) && !urbanTurnOk(din, d)) return false;
    return true;
  };
  const bad: string[] = [];
  let checked = 0;
  for (let u = 0; u < 2 * N; u++) {
    const tu = g.nodeType(u);
    if (!tu || !(isRamp(u) || RD[tu]?.highway)) continue;
    for (const din of ins.get(u) ?? []) {
      // u に din で入ったときの、前のノードがランプか
      const pc = (u % N) - DXc[din] - DYc[din] * g.n;
      const prevRamp = pc >= 0 && (g.road[pc] === RoadType.Ramp || g.up[pc] === RoadType.Ramp);
      g.forEachOut(u, (v, d) => {
        if (!ok(u, din, d, v, prevRamp)) return;
        g.forEachOut(v, (w, d2) => {
          if (!ok(v, d, d2, w, isRamp(u))) return;
          const a = carPos(g, segs, u, din, d, 1), b = carPos(g, segs, v, d, d2, 0);
          if (!a.seg && !b.seg) return;
          checked++;
          const gap = Math.hypot(a.x - b.x, a.z - b.z);
          if (gap > 3) bad.push(`${u}(${din}->${d})${a.seg ? "S" : ""}[${g.nodeType(u)}] → ${v}(${d}->${d2})${b.seg ? "S" : ""}[${g.nodeType(v)}] gap ${gap.toFixed(1)}m`);
        });
      });
    }
  }
  return { bad, checked };
}

describe('junction car paths are continuous (carLayer follows the drawn curves without jumps)', () => {
  const cases: [string, 'x' | 't', number, number, boolean, boolean, JctForm][] = [];
  for (const [ln, ta, tb] of LEVELS) for (const [gn, da, db] of GEOMS) cases.push([`tee ${ln}, ${gn}`, 't', ta, tb, da, db, 'tee']);
  cases.push(['tee one-way branch', 't', G, G1, false, false, 'tee'], ['tee one-way through', 't', E1, E, false, false, 'tee']);
  for (const form of ['semi', 'clover', 'turbine'] as JctForm[]) cases.push([`${form} mixed axis`, 'x', G, E, false, false, form], [`${form} elevated diagonal`, 'x', E, E, false, true, form]);
  for (const [name, kind, ta, tb, da, db, form] of cases)
    it(name, { timeout: 60000 }, () => {
      const { w } = build(kind, ta, tb, da, db, form);
      const r = carPathGaps(w.g);
      expect(r.checked).toBeGreaterThan(4);
      expect(r.bad, r.bad.slice(0, 6).join('\n')).toEqual([]);
    });
});

// ---- T字・Y字の合わさる側の本線の端：行き止まりの切れ端（丸い端）を残さず、端のマスでランプに分かれる ----
describe('junction ramp ends meet a carriageway', () => {
  const popc = (m: number) => { let k = 0; for (; m; m &= m - 1) k++; return k; };
  const cases: [string, 'x' | 't', number, number, boolean, boolean, JctForm][] = [];
  for (const [ln, ta, tb] of LEVELS) for (const [gn, da, db] of GEOMS) cases.push([`tee ${ln}, ${gn}`, 't', ta, tb, da, db, 'tee']);
  cases.push(['tee one-way branch', 't', G, G1, false, false, 'tee'], ['tee one-way elevated branch into ground', 't', G, E1, false, true, 'tee']);
  for (const form of ['semi', 'clover', 'turbine'] as JctForm[]) cases.push([`${form} mixed`, 'x', G, E, false, false, form]);
  for (const [name, kind, ta, tb, da, db, form] of cases)
    it(name, { timeout: 60000 }, () => {
      const { w } = build(kind, ta, tb, da, db, form);
      const g = w.g, n = g.n, N = n * n;
      const chains = findJctChains(g, 0);
      const anchors = new Set<number>();
      for (const C of chains) for (const M of [C.main0, C.main1]) if (M) anchors.add(M.node);
      // 1) 高速道路のマスで、つながりが1本だけ（行き止まり）のものは、ランプへ分かれる・ランプから始まる端だけ（マップの端は除く）
      for (let v = 0; v < 2 * N; v++) {
        const t = g.nodeType(v), c = v % N, x = c % n, y = (c / n) | 0;
        if (!RD[t]?.highway || Math.abs(x - C) > 20 || Math.abs(y - C) > 20) continue; // 引いた道路の両端（交差点から 30 マス）は除く
        const m = v >= N ? g.conn1[c] : g.conn[c];
        let hwArms = 0;
        for (let d = 0; d < 8; d++) {
          if (!(m & (1 << d)) || !g.inb(x + DXc[d], y + DYc[d])) continue;
          const j = (y + DYc[d]) * n + x + DXc[d], L = g.arriveLevel(v >= N ? 1 : 0, j, d);
          if (RD[g.nodeType(L * N + j)]?.highway) hwArms++;
        }
        if (popc(m) >= 1 && hwArms <= 1) expect(anchors.has(v), `dead-end highway stub at ${x},${y} (level ${v >= N ? 1 : 0})`).toBe(true);
      }
      // 2) ランプの曲線の、本線の側の端は、本線の車線の上（中心から 0〜3m ランプの側）にある
      for (const C of chains)
        for (const [M, s] of [[C.main0, C.bound[0]], [C.main1, C.bound[C.bound.length - 1]]] as const) {
          if (!M) continue;
          const q = jAt(C, s);
          const rx = q.x - M.x, rz = q.z - M.z;
          const o = -rx * M.uz + rz * M.ux, along = Math.abs(rx * M.ux + rz * M.uz);
          expect(o, 'ramp end lies on the right lane of its carriageway').toBeGreaterThan(0.5);
          expect(o).toBeLessThan(3.2);
          expect(along).toBeGreaterThan(CELL * 0.45); // マスの境（入口・出口）
        }
      // 3) T字（両方向）：合わさる側の本線は、端の1マスで、右へ分かれるランプと左から合わさるランプに分かれる
      if (kind === 't' && tb !== G1 && tb !== E1) {
        const ends = [...anchors].filter((v) => {
          const c = v % N, m = v >= N ? g.conn1[c] : g.conn[c];
          return chains.filter((C) => C.main0?.node === v || C.main1?.node === v).length === 2 && popc(m) === 3;
        });
        const info = [...anchors].map((v) => { const c = v % N, m = v >= N ? g.conn1[c] : g.conn[c]; return `${c % n},${(c / n) | 0}/L${v >= N ? 1 : 0}: conn=${m.toString(2)} chains=${chains.filter((C) => C.main0?.node === v || C.main1?.node === v).length}`; });
        expect(ends.length, 'one Y-split cell at the end of the branch: ' + info.join(' | ')).toBeGreaterThanOrEqual(1);
      }
    });
});

// ---- Y字の分かれ目：本線が2本のランプに分かれる・2本から始まるところで、2本のランプの路面が重ならない ----
describe('junction Y-splits do not stack decks', () => {
  const cases: [string, number, number, boolean, boolean][] = [];
  for (const [ln, ta, tb] of LEVELS) for (const [gn, da, db] of GEOMS) cases.push([`tee ${ln}, ${gn}`, ta, tb, da, db]);
  for (const [name, ta, tb, da, db] of cases)
    it(name, { timeout: 60000 }, () => {
      const { w } = build('t', ta, tb, da, db, 'tee');
      const g = w.g;
      const chains = findJctChains(g, 0);
      const ends = new Map<number, { C: (typeof chains)[number]; start: boolean }[]>();
      for (const C of chains) {
        if (C.dead0 && C.main0) (ends.get(C.main0.node) ?? ends.set(C.main0.node, []).get(C.main0.node)!).push({ C, start: true });
        if (C.dead1 && C.main1) (ends.get(C.main1.node) ?? ends.set(C.main1.node, []).get(C.main1.node)!).push({ C, start: false });
      }
      let pairs = 0;
      for (const list of ends.values()) {
        if (list.length !== 2) continue;
        pairs++;
        const [a, b] = list;
        const sOf = (e: (typeof list)[number], k: number) => (e.start ? e.C.bound[0] + k : e.C.bound[e.C.bound.length - 1] - k);
        let worst = Infinity;
        for (let k = 0; k <= 40; k += 1) {
          const sa = sOf(a, k), sb = sOf(b, k);
          const p = jAt(a.C, sa), q = jAt(b.C, sb);
          // 曲線に直交する向きの、2本の中心の間の距離（路面の縁どうしのすきま）
          const d = Math.abs((q.x - p.x) * -p.tz + (q.z - p.z) * p.tx);
          worst = Math.min(worst, d - jHalf(a.C, sa) - jHalf(b.C, sb));
        }
        expect(worst, 'two ramp decks overlap at the Y-split').toBeGreaterThan(-0.6);
        // 分かれ目の端では、2本合わせて本線の幅（すきまなし）
        const p0 = jAt(a.C, sOf(a, 0)), q0 = jAt(b.C, sOf(b, 0));
        const span = Math.hypot(p0.x - q0.x, p0.z - q0.z) + jHalf(a.C, sOf(a, 0)) + jHalf(b.C, sOf(b, 0));
        const half = (a.start ? a.C.main0 : a.C.main1)!.half;
        expect(Math.abs(span - 2 * half), 'ramps together span the branch deck at the split').toBeLessThan(0.8);
      }
      if (ta !== G1 && tb !== G1) expect(pairs).toBeGreaterThanOrEqual(1);
    });
});

// ---- 描いたランプの縁（路面の縁と欄干）がなめらかに続くか：急な折れ、段、となりの曲線とのずれがない ----
describe('junction ramp edges are smooth and continuous', () => {
  const cases: [string, 'x' | 't', number, number, boolean, boolean, JctForm][] = [];
  for (const [ln, ta, tb] of LEVELS) for (const [gn, da, db] of GEOMS) cases.push([`tee ${ln}, ${gn}`, 't', ta, tb, da, db, 'tee']);
  for (const form of ['semi', 'clover', 'turbine'] as JctForm[]) cases.push([`${form} mixed axis`, 'x', G, E, false, false, form], [`${form} ground diagonal`, 'x', G, G, false, true, form]);
  for (const [name, kind, ta, tb, da, db, form] of cases)
    it(name, { timeout: 60000 }, () => {
      const { w } = build(kind, ta, tb, da, db, form);
      const chains = findJctChains(w.g, 0);
      const ang = (ax: number, az: number, bx: number, bz: number) => Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz)) * (180 / Math.PI);
      const ends: { x: number; z: number; tx: number; tz: number; w: number }[] = [];
      for (const C of chains) {
        if (C.draw1 - C.draw0 < 2) continue;
        // 縁の点（1m ごと）
        const L: [number, number][] = [], R: [number, number][] = [];
        for (let s = C.draw0; s <= C.draw1 + 1e-6; s += 1) {
          const q = jAt(C, Math.min(s, C.draw1)), hw = jHalf(C, Math.min(s, C.draw1));
          L.push([q.x + q.tz * hw, q.z - q.tx * hw]);
          R.push([q.x - q.tz * hw, q.z + q.tx * hw]);
        }
        for (const P of [L, R])
          for (let k = 1; k + 1 < P.length; k++) {
            const a = ang(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1], P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
            expect(a, `edge turns ${a.toFixed(1)}° within 1 m (chain of ${C.nodes.length} nodes, at ${k}/${P.length} m, ${P === L ? 'left' : 'right'} edge, dead ${C.dead0}/${C.dead1}, main ${!!C.main0}/${!!C.main1}, w ${jHalf(C, C.draw0 + k).toFixed(2)})`).toBeLessThan(7);
          }
        for (const s of [C.draw0, C.draw1]) { const q = jAt(C, s); ends.push({ x: q.x, z: q.z, tx: q.tx, tz: q.tz, w: jHalf(C, s) }); }
        // Y字の分かれ目：外側の縁は本線の縁に重なり、向きは本線と同じ
        for (const [M, s, dead] of [[C.main0, C.bound[0], C.dead0], [C.main1, C.bound[C.bound.length - 1], C.dead1]] as const) {
          if (!M || !dead) continue;
          const q = jAt(C, s);
          expect(ang(q.tx, q.tz, M.ux, M.uz) % 180, 'ramp leaves the branch tangentially').toBeLessThan(3);
          const o = Math.abs(-(q.x - M.x) * M.uz + (q.z - M.z) * M.ux) + jHalf(C, s);
          expect(Math.abs(o - M.half), 'outer edge continues the branch edge').toBeLessThan(0.4);
        }
      }
      // となりの曲線どうし（分かれ目・合わさり目のマスで、幹と枝）の端がそろう：同じ点で終わる・始まるなら、向きと幅が同じ
      for (let i = 0; i < ends.length; i++)
        for (let j = i + 1; j < ends.length; j++) {
          const a = ends[i], b = ends[j];
          if (Math.hypot(a.x - b.x, a.z - b.z) > 0.3) continue;
          expect(ang(a.tx, a.tz, b.tx, b.tz) % 180, 'heading matches where curves meet').toBeLessThan(4);
          expect(Math.abs(a.w - b.w), 'width matches where curves meet').toBeLessThan(0.15);
        }
    });
});
