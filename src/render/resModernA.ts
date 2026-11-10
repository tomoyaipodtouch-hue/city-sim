// 近代的なマンションの形（A）。resRegistry の RES に登録する
// 敷地の座標：x は -W/2..W/2、z は -D/2..D/2、+z が道路の側（正面）、y = 0 が敷地の地面。
// buildingGen から読み込まれるので、buildingGen は型だけ読み込む（実行時に読み込むと循環する）
//  ribbonWhite      … 白い箱と横に長い連続窓。角はガラス、1階はピロティ（細い柱、奥まったガラスの玄関、下は駐車場と庭）
//  rawConcrete      … 打ち放しコンクリートとガラス（日本のデザイナーズマンション）。深く奥まった大きな窓、
//                      コンクリートの縦のひれ、または深いバルコニーの格子。ところどころ木
//  staggeredBalcony … 白いバルコニーの板が階ごとに左右へずれる（濃い色の本体、ガラスの手すり、木の軒裏）
//  timberLouver     … ガラスの本体に縦の木のルーバー（深さが波のように変わる）。白い床の帯
import * as THREE from 'three';
import { PAT } from './builder';
import type { MeshBuilder } from './builder';
import { MAT } from './textures';
import type { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';
import { RES } from './resRegistry';

const C = (h: number) => new THREE.Color(h);
const FH = 3.1; // 住宅の階高
// 窓の模様の 1 階ぶんの長さ（シェーダー）。住宅の階高 3.1m に合わせて縦にのばす
const VS_CURTAIN = 3.7 / FH, VS_FULL = 3.8 / FH;

const K = {
  lawn: C(0x6e9a4a), lawn2: C(0x7aa553), pave: C(0x9c9b96), paveLt: C(0xb7b3aa), gravel: C(0xa9a59b), asphalt: C(0x3d3f42),
  line: C(0xf0f0ea), hedge: C(0x3e6b2f), curb: C(0xc9c5bc), roof: C(0xb5b2aa), unit: C(0xb9bdc2), fan: C(0x3a3d42),
  cap: C(0xd6d3cb), door: C(0x3a3f45), glow: C(0xe8f0f6), lamp: C(0xfff0cf), rail: C(0x9db7c2), railLt: C(0xc6d7dd), railDk: C(0x7f9fb3),
  lobby: C(0x7fa6c4), steel: C(0x7a8088), soffit: C(0xd9dad8),
};
const CARS = [0xd8d8d8, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xf2f2f2, 0x3b5d3a, 0xb8bcc0, 0x101820].map(C);
const WOODS = [0xa8774a, 0xb88a5a, 0x8f6440, 0xc39a6b, 0x9a6b42].map(C);
const ROOFS = [0xb5b2aa, 0xa6a39c, 0xc4c1b9, 0x9b9891].map(C);

// ---------------- 部品 ----------------
// 箱。壁の模様の縦の座標は「vb からの高さ × vs」（窓の帯を階にそろえる）。skip = 描かない壁（1 = +z、2 = -z、4 = +x、8 = -x）
interface BO { roof?: THREE.Color | null; bot?: THREE.Color; m?: number; rm?: number; skip?: number; vs?: number; vb?: number }
function bx(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: THREE.Color, pat = 0, o: BO = {}) {
  const vs = o.vs ?? 1, vb = o.vb ?? 0;
  const h = (y1 - y0) * vs, v0 = (y0 - vb) * vs, wx = x1 - x0, wz = z1 - z0, keep = mb.matOverride, sk = o.skip ?? 0;
  if (o.m !== undefined) mb.matOverride = o.m;
  if (!(sk & 1)) mb.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], wall, pat, wx, h, 0, v0);
  if (!(sk & 2)) mb.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], wall, pat, wx, h, 0, v0);
  if (!(sk & 4)) mb.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], wall, pat, wz, h, 0, v0);
  if (!(sk & 8)) mb.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], wall, pat, wz, h, 0, v0);
  mb.matOverride = o.rm !== undefined ? o.rm : keep;
  if (o.roof !== null) mb.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], o.roof ?? wall, 0);
  mb.matOverride = keep;
  if (o.bot) mb.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], o.bot, 0);
}
// 縦の細い板（ルーバー・ひれ）：正面と両側の 3 面だけ（裏・上下は見えない）。n = 外向きの向き（1 = +z、-1 = -z、2 = +x、-2 = -x）
function slat(mb: MeshBuilder, n: number, a: number, b: number, s: number, dep: number, y0: number, y1: number, col: THREE.Color) {
  // a..b = 面に沿った幅、s = 面の位置、dep = 外への出
  if (n === 1) {
    const z0 = s, z1 = s + dep;
    mb.quad([a, y0, z1], [b, y0, z1], [b, y1, z1], [a, y1, z1], col);
    mb.quad([b, y0, z1], [b, y0, z0], [b, y1, z0], [b, y1, z1], col);
    mb.quad([a, y0, z0], [a, y0, z1], [a, y1, z1], [a, y1, z0], col);
  } else if (n === -1) {
    const z0 = s - dep, z1 = s;
    mb.quad([b, y0, z0], [a, y0, z0], [a, y1, z0], [b, y1, z0], col);
    mb.quad([b, y0, z1], [b, y0, z0], [b, y1, z0], [b, y1, z1], col);
    mb.quad([a, y0, z0], [a, y0, z1], [a, y1, z1], [a, y1, z0], col);
  } else if (n === 2) {
    const x0 = s, x1 = s + dep;
    mb.quad([x1, y0, b], [x1, y0, a], [x1, y1, a], [x1, y1, b], col);
    mb.quad([x0, y0, b], [x1, y0, b], [x1, y1, b], [x0, y1, b], col);
    mb.quad([x1, y0, a], [x0, y0, a], [x0, y1, a], [x1, y1, a], col);
  } else {
    const x0 = s - dep, x1 = s;
    mb.quad([x0, y0, a], [x0, y0, b], [x0, y1, b], [x0, y1, a], col);
    mb.quad([x0, y0, b], [x1, y0, b], [x1, y1, b], [x0, y1, b], col);
    mb.quad([x1, y0, a], [x0, y0, a], [x0, y1, a], [x1, y1, a], col);
  }
}
// 屋上のふち（パラペット）
function rim(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, wall: THREE.Color, h = 1.0, t = 0.3, cap = K.cap, m: number = MAT.plaster) {
  const o: BO = { roof: cap, m, rm: MAT.none };
  bx(mb, x0, y, z1 - t, x1, y + h, z1, wall, 0, o);
  bx(mb, x0, y, z0, x1, y + h, z0 + t, wall, 0, o);
  bx(mb, x0, y, z0 + t, x0 + t, y + h, z1 - t, wall, 0, o);
  bx(mb, x1 - t, y, z0 + t, x1, y + h, z1 - t, wall, 0, o);
}
// ガラスの手すり（屋上のふち）
function glassRim(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, h = 1.1) {
  const t = 0.08;
  bx(mb, x0, y, z1 - t, x1, y + h, z1, K.railLt);
  bx(mb, x0, y, z0, x1, y + h, z0 + t, K.railLt);
  bx(mb, x0, y, z0 + t, x0 + t, y + h, z1 - t, K.railLt);
  bx(mb, x1 - t, y, z0 + t, x1, y + h, z1 - t, K.railLt);
}
// 屋上の機械：階段室（エレベーターの機械室）と室外機。奥（-z）に寄せて、道路から目立たないように
function roofKit(mb: MeshBuilder, rng: Rng, x0: number, z0: number, x1: number, z1: number, y: number, wall: THREE.Color, m: number = MAT.plaster) {
  const W = x1 - x0, D = z1 - z0;
  if (W < 5 || D < 4) return;
  const sw = Math.min(W * 0.35, 4 + rng.next() * 2), sd = Math.min(D * 0.55, 4.5 + rng.next() * 1.5);
  const sx = rng.next() < 0.5 ? x0 + 1.2 + rng.next() * Math.max(0.1, W * 0.5 - sw - 1.2) : x1 - 1.2 - sw - rng.next() * Math.max(0.1, W * 0.5 - sw - 1.2);
  const sz = z0 + 1.0;
  bx(mb, sx, y, sz, sx + sw, y + 3.2, sz + sd, wall, 0, { roof: K.roof, m, rm: MAT.membrane });
  bx(mb, sx + sw / 2 - 0.5, y, sz + sd, sx + sw / 2 + 0.5, y + 2.2, sz + sd + 0.05, K.door, 0, { m: MAT.metal });
  // 室外機（ファンつき）を 1 列
  const n = Math.max(1, Math.min(4, Math.floor((W - sw - 4) / 3)));
  const ux0 = sx < (x0 + x1) / 2 ? sx + sw + 1.5 : x0 + 1.5;
  const uz = z0 + 1.0 + rng.next() * Math.max(0.1, D * 0.4 - 1.6);
  for (let i = 0; i < n; i++) {
    const ux = ux0 + i * 2.8;
    if (ux + 2.2 > x1 - 0.8) break;
    bx(mb, ux, y, uz, ux + 2.2, y + 1.2, uz + 1.4, K.unit, 0, { m: MAT.metal });
    mb.cylinder(ux + 0.65, uz + 0.7, y + 1.2, y + 1.25, 0.5, 8, K.fan, K.fan);
    mb.cylinder(ux + 1.55, uz + 0.7, y + 1.2, y + 1.25, 0.5, 8, K.fan, K.fan);
  }
}
// 駐車中の車
function car(mb: MeshBuilder, x: number, z: number, rng: Rng, alongZ = true) {
  const c = rng.pick(CARS), g = C(0x26303a);
  const L = 4.3, Wd = 1.8;
  const [hx, hz] = alongZ ? [Wd / 2, L / 2] : [L / 2, Wd / 2];
  bx(mb, x - hx, 0.25, z - hz, x + hx, 0.95, z + hz, c, 0, { m: MAT.metal });
  const [cx, cz] = alongZ ? [hx * 0.9, hz * 0.5] : [hx * 0.5, hz * 0.9];
  bx(mb, x - cx, 0.95, z - cz, x + cx, 1.45, z + cz, g, 0, { roof: c, m: MAT.none, rm: MAT.metal });
}

// ---------------- 建物の大きさ ----------------
interface FP { x0: number; x1: number; z0: number; z1: number; floors: number; tower: boolean }
// 敷地に置く棟の平面。中層は横長の板状、高層は細めの塔。細すぎる塔にならないよう、階数を幅に合わせて抑える
function plan(f: LotFrame, rng: Rng, floors: number, o: { slender?: number; maxW?: number; maxD?: number; minD?: number } = {}): FP {
  const tower = floors >= 9;
  const small = Math.min(f.W, f.D) < 24;
  const front = small ? 3.2 : tower ? 6 : 4, back = small ? 2.2 : tower ? 4 : 3, side = small ? 1.4 : tower ? 3.5 : 2;
  let w = f.W - 2 * side, d = f.D - front - back;
  if (!tower) d = Math.min(d, (o.minD ?? 11) + rng.next() * 4);
  else {
    w = Math.min(w, (o.maxW ?? 30) + rng.next() * 4);
    d = Math.min(d, (o.maxD ?? 21) + rng.next() * 4);
    // 高い塔ほど少し細く
    if (floors > 30) { w *= 0.92; d *= 0.95; }
  }
  w = Math.max(8, w); d = Math.max(7, d);
  // 細長くなりすぎない高さ（短い辺の slender 倍まで）
  const maxH = Math.min(w, d) * (o.slender ?? 7.5);
  const fl = tower ? Math.max(9, Math.min(floors, Math.floor(maxH / FH))) : floors;
  const z1 = f.D / 2 - front;
  return { x0: -w / 2, x1: w / 2, z0: z1 - d, z1, floors: fl, tower };
}

// 敷地：芝生、道路ぞいの歩道、玄関へのアプローチ、建物のまわりの砂利、木と生け垣
function site(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, p: FP, ex: number, ew: number, trees = true) {
  const W = f.W, D = f.D;
  mb.ground(-W / 2 + 0.2, -D / 2 + 0.2, W / 2 - 0.2, D / 2 - 0.2, 0.06, rng.next() < 0.5 ? K.lawn : K.lawn2);
  mb.ground(p.x0 - 0.9, p.z0 - 0.9, p.x1 + 0.9, p.z1 + 0.9, 0.08, K.gravel);
  mb.ground(-W / 2 + 0.2, D / 2 - 1.8, W / 2 - 0.2, D / 2 - 0.2, 0.1, K.pave);
  mb.ground(ex - ew / 2, p.z1, ex + ew / 2, D / 2 - 1.8, 0.11, K.paveLt);
  // 正面の生け垣（玄関の道をあける）
  const hz = D / 2 - 2.6;
  if (hz - p.z1 > 1.6) {
    const a = ex - ew / 2 - 0.6, b = ex + ew / 2 + 0.6;
    if (a - (-W / 2 + 1) > 2) bx(mb, -W / 2 + 1, 0, hz - 0.6, a, 0.9, hz, K.hedge);
    if (W / 2 - 1 - b > 2) bx(mb, b, 0, hz - 0.6, W / 2 - 1, 0.9, hz, K.hedge);
  }
  if (!trees) return;
  // 木：正面の両すみ、裏庭（あれば）
  const fz = (p.z1 + D / 2 - 1.8) / 2;
  if (D / 2 - 1.8 - p.z1 > 2.5) {
    tf(-W / 2 + 2, fz, 0.75 + rng.next() * 0.25);
    tf(W / 2 - 2, fz, 0.75 + rng.next() * 0.25);
  } else {
    tf(-W / 2 + 1.4, D / 2 - 1.2, 0.65);
    tf(W / 2 - 1.4, D / 2 - 1.2, 0.65);
  }
  const by = p.z0 - (-D / 2);
  if (by > 5) {
    const n = Math.max(1, Math.round((W - 4) / 8));
    for (let i = 0; i < n; i++) tf(-W / 2 + 3 + ((W - 6) * (i + rng.next() * 0.6)) / n, -D / 2 + 1.5 + rng.next() * Math.min(by - 3.5, 6), 0.8 + rng.next() * 0.4, rng.next() < 0.3 ? 1 : 0);
  }
  if (p.x0 - (-W / 2) > 3.5) tf(-W / 2 + 1.8, (p.z0 + p.z1) / 2, 0.8, 1);
  if (W / 2 - p.x1 > 3.5) tf(W / 2 - 1.8, (p.z0 + p.z1) / 2 - 2, 0.8, 1);
}

// 正面（+z）の柱の位置を均等に割る
function spans(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.round((b - a) / step)), out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

// ======================================================================
// A. 白い箱と横に長い連続窓
// ======================================================================
const WHITES = [0xf3f3f0, 0xeeeeea, 0xf4f1ea, 0xe9ebec, 0xf0efe9].map(C);
const DARK_GLASS = [0x2f3a44, 0x3a4550, 0x34404a, 0x45525c, 0x3b4a48, 0x3d4652].map(C);
function ribbonWhite(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors0: number) {
  const p = plan(f, rng, floors0, { slender: 7, maxW: 30, maxD: 20 });
  const { x0, x1, z0, z1, floors, tower } = p;
  const white = rng.pick(WHITES), glass = rng.pick(DARK_GLASS), soff = white.clone().multiplyScalar(0.93);
  const gh = tower ? 6.2 : floors <= 4 ? 3.6 : 4.2; // ピロティの高さ
  const n = floors - 1, H = gh + n * FH;
  const ins = 0.4; // 窓の奥まり
  const vb = gh - 2 * FH;
  const bandLo = 0.35 + rng.next() * 0.25, bandHi = 0.85 + rng.next() * 0.3;
  const lobbyLeft = rng.next() < 0.5;
  const w = x1 - x0, d = z1 - z0;
  // ---- 地面と1階（ピロティ） ----
  const lw = Math.max(5, Math.min(w * 0.42, 14));
  const lx0 = lobbyLeft ? x0 + 0.8 : x1 - 0.8 - lw, lx1 = lx0 + lw;
  const ex = (lx0 + lx1) / 2;
  site(mb, f, rng, tf, p, ex, 3);
  // ピロティの下：駐車場（アスファルトと白線）と車
  const px0 = lobbyLeft ? lx1 + 0.6 : x0 + 0.4, px1 = lobbyLeft ? x1 - 0.4 : lx0 - 0.6;
  if (px1 - px0 > 3) {
    mb.ground(px0, z0 + 0.4, px1, f.D / 2 - 1.8, 0.1, K.asphalt);
    const nst = Math.floor((px1 - px0) / 2.6);
    for (let i = 0; i <= nst; i++) mb.ground(px0 + 0.2 + i * 2.6, z1 - 5.6, px0 + 0.32 + i * 2.6, z1 - 0.4, 0.12, K.line);
    for (let i = 0; i < nst; i++) if (rng.next() < 0.55) car(mb, px0 + 1.46 + i * 2.6, z1 - 3, rng);
    if (d > 13) for (let i = 0; i < nst; i++) {
      mb.ground(px0 + 0.2 + i * 2.6, z0 + 0.4, px0 + 0.32 + i * 2.6, z0 + 5.4, 0.12, K.line);
      if (rng.next() < 0.4) car(mb, px0 + 1.46 + i * 2.6, z0 + 3, rng);
    }
  }
  // 奥まったガラスの玄関ホール（夜は明るい）と、白い階段室
  bx(mb, lx0, 0, z0 + 1.2, lx1, gh - 0.5, z1 - 1.6, K.lobby, PAT.fullglass, { roof: null, m: MAT.none, vs: VS_FULL });
  bx(mb, lx0 + 0.6, 0, z0 + 0.6, lx1 - 0.6, gh - 0.5, z0 + 1.2, white, 0, { roof: null, m: MAT.plaster });
  bx(mb, ex - 1.1, 0, z1 - 1.62, ex + 1.1, 2.5, z1 - 1.58, K.door, 0, { m: MAT.metal });
  // 細い丸い柱（ピロティ）
  const r = tower ? 0.38 : 0.22;
  const xs = spans(x0 + 0.6, x1 - 0.6, tower ? 7 : 5.6), zs = spans(z0 + 0.6, z1 - 0.6, 6.5);
  for (const x of xs) for (const z of [zs[0], zs[zs.length - 1], ...(d > 14 ? zs.slice(1, -1) : [])]) {
    if (x > lx0 - 0.3 && x < lx1 + 0.3 && z > z0 + 1 && z < z1 - 1.4) continue;
    mb.cylinder(x, z, 0, gh - 0.5, r, 10, white, undefined);
  }
  // 軒裏の照明（夜に光る細い帯）
  bx(mb, x0 + 0.6, gh - 0.62, z1 - 0.7, x1 - 0.6, gh - 0.5, z1 - 0.5, K.glow, PAT.glow, { roof: null });
  // ---- 上の階：奥まった黒いガラスの帯と、白い横の帯 ----
  bx(mb, x0 + ins, gh, z0 + ins, x1 - ins, H, z1 - ins, glass, PAT.curtain, { roof: null, m: MAT.none, vs: VS_CURTAIN, vb });
  for (let k = 0; k < n; k++) {
    const y = gh + k * FH;
    const ya = k === 0 ? gh - 0.5 : y - bandLo;
    bx(mb, x0, ya, z0, x1, y + bandHi, z1, white, 0, { roof: white, bot: soff, m: MAT.plaster, rm: MAT.none });
  }
  // 屋上の帯（パラペットを兼ねる）
  bx(mb, x0, H - bandLo, z0, x1, H + 0.15, z1, white, 0, { roof: rng.pick(ROOFS), bot: soff, m: MAT.plaster, rm: MAT.membrane });
  rim(mb, x0, z0, x1, z1, H + 0.15, white, 1.0, 0.3, white);
  // 側面：まん中は白い壁、角はガラス（角の窓）。ときどき側面も帯の窓のまま
  const cw = Math.min(3.6, d * 0.28);
  if (rng.next() < 0.75 && d - 2 * cw > 3) {
    for (const sx of [x0, x1 - ins + 0.02]) bx(mb, sx, gh, z0 + cw, sx + ins - 0.02, H, z1 - cw, white, 0, { roof: null, m: MAT.plaster });
  }
  // 正面の縦の白い壁（階段室）。屋上より少し上まで
  if (rng.next() < 0.55 && w > 14) {
    const sw = 2.8 + rng.next() * 1.4, sx = x0 + w * (rng.next() < 0.5 ? 0.3 : 0.62) - sw / 2;
    bx(mb, sx, gh - 0.5, z1 - ins, sx + sw, H + 2.4, z1 + 0.25, white, 0, { roof: white, m: MAT.plaster, rm: MAT.none });
    bx(mb, sx, gh - 0.5, z0 - 0.25, sx + sw, H + 2.4, z0 + ins, white, 0, { roof: white, m: MAT.plaster, rm: MAT.none });
  }
  // ---- 屋上：セットバックしたガラスの最上階（屋上テラス）か、機械 ----
  const top = H + 0.15;
  if (rng.next() < 0.55 && w > 12 && d > 9) {
    const qx0 = x0 + 2, qx1 = x1 - (w > 20 ? w * 0.3 : 2), qz0 = z0 + 1.5, qz1 = z1 - 3.2;
    bx(mb, qx0, top, qz0, qx1, top + 3.0, qz1, glass, PAT.curtain, { roof: null, m: MAT.none, vs: VS_CURTAIN, vb: top - 2 * FH - 0.6 });
    bx(mb, qx0 - 0.5, top + 3.0, qz0 - 0.5, qx1 + 0.5, top + 3.45, qz1 + 0.9, white, 0, { roof: rng.pick(ROOFS), bot: soff, m: MAT.plaster, rm: MAT.membrane });
    bx(mb, qx0 - 0.5, top + 3.3, qz1 + 0.75, qx1 + 0.5, top + 3.45, qz1 + 0.9, K.glow, PAT.glow, { roof: null });
    roofKit(mb, rng, qx0, qz0, qx1, qz1, top + 3.45, white);
  } else roofKit(mb, rng, x0 + 0.3, z0 + 0.3, x1 - 0.3, z1 - 0.3, top, white);
}

// ======================================================================
// B. 打ち放しコンクリートとガラス（日本のデザイナーズマンション）
// ======================================================================
const CONCRETES = [0xb9b7b1, 0xa9a8a3, 0xc4c1b9, 0xb0b1ae, 0xbdb8ae].map(C);
const CGLASS = [0x3f4a52, 0x36424c, 0x46525a, 0x3c4648, 0x4a5560].map(C);
function rawConcrete(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors0: number) {
  const p = plan(f, rng, floors0, { slender: 7, maxW: 26, maxD: 19, minD: 11 });
  const { x0, x1, z0, z1, floors, tower } = p;
  const conc = rng.pick(CONCRETES), glass = rng.pick(CGLASS), wood = rng.pick(WOODS);
  const concDk = conc.clone().multiplyScalar(0.9);
  const gh = tower ? 4.8 : 3.6;
  const n = floors - 1, H = gh + n * FH, vb = gh - 2 * FH;
  const w = x1 - x0, d = z1 - z0;
  const deep = rng.next() < 0.5; // 深いバルコニーの格子（でなければ縦のひれ）
  const ins = deep ? 0.4 : 0.85; // 窓の奥まり（ひれの型は窓を深く）
  const bal = deep ? 1.5 + rng.next() * 0.4 : 0; // バルコニーの奥行き（正面と裏）
  const CO: BO = { m: MAT.concrete, rm: MAT.none };
  // ---- 地面と1階 ----
  const ex = x0 + w * (0.3 + rng.next() * 0.4);
  site(mb, f, rng, tf, p, ex, 2.4);
  // 1階：コンクリートの箱、正面の玄関は 1.8m 奥まって、木の壁と天井、ガラスの扉
  const ew = Math.min(6, w * 0.3);
  bx(mb, x0, 0, z0, x1, gh, z1 - 1.8, conc, 0, { ...CO, roof: null });
  bx(mb, x0, 0, z1 - 1.8, ex - ew / 2, gh, z1, conc, 0, { ...CO, roof: null });
  bx(mb, ex + ew / 2, 0, z1 - 1.8, x1, gh, z1, conc, 0, { ...CO, roof: null });
  bx(mb, ex - ew / 2 + 0.4, 0, z1 - 1.85, ex + ew / 2 - 0.4, gh - 0.4, z1 - 1.79, K.lobby, PAT.fullglass, { roof: null, m: MAT.none, vs: VS_FULL });
  bx(mb, ex - ew / 2, gh - 0.4, z1 - 1.8, ex + ew / 2, gh, z1 - 0.02, wood, 0, { roof: null, bot: wood, m: MAT.siding, skip: 2 });
  bx(mb, ex - ew / 2, 0, z1 - 1.8, ex - ew / 2 + 0.4, gh - 0.4, z1 - 0.02, wood, 0, { roof: null, m: MAT.siding });
  bx(mb, ex + ew / 2 - 0.4, 0, z1 - 1.8, ex + ew / 2, gh - 0.4, z1 - 0.02, wood, 0, { roof: null, m: MAT.siding });
  bx(mb, ex - ew / 2 + 0.5, gh - 0.55, z1 - 1.5, ex + ew / 2 - 0.5, gh - 0.42, z1 - 1.3, K.lamp, PAT.glow, { roof: null });
  // 1階の正面の横長の窓（住戸・管理室）
  for (const [a, b] of [[x0 + 1, ex - ew / 2 - 1], [ex + ew / 2 + 1, x1 - 1]]) if (b - a > 2.5) bx(mb, a, 0.9, z1 - 0.06, b, gh - 0.6, z1 + 0.02, glass, PAT.fullglass, { roof: null, m: MAT.none, vs: VS_FULL, vb: -2 * FH });
  // ---- 上の階 ----
  // 奥まった大きなガラス（床から天井まで）
  bx(mb, x0 + ins, gh, z0 + ins, x1 - ins, H, z1 - ins, glass, PAT.fullglass, { roof: null, m: MAT.none, vs: VS_FULL, vb });
  // 床の帯（コンクリートの梁）
  for (let k = 0; k < n; k++) {
    const y = gh + k * FH;
    bx(mb, x0, y - 0.35, z0, x1, y + 0.3, z1, conc, 0, { ...CO, roof: conc, bot: concDk });
  }
  // 側面：コンクリートの壁。縦に 1 列だけ窓（壁を 2 つに分けてすき間をあける）
  // 奥行きのある棟・塔は 2 列（大きな無窓の壁にならないように）
  const gap = 1.6, gzs = tower || d > 15 ? [z0 + d * (0.25 + rng.next() * 0.08), z1 - d * (0.25 + rng.next() * 0.08)] : [z0 + d * (0.35 + rng.next() * 0.3)];
  for (const [sx, sk] of [[x0, 4], [x1 - ins, 8]] as [number, number][]) {
    let za = z0;
    for (const gz of gzs) { bx(mb, sx, gh, za, sx + ins, H, gz - gap / 2, conc, 0, { ...CO, roof: null, skip: sk }); za = gz + gap / 2; }
    bx(mb, sx, gh, za, sx + ins, H, z1, conc, 0, { ...CO, roof: null, skip: sk });
  }
  // 正面と裏：縦のひれ（不規則な間隔）か、深いバルコニーの格子
  const fins: number[] = [];
  {
    let x = x0 + ins;
    fins.push(x0);
    while (true) {
      x += deep ? 3.4 + rng.next() * 1.6 : 1.8 + rng.next() * 2.6;
      if (x > x1 - 1.6) break;
      fins.push(x);
    }
    fins.push(x1 - 0.3);
  }
  const ft = deep ? 0.3 : 0.24;
  const proj = deep ? bal : 0.45 + rng.next() * 0.5;
  // 木の縦の格子で隠す列（1 列）
  // 塔では全高の木の帯がうるさいので、下の 5 階ぶんだけ（足もとのアクセント）
  const woodBay = fins.length > 3 ? 1 + rng.int(fins.length - 3) : -1;
  const woodTop = tower ? Math.min(H - 0.35, gh + 5 * FH - 0.35) : H - 0.35;
  for (const [s, sgn] of [[z1, 1], [z0, -1]] as [number, number][]) {
    const zin = s - sgn * ins;
    for (let i = 0; i < fins.length; i++) {
      const x = fins[i];
      const a = Math.min(Math.max(x, x0), x1 - ft);
      // 角のひれは少し太く
      const za = sgn > 0 ? zin : s - proj, zb = sgn > 0 ? s + proj : zin;
      bx(mb, a, gh - 0.35, za, a + ft, H + (deep ? 0.9 : 0.3), zb, conc, 0, { ...CO, roof: conc });
    }
    if (deep) {
      // バルコニーの床（軒裏は木）と、コンクリートの低い手すり壁
      for (let k = 1; k <= n; k++) {
        const y = gh + k * FH;
        const za = sgn > 0 ? s : s - bal, zb = sgn > 0 ? s + bal : s;
        bx(mb, x0, y - 0.35, za, x1, y + 0.3, zb, conc, 0, { ...CO, roof: conc, bot: wood });
        if (k < n) {
          const zr = sgn > 0 ? s + bal - 0.15 : s - bal;
          bx(mb, x0, y + 0.3, zr, x1, y + 1.05, zr + 0.15, rng.next() < 0.5 ? K.rail : K.railDk, 0, { roof: null, m: MAT.none });
        }
      }
      // 1 階の上のバルコニーの床（いちばん下）
      const za = sgn > 0 ? s : s - bal, zb = sgn > 0 ? s + bal : s;
      bx(mb, x0, gh - 0.35, za, x1, gh + 0.3, zb, conc, 0, { ...CO, roof: conc, bot: wood });
    }
    // 木の縦格子の列
    if (woodBay >= 0) {
      const a = fins[woodBay] + ft + 0.1, b = fins[woodBay + 1] - 0.1;
      const zs = sgn > 0 ? zin : zin;
      for (let x = a + 0.15; x < b - 0.1; x += 0.42) slat(mb, sgn, x, x + 0.09, zs, ins - 0.1, gh + 0.3, woodTop, wood);
    }
  }
  // ---- 屋上 ----
  bx(mb, x0, H - 0.35, z0, x1, H + 0.3, z1, conc, 0, { ...CO, roof: rng.pick(ROOFS), bot: concDk, rm: MAT.membrane });
  rim(mb, x0, z0 - (deep ? bal : 0), x1, z1 + (deep ? bal : 0), H + 0.3, conc, 0.9, 0.25, conc, MAT.concrete);
  roofKit(mb, rng, x0 + 0.3, z0 + 0.3, x1 - 0.3, z1 - 0.3, H + 0.3, conc, MAT.concrete);
}

// ======================================================================
// D. 左右にずれる白いバルコニー
// ======================================================================
const BODIES = [0x5f6368, 0x6d7175, 0x55595e, 0x7b746b, 0x56636e, 0x4b5560].map(C);
function staggeredBalcony(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors0: number) {
  const p = plan(f, rng, floors0, { slender: 7, maxW: 28, maxD: 20 });
  const { x0, x1, z0, z1, floors, tower } = p;
  const body = rng.pick(BODIES), white = rng.pick(WHITES), wood = rng.pick(WOODS);
  const soffit = rng.next() < 0.7 ? wood : white.clone().multiplyScalar(0.9);
  const gh = tower ? 5.4 : 3.8;
  const n = floors - 1, H = gh + n * FH, vb = gh - 2 * FH;
  const w = x1 - x0, d = z1 - z0;
  const dep = Math.min(2.2, 1.6 + rng.next() * 0.6);
  const mode = rng.next() < 0.5 ? 'checker' : 'shift';
  const sideEnds = rng.next() < 0.6; // 側面は白い壁
  // ---- 地面と1階 ----
  const ex = x0 + w * (0.35 + rng.next() * 0.3);
  site(mb, f, rng, tf, p, ex, 3);
  bx(mb, x0 + 0.8, 0, z0 + 0.8, x1 - 0.8, gh, z1 - 1.2, K.lobby, PAT.fullglass, { roof: null, m: MAT.none, vs: VS_FULL });
  bx(mb, ex - 1.2, 0, z1 - 1.24, ex + 1.2, 2.6, z1 - 1.18, K.door, 0, { m: MAT.metal });
  // 1階の白い柱
  for (const x of spans(x0 + 0.4, x1 - 0.4, 6)) {
    bx(mb, x - 0.35, 0, z1 - 0.8, x + 0.35, gh, z1 - 0.1, white, 0, { m: MAT.plaster });
    bx(mb, x - 0.35, 0, z0 + 0.1, x + 0.35, gh, z0 + 0.8, white, 0, { m: MAT.plaster });
  }
  // 入口のひさし（木の軒裏）と照明
  bx(mb, ex - 3, gh - 0.6, z1 - 1.2, ex + 3, gh - 0.25, z1 + 2.2, white, 0, { bot: wood, m: MAT.plaster });
  bx(mb, ex - 2.6, gh - 0.66, z1 + 1.6, ex + 2.6, gh - 0.6, z1 + 1.9, K.lamp, PAT.glow, { roof: null });
  // ---- 本体（濃い色の窓の壁）----
  bx(mb, x0, gh, z0, x1, H, z1, body, PAT.curtain, { roof: null, m: MAT.none, vs: VS_CURTAIN, vb, bot: white });
  if (sideEnds) for (const sx of [x0 - 0.3, x1]) bx(mb, sx, gh - 0.3, z0 + 0.6, sx + 0.3, H + 1.2, z1 - 0.6, white, 0, { roof: white, m: MAT.plaster, rm: MAT.none });
  // 床の細い白い帯（階を区切る）
  for (let k = 0; k < n; k++) {
    const y = gh + k * FH;
    bx(mb, x0 - 0.05, y - 0.3, z0 - 0.05, x1 + 0.05, y, z1 + 0.05, white, 0, { roof: null, bot: white, m: MAT.plaster });
  }
  // ---- バルコニー ----
  const nm = Math.max(2, Math.round(w / (tower ? 6.5 : 5.5)));
  const mw = w / nm;
  const ph = rng.int(2);
  // 1 つのバルコニー：白い床（木の軒裏）と、ガラスの手すり（前と両わき）
  const balc = (a: number, b: number, y: number, s: number, sgn: number) => {
    const za = sgn > 0 ? s : s - dep, zb = sgn > 0 ? s + dep : s;
    bx(mb, a, y - 0.42, za, b, y, zb, white, 0, { roof: white, bot: soffit, m: MAT.plaster, rm: MAT.none });
    const rz = sgn > 0 ? zb - 0.06 : za + 0.06;
    const keep = mb.matOverride; mb.matOverride = MAT.none;
    mb.quad(sgn > 0 ? [a, y, rz] : [b, y, rz], sgn > 0 ? [b, y, rz] : [a, y, rz], sgn > 0 ? [b, y + 1.0, rz] : [a, y + 1.0, rz], sgn > 0 ? [a, y + 1.0, rz] : [b, y + 1.0, rz], K.railLt);
    mb.quad([b, y, sgn > 0 ? rz : s], [b, y, sgn > 0 ? s : rz], [b, y + 1.0, sgn > 0 ? s : rz], [b, y + 1.0, sgn > 0 ? rz : s], K.railLt);
    mb.quad([a, y, sgn > 0 ? s : rz], [a, y, sgn > 0 ? rz : s], [a, y + 1.0, sgn > 0 ? rz : s], [a, y + 1.0, sgn > 0 ? s : rz], K.railLt);
    mb.matOverride = keep;
  };
  const balcX = (a: number, b: number, y: number, s: number, sgn: number) => {
    // 側面（x の向き）のバルコニー
    const xa = sgn > 0 ? s : s - dep, xb = sgn > 0 ? s + dep : s;
    bx(mb, xa, y - 0.42, a, xb, y, b, white, 0, { roof: white, bot: soffit, m: MAT.plaster, rm: MAT.none });
    const rx = sgn > 0 ? xb - 0.06 : xa;
    bx(mb, rx, y, a, rx + 0.06, y + 1.0, b, K.railLt, 0, { roof: null, m: MAT.none });
  };
  for (let k = 1; k < n; k++) {
    const y = gh + k * FH;
    for (const [s, sgn] of [[z1, 1], [z0, -1]] as [number, number][]) {
      if (mode === 'checker') {
        for (let j = 0; j < nm; j++) if ((j + k + ph + (sgn < 0 ? 1 : 0)) % 2 === 0) balc(x0 + j * mw + 0.15, x0 + (j + 1) * mw - 0.15, y, s, sgn);
      } else {
        // 階ごとに左右へずれる長いバルコニー（幅の約 6 割）
        const L = w * 0.58, off = (k + ph + (sgn < 0 ? 1 : 0)) % 2 === 0;
        if (w > 26) {
          // 広い面は 2 つずつ
          const h2 = w / 2, L2 = h2 * 0.62;
          for (const base of [x0, x0 + h2]) balc(off ? base + 0.2 : base + h2 - L2 - 0.2, off ? base + 0.2 + L2 : base + h2 - 0.2, y, s, sgn);
        } else balc(off ? x0 + 0.3 : x1 - L - 0.3, off ? x0 + 0.3 + L : x1 - 0.3, y, s, sgn);
      }
    }
    // 塔は側面にもバルコニー（白い壁の側面でなければ）
    if (tower && !sideEnds && d > 12) {
      const L = d * 0.5, off = (k + ph) % 2 === 0;
      balcX(off ? z0 + 0.6 : z1 - 0.6 - L, off ? z0 + 0.6 + L : z1 - 0.6, y, x1, 1);
      balcX(off ? z1 - 0.6 - L : z0 + 0.6, off ? z1 - 0.6 : z0 + 0.6 + L, y, x0, -1);
    }
  }
  // ---- 屋上：白い枠と光る帯、ガラスの手すり、機械 ----
  bx(mb, x0 - 0.4, H, z0 - 0.4, x1 + 0.4, H + 0.6, z1 + 0.4, white, 0, { roof: rng.pick(ROOFS), bot: soffit, m: MAT.plaster, rm: MAT.membrane });
  bx(mb, x0 - 0.42, H + 0.1, z1 + 0.38, x1 + 0.42, H + 0.25, z1 + 0.42, K.glow, PAT.glow, { roof: null });
  glassRim(mb, x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3, H + 0.6);
  roofKit(mb, rng, x0 + 0.5, z0 + 0.5, x1 - 0.5, z1 - 0.5, H + 0.6, white);
}

// ======================================================================
// E. 縦の木のルーバー
// ======================================================================
const FRAMES = [0xf2f2ef, 0xeceae4, 0x3a3d40, 0xdedfdc].map(C);
const LGLASS = [0x4f6a7e, 0x46596a, 0x5a6e78, 0x3f5262].map(C);
function timberLouver(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors0: number) {
  const p = plan(f, rng, floors0, { slender: 8, maxW: 26, maxD: 22 });
  const { x0, x1, z0, z1, floors, tower } = p;
  const frame = rng.pick(FRAMES), glass = rng.pick(LGLASS), wood = rng.pick(WOODS);
  const woodDk = wood.clone().multiplyScalar(0.82);
  const gh = tower ? 5.4 : 3.8;
  const n = floors - 1, H = gh + n * FH, vb = gh - 2 * FH;
  const w = x1 - x0;
  const out = 0.9; // 床の帯の張り出し（ルーバーはこの中）
  // 何階ごとに白い帯とルーバーの区切りを入れるか（高い塔はまとめて、三角形の数を抑える）
  const G = n <= 10 ? 1 : Math.max(2, Math.ceil(n / 10));
  const sp = tower ? 0.8 : 0.7; // ルーバーの間隔
  // ---- 地面と1階 ----
  const ex = x0 + w * (0.3 + rng.next() * 0.4);
  site(mb, f, rng, tf, p, ex, 3);
  bx(mb, x0 + 0.6, 0, z0 + 0.6, x1 - 0.6, gh, z1 - 1.0, K.lobby, PAT.fullglass, { roof: null, m: MAT.none, vs: VS_FULL });
  // 1階の木の壁（片側）
  const wx = ex < 0 ? x1 - 0.6 - w * 0.35 : x0 + 0.6;
  bx(mb, wx, 0, z1 - 1.02, wx + w * 0.35, gh, z1 - 0.95, wood, 0, { roof: null, m: MAT.siding });
  bx(mb, ex - 1.1, 0, z1 - 1.04, ex + 1.1, 2.5, z1 - 0.98, K.door, 0, { m: MAT.metal });
  // ひさし（木の軒裏）
  bx(mb, ex - 3.5, gh - 0.5, z1 - 1, ex + 3.5, gh - 0.15, z1 + 2.4, frame, 0, { bot: wood, m: MAT.plaster });
  bx(mb, ex - 3.1, gh - 0.56, z1 + 1.8, ex + 3.1, gh - 0.5, z1 + 2.1, K.lamp, PAT.glow, { roof: null });
  // ---- 本体：ガラス ----
  bx(mb, x0, gh, z0, x1, H, z1, glass, PAT.curtain, { roof: null, m: MAT.none, vs: VS_CURTAIN, vb });
  // ---- 帯とルーバー ----
  const FM = frame.r < 0.5 ? MAT.metal : MAT.plaster;
  const ph = rng.next() * 6, amp = 0.3 + rng.next() * 0.25, wave = 0.25 + rng.next() * 0.25;
  const cover = 0.55 + rng.next() * 0.25;
  const pw = tower ? 3.2 : 2.6; // 引き戸のパネルの幅
  // 面ごとのルーバー：a..b を幅 pw のパネルに分け、パネルごとにルーバーを付けるかを決める（住人が動かした引き戸のように）
  const face = (sgn: number, a: number, b: number, s: number, ya: number, yb: number, gi: number) => {
    const np = Math.max(1, Math.round((b - a) / pw)), pwi = (b - a) / np;
    for (let j = 0; j < np; j++) {
      if (rng.next() > cover) continue;
      const pa = a + j * pwi + 0.1, pb = a + (j + 1) * pwi - 0.1;
      for (let x = pa + sp / 2; x < pb; x += sp) {
        // 深さが波のように変わる
        const dep = 0.25 + (out - 0.35) * (0.5 + 0.5 * Math.sin(ph + x * wave + gi * 0.9)) * (0.5 + amp);
        slat(mb, sgn, x - 0.06, x + 0.06, s, Math.min(out - 0.05, dep), ya, yb, wood);
      }
    }
  };
  for (let g = 0; g * G < n; g++) {
    const ka = g * G, kb = Math.min(n, ka + G);
    const ya = gh + ka * FH, yb = gh + kb * FH;
    // 区切りの白い帯（床の張り出し）。下の面は木
    bx(mb, x0 - out, ya - 0.32, z0 - out, x1 + out, ya, z1 + out, frame, 0, { roof: frame, bot: g === 0 ? wood : woodDk, m: FM, rm: MAT.none });
    face(1, x0, x1, z1, ya, yb - 0.32, g);
    face(-1, x0, x1, z0, ya, yb - 0.32, g);
    face(2, z0, z1, x1, ya, yb - 0.32, g);
    face(-2, z0, z1, x0, ya, yb - 0.32, g);
    // まとめた階のあいだの細い帯（ガラスの奥の床が見える）
    for (let k = ka + 1; k < kb; k++) {
      const y = gh + k * FH;
      bx(mb, x0 - 0.04, y - 0.25, z0 - 0.04, x1 + 0.04, y, z1 + 0.04, frame, 0, { roof: null, m: FM });
    }
  }
  // ---- 屋上 ----
  bx(mb, x0 - out, H - 0.32, z0 - out, x1 + out, H + 0.5, z1 + out, frame, 0, { roof: rng.pick(ROOFS), bot: woodDk, m: FM, rm: MAT.membrane });
  bx(mb, x0 - out - 0.02, H + 0.1, z1 + out - 0.02, x1 + out + 0.02, H + 0.25, z1 + out + 0.02, K.glow, PAT.glow, { roof: null });
  glassRim(mb, x0 - out + 0.1, z0 - out + 0.1, x1 + out - 0.1, z1 + out - 0.1, H + 0.5);
  // 機械を木の格子で囲む
  const mx0 = x0 + 1, mx1 = Math.min(x1 - 1, x0 + 1 + Math.max(6, w * 0.45)), mz0 = z0 + 1, mz1 = Math.min(z1 - 1, z0 + 7);
  roofKit(mb, rng, mx0, mz0, mx1, mz1, H + 0.5, frame, FM);
  for (let x = mx0 + 0.3; x < mx1; x += 0.32) slat(mb, 1, x, x + 0.14, mz1, 0.1, H + 0.5, H + 2.8, wood);
}

RES.ribbonWhite = { fn: ribbonWhite, minF: 3, maxF: 32 };
RES.rawConcrete = { fn: rawConcrete, minF: 3, maxF: 30 };
RES.staggeredBalcony = { fn: staggeredBalcony, minF: 3, maxF: 36 };
RES.timberLouver = { fn: timberLouver, minF: 3, maxF: 50 };
