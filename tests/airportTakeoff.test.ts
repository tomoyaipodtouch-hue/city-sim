// 離陸と着陸の姿：滑走路の手前の端から滑走し、滑走路の半分ほどで浮いて、奥の端は十分な高さで越える。
// 着陸は目標点の標識のあたり（滑走路の 1〜3 割）で接地し、滑走路の端を越えずに出口へ
import { describe, expect, it } from 'vitest';
import { airportLayout, type AirportSize } from '../src/sim/airport';
import { AirOps, clearPitch, moveV, type Ac } from '../src/render/airport/ops';
import { AC, type AcType } from '../src/render/airport/aircraft';

const SIZES = [
  { size: 1, out: 2500, flights: 25, cargo: 4, seed: 12345, light: ['atr', 'a220'], heavy: ['e190'] },
  { size: 2, out: 2600, flights: 60, cargo: 8, seed: 4242, light: ['a220', 'e190'], heavy: ['b787'] },
  { size: 3, out: 3000, flights: 111, cargo: 16, seed: 31, light: ['a220', 'e190'], heavy: ['b777', 'a350'] },
] as const;

// 離陸滑走をはじめた飛行機を 1 機だけ置いて、浮くまで・奥の端を越えるまでを見る
function flyTakeoff(size: AirportSize, out: number, type: AcType, dir: number) {
  const L = airportLayout(size), rw = L.runways[L.runways.length - 1], len = rw.a1 - rw.a0;
  const ops = new AirOps(L, { pos: out, neg: out }, 1);
  const K = ops.takeoffPlan(type, dir);
  const ac = { id: 1, type, livery: 0, cargo: false, stand: 0, dir, phase: 'takeoff', move: K.move, t: 0, T: 0, exit: -1, plan: null, queue: 0, res: [], a: 0, c: 0, y: 0, ha: 0, hc: 1, pitch: 0, rev: false, lights: true, moving: false, tk: K } as Ac;
  ops.aircraft.push(ac);
  const thr = dir > 0 ? rw.a0 : rw.a1, far = dir > 0 ? rw.a1 : rw.a0;
  const start = (K.move.path.a[0] - thr) * dir;
  let lof = NaN, yFar = NaN, maxGround = 0, pitch3 = NaN, maxPitch = 0, prevV = 0, maxAcc = 0, accEarly = 0, accLate = 0;
  for (let t = 0; t < 200 && ac.phase === 'takeoff'; t += 0.05) {
    ops.update(0.05, 0.5);
    const d = (ac.a - thr) * dir;
    if (ac.y === 0) maxGround = Math.max(maxGround, ac.pitch);
    else if (Number.isNaN(lof)) lof = d;
    if (Number.isNaN(pitch3) && ac.y >= 3) pitch3 = ac.pitch;
    maxPitch = Math.max(maxPitch, ac.pitch);
    if (Number.isNaN(yFar) && (ac.a - far) * dir >= 0) yFar = ac.y;
    const v = moveV(K.move, ac.t), acc = (v - prevV) / 0.05;
    if (t > 0.1) maxAcc = Math.max(maxAcc, acc);
    if (Number.isNaN(lof) && v < K.vr * 0.4) accEarly = acc;
    if (Number.isNaN(lof) && v > K.vr * 0.8 && v < K.vr) accLate = acc;
    prevV = v;
  }
  return { len, start, lof, yFar, maxGround, pitch3, maxPitch, maxAcc, accEarly, accLate, clear: clearPitch(type, 0) };
}

describe('take-off on the shortened runways', () => {
  for (const S of SIZES) {
    for (const type of [...S.light, ...S.heavy] as AcType[]) {
      it(`size ${S.size} ${type}: lines up at the threshold, lifts off mid-runway and climbs over the far end`, () => {
        const res: Record<number, number> = {};
        for (const dir of [1, -1]) {
          const r = flyTakeoff(S.size, S.out, type, dir);
          // 滑走路の手前の端（尾が端のすぐ内側）から
          expect(r.start).toBeLessThan(45);
          // 浮く位置：滑走をはじめたところから、滑走路の長さの 4〜7.5 割（端から数えても 7 割より手前）
          expect((r.lof - r.start) / r.len).toBeGreaterThan(0.4);
          expect((r.lof - r.start) / r.len).toBeLessThan(0.75);
          expect(r.lof / r.len).toBeLessThan(0.7);
          // 奥の端を 15m 以上の高さで越える
          expect(r.yFar).toBeGreaterThan(15);
          // 加速：はじめが強く、速くなると弱い。0.4g を超えない
          expect(r.accEarly).toBeGreaterThan(r.accLate);
          expect(r.maxAcc).toBeLessThan(4);
          // 地上で機首を上げはじめ（胴体の後ろは地面にふれない）、浮いてすぐは 8〜11°、上昇中も 15° まで
          expect(r.maxGround).toBeGreaterThan(0.03);
          expect(r.maxGround).toBeLessThanOrEqual(r.clear + 1e-6);
          expect(r.pitch3).toBeGreaterThan(0.13);
          expect(r.pitch3).toBeLessThan(0.2);
          expect(r.maxPitch).toBeLessThan(0.27);
          res[dir] = r.lof / r.len;
        }
        expect(Math.abs(res[1] - res[-1])).toBeLessThan(0.02);
      });
    }
    it(`size ${S.size}: light types lift off before the heavier ones`, () => {
      const f = (t: AcType) => flyTakeoff(S.size, S.out, t, 1).lof;
      const light = Math.max(...(S.light as readonly AcType[]).map(f)), heavy = Math.min(...(S.heavy as readonly AcType[]).map(f));
      if (S.size === 1) expect(f('atr')).toBeLessThan(heavy);
      else expect(light).toBeLessThan(heavy);
    });
  }
});

describe('landing on the shortened runways', () => {
  for (const S of SIZES) {
    it(`size ${S.size}: touches down at the aiming point, flares, de-rotates and never overruns`, () => {
      const L = airportLayout(S.size), rw = L.runways[0], len = rw.a1 - rw.a0;
      const ops = new AirOps(L, { pos: S.out, neg: S.out }, S.seed);
      ops.open = true;
      ops.flights = S.flights;
      ops.cargoFlights = S.cargo;
      ops.seed();
      const st = new Map<Ac, { phase: string; y: number; pitch: number; maxD: number; v1: number }>();
      const seen = new Set<string>();
      let landings = 0, takeoffs = 0;
      for (let t = 0; t < 5400; t += 0.1) {
        ops.update(0.1, 0.5);
        for (const ac of ops.aircraft) {
          const p = st.get(ac);
          const thr = ac.dir > 0 ? rw.a0 : rw.a1, d = (ac.a - thr) * ac.dir;
          if (p && p.phase === 'approach' && ac.phase === 'rollout') {
            // 接地：目標点の標識のあたり（滑走路の 1〜3 割）。その手前では浮いていて、機首を上げている（フレア）
            landings++;
            seen.add(ac.type);
            expect(d / len).toBeGreaterThan(0.1);
            expect(d / len).toBeLessThan(0.3);
            expect(p.y).toBeGreaterThan(0);
            expect(p.y).toBeLessThan(1.5);
            expect(p.pitch).toBeGreaterThan(0.03);
            // 減速度は機材のふつうの値（0.35g まで）
            expect(ac.move!.dec).toBeLessThan(3.5);
          }
          if (ac.phase === 'rollout') {
            expect(ac.y).toBe(0);
            // 機首が滑走路の奥の端を越えない
            expect(d + AC[ac.type].len / 2).toBeLessThan(len);
            // 接地して 4 秒たったら前輪も下りている
            if (ac.t > 4) expect(ac.pitch).toBe(0);
          }
          if (p && p.phase === 'rollout' && ac.phase !== 'rollout') {
            // 出口の速さまで落としてから曲がる
            expect(p.v1).toBeLessThanOrEqual(rw.exits[ac.exit].speed + 0.5);
          }
          if (p && p.phase !== 'takeoff' && ac.phase === 'takeoff') takeoffs++;
          st.set(ac, { phase: ac.phase, y: ac.y, pitch: ac.pitch, maxD: d, v1: ac.move ? moveV(ac.move, ac.t) : 0 });
        }
      }
      expect(landings).toBeGreaterThan(10);
      expect(takeoffs).toBeGreaterThan(10);
      expect([...S.light].some((t) => seen.has(t))).toBe(true);
      expect([...S.heavy].some((t) => seen.has(t))).toBe(true);
    });
  }
});
