// 倉庫業（IL）：港・貨物駅の近くに集まり、すぐ近くでは大きな敷地（6×4 まで）にもなる
import { describe, expect, it } from 'vitest';
import { World, BState } from '../src/sim/world';
import { CivicId, DEFAULT_TAX, GROW, GrowKind, LOGI_REACH, logiReach, RoadType, ZoneType } from '../src/sim/defs';
import { campuses, portLevel, PORT_STEPS } from '../src/render/buildingLayer';
import { generateBuilding, setupLot } from '../src/render/buildingGen';
import { MeshBuilder } from '../src/render/builder';
import { LOGI } from '../src/render/logiRegistry';

// 東側が海（x >= 58 が水）の 64×64 のマップ。工業ゾーンの街区（6×6）と、海辺の道路（x = 49）
function harbor(port: 'seaport_l' | 'freight_st' | null) {
  const w = new World(64);
  const V = 65;
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= 59 ? -4 : 8;
  w.sandbox = true;
  const ok = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) throw new Error(`${c.t}: ${r.msg}`);
  };
  for (let y = 4; y <= 39; y += 7) ok({ t: 'road', x0: 2, y0: y, x1: 49, y1: y, road: RoadType.Road });
  for (const x of [2, 9, 16, 23, 30, 37, 44, 49]) ok({ t: 'road', x0: x, y0: 4, x1: x, y1: 39, road: RoadType.Street });
  ok({ t: 'zone', x0: 24, y0: 5, x1: 48, y1: 38, zone: ZoneType.I, den: 1 });
  ok({ t: 'plop', id: 'coal', x: 4, y: 41 });
  ok({ t: 'plop', id: 'pump', x: 10, y: 40 });
  ok({ t: 'plop', id: 'pump', x: 13, y: 40 });
  if (port === 'seaport_l') ok({ t: 'plop', id: 'seaport_l', x: 53, y: 20 });
  if (port === 'freight_st') {
    // 西の端まで続く線路と、線路と道路に接する貨物駅
    ok({ t: 'transit', x0: 0, y0: 46, x1: 40, y1: 46, kind: 'rail' });
    ok({ t: 'road', x0: 23, y0: 39, x1: 23, y1: 45, road: RoadType.Street });
    ok({ t: 'plop', id: 'freight_st', x: 21, y: 44 });
  }
  return w;
}

// 工業の種類ごとの需要を同じにして育てる（場所の好みだけを比べる）
function grow(w: World, days: number) {
  const kinds: GrowKind[] = ['ID', 'IM', 'IL', 'IH'];
  for (let d = 0; d < days; d++) {
    for (const k of kinds) w.demand[k] = 0.8;
    (w as unknown as { ilInland: number }).ilInland = 0.8; // 内陸の倉庫業の需要も同じにする
    w.stepDay();
  }
  return [...w.buildings.values()].filter((b) => !b.civic && GROW[b.type as GrowKind].zone === ZoneType.I);
}

describe('warehousing (IL)', () => {
  it('grows next to a container terminal, with some big lots there', () => {
    const w = harbor('seaport_l');
    const port = [...w.buildings.values()].find((b) => b.type === 'seaport_l')!;
    expect(port.w * port.h).toBe(96);
    const ind = grow(w, 240);
    const full = (b: { x: number; y: number; w: number; h: number }) => logiReach(port, b.x + b.w / 2, b.y + b.h / 2).full;
    const near = ind.filter(full);
    const il = near.filter((b) => b.type === 'IL');
    const big = ind.filter((b) => b.type === 'IL' && Math.max(b.w, b.h) > 4);
    console.log(`port: ${ind.length} industrial, ${near.length} near, IL near ${il.length}, big ${big.map((b) => `${b.w}x${b.h}`).join(' ')}`);
    expect(il.length).toBeGreaterThan(near.length * 0.3);
    expect(big.length).toBeGreaterThan(0);
    // 大きな敷地は、いちばん強い範囲（大型コンテナターミナルから 20 マス）の中だけ
    for (const b of big) expect(logiReach(port, b.x + 0.5, b.y + 0.5).full || logiReach(port, b.x + b.w - 0.5, b.y + b.h - 0.5).full).toBe(true);
    // ほかの工業も前と同じ大きさのまま
    for (const b of ind) if (b.type !== 'IL') expect(Math.max(b.w, b.h)).toBeLessThanOrEqual(4);
    // 1 マスあたりの雇用は製造業より少なく、汚染も少ない
    expect(GROW.IL.capPerCell).toBeLessThan(GROW.IM.capPerCell * 0.7);
    expect(GROW.IL.pollution).toBeLessThan(GROW.IM.pollution * 0.5);
  });

  it('is rare far from ports, and never on big lots there', () => {
    const w = harbor(null);
    const ind = grow(w, 240);
    const il = ind.filter((b) => b.type === 'IL');
    console.log(`inland: ${ind.length} industrial, IL ${il.length}`);
    expect(ind.length).toBeGreaterThan(20);
    expect(il.length).toBeLessThan(ind.length * 0.15);
    for (const b of ind) expect(Math.max(b.w, b.h)).toBeLessThanOrEqual(4);
  });

  it('ports and freight stations raise warehousing demand much more than factory demand', () => {
    const a = harbor(null), b = harbor('seaport_l'), c = harbor('freight_st');
    // 最初の月の需要（まだ何も建っていないうち）をくらべる
    for (let d = 0; d < 30; d++) { a.stepDay(); b.stepDay(); c.stepDay(); }
    const fs = [...c.buildings.values()].find((x) => x.type === 'freight_st')!;
    expect(fs.note).toContain('鉄道');
    console.log(`demand IL ${a.demand.IL.toFixed(2)} → port ${b.demand.IL.toFixed(2)} / freight ${c.demand.IL.toFixed(2)}, ID ${a.demand.ID.toFixed(2)} → ${b.demand.ID.toFixed(2)}, IM ${a.demand.IM.toFixed(2)} → ${b.demand.IM.toFixed(2)}`);
    expect(b.demand.IL - a.demand.IL).toBeGreaterThan(0.3);
    expect(b.demand.IL - a.demand.IL).toBeGreaterThan(b.demand.ID - a.demand.ID);
    expect(b.demand.IL - a.demand.IL).toBeGreaterThan(b.demand.IM - a.demand.IM);
    expect(c.demand.IL - a.demand.IL).toBeGreaterThan(0.2);
    expect(c.demand.ID).toBeCloseTo(a.demand.ID, 5); // 貨物駅は倉庫業の需要だけ上げる
  });

  it('grows next to a freight station too', () => {
    const w = harbor('freight_st');
    const fs = [...w.buildings.values()].find((b) => b.type === 'freight_st')!;
    const ind = grow(w, 240);
    const near = ind.filter((b) => logiReach(fs, b.x + b.w / 2, b.y + b.h / 2).v >= 0.5);
    const il = near.filter((b) => b.type === 'IL');
    console.log(`freight: ${near.length} near, IL ${il.length}`);
    expect(il.length).toBeGreaterThan(near.length * 0.3);
  });

  it('loads an old save without warehousing fields', () => {
    const w = harbor(null);
    grow(w, 120);
    const d = w.serialize();
    // 倉庫業を足す前の保存データ：税率と需要に IL がない
    const taxes = { ...d.taxes } as Partial<Record<GrowKind, number>>;
    const demand = { ...d.demand } as Partial<Record<GrowKind, number>>;
    delete taxes.IL;
    delete demand.IL;
    const old = { ...d, taxes, demand } as typeof d;
    const before = [...w.buildings.values()].map((b) => `${b.id}:${b.type}:${b.x},${b.y},${b.w}x${b.h}`).sort();
    const l = World.load(old);
    expect(l.taxes.IL).toBe(DEFAULT_TAX);
    expect(l.demand.IL).toBe(0);
    expect([...l.buildings.values()].map((b) => `${b.id}:${b.type}:${b.x},${b.y},${b.w}x${b.h}`).sort()).toEqual(before);
    for (let k = 0; k < 31; k++) l.stepDay();
    expect(Number.isFinite(l.stats.demand.IL)).toBe(true);
    expect(Number.isFinite(l.stats.demandRCI[2])).toBe(true);
    expect([...l.buildings.values()].some((b) => b.state === BState.Normal && (b.type === 'ID' || b.type === 'IM'))).toBe(true);
  });

  it('is drawn with the same near-port rules as the simulation', () => {
    // 描画の近さ（portLevel）は、シミュレーションと同じ施設・同じはかり方。形の近さが届く範囲は、建つ範囲より広くない
    const mk = (id: number, type: string, x: number, y: number, w: number, h: number, civic = false) =>
      ({ id, civic, type, x, y, w, h, face: 2, seed: id * 7919, den: 2, cap: 100, occ: 100, state: BState.Normal, stateDays: 0, powered: true, watered: true, floors: 1, commute: 0, employed: 1, badMonths: 0 }) as unknown as Parameters<typeof portLevel>[0];
    for (const id of Object.keys(LOGI_REACH) as CivicId[]) {
      const r = LOGI_REACH[id]!;
      expect(r.look[0]).toBe(r.grow[0]);
      expect(r.look[2]).toBeLessThanOrEqual(r.grow[2]);
      const p = mk(1, id, 40, 40, 4, 4, true);
      for (let d = 0; d <= r.grow[2] + 2; d += 2) {
        const b = mk(2, 'IL', 44 + d, 40, 2, 2);
        const grow = logiReach(p, b.x + b.w / 2, b.y + b.h / 2).v;
        if (portLevel(b, [p]) > 0) expect(grow).toBeGreaterThan(0);
      }
      // 大きな敷地が建つ範囲（full）の倉庫業は、いつも港の近くの形になる
      const big = mk(3, 'IL', 44 + r.grow[1] - 3, 40, 6, 4);
      expect(logiReach(p, big.x + 0.5, big.y + 0.5).full).toBe(true);
      expect(portLevel(big, [p])).toBeGreaterThan(0);
    }
    expect(portLevel(mk(4, 'IL', 10, 10, 2, 2), [mk(5, 'coal', 12, 10, 4, 4, true)])).toBe(0);
    expect(PORT_STEPS).toBeGreaterThan(0);
    // 連結は倉庫業だけ（製造業はつながない）。奥行き 5 マス以上の大きな敷地もつながない
    const list = [mk(10, 'IL', 1, 10, 6, 3), mk(11, 'IL', 7, 10, 6, 3), mk(12, 'IM', 20, 10, 3, 3), mk(13, 'IM', 23, 10, 3, 3), mk(14, 'IL', 1, 20, 4, 6), mk(15, 'IL', 5, 20, 4, 6)];
    const c = campuses(list, new Map(), true);
    expect(c.has(10) && c.has(11)).toBe(true);
    expect(c.has(12) || c.has(13) || c.has(14) || c.has(15)).toBe(false);
  });

  it('always looks like a warehouse, and factories never do', () => {
    let used = '';
    const keep = { ...LOGI };
    for (const k of Object.keys(LOGI)) LOGI[k] = (...a) => { used = k; keep[k](...a); };
    try {
      const draw = (type: string, w: number, h: number, seed: number, port: number) => {
        const mb = new MeshBuilder();
        const b = { id: 1, civic: false, type, x: 10, y: 10, w, h, face: seed % 2 ? 2 : 0, seed, den: 2, cap: 100, occ: 100, state: BState.Normal, stateDays: 0, powered: true, watered: true, floors: 1, commute: 0, employed: 1, badMonths: 0 } as Parameters<typeof generateBuilding>[1];
        const f = setupLot(mb, b, () => 0, () => 0);
        used = '';
        generateBuilding(mb, b, f, [], () => false, undefined, [], port);
        return used;
      };
      const sizes: [number, number][] = [[2, 2], [3, 2], [3, 3], [4, 4], ...[[5, 3], [6, 4], [4, 6], [3, 6]] as [number, number][]];
      for (const [w, h] of sizes) for (const port of [0, 0.5, 1]) for (let s = 1; s <= 4; s++) expect(draw('IL', w, h, s * 7919 + w * 31 + h, port)).not.toBe('');
      for (const t of ['IM', 'ID']) for (const port of [0, 1]) for (let s = 1; s <= 4; s++) expect(draw(t, 4, 4, s * 104729, port)).toBe('');
    } finally {
      Object.assign(LOGI, keep);
    }
  });
});
