import { World } from '../src/sim/world';
import { GrowKind, RoadType, ZoneType } from '../src/sim/defs';
// 水のない平らな場所を探す
export function findDryArea(w: World, size: number): [number, number] {
  const g = w.g;
  let best: [number, number] = [0, 0], bestScore = Infinity;
  for (let y = 4; y < g.n - size - 4; y += 4)
    for (let x = 4; x < g.n - size - 4; x += 4) {
      let water = 0, lo = Infinity, hi = -Infinity;
      for (let yy = y; yy < y + size; yy++)
        for (let xx = x; xx < x + size; xx++) {
          if (g.isWater(xx, yy)) water++;
          lo = Math.min(lo, g.cellMinH(xx, yy));
          hi = Math.max(hi, g.cellMaxH(xx, yy));
        }
      const score = water * 100 + (hi - lo);
      if (score < bestScore) { bestScore = score; best = [x, y]; }
    }
  return best;
}

export function buildTestCity(w: World) {
  const [ox, oy] = findDryArea(w, 40);
  const log: string[] = [];
  const run = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) log.push(`${c.t}: ${r.msg}`);
    return r;
  };
  // 格子状の道路
  for (let k = 0; k <= 40; k += 6) {
    run({ t: 'road', x0: ox, y0: oy + k, x1: ox + 40, y1: oy + k, road: RoadType.Road });
    run({ t: 'road', x0: ox + k, y0: oy, x1: ox + k, y1: oy + 40, road: RoadType.Street });
  }
  // 隣の都市への道路
  run({ t: 'road', x0: ox + 20, y0: oy + 40, x1: ox + 20, y1: w.g.n - 1, road: RoadType.Road });
  // ゾーン
  run({ t: 'zone', x0: ox + 1, y0: oy + 1, x1: ox + 23, y1: oy + 17, zone: ZoneType.R, den: 0 });
  run({ t: 'zone', x0: ox + 1, y0: oy + 19, x1: ox + 23, y1: oy + 23, zone: ZoneType.C, den: 0 });
  run({ t: 'zone', x0: ox + 25, y0: oy + 25, x1: ox + 39, y1: oy + 39, zone: ZoneType.I, den: 0 });
  run({ t: 'zone', x0: ox + 25, y0: oy + 1, x1: ox + 39, y1: oy + 17, zone: ZoneType.R, den: 0 });
  // 発電所と水道
  run({ t: 'plop', id: 'coal', x: ox + 32, y: oy + 20 });
  run({ t: 'plop', id: 'pump', x: ox + 1, y: oy + 26 });
  run({ t: 'pline', x0: ox + 30, y0: oy + 21, x1: ox + 4, y1: oy + 27 });
  return log;
}

// 住宅・商業・工業と隣の都市への道路がある街（工業地区は東、港を置ける海は東の端）
export function freightCity(port: 'seaport' | 'freight_st' | null) {
  const w = new World(80);
  const V = 81;
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= 75 ? -4 : 8;
  w.sandbox = true;
  w.funds = 1e9;
  const ok = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.msg}`);
  };
  // 格子：横は一般道（真ん中 y = 34 は大通り）、縦は街路。西の端へ大通りがつながる
  for (let y = 10; y <= 58; y += 6) ok({ t: 'road', x0: y === 34 ? 0 : 2, y0: y, x1: 68, y1: y, road: y === 34 ? RoadType.Avenue : RoadType.Road });
  for (let x = 2; x <= 68; x += 6) ok({ t: 'road', x0: x, y0: 10, x1: x, y1: 58, road: RoadType.Street });
  ok({ t: 'zone', x0: 3, y0: 11, x1: 43, y1: 57, zone: ZoneType.R, den: 2 });
  ok({ t: 'zone', x0: 45, y0: 11, x1: 49, y1: 57, zone: ZoneType.C, den: 1 });
  ok({ t: 'zone', x0: 51, y0: 11, x1: 67, y1: 57, zone: ZoneType.I, den: 1 });
  ok({ t: 'plop', id: 'nuclear', x: 10, y: 64 });
  ok({ t: 'road', x0: 2, y0: 58, x1: 2, y1: 70, road: RoadType.Road });
  ok({ t: 'road', x0: 2, y0: 70, x1: 30, y1: 70, road: RoadType.Road });
  for (let x = 16; x <= 28; x += 3) ok({ t: 'plop', id: 'pump', x, y: 68 });
  ok({ t: 'pline', x0: 13, y0: 64, x1: 13, y1: 59 });
  if (port) addPort(w, port);
  return w;
}
// 港（東の海）か、貨物駅（西の端まで続く線路の南の端）を置く
export function addPort(w: World, port: 'seaport' | 'freight_st') {
  const ok = (c: Parameters<World['exec']>[0]) => {
    const r = w.exec(c);
    if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.msg}`);
  };
  if (port === 'seaport') {
    ok({ t: 'road', x0: 68, y0: 40, x1: 73, y1: 40, road: RoadType.Road });
    ok({ t: 'plop', id: 'seaport', x: 71, y: 42 });
  } else {
    ok({ t: 'transit', x0: 0, y0: 76, x1: 60, y1: 76, kind: 'rail' });
    ok({ t: 'road', x0: 56, y0: 58, x1: 56, y1: 73, road: RoadType.Road });
    ok({ t: 'plop', id: 'freight_st', x: 56, y: 74 });
  }
}
export function growFreightCity(w: World, days: number) {
  const kinds: GrowKind[] = ['R1', 'R2', 'CS1', 'CS2', 'ID', 'IM', 'IL', 'IH'];
  for (let d = 0; d < days; d++) {
    if (d < days - 90) for (const k of kinds) w.demand[k] = Math.max(w.demand[k], 0.8);
    w.stepDay();
  }
}
