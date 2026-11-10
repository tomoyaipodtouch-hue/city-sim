// 町はずれの一軒家と農家（ヨーロッパの田園）。outskirtsLayer から呼ばれる、形を作るだけの関数
//   ruralHouse … 16×16m の敷地の一軒家（屋根・壁・窓・玄関・車庫・物置・垣根・小道・花壇・車）。いろいろな組み合わせ
//   farmstead  … 32×32m の農家。地方ごとの5つの型（広い地域ごとに同じ型がまとまる）
//     0 フランスのロンジェール（細長い平屋の石造り。納屋が一列につながる。石塀の庭）
//     1 オランダのストルプ（大きな四角錐の屋根の下に納屋と家。前にレンガの母屋。干し草小屋、ポプラ）
//     2 北ドイツのハレンハウス（地面近くまで下りる大きな切妻屋根、妻側に大きな戸、木組みとレンガ、オーク）
//     3 四方を囲む農家（オーストリア・南ドイツ。白い壁、赤い瓦、門のアーチ、中庭）
//     4 北欧の農家（ファールンレッドの板壁と白い縁取り、黒い屋根、腰折れ屋根の納屋、離れの小屋、旗竿）
// 敷地の座標：x は横、+z が道路の側（正面）。y は世界の高さ。ground lawn（芝生）は呼ぶ側が描く
import * as THREE from 'three';
import { MeshBuilder, PAT } from './builder';
import { MAT } from './textures';
import { Rng, hash2 } from '../sim/rng';
import { CELL } from '../sim/constants';
import type { TreeSpot } from './buildingGen';

export interface RuralCtx {
  fa: number; // 敷地の向き（正面 = +z を世界のどちらへ向けるか）
  cx: number; // 敷地の中心（世界の座標）
  cz: number;
  base: number; // 敷地の地面の高さ（だいたい）
  lo: number; // 敷地のいちばん低い地面（土台をここまで下ろす）
  seed: number;
  gy?: (x: number, z: number) => number; // 世界の座標での地面の高さ（あれば、建物や小道を斜面に合わせる）
}

type V3 = [number, number, number];
type Col = THREE.Color;
const C = (h: number) => new THREE.Color(h);
const PI = Math.PI;
const LIFT = 0.12; // 呼ぶ側の芝生の浮かせる高さ
const THATCH = MAT.plaster; // 茅葺き（細かいざらつき）

// ---------------- 地方（広い範囲で同じ型がまとまる） ----------------
// ゆがめた格子の点のうち、いちばん近い点の型（ボロノイ）。1つの地方は 400〜600m くらい
export function ruralRegion(x: number, z: number): number {
  const S = CELL * 30;
  const gx = Math.floor(x / S), gz = Math.floor(z / S);
  let best = 1e18, t = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i, cz = gz + j;
      const px = (cx + 0.15 + hash2(cx, cz, 901) * 0.7) * S, pz = (cz + 0.15 + hash2(cx, cz, 902) * 0.7) * S;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best) { best = d; t = Math.floor(hash2(cx, cz, 903) * 5); }
    }
  return t;
}

// ---------------- 道具（敷地の座標系、部分の座標系） ----------------
class Kit {
  trees: TreeSpot[] = [];
  private cs: number;
  private sn: number;
  fx = 0;
  fz = 0;
  fe = 0;
  private stack: [number, number, number][] = [];
  winK = 0; // 窓ごとに夜の明かりを変えるための番号
  constructor(public mb: MeshBuilder, public c: RuralCtx, public r: Rng) {
    this.cs = Math.cos(c.fa);
    this.sn = Math.sin(c.fa);
  }
  // 敷地の座標 → 世界の座標
  w(lx: number, lz: number): [number, number] {
    return [this.c.cx + lx * this.cs - lz * this.sn, this.c.cz + lx * this.sn + lz * this.cs];
  }
  private apply() {
    const [x, z] = this.w(this.fx, this.fz);
    this.mb.setTransform(this.c.fa + this.fe, x, 0, z);
  }
  // 部分の座標系を敷地の座標で決める
  at(lx = 0, lz = 0, e = 0) {
    this.fx = lx; this.fz = lz; this.fe = e;
    this.stack.length = 0;
    this.apply();
  }
  // いまの座標系の中に、もう1段の座標系
  push(px: number, pz: number, e = 0) {
    this.stack.push([this.fx, this.fz, this.fe]);
    const [lx, lz] = this.toLot(px, pz);
    this.fx = lx; this.fz = lz; this.fe += e;
    this.apply();
  }
  pop() {
    const s = this.stack.pop();
    if (!s) return;
    [this.fx, this.fz, this.fe] = s;
    this.apply();
  }
  toLot(px: number, pz: number): [number, number] {
    const c = Math.cos(this.fe), s = Math.sin(this.fe);
    return [this.fx + px * c - pz * s, this.fz + px * s + pz * c];
  }
  // いまの座標系の点の地面の高さ
  gh(px: number, pz: number) {
    if (!this.c.gy) return this.c.base;
    const [lx, lz] = this.toLot(px, pz);
    const [x, z] = this.w(lx, lz);
    return this.c.gy(x, z);
  }
  // 長方形の範囲の地面の高さ（いちばん低い、いちばん高い）
  span(x0: number, z0: number, x1: number, z1: number): [number, number] {
    if (!this.c.gy) return [this.c.lo, this.c.base];
    let lo = 1e9, hi = -1e9;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [(x0 + x1) / 2, (z0 + z1) / 2], [(x0 + x1) / 2, z0], [(x0 + x1) / 2, z1], [x0, (z0 + z1) / 2], [x1, (z0 + z1) / 2]]) {
      const h = this.gh(x, z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return [lo, hi];
  }
  m(mat: number | null) { this.mb.matOverride = mat; }
  tree(px: number, pz: number, s: number, kind = 0, shape?: number, col?: number) {
    const [lx, lz] = this.toLot(px, pz);
    const [x, z] = this.w(lx, lz);
    const t: TreeSpot = { x, y: this.c.gy ? this.c.gy(x, z) : this.c.base, z, s, kind };
    if (shape !== undefined) t.shape = shape;
    if (col !== undefined) t.col = col;
    this.trees.push(t);
  }
  end() {
    this.mb.setTransform(0, 0, 0, 0);
    this.mb.matOverride = null;
    return this.trees;
  }
}

// ---------------- 形の部品（いまの座標系で描く） ----------------
interface BoxO { top?: Col | null; skip?: number; vb?: number; pat?: number; vert?: boolean; bot?: boolean }
// 直方体。skip：1 = +z、2 = -z、4 = +x、8 = -x、16 = 上。vb = 壁の模様の高さの基準（根元の陰）。vert = 縦張りの板
function box(k: Kit, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Col, mat: number | null, o: BoxO = {}) {
  const mb = k.mb, sk = o.skip ?? 0, p = o.pat ?? 0, h = y1 - y0, v0 = y0 - (o.vb ?? y0);
  k.m(mat);
  const face = (a: V3, b: V3, c: V3, d: V3, len: number) => {
    if (o.vert) mb.quad(b, c, d, a, col, p, h, len, 0, 20);
    else mb.quad(a, b, c, d, col, p, len, h, 0, v0);
  };
  if (!(sk & 1)) face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], x1 - x0);
  if (!(sk & 2)) face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], x1 - x0);
  if (!(sk & 4)) face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], z1 - z0);
  if (!(sk & 8)) face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], z1 - z0);
  if (!(sk & 16) && o.top !== null) mb.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], o.top ?? col, p >= PAT.garden && p <= PAT.gardenGlow ? PAT.garden : 0);
  if (o.bot) mb.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col);
}

// 壁の面：中心 (px, pz)、外向き (nx, nz)、長さ len。a = 壁に沿った位置（外から見て左 → 右）
interface Wall { px: number; pz: number; nx: number; nz: number; len: number }
const wp = (W: Wall, a: number, y: number, d: number): V3 => [W.px + W.nz * a + W.nx * d, y, W.pz - W.nx * a + W.nz * d];
// 壁の4つの面（0 = +z、1 = +x、2 = -z、3 = -x）
const sides = (x0: number, z0: number, x1: number, z1: number): Wall[] => [
  { px: (x0 + x1) / 2, pz: z1, nx: 0, nz: 1, len: x1 - x0 },
  { px: x1, pz: (z0 + z1) / 2, nx: 1, nz: 0, len: z1 - z0 },
  { px: (x0 + x1) / 2, pz: z0, nx: 0, nz: -1, len: x1 - x0 },
  { px: x0, pz: (z0 + z1) / 2, nx: -1, nz: 0, len: z1 - z0 },
];
// 壁から出っぱる箱（d0..d1 は壁からの距離）。skip：1 = 上、2 = 下、4 = 横
function wbox(k: Kit, W: Wall, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number, col: Col, mat: number | null, skip = 0, pat = 0) {
  const mb = k.mb;
  k.m(mat);
  mb.quad(wp(W, a0, y0, d1), wp(W, a1, y0, d1), wp(W, a1, y1, d1), wp(W, a0, y1, d1), col, pat, a1 - a0, y1 - y0);
  if (!(skip & 1)) mb.quad(wp(W, a0, y1, d1), wp(W, a1, y1, d1), wp(W, a1, y1, d0), wp(W, a0, y1, d0), col);
  if (!(skip & 2)) mb.quad(wp(W, a0, y0, d0), wp(W, a1, y0, d0), wp(W, a1, y0, d1), wp(W, a0, y0, d1), col);
  if (!(skip & 4)) {
    mb.quad(wp(W, a1, y0, d1), wp(W, a1, y0, d0), wp(W, a1, y1, d0), wp(W, a1, y1, d1), col);
    mb.quad(wp(W, a0, y0, d0), wp(W, a0, y0, d1), wp(W, a0, y1, d1), wp(W, a0, y1, d0), col);
  }
}
// 壁に沿った平行四辺形（筋かいなど）。下の辺 a0..a1（高さ y0）、上の辺 b0..b1（高さ y1）
function wpara(k: Kit, W: Wall, a0: number, a1: number, y0: number, b0: number, b1: number, y1: number, d: number, col: Col) {
  k.m(MAT.none);
  k.mb.quad(wp(W, a0, y0, d), wp(W, a1, y0, d), wp(W, b1, y1, d), wp(W, b0, y1, d), col);
}

// ガラス（夜は明かりがともる）。窓の模様の1つ分にぴったり合わせた面の座標を使う
const GLASS = C(0x2a323c);
function glass(k: Kit, W: Wall, a0: number, a1: number, y0: number, y1: number, d: number) {
  k.m(MAT.none);
  const i = k.winK++;
  k.mb.quad(wp(W, a0, y0, d), wp(W, a1, y0, d), wp(W, a1, y1, d), wp(W, a0, y1, d), GLASS, PAT.house, 1.2, 1.2, 1.2 + 3.6 * (i % 9), 3.95 + 3 * ((i * 7) % 5));
}

interface WinS {
  frame: Col;
  bars: number; // 0 = なし、1 = 十字、2 = 縦の1本、3 = 格子（縦1本と横2本）
  shut: Col | null; // 雨戸（鎧戸）
  sill: Col | null; // 窓台
  surround?: Col | null; // 窓のまわりの帯（石の枠、しっくいの縁）
  box?: Col | null; // 花の箱
}
// 窓：中心 a、下の高さ y0、幅 w、高さ h
function win(k: Kit, W: Wall, a: number, y0: number, w: number, h: number, s: WinS) {
  const fw = 0.11, d = 0.07;
  if (s.surround) wbox(k, W, a - w / 2 - 0.26, a + w / 2 + 0.26, y0 - 0.22, y0 + h + 0.26, 0, 0.03, s.surround, MAT.plaster, 7);
  wbox(k, W, a - w / 2 - fw, a + w / 2 + fw, y0 - fw, y0 + h + fw, 0, d, s.frame, MAT.none, 2);
  glass(k, W, a - w / 2, a + w / 2, y0, y0 + h, d + 0.005);
  const bw = 0.055, bd = d + 0.02;
  k.m(MAT.none);
  if (s.bars === 1 || s.bars === 2 || s.bars === 3) k.mb.quad(wp(W, a - bw, y0, bd), wp(W, a + bw, y0, bd), wp(W, a + bw, y0 + h, bd), wp(W, a - bw, y0 + h, bd), s.frame);
  if (s.bars === 1) { const yb = y0 + h * 0.68; k.mb.quad(wp(W, a - w / 2, yb - bw, bd), wp(W, a + w / 2, yb - bw, bd), wp(W, a + w / 2, yb + bw, bd), wp(W, a - w / 2, yb + bw, bd), s.frame); }
  if (s.bars === 3)
    for (const f of [0.34, 0.67]) { const yb = y0 + h * f; k.mb.quad(wp(W, a - w / 2, yb - 0.025, bd), wp(W, a + w / 2, yb - 0.025, bd), wp(W, a + w / 2, yb + 0.025, bd), wp(W, a - w / 2, yb + 0.025, bd), s.frame); }
  if (s.sill) wbox(k, W, a - w / 2 - 0.16, a + w / 2 + 0.16, y0 - 0.16, y0 - 0.05, 0, 0.17, s.sill, MAT.concrete, 6);
  if (s.box) wbox(k, W, a - w / 2, a + w / 2, y0 - 0.38, y0 - 0.12, 0.1, 0.36, s.box, MAT.none, 6, PAT.gardenLeaf);
  if (s.shut) {
    const sw = w / 2 + 0.02;
    wbox(k, W, a - w / 2 - fw - sw, a - w / 2 - fw - 0.02, y0 - 0.02, y0 + h + 0.04, 0.02, 0.07, s.shut, MAT.siding, 3);
    wbox(k, W, a + w / 2 + fw + 0.02, a + w / 2 + fw + sw, y0 - 0.02, y0 + h + 0.04, 0.02, 0.07, s.shut, MAT.siding, 3);
  }
}
// 玄関の戸：中心 a、幅 w、高さ h、床の高さ y0
function door(k: Kit, W: Wall, a: number, y0: number, w: number, h: number, col: Col, frame: Col, lite = true) {
  wbox(k, W, a - w / 2 - 0.1, a + w / 2 + 0.1, y0, y0 + h + 0.1, 0, 0.06, frame, MAT.none, 2);
  wbox(k, W, a - w / 2, a + w / 2, y0, y0 + h, 0.06, 0.08, col, MAT.none, 6);
  if (lite) glass(k, W, a - w * 0.18, a + w * 0.18, y0 + h * 0.55, y0 + h * 0.9, 0.085);
}

// 屋根（棟は x の向き）。y = 軒の高さ（壁の上）、rise = 棟までの高さ。
// c0 / c1 = 両端（-x / +x）の妻の高さの割合：1 = 切妻、0 = 寄棟、その間 = 半切妻（ドイツ瓦屋根の Krüppelwalm）
interface RoofO { ov?: number; ovG?: number; c0?: number; c1?: number; t?: number; fascia?: Col; soffit?: Col; wallMat?: number | null; roofMat?: number; gable0?: boolean; gable1?: boolean }
interface RoofI { x0: number; x1: number; z0: number; z1: number; y: number; kk: number; hd: number; zm: number; yt: number; t: number }
function roof(k: Kit, x0: number, z0: number, x1: number, z1: number, y: number, rise: number, rc: Col, wc: Col, o: RoofO = {}): RoofI {
  const mb = k.mb;
  const ov = o.ov ?? 0.5, ovG = o.ovG ?? ov, t = o.t ?? 0.2;
  const hd = (z1 - z0) / 2, zm = (z0 + z1) / 2, kk = rise / hd, yt = y + rise;
  const ye = y - kk * ov, z1e = z1 + ov, z0e = z0 - ov;
  const fas = o.fascia ?? rc, sof = o.soffit ?? C(0xd8d2c6);
  const end = (c: number) => {
    if (c >= 0.999) return { o: ovG, ins: -ovG, yc: yt, hz: 0, ycw: yt, hw: 0, gable: true, hip: false };
    const oc = c > 0.001 ? ovG : ov, ins = hd * (1 - c);
    return { o: oc, ins, yc: y + kk * (hd * c - oc), hz: ins + oc, ycw: y + kk * hd * c, hw: ins, gable: c > 0.001, hip: true };
  };
  const e0 = end(o.c0 ?? 1), e1 = end(o.c1 ?? 1);
  const T = (p: V3): V3 => [p[0], p[1] + t, p[2]];
  // 前の斜面（+z）と後ろの斜面（-z）の頂点
  const E0: V3 = [x0 - e0.o, ye, z1e], E1: V3 = [x1 + e1.o, ye, z1e];
  const C1: V3 = [x1 + e1.o, e1.yc, zm + e1.hz], C0: V3 = [x0 - e0.o, e0.yc, zm + e0.hz];
  const R1: V3 = [x1 - e1.ins, yt, zm], R0: V3 = [x0 + e0.ins, yt, zm];
  const bE0: V3 = [x1 + e1.o, ye, z0e], bE1: V3 = [x0 - e0.o, ye, z0e];
  const bC1: V3 = [x0 - e0.o, e0.yc, zm - e0.hz], bC0: V3 = [x1 + e1.o, e1.yc, zm - e1.hz];
  k.m(o.roofMat ?? MAT.shingle);
  // 4つの点の面。同じ点が重なるときは三角形にする（法線がつぶれないように）
  const q4 = (a: V3, b: V3, c: V3, d: V3) => {
    const P = [a, b, c, d].filter((p, i, A) => { const q = A[(i + 3) % 4]; return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 1e-4; });
    if (P.length === 4) mb.quad(P[0], P[1], P[2], P[3], rc);
    else if (P.length === 3) mb.tri(P[0], P[1], P[2], rc);
  };
  const both = e0.hip && !e0.gable && e1.hip && !e1.gable;
  if (!both) {
    q4(T(E0), T(E1), T(C1), T(C0));
    q4(T(bE0), T(bE1), T(bC1), T(bC0));
  }
  if (e0.hip || e1.hip) {
    q4(T(C0), T(C1), T(R1), T(R0));
    q4(T(bC0), T(bC1), T(R0), T(R1));
  }
  if (e1.hip) mb.tri(T(C1), T(bC0), T(R1), rc);
  if (e0.hip) mb.tri(T(bC1), T(C0), T(R0), rc);
  // 鼻隠し（軒先の厚み）とけらば（妻側の縁）
  k.m(MAT.none);
  const strip = (a: V3, b: V3) => mb.quad(a, b, T(b), T(a), fas);
  strip(E0, E1);
  strip(bE0, bE1);
  if (e1.hip && e1.hz > 0.01) strip(C1, bC0);
  if (e0.hip && e0.hz > 0.01) strip(bC1, C0);
  if (e1.gable) { strip(E1, C1); strip(bC0, bE0); }
  if (e0.gable) { strip(bE1, bC1); strip(C0, E0); }
  // 軒裏
  mb.quad([x0 - e0.o, ye, z1e], [x0 - e0.o, y, z1], [x1 + e1.o, y, z1], [x1 + e1.o, ye, z1e], sof);
  mb.quad([x1 + e1.o, ye, z0e], [x1 + e1.o, y, z0], [x0 - e0.o, y, z0], [x0 - e0.o, ye, z0e], sof);
  if (e1.gable && e1.o > 0.25) {
    mb.quad([x1, ye, z1e], [x1, e1.yc, zm + e1.hz], [x1 + e1.o, e1.yc, zm + e1.hz], [x1 + e1.o, ye, z1e], sof);
    mb.quad([x1 + e1.o, ye, z0e], [x1 + e1.o, e1.yc, zm - e1.hz], [x1, e1.yc, zm - e1.hz], [x1, ye, z0e], sof);
  }
  if (e0.gable && e0.o > 0.25) {
    mb.quad([x0 - e0.o, ye, z1e], [x0 - e0.o, e0.yc, zm + e0.hz], [x0, e0.yc, zm + e0.hz], [x0, ye, z1e], sof);
    mb.quad([x0, ye, z0e], [x0, e0.yc, zm - e0.hz], [x0 - e0.o, e0.yc, zm - e0.hz], [x0 - e0.o, ye, z0e], sof);
  }
  // 妻壁
  k.m(o.wallMat ?? MAT.plaster);
  if (e1.gable && o.gable1 !== false) {
    if (e1.hw < 0.01) mb.tri([x1, y, z1], [x1, y, z0], [x1, e1.ycw, zm], wc);
    else { mb.tri([x1, y, z1], [x1, y, z0], [x1, e1.ycw, zm - e1.hw], wc); mb.tri([x1, y, z1], [x1, e1.ycw, zm - e1.hw], [x1, e1.ycw, zm + e1.hw], wc); }
  }
  if (e0.gable && o.gable0 !== false) {
    if (e0.hw < 0.01) mb.tri([x0, y, z0], [x0, y, z1], [x0, e0.ycw, zm], wc);
    else { mb.tri([x0, y, z0], [x0, y, z1], [x0, e0.ycw, zm + e0.hw], wc); mb.tri([x0, y, z0], [x0, e0.ycw, zm + e0.hw], [x0, e0.ycw, zm - e0.hw], wc); }
  }
  return { x0, x1, z0, z1, y, kk, hd, zm, yt, t };
}
// 屋根の上面の高さ（前の斜面なら s = 1、後ろなら -1）
const roofY = (R: RoofI, z: number) => R.y + R.t + R.kk * (R.hd - Math.abs(z - R.zm));

// 腰折れ屋根（北欧の納屋）。棟は x の向き。下の急な斜面で knee の高さまで上がり、上はゆるい斜面
function gambrel(k: Kit, x0: number, z0: number, x1: number, z1: number, y: number, h1: number, h2: number, inset: number, rc: Col, wc: Col, wallMat: number | null, trim: Col, vert = false) {
  const mb = k.mb, ov = 0.35, zm = (z0 + z1) / 2, t = 0.18;
  const yk = y + h1, yt = yk + h2;
  const prof: [number, number][] = [[z1 + ov, y - ov * (h1 / inset)], [z1 - inset, yk], [zm, yt], [z0 + inset, yk], [z0 - ov, y - ov * (h1 / inset)]];
  const xa = x0 - 0.3, xb = x1 + 0.3;
  k.m(MAT.shingle);
  for (let i = 0; i < 4; i++) {
    const [za, ya] = prof[i], [zb, yb] = prof[i + 1];
    mb.quad([xa, ya + t, za], [xb, ya + t, za], [xb, yb + t, zb], [xa, yb + t, zb], rc);
  }
  k.m(MAT.none);
  for (const [xx, s] of [[xb, 1], [xa, -1]] as const)
    for (let i = 0; i < 4; i++) {
      const [za, ya] = prof[s > 0 ? i : i + 1], [zb, yb] = prof[s > 0 ? i + 1 : i];
      mb.quad([xx, ya, za], [xx, yb, zb], [xx, yb + t, zb], [xx, ya + t, za], trim);
    }
  mb.quad([xa, prof[0][1], prof[0][0]], [xb, prof[0][1], prof[0][0]], [xb, prof[0][1] + t, prof[0][0]], [xa, prof[0][1] + t, prof[0][0]], trim);
  mb.quad([xb, prof[4][1], prof[4][0]], [xa, prof[4][1], prof[4][0]], [xa, prof[4][1] + t, prof[4][0]], [xb, prof[4][1] + t, prof[4][0]], trim);
  // 妻壁（五角形）
  k.m(wallMat);
  for (const [xx, s] of [[x1, 1], [x0, -1]] as const) {
    const za = s > 0 ? z1 : z0, zb = s > 0 ? z0 : z1, ia = s > 0 ? z1 - inset : z0 + inset, ib = s > 0 ? z0 + inset : z1 - inset;
    if (vert) mb.quad([xx, y, zb], [xx, yk, ib], [xx, yk, ia], [xx, y, za], wc, 0, h1, z1 - z0, 0, 20);
    else mb.quad([xx, y, za], [xx, y, zb], [xx, yk, ib], [xx, yk, ia], wc, 0, z1 - z0, h1, 0, 5);
    mb.tri([xx, yk, ia], [xx, yk, ib], [xx, yt, zm], wc);
  }
  return { yk, yt };
}

// 煙突（下 y0、上 y1）
function chimney(k: Kit, x: number, z: number, w: number, d: number, y0: number, y1: number, col: Col, mat: number = MAT.brick) {
  box(k, x - w / 2, y0, z - d / 2, x + w / 2, y1, z + d / 2, col, mat, { top: null });
  box(k, x - w / 2 - 0.07, y1, z - d / 2 - 0.07, x + w / 2 + 0.07, y1 + 0.14, z + d / 2 + 0.07, C(0x6a6662), MAT.concrete);
  box(k, x - 0.12, y1 + 0.14, z - 0.12, x + 0.12, y1 + 0.42, z + 0.12, C(0x8a5a46), MAT.none);
}

// 屋根窓（前の斜面 +z に置く）。dx = 中心、dw = 幅、dh = 窓の壁の高さ、zf = 前の壁の位置
function dormer(k: Kit, R: RoofI, dx: number, dw: number, dh: number, zf: number, roofCol: Col, wallCol: Col, wallMat: number | null, ws: WinS, shed = false) {
  const yb = Math.min(roofY(R, zf), roofY(R, R.z1)) - (zf >= R.z1 - 0.01 ? 0.7 : 0.05);
  const yd = yb + dh;
  // 屋根窓の棟は、母屋の屋根の斜面にぶつかるところまで（屋根から突き抜けないように）
  const rd = Math.min(dw * 0.55, R.yt + R.t - yd - 0.15);
  if (rd < 0.3) return;
  const zb = Math.max(R.zm + 0.2, R.z1 - (yd + (shed ? 0.4 : rd + 0.05) - R.y - R.t) / R.kk);
  if (zb >= zf - 0.5) return;
  box(k, dx - dw / 2, yb - 0.6, zb, dx + dw / 2, yd, zf, wallCol, wallMat, { skip: 2 | 16 });
  win(k, sides(dx - dw / 2, zb, dx + dw / 2, zf)[0], 0, yb + 0.3, dw - 0.55, Math.max(0.6, dh - 0.55), { ...ws, shut: null, box: null, surround: null, sill: null });
  if (shed) {
    // 片流れの屋根窓：前から後ろへ、ゆるく上がる
    const L = zf - zb + 0.3;
    k.m(MAT.shingle);
    const yr = Math.min(R.yt, yd + 0.15 + L * 0.2);
    k.mb.quad([dx - dw / 2 - 0.15, yd + 0.15, zf + 0.3], [dx + dw / 2 + 0.15, yd + 0.15, zf + 0.3], [dx + dw / 2 + 0.15, yr, zb - 0.3], [dx - dw / 2 - 0.15, yr, zb - 0.3], roofCol);
    box(k, dx - dw / 2 - 0.15, yd, zf + 0.2, dx + dw / 2 + 0.15, yd + 0.15, zf + 0.3, roofCol, MAT.none, { skip: 2 | 16 });
    return;
  }
  const mid = (zb + zf) / 2, L = zf - zb;
  k.push(dx, mid, PI / 2);
  roof(k, -L / 2, -dw / 2, L / 2, dw / 2, yd, rd, roofCol, wallCol, { ov: 0.18, ovG: 0.12, t: 0.12, wallMat, gable0: false });
  k.pop();
}

// 太陽光パネル（屋根の斜面 s = 1 前、-1 後ろ）
const PANEL = C(0x1b2433);
function solar(k: Kit, R: RoofI, s: number, xa: number, xb: number, rows: number) {
  const pw = 1.05, ph = 1.72, gap = 0.04;
  const n = Math.floor((xb - xa) / (pw + gap));
  if (n < 2) return;
  const x0 = (xa + xb) / 2 - (n * (pw + gap)) / 2;
  const slope = Math.hypot(1, R.kk), dzs = 1 / slope;
  k.m(MAT.none);
  for (let r = 0; r < rows; r++) {
    const d0 = R.hd * 0.18 + r * (ph + gap) * dzs, d1 = d0 + ph * dzs;
    if (d1 > R.hd * 0.92) break;
    const za = R.zm + s * (R.hd - d0), zb = R.zm + s * (R.hd - d1);
    const ya = roofY(R, za) + 0.1, yb = roofY(R, zb) + 0.1;
    for (let i = 0; i < n; i++) {
      const xx0 = x0 + i * (pw + gap), xx1 = xx0 + pw;
      if (s > 0) k.mb.quad([xx0, ya, za], [xx1, ya, za], [xx1, yb, zb], [xx0, yb, zb], PANEL);
      else k.mb.quad([xx1, ya, za], [xx0, ya, za], [xx0, yb, zb], [xx1, yb, zb], PANEL);
    }
  }
}
// 天窓（屋根の斜面に暗いガラス）
function skylight(k: Kit, R: RoofI, s: number, x: number, d: number) {
  const za = R.zm + s * (R.hd - d), zb = R.zm + s * (R.hd - d - 1.0);
  const ya = roofY(R, za) + 0.05, yb = roofY(R, zb) + 0.05;
  k.m(MAT.none);
  const fr = C(0x3a3d40);
  if (s > 0) {
    k.mb.quad([x - 0.42, ya, za], [x + 0.42, ya, za], [x + 0.42, yb, zb], [x - 0.42, yb, zb], fr);
    k.mb.quad([x - 0.34, ya + 0.02, za - 0.06 * s], [x + 0.34, ya + 0.02, za - 0.06 * s], [x + 0.34, yb + 0.02, zb + 0.06 * s], [x - 0.34, yb + 0.02, zb + 0.06 * s], GLASS, PAT.house, 1.2, 1.2, 1.2 + 3.6 * (k.winK++ % 9), 3.95);
  } else {
    k.mb.quad([x + 0.42, ya, za], [x - 0.42, ya, za], [x - 0.42, yb, zb], [x + 0.42, yb, zb], fr);
    k.mb.quad([x + 0.34, ya + 0.02, za - 0.06 * s], [x - 0.34, ya + 0.02, za - 0.06 * s], [x - 0.34, yb + 0.02, zb + 0.06 * s], [x + 0.34, yb + 0.02, zb + 0.06 * s], GLASS, PAT.house, 1.2, 1.2, 1.2 + 3.6 * (k.winK++ % 9), 3.95);
  }
}

// 地面に沿う面（砂利の庭、小道、舗装）。いまの座標系の長方形
function patch(k: Kit, x0: number, z0: number, x1: number, z1: number, lift: number, col: Col, mat: number, step = 4) {
  if (!k.c.gy) {
    box(k, x0, k.c.lo - 0.3, z0, x1, k.c.base + lift, z1, col, mat);
    return;
  }
  const nx = Math.max(1, Math.ceil((x1 - x0) / step)), nz = Math.max(1, Math.ceil((z1 - z0) / step));
  const H: number[] = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H.push(k.gh(x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz) + lift);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const xa = x0 + ((x1 - x0) * i) / nx, xb = x0 + ((x1 - x0) * (i + 1)) / nx, za = z0 + ((z1 - z0) * j) / nz, zb = z0 + ((z1 - z0) * (j + 1)) / nz;
      const h = (ii: number, jj: number) => H[jj * (nx + 1) + ii];
      k.mb.quadC([xa, h(i, j + 1), zb], [xb, h(i + 1, j + 1), zb], [xb, h(i + 1, j), za], [xa, h(i, j), za], col, col, col, col, mat);
    }
  // ふち（少しだけ厚みを見せる）
  k.m(mat);
  const e = (ax: number, az: number, bx: number, bz: number) => { const ha = k.gh(ax, az), hb = k.gh(bx, bz); k.mb.quad([ax, ha - 0.05, az], [bx, hb - 0.05, bz], [bx, hb + lift, bz], [ax, ha + lift, az], col); };
  e(x0, z1, x1, z1); e(x1, z0, x0, z0); e(x1, z1, x1, z0); e(x0, z0, x0, z1);
}

// 土台から立てる箱（建物の本体）。床の高さ fl、上 top、土台は地面のいちばん低いところまで
function body(k: Kit, x0: number, z0: number, x1: number, z1: number, fl: number, top: number, col: Col, mat: number | null, plinth: Col, vert = false, lo?: number) {
  const bot = (lo ?? k.span(x0, z0, x1, z1)[0]) - 0.4;
  box(k, x0 - 0.05, bot, z0 - 0.05, x1 + 0.05, fl + 0.3, z1 + 0.05, plinth, MAT.concrete, { top: null, vb: bot });
  box(k, x0, fl + 0.3, z0, x1, top, z1, col, mat, { top: null, vb: fl - 1.2, vert });
}
// 床の高さ（建物の下のいちばん高い地面 + 少し）
function floorAt(k: Kit, x0: number, z0: number, x1: number, z1: number, up = 0.3): [number, number] {
  const [lo, hi] = k.span(x0, z0, x1, z1);
  return [hi + up, lo];
}

// 横向きの円柱（タイヤ、干し草のロール）。軸は x
function cylX(k: Kit, x0: number, x1: number, y: number, z: number, r: number, col: Col, seg = 8, caps = true, capCol?: Col) {
  const mb = k.mb;
  const P = (x: number, a: number): V3 => [x, y + r * Math.sin(a), z + r * Math.cos(a)];
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * PI * 2, a1 = ((s + 1) / seg) * PI * 2;
    mb.quad(P(x0, a0), P(x1, a0), P(x1, a1), P(x0, a1), col);
    if (caps) {
      mb.tri([x1, y, z], P(x1, a1), P(x1, a0), capCol ?? col);
      mb.tri([x0, y, z], P(x0, a0), P(x0, a1), capCol ?? col);
    }
  }
}

// ---------------- 小物 ----------------
const CARS = [0xd8d8d8, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xf2f2f2, 0x3b5d3a, 0xb8bcc0, 0x101820, 0x6d1f2a, 0x4a6a8a].map(C);
const TYRE = C(0x1e1f21);
function car(k: Kit, x: number, z: number, ang: number) {
  const col = k.r.pick(CARS);
  k.push(x, z, ang);
  const y = k.gh(0, 0) + 0.05;
  const L = 4.2 + k.r.next() * 0.5, Wd = 1.8;
  box(k, -0.92, y + 0.05, -L / 2 + 0.55, 0.92, y + 0.42, -L / 2 + 1.25, TYRE, MAT.none, { top: null });
  box(k, -0.92, y + 0.05, L / 2 - 1.2, 0.92, y + 0.42, L / 2 - 0.5, TYRE, MAT.none, { top: null });
  box(k, -Wd / 2, y + 0.25, -L / 2, Wd / 2, y + 0.8, L / 2, col, MAT.none);
  k.m(MAT.none);
  const cab = C(0x20262c);
  const zb = -L / 2 + 0.45, zf = L / 2 - 1.35;
  k.mb.prism([[-0.84, zb], [0.84, zb], [0.84, zf], [-0.84, zf]], y + 0.8, y + 1.38, cab, PAT.none, col, [[-0.72, zb + 0.4], [0.72, zb + 0.4], [0.72, zf - 0.55], [-0.72, zf - 0.55]]);
  k.pop();
}

const TRACTORS: [number, number][] = [[0x367c2b, 0xe2b51d], [0xa3221c, 0x9c9ea0], [0x1f4e9a, 0xd8d8d8], [0x3d6b35, 0x8a8f92], [0x8a1b1b, 0x2a2a2a], [0xc9c4b8, 0xa3221c]];
function tractor(k: Kit, x: number, z: number, ang: number) {
  const [b, w] = k.r.pick(TRACTORS), body = C(b), rim = C(w);
  k.push(x, z, ang);
  const y = k.gh(0, 0) + 0.05;
  cylX(k, -1.2, -0.72, y + 0.82, -0.9, 0.82, TYRE, 10, true, rim);
  cylX(k, 0.72, 1.2, y + 0.82, -0.9, 0.82, TYRE, 10, true, rim);
  cylX(k, -0.98, -0.66, y + 0.5, 1.45, 0.5, TYRE, 8, true, rim);
  cylX(k, 0.66, 0.98, y + 0.5, 1.45, 0.5, TYRE, 8, true, rim);
  box(k, -0.42, y + 0.55, -0.4, 0.42, y + 1.42, 2.15, body, MAT.none);
  box(k, -0.72, y + 1.0, -1.7, 0.72, y + 1.48, -0.25, body, MAT.none);
  box(k, -0.66, y + 1.48, -1.6, 0.66, y + 2.55, -0.32, C(0x26303a), MAT.none, { top: null });
  box(k, -0.76, y + 2.55, -1.72, 0.76, y + 2.68, -0.2, body, MAT.none);
  box(k, 0.3, y + 1.42, 1.2, 0.4, y + 2.4, 1.3, C(0x333333), MAT.none);
  k.pop();
}
const BALE = { straw: C(0xcdb27a), white: C(0xe0ddd2), black: C(0x2b2e2b), green: C(0x4c6b3e) };
function bale(k: Kit, x: number, z: number, ang: number, col: Col, stackY = 0) {
  k.push(x, z, ang);
  const y = k.gh(0, 0) + 0.7 + stackY;
  cylX(k, -0.6, 0.6, y, 0, 0.75, col, 10, true, col === BALE.straw ? C(0xb89a60) : col);
  k.pop();
}
// 薪の山
function woodpile(k: Kit, x0: number, z0: number, x1: number, h: number, ang = 0) {
  k.push(x0, z0, ang);
  const y = k.gh(0, 0);
  box(k, 0, y - 0.2, -0.45, x1, y + h, 0.45, C(0x8a6a48), MAT.siding, { top: C(0x5a4636) });
  box(k, -0.1, y + h, -0.6, x1 + 0.1, y + h + 0.1, 0.6, C(0x3c3f42), MAT.metal);
  k.pop();
}

// 片流れの小屋（前が開いている。荷車や機械の置き場）。中心 x, z、+z が前
function lean(k: Kit, x: number, z: number, ang: number, w: number, d: number, h: number, roofC: Col, wood: Col) {
  k.push(x, z, ang);
  const [fl, lo] = floorAt(k, -w / 2, -d / 2, w / 2, d / 2, 0.05);
  box(k, -w / 2, lo - 0.3, -d / 2, w / 2, fl + h + 0.6, -d / 2 + 0.15, wood, MAT.siding, { top: null, vert: true });
  for (const sx of [-1, 1]) box(k, sx * w / 2 - 0.08, lo - 0.3, -d / 2, sx * w / 2 + 0.08, fl + h + 0.4, d / 2 - 0.2, wood, MAT.siding, { top: null, vert: true, skip: sx > 0 ? 8 : 4 });
  for (const px of [-w / 2 + 0.1, 0, w / 2 - 0.1]) box(k, px - 0.1, lo - 0.3, d / 2 - 0.3, px + 0.1, fl + h, d / 2 - 0.1, wood, MAT.none);
  k.m(MAT.shingle);
  k.mb.quad([-w / 2 - 0.3, fl + h, d / 2 + 0.4], [w / 2 + 0.3, fl + h, d / 2 + 0.4], [w / 2 + 0.3, fl + h + 0.8, -d / 2 - 0.3], [-w / 2 - 0.3, fl + h + 0.8, -d / 2 - 0.3], roofC);
  k.m(MAT.none);
  k.mb.quad([-w / 2 - 0.3, fl + h - 0.15, d / 2 + 0.4], [w / 2 + 0.3, fl + h - 0.15, d / 2 + 0.4], [w / 2 + 0.3, fl + h, d / 2 + 0.4], [-w / 2 - 0.3, fl + h, d / 2 + 0.4], wood);
  k.mb.quad([w / 2 + 0.3, fl + h - 0.15, d / 2 + 0.4], [-w / 2 - 0.3, fl + h - 0.15, d / 2 + 0.4], [-w / 2 - 0.3, fl + h + 0.65, -d / 2 - 0.3], [w / 2 + 0.3, fl + h + 0.65, -d / 2 - 0.3], C(0x4a3c30));
  // 中の荷車
  box(k, -1.6, fl + 0.45, -0.9, 1.4, fl + 0.95, 0.9, C(0x6a5038), MAT.siding);
  cylX(k, -1.25, -1.1, fl + 0.5, 0, 0.5, C(0x3a3028), 8, true);
  cylX(k, 1.1, 1.25, fl + 0.5, 0, 0.5, C(0x3a3028), 8, true);
  k.pop();
}

// 生け垣（いまの座標系で x0..x1、z0..z1 の箱。地面に合わせる）
const HEDGE = [0x3f5f2a, 0x4a6b2e, 0x52702f, 0x3a5628].map(C);
function hedge(k: Kit, x0: number, z0: number, x1: number, z1: number, h: number, col: Col) {
  const [lo, hi] = k.span(x0, z0, x1, z1);
  box(k, x0, lo - 0.3, z0, x1, (lo + hi) / 2 + h, z1, col, MAT.none, { pat: PAT.gardenLeaf });
}
// 低い石の塀・しっくいの塀（上に笠石）
function lowWall(k: Kit, x0: number, z0: number, x1: number, z1: number, h: number, col: Col, mat: number, cap: Col) {
  const [lo, hi] = k.span(x0, z0, x1, z1);
  const top = (lo + hi) / 2 + h;
  box(k, x0, lo - 0.3, z0, x1, top, z1, col, mat, { top: null, vb: lo });
  box(k, x0 - 0.05, top, z0 - 0.05, x1 + 0.05, top + 0.1, z1 + 0.05, cap, MAT.concrete);
}
// 柱と横木の柵（x の向き、または z の向き）
function railFence(k: Kit, ax: number, az: number, bx: number, bz: number, col: Col, h = 1.1, rails = 2, sp = 2.4) {
  const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, n = Math.max(1, Math.round(L / sp));
  const nx = -uz * 0.04, nz = ux * 0.04;
  for (let i = 0; i <= n; i++) {
    const px = ax + ((bx - ax) * i) / n, pz = az + ((bz - az) * i) / n, g = k.gh(px, pz);
    box(k, px - 0.07, g - 0.3, pz - 0.07, px + 0.07, g + h + 0.08, pz + 0.07, col, MAT.none);
  }
  k.m(MAT.none);
  for (let r = 0; r < rails; r++) {
    const fy = h * (rails === 1 ? 0.9 : 0.35 + (0.58 * r) / (rails - 1));
    for (let i = 0; i < n; i++) {
      const pa = [ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n], pb = [ax + ((bx - ax) * (i + 1)) / n, az + ((bz - az) * (i + 1)) / n];
      const ga = k.gh(pa[0], pa[1]) + fy, gb = k.gh(pb[0], pb[1]) + fy;
      k.mb.quad([pa[0] + nx, ga - 0.07, pa[1] + nz], [pb[0] + nx, gb - 0.07, pb[1] + nz], [pb[0] + nx, gb + 0.07, pb[1] + nz], [pa[0] + nx, ga + 0.07, pa[1] + nz], col);
      k.mb.quad([pb[0] - nx, gb - 0.07, pb[1] - nz], [pa[0] - nx, ga - 0.07, pa[1] - nz], [pa[0] - nx, ga + 0.07, pa[1] - nz], [pb[0] - nx, gb + 0.07, pb[1] - nz], col);
      k.mb.quad([pa[0] - nx, ga + 0.07, pa[1] - nz], [pa[0] + nx, ga + 0.07, pa[1] + nz], [pb[0] + nx, gb + 0.07, pb[1] + nz], [pb[0] - nx, gb + 0.07, pb[1] - nz], col);
    }
  }
}
// 白い板の柵（ピケットフェンス）。x の向きのみ（正面）
function picket(k: Kit, x0: number, x1: number, z: number, col: Col, h = 0.95) {
  const n = Math.round((x1 - x0) / 0.34);
  k.m(MAT.none);
  for (let i = 0; i < n; i++) {
    const a = x0 + ((x1 - x0) * (i + 0.5)) / n, g = k.gh(a, z);
    k.mb.quad([a - 0.05, g - 0.2, z + 0.02], [a + 0.05, g - 0.2, z + 0.02], [a + 0.05, g + h, z + 0.02], [a - 0.05, g + h, z + 0.02], col);
    k.mb.quad([a + 0.05, g - 0.2, z - 0.02], [a - 0.05, g - 0.2, z - 0.02], [a - 0.05, g + h, z - 0.02], [a + 0.05, g + h, z - 0.02], col);
    k.mb.tri([a - 0.05, g + h, z + 0.02], [a + 0.05, g + h, z + 0.02], [a, g + h + 0.1, z], col);
  }
  const ga = k.gh(x0, z), gb = k.gh(x1, z);
  for (const fy of [0.25, 0.7]) {
    k.mb.quad([x1, gb + fy - 0.05, z - 0.03], [x0, ga + fy - 0.05, z - 0.03], [x0, ga + fy + 0.05, z - 0.03], [x1, gb + fy + 0.05, z - 0.03], col);
  }
}
// 低い茂み（六角の柱）
function shrub(k: Kit, x: number, z: number, r: number, h: number, col: Col) {
  const g = k.gh(x, z) - 0.15;
  const ring: [number, number][] = [], top: [number, number][] = [];
  for (let s = 0; s < 6; s++) { const a = (s / 6) * PI * 2 + x; ring.push([x + Math.cos(a) * r, z + Math.sin(a) * r]); top.push([x + Math.cos(a) * r * 0.55, z + Math.sin(a) * r * 0.55]); }
  k.m(MAT.none);
  k.mb.prism(ring, g, g + h, col, PAT.gardenLeaf, col, top);
}
const FLOWERS = [0xd9567a, 0xc23a30, 0xe8c547, 0x8a6bb0, 0xf0ece4, 0xe58a3a, 0xb04a8a].map(C);
// 花壇（いまの座標系で x の向き）
function flowerBed(k: Kit, x0: number, x1: number, z0: number, z1: number) {
  const n = Math.max(2, Math.round((x1 - x0) / 0.9));
  for (let i = 0; i < n; i++) {
    const a = x0 + ((x1 - x0) * i) / n, b = a + (x1 - x0) / n, g = k.gh((a + b) / 2, (z0 + z1) / 2);
    const col = i % 3 === 1 ? HEDGE[2] : k.r.pick(FLOWERS);
    box(k, a, g - 0.1, z0, b, g + 0.22 + k.r.next() * 0.22, z1, HEDGE[(i + 1) % 4], MAT.none, { pat: PAT.gardenLeaf, skip: 2, top: col });
  }
}
// 小さな切妻の物置（中心 x, z、向き ang）
function shed(k: Kit, x: number, z: number, ang: number, w: number, d: number, wall: Col, roofC: Col, trim: Col, eave = 2.1, mat: number = MAT.siding) {
  k.push(x, z, ang);
  const [fl, lo] = floorAt(k, -w / 2, -d / 2, w / 2, d / 2, 0.12);
  body(k, -w / 2, -d / 2, w / 2, d / 2, fl - 0.3, fl + eave, wall, mat, C(0x6e6a64), mat === MAT.siding, lo);
  const S = sides(-w / 2, -d / 2, w / 2, d / 2);
  door(k, S[0], 0, fl, 0.9, 1.9, trim === wall ? C(0x4a3b2e) : wall, trim, false);
  roof(k, -w / 2, -d / 2, w / 2, d / 2, fl + eave, d * 0.36, roofC, wall, { ov: 0.25, ovG: 0.2, t: 0.12, wallMat: mat, fascia: trim });
  k.pop();
}

// ======================================================================
//                          一軒家
// ======================================================================
type HouseStyle = 'render' | 'french' | 'brick' | 'nordic' | 'alpine' | 'modern' | 'stone';
type RoofKind = 'gable' | 'hip' | 'half' | 'mansard' | 'flat' | 'mono';
interface HS {
  style: HouseStyle;
  wall: Col; wallMat: number; vert: boolean; plinth: Col;
  upper: { col: Col; mat: number; vert: boolean } | null; // 2階だけ別の外壁（アルプスの木の2階）
  roof: Col; roofMat: number; roofKind: RoofKind; pitch: number; ov: number; ovG: number; fascia: Col; soffit: Col;
  floors: 1 | 1.5 | 2;
  ws: WinS; winW: number; winH: number; big: boolean;
  doorC: Col; trim: Col | null;
  gableToRoad: boolean; chimney: number; dormers: number; dormerShed: boolean; eaveDormer: boolean;
  solar: boolean; skylights: boolean;
  garage: 'none' | 'garage' | 'carport'; garageRoof: 'flat' | 'gable';
  fence: 'hedge' | 'picket' | 'wall' | 'rail' | 'slat' | 'gabion' | 'lowhedge';
  porch: 'none' | 'canopy' | 'gable' | 'veranda';
  conserv: boolean; balcony: boolean;
}

const pickW = <T,>(r: Rng, w: [T, number][]): T => {
  let s = 0;
  for (const [, p] of w) s += p;
  let x = r.next() * s;
  for (const [v, p] of w) { x -= p; if (x <= 0) return v; }
  return w[w.length - 1][0];
};
const WHITE = C(0xf2f1ec), ANTH = C(0x2e3134), WOODF = C(0x6a4a32);
const DOORS = [0x6b4a32, 0x2f4a3a, 0x2c3e55, 0x7a2a25, 0x333638, 0x4f5a4a, 0x8a6a48].map(C);

function houseStyle(r: Rng, reg: number): HouseStyle {
  if (r.next() < 0.2) return 'modern';
  const regional: [HouseStyle, number][][] = [
    [['french', 0.5], ['stone', 0.35], ['render', 0.15]],
    [['brick', 0.85], ['render', 0.15]],
    [['brick', 0.55], ['render', 0.45]],
    [['alpine', 0.45], ['render', 0.55]],
    [['nordic', 1]],
  ];
  if (r.next() < 0.8) return pickW(r, regional[reg]);
  return r.pick(['render', 'french', 'brick', 'nordic', 'alpine', 'stone'] as HouseStyle[]);
}

function houseSpec(r: Rng, style: HouseStyle): HS {
  const s: HS = {
    style, wall: WHITE, wallMat: MAT.plaster, vert: false, plinth: C(0x8c8a85), upper: null,
    roof: C(0x9c4a32), roofMat: MAT.shingle, roofKind: 'gable', pitch: 1, ov: 0.5, ovG: 0.4, fascia: WHITE, soffit: C(0xe2ddd3),
    floors: 1.5, ws: { frame: WHITE, bars: 0, shut: null, sill: C(0xb9b4aa) }, winW: 1.1, winH: 1.35, big: false,
    doorC: r.pick(DOORS), trim: null, gableToRoad: false, chimney: 0, dormers: 0, dormerShed: false, eaveDormer: false,
    solar: false, skylights: false, garage: 'none', garageRoof: 'flat', fence: 'hedge', porch: 'none', conserv: false, balcony: false,
  };
  const floors = (a: number, b: number) => { const x = r.next(); s.floors = x < a ? 1 : x < a + b ? 1.5 : 2; };
  switch (style) {
    case 'render': {
      s.wall = C(r.pick([0xf2efe7, 0xebe3d2, 0xe9dcc0, 0xdfe2da, 0xf0dfc8, 0xe6e6e2, 0xf1ead6]));
      s.roof = C(r.pick([0x9c4a32, 0x7e3c2c, 0x3f4245, 0x5b4038, 0x8a4a3a]));
      s.roofKind = pickW(r, [['gable', 0.5], ['half', 0.25], ['hip', 0.25]]);
      s.pitch = r.range(0.82, 1.1);
      floors(0.12, 0.5);
      s.fascia = r.next() < 0.5 ? WOODF : s.roof;
      s.soffit = r.next() < 0.5 ? C(0x9a7652) : C(0xe5e0d6);
      s.ws = { frame: r.next() < 0.75 ? WHITE : ANTH, bars: r.next() < 0.4 ? 2 : 0, shut: r.next() < 0.18 ? C(r.pick([0x3f6b46, 0x6a4a30, 0x5b6f7a])) : null, sill: C(0xb9b4aa) };
      s.chimney = r.next() < 0.7 ? 1 : 0;
      s.solar = r.next() < 0.35;
      s.skylights = r.next() < 0.4;
      s.garage = pickW(r, [['garage', 0.5], ['carport', 0.2], ['none', 0.3]]);
      s.garageRoof = r.next() < 0.6 ? 'flat' : 'gable';
      s.fence = pickW(r, [['hedge', 0.45], ['rail', 0.2], ['slat', 0.2], ['lowhedge', 0.15]]);
      s.porch = pickW(r, [['canopy', 0.5], ['gable', 0.3], ['none', 0.2]]);
      s.conserv = r.next() < 0.15;
      s.gableToRoad = r.next() < 0.2;
      break;
    }
    case 'french': {
      s.wall = C(r.pick([0xe8dcc0, 0xdfcca6, 0xece4d2, 0xd9c19a, 0xf1ebdf, 0xe6d3b3]));
      const north = r.next() < 0.5;
      if (north) {
        s.roof = C(r.pick([0x474d55, 0x40464e, 0x535a62]));
        s.roofKind = pickW(r, [['gable', 0.45], ['hip', 0.35], ['mansard', 0.2]]);
        s.pitch = r.range(1.05, 1.3);
        floors(0.15, 0.45);
        s.dormers = s.floors === 2 ? (r.next() < 0.4 ? 2 : 0) : 2;
      } else {
        s.roof = C(r.pick([0xb5623f, 0xa65b3e, 0xbf7350, 0x9e5636]));
        s.roofKind = pickW(r, [['gable', 0.5], ['hip', 0.5]]);
        s.pitch = r.range(0.48, 0.6);
        s.floors = r.next() < 0.3 ? 1 : 2;
        s.ov = 0.45; s.ovG = 0.2;
      }
      s.fascia = s.wall; s.soffit = s.wall;
      s.ws = { frame: WHITE, bars: 3, shut: C(r.pick([0x8fb0c4, 0x9aab8a, 0xb4a7c4, 0x8e3b32, 0xd6d3cc, 0x6d8a9a, 0x4f6b54, 0x5b7fa1])), sill: C(0xd8d0c0) };
      s.winW = 1.0; s.winH = 1.45;
      s.chimney = 1 + (r.next() < 0.4 ? 1 : 0);
      s.solar = r.next() < 0.15;
      s.garage = pickW(r, [['garage', 0.35], ['none', 0.45], ['carport', 0.2]]);
      s.garageRoof = 'gable';
      s.fence = pickW(r, [['wall', 0.5], ['hedge', 0.35], ['lowhedge', 0.15]]);
      s.porch = pickW(r, [['canopy', 0.4], ['none', 0.6]]);
      break;
    }
    case 'brick': {
      s.wall = C(r.pick([0x8a4430, 0x9b5338, 0x7a3e2e, 0x6b4535, 0xc8a66e, 0xa0563a, 0x8e5a44]));
      s.wallMat = MAT.brick;
      s.plinth = s.wall.clone().multiplyScalar(0.7);
      s.roof = C(r.pick([0x3a3c40, 0x5d3a2f, 0x8c4632, 0x6a6e72, 0x2f3236]));
      s.roofKind = pickW(r, [['gable', 0.6], ['hip', 0.25], ['half', 0.15]]);
      s.pitch = r.range(0.95, 1.2);
      floors(0.2, 0.45);
      s.fascia = WHITE; s.soffit = WHITE;
      s.ws = { frame: r.next() < 0.8 ? WHITE : C(0x2f4a3a), bars: r.next() < 0.5 ? 1 : 0, shut: r.next() < 0.15 ? C(0x2f4a3a) : null, sill: C(0x9c9a94), surround: null };
      s.chimney = r.next() < 0.8 ? 1 : 0;
      s.dormers = s.floors === 1.5 ? 1 + Math.floor(r.next() * 2) : 0;
      s.dormerShed = r.next() < 0.4;
      s.solar = r.next() < 0.3;
      s.skylights = r.next() < 0.3;
      s.garage = pickW(r, [['garage', 0.55], ['carport', 0.15], ['none', 0.3]]);
      s.garageRoof = r.next() < 0.6 ? 'flat' : 'gable';
      s.fence = pickW(r, [['lowhedge', 0.4], ['picket', 0.2], ['hedge', 0.4]]);
      s.porch = pickW(r, [['canopy', 0.5], ['gable', 0.3], ['none', 0.2]]);
      s.conserv = r.next() < 0.25;
      break;
    }
    case 'nordic': {
      s.wall = C(r.pick([0x8b2c22, 0x8b2c22, 0xd8b45c, 0xeeeee8, 0xa9b8c2, 0x9aa98a, 0x3a3d3f, 0xe0cfa0]));
      s.wallMat = MAT.siding;
      s.vert = r.next() < 0.5;
      s.plinth = C(0x6e6c68);
      s.trim = s.wall.getHex() === 0x3a3d3f ? C(0xa98260) : WHITE;
      s.roof = C(r.pick([0x2b2d30, 0x3a3c3f, 0x8c3b2a, 0x2b2d30]));
      s.roofKind = 'gable';
      s.pitch = r.range(0.68, 0.9);
      floors(0.2, 0.45);
      s.ov = 0.4; s.ovG = 0.35;
      s.fascia = s.trim; s.soffit = s.trim;
      s.ws = { frame: s.trim, bars: r.next() < 0.6 ? 3 : 1, shut: null, sill: null, surround: null };
      s.winW = 1.0; s.winH = 1.3;
      s.chimney = r.next() < 0.6 ? 1 : 0;
      s.dormers = s.floors === 1.5 && r.next() < 0.5 ? 1 : 0;
      s.solar = r.next() < 0.25;
      s.garage = pickW(r, [['carport', 0.4], ['garage', 0.25], ['none', 0.35]]);
      s.garageRoof = 'gable';
      s.fence = pickW(r, [['picket', 0.5], ['rail', 0.3], ['lowhedge', 0.2]]);
      s.porch = pickW(r, [['veranda', 0.55], ['gable', 0.3], ['canopy', 0.15]]);
      s.gableToRoad = r.next() < 0.15;
      break;
    }
    case 'alpine': {
      s.wall = C(r.pick([0xf3f0e8, 0xeee6d4, 0xf2ece0]));
      s.upper = { col: C(r.pick([0x7a5233, 0x8a6040, 0x5e4029, 0x9a7048])), mat: MAT.siding, vert: r.next() < 0.4 };
      s.roof = C(r.pick([0x5b4a40, 0x46484b, 0x8c4632, 0x3c3e41]));
      s.roofKind = 'gable';
      s.pitch = r.range(0.42, 0.55);
      s.floors = 2;
      s.ov = 1.05; s.ovG = 1.25;
      s.fascia = s.upper.col; s.soffit = s.upper.col.clone().multiplyScalar(1.15);
      s.ws = { frame: WHITE, bars: 1, shut: C(r.pick([0x3f6b46, 0x6a4a30, 0x2f4f3a, 0x7a2a25])), sill: s.upper.col, box: r.next() < 0.6 ? C(0xc8362b) : null };
      s.winW = 1.0; s.winH = 1.3;
      s.gableToRoad = r.next() < 0.75;
      s.balcony = r.next() < 0.75;
      s.chimney = 1;
      s.solar = r.next() < 0.3;
      s.garage = pickW(r, [['garage', 0.5], ['carport', 0.3], ['none', 0.2]]);
      s.garageRoof = 'gable';
      s.fence = pickW(r, [['rail', 0.55], ['hedge', 0.25], ['lowhedge', 0.2]]);
      s.porch = 'none';
      break;
    }
    case 'modern': {
      const v = r.int(5);
      s.wall = C([0xf3f3f1, 0x2e3033, 0xa57b52, 0x8d9092, 0xd9d4ca][v]);
      s.wallMat = [MAT.plaster, MAT.siding, MAT.siding, MAT.concrete, MAT.brick][v];
      s.vert = v === 1 || v === 2;
      s.plinth = C(0x55585b);
      s.roofKind = pickW(r, [['flat', 0.45], ['mono', 0.2], ['gable', 0.35]]);
      s.roof = s.roofKind === 'gable' ? (r.next() < 0.6 ? C(0x2f3134) : s.wall) : C(0x6a6c6e);
      s.roofMat = s.roofKind === 'gable' && s.roof.getHex() === 0x2f3134 ? MAT.metal : MAT.shingle;
      if (s.roofKind === 'gable' && s.roof === s.wall) s.roofMat = s.wallMat;
      s.pitch = r.range(0.75, 1.05);
      s.ov = s.roofKind === 'gable' ? 0.08 : 0.3; s.ovG = 0.06;
      s.fascia = s.roof; s.soffit = ANTH;
      s.floors = r.next() < 0.45 ? 1 : 2;
      s.ws = { frame: ANTH, bars: 0, shut: null, sill: null };
      s.winW = r.range(1.6, 2.6); s.winH = 1.5; s.big = true;
      s.doorC = ANTH;
      s.solar = r.next() < 0.55;
      s.garage = pickW(r, [['carport', 0.5], ['garage', 0.3], ['none', 0.2]]);
      s.garageRoof = 'flat';
      s.fence = pickW(r, [['slat', 0.35], ['gabion', 0.25], ['lowhedge', 0.25], ['hedge', 0.15]]);
      s.porch = 'canopy';
      s.gableToRoad = s.roofKind === 'gable' && r.next() < 0.4;
      break;
    }
    case 'stone': {
      s.wall = C(r.pick([0xb7ab92, 0x9e978a, 0xc9bc9f, 0x8f877a, 0xaa9f88]));
      s.wallMat = MAT.gravel;
      s.plinth = s.wall.clone().multiplyScalar(0.8);
      s.roof = C(r.pick([0x41474e, 0x52575c, 0x3c4147]));
      s.roofKind = 'gable';
      s.pitch = r.range(1.0, 1.25);
      floors(0.25, 0.5);
      s.ov = 0.3; s.ovG = 0.12;
      s.fascia = s.roof; s.soffit = C(0x6a5a48);
      s.ws = { frame: C(r.pick([0xf0eee8, 0x6d8a9a, 0x6a4a32, 0x9aab8a])), bars: 3, shut: r.next() < 0.3 ? C(r.pick([0x5b7fa1, 0x6a4a32, 0x4f6b54])) : null, sill: C(0xcfc6b2), surround: C(0xd8cfbb) };
      s.winW = 0.95; s.winH = 1.25;
      s.chimney = 2;
      s.dormers = s.floors === 2 ? 0 : 2;
      s.eaveDormer = true;
      s.garage = pickW(r, [['none', 0.55], ['garage', 0.25], ['carport', 0.2]]);
      s.garageRoof = 'gable';
      s.fence = pickW(r, [['wall', 0.6], ['hedge', 0.4]]);
      s.porch = r.next() < 0.3 ? 'gable' : 'none';
      break;
    }
  }
  if (s.floors === 1.5 && s.dormers === 0 && style !== 'modern' && s.roofKind !== 'flat') s.dormers = r.next() < 0.6 ? 1 + Math.floor(r.next() * 2) : 0;
  if (s.roofKind === 'hip' && s.floors === 1.5) s.dormers = Math.max(1, s.dormers);
  return s;
}

export function ruralHouse(mb: MeshBuilder, c: RuralCtx): TreeSpot[] {
  const r = new Rng((Math.imul(c.seed | 0, 2654435761) ^ 0x5bd1e995) >>> 0);
  const k = new Kit(mb, c, r);
  const S = houseSpec(r, houseStyle(r, ruralRegion(c.cx, c.cz)));
  buildHouse(k, S);
  return k.end();
}

function buildHouse(k: Kit, S: HS) {
  const r = k.r;
  // ---- 配置 ----
  const g = r.next() < 0.5 ? -1 : 1; // 車庫の側（敷地の x の向き）
  const hasG = S.garage !== 'none';
  let L = S.floors === 1 ? r.range(9.6, 11.6) : r.range(8.4, 10.6); // 棟の向きの長さ
  let D = S.floors === 1 ? r.range(7.6, 9.0) : r.range(7.0, 8.4); // 奥行き
  if (S.style === 'alpine') { L = r.range(9.5, 11); D = r.range(8.5, 9.6); }
  if (S.gableToRoad) L = Math.min(L, 9.6);
  // 敷地の x の向きに収まるように縮める（車庫の分をあける）
  const maxX = hasG ? 14.4 - 3.9 : 14.4;
  const sx = Math.min(1, maxX / (S.gableToRoad ? D : L));
  if (S.gableToRoad) D *= sx; else L *= sx;
  const EX = S.gableToRoad ? D : L, EZ = S.gableToRoad ? L : D;
  const hx = hasG ? -g * (3.9 / 2) + r.range(-0.3, 0.3) : r.range(-0.7, 0.7);
  const zF = Math.min(r.range(1.0, 2.6), 7.0 - EZ + 2.6 + 0.4);
  const hz = Math.max(-7.1 + EZ / 2, zF - EZ / 2);
  const rot = S.gableToRoad ? PI / 2 : 0;

  // ---- 地面のもの（小道・車寄せ）を先に ----
  const front = hz + EZ / 2; // 敷地の z（正面の壁）
  k.at(0, 0, 0);
  const doorX = S.gableToRoad ? hx + (r.next() < 0.5 ? 0 : (r.next() < 0.5 ? -1 : 1) * EX * 0.22) : hx + (r.next() < 0.4 ? 0 : -g * EX * 0.25);
  const pathC = C(r.pick([0xa8a49a, 0xb7ae9c, 0x9c968c]));
  patch(k, doorX - 0.6, front + 0.8, doorX + 0.6, 7.9, LIFT + 0.1, pathC, S.style === 'modern' ? MAT.concrete : MAT.brick);
  const gx0 = hx + g * (EX / 2) + (g > 0 ? 0.3 : -3.8), gx1 = gx0 + 3.5; // 車庫の敷地の x
  const gFront = Math.min(7.0, front - r.range(0, 1.2));
  if (hasG) {
    const dc = C(r.pick([0x8f8b84, 0xa39b8a, 0x77736d]));
    patch(k, gx0 + 0.2, gFront, gx1 - 0.2, 7.95, LIFT + 0.09, dc, r.next() < 0.5 ? MAT.gravel : MAT.brick);
  }

  // ---- 本体 ----
  k.at(hx, hz, rot);
  const x0 = -L / 2, x1 = L / 2, z0 = -D / 2, z1 = D / 2;
  const [fl, lo] = floorAt(k, x0, z0, x1, z1, 0.35);
  const eaveH = S.floors === 1 ? 2.95 : S.floors === 1.5 ? 3.9 : 5.75;
  const top = fl + eaveH;
  const W = sides(x0, z0, x1, z1);
  // 正面（敷地の +z を向く面）
  const fi = S.gableToRoad ? 1 : 0, bi = (fi + 2) % 4;
  // 車庫の側の面
  const gi = S.gableToRoad ? (g > 0 ? 2 : 0) : (g > 0 ? 1 : 3);
  // 近代的な2階建ての平屋根：2階は別の箱（片側へ張り出す、ちがう外壁）
  const split = S.roofKind === 'flat' && S.floors === 2;
  let UV: [number, number, number, number] = [x0, z0, x1, z1];
  let UC = S.wall, UM = S.wallMat, UVert = S.vert;
  if (split) {
    const Lu = L * r.range(0.62, 0.8);
    let over = r.range(0.6, 1.5);
    const edge = (u: number) => Math.abs(hx + u) + Lu / 2;
    let ux = -g * ((L - Lu) / 2 + over);
    while (edge(ux) > 7.2 && over > 0) { over -= 0.2; ux = -g * ((L - Lu) / 2 + over); }
    UV = [ux - Lu / 2, z0 + r.range(0, 0.8), ux + Lu / 2, z1 + r.range(0, 0.9)];
    const light = S.wall.getHex() === 0xf3f3f1 || S.wall.getHex() === 0xd9d4ca;
    const pick = r.next();
    if (light) { UC = pick < 0.6 ? C(0xa57b52) : C(0x2e3033); UM = MAT.siding; UVert = true; }
    else { UC = C(0xf3f3f1); UM = MAT.plaster; UVert = false; }
    body(k, x0, z0, x1, z1, fl, fl + 3.0, S.wall, S.wallMat, S.plinth, S.vert, lo);
    box(k, x0 - 0.12, fl + 3.0, z0 - 0.12, x1 + 0.12, fl + 3.3, z1 + 0.12, C(0xe8e8e4), MAT.plaster, { top: C(0x8a8c8e) });
    box(k, UV[0], fl + 3.3, UV[1], UV[2], top, UV[3], UC, UM, { top: null, vert: UVert, vb: fl + 2 });
    // 張り出した下の面（軒裏）
    k.m(MAT.none);
    k.mb.quad([UV[0], fl + 3.3, UV[1]], [UV[2], fl + 3.3, UV[1]], [UV[2], fl + 3.3, UV[3]], [UV[0], fl + 3.3, UV[3]], C(0x3a3d40));
  } else if (S.upper) {
    body(k, x0, z0, x1, z1, fl, fl + 2.95, S.wall, S.wallMat, S.plinth, S.vert, lo);
    box(k, x0 - 0.04, fl + 2.95, z0 - 0.04, x1 + 0.04, top, z1 + 0.04, S.upper.col, S.upper.mat, { top: null, vert: S.upper.vert, vb: fl - 3 });
  } else body(k, x0, z0, x1, z1, fl, top, S.wall, S.wallMat, S.plinth, S.vert, lo);
  // 北欧：白い角の板と、軒の下の帯
  if (S.trim) {
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) box(k, cx - 0.1, fl + 0.25, cz - 0.1, cx + 0.1, top, cz + 0.1, S.trim, MAT.none, { top: null });
    box(k, x0 - 0.06, fl + 0.22, z0 - 0.06, x1 + 0.06, fl + 0.36, z1 + 0.06, S.trim, MAT.none, { top: null });
  }
  if (S.style === 'stone') for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) box(k, cx - 0.3, fl + 0.3, cz - 0.3, cx + 0.3, top - 0.05, cz + 0.3, S.ws.surround ?? S.wall, MAT.gravel, { top: null });

  // ---- 屋根 ----
  const rise = S.pitch * (D / 2);
  let R: RoofI | null = null;
  const rk = S.roofKind;
  const wallTop = S.upper ? S.upper.col : S.wall, wallTopMat = S.upper ? S.upper.mat : S.wallMat;
  if (rk === 'gable' || rk === 'hip' || rk === 'half') {
    const cc = rk === 'gable' ? 1 : rk === 'hip' ? 0 : r.range(0.6, 0.72);
    R = roof(k, x0, z0, x1, z1, top, rise, S.roof, wallTop, { ov: S.ov, ovG: S.ovG, c0: cc, c1: cc, fascia: S.fascia, soffit: S.soffit, wallMat: wallTopMat, roofMat: S.roofMat });
  } else if (rk === 'mansard') {
    // マンサード：急な下の斜面（屋根窓つき）と、ゆるい上の寄棟
    const m = 0.85, h1 = 2.7, y = top;
    k.m(MAT.shingle);
    const o = 0.25;
    const P = (x: number, yy: number, z: number): V3 => [x, yy, z];
    const lo4: V3[] = [P(x0 - o, y - 0.1, z1 + o), P(x1 + o, y - 0.1, z1 + o), P(x1 + o, y - 0.1, z0 - o), P(x0 - o, y - 0.1, z0 - o)];
    const hi4: V3[] = [P(x0 + m, y + h1, z1 - m), P(x1 - m, y + h1, z1 - m), P(x1 - m, y + h1, z0 + m), P(x0 + m, y + h1, z0 + m)];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; k.mb.quad(lo4[i], lo4[j], hi4[j], hi4[i], S.roof); }
    box(k, x0 - o, y - 0.3, z0 - o, x1 + o, y - 0.05, z1 + o, S.fascia, MAT.none, { top: null });
    roof(k, x0 + m, z0 + m, x1 - m, z1 - m, y + h1, (D / 2 - m) * 0.35, S.roof, S.wall, { ov: 0.12, c0: 0, c1: 0, t: 0.1, fascia: S.roof });
    // 下の斜面の屋根窓（前と後ろ）
    const nd = Math.max(1, Math.round((L - 2) / 3));
    for (const sgn of [1, -1]) {
      const Wd: Wall = { px: 0, pz: sgn * (D / 2 - 0.9), nx: 0, nz: sgn, len: L };
      for (let i = 0; i < nd; i++) {
        const a = -L / 2 + (L * (i + 0.5)) / nd;
        wbox(k, Wd, a - 0.7, a + 0.7, y - 0.2, y + 2.0, 0, 1.05, S.wall, MAT.plaster, 1);
        win(k, { ...Wd, pz: sgn * (D / 2 + 0.15) }, a, y + 0.45, 0.85, 1.2, { ...S.ws, shut: null, sill: null, box: null });
        wbox(k, Wd, a - 0.85, a + 0.85, y + 2.0, y + 2.2, -0.2, 1.2, S.roof, MAT.none, 0);
      }
    }
  } else if (rk === 'flat') {
    if (!split) {
      // 平屋：片側だけ少し高い、木（または濃い色）の箱
      const wl = L * r.range(0.3, 0.42), side = g;
      const ax0 = side > 0 ? x1 - wl : x0, ax1 = side > 0 ? x1 : x0 + wl;
      const acc = S.wall.getHex() === 0xa57b52 ? C(0x2e3033) : C(0xa57b52);
      box(k, ax0 - 0.05, top - 0.2, z0 - 0.35, ax1 + 0.05, top + 0.9, z1 + 0.35, acc, MAT.siding, { top: C(0x7d7f80), vert: true, vb: top - 3 });
      box(k, ax0 + (side > 0 ? 0.3 : 0.05), fl + 0.3, z1, ax1 - (side > 0 ? 0.05 : 0.3), top - 0.2, z1 + 0.35, acc, MAT.siding, { top: null, vert: true, skip: 2 });
      glass(k, sides(ax0, z0, ax1, z1 + 0.35)[0], -wl / 2 + 0.5, wl / 2 - 0.5, fl + 0.5, top - 0.5, 0.01);
    }
    const [ax, az, bx2, bz] = UV;
    box(k, ax - 0.25, top, az - 0.25, bx2 + 0.25, top + 0.35, bz + 0.25, C(0xe8e8e4), MAT.plaster, { top: C(0x7d7f80) });
    box(k, ax - 0.25, top + 0.35, az - 0.25, bx2 + 0.25, top + 0.42, bz + 0.25, C(0x6e7174), MAT.metal);
  } else {
    // 片流れ：後ろが高く、前が低い
    const yH = top + D * 0.22, yL = top + 0.2;
    k.m(MAT.metal);
    k.mb.quad([x0 - 0.3, yL + 0.15, z1 + 0.5], [x1 + 0.3, yL + 0.15, z1 + 0.5], [x1 + 0.3, yH + 0.15, z0 - 0.3], [x0 - 0.3, yH + 0.15, z0 - 0.3], S.roof);
    box(k, x0 - 0.3, yL - 0.05, z1 + 0.4, x1 + 0.3, yL + 0.15, z1 + 0.5, ANTH, MAT.none, { top: null });
    box(k, x0 - 0.3, yH - 0.1, z0 - 0.3, x1 + 0.3, yH + 0.15, z0 - 0.2, ANTH, MAT.none, { top: null });
    k.m(S.wallMat);
    // 横の壁（台形の上の部分）
    k.mb.quad([x1, top, z1], [x1, top, z0], [x1, yH, z0], [x1, yL, z1], S.wall);
    k.mb.quad([x0, top, z0], [x0, top, z1], [x0, yL, z1], [x0, yH, z0], S.wall);
    k.mb.quad([x1, top, z0], [x0, top, z0], [x0, yH, z0], [x1, yH, z0], S.wall);
    k.mb.quad([x0, top, z1], [x1, top, z1], [x1, yL, z1], [x0, yL, z1], S.wall);
    for (const sx2 of [x0 - 0.3, x1 + 0.3]) box(k, sx2 - 0.02, yL, z0 - 0.3, sx2 + 0.02, yL + 0.01, z1 + 0.5, ANTH, MAT.none, { top: null, skip: 1 | 2 });
  }

  // ---- 窓と戸 ----
  // 正面の壁の座標での戸の位置。妻入り（rot = π/2）でも、面 1 の a の向き（local の -z）は敷地の +x になる
  const dA = doorX - hx;
  const gf = fl + 0.3; // 1階の床の上
  const rows: [number, number][] = [[gf + 0.6 + (S.big ? -0.45 : 0.3), S.big ? 2.15 : S.winH]];
  if (S.floors === 2) rows.push([gf + 2.9 + 0.75, S.big ? 1.6 : S.winH]);
  const gableSide = (i: number) => i === 1 || i === 3;
  for (let i = 0; i < 4; i++) {
    const Wl = W[i];
    const isGable = gableSide(i);
    const len = Wl.len;
    const ww = S.big ? (isGable ? Math.min(S.winW, 1.6) : S.winW) : S.winW;
    const n = Math.max(1, Math.round((len - 1.4) / (S.big ? ww + 1.8 : 2.7)));
    for (let row = 0; row < rows.length; row++) {
      const [y0, h] = rows[row];
      if (i === gi && hasG && row === 0) continue;
      if (split && row === 1) continue;
      for (let j = 0; j < n; j++) {
        let a = -len / 2 + (len * (j + 0.5)) / n;
        if (S.big && n === 1) a = (r.next() - 0.5) * (len - ww - 1.6);
        if (i === fi && row === 0 && Math.abs(a - dA) < ww / 2 + 1.0) continue;
        if (S.big && row === 0 && i === bi && j === 0) {
          // 庭に出る大きなガラス戸
          win(k, Wl, a, gf + 0.05, Math.min(len - 2, ww * 1.3), 2.3, S.ws);
          continue;
        }
        if (S.big && r.next() < 0.3) continue;
        win(k, Wl, a, y0, ww, h, S.ws);
      }
    }
    // 屋根裏（妻壁）の窓
    if (isGable && R && rk !== 'hip') {
      const yA = top + 0.55;
      const room = (R.hd - (yA + 1.3 - top) / R.kk) * (rk === 'half' ? 0.8 : 1);
      if (room > 0.9) {
        const nn = S.floors === 1.5 && room > 2.6 ? 2 : 1;
        for (let j = 0; j < nn; j++) {
          const a = nn === 1 ? 0 : (j - 0.5) * 1.9;
          win(k, Wl, a, yA, S.big ? 1.2 : 0.9, S.floors === 1.5 ? 1.2 : 1.0, { ...S.ws, box: null });
        }
      }
    }
  }
  if (split) {
    // 2階の箱：長い横長の窓と、大きな窓
    const US = sides(UV[0], UV[1], UV[2], UV[3]);
    const y2 = fl + 3.3 + 0.75;
    for (let i = 0; i < 4; i++) {
      const Wu = US[i];
      if (i === 0 || i === 2) {
        const wl = Wu.len * r.range(0.45, 0.7);
        win(k, Wu, (r.next() - 0.5) * (Wu.len - wl - 0.8), y2 - 0.25, wl, 1.3, S.ws);
      } else if (r.next() < 0.7) win(k, Wu, (r.next() - 0.5) * (Wu.len - 2.6), y2 - 0.55, 1.4, 1.9, S.ws);
    }
  }
  // 玄関
  const FW = W[fi];
  if (S.style === 'modern' && !split) {
    // 玄関のまわりの木の板（アクセント）
    const wood = S.wall.getHex() === 0xa57b52 ? C(0x2e3033) : C(0xa57b52);
    const aL = Math.max(-FW.len / 2 + 0.1, dA - 1.1), aR = Math.min(FW.len / 2 - 0.1, dA + r.range(1.3, 2.4));
    wbox(k, FW, aL, aR, gf - 0.05, Math.min(top - 0.05, gf + (S.floors === 2 ? 5.3 : 2.75)), 0, 0.05, wood, MAT.siding, 2);
  }
  door(k, FW, dA, gf, 1.05, 2.15, S.doorC, S.ws.frame === ANTH ? ANTH : S.trim ?? WHITE);
  {
    // 玄関の段
    const st = (d: number, h: number) => wbox(k, FW, dA - 0.9, dA + 0.9, fl - 0.6, h, 0, d, C(0xa9a59d), MAT.concrete, 0);
    st(1.0, fl + 0.12);
    st(0.55, fl + 0.3);
  }
  if (S.porch === 'canopy') {
    wbox(k, FW, dA - 1.0, dA + 1.0, gf + 2.45, gf + 2.6, 0, 1.15, S.style === 'modern' ? ANTH : S.fascia, MAT.none, 0);
  } else if (S.porch === 'gable' || S.porch === 'veranda') {
    const pw = S.porch === 'veranda' ? 2.8 : 2.2, pd = S.porch === 'veranda' ? 2.0 : 1.5;
    const ver = S.porch === 'veranda';
    k.push(FW.px + FW.nz * dA + FW.nx * (pd / 2), FW.pz - FW.nx * dA + FW.nz * (pd / 2), Math.atan2(-FW.nx, FW.nz));
    // ここでの座標：+z = 外向き
    const trim = S.trim ?? WHITE;
    if (ver) {
      // ガラス張りの玄関ポーチ（北欧）
      box(k, -pw / 2, fl - 0.5, -pd / 2, pw / 2, gf, pd / 2, S.plinth, MAT.concrete);
      box(k, -pw / 2, gf, -pd / 2, pw / 2, gf + 0.9, pd / 2, S.wall, S.wallMat, { top: null, vert: S.vert, skip: 2 });
      const PS = sides(-pw / 2, -pd / 2, pw / 2, pd / 2);
      for (const i of [0, 1, 3]) {
        const Wp = PS[i];
        glass(k, Wp, -Wp.len / 2 + 0.12, Wp.len / 2 - 0.12, gf + 0.9, gf + 2.3, 0.01);
        for (const a of [-Wp.len / 2 + 0.06, 0, Wp.len / 2 - 0.06]) wbox(k, Wp, a - 0.06, a + 0.06, gf + 0.9, gf + 2.35, 0, 0.04, trim, MAT.none, 3);
      }
      box(k, -pw / 2, gf + 2.3, -pd / 2, pw / 2, gf + 2.45, pd / 2, trim, MAT.none, { top: null, skip: 2 });
      k.push(0, 0, PI / 2);
      roof(k, -pd / 2 - 0.3, -pw / 2, pd / 2, pw / 2, gf + 2.45, pw * 0.38, S.roof, trim, { ov: 0.2, ovG: 0.15, t: 0.12, fascia: trim, wallMat: MAT.none });
      k.pop();
    } else {
      for (const px of [-pw / 2 + 0.12, pw / 2 - 0.12]) box(k, px - 0.08, fl, pd / 2 - 0.2, px + 0.08, gf + 2.4, pd / 2 - 0.04, trim === WHITE && S.style !== 'nordic' ? C(0x6a4a32) : trim, MAT.none);
      k.push(0, 0, PI / 2);
      roof(k, -pd / 2 - 0.2, -pw / 2, pd / 2, pw / 2, gf + 2.4, pw * 0.42, S.roof, S.fascia, { ov: 0.15, ovG: 0.2, t: 0.12, fascia: S.fascia, wallMat: MAT.none, roofMat: S.roofMat });
      k.pop();
    }
    k.pop();
  }

  // ---- 屋根の上（屋根窓、煙突、天窓、太陽光パネル） ----
  let solarDone = false;
  if (R) {
    // 前の斜面（local +z）が敷地の正面（gableToRoad でなければ）
    const nd = S.dormers;
    const span = L - 2.4;
    const placed: number[] = [];
    if (nd > 0 && rk !== 'mansard') {
      const dw = S.eaveDormer ? 1.5 : S.dormerShed ? Math.min(span * 0.6, 3.2) : r.range(1.6, 2.1);
      const cnt = S.dormerShed ? 1 : Math.min(nd, Math.floor(span / (dw + 1.0)));
      for (let i = 0; i < cnt; i++) {
        const dx = cnt === 1 ? (r.next() - 0.5) * 0.6 : -span / 2 + (span * (i + 0.5)) / cnt;
        placed.push(dx);
        const zf = S.eaveDormer ? z1 : z1 - r.range(0.6, 1.0);
        dormer(k, R, dx, dw, S.eaveDormer ? 1.8 : 1.55, zf, S.roof, S.style === 'nordic' || S.style === 'alpine' ? S.wall : S.style === 'brick' ? S.wall : S.wall, S.wallMat === MAT.gravel ? MAT.gravel : S.wallMat, S.ws, S.dormerShed);
        if (S.style === 'nordic' || S.style === 'brick') {
          // 後ろの斜面にも
          k.push(0, 0, PI);
          dormer(k, { ...R }, -dx, dw, 1.5, z1 - 0.8, S.roof, S.wall, S.wallMat, S.ws, S.dormerShed);
          k.pop();
        }
      }
    }
    // 煙突
    for (let i = 0; i < S.chimney; i++) {
      const cxp = S.chimney === 2 ? (i ? x1 - 0.55 : x0 + 0.55) : (r.next() < 0.5 ? -1 : 1) * r.range(L * 0.15, L * 0.3);
      const czp = S.chimney === 2 ? R.zm : R.zm + (r.next() < 0.5 ? -1 : 1) * r.range(0.4, 1.2);
      const yb = roofY(R, czp) - 0.5;
      const ch = S.style === 'stone' ? S.wall : S.style === 'brick' ? S.wall.clone().multiplyScalar(0.9) : S.style === 'render' || S.style === 'alpine' ? S.wall : C(0x9b5a42);
      chimney(k, cxp, czp, S.chimney === 2 ? 0.9 : 0.6, S.chimney === 2 ? 0.7 : 0.6, yb, R.yt + 0.9 + (S.chimney === 2 ? 0.2 : 0), ch, S.style === 'stone' ? MAT.gravel : S.style === 'render' || S.style === 'alpine' ? MAT.plaster : MAT.brick);
    }
    // 太陽光パネル：屋根窓のない側（後ろ）か、前
    if (S.solar && rk !== 'mansard') {
      const side = placed.length ? -1 : r.next() < 0.5 ? 1 : -1;
      const inset = rk === 'gable' ? 0.6 : R.hd * 0.9;
      solar(k, R, side, x0 + inset, x1 - inset, rk === 'gable' ? (r.next() < 0.5 ? 2 : 1) : 1);
      solarDone = true;
    }
    if (S.skylights) {
      const side = placed.length ? 1 : -1;
      const nsk = 1 + r.int(2);
      for (let i = 0; i < nsk; i++) skylight(k, R, solarDone ? -side : side, (i - (nsk - 1) / 2) * 2.2 + 0.6, R.hd * 0.35);
    }
  }
  if (S.solar && rk === 'flat') {
    // 平らな屋根の上の、傾けた太陽光パネル
    k.m(MAT.none);
    const yy = top + 0.5;
    for (let row = 0; row < 2; row++) {
      const za = UV[1] + 1.2 + row * 2.2, zb = za + 1.5;
      const x0p = UV[0] + 1.0, x1p = UV[2] - 1.0;
      k.mb.quad([x0p, yy + 0.2, zb], [x1p, yy + 0.2, zb], [x1p, yy + 0.75, za], [x0p, yy + 0.75, za], PANEL);
      k.mb.quad([x0p, yy, za], [x1p, yy, za], [x1p, yy + 0.75, za], [x0p, yy + 0.75, za], C(0x8a8d90));
    }
  }

  // ---- バルコニー（アルプス：2階の正面にぐるりと木の手すり） ----
  if (S.balcony) {
    const BW = W[fi];
    const yb = fl + 3.15;
    wbox(k, BW, -BW.len / 2 - 0.2, BW.len / 2 + 0.2, yb - 0.2, yb, 0, 1.3, S.upper?.col ?? WOODF, MAT.siding, 0);
    wbox(k, BW, -BW.len / 2 - 0.2, BW.len / 2 + 0.2, yb, yb + 1.0, 1.22, 1.3, S.upper?.col ?? WOODF, MAT.siding, 0);
    if (S.ws.box) {
      const nb = Math.max(2, Math.floor(BW.len / 2.2));
      for (let i = 0; i < nb; i++) { const a = -BW.len / 2 + (BW.len * (i + 0.5)) / nb; wbox(k, BW, a - 0.55, a + 0.55, yb + 0.98, yb + 1.18, 1.14, 1.4, i % 2 ? HEDGE[2] : S.ws.box, MAT.none, 0, PAT.gardenLeaf); }
    }
  }

  // ---- 温室（裏） ----
  if (S.conserv) {
    const BW = W[bi];
    const cw = Math.min(4.2, BW.len - 2), cd = 2.8, a = (r.next() - 0.5) * (BW.len - cw - 1);
    k.push(BW.px + BW.nz * a + BW.nx * (cd / 2), BW.pz - BW.nx * a + BW.nz * (cd / 2), Math.atan2(-BW.nx, BW.nz));
    const [cfl] = floorAt(k, -cw / 2, -cd / 2, cw / 2, cd / 2, 0.2);
    box(k, -cw / 2, lo - 0.3, -cd / 2, cw / 2, Math.max(cfl, gf) + 0.5, cd / 2, S.plinth, S.wallMat === MAT.brick ? MAT.brick : MAT.concrete, { skip: 2 });
    const yb = Math.max(cfl, gf) + 0.5, yt = gf + 2.4;
    const CS = sides(-cw / 2, -cd / 2, cw / 2, cd / 2);
    for (const i of [0, 1, 3]) {
      const Wc = CS[i];
      glass(k, Wc, -Wc.len / 2, Wc.len / 2, yb, yt, 0);
      const nb = Math.max(2, Math.round(Wc.len / 0.9));
      for (let j = 0; j <= nb; j++) { const aa = -Wc.len / 2 + (Wc.len * j) / nb; wbox(k, Wc, aa - 0.04, aa + 0.04, yb, yt, 0, 0.05, WHITE, MAT.none, 3); }
    }
    k.m(MAT.none);
    k.mb.quad([-cw / 2 - 0.1, yt, cd / 2 + 0.1], [cw / 2 + 0.1, yt, cd / 2 + 0.1], [cw / 2 + 0.1, yt + 0.9, -cd / 2], [-cw / 2 - 0.1, yt + 0.9, -cd / 2], C(0x55656e));
    for (let j = 0; j <= 4; j++) { const xx = -cw / 2 - 0.1 + ((cw + 0.2) * j) / 4; k.mb.quad([xx - 0.04, yt + 0.02, cd / 2 + 0.1], [xx + 0.04, yt + 0.02, cd / 2 + 0.1], [xx + 0.04, yt + 0.92, -cd / 2], [xx - 0.04, yt + 0.92, -cd / 2], WHITE); }
    k.pop();
  }

  // ---- 車庫・カーポート ----
  if (hasG) {
    k.at(0, 0, 0);
    const gd = 6.2, gz1 = Math.min(gFront, front + 0.2), gz0 = gz1 - gd;
    const gw0 = gx0 + 0.1, gw1 = gx1 - 0.1;
    if (S.garage === 'garage') {
      const [gfl, glo] = floorAt(k, gw0, gz0, gw1, gz1, 0.08);
      const gt = gfl + 2.75;
      body(k, gw0, gz0, gw1, gz1, gfl - 0.25, gt, S.upper ? S.wall : S.wall, S.wallMat, S.plinth, S.vert, glo);
      const GW = sides(gw0, gz0, gw1, gz1)[0];
      const gdC = C(r.pick([0xe8e8e4, 0x3a3d40, 0x8a6a48, 0xb8bcc0]));
      wbox(k, GW, -1.25, 1.25, gfl, gfl + 2.1, 0, 0.05, gdC, MAT.siding, 2);
      if (S.garageRoof === 'flat' || S.style === 'modern') {
        box(k, gw0 - 0.12, gt, gz0 - 0.12, gw1 + 0.12, gt + 0.3, gz1 + 0.12, S.style === 'modern' ? ANTH : S.fascia, MAT.none, { top: C(0x6e7072) });
      } else {
        k.push((gw0 + gw1) / 2, (gz0 + gz1) / 2, PI / 2);
        roof(k, -gd / 2, -(gw1 - gw0) / 2, gd / 2, (gw1 - gw0) / 2, gt, (gw1 - gw0) * 0.5 * Math.min(S.pitch, 0.8), S.roof, S.wall, { ov: 0.3, ovG: 0.3, fascia: S.fascia, soffit: S.soffit, wallMat: S.wallMat, roofMat: S.roofMat });
        k.pop();
      }
    } else {
      // カーポート：4本の柱と平らな屋根
      const [gfl] = floorAt(k, gw0, gz0, gw1, gz1, 0);
      const pc = S.style === 'modern' ? ANTH : S.style === 'nordic' ? (S.trim ?? WHITE) : WOODF;
      for (const [px, pz] of [[gw0 + 0.15, gz0 + 0.2], [gw1 - 0.15, gz0 + 0.2], [gw0 + 0.15, gz1 - 0.2], [gw1 - 0.15, gz1 - 0.2]]) box(k, px - 0.08, k.gh(px, pz) - 0.2, pz - 0.08, px + 0.08, gfl + 2.5, pz + 0.08, pc, MAT.none);
      box(k, gw0 - 0.1, gfl + 2.5, gz0 - 0.1, gw1 + 0.1, gfl + 2.72, gz1 + 0.2, pc, MAT.none, { top: C(0x6e7072) });
    }
    if (r.next() < 0.55) car(k, (gx0 + gx1) / 2, S.garage === 'garage' ? Math.min(gz1 + 2.6, 5.4) : (gz0 + gz1) / 2, r.next() < 0.5 ? 0 : PI);
  } else if (r.next() < 0.3) {
    k.at(0, 0, 0);
    const cxp = hx + g * (EX / 2 + 1.6);
    if (Math.abs(cxp) < 6.2) {
      patch(k, cxp - 1.3, front - 2.5, cxp + 1.3, 7.95, LIFT + 0.09, C(0x9a958b), MAT.gravel);
      car(k, cxp, front + 1.2, 0);
    }
  }

  // ---- 庭 ----
  k.at(0, 0, 0);
  // 花壇と茂み（正面の壁ぞい）
  if (S.style !== 'modern' || r.next() < 0.5) {
    const fx0 = hx - EX / 2 + 0.3, fx1 = hx + EX / 2 - 0.3;
    const gapA = doorX - 1.0, gapB = doorX + 1.0;
    if (gapA - fx0 > 1.2) flowerBed(k, fx0, gapA, front + 0.2, front + 0.75);
    if (fx1 - gapB > 1.2 && !(hasG && g > 0 && S.style === 'modern')) flowerBed(k, gapB, fx1, front + 0.2, front + 0.75);
  } else {
    // 砂利の帯
    patch(k, hx - EX / 2, front + 0.05, hx + EX / 2, front + 0.7, LIFT + 0.06, C(0xb5b0a6), MAT.gravel);
  }
  for (let i = 0; i < 2 + r.int(3); i++) {
    const sxp = r.range(-6.8, 6.8), szp = r.range(front + 1.6, 6.6);
    if (Math.abs(sxp - doorX) < 1.4 || (hasG && sxp > gx0 - 0.6 && sxp < gx1 + 0.6)) continue;
    shrub(k, sxp, szp, r.range(0.5, 0.95), r.range(0.7, 1.4), HEDGE[r.int(4)]);
  }
  // 物置（裏の、車庫と反対の角）
  const backZ = hz - EZ / 2;
  if (r.next() < 0.6 && backZ > -4.2) {
    const shx = -g * 5.6, shz = -6.0;
    const SC = S.style === 'nordic' ? S.wall : C(r.pick([0x6f7d6a, 0x8a6a48, 0x8b2c22, 0x3a3d3f, 0xa58a68]));
    shed(k, shx, shz, g > 0 ? PI / 2 : -PI / 2, 2.6, 2.2, SC, C(0x34373a), S.style === 'nordic' ? (S.trim ?? WHITE) : SC.clone().multiplyScalar(0.8));
  }
  // テラス（裏）と、パラソル
  if (r.next() < 0.45 && backZ > -5.2) {
    const tx = hx + r.range(-1.5, 1.5);
    patch(k, tx - 2.2, Math.max(-7.4, backZ - 2.8), tx + 2.2, backZ - 0.05, LIFT + 0.1, C(r.pick([0xb5ada0, 0x9c968c, 0x8a6a4a])), S.style === 'modern' ? MAT.concrete : MAT.brick);
    const ty = k.gh(tx, backZ - 1.5) + LIFT + 0.1;
    box(k, tx - 0.5, ty, backZ - 2.0, tx + 0.5, ty + 0.75, backZ - 1.1, C(0x7a6450), MAT.none);
    if (r.next() < 0.6) {
      box(k, tx - 0.03, ty, backZ - 1.58, tx + 0.03, ty + 2.2, backZ - 1.52, C(0x9a9a9a), MAT.none, { top: null });
      const pc = C(r.pick([0xe8e2d2, 0x2e3b4e, 0xb03a2e, 0x6e7f5a]));
      const ring: V3[] = [];
      for (let s = 0; s < 6; s++) { const a = (s / 6) * PI * 2; ring.push([tx + Math.cos(a) * 1.4, ty + 1.85, backZ - 1.55 + Math.sin(a) * 1.4]); }
      k.m(MAT.none);
      for (let s = 0; s < 6; s++) k.mb.tri([tx, ty + 2.35, backZ - 1.55], ring[(s + 1) % 6], ring[s], pc);
    }
  }
  // 家庭菜園（木の枠の畑）
  if (r.next() < 0.3 && backZ > -4) {
    for (let i = 0; i < 2; i++) {
      const bxp = g * (1.0 + i * 1.8) - 1.2 * g, bzp = -6.4;
      const gyb = k.gh(bxp, bzp);
      box(k, bxp - 0.6, gyb - 0.2, bzp - 1.2, bxp + 0.6, gyb + 0.45, bzp + 1.2, C(0x8a6a48), MAT.siding, { top: C(0x4f6b2e), pat: 0 });
    }
  }

  // ---- 垣根・柵 ----
  buildBoundary(k, S, doorX, hasG ? [gx0, gx1] : null);

  // ---- 木 ----
  const tk = S.style === 'nordic' ? [0, 0, 1] : [0, 0, 0, 1];
  const nt = 1 + r.int(3);
  const spots: [number, number][] = [[-g * 5.6, 5.6], [g * 5.8, -5.5], [-g * 5.4, -1.0], [g * 2.5, -6.4], [-g * 2.0, -6.6]];
  for (let i = 0; i < nt; i++) {
    const [tx, tz] = spots[(i + r.int(2)) % spots.length];
    if (tz > 0 && Math.abs(tx - doorX) < 2) continue;
    if (hasG && tx > gx0 - 1 && tx < gx1 + 1 && tz > gFront - 7) continue;
    const kind = r.pick(tk);
    if (kind === 1) k.tree(tx, tz, r.range(0.45, 0.65), 1, r.next() < 0.3 ? 1 : 0);
    else if (S.style === 'nordic' && r.next() < 0.6) k.tree(tx, tz, r.range(0.55, 0.8), 0, 1, 0x7a9a48); // シラカバ
    else k.tree(tx, tz, r.range(0.45, 0.75), 0, r.next() < 0.5 ? 0 : 3, r.next() < 0.5 ? 0x5f7f34 : undefined);
  }
}

// 敷地のまわりの垣根・柵（正面は入口と車寄せをあける）
function buildBoundary(k: Kit, S: HS, doorX: number, gar: [number, number] | null) {
  const r = k.r;
  k.at(0, 0, 0);
  const E = 7.75;
  // 正面のすき間
  const gaps: [number, number][] = [[doorX - 0.7, doorX + 0.7]];
  if (gar) gaps.push([gar[0] + 0.05, gar[1] - 0.05]);
  gaps.sort((a, b) => a[0] - b[0]);
  const segs: [number, number][] = [];
  let x = -E;
  for (const [a, b] of gaps) { if (a - x > 0.3) segs.push([x, a]); x = Math.max(x, b); }
  if (E - x > 0.3) segs.push([x, E]);
  const hc = HEDGE[r.int(4)];
  const sideKind = S.fence === 'picket' || S.fence === 'wall' || S.fence === 'gabion' || S.fence === 'lowhedge' ? (r.next() < 0.6 ? 'hedge' : 'rail') : S.fence;
  // 正面
  for (const [a, b] of segs) {
    switch (S.fence) {
      case 'hedge': hedge(k, a, E - 0.45, b, E + 0.2, 1.15, hc); break;
      case 'lowhedge': hedge(k, a, E - 0.35, b, E + 0.2, 0.6, hc); break;
      case 'picket': picket(k, a, b, E, S.trim ?? WHITE); break;
      case 'wall': lowWall(k, a, E - 0.3, b, E + 0.15, 0.85, S.style === 'stone' ? S.wall : S.wall, S.style === 'stone' ? MAT.gravel : MAT.plaster, C(0xc9c2b4)); break;
      case 'rail': railFence(k, a, E, b, E, S.style === 'alpine' ? C(0x7a5233) : C(0x8a7458), 1.0, 2, 2.2); break;
      case 'slat': {
        const [lo, hi] = k.span(a, E - 0.05, b, E + 0.05);
        box(k, a, lo - 0.3, E - 0.05, b, (lo + hi) / 2 + 1.0, E + 0.05, C(r.pick([0x3a3d40, 0x8a6a48, 0x6e6a64])), MAT.siding, { vb: lo });
        break;
      }
      case 'gabion': lowWall(k, a, E - 0.3, b, E + 0.15, 0.9, C(0x9a958c), MAT.gravel, C(0x6e7072)); break;
    }
  }
  // 門柱（低い塀や柵のとき）
  if (S.fence === 'wall' || S.fence === 'gabion' || S.fence === 'slat')
    for (const px of [doorX - 0.8, doorX + 0.8]) { const g = k.gh(px, E); box(k, px - 0.22, g - 0.3, E - 0.3, px + 0.22, g + 1.25, E + 0.15, S.fence === 'slat' ? ANTH : C(0xc9c2b4), MAT.concrete); }
  // 横と裏
  const sideSeg = (ax: number, az: number, bx: number, bz: number, back: boolean) => {
    const vert = ax === bx;
    switch (sideKind) {
      case 'hedge': if (vert) hedge(k, ax - 0.4, Math.min(az, bz), ax + 0.4, Math.max(az, bz), back ? 1.8 : 1.6, hc); else hedge(k, Math.min(ax, bx), az - 0.4, Math.max(ax, bx), az + 0.4, 1.8, hc); break;
      case 'slat': {
        const x0 = vert ? ax - 0.05 : Math.min(ax, bx), x1 = vert ? ax + 0.05 : Math.max(ax, bx), z0 = vert ? Math.min(az, bz) : az - 0.05, z1 = vert ? Math.max(az, bz) : az + 0.05;
        const [lo, hi] = k.span(x0, z0, x1, z1);
        box(k, x0, lo - 0.3, z0, x1, (lo + hi) / 2 + 1.7, z1, C(0x6e5a46), MAT.siding, { vb: lo });
        break;
      }
      default: railFence(k, ax, az, bx, bz, S.style === 'nordic' ? C(0x9a9a92) : C(0x8a7458), 1.1, 2, 2.6);
    }
  };
  sideSeg(-E, -E, -E, E - 0.5, false);
  sideSeg(E, -E, E, E - 0.5, false);
  sideSeg(-E + 0.4, -E, E - 0.4, -E, true);
}

// ======================================================================
//                          農家（32×32m）
// ======================================================================
export function farmstead(mb: MeshBuilder, c: RuralCtx): TreeSpot[] {
  const r = new Rng((Math.imul(c.seed | 0, 2246822519) ^ 0x27d4eb2f) >>> 0);
  const k = new Kit(mb, c, r);
  const reg = ruralRegion(c.cx, c.cz);
  const type = r.next() < 0.75 ? reg : r.int(5);
  [longere, stolp, hallenhaus, vierseithof, nordicFarm][type](k);
  return k.end();
}
// 型を指定して作る（確認用）
export function farmsteadOfType(mb: MeshBuilder, c: RuralCtx, type: number): TreeSpot[] {
  const r = new Rng((Math.imul(c.seed | 0, 2246822519) ^ 0x27d4eb2f) >>> 0);
  const k = new Kit(mb, c, r);
  [longere, stolp, hallenhaus, vierseithof, nordicFarm][type % 5](k);
  return k.end();
}
export function ruralHouseOfStyle(mb: MeshBuilder, c: RuralCtx, style: number): TreeSpot[] {
  const r = new Rng((Math.imul(c.seed | 0, 2654435761) ^ 0x5bd1e995) >>> 0);
  const k = new Kit(mb, c, r);
  const st = (['render', 'french', 'brick', 'nordic', 'alpine', 'modern', 'stone'] as HouseStyle[])[style % 7];
  buildHouse(k, houseSpec(r, st));
  return k.end();
}

const YARD = { gravel: C(0xaaa08a), earth: C(0x8e8068), cobble: C(0x8f8b84), brick: C(0x8a5a48) };
const ORCH = 0x5f7f34;
function orchard(k: Kit, x0: number, z0: number, x1: number, z1: number, sp = 4.2) {
  const nx = Math.max(1, Math.floor((x1 - x0) / sp)), nz = Math.max(1, Math.floor((z1 - z0) / sp));
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      if (k.r.next() < 0.12) continue;
      const x = x0 + ((x1 - x0) * (i + 0.5)) / nx + (k.r.next() - 0.5) * 0.6, z = z0 + ((z1 - z0) * (j + 0.5)) / nz + (k.r.next() - 0.5) * 0.6;
      k.tree(x, z, k.r.range(0.42, 0.56), 0, 0, ORCH);
    }
}
// 一列の窓（壁 W、位置の一覧、下の高さ y0）
function winRow(k: Kit, W: Wall, as: number[], y0: number, w: number, h: number, s: WinS) {
  for (const a of as) win(k, W, a, y0, w, h, s);
}
// 木組み（ハーフティンバー）：壁 W の a0..a1、y0..y1 に柱・横木・筋かい
function timber(k: Kit, W: Wall, a0: number, a1: number, y0: number, y1: number, col: Col, sp = 1.25, rails = 1, top?: (a: number) => number) {
  const n = Math.max(1, Math.round((a1 - a0) / sp));
  const d0 = 0, d1 = 0.06;
  const yt = (a: number) => (top ? Math.min(y1, top(a)) : y1);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n, h = yt(a);
    if (h - y0 < 0.3) continue;
    wbox(k, W, a - 0.1, a + 0.1, y0, h, d0, d1, col, MAT.none, 3);
  }
  wbox(k, W, a0 - 0.1, a1 + 0.1, y0 - 0.12, y0 + 0.08, d0, d1 + 0.01, col, MAT.none, 2);
  if (!top) wbox(k, W, a0 - 0.1, a1 + 0.1, y1 - 0.1, y1 + 0.1, d0, d1 + 0.01, col, MAT.none, 2);
  for (let j = 1; j <= rails; j++) {
    const yr = y0 + ((y1 - y0) * j) / (rails + 1);
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n, b = a0 + ((a1 - a0) * (i + 1)) / n;
      if (yt(a) < yr + 0.2 || yt(b) < yr + 0.2) continue;
      wbox(k, W, a + 0.1, b - 0.1, yr - 0.08, yr + 0.08, d0, d1, col, MAT.none, 4);
    }
  }
  // 筋かい（両端のます）
  const yr1 = y0 + (y1 - y0) / (rails + 1);
  for (const i of [0, n - 1]) {
    if (n < 3) break;
    const a = a0 + ((a1 - a0) * i) / n, b = a0 + ((a1 - a0) * (i + 1)) / n;
    if (i === 0) wpara(k, W, a + 0.1, a + 0.32, y0 + 0.08, b - 0.32, b - 0.1, yr1 - 0.08, d1 - 0.005, col);
    else wpara(k, W, b - 0.32, b - 0.1, y0 + 0.08, a + 0.1, a + 0.32, yr1 - 0.08, d1 - 0.005, col);
  }
}

// ---- 0. フランスのロンジェール ----
function longere(k: Kit) {
  const r = k.r;
  const rendered = r.next() < 0.25;
  const stone = C(r.pick([0x9d978c, 0xb3a68c, 0x8a8274, 0xa89a80]));
  const wall = rendered ? C(0xe6dfd0) : stone, wmat = rendered ? MAT.plaster : MAT.gravel;
  const quoin = rendered ? C(0xb8ad98) : stone.clone().lerp(C(0xe0d8c8), 0.45);
  const rkind = r.next();
  const roofC = rkind < 0.6 ? C(r.pick([0x454b52, 0x3e444b])) : rkind < 0.8 ? C(0x7c6a4c) : C(0x9a5236);
  const roofM = rkind >= 0.6 && rkind < 0.8 ? THATCH : MAT.shingle; // 茅葺き
  const frame = C(r.pick([0xf0eee8, 0x7d97a6, 0x6a8a7a, 0x8a5a3a, 0xc8c2b4]));
  const wood = C(r.pick([0x5d4632, 0x3f5a46, 0x6a2c26, 0x4a5a6a]));
  const ws: WinS = { frame, bars: 3, shut: r.next() < 0.5 ? frame.clone().multiplyScalar(0.85) : null, sill: null, surround: rendered ? null : quoin };
  const flip = r.next() < 0.5 ? 1 : -1; // 家と納屋の左右
  // 建物（奥に一列）。z = -12.5..-5.5
  const z0 = -12.6, z1 = -5.4, D = z1 - z0;
  k.at(0, 0, 0);
  // 庭：前の半分は砂利、片側は果樹園の草地
  patch(k, -14.5, z1 - 0.2, 14.5, 3.5, LIFT + 0.1, r.next() < 0.5 ? YARD.gravel : YARD.earth, MAT.gravel);
  patch(k, flip * 2 - 2.2, 3.5, flip * 2 + 2.2, 15.9, LIFT + 0.09, YARD.gravel, MAT.gravel);
  const segs: [number, number, number, number, string][] = [];
  // 区間：[x0, x1, 軒の高さ, 屋根の高さ, 種類]
  const xs = [-14.5, -14.5 + r.range(10.5, 12.5)];
  xs.push(xs[1] + r.range(8, 10));
  xs.push(14.5);
  const eH = r.range(2.9, 3.2);
  segs.push([xs[0], xs[1], eH, D * 0.62, 'house']);
  segs.push([xs[1], xs[2], eH + r.range(0.3, 0.8), D * 0.65, 'barn']);
  if (xs[3] - xs[2] > 3) segs.push([xs[2], xs[3], eH - 0.4, D * 0.55, 'stable']);
  const [flA, lo] = floorAt(k, -14.5, z0, 14.5, z1, 0.2);
  for (let s = 0; s < segs.length; s++) {
    let [a, b, eh, rise, kind] = segs[s];
    if (flip < 0) { const t = a; a = -b; b = -t; }
    const fl = flA;
    body(k, a, z0, b, z1, fl - 0.25, fl + eh, wall, wmat, wall.clone().multiplyScalar(0.85), false, lo);
    // 角の石
    for (const cx of [a, b]) for (const cz of [z0, z1]) box(k, cx - 0.32, fl, cz - 0.32, cx + 0.32, fl + eh - 0.05, cz + 0.32, quoin, wmat, { top: null });
    const c0 = s === 0 && flip > 0 ? (r.next() < 0.3 ? 0.65 : 1) : 1;
    roof(k, a, z0, b, z1, fl + eh, rise, roofC, wall, { ov: 0.35, ovG: 0.15, wallMat: wmat, roofMat: roofM, t: roofM === THATCH ? 0.45 : 0.2, fascia: roofC, soffit: C(0x5a4a3a), c0: flip > 0 ? c0 : 1, c1: flip < 0 && s === 0 ? c0 : 1 });
    const F = sides(a, z0, b, z1)[0], B = sides(a, z0, b, z1)[2];
    const len = b - a;
    if (kind === 'house') {
      // 家：小さな窓、戸、屋根窓（軒を切る）、妻壁の高い煙突
      const n = Math.max(3, Math.round(len / 2.6));
      const da = (r.next() - 0.5) * len * 0.3;
      for (let i = 0; i < n; i++) {
        const aa = -len / 2 + (len * (i + 0.5)) / n;
        if (Math.abs(aa - da) < 1.0) continue;
        win(k, F, aa, fl + 0.85, 0.95, 1.25, ws);
      }
      door(k, F, da, fl, 1.0, 2.05, wood, rendered ? quoin : quoin, false);
      winRow(k, B, [-len * 0.25, len * 0.2], fl + 0.95, 0.8, 1.0, { ...ws, shut: null });
      const R: RoofI = { x0: a, x1: b, z0, z1, y: fl + eh, kk: rise / (D / 2), hd: D / 2, zm: (z0 + z1) / 2, yt: fl + eh + rise, t: 0.2 };
      for (const f of [-0.25, 0.25]) dormer(k, R, (a + b) / 2 + f * len, 1.3, 1.6, z1, roofC, wall, wmat, { ...ws, shut: null });
      for (const ex of [a + 0.5, b - 0.5]) {
        if ((flip > 0 && ex > (a + b) / 2) || (flip < 0 && ex < (a + b) / 2)) { chimney(k, ex + (flip > 0 ? -1.2 : 1.2), (z0 + z1) / 2, 0.8, 0.6, fl + eh, fl + eh + rise + 0.6, stone, MAT.gravel); continue; }
        chimney(k, ex, (z0 + z1) / 2, 1.0, 0.75, fl + eh, fl + eh + rise + 0.9, stone, MAT.gravel);
      }
    } else if (kind === 'barn') {
      // 納屋：大きなアーチの戸と、上の干し草の戸
      wbox(k, F, -1.9, 1.9, fl, fl + 3.4, 0, 0.08, quoin, wmat, 2);
      wbox(k, F, -1.6, 1.6, fl, fl + 3.15, 0.08, 0.12, wood, MAT.siding, 2);
      wbox(k, F, -0.05, 0.05, fl, fl + 3.15, 0.12, 0.13, C(0x2a2420), MAT.none, 3);
      if (eh > 3.3) wbox(k, F, len * 0.28 - 0.6, len * 0.28 + 0.6, fl + 1.2, fl + 2.4, 0.02, 0.07, wood, MAT.siding, 2);
      wbox(k, B, -1.4, 1.4, fl, fl + 2.8, 0.02, 0.07, wood, MAT.siding, 2);
    } else {
      // 家畜小屋：上下に分かれた戸と、小さな窓
      for (const aa of [-len * 0.22, len * 0.22]) {
        wbox(k, F, aa - 0.55, aa + 0.55, fl, fl + 2.0, 0.02, 0.07, wood, MAT.siding, 2);
        wbox(k, F, aa - 0.55, aa + 0.55, fl + 0.98, fl + 1.04, 0.07, 0.09, C(0x2a2420), MAT.none, 3);
      }
      win(k, F, 0, fl + 1.3, 0.6, 0.5, { ...ws, shut: null, bars: 0 });
    }
  }
  // 石の塀の庭（正面に門柱）
  const gx = flip * 2;
  const capC = quoin;
  lowWall(k, -15.6, 15.1, gx - 2.3, 15.6, 1.15, stone, MAT.gravel, capC);
  lowWall(k, gx + 2.3, 15.1, 15.6, 15.6, 1.15, stone, MAT.gravel, capC);
  lowWall(k, -15.6, -4.5, -15.1, 15.1, 1.15, stone, MAT.gravel, capC);
  lowWall(k, 15.1, -4.5, 15.6, 15.1, 1.15, stone, MAT.gravel, capC);
  for (const px of [gx - 2.5, gx + 2.5]) { const g = k.gh(px, 15.35); box(k, px - 0.4, g - 0.3, 14.95, px + 0.4, g + 2.1, 15.75, quoin, MAT.gravel); box(k, px - 0.5, g + 2.1, 14.85, px + 0.5, g + 2.3, 15.85, capC, MAT.concrete); }
  hedge(k, -15.8, -15.8, 15.8, -14.6, 2.0, HEDGE[r.int(4)]);
  hedge(k, -15.8, -14.6, -14.8, -4.5, 1.8, HEDGE[r.int(4)]);
  hedge(k, 14.8, -14.6, 15.8, -4.5, 1.8, HEDGE[r.int(4)]);
  // 井戸
  {
    const wx = -flip * 9.5, wz = -1.5, g = k.gh(wx, wz);
    k.m(MAT.gravel);
    k.mb.cylinder(wx, wz, g - 0.3, g + 0.85, 0.75, 10, stone, C(0x1a1c1e));
    for (const s of [-1, 1]) box(k, wx + s * 0.62 - 0.06, g + 0.85, wz - 0.06, wx + s * 0.62 + 0.06, g + 2.0, wz + 0.06, C(0x5d4632), MAT.none);
    k.push(wx, wz, 0);
    roof(k, -0.9, -0.6, 0.9, 0.6, g + 1.95, 0.55, roofC, C(0x5d4632), { ov: 0.15, ovG: 0.1, t: 0.08, wallMat: MAT.none });
    k.pop();
  }
  // 小さな離れ（パン焼き小屋）
  shed(k, flip * 10.8, 9.5, flip > 0 ? -PI / 2 : PI / 2, 3.6, 3.0, wall, roofC, wood, 2.3, wmat);
  // 果樹園（シードル用のリンゴ）
  orchard(k, flip > 0 ? -14.5 : 4.2, 4.2, flip > 0 ? -4.2 : 14.5, 14.6, 3.0);
  // 荷車の小屋（片流れ、前が開いている）
  lean(k, flip * 12.6, -1.2, flip > 0 ? -PI / 2 : PI / 2, 6.5, 3.6, 3.0, roofC, C(0x5d4632));
  if (r.next() < 0.75) tractor(k, flip * 6.0, -1.0, r.range(-0.6, 0.6) + PI / 2);
  for (let i = 0; i < 3; i++) bale(k, flip * (8.8 - i * 1.3), 3.0, PI / 2, BALE.straw);
  if (r.next() < 0.5) bale(k, flip * 8.15, 3.0, PI / 2, BALE.straw, 1.4);
  k.tree(-flip * 12.5, -3.2, r.range(1.2, 1.5), 0, 3);
}

// ---- 1. オランダのストルプ ----
function stolp(k: Kit) {
  const r = k.r;
  const brick = C(r.pick([0x8a4430, 0x7a3e2e, 0x9b5338, 0x6e3a2c]));
  const thatch = r.next() < 0.7;
  const roofC = thatch ? C(0x7a6748) : C(r.pick([0x34373a, 0x8a4430]));
  const skirt = C(r.pick([0x8a4430, 0x34373a]));
  const green = C(r.pick([0x2f5a3e, 0x2f4a3a, 0x3a5a4a]));
  const ws: WinS = { frame: WHITE, bars: 3, shut: r.next() < 0.6 ? green : null, sill: null };
  const flip = r.next() < 0.5 ? 1 : -1;
  k.at(0, 0, 0);
  // 庭（レンガ敷きの道と砂利）
  patch(k, -15, -2, 15, 4, LIFT + 0.1, YARD.gravel, MAT.gravel);
  patch(k, flip * 9 - 1.5, 4, flip * 9 + 1.5, 15.95, LIFT + 0.1, YARD.brick, MAT.brick);
  // ストルプ（四角錐の屋根の納屋）：一辺 17m
  const cx = -flip * 1.5, cz = -6.5, h = 8.4;
  k.at(cx, cz, 0);
  const [fl, lo] = floorAt(k, -h, -h, h, h, 0.2);
  const eave = fl + 2.7;
  body(k, -h, -h, h, h, fl - 0.25, eave, brick, MAT.brick, brick.clone().multiplyScalar(0.7), false, lo);
  const rise = h * 1.32;
  // 下の帯（瓦のすそ）と、上の茅葺き
  if (thatch) {
    const yb = eave + 1.6, ins = 1.6 / 1.32;
    roof(k, -h + ins, -h + ins, h - ins, h - ins, yb, rise - 1.6, roofC, brick, { ov: 0, c0: 0, c1: 0, t: 0.35, roofMat: THATCH, fascia: roofC });
    k.m(MAT.shingle);
    const o = 0.55, ye = eave - o * 1.32;
    const L4: V3[] = [[-h - o, ye, h + o], [h + o, ye, h + o], [h + o, ye, -h - o], [-h - o, ye, -h - o]];
    const H4: V3[] = [[-h + ins, yb + 0.2, h - ins], [h - ins, yb + 0.2, h - ins], [h - ins, yb + 0.2, -h + ins], [-h + ins, yb + 0.2, -h + ins]];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; k.mb.quad(L4[i], L4[j], H4[j], H4[i], skirt); }
    box(k, -h - o, ye - 0.15, -h - o, h + o, ye + 0.01, h + o, WHITE, MAT.none, { top: null });
  } else roof(k, -h, -h, h, h, eave, rise, roofC, brick, { ov: 0.55, c0: 0, c1: 0, fascia: WHITE });
  // 頂上の煙突
  chimney(k, flip * 0.9, 0.9, 0.7, 0.7, eave + rise - 2.2, eave + rise + 0.6, brick);
  const SW = sides(-h, -h, h, h);
  // 横の大きな納屋の戸（白い枠）
  const bs = SW[flip > 0 ? 1 : 3];
  wbox(k, bs, -2.1, 2.1, fl, fl + 2.65, 0, 0.06, WHITE, MAT.none, 2);
  wbox(k, bs, -1.9, 1.9, fl, fl + 2.5, 0.06, 0.1, green, MAT.siding, 2);
  winRow(k, SW[2], [-4.5, 0, 4.5], fl + 1.2, 1.1, 1.0, { ...ws, shut: null });
  winRow(k, SW[flip > 0 ? 3 : 1], [-5, 5], fl + 1.2, 1.0, 1.0, { ...ws, shut: null });
  // 前の母屋（レンガ、正面の妻、白い窓と緑の雨戸）
  const fw = r.range(7.5, 9), fd = 6.5;
  k.at(cx + flip * 1.2, cz + h + fd / 2 - 0.3, PI / 2);
  const [ffl, flo] = floorAt(k, -fd / 2, -fw / 2, fd / 2, fw / 2, 0.3);
  const fe = ffl + 3.6;
  body(k, -fd / 2 - 0.5, -fw / 2, fd / 2, fw / 2, ffl, fe, brick, MAT.brick, brick.clone().multiplyScalar(0.7), false, flo);
  roof(k, -fd / 2 - 0.5, -fw / 2, fd / 2, fw / 2, fe, (fw / 2) * 1.15, thatch ? skirt : roofC, brick, { ov: 0.3, ovG: 0.25, fascia: WHITE, soffit: WHITE, wallMat: MAT.brick });
  const FS = sides(-fd / 2 - 0.5, -fw / 2, fd / 2, fw / 2);
  winRow(k, FS[1], [-fw * 0.28, fw * 0.28], ffl + 1.2, 1.15, 1.6, ws);
  door(k, FS[1], 0, ffl + 0.3, 1.0, 2.2, green, WHITE);
  win(k, FS[1], 0, fe + 0.9, 1.0, 1.3, { ...ws, shut: null });
  win(k, FS[1], -1.6, fe + 0.5, 0.7, 0.9, { ...ws, shut: null });
  win(k, FS[1], 1.6, fe + 0.5, 0.7, 0.9, { ...ws, shut: null });
  winRow(k, FS[0], [-1.2, 1.4], ffl + 1.2, 1.1, 1.5, ws);
  winRow(k, FS[2], [-1.2, 1.4], ffl + 1.2, 1.1, 1.5, ws);
  // 白い妻の縁と、頂上の飾り（ウレンボルト）
  {
    const W1 = FS[1];
    const yt = fe + (fw / 2) * 1.15;
    wbox(k, W1, -0.12, 0.12, yt + 0.1, yt + 1.0, 0.25, 0.4, WHITE, MAT.none, 0);
  }
  // 干し草小屋（ホーイベルグ：4本の柱と上げ下げできる屋根）
  k.at(flip * 10, -10, 0);
  {
    const g = k.gh(0, 0), s = 2.3, ph = 7.5, roofY = g + r.range(4.4, 6.2);
    for (const [px, pz] of [[-s, -s], [s, -s], [-s, s], [s, s]]) box(k, px - 0.12, g - 0.3, pz - 0.12, px + 0.12, g + ph, pz + 0.12, C(0x5d4a38), MAT.none);
    box(k, -s + 0.15, g - 0.2, -s + 0.15, s - 0.15, roofY - 0.6, s - 0.15, C(0xb59a5e), THATCH);
    roof(k, -s - 0.2, -s - 0.2, s + 0.2, s + 0.2, roofY, 1.8, thatch ? roofC : C(0x6a5a40), C(0x5d4a38), { ov: 0.3, c0: 0, c1: 0, t: 0.15, roofMat: thatch ? THATCH : MAT.shingle });
  }
  k.at(0, 0, 0);
  // まわり：高い生け垣とポプラ
  hedge(k, -15.8, -15.8, 15.8, -14.8, 2.4, HEDGE[0]);
  hedge(k, -flip * 15.8 - 0.5, -14.8, -flip * 15.8 + 0.5, 10, 2.2, HEDGE[1]);
  for (let i = 0; i < 6; i++) k.tree(-15 + i * 6, -15.2, r.range(1.9, 2.3), 0, 2, 0x5d7f35);
  for (let i = 0; i < 3; i++) k.tree(flip * 15, -8 + i * 6.5, r.range(1.9, 2.2), 0, 2, 0x66883a);
  // 白い柵（正面）と、牧草地の木
  railFence(k, -15.5, 15.6, flip * 9 - 1.7, 15.6, WHITE, 1.1, 2, 2.6);
  railFence(k, flip * 9 + 1.7, 15.6, 15.5, 15.6, WHITE, 1.1, 2, 2.6);
  orchard(k, flip > 0 ? -14.5 : 4, 6, flip > 0 ? -4 : 14.5, 14.5, 4.0);
  // 白黒のロール
  for (let i = 0; i < 4; i++) bale(k, flip * (4.5 + i * 1.6), 0.5, PI / 2, i % 2 ? BALE.black : BALE.white);
  if (r.next() < 0.7) tractor(k, -flip * 8, 1.5, r.range(-0.4, 0.4));
}

// ---- 2. 北ドイツのハレンハウス（低地ドイツの家） ----
function hallenhaus(k: Kit) {
  const r = k.r;
  const brick = C(r.pick([0x8e4a36, 0x9b5338, 0x7a3e2e, 0xa0563a]));
  const oak = C(r.pick([0x3b2a20, 0x2e2622, 0x4a3426]));
  const rk = r.next();
  const thatch = rk < 0.55;
  const roofC = thatch ? C(0x6e5e42) : rk < 0.85 ? C(0x9b4a32) : C(0x3e4044);
  const roofM = thatch ? THATCH : MAT.shingle;
  const doorC = C(r.pick([0x2f5a3e, 0x6b4a32, 0x7a2a25, 0x3a4a5a]));
  const ws: WinS = { frame: WHITE, bars: 3, shut: null, sill: null };
  const flip = r.next() < 0.5 ? 1 : -1;
  const hw = 7, L = 25; // 幅 14m、長さ 25m（棟は道路に向かう）
  const hx = -flip * 4.2, hz0 = -15, hz1 = hz0 + L;
  k.at(0, 0, 0);
  patch(k, hx - 3, hz1, hx + 3, 15.95, LIFT + 0.1, YARD.cobble, MAT.brick);
  patch(k, flip * 2.5, -5, flip * 15, 12, LIFT + 0.1, YARD.gravel, MAT.gravel);
  // ローカル：棟は x、x1 = 正面の妻（敷地の +z）
  k.at(hx, (hz0 + hz1) / 2, PI / 2);
  const x0 = -L / 2, x1 = L / 2, z0 = -hw, z1 = hw;
  const [fl, lo] = floorAt(k, x0, z0, x1, z1, 0.25);
  const eave = fl + 2.5, rise = hw * 1.22;
  body(k, x0, z0, x1, z1, fl - 0.25, eave, brick, MAT.brick, C(0x6e6a64), false, lo);
  roof(k, x0, z0, x1, z1, eave, rise, roofC, brick, { ov: 0.6, ovG: 0.35, c0: r.next() < 0.6 ? 0.55 : 1, c1: 1, roofMat: roofM, fascia: thatch ? roofC : oak, soffit: oak, wallMat: MAT.brick, t: thatch ? 0.5 : 0.2 });
  const S = sides(x0, z0, x1, z1);
  // 正面の妻（+x）：木組み、大きな戸（グローテ・ドェール）
  const G = S[1];
  const kk = rise / hw;
  const topAt = (a: number) => eave + kk * (hw - Math.abs(a));
  timber(k, G, -hw, hw, fl + 0.3, eave, oak, 1.2, 1);
  timber(k, G, -hw + 0.2, hw - 0.2, eave, eave + rise, oak, 1.4, 2, (a) => topAt(a) - 0.2);
  wbox(k, G, -hw - 0.1, hw + 0.1, eave - 0.1, eave + 0.15, 0, 0.12, oak, MAT.none, 0);
  // 大きな戸と、上の横木（文字が彫られた梁）
  wbox(k, G, -2.3, 2.3, fl + 0.3, fl + 4.4, 0.05, 0.1, oak, MAT.none, 2);
  wbox(k, G, -2.05, 2.05, fl + 0.3, fl + 4.1, 0.1, 0.14, doorC, MAT.siding, 2);
  wbox(k, G, -0.04, 0.04, fl + 0.3, fl + 4.1, 0.14, 0.15, oak, MAT.none, 3);
  wbox(k, G, -2.5, 2.5, fl + 4.4, fl + 4.75, 0.05, 0.16, C(0x6a5038), MAT.none, 0);
  winRow(k, G, [-4.6, 4.6], fl + 1.0, 0.9, 1.0, ws);
  winRow(k, G, [-3.4, 3.4], eave + 1.0, 0.8, 0.9, ws);
  // 頂上の馬の頭（交差した2枚の破風板）
  {
    const yt = eave + rise + 0.2;
    k.m(MAT.none);
    for (const s of [-1, 1]) {
      const a0 = s * 1.6, y0 = yt - 1.6 * kk, a1 = -s * 0.9, y1 = yt + 0.9 * kk;
      k.mb.quad(wp(G, a0, y0, 0.75), wp(G, a0 + s * 0.3, y0, 0.75), wp(G, a1 + s * 0.3, y1, 0.75), wp(G, a1, y1, 0.75), oak);
      k.mb.quad(wp(G, a0 + s * 0.3, y0, 0.65), wp(G, a0, y0, 0.65), wp(G, a1, y1, 0.65), wp(G, a1 + s * 0.3, y1, 0.65), oak);
    }
  }
  // 長い側の壁：木組みと、小さな窓（住まいは奥）
  for (const i of [0, 2]) {
    const W = S[i];
    timber(k, W, -L / 2 + 0.1, L / 2 - 0.1, fl + 0.3, eave, oak, 1.25, 1);
    const sgn = i === 0 ? -1 : 1; // 奥（-x）の方が a の正負どちらか
    winRow(k, W, [sgn * -8, sgn * -5.5, sgn * -3], fl + 0.95, 0.85, 1.0, ws);
    wbox(k, W, sgn * 4 - 1.2, sgn * 4 + 1.2, fl + 0.3, eave - 0.05, 0.06, 0.1, doorC, MAT.siding, 2);
  }
  // 奥の妻（住まい）
  winRow(k, S[3], [-4, -1.5, 1.5, 4], fl + 0.95, 0.95, 1.15, ws);
  timber(k, S[3], -hw, hw, fl + 0.3, eave, oak, 1.2, 1);
  chimney(k, x0 + 3.5, 0, 0.7, 0.7, eave + rise - 1.8, eave + rise + 0.7, brick);
  // 横の建物：小さな木組みの納屋（パン焼き小屋）、または近代的な機械小屋
  k.at(0, 0, 0);
  if (r.next() < 0.5) {
    k.at(flip * 10.5, -9, PI / 2);
    const [sfl, slo] = floorAt(k, -6, -4, 6, 4, 0.1);
    const mc = C(r.pick([0x7d8a7a, 0x8a8d90, 0x6e7a6a]));
    body(k, -6, -4, 6, 4, sfl - 0.2, sfl + 4.6, mc, MAT.metal, C(0x77736d), false, slo);
    roof(k, -6, -4, 6, 4, sfl + 4.6, 1.5, C(0x5a5e60), mc, { ov: 0.3, ovG: 0.2, roofMat: MAT.metal, wallMat: MAT.metal, fascia: C(0x5a5e60) });
    const MS = sides(-6, -4, 6, 4);
    wbox(k, MS[1], -2.2, 2.2, sfl, sfl + 4.0, 0.02, 0.08, C(0x9a9d9f), MAT.metal, 2);
  } else {
    k.at(flip * 10.5, -8, 0);
    const [sfl, slo] = floorAt(k, -3, -4, 3, 4, 0.2);
    body(k, -3, -4, 3, 4, sfl - 0.2, sfl + 2.3, brick, MAT.brick, C(0x6e6a64), false, slo);
    const SS = sides(-3, -4, 3, 4);
    for (const i of [0, 1, 2, 3]) timber(k, SS[i], -SS[i].len / 2 + 0.1, SS[i].len / 2 - 0.1, sfl + 0.3, sfl + 2.3, oak, 1.2, 1);
    roof(k, -3, -4, 3, 4, sfl + 2.3, 3.6, roofC, brick, { ov: 0.4, ovG: 0.25, roofMat: roofM, fascia: oak, wallMat: MAT.brick });
    door(k, SS[flip > 0 ? 3 : 1], 0, sfl + 0.3, 1.1, 1.9, doorC, oak, false);
  }
  k.at(0, 0, 0);
  // 野石の低い塀（正面）
  const stoneC = C(0x8f877a);
  lowWall(k, -15.6, 15.2, hx - 3.4, 15.7, 0.85, stoneC, MAT.gravel, C(0x7a7266));
  lowWall(k, hx + 3.4, 15.2, 15.6, 15.7, 0.85, stoneC, MAT.gravel, C(0x7a7266));
  // オークの大木
  k.tree(-flip * 14.6, 1, r.range(1.5, 1.8), 0, 3, 0x4f7034);
  k.tree(-flip * 13.8, -12.5, r.range(1.5, 1.8), 0, 0, 0x557a2c);
  k.tree(flip * 14.2, 14.2, r.range(1.3, 1.6), 0, 3, 0x4f7034);
  if (r.next() < 0.6) k.tree(flip * 7, -14.4, r.range(1.2, 1.5), 0, 3);
  hedge(k, -15.8, -15.8, 15.8, -15.0, 1.8, HEDGE[r.int(4)]);
  // 庭の機械とロール
  tractor(k, flip * 7.5, 4.5, r.range(-0.5, 0.5) + (flip > 0 ? 0 : PI));
  for (let i = 0; i < 5; i++) bale(k, flip * 13.5, -1.5 + i * 1.3, 0, i % 2 ? BALE.green : BALE.white, 0);
  if (r.next() < 0.5) woodpile(k, flip > 0 ? 3.5 : -8.5, -15.0 + 1.2, 5, 1.4);
}

// ---- 3. 四方を囲む農家（フィアザイトホーフ） ----
function vierseithof(k: Kit) {
  const r = k.r;
  const yellow = r.next() < 0.25;
  const wall = yellow ? C(r.pick([0xe3c27a, 0xe8cf94])) : C(r.pick([0xf2efe8, 0xeee9df]));
  const trim = yellow ? WHITE : C(0xd8d2c4);
  const roofC = C(r.pick([0xa04a30, 0x9a4a35, 0x8c4632, 0x7a4a3a]));
  const plinth = C(0x8a8780);
  const shutC = C(r.pick([0x3f6b46, 0x6a4a30, 0x2f4f3a]));
  const ws: WinS = { frame: WHITE, bars: 1, shut: r.next() < 0.5 ? shutC : null, sill: C(0xb9b4aa), surround: yellow ? WHITE : null, box: r.next() < 0.5 ? C(0xc8362b) : null };
  const E = 13.6, dW = 7.2; // 外側の半分の幅、棟の奥行き
  k.at(0, 0, 0);
  // 中庭（石畳）と、門から道路への道
  patch(k, -E + dW, -E + dW, E - dW, E - dW, LIFT + 0.1, YARD.cobble, MAT.brick);
  patch(k, -2, E - 0.5, 2, 15.95, LIFT + 0.1, YARD.gravel, MAT.gravel);
  const [fl, lo] = floorAt(k, -E, -E, E, E, 0.2);
  const pitch = r.range(0.95, 1.1);
  // 正面の棟（住まい、2階建て、門）
  const frontH = 5.6, backH = r.range(5.8, 6.6), sideH = r.range(3.4, 3.9);
  // 前（z = E-dW..E）と後ろ（-E..-E+dW）：寄棟の両端
  for (const [zc, h, kind] of [[E - dW / 2, frontH, 'front'], [-E + dW / 2, backH, 'back']] as const) {
    k.at(0, zc, 0);
    body(k, -E, -dW / 2, E, dW / 2, fl - 0.25, fl + h, wall, MAT.plaster, plinth, false, lo);
    roof(k, -E, -dW / 2, E, dW / 2, fl + h, (dW / 2) * pitch, roofC, wall, { ov: 0.45, c0: 0, c1: 0, fascia: C(0x6a5040), soffit: C(0xe2ddd3) });
    const S = sides(-E, -dW / 2, E, dW / 2);
    if (kind === 'front') {
      // 外の面（道路側）：2列の窓と、真ん中の門
      const xs: number[] = [];
      for (let i = 0; i < 8; i++) { const a = -E + 1.6 + i * ((2 * E - 3.2) / 7); if (Math.abs(a) > 2.8) xs.push(a); }
      winRow(k, S[0], xs, fl + 1.2, 1.0, 1.3, ws);
      winRow(k, S[0], xs, fl + 3.9, 1.0, 1.25, { ...ws, box: null });
      winRow(k, S[2], xs.filter((_, i) => i % 2 === 0), fl + 1.2, 1.0, 1.3, { ...ws, box: null, shut: null });
      winRow(k, S[2], xs.filter((_, i) => i % 2 === 0), fl + 3.9, 1.0, 1.25, { ...ws, box: null, shut: null });
      // 門：アーチの形の戸（上は半円）と白い縁
      for (const W of [S[0], S[2]]) {
        const y0 = fl + 0.3, hh = 3.0, rr = 1.7;
        wbox(k, W, -rr - 0.35, rr + 0.35, y0, y0 + hh + 0.35, 0, 0.04, trim, MAT.plaster, 2);
        const gC = C(0x5d4632);
        wbox(k, W, -rr, rr, y0, y0 + hh, 0.04, 0.09, gC, MAT.siding, 2);
        k.m(MAT.none);
        const seg = 8;
        for (let s = 0; s < seg; s++) {
          const a0 = PI - (s / seg) * PI, a1 = PI - ((s + 1) / seg) * PI;
          k.mb.tri(wp(W, 0, y0 + hh, 0.09), wp(W, Math.cos(a1) * rr, y0 + hh + Math.sin(a1) * rr, 0.09), wp(W, Math.cos(a0) * rr, y0 + hh + Math.sin(a0) * rr, 0.09), gC);
          k.mb.quad(wp(W, Math.cos(a0) * (rr + 0.35), y0 + hh + Math.sin(a0) * (rr + 0.35), 0.04), wp(W, Math.cos(a0) * rr, y0 + hh + Math.sin(a0) * rr, 0.04), wp(W, Math.cos(a1) * rr, y0 + hh + Math.sin(a1) * rr, 0.04), wp(W, Math.cos(a1) * (rr + 0.35), y0 + hh + Math.sin(a1) * (rr + 0.35), 0.04), trim);
        }
        wbox(k, W, -0.04, 0.04, y0, y0 + hh + rr * 0.95, 0.09, 0.1, C(0x2a2420), MAT.none, 3);
      }
      // 門の上の小さな飾りの破風（屋根窓）
      const R: RoofI = { x0: -E, x1: E, z0: -dW / 2, z1: dW / 2, y: fl + h, kk: pitch, hd: dW / 2, zm: 0, yt: fl + h + (dW / 2) * pitch, t: 0.2 };
      dormer(k, R, 0, 2.6, 2.0, dW / 2, roofC, wall, MAT.plaster, { ...ws, shut: null, box: null, surround: null });
      chimney(k, -E * 0.45, 0.6, 0.7, 0.6, R.yt - 1.5, R.yt + 0.8, wall, MAT.plaster);
      chimney(k, E * 0.4, -0.6, 0.7, 0.6, R.yt - 1.5, R.yt + 0.8, wall, MAT.plaster);
    } else {
      // 後ろの棟（大きな納屋）：中庭の側に大きな戸、外は小さな通気の穴
      for (const a of [-6, 6]) {
        wbox(k, S[0], a - 1.8, a + 1.8, fl + 0.3, fl + 3.9, 0, 0.05, trim, MAT.plaster, 2);
        wbox(k, S[0], a - 1.6, a + 1.6, fl + 0.3, fl + 3.7, 0.05, 0.1, C(0x5d4632), MAT.siding, 2);
      }
      for (let i = 0; i < 7; i++) wbox(k, S[2], -E + 2.5 + i * 3.6 - 0.15, -E + 2.5 + i * 3.6 + 0.15, fl + 3.4, fl + 4.6, 0, 0.03, C(0x4a4038), MAT.none, 2);
      winRow(k, S[2], [-9, -3, 3, 9], fl + 1.4, 0.8, 0.8, { ...ws, box: null, shut: null, surround: null });
    }
  }
  // 左右の棟（家畜小屋・倉庫）
  for (const s of [-1, 1]) {
    k.at(s * (E - dW / 2), 0, PI / 2);
    const Lz = 2 * (E - dW);
    body(k, -Lz / 2 - 0.2, -dW / 2, Lz / 2 + 0.2, dW / 2, fl - 0.25, fl + sideH, wall, MAT.plaster, plinth, false, lo);
    roof(k, -Lz / 2 - dW / 2, -dW / 2, Lz / 2 + dW / 2, dW / 2, fl + sideH, (dW / 2) * pitch, roofC, wall, { ov: 0.45, ovG: 0, fascia: C(0x6a5040), gable0: false, gable1: false });
    const S = sides(-Lz / 2, -dW / 2, Lz / 2, dW / 2);
    // 中庭の側（s = 1 のとき -z の面…回転で x と z が入れかわる）
    const inner = S[s > 0 ? 0 : 2], outer = S[s > 0 ? 2 : 0];
    winRow(k, inner, [-3.6, 0, 3.6], fl + 1.4, 0.9, 0.9, { ...ws, box: null, shut: null });
    wbox(k, inner, 5.8 - 0.75, 5.8 + 0.75, fl + 0.3, fl + 2.5, 0.02, 0.08, C(0x5d4632), MAT.siding, 2);
    wbox(k, inner, -5.8 - 0.75, -5.8 + 0.75, fl + 0.3, fl + 2.5, 0.02, 0.08, C(0x5d4632), MAT.siding, 2);
    winRow(k, outer, [-5, -1.7, 1.7, 5], fl + 1.6, 0.7, 0.7, { ...ws, box: null, shut: null, surround: null });
  }
  k.at(0, 0, 0);
  // 中庭の木（ボダイジュ）と水飲み場
  if (r.next() < 0.6) k.tree(r.range(-2, 2), r.range(-2, 1), r.range(0.9, 1.2), 0, 0, 0x587d36);
  else {
    const g = k.gh(-3, -3);
    box(k, -4.2, g - 0.2, -3.4, -2.2, g + 0.7, -2.6, C(0x9a958c), MAT.concrete, { top: C(0x3a5a6a) });
  }
  // 外：菩提樹と果樹（モスト用の梨）
  k.tree(-E - 0.6, E + 1.2, r.range(1.5, 1.8), 0, 3, 0x557a2c);
  k.tree(E + 1.2, -E - 1.0, r.range(1.3, 1.6), 0, 0);
  for (let i = 0; i < 4; i++) k.tree(-E - 1.4, -E + 2 + i * 6.5, r.range(0.6, 0.75), 0, 1, ORCH);
  for (let i = 0; i < 3; i++) k.tree(E + 1.5, -E + 6 + i * 6.5, r.range(0.6, 0.75), 0, 1, ORCH);
  // 門の前のロールとトラクター（中庭の中）
  if (r.next() < 0.75) tractor(k, r.range(-3, 3), r.range(-3, 1), r.range(0, PI * 2));
  for (let i = 0; i < 3; i++) bale(k, 4.5, -4.5 + i * 1.3, 0, BALE.straw);
}

// ---- 4. 北欧の農家 ----
function nordicFarm(k: Kit) {
  const r = k.r;
  const red = C(0x8b2c22), white = C(0xf2f1ec);
  const houseC = C(r.pick([0x8b2c22, 0x8b2c22, 0xeeeee8, 0xd8b45c, 0xe0cfa0]));
  const roofC = C(r.pick([0x2b2d30, 0x3a3c3f, 0x8c3b2a]));
  const barnRoof = C(r.pick([0x2b2d30, 0x55595c, 0x3a3c3f]));
  const ws: WinS = { frame: white, bars: 3, shut: null, sill: null };
  const flip = r.next() < 0.5 ? 1 : -1;
  k.at(0, 0, 0);
  patch(k, -13, -4.5, 13, 5, LIFT + 0.1, YARD.gravel, MAT.gravel);
  patch(k, flip * -6 - 1.6, 5, flip * -6 + 1.6, 15.95, LIFT + 0.1, YARD.gravel, MAT.gravel);
  // 母屋（2階建て、白い縁取り、ガラスの玄関）
  {
    k.at(flip * -6.5, 9.5, PI);
    const L = 11, D = 7.4;
    const [fl, lo] = floorAt(k, -L / 2, -D / 2, L / 2, D / 2, 0.45);
    const top = fl + 5.6;
    body(k, -L / 2, -D / 2, L / 2, D / 2, fl, top, houseC, MAT.siding, C(0x6e6c68), false, lo);
    for (const [cx, cz] of [[-L / 2, -D / 2], [L / 2, -D / 2], [-L / 2, D / 2], [L / 2, D / 2]]) box(k, cx - 0.12, fl + 0.25, cz - 0.12, cx + 0.12, top, cz + 0.12, white, MAT.none, { top: null });
    const R = roof(k, -L / 2, -D / 2, L / 2, D / 2, top, (D / 2) * 0.82, roofC, houseC, { ov: 0.4, ovG: 0.35, fascia: white, soffit: white, wallMat: MAT.siding });
    const S = sides(-L / 2, -D / 2, L / 2, D / 2);
    // 中庭側 = local -z（S[2]）。回転 PI なので local -z → 敷地 +z？ ここでは中庭（-z の敷地）を向く面が S[0]
    for (const i of [0, 2]) {
      winRow(k, S[i], [-3.6, -1.2, 1.2, 3.6].filter((a) => i !== 0 || Math.abs(a) > 1.5), fl + 1.2, 1.0, 1.35, ws);
      winRow(k, S[i], [-3.6, -1.2, 1.2, 3.6], fl + 3.95, 1.0, 1.3, ws);
    }
    for (const i of [1, 3]) { winRow(k, S[i], [-1.6, 1.6], fl + 1.2, 1.0, 1.35, ws); win(k, S[i], 0, top + 0.6, 0.8, 1.0, ws); }
    door(k, S[0], 0, fl + 0.3, 1.0, 2.1, C(0x2f4a3a), white);
    // ガラスの玄関（白い柱と小さな切妻）
    k.push(0, D / 2 + 1.0, 0);
    box(k, -1.4, fl - 0.6, -1.0, 1.4, fl + 0.3, 1.0, C(0x77736d), MAT.concrete);
    for (const px of [-1.3, 1.3]) for (const pz of [0.9]) box(k, px - 0.09, fl + 0.3, pz - 0.09, px + 0.09, fl + 2.6, pz + 0.09, white, MAT.none);
    box(k, -1.4, fl + 0.3, 0.75, 1.4, fl + 1.2, 0.85, white, MAT.none);
    k.push(0, 0, PI / 2);
    roof(k, -1.2, -1.45, 1.1, 1.45, fl + 2.6, 1.3, roofC, white, { ov: 0.15, ovG: 0.2, t: 0.12, fascia: white, wallMat: MAT.none });
    k.pop();
    k.pop();
    chimney(k, L * 0.22, 0.4, 0.6, 0.6, R.yt - 1.2, R.yt + 0.8, C(0x9b5a42), MAT.brick);
  }
  // 腰折れ屋根の大きな納屋（ファールンレッド、白い縁取り、斜めの板の戸）
  {
    k.at(flip * 2.5, -9.5, 0);
    const L = 21, D = 9.5;
    const [fl, lo] = floorAt(k, -L / 2, -D / 2, L / 2, D / 2, 0.2);
    const top = fl + 3.6;
    body(k, -L / 2, -D / 2, L / 2, D / 2, fl - 0.2, top, red, MAT.siding, C(0x77736d), true, lo);
    for (const [cx, cz] of [[-L / 2, -D / 2], [L / 2, -D / 2], [-L / 2, D / 2], [L / 2, D / 2]]) box(k, cx - 0.12, fl + 0.1, cz - 0.12, cx + 0.12, top, cz + 0.12, white, MAT.none, { top: null });
    gambrel(k, -L / 2, -D / 2, L / 2, D / 2, top, 3.2, 2.1, 1.6, barnRoof, red, MAT.siding, white, true);
    const S = sides(-L / 2, -D / 2, L / 2, D / 2);
    // 中庭側の戸（白い枠と X の板）
    for (const a of [-6, 0, 6]) {
      const w = a === 0 ? 3.6 : 1.6, h = a === 0 ? 3.3 : 2.2;
      wbox(k, S[0], a - w / 2 - 0.12, a + w / 2 + 0.12, fl + 0.1, fl + h + 0.12, 0, 0.05, white, MAT.none, 2);
      wbox(k, S[0], a - w / 2, a + w / 2, fl + 0.1, fl + h, 0.05, 0.08, red, MAT.siding, 2);
      wpara(k, S[0], a - w / 2, a - w / 2 + 0.16, fl + 0.1, a + w / 2 - 0.16, a + w / 2, fl + h, 0.085, white);
      wpara(k, S[0], a + w / 2 - 0.16, a + w / 2, fl + 0.1, a - w / 2, a - w / 2 + 0.16, fl + h, 0.09, white);
    }
    winRow(k, S[0], [-8.6, -3.2, 3.2, 8.6], fl + 1.8, 0.9, 0.7, { ...ws, bars: 1 });
    // 妻の上の干し草の戸
    for (const i of [1, 3]) {
      wbox(k, S[i], -1.0, 1.0, top + 0.5, top + 2.3, 0, 0.05, white, MAT.none, 2);
      wbox(k, S[i], -0.85, 0.85, top + 0.5, top + 2.2, 0.05, 0.08, red, MAT.siding, 2);
    }
    // 裏の高いところの干し草の戸
    wbox(k, S[2], -1.6, 1.6, top - 0.4, top + 2.0, 0, 0.05, white, MAT.none, 2);
    wbox(k, S[2], -1.45, 1.45, top - 0.4, top + 1.9, 0.05, 0.08, red, MAT.siding, 2);
    winRow(k, S[2], [-7, -3.5, 3.5, 7], fl + 1.8, 0.9, 0.7, { ...ws, bars: 1 });
  }
  // 離れの小屋（倉、薪小屋）
  k.at(0, 0, 0);
  shed(k, flip * 10.8, 7.5, flip > 0 ? -PI / 2 : PI / 2, 4.2, 3.4, red, roofC, white, 2.4);
  {
    // 高床の倉（ストールブー）
    k.at(flip * 11.5, 0.5, flip > 0 ? -PI / 2 : PI / 2);
    const g = k.gh(0, 0);
    for (const [px, pz] of [[-1.2, -1.0], [1.2, -1.0], [-1.2, 1.0], [1.2, 1.0]]) box(k, px - 0.15, g - 0.3, pz - 0.15, px + 0.15, g + 0.8, pz + 0.15, C(0x8f877a), MAT.gravel);
    box(k, -1.6, g + 0.8, -1.4, 1.6, g + 3.0, 1.4, red, MAT.siding, { top: null, vert: true });
    door(k, sides(-1.6, -1.4, 1.6, 1.4)[0], 0, g + 0.8, 0.8, 1.8, C(0x5d3a2a), white, false);
    roof(k, -1.6, -1.4, 1.6, 1.4, g + 3.0, 1.4, C(0x2b2d30), red, { ov: 0.35, ovG: 0.3, t: 0.15, fascia: white, wallMat: MAT.siding });
  }
  // 薪の山
  k.at(0, 0, 0);
  woodpile(k, flip > 0 ? -14.5 : 9.5, -3.5, 5, 1.3);
  // 丸太の斜めの柵（ゲーデスゴード）：正面
  {
    k.at(0, 0, 0);
    const z = 15.4, x0 = -15.5, x1 = 15.5, gap0 = flip * -6 - 2, gap1 = flip * -6 + 2;
    const pole = C(0x6e6558);
    k.m(MAT.none);
    for (let x = x0; x < x1; x += 0.55) {
      if (x > gap0 && x < gap1) continue;
      const g = k.gh(x, z);
      const a: V3 = [x, g - 0.1, z - 0.05], b: V3 = [x + 1.0, g + 1.15, z + 0.05];
      k.mb.quad([a[0], a[1], z + 0.06], [a[0] + 0.17, a[1], z + 0.06], [b[0] + 0.17, b[1], z + 0.06], [b[0], b[1], z + 0.06], pole);
      k.mb.quad([a[0] + 0.17, a[1], z - 0.06], [a[0], a[1], z - 0.06], [b[0], b[1], z - 0.06], [b[0] + 0.17, b[1], z - 0.06], pole);
      k.mb.quad([b[0], b[1], z + 0.06], [b[0] + 0.17, b[1], z + 0.06], [b[0] + 0.17, b[1], z - 0.06], [b[0], b[1], z - 0.06], pole);
    }
    for (let x = x0; x < x1; x += 2.2) {
      if (x > gap0 - 1 && x < gap1) continue;
      const g = k.gh(x, z);
      box(k, x - 0.05, g - 0.2, z - 0.2, x + 0.05, g + 1.4, z - 0.1, pole, MAT.none, { top: null });
      box(k, x - 0.05, g - 0.2, z + 0.1, x + 0.05, g + 1.4, z + 0.2, pole, MAT.none, { top: null });
    }
  }
  // 旗竿と吹き流し
  {
    const px = flip * -1.5, pz = 12.5, g = k.gh(px, pz);
    k.m(MAT.none);
    k.mb.cylinder(px, pz, g - 0.2, g + 10, 0.07, 6, white, white, 0.04);
    k.mb.quad([px, g + 9.85, pz], [px + 3.2, g + 9.55, pz + 0.3], [px + 3.2, g + 9.47, pz + 0.3], [px, g + 9.45, pz], C(0x1f4e9a));
    k.mb.quad([px + 3.2, g + 9.55, pz + 0.3], [px, g + 9.85, pz], [px, g + 9.45, pz], [px + 3.2, g + 9.47, pz + 0.3], C(0x1f4e9a));
  }
  // 家庭菜園とリンゴの木（母屋の横）
  {
    const gx0 = flip > 0 ? 1.5 : -8.5;
    for (let i = 0; i < 4; i++) {
      const zz = 9.2 + i * 1.3, g = k.gh(gx0 + 3.5, zz);
      box(k, gx0, g - 0.1, zz - 0.4, gx0 + 7, g + 0.25, zz + 0.4, C(0x6a5440), MAT.none, { top: i % 2 ? C(0x5a7a34) : C(0x4a6a2e), pat: i % 2 ? PAT.gardenLeaf : 0 });
    }
    for (let i = 0; i < 3; i++) k.tree(flip * 13.6, 9.5 + i * 2.6, r.range(0.45, 0.55), 0, 0, ORCH);
  }
  // シラカバとトウヒ
  for (let i = 0; i < 3; i++) k.tree(-flip * (3 + i * 3.5), 14.2, r.range(0.8, 1.05), 0, 1, 0x7a9a48);
  for (let i = 0; i < 4; i++) k.tree(-14 + i * 9 + r.range(-1, 1), -15.2, r.range(1.0, 1.3), 1, 0);
  k.tree(flip * 14.5, -6, r.range(0.9, 1.1), 1, 0);
  tractor(k, flip * 4, 1, r.range(0, PI * 2));
  for (let i = 0; i < 4; i++) bale(k, -flip * 13.5, -9 + i * 1.3, 0, BALE.white);
  if (r.next() < 0.5) bale(k, -flip * 13.5, -7.7, 0, BALE.white, 1.4);
}
