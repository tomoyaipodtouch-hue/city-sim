// CIQ庁舎（税関・出入国管理・検疫）：白とガラスの中層の庁舎（旗ざお、植え込み、駐車場）と、
// コンテナのX線検査場（門形の大きな検査棟、検査を待つトレーラーの列、検査のヤード、フェンス、ブース）。
// 敷地の座標：x は -W/2..W/2、z は -D/2..D/2、+z が道路の側（正面）、y = 0 が敷地の地面
import * as THREE from 'three';
import { PAT } from './builder';
import type { MeshBuilder } from './builder';
import { MAT } from './textures';
import type { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';
import { LB, type PoolAt } from './logisticsB';

const { bx, gq, wq, vehicle, carRow, fence, mastT, pole, booth, boxCol, K, LINES, CABS } = LB;
type P3 = [number, number, number];
const C = (h: number) => new THREE.Color(h);

// ---------------- 色 ----------------
const Q = {
  white: C(0xf2f3f4), white2: C(0xe1e5e9), frame: C(0xd3d8dd), glass: C(0x6d93b3), glassDk: C(0x3d5870),
  stone: C(0xd8d4ca), stone2: C(0xc6c1b5), navy: C(0x1d3a6b), conc: C(0xc5c2ba), concDk: C(0xa9a69e),
  portal: C(0x2f6cb0), portalDk: C(0x24558c), haz: C(0xf2c200), black: C(0x1e2023), tunnel: C(0x2a2c2f),
  red: C(0xd0362b), green: C(0x2fbf5a), sign: C(0xf4f6fa), asphalt: C(0x4a4d51), lane: C(0x55585c), pallet: C(0xa0784c), carton: C(0xc8ab7c),
};

// 下を向いた面（ひさしや天井の照明）
function down(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, col: THREE.Color, pat = PAT.glow) {
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], col, pat);
  mb.matOverride = keep;
}

// 旗ざおと旗（旗は +x へなびく、正面 +z に向いた面）
type Flag = 'jp' | 'customs' | 'blue';
function flagpole(mb: MeshBuilder, x: number, z: number, h: number, kind: Flag) {
  bx(mb, x - 0.08, 0, z - 0.08, x + 0.08, h, z + 0.08, Q.white2, 0, { m: MAT.metal });
  bx(mb, x - 0.14, h, z - 0.14, x + 0.14, h + 0.22, z + 0.14, C(0xd9b44a), 0, { m: MAT.metal });
  bx(mb, x - 0.3, 0, z - 0.3, x + 0.3, 0.25, z + 0.3, Q.stone2);
  const fw = 1.9, fh = 1.27, y1 = h - 0.2, y0 = y1 - fh, x0 = x + 0.1, x1 = x0 + fw;
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  const field = kind === 'jp' ? Q.white : kind === 'customs' ? Q.navy : C(0x2c79c9);
  // 少しなびかせる（2 枚の面を折る）
  const xm = (x0 + x1) / 2, dz = 0.18;
  for (const s of [1, -1]) {
    const q = (a: P3, b: P3, c: P3, d: P3) => (s > 0 ? mb.quad(a, b, c, d, field) : mb.quad(b, a, d, c, field));
    q([x0, y0, z], [xm, y0 - 0.05, z + dz], [xm, y1 - 0.05, z + dz], [x0, y1, z]);
    q([xm, y0 - 0.05, z + dz], [x1, y0 - 0.1, z], [x1, y1 - 0.1, z], [xm, y1 - 0.05, z + dz]);
  }
  // 日の丸（両面に赤い円）／税関の旗（白い横の帯）／青い旗（白い丸）
  const cx = x0 + fw * 0.5, cy = (y0 + y1) / 2 - 0.05, zc = z + dz;
  if (kind === 'jp' || kind === 'blue') {
    const r = fh * (kind === 'jp' ? 0.3 : 0.22), col = kind === 'jp' ? Q.red : Q.white, n = 14;
    for (const s of [1, -1]) {
      const P = (k: number): P3 => { const a = (k / n) * Math.PI * 2; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, zc + s * 0.012]; };
      for (let k = 0; k < n; k++) (s > 0 ? mb.tri([cx, cy, zc + s * 0.012], P(k), P(k + 1), col) : mb.tri([cx, cy, zc + s * 0.012], P(k + 1), P(k), col));
    }
  } else {
    for (const s of [1, -1]) {
      const a: P3 = [x0 + 0.1, cy - 0.12, z + s * 0.012], b: P3 = [x1 - 0.1, cy - 0.17, z + s * 0.012];
      const zz = (p: P3, t: number): P3 => [p[0], p[1], p[2] + dz * (1 - Math.abs(t - 0.5) * 2)];
      for (let k = 0; k < 2; k++) {
        const t0 = k / 2, t1 = (k + 1) / 2;
        const p0 = zz([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2]], t0), p1 = zz([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2]], t1);
        const q0: P3 = [p0[0], p0[1] + 0.24, p0[2]], q1: P3 = [p1[0], p1[1] + 0.24, p1[2]];
        if (s > 0) mb.quad(p0, p1, q1, q0, Q.white); else mb.quad(p1, p0, q0, q1, Q.white);
      }
    }
  }
  mb.matOverride = keep;
}

// 縦書きの看板（紺の板に、光る白い文字の形を 4 つ）。正面 +z の壁 z に貼る
function verticalSign(mb: MeshBuilder, cx: number, y0: number, z: number, w: number, n: number) {
  const h = n * w * 1.05 + w * 0.5;
  bx(mb, cx - w / 2 - 0.25, y0, z, cx + w / 2 + 0.25, y0 + h, z + 0.3, Q.navy, 0, { m: MAT.metal });
  for (let k = 0; k < n; k++) {
    const yb = y0 + h - w * 0.35 - (k + 1) * w * 1.05, s = w * 0.42;
    const glyph = (x0: number, x1: number, ya: number, yb2: number) => wq(mb, 0, z + 0.33, cx + x0 * s, cx + x1 * s, yb + w * 0.5 + ya * s, yb + w * 0.5 + yb2 * s, Q.sign, PAT.lit, MAT.none);
    // 漢字らしい画（横・縦の線の組み合わせ）
    glyph(-1, 1, 0.75, 0.95);
    glyph(-0.85, 0.85, -0.05, 0.12);
    glyph(-1, 1, -0.95, -0.78);
    if (k % 2 === 0) { glyph(-0.6, -0.42, -0.95, 0.95); glyph(0.42, 0.6, -0.78, 0.75); }
    else { glyph(-0.09, 0.09, -0.95, 0.95); glyph(-0.9, -0.72, 0.12, 0.75); glyph(0.72, 0.9, -0.78, -0.05); }
  }
}

// ---------------- 庁舎（敷地の X0..X1 の側）----------------
function office(mb: MeshBuilder, rng: Rng, tf: TF, X0: number, X1: number, Z0: number, Z1: number) {
  // 地面：前の広場（石張り）、道路ぎわの芝生、横の車路、裏の駐車場
  gq(mb, X0 + 0.2, Z0 + 0.2, X1 - 0.2, Z1 - 0.2, 0.07, Q.stone);
  const drive = 5.2; // 横の車路（-x の端）
  const bx0 = X0 + drive + 1.2, bx1 = X1 - 2.2;
  const plaza = 11;
  const fz1 = Z1 - plaza, fz0 = fz1 - Math.min(16, (Z1 - Z0) * 0.34);
  gq(mb, X0 + 0.4, Z0 + 0.4, X0 + drive, Z1 - 0.2, 0.09, Q.asphalt);
  gq(mb, X0 + drive - 0.15, Z0 + 0.6, X0 + drive, fz0 - 1, 0.1, K.paint);
  // 石張りの目地（広場）
  for (let x = bx0; x < X1 - 0.5; x += 3) gq(mb, x, fz1 + 0.5, x + 0.06, Z1 - 3, 0.085, Q.stone2);
  // 道路ぎわの植え込み（車路のところはあける）と木
  gq(mb, X0 + drive + 0.3, Z1 - 2.8, X1 - 0.3, Z1 - 0.3, 0.1, K.lawn);
  bx(mb, X0 + drive + 0.5, 0.05, Z1 - 2.6, X1 - 0.5, 0.75, Z1 - 1.9, K.hedge, 0, { m: MAT.none });
  for (let x = X0 + drive + 2.5; x < X1 - 1; x += 7 + rng.next() * 2) tf(x, Z1 - 1.0, 0.7 + rng.next() * 0.15);

  // ---- 建物：ガラスの1階（ロビー）、白い格子（ひさしと縦のひれ）で包んだガラスの上の階、片側の白いコア ----
  const fl = 6, fh = 3.8, gH = 5.2, H = gH + fl * fh;
  // 1階：奥まったガラスと白い柱
  bx(mb, bx0 + 0.6, 0, fz0 + 0.6, bx1 - 0.6, gH, fz1 - 1.6, Q.glass, PAT.fullglass, { roof: null });
  const cols = Math.max(2, Math.round((bx1 - bx0) / 6));
  for (let k = 0; k <= cols; k++) {
    const x = bx0 + 0.35 + ((bx1 - bx0 - 0.7) * k) / cols;
    bx(mb, x - 0.35, 0, fz1 - 0.7, x + 0.35, gH, fz1, Q.white);
  }
  // 上の階：ガラスの箱
  bx(mb, bx0, gH, fz0, bx1, H, fz1, Q.white, PAT.curtain, { roof: Q.white2 });
  mb.box(bx0, gH - 0.01, fz0, bx1, gH + 0.6, fz1, Q.white, PAT.none, Q.white);
  // 白い格子：各階のひさし（4 面）と、縦のひれ（正面）
  const coreD = 7.5; // 正面の左のコアの奥行き
  for (let k = 1; k <= fl; k++) {
    const y = gH + k * fh - 0.25;
    bx(mb, bx0 - 0.15, y, fz1, bx1 + 0.15, y + 0.28, fz1 + 1.0, Q.white, 0, { bot: Q.white2 });
    bx(mb, bx1, y, fz0 - 1.0, bx1 + 1.0, y + 0.28, fz1 + 1.0, Q.white, 0, { bot: Q.white2 });
    bx(mb, bx0 - 1.0, y, fz0 - 1.0, bx1, y + 0.28, fz0, Q.white, 0, { bot: Q.white2 });
    bx(mb, bx0 - 1.0, y, fz0, bx0, y + 0.28, fz1 - coreD, Q.white, 0, { bot: Q.white2 });
  }
  const fins = Math.max(3, Math.round((bx1 - bx0) / 3.3));
  for (let k = 0; k <= fins; k++) {
    const x = bx0 + ((bx1 - bx0) * k) / fins;
    bx(mb, x - 0.14, gH + 0.6, fz1, x + 0.14, H, fz1 + 1.0, Q.white);
  }
  // 片側（-x）の白いコア（階段・エレベーター）。少し高く、縦の細い窓と縦書きの看板
  const cx0 = bx0 - 1.2, cx1 = bx0 + 4.2;
  bx(mb, cx0, 0, fz1 - coreD, cx1, H + 3.2, fz1 + 1.2, Q.white, PAT.none, { roof: Q.white2 });
  wq(mb, 3, cx0 - 0.02, fz1 - 4.2, fz1 - 3.1, 2, H + 1, Q.glassDk, PAT.fullglass, MAT.none);
  wq(mb, 2, fz1 - coreD - 0.02, cx0 + 1.2, cx0 + 2.2, 2, H + 1, Q.glassDk, PAT.fullglass, MAT.none);
  verticalSign(mb, (cx0 + cx1) / 2, H - 9.5, fz1 + 1.2, 2.4, 2);
  // 屋上：手すり、機械室、空調の箱、アンテナ
  bx(mb, bx0, H, fz1 - 0.2, bx1 + 1.0, H + 1.1, fz1 + 1.0, Q.white);
  bx(mb, bx1 + 0.8, H, fz0, bx1 + 1.0, H + 1.1, fz1, Q.white);
  bx(mb, bx0, H, fz0, bx1, H + 1.1, fz0 + 0.2, Q.white);
  bx(mb, bx0, H, fz0, bx0 + 0.2, H + 1.1, fz1 - coreD, Q.white);
  const mx = (bx0 + bx1) / 2 + 1.5, mz = (fz0 + fz1) / 2;
  bx(mb, mx - 4, H, mz - 3, mx + 3, H + 3.2, mz + 2.5, Q.white2, PAT.industrial, { roof: Q.frame });
  for (let k = 0; k < 3; k++) bx(mb, bx1 - 3.2, H, fz0 + 1.2 + k * 2.6, bx1 - 1.0, H + 1.4, fz0 + 3.0 + k * 2.6, C(0xb9bfc5), 0, { m: MAT.metal });
  bx(mb, cx0 + 1.5, H + 3.2, fz1 - 3, cx0 + 1.7, H + 11, fz1 - 2.8, K.steel, 0, { m: MAT.metal });
  bx(mb, cx0 + 1.1, H + 9.6, fz1 - 2.95, cx0 + 2.1, H + 9.8, fz1 - 2.85, K.steel, 0, { m: MAT.metal });
  // 玄関のひさし（薄い板と細い柱）
  const ex = (bx0 + bx1) / 2 + 1;
  bx(mb, ex - 5, 4.3, fz1 - 1, ex + 5, 4.75, fz1 + 5, Q.white, 0, { bot: Q.white2 });
  for (const x of [ex - 4.4, ex + 4.4]) bx(mb, x - 0.12, 0, fz1 + 4.3, x + 0.12, 4.3, fz1 + 4.55, Q.white2, 0, { m: MAT.metal });
  wq(mb, 0, fz1 + 5.02, ex - 4.6, ex + 4.6, 4.35, 4.7, Q.sign, PAT.lit, MAT.none);
  // 広場：3 本の旗ざお（国旗、税関の旗、青い旗）、植え込みの箱、低い照明柱
  const fzF = Z1 - 5.2;
  const fxs = [bx1 - 9.5, bx1 - 6.3, bx1 - 3.1];
  (['jp', 'customs', 'blue'] as Flag[]).forEach((k, i) => flagpole(mb, fxs[i], fzF, i === 0 ? 11 : 10, k));
  for (const [x0, x1] of [[bx0 - 0.5, bx0 + 3.5], [ex + 6.5, ex + 9.5]] as [number, number][]) {
    if (x1 > fxs[0] - 1) continue;
    bx(mb, x0, 0, fz1 + 6, x1, 0.55, fz1 + 8.5, Q.stone2, 0, { roof: K.hedge });
    tf((x0 + x1) / 2, fz1 + 7.25, 0.75);
  }
  pole(mb, X0 + drive + 1.2, Z1 - 4, 5);
  pole(mb, X1 - 1.2, fz1 + 2, 5);
  // 裏の駐車場（2 列が向かい合う）
  const pz1 = fz0 - 2, pz0 = Z0 + 1;
  if (pz1 - pz0 >= 11) {
    gq(mb, X0 + drive, pz0, X1 - 0.6, pz1, 0.09, Q.asphalt);
    carRow(mb, rng, X0 + drive + 0.4, X1 - 1, pz0, pz0 + 5.2, 0.7);
    carRow(mb, rng, X0 + drive + 0.4, X1 - 1, pz1 - 5.2, pz1, 0.6);
    if (pz1 - pz0 > 24) {
      const m = (pz0 + pz1) / 2;
      carRow(mb, rng, X0 + drive + 0.4, X1 - 1, m - 5.4, m - 0.2, 0.55);
      carRow(mb, rng, X0 + drive + 0.4, X1 - 1, m + 0.2, m + 5.4, 0.55);
    }
    pole(mb, X0 + drive + 0.6, (pz0 + pz1) / 2, 6);
    for (let x = X0 + drive + 4; x < X1 - 2; x += 9) tf(x, Z0 + 0.6, 0.55 + rng.next() * 0.2);
  }
}

// ---------------- X線検査場（敷地の X0..X1 の側）----------------
function inspection(mb: MeshBuilder, rng: Rng, tf: TF, X0: number, X1: number, Z0: number, Z1: number) {
  const strip = 2.8, zs = Z1 - strip; // 道路ぎわの植え込み
  const yardA: PoolAt = { a: [X0 + 0.6, Z0 + 0.6, X1 - 0.6, zs - 0.2], base: K.yard };
  gq(mb, X0 + 0.3, Z0 + 0.3, X1 - 0.3, zs, 0.07, K.apron);
  gq(mb, X0 + 0.6, Z0 + 0.6, X1 - 0.6, zs - 0.2, 0.09, K.yard, PAT.lit);
  // ---- 検査棟：コンクリートの遮へい壁のトンネル（中を通る 1 車線）と、まん中の門形のガントリー（X線の装置）----
  const SW = 11.5, sx1 = X1 - 2.6, sx0 = sx1 - SW, scx = (sx0 + sx1) / 2;
  const sz0 = Z0 + 3.5, SL = Math.min(28, (Z1 - Z0) * 0.52), sz1 = sz0 + SL, th = 9, wt = 1.5;
  for (const [a, b] of [[sx0, sx0 + wt], [sx1 - wt, sx1]] as [number, number][]) bx(mb, a, 0, sz0, b, th, sz1, Q.conc, PAT.none, { m: MAT.concrete, roof: Q.concDk });
  // 壁の外の控え壁（遮へい壁の厚みを見せる）
  for (let z = sz0 + 2; z < sz1 - 1; z += 4.5)
    for (const [a, b] of [[sx0 - 0.5, sx0], [sx1, sx1 + 0.5]] as [number, number][]) bx(mb, a, 0, z - 0.4, b, th - 0.6, z + 0.4, Q.concDk, 0, { m: MAT.concrete });
  bx(mb, sx0, th, sz0, sx1, th + 0.9, sz1, Q.conc, PAT.none, { m: MAT.concrete, bot: Q.tunnel, roof: C(0xbfc3c6) });
  // 中の天井の照明（夜に光る帯）と、床の白線
  for (let z = sz0 + 2; z < sz1 - 1; z += 4) down(mb, scx - 1.2, z, scx + 1.2, z + 0.5, th - 0.05, K.led);
  gq(mb, sx0 + wt + 0.6, sz0, sx0 + wt + 0.75, sz1 + 6, 0.11, K.yel);
  gq(mb, sx1 - wt - 0.75, sz0, sx1 - wt - 0.6, sz1 + 6, 0.11, K.yel);
  // 入口と出口の枠（黄色と黒のしま）
  for (const z of [sz1, sz0]) {
    const s = z === sz1 ? 1 : -1;
    for (const x of [sx0 + wt, sx1 - wt]) {
      for (let y = 0; y < th; y += 0.8) {
        const col = Math.round(y / 0.8) % 2 ? Q.black : Q.haz;
        const xa = x === sx0 + wt ? x - 0.5 : x, xb = x === sx0 + wt ? x : x + 0.5;
        wq(mb, s > 0 ? 0 : 2, z + s * 0.03, xa, xb, y, Math.min(th, y + 0.8), col, 0, MAT.none);
      }
    }
    wq(mb, s > 0 ? 0 : 2, z + s * 0.03, sx0 + wt, sx1 - wt, th - 1.4, th, Q.haz, 0, MAT.none);
  }
  // 屋上の機械
  bx(mb, sx0 + 1.5, th + 0.9, sz0 + 2, sx0 + 5, th + 2.6, sz0 + 6, C(0xb9bfc5), 0, { m: MAT.metal });
  bx(mb, sx1 - 4.5, th + 0.9, sz0 + 2, sx1 - 1.5, th + 2.2, sz0 + 4.5, C(0xb9bfc5), 0, { m: MAT.metal });
  // 門形のガントリー：両側の太い脚と上の梁（青い鋼板）、梁の下に黄と黒のしま、上に線源の箱と赤い回転灯
  const pz = sz0 + SL * 0.58, pd = 3.6, ph = 15, lw = 1.8;
  for (const [a, b] of [[sx0 - lw, sx0 + 0.2], [sx1 - 0.2, sx1 + lw]] as [number, number][]) {
    bx(mb, a, 0, pz - pd, b, ph, pz + pd, Q.portal, PAT.industrial, { m: MAT.metal });
    bx(mb, a - 0.12, 0, pz - pd - 0.12, b + 0.12, 0.6, pz + pd + 0.12, Q.concDk, 0, { m: MAT.concrete });
  }
  bx(mb, sx0 - lw, th + 0.9, pz - pd, sx1 + lw, ph, pz + pd, Q.portal, PAT.industrial, { m: MAT.metal, roof: Q.portalDk });
  bx(mb, sx0 - lw - 0.05, ph, pz - pd - 0.05, sx1 + lw + 0.05, ph + 0.5, pz + pd + 0.05, Q.white2, 0, { m: MAT.metal });
  for (const s of [1, -1]) {
    const z = pz + s * (pd + 0.03);
    for (let x = sx0 - lw, k = 0; x < sx1 + lw - 0.01; x += 1.0, k++) wq(mb, s > 0 ? 0 : 2, z, x, Math.min(sx1 + lw, x + 1.0), th + 0.9, th + 1.6, k % 2 ? Q.black : Q.haz, 0, MAT.none);
    // 梁の看板（紺の板に白い光る帯）
    wq(mb, s > 0 ? 0 : 2, z + s * 0.01, scx - 4, scx + 4, th + 2.4, th + 4.2, Q.navy, 0, MAT.metal);
    wq(mb, s > 0 ? 0 : 2, z + s * 0.03, scx - 3.4, scx + 3.4, th + 3.05, th + 3.55, Q.sign, PAT.lit, MAT.none);
  }
  // 線源の箱（梁の上）と回転灯
  bx(mb, sx1 - 4.5, ph + 0.5, pz - 2, sx1 + lw, ph + 2.6, pz + 2, Q.white, PAT.none, { roof: Q.white2 });
  wq(mb, 0, pz + 2.02, sx1 - 3.6, sx1 - 1.6, ph + 1.1, ph + 2.1, Q.haz, PAT.lit, MAT.none);
  for (const x of [sx0 - lw + 0.5, sx1 + lw - 0.5]) bx(mb, x - 0.3, ph + 0.5, pz - 0.3, x + 0.3, ph + 1.1, pz + 0.3, C(0xff5a3c), PAT.glow, { m: MAT.none });
  // 入口の信号（赤と緑）
  bx(mb, sx0 - 0.9, 0, sz1 + 1.2, sx0 - 0.7, 4.2, sz1 + 1.4, K.steelDk, 0, { m: MAT.metal });
  bx(mb, sx0 - 1.15, 3.2, sz1 + 1.1, sx0 - 0.45, 4.8, sz1 + 1.5, Q.black);
  wq(mb, 0, sz1 + 1.52, sx0 - 1.0, sx0 - 0.6, 4.1, 4.5, Q.red, PAT.glow, MAT.none);
  wq(mb, 0, sz1 + 1.52, sx0 - 1.0, sx0 - 0.6, 3.4, 3.8, C(0x1f3a26), 0, MAT.none);
  // 検査中のトレーラー（後ろが入口から出ている）と、入口の前で待つもう 1 台
  const fwd = -Math.PI / 2; // 奥（-z）へ向かう
  vehicle(mb, scx, sz1 + 5.5, fwd, 'cont', boxCol(rng, rng.int(LINES.length)), rng.pick(CABS));
  if (zs - 2 - (sz1 + 7) > 17.6) vehicle(mb, scx, zs - 2.5, fwd, 'cont', boxCol(rng, rng.int(LINES.length)), rng.pick(CABS));
  // 出口の先（裏）に出てきたトレーラー
  if (sz0 - Z0 > 3) gq(mb, sx0 + wt, Z0 + 0.8, sx1 - wt, sz0, 0.1, Q.lane);
  // ---- 待機レーン（検査棟の横、ガントリーより前。トレーラーが並んで待つ）----
  const lx1 = sx0 - lw - 1.0, lane = 5.0;
  const nl = Math.max(1, Math.min(2, Math.floor((lx1 - X0 - 2) / lane)));
  const lx0 = lx1 - nl * lane;
  const lzT = zs - 4, lzB = pz - pd;
  // 操作室（ガントリーの後ろ、検査棟の横の白い建物。検査の画面を見る窓）
  {
    const ox1 = sx0 - 0.6, ox0 = Math.max(lx0, ox1 - 7.5), oz0 = sz0 + 1, oz1 = pz - pd - 1;
    if (oz1 - oz0 > 4) {
      bx(mb, ox0, 0, oz0, ox1, 4.2, oz1, Q.white, PAT.ribbon, { roof: Q.white2 });
      bx(mb, ox0 - 0.4, 4.2, oz0 - 0.4, ox1 + 0.4, 4.6, oz1 + 0.4, Q.white2);
      bx(mb, ox0 + 1, 4.6, oz0 + 1, ox0 + 3, 5.6, oz0 + 2.4, C(0xb9bfc5), 0, { m: MAT.metal });
    }
  }
  for (let k = 0; k <= nl; k++) {
    const x = lx0 + k * lane;
    for (let z = lzB + 1; z < lzT - 1; z += 4) gq(mb, x - 0.07, z, x + 0.07, Math.min(lzT, z + 2.2), 0.11, K.paint);
  }
  gq(mb, lx0, lzT - 0.3, lx1, lzT, 0.11, K.paint);
  for (let k = 0; k < nl; k++) {
    const x = lx0 + (k + 0.5) * lane;
    let z = lzT - 1.5;
    // 1 本のレーンに 1〜2 台（すき間をあけて）。後ろの端が z
    while (z - 17.6 > lzB) {
      if (rng.next() < 0.85) vehicle(mb, x, z, fwd, 'cont', boxCol(rng, rng.int(LINES.length)), rng.pick(CABS));
      z -= 17.4 + 2.5 + rng.next() * 3;
    }
  }
  // ---- 手で開けて調べる検査場（屋根のある台。広いときだけ）----
  const dx0 = X0 + 1.4, dx1 = lx0 - 1.2;
  if (dx1 - dx0 >= 5) {
    const dz0 = Z0 + 2.5, dz1 = Math.min(dz0 + 22, zs - 8);
    gq(mb, dx0, dz0, dx1, dz1, 0.1, Q.lane, PAT.lit);
    // 屋根（白い鋼板）と細い柱
    bx(mb, dx0 - 0.4, 6.4, dz0 - 0.4, dx1 + 0.4, 6.9, dz1 + 0.4, Q.white, 0, { bot: Q.white2, m: MAT.metal });
    for (const x of [dx0 + 0.3, dx1 - 0.3]) for (let z = dz0 + 0.3; z <= dz1 - 0.29; z += (dz1 - dz0 - 0.6) / 3) bx(mb, x - 0.15, 0, z - 0.15, x + 0.15, 6.4, z + 0.15, K.steel, 0, { m: MAT.metal });
    for (let z = dz0 + 3; z < dz1 - 1; z += 5) down(mb, (dx0 + dx1) / 2 - 1.2, z, (dx0 + dx1) / 2 + 1.2, z + 0.4, 6.38, K.led);
    // 扉を開けたコンテナ（シャーシに載せたまま）と、出した荷物（パレット）
    const cx = (dx0 + dx1) / 2;
    vehicle(mb, cx, dz0 + 1.2, Math.PI / 2, 'contDrop', boxCol(rng, rng.int(LINES.length)), Q.white);
    for (let k = 0; k < 4; k++) {
      const z = dz0 + 15 + (k >> 1) * 1.6, x = cx + (k & 1 ? 0.9 : -0.9);
      if (z + 1.3 > dz1 - 0.5) continue;
      bx(mb, x - 0.6, 0, z, x + 0.6, 0.15, z + 1.2, Q.pallet);
      bx(mb, x - 0.55, 0.15, z + 0.05, x + 0.55, 0.15 + 0.6 + rng.next() * 0.6, z + 1.15, Q.carton, 0, { m: MAT.plaster });
    }
    // 検査を待つコンテナ（地面に 1〜2 段）
    for (let z = dz1 + 1.5; z + 12.2 < zs - 10.5; z += 13) {
      const n = 1 + rng.int(2);
      for (let k = 0; k < n; k++) bx(mb, cx - 1.22, k * 2.59, z, cx + 1.22, (k + 1) * 2.59, z + 12.19, boxCol(rng, rng.int(LINES.length)), 0, { m: MAT.metal });
    }
  }
  // ---- 入口：道路ぎわの植え込み、ゲート、書類の確認のブースと屋根 ----
  const gx0 = Math.min(lx0, scx - 3) - 0.5, gx1 = Math.max(lx1, scx + 3) + 0.5;
  for (const [a, b] of [[X0 + 0.4, gx0], [gx1, X1 - 0.4]] as [number, number][]) {
    if (b - a < 1) continue;
    gq(mb, a, zs + 0.1, b, Z1 - 0.3, 0.1, K.lawn);
    if (b - a > 2.5) bx(mb, a + 0.3, 0.05, zs + 0.3, b - 0.3, 0.85, zs + 0.95, K.hedge, 0, { m: MAT.none });
    for (let x = a + 2.2; x < b - 1.5; x += 7.5 + rng.next() * 2) tf(x, (zs + Z1) / 2 + 0.3, 0.62 + rng.next() * 0.2);
    fence(mb, a + 0.1, zs, b - 0.1, zs, 2.4);
  }
  gq(mb, gx0, zs, gx1, Z1 - 0.2, 0.08, Q.asphalt);
  // ブースの屋根（レーンの上）
  const cz = zs - 7;
  bx(mb, gx0 + 0.3, 5.6, cz - 2, gx1 - 0.3, 6.0, cz + 2, Q.white, 0, { bot: Q.white2, m: MAT.metal });
  wq(mb, 0, cz + 2.02, gx0 + 0.3, gx1 - 0.3, 5.62, 5.98, Q.portal, 0, MAT.metal);
  wq(mb, 0, cz + 2.04, (gx0 + gx1) / 2 - 3, (gx0 + gx1) / 2 + 3, 5.7, 5.9, Q.sign, PAT.lit, MAT.none);
  for (let x = gx0 + 2.5; x < gx1 - 2; x += 4) down(mb, x - 0.8, cz - 0.25, x + 0.8, cz + 0.25, 5.58, K.led);
  for (const x of [gx0 + 0.6, gx1 - 0.6]) bx(mb, x - 0.18, 0, cz - 0.18, x + 0.18, 5.6, cz + 0.18, K.steel, 0, { m: MAT.metal });
  booth(mb, lx1 + 1.3, cz, 0);
  if (nl > 1) booth(mb, lx0 + lane, cz + 0.4, 0);
  // 遮断機（入口の前）
  bx(mb, gx0 + 0.2, 0, zs - 1.2, gx0 + 0.6, 1.1, zs - 0.8, K.white, 0);
  bx(mb, gx0 + 0.6, 0.95, zs - 1.1, Math.min(gx1 - 1, gx0 + 6), 1.07, zs - 0.96, K.white, 0, { m: MAT.none });
  // ヤードのフェンス（横・裏）と照明塔
  fence(mb, X0 + 0.4, Z0 + 0.4, X0 + 0.4, zs, 2.4);
  fence(mb, X1 - 0.4, Z0 + 0.4, X1 - 0.4, zs, 2.4);
  fence(mb, X0 + 0.4, Z0 + 0.4, X1 - 0.4, Z0 + 0.4, 2.4);
  mastT(mb, X0 + 1.4, Z0 + 1.4, 20, yardA);
  mastT(mb, X0 + 1.4, zs - 10, 18, yardA);
  mastT(mb, X1 - 1.2, zs - 1.5, 18, yardA);
  pole(mb, sx0 - lw - 0.5, sz1 + 3, 7, yardA);
}

// CIQ庁舎。敷地を横に分け、道路から見て左に庁舎、右に検査場（奥行きが長い敷地でも同じ並び）
function ciqBody(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  mb.flatRoofMat = MAT.membrane;
  const hw = f.W / 2, hd = f.D / 2;
  const ow = f.W >= f.D ? Math.round(f.W * 0.45) : Math.round(f.W * 0.5);
  office(mb, rng, tf, -hw, -hw + ow, -hd, hd);
  inspection(mb, rng, tf, -hw + ow, hw, -hd, hd);
}
const ciqLit = LB.withPools((mb, f, rng, tf) => ciqBody(mb, f, rng, tf));
export function ciqOffice(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  ciqLit(mb, f, rng, tf, 0);
}
