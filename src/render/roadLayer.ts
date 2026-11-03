// 道路と送電線の描画
//
// 道路はマスごとに「腕」（つながっている方向）を調べて形を作る。
//   1本：行き止まり（通りは丸い転回場）
//   2本：まっすぐ、またはなめらかなカーブ
//   3本以上：交差点（角が丸い路面、停止線、横断歩道）
// 路面、白線・黄線、歩道や壁などの立体物は、それぞれ別のメッシュにまとめる。
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, isDiag } from '../sim/constants';
import { ROADS, RoadType, isHighway } from '../sim/defs';

export const ROAD_LIFT = 0.3;

const COL = {
  white: new THREE.Color(0xecece6),
  yellow: new THREE.Color(0xe3b62e),
  walk: new THREE.Color(0xb8b5ac),
  curb: new THREE.Color(0x8f8c85),
  barrier: new THREE.Color(0xc4c1b9),
  concrete: new THREE.Color(0xb3afa6),
  signal: new THREE.Color(0x3a3d40),
  island: new THREE.Color(0x5f8f44),
  asphalt: new THREE.Color(0x55585c),
  asphaltHw: new THREE.Color(0x4a4d51),
  asphaltStreet: new THREE.Color(0x5e6064),
};

// 道路の種類ごとの見た目
function sidewalkOf(t: number) {
  return t === RoadType.Street ? 1.7 : t === RoadType.Road || t === RoadType.OneWay || t === RoadType.Avenue ? 2.0 : 0;
}
function hasBarrier(t: number) {
  return isHighway(t) || t === RoadType.Ramp;
}

// 路面のざらつき（世界座標で繰り返す）
function asphaltTexture(): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);
  for (let k = 0; k < 1600; k++) {
    const v = 200 + Math.floor(Math.random() * 55);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 頂点を貯めてメッシュにするための入れ物
class Buf {
  P: number[] = [];
  N: number[] = [];
  C: number[] = [];
  U: number[] = [];
  I: number[] = [];
  v(x: number, y: number, z: number, c: THREE.Color, nx = 0, ny = 1, nz = 0) {
    this.P.push(x, y, z);
    this.N.push(nx, ny, nz);
    this.C.push(c.r, c.g, c.b);
    this.U.push(x / 7, z / 7);
    return this.P.length / 3 - 1;
  }
  // 上向きの面になるように三角形を追加
  tri(a: number, b: number, c: number) {
    const P = this.P;
    const e1x = P[b * 3] - P[a * 3], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3], e2z = P[c * 3 + 2] - P[a * 3 + 2];
    if (e1z * e2x - e1x * e2z >= 0) this.I.push(a, b, c);
    else this.I.push(a, c, b);
  }
  // 縦の面（両面）
  wall(ax: number, az: number, ay0: number, ay1: number, bx: number, bz: number, by0: number, by1: number, c: THREE.Color) {
    const nx = bz - az, nz = -(bx - ax);
    const l = Math.hypot(nx, nz) || 1;
    const i0 = this.v(ax, ay0, az, c, nx / l, 0, nz / l), i1 = this.v(bx, by0, bz, c, nx / l, 0, nz / l);
    const i2 = this.v(bx, by1, bz, c, nx / l, 0, nz / l), i3 = this.v(ax, ay1, az, c, nx / l, 0, nz / l);
    this.I.push(i0, i1, i2, i0, i2, i3, i0, i2, i1, i0, i3, i2);
  }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color) {
    this.wall(x0, z1, y0, y1, x1, z1, y0, y1, c);
    this.wall(x1, z0, y0, y1, x0, z0, y0, y1, c);
    this.wall(x1, z1, y0, y1, x1, z0, y0, y1, c);
    this.wall(x0, z0, y0, y1, x0, z1, y0, y1, c);
    const a = this.v(x0, y1, z0, c), b = this.v(x1, y1, z0, c), d = this.v(x1, y1, z1, c), e = this.v(x0, y1, z1, c);
    this.tri(a, b, d);
    this.tri(a, d, e);
  }
  geometry(uv = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setIndex(this.I);
    return g;
  }
}

// 道路の中心線上の点（位置、高さ、車道の半分の幅、歩道の幅、道路の種類）
interface RP {
  x: number;
  z: number;
  h: number;
  hw: number;
  sw: number;
  t: number;
}

interface Arm {
  d: number;
  ux: number;
  uz: number;
  L: number; // 中心から中間点までの長さ
  ang: number;
  w: number; // このマスでの車道の幅
  wm: number; // 中間点での車道の幅（隣の道路との平均）
  sw: number;
  swm: number;
  eh: number; // 中間点の高さ
  t: number;
  tn: number; // 隣の道路の種類
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class RoadLayer {
  group = new THREE.Group();
  private surface: THREE.Mesh;
  private marks: THREE.Mesh;
  private solid: THREE.Mesh;
  private poles: THREE.Mesh;
  private wires: THREE.LineSegments;
  jctl: Uint8Array = new Uint8Array(0); // 交差点の制御方式（シミュレーションで決まったもの）

  constructor() {
    const smat = new THREE.MeshLambertMaterial({ vertexColors: true, map: asphaltTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.surface = new THREE.Mesh(new THREE.BufferGeometry(), smat);
    this.surface.receiveShadow = true;
    this.marks = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    this.marks.receiveShadow = true;
    this.solid = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.solid.castShadow = true;
    this.solid.receiveShadow = true;
    this.poles = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x6b5b4a }));
    this.poles.castShadow = true;
    this.wires = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.7 }));
    this.group.add(this.surface, this.marks, this.solid, this.poles, this.wires);
  }

  static centerH(g: Grid, i: number) {
    return g.roadH(i) + ROAD_LIFT;
  }

  rebuild(g: Grid) {
    const n = g.n, NC = n * n;
    const S = new Buf(), M = new Buf(), O = new Buf();

    // ---- 部品 ----
    // 中心線に沿った帯（路面・歩道・線）を作る
    const ribbon = (pts: RP[], t: number) => {
      if (pts.length < 2) return;
      const asph = t === RoadType.Street ? COL.asphaltStreet : isHighway(t) ? COL.asphaltHw : COL.asphalt;
      const L: number[] = [], R: number[] = [];
      const nrm = pts.map((p, k) => {
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        return [-dz / l, dx / l];
      });
      pts.forEach((p, k) => {
        const [px, pz] = nrm[k];
        L.push(S.v(p.x - px * p.hw, p.h, p.z - pz * p.hw, asph));
        R.push(S.v(p.x + px * p.hw, p.h, p.z + pz * p.hw, asph));
      });
      for (let k = 0; k + 1 < pts.length; k++) {
        S.tri(L[k], R[k], R[k + 1]);
        S.tri(L[k], R[k + 1], L[k + 1]);
      }
      // 歩道（縁石つき）または高速道路の壁
      for (const side of [-1, 1]) {
        const walk = pts.map((p) => p.sw);
        const barrier = hasBarrier(t);
        if (!barrier && walk.every((w) => w <= 0)) continue;
        let prevIn = -1, prevOut = -1;
        pts.forEach((p, k) => {
          const [px, pz] = nrm[k];
          const ix = p.x + side * px * p.hw, iz = p.z + side * pz * p.hw;
          const wv = barrier ? 0.55 : p.sw;
          const top = p.h + (barrier ? 0.95 : 0.16);
          const ox = ix + side * px * wv, oz = iz + side * pz * wv;
          const a = O.v(ix, top, iz, barrier ? COL.barrier : COL.walk), b = O.v(ox, top, oz, barrier ? COL.barrier : COL.walk);
          if (k > 0) {
            O.tri(prevIn, prevOut, b);
            O.tri(prevIn, b, a);
            const q = pts[k - 1];
            const [qx, qz] = nrm[k - 1];
            O.wall(q.x + side * qx * q.hw, q.z + side * qz * q.hw, q.h - 0.05, q.h + (barrier ? 0.95 : 0.16), ix, iz, p.h - 0.05, top, barrier ? COL.barrier : COL.curb);
          }
          prevIn = a;
          prevOut = b;
        });
      }
    };
    // 中心線からの距離 off の位置に線を引く（dash = 破線）
    const line = (pts: RP[], off: (p: RP) => number, c: THREE.Color, width = 0.16, dash = false) => {
      if (pts.length < 2) return;
      let acc = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz);
        if (l < 1e-3) continue;
        const px = -dz / l, pz = dx / l;
        // 破線は 3m 引いて 6m 空ける
        const steps = dash ? Math.max(1, Math.ceil(l / 1.5)) : 1;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const mid = acc + l * (t0 + t1) * 0.5;
          if (dash && mid % 9 > 3) continue;
          const pa = { x: lerp(a.x, b.x, t0), z: lerp(a.z, b.z, t0), h: lerp(a.h, b.h, t0), o: lerp(off(a), off(b), t0) };
          const pb = { x: lerp(a.x, b.x, t1), z: lerp(a.z, b.z, t1), h: lerp(a.h, b.h, t1), o: lerp(off(a), off(b), t1) };
          const i0 = M.v(pa.x + px * (pa.o - width / 2), pa.h + 0.02, pa.z + pz * (pa.o - width / 2), c);
          const i1 = M.v(pa.x + px * (pa.o + width / 2), pa.h + 0.02, pa.z + pz * (pa.o + width / 2), c);
          const i2 = M.v(pb.x + px * (pb.o + width / 2), pb.h + 0.02, pb.z + pz * (pb.o + width / 2), c);
          const i3 = M.v(pb.x + px * (pb.o - width / 2), pb.h + 0.02, pb.z + pz * (pb.o - width / 2), c);
          M.tri(i0, i1, i2);
          M.tri(i0, i2, i3);
        }
        acc += l;
      }
    };
    // 道路の種類ごとの線
    const markings = (pts: RP[], t: number) => {
      const edge = (side: number) => (p: RP) => side * (p.hw - 0.35);
      switch (t) {
        case RoadType.Road:
          line(pts, () => -0.16, COL.yellow, 0.13);
          line(pts, () => 0.16, COL.yellow, 0.13);
          line(pts, edge(-1), COL.white, 0.14);
          line(pts, edge(1), COL.white, 0.14);
          break;
        case RoadType.OneWay:
        case RoadType.Avenue:
          line(pts, () => 0, COL.white, 0.14, true);
          line(pts, edge(-1), COL.white, 0.14);
          line(pts, edge(1), COL.white, 0.14);
          break;
        case RoadType.Highway:
        case RoadType.GroundHighway:
          line(pts, (p) => -p.hw / 3 + 0.4, COL.white, 0.15, true);
          line(pts, (p) => p.hw / 3 - 0.4, COL.white, 0.15, true);
          line(pts, (p) => -(p.hw - 0.9), COL.yellow, 0.16);
          line(pts, (p) => p.hw - 0.9, COL.white, 0.16);
          break;
        // ランプは短く斜めに重なるので、線は引かない
      }
    };
    // 円（転回場、ラウンドアバウト、つなぎ目）
    const disc = (cx: number, cz: number, h: number, r: number, c: THREE.Color, buf: Buf = S, seg = 20) => {
      const ci = buf.v(cx, h, cz, c);
      const ring: number[] = [];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        ring.push(buf.v(cx + Math.cos(a) * r, h, cz + Math.sin(a) * r, c));
      }
      for (let s = 0; s < seg; s++) buf.tri(ci, ring[s], ring[(s + 1) % seg]);
    };
    // 円弧の歩道
    const ringWalk = (cx: number, cz: number, h: number, r0: number, r1: number, a0: number, a1: number) => {
      const seg = 16;
      let pi = -1, po = -1;
      for (let s = 0; s <= seg; s++) {
        const a = a0 + ((a1 - a0) * s) / seg;
        const cs = Math.cos(a), sn = Math.sin(a);
        const i = O.v(cx + cs * r0, h + 0.16, cz + sn * r0, COL.walk), o = O.v(cx + cs * r1, h + 0.16, cz + sn * r1, COL.walk);
        if (s > 0) {
          O.tri(pi, po, o);
          O.tri(pi, o, i);
          const ap = a0 + ((a1 - a0) * (s - 1)) / seg;
          O.wall(cx + Math.cos(ap) * r0, cz + Math.sin(ap) * r0, h - 0.05, h + 0.16, cx + cs * r0, cz + sn * r0, h - 0.05, h + 0.16, COL.curb);
        }
        pi = i;
        po = o;
      }
    };
    // 橋・高架の床版と橋脚
    const deckUnder = (pts: RP[], bot: number | null) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const px = -dz / l, pz = dx / l;
        const wa = a.hw + Math.max(a.sw, 0.6), wb = b.hw + Math.max(b.sw, 0.6);
        const th = 1.2;
        for (const sd of [-1, 1]) O.wall(a.x + sd * px * wa, a.z + sd * pz * wa, a.h - th, a.h + 0.1, b.x + sd * px * wb, b.z + sd * pz * wb, b.h - th, b.h + 0.1, COL.concrete);
        const i0 = O.v(a.x - px * wa, a.h - th, a.z - pz * wa, COL.concrete, 0, -1, 0), i1 = O.v(a.x + px * wa, a.h - th, a.z + pz * wa, COL.concrete, 0, -1, 0);
        const i2 = O.v(b.x + px * wb, b.h - th, b.z + pz * wb, COL.concrete, 0, -1, 0), i3 = O.v(b.x - px * wb, b.h - th, b.z - pz * wb, COL.concrete, 0, -1, 0);
        O.I.push(i0, i2, i1, i0, i3, i2);
        // 欄干（歩道のない橋・高架は壁があるので省く）
        if (a.sw > 0) for (const sd of [-1, 1]) O.wall(a.x + sd * px * wa, a.z + sd * pz * wa, a.h + 0.1, a.h + 1.1, b.x + sd * px * wb, b.z + sd * pz * wb, b.h + 0.1, b.h + 1.1, COL.concrete);
      }
      if (bot !== null) {
        const p = pts[0];
        if (p.h - bot > 3) O.box(p.x - 1.0, bot, p.z - 1.0, p.x + 1.0, p.h - 1.2, p.z + 1.0, COL.concrete);
      }
    };

    // ---- マス（ノード）ごと ----
    for (let node = 0; node < 2 * NC; node++) {
      const level = node >= NC ? 1 : 0;
      const i = node - level * NC;
      const t = level ? g.up[i] : g.road[i];
      if (!t) continue;
      const x = i % n, y = (i / n) | 0;
      const cx = (x + 0.5) * CELL, cz = (y + 0.5) * CELL;
      const ch = g.nodeH(node) + ROAD_LIFT;
      const def = ROADS[t];
      const w = def.width, sw = sidewalkOf(t);
      const m = level ? g.conn1[i] : g.conn[i];
      const ground = g.cellH(x, y);
      const elevated = level === 1 || g.deck[i] > 0;
      const arms: Arm[] = [];
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d))) continue;
        const nx = x + DX[d], ny = y + DY[d];
        const len = Math.hypot(DX[d], DY[d]);
        let tn = t, eh = ch;
        if (g.inb(nx, ny)) {
          const j = ny * n + nx;
          const nl = g.arriveLevel(level, j, d);
          tn = (nl ? g.up[j] : g.road[j]) || t;
          eh = (ch + g.nodeH(nl * NC + j) + ROAD_LIFT) / 2;
        }
        const wn = ROADS[tn]?.width ?? w;
        arms.push({
          d, ux: DX[d] / len, uz: DY[d] / len, L: (CELL * len) / 2, ang: Math.atan2(DY[d], DX[d]),
          w, wm: (w + wn) / 2, sw, swm: (sw + sidewalkOf(tn)) / 2, eh, t, tn,
        });
      }
      const armPts = (a: Arm, s0: number): RP[] => {
        const k = s0 / a.L;
        return [
          { x: cx + a.ux * s0, z: cz + a.uz * s0, h: lerp(ch, a.eh, k), hw: lerp(a.w, a.wm, k) / 2, sw: lerp(a.sw, a.swm, k), t },
          { x: cx + a.ux * a.L, z: cz + a.uz * a.L, h: a.eh, hw: a.wm / 2, sw: a.swm, t },
        ];
      };
      const k = arms.length;
      const ctl = level === 0 && this.jctl.length === NC ? this.jctl[i] : 0;
      const asph = t === RoadType.Street ? COL.asphaltStreet : isHighway(t) ? COL.asphaltHw : COL.asphalt;

      if (k === 0) {
        disc(cx, cz, ch, w / 2, asph);
        continue;
      }
      const opposite = k === 2 && ((arms[0].d + 4) & 7) === arms[1].d;
      if (k === 1) {
        // 行き止まり
        const a = arms[0];
        const pts = armPts(a, 0).reverse();
        ribbon(pts, t);
        markings(pts, t);
        if (elevated) deckUnder(pts, level ? ground : null);
        const back = Math.atan2(-a.uz, -a.ux);
        if (t === RoadType.Street) {
          // 袋小路の転回場
          const r = w * 0.95;
          disc(cx - a.ux * 1.5, cz - a.uz * 1.5, ch, r, asph);
          ringWalk(cx - a.ux * 1.5, cz - a.uz * 1.5, ch, r, r + sw, back - Math.PI * 0.78, back + Math.PI * 0.78);
        } else if (hasBarrier(t)) {
          disc(cx, cz, ch, w / 2, asph);
          O.wall(cx - a.uz * (w / 2 + 0.5), cz + a.ux * (w / 2 + 0.5), ch - 0.05, ch + 0.95, cx + a.uz * (w / 2 + 0.5), cz - a.ux * (w / 2 + 0.5), ch - 0.05, ch + 0.95, COL.barrier);
        } else {
          disc(cx, cz, ch, w / 2, asph);
          if (sw > 0) ringWalk(cx, cz, ch, w / 2, w / 2 + sw, back - Math.PI / 2, back + Math.PI / 2);
        }
        continue;
      }
      if (k === 2) {
        const [a, b] = arms;
        let pts: RP[];
        if (opposite) {
          pts = [...armPts(a, 0).reverse(), ...armPts(b, 0).slice(1)];
          pts[1] = { ...pts[1], hw: w / 2, sw };
        } else {
          // なめらかなカーブ（2次ベジェ曲線）
          pts = [];
          const ax = cx + a.ux * a.L, az = cz + a.uz * a.L, bx = cx + b.ux * b.L, bz = cz + b.uz * b.L;
          const seg = 10;
          for (let s = 0; s <= seg; s++) {
            const u = s / seg;
            const p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
            const half = u < 0.5 ? lerp(a.wm, w, u * 2) : lerp(w, b.wm, u * 2 - 1);
            const swv = u < 0.5 ? lerp(a.swm, sw, u * 2) : lerp(sw, b.swm, u * 2 - 1);
            pts.push({ x: p0 * ax + p1 * cx + p2 * bx, z: p0 * az + p1 * cz + p2 * bz, h: p0 * a.eh + p1 * ch + p2 * b.eh, hw: half / 2, sw: swv, t });
          }
        }
        ribbon(pts, t);
        markings(pts, t);
        if (elevated) deckUnder(pts, level ? ground : null);
        continue;
      }

      // ---- 高速道路とランプの分岐・合流：交差点の形にせず、帯をそのままつなぐ ----
      if (hasBarrier(t) || arms.some((q) => q.tn === RoadType.Ramp && hasBarrier(t))) {
        for (const a of arms) {
          const pts = armPts(a, 0).reverse();
          pts[1] = { ...pts[1], hw: a.w / 2 };
          ribbon(pts, t);
          if (!isDiag(a.d)) markings(pts, t);
          if (elevated) deckUnder(pts, level ? ground : null);
        }
        disc(cx, cz, ch, w / 2, asph);
        continue;
      }

      // ---- 交差点（3本以上） ----
      arms.sort((p, q) => p.ang - q.ang);
      const maxHalf = Math.max(...arms.map((a) => a.w / 2 + (hasBarrier(a.t) ? 0.6 : a.sw)));
      const round = ctl === 4;
      const R = round ? maxHalf + 3 : 0;
      const starts = arms.map((a) => Math.min(a.L * 0.85, round ? R - 1 : maxHalf + 0.6));
      arms.forEach((a, k2) => {
        const pts = armPts(a, starts[k2]).reverse();
        ribbon(pts, t);
        markings(pts, t);
        if (elevated) deckUnder(pts, level ? ground : null);
      });
      if (round) {
        disc(cx, cz, ch, R, asph, S, 24);
        disc(cx, cz, ch + 0.35, R * 0.42, COL.island, O, 16);
        O.wall(cx + R * 0.42, cz, ch - 0.05, ch + 0.35, cx + R * 0.42, cz, ch - 0.05, ch + 0.35, COL.curb);
        // 島の縁石
        for (let s = 0; s < 16; s++) {
          const a0 = (s / 16) * Math.PI * 2, a1 = ((s + 1) / 16) * Math.PI * 2, r = R * 0.42;
          O.wall(cx + Math.cos(a0) * r, cz + Math.sin(a0) * r, ch, ch + 0.35, cx + Math.cos(a1) * r, cz + Math.sin(a1) * r, ch, ch + 0.35, COL.curb);
        }
        continue;
      }
      // 角の丸い路面：腕の端の角どうしを曲線でつなぐ
      const ci = S.v(cx, ch, cz, asph);
      const outline: number[] = [];
      for (let k2 = 0; k2 < arms.length; k2++) {
        const a = arms[k2], b = arms[(k2 + 1) % arms.length];
        const sa = starts[k2], sb = starts[(k2 + 1) % arms.length];
        const pa = [-a.uz, a.ux], pb = [-b.uz, b.ux];
        const Ra = [cx + a.ux * sa + pa[0] * (a.w / 2), cz + a.uz * sa + pa[1] * (a.w / 2)];
        const Lb = [cx + b.ux * sb - pb[0] * (b.w / 2), cz + b.uz * sb - pb[1] * (b.w / 2)];
        // 2本の道路の端の線が交わる点を、曲線の制御点にする
        const det = a.ux * b.uz - a.uz * b.ux;
        let K = [(Ra[0] + Lb[0]) / 2, (Ra[1] + Lb[1]) / 2];
        if (Math.abs(det) > 1e-3) {
          const dx = Lb[0] - Ra[0], dz = Lb[1] - Ra[1];
          const tA = (dx * b.uz - dz * b.ux) / det;
          const cand = [Ra[0] + a.ux * tA, Ra[1] + a.uz * tA];
          if (Math.hypot(cand[0] - cx, cand[1] - cz) < maxHalf * 2.2) K = cand;
        }
        const seg = 6;
        const curve: [number, number][] = [];
        for (let s = 0; s <= seg; s++) {
          const u = s / seg;
          const p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
          curve.push([p0 * Ra[0] + p1 * K[0] + p2 * Lb[0], p0 * Ra[1] + p1 * K[1] + p2 * Lb[1]]);
        }
        for (const [px, pz] of curve) outline.push(S.v(px, ch, pz, asph));
        // 角の歩道
        const swc = Math.min(sidewalkOf(a.t) || 0, sidewalkOf(b.t) || 0) || (hasBarrier(t) ? 0 : 0);
        if (swc > 0) {
          let pi = -1, po = -1;
          curve.forEach(([px, pz], s) => {
            const dx = px - cx, dz = pz - cz;
            const l = Math.hypot(dx, dz) || 1;
            const ii = O.v(px, ch + 0.16, pz, COL.walk), oo = O.v(px + (dx / l) * swc, ch + 0.16, pz + (dz / l) * swc, COL.walk);
            if (s > 0) {
              O.tri(pi, po, oo);
              O.tri(pi, oo, ii);
              const [qx, qz] = curve[s - 1];
              O.wall(qx, qz, ch - 0.05, ch + 0.16, px, pz, ch - 0.05, ch + 0.16, COL.curb);
            }
            pi = ii;
            po = oo;
          });
        }
      }
      for (let s = 0; s < outline.length; s++) S.tri(ci, outline[s], outline[(s + 1) % outline.length]);
      if (elevated) deckUnder([{ x: cx, z: cz, h: ch, hw: maxHalf, sw: 0, t }, { x: cx + 0.01, z: cz, h: ch, hw: maxHalf, sw: 0, t }], level ? ground : null);

      // 停止線と横断歩道（信号・一時停止）
      arms.forEach((a, k2) => {
        const s0 = starts[k2];
        const px = -a.uz, pz = a.ux;
        if (ctl === 2 || ctl === 3) {
          // 交差点に入ってくる車線は、腕の向きから見て右側（-p 側）
          const sd = s0 + (ctl === 3 ? 4.2 : 0.6);
          line([{ x: cx + a.ux * sd - px * (a.w / 2 - 0.3), z: cz + a.uz * sd - pz * (a.w / 2 - 0.3), h: ch, hw: 0, sw: 0, t }, { x: cx + a.ux * sd, z: cz + a.uz * sd, h: ch, hw: 0, sw: 0, t }], () => 0, COL.white, 0.45);
        }
        if (ctl === 3 && a.t !== RoadType.Street && !arms.some((q) => q.tn === RoadType.Ramp)) {
          // 横断歩道（しま模様）
          for (let o = -a.w / 2 + 0.6; o < a.w / 2 - 0.3; o += 1.0) {
            const s1 = s0 + 0.6, s2 = s0 + 3.4;
            line([{ x: cx + a.ux * s1 + px * o, z: cz + a.uz * s1 + pz * o, h: ch, hw: 0, sw: 0, t }, { x: cx + a.ux * s2 + px * o, z: cz + a.uz * s2 + pz * o, h: ch, hw: 0, sw: 0, t }], () => 0, COL.white, 0.5);
          }
        }
      });
      // 優先道路のセンターラインは交差点の中も続ける（信号のない交差点）
      if (ctl !== 3) {
        const rank = (a: Arm) => ROADS[a.t].rank * 10 + a.w;
        for (const a of arms) {
          const b = arms.find((q) => q.d === ((a.d + 4) & 7));
          if (!b || a.d > b.d) continue;
          const others = arms.filter((q) => q !== a && q !== b);
          if (others.every((q) => rank(q) < rank(a)) || others.length === 1) {
            const sa = starts[arms.indexOf(a)], sb = starts[arms.indexOf(b)];
            const pts: RP[] = [
              { x: cx + a.ux * sa, z: cz + a.uz * sa, h: ch, hw: a.w / 2, sw: 0, t },
              { x: cx + b.ux * sb, z: cz + b.uz * sb, h: ch, hw: b.w / 2, sw: 0, t },
            ];
            if (t === RoadType.Road) {
              line(pts, () => -0.16, COL.yellow, 0.13);
              line(pts, () => 0.16, COL.yellow, 0.13);
            } else if (t === RoadType.OneWay || t === RoadType.Avenue) line(pts, () => 0, COL.white, 0.14, true);
            break;
          }
        }
      }
      // 信号機
      if (ctl === 3) {
        const o = maxHalf + 0.3;
        for (const [sx, sz] of [[1, 1], [-1, -1]]) {
          const qx = cx + sx * o, qz = cz + sz * o;
          O.box(qx - 0.15, ch, qz - 0.15, qx + 0.15, ch + 5.6, qz + 0.15, COL.signal);
          O.box(Math.min(qx, qx - sx * 4), ch + 5.4, qz - 0.1, Math.max(qx, qx - sx * 4), ch + 5.6, qz + 0.1, COL.signal);
          O.box(qx - sx * 3.2 - 0.3, ch + 4.6, qz - 0.3, qx - sx * 3.2 + 0.3, ch + 5.4, qz + 0.3, COL.signal);
        }
      }
    }
    for (const [mesh, buf, uv] of [[this.surface, S, true], [this.marks, M, false], [this.solid, O, false]] as const) {
      mesh.geometry.dispose();
      mesh.geometry = buf.geometry(uv);
    }
    this.rebuildLines(g);
  }

  private rebuildLines(g: Grid) {
    const n = g.n;
    const P: number[] = [], NN: number[] = [], I: number[] = [];
    const W: number[] = [];
    const poleH = 11;
    const top = (i: number) => {
      const x = i % n, y = (i / n) | 0;
      return [(x + 0.5) * CELL + (g.road[i] ? 6.5 : 0), (g.road[i] ? g.roadH(i) : g.cellH(x, y)) + poleH, (y + 0.5) * CELL + (g.road[i] ? 6.5 : 0)];
    };
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      const faces: [number[], number[]][] = [
        [[0, 0, 1], [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]],
        [[0, 0, -1], [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0]],
        [[1, 0, 0], [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1]],
        [[-1, 0, 0], [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0]],
        [[0, 1, 0], [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0]],
      ];
      for (const [nrm, v] of faces) {
        const b = P.length / 3;
        P.push(...v);
        for (let k = 0; k < 4; k++) NN.push(...nrm);
        I.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    };
    for (let i = 0; i < n * n; i++) {
      if (!g.pline[i]) continue;
      const x = i % n, y = (i / n) | 0;
      const [tx, ty, tz] = top(i);
      // 2マスに1本の電柱（すべてのマスに置くと多すぎる）
      box(tx - 0.2, ty - poleH, tz - 0.2, tx + 0.2, ty, tz + 0.2);
      box(tx - 1.4, ty - 1.0, tz - 0.12, tx + 1.4, ty - 0.75, tz + 0.12);
      // 電線（右・下・斜めの隣とつなぐ）
      for (const d of [0, 1, 2, 3]) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!g.inb(nx, ny)) continue;
        const j = ny * n + nx;
        if (!g.pline[j]) continue;
        if (d === 1 && (g.pline[y * n + x + 1] || g.pline[(y + 1) * n + x])) continue;
        if (d === 3 && (g.pline[y * n + x - 1] || g.pline[(y + 1) * n + x])) continue;
        const [sx, sy, sz] = top(j);
        for (const off of [-1.2, 1.2]) W.push(tx + off, ty - 0.9, tz, sx + off, sy - 0.9, sz);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(NN, 3));
    geo.setIndex(I);
    this.poles.geometry.dispose();
    this.poles.geometry = geo;
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(W, 3));
    this.wires.geometry.dispose();
    this.wires.geometry = wg;
  }
}
