// 町はずれ（ヨーロッパの田園）：街のふちから外へ、少しずつ田園に変わっていく飾り（描画だけ。シミュレーションには関係しない）
//   1. 街のすぐ外（1〜2マス）：草地の色のむら、背の高い草の株、野の花、低い茂み、ところどころの生け垣と小さな林
//   2. その外（3〜14マス）：畑のパッチワーク。地方ごとに、生け垣で囲まれた小さめの区画（ボカージュ）、開けた大きな区画（ボース平野・干拓地）、
//      細長い短冊の畑（ポーランドなど）。区画のふちは草の帯で、生け垣・農道（2本の轍）・用水路が通る。干し草のロール
//   3. 農家（母屋、大きな納屋、サイロ、砂利の庭、果樹園）
//   4. 一軒家（急な瓦屋根、しっくいの壁、庭と生け垣）
//   5. 風車（白い3枚羽根。ゆっくり回る）
//   6. 行き止まりの道の先：ポプラ並木の農道（砂利の2本の轍が、先で草にうもれて消える）
// すべてマスの位置から決める（街が育っても、残ったマスの飾りは変わらない）。マスが開発されると、そのマスの飾りは消える。
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, WATER_LEVEL, opp } from '../sim/constants';
import { RoadType } from '../sim/defs';
import { hash2 } from '../sim/rng';
import { MeshBuilder, PAT } from './builder';
import { MAT } from './textures';
import { createBuildingMaterial } from './materials';
import type { TreeSpot } from './buildingGen';

const CHUNK = 16;
export const OUT_MAXD = 14; // 飾るのは、開発されたマスからこのマス数まで
const OUT_EXT = 8; // 区画は丸ごと描く（ふちの区画は、この分まではみ出してよい）
const LIFT = 0.12; // 地面をおおう面の浮かせる高さ（地形の面と重ならないように）
const MAC = 24; // 区画を分ける大きなブロック（マス）
const MAX_TURBINES = 6;

// マスの種類
export const OK = { none: 0, meadow: 1, field: 2, house: 3, farm: 4, farmPart: 5 } as const;
// 畑の模様（シェーダーの番号と同じ）
const PT = { plough: 1, maize: 2, cereal: 3, rape: 4, grass: 5, stubble: 6, rows: 7 } as const;
// 区画の地方：0 = 生け垣の多い地方（ボカージュ）、1 = 開けた畑、2 = 細長い短冊の畑
export const RT = { bocage: 0, open: 1, strip: 2 } as const;

const C = (hex: number) => new THREE.Color(hex);
// 作物（航空写真のような落ちついた色）。pat = 模様、h = 背の高さ（m）、side = 区画のふちの側面の色
interface CropDef { pat: number; col: THREE.Color; h: number; side: THREE.Color; bales?: boolean }
const CR = (pat: number, col: number, h: number, side: number, bales = false): CropDef => ({ pat, col: C(col), h, side: C(side), bales });
export const CROPS: CropDef[] = [
  CR(0, 0, 0, 0),
  CR(PT.plough, 0x7a6550, 0, 0), // 1 耕した畑（茶色）
  CR(PT.plough, 0x8f7c62, 0, 0), // 2 ならした畑（明るい土）
  CR(PT.maize, 0x56703a, 2.2, 0x3e5129), // 3 トウモロコシ
  CR(PT.cereal, 0xb3a06c, 0.7, 0x8f7f52), // 4 実った小麦
  CR(PT.cereal, 0xa59d70, 0.6, 0x847c56), // 5 大麦
  CR(PT.cereal, 0x7c8a4f, 0.5, 0x5e6b3b), // 6 青い麦
  CR(PT.rape, 0xbfae55, 0.9, 0x76803e), // 7 菜の花（くすんだ黄色）
  CR(PT.grass, 0x6b8247, 0, 0, true), // 8 牧草地
  CR(PT.grass, 0x84895a, 0, 0, true), // 9 干し草の草地
  CR(PT.stubble, 0xbfb08a, 0, 0, true), // 10 刈り取りあと
  CR(PT.rows, 0x58703f, 0.35, 0x45582f), // 11 ビート・ジャガイモ
];
// 地方ごとの作物の割合
const CROP_W: [number, number][][] = [
  [[8, 0.36], [9, 0.1], [4, 0.13], [6, 0.06], [3, 0.14], [1, 0.07], [10, 0.08], [7, 0.02], [5, 0.04]],
  [[4, 0.26], [5, 0.12], [6, 0.08], [7, 0.04], [3, 0.12], [11, 0.08], [1, 0.1], [2, 0.05], [10, 0.1], [8, 0.05]],
  [[4, 0.16], [5, 0.1], [6, 0.1], [7, 0.03], [3, 0.08], [11, 0.12], [1, 0.1], [2, 0.06], [10, 0.08], [8, 0.1], [9, 0.07]],
];
// 区画のふち：0 = なし（同じ区画）、1 = 草の帯、2 = 生け垣、3 = 農道（2本の轍）、4 = 用水路
export const EF = { none: 0, margin: 1, hedge: 2, track: 3, ditch: 4 } as const;
// ふちの種類ごとに、作物を内側へ下げる幅（m）
const INSET = [0, 1.3, 2.4, 3.0, 2.1];
const COL = {
  lush: C(0x5a8238),
  dry: C(0xa29d60),
  margin: C(0x72874a),
  marginDry: C(0x8f9160),
  rut: C(0x8a7a5f),
  ditch: C(0x3c4637),
  reed: C(0x7f8651),
  grassA: C(0x6d8f45), // 地形の草の色（terrainLayer と同じ）
  grassB: C(0x87a052),
  tuft: [C(0x5f7434), C(0x7f8443), C(0x6a7a3a)],
  flower: [C(0xf2efe6), C(0xe8c93a), C(0xc8362b), C(0x8a6bb0)],
  hedge: [C(0x3f5f2a), C(0x4a6b2e), C(0x52702f), C(0x3a5628)],
  verge: C(0x73984a),
  gravel: C(0xb5a98c),
  gravelEnd: C(0x8f8d63),
  lawn: C(0x6a9a42),
  yard: C(0xa79d86),
  strawBale: C(0xcdb27a),
  wrapDark: C(0x2b2e2b),
  wrapWhite: C(0xd9d5c8),
  walls: [C(0xeee8dc), C(0xe6d9ba), C(0xcdbf9f), C(0xd9cfc0), C(0xf2eee6)],
  plinth: C(0x9a9284),
  roofs: [C(0x9b4b33), C(0x8a4430), C(0x7a4a36), C(0x4d535b), C(0xa5573a)],
  chimney: C(0xb8a990),
  barnWalls: [C(0x6b5442), C(0xb8ab90), C(0x7d8a7a), C(0x8a6a4e)],
  barnRoofs: [C(0x5a5e60), C(0x8c4a35), C(0x6a6458)],
  door: C(0x4a3b2e),
  silo: C(0xc9ccc8),
  white: C(0xe9ecee),
  shed: C(0x7a6650),
};

// なめらかなノイズ（マスの座標から、0..1）
function vnoise(x: number, y: number, seed: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed), c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
// 区画の地方と区画：大きなブロック（MAC マス、行ごとにずらす）を、地方ごとの大きさになるまで二つに分けていく。
// 戻り値 = [区画の番号, 地方, 畝が x の向きか]
export function parcelOf(x: number, y: number): [number, number, boolean] {
  const my = Math.floor(y / MAC), xo = Math.floor(hash2(my, 0, 51) * MAC), mx = Math.floor((x + xo) / MAC);
  const r = vnoise(mx / 1.6 + 0.3, my / 1.6 + 0.7, 61), r2 = hash2(mx, my, 62);
  const rt = r > 0.56 ? RT.bocage : r < 0.3 && r2 < 0.75 ? RT.strip : RT.open;
  let x0 = mx * MAC - xo, y0 = my * MAC, w = MAC, h = MAC;
  const along = hash2(mx, my, 57) < 0.5; // 短冊の畑の長い向き（true = x）
  for (let depth = 0; depth < 12; depth++) {
    const hs = hash2(x0 * 131 + w * 7, y0 * 137 + h * 11, 58 + depth);
    let axisX: boolean, pos: number;
    if (rt === RT.strip) {
      const long = along ? w : h, short = along ? h : w;
      if (long > 15) { axisX = along; pos = 8 + Math.floor(hs * (long - 15)); }
      else if (short > 3) { axisX = !along; pos = short - 2 < 2 ? 2 : hs < 0.5 ? 2 : 3; if (short - pos < 2) pos = 2; }
      else break;
    } else {
      const [minW, maxW, minH, maxH] = rt === RT.bocage ? [4, 8, 4, 6] : [6, 12, 6, 8];
      const sx = w > maxW && w >= minW * 2, sy = h > maxH && h >= minH * 2;
      if (!sx && !sy) break;
      axisX = sx && sy ? w / maxW >= h / maxH : sx;
      const len = axisX ? w : h, mn = axisX ? minW : minH;
      pos = mn + Math.floor(hs * (len - mn * 2 + 1));
    }
    if (axisX) { if (x - x0 < pos) w = pos; else { x0 += pos; w -= pos; } }
    else { if (y - y0 < pos) h = pos; else { y0 += pos; h -= pos; } }
  }
  const id = (Math.imul(x0 + 4096, 73856093) ^ Math.imul(y0 + 4096, 19349663) ^ Math.imul(w * 64 + h, 83492791) ^ (rt << 29)) | 0;
  // 畝は長い向き（短冊の畑は必ず長い向き）
  return [id, rt, w >= h];
}

export interface OutskirtsPlan {
  n: number;
  dist: Uint8Array; // 開発されたマスからの距離（マス）。255 = 遠い
  kind: Uint8Array;
  parcel: Int32Array; // 畑の区画の番号
  crop: Uint8Array; // CROPS の番号
  region: Uint8Array; // 区画の地方（RT）
  rowX: Uint8Array; // 1 = 畝が x の向き
  edgeE: Uint8Array; // マスの東の辺のふち（EF）
  edgeS: Uint8Array; // マスの南の辺のふち（EF）
  lane: Uint8Array; // 農道：進む向き + 1（0 = なし）
  laneStep: Uint8Array; // 道の端から何マス目か（1..）
  laneLen: Uint8Array; // 農道の長さ（マス）
  face: Uint8Array; // 一軒家・農家の正面の向き（0 = 東, 1 = 南, 2 = 西, 3 = 北）
  turbine: Uint8Array;
}

const popcount = (v: number) => { let c = 0; for (; v; v &= v - 1) c++; return c; };
const LANE_ROADS = new Set<number>([RoadType.Street, RoadType.Road, RoadType.OneWay]);

// 町はずれの計画：どのマスに何を置くか（マスの位置と、まわりの開発のようすだけで決まる）
export function planOutskirts(g: Grid): OutskirtsPlan {
  const n = g.n, N = n * n;
  const dev = new Uint8Array(N), free = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (g.road[i] || g.up[i] || g.rail[i] || g.erail[i] || g.mono[i] || g.bldg[i] || g.zone[i] || g.quay[i]) dev[i] = 1;
  }
  // 開発されたマスからの距離（3-4 の面取り距離。丸い等高線になる）
  const INF = 1 << 20, dd = new Int32Array(N);
  for (let i = 0; i < N; i++) dd[i] = dev[i] ? 0 : INF;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let v = dd[i];
      if (x > 0 && dd[i - 1] + 3 < v) v = dd[i - 1] + 3;
      if (y > 0) {
        const j = i - n;
        if (dd[j] + 3 < v) v = dd[j] + 3;
        if (x > 0 && dd[j - 1] + 4 < v) v = dd[j - 1] + 4;
        if (x < n - 1 && dd[j + 1] + 4 < v) v = dd[j + 1] + 4;
      }
      dd[i] = v;
    }
  for (let y = n - 1; y >= 0; y--)
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      let v = dd[i];
      if (x < n - 1 && dd[i + 1] + 3 < v) v = dd[i + 1] + 3;
      if (y < n - 1) {
        const j = i + n;
        if (dd[j] + 3 < v) v = dd[j] + 3;
        if (x < n - 1 && dd[j + 1] + 4 < v) v = dd[j + 1] + 4;
        if (x > 0 && dd[j - 1] + 4 < v) v = dd[j - 1] + 4;
      }
      dd[i] = v;
    }
  const dist = new Uint8Array(N);
  for (let i = 0; i < N; i++) dist[i] = dd[i] >= INF ? 255 : Math.min(255, Math.round(dd[i] / 3));
  // 飾ってよいマス（街の近くだけ調べる）
  const Hs = g.heights, V = n + 1;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (dev[i] || dist[i] > OUT_MAXD + OUT_EXT || g.pline[i]) continue;
      const a = Hs[y * V + x], b = Hs[y * V + x + 1], c = Hs[(y + 1) * V + x], d = Hs[(y + 1) * V + x + 1];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      // 水、砂浜、急な斜面には置かない
      if (lo < WATER_LEVEL + 2.3 || hi - lo > 6) continue;
      // 自然の林はそのまま（ぽつんと1本だけの木のマスは、畑の中の木として残す）
      if (g.tree[i]) {
        if (g.tree[i] > 1) continue;
        let nb = 0;
        for (let k = 0; k < 8; k++) { const xx = x + DX[k], yy = y + DY[k]; if (g.inb(xx, yy) && g.tree[yy * n + xx]) nb++; }
        if (nb >= 2) continue;
      }
      free[i] = 1;
    }

  const P: OutskirtsPlan = {
    n, dist, kind: new Uint8Array(N), parcel: new Int32Array(N), crop: new Uint8Array(N), region: new Uint8Array(N), rowX: new Uint8Array(N), edgeE: new Uint8Array(N), edgeS: new Uint8Array(N),
    lane: new Uint8Array(N), laneStep: new Uint8Array(N), laneLen: new Uint8Array(N), face: new Uint8Array(N), turbine: new Uint8Array(N),
  };
  const near = (i: number) => free[i] && dist[i] >= 1 && dist[i] <= OUT_MAXD;

  // ---- 行き止まりの道の先の農道 ----
  for (let y = 2; y < n - 2; y++)
    for (let x = 2; x < n - 2; x++) {
      const i = y * n + x;
      if (!LANE_ROADS.has(g.road[i]) || g.up[i] || g.deck[i] > 0 || g.lift[i] > 0 || popcount(g.conn[i]) !== 1) continue;
      const o = opp(31 - Math.clz32(g.conn[i]));
      const want = 3 + Math.floor(hash2(x, y, 41) * 6);
      let k = 1;
      for (; k <= want; k++) {
        const xx = x + DX[o] * k, yy = y + DY[o] * k;
        if (!g.inb(xx, yy)) break;
        const j = yy * n + xx;
        if (!near(j) || P.lane[j]) break;
      }
      const len = k - 1;
      if (len < 2) continue;
      for (let s = 1; s <= len; s++) {
        const j = (y + DY[o] * s) * n + x + DX[o] * s;
        P.lane[j] = o + 1; P.laneStep[j] = s; P.laneLen[j] = len;
      }
    }

  // ---- 草地と畑 ----
  // 畑は区画を丸ごと描く：区画のどこかが街から OUT_MAXD マス以内なら、はみ出したところ（OUT_EXT まで）も描く（外のふちが区画の形になる）
  const pmin = new Map<number, number>();
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!free[i] || dist[i] < 1) continue;
      if (dist[i] <= 2) { if (dist[i] <= OUT_MAXD) P.kind[i] = OK.meadow; continue; }
      const [pid, rt, rx] = parcelOf(x, y);
      P.parcel[i] = pid; P.region[i] = rt; P.rowX[i] = rx ? 1 : 0;
      const m = pmin.get(pid);
      if (m === undefined || dist[i] < m) pmin.set(pid, dist[i]);
    }
  for (let i = 0; i < N; i++) {
    if (!free[i] || dist[i] < 3) continue;
    const pid = P.parcel[i];
    if ((pmin.get(pid) ?? 255) > OUT_MAXD) { P.parcel[i] = 0; continue; }
    P.kind[i] = OK.field;
    const hc = hash2(pid, P.region[i], 55);
    let acc = 0;
    for (const [c, p] of CROP_W[P.region[i]]) { acc += p; if (hc < acc) { P.crop[i] = c; break; } }
    if (!P.crop[i]) P.crop[i] = 8;
  }

  // ---- 一軒家（街の近く。道路や農道に面して） ----
  const roadNear = (x: number, y: number, r: number) => {
    for (let yy = y - r; yy <= y + r; yy++)
      for (let xx = x - r; xx <= x + r; xx++) if (g.inb(xx, yy) && (g.road[yy * n + xx] || P.lane[yy * n + xx])) return true;
    return false;
  };
  const cand = new Float32Array(N);
  for (let y = 1; y < n - 1; y++)
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (!P.kind[i] || P.lane[i] || dist[i] < 2 || dist[i] > 6 || g.cellMaxH(x, y) - g.cellMinH(x, y) > 2.5) continue;
      const h = hash2(x, y, 71);
      if (h < (roadNear(x, y, 2) ? 0.16 : 0.03)) cand[i] = h + 1e-6;
    }
  for (let y = 1; y < n - 1; y++)
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (!cand[i]) continue;
      let best = true;
      for (let d = 0; d < 8 && best; d++) { const j = (y + DY[d]) * n + x + DX[d]; if (cand[j] && cand[j] < cand[i]) best = false; }
      if (!best) continue;
      P.kind[i] = OK.house;
      // 正面は、いちばん近い道路（農道）の向き
      let face = Math.floor(hash2(x, y, 72) * 4);
      search: for (let r = 1; r <= 2; r++)
        for (let f = 0; f < 4; f++) {
          const xx = x + DX[f * 2] * r, yy = y + DY[f * 2] * r;
          if (g.inb(xx, yy) && (g.road[yy * n + xx] || P.lane[yy * n + xx])) { face = f; break search; }
        }
      P.face[i] = face;
    }

  // ---- 農家（8×8 マスのブロックに1つまで。2×2 マスの敷地） ----
  for (let by = 0; by * 8 < n; by++)
    for (let bx = 0; bx * 8 < n; bx++) {
      if (hash2(bx, by, 81) > 0.8) continue;
      const x = bx * 8 + Math.floor(hash2(bx, by, 82) * 7), y = by * 8 + Math.floor(hash2(bx, by, 83) * 7);
      if (x + 1 >= n || y + 1 >= n) continue;
      let ok = true, lo = 1e9, hi = -1e9;
      for (let yy = y; yy <= y + 1 && ok; yy++)
        for (let xx = x; xx <= x + 1 && ok; xx++) {
          const j = yy * n + xx;
          if (P.kind[j] !== OK.field || P.lane[j] || dist[j] < 5) ok = false;
          lo = Math.min(lo, g.cellMinH(xx, yy)); hi = Math.max(hi, g.cellMaxH(xx, yy));
        }
      if (!ok || hi - lo > 2.5) continue;
      for (let yy = y; yy <= y + 1; yy++) for (let xx = x; xx <= x + 1; xx++) P.kind[yy * n + xx] = OK.farmPart;
      P.kind[y * n + x] = OK.farm;
      P.face[y * n + x] = Math.floor(hash2(x, y, 84) * 4);
    }

  // ---- 風車（遠くの畑に、ほんの少し） ----
  const tc: [number, number][] = [];
  for (let by = 0; by * 18 < n; by++)
    for (let bx = 0; bx * 18 < n; bx++) {
      const h = hash2(bx, by, 91);
      if (h > 0.45) continue;
      const x = bx * 18 + 2 + Math.floor(hash2(bx, by, 92) * 14), y = by * 18 + 2 + Math.floor(hash2(bx, by, 93) * 14);
      if (!g.inb(x, y)) continue;
      const i = y * n + x;
      if (P.kind[i] !== OK.field || P.lane[i] || dist[i] < 9) continue;
      tc.push([h, i]);
    }
  tc.sort((a, b) => a[0] - b[0]);
  for (const [, i] of tc.slice(0, MAX_TURBINES)) P.turbine[i] = 1;
  planEdges(g, P);
  return P;
}

// 区画のふち（生け垣・農道・用水路・草の帯）。辺ごとに1回だけ決める（西・北のマスの edgeE / edgeS に入れる）
function planEdges(g: Grid, P: OutskirtsPlan) {
  const n = g.n;
  const isField = (j: number) => P.kind[j] === OK.field && !P.lane[j];
  // 農道は、ブロックを分けた線に沿って続く（線ごとに決める）
  const trackLine = (vert: boolean, line: number, along: number, rt: number) => hash2(line * 2 + (vert ? 1 : 0), Math.floor(along / MAC), 140) < [0.22, 0.38, 0.6][rt];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      for (const vert of [true, false]) {
        const xx = vert ? x + 1 : x, yy = vert ? y : y + 1;
        if (!g.inb(xx, yy)) continue;
        const j = yy * n + xx;
        const fa = isField(i), fb = isField(j);
        if (!fa && !fb) continue;
        if (fa && fb && P.parcel[i] === P.parcel[j]) continue;
        const f = fa ? i : j, other = fa ? j : i, ok = P.kind[other];
        const rt = P.region[f];
        let e: number = EF.margin;
        const blocked = P.lane[other] || ok === OK.house || ok === OK.farm || ok === OK.farmPart || g.isWater(xx, yy) || g.isWater(x, y);
        if (!blocked) {
          const h = hash2(vert ? xx * 2 + 1 : x * 2, vert ? y * 2 : yy * 2, 141);
          if (fa && fb && trackLine(vert, vert ? xx : yy, vert ? y : x, rt)) e = EF.track;
          else if (rt === RT.bocage) e = h < 0.86 ? EF.hedge : EF.margin;
          else if (rt === RT.open) e = !(fa && fb) ? (h < 0.4 ? EF.hedge : EF.margin) : h < 0.1 ? EF.hedge : h < 0.26 ? EF.ditch : EF.margin;
          else e = !(fa && fb) ? (h < 0.2 ? EF.hedge : EF.margin) : h < 0.07 ? EF.ditch : EF.margin;
        }
        if (vert) P.edgeE[i] = e; else P.edgeS[i] = e;
      }
    }
  // 農道を、草地を通って道路まで（3マスまで）のばす
  const free2 = (j: number) => P.kind[j] === OK.meadow && !P.lane[j];
  for (let pass = 0; pass < 3; pass++)
    for (let y = 1; y < n - 1; y++)
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        // 南北の線（マス x と x+1 のあいだ）
        if (!P.edgeE[i] && free2(i) && free2(i + 1) && (P.edgeE[i - n] === EF.track || P.edgeE[i + n] === EF.track)) P.edgeE[i] = EF.track;
        // 東西の線（マス y と y+1 のあいだ）
        if (!P.edgeS[i] && free2(i) && free2(i + n) && (P.edgeS[i - 1] === EF.track || P.edgeS[i + 1] === EF.track)) P.edgeS[i] = EF.track;
      }
}

interface Chunk {
  sig: number;
  mesh: THREE.Mesh | null;
  rotors: THREE.Mesh[];
  trees: TreeSpot[];
  tris: number;
}

type V3 = [number, number, number];

export class OutskirtsLayer {
  group = new THREE.Group();
  material = createBuildingMaterial();
  private chunks = new Map<number, Chunk>();
  private sigN = 0;
  private rotorGeo: THREE.BufferGeometry | null = null;
  private spin = 0;
  // 計測用（三角形の数、最後に作り直したときの時間と区画の数）
  stats = { tris: 0, planMs: 0, buildMs: 0, rebuilt: 0, chunks: 0, trees: 0 };

  allTrees(): TreeSpot[] {
    const out: TreeSpot[] = [];
    for (const c of this.chunks.values()) out.push(...c.trees);
    return out;
  }

  // 風車の羽根を回す（実時間の秒）
  update(dt: number) {
    this.spin = (this.spin + dt * 1.35) % (Math.PI * 2);
    for (const c of this.chunks.values()) for (const r of c.rotors) r.rotation.z = this.spin + r.userData.phase;
  }

  private lastKey = 0;
  // 計画に関係するマスの中身の印（建物が建っても、ゾーンのマスならふつうは変わらない）
  private planKey(g: Grid) {
    let h = 0x811c9dc5 | 0;
    const N = g.n * g.n;
    for (let i = 0; i < N; i++) {
      const v = (g.road[i] ? 1 : 0) | (g.up[i] ? 2 : 0) | (g.rail[i] || g.erail[i] || g.mono[i] ? 4 : 0) | (g.bldg[i] ? 8 : 0) | (g.zone[i] ? 16 : 0) | (g.quay[i] ? 32 : 0) | (g.pline[i] ? 64 : 0) | (g.tree[i] << 7);
      if (!v) continue;
      h = Math.imul(h ^ i, 16777619);
      h = Math.imul(h ^ v ^ (g.road[i] << 10) ^ (g.conn[i] << 16), 16777619);
      if (g.road[i]) h = Math.imul(h ^ ((g.deck[i] > 0 ? 1 : 0) | (g.lift[i] > 0 ? 2 : 0)), 16777619);
    }
    return h;
  }

  // 変わった区画だけ作り直す。木の位置が変わったら true。heights = 地形の高さが変わった
  rebuild(g: Grid, heights = true): boolean {
    const t0 = performance.now();
    const n = g.n, cn = Math.ceil(n / CHUNK);
    if (this.sigN !== n) { this.clear(); this.sigN = n; heights = true; }
    // 開発のようすも地形も変わっていなければ、何もしない（街が育つたびに計画を作り直さない）
    const key = this.planKey(g);
    if (!heights && key === this.lastKey) { this.stats = { ...this.stats, planMs: performance.now() - t0, buildMs: 0, rebuilt: 0 }; return false; }
    this.lastKey = key;
    const P = planOutskirts(g);
    const t1 = performance.now();
    let treesChanged = false, rebuilt = 0;
    for (let cz = 0; cz < cn; cz++)
      for (let cx = 0; cx < cn; cx++) {
        const ci = cz * cn + cx;
        const x0 = cx * CHUNK, y0 = cz * CHUNK, x1 = Math.min(n, x0 + CHUNK), y1 = Math.min(n, y0 + CHUNK);
        // 区画の中身の印（まわり 1 マスも含める）。畑のマスは距離に関係なく同じ形なので、距離は草地のマスだけ入れる
        let h = 0x811c9dc5 | 0, any = false;
        const mix = (v: number) => { h = Math.imul(h ^ v, 16777619); };
        for (let y = Math.max(0, y0 - 1); y < Math.min(n, y1 + 1); y++)
          for (let x = Math.max(0, x0 - 1); x < Math.min(n, x1 + 1); x++) {
            const i = y * n + x, k = P.kind[i];
            if (!k && !P.edgeE[i] && !P.edgeS[i]) continue;
            if (x >= x0 && x < x1 && y >= y0 && y < y1) any = true;
            mix(i); mix(k | (k === OK.meadow ? P.dist[i] << 4 : 0) | (P.lane[i] << 12) | (P.laneStep[i] << 16) | (P.laneLen[i] << 20) | (P.face[i] << 24) | (P.turbine[i] << 27) | ((g.road[i] ? 1 : 0) << 28));
            mix(P.parcel[i]); mix(P.crop[i] | (P.region[i] << 8) | (P.rowX[i] << 10) | (P.edgeE[i] << 12) | (P.edgeS[i] << 16));
            mix(Math.round(g.vh(x, y) * 16)); mix(Math.round(g.vh(x + 1, y + 1) * 16)); mix(Math.round(g.vh(x + 1, y) * 16)); mix(Math.round(g.vh(x, y + 1) * 16));
          }
        const sig = any ? h : 0;
        const old = this.chunks.get(ci);
        if (old && old.sig === sig) continue;
        if (!old && !any) continue;
        if (old) this.drop(old);
        this.chunks.delete(ci);
        if (old?.trees.length) treesChanged = true;
        if (!any) continue;
        const ch = this.build(g, P, x0, y0, x1, y1);
        ch.sig = sig;
        rebuilt++;
        if (ch.trees.length) treesChanged = true;
        this.chunks.set(ci, ch);
      }
    const t2 = performance.now();
    let tris = 0, trees = 0;
    for (const c of this.chunks.values()) { tris += c.tris; trees += c.trees.length; }
    this.stats = { tris, planMs: t1 - t0, buildMs: t2 - t1, rebuilt, chunks: this.chunks.size, trees };
    return treesChanged;
  }

  private drop(c: Chunk) {
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
    for (const r of c.rotors) this.group.remove(r);
  }
  private clear() {
    for (const c of this.chunks.values()) this.drop(c);
    this.chunks.clear();
  }

  // 風車の羽根（ハブを原点、回る軸は +z、羽根は xy 面）。すべての風車で同じ形を使う
  private rotor(): THREE.BufferGeometry {
    if (this.rotorGeo) return this.rotorGeo;
    const mb = new MeshBuilder();
    mb.matOverride = MAT.none;
    const w = COL.white;
    mb.box(-1.1, -1.1, -1.2, 1.1, 1.1, 1.2, w);
    mb.quad([-1.1, -1.1, 1.2], [1.1, -1.1, 1.2], [0, 0, 2.6], [0, 0, 2.6], w);
    mb.quad([1.1, 1.1, 1.2], [-1.1, 1.1, 1.2], [0, 0, 2.6], [0, 0, 2.6], w);
    mb.quad([1.1, -1.1, 1.2], [1.1, 1.1, 1.2], [0, 0, 2.6], [0, 0, 2.6], w);
    mb.quad([-1.1, 1.1, 1.2], [-1.1, -1.1, 1.2], [0, 0, 2.6], [0, 0, 2.6], w);
    for (let k = 0; k < 3; k++) {
      const th = (k / 3) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
      const R = (x: number, y: number, z: number): V3 => [x * cs - y * sn, x * sn + y * cs, z];
      const r0 = 1, r1 = 42, c0 = 1.6, c1 = 0.35, t = 0.3;
      // 羽根の前の縁はまっすぐ、後ろの縁が根元で広がる
      const xa0 = -0.5, xb0 = xa0 + c0 * 1.6, xa1 = -0.2, xb1 = xa1 + c1;
      mb.quad(R(xa0, r0, t), R(xb0, r0, t), R(xb1, r1, t), R(xa1, r1, t), w);
      mb.quad(R(xb0, r0, -t), R(xa0, r0, -t), R(xa1, r1, -t), R(xb1, r1, -t), w);
      mb.quad(R(xb0, r0, t), R(xb0, r0, -t), R(xb1, r1, -t), R(xb1, r1, t), w);
      mb.quad(R(xa0, r0, -t), R(xa0, r0, t), R(xa1, r1, t), R(xa1, r1, -t), w);
    }
    this.rotorGeo = mb.toGeometry();
    return this.rotorGeo;
  }

  private build(g: Grid, P: OutskirtsPlan, X0: number, Y0: number, X1: number, Y1: number): Chunk {
    const n = g.n;
    const mb = new MeshBuilder();
    const trees: TreeSpot[] = [];
    const rotors: THREE.Mesh[] = [];
    const vh = (vx: number, vy: number) => g.vh(vx, vy);
    const gy = (x: number, z: number) => g.groundAt(x, z);
    const kindAt = (x: number, y: number) => (g.inb(x, y) ? P.kind[y * n + x] : 0);
    const covered = (x: number, y: number) => kindAt(x, y) !== OK.none;
    const tmp = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
    // マス全体をおおう面（地形と同じ対角線で分ける）
    const cellTop = (x: number, y: number, lift: number, cols: THREE.Color[], mat: number, pat = 0, u = 0, v = 0) => {
      const x0 = x * CELL, x1 = x0 + CELL, z0 = y * CELL, z1 = z0 + CELL;
      mb.quadC([x0, vh(x, y + 1) + lift, z1], [x1, vh(x + 1, y + 1) + lift, z1], [x1, vh(x + 1, y) + lift, z0], [x0, vh(x, y) + lift, z0], cols[0], cols[1], cols[2], cols[3], mat, pat, u, v);
    };
    // 地形の草の色（terrainLayer と同じ式）
    const terrCol = (vx: number, vy: number, out: THREE.Color) => out.copy(COL.grassA).lerp(COL.grassB, hash2(vx, vy, 7) * 0.7);
    // 草地の色のむら：まわりが全部飾りのマスの頂点だけ色を変え、ふちは地形の色にそろえる（つなぎ目が見えないように）
    const meadowCol = (vx: number, vy: number, out: THREE.Color) => {
      terrCol(vx, vy, out);
      if (!(covered(vx - 1, vy - 1) && covered(vx, vy - 1) && covered(vx - 1, vy) && covered(vx, vy))) return out;
      const m = vnoise(vx / 3.3, vy / 3.3, 85), m2 = vnoise(vx / 1.7 + 9, vy / 1.7 + 4, 86);
      const c = COL.lush.clone().lerp(COL.dry, Math.min(1, Math.max(0, (m - 0.25) * 1.7)));
      c.multiplyScalar(0.88 + m2 * 0.22);
      return out.lerp(c, 0.82);
    };
    // 頂点のずらし：区画のふちを、ゆるやかに曲げる（まわりの4マスがすべて畑で、平らなときだけ。ずらした頂点はとなりのマスと共有）
    const jcache = new Map<number, [number, number]>();
    const J = (vx: number, vy: number): [number, number] => {
      const key = vy * (n + 1) + vx;
      const c = jcache.get(key);
      if (c) return c;
      let ok = true;
      for (let k2 = 0; k2 < 4 && ok; k2++) {
        const cx = vx - 1 + (k2 & 1), cy = vy - 1 + (k2 >> 1);
        if (!g.inb(cx, cy)) { ok = false; break; }
        const j = cy * n + cx;
        if (P.kind[j] !== OK.field || P.lane[j] || P.turbine[j] || g.cellMaxH(cx, cy) - g.cellMinH(cx, cy) > 1.5) ok = false;
      }
      const A = 4.2;
      const r: [number, number] = ok
        ? [vx * CELL + (vnoise(vx / 3.1 + 0.5, vy / 3.1 + 0.2, 301) - 0.5) * 2 * A, vy * CELL + (vnoise(vx / 3.1 + 0.8, vy / 3.1 + 0.6, 302) - 0.5) * 2 * A]
        : [vx * CELL, vy * CELL];
      jcache.set(key, r);
      return r;
    };
    // マスの中の位置 (u, v)（0..1）を、ずらした4つの角から求める
    const Qw = (x: number, y: number, u: number, v: number): [number, number] => {
      const a = J(x, y), b = J(x + 1, y), c = J(x, y + 1), d = J(x + 1, y + 1);
      return [a[0] * (1 - u) * (1 - v) + b[0] * u * (1 - v) + c[0] * (1 - u) * v + d[0] * u * v, a[1] * (1 - u) * (1 - v) + b[1] * u * (1 - v) + c[1] * (1 - u) * v + d[1] * u * v];
    };
    const Q3 = (x: number, y: number, u: number, v: number, lift: number): V3 => { const [wx, wz] = Qw(x, y, u, v); return [wx, gy(wx, wz) + lift, wz]; };
    // マスの中の四角 (u0..u1, v0..v1) を地面に沿わせて描く（斜面では細かく分ける）
    const patch = (x: number, y: number, u0: number, v0: number, u1: number, v1: number, lift: number, col: THREE.Color, mat: number, pat = 0, pu = 0, pv = 0) => {
      if (u1 - u0 < 0.01 || v1 - v0 < 0.01) return;
      const k = g.cellMaxH(x, y) - g.cellMinH(x, y) > 1.2 ? 2 : 1;
      for (let a = 0; a < k; a++)
        for (let b = 0; b < k; b++) {
          const ua = u0 + ((u1 - u0) * a) / k, ub = u0 + ((u1 - u0) * (a + 1)) / k, va = v0 + ((v1 - v0) * b) / k, vb = v0 + ((v1 - v0) * (b + 1)) / k;
          mb.quadC(Q3(x, y, ua, vb, lift), Q3(x, y, ub, vb, lift), Q3(x, y, ub, va, lift), Q3(x, y, ua, va, lift), col, col, col, col, mat, pat, pu, pv);
        }
    };
    // 生け垣の一区切り（A から B へ、向きのついた箱。上に小さな箱を重ねて、てっぺんをでこぼこに）
    const hedgeSeg = (ax: number, az: number, bx: number, bz: number, w: number, ht: number, col: THREE.Color, crown: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.5) return;
      const lo = Math.min(gy(ax, az), gy(bx, bz)), hi = Math.max(gy(ax, az), gy(bx, bz));
      mb.setTransform(Math.atan2(bz - az, bx - ax), (ax + bx) / 2, 0, (az + bz) / 2);
      mb.matOverride = MAT.none;
      mb.box(-len / 2, lo - 0.4, -w / 2, len / 2, hi + ht, w / 2, col, PAT.gardenLeaf);
      // てっぺんの盛り上がり（2つ、少し細く。並べて、平らな箱に見えないように）
      if (crown > 0) {
        const c2 = col.clone().multiplyScalar(1.08);
        mb.box(-len / 2 + 0.3, hi + ht - 0.3, -w * 0.38, -len * 0.05, hi + ht + crown, w * 0.38, c2, PAT.gardenLeaf);
        mb.box(len * 0.08, hi + ht - 0.3, -w * 0.36, len / 2 - 0.4, hi + ht + crown * 0.7, w * 0.36, c2, PAT.gardenLeaf);
      }
      mb.setTransform(0, 0, 0, 0);
    };
    // 区画のふち（辺の A から B）：生け垣・農道・用水路
    const edgeLine = (ax: number, az: number, bx: number, bz: number, e: number, key: number, rt: number) => {
      const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
      if (e === EF.hedge) {
        const boc = rt === RT.bocage;
        let s0 = 0;
        for (let p = 0; p < 2; p++) {
          const s1 = p === 1 ? len : len * (0.38 + hash2(key, p, 101) * 0.24);
          // ところどころ、畑の出入口のすき間
          if (hash2(key, p, 102) > 0.04) {
            const w = boc ? 2.3 + hash2(key, p, 103) * 0.9 : 1.5 + hash2(key, p, 103) * 0.7;
            const ht = boc ? 2.3 + hash2(key, p, 104) * 1.6 : 1.4 + hash2(key, p, 104) * 1.0;
            const col = COL.hedge[Math.floor(hash2(key, p, 105) * COL.hedge.length)];
            hedgeSeg(ax + ux * s0, az + uz * s0, ax + ux * s1, az + uz * s1, w, ht, col, hash2(key, p, 106) < (boc ? 0.85 : 0.5) ? 0.4 + hash2(key, p, 107) * 0.7 : 0);
          }
          s0 = s1;
        }
        // 生け垣の木（ボカージュは多い）
        const pt = boc ? 0.62 : rt === RT.open ? 0.2 : 0.1;
        for (let t = 0; t < 2; t++) {
          if (hash2(key, t, 108) >= (t ? pt * 0.4 : pt)) continue;
          const a = (0.12 + hash2(key, t, 109) * 0.76) * len, tx = ax + ux * a, tz = az + uz * a;
          trees.push({ x: tx, y: gy(tx, tz), z: tz, s: 1.0 + hash2(key, t, 110) * 0.6, kind: 0, shape: hash2(key, t, 111) < 0.6 ? 0 : 3 });
        }
      } else if (e === EF.track) {
        // 農道：土の2本の轍（まん中と両側は草）
        for (const o of [-1, 1]) strip(ax, az, ux, uz, -0.25, len + 0.25, o * 0.6 - 0.28, o * 0.6 + 0.28, LIFT + 0.06, COL.rut, COL.rut, MAT.gravel);
        if (hash2(key, 3, 112) < 0.07) {
          const a = hash2(key, 4, 113) * len, tx = ax + ux * a - uz * 2.6, tz = az + uz * a + ux * 2.6;
          trees.push({ x: tx, y: gy(tx, tz), z: tz, s: 1.1 + hash2(key, 5, 114) * 0.4, kind: 0 });
        }
      } else if (e === EF.ditch) {
        // 用水路：暗い水と、両側のアシ
        strip(ax, az, ux, uz, -0.2, len + 0.2, -0.55, 0.55, LIFT + 0.05, COL.ditch, COL.ditch, MAT.none);
        for (const o of [-1, 1]) strip(ax, az, ux, uz, -0.2, len + 0.2, o > 0 ? 0.55 : -1.05, o > 0 ? 1.05 : -0.55, LIFT + 0.07, COL.reed, COL.reed, MAT.ground);
        // 干拓地の水路ぞいの木（ヤナギ）
        if (hash2(key, 6, 115) < 0.14) {
          const a = hash2(key, 7, 116) * len, tx = ax + ux * a + uz * 1.6, tz = az + uz * a - ux * 1.6;
          trees.push({ x: tx, y: gy(tx, tz), z: tz, s: 0.9 + hash2(key, 8, 117) * 0.3, kind: 0, shape: 3, col: 0x7a8a55 });
        }
      }
    };
    // 地面の飾りの向きの帯（農道の轍など）：中心 c から向き u に sA..sB、横に oL..oR。地面に沿わせる
    const strip = (cx: number, cz: number, ux: number, uz: number, sA: number, sB: number, oL: number, oR: number, lift: number, cA: THREE.Color, cB: THREE.Color, mat: number) => {
      const nx = -uz, nz = ux;
      const p = (s: number, o: number): V3 => { const x = cx + ux * s + nx * o, z = cz + uz * s + nz * o; return [x, gy(x, z) + lift, z]; };
      mb.quadC(p(sA, oR), p(sB, oR), p(sB, oL), p(sA, oL), cA, cB, cB, cA, mat);
    };
    // 横にしたロール（干し草）。中心 (x, z)、向き ang
    const bale = (x: number, z: number, ang: number, col: THREE.Color) => {
      const r = 0.75, L = 1.25, y = gy(x, z) + r - 0.05, seg = 8;
      mb.setTransform(ang, x, 0, z);
      mb.matOverride = MAT.none;
      const P2 = (xx: number, th: number): V3 => [xx, y + r * Math.sin(th), r * Math.cos(th)];
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
        mb.quad(P2(-L / 2, a0), P2(L / 2, a0), P2(L / 2, a1), P2(-L / 2, a1), col);
        mb.tri([L / 2, y, 0], P2(L / 2, a1), P2(L / 2, a0), col);
        mb.tri([-L / 2, y, 0], P2(-L / 2, a0), P2(-L / 2, a1), col);
      }
      mb.setTransform(0, 0, 0, 0);
    };
    // 家（切妻屋根）：中心 (lx, lz)、幅 w（棟の向き）、奥行き d、軒の高さ eave、屋根の高さ rise。frame は敷地の向きと中心
    const house = (fa: number, fx: number, fz: number, lx: number, lz: number, e: number, w: number, d: number, base: number, eave: number, rise: number, wall: THREE.Color, roof: THREE.Color, wallPat: number, wallMat: number | null, chimney: boolean) => {
      const cs = Math.cos(fa), sn = Math.sin(fa);
      mb.setTransform(fa + e, fx + lx * cs - lz * sn, 0, fz + lx * sn + lz * cs);
      mb.matOverride = MAT.concrete;
      mb.box(-w / 2, base - 1.2, -d / 2, w / 2, base + 0.4, d / 2, COL.plinth);
      mb.matOverride = wallMat;
      mb.box(-w / 2 + 0.05, base + 0.4, -d / 2 + 0.05, w / 2 - 0.05, base + eave, d / 2 - 0.05, wall, wallPat);
      mb.matOverride = null;
      mb.gableX(-w / 2, -d / 2, w / 2, d / 2, base + eave, rise, roof, wall, 0.45);
      if (chimney) {
        mb.matOverride = MAT.brick;
        const cx = w / 2 - 1.6;
        mb.box(cx - 0.4, base + eave, -0.9, cx + 0.4, base + eave + rise + 1.1, -0.1, COL.chimney);
      }
      mb.matOverride = null;
      mb.setTransform(0, 0, 0, 0);
    };
    // 敷地の座標（正面 = +z）から世界の座標へ
    const frameAng = (f: number) => [-Math.PI / 2, 0, Math.PI / 2, Math.PI][f];
    const toW = (fa: number, fx: number, fz: number, lx: number, lz: number): [number, number] => [fx + lx * Math.cos(fa) - lz * Math.sin(fa), fz + lx * Math.sin(fa) + lz * Math.cos(fa)];

    for (let y = Y0; y < Y1; y++)
      for (let x = X0; x < X1; x++) {
        const i = y * n + x, k = P.kind[i];
        // 区画のふち（東と南の辺は、このマスが受け持つ）
        if (P.edgeE[i] > EF.margin && x + 1 < n) {
          const [ax, az] = J(x + 1, y), [bx, bz] = J(x + 1, y + 1);
          const f = P.kind[i] === OK.field ? i : i + 1;
          edgeLine(ax, az, bx, bz, P.edgeE[i], (x + 1) * 2 * 65599 + y * 2 + 1, P.region[f]);
        }
        if (P.edgeS[i] > EF.margin && y + 1 < n) {
          const [ax, az] = J(x, y + 1), [bx, bz] = J(x + 1, y + 1);
          const f = P.kind[i] === OK.field ? i : i + n;
          edgeLine(ax, az, bx, bz, P.edgeS[i], x * 2 * 65599 + (y + 1) * 2, P.region[f]);
        }
        if (!k) continue;
        const cxw = (x + 0.5) * CELL, czw = (y + 0.5) * CELL;
        const H = (s: number) => hash2(x * 5 + s, y * 7 - s, 120 + s);
        const lane = P.lane[i];
        if (k === OK.meadow) {
          // ---- 草地 ----
          cellTop(x, y, LIFT, [meadowCol(x, y + 1, tmp[0]), meadowCol(x + 1, y + 1, tmp[1]), meadowCol(x + 1, y, tmp[2]), meadowCol(x, y, tmp[3])], MAT.ground);
          const d = P.dist[i];
          // 背の高い草の株（街のすぐそばは刈ってあるので少ない）
          const nt = d <= 1 ? 1 : 3;
          mb.matOverride = MAT.none;
          for (let t = 0; t < nt; t++) {
            const px = (x + 0.1 + H(t) * 0.8) * CELL, pz = (y + 0.1 + H(t + 10) * 0.8) * CELL;
            if (lane) {
              // 農道の上には置かない
              const o = lane - 1, dl = Math.hypot(DX[o], DY[o]);
              if (Math.abs(((px - cxw) * DY[o] - (pz - czw) * DX[o]) / dl) < 5) continue;
            }
            const r = 0.6 + H(t + 20) * 0.7, ht = 0.45 + H(t + 30) * 0.5, b = gy(px, pz) + LIFT - 0.05;
            const col = COL.tuft[Math.floor(H(t + 40) * 3)];
            const top: V3 = [px, b + ht, pz];
            const q: V3[] = [[px + r, b, pz], [px, b, pz + r], [px - r, b, pz], [px, b, pz - r]];
            for (let s = 0; s < 4; s++) mb.tri(q[s], top, q[(s + 1) % 4], col);
          }
          // 野の花（小さな点の集まり）
          if (H(50) < 0.4 && !lane) {
            const fx = (x + 0.2 + H(51) * 0.6) * CELL, fz = (y + 0.2 + H(52) * 0.6) * CELL;
            const fc = COL.flower[Math.floor(H(53) * COL.flower.length)];
            for (let f = 0; f < 6; f++) {
              const px = fx + (H(60 + f) - 0.5) * 5, pz = fz + (H(70 + f) - 0.5) * 5, b = gy(px, pz) + LIFT + 0.18, s = 0.22;
              mb.quad([px - s, b, pz + s], [px + s, b, pz + s], [px + s, b, pz - s], [px - s, b, pz - s], f === 5 ? COL.flower[0] : fc);
            }
          }
          // 低い茂み
          if (H(80) < 0.35 && !lane) {
            const px = (x + 0.15 + H(81) * 0.7) * CELL, pz = (y + 0.15 + H(82) * 0.7) * CELL, b = gy(px, pz);
            const r = 0.9 + H(83) * 0.7, ht = 1.0 + H(84) * 0.9;
            const ring: [number, number][] = [], top: [number, number][] = [];
            for (let s = 0; s < 6; s++) { const a = (s / 6) * Math.PI * 2 + H(85); ring.push([px + Math.cos(a) * r, pz + Math.sin(a) * r]); top.push([px + Math.cos(a) * r * 0.55, pz + Math.sin(a) * r * 0.55]); }
            mb.prism(ring, b - 0.2, b + ht, COL.hedge[Math.floor(H(86) * 4)], PAT.gardenLeaf, COL.hedge[1], top);
          }
          // 街のふちに沿った、ところどころの小さな林（畑の側の辺の生け垣は、畑のマスが受け持つ）
          if (d === 2 && vnoise(x / 5 + 1.3, y / 5 + 2.1, 87) > 0.56 && !lane) {
            const nt2 = 1 + Math.floor(H(90) * 3);
            for (let t = 0; t < nt2; t++) {
              const px = (x + 0.15 + H(91 + t) * 0.7) * CELL, pz = (y + 0.15 + H(95 + t) * 0.7) * CELL;
              trees.push({ x: px, y: gy(px, pz), z: pz, s: 0.95 + H(99 + t) * 0.6, kind: H(103 + t) < 0.15 ? 1 : 0 });
            }
          }
        } else if (k === OK.field) {
          // ---- 畑：草の帯（区画のふち）の上に、内側へ下げた作物の面。ふちに沿って枕地（トラクターが回る帯） ----
          const cd = CROPS[P.crop[i]];
          {
            const mc = (vx: number, vy: number, out: THREE.Color) => out.copy(COL.margin).lerp(COL.marginDry, vnoise(vx / 2.3, vy / 2.3, 311)).multiplyScalar(0.93 + hash2(vx, vy, 312) * 0.12);
            const [a0, a1] = J(x, y + 1), [b0, b1] = J(x + 1, y + 1), [c0, c1] = J(x + 1, y), [d0, d1] = J(x, y);
            mb.quadC([a0, gy(a0, a1) + LIFT, a1], [b0, gy(b0, b1) + LIFT, b1], [c0, gy(c0, c1) + LIFT, c1], [d0, gy(d0, d1) + LIFT, d1], mc(x, y + 1, tmp[0]), mc(x + 1, y + 1, tmp[1]), mc(x + 1, y, tmp[2]), mc(x, y, tmp[3]), MAT.ground);
          }
          if (!lane) {
            const raised = P.turbine[i] ? 0 : cd.h;
            // 4つの辺のふち（東・南・西・北）
            const E = [P.edgeE[i], P.edgeS[i], x > 0 ? P.edgeE[i - 1] : EF.margin, y > 0 ? P.edgeS[i - n] : EF.margin];
            const u0 = INSET[E[2]] / CELL, u1 = 1 - INSET[E[0]] / CELL, v0 = INSET[E[3]] / CELL, v1 = 1 - INSET[E[1]] / CELL;
            const pid = P.parcel[i];
            // 区画ごとの色の違い（同じ作物でも少しずつ違う）
            const tint = new THREE.Color().copy(cd.col).multiplyScalar(0.92 + hash2(pid, 5, 57) * 0.16);
            tint.lerp(COL.dry, (hash2(pid, 6, 58) - 0.5) * 0.12);
            const off = Math.floor(hash2(pid, 7, 59) * 6) * 4;
            const ang = (P.rowX[i] ? Math.PI / 2 : 0) + 0.001;
            const top = LIFT + 0.03 + raised;
            patch(x, y, u0, v0, u1, v1, top, tint, MAT.ground, PAT.field, ang + off, cd.pat);
            if (raised > 0) {
              // 背の高い作物の、区画のふちの側面
              mb.matOverride = MAT.ground;
              const side = (ua: number, va: number, ub: number, vb: number) => {
                const A = Q3(x, y, ua, va, 0), B = Q3(x, y, ub, vb, 0);
                const L = Math.hypot(B[0] - A[0], B[2] - A[2]);
                mb.quad(A, B, [B[0], B[1] + top, B[2]], [A[0], A[1] + top, A[2]], cd.side, PAT.none, L, raised);
              };
              if (E[0]) side(u1, v1, u1, v0);
              if (E[2]) side(u0, v0, u0, v1);
              if (E[1]) side(u0, v1, u1, v1);
              if (E[3]) side(u1, v0, u0, v0);
              mb.matOverride = null;
            }
            // 枕地：ふちに沿った帯は、畝の向きがふちと平行で、色が少し違う（牧草地・刈り取りあとにはない）
            if (cd.pat !== PT.grass && cd.pat !== PT.stubble) {
              const hw = 6 / CELL, hc = tint.clone().multiply(cd.pat === PT.plough ? new THREE.Color(0.86, 0.85, 0.84) : new THREE.Color(0.9, 0.93, 0.82)), lt = top + 0.025;
              const vA = v0 + (E[3] ? hw : 0), vB = v1 - (E[1] ? hw : 0);
              if (E[3]) patch(x, y, u0, v0, u1, Math.min(v1, v0 + hw), lt, hc, MAT.ground, PAT.field, Math.PI / 2 + 0.001 + off, cd.pat);
              if (E[1]) patch(x, y, u0, Math.max(v0, v1 - hw), u1, v1, lt, hc, MAT.ground, PAT.field, Math.PI / 2 + 0.001 + off, cd.pat);
              if (E[2] && vB > vA) patch(x, y, u0, vA, Math.min(u1, u0 + hw), vB, lt, hc, MAT.ground, PAT.field, 0.001 + off, cd.pat);
              if (E[0] && vB > vA) patch(x, y, Math.max(u0, u1 - hw), vA, u1, vB, lt, hc, MAT.ground, PAT.field, 0.001 + off, cd.pat);
            }
            // 干し草のロール（牧草地と刈り取りあと）
            if (cd.bales && !P.turbine[i] && H(130) < (cd.pat === PT.stubble ? 0.28 : 0.1)) {
              const nb = 3 + Math.floor(H(131) * 4);
              const col = cd.pat === PT.stubble ? COL.strawBale : H(132) < 0.5 ? COL.wrapDark : COL.wrapWhite;
              const [bx, bz] = Qw(x, y, 0.3 + H(133) * 0.4, 0.3 + H(134) * 0.4);
              for (let b = 0; b < nb; b++) {
                const row = H(135) < 0.5;
                const px = bx + (row ? (b - nb / 2) * 2.1 : (H(140 + b) - 0.5) * 8), pz = bz + (row ? 0 : (H(150 + b) - 0.5) * 8);
                bale(px, pz, row ? Math.PI / 2 : H(160 + b) * 3, col);
              }
            }
          }
          // 風車
          if (P.turbine[i]) {
            const b = gy(cxw, czw), hub = b + 80;
            mb.matOverride = MAT.gravel;
            mb.box(cxw - 4, b - 0.5, czw - 4, cxw + 4, b + LIFT + 0.12, czw + 4, COL.gravel);
            mb.matOverride = MAT.none;
            mb.cylinder(cxw, czw, b - 0.5, hub - 1.8, 2.1, 14, COL.white, undefined, 1.25);
            // 風は西南西から（羽根は風上を向く）
            const yaw = -2.0;
            mb.setTransform(yaw, cxw, 0, czw);
            mb.box(-1.6, hub - 1.8, -6.5, 1.6, hub + 1.6, 3.6, COL.white, PAT.none, COL.white, true);
            mb.setTransform(0, 0, 0, 0);
            mb.matOverride = null;
            const r = new THREE.Mesh(this.rotor(), this.material);
            r.rotation.order = 'YXZ';
            r.rotation.y = -yaw; // three.js の回転は、MeshBuilder.setTransform と向きが逆
            r.position.set(cxw - Math.sin(yaw) * 4.8, hub, czw + Math.cos(yaw) * 4.8);
            r.userData.phase = hash2(x, y, 170) * 6.28;
            r.castShadow = r.receiveShadow = true;
            rotors.push(r);
          }
        } else if (k === OK.house) {
          // ---- 一軒家 ----
          cellTop(x, y, LIFT, [COL.lawn, COL.lawn, COL.lawn, COL.lawn], MAT.ground);
          const f = P.face[i], fa = frameAng(f);
          const base = g.cellH(x, y);
          const w = 8.5 + H(200) * 2, d = 7 + H(201) * 1.4;
          const two = H(202) < 0.45;
          const wall = COL.walls[Math.floor(H(203) * COL.walls.length)], roof = COL.roofs[Math.floor(H(204) * COL.roofs.length)];
          const ox = (H(205) - 0.5) * 2;
          house(fa, cxw, czw, ox, -0.6, 0, w, d, base, two ? 5.6 : 3.2, d * (two ? 0.5 : 0.62), wall, roof, PAT.house, null, H(206) < 0.7);
          // 玄関から生け垣の入口までの砂利の小道
          {
            const sx = Math.max(-1.5, Math.min(1.5, ox));
            const [ax, az] = toW(fa, cxw, czw, sx, d / 2 - 0.6), [bx, bz] = toW(fa, cxw, czw, sx, 7.6);
            const L = 7.6 - (d / 2 - 0.6), ux = (bx - ax) / L, uz = (bz - az) / L;
            strip(ax, az, ux, uz, 0, L, -0.7, 0.7, LIFT + 0.08, COL.gravel, COL.gravel, MAT.gravel);
          }
          // 庭の生け垣（横と裏。正面は低く、入口をあける）
          {
            mb.setTransform(fa, cxw, 0, czw);
            const hc = COL.hedge[Math.floor(H(209) * 4)];
            const lowBox = (x0: number, z0: number, x1: number, z1: number, ht: number) => {
              const b2 = base;
              mb.matOverride = MAT.none;
              mb.box(x0, b2 - 0.6, z0, x1, b2 + ht, z1, hc, PAT.gardenLeaf);
            };
            lowBox(-7.6, -7.6, -6.6, 7.6, 1.6);
            lowBox(6.6, -7.6, 7.6, 7.6, 1.6);
            lowBox(-6.6, -7.6, 6.6, -6.6, 1.8);
            lowBox(-6.6, 6.8, -2.5, 7.6, 1.0);
            lowBox(2.5, 6.8, 6.6, 7.6, 1.0);
            mb.matOverride = null;
            mb.setTransform(0, 0, 0, 0);
          }
          // 庭の木
          const nt = 1 + (H(210) < 0.4 ? 1 : 0);
          for (let t = 0; t < nt; t++) {
            const [tx, tz] = t ? toW(fa, cxw, czw, (ox > 0 ? -1 : 1) * 4.8, -5.6) : toW(fa, cxw, czw, (H(211) < 0.5 ? -1 : 1) * (4.6 + H(212) * 0.8), 5.4);
            trees.push({ x: tx, y: gy(tx, tz), z: tz, s: 0.6 + H(213 + t) * 0.35, kind: H(215 + t) < 0.2 ? 1 : 0 });
          }
        } else if (k === OK.farm) {
          // ---- 農家（2×2 マス） ----
          const fx = (x + 1) * CELL, fz = (y + 1) * CELL;
          for (let yy = y; yy <= y + 1; yy++) for (let xx = x; xx <= x + 1; xx++) if (g.inb(xx, yy)) cellTop(xx, yy, LIFT, [COL.lawn, COL.lawn, COL.lawn, COL.lawn], MAT.ground);
          let lo = 1e9, hi = -1e9;
          for (let yy = y; yy <= y + 1; yy++) for (let xx = x; xx <= x + 1; xx++) { lo = Math.min(lo, g.cellMinH(xx, yy)); hi = Math.max(hi, g.cellMaxH(xx, yy)); }
          const base = (lo + hi) / 2 + 0.1;
          const fa = frameAng(P.face[i]);
          mb.setTransform(fa, fx, 0, fz);
          // 砂利の庭
          mb.matOverride = MAT.gravel;
          mb.box(-12, lo - 0.3, -5, 3, base + 0.06, 7, COL.yard);
          mb.box(-2.5, lo - 0.3, 7, 2.5, base + 0.04, 16, COL.yard);
          mb.matOverride = null;
          mb.setTransform(0, 0, 0, 0);
          // 母屋（2階建て、急な屋根）
          const wall = COL.walls[Math.floor(H(220) * COL.walls.length)], roof = COL.roofs[Math.floor(H(221) * COL.roofs.length)];
          house(fa, fx, fz, -7, -10, 0, 13, 8, base, 5.8, 5.2, wall, roof, PAT.house, null, true);
          // 納屋（大きく、ゆるい屋根。棟は奥行きの向き）
          const bw = COL.barnWalls[Math.floor(H(222) * COL.barnWalls.length)], br = COL.barnRoofs[Math.floor(H(223) * COL.barnRoofs.length)];
          const wood = bw === COL.barnWalls[0] || bw === COL.barnWalls[3];
          house(fa, fx, fz, 8.5, -3, Math.PI / 2, 22, 12, base, 6.2, 4.2, bw, br, PAT.none, wood ? MAT.siding : null, false);
          {
            // 納屋の大きな戸（庭の側）
            const [dx, dz] = toW(fa, fx, fz, 2.42, -3);
            mb.setTransform(fa, dx, 0, dz);
            mb.matOverride = MAT.siding;
            mb.box(-0.12, base + 0.4, -2.6, 0.12, base + 4.8, 2.6, COL.door);
            mb.matOverride = null;
            mb.setTransform(0, 0, 0, 0);
          }
          // サイロ（ときどき）
          if (H(224) < 0.45) {
            const [sx, sz] = toW(fa, fx, fz, 12, 11.5);
            mb.matOverride = MAT.metal;
            mb.cylinder(sx, sz, base - 0.5, base + 11, 2.5, 14, COL.silo);
            mb.cylinder(sx, sz, base + 11, base + 12.6, 2.5, 14, COL.silo, undefined, 0.3);
            mb.matOverride = null;
          } else {
            // 小さな物置
            house(fa, fx, fz, 11, 12, 0, 6, 4, base, 2.6, 1.3, COL.shed, br, PAT.none, MAT.siding, false);
          }
          // まわりの生け垣（正面の入口はあける）
          {
            const hc = COL.hedge[Math.floor(H(225) * 4)];
            mb.setTransform(fa, fx, 0, fz);
            mb.matOverride = MAT.none;
            const hb = (x0: number, z0: number, x1: number, z1: number) => mb.box(x0, lo - 0.4, z0, x1, base + 2.0, z1, hc, PAT.gardenLeaf);
            hb(-16, -16, 16, -14.8);
            hb(-16, -14.8, -14.8, 16);
            hb(14.8, -14.8, 16, 16);
            hb(-14.8, 14.8, -3, 16);
            hb(3, 14.8, 14.8, 16);
            mb.matOverride = null;
            mb.setTransform(0, 0, 0, 0);
          }
          // 果樹園（リンゴの木）と、母屋のそばの大きな木
          for (let r = 0; r < 2; r++)
            for (let c = 0; c < 3; c++) {
              if (H(230 + r * 3 + c) < 0.15) continue;
              const [tx, tz] = toW(fa, fx, fz, -13 + c * 4.2 + (H(240 + c) - 0.5), 9.5 + r * 4 + (H(245 + r) - 0.5) * 0.6);
              trees.push({ x: tx, y: gy(tx, tz), z: tz, s: 0.42 + H(250 + r * 3 + c) * 0.12, kind: 0, shape: 0, col: 0x5f7f34 });
            }
          for (let t = 0; t < 2; t++) {
            const [tx, tz] = toW(fa, fx, fz, t ? -14.5 : 1.5, t ? -3 : -14.2);
            trees.push({ x: tx, y: gy(tx, tz), z: tz, s: 1.2 + H(260 + t) * 0.4, kind: 0, shape: 3 });
          }
        }

        // ---- 農道（行き止まりの道の先）：草の帯の上に砂利の轍。先へ行くほど細く、草にうもれる ----
        if (lane) {
          const o = lane - 1, step = P.laneStep[i], len = P.laneLen[i];
          const dl = Math.hypot(DX[o], DY[o]), ux = DX[o] / dl, uz = DY[o] / dl, cl = CELL * dl;
          // 道路のマスの中心
          const rx = (x - DX[o] * step + 0.5) * CELL, rz = (y - DY[o] * step + 0.5) * CELL;
          const total = len * cl + cl * 0.3;
          const sA = step === 1 ? 5 : (step - 0.5) * cl, sB = step === len ? total : (step + 0.5) * cl;
          const mid = (sA + sB) / 2;
          const wid = (s: number) => 3.4 - 1.4 * Math.min(1, s / total);
          const grass = (s: number) => Math.min(1, Math.max(0, (s / total - 0.15) * 1.6));
          const cA = new THREE.Color(), cB = new THREE.Color();
          for (const [a, b] of [[sA, mid], [mid, sB]]) {
            // 草の帯（両側の路肩）
            strip(rx, rz, ux, uz, a, b, -4, 4, LIFT + 0.08, COL.verge, COL.verge, MAT.ground);
            // 轍：根元は全面の砂利、先へ行くと中ほどに草が生え、最後は草の色に近づく
            const fa2 = Math.min(1, Math.max(0, (a / total - 0.7) / 0.3)), fb2 = Math.min(1, Math.max(0, (b / total - 0.7) / 0.3));
            cA.copy(COL.gravel).lerp(COL.gravelEnd, fa2);
            cB.copy(COL.gravel).lerp(COL.gravelEnd, fb2);
            const gm = (grass(a) + grass(b)) / 2 * 0.9;
            const wa = (wid(a) + wid(b)) / 4;
            if (gm < 0.05) strip(rx, rz, ux, uz, a, b, -wa, wa, LIFT + 0.15, cA, cB, MAT.gravel);
            else {
              strip(rx, rz, ux, uz, a, b, -wa, -gm, LIFT + 0.15, cA, cB, MAT.gravel);
              strip(rx, rz, ux, uz, a, b, gm, wa, LIFT + 0.15, cA, cB, MAT.gravel);
            }
          }
          // ポプラ並木（道の両側。最後のマスには植えない）
          if (step < len) {
            const sp = dl > 1.2 ? cl / 2 : 8;
            for (let s = (step - 0.5) * cl + sp / 2; s < (step + 0.5) * cl; s += sp) {
              if (s < 10) continue;
              for (const side of [-1, 1]) {
                const tx = rx + ux * s - uz * side * 5.4, tz = rz + uz * s + ux * side * 5.4;
                const tcx = Math.floor(tx / CELL), tcz = Math.floor(tz / CELL);
                if (!g.inb(tcx, tcz) || !P.kind[tcz * n + tcx]) continue;
                const hs = hash2(Math.round(tx), Math.round(tz), 180);
                trees.push({ x: tx, y: gy(tx, tz), z: tz, s: 2.0 + hs * 0.45, kind: 0, shape: 2, col: hs < 0.5 ? 0x5d7f35 : 0x66883a });
              }
            }
          }
        }
      }
    mb.matOverride = null;
    const ch: Chunk = { sig: 0, mesh: null, rotors, trees, tris: 0 };
    if (mb.vertexCount) {
      const m = new THREE.Mesh(mb.toGeometry(), this.material);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      ch.mesh = m;
      ch.tris = mb.idx.length / 3;
    }
    for (const r of rotors) { this.group.add(r); ch.tris += (this.rotorGeo!.index!.count / 3); }
    return ch;
  }
}
