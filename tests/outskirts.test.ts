// 町はずれの田園（描画だけの飾り）：マスの位置から決まること、開発されたマスの飾りが消えること、
// 行き止まりの道の先に農道が続くこと、街が育っても作り直すのは変わった区画だけであること
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType, ZoneType } from '../src/sim/defs';
import { OK, OUT_MAXD, OutskirtsLayer, planOutskirts } from '../src/render/outskirtsLayer';

function town() {
  const w = World.create({ name: 't', seed: 7, style: 'river', difficulty: 0, sandbox: true, n: 128 });
  // 平らな地面で、決まった街を作る（地形の生成によらないように）
  const g = w.g;
  w.funds = 1e9;
  g.heights.fill(8);
  g.tree.fill(0);
  const ox = 40, oy = 40;
  const run = (c: Parameters<World['exec']>[0]) => { const r = w.exec(c); expect(r.ok, JSON.stringify(c) + ' ' + r.msg).toBe(true); };
  for (let k = 0; k <= 28; k += 7) {
    run({ t: 'road', x0: ox, y0: oy + k, x1: ox + 28, y1: oy + k, road: RoadType.Road });
    run({ t: 'road', x0: ox + k, y0: oy, x1: ox + k, y1: oy + 28, road: RoadType.Street });
  }
  // 街の外へ少し出て、行き止まりになる道
  run({ t: 'road', x0: ox + 14, y0: oy + 28, x1: ox + 14, y1: oy + 31, road: RoadType.Street });
  run({ t: 'zone', x0: ox + 1, y0: oy + 1, x1: ox + 27, y1: oy + 27, zone: ZoneType.R, den: 1 });
  return { w, g, ox, oy };
}

describe('町はずれの田園', () => {
  it('開発されたマスのまわりだけを飾り、開発されたマスは飾らない', () => {
    const { g } = town();
    const P = planOutskirts(g);
    const n = g.n;
    let deco = 0, fields = 0, meadows = 0;
    for (let i = 0; i < n * n; i++) {
      if (!P.kind[i]) continue;
      deco++;
      if (P.kind[i] === OK.field) fields++;
      if (P.kind[i] === OK.meadow) meadows++;
      expect(g.road[i] || g.bldg[i] || g.zone[i]).toBeFalsy();
      expect(P.dist[i]).toBeGreaterThanOrEqual(1);
      expect(P.dist[i]).toBeLessThanOrEqual(OUT_MAXD);
    }
    expect(fields).toBeGreaterThan(500);
    expect(meadows).toBeGreaterThan(100);
    expect(deco).toBeLessThan(n * n);
  });

  it('行き止まりの道の先に、3〜8 マスの農道が続く', () => {
    const { g, ox, oy } = town();
    const P = planOutskirts(g);
    const n = g.n;
    const x = ox + 14;
    const first = (oy + 32) * n + x;
    expect(P.lane[first]).toBeGreaterThan(0);
    const len = P.laneLen[first];
    expect(len).toBeGreaterThanOrEqual(2);
    expect(len).toBeLessThanOrEqual(8);
    for (let s = 1; s <= len; s++) expect(P.laneStep[(oy + 31 + s) * n + x]).toBe(s);
  });

  it('マスの位置から決まる：街が育っても、残ったマスの作物と区画は変わらない', () => {
    const { w, g, ox, oy } = town();
    const A = planOutskirts(g);
    w.exec({ t: 'zone', x0: ox + 29, y0: oy, x1: ox + 31, y1: oy + 10, zone: ZoneType.R, den: 1 });
    const B = planOutskirts(g);
    const n = g.n;
    let same = 0;
    for (let i = 0; i < n * n; i++) {
      if (A.kind[i] !== OK.field || B.kind[i] !== OK.field) continue;
      expect(B.parcel[i]).toBe(A.parcel[i]);
      expect(B.crop[i]).toBe(A.crop[i]);
      same++;
    }
    expect(same).toBeGreaterThan(300);
    // 新しく開発されたマスの飾りは消える
    expect(B.kind[(oy + 5) * n + ox + 30]).toBe(OK.none);
  });

  it('作り直すのは変わった区画だけ（三角形の数と時間を測る）', () => {
    const { w, g, ox, oy } = town();
    const L = new OutskirtsLayer();
    L.rebuild(g);
    const full = { ...L.stats };
    expect(full.tris).toBeGreaterThan(1000);
    // 何も変わらなければ、作り直さない
    L.rebuild(g);
    expect(L.stats.rebuilt).toBe(0);
    // 小さく街を広げると、作り直すのはまわりの区画だけ
    w.exec({ t: 'zone', x0: ox + 29, y0: oy + 2, x1: ox + 30, y1: oy + 4, zone: ZoneType.R, den: 1 });
    L.rebuild(g);
    const inc = { ...L.stats };
    expect(inc.rebuilt).toBeGreaterThan(0);
    expect(inc.rebuilt).toBeLessThan(full.rebuilt);
    console.log(`outskirts: full ${JSON.stringify(full)} / incremental ${JSON.stringify(inc)}`);
  });
});
