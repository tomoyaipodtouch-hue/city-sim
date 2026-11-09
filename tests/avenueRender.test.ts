// 大通りの見た目が、シミュレーションの車線の決まりとそろっていること
// （中央分離帯の向き、分離帯の並木の位置。橋の上には木を植えない）
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { CELL } from '../src/sim/constants';
import { RoadLayer, avenueMedianDir, AV_W } from '../src/render/roadLayer';

const AV = RoadType.Avenue;
const E = 0, S = 2, W = 4, N = 6;

function flat(n = 48) {
  const w = new World(n);
  w.g.heights.fill(6);
  w.funds = 1e9;
  return w;
}
function draw(w: World, x0: number, y0: number, x1: number, y1: number, road: RoadType = AV) {
  const r = w.exec({ t: 'road', x0, y0, x1, y1, road });
  expect(r.ok, `road ${road} (${x0},${y0})→(${x1},${y1}): ${r.msg}`).toBe(true);
}

describe('大通りの中央分離帯の向き（右側通行：進む向きの左が分離帯）', () => {
  it('東西の線：北の行は西向きで分離帯は南、南の行は東向きで分離帯は北（引く向きによらない）', () => {
    for (const [x0, x1] of [[4, 40], [40, 4]]) {
      const w = flat();
      draw(w, x0, 20, x1, 20);
      for (let x = 6; x < 38; x++) {
        expect(avenueMedianDir(w.g, w.g.idx(x, 19)), `(${x},19)`).toBe(S);
        expect(avenueMedianDir(w.g, w.g.idx(x, 20)), `(${x},20)`).toBe(N);
      }
    }
  });
  it('南北の線：西の列は南向きで分離帯は東、東の列は北向きで分離帯は西', () => {
    for (const [y0, y1] of [[4, 40], [40, 4]]) {
      const w = flat();
      draw(w, 20, y0, 20, y1);
      for (let y = 6; y < 38; y++) {
        expect(avenueMedianDir(w.g, w.g.idx(19, y)), `(19,${y})`).toBe(E);
        expect(avenueMedianDir(w.g, w.g.idx(20, y)), `(20,${y})`).toBe(W);
      }
    }
  });
});

describe('分離帯の並木（ケヤキ）', () => {
  it('まっすぐな区間：中心線の両側に1列ずつ、8m ごと。分離帯の植え込みの中だけ', () => {
    const w = flat();
    draw(w, 4, 20, 40, 20);
    const L = new RoadLayer();
    L.rebuild(w.g);
    const zc = 20 * CELL;
    const trees = L.medianTrees;
    expect(trees.length).toBeGreaterThan(20);
    // 分離帯の縁石から 2.75m：中心線から (CELL - AV_W) / 2 - 2.75
    const off = (CELL - AV_W) / 2 - 2.75;
    const rows = new Map<number, number[]>();
    for (const t of trees) {
      const dz = t.z - zc;
      expect(Math.abs(Math.abs(dz) - off), `木 (${t.x.toFixed(1)}, ${t.z.toFixed(1)})`).toBeLessThan(0.05);
      expect(t.x).toBeGreaterThan(4 * CELL);
      expect(t.x).toBeLessThan(40 * CELL);
      const k = Math.sign(dz);
      (rows.get(k) ?? rows.set(k, []).get(k)!).push(t.x);
    }
    expect([...rows.keys()].sort()).toEqual([-1, 1]);
    for (const xs of rows.values()) {
      xs.sort((a, b) => a - b);
      for (let k = 1; k < xs.length; k++) expect(xs[k] - xs[k - 1]).toBeGreaterThanOrEqual(7.9);
      // 道の真ん中あたりは、すき間なく 8m ごと
      const mid = xs.filter((x) => x > 10 * CELL && x < 34 * CELL);
      for (let k = 1; k < mid.length; k++) expect(mid[k] - mid[k - 1]).toBeCloseTo(8, 1);
    }
  });

  it('橋の上（水の上）には植えない', () => {
    const w = flat();
    for (let vy = 0; vy <= w.g.n; vy++) for (let vx = 20; vx <= 26; vx++) w.g.setVh(vx, vy, -3);
    draw(w, 4, 20, 42, 20);
    expect(w.g.deck[w.g.idx(23, 19)]).toBeGreaterThan(0);
    const L = new RoadLayer();
    L.rebuild(w.g);
    expect(L.medianTrees.length).toBeGreaterThan(10);
    for (const t of L.medianTrees) {
      const c = w.g.idx(Math.floor(t.x / CELL), Math.floor(t.z / CELL));
      expect(w.g.deck[c], `木 (${t.x.toFixed(1)}, ${t.z.toFixed(1)}) が橋の上`).toBe(0);
    }
  });
});
