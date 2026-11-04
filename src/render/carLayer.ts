// 車・トラック・バス・電車・歩く人の表示（交通量に比例した台数を走らせる）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, opp } from '../sim/constants';
import { isHighway, LINES, LineKind, ROADS, RoadType } from '../sim/defs';
import { RailLayer, TRACK_GAP } from './railLayer';
import { ROAD_LIFT } from './roadLayer';
import { boxTruck, cityBus, garbageTruck, hatchback, minivan, pickup, sedan, suv, tractor, trailerBox, trailerTank, vc } from './vehicles';

const MAX_CARS = 1500;
const MAX_TRUCKS = 300;
const MAX_PEOPLE = 700;
const MAX_LIGHTS = (MAX_CARS + MAX_TRUCKS + 200) * 2;
const KINGPIN = 1.6; // トラクターの中心から連結部までの距離
const TRAILER_AXLE = 12.2; // 連結部から後ろの車輪までの距離

// 車は「今いるマス（from）」の中を、入ってきた辺の中点から出ていく辺の中点まで、
// マスの中心を制御点にした曲線（2次ベジェ曲線）に沿って進む。道路の描き方と同じ形になる。
interface Cell {
  from: number; // ノード（階層つき）
  to: number; // 次のノード
  din: number; // 入ってきた向き
  d: number; // 出ていく向き
  hA: number; // 入ってきたところの高さ
}
interface Car extends Cell {
  t: number; // マスの中での進み具合（0..1）
  alive: boolean;
  lane: number;
  col: number; // 車体の色（パレットの番号）。車ごとに決めて変えない
  col2: number; // トレーラーの色
  p: Cell | null; // ひとつ前のマス（トレーラーの位置に使う）
}

// 走る場所：道路（車・トラック・バス）、歩道、線路（鉄道・高架鉄道・モノレール・地下鉄）
type Track = 'road' | 'bus' | 'walk' | LineKind;

class Fleet {
  mesh: THREE.InstancedMesh;
  trailer: THREE.InstancedMesh | null = null;
  trailerColors: THREE.Color[] = [];
  cars: Car[] = [];
  cdf = new Float32Array(0);
  nodes = new Int32Array(0);
  target = 0;
  vol: Float32Array = new Float32Array(0); // 次の行き先を選ぶときの重み
  colors: THREE.Color[];
  constructor(geo: THREE.BufferGeometry, public max: number, palette: number[], public track: Track = 'road', public halfLen = 2.3, public share = 1) {
    this.colors = palette.map((h) => new THREE.Color(h));
    this.mesh = this.makeMesh(geo, max);
  }
  makeMesh(geo: THREE.BufferGeometry, max: number) {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.setColorAt(0, new THREE.Color());
    return m;
  }
  withTrailer(geo: THREE.BufferGeometry, palette: number[]) {
    this.trailer = this.makeMesh(geo, this.max);
    this.trailerColors = palette.map((h) => new THREE.Color(h));
    return this;
  }
}

const CAR_COLORS = [0xd8d8d8, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xf2f2f2, 0x3b5d3a, 0xc9a227, 0x5a2d82, 0x6d4c33, 0xb8bcc0, 0x101820, 0x7a1f2b, 0x4a6a8a];
const CAB_COLORS = [0xe8e8e8, 0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b, 0x2b2b2b, 0x8a8f96];

export class CarLayer {
  group = new THREE.Group();
  private fleets: Fleet[];
  private cars: Fleet[]; // 自家用車（種類ごと）
  private trucks: Fleet[]; // トラック（種類ごと）
  private bus: Fleet;
  private packers: Fleet;
  private people: Fleet;
  private lineFleets: Fleet[];
  private night = 0;
  private lightsHead: THREE.Points;
  private lightsTail: THREE.Points;
  private grid: Grid | null = null;
  private traffic: Float32Array | null = null;
  private cong: Float32Array | null = null;
  private mtx = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private pt = { x: 0, z: 0, h: 0, tx: 0, tz: 1 };
  enabled = true;
  showSubway = false;
  viewDist = 500;

  // 夜は車が暗くなりすぎないように、少し光らせる。前後のライトは光の点で描く
  setNight(k: number) {
    this.night = k;
    for (const f of this.fleets) for (const m of [f.mesh, f.trailer]) if (m) (m.material as THREE.MeshLambertMaterial).emissive.setRGB(0.05 * k, 0.05 * k, 0.045 * k);
    for (const p of [this.lightsHead, this.lightsTail]) (p.material as THREE.PointsMaterial).opacity = Math.min(1, k * 1.3);
  }
  private makeLights(color: number, size: number) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 32, 32);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_LIGHTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(c), color, size, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    pts.frustumCulled = false;
    return pts;
  }

  constructor() {
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
    // 歩く人：脚、胴（服の色）、頭
    const person = mergeGeometries([
      vc(new THREE.BoxGeometry(0.46, 0.75, 0.3).translate(0, 0.45, 0), 0x9a9aa0),
      vc(new THREE.BoxGeometry(0.5, 0.65, 0.32).translate(0, 1.15, 0), 0xffffff),
      vc(new THREE.BoxGeometry(0.28, 0.28, 0.28).translate(0, 1.65, 0), 0xf0d0b0),
    ])!;
    // 自家用車の種類と割合
    this.cars = [
      new Fleet(sedan(), 600, CAR_COLORS, 'road', 2.3, 0.34),
      new Fleet(hatchback(), 340, CAR_COLORS, 'road', 2.0, 0.18),
      new Fleet(suv(), 460, CAR_COLORS, 'road', 2.4, 0.26),
      new Fleet(pickup(), 220, [0xf2f2f2, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0x3b5d3a, 0xb8bcc0], 'road', 2.7, 0.1),
      new Fleet(minivan(), 240, CAR_COLORS, 'road', 2.5, 0.12),
    ];
    // トラック：箱型、箱型のトレーラー、タンクのトレーラー
    this.trucks = [
      new Fleet(boxTruck(), 160, CAB_COLORS, 'road', 4.4, 0.45),
      new Fleet(tractor(), 140, CAB_COLORS, 'road', 3.1, 0.4).withTrailer(trailerBox(), [0xf2f2f0, 0xe4e6e8, 0xd0d4d8, 0xb5452f, 0x2f6fb5]),
      new Fleet(tractor(), 60, CAB_COLORS, 'road', 3.1, 0.15).withTrailer(trailerTank(), [0xd8dce0, 0xc8ccd0, 0xf0f0f0]),
    ];
    this.packers = new Fleet(garbageTruck(), 60, [0xf2f2f2, 0x2e8b57, 0x2e6da4, 0x3f7f3f], 'road', 3.7);
    this.bus = new Fleet(cityBus(), 200, [0xe0a800, 0x2f86d0, 0x2e8b57, 0xd0d0d0], 'bus', 6.0);
    this.lineFleets = [
      new Fleet(train, 160, [0xf2f2f2], 'rail'),
      new Fleet(train, 160, [0xe8eef2], 'erail'),
      new Fleet(mono, 120, [0xf4f4f4], 'mono'),
      new Fleet(train, 160, [0xd9dde2], 'sub'),
    ];
    this.people = new Fleet(person, MAX_PEOPLE, [0xc0392b, 0x2e6da4, 0xf2f2f2, 0x333333, 0xe0a800, 0x4c7a3b, 0x8e44ad, 0xd98aa0, 0x6d8fb0, 0xb07a4a], 'walk');
    this.fleets = [...this.cars, ...this.trucks, this.packers, this.bus, ...this.lineFleets, this.people];
    this.lightsHead = this.makeLights(0xfff1c8, 3.2);
    this.lightsTail = this.makeLights(0xff3020, 2.2);
    this.group.add(this.lightsHead, this.lightsTail);
    for (const f of this.fleets) {
      this.group.add(f.mesh);
      if (f.trailer) this.group.add(f.trailer);
    }
  }

  setData(g: Grid, traffic: Float32Array, cong: Float32Array, freight: Float32Array, riders?: Float32Array, garbage?: Uint8Array, garbageLeft?: Uint8Array) {
    this.grid = g;
    this.traffic = traffic;
    this.cong = cong;
    const N = g.n * g.n;
    const walkable = (v: number) => v < N && g.road[v] !== 0 && !isHighway(g.road[v]) && g.road[v] !== RoadType.Ramp;
    const exists = (f: Fleet, v: number) => (f.track === 'road' ? g.nodeType(v) !== 0 : f.track === 'bus' ? v < N && g.road[v] !== 0 : f.track === 'walk' ? walkable(v) : g[f.track][v] !== 0);
    const build = (f: Fleet, vol: Float32Array, scale: number) => {
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
      f.target = Math.min(f.max, Math.round(total * scale * f.share));
      // 道路や線路がなくなった車両は消す
      f.cars = f.cars.filter((c) => exists(f, c.from) && exists(f, c.to));
    };
    for (const f of this.cars) build(f, traffic, 0.012);
    // トラックは交通量に重み 2.5 で入っているので、台数は少なめ
    for (const f of this.trucks) build(f, freight, 0.003);
    // ゴミ収集車：ゴミの多い場所の一般の道路を回る。処理施設があって、処理できている分だけ走る
    if (garbage && garbageLeft) {
      const n = g.n;
      const gv = new Float32Array(2 * N);
      let sum = 0, left = 0;
      for (let i = 0; i < N; i++) {
        sum += garbage[i];
        left += garbageLeft[i];
        if (!walkable(i)) continue;
        const x = i % n, y = (i / n) | 0;
        let m = 0;
        for (let d = 0; d < 8; d += 2) if (g.inb(x + DX[d], y + DY[d])) m = Math.max(m, garbage[(y + DY[d]) * n + x + DX[d]]);
        gv[i] = m;
      }
      const handled = sum > 0 ? Math.max(0, 1 - left / sum) : 0;
      build(this.packers, gv, 0.0002 * handled);
    }
    // 歩く人は、交通量の多い一般の道路の歩道に多い
    build(this.people, traffic, 0.006);
    if (riders && riders.length === 5 * N) {
      // バスは40人に1台、電車は1両に乗る人数を多めに見て台数を決める
      build(this.bus, riders.subarray(0, N), 0.002);
      this.lineFleets.forEach((f, i) => build(f, riders.subarray((i + 1) * N, (i + 2) * N), 0.0012));
    }
  }

  private trackH(f: Fleet, node: number) {
    const g = this.grid!;
    if (f.track === 'road') return g.nodeH(node) + ROAD_LIFT;
    if (f.track === 'bus') return g.roadH(node) + ROAD_LIFT;
    if (f.track === 'walk') return g.roadH(node) + ROAD_LIFT + 0.18;
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
    return {
      from, to: nx[0], din: nx[1], d: nx[1], t: Math.random(), hA: this.trackH(f, from), alive: true, lane: Math.random() < 0.5 ? 0 : 1,
      col: (Math.random() * f.colors.length) | 0, col2: (Math.random() * Math.max(1, f.trailerColors.length)) | 0, p: null,
    };
  }

  // 次のノードを、交通量の多い方を選びやすくして決める（Uターンはしない）
  private pickNext(f: Fleet, node: number, din: number): [number, number] | null {
    const g = this.grid!, tr = f.track === 'road' && f !== this.packers ? this.traffic! : f.vol;
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
    if (f === this.packers) {
      // ゴミ収集車は一般の道路だけを走る
      const N = g.n * g.n;
      g.forEachOut(node, (v, d) => { if (v < N && g.road[v] && !isHighway(g.road[v]) && g.road[v] !== RoadType.Ramp) add(v, d); });
    } else if (f.track === 'road') g.forEachOut(node, add);
    else if (f.track === 'bus') g.forEachOut(node, (v, d) => { if (v < g.n * g.n) add(v, d); });
    else if (f.track === 'walk') {
      // 歩道は一方通行も関係なく、つながっている向きに進める
      const n = g.n, x = node % n, y = (node / n) | 0, m = g.conn[node];
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d)) || !g.inb(x + DX[d], y + DY[d])) continue;
        const j = (y + DY[d]) * n + x + DX[d];
        if (g.road[j] && !isHighway(g.road[j]) && g.road[j] !== RoadType.Ramp) add(j, d);
      }
    } else {
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

  // マスの中の道のり（入口の半分 + 出口の半分）
  private static cellLen(c: Cell) {
    return (c.din & 1 ? CELL * 0.707 : CELL * 0.5) + (c.d & 1 ? CELL * 0.707 : CELL * 0.5);
  }

  // マスの中の位置 t の点と進む向き（this.pt に入れる）
  private place(f: Fleet, c: Cell, t: number) {
    const g = this.grid!, n = g.n, NC = n * n;
    const fc = c.from % NC;
    const cx = ((fc % n) + 0.5) * CELL, cz = (((fc / n) | 0) + 0.5) * CELL;
    // 入口 A、中心 C、出口 B
    const ax = cx - DX[c.din] * CELL * 0.5, az = cz - DY[c.din] * CELL * 0.5;
    const bx = cx + DX[c.d] * CELL * 0.5, bz = cz + DY[c.d] * CELL * 0.5;
    const hc = this.trackH(f, c.from), hb = (hc + this.trackH(f, c.to)) / 2;
    const p0 = (1 - t) * (1 - t), p1 = 2 * t * (1 - t), p2 = t * t;
    const P = this.pt;
    P.x = p0 * ax + p1 * cx + p2 * bx;
    P.z = p0 * az + p1 * cz + p2 * bz;
    P.h = p0 * c.hA + p1 * hc + p2 * hb;
    let tx = 2 * (1 - t) * (cx - ax) + 2 * t * (bx - cx), tz = 2 * (1 - t) * (cz - az) + 2 * t * (bz - cz);
    const tl = Math.hypot(tx, tz) || 1;
    P.tx = tx / tl;
    P.tz = tz / tl;
  }

  // 道に沿って back m だけ後ろの点（トレーラーの連結部や車輪）
  private placeBack(f: Fleet, c: Car, back: number) {
    const len = CarLayer.cellLen(c);
    const tb = c.t - back / len;
    if (tb >= 0) return this.place(f, c, tb);
    let rem = -tb * len;
    if (c.p) {
      const pl = CarLayer.cellLen(c.p);
      if (rem <= pl) return this.place(f, c.p, 1 - rem / pl);
      this.place(f, c.p, 0);
      rem -= pl;
    } else this.place(f, c, 0);
    // それより前はまっすぐ伸ばす
    const P = this.pt;
    P.x -= P.tx * rem;
    P.z -= P.tz * rem;
  }

  update(dt: number) {
    const g = this.grid;
    if (!g || !this.enabled) {
      for (const f of this.fleets) {
        f.mesh.count = 0;
        if (f.trailer) f.trailer.count = 0;
      }
      return;
    }
    const lit = this.night > 0.05;
    const hp = this.lightsHead.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tp = this.lightsTail.geometry.getAttribute('position') as THREE.BufferAttribute;
    let nh = 0, nt = 0;
    const P = this.pt;
    for (const f of this.fleets) {
      if ((f.track === 'sub' && !this.showSubway) || (f.track === 'walk' && this.viewDist > 450)) {
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
      const walk = f.track === 'walk';
      const line = f.track !== 'road' && f.track !== 'bus' && !walk;
      let k = 0;
      for (const c of f.cars) {
        const def = ROADS[line ? 1 : g.nodeType(c.from)] || ROADS[1];
        const turning = c.din !== c.d;
        const len = CarLayer.cellLen(c);
        const cg = line || walk ? 1 : Math.max(this.cong![c.from], 1);
        const kmh = walk ? 4.5 + (c.col % 3) * 0.6 : line ? LINES[f.track as LineKind].speedKmh * 1.2 : def.speedKmh * (f.track === 'bus' ? 0.8 : f.trailer ? 0.85 : 1);
        const speed = (((kmh / 3.6) * 0.9) / cg) * (turning ? 0.6 : 1);
        c.t += (dt * speed) / len;
        let guard = 0;
        while (c.t >= 1 && guard++ < 3) {
          c.t -= 1;
          // ときどき入れ替えて、交通量の分布を保つ（トレーラーは途中で消えると目立つので、少なめに）
          if (Math.random() < (f.trailer ? 0.008 : 0.03)) {
            const nc = this.spawn(f);
            if (nc) Object.assign(c, nc);
            continue;
          }
          const nx = this.pickNext(f, c.to, c.d);
          if (!nx) {
            c.alive = false;
            break;
          }
          c.p = { from: c.from, to: c.to, din: c.din, d: c.d, hA: c.hA };
          c.hA = (this.trackH(f, c.from) + this.trackH(f, c.to)) / 2;
          c.from = c.to;
          c.din = c.d;
          c.to = nx[0];
          c.d = nx[1];
        }
        if (!c.alive) continue;
        this.place(f, c, c.t);
        // 右側通行。一方通行・大通り・高速道路は2車線を使い分ける。電車は複線の、進む向きの右側の線路を走る
        const lane = walk ? (def.width / 2 + 0.9) * (c.lane ? 1 : -1) : line ? TRACK_GAP : def.oneWay ? (c.lane ? 1 : -1) * def.width * 0.2 : (def.width / 2) * 0.48;
        const x = P.x - P.tz * lane, z = P.z + P.tx * lane, h = P.h, tx = P.tx, tz = P.tz;
        this.v.set(x, h, z);
        this.q.setFromAxisAngle(this.up, Math.atan2(tx, tz));
        this.mtx.compose(this.v, this.q, this.s);
        f.mesh.setColorAt(k, f.colors[c.col]);
        f.mesh.setMatrixAt(k, this.mtx);
        // トレーラー：連結部から後ろの車輪へ向けて置く（カーブで折れ曲がる）
        if (f.trailer) {
          this.placeBack(f, c, KINGPIN);
          const kx = P.x - P.tz * lane, kz = P.z + P.tx * lane, kh = P.h;
          this.placeBack(f, c, KINGPIN + TRAILER_AXLE);
          const rx = P.x - P.tz * lane, rz = P.z + P.tx * lane;
          this.v.set(kx, kh, kz);
          this.q.setFromAxisAngle(this.up, Math.atan2(kx - rx, kz - rz));
          this.mtx.compose(this.v, this.q, this.s);
          f.trailer.setMatrixAt(k, this.mtx);
          f.trailer.setColorAt(k, f.trailerColors[c.col2 % f.trailerColors.length]);
          if (lit && nt < MAX_LIGHTS - 2) {
            const bx = (kx - rx) / TRAILER_AXLE, bz = (kz - rz) / TRAILER_AXLE;
            for (const sd of [-0.9, 0.9]) tp.setXYZ(nt++, rx - bx * 1.8 - bz * sd, kh + 1.0, rz - bz * 1.8 + bx * sd);
          }
        }
        k++;
        // 夜のライト（前は白、後ろは赤）
        if (lit && !walk && !line && nh < MAX_LIGHTS - 2) {
          const half = f.halfLen, py = h + 0.8;
          for (const sd of [-0.6, 0.6]) {
            hp.setXYZ(nh++, x + tx * half - tz * sd, py, z + tz * half + tx * sd);
            if (!f.trailer) tp.setXYZ(nt++, x - tx * half - tz * sd, py, z - tz * half + tx * sd);
          }
        }
        if (k >= f.max) break;
      }
      f.cars = f.cars.filter((c) => c.alive);
      f.mesh.count = k;
      f.mesh.instanceMatrix.needsUpdate = true;
      if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
      if (f.trailer) {
        f.trailer.count = k;
        f.trailer.instanceMatrix.needsUpdate = true;
        if (f.trailer.instanceColor) f.trailer.instanceColor.needsUpdate = true;
      }
    }
    this.lightsHead.geometry.setDrawRange(0, nh);
    this.lightsTail.geometry.setDrawRange(0, nt);
    hp.needsUpdate = tp.needsUpdate = nh + nt > 0;
    this.lightsHead.visible = this.lightsTail.visible = lit;
  }
}
