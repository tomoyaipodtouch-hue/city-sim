// 池のある庭園（2×3）：京都のお寺の庭（苔寺や天龍寺の曹源池のような、苔と石組の池泉庭園）。
// ・庭一面の苔と、ゆるやかな築山。池は地面より低く、岸は自然な曲線（石組の護岸と、小石を敷いた州浜）
// ・中島に雲のように刈り込んだ黒松、石の橋、石組から落ちる小さな滝と滝つぼの波紋
// ・睡蓮と杜若、石灯籠（雪見・春日・岬）、四阿（あずまや）と行灯、飛び石と延段
// ・まわりは瓦をのせた土塀と門。夜は灯籠と行灯がともり、木と滝を下から照らす
// 座標は敷地の座標（x = 幅、z = 奥行き、+z が道路に面した正面）。
import * as THREE from 'three';
import { MeshBuilder, PAT } from './builder';
import { MAT } from './textures';
import type { Rng } from '../sim/rng';
import { LAKE_T, type PondBuilder } from './parkPond';
import type { LotFrame, TF } from './buildingGen';

type V3 = [number, number, number];
type V2 = [number, number];
const C = (h: number) => new THREE.Color(h);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// なめらかな最大・最小（池の形をつなぐ）
const smax = (a: number, b: number, k: number) => {
  const h = clamp01(0.5 + (0.5 * (a - b)) / k);
  return b + (a - b) * h + k * h * (1 - h);
};
const smin = (a: number, b: number, k: number) => -smax(-a, -b, k);

const K = {
  moss: [C(0x33501f), C(0x3f5e24), C(0x4d6c28)],
  mossSun: C(0x5e7c2c),
  earth: C(0x5a503f),
  earthWet: C(0x3b372c),
  pebble: C(0x8f8a7f),
  gravel: C(0x8a857b),
  rock: [C(0x76776f), C(0x837d70), C(0x666d68), C(0x8c8579), C(0x6e6b64)],
  rockWet: C(0x4b4e4a),
  granite: C(0x9d998f),
  graniteDark: C(0x86827a),
  plaster: C(0xd9caa5),
  wallBase: C(0x8c867b),
  tile: C(0x4a4e54),
  wood: C(0x58402f),
  woodLight: C(0x7d6046),
  bark: C(0x5a4131), // 檜皮葺
  pineBark: C(0x4e433a),
  pine: [C(0x2b4525), C(0x324f2a), C(0x2a4123)],
  shrub: [C(0x33502a), C(0x3a582d), C(0x2f4a27)],
  pad: [C(0x3b5a28), C(0x45652c), C(0x506d2e)],
  lilyW: C(0xf2efe5),
  lilyP: C(0xe2a0b5),
  iris: C(0x4b7733),
  irisF: C(0x4a3a8f),
  open: C(0x2a2622),
  paper: C(0xeee5cf),
  fixture: C(0x2b2b29),
  bronze: C(0x4b4537),
  step: [C(0x908c84), C(0x9a958b), C(0x86837c)],
};
// 青もみじ（明るい黄緑）
const MAPLE = [0x6c9c33, 0x77a43a, 0x649530];

export function kyotoGarden(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, pond?: PondBuilder) {
  const w = f.W / 2, d = f.D / 2, m = Math.min(w, d);
  const YG = 0.5; // 庭の地面の高さ（まわりの土塀の中を少し高くする）
  const YW = 0.12; // 池の水面の高さ
  const keepMat = mb.matOverride;
  mb.slopeRoofMat = MAT.shingle;
  const R = () => rng.next();
  const jit = (s: number) => (R() - 0.5) * 2 * s;
  const W = (x: number, y: number, z: number) => mb.world(x, y, z);

  // ---------------- 池の形（符号つきの距離。正 = 水の中、m） ----------------
  const bl = (u: number, v: number, ru: number, rv: number) => ({ x: (u + jit(0.03)) * w, z: (v + jit(0.03)) * d, rx: ru * w, rz: rv * d });
  const PA = bl(-0.26, -0.1, 0.44, 0.36), PB = bl(0.26, -0.24, 0.34, 0.3), PC = bl(0.14, -0.5, 0.17, 0.21), PE = bl(0.5, 0.1, 0.2, 0.2);
  const ell = (x: number, z: number, e: { x: number; z: number; rx: number; rz: number }) => (1 - Math.hypot((x - e.x) / e.rx, (z - e.z) / e.rz)) * Math.min(e.rx, e.rz);
  const isl = { x: PA.x + 0.03 * w, z: PA.z - 0.04 * d, r: 0.17 * m };
  const cape = { x: -0.66 * w, z: 0.05 * d, r: 0.16 * m };
  const wb1 = R() * 6.28, wb2 = R() * 6.28, wb3 = R() * 6.28;
  const sdPond = (x: number, z: number) => {
    let s = smax(smax(ell(x, z, PA), ell(x, z, PB), 2.2), smax(ell(x, z, PC), ell(x, z, PE), 2.2), 2.2);
    // 岸のゆらぎ（入り江と岬）
    s += 0.28 * Math.sin(x * 0.83 + wb1) * Math.sin(z * 0.71 + wb2) + 0.16 * Math.sin(x * 1.9 - z * 1.4 + wb2);
    // 中島と州浜の岬（陸地）
    const ia = Math.atan2(z - isl.z, x - isl.x);
    s = smin(s, Math.hypot(x - isl.x, z - isl.z) - isl.r * (1 + 0.12 * Math.sin(ia * 3 + wb3)), 1.0);
    s = smin(s, Math.hypot(x - cape.x, z - cape.z) - cape.r, 1.6);
    // 土塀と正面の延段からは離す
    s = smin(s, w - 3.2 - Math.abs(x), 1.5);
    s = smin(s, d - 3.6 - Math.abs(z), 1.5);
    return s;
  };
  const grad = (x: number, z: number): V2 => {
    const e = 0.25;
    const gx = sdPond(x + e, z) - sdPond(x - e, z), gz = sdPond(x, z + e) - sdPond(x, z - e);
    const l = Math.hypot(gx, gz) || 1;
    return [gx / l, gz / l];
  };

  // ---------------- 滝の位置（奥の入り江の突き当たり） ----------------
  let fz = PC.z;
  while (sdPond(PC.x, fz) > 0 && fz > -d + 2) fz -= 0.05;
  const Fb: V2 = [PC.x, fz]; // 水ぎわ
  const gF = grad(Fb[0], Fb[1]);
  const out: V2 = [-gF[0], -gF[1]]; // 陸の方へ
  const side: V2 = [-out[1], out[0]];
  const FH = 1.55; // 滝の高さ
  const yTop = YW + FH;
  const Lp: V2 = [Fb[0] + out[0] * 0.3, Fb[1] + out[1] * 0.3]; // 落ち口
  // a = 陸の方への距離（負なら池の方）、o = 横
  const FP = (a: number, o: number): V2 => [Lp[0] + out[0] * a + side[0] * o, Lp[1] + out[1] * a + side[1] * o];

  // ---------------- 地面の高さ（築山と、池へ下る岸） ----------------
  const Mc = FP(2.0, 0);
  const mounds: [number, number, number, number][] = [
    // 滝の後ろの築山（落ち口のうしろが滝の高さより少し高くなるように）
    [Mc[0], Mc[1], 2.7, (yTop + 0.12 - YG) / Math.exp(-(1.5 * 1.5) / (2.7 * 2.7))],
    [-0.68 * w, -0.74 * d, 0.32 * m + 1.5, 0.75],
    [0.74 * w, -0.72 * d, 0.28 * m + 1.2, 0.5],
    [-0.62 * w, 0.72 * d, 0.25 * m + 1, 0.32],
    [isl.x, isl.z, isl.r * 0.9, 0.32],
  ];
  const hBase = (x: number, z: number) => {
    let h = YG;
    for (const [mx, mz, r, hh] of mounds) h += hh * Math.exp(-((x - mx) ** 2 + (z - mz) ** 2) / (r * r));
    return h;
  };
  const beachW = (x: number, z: number) => smooth(5.2, 2.4, Math.hypot(x - cape.x, z - cape.z));
  const fallW = (x: number, z: number) => smooth(2.6, 0.9, Math.hypot(x - Fb[0], z - Fb[1]));
  const bankW = (x: number, z: number) => {
    const b = beachW(x, z), fw = fallW(x, z);
    return (1.1 + 1.9 * b) * (1 - fw) + 0.35 * fw;
  };
  const ground = (x: number, z: number) => {
    const s = sdPond(x, z);
    if (s >= 0) return YW - 0.04 - Math.min(0.35, s * 0.3);
    const b = beachW(x, z);
    const u = clamp01(-s / bankW(x, z));
    // ふつうの岸は水ぎわが少し急、州浜はなだらか
    const t = u * (2 - u) * (1 - b) + u * b;
    return YW - 0.04 + (hBase(x, z) - YW + 0.04) * t;
  };

  // ---------------- 正面の門と延段、四阿の位置 ----------------
  let pathEnd = d - 6.5;
  while (sdPond(0, pathEnd) > -1.2 && pathEnd < d - 3) pathEnd += 0.25;
  const G2: V2 = [0, pathEnd];
  // 四阿：右手前（池のそば、池からは少し離す）
  let pav: V2 = [0.5 * w, 0.5 * d], best = Infinity;
  for (const sgn of [1, -1]) {
    for (let z = 0.05 * d; z < d - 3.6; z += 0.5)
      for (let x = 3.4; x < w - 3.4; x += 0.5) {
        const px = x * sgn;
        const s = Math.max(sdPond(px, z), sdPond(px + 2, z + 2), sdPond(px - 2, z + 2), sdPond(px + 2, z - 2), sdPond(px - 2, z - 2));
        if (s > -1.0) continue;
        const sc = Math.abs(-sdPond(px, z) - 3.9) + 0.12 * Math.abs(z - 0.45 * d) + (sgn < 0 ? 4 : 0);
        if (sc < best) { best = sc; pav = [px, z]; }
      }
    if (best < 3) break;
  }

  // 置いたものの場所（木や石が重ならないように）
  const used: [number, number, number][] = [];
  const free = (x: number, z: number, r: number) => used.every(([ux, uz, ur]) => Math.hypot(x - ux, z - uz) > r + ur);
  const occupy = (x: number, z: number, r: number) => used.push([x, z, r]);
  occupy(pav[0], pav[1], 2.6);
  occupy(Fb[0] + out[0] * 0.6, Fb[1] + out[1] * 0.6, 1.8);

  // ---------------- 地面（苔・土・小石）：格子の面 ----------------
  {
    const S = 0.8;
    const x0 = -w + 0.45, z0 = -d + 0.45, x1 = w - 0.45, z1 = d - 0.45;
    const nx = Math.round((x1 - x0) / S), nz = Math.round((z1 - z0) / S);
    const sx = (x1 - x0) / nx, sz = (z1 - z0) / nz;
    const nv = (nx + 1) * (nz + 1);
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), Cl = new Float32Array(nv * 3), U = new Float32Array(nv * 2);
    const SD = new Float32Array(nv);
    const col = new THREE.Color(), tmp = new THREE.Color();
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= nx; i++) {
        const k = j * (nx + 1) + i;
        const x = x0 + i * sx, z = z0 + j * sz;
        const s = sdPond(x, z);
        SD[k] = s;
        const h = ground(x, z);
        P[k * 3] = x; P[k * 3 + 1] = h; P[k * 3 + 2] = z;
        const e = 0.4;
        const gx = (ground(x + e, z) - ground(x - e, z)) / (2 * e), gz = (ground(x, z + e) - ground(x, z - e)) / (2 * e);
        const l = Math.hypot(gx, 1, gz);
        N[k * 3] = -gx / l; N[k * 3 + 1] = 1 / l; N[k * 3 + 2] = -gz / l;
        // 色：苔（場所ごとに少しずつ違う）、水ぎわの土、州浜と門の前の小石
        // 苔の種類のむら（大きなまだらと、小さなまだら）。築山の上は日当たりがよく明るい
        const n = 0.5 + 0.5 * Math.sin(x * 0.31 + z * 0.17 + wb1) * Math.sin(z * 0.23 - x * 0.13 + wb2);
        const n2 = 0.5 + 0.5 * Math.sin(x * 0.83 - z * 0.61 + wb3) * Math.sin(z * 0.97 + x * 0.41 + wb1);
        col.copy(K.moss[0]).lerp(K.moss[1], clamp01(n * 2)).lerp(K.moss[2], clamp01(n * 2 - 1));
        col.lerp(K.mossSun, Math.max(clamp01((hBase(x, z) - YG - 0.25) * 0.8) * 0.6, smooth(0.62, 0.9, n2) * 0.55));
        col.multiplyScalar(0.9 + 0.2 * n2);
        const gate = smooth(1.5, 1.2, Math.abs(x)) * smooth(pathEnd - 0.9, pathEnd - 0.4, z);
        const peb = Math.max(beachW(x, z) * (1 - smooth(1.0, 2.0, -s)), gate);
        const near = smooth(0.3, 0.05, -s);
        const moss = (1 - near) * (1 - peb);
        tmp.copy(K.earth).lerp(K.earthWet, smooth(-0.35, -0.02, s));
        tmp.lerp(col, moss);
        tmp.lerp(gate > 0.5 ? K.gravel : K.pebble, peb);
        Cl[k * 3] = tmp.r; Cl[k * 3 + 1] = tmp.g; Cl[k * 3 + 2] = tmp.b;
        U[k * 2] = moss; U[k * 2 + 1] = peb;
      }
    // 深い水の下は描かない（水面がおおう）
    const keep = (i: number, j: number) => {
      const k = j * (nx + 1) + i;
      return Math.min(SD[k], SD[k + 1], SD[k + nx + 1], SD[k + nx + 2]) < 0.6;
    };
    mb.gridSurface(nx, nz, P, N, Cl, U, PAT.gardenGround, MAT.none, keep);
  }

  // ---------------- 池の水面 ----------------
  // 水面の端（シェーダーの岸辺の帯）は、土手の地面の下にかくれるよう少し陸の方へ広げる
  pond?.addLocal(-w + 1, -d + 1, w - 1, d - 1, YW, (x, z) => LAKE_T + 0.012 + sdPond(x, z) * 0.1, W, 0.9);

  // ---------------- 形を作る道具 ----------------
  // 外向きに面を張る（中心 c から見て裏返っていたら順番を逆にする）
  const quadOut = (a: V3, b: V3, c: V3, dd: V3, col: THREE.Color, ctr: V3, pat: number = PAT.garden) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [dd[0] - a[0], dd[1] - a[1], dd[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const mx = (a[0] + b[0] + c[0] + dd[0]) / 4 - ctr[0], my = (a[1] + b[1] + c[1] + dd[1]) / 4 - ctr[1], mz = (a[2] + b[2] + c[2] + dd[2]) / 4 - ctr[2];
    if (n[0] * mx + n[1] * my + n[2] * mz >= 0) mb.quad(a, b, c, dd, col, pat);
    else mb.quad(dd, c, b, a, col, pat);
  };
  // 多角形のふた（下向き）
  const capDown = (poly: V2[], y: number, col: THREE.Color) => {
    let cx = 0, cz = 0;
    for (const [x, z] of poly) { cx += x / poly.length; cz += z / poly.length; }
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      const t: [V3, V3, V3] = [[cx, y, cz], [a[0], y, a[1]], [b[0], y, b[1]]];
      // 下向きになる順番
      const e1 = [t[1][0] - t[0][0], t[1][2] - t[0][2]], e2 = [t[2][0] - t[0][0], t[2][2] - t[0][2]];
      const ny = e1[1] * e2[0] - e1[0] * e2[1];
      if (ny < 0) mb.tri(t[0], t[1], t[2], col, PAT.garden);
      else mb.tri(t[0], t[2], t[1], col, PAT.garden);
    }
  };
  const ngon = (cx: number, cz: number, r: number, n: number, rot = 0, asp = 1): V2[] =>
    Array.from({ length: n }, (_, k) => {
      const a = rot + (k / n) * Math.PI * 2;
      return [cx + Math.cos(a) * r, cz + Math.sin(a) * r * asp] as V2;
    });
  // 自然の石：角ばった塊。輪ごとに半径と高さを少しずつ変え、平らな面で描く（底は地面に埋める）
  const rock = (cx: number, cz: number, y0: number, r: number, h: number, col: THREE.Color, ang = R() * 6.28, asp = 0.7 + R() * 0.45, seg = 7) => {
    mb.matOverride = MAT.concrete;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rings: [number, number][] = [[-0.3, 0.9], [0.0, 1.0], [0.42, 1.04 + jit(0.06)], [0.8, 0.74 + jit(0.08)], [1.0, 0.3 + R() * 0.15]];
    const jr = Array.from({ length: seg }, () => 0.8 + R() * 0.34);
    const ja = Array.from({ length: seg }, () => jit(0.22));
    const tilt = [jit(0.12), jit(0.12)];
    const pts: V3[][] = rings.map(([hf, rf], ri) =>
      Array.from({ length: seg }, (_, k) => {
        const a = ((k + ja[k]) / seg) * Math.PI * 2;
        const rr = r * rf * (ri === rings.length - 1 ? 0.8 + R() * 0.4 : jr[k]);
        const ex = Math.cos(a) * rr, ez = Math.sin(a) * rr * asp;
        const y = y0 + h * hf + (ri >= 3 ? jit(0.07) * h : 0) + (ex * tilt[0] + ez * tilt[1]) * (hf > 0 ? hf : 0);
        return [cx + ex * ca - ez * sa, y, cz + ex * sa + ez * ca] as V3;
      }),
    );
    for (let ri = 0; ri < rings.length - 1; ri++)
      for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg;
        mb.quad(pts[ri][k1], pts[ri][k], pts[ri + 1][k], pts[ri + 1][k1], col, PAT.garden);
      }
    const top = pts[rings.length - 1];
    let tx = 0, ty = 0, tz = 0;
    for (const p of top) { tx += p[0] / seg; ty += p[1] / seg; tz += p[2] / seg; }
    for (let k = 0; k < seg; k++) mb.tri([tx, ty + h * 0.04, tz], top[(k + 1) % seg], top[k], col, PAT.garden);
    mb.matOverride = null;
  };
  // こんもりした葉の房（刈り込みや松の枝先）。底は平ら
  const blob = (cx: number, cz: number, y: number, r: number, h: number, col: THREE.Color, seg = 10, rings = 4) => {
    mb.matOverride = MAT.none;
    const jr = Array.from({ length: seg }, () => 0.86 + R() * 0.24);
    const P = (k: number, t: number): V3 => {
      const a = (k / seg) * Math.PI * 2;
      const rr = Math.cos(t) * r * jr[k % seg];
      return [cx + Math.cos(a) * rr, y + Math.sin(t) * h, cz + Math.sin(a) * rr];
    };
    const Nn = (k: number, t: number): V3 => {
      const a = (k / seg) * Math.PI * 2;
      const nx = (Math.cos(t) / r) * Math.cos(a), ny = Math.sin(t) / h, nz = (Math.cos(t) / r) * Math.sin(a);
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    };
    for (let q = 0; q < rings; q++) {
      const t0 = (q / rings) * Math.PI / 2, t1 = ((q + 1) / rings) * Math.PI / 2;
      for (let k = 0; k < seg; k++) mb.quadN(P(k + 1, t0), P(k, t0), P(k, t1), P(k + 1, t1), Nn(k + 1, t0), Nn(k, t0), Nn(k, t1), Nn(k + 1, t1), col, PAT.gardenLeaf);
    }
    const ring: V2[] = Array.from({ length: seg }, (_, k) => { const p = P(k, 0); return [p[0], p[2]]; });
    capDown(ring, y, col.clone().multiplyScalar(0.7));
    mb.matOverride = null;
  };
  // 傾いた角柱（a から b へ。断面は n 角形、半径 r0 → r1）
  const strut = (a: V3, b: V3, r0: number, r1: number, col: THREE.Color, n = 6, pat: number = PAT.garden) => {
    if (b[1] < a[1]) [a, b] = [b, a];
    mb.prism(ngon(a[0], a[2], r0, n), a[1], b[1], col, pat, null, ngon(b[0], b[2], r1, n));
  };
  const gAt = (p: V2) => ground(p[0], p[1]);

  // ---------------- 土塀と門 ----------------
  {
    mb.matOverride = null;
    const t0 = 0.25, t1 = 0.7, yb = 0.35, yp = 1.72;
    const capX = (x0: number, x1: number, zc: number) => mb.gableX(x0, zc - 0.23, x1, zc + 0.23, yp, 0.2, K.tile, K.plaster, 0.16);
    const capZ = (z0: number, z1: number, xc: number) => {
      const x0 = xc - 0.23, x1 = xc + 0.23, ov = 0.16, rise = 0.2, y = yp;
      const xm = xc, oz0 = z0 - ov, oz1 = z1 + ov, ox0 = x0 - ov, ox1 = x1 + ov, yt = y + rise, drop = (rise * ov) / ((x1 - x0) / 2);
      mb.quad([ox1, y - drop, oz1], [ox1, y - drop, oz0], [xm, yt, oz0], [xm, yt, oz1], K.tile);
      mb.quad([ox0, y - drop, oz0], [ox0, y - drop, oz1], [xm, yt, oz1], [xm, yt, oz0], K.tile);
      mb.tri([x0, y, z0], [xm, yt, z0], [x1, y, z0], K.plaster);
      mb.tri([x1, y, z1], [xm, yt, z1], [x0, y, z1], K.plaster);
    };
    const wallX = (x0: number, x1: number, za: number, zb: number) => {
      mb.box(x0, 0, za - 0.03, x1, yb, zb + 0.03, K.wallBase);
      mb.box(x0, yb, za, x1, yp, zb, K.plaster);
      capX(x0, x1, (za + zb) / 2);
    };
    const wallZ = (z0: number, z1: number, xa: number, xb: number) => {
      mb.box(xa - 0.03, 0, z0, xb + 0.03, yb, z1, K.wallBase);
      mb.box(xa, yb, z0, xb, yp, z1, K.plaster);
      capZ(z0, z1, (xa + xb) / 2);
    };
    const gw = 1.6;
    wallX(-w + t0, -gw, d - t1, d - t0);
    wallX(gw, w - t0, d - t1, d - t0);
    wallX(-w + t0, w - t0, -d + t0, -d + t1);
    wallZ(-d + t1, d - t1, -w + t0, -w + t1);
    wallZ(-d + t1, d - t1, w - t1, w - t0);
    // 門（薬医門のような形）：本柱・控柱・冠木と、瓦の切妻屋根
    const zc = d - 0.47;
    for (const sx of [-1, 1]) {
      mb.box(sx * 1.45 - 0.15, 0, zc - 0.15, sx * 1.45 + 0.15, 2.55, zc + 0.15, K.wood);
      mb.box(sx * 1.45 - 0.1, YG, zc - 1.55, sx * 1.45 + 0.1, 2.2, zc - 1.35, K.wood);
      mb.box(sx * 1.45 - 0.08, 2.08, zc - 1.5, sx * 1.45 + 0.08, 2.24, zc + 0.1, K.wood);
    }
    mb.box(-1.8, 2.25, zc - 0.13, 1.8, 2.45, zc + 0.13, K.wood);
    mb.gableX(-1.95, zc - 1.75, 1.95, zc + 0.35, 2.45, 0.62, K.tile, K.wood, 0.4);
    // 敷居の石段（外の歩道から庭の高さへ）
    mb.matOverride = MAT.concrete;
    mb.box(-gw, 0, d - 0.78, gw, YG + 0.03, d - 0.16, K.granite);
    mb.box(-gw + 0.1, 0, d - 0.16, gw - 0.1, 0.26, d - 0.02, K.granite);
    mb.matOverride = null;
  }

  // ---------------- 延段（門から続く石畳） ----------------
  {
    mb.matOverride = MAT.concrete;
    let z = d - 0.85;
    while (z > pathEnd + 0.3) {
      const len = 0.38 + R() * 0.3;
      const zb = Math.max(pathEnd, z - len);
      let x = -0.7;
      while (x < 0.69) {
        const wd = Math.min(0.7 - x, 0.32 + R() * 0.55);
        const col = K.step[Math.floor(R() * 3)];
        mb.box(x + 0.03, YG - 0.06, zb + 0.03, x + wd - 0.03, YG + 0.06, z - 0.03, col, PAT.garden);
        x += wd;
      }
      z = zb;
    }
    mb.matOverride = null;
    occupy(0, (d + pathEnd) / 2, 1.2);
  }

  // ---------------- 中島への石橋 ----------------
  let bridgeShore: V2 | null = null;
  let bridgeIsl: V2 | null = null;
  {
    let bestB: { dir: V2; a: V2; b: V2; gap: number } | null = null, bs = Infinity;
    for (let k = 0; k < 32; k++) {
      const ang = (k / 32) * Math.PI * 2;
      const dir: V2 = [Math.cos(ang), Math.sin(ang)];
      let t = 0;
      while (t < isl.r * 1.6 && sdPond(isl.x + dir[0] * t, isl.z + dir[1] * t) < 0) t += 0.05;
      const ta = t;
      while (t < ta + 9 && sdPond(isl.x + dir[0] * t, isl.z + dir[1] * t) >= 0) t += 0.05;
      const gap = t - ta;
      if (t >= ta + 9 || gap < 1.6) continue;
      const a: V2 = [isl.x + dir[0] * ta, isl.z + dir[1] * ta], b: V2 = [isl.x + dir[0] * t, isl.z + dir[1] * t];
      // 岸の先が築山や州浜、滝のそばでないところ。正面（門の方）に近い向きをえらぶ
      if (beachW(b[0], b[1]) > 0.3 || fallW(b[0], b[1]) > 0.1 || Math.abs(b[0]) > w - 3 || Math.abs(b[1]) > d - 3) continue;
      const sc = gap - 1.3 * dir[1];
      if (sc < bs) { bs = sc; bestB = { dir, a, b, gap }; }
    }
    if (bestB) {
      const { dir, a, b, gap } = bestB;
      const pA: V2 = [a[0] - dir[0] * 0.55, a[1] - dir[1] * 0.55], pB: V2 = [b[0] + dir[0] * 0.55, b[1] + dir[1] * 0.55];
      bridgeShore = pB;
      bridgeIsl = pA;
      const top = Math.max(gAt(pA), gAt(pB), YW + 0.38) + 0.05;
      const perp: V2 = [-dir[1], dir[0]];
      const slab = (p0: V2, p1: V2, off: number) => {
        const hw = 0.42;
        const c = (p: V2, o: number): V2 => [p[0] + perp[0] * (o + off), p[1] + perp[1] * (o + off)];
        const poly: V2[] = [c(p0, -hw), c(p1, -hw), c(p1, hw), c(p0, hw)];
        mb.matOverride = MAT.concrete;
        mb.prism(poly, top - 0.26, top, K.granite, PAT.garden, K.granite);
        mb.matOverride = null;
      };
      if (gap < 4.4) slab(pA, pB, 0);
      else {
        // 長いときは2枚の石を少しずらしてつなぐ（まん中は池の中の石で支える）
        const mid: V2 = [(pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2];
        slab(pB, [mid[0] - dir[0] * 0.2, mid[1] - dir[1] * 0.2], 0.22);
        slab(pA, [mid[0] + dir[0] * 0.2, mid[1] + dir[1] * 0.2], -0.22);
        rock(mid[0], mid[1], YW - 0.4, 0.75, top - 0.26 - YW + 0.42, K.rockWet, Math.atan2(dir[1], dir[0]) + 1.57, 0.8);
      }
      // 橋のたもとの石（橋挟み石）
      for (const [p, sgn] of [[pA, -1], [pB, 1]] as [V2, number][])
        for (const o of [-0.75, 0.75]) {
          const q: V2 = [p[0] + perp[0] * o + dir[0] * 0.25 * sgn, p[1] + perp[1] * o + dir[1] * 0.25 * sgn];
          rock(q[0], q[1], gAt(q) - 0.1, 0.32 + R() * 0.12, 0.42 + R() * 0.2, K.rock[Math.floor(R() * 5)]);
        }
      occupy((pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2, gap / 2 + 0.6);
      occupy(pB[0], pB[1], 1.0);
    }
  }

  // ---------------- 滝石組と滝 ----------------
  {
    const ang = Math.atan2(side[1], side[0]);
    const g = (p: V2) => gAt(p);
    // 鏡石（水の後ろの大きな石。濡れて暗い）と、落ち口の石
    const mir = FP(0.6, 0);
    rock(mir[0], mir[1], YW - 0.35, 1.05, yTop - YW + 0.45, K.rockWet, ang, 0.6);
    const lip = FP(0.5, 0);
    rock(lip[0], lip[1], yTop - 0.2, 0.62, 0.24, K.rock[2], ang, 0.85);
    // 両脇の石（脇石）
    // [陸の方への距離, 横, 半径, 頂の高さ]
    for (const [a, o, r, hh] of [
      [0.2, -1.4, 0.75, yTop + 0.6], [0.28, 1.4, 0.68, yTop + 0.3], [0.95, -1.75, 0.62, yTop + 0.7], [1.0, 1.8, 0.55, yTop + 0.5],
      [-0.55, -1.8, 0.5, YW + 0.55], [-0.4, 1.85, 0.46, YW + 0.48], [1.6, -0.5, 0.9, yTop + 0.95], [1.4, 1.0, 0.7, yTop + 0.55],
    ] as [number, number, number, number][]) {
      const p = FP(a, o);
      const y0 = Math.min(g(p), YW) - 0.3;
      rock(p[0], p[1], y0, r, hh - y0, K.rock[Math.floor(R() * 5)], ang + jit(0.5));
      occupy(p[0], p[1], r);
    }
    // 水分石（滝つぼの中の低い石）
    const ws = FP(-1.45, 0.35);
    rock(ws[0], ws[1], YW - 0.3, 0.36, 0.42, K.rockWet);
    if (pond) {
      // 水の帯（落ち口から滝つぼへ）
      const pts: V3[] = [];
      const wid: number[] = [];
      const NS = 9;
      for (let k = 0; k < NS; k++) {
        const s = k / (NS - 1);
        const p = FP(0.06 - 0.5 * Math.sqrt(s), 0);
        pts.push(W(p[0], yTop + 0.03 - (yTop + 0.03 - YW) * s, p[1]));
        wid.push(1.05 + 0.3 * s);
      }
      const w0 = W(0, 0, 0), w1 = W(side[0], 0, side[1]);
      pond.fallSheet(pts, [w1[0] - w0[0], w1[2] - w0[2]], wid);
      const fo = FP(-0.75, 0);
      const fw = W(fo[0], YW + 0.015, fo[1]);
      pond.foam(fw[0], fw[1], fw[2], 1.3);
      const fr = W(fo[0], YW, fo[1]);
      pond.falls.push(fr[0], fr[1], fr[2], 1);
      // 滝のライトアップ（滝つぼの手前の水の中から）
      const ul = FP(-1.35, -0.25);
      const lw = W(ul[0], YW + 0.1, ul[1]);
      pond.addLight(lw[0], lw[1], lw[2], -6.5, 3.2, 3.1, 2.9);
    }
  }

  // ---------------- 岸の石組（護岸） ----------------
  {
    const cand: V2[] = [];
    for (let z = -d + 2; z < d - 2; z += 0.45)
      for (let x = -w + 2; x < w - 2; x += 0.45) {
        const s = sdPond(x, z);
        if (Math.abs(s) < 0.12) cand.push([x + jit(0.15), z + jit(0.15)]);
      }
    // ばらばらの順に見て、間をあけて置く
    for (let k = cand.length - 1; k > 0; k--) {
      const j = Math.floor(R() * (k + 1));
      [cand[k], cand[j]] = [cand[j], cand[k]];
    }
    const placed: V2[] = [];
    for (const p of cand) {
      if (beachW(p[0], p[1]) > 0.35 || fallW(p[0], p[1]) > 0.25) continue;
      if (placed.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.55)) continue;
      if ((bridgeShore && Math.hypot(p[0] - bridgeShore[0], p[1] - bridgeShore[1]) < 1.3) || (bridgeIsl && Math.hypot(p[0] - bridgeIsl[0], p[1] - bridgeIsl[1]) < 1.3)) continue;
      placed.push(p);
      if (R() < 0.3) continue; // ところどころは苔が水ぎわまで来る
      const big = R() < 0.25;
      const r = big ? 0.6 + R() * 0.25 : 0.32 + R() * 0.25;
      const g2 = grad(p[0], p[1]);
      const q: V2 = [p[0] + g2[0] * 0.12, p[1] + g2[1] * 0.12];
      rock(q[0], q[1], YW - 0.25, r, (big ? 0.55 : 0.32) + R() * 0.25, K.rock[Math.floor(R() * 5)]);
    }
    // 州浜の水ぎわの、丸い小さな石
    for (let k = 0; k < 9; k++) {
      const a = R() * Math.PI * 2;
      let t = cape.r;
      const dir: V2 = [Math.cos(a), Math.sin(a)];
      while (t < cape.r + 6 && sdPond(cape.x + dir[0] * t, cape.z + dir[1] * t) < -0.05) t += 0.1;
      const p: V2 = [cape.x + dir[0] * (t - 0.2), cape.z + dir[1] * (t - 0.2)];
      if (sdPond(p[0], p[1]) > 0.3) continue;
      rock(p[0], p[1], gAt(p) - 0.06, 0.16 + R() * 0.14, 0.14 + R() * 0.1, K.rock[Math.floor(R() * 5)], R() * 6, 0.85, 6);
    }
  }

  // ---------------- 石灯籠 ----------------
  const hexPrism = (cx: number, cz: number, r: number, y0: number, y1: number, col: THREE.Color, r1 = r, cap = true, n = 6, rot = Math.PI / 6) => {
    mb.prism(ngon(cx, cz, r, n, rot), y0, y1, col, PAT.garden, cap ? col : null, ngon(cx, cz, r1, n, rot));
  };
  // 火袋：6つの面のうち、窓の面は夜にともる
  const fireBox = (cx: number, cz: number, r: number, y0: number, y1: number, open: number[]) => {
    const poly = ngon(cx, cz, r, 6, Math.PI / 6);
    const ctr: V3 = [cx, (y0 + y1) / 2, cz];
    for (let k = 0; k < 6; k++) {
      const a = poly[k], b = poly[(k + 1) % 6];
      const isOpen = open.includes(k);
      quadOut([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], isOpen ? K.open : K.granite, ctr, isOpen ? PAT.gardenGlow : PAT.garden);
    }
  };
  const umbrella = (cx: number, cz: number, r: number, y0: number, band: number, rise: number, n = 6) => {
    const poly = ngon(cx, cz, r, n, Math.PI / 6);
    mb.prism(poly, y0, y0 + band, K.granite, PAT.garden, null);
    mb.prism(poly, y0 + band, y0 + band + rise, K.graniteDark, PAT.garden, K.graniteDark, ngon(cx, cz, r * 0.18, n, Math.PI / 6));
    capDown(poly, y0, K.graniteDark);
  };
  const lanternLight = (x: number, y: number, z: number, r = 4.5) => {
    if (!pond) return;
    const p = W(x, y, z);
    pond.addLight(p[0], p[1], p[2], r, 0.9, 0.54, 0.25);
  };
  // 雪見灯籠（州浜の水ぎわ）
  const yukimi = (cx: number, cz: number, s = 1) => {
    const gy = gAt([cx, cz]) - 0.02;
    mb.matOverride = MAT.concrete;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      strut([cx + Math.cos(a) * 0.5 * s, gy - 0.05, cz + Math.sin(a) * 0.5 * s], [cx + Math.cos(a) * 0.24 * s, gy + 0.46 * s, cz + Math.sin(a) * 0.24 * s], 0.08 * s, 0.07 * s, K.granite, 4);
    }
    hexPrism(cx, cz, 0.32 * s, gy + 0.46 * s, gy + 0.54 * s, K.granite);
    fireBox(cx, cz, 0.2 * s, gy + 0.54 * s, gy + 0.82 * s, [0, 2, 4]);
    umbrella(cx, cz, 0.82 * s, gy + 0.82 * s, 0.07 * s, 0.22 * s);
    hexPrism(cx, cz, 0.07 * s, gy + 1.11 * s, gy + 1.22 * s, K.granite, 0.02 * s, true, 8);
    mb.matOverride = null;
    lanternLight(cx, gy + 0.68 * s, cz);
    occupy(cx, cz, 0.9 * s);
  };
  // 春日灯籠（四阿への道ばた）
  const kasuga = (cx: number, cz: number) => {
    const gy = gAt([cx, cz]) - 0.02;
    mb.matOverride = MAT.concrete;
    hexPrism(cx, cz, 0.42, gy - 0.05, gy + 0.2, K.graniteDark, 0.36);
    hexPrism(cx, cz, 0.13, gy + 0.2, gy + 1.05, K.granite, 0.12, false, 8, 0);
    hexPrism(cx, cz, 0.18, gy + 0.56, gy + 0.64, K.granite, 0.18, true, 8, 0);
    hexPrism(cx, cz, 0.28, gy + 1.05, gy + 1.2, K.granite, 0.34);
    fireBox(cx, cz, 0.21, gy + 1.2, gy + 1.52, [0, 3]);
    umbrella(cx, cz, 0.47, gy + 1.52, 0.06, 0.24);
    hexPrism(cx, cz, 0.08, gy + 1.82, gy + 1.96, K.granite, 0.02, true, 8);
    mb.matOverride = null;
    lanternLight(cx, gy + 1.36, cz);
    occupy(cx, cz, 0.7);
  };
  // 岬灯籠（中島の水ぎわの小さな灯籠）
  const misaki = (cx: number, cz: number) => {
    const gy = gAt([cx, cz]) - 0.02;
    rock(cx, cz, gy - 0.1, 0.3, 0.32, K.rock[1]);
    mb.matOverride = MAT.concrete;
    hexPrism(cx, cz, 0.2, gy + 0.2, gy + 0.26, K.granite, 0.2, true, 4, Math.PI / 4);
    fireBox(cx, cz, 0.13, gy + 0.26, gy + 0.46, [1, 4]);
    umbrella(cx, cz, 0.36, gy + 0.46, 0.05, 0.14, 4);
    mb.matOverride = null;
    lanternLight(cx, gy + 0.36, cz, 4.5);
    occupy(cx, cz, 0.5);
  };
  {
    // 雪見灯籠：州浜の岬の先、水ぎわ
    const dirP = grad(cape.x, cape.z);
    let t = 0;
    while (t < 8 && sdPond(cape.x + dirP[0] * t, cape.z + dirP[1] * t) < -0.6) t += 0.1;
    yukimi(cape.x + dirP[0] * t - dirP[1] * 0.4, cape.z + dirP[1] * t + dirP[0] * 0.4, 1);
    // 岬灯籠：中島の橋のたもとから少し横
    if (bridgeIsl) {
      const v: V2 = [bridgeIsl[0] - isl.x, bridgeIsl[1] - isl.z];
      const l = Math.hypot(v[0], v[1]) || 1;
      const a = Math.atan2(v[1], v[0]) + 0.9;
      let rr = l;
      while (rr > 0.3 && sdPond(isl.x + Math.cos(a) * rr, isl.z + Math.sin(a) * rr) > -0.45) rr -= 0.1;
      misaki(isl.x + Math.cos(a) * rr, isl.z + Math.sin(a) * rr);
    }
  }

  // ---------------- 四阿（あずまや）と行灯 ----------------
  {
    const [px, pz] = pav;
    const gy = Math.max(gAt(pav), YG);
    const ctr: V3 = [px, gy + 1.5, pz];
    mb.matOverride = MAT.concrete;
    mb.box(px - 2.05, gy - 0.25, pz - 2.05, px + 2.05, gy + 0.2, pz + 2.05, K.graniteDark, PAT.garden, K.granite);
    mb.matOverride = null;
    const fy = gy + 0.2, ey = fy + 2.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) mb.box(px + sx * 1.55 - 0.08, fy, pz + sz * 1.55 - 0.08, px + sx * 1.55 + 0.08, ey, pz + sz * 1.55 + 0.08, K.wood, PAT.garden);
    // 桁（柱の上をつなぐ）
    mb.box(px - 1.65, ey - 0.16, pz - 1.63, px + 1.65, ey, pz - 1.47, K.wood, PAT.garden);
    mb.box(px - 1.65, ey - 0.16, pz + 1.47, px + 1.65, ey, pz + 1.63, K.wood, PAT.garden);
    mb.box(px - 1.63, ey - 0.16, pz - 1.47, px - 1.47, ey, pz + 1.47, K.wood, PAT.garden);
    mb.box(px + 1.47, ey - 0.16, pz - 1.47, px + 1.63, ey, pz + 1.47, K.wood, PAT.garden);
    // 腰掛け（池と反対の2辺）
    const gp = grad(px, pz); // 池から離れる向き（-gp が池の方）
    const bx = gp[0] < 0 ? 1 : -1, bz = gp[1] < 0 ? 1 : -1;
    mb.box(px + bx * 1.45 - 0.22, fy + 0.38, pz - 1.4, px + bx * 1.45 + 0.22, fy + 0.46, pz + 1.4, K.woodLight, PAT.garden);
    mb.box(px - 1.4, fy + 0.38, pz + bz * 1.45 - 0.22, px + 1.4, fy + 0.46, pz + bz * 1.45 + 0.22, K.woodLight, PAT.garden);
    // 屋根（宝形造・檜皮葺）：厚い軒先と、少しそりのある屋根
    const eo = 2.4, em = 1.25;
    const ry0 = ey + 0.04, ry1 = ry0 + 0.24, rym = ry1 + 0.42, ryt = rym + 0.9;
    mb.matOverride = MAT.shingle;
    const sq = (r: number, y: number): V3[] => [[px - r, y, pz - r], [px + r, y, pz - r], [px + r, y, pz + r], [px - r, y, pz + r]];
    const s0 = sq(eo, ry0), s1 = sq(eo, ry1), s2 = sq(em, rym);
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      quadOut(s0[k], s0[k1], s1[k1], s1[k], K.bark, ctr);
      quadOut(s1[k], s1[k1], s2[k1], s2[k], K.bark, [px, ry0 - 1, pz]);
      mb.tri(s2[k1], s2[k], [px, ryt, pz], K.bark, PAT.garden);
    }
    mb.matOverride = null;
    // 軒の裏（下向き）
    capDown([[px - eo, pz - eo], [px + eo, pz - eo], [px + eo, pz + eo], [px - eo, pz + eo]], ry0, K.woodLight);
    // 頂の飾り（露盤と宝珠）
    hexPrism(px, pz, 0.16, ryt - 0.08, ryt + 0.12, K.bronze, 0.14, true, 8);
    hexPrism(px, pz, 0.09, ryt + 0.12, ryt + 0.32, K.bronze, 0.03, true, 8);
    // 行灯（池に近い側の床の隅）
    const ax = px - bx * 1.1, az = pz - bz * 1.1;
    mb.box(ax - 0.2, fy, az - 0.2, ax + 0.2, fy + 0.06, az + 0.2, K.wood, PAT.garden);
    const actr: V3 = [ax, fy + 0.4, az];
    const ap = sq(0.17, 0).map((p) => [p[0] - px + ax, 0, p[2] - pz + az] as V3);
    for (let k = 0; k < 4; k++) {
      const a = ap[k], b = ap[(k + 1) % 4];
      quadOut([a[0], fy + 0.06, a[2]], [b[0], fy + 0.06, b[2]], [b[0], fy + 0.66, b[2]], [a[0], fy + 0.66, a[2]], K.paper, actr, PAT.gardenGlow);
    }
    mb.box(ax - 0.2, fy + 0.66, az - 0.2, ax + 0.2, fy + 0.71, az + 0.2, K.wood, PAT.garden);
    if (pond) {
      const p = W(ax, fy + 0.45, az);
      pond.addLight(p[0], p[1], p[2], 5.5, 0.95, 0.65, 0.36);
    }
    // 春日灯籠：四阿の手前（門の側）
    const kp: V2 = [px - Math.sign(px || 1) * 1.4, Math.min(d - 2.2, pz + 2.9)];
    if (sdPond(kp[0], kp[1]) < -1.2 && free(kp[0], kp[1], 0.8)) kasuga(kp[0], kp[1]);
  }

  // ---------------- 飛び石 ----------------
  {
    const stones: V2[] = [];
    const stoneAt = (x: number, z: number) => {
      if (sdPond(x, z) > -0.45 || !free(x, z, 0.3)) return;
      if (stones.some((q) => Math.hypot(q[0] - x, q[1] - z) < 0.75)) return;
      if (Math.hypot(x - pav[0], z - pav[1]) < 2.2) return;
      if (Math.abs(x) < 0.9 && z > pathEnd - 0.3) return;
      stones.push([x, z]);
      const r = 0.29 + R() * 0.1;
      const gy = gAt([x, z]);
      mb.matOverride = MAT.concrete;
      const n = 6 + Math.floor(R() * 2);
      const poly: V2[] = Array.from({ length: n }, (_, k) => {
        const a = (k / n) * Math.PI * 2 + jit(0.2);
        const rr = r * (0.82 + R() * 0.3);
        return [x + Math.cos(a) * rr, z + Math.sin(a) * rr * 0.85];
      });
      mb.prism(poly, gy - 0.1, gy + 0.07, K.step[Math.floor(R() * 3)], PAT.garden, K.step[Math.floor(R() * 3)]);
      mb.matOverride = null;
    };
    // 曲がった道すじ（2次のベジェ曲線）に沿って、少しずつ左右にずらして置く
    const path = (a: V2, b: V2, bend: number) => {
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const c: V2 = [mx - (dz / l) * bend, mz + (dx / l) * bend];
      const pts: V2[] = [];
      for (let k = 0; k <= 60; k++) {
        const t = k / 60;
        pts.push([(1 - t) * (1 - t) * a[0] + 2 * t * (1 - t) * c[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * t * (1 - t) * c[1] + t * t * b[1]]);
      }
      let acc = 0, side2 = 1;
      for (let k = 1; k < pts.length; k++) {
        acc += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        if (acc >= 0.92) {
          acc = 0;
          side2 = -side2;
          const tx = pts[k][0] - pts[k - 1][0], tz = pts[k][1] - pts[k - 1][1], tl = Math.hypot(tx, tz) || 1;
          stoneAt(pts[k][0] - (tz / tl) * 0.13 * side2, pts[k][1] + (tx / tl) * 0.13 * side2);
        }
      }
    };
    const start: V2 = [G2[0], G2[1] - 0.3];
    path(start, [pav[0] - Math.sign(pav[0] || 1) * 2.0, pav[1] + 0.6], 1.2);
    if (bridgeShore) path(start, bridgeShore, -1.5);
    const beachP: V2 = [cape.x + 1.2, cape.z + 1.6];
    path(bridgeShore ?? start, beachP, 1.4);
    for (const p of stones) occupy(p[0], p[1], 0.45);
  }

  // ---------------- 中島の黒松（雲のように刈り込んだ枝） ----------------
  const pine = (bx: number, bz: number, lean: number, s: number) => {
    const gy = gAt([bx, bz]) - 0.05;
    const lx = Math.cos(lean), lz = Math.sin(lean);
    const pts: V3[] = [];
    let x = bx, z = bz, y = gy;
    const wig = R() * 6.28;
    for (let k = 0; k <= 6; k++) {
      pts.push([x, y, z]);
      const t = k / 6;
      const sway = Math.sin(k * 1.3 + wig) * 0.12 * s;
      x += (lx * (0.3 + 0.32 * t) - lz * sway) * s;
      z += (lz * (0.3 + 0.32 * t) + lx * sway) * s;
      y += (0.66 - 0.06 * t) * s;
    }
    for (let k = 0; k < 6; k++) strut(pts[k], pts[k + 1], (0.2 - 0.024 * k) * s, (0.2 - 0.024 * (k + 1)) * s, K.pineBark, 7);
    // 枝の先の葉の房（下の枝ほど大きく横に張る）
    const top = pts[6];
    blob(top[0], top[2], top[1] - 0.12 * s, 0.95 * s, 0.55 * s, K.pine[0]);
    const nb = 5;
    for (let k = 0; k < nb; k++) {
      const tp = pts[2 + Math.min(4, Math.floor((k * 4) / nb + 0.5))];
      const a = lean + (k % 2 ? 1 : -1) * (0.9 + R() * 0.9) + (k > 2 ? Math.PI * 0.85 : 0) + jit(0.3);
      const reach = (1.5 - k * 0.12 + R() * 0.3) * s;
      const end: V3 = [tp[0] + Math.cos(a) * reach, tp[1] + (0.15 + R() * 0.2) * s, tp[2] + Math.sin(a) * reach];
      strut(tp, end, 0.07 * s, 0.045 * s, K.pineBark, 5);
      blob(end[0], end[2], end[1] - 0.08 * s, (1.05 - k * 0.08 + R() * 0.15) * s, (0.4 + R() * 0.12) * s, K.pine[k % 3]);
    }
    if (pond) {
      // 松のライトアップ（池の側から照らす）
      const ux = bx + lx * 0.9, uz = bz + lz * 0.9;
      const p = W(ux, gAt([ux, uz]) + 0.12, uz);
      pond.addLight(p[0], p[1], p[2], -8, 5.0, 4.4, 3.4);
      mb.box(ux - 0.07, gAt([ux, uz]), uz - 0.07, ux + 0.07, gAt([ux, uz]) + 0.12, uz + 0.07, K.fixture, PAT.garden);
    }
  };
  {
    // 池の中ほどへ傾ける
    const toward = Math.atan2(PB.z - isl.z, PB.x - isl.x);
    pine(isl.x - Math.cos(toward) * 0.5, isl.z - Math.sin(toward) * 0.5, toward + jit(0.4), 0.95 + R() * 0.15);
    occupy(isl.x, isl.z, isl.r);
  }

  // ---------------- 石組（三尊石）と刈り込み ----------------
  {
    const triad = (cx: number, cz: number, s: number) => {
      const a = R() * 6.28, gy = gAt([cx, cz]);
      rock(cx, cz, gy - 0.25, 0.55 * s, 1.35 * s, K.rock[Math.floor(R() * 5)], a, 0.7);
      for (const sgn of [-1, 1]) {
        const p: V2 = [cx + Math.cos(a) * 0.95 * s * sgn + jit(0.2), cz + Math.sin(a) * 0.95 * s * sgn + jit(0.2)];
        rock(p[0], p[1], gAt(p) - 0.2, 0.45 * s, (0.6 + R() * 0.25) * s, K.rock[Math.floor(R() * 5)]);
      }
      occupy(cx, cz, 1.6 * s);
    };
    const tp: V2 = [-0.68 * w + 1.2, -0.74 * d + 1.0];
    if (sdPond(tp[0], tp[1]) < -2 && free(tp[0], tp[1], 1.4)) triad(tp[0], tp[1], 1);
    const tp2: V2 = [0.74 * w - 1.0, -0.72 * d + 0.8];
    if (sdPond(tp2[0], tp2[1]) < -2 && free(tp2[0], tp2[1], 1.2)) triad(tp2[0], tp2[1], 0.75);
    // 刈り込み（丸くこんもりした低木）：滝石組の両脇、奥の隅、石組や四阿のそばに、2〜3株ずつまとめる
    const anchors: V2[] = [FP(0.9, -2.3), FP(0.9, 2.4), [-w + 2.6, -d + 2.6], [w - 2.6, -d + 2.8], [tp[0] + 1.6, tp[1] + 0.8], [tp2[0] - 1.4, tp2[1] + 0.9], [pav[0] + Math.sign(pav[0] || 1) * 2.6, pav[1] - 1.2], [-w + 2.4, d - 3.2]];
    for (const [ax0, az0] of anchors) {
      for (let tries = 0; tries < 6; tries++) {
        const x = ax0 + jit(0.8), z = az0 + jit(0.8);
        if (Math.abs(x) > w - 1.5 || Math.abs(z) > d - 1.5) continue;
        const s = sdPond(x, z);
        if (s > -0.9 || !free(x, z, 0.7)) continue;
        if (Math.abs(x) < 1.6 && z > pathEnd - 1) continue;
        const r = 0.6 + R() * 0.45;
        const cnt = 1 + Math.floor(R() * 3);
        for (let q = 0; q < cnt; q++) {
          const a = R() * 6.28, o = q ? r * (0.75 + R() * 0.3) : 0;
          const bx2 = x + Math.cos(a) * o, bz2 = z + Math.sin(a) * o, rr = r * (q ? 0.62 + R() * 0.2 : 1);
          blob(bx2, bz2, gAt([bx2, bz2]) - 0.05, rr, rr * (0.6 + R() * 0.15), K.shrub[Math.floor(R() * 3)], 9, 3);
        }
        occupy(x, z, r + 0.4);
        break;
      }
    }
  }

  // ---------------- 睡蓮（手前の入り江）と杜若（水ぎわ） ----------------
  {
    mb.matOverride = MAT.none;
    let lilies = 0;
    for (let tries = 0; tries < 200 && lilies < 22; tries++) {
      const a = R() * 6.28, rr = Math.sqrt(R()) * Math.min(PE.rx, PE.rz) * 0.8;
      const x = PE.x + Math.cos(a) * rr, z = PE.z + Math.sin(a) * rr;
      if (sdPond(x, z) < 0.55) continue;
      const r = 0.2 + R() * 0.17, y = YW + 0.03;
      const n = 9, rot = R() * 6.28;
      const col = K.pad[Math.floor(R() * 3)];
      // 切れこみのある丸い葉
      for (let k = 0; k < n - 1; k++) {
        const a0 = rot + (k / n) * Math.PI * 2 + 0.25, a1 = rot + ((k + 1) / n) * Math.PI * 2 + 0.25;
        mb.tri([x, y, z], [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r], [x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], col, PAT.garden);
      }
      if (R() < 0.28) {
        const fc = R() < 0.55 ? K.lilyW : K.lilyP;
        const fx = x + jit(r * 0.4), fz = z + jit(r * 0.4);
        mb.prism(ngon(fx, fz, 0.09, 5, R() * 6), y, y + 0.05, fc, PAT.garden, fc, ngon(fx, fz, 0.06, 5, R() * 6));
      }
      lilies++;
    }
    // 杜若：右手と手前の水ぎわに、いくつかの株
    let clumps = 0;
    for (let tries = 0; tries < 400 && clumps < 7; tries++) {
      const x = jit(w - 2.5), z = jit(d - 2.5);
      const s = sdPond(x, z);
      if (s < -0.25 || s > 0.2 || x < -0.15 * w || z < -0.35 * d) continue;
      if (fallW(x, z) > 0.05 || !free(x, z, 0.5)) continue;
      if ((bridgeShore && Math.hypot(x - bridgeShore[0], z - bridgeShore[1]) < 1.4)) continue;
      const gy = Math.max(gAt([x, z]), YW) - 0.02;
      for (let q = 0; q < 9; q++) {
        const a = R() * 6.28, lean = 0.08 + R() * 0.16, hh = 0.62 + R() * 0.32;
        const bx2 = x + jit(0.22), bz2 = z + jit(0.22);
        strut([bx2, gy, bz2], [bx2 + Math.cos(a) * lean, gy + hh, bz2 + Math.sin(a) * lean], 0.035, 0.012, K.iris, 3);
        if (q < 3 && R() < 0.8) {
          const fx = bx2 + Math.cos(a) * lean * 0.85, fz = bz2 + Math.sin(a) * lean * 0.85, fy = gy + hh * 0.82;
          mb.prism(ngon(fx, fz, 0.075, 3, R() * 6), fy, fy + 0.09, K.irisF, PAT.garden, K.irisF, ngon(fx, fz, 0.035, 3, R() * 6));
        }
      }
      occupy(x, z, 0.5);
      clumps++;
    }
    mb.matOverride = null;
  }

  // ---------------- 木（青もみじと杉）とライトアップ ----------------
  {
    const maples: [number, number, number][] = [];
    for (let tries = 0; tries < 300 && maples.length < 9; tries++) {
      const x = jit(w - 2.0), z = jit(d - 2.0);
      const s = sdPond(x, z);
      if (s > -1.4 || s < -6.5) continue;
      if (Math.hypot(x - isl.x, z - isl.z) < isl.r + 1) continue;
      if (Math.abs(x) < 2 && z > pathEnd - 1.5) continue;
      if (!free(x, z, 1.3) || maples.some(([mx, mz]) => Math.hypot(mx - x, mz - z) < 3.4)) continue;
      maples.push([x, z, s]);
      occupy(x, z, 0.8);
    }
    for (const [x, z] of maples) tf(x, z, 0.62 + R() * 0.22, 0, gAt([x, z]) - 0.05, MAPLE[Math.floor(R() * MAPLE.length)], R() < 0.6 ? 3 : 0);
    // 池にいちばん近いもみじを、下から照らす
    maples.sort((a, b) => b[2] - a[2]);
    for (const [x, z] of maples.slice(0, 3)) {
      const g2 = grad(x, z);
      const ux = x + g2[0] * 0.9, uz = z + g2[1] * 0.9;
      const gy = gAt([ux, uz]);
      if (pond) {
        const p = W(ux, gy + 0.12, uz);
        pond.addLight(p[0], p[1], p[2], -8.5, 5.0, 4.2, 3.1);
      }
      mb.box(ux - 0.07, gy, uz - 0.07, ux + 0.07, gy + 0.12, uz + 0.07, K.fixture, PAT.garden);
    }
    // 奥の杉（土塀の内側）
    let cn = 0;
    for (let tries = 0; tries < 60 && cn < 4; tries++) {
      const x = jit(w - 2.2), z = -d + 2.0 + R() * 3.5;
      if (sdPond(x, z) > -1.6 || !free(x, z, 1.1)) continue;
      tf(x, z, 1.0 + R() * 0.3, 1, gAt([x, z]) - 0.05);
      occupy(x, z, 1.4);
      cn++;
    }
    // 手前の左右の隅にも少し
    for (const sx of [-1, 1]) {
      const x = sx * (w - 2.0), z = d - 2.2;
      if (free(x, z, 1.0) && sdPond(x, z) < -2) {
        tf(x, z, 0.62 + R() * 0.15, 0, gAt([x, z]) - 0.05, MAPLE[Math.floor(R() * MAPLE.length)], 0);
        occupy(x, z, 1.0);
      }
    }
  }
  mb.matOverride = keepMat;
}
