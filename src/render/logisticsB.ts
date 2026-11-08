// 物流施設（その2）：冷凍・冷蔵倉庫（coldStorage）と、コンテナヤード・CFS・シャーシプール（containerYard）
// 敷地の座標：x は -W/2..W/2、z は -D/2..D/2、+z が道路の側（正面）、y = 0 が敷地の地面。
// buildingGen から読み込まれるので、buildingGen は型だけ読み込む（実行時に読み込むと循環する）
import * as THREE from 'three';
import { PAT } from './builder';
import type { MeshBuilder } from './builder';
import { MAT } from './textures';
import { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';
import { LOGI } from './logiRegistry';

type P3 = [number, number, number];
type Col = THREE.Color;
const C = (h: number) => new THREE.Color(h);
// 色を少しくすませる（明るさは変えず、灰色へ k だけ近づける）
function mute(c: THREE.Color, k: number) {
  const l = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
  return c.setRGB(c.r + (l - c.r) * k, c.g + (l - c.g) * k, c.b + (l - c.b) * k);
}

// ---------------- 色 ----------------
const K = {
  joint2: C(0xc4c9ce), panel: C(0xf3f4f5), ivory: C(0xf0ede4), pgrey: C(0xe6e9ec), silver: C(0xdcdfe3), joint: C(0xd5d9dd), annex: C(0xdadee2),
  cap: C(0xd2d6da), roof: C(0xcfd2d4), plinth: C(0x8e949b), conc: C(0xbcbab3), apron: C(0xb4b2aa), court: C(0x55585c), yard: C(0x5f6266),
  paint: C(0xefefe9), yel: C(0xf2c200), seal: C(0x26292d), door: C(0xe9ebed), glass: C(0x7aa6c9), glassG: C(0x6f9fa6),
  slot: C(0xa9cbe0), steel: C(0x8a9097), steelDk: C(0x4a5057), fence: C(0x7f868d), solar: C(0x23344c), solarJ: C(0x7d8a99), lawn: C(0x6e9a4a), hedge: C(0x3f6a31),
  lamp: C(0xfff0cf), led: C(0xe9f2ff), tyre: C(0x1d1f22), chassis: C(0x2c2f33), cabGlass: C(0x1c2834), unit: C(0xc9cdd1), grille: C(0x3b4046),
  fan: C(0x2a2f34), cond: C(0xc6cbd0), condTop: C(0xb5bbc1), pipe: C(0xa0a7ae), white: C(0xf2f3f4), red: C(0xd0362b), trans: C(0xd9e6ec),
  sky: C(0x9db0ba), poolHi: C(0x9a9891), dockLit: C(0x74736f), litGround: C(0x6a6c6e), cargo: C(0xc8b28c), silverBody: C(0xd3d7db), vroof: C(0xe4e6e8), black: C(0x1e2023), shed: C(0xc9ced3), cream: C(0xe2ddcf),
};
// 会社の色（帯・看板・ひさしのふちに少しだけ）
const ACC = [0x1d3557, 0x1f5fae, 0x2a6fb5, 0x6fb7d9, 0x0f8a8a, 0x2e7d5b, 0xc9402f].map(C);
// 自動倉庫の縦長のロゴの色（はっきりした色）
const LOGO = [0x0a84c6, 0x1f6fd0, 0x2e9e5b, 0xe2452d, 0x0f8a8a, 0xe39a1c].map(C);
// 運転台の色（白が多い）
const CABS = [0xf2f2f2, 0xf2f2f2, 0xf2f2f2, 0xe6e8ea, 0x1d3f8a, 0x9a1d1d, 0x2e6b3a, 0x2b2b2b, 0x1f5fae].map(C);
const CARS = [0xf2f2f2, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xd8d8d8, 0x3b5d3a, 0x101820, 0xb8bcc0].map(C);
// コンテナの色：船会社ごとの色の系統（少しくすませる）。1 つの系統の中で少しずつ違う色
const LINES = [
  [0x46a3c4, 0x4fadcd, 0x3d97b9, 0x5ab0cc], // 水色
  [0xc4972f, 0xcda23d, 0xb4892c, 0xbc9343], // からし色
  [0x2f7a3c, 0x387f43, 0x2a6b35, 0x3d8748], // 緑
  [0x22407a, 0x2a4b8a, 0x30538f, 0x253f7c], // 紺
  [0xb8306f, 0xae3769, 0xc23f78, 0xa02c61], // 赤紫
  [0x2f5fa6, 0x3667ad, 0xd5d9dc, 0x2b599e], // 青と白
  [0x8b3a2a, 0x984530, 0x7e3627, 0x8f4232], // さび色の赤
  [0x8a9097, 0x949aa1, 0x80878e, 0x9aa0a6], // 灰色
  [0x7a4a2e, 0x86553a, 0xbfae95, 0x6f4429], // 茶色とベージュ（リース会社）
  [0xd06a22, 0xd8762b, 0xc4621f, 0xcf7231], // オレンジ
].map((a) => a.map((h) => mute(C(h), 0.22)));
// 屋根の仕上げ（白い防水シート、明るい灰色、うすい緑がかった灰色）。建物ごとに K.roof の値を書きかえる
const ROOFS = [0xe6e8e9, 0xcfd2d4, 0xc3cbc5].map(C);
function roofPick(rng: Rng) {
  K.roof.copy(rng.pick(ROOFS));
}
// シャーシの枠の色（黄色・青。ふつうは黒）
const FRAME = [0xd9b21c, 0x2a55a0].map(C);
const RUST = [0x8a5a44, 0x7c4b38, 0x946049].map(C);
const REEF = [0xeef0f1, 0xe7eaec, 0xf3f3ef, 0xe2e6e9].map(C);
// 荷役の機械の色（黄色・赤・濃いオレンジ）
const MACH = [0xf2c200, 0xe8b400, 0xc8372d, 0xd9661a].map(C);
// 重ね描きで使う一時の色（面を描くときに値が写されるので、使い回してよい）
const tmpC = new THREE.Color();

// ---------------- 小さな部品 ----------------
// 箱（角の順は問わない）。壁の模様の高さ（v）は地面からの高さにそろえる（根元の陰が地面の近くだけにつく）
interface BO { roof?: Col | null; bot?: Col; rpat?: number; bpat?: number; m?: number; rm?: number; v?: number }
function bx(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: Col, pat = 0, o: BO = {}) {
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (z0 > z1) [z0, z1] = [z1, z0];
  const h = y1 - y0, wx = x1 - x0, wz = z1 - z0, keep = mb.matOverride, v0 = o.v ?? y0;
  if (o.m !== undefined) mb.matOverride = o.m;
  mb.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], wall, pat, wx, h, 0, v0);
  mb.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], wall, pat, wx, h, 0, v0);
  mb.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], wall, pat, wz, h, 0, v0);
  mb.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], wall, pat, wz, h, 0, v0);
  mb.matOverride = o.rm !== undefined ? o.rm : keep;
  if (o.roof !== null) mb.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], o.roof ?? wall, o.rpat ?? 0);
  if (o.bot) mb.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], o.bot, o.bpat ?? 0);
  mb.matOverride = keep;
}
// 上を向いた面（地面・白線・屋上の面）
function gq(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, col: Col, pat = 0, m: number = MAT.ground) {
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (z0 > z1) [z0, z1] = [z1, z0];
  const keep = mb.matOverride;
  mb.matOverride = m;
  mb.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], col, pat);
  mb.matOverride = keep;
}
// 壁に貼る面。d = 向き（0 = +z、1 = +x、2 = -z、3 = -x）、w = 壁の位置、a0..a1 = 壁にそった範囲（d が 0, 2 なら x、1, 3 なら z）
function wq(mb: MeshBuilder, d: number, w: number, a0: number, a1: number, y0: number, y1: number, col: Col, pat = 0, m: number | null = null, v0 = y0) {
  if (a0 > a1) [a0, a1] = [a1, a0];
  const L = a1 - a0, h = y1 - y0, keep = mb.matOverride;
  if (m !== null) mb.matOverride = m;
  if (d === 0) mb.quad([a0, y0, w], [a1, y0, w], [a1, y1, w], [a0, y1, w], col, pat, L, h, 0, v0);
  else if (d === 2) mb.quad([a1, y0, w], [a0, y0, w], [a0, y1, w], [a1, y1, w], col, pat, L, h, 0, v0);
  else if (d === 1) mb.quad([w, y0, a1], [w, y0, a0], [w, y1, a0], [w, y1, a1], col, pat, L, h, 0, v0);
  else mb.quad([w, y0, a0], [w, y0, a1], [w, y1, a1], [w, y1, a0], col, pat, L, h, 0, v0);
  mb.matOverride = keep;
}
// 外向きの符号（d = 0, 1 は +、2, 3 は -）
const sgn = (d: number) => (d < 2 ? 1 : -1);
// 壁の位置 w、壁にそった a、外へ o の点を敷地の (x, z) に
function wpt(d: number, w: number, a: number, o: number): [number, number] {
  const s = sgn(d);
  return d === 0 || d === 2 ? [a, w + s * o] : [w + s * o, a];
}
// 壁から外へ出た箱（a0..a1 は壁にそった範囲、o0..o1 は外への出）
function wbox(mb: MeshBuilder, d: number, w: number, a0: number, a1: number, o0: number, o1: number, y0: number, y1: number, col: Col, pat = 0, o: BO = {}) {
  const [x0, z0] = wpt(d, w, a0, o0), [x1, z1] = wpt(d, w, a1, o1);
  bx(mb, x0, y0, z0, x1, y1, z1, col, pat, o);
}
// 四角い輪の帯（箱の 4 つの面に少し浮かせて貼る）。open = となりの敷地の建物につながる側（1 = -x、2 = +x。その面は貼らず、端で切る）
function ring4(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, col: Col, pat = 0, m: number | null = null, off = 0.04, v0 = y0, open = 0) {
  const a = x0 - (open & 1 ? 0 : off), b = x1 + (open & 2 ? 0 : off);
  wq(mb, 0, z1 + off, a, b, y0, y1, col, pat, m, v0);
  wq(mb, 2, z0 - off, a, b, y0, y1, col, pat, m, v0);
  if (!(open & 2)) wq(mb, 1, x1 + off, z0 - off, z1 + off, y0, y1, col, pat, m, v0);
  if (!(open & 1)) wq(mb, 3, x0 - off, z0 - off, z1 + off, y0, y1, col, pat, m, v0);
}
// 上を向いた多角形（ファンの丸など）。n 角形
function disc(mb: MeshBuilder, cx: number, cz: number, y: number, r: number, n: number, col: Col) {
  const P = (k: number): P3 => { const a = -(k / n) * Math.PI * 2; return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; };
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  for (let k = 1; k < n - 1; k++) mb.tri(P(0), P(k), P(k + 1), col);
  mb.matOverride = keep;
}
// 区間 a..b に pitch ごとに並べた中心（端を margin あける）
function slots(a: number, b: number, pitch: number, margin = 0): number[] {
  const n = Math.floor((b - a - 2 * margin) / pitch);
  const out: number[] = [];
  const s = (a + b) / 2 - ((n - 1) * pitch) / 2;
  for (let i = 0; i < n; i++) out.push(s + i * pitch);
  return out;
}
// a..b から gaps を除いた区間
function cut(a: number, b: number, gaps: [number, number][]): [number, number][] {
  let segs: [number, number][] = [[a, b]];
  for (const [g0, g1] of gaps) {
    const out: [number, number][] = [];
    for (const [s0, s1] of segs) {
      if (g1 <= s0 || g0 >= s1) out.push([s0, s1]);
      else {
        if (g0 > s0 + 1) out.push([s0, g0]);
        if (g1 < s1 - 1) out.push([g1, s1]);
      }
    }
    segs = out;
  }
  return segs;
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------- 車と荷役の機械（すべて止まっている）----------------
// 車の座標：後ろの端 (x, z) から、角度 a の向き（s）へ。t は横、sl は前へ行くほど上がる傾き
type PF = (s: number, t: number, y: number) => P3;
function vframe(x: number, y: number, z: number, a: number, sl = 0): PF {
  const c = Math.cos(a), s = Math.sin(a);
  return (u, t, h) => [x + u * c - t * s, y + h + u * sl, z + u * s + t * c];
}
function vb(mb: MeshBuilder, P: PF, s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: Col, m: number = MAT.none, top?: Col) {
  const keep = mb.matOverride;
  mb.matOverride = m;
  mb.quad(P(s0, t1, y0), P(s1, t1, y0), P(s1, t1, y1), P(s0, t1, y1), col);
  mb.quad(P(s1, t0, y0), P(s0, t0, y0), P(s0, t0, y1), P(s1, t0, y1), col);
  mb.quad(P(s1, t1, y0), P(s1, t0, y0), P(s1, t0, y1), P(s1, t1, y1), col);
  mb.quad(P(s0, t0, y0), P(s0, t1, y0), P(s0, t1, y1), P(s0, t0, y1), col);
  mb.quad(P(s0, t1, y1), P(s1, t1, y1), P(s1, t0, y1), P(s0, t0, y1), top ?? col);
  mb.matOverride = keep;
}
// 横の面だけの細い帯（車体の色の線）
function vstripe(mb: MeshBuilder, P: PF, s0: number, s1: number, t: number, y0: number, y1: number, col: Col) {
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  mb.quad(P(s0, t, y0), P(s1, t, y0), P(s1, t, y1), P(s0, t, y1), col);
  mb.quad(P(s1, -t, y0), P(s0, -t, y0), P(s0, -t, y1), P(s1, -t, y1), col);
  mb.matOverride = keep;
}
// 種類：reefer = トラクターと冷凍トレーラー、reeferDrop = 運転台なしで置いた冷凍トレーラー、reefer10 = 10t の冷凍車、reefer4 = 4t の冷凍車、
// cont = トラクターとコンテナを積んだシャーシ、contDrop = コンテナを積んだシャーシだけ、chassis = 空のシャーシ（骨組み）、tractor = トラクターだけ、
// wing = 10t のウイング車、wingOpen = 横の羽を上げたウイング車
// 長さ：reefer 18.5、reeferDrop 14.1、reefer10 12.0、reefer4 7.1、cont 17.4、contDrop と chassis 12.5、tractor 6.3、wing 12.0
type VK = 'reefer' | 'reeferDrop' | 'reefer10' | 'reefer4' | 'cont' | 'contDrop' | 'chassis' | 'tractor' | 'wing' | 'wingOpen';
interface VO { stripe?: Col; c20?: boolean; frame?: Col }
// (x, z) = 後ろの端の中央、a = 前の向き（x 軸から z 軸の向きへの角度）。box = 荷台・コンテナの色、cab = 運転台の色
function vehicle(mb: MeshBuilder, x: number, z: number, a: number, k: VK, box: Col, cab: Col, o: VO = {}) {
  const P = vframe(x, 0, z, a);
  const B = (s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: Col, m: number = MAT.none, top?: Col) => vb(mb, P, s0, s1, t0, t1, y0, y1, col, m, top);
  const shield = (s: number, w: number, y0: number, y1: number) => {
    const keep = mb.matOverride;
    mb.matOverride = MAT.none;
    mb.quad(P(s, w, y0), P(s, -w, y0), P(s, -w, y1), P(s, w, y1), K.cabGlass);
    mb.matOverride = keep;
  };
  // トラクター（s0 から前へ 6.2m。後ろ半分はフレーム、前に運転台）
  const tractor = (s0: number) => {
    B(s0, s0 + 6.2, -1.08, 1.08, 0.05, 1.15, K.chassis);
    B(s0 + 3.85, s0 + 6.2, -1.25, 1.25, 1.05, 3.8, cab);
    shield(s0 + 6.22, 1.1, 2.35, 3.45);
  };
  if (k === 'reefer' || k === 'reeferDrop') {
    const L = 13.6;
    B(0.6, 3.6, -1.18, 1.18, 0.05, 1.05, K.tyre);
    B(0, L, -1.27, 1.27, 1.2, 4.0, box, MAT.plaster, K.vroof);
    // 前の冷凍機（灰色の箱と、暗い吸い込み口）
    B(L, L + 0.45, -0.95, 0.95, 2.35, 3.85, K.unit);
    if (o.stripe) vstripe(mb, P, 0.4, L - 0.4, 1.285, 1.45, 1.75, o.stripe);
    if (k === 'reeferDrop') B(L - 3.3, L - 3.0, -1.0, 1.0, 0, 1.2, K.chassis);
    else tractor(L - 1.3);
  } else if (k === 'reefer10') {
    B(0.5, 11.8, -1.1, 1.1, 0.05, 1.1, K.chassis);
    B(0, 9.6, -1.25, 1.25, 1.1, 3.75, box, MAT.plaster, K.vroof);
    B(9.6, 10.2, -0.85, 0.85, 3.25, 3.75, K.unit);
    if (o.stripe) vstripe(mb, P, 0.3, 9.3, 1.265, 1.3, 1.6, o.stripe);
    B(9.75, 11.95, -1.24, 1.24, 0.75, 3.2, cab);
    shield(11.97, 1.1, 1.95, 2.95);
  } else if (k === 'reefer4') {
    B(0.5, 6.8, -0.95, 0.95, 0.05, 0.9, K.chassis);
    B(0, 5.0, -1.1, 1.1, 0.9, 3.0, box, MAT.plaster, K.vroof);
    B(5.0, 5.45, -0.75, 0.75, 2.45, 2.95, K.unit);
    B(5.3, 7.05, -1.05, 1.05, 0.6, 2.55, cab);
    shield(7.07, 0.95, 1.55, 2.35);
  } else if (k === 'cont' || k === 'contDrop' || k === 'chassis') {
    const fc = o.frame ?? K.chassis;
    if (k === 'chassis') {
      // 空のシャーシ：2 本の桁、前と後ろと中の横材、後ろの車輪、前の脚
      B(0.2, 12.3, 0.32, 0.58, 1.02, 1.32, fc);
      B(0.2, 12.3, -0.58, -0.32, 1.02, 1.32, fc);
      B(0, 0.35, -1.22, 1.22, 1.0, 1.38, fc);
      B(12.1, 12.45, -1.22, 1.22, 1.0, 1.38, fc);
      B(6.0, 6.3, -1.22, 1.22, 1.08, 1.32, fc);
      B(0.8, 3.5, -1.2, 1.2, 0.05, 1.0, K.tyre);
      B(9.3, 9.55, -1.0, 1.0, 0, 1.05, fc);
    } else {
      B(0.1, 12.4, -0.62, 0.62, 1.0, 1.4, fc);
      B(0.8, 3.5, -1.2, 1.2, 0.05, 1.0, K.tyre);
      const cl = o.c20 ? 6.06 : 12.19;
      B(0.15, 0.15 + cl, -1.22, 1.22, 1.4, 3.99, box, MAT.metal);
      if (k === 'contDrop') B(9.3, 9.55, -1.0, 1.0, 0, 1.05, fc);
      else tractor(11.2);
    }
  } else if (k === 'tractor') tractor(0);
  else {
    // 10t のウイング車（荷台は銀色）
    B(0.6, 11.8, -1.1, 1.1, 0.05, 1.1, K.chassis);
    B(0, 9.6, -1.25, 1.25, 1.1, 1.55, box, MAT.none, K.silverBody);
    if (k === 'wing') B(0, 9.6, -1.25, 1.25, 1.55, 3.8, K.silverBody, MAT.metal, K.vroof);
    else {
      // 横の羽を上げて、荷物が見える
      B(0.3, 9.3, -1.0, 1.0, 1.55, 2.9, K.cargo);
      B(9.3, 9.6, -1.25, 1.25, 1.55, 3.8, K.silverBody, MAT.metal);
      B(0, 9.6, -0.15, 0.15, 3.65, 3.85, K.silverBody);
      const keep = mb.matOverride;
      mb.matOverride = MAT.metal;
      for (const sd of [1, -1]) {
        const a0 = P(0, sd * 0.15, 3.85), a1 = P(9.6, sd * 0.15, 3.85), b1 = P(9.6, sd * 1.75, 5.55), b0 = P(0, sd * 1.75, 5.55);
        mb.quad(a0, a1, b1, b0, K.silverBody);
        mb.quad(b0, b1, a1, a0, K.silverBody);
      }
      mb.matOverride = keep;
    }
    B(9.75, 11.95, -1.24, 1.24, 0.75, 3.25, cab);
    shield(11.97, 1.1, 2.0, 3.0);
  }
}
// 乗用車（中心 x, z、a = 向き）
function car(mb: MeshBuilder, x: number, z: number, a: number, col: Col) {
  const P = vframe(x, 0, z, a);
  vb(mb, P, -2.15, 2.15, -0.86, 0.86, 0.25, 0.95, col);
  vb(mb, P, -1.0, 1.1, -0.76, 0.76, 0.95, 1.45, K.cabGlass, MAT.none, col);
}
// 空コンテナ用のトップリフター（マストを上げ、つかんだコンテナを持ち上げた姿）。
// (x, z) = 後ろの端、a = 前の向き。yc = つり具の上の高さ。hold = つかんだコンテナの色（null なら空）
function topLifter(mb: MeshBuilder, x: number, z: number, a: number, body: Col, mastH: number, yc: number, hold: Col | null) {
  const P = vframe(x, 0, z, a);
  const B = (s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: Col, m: number = MAT.none, top?: Col) => vb(mb, P, s0, s1, t0, t1, y0, y1, col, m, top);
  B(0.7, 6.3, -2.0, 2.0, 0.05, 1.5, K.tyre);
  B(0, 6.6, -1.75, 1.75, 1.0, 2.5, body);
  B(0, 1.3, -1.85, 1.85, 1.0, 3.3, body);
  B(1.3, 3.0, -1.6, 0.2, 2.5, 3.3, body);
  // 運転室（片側に寄せたガラスの箱）
  B(3.1, 5.3, 0.3, 1.8, 2.5, 5.0, K.cabGlass, MAT.none, body);
  // マスト（2 本の柱と上のつなぎ）
  B(6.6, 7.05, -1.55, -1.1, 0.4, mastH, K.steelDk, MAT.metal);
  B(6.6, 7.05, 1.1, 1.55, 0.4, mastH, K.steelDk, MAT.metal);
  B(6.6, 7.05, -1.55, 1.55, mastH - 0.45, mastH, K.steelDk, MAT.metal);
  // つり具：コンテナの長い辺にそった横の梁
  B(7.05, 7.4, -1.4, 1.4, yc - 1.6, yc, K.steelDk, MAT.metal);
  B(7.4, 7.75, -6.1, 6.1, yc - 0.55, yc + 0.15, body);
  if (hold) B(7.75, 10.19, -6.09, 6.09, yc - 2.59, yc, hold, MAT.metal);
}
// リーチスタッカー（斜めのブームの先でコンテナをつかむ）。lift = ブームの角度（ラジアン）
function reachStacker(mb: MeshBuilder, x: number, z: number, a: number, body: Col, lift: number, hold: Col | null) {
  const P = vframe(x, 0, z, a);
  const B = (s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: Col, m: number = MAT.none, top?: Col) => vb(mb, P, s0, s1, t0, t1, y0, y1, col, m, top);
  B(0.6, 7.4, -2.0, 2.0, 0.05, 1.6, K.tyre);
  B(0, 8.0, -1.6, 1.6, 1.0, 2.6, body);
  B(0, 1.7, -1.8, 1.8, 1.0, 3.4, body);
  B(4.3, 6.3, -1.75, -0.25, 2.6, 4.9, K.cabGlass, MAT.none, body);
  // ブーム（後ろの上から前へ斜めに）
  const Lh = 12.5 * Math.cos(lift), sl = Math.tan(lift);
  const ca = Math.cos(a), sa = Math.sin(a);
  const Pb = vframe(x + ca * 1.4, 3.5, z + sa * 1.4, a, sl);
  vb(mb, Pb, 0, Lh, -0.5, 0.5, -0.55, 0.45, body);
  const tipS = 1.4 + Lh, tipY = 3.5 + Lh * sl;
  // つり具（コンテナの長さの梁）と、つかんだコンテナ
  // 空のときは、つり具を縮めてブームの向きに回してある
  if (hold) {
    B(tipS - 0.35, tipS + 0.35, -6.1, 6.1, tipY - 1.25, tipY - 0.7, K.steelDk, MAT.metal);
    B(tipS - 1.22, tipS + 1.22, -6.09, 6.09, tipY - 3.85, tipY - 1.25, hold, MAT.metal);
  } else B(tipS - 3.0, tipS + 3.0, -0.35, 0.35, tipY - 1.25, tipY - 0.7, K.steelDk, MAT.metal);
}

// ---------------- 敷地の部品 ----------------
// フェンス（軸にそった直線）：柱と、上と下の横棒
function fence(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, h = 2.2) {
  const L = Math.hypot(x1 - x0, z1 - z0);
  if (L < 1) return;
  const n = Math.max(1, Math.round(L / 6));
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    bx(mb, x - 0.06, 0, z - 0.06, x + 0.06, h, z + 0.06, K.fence, 0, { m: MAT.metal, roof: null });
  }
  for (const y of [h - 0.1, 0.25]) bx(mb, x0 - 0.04, y, z0 - 0.04, x1 + 0.04, y + 0.07, z1 + 0.04, K.fence, 0, { m: MAT.metal });
}
// 光だまりを入れる四角（x0, z0, x1, z1）と、その地面の色
type Rect = [number, number, number, number];
interface PoolAt { a: Rect; base: Col }
// 照明塔の足もとの光だまり（夜は照らされて明るく、外へなめらかに暗くなる。昼はうすい明るいむら）。
// 頂点ごとに中心からの距離で色を混ぜた格子。地面と同じ色から、真下の明るい色へ
function pool(mb: MeshBuilder, cx: number, cz: number, R: number, p: PoolAt, y = 0.095) {
  const { a, base } = p;
  const x0 = Math.max(a[0], cx - R), x1 = Math.min(a[2], cx + R), z0 = Math.max(a[1], cz - R), z1 = Math.min(a[3], cz + R);
  if (x1 - x0 < 2 || z1 - z0 < 2) return;
  tmpC.copy(base).lerp(K.poolHi, 0.75);
  const nx = Math.max(2, Math.round((x1 - x0) / (R / 3))), nz = Math.max(2, Math.round((z1 - z0) / (R / 3)));
  const nv = (nx + 1) * (nz + 1);
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), Cl = new Float32Array(nv * 3), U = new Float32Array(nv * 2);
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const k = j * (nx + 1) + i, x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * j) / nz;
    let t = Math.max(0, 1 - Math.hypot(x - cx, z - cz) / R);
    t = t * t * (3 - 2 * t);
    P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z; N[k * 3 + 1] = 1;
    Cl[k * 3] = base.r + (tmpC.r - base.r) * t; Cl[k * 3 + 1] = base.g + (tmpC.g - base.g) * t; Cl[k * 3 + 2] = base.b + (tmpC.b - base.b) * t;
  }
  mb.gridSurface(nx, nz, P, N, Cl, U, PAT.lit, MAT.ground, () => true);
}
// 高い照明塔（頭に 2 つの大きな投光器。夜に光り、遠くからも見える）。p = 足もとの光だまり（なければなし）
function mastT(mb: MeshBuilder, x: number, z: number, h: number, p: PoolAt | null = null) {
  bx(mb, x - 0.32, 0, z - 0.32, x + 0.32, h, z + 0.32, K.steel, 0, { m: MAT.metal, roof: null });
  bx(mb, x - 1.9, h, z - 0.8, x + 1.9, h + 0.35, z + 0.8, K.steel, 0, { m: MAT.metal });
  for (const s of [-1, 1]) bx(mb, x - 1.6, h + 0.35, z + s * 0.5 - 0.25, x + 1.6, h + 1.35, z + s * 0.5 + 0.25, K.led, PAT.glow, { roof: K.steel });
  if (p) pool(mb, x, z, Math.min(18, h * 0.75), p);
}
// 低い照明柱（足もとに小さな光だまり）
function pole(mb: MeshBuilder, x: number, z: number, h: number, p: PoolAt | null = null) {
  bx(mb, x - 0.12, 0, z - 0.12, x + 0.12, h, z + 0.12, K.steel, 0, { m: MAT.metal, roof: null });
  bx(mb, x - 0.75, h - 0.28, z - 0.25, x + 0.75, h, z + 0.25, K.led, PAT.glow, { roof: K.steel });
  if (p) pool(mb, x, z, Math.min(9, h * 0.6), p);
}
// 守衛所と、ゲートの遮断機（腕は +x へ arm の長さ。負なら -x へ）
function booth(mb: MeshBuilder, x: number, z: number, arm: number) {
  bx(mb, x - 1.2, 0, z - 1.4, x + 1.2, 2.7, z + 1.4, K.white, PAT.office, { roof: K.roof });
  bx(mb, x - 1.7, 2.7, z - 1.9, x + 1.7, 3.0, z + 1.9, K.cap, 0, { roof: K.cap, m: MAT.metal });
  if (arm !== 0) {
    const s = Math.sign(arm), xa = x + s * 1.5, xb = x + arm;
    bx(mb, xa, 0.95, z + 1.6, xb, 1.07, z + 1.74, K.white, 0, { m: MAT.none });
    bx(mb, xb - s * 1.2, 0.95, z + 1.59, xb, 1.08, z + 1.75, K.red, 0, { m: MAT.none });
  }
}
// 正面の植え込み（芝生、低い生け垣、木）と、その内側のフェンス。gaps = 出入口の x の範囲。
// 横と裏のフェンスも引く（back = 裏も引く）。open = となりの敷地とつながる側（1 = -x、2 = +x。横のフェンスなし、植え込みは端まで）
function siteEdge(mb: MeshBuilder, rng: Rng, tf: TF, W: number, D: number, strip: number, gaps: [number, number][], back = true, treeGap = 9, open = 0) {
  const hw = W / 2, hd = D / 2, zs = hd - strip;
  const oL = (open & 1) !== 0, oR = (open & 2) !== 0;
  for (const [a, b] of cut(oL ? -hw : -hw + 0.3, oR ? hw : hw - 0.3, gaps)) {
    const ea = oL && a <= -hw + 0.01, eb = oR && b >= hw - 0.01;
    gq(mb, a, zs + 0.1, b, hd - 0.3, 0.1, K.lawn);
    if (b - a > 2.5) bx(mb, a + (ea ? 0 : 0.3), 0.05, zs + 0.3, b - (eb ? 0 : 0.3), 0.9, zs + 0.95, K.hedge, 0, { m: MAT.none });
    if (strip >= 2 && b - a > 4) for (let x = a + 2.2 + rng.next() * 2; x < b - 1.5; x += treeGap + rng.next() * 4) tf(x, (zs + hd) / 2 + 0.25, 0.62 + rng.next() * 0.25);
    fence(mb, a + (ea ? 0.07 : 0.1), zs, b - (eb ? 0.07 : 0.1), zs);
  }
  if (!oL) fence(mb, -hw + 0.4, -hd + 0.4, -hw + 0.4, zs);
  if (!oR) fence(mb, hw - 0.4, -hd + 0.4, hw - 0.4, zs);
  if (back) fence(mb, oL ? -hw + 0.07 : -hw + 0.4, -hd + 0.4, oR ? hw - 0.07 : hw - 0.4, -hd + 0.4);
}
// 駐車場の列：x0..x1 に 2.6m ごとの区画（奥行き z0..z1）
function carRow(mb: MeshBuilder, rng: Rng, x0: number, x1: number, z0: number, z1: number, fill = 0.65) {
  for (let x = x0; x + 2.6 <= x1 + 0.01; x += 2.6) {
    gq(mb, x, z0 + 0.3, x + 0.12, z1, 0.12, K.paint);
    if (rng.next() < fill) car(mb, x + 1.36, (z0 + z1) / 2, rng.next() < 0.5 ? Math.PI / 2 : -Math.PI / 2, rng.pick(CARS));
  }
}
// 7 つの線で描く数字（壁 d の面に貼る）。a0 = 左の端、y0 = 下の端、w×h の大きさ
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
function digit(mb: MeshBuilder, d: number, w: number, a0: number, y0: number, dw: number, dh: number, n: number, col: Col) {
  const t = dw * 0.22, m = SEG[n % 10];
  const sg = (bit: number, u0: number, v0: number, u1: number, v1: number) => {
    if (!(m & (1 << bit))) return;
    // 壁の向きで左右が入れかわる（-z と +x の面は、敷地の座標の向きと逆に読む）
    const flip = d === 2 || d === 1;
    const p0 = flip ? a0 + dw - u1 : a0 + u0, p1 = flip ? a0 + dw - u0 : a0 + u1;
    wq(mb, d, w, p0, p1, y0 + v0, y0 + v1, col, PAT.lit, MAT.none, 10);
  };
  const hh = dh / 2;
  sg(0, 0, dh - t, dw, dh);
  sg(1, dw - t, hh, dw, dh);
  sg(2, dw - t, 0, dw, hh);
  sg(3, 0, 0, dw, t);
  sg(4, 0, 0, t, hh);
  sg(5, 0, hh, t, dh);
  sg(6, 0, hh - t / 2, dw, hh + t / 2);
}
// 会社のマーク（壁 d の面 w、中心 ca, cy、半径 r）：丸（8 角形を 3 枚の面で）か、45° 回したひし形
function mark(mb: MeshBuilder, d: number, w: number, ca: number, cy: number, r: number, col: Col, round: boolean) {
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  const flip = d === 2 || d === 1;
  const Q = (p: [number, number][]) => {
    const v = p.map(([u, y]): P3 => (d === 0 || d === 2 ? [ca + u, cy + y, w] : [w, cy + y, ca + u]));
    if (flip) v.reverse();
    mb.quad(v[0], v[1], v[2], v[3], col, PAT.lit);
  };
  if (round) {
    const c = r * 0.924, s = r * 0.383;
    Q([[-c, -s], [c, -s], [c, s], [-c, s]]);
    Q([[-c, s], [c, s], [s, c], [-s, c]]);
    Q([[-s, -c], [s, -c], [c, -s], [-c, -s]]);
  } else Q([[0, -r], [r, 0], [0, r], [-r, 0]]);
  mb.matOverride = keep;
}
// 字の形（細い線 2〜4 本）：0 = I、1 = L、2 = r、3 = F、4 = n、5 = U、6 = E、7 = o、8 = P。
// st(a0, a1, y0, y1) = 線を 1 本描く。縦と横の線は重ねない（同じ面に重なる面をつくらない）
const GLYPHS = [0, 1, 2, 3, 4, 4, 5, 5, 6, 7, 7, 8];
function glyphW(k: number, h: number, r: number) {
  return k === 0 ? h * 0.16 : k === 2 ? h * 0.4 : h * (0.5 + r * 0.12);
}
function glyph(st: (a0: number, a1: number, y0: number, y1: number) => void, k: number, a: number, w: number, y0: number, top: number, s: number) {
  const ym = y0 + (top - y0) * 0.54, b = a + w;
  st(a, a + s, y0, top);
  if (k === 1) st(a + s, b, y0, y0 + s);
  else if (k === 2) st(a + s, b, top - s, top);
  else if (k === 3) { st(a + s, b, top - s, top); st(a + s, b - w * 0.15, ym - s / 2, ym + s / 2); }
  else if (k === 4) { st(a + s, b - s, top - s, top); st(b - s, b, y0, top); }
  else if (k === 5) { st(a + s, b - s, y0, y0 + s); st(b - s, b, y0, top); }
  else if (k === 6) { st(a + s, b, top - s, top); st(a + s, b - w * 0.12, ym - s / 2, ym + s / 2); st(a + s, b, y0, y0 + s); }
  else if (k === 7) { st(a + s, b - s, top - s, top); st(a + s, b - s, y0, y0 + s); st(b - s, b, y0, top); }
  else if (k === 8) { st(a + s, b, top - s, top); st(a + s, b, ym - s, ym); st(b - s, b, ym, top - s); }
}
// 看板の文字（壁 d の面 w、a0..a1、y0..y1）：左に会社のマーク、続けて細い線で組んだ字。単語の頭は大文字で高い
function letters(mb: MeshBuilder, rng: Rng, d: number, w: number, a0: number, a1: number, y0: number, y1: number, col: Col) {
  const h = y1 - y0, s = h * 0.16, xh = y0 + h * 0.74;
  // 壁の向きで左右が入れかわる（-z と +x の面は、敷地の座標の向きと逆に読む）
  const flip = d === 2 || d === 1, F = (a: number) => (flip ? a0 + a1 - a : a);
  const st = (p: number, q: number, ya: number, yb: number) => wq(mb, d, w, F(p), F(q), ya, yb, col, PAT.lit, MAT.none, 10);
  let a = a0;
  if (a1 - a0 > h * 4) {
    mark(mb, d, w, F(a + h * 0.5), y0 + h * 0.5, h * 0.5, col, rng.next() < 0.55);
    a += h * 1.45;
  }
  let first = true;
  while (a < a1) {
    const k = rng.pick(GLYPHS), lw = glyphW(k, h, rng.next());
    if (a + lw > a1) break;
    glyph(st, k, a, lw, y0, first ? y1 : xh, s);
    a += lw + h * 0.2;
    first = false;
    if (rng.next() < 0.17) { a += h * 0.45; first = true; }
  }
}

// ---------------- 冷蔵倉庫の部品 ----------------
// 断熱パネルの目地（横の線を hStep ごと、縦の線を vStep ごと）。少し濃い細い線を壁から浮かせて貼る
function panelLines(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, hStep: number, vStep: number, col0: Col, faces = 15) {
  const off = 0.03;
  let kk = 0, col = col0;
  for (let y = y0 + hStep; y < y1 - 0.8; y += hStep) {
    // 3 本ごとに少し太く濃い線（階の高さの目安になる）
    const strong = ++kk % 3 === 0, t = strong ? 0.14 : 0.08;
    col = strong ? K.joint2 : col0;
    if (faces & 1) wq(mb, 0, z1 + off, x0, x1, y - t, y + t, col, 0, MAT.none, 10);
    if (faces & 2) wq(mb, 2, z0 - off, x0, x1, y - t, y + t, col, 0, MAT.none, 10);
    if (faces & 4) wq(mb, 1, x1 + off, z0, z1, y - t, y + t, col, 0, MAT.none, 10);
    if (faces & 8) wq(mb, 3, x0 - off, z0, z1, y - t, y + t, col, 0, MAT.none, 10);
  }
  if (vStep <= 0) return;
  const vt = 0.12;
  for (const [d, w, a0, a1, bit] of [[0, z1 + off, x0, x1, 1], [2, z0 - off, x0, x1, 2], [1, x1 + off, z0, z1, 4], [3, x0 - off, z0, z1, 8]] as [number, number, number, number, number][]) {
    if (!(faces & bit)) continue;
    const n = Math.round((a1 - a0) / vStep);
    for (let i = 1; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      wq(mb, d, w + sgn(d) * 0.005, a - vt, a + vt, y0, y1, col0, 0, MAT.none, 10);
    }
  }
}
// 屋上のふち（パラペット）の輪。open = その側の板を描かない（1 = -x、2 = +x。となりの敷地の建物につながる）
function rim(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, h: number, col: Col, t = 0.35, open = 0) {
  const o: BO = { roof: K.cap, m: MAT.plaster };
  bx(mb, x0, y, z1 - t, x1, y + h, z1, col, 0, o);
  bx(mb, x0, y, z0, x1, y + h, z0 + t, col, 0, o);
  if (!(open & 1)) bx(mb, x0, y, z0 + t, x0 + t, y + h, z1 - t, col, 0, o);
  if (!(open & 2)) bx(mb, x1 - t, y, z0 + t, x1, y + h, z1 - t, col, 0, o);
}
// 屋上の冷凍機の室外機の列（暗い台の上に、ファンの丸のある箱を並べる）。alongX = 列が x の向き
function condRow(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, alongX: boolean) {
  const L = alongX ? x1 - x0 : z1 - z0;
  const n = Math.floor((L + 0.3) / 5.0);
  if (n < 1) return;
  const uw = (L + 0.3) / n - 0.3;
  bx(mb, x0 + (alongX ? 0 : 0.25), y, z0 + (alongX ? 0.25 : 0), x1 - (alongX ? 0 : 0.25), y + 0.45, z1 - (alongX ? 0.25 : 0), K.steelDk, 0, { m: MAT.metal, v: 10, roof: null });
  const wd = alongX ? z1 - z0 : x1 - x0, r = Math.min(0.82, wd * 0.36);
  for (let i = 0; i < n; i++) {
    const a = (alongX ? x0 : z0) + i * (uw + 0.3);
    const [ux0, uz0, ux1, uz1] = alongX ? [a, z0, a + uw, z1] : [x0, a, x1, a + uw];
    bx(mb, ux0, y + 0.45, uz0, ux1, y + 2.0, uz1, K.cond, 0, { roof: K.condTop, m: MAT.metal, v: 10 });
    const nf = Math.max(1, Math.round(uw / 2.4));
    for (let j = 0; j < nf; j++) {
      const t = a + (uw * (j + 0.5)) / nf;
      if (alongX) disc(mb, t, (z0 + z1) / 2, y + 2.02, r, 8, K.fan);
      else disc(mb, (x0 + x1) / 2, t, y + 2.02, r, 8, K.fan);
    }
  }
}
// 室外機を並べた面（x0..x1、z0..z1）。列の間は 3.4m
function condField(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, maxRows = 8) {
  const alongX = x1 - x0 >= z1 - z0 || z1 - z0 < 5;
  const W = alongX ? z1 - z0 : x1 - x0;
  const rows = Math.min(maxRows, Math.floor((W + 1.2) / 3.4));
  for (let r = 0; r < rows; r++) {
    const c = (alongX ? z0 : x0) + r * 3.4;
    if (alongX) condRow(mb, x0, c, x1, c + 2.2, y, true);
    else condRow(mb, c, z0, c + 2.2, z1, y, false);
  }
  return rows;
}
// 機械室の小屋（暗いガラリの帯）
function penthouse(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, h: number, col: Col) {
  bx(mb, x0, y, z0, x1, y + h, z1, col, 0, { roof: K.roof, m: MAT.metal, v: 10 });
  const g0 = y + h * 0.35, g1 = y + h * 0.78;
  wq(mb, 0, z1 + 0.03, x0 + 0.8, x1 - 0.8, g0, g1, K.grille, 0, MAT.metal, 10);
  wq(mb, 2, z0 - 0.03, x0 + 0.8, x1 - 0.8, g0, g1, K.grille, 0, MAT.metal, 10);
  wq(mb, 1, x1 + 0.03, z0 + 0.8, z1 - 0.8, g0, g1, K.grille, 0, MAT.metal, 10);
}
// 屋上の配管（細い箱を小さな台に載せる）
function pipe(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number) {
  bx(mb, x0, y + 0.9, z0, x1, y + 1.35, z1, K.pipe, 0, { m: MAT.metal, v: 10 });
  const L = Math.max(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L / 6));
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    const cx = x1 - x0 > z1 - z0 ? x : (x0 + x1) / 2, cz = x1 - x0 > z1 - z0 ? (z0 + z1) / 2 : z;
    bx(mb, cx - 0.1, y, cz - 0.1, cx + 0.1, y + 0.9, cz + 0.1, K.steelDk, 0, { m: MAT.metal, v: 10, roof: null });
  }
}
// 屋上の太陽光パネル（x の向きの列。少し +z へ傾ける）。上のふちに明るい枠の線、まん中に横の継ぎ目、
// 約 4m ごとに縦の継ぎ目を入れて、屋根が 1 枚の紺の板に見えないようにする。列の間からは屋根が見える
function solar(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, pitch = 3.3) {
  if (x1 - x0 < 3) return;
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  const lo = y + 0.3, hi = y + 0.85, dz = 1.9;
  // 傾いた面の上の点（t = 0 が下のふち、1 が上のふち）。継ぎ目の線は面から少し浮かせる
  const nl = Math.hypot(dz, hi - lo), ny = (dz / nl) * 0.025, nz = ((hi - lo) / nl) * 0.025;
  const n = Math.max(1, Math.round((x1 - x0) / 4)), sx = (x1 - x0) / n;
  for (let z = z0; z + dz <= z1; z += pitch) {
    const S = (x: number, t: number): P3 => [x, lo + (hi - lo) * t + ny, z + dz * (1 - t) + nz];
    mb.quad([x0, lo, z + dz], [x1, lo, z + dz], [x1, hi, z], [x0, hi, z], K.solar);
    mb.quad([x1, y, z], [x0, y, z], [x0, hi, z], [x1, hi, z], K.steelDk);
    mb.quad([x0, y, z + dz], [x1, y, z + dz], [x1, lo, z + dz], [x0, lo, z + dz], K.steelDk);
    mb.quad(S(x0, 0.955), S(x1, 0.955), S(x1, 1), S(x0, 1), K.cap);
    mb.quad(S(x0, 0.48), S(x1, 0.48), S(x1, 0.52), S(x0, 0.52), K.solarJ);
    for (let i = 1; i < n; i++) {
      const x = x0 + i * sx;
      mb.quad(S(x - 0.04, 0), S(x + 0.04, 0), S(x + 0.04, 0.955), S(x - 0.04, 0.955), K.solarJ);
    }
  }
  mb.matOverride = keep;
}
// 屋上の小さな空調の箱（ファンの丸）
function hvac(mb: MeshBuilder, x: number, z: number, y: number, w = 3.6, d = 2.0) {
  bx(mb, x, y, z, x + w, y + 1.4, z + d, K.cond, 0, { m: MAT.metal, roof: K.condTop, v: 10 });
  disc(mb, x + w * 0.3, z + d / 2, y + 1.42, Math.min(0.7, d * 0.34), 8, K.fan);
  disc(mb, x + w * 0.7, z + d / 2, y + 1.42, Math.min(0.7, d * 0.34), 8, K.fan);
}
// ドックシェルター（黒い布の枠と、白い断熱扉、上の灯り、車止め）。壁 d の面 w、a = 中心、y0 = 床（台）の高さ
function shelter(mb: MeshBuilder, d: number, w: number, a: number, y0: number, lamp: boolean) {
  const s = sgn(d);
  wbox(mb, d, w, a - 1.75, a + 1.75, 0, 0.62, y0 - 0.1, y0 + 3.85, K.seal, 0, { m: MAT.none, v: 10 });
  // 扉（横のうね）：面の座標の u を縦にして、金属のうねを横向きにする
  {
    const keep = mb.matOverride;
    mb.matOverride = MAT.metal;
    const wf = w + s * 0.64, b0 = a - 1.3, b1 = a + 1.3, ya = y0 + 0.2, yb = y0 + 3.15;
    if (d === 0) mb.quad([b1, ya, wf], [b1, yb, wf], [b0, yb, wf], [b0, ya, wf], K.door, 0, yb - ya, b1 - b0, 0, 10);
    else if (d === 2) mb.quad([b0, ya, wf], [b0, yb, wf], [b1, yb, wf], [b1, ya, wf], K.door, 0, yb - ya, b1 - b0, 0, 10);
    else if (d === 1) mb.quad([wf, ya, b0], [wf, yb, b0], [wf, yb, b1], [wf, ya, b1], K.door, 0, yb - ya, b1 - b0, 0, 10);
    else mb.quad([wf, ya, b1], [wf, yb, b1], [wf, yb, b0], [wf, ya, b0], K.door, 0, yb - ya, b1 - b0, 0, 10);
    mb.matOverride = keep;
  }
  // 車止め（黒いゴム）と、黄色い縁
  wq(mb, d, w + s * 0.03, a - 1.45, a - 1.0, y0 - 0.55, y0 - 0.1, K.black, 0, MAT.none, 10);
  wq(mb, d, w + s * 0.03, a + 1.0, a + 1.45, y0 - 0.55, y0 - 0.1, K.black, 0, MAT.none, 10);
  wq(mb, d, w + s * 0.03, a - 1.95, a - 1.8, 0.1, y0 - 0.1, K.yel, 0, MAT.none, 10);
  // 灯り（夜に光る）
  if (lamp) wbox(mb, d, w, a - 0.45, a + 0.45, 0, 0.3, y0 + 4.05, y0 + 4.35, K.lamp, PAT.lit, { m: MAT.none, v: 10 });
}
// ドックの面（壁 d の w）：灰色の腰壁、シェルターの列、上のひさし（下の面は夜に光る）
function dockFace(mb: MeshBuilder, d: number, w: number, a0: number, a1: number, docks: number[], y0: number, hc: number, cd: number, edge: Col | null) {
  wq(mb, d, w + sgn(d) * 0.02, a0, a1, 0, y0, K.plinth, 0, MAT.concrete);
  docks.forEach((a) => shelter(mb, d, w, a, y0, true));
  // ドックの前の地面（夜はドックの灯りに照らされる）
  {
    const [x0, z0] = wpt(d, w, a0, 0.65), [x1, z1] = wpt(d, w, a1, 4.6);
    gq(mb, x0, z0, x1, z1, 0.105, K.dockLit, PAT.lit);
  }
  if (cd > 0) {
    wbox(mb, d, w, a0, a1, 0, cd, hc, hc + 0.32, K.white, 0, { roof: K.roof, bot: K.lamp, bpat: PAT.lit, m: MAT.metal, v: 10 });
    if (edge) {
      const s = sgn(d);
      wq(mb, d, w + s * (cd + 0.02), a0, a1, hc + 0.02, hc + 0.3, edge, 0, MAT.none, 10);
    }
  }
}
// ドックに止まっている車（後ろをシェルターにつける）。room = 前に使える長さ
function dockTrucks(mb: MeshBuilder, rng: Rng, d: number, w: number, docks: number[], room: number, fill: number, stripe: Col | null) {
  const ang = d === 0 ? Math.PI / 2 : d === 2 ? -Math.PI / 2 : d === 1 ? 0 : Math.PI;
  for (const a of docks) {
    if (rng.next() > fill) continue;
    let k: VK;
    if (room >= 18.7) k = rng.pick<VK>(['reefer', 'reefer', 'reeferDrop', 'reefer10']);
    else if (room >= 14.3) k = rng.pick<VK>(['reeferDrop', 'reefer10', 'reefer10']);
    else if (room >= 12.2) k = rng.pick<VK>(['reefer10', 'reefer10', 'reefer4']);
    else if (room >= 7.3) k = 'reefer4';
    else continue;
    const [x, z] = wpt(d, w, a, 0.66);
    vehicle(mb, x, z, ang, k, rng.pick(REEF), rng.pick(CABS), { stripe: stripe && rng.next() < 0.5 ? stripe : undefined });
  }
}
// ドックの前の白い誘導線
function dockLines(mb: MeshBuilder, d: number, w: number, docks: number[], len: number) {
  for (const a of docks) for (const e of [a - 2.1, a + 2.1]) {
    const [x0, z0] = wpt(d, w, e - 0.07, 0.8), [x1, z1] = wpt(d, w, e + 0.07, 0.8 + len);
    gq(mb, x0, z0, x1, z1, 0.12, K.paint);
  }
}
// 冷凍コンテナの電源柱（黄色いケーブルでコンテナにつなぐ）。(x, z) = 柱、(cx, cz) = つなぐ先
function plug(mb: MeshBuilder, x: number, z: number, tx: number, tz: number, y: number) {
  bx(mb, x - 0.18, 0, z - 0.14, x + 0.18, 1.6, z + 0.14, K.steelDk, 0, { m: MAT.metal });
  bx(mb, x - 0.22, 1.05, z - 0.18, x + 0.22, 1.45, z + 0.18, K.yel, 0, { m: MAT.none, v: 10 });
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  const dx = tx - x, dz = tz - z, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * 0.05, nz = (dx / l) * 0.05;
  mb.quad([x - nx, 1.3, z - nz], [x + nx, 1.3, z + nz], [tx + nx, y, tz + nz], [tx - nx, y, tz - nz], K.yel);
  mb.quad([x + nx, 1.3, z + nz], [x - nx, 1.3, z - nz], [tx - nx, y, tz - nz], [tx + nx, y, tz + nz], K.yel);
  mb.matOverride = keep;
}
// 事務所（ガラスの箱）。正面 +z、floors 階、屋上の白いふち、入口のひさし
function office(mb: MeshBuilder, rng: Rng, x0: number, x1: number, z0: number, z1: number, floors: number) {
  const h = floors * 3.7 + 0.5;
  const pat = rng.pick([PAT.ribbon, PAT.ribbon, PAT.curtain]);
  bx(mb, x0, 0, z0, x1, h, z1, rng.pick([K.glass, K.glassG]), pat, { roof: K.roof, m: MAT.none });
  bx(mb, x0 - 0.12, h, z0 - 0.12, x1 + 0.12, h + 0.75, z1 + 0.12, K.white, 0, { roof: K.cap, m: MAT.metal, v: 10 });
  const e1 = x0 + Math.min(7.5, x1 - x0 - 1);
  bx(mb, x0 + 1, 3.25, z1, e1, 3.55, z1 + 2.4, K.white, 0, { roof: K.cap, bot: K.lamp, bpat: PAT.lit, m: MAT.metal, v: 10 });
  return h + 0.75;
}

// =====================================================================
// 冷凍・冷蔵倉庫。窓のほとんどない白い断熱パネルの箱、前に低い荷捌き棟（ドックシェルターの列）、
// 屋上に冷凍機の室外機の列、角にガラスの事務所、ドックに冷凍トレーラー。形は 4 種類：
//   block = 港の多層冷蔵倉庫（大きな箱＋荷捌き棟、外に出た階段・エレベーターの塔）
//   twostep = 高さの違う 2 つの箱（低い方の屋上に室外機がびっしり）
//   highbay = 自動倉庫の高い棟（銀の縦うねの外壁と縦長のロゴ）＋低い荷捌き棟（屋上に太陽光）
//   cross = 平屋のクロスドック（長いドックの列）と、冷凍コンテナの棚（3×4 以上）
// 1×2 の細い敷地は小さな冷蔵庫（coldMini）
// =====================================================================
type CK = 'block' | 'twostep' | 'highbay';
function coldStorage(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  mb.flatRoofMat = MAT.membrane;
  if (f.W < 28 || f.D < 28) { coldMini(mb, f, rng, tf, den); return; }
  // 連結した敷地どうしは、同じ選び方の乱数で形・色・高さをそろえる。つながる敷地は箱（block）だけ
  const S = f.campus !== undefined ? new Rng(f.campus) : rng;
  if (f.joinL || f.joinR) { coldBlock(mb, f, rng, tf, den, 'block', S); return; }
  const kinds: string[] = ['block', 'block', 'twostep'];
  if (f.W >= 48 || f.D >= 48) kinds.push('highbay', 'highbay');
  if (f.W >= 64 && f.D >= 48) kinds.push('cross', 'cross');
  const kind = S.pick(kinds);
  if (kind === 'cross') coldCross(mb, f, rng, tf, den);
  else coldBlock(mb, f, rng, tf, den, kind as CK, S);
}

function coldBlock(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number, kind: CK, srng?: Rng) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  // 連結した敷地どうしでそろえる選び方（形・色・高さ）。連結がなければ rng そのもの
  const S = srng ?? (f.campus !== undefined ? new Rng(f.campus) : rng);
  const jl = !!f.joinL, jr = !!f.joinR, joined = jl || jr;
  const open = (jl ? 1 : 0) | (jr ? 2 : 0);
  const lead = f.campus === undefined || !!f.lead;
  const edge = (sd: number) => (sd < 0 ? jl : jr); // その側（-1 = -x）がとなりにつながるか
  // 奥行き 48m 未満は低い冷蔵倉庫：窓のない白い箱、正面いっぱいの黒いドックシェルター、屋上の室外機（事務所のビルに見えないように）
  const short = D < 48;
  // 事務所の側（-1 = -x の端）。連結したときは、つながっていない端（両方つながっていれば事務所なし）
  const r0 = S.next();
  const os = jl && !jr ? 1 : jr && !jl ? -1 : r0 < 0.5 ? -1 : 1;
  const office = !(jl && jr);
  // 横の通路の側（ふつうは事務所の反対。連結したときは外の端＝事務所と同じ側）と幅
  const ls = joined ? os : -os;
  const lane = jl && jr ? 0 : W >= 64 ? 7 : W >= 48 ? 5 : 2.5;
  const xb0 = -hw + (jl ? 0 : ls < 0 ? lane : 2.5), xb1 = hw - (jr ? 0 : ls > 0 ? lane : 2.5);
  const strip = 3;
  const courtD = D >= 64 ? 21 : D >= 48 ? 16 : 13.5;
  const zF = hd - strip - courtD; // ドックの面
  const zB = -hd + (D >= 48 ? 3 : 2); // 建物の裏
  const annexD = D >= 64 ? 10 : D >= 48 ? 7 : 0;
  const zM = zF - annexD; // 高い棟の正面
  const panel = S.pick([K.panel, K.panel, K.ivory, K.pgrey]);
  const accent = S.pick(ACC);
  const H = D >= 48 ? (D >= 64 ? 24 : 18) + den * 2.6 + S.next() * 3 : 10 + den * 0.8 + S.next() * 1.5;
  const Ha = D >= 48 ? 8.4 + S.next() * 0.9 : 6.5; // 荷捌き棟の高さ
  // 事務所の幅（短い敷地は 1 層の小さな箱）
  const ow = short ? 5 : W >= 48 ? 11 : 8;
  // 事務所は建物の横の面より少し外へ出す（ガラスと板の壁が同じ面にならないように）
  const ox0 = os < 0 ? xb0 - 0.15 : xb1 - ow + 0.15, ox1 = ox0 + ow;
  roofPick(S);
  const floors = short ? 1 : D >= 48 && W >= 48 ? 3 : 2;
  const sL = jl ? -hw : -hw + 0.6, sR = jr ? hw : hw - 0.6; // 舗装の端

  // ---- 敷地：コンクリートの下地、トラックの前庭（アスファルト）、ドックの前のコンクリート ----
  gq(mb, jl ? -hw : -hw + 0.2, -hd + 0.2, jr ? hw : hw - 0.2, hd - 0.2, 0.07, K.apron);
  gq(mb, sL, zF, sR, hd - strip, 0.09, K.court, PAT.lit);
  const gx = -os * (hw - 8.5); // ゲートの中心
  siteEdge(mb, rng, tf, W, D, strip, [[gx - 5, gx + 5]], true, 9, open);
  if (W >= 48) booth(mb, gx + os * 6.6, hd - strip - 3.5, -os * 5.2);

  // ---- 建物の形（種類ごと）----
  // 高い棟（tall）の範囲と、低い棟（荷捌き棟と同じ高さの部分）の範囲
  const tS = S.next() < 0.5 ? -1 : 1; // 高い部分の側（twostep と highbay）
  let tx0 = xb0, tx1 = xb1; // 高い棟の x の範囲
  let lowX: [number, number] | null = null; // 高い棟の横の低い棟
  let Hl = Ha; // 低い棟の高さ
  const span = xb1 - xb0;
  if (kind === 'twostep') {
    const tw = Math.round(span * (0.5 + S.next() * 0.12));
    if (tS < 0) { tx1 = xb0 + tw; lowX = [tx1, xb1]; } else { tx0 = xb1 - tw; lowX = [xb0, tx0]; }
    Hl = Math.max(Ha + 3, Math.round(H * 0.55));
  } else if (kind === 'highbay') {
    const tw = clamp(Math.round(span * 0.48), 16, 28);
    if (tS < 0) { tx1 = xb0 + tw; lowX = [tx1, xb1]; } else { tx0 = xb1 - tw; lowX = [xb0, tx0]; }
    Hl = Ha + 0.6;
  }
  const Ht = kind === 'highbay' ? (D >= 48 ? 27 : 22) + den * 1.6 + S.next() * 2.5 : H;
  const tz1 = kind === 'highbay' && annexD === 0 ? zF : zM; // 高い棟の正面
  const wall = kind === 'highbay' ? K.silver : panel;
  const wallMat = kind === 'highbay' ? MAT.metal : MAT.plaster;
  // 高い棟の面のうち、となりにつながる面（block だけ。高い棟が敷地の端まであるとき）
  const tOpen = lowX ? 0 : open;
  const tFaces = 15 & ~(tOpen & 1 ? 8 : 0) & ~(tOpen & 2 ? 4 : 0);

  // 高い棟
  bx(mb, tx0, 0, zB, tx1, Ht, tz1, wall, 0, { roof: K.roof, m: wallMat, rm: MAT.membrane });
  ring4(mb, tx0, zB, tx1, tz1, 0, 1.2, K.plinth, 0, MAT.concrete, 0.03, 0, tOpen);
  if (kind === 'highbay') {
    // 自動倉庫：窓のない銀の箱、上のふちだけ少し明るい帯
    ring4(mb, tx0, zB, tx1, tz1, Ht - 0.7, Ht, K.white, 0, MAT.metal, 0.04, 10);
    rim(mb, tx0, zB, tx1, tz1, Ht, 0.5, K.white, 0.25);
  } else {
    panelLines(mb, tx0, zB, tx1, tz1, 0, Ht, 2.4, 9.5, K.joint, tFaces);
    rim(mb, tx0, zB, tx1, tz1, Ht, 1.1, panel, 0.35, tOpen);
  }
  // 低い棟（高い棟の横）
  if (lowX) {
    const [l0, l1] = lowX;
    bx(mb, l0, 0, zB, l1, Hl, tz1, panel, 0, { roof: K.roof, m: MAT.plaster, rm: MAT.membrane });
    ring4(mb, l0, zB, l1, tz1, 0, 1.2, K.plinth, 0, MAT.concrete, 0.03);
    panelLines(mb, l0, zB, l1, tz1, 0, Hl, 2.4, 9.5, K.joint, 1 | 2 | (l1 > tx1 ? 4 : 8));
    rim(mb, l0, zB, l1, tz1, Hl, 1.0, panel);
  }
  // 荷捌き棟（前の低い棟）
  if (annexD > 0) {
    bx(mb, xb0, 0, zM, xb1, Ha, zF, K.annex, 0, { roof: K.roof, m: MAT.plaster, rm: MAT.membrane });
    panelLines(mb, xb0, zM, xb1, zF, 0, Ha, 2.4, 0, K.joint, 1 | (jr ? 0 : 4) | (jl ? 0 : 8));
    rim(mb, xb0, zM, xb1, zF, Ha, 0.9, K.annex, 0.35, open);
  }

  // ---- 会社の色の帯と看板 ----
  // 文字は連結の中の 1 つだけ。短い敷地は事務所の側の横の面に書く（正面はドックの列だけにする）
  const bandT = S.next();
  const sx0 = tx0 + 2, sx1 = tx0 + Math.min(20, (tx1 - tx0) * 0.55);
  const sideSign = short && office;
  const sd = os > 0 ? 1 : 3, sw = os > 0 ? tx1 : tx0, sz0 = zB + (tz1 - zB) * 0.18, sz1 = zB + (tz1 - zB) * 0.82;
  const say = (y0: number, y1: number, col: Col, off: number) => {
    if (!lead) return;
    if (sideSign) letters(mb, rng, sd, sw + sgn(sd) * off, sz0, sz1, y0, y1, col);
    else letters(mb, rng, 0, tz1 + off, sx0, sx1, y0, y1, col);
  };
  if (kind === 'highbay') {
    // 縦長のロゴ（夜は自分の色で光る）
    const lc = S.pick(LOGO);
    const lx = tS < 0 ? tx0 + 2.5 : tx1 - 6.5;
    const ly0 = Math.max(Hl + 2, Ht * 0.3), ly1 = Ht - 2.2;
    wq(mb, 0, tz1 + 0.05, lx, lx + 4, ly0, ly1, lc, PAT.lit, MAT.none, 10);
    for (let k = 0; k < 4; k++) {
      const y = ly1 - 1.2 - k * 1.7;
      if (y < ly0 + 1) break;
      wq(mb, 0, tz1 + 0.07, lx + 0.7, lx + 3.3, y - 0.8, y, K.white, PAT.lit, MAT.none, 10);
    }
    // 下から照らす投光器（荷捌き棟の屋上のふち）
    const yu = annexD > 0 ? Ha : 0;
    for (const x of slots(tx0 + 2, tx1 - 2, 9)) bx(mb, x - 0.3, yu, tz1 + 0.6, x + 0.3, yu + 0.45, tz1 + 1.2, K.lamp, PAT.lit, { m: MAT.none, v: 10 });
  } else if (bandT < 0.55) {
    // 上の帯と、白い文字
    const b0 = Ht - 3.4, b1 = Ht - 0.4;
    ring4(mb, tx0, zB, tx1, tz1, b0, b1, accent, 0, MAT.none, 0.05, 10, tOpen);
    say(b0 + 0.6, b1 - 0.6, K.white, 0.08);
  } else if (bandT < 0.8) {
    // 細い 2 本の線
    ring4(mb, tx0, zB, tx1, tz1, Ht - 2.6, Ht - 2.1, accent, 0, MAT.none, 0.05, 10, tOpen);
    ring4(mb, tx0, zB, tx1, tz1, Ht - 1.5, Ht - 1.15, accent, 0, MAT.none, 0.05, 10, tOpen);
    say(Ht - 5.6, Ht - 3.6, accent, 0.06);
  } else if (lead) {
    // 帯なし：会社の色の看板の板
    if (sideSign) wq(mb, sd, sw + sgn(sd) * 0.06, sz0 - 1, sz1 + 1, Ht - 4.6, Ht - 1.6, accent, PAT.lit, MAT.none, 10);
    else wq(mb, 0, tz1 + 0.06, sx0, sx1, Ht - 4.6, Ht - 1.6, accent, PAT.lit, MAT.none, 10);
    if (sideSign) letters(mb, rng, sd, sw + sgn(sd) * 0.08, sz0, sz1, Ht - 3.8, Ht - 2.4, K.white);
    else letters(mb, rng, 0, tz1 + 0.08, sx0 + 1, sx1 - 1, Ht - 3.8, Ht - 2.4, K.white);
  }
  if (lowX && kind === 'twostep') ring4(mb, lowX[0], zB, lowX[1], tz1, Hl - 1.6, Hl - 1.1, accent, 0, MAT.none, 0.05, 10);

  // ---- 階段とエレベーターの塔（外に出た塔。縦のガラスのすき間は夜に光る）----
  // 荷捌き棟がないときは、高い棟の端の面（低い棟のない側。ふつうは通路の側）に出す。横の通路の機械室と同じ側なら前寄りに。
  // つながる側には出さない
  const machine = lane >= 4.5 && lane < 6.5 && kind !== 'highbay';
  const coreS = lowX ? tS : ls; // 塔を出す側（+1 = +x の端）
  const coreFront = annexD === 0 && machine && coreS === ls;
  const czc = coreFront ? tz1 - 3.3 : (zB + tz1) / 2;
  if (kind !== 'highbay') {
    const coreCol = bandT >= 0.8 ? accent : K.pgrey;
    if (annexD > 0) {
      const xs = tx1 - tx0 > 34 ? [tx0 + 6, tx1 - 6] : [tS < 0 || kind === 'block' ? tx0 + 5 : tx1 - 5];
      for (const xc of xs) {
        bx(mb, xc - 2.8, Ha, zM + 0.04, xc + 2.8, Ht + 3.5, zM + 3, coreCol, 0, { roof: K.cap, m: MAT.plaster, v: 10 });
        wq(mb, 0, zM + 3.03, xc - 0.55, xc + 0.55, Ha + 1, Ht + 2.6, K.slot, PAT.lit, MAT.none, 10);
      }
    } else if (!edge(coreS)) {
      const xe = coreS > 0 ? tx1 : tx0, cd = Math.min(2.2, (coreS > 0 ? hw - tx1 : tx0 + hw) - 0.7);
      // 短い敷地で、事務所の側の横の面に看板があるときは、塔を後ろ寄りに
      const cz = sideSign && coreS === os ? zB + 3.2 : czc;
      bx(mb, xe, 0, cz - 2.8, xe + coreS * cd, Ht + (short ? 1.2 : 3), cz + 2.8, coreCol, 0, { roof: K.cap, m: MAT.plaster });
      wq(mb, coreS > 0 ? 1 : 3, xe + coreS * (cd + 0.03), cz - 0.55, cz + 0.55, 1.5, Ht + (short ? 0.6 : 2.2), K.slot, PAT.lit, MAT.none, 10);
    }
  }

  // ---- 屋上 ----
  {
    // 高い棟：機械室、配管、室外機の列（短い敷地は機械室なしで、屋上いっぱいに室外機）
    const m = 2.2;
    const pw = Math.min(12, (tx1 - tx0) * 0.35), pd = Math.min(8, (tz1 - zB) * 0.45);
    const pa = rng.next() < 0.5;
    const px0 = pa ? tx0 + m : tx1 - m - pw;
    if (kind === 'highbay') {
      condField(mb, tx0 + 3.5, zB + 3.5, tx1 - 3.5, tz1 - 3.5, Ht, 4);
    } else if (short) {
      condField(mb, tx0 + (tOpen & 1 ? 1 : 1.8), zB + 1.6, tx1 - (tOpen & 2 ? 1 : 1.8), tz1 - 1.4, Ht, 6);
    } else {
      penthouse(mb, px0, zB + m, px0 + pw, zB + m + pd, Ht, 4.2, panel);
      const fx0 = pa ? px0 + pw + 1.5 : tx0 + m, fx1 = pa ? tx1 - m : px0 - 1.5;
      const rows = condField(mb, fx0, zB + m + 2.6, fx1, tz1 - m - 0.5, Ht, kind === 'twostep' ? 2 : 6);
      // 配管：機械室から、室外機の列の裏にそって
      pipe(mb, pa ? px0 + pw : fx0 + 1, zB + m + 0.8, pa ? fx1 - 1 : px0, zB + m + 1.25, Ht);
      // 機械室の前は空ける（室外機の列が足りないときは、小さな空調の箱）
      if (rows < 2) hvac(mb, px0, tz1 - m - 2.5, Ht);
    }
    // 高い建物の角の赤い灯（つながる側の角はなし）
    if (Ht >= 26) for (const [x, z] of [[tx0 + 0.4, zB + 0.4], [tx1 - 0.4, zB + 0.4], [tx0 + 0.4, tz1 - 0.4], [tx1 - 0.4, tz1 - 0.4]]) {
      if ((x < 0 && tOpen & 1) || (x > 0 && tOpen & 2)) continue;
      bx(mb, x - 0.2, Ht + (kind === 'highbay' ? 0.5 : 1.1), z - 0.2, x + 0.2, Ht + (kind === 'highbay' ? 0.9 : 1.5), z + 0.2, K.red, PAT.lit, { m: MAT.none, v: 10 });
    }
    // 低い棟の屋上：twostep は室外機がびっしり、highbay は太陽光
    if (lowX) {
      const [l0, l1] = lowX;
      if (kind === 'twostep') condField(mb, l0 + 1.8, zB + 1.8, l1 - 1.8, tz1 - 1.8, Hl);
      else {
        solar(mb, l0 + 1.5, zB + 1.5, l1 - 1.5, tz1 - 1.5, Hl);
      }
    }
    // 荷捌き棟の屋上：太陽光か、小さな空調の箱
    if (annexD > 0) {
      const a0 = xb0 + (jl ? 0.5 : 1.5), a1 = xb1 - (jr ? 0.5 : 1.5);
      if (kind === 'highbay' || S.next() < 0.5) solar(mb, a0, zM + 1.2, a1, zF - 1.2, Ha);
      else for (const x of slots(a0, a1, 12)) hvac(mb, x - 1.8, zM + 2.0, Ha);
    }
  }

  // ---- 事務所と、ドックの列 ----
  const oz1 = zF + (D >= 64 ? 5 : D >= 48 ? 3.5 : 2.5);
  if (office) office(mb, rng, ox0, ox1, zF - Math.min(3, annexD + 1.5), oz1, floors);
  // ドックの範囲（事務所の横から反対の端まで。highbay で荷捌き棟がないときは低い棟の前だけ）。つながる端は敷地の端まで
  let da = office && os < 0 ? ox1 + 1.2 : xb0 + 1.2, db = office && os > 0 ? ox0 - 1.2 : xb1 - 1.2;
  if (kind === 'highbay' && annexD === 0 && lowX) { da = Math.max(da, lowX[0] + 1); db = Math.min(db, lowX[1] - 1); }
  const docks = slots(da, db, short ? 4.0 : 4.2, 0.2);
  const yd = 1.2;
  dockFace(mb, 0, zF, jl ? -hw : da - 0.5, jr ? hw : db + 0.5, docks, yd, yd + 4.5, D >= 48 ? 2.6 : 2.0, S.next() < 0.6 ? accent : null);
  const room = hd - strip - 0.6 - (zF + 0.66);
  dockLines(mb, 0, zF, docks, Math.min(9, room - 1));
  dockTrucks(mb, rng, 0, zF, docks, room, 0.6, rng.next() < 0.5 ? accent : null);

  // ---- 横の通路（ls の側）：冷凍機の機械置き場（highbay）、機械室、電源柱につないだ冷凍コンテナ ----
  if (kind === 'highbay' && lane >= 5) {
    const ex0 = ls > 0 ? xb1 + 0.6 : xb0 - 0.6, ex1 = ls > 0 ? hw - 1.0 : -hw + 1.0;
    const ez0 = zB + 1, ez1 = Math.min(zM - 1, zB + 16);
    gq(mb, ex0, ez0, ex1, ez1, 0.11, K.conc);
    condField(mb, Math.min(ex0, ex1) + 0.4, ez0 + 0.6, Math.max(ex0, ex1) - 0.4, ez1 - 0.6, 0.1, 3);
    fence(mb, ex0, ez1, ex1, ez1, 1.8);
  } else if (machine) {
    // 冷凍機の機械室（自然冷媒）の低い棟と、上の室外機（階段の塔が前寄りにあるときは、その手前まで）
    const mx0 = ls > 0 ? xb1 : xb0, mx1 = ls > 0 ? xb1 + 3.6 : xb0 - 3.6;
    const mz0 = zB + 1.5, mz1 = Math.min(zM - 1, zB + 13, coreFront ? czc - 3.3 : Infinity);
    if (mz1 - mz0 >= 5) {
      bx(mb, mx0, 0, mz0, mx1, 5.2, mz1, K.pgrey, 0, { roof: K.roof, m: MAT.plaster });
      wq(mb, ls > 0 ? 1 : 3, mx1 + (ls > 0 ? 0.03 : -0.03), mz0 + 1, mz1 - 1, 2.2, 4.4, K.grille, 0, MAT.metal, 10);
      condRow(mb, Math.min(mx0, mx1) + 0.4, mz0 + 0.5, Math.max(mx0, mx1) - 0.4, mz1 - 0.5, 5.2, false);
      if (!coreFront) pipe(mb, Math.min(mx0, mx1) + 1.2, mz1 - 0.4, Math.min(mx0, mx1) + 1.6, zM - 0.5, 5.2);
    }
  } else if (lane >= 6.5 && D >= 48) {
    const xr = ls > 0 ? hw - 2.2 : -hw + 2.2;
    const n = Math.min(3, Math.floor((zF - zB - 2) / 13.5));
    for (let i = 0; i < n; i++) {
      const z = zB + 1 + i * 13.5;
      vehicle(mb, xr, z, Math.PI / 2, 'contDrop', rng.pick(REEF), K.white);
      plug(mb, xr - ls * 2.0, z + 13.0, xr - ls * 0.95, z + 12.6, 2.6);
    }
  }

  // ---- 事務所の前の駐車場、照明 ----
  if (office && D >= 48) {
    const px0 = os < 0 ? ox0 : ox0 - 0.5, px1 = os < 0 ? ox1 + 0.5 : ox1;
    const pz1 = hd - strip - 0.3;
    if (pz1 - 5.2 > oz1 + 3) carRow(mb, rng, Math.max(-hw + 1, px0), Math.min(hw - 1, px1), pz1 - 5.2, pz1, 0.7);
  } else if (office) {
    for (let i = 0; i < 2; i++) car(mb, ox0 + 1 + i * 2.8, hd - strip - 2.6, Math.PI / 2, rng.pick(CARS));
  }
  const cp: PoolAt = { a: [sL, zF, sR, hd - strip], base: K.court };
  if (!edge(ls)) pole(mb, ls > 0 ? hw - 1.4 : -hw + 1.4, hd - strip - 1.2, 11, cp);
  if (office && W >= 48) pole(mb, (ox0 + ox1) / 2 - os * (ow / 2 + 4), hd - strip - 1.2, 11, cp);
}

// 平屋のクロスドック（長いドックの列）と、横の冷凍コンテナの棚（4×3 以上）
function coldCross(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const rs = rng.next() < 0.5 ? -1 : 1; // 棚の側
  const strip = 3, courtD = D >= 64 ? 21 : 16;
  const zF = hd - strip - courtD, zB = -hd + 3;
  const rackW = 16.5;
  const xs0 = rs < 0 ? -hw + rackW + 2 : -hw + 2.5, xs1 = rs < 0 ? hw - 2.5 : hw - rackW - 2;
  const H = 12 + den * 0.6 + rng.next() * 1.4;
  const panel = rng.pick([K.panel, K.ivory, K.pgrey]);
  const accent = rng.pick(ACC);
  roofPick(rng);
  gq(mb, -hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, K.apron);
  gq(mb, -hw + 0.6, zF, hw - 0.6, hd - strip, 0.09, K.court, PAT.lit);
  const gx = rs * (hw - 9);
  siteEdge(mb, rng, tf, W, D, strip, [[gx - 5, gx + 5]]);
  booth(mb, gx - rs * 6.6, hd - strip - 3.5, rs * 5.2);

  // ---- 平屋の箱：白いパネル、濃い灰色の腰の帯、8 つの部屋の区切り（縦の目地）----
  bx(mb, xs0, 0, zB, xs1, H, zF, panel, 0, { roof: K.roof, m: MAT.plaster, rm: MAT.membrane });
  ring4(mb, xs0, zB, xs1, zF, 0, 1.5, K.plinth, 0, MAT.concrete, 0.03);
  panelLines(mb, xs0, zB, xs1, zF, 1.5, H, 2.6, 0, K.joint, 2 | 4 | 8);
  for (let i = 1; i < 8; i++) {
    const x = xs0 + ((xs1 - xs0) * i) / 8;
    wq(mb, 2, zB - 0.05, x - 0.22, x + 0.22, 1.5, H, K.joint, 0, MAT.none, 10);
  }
  rim(mb, xs0, zB, xs1, zF, H, 0.8, panel);
  // 看板（正面の上）
  {
    const a0 = rs < 0 ? xs1 - 22 : xs0 + 2;
    wq(mb, 0, zF + 0.05, a0, a0 + 20, H - 3.4, H - 0.6, accent, PAT.lit, MAT.none, 10);
    letters(mb, rng, 0, zF + 0.08, a0 + 1, a0 + 19, H - 2.6, H - 1.4, K.white);
  }
  // 屋上：室外機の列（奥）と太陽光（手前）
  const zmid = zB + (zF - zB) * 0.45;
  condField(mb, xs0 + 2, zB + 2, xs1 - 2, zmid, H, 4);
  solar(mb, xs0 + 2, zmid + 1.5, xs1 - 2, zF - 1.5, H);

  // ---- 事務所と、長いドックの列 ----
  const ow = 10, ox0 = rs < 0 ? xs1 - ow + 0.15 : xs0 - 0.15, ox1 = ox0 + ow;
  office(mb, rng, ox0, ox1, zF - 2, zF + 4, 2);
  const da = rs < 0 ? xs0 + 1.2 : ox1 + 1.2, db = rs < 0 ? ox0 - 1.2 : xs1 - 1.2;
  const docks = slots(da, db, 4.0, 0.2);
  dockFace(mb, 0, zF, da - 0.5, db + 0.5, docks, 1.2, 5.6, 3.4, accent);
  const room = hd - strip - 0.6 - (zF + 0.66);
  dockLines(mb, 0, zF, docks, Math.min(9, room - 1));
  dockTrucks(mb, rng, 0, zF, docks, room, 0.62, rng.next() < 0.5 ? accent : null);

  // ---- 冷凍コンテナの棚：鉄の骨組み（各段の通路と黄色い手すり）に、白い冷凍コンテナを 2〜3 段 ----
  // コンテナは x の向き。冷凍機の付いた端は通路の側
  const rx0 = rs < 0 ? -hw + 1.2 : hw - 1.2 - 12.2; // コンテナの x の始まり
  const wx = rs < 0 ? rx0 + 12.2 : rx0; // 通路の側の端
  const wd = rs < 0 ? 1 : 3; // 通路の側の面の向き
  const tiers = den >= 2 ? 3 : 2;
  const rz0 = zB, rz1 = zF + 2;
  const nRows = Math.floor((rz1 - rz0) / 2.5);
  const hts: number[][] = [[]], cols: Col[][][] = [[]];
  for (let r = 0; r < nRows; r++) {
    const h = rng.next() < 0.12 ? tiers - 1 : tiers;
    hts[0].push(h);
    cols[0].push(Array.from({ length: h }, () => rng.pick(REEF)));
  }
  contBlock(mb, { alongX: true, a0: rx0, c0: rz0, lens: [12.19], rows: nRows, hts, cols, pitch: 2.5 });
  // 冷凍機の面（灰色の板と暗い吸い込み口）
  for (let r = 0; r < nRows; r++) for (let k = 0; k < hts[0][r]; k++) {
    const z0 = rz0 + r * 2.5, y0 = k * 2.59;
    wq(mb, wd, wx + sgn(wd) * 0.06, z0 + 0.25, z0 + 2.2, y0 + 0.3, y0 + 2.3, K.unit, 0, MAT.metal, y0 + 0.3);
    wq(mb, wd, wx + sgn(wd) * 0.08, z0 + 0.6, z0 + 1.6, y0 + 1.1, y0 + 2.0, K.grille, 0, MAT.none, 10);
  }
  // 骨組み：柱、各段の通路の床、手すり
  const gw0 = rs < 0 ? wx + 0.4 : wx - 0.4, gw1 = rs < 0 ? wx + 1.9 : wx - 1.9;
  for (let z = rz0; z <= rz0 + nRows * 2.5 + 0.01; z += Math.max(2.5, (nRows * 2.5) / Math.max(1, Math.round((nRows * 2.5) / 7.5)))) {
    bx(mb, gw1 - 0.1, 0, z - 0.1, gw1 + 0.1, tiers * 2.59 + 1.2, z + 0.1, K.steel, 0, { m: MAT.metal, roof: null });
    bx(mb, gw0 - 0.1, 0, z - 0.1, gw0 + 0.1, tiers * 2.59 + 1.2, z + 0.1, K.steel, 0, { m: MAT.metal, roof: null });
  }
  for (let k = 1; k <= tiers; k++) {
    const y = k * 2.59 - 0.1;
    bx(mb, gw0, y - 0.2, rz0, gw1, y, rz0 + nRows * 2.5, K.steelDk, 0, { m: MAT.metal, v: 10, bot: K.steelDk });
    bx(mb, gw1 - 0.05, y + 1.0, rz0, gw1 + 0.05, y + 1.1, rz0 + nRows * 2.5, K.yel, 0, { m: MAT.none, v: 10 });
    // 夜に通路の LED の線
    wq(mb, rs < 0 ? 1 : 3, gw1 + (rs < 0 ? 0.08 : -0.08), rz0, rz0 + nRows * 2.5, y - 0.18, y - 0.06, K.led, PAT.glow, MAT.none, 10);
  }
  const cp: PoolAt = { a: [-hw + 0.6, zF, hw - 0.6, hd - strip], base: K.court };
  mastT(mb, rs < 0 ? -hw + 14.5 : hw - 14.5, zF + 3.5, 20, cp);
  pole(mb, -rs * (hw - 1.4), hd - strip - 1.2, 11, cp);
}

// 1×2 の細い敷地：小さな冷蔵庫（2 つのドック、屋上に室外機、4t か 10t の冷凍車）
function coldMini(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const panel = rng.pick([K.panel, K.ivory, K.pgrey]);
  const accent = rng.pick(ACC);
  const H = 9.5 + den * 0.8 + rng.next() * 1.5;
  roofPick(rng);
  gq(mb, -hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, K.apron);
  if (D >= W) {
    // 縦長：建物は奥、ドックは正面、前庭は手前
    const strip = 1.8;
    const x0 = -hw + 1.4, x1 = hw - 1.4, z0 = -hd + 1.4, z1 = Math.min(z0 + 15, hd - strip - 13.3);
    gq(mb, -hw + 0.6, z1, hw - 0.6, hd - strip, 0.09, K.court, PAT.lit);
    siteEdge(mb, rng, tf, W, D, strip, [[-4, hw - 0.5]], true, 20);
    bx(mb, x0, 0, z0, x1, H, z1, panel, 0, { roof: K.roof, m: MAT.plaster, rm: MAT.membrane });
    panelLines(mb, x0, z0, x1, z1, 0, H, 2.4, 0, K.joint);
    rim(mb, x0, z0, x1, z1, H, 0.8, panel);
    ring4(mb, x0, z0, x1, z1, H - 2.2, H - 0.6, accent, 0, MAT.none, 0.05, 10);
    letters(mb, rng, 0, z1 + 0.08, x0 + 1, x1 - 1, H - 1.9, H - 0.9, K.white);
    const docks = [x0 + 2.4, x0 + 6.6];
    dockFace(mb, 0, z1, x0 + 0.3, x0 + 8.7, docks, 1.1, 5.4, 1.8, accent);
    // 入口（小さなガラスの扉と窓の帯）
    wq(mb, 0, z1 + 0.04, x1 - 3.4, x1 - 0.6, 0.1, 2.6, K.glass, PAT.curtain, MAT.none);
    wq(mb, 0, z1 + 0.04, x1 - 3.4, x1 - 0.6, 3.3, 4.6, K.glass, PAT.ribbon, MAT.none, 3.3);
    condRow(mb, x0 + 1, z0 + 1.2, x1 - 1, z0 + 3.4, H, true);
    condRow(mb, x0 + 1, z0 + 5, x1 - 1, z0 + 7.2, H, true);
    hvac(mb, x0 + 1, z1 - 3.5, H, 3.2, 2.0);
    const room = hd - strip - 0.4 - (z1 + 0.66);
    dockTrucks(mb, rng, 0, z1, docks.slice(0, 1 + (rng.next() < 0.5 ? 1 : 0)), room, 0.9, null);
    pole(mb, hw - 1.2, hd - strip - 1.0, 9, { a: [-hw + 0.6, z1, hw - 0.6, hd - strip], base: K.court });
  } else {
    // 横長：建物は左（-x）、ドックは右の面（+x）、前庭は右
    const strip = 1.8;
    const x0 = -hw + 1.4, x1 = x0 + 15, z0 = -hd + 1.4, z1 = hd - strip - 0.6;
    gq(mb, x1, -hd + 0.6, hw - 0.6, hd - strip, 0.09, K.court, PAT.lit);
    siteEdge(mb, rng, tf, W, D, strip, [[x1 + 1, hw - 0.5]], true, 20);
    bx(mb, x0, 0, z0, x1, H, z1, panel, 0, { roof: K.roof, m: MAT.plaster, rm: MAT.membrane });
    panelLines(mb, x0, z0, x1, z1, 0, H, 2.4, 0, K.joint);
    rim(mb, x0, z0, x1, z1, H, 0.8, panel);
    ring4(mb, x0, z0, x1, z1, H - 2.2, H - 0.6, accent, 0, MAT.none, 0.05, 10);
    letters(mb, rng, 0, z1 + 0.08, x0 + 1, x1 - 1, H - 1.9, H - 0.9, K.white);
    const docks = [z0 + 2.4, z0 + 6.6];
    dockFace(mb, 1, x1, z0 + 0.3, z0 + 8.7, docks, 1.1, 5.4, 1.8, accent);
    wq(mb, 0, z1 + 0.04, x0 + 1, x0 + 4, 0.1, 2.6, K.glass, PAT.curtain, MAT.none);
    wq(mb, 0, z1 + 0.04, x0 + 1, x1 - 1, 3.3, 4.6, K.glass, PAT.ribbon, MAT.none, 3.3);
    condRow(mb, x0 + 1.2, z0 + 1, x0 + 3.4, z1 - 1, H, false);
    condRow(mb, x0 + 5, z0 + 1, x0 + 7.2, z1 - 1, H, false);
    const room = hw - 0.8 - (x1 + 0.66);
    dockTrucks(mb, rng, 1, x1, docks.slice(0, 1 + (rng.next() < 0.5 ? 1 : 0)), room, 0.9, null);
    pole(mb, hw - 1.2, -hd + 1.2, 9, { a: [x1, -hd + 0.6, hw - 0.6, hd - strip], base: K.court });
  }
}

// =====================================================================
// コンテナの区画。alongX = 長さの向きが x。長さの向きに lens[i] の箱を並べ（a0 から）、横の向きに rows 列（c0 から pitch ごと）。
// hts[i][r] = 段数、cols[i][r][k] = 色。となりの箱にふさがれる面は描かない。
// 面ごとに、少し暗い枠の面と、少し内側に小さくした板を重ねて、1 つずつの箱に見せる
// =====================================================================
const CH = 2.59, CW = 2.44;
// lit = 夜に照明塔に照らされる面（1 = 横の向きの - の面、2 = 横の向きの + の面、4 = 長さの向きの + の端、8 = - の端）。
// 照らされるのは下の 3 段だけ（上へ行くほど暗くなる。照明塔の光が届く高さ）
interface Blk { alongX: boolean; a0: number; c0: number; lens: number[]; rows: number; hts: number[][]; cols: Col[][][]; pitch?: number; lit?: number }
// コンテナの 1 つの面。pat = PAT.lit なら夜は照らされて明るい（内側の板だけ。箱の合わせ目の枠は暗いまま）
function contFace(mb: MeshBuilder, d: number, w: number, a0: number, a1: number, y0: number, y1: number, col: Col, end = false, pat = 0) {
  tmpC.copy(col).multiplyScalar(0.62);
  wq(mb, d, w, a0, a1, y0, y1, tmpC, 0, MAT.metal, y0);
  wq(mb, d, w + sgn(d) * 0.025, a0 + 0.09, a1 - 0.09, y0 + 0.13, y1 - 0.09, col, pat, MAT.metal, y0 + 0.13);
  // 端の面：扉の合わせ目（縦の暗い線）
  if (end) {
    const m = (a0 + a1) / 2;
    tmpC.copy(col).multiplyScalar(0.5);
    wq(mb, d, w + sgn(d) * 0.04, m - 0.04, m + 0.04, y0 + 0.2, y1 - 0.15, tmpC, 0, MAT.none, 10);
  }
}
function contTop(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, col: Col) {
  tmpC.copy(col).multiplyScalar(0.6);
  gq(mb, x0, z0, x1, z1, y, tmpC, 0, MAT.none);
  tmpC.copy(col).multiplyScalar(1.04);
  gq(mb, x0 + 0.08, z0 + 0.08, x1 - 0.08, z1 - 0.08, y + 0.02, tmpC, 0, MAT.none);
}
function contBlock(mb: MeshBuilder, b: Blk) {
  const { alongX, a0, c0, lens, rows, hts, cols } = b;
  const pitch = b.pitch ?? CW;
  const n = lens.length;
  const as: number[] = [];
  let a = a0;
  for (const L of lens) { as.push(a); a += L; }
  const Hh = (i: number, r: number) => (i < 0 || i >= n || r < 0 || r >= rows ? 0 : hts[i][r]);
  // 長さの向きの面（d：+a、-a）と、横の向きの面
  const dA = (plus: boolean) => (alongX ? (plus ? 1 : 3) : (plus ? 0 : 2));
  const dC = (plus: boolean) => (alongX ? (plus ? 0 : 2) : (plus ? 1 : 3));
  // すき間があるとき（pitch > CW）は、横の向きのとなりにふさがれない
  const gapC = pitch > CW + 0.05;
  const lit = b.lit ?? 0;
  const pC0 = lit & 1 ? PAT.lit : 0, pC1 = lit & 2 ? PAT.lit : 0, pA1 = lit & 4 ? PAT.lit : 0, pA0 = lit & 8 ? PAT.lit : 0;
  for (let i = 0; i < n; i++) for (let r = 0; r < rows; r++) {
    const h = hts[i][r];
    const A0 = as[i], A1 = as[i] + lens[i], C0 = c0 + r * pitch, C1 = C0 + CW;
    for (let k = 0; k < h; k++) {
      const y0 = k * CH, y1 = y0 + CH, col = cols[i][r][k], lo = k <= 2;
      if (Hh(i + 1, r) <= k) contFace(mb, dA(true), A1, C0, C1, y0, y1, col, true, lo ? pA1 : 0);
      if (Hh(i - 1, r) <= k) contFace(mb, dA(false), A0, C0, C1, y0, y1, col, true, lo ? pA0 : 0);
      if (gapC || Hh(i, r + 1) <= k) contFace(mb, dC(true), C1, A0, A1, y0, y1, col, false, lo ? pC1 : 0);
      if (gapC || Hh(i, r - 1) <= k) contFace(mb, dC(false), C0, A0, A1, y0, y1, col, false, lo ? pC0 : 0);
    }
    if (h > 0) {
      const y = h * CH;
      if (alongX) contTop(mb, A0, C0, A1, C1, y, cols[i][r][h - 1]);
      else contTop(mb, C0, A0, C1, A1, y, cols[i][r][h - 1]);
    }
  }
}
// 1 つの船会社の系統から色を選ぶ（たまにほかの会社の色や、さびた箱がまじる）
function boxCol(rng: Rng, fam: number): Col {
  const r = rng.next();
  if (r < 0.06) return rng.pick(RUST);
  if (r < 0.16) return rng.pick(rng.pick(LINES));
  return rng.pick(LINES[fam]);
}

// =====================================================================
// コンテナヤード。形は 3 種類：
//   depot = 空コンテナのデポ（船会社ごとの色の高い壁、トップリフター、ゲートの屋根、修理の小屋、冷凍コンテナの点検の列）
//   cfs = CFS の上屋（片側はコンテナのドック、片側はトラックの台とひさし、リーチスタッカー、積んだコンテナ）（3×3 以上）
//   chassis = シャーシプール（骨組みのシャーシを、中央の通路に頭を向けて並べる、トラクターの屋根、受付の小屋）
// 1×2 の細い敷地は小さなデポ
// =====================================================================
function containerYard(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  mb.flatRoofMat = MAT.membrane;
  const W = f.W, D = f.D;
  if (W < 28 || D < 28) { depot(mb, f, rng, tf, den); return; }
  // シャーシプールは奥行き 44m 以上（2 列が入るとき）
  const kinds = D >= 44 ? ['depot', 'depot', 'chassis'] : ['depot', 'depot'];
  if (W >= 48 && D >= 48) kinds.push('cfs', 'cfs');
  const k = rng.pick(kinds);
  if (k === 'cfs') cfs(mb, f, rng, tf, den);
  else if (k === 'chassis') chassisPool(mb, f, rng, tf, den);
  else depot(mb, f, rng, tf, den);
}

// ---- 空コンテナのデポ ----
function depot(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const small = Math.min(W, D) < 28;
  const big = W >= 48 && D >= 48;
  const strip = small ? 1.6 : 2.5;
  const gateD = D >= 48 ? 13 : D >= 32 ? 9 : 7; // ゲートの帯（植え込みの内側）
  const zs = hd - strip;
  const zG = zs - gateD; // 区画を置く範囲の前の端
  const xa = -hw + 1.2, xb = hw - 1.2, za = -hd + 1.2;
  const ls = rng.next() < 0.5 ? -1 : 1; // 横の通路・ゲートの側
  const alongX = xb - xa >= zG - za;
  const sideLane = alongX && W >= 48 ? 6.5 : 0;
  const cx0 = ls < 0 ? xa + sideLane : xa, cx1 = ls > 0 ? xb - sideLane : xb;
  // 長さの向き（x の向きの区画は横の通路の反対の端から、z の向きの区画は奥から。z の向きは前に車の通り道を残す）
  const L = alongX ? cx1 - cx0 : zG - za - (big ? 4.6 : 0);
  const A = alongX ? zG - za : cx1 - cx0;
  // 空コンテナの壁は高く（5〜7 段がふつう）
  const maxH = clamp(4 + den + (big ? 1 : 0) - (small ? 1 : 0), 4, 7);

  gq(mb, -hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, K.apron);
  gq(mb, -hw + 0.5, -hd + 0.5, hw - 0.5, zs, 0.09, K.yard, PAT.lit);
  const gw = big ? 10 : 7.5;
  const gx0 = ls < 0 ? -hw + 1 : hw - 1 - gw, gx1 = gx0 + gw;
  siteEdge(mb, rng, tf, W, D, strip, [[gx0, gx1]], true, 11);

  // ---- 長さの向きの並び（40ft を詰め、余りに 20ft）----
  const lens: number[] = [];
  let used = 0;
  while (used + 12.19 <= L) { lens.push(12.19); used += 12.19; }
  if (used + 6.06 <= L) { lens.push(6.06); used += 6.06; }
  if (rng.next() < 0.5) lens.reverse();
  const n = lens.length;
  const aStart = alongX ? (ls < 0 ? cx1 - used : cx0) : za;
  const aAt = (i: number) => { let a = aStart; for (let j = 0; j < i; j++) a += lens[j]; return a; };
  // 通路の奥の端の並び番号（照明塔を置くので、ここには機械を置かない）
  const farI = alongX ? (ls < 0 ? n - 1 : 0) : 0;
  // ---- 横の向き：区画（2〜3 列）と通路（9〜16m）----
  const aisleMin = small ? 7.5 : A >= 30 ? 11 : 9;
  let nb = 1;
  while ((nb + 1) * 2 * CW + nb * aisleMin <= A) nb++;
  const rowsOf: number[] = Array(nb).fill(2);
  let extra = A - nb * 2 * CW - (nb - 1) * aisleMin;
  for (let i = 0; i < nb && extra >= CW + 0.5; i++) {
    if (nb === 1 && A < 12) break;
    rowsOf[i] = 3;
    extra -= CW;
  }
  const aisle = nb > 1 ? Math.min(16, aisleMin + extra / (nb - 1)) : 0;
  const total = rowsOf.reduce((s, r) => s + r * CW, 0) + (nb - 1) * aisle;
  // 横の向きの始まり：x の向きの区画は奥から。z の向きの区画はゲートの反対の側に寄せる
  const cStart = alongX ? za : ls < 0 ? cx1 - total : cx0;
  const cEnd = cStart + total;
  const blocks: { c0: number; rows: number; hts: number[][]; cols: Col[][][] }[] = [];
  let c = cStart;
  for (let bI = 0; bI < nb; bI++) {
    const rows = rowsOf[bI];
    const hts: number[][] = [], cols: Col[][][] = [];
    for (let i = 0; i < n; i++) {
      // 2 本ごとに船会社が変わる
      const fam = (Math.floor(i / 2) * 3 + bI * 5 + rng.int(LINES.length)) % LINES.length;
      hts.push([]);
      cols.push([]);
      for (let r = 0; r < rows; r++) {
        let h = maxH - (rng.next() < 0.15 ? 1 + rng.int(2) : 0);
        if (i === 0 || i === n - 1) h = maxH;
        if (rng.next() < 0.05) h = 0;
        h = Math.max(0, h);
        hts[i].push(h);
        cols[i].push(Array.from({ length: h }, () => boxCol(rng, fam)));
      }
    }
    blocks.push({ c0: c, rows, hts, cols });
    c += rows * CW + aisle;
  }
  // 冷凍コンテナの点検の列：通路に面した区画の、奥の端を白い冷凍コンテナ 1〜2 段に（電源柱につなぐ）
  const pti = !small && n >= 2 && (alongX || nb >= 2);
  const ptiB = alongX ? nb - 1 : 0;
  if (pti) {
    const blk = blocks[ptiB];
    for (let r = 0; r < blk.rows; r++) {
      const h = r === blk.rows - 1 ? 1 : 2;
      blk.hts[farI][r] = h;
      blk.cols[farI][r] = Array.from({ length: h }, () => rng.pick(REEF));
    }
  }
  // 壁の下の段は夜に照明塔で照らされる（4 つの面とも。上の段は暗いまま）
  blocks.forEach((blk) => {
    contBlock(mb, { alongX, a0: aStart, c0: blk.c0, lens, rows: blk.rows, hts: blk.hts, cols: blk.cols, lit: 1 | 2 | 4 | 8 });
  });

  // ---- 地面の白線（区画のふち）と、区画の番号 ----
  const toXZ = (a: number, cc: number): [number, number] => (alongX ? [a, cc] : [cc, a]);
  blocks.forEach((blk, bI) => {
    const e0 = blk.c0 - 0.5, e1 = blk.c0 + blk.rows * CW + 0.5;
    for (const e of [e0, e1]) {
      const [x0, z0] = toXZ(aStart - 0.3, e - 0.08), [x1, z1] = toXZ(aStart + used + 0.3, e + 0.08);
      gq(mb, x0, z0, x1, z1, 0.11, K.paint);
    }
    // 番号：区画の前の地面に白い字
    if (bI < nb - 1) {
      const nearA = alongX ? (ls < 0 ? aStart + 1.5 : aStart + used - 3.5) : aStart + used - 3.5;
      const [nx, nz] = toXZ(nearA, e1 + 1.0);
      gq(mb, nx, nz, nx + 1.4, nz + 0.25, 0.12, K.paint);
      gq(mb, nx + 1.8, nz, nx + 2.05, nz + 1.6, 0.12, K.paint);
    }
  });
  if (pti) {
    const blk = blocks[ptiB];
    const ai = aAt(farI), face = blk.c0 + blk.rows * CW;
    for (const t of [0.3, 0.7]) {
      const aa = ai + lens[farI] * t;
      const [px, pz] = toXZ(aa, face + 1.4), [qx, qz] = toXZ(aa, face + 0.05);
      plug(mb, px, pz, qx, qz, 1.6);
    }
  }

  // ---- 荷役の機械：通路のトップリフター（コンテナを持ち上げた姿）か、リーチスタッカー ----
  const fwdA = alongX ? 0 : Math.PI / 2; // +a の向き
  if (nb >= 2) {
    const used2: [number, number][] = [];
    const tries = big ? 2 : 1;
    for (let m = 0; m < tries; m++) {
      const body = rng.pick(MACH);
      const bI = rng.int(nb - 1); // 区画 bI と bI+1 の間の通路
      if (aisle >= 10.8 && n >= 2) {
        const cand: number[] = [];
        for (let i = 0; i < n; i++) if (i !== farI && used2.every(([b, j]) => b !== bI || Math.abs(j - i) >= 2)) cand.push(i);
        if (!cand.length) continue;
        const i = rng.pick(cand);
        used2.push([bI, i]);
        const blk = blocks[bI + 1];
        const am = aAt(i) + lens[i] / 2;
        const front = blk.c0; // 次の区画の手前の面
        const yc = Math.min(maxH, blk.hts[i][0] + 1) * CH + 0.3;
        const [x, z] = toXZ(am, front - 10.5);
        topLifter(mb, x, z, alongX ? Math.PI / 2 : 0, body, Math.max(yc + 1.5, maxH * CH + 2.5), yc, rng.next() < 0.8 ? boxCol(rng, rng.int(LINES.length)) : null);
      } else if (m === 0) {
        // 通路が狭い：リーチスタッカーを通路にそって置く
        const cm = blocks[bI].c0 + blocks[bI].rows * CW + aisle / 2;
        const aS = aStart + 0.5 + rng.next() * Math.max(0, used - 17.5);
        const [x, z] = toXZ(aS, cm);
        reachStacker(mb, x, z, fwdA, body, 0.22, null);
      }
    }
  } else {
    // 区画が 1 つ：空いている側にリーチスタッカー
    const f0 = alongX ? cEnd : ls < 0 ? cx0 : cEnd, f1 = alongX ? zG : ls < 0 ? cStart : cx1;
    if (f1 - f0 >= 5.5 && used >= 14) {
      const [x, z] = toXZ(aStart + 0.6, (f0 + f1) / 2);
      reachStacker(mb, x, z, fwdA, rng.pick(MACH), 0.2, null);
    }
  }

  // ---- ゲートの帯：ゲートの屋根（大きな敷地）か小さな受付、事務所、待っているトレーラー、修理の小屋 ----
  if (big) {
    const cz0 = zs - 9.5, cz1 = zs - 2;
    // 屋根（下の面は夜に光る）と柱、2 つの車線、真ん中の島の受付
    bx(mb, gx0 + 0.5, 6.2, cz0, gx1 - 0.5, 6.85, cz1, K.white, 0, { roof: K.roof, bot: K.lamp, bpat: PAT.lit, m: MAT.metal, v: 10 });
    gq(mb, gx0 + 0.5, cz0, gx1 - 0.5, cz1, 0.1, K.litGround, PAT.lit);
    wq(mb, 0, cz1 + 0.03, gx0 + 0.5, gx1 - 0.5, 6.25, 6.8, rng.pick(ACC), 0, MAT.none, 10);
    for (const x of [gx0 + 0.9, gx1 - 0.9]) for (const z of [cz0 + 0.6, cz1 - 0.6]) bx(mb, x - 0.2, 0, z - 0.2, x + 0.2, 6.2, z + 0.2, K.steel, 0, { m: MAT.metal, roof: null });
    const xm = (gx0 + gx1) / 2;
    bx(mb, xm - 0.7, 0.1, cz0 + 0.5, xm + 0.7, 0.3, cz1 - 0.5, K.yel, 0, { m: MAT.none });
    bx(mb, xm - 0.6, 0.3, cz0 + 2, xm + 0.6, 2.8, cz0 + 4.2, K.white, PAT.office, { roof: K.cap });
    gq(mb, gx0 + 0.5, cz0 - 3, gx0 + 0.65, zs, 0.12, K.paint);
    gq(mb, gx1 - 0.65, cz0 - 3, gx1 - 0.5, zs, 0.12, K.paint);
    // 入ってくるトレーラー（屋根の下で止まっている。外側の車線）
    vehicle(mb, xm + (ls < 0 ? -2.3 : 2.3), zs - 0.1, -Math.PI / 2, 'cont', boxCol(rng, rng.int(LINES.length)), rng.pick(CABS));
  } else {
    const kx = gx0 + (ls < 0 ? gw - 1.2 : 1.2);
    bx(mb, kx - 0.9, 0, zs - 4.2, kx + 0.9, 2.6, zs - 1.8, K.white, PAT.office, { roof: K.cap });
  }
  // 事務所（プレハブ）
  {
    const ow = small ? 6 : 9, od = 4;
    const ox0 = ls < 0 ? gx1 + 1 : gx0 - 1 - ow;
    const z1 = zs - 1.2, z0 = z1 - od;
    if (ox0 > -hw + 0.8 && ox0 + ow < hw - 0.8) {
      const fl = small || D < 32 ? 1 : 2;
      bx(mb, ox0, 0, z0, ox0 + ow, fl * 2.9, z1, K.white, PAT.office, { roof: K.roof, m: MAT.plaster });
      bx(mb, ox0 - 0.15, fl * 2.9, z0 - 0.15, ox0 + ow + 0.15, fl * 2.9 + 0.3, z1 + 0.15, K.cap, 0, { roof: K.cap, m: MAT.metal, v: 10 });
      if (fl > 1) wq(mb, 0, z1 + 0.04, ox0, ox0 + ow, 2.75, 3.0, rng.pick(ACC), 0, MAT.none, 10);
      if (!small && z0 - 5 > zG) for (let i = 0; i < 3; i++) if (rng.next() < 0.7) car(mb, ox0 + 1.5 + i * 2.8, z0 - 3.2, Math.PI / 2, rng.pick(CARS));
    }
  }
  // 修理の小屋（鉄骨と半透明の屋根、横は開いている）
  let shedX: [number, number] | null = null;
  if (big && rng.next() < 0.75) {
    const sw = 18, sd = 9.5, sh = 7.5;
    const sx0 = ls < 0 ? hw - 1.5 - sw : -hw + 1.5, sx1 = sx0 + sw;
    const sz1 = zs - 1.0, sz0 = sz1 - sd;
    shedX = [sx0, sx1];
    gq(mb, sx0, sz0, sx1, sz1, 0.11, K.conc);
    for (const x of [sx0 + 0.3, (sx0 + sx1) / 2, sx1 - 0.3]) for (const z of [sz0 + 0.3, sz1 - 0.3]) bx(mb, x - 0.18, 0, z - 0.18, x + 0.18, sh, z + 0.18, K.steel, 0, { m: MAT.metal, roof: null });
    bx(mb, sx0, sh, sz0, sx1, sh + 0.45, sz1, K.steel, 0, { roof: null, m: MAT.metal, v: 10 });
    const keep = mb.matOverride;
    mb.matOverride = MAT.none;
    // 片流れの半透明の屋根（下の面も見える。夜は中の明かりで光る）
    mb.quad([sx0, sh + 0.45, sz1], [sx1, sh + 0.45, sz1], [sx1, sh + 1.3, sz0], [sx0, sh + 1.3, sz0], K.trans);
    mb.quad([sx0, sh + 1.25, sz0], [sx1, sh + 1.25, sz0], [sx1, sh + 0.4, sz1], [sx0, sh + 0.4, sz1], K.trans, PAT.lit);
    mb.matOverride = keep;
    // 奥の壁（波板）と、修理中のコンテナ
    bx(mb, sx0, 0, sz0, sx1, sh, sz0 + 0.15, K.shed, 0, { m: MAT.metal });
    contBlock(mb, { alongX: true, a0: sx0 + 2.9, c0: sz0 + 3.2, lens: [12.19], rows: 1, hts: [[1]], cols: [[[boxCol(rng, rng.int(LINES.length))]]] });
  }
  // ---- 照明塔：通路の奥の端（区画が 1 つなら、ゲートの帯のゲートの反対の角）----
  const mh = big ? 26 + den : 18;
  const yardP: PoolAt = { a: [-hw + 0.5, -hd + 0.5, hw - 0.5, zs], base: K.yard };
  const mast = (x: number, z: number, h: number) => mastT(mb, x, z, h, yardP);
  if (nb >= 2) {
    const am = alongX ? (ls < 0 ? aStart + used - 1.4 : aStart + 1.4) : za + 1.4;
    const [x, z] = toXZ(am, blocks[0].c0 + blocks[0].rows * CW + aisle / 2);
    mast(x, z, mh);
    if (big) {
      if (nb >= 3) {
        const [x2, z2] = toXZ(am, blocks[nb - 2].c0 + blocks[nb - 2].rows * CW + aisle / 2);
        mast(x2, z2, mh);
      } else {
        const mx = shedX ? (ls < 0 ? shedX[0] - 1.6 : shedX[1] + 1.6) : ls < 0 ? xb - 1.5 : xa + 1.5;
        mast(mx, zG + 2.5, mh);
      }
    }
  } else mast(ls < 0 ? xb - 1.0 : xa + 1.0, zs - 1.5, mh);
}

// ---- CFS 上屋 ----
function cfs(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const ls = rng.next() < 0.5 ? -1 : 1; // 横の通路の側
  const strip = 2.5;
  const truckD = D >= 64 ? 16.5 : 15; // 正面のトラックの前庭
  const backD = D >= 64 ? 19 : 14; // 裏のコンテナの前庭
  const zF = hd - strip - truckD, zS = -hd + 1 + backD; // 上屋の正面と裏
  const laneW = 8;
  const xs0 = ls < 0 ? -hw + laneW + 1 : -hw + 2, xs1 = ls < 0 ? hw - 2 : hw - laneW - 1;
  const He = 9 + rng.next() * 1.2, rise = 1.6 + rng.next() * 0.6;
  const wall = rng.pick([K.shed, K.cream, K.shed]);
  const band = rng.pick([C(0x2e6da4), C(0x2e7d5b), C(0x1f4e8c), C(0x0f8a8a)]);
  gq(mb, -hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, K.apron);
  gq(mb, -hw + 0.5, -hd + 0.5, hw - 0.5, zS, 0.09, K.yard, PAT.lit);
  gq(mb, -hw + 0.5, zF, hw - 0.5, hd - strip, 0.09, K.court, PAT.lit);
  const lx0 = ls < 0 ? -hw + 0.5 : xs1 + 0.5, lx1 = ls < 0 ? xs0 - 0.5 : hw - 0.5;
  gq(mb, lx0, zS, lx1, zF, 0.09, K.yard, PAT.lit);
  const gx0 = ls < 0 ? -hw + 1 : hw - 11, gx1 = gx0 + 10;
  siteEdge(mb, rng, tf, W, D, strip, [[gx0, gx1]]);
  booth(mb, (gx0 + gx1) / 2, hd - strip - 4, 0);

  // ---- 上屋（波板の壁、軒の色の帯、コンクリートの腰、低い切妻の金属屋根と天窓の帯）----
  bx(mb, xs0, 0, zS, xs1, He, zF, wall, 0, { roof: null, m: MAT.metal });
  ring4(mb, xs0, zS, xs1, zF, 0, 1.2, K.conc, 0, MAT.concrete, 0.03);
  ring4(mb, xs0, zS, xs1, zF, He - 1.1, He - 0.3, band, 0, MAT.none, 0.05, 10);
  {
    const keep = mb.matOverride;
    mb.matOverride = MAT.metal;
    mb.gableX(xs0, zS, xs1, zF, He, rise, C(0xaab0b6), wall, 0.5);
    mb.matOverride = MAT.none;
    // 天窓の帯（棟にそって、両側の斜面に）
    const zm = (zS + zF) / 2, hz = (zF - zS) / 2;
    for (const sd of [1, -1]) for (const t of [0.25, 0.62]) {
      const za0 = zm + sd * hz * t, za1 = zm + sd * hz * (t + 0.08);
      const y0 = He + rise * (1 - t) + 0.04, y1 = He + rise * (1 - t - 0.08) + 0.04;
      if (sd > 0) mb.quad([xs0 + 2, y1, za1], [xs1 - 2, y1, za1], [xs1 - 2, y0, za0], [xs0 + 2, y0, za0], K.sky, PAT.lit);
      else mb.quad([xs1 - 2, y1, za1], [xs0 + 2, y1, za1], [xs0 + 2, y0, za0], [xs1 - 2, y0, za0], K.sky, PAT.lit);
    }
    mb.matOverride = keep;
    // 雨どい
    for (const z of [zF + 0.45, zS - 0.45]) bx(mb, xs0 - 0.5, He - 0.45, z - 0.22, xs1 + 0.5, He + 0.05, z + 0.22, band, 0, { m: MAT.none, v: 10, roof: K.steelDk });
    // 棟の換気口（細長い箱）
    bx(mb, xs0 + 3, He + rise - 0.1, (zS + zF) / 2 - 0.6, xs1 - 3, He + rise + 0.5, (zS + zF) / 2 + 0.6, C(0xaeb3b8), 0, { m: MAT.metal, v: 10 });
  }
  // 大きな上屋の番号（暗い板に白い数字。妻の面と正面）
  {
    const n = 1 + rng.int(9);
    const ex = ls < 0 ? xs0 : xs1, ed = ls < 0 ? 3 : 1;
    const zc = (zS + zF) / 2;
    wq(mb, ed, ex + sgn(ed) * 0.05, zc - 3, zc + 3, He - 6.2, He - 1.6, K.steelDk, 0, MAT.none, 10);
    digit(mb, ed, ex + sgn(ed) * 0.07, zc - 1.4, He - 5.6, 2.8, 3.4, n, K.white);
    const fx = ls < 0 ? xs0 + 2 : xs1 - 6;
    wq(mb, 0, zF + 0.05, fx, fx + 4, 6.8, He - 1.2, K.steelDk, 0, MAT.none, 10);
    digit(mb, 0, zF + 0.07, fx + 1.0, 7.1, 2.0, He - 1.5 - 7.1, n, K.white);
  }

  // ---- 事務所の棟（2 階、横長の窓）----
  const ow = 11, ox0 = ls < 0 ? xs1 - ow : xs0, ox1 = ox0 + ow;
  bx(mb, ox0, 0, zF, ox1, 8, zF + 5.5, K.white, PAT.ribbon, { roof: K.roof, m: MAT.plaster });
  bx(mb, ox0 - 0.1, 8, zF - 0.1, ox1 + 0.1, 8.5, zF + 5.6, band, 0, { roof: K.cap, m: MAT.none, v: 10 });

  // ---- 正面（トラックの側）：高さ 1m の台、大きなシャッター、深いひさし、羽を上げたウイング車 ----
  {
    const pa = ls < 0 ? xs0 + 0.5 : ox1 + 0.5, pb = ls < 0 ? ox0 - 0.5 : xs1 - 0.5;
    bx(mb, pa, 0, zF, pb, 1.0, zF + 2.6, K.conc, 0, { roof: K.apron, m: MAT.concrete });
    wq(mb, 0, zF + 2.63, pa, pb, 0.1, 0.9, K.black, 0, MAT.none, 10);
    const xs = slots(pa, pb, 5.8, 0.3);
    for (const x of xs) {
      const keep = mb.matOverride;
      mb.matOverride = MAT.metal;
      mb.quad([x + 2.2, 1.0, zF + 0.06], [x + 2.2, 5.5, zF + 0.06], [x - 2.2, 5.5, zF + 0.06], [x - 2.2, 1.0, zF + 0.06], C(0xb9bec3), 0, 4.5, 4.4, 0, 10);
      mb.matOverride = keep;
    }
    // ひさし（下の面は夜に光る）と細い柱
    const cd = 5.2;
    bx(mb, pa, 6.2, zF, pb, 6.55, zF + cd, K.white, 0, { roof: K.roof, bot: K.lamp, bpat: PAT.lit, m: MAT.metal, v: 10 });
    wq(mb, 0, zF + cd + 0.03, pa, pb, 6.22, 6.52, band, 0, MAT.none, 10);
    gq(mb, pa, zF + 2.6, pb, zF + cd, 0.1, K.litGround, PAT.lit);
    for (const x of xs) if (rng.next() < 0.6) vehicle(mb, x, zF + 2.7, Math.PI / 2, rng.next() < 0.45 ? 'wingOpen' : 'wing', rng.pick(ACC), rng.pick(CABS));
  }
  // ---- 裏（コンテナの側）：シール付きのドック、扉の前に後ろからつけたコンテナ ----
  const cd = slots(xs0 + 1, xs1 - 1, 4.6, 0.3);
  const nDock = Math.max(3, cd.length - 3);
  const dockXs = ls < 0 ? cd.slice(cd.length - nDock) : cd.slice(0, nDock);
  dockFace(mb, 2, zS, Math.min(...dockXs) - 2.3, Math.max(...dockXs) + 2.3, dockXs, 1.2, 0, 0, null);
  const roomB = zS - 0.66 - (-hd + 1);
  for (const x of dockXs) {
    if (rng.next() > 0.65) continue;
    const kk: VK = roomB >= 17.6 && rng.next() < 0.5 ? 'cont' : 'contDrop';
    vehicle(mb, x, zS - 0.66, -Math.PI / 2, kk, boxCol(rng, rng.int(LINES.length)), rng.pick(CABS), { c20: rng.next() < 0.2 });
  }
  // 積んだコンテナの山（ドックのない端、2〜3 段）とリーチスタッカー
  {
    const freeA = ls < 0 ? xs0 - 0.5 : Math.max(...dockXs) + 3, freeB = ls < 0 ? Math.min(...dockXs) - 3 : xs1 + 0.5;
    const nPos = Math.floor((freeB - freeA) / 12.3);
    if (nPos >= 1) {
      const rows = Math.min(3, Math.floor((backD - 8) / 2.5));
      const hts: number[][] = [], cols: Col[][][] = [];
      for (let i = 0; i < nPos; i++) {
        hts.push([]);
        cols.push([]);
        for (let r = 0; r < rows; r++) {
          const h = 2 + rng.int(2);
          hts[i].push(h);
          cols[i].push(Array.from({ length: h }, () => boxCol(rng, rng.int(LINES.length))));
        }
      }
      const a0 = ls < 0 ? freeA + 0.5 : freeB - 0.5 - nPos * 12.19;
      contBlock(mb, { alongX: true, a0, c0: -hd + 1.5, lens: Array(nPos).fill(12.19), rows, hts, cols, lit: 2 });
      // リーチスタッカー：山の前から、手前の列の上へコンテナを持ち上げた姿（上屋の壁に当たらないよう、ブームの角度を決める）
      const front = -hd + 1.5 + rows * CW, zc = front - CW / 2;
      let topH = 0;
      for (const h of hts) topH = Math.max(topH, h[rows - 1]);
      let lift = Math.asin(clamp((topH * CH + 4.15 - 3.5) / 12.5, 0, 0.95));
      let zr = zc + 1.4 + 12.5 * Math.cos(lift);
      if (zr > zS - 0.6) {
        zr = zS - 0.6;
        const cl = (zr - zc - 1.4) / 12.5;
        lift = cl > 0.3 ? Math.acos(Math.min(1, cl)) : -1;
      }
      if (lift >= 0 && zr - 8 >= front + 0.2) reachStacker(mb, a0 + nPos * 6.095, zr, -Math.PI / 2, rng.pick(MACH), lift, boxCol(rng, rng.int(LINES.length)));
    }
  }
  // ---- 照明塔（コンテナの側）と、税関の検査の小さなひさし ----
  mastT(mb, ls < 0 ? -hw + 2.5 : hw - 2.5, -hd + 2.5, 24 + den, { a: [-hw + 0.5, -hd + 0.5, hw - 0.5, zS], base: K.yard });
  {
    const ix = ls < 0 ? -hw + 1.2 : hw - 1.2 - 7, iz = zS + 3;
    if (zF - iz > 16) {
      bx(mb, ix, 5, iz, ix + 7, 5.3, iz + 14, K.white, 0, { roof: K.roof, bot: K.lamp, bpat: PAT.lit, m: MAT.metal, v: 10 });
      gq(mb, ix, iz, ix + 7, iz + 14, 0.1, K.litGround, PAT.lit);
      for (const [x, z] of [[ix + 0.3, iz + 0.3], [ix + 6.7, iz + 0.3], [ix + 0.3, iz + 13.7], [ix + 6.7, iz + 13.7]]) bx(mb, x - 0.12, 0, z - 0.12, x + 0.12, 5, z + 0.12, K.steel, 0, { m: MAT.metal, roof: null });
      wq(mb, 0, iz + 14.03, ix, ix + 7, 5.02, 5.28, K.yel, 0, MAT.none, 10);
    }
  }
  pole(mb, ls < 0 ? hw - 1.4 : -hw + 1.4, hd - strip - 1.2, 12, { a: [-hw + 0.5, zF, hw - 0.5, hd - strip], base: K.court });
}

// ---- シャーシプール ----
function chassisPool(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const strip = 2.5;
  const frontD = D >= 48 ? 10 : 9; // 受付と、トラクターの屋根の帯
  const zG = hd - strip - frontD;
  const za = -hd + 1.0;
  const ls = rng.next() < 0.5 ? -1 : 1; // 通路への横の道の側
  gq(mb, -hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, K.apron);
  gq(mb, -hw + 0.5, -hd + 0.5, hw - 0.5, hd - strip, 0.09, K.yard, PAT.lit);
  const gx0 = ls < 0 ? -hw + 1 : hw - 11, gx1 = gx0 + 10;
  siteEdge(mb, rng, tf, W, D, strip, [[gx0, gx1]], true, 10);
  const L = 12.5, pitch = 3.4;
  // 列：奥から「列（頭は +z）、通路、列（頭は -z）」。2 つ目の列は横の道のぶん短い
  const A = zG - za;
  const aisle = clamp(A - 2 * L - 0.6, 8, 15);
  const two = A >= 2 * L + 8 + 0.6;
  const rowsZ: { z: number; head: number; x0: number; x1: number }[] = [];
  rowsZ.push({ z: za + 0.3, head: 1, x0: -hw + 1.2, x1: hw - 1.2 });
  const aisleZ0 = za + 0.3 + L + 0.3;
  if (two) rowsZ.push({ z: aisleZ0 + aisle + L, head: -1, x0: ls < 0 ? -hw + 8.5 : -hw + 1.2, x1: ls < 0 ? hw - 1.2 : hw - 8.5 });
  // 通路の中央の黄色い線
  const aisleMid = two ? aisleZ0 + aisle / 2 : (aisleZ0 + zG) / 2;
  gq(mb, -hw + 2, aisleMid - 0.08, hw - 2, aisleMid + 0.08, 0.11, K.yel);
  for (const row of rowsZ) {
    const xs = slots(row.x0, row.x1, pitch, 0.1);
    // 区画の白線（シャーシの間）
    const zr0 = row.head > 0 ? row.z : row.z - L, zr1 = zr0 + L;
    for (const x of xs) gq(mb, x - pitch / 2 - 0.06, zr0, x - pitch / 2 + 0.06, zr1, 0.11, K.paint);
    gq(mb, xs[xs.length - 1] + pitch / 2 - 0.06, zr0, xs[xs.length - 1] + pitch / 2 + 0.06, zr1, 0.11, K.paint);
    gq(mb, row.x0, row.head > 0 ? zr1 - 0.06 : zr0 - 0.06, row.x1, row.head > 0 ? zr1 + 0.06 : zr0 + 0.06, 0.11, K.paint);
    for (const x of xs) {
      const r = rng.next();
      if (r < 0.08) continue;
      const fc = rng.next() < 0.14 ? FRAME[0] : rng.next() < 0.1 ? FRAME[1] : K.chassis;
      const ang = row.head > 0 ? Math.PI / 2 : -Math.PI / 2;
      if (r < 0.2 + den * 0.07) vehicle(mb, x, row.z, ang, 'contDrop', boxCol(rng, rng.int(LINES.length)), K.white, { frame: fc, c20: rng.next() < 0.25 });
      else vehicle(mb, x, row.z, ang, 'chassis', K.white, K.white, { frame: fc });
    }
  }
  // 通路で、シャーシをつないでいるトラクター
  {
    const x = -hw + 6 + rng.next() * (W - 26);
    vehicle(mb, x, aisleMid - 1.3, 0, rng.next() < 0.5 ? 'cont' : 'tractor', boxCol(rng, rng.int(LINES.length)), rng.pick(CABS));
  }
  // ---- 前の帯：トラクターの屋根（3〜4 台）、受付の小屋、照明 ----
  {
    const zs = hd - strip;
    const n = W >= 48 ? 4 : 2;
    const cw = n * 4.4;
    const cx0 = ls < 0 ? hw - 1.5 - cw : -hw + 1.5, cx1 = cx0 + cw;
    const cz0 = zs - frontD + 1.5, cz1 = cz0 + Math.min(7.6, frontD - 2);
    bx(mb, cx0, 4.6, cz0, cx1, 4.9, cz1, K.white, 0, { roof: K.roof, bot: K.lamp, bpat: PAT.lit, m: MAT.metal, v: 10 });
    gq(mb, cx0, cz0, cx1, cz1, 0.1, K.litGround, PAT.lit);
    for (const x of [cx0 + 0.3, cx1 - 0.3]) for (const z of [cz0 + 0.3, cz1 - 0.3]) bx(mb, x - 0.12, 0, z - 0.12, x + 0.12, 4.6, z + 0.12, K.steel, 0, { m: MAT.metal, roof: null });
    for (let i = 0; i < n; i++) {
      const x = cx0 + 2.2 + i * 4.4;
      gq(mb, x + 2.14, cz0, x + 2.26, cz1, 0.11, K.paint);
      if (rng.next() < 0.75) vehicle(mb, x, cz0 + 0.6, Math.PI / 2, 'tractor', K.white, rng.pick(CABS));
    }
    // 受付の小屋（窓と小さなひさし）
    const kx = ls < 0 ? gx1 + 1.5 : gx0 - 7.5;
    if (kx + 7 < cx0 || kx - 1 > cx1) {
      bx(mb, kx, 0, zs - 5.5, kx + 6, 3.1, zs - 1.5, K.white, PAT.office, { roof: K.roof, m: MAT.plaster });
      bx(mb, kx - 0.3, 3.1, zs - 6.8, kx + 6.3, 3.35, zs - 1.2, rng.pick(ACC), 0, { roof: K.cap, m: MAT.none, v: 10 });
    }
  }
  // 照明柱（通路にそって）
  const yp: PoolAt = { a: [-hw + 0.5, -hd + 0.5, hw - 0.5, hd - strip], base: K.yard };
  for (const x of slots(-hw + 2, hw - 2, 28)) pole(mb, x, two ? aisleMid + 0.9 : zG + 1, 14, yp);
}

LOGI.coldStorage = coldStorage;
LOGI.containerYard = containerYard;
