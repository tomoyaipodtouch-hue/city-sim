import { World } from '../src/sim/world';
import { CivicId, GrowKind, RoadType, ZoneType } from '../src/sim/defs';
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

// 港町（128×128、東が海）：西に住宅・商業、東の港のそばに工業地区（工場・倉庫）、大型コンテナターミナルと港、
// 西の端から来る貨物鉄道と貨物駅、西の端から工業地区の北まで来る高架の都市高速（ランプ 2 か所）。
// 需要を強めて days 日育てる（最後の 240 日はふつうの需要）
export function portCity(days: number) {
  const n = 128, V = n + 1;
  const w = new World(n);
  w.sandbox = true;
  w.funds = 1e9;
  for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) w.g.heights[y * V + x] = x >= 120 ? -4 : 8;
  const run = (c: Parameters<World['exec']>[0]) => w.exec(c).ok;
  const tryPlace = (id: CivicId, x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (w.exec({ t: 'plop', id, x, y }).ok) return true;
    return false;
  };
  // 住宅・商業（西）。隣の都市へは西の端と南の端
  for (let y = 20; y <= 104; y += 6) run({ t: 'road', x0: 4, y0: y, x1: 56, y1: y, road: y === 62 ? RoadType.Avenue : RoadType.Road });
  for (let x = 4; x <= 56; x += 6) run({ t: 'road', x0: x, y0: 20, x1: x, y1: 104, road: x === 28 ? RoadType.Avenue : RoadType.Street });
  run({ t: 'road', x0: 0, y0: 62, x1: 4, y1: 62, road: RoadType.Avenue });
  run({ t: 'road', x0: 0, y0: 38, x1: 4, y1: 38, road: RoadType.Road });
  run({ t: 'road', x0: 16, y0: 104, x1: 16, y1: 127, road: RoadType.Road });
  run({ t: 'zone', x0: 5, y0: 21, x1: 55, y1: 55, zone: ZoneType.R, den: 2 });
  run({ t: 'zone', x0: 5, y0: 57, x1: 55, y1: 73, zone: ZoneType.C, den: 2 });
  run({ t: 'zone', x0: 5, y0: 75, x1: 55, y1: 103, zone: ZoneType.R, den: 2 });
  // 工業地区（東、港のそば）。横は一般道（真ん中は大通り）、縦は街路。高速道路のランプから南へ一般道（x = 80）が通る
  for (let y = 26; y <= 104; y += 6) run({ t: 'road', x0: 56, y0: y, x1: 106, y1: y, road: y === 62 ? RoadType.Avenue : RoadType.Road });
  for (let x = 62; x <= 104; x += 6) run({ t: 'road', x0: x, y0: 26, x1: x, y1: 104, road: x === 80 ? RoadType.Road : RoadType.Street });
  run({ t: 'zone', x0: 57, y0: 27, x1: 105, y1: 103, zone: ZoneType.I, den: 1 });
  tryPlace('seaport_l', 106, 120, 28, 50);
  run({ t: 'road', x0: 106, y0: 86, x1: 118, y1: 86, road: RoadType.Road });
  tryPlace('seaport', 106, 120, 76, 92);
  run({ t: 'transit', x0: 0, y0: 112, x1: 96, y1: 112, kind: 'rail' });
  run({ t: 'road', x0: 56, y0: 104, x1: 56, y1: 110, road: RoadType.Road });
  run({ t: 'road', x0: 56, y0: 109, x1: 100, y1: 109, road: RoadType.Road });
  run({ t: 'road', x0: 86, y0: 104, x1: 86, y1: 109, road: RoadType.Road });
  run({ t: 'plop', id: 'freight_st', x: 80, y: 110 });
  run({ t: 'road', x0: 0, y0: 10, x1: 100, y1: 10, road: RoadType.UrbanHighway });
  for (const x of [80, 34]) {
    const x1 = x === 80 ? 70 : 22, y1 = x === 80 ? 26 : 20;
    run({ t: 'road', x0: x, y0: 12, x1: x, y1: y1, road: RoadType.Road });
    run({ t: 'road', x0: x, y0: 2, x1: x, y1: 8, road: RoadType.Road });
    run({ t: 'road', x0: x, y0: 2, x1: x1, y1: 2, road: RoadType.Road });
    run({ t: 'road', x0: x1, y0: 2, x1: x1, y1: y1, road: RoadType.Road });
    run({ t: 'uramp', x, y: 11 });
    run({ t: 'uramp', x, y: 9 });
  }
  // 電気・水
  tryPlace('coal', 40, 60, 112, 124);
  run({ t: 'road', x0: 4, y0: 104, x1: 4, y1: 120, road: RoadType.Street });
  run({ t: 'road', x0: 4, y0: 120, x1: 60, y1: 120, road: RoadType.Street });
  tryPlace('nuclear', 20, 40, 122, 126);
  tryPlace('nuclear', 26, 60, 122, 126);
  for (let k = 0; k < 12; k++) tryPlace('pump', 5, 60, 121, 122);
  run({ t: 'pline', x0: 14, y0: 115, x1: 38, y1: 115 });
  run({ t: 'pline', x0: 30, y0: 119, x1: 30, y1: 116 });
  run({ t: 'pline', x0: 41, y0: 112, x1: 41, y1: 105 });
  run({ t: 'pline', x0: 43, y0: 115, x1: 60, y1: 115 });
  run({ t: 'pline', x0: 60, y0: 115, x1: 60, y1: 105 });
  const kinds: GrowKind[] = ['R1', 'R2', 'CS1', 'CS2', 'ID', 'IM', 'IL', 'IH'];
  for (let d = 0; d < days; d++) {
    if (d < days - 240) {
      for (const k of kinds) w.demand[k] = Math.max(w.demand[k], 0.8);
      (w as unknown as { ilInland: number }).ilInland = 0.8;
    }
    w.stepDay();
  }
  return w;
}
