// 物流施設（その1）：大型のマルチテナント型物流施設（multiTenant）と、配送センター・トラックターミナル・宅配の仕分けハブ（distCenter）
// 敷地の座標：x は -W/2..W/2、z は -D/2..D/2、+z が道路の側（正面）、y = 0 が敷地の地面。
// buildingGen から読み込まれるので、buildingGen は型だけ読み込む（実行時に読み込むと循環する）
import * as THREE from 'three';
import { PAT } from './builder';
import type { MeshBuilder } from './builder';
import { MAT } from './textures';
import { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';
import { LOGI, type LogiFn } from './logiRegistry';

type P3 = [number, number, number];
const C = (h: number) => new THREE.Color(h);
const TAU = Math.PI * 2;

// ---------------- 色 ----------------
const K = {
  white: C(0xeef0f1), white2: C(0xe3e6e9), ribbed: C(0xdfe3e6), joint: C(0xc3c8cd), cap: C(0xd5d8db), roof: C(0xcfd2d4),
  plinth: C(0x6b7178), conc: C(0xbab8b1), apron: C(0xb0aea6), litGround: C(0x8f8d87), slab: C(0xe8eaeb), under: C(0xc7c9ca),
  deck: C(0x7a7d81), court: C(0x55585c), lane: C(0x606367), ramp: C(0x8a8d90), paint: C(0xeeeee8), yel: C(0xf2c200),
  shutter: C(0xb9bec3), seal: C(0x1c1f23), glass: C(0x6f9cc2), glassT: C(0x5f9aa2), glassDk: C(0x2c4864), slot: C(0xa9cbe0),
  steel: C(0x8a9097), steelDk: C(0x464c53), fence: C(0x7d848b), solar: C(0x23344c), solarJ: C(0x7d8a99), lawn: C(0x6e9a4a), hedge: C(0x3f6a31),
  lamp: C(0xfff0cf), led: C(0xe9f2ff), tyre: C(0x1d1f22), chassis: C(0x2b2e32), cabGlass: C(0x1c2834), cage: C(0x9aa3ab),
  silver: C(0xd3d7db), cargo: C(0xc8b28c), unit: C(0xd5d8db), vroof: C(0xe4e6e8), navy: C(0x232f3e), conveyor: C(0xf3e3c3),
};
// 会社の色（帯や看板に少しだけ使う）
const ACCENT = [0x1f4e8c, 0x0f8a8a, 0xe2452d, 0x2e9e5b, 0x1f6fd0, 0x6fb7d9].map(C);
// 運転台の色（白が多い）
const CABS = [0xf2f2f2, 0xf2f2f2, 0xf2f2f2, 0xf2f2f2, 0xe8e9ea, 0xd9d9d9, 0x1d3f8a, 0x9a1d1d, 0x2e6b3a, 0x2b2b2b, 0x1f5fae].map(C);
// デッキに並ぶトラックの運転台（ほとんど白）
const DECK_CABS = [0xf2f2f2, 0xf2f2f2, 0xf2f2f2, 0xeceeef, 0xeceeef, 0xdfe2e5, 0xdfe2e5, 0x1d3f8a].map(C);
const CARS = [0xf2f2f2, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xd8d8d8, 0x3b5d3a, 0x101820, 0xb8bcc0].map(C);
// 屋根の仕上げ（白い防水シート、明るい灰色、うすい緑がかった灰色）と、壁の色合い（青みの白、アイボリー、明るい灰色）
const ROOFS = [0xe6e8e9, 0xcfd2d4, 0xc3cbc5].map(C);
const TINTS = [0xeef0f1, 0xf0ede4, 0xe1e4e7].map(C);
// 建物ごとに屋根の色を選び、壁の色合いを返す（K.roof の値を書きかえる。面を描くときに値が写されるので、ほかの建物には残らない）
function finish(rng: Rng): THREE.Color {
  K.roof.copy(rng.pick(ROOFS));
  return rng.pick(TINTS);
}
// 光だまりの明るい色（照明塔の真下）
const POOL = C(0x8f8d87);
type Rect = [number, number, number, number]; // x0, z0, x1, z1

// ---------------- 小さな部品 ----------------
// 箱。壁の模様の高さ（v）は地面からの高さにそろえる（階ごとの窓がそろい、根元の陰も地面の近くだけにつく）
// skip = 描かない壁（1 = +z、2 = -z、4 = +x、8 = -x。となりの敷地の建物とくっつく面）
interface BO { roof?: THREE.Color | null; bot?: THREE.Color; rpat?: number; bpat?: number; m?: number; rm?: number; skip?: number }
function bx(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: THREE.Color, pat = 0, o: BO = {}) {
  const h = y1 - y0, wx = x1 - x0, wz = z1 - z0, keep = mb.matOverride, sk = o.skip ?? 0;
  if (o.m !== undefined) mb.matOverride = o.m;
  if (!(sk & 1)) mb.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], wall, pat, wx, h, 0, y0);
  if (!(sk & 2)) mb.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], wall, pat, wx, h, 0, y0);
  if (!(sk & 4)) mb.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], wall, pat, wz, h, 0, y0);
  if (!(sk & 8)) mb.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], wall, pat, wz, h, 0, y0);
  mb.matOverride = o.rm !== undefined ? o.rm : keep;
  if (o.roof !== null) mb.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], o.roof ?? wall, o.rpat ?? 0);
  if (o.bot) mb.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], o.bot, o.bpat ?? 0);
  mb.matOverride = keep;
}
// 地面に貼る面（舗装・白線・芝生）
function gq(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, col: THREE.Color, pat = 0) {
  const keep = mb.matOverride;
  mb.matOverride = MAT.ground;
  mb.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], col, pat);
  mb.matOverride = keep;
}
// 壁に貼る面。d = 向き（0 = +z、1 = +x、2 = -z、3 = -x）、w = 壁の位置、a0..a1 = 壁にそった範囲
function wq(mb: MeshBuilder, d: number, w: number, a0: number, a1: number, y0: number, y1: number, col: THREE.Color, pat = 0, m: number | null = null, v0 = y0) {
  const L = a1 - a0, h = y1 - y0, keep = mb.matOverride;
  if (m !== null) mb.matOverride = m;
  if (d === 0) mb.quad([a0, y0, w], [a1, y0, w], [a1, y1, w], [a0, y1, w], col, pat, L, h, 0, v0);
  else if (d === 2) mb.quad([a1, y0, w], [a0, y0, w], [a0, y1, w], [a1, y1, w], col, pat, L, h, 0, v0);
  else if (d === 1) mb.quad([w, y0, a1], [w, y0, a0], [w, y1, a0], [w, y1, a1], col, pat, L, h, 0, v0);
  else mb.quad([w, y0, a0], [w, y0, a1], [w, y1, a1], [w, y1, a0], col, pat, L, h, 0, v0);
  mb.matOverride = keep;
}
// 敷地の中心のまわりに 90°×q 回して描く。中の座標 (u, v) は、敷地の (x, z) = q=1 なら (-v, u)、q=2 なら (-u, -v)
function turn(mb: MeshBuilder, q: number, draw: () => void) {
  if ((q & 3) === 0) { draw(); return; }
  const [tx, ty, tz] = mb.world(0, 0, 0), [ax, , az] = mb.world(1, 0, 0);
  const a = Math.atan2(az - tz, ax - tx);
  mb.setTransform(a + (q * Math.PI) / 2, tx, ty, tz);
  try { draw(); } finally { mb.setTransform(a, tx, ty, tz); }
}
// a..b から gaps（出入口など）を除いた区間
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
// 区間 a..b に pitch ごとに並べた中心（端を margin あける）
function slots(a: number, b: number, pitch: number, margin = 0): number[] {
  const n = Math.floor((b - a - 2 * margin) / pitch);
  const out: number[] = [];
  const s = (a + b) / 2 - ((n - 1) * pitch) / 2;
  for (let i = 0; i < n; i++) out.push(s + i * pitch);
  return out;
}

// n 個のうち fill の割合だけ選ぶ（数はそろえ、場所はばらばら。並びがかたよらないように）
function pickSome(rng: Rng, n: number, fill: number): boolean[] {
  const k = Math.max(0, Math.min(n, Math.round(n * fill + rng.next() - 0.5)));
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = rng.int(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const out = new Array<boolean>(n).fill(false);
  for (let i = 0; i < k; i++) out[idx[i]] = true;
  return out;
}
// トラックの前庭の舗装（夜は照明塔に照らされて、うっすら明るい）
function court(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number) {
  gq(mb, x0, z0, x1, z1, 0.09, K.court, PAT.lit);
}
// 照明塔の足もとの光だまり（夜は照らされて明るく、外へなめらかに暗くなる。昼はうすい明るいむら）。
// 頂点ごとに中心からの距離で色を混ぜた格子。a = 光だまりを入れる四角（前庭の範囲）、base = その地面の色。
// すぐには描かずにためておき、形を作り終えたら poolFlush でまとめて描く
function pool(mb: MeshBuilder, cx: number, cz: number, R: number, a: Rect, base: THREE.Color = K.court, peak: THREE.Color = POOL, y = 0.095) {
  const x0 = Math.max(a[0], cx - R), x1 = Math.min(a[2], cx + R), z0 = Math.max(a[1], cz - R), z1 = Math.min(a[3], cz + R);
  if (x1 - x0 < 2 || z1 - z0 < 2) return;
  const [tx, ty, tz] = mb.world(0, 0, 0), [ax, , az] = mb.world(1, 0, 0);
  poolQ.push({ cx, cz, R, e: [x0, z0, x1, z1], c0: [base.r, base.g, base.b], c1: [peak.r, peak.g, peak.b], y, tr: [Math.atan2(az - tz, ax - tx), tx, ty, tz] });
}
// ためた光だまり。e = 四角に切った範囲、c0 = 地面の色、c1 = 真下の色、tr = 描いたときの回転と位置
interface PoolQ { cx: number; cz: number; R: number; e: Rect; c0: number[]; c1: number[]; y: number; tr: [number, number, number, number] }
const poolQ: PoolQ[] = [];
// ためた光だまりを描く。同じ高さ・同じ色で範囲が重なるものは 1 枚の格子にまとめ、頂点の明るさはいちばん明るい塔のもの
// （同じ面に別の三角形の分け方の格子を重ねると、夜にぎざぎざの暗いむらが出る）
function poolFlush(mb: MeshBuilder) {
  const q = poolQ.splice(0);
  if (!q.length) return;
  const [tx, ty, tz] = mb.world(0, 0, 0), [ax, , az] = mb.world(1, 0, 0);
  const key = (p: PoolQ) => `${p.tr.join()}|${p.y}|${p.c0.join()}|${p.c1.join()}`;
  const par = q.map((_, i) => i);
  const find = (i: number): number => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  const hit = (a: Rect, b: Rect) => a[0] < b[2] - 1e-3 && b[0] < a[2] - 1e-3 && a[1] < b[3] - 1e-3 && b[1] < a[3] - 1e-3;
  for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) if (key(q[i]) === key(q[j]) && hit(q[i].e, q[j].e)) par[find(j)] = find(i);
  const groups = new Map<number, PoolQ[]>();
  q.forEach((p, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(p); else groups.set(r, [p]); });
  for (const g of groups.values()) {
    mb.setTransform(...g[0].tr);
    poolGrid(mb, g);
  }
  mb.setTransform(Math.atan2(az - tz, ax - tx), tx, ty, tz);
}
// 光だまりの組を 1 枚の格子で描く。格子の線は、どの光だまりの範囲の端も通る（範囲の外へはみ出さない）。
// 区間ごとのこまかさは、その区間をおおう光だまりの半径の 1/3（1 つだけなら前と同じ格子）
function poolGrid(mb: MeshBuilder, g: PoolQ[]) {
  const lines = (k: 0 | 1) => {
    const b = g.flatMap((p) => [p.e[k], p.e[k + 2]]).sort((u, v) => u - v);
    const bs = [b[0]];
    for (const v of b) if (v - bs[bs.length - 1] > 1e-3) bs.push(v);
    const out = [bs[0]];
    for (let i = 1; i < bs.length; i++) {
      const a = bs[i - 1], L = bs[i] - a;
      let step = Infinity;
      for (const p of g) if (p.e[k] <= a + 1e-3 && p.e[k + 2] >= bs[i] - 1e-3) step = Math.min(step, p.R / 3);
      const n = step === Infinity ? 1 : Math.max(g.length === 1 ? 2 : 1, Math.round(L / step));
      for (let j = 1; j <= n; j++) out.push(a + (L * j) / n);
    }
    return out;
  };
  const xs = lines(0), zs = lines(1), nx = xs.length - 1, nz = zs.length - 1;
  const { y, c0, c1 } = g[0];
  const nv = (nx + 1) * (nz + 1);
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), Cl = new Float32Array(nv * 3), U = new Float32Array(nv * 2);
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const k = j * (nx + 1) + i, x = xs[i], z = zs[j];
    let t = 0;
    for (const p of g) {
      let s = Math.max(0, 1 - Math.hypot(x - p.cx, z - p.cz) / p.R);
      s = s * s * (3 - 2 * s);
      t = Math.max(t, s);
    }
    P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z; N[k * 3 + 1] = 1;
    for (let c = 0; c < 3; c++) Cl[k * 3 + c] = c0[c] + (c1[c] - c0[c]) * t;
  }
  // 四角の中心が、どれかの光だまりの範囲に入るものだけ描く
  const keep = (i: number, j: number) => {
    const x = (xs[i] + xs[i + 1]) / 2, z = (zs[j] + zs[j + 1]) / 2;
    return g.some((p) => x > p.e[0] && x < p.e[2] && z > p.e[1] && z < p.e[3]);
  };
  mb.gridSurface(nx, nz, P, N, Cl, U, PAT.lit, MAT.ground, keep);
}

// ---------------- 車（止まっているトラック・トレーラー・バン・乗用車）----------------
// 車の座標：後ろの端 (x, z) から、角度 a の向き（s）へ。t は横、sl は坂の傾き
type PF = (s: number, t: number, y: number) => P3;
function vframe(x: number, y: number, z: number, a: number, sl = 0): PF {
  const c = Math.cos(a), s = Math.sin(a);
  return (u, t, h) => [x + u * c - t * s, y + h + u * sl, z + u * s + t * c];
}
function vb(mb: MeshBuilder, P: PF, s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: THREE.Color, top?: THREE.Color) {
  mb.quad(P(s0, t1, y0), P(s1, t1, y0), P(s1, t1, y1), P(s0, t1, y1), col);
  mb.quad(P(s1, t0, y0), P(s0, t0, y0), P(s0, t0, y1), P(s1, t0, y1), col);
  mb.quad(P(s1, t1, y0), P(s1, t0, y0), P(s1, t0, y1), P(s1, t1, y1), col);
  mb.quad(P(s0, t0, y0), P(s0, t1, y0), P(s0, t1, y1), P(s0, t0, y1), col);
  mb.quad(P(s0, t1, y1), P(s1, t1, y1), P(s1, t0, y1), P(s0, t0, y1), top ?? col);
}
// 種類：van = トレーラー（箱）、drop = 運転台なしで置いたトレーラー、reefer = 冷凍トレーラー、cont = コンテナを積んだシャーシ、
// wing = 10t のウイング車、wingOpen = 横の羽を上げたウイング車、small = 4t の箱車、pvan = 宅配のバン
type TK = 'van' | 'drop' | 'reefer' | 'cont' | 'wing' | 'wingOpen' | 'small' | 'pvan';
const TLEN: Record<TK, number> = { van: 17.7, drop: 12.6, reefer: 18.2, cont: 17.7, wing: 12.0, wingOpen: 12.0, small: 7.1, pvan: 5.0 };
// 長さが入る種類を選ぶ（入らなければ小さいものへ）
function fitKind(rng: Rng, room: number, prefer: TK[]): TK | null {
  const ok = prefer.filter((k) => TLEN[k] <= room);
  if (ok.length) return rng.pick(ok);
  for (const k of ['wing', 'small', 'pvan'] as TK[]) if (TLEN[k] <= room) return k;
  return null;
}
function truck(mb: MeshBuilder, x: number, z: number, a: number, k: TK, body: THREE.Color, cab: THREE.Color, y = 0, sl = 0) {
  const P = vframe(x, y, z, a, sl);
  const keep = mb.matOverride;
  const B = (s0: number, s1: number, t0: number, t1: number, y0: number, y1: number, col: THREE.Color, m: number = MAT.none, top?: THREE.Color) => {
    mb.matOverride = m;
    vb(mb, P, s0, s1, t0, t1, y0, y1, col, top);
  };
  const shield = (s: number, w: number, y0: number, y1: number) => {
    mb.matOverride = MAT.none;
    mb.quad(P(s, w, y0), P(s, -w, y0), P(s, -w, y1), P(s, w, y1), K.cabGlass);
  };
  if (k === 'van' || k === 'drop' || k === 'reefer' || k === 'cont') {
    const L = 12.6;
    if (k === 'cont') {
      B(0, L, -0.5, 0.5, 1.0, 1.42, K.chassis);
      B(0.15, 12.35, -1.22, 1.22, 1.42, 4.02, body, MAT.metal);
    } else B(0, L, -1.27, 1.27, 1.22, 4.05, body, MAT.metal, K.vroof);
    B(0.7, 3.8, -1.12, 1.12, 0.05, k === 'cont' ? 1.0 : 1.22, K.tyre);
    if (k === 'reefer') B(L, L + 0.45, -0.95, 0.95, 2.55, 3.9, K.unit);
    if (k === 'drop') {
      // 前の脚をおろして置いたトレーラー
      B(L - 3.3, L - 3.0, -1.0, 1.0, 0, 1.22, K.chassis);
      mb.matOverride = keep;
      return;
    }
    const c0 = L + (k === 'reefer' ? 0.55 : 0.1);
    B(L - 1.2, c0 + 4.95, -1.1, 1.1, 0.05, 1.25, K.chassis); // 前の端は運転台の面より少し奥（同じ面に重ねない）
    B(c0 + 2.4, c0 + 5.0, -1.25, 1.25, 1.1, 3.75, cab);
    shield(c0 + 5.02, 1.1, 2.3, 3.35);
  } else if (k === 'wing' || k === 'wingOpen') {
    B(0.6, 11.8, -1.1, 1.1, 0.05, 1.1, K.chassis);
    B(0, 9.6, -1.25, 1.25, 1.1, 1.55, body, MAT.none, K.silver);
    if (k === 'wing') B(0, 9.6, -1.25, 1.25, 1.55, 3.8, K.silver, MAT.metal, K.vroof);
    else {
      // 横の羽を上げて、荷物が見える
      B(0.3, 9.3, -1.0, 1.0, 1.55, 2.9, K.cargo);
      B(9.3, 9.6, -1.25, 1.25, 1.55, 3.8, K.silver, MAT.metal);
      B(0, 9.6, -0.15, 0.15, 3.65, 3.85, K.silver);
      mb.matOverride = MAT.metal;
      for (const sd of [1, -1]) {
        const a0 = P(0, sd * 0.15, 3.85), a1 = P(9.6, sd * 0.15, 3.85), b1 = P(9.6, sd * 1.75, 5.55), b0 = P(0, sd * 1.75, 5.55);
        mb.quad(a0, a1, b1, b0, K.silver);
        mb.quad(b0, b1, a1, a0, K.silver);
      }
    }
    B(9.75, 11.95, -1.24, 1.24, 0.75, 3.25, cab);
    shield(11.97, 1.1, 2.0, 3.0);
  } else if (k === 'small') {
    B(0.5, 6.8, -0.95, 0.95, 0.05, 0.9, K.chassis);
    B(0, 5.2, -1.1, 1.1, 0.9, 3.0, body, MAT.metal, K.vroof);
    B(5.3, 7.05, -1.05, 1.05, 0.6, 2.6, cab);
    shield(7.07, 0.95, 1.6, 2.4);
  } else {
    // 宅配のバン：荷室と、低い運転席
    B(0, 3.7, -0.95, 0.95, 0.3, 2.5, body, MAT.none, K.vroof);
    B(3.7, 4.95, -0.95, 0.95, 0.3, 1.8, body);
    shield(4.97, 0.85, 1.05, 1.7);
  }
  mb.matOverride = keep;
}
// 乗用車（中心 x, z、a = 向き）
function car(mb: MeshBuilder, x: number, z: number, a: number, col: THREE.Color) {
  const P = vframe(x, 0, z, a);
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  vb(mb, P, -2.15, 2.15, -0.86, 0.86, 0.25, 0.95, col);
  vb(mb, P, -1.0, 1.1, -0.76, 0.76, 0.95, 1.45, K.cabGlass, col);
  mb.matOverride = keep;
}
// 駐車場：x0..x1 に 2.6m ごとの区画（奥行き z0..z1、車は +z か -z 向き）
function carRow(mb: MeshBuilder, rng: Rng, x0: number, x1: number, z0: number, z1: number, fill = 0.7) {
  gq(mb, x0, z0 - 0.5, x1, z1, 0.105, K.court, PAT.lit);
  for (let x = x0 + 0.3; x + 2.6 <= x1; x += 2.6) {
    gq(mb, x, z0 + 0.3, x + 0.12, z1, 0.115, K.paint);
    if (rng.next() < fill) car(mb, x + 1.36, (z0 + z1) / 2, rng.next() < 0.5 ? Math.PI / 2 : -Math.PI / 2, rng.pick(CARS));
  }
}

// ---------------- 建物の部品 ----------------
// 搬入口の列（+z 向きの壁 z）。xs = 扉の中心、y = 扉の下端（床の高さ）、dw×dh = 扉の大きさ。
// seal = 黒いドックシェルター、bz = 車止めを貼る面（台の前のふち。なければ壁）、lamp = 何枚ごとに灯り
function doors(mb: MeshBuilder, xs: number[], z: number, y: number, dw: number, dh: number, seal: boolean, bz: number | null = null, lamp = 2) {
  const keep = mb.matOverride;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], a = x - dw / 2, b = x + dw / 2;
    let zf = z + 0.03;
    if (seal) {
      bx(mb, a - 0.32, y - 0.05, z, b + 0.32, y + dh + 0.38, z + 0.32, K.seal, 0, { m: MAT.none });
      zf = z + 0.34;
    }
    // シャッター（横のうね）：面の座標の u を縦にして、金属のうねを横向きにする
    mb.matOverride = MAT.metal;
    mb.quad([b, y, zf], [b, y + dh, zf], [a, y + dh, zf], [a, y, zf], K.shutter, 0, dh, dw, 0, 10);
    mb.matOverride = keep;
    // 車止め（黄色）
    const zb = (bz ?? z) + 0.05 + (bz === null && seal ? 0.32 : 0); // 台の前の柱の面より少し前
    for (const s of [a + 0.1, b - 0.55]) wq(mb, 0, zb, s, s + 0.45, y - 0.62, y - 0.12, K.yel, 0, MAT.none, 10);
    // 灯り（夜に光る）
    if (lamp > 0 && i % lamp === 0) wq(mb, 0, z + 0.04, x - 0.4, x + 0.4, y + dh + 0.6, y + dh + 0.9, K.lamp, PAT.lit, MAT.none, 10);
  }
}
// 深いひさし（壁 z から +z へ depth）。上は明るい灰色の金属の板に半透明の明かり取りの帯（屋根ではなくひさしに見せる）。
// 下の面と下の地面は夜に光る。posts = 外側の細い柱の間隔（0 なら片持ち）。oL / oR = その端がとなりの敷地のひさしにつながる
const SKY = C(0xa7c4d4);
function canopy(mb: MeshBuilder, x0: number, x1: number, z: number, depth: number, y: number, edge: THREE.Color, posts = 0, oL = false, oR = false) {
  const skip = (oL ? 8 : 0) | (oR ? 4 : 0);
  bx(mb, x0, y, z, x1, y + 0.32, z + depth - 0.3, K.white2, 0, { roof: K.cap, bot: K.under, bpat: PAT.lit, m: MAT.metal, rm: MAT.metal, skip });
  bx(mb, x0 - (oL ? 0 : 0.05), y - 0.3, z + depth - 0.3, x1 + (oR ? 0 : 0.05), y + 0.6, z + depth, K.white, 0, { roof: K.cap, m: MAT.metal, skip });
  wq(mb, 0, z + depth + 0.02, x0, x1, y + 0.05, y + 0.3, edge, 0, MAT.none, 10);
  // 鼻先の下の明かりの線（夜はダウンライトの帯に見える）
  wq(mb, 0, z + depth + 0.02, x0, x1, y - 0.3, y - 0.08, K.led, PAT.glow, MAT.none, 10);
  // 明かり取りの帯（x の向き）
  if (depth >= 5) {
    const keep = mb.matOverride, a = x0 + (oL ? 0 : 0.6), b = x1 - (oR ? 0 : 0.6);
    mb.matOverride = MAT.none;
    for (const t of depth >= 7 ? [0.3, 0.66] : [0.5]) {
      const zz = z + (depth - 0.3) * t;
      mb.quad([a, y + 0.335, zz + 0.45], [b, y + 0.335, zz + 0.45], [b, y + 0.335, zz - 0.45], [a, y + 0.335, zz - 0.45], SKY);
    }
    mb.matOverride = keep;
  }
  if (posts > 0) {
    const n = Math.max(1, Math.round((x1 - x0) / posts));
    for (let i = 0; i <= n; i++) {
      const x = x0 + 0.4 + ((x1 - x0 - 0.8) * i) / n;
      bx(mb, x - 0.14, 0, z + depth - 0.75, x + 0.14, y, z + depth - 0.47, K.steel, 0, { m: MAT.metal });
    }
  }
}
// 照明塔（頭に 2 つの大きな投光器。夜に光り、遠くからも見える）。a = 足もとの光だまりを入れる四角（null ならなし）
function mast(mb: MeshBuilder, x: number, z: number, h: number, a: Rect | null = null) {
  bx(mb, x - 0.17, 0, z - 0.17, x + 0.17, h, z + 0.17, K.steel, 0, { m: MAT.metal });
  bx(mb, x - 1.8, h - 0.25, z - 0.7, x + 1.8, h, z + 0.7, K.steel, 0, { m: MAT.metal });
  for (const s of [-1, 1]) bx(mb, x - 1.6, h, z + s * 0.65 - 0.25, x + 1.6, h + 1.0, z + s * 0.65 + 0.25, K.led, PAT.glow, { roof: K.steel });
  if (a) pool(mb, x, z, h * 0.95, a);
}
// フェンス（軸にそった直線）：柱と、上と下の横棒
function fence(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, h = 2.0) {
  const L = Math.hypot(x1 - x0, z1 - z0);
  if (L < 1) return;
  const n = Math.max(1, Math.round(L / 6));
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    bx(mb, x - 0.06, 0, z - 0.06, x + 0.06, h, z + 0.06, K.fence, 0, { m: MAT.metal });
  }
  const xa = Math.min(x0, x1) - 0.04, xb = Math.max(x0, x1) + 0.04, za = Math.min(z0, z1) - 0.04, zb = Math.max(z0, z1) + 0.04;
  for (const y of [h - 0.1, 0.25]) bx(mb, xa, y, za, xb, y + 0.07, zb, K.fence, 0, { m: MAT.metal });
}
// 守衛所と、ゲートの遮断機（腕は +x へのびる）
function booth(mb: MeshBuilder, x: number, z: number, arm: number) {
  bx(mb, x - 1.3, 0, z - 1.5, x + 1.3, 2.7, z + 1.5, K.white, PAT.office, { roof: K.roof });
  bx(mb, x - 1.8, 2.7, z - 2.0, x + 1.8, 3.0, z + 2.0, K.white2, 0, { roof: K.cap });
  if (arm !== 0) {
    const s = Math.sign(arm), xa = x + s * 1.6, xb = x + arm;
    bx(mb, Math.min(xa, xb), 0.95, z - 0.07, Math.max(xa, xb), 1.07, z + 0.07, K.white, 0, { m: MAT.none });
    bx(mb, Math.min(xb, xb - s * 0.9), 0.95, z - 0.08, Math.max(xb, xb - s * 0.9), 1.08, z + 0.08, C(0xd23a2a), 0, { m: MAT.none });
  }
}
// 屋上の太陽光パネル（x の向きの列。少し +z へ傾ける）。上のふちに明るい枠の線、まん中に横の継ぎ目、
// 約 5m ごとに縦の継ぎ目を入れて、屋根が 1 枚の紺の板に見えないようにする。列の間からは屋根が見える
function solar(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, pitch = 3.3) {
  if (x1 - x0 < 3) return;
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  const lo = y + 0.3, hi = y + 0.85, dz = 1.9;
  // 傾いた面の上の点（t = 0 が下のふち、1 が上のふち）。継ぎ目の線は面から少し浮かせる
  const nl = Math.hypot(dz, hi - lo), ny = (dz / nl) * 0.025, nz = ((hi - lo) / nl) * 0.025;
  const n = Math.max(1, Math.round((x1 - x0) / 5)), sx = (x1 - x0) / n;
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
// 屋上の空調の室外機（ファンの丸）
function hvac(mb: MeshBuilder, x: number, z: number, y: number, w = 4.4, d = 2.2) {
  bx(mb, x, y, z, x + w, y + 1.5, z + d, C(0xbfc4c9), 0, { m: MAT.metal, roof: C(0xaab0b6) });
  const n = Math.max(1, Math.round(w / 2.2));
  for (let i = 0; i < n; i++) mb.cylinder(x + (w / n) * (i + 0.5), z + d / 2, y + 1.5, y + 1.56, Math.min(0.8, d * 0.36), 8, K.steelDk, K.steelDk);
}
// 天窓（低いガラスの箱）
function skylight(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number) {
  bx(mb, x0, y, z0, x1, y + 0.45, z1, K.white2, 0, { roof: C(0x8fb4cc), m: MAT.none, rm: MAT.none });
}
// 光る看板（会社の色の板と、細い線で組んだ白い文字）。+z 向き、z が板の裏
function sign(mb: MeshBuilder, rng: Rng, x0: number, x1: number, y0: number, y1: number, z: number, col: THREE.Color, letter: THREE.Color = K.white) {
  bx(mb, x0, y0, z, x1, y1, z + 0.3, col, PAT.lit, { roof: col, m: MAT.none });
  const m = (y1 - y0) * 0.2;
  letters(mb, rng, x0 + m * 1.4, x1 - m, y0 + m, y1 - m, z + 0.32, letter);
}
// 会社のマーク（+z 向きの面 z、中心 cx, cy、半径 r）：丸（8 角形を 3 枚の面で）か、45° 回したひし形
function mark(mb: MeshBuilder, cx: number, cy: number, r: number, z: number, col: THREE.Color, round: boolean) {
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  const P = (x: number, y: number): P3 => [cx + x, cy + y, z];
  if (round) {
    const c = r * 0.924, s = r * 0.383;
    mb.quad(P(-c, -s), P(c, -s), P(c, s), P(-c, s), col, PAT.lit);
    mb.quad(P(-c, s), P(c, s), P(s, c), P(-s, c), col, PAT.lit);
    mb.quad(P(-s, -c), P(s, -c), P(c, -s), P(-c, -s), col, PAT.lit);
  } else mb.quad(P(0, -r), P(r, 0), P(0, r), P(-r, 0), col, PAT.lit);
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
// 看板の文字（+z 向きの面 z、a0..a1、y0..y1）：左に会社のマーク、続けて細い線で組んだ字。単語の頭は大文字で高い
function letters(mb: MeshBuilder, rng: Rng, a0: number, a1: number, y0: number, y1: number, z: number, col: THREE.Color) {
  const h = y1 - y0, s = h * 0.16, xh = y0 + h * 0.74;
  const st = (p: number, q: number, ya: number, yb: number) => wq(mb, 0, z, p, q, ya, yb, col, PAT.lit, MAT.none, 10);
  let a = a0;
  if (a1 - a0 > h * 4) {
    mark(mb, a + h * 0.5, y0 + h * 0.5, h * 0.5, z, col, rng.next() < 0.55);
    a += h * 1.45;
  }
  let first = true;
  while (a < a1) {
    const k = rng.pick(GLYPHS), w = glyphW(k, h, rng.next());
    if (a + w > a1) break;
    glyph(st, k, a, w, y0, first ? y1 : xh, s);
    a += w + h * 0.2;
    first = false;
    // 単語の切れ目
    if (rng.next() < 0.17) { a += h * 0.45; first = true; }
  }
}
// 屋根の上の天窓：建物ごとに、細長い帯・格子・なし のどれか。y = 屋根の高さ
function skylights(mb: MeshBuilder, rng: Rng, x0: number, z0: number, x1: number, z1: number, y: number) {
  const r = rng.next();
  if (r < 0.4) {
    // 帯（z の向きに長い）
    for (let x = x0 + 4; x + 1.6 < x1 - 2; x += 9) skylight(mb, x, z0 + 1.5, x + 1.6, z1 - 1.5, y);
  } else if (r < 0.75) {
    for (let x = x0 + 4; x + 1.4 < x1 - 2; x += 10) for (let z = z0 + 3; z + 2.6 < z1 - 2; z += 8) skylight(mb, x, z, x + 1.4, z + 2.6, y);
  }
}
// 建物の上のふちを包む会社の色の帯（厚い板の輪。壁から少し出す）。y0..y1 = 帯の高さ。
// oL / oR = -x / +x の側がとなりの敷地の建物につながる（その側は帯を出さず、端で切る）
function band(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, col: THREE.Color, oL = false, oR = false) {
  const a = x0 - (oL ? 0 : 0.15), b = x1 + (oR ? 0 : 0.15);
  rim(mb, a, z0 - 0.15, b, z1 + 0.15, y0, y1 - y0, col, 0.4, oL, oR);
  // 帯の下のふちの光の線（夜は建物の形が横長の線で見える）
  const ga = x0 - (oL ? 0 : 0.18), gb = x1 + (oR ? 0 : 0.18);
  wq(mb, 0, z1 + 0.18, ga, gb, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none, 10);
  wq(mb, 2, z0 - 0.18, ga, gb, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none, 10);
  if (!oR) wq(mb, 1, x1 + 0.18, z0 - 0.15, z1 + 0.15, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none, 10);
  if (!oL) wq(mb, 3, x0 - 0.18, z0 - 0.15, z1 + 0.15, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none, 10);
}
// 屋上のふち（パラペット）の輪。oL / oR = その側の板を描かない（となりの敷地の建物につながる）
function rim(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, h: number, col: THREE.Color, t = 0.35, oL = false, oR = false) {
  const o: BO = { roof: K.cap, m: MAT.metal, skip: (oL ? 8 : 0) | (oR ? 4 : 0) };
  bx(mb, x0, y, z1 - t, x1, y + h, z1, col, 0, o);
  bx(mb, x0, y, z0, x1, y + h, z0 + t, col, 0, o);
  if (!oL) bx(mb, x0, y, z0 + t, x0 + t, y + h, z1 - t, col, 0, o);
  if (!oR) bx(mb, x1 - t, y, z0 + t, x1, y + h, z1 - t, col, 0, o);
}
// 筒の帯（外と内の両面）。遠くからは輪に見える
function ring(mb: MeshBuilder, cx: number, cz: number, r: number, y0: number, y1: number, n: number, col: THREE.Color, pat = 0) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
    const p = (a: number, y: number): P3 => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    const no = (a: number, s: number): P3 => [Math.cos(a) * s, 0, Math.sin(a) * s];
    mb.quadN(p(a1, y0), p(a0, y0), p(a0, y1), p(a1, y1), no(a1, 1), no(a0, 1), no(a0, 1), no(a1, 1), col, pat);
    mb.quadN(p(a0, y0), p(a1, y0), p(a1, y1), p(a0, y1), no(a0, -1), no(a1, -1), no(a1, -1), no(a0, -1), col, pat);
  }
}

// ---------------- 直線のランプウェイ（折り返し）と、らせんのランプ ----------------
// 坂の板：x0..x1、z = za で上面の高さ ya、z = zb で yb。厚さ th、両側に高さ ph の立ち上がり（手すり壁）。
// glow = 光の線をつける外側（-1 = x0 の側、1 = x1 の側、0 = なし）。outer = 外側の面の色（会社の色。なければ wall）
function rampRun(mb: MeshBuilder, x0: number, x1: number, za: number, ya: number, zb: number, yb: number, glow: number, wall: THREE.Color, outer: THREE.Color = wall) {
  const th = 0.75, ph = 1.15, pt = 0.25;
  const [zl, yl, zh, yh] = za < zb ? [za, ya, zb, yb] : [zb, yb, za, ya];
  const keep = mb.matOverride;
  const L = Math.hypot(zh - zl, yh - yl);
  mb.matOverride = MAT.ground;
  mb.quad([x0, yh, zh], [x1, yh, zh], [x1, yl, zl], [x0, yl, zl], K.ramp);
  mb.matOverride = MAT.concrete;
  mb.quad([x0, yl - th, zl], [x1, yl - th, zl], [x1, yh - th, zh], [x0, yh - th, zh], K.under);
  mb.quad([x1, yh - th, zh], [x1, yl - th, zl], [x1, yl + ph, zl], [x1, yh + ph, zh], glow > 0 ? outer : wall, 0, L, th + ph, 0, 6);
  mb.quad([x0, yl - th, zl], [x0, yh - th, zh], [x0, yh + ph, zh], [x0, yl + ph, zl], glow < 0 ? outer : wall, 0, L, th + ph, 0, 6);
  mb.quad([x1 - pt, yl, zl], [x1 - pt, yh, zh], [x1 - pt, yh + ph, zh], [x1 - pt, yl + ph, zl], wall);
  mb.quad([x0 + pt, yh, zh], [x0 + pt, yl, zl], [x0 + pt, yl + ph, zl], [x0 + pt, yh + ph, zh], wall);
  mb.quad([x1 - pt, yh + ph, zh], [x1, yh + ph, zh], [x1, yl + ph, zl], [x1 - pt, yl + ph, zl], K.cap);
  mb.quad([x0, yh + ph, zh], [x0 + pt, yh + ph, zh], [x0 + pt, yl + ph, zl], [x0, yl + ph, zl], K.cap);
  mb.matOverride = MAT.none;
  const g0 = ph - 0.3, g1 = ph - 0.12;
  if (glow > 0) mb.quad([x1 + 0.03, yh + g0, zh], [x1 + 0.03, yl + g0, zl], [x1 + 0.03, yl + g1, zl], [x1 + 0.03, yh + g1, zh], K.led, PAT.glow);
  if (glow < 0) mb.quad([x0 - 0.03, yl + g0, zl], [x0 - 0.03, yh + g0, zh], [x0 - 0.03, yh + g1, zh], [x0 - 0.03, yl + g1, zl], K.led, PAT.glow);
  mb.matOverride = keep;
}
// らせんのランプ（中心 cx, cz、外の半径 R、内の半径 rIn）。角度 a0 から反時計回りに turns 周、1周で fh 上がる。
// 1周ごとに白い帯（下に会社の色の線、上に夜に光る線）。帯のすき間から路面とトラックが見える。
// 角度 a0 の向き（デッキの側）は、各階の高さで手すりをあけて、デッキへ出入りできるようにする
function helixRamp(mb: MeshBuilder, cx: number, cz: number, R: number, rIn: number, a0: number, turns: number, fh: number, wall: THREE.Color, accent: THREE.Color, seg: number) {
  const th = 0.7, ph = 1.45, pt = 0.3;
  const P = (a: number, r: number, y: number): P3 => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
  const N = (a: number, s = 1): P3 => [Math.cos(a) * s, 0, Math.sin(a) * s];
  const keep = mb.matOverride;
  const n = turns * seg;
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (i / seg) * TAU, t1 = a0 + ((i + 1) / seg) * TAU, y0 = (i / seg) * fh, y1 = ((i + 1) / seg) * fh;
    mb.matOverride = MAT.ground;
    mb.quad(P(t0, rIn, y0), P(t1, rIn, y1), P(t1, R, y1), P(t0, R, y0), K.lane);
    mb.matOverride = MAT.concrete;
    mb.quad(P(t0, rIn, y0 - th), P(t0, R, y0 - th), P(t1, R, y1 - th), P(t1, rIn, y1 - th), K.under);
    const band = (ya: number, yb: number, col: THREE.Color, pat = 0) =>
      mb.quadN(P(t1, R, y1 + ya), P(t0, R, y0 + ya), P(t0, R, y0 + yb), P(t1, R, y1 + yb), N(t1), N(t0), N(t0), N(t1), col, pat);
    mb.matOverride = MAT.plaster;
    mb.quadN(P(t0, rIn, y0 - th), P(t1, rIn, y1 - th), P(t1, rIn, y1 + 0.55), P(t0, rIn, y0 + 0.55), N(t0, -1), N(t1, -1), N(t1, -1), N(t0, -1), wall);
    mb.matOverride = MAT.none;
    band(-th, -th + 0.42, accent);
    mb.matOverride = MAT.plaster;
    // デッキへの出入口（手すりなし。床の厚みの帯だけ）
    const dm = (((t0 + t1) / 2 - a0) % TAU + TAU) % TAU;
    if ((dm < 0.35 || dm > TAU - 0.35) && y0 + y1 > 1) {
      band(-th + 0.42, 0, wall);
      continue;
    }
    band(-th + 0.42, ph - 0.26, wall);
    mb.matOverride = MAT.none;
    band(ph - 0.26, ph, K.led, PAT.glow);
    mb.matOverride = MAT.plaster;
    mb.quadN(P(t0, R - pt, y0), P(t1, R - pt, y1), P(t1, R - pt, y1 + ph), P(t0, R - pt, y0 + ph), N(t0, -1), N(t1, -1), N(t1, -1), N(t0, -1), wall);
    mb.quad(P(t0, R - pt, y0 + ph), P(t1, R - pt, y1 + ph), P(t1, R, y1 + ph), P(t0, R, y0 + ph), K.cap);
  }
  mb.matOverride = keep;
}

// 直線ランプの奥の折り返し：半円の踊り場（中心 cx, cz、半径 r、-z の向きにふくらむ、床の高さ y）。
// 床の板と下の面、外の面（下に会社の色の線、白い手すり壁、上に夜に光る線）、手すり壁の内側と上のふた
function turnaround(mb: MeshBuilder, cx: number, cz: number, r: number, y: number, wall: THREE.Color, accent: THREE.Color, n = 8) {
  const th = 0.75, ph = 1.15, pt = 0.25;
  const P = (a: number, rr: number, yy: number): P3 => [cx + Math.cos(a) * rr, yy, cz + Math.sin(a) * rr];
  const N = (a: number, s = 1): P3 => [Math.cos(a) * s, 0, Math.sin(a) * s];
  const keep = mb.matOverride;
  for (let i = 0; i < n; i++) {
    const a0 = Math.PI * (1 + i / n), a1 = Math.PI * (1 + (i + 1) / n);
    mb.matOverride = MAT.ground;
    mb.tri([cx, y, cz], P(a1, r, y), P(a0, r, y), K.ramp);
    mb.matOverride = MAT.concrete;
    mb.tri([cx, y - th, cz], P(a0, r, y - th), P(a1, r, y - th), K.under);
    const band = (ya: number, yb: number, col: THREE.Color, pat = 0) =>
      mb.quadN(P(a1, r, y + ya), P(a0, r, y + ya), P(a0, r, y + yb), P(a1, r, y + yb), N(a1), N(a0), N(a0), N(a1), col, pat);
    mb.matOverride = MAT.none;
    band(-th, -th + 0.42, accent);
    mb.matOverride = MAT.plaster;
    band(-th + 0.42, ph - 0.26, wall);
    mb.matOverride = MAT.none;
    band(ph - 0.26, ph, K.led, PAT.glow);
    mb.matOverride = MAT.plaster;
    mb.quadN(P(a0, r - pt, y), P(a1, r - pt, y), P(a1, r - pt, y + ph), P(a0, r - pt, y + ph), N(a0, -1), N(a1, -1), N(a1, -1), N(a0, -1), wall);
    mb.quad(P(a0, r - pt, y + ph), P(a1, r - pt, y + ph), P(a1, r, y + ph), P(a0, r, y + ph), K.cap);
  }
  mb.matOverride = keep;
}
// 半円の板（中心 cx, cz、半径 r、-z の向きにふくらむ）：上の面（屋根）、下の面、まわりの面
function halfDisc(mb: MeshBuilder, cx: number, cz: number, r: number, y0: number, y1: number, side: THREE.Color, top: THREE.Color, n = 10) {
  const P = (a: number, y: number): P3 => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
  const N = (a: number): P3 => [Math.cos(a), 0, Math.sin(a)];
  const keep = mb.matOverride;
  for (let i = 0; i < n; i++) {
    const a0 = Math.PI * (1 + i / n), a1 = Math.PI * (1 + (i + 1) / n);
    mb.matOverride = MAT.membrane;
    mb.tri([cx, y1, cz], P(a1, y1), P(a0, y1), top);
    mb.matOverride = MAT.concrete;
    mb.tri([cx, y0, cz], P(a0, y0), P(a1, y0), K.under);
    mb.quadN(P(a1, y0), P(a0, y0), P(a0, y1), P(a1, y1), N(a1), N(a0), N(a0), N(a1), side);
  }
  mb.matOverride = keep;
}
// 円弧の帯（外の半径 r、厚さ t、角度 a0..a1）：外と内の面、上のふた、外の面の下のふちの光の線
function arcBand(mb: MeshBuilder, cx: number, cz: number, r: number, t: number, a0: number, a1: number, n: number, y0: number, y1: number, col: THREE.Color) {
  const P = (a: number, rr: number, y: number): P3 => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
  const N = (a: number, s = 1): P3 => [Math.cos(a) * s, 0, Math.sin(a) * s];
  const keep = mb.matOverride;
  for (let i = 0; i < n; i++) {
    const b0 = a0 + ((a1 - a0) * i) / n, b1 = a0 + ((a1 - a0) * (i + 1)) / n;
    mb.matOverride = MAT.metal;
    mb.quadN(P(b1, r, y0), P(b0, r, y0), P(b0, r, y1), P(b1, r, y1), N(b1), N(b0), N(b0), N(b1), col);
    mb.quadN(P(b0, r - t, y0), P(b1, r - t, y0), P(b1, r - t, y1), P(b0, r - t, y1), N(b0, -1), N(b1, -1), N(b1, -1), N(b0, -1), col);
    mb.quad(P(b0, r - t, y1), P(b1, r - t, y1), P(b1, r, y1), P(b0, r, y1), K.cap);
    mb.matOverride = MAT.none;
    mb.quadN(P(b1, r + 0.03, y0 + 0.1), P(b0, r + 0.03, y0 + 0.1), P(b0, r + 0.03, y0 + 0.3), P(b1, r + 0.03, y0 + 0.3), N(b1), N(b0), N(b0), N(b1), K.led, PAT.glow);
  }
  mb.matOverride = keep;
}

// =====================================================================
// マルチテナント型の大型物流施設（ランプウェイ型）。短い辺が 60m 以上の敷地（らせんは 4×4 と、いちばん大きい 6×4 だけ）。
// 敷地の長い辺いっぱいの低く長い箱（3〜4 層）。上のふちを会社の色の太い帯で包み、横長に見せる。
// 箱の長い面に、各階のトラックの接車デッキ（白い床の帯、手すり壁、夜は床と天井の線が光る）。
// 片方の端に、各階へ上がる直線の折り返しランプ（ramp）か、らせん（helix）、らせんを白い縦ルーバーで包んだもの（screen）。
// 階段の塔は裏の面に出す。
// 縦長の敷地（港のそばの 4×5、4×6）は、長い辺を道路と直角に置く：デッキと長いトラックの前庭は横の辺にそい、
// 道路の側の端に事務所と駐車場とゲート、ランプは奥の端
// =====================================================================
type MK = 'ramp' | 'helix' | 'screen';
function mtDeck(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number, kind: MK) {
  const end = f.D > f.W;
  // 縦長：回した座標で、q = 1 なら道路が +x の端、q = 3 なら -x の端（左右どちらの横の辺に前庭が来るかが変わる）
  const q = end ? (rng.next() < 0.5 ? 1 : 3) : 0;
  const tr: TF = q === 0 ? tf : q === 1 ? (x, z, s, k, y, c, h) => tf(-z, x, s, k, y, c, h) : (x, z, s, k, y, c, h) => tf(z, -x, s, k, y, c, h);
  turn(mb, q, () => mtDeckBody(mb, end ? f.D : f.W, end ? f.W : f.D, end, q, rng, tr, den, kind));
}
// W = 長い辺、D = 短い辺（回した座標）。end = 道路が端（回した座標の X(-hw) の側）
function mtDeckBody(mb: MeshBuilder, W: number, D: number, end: boolean, q: number, rng: Rng, tf: TF, den: number, kind: MK) {
  const hw = W / 2, hd = D / 2;
  const fh = 7;
  const big = W >= 80; // 港のそばの大きな敷地
  // 高さと長さの比が 0.25〜0.35 になるように（長さ 80m の敷地は 3 層）
  const levels = !big || W >= 90 ? 4 : 3;
  const H = levels * fh;
  const sr = rng.next() < 0.5 ? 1 : -1;
  // ランプのある側（+1 = +x）。縦長は奥の端（道路は X(-hw) の側）
  const side = end ? (q === 1 ? -1 : 1) : sr;
  const X = (x: number) => side * x;
  const helix = kind !== 'ramp';
  const accent = rng.pick(ACCENT);
  const wall = finish(rng);
  const court = 10;
  const z1 = hd - 3 - court, dd = 16, zc = z1 - dd, z0 = -hd + 3;
  const cE = end ? hd - 0.6 : hd - 3; // 前庭の外のふち（縦長はフェンスまで）
  const R = 12, rIn = R - 6.5;
  const rw = W >= 60 ? 12 : 11;
  const xo = hw - (kind === 'screen' ? 2.2 : 1.5); // ランプ（らせん）の外のふち（ルーバーの輪がフェンスにかからないように）
  const x1 = helix ? xo - 2 * R : xo - rw; // 倉庫の端（ランプの側）
  const x0 = -hw + 2.5 + (end ? 13 : 0); // 倉庫の反対の端（縦長は道路の側に駐車場をあける）
  const ow = Math.min(14, Math.round((x1 - x0) * 0.3)); // 角のガラスの事務所の幅
  const xe = helix ? x1 : xo + 0.65; // 帯で包む範囲の端（直線ランプはランプの塔まで）
  const xm0 = Math.min(X(x0), X(xe)), xm1 = Math.max(X(x0), X(xe));
  mb.flatRoofMat = MAT.membrane;
  // 左右を入れかえた箱・地面・壁の面
  const B = (a0: number, y0: number, za: number, a1: number, y1: number, zb: number, col: THREE.Color, pat = 0, o: BO = {}) =>
    bx(mb, Math.min(X(a0), X(a1)), y0, za, Math.max(X(a0), X(a1)), y1, zb, col, pat, o);
  const G = (a0: number, za: number, a1: number, zb: number, y: number, col: THREE.Color, pat = 0) => gq(mb, Math.min(X(a0), X(a1)), za, Math.max(X(a0), X(a1)), zb, y, col, pat);
  const Wz = (d: number, z: number, a0: number, a1: number, y0: number, y1: number, col: THREE.Color, pat = 0, m: number | null = null, v0 = y0) =>
    wq(mb, d, z, Math.min(X(a0), X(a1)), Math.max(X(a0), X(a1)), y0, y1, col, pat, m, v0);
  const Wx = (d: number, x: number, za: number, zb: number, y0: number, y1: number, col: THREE.Color, pat = 0, m: number | null = null) =>
    wq(mb, side > 0 ? d : 4 - d, X(x), za, zb, y0, y1, col, pat, m);

  // ---- 敷地：コンクリートの下地、トラックの前庭と、ランプ側の通路はアスファルト ----
  gq(mb, -hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, K.apron);
  // 前庭（縦長は道路の側の端の出入口から、ランプまでの長い前庭）
  const ca = end ? -hw + 0.5 : x0 + ow + 3;
  G(ca, z1, xo + 1, cE, 0.09, K.court, PAT.lit);
  G(x1, z0 - 1, xo + 1, z1, 0.09, K.court, PAT.lit);
  const front: Rect = [Math.min(X(ca), X(xo + 1)), z1, Math.max(X(ca), X(xo + 1)), cE];
  // デッキの下（1階の荷捌き）：夜に照らされる床
  G(x0 + ow, zc + 3.2, x1, z1, 0.1, K.litGround, PAT.lit);
  // 前庭の白線（進む向きの中央の線。縦長はフェンスぎわの待機の列をよけた車線のまん中）
  const yl = end ? (z1 + cE - 3.2) / 2 : z1 + court * 0.62;
  G(end ? -hw + 1 : x0 + ow + 4, yl, xo, yl + 0.18, 0.11, K.yel);

  // ---- 倉庫の箱（金属パネル、各階の高い位置に細い窓） ----
  B(x0, 0, z0, x1, H, zc, wall, PAT.industrial, { roof: K.roof, m: MAT.metal, rm: MAT.membrane });
  // 根元の濃い灰色の帯と、各階の床の線（少し濃い目地）
  B(x0 - 0.06, 0, z0 - 0.06, x1 + 0.06, 1.2, zc - 0.05, K.plinth, 0, { roof: null, m: MAT.concrete });
  for (let k = 1; k < levels; k++) B(x0 - 0.06, k * fh - 0.3, z0 - 0.06, x1 + 0.06, k * fh + 0.05, zc - 0.05, K.joint, 0, { m: MAT.metal });

  // ---- 各階の接車デッキ ----
  const deckEnd = helix ? x1 : xo; // デッキの床の先（直線ランプは、ランプの帯の前の踊り場までつながる）
  for (let k = 1; k <= levels; k++) {
    const y = k * fh, top = k === levels;
    const xd0 = k === 1 ? x0 + ow : x0;
    // 床の板。下の面は下の階のバースの天井（夜は照明で明るい）
    B(xd0, y - 0.9, zc, x1, y, z1, K.slab, 0, { roof: top ? K.roof : K.deck, rpat: top ? 0 : PAT.lit, bot: K.under, bpat: PAT.lit, m: MAT.concrete, rm: top ? MAT.membrane : MAT.concrete });
    // 直線ランプの前の踊り場（デッキの続き）
    if (!helix && !top) {
      B(x1, y - 0.9, z1 - 8, xo, y, z1, K.slab, 0, { roof: K.ramp, bot: K.under, m: MAT.concrete, rm: MAT.ground });
      B(xo - 0.3, y, z1 - 8, xo, y + 1.15, z1 - 0.3, wall, 0, { roof: K.cap, m: MAT.concrete });
      Wx(1, xo + 0.03, z1 - 8, z1 - 0.3, y + 0.85, y + 1.03, K.led, PAT.glow, MAT.none);
      // デッキの端の手すり（ランプの坂との間）
      B(x1 - 0.3, y, zc, x1, y + 1.15, z1 - 8, wall, 0, { roof: K.cap, m: MAT.concrete });
    }
    if (top) continue;
    const xe2 = helix ? x1 : xo;
    // 正面の手すり壁と、天井の下の光の線（夜は階ごとの明るい線になる）
    B(xd0, y, z1 - 0.3, xe2, y + 1.15, z1, wall, 0, { roof: K.cap, m: MAT.concrete });
    Wz(0, z1 + 0.03, xd0, xe2, y - 0.9, y - 0.58, K.led, PAT.glow, MAT.none);
    // らせんの側：デッキの端の手すり（らせんにつながる所はあける）
    if (helix) {
      const hz = (zc + z1) / 2;
      B(x1 - 0.3, y, zc, x1, y + 1.15, hz - 4, wall, 0, { roof: K.cap, m: MAT.concrete });
      B(x1 - 0.3, y, hz + 4, x1, y + 1.15, z1 - 0.3, wall, 0, { roof: K.cap, m: MAT.concrete });
    }
    // 倉庫の壁の暗い帯（バースの列が遠くから見える）とシャッター、止まっている 10t のウイング車（荷台は白か銀、会社の色は細い線だけ）
    Wz(0, zc + 0.02, xd0 + 0.6, x1 - 0.6, y + 0.05, y + 4.75, K.seal, 0, MAT.none, 10);
    const sl = slots(xd0 + 1, x1 - (helix ? 1 : 0.5), 4.5, 0.5), on = pickSome(rng, sl.length, 0.8);
    // 床のバースの白線と、通路の黄色い線
    for (const xs of sl.slice(1)) G(xs - 2.31, zc + 0.6, xs - 2.19, zc + 12.8, y + 0.02, K.paint);
    G(xd0 + 1, zc + 13.4, x1 - 1, zc + 13.55, y + 0.02, K.yel);
    sl.forEach((xs, i) => {
      Wz(0, zc + 0.05, xs - 1.7, xs + 1.7, y + 0.15, y + 4.4, K.shutter, 0, MAT.metal, 10);
      const r = rng.next(), body = rng.next() < 0.3 ? accent : rng.next() < 0.8 ? K.white : K.silver;
      if (on[i]) truck(mb, X(xs), zc + 0.35, Math.PI / 2, r < 0.15 ? 'wingOpen' : 'wing', body, rng.pick(DECK_CABS), y);
    });
  }
  // デッキの反対の端の壁（事務所の上。床の板の端を少し外から覆い、上はいちばん上の床の下まで。前の面は床の板の面より少し前）
  B(x0 - 0.05, 2 * fh - 0.9, zc, x0 + 0.4, H - 0.9, z1 + 0.02, wall, 0, { roof: K.cap, m: MAT.metal });
  // 正面の柱（約 11m ごと）
  {
    const n = Math.max(2, Math.round((deckEnd - x0) / 11));
    for (let i = 0; i <= n; i++) {
      const xc = x0 + 0.5 + ((deckEnd - x0 - 1) * i) / n;
      B(xc - 0.45, 0, z1 - 1.15, xc + 0.45, H - 0.9, z1 - 0.25, K.white2, 0, { roof: K.cap, m: MAT.concrete });
    }
  }
  // 1階の荷捌き：高さ 1m の台、ドックシェルターのない大きなシャッター、トラック
  {
    const pa = x0 + ow + 0.6, pb = x1 - 0.6;
    B(pa, 0, zc, pb, 1.0, zc + 3.2, K.conc, 0, { roof: K.apron, m: MAT.concrete });
    const xs = slots(pa, pb, 4.6, 0.3);
    doors(mb, xs.map(X), zc, 1.0, 3.6, 4.2, false, zc + 3.2, 2);
    // デッキの下に収まる長さ（10t 車と、運転台なしのトレーラー）
    const on = pickSome(rng, xs.length, 0.55);
    for (const [i, x] of xs.entries()) if (on[i]) {
      const k = rng.pick<TK>(['wing', 'wing', 'wingOpen', 'drop']);
      truck(mb, X(x), zc + 3.35, Math.PI / 2, k, rng.next() < 0.75 ? K.white : K.silver, rng.pick(CABS));
    }
  }
  // ---- 角のガラスの事務所（2層分、うすい青のガラスと白い床の帯）----
  B(x0, 0, zc, x0 + ow - 0.1, 2 * fh - 0.9, z1 - 0.3, K.glass, PAT.curtain, { roof: null, m: MAT.none });
  B(x0 - 0.1, fh - 0.9, zc + 0.05, x0 + ow, fh, z1 - 0.2, K.white, 0, { roof: K.cap, m: MAT.metal });
  B(x0 + 1.5, 3.4, z1 - 0.3, x0 + Math.min(ow - 1, 9), 3.7, z1 + 2.6, K.white2, 0, { roof: K.cap, m: MAT.metal });
  // ---- 階段とエレベーターの塔（裏の面に出た細い塔、縦のガラスのすき間は夜に光る）----
  for (const t of x1 - x0 >= 64 ? [0.14, 0.5, 0.86] : x1 - x0 >= 40 ? [0.2, 0.8] : [0.5]) {
    const xm = x0 + (x1 - x0) * t;
    B(xm - 3, 0, z0 - 2.2, xm + 3, H + 3, z0 + 0.5, K.white2, 0, { roof: K.cap, m: MAT.metal });
    Wz(2, z0 - 2.23, xm - 0.7, xm + 0.7, 1.2, H + 2.2, K.slot, PAT.lit, MAT.none);
  }
  // ---- 上のふちを包む会社の色の太い帯（横長に見せる）と、帯に直接書いた白い大きな文字（正面と横）----
  // 直線ランプの塔は、奥を半円に丸めた帯で別に包む（下のランプのところ）
  if (helix) band(mb, xm0, z0, xm1, z1, H - 2.8, H + 0.6, accent);
  else {
    // ランプの塔の側は、正面の帯を塔の帯へそのまま続ける（横の板は奥の半円までの短い区間だけ）
    const o: BO = { roof: K.cap, m: MAT.metal }, y0 = H - 2.8, y1 = H + 0.6;
    B(x0 - 0.15, y0, z1 - 0.25, x1, y1, z1 + 0.15, accent, 0, o);
    B(x0 - 0.15, y0, z0 - 0.15, x1 + 0.15, y1, z0 + 0.25, accent, 0, o);
    B(x0 - 0.15, y0, z0 + 0.25, x0 + 0.25, y1, z1 - 0.25, accent, 0, o);
    B(x1 - 0.25, y0, z0 + 0.25, x1 + 0.15, y1, z0 + 6, accent, 0, o);
    Wz(0, z1 + 0.18, x0 - 0.18, x1, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none);
    Wz(2, z0 - 0.18, x0 - 0.18, x1 + 0.18, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none);
    Wx(3, x0 - 0.18, z0 - 0.15, z1 + 0.15, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none);
    Wx(1, x1 + 0.18, z0 - 0.15, z0 + 6, y0 + 0.1, y0 + 0.3, K.led, PAT.glow, MAT.none);
  }
  {
    const sa = x0 + 3, sb = x0 + 3 + Math.min(26, (x1 - x0) * 0.6);
    letters(mb, rng, Math.min(X(sa), X(sb)), Math.max(X(sa), X(sb)), H - 2.2, H + 0.1, z1 + 0.17, K.white);
    const za = z0 + 4, zb = z0 + 4 + Math.min(24, (z1 - z0) * 0.55), xf = x0 - 0.17;
    if (side > 0) turn(mb, 1, () => letters(mb, rng, za, zb, H - 2.2, H + 0.1, -xf, K.white));
    else turn(mb, 3, () => letters(mb, rng, -zb, -za, H - 2.2, H + 0.1, -xf, K.white));
  }
  // ---- 屋上：太陽光パネル、室外機、天窓 ----
  {
    // らせんの上の折り返しの場所はパネルを置かない
    const hz = (zc + z1) / 2;
    const sol = (a: number, b: number, za: number, zb: number) => solar(mb, Math.min(X(a), X(b)), za, Math.max(X(a), X(b)), zb, H);
    const useSolar = rng.next() < (big ? 0.75 : 0.45);
    if (helix) {
      if (useSolar) {
        sol(x0 + 1.5, x1 - 1.5, z0 + 6, hz - 7.5);
        sol(x0 + 1.5, x1 - 14, hz - 7.5, z1 - 1.5);
      } else skylights(mb, rng, xm0 + (side > 0 ? 0 : 14), z0 + 4, xm1 - (side > 0 ? 14 : 0), z1 - 2, H);
      G(x1 - 13, hz - 7, x1 - 0.4, hz + 7, H + 0.03, K.lane);
      for (let zz = hz - 6; zz < hz + 6; zz += 3.3) G(x1 - 12, zz, x1 - 3, zz + 0.15, H + 0.05, K.paint);
    } else if (useSolar) sol(x0 + 1.5, x1 - 1.5, z0 + 6, z1 - 1.5);
    else skylights(mb, rng, Math.min(X(x0), X(x1)), z0 + 4, Math.max(X(x0), X(x1)), z1 - 2, H);
    for (let i = 0; i < 3; i++) hvac(mb, X(x0 + 3 + i * 6) - 2.2, z0 + 1.2, H, 4.4, 2.6);
  }

  // ---- ランプ ----
  if (!helix) {
    const lb = 6, zr0 = z0 + lb, zr1 = z1 - 8, lw = (rw - 0.3) / 2;
    const aA = x1 + 0.3 + lw, aB = xo; // 外の車線
    const bA = x1 + 0.3, bB = x1 + 0.3 + lw; // 内の車線
    const run = (a: number, b: number, za: number, ya: number, zb: number, yb: number, glow: boolean) => {
      const p = X(a), q = X(b);
      rampRun(mb, Math.min(p, q), Math.max(p, q), za, ya, zb, yb, glow ? side : 0, wall, accent);
    };
    // 奥の折り返し：半階の高さの半円の踊り場（白い手すり壁と会社の色の線が、らせんのように曲がって見える）
    const rc = X((x1 + 0.3 + xo) / 2), rr = (xo - x1 - 0.3) / 2;
    for (let k = 0; k < levels - 1; k++) {
      const y = k * fh;
      run(aA, aB, zr1, y, zr0, y + fh / 2, true);
      run(bA, bB, zr0, y + fh / 2, zr1, y + fh, false);
      turnaround(mb, rc, zr0, rr, y + fh / 2, wall, accent);
    }
    // ランプの塔の屋根（建物の屋上と同じ高さ。奥は半円に丸める）と、まわりの会社の色の帯
    const xt = xo + 0.65, tc = X((x1 + xt) / 2), tr = (xt - x1) / 2;
    B(x1, H - 0.9, zr0, xt, H, z1, K.slab, 0, { roof: K.roof, bot: K.under, m: MAT.concrete, rm: MAT.membrane });
    halfDisc(mb, tc, zr0, tr, H - 0.9, H, K.slab, K.roof);
    B(x1, H - 2.8, z1 - 0.25, xt + 0.15, H + 0.6, z1 + 0.15, accent, 0, { roof: K.cap, m: MAT.metal });
    B(xt - 0.25, H - 2.8, zr0, xt + 0.15, H + 0.6, z1 - 0.25, accent, 0, { roof: K.cap, m: MAT.metal });
    arcBand(mb, tc, zr0, tr + 0.15, 0.4, Math.PI, TAU, 10, H - 2.8, H + 0.6, accent);
    Wz(0, z1 + 0.18, x1, xt + 0.18, H - 2.7, H - 2.5, K.led, PAT.glow, MAT.none);
    Wx(1, xt + 0.18, zr0, z1 + 0.15, H - 2.7, H - 2.5, K.led, PAT.glow, MAT.none);
    for (let i = 0; i < 2; i++) hvac(mb, X((x1 + xo) / 2) - 2.2, zr0 + 1 + i * 5, H, 4.4, 2.4);
    // 外の柱（まっすぐな側と、半円のまわりの丸い柱）
    for (const zz of [zr0, (zr0 + zr1) / 2, zr1, z1 - 0.8]) B(xo - 0.1, 0, zz - 0.4, xo + 0.65, H - 2.8, zz + 0.4, K.white2, 0, { roof: K.cap, m: MAT.concrete });
    for (const a of [1.3, 1.5, 1.7].map((t) => t * Math.PI)) mb.cylinder(rc + Math.cos(a) * (rr + 0.4), zr0 + Math.sin(a) * (rr + 0.4), 0, H - 2.8, 0.36, 8, K.white2, K.cap);
    // 入口の白線（矢印のかわりの線）
    G(aA + 0.8, zr1, aA + 1.0, z1 + 6, 0.11, K.paint);
  } else {
    // ---- らせん ----
    const hx = x1 + R, hz = (zc + z1) / 2, turns = levels;
    const cx = X(hx), a0 = side > 0 ? Math.PI : 0;
    helixRamp(mb, cx, hz, R, rIn, a0, turns, fh, K.white, accent, 22);
    const topY = turns * fh;
    // 中心の柱（白。いちばん上の周の手すりより少し上まで）
    mb.cylinder(cx, hz, 0, topY + 1.2, 2.3, 14, K.white2, K.cap);
    // 外の柱（いちばん上の周の手すりの高さまで）
    for (let k = 0; k < 6; k++) {
      const da = Math.PI / 6 + (k * TAU) / 6, a = a0 + da, px = cx + Math.cos(a) * (R + 0.35), pz = hz + Math.sin(a) * (R + 0.35);
      bx(mb, px - 0.32, 0, pz - 0.32, px + 0.32, (turns - 1 + da / TAU) * fh + 1.2, pz + 0.32, K.white2, 0, { roof: K.cap, m: MAT.concrete });
    }
    // いちばん上の周の照明柱
    for (let k = 1; k < 4; k++) {
      const a = a0 + (turns - 1) * TAU + (k * TAU) / 4, y = (turns - 1 + k / 4) * fh + 1.45;
      const px = cx + Math.cos(a) * (R - 0.15), pz = hz + Math.sin(a) * (R - 0.15);
      bx(mb, px - 0.1, y, pz - 0.1, px + 0.1, y + 6, pz + 0.1, K.steel, 0, { m: MAT.metal });
      bx(mb, px - 0.5, y + 6, pz - 0.5, px + 0.5, y + 6.35, pz + 0.5, K.led, PAT.glow, { roof: K.steel });
    }
    // らせんの上のトラック（止まっている）。弦の向きに置く（前と後ろの端が車線の真ん中にくる）
    const rm = (R + rIn) / 2 + 0.6, tk: TK = 'small', tl = TLEN[tk], da = 2 * Math.asin(tl / (2 * rm));
    for (let k = 0; k < turns; k++) {
      if (rng.next() < 0.3) continue;
      const fr = 0.15 + rng.next() * 0.55, a = a0 + (k + fr) * TAU, y = (k + fr) * fh;
      truck(mb, cx + Math.cos(a) * rm, hz + Math.sin(a) * rm, a + Math.PI / 2 + da / 2, tk, rng.next() < 0.8 ? K.white : K.silver, rng.pick(CABS), y + 0.05, ((da / TAU) * fh) / tl);
    }
    // 白い縦ルーバーで包む（すき間から帯とトラックが見える）
    if (kind === 'screen') {
      const rs = R + 1.0, nf = Math.round((TAU * rs) / 1.8);
      for (let i = 0; i < nf; i++) {
        const a = (i / nf) * TAU;
        const P = vframe(cx + Math.cos(a) * rs, 0, hz + Math.sin(a) * rs, a);
        const keep = mb.matOverride;
        mb.matOverride = MAT.metal;
        vb(mb, P, -0.4, 0.4, -0.13, 0.13, 3.2, topY + 2.4, K.white, K.cap);
        mb.matOverride = keep;
      }
      ring(mb, cx, hz, rs + 0.45, topY + 1.4, topY + 2.4, 40, K.white);
      ring(mb, cx, hz, rs + 0.45, 3.2, 4.0, 40, accent);
    }
    // ガラスの階段の塔（らせんの横）
    const ga = x1, gb = x1 + 5, gz0 = hz - R - 6, gz1 = hz - R - 1;
    if (gz0 > z0 + 1) {
      B(ga, 0, gz0, gb, H + 3, gz1, K.glass, PAT.curtain, { roof: K.cap, m: MAT.none });
      B(ga - 0.1, H + 3, gz0 - 0.1, gb + 0.1, H + 3.6, gz1 + 0.1, K.white, 0, { roof: K.cap, m: MAT.metal });
    }
  }

  // ---- 道路ぎわ：植え込み、ゲート、守衛所、フェンス、駐車場、照明 ----
  if (end) {
    // 縦長：道路の側の端（X(-hw)）に植え込み（前庭の出入口をあける）、出入口の横に守衛所と遮断機
    for (const [a, b] of cut(-hd + 0.5, hd - 0.5, [[z1 + 0.3, hd - 0.5]])) {
      G(-hw + 0.3, a, -hw + 3, b, 0.1, K.lawn);
      B(-hw + 2.0, 0, a + 0.3, -hw + 2.9, 0.9, b - 0.3, K.hedge, 0, { m: MAT.gravel });
      for (let z = a + 3; z < b - 2; z += 7 + rng.next() * 3) tf(X(-hw + 1.2), z, 0.75 + rng.next() * 0.25);
    }
    booth(mb, X(-hw + 6.5), z1 - 2.3, 0);
    B(-hw + 6.43, 0.95, z1 - 0.8, -hw + 6.57, 1.07, z1 + 7, K.white, 0, { m: MAT.none });
    fence(mb, X(-hw + 3), hd - 0.5, X(hw - 0.5), hd - 0.5);
    fence(mb, X(-hw + 3), -hd + 0.5, X(hw - 0.5), -hd + 0.5);
    fence(mb, X(hw - 0.5), -hd + 0.5, X(hw - 0.5), hd - 0.5);
    // 道路と倉庫の間の駐車場（2 列ずつ、間に通路）
    G(-hw + 3.2, z0 - 1, x0 - 0.8, z1 - 4.6, 0.1, K.court, PAT.lit);
    const pa = X(-hw + 3.6), pb = X(x0 - 1.2);
    for (let z = z0 - 0.5; z + 10 <= z1 - 5; z += 16) {
      carRow(mb, rng, Math.min(pa, pb), Math.max(pa, pb), z, z + 5, 0.7);
      carRow(mb, rng, Math.min(pa, pb), Math.max(pa, pb), z + 5.3, z + 10.3, 0.7);
    }
    // フェンスぎわで待つトレーラー（道路の向き）
    for (let x = x0 + ow + 4; x + 19 < x1 - 2; x += 19 + rng.next() * 8) {
      if (rng.next() < 0.35) continue;
      truck(mb, X(x + 18), cE - 1.45, side > 0 ? Math.PI : 0, rng.next() < 0.5 ? 'drop' : 'van', rng.next() < 0.8 ? K.white : K.silver, rng.pick(CABS));
    }
    // 照明塔はデッキの前（ランプの入口はあける）
    const lm = [x0 + ow + 3.5, (x0 + ow + x1) / 2, x1 - 2];
    for (const x of lm) mast(mb, X(x), z1 + 1.3, 13, front);
    return;
  }
  const gc = (x0 + ow + 4 + xo) / 2 + (helix ? 0 : 3), gw = 14;
  const gate: [number, number] = [gc - gw / 2, gc + gw / 2];
  for (const [a, b] of cut(-hw + 0.5, hw - 0.5, [[Math.min(X(gate[0]), X(gate[1])), Math.max(X(gate[0]), X(gate[1]))]])) {
    gq(mb, a, hd - 3, b, hd - 0.3, 0.1, K.lawn);
    bx(mb, a + 0.3, 0, hd - 2.9, b - 0.3, 0.9, hd - 2.0, K.hedge, 0, { m: MAT.gravel });
    for (let x = a + 3; x < b - 2; x += 7 + rng.next() * 3) tf(x, hd - 1.2, 0.75 + rng.next() * 0.25);
  }
  booth(mb, X(gate[0] - 3), hd - 6.5, 0);
  B(gate[0] - 1.6, 0.95, hd - 3.6, gate[1] - 4, 1.07, hd - 3.45, K.white, 0, { m: MAT.none });
  fence(mb, -hw + 0.5, hd - 3, -hw + 0.5, -hd + 0.5);
  fence(mb, -hw + 0.5, -hd + 0.5, hw - 0.5, -hd + 0.5);
  fence(mb, hw - 0.5, -hd + 0.5, hw - 0.5, hd - 3);
  // 事務所の前の駐車場
  {
    const pa = X(x0 - 2), pb = X(x0 + ow + 3);
    carRow(mb, rng, Math.min(pa, pb), Math.max(pa, pb), hd - 9, hd - 3.6, 0.65);
  }
  mast(mb, X(x0 + ow + 3.5), z1 + 1.5, 13, front);
  mast(mb, X(xo - 1), hd - 4, 13, front);
  if (big) mast(mb, X((x0 + ow + xo) / 2 + 6), z1 + 1.5, 13, front);
}

// =====================================================================
// マルチテナント型の小さめの物流施設（ボックス型）。3×3、4×3 の敷地と、港のそばの細長い 5×3・6×3 など。
// 2〜3 層の金属パネルの箱。上のふちを会社の色の太い帯で包む。正面の上の階に細い窓の帯（横は最上階だけ、裏はなし）。
// 1階の正面に荷積み場（台、シャッター、深いひさし）、裏にも浅い荷積み場。
// 正面に会社の色の縦の搬送機の塔（夜は照らされる）、角にガラスの階段の塔、屋上に太陽光パネルか天窓
// =====================================================================
// 港のそばの縦長の大きな敷地（3×5、3×6）は、長い辺を道路と直角に置く（回した座標で描く。
// q = 1 なら道路が +x の端、q = 3 なら -x の端）。前庭は横の辺にそい、道路の側の端に事務所と駐車場とゲート
function mtBox(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number, srng?: Rng) {
  if (f.D > f.W && f.D >= 80) {
    const q = (srng ?? rng).next() < 0.5 ? 1 : 3;
    const tr: TF = q === 1 ? (x, z, s, k, y, c, h) => tf(-z, x, s, k, y, c, h) : (x, z, s, k, y, c, h) => tf(z, -x, s, k, y, c, h);
    turn(mb, q, () => mtBoxBody(mb, { W: f.D, D: f.W, base: f.base }, rng, tr, den, srng, q));
    return;
  }
  mtBoxBody(mb, f, rng, tf, den, srng, 0);
}
function mtBoxBody(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number, srng: Rng | undefined, q: number) {
  const hw = f.W / 2, hd = f.D / 2;
  const end = q !== 0;
  // 連結した敷地どうしでそろえる選び方（色・事務所の向き・屋根）。連結がなければ rng そのもの
  const S = srng ?? (f.campus !== undefined ? new Rng(f.campus) : rng);
  const jl = !!f.joinL, jr = !!f.joinR, joined = jl || jr;
  const lead = f.campus === undefined || !!f.lead;
  const two = f.D >= 56; // 裏にも前庭のある荷積み場
  // 階数：港のそばの長い敷地（5×3 など）は密度で 2〜3 層
  const big = Math.max(f.W, f.D) >= 80;
  const fh = 7, n = big ? (den >= 2 || joined ? 3 : 2) : Math.max(f.W, f.D) < 56 && !joined ? 2 : 3, H = n * fh;
  // 前庭の奥行き（10t のウイング車が、ひさしの外へ半分以上出て止まれる長さ）
  const cd = f.D >= 48 ? Math.min(16.5, Math.max(15.5, f.D * 0.3)) : 12;
  const z1 = hd - 3 - cd, z0 = two ? -hd + 1 + cd : -hd + 6;
  const accent = S.pick(ACCENT), wall = finish(S);
  // 事務所を左か右か（連結したときは、つながっていない端。両側がつながっていれば事務所なし）
  const fr = S.next();
  // 縦長の大きな敷地は、事務所を道路の側の端に
  const flip = end ? q === 1 : jl && !jr ? true : jr && !jl ? false : fr < 0.5;
  const office = !(jl && jr);
  const X = (x: number) => (flip ? -x : x);
  // 建物の端：敷地の座標（wl..wr。つながる側は敷地の端まで）と、回した座標（X の中）
  const ep = end ? 13 : 0; // 縦長：道路の側の端の駐車場と植え込み
  const wl = jl ? -hw : -hw + 2.5 + (flip ? 0 : ep), wr = jr ? hw : hw - 2.5 - (flip ? ep : 0);
  const x0 = flip ? -wr : wl, x1 = flip ? -wl : wr;
  const ja = flip ? jr : jl, jb = flip ? jl : jr; // 回した座標で x0 / x1 の側がつながる
  const eL = jl ? 0 : 1, eR = jr ? 0 : 1; // 敷地の座標で、帯や目地を端から外へ出すかどうか
  const sL = jl ? -hw : -hw + 0.5, sR = jr ? hw : hw - 0.5; // 舗装・植え込みの端
  const ow = office ? Math.min(10, (x1 - x0) * 0.28) : 0;
  mb.flatRoofMat = MAT.membrane;
  gq(mb, jl ? -hw : -hw + 0.2, -hd + 0.2, jr ? hw : hw - 0.2, hd - 0.2, 0.07, K.apron);
  const cE = end ? hd - 0.6 : hd - 3; // 前庭の外のふち（縦長はフェンスまで）
  court(mb, sL, z1, sR, cE);
  if (two) court(mb, sL, -hd + 0.5, sR, z0);
  // 箱：1階は窓なし、上の階は細い窓の帯。根元の灰色の帯と、各階の目地
  const skip = (jl ? 8 : 0) | (jr ? 4 : 0); // となりとくっつく端の壁は描かない
  bx(mb, wl, 0, z0, wr, fh, z1, wall, 0, { roof: null, m: MAT.metal, skip });
  bx(mb, wl, fh, z0, wr, H, z1, wall, 0, { roof: K.roof, m: MAT.metal, rm: MAT.membrane, skip });
  // 正面の各階の細い横長の窓（夜はうっすら光る）と、横の最上階の窓（つながる側はなし）
  for (let k = 1; k < n; k++) {
    const y = k * fh + 2.6;
    wq(mb, 0, z1 + 0.03, wl + eL, wr - eR, y, y + 0.8, K.glassDk, PAT.lit, MAT.none);
  }
  {
    const y = (n - 1) * fh + 2.6;
    if (!jr) wq(mb, 1, wr + 0.03, z0 + 3, z1 - 3, y, y + 0.8, K.glassDk, PAT.lit, MAT.none);
    if (!jl) wq(mb, 3, wl - 0.03, z0 + 3, z1 - 3, y, y + 0.8, K.glassDk, PAT.lit, MAT.none);
  }
  bx(mb, wl - 0.05 * eL, 0, z0 - 0.05, wr + 0.05 * eR, 1.0, z1 + 0.05, K.conc, 0, { roof: null, m: MAT.concrete, skip });
  for (let k = 1; k < n; k++) bx(mb, wl - 0.06 * eL, k * fh - 0.3, z0 - 0.06, wr + 0.06 * eR, k * fh + 0.05, z1 + 0.06, K.joint, 0, { m: MAT.metal, skip });
  // 上のふちを包む会社の色の帯
  band(mb, wl, z0, wr, z1, H - 2.8, H + 0.6, accent, jl, jr);
  // 荷積み場（正面と、裏）：台、シャッター（2枚ずつ柱の間に）、ひさし（深さ 7.5m まで）、10t のウイング車
  const dock = (back: boolean) => {
    const zf = back ? -z0 : z1; // 回した座標での壁の位置
    // 範囲：つながる端は敷地の端まで（ひさしがとなりにつながる）。正面は事務所の横から。
    // 裏は turn 2 の座標（敷地の x = -u）
    let xa: number, xb: number, oa: boolean, ob: boolean;
    if (back) {
      xa = -wr + (jr ? 0 : 1.5); xb = -wl - (jl ? 0 : 1.5); oa = jr; ob = jl;
    } else {
      const da = x0 + (ow > 0 ? ow + 1.5 : ja ? 0 : 1.5), db = x1 - (jb ? 0 : 1.5);
      xa = Math.min(X(da), X(db)); xb = Math.max(X(da), X(db));
      oa = jl && xa <= -hw + 0.01; ob = jr && xb >= hw - 0.01;
    }
    // 裏の浅い荷積み場（前庭なし）は台とひさしだけ
    const shallow = back && !two;
    const dep = shallow ? 4.5 : 7.5;
    const pd = shallow ? 2.0 : 3.0;
    const draw = () => {
      bx(mb, xa, 0, zf, xb, 1.0, zf + pd, K.conc, 0, { roof: K.apron, m: MAT.concrete, skip: (oa ? 8 : 0) | (ob ? 4 : 0) });
      gq(mb, xa, zf + pd, xb, zf + dep, 0.1, K.litGround, PAT.lit);
      const xs = slots(xa + (oa ? 1 : 0), xb - (ob ? 1 : 0), 5.5, 0.4);
      doors(mb, xs, zf, 1.0, 4.4, 4.4, false, zf + pd, 2);
      canopy(mb, xa - (oa ? 0 : 0.5), xb + (ob ? 0 : 0.5), zf, dep, shallow ? 5.6 : 6.3, accent, shallow ? 0 : 11, oa, ob);
      if (shallow) return;
      const room = back ? cd - 2.9 : cE - 0.3 - zf - 3.15;
      const on = pickSome(rng, xs.length, 0.6);
      for (let i = 0; i < xs.length; i++) {
        if (!on[i]) continue;
        const kk = fitKind(rng, room, ['wing', 'wing', 'wingOpen']);
        const body = rng.next() < 0.3 ? accent : rng.next() < 0.8 ? K.white : K.silver;
        if (kk) truck(mb, xs[i], zf + 3.15, Math.PI / 2, kk, body, rng.pick(CABS));
      }
    };
    if (back) turn(mb, 2, draw);
    else draw();
  };
  dock(false);
  dock(true);
  // 縦の搬送機の塔（会社の色、ひさしの上から屋上の上まで）
  const span = x1 - x0 - ow;
  const towers = (span > 60 ? [0.42, 0.66, 0.9] : [0.62, 0.9]).map((t) => x0 + ow + span * t);
  for (const tx of towers) {
    const xs = X(tx);
    bx(mb, xs - 2, 6.9, z1, xs + 2, H + 3, z1 + 1.3, accent, PAT.lit, { roof: K.cap, m: MAT.metal });
    wq(mb, 0, z1 + 1.33, xs - 0.35, xs + 0.35, 8, H + 2, K.white, 0, MAT.metal);
  }
  // 帯に直接書いた白い大きな文字（正面は連結の中の 1 つだけ。横は事務所の側の端）
  {
    const sa = x0 + 2, sb = Math.min(x0 + 2 + 24, towers[0] - 2.6);
    if (lead && sb - sa > 8) letters(mb, rng, Math.min(X(sa), X(sb)), Math.max(X(sa), X(sb)), H - 2.2, H + 0.1, z1 + 0.17, K.white);
    const za = z0 + 2, zb = Math.min(z1 - 2, za + 24), xf = x0 - 0.17;
    if (office) {
      if (!flip) turn(mb, 1, () => letters(mb, rng, za, zb, H - 2.2, H + 0.1, -xf, K.white));
      else turn(mb, 3, () => letters(mb, rng, -zb, -za, H - 2.2, H + 0.1, -xf, K.white));
    }
  }
  // ガラスの事務所（正面の角、2層）と、ガラスの階段の塔（つながっていない端）
  if (office) {
    const a = X(x0), b = X(x0 + ow);
    const oa = Math.min(a, b), ob = Math.max(a, b);
    bx(mb, oa - 0.3, 0, z1 - 3, ob + 0.3, 9, z1 + 2.5, K.glass, PAT.curtain, { roof: K.roof, m: MAT.none, rm: MAT.membrane });
    bx(mb, oa - 0.5, 9, z1 - 3.2, ob + 0.5, 9.6, z1 + 2.7, K.white, 0, { roof: K.cap, m: MAT.metal });
    // 事務所の前の駐車場
    if (!end && hd - 3.5 - (z1 + 3) >= 5) carRow(mb, rng, Math.max(-hw + 0.6, flip ? oa - 3 : oa - 1), Math.min(hw - 0.6, flip ? ob + 1 : ob + 3), hd - 8.6, hd - 3.6, 0.6);
  }
  if (!jb) {
    const ta = X(x1 - 4.2), tb = X(x1 + 0.8);
    bx(mb, Math.min(ta, tb), 0, z0 + 2, Math.max(ta, tb), H + 2.5, z0 + 6.5, K.glass, PAT.curtain, { roof: K.cap, m: MAT.none });
  }
  // 屋上：奥の半分に太陽光パネル、手前に天窓の帯と室外機。または天窓（帯・格子）と室外機
  const hv = (x: number, z: number) => { const p = X(x), q = X(x + 4.4); hvac(mb, Math.min(p, q), z, H, 4.4, 2.4); };
  if (S.next() < 0.6) {
    const zm = (z0 + z1) / 2;
    solar(mb, wl + 1.5 * eL, z0 + 1.5, wr - 1.5 * eR, zm, H);
    for (let x = x0 + 16; x + 1.6 < x1 - 2; x += 9) { const p = X(x), q = X(x + 1.6); skylight(mb, Math.min(p, q), zm + 1.5, Math.max(p, q), z1 - 2, H); }
    for (let i = 0; i < 2; i++) hv(x0 + 3 + i * 6, z1 - 4.5);
  } else {
    skylights(mb, S, wl, z0 + 2.5, wr, z1, H);
    for (let i = 0; i < 2; i++) hv(x0 + 3 + i * 6, z0 + 1.5);
  }
  if (end) {
    // 縦長：道路の側の端（rx）に植え込み（前庭の出入口をあける）、出入口の横に守衛所と遮断機、建物との間に駐車場。ほかの 3 辺はフェンス
    const sg = X(x0) > 0 ? 1 : -1, rx = sg * hw;
    const P = (a: number, b: number): [number, number] => [Math.min(rx - sg * a, rx - sg * b), Math.max(rx - sg * a, rx - sg * b)];
    for (const [a, b] of cut(-hd + 0.5, hd - 0.5, [[z1 + 3, hd - 0.5]])) {
      const [la, lb] = P(0.3, 3), [ea, eb] = P(2.0, 2.9);
      gq(mb, la, a, lb, b, 0.1, K.lawn);
      bx(mb, ea, 0, a + 0.3, eb, 0.8, b - 0.3, K.hedge, 0, { m: MAT.gravel });
      for (let z = a + 2.5; z < b - 1.5; z += 6.5 + rng.next() * 3) tf(rx - sg * 1.2, z, 0.7 + rng.next() * 0.2);
    }
    booth(mb, rx - sg * 6.5, z1 + 0.6, 0);
    {
      const [aa, ab] = P(6.43, 6.57);
      bx(mb, aa, 0.95, z1 + 2.1, ab, 1.07, z1 + 9, K.white, 0, { m: MAT.none });
    }
    const [fa, fb] = P(3, 2 * hw - 0.5);
    fence(mb, fa, hd - 0.5, fb, hd - 0.5);
    fence(mb, fa, -hd + 0.5, fb, -hd + 0.5);
    fence(mb, -rx + sg * 0.5, -hd + 0.5, -rx + sg * 0.5, hd - 0.5);
    // 駐車場（2 列ずつ、間に通路）
    const [pa, pb] = P(3.6, hw - Math.abs(X(x0)) - 1.2);
    gq(mb, pa - 0.4, z0 - 1, pb + 0.4, z1 - 4.4, 0.1, K.court, PAT.lit);
    for (let z = z0 - 0.5; z + 10 <= z1 - 5; z += 16) {
      carRow(mb, rng, pa, pb, z, z + 5, 0.7);
      carRow(mb, rng, pa, pb, z + 5.3, z + 10.3, 0.7);
    }
    const fr: Rect = [sL, z1, sR, cE];
    for (const t of [0.15, 0.5, 0.85]) mast(mb, X(x0 + ow + (x1 - x0 - ow) * t), hd - 1.6, 12, fr);
    return;
  }
  // 道路ぎわの植え込みとゲート、フェンス（つながる側はなし。植え込みは端まで続ける）
  const ga = Math.min(X(x0 + ow + 6), X(x0 + ow + 18)), gb = Math.max(X(x0 + ow + 6), X(x0 + ow + 18));
  for (const [a, b] of cut(sL, sR, [[ga, gb]])) {
    gq(mb, a, hd - 3, b, hd - 0.3, 0.1, K.lawn);
    bx(mb, a + (a <= -hw + 0.01 ? 0 : 0.3), 0, hd - 2.9, b - (b >= hw - 0.01 ? 0 : 0.3), 0.8, hd - 2.1, K.hedge, 0, { m: MAT.gravel });
    for (let x = a + 2.5; x < b - 1.5; x += 6.5 + rng.next() * 3) tf(x, hd - 1.2, 0.7 + rng.next() * 0.2);
  }
  if (!jl) fence(mb, -hw + 0.5, hd - 3, -hw + 0.5, -hd + 0.5);
  fence(mb, jl ? -hw + 0.07 : -hw + 0.5, -hd + 0.5, jr ? hw - 0.07 : hw - 0.5, -hd + 0.5);
  if (!jr) fence(mb, hw - 0.5, -hd + 0.5, hw - 0.5, hd - 3);
  mast(mb, Math.max(-hw + 2.2, Math.min(hw - 2.2, (ga + gb) / 2 + (flip ? -8 : 8))), hd - 4, 12, [sL, z1, sR, hd - 3]);
}

// 1×2 の小さな敷地：2層の小さな倉庫、搬入口 2〜3、縦の搬送機の塔、小さなトラック
function mtMini(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  longFrame(mb, f, tf, (L) => {
    const ha = L.A / 2, hb = L.B / 2;
    const accent = rng.pick(ACCENT), wall = finish(rng);
    mb.flatRoofMat = MAT.membrane;
    gq(mb, -ha + 0.2, -hb + 0.2, ha - 0.2, hb - 0.2, 0.07, K.apron);
    court(mb, -ha + 0.5, 0, ha - 0.5, hb - (L.end ? 0.5 : 2));
    const u0 = -ha + 2, u1 = ha - (L.end ? 6 : 2), v0 = -hb + 1.5, v1 = 0, H = 12.5;
    bx(mb, u0, 0, v0, u1, H, v1, wall, PAT.industrial, { roof: K.roof, m: MAT.metal, rm: MAT.membrane });
    bx(mb, u0 - 0.05, 0, v0 - 0.05, u1 + 0.05, 0.9, v1 + 0.05, K.conc, 0, { roof: null, m: MAT.concrete });
    bx(mb, u0 - 0.06, 6.7, v0 - 0.06, u1 + 0.06, 7.05, v1 + 0.06, K.joint, 0, { m: MAT.metal });
    rim(mb, u0, v0, u1, v1, H, 1.2, wall);
    // ガラスの事務所（道路側の端）
    const oa = L.end ? u1 - 1 : u1 - 7;
    bx(mb, oa, 0, v0 + 0.5, u1 + (L.end ? 3.5 : 0.3), 7, v1 + 1.2, K.glass, PAT.curtain, { roof: K.cap, m: MAT.none });
    // 搬入口とひさし
    const xs = slots(u0 + 1, oa - 1, 4.4, 0.3);
    doors(mb, xs, v1, 0.9, 3.2, 3.6, false, null, 2);
    canopy(mb, u0 + 0.5, oa - 0.5, v1, 3.2, 5.2, accent, 0);
    const room = (L.end ? hb - 0.5 : hb - 2.1) - 0.3;
    for (let i = 0; i < xs.length; i++) {
      if (i % 2 !== 0 && rng.next() > 0.3) continue;
      const k = fitKind(rng, room, ['small', 'pvan']);
      if (k) truck(mb, xs[i], v1 + 0.3, Math.PI / 2, k, rng.next() < 0.5 ? K.white : accent, rng.pick(CABS));
    }
    // 縦の搬送機の塔（会社の色）
    const tx = u0 + 2.2;
    bx(mb, tx - 1.8, 0, v0 - 0.8, tx + 1.8, H + 2.5, v0 + 2.5, accent, PAT.lit, { roof: K.cap, m: MAT.metal });
    solar(mb, u0 + 5, v0 + 1, oa - 1, v1 - 1, H, 2.6);
    // 道路ぎわ
    if (L.end) {
      gq(mb, ha - 2.5, -hb + 0.3, ha - 0.3, 0, 0.1, K.lawn);
      L.tree(ha - 1.4, -hb + 2.5, 0.7);
    } else {
      gq(mb, -ha + 0.3, hb - 2, ha - 9, hb - 0.3, 0.1, K.lawn);
      for (let u = -ha + 2; u < ha - 10; u += 7) L.tree(u, hb - 1.1, 0.7);
    }
  });
}

// =====================================================================
// 配送センター・トラックターミナル・宅配の仕分けハブ（distCenter）
// 長い 1 層の建物。敷地の長い方向を u とした座標で描く（道路は、横長の敷地なら +v の長い辺、縦長なら +u の端）
// =====================================================================
// jl / jr = -u / +u の端がとなりの敷地の建物につながる（横長の敷地だけ）。lead = 看板を描く敷地。
// rs = 連結した敷地どうしでそろえる選び方の乱数（連結がなければ null）
interface LF { A: number; B: number; end: boolean; tree: (u: number, v: number, s: number) => void; jl: boolean; jr: boolean; lead: boolean; rs: Rng | null }
function longFrame(mb: MeshBuilder, f: LotFrame, tf: TF, draw: (L: LF) => void) {
  const end = f.W < f.D;
  const A = end ? f.D : f.W, B = end ? f.W : f.D;
  const tree = (u: number, v: number, s: number) => (end ? tf(-v, u, s) : tf(u, v, s));
  const jl = !end && !!f.joinL, jr = !end && !!f.joinR;
  const lead = f.campus === undefined || !!f.lead || !(jl || jr);
  const rs = f.campus !== undefined ? new Rng(f.campus) : null;
  turn(mb, end ? 1 : 0, () => draw({ A, B, end, tree, jl, jr, lead, rs }));
}
// 道路ぎわの植え込みと出入口（横長：+v の辺、縦長：+u の端）。gaps は出入口（道路にそった座標）
function roadEdge(mb: MeshBuilder, rng: Rng, L: LF, gaps: [number, number][]) {
  const ha = L.A / 2, hb = L.B / 2;
  // つながる端は敷地の端まで続ける
  const e0 = L.jl ? -ha : -(L.end ? hb : ha) + 0.4, e1 = L.jr ? ha : (L.end ? hb : ha) - 0.4;
  for (const [a, b] of cut(e0, e1, gaps)) {
    if (L.end) {
      gq(mb, ha - 2.8, a, ha - 0.3, b, 0.1, K.lawn);
      bx(mb, ha - 2.7, 0, a + 0.3, ha - 1.9, 0.8, b - 0.3, K.hedge, 0, { m: MAT.gravel });
      for (let v = a + 2.5; v < b - 1.5; v += 6.5 + rng.next() * 3) L.tree(ha - 1.1, v, 0.7 + rng.next() * 0.2);
    } else {
      gq(mb, a, hb - 2.8, b, hb - 0.3, 0.1, K.lawn);
      bx(mb, a + (L.jl && a <= -ha + 0.01 ? 0 : 0.3), 0, hb - 2.7, b - (L.jr && b >= ha - 0.01 ? 0 : 0.3), 0.8, hb - 1.9, K.hedge, 0, { m: MAT.gravel });
      for (let u = a + 2.5; u < b - 1.5; u += 6.5 + rng.next() * 3) L.tree(u, hb - 1.1, 0.7 + rng.next() * 0.2);
    }
  }
}
// 敷地のまわりのフェンス（道路側はのぞく）
function siteFence(mb: MeshBuilder, L: LF) {
  const ha = L.A / 2, hb = L.B / 2;
  if (L.end) {
    fence(mb, ha - 3, -hb + 0.5, -ha + 0.5, -hb + 0.5);
    fence(mb, -ha + 0.5, -hb + 0.5, -ha + 0.5, hb - 0.5);
    fence(mb, -ha + 0.5, hb - 0.5, ha - 3, hb - 0.5);
  } else {
    // つながる端にはフェンスを引かない
    if (!L.jl) fence(mb, -ha + 0.5, hb - 3, -ha + 0.5, -hb + 0.5);
    fence(mb, L.jl ? -ha + 0.07 : -ha + 0.5, -hb + 0.5, L.jr ? ha - 0.07 : ha - 0.5, -hb + 0.5);
    if (!L.jr) fence(mb, ha - 0.5, -hb + 0.5, ha - 0.5, hb - 3);
  }
}
// 建物の長い面（+v の向きの壁 v）に、トレーラーを付けた米国式の搬入口（床の高さ 1.2m、黒いシェルター）。
// back = 裏（-v の向き）。room = 前に空いている長さ
// avoid = トレーラーを止めない u の範囲（守衛所や照明塔の前など）
function usDocks(mb: MeshBuilder, rng: Rng, ua: number, ub: number, v: number, back: boolean, room: number, fill: number, reefer = 0.2, pitch = 4.0, avoid: [number, number][] = []) {
  const draw = () => {
    const a = back ? -ub : ua, b = back ? -ua : ub, w = back ? -v : v;
    const xs = slots(a, b, pitch, 0.3);
    doors(mb, xs, w, 1.2, 2.7, 3.0, true, null, 2);
    // 誘導の白線
    for (const x of xs) gq(mb, x + 1.95, w + 0.4, x + 2.08, w + Math.min(9, room - 1), 0.11, K.paint);
    const on = pickSome(rng, xs.length, fill);
    xs.forEach((x, i) => {
      if (!on[i] || avoid.some(([a, b]) => x > a && x < b)) return;
      const k = fitKind(rng, room - 0.6, rng.next() < reefer ? ['reefer', 'drop'] : ['drop', 'drop', 'van']);
      if (k) truck(mb, x, w + 0.4, Math.PI / 2, k, K.white, rng.pick(CABS));
    });
  };
  if (back) turn(mb, 2, draw);
  else draw();
}

// 米国式のクロスドック（両面の搬入口）か、フルフィルメントセンター（片面に長い搬入口の列）。
// ティルトアップのコンクリートの板の壁（目地の線、2色の灰色、会社の色の帯）、角にガラスの事務所、白い屋根に天窓の格子
function tiltShed(mb: MeshBuilder, rng: Rng, L: LF, den: number, fc: boolean) {
  const ha = L.A / 2, hb = L.B / 2;
  const S = L.rs ?? rng, jl = L.jl, jr = L.jr; // 連結した敷地どうしでそろえる選び方、つながる端
  const small = L.A < 40; // 2×2：低い倉庫、1 層の小さなガラスの事務所、搬入口を詰めて並べる
  const big = L.A >= 80; // 港のそばの大きな敷地：背を少し高く（高さと長さの比を 0.15 くらいに）、搬入口に長いひさし
  const both = !fc && L.B >= 44;
  const h = (small ? 9.5 : big ? 14.5 : 12.5) + (den >= 2 ? (small ? 0.5 : 1) : 0);
  const accent = fc ? K.navy : S.pick([C(0x1f8a8a), C(0x2f6fb5), C(0x1f4e8c), C(0x2e9e5b)]);
  const tint = finish(S);
  const base = fc ? C(0xd9dbdc) : tint, grey = fc ? C(0xe8e9ea) : C(0xbfc3c6);
  const signCol = fc ? C(0x2f6fb5) : accent;
  mb.flatRoofMat = MAT.membrane;
  // 配置（v の範囲）
  let v0: number, v1: number;
  const E = L.end ? 13 : 0;
  const u0 = jl ? -ha : -ha + 2, u1 = jr ? ha : ha - 2 - E;
  const sL = jl ? -ha : -ha + 0.5, sR = jr ? ha : ha - 0.5; // 舗装の端
  if (L.end) {
    if (both) { const bd = L.B >= 60 ? 26 : 16; v0 = -bd / 2; v1 = bd / 2; }
    else { v0 = -hb + 2; v1 = Math.min(v0 + 27, hb - 16); }
  } else if (both) {
    const bd = L.B >= 60 ? 26 : 16, cf = (L.B - 4 - bd) / 2;
    v1 = hb - 3 - cf; v0 = v1 - bd;
  } else {
    const cf = L.B >= 60 ? 30 : L.B >= 44 ? 18 : 14.5;
    v1 = hb - 3 - cf; v0 = -hb + 2;
  }
  gq(mb, jl ? -ha : -ha + 0.2, -hb + 0.2, jr ? ha : ha - 0.2, hb - 0.2, 0.07, K.apron);
  // トラックの前庭
  const frontRoom = (L.end ? hb - 1 : hb - 3.2) - v1;
  const frontR: Rect = [sL, v1, sR, v1 + frontRoom], backR: Rect = [sL, -hb + 0.5, sR, v0];
  court(mb, ...frontR);
  if (both) court(mb, ...backR);
  // 事務所の位置（連結したときは、つながっていない端。両方つながっていれば事務所なし）
  const oR = L.end ? 0 : S.next();
  const oe = L.end ? 1 : jl && !jr ? 1 : jr && !jl ? -1 : oR < 0.5 ? 1 : -1;
  const office = !(jl && jr);
  const ow = small ? 5 : Math.min(16, (u1 - u0) * 0.25);
  // 建物の箱（コンクリートの板）と屋根
  bx(mb, u0, 0, v0, u1, h, v1, base, 0, { roof: K.roof, m: MAT.concrete, rm: MAT.membrane, skip: (jl ? 8 : 0) | (jr ? 4 : 0) });
  rim(mb, u0, v0, u1, v1, h, 1.0, grey, 0.3, jl, jr);
  // 上の帯（2色目の灰色）と、会社の色の帯：4 面に
  const bandH = fc ? 2.4 : 3.0;
  const faces: [number, number, number, number][] = [[0, v1, u0, u1], [2, v0, u0, u1], [1, u1, v0, v1], [3, u0, v0, v1]];
  for (const [d, w, a, b] of faces) {
    if ((d === 1 && jr) || (d === 3 && jl)) continue;
    const s = d === 0 || d === 1 ? 1 : -1, ww = w + s * 0.03;
    wq(mb, d, ww, a, b, h - bandH, h, fc ? K.navy : grey, 0, MAT.concrete);
    if (!fc) wq(mb, d, ww + s * 0.01, a, b, h - 4.3, h - 3.1, accent, 0, MAT.none);
    // 板の目地（縦の細い線）
    for (let t = a + 9.6; t < b - 1; t += 9.6) wq(mb, d, ww + s * 0.02, t, t + 0.12, 0.3, h - (fc ? bandH : 4.3), C(0x8d9399), 0, MAT.concrete);
  }
  // 会社の色の角（事務所の反対の正面の角を、2 つの面で縦に包む）
  const corner = !fc && !small && !(jl || jr);
  const cu = L.end ? u1 : oe > 0 ? u0 : u1; // 角の u
  if (corner) {
    const cs = cu > 0 ? 1 : -1;
    wq(mb, 0, v1 + 0.065, cs > 0 ? cu - 3.2 : cu, cs > 0 ? cu : cu + 3.2, 0.3, h - 3.1, accent, 0, MAT.concrete);
    wq(mb, cs > 0 ? 1 : 3, cu + cs * 0.065, v1 - 3.2, v1, 0.3, h - 3.1, accent, 0, MAT.concrete);
  }
  // 付け柱（FC：明るい灰色、等間隔）
  if (fc) for (let t = u0 + 6; t < u1 - 3; t += 12) {
    bx(mb, t - 0.7, 0, v1 - 0.1, t + 0.7, h + 0.8, v1 + 0.35, grey, 0, { roof: K.cap, m: MAT.concrete });
    if (both) bx(mb, t - 0.7, 0, v0 - 0.35, t + 0.7, h + 0.8, v0 + 0.1, grey, 0, { roof: K.cap, m: MAT.concrete });
  }
  // ガラスの事務所（横長の敷地：正面の角、縦長：道路側の端）と、高くした壁、金属のひさし
  let da = u0 + (jl ? 1 : 2), db = u1 - (jr ? 1 : 2); // 搬入口の範囲
  if (corner) { if (cu < 0) da = u0 + 4.2; else db = u1 - 4.2; }
  const oh = small ? 4.5 : 9; // 事務所の高さ
  if (L.end) {
    const oa = v0 + 1, ob = Math.min(v1 - 1, v0 + 16);
    bx(mb, u1 - 4, 0, oa, u1 + 4, oh, ob, fc ? K.glassDk : K.glassT, PAT.curtain, { roof: K.roof, m: MAT.none, rm: MAT.membrane });
    bx(mb, u1 - 4.3, oh, oa - 0.3, u1 + 4.3, oh + 0.6, ob + 0.3, K.white, 0, { roof: K.cap, m: MAT.metal });
    bx(mb, u1 + 4, 3.4, oa + 2, u1 + 6, 3.7, oa + 8, K.steel, 0, { roof: K.cap, m: MAT.metal });
    bx(mb, u1 - 0.35, h, oa, u1 + 0.05, h + 2.6, ob, base, 0, { roof: K.cap, m: MAT.concrete });
    // 回した座標（q=3）：u' = -v、v' = u。道路側（+u）を向いた看板と、事務所の前の駐車場
    turn(mb, 3, () => sign(mb, rng, -Math.min(ob - 1, oa + 15), -(oa + 1), h + 0.3, h + 2.4, u1 + 0.06, signCol));
    turn(mb, 1, () => carRow(mb, rng, oa, ob, -(ha - 3.3), -(u1 + 6.5), 0.7));
  } else if (!office) {
    // 連結のまん中の敷地：事務所なし。看板は正面のまん中（連結の中の 1 つだけ）
    const sl = Math.min(24, (u1 - u0) * 0.4);
    if (L.lead) sign(mb, rng, -sl / 2, sl / 2, h - 2.8, h - 0.2, v1 + 0.06, signCol);
  } else {
    const oa = oe > 0 ? u1 - ow : u0 - 0.3, ob = oe > 0 ? u1 + 0.3 : u0 + ow;
    bx(mb, oa, 0, v1 - 5, ob, oh, v1 + 2, fc ? K.glassDk : K.glassT, PAT.curtain, { roof: K.roof, m: MAT.none, rm: MAT.membrane });
    bx(mb, oa - 0.3, oh, v1 - 5, ob + 0.3, oh + 0.6, v1 + 2.3, K.white, 0, { roof: K.cap, m: MAT.metal });
    if (!small) {
      bx(mb, oa + 2, 3.4, v1 + 2, oa + 8, 3.7, v1 + 4.6, K.steel, 0, { roof: K.cap, m: MAT.metal });
      bx(mb, oa, h, v1 - 0.35, ob, h + 2.6, v1 + 0.05, base, 0, { roof: K.cap, m: MAT.concrete });
    }
    if (oe > 0) db = oa - (small ? 1.5 : 3); else da = ob + (small ? 1.5 : 3);
    // 大きな看板：正面の上の帯（事務所のとなり）と、事務所の側の端の面
    const sl = Math.min(24, (u1 - u0 - ow) * 0.6), sy0 = h - 2.8, sy1 = h - 0.2;
    const sa = oe > 0 ? oa - 1.5 - sl : ob + 1.5, sb = sa + sl;
    if (L.lead) sign(mb, rng, sa, sb, sy0, sy1, v1 + 0.06, signCol);
    const ea = v0 + 2, eb = Math.min(v1 - 6.5, ea + 24);
    if (eb - ea > 8) {
      if (oe > 0) turn(mb, 3, () => sign(mb, rng, -eb, -ea, sy0, sy1, u1 + 0.06, signCol));
      else turn(mb, 1, () => sign(mb, rng, ea, eb, sy0, sy1, -u0 + 0.06, signCol));
    }
    // 事務所の前の駐車場（前庭の端）
    const pa = oe > 0 ? ob - ow - 4 : oa, pb = oe > 0 ? ob : oa + ow + 4;
    carRow(mb, rng, Math.max(-ha + 1, pa), Math.min(ha - 1, pb), hb - 8.6, hb - 3.6, 0.7);
  }
  // 道路ぎわの出入口と守衛所の位置（守衛所の前の搬入口にはトレーラーを止めない）
  const gaps: [number, number][] = L.end ? [[v1 + 4, hb - 1], ...(both ? [[-hb + 1, v0 - 1] as [number, number]] : [])] : [[oe > 0 ? da + 2 : db - 16, oe > 0 ? da + 16 : db - 2]];
  // つながる端のすぐそばには出入口を置かない（守衛所が敷地からはみ出さないように）
  if (!L.end && jl && gaps[0][0] < -ha + 5) gaps[0] = [-ha + 5, gaps[0][1] - gaps[0][0] - ha + 5];
  if (!L.end && jr && gaps[0][1] > ha - 5) gaps[0] = [gaps[0][0] - gaps[0][1] + ha - 5, ha - 5];
  const bu = gaps[0][0] - 2.2, mu = (u0 + u1) / 2;
  // 搬入口（前と裏）
  usDocks(mb, rng, da, db, v1, false, fc && frontRoom >= 28 ? 17 : frontRoom, 0.55, 0.2, small ? 3.7 : 4.0, L.end ? [[mu - 1.6, mu + 1.6]] : [[bu - 3, bu + 3], [mu - 1.6, mu + 1.6]]);
  if (both) usDocks(mb, rng, u0 + 2, u1 - 2, v0, true, v0 + hb - 0.5, 0.5);
  // 大きな敷地と 4×4 の FC：搬入口の列の上に長いひさし（片持ち）。大きな敷地のクロスドックは両面に
  // つながる端は敷地の端まで（となりのひさしと 1 本につながる）
  const longCanopy = (fc && L.A >= 64) || big;
  if (longCanopy) {
    const ol = jl && da <= u0 + 1, or = jr && db >= u1 - 1;
    canopy(mb, ol ? -ha : da - 0.6, or ? ha : db + 0.6, v1, 4.6, 5.7, fc ? signCol : accent, 0, ol, or);
    if (both) turn(mb, 2, () => canopy(mb, jr ? -ha : -(u1 - 1.4), jl ? ha : -(u0 + 1.4), -v0, 4.6, 5.7, accent, 0, jr, jl));
  }
  // 前庭が深い FC：フェンスぎわにトレーラーの置き場の列
  if (fc && frontRoom >= 28) {
    const vz = hb - 3.4;
    for (let u = da + 1; u + 3 < db; u += 3.6) {
      gq(mb, u - 0.06, vz - 13.4, u + 0.06, vz, 0.11, K.paint);
      // 照明塔の前はあける
      if (rng.next() < 0.65 && Math.abs(u + 1.8 - mu) > 2) truck(mb, u + 1.8, vz - 12.8, Math.PI / 2, 'drop', K.white, K.white);
    }
  }
  // 屋根：天窓（帯・格子・なし）、室外機、（FC）太陽光パネル
  skylights(mb, S, u0 + 2, v0 + 6, u1 - 2, v1, h);
  for (let i = 0; i < 3; i++) hvac(mb, u0 + 9 + i * ((u1 - u0 - 18) / 2), v0 + 1.4 + (i % 2) * 2, h, 4.0, 2.2);
  if (fc && v1 - v0 > 20) solar(mb, u0 + 3, (v0 + v1) / 2 + 1, u1 - 3, v1 - 2.5, h);
  // 道路ぎわ・フェンス・照明
  roadEdge(mb, rng, L, gaps);
  siteFence(mb, L);
  if (L.end) booth(mb, ha - 6, v1 + 2.2, 0);
  else booth(mb, bu, hb - 6, 0);
  // 照明塔（ひさしがあるときは、ひさしの外に立てる）
  const mv = longCanopy ? v1 + 6.5 : v1 + 1.5;
  mast(mb, u0 + (jl ? 2.2 : 1.2), mv, 13, frontR);
  mast(mb, mu, Math.min(hb - 4, v1 + frontRoom - 1), 13, frontR);
  if (both) mast(mb, (u0 + u1) / 2, -hb + 1.5, 13, backR);
  // 大きな敷地：長い前庭の照明塔を増やす
  if (big) {
    if (!jr) mast(mb, u1 - 1.2, mv, 13, frontR);
    if (both) for (const t of [0.2, 0.8]) mast(mb, u0 + (u1 - u0) * t, -hb + 1.5, 13, backR);
  }
}

// 日本式のトラックターミナル：長い荷扱場（高さ 1m の台）に、両側へ大きく張り出した平らな屋根。壁はなく、中のかご台車が見える。
// 3.8m ごとのバースに 10t のウイング車（いくつかは羽を上げている）。屋根のふちにバースの番号の板。端に 3〜4 層の事務所。
// 港のそばの大きな敷地（長さ 80m 以上）は、荷扱場の上に 1 層の倉庫を載せる（高さと長さの比を 0.15 くらいに）
function truckTerminal(mb: MeshBuilder, rng: Rng, L: LF, den: number) {
  const ha = L.A / 2, hb = L.B / 2;
  const S = L.rs ?? rng, jl = L.jl, jr = L.jr; // 連結した敷地どうしでそろえる選び方、つながる端
  const eL = jl ? 0 : 1, eR = jr ? 0 : 1; // 屋根を端から外へ出すかどうか
  const both = L.B >= 44;
  const accent = S.pick([C(0x2f6fb5), C(0x2e9e5b), C(0x1f4e8c)]);
  const tint = finish(S);
  const small = L.A < 40; // 2×2：低い事務所（2 層）を短くして、荷扱場を長く
  const big = L.A >= 80;
  mb.flatRoofMat = MAT.membrane;
  gq(mb, jl ? -ha : -ha + 0.2, -hb + 0.2, jr ? ha : ha - 0.2, hb - 0.2, 0.07, K.apron);
  const yard: Rect = [jl ? -ha : -ha + 0.5, -hb + 0.5, jr ? ha : ha - 0.5, hb - (L.end ? 0.5 : 3)];
  court(mb, ...yard);
  const pd = both ? (L.B >= 60 ? 16 : 12) : 10;
  let v0: number, v1: number;
  if (both) { const mid = L.end ? 0 : -1.5; v0 = mid - pd / 2; v1 = mid + pd / 2; }
  else { v0 = -hb + 2.5; v1 = v0 + pd; }
  const ofw = small ? 7 : 12; // 事務所の長さ
  // 事務所の端（連結したときは、つながっていない端。両方つながっていれば事務所なし）
  const oR = L.end ? 0 : S.next();
  const officeEnd = L.end ? 1 : jl && !jr ? 1 : jr && !jl ? -1 : oR < 0.5 ? 1 : -1;
  const office = !(jl && jr);
  const u0 = jl ? -ha : officeEnd < 0 ? -ha + 2 + ofw : -ha + 2.5, u1 = jr ? ha : officeEnd > 0 ? ha - 2 - ofw - (L.end ? 2 : 0) : ha - 2.5;
  const yr = 7.2 + (den >= 2 ? 0.4 : 0); // 屋根の下の高さ
  const c1 = 8, c0 = both ? 8 : 2; // 屋根の張り出し
  // 荷扱場の台（夜は床が光る）と、白いふち
  const skip = (jl ? 8 : 0) | (jr ? 4 : 0); // となりとくっつく端の面は描かない
  bx(mb, u0, 0, v0, u1, 1.0, v1, K.conc, 0, { roof: C(0x9a9890), rpat: PAT.lit, m: MAT.concrete, rm: MAT.concrete, skip });
  // 屋根：薄い板、白いふち（会社の色の線）、下の面は夜に光る
  const ra = u0 - 0.5 * eL, rb = u1 + 0.5 * eR;
  bx(mb, ra, yr, v0 - c0, rb, yr + 0.45, v1 + c1, K.white2, 0, { roof: K.roof, bot: K.under, bpat: PAT.lit, m: MAT.metal, skip });
  for (const [vv, d] of [[v1 + c1, 0], [v0 - c0, 2]] as [number, number][]) {
    bx(mb, u0 - 0.55 * eL, yr - 0.4, d === 0 ? vv - 0.25 : vv - 0.05, u1 + 0.55 * eR, yr + 0.9, d === 0 ? vv + 0.05 : vv + 0.25, K.white, 0, { roof: K.cap, m: MAT.metal, skip });
    wq(mb, d, d === 0 ? vv + 0.08 : vv - 0.08, ra, rb, yr + 0.15, yr + 0.45, accent, 0, MAT.none, 10);
    wq(mb, d, d === 0 ? vv + 0.08 : vv - 0.08, ra, rb, yr - 0.38, yr - 0.12, K.led, PAT.glow, MAT.none, 10);
  }
  // 上の倉庫（大きな敷地）：金属パネルの箱、横長の窓の帯、上のふちに会社の色の線。top = 屋根の高さ
  let top = yr + 0.45;
  const va = v0 - 0.6, vb = v1 + 0.6;
  if (big) {
    const ya = top, yb = ya + 8.5;
    bx(mb, u0, ya, va, u1, yb, vb, tint, PAT.industrial, { roof: K.roof, m: MAT.metal, rm: MAT.membrane, skip });
    rim(mb, u0, va, u1, vb, yb, 1.0, tint, 0.3, jl, jr);
    for (const d of [0, 2]) {
      const w = d === 0 ? vb + 0.03 : va - 0.03, s = d === 0 ? 1 : -1;
      wq(mb, d, w, u0 + eL, u1 - eR, ya + 4.2, ya + 5.2, K.glassDk, PAT.lit, MAT.none);
      wq(mb, d, w + s * 0.01, u0, u1, yb - 1.5, yb - 0.8, accent, 0, MAT.none);
    }
    if (!jr) wq(mb, 1, u1 + 0.03, va, vb, yb - 1.5, yb - 0.8, accent, 0, MAT.none);
    if (!jl) wq(mb, 3, u0 - 0.03, va, vb, yb - 1.5, yb - 0.8, accent, 0, MAT.none);
    // 荷物用のエレベーターの塔（屋根の上に出る）
    for (const t of [0.3, 0.7]) {
      const u = u0 + (u1 - u0) * t;
      bx(mb, u - 2.5, yb, v0 + 1, u + 2.5, yb + 3.2, v0 + 5, tint, 0, { roof: K.cap, m: MAT.metal });
    }
    top = yb;
  }
  // 屋根の下の地面（夜はダウンライトに照らされて明るい帯になる）
  gq(mb, ra, v1, rb, v1 + c1 - 0.3, 0.1, K.litGround, PAT.lit);
  if (both) gq(mb, ra, v0 - c0 + 0.3, rb, v0, 0.1, K.litGround, PAT.lit);
  // 柱（2 列）
  for (let u = u0 + 1; u <= u1 - 0.5; u += Math.max(10, (u1 - u0 - 2) / Math.round((u1 - u0) / 12))) for (const vv of [v0 + 0.8, v1 - 0.8]) bx(mb, u - 0.25, 1.0, vv - 0.25, u + 0.25, yr, vv + 0.25, K.steel, 0, { m: MAT.metal });
  // 台の上のかご台車の固まりと、フォークリフト
  for (let u = u0 + 2; u < u1 - 3; u += 5 + rng.next() * 4) {
    // 台の端（となりにつながる端も）からはみ出さないように
    const v = v0 + 2 + rng.next() * (pd - 6), len = Math.min(1.6 + rng.next() * 3, u1 - 0.5 - u);
    bx(mb, u, 1.0, v, u + len, 2.7, v + 1.6, K.cage, 0, { m: MAT.metal });
    if (rng.next() < 0.2 && u + len + 2.1 < u1 - 0.3) bx(mb, u + len + 1, 1.0, v, u + len + 2.1, 3.1, v + 1.0, K.yel, 0, { m: MAT.none });
  }
  // バース：両側（片側の時は +v だけ）
  const bays = (back: boolean) => {
    const draw = () => {
      const a = back ? -u1 : u0, b = back ? -u0 : u1, w = back ? -v0 : v1, cc = back ? c0 : c1;
      const room = back ? v0 - (-hb + 0.6) : (L.end ? hb - 0.6 : hb - 3.3) - v1;
      const xs = slots(a, b, 3.8, 0.3), on = pickSome(rng, xs.length, 0.72);
      for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        // 台のふちの車止めと、屋根のふちの番号の板（紺に白）
        wq(mb, 0, w + 0.03, x - 0.9, x - 0.5, 0.35, 0.85, K.yel, 0, MAT.none, 10);
        wq(mb, 0, w + 0.03, x + 0.5, x + 0.9, 0.35, 0.85, K.yel, 0, MAT.none, 10);
        wq(mb, 0, w + cc + 0.09, x - 0.5, x + 0.5, yr - 0.32, yr + 0.36, K.navy, 0, MAT.none, 10);
        wq(mb, 0, w + cc + 0.1, x - 0.22, x + 0.22, yr - 0.18, yr + 0.22, K.white, PAT.lit, MAT.none, 10);
        if (on[i]) {
          const k = fitKind(rng, room - 0.3, rng.next() < 0.28 ? ['wingOpen'] : ['wing']);
          if (k) truck(mb, x, w + 0.12, Math.PI / 2, k, rng.pick([accent, K.white, C(0x2e9e5b), C(0xd23a3a)]), rng.pick(CABS));
        }
      }
    };
    if (back) turn(mb, 2, draw);
    else draw();
  };
  bays(false);
  if (both) bays(true);
  else {
    // 片側の時、裏は低い壁
    bx(mb, u0, 1.0, v0, u1, 3.2, v0 + 0.3, K.white2, 0, { roof: K.cap, m: MAT.metal, skip });
  }
  // 事務所（3〜4 層、2×2 は 2 層。横長の窓の帯）
  if (office) {
    const fl = small ? 2 : big ? 4 + (den >= 2 ? 1 : 0) : 3 + (den >= 2 ? 1 : 0), oh = fl * 3.6 + 0.6;
    const oa = officeEnd > 0 ? u1 + 0.5 : u0 - ofw - 0.5 + 0.5, ob = oa + ofw - 0.5;
    const ov0 = both ? v0 - 2 : v0, ov1 = Math.min(v1 + 2, ov0 + 16);
    bx(mb, oa, 0, ov0, ob, oh, ov1, tint, PAT.ribbon, { roof: K.roof, m: MAT.none, rm: MAT.membrane });
    rim(mb, oa, ov0, ob, ov1, oh, 1.0, tint, 0.3);
    hvac(mb, oa + 2, ov0 + 2, oh, Math.min(4.0, ofw - 4.5), 2.2);
    if (!small) sign(mb, rng, oa + 1.5, ob - 1.5, oh - 2.0, oh - 0.6, ov1 + 0.02, accent);
  }
  // 屋根のふちの上の大きな看板（事務所のとなりから、正面の向き）
  // 大きな敷地は上の倉庫の正面に
  if (L.lead) {
    const sl = Math.min(22, (u1 - u0) * 0.6), sa = officeEnd > 0 ? u1 - 1 - sl : u0 + 1;
    if (big) sign(mb, rng, sa, sa + sl, top - 4.2, top - 1.9, vb, accent);
    else sign(mb, rng, sa, sa + sl, yr + 0.45, yr + 3.2, v1 + c1 - 0.8, accent);
  }
  // 屋根の上：4 割ほど（大きな敷地は 7 割）は長い太陽光パネル、ほかは天窓の列
  if (S.next() < (big ? 0.7 : 0.4)) solar(mb, u0 + 2, big ? v0 + 6 : v0 + 1, u1 - 2, v1 - 1, top);
  else for (let u = u0 + 4; u < u1 - 4; u += 8) skylight(mb, u, big ? v0 + 6 : v0 + 1.5, u + 1.6, v1 - 1.5, top);
  // 道路ぎわ・フェンス・照明
  const gaps: [number, number][] = L.end ? [[v1 + c1 + 1, hb - 1], ...(both ? [[-hb + 1, v0 - c0 - 1] as [number, number]] : [])] : [[officeEnd > 0 ? -ha + 3 : ha - 17, officeEnd > 0 ? -ha + 17 : ha - 3]];
  roadEdge(mb, rng, L, gaps);
  siteFence(mb, L);
  mast(mb, L.end ? ha - 4 : (gaps[0][0] + gaps[0][1]) / 2, L.end ? v1 + c1 + 0.5 : hb - 4, 14, yard);
  // 2 本目の照明塔（つながる端のすぐそばには置かない。となりの照明塔と並ばないように）
  const mu = officeEnd > 0 ? u0 + 2 : u1 - 2;
  if (!((jl && mu < -ha + 6) || (jr && mu > ha - 6))) mast(mb, mu, both ? -hb + 1.5 : hb - 4.5, 14, yard);
  // 大きな敷地：長い前庭の照明塔を増やす（裏の側）
  if (big && both) mast(mb, (u0 + u1) / 2, -hb + 1.5, 14, yard);
}

// 宅配の仕分けハブ：1 層の白いアルミの仕分け棟（横のルーバーの線）、角に 4 層のガラスの見学棟と、
// らせんのコンベヤが見えるガラスの円筒（夜は光る名物）。ひさしの下にブランドの色のバンがずらり、裏に幹線のトレーラー
function parcelHub(mb: MeshBuilder, rng: Rng, L: LF, den: number) {
  const ha = L.A / 2, hb = L.B / 2;
  const brand = rng.pick([C(0x8cc63f), C(0x1f6fd0), C(0xf28c28), C(0x2e9e5b), C(0x1d3f8a)]);
  const both = L.B >= 44;
  const h = 13 + (den >= 2 ? 1 : 0);
  mb.flatRoofMat = MAT.membrane;
  gq(mb, -ha + 0.2, -hb + 0.2, ha - 0.2, hb - 0.2, 0.07, K.apron);
  const E = L.end ? 15 : 0;
  const wingW = Math.min(16, L.A * 0.24);
  const u0 = -ha + 2, u1 = ha - 2 - E - (L.end ? 0 : wingW);
  let v0: number, v1: number;
  if (L.end) { v0 = both ? -9 : -hb + 2; v1 = both ? 9 : Math.min(v0 + 16, hb - 13); }
  else if (both) { const bd = L.B >= 60 ? 24 : 16; v1 = hb - 3 - (L.B >= 60 ? 18 : 15); v0 = v1 - bd; }
  else { v1 = hb - 3 - 13; v0 = -hb + 2; }
  const frontR: Rect = [-ha + 0.5, v1, ha - 0.5, L.end ? hb - 0.5 : hb - 3], backR: Rect = [-ha + 0.5, -hb + 0.5, ha - 0.5, v0];
  court(mb, ...frontR);
  if (both) court(mb, ...backR);
  finish(rng);
  // 仕分け棟（白いアルミ、横のルーバーの線）
  const wall = C(0xf2f3f4);
  bx(mb, u0, 0, v0, u1, h, v1, wall, 0, { roof: K.roof, m: MAT.metal, rm: MAT.membrane });
  rim(mb, u0, v0, u1, v1, h, 1.0, wall, 0.3);
  for (const y of [h - 1.2, h - 2.4, h - 3.6]) bx(mb, u0 - 0.2, y, v0 - 0.2, u1 + 0.2, y + 0.22, v1 + 0.2, C(0xd9dde1), 0, { m: MAT.metal });
  bx(mb, u0 - 0.05, 0, v0 - 0.05, u1 + 0.05, 1.0, v1 + 0.05, K.conc, 0, { roof: null, m: MAT.concrete });
  // 正面：台、細かいシャッター、ブランドの色のひさし、小さなバン
  {
    const ua = u0 + 1, ub = u1 - 1;
    bx(mb, ua, 0, v1, ub, 1.0, v1 + 2.6, K.conc, 0, { roof: K.apron, m: MAT.concrete });
    gq(mb, ua, v1 + 2.6, ub, v1 + 8, 0.1, K.litGround, PAT.lit);
    const xs = slots(ua, ub, 3.4, 0.2);
    doors(mb, xs, v1, 1.0, 2.8, 3.4, false, v1 + 2.6, 2);
    canopy(mb, ua - 0.5, ub + 0.5, v1, 8, 5.4, brand, 0);
    const room = (L.end ? hb - 0.5 : hb - 3.2) - (v1 + 2.7);
    const on = pickSome(rng, xs.length, 0.7);
    for (const [i, x] of xs.entries()) if (on[i]) truck(mb, x, v1 + 2.75, Math.PI / 2, rng.next() < 0.75 ? 'pvan' : 'small', rng.next() < 0.75 ? brand : K.white, K.white);
    // バンの待機場（前庭の道路側に、すき間なく並ぶ）
    if (room >= 14) {
      const vz = (L.end ? hb - 1 : hb - 3.4) - 5.2;
      for (let u = ua + 1; u + 2.2 < ub; u += 2.4) truck(mb, u + 1.1, vz, Math.PI / 2, 'pvan', brand, K.white);
    }
  }
  // 裏：幹線のトレーラー（米国式の搬入口）
  if (both) usDocks(mb, rng, u0 + 2, u1 - 2, v0, true, v0 + hb - 0.5, 0.55, 0);
  // ガラスの見学棟とガラスの円筒（横長：正面の角、縦長：道路側の端）
  {
    const fl = 4, gh = fl * 4.5;
    let ga: number, gb: number, gv0: number, gv1: number, dcx: number, dz: number[];
    // 見学棟は仕分け棟の端に並べる（重ねない。ルーバーの線と廊下の帯が同じ面にならないように）
    if (L.end) { ga = u1; gb = u1 + 9; gv0 = v0; gv1 = Math.min(v0 + 14, v1); dcx = u1 + 5; dz = [gv1 + 5]; }
    else { ga = u1; gb = u1 + wingW; gv0 = v1 - 14; gv1 = v1 + 1.5; dcx = u1 + wingW / 2; dz = [gv1 + 5.5, gv0 - 5.5]; }
    bx(mb, ga, 0, gv0, gb, gh - 0.35, gv1, K.glass, PAT.curtain, { roof: null, m: MAT.none });
    // 白い横のひれ（各階。いちばん上は屋根の板）と、見学の廊下の帯（明るいガラス）
    for (let k = 1; k <= fl; k++) bx(mb, k === fl ? ga - 0.05 : ga + 0.25, k * 4.5 - 0.35, gv0 - 0.4, gb + 0.4, k * 4.5, gv1 + 0.4, K.white, 0, { roof: k === fl ? K.roof : K.cap, m: MAT.metal, rm: k === fl ? MAT.membrane : MAT.metal });
    bx(mb, ga + 0.25, 9.4, gv0 - 0.2, gb + 0.2, 12.6, gv1 + 0.2, C(0xbfdcef), PAT.fullglass, { roof: null, m: MAT.none });
    sign(mb, rng, ga + 1, gb - 1, gh + 0.4, gh + 2.2, gv1 - 0.6, brand);
    // らせんのコンベヤの円筒
    const dcz = dz.find((z) => z - 4.6 > -hb + 0.8 && z + 4.6 < hb - (L.end ? 0.8 : 3.2));
    if (dcz !== undefined) spiralDrum(mb, dcx, dcz, 4.2, gh - 1, brand);
  }
  // 仕分け棟の正面の上の大きな看板（ルーバーの前）
  sign(mb, rng, u0 + 3, u0 + 3 + Math.min(24, (u1 - u0) * 0.55), h - 3.4, h - 0.4, v1 + 0.25, brand);
  // 屋上：奥の半分に太陽光、手前に天窓の帯と室外機
  {
    const vm = (v0 + v1) / 2;
    solar(mb, u0 + 2, v0 + 2, u1 - 4, vm, h);
    for (let u = u0 + 9; u + 1.6 < u1 - 4; u += 9) skylight(mb, u, vm + 1.5, u + 1.6, v1 - 2, h);
    hvac(mb, u0 + 3, v1 - 3, h, 4.0, 2.0);
  }
  // 道路ぎわ
  const gaps: [number, number][] = L.end ? [[v1 + 1, hb - 1], ...(both ? [[-hb + 1, v0 - 1] as [number, number]] : [])] : [[u0 + 2, u0 + 16]];
  roadEdge(mb, rng, L, gaps);
  siteFence(mb, L);
  mast(mb, u0 + 1.2, v1 + 9, 12, frontR);
  if (both) mast(mb, (u0 + u1) / 2, -hb + 1.5, 12, backR);
}
// らせんのコンベヤが見えるガラスの円筒（細い縦の枠、上と下の白い輪、中のらせんの帯は夜に光る）
function spiralDrum(mb: MeshBuilder, cx: number, cz: number, r: number, h: number, accent: THREE.Color) {
  const keep = mb.matOverride;
  mb.cylinder(cx, cz, 0, 1.2, r + 0.3, 20, K.white2, K.roof);
  mb.cylinder(cx, cz, h, h + 1.2, r + 0.3, 20, K.white, K.cap);
  mb.cylinder(cx, cz, 1.2, h, 0.7, 10, K.white2);
  // らせんの帯（上と下の面）と、外のふちの暗い鋼の帯（斜めに上がる線で、らせんの傾きが外から見える）
  const turns = Math.max(3, Math.round((h - 2) / 4)), seg = 16, P = (a: number, rr: number, y: number): P3 => [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
  const Nr = (a: number): P3 => [Math.cos(a), 0, Math.sin(a)];
  mb.matOverride = MAT.none;
  for (let i = 0; i < turns * seg; i++) {
    const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU, y0 = 1.6 + (i / (turns * seg)) * (h - 3), y1 = 1.6 + ((i + 1) / (turns * seg)) * (h - 3);
    mb.quad(P(a0, 0.9, y0), P(a1, 0.9, y1), P(a1, r - 0.8, y1), P(a0, r - 0.8, y0), K.conveyor, PAT.lit);
    mb.quad(P(a0, 0.9, y0 - 0.2), P(a0, r - 0.8, y0 - 0.2), P(a1, r - 0.8, y1 - 0.2), P(a1, 0.9, y1 - 0.2), accent);
    mb.quadN(P(a1, r - 0.8, y1 - 0.25), P(a0, r - 0.8, y0 - 0.25), P(a0, r - 0.8, y0 + 0.5), P(a1, r - 0.8, y1 + 0.5), Nr(a1), Nr(a0), Nr(a0), Nr(a1), K.steelDk);
  }
  // 縦の窓枠と、横の輪（中が見える）
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    vb(mb, vframe(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r, a), -0.12, 0.12, -0.09, 0.09, 1.2, h, K.white);
  }
  mb.matOverride = keep;
}

// アマゾン型のフルフィルメントセンター：明るい灰色の板、上に紺の帯、等間隔の付け柱、片面に長い搬入口の列
function fulfillment(mb: MeshBuilder, rng: Rng, L: LF, den: number) {
  tiltShed(mb, rng, L, den, true);
}

// 1×2 の小さな配送所：1 層の倉庫、搬入口 3、宅配のバン
function miniDepot(mb: MeshBuilder, rng: Rng, L: LF) {
  const ha = L.A / 2, hb = L.B / 2;
  const brand = rng.pick([C(0x8cc63f), C(0x1f6fd0), C(0xf28c28), C(0x2e9e5b)]);
  finish(rng);
  mb.flatRoofMat = MAT.membrane;
  gq(mb, -ha + 0.2, -hb + 0.2, ha - 0.2, hb - 0.2, 0.07, K.apron);
  court(mb, -ha + 0.5, 0, ha - 0.5, hb - (L.end ? 0.5 : 2.2));
  const u0 = -ha + 1.5, u1 = ha - (L.end ? 6.5 : 1.5), v0 = -hb + 1.2, v1 = -0.2, h = 7.5;
  bx(mb, u0, 0, v0, u1, h, v1, C(0xf2f3f4), 0, { roof: K.roof, m: MAT.metal, rm: MAT.membrane });
  rim(mb, u0, v0, u1, v1, h, 0.8, C(0xf2f3f4), 0.25);
  bx(mb, u0 - 0.06, h - 1.3, v0 - 0.06, u1 + 0.06, h - 0.8, v1 + 0.06, brand, 0, { m: MAT.none });
  const oa = u1 - 7;
  bx(mb, oa, 0, v1 - 2, u1 + (L.end ? 2.5 : 0.25), 6, v1 + 1.0, K.glass, PAT.curtain, { roof: K.cap, m: MAT.none });
  const xs = slots(u0 + 1, oa - 1, 3.6, 0.2);
  doors(mb, xs, v1, 0.6, 2.8, 3.0, false, null, 2);
  canopy(mb, u0 + 0.5, oa - 0.5, v1, 3.0, 4.4, brand, 0);
  for (let i = 0; i < xs.length; i++) if (rng.next() < 0.7) truck(mb, xs[i], v1 + 0.3, Math.PI / 2, 'pvan', brand, K.white);
  for (let u = u0 + 2; u < oa - 2; u += 6) skylight(mb, u, v0 + 2, u + 1.4, v0 + 4.6, h);
  hvac(mb, oa + 1, v0 + 1.5, h, 3.6, 2.0);
  if (L.end) {
    gq(mb, ha - 2.5, -hb + 0.3, ha - 0.3, -0.5, 0.1, K.lawn);
    L.tree(ha - 1.4, -hb + 2.5, 0.7);
  } else {
    gq(mb, -ha + 0.3, hb - 2.0, ha - 10, hb - 0.3, 0.1, K.lawn);
    for (let u = -ha + 2; u < ha - 11; u += 7) L.tree(u, hb - 1.1, 0.7);
  }
}

// ---------------- 登録 ----------------
// マルチテナント型：4×4 と、港のそばの 5×4・6×4（向きはどちらでも）はランプウェイ型（直線の折り返しランプ・らせん・
// ルーバーで包んだらせん）、それより小さい敷地と、細長い 5×3・6×3 はボックス型（3×4 も。高さに見合う長さがないので）、1×2 は小さな倉庫
function multiTenant(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const cells = Math.round((f.W * f.D) / 256);
  if (cells <= 2) return mtMini(mb, f, rng, tf);
  // 連結した敷地どうしは、同じ選び方の乱数で形をそろえる。つながる敷地はボックス型（となりと 1 つの長い箱になる）
  const S = f.campus !== undefined ? new Rng(f.campus) : rng;
  const r = S.next();
  if (f.joinL || f.joinR) return mtBox(mb, f, rng, tf, den, S);
  if (Math.min(f.W, f.D) >= 60) {
    // 港のそばの大きな敷地：らせんは長い辺が 96m の敷地だけ（80m の敷地は直線のランプ）
    const L = Math.max(f.W, f.D);
    if (L >= 80) return mtDeck(mb, f, rng, tf, den, L < 96 || r < 0.55 ? 'ramp' : r < 0.82 ? 'helix' : 'screen');
    return mtDeck(mb, f, rng, tf, den, r < 0.5 ? 'ramp' : r < 0.8 ? 'helix' : 'screen');
  }
  return mtBox(mb, f, rng, tf, den, S);
}
// 配送センター：1×2 は小さな配送所。2×2 はトラックターミナル（片側）か FC（片面）だけ。
// 短い辺が 44m 未満は FC（片面）・トラックターミナル（片側）・宅配ハブ、それ以上はクロスドック・トラックターミナル（両側）・宅配ハブ・FC。
// 港のそばの大きな敷地（長い辺が 80m 以上）は、長いクロスドック・トラックターミナル・FC が多く、宅配ハブは少ない
function distCenter(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const cells = Math.round((f.W * f.D) / 256);
  longFrame(mb, f, tf, (L) => {
    if (cells <= 2) return miniDepot(mb, rng, L);
    const r = (L.rs ?? rng).next();
    // 連結した敷地：となりとつなげられる形だけ（FC・クロスドック・トラックターミナル）
    if (L.jl || L.jr) {
      if (L.B < 44) return r < 0.5 ? fulfillment(mb, rng, L, den) : truckTerminal(mb, rng, L, den);
      return r < 0.35 ? tiltShed(mb, rng, L, den, false) : r < 0.7 ? truckTerminal(mb, rng, L, den) : fulfillment(mb, rng, L, den);
    }
    if (cells <= 4) return r < 0.6 ? truckTerminal(mb, rng, L, den) : fulfillment(mb, rng, L, den);
    if (L.A >= 80) {
      if (r < 0.32) return tiltShed(mb, rng, L, den, false);
      if (r < 0.64) return truckTerminal(mb, rng, L, den);
      if (r < 0.9) return fulfillment(mb, rng, L, den);
      return parcelHub(mb, rng, L, den);
    }
    if (L.B < 44) {
      if (r < 0.4) return fulfillment(mb, rng, L, den);
      if (r < 0.7) return truckTerminal(mb, rng, L, den);
      return parcelHub(mb, rng, L, den);
    }
    if (r < 0.3) return tiltShed(mb, rng, L, den, false);
    if (r < 0.55) return truckTerminal(mb, rng, L, den);
    if (r < 0.8) return parcelHub(mb, rng, L, den);
    return fulfillment(mb, rng, L, den);
  });
}

// 形を作り終えたら、ためた光だまりを描く
function withPools(fn: LogiFn): LogiFn {
  return (mb, f, rng, tf, den) => {
    poolQ.length = 0;
    try {
      fn(mb, f, rng, tf, den);
      poolFlush(mb);
    } finally {
      poolQ.length = 0;
    }
  };
}
LOGI.multiTenant = withPools(multiTenant);
LOGI.distCenter = withPools(distCenter);
