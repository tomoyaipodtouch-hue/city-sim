// 旅客機・貨物機の形（実寸）と塗装（架空の航空会社）。
// 形は MeshBuilder で作る。塗装の部分（尾翼・胴体の線・窓の帯）は「塗装の番号」（aSlot）で印をつけ、
// インスタンスごとの色（iTail・iStripe・iWin）で塗る。1 種類の機体 = 1 回の描画（InstancedMesh）
import * as THREE from 'three';
import { MeshBuilder } from '../builder';
import type { AcKind } from '../../sim/airport';

export type AcType = AcKind;
export const AC_TYPES: AcType[] = ['atr', 'a220', 'e190', 'a320', 'b737', 'b787', 'b777', 'a350'];

// 低翼のジェット機の翼とエンジン：rootLE/rootTE = 付け根の前縁・後縁（z）、tipC = 翼端の翼弦、sweep = 後退（翼の長さ 1m あたり）、
// ex/er = エンジンの位置（x）と半径、fin = 垂直尾翼の高さ、hs = 水平尾翼の半分の幅、winglet = 翼端の小翼の高さ、gear = 主脚の位置（x）
export interface JetDims { rootLE: number; rootTE: number; tipC: number; sweep: number; ex: number; er: number; fin: number; hs: number; winglet: number; gear: number; flatEngine?: boolean }
// 機体の大きさ（m）。len = 全長、span = 翼幅、R = 胴体の半径、fy = 胴体の中心の高さ、door = 前の左の扉（機首からの距離、床の高さ）
export interface AcDims { len: number; span: number; R: number; fy: number; high: boolean; tTail: boolean; props: boolean; wide: boolean; door: [number, number]; jet?: JetDims }
export const AC: Record<AcType, AcDims> = {
  atr: { len: 27.2, span: 27.1, R: 1.33, fy: 1.95, high: true, tTail: true, props: true, wide: false, door: [4, 1.6] }, // ATR72-600
  a220: { len: 38.7, span: 35.1, R: 1.85, fy: 2.55, high: false, tTail: false, props: false, wide: false, door: [5.2, 2.9], jet: { rootLE: 3.4, rootTE: -3.9, tipC: 1.9, sweep: 0.47, ex: 6.3, er: 1.08, fin: 6.0, hs: 5.8, winglet: 1.6, gear: 2.6 } }, // A220-300
  e190: { len: 36.2, span: 28.7, R: 1.5, fy: 2.3, high: false, tTail: false, props: false, wide: false, door: [4.6, 2.6], jet: { rootLE: 3.0, rootTE: -3.6, tipC: 1.6, sweep: 0.45, ex: 5.4, er: 0.86, fin: 5.2, hs: 5.0, winglet: 1.6, gear: 2.6 } }, // E190
  a320: { len: 37.6, span: 35.8, R: 1.98, fy: 2.75, high: false, tTail: false, props: false, wide: false, door: [5.5, 3.4], jet: { rootLE: 3.6, rootTE: -4.3, tipC: 1.6, sweep: 0.5, ex: 5.75, er: 1.05, fin: 5.9, hs: 6.2, winglet: 2.4, gear: 3.8 } }, // A320neo
  b737: { len: 39.5, span: 35.9, R: 1.88, fy: 2.45, high: false, tTail: false, props: false, wide: false, door: [5.8, 2.7], jet: { rootLE: 3.8, rootTE: -4.2, tipC: 1.3, sweep: 0.52, ex: 4.9, er: 1.0, fin: 6.4, hs: 6.5, winglet: 2.8, gear: 2.9, flatEngine: true } }, // 737-800
  b777: { len: 73.9, span: 64.8, R: 3.1, fy: 4.3, high: false, tTail: false, props: false, wide: true, door: [9.5, 5.3], jet: { rootLE: 7.6, rootTE: -8.6, tipC: 2.5, sweep: 0.6, ex: 9.7, er: 1.75, fin: 12.5, hs: 11.5, winglet: 0, gear: 5.5 } }, // 777-300ER
  a350: { len: 66.8, span: 64.75, R: 3.0, fy: 4.1, high: false, tTail: false, props: false, wide: true, door: [8.7, 5.0], jet: { rootLE: 7.2, rootTE: -8.0, tipC: 2.3, sweep: 0.58, ex: 10.0, er: 1.6, fin: 11.5, hs: 10.5, winglet: 3.0, gear: 5.4 } }, // A350-900
  b787: { len: 62.8, span: 60.1, R: 2.9, fy: 3.9, high: false, tTail: false, props: false, wide: true, door: [8.3, 5.0], jet: { rootLE: 6.8, rootTE: -7.0, tipC: 2.4, sweep: 0.55, ex: 9.8, er: 1.5, fin: 10.5, hs: 10.0, winglet: 0, gear: 4.8 } }, // 787-9（A330 級）
};

// 離着陸の性能（実機に近い値。m/s・m/s²）。vr = 引き起こし（ローテーション）の速さ、acc = 離陸滑走のはじめの加速度
// （速くなると推力が落ち、空気の抵抗がふえるので小さくなる）、climb = 浮上したあとの上昇の勾配、vapp = 進入の速さ、brk = 接地したあとの減速度。
// ゲームの滑走路は実際より短いので、速さは滑走路の長さに合わせて縮める（ops.ts の speedScale）。加速度・勾配はそのまま。
// 引き起こしは滑走路の 43〜55%、浮くのは 52〜64%（軽い ATR・A220 が手前、重い 777・A350 が奥。奥の端まで 35% 以上残る）
export interface AcPerf { vr: number; acc: number; climb: number; vapp: number; brk: number }
export const PERF: Record<AcType, AcPerf> = {
  atr: { vr: 55, acc: 2.3, climb: 0.12, vapp: 57, brk: 2.2 },
  a220: { vr: 64, acc: 2.85, climb: 0.16, vapp: 65, brk: 2.4 },
  e190: { vr: 64, acc: 2.8, climb: 0.15, vapp: 66, brk: 2.4 },
  a320: { vr: 68, acc: 2.95, climb: 0.15, vapp: 68, brk: 2.4 },
  b737: { vr: 71, acc: 3.05, climb: 0.14, vapp: 72, brk: 2.4 },
  b787: { vr: 75, acc: 3.2, climb: 0.14, vapp: 74, brk: 2.6 },
  b777: { vr: 79, acc: 3.5, climb: 0.13, vapp: 77, brk: 2.6 },
  a350: { vr: 74, acc: 3.15, climb: 0.14, vapp: 72, brk: 2.6 },
};

// 胴体の形の表：[z（全長に対する割合）, 半径の割合, 中心の高さのずれ（R に対する割合）]。
// ops.ts も使う（機首を上げたとき、胴体の後ろが地面にふれない角度）
export const FUSE_PROF: readonly (readonly [number, number, number])[] = [
  [0.5, 0.04, -0.25], [0.485, 0.38, -0.15], [0.465, 0.62, -0.08], [0.44, 0.82, -0.03], [0.405, 0.95, 0], [0.36, 1, 0],
  [-0.24, 1, 0], [-0.3, 0.92, 0.12], [-0.37, 0.72, 0.32], [-0.44, 0.45, 0.5], [-0.5, 0.12, 0.62],
];

// 架空の航空会社（実在の会社は使わない）。白地に、尾翼と胴体の線の色を変える
export interface Livery { name: string; tail: number; stripe: number; win: number; fleet: AcType[]; cargo?: boolean }
export const LIVERIES: Livery[] = [
  { name: 'エアロルーメン', tail: 0x16697a, stripe: 0xf2a541, win: 0x1c2530, fleet: ['a220', 'a320', 'b787', 'a350'] },
  { name: 'ケストレルライン', tail: 0xc22f3a, stripe: 0x2b2d42, win: 0x1c2530, fleet: ['e190', 'a220', 'b737', 'b787', 'b777'] },
  { name: 'マリーヴォ航空', tail: 0x2754a6, stripe: 0x6fb7f2, win: 0x1c2530, fleet: ['atr', 'a320'] },
  { name: 'テッセラ・リージョナル', tail: 0x5e3f8f, stripe: 0xe8559f, win: 0x1c2530, fleet: ['atr', 'e190', 'b737'] },
  { name: 'ヴェローラ', tail: 0x23855a, stripe: 0xa9d86e, win: 0x1c2530, fleet: ['a220', 'e190', 'a320', 'b787', 'b777', 'a350'] },
];
// 貨物機（窓がないので、窓の帯は白）
export const CARGO_LIVERY: Livery = { name: 'クイルカーゴ', tail: 0xe0661c, stripe: 0x3b3b3b, win: 0xf1f2f3, fleet: ['atr', 'b737', 'b787', 'b777'], cargo: true };
export const ALL_LIVERIES = [...LIVERIES, CARGO_LIVERY];

const C = (h: number) => new THREE.Color(h);
// 塗装の印の色（形を作るときだけ使う。あとで白に置きかえて aSlot をつける）
const SLOT_TAIL = C(0xff0000), SLOT_STRIPE = C(0x00ff00), SLOT_WIN = C(0x0000ff);
const WHITE = C(0xf3f4f5), BELLY = C(0xd9dcdf), WING = C(0xd5d9de), GREY = C(0x8d939a), DARK = C(0x23262a), GLASS = C(0x1b232d), TYRE = C(0x1a1a1a);

type V3 = [number, number, number];

// 胴体：z に沿った輪を、半径と高さのずれの表で結ぶ（機首が +z）
function fuselage(mb: MeshBuilder, d: AcDims, col: THREE.Color) {
  const L = d.len, R = d.R, seg = 12;
  const prof = FUSE_PROF;
  const ring = (k: number): V3[] => {
    const [zf, rf, dy] = prof[k];
    const out: V3[] = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      out.push([Math.cos(a) * R * rf, d.fy + dy * R + Math.sin(a) * R * rf * 0.98, zf * L]);
    }
    return out;
  };
  for (let k = 0; k + 1 < prof.length; k++) {
    const A = ring(k), B = ring(k + 1);
    for (let s = 0; s < seg; s++) {
      const s2 = (s + 1) % seg;
      const ang = ((s + 0.5) / seg) * Math.PI * 2;
      const nA: V3 = [Math.cos((s / seg) * Math.PI * 2), Math.sin((s / seg) * Math.PI * 2), 0];
      const nB: V3 = [Math.cos((s2 / seg) * Math.PI * 2), Math.sin((s2 / seg) * Math.PI * 2), 0];
      // 下半分は少し灰色（汚れ・下面の塗装）
      const c = Math.sin(ang) < -0.55 ? BELLY : col;
      mb.quadN(A[s2], A[s], B[s], B[s2], nB, nA, nA, nB, c);
    }
  }
}

// 平らな翼（上下 2 枚と、前と後ろのへり）。root/tip = [x, y, 前縁の z, 後縁の z]
function wingPanel(mb: MeshBuilder, root: [number, number, number, number], tip: [number, number, number, number], th: number, col: THREE.Color) {
  const [rx, ry, rl, rt] = root, [tx, ty, tl, tt] = tip;
  const up = (x: number, y: number, z: number): V3 => [x, y + th / 2, z];
  const dn = (x: number, y: number, z: number): V3 => [x, y - th / 2, z];
  const flip = tx < rx;
  const q = (a: V3, b: V3, c2: V3, e: V3, cc: THREE.Color) => (flip ? mb.quad(e, c2, b, a, cc) : mb.quad(a, b, c2, e, cc));
  q(up(rx, ry, rt), up(tx, ty, tt), up(tx, ty, tl), up(rx, ry, rl), col);
  q(dn(rx, ry, rl), dn(tx, ty, tl), dn(tx, ty, tt), dn(rx, ry, rt), col);
  q(dn(rx, ry, rl), up(rx, ry, rl), up(tx, ty, tl), dn(tx, ty, tl), col);
  q(up(rx, ry, rt), dn(rx, ry, rt), dn(tx, ty, tt), up(tx, ty, tt), col);
  q(dn(tx, ty, tt), dn(tx, ty, tl), up(tx, ty, tl), up(tx, ty, tt), col);
}
// 縦の板（垂直尾翼）：root/tip = [y, 前縁の z, 後縁の z]
function finPanel(mb: MeshBuilder, root: [number, number, number], tip: [number, number, number], th: number, col: THREE.Color) {
  const [ry, rl, rt] = root, [ty, tl, tt] = tip;
  const h = th / 2;
  mb.quad([h, ry, rt], [h, ry, rl], [h * 0.6, ty, tl], [h * 0.6, ty, tt], col);
  mb.quad([-h, ry, rl], [-h, ry, rt], [-h * 0.6, ty, tt], [-h * 0.6, ty, tl], col);
  mb.quad([-h, ry, rl], [-h * 0.6, ty, tl], [h * 0.6, ty, tl], [h, ry, rl], col);
  mb.quad([h, ry, rt], [h * 0.6, ty, tt], [-h * 0.6, ty, tt], [-h, ry, rt], col);
  mb.quad([-h * 0.6, ty, tl], [-h * 0.6, ty, tt], [h * 0.6, ty, tt], [h * 0.6, ty, tl], col);
}
// エンジン（z に沿った円筒）
function nacelle(mb: MeshBuilder, x: number, y: number, z0: number, z1: number, r: number, col: THREE.Color, lip: THREE.Color, seg = 10) {
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
    const p = (a: number, z: number, rr: number): V3 => [x + Math.cos(a) * rr, y + Math.sin(a) * rr, z];
    const n0: V3 = [Math.cos(a0), Math.sin(a0), 0], n1: V3 = [Math.cos(a1), Math.sin(a1), 0];
    const zl = z1 - (z1 - z0) * 0.12;
    mb.quadN(p(a1, z0, r * 0.75), p(a0, z0, r * 0.75), p(a0, zl, r), p(a1, zl, r), n1, n0, n0, n1, col);
    mb.quadN(p(a1, zl, r), p(a0, zl, r), p(a0, z1, r * 0.95), p(a1, z1, r * 0.95), n1, n0, n0, n1, lip);
    mb.tri([x, y, z1 - 0.3], p(a1, z1, r * 0.9), p(a0, z1, r * 0.9), DARK);
  }
}

// 機体の形（鼻先が +z、主脚の接地点が y = 0）。static = 塗装の色をそのまま塗る（格納庫の中の機体など）
export function buildAircraft(mb: MeshBuilder, type: AcType, livery?: Livery) {
  const d = AC[type], L = d.len, R = d.R, fy = d.fy;
  const tail = livery ? C(livery.tail) : SLOT_TAIL, stripe = livery ? C(livery.stripe) : SLOT_STRIPE, win = livery ? C(livery.win) : SLOT_WIN;
  fuselage(mb, d, WHITE);
  // 窓の帯（左右）と操縦席の窓
  for (const sd of [-1, 1]) {
    const x = sd * R * 1.0;
    const y0 = fy + R * 0.18, y1 = fy + R * 0.36, z0 = -L * 0.3, z1 = L * 0.34;
    if (sd > 0) mb.quad([x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], win);
    else mb.quad([x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], win);
    // 胴体の線（窓の下）
    const s0 = fy - R * 0.12, s1 = fy + R * 0.02;
    const xs = sd * R * 1.005;
    if (sd > 0) mb.quad([xs, s0, -L * 0.36], [xs, s0, L * 0.4], [xs, s1, L * 0.4], [xs, s1, -L * 0.36], stripe);
    else mb.quad([xs, s0, L * 0.4], [xs, s0, -L * 0.36], [xs, s1, -L * 0.36], [xs, s1, L * 0.4], stripe);
    // 操縦席の窓
    const cz = L * 0.445, cy = fy + R * 0.35;
    const cx = sd * R * 0.52;
    if (sd > 0) mb.quad([cx, cy, cz - 0.9], [cx * 0.55, cy, cz + 0.35], [cx * 0.45, cy + R * 0.28, cz - 0.2], [cx * 0.95, cy + R * 0.28, cz - 1.1], GLASS);
    else mb.quad([cx * 0.55, cy, cz + 0.35], [cx, cy, cz - 0.9], [cx * 0.95, cy + R * 0.28, cz - 1.1], [cx * 0.45, cy + R * 0.28, cz - 0.2], GLASS);
  }
  const half = d.span / 2;
  if (d.high) {
    // ATR72：胴体の上の高翼（まっすぐ）、主翼の前のプロペラ機のエンジン、T 字の尾翼、胴体の横の脚のふくらみ
    const wy = fy + R * 0.95;
    for (const sd of [-1, 1]) {
      wingPanel(mb, [sd * R * 0.6, wy, 1.7, -1.1], [sd * half, wy - 0.15, 0.95, -0.45], 0.32, WING);
      const ex = sd * 4.1;
      nacelle(mb, ex, wy - 0.45, -1.6, 3.3, 0.62, WHITE, stripe, 10);
      // プロペラ（6 枚。止まって見える）
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.3;
        const bx = Math.cos(a), by = Math.sin(a);
        const r0 = 0.3, r1 = 1.95, w = 0.14;
        const p = (r: number, o: number): V3 => [ex + bx * r - by * o, wy - 0.45 + by * r + bx * o, 3.45];
        mb.quad(p(r0, -w), p(r1, -w * 0.6), p(r1, w * 0.6), p(r0, w), DARK);
        mb.quad(p(r0, w), p(r1, w * 0.6), p(r1, -w * 0.6), p(r0, -w), DARK);
      }
      mb.box(ex - 0.25, wy - 0.7, 3.3, ex + 0.25, wy - 0.2, 3.7, GREY);
      // 脚のふくらみ
      mb.box(sd * R * 0.75 - 0.5, 0.65, -2.4, sd * R * 0.75 + 0.5, fy - 0.3, 1.2, BELLY);
      mb.box(sd * R * 0.75 - 0.25, 0, -0.9, sd * R * 0.75 + 0.25, 0.75, 0.0, TYRE);
    }
    // 垂直尾翼（塗装）と、その上の水平尾翼
    finPanel(mb, [fy + R * 0.5, -L * 0.3, -L * 0.47], [fy + R + 4.6, -L * 0.44, -L * 0.52], 0.34, tail);
    for (const sd of [-1, 1]) wingPanel(mb, [0, fy + R + 4.5, -L * 0.45, -L * 0.52], [sd * 3.65, fy + R + 4.45, -L * 0.48, -L * 0.53], 0.18, tail);
    mb.box(-0.12, 0, L * 0.38, 0.12, fy - R * 0.8, L * 0.4, DARK);
    mb.box(-0.2, 0, L * 0.38, 0.2, 0.6, L * 0.405, TYRE);
  } else {
    // A220・E190・A320・737・787：胴体の下の低翼（後退翼）、翼の下のターボファン、ふつうの尾翼
    const J = d.jet!, k = d.wide ? 1.6 : 1; // 部材の厚み・反りの倍率
    const wy = fy - R * 0.62, sweep = J.sweep;
    const rootLE = J.rootLE, rootTE = J.rootTE, tipC = J.tipC, dih = 1.4 * k + (d.wide ? 1.2 : 0);
    for (const sd of [-1, 1]) {
      const tipLE = rootLE - (half - R) * sweep;
      wingPanel(mb, [sd * R * 0.4, wy, rootLE, rootTE], [sd * half, wy + dih, tipLE, tipLE - tipC], 0.36 * k, WING);
      // 翼端の小さな翼（塗装）。787 は小翼のない、後ろへ流れた翼端
      const wx = sd * half;
      if (J.winglet > 0) {
        const wh = J.winglet;
        mb.quad([wx, wy + dih, tipLE - tipC], [wx, wy + dih, tipLE], [wx, wy + dih + wh, tipLE - tipC * 0.9], [wx, wy + dih + wh, tipLE - tipC * 1.3], tail);
        mb.quad([wx, wy + dih, tipLE], [wx, wy + dih, tipLE - tipC], [wx, wy + dih + wh, tipLE - tipC * 1.3], [wx, wy + dih + wh, tipLE - tipC * 0.9], tail);
      }
      const ex = sd * J.ex, er = J.er;
      const ez = rootLE - (Math.abs(ex) - R) * sweep;
      nacelle(mb, ex, wy - er * 0.55, ez - er * 1.7, ez + er * 2.5, er, GREY, stripe, 12);
      if (J.flatEngine) mb.box(ex - er * 0.9, wy - er * 1.5, ez - er * 1.2, ex + er * 0.9, wy - er * 1.1, ez + er * 2.2, GREY); // 737 の下の平らなエンジン
      // 主脚（787 は 4 輪の台車）
      const gx = sd * J.gear;
      mb.box(gx - 0.25 * k, 0, -1.6 * k, gx + 0.25 * k, wy, -1.0 * k, DARK);
      mb.box(gx - 0.45 * k, 0, -2.0 * k, gx + 0.45 * k, 1.0 * k, -0.6 * k, TYRE);
    }
    // 翼の付け根のふくらみ
    mb.box(-R * 0.75, wy - 0.3, rootTE - 1.0, R * 0.75, fy - R * 0.3, rootLE + 1.2, BELLY);
    finPanel(mb, [fy + R * 0.55, -L * 0.3, -L * 0.47], [fy + R + J.fin, -L * 0.45, -L * 0.52], 0.4 * k, tail);
    const hs = J.hs;
    for (const sd of [-1, 1]) wingPanel(mb, [0, fy + R * 0.25, -L * 0.37, -L * 0.47], [sd * hs, fy + R * 0.25 + 0.7 * k, -L * 0.45, -L * 0.5], 0.22 * k, WING);
    mb.box(-0.15, 0, L * 0.36, 0.15, fy - R * 0.8, L * 0.38, DARK);
    mb.box(-0.25, 0, L * 0.355, 0.25, 0.75, L * 0.385, TYRE);
  }
}

// インスタンス用の形：塗装の印の色を白にして、塗装の番号 aSlot（0 = そのまま, 1 = 尾翼, 2 = 線, 3 = 窓）をつける
export function aircraftGeometry(type: AcType): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  mb.setTransform(0, 0, 0, 0);
  buildAircraft(mb, type);
  const g = mb.toGeometry();
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const slot = new Float32Array(col.count);
  for (let i = 0; i < col.count; i++) {
    const r = col.getX(i), gg = col.getY(i), b = col.getZ(i);
    const s = r > 0.99 && gg < 0.01 && b < 0.01 ? 1 : gg > 0.99 && r < 0.01 && b < 0.01 ? 2 : b > 0.99 && r < 0.01 && gg < 0.01 ? 3 : 0;
    slot[i] = s;
    if (s) col.setXYZ(i, 1, 1, 1);
  }
  g.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
  // 建物用の属性はいらない
  for (const k of ['aUvm', 'aPat', 'aMat']) g.deleteAttribute(k);
  return g;
}

// 機体のマテリアル：インスタンスごとの塗装の色（iTail・iStripe・iWin）
export function aircraftMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.08 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSlot;\nattribute vec3 iTail;\nattribute vec3 iStripe;\nattribute vec3 iWin;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n  if (aSlot > 0.5) vColor.rgb = aSlot < 1.5 ? iTail : (aSlot < 2.5 ? iStripe : iWin);');
  };
  m.customProgramCacheKey = () => 'aircraft-livery';
  return m;
}
