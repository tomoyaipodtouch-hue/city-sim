// 道路と送電線の描画
//
// 道路はマスごとに「腕」（つながっている方向）を調べて形を作る。
//   1本：行き止まり（街路は丸い転回場）
//   2本：まっすぐ、またはなめらかなカーブ
//   3本以上：交差点（角が丸い路面、停止線、横断歩道）
// 路面、白線・黄線、歩道や壁などの立体物は、それぞれ別のメッシュにまとめる。
import * as THREE from 'three';
import { withAO } from './ao';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, isDiag } from '../sim/constants';
import { ROADS, RoadType, isHighway } from '../sim/defs';
import { addBridgeStructures } from './bridgeStyles';

export const ROAD_LIFT = 0.3;
const DIAG_LANE_W = 10.7; // 斜めの区間の、2マス幅の道路の1車線分の幅

const COL = {
  white: new THREE.Color(0xecece6),
  yellow: new THREE.Color(0xe3b62e),
  walk: new THREE.Color(0xb8b5ac),
  curb: new THREE.Color(0x8f8c85),
  barrier: new THREE.Color(0xc4c1b9),
  concrete: new THREE.Color(0xb3afa6),
  signal: new THREE.Color(0x3a3d40),
  island: new THREE.Color(0x5f8f44),
  glass: new THREE.Color(0x8fb4c9),
  busSign: new THREE.Color(0x2f86d0),
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
export class Buf {
  P: number[] = [];
  N: number[] = [];
  C: number[] = [];
  U: number[] = [];
  I: number[] = [];
  owner = -1; // いま作っている道路のノード（路面の三角形ごとに記録する）
  T: number[] = [];
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
    this.T.push(this.owner);
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
  ng: boolean; // 隣も地上の道路か（橋や高架につながる腕は、地面に合わせない）
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
    const smat = withAO(new THREE.MeshLambertMaterial({ vertexColors: true, map: asphaltTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), 0.32);
    this.surface = new THREE.Mesh(new THREE.BufferGeometry(), smat);
    this.surface.receiveShadow = true;
    this.marks = new THREE.Mesh(new THREE.BufferGeometry(), withAO(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), 0.32));
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
    // 地上の道路は、路面・歩道・線の高さを地面（造成した地形）に合わせる。
    // マスの中心の高さだけで描くと、坂道や、坂道どうしの交差点で地面が路面より上に出てしまうため
    let onGround = false, liftCur = 0;
    // 歩道と線は、いったんためておき、最後に「ほかの道路の路面の上に重なるもの」を取り除いてから描く
    const walkQ: { p: number[]; w: number[][] }[] = [];
    const lineQ: { p: number[]; c: THREE.Color; o: number }[] = [];
    const H = (x: number, z: number, fb: number) => (onGround ? g.groundAt(x, z) + ROAD_LIFT + liftCur : fb);

    // ---- 部品 ----
    // 中心線に沿った帯（路面・歩道・線）を作る
    // sides: [左（-p 側）, 右（+p 側）] に歩道や壁を付けるか。p は点の並び順に対して右向き
    // 地面に合わせるときは、点を細かくして地形の折れ目に沿わせる
    const densify = (pts: RP[], step: number): RP[] => {
      const out: RP[] = [pts[0]];
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const m = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step);
        for (let s2 = 1; s2 <= m; s2++) {
          const u = s2 / m;
          out.push({ x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), h: lerp(a.h, b.h, u), hw: lerp(a.hw, b.hw, u), sw: lerp(a.sw, b.sw, u), t: b.t });
        }
      }
      return out;
    };
    const ribbon = (pts0: RP[], t: number, sides: [boolean, boolean] = [true, true], fixedN?: [number, number]) => {
      if (pts0.length < 2) return;
      const pts = onGround && !fixedN ? densify(pts0, 3.5) : pts0;
      const asph = t === RoadType.Street ? COL.asphaltStreet : isHighway(t) ? COL.asphaltHw : COL.asphalt;
      const L: number[] = [], R: number[] = [];
      const nrm = pts.map((p, k) => {
        if (fixedN) return fixedN;
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        return [-dz / l, dx / l];
      });
      pts.forEach((p, k) => {
        const [px, pz] = nrm[k];
        const lx = p.x - px * p.hw, lz = p.z - pz * p.hw, rx = p.x + px * p.hw, rz = p.z + pz * p.hw;
        L.push(S.v(lx, H(lx, lz, p.h), lz, asph));
        R.push(S.v(rx, H(rx, rz, p.h), rz, asph));
      });
      for (let k = 0; k + 1 < pts.length; k++) {
        S.tri(L[k], R[k], R[k + 1]);
        S.tri(L[k], R[k + 1], L[k + 1]);
      }
      // 歩道（縁石つき）または高速道路の壁
      for (const side of [-1, 1]) {
        if (!sides[side < 0 ? 0 : 1]) continue;
        const walk = pts.map((p) => p.sw);
        const barrier = hasBarrier(t);
        if (!barrier && walk.every((w) => w <= 0)) continue;
        let prevIn = -1, prevOut = -1;
        let prev: number[] | null = null; // [内側 x, z, 高さ, 外側 x, z, 高さ]
        const up = barrier ? 0.95 : 0.16;
        pts.forEach((p, k) => {
          const [px, pz] = nrm[k];
          const ix = p.x + side * px * p.hw, iz = p.z + side * pz * p.hw;
          const wv = barrier ? 0.55 : p.sw;
          const ox = ix + side * px * wv, oz = iz + side * pz * wv;
          const hi = H(ix, iz, p.h), ho = H(ox, oz, p.h);
          if (barrier) {
            const a = O.v(ix, hi + up, iz, COL.barrier), b = O.v(ox, ho + up, oz, COL.barrier);
            if (k > 0 && prev) {
              O.tri(prevIn, prevOut, b);
              O.tri(prevIn, b, a);
              O.wall(prev[0], prev[1], prev[2] - 0.05, prev[2] + up, ix, iz, hi - 0.05, hi + up, COL.barrier);
            }
            prevIn = a;
            prevOut = b;
          } else if (prev && (p.sw > 0.05 || pts[k - 1].sw > 0.05)) {
            const walls = [[prev[0], prev[1], prev[2] - 0.05, prev[2] + up, ix, iz, hi - 0.05, hi + up]];
            // 歩道の外側の縁（地面とのすき間を隠す）
            if (onGround) walls.push([prev[3], prev[4], prev[5] - 1.2, prev[5] + up, ox, oz, ho - 1.2, ho + up]);
            walkQ.push({ p: [prev[0], prev[2] + up, prev[1], prev[3], prev[5] + up, prev[4], ox, ho + up, oz, ix, hi + up, iz], w: walls });
          }
          prev = [ix, iz, hi, ox, oz, ho];
        });
      }
    };
    // 中心線からの距離 off の位置に線を引く（dash = 破線）
    let lineN: [number, number] | null = null; // 線の横向きを固定する（広がるつなぎ目）
    const line = (pts: RP[], off: (p: RP) => number, c: THREE.Color, width = 0.16, dash = false) => {
      if (pts.length < 2) return;
      let acc = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz);
        if (l < 1e-3) continue;
        const px = lineN ? lineN[0] : -dz / l, pz = lineN ? lineN[1] : dx / l;
        // 破線は 3m 引いて 6m 空ける
        const steps = dash ? Math.max(1, Math.ceil(l / 1.5)) : onGround ? Math.max(1, Math.ceil(l / 3.5)) : 1;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const mid = acc + l * (t0 + t1) * 0.5;
          if (dash && mid % 9 > 3) continue;
          const pa = { x: lerp(a.x, b.x, t0), z: lerp(a.z, b.z, t0), h: lerp(a.h, b.h, t0), o: lerp(off(a), off(b), t0) };
          const pb = { x: lerp(a.x, b.x, t1), z: lerp(a.z, b.z, t1), h: lerp(a.h, b.h, t1), o: lerp(off(a), off(b), t1) };
          const mv = (q: { x: number; z: number; h: number; o: number }, o: number) => {
            const vx = q.x + px * o, vz = q.z + pz * o;
            return [vx, H(vx, vz, q.h) + 0.02, vz];
          };
          lineQ.push({ p: [...mv(pa, pa.o - width / 2), ...mv(pa, pa.o + width / 2), ...mv(pb, pb.o + width / 2), ...mv(pb, pb.o - width / 2)], c, o: S.owner });
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
        case RoadType.UrbanHighway:
        case RoadType.UrbanGroundHighway:
          // 片側1車線：中央の黄色の2本線と、両端の白線
          line(pts, () => -0.16, COL.yellow, 0.14);
          line(pts, () => 0.16, COL.yellow, 0.14);
          line(pts, (p) => -(p.hw - 0.45), COL.white, 0.15);
          line(pts, (p) => p.hw - 0.45, COL.white, 0.15);
          break;
        case RoadType.UrbanHighway1W:
        case RoadType.UrbanGroundHighway1W:
          // 一方通行2車線：真ん中に白の破線、両端に白線
          line(pts, () => 0, COL.white, 0.14, true);
          line(pts, (p) => -(p.hw - 0.45), COL.white, 0.15);
          line(pts, (p) => p.hw - 0.45, COL.white, 0.15);
          break;
        // ランプは短く斜めに重なるので、線は引かない
      }
    };
    // 円（転回場、ラウンドアバウト、つなぎ目）
    const disc = (cx: number, cz: number, h: number, r: number, c: THREE.Color, buf: Buf = S, seg = 20) => {
      const dh = h - H(cx, cz, h); // 島など、路面より高いものはその分だけ持ち上げる
      const ci = buf.v(cx, h, cz, c);
      const ring: number[] = [];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const rx = cx + Math.cos(a) * r, rz = cz + Math.sin(a) * r;
        ring.push(buf.v(rx, H(rx, rz, h) + dh, rz, c));
      }
      for (let s = 0; s < seg; s++) buf.tri(ci, ring[s], ring[(s + 1) % seg]);
    };
    // 円弧の歩道
    const ringWalk = (cx: number, cz: number, h: number, r0: number, r1: number, a0: number, a1: number) => {
      const seg = 16;
      for (let s = 0; s <= seg; s++) {
        const a = a0 + ((a1 - a0) * s) / seg;
        const cs = Math.cos(a), sn = Math.sin(a);
        const ix = cx + cs * r0, iz = cz + sn * r0, ox = cx + cs * r1, oz = cz + sn * r1;
        const hi = H(ix, iz, h), ho = H(ox, oz, h);
        if (s > 0) {
          const ap = a0 + ((a1 - a0) * (s - 1)) / seg;
          const qx = cx + Math.cos(ap) * r0, qz = cz + Math.sin(ap) * r0, hq = H(qx, qz, h);
          const rx = cx + Math.cos(ap) * r1, rz = cz + Math.sin(ap) * r1, hr = H(rx, rz, h);
          const walls = [[qx, qz, hq - 0.05, hq + 0.16, ix, iz, hi - 0.05, hi + 0.16]];
          if (onGround) walls.push([rx, rz, hr - 1.2, hr + 0.16, ox, oz, ho - 1.2, ho + 0.16]);
          walkQ.push({ p: [qx, hq + 0.16, qz, rx, hr + 0.16, rz, ox, ho + 0.16, oz, ix, hi + 0.16, iz], w: walls });
        }
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

    // 路面の矢印（2車線分）
    const arrow = (x0: number, z0: number, h: number, ux: number, uz: number, w: number) => {
      const px = -uz, pz = ux;
      for (const o of [-w * 0.2, w * 0.2]) {
        const bx = x0 + px * o, bz = z0 + pz * o;
        const at = (s: number, l: number) => [bx + ux * s + px * l, bz + uz * s + pz * l];
        const q = [at(-2.6, -0.2), at(0.6, -0.2), at(0.6, 0.2), at(-2.6, 0.2)].map(([qx, qz]) => M.v(qx, H(qx, qz, h) + 0.03, qz, COL.white));
        M.tri(q[0], q[1], q[2]);
        M.tri(q[0], q[2], q[3]);
        const hd = [at(0.6, -0.85), at(2.8, 0), at(0.6, 0.85)].map(([qx, qz]) => M.v(qx, H(qx, qz, h) + 0.03, qz, COL.white));
        M.tri(hd[0], hd[1], hd[2]);
      }
    };

    // 持ち上げた道路（立体交差の取り付け部分）の両側の壁
    const embank = (pts: RP[]) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const px = -dz / l, pz = dx / l;
        for (const sd of [-1, 1]) {
          const wa = a.hw + a.sw, wb = b.hw + b.sw;
          const ax = a.x + sd * px * wa, az = a.z + sd * pz * wa, bx = b.x + sd * px * wb, bz = b.z + sd * pz * wb;
          O.wall(ax, az, g.groundAt(ax, az) - 0.5, a.h + 0.16, bx, bz, g.groundAt(bx, bz) - 0.5, b.h + 0.16, COL.concrete);
        }
      }
    };

    // ---- マス（ノード）ごと ----
    for (let node = 0; node < 2 * NC; node++) {
      const level = node >= NC ? 1 : 0;
      const i = node - level * NC;
      const t = level ? g.up[i] : g.road[i];
      if (!t) continue;
      S.owner = node;
      const x = i % n, y = (i / n) | 0;
      const cx = (x + 0.5) * CELL, cz = (y + 0.5) * CELL;
      const ch = g.nodeH(node) + ROAD_LIFT;
      const def = ROADS[t];
      const w = def.width, sw = sidewalkOf(t);
      const m = level ? g.conn1[i] : g.conn[i];
      const ground = g.cellH(x, y);
      const elevated = level === 1 || g.deck[i] > 0;
      const raised = level === 0 && g.lift[i] > 0.3;
      const nodeGround = !elevated && !raised;
      onGround = nodeGround;
      liftCur = level === 0 ? g.lift[i] : 0;
      const arms: Arm[] = [];
      // 2車線（大通り）と1車線の道路のつなぎ目
      const wideLocal = (tt: number) => tt !== 0 && !!ROADS[tt]?.wide && !isHighway(tt);
      const nb = (c: number, d: number) => { const qx = (c % n) + DX[d], qy = ((c / n) | 0) + DY[d]; return g.inb(qx, qy) ? qy * n + qx : -1; };
      let taper: { d: number; side: number } | null = null; // この道路の腕 d が、横（side の向き）に広がって大通りにつながる
      let openEnd = -1; // 大通りの車線が、ここで1車線の道路に合流する（反対向きに、マスの端までのばす）
      const skip = new Set<number>();
      if (level === 0) {
        for (let d = 0; d < 8; d++) {
          if (!(m & (1 << d))) continue;
          const j = nb(i, d);
          if (j < 0) continue;
          if (!wideLocal(t) && wideLocal(g.road[j]) && !isDiag(d)) {
            // 隣が大通りの車線で、その横の車線にも斜めにつながっている → 広がりながらつなぐ
            for (const p of [(d + 2) & 7, (d + 6) & 7]) {
              const Y = nb(j, p);
              if (Y < 0 || g.road[Y] !== g.road[j]) continue;
              const diag = [1, 3, 5, 7].find((dd) => nb(i, dd) === Y);
              if (diag !== undefined && m & (1 << diag)) { taper = { d, side: p }; skip.add(diag); }
            }
          }
          if (wideLocal(t) && isDiag(d) && !wideLocal(g.road[j]) && g.road[j]) skip.add(d); // 大通り側の斜めのつなぎは描かない
          // 大通りの端の折り返し（横の車線へのつなぎ）は描かない
          if (wideLocal(t) && !isDiag(d) && g.road[j] === t && !(m & (1 << ((d + 4) & 7)))) {
            const along = [0, 2, 4, 6].filter((q) => q !== d && q !== ((d + 4) & 7) && m & (1 << q));
            if (along.length === 1) skip.add(d);
          }
        }
        if (wideLocal(t)) {
          // 斜めに1車線の道路へつながっている車線：腕は後ろだけなので、前へのばす
          const diagTo = [1, 3, 5, 7].some((dd) => m & (1 << dd) && skip.has(dd));
          const straight = [0, 2, 4, 6].filter((q) => m & (1 << q) && !skip.has(q));
          if (diagTo && straight.length === 1) openEnd = (straight[0] + 4) & 7;
        }
      }
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d)) || skip.has(d)) continue;
        const nx = x + DX[d], ny = y + DY[d];
        const len = Math.hypot(DX[d], DY[d]);
        let tn = t, eh = ch, ng = true;
        if (g.inb(nx, ny)) {
          const j = ny * n + nx;
          const nl = g.arriveLevel(level, j, d);
          tn = (nl ? g.up[j] : g.road[j]) || t;
          eh = (ch + g.nodeH(nl * NC + j) + ROAD_LIFT) / 2;
          ng = nl === 0 && g.deck[j] === 0 && g.lift[j] <= 0.3;
        }
        // 2マス幅の道路（大通り・高速道路）は、斜めだと車線の間隔が約11.3mになるので細くする
        const capW = (tt: number, ww: number) => (ROADS[tt]?.wide && isDiag(d) ? Math.min(ww, DIAG_LANE_W) : ww);
        const wa = capW(t, w);
        const wn = capW(tn, ROADS[tn]?.width ?? w);
        const keepW = (wideLocal(t) && !wideLocal(tn)) || (taper && taper.d === d);
        arms.push({
          d, ux: DX[d] / len, uz: DY[d] / len, L: (CELL * len) / 2, ang: Math.atan2(DY[d], DX[d]),
          w: wa, wm: keepW ? wa : (wa + wn) / 2, sw, swm: (sw + sidewalkOf(tn)) / 2, eh, t, tn, ng,
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
      // 橋や高架につながるマスは、地面に合わせずに中心の高さで描く
      onGround = nodeGround && (arms.length >= 3 || arms.every((a) => a.ng));
      const ctl = level === 0 && this.jctl.length === NC ? this.jctl[i] : 0;
      const asph = t === RoadType.Street ? COL.asphaltStreet : isHighway(t) ? COL.asphaltHw : COL.asphalt;

      // バス停：歩道に待合所、車道の端に停車スペースの印
      if (level === 0 && g.bstop[i] && arms.length) {
        const a0 = arms.find((q) => !isDiag(q.d)) ?? arms[0];
        const ux = a0.ux, uz = a0.uz, px = -uz, pz = ux;
        const hw = w / 2, so = hw + Math.max(sw, 1.2) * 0.55;
        const at = (s2: number, o: number): [number, number] => [cx + ux * s2 + px * o, cz + uz * s2 + pz * o];
        // 停車スペース（黄色の枠）
        const box: [number, number][] = [at(-4.5, hw - 2.8), at(4.5, hw - 2.8), at(4.5, hw - 0.4), at(-4.5, hw - 0.4)];
        for (let e = 0; e < 4; e++) {
          const [x0, z0] = box[e], [x1, z1] = box[(e + 1) % 4];
          line([{ x: x0, z: z0, h: ch, hw: 0, sw: 0, t }, { x: x1, z: z1, h: ch, hw: 0, sw: 0, t }], () => 0, COL.yellow, 0.18);
        }
        // 待合所
        const [sx, sz] = at(0, so);
        const y0 = ch + 0.16;
        for (const s2 of [-1.4, 1.4]) {
          const [qx, qz] = at(s2, so + 0.5);
          O.box(qx - 0.06, y0, qz - 0.06, qx + 0.06, y0 + 2.5, qz + 0.06, COL.signal);
        }
        const [bx0, bz0] = at(-1.5, so + 0.55), [bx1, bz1] = at(1.5, so + 0.55);
        O.wall(bx0, bz0, y0, y0 + 2.3, bx1, bz1, y0, y0 + 2.3, COL.glass);
        O.box(Math.min(sx - 1.6, sx + 1.6), y0 + 2.5, Math.min(sz - 1.6, sz + 1.6), Math.max(sx - 1.6, sx + 1.6), y0 + 2.65, Math.max(sz - 1.6, sz + 1.6), COL.signal);
        const [gx, gz] = at(2.4, so - 0.2);
        O.box(gx - 0.05, y0, gz - 0.05, gx + 0.05, y0 + 2.8, gz + 0.05, COL.signal);
        O.box(gx - 0.35, y0 + 2.3, gz - 0.35, gx + 0.35, y0 + 3.0, gz + 0.35, COL.busSign);
      }

      if (k === 0) {
        disc(cx, cz, ch, w / 2, asph);
        continue;
      }
      const opposite = k === 2 && ((arms[0].d + 4) & 7) === arms[1].d;
      if (k === 1 && openEnd >= 0) {
        // 大通りの車線の端：1車線の道路へ広がって合流するので、マスの端までまっすぐのばす
        const a = arms[0];
        const fx = DX[openEnd], fz = DY[openEnd];
        const pts: RP[] = [...armPts(a, 0).reverse(), { x: cx + fx * CELL * 0.5, z: cz + fz * CELL * 0.5, h: ch, hw: a.w / 2, sw: a.sw, t }];
        // 中央分離帯の側（相手の車線の側）には歩道を付けない
        ribbon(pts, t);
        markings(pts, t);
        continue;
      }
      if (k === 2 && opposite && taper) {
        // 1車線の道路が、大通りの2つの車線の幅に広がってつながる
        // マス全体（後ろの端から前の端まで）で、大通りの側にだけ広げる。外側の縁はまっすぐ
        const ta = arms.find((q) => q.d === taper!.d)!, other = arms.find((q) => q !== ta)!;
        const sx = DX[taper.side], sz = DY[taper.side];
        const wn = ROADS[ta.tn]?.width ?? w;
        const tp: RP[] = [];
        for (let s2 = 0; s2 <= 12; s2++) {
          const f = s2 / 12, e = f * f * (3 - 2 * f);
          const along = -other.L + (other.L + ta.L) * f;
          const half = lerp(w / 2, CELL / 2 + wn / 2, e);
          const shift = half - w / 2 - lerp(0, (wn - w) / 2, e); // 外側の縁が、道路の縁から大通りの外側の縁へ少しだけ動く
          tp.push({ x: cx + ta.ux * along + sx * shift, z: cz + ta.uz * along + sz * shift, h: lerp(other.eh, ta.eh, f), hw: half, sw: lerp(other.swm, sidewalkOf(ta.tn), e), t });
        }
        // 帯の右向き（進む向きに対して）が、広がる側かどうかで符号を合わせる
        const rx = -ta.uz, rz = ta.ux;
        const N: [number, number] = [rx, rz];
        ribbon(tp, t, [true, true], N);
        lineN = N;
        markings(tp, t);
        lineN = null;
        continue;
      }
      if (k === 1) {
        // 行き止まり
        const a = arms[0];
        const pts = armPts(a, 0).reverse();
        const back = Math.atan2(-a.uz, -a.ux);
        if (t === RoadType.Street) {
          // 袋小路の転回場。腕の歩道は、転回場の円と交わるところで止める
          const r = w * 0.95, off = 1.5;
          const hw = a.w / 2;
          const cut = Math.sqrt(Math.max(0, r * r - hw * hw)) - off; // 中心から、歩道が円にぶつかるまでの距離
          const P: RP = { x: cx + a.ux * cut, z: cz + a.uz * cut, h: lerp(ch, a.eh, cut / a.L), hw, sw: a.sw, t };
          ribbon([pts[0], P], t);
          ribbon([P, pts[1]], t, [false, false]);
          markings(pts, t);
          if (elevated) deckUnder(pts, level ? ground : null);
          disc(cx - a.ux * off, cz - a.uz * off, ch, r, asph);
          const open = Math.asin(Math.min(1, hw / r));
          ringWalk(cx - a.ux * off, cz - a.uz * off, ch, r, r + sw, back - (Math.PI - open), back + (Math.PI - open));
          continue;
        }
        ribbon(pts, t);
        markings(pts, t);
        if (elevated) deckUnder(pts, level ? ground : null);
        if (false) {
          // 使わない
        } else if (hasBarrier(t)) {
          disc(cx, cz, ch, w / 2, asph);
          O.wall(cx - a.uz * (w / 2 + 0.5), cz + a.ux * (w / 2 + 0.5), ch - 0.05, ch + 0.95, cx + a.uz * (w / 2 + 0.5), cz - a.ux * (w / 2 + 0.5), ch - 0.05, ch + 0.95, COL.barrier);
        } else {
          disc(cx, cz, ch, w / 2, asph);
          if (sw > 0) ringWalk(cx, cz, ch, w / 2, w / 2 + sw, back - Math.PI / 2, back + Math.PI / 2);
        }
        continue;
      }
      if (k === 2 && t !== RoadType.Ramp && !arms.some((q) => q.tn === RoadType.Ramp && hasBarrier(t))) {
        const [a, b] = arms;
        let pts: RP[];
        if (opposite) {
          pts = [...armPts(a, 0).reverse(), ...armPts(b, 0).slice(1)];
          pts[1] = { ...pts[1], hw: Math.min(a.w, b.w) / 2, sw };
        } else {
          // なめらかなカーブ（2次ベジェ曲線）
          pts = [];
          const ax = cx + a.ux * a.L, az = cz + a.uz * a.L, bx = cx + b.ux * b.L, bz = cz + b.uz * b.L;
          const seg = 10;
          for (let s = 0; s <= seg; s++) {
            const u = s / seg;
            const p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
            const wc = Math.min(a.w, b.w);
            const half = u < 0.5 ? lerp(a.wm, wc, u * 2) : lerp(wc, b.wm, u * 2 - 1);
            const swv = u < 0.5 ? lerp(a.swm, sw, u * 2) : lerp(sw, b.swm, u * 2 - 1);
            pts.push({ x: p0 * ax + p1 * cx + p2 * bx, z: p0 * az + p1 * cz + p2 * bz, h: p0 * a.eh + p1 * ch + p2 * b.eh, hw: half / 2, sw: swv, t });
          }
        }
        // 進む向きから見て左側が中央分離帯（反対車線）。斜めの大通りでは、そちらの歩道を省く
        const forward = (g.flow[i] | g.flow1[i]) & (1 << b.d) ? true : false;
        const inner = forward ? 0 : 1;
        const sides: [boolean, boolean] = [true, true];
        if (def.wide && !isHighway(t) && (isDiag(a.d) || isDiag(b.d))) sides[inner] = false;
        ribbon(pts, t, sides);
        markings(pts, t);
        if (t === RoadType.OneWay && opposite) {
          // 一方通行の起点・終点（隣が一方通行のまっすぐな道路でない場所）に、進む向きの矢印を描く
          const straightOW = (q: Arm) => {
            const qx = x + DX[q.d], qy = y + DY[q.d];
            if (!g.inb(qx, qy)) return false;
            const j = qy * n + qx;
            return g.road[j] === RoadType.OneWay && g.conn[j] === ((1 << a.d) | (1 << b.d));
          };
          if (!straightOW(a) || !straightOW(b)) {
            const out = g.flow[i] & (1 << b.d) ? b : a;
            arrow(cx, cz, ch, out.ux, out.uz, w);
          }
        }
        if (elevated) deckUnder(pts, level ? ground : null);
        if (!elevated && (raised || pts.some((p) => p.h - ROAD_LIFT > g.groundAt(p.x, p.z) + 0.8))) embank(pts);
        continue;
      }

      // ---- 高速道路とランプの分岐・合流：交差点の形にせず、帯をそのままつなぐ ----
      if (hasBarrier(t)) {
        // 帯の右向きの法線
        const rightOf = (pts: RP[]) => {
          const p = pts[0], q = pts[pts.length - 1];
          const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
          return [-dz / l, dx / l];
        };
        if (t === RoadType.Ramp && k === 2) {
          // ランプの途中：まっすぐか曲線の帯。高速道路のすぐ横なら、そちら側の壁は省く
          const [a, b] = arms;
          const pts: RP[] = [];
          const ax = cx + a.ux * a.L, az = cz + a.uz * a.L, bx = cx + b.ux * b.L, bz = cz + b.uz * b.L;
          for (let s2 = 0; s2 <= 10; s2++) {
            const u = s2 / 10, p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
            const half = u < 0.5 ? lerp(a.wm, w, u * 2) : lerp(w, b.wm, u * 2 - 1);
            pts.push({ x: p0 * ax + p1 * cx + p2 * bx, z: p0 * az + p1 * cz + p2 * bz, h: p0 * a.eh + p1 * ch + p2 * b.eh, hw: Math.min(half, w) / 2, sw: 0, t });
          }
          const [px, pz] = rightOf(pts);
          const sides: [boolean, boolean] = [true, true];
          for (const sd of [0, 2, 4, 6]) {
            const qx = x + DX[sd], qy = y + DY[sd];
            if (!g.inb(qx, qy)) continue;
            const j = qy * n + qx;
            if (isHighway(level ? g.up[j] : g.road[j])) sides[DX[sd] * px + DY[sd] * pz > 0 ? 1 : 0] = false;
          }
          ribbon(pts, t, sides);
          if (elevated) deckUnder(pts, level ? ground : null);
          continue;
        }
        if (t === RoadType.Ramp) {
          // ランプ：高速道路へ向かう2本の腕を曲線でつなぎ、高速道路と反対側にだけ壁を付ける
          const hw = arms.filter((q) => isHighway(q.tn));
          const others = arms.filter((q) => !isHighway(q.tn));
          if (hw.length === 2) {
            const [a, b] = hw;
            const pts: RP[] = [];
            const ax = cx + a.ux * a.L, az = cz + a.uz * a.L, bx = cx + b.ux * b.L, bz = cz + b.uz * b.L;
            for (let s2 = 0; s2 <= 10; s2++) {
              const u = s2 / 10, p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
              pts.push({ x: p0 * ax + p1 * cx + p2 * bx, z: p0 * az + p1 * cz + p2 * bz, h: p0 * a.eh + p1 * ch + p2 * b.eh, hw: w / 2, sw: 0, t });
            }
            // 2本の腕の向きの和が、高速道路のある側
            const sx = a.ux + b.ux, sz = a.uz + b.uz;
            const [px, pz] = rightOf(pts);
            const hwRight = sx * px + sz * pz > 0;
            ribbon(pts, t, hwRight ? [true, false] : [false, true]);
            if (elevated) deckUnder(pts, level ? ground : null);
          } else for (const a of hw) ribbon(armPts(a, 0).reverse(), t, [false, false]);
          for (const a of others) {
            onGround = nodeGround && a.ng; // 高架へ上がる腕は、地面に合わせない
            const pts = armPts(a, 0).reverse();
            ribbon(pts, t, [false, false]);
            if (elevated) deckUnder(pts, level ? ground : null);
          }
          onGround = nodeGround;
          disc(cx, cz, ch, w / 2, asph);
          continue;
        }
        // 高速道路：本線（反対向きの2本）はまっすぐな帯にして、ランプが分かれる側だけ壁を切る
        const ramps = arms.filter((q) => q.tn === RoadType.Ramp);
        const main = arms.filter((q) => q.tn !== RoadType.Ramp);
        const pair = main.length === 2 && ((main[0].d + 4) & 7) === main[1].d ? main : null;
        if (pair) {
          const [a, b] = pair;
          const pts = [...armPts(a, 0).reverse(), ...armPts(b, 0).slice(1)];
          pts[1] = { ...pts[1], hw: Math.min(a.w, b.w) / 2 };
          const [px, pz] = rightOf(pts);
          const sides: [boolean, boolean] = [true, true];
          for (const r of ramps) sides[r.ux * px + r.uz * pz > 0 ? 1 : 0] = false;
          ribbon(pts, t, sides);
          markings(pts, t);
          if (elevated) deckUnder(pts, level ? ground : null);
        } else {
          for (const a of main) {
            const pts = armPts(a, 0).reverse();
            ribbon(pts, t, ramps.length ? [false, false] : [true, true]);
            if (!isDiag(a.d)) markings(pts, t);
            if (elevated) deckUnder(pts, level ? ground : null);
          }
        }
        // ランプへ分かれる部分：壁も線もない路面
        for (const a of ramps) ribbon(armPts(a, 0).reverse(), t, [false, false]);
        disc(cx, cz, Math.min(...arms.map((q) => q.w)) / 2 > 0 ? ch : ch, Math.min(...arms.map((q) => q.w)) / 2, asph);
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
        onGround = nodeGround && a.ng;
        ribbon(pts, t);
        markings(pts, t);
        if (elevated) deckUnder(pts, level ? ground : null);
      });
      onGround = nodeGround;
      if (round) {
        disc(cx, cz, ch, R, asph, S, 32);
        const ri = R * 0.45, ra = R * 0.6; // 中央の島、トラック用のエプロン（少し高い石畳）
        disc(cx, cz, ch + 0.12, ra, COL.concrete, O, 28);
        for (let s2 = 0; s2 < 28; s2++) {
          const a0 = (s2 / 28) * Math.PI * 2, a1 = ((s2 + 1) / 28) * Math.PI * 2;
          O.wall(cx + Math.cos(a0) * ra, cz + Math.sin(a0) * ra, ch - 0.05, ch + 0.12, cx + Math.cos(a1) * ra, cz + Math.sin(a1) * ra, ch - 0.05, ch + 0.12, COL.curb);
          O.wall(cx + Math.cos(a0) * ri, cz + Math.sin(a0) * ri, ch + 0.1, ch + 0.4, cx + Math.cos(a1) * ri, cz + Math.sin(a1) * ri, ch + 0.1, ch + 0.4, COL.curb);
        }
        disc(cx, cz, ch + 0.4, ri, COL.island, O, 24);
        // 島の植え込みと記念塔
        disc(cx, cz, ch + 0.45, ri * 0.55, new THREE.Color(0xc26f8e), O, 16);
        disc(cx, cz, ch + 0.5, ri * 0.32, new THREE.Color(0xe8c54a), O, 12);
        O.box(cx - 0.6, ch + 0.4, cz - 0.6, cx + 0.6, ch + 3.2, cz + 0.6, COL.barrier);
        O.box(cx - 0.9, ch + 3.2, cz - 0.9, cx + 0.9, ch + 3.5, cz + 0.9, COL.barrier);
        // 外側の白線（円）
        const ring: RP[] = [];
        for (let s2 = 0; s2 <= 40; s2++) {
          const a0 = (s2 / 40) * Math.PI * 2;
          ring.push({ x: cx + Math.cos(a0) * (R - 0.6), z: cz + Math.sin(a0) * (R - 0.6), h: ch, hw: 0, sw: 0, t });
        }
        // 腕の入口の部分は線を引かない
        const angs = arms.map((q) => q.ang);
        const near = (p: RP) => angs.some((an) => { let d = Math.atan2(p.z - cz, p.x - cx) - an; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) < 0.62; });
        let seg: RP[] = [];
        for (const p of ring) {
          if (near(p)) { if (seg.length > 1) line(seg, () => 0, COL.white, 0.15); seg = []; } else seg.push(p);
        }
        if (seg.length > 1) line(seg, () => 0, COL.white, 0.15);
        for (const a of arms) {
          const px = -a.uz, pz = a.ux;
          const s0 = R + 0.2;
          // ゆずれの線（入ってくる車線、-p 側）：白い三角の列
          for (let o = -a.w / 2 + 0.5; o < -0.4; o += 0.9) {
            const bx = cx + a.ux * s0 + px * o, bz = cz + a.uz * s0 + pz * o;
            line([{ x: bx, z: bz, h: ch, hw: 0, sw: 0, t }, { x: bx + a.ux * 0.6, z: bz + a.uz * 0.6, h: ch, hw: 0, sw: 0, t }], () => 0, COL.white, 0.4);
          }
          // 分離島（両方向の道路だけ）：入口の真ん中の細長い島
          if (!ROADS[a.t]?.oneWay && !ROADS[a.tn]?.oneWay) {
            const s1 = R + 0.6, s2 = Math.min(a.L - 0.3, R + 5.5);
            if (s2 > s1 + 1) {
              const P = (sAlong: number, o: number) => [cx + a.ux * sAlong + px * o, cz + a.uz * sAlong + pz * o];
              const q = [P(s1, 0), P(s1 + 1.2, -0.9), P(s2, -0.5), P(s2, 0.5), P(s1 + 1.2, 0.9)];
              const top = q.map(([x, z]) => O.v(x, ch + 0.25, z, COL.island));
              for (let e = 1; e + 1 < top.length; e++) O.tri(top[0], top[e], top[e + 1]);
              for (let e = 0; e < q.length; e++) {
                const [x0, z0] = q[e], [x1, z1] = q[(e + 1) % q.length];
                O.wall(x0, z0, ch - 0.05, ch + 0.25, x1, z1, ch - 0.05, ch + 0.25, COL.curb);
              }
            }
          }
        }
        // 腕と腕の間の歩道
        const sorted = [...arms].sort((p, q) => p.ang - q.ang);
        for (let k2 = 0; k2 < sorted.length; k2++) {
          const a = sorted[k2], b = sorted[(k2 + 1) % sorted.length];
          const ga = Math.asin(Math.min(0.95, (a.w / 2 + 0.4) / R)), gb = Math.asin(Math.min(0.95, (b.w / 2 + 0.4) / R));
          let a0 = a.ang + ga, a1 = b.ang - gb;
          if (k2 === sorted.length - 1) a1 += Math.PI * 2;
          const swr = Math.min(sidewalkOf(a.t) || 0, sidewalkOf(b.t) || 0) || 1.6;
          if (a1 - a0 > 0.1) ringWalk(cx, cz, ch, R, R + swr, a0, a1);
        }
        continue;
      }
      // 角の丸い路面：腕の端の角どうしを曲線でつなぐ
      const ci = S.v(cx, H(cx, cz, ch), cz, asph);
      const outline: number[] = [];
      for (let k2 = 0; k2 < arms.length; k2++) {
        const a = arms[k2], b = arms[(k2 + 1) % arms.length];
        const sa = starts[k2], sb = starts[(k2 + 1) % arms.length];
        const pa = [-a.uz, a.ux], pb = [-b.uz, b.ux];
        // 45° の鋭い角：角を丸めず、歩道も付けない（ほかの道路の上にはみ出すため）
        const gap = (b.ang - a.ang + Math.PI * 4) % (Math.PI * 2);
        const acute = gap < 1.2;
        const Ra = [cx + a.ux * sa + pa[0] * (a.w / 2), cz + a.uz * sa + pa[1] * (a.w / 2)];
        const Lb = [cx + b.ux * sb - pb[0] * (b.w / 2), cz + b.uz * sb - pb[1] * (b.w / 2)];
        // 2本の道路の端の線が交わる点を、曲線の制御点にする
        const det = a.ux * b.uz - a.uz * b.ux;
        let K = [(Ra[0] + Lb[0]) / 2, (Ra[1] + Lb[1]) / 2];
        if (Math.abs(det) > 1e-3) {
          const dx = Lb[0] - Ra[0], dz = Lb[1] - Ra[1];
          const tA = (dx * b.uz - dz * b.ux) / det;
          const cand = [Ra[0] + a.ux * tA, Ra[1] + a.uz * tA];
          if (!acute && Math.hypot(cand[0] - cx, cand[1] - cz) < maxHalf * 2.2) K = cand;
        }
        const seg = 6;
        const curve: [number, number][] = [];
        for (let s = 0; s <= seg; s++) {
          const u = s / seg;
          const p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
          curve.push([p0 * Ra[0] + p1 * K[0] + p2 * Lb[0], p0 * Ra[1] + p1 * K[1] + p2 * Lb[1]]);
        }
        for (const [px, pz] of curve) outline.push(S.v(px, H(px, pz, ch), pz, asph));
        // 角の歩道
        const swc = Math.min(sidewalkOf(a.t) || 0, sidewalkOf(b.t) || 0);
        if (swc > 0 && !acute) {
          let prev: number[] | null = null;
          curve.forEach(([px, pz]) => {
            const dx = px - cx, dz = pz - cz;
            const l = Math.hypot(dx, dz) || 1;
            const ox = px + (dx / l) * swc, oz = pz + (dz / l) * swc;
            const hi = H(px, pz, ch), ho = H(ox, oz, ch);
            if (prev) {
              const walls = [[prev[0], prev[1], prev[2] - 0.05, prev[2] + 0.16, px, pz, hi - 0.05, hi + 0.16]];
              if (onGround) walls.push([prev[3], prev[4], prev[5] - 1.2, prev[5] + 0.16, ox, oz, ho - 1.2, ho + 0.16]);
              walkQ.push({ p: [prev[0], prev[2] + 0.16, prev[1], prev[3], prev[5] + 0.16, prev[4], ox, ho + 0.16, oz, px, hi + 0.16, pz], w: walls });
            }
            prev = [px, pz, hi, ox, oz, ho];
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
    // ---- 斜めの道路どうしが X 字に交わる角：交差点の路面 ----
    for (let i = 0; i < NC; i++) {
      const t = g.road[i];
      if (!t || g.up[i]) continue;
      const x = i % n, y = (i / n) | 0;
      for (const d of [1, 3]) {
        if (!(g.conn[i] & (1 << d))) continue;
        const ax = x + DX[d], ay = y, bx = x, by = y + DY[d];
        if (!g.inb(ax, ay) || !g.inb(bx, by)) continue;
        const dd = d === 1 ? 3 : 1; // (ax,ay) → (bx,by) の向き
        if (!(g.conn[ay * n + ax] & (1 << dd))) continue;
        const t2 = g.road[ay * n + ax];
        const cx = (x + 0.5 + DX[d] / 2) * CELL, cz = (y + 0.5 + DY[d] / 2) * CELL;
        const w = Math.max(ROADS[t].width, ROADS[t2]?.width ?? 0);
        S.owner = -3;
        onGround = true;
        liftCur = 0;
        const asph = t === RoadType.Street || t2 === RoadType.Street ? COL.asphaltStreet : COL.asphalt;
        disc(cx, cz, g.groundAt(cx, cz) + ROAD_LIFT + 0.04, w * 0.78, asph, S, 24);
      }
    }
    onGround = false;

    // ---- 重なりの取り除き ----
    // 路面の三角形を、マスごとの入れ物に分けておく
    const buckets = new Map<number, number[]>();
    const SP = S.P, SI = S.I;
    for (let t3 = 0; t3 < SI.length / 3; t3++) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let q = 0; q < 3; q++) {
        const vi = SI[t3 * 3 + q];
        x0 = Math.min(x0, SP[vi * 3]); x1 = Math.max(x1, SP[vi * 3]);
        z0 = Math.min(z0, SP[vi * 3 + 2]); z1 = Math.max(z1, SP[vi * 3 + 2]);
      }
      for (let by = Math.floor(z0 / CELL); by <= Math.floor(z1 / CELL); by++)
        for (let bx = Math.floor(x0 / CELL); bx <= Math.floor(x1 / CELL); bx++) {
          const key = by * 4096 + bx;
          (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(t3);
        }
    }
    // 点 (x, z) が、owner 以外の道路の路面の内側（ふちから少し内側）にあるか
    const onOtherRoad = (x: number, z: number, owner: number) => {
      const list = buckets.get(Math.floor(z / CELL) * 4096 + Math.floor(x / CELL));
      if (!list) return false;
      for (const t3 of list) {
        if (S.T[t3] === owner) continue;
        const a = SI[t3 * 3], b = SI[t3 * 3 + 1], c = SI[t3 * 3 + 2];
        const ax = SP[a * 3], az = SP[a * 3 + 2], bx = SP[b * 3], bz = SP[b * 3 + 2], cx = SP[c * 3], cz = SP[c * 3 + 2];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-6) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 > 0.02 && l2 > 0.02 && l3 > 0.02) return true;
      }
      return false;
    };
    // 中心と4つの角のうち、2つ以上がほかの道路の上にあれば重なっているとみなす
    const overlaps = (p: number[], owner: number) => {
      const mx = (p[0] + p[3] + p[6] + p[9]) / 4, mz = (p[2] + p[5] + p[8] + p[11]) / 4;
      let k = onOtherRoad(mx, mz, owner) ? 1 : 0;
      for (let c = 0; c < 4 && k < 2; c++) if (onOtherRoad(p[c * 3] * 0.8 + mx * 0.2, p[c * 3 + 2] * 0.8 + mz * 0.2, owner)) k++;
      return k >= 2;
    };
    for (const q of walkQ) {
      const p = q.p;
      if (overlaps(p, -2)) continue;
      const ids = [0, 1, 2, 3].map((k) => O.v(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], COL.walk));
      O.tri(ids[0], ids[1], ids[2]);
      O.tri(ids[0], ids[2], ids[3]);
      for (const w of q.w) O.wall(w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], COL.curb);
    }
    for (const q of lineQ) {
      const p = q.p;
      // 線は細いので、両端と中心のどれかがほかの道路の上なら消す
      const mx = (p[0] + p[3] + p[6] + p[9]) / 4, mz = (p[2] + p[5] + p[8] + p[11]) / 4;
      const ax = (p[0] + p[3]) / 2, az = (p[2] + p[5]) / 2, bx = (p[6] + p[9]) / 2, bz = (p[8] + p[11]) / 2;
      if (onOtherRoad(mx, mz, q.o) || onOtherRoad(ax * 0.9 + mx * 0.1, az * 0.9 + mz * 0.1, q.o) || onOtherRoad(bx * 0.9 + mx * 0.1, bz * 0.9 + mz * 0.1, q.o)) continue;
      const ids = [0, 1, 2, 3].map((k) => M.v(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], q.c));
      M.tri(ids[0], ids[1], ids[2]);
      M.tri(ids[0], ids[2], ids[3]);
    }
    addBridgeStructures(g, O, ROAD_LIFT);
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
