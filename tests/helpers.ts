import { World } from '../src/sim/world';
import { RoadType, ZoneType } from '../src/sim/defs';
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

