// 車両と人の形。前は +z、幅は x（+x が左側）。頂点ごとに色（color）と材質（aPbr）を持つ。
// 乗用車は、前から後ろへ並べた断面をつないで作る（丸みのある肩、傾いた窓、なめらかな屋根）
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// 部品の材質：[ざらつき, 金属感, 色の掛け方, 光り方]
// 色の掛け方：0 = 頂点の色のまま、1 = インスタンスの色を掛ける（車体の色）、2〜4 = 人のズボン・肌・髪
// 光り方：0 = なし、1 = 前照灯、2 = 尾灯、3 = 表示板・行灯、4 = 窓（夜は車内の明かり）
type Part = readonly [number, number, number, number];
export const PART = {
  paint: [0.3, 0.06, 1, 0],
  paintMatte: [0.55, 0.05, 1, 0],
  paintMetal: [0.22, 0.75, 1, 0],
  glass: [0.04, 0, 0, 0],
  win: [0.04, 0, 0, 4],
  tire: [0.88, 0, 0, 0],
  rim: [0.28, 0.85, 0, 0],
  trim: [0.55, 0, 0, 0],
  chrome: [0.15, 1, 0, 0],
  head: [0.08, 0.3, 0, 1],
  tail: [0.2, 0, 0, 2],
  sign: [0.4, 0, 0, 3],
  plain: [0.5, 0.05, 0, 0],
  alu: [0.38, 0.55, 0, 0],
  cloth: [0.85, 0, 1, 0],
  pants: [0.8, 0, 2, 0],
  skin: [0.6, 0, 3, 0],
  hair: [0.7, 0, 4, 0],
} as const satisfies Record<string, Part>;

// よく使う色。PAINT（白）の部分が車体の色になる
const PAINT = 0xffffff, GLASS = 0x10151b, WIN = 0x141b23, TIRE = 0x161718, RIM = 0xb9bdc2, TRIM = 0x1d1f22, HEAD = 0xf2f4f6, TAIL = 0xb3141c, CHROME = 0xd0d4d8, WHITE = 0xeef0f1;
const AMBER = 0xe08a1e, PLATE = 0xe9ecdf;
// 色から部品を決める（vc を使う古い作り方のため）
const PART_OF = new Map<number, Part>([[PAINT, PART.paint], [GLASS, PART.glass], [WIN, PART.win], [TIRE, PART.tire], [RIM, PART.rim], [TRIM, PART.trim], [CHROME, PART.chrome], [HEAD, PART.head], [TAIL, PART.tail]]);
const partOf = (hex: number) => PART_OF.get(hex) ?? PART.plain;

const colors = new Map<number, THREE.Color>();
const lc = (hex: number) => colors.get(hex) ?? colors.set(hex, new THREE.Color(hex)).get(hex)!;

// three の形に、色と材質をつける（uv は使わない）
export function vc(geo: THREE.BufferGeometry, hex: number, part: Part = partOf(hex)) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = lc(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3), m = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a.set([c.r, c.g, c.b], i * 3);
    m.set(part, i * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.setAttribute('aPbr', new THREE.BufferAttribute(m, 4));
  g.deleteAttribute('uv');
  return g;
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp3 = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add = (a: V, b: V, k = 1): V => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const norm = (a: V): V => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// 三角形を貯めて形にする。smooth はなめらかな面（車体）、それ以外は平らな面
class Parts {
  private buf = { s: { p: [] as number[], c: [] as number[], m: [] as number[] }, f: { p: [] as number[], c: [] as number[], m: [] as number[] } };
  private extra: THREE.BufferGeometry[] = [];
  smooth = false;
  // hint は外向きのおおよその向き。逆向きなら裏返す
  tri(a: V, b: V, c: V, hex: number, part: Part, hint?: V) {
    const n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(n[0], n[1], n[2]) < 1e-7) return;
    if (hint && dot(n, hint) < 0) [b, c] = [c, b];
    const B = this.smooth ? this.buf.s : this.buf.f, k = lc(hex);
    for (const v of [a, b, c]) {
      B.p.push(v[0], v[1], v[2]);
      B.c.push(k.r, k.g, k.b);
      B.m.push(part[0], part[1], part[2], part[3]);
    }
  }
  quad(a: V, b: V, c: V, d: V, hex: number, part: Part, hint?: V) {
    this.tri(a, b, c, hex, part, hint);
    this.tri(a, c, d, hex, part, hint);
  }
  // 凸な多角形
  poly(ps: V[], hex: number, part: Part, hint?: V) {
    for (let i = 1; i < ps.length - 1; i++) this.tri(ps[0], ps[i], ps[i + 1], hex, part, hint);
  }
  // 面を選べる箱（下の面は省く。faces：'+x' '-x' '+y' '+z' '-z'）
  box(w: number, h: number, l: number, x: number, y: number, z: number, hex: number, part: Part = partOf(hex), faces = '+x-x+y+z-z') {
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2, z0 = z - l / 2, z1 = z + l / 2;
    if (faces.includes('+x')) this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], hex, part, [1, 0, 0]);
    if (faces.includes('-x')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], hex, part, [-1, 0, 0]);
    if (faces.includes('+y')) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], hex, part, [0, 1, 0]);
    if (faces.includes('-y')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], hex, part, [0, -1, 0]);
    if (faces.includes('+z')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], hex, part, [0, 0, 1]);
    if (faces.includes('-z')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], hex, part, [0, 0, -1]);
  }
  // 横向きの円盤（車輪）。s = +1 は左（+x）向き
  disc(s: number, x: number, y: number, z: number, r: number, seg: number, hex: number, part: Part, from = 0, to = Math.PI * 2) {
    const pts: V[] = [];
    const full = to - from >= Math.PI * 2 - 1e-6;
    const nSeg = full ? seg : Math.max(1, Math.round((seg * (to - from)) / (Math.PI * 2)));
    for (let i = 0; i < (full ? nSeg : nSeg + 1); i++) {
      const a = from + ((to - from) * i) / nSeg + (full ? Math.PI / seg : 0);
      pts.push([x, y + Math.sin(a) * r, z + Math.cos(a) * r]);
    }
    if (!full) pts.unshift([x, y, z]);
    this.poly(pts, hex, part, [s, 0, 0]);
  }
  geo(g: THREE.BufferGeometry, hex: number, part: Part = partOf(hex)) {
    this.extra.push(vc(g, hex, part));
  }
  build(crease = (40 * Math.PI) / 180) {
    const out: THREE.BufferGeometry[] = [];
    for (const [k, B] of Object.entries(this.buf)) {
      if (!B.p.length) continue;
      let g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.c, 3));
      g.setAttribute('aPbr', new THREE.Float32BufferAttribute(B.m, 4));
      if (k === 's') g = toCreasedNormals(g, crease);
      else g.computeVertexNormals();
      out.push(g);
    }
    for (const g of this.extra) if (!g.getAttribute('normal')) g.computeVertexNormals();
    return mergeGeometries([...out, ...this.extra])!;
  }
}

// ---------------- 乗用車 ----------------
// 断面：z、下端 y0、肩（窓の下）y1、上端 y2、下端の半幅 w0、肩の半幅 w1、上の半幅 w2
interface St { z: number; y0: number; y1: number; y2: number; w0: number; w1: number; w2: number }
const st = (z: number, y0: number, y1: number, y2: number, w1: number, w2: number, w0 = w1 * 0.95): St => ({ z, y0, y1, y2, w0, w1, w2 });
// 区間の種類：body = 全部車体、ws = 前の窓、roof = 屋根と横の窓、rw = 後ろの窓（横は窓）、rwc = 後ろの窓（横は車体）
type Gap = 'body' | 'ws' | 'roof' | 'rw' | 'rwc';
// 断面の 8 点（右下から上を回って左下へ）
function ring(s: St): V[] {
  const e = Math.min(0.09, (s.y2 - s.y1) * 0.22);
  return [
    [-s.w0, s.y0, s.z], [-s.w1, s.y1, s.z], [-s.w2, s.y2 - e, s.z], [-s.w2 * 0.8, s.y2, s.z],
    [s.w2 * 0.8, s.y2, s.z], [s.w2, s.y2 - e, s.z], [s.w1, s.y1, s.z], [s.w0, s.y0, s.z],
  ];
}
const segPart = (g: Gap, seg: number): Part => {
  // seg：0,6 = 下の横、1,5 = 上の横（窓）、2,4 = 屋根の端（柱）、3 = 上
  if (seg === 0 || seg === 6 || g === 'body') return PART.paint;
  if (seg === 1 || seg === 5) return g === 'rwc' ? PART.paint : PART.glass;
  if (seg === 2 || seg === 4) return PART.paint;
  return g === 'roof' ? PART.paint : PART.glass;
};

interface CarOpt {
  sts: St[]; // 前から後ろへ
  gaps: Gap[];
  r: number; // 車輪の半径
  axles: number[];
  rearGlass?: boolean; // 後ろの面の上半分がガラス（ハッチバック・SUV など）
  frontGlass?: boolean; // 前の面の上半分がガラス（キャブオーバー）
  pillar?: number; // B ピラーの位置（屋根の区間の中の割合）
  arch?: number; // フェンダーの黒い縁の太さ
  mirrors?: boolean;
}

// 断面をつないだ車体。返り値の on() で、車体の面の上に部品を貼れる
function loftBody(P: Parts, o: CarOpt) {
  const R = o.sts.map(ring);
  const zF = o.sts[0].z, zR = o.sts[o.sts.length - 1].z;
  P.smooth = true;
  for (let i = 0; i < R.length - 1; i++)
    for (let s = 0; s < 7; s++) {
      const a = R[i][s], b = R[i][s + 1], c = R[i + 1][s + 1], d = R[i + 1][s];
      const part = segPart(o.gaps[i], s);
      // 前から後ろへ並べているので、a→b→c→d の向きがいつも外向き
      P.quad(a, b, c, d, part === PART.paint ? PAINT : GLASS, part);
    }
  // 前と後ろの面（下半分は車体、上半分は車体かガラス）
  for (const [k, glass, sgn] of [[0, !!o.frontGlass, 1], [R.length - 1, !!o.rearGlass, -1]] as const) {
    const r = R[k];
    P.quad(r[0], r[1], r[6], r[7], PAINT, PART.paint, [0, 0, sgn]);
    P.poly([r[1], r[2], r[3], r[4], r[5], r[6]], glass ? GLASS : PAINT, glass ? PART.glass : PART.paint, [0, 0, sgn]);
  }
  P.smooth = false;
  // 区間 i、面 s の (u, v) の点（u は前→後ろ、v は面の中）。外へ off だけ浮かせる
  // 面の外向き（対角線の外積）
  const nrm = (i: number, s: number) => norm(cross(sub(R[i + 1][s + 1], R[i][s]), sub(R[i + 1][s], R[i][s + 1])));
  const at = (i: number, s: number, u: number, v: number, off: number): V => add(lerp3(lerp3(R[i][s], R[i][s + 1], v), lerp3(R[i + 1][s], R[i + 1][s + 1], v), u), nrm(i, s), off);
  const on = (i: number, s: number, u0: number, u1: number, v0: number, v1: number, hex: number, part: Part, off = 0.012) => {
    P.quad(at(i, s, u0, v0, off), at(i, s, u1, v0, off), at(i, s, u1, v1, off), at(i, s, u0, v1, off), hex, part, nrm(i, s));
  };
  // 前（k=0）・後ろの面に貼る四角（x0..x1, y0..y1）
  const cap = (front: boolean, x0: number, x1: number, y0: number, y1: number, hex: number, part: Part, off = 0.012) => {
    const z = (front ? zF : zR) + (front ? off : -off);
    P.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], hex, part, [0, 0, front ? 1 : -1]);
  };
  // z の位置の断面（間をとる）
  const stAt = (z: number): St => {
    for (let i = 0; i < o.sts.length - 1; i++) {
      const a = o.sts[i], b = o.sts[i + 1];
      if (z <= a.z && z >= b.z) {
        const t = (a.z - z) / (a.z - b.z || 1);
        return { z, y0: a.y0 + (b.y0 - a.y0) * t, y1: a.y1 + (b.y1 - a.y1) * t, y2: a.y2 + (b.y2 - a.y2) * t, w0: a.w0 + (b.w0 - a.w0) * t, w1: a.w1 + (b.w1 - a.w1) * t, w2: a.w2 + (b.w2 - a.w2) * t };
      }
    }
    return z > zF ? o.sts[0] : o.sts[o.sts.length - 1];
  };
  return { R, on, cap, stAt };
}

// 車輪：フェンダーの黒い縁、タイヤ、ホイール（円盤を重ねる）
function wheelSet(P: Parts, stAt: (z: number) => St, r: number, zs: number[], arch = 0.07, dual = false) {
  for (const z of zs) {
    const s0 = stAt(z);
    // 車輪の上の高さでの車体の横の位置
    const yTop = r * 2 + arch;
    const t = Math.max(0, Math.min(1, (yTop - s0.y0) / (s0.y1 - s0.y0 || 1)));
    const bx = s0.w0 + (s0.w1 - s0.w0) * t;
    for (const s of [-1, 1]) {
      if (arch > 0) P.disc(s, s * (bx + 0.004), r, z, r + arch, 8, TRIM, PART.trim, 0, Math.PI);
      P.disc(s, s * (bx + 0.014), r, z, r, 8, TIRE, PART.tire);
      P.disc(s, s * (bx + 0.024), r, z, r * (dual ? 0.5 : 0.62), 8, RIM, PART.rim);
    }
  }
}

// 乗用車の共通の作り：車体、車輪、ライト、グリル、ミラー
function car(o: CarOpt, extra?: (P: Parts, B: ReturnType<typeof loftBody>) => void) {
  const P = new Parts();
  const B = loftBody(P, o);
  const f = o.sts[0], b = o.sts[o.sts.length - 1];
  wheelSet(P, B.stAt, o.r, o.axles, o.arch ?? 0.07);
  // 前照灯：前の面の上の左右と、鼻先の角へ回り込む部分
  for (const s of [-1, 1]) B.cap(true, s * f.w1 * 0.48, s * f.w1 * 0.96, f.y1 - 0.13, f.y1 - 0.02, HEAD, PART.head);
  B.on(0, 2, 0.0, 0.6, 0, 1, HEAD, PART.head);
  B.on(0, 4, 0.0, 0.6, 0, 1, HEAD, PART.head);
  // 前の面：グリル（黒）とナンバー
  B.cap(true, -f.w1 * 0.42, f.w1 * 0.42, f.y0 + 0.12, f.y1 - 0.16, TRIM, PART.trim);
  B.cap(true, -0.2, 0.2, f.y0 + 0.02, f.y0 + 0.13, PLATE, PART.plain, 0.02);
  // 尾灯：後ろの面の上の左右と、細い横一文字の帯
  const ty = b.y1 - 0.03;
  B.cap(false, b.w1 * 0.42, b.w1 * 0.96, ty - 0.13, ty, TAIL, PART.tail);
  B.cap(false, -b.w1 * 0.96, -b.w1 * 0.42, ty - 0.13, ty, TAIL, PART.tail);
  B.cap(false, -b.w1 * 0.42, b.w1 * 0.42, ty - 0.06, ty - 0.03, TAIL, PART.tail);
  B.cap(false, -0.2, 0.2, b.y0 + 0.12, b.y0 + 0.24, PLATE, PART.plain);
  // 後ろの下（黒いバンパーの下端）
  B.cap(false, -b.w0 * 0.9, b.w0 * 0.9, b.y0, b.y0 + 0.08, TRIM, PART.trim);
  // B ピラー（車体の色）
  const ri = o.gaps.indexOf('roof');
  if (ri >= 0 && o.pillar !== undefined) {
    B.on(ri, 1, o.pillar, o.pillar + 0.06, 0, 1, PAINT, PART.paint, 0.01);
    B.on(ri, 5, o.pillar, o.pillar + 0.06, 0, 1, PAINT, PART.paint, 0.01);
  }
  // ミラー（窓の付け根）
  if (o.mirrors !== false) {
    const wi = o.gaps.indexOf('ws'), sw = o.sts[wi];
    for (const s of [-1, 1]) {
      const x = s * (sw.w1 + 0.1), y = sw.y1 + 0.06, z = sw.z - 0.2;
      P.quad([s * sw.w1 * 0.97, y - 0.05, z], [x, y - 0.05, z - 0.04], [x, y + 0.08, z - 0.04], [s * sw.w1 * 0.97, y + 0.08, z], PAINT, PART.paint, [0, 0.2, 1]);
      P.quad([s * sw.w1 * 0.97, y + 0.08, z], [x, y + 0.08, z - 0.04], [x, y + 0.08, z - 0.16], [s * sw.w1 * 0.97, y + 0.08, z - 0.16], PAINT, PART.paint, [0, 1, 0]);
    }
  }
  extra?.(P, B);
  return P.build();
}

export function sedan() {
  return car({
    sts: [st(2.32, 0.32, 0.7, 0.74, 0.82, 0.68, 0.78), st(2.1, 0.26, 0.82, 0.86, 0.89, 0.79), st(1.02, 0.25, 0.94, 0.98, 0.9, 0.81), st(0.2, 0.25, 0.97, 1.44, 0.9, 0.66), st(-1.0, 0.25, 0.99, 1.43, 0.9, 0.65), st(-1.78, 0.27, 1.01, 1.05, 0.89, 0.78), st(-2.32, 0.34, 0.97, 1.0, 0.82, 0.7, 0.78)],
    gaps: ['body', 'body', 'ws', 'roof', 'rw', 'body'],
    r: 0.33, axles: [1.4, -1.38], pillar: 0.45,
  });
}
export function hatchback() {
  return car({
    sts: [st(2.02, 0.3, 0.64, 0.68, 0.79, 0.64, 0.75), st(1.82, 0.24, 0.79, 0.85, 0.86, 0.76), st(0.92, 0.24, 0.93, 0.97, 0.87, 0.78), st(0.02, 0.24, 0.97, 1.47, 0.87, 0.63), st(-1.62, 0.25, 0.99, 1.45, 0.87, 0.63), st(-2.02, 0.33, 0.96, 1.34, 0.83, 0.6, 0.78)],
    gaps: ['body', 'body', 'ws', 'roof', 'rwc'],
    r: 0.31, axles: [1.27, -1.28], rearGlass: true, pillar: 0.5,
  });
}
export function suv() {
  return car({
    sts: [st(2.33, 0.42, 0.82, 0.88, 0.86, 0.7, 0.8), st(2.12, 0.34, 0.98, 1.04, 0.92, 0.82), st(1.12, 0.34, 1.1, 1.15, 0.93, 0.84), st(0.22, 0.34, 1.14, 1.67, 0.93, 0.71), st(-1.95, 0.35, 1.17, 1.65, 0.93, 0.71), st(-2.33, 0.44, 1.12, 1.55, 0.88, 0.66, 0.82)],
    gaps: ['body', 'body', 'ws', 'roof', 'rwc'],
    r: 0.37, axles: [1.42, -1.4], rearGlass: true, pillar: 0.4, arch: 0.13,
  }, (P) => {
    // ルーフレール
    for (const s of [-1, 1]) P.box(0.05, 0.05, 1.9, s * 0.62, 1.69, -0.85, TRIM, PART.trim, s > 0 ? '+x+y+z-z' : '-x+y+z-z');
  });
}
export function minivan() {
  return car({
    sts: [st(2.37, 0.32, 0.76, 0.82, 0.84, 0.7, 0.8), st(2.2, 0.28, 0.93, 0.99, 0.89, 0.8), st(1.5, 0.28, 1.05, 1.1, 0.9, 0.84), st(0.72, 0.28, 1.08, 1.84, 0.9, 0.79), st(-2.22, 0.28, 1.1, 1.83, 0.9, 0.79), st(-2.37, 0.34, 1.08, 1.76, 0.87, 0.76, 0.82)],
    gaps: ['body', 'body', 'ws', 'roof', 'rwc'],
    r: 0.33, axles: [1.52, -1.45], rearGlass: true, pillar: 0.2,
  }, (P, B) => {
    // スライドドアのレール（細い黒い線）
    B.on(3, 0, 0.42, 0.75, 0.86, 0.9, TRIM, PART.trim, 0.008);
    B.on(3, 6, 0.42, 0.75, 0.1, 0.14, TRIM, PART.trim, 0.008);
  });
}
// 軽自動車（背の高いワゴン）
export function kei() {
  return car({
    sts: [st(1.7, 0.3, 0.7, 0.76, 0.7, 0.6, 0.66), st(1.55, 0.26, 0.86, 0.92, 0.73, 0.66), st(1.04, 0.26, 0.98, 1.02, 0.74, 0.7), st(0.56, 0.26, 1.0, 1.77, 0.74, 0.68), st(-1.62, 0.26, 1.02, 1.76, 0.74, 0.68), st(-1.7, 0.3, 1.0, 1.7, 0.72, 0.66, 0.69)],
    gaps: ['body', 'body', 'ws', 'roof', 'rwc'],
    r: 0.28, axles: [1.18, -1.14], rearGlass: true, pillar: 0.3, arch: 0.05,
  });
}
// タクシー（背の高いセダン型。屋根に行灯）
export function taxi() {
  return car({
    sts: [st(2.2, 0.3, 0.7, 0.76, 0.78, 0.64, 0.74), st(2.0, 0.26, 0.86, 0.92, 0.84, 0.74), st(1.12, 0.26, 0.98, 1.02, 0.85, 0.78), st(0.32, 0.26, 1.01, 1.69, 0.85, 0.7), st(-1.86, 0.26, 1.03, 1.67, 0.85, 0.7), st(-2.2, 0.32, 1.0, 1.52, 0.82, 0.64, 0.77)],
    gaps: ['body', 'body', 'ws', 'roof', 'rwc'],
    r: 0.3, axles: [1.36, -1.3], rearGlass: true, pillar: 0.42,
  }, (P) => {
    P.box(0.46, 0.2, 0.16, 0, 1.79, 0.05, 0xfff3c4, PART.sign, '+x-x+y+z-z');
  });
}
// ピックアップトラック（運転台は断面から、荷台は箱から作る）
export function pickup() {
  const W = 0.93;
  return car({
    sts: [st(2.65, 0.44, 0.88, 0.94, 0.88, 0.74, 0.84), st(2.45, 0.4, 1.03, 1.09, 0.93, 0.84), st(1.42, 0.4, 1.14, 1.19, 0.93, 0.86), st(0.72, 0.4, 1.17, 1.8, 0.93, 0.74), st(-0.38, 0.4, 1.18, 1.78, 0.93, 0.74, 0.88)],
    gaps: ['body', 'body', 'ws', 'roof'],
    r: 0.38, axles: [1.72], rearGlass: true, pillar: 0.45, arch: 0.1,
  }, (P) => {
    // 荷台：横の壁、後ろのあおり、床。後輪
    for (const s of [-1, 1]) P.box(0.07, 0.78, 2.22, s * (W - 0.035), 0.79, -1.55, PAINT, PART.paint, '+x-x+y');
    P.box(2 * W, 0.78, 0.07, 0, 0.79, -2.63, PAINT, PART.paint, '+y+z-z');
    P.box(2 * W - 0.14, 0.04, 2.2, 0, 0.62, -1.52, TRIM, PART.trim, '+y');
    P.box(2 * W, 0.12, 0.08, 0, 0.36, -2.67, TRIM, PART.trim, '-z+y');
    for (const s of [-1, 1]) {
      P.quad([s * (W - 0.0), 1.06, -2.6], [s * (W - 0.0), 1.06, -2.4], [s * (W - 0.0), 0.9, -2.4], [s * (W - 0.0), 0.9, -2.6], TAIL, PART.tail, [s, 0, 0]);
      P.quad([s * W * 0.95, 1.06, -2.672], [s * W * 0.55, 1.06, -2.672], [s * W * 0.55, 0.9, -2.672], [s * W * 0.95, 0.9, -2.672], TAIL, PART.tail, [0, 0, -1]);
    }
    for (const s of [-1, 1]) {
      P.disc(s, s * (W + 0.004), 0.38, -1.72, 0.48, 8, TRIM, PART.trim, 0, Math.PI);
      P.disc(s, s * (W + 0.014), 0.38, -1.72, 0.38, 8, TIRE, PART.tire);
      P.disc(s, s * (W + 0.024), 0.38, -1.72, 0.24, 8, RIM, PART.rim);
    }
  });
}

// ---------------- バス・トラック ----------------
// 路線バス（ノンステップ）：白い車体に色の帯（インスタンスの色）、大きな窓、行き先表示、屋根の冷房装置
export function cityBus() {
  const P = new Parts();
  const L = 6.0, w = 1.245;
  const sts = [st(L, 0.36, 1.12, 2.92, 1.17, 1.12, 1.12), st(L - 0.18, 0.32, 1.08, 3.06, w, w, w - 0.02), st(-L + 0.2, 0.32, 1.08, 3.06, w, w, w - 0.02), st(-L, 0.42, 1.12, 2.96, 1.19, 1.15, 1.14)];
  const R = sts.map(ring);
  P.smooth = true;
  for (let i = 0; i < 3; i++)
    for (let s = 0; s < 7; s++) {
      const a = R[i][s], b = R[i][s + 1], c = R[i + 1][s + 1], d = R[i + 1][s];
      // 下の横は帯の色、ほかは白
      const lower = s === 0 || s === 6;
      P.quad(a, b, c, d, lower ? PAINT : WHITE, lower ? PART.paint : PART.plain);
    }
  // 前の面：下は帯の色、上は大きなガラス。後ろの面：下は白、上は小さな窓
  P.quad(R[0][0], R[0][1], R[0][6], R[0][7], PAINT, PART.paint, [0, 0, 1]);
  P.poly([R[0][1], R[0][2], R[0][3], R[0][4], R[0][5], R[0][6]], GLASS, PART.glass, [0, 0, 1]);
  P.quad(R[3][0], R[3][1], R[3][6], R[3][7], WHITE, PART.plain, [0, 0, -1]);
  P.poly([R[3][1], R[3][2], R[3][3], R[3][4], R[3][5], R[3][6]], WHITE, PART.plain, [0, 0, -1]);
  P.smooth = false;
  // 横の窓（柱で区切る）と、右側（-x）のドア
  const winY0 = 1.32, winY1 = 2.66;
  const panes: [number, number][] = [[4.05, 5.6], [2.55, 3.95], [1.0, 2.45], [-0.8, 0.9], [-2.3, -0.9], [-3.8, -2.4], [-5.5, -3.9]];
  for (const s of [-1, 1]) {
    const x = s * (w + 0.012);
    for (const [z0, z1] of panes) {
      // 右側のドアのところは窓をよけない（ドアは別に貼る）
      P.quad([x, winY0, z0], [x, winY0, z1], [x, winY1, z1], [x, winY1, z0], WIN, PART.win, [s, 0, 0]);
    }
    // 窓の下の黒い帯
    P.quad([x, winY0 - 0.06, -5.6], [x, winY0 - 0.06, 5.65], [x, winY0 - 0.02, 5.65], [x, winY0 - 0.02, -5.6], TRIM, PART.trim, [s, 0, 0]);
  }
  for (const [z0, z1] of [[4.15, 5.35], [-0.75, 0.5]]) {
    const x = -(w + 0.02);
    P.quad([x, 0.4, z0], [x, 0.4, z1], [x, 2.7, z1], [x, 2.7, z0], GLASS, PART.win, [-1, 0, 0]);
    P.quad([x - 0.002, 0.4, (z0 + z1) / 2 - 0.02], [x - 0.002, 0.4, (z0 + z1) / 2 + 0.02], [x - 0.002, 2.7, (z0 + z1) / 2 + 0.02], [x - 0.002, 2.7, (z0 + z1) / 2 - 0.02], TRIM, PART.trim, [-1, 0, 0]);
  }
  // 行き先表示（夜は光る）、前照灯、尾灯、後ろの窓
  const zf = L + 0.014, zr = -L - 0.014;
  P.quad([-0.85, 2.6, zf], [0.85, 2.6, zf], [0.85, 2.82, zf], [-0.85, 2.82, zf], 0xffa040, PART.sign, [0, 0, 1]);
  for (const s of [-1, 1]) {
    P.quad([s * 0.75, 0.62, zf], [s * 1.08, 0.62, zf], [s * 1.08, 0.82, zf], [s * 0.75, 0.82, zf], HEAD, PART.head, [0, 0, 1]);
    P.quad([s * 0.85, 0.7, zr], [s * 1.12, 0.7, zr], [s * 1.12, 1.25, zr], [s * 0.85, 1.25, zr], TAIL, PART.tail, [0, 0, -1]);
  }
  P.quad([-0.9, 0.36, zf], [0.9, 0.36, zf], [0.9, 0.56, zf], [-0.9, 0.56, zf], TRIM, PART.trim, [0, 0, 1]);
  P.quad([-0.75, 1.7, zr], [0.75, 1.7, zr], [0.75, 2.55, zr], [-0.75, 2.55, zr], WIN, PART.win, [0, 0, -1]);
  P.quad([-0.75, 2.62, zr], [0.75, 2.62, zr], [0.75, 2.8, zr], [-0.75, 2.8, zr], 0xffa040, PART.sign, [0, 0, -1]);
  // 屋根の冷房装置
  P.box(1.7, 0.28, 3.2, 0, 3.2, 0.6, 0xdfe2e5, PART.plain, '+x-x+y+z-z');
  // ミラー（前に張り出す）
  for (const s of [-1, 1]) P.box(0.06, 0.4, 0.1, s * 1.36, 2.2, L - 0.1, TRIM, PART.trim, '+x-x+z-z+y');
  wheelSet(P, () => sts[1], 0.5, [3.9, -3.3], 0.08);
  return P.build();
}

// キャブオーバーの運転台（トラック・ゴミ収集車）。前面の上半分がガラス
function cab(P: Parts, zF: number, zB: number, W: number, yb: number, yTop: number, belt: number) {
  const w = W / 2;
  const sts = [st(zF, yb + 0.05, belt, yTop - 0.06, w - 0.06, w - 0.12, w - 0.08), st(zF - 0.22, yb, belt, yTop, w, w - 0.06, w - 0.02), st(zB, yb, belt, yTop, w, w - 0.06, w - 0.02)];
  const B = loftBody(P, { sts, gaps: ['body', 'body'], r: 0.5, axles: [0, 0], frontGlass: true });
  // 横の窓（ドアの窓）
  B.on(1, 1, 0.0, 0.62, 0.08, 0.86, GLASS, PART.glass);
  B.on(1, 5, 0.0, 0.62, 0.14, 0.92, GLASS, PART.glass);
  // 前：バンパー、グリル、ライト
  B.cap(true, -w + 0.08, w - 0.08, yb + 0.05, yb + 0.32, TRIM, PART.trim);
  B.cap(true, -w * 0.6, w * 0.6, yb + 0.42, belt - 0.12, 0x3a3e44, PART.trim);
  for (const s of [-1, 1]) B.cap(true, s * (w * 0.62), s * (w - 0.12), yb + 0.4, yb + 0.6, HEAD, PART.head, 0.016);
  // ミラー（大きいもの）
  for (const s of [-1, 1]) P.box(0.06, 0.5, 0.14, s * (w + 0.25), belt + 0.35, zF - 0.1, TRIM, PART.trim, '+x-x+y+z-z');
  return B;
}
// 二重の後輪（タイヤを横から見た輪と、トレッド）
function bigWheel(P: Parts, x: number, z: number, r: number, wdt: number) {
  const s = Math.sign(x);
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + Math.PI / n, a1 = ((i + 1) / n) * Math.PI * 2 + Math.PI / n;
    const p = (a: number, xx: number): V => [xx, r + Math.sin(a) * r, z + Math.cos(a) * r];
    P.quad(p(a0, x - s * wdt), p(a1, x - s * wdt), p(a1, x), p(a0, x), TIRE, PART.tire, [0, Math.sin((a0 + a1) / 2), Math.cos((a0 + a1) / 2)]);
  }
  P.disc(s, x, r, z, r, 8, TIRE, PART.tire);
  P.disc(s, x + s * 0.01, r, z, r * 0.55, 8, RIM, PART.rim);
}

// 箱型のトラック（運転台＋アルミの荷箱）
export function boxTruck() {
  const P = new Parts();
  const W = 2.3;
  cab(P, 4.35, 2.05, W, 0.62, 2.85, 1.6);
  P.box(W - 0.5, 0.36, 7.4, 0, 0.78, -0.4, TRIM, PART.trim, '+x-x+z-z');
  // 荷箱：アルミの白、下に会社の色の帯、後ろの扉の線
  P.box(2.45, 2.55, 6.3, 0, 2.23, -1.25, 0xe6e8ea, PART.alu, '+x-x+y+z-z');
  for (const s of [-1, 1]) {
    const x = s * 1.237;
    P.quad([x, 1.0, -4.38], [x, 1.0, 1.88], [x, 1.32, 1.88], [x, 1.32, -4.38], PAINT, PART.paint, [s, 0, 0]);
    // 横の巻き込み防止の柵
    P.quad([s * 1.1, 0.55, -1.9], [s * 1.1, 0.55, 2.6], [s * 1.1, 0.75, 2.6], [s * 1.1, 0.75, -1.9], 0x9aa0a6, PART.alu, [s, 0, 0]);
  }
  const zr = -4.4 - 0.012;
  P.quad([-0.02, 1.0, zr], [0.02, 1.0, zr], [0.02, 3.45, zr], [-0.02, 3.45, zr], 0x8a9096, PART.alu, [0, 0, -1]);
  for (const s of [-1, 1]) P.quad([s * 0.7, 0.62, -4.42], [s * 1.12, 0.62, -4.42], [s * 1.12, 0.8, -4.42], [s * 0.7, 0.8, -4.42], TAIL, PART.tail, [0, 0, -1]);
  P.box(2.2, 0.12, 0.1, 0, 0.5, -4.35, TRIM, PART.trim, '+y-z');
  // 車輪：前は運転台の下、後ろは二軸
  for (const s of [-1, 1]) {
    P.disc(s, s * (W / 2 + 0.004), 0.5, 3.3, 0.58, 8, TRIM, PART.trim, 0, Math.PI);
    P.disc(s, s * (W / 2 + 0.014), 0.5, 3.3, 0.5, 8, TIRE, PART.tire);
    P.disc(s, s * (W / 2 + 0.024), 0.5, 3.3, 0.3, 8, RIM, PART.rim);
    for (const z of [-2.5, -3.6]) bigWheel(P, s * 1.2, z, 0.5, 0.5);
  }
  return P.build();
}
// トレーラーを引く車（キャブオーバーのトラクター）。連結部は z = -1.6
export function tractor() {
  const P = new Parts();
  const W = 2.45;
  cab(P, 3.1, 1.0, W, 0.68, 3.25, 1.75);
  // 屋根の上の風よけ
  P.quad([-1.05, 3.25, 1.6], [1.05, 3.25, 1.6], [1.05, 3.62, 1.0], [-1.05, 3.62, 1.0], PAINT, PART.paint, [0, 1, 1]);
  for (const s of [-1, 1]) P.quad([s * 1.05, 3.25, 1.6], [s * 1.05, 3.25, 1.0], [s * 1.05, 3.62, 1.0], [s * 1.05, 3.25, 1.0], PAINT, PART.paint, [s, 0, 0]);
  // シャシー、連結器、燃料タンク、排気管
  P.box(1.6, 0.4, 5.6, 0, 0.82, -0.3, TRIM, PART.trim, '+x-x+y+z-z');
  P.box(1.5, 0.08, 1.3, 0, 1.06, -1.6, 0x3a3d42, PART.plain, '+y');
  for (const s of [-1, 1]) P.box(0.5, 0.55, 1.2, s * 1.0, 0.85, 0.2, 0xc8ccd0, PART.alu, s > 0 ? '+x+y+z-z' : '-x+y+z-z');
  P.geo(new THREE.CylinderGeometry(0.1, 0.1, 2.5, 6, 1, true).translate(1.1, 2.4, 0.85), CHROME, PART.chrome);
  for (const s of [-1, 1]) {
    P.disc(s, s * (W / 2 + 0.004), 0.52, 2.4, 0.6, 8, TRIM, PART.trim, 0, Math.PI);
    P.disc(s, s * (W / 2 + 0.014), 0.52, 2.4, 0.52, 8, TIRE, PART.tire);
    P.disc(s, s * (W / 2 + 0.024), 0.52, 2.4, 0.32, 8, RIM, PART.rim);
    for (const z of [-1.3, -2.5]) bigWheel(P, s * 1.22, z, 0.52, 0.5);
  }
  return P.build();
}
// 箱型のトレーラー（連結部が原点、後ろ向きに伸びる）
export function trailerBox() {
  const P = new Parts();
  const W = 2.55;
  P.box(W, 2.85, 14.4, 0, 2.6, -6.9, PAINT, PART.paintMatte, '+x-x+y+z-z');
  // 屋根の縁と下の縁（細い線）
  for (const s of [-1, 1]) {
    const x = s * (W / 2 + 0.01);
    P.quad([x, 3.92, -14.1], [x, 3.92, 0.3], [x, 4.0, 0.3], [x, 4.0, -14.1], 0xb8bcc0, PART.alu, [s, 0, 0]);
    P.quad([x, 1.18, -14.1], [x, 1.18, 0.3], [x, 1.3, 0.3], [x, 1.3, -14.1], 0x8a9096, PART.alu, [s, 0, 0]);
  }
  // 後ろの扉（真ん中の線と、取っ手の棒）
  const zr = -14.1 - 0.012;
  P.quad([-0.03, 1.2, zr], [0.03, 1.2, zr], [0.03, 4.0, zr], [-0.03, 4.0, zr], 0x5a6066, PART.plain, [0, 0, -1]);
  for (const x of [-0.55, 0.55]) P.quad([x - 0.025, 1.4, zr], [x + 0.025, 1.4, zr], [x + 0.025, 3.8, zr], [x - 0.025, 3.8, zr], CHROME, PART.chrome, [0, 0, -1]);
  P.box(W - 0.6, 0.3, 13.6, 0, 1.0, -7.0, TRIM, PART.trim, '+x-x');
  P.box(0.12, 0.85, 0.12, -0.8, 0.6, -2.0, TRIM, PART.trim, '+x-x+z-z'); P.box(0.12, 0.85, 0.12, 0.8, 0.6, -2.0, TRIM, PART.trim, '+x-x+z-z');
  P.box(W - 0.3, 0.12, 0.1, 0, 0.55, -14.0, TRIM, PART.trim, '+y-z');
  for (const s of [-1, 1]) {
    for (const z of [-11.6, -12.8]) bigWheel(P, s * 1.2, z, 0.5, 0.5);
    P.quad([s * 0.75, 0.95, -14.13], [s * 1.15, 0.95, -14.13], [s * 1.15, 1.12, -14.13], [s * 0.75, 1.12, -14.13], TAIL, PART.tail, [0, 0, -1]);
  }
  return P.build();
}
// タンクのトレーラー（ステンレスのタンク）
export function trailerTank() {
  const P = new Parts();
  const W = 2.5;
  P.geo(new THREE.CylinderGeometry(1.15, 1.15, 11.6, 14, 1, true).rotateX(Math.PI / 2).translate(0, 2.35, -7.2), PAINT, PART.paintMetal);
  P.geo(new THREE.SphereGeometry(1.15, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).translate(0, 2.35, -1.4).scale(1, 1, 1), PAINT, PART.paintMetal);
  P.geo(new THREE.SphereGeometry(1.15, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2).translate(0, 2.35, -13.0), PAINT, PART.paintMetal);
  // 帯（補強の輪）
  for (const z of [-4.5, -9.9]) P.geo(new THREE.CylinderGeometry(1.17, 1.17, 0.12, 14, 1, true).rotateX(Math.PI / 2).translate(0, 2.35, z), 0x9aa0a6, PART.alu);
  P.box(W - 0.7, 0.3, 13.2, 0, 1.05, -7.2, TRIM, PART.trim, '+x-x');
  P.box(0.6, 0.12, 9, 0, 3.55, -7.2, 0x9aa0a6, PART.alu, '+x-x+y+z-z'); // 上の通路
  P.box(0.12, 0.85, 0.12, -0.8, 0.6, -2.0, TRIM, PART.trim, '+x-x+z-z'); P.box(0.12, 0.85, 0.12, 0.8, 0.6, -2.0, TRIM, PART.trim, '+x-x+z-z');
  for (const s of [-1, 1]) {
    for (const z of [-11.2, -12.4]) bigWheel(P, s * 1.2, z, 0.5, 0.5);
    P.box(0.3, 0.9, 0.06, s * 1.0, 1.0, -13.5, 0x2a2d31, PART.plain, '+y-z');
    P.quad([s * 0.85, 1.25, -13.54], [s * 1.15, 1.25, -13.54], [s * 1.15, 1.4, -13.54], [s * 0.85, 1.4, -13.54], TAIL, PART.tail, [0, 0, -1]);
  }
  return P.build();
}

// ゴミ収集車（パッカー車）：運転台、丸みのある荷箱（白）、後ろの投入口
export function garbageTruck() {
  const P = new Parts();
  const W = 2.3;
  cab(P, 3.7, 2.2, W, 0.62, 2.82, 1.6);
  P.box(W - 0.5, 0.36, 7.0, 0, 0.78, 0, TRIM, PART.trim, '+x-x+z-z');
  // 荷箱（上が丸い）を断面でつなぐ
  const box = [st(2.12, 1.0, 2.8, 3.15, 1.2, 1.0, 1.2), st(-2.62, 1.0, 2.8, 3.15, 1.2, 1.0, 1.2)];
  const R = box.map(ring);
  P.smooth = true;
  for (let s = 0; s < 7; s++) P.quad(R[0][s], R[0][s + 1], R[1][s + 1], R[1][s], 0xf2f2ee, PART.plain);
  P.poly([R[0][0], R[0][1], R[0][2], R[0][3], R[0][4], R[0][5], R[0][6], R[0][7]], 0xf2f2ee, PART.plain, [0, 0, 1]);
  P.smooth = false;
  // 帯（会社の色）
  for (const s of [-1, 1]) P.quad([s * 1.215, 1.4, -2.6], [s * 1.215, 1.4, 2.1], [s * 1.215, 1.8, 2.1], [s * 1.215, 1.8, -2.6], PAINT, PART.paint, [s, 0, 0]);
  // 後ろの投入口（灰色、斜め）
  const sh: [number, number][] = [[-3.65, 0.95], [-2.62, 0.95], [-2.62, 3.0], [-3.1, 2.9], [-3.7, 1.9]];
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(sh.map(([z, y]) => new THREE.Vector2(z, y))), { depth: W - 0.05, bevelEnabled: false, curveSegments: 1 });
  g.rotateY(-Math.PI / 2).translate((W - 0.05) / 2, 0, 0);
  P.geo(g, 0xb9bcc0, PART.alu);
  P.box(W - 0.5, 0.6, 0.06, 0, 1.45, -3.69, 0x3a3d42, PART.plain, '-z');
  for (const s of [-1, 1]) {
    P.box(0.08, 2.0, 0.08, s * (W / 2 - 0.1), 2.0, -3.3, 0xf0a020, PART.plain, '+x-x+y+z-z'); // 黄色の手すり
    P.quad([s * 0.7, 0.62, -3.72], [s * 1.05, 0.62, -3.72], [s * 1.05, 0.82, -3.72], [s * 0.7, 0.82, -3.72], TAIL, PART.tail, [0, 0, -1]);
  }
  P.box(0.5, 0.16, 0.28, 0, 2.9, 3.0, AMBER, PART.sign, '+x-x+y+z-z'); // 回転灯
  for (const s of [-1, 1]) {
    P.disc(s, s * (W / 2 + 0.004), 0.48, 2.95, 0.56, 8, TRIM, PART.trim, 0, Math.PI);
    P.disc(s, s * (W / 2 + 0.014), 0.48, 2.95, 0.48, 8, TIRE, PART.tire);
    P.disc(s, s * (W / 2 + 0.024), 0.48, 2.95, 0.29, 8, RIM, PART.rim);
    bigWheel(P, s * 1.18, -1.9, 0.48, 0.5);
  }
  return P.build();
}

// ---------------- 歩く人 ----------------
// 脚・胴・腕・頭（60 三角形以下）。aLimb = [振る向きと大きさ, 振る中心の高さ]
export function person() {
  const parts: { g: THREE.BufferGeometry; limb: [number, number] }[] = [];
  const prism = (w0: number, d0: number, w1: number, d1: number, y0: number, y1: number, x: number, z: number, hex: number, part: Part, top: boolean, limb: [number, number]) => {
    const Q = new Parts();
    const p = (s: number, t: number, y: number, w: number, d: number): V => [x + (s * w) / 2, y, z + (t * d) / 2];
    const c0 = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    for (let i = 0; i < 4; i++) {
      const [sa, ta] = c0[i], [sb, tb] = c0[(i + 1) % 4];
      Q.quad(p(sa, ta, y0, w0, d0), p(sb, tb, y0, w0, d0), p(sb, tb, y1, w1, d1), p(sa, ta, y1, w1, d1), hex, part, [(sa + sb) / 2, 0, (ta + tb) / 2]);
    }
    if (top) Q.quad(p(-1, -1, y1, w1, d1), p(1, -1, y1, w1, d1), p(1, 1, y1, w1, d1), p(-1, 1, y1, w1, d1), hex, part, [0, 1, 0]);
    parts.push({ g: Q.build(), limb });
  };
  // 脚（ズボン）、胴（服＝インスタンスの色）、腕（服）、首から上（肌）、髪
  prism(0.13, 0.15, 0.15, 0.17, 0.0, 0.86, 0.09, 0, 0x333333, PART.pants, false, [1, 0.86]);
  prism(0.13, 0.15, 0.15, 0.17, 0.0, 0.86, -0.09, 0, 0x333333, PART.pants, false, [-1, 0.86]);
  prism(0.34, 0.2, 0.4, 0.22, 0.82, 1.43, 0, 0, PAINT, PART.cloth, true, [0, 0]);
  prism(0.08, 0.09, 0.1, 0.11, 0.78, 1.42, 0.25, 0, PAINT, PART.cloth, false, [-0.7, 1.38]);
  prism(0.08, 0.09, 0.1, 0.11, 0.78, 1.42, -0.25, 0, PAINT, PART.cloth, false, [0.7, 1.38]);
  // 頭：前と横は肌、上と後ろは髪
  const H = new Parts();
  const hy0 = 1.43, hy1 = 1.7, hw = 0.1, hd = 0.11;
  H.quad([-hw, hy0, hd], [hw, hy0, hd], [hw, hy1, hd], [-hw, hy1, hd], 0xffffff, PART.skin, [0, 0, 1]);
  H.quad([-hw, hy0, -hd], [hw, hy0, -hd], [hw, hy1, -hd], [-hw, hy1, -hd], 0xffffff, PART.hair, [0, 0, -1]);
  for (const s of [-1, 1]) {
    H.quad([s * hw, hy0, -hd], [s * hw, hy0, hd], [s * hw, hy1, hd], [s * hw, hy1, -hd], 0xffffff, PART.skin, [s, 0, 0]);
  }
  H.quad([-hw, hy1, -hd], [hw, hy1, -hd], [hw, hy1, hd], [-hw, hy1, hd], 0xffffff, PART.hair, [0, 1, 0]);
  parts.push({ g: H.build(), limb: [0, 0] });
  for (const p of parts) {
    const n = p.g.getAttribute('position').count;
    const a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) a.set(p.limb, i * 2);
    p.g.setAttribute('aLimb', new THREE.BufferAttribute(a, 2));
  }
  return mergeGeometries(parts.map((p) => p.g))!;
}

// ---------------- 列車の車両 ----------------
// kind：rail（鉄道）、erail（高架鉄道）、sub（地下鉄）、mono（モノレール）。head = 運転台つき（前が +z）
export const TRAIN_SPEC = {
  rail: { L: 18, gap: 0.8, cars: 5, stripe: 0x2e9e5b, stripe2: 0xf08a24 },
  // 高架鉄道は短めの車両の4両編成（全体の長さは 18m の3両と同じ 55.6m。カーブで車体が線路からはみ出しにくい）
  erail: { L: 13.3, gap: 0.8, cars: 4, stripe: 0x1f6fd0, stripe2: 0x9ad0ff },
  sub: { L: 17, gap: 0.8, cars: 5, stripe: 0xd23a3a, stripe2: 0xf2f2f2 },
  mono: { L: 13, gap: 0.6, cars: 4, stripe: 0x1aa38a, stripe2: 0x0f6f60 },
} as const;
export type TrainKind = keyof typeof TRAIN_SPEC;
// 台車（前後の車輪）の位置：車体の中心から、車体の半分の長さのこの割合だけ前後
export const BOGIE = 0.7;

type P2 = [number, number];
// 横から見た輪郭（[前後, 高さ]）を、幅 w に押し出す
function side(pts: P2[], w: number, color: number, part?: Part) {
  const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: false, curveSegments: 1 });
  g.rotateY(-Math.PI / 2);
  g.translate(w / 2, 0, 0);
  return vc(g, color, part);
}
const box = (w: number, h: number, l: number, x: number, y: number, z: number, color: number, part?: Part) => vc(new THREE.BoxGeometry(w, h, l).translate(x, y, z), color, part);

export function trainCar(kind: TrainKind, head: boolean) {
  const S = TRAIN_SPEC[kind];
  const L = S.L, hl = L / 2;
  const mono = kind === 'mono';
  const W = mono ? 2.7 : 2.9;
  const y0 = mono ? -0.5 : 0.95, y1 = mono ? 2.9 : 4.0; // 車体の下と上
  // 高架鉄道は通勤電車：ステンレスの銀色の車体に色の帯、片側3ドア、平らな前面
  const commuter = kind === 'erail';
  const BODY = mono ? 0xf2f4f6 : commuter ? 0xc9ced3 : 0xe4e7ea;
  const bodyPart = commuter ? PART.alu : PART.plain;
  const parts: THREE.BufferGeometry[] = [];
  // 車体（横から見た輪郭）。先頭車は前が斜め、モノレールは丸みのある前
  const front: P2[] = head
    ? mono
      ? [[hl - 2.6, y0], [hl - 0.6, y0 + 0.4], [hl, y0 + 1.4], [hl - 0.3, y1 - 0.8], [hl - 1.6, y1]]
      : commuter
        ? [[hl, y0], [hl, y1 - 0.35], [hl - 0.35, y1]]
        : [[hl - 0.2, y0], [hl, y0 + 0.7], [hl, y0 + 1.6], [hl - 1.4, y1 - 0.15], [hl - 1.8, y1]]
    : [[hl, y0], [hl, y1]];
  parts.push(side([[-hl, y0], ...front, [-hl, y1]], W, BODY, bodyPart));
  // 屋根のまるみ（少し細い板を重ねる）
  parts.push(box(W - 0.5, 0.22, (head ? L - 2.2 : L) - 0.3, 0, y1 + 0.08, head ? -1.0 : 0, 0xd2d6da));
  // 窓の帯（両側）と、色の帯
  const winY = mono ? 1.25 : 2.55, winH = mono ? 0.95 : 1.05;
  const wl = head ? L - 3.6 : L - 1.2, wz = head ? -1.2 : 0;
  parts.push(box(W + 0.04, winH, wl, 0, winY, wz, WIN));
  parts.push(box(W + 0.05, 0.28, L - 0.4, 0, winY - winH / 2 - 0.25, 0, S.stripe));
  parts.push(box(W + 0.05, 0.12, L - 0.4, 0, winY - winH / 2 - 0.5, 0, S.stripe2));
  // ドア（片側 2〜3 か所、暗い色）。通勤電車は車体の長さに合わせて等間隔に3か所
  const doors = mono ? [-3.5, 2.0] : commuter ? [-0.65 * hl, 0, 0.65 * hl] : [-6.0, -1.5, 3.0];
  for (const z of doors) {
    const dz = z + (head && !commuter ? -0.8 : head ? -0.6 : 0);
    if (commuter) {
      // 両開きのドア（銀色）と、ドアの窓
      parts.push(box(W + 0.07, 2.0, 1.3, 0, 2.1, dz, 0xb2b8be, PART.alu));
      parts.push(box(W + 0.09, 0.9, 0.9, 0, 2.55, dz, WIN));
    } else parts.push(box(W + 0.07, mono ? 1.7 : 2.0, 1.2, 0, (mono ? 1.0 : 2.1), dz, 0xb4babf, PART.alu));
  }
  if (head) {
    // 前面のガラスとライト
    const gz = mono ? hl - 0.9 : hl - 0.75;
    parts.push(side(mono ? [[hl - 1.0, y0 + 1.4], [hl - 0.25, y0 + 1.5], [hl - 0.55, y1 - 0.85], [hl - 1.5, y1 - 0.2]] : commuter ? [[hl - 0.05, y0 + 1.5], [hl + 0.04, y0 + 1.5], [hl + 0.04, y1 - 0.5], [hl - 0.05, y1 - 0.5]] : [[hl - 0.05, y0 + 1.7], [hl - 0.05, y0 + 1.75], [hl - 1.35, y1 - 0.2], [hl - 1.5, y1 - 0.25]], W - 0.3, GLASS));
    if (commuter) parts.push(box(W - 0.2, 0.5, 0.1, 0, y1 - 0.25, hl + 0.02, 0xff9a3a, PART.sign)); // 行き先表示
    parts.push(box(0.5, 0.2, 0.08, -W / 2 + 0.55, y0 + 0.75, gz + 0.7, HEAD), box(0.5, 0.2, 0.08, W / 2 - 0.55, y0 + 0.75, gz + 0.7, HEAD));
    parts.push(box(W - 0.6, 0.35, 0.1, 0, y0 + 0.35, hl - 0.1, S.stripe)); // 前の色の帯
  }
  if (mono) {
    // 軌道けたを包むスカート
    parts.push(box(W - 0.2, 0.9, L - 1.0, 0, -0.75, 0, 0x7d848b));
  } else {
    // 台車と床下の機器（通勤電車の台車は、線路に沿って並べるときの台車の位置に合わせる）
    const bz = commuter ? hl * BOGIE : hl - 3.2;
    for (const z of [bz, -bz]) parts.push(box(2.3, 0.75, 2.8, 0, 0.55, z, 0x2a2d31));
    parts.push(box(2.2, 0.45, commuter ? 2 * bz - 4.4 : L - 9, 0, 0.75, 0, 0x3a3d42));
    // 通勤電車は、運転台のある車両にはパンタグラフを載せない（中間の電動車だけ）
    if (kind !== 'sub' && !(commuter && head)) {
      // パンタグラフ（低い台と、細い枠）
      const pz = head ? -3.5 : 2.5, py = y1 + 0.2;
      parts.push(box(1.0, 0.14, 0.7, 0, py, pz, 0x5a5f66));
      parts.push(box(0.06, 0.06, 1.0, 0, py + 0.45, pz, 0x30343a));
      parts.push(box(1.1, 0.06, 0.08, 0, py + 0.75, pz, 0x30343a));
    }
  }
  return mergeGeometries(parts)!;
}
