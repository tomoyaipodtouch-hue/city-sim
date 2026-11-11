// 貨物地区の車の流れ（carLayer を画面なしで動かす）：トラックとトレーラーの多い工業地区の格子（街路と一般道の交差点）で、
// 長い車両が交差点をふさいで、止まったまま動けなくなる車（消される車）が出ないか
import { describe, expect, it } from 'vitest';
import { World, Building } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { CarLayer } from '../src/render/carLayer';

// 画面のない環境：canvas は何もしないものにする（CarLayer の光の模様に使う）
const sink: any = new Proxy(function () {}, {
  get: (_t, k) => (k === 'width' || k === 'height' ? 32 : k === Symbol.toPrimitive ? () => 0 : k === 'toString' || k === 'valueOf' ? () => '' : sink),
  apply: () => sink,
  set: () => true,
});
(globalThis as any).document ??= { createElement: () => sink };

// 決まった乱数（毎回同じ動きにする）
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(seed: number) {
  const w = new World(72);
  w.g.heights.fill(10);
  w.funds = 1e9;
  // 工業地区の格子：横は一般道（真ん中は大通り）、縦は街路。6 マスごと
  for (let y = 6; y <= 60; y += 6) w.exec({ t: 'road', x0: 6, y0: y, x1: 60, y1: y, road: y === 36 ? RoadType.Avenue : RoadType.Road });
  for (let x = 6; x <= 60; x += 6) w.exec({ t: 'road', x0: x, y0: 6, x1: x, y1: 60, road: RoadType.Street });
  const g = w.g, n = g.n, N = n * n;
  // 混んだ貨物地区の交通量：一般道・大通りは容量の 6〜7 割、街路は 5 割。そのうち貨物（乗用車換算）は 4 割
  const tr = new Float32Array(2 * N), fr = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    const t = g.road[i];
    if (!t) continue;
    tr[i] = (t === RoadType.Street ? 450 : t === RoadType.Avenue ? 2400 : 1600) * Number((globalThis as any).process?.env?.FF_SCALE ?? 1);
    fr[i] = tr[i] * 0.4;
  }
  // 倉庫（トレーラーはまわりから多く出てくる）
  const lots = [[13, 13], [31, 25], [43, 43], [19, 49]].map(([x, y], k) => ({ id: k + 1, type: 'IL', civic: false, x, y, w: 4, h: 4 }) as unknown as Building);
  const L = new CarLayer();
  L.setLogistics(lots);
  const rnd = Math.random;
  Math.random = seeded(seed);
  try {
    L.setData(g, tr, new Float32Array(2 * N).fill(1), fr);
    for (let k = 0; k < 600; k++) L.update(1 / 10); // 60 秒ならす
    const d0 = L.drops;
    let moving = 0, total = 0;
    const trucks = (L as any).trucks as { cars: { v?: number }[]; trailer: unknown }[];
    for (let k = 0; k < 1800; k++) {
      L.update(1 / 10); // 180 秒
      if (k % 10) continue;
      for (const f of [...(L as any).cars, ...trucks]) for (const c of f.cars) { total++; if ((c.v ?? 0) > 0.5) moving++; }
    }
    return { drops: L.drops - d0, moving: moving / total, trailers: trucks[1].cars.length + trucks[2].cars.length, trucks: trucks[0].cars.length, cars: (L as any).cars.reduce((a: number, f: { cars: unknown[] }) => a + f.cars.length, 0) };
  } finally {
    Math.random = rnd;
  }
}

describe('freight district traffic flows (headless car layer)', () => {
  for (const seed of [1, 2])
    it(`trucks and trailers pass the junctions without being removed as stuck (seed ${seed})`, { timeout: 240000 }, () => {
      const r = run(seed);
      console.log(`seed ${seed}:`, r);
      expect(r.trailers).toBeGreaterThan(15);
      expect(r.trucks).toBeGreaterThan(60);
      // 止まったまま動けずに消された車は、3 分でほとんどない（以前はトレーラーの荷台が交差点に残り、横切る向きの車が入れずに、列ごと消されていた）
      expect(r.drops).toBeLessThanOrEqual(3);
      expect(r.moving).toBeGreaterThan(0.7);
    });
});
