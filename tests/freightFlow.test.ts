// 貨物地区の車の流れ（carLayer を画面なしで動かす）：港のそばの、トラックとトレーラーの多い工業地区の格子（街路と一般道の交差点）で、
// 長い車両が交差点をふさいで、止まったまま動けなくなる車（消される車）が出ないか
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { CarLayer } from '../src/render/carLayer';
import { portCity } from './helpers';

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

// 港のそばの工業地区（倉庫・工場）のある港町をシミュレーションで育て、その交通量で車を走らせる
let grown: World | null = null;
function city() {
  if (!grown) {
    grown = portCity(1800);
    for (let d = 0; d < 150; d++) grown.stepDay();
  }
  return grown;
}

const MEASURE = 150; // 測る秒数

function run(seed: number) {
  const w = city(), g = w.g, n = g.n, N = n * n, M = w.maps;
  const ind = (node: number) => { const c = node % N, x = c % n, y = (c / n) | 0; return x >= 56 && y >= 20 && y <= 111; }; // 工業地区
  const L = new CarLayer();
  L.jctl = M.jctl;
  L.setLogistics([...w.buildings.values()]);
  const rnd = Math.random;
  Math.random = seeded(seed);
  try {
    L.setData(g, M.traffic, M.congestion, M.freight, M.riders, M.garbage, M.garbageLeft);
    const fleets = [...(L as any).cars, ...(L as any).trucks] as { cars: { v?: number; from: number; wait?: number; rw?: number; lim?: unknown }[]; trailer: unknown }[];
    for (let k = 0; k < 600; k++) L.update(1 / 10); // 60 秒ならす
    let moving = 0, total = 0, drops = 0, trailers = 0, trucks = 0, all = 0;
    for (let k = 0; k < MEASURE * 10; k++) {
      // MEASURE 秒：工業地区で、止まったまま動けずに消された車（30 秒以上待っていた・交差点の手前で 40 秒以上待っていた・待ち合いの輪）を数える
      // （待っていた秒数と前の車は、消される前の値で見る。マップの端から出ていく車・行き止まりで消える車は数えない）
      const before = new Map(fleets.flatMap((f) => f.cars.map((c) => [c, [c.wait ?? 0, c.rw ?? 0, c.lim ? 1 : 0]] as const)));
      const d0 = L.drops;
      L.update(1 / 10);
      if (L.drops > d0) {
        const after = new Set(fleets.flatMap((f) => f.cars));
        for (const [c, [wt, rw, lim]] of before) if (!after.has(c) && ind(c.from) && (wt > 29.5 || rw > 39.5 || (lim && wt + rw >= 6))) drops++;
      }
      if (k % 10) continue;
      fleets.forEach((f, i) => {
        for (const c of f.cars) {
          if (!ind(c.from)) continue;
          total++;
          if ((c.v ?? 0) > 0.5) moving++;
          if (f.trailer) trailers++;
          else if (i >= fleets.length - 3) trucks++;
        }
      });
      all++;
    }
    return { drops, allDrops: L.drops, moving: moving / total, vehicles: Math.round(total / all), trailers: Math.round(trailers / all), trucks: Math.round(trucks / all) };
  } finally {
    Math.random = rnd;
  }
}

describe('freight district traffic flows (headless car layer)', () => {
  it('trucks and trailers pass the junctions without being removed as stuck', { timeout: 600000 }, () => {
    const rs = [1, 2, 3].map(run);
    for (const [k, r] of rs.entries()) console.log(`seed ${k + 1}:`, r);
    const mean = (f: (r: (typeof rs)[0]) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    const dropsPerMin = mean((r) => r.drops) / (MEASURE / 60), moving = mean((r) => r.moving);
    console.log(`industrial district: ${dropsPerMin.toFixed(1)} stuck removals/min, ${(moving * 100).toFixed(0)}% moving`);
    for (const r of rs) {
      expect(r.trailers).toBeGreaterThan(10);
      expect(r.trucks).toBeGreaterThan(40);
    }
    // 止まったまま動けずに消される車は少なく、多くの車が動いている
    // （以前はトレーラーの荷台が交差点に残って横切る向きの車が入れず、出口の先がふさがった車にゆずって待ち続け、列ごと消されていた。
    // トラックも交通量の多い街路へ入っていった。この街で 1 分に約 8 台、動いている車は 66%。直したあとは約 4 台、71%）
    expect(dropsPerMin).toBeLessThan(6.5);
    expect(moving).toBeGreaterThan(0.68);
  });
});
