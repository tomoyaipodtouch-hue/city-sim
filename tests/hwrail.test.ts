// 高架の高速道路が高架鉄道をまたぐ所：高速道路だけを持ち上げて（約 10% の坂）、線路の上を越える（src/sim/hwrail.ts）
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { CELL } from '../src/sim/constants';
import { RailLayer } from '../src/render/railLayer';
import { removeTransitAt } from '../src/sim/plan';
import {
  erailDeckH, HWR_CLEAR, HWR_GRADE, HWR_MSG_END, HWR_MSG_PARALLEL, HWR_MSG_PARALLEL_RAIL, HWR_MSG_RAMP, HWR_MSG_STATION,
  ERAIL_CATENARY, ERAIL_RAIL_TOP, HW_STRUCT, HW_ROAD_LIFT, levelHighwaysOverRail,
} from '../src/sim/hwrail';

type Line = [number, number, number, number];
const mk = () => {
  const w = new World(48);
  w.g.heights.fill(6);
  w.funds = 1e9;
  return w;
};
const rail = (w: World, l: Line) => w.exec({ t: 'transit', x0: l[0], y0: l[1], x1: l[2], y1: l[3], kind: 'erail' });
const road = (w: World, l: Line, road: RoadType) => w.exec({ t: 'road', x0: l[0], y0: l[1], x1: l[2], y1: l[3], road });
// 線（まっすぐか 45°）のマス
const cellsOf = (w: World, l: Line) => {
  const sx = Math.sign(l[2] - l[0]), sy = Math.sign(l[3] - l[1]);
  const len = Math.max(Math.abs(l[2] - l[0]), Math.abs(l[3] - l[1]));
  return Array.from({ length: len + 1 }, (_, k) => w.g.idx(l[0] + sx * k, l[1] + sy * k));
};
const railHeights = (w: World) => {
  const out: number[] = [];
  for (let i = 0; i < w.g.n * w.g.n; i++) if (w.g.erail[i]) out.push(RailLayer.lineH(w.g, 'erail', i));
  return out;
};

// 高速道路の縦断：となりのマスとの勾配と、交差の所の高さ
function checkProfile(w: World, cells: number[], diag: boolean) {
  const g = w.g;
  const step = diag ? CELL * Math.SQRT2 : CELL;
  let maxGrade = 0;
  for (let k = 0; k + 1 < cells.length; k++) {
    const a = cells[k], b = cells[k + 1];
    if (!g.up[a] || !g.up[b]) continue;
    maxGrade = Math.max(maxGrade, Math.abs(g.upH[b] - g.upH[a]) / step);
  }
  expect(maxGrade).toBeLessThanOrEqual(HWR_GRADE + 1e-6);
  // 線路のマス（またはマスの角で交わる両側のマス）で、桁の下面が架線柱の上端より上
  const crossing = cells.filter((c) => g.erail[c]);
  for (const c of crossing) {
    expect(g.upH[c] - erailDeckH(g, c)).toBeGreaterThanOrEqual(HWR_CLEAR - 1e-6);
    // 鉄道の床版の高さは、描画（RailLayer）と同じ
    expect(erailDeckH(g, c)).toBeCloseTo(RailLayer.lineH(g, 'erail', c), 5);
  }
  const top = Math.max(...cells.map((c) => g.upH[c]));
  return { maxGrade, top, crossing };
}

const GEOMS: Record<string, { rail: Line; hw: Line; diag: boolean }> = {
  axis90: { rail: [4, 24, 44, 24], hw: [24, 4, 24, 44], diag: false },
  diagHw45: { rail: [4, 24, 44, 24], hw: [4, 4, 44, 44], diag: true },
  diagRail45: { rail: [4, 4, 44, 44], hw: [24, 4, 24, 44], diag: false },
  diag90corner: { rail: [5, 44, 44, 5], hw: [4, 4, 44, 44], diag: true }, // 斜めどうしがマスの角で交わる
};

describe('elevated highway over elevated rail', () => {
  it('clearance numbers', () => {
    // 桁の下面 - 架線柱の上端 = 0.5m、レールの上面から桁の下面まで 6.74m（実際の電化路線の 5.0〜5.5m 以上）
    const under = HWR_CLEAR + HW_ROAD_LIFT - HW_STRUCT;
    expect(under - ERAIL_CATENARY).toBeCloseTo(0.5, 5);
    expect(under - ERAIL_RAIL_TOP).toBeGreaterThanOrEqual(5.5);
  });

  for (const [name, G] of Object.entries(GEOMS))
    for (const order of ['rail first', 'highway first'] as const)
      for (const type of [RoadType.UrbanHighway, RoadType.UrbanHighway1W, RoadType.Highway]) {
        if (type === RoadType.Highway && name !== 'axis90' && name !== 'diagHw45') continue;
        it(`${name}, ${order}, type ${type}`, () => {
          const w = mk();
          // 線路だけのときの鉄道の高さ
          const ref = mk();
          expect(rail(ref, G.rail).ok).toBe(true);
          const r1 = order === 'rail first' ? rail(w, G.rail) : road(w, G.hw, type);
          const r2 = order === 'rail first' ? road(w, G.hw, type) : rail(w, G.rail);
          expect(r1.ok, r1.msg).toBe(true);
          expect(r2.ok, r2.msg).toBe(true);
          // 鉄道の高さは変わらない
          expect(railHeights(w)).toEqual(railHeights(ref));
          const cells = cellsOf(w, G.hw);
          const p = checkProfile(w, cells, G.diag);
          // 交差の所は、ふつうの高さ（地面 + 9〜10m）より上がっている
          expect(p.top - 6).toBeGreaterThan(8 + HWR_CLEAR - 0.01);
          if (name === 'diag90corner') {
            // マスの角で交わる：角の両側のマスの平均（角の上の高さ）で足りている
            const g = w.g;
            const k = cells.findIndex((c) => g.upH[c] === p.top);
            expect((g.upH[cells[k]] + g.upH[cells[k + 1]]) / 2 - (6 + 8)).toBeGreaterThanOrEqual(HWR_CLEAR - 1e-6);
          } else expect(p.crossing.length).toBe(1);
          // 遠くは、ふつうの高さのまま
          expect(w.g.upH[cells[2]]).toBeCloseTo(w.g.upH[cells[cells.length - 3]], 3);
          expect(w.g.upH[cells[2]] - 6).toBeLessThan(10.01);
          // 両方の順番で同じ高さ
          const w2 = mk();
          if (order === 'rail first') { road(w2, G.hw, type); rail(w2, G.rail); } else { rail(w2, G.rail); road(w2, G.hw, type); }
          expect(Array.from(cells, (c) => +w2.g.upH[c].toFixed(3))).toEqual(Array.from(cells, (c) => +w.g.upH[c].toFixed(3)));
        });
      }

  it('the climb is short: about 10% for a few cells on each side', () => {
    const w = mk();
    rail(w, GEOMS.axis90.rail);
    road(w, GEOMS.axis90.hw, RoadType.UrbanHighway);
    const raised = cellsOf(w, GEOMS.axis90.hw).filter((c) => w.g.upH[c] > 6 + 9 + 0.05);
    // 交差のマス + 両側 5〜6 マス
    expect(raised.length).toBeLessThanOrEqual(13);
    expect(raised.length).toBeGreaterThanOrEqual(9);
  });

  it('refuses running along the rail (both orders)', () => {
    let w = mk();
    rail(w, [4, 24, 44, 24]);
    let r = road(w, [10, 24, 30, 24], RoadType.UrbanHighway);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_PARALLEL);
    r = road(w, [10, 10, 40, 40], RoadType.UrbanHighway);
    expect(r.ok, r.msg).toBe(true); // 横切るのはよい
    w = mk();
    road(w, [10, 24, 30, 24], RoadType.UrbanHighway);
    r = rail(w, [4, 24, 44, 24]);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_PARALLEL_RAIL);
    // 斜めに沿って重ねるのもだめ
    w = mk();
    rail(w, [4, 4, 44, 44]);
    r = road(w, [10, 10, 30, 30], RoadType.UrbanHighway1W);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_PARALLEL);
  });

  it('refuses crossing over a station', () => {
    const w = mk();
    expect(rail(w, [4, 24, 44, 24]).ok).toBe(true);
    expect(road(w, [4, 25, 44, 25], RoadType.Road).ok).toBe(true);
    const st = w.exec({ t: 'estop', x: 24, y: 24 });
    expect(st.ok, st.msg).toBe(true);
    let r = road(w, [24, 4, 24, 44], RoadType.UrbanHighway);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_STATION);
    // 駅のすぐ隣の線路のマスもだめ。離れていればよい
    const stn = Array.from({ length: 48 }, (_, x) => x).filter((x) => w.g.estn[w.g.idx(x, 24)]);
    r = road(w, [stn[stn.length - 1] + 1, 4, stn[stn.length - 1] + 1, 44], RoadType.UrbanHighway);
    expect(r.ok).toBe(false);
    r = road(w, [stn[stn.length - 1] + 4, 4, stn[stn.length - 1] + 4, 44], RoadType.UrbanHighway);
    expect(r.ok, r.msg).toBe(true);
    // 高速道路の下には駅を置けない
    const w2 = mk();
    road(w2, [24, 4, 24, 44], RoadType.UrbanHighway);
    rail(w2, [4, 24, 44, 24]);
    road(w2, [4, 25, 44, 25], RoadType.Road);
    expect(w2.exec({ t: 'estop', x: 24, y: 24 }).ok).toBe(false);
  });

  it('refuses crossing over the platform of an elevated station building', () => {
    const w = mk();
    rail(w, [4, 24, 44, 24]);
    road(w, [4, 27, 44, 27], RoadType.Road);
    expect(w.exec({ t: 'plop', id: 'el_station', x: 24, y: 25 }).ok).toBe(true);
    // 駅の敷地（24..25, 25..26）のまわりの線路のマスがホーム
    const r = road(w, [23, 4, 23, 44], RoadType.UrbanHighway);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_STATION);
    expect(road(w, [30, 4, 30, 44], RoadType.UrbanHighway).ok).toBe(true);
    // 高速道路の下には、敷地のある駅も置けない
    const p = w.exec({ t: 'plop', id: 'el_station', x: 30, y: 25 });
    expect(p.ok).toBe(false);
  });

  it('refuses when a ramp is too close (both orders)', () => {
    // 線路を後から：ランプが坂の範囲にある
    let w = mk();
    road(w, [24, 4, 24, 44], RoadType.UrbanHighway);
    expect(w.exec({ t: 'uramp', x: 25, y: 31 }).ok).toBe(true);
    let r = rail(w, [4, 26, 44, 26]);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_RAMP);
    // 離れていればよい
    r = rail(w, [4, 14, 44, 14]);
    expect(r.ok, r.msg).toBe(true);
    checkProfile(w, cellsOf(w, [24, 4, 24, 44]), false);
    // 高速道路を後から：続きを引いて線路を越えると、坂がランプにかかる
    w = mk();
    road(w, [24, 30, 24, 44], RoadType.UrbanHighway);
    expect(w.exec({ t: 'uramp', x: 25, y: 34 }).ok).toBe(true);
    rail(w, [4, 26, 44, 26]);
    r = road(w, [24, 4, 24, 30], RoadType.UrbanHighway);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_RAMP);
  });

  it('refuses when the highway ends too close to the rail', () => {
    const w = mk();
    rail(w, [4, 26, 44, 26]);
    const r = road(w, [24, 4, 24, 29], RoadType.UrbanHighway);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe(HWR_MSG_END);
  });

  it('stays valid after the rail is bulldozed, and levelling is idempotent', () => {
    const w = mk();
    rail(w, GEOMS.diagHw45.rail);
    road(w, GEOMS.diagHw45.hw, RoadType.UrbanHighway);
    const g = w.g;
    const before = g.upH.slice();
    expect(levelHighwaysOverRail(g)).toEqual([]);
    expect(Array.from(g.upH)).toEqual(Array.from(before));
    // 線路だけを取り除く（取り壊しの「高架」は、上の高速道路も一緒に壊すので、直接外す）
    for (let x = 0; x < g.n; x++) removeTransitAt(g, g.idx(x, 24), 'up');
    expect(levelHighwaysOverRail(g)).toEqual([]);
    const cells = cellsOf(w, GEOMS.diagHw45.hw);
    expect(cells.every((c) => g.up[c])).toBe(true);
    checkProfile(w, cells, true);
    // 線路を引き直しても同じ
    expect(rail(w, GEOMS.diagHw45.rail).ok).toBe(true);
    expect(Array.from(g.upH)).toEqual(Array.from(before));
  });

  it('old saves with a highway sunk into the rail are raised on load', () => {
    const w = mk();
    rail(w, GEOMS.axis90.rail);
    road(w, GEOMS.axis90.hw, RoadType.UrbanHighway);
    const cells = cellsOf(w, GEOMS.axis90.hw);
    const want = cells.map((c) => w.g.upH[c]);
    for (const c of cells) w.g.upH[c] = 6 + 9; // 以前の版の高さ
    const w2 = World.load(w.serialize());
    expect(cells.map((c) => w2.g.upH[c])).toEqual(want);
  });
});
