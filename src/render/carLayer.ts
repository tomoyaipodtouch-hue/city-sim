// 車の表示（交通量に比例した台数を走らせる）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, opp } from '../sim/constants';
import { ROADS } from '../sim/defs';
import { ROAD_LIFT } from './roadLayer';

const MAX_CARS = 1500;

interface Car {
  from: number;
  to: number;
  d: number;
  t: number;
  alive: boolean;
  lane: number;
}

function vc(geo: THREE.BufferGeometry, hex: number) {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo.toNonIndexed();
}

export class CarLayer {
  mesh: THREE.InstancedMesh;
  private cars: Car[] = [];
  private cdf: Float32Array = new Float32Array(0);
  private cells: Int32Array = new Int32Array(0);
  private target = 0;
  private grid: Grid | null = null;
  private traffic: Float32Array | null = null;
  private cong: Float32Array | null = null;
  private mtx = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  enabled = true;

  constructor() {
    const body = vc(new THREE.BoxGeometry(1.9, 1.0, 4.4).translate(0, 0.75, 0), 0xffffff);
    const cabin = vc(new THREE.BoxGeometry(1.7, 0.75, 2.3).translate(0, 1.6, -0.2), 0x2a3440);
    const geo = mergeGeometries([body, cabin])!;
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_CARS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    const palette = [0xd8d8d8, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xf2f2f2, 0x3b5d3a, 0xc9a227, 0x5a2d82, 0x6d4c33];
    const col = new THREE.Color();
    for (let i = 0; i < MAX_CARS; i++) {
      col.setHex(palette[(i * 7) % palette.length]);
      this.mesh.setColorAt(i, col);
    }
  }

  setData(g: Grid, traffic: Float32Array, cong: Float32Array) {
    this.grid = g;
    this.traffic = traffic;
    this.cong = cong;
    const cells: number[] = [];
    const w: number[] = [];
    let total = 0;
    for (let i = 0; i < traffic.length; i++) {
      if (!g.road[i] || traffic[i] < 1 || !g.flow[i]) continue;
      total += traffic[i];
      cells.push(i);
      w.push(total);
    }
    this.cells = Int32Array.from(cells);
    this.cdf = Float32Array.from(w);
    this.target = Math.min(MAX_CARS, Math.round(total * 0.012));
    // 道路がなくなった車は消す
    for (const c of this.cars) if (!g.road[c.from] || !g.road[c.to]) c.alive = false;
    this.cars = this.cars.filter((c) => c.alive);
  }

  private spawn(): Car | null {
    const g = this.grid!;
    if (!this.cells.length) return null;
    const total = this.cdf[this.cdf.length - 1];
    const r = Math.random() * total;
    let lo = 0, hi = this.cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const from = this.cells[lo];
    const d = this.pickDir(from, -1);
    if (d < 0) return null;
    const n = g.n;
    const to = from + DY[d] * n + DX[d];
    return { from, to, d, t: Math.random(), alive: true, lane: Math.random() < 0.5 ? 0 : 1 };
  }

  private pickDir(cell: number, back: number): number {
    const g = this.grid!, tr = this.traffic!;
    const n = g.n;
    const m = g.flow[cell];
    const x = cell % n, y = (cell / n) | 0;
    let total = 0;
    const opts: number[] = [], ws: number[] = [];
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d)) || d === back) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (!g.inb(nx, ny)) continue;
      const j = ny * n + nx;
      if (!g.road[j]) continue;
      const w = tr[j] + 2;
      opts.push(d);
      ws.push(w);
      total += w;
    }
    if (!opts.length) return back >= 0 && m & (1 << back) ? back : -1;
    let r = Math.random() * total;
    for (let k = 0; k < opts.length; k++) {
      r -= ws[k];
      if (r <= 0) return opts[k];
    }
    return opts[opts.length - 1];
  }

  update(dt: number) {
    const g = this.grid;
    if (!g || !this.enabled) {
      this.mesh.count = 0;
      return;
    }
    const n = g.n;
    // 台数を目標に近づける
    let add = Math.min(30, this.target - this.cars.length);
    while (add-- > 0) {
      const c = this.spawn();
      if (c) this.cars.push(c);
    }
    if (this.cars.length > this.target) this.cars.length = Math.max(0, this.target);

    let k = 0;
    for (const c of this.cars) {
      const def = ROADS[g.road[c.from]] || ROADS[1];
      const len = c.d & 1 ? CELL * 1.414 : CELL;
      const cg = Math.max(this.cong![c.from], 1);
      const speed = ((def.speedKmh / 3.6) * 0.9) / cg;
      c.t += (dt * speed) / len;
      let guard = 0;
      while (c.t >= 1 && guard++ < 3) {
        c.t -= 1;
        // ときどき入れ替えて、交通量の分布を保つ
        if (Math.random() < 0.03) {
          const nc = this.spawn();
          if (nc) Object.assign(c, nc);
          continue;
        }
        const nd = this.pickDir(c.to, opp(c.d));
        if (nd < 0) {
          c.alive = false;
          break;
        }
        c.from = c.to;
        c.d = nd;
        c.to = c.from + DY[nd] * n + DX[nd];
      }
      if (!c.alive) continue;
      const fx = (c.from % n) + 0.5, fy = ((c.from / n) | 0) + 0.5;
      const tx = (c.to % n) + 0.5, ty = ((c.to / n) | 0) + 0.5;
      const fh = g.roadH(c.from), th = g.roadH(c.to);
      const dx = DX[c.d], dz = DY[c.d];
      const l = Math.hypot(dx, dz);
      // 右側通行。一方通行と大通りは2車線を使い分ける
      const lane = def.oneWay ? (c.lane ? 1 : -1) * def.width * 0.2 : (def.width / 2) * 0.48;
      const ox = (-dz / l) * lane, oz = (dx / l) * lane;
      this.v.set((fx + (tx - fx) * c.t) * CELL + ox, fh + (th - fh) * c.t + ROAD_LIFT, (fy + (ty - fy) * c.t) * CELL + oz);
      this.q.setFromAxisAngle(this.up, Math.atan2(dx, dz));
      this.mtx.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(k++, this.mtx);
      if (k >= MAX_CARS) break;
    }
    this.cars = this.cars.filter((c) => c.alive);
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
