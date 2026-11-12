// 空港の動かない形：芝生、滑走路・誘導路・駐機場の舗装と路面の表示（実際の規格どおり）、ターミナル（木とガラスの大屋根）、
// 屋上の展望デッキ、管制塔、空港ホテルとオフィス、駐車場ビル、空港駅、高架の出発ロビー前の道路、格納庫（中に機体）、
// 燃料タンク、空港の消防署、貨物上屋。それと夜の灯火の位置と色（灯火は lights.ts でまとめて 1 回で描く）。
// 形は敷地の座標（a = 滑走路の向き、c = 横、+c が陸側）で作り、MeshBuilder の変換で世界の座標にする。
import * as THREE from 'three';
import { MeshBuilder, PAT } from '../builder';
import { MAT } from '../textures';
import { CELL } from '../../sim/constants';
import { AcKind, AirFrame, AirportLayout, LRect, rotAngle, runwayNumber, standDir, standLaneBack, standPt, standTailBack } from '../../sim/airport';
import type { TreeSpot } from '../buildingGen';
import { buildAircraft, LIVERIES } from './aircraft';
import { Rng } from '../../sim/rng';
import type { FcPlan } from '../../sim/forecourt';

const C = (h: number) => new THREE.Color(h);
const COL = {
  grass: C(0x7f9f55), grass2: C(0x8aa95e), grassCell: C(0x7a9a52),
  asph: C(0x35383c), asphRw: C(0x2e3134), shoulder: C(0x6a6d70), taxi: C(0x3c3f43), apron: C(0xaeaca6), apronJoint: C(0x9a9892),
  white: C(0xf1f1ec), yellow: C(0xe9b72a), red: C(0xc8342c), blackOutline: C(0x1d1e20),
  road: C(0x3a3c40), curb: C(0xb9b5ad), walk: C(0xc9c4ba),
  glass: C(0x6f93ad), wood: C(0xb07a48), woodDark: C(0x7a5232), roofTop: C(0xc6cacd), steel: C(0xdfe3e6), steelDark: C(0x7c8288),
  concrete: C(0xc4c0b6), concreteDark: C(0x9a968e), towerWhite: C(0xeceeee), cabGlass: C(0x3e5f6f),
  hotel: C(0xb8a58a), office: C(0xe6e6e2), carpark: C(0xc9c5bd), hangar: C(0xd2d6da), tank: C(0xe9ebec), fire: C(0xb8312b), cargo: C(0x9fa7ae),
  rail: C(0xd8dadc), platform: C(0xcfcac0),
};

// 夜の灯火の種類と色（実際の規格の色。加算で光らせるので明るめ）
export const LIGHT = {
  edge: [1.0, 0.93, 0.78], // 滑走路の縁（白）
  thr: [0.25, 1.0, 0.45], // 滑走路の手前の端（緑）
  end: [1.0, 0.16, 0.1], // 滑走路の奥の端（赤）
  clWhite: [0.95, 0.95, 0.9],
  clRed: [1.0, 0.16, 0.1],
  txEdge: [0.2, 0.42, 1.0], // 誘導路の縁（青）
  txCl: [0.25, 1.0, 0.45], // 誘導路の中心線（緑）
  appr: [1.0, 0.95, 0.82], // 進入灯
  papiW: [1.0, 0.97, 0.9],
  papiR: [1.0, 0.16, 0.1],
  flood: [1.0, 0.86, 0.66], // エプロンの照明塔
  street: [1.0, 0.8, 0.55],
} as const;

export interface AirGeo {
  mb: MeshBuilder;
  // 灯火：x, y, z, r, g, b, 大きさ（7 つずつ。世界の座標）
  lights: number[];
  // 滑走路の中心線灯（向きで色が変わる）：lights の中の番号と、敷地の a
  centre: { idx: number; a: number; rw: number }[];
  beacons: number[]; // 航空障害灯（x, y, z）
  pools: number[]; // 地面を照らす光（x, y, z, 大きさ）
  trees: TreeSpot[];
}
// 門のマス（敷地の外）：中心（敷地の座標）、外へ向かう向き、つながっているもの（都市高速・一般道）、路面の高さ（敷地の地面から）
export interface GateCtx { a: number; c: number; da: number; dc: number; kind: 'hw' | 'road' | null; h: number; diag: boolean }
export interface AirCtx {
  cells: number[]; // 敷地のマス
  n: number;
  base: number;
  seed: number;
  gate: GateCtx | null; // 正門
  svc: GateCtx | null; // 通用門
  lines: string[]; // 空港駅につながっている線
  fc: FcCtx | null; // ターミナル前の道路（フォアコート）
}
// フォアコート：計画（land の座標の列）と、正門の階・高架の高さ
export interface FcCtx { plan: FcPlan; pts: Map<string, [number, number, number][]> }

// 7 セグメントの数字（滑走路の番号、駐機スポットの番号）。[u0, v0, u1, v1]（幅 1、高さ 2 の中で）
const SEG: Record<string, number[][]> = {};
{
  const s = 0.28;
  const S = {
    a: [0, 2 - s, 1, 2], b: [1 - s, 1, 1, 2], c: [1 - s, 0, 1, 1], d: [0, 0, 1, s], e: [0, 0, s, 1], f: [0, 1, s, 2], g: [0, 1 - s / 2, 1, 1 + s / 2],
  };
  const D: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', L: 'fed', R: 'abgfe', C: 'afed' };
  for (const k in D) SEG[k] = [...D[k]].map((ch) => S[ch as keyof typeof S]);
}

export function buildAirportGeometry(L: AirportLayout, f: AirFrame, ctx: AirCtx): AirGeo {
  const mb = new MeshBuilder();
  const out: AirGeo = { mb, lights: [], centre: [], beacons: [], pools: [], trees: [] };
  const rng = new Rng(ctx.seed);
  const base = ctx.base;
  const A = L.A, Cw = L.C;
  const ang = rotAngle(f.rot);
  // 陸側（道路・駅・ターミナル）は、敷地の中で回した座標（land）で作る。T = いまの座標 → 敷地の座標
  const land = L.land, lco = Math.cos(land.rot), lsi = Math.sin(land.rot);
  const toLot = (a: number, c: number): [number, number] => [land.oa + a * lco - c * lsi, land.oc + a * lsi + c * lco];
  let T = (a: number, c: number): [number, number] => [a, c];
  const W = (a0: number, y: number, c0: number): [number, number, number] => {
    const [a, c] = T(a0, c0);
    return [a * f.cos - c * f.sin + f.cx, y + base, a * f.sin + c * f.cos + f.cz];
  };
  const light = (a: number, y: number, c: number, col: readonly number[], size: number) => {
    const p = W(a, y, c);
    out.lights.push(p[0], p[1], p[2], col[0], col[1], col[2], size);
  };
  const pool = (a: number, c: number, y: number, size: number) => { const p = W(a, y, c); out.pools.push(p[0], p[1], p[2], size); };
  const beacon = (a: number, y: number, c: number) => { const p = W(a, y, c); out.beacons.push(p[0], p[1], p[2]); };
  const tree = (a: number, c: number, s = 1, kind = 0) => { const p = W(a, 0, c); out.trees.push({ x: p[0], y: base, z: p[2], s, kind }); };
  // ---- 敷地のマスの芝生（斜めの敷地の、長方形からはみ出す階段状のふち） ----
  mb.setTransform(0, 0, base, 0);
  if (f.rot & 1) for (const i of ctx.cells) {
    const x = i % ctx.n, y = (i / ctx.n) | 0;
    mb.ground(x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL, 0.03, COL.grassCell);
  }
  mb.setTransform(ang, f.cx, base, f.cz);
  const useLot = () => { T = (a, c) => [a, c]; mb.setTransform(ang, f.cx, base, f.cz); };
  const useLand = () => { useLot(); const o = W(land.oa, 0, land.oc); T = toLot; mb.setTransform(ang + land.rot, o[0], base, o[2]); };
  // 区画の中心で 180° 回す（貨物上屋・消防署の向き）。返す区画は中心が原点
  const useFlip = (r: LRect): LRect => {
    const o = W((r.a0 + r.a1) / 2, 0, (r.c0 + r.c1) / 2), ha = (r.a1 - r.a0) / 2, hc = (r.c1 - r.c0) / 2;
    mb.setTransform(ang + Math.PI, o[0], base, o[2]);
    return { a0: -ha, c0: -hc, a1: ha, c1: hc };
  };
  const G = (a0: number, c0: number, a1: number, c1: number, y: number, col: THREE.Color) => mb.ground(Math.min(a0, a1), Math.min(c0, c1), Math.max(a0, a1), Math.max(c0, c1), y, col);
  // 線（折れ線、幅 w）
  const pline = (pts: [number, number][], w: number, y: number, col: THREE.Color) => {
    mb.matOverride = MAT.ground;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a0, c0] = pts[i], [a1, c1] = pts[i + 1];
      const l = Math.hypot(a1 - a0, c1 - c0) || 1, na = (-(c1 - c0) / l) * w / 2, nc = ((a1 - a0) / l) * w / 2;
      const p = [[a0 - na, c0 - nc], [a1 - na, c1 - nc], [a1 + na, c1 + nc], [a0 + na, c0 + nc]];
      // 上向きの面になるよう、回りの向きをそろえる
      const cross = (p[1][0] - p[0][0]) * (p[3][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[3][0] - p[0][0]);
      const q = cross > 0 ? [p[0], p[3], p[2], p[1]] : p;
      mb.quad([q[0][0], y, q[0][1]], [q[1][0], y, q[1][1]], [q[2][0], y, q[2][1]], [q[3][0], y, q[3][1]], col);
    }
    mb.matOverride = null;
  };
  const arc = (ca: number, cc: number, r: number, a0: number, a1: number, k = 10): [number, number][] => {
    const pts: [number, number][] = [];
    for (let j = 0; j <= k; j++) { const t = a0 + ((a1 - a0) * j) / k; pts.push([ca + Math.cos(t) * r, cc + Math.sin(t) * r]); }
    return pts;
  };
  // 上向きの三角形（回りの向きをそろえる）
  const triUp = (p: [number, number][], y: number, col: THREE.Color) => {
    const cross = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    const q = cross > 0 ? [p[0], p[2], p[1]] : p;
    mb.matOverride = MAT.ground;
    mb.tri([q[0][0], y, q[0][1]], [q[1][0], y, q[1][1]], [q[2][0], y, q[2][1]], col);
    mb.matOverride = null;
  };
  // 数字（7 セグメント）：文字の下の端の a、左の端の c、文字の高さ h、読む向き（+1 = a の増える向きを向いて読む）
  const digit = (ch: string, a0: number, c0: number, h: number, dir: number, y: number, col: THREE.Color) => {
    const segs = SEG[ch];
    if (!segs) return;
    const s = h / 2;
    for (const [u0, v0, u1, v1] of segs) G(a0 + dir * v0 * s, c0 + dir * u0 * s * 0.55, a0 + dir * v1 * s, c0 + dir * u1 * s * 0.55, y, col);
  };
  const text = (str: string, aBot: number, cMid: number, h: number, dir: number, y: number, col: THREE.Color) => {
    const cw = h * 0.5 * 0.55, gap = h * 0.18, total = str.length * cw + (str.length - 1) * gap;
    let c = cMid - (dir * total) / 2;
    for (const ch of str) { digit(ch, aBot, c, h, dir, y, col); c += dir * (cw + gap); }
  };

  // ---- 芝生（刈り込みのしま） ----
  G(-A / 2, -Cw / 2, A / 2, Cw / 2, 0.05, COL.grass);
  for (let a = -A / 2 + 10; a < A / 2 - 10; a += 40) G(a, -Cw / 2 + 2, a + 20, 30, 0.055, COL.grass2);

  // ---- 滑走路（1 本または平行な 2 本）。s = 誘導路のある側（+1 = +c）、u = 滑走路の中心から誘導路の側への距離 ----
  const tw = L.taxiW;
  L.runways.forEach((rw, ri) => {
  const rc = rw.c, rwW = rw.width, hw = rwW / 2, s = rw.side >= 0 ? 1 : -1, tU = s * (rw.taxiC - rc);
  const cu = (u: number) => rc + s * u;
  // ---- 滑走路：路肩、舗装、両端の過走帯（黄色の山形） ----
  G(rw.a0 - 32, Math.max(-Cw / 2, rc - hw - 4), rw.a1 + 32, Math.min(Cw / 2, rc + hw + 4), 0.08, COL.shoulder);
  G(rw.a0, rc - hw, rw.a1, rc + hw, 0.1, COL.asphRw);
  for (const [end, dir] of [[rw.a0, 1], [rw.a1, -1]] as const) {
    G(end - dir * 30, rc - hw, end, rc + hw, 0.1, COL.asph);
    for (let k = 0; k < 3; k++) {
      const a = end - dir * (6 + k * 9);
      pline([[a - dir * 8, rc - hw + 1.5], [a, rc], [a - dir * 8, rc + hw - 1.5]], 1.2, 0.14, COL.yellow);
    }
  }
  // 縁の線（白）
  G(rw.a0, rc - hw + 0.3, rw.a1, rc - hw + 1.2, 0.14, COL.white);
  G(rw.a0, rc + hw - 1.2, rw.a1, rc + hw - 0.3, 0.14, COL.white);
  const numA = runwayNumber(f.cos, f.sin), numB = runwayNumber(-f.cos, -f.sin);
  for (const [end, dir, num] of [[rw.a0, 1, numA], [rw.a1, -1, numB]] as const) {
    // 進入端の標識（ピアノキー）：幅 30m の滑走路は 8 本、45m は 12 本
    const keys = rwW >= 45 ? [2.7, 6.3, 9.9, 13.5, 17.1, 20.7] : [2.7, 6.3, 9.9, 13.5];
    for (const o of keys) for (const sd of [-1, 1]) G(end + dir * 6, rc + sd * o - 0.9, end + dir * 36, rc + sd * o + 0.9, 0.14, COL.white);
    // 滑走路の番号（高さ 9m）
    text(num, end + dir * 48, rc, 9, dir, 0.14, COL.white);
    // 平行な滑走路：着陸する向きから見て左（L）・右（R）
    if (L.runways.length > 1) text((dir > 0) === (rc < 0) ? 'L' : 'R', end + dir * 61, rc, 9, dir, 0.14, COL.white);
    // 接地帯の標識（150m ごと）と、目標点の標識（滑走路 1,200m 以上は 300m、それより短いと 250m）
    const len = rw.a1 - rw.a0, k = rwW / 30, aim = len >= 1200 ? 300 : 250;
    for (const sd of [-1, 1]) {
      for (let z = 150; z < Math.min(len / 2, 600); z += 150) {
        if (Math.abs(z - aim) < 60) continue;
        for (const o of [5.0, 8.4]) G(end + dir * z, rc + sd * o * k - 0.9, end + dir * (z + 22.5), rc + sd * o * k + 0.9, 0.14, COL.white);
      }
      G(end + dir * aim, rc + sd * 7.5 * k - 2 * k, end + dir * (aim + 45), rc + sd * 7.5 * k + 2 * k, 0.14, COL.white);
    }
  }
  // 中心線（30m の線と 20m のすき間）
  for (let a = rw.a0 + 70; a + 30 <= rw.a1 - 70; a += 50) G(a, rc - 0.45, a + 30, rc + 0.45, 0.14, COL.white);

  for (const la of rw.links) {
    G(la - tw / 2, cu(hw), la + tw / 2, cu(tU + tw / 2), 0.1, COL.taxi);
    // 角を広げる（隅切り）
    for (const sd of [-1, 1]) {
      const a1 = la + sd * tw / 2, ut = tU - tw / 2;
      triUp([[a1, cu(ut)], [a1 + sd * 12, cu(ut)], [a1, cu(ut - 12)]], 0.1, COL.taxi);
      triUp([[a1, cu(hw)], [a1, cu(hw + 10)], [a1 + sd * 10, cu(hw)]], 0.1, COL.taxi);
    }
    // 中心線（黄色）：滑走路の中心線から曲がって誘導路へ
    const inward = la < 0 ? 1 : -1;
    pline([[la, rc], ...arc(la + inward * 14, tU - 14, 14, inward > 0 ? Math.PI : 0, Math.PI / 2).map(([a, u]) => [a, cu(u)] as [number, number])], 0.3, 0.14, COL.yellow);
    // 滑走路の手前の停止位置（実線 2 本・破線 2 本。実線が誘導路の側）
    const hU = s * (rw.holdC - rc);
    for (const o of [0, 0.9]) G(la - tw / 2, cu(hU + 2.7 + o), la + tw / 2, cu(hU + 2.7 + o + 0.3), 0.14, COL.yellow);
    for (const o of [0, 0.9]) for (let a = la - tw / 2; a < la + tw / 2 - 0.5; a += 1.8) G(a, cu(hU + o), a + 0.9, cu(hU + o + 0.3), 0.14, COL.yellow);
    // 停止位置の標識（赤地）
    for (const sd of [-1, 1]) {
      const a = la + sd * (tw / 2 + 3), q0 = cu(hU + 1.4), q1 = cu(hU + 1.6), r0 = cu(hU + 1.3), r1 = cu(hU + 1.7);
      mb.box(a - 0.1, 0.1, Math.min(q0, q1), a + 0.1, 0.6, Math.max(q0, q1), COL.steelDark);
      mb.box(a - 1.4, 0.6, Math.min(r0, r1), a + 1.4, 1.6, Math.max(r0, r1), COL.red);
    }
  }
  // 高速脱出誘導路：滑走路から斜めに平行誘導路へ。中心線は滑走路の中心線から分かれる
  for (const e of rw.exits) {
    if (!e.rapid) continue;
    const [p0, p1, p2, p3] = e.pts;
    pline([[p1[0] - e.dir * 10, p1[1]], p2, p3], tw, 0.1, COL.taxi);
    pline([[p0[0], p0[1]], [p1[0], p1[1] + 0.5], [p2[0], p2[1]], p3], 0.3, 0.14, COL.yellow);
    // 出口の案内灯（緑と黄色の交互、実際の規格）
    const n = 10;
    for (let k = 1; k < n; k++) {
      const t = k / n, a = p1[0] + (p2[0] - p1[0]) * t, c = p1[1] + (p2[1] - p1[1]) * t;
      light(a, 0.2, c, k % 2 && t < 0.5 ? [1.0, 0.8, 0.2] : LIGHT.txCl, 2.4);
    }
  }

  // 吹き流し（滑走路の横）
  for (const a of [rw.a0 + 150, rw.a1 - 150]) {
    const c = cu(hw + 14);
    mb.cylinder(a, c, 0.05, 6, 0.08, 6, COL.steelDark);
    for (let k = 0; k < 5; k++) mb.cylinder(a + 0.6 + k * 0.7, c, 5.4 - k * 0.03, 6.0 - k * 0.03, 0.42 - k * 0.06, 8, k % 2 ? COL.white : C(0xf26b1d), undefined, 0.4 - k * 0.06);
  }

  // 夜の灯火
  // 滑走路の縁（白、50m ごと）、手前の端（緑）、奥の端（赤）、中心線（15m ごと）
  for (let a = rw.a0; a <= rw.a1 + 0.1; a += 50) for (const sd of [-1, 1]) light(a, 0.4, rc + sd * (hw + 1.5), LIGHT.edge, 4);
  for (const [end, dir] of [[rw.a0, 1], [rw.a1, -1]] as const) {
    for (let c = -hw; c <= hw + 0.1; c += 3) {
      light(end - dir * 1.0, 0.35, rc + c, LIGHT.thr, 4.2);
      light(end + dir * 0.6, 0.35, rc + c, LIGHT.end, 3.6);
      mb.box(end - dir * 1.0 - 0.2, 0.1, rc + c - 0.2, end - dir * 1.0 + 0.2, 0.35, rc + c + 0.2, COL.steelDark);
    }
    // 進入灯：滑走路の手前にのびる光の列（15m ごと）と横の列（クロスバー）
    for (let k = 1; k * 15 < (A / 2 - Math.abs(end)) - 2; k++) {
      const a = end - dir * k * 15;
      for (const o of [-1.6, -0.8, 0, 0.8, 1.6]) light(a, 1.2, rc + o, LIGHT.appr, 4.5);
      if (k === 3) for (let o = -12; o <= 12; o += 1.5) if (Math.abs(o) > 2) light(a, 1.2, rc + o, LIGHT.appr, 4.5);
      mb.box(a - 0.15, 0, rc - 2, a + 0.15, 1.1, rc + 2, COL.steelDark);
      if (k === 3) mb.box(a - 0.15, 0.9, rc - 12.5, a + 0.15, 1.1, rc + 12.5, COL.steelDark);
    }
    // PAPI（進入角の指示灯）：着陸する向きの左側に 4 つ。正しい角度なら白 2・赤 2
    for (let k = 0; k < 4; k++) {
      const a = end + dir * 250, c = rc - dir * (hw + 3 + k * 3);
      mb.box(a - 0.6, 0, c - 0.6, a + 0.6, 0.9, c + 0.6, COL.white);
      light(a - dir * 0.7, 0.6, c, k < 2 ? LIGHT.papiR : LIGHT.papiW, 4.5);
    }
  }
  for (let a = rw.a0 + 7.5; a < rw.a1; a += 15) {
    out.centre.push({ idx: out.lights.length / 7, a, rw: ri });
    light(a, 0.25, rc, LIGHT.clWhite, 2.6);
  }
  for (const la of rw.links) {
    for (let u = hw + 6; u < tU - 6; u += 7) light(la, 0.2, cu(u), LIGHT.txCl, 2.4);
    for (let u = hw + 4; u < tU - tw / 2; u += 12) for (const sd of [-1, 1]) light(la + sd * (tw / 2 + 1), 0.4, cu(u), LIGHT.txEdge, 3);
  }
  });

  // ---- 誘導路の網（平行誘導路・エプロンの誘導路・つなぎ）、取付誘導路、高速脱出誘導路 ----
  const net = L.net;
  const onApron = (a: number, c: number) => L.aprons.some((ap) => a > ap.a0 + 1 && a < ap.a1 - 1 && c > ap.c0 + 1 && c < ap.c1 - 1);
  const isLink = (i: number, j: number) => L.runways.some((rw) => rw.links.some((la) => Math.abs(net.nodes[i][0] - la) < 0.5 && Math.abs(net.nodes[j][0] - la) < 0.5 && Math.abs(net.nodes[i][1] - net.nodes[j][1]) > 0.5));
  net.edges.forEach(([i, j], q) => {
    if (isLink(i, j)) return;
    const [a0, c0] = net.nodes[i], [a1, c1] = net.nodes[j], w = net.width[q];
    const l = Math.hypot(a1 - a0, c1 - c0) || 1, ua = (a1 - a0) / l, uc = (c1 - c0) / l, e = w / 2;
    // エプロンにかかるところは、エプロンの舗装（少し上）が上に重なる
    if (!(onApron(a0, c0) && onApron(a1, c1))) pline([[a0 - ua * e, c0 - uc * e], [a1 + ua * e, c1 + uc * e]], w, 0.092, COL.taxi);
    pline([[a0, c0], [a1, c1]], 0.3, 0.14, COL.yellow);
  });
  // ---- エプロン（駐機場）：コンクリート舗装と目地 ----
  for (const ap of L.aprons) {
    G(ap.a0, ap.c0, ap.a1, ap.c1, 0.1, COL.apron);
    for (let a = ap.a0 + 7.5; a < ap.a1; a += 7.5) G(a - 0.08, ap.c0, a + 0.08, ap.c1, 0.115, COL.apronJoint);
    for (let c = ap.c0 + 7.5; c < ap.c1; c += 7.5) G(ap.a0, c - 0.08, ap.a1, c + 0.08, 0.115, COL.apronJoint);
  }
  // 誘導路とエプロンの境：エプロンの縁の線
  // 駐機スポット：誘導路の中心線から曲がって入る誘導線、停止線、番号、機材の置き場の赤い線。
  // 形は「機首が +c を向くスポット」の座標（a = スポットの中心線 + 横、c = 機首 − 後ろ）で書き、スポットの向きへ回す
  L.stands.forEach((st, k) => {
    const R = st.wide ? 24 : 18, lc = st.noseC - standLaneBack(L, st), sc0 = lc + R;
    const D = ([a, c]: [number, number]): [number, number] => standPt(st, st.noseC - c, a - st.a);
    const ln = (pts: [number, number][], w: number, col: THREE.Color) => pline(pts.map(D), w, 0.14, col);
    ln([[st.a - R, lc], ...arc(st.a - R, lc + R, R, -Math.PI / 2, 0, 10), [st.a, st.noseC - 2]], 0.3, COL.yellow);
    ln([[st.a + R, lc], ...arc(st.a + R, lc + R, R, -Math.PI / 2, -Math.PI, 10), [st.a, sc0]], 0.3, COL.yellow);
    ln([[st.a - 2.5, st.noseC], [st.a + 2.5, st.noseC]], 0.6, COL.white); // 停止線
    ln([[st.a - 0.6, st.noseC - 4], [st.a + 0.6, st.noseC - 4]], 0.6, COL.white); // 小さい機材の停止線
    if (st.wide) ln([[st.a - 2.5, st.noseC - 2], [st.a + 2.5, st.noseC - 2]], 0.6, COL.white);
    const [na, nc] = D([st.a + 5, sc0 + 4]);
    text(String(k + 1), na - 2, nc, 4, 1, 0.14, COL.yellow);
    // 機材を置く場所の赤い線（スポットの両わき）
    const half = st.wide ? 32 : 22;
    if (!st.cargo) for (const sd of [-1, 1]) ln([[st.a + sd * half, Math.max(lc + 10, st.noseC - 95)], [st.a + sd * half, st.noseC + 1]], 0.3, COL.red);
  });
  // 構内道路（エプロンの、ターミナルの前）：白い縁と破線、乗客が歩く横断歩道
  if (Number.isFinite(L.serviceC)) {
    const sv = L.serviceC, ap = L.aprons[0];
    G(ap.a0, sv - 3.3, ap.a1, sv - 3.0, 0.14, COL.white);
    G(ap.a0, sv + 3.0, ap.a1, sv + 3.3, 0.14, COL.white);
    for (let a = ap.a0 + 2; a < ap.a1 - 3; a += 6) G(a, sv - 0.1, a + 3, sv + 0.1, 0.14, COL.white);
    if (L.walk) for (const st of L.stands) {
      if (st.cargo) continue;
      for (let a = st.a + 4.5; a < st.a + 10.5; a += 1.2) G(a, sv - 3, a + 0.6, sv + 3, 0.141, COL.white);
    }
  }

  // 大：エプロンのふちの構内道路と、スポットの列ごとの尾翼の後ろの道路（白い縁と破線）
  if (L.gseRoad !== undefined) {
    const pr = L.gseRoad, road = (pts: [number, number][]) => {
      pline(pts, 7, 0.118, C(0x8e8c86));
      pline(pts, 0.2, 0.142, COL.white);
    };
    const tails = new Map<number, [number, number]>();
    for (const st of L.stands) {
      const [ua, uc] = st.dir ?? [0, 1];
      if (uc !== 0) continue;
      const a = standPt(st, standTailBack(L, st), 0)[0], key = Math.round(a);
      const t = tails.get(key) ?? [Infinity, -Infinity];
      tails.set(key, [Math.min(t[0], st.noseC - 40), Math.max(t[1], st.noseC + 40)]);
      void ua;
    }
    let a0 = Infinity, a1 = -Infinity;
    for (const [a, [c0]] of tails) { road([[a, Math.max(c0, -pr)], [a, pr]]); a0 = Math.min(a0, a); a1 = Math.max(a1, a); }
    for (const st of L.stands) if (st.cargo) a1 = Math.max(a1, st.a + 40);
    a0 = Math.min(a0, L.depot[0]);
    road([[a0 - 3.5, pr], [a1, pr]]);
  }

  // ---- 通用門と構内道路（貨物・整備地区。敷地の座標） ----
  {
    const svcRoad = (pts: [number, number][]) => {
      pline(pts, 7, 0.115, COL.road);
      pline(pts, 0.15, 0.142, COL.white);
    };
    if (ctx.svc) svcRoad([[ctx.svc.a, ctx.svc.c], L.svcRoads[0][0]]);
    for (const r of L.svcRoads) svcRoad(r);
    // 通用門の門扉と守衛所
    const [ga0, gc0] = L.svcRoads[0][0], [ga1, gc1] = L.svcRoads[0][1], gl = Math.hypot(ga1 - ga0, gc1 - gc0) || 1;
    const ia = (ga1 - ga0) / gl, ic = (gc1 - gc0) / gl, pa = -ic, pc = ia;
    const ba = ga0 + ia * 6, bc = gc0 + ic * 6;
    mb.box(Math.min(ba + pa * 5, ba + pa * 8) - 1.5, 0, Math.min(bc + pc * 5, bc + pc * 8) - 1.5, Math.max(ba + pa * 5, ba + pa * 8) + 1.5, 3.2, Math.max(bc + pc * 5, bc + pc * 8) + 1.5, COL.office, PAT.office, COL.concrete);
    pline([[ba - pa * 3.4, bc - pc * 3.4], [ba + pa * 3.4, bc + pc * 3.4]], 0.25, 1.1, COL.red);
  }

  // ---- 陸側（land の座標）：ターミナル前の道路（フォアコート）の車寄せの歩道・屋根・橋脚・標識・植え込み ----
  // 道路そのもの（路面・車線・欄干・高架の床版）は道路の層が、街の都市高速と同じ作りで描く
  useLand();
  const fi = ctx.fc ? fcInfo(L, ctx.fc) : null;
  if (ctx.fc && fi) forecourtFeatures(mb, L, ctx.fc, fi, { light, pool, tree, G, pline, rng });

  useLot();

  // ---- 建物 ----
  for (const bd of L.buildings) {
    if (bd.sub) useLand(); else useLot();
    const r = bd.flip ? useFlip(bd.r) : bd.r;
    switch (bd.kind) {
      case 'pier': pier(mb, r, bd.h, rng, L); break;
      case 'concourse': concourse(mb, r, bd.h, L, light); break;
      case 'terminal': terminal(mb, r, bd.h, L, light, fi); break;
      case 'tower': tower(mb, r, bd.h, L, beacon); break;
      case 'hotel': hotel(mb, r, bd.h, beacon); break;
      case 'office': office(mb, r, bd.h, beacon); break;
      case 'carpark': carpark(mb, r, bd.h, rng); break;
      case 'station': station(mb, r, bd.h, L, ctx.lines, fi); break;
      case 'plaza': plaza(mb, r, rng, tree, light); break;
      case 'hangar': hangar(mb, r, bd.h, bd.ac ?? L.hangarType, beacon, light, (a, c, rot) => mb.setTransform(ang + rot, a * f.cos - c * f.sin + f.cx, base + 0.12, a * f.sin + c * f.cos + f.cz), () => mb.setTransform(ang, f.cx, base, f.cz)); break;
      case 'fuel': fuel(mb, r); break;
      case 'fire': fireStation(mb, r, bd.h); break;
      case 'cargo': cargo(mb, r, bd.h, rng); break;
    }
  }
  useLot();
  // 駐機場の車両の車庫（使っていない車）
  {
    const [da, dc] = L.depot;
    G(da - 22, dc - 12, da + 30, dc + 14, 0.13, C(0xa5a39d));
    for (let k = 0; k < 5; k++) G(da - 20 + k * 10, dc - 11, da - 19.85 + k * 10, dc + 13, 0.14, COL.white);
    for (let k = 0; k < 4; k++) mb.box(da - 18 + k * 10, 0.1, dc - 8, da - 15 + k * 10, 1.5, dc - 2, k % 2 ? C(0xf2c230) : C(0xe8772e));
    mb.box(da + 14, 0.1, dc - 9, da + 16.6, 3.2, dc + 4, C(0xe9ebec));
    mb.box(da + 19, 0.1, dc - 9, da + 21.6, 3.2, dc + 4, C(0xe9ebec));
  }
  // ---- 夜の灯火 ----
  // 誘導路の縁（青、30m ごと。エプロンの上はなし）と中心線（緑、15m ごと）
  net.edges.forEach(([i, j], q) => {
    if (isLink(i, j)) return;
    const [a0, c0] = net.nodes[i], [a1, c1] = net.nodes[j], w = net.width[q];
    const l = Math.hypot(a1 - a0, c1 - c0) || 1, ua = (a1 - a0) / l, uc = (c1 - c0) / l;
    for (let d = 7.5; d < l; d += 15) {
      const a = a0 + ua * d, c = c0 + uc * d;
      if (onApron(a, c)) continue;
      light(a, 0.2, c, LIGHT.txCl, 2.4);
      if ((Math.round(d / 15) & 1) === 0) for (const sd of [-1, 1]) {
        const ea = a - uc * sd * (w / 2 + 1), ec = c + ua * sd * (w / 2 + 1);
        if (!onApron(ea, ec)) light(ea, 0.4, ec, LIGHT.txEdge, 3);
      }
    }
  });
  // エプロンの照明塔
  for (const [a, c] of L.masts) {
    mb.cylinder(a, c, 0, 24, 0.35, 8, COL.steelDark, undefined, 0.22);
    mb.box(a - 2.2, 24, c - 0.6, a + 2.2, 25.4, c + 0.4, COL.steelDark);
    for (const o of [-1.5, 0, 1.5]) light(a + o, 24.6, c - 0.8, LIGHT.flood, 6);
    pool(a, c - 22, 0.25, 46);
  }
  void tree;
  return out;
}

const CARCOL = [0xf2f2f0, 0x1d1f22, 0x8d9399, 0xb8bcc1, 0x8a2a24, 0x284a78, 0x3d5a40, 0xd8c34a].map(C);

// 搭乗口の低い建物（ガラス）と、屋上の展望デッキ（人が飛行機を見ている）
function pier(mb: MeshBuilder, r: LRect, h: number, rng: Rng, L: AirportLayout) {
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.glass, PAT.terminal, COL.concrete);
  // 搭乗口のドア（エプロン側、スポットの前）
  // 搭乗口のドア（歩いて乗る空港）と、搭乗橋の付け根（回転する円い部屋と、桟橋へつなぐ固定の通路）
  for (const st of L.stands) {
    if (st.cargo || st.a < r.a0 || st.a > r.a1) continue;
    if (!st.rot) { if (L.walk) mb.box(st.a + 7 - 1.8, 0, r.c0 - 0.05, st.a + 7 + 1.8, 2.6, r.c0, C(0x2a2f36)); continue; }
    const [ra, rcc] = st.rot;
    mb.cylinder(ra, rcc, 0, 3.6, 0.55, 10, COL.steelDark);
    mb.cylinder(ra, rcc, 3.6, 7.0, 2.3, 14, COL.steel, C(0xb8bcc0));
    mb.box(ra - 1.6, 3.7, rcc, ra + 1.6, 6.7, r.c0, COL.glass, PAT.terminal, COL.steel);
    mb.box(ra - 0.35, 0, r.c0 - 2.2, ra + 0.35, 3.7, r.c0 - 1.5, COL.steelDark);
  }
  // デッキの床（木）とガラスの手すり
  mb.matOverride = MAT.siding;
  mb.box(r.a0 + 0.5, h, r.c0 + 0.3, r.a1 - 0.5, h + 0.15, r.c1, COL.wood);
  mb.matOverride = null;
  mb.box(r.a0 + 0.3, h, r.c0, r.a1 - 0.3, h + 1.15, r.c0 + 0.12, C(0x9cc3d4));
  mb.box(r.a0 + 0.3, h + 1.1, r.c0 - 0.05, r.a1 - 0.3, h + 1.22, r.c0 + 0.17, COL.steelDark);
  for (const a of [r.a0 + 0.3, r.a1 - 0.42]) mb.box(a, h, r.c0, a + 0.12, h + 1.15, r.c1, C(0x9cc3d4));
  // 人（手すりのそばに立って、飛行機を見る）とベンチ、望遠鏡
  const shirts = [0xc8342c, 0x2f6fb2, 0xf2c230, 0x3d8a4a, 0xeeeeee, 0x333333, 0xe8772e, 0x8e5aa8].map(C);
  for (let a = r.a0 + 4; a < r.a1 - 4; a += 2.4 + rng.next() * 5) {
    const c = r.c0 + 0.7 + rng.next() * 1.4, s = rng.next() < 0.2 ? 0.75 : 1;
    mb.box(a - 0.22 * s, h + 0.15, c - 0.15 * s, a + 0.22 * s, h + 0.15 + 0.85 * s, c + 0.15 * s, C(0x3a3d44));
    mb.box(a - 0.25 * s, h + 0.15 + 0.85 * s, c - 0.17 * s, a + 0.25 * s, h + 0.15 + 1.45 * s, c + 0.17 * s, rng.pick(shirts));
    mb.box(a - 0.12 * s, h + 0.15 + 1.47 * s, c - 0.12 * s, a + 0.12 * s, h + 0.15 + 1.72 * s, c + 0.12 * s, C(0xd9b08c));
  }
  for (let a = r.a0 + 10; a < r.a1 - 8; a += 26) {
    mb.box(a - 1.2, h + 0.15, r.c1 - 2.2, a + 1.2, h + 0.6, r.c1 - 1.6, COL.wood);
    mb.box(a + 6 - 0.06, h + 0.15, r.c0 + 0.7, a + 6 + 0.06, h + 1.25, r.c0 + 0.82, COL.steelDark);
    mb.box(a + 6 - 0.15, h + 1.25, r.c0 + 0.5, a + 6 + 0.15, h + 1.45, r.c0 + 1.0, COL.steelDark);
  }
}

// 搭乗橋の付け根（回転する円い部屋と、建物の面までの固定の通路）。スポットの向きに合わせる
function bridgeRoots(mb: MeshBuilder, r: LRect, L: AirportLayout) {
  for (const st of L.stands) {
    if (st.cargo || !st.rot) continue;
    const [ra, rcc] = st.rot;
    if (ra < r.a0 - 12 || ra > r.a1 + 12 || rcc < r.c0 - 12 || rcc > r.c1 + 12) continue;
    const [ua, uc] = standDir(st);
    mb.cylinder(ra, rcc, 0, 3.6, 0.55, 10, COL.steelDark);
    mb.cylinder(ra, rcc, 3.6, 7.0, 2.3, 14, COL.steel, C(0xb8bcc0));
    if (uc !== 0) {
      const face = uc > 0 ? r.c0 : r.c1;
      mb.box(ra - 1.6, 3.7, Math.min(rcc, face), ra + 1.6, 6.7, Math.max(rcc, face), COL.glass, PAT.terminal, COL.steel);
      const l0 = face - uc * 2.2, l1 = face - uc * 1.5;
      mb.box(ra - 0.35, 0, Math.min(l0, l1), ra + 0.35, 3.7, Math.max(l0, l1), COL.steelDark);
    } else {
      const face = ua > 0 ? r.a0 : r.a1;
      mb.box(Math.min(ra, face), 3.7, rcc - 1.6, Math.max(ra, face), 6.7, rcc + 1.6, COL.glass, PAT.terminal, COL.steel);
      const l0 = face - ua * 2.2, l1 = face - ua * 1.5;
      mb.box(Math.min(l0, l1), 0, rcc - 0.35, Math.max(l0, l1), 3.7, rcc + 0.35, COL.steelDark);
    }
  }
}

// 大の本館の桟橋とサテライト：c に沿って長いガラスの建物（2 層）。屋根は張り出し、木の鼻隠しと天窓の帯。
// 幅の広いサテライトは真ん中が高い吹き抜け（ガラス）。本館とサテライトのあいだは地下の新交通（ピープルムーバー）でつなぐ
function concourse(mb: MeshBuilder, r: LRect, h: number, L: AirportLayout, light: (a: number, y: number, c: number, col: readonly number[], s: number) => void) {
  const am = (r.a0 + r.a1) / 2, wide = r.a1 - r.a0 > 30;
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.glass, PAT.terminal, COL.concrete);
  mb.matOverride = MAT.siding;
  mb.box(r.a0 - 0.2, 4.6, r.c0 - 0.2, r.a1 + 0.2, 5.2, r.c1 + 0.2, COL.wood);
  mb.matOverride = null;
  // 張り出した屋根と鼻隠し（夜は木の色で光る）、屋根の上の天窓の帯
  mb.box(r.a0 - 2.5, h, r.c0 - 2.5, r.a1 + 2.5, h + 0.9, r.c1 + 2.5, COL.roofTop, PAT.none, COL.roofTop);
  mb.matOverride = MAT.siding;
  mb.box(r.a0 - 2.6, h - 0.1, r.c0 - 2.6, r.a1 + 2.6, h + 0.5, r.c1 + 2.6, COL.wood, PAT.lit);
  mb.matOverride = null;
  mb.box(am - 1.5, h + 0.9, r.c0 + 4, am + 1.5, h + 1.3, r.c1 - 4, C(0x9c9585), PAT.lit);
  if (wide) {
    // 吹き抜け（高いガラスの箱）と、その屋根
    const ha = (r.a1 - r.a0) / 2 - 9;
    mb.box(am - ha, h + 0.9, r.c0 + 30, am + ha, h + 7, r.c1 - 30, COL.glass, PAT.terminal, COL.steel);
    mb.box(am - ha - 1.5, h + 7, r.c0 + 28.5, am + ha + 1.5, h + 7.8, r.c1 - 28.5, COL.roofTop, PAT.none, COL.roofTop);
    mb.matOverride = MAT.siding;
    mb.box(am - ha - 1.6, h + 6.8, r.c0 + 28.4, am + ha + 1.6, h + 7.3, r.c1 - 28.4, COL.wood, PAT.lit);
    mb.matOverride = null;
    // 新交通の駅の案内（光る帯、両端）
    for (const c of [r.c0 + 0.5, r.c1 - 0.5]) mb.box(am - 8, h - 3, Math.min(c, c - Math.sign(c) * 0.15), am + 8, h - 1.8, Math.max(c, c - Math.sign(c) * 0.15), C(0x2a6fb5), PAT.glow);
  }
  bridgeRoots(mb, r, L);
  // 屋根のふちの照明（エプロンを照らす）
  for (let c = r.c0 + 10; c < r.c1 - 5; c += 30) for (const a of [r.a0 - 2.8, r.a1 + 2.8]) light(a, h - 0.4, c, [1.0, 0.82, 0.6], 4);
}

// エアポートセンター：ホテルとオフィスのあいだの広場。石の舗装、木の植え込み、水盤、ガラスの大屋根（細い柱で高く支える）
function plaza(mb: MeshBuilder, r: LRect, rng: Rng, tree: (a: number, c: number, s?: number, kind?: number) => void, light: (a: number, y: number, c: number, col: readonly number[], s: number) => void) {
  mb.ground(r.a0, r.c0, r.a1, r.c1, 0.13, C(0xcfc8bb));
  for (let a = r.a0 + 6; a < r.a1; a += 6) mb.ground(a - 0.1, r.c0, a + 0.1, r.c1, 0.135, C(0xbdb5a7));
  const am = (r.a0 + r.a1) / 2, cm = (r.c0 + r.c1) / 2;
  // 水盤
  mb.ground(am - 22, cm - 6, am + 22, cm + 6, 0.14, C(0x4d7f9a));
  mb.box(am - 22.3, 0, cm - 6.3, am + 22.3, 0.35, cm - 6, COL.concrete);
  mb.box(am - 22.3, 0, cm + 6, am + 22.3, 0.35, cm + 6.3, COL.concrete);
  // ガラスの大屋根
  const y = 21, ra0 = am - 60, ra1 = am + 60, rc0 = r.c0 + 4, rc1 = r.c1 - 4;
  mb.box(ra0, y, rc0, ra1, y + 0.5, rc1, C(0xb9d0db), PAT.none, C(0x8fb0c0));
  mb.matOverride = MAT.siding;
  mb.box(ra0 - 0.3, y - 0.4, rc0 - 0.3, ra1 + 0.3, y + 0.2, rc1 + 0.3, COL.wood, PAT.lit);
  mb.matOverride = null;
  for (let a = ra0 + 6; a <= ra1 - 6; a += 27) for (const c of [rc0 + 3, rc1 - 3]) {
    mb.cylinder(a, c, 0, y - 0.4, 0.35, 8, COL.steel);
    light(a, y - 1, c, [1.0, 0.85, 0.65], 4);
  }
  // 植え込みの木
  for (let a = r.a0 + 5; a < r.a1 - 3; a += 11 + rng.next() * 4) {
    if (a > ra0 - 4 && a < ra1 + 4) continue;
    tree(a, r.c0 + 5 + rng.next() * (r.c1 - r.c0 - 10), 0.8 + rng.next() * 0.4, rng.next() < 0.4 ? 1 : 0);
  }
  for (let a = ra0; a <= ra1; a += 15) tree(a, rc0 - 1.5, 0.7, 0);
}

// ターミナル：ガラスの箱（2 層）の上に、木の天井の大きな波打つ屋根。陸側は出発ロビー前の道路の上まで張り出す。
// 屋根は木のような柱（幹から枝が 4 本）で支える
function terminal(mb: MeshBuilder, r: LRect, h: number, L: AirportLayout, light: (a: number, y: number, c: number, col: readonly number[], s: number) => void, fi: FcInfo | null) {
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.glass, PAT.terminal, COL.concrete);
  const dy = fi ? fi.yDeck : 6.6; // 出発階の床（出発の車寄せの歩道と同じ高さ）
  // 2 階の床の帯（木）
  mb.matOverride = MAT.siding;
  mb.box(r.a0 - 0.2, dy - 0.6, r.c0 - 0.2, r.a1 + 0.2, dy, r.c1 + 0.2, COL.wood);
  mb.matOverride = null;
  // 入口（陸側：1 階は到着、2 階は出発）。出発の入口には、ガラスのひさし
  for (let a = r.a0 + 16; a < r.a1 - 10; a += 30) {
    mb.box(a - 2.5, fi ? fi.yGround : 0, r.c1, a + 2.5, (fi ? fi.yGround : 0) + 2.8, r.c1 + 0.1, C(0x2a2f36));
    mb.box(a - 2.5, dy, r.c1, a + 2.5, dy + 2.8, r.c1 + 0.1, C(0x2a2f36));
    if (fi) {
      mb.box(a - 4.2, dy + 3.6, r.c1, a + 4.2, dy + 3.75, r.c1 + 3.2, C(0x9cc3d4));
      mb.box(a - 4.2, dy + 3.75, r.c1, a + 4.2, dy + 3.95, r.c1 + 0.3, COL.steel);
      // 入口の上の光る案内（出発）
      mb.box(a - 2.0, dy + 2.95, r.c1 + 0.05, a + 2.0, dy + 3.45, r.c1 + 0.15, C(0x1f4f9a), PAT.glow);
    }
  }
  // 大屋根：a に沿って波打つ。陸側へ少し高くなる
  // 屋根は出発の車寄せ（高架の歩道と、自家用車の車線）まで張り出す。その外の車線と島は空から見える
  // 屋根は出発の車寄せの車線の上まで張り出す（車寄せは屋根の下）
  const a0 = r.a0 - 12, a1 = r.a1 + 12, c0 = r.c0 - 1.5, c1 = fi ? fi.cF + 1.5 : L.viaduct.c0 + 6;
  const NA = 40, NC = 4;
  const hRoof = Math.max(h, dy + 7.5);
  const yAt = (a: number, c: number) => hRoof + 2.2 + 2.2 * Math.sin((a / 46) * Math.PI) + ((c - c0) / (c1 - c0)) * 2.4;
  const th = 1.1;
  for (let i = 0; i < NA; i++) for (let j = 0; j < NC; j++) {
    const aa = a0 + ((a1 - a0) * i) / NA, ab = a0 + ((a1 - a0) * (i + 1)) / NA;
    const ca = c0 + ((c1 - c0) * j) / NC, cb = c0 + ((c1 - c0) * (j + 1)) / NC;
    // 上の面（明るい金属。ところどころ天窓）
    const sky = i % 8 === 3 && j > 0 && j < NC - 1;
    mb.quad([aa, yAt(aa, cb), cb], [ab, yAt(ab, cb), cb], [ab, yAt(ab, ca), ca], [aa, yAt(aa, ca), ca], sky ? C(0x9c9585) : COL.roofTop, sky ? PAT.lit : 0);
    // 下の面（木の天井。夜は照らされて温かく光る）
    mb.quad([aa, yAt(aa, ca) - th, ca], [ab, yAt(ab, ca) - th, ca], [ab, yAt(ab, cb) - th, cb], [aa, yAt(aa, cb) - th, cb], COL.woodDark, PAT.lit);
  }
  // 屋根のふち（木の鼻隠し）
  mb.matOverride = MAT.siding;
  for (let i = 0; i < NA; i++) {
    const aa = a0 + ((a1 - a0) * i) / NA, ab = a0 + ((a1 - a0) * (i + 1)) / NA;
    // 鼻隠しは夜にライトアップ（木の色のまま明るく）
    mb.quad([aa, yAt(aa, c1) - th, c1], [ab, yAt(ab, c1) - th, c1], [ab, yAt(ab, c1), c1], [aa, yAt(aa, c1), c1], COL.wood, PAT.lit);
    mb.quad([ab, yAt(ab, c0) - th, c0], [aa, yAt(aa, c0) - th, c0], [aa, yAt(aa, c0), c0], [ab, yAt(ab, c0), c0], COL.wood, PAT.lit);
  }
  for (const a of [a0, a1]) {
    const sd = a === a0 ? -1 : 1;
    for (let j = 0; j < NC; j++) {
      const ca = c0 + ((c1 - c0) * j) / NC, cb = c0 + ((c1 - c0) * (j + 1)) / NC;
      if (sd > 0) mb.quad([a, yAt(a, cb) - th, cb], [a, yAt(a, ca) - th, ca], [a, yAt(a, ca), ca], [a, yAt(a, cb), cb], COL.wood);
      else mb.quad([a, yAt(a, ca) - th, ca], [a, yAt(a, cb) - th, cb], [a, yAt(a, cb), cb], [a, yAt(a, ca), ca], COL.wood);
    }
  }
  mb.matOverride = null;
  // 木のような柱（陸側、出発の車寄せの歩道の上）
  const cc = fi ? (r.c1 + fi.cK) / 2 + 0.8 : L.viaduct.c0 + 1, cy0 = fi ? dy : 0, cy1 = fi ? dy + 6 : 8.5;
  for (let a = r.a0 + 4; a <= r.a1 - 4; a += 28) {
    mb.cylinder(a, cc, cy0, cy1, 0.45, 10, COL.steel, undefined, 0.4);
    const top = yAt(a, cc) - th;
    for (const [da, dc] of [[-4, -2.2], [4, -2.2], [-4, 1.5], [4, 1.5]]) {
      const ta = a + da, tcc = cc + dc, ty = yAt(ta, tcc) - th;
      const p0: [number, number] = [a, cc];
      // 枝（細い角柱を斜めに）
      const w = 0.18;
      mb.quad([p0[0] - w, cy1 - 0.2, p0[1]], [p0[0] + w, cy1 - 0.2, p0[1]], [ta + w, ty, tcc], [ta - w, ty, tcc], COL.steel);
      mb.quad([p0[0] + w, cy1 - 0.2, p0[1]], [p0[0] - w, cy1 - 0.2, p0[1]], [ta - w, ty, tcc], [ta + w, ty, tcc], COL.steel);
    }
    void top;
    // 屋根の下の照明
    light(a, yAt(a, cc) - th - 0.4, cc - 4, [1.0, 0.82, 0.6], 4);
  }
}

// 管制塔：細い塔の上に、外へ傾いたガラスの管制室（八角形）。塔の横に白い帆のような壁。屋上に航空障害灯
function tower(mb: MeshBuilder, r: LRect, h: number, L: AirportLayout, beacon: (a: number, y: number, c: number) => void) {
  // 足もとの建物
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.office, PAT.ribbon, COL.concrete);
  const [ta, tcc, th] = L.tower;
  const k = th / 46; // 大きい空港ほど太く大きな管制室
  const ring0 = (rad: number, n: number, rot = 0): [number, number][] => Array.from({ length: n }, (_, q) => [ta + Math.cos((q / n) * Math.PI * 2 + rot) * rad * k, tcc + Math.sin((q / n) * Math.PI * 2 + rot) * rad * k]);
  // 塔（下が太い）
  mb.prism(ring0(3.4, 16), h, th - 8, COL.towerWhite, PAT.none, null, ring0(2.5, 16));
  // 帆の壁（塔の陸側）
  mb.prism([[ta - 0.4, tcc + 2.6], [ta + 0.4, tcc + 2.6], [ta + 0.4, tcc + 9], [ta - 0.4, tcc + 9]], h, h + 2, COL.towerWhite, PAT.none, null);
  {
    const p = (a: number, y: number, c: number): [number, number, number] => [a, y, c];
    const sd = 0.35;
    mb.quad(p(ta + sd, h, tcc + 9), p(ta + sd, h, tcc + 2.5), p(ta + sd, th - 8, tcc + 2.2), p(ta + sd, th - 14, tcc + 4.5), COL.towerWhite);
    mb.quad(p(ta - sd, h, tcc + 2.5), p(ta - sd, h, tcc + 9), p(ta - sd, th - 14, tcc + 4.5), p(ta - sd, th - 8, tcc + 2.2), COL.towerWhite);
    mb.quad(p(ta - sd, h, tcc + 9), p(ta + sd, h, tcc + 9), p(ta + sd, th - 14, tcc + 4.5), p(ta - sd, th - 14, tcc + 4.5), COL.towerWhite);
  }
  // 機械室（暗い帯）と、外へ傾いたガラスの管制室
  mb.prism(ring0(4.6, 8, Math.PI / 8), th - 8, th - 5.5, COL.steelDark, PAT.none, COL.concrete, ring0(5.2, 8, Math.PI / 8));
  mb.prism(ring0(5.2, 8, Math.PI / 8), th - 5.5, th, COL.cabGlass, PAT.fullglass, null, ring0(6.6, 8, Math.PI / 8));
  // 屋根（張り出す）とアンテナ
  mb.prism(ring0(7.4, 8, Math.PI / 8), th, th + 0.8, COL.towerWhite, PAT.none, COL.concrete);
  mb.box(ta - 0.25, th + 0.8, tcc - 0.25, ta + 0.25, th + 7, tcc + 0.25, COL.steelDark);
  mb.box(ta + 2, th + 0.8, tcc - 0.15, ta + 2.3, th + 4, tcc + 0.15, COL.steelDark);
  // 夜の管制室のうす明かり（光る帯）
  mb.prism(ring0(5.0, 8, Math.PI / 8), th - 5.4, th - 5.0, C(0x7fb3a0), PAT.glow, null);
  beacon(ta, th + 7.2, tcc);
  beacon(ta + 7.3 * k, th + 0.9, tcc);
  beacon(ta - 7.3 * k, th + 0.9, tcc);
}

// 空港ホテル：低層部はガラス、上はブロンズのカーテンウォール。屋上に光る帯と障害灯
function hotel(mb: MeshBuilder, r: LRect, h: number, beacon: (a: number, y: number, c: number) => void) {
  mb.box(r.a0, 0, r.c0, r.a1, 7, r.c1, COL.glass, PAT.terminal, COL.concrete);
  mb.box(r.a0 + 2, 7, r.c0 + 4, r.a1 - 2, h, r.c1 - 2, COL.hotel, PAT.curtain, COL.concrete);
  mb.box(r.a0 + 1.6, h, r.c0 + 3.6, r.a1 - 1.6, h + 1.2, r.c1 - 1.6, C(0xd8dadc), PAT.glow);
  mb.box((r.a0 + r.a1) / 2 - 6, h + 1.2, (r.c0 + r.c1) / 2 - 4, (r.a0 + r.a1) / 2 + 6, h + 4, (r.c0 + r.c1) / 2 + 4, COL.steelDark);
  for (const a of [r.a0 + 2, r.a1 - 2]) beacon(a, h + 1.4, r.c0 + 4);
  // 入口のひさし
  mb.box(r.a0 + 10, 4, r.c1, r.a1 - 10, 4.4, r.c1 + 4, COL.steel);
}
function office(mb: MeshBuilder, r: LRect, h: number, beacon: (a: number, y: number, c: number) => void) {
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.office, PAT.ribbon, COL.concrete);
  mb.box(r.a0 + 6, h, r.c0 + 6, r.a1 - 6, h + 3, r.c1 - 6, COL.steelDark);
  beacon((r.a0 + r.a1) / 2, h + 3.2, (r.c0 + r.c1) / 2);
}

// 駐車場ビル（5 層。床の縁と柱、車）
function carpark(mb: MeshBuilder, r: LRect, h: number, rng: Rng) {
  const lv = 4, fh = h / lv;
  for (let k = 0; k <= lv; k++) {
    const y = k * fh;
    if (k) mb.box(r.a0, y - 0.35, r.c0, r.a1, y, r.c1, COL.carpark, PAT.none, C(0x8e8c88));
    mb.box(r.a0 - 0.2, y + 0.0, r.c0 - 0.2, r.a1 + 0.2, y + 1.1, r.c0, COL.carpark);
    mb.box(r.a0 - 0.2, y + 0.0, r.c1, r.a1 + 0.2, y + 1.1, r.c1 + 0.2, COL.carpark);
    if (k < lv) for (let a = r.a0 + 1; a < r.a1; a += 8) for (const c of [r.c0 + 0.5, (r.c0 + r.c1) / 2, r.c1 - 0.5]) mb.box(a - 0.35, y, c - 0.35, a + 0.35, y + fh - 0.35, c + 0.35, COL.concreteDark);
    // 車
    for (let a = r.a0 + 3; a < r.a1 - 4; a += 2.6) for (const c of [r.c0 + 4, r.c1 - 4]) if (rng.next() < (k === lv ? 0.35 : 0.7)) {
      const col = rng.pick(CARCOL);
      mb.box(a - 0.9, y + 0.05, c - 2.2, a + 0.9, y + 0.75, c + 2.2, col);
      mb.box(a - 0.78, y + 0.75, c - 1.2, a + 0.78, y + 1.25, c + 1.0, C(0x2a3440));
    }
  }
  // 階段とエレベーターの塔（ガラス）
  mb.box(r.a1 - 6, 0, r.c1 - 6, r.a1, h + 3, r.c1, COL.glass, PAT.terminal, COL.concrete);
  // 屋上の照明
  for (let a = r.a0 + 10; a < r.a1 - 8; a += 20) mb.box(a - 0.08, h, (r.c0 + r.c1) / 2 - 0.08, a + 0.08, h + 6, (r.c0 + r.c1) / 2 + 0.08, COL.steelDark);
}

// 空港駅：敷地の陸側のふちに沿うホームと長い屋根。真ん中にガラスの駅舎と、ターミナルへの渡り廊下
// 列車の長さ（m。render/vehicles.ts の TRAIN_SPEC：両数 ×（車両の長さ + すき間））
const TRAIN_LEN: Record<string, number> = { rail: 5 * 18.8, erail: 4 * 14.1, mono: 4 * 13.6, sub: 5 * 17.8 };

// 空港駅。高架鉄道・モノレールがつながると、ターミナルの前の高架駅（木とガラスの屋根のホーム、ターミナルの出発階へのガラスの連絡橋）。
// 地上の鉄道・地下鉄・つながっていないときは、地上のホームと駅舎
function station(mb: MeshBuilder, r: LRect, h: number, L: AirportLayout, lines: string[], fi: FcInfo | null) {
  const elevated = lines.includes('erail') || lines.includes('mono');
  const term = L.buildings.find((b) => b.kind === 'terminal')!;
  // ホームの長さ：つながっている列車のいちばん長いものより少し長く
  const tl = Math.max(60, ...lines.map((k) => TRAIN_LEN[k] ?? 0));
  const half = Math.min((r.a1 - r.a0) / 2, tl / 2 + 8);
  const a0 = -half, a1 = half;
  // 戻りの列が駅の範囲を通る（小）：ホームは道路の外（敷地のふち）に寄せ、駅舎は道路の上の高い所に
  const over = !!fi && fi.cR + 6.4 > r.c0;
  const pc0 = over ? fi!.cR + 6.4 : r.c0 + 1;
  // ターミナルへの連絡橋：出発の車寄せの車線の上（出発階 + 5.5m）を渡り、歩道の上のガラスの箱（エスカレーター）へ降りる
  const bridge = (by: number, c1: number) => {
    const c0 = fi ? fi.cK - 4 : term.r.c1;
    mb.box(-4.5, by, c0, 4.5, by + 3.4, c1, COL.glass, PAT.terminal, COL.steel);
    mb.matOverride = MAT.siding;
    mb.box(-5.0, by + 3.4, c0 - 0.5, 5.0, by + 3.9, c1 + 0.5, COL.wood, PAT.lit);
    mb.matOverride = null;
    if (fi) {
      // エスカレーターの箱（出発の歩道の上）
      mb.box(-6, fi.yDeck, fi.facade + 0.5, 6, by + 3.4, fi.cK - 1.2, COL.glass, PAT.terminal, COL.steel);
      // 支え：車線の外（1 列目と戻りの列の間、戻りの列の外）
      const cs = [fi.cF + 5.8, ...(over ? [] : [fi.cR + 6.2])].filter((c) => c < c1 - 0.5);
      for (const c of cs) mb.box(-0.6, 0, c - 0.6, 0.6, by, c + 0.6, COL.steel);
    } else for (const c of [L.roadC[0] + 1, L.roadC[1] - 1]) mb.box(-0.5, 0, c - 0.5, 0.5, by, c + 0.5, COL.steel);
  };
  const byOf = (py: number) => (fi ? Math.max(py + 0.6, fi.yDeck + 5.5) : Math.max(py + 0.6, L.viaduct.h + 2.8));
  if (!elevated) {
    const py = 0;
    mb.box(a0, py, pc0 + (over ? 0 : 2), a1, py + 1.1, r.c1, COL.platform, PAT.none, C(0xd6d1c6));
    mb.box(a0, py + 1.1, r.c1 - 0.6, a1, py + 1.12, r.c1 - 0.3, COL.yellow);
    for (let a = a0 + 4; a < a1; a += 12) mb.box(a - 0.15, py + 1.1, pc0 + (over ? 0.6 : 4), a + 0.15, py + h, pc0 + (over ? 0.9 : 4.3), COL.steel);
    mb.box(a0, py + h, pc0 - (over ? 0 : 1), a1, py + h + 0.4, r.c1 + 1.5, COL.steel, PAT.none, C(0xe8eaec));
    mb.box(a0 + 2, py + h + 0.4, pc0 + 1, a1 - 2, py + h + 0.5, pc0 + 3, C(0x8fb3c8));
    const by = byOf(py + h);
    if (over) {
      // 駅舎：道路の上の高い所のガラスの箱。ホームへは階段の塔
      mb.box(-16, by - 0.8, fi!.cR - 5, 16, by + 4.2, pc0 + 2, COL.glass, PAT.terminal, COL.concrete, true);
      mb.box(10, 0, pc0 + 0.2, 16, by, pc0 + 3.4, COL.glass, PAT.terminal, COL.concrete);
      bridge(by, fi!.cR - 5);
      mb.box(-12, by + 2.6, fi!.cR - 5.06, 12, by + 3.6, fi!.cR - 4.96, C(0x2a6fb5), PAT.glow);
    } else {
      mb.box(-16, 0, r.c0 - 1, 16, py + h + 3, r.c0 + 4, COL.glass, PAT.terminal, COL.concrete);
      bridge(by, r.c0 - 1);
      mb.box(-12, py + h + 1.2, r.c0 - 1.05, 12, py + h + 2.4, r.c0 - 0.95, C(0x2a6fb5), PAT.glow);
    }
    return;
  }
  // ---- 高架駅 ----
  const py = lines.includes('erail') ? 8 : 11; // 高架鉄道 8m、モノレール 11m（線路の高さ）
  const edge = L.land.edge + 5.2; // ホームのふち（線路のマスの、線路の中心から 2.8m 手前）
  // ホームの床（高架の床版）と、柱
  mb.matOverride = MAT.concrete;
  mb.box(a0, py - 1.2, pc0, a1, py + 1.1, edge, COL.concrete, PAT.none, COL.platform);
  mb.matOverride = null;
  for (let a = a0 + 8; a < a1; a += 16) mb.box(a - 0.7, 0, pc0 + (over ? 0.3 : 2), a + 0.7, py - 1.2, pc0 + (over ? 1.7 : 4), COL.concreteDark);
  mb.box(a0, py + 1.1, edge - 0.9, a1, py + 1.12, edge - 0.5, COL.yellow); // 点字ブロックの黄色
  // ホームのガラスの壁（陸側）
  mb.box(a0, py + 1.1, pc0, a1, py + 3.2, pc0 + 0.15, C(0x9cc3d4));
  // 屋根：ターミナルと同じ、木の天井の波打つ大屋根（ホームと線路の上まで）
  const rc0 = pc0 - 1, rc1 = edge + 5.5, NA = Math.max(6, Math.round((a1 - a0) / 6)), th = 0.7;
  const yAt = (a: number, c: number) => py + 6.2 + 0.9 * Math.sin((a / 23) * Math.PI) + ((c - rc0) / (rc1 - rc0)) * 0.8;
  for (let i = 0; i < NA; i++) {
    const aa = a0 - 3 + ((a1 - a0 + 6) * i) / NA, ab = a0 - 3 + ((a1 - a0 + 6) * (i + 1)) / NA;
    const sky = i % 4 === 1;
    mb.quad([aa, yAt(aa, rc1), rc1], [ab, yAt(ab, rc1), rc1], [ab, yAt(ab, rc0), rc0], [aa, yAt(aa, rc0), rc0], sky ? C(0x9c9585) : COL.roofTop, sky ? PAT.lit : 0);
    mb.quad([aa, yAt(aa, rc0) - th, rc0], [ab, yAt(ab, rc0) - th, rc0], [ab, yAt(ab, rc1) - th, rc1], [aa, yAt(aa, rc1) - th, rc1], COL.woodDark, PAT.lit);
    mb.matOverride = MAT.siding;
    mb.quad([aa, yAt(aa, rc1) - th, rc1], [ab, yAt(ab, rc1) - th, rc1], [ab, yAt(ab, rc1), rc1], [aa, yAt(aa, rc1), rc1], COL.wood, PAT.lit);
    mb.quad([ab, yAt(ab, rc0) - th, rc0], [aa, yAt(aa, rc0) - th, rc0], [aa, yAt(aa, rc0), rc0], [ab, yAt(ab, rc0), rc0], COL.wood, PAT.lit);
    mb.matOverride = null;
  }
  // 屋根を支える木のような柱（ホームの真ん中）
  const cm = (pc0 + edge) / 2;
  for (let a = a0 + 10; a <= a1 - 9; a += 20) {
    mb.cylinder(a, cm, py + 1.1, py + 4.2, 0.3, 8, COL.steel, undefined, 0.28);
    for (const [da, dc] of [[-3, -2.5], [3, -2.5], [-3, 2.5], [3, 2.5]]) {
      const ta = a + da, tcc = cm + dc, ty = yAt(ta, tcc) - th, w = 0.13;
      mb.quad([a - w, py + 4.0, cm], [a + w, py + 4.0, cm], [ta + w, ty, tcc], [ta - w, ty, tcc], COL.steel);
      mb.quad([a + w, py + 4.0, cm], [a - w, py + 4.0, cm], [ta - w, ty, tcc], [ta + w, ty, tcc], COL.steel);
    }
  }
  const by = byOf(py);
  if (over) {
    // 駅舎：ホームの階から道路の上へ張り出すガラスの箱
    mb.box(-14, py - 1.2, fi!.cR - 5, 14, by + 3.6, pc0 + 2, COL.glass, PAT.terminal, COL.steel, true);
    bridge(by, fi!.cR - 5);
  } else {
    // 駅舎（ガラスの箱、エスカレーターとエレベーター）：地面からホームの階まで
    mb.box(-17, 0, r.c0 - 2, 17, py + 1.1, pc0 + 4, COL.glass, PAT.terminal, COL.platform);
    mb.box(-6, py + 1.1, pc0 - 2, 6, py + 4.4, pc0 + 2, COL.glass, PAT.terminal, COL.steel);
    bridge(by, pc0 - 2);
  }
  // 駅名の看板（光る帯）
  mb.box(-12, py + 5.0, pc0 - 2.06, 12, py + 6.0, pc0 - 1.96, C(0x2a6fb5), PAT.glow);
}

// 格納庫：かまぼこ形の屋根、エプロン側の大きな扉は開いていて、中に整備中の機体
function hangar(mb: MeshBuilder, r: LRect, h: number, type: AcKind, beacon: (a: number, y: number, c: number) => void, light: (a: number, y: number, c: number, col: readonly number[], s: number) => void, at: (a: number, c: number, rot: number) => void, back: () => void) {
  const wh = h - 5, NA = 12;
  const ca = r.c0, cb = r.c1;
  // 床と奥の壁、横の壁
  mb.ground(r.a0, ca, r.a1, cb, 0.12, C(0xb9b8b3));
  mb.box(r.a0, 0, cb - 0.5, r.a1, wh, cb, COL.hangar, PAT.industrial);
  for (const a of [r.a0, r.a1 - 0.5]) mb.box(a, 0, ca, a + 0.5, wh, cb, COL.hangar, PAT.industrial);
  // 屋根（a に沿ったかまぼこ形）。手前の上は扉の梁
  const yr = (a: number) => wh + 5 * Math.sin(((a - r.a0) / (r.a1 - r.a0)) * Math.PI);
  for (let i = 0; i < NA; i++) {
    const a0 = r.a0 + ((r.a1 - r.a0) * i) / NA, a1 = r.a0 + ((r.a1 - r.a0) * (i + 1)) / NA;
    mb.quad([a0, yr(a0), cb], [a1, yr(a1), cb], [a1, yr(a1), ca], [a0, yr(a0), ca], C(0xc2c7cc));
    mb.quad([a0, yr(a0) - 0.3, ca], [a1, yr(a1) - 0.3, ca], [a1, yr(a1) - 0.3, cb], [a0, yr(a0) - 0.3, cb], C(0x5d6166), PAT.lit);
    // 妻壁（前と後ろの三日月の部分）
    mb.quad([a0, wh, ca], [a1, wh, ca], [a1, yr(a1), ca], [a0, yr(a0), ca], COL.hangar);
    mb.quad([a1, wh, cb], [a0, wh, cb], [a0, yr(a0), cb], [a1, yr(a1), cb], COL.hangar);
  }
  mb.box(r.a0, wh - 3, ca, r.a1, wh, ca + 1, COL.hangar);
  // 開いた扉（両わきに寄せた板）
  for (const a of [r.a0 + 0.5, r.a1 - 8.5]) mb.box(a, 0, ca - 0.6, a + 8, wh - 3, ca, C(0xaab0b6));
  // 中の機体（整備中の A220）
  const am = (r.a0 + r.a1) / 2, cm = (ca + cb) / 2 + 2;
  // 機首が -c（エプロン）を向く
  at(am, cm, Math.PI);
  buildAircraft(mb, type, LIVERIES[0]);
  back();
  // 作業台と道具
  mb.box(am - 3, 0.1, cm + 8, am + 3, 3.2, cm + 10, C(0xf2c230));
  for (let a = r.a0 + 8; a < r.a1 - 6; a += 15) light(a, wh - 0.5, (ca + cb) / 2, [1.0, 0.95, 0.85], 7);
  beacon((r.a0 + r.a1) / 2, wh + 5.2, ca + 2);
  // 看板（光る帯）
  mb.box(r.a0 + 15, wh - 2.4, ca - 0.08, r.a1 - 15, wh - 0.8, ca, C(0x16697a), PAT.glow);
}

// 燃料タンク（3 基）と防油堤、ポンプ小屋
function fuel(mb: MeshBuilder, r: LRect) {
  mb.ground(r.a0, r.c0, r.a1, r.c1, 0.12, C(0xa8a49b));
  for (const [a0, c0, a1, c1] of [[r.a0, r.c0, r.a1, r.c0 + 0.5], [r.a0, r.c1 - 0.5, r.a1, r.c1], [r.a0, r.c0, r.a0 + 0.5, r.c1], [r.a1 - 0.5, r.c0, r.a1, r.c1]]) mb.box(a0, 0, c0, a1, 1.4, c1, COL.concrete);
  const n = 3, sp = (r.a1 - r.a0) / n;
  for (let k = 0; k < n; k++) {
    const a = r.a0 + sp * (k + 0.5), c = (r.c0 + r.c1) / 2 + 1;
    mb.cylinder(a, c, 0, 10, 7.2, 20, COL.tank, C(0xd6d8da));
    mb.cylinder(a, c, 10, 10.8, 7.2, 20, C(0xd6d8da), C(0xc8cacc), 5);
    mb.box(a + 6.6, 0, c - 0.5, a + 7.6, 10.3, c + 0.5, COL.steelDark); // はしご
  }
  mb.box(r.a1 - 8, 0, r.c1 - 6, r.a1 - 1, 3.5, r.c1 - 1, COL.office, PAT.industrial);
}

// 空港の消防署：赤い扉の車庫 4 つと、ホースを干す塔。前に化学消防車
function fireStation(mb: MeshBuilder, r: LRect, h: number) {
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, C(0xe8e6e0), PAT.office, COL.concrete);
  const bays = 4, bw = (r.a1 - r.a0 - 14) / bays;
  for (let k = 0; k < bays; k++) {
    const a = r.a0 + 2 + k * bw;
    mb.box(a + 0.6, 0, r.c0 - 0.1, a + bw - 0.6, 5.5, r.c0, COL.fire);
  }
  mb.box(r.a1 - 10, 0, r.c0 + 4, r.a1 - 4, h + 8, r.c0 + 10, C(0xe8e6e0), PAT.none, COL.fire);
  // 化学消防車（大きな赤い車）
  for (let k = 0; k < 2; k++) {
    const a = r.a0 + 2 + bw * (k + 0.5), c = r.c0 - 7;
    mb.box(a - 1.5, 0.6, c - 6, a + 1.5, 3.4, c + 5, COL.fire);
    mb.box(a - 1.45, 2.0, c + 3.6, a + 1.45, 3.2, c + 5.05, C(0x24303c));
    mb.box(a - 0.4, 3.4, c - 1, a + 0.4, 3.9, c + 2, C(0xdcdcdc));
    for (const z of [-4.2, -1.5, 3.4]) for (const sd of [-1, 1]) mb.box(a + sd * 1.5 - (sd > 0 ? 0.4 : 0), 0, c + z - 0.6, a + sd * 1.5 + (sd < 0 ? 0.4 : 0), 1.2, c + z + 0.6, C(0x161616));
  }
  mb.ground(r.a0, r.c0 - 14, r.a1 - 12, r.c0, 0.12, C(0xa8a49b));
}

// 貨物上屋：大きな金属の建物、エプロン側に扉、陸側にトラックの荷さばき場。前にコンテナ（ULD）
function cargo(mb: MeshBuilder, r: LRect, h: number, rng: Rng) {
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.cargo, PAT.industrial, C(0x8b9096));
  for (let a = r.a0 + 6; a < r.a1 - 8; a += 16) mb.box(a, 0, r.c0 - 0.1, a + 9, 6, r.c0, C(0x5d6267));
  for (let a = r.a0 + 4; a < r.a1 - 4; a += 5) mb.box(a, 0.8, r.c1, a + 3.2, 4, r.c1 + 0.1, C(0x4a4f55));
  mb.box(r.a0 + 2, h - 2.5, r.c0 - 0.08, r.a0 + 30, h - 0.8, r.c0, C(0xe0661c), PAT.glow);
  // コンテナ（ULD）と台車
  for (let k = 0; k < 10; k++) {
    const a = r.a0 + 8 + k * 4.2 + rng.next(), c = r.c0 - 6 - (k % 2) * 3.4;
    mb.box(a - 1.6, 0.1, c - 1.3, a + 1.6, 0.5, c + 1.3, COL.steelDark);
    mb.box(a - 1.5, 0.5, c - 1.2, a + 1.5, 2.1, c + 1.2, rng.next() < 0.6 ? C(0xbfc4c9) : C(0x9aa0a6));
  }
}

// ---- ターミナル前の道路（フォアコート）の、道路のまわりのもの ----
export interface FcInfo {
  cF: number; cR: number; cK: number; // 1 列目・戻りの列の中心、車寄せの縁石（1 列目の車道のターミナル側の縁）
  H: number; // 高架の高さ（地面から）
  yGround: number; yDeck: number; // 地上・高架の車寄せの歩道の高さ
  dep: [number, number] | null; // 出発（高架）の 1 列目の a の範囲
  arr: [number, number] | null; // 到着（地上）の 1 列目の a の範囲
  stack: [number, number] | null; // 2 層が重なる範囲
  term: LRect;
  facade: number;
}
const ROAD_UP = 0.3; // 道路の層の路面の持ち上げ（roadLayer の ROAD_LIFT）
function fcInfo(L: AirportLayout, fc: FcCtx): FcInfo | null {
  const P = fc.plan, term = L.buildings.find((b) => b.kind === 'terminal')!.r;
  const rng = (lv: number): [number, number] | null => {
    const r = P.rows.filter((q) => (q.name === 'Fm' || q.name === 'Fo') && q.lv === lv)[0];
    return r ? [Math.min(r.a0, r.a1), Math.max(r.a0, r.a1)] : null;
  };
  const dep = rng(1), arr = rng(0);
  const stack: [number, number] | null = dep && arr && Math.min(dep[1], arr[1]) > Math.max(dep[0], arr[0]) ? [Math.max(dep[0], arr[0]), Math.min(dep[1], arr[1])] : null;
  const cF = P.lines.F, cK = cF - 4.5;
  return { cF, cR: P.lines.R, cK, H: P.H, yGround: ROAD_UP + 0.16, yDeck: P.H + ROAD_UP + 0.16, dep, arr, stack, term, facade: term.c1 };
}

function forecourtFeatures(mb: MeshBuilder, L: AirportLayout, fc: FcCtx, fi: FcInfo, T: FcTools) {
  const { G, rng } = T;
  const { cF, cK, H, term } = fi;
  const fac = term.c1;
  const PAVE = C(0xc9c4ba), PAVE2 = C(0xb6b0a5), KERB = C(0xd9d5cc);
  const ta0 = term.a0 - 8, ta1 = term.a1 + 8;
  const clip = (r: [number, number] | null): [number, number] | null => (r && Math.min(r[1], ta1) > Math.max(r[0], ta0) ? [Math.max(r[0], ta0), Math.min(r[1], ta1)] : null);
  const dep = clip(fi.dep), arr = clip(fi.arr);
  // 歩道：舗装（3m ごとの目地）、縁石、車止め（ボラード）
  const sidewalk = (a0: number, a1: number, y: number, under: boolean) => {
    // 床（高架は厚い床版。下から見える面も描く）
    if (under) {
      mb.matOverride = MAT.concrete;
      mb.box(a0, y - 1.3, fac, a1, y - 0.16, cK, COL.concrete, PAT.none, COL.concrete, true);
      mb.matOverride = null;
    }
    mb.box(a0, y - 0.16, fac, a1, y, cK, PAVE, PAT.none, PAVE);
    for (let a = a0 + 3; a < a1 - 1; a += 3) G(a, fac + 0.1, a + 0.12, cK - 0.4, y + 0.01, PAVE2);
    G(a0, cK - 1.4, a1, cK - 1.0, y + 0.012, C(0xd8c25a)); // 点字ブロック
    mb.box(a0, y - 0.16, cK - 0.3, a1, y + 0.02, cK, KERB);
    for (let a = a0 + 1.5; a < a1; a += 2.4) mb.box(a - 0.11, y, cK - 0.55, a + 0.11, y + 0.9, cK - 0.33, C(0x4a5056));
  };
  if (dep) sidewalk(dep[0], dep[1], fi.yDeck, true);
  if (arr) sidewalk(arr[0], arr[1], fi.yGround, false);
  // 2 層が重なるところの橋脚：門形（歩道の柱と、分離帯の柱を、高架の下の梁でつなぐ）。24m ごと
  if (fi.stack) {
    const [s0, s1] = fi.stack;
    const cIn = cK - 1.4, cOut = cF + 5.8, top = H + ROAD_UP - 0.38 - 1.25;
    mb.matOverride = MAT.concrete;
    for (let a = s1 - 12; a > s0 + 4; a -= 24) {
      for (const c of [cIn, cOut]) mb.box(a - 0.65, 0, c - 0.65, a + 0.65, top - 1.1, c + 0.65, C(0xb8b4ab));
      mb.box(a - 0.8, top - 1.3, cIn - 0.9, a + 0.8, top, cOut + 0.9, C(0xb8b4ab), PAT.none, C(0xb8b4ab), true);
    }
    mb.matOverride = null;
  }
  // 出発の歩道：ベンチ、荷物のカート、人（静かな形。1 つのメッシュにまとめる）
  const people = (a0: number, a1: number, y: number, k: number) => {
    for (let a = a0 + 6; a < a1 - 4; a += 9 + rng.next() * 8) {
      const c = fac + 1.2 + rng.next() * (cK - fac - 2.6);
      const col = rng.pick([C(0x2b3a55), C(0x6a3b2e), C(0x3d4a3c), C(0x8a8f96), C(0x1f2227), C(0xb08a5a)]);
      mb.box(a - 0.22, y, c - 0.15, a + 0.22, y + 1.05, c + 0.15, C(0x2a2d33));
      mb.box(a - 0.25, y + 1.05, c - 0.17, a + 0.25, y + 1.55, c + 0.17, col);
      mb.box(a - 0.11, y + 1.55, c - 0.11, a + 0.11, y + 1.8, c + 0.11, C(0xe0b89a));
      if (rng.next() < 0.5) mb.box(a + 0.3, y, c - 0.2, a + 0.75, y + 0.65, c + 0.2, rng.pick([C(0x2a2d33), C(0x9a2b2b), C(0x2b4f8a)]));
    }
    for (let a = a0 + 14; a < a1 - 8; a += 30) {
      // ベンチ
      mb.box(a - 1.2, y + 0.42, fac + 1.0, a + 1.2, y + 0.5, fac + 1.6, C(0x8a6440));
      for (const x of [a - 1.0, a + 1.0]) mb.box(x - 0.06, y, fac + 1.1, x + 0.06, y + 0.42, fac + 1.5, C(0x4a5056));
      // 荷物のカート（並べて置いてある）
      if (k) for (let q = 0; q < 3; q++) mb.box(a + 6 + q * 0.5, y, fac + 1.0, a + 6.4 + q * 0.5, y + 0.9, fac + 2.0, C(0x8e9398));
    }
  };
  if (dep) people(dep[0], dep[1], fi.yDeck, 1);
  if (arr) people(arr[0], arr[1], fi.yGround, 0);
  // 到着の車寄せ：西にバスの乗り場（歩道を切り込んだバス停車帯と、止まっている空港バス）、東にタクシー乗り場（並んで待つタクシー）
  if (arr) {
    const bay = (a0: number, a1: number, kind: 'bus' | 'taxi') => {
      // 歩道を切り込んだ停車帯：路面を歩道の内側へ 3.3m 広げる（縁石も切り込む）
      const cb = cK - 3.3, y = fi.yGround;
      mb.box(a0, y - 0.16, cb - 0.3, a1, y + 0.02, cb, KERB);
      G(a0, cb, a1, cK, ROAD_UP + 0.02, C(0x3a3c40));
      for (const [x0, x1] of [[a0, a0 + 0.15], [a1 - 0.15, a1]]) G(x0, cb, x1, cK, ROAD_UP + 0.03, COL.yellow);
      G(a0, cb + 0.15, a1, cb + 0.3, ROAD_UP + 0.03, COL.yellow);
      const mid = (cb + cK) / 2;
      if (kind === 'bus') {
        for (let a = a0 + 2; a + 12 < a1; a += 15) {
          mb.box(a, ROAD_UP + 0.35, mid - 1.25, a + 12, ROAD_UP + 3.3, mid + 1.25, C(0xf0f0ee), PAT.ribbon, C(0xdedede));
          mb.box(a, ROAD_UP + 1.0, mid - 1.27, a + 12, ROAD_UP + 1.35, mid + 1.27, C(0x2a5aa8));
          for (const x of [a + 2, a + 9.5]) for (const c of [mid - 1.2, mid + 1.2]) mb.box(x - 0.5, ROAD_UP, c - 0.15, x + 0.5, ROAD_UP + 1.0, c + 0.15, C(0x1d1f22));
        }
      } else {
        for (let a = a0 + 1.5; a + 4.5 < a1; a += 5.6) {
          mb.box(a, ROAD_UP + 0.3, mid - 0.85, a + 4.5, ROAD_UP + 0.95, mid + 0.85, C(0xe8c22a));
          mb.box(a + 1.1, ROAD_UP + 0.95, mid - 0.75, a + 3.3, ROAD_UP + 1.45, mid + 0.75, C(0x2a3440));
          mb.box(a + 2.0, ROAD_UP + 1.45, mid - 0.2, a + 2.4, ROAD_UP + 1.65, mid + 0.2, C(0xf2f2f0));
        }
      }
      // 乗り場の屋根（木の天井とガラス）
      mb.box(a0 + 1, y + 3.2, cb - 2.6, a1 - 1, y + 3.35, cb + 0.6, C(0x9cc3d4));
      mb.matOverride = MAT.siding; mb.box(a0 + 1, y + 3.0, cb - 2.5, a1 - 1, y + 3.2, cb + 0.5, COL.wood, PAT.lit); mb.matOverride = null;
      for (let a = a0 + 2; a < a1 - 1; a += 8) mb.box(a - 0.1, y, cb - 2.2, a + 0.1, y + 3.0, cb - 2.0, COL.steelDark);
      // 乗り場の案内（光る板）
      mb.box(a0 + 1.5, y + 2.2, cb - 2.3, a0 + 1.7, y + 2.9, cb - 1.1, C(kind === 'bus' ? 0x2a6fb5 : 0xe8c22a), PAT.glow);
    };
    const span = arr[1] - arr[0];
    if (span > 60) {
      bay(arr[0] + 6, arr[0] + 6 + Math.min(47, span * 0.3), 'bus');
      bay(arr[1] - 6 - Math.min(36, span * 0.25), arr[1] - 6, 'taxi');
    }
  }
  // 横断歩道（到着の車寄せから、分離帯・駅のほうへ）：地上の 1 列目と戻りの列。停止線つき
  if (arr) {
    const a = Math.max(arr[0] + 20, Math.min(arr[1] - 20, (term.a0 + term.a1) / 2 + 30));
    const zebra = (c0: number, c1: number) => {
      for (let c = c0 + 0.5; c < c1 - 0.5; c += 1.0) G(a - 2, c, a + 2, c + 0.5, ROAD_UP + 0.035, COL.white);
      G(a + 4, c0 + 0.3, a + 4.4, c1 - 0.3, ROAD_UP + 0.035, COL.white);
    };
    zebra(cK, cF + 4.5);
    if (!fc.plan.rows.some((r) => r.name.startsWith('R') && r.lv === 1)) zebra(fi.cR - 4.5, fi.cR + 4.5);
  }
  // 駐停車禁止の縁石の黄色（車寄せの外の 1 列目）
  for (const [r0, lvY] of [[fi.dep, fi.yDeck], [fi.arr, fi.yGround]] as const) {
    if (!r0) continue;
    const y = lvY - 0.16 + 0.005;
    if (r0[1] > ta1 + 4) G(ta1, cK + 0.15, r0[1] - 8, cK + 0.3, y, COL.yellow);
    if (r0[0] < ta0 - 4) G(r0[0] + 8, cK + 0.15, ta0, cK + 0.3, y, COL.yellow);
  }
  // 植え込みと並木（同じ間隔の列）：1 列目と戻りの列の間の分離帯、U ターンの内側、戻りの列の外側
  const roadPts: [number, number][] = [];
  for (const [name, list] of fc.pts) { void name; for (const p of list) roadPts.push([p[0], p[1]]); }
  const clear = (a: number, c: number, r: number) => {
    for (const [pa, pc] of roadPts) if (Math.abs(pa - a) < r + 12 && Math.abs(pc - c) < r + 12 && Math.hypot(pa - a, pc - c) < r) return false;
    return true;
  };
  const rows = fc.plan.rows;
  const Rrow = rows.find((r) => r.name === 'Rm');
  const medC = (cF + fi.cR) / 2;
  if (Rrow && fi.cR - cF > 12) {
    const a0 = Math.min(Rrow.a0, Rrow.a1) + 10, a1 = Math.max(Rrow.a0, Rrow.a1) - 10;
    const fRow = rows.filter((r) => r.name === 'Fm' || r.name === 'Fo');
    const fa0 = Math.min(...fRow.map((r) => Math.min(r.a0, r.a1))), fa1 = Math.max(...fRow.map((r) => Math.max(r.a0, r.a1)));
    const m0 = Math.max(a0, fa0 + 6), m1 = Math.min(a1, fa1 - 6);
    const wMed = fi.cR - cF - 9 - 1.6;
    if (m1 > m0 && wMed > 1.5) {
      // 縁石つきの植え込み（低い刈り込み）
      mb.box(m0, 0, medC - wMed / 2, m1, 0.5, medC + wMed / 2, C(0xb9b5ad), PAT.none, C(0x5d7f3a));
      mb.box(m0 + 0.4, 0.5, medC - wMed / 2 + 0.4, m1 - 0.4, 1.1, medC + wMed / 2 - 0.4, C(0x4f7234));
      for (let a = m1 - 6; a > m0 + 4; a -= 12) if ((!fi.stack || Math.abs(((fi.stack[1] - 12 - a) % 24 + 24) % 24) > 4)) T.tree(a, medC, 0.55, 0);
    }
  }
  // U ターンの内側：芝生と、輪に並ぶ木
  const U = fc.pts.get('U');
  if (U && U.length > 3) {
    let sa = 0, sc = 0;
    for (const p of U) { sa += p[0]; sc += p[1]; }
    sa /= U.length; sc /= U.length;
    for (let k = 0; k < 10; k++) {
      const t = (k / 10) * Math.PI * 2, a = sa + Math.cos(t) * 9, c = sc + Math.sin(t) * 9;
      if (clear(a, c, 10)) T.tree(a, c, 0.75, 1);
    }
  }
  // 戻りの列の外側（敷地のふちに沿って）
  if (Rrow) {
    const a0 = Math.min(Rrow.a0, Rrow.a1), a1 = Math.max(Rrow.a0, Rrow.a1), c = fi.cR + 9.5;
    for (let a = a1 - 8; a > a0 + 8; a -= 14) {
      if (L.station && a > L.station.a0 - 10 && a < L.station.a1 + 10 && L.station.c0 < c + 4) continue;
      if (L.buildings.some((b) => !b.sub === (L.land.rot === 0) && a > b.r.a0 - 4 && a < b.r.a1 + 4 && c > b.r.c0 - 4 && c < b.r.c1 + 4)) continue;
      if (c < L.land.edge - 1.5 && clear(a, c, 9)) T.tree(a, c, 0.7, 0);
    }
  }
  // 街灯（地上の歩道の縁）
  if (arr) for (let a = arr[0] + 10; a < arr[1]; a += 30) { T.light(a, fi.yGround + 3.6, fac + 0.5, LIGHT.street, 3); }
}

interface FcTools {
  light: (a: number, y: number, c: number, col: readonly number[], s: number) => void;
  pool: (a: number, c: number, y: number, size: number) => void;
  tree: (a: number, c: number, s?: number, kind?: number) => void;
  G: (a0: number, c0: number, a1: number, c1: number, y: number, col: THREE.Color) => void;
  pline: (pts: [number, number][], w: number, y: number, col: THREE.Color) => void;
  rng: Rng;
}
