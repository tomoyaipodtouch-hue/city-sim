// 空港のターミナル前の道路（フォアコート）：本物の道路のマス（街の都市高速と同じ作り）で、正門の道路の階のまま続く。
// 計画（全部の向き・大きさ・階）、正門の階、曲がりのなめらかさ、取り壊し、以前の保存データ、車の流れ（画面なしの車の層）
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { DX, DY } from '../src/sim/constants';
import { AIRPORT_SPECS, airportLayout, airportPorts, footprintAt, makeFrame, placeCentre, type AirportSize } from '../src/sim/airport';
import { forecourtPlan } from '../src/sim/forecourt';
import { findJctChains } from '../src/render/jctCurve';
import { CarLayer } from '../src/render/carLayer';

// 画面のない環境：canvas は何もしないものにする（CarLayer の光の模様に使う）
const sink: any = new Proxy(function () {}, {
  get: (_t, k) => (k === 'width' || k === 'height' ? 32 : k === Symbol.toPrimitive ? () => 0 : k === 'toString' || k === 'valueOf' ? () => '' : sink),
  apply: () => sink,
  set: () => true,
});
(globalThis as any).document ??= { createElement: () => sink };

const flat = (n = 128) => {
  const w = new World(n), V = n + 1;
  for (let i = 0; i < V * V; i++) w.g.heights[i] = 8;
  w.sandbox = true; w.funds = 1e10;
  return w;
};
const ID = { 1: 'airport_1', 2: 'airport_2', 3: 'airport_3' } as const;
function place(size: AirportSize, rot: number, road?: RoadType) {
  const w = flat();
  const r = w.exec({ t: 'plop', id: ID[size], x: 64, y: 64, rot });
  if (!r.ok) throw new Error(r.msg);
  const b = [...w.buildings.values()].find((q) => q.type === ID[size])!;
  const gc = w.airportAccess(b)!.ports.gate!;
  if (road !== undefined) {
    const rr = w.exec({ t: 'road', x0: gc.x + DX[gc.d] * 12, y0: gc.y + DY[gc.d] * 12, x1: gc.x, y1: gc.y, road });
    if (!rr.ok) throw new Error(rr.msg);
  }
  return { w, b, gc };
}
// 道路だけで行けるか
function reach(w: World, from: number, to: number) {
  const seen = new Set([from]), q = [from];
  while (q.length) {
    const u = q.pop()!;
    if (u === to) return true;
    w.g.forEachOut(u, (v) => { if (!seen.has(v)) { seen.add(v); q.push(v); } });
  }
  return false;
}

describe('airport forecourt plan', () => {
  it('plans valid road cells for every size, orientation and gate level', () => {
    const n = 128;
    for (const size of [1, 2, 3] as AirportSize[]) for (let rot = 0; rot < 8; rot++) for (const level of [0, 1] as const) {
      const spec = AIRPORT_SPECS[size], L = airportLayout(size);
      const [cx, cz] = placeCentre(n, spec, rot, 64, 64);
      const fp = footprintAt(n, spec, rot, cx, cz), f = makeFrame(spec, rot, cx, cz), lot = new Set(fp.cells);
      const P = airportPorts(n, f, L, fp.cells, (i) => lot.has(i));
      const plan = forecourtPlan(n, f, L, fp.cells, (i) => lot.has(i), P.gate!, level);
      expect(plan.ok, `size ${size} rot ${rot} level ${level}: ${plan.reason}`).toBe(true);
      // マスの並びは階によらない（敷地の建物の印から除くマスが決まる）
      const other = forecourtPlan(n, f, L, fp.cells, (i) => lot.has(i), P.gate!, (1 - level) as 0 | 1);
      expect([...other.cells].sort()).toEqual([...plan.cells].sort());
    }
  });
});

describe('airport forecourt in the world', () => {
  for (const size of [1, 2, 3] as AirportSize[]) {
    it(`size ${size}: the gate road continues at its own level into the forecourt (elevated and ground)`, () => {
      for (let rot = 0; rot < 8; rot++) {
        for (const t of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway, RoadType.Road]) {
          const { w, b, gc } = place(size, rot, t);
          const g = w.g, N = g.n * g.n;
          expect(b.airFc, `rot ${rot} t ${t}`).toBe(true);
          expect(b.airLevel).toBe(t === RoadType.UrbanHighway ? 1 : 0);
          const P = w.fcPlanOf(b, b.airLevel!)!;
          const lv = t === RoadType.UrbanHighway ? 1 : 0;
          // 正門から車寄せの列まで、同じ階のまま（高架なら地上のマスを通らない）
          for (const name of ['IN', 'Fm', 'RET', 'Rm', 'U']) {
            const p = P.paths.find((q) => q.name === name)!;
            expect(p.lv.every((v) => v === lv), `rot ${rot} ${name}`).toBe(true);
          }
          const IN = P.paths.find((q) => q.name === 'IN' || q.name === 'STEM')!;
          expect(IN.cells[0]).toBe(gc.cell);
          // 都市高速・道路の遠くから、両方の階の車寄せへ、U ターンして戻る
          const far = (t === RoadType.UrbanHighway ? N : 0) + g.idx(gc.x + DX[gc.d] * 12, gc.y + DY[gc.d] * 12);
          const A = w.airportAccess(b)!;
          for (const curb of [A.curb.find((v) => v >= N)!, A.curb.find((v) => v < N)!]) {
            expect(curb !== undefined && reach(w, far, curb), `rot ${rot} t ${t} in`).toBe(true);
            expect(reach(w, curb, far), `rot ${rot} t ${t} out`).toBe(true);
          }
          // 車寄せのマスは、ターミナルの側の欄干を付けない印
          expect(A.curb.every((v) => g.aport[v % N] & (v >= N ? 4 : 2))).toBe(true);
        }
      }
    });
  }

  it('curves are smooth: no more than 7°/m anywhere, no tight loops', () => {
    for (const size of [1, 2, 3] as AirportSize[]) for (const rot of [0, 1, 2, 3]) for (const t of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway]) {
      const { w } = place(size, rot, t);
      const g = w.g, N = g.n * g.n;
      const chains = findJctChains(g, 0.3).filter((C) => C.nodes.some((v) => g.aport[v % N]));
      expect(chains.length).toBeGreaterThanOrEqual(5);
      let worst = 0, minR = Infinity;
      for (const C of chains) {
        const m = C.x.length;
        for (let k = 2; k + 2 < m; k++) {
          const a0 = Math.atan2(C.z[k] - C.z[k - 2], C.x[k] - C.x[k - 2]), a1 = Math.atan2(C.z[k + 2] - C.z[k], C.x[k + 2] - C.x[k]);
          let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d;
          worst = Math.max(worst, (d * 180) / Math.PI / Math.max(0.5, (C.s[k + 2] - C.s[k - 2]) / 2));
        }
        for (let k = 4; k + 4 < m; k++) {
          const a0 = Math.atan2(C.z[k] - C.z[k - 4], C.x[k] - C.x[k - 4]), a1 = Math.atan2(C.z[k + 4] - C.z[k], C.x[k + 4] - C.x[k]);
          let d = Math.abs(a1 - a0); if (d > Math.PI) d = 2 * Math.PI - d;
          if (d > 1e-3) minR = Math.min(minR, (C.s[k + 4] - C.s[k - 4]) / 2 / d);
        }
      }
      expect(worst, `size ${size} rot ${rot}`).toBeLessThanOrEqual(7);
      expect(minR, `size ${size} rot ${rot}`).toBeGreaterThan(12);
    }
  });

  it('forecourt roads belong to the airport: they cannot be bulldozed or drawn over, and go with the airport', () => {
    const { w, b, gc } = place(1, 2, RoadType.UrbanHighway);
    const g = w.g;
    const cells = w.fcPlanOf(b, b.airLevel!)!.cells;
    const i = cells[Math.floor(cells.length / 2)], x = i % g.n, y = (i / g.n) | 0;
    const r = w.exec({ t: 'bulldoze', x0: x, y0: y, x1: x, y1: y, layer: 'all' });
    expect(r.ok).toBe(false);
    expect(g.road[i] || g.up[i]).toBeTruthy();
    // 道路を引くこともできない
    expect(w.exec({ t: 'road', x0: x, y0: y - 3, x1: x, y1: y + 3, road: RoadType.Road }).ok).toBe(false);
    // 空港を取り壊すと、道路も消える（正門の外の道路は残る）
    const lot = w.lotCells(b)!;
    const [tx, ty] = [lot[0] % g.n, (lot[0] / g.n) | 0];
    expect(w.exec({ t: 'bulldoze', x0: tx, y0: ty, x1: tx, y1: ty, layer: 'all' }).ok).toBe(true);
    expect(w.buildings.size).toBe(0);
    expect(cells.every((c) => !g.road[c] && !g.up[c] && !g.aport[c])).toBe(true);
    expect(g.up[gc.cell]).toBe(RoadType.UrbanHighway);
  });

  it('switching the gate road from ground to elevated rebuilds the forecourt at the new level', () => {
    const { w, b, gc } = place(2, 2);
    expect(b.airLevel).toBe(0);
    expect(w.airportAccess(b)!.main).toBe(null); // 正門の目印の道路だけ：つながっていない
    const r = w.exec({ t: 'road', x0: gc.x + DX[gc.d] * 12, y0: gc.y + DY[gc.d] * 12, x1: gc.x, y1: gc.y, road: RoadType.UrbanHighway });
    expect(r.ok, r.msg).toBe(true);
    expect(b.airLevel).toBe(1);
    expect(w.g.road[gc.cell]).toBe(0); // 地上の目印は外した
    expect(w.airportAccess(b)!.main?.kind).toBe('hw');
  });

  it('legacy saves get the forecourt: version 2 with a highway at the gate, and an old airport reconnected by the radius-6 search', () => {
    // 版 2：正門まで都市高速が引いてあり、敷地のマスは全部建物の印
    {
      const { w, b } = place(1, 3, RoadType.UrbanHighway);
      const save = w.serialize();
      const g = w.g;
      const fc = new Set(w.fcPlanOf(b, 1)!.cells);
      const sb = save.buildings.find((q) => q.id === b.id)! as any;
      sb.airGate = 2; delete sb.airFc; delete sb.airLevel; delete sb.airH;
      for (const k of ['road', 'up', 'conn', 'conn1', 'flow', 'flow1', 'jct', 'aport'] as const) {
        const arr = (save as any)[k] as Uint8Array;
        for (const i of fc) arr[i] = 0;
      }
      for (const i of w.lotCells(b)!) (save as any).bldg[i] = b.id;
      // 門のマスから敷地へのつながりも外す
      const G = w.airportAccess(b)!.ports.gate!.cell;
      (save as any).conn1[G] &= ~0; void g;
      const w2 = World.load(save);
      const b2 = w2.buildings.get(b.id)!;
      expect(b2.airGate).toBe(3);
      expect(b2.airFc).toBe(true);
      expect(b2.airLevel).toBe(1);
      const A = w2.airportAccess(b2)!;
      expect(A.main?.kind).toBe('hw');
      const N = w2.g.n * w2.g.n, gc = A.ports.gate!;
      const far = N + w2.g.idx(gc.x + DX[gc.d] * 12, gc.y + DY[gc.d] * 12);
      expect(reach(w2, far, A.curb.find((v) => v >= N)!)).toBe(true);
      expect(reach(w2, far, A.curb.find((v) => v < N)!)).toBe(true);
    }
    // 版なし：正門の近くを通る都市高速を、正門まで延ばしてつなぐ
    {
      const { w, b } = place(2, 1);
      const gc = w.airportAccess(b)!.ports.gate!;
      const px = gc.x + DX[gc.d] * 3, py = gc.y + DY[gc.d] * 3, sd = (gc.d + 2) & 7;
      expect(w.exec({ t: 'road', x0: px - DX[sd] * 8, y0: py - DY[sd] * 8, x1: px + DX[sd] * 8, y1: py + DY[sd] * 8, road: RoadType.UrbanHighway }).ok).toBe(true);
      const save = w.serialize();
      const fc = new Set(w.fcPlanOf(b, 0)!.cells);
      for (const q of save.buildings) { const a = q as any; delete a.airGate; delete a.airFc; delete a.airLevel; delete a.airH; }
      for (const k of ['road', 'up', 'conn', 'conn1', 'flow', 'flow1', 'jct', 'aport'] as const) { const arr = (save as any)[k] as Uint8Array; for (const i of fc) arr[i] = 0; arr[gc.cell] = 0; }
      for (const i of w.lotCells(b)!) (save as any).bldg[i] = b.id;
      const w2 = World.load(save);
      const b2 = w2.buildings.get(b.id)!;
      expect(b2.airFc).toBe(true);
      expect(w2.airportAccess(b2)!.main?.kind).toBe('hw');
      expect(b2.airLevel).toBe(1);
    }
  });
});

describe('city cars drive the forecourt (headless car layer)', () => {
  for (const [size, rot, t] of [[1, 2, RoadType.UrbanHighway], [2, 1, RoadType.UrbanGroundHighway], [3, 2, RoadType.UrbanHighway]] as [AirportSize, number, RoadType][])
    it(`size ${size} rot ${rot}: cars enter, stop at the curbs, U-turn and leave; nobody gets stuck`, { timeout: 120000 }, () => {
      const { w, gc } = place(size, rot, t);
      const g = w.g, N = g.n * g.n;
      // 都市高速を空港へ向かう交通（混んだ街）。フォアコートの道路も交通量あり
      const tr = new Float32Array(2 * N);
      for (let v = 0; v < 2 * N; v++) { const ty = g.nodeType(v); if (ty) tr[v] = g.aport[v % N] ? 1500 : 2500; }
      const L = new CarLayer();
      L.setData(g, tr, new Float32Array(2 * N).fill(1), new Float32Array(2 * N));
      // U ターンの先（戻りの列）を走った車がいたか
      const Rcells = new Set<number>();
      const seenR = new Set<object>(), seenF = new Set<object>();
      for (let k = 0; k < 4000; k++) {
        L.update(1 / 20);
        if (k % 10) continue;
        for (const f of (L as any).cars) for (const c of f.cars) {
          const cell = c.from % N;
          if (!g.aport[cell]) continue;
          if (g.aport[cell] & 6) seenF.add(c);
          else if (seenF.has(c)) { Rcells.add(cell); seenR.add(c); }
        }
      }
      expect(L.curbStops).toBeGreaterThan(5);
      expect(seenR.size).toBeGreaterThan(5);
      const at = (L as any).dropAt.map((v: number) => `${v % N % g.n},${((v % N) / g.n) | 0}${v >= N ? '^' : ''}${g.aport[v % N] ? 'A' : ''}`);
      expect(L.drops, at.join(' ') + ' gate ' + gc.x + ',' + gc.y).toBe(0);
    });
});
