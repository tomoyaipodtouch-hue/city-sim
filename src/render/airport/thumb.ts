// メニューの空港の絵：ターミナル・管制塔・駐機中の飛行機のあたりだけを切り取った形（敷地の全体は細長すぎるので）
import { MeshBuilder } from '../builder';
import { AIRPORT_SPECS, airportLayout, makeFrame, type AirportSize } from '../../sim/airport';
import { buildAirportGeometry } from './geometry';
import { AC, buildAircraft, LIVERIES } from './aircraft';

// 切り取る範囲（敷地の座標、m）。絵の座標では (0, 0)〜(W, D)
const WIN = { a0: -78, a1: 140, c0: -12, c1: 70 };
export const AIRPORT_THUMB_CELLS = { w: (WIN.a1 - WIN.a0) / 16, h: (WIN.c1 - WIN.c0) / 16 };

export function airportThumbModel(size: AirportSize): MeshBuilder {
  const L = airportLayout(size);
  const f = makeFrame(AIRPORT_SPECS[size], 2, -WIN.a0, -WIN.c0);
  const geo = buildAirportGeometry(L, f, { cells: [], n: 1, base: 0, seed: 7, access: [], highway: null, lines: [] });
  const mb = geo.mb;
  // 駐機中の飛行機（機首がターミナルを向く）
  const types = ['a220', 'atr', 'e190'] as const;
  L.stands.filter((s) => !s.cargo).forEach((st, k) => {
    const t = types[k % 3];
    mb.setTransform(0, st.a - WIN.a0, 0.12, st.noseC - AC[t].len / 2 - WIN.c0);
    buildAircraft(mb, t, LIVERIES[(k * 2) % LIVERIES.length]);
  });
  // 範囲の中の三角形だけを残す
  const out = new MeshBuilder();
  const W = WIN.a1 - WIN.a0, D = WIN.c1 - WIN.c0;
  const remap = new Map<number, number>();
  const P = mb.pos;
  for (let t = 0; t < mb.idx.length; t += 3) {
    const a = mb.idx[t], b = mb.idx[t + 1], c = mb.idx[t + 2];
    const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, z = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
    const inside = (v: number) => P[v * 3] >= 0 && P[v * 3] <= W && P[v * 3 + 2] >= 0 && P[v * 3 + 2] <= D;
    if ((x < 0 || x > W || z < 0 || z > D) && !inside(a) && !inside(b) && !inside(c)) continue;
    for (const v of [a, b, c]) {
      let j = remap.get(v);
      if (j === undefined) {
        j = out.pos.length / 3;
        remap.set(v, j);
        // 範囲の外へのびる板（芝生・滑走路・道路）は、範囲のふちで切る
        out.pos.push(Math.max(0, Math.min(W, P[v * 3])), P[v * 3 + 1], Math.max(0, Math.min(D, P[v * 3 + 2])));
        out.nor.push(mb.nor[v * 3], mb.nor[v * 3 + 1], mb.nor[v * 3 + 2]);
        out.col.push(mb.col[v * 3], mb.col[v * 3 + 1], mb.col[v * 3 + 2]);
        out.uvm.push(mb.uvm[v * 2], mb.uvm[v * 2 + 1]);
        out.pat.push(mb.pat[v]);
        out.mat.push(mb.mat[v]);
      }
      out.idx.push(j);
    }
  }
  return out;
}
