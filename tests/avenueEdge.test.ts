// 大通りをマップの端まで引く（隣の都市へ続く）。
// ・2本の車線とも、マップの端のマスまで届く。端では折り返さない（隣の都市へ出ていく・入ってくる）。
// ・端の1マス手前で止めても、マップの端までのばす。
// ・交通：端へ向かう車線から、隣の都市（マップの端のマス → 外のノード）へ行ける。
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { DX, DY } from '../src/sim/constants';
import { assignTrips, buildJunctions } from '../src/sim/traffic';

const AV = RoadType.Avenue;
const n = 32;
function flat() {
  const w = new World(n);
  w.g.heights.fill(6);
  w.funds = 1e9;
  return w;
}
const draw = (w: World, x0: number, y0: number, x1: number, y1: number) => {
  const r = w.exec({ t: 'road', x0, y0, x1, y1, road: AV });
  expect(r.ok, r.msg).toBe(true);
};
const bit = (m: number, d: number) => (m & (1 << d)) !== 0;

// [名前, 中心線, 端の外向き, 端の行きの車線のマス, 端の帰りの車線のマス]
const CASES: [string, [number, number, number, number], number, [number, number], [number, number]][] = [
  ['east', [10, 16, n, 16], 0, [n - 1, 16], [n - 1, 15]],
  ['west', [20, 16, 0, 16], 4, [0, 15], [0, 16]],
  ['south', [16, 10, 16, n], 2, [15, n - 1], [16, n - 1]],
  ['north', [16, 20, 16, 0], 6, [16, 0], [15, 0]],
];

describe('大通りをマップの端まで', () => {
  for (const [name, L, out, F, B] of CASES) {
    for (const short of [false, true]) {
      it(`${name}${short ? '（1マス手前で止めてものびる）' : ''}`, () => {
        const w = flat(), g = w.g;
        const line = L.slice() as typeof L;
        if (short) { line[2] -= DX[out]; line[3] -= DY[out]; }
        draw(w, ...line);
        const f = g.idx(F[0], F[1]), b = g.idx(B[0], B[1]);
        expect(g.road[f]).toBe(AV);
        expect(g.road[b]).toBe(AV);
        // 行きの車線は端のマスへ入ってくる、帰りの車線は端のマスから内へ出ていく
        const fin = g.idx(F[0] - DX[out], F[1] - DY[out]);
        expect(bit(g.flow[fin], out)).toBe(true);
        expect(bit(g.flow[b], (out + 4) & 7)).toBe(true);
        // 端で折り返さない（2本の車線の間のつながりがない）
        expect(g.flow[f]).toBe(0);
        expect(g.flow[b]).toBe(1 << ((out + 4) & 7));
        const side = [0, 2, 4, 6].find((d) => B[0] - F[0] === DX[d] && B[1] - F[1] === DY[d])!;
        expect(bit(g.conn[f], side)).toBe(false);
        // 端の先へは何もはみ出さない（マップの外なので）。反対側の端は、ふつうに折り返す
        let uturns = 0;
        for (let i = 0; i < n * n; i++)
          if (g.road[i] === AV)
            for (const d of [0, 2, 4, 6]) {
              const x = (i % n) + DX[d], y = ((i / n) | 0) + DY[d];
              if (g.inb(x, y) && bit(g.flow[i], d) && g.road[g.idx(x, y)] === AV && !bit(g.flow[i], (d + 4) & 7) && (d === ((out + 2) & 7) || d === ((out + 6) & 7))) uturns++;
            }
        expect(uturns).toBe(1);
      });
    }
  }

  it('引き直しても変わらない。古い折り返しが残っていれば外す', () => {
    const w = flat(), g = w.g;
    draw(w, 10, 16, n, 16);
    expect(w.exec({ t: 'road', x0: 10, y0: 16, x1: n, y1: 16, road: AV }).ok).toBe(false); // すでに大通りです
    // 古い保存データ：端の折り返し（行き → 帰り）
    const f = g.idx(n - 1, 16), b = g.idx(n - 1, 15);
    g.flow[f] |= 1 << 6;
    g.conn[f] |= 1 << 6;
    g.conn[b] |= 1 << 2;
    draw(w, 10, 16, n, 16);
    expect(g.flow[f]).toBe(0);
    expect(g.conn[f] & (1 << 6)).toBe(0);
  });

  it('交通：端へ向かう車線から隣の都市へ行ける', () => {
    const w = flat(), g = w.g;
    draw(w, 10, 16, n, 16);
    const N = n * n;
    const J = buildJunctions(g, new Float32Array(2 * N));
    // 大通りの行きの車線の途中から、行き先は隣の都市だけ
    const r = assignTrips(g, [{ cell: g.idx(14, 16), trips: 10, buildings: [{ id: 9, trips: 10 }] }], new Map(), new Float32Array(2 * N).fill(1), J, () => 0.5, {
      externalCap: 100, externalOnly: true, carOnly: true, maxMinutes: 120, weight: 1,
    });
    expect(r.external).toBe(10);
    // 帰りの車線からも、反対側の端で折り返して行ける
    const r2 = assignTrips(g, [{ cell: g.idx(14, 15), trips: 10, buildings: [{ id: 9, trips: 10 }] }], new Map(), new Float32Array(2 * N).fill(1), J, () => 0.5, {
      externalCap: 100, externalOnly: true, carOnly: true, maxMinutes: 120, weight: 1,
    });
    expect(r2.external).toBe(10);
  });
});
