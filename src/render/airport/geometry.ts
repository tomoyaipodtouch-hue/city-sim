// 空港の動かない形：芝生、滑走路・誘導路・駐機場の舗装と路面の表示（実際の規格どおり）、ターミナル（木とガラスの大屋根）、
// 屋上の展望デッキ、管制塔、空港ホテルとオフィス、駐車場ビル、空港駅、高架の出発ロビー前の道路、格納庫（中に機体）、
// 燃料タンク、空港の消防署、貨物上屋。それと夜の灯火の位置と色（灯火は lights.ts でまとめて 1 回で描く）。
// 形は敷地の座標（a = 滑走路の向き、c = 横、+c が陸側）で作り、MeshBuilder の変換で世界の座標にする。
import * as THREE from 'three';
import { MeshBuilder, PAT } from '../builder';
import { MAT } from '../textures';
import { CELL } from '../../sim/constants';
import { AirFrame, AirportLayout, LRect, rotAngle, runwayNumber } from '../../sim/airport';
import type { TreeSpot } from '../buildingGen';
import { buildAircraft, LIVERIES } from './aircraft';
import { Rng } from '../../sim/rng';

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
  centre: { idx: number; a: number }[];
  beacons: number[]; // 航空障害灯（x, y, z）
  pools: number[]; // 地面を照らす光（x, y, z, 大きさ）
  trees: TreeSpot[];
}
export interface AirCtx {
  cells: number[]; // 敷地のマス
  n: number;
  base: number;
  seed: number;
  access: [number, number][]; // 一般道の入口（敷地の座標）
  highway: { a: number; c: number; h: number } | null; // 高速道路の出入口（敷地の外のマスの中心と、路面の高さ）
  lines: string[]; // 空港駅につながっている線
}

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
  const W = (a: number, y: number, c: number): [number, number, number] => [a * f.cos - c * f.sin + f.cx, y + base, a * f.sin + c * f.cos + f.cz];
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

  const rw = L.runways[0], rc = rw.c, rwW = rw.width, hw = rwW / 2;
  // ---- 滑走路：路肩、舗装、両端の過走帯（黄色の山形） ----
  G(rw.a0 - 32, rc - hw - 4, rw.a1 + 32, rc + hw + 4, 0.08, COL.shoulder);
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
    // 進入端の標識（ピアノキー）：幅 30m の滑走路は 8 本
    for (const o of [2.7, 6.3, 9.9, 13.5]) for (const sd of [-1, 1]) G(end + dir * 6, rc + sd * o - 0.9, end + dir * 36, rc + sd * o + 0.9, 0.14, COL.white);
    // 滑走路の番号（高さ 9m）
    text(num, end + dir * 48, rc, 9, dir, 0.14, COL.white);
    // 接地帯の標識（150m）と、目標点の標識（250m）
    for (const sd of [-1, 1]) {
      for (const o of [5.0, 8.4]) G(end + dir * 150, rc + sd * o - 0.9, end + dir * 172.5, rc + sd * o + 0.9, 0.14, COL.white);
      G(end + dir * 250, rc + sd * 7.5 - 2, end + dir * 295, rc + sd * 7.5 + 2, 0.14, COL.white);
    }
  }
  // 中心線（30m の線と 20m のすき間）
  for (let a = rw.a0 + 70; a + 30 <= rw.a1 - 70; a += 50) G(a, rc - 0.45, a + 30, rc + 0.45, 0.14, COL.white);

  // ---- 平行誘導路と取付誘導路 ----
  const tc = L.taxiC, tw = L.taxiW;
  G(L.taxiA0 - tw / 2, tc - tw / 2, L.taxiA1 + tw / 2, tc + tw / 2, 0.1, COL.taxi);
  for (const la of rw.links) {
    G(la - tw / 2, rc + hw, la + tw / 2, tc - tw / 2, 0.1, COL.taxi);
    // 角を広げる（隅切り）
    for (const sd of [-1, 1]) {
      mb.matOverride = MAT.ground;
      const ccc = tc - tw / 2, a1 = la + sd * tw / 2;
      if (sd > 0) mb.tri([a1, 0.1, ccc], [a1 + 12, 0.1, ccc], [a1, 0.1, ccc - 12], COL.taxi);
      else mb.tri([a1, 0.1, ccc], [a1, 0.1, ccc - 12], [a1 - 12, 0.1, ccc], COL.taxi);
      const crw = rc + hw;
      if (sd > 0) mb.tri([a1, 0.1, crw], [a1, 0.1, crw + 10], [a1 + 10, 0.1, crw], COL.taxi);
      else mb.tri([a1, 0.1, crw], [a1 - 10, 0.1, crw], [a1, 0.1, crw + 10], COL.taxi);
      mb.matOverride = null;
    }
    // 中心線（黄色）：滑走路の中心線から曲がって誘導路へ
    const inward = la < 0 ? 1 : -1;
    pline([[la, rc], ...arc(la + inward * 14, tc - 14, 14, inward > 0 ? Math.PI : 0, Math.PI / 2)], 0.3, 0.14, COL.yellow);
    // 滑走路の手前の停止位置（実線 2 本・破線 2 本。実線が誘導路の側）
    const hc = rw.holdC;
    for (const o of [0, 0.9]) G(la - tw / 2, hc + 2.7 + o, la + tw / 2, hc + 2.7 + o + 0.3, 0.14, COL.yellow);
    for (const o of [0, 0.9]) for (let a = la - tw / 2; a < la + tw / 2 - 0.5; a += 1.8) G(a, hc + o, a + 0.9, hc + o + 0.3, 0.14, COL.yellow);
    // 停止位置の標識（赤地）
    for (const sd of [-1, 1]) {
      const a = la + sd * (tw / 2 + 3);
      mb.box(a - 0.1, 0.1, hc + 1.4, a + 0.1, 0.6, hc + 1.6, COL.steelDark);
      mb.box(a - 1.4, 0.6, hc + 1.3, a + 1.4, 1.6, hc + 1.7, COL.red);
    }
  }
  // 誘導路の中心線
  G(L.taxiA0 + 14, tc - 0.15, L.taxiA1 - 14, tc + 0.15, 0.14, COL.yellow);

  // ---- エプロン（駐機場）：コンクリート舗装と目地 ----
  for (const ap of L.aprons) {
    G(ap.a0, ap.c0, ap.a1, ap.c1, 0.1, COL.apron);
    for (let a = ap.a0 + 7.5; a < ap.a1; a += 7.5) G(a - 0.08, ap.c0, a + 0.08, ap.c1, 0.115, COL.apronJoint);
    for (let c = ap.c0 + 7.5; c < ap.c1; c += 7.5) G(ap.a0, c - 0.08, ap.a1, c + 0.08, 0.115, COL.apronJoint);
  }
  // 誘導路とエプロンの境：エプロンの縁の線
  // 駐機スポット：誘導路の中心線から曲がって入る誘導線、停止線、番号、機材の置き場の赤い線
  L.stands.forEach((st, k) => {
    const sc0 = tc + 18;
    pline([[st.a - 18, tc], ...arc(st.a - 18, tc + 18, 18, -Math.PI / 2, 0, 10), [st.a, st.noseC - 2]], 0.3, 0.14, COL.yellow);
    pline([[st.a + 18, tc], ...arc(st.a + 18, tc + 18, 18, -Math.PI / 2, -Math.PI, 10), [st.a, sc0]], 0.3, 0.14, COL.yellow);
    G(st.a - 2.5, st.noseC - 0.3, st.a + 2.5, st.noseC + 0.3, 0.14, COL.white); // 停止線
    G(st.a - 0.6, st.noseC - 4.3, st.a + 0.6, st.noseC - 3.7, 0.14, COL.white); // 小さい機材の停止線
    text(String(k + 1), sc0 + 2, st.a + 4, 4, 1, 0.14, COL.yellow);
    if (!st.cargo) for (const sd of [-1, 1]) G(st.a + sd * 22 - 0.15, tc + 10, st.a + sd * 22 + 0.15, st.noseC + 1, 0.14, COL.red);
  });
  // 構内道路（エプロンの、ターミナルの前）：白い縁と破線、乗客が歩く横断歩道
  {
    const sv = L.serviceC, ap = L.aprons[0];
    G(ap.a0, sv - 3.3, ap.a1, sv - 3.0, 0.14, COL.white);
    G(ap.a0, sv + 3.0, ap.a1, sv + 3.3, 0.14, COL.white);
    for (let a = ap.a0 + 2; a < ap.a1 - 3; a += 6) G(a, sv - 0.1, a + 3, sv + 0.1, 0.14, COL.white);
    for (const st of L.stands) {
      if (st.cargo) continue;
      for (let a = st.a + 4.5; a < st.a + 10.5; a += 1.2) G(a, sv - 3, a + 0.6, sv + 3, 0.141, COL.white);
    }
  }

  // ---- 陸側の道路（到着の車寄せ・アクセス道路）と高架の出発ロビー前の道路 ----
  const [rc0, rc1] = L.roadC;
  G(-A / 2, rc0, A / 2, rc1, 0.1, COL.road);
  G(-A / 2, rc0 - 3, A / 2, rc0, 0.25, COL.walk);
  G(-A / 2, rc1, A / 2, rc1 + 2, 0.25, COL.walk);
  mb.box(-A / 2, 0, rc0 - 0.25, A / 2, 0.25, rc0, COL.curb);
  for (let a = -A / 2 + 3; a < A / 2 - 6; a += 9) G(a, (rc0 + rc1) / 2 - 0.1, a + 4.5, (rc0 + rc1) / 2 + 0.1, 0.14, COL.white);
  G(-A / 2, rc0 + 3.2, A / 2, rc0 + 3.35, 0.14, COL.white);
  // 一般道の入口（敷地の陸側のふちまで）
  for (const [a, c] of ctx.access) {
    if (c < rc1) continue;
    const aa = Math.max(-A / 2 + 6, Math.min(A / 2 - 6, a));
    G(aa - 5, rc1, aa + 5, Cw / 2, 0.1, COL.road);
  }
  const V = L.viaduct;
  {
    const yd = V.h;
    // 床版と欄干、柱
    mb.matOverride = MAT.concrete;
    mb.box(V.a0, yd - 0.8, V.c0, V.a1, yd, V.c1, COL.concrete);
    mb.box(V.a0, yd, V.c1 - 0.3, V.a1, yd + 1.1, V.c1, COL.concrete);
    for (let a = V.a0 + 6; a < V.a1; a += 22) for (const c of [V.c0 + 2, V.c1 - 2]) mb.box(a - 0.5, 0, c - 0.5, a + 0.5, yd - 0.8, c + 0.5, COL.concreteDark);
    // 両端の坂道
    for (const sd of [-1, 1]) {
      const a0 = sd > 0 ? V.a1 : V.a0, a1 = a0 + sd * V.ramp;
      const p = (a: number, y: number, c: number): [number, number, number] => [a, y, c];
      if (sd > 0) {
        mb.quad(p(a0, yd, V.c1), p(a1, 0.12, V.c1), p(a1, 0.12, V.c0), p(a0, yd, V.c0), COL.road);
        mb.quad(p(a0, yd - 0.8, V.c0), p(a1, 0.1, V.c0), p(a1, 0.1, V.c1), p(a0, yd - 0.8, V.c1), COL.concreteDark);
        mb.quad(p(a0, yd - 0.8, V.c1), p(a1, 0.0, V.c1), p(a1, 0.12, V.c1), p(a0, yd, V.c1), COL.concrete);
        mb.quad(p(a1, 0.0, V.c0), p(a0, yd - 0.8, V.c0), p(a0, yd, V.c0), p(a1, 0.12, V.c0), COL.concrete);
      } else {
        mb.quad(p(a1, 0.12, V.c1), p(a0, yd, V.c1), p(a0, yd, V.c0), p(a1, 0.12, V.c0), COL.road);
        mb.quad(p(a1, 0.1, V.c0), p(a0, yd - 0.8, V.c0), p(a0, yd - 0.8, V.c1), p(a1, 0.1, V.c1), COL.concreteDark);
        mb.quad(p(a1, 0.0, V.c1), p(a0, yd - 0.8, V.c1), p(a0, yd, V.c1), p(a1, 0.12, V.c1), COL.concrete);
        mb.quad(p(a0, yd - 0.8, V.c0), p(a1, 0.0, V.c0), p(a1, 0.12, V.c0), p(a0, yd, V.c0), COL.concrete);
      }
    }
    mb.matOverride = null;
    G(V.a0, V.c0, V.a1, V.c1, yd + 0.02, COL.road);
    for (let a = V.a0 + 2; a < V.a1 - 4; a += 9) G(a, (V.c0 + V.c1) / 2 - 0.1, a + 4.5, (V.c0 + V.c1) / 2 + 0.1, yd + 0.05, COL.white);
    // 出発の車寄せの歩道
    G(V.a0, V.c0 - 1.5, V.a1, V.c0, yd + 0.12, COL.walk);
    // 止まっている車（送迎・タクシー）
    for (let a = V.a0 + 12; a < V.a1 - 10; a += 11 + rng.next() * 9) car(mb, a, yd + 0.05, V.c0 + 1.6, rng, 0);
    for (let a = V.a0 + 8; a < V.a1 - 8; a += 9 + rng.next() * 10) car(mb, a, 0.1, rc0 + 1.5, rng, 0);
    for (let a = -A / 2 + 30; a < A / 2 - 30; a += 40 + rng.next() * 70) car(mb, a, 0.1, rc0 + (rng.next() < 0.5 ? 5.5 : 9.5), rng, rng.next() < 0.5 ? 0 : Math.PI);
  }
  // 街灯（陸側の道路の両側）
  for (let a = -A / 2 + 15; a < A / 2 - 10; a += 32) {
    for (const c of [rc0 - 1.5, rc1 + 1]) {
      if (c < rc1 && a > V.a0 - V.ramp && a < V.a1 + V.ramp) continue;
      mb.box(a - 0.1, 0, c - 0.1, a + 0.1, 8, c + 0.1, COL.steelDark);
      mb.box(a - 0.3, 7.8, c - 0.3, a + 0.3, 8.1, c + 0.3, COL.steelDark);
      light(a, 7.8, c, LIGHT.street, 6);
      pool(a, c, 0.3, 14);
    }
  }
  // 高速道路の出入口（空港専用ランプ）：陸側の道路から、敷地のふちの高速道路の高さまで上る
  if (ctx.highway && ctx.highway.c > rc1) {
    const H = Math.max(0, ctx.highway.h), ah = Math.max(-A / 2 + 12, Math.min(A / 2 - 12, ctx.highway.a));
    let sg = ah > 0 ? 1 : -1;
    const len = Math.max(40, H * 9);
    if (Math.abs(ah + sg * len) > A / 2 - 4) sg = -sg;
    const cA = rc1 + 2.5, cB = Cw / 2 - 0.5, ae = ah, as = ah + sg * len;
    const lo = Math.min(as, ae), hi = Math.max(as, ae);
    const yAt = (a: number) => (H * (a - as)) / (ae - as);
    // 床（坂）と側面、橋脚
    const NS = 8;
    for (let k = 0; k < NS; k++) {
      const a0 = lo + ((hi - lo) * k) / NS, a1 = lo + ((hi - lo) * (k + 1)) / NS, y0 = yAt(a0) + 0.12, y1 = yAt(a1) + 0.12;
      mb.quad([a0, y0, cB], [a1, y1, cB], [a1, y1, cA], [a0, y0, cA], COL.road);
      mb.quad([a0, Math.max(0, y0 - 1), cB], [a0, y0, cB], [a1, y1, cB], [a1, Math.max(0, y1 - 1), cB], COL.concrete);
      mb.quad([a1, Math.max(0, y1 - 1), cA], [a1, y1, cA], [a0, y0, cA], [a0, Math.max(0, y0 - 1), cA], COL.concrete);
      mb.box(Math.min(a0, a1), y0 + 0.1, cA - 0.3, Math.max(a0, a1), y0 + 1.0, cA, COL.concrete);
      if (y0 > 2.5) mb.box((a0 + a1) / 2 - 0.5, 0, (cA + cB) / 2 - 0.5, (a0 + a1) / 2 + 0.5, (y0 + y1) / 2 - 0.9, (cA + cB) / 2 + 0.5, COL.concreteDark);
    }
    // 案内標識（緑の門形）
    const ga = as + sg * 6;
    mb.box(ga - 0.2, 0, cA - 1.2, ga + 0.2, 6.5, cA - 0.8, COL.steelDark);
    mb.box(ga - 0.2, 0, cB + 0.2, ga + 0.2, 6.5, cB + 0.6, COL.steelDark);
    mb.box(ga - 0.15, 5.2, cA - 1.2, ga + 0.15, 7.2, cB + 0.6, C(0x1f6b45), PAT.glow);
  }
  // 陸側の植え込み
  for (let a = -A / 2 + 12; a < A / 2 - 12; a += 18) {
    if (Math.abs(a) < L.station.a1 + 6) continue;
    if (ctx.access.some(([aa, cc]) => cc > rc1 && Math.abs(aa - a) < 9)) continue;
    tree(a, rc1 + 6 + rng.next() * 3, 0.8 + rng.next() * 0.3, rng.next() < 0.3 ? 1 : 0);
  }

  // ---- 建物 ----
  for (const bd of L.buildings) {
    switch (bd.kind) {
      case 'pier': pier(mb, bd.r, bd.h, rng); break;
      case 'terminal': terminal(mb, bd.r, bd.h, L, light); break;
      case 'tower': tower(mb, bd.r, bd.h, L, beacon); break;
      case 'hotel': hotel(mb, bd.r, bd.h, beacon); break;
      case 'office': office(mb, bd.r, bd.h, beacon); break;
      case 'carpark': carpark(mb, bd.r, bd.h, rng); break;
      case 'station': station(mb, bd.r, bd.h, L, ctx.lines); break;
      case 'hangar': hangar(mb, bd.r, bd.h, beacon, light, (a, c, rot) => mb.setTransform(ang + rot, a * f.cos - c * f.sin + f.cx, base + 0.12, a * f.sin + c * f.cos + f.cz), () => mb.setTransform(ang, f.cx, base, f.cz)); break;
      case 'fuel': fuel(mb, bd.r); break;
      case 'fire': fireStation(mb, bd.r, bd.h); break;
      case 'cargo': cargo(mb, bd.r, bd.h, rng); break;
    }
  }
  // 駐機場の車両の車庫（使っていない車）
  {
    const [da, dc] = L.depot;
    G(da - 22, dc - 12, da + 30, dc + 14, 0.13, C(0xa5a39d));
    for (let k = 0; k < 5; k++) G(da - 20 + k * 10, dc - 11, da - 19.85 + k * 10, dc + 13, 0.14, COL.white);
    for (let k = 0; k < 4; k++) mb.box(da - 18 + k * 10, 0.1, dc - 8, da - 15 + k * 10, 1.5, dc - 2, k % 2 ? C(0xf2c230) : C(0xe8772e));
    mb.box(da + 14, 0.1, dc - 9, da + 16.6, 3.2, dc + 4, C(0xe9ebec));
    mb.box(da + 19, 0.1, dc - 9, da + 21.6, 3.2, dc + 4, C(0xe9ebec));
  }
  // 吹き流し（滑走路の横）
  for (const a of [rw.a0 + 150, rw.a1 - 150]) {
    const c = rc + hw + 14;
    mb.cylinder(a, c, 0.05, 6, 0.08, 6, COL.steelDark);
    for (let k = 0; k < 5; k++) mb.cylinder(a + 0.6 + k * 0.7, c, 5.4 - k * 0.03, 6.0 - k * 0.03, 0.42 - k * 0.06, 8, k % 2 ? COL.white : C(0xf26b1d), undefined, 0.4 - k * 0.06);
  }

  // ---- 夜の灯火 ----
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
    out.centre.push({ idx: out.lights.length / 7, a });
    light(a, 0.25, rc, LIGHT.clWhite, 2.6);
  }
  // 誘導路の縁（青、30m ごと）と中心線（緑、15m ごと）
  for (let a = L.taxiA0; a <= L.taxiA1; a += 30) {
    light(a, 0.4, tc - tw / 2 - 1, LIGHT.txEdge, 3);
    const onApron = L.aprons.some((ap) => a > ap.a0 - 4 && a < ap.a1 + 4);
    if (!onApron) light(a, 0.4, tc + tw / 2 + 1, LIGHT.txEdge, 3);
  }
  for (let a = L.taxiA0 + 15; a < L.taxiA1 - 7; a += 15) light(a, 0.2, tc, LIGHT.txCl, 2.4);
  for (const la of rw.links) {
    for (let c = rc + hw + 6; c < tc - 6; c += 7) light(la, 0.2, c, LIGHT.txCl, 2.4);
    for (let c = rc + hw + 4; c < tc - tw / 2; c += 12) for (const sd of [-1, 1]) light(la + sd * (tw / 2 + 1), 0.4, c, LIGHT.txEdge, 3);
  }
  // エプロンの照明塔
  const masts: [number, number][] = [[-110, 36.5], [-27.5, 36.5], [27.5, 36.5], [110, 36.5], [L.aprons[1].a0 + 4, L.aprons[1].c1 - 2], [L.aprons[2].a1 - 4, L.aprons[2].c1 - 2]];
  for (const [a, c] of masts) {
    mb.cylinder(a, c, 0, 24, 0.35, 8, COL.steelDark, undefined, 0.22);
    mb.box(a - 2.2, 24, c - 0.6, a + 2.2, 25.4, c + 0.4, COL.steelDark);
    for (const o of [-1.5, 0, 1.5]) light(a + o, 24.6, c - 0.8, LIGHT.flood, 6);
    pool(a, c - 22, 0.25, 46);
  }
  void tree;
  return out;
}

// 止まっている車
const CARCOL = [0xf2f2f0, 0x1d1f22, 0x8d9399, 0xb8bcc1, 0x8a2a24, 0x284a78, 0x3d5a40, 0xd8c34a].map(C);
function car(mb: MeshBuilder, a: number, y: number, c: number, rng: Rng, rot: number) {
  const col = rng.pick(CARCOL);
  const l = 4.4, w = 1.8;
  void rot;
  mb.box(a - l / 2, y + 0.25, c - w / 2, a + l / 2, y + 0.95, c + w / 2, col);
  mb.box(a - l / 2 + 0.9, y + 0.95, c - w / 2 + 0.12, a + l / 2 - 1.1, y + 1.45, c + w / 2 - 0.12, C(0x2a3440));
}

// 搭乗口の低い建物（ガラス）と、屋上の展望デッキ（人が飛行機を見ている）
function pier(mb: MeshBuilder, r: LRect, h: number, rng: Rng) {
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.glass, PAT.terminal, COL.concrete);
  // 搭乗口のドア（エプロン側、スポットの前）
  for (const a of [-48, 7, 62]) mb.box(a - 1.8, 0, r.c0 - 0.05, a + 1.8, 2.6, r.c0, C(0x2a2f36));
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

// ターミナル：ガラスの箱（2 層）の上に、木の天井の大きな波打つ屋根。陸側は出発ロビー前の道路の上まで張り出す。
// 屋根は木のような柱（幹から枝が 4 本）で支える
function terminal(mb: MeshBuilder, r: LRect, h: number, L: AirportLayout, light: (a: number, y: number, c: number, col: readonly number[], s: number) => void) {
  mb.box(r.a0, 0, r.c0, r.a1, h, r.c1, COL.glass, PAT.terminal, COL.concrete);
  // 2 階の床の帯（木）
  mb.matOverride = MAT.siding;
  mb.box(r.a0 - 0.2, 6.0, r.c0 - 0.2, r.a1 + 0.2, 6.6, r.c1 + 0.2, COL.wood);
  mb.matOverride = null;
  // 入口（陸側：1 階は到着、2 階は出発）
  for (let a = r.a0 + 16; a < r.a1 - 10; a += 30) {
    mb.box(a - 2.5, 0, r.c1, a + 2.5, 2.8, r.c1 + 0.1, C(0x2a2f36));
    mb.box(a - 2.5, 6.6, r.c1, a + 2.5, 9.4, r.c1 + 0.1, C(0x2a2f36));
  }
  // 大屋根：a に沿って波打つ。陸側へ少し高くなる
  const a0 = r.a0 - 12, a1 = r.a1 + 12, c0 = r.c0 - 1.5, c1 = L.viaduct.c1 + 4;
  const NA = 40, NC = 4;
  const yAt = (a: number, c: number) => h + 2.2 + 2.2 * Math.sin((a / 46) * Math.PI) + ((c - c0) / (c1 - c0)) * 2.4;
  const th = 1.1;
  for (let i = 0; i < NA; i++) for (let j = 0; j < NC; j++) {
    const aa = a0 + ((a1 - a0) * i) / NA, ab = a0 + ((a1 - a0) * (i + 1)) / NA;
    const ca = c0 + ((c1 - c0) * j) / NC, cb = c0 + ((c1 - c0) * (j + 1)) / NC;
    // 上の面（明るい金属。ところどころ天窓）
    const sky = i % 8 === 3 && j > 0 && j < NC - 1;
    mb.quad([aa, yAt(aa, cb), cb], [ab, yAt(ab, cb), cb], [ab, yAt(ab, ca), ca], [aa, yAt(aa, ca), ca], sky ? C(0xb9c3c6) : COL.roofTop, sky ? PAT.lit : 0);
    // 下の面（木の天井。夜は照らされて温かく光る）
    mb.quad([aa, yAt(aa, ca) - th, ca], [ab, yAt(ab, ca) - th, ca], [ab, yAt(ab, cb) - th, cb], [aa, yAt(aa, cb) - th, cb], COL.woodDark, PAT.lit);
  }
  // 屋根のふち（木の鼻隠し）
  mb.matOverride = MAT.siding;
  for (let i = 0; i < NA; i++) {
    const aa = a0 + ((a1 - a0) * i) / NA, ab = a0 + ((a1 - a0) * (i + 1)) / NA;
    mb.quad([aa, yAt(aa, c1) - th, c1], [ab, yAt(ab, c1) - th, c1], [ab, yAt(ab, c1), c1], [aa, yAt(aa, c1), c1], COL.wood);
    mb.quad([ab, yAt(ab, c0) - th, c0], [aa, yAt(aa, c0) - th, c0], [aa, yAt(aa, c0), c0], [ab, yAt(ab, c0), c0], COL.wood);
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
  // 木のような柱（陸側、道路の外側）
  const cc = c1 - 2.5;
  for (let a = r.a0 + 4; a <= r.a1 - 4; a += 28) {
    mb.cylinder(a, cc, 0, 8.5, 0.45, 10, COL.steel, undefined, 0.4);
    const top = yAt(a, cc) - th;
    for (const [da, dc] of [[-4, -2.2], [4, -2.2], [-4, 1.5], [4, 1.5]]) {
      const ta = a + da, tcc = cc + dc, ty = yAt(ta, tcc) - th;
      const p0: [number, number] = [a, cc];
      // 枝（細い角柱を斜めに）
      const w = 0.18;
      mb.quad([p0[0] - w, 8.3, p0[1]], [p0[0] + w, 8.3, p0[1]], [ta + w, ty, tcc], [ta - w, ty, tcc], COL.steel);
      mb.quad([p0[0] + w, 8.3, p0[1]], [p0[0] - w, 8.3, p0[1]], [ta - w, ty, tcc], [ta + w, ty, tcc], COL.steel);
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
  const ring = (rad: number, n: number, rot = 0): [number, number][] => Array.from({ length: n }, (_, k) => [ta + Math.cos((k / n) * Math.PI * 2 + rot) * rad, tcc + Math.sin((k / n) * Math.PI * 2 + rot) * rad]);
  // 塔（下が太い）
  mb.prism(ring(3.4, 16), h, th - 8, COL.towerWhite, PAT.none, null, ring(2.5, 16));
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
  mb.prism(ring(4.6, 8, Math.PI / 8), th - 8, th - 5.5, COL.steelDark, PAT.none, COL.concrete, ring(5.2, 8, Math.PI / 8));
  mb.prism(ring(5.2, 8, Math.PI / 8), th - 5.5, th, COL.cabGlass, PAT.fullglass, null, ring(6.6, 8, Math.PI / 8));
  // 屋根（張り出す）とアンテナ
  mb.prism(ring(7.4, 8, Math.PI / 8), th, th + 0.8, COL.towerWhite, PAT.none, COL.concrete);
  mb.box(ta - 0.25, th + 0.8, tcc - 0.25, ta + 0.25, th + 7, tcc + 0.25, COL.steelDark);
  mb.box(ta + 2, th + 0.8, tcc - 0.15, ta + 2.3, th + 4, tcc + 0.15, COL.steelDark);
  // 夜の管制室のうす明かり（光る帯）
  mb.prism(ring(5.0, 8, Math.PI / 8), th - 5.4, th - 5.0, C(0x7fb3a0), PAT.glow, null);
  beacon(ta, th + 7.2, tcc);
  beacon(ta + 7.3, th + 0.9, tcc);
  beacon(ta - 7.3, th + 0.9, tcc);
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
function station(mb: MeshBuilder, r: LRect, h: number, L: AirportLayout, lines: string[]) {
  const elevated = lines.includes('erail') || lines.includes('mono');
  const py = elevated ? 8 : 0;
  // ホーム
  mb.box(r.a0, py, r.c0 + 3, r.a1, py + 1.1, r.c1, COL.platform, PAT.none, C(0xd6d1c6));
  if (elevated) for (let a = r.a0 + 6; a < r.a1; a += 20) mb.box(a - 0.6, 0, r.c0 + 5.5, a + 0.6, py, r.c0 + 7, COL.concrete);
  mb.box(r.a0, py + 1.1, r.c1 - 0.6, r.a1, py + 1.12, r.c1 - 0.3, COL.yellow);
  // 屋根（白い鉄骨と、ガラスの帯）
  for (let a = r.a0 + 4; a < r.a1; a += 12) mb.box(a - 0.15, py + 1.1, r.c0 + 5, a + 0.15, py + h, r.c0 + 5.3, COL.steel);
  mb.box(r.a0, py + h, r.c0 + 2, r.a1, py + h + 0.4, r.c1 + 1.5, COL.steel, PAT.none, C(0xe8eaec));
  mb.box(r.a0 + 2, py + h + 0.4, r.c0 + 5, r.a1 - 2, py + h + 0.5, r.c0 + 7, C(0x8fb3c8));
  // 駅舎（真ん中）と、ターミナルへの渡り廊下
  mb.box(-16, 0, r.c0 - 1, 16, py + h + 3, r.c0 + 4, COL.glass, PAT.terminal, COL.concrete);
  mb.box(-5, 9.5, L.buildings[1].r.c1, 5, 12.5, r.c0 - 1, COL.glass, PAT.terminal, COL.steel);
  for (const c of [L.roadC[0] + 1, L.roadC[1] - 1]) mb.box(-0.4, 0, c - 0.4, 0.4, 9.5, c + 0.4, COL.steel);
  // 駅名の看板（光る帯）
  mb.box(-12, py + h + 1.2, r.c0 - 1.05, 12, py + h + 2.4, r.c0 - 0.95, C(0x2a6fb5), PAT.glow);
}

// 格納庫：かまぼこ形の屋根、エプロン側の大きな扉は開いていて、中に整備中の機体
function hangar(mb: MeshBuilder, r: LRect, h: number, beacon: (a: number, y: number, c: number) => void, light: (a: number, y: number, c: number, col: readonly number[], s: number) => void, at: (a: number, c: number, rot: number) => void, back: () => void) {
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
  buildAircraft(mb, 'a220', LIVERIES[0]);
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
