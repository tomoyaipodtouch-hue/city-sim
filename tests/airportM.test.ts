// 空港（中）：置き方（縦横・斜めの 8 方向、海の上、2km マップ）、運航（2 時間・6 機まで・とどこおらない）、搭乗橋
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { AIRPORT_SPECS, airportCells, airportLayout, footprintAt, frameOf, makeFrame, placeCentre, planAirport } from '../src/sim/airport';
import { CELL } from '../src/sim/constants';
import { AirOps } from '../src/render/airport/ops';
import { AC } from '../src/render/airport/aircraft';

const SPEC = AIRPORT_SPECS[2];
type Cmd = Parameters<World['exec']>[0];
const flat = (n = 128, h = 8, seaFrom = Infinity) => {
  const w = new World(n), V = n + 1;
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= seaFrom ? -6 : h;
  w.sandbox = true;
  w.funds = 1e9;
  return w;
};
const ok = (w: World, c: Cmd) => {
  const r = w.exec(c);
  if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.msg}`);
  return r;
};
function roadBeside(w: World, rot: number, tx: number, ty: number) {
  const n = w.g.n;
  const [cx, cz] = placeCentre(n, SPEC, rot, tx, ty);
  const lot = new Set(footprintAt(n, SPEC, rot, cx, cz).cells);
  const f = makeFrame(SPEC, rot, cx, cz);
  let x = Math.floor((f.cx - f.sin * (f.C / 2 + 8)) / CELL), y = Math.floor((f.cz + f.cos * (f.C / 2 + 8)) / CELL);
  while (lot.has(y * n + x)) { x += Math.round(-f.sin); y += Math.round(f.cos); }
  const dx = Math.round(-f.sin * 1.4), dy = Math.round(f.cos * 1.4);
  ok(w, { t: 'road', x0: x, y0: y, x1: x + dx * 2, y1: y + dy * 2, road: RoadType.Road });
}

describe('medium airport placement', () => {
  it('fits all 8 orientations on a 2 km map', () => {
    for (let rot = 0; rot < 8; rot++) {
      const w = flat();
      roadBeside(w, rot, 64, 64);
      const p = planAirport(w.g, 2, 64, 64, rot);
      expect(p.reason, `rot ${rot}`).toBe('');
      if (rot % 2 === 0) {
        expect(p.cells.length).toBe(18 * 85);
        expect([p.w, p.h].sort((a, b) => a - b)).toEqual([18, 85]);
      } else {
        expect(p.cells.length).toBeGreaterThan(18 * 85);
        expect(Math.max(p.w, p.h)).toBeLessThanOrEqual(76);
      }
      expect(p.cost).toBeGreaterThanOrEqual(SPEC.cost);
      ok(w, { t: 'plop', id: 'airport_2', x: 64, y: 64, rot });
      const b = [...w.buildings.values()].find((q) => q.type === 'airport_2')!;
      const cells = new Set(airportCells(w.g.n, b, SPEC));
      let marked = 0;
      for (let i = 0; i < w.g.bldg.length; i++) if (w.g.bldg[i] === b.id) { marked++; expect(cells.has(i)).toBe(true); }
      expect(marked).toBe(cells.size);
      expect(frameOf(b, SPEC).cx).toBeCloseTo(p.cx, 5);
    }
  });

  it('reclaims the sea, axis and diagonal', () => {
    for (const [rot, tx] of [[4, 84], [3, 74]] as const) {
      const w = flat(128, 8, 80);
      roadBeside(w, rot, tx, 64);
      const p = planAirport(w.g, 2, tx, 64, rot);
      expect(p.reason).toBe('');
      expect(p.fill.length).toBeGreaterThan(100);
      expect(p.quay.length).toBeGreaterThan(20);
      ok(w, { t: 'plop', id: 'airport_2', x: tx, y: 64, rot });
      for (const i of p.cells) expect(w.g.isWater(i % 128, (i / 128) | 0)).toBe(false);
    }
  });

  it('layout: 6–10 jet bridges, a full parallel taxiway and rapid exits for both directions', () => {
    const L = airportLayout(2);
    const br = L.stands.filter((s) => s.bridge);
    expect(br.length).toBeGreaterThanOrEqual(6);
    expect(br.length).toBeLessThanOrEqual(10);
    expect(br.some((s) => s.wide)).toBe(true);
    const r = L.runways[0];
    expect(r.a1 - r.a0).toBe(1200);
    for (const dir of [1, -1]) expect(r.exits.some((e) => e.dir === dir && e.rapid)).toBe(true);
    // 平行誘導路は滑走路の両端の取付誘導路をつなぐ
    const tx = L.net.nodes.filter(([, c]) => c === L.taxiC).map(([a]) => a);
    expect(Math.min(...tx)).toBeLessThanOrEqual(r.links[0]);
    expect(Math.max(...tx)).toBeGreaterThanOrEqual(r.links[1]);
    // 斜めでも 2km マップの中
    const fp = footprintAt(128, SPEC, 1, ...placeCentre(128, SPEC, 1, 64, 64));
    expect(fp.out).toBe(false);
  });
});

describe('medium airport operations', () => {
  const run = (sec: number, seed: number) => {
    const L = airportLayout(2);
    const ops = new AirOps(L, { pos: 2600, neg: 2600 }, seed);
    ops.open = true;
    ops.flights = 60;
    ops.cargoFlights = 8;
    ops.seed();
    let flips = 0;
    ops.onDirChange = () => flips++;
    const since = new Map<object, { phase: string; t: number }>();
    const st = { landings: 0, takeoffs: 0, maxN: 0, flips: 0, docked: 0, wide: 0, rapid: 0, maxGround: 0 };
    let dockOk = true;
    const door = new Float32Array(3);
    for (let t = 0; t < sec; t += 0.1) {
      ops.update(0.1, 0.5);
      st.maxN = Math.max(st.maxN, ops.aircraft.length);
      let ground = 0;
      for (const ac of ops.aircraft) {
        const s = since.get(ac);
        if (ac.moving && ac.y === 0 && ac.phase !== 'rollout' && ac.phase !== 'takeoff') ground++;
        if (!s || s.phase !== ac.phase) {
          if (ac.phase === 'rollout') { st.landings++; if (L.runways[0].exits[ac.exit].rapid) st.rapid++; if (AC[ac.type].wide) st.wide++; }
          if (ac.phase === 'takeoff') st.takeoffs++;
          // プッシュバックは搭乗橋が縮んでから
          if (ac.phase === 'push' && L.stands[ac.stand].bridge && ops.bridge[ac.stand] > 0.01) dockOk = false;
          since.set(ac, { phase: ac.phase, t });
        } else if (ac.phase !== 'park') {
          // スポットでの出発待ち・待機の場所は順番待ちで長くなることがある（とどこおってはいない）
          const lim = ac.phase === 'ready' || ac.phase === 'queue' || ac.phase === 'holdIn' ? 600 : 240;
          expect(t - s.t, `${ac.phase} stuck`).toBeLessThan(lim);
        }
        // 駐機中で搭乗橋が扉についている
        if (ac.phase === 'park' && L.stands[ac.stand].bridge && ops.bridge[ac.stand] >= 1) {
          ops.bridgeDoor(ac.stand, door);
          const d = AC[ac.type];
          expect(door[1]).toBeCloseTo(L.stands[ac.stand].noseC - d.door[0], 3);
          expect(Math.abs(door[0] - (L.stands[ac.stand].a + d.R))).toBeLessThan(0.5);
          st.docked++;
        }
      }
      st.maxGround = Math.max(st.maxGround, ground);
    }
    st.flips = flips;
    return { st, dockOk };
  };

  it('runs 2 sim-hours with no stalls, at most 6 aircraft, docking jet bridges', () => {
    const { st, dockOk } = run(7200, 4242);
    console.log(st);
    expect(st.maxN).toBeLessThanOrEqual(6);
    expect(st.maxN).toBeGreaterThanOrEqual(4);
    expect(st.landings).toBeGreaterThan(30);
    expect(st.takeoffs).toBeGreaterThan(30);
    expect(st.rapid).toBeGreaterThan(5);
    expect(st.wide).toBeGreaterThan(0);
    expect(st.docked).toBeGreaterThan(1000);
    expect(st.flips).toBeGreaterThan(1);
    // 地上で同時に動く飛行機が 2 機以上のときがある（予約で順番を守りながら、同時に動ける）
    expect(st.maxGround).toBeGreaterThanOrEqual(2);
    expect(dockOk).toBe(true);
  });

  it('never lets two moving aircraft overlap on the ground', () => {
    const L = airportLayout(2);
    const ops = new AirOps(L, { pos: 2600, neg: 2600 }, 99);
    ops.open = true;
    ops.flights = 60;
    ops.cargoFlights = 8;
    ops.seed();
    let worst = Infinity;
    for (let t = 0; t < 3600; t += 0.2) {
      ops.update(0.2, 0.5);
      const g = ops.aircraft.filter((a) => a.y === 0 && a.phase !== 'approach' && a.phase !== 'takeoff');
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        if (!g[i].moving && !g[j].moving) continue;
        const d = Math.hypot(g[i].a - g[j].a, g[i].c - g[j].c);
        worst = Math.min(worst, d);
      }
    }
    console.log('closest moving pair (m)', worst);
    expect(worst).toBeGreaterThan(20);
  });
});
