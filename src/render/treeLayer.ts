// 木（インスタンス描画）
// 葉の房をいくつも重ねた形（球の集まりの外側だけを1枚の面にする）、幹と枝、樹種の違い、風のゆれ。
// 近く（カメラのまわりだけ）はくわしい形、ふつうは中くらい、遠くは簡単な形にして軽くする
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import { ROADS, RoadType } from '../sim/defs';
import { hash2 } from '../sim/rng';
import { shared, AMB_IRR_GLSL, AMB_IRR_PARS, ambUniforms } from './materials';
import type { TreeSpot } from './buildingGen';
import { GARDEN_LIGHT_PARS, gardenUniforms } from './gardenLight';

const MAX_TREES = 64000;

type V3 = [number, number, number];

// 形を組み立てる（頂点を共有する）。aLeaf = 1 は葉、0 は幹と枝
class GeoB {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  l: number[] = [];
  i: number[] = [];
  uv: number[] = [];
  v(p: V3, n: V3, c: V3, leaf: number, uv?: [number, number]) {
    const k = Math.hypot(n[0], n[1], n[2]) || 1;
    if (uv) this.uv.push(uv[0], uv[1]);
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0] / k, n[1] / k, n[2] / k);
    this.c.push(c[0], c[1], c[2]);
    this.l.push(leaf);
    return this.p.length / 3 - 1;
  }
  // 面の向きは頂点の法線にそろえる
  t(a: number, b: number, c: number) {
    const P = this.p, N = this.n;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const sx = N[a * 3] + N[b * 3] + N[c * 3], sy = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], sz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (fx * sx + fy * sy + fz * sz < 0) this.i.push(a, c, b);
    else this.i.push(a, b, c);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(this.l, 1));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

// 決まった並びの乱数（形を作るときだけ使う）
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 幹や枝：折れ線にそって、先が細くなる筒を作る（両端はふさがない）
function tube(gb: GeoB, pts: V3[], rad: number[], sides: number, col: (t: number) => V3) {
  const a = pts[0], b = pts[pts.length - 1];
  const dir: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ref: V3 = Math.abs(dir[1]) / Math.hypot(...dir) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const rings: number[][] = [];
  for (let k = 0; k < pts.length; k++) {
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[Math.min(pts.length - 1, k + 1)];
    const T = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).normalize();
    const B = new THREE.Vector3(...ref).cross(T).normalize();
    const Nn = new THREE.Vector3().crossVectors(T, B).normalize();
    const ring: number[] = [];
    const c = col(k / (pts.length - 1));
    for (let s = 0; s < sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      const nx = Math.cos(ang) * Nn.x + Math.sin(ang) * B.x, ny = Math.cos(ang) * Nn.y + Math.sin(ang) * B.y, nz = Math.cos(ang) * Nn.z + Math.sin(ang) * B.z;
      ring.push(gb.v([pts[k][0] + nx * rad[k], pts[k][1] + ny * rad[k], pts[k][2] + nz * rad[k]], [nx, ny, nz], c, 0));
    }
    rings.push(ring);
  }
  for (let k = 0; k + 1 < rings.length; k++)
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      gb.t(rings[k][s], rings[k][s1], rings[k + 1][s1]);
      gb.t(rings[k][s], rings[k + 1][s1], rings[k + 1][s]);
    }
}

// 葉の房（だ円体）。tint は房ごとの色の違い
interface Lump { c: V3; r: number; ey: number; tint: V3 }

// 光線と房（だ円体）の交わり：遠い側の距離（なければ -1）
function lumpHit(o: THREE.Vector3, d: THREE.Vector3, L: Lump, far: boolean) {
  const ox = o.x - L.c[0], oy = (o.y - L.c[1]) / L.ey, oz = o.z - L.c[2];
  const dx = d.x, dy = d.y / L.ey, dz = d.z;
  const A = dx * dx + dy * dy + dz * dz, Bq = ox * dx + oy * dy + oz * dz, Cq = ox * ox + oy * oy + oz * oz - L.r * L.r;
  const D = Bq * Bq - A * Cq;
  if (D < 0) return -1;
  const s = Math.sqrt(D);
  return far ? (-Bq + s) / A : (-Bq - s) / A;
}

// 中心から方向 d に見た、房の集まりの外側までの距離
function surfaceAt(lumps: Lump[], center: THREE.Vector3, d: THREE.Vector3) {
  let best = 0.4;
  for (const L of lumps) best = Math.max(best, lumpHit(center, d, L, true));
  return best;
}

// 葉の房の板（透かしの絵を貼る）：形のまわりに散らして、輪郭を葉らしくぎざぎざにする
function leafCards(lumps: Lump[], C: V3, count: number, yBot: number, yTop: number) {
  const gb = new GeoB();
  const r = rng(29);
  const center = new THREE.Vector3(...C);
  const d = new THREE.Vector3(), cn = new THREE.Vector3(), tx = new THREE.Vector3(), ty = new THREE.Vector3(), P = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    // 先頭の何枚かだけ描いても全体に散らばるよう、順番を飛ばして置く。上と横に多く、真下には置かない
    const k = (i * 29) % count;
    const y = 1 - ((k + 0.5) / count) * 1.45, rr = Math.sqrt(Math.max(0, 1 - y * y)), a = k * 2.39996 + r() * 0.4;
    d.set(Math.cos(a) * rr, y, Math.sin(a) * rr).normalize();
    const t = surfaceAt(lumps, center, d) * (0.9 + r() * 0.12);
    P.copy(center).addScaledVector(d, t);
    cn.set(d.x + (r() - 0.5) * 1.1, d.y + (r() - 0.5) * 1.1, d.z + (r() - 0.5) * 1.1).normalize();
    tx.set(0, 1, 0).cross(cn);
    if (tx.lengthSq() < 1e-4) tx.set(1, 0, 0);
    tx.normalize();
    ty.crossVectors(cn, tx).normalize();
    const rot = r() * 6.28, c = Math.cos(rot), sn = Math.sin(rot);
    const ax = tx.clone().multiplyScalar(c).addScaledVector(ty, sn), ay = tx.clone().multiplyScalar(-sn).addScaledVector(ty, c);
    const h = 0.8 + r() * 0.32;
    const hgt = Math.max(0, Math.min(1, (P.y - yBot) / (yTop - yBot)));
    const ao = (0.55 + 0.5 * Math.pow(hgt, 0.8)) * (0.88 + 0.14 * d.y);
    const tint = 0.92 + r() * 0.16;
    const col: V3 = [ao * tint * 1.03, ao * tint, ao * tint * 0.95];
    // 明るさは形の外向きで決める（板の向きでばらばらにならないよう）
    const nn: V3 = [d.x * 0.8 + cn.x * 0.2, d.y * 0.8 + cn.y * 0.2, d.z * 0.8 + cn.z * 0.2];
    const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) =>
      gb.v([P.x + (ax.x * u + ay.x * v) * h, P.y + (ax.y * u + ay.y * v) * h, P.z + (ax.z * u + ay.z * v) * h], nn, col, 1, [(u + 1) / 4, (v + 1) / 2]),
    );
    gb.i.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  }
  return gb.build();
}

// 葉の板の絵（白黒。色は木ごとの色をかける）。左半分=小さな葉をたくさん描いた丸い房、右半分=針葉樹の小枝
let leafCardTex: THREE.Texture | null = null;
function leafCardTexture() {
  if (leafCardTex) return leafCardTex;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S * 2;
  cv.height = S;
  const ctx = cv.getContext('2d')!;
  const r = rng(5);
  for (let k = 0; k < 90; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * S * 0.36;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
    const len = S * (0.05 + r() * 0.035), wid = len * 0.48;
    const v = Math.round(140 + r() * 115);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + (r() - 0.5) * 1.4);
    ctx.beginPath();
    ctx.ellipse(len * 0.5, 0, len, wid, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // 小枝：下の真ん中から外へ広がる枝に、短い葉を両側に
  ctx.lineCap = 'round';
  for (let b = 0; b < 7; b++) {
    const a = -Math.PI / 2 + (b / 6 - 0.5) * 1.5 + (r() - 0.5) * 0.15;
    const L = S * (0.62 + r() * 0.3) * (1 - Math.abs(b / 6 - 0.5) * 0.5);
    const x0 = S * 1.5, y0 = S * 0.98;
    for (let k = 2; k < 16; k++) {
      const t = k / 16, px = x0 + Math.cos(a) * L * t, py = y0 + Math.sin(a) * L * t;
      const nl = S * 0.1 * (1 - t * 0.5);
      for (const sd of [-1, 1]) {
        const na = a + sd * 1.0;
        const v = Math.round(150 + r() * 105);
        ctx.strokeStyle = `rgb(${v},${v},${v})`;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
        ctx.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 2;
  leafCardTex = t;
  return t;
}

// 針葉樹の段のふちに、小枝の板を並べる（上から見ると、ふちが細かくぎざぎざになる）
function needleCards() {
  const gb = new GeoB();
  const r = rng(37);
  const tiers = 6;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const base = 1.15 + t * 6.0, h = 2.9 - t * 0.9, R = 2.3 * (1 - 0.72 * Math.pow(t, 0.9));
    const apexY = base + h;
    const shade = 0.62 + 0.38 * t;
    const n = Math.max(4, Math.round(9 * (1 - 0.5 * t)));
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + r() * 0.5;
      const ca = Math.cos(a), sa = Math.sin(a);
      // 板の向き：横（円周の向き）と、斜面にそって外へ
      const tu: V3 = [-sa, 0, ca];
      const sl = Math.hypot(R, h);
      const tv: V3 = [(ca * R) / sl, -h / sl - 0.1, (sa * R) / sl];
      const nn: V3 = [ca * h, R * 1.4, sa * h];
      const rho = R * (0.72 + r() * 0.12);
      const cy = apexY - h * (rho / R);
      const len = (0.9 + r() * 0.3) * Math.max(0.55, R / 2.3) + 0.25, wid = len * 0.62;
      const col: V3 = [shade * 1.05, shade * 1.08, shade * 0.95];
      const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) =>
        gb.v([ca * rho + tu[0] * u * wid + tv[0] * v * len, cy + tu[1] * u * wid + tv[1] * v * len, sa * rho + tu[2] * u * wid + tv[2] * v * len], nn, col, 1, [0.5 + (u + 1) / 4, (v + 1) / 2]),
      );
      gb.i.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }
  }
  return gb.build();
}

// 房の集まりの外側を、中心から見た方向ごとに求めて1枚の面にする（中に隠れる面を作らない）
function canopy(gb: GeoB, lumps: Lump[], C: V3, detail: number, yBot: number, yTop: number, jitter = 0.16, shrink = 1, dark = 1) {
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('uv');
  ico.deleteAttribute('normal');
  const g = mergeVertices(ico, 1e-4);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  // 陰の計算に使う方向（半球に散らす）
  const dirs: THREE.Vector3[] = [];
  for (let k = 0; k < 24; k++) {
    const y = 1 - (k + 0.5) / 12, r = Math.sqrt(Math.max(0, 1 - y * y)), a = k * 2.39996;
    dirs.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  const hit = lumpHit;
  const center = new THREE.Vector3(...C);
  const idx: number[] = [];
  const P = new THREE.Vector3(), d = new THREE.Vector3(), nrm = new THREE.Vector3(), o = new THREE.Vector3(), rd = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    let best = 0.4, who = 0;
    lumps.forEach((L, k) => {
      const t = hit(center, d, L, true);
      if (t > best) { best = t; who = k; }
    });
    const L = lumps[who];
    const jit = 1 + (hash2(Math.round(d.x * 1000), Math.round(d.y * 1000) * 7 + Math.round(d.z * 1000) * 13, 5) - 0.5) * jitter;
    P.copy(center).addScaledVector(d, best * jit * shrink);
    // 房の面の向き（だ円体の法線）を少し丸める
    nrm.set(P.x - L.c[0], (P.y - L.c[1]) / (L.ey * L.ey), P.z - L.c[2]).normalize().multiplyScalar(0.85).addScaledVector(d, 0.15).normalize();
    // まわりの房にどれだけふさがれているか（くぼみは暗く）
    let occ = 0, tot = 0;
    o.copy(P).addScaledVector(nrm, 0.05);
    for (const dd of dirs) {
      rd.copy(dd);
      const cos = rd.dot(nrm);
      if (cos < 0.15) continue;
      tot += cos;
      for (let k = 0; k < lumps.length; k++) {
        if (k === who) continue;
        if (hit(o, rd, lumps[k], true) > 0.02) { occ += cos; break; }
      }
    }
    const crev = 1 - 0.55 * (tot > 0 ? occ / tot : 0);
    const hgt = Math.max(0, Math.min(1, (P.y - yBot) / (yTop - yBot)));
    // 下側と内側は暗く（木の中の影）、上は明るい
    const ao = crev * (0.5 + 0.5 * Math.pow(hgt, 0.8)) * (0.86 + 0.14 * nrm.y) * dark;
    idx.push(gb.v([P.x, P.y, P.z], [nrm.x, nrm.y, nrm.z], [L.tint[0] * ao, L.tint[1] * ao, L.tint[2] * ao], 1));
  }
  const ix = g.getIndex()!;
  for (let k = 0; k < ix.count; k += 3) gb.t(idx[ix.getX(k)], idx[ix.getX(k + 1)], idx[ix.getX(k + 2)]);
}

const BARK: V3 = [0.15, 0.115, 0.085]; // 樹皮（線形の色）
const bark = (k: number): V3 => [BARK[0] * k, BARK[1] * k, BARK[2] * k];

// 広葉樹の房の並び（どの細かさでも同じ形）
function broadleafLumps(): Lump[] {
  const r = rng(7);
  const tint = (): V3 => {
    const v = 0.88 + r() * 0.24, y = r() - 0.5;
    return [v * (1 + y * 0.14), v * (1 + y * 0.04), v * (1 - y * 0.22)];
  };
  const L: Lump[] = [{ c: [0, 5.0, 0], r: 1.9, ey: 0.88, tint: [1, 1, 1] }];
  // まわりの房（高さを少しずつ変える）
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + (r() - 0.5) * 0.5, rr = 1.45 + r() * 0.4;
    L.push({ c: [Math.cos(a) * rr, 4.5 + (r() - 0.5) * 1.1, Math.sin(a) * rr], r: 0.95 + r() * 0.32, ey: 0.86, tint: tint() });
  }
  // てっぺんの房
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.6 + (r() - 0.5) * 0.6, rr = 0.7 + r() * 0.45;
    L.push({ c: [Math.cos(a) * rr, 5.95 + r() * 0.55, Math.sin(a) * rr], r: 0.92 + r() * 0.22, ey: 0.9, tint: tint() });
  }
  // 下に垂れた房
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.9 + (r() - 0.5) * 0.4, rr = 1.55 + r() * 0.2;
    L.push({ c: [Math.cos(a) * rr, 3.65 + r() * 0.3, Math.sin(a) * rr], r: 0.82 + r() * 0.12, ey: 0.8, tint: tint() });
  }
  return L;
}

// 広葉樹。lod: 0=近く（枝あり）, 1=ふつう, 2=遠く
function broadleafGeo(lod: number) {
  const gb = new GeoB();
  const lumps = broadleafLumps();
  // 近くは、少し小さく暗い芯のまわりを葉の房の板でおおう
  canopy(gb, lumps, [0, 4.9, 0], lod === 0 ? 3 : lod === 1 ? 1 : 0, 2.8, 7.4, 0.16, lod === 0 ? 0.9 : 1, lod === 0 ? 0.85 : 1);
  if (lod === 0) {
    // 根元が少し広がり、少し曲がった幹
    tube(gb, [[0, -0.5, 0], [0, 0.15, 0], [0.06, 1.3, 0.03], [0.12, 2.5, -0.02], [0.08, 3.6, 0]], [0.36, 0.3, 0.24, 0.2, 0.15], 7, (t) => bark(1 - 0.45 * t));
    // 太い枝：分かれ目から房の中へ
    const fork: V3 = [0.12, 2.5, -0.02];
    lumps.slice(1, 8).forEach((L, k) => {
      if (k % 2 === 1) return;
      const end: V3 = [L.c[0] * 0.85, L.c[1] - 0.2, L.c[2] * 0.85];
      const mid: V3 = [fork[0] + (end[0] - fork[0]) * 0.45, fork[1] + (end[1] - fork[1]) * 0.3 + 0.25, fork[2] + (end[2] - fork[2]) * 0.45];
      tube(gb, [fork, mid, end], [0.13, 0.09, 0.05], 5, (t) => bark(0.62 - 0.22 * t));
    });
    // 分かれ目より下から出る細い枝
    const lo = lumps[lumps.length - 1];
    tube(gb, [[0.04, 1.9, 0.02], [lo.c[0] * 0.5, 2.7, lo.c[2] * 0.5], [lo.c[0] * 0.85, lo.c[1], lo.c[2] * 0.85]], [0.08, 0.055, 0.035], 4, (t) => bark(0.7 - 0.2 * t));
  } else if (lod === 1) {
    tube(gb, [[0, -0.5, 0], [0.06, 3.4, 0]], [0.32, 0.17], 5, (t) => bark(1 - 0.45 * t));
  } else {
    tube(gb, [[0, -0.5, 0], [0.05, 3.2, 0]], [0.32, 0.17], 3, (t) => bark(0.95 - 0.4 * t));
  }
  return gb.build();
}

// 針葉樹（トウヒ・モミ）：段になった枝葉。ふちはぎざぎざ、下側は暗い。
// 近く（lod 0）は段ごとに中ほどの輪を外へふくらませて、平らな三角の板に見えないようにする
function coniferGeo(lod: number) {
  const gb = new GeoB();
  // 近くの段の数は、ふちに並べる小枝の板（needleCards）とそろえる
  const tiers = lod === 0 ? 6 : lod === 1 ? 4 : 2;
  const seg = lod === 0 ? 13 : lod === 1 ? 8 : 6;
  const r = rng(11);
  for (let k = 0; k < tiers; k++) {
    const t = k / Math.max(1, tiers - 1);
    const base = 1.15 + t * (lod === 2 ? 3.6 : 6.0);
    const h = (lod === 2 ? 4.4 : 2.9) - t * (lod === 2 ? 1.2 : 0.9);
    const R = 2.3 * (1 - 0.72 * Math.pow(t, 0.9)) * (lod === 2 ? 1.05 : 1);
    const apexY = base + h;
    const shade = 0.62 + 0.38 * t; // 下の段ほど暗い
    const apexIn: number[] = [], rim: number[] = [], mid: number[] = [];
    const rot = r() * 6.28;
    for (let s = 0; s < seg; s++) {
      const a = rot + (s / seg) * Math.PI * 2;
      const rr = R * (s % 2 ? 0.8 : 1) * (0.94 + r() * 0.12);
      const cx = Math.cos(a), cz = Math.sin(a);
      const droop = (s % 2 ? 0.12 : -0.08) * h;
      const ry = base + droop;
      // 横の面（法線は外向き・上向き）
      const n: V3 = [cx * h, rr * 0.9, cz * h];
      rim.push(gb.v([cx * rr, ry, cz * rr], n, [shade * 1.05, shade * 1.07, shade * 0.92], 1));
      const inS = lod === 2 ? 0.85 : 0.6;
      if (lod === 0) {
        // 中ほどの輪：外へふくらませ、法線は横向きに（丸みのある段に見える）
        const mr = rr * 0.5 * 1.18, my = ry + (apexY - ry) * 0.5;
        const ms = shade * 0.85;
        mid.push(gb.v([cx * mr, my, cz * mr], [cx * h * 1.25, rr * 0.75, cz * h * 1.25], [ms * 1.04, ms * 1.06, ms * 0.93], 1));
      }
      apexIn.push(gb.v([0, apexY, 0], n, [shade * inS, shade * inS * 1.03, shade * inS], 1));
    }
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      if (lod === 0) {
        gb.t(mid[s], rim[s], rim[s1]);
        gb.t(mid[s], rim[s1], mid[s1]);
        gb.t(apexIn[s], mid[s], mid[s1]);
      } else gb.t(apexIn[s], rim[s], rim[s1]);
    }
    if (lod < 2) {
      // 下側（枝の裏）：ふちから幹へ
      const inner = gb.v([0, base + h * 0.32, 0], [0, -1, 0], [0.22, 0.22, 0.2], 1);
      const under: number[] = [];
      for (let s = 0; s < seg; s++) {
        const pi = rim[s] * 3;
        const px = gb.p[pi], py = gb.p[pi + 1], pz = gb.p[pi + 2];
        const len = Math.hypot(px, pz) || 1;
        under.push(gb.v([px, py, pz], [px / len * 0.4, -1, pz / len * 0.4], [shade * 0.4, shade * 0.42, shade * 0.38], 1));
      }
      for (let s = 0; s < seg; s++) gb.t(inner, under[(s + 1) % seg], under[s]);
    }
  }
  // 幹（下の段の下から見える）
  const sides = lod === 0 ? 6 : lod === 1 ? 4 : 3;
  if (lod === 0) tube(gb, [[0, -0.5, 0], [0, 0.2, 0], [0, 1.6, 0], [0, 4.5, 0]], [0.3, 0.24, 0.19, 0.1], sides, (t) => bark(0.95 - 0.5 * t));
  else tube(gb, [[0, -0.5, 0], [0, 2.4, 0]], [0.26, 0.15], sides, (t) => bark(0.9 - 0.4 * t));
  return gb.build();
}

// 葉の細かい凹凸に使う、くり返しのある 3D の模様（房のような丸いでこぼこ）。
// a = 高さ、rgb = その傾き（面の向きを変えるのに使う）
let leafTex: THREE.Data3DTexture | null = null;
function leafTexture() {
  if (leafTex) return leafTex;
  const S = 32, G = 8, cs = S / G;
  const r = rng(91);
  const fp = new Float32Array(G * G * G * 3);
  for (let i = 0; i < fp.length; i++) fp[i] = r();
  const val = new Float32Array(S * S * S);
  for (let z = 0; z < S; z++)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const px = (x + 0.5) / cs, py = (y + 0.5) / cs, pz = (z + 0.5) / cs;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        let f1 = 9, f2 = 9;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const cx = ix + dx, cy = iy + dy, cz = iz + dz;
              const wx = (cx + G) % G, wy = (cy + G) % G, wz = (cz + G) % G;
              const k = ((wz * G + wy) * G + wx) * 3;
              const qx = cx + fp[k] - px, qy = cy + fp[k + 1] - py, qz = cz + fp[k + 2] - pz;
              const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
              if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
            }
        // 房の中ほど明るく、すき間は暗い
        val[(z * S + y) * S + x] = Math.max(0, Math.min(1, 1.15 - f1 * 1.1 + (f2 - f1) * 0.35));
      }
  const at = (x: number, y: number, z: number) => val[(((z + S) % S) * S + ((y + S) % S)) * S + ((x + S) % S)];
  const grad = new Float32Array(S * S * S * 3);
  let gmax = 1e-6;
  for (let z = 0; z < S; z++)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = ((z * S + y) * S + x) * 3;
        grad[i] = at(x + 1, y, z) - at(x - 1, y, z);
        grad[i + 1] = at(x, y + 1, z) - at(x, y - 1, z);
        grad[i + 2] = at(x, y, z + 1) - at(x, y, z - 1);
        gmax = Math.max(gmax, Math.abs(grad[i]), Math.abs(grad[i + 1]), Math.abs(grad[i + 2]));
      }
  const data = new Uint8Array(S * S * S * 4);
  for (let i = 0; i < S * S * S; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round((grad[i * 3 + c] / gmax) * 127.5 + 127.5);
    data[i * 4 + 3] = Math.round(val[i] * 255);
  }
  const t = new THREE.Data3DTexture(data, S, S, S);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  leafTex = t;
  return t;
}

// みんなで使う値
const U = {
  uWindT: { value: 0 },
  uRing: { value: new THREE.Vector3(0, 0, -1) }, // 近くの木の中心 (x, z) と半径の2乗（くわしい形に置きかえる範囲）
  uFarS: { value: 1 },
  uRingD: { value: new THREE.Vector3(0, 0, -1) }, // 影を作るときに消す範囲（高画質のときだけ、近くの木が自分で影を作る）
};

// 広葉樹の枝下の高さを木ごとに変える（細長い木は地面近くから葉をつける）。形の高さ 0..7.4 のうち 2.8 が枝下
const MORPH = /* glsl */ `
  {
    vec3 c0 = instanceMatrix[0].xyz, c1 = instanceMatrix[1].xyz;
    float colum = smoothstep(1.7, 2.2, length(c1) / length(c0));
    float hb = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    float nb = mix(mix(2.0, 3.0, hb), 0.9, colum);
    float y = transformed.y;
    transformed.y = y < 2.8 ? y * (nb / 2.8) : nb + (y - 2.8) * ((7.4 - nb) / 4.6);
  }
`;

// 風のゆれ（世界の向きで決めて、木の座標に直す）。上ほど大きく、葉は細かくそよぐ
const WIND = /* glsl */ `
  {
    vec3 io = instanceMatrix[3].xyz;
    float hh = max(position.y, 0.0);
    float bend = hh * hh * 0.0024;
    float ph = dot(io.xz, vec2(0.043, 0.031));
    float s = sin(uWindT * 1.25 + ph) * 0.7 + sin(uWindT * 2.05 + ph * 1.7) * 0.3;
    vec3 w = vec3(0.8, 0.0, 0.6) * bend * (s + 0.5);
    w += aLeaf * 0.03 * vec3(sin(uWindT * 4.6 + dot(position, vec3(2.7, 1.9, 3.1))), 0.0, cos(uWindT * 4.1 + dot(position, vec3(2.3, 3.3, 1.7))));
    vec3 c0 = instanceMatrix[0].xyz, c1 = instanceMatrix[1].xyz, c2 = instanceMatrix[2].xyz;
    transformed += vec3(dot(w, c0) / dot(c0, c0), dot(w, c1) / dot(c1, c1), dot(w, c2) / dot(c2, c2));
  }
`;

// lod: 0=近く, 1=ふつう（近くの範囲は消す）, 2=遠く。conifer=針葉樹、cards=葉の房の板（透かし、両面）
function treeMaterial(lod: number, conifer: boolean, cards = false) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (cards) {
    m.map = leafCardTexture();
    m.alphaTest = 0.5;
    m.alphaToCoverage = true;
    m.side = THREE.DoubleSide;
  }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWindT = U.uWindT;
    sh.uniforms.uRing = U.uRing;
    sh.uniforms.uFarS = U.uFarS;
    sh.uniforms.uLeafTex = { value: leafTexture() };
    sh.uniforms.uSkyC = shared.uSkyHz;
    sh.uniforms.uNight = shared.uNight;
    ambUniforms(sh.uniforms);
    gardenUniforms(sh.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aLeaf;
        uniform float uWindT;
        uniform vec3 uRing;
        uniform float uFarS;
        varying float vLeaf;
        varying vec3 vLeafP;
        // 夜の庭の明かり（ライトアップ・灯籠・街灯）に照らされる量。頂点ごとに求める
        varying vec3 vGL;
        ${GARDEN_LIGHT_PARS}`,
      )
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
        vColor.rgb *= color;
        #ifdef USE_INSTANCING_COLOR
        // 葉だけに木ごとの色をかける（幹はそのまま）
        vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aLeaf);
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
        vLeaf = aLeaf;
        ${conifer ? '' : MORPH}
        // 模様の位置（世界の座標。ゆれる前の位置なので、模様は葉といっしょに動く）
        vLeafP = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        vGL = vec3(0.0);
        if (uGLn > 0) vGL = gardenLight(vLeafP, normalize(mat3(instanceMatrix) * objectNormal), 0.2 + 0.3 * aLeaf);
        ${lod < 2 ? WIND : ''}
        ${lod >= 1 ? '{ vec2 dd = instanceMatrix[3].xz - uRing.xy; if (dot(dd, dd) < uRing.z) transformed = vec3(0.0); }' : ''}
        ${lod === 2 ? 'transformed *= uFarS;' : ''}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vLeaf;
        varying vec3 vLeafP;
        varying vec3 vGL;
        uniform highp sampler3D uLeafTex;
        uniform vec3 uSkyC;
        uniform float uNight;
        ${AMB_IRR_PARS}
        float gSun = 1.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${
          cards
            ? `// 葉の板：明るさは絵の葉ごとの明るさで決める（3D の模様は使わず軽くする）
        float lf = clamp((sampledDiffuseColor.r - 0.5) * 2.0, 0.0, 1.0);
        vec3 lg = vec3(0.0);
        float bk = 0.5;`
            : lod === 0
            ? `// 葉の房の模様。針葉樹は細かめ
        vec3 lp = vLeafP * ${conifer ? '1.6' : '1.0'};
        vec4 n1 = texture(uLeafTex, lp * 0.19);
        // 細かい葉は近くでは葉の板で表し、ふつうの距離では見えないので、大きい房の模様だけ使う
        float lf = n1.a;
        vec3 lg = (n1.rgb - 0.5) * 0.9;
        // 樹皮は縦のすじ
        float bk = 0.5;
        if (vLeaf < 0.5) bk = texture(uLeafTex, vLeafP * vec3(1.6, 0.18, 1.6)).a;`
            : lod === 1
            ? `// 葉の房の模様。針葉樹は細かめ。遠く（約 300m より先）は模様が画素より小さいので読まない（軽くする）
        vec3 lp = vLeafP * ${conifer ? '0.304' : '0.19'};
        float near = 1.0 - smoothstep(240.0, 300.0, length(vViewPosition));
        vec3 ldx = dFdx(lp), ldy = dFdy(lp);
        float lf = 0.5;
        vec3 lg = vec3(0.0);
        float bk = 0.5;
        if (near > 0.0) {
          // 分岐の中なので、ミップマップの選び方は分岐の外で求めた変化量で決める
          vec4 n1 = textureGrad(uLeafTex, lp, ldx, ldy);
          lf = mix(0.5, n1.a, near);
          lg = (n1.rgb - 0.5) * 0.9 * near;
          // 樹皮は縦のすじ
          if (vLeaf < 0.5) {
            vec3 bp = vLeafP * vec3(1.6, 0.18, 1.6), bdx = dFdx(bp), bdy = dFdy(bp);
            bk = mix(0.5, textureGrad(uLeafTex, bp, bdx, bdy).a, near);
          }
        }`
            : 'float lf = 0.5; float bk = 0.5;'
        }
        // 房のすき間は奥が見えて暗い（近くの木は黒い穴に見えないよう浅めに。夜はさらに浅く）。日が当たる房は少し黄色っぽく
        float gap = mix(mix(${lod === 0 ? '0.65' : '0.5'}, 0.8, uNight), 1.0, smoothstep(0.1, 0.38, lf));
        vec3 leafC = (0.58 + 0.72 * lf) * gap * mix(vec3(0.93, 0.97, 1.08), vec3(1.06, 1.03, 0.9), lf);
        diffuseColor.rgb *= mix(vec3(0.75 + 0.5 * bk), leafC, vLeaf)${lod === 2 ? (conifer ? ' * 1.15' : '') : ''};
        gSun = mix(1.0, 0.4 + 1.2 * lf, vLeaf);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        lod < 2
          ? `#include <normal_fragment_maps>
        ${cards ? '// 板の裏も表と同じ明るさにする\n        normal *= faceDirection;' : ''}
        // 葉の房ごとに日なたと日かげができるよう、模様の傾きで面の向きを少し変える
        {
          vec3 gv = (viewMatrix * vec4(lg, 0.0)).xyz;
          normal = normalize(normal - ${conifer ? '0.9' : '1.3'} * vLeaf * (gv - dot(gv, normal) * normal));
        }`
          : '#include <normal_fragment_maps>',
      )
      .replace(
        '#include <lights_lambert_pars_fragment>',
        `varying vec3 vViewPosition;
        struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
        void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
          // 葉は光が回りこむので、かげの境目を少しやわらかく
          float w = ${lod === 2 ? '0.45' : '0.25'} * vLeaf;
          float dotNL = saturate( ( dot( geometryNormal, directLight.direction ) + w ) / ( 1.0 + w ) );
          reflectedLight.directDiffuse += dotNL * directLight.color * gSun * BRDF_Lambert( material.diffuseColor );
        }
        void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
          reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
        }
        #define RE_Direct RE_Direct_Lambert
        #define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert`,
      )
      // まわりからの光は式で（環境マップを読まない。値は同じ）
      .replace('#include <lights_fragment_maps>', AMB_IRR_GLSL)
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // ふちに空の色がうっすら乗る（空気感）。夜は月明かりの青白い色
        float rimF = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        reflectedLight.indirectDiffuse += max(uSkyC, vec3(0.05, 0.06, 0.09) * uNight) * diffuseColor.rgb * rimF * 0.7 * vLeaf;
        // 夜：街あかりや月明かりの照り返しで、木が真っ黒の固まりにならないように少し持ち上げる
        reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.07, 0.08, 0.11) * uNight;
        // 庭のライトアップや灯籠の明かり
        reflectedLight.directDiffuse += vGL * diffuseColor.rgb;`,
      );
  };
  m.customProgramCacheKey = () => 'tree2-' + lod + (conifer ? 'c' : 'b') + (cards ? 'L' : '');
  return m;
}

// 影を作るときも同じ形・同じだけゆらす。ring=近くの範囲を消す（区画の木用）、cards=葉の板（透かし）
function treeDepthMaterial(conifer: boolean, ring: boolean, cards = false) {
  const m = new THREE.MeshDepthMaterial();
  if (cards) {
    m.map = leafCardTexture();
    m.alphaTest = 0.5;
    m.side = THREE.DoubleSide;
  }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWindT = U.uWindT;
    sh.uniforms.uRingD = U.uRingD;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aLeaf;\nuniform float uWindT;\nuniform vec3 uRingD;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${conifer ? '' : MORPH}\n${WIND}\n${ring ? '{ vec2 dd = instanceMatrix[3].xz - uRingD.xy; if (dot(dd, dd) < uRingD.z) transformed = vec3(0.0); }' : ''}`,
      );
  };
  m.customProgramCacheKey = () => 'treeDepth' + (conifer ? 'c' : 'b') + (ring ? 'r' : '') + (cards ? 'L' : '');
  return m;
}

// 樹種：木ごとの形の伸び縮み（横, 縦, 横）
// 広葉樹: 0=丸い（ケヤキ・カエデ）, 1=たまご形（シナノキ）, 2=細長い（ポプラ・イチョウ）, 3=横に広い
// 針葉樹: 0=トウヒ・モミ, 1=細いイトスギ
const SHAPE: V3[][] = [
  [[1, 1, 1], [0.84, 1.18, 0.84], [0.56, 1.3, 0.56], [1.2, 0.86, 1.2]],
  [[1, 1, 1], [0.56, 1.1, 0.56]],
];
const hex = (h: number) => new THREE.Color(h);
// 夏の緑（少しずつ違う）、赤むらさきの葉（ベニバスモモ）、黄緑の葉（ニセアカシア 'フリーシア'）
const GREENS = [0x557a2c, 0x5f8434, 0x4a6e2a, 0x6a8c38, 0x587d36, 0x748f3a, 0x4f7034, 0x678a3c, 0x5c7a2e, 0x4b7330].map(hex);
const COPPER = [0x6a4a46, 0x5e4852].map(hex);
const GOLDEN = [0x8e9e44, 0x99a24c].map(hex);
const DARKS = [0x2f5532, 0x37603a, 0x2c4e34, 0x3a6036, 0x30583f, 0x42673a].map(hex);

// 植え方の違い（0=自然の林, 1=公園や庭, 2=街路樹）
interface Pick { shape: number; color: THREE.Color }
function pickSpecies(kind: number, src: number, h: number, h2: number): Pick {
  if (kind === 1) {
    const cyp = src === 0 ? 0.08 : src === 1 ? 0.3 : 0.5;
    return { shape: h < cyp ? 1 : 0, color: DARKS[Math.floor(h2 * DARKS.length)] };
  }
  const w = src === 0 ? [0.5, 0.34, 0.04, 0.12] : src === 1 ? [0.38, 0.3, 0.14, 0.18] : [0.3, 0.45, 0.25, 0];
  let shape = 0, acc = 0;
  for (let k = 0; k < 4; k++) {
    acc += w[k];
    if (h < acc) { shape = k; break; }
  }
  const cp = src === 0 ? 0.015 : src === 1 ? 0.035 : 0.06, gd = src === 0 ? 0.03 : src === 1 ? 0.045 : 0.04;
  const copper = h2 < cp;
  const color = copper ? COPPER[Math.floor((h2 / cp) * COPPER.length)] : h2 < cp + gd ? GOLDEN[Math.floor(((h2 - cp) / gd) * GOLDEN.length)] : GREENS[Math.floor(((h2 - cp - gd) / (1 - cp - gd)) * GREENS.length) % GREENS.length];
  // 赤むらさきの葉の木（ベニバスモモ、ムラサキブナ）は丸い形か横に広い形（細長いと枯れた木のように見える）
  if (copper && (shape === 1 || shape === 2)) shape = h < 0.5 ? 0 : 3;
  return { shape, color };
}

// 木は 24×24 マスの区画ごとに分けて描く（画面の外の区画は描かない）。
// 遠くから見るときは、形を簡単にし、本数を間引く
const CHUNK = 24;
// くわしい形にするズーム（これより近いとき）と、その本数の上限
const HERO_DIST = 95;
const HERO_DIST_HQ = 140;
const HERO_MAX = 2400;
// 近くの広葉樹1本の葉の板の数（ふつう / 高画質）
const CARDS = 40;
const CARDS_HQ = 56;

interface Chunk { meshes: THREE.InstancedMesh[]; totals: number[]; cx: number; cz: number; ci: number; y0: number; y1: number; far: boolean; hash: number }

// 区画の中身（木の位置・大きさ・色）から求める値
function listHash(L: { m: number[]; seed: number[]; col: number[] }[]) {
  let h = 2166136261;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 16777619); };
  for (const l of L) {
    mix(l.seed.length);
    for (let k = 0; k < l.seed.length; k++) {
      const o = k * 16;
      mix(l.m[o + 12] * 64); mix(l.m[o + 13] * 64); mix(l.m[o + 14] * 64); mix(l.m[o] * 1024); mix(l.m[o + 5] * 1024);
      mix(l.seed[k] * 65536); mix(l.col[k * 3] * 4096); mix(l.col[k * 3 + 1] * 4096);
    }
  }
  return h >>> 0;
}

export class TreeLayer {
  group = new THREE.Group();
  private hero = [broadleafGeo(0), coniferGeo(0)];
  private near = [broadleafGeo(1), coniferGeo(1)];
  private far = [broadleafGeo(2), coniferGeo(2)];
  // [広葉樹, 針葉樹]
  private matHero = [treeMaterial(0, false), treeMaterial(0, true)];
  private matNear = [treeMaterial(1, false), treeMaterial(1, true)];
  private matFar = [treeMaterial(2, false), treeMaterial(2, true)];
  private depthMat = [treeDepthMaterial(false, true), treeDepthMaterial(true, true)];
  // 近くの木の輪郭につける葉の板 [広葉樹, 針葉樹]
  private heroCards: THREE.InstancedMesh[];
  // far = この区画を遠くの形で描いているか。hash = 中身が変わったかを調べるための値（同じなら作り直さない）
  private chunks: Chunk[] = [];
  private lodFar = false;
  private keep = 1;
  private shadows = true;
  // カメラのまわりだけ、くわしい形で描く
  private heroMeshes: THREE.InstancedMesh[];
  private cam: THREE.Camera | null = null;
  private heroAt = new THREE.Vector3(1e9, 0, 1e9);
  private heroR = 0;
  private heroDirty = true;
  private fwd = new THREE.Vector3();
  // 高画質のときは、近くの木を広い範囲でくわしくし、葉の影も作る（CityRenderer.setQuality が設定する）
  hq = false;
  private heroHq = false;
  private grab = (_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera) => {
    const c = cam as THREE.PerspectiveCamera;
    // 水面の映り込みなどのカメラは使わない（地面より上の、ふつうの画角のカメラだけ）
    if (!c.isPerspectiveCamera || c.fov > 80 || c.position.y <= 0) return;
    this.cam = c;
  };

  constructor() {
    this.heroMeshes = this.hero.map((geo, k) => {
      const m = new THREE.InstancedMesh(geo, this.matHero[k], HERO_MAX);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      // 影は「ふつう」の形が全部の木の分を作る（ほぼ同じ形なので、二重に作らない）
      m.castShadow = false;
      m.receiveShadow = true;
      m.customDepthMaterial = treeDepthMaterial(k === 1, false);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(HERO_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.onBeforeRender = this.grab;
      this.group.add(m);
      return m;
    });
    const cardGeo = [leafCards(broadleafLumps(), [0, 4.9, 0], CARDS_HQ, 2.8, 7.4), needleCards()];
    cardGeo[0].setDrawRange(0, CARDS * 6);
    this.heroCards = cardGeo.map((geo, k) => {
      const cards = new THREE.InstancedMesh(geo, treeMaterial(0, k === 1, true), HERO_MAX);
      // 行列と色は近くの木と同じものを使う
      cards.instanceMatrix = this.heroMeshes[k].instanceMatrix;
      cards.instanceColor = this.heroMeshes[k].instanceColor;
      cards.count = 0;
      cards.visible = false;
      cards.frustumCulled = false;
      cards.castShadow = false;
      cards.receiveShadow = true;
      cards.customDepthMaterial = treeDepthMaterial(k === 1, false, true);
      // 板を先に描くと、その奥の芯の面は色の計算をせずに済む
      cards.renderOrder = -1;
      this.group.add(cards);
      return cards;
    });
  }

  // ズームに合わせて、木の形の細かさと本数を切り替える。
  // 近くから見ているときも、カメラから遠い区画は遠くの形にする（画面の奥の林まで細かい形で描かない）
  setLod(dist: number) {
    U.uWindT.value = (performance.now() / 1000) % 3600;
    const allFar = dist > 450;
    const keep = dist > 2600 ? 0.1 : dist > 1800 ? 0.16 : dist > 1100 ? 0.3 : dist > 700 ? 0.55 : 1;
    const shadows = dist < 600;
    // 間引いた分、残りを少し大きくして林のこみ具合を保つ（遠くから見ても林が閉じて見えるように）
    U.uFarS.value = Math.pow(keep, -0.35);
    const all = keep !== this.keep || shadows !== this.shadows || allFar !== this.lodFar;
    this.lodFar = allFar;
    this.keep = keep;
    this.shadows = shadows;
    // 区画がカメラからこれより遠ければ遠くの形（ズームに合わせて広げる。境目で行ったり来たりしないよう幅をもたせる）
    const T = Math.max(280, dist * 1.5);
    for (const c of this.chunks) {
      const far = allFar || this.chunkFar(c, T);
      if (far !== c.far || all) this.applyLod(c, far);
    }
    this.updateHero(dist);
  }

  private chunkFar(c: Chunk, T: number) {
    const cam = this.cam;
    if (!cam) return false;
    const span = CHUNK * CELL, p = cam.position;
    const x0 = c.cx * span, z0 = c.cz * span;
    const dx = Math.max(x0 - p.x, 0, p.x - x0 - span), dz = Math.max(z0 - p.z, 0, p.z - z0 - span);
    const dy = Math.max(c.y0 - p.y, 0, p.y - c.y1);
    const d2 = dx * dx + dy * dy + dz * dz;
    const t = c.far ? T * 0.92 : T * 1.08;
    return d2 > t * t;
  }

  private applyLod(c: Chunk, far: boolean) {
    c.far = far;
    c.meshes.forEach((m, k) => {
      m.geometry = (far ? this.far : this.near)[k];
      m.material = (far ? this.matFar : this.matNear)[k];
      m.count = Math.ceil(c.totals[k] * this.keep);
      m.castShadow = this.shadows;
    });
  }

  // カメラの近くの木を、くわしい形に置きかえる
  private updateHero(dist: number) {
    const cam = this.cam;
    const hq = this.hq;
    if (dist >= (hq ? HERO_DIST_HQ : HERO_DIST) || !cam || this.lodFar) {
      if (this.heroMeshes[0].visible || this.heroMeshes[1].visible || U.uRing.value.z > 0) {
        for (const m of [...this.heroMeshes, ...this.heroCards]) { m.count = 0; m.visible = false; }
        U.uRing.value.z = -1;
        U.uRingD.value.z = -1;
        this.heroAt.set(1e9, 0, 1e9);
      }
      return;
    }
    if (hq !== this.heroHq) {
      this.heroHq = hq;
      this.heroDirty = true;
      // 高画質：葉の板を増やし、近くの木は自分の形で影を作る（葉のすき間から光がもれる影）
      this.heroCards[0].geometry.setDrawRange(0, (hq ? CARDS_HQ : CARDS) * 6);
      for (const m of [...this.heroMeshes, ...this.heroCards]) m.castShadow = hq;
    }
    // 画面の中心（注視点）と、カメラの真下の間を中心にする
    const fwd = this.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const tx = cam.position.x + fwd.x * dist, tz = cam.position.z + fwd.z * dist;
    const cx = tx + (cam.position.x - tx) * 0.25, cz = tz + (cam.position.z - tz) * 0.25;
    // いちばん寄ったときも、くわしい形の範囲の境目が画面の中ほどに来ないよう、少し広めにとる
    const R = hq ? Math.min(170, Math.max(65, dist * 1.3 + 25)) : Math.min(100, Math.max(65, dist * 0.85 + 12));
    const moved = Math.hypot(cx - this.heroAt.x, cz - this.heroAt.z);
    if (!this.heroDirty && moved < R * 0.12 && Math.abs(R - this.heroR) < R * 0.1) return;
    this.heroDirty = false;
    this.heroAt.set(cx, 0, cz);
    this.heroR = R;
    // 範囲に入る木を集める（区画で絞ってから）
    const R2 = R * R;
    const cand: { d2: number; m: THREE.InstancedMesh; j: number; k: number }[] = [];
    const span = CHUNK * CELL;
    for (const c of this.chunks) {
      const x0 = c.cx * span, z0 = c.cz * span;
      const ddx = Math.max(x0 - cx, 0, cx - x0 - span), ddz = Math.max(z0 - cz, 0, cz - z0 - span);
      if (ddx * ddx + ddz * ddz > R2 + 400) continue;
      c.meshes.forEach((m, k) => {
        const a = m.instanceMatrix.array;
        for (let j = 0; j < c.totals[k]; j++) {
          const dx = a[j * 16 + 12] - cx, dz = a[j * 16 + 14] - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 < R2) cand.push({ d2, m, j, k });
        }
      });
    }
    let r2 = R2;
    if (cand.length > HERO_MAX) {
      cand.sort((a, b) => a.d2 - b.d2);
      r2 = cand[HERO_MAX].d2;
      cand.length = HERO_MAX;
    }
    const n = [0, 0];
    for (const e of cand) {
      if (e.d2 >= r2) continue;
      const h = this.heroMeshes[e.k], i = n[e.k]++;
      (h.instanceMatrix.array as Float32Array).set((e.m.instanceMatrix.array as Float32Array).subarray(e.j * 16, e.j * 16 + 16), i * 16);
      (h.instanceColor!.array as Float32Array).set((e.m.instanceColor!.array as Float32Array).subarray(e.j * 3, e.j * 3 + 3), i * 3);
    }
    this.heroMeshes.forEach((h, k) => {
      h.count = n[k];
      h.visible = n[k] > 0;
      h.instanceMatrix.clearUpdateRanges();
      h.instanceMatrix.addUpdateRange(0, n[k] * 16);
      h.instanceMatrix.needsUpdate = true;
      h.instanceColor!.clearUpdateRanges();
      h.instanceColor!.addUpdateRange(0, n[k] * 3);
      h.instanceColor!.needsUpdate = true;
    });
    this.heroCards.forEach((c, k) => {
      c.count = n[k];
      c.visible = n[k] > 0;
    });
    // ふつうの形は、この範囲の内側を描かない（境目で消えないよう少しだけ内側）
    U.uRing.value.set(cx, cz, r2 - 0.5);
    U.uRingD.value.set(cx, cz, hq ? r2 - 0.5 : -1);
  }

  rebuild(g: Grid, extra: TreeSpot[]) {
    const n = g.n;
    // 前の区画（中身が同じなら、そのまま使う）
    const old = new Map<number, Chunk>();
    for (const c of this.chunks) old.set(c.ci, c);
    const drop = (c: Chunk) => { for (const m of c.meshes) { this.group.remove(m); m.dispose(); } };
    this.chunks = [];
    this.heroDirty = true;
    const cn = Math.ceil(n / CHUNK);
    // 区画ごとに [種類][行列とシードと色]
    const lists: { m: number[]; seed: number[]; col: number[] }[][] = Array.from({ length: cn * cn }, () => [{ m: [], seed: [], col: [] }, { m: [], seed: [], col: [] }]);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3();
    const v = new THREE.Vector3(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    // src: 0=自然の林, 1=公園や庭, 2=街路樹。sp を決めると樹種をそろえる（同じ通りの街路樹）
    const put = (kind: number, x: number, y: number, z: number, s: number, seed: number, src: number, sp = -1, colHex?: number, shape?: number) => {
      const cx = Math.min(cn - 1, Math.max(0, Math.floor(x / CELL / CHUNK))), cz = Math.min(cn - 1, Math.max(0, Math.floor(z / CELL / CHUNK)));
      const L = lists[cz * cn + cx][kind];
      if (L.seed.length >= MAX_TREES) return;
      const ix = Math.floor(x * 7.3), iz = Math.floor(z * 7.3);
      const h1 = hash2(ix, iz, 21), h2 = hash2(ix, iz, 22), h3 = hash2(ix, iz, 23), h4 = hash2(ix, iz, 24);
      // 街路樹は通りごとに色もそろえる
      const pk = pickSpecies(kind, src, sp >= 0 ? sp : h1, sp >= 0 ? (sp * 9.73 + h2 * 0.04) % 1 : h2);
      // 庭の木などは、形と色を決めて植える（青もみじなど）
      if (shape !== undefined) pk.shape = shape;
      if (colHex !== undefined) pk.color = new THREE.Color(colHex);
      const sh = SHAPE[kind][pk.shape];
      // 少しだけ傾ける（自然の木らしく）
      const tilt = src === 2 ? 0.012 : 0.035;
      ax.set(Math.cos(h3 * 6.28), 0, Math.sin(h3 * 6.28));
      q.setFromAxisAngle(up, seed * 6.28);
      q2.setFromAxisAngle(ax, (h4 - 0.5) * 2 * tilt);
      q.premultiply(q2);
      const wid = 0.9 + h3 * 0.2;
      mtx.compose(v.set(x, y, z), q, sc.set(s * sh[0] * wid, s * sh[1] * (0.88 + seed * 0.24), s * sh[2] * wid));
      L.m.push(...mtx.elements);
      L.seed.push(seed);
      col.copy(pk.color).multiplyScalar(0.9 + h4 * 0.2);
      L.col.push(col.r, col.g, col.b);
    };
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const t = g.tree[i];
        if (!t || g.road[i] || g.bldg[i] || g.pline[i]) continue;
        const per = t * 2;
        for (let k = 0; k < per; k++) {
          const hx = hash2(x * 7 + k, y * 13, 1), hz = hash2(x * 11, y * 5 + k, 2), hs = hash2(x + k * 31, y, 3);
          const wx = (x + 0.1 + hx * 0.8) * CELL, wz = (y + 0.1 + hz * 0.8) * CELL;
          const wy = g.groundAt(wx, wz);
          if (wy < 0.4) continue;
          const kind = hash2(x, y, 9) < 0.4 + (wy > 30 ? 0.4 : 0) ? 1 : 0;
          put(kind, wx, wy, wz, 0.8 + hs * 0.6, hs, 0);
        }
      }
    for (const t of extra) put(t.kind, t.x, t.y, t.z, t.s, hash2(Math.floor(t.x), Math.floor(t.z), 4), 1, -1, t.col, t.shape);
    // 街路樹：まっすぐな一般道・一方通行・大通り・街路の歩道に、街灯と1マスずつ交互に植える
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (!((x + y) & 1)) continue;
        const i = y * n + x;
        const t = g.road[i];
        if (!(t === RoadType.Street || t === RoadType.Road || t === RoadType.OneWay || t === RoadType.Avenue)) continue;
        if (g.up[i] || g.deck[i] > 0 || g.lift[i] > 0.3 || g.bstop[i] || g.rail[i]) continue;
        const m = g.conn[i];
        const ew = m === ((1 << 0) | (1 << 4)) || m === (1 << 0) || m === (1 << 4);
        const ns = m === ((1 << 2) | (1 << 6)) || m === (1 << 2) || m === (1 << 6);
        if (!ew && !ns) continue;
        const off = ROADS[t].width / 2 + (t === RoadType.Street ? 0.85 : 1.0);
        // 同じ通りのひと続きは、同じ樹種にそろえる
        const sp = hash2(ew ? Math.floor(x / 8) : x, ew ? y : Math.floor(y / 8), 12);
        for (const sd of [-1, 1]) {
          // 横のマスが道路（大通りの反対車線など）なら、そちらには植えない
          const ox = ew ? 0 : sd, oy = ew ? sd : 0;
          if (g.inb(x + ox, y + oy) && g.road[(y + oy) * n + x + ox]) continue;
          const hs = hash2(x * 3 + sd, y * 7, 11);
          if (hs < 0.15) continue;
          const wx = (x + 0.5) * CELL + ox * off, wz = (y + 0.5) * CELL + oy * off;
          put(0, wx, g.roadH(i) + 0.45, wz, 0.55 + hs * 0.15, hs, 2, sp);
        }
      }
    for (let ci = 0; ci < lists.length; ci++) {
      const L = lists[ci];
      const prev = old.get(ci);
      old.delete(ci);
      if (!L[0].seed.length && !L[1].seed.length) {
        if (prev) drop(prev);
        continue;
      }
      // 中身が変わっていない区画は作り直さない（建物が建つたびに全部を作り直すと重い）
      const hash = listHash(L);
      if (prev && prev.hash === hash) {
        this.chunks.push(prev);
        continue;
      }
      if (prev) drop(prev);
      const meshes: THREE.InstancedMesh[] = [];
      const totals: number[] = [];
      let y0 = Infinity, y1 = -Infinity;
      for (const list of L) for (let k = 13; k < list.m.length; k += 16) { y0 = Math.min(y0, list.m[k]); y1 = Math.max(y1, list.m[k] + 14); }
      const chunk: Chunk = { meshes, totals, cx: ci % cn, cz: Math.floor(ci / cn), ci, y0, y1, far: false, hash };
      // 形の細かさは、次の setLod で区画ごとに決め直す
      const far = this.lodFar || (prev ? prev.far : false);
      chunk.far = far;
      L.forEach((list, kind) => {
        const cnt = list.seed.length;
        const m = new THREE.InstancedMesh((far ? this.far : this.near)[kind], (far ? this.matFar : this.matNear)[kind], Math.max(1, cnt));
        m.customDepthMaterial = this.depthMat[kind];
        // 間引くときに場所が偏らないよう、並びを混ぜる（シードの順）
        const order = list.seed.map((_, k) => k).sort((a2, b2) => ((list.seed[a2] * 7919) % 1) - ((list.seed[b2] * 7919) % 1));
        order.forEach((src, k) => {
          mtx.fromArray(list.m, src * 16);
          m.setMatrixAt(k, mtx);
          col.setRGB(list.col[src * 3], list.col[src * 3 + 1], list.col[src * 3 + 2]);
          m.setColorAt(k, col);
        });
        m.computeBoundingSphere();
        if (m.boundingSphere) m.boundingSphere.radius += 12;
        m.count = Math.ceil(cnt * this.keep);
        m.castShadow = this.shadows;
        m.receiveShadow = true;
        m.onBeforeRender = this.grab;
        this.group.add(m);
        meshes.push(m);
        totals.push(cnt);
      });
      this.chunks.push(chunk);
    }
    for (const c of old.values()) drop(c);
  }
}
