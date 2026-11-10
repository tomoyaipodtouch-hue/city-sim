// 近代的なマンションの形（B）。resRegistry の RES に登録する
// 敷地の座標：x は -W/2..W/2、z は -D/2..D/2、+z が道路の側（正面）、y = 0 が敷地の地面。
// buildingGen から読み込まれるので、buildingGen は型だけ読み込む（実行時に読み込むと循環する）
//  perfScreen   … 白い外壁。バルコニーを白い穴あき金属のスクリーンで囲む（張り出し・面一・角の曲面。夜は中の明かりがほんのり透ける）
//  greenTerrace … 階ごと（数階ごと）に後ろへ下がる段々のテラス。どのテラスにも植え込みと小さな木。明るい塗り壁とガラス
//  zigzagBay    … 三角の出窓が並ぶのこぎり形の外壁。出窓の片面はガラス、もう片面はテラコッタ・金属・明るいレンガ
//  nordicTimber … 黒い金属（焼き杉）の外壁と黒い窓枠。木で内張りした箱形のバルコニー（北欧）
import * as THREE from 'three';
import { PAT } from './builder';
import type { MeshBuilder } from './builder';
import { MAT } from './textures';
import type { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';
import { RES } from './resRegistry';

type P2 = [number, number];
const C = (h: number) => new THREE.Color(h);
const FH = 3.1; // 住宅の階高
const GH = 4.2; // 1階の高さ（玄関ホール）
// 窓の模様の 1 階ぶんの長さ（シェーダー）を住宅の階高に合わせる倍率
const VS: Record<number, number> = { [PAT.ribbon]: 3.7 / FH, [PAT.curtain]: 3.7 / FH, [PAT.fullglass]: 3.8 / FH, [PAT.apartment]: 3.0 / FH, [PAT.office]: 3.4 / FH };

const K = {
  lawn: C(0x6e9a4a), lawn2: C(0x7aa553), pave: C(0x9c9b96), paveLt: C(0xb9b4aa), leaf: C(0x3e6b2f), cap: C(0xd6d3cb),
  unit: C(0xb9bdc2), fan: C(0x3a3d42), lamp: C(0xf3e2c0), door: C(0x3a3f45), railGl: C(0x9fbcc8), pv: C(0x23344c),
};
const LEAVES = [0x3e6b2f, 0x4a7a35, 0x56853b, 0x35602c, 0x5f8f42].map(C);
const ROOFS = [0xb5b2aa, 0xa6a39c, 0xc4c1b9, 0x9b9891].map(C);

// ---------------- 小さな部品 ----------------
// 縦の壁（A→B、外向きは進む向きの右手 = (-dz, dx)）。窓の模様は yb の高さから階ごとにそろえる
function wq(mb: MeshBuilder, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, col: THREE.Color, pat = 0, yb = 0, u0 = 0) {
  const s = VS[pat] ?? 1;
  mb.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], col, pat, Math.hypot(bx - ax, bz - az), (y1 - y0) * s, u0, (y0 - yb) * s);
}
// 水平の面（上向き / 下向き）
function hq(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, col: THREE.Color, pat = 0, down = false) {
  if (down) mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], col, pat);
  else mb.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], col, pat);
}
// 箱。skip = 描かない壁（1 = +z、2 = -z、4 = +x、8 = -x）。top: null で上面なし。bot を渡すと下面（botPat で夜に光る軒裏など）
interface BO { pat?: number; yb?: number; top?: THREE.Color | null; topM?: number; bot?: THREE.Color; botPat?: number; skip?: number; m?: number }
function bx(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: THREE.Color, o: BO = {}) {
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (z1 < z0) [z0, z1] = [z1, z0];
  const pat = o.pat ?? 0, yb = o.yb ?? 0, sk = o.skip ?? 0, keep = mb.matOverride;
  if (o.m !== undefined) mb.matOverride = o.m;
  if (!(sk & 1)) wq(mb, x0, z1, x1, z1, y0, y1, col, pat, yb);
  if (!(sk & 2)) wq(mb, x1, z0, x0, z0, y0, y1, col, pat, yb);
  if (!(sk & 4)) wq(mb, x1, z1, x1, z0, y0, y1, col, pat, yb);
  if (!(sk & 8)) wq(mb, x0, z0, x0, z1, y0, y1, col, pat, yb);
  mb.matOverride = o.topM !== undefined ? o.topM : keep;
  if (o.top !== null) hq(mb, x0, z0, x1, z1, y1, o.top ?? col);
  mb.matOverride = o.m !== undefined ? o.m : keep;
  if (o.bot) hq(mb, x0, z0, x1, z1, y0, o.bot, o.botPat ?? 0, true);
  mb.matOverride = keep;
}
// 多角形の面（凹んだ形でもよい）
function polyCap(mb: MeshBuilder, pts: P2[], y: number, col: THREE.Color, down = false, pat = 0) {
  const tris = THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), []);
  for (const [a, b, c] of tris) {
    const A: [number, number, number] = [pts[a][0], y, pts[a][1]], B: [number, number, number] = [pts[b][0], y, pts[b][1]], Cc: [number, number, number] = [pts[c][0], y, pts[c][1]];
    // 上向きの法線 = (B-A)×(C-A) の y が正
    const ny = (B[2] - A[2]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[2] - A[2]);
    if ((ny > 0) !== down) mb.tri(A, B, Cc, col, pat); else mb.tri(A, Cc, B, col, pat);
  }
}
// 両面の薄い板（開いた折れ線に沿う。スクリーンや手すり）
function sheet(mb: MeshBuilder, pts: P2[], y0: number, y1: number, col: THREE.Color, pat = 0, m?: number) {
  const keep = mb.matOverride;
  if (m !== undefined) mb.matOverride = m;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx2, bz] = pts[i + 1];
    wq(mb, ax, az, bx2, bz, y0, y1, col, pat, y0);
    wq(mb, bx2, bz, ax, az, y0, y1, col, pat, y0);
  }
  mb.matOverride = keep;
}
const arc = (cx: number, cz: number, r: number, a0: number, a1: number, n: number): P2[] => {
  const o: P2[] = [];
  for (let k = 0; k <= n; k++) { const a = a0 + ((a1 - a0) * k) / n; o.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  return o;
};

// ---------------- 建物の大きさ ----------------
interface Mass { x0: number; x1: number; z0: number; z1: number; n: number; H: number }
// 敷地の中の本体の位置と階数（細すぎないように階数をおさえる）
function mass(f: LotFrame, floors: number, rng: Rng, maxDep: number, maxW: number, slender = 8.5): Mass {
  const tall = floors >= 9;
  const front = f.D < 24 ? 2.6 : tall ? 5.5 + rng.next() * 2 : 4 + rng.next() * 1.5;
  const rear = f.D < 24 ? 1.6 : 3;
  const side = f.W < 24 ? 1.3 : tall ? 3 + rng.next() * 2 : 2 + rng.next();
  const W = Math.min(f.W - 2 * side, maxW), dep = Math.min(f.D - front - rear, maxDep);
  const z1 = f.D / 2 - front, z0 = z1 - dep;
  const n = Math.max(3, Math.min(floors, Math.round((Math.min(W, dep) * slender) / FH)));
  return { x0: -W / 2, x1: W / 2, z0, z1, n, H: fy(n) };
}
// k 階の床の高さ（0 = 1階）。fy(n) = n 階建ての屋上
const fy = (k: number) => (k <= 0 ? 0 : GH + (k - 1) * FH);

// 敷地：芝生、玄関までの舗装、道路ぞいの生け垣、木
function site(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, m: Mass, ex = 0) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.06, rng.next() < 0.5 ? K.lawn : K.lawn2);
  // 建物の前の舗装と、玄関から道路までの通路
  mb.ground(Math.max(-hw + 0.3, m.x0 - 1), m.z1, Math.min(hw - 0.3, m.x1 + 1), Math.min(hd - 0.2, m.z1 + 1.6), 0.09, K.paveLt);
  const ew = 3.2 + rng.next() * 1.2;
  mb.ground(ex - ew / 2, m.z1, ex + ew / 2, hd - 0.2, 0.1, K.paveLt);
  for (let z = m.z1 + 2; z < hd - 0.6; z += 1.2) mb.ground(ex - ew / 2, z, ex + ew / 2, z + 0.06, 0.11, K.pave);
  const leaf = rng.pick(LEAVES);
  const gap = hd - m.z1;
  if (gap > 3.2) {
    // 道路ぞいの低い生け垣（通路の左右）
    const hz = hd - 1.0;
    for (const [a, b] of [[-hw + 0.8, ex - ew / 2 - 0.8], [ex + ew / 2 + 0.8, hw - 0.8]] as P2[])
      if (b - a > 1.5) bx(mb, a, 0, hz - 0.45, b, 0.75, hz + 0.45, leaf, { pat: PAT.gardenLeaf });
  }
  // 木：前庭、横、裏
  if (gap > 4.5) for (const s of [-1, 1]) { const x = ex + s * (ew / 2 + 2.6 + rng.next() * Math.max(0.1, hw - ew / 2 - 6)); if (Math.abs(x) < hw - 1.8) tf(x, m.z1 + gap * 0.5, 0.7 + rng.next() * 0.25); }
  const sideGap = hw + m.x0;
  if (sideGap > 3.2) for (const s of [-1, 1]) tf(s * (hw - sideGap / 2), m.z0 + rng.next() * (m.z1 - m.z0), 0.6 + rng.next() * 0.3);
  const rearGap = m.z0 + hd;
  if (rearGap > 3.2) for (let x = m.x0 + 3; x < m.x1 - 2; x += 8 + rng.next() * 5) tf(x, -hd + rearGap / 2, 0.6 + rng.next() * 0.3);
}

// 1階：奥まったガラスの玄関ホールと柱、ひさし（下面は夜に光る）。正面以外の 1 階の壁も描く
function lobby(mb: MeshBuilder, m: Mass, wall: THREE.Color, glass: THREE.Color, pier: THREE.Color, rng: Rng, ex = 0, wallM: number | null = null) {
  const { x0, x1, z0, z1 } = m, r = 1.0, keep = mb.matOverride;
  mb.matOverride = wallM;
  bx(mb, x0, 0, z0, x1, GH, z1 - r, wall, { pat: PAT.apartment, skip: 1, top: null });
  mb.matOverride = keep;
  wq(mb, x0, z1 - r, x1, z1 - r, 0, GH - 0.6, glass, PAT.fullglass);
  // 正面の柱と梁
  const np = Math.max(2, Math.round((x1 - x0) / 5.5));
  for (let i = 0; i <= np; i++) { const x = x0 + 0.3 + ((x1 - x0 - 0.6) * i) / np; bx(mb, x - 0.3, 0, z1 - 0.6, x + 0.3, GH - 0.6, z1, pier, { top: null }); }
  bx(mb, x0, GH - 0.6, z1 - r, x1, GH, z1, pier, { top: null, bot: K.lamp, botPat: PAT.lit, skip: 2 });
  // 玄関のひさし
  const cw = 3 + rng.next() * 2.5;
  bx(mb, ex - cw, 3.1, z1, ex + cw, 3.4, z1 + 2.4, pier, { bot: K.lamp, botPat: PAT.lit, skip: 2 });
}

// 屋上：パラペット、階段室と昇降機の機械室、室外機（solar = 太陽光パネル）
function roofKit(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, par: THREE.Color, rng: Rng, solar = false, ph = 1.0) {
  const t = 0.3, cap = par.getHSL({ h: 0, s: 0, l: 0 }).l < 0.3 ? par : K.cap;
  bx(mb, x0, y, z1 - t, x1, y + ph, z1, par, { top: cap });
  bx(mb, x0, y, z0, x1, y + ph, z0 + t, par, { top: cap });
  bx(mb, x0, y, z0 + t, x0 + t, y + ph, z1 - t, par, { top: cap });
  bx(mb, x1 - t, y, z0 + t, x1, y + ph, z1 - t, par, { top: cap });
  const W = x1 - x0, D = z1 - z0;
  if (W < 6 || D < 5) return;
  // 機械室（片側に寄せる）
  const mw = Math.min(7, W * 0.3), md = Math.min(5.5, D * 0.45), left = rng.next() < 0.5;
  const mx0 = left ? x0 + 1.5 : x1 - 1.5 - mw, mz0 = z0 + 1.2 + rng.next() * Math.max(0.1, D - md - 2.4);
  bx(mb, mx0, y, mz0, mx0 + mw, y + 3.0, mz0 + md, par, { top: C(0xa9a69f) });
  bx(mb, mx0 + mw * 0.3, y + 3.0, mz0 + 0.4, mx0 + mw * 0.3 + 0.08, y + 3.6, mz0 + md - 0.4, K.unit);
  // 室外機または太陽光パネル
  const ux0 = left ? mx0 + mw + 1.2 : x0 + 1.5, ux1 = left ? x1 - 1.5 : mx0 - 1.2;
  if (solar) {
    for (let z = z0 + 1.5; z + 1.8 < z1 - 1; z += 2.6)
      if (ux1 - ux0 > 2) mb.quad([ux0, y + 0.4, z + 1.8], [ux1, y + 0.4, z + 1.8], [ux1, y + 1.0, z], [ux0, y + 1.0, z], K.pv, PAT.none);
  } else {
    for (let x = ux0; x + 2.2 < ux1; x += 3.2) {
      if (rng.next() < 0.35) continue;
      const z = z0 + 1.5 + rng.next() * Math.max(0.1, D - 4);
      bx(mb, x, y, z, x + 2.2, y + 1.2, z + 1.4, K.unit);
      hq(mb, x + 0.3, z + 0.25, x + 1.9, z + 1.15, y + 1.22, K.fan);
    }
  }
}

// 外壁の面（正面・裏・右・左）。P(u, w) = 面にそった位置 u（外から見て左→右）と外への出 w
interface Face { P: (u: number, w: number) => P2; L: number; side: number }
function faceOf(m: Mass, k: number): Face {
  const { x0, x1, z0, z1 } = m;
  if (k === 0) return { P: (u, w) => [x0 + u, z1 + w], L: x1 - x0, side: k };
  if (k === 1) return { P: (u, w) => [x1 - u, z0 - w], L: x1 - x0, side: k };
  if (k === 2) return { P: (u, w) => [x1 + w, z1 - u], L: z1 - z0, side: k };
  return { P: (u, w) => [x0 - w, z0 + u], L: z1 - z0, side: k };
}
// 面にそった箱（u0..u1、w0..w1、y0..y1）
function fbox(mb: MeshBuilder, F: Face, u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, col: THREE.Color, o: BO = {}) {
  const [ax, az] = F.P(u0, w0), [bx2, bz] = F.P(u1, w1);
  bx(mb, ax, y0, az, bx2, y1, bz, col, o);
}
// 面にそった壁（外向き）
function fwall(mb: MeshBuilder, F: Face, u0: number, u1: number, w: number, y0: number, y1: number, col: THREE.Color, pat = 0, yb = 0) {
  const [ax, az] = F.P(u0, w), [bx2, bz] = F.P(u1, w);
  wq(mb, ax, az, bx2, bz, y0, y1, col, pat, yb);
}

// ================= F. 白い穴あき金属のバルコニー =================
const F_WALL = [0xf4f4f1, 0xefeeea, 0xf1f2f3, 0xebe8e1].map(C);
const F_SCREEN = [0xe9eae7, 0xdfe1df, 0xeeece6, 0xe4e6e8].map(C);
const F_GLASS = [0x8fa3b0, 0x7f95a4, 0x9aabb4, 0x6f8797, 0x8c9c9a].map(C);
function perfScreen(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const tall = floors >= 9;
  const m = mass(f, floors, rng, tall ? 18 + rng.next() * 5 : 12 + rng.next() * 4, tall ? 34 : 60);
  const { x0, x1, z0, z1, n, H } = m;
  const wall = rng.pick(F_WALL), scr = rng.pick(F_SCREEN), glass = rng.pick(F_GLASS);
  const soffit = C(0xe4d6bd);
  site(mb, f, rng, tf, m);
  lobby(mb, m, wall, glass, wall, rng, 0, MAT.plaster);
  // 本体：正面と裏は白い帯と横長の窓、横は白い塗り壁と窓
  wq(mb, x0, z1, x1, z1, GH, H, glass, PAT.ribbon, GH);
  wq(mb, x1, z0, x0, z0, GH, H, glass, PAT.ribbon, GH);
  const keep = mb.matOverride;
  mb.matOverride = MAT.plaster;
  wq(mb, x1, z1, x1, z0, GH, H, wall, PAT.apartment, GH);
  wq(mb, x0, z0, x0, z1, GH, H, wall, PAT.apartment, GH);
  mb.matOverride = keep;
  hq(mb, x0, z0, x1, z1, H, rng.pick(ROOFS));
  roofKit(mb, x0, z0, x1, z1, H, wall, rng);
  // バルコニーの並び（scheme 0 = 市松、1 = 縦の列、2 = 2 階ずつずれる）
  const L = x1 - x0, nb = Math.max(2, Math.round(L / (4.4 + rng.next() * 1.4))), bw = L / nb;
  const scheme = rng.int(3), pd = 1.5 + rng.next() * 0.6, gap = 0.45, rail = 1.15;
  const curved = nb >= 3 && rng.next() < 0.5; // 正面の両端は角の丸いバルコニー（曲面のスクリーン）
  const fullP = 0.25 + rng.next() * 0.25; // 天井までのスクリーンの割合
  const flushP = 0.5 + rng.next() * 0.4; // 張り出さない窓の前の面一のスクリーンの割合
  for (const side of [0, 1]) {
    const F = faceOf(m, side);
    for (let k = 1; k < n; k++) {
      const y = fy(k), top = k === n - 1 ? H : fy(k + 1);
      for (let i = 0; i < nb; i++) {
        const proj = scheme === 0 ? (i + k + side) % 2 === 0 : scheme === 1 ? (i + side) % 2 === 0 : (i + (k >> 1)) % 3 !== 0;
        const u0 = i * bw + gap / 2, u1 = (i + 1) * bw - gap / 2;
        const h = Math.sin(i * 12.9898 + k * 78.233 + side * 37.7 + f.W) * 43758.5453, r = h - Math.floor(h);
        const lit = r < 0.22 ? PAT.lit : PAT.none;
        if (curved && side === 0 && (i === 0 || i === nb - 1)) {
          // 角の丸いバルコニー：床の板と、曲面のスクリーン（角の外へ少し回りこむ）
          const left = i === 0, rr = Math.min(pd, bw * 0.6);
          const ua = left ? -0.01 : u0, ub = left ? u1 : L + 0.01;
          const pts: P2[] = left
            ? [F.P(ub, 0), F.P(ub, pd), ...arc(x0 + rr, z1 + pd - rr, rr, Math.PI / 2, Math.PI, 6), F.P(ua, 0)]
            : [F.P(ua, 0), F.P(ua, pd), ...arc(x1 - rr, z1 + pd - rr, rr, Math.PI / 2, 0, 6), F.P(ub, 0)];
          mb.prism(pts, y - 0.25, y, wall, PAT.none, wall);
          polyCap(mb, pts, y - 0.25, r < 0.4 ? soffit : wall, true, r < 0.4 ? PAT.lit : PAT.none);
          sheet(mb, pts, y, y + rail, scr, lit, MAT.metal);
          continue;
        }
        if (proj) {
          // 張り出したバルコニー：床の板（下面は夜にほんのり光る）と、三方の穴あき金属のスクリーン
          fbox(mb, F, u0, u1, 0, pd, y - 0.25, y, wall, { bot: r < 0.4 ? soffit : wall, botPat: r < 0.4 ? PAT.lit : PAT.none, skip: side === 0 ? 2 : 1 });
          const full = r > 1 - fullP;
          if (full) {
            // 天井までのスクリーン：横は全面、正面は片側だけ（残りは手すりの高さ。引き戸のスクリーンを開けたところ）
            const op = (u1 - u0) * (0.3 + r * 0.3), right = r > 0.9;
            const um = right ? u1 - op : u0 + op;
            sheet(mb, [F.P(u0, 0.02), F.P(u0, pd)], y, top - 0.3, scr, lit, MAT.metal);
            sheet(mb, [F.P(u1, pd), F.P(u1, 0.02)], y, top - 0.3, scr, lit, MAT.metal);
            sheet(mb, [F.P(u0, pd), F.P(u1, pd)], y, y + rail, scr, lit, MAT.metal);
            sheet(mb, right ? [F.P(u0, pd), F.P(um, pd)] : [F.P(um, pd), F.P(u1, pd)], y + rail, top - 0.3, scr, lit, MAT.metal);
            // 天井の板
            fbox(mb, F, u0, u1, 0, pd, top - 0.3, top - 0.05, wall, { skip: side === 0 ? 2 : 1, bot: soffit });
          } else {
            sheet(mb, [F.P(u0, 0.02), F.P(u0, pd), F.P(u1, pd), F.P(u1, 0.02)], y, y + rail, scr, lit, MAT.metal);
            if (r > 0.72) {
              // 片側だけ高いスクリーン（目隠し）
              const um = u0 + (u1 - u0) * 0.5;
              sheet(mb, [F.P(um, pd), F.P(u1, pd), F.P(u1, 0.02)], y + rail, top - 0.3, scr, PAT.none, MAT.metal);
            }
          }
        } else if (r < flushP) {
          // 面一のスクリーン（窓の前の手すり）
          sheet(mb, [F.P(u0 + 0.2, 0.12), F.P(u1 - 0.2, 0.12)], y, y + rail, scr, PAT.none, MAT.metal);
          fbox(mb, F, u0 + 0.1, u1 - 0.1, 0, 0.18, y - 0.15, y, wall, { skip: side === 0 ? 2 : 1 });
        }
      }
    }
  }
  // 屋上のふち：白い厚い板（少し張り出す）
  bx(mb, x0 - 0.3, H - 0.2, z1 - 0.3, x1 + 0.3, H + 0.15, z1 + 0.3, wall, { bot: wall });
}

// ================= G. 段々のテラスと緑のバルコニー =================
const G_WALL = [0xefebe3, 0xe6e1d6, 0xd9d6cf, 0xf2f1ec, 0xd8d0c2].map(C);
const G_GLASS = [0x7f97a6, 0x6f8a9a, 0x8aa0a8, 0x5f7f92].map(C);
const G_PLANTER = [0xcfcac0, 0xb9b4aa, 0x9a8f80, 0xe6e2da, 0x8c7a66].map(C);
// 植え込み：鉢（箱）と、上の葉（高さをすこしずつ変える）。drape = 前の面に垂れる葉
function planterRow(mb: MeshBuilder, P: (u: number, w: number) => P2, u0: number, u1: number, w0: number, w1: number, y: number, pot: THREE.Color, rng: Rng, drape: boolean) {
  const [ax, az] = P(u0, w0), [bx2, bz] = P(u1, w1);
  bx(mb, ax, y, az, bx2, y + 0.85, bz, pot, { top: K.leaf });
  const n = Math.max(1, Math.round((u1 - u0) / 2.6));
  for (let i = 0; i < n; i++) {
    const a = u0 + ((u1 - u0) * i) / n + 0.1, b = u0 + ((u1 - u0) * (i + 1)) / n - 0.1;
    const h = 0.35 + rng.next() * 0.45, lc = rng.pick(LEAVES);
    const [px, pz] = P(a, w0 + 0.08), [qx, qz] = P(b, w1 - 0.08);
    bx(mb, px, y + 0.85, pz, qx, y + 0.85 + h, qz, lc, { pat: PAT.gardenLeaf });
    if (drape && rng.next() < 0.45) {
      const [rx, rz] = P(a + 0.2, w1), [sx, sz] = P(b - 0.2, w1 + 0.18);
      bx(mb, rx, y - 0.4 - rng.next() * 0.8, rz, sx, y + 0.9, sz, lc, { pat: PAT.gardenLeaf });
    }
  }
}
function greenTerrace(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const tall = floors >= 9;
  const both = f.D >= 40 && rng.next() < 0.65; // 前と後ろの両方へ段々にする
  const m = mass(f, floors, rng, tall ? 40 : 30, tall ? 40 : 60, 12);
  const { x0, x1, z0, z1 } = m;
  const dep = z1 - z0, minCore = tall ? 12 : 7;
  const d = 3 + rng.next() * 1.4; // 1 段で下がる奥行き
  // 下は真っすぐの本体（緑のバルコニー）、上の数階が段々に下がる。s 階ごとに 1 段
  const s = tall ? (rng.next() < 0.5 ? 1 : 2) : 1;
  const n = Math.max(3, Math.min(floors, m.n));
  const maxSteps = Math.max(0, Math.floor((dep - minCore) / (d * (both ? 2 : 1))));
  const nSteps = Math.max(0, Math.min(maxSteps, tall ? 5 : 4, Math.floor((n - 2) / s)));
  const kB = n - nSteps * s; // 本体の階数
  const levels: [number, number][] = [[0, kB]];
  for (let j = 1; j <= nSteps; j++) levels.push([kB + (j - 1) * s, kB + j * s]);
  const steps = levels.length;
  const wall = rng.pick(G_WALL), glass = rng.pick(G_GLASS), pot = rng.pick(G_PLANTER), pave = rng.pick([C(0xb9b4aa), C(0xa59d8c), C(0xc8c2b6)]);
  const H = fy(n);
  m.n = n; m.H = H;
  site(mb, f, rng, tf, m);
  lobby(mb, m, wall, glass, wall, rng, 0, MAT.plaster);
  const keep = mb.matOverride;
  const maxTrees = tall ? 2 : 3;
  for (let j = 0; j < steps; j++) {
    const [k0, k1] = levels[j];
    const yA = Math.max(GH, fy(k0)), yB = fy(k1);
    const zf = z1 - j * d, zb = both ? z0 + j * d : z0;
    if (yB > yA) {
      // 正面と裏（段々の側）はガラスと白い帯、横は塗り壁と窓
      wq(mb, x0, zf, x1, zf, yA, yB, glass, PAT.ribbon, GH);
      wq(mb, x1, zb, x0, zb, yA, yB, both ? glass : wall, both ? PAT.ribbon : PAT.apartment, GH);
      mb.matOverride = MAT.plaster;
      wq(mb, x1, zf, x1, zb, yA, yB, wall, PAT.apartment, GH);
      wq(mb, x0, zb, x0, zf, yA, yB, wall, PAT.apartment, GH);
      mb.matOverride = keep;
      // 床の帯（厚い白い板）
      bx(mb, x0 - 0.1, yB - 0.35, zb - 0.1, x1 + 0.1, yB + 0.05, zf + 0.1, wall, { top: null });
    }
    // 間の階の緑のバルコニー（張り出した板と植え込み）
    for (let k = Math.max(1, k0 + 1); k < k1; k++) {
      const y = fy(k);
      for (const back of both ? [false, true] : [false]) {
        const P = back ? (u: number, w: number): P2 => [x1 - u, zb - w] : (u: number, w: number): P2 => [x0 + u, zf + w];
        const [a, b] = P(0.4, 0), [c, e] = P(x1 - x0 - 0.4, 1.4);
        bx(mb, a, y - 0.25, b, c, y, e, wall, { bot: wall });
        planterRow(mb, P, 0.4, x1 - x0 - 0.4, 1.0, 1.4, y, pot, rng, !tall);
      }
    }
    // 屋根（テラス）：舗装、前のふちに植え込み、横のふちにも小さな植え込み、小さな木
    const last = j === steps - 1;
    if (last) {
      hq(mb, x0, zb, x1, zf, H + 0.05, rng.pick(ROOFS));
      roofKit(mb, x0, zb, x1, zf, H + 0.05, wall, rng, rng.next() < 0.4);
      // 屋上の小さな庭
      if (x1 - x0 > 14 && zf - zb > 9) {
        const gx = rng.next() < 0.5 ? x0 + 1.5 : x1 - 7.5;
        mb.ground(gx, zf - 5, gx + 6, zf - 1, H + 0.15, K.lawn);
        tf(gx + 3, zf - 3, 0.4, 0, H + 0.1);
      }
      continue;
    }
    const nzf = z1 - (j + 1) * d, nzb = both ? z0 + (j + 1) * d : z0;
    mb.matOverride = MAT.ground;
    hq(mb, x0, nzf, x1, zf, yB + 0.06, pave);
    if (both) hq(mb, x0, zb, x1, nzb, yB + 0.06, pave);
    mb.matOverride = keep;
    for (const back of both ? [false, true] : [false]) {
      const P = back ? (u: number, w: number): P2 => [x1 - u, zb - w] : (u: number, w: number): P2 => [x0 + u, zf + w];
      planterRow(mb, P, 0.15, x1 - x0 - 0.15, -0.95, 0.05, yB, pot, rng, true);
      // 横のふち
      const za = back ? zb : nzf, zc = back ? nzb : zf;
      const sa = back ? za + 1.0 : za + 0.1, sc = back ? zc - 0.1 : zc - 1.0;
      for (const xs of [x0 + 0.1, x1 - 0.9]) {
        if (sc - sa < 1) continue;
        bx(mb, xs, yB, sa, xs + 0.8, yB + 0.8, sc, pot, { top: rng.pick(LEAVES) });
        bx(mb, xs + 0.08, yB + 0.8, sa + 0.1, xs + 0.72, yB + 1.1 + rng.next() * 0.3, sc - 0.1, rng.pick(LEAVES), { pat: PAT.gardenLeaf });
      }
      // 小さな木（テラスの奥の方）
      const nt = Math.min(maxTrees, Math.max(1, Math.round((x1 - x0) / 9)));
      const tz = back ? zb - (zb - nzb) * 0.55 : zf - (zf - nzf) * 0.55;
      for (let t = 0; t < nt; t++) {
        const x = x0 + ((x1 - x0) * (t + 0.3 + rng.next() * 0.4)) / nt;
        tf(x, tz, 0.3 + rng.next() * 0.18, rng.next() < 0.2 ? 1 : 0, yB + 0.1);
      }
    }
  }
}

// ================= H. ジグザグの出窓 =================
// 出窓の板の色と素材
const H_PANEL: [number, number][] = [[0xb8694c, MAT.plaster], [0xc47a57, MAT.plaster], [0xd8c6aa, MAT.brick], [0xcbb79a, MAT.brick], [0xb9ab8f, MAT.metal], [0xeeeeea, MAT.plaster], [0x5a5e63, MAT.metal], [0xa15a3e, MAT.brick]];
const H_GLASS = [0x7d93a3, 0x6c8597, 0x8fa4ae, 0x5f7889].map(C);
function zigzagBay(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const tall = floors >= 9;
  const m = mass(f, floors, rng, tall ? 20 : 12 + rng.next() * 4, tall ? 34 : 60);
  const { x0, x1, z0, z1, n, H } = m;
  const [pc, pm] = rng.pick(H_PANEL), panel = C(pc), glass = rng.pick(H_GLASS);
  const dark = pc === 0x5a5e63;
  const white = !dark && rng.next() < 0.5;
  const wall = dark ? C(0x3f4348) : white ? C(0xeeebe4) : panel.clone();
  const wallM = dark ? MAT.metal : white || pm === MAT.metal ? MAT.plaster : pm;
  const slab = dark ? C(0x2e3135) : C(0xe9e7e2);
  site(mb, f, rng, tf, m);
  lobby(mb, m, wall, glass, slab, rng, 0, wallM);
  const keep = mb.matOverride;
  // 横の壁と屋上
  mb.matOverride = wallM;
  wq(mb, x1, z1, x1, z0, GH, H, wall, PAT.apartment, GH);
  wq(mb, x0, z0, x0, z1, GH, H, wall, PAT.apartment, GH);
  mb.matOverride = keep;
  hq(mb, x0, z0, x1, z1, H, rng.pick(ROOFS));
  // 出窓：歯の幅 t、出 p、頂点の位置 a（割合）。bandF 階ごとに向きが入れかわる（0 = 全体で 1 つ）
  const t0 = 3.2 + rng.next() * 1.3, p = 1.1 + rng.next() * 0.8, a = 0.3 + rng.next() * 0.15;
  const bandF = tall ? rng.pick([0, 0, 2, 3]) : rng.pick([0, 1, 1, 2]);
  const endW = rng.next() < 0.5 ? 1.5 + rng.next() * 1.5 : 0; // 両端の平らな壁
  for (const side of [0, 1]) {
    const F = faceOf(m, side);
    const L = F.L - 2 * endW, nt = Math.max(2, Math.round(L / t0)), t = L / nt;
    if (endW > 0) {
      mb.matOverride = wallM;
      fwall(mb, F, 0, endW, 0, GH, H, wall, PAT.apartment, GH);
      fwall(mb, F, F.L - endW, F.L, 0, GH, H, wall, PAT.apartment, GH);
      mb.matOverride = keep;
    }
    const bands: [number, number, boolean][] = [];
    if (bandF === 0) bands.push([1, n, false]);
    else for (let k = 1, b = 0; k < n; k += bandF, b++) bands.push([k, Math.min(n, k + bandF), b % 2 === 1]);
    for (const [k0, k1, flip] of bands) {
      const yA = fy(k0), yB = fy(k1);
      for (let i = 0; i < nt; i++) {
        const ua = endW + i * t, ub = ua + t, fa = flip ? 1 - a : a;
        const A = F.P(ua, 0), B = F.P(ua + fa * t, p), Cc = F.P(ub, 0);
        // ガラスの面は頂点に向かって長い面（flip で入れかわる）
        const [g0, g1, s0, s1] = flip ? [B, Cc, A, B] : [A, B, B, Cc];
        wq(mb, g0[0], g0[1], g1[0], g1[1], yA, yB, glass, PAT.curtain, GH);
        mb.matOverride = pm;
        wq(mb, s0[0], s0[1], s1[0], s1[1], yA, yB, panel, PAT.none, GH);
        mb.matOverride = keep;
        // 上と下のふた（床の板の色）
        const tri: P2[] = [A, B, Cc];
        if (k1 === n) {
          // 屋上の高さまで出窓の形のパラペットを立ち上げる（屋上のふちもジグザグに）
          mb.matOverride = dark ? MAT.metal : MAT.plaster;
          wq(mb, A[0], A[1], B[0], B[1], yB, yB + 1, dark ? wall : slab);
          wq(mb, B[0], B[1], Cc[0], Cc[1], yB, yB + 1, dark ? wall : slab);
          mb.matOverride = keep;
        }
        polyCap(mb, tri, k1 === n ? yB + 1 : yB, slab);
        polyCap(mb, tri, yA, slab, true);
      }
    }
  }
  roofKit(mb, x0, z0, x1, z1, H, dark ? wall : slab, rng);
}

// ================= I. 黒い外壁と木の箱のバルコニー =================
// 外壁の色（黒い金属、焼き杉、濃い灰色）と素材
const I_CLAD: [number, number][] = [[0x26282b, MAT.metal], [0x2f3134, MAT.metal], [0x332e2a, MAT.siding], [0x1f2224, MAT.siding], [0x44474a, MAT.metal], [0x3a3836, MAT.metal]];
const I_WOOD = [0xb07d4e, 0xc08a55, 0x9c6b42, 0xc9975f].map(C);
const I_GLASS = [0x3c4752, 0x46525c, 0x384048].map(C);
function nordicTimber(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const tall = floors >= 9;
  const m = mass(f, floors, rng, tall ? 21 : 12 + rng.next() * 4, tall ? 32 : 60);
  const { x0, x1, z0, z1, n, H } = m;
  const [cc, cm] = rng.pick(I_CLAD), clad = C(cc), wood = rng.pick(I_WOOD), glass = rng.pick(I_GLASS);
  const frame = rng.next() < 0.5 ? clad : C(0x1c1d1f);
  const soffitLit = wood.clone().multiplyScalar(0.92);
  site(mb, f, rng, tf, m);
  lobby(mb, m, clad, glass, clad, rng, 0, cm);
  const keep = mb.matOverride;
  const dp = 0.32; // 窓の奥行き
  const bays: number[][] = [];
  for (let s = 0; s < 4; s++) {
    const F = faceOf(m, s);
    const e = s >= 2 ? dp : 0; // 横の面は、正面と裏の角の柱を避ける
    // 奥まったガラス（黒い窓枠）
    fwall(mb, F, e, F.L - e, -dp, GH, H, glass, PAT.fullglass, GH);
    // 柱：幅を少しずつ変えた外壁の板
    const nb = Math.max(2, Math.round(F.L / (3.2 + rng.next() * 0.8)));
    const cuts: number[] = [0];
    for (let i = 1; i < nb; i++) cuts.push((F.L * i) / nb + (rng.next() - 0.5) * 0.8);
    cuts.push(F.L);
    bays.push(cuts);
    mb.matOverride = cm;
    for (let i = 0; i <= nb; i++) {
      const pw = i === 0 || i === nb ? 0.9 : 0.5 + rng.next() * 0.9;
      const ua = Math.max(e, cuts[i] - (i === 0 ? 0 : i === nb ? pw : pw / 2)), ub = Math.min(F.L - e, cuts[i] + (i === 0 ? pw : i === nb ? 0 : pw / 2));
      fbox(mb, F, ua, ub, -dp, 0, GH, H, clad, { skip: s === 0 ? 2 : s === 1 ? 1 : s === 2 ? 8 : 4, top: null });
    }
    // 階ごとの横の帯（窓の上と下の外壁）。ところどころ窓をふさぐ板
    for (let k = 1; k <= n; k++) {
      const y = fy(k);
      const ya = k === 1 ? GH : y - 0.45, yb2 = k === n ? H : y + 0.85;
      fbox(mb, F, e, F.L - e, -dp, 0, ya, yb2, clad, { skip: s === 0 ? 2 : s === 1 ? 1 : s === 2 ? 8 : 4, top: k === n ? null : clad, bot: clad });
      if (k < n && !tall && s >= 2) for (let i = 0; i < nb; i++) if (rng.next() < 0.3) fbox(mb, F, cuts[i] + 0.2, cuts[i + 1] - 0.2, -dp, 0, y + 0.85, fy(k + 1) - 0.45, clad, { skip: s === 2 ? 8 : 4, top: null });
    }
    mb.matOverride = keep;
  }
  hq(mb, x0, z0, x1, z1, H, C(0x8f9294));
  // 箱のバルコニー（正面と裏）：外は黒い枠、内側（床・横・天井）は木。前はガラスの手すり
  const pd = 1.5 + rng.next() * 0.4, th = 0.22, scheme = rng.int(3);
  for (const side of [0, 1]) {
    const F = faceOf(m, side), cuts = bays[side], nb = cuts.length - 1;
    const sk = side === 0 ? 2 : 1;
    for (let k = 1; k < n; k++) {
      const y = fy(k), top = k === n - 1 ? H : fy(k + 1);
      for (let i = 0; i < nb; i++) {
        const on = scheme === 0 ? (i + k + side) % 2 === 0 : scheme === 1 ? (i % 3 === (k + side) % 3) : (i + side) % 2 === 0 && k % 2 === 1;
        if (!on) continue;
        const u0 = cuts[i] + 0.15, u1 = cuts[i + 1] - 0.15;
        if (u1 - u0 < 2) continue;
        const h = Math.sin(i * 12.9898 + k * 78.233 + side * 37.7 + f.D) * 43758.5453, r = h - Math.floor(h);
        // 床（上面は木のデッキ）と天井（下面は木の軒裏。夜は一部が光る）
        mb.matOverride = cm;
        fbox(mb, F, u0, u1, 0, pd, y - th, y, frame, { skip: sk, top: wood, topM: MAT.siding, bot: frame });
        fbox(mb, F, u0, u1, 0, pd, top - th, top, frame, { skip: sk, bot: r < 0.4 ? soffitLit : wood, botPat: r < 0.4 ? PAT.lit : PAT.none });
        // 横の板：外は黒、内側は木
        for (const [ua, ub, inner] of [[u0, u0 + th, 1], [u1 - th, u1, -1]] as [number, number, number][]) {
          fbox(mb, F, ua, ub, 0, pd, y, top - th, frame, { skip: sk, top: null });
          const ui = inner > 0 ? ub + 0.01 : ua - 0.01;
          mb.matOverride = MAT.siding;
          const [px, pz] = F.P(ui, 0), [qx, qz] = F.P(ui, pd);
          if (inner > 0) wq(mb, qx, qz, px, pz, y, top - th, wood); else wq(mb, px, pz, qx, qz, y, top - th, wood);
          mb.matOverride = cm;
        }
        mb.matOverride = keep;
        // ガラスの手すり
        const [ax, az] = F.P(u0 + th, pd - 0.08), [bx2, bz] = F.P(u1 - th, pd - 0.08);
        sheet(mb, [[ax, az], [bx2, bz]], y, y + 1.1, K.railGl);
      }
    }
  }
  roofKit(mb, x0, z0, x1, z1, H, clad, rng, rng.next() < 0.6, 0.7);
}

RES['perfScreen'] = { fn: perfScreen, minF: 3, maxF: 36 };
RES['greenTerrace'] = { fn: greenTerrace, minF: 3, maxF: 28 };
RES['zigzagBay'] = { fn: zigzagBay, minF: 3, maxF: 30 };
RES['nordicTimber'] = { fn: nordicTimber, minF: 3, maxF: 45 };
