// 年齢層・出生・死亡と、斎場・霊園
import { describe, expect, it } from 'vitest';
import { defaultFuneral, DEFAULT_AGES, stepAges, updatePopulation, workersOf } from '../src/sim/population';
import type { Building } from '../src/sim/world';
import { World } from '../src/sim/world';
import { buildTestCity } from './helpers';

const home = (occ: number): Building => ({
  id: 1, civic: false, type: 'R1', x: 0, y: 0, w: 1, h: 1, face: 2, seed: 1, den: 0, cap: occ, occ, state: 1, stateDays: 0,
  powered: true, watered: true, floors: 1, commute: 10, employed: 1, badMonths: 0,
});
const civic = (type: 'cemetery' | 'crematorium', occ = 0): Building => ({ ...home(0), id: type === 'cemetery' ? 2 : 3, civic: true, type, occ });

describe('age groups', () => {
  it('a new neighbourhood is young and slowly ages over decades', () => {
    const b = home(1000);
    stepAges(b, 50);
    const young = b.ages![2];
    for (let m = 0; m < 12 * 40; m++) stepAges(b, 50);
    const sum = b.ages!.reduce((a, v) => a + v, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(b.ages![2]).toBeGreaterThan(young + 0.03); // 高齢化
    expect(b.ages![2]).toBeLessThan(0.35);
    expect(b.ages![0]).toBeGreaterThan(0.1);
  });

  it('old saves (no ages) keep the old worker count', () => {
    const b = home(1000);
    expect(workersOf(b)).toBeCloseTo(500, 6);
    b.ages = [0.1, 0.4, 0.5];
    expect(workersOf(b)).toBeLessThan(400);
    expect(DEFAULT_AGES.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 6);
  });

  it('better health means fewer deaths', () => {
    const a = home(10000), b = home(10000);
    a.ages = [0.2, 0.5, 0.3]; b.ages = [0.2, 0.5, 0.3]; a.aOcc = b.aOcc = 10000;
    expect(stepAges(a, 90).deaths).toBeLessThan(stepAges(b, 20).deaths);
  });
});

describe('funeral', () => {
  const town = (n: number) => Array.from({ length: n }, (_, k) => ({ ...home(1000), id: 100 + k, ages: [0.15, 0.5, 0.35] as [number, number, number], aOcc: 1000 }));
  it('no crematorium: the dead wait and shortage rises', () => {
    const f = defaultFuneral();
    const hs = town(10);
    for (let m = 0; m < 3; m++) updatePopulation(hs, f, 50, () => 1, 10000);
    expect(f.deaths).toBeGreaterThan(5);
    expect(f.waiting).toBeGreaterThan(f.deaths);
    expect(f.shortage).toBeGreaterThan(0.5);
  });
  it('crematorium and cemetery: no backlog, cemetery fills', () => {
    const f = defaultFuneral();
    const cem = civic('cemetery');
    const all = [...town(10), civic('crematorium'), cem];
    for (let m = 0; m < 12; m++) updatePopulation(all, f, 50, () => 1, 10000);
    expect(f.waiting).toBeLessThan(1);
    expect(f.shortage).toBeLessThan(0.05);
    expect(cem.occ).toBeGreaterThan(50);
    expect(f.graveFree).toBeCloseTo(3000 - cem.occ, 3);
  });
  it('a full cemetery makes ashes wait', () => {
    const f = defaultFuneral();
    const all = [...town(10), civic('crematorium'), civic('cemetery', 3000)];
    for (let m = 0; m < 4; m++) updatePopulation(all, f, 50, () => 1, 10000);
    expect(f.ashes).toBeGreaterThan(5);
    expect(f.shortage).toBeGreaterThan(0.3);
  });
  it('small towns are not punished', () => {
    const f = defaultFuneral();
    const hs = town(1);
    for (let m = 0; m < 6; m++) updatePopulation(hs, f, 50, () => 1, 1000);
    expect(f.shortage).toBeLessThan(0.2);
  });
});

describe('in the city', () => {
  it('runs with ages and saves/loads them', { timeout: 30000 }, () => {
    const w = World.create({ name: 't', seed: 12345, style: 'river', difficulty: 1, sandbox: false });
    buildTestCity(w);
    for (let d = 0; d < 360 * 2; d++) w.stepDay();
    const s = w.stats;
    const f = s.services.funeral;
    expect(f.ages[0] + f.ages[1] + f.ages[2]).toBeCloseTo(1, 4);
    expect(f.births).toBeGreaterThan(0);
    const homes = [...w.buildings.values()].filter((b) => b.type === 'R1' && b.state === 1);
    expect(homes.length).toBeGreaterThan(0);
    expect(homes.every((b) => b.ages && Math.abs(b.ages[0] + b.ages[1] + b.ages[2] - 1) < 1e-6)).toBe(true);
    const w2 = World.load(JSON.parse(JSON.stringify(w.serialize())));
    const b2 = w2.buildings.get(homes[0].id)!;
    expect(b2.ages).toEqual(homes[0].ages);
    expect(w2.stats.services.funeral.deaths).toBeCloseTo(f.deaths, 6);
  });
});
