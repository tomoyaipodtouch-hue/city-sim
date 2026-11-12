// 空港の門：正門へ都市高速・大通りを引いて終わらせるとつながり、車が 都市高速 → 正門 → ループ（2 層の U ターン）→ 車寄せ → 正門 → 都市高速 と走れる。
// 通用門は一般道でつながる。敷地のほかの場所に道路が接しても、つながらない。以前の空港は、読み込むときに正門へつなぎ直す
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { AIRPORT_SPECS, airportLayout, footprintAt, landLoop, loopRoute, makeFrame, placeCentre, planAirport, type AirportSize } from '../src/sim/airport';
import { DX, DY } from '../src/sim/constants';

type Cmd = Parameters<World['exec']>[0];
const flat = (n = 128) => {
  const w = new World(n), V = n + 1;
  for (let i = 0; i < V * V; i++) w.g.heights[i] = 8;
  w.sandbox = true; w.funds = 1e10;
  return w;
};
const ok = (w: World, c: Cmd) => { const r = w.exec(c); if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.msg}`); return r; };
const ID = { 1: 'airport_1', 2: 'airport_2', 3: 'airport_3' } as const;

function place(size: AirportSize, rot: number) {
  const w = flat();
  ok(w, { t: 'plop', id: ID[size], x: 64, y: 64, rot });
  const b = [...w.buildings.values()].find((q) => q.type === ID[size])!;
  return { w, b };
}
// 車の経路のグラフ（道路 + 空港のループのつながり）で、from から to へ行けるか
function reach(w: World, links: [number, number, number][], from: number, to: number) {
  const L = new Map<number, number[]>();
  for (const [u, v] of links) (L.get(u) ?? L.set(u, []).get(u)!).push(v);
  const seen = new Set([from]), q = [from];
  while (q.length) {
    const u = q.pop()!;
    if (u === to) return true;
    const next: number[] = [...(L.get(u) ?? [])];
    w.g.forEachOut(u, (v) => next.push(v));
    for (const v of next) if (!seen.has(v)) { seen.add(v); q.push(v); }
  }
  return false;
}
// 門の外 k マスから門のマスまで引く
function drawInto(w: World, gc: { x: number; y: number; d: number }, road: RoadType, k = 10) {
  return w.exec({ t: 'road', x0: gc.x + DX[gc.d] * k, y0: gc.y + DY[gc.d] * k, x1: gc.x, y1: gc.y, road });
}

describe('airport gates and the landside loop', () => {
  for (const size of [1, 2, 3] as const) {
    it(`size ${size}: an urban highway ending in the main gate connects in all 8 orientations, and cars loop through both levels`, () => {
      for (let rot = 0; rot < 8; rot++) {
        for (const t of [RoadType.UrbanHighway, RoadType.UrbanGroundHighway]) {
          const { w, b } = place(size, rot);
          const A0 = w.airportAccess(b)!;
          expect(A0.main, `rot ${rot} unconnected at first`).toBe(null);
          const gc = A0.ports.gate!;
          const r = drawInto(w, gc, t);
          expect(r.ok, `rot ${rot} road ${t}: ${r.msg}`).toBe(true);
          const A = w.airportAccess(b)!;
          expect(A.main?.kind, `rot ${rot} road ${t}`).toBe('hw');
          const N = w.g.n * w.g.n, far = (t === RoadType.UrbanHighway ? N : 0) + w.g.idx(gc.x + DX[gc.d] * 10, gc.y + DY[gc.d] * 10);
          const n = A.nodes;
          // 都市高速 → 正門 → ターミナル、ターミナル → 正門 → 都市高速
          expect(reach(w, A.links, far, n.term), `rot ${rot} in`).toBe(true);
          expect(reach(w, A.links, n.term, far), `rot ${rot} out`).toBe(true);
          // 両方の階の U ターン：正門 → 車寄せ → U ターン → 戻りの道 → 正門 → 都市高速
          for (const [curb, u] of [[n.arrCurb, n.arrU], [n.depCurb, n.depU]]) {
            expect(reach(w, A.links, A.main!.node, curb)).toBe(true);
            const via = A.links.filter(([p]) => p === curb).map(([, q]) => q);
            expect(via).toContain(u);
            expect(A.links.filter(([p]) => p === u).map(([, q]) => q)).toContain(n.ret);
            expect(reach(w, A.links, n.ret, far)).toBe(true);
          }
          expect(new Set(Object.values(n)).size).toBe(Object.values(n).length);
        }
      }
    });

    it(`size ${size}: an ordinary road or avenue into the main gate connects; the service gate takes a road; touching the lot elsewhere does not`, () => {
      for (let rot = 0; rot < 8; rot++) {
        const { w, b } = place(size, rot);
        const A0 = w.airportAccess(b)!;
        // 敷地のふちに接するだけの道路（門ではない）
        const lot = new Set(w.lotCells(b)!);
        let touched = false;
        for (const i of lot) {
          const x = i % 128, y = (i / 128) | 0;
          for (let d = 0; d < 8 && !touched; d += 2) {
            const qx = x + DX[d] * 2, qy = y + DY[d] * 2, px = x + DX[d], py = y + DY[d];
            const j = py * 128 + px;
            if (lot.has(j) || lot.has(qy * 128 + qx) || j === A0.ports.gate!.cell || j === A0.ports.svc!.cell) continue;
            if (Math.hypot(px - A0.ports.gate!.x, py - A0.ports.gate!.y) < 6 || Math.hypot(px - A0.ports.svc!.x, py - A0.ports.svc!.y) < 6) continue;
            touched = w.exec({ t: 'road', x0: qx + DX[d] * 3, y0: qy + DY[d] * 3, x1: px, y1: py, road: RoadType.Road }).ok;
          }
          if (touched) break;
        }
        expect(touched).toBe(true);
        expect(w.airportAccess(b)!.main).toBe(null);
        expect(w.accessCells(b)).toEqual([]);
        // 正門へ大通り（斜めは一般道）
        const gc = A0.ports.gate!;
        const road = gc.d & 1 ? RoadType.Road : RoadType.Avenue;
        let r = drawInto(w, gc, road);
        if (!r.ok || !w.airportAccess(b)!.main) r = drawInto(w, gc, RoadType.Road);
        expect(w.airportAccess(b)!.main?.kind, `rot ${rot}`).toBe('road');
        const A = w.airportAccess(b)!;
        // 引いた道路の、門から 8 マスほど外のマス（大通りは格子点に沿うので、まわりのマスから探す）
        let far = -1;
        for (let dy = -1; dy <= 1 && far < 0; dy++) for (let dx = -1; dx <= 1 && far < 0; dx++) {
          const j = w.g.idx(gc.x + DX[gc.d] * 8 + dx, gc.y + DY[gc.d] * 8 + dy);
          if (w.g.road[j]) far = j;
        }
        expect(reach(w, A.links, far, A.nodes.term)).toBe(true);
        expect(reach(w, A.links, A.nodes.term, far)).toBe(true);
        // 通用門
        const sc = A.ports.svc!;
        expect(drawInto(w, sc, RoadType.Road, 6).ok, `rot ${rot} svc`).toBe(true);
        const A2 = w.airportAccess(b)!;
        expect(A2.svc?.kind).toBe('road');
        expect(reach(w, A2.links, w.g.idx(sc.x + DX[sc.d] * 6, sc.y + DY[sc.d] * 6), A2.cargo)).toBe(true);
        expect(w.accessCells(b).sort()).toEqual([gc.cell, sc.cell].sort());
      }
    });
  }

  it('the loop routes run both levels with their own U-turn, curb on the right (terminal side)', () => {
    for (const size of [1, 2, 3] as const) {
      const L = airportLayout(size), P = landLoop(L);
      const term = L.buildings.find((b) => b.kind === 'terminal')!.r;
      for (const gateH of [0, 9]) {
        const g: [number, number, number] = [L.gate, L.land.edge + 8, gateH];
        const arr = loopRoute(L, 'arrCar', 0, g), dep = loopRoute(L, 'depCar', 0, g);
        // 到着は地上だけ、出発は高架の車寄せ（高さ h）を通る
        expect(arr.pts.filter((p) => p[1] < P.r1 + 0.5).every((p) => p[2] === 0)).toBe(true);
        expect(dep.pts.filter((p) => p[2] === P.h).length).toBeGreaterThan(4);
        for (const R of [arr, dep]) {
          // 車寄せの車線はターミナルの側：-a へ走るとき c が小さいほうが右（右側通行）
          const cs = R.pts.filter((p) => Math.abs(p[1] - P.curb) < 0.01);
          expect(cs.length).toBe(2);
          expect(cs[0][0]).toBeGreaterThan(cs[1][0]);
          expect(P.curb).toBeGreaterThan(term.c1 - 0.01);
          // U ターン：a のいちばん小さいところで、c が内側から外側へ
          const k = R.pts.findIndex((p, i) => i > 0 && Math.abs(p[1] - P.ret1) < 0.01 && Math.abs(R.pts[i - 1][1] - P.thru) < 0.01);
          expect(k).toBeGreaterThan(0);
          expect(R.pts[k][0]).toBeCloseTo(R.pts[k - 1][0], 5);
        }
      }
    }
  });

  it('a legacy airport with an urban highway beside it is reconnected to the gate on load', () => {
    const { w, b } = place(2, 1);
    const gc = w.airportAccess(b)!.ports.gate!;
    // 正門の 3 マス外を通る都市高速（以前の空港なら、敷地のそばでつながっていた）
    const px = gc.x + DX[gc.d] * 3, py = gc.y + DY[gc.d] * 3, sd = (gc.d + 2) & 7;
    ok(w, { t: 'road', x0: px - DX[sd] * 8, y0: py - DY[sd] * 8, x1: px + DX[sd] * 8, y1: py + DY[sd] * 8, road: RoadType.UrbanHighway });
    expect(w.airportAccess(b)!.main).toBe(null);
    const save = w.serialize();
    for (const q of save.buildings) delete (q as { airGate?: number }).airGate;
    const w2 = World.load(save);
    const b2 = w2.buildings.get(b.id)!;
    expect(w2.airportAccess(b2)!.main?.kind).toBe('hw');
    expect(b2.airLegacy).toBe(false);
    // つなぐものがなければ、つながっていないと知らせる
    const { w: w3, b: b3 } = place(1, 2);
    const s3 = w3.serialize();
    for (const q of s3.buildings) delete (q as { airGate?: number }).airGate;
    const w4 = World.load(s3);
    expect(w4.buildings.get(b3.id)!.airLegacy).toBe(true);
  });
});
void AIRPORT_SPECS; void footprintAt; void makeFrame; void placeCentre; void planAirport;

describe('drawing into the gate', () => {
  it('extending a dead-end road by one cell into the gate does not snap back', () => {
    const w = flat();
    ok(w, { t: 'plop', id: 'airport_1', x: 64, y: 64, rot: 4 });
    const b = [...w.buildings.values()][0];
    const gc = w.airportAccess(b)!.ports.gate!;
    ok(w, { t: 'road', x0: gc.x + DX[gc.d] * 6, y0: gc.y + DY[gc.d] * 6, x1: gc.x + DX[gc.d], y1: gc.y + DY[gc.d], road: RoadType.Road });
    expect(w.airportAccess(b)!.main).toBe(null);
    ok(w, { t: 'road', x0: gc.x + DX[gc.d], y0: gc.y + DY[gc.d], x1: gc.x, y1: gc.y, road: RoadType.Road });
    expect(w.airportAccess(b)!.main?.kind).toBe('road');
  });
});
