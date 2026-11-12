// 空港（大）：置き方（8 方向、海の上、2km マップ）、配置、運航（2 時間・12 機まで・とどこおらない・翼の間隔・停止位置・2 本の滑走路）
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { AIRPORT_SPECS, airportCells, airportLayout, footprintAt, frameOf, makeFrame, placeCentre, planAirport, standDir, standPt, type StandDef } from '../src/sim/airport';
import { CELL } from '../src/sim/constants';
import { AirOps } from '../src/render/airport/ops';
import { AC } from '../src/render/airport/aircraft';

const SPEC = AIRPORT_SPECS[3];
type Cmd = Parameters<World['exec']>[0];
const flat = (n = 128, h = 8, seaFrom = Infinity) => {
  const w = new World(n), V = n + 1;
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= seaFrom ? -6 : h;
  w.sandbox = true;
  w.funds = 1e10;
  return w;
};
const ok = (w: World, c: Cmd) => {
  const r = w.exec(c);
  if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.msg}`);
  return r;
};
// 敷地の陸側（-a の端）の外に、一般道を少し引く
function roadBeside(w: World, rot: number, tx: number, ty: number) {
  const n = w.g.n;
  const [cx, cz] = placeCentre(n, SPEC, rot, tx, ty);
  const lot = new Set(footprintAt(n, SPEC, rot, cx, cz).cells);
  const f = makeFrame(SPEC, rot, cx, cz);
  let x = Math.floor((f.cx - f.cos * (f.A / 2 + 8)) / CELL), y = Math.floor((f.cz - f.sin * (f.A / 2 + 8)) / CELL);
  while (lot.has(y * n + x)) { x += Math.round(-f.cos); y += Math.round(-f.sin); }
  const dx = Math.round(-f.cos * 1.4), dy = Math.round(-f.sin * 1.4);
  ok(w, { t: 'road', x0: x, y0: y, x1: x + dx * 2, y1: y + dy * 2, road: RoadType.Road });
}

describe('large airport placement', () => {
  it('fits all 8 orientations on a 2 km map', () => {
    for (let rot = 0; rot < 8; rot++) {
      const w = flat();
      roadBeside(w, rot, 64, 64);
      const p = planAirport(w.g, 3, 64, 64, rot);
      expect(p.reason, `rot ${rot}`).toBe('');
      if (rot % 2 === 0) {
        expect(p.cells.length).toBe(40 * 100);
        expect([p.w, p.h].sort((a, b) => a - b)).toEqual([40, 100]);
      } else expect(p.cells.length).toBeGreaterThan(40 * 100);
      expect(p.cost).toBeGreaterThanOrEqual(SPEC.cost);
      ok(w, { t: 'plop', id: 'airport_3', x: 64, y: 64, rot });
      const b = [...w.buildings.values()].find((q) => q.type === 'airport_3')!;
      const cells = new Set(airportCells(w.g.n, b, SPEC));
      let marked = 0;
      for (let i = 0; i < w.g.bldg.length; i++) if (w.g.bldg[i] === b.id) { marked++; expect(cells.has(i)).toBe(true); }
      expect(marked).toBe(cells.size);
      expect(frameOf(b, SPEC).cx).toBeCloseTo(p.cx, 5);
    }
  });

  it('reclaims the sea, axis and diagonal', () => {
    for (const [rot, tx] of [[0, 70], [3, 72]] as const) {
      const w = flat(128, 8, 80);
      roadBeside(w, rot, tx, 64);
      const p = planAirport(w.g, 3, tx, 64, rot);
      expect(p.reason, `rot ${rot}`).toBe('');
      expect(p.fill.length).toBeGreaterThan(200);
      expect(p.quay.length).toBeGreaterThan(20);
      ok(w, { t: 'plop', id: 'airport_3', x: tx, y: 64, rot });
      for (const i of p.cells) expect(w.g.isWater(i % 128, (i / 128) | 0)).toBe(false);
    }
  });

  it('layout: two parallel 1,400 m runways, 20+ jet bridges with wide-body stands, remote and cargo stands', () => {
    const L = airportLayout(3);
    expect(L.runways.length).toBe(2);
    const [N, S] = L.runways;
    for (const r of L.runways) expect(r.a1 - r.a0).toBe(1400);
    expect(Math.abs(S.c - N.c)).toBeGreaterThan(500);
    expect(N.exits.filter((e) => e.rapid).length).toBeGreaterThanOrEqual(2);
    expect(L.parallel).toBe(true);
    const br = L.stands.filter((s) => s.bridge);
    expect(br.length).toBeGreaterThanOrEqual(20);
    expect(br.filter((s) => s.wide).length).toBeGreaterThanOrEqual(4);
    expect(L.stands.filter((s) => !s.bridge && !s.cargo).length).toBeGreaterThanOrEqual(4);
    expect(L.stands.filter((s) => s.cargo).length).toBeGreaterThanOrEqual(2);
    expect(L.wideTypes).toEqual(expect.arrayContaining(['b777', 'a350']));
    // ターミナルの区画は 2 本の滑走路のあいだ（どの飛行機も滑走路を横切らない）
    for (const st of L.stands) {
      const [a, c] = standPt(st, 0, 0);
      expect(c).toBeGreaterThan(N.c + 60);
      expect(c).toBeLessThan(S.c - 60);
      expect(Math.abs(a)).toBeLessThan(L.A / 2);
    }
    for (const k of ['concourse', 'tower', 'hangar', 'cargo', 'fuel', 'fire', 'carpark', 'hotel', 'office', 'plaza', 'station', 'terminal'] as const) expect(L.buildings.some((b) => b.kind === k), k).toBe(true);
    expect(L.buildings.filter((b) => b.kind === 'fire').length).toBe(2);
    expect(L.buildings.filter((b) => b.kind === 'hangar').length).toBeGreaterThanOrEqual(2);
    expect(SPEC.maxAircraft).toBe(12);
    expect(SPEC.cost).toBe(1000000);
  });
});

// 飛行機の地面の上の形（翼幅 × 全長の向きのある長方形）。重なっているか（分離軸）
type Box = { a: number; c: number; ua: number; uc: number; hl: number; hw: number };
const boxOf = (ac: { a: number; c: number; ha: number; hc: number; type: keyof typeof AC }, margin = 0.5): Box =>
  ({ a: ac.a, c: ac.c, ua: ac.ha, uc: ac.hc, hl: AC[ac.type].len / 2 - margin, hw: AC[ac.type].span / 2 - margin });
function overlap(p: Box, q: Box) {
  const axes = [[p.ua, p.uc], [-p.uc, p.ua], [q.ua, q.uc], [-q.uc, q.ua]];
  for (const [x, y] of axes) {
    const proj = (b: Box) => Math.abs(b.ua * x + b.uc * y) * b.hl + Math.abs(-b.uc * x + b.ua * y) * b.hw;
    const d = Math.abs((q.a - p.a) * x + (q.c - p.c) * y);
    if (d > proj(p) + proj(q)) return false;
  }
  return true;
}
const corners = (b: Box) => [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([i, j]) => [b.a + b.ua * b.hl * i - b.uc * b.hw * j, b.c + b.uc * b.hl * i + b.ua * b.hw * j]);
const parked = (st: StandDef, type: keyof typeof AC) => {
  const [a, c] = standPt(st, AC[type].len / 2, 0), [ua, uc] = standDir(st);
  return { a, c, ha: ua, hc: uc, type };
};

describe('large airport operations', () => {
  it('runs 2 sim-hours: ≤12 aircraft, no stalls, no overlap, no stop after the exit, holds behind the line, both runways', () => {
    const L = airportLayout(3), [N, S] = L.runways;
    const ops = new AirOps(L, { pos: 3000, neg: 3000 }, 31);
    ops.open = true;
    ops.flights = 140;
    ops.cargoFlights = 16;
    ops.seed();
    const since = new Map<object, { phase: string; t: number; a: number; c: number }>();
    const st = { landN: 0, landS: 0, offN: 0, offS: 0, maxN: 0, holds: 0, arrivals: 0, docked: 0, wide: 0, rapid: 0, simul: 0 };
    let worstOverlap = '';
    const door = new Float32Array(3);
    for (let t = 0; t < 7200; t += 0.2) {
      ops.update(0.2, 0.5);
      st.maxN = Math.max(st.maxN, ops.aircraft.length);
      const g = ops.aircraft.filter((a) => a.y < 0.5 && a.phase !== 'approach' && a.phase !== 'takeoff' && a.phase !== 'gone');
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        if (overlap(boxOf(g[i]), boxOf(g[j]))) worstOverlap ||= `${t.toFixed(1)}: ${g[i].type} ${g[i].phase} @${g[i].a.toFixed(0)},${g[i].c.toFixed(0)} / ${g[j].type} ${g[j].phase} @${g[j].a.toFixed(0)},${g[j].c.toFixed(0)}`;
      }
      // 着陸と出発が同時に（別の滑走路で）
      if (ops.aircraft.some((a) => a.phase === 'rollout') && ops.aircraft.some((a) => a.phase === 'takeoff' && a.y < 1)) st.simul++;
      for (const ac of ops.aircraft) {
        const p = since.get(ac);
        if (ac.phase === 'holdIn' || ac.phase === 'exit') throw new Error(`arrival stopped after the exit (${ac.phase})`);
        if (!p || p.phase !== ac.phase) {
          const onN = Math.abs(ac.c - N.c) < 30, onS = Math.abs(ac.c - S.c) < 30;
          if (ac.phase === 'rollout') { if (onN) st.landN++; if (onS) st.landS++; if (AC[ac.type].wide) st.wide++; }
          if (ac.phase === 'takeoff') { if (onN) st.offN++; if (onS) st.offS++; }
          if (ac.phase === 'taxiIn') { st.arrivals++; if (N.exits[ac.exit]?.rapid) st.rapid++; }
          since.set(ac, { phase: ac.phase, t, a: ac.a, c: ac.c });
        } else {
          if (ac.phase === 'taxiIn') {
            const left = ac.move!.T - ac.t;
            if (Math.hypot(ac.a - p.a, ac.c - p.c) < 1e-3 && left > 4) throw new Error(`arrival stopped while taxiing in at ${t.toFixed(1)}`);
          }
          if (ac.phase !== 'park') {
            const lim = ac.phase === 'ready' ? 900 : 240;
            expect(t - p.t, `${ac.phase} stuck`).toBeLessThan(lim);
          }
          p.a = ac.a; p.c = ac.c;
        }
        // 出発機が待つ・走るあいだ：機体の全体が、出発の滑走路の停止位置の標示より誘導路の側
        const nearLink = Math.min(...S.links.map((la) => Math.abs(ac.a - la))) < AC[ac.type].len + 40;
        if (ac.phase === 'holdOut' || (ac.phase === 'taxiOut' && nearLink) || (ac.phase === 'lineup' && p?.phase !== 'lineup')) {
          st.holds++;
          for (const [, c] of corners(boxOf(ac, 0))) expect(c, `${ac.phase} ${ac.type}`).toBeLessThanOrEqual(S.holdC);
        }
        if (ac.phase === 'park' && L.stands[ac.stand].bridge && ops.bridge[ac.stand] >= 1) {
          ops.bridgeDoor(ac.stand, door);
          const sd = L.stands[ac.stand], d = AC[ac.type], want = standPt(sd, d.door[0], d.R);
          expect(Math.hypot(door[0] - want[0], door[1] - want[1])).toBeLessThan(0.6);
          st.docked++;
        }
      }
    }
    console.log(st);
    expect(worstOverlap).toBe('');
    expect(st.maxN).toBeLessThanOrEqual(12);
    expect(st.maxN).toBeGreaterThanOrEqual(8);
    expect(st.landN).toBeGreaterThan(30);
    expect(st.offS).toBeGreaterThan(30);
    expect(st.landS + st.offN).toBe(0);
    expect(st.simul).toBeGreaterThan(0);
    expect(st.rapid).toBeGreaterThan(5);
    expect(st.wide).toBeGreaterThan(0);
    expect(st.holds).toBeGreaterThan(0);
    expect(st.docked).toBeGreaterThan(1000);
  });

  it('parked aircraft of the allowed types keep 4.5 m wingtip clearance at neighbouring stands', () => {
    const L = airportLayout(3);
    const typesOf = (st: StandDef) => (st.cargo ? L.cargoTypes.filter((t) => st.wide || !AC[t].wide) : st.wide ? [...L.types, ...L.wideTypes] : L.types);
    for (let i = 0; i < L.stands.length; i++) for (let j = i + 1; j < L.stands.length; j++) {
      const A = L.stands[i], B = L.stands[j];
      for (const ta of typesOf(A)) for (const tb of typesOf(B)) expect(overlap(boxOf(parked(A, ta), -2.25), boxOf(parked(B, tb), -2.25)), `stands ${i}/${j} ${ta}/${tb}`).toBe(false);
    }
  });
});
