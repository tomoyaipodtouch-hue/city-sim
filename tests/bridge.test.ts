// 道路の橋の構造物（BridgeLayer）：橋のまとめ方と、構造物が床版からはみ出さないこと
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { addBridgeStructures, roadBridgeFrames, type BridgeFrame } from '../src/render/bridgeStyles';
import { ROAD_LIFT } from '../src/render/roadLayer';
import { PbrBuf } from '../src/render/infraMaterial';

// 南北に流れる川（格子点 x = 20..26 が水）
function riverNS(n = 48) {
  const w = new World(n);
  w.g.heights.fill(6);
  w.funds = 1e9;
  for (let vy = 0; vy <= n; vy++) for (let vx = 20; vx <= 26; vx++) w.g.setVh(vx, vy, -3);
  return w;
}
// 斜めに流れる川（格子点で 6 <= x - y <= 12 が水）
function riverDiag(n = 64) {
  const w = new World(n);
  w.g.heights.fill(6);
  w.funds = 1e9;
  for (let vy = 0; vy <= n; vy++)
    for (let vx = 0; vx <= n; vx++) {
      const k = vx - vy;
      if (k >= 6 && k <= 12) w.g.setVh(vx, vy, -3);
    }
  return w;
}
function draw(w: World, x0: number, y0: number, x1: number, y1: number, road: RoadType) {
  const r = w.exec({ t: 'road', x0, y0, x1, y1, road });
  expect(r.ok, `road ${road} (${x0},${y0})→(${x1},${y1}): ${r.msg}`).toBe(true);
}

// 構造物の頂点を、橋の枠の座標（道に沿った s、横の q、高さ y）で返す
function structurePoints(w: World, style: number) {
  for (let i = 0; i < w.g.bstyle.length; i++) w.g.bstyle[i] = style;
  const B = new PbrBuf();
  addBridgeStructures(w.g, B, ROAD_LIFT);
  return B;
}
function toFrame(F: BridgeFrame, B: PbrBuf) {
  const out: [number, number, number][] = [];
  for (let k = 0; k < B.P.length; k += 3) {
    const x = B.P[k] - F.sx, y = B.P[k + 1], z = B.P[k + 2] - F.sz;
    out.push([x * F.ux + z * F.uz, x * F.px + z * F.pz, y]);
  }
  return out;
}

describe('bridge structures', () => {
  it('a straight avenue bridge is one structure on the avenue axis, centred between the two lanes', () => {
    const w = riverNS();
    draw(w, 10, 24, 36, 24, RoadType.Avenue);
    const fs = roadBridgeFrames(w.g);
    expect(fs.length).toBe(1);
    const F = fs[0];
    expect(F.t).toBe(RoadType.Avenue);
    expect(Math.abs(F.ux)).toBeCloseTo(1, 6);
    expect(F.uz).toBeCloseTo(0, 6);
    expect(F.e).toBeCloseTo(8, 6);
    expect(F.Wd).toBeCloseTo(15.5, 6);
    // 中心は2本の車線のマスの境（行の境の z）
    const rows = new Set(F.cells.map((c) => (c / w.g.n) | 0));
    expect(rows.size).toBe(2);
    const zc = Math.max(...rows) * 16;
    expect(F.sz).toBeCloseTo(zc, 6);
    expect(F.span[0]).toEqual(F.span[1]);
  });

  it('an avenue and a road built side by side are separate bridges', () => {
    const w = riverNS();
    draw(w, 10, 24, 36, 24, RoadType.Avenue);
    const rows = new Set<number>();
    for (let c = 0; c < w.g.road.length; c++) if (w.g.road[c] === RoadType.Avenue) rows.add((c / w.g.n) | 0);
    draw(w, 10, Math.max(...rows) + 1, 36, Math.max(...rows) + 1, RoadType.Road);
    const fs = roadBridgeFrames(w.g);
    expect(fs.map((f) => f.t).sort()).toEqual([RoadType.Road, RoadType.Avenue].sort());
    const road = fs.find((f) => f.t === RoadType.Road)!;
    expect(road.e).toBe(0);
    expect(road.Wd).toBeCloseTo(7, 6);
  });

  it('a diagonal avenue bridge is one structure on the 45° axis', () => {
    const w = riverDiag();
    draw(w, 4, 40, 28, 16, RoadType.Avenue);
    const fs = roadBridgeFrames(w.g).filter((f) => f.t === RoadType.Avenue);
    expect(fs.length).toBe(1);
    const F = fs[0];
    expect(Math.abs(F.ux)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(F.uz)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(F.e).toBeCloseTo(8 / Math.SQRT2, 3);
  });

  it('a ground highway bridge puts both carriageways on one structure', () => {
    const w = riverNS();
    draw(w, 6, 30, 42, 30, RoadType.GroundHighway);
    const fs = roadBridgeFrames(w.g);
    expect(fs.length).toBe(1);
    expect(fs[0].e).toBeCloseTo(8, 6);
    expect(fs[0].gap).toBeGreaterThan(0);
  });

  for (const [what, type, x0, y0, x1, y1, diag] of [
    ['straight avenue', RoadType.Avenue, 10, 24, 36, 24, false],
    ['road', RoadType.Road, 10, 24, 36, 24, false],
    ['ground highway', RoadType.GroundHighway, 6, 30, 42, 30, false],
    ['diagonal avenue', RoadType.Avenue, 4, 40, 28, 16, true],
  ] as const) {
    it(`girder bridge piers stay under the deck (${what})`, () => {
      const w = diag ? riverDiag() : riverNS();
      draw(w, x0, y0, x1, y1, type);
      const F = roadBridgeFrames(w.g)[0];
      const pts = toFrame(F, structurePoints(w, 0));
      expect(pts.length).toBeGreaterThan(0);
      for (const [s, q, y] of pts) {
        expect(Math.abs(q)).toBeLessThanOrEqual(F.Wd + 1e-3);
        expect(s).toBeGreaterThanOrEqual(-1e-3);
        expect(s).toBeLessThanOrEqual(F.L + 1e-3);
        expect(y).toBeLessThanOrEqual(F.Hc - 1.2 + 0.1);
      }
      // 橋脚は2本の車線の両方の下にある（2本の車線の橋）
      if (F.e > 0) {
        const low = pts.filter(([, , y]) => y < F.Hc - 4);
        expect(low.some(([, q]) => q < -F.e + 2)).toBe(true);
        expect(low.some(([, q]) => q > F.e - 2)).toBe(true);
      }
    });
  }

  it('every style stays on the bridge axis and close to the deck', () => {
    for (let style = 0; style < 6; style++) {
      const w = riverNS();
      draw(w, 8, 24, 38, 24, RoadType.Avenue);
      const F = roadBridgeFrames(w.g)[0];
      const pts = toFrame(F, structurePoints(w, style));
      expect(pts.length, `style ${style}`).toBeGreaterThan(0);
      let qMax = 0;
      for (const [s, q] of pts) {
        qMax = Math.max(qMax, Math.abs(q));
        expect(s, `style ${style}`).toBeGreaterThanOrEqual(-1.5);
        expect(s, `style ${style}`).toBeLessThanOrEqual(F.L + 1.5);
      }
      // 左右対称（中心がずれていない）
      const lo = Math.min(...pts.map(([, q]) => q)), hi = Math.max(...pts.map(([, q]) => q));
      expect(lo + hi, `style ${style}`).toBeCloseTo(0, 3);
      expect(qMax, `style ${style}`).toBeLessThan(F.Wd + (style === 2 ? 14 : 4));
    }
  });

  it('an avenue overpass gets one wall pier in the highway median under both lanes', () => {
    const w = new World(48);
    w.g.heights.fill(6);
    w.funds = 1e9;
    draw(w, 20, 4, 20, 44, RoadType.GroundHighway);
    draw(w, 6, 24, 36, 24, RoadType.Avenue);
    let ups = 0;
    for (let c = 0; c < w.g.up.length; c++) if (w.g.up[c] === RoadType.Avenue) ups++;
    expect(ups).toBeGreaterThan(0);
    const B = new PbrBuf();
    addBridgeStructures(w.g, B, ROAD_LIFT);
    expect(B.P.length).toBeGreaterThan(0);
    // 壁の橋脚は、高速道路の中央分離帯（2本の車線のマスの境の x）にある
    const hwCols = new Set<number>();
    for (let c = 0; c < w.g.road.length; c++) if (w.g.road[c] === RoadType.GroundHighway) hwCols.add(c % w.g.n);
    const xm = Math.max(...hwCols) * 16;
    let zlo = Infinity, zhi = -Infinity;
    for (let k = 0; k < B.P.length; k += 3) {
      expect(Math.abs(B.P[k] - xm)).toBeLessThanOrEqual(0.91);
      zlo = Math.min(zlo, B.P[k + 2]);
      zhi = Math.max(zhi, B.P[k + 2]);
    }
    // 2本の車線（16m おき）の両方の下にのびる
    expect(zhi - zlo).toBeGreaterThan(20);
  });
});
