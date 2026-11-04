// @ts-nocheck -- Node 専用の生成スクリプト
// 画像をもとに、だいたい同じ形の街を作って保存ファイルにする（MAKECITY=1 のときだけ動かす）
import { describe, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType, ZoneType, CivicId } from '../src/sim/defs';
import { gzipSync } from 'zlib';
import { writeFileSync } from 'fs';

const env = (globalThis as unknown as { process: { env: Record<string, string> } }).process.env;
const on = !!env.MAKECITY;

describe.skipIf(!on)('make city', () => {
  it('builds and grows', { timeout: 1800000 }, () => {
    const w = World.create({ name: env.CITYNAME || '湾岸市', seed: Number(env.SEED || 4242), style: 'coast', difficulty: 1, sandbox: false });
    const g = w.g, n = g.n;
    w.funds = 1e9;
    const log: string[] = [];
    const run = (c: Parameters<World['exec']>[0]) => {
      const r = w.exec(c);
      if (!r.ok) log.push(`${JSON.stringify(c)} → ${r.msg}`);
      return r.ok;
    };
    const used = new Uint8Array(n * n);
    // 水がなく平らで、まだ使っていない四角を探す（pref = 好みの中心）
    const find = (W: number, H: number, pref: [number, number], waterNear = false): [number, number] | null => {
      let best: [number, number] | null = null, bs = 1e9;
      for (let y = 3; y < n - H - 3; y += 2)
        for (let x = 3; x < n - W - 3; x += 2) {
          let bad = 0, lo = 1e9, hi = -1e9;
          for (let yy = y - 1; yy <= y + H; yy++)
            for (let xx = x - 1; xx <= x + W; xx++) {
              if (used[yy * n + xx] || g.isWater(xx, yy)) bad++;
              lo = Math.min(lo, g.cellMinH(xx, yy));
              hi = Math.max(hi, g.cellMaxH(xx, yy));
            }
          if (bad) continue;
          let sc = (hi - lo) * 3 + Math.hypot(x + W / 2 - pref[0], y + H / 2 - pref[1]);
          if (waterNear) {
            let wd = 99;
            for (let k = 1; k < 12 && wd === 99; k++) for (const [dx, dy] of [[-k, 0], [W + k, 0], [0, -k], [0, H + k]]) if (g.inb(x + dx, y + dy) && g.isWater(x + dx, y + dy)) wd = k;
            sc += wd * 4;
          }
          if (sc < bs) { bs = sc; best = [x, y]; }
        }
      if (best) for (let yy = best[1] - 1; yy <= best[1] + H; yy++) for (let xx = best[0] - 1; xx <= best[0] + W; xx++) if (g.inb(xx, yy)) used[yy * n + xx] = 1;
      return best;
    };
    // 格子の街区：step マスごとに道路、間にゾーン
    const district = (W: number, H: number, pref: [number, number], zoneOf: (bx: number, by: number) => [ZoneType, number], step = 6, main = RoadType.Road) => {
      const p = find(W, H, pref);
      if (!p) { log.push('no room ' + W + 'x' + H); return null; }
      const [x0, y0] = p;
      for (let k = 0; k <= H; k += step) run({ t: 'road', x0, y0: y0 + k, x1: x0 + W, y1: y0 + k, road: k === 0 || k >= H - step + 1 ? main : RoadType.Road });
      for (let k = 0; k <= W; k += step) run({ t: 'road', x0: x0 + k, y0, x1: x0 + k, y1: y0 + H, road: RoadType.Street });
      for (let by = 0; by + step <= H; by += step)
        for (let bx = 0; bx + step <= W; bx += step) {
          const [z, den] = zoneOf(bx / step, by / step);
          if (z) run({ t: 'zone', x0: x0 + bx + 1, y0: y0 + by + 1, x1: x0 + bx + step - 1, y1: y0 + by + step - 1, zone: z, den });
        }
      return { x0, y0, x1: x0 + W, y1: y0 + H, cx: x0 + (W >> 1), cy: y0 + (H >> 1) };
    };
    const connect = (a: { cx: number; cy: number; x0: number; y0: number }, b: { cx: number; cy: number; x0: number; y0: number }, road = RoadType.Road) => {
      // 左上の角どうしを L 字につなぐ
      run({ t: 'road', x0: a.x0, y0: a.y0, x1: b.x0, y1: a.y0, road });
      run({ t: 'road', x0: b.x0, y0: a.y0, x1: b.x0, y1: b.y0, road });
    };
    const plop = (id: CivicId, near: { x0: number; y0: number; x1: number; y1: number }) => {
      // 街区のまわりの道路沿いの空き地に置く
      for (let r = 1; r < 14; r++)
        for (const [x, y] of [[near.x1 + r, near.y0 + r], [near.x0 - r - 3, near.y1 - r], [near.x0 + r * 2, near.y1 + r], [near.x1 - r * 2, near.y0 - r - 3]]) {
          if (!g.inb(x, y)) continue;
          if (w.exec({ t: 'plop', id, x, y }).ok) {
            run({ t: 'road', x0: x - 1, y0: y - 3, x1: x - 1, y1: y + 4, road: RoadType.Street });
            return true;
          }
        }
      log.push('could not place ' + id);
      return false;
    };

    // ---- 地区 ----
    const c = n / 2;
    const downA = district(30, 24, [c + 18, c - 30], (bx, by) => [by % 2 ? ZoneType.R : ZoneType.C, 2], 6, RoadType.Avenue);
    const downB = district(30, 30, [c + 32, c + 4], (bx, by) => [(bx + by) % 3 === 0 ? ZoneType.C : ZoneType.R, 2], 6, RoadType.Avenue);
    const ind1 = district(24, 18, [c - 30, c - 12], () => [ZoneType.I, 1]);
    const ind2 = district(24, 18, [c - 8, c - 2], () => [ZoneType.I, 2]);
    const mid = district(18, 18, [c, c + 14], (bx) => [bx === 1 ? ZoneType.C : ZoneType.R, 1]);
    const sub = district(24, 18, [c + 4, c + 34], (bx, by) => [by === 0 && bx === 1 ? ZoneType.C : ZoneType.R, 0]);
    const ds = [downA, downB, ind1, ind2, mid, sub].filter(Boolean) as NonNullable<typeof downA>[];
    // 地区どうしをつなぐ
    for (let k = 1; k < ds.length; k++) connect(ds[k - 1], ds[k]);
    if (downA && downB) connect(downA, downB, RoadType.Avenue);
    // 隣の都市へ：いちばん近いマップの端まで道路
    for (const d of [downB, ind1, sub]) {
      if (!d) continue;
      const toE = n - 1 - d.x1, toS = n - 1 - d.y1, toW = d.x0, toN = d.y0;
      const m = Math.min(toE, toS, toW, toN);
      if (m === toE) run({ t: 'road', x0: d.x1, y0: d.cy, x1: n - 1, y1: d.cy, road: RoadType.Road });
      else if (m === toS) run({ t: 'road', x0: d.cx, y0: d.y1, x1: d.cx, y1: n - 1, road: RoadType.Road });
      else if (m === toW) run({ t: 'road', x0: d.x0, y0: d.cy, x1: 0, y1: d.cy, road: RoadType.Road });
      else run({ t: 'road', x0: d.cx, y0: d.y0, x1: d.cx, y1: 0, road: RoadType.Road });
    }
    // ---- 電力・水道・公共施設 ----
    for (const d of [ind1, ind2]) if (d) { plop('coal', d); plop('coal', d); }
    if (ind2) { plop('gas', ind2); plop('oil', ind2); }
    for (const d of ds) { plop('pump', d); plop('pump', d); }
    if (downB) { plop('pump', downB); plop('pump', downB); plop('tower', downB); }
    for (const d of ds) { plop('police_s', d); plop('fire_s', d); plop('clinic', d); }
    if (downA) { plop('hospital', downA); plop('police_l', downA); plop('school_h', downA); plop('library', downA); plop('park_l', downA); }
    if (downB) { plop('hospital', downB); plop('school_e', downB); plop('school_h', downB); plop('college', downB); plop('park_l', downB); plop('plaza', downB); }
    if (mid) { plop('school_e', mid); plop('park_s', mid); }
    if (sub) { plop('school_e', sub); plop('playground', sub); plop('greenway', sub); }
    if (ind1) { plop('landfill', ind1); plop('landfill', ind1); plop('incinerator', ind1); plop('recycling', ind1); }
    // 港（工業地区の近くの水辺）
    if (ind1) {
      let placed = false;
      for (let y = 4; y < n - 8 && !placed; y++)
        for (let x = 4; x < n - 8 && !placed; x++) {
          if (Math.hypot(x - ind1.cx, y - ind1.cy) > 45) continue;
          if (w.exec({ t: 'plop', id: 'seaport', x, y }).ok) {
            placed = true;
            run({ t: 'road', x0: x + 2, y0: y + 2, x1: ind1.x0, y1: y + 2, road: RoadType.Road });
            run({ t: 'road', x0: ind1.x0, y0: y + 2, x1: ind1.x0, y1: ind1.y0, road: RoadType.Road });
          }
        }
      if (!placed) log.push('no seaport');
    }
    // 鉄道：工業地区 → 中心 → 都心
    if (ind2 && downA && downB) {
      const L = (x0: number, y0: number, x1: number, y1: number) => run({ t: 'transit', x0, y0, x1, y1, kind: 'rail' });
      const ax = ind2.x1 + 2, ay = ind2.y0 - 3;
      L(ind1 ? ind1.x0 : ax - 30, ay, ax, ay);
      L(ax, ay, downA.x0 - 3, ay);
      L(downA.x0 - 3, ay, downA.x0 - 3, downB.y1);
    }
    // 道路をつなぎ直す（ゾーンと送電線）：送電は道路とゾーンでつながる
    console.log(log.slice(0, 40).join('\n'));
    // ---- 育てる ----
    w.funds = 120000;
    const target = Number(env.POP || 41000);
    for (let m = 0; m < 12 * 60; m++) {
      for (let d = 0; d < 30; d++) w.stepDay();
      if (w.funds < 20000) w.funds += 60000; // 足りなくなったら借りたことにする
      if (m % 12 === 0) console.log(`year ${m / 12}: pop=${w.stats.population} funds=${w.funds} rating=${w.stats.rating ?? ''} demand=${w.stats.demandRCI.map((v: number) => v.toFixed(2))}`);
      if (w.stats.population >= target) break;
    }
    w.funds = 175971;
    w.updateStats();
    console.log('final pop', w.stats.population, 'date day', w.day);
    // ---- 書き出し（ゲームの「ファイルに書き出す」と同じ形） ----
    const d = w.serialize() as unknown as Record<string, unknown>;
    const obj: Record<string, unknown> = { ...d, format: 'pocket-metro' };
    for (const k of ['heights', 'road', 'conn', 'flow', 'deck', 'up', 'conn1', 'flow1', 'upH', 'lift', 'ictl', 'isplit', 'iflags', 'pline', 'zone', 'zden', 'bldg', 'tree', 'rail', 'erail', 'mono', 'sub', 'bstop', 'congestion', 'traffic']) {
      const v = d[k] as ArrayBufferView | undefined;
      if (v) obj[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
    }
    writeFileSync(env.OUT || 'city.pmcity', gzipSync(JSON.stringify(obj)));
  });
});
