// 高速鉄道の線路（高架橋・盛土・スラブ軌道・架線・防音壁・橋脚）と列車の描画。
//
// 線路の形は sim/hsr の hsrPoly（大きなカーブでなめらかにした線）を、横に広げて作る。
// 形は 32×32 マスの区画ごとに 1 つのメッシュにまとめ、区画ごとに正しい囲み（bounding sphere）で画面の外を省く。
// 列車は先頭車と中間車の 2 つのインスタンスメッシュで、全部の列車をそれぞれ 1 回で描く（毎フレーム配列を作らない）。
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import { hsrBits, hsrChains, hsrPoly, hsrAt, HsrPoly, HSRF_STATION, HSR_GIRDER, HSR_PLAT, HSR_STN_LEN, HSR_TRACK, resNear, stnCell } from '../sim/hsr';
import { HsrOps, HSR_CAR_GAP, HSR_CAR_L, HSR_MAX_CARS, stationWeight } from '../sim/hsrOps';
import type { Building } from '../sim/world';
import { createInfraMaterial, matColor, PbrBuf, RM } from './infraMaterial';
import { createVehicleMaterial } from './vehicleMaterial';
import { hsrCar } from './vehicles';

const CH = 32; // 区画の大きさ（マス）
const COL = {
  deck: matColor(0xbdb9b0, RM.concrete),
  girder: matColor(0xc9c5bc, RM.concrete),
  under: matColor(0xa29e96, RM.concrete),
  parapet: matColor(0xd3d0c8, RM.concrete),
  slab: matColor(0x9d9a94, RM.concrete),
  rail: matColor(0xc4c8cd, RM.rail),
  wire: matColor(0x2b2e32, RM.wire),
  mast: matColor(0x9aa2a8, RM.steel),
  barrier: matColor(0x8c9a96, RM.panel), // 防音壁（アルミのパネル）
  barrierTop: matColor(0x6f7a77, RM.alu),
  pier: matColor(0xc2beb5, RM.concrete),
  ballast: matColor(0x8f887c, RM.ballast),
  embank: matColor(0x7d8a5a, RM.plain), // 盛土の斜面（草）
  stop: matColor(0xc9302c, RM.plastic), // 車止め
};

type V3 = [number, number, number];

// 一方向だけの四角（法線 n の側から見える）
function quad(B: PbrBuf, a: V3, b: V3, c: V3, d: V3, col: THREE.Color, n: V3) {
  const i0 = B.v(a[0], a[1], a[2], col, n[0], n[1], n[2]), i1 = B.v(b[0], b[1], b[2], col, n[0], n[1], n[2]);
  const i2 = B.v(c[0], c[1], c[2], col, n[0], n[1], n[2]), i3 = B.v(d[0], d[1], d[2], col, n[0], n[1], n[2]);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) B.I.push(i0, i1, i2, i0, i2, i3);
  else B.I.push(i0, i2, i1, i0, i3, i2);
}
// 向きのついた箱（中心 cx, cz、u = 線路の向き）。下の面は省く
function obox(B: PbrBuf, cx: number, cz: number, ux: number, uz: number, a0: number, a1: number, o0: number, o1: number, y0: number, y1: number, col: THREE.Color) {
  const px = -uz, pz = ux;
  const P = (a: number, o: number, y: number): V3 => [cx + ux * a + px * o, y, cz + uz * a + pz * o];
  quad(B, P(a1, o0, y0), P(a1, o1, y0), P(a1, o1, y1), P(a1, o0, y1), col, [ux, 0, uz]);
  quad(B, P(a0, o0, y0), P(a0, o1, y0), P(a0, o1, y1), P(a0, o0, y1), col, [-ux, 0, -uz]);
  quad(B, P(a0, o1, y0), P(a1, o1, y0), P(a1, o1, y1), P(a0, o1, y1), col, [px, 0, pz]);
  quad(B, P(a0, o0, y0), P(a1, o0, y0), P(a1, o0, y1), P(a0, o0, y1), col, [-px, 0, -pz]);
  quad(B, P(a0, o0, y1), P(a1, o0, y1), P(a1, o1, y1), P(a0, o1, y1), col, [0, 1, 0]);
}

export interface HsrSpan { s0: number; s1: number }
// 線の上の駅（ホームのマスのまとまり）の道のりの範囲
export function stationSpans(g: Grid, P: HsrPoly): HsrSpan[] {
  const out: HsrSpan[] = [];
  let open: HsrSpan | null = null;
  for (let k = 0; k < P.cells.length; k++) {
    const st = (g.hsrf[P.cells[k]] & HSRF_STATION) !== 0;
    const s = P.cellS[k];
    if (st) {
      if (open && s - open.s1 < CELL * 1.6) open.s1 = s + CELL / 2;
      else { open = { s0: s - CELL / 2, s1: s + CELL / 2 }; out.push(open); }
    } else open = null;
  }
  return out;
}

export class HsrLayer {
  group = new THREE.Group();
  private material = createInfraMaterial();
  private chunks = new Map<number, THREE.Mesh>();
  trains = new HsrTrains();
  tris = 0; // 線路の三角形の数（確かめる用）

  constructor() {
    this.group.add(this.trains.group);
  }

  // 線路の形を作り直す（線路・駅・住宅地のゾーン・地形が変わったとき）
  rebuild(g: Grid, list: Building[], riders?: Float32Array) {
    const n = g.n, cpr = Math.ceil(n / CH);
    const bufs = new Map<number, PbrBuf>();
    const bufAt = (x: number, z: number) => {
      const cx = Math.max(0, Math.min(cpr - 1, Math.floor(x / CELL / CH))), cz = Math.max(0, Math.min(cpr - 1, Math.floor(z / CELL / CH)));
      const k = cz * cpr + cx;
      let b = bufs.get(k);
      if (!b) bufs.set(k, (b = new PbrBuf()));
      b.withUV = false;
      return b;
    };
    const pin = stationPins(g, list);
    for (const ch of hsrChains(g)) {
      const P = hsrPoly(g, ch.cells, pin, ch.pre, ch.post, ch.loop);
      if (P.n < 2) continue;
      const ext = edgeExtend(g, P, ch.cells);
      this.sweep(g, ext, stationSpans(g, P), bufAt, ch.cells);
    }
    // 区画のメッシュを入れ替える
    for (const m of this.chunks.values()) { this.group.remove(m); m.geometry.dispose(); }
    this.chunks.clear();
    this.tris = 0;
    for (const [k, B] of bufs) {
      if (!B.I.length) continue;
      const geo = B.geometry();
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const m = new THREE.Mesh(geo, this.material);
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.chunks.set(k, m);
      this.tris += B.I.length / 3;
    }
    this.trains.rebuild(g, list, riders);
  }
  get chunkCount() { return this.chunks.size; }

  // 線に沿って、高架橋・盛土・軌道・架線・防音壁・橋脚を作る
  private sweep(g: Grid, P: HsrPoly, spans: HsrSpan[], bufAt: (x: number, z: number) => PbrBuf, cells: number[]) {
    const N = P.n;
    const spread = new Float32Array(N), rx = new Float32Array(N), rz = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      let w = 0;
      for (const sp of spans) w = Math.max(w, stationWeight(sp, P.s[j]));
      spread[j] = w;
      const a = Math.max(0, j - 1), b = Math.min(N - 1, j + 1);
      const tx = P.x[b] - P.x[a], tz = P.z[b] - P.z[a], l = Math.hypot(tx, tz) || 1;
      rx[j] = -tz / l;
      rz[j] = tx / l;
    }
    const at = (j: number, o: number, y: number): V3 => [P.x[j] + rx[j] * o, y, P.z[j] + rz[j] * o];
    const tracks = (w: number) => (w > 0.002 ? [-HSR_TRACK, HSR_TRACK, -(HSR_TRACK + (HSR_PLAT - HSR_TRACK) * w), HSR_TRACK + (HSR_PLAT - HSR_TRACK) * w] : [-HSR_TRACK, HSR_TRACK]);
    let pierAcc = 14, mastAcc = 20;
    const UP: V3 = [0, 1, 0], DOWN: V3 = [0, -1, 0];
    for (let j = 0; j + 1 < N; j++) {
      const k = j + 1;
      const B = bufAt((P.x[j] + P.x[k]) / 2, (P.z[j] + P.z[k]) / 2);
      const hj = P.h[j], hk = P.h[k];
      const wj = spread[j], wk = spread[k];
      const hwj = 6.4 + (HSR_PLAT - HSR_TRACK) * wj, hwk = 6.4 + (HSR_PLAT - HSR_TRACK) * wk;
      const lift = (P.lift[j] + P.lift[k]) / 2;
      const elevated = lift > 3.6;
      const inStn = wj > 0.99 && wk > 0.99;
      const nOut = (s: number): V3 => [rx[j] * s, 0, rz[j] * s];
      if (elevated) {
        // 床版と、両側の縁（壁高欄）
        quad(B, at(j, -hwj, hj), at(j, hwj, hj), at(k, hwk, hk), at(k, -hwk, hk), COL.deck, UP);
        for (const s of [-1, 1]) {
          const top = inStn ? 0 : 1.0;
          quad(B, at(j, s * hwj, hj - 0.7), at(k, s * hwk, hk - 0.7), at(k, s * hwk, hk + top), at(j, s * hwj, hj + top), COL.parapet, nOut(s));
          if (!inStn) {
            quad(B, at(j, s * (hwj - 0.3), hj + 1.0), at(k, s * (hwk - 0.3), hk + 1.0), at(k, s * hwk, hk + 1.0), at(j, s * hwj, hj + 1.0), COL.parapet, UP);
            quad(B, at(j, s * (hwj - 0.3), hj), at(k, s * (hwk - 0.3), hk), at(k, s * (hwk - 0.3), hk + 1.0), at(j, s * (hwj - 0.3), hj + 1.0), COL.parapet, nOut(-s));
          }
          // 箱桁：張り出しの裏、斜めの腹板
          quad(B, at(j, s * hwj, hj - 0.7), at(k, s * hwk, hk - 0.7), at(k, s * 4.0, hk - 0.95), at(j, s * 4.0, hj - 0.95), COL.under, [rx[j] * s * 0.2, -1, rz[j] * s * 0.2]);
          quad(B, at(j, s * 4.0, hj - 0.95), at(k, s * 4.0, hk - 0.95), at(k, s * 2.9, hk - HSR_GIRDER), at(j, s * 2.9, hj - HSR_GIRDER), COL.girder, [rx[j] * s, -0.4, rz[j] * s]);
        }
        quad(B, at(j, -2.9, hj - HSR_GIRDER), at(j, 2.9, hj - HSR_GIRDER), at(k, 2.9, hk - HSR_GIRDER), at(k, -2.9, hk - HSR_GIRDER), COL.under, DOWN);
      } else {
        // 盛土：上の面（バラスト）と、両側の斜面
        quad(B, at(j, -hwj, hj), at(j, hwj, hj), at(k, hwk, hk), at(k, -hwk, hk), COL.ballast, UP);
        for (const s of [-1, 1]) {
          const dj = P.lift[j] + 0.4, dk = P.lift[k] + 0.4;
          quad(B, at(j, s * hwj, hj), at(k, s * hwk, hk), at(k, s * (hwk + dk * 1.6 + 0.6), hk - dk), at(j, s * (hwj + dj * 1.6 + 0.6), hj - dj), COL.embank, [rx[j] * s * 0.6, 1, rz[j] * s * 0.6]);
        }
      }
      // 軌道（スラブと 2 本のレール）と架線
      const tj = tracks(Math.max(wj, wk));
      for (let q = 0; q < tj.length; q++) {
        const oj = q < 2 ? tj[q] : Math.sign(tj[q]) * (HSR_TRACK + (HSR_PLAT - HSR_TRACK) * wj);
        const ok = q < 2 ? tj[q] : Math.sign(tj[q]) * (HSR_TRACK + (HSR_PLAT - HSR_TRACK) * wk);
        quad(B, at(j, oj - 1.3, hj + 0.18), at(j, oj + 1.3, hj + 0.18), at(k, ok + 1.3, hk + 0.18), at(k, ok - 1.3, hk + 0.18), COL.slab, UP);
        for (const r of [-0.75, 0.75]) quad(B, at(j, oj + r - 0.07, hj + 0.36), at(j, oj + r + 0.07, hj + 0.36), at(k, ok + r + 0.07, hk + 0.36), at(k, ok + r - 0.07, hk + 0.36), COL.rail, UP);
        if (q < 2 || Math.max(wj, wk) > 0.3) quad(B, at(j, oj - 0.05, hj + 5.6), at(j, oj + 0.05, hj + 5.6), at(k, ok + 0.05, hk + 5.6), at(k, ok - 0.05, hk + 5.6), COL.wire, UP);
      }
      // 防音壁：住宅地に面した側だけ（駅の中は除く）
      if (!inStn) for (const s of [-1, 1]) {
        const mx = (P.x[j] + P.x[k]) / 2 + rx[j] * s * 22, mz = (P.z[j] + P.z[k]) / 2 + rz[j] * s * 22;
        if (!resNear(g, mx, mz, 1)) continue;
        const b0 = elevated ? 1.0 : 0;
        const oj = s * (hwj - (elevated ? 0.15 : 0.2)), ok = s * (hwk - (elevated ? 0.15 : 0.2));
        quad(B, at(j, oj, hj + b0), at(k, ok, hk + b0), at(k, ok, hk + 3.4), at(j, oj, hj + 3.4), COL.barrier, nOut(s));
        quad(B, at(j, oj, hj + b0), at(k, ok, hk + b0), at(k, ok, hk + 3.4), at(j, oj, hj + 3.4), COL.barrier, nOut(-s));
        quad(B, at(j, oj - 0.12, hj + 3.4), at(k, ok - 0.12, hk + 3.4), at(k, ok + 0.12, hk + 3.4), at(j, oj + 0.12, hj + 3.4), COL.barrierTop, UP);
      }
      const segL = P.s[k] - P.s[j];
      const ux = -rz[j], uz = rx[j];
      // 橋脚（約 32m おき）。下に道路や線路があるときは門型にする
      pierAcc -= segL;
      if (pierAcc <= 0) {
        pierAcc += 32;
        if (elevated && wj < 0.5) {
          const t = Math.min(1, Math.max(0, (segL + pierAcc - 32) / Math.max(1e-3, segL)));
          const px = P.x[j] + (P.x[k] - P.x[j]) * t, pz = P.z[j] + (P.z[k] - P.z[j]) * t, ph = hj + (hk - hj) * t;
          const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
          const ground = ph - (P.lift[j] + (P.lift[k] - P.lift[j]) * t);
          const top = ph - HSR_GIRDER;
          const PB = bufAt(px, pz);
          const ci = g.inb(cx, cz) ? g.idx(cx, cz) : -1;
          const under = ci >= 0 && (g.road[ci] || g.rail[ci] || g.erail[ci] || g.mono[ci] || g.up[ci]);
          if (under) {
            const co = Math.max(hwj, 7.5) + 1.2;
            for (const s of [-1, 1]) obox(PB, px, pz, ux, uz, -0.8, 0.8, s * co - 0.8, s * co + 0.8, ground - 0.5, top - 0.2, COL.pier);
            obox(PB, px, pz, ux, uz, -0.9, 0.9, -co - 0.9, co + 0.9, top - 1.6, top, COL.pier);
          } else {
            obox(PB, px, pz, ux, uz, -1.0, 1.0, -1.7, 1.7, ground - 0.5, top - 0.9, COL.pier);
            obox(PB, px, pz, ux, uz, -1.3, 1.3, -3.1, 3.1, top - 0.9, top, COL.pier);
          }
        }
      }
      // 架線柱（約 50m おき、両側）。駅の大屋根の下には立てない
      mastAcc -= segL;
      if (mastAcc <= 0) {
        mastAcc += 50;
        if (wj < 0.2) for (const s of [-1, 1]) {
          const o = s * (hwj - 0.65);
          const [mx, , mz] = at(j, o, 0);
          obox(B, mx, mz, ux, uz, -0.18, 0.18, -0.18, 0.18, hj + (elevated ? 1.0 : 0), hj + 7.0, COL.mast);
          obox(B, mx, mz, ux, uz, -0.07, 0.07, s > 0 ? -(hwj - 0.65 - 1.6) : -0.1, s > 0 ? 0.1 : hwj - 0.65 - 1.6, hj + 6.25, hj + 6.4, COL.mast);
        }
      }
    }
    // 車止め（線路の行き止まり。マップの端は除く）
    const n = g.n;
    for (const [end, j, dir] of [[cells[0], 0, 1], [cells[cells.length - 1], N - 1, -1]] as const) {
      if (hsrBits(g.hsr[end]).length !== 1) continue;
      const x = end % n, y = (end / n) | 0;
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1) continue;
      const ux = -rz[j] * dir, uz = rx[j] * dir;
      const B = bufAt(P.x[j], P.z[j]);
      for (const o of tracks(spread[j])) {
        const [bx, , bz] = at(j, o, 0);
        obox(B, bx + ux * 2.0, bz + uz * 2.0, ux, uz, -0.9, 0.9, -1.0, 1.0, P.h[j] + 0.2, P.h[j] + 1.4, COL.stop);
      }
    }
  }
}

// 駅の床版の高さ（ホームのマス → 高さ）
function stationPins(g: Grid, list: Building[]) {
  const pin = new Map<number, number>();
  for (const b of list) if (b.type === 'hsr_station' && b.hsr) for (let a = 0; a < HSR_STN_LEN; a++) pin.set(stnCell(g, b.x, b.y, b.hsr.axis, a, b.hsr.row), b.hsr.deck);
  return pin;
}

// マップの端で終わる線は、マップの端まで（半マス）のばす
function edgeExtend(g: Grid, P: HsrPoly, cells: number[]): HsrPoly {
  const n = g.n;
  const onEdge = (c: number) => { const x = c % n, y = (c / n) | 0; return x === 0 || y === 0 || x === n - 1 || y === n - 1; };
  const head = hsrBits(g.hsr[cells[0]]).length === 1 && onEdge(cells[0]);
  const tail = hsrBits(g.hsr[cells[cells.length - 1]]).length === 1 && onEdge(cells[cells.length - 1]);
  if (!head && !tail) return P;
  const N = P.n + (head ? 1 : 0) + (tail ? 1 : 0);
  const cp = (src: Float32Array | Uint8Array | Int32Array, mk: (n: number) => Float32Array | Uint8Array | Int32Array) => { const a = mk(N); a.set(src, head ? 1 : 0); return a; };
  const x = cp(P.x, (m) => new Float32Array(m)) as Float32Array, z = cp(P.z, (m) => new Float32Array(m)) as Float32Array;
  const h = cp(P.h, (m) => new Float32Array(m)) as Float32Array, lift = cp(P.lift, (m) => new Float32Array(m)) as Float32Array;
  const arc = cp(P.arc, (m) => new Uint8Array(m)) as Uint8Array, ci = cp(P.ci, (m) => new Int32Array(m)) as Int32Array;
  const ext = (dst: number, a: number, b: number) => {
    const dx = x[a] - x[b], dz = z[a] - z[b], l = Math.hypot(dx, dz) || 1;
    x[dst] = x[a] + (dx / l) * (CELL / 2);
    z[dst] = z[a] + (dz / l) * (CELL / 2);
    h[dst] = h[a]; lift[dst] = lift[a]; ci[dst] = ci[a];
  };
  if (head) ext(0, 1, 2);
  if (tail) ext(N - 1, N - 2, N - 3);
  const s = new Float32Array(N);
  for (let k = 1; k < N; k++) s[k] = s[k - 1] + Math.hypot(x[k] - x[k - 1], z[k] - z[k - 1]);
  const off = head ? CELL / 2 : 0;
  for (let k = 0; k < N; k++) s[k] -= off;
  return { ...P, n: N, x, z, h, lift, arc, ci, s, len: s[N - 1] };
}

// ---------------- 列車 ----------------
// 描いた台数の分だけ GPU へ送る
function flush(m: THREE.InstancedMesh, k: number) {
  if (!k) return;
  m.instanceMatrix.clearUpdateRanges();
  m.instanceMatrix.addUpdateRange(0, k * 16);
  m.instanceMatrix.needsUpdate = true;
}
const MAX_TRAINS = 64;
const MAX_MID = HSR_MAX_CARS - 2; // 8 両編成の中間車
export class HsrTrains {
  group = new THREE.Group();
  ops = new HsrOps();
  private lead: THREE.InstancedMesh;
  private mid: THREE.InstancedMesh;
  private n = 0;
  private mtx = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private eu = new THREE.Euler(0, 0, 0, 'YXZ');
  private pos = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private A = { x: 0, z: 0, h: 0, tx: 1, tz: 0 };
  private Bp = { x: 0, z: 0, h: 0, tx: 1, tz: 0 };
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sph = new THREE.Sphere(new THREE.Vector3(), 16);
  visibleCars = 0;

  constructor() {
    const mat = createVehicleMaterial();
    this.lead = new THREE.InstancedMesh(hsrCar(true), mat, MAX_TRAINS * 2);
    this.mid = new THREE.InstancedMesh(hsrCar(false), mat, MAX_TRAINS * MAX_MID);
    for (const m of [this.lead, this.mid]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false; // 画面の外の車両は update で省く
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  rebuild(g: Grid, list: Building[], riders?: Float32Array) {
    this.n = g.n;
    const N = g.n * g.n;
    const stns = list.filter((b) => b.type === 'hsr_station');
    this.ops.build(g, stns, riders && riders.length >= 6 * N ? riders.subarray(5 * N, 6 * N) : undefined);
  }

  // dt = ゲームの時間の進み（秒）。cam = 画面のカメラ（画面の外の車両を省く）
  update(dt: number, cam: THREE.Camera | null) {
    if (dt > 0) this.ops.step(dt);
    if (!this.group.visible) return;
    if (cam) {
      this.pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.pm);
    }
    const lim = this.n * CELL;
    let nl = 0, nm = 0;
    const T = this.ops.trains;
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      const P = this.ops.routes[t.route]?.poly;
      if (!P || t.gone) continue;
      for (let c = 0; c < t.cars; c++) {
        const sc = t.s - t.dir * (c * (HSR_CAR_L + HSR_CAR_GAP) + HSR_CAR_L / 2);
        const sf = sc + t.dir * HSR_CAR_L * 0.34, sr = sc - t.dir * HSR_CAR_L * 0.34;
        hsrAt(P, sf, this.A);
        hsrAt(P, sr, this.Bp);
        const of = this.ops.laneOffset(t, sf), or = this.ops.laneOffset(t, sr);
        const fx = this.A.x - this.A.tz * of, fz = this.A.z + this.A.tx * of;
        const bx = this.Bp.x - this.Bp.tz * or, bz = this.Bp.z + this.Bp.tx * or;
        const cx = (fx + bx) / 2, cz = (fz + bz) / 2, cy = (this.A.h + this.Bp.h) / 2 + 0.36;
        // マップの外（隣の都市へ出入りするところ）は描かない
        if (cx < 0 || cz < 0 || cx > lim || cz > lim) continue;
        this.sph.center.set(cx, cy + 2, cz);
        if (cam && !this.frustum.intersectsSphere(this.sph)) continue;
        // 向き：先頭車は進む向き、最後尾の車両は逆向き（運転台が外を向く）
        const back = c === t.cars - 1;
        // fx - bx は進む向き（dir に関係なく、前の台車 - 後ろの台車）
        let vx = fx - bx, vz = fz - bz, vy = this.A.h - this.Bp.h;
        if (back && t.cars > 1) { vx = -vx; vz = -vz; vy = -vy; }
        const hl = Math.hypot(vx, vz) || 1;
        this.eu.set(-Math.atan2(vy, hl), Math.atan2(vx, vz), 0);
        this.q.setFromEuler(this.eu);
        this.pos.set(cx, cy, cz);
        this.mtx.compose(this.pos, this.q, this.one);
        if (c === 0 || back) { if (nl < this.lead.instanceMatrix.count) this.lead.setMatrixAt(nl++, this.mtx); }
        else if (nm < this.mid.instanceMatrix.count) this.mid.setMatrixAt(nm++, this.mtx);
      }
    }
    this.lead.count = nl;
    this.mid.count = nm;
    this.visibleCars = nl + nm;
    flush(this.lead, nl);
    flush(this.mid, nm);
  }
}
