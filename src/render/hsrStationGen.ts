// 高速鉄道の駅と、駅前広場・バスターミナルの形（敷地の座標。x = 線路の向き、z = 横。buildingGen から呼ぶ）。
// 駅は空港と同じ木とガラスの雰囲気。屋根は波型ではなく、すっきりした箱型：ホームを覆う箱型のガラス屋根（木の天井・細い柱）、
// 駅舎も木とガラスの箱。両側の長い辺に出入口と庇。線路・床版・副本線は hsrLayer が描く。
import * as THREE from 'three';
import { MeshBuilder, PAT } from './builder';
import { MAT } from './textures';
import { CELL } from '../sim/constants';
import { HSR_LIFT, HSR_TRACK, HSR_PLAT, type HsrStn } from '../sim/hsr';
import type { Rng } from '../sim/rng';

type TF = (lx: number, lz: number, s?: number, kind?: number, y?: number, col?: number, shape?: number) => void;
type F = { W: number; D: number; base: number };
const C = (h: number) => new THREE.Color(h);
const COL = {
  glass: C(0x6f93ad), roofGlass: C(0x7c9db0), wood: C(0xb07a48), woodDark: C(0x7a5232), steel: C(0xdfe3e6), steelDark: C(0x7c8288),
  stone: C(0xcfcac0), stone2: C(0xbdb7ab), plat: C(0xd3cdbf), edge: C(0xe9b72a), concrete: C(0xc4c0b6), asph: C(0x3a3c40),
  white: C(0xf1f1ec), sign: C(0x1f4f9a), dark: C(0x2a2f36), lawn: C(0x76a050), water: C(0x5d93b0), bench: C(0x8a6a4a),
  taxi: C(0x1d2340), taxiTop: C(0xf2c94c), bus: C(0xe8ecee), busBand: C(0x1d6b86),
};

// 木の面（板張りの模様。夜は照らされて温かく光る）
function wood(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, lit = true, col = COL.wood) {
  const k = mb.matOverride;
  mb.matOverride = MAT.siding;
  mb.box(x0, y0, z0, x1, y1, z1, col, lit ? PAT.lit : 0);
  mb.matOverride = k;
}
// 下を向いた木の天井
function soffit(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number) {
  const k = mb.matOverride;
  mb.matOverride = MAT.siding;
  mb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], COL.woodDark, PAT.lit);
  mb.matOverride = k;
}
// 箱型の屋根：上はガラス（木の梁が並ぶ）、まわりは木の鼻隠し、下は木の天井
function boxRoof(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, th = 1.3) {
  soffit(mb, x0, z0, x1, z1, y);
  wood(mb, x0, y, z0, x1, y + th, z0 + 0.4);
  wood(mb, x0, y, z1 - 0.4, x1, y + th, z1);
  wood(mb, x0, y, z0, x0 + 0.4, y + th, z1);
  wood(mb, x1 - 0.4, y, z0, x1, y + th, z1);
  const k = mb.matOverride;
  mb.matOverride = MAT.none;
  mb.quad([x0 + 0.4, y + th - 0.25, z1 - 0.4], [x1 - 0.4, y + th - 0.25, z1 - 0.4], [x1 - 0.4, y + th - 0.25, z0 + 0.4], [x0 + 0.4, y + th - 0.25, z0 + 0.4], COL.roofGlass);
  mb.matOverride = k;
  // ガラスの上の木の梁（8m おき）
  for (let x = x0 + 8; x < x1 - 4; x += 8) wood(mb, x - 0.25, y + th - 0.25, z0 + 0.4, x + 0.25, y + th + 0.05, z1 - 0.4, false);
}
// 木とガラスの箱（壁はガラス、上の帯は木）
function glassBox(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number) {
  mb.box(x0, y0, z0, x1, y1 - 0.9, z1, COL.glass, PAT.terminal, COL.concrete);
  // 上の木の帯（まわりだけ。屋上はコンクリート）
  wood(mb, x0 - 0.15, y1 - 0.9, z0 - 0.15, x1 + 0.15, y1, z0 + 0.6);
  wood(mb, x0 - 0.15, y1 - 0.9, z1 - 0.6, x1 + 0.15, y1, z1 + 0.15);
  wood(mb, x0 - 0.15, y1 - 0.9, z0 + 0.6, x0 + 0.6, y1, z1 - 0.6);
  wood(mb, x1 - 0.6, y1 - 0.9, z0 + 0.6, x1 + 0.15, y1, z1 - 0.6);
  mb.box(x0 + 0.6, y1 - 0.95, z0 + 0.6, x1 - 0.6, y1 - 0.75, z1 - 0.6, COL.concrete);
}
// 出入口：庇（上はガラス、下は木の天井、細い鋼の柱）と、光る駅名の帯、扉
function entrance(mb: MeshBuilder, side: number, zf: number, cx: number, half: number, y: number) {
  const z0 = side > 0 ? zf : zf - 6.5, z1 = side > 0 ? zf + 6.5 : zf;
  boxRoof(mb, cx - half, z0, cx + half, z1, y, 0.7);
  const zo = side > 0 ? z1 - 0.6 : z0 + 0.6;
  for (const x of [cx - half + 1, cx + half - 1]) mb.cylinder(x, zo, 0, y, 0.16, 8, COL.steel);
  mb.box(cx - 7, y + 1.1, zf - 0.05, cx + 7, y + 2.0, zf + 0.05, COL.sign, PAT.glow);
  for (let x = cx - half + 4; x < cx + half - 3; x += 5) mb.box(x - 1.4, 0, zf - 0.06, x + 1.4, 2.8, zf + 0.06, COL.dark);
}

// 高速鉄道の駅（14×4 マス）
export function hsrStation(mb: MeshBuilder, f: F, s: HsrStn | undefined, tf: TF) {
  const W = f.W, D = f.D;
  const tz = s ? (s.row - 1.5) * CELL : -CELL / 2;
  const dk = s ? s.deck - f.base : HSR_LIFT;
  const elevated = dk > 4;
  const PT = dk + 1.1; // ホームの床
  const RY = PT + 9.5; // 屋根の下の面
  const pz0 = HSR_PLAT + 1.8, pz1 = HSR_PLAT + 8.0; // 線路の中心からホームの内側・外側まで
  const xa = -W / 2 + 2, xb = W / 2 - 2;
  // 敷地の舗装
  mb.ground(-W / 2 + 0.2, -D / 2 + 0.2, W / 2 - 0.2, D / 2 - 0.2, 0.08, COL.stone);
  // ホーム（両側。止まる列車は外側の副本線に入る）
  for (const sd of [-1, 1]) {
    const z0 = tz + sd * pz0, z1 = tz + sd * pz1;
    const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
    mb.box(xa, elevated ? PT - 0.9 : 0, lo, xb, PT, hi, COL.plat, 0, COL.plat, true);
    const e = tz + sd * (pz0 + 0.45);
    mb.box(xa, PT, Math.min(e, tz + sd * pz0), xb, PT + 0.03, Math.max(e, tz + sd * pz0), COL.edge);
    // 外側の低いガラスの風よけ
    const zo = tz + sd * (pz1 - 0.1);
    mb.box(xa, PT, zo - 0.06, xb, PT + 2.4, zo + 0.06, COL.glass, PAT.terminal);
    // 屋根の細い柱（ホームの上、16m おき）と、ベンチ・発車標
    for (let x = xa + 8; x < xb - 4; x += 16) {
      mb.cylinder(x, tz + sd * (pz1 - 1.6), PT, RY, 0.28, 8, COL.steel);
      mb.box(x + 3, PT, tz + sd * (pz0 + 3.2) - 0.3, x + 5, PT + 0.45, tz + sd * (pz0 + 3.2) + 0.3, COL.bench);
    }
    mb.box(-3, PT + 3.2, tz + sd * (pz0 + 2.5) - 0.12, 3, PT + 3.9, tz + sd * (pz0 + 2.5) + 0.12, COL.dark, PAT.glow);
    if (elevated) {
      // ホームを支える柱
      for (let x = xa + 6; x < xb - 2; x += 16) mb.cylinder(x, tz + sd * (pz1 - 2.5), 0, PT - 0.9, 0.55, 10, COL.concrete);
      // コンコースからホームへのエスカレーターとエレベーター（ガラスの箱）
      for (const x of [-W / 4, W / 4]) mb.box(x - 5, 8, tz + sd * (pz0 + 1.6) - 1.3, x + 5, PT + 3.2, tz + sd * (pz0 + 1.6) + 1.3, COL.glass, PAT.terminal, COL.steel);
    }
  }
  // ホームと線路を覆う箱型のガラス屋根（木の天井）
  boxRoof(mb, -W / 2 + 1, tz - pz1 - 1.5, W / 2 - 1, tz + pz1 + 1.5, RY, 1.5);
  // 駅舎（木とガラスの箱）と、両側の出入口
  const zA = -D / 2 + 1.5, zB = D / 2 - 1.5;
  if (elevated) {
    // 高架の下のコンコース（敷地の端から端まで。両側の長い辺が出入口）
    glassBox(mb, -38, zA, 38, zB, 0, 8);
    for (const x of [-26, 26]) mb.cylinder(x, tz, 8, dk - 2.4, 1.3, 12, COL.concrete);
    // コンコースの外は、高架橋の柱
    for (let x = xa + 8; x < xb; x += 32) if (Math.abs(x) > 42) mb.cylinder(x, tz, 0, dk - 2.4, 1.3, 12, COL.concrete);
  } else {
    // 地上の駅：線路の両側の駅舎と、線路をまたぐガラスの通路
    for (const [z0, z1] of [[zA, tz - pz1 - 1], [tz + pz1 + 1, zB]]) if (z1 - z0 > 3.5) glassBox(mb, -38, z0, 38, z1, 0, 8);
    mb.box(-6, PT + 5.2, zA + 1, 6, PT + 8.6, zB - 1, COL.glass, PAT.terminal, COL.concrete, true);
    wood(mb, -6.2, PT + 8.6, zA + 1, 6.2, PT + 9.2, zB - 1);
  }
  entrance(mb, 1, zB, 0, 16, 5.4);
  entrance(mb, -1, zA, 0, 16, 5.4);
  // 敷地の両端の植え込み
  for (const x of [-W / 2 + 10, W / 2 - 10]) for (const z of [zA + 3, zB - 3]) tf(x, z, 1.0, 0);
}

// 駅前広場・バスターミナル（10×4 マス）。+z が道路の側
export function hsrPlaza(mb: MeshBuilder, f: F, rng: Rng, tf: TF) {
  const W = f.W, D = f.D;
  mb.ground(-W / 2 + 0.2, -D / 2 + 0.2, W / 2 - 0.2, D / 2 - 0.2, 0.08, COL.stone);
  // バス乗り場：道路側の車線と、のりばの島（木とガラスの屋根）
  const lane0 = D / 2 - 13, lane1 = D / 2 - 1;
  mb.ground(-W / 2 + 4, lane0, W / 2 - 34, lane1, 0.1, COL.asph);
  for (let x = -W / 2 + 10; x < W / 2 - 40; x += 18) {
    mb.ground(x, lane0 + 0.6, x + 0.25, lane0 + 4, 0.12, COL.white);
    // 止まっているバス
    if (rng.next() < 0.7) {
      mb.box(x + 2, 0.4, lane0 + 1.2, x + 14, 3.3, lane0 + 3.7, COL.bus, PAT.ribbon, COL.white);
      mb.box(x + 2, 0.9, lane0 + 1.15, x + 14, 1.2, lane0 + 3.75, COL.busBand);
    }
  }
  const iz0 = lane0 - 5, iz1 = lane0 - 0.4;
  mb.box(-W / 2 + 4, 0, iz0, W / 2 - 34, 0.25, iz1, COL.stone2);
  boxRoof(mb, -W / 2 + 6, iz0 + 0.5, W / 2 - 36, iz1 + 0.3, 3.6, 0.6);
  for (let x = -W / 2 + 10; x < W / 2 - 36; x += 12) for (const z of [iz0 + 1.2]) mb.cylinder(x, z, 0.25, 3.6, 0.13, 6, COL.steel);
  // タクシー乗り場（端）
  const tx0 = W / 2 - 32, tx1 = W / 2 - 2;
  mb.ground(tx0, lane0 - 4, tx1, lane1, 0.1, COL.asph);
  for (let k = 0; k < 4; k++) {
    const z = lane0 - 2.5 + k * 3.6;
    mb.ground(tx0 + 2, z + 1.6, tx1 - 2, z + 1.75, 0.12, COL.white);
    if (k < 3) {
      const x = tx0 + 6 + k * 7;
      mb.box(x, 0.3, z - 0.95, x + 4.4, 1.25, z + 0.95, COL.taxi);
      mb.box(x + 1.0, 1.25, z - 0.8, x + 3.4, 1.75, z + 0.8, COL.dark);
      mb.box(x + 2.0, 1.75, z - 0.2, x + 2.5, 2.0, z + 0.2, COL.taxiTop, PAT.glow);
    }
  }
  boxRoof(mb, tx0 + 1, lane0 - 6.5, tx1 - 1, lane0 - 4.2, 3.4, 0.5);
  // 広場（駅の側）：植え込みと木、水盤、時計の塔、ベンチ
  const pz0 = -D / 2 + 2, pz1 = iz0 - 2;
  for (let x = -W / 2 + 12; x < W / 2 - 8; x += 22) {
    mb.box(x - 4, 0, pz0 + 4, x + 4, 0.5, pz0 + 10, COL.stone2, 0, COL.lawn);
    tf(x, pz0 + 7, 0.9 + rng.next() * 0.25, 0);
    mb.box(x + 6, 0, pz1 - 2, x + 9, 0.45, pz1 - 1.4, COL.bench);
  }
  mb.box(-14, 0, pz0 + 13, 14, 0.35, pz0 + 19, COL.stone2);
  mb.box(-13.4, 0.35, pz0 + 13.6, 13.4, 0.4, pz0 + 18.4, COL.water);
  wood(mb, 20, 0, pz0 + 14, 22.4, 11, pz0 + 16.4, false);
  mb.box(19.8, 11, pz0 + 13.8, 22.6, 13.4, pz0 + 16.6, COL.glass, PAT.terminal, COL.wood);
  void HSR_TRACK;
}
