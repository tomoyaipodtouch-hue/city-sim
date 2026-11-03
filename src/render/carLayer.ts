// 車とトラックの表示（交通量に比例した台数を走らせる）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, opp } from '../sim/constants';
import { ROADS } from '../sim/defs';
import { ROAD_LIFT } from './roadLayer';

const MAX_CARS = 1500;
const MAX_TRUCKS = 300;

interface Car {
  from: number; // ノード（階層つき）
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

class Fleet {
  mesh: THREE.InstancedMesh;
  cars: Car[] = [];
  cdf = new Float32Array(0);
  nodes = new Int32Array(0);
  target = 0;
  constructor(geo: THREE.BufferGeometry, max: number, palette: number[]) {
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    const col = new THREE.Color();
    for (let i = 0; i < max; i++) {
      col.setHex(palette[(i * 7) % palette.length]);
      this.mesh.setColorAt(i, col);
    }
  }
}

export class CarLayer {
  group = new THREE.Group();
  private fleets: Fleet[];
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
    const car = mergeGeometries([body, cabin])!;
    const box = vc(new THREE.BoxGeometry(2.4, 2.9, 7.5).translate(0, 1.9, -1.2), 0xffffff);
    const cab = vc(new THREE.BoxGeometry(2.3, 2.2, 2.2).translate(0, 1.5, 3.6), 0xffffff);
    const glass = vc(new THREE.BoxGeometry(2.32, 0.7, 0.2).translate(0, 2.1, 4.65), 0x2a3440);
    const truck = mergeGeometries([box, cab, glass])!;
    this.fleets = [
      new Fleet(car, MAX_CARS, [0xd8d8d8, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xf2f2f2, 0x3b5d3a, 0xc9a227, 0x5a2d82, 0x6d4c33]),
      new Fleet(truck, MAX_TRUCKS, [0xe8e8e8, 0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b]),
    ];
    this.group.add(...this.fleets.map((f) => f.mesh));
  }

  setData(g: Grid, traffic: Float32Array, cong: Float32Array, freight: Float32Array) {
    this.grid = g;
    this.traffic = traffic;
    this.cong = cong;
    const NN = g.n * g.n * 2;
    const build = (f: Fleet, vol: Float32Array, scale: number, max: number) => {
      const nodes: number[] = [], w: number[] = [];
      let total = 0;
      for (let v = 0; v < NN; v++) {
        if (vol[v] < 1 || !g.nodeType(v)) continue;
        total += vol[v];
        nodes.push(v);
        w.push(total);
      }
      f.nodes = Int32Array.from(nodes);
      f.cdf = Float32Array.from(w);
      f.target = Math.min(max, Math.round(total * scale));
      // 道路がなくなった車は消す
      f.cars = f.cars.filter((c) => g.nodeType(c.from) && g.nodeType(c.to));
    };
    // トラックは交通量に重み 2.5 で入っているので、台数は少なめ
    build(this.fleets[0], traffic, 0.012, MAX_CARS);
    build(this.fleets[1], freight, 0.003, MAX_TRUCKS);
  }

  private spawn(f: Fleet): Car | null {
    if (!f.nodes.length) return null;
    const total = f.cdf[f.cdf.length - 1];
    const r = Math.random() * total;
    let lo = 0, hi = f.cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f.cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const from = f.nodes[lo];
    const nx = this.pickNext(from, -1);
    if (!nx) return null;
    return { from, to: nx[0], d: nx[1], t: Math.random(), alive: true, lane: Math.random() < 0.5 ? 0 : 1 };
  }

  // 次のノードを、交通量の多い方を選びやすくして決める（Uターンはしない）
  private pickNext(node: number, din: number): [number, number] | null {
    const g = this.grid!, tr = this.traffic!;
    const opts: [number, number][] = [];
    const ws: number[] = [];
    let total = 0;
    g.forEachOut(node, (v, d) => {
      if (din >= 0 && d === opp(din)) return;
      const w = tr[v] + 2;
      opts.push([v, d]);
      ws.push(w);
      total += w;
    });
    if (!opts.length) return null;
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
      for (const f of this.fleets) f.mesh.count = 0;
      return;
    }
    const n = g.n, NC = n * n;
    for (const f of this.fleets) {
      // 台数を目標に近づける
      let add = Math.min(30, f.target - f.cars.length);
      while (add-- > 0) {
        const c = this.spawn(f);
        if (c) f.cars.push(c);
      }
      if (f.cars.length > f.target) f.cars.length = Math.max(0, f.target);
      let k = 0;
      for (const c of f.cars) {
        const def = ROADS[g.nodeType(c.from)] || ROADS[1];
        const len = c.d & 1 ? CELL * 1.414 : CELL;
        const cg = Math.max(this.cong![c.from], 1);
        const speed = ((def.speedKmh / 3.6) * 0.9) / cg;
        c.t += (dt * speed) / len;
        let guard = 0;
        while (c.t >= 1 && guard++ < 3) {
          c.t -= 1;
          // ときどき入れ替えて、交通量の分布を保つ
          if (Math.random() < 0.03) {
            const nc = this.spawn(f);
            if (nc) Object.assign(c, nc);
            continue;
          }
          const nx = this.pickNext(c.to, c.d);
          if (!nx) {
            c.alive = false;
            break;
          }
          c.from = c.to;
          c.to = nx[0];
          c.d = nx[1];
        }
        if (!c.alive) continue;
        const fc = c.from % NC, tc = c.to % NC;
        const fx = (fc % n) + 0.5, fy = ((fc / n) | 0) + 0.5;
        const tx = (tc % n) + 0.5, ty = ((tc / n) | 0) + 0.5;
        const fh = g.nodeH(c.from), th = g.nodeH(c.to);
        const dx = DX[c.d], dz = DY[c.d];
        const l = Math.hypot(dx, dz);
        // 右側通行。一方通行・大通り・高速道路は2車線を使い分ける
        const lane = def.oneWay ? (c.lane ? 1 : -1) * def.width * 0.2 : (def.width / 2) * 0.48;
        const ox = (-dz / l) * lane, oz = (dx / l) * lane;
        this.v.set((fx + (tx - fx) * c.t) * CELL + ox, fh + (th - fh) * c.t + ROAD_LIFT, (fy + (ty - fy) * c.t) * CELL + oz);
        this.q.setFromAxisAngle(this.up, Math.atan2(dx, dz));
        this.mtx.compose(this.v, this.q, this.s);
        f.mesh.setMatrixAt(k++, this.mtx);
        if (k >= f.mesh.instanceMatrix.count) break;
      }
      f.cars = f.cars.filter((c) => c.alive);
      f.mesh.count = k;
      f.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
