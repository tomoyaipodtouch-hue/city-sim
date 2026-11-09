// CIQ庁舎：半径 20 マスの工業ゾーンは倉庫業（IL）だけになり、大きな敷地も建つ。範囲の中の工場は少しずつ倉庫業に建て替わる
import { describe, expect, it } from 'vitest';
import { World, BState, type Building } from '../src/sim/world';
import { CIQ_RADIUS, CIVIC, GROW, GrowKind, RoadType, ZoneType } from '../src/sim/defs';

// 平らな 96×96 のマップ。7 マスごとの道路の格子。CIQ庁舎（44, 44 の 4×3）のまわりと、遠い東の端に工業ゾーン
const CX = 44, CY = 44;
function town(ciq: boolean) {
  const w = new World(96);
  w.g.heights.fill(8);
  w.sandbox = true;
  const ok = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) throw new Error(`${c.t}: ${r.msg}`);
  };
  for (let y = 2; y <= 93; y += 7) ok({ t: 'road', x0: 2, y0: y, x1: 93, y1: y, road: RoadType.Road });
  for (let x = 2; x <= 93; x += 7) ok({ t: 'road', x0: x, y0: 2, x1: x, y1: 93, road: RoadType.Street });
  // 内側：CIQ庁舎のまわり（x, y = 24..69）。外側：東の端（x = 79..92。庁舎から 30 マス以上）
  ok({ t: 'zone', x0: 24, y0: 24, x1: 69, y1: 69, zone: ZoneType.I, den: 1 });
  ok({ t: 'zone', x0: 79, y0: 3, x1: 92, y1: 92, zone: ZoneType.I, den: 1 });
  ok({ t: 'plop', id: 'nuclear', x: 5, y: 5 });
  ok({ t: 'plop', id: 'nuclear', x: 5, y: 12 });
  for (const [x, y] of [[3, 24], [3, 45], [3, 66], [3, 87], [73, 3], [73, 87]]) ok({ t: 'plop', id: 'pump', x, y });
  if (ciq) placeCiq(w);
  return w;
}
function placeCiq(w: World) {
  // 区画（ゾーン）の中に置く。道路にはさまれた 6×6 の区画（x 45..50, y 45..50）
  w.exec({ t: 'bulldoze', x0: 45, y0: 45, x1: 50, y1: 50 });
  const r = w.exec({ t: 'plop', id: 'ciq', x: 47, y: 47 });
  if (!r.ok) throw new Error(`plop ciq: ${r.msg}`);
  return [...w.buildings.values()].find((b) => b.type === 'ciq')!;
}
// 施設の四角からの距離（defs と同じはかり方。敷地の中心で）
function dist(p: Building, b: Building) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return Math.hypot(Math.max(p.x - cx, 0, cx - (p.x + p.w)), Math.max(p.y - cy, 0, cy - (p.y + p.h)));
}
const industry = (w: World) => [...w.buildings.values()].filter((b) => !b.civic && GROW[b.type as GrowKind].zone === ZoneType.I);
// 工業の種類ごとの需要を固定して進める。住人がいない街なので、働く人が足りなくても空き家にはしない
function run(w: World, days: number, dem: Partial<Record<GrowKind, number>>) {
  for (let d = 0; d < days; d++) {
    for (const [k, v] of Object.entries(dem)) w.demand[k as GrowKind] = v;
    for (const b of w.buildings.values()) b.badMonths = 0;
    (w as unknown as { ilInland: number }).ilInland = dem.IL ?? 0;
    w.stepDay();
  }
}
const jobs = (bs: Building[]) => bs.reduce((s, b) => s + b.cap, 0);

describe('CIQ office', { timeout: 60000 }, () => {
  it('is a 4x3 civic with cost and upkeep like other civics', () => {
    const d = CIVIC.ciq;
    expect([d.w, d.h]).toEqual([4, 3]);
    expect(d.cost).toBe(20000);
    expect(d.upkeep).toBe(200);
    expect(d.waterfront).toBeFalsy();
    expect(d.desc).toContain('半径20マス');
    expect(CIQ_RADIUS).toBe(20);
  });

  it('turns industrial zoning within 20 cells into warehousing, with big lots', () => {
    const w = town(true);
    const p = [...w.buildings.values()].find((b) => b.type === 'ciq')!;
    expect(p.x).toBeGreaterThan(CX - 4);
    expect(p.y).toBeGreaterThan(CY - 4);
    run(w, 300, { ID: 0.8, IM: 0.8, IL: 0.8, IH: 0.8 });
    const ind = industry(w);
    const inR = ind.filter((b) => dist(p, b) <= CIQ_RADIUS);
    const outR = ind.filter((b) => dist(p, b) > 28);
    const ilIn = inR.filter((b) => b.type === 'IL');
    const big = ilIn.filter((b) => Math.max(b.w, b.h) > 4);
    const share = jobs(ilIn) / Math.max(1, jobs(inR));
    const outIL = jobs(outR.filter((b) => b.type === 'IL')) / Math.max(1, jobs(outR));
    console.log(`ciq: in ${inR.length} (IL ${ilIn.length}, share ${(share * 100).toFixed(1)}%, big ${big.map((b) => `${b.w}x${b.h}`).join(' ')}), out ${outR.length} (IL ${(outIL * 100).toFixed(1)}%: ${[...new Set(outR.map((b) => b.type))].join(',')})`);
    expect(inR.length).toBeGreaterThan(30);
    expect(share).toBeGreaterThanOrEqual(0.85);
    expect(big.length).toBeGreaterThan(0);
    // 外側は今までどおり（いろいろな工業が建ち、倉庫業ばかりにはならない）
    expect(outR.length).toBeGreaterThan(20);
    expect(new Set(outR.map((b) => b.type)).size).toBeGreaterThanOrEqual(3);
    expect(outIL).toBeLessThan(0.5);
    for (const b of outR) expect(Math.max(b.w, b.h)).toBeLessThanOrEqual(4);
  });

  it('keeps filling with warehousing when there is no demand', () => {
    const w = town(true);
    const p = [...w.buildings.values()].find((b) => b.type === 'ciq')!;
    run(w, 300, { ID: -0.5, IM: -0.5, IL: -0.5, IH: -0.5 });
    const ind = industry(w);
    const inR = ind.filter((b) => dist(p, b) <= CIQ_RADIUS);
    // 範囲の中で、2×2 の敷地が入る空き地（工業ゾーン）がほとんど残っていない（残るのは 1 マス幅のすき間だけ）
    const g = w.g, n = g.n;
    const free = (x: number, y: number) => { const i = g.idx(x, y); return g.zone[i] === ZoneType.I && !g.road[i] && !g.bldg[i]; };
    let zoned = 0, holes = 0;
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++) {
        const d = Math.hypot(Math.max(p.x - x - 1, 0, x + 1 - (p.x + p.w)), Math.max(p.y - y - 1, 0, y + 1 - (p.y + p.h)));
        if (d > CIQ_RADIUS - 2) continue;
        if (g.zone[g.idx(x, y)] === ZoneType.I && !g.road[g.idx(x, y)]) zoned++;
        if (free(x, y) && free(x + 1, y) && free(x, y + 1) && free(x + 1, y + 1)) holes++;
      }
    console.log(`no demand: in ${inR.length}, outside ${ind.length - inR.length}, 2x2 holes ${holes} / ${zoned} zoned cells`);
    expect(inR.every((b) => b.type === 'IL')).toBe(true);
    expect(inR.length).toBeGreaterThan(30);
    expect(holes).toBeLessThan(zoned * 0.02);
    // 範囲のすぐ外（敷地の中心が範囲の外でも、範囲の中のマスから建てた敷地）より遠くには、需要がないので建たない
    expect(ind.filter((b) => dist(p, b) > CIQ_RADIUS + 2).length).toBe(0);
  });

  it('redevelops old factories in the radius into warehousing over a few years', () => {
    const w = town(false);
    // まず製造業だけで埋める
    run(w, 300, { ID: -1, IM: 0.9, IL: -1, IH: -1 });
    const before = industry(w).filter((b) => b.state === BState.Normal);
    expect(before.filter((b) => b.type === 'IM').length).toBeGreaterThan(40);
    const p = placeCiq(w);
    const inside = () => industry(w).filter((b) => dist(p, b) <= CIQ_RADIUS && b.type !== 'IL').length;
    const out0 = industry(w).filter((b) => dist(p, b) > 28 && b.type === 'IM').length;
    const start = inside();
    run(w, 60, { ID: -1, IM: 0.2, IL: -1, IH: -1 });
    const after2m = inside();
    const counts: number[] = [];
    for (let y = 0; y < 4; y++) {
      run(w, 360, { ID: -1, IM: 0.2, IL: -1, IH: -1 });
      counts.push(inside());
    }
    const out1 = industry(w).filter((b) => dist(p, b) > 28 && b.type === 'IM').length;
    console.log(`redevelop: factories in radius ${start} → 2 months ${after2m} → years ${counts.join(' → ')}; outside IM ${out0} → ${out1}`);
    expect(start).toBeGreaterThan(20);
    // いっぺんには建て替わらない
    expect(after2m).toBeGreaterThan(start * 0.8);
    // 3 年でほとんど建て替わる
    expect(counts[2]).toBeLessThan(start * 0.25);
    expect(counts[3]).toBeLessThanOrEqual(counts[2]);
    // 外側の工場はそのまま
    expect(out1).toBeGreaterThanOrEqual(out0 * 0.9);
  });

  it('saves and loads with the CIQ office', () => {
    const w = town(true);
    run(w, 30, { ID: 0.5, IM: 0.5, IL: 0.5, IH: 0.5 });
    const json = structuredClone(w.serialize());
    const l = World.load(json);
    const key = (x: World) => [...x.buildings.values()].map((b) => `${b.id}:${b.type}:${b.x},${b.y},${b.w}x${b.h}:${b.face}`).sort();
    expect(key(l)).toEqual(key(w));
    const p = [...l.buildings.values()].find((b) => b.type === 'ciq')!;
    expect(p.civic).toBe(true);
    // 読み込んだあとも範囲の中は倉庫業だけ
    const n0 = industry(l).length;
    run(l, 120, { ID: 0.5, IM: 0.5, IL: 0.5, IH: 0.5 });
    const newIn = industry(l).filter((b) => b.id > Math.max(...key(w).map((s) => Number(s.split(':')[0]))) && dist(p, b) <= CIQ_RADIUS);
    console.log(`after load: ${n0} → ${industry(l).length}, new in radius ${newIn.length}`);
    expect(newIn.length).toBeGreaterThan(0);
    expect(newIn.every((b) => b.type === 'IL')).toBe(true);
    expect(Number.isFinite(l.stats.demand.IL)).toBe(true);
  });
});
