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
      // ターミナル前の道路のマス（空港の道路）には、建物の印をつけない
      let road = 0;
      for (const i of cells) if (w.g.aport[i]) { road++; expect(w.g.bldg[i]).toBe(0); }
      expect(road).toBeGreaterThan(40);
      expect(marked + road).toBe(cells.size);
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
          const lim = ac.phase === 'ready' ? 900 : 240;
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
    expect(st.landings).toBeGreaterThan(15);
    expect(st.takeoffs).toBeGreaterThan(15);
    expect(st.rapid).toBeGreaterThan(5);
    expect(st.wide).toBeGreaterThan(0);
    expect(st.docked).toBeGreaterThan(1000);
    expect(st.flips).toBeGreaterThan(1);
    expect(dockOk).toBe(true);
  });

});

// 飛行機の地面の上の形（翼幅 × 全長の向きのある長方形、margin だけ小さく）。重なっているか（分離軸）
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

describe('aircraft clearances and stops (小 and 中)', () => {
  for (const size of [1, 2] as const) {
    it(`size ${size}: footprints never overlap, arrivals never stop after the exit, departures hold short behind the line`, () => {
      const L = airportLayout(size), r = L.runways[0];
      const ops = new AirOps(L, { pos: 2600, neg: 2600 }, 7 + size);
      ops.open = true;
      ops.flights = 60;
      ops.cargoFlights = 8;
      ops.seed();
      const last = new Map<object, { a: number; c: number; phase: string; still: number }>();
      let holds = 0, arrivals = 0, worstOverlap = '';
      for (let t = 0; t < 7200; t += 0.2) {
        ops.update(0.2, 0.5);
        const g = ops.aircraft.filter((a) => a.y < 0.5 && a.phase !== 'approach' && a.phase !== 'takeoff' && a.phase !== 'gone');
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
          if (overlap(boxOf(g[i]), boxOf(g[j]))) worstOverlap ||= `${t.toFixed(1)}: ${g[i].type} ${g[i].phase} @${g[i].a.toFixed(0)},${g[i].c.toFixed(0)} / ${g[j].type} ${g[j].phase} @${g[j].a.toFixed(0)},${g[j].c.toFixed(0)}`;
        }
        for (const ac of ops.aircraft) {
          const p = last.get(ac);
          // 着陸機：出口を出てからスポットまで、止まらない（スポットに着く手前のゆっくりした止まり方は除く）
          if (ac.phase === 'holdIn' || ac.phase === 'exit') throw new Error(`arrival stopped after the exit (${ac.phase})`);
          if (ac.phase === 'taxiIn') {
            const moved = p ? Math.hypot(ac.a - p.a, ac.c - p.c) : 1;
            const left = ac.move!.T - ac.t;
            if (moved < 1e-3 && left > 4) throw new Error(`arrival stopped while taxiing in at ${t.toFixed(1)}`);
            if (!p || p.phase !== 'taxiIn') arrivals++;
          }
          // 出発機が走る・待つあいだ：機体の全体が、滑走路の手前の停止位置の標示より誘導路の側（滑走路へ入るのは line up から）
          const nearLink = Math.min(...r.links.map((la) => Math.abs(ac.a - la))) < AC[ac.type].len + 40;
          if (ac.phase === 'holdOut' || (ac.phase === 'taxiOut' && nearLink) || (ac.phase === 'lineup' && p?.phase !== 'lineup')) {
            holds++;
            for (const [, c] of corners(boxOf(ac, 0))) expect(c, `${ac.phase} ${ac.type}`).toBeGreaterThanOrEqual(r.holdC);
          }
          last.set(ac, { a: ac.a, c: ac.c, phase: ac.phase, still: 0 });
        }
      }
      expect(worstOverlap).toBe('');
      expect(arrivals).toBeGreaterThan(10);
      expect(holds).toBeGreaterThan(0);
    });
  }

  it('parked aircraft of the allowed types never touch wingtips at neighbouring stands (4.5 m clearance)', () => {
    for (const size of [1, 2] as const) {
      const L = airportLayout(size);
      const typesOf = (st: (typeof L.stands)[number]) => (st.cargo ? L.cargoTypes.filter((t) => st.wide || !AC[t].wide) : st.wide ? [...L.types, ...L.wideTypes] : L.types);
      for (let i = 0; i < L.stands.length; i++) for (let j = i + 1; j < L.stands.length; j++) {
        const A = L.stands[i], B = L.stands[j];
        for (const ta of typesOf(A)) for (const tb of typesOf(B)) {
          const a = { a: A.a, c: A.noseC - AC[ta].len / 2, ha: 0, hc: 1, type: ta }, b = { a: B.a, c: B.noseC - AC[tb].len / 2, ha: 0, hc: 1, type: tb };
          // 翼幅を 4.5m ひろげた形でも重ならない
          expect(overlap(boxOf(a, -2.25), boxOf(b, -2.25)), `size ${size} stands ${i}/${j} ${ta}/${tb}`).toBe(false);
        }
      }
    }
  });
});
