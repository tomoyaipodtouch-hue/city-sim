// 車とトラックの表示（交通量に比例した台数を走らせる）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, opp } from '../sim/constants';
import { LINES, LineKind, ROADS } from '../sim/defs';
import { RailLayer, TRACK_GAP } from './railLayer';
import { ROAD_LIFT } from './roadLayer';

const MAX_CARS = 1500;
const MAX_TRUCKS = 300;

// 車は「今いるマス（from）」の中を、入ってきた辺の中点から出ていく辺の中点まで、
// マスの中心を制御点にした曲線（2次ベジェ曲線）に沿って進む。道路の描き方と同じ形になる。
interface Car {
  from: number; // 今いるノード（階層つき）
  to: number; // 次のノード
  din: number; // 入ってきた向き
  d: number; // 出ていく向き
  t: number; // マスの中での進み具合（0..1）
  hA: number; // 入ってきたところの高さ
  alive: boolean;
  lane: number;
  col: number; // 車体の色（パレットの番号）。車ごとに決めて変えない
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

// 走る場所：道路（車・トラック・バス）または線路（鉄道・高架鉄道・モノレール・地下鉄）
type Track = 'road' | 'bus' | LineKind;

class Fleet {
  mesh: THREE.InstancedMesh;
  cars: Car[] = [];
  cdf = new Float32Array(0);
  nodes = new Int32Array(0);
  target = 0;
  vol: Float32Array = new Float32Array(0); // 次の行き先を選ぶときの重み
  colors: THREE.Color[];
  constructor(geo: THREE.BufferGeometry, max: number, palette: number[], public track: Track = 'road') {
    this.colors = palette.map((h) => new THREE.Color(h));
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
    const bus = mergeGeometries([
      vc(new THREE.BoxGeometry(2.5, 2.8, 11).translate(0, 1.7, 0), 0xffffff),
      vc(new THREE.BoxGeometry(2.52, 0.9, 9.5).translate(0, 2.2, 0.3), 0x2a3440),
    ])!;
    const train = mergeGeometries([
      vc(new THREE.BoxGeometry(2.9, 3.2, 18).translate(0, 1.9, 0), 0xffffff),
      vc(new THREE.BoxGeometry(2.92, 0.9, 16).translate(0, 2.3, 0), 0x2a3440),
      vc(new THREE.BoxGeometry(2.94, 0.3, 18).translate(0, 1.0, 0), 0x2f86d0),
    ])!;
    const mono = mergeGeometries([
      vc(new THREE.BoxGeometry(2.6, 3.0, 15).translate(0, 1.0, 0), 0xffffff),
      vc(new THREE.BoxGeometry(2.62, 0.9, 13).translate(0, 1.6, 0), 0x2a3440),
      vc(new THREE.BoxGeometry(2.64, 0.35, 15).translate(0, 0.1, 0), 0x2ea37a),
    ])!;
    this.fleets = [
      new Fleet(car, MAX_CARS, [0xd8d8d8, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xf2f2f2, 0x3b5d3a, 0xc9a227, 0x5a2d82, 0x6d4c33]),
      new Fleet(truck, MAX_TRUCKS, [0xe8e8e8, 0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b]),
      new Fleet(bus, 200, [0xe0a800, 0x2f86d0], 'bus'),
      new Fleet(train, 160, [0xf2f2f2], 'rail'),
      new Fleet(train, 160, [0xe8eef2], 'erail'),
      new Fleet(mono, 120, [0xf4f4f4], 'mono'),
      new Fleet(train, 160, [0xd9dde2], 'sub'),
    ];
    this.group.add(...this.fleets.map((f) => f.mesh));
  }

  showSubway = false;

  setData(g: Grid, traffic: Float32Array, cong: Float32Array, freight: Float32Array, riders?: Float32Array) {
    this.grid = g;
    this.traffic = traffic;
    this.cong = cong;
    const N = g.n * g.n;
    const exists = (f: Fleet, v: number) => (f.track === 'road' ? g.nodeType(v) !== 0 : f.track === 'bus' ? v < N && g.road[v] !== 0 : g[f.track][v] !== 0);
    const build = (f: Fleet, vol: Float32Array, scale: number, max: number) => {
      const nodes: number[] = [], w: number[] = [];
      let total = 0;
      const len = f.track === 'road' ? 2 * N : N;
      for (let v = 0; v < len; v++) {
        if (vol[v] < 1 || !exists(f, v)) continue;
        total += vol[v];
        nodes.push(v);
        w.push(total);
      }
      f.nodes = Int32Array.from(nodes);
      f.cdf = Float32Array.from(w);
      f.vol = vol;
      f.target = Math.min(max, Math.round(total * scale));
      // 道路や線路がなくなった車両は消す
      f.cars = f.cars.filter((c) => exists(f, c.from) && exists(f, c.to));
    };
    // トラックは交通量に重み 2.5 で入っているので、台数は少なめ
    build(this.fleets[0], traffic, 0.012, MAX_CARS);
    build(this.fleets[1], freight, 0.003, MAX_TRUCKS);
    if (riders && riders.length === 5 * N) {
      // バスは40人に1台、電車は1両に乗る人数を多めに見て台数を決める
      build(this.fleets[2], riders.subarray(0, N), 0.002, 200);
      (['rail', 'erail', 'mono', 'sub'] as const).forEach((k, i) => build(this.fleets[3 + i], riders.subarray((i + 1) * N, (i + 2) * N), 0.0012, 160));
    }
  }

  private trackH(f: Fleet, node: number) {
    const g = this.grid!;
    if (f.track === 'road') return g.nodeH(node) + ROAD_LIFT;
    if (f.track === 'bus') return g.roadH(node) + ROAD_LIFT;
    if (f.track === 'sub') return g.cellH(node % g.n, (node / g.n) | 0) + 0.8;
    return RailLayer.lineH(g, f.track, node) + (f.track === 'mono' ? 0.1 : 0.35);
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
    const nx = this.pickNext(f, from, -1);
    if (!nx) return null;
    return { from, to: nx[0], din: nx[1], d: nx[1], t: Math.random(), hA: this.trackH(f, from), alive: true, lane: Math.random() < 0.5 ? 0 : 1, col: (Math.random() * f.colors.length) | 0 };
  }

  // 次のノードを、交通量の多い方を選びやすくして決める（Uターンはしない）
  private pickNext(f: Fleet, node: number, din: number): [number, number] | null {
    const g = this.grid!, tr = f.track === 'road' ? this.traffic! : f.vol;
    const opts: [number, number][] = [];
    const ws: number[] = [];
    let total = 0;
    const add = (v: number, d: number) => {
      if (din >= 0 && d === opp(din)) return;
      const w = (tr[v] || 0) + 2;
      opts.push([v, d]);
      ws.push(w);
      total += w;
    };
    if (f.track === 'road') g.forEachOut(node, add);
    else if (f.track === 'bus') g.forEachOut(node, (v, d) => { if (v < g.n * g.n) add(v, d); });
    else {
      const m = g[f.track][node], n = g.n;
      const x = node % n, y = (node / n) | 0;
      for (let d = 0; d < 8; d++) if (m & (1 << d) && g.inb(x + DX[d], y + DY[d])) add((y + DY[d]) * n + x + DX[d], d);
    }
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
      if (f.track === 'sub' && !this.showSubway) {
        f.mesh.count = 0;
        continue;
      }
      // 台数を目標に近づける
      let add = Math.min(30, f.target - f.cars.length);
      while (add-- > 0) {
        const c = this.spawn(f);
        if (c) f.cars.push(c);
      }
      if (f.cars.length > f.target) f.cars.length = Math.max(0, f.target);
      let k = 0;
      for (const c of f.cars) {
        const line = f.track !== 'road' && f.track !== 'bus';
        const def = ROADS[line ? 1 : g.nodeType(c.from)] || ROADS[1];
        const turning = c.din !== c.d;
        // マスの中の道のり（入口の半分 + 出口の半分）
        const len = (c.din & 1 ? CELL * 0.707 : CELL * 0.5) + (c.d & 1 ? CELL * 0.707 : CELL * 0.5);
        const cg = line ? 1 : Math.max(this.cong![c.from], 1);
        const kmh = line ? LINES[f.track as LineKind].speedKmh * 1.2 : def.speedKmh * (f.track === 'bus' ? 0.8 : 1);
        const speed = (((kmh / 3.6) * 0.9) / cg) * (turning ? 0.6 : 1);
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
          const nx = this.pickNext(f, c.to, c.d);
          if (!nx) {
            c.alive = false;
            break;
          }
          c.hA = (this.trackH(f, c.from) + this.trackH(f, c.to)) / 2;
          c.from = c.to;
          c.din = c.d;
          c.to = nx[0];
          c.d = nx[1];
        }
        if (!c.alive) continue;
        const fc = c.from % NC;
        const cx = ((fc % n) + 0.5) * CELL, cz = (((fc / n) | 0) + 0.5) * CELL;
        // 入口 A、中心 C、出口 B
        const ax = cx - DX[c.din] * CELL * 0.5, az = cz - DY[c.din] * CELL * 0.5;
        const bx = cx + DX[c.d] * CELL * 0.5, bz = cz + DY[c.d] * CELL * 0.5;
        const hc = this.trackH(f, c.from), hb = (hc + this.trackH(f, c.to)) / 2;
        const t = c.t, p0 = (1 - t) * (1 - t), p1 = 2 * t * (1 - t), p2 = t * t;
        const x = p0 * ax + p1 * cx + p2 * bx, z = p0 * az + p1 * cz + p2 * bz;
        const h = p0 * c.hA + p1 * hc + p2 * hb;
        // 進行方向（曲線の接線）
        let tx = 2 * (1 - t) * (cx - ax) + 2 * t * (bx - cx), tz = 2 * (1 - t) * (cz - az) + 2 * t * (bz - cz);
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        // 右側通行。一方通行・大通り・高速道路は2車線を使い分ける
        // 電車は複線の、進む向きの右側の線路を走る
        const lane = line ? TRACK_GAP : def.oneWay ? (c.lane ? 1 : -1) * def.width * 0.2 : (def.width / 2) * 0.48;
        this.v.set(x - tz * lane, h, z + tx * lane);
        this.q.setFromAxisAngle(this.up, Math.atan2(tx, tz));
        this.mtx.compose(this.v, this.q, this.s);
        f.mesh.setColorAt(k, f.colors[c.col]);
        f.mesh.setMatrixAt(k++, this.mtx);
        if (k >= f.mesh.instanceMatrix.count) break;
      }
      f.cars = f.cars.filter((c) => c.alive);
      f.mesh.count = k;
      f.mesh.instanceMatrix.needsUpdate = true;
      if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    }
  }
}
