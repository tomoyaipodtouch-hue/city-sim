// ジャンクションの車の流れ（carLayer を画面なしで動かす）：たくさんの車が来ても、T字・Y字の分かれ目・合わさり目で
// 止まったまま動けなくなる車（消される車）が出ないか
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { CarLayer } from '../src/render/carLayer';

// 画面のない環境：canvas は何もしないものにする（CarLayer の光の模様に使う）
const sink: any = new Proxy(function () {}, {
  get: (_t, k) => (k === 'width' || k === 'height' ? 32 : k === Symbol.toPrimitive ? () => 0 : k === 'toString' || k === 'valueOf' ? () => '' : sink),
  apply: () => sink,
  set: () => true,
});
(globalThis as any).document ??= { createElement: () => sink };

function run(ta: number, tb: number, diag: boolean) {
  const w = new World(96);
  w.g.heights.fill(10);
  w.funds = 1e9;
  w.exec({ t: 'road', x0: 18, y0: 48, x1: 78, y1: 48, road: ta });
  if (diag) w.exec({ t: 'road', x0: 78, y0: 78, x1: 48, y1: 48, road: tb });
  else w.exec({ t: 'road', x0: 48, y0: 78, x1: 48, y1: 48, road: tb });
  expect(w.exec({ t: 'jct', form: 'tee', x: 48, y: 48 }).ok).toBe(true);
  const g = w.g, N = g.n * g.n;
  // 混んだ都市の交通量（本線は容量いっぱい、ランプもたくさん）
  const tr = new Float32Array(2 * N);
  for (let v = 0; v < 2 * N; v++) { const t = g.nodeType(v); if (t >= RoadType.Highway) tr[v] = t === RoadType.Ramp ? 3000 : 6000; }
  const L = new CarLayer();
  L.setData(g, tr, new Float32Array(2 * N).fill(1), new Float32Array(2 * N));
  for (let k = 0; k < 3000; k++) L.update(1 / 20); // 150 秒
  const cars = (L as any).cars.flatMap((f: any) => f.cars);
  return { drops: L.drops, cars: cars.length };
}

describe('junction traffic flows through T/Y splits and merges (headless car layer)', () => {
  for (const [name, ta, tb, diag] of [
    ['ground × ground, axis', RoadType.UrbanGroundHighway, RoadType.UrbanGroundHighway, false],
    ['ground × ground, diagonal (Y)', RoadType.UrbanGroundHighway, RoadType.UrbanGroundHighway, true],
    ['ground through × elevated branch', RoadType.UrbanGroundHighway, RoadType.UrbanHighway, false],
  ] as [string, number, number, boolean][])
    it(name, { timeout: 120000 }, () => {
      const r = run(ta, tb, diag);
      expect(r.cars).toBeGreaterThan(150);
      // 止まったまま動けずに消された車がない（以前は分かれ目のマスで、反対車線の車を待って止まり、40〜70 台が消えていた）
      expect(r.drops).toBe(0);
    });
});
