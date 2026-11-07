// 車・トラック・バス・電車・歩く人の表示（交通量に比例した台数を走らせる）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, opp } from '../sim/constants';
import { CIVIC, CivicId, isHighway, LINES, LineKind, ROADS, RoadType } from '../sim/defs';
import type { Building } from '../sim/world';
import { RailLayer, TRACK_GAP } from './railLayer';
import { isUrbanHighway, urbanTurnOk } from '../sim/traffic';
import { ROAD_LIFT } from './roadLayer';
import { findTurnbacks, Turnback } from './turnback';
import { boxTruck, cityBus, garbageTruck, trainCar, TRAIN_SPEC, TrainKind, hatchback, minivan, pickup, sedan, suv, tractor, trailerBox, trailerTank, vc } from './vehicles';

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
  stop?: number; // 駅に止まっている残りの秒数
  lastStop?: number; // 最後に止まった駅のマス
  wait?: number; // 前の列車を待っている秒数
  hist: Cell[]; // 通ってきたマス（新しい順）。トレーラーや列車の後ろの車両の位置に使う
  tb?: Turnback | null; // この先の折り返し（行き止まり）
  tbKey?: number; // tb を調べたときの to
  revPending?: boolean; // 行き止まりで止まっていて、このあと向きを変える
}

// 走る場所：道路（車・トラック・バス）、歩道、線路（鉄道・高架鉄道・モノレール・地下鉄）
type Track = 'road' | 'bus' | 'walk' | LineKind;

class Fleet {
  mesh: THREE.InstancedMesh;
  trailer: THREE.InstancedMesh | null = null;
  // 列車：先頭と最後尾は mesh（運転台つき）、中間の車両は mid
  mid: THREE.InstancedMesh | null = null;
  carsPer = 1;
  spacing = 0;
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
  asTrain(kind: TrainKind) {
    const S = TRAIN_SPEC[kind];
    this.carsPer = S.cars;
    this.spacing = S.L + S.gap;
    this.mesh.dispose();
    this.mesh = this.makeMesh(trainCar(kind, true), this.max * 2);
    this.mid = this.makeMesh(trainCar(kind, false), this.max * Math.max(1, S.cars - 2));
    this.halfLen = S.L / 2;
    return this;
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
    for (const f of this.fleets) for (const m of [f.mesh, f.trailer, f.mid]) if (m) (m.material as THREE.MeshLambertMaterial).emissive.setRGB(0.05 * k, 0.05 * k, 0.045 * k);
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
      new Fleet(train, 60, [0xffffff], 'rail').asTrain('rail'),
      new Fleet(train, 60, [0xffffff], 'erail').asTrain('erail'),
      new Fleet(mono, 50, [0xffffff], 'mono').asTrain('mono'),
      new Fleet(train, 60, [0xffffff], 'sub').asTrain('sub'),
    ];
    this.people = new Fleet(person, MAX_PEOPLE, [0xc0392b, 0x2e6da4, 0xf2f2f2, 0x333333, 0xe0a800, 0x4c7a3b, 0x8e44ad, 0xd98aa0, 0x6d8fb0, 0xb07a4a], 'walk');
    this.fleets = [...this.cars, ...this.trucks, this.packers, this.bus, ...this.lineFleets, this.people];
    this.lightsHead = this.makeLights(0xfff1c8, 3.2);
    this.lightsTail = this.makeLights(0xff3020, 2.2);
    this.group.add(this.lightsHead, this.lightsTail);
    for (const f of this.fleets) {
      this.group.add(f.mesh);
      if (f.trailer) this.group.add(f.trailer);
      if (f.mid) this.group.add(f.mid);
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
      // バスは前の 4 割の台数にし、バス停の数の 1.5 倍までにする
      build(this.bus, riders.subarray(0, N), 0.0008);
      let stops = 0;
      for (let i = 0; i < N; i++) if (g.bstop[i]) stops++;
      stops += this.busStopBuildings;
      this.bus.target = Math.min(this.bus.target, Math.max(1, Math.ceil(stops * 1.5)));
      // 高架鉄道（i = 1）は本数を 4 割に（3両編成なので、4両のときと本数が同じになるよう 0.3 倍）
      this.lineFleets.forEach((f, i) => build(f, riders.subarray((i + 1) * N, (i + 2) * N), (0.0012 / f.carsPer) * (i === 1 ? 0.3 : 1)));
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
    const car: Car = {
      from, to: nx[0], din: nx[1], d: nx[1], t: Math.random(), hA: this.trackH(f, from), alive: true, lane: Math.random() < 0.5 ? 0 : 1,
      col: (Math.random() * f.colors.length) | 0, col2: (Math.random() * Math.max(1, f.trailerColors.length)) | 0, hist: [],
    };
    if (f.mid) this.seedHistory(f, car);
    return car;
  }

  // 列車は、出てきたときから後ろの車両が線路の上に並ぶように、通ってきたマスをさかのぼって作っておく
  private seedHistory(f: Fleet, c: Car) {
    const g = this.grid!, n = g.n;
    const mask = g[f.track as LineKind];
    let cur: Cell = c;
    for (let k = 0; k < 7; k++) {
      const x = cur.from % n, y = (cur.from / n) | 0;
      let back = -1;
      // まっすぐ後ろを優先し、なければ進む向き以外のつながっている向き
      const prefer = (cur.din + 4) & 7;
      for (const d of [prefer, ...[0, 1, 2, 3, 4, 5, 6, 7].filter((q) => q !== prefer)]) {
        if (d === cur.d || !(mask[cur.from] & (1 << d)) || !g.inb(x + DX[d], y + DY[d])) continue;
        back = d;
        break;
      }
      if (back < 0) break;
      const j = (y + DY[back]) * n + x + DX[back];
      const dirIn = (back + 4) & 7;
      const prev: Cell = { from: j, to: cur.from, din: dirIn, d: dirIn, hA: this.trackH(f, j) };
      cur.din = dirIn;
      c.hist.push(prev);
      cur = prev;
    }
  }

  // 次のノードを、交通量の多い方を選びやすくして決める（Uターンはしない）
  private pickNext(f: Fleet, node: number, din: number): [number, number] | null {
    const g = this.grid!, tr = f.track === 'road' && f !== this.packers ? this.traffic! : f.vol;
    const opts: [number, number][] = [];
    const ws: number[] = [];
    let total = 0;
    const add = (v: number, d: number) => {
      if (din >= 0 && d === opp(din)) return;
      if ((f.track === 'road' || f.track === 'bus') && din >= 0 && isUrbanHighway(g.nodeType(node)) && !urbanTurnOk(din, d)) {
        // ランプへの出入りのときだけ（本線の斜めの区間・曲がり角は通れる）
        const n = g.n, c = node % (n * n), px = (c % n) - DX[din], py = ((c / n) | 0) - DY[din];
        const fromRamp = g.inb(px, py) && (g.road[g.idx(px, py)] === RoadType.Ramp || g.up[g.idx(px, py)] === RoadType.Ramp);
        if (fromRamp || g.nodeType(v) === RoadType.Ramp) return;
      }
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

  private trainCap(f: Fleet) {
    return f.mesh.instanceMatrix.count;
  }

  // 駅のホームに接する線路のマス（路線ごと）
  private stations = new Map<string, Set<number>>();
  private busStopBuildings = 0;
  // 線路の行き止まり（折り返し）。線路が変わったときに呼ぶ
  private turnbacks = new Map<string, Map<number, Turnback>>();
  setTurnbacks(g: Grid) {
    for (const k of ['rail', 'erail', 'mono', 'sub'] as const) this.turnbacks.set(k, findTurnbacks(g, k));
    for (const f of this.lineFleets) for (const c of f.cars) c.tbKey = -1;
  }
  // 列車の進む先（まっすぐ 16 マスまで）にある折り返し
  private endAhead(f: Fleet, c: Car): Turnback | null {
    if (c.tbKey === c.to) return c.tb ?? null;
    c.tbKey = c.to;
    c.tb = null;
    const tbs = this.turnbacks.get(f.track);
    if (!tbs || !tbs.size) return null;
    const g = this.grid!, n = g.n, mask = g[f.track as LineKind];
    let x = c.to % n, y = (c.to / n) | 0;
    const d = c.d;
    for (let k = 0; k < 16; k++) {
      const i = y * n + x, tb = tbs.get(i);
      if (tb && tb.ux * DX[d] + tb.uz * DY[d] > 0.5) { c.tb = tb; return tb; }
      if (!(mask[i] & (1 << d))) break;
      x += DX[d]; y += DY[d];
      if (!g.inb(x, y)) break;
    }
    return null;
  }
  // 行き止まりで向きを変える：最後尾の位置が新しい先頭になり、来た道を戻る（右側通行なので、渡った先の線路をそのまま走る）
  private reverseTrain(f: Fleet, c: Car) {
    const rev = (q: Cell): Cell => {
      const n = this.grid!.n, x = (q.from % n) - DX[q.din], y = ((q.from / n) | 0) - DY[q.din];
      const to = this.grid!.inb(x, y) ? y * n + x : q.from;
      return { from: q.from, to, din: opp(q.d), d: opp(q.din), hA: this.trackH(f, q.from) };
    };
    const segs: Cell[] = [c, ...c.hist];
    let rem = (f.carsPer - 1) * f.spacing + f.halfLen * 1.6;
    let k = 0, tf = 0;
    for (; k < segs.length; k++) {
      const L = CarLayer.cellLen(segs[k]);
      const avail = (k === 0 ? c.t : 1) * L;
      if (rem <= avail || k === segs.length - 1) { tf = Math.max(0, (avail - Math.min(rem, avail)) / L); break; }
      rem -= avail;
    }
    const head = rev(segs[k]);
    const hist: Cell[] = [];
    for (let j = k - 1; j >= 0; j--) hist.push(rev(segs[j]));
    c.from = head.from; c.to = head.to; c.din = head.din; c.d = head.d; c.hA = head.hA;
    c.t = 1 - tf;
    c.hist = hist;
    c.tbKey = -1;
    c.lastStop = -1;
  }

  setStations(g: Grid, list: Building[]) {
    this.stations.clear();
    this.busStopBuildings = list.filter((b) => b.civic && CIVIC[b.type as CivicId].transit === 'bus').length;
    for (const b of list) {
      if (!b.civic) continue;
      const k = CIVIC[b.type as CivicId].transit;
      if (!k || k === 'bus') continue;
      const mask = g[k];
      const set = this.stations.get(k) ?? this.stations.set(k, new Set()).get(k)!;
      for (let y = b.y - 1; y <= b.y + b.h; y++)
        for (let x = b.x - 1; x <= b.x + b.w; x++) if (g.inb(x, y) && mask[g.idx(x, y)]) set.add(g.idx(x, y));
    }
    // 線路の上だけの高架駅
    for (let i = 0; i < g.estn.length; i++) if (g.estn[i] && g.erail[i]) (this.stations.get('erail') ?? this.stations.set('erail', new Set()).get('erail')!).add(i);
  }
  // 列車が占めているマス（進む向きで上り・下りの線路を分ける）
  private static occKey(cell: number, d: number) {
    return cell * 2 + (d < 4 ? 0 : 1);
  }
  private buildOcc(f: Fleet) {
    const occ = new Map<number, Car>();
    const cells = Math.ceil((f.carsPer * f.spacing) / 14) + 1;
    for (const c of f.cars) {
      occ.set(CarLayer.occKey(c.from, c.d), c);
      for (let k = 0; k < Math.min(cells, c.hist.length); k++) occ.set(CarLayer.occKey(c.hist[k].from, c.hist[k].d), c);
    }
    return occ;
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
    let last: Cell = c;
    for (const h of c.hist) {
      const pl = CarLayer.cellLen(h);
      if (rem <= pl) return this.place(f, h, 1 - rem / pl);
      rem -= pl;
      last = h;
    }
    this.place(f, last, 0);
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
        if (f.mid) f.mid.count = 0;
      }
      return;
    }
    const lit = this.night > 0.05;
    const hp = this.lightsHead.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tp = this.lightsTail.geometry.getAttribute('position') as THREE.BufferAttribute;
    let nh = 0, nt = 0;
    const P = this.pt;
    // 車どうしの間隔：同じマス・同じ向き・同じ車線にいる車を集めておく（前の車に追いついたら待つ）
    const lanes = new Map<number, { c: Car; h: number }[]>();
    const laneOf = (c: Car) => ((ROADS[g.nodeType(c.from)] || ROADS[1]).oneWay ? c.lane : 0);
    for (const f of this.fleets) {
      if (f.track !== 'road' && f.track !== 'bus') continue;
      for (const c of f.cars) {
        const key = (c.from * 8 + c.d) * 2 + laneOf(c);
        const a = lanes.get(key);
        if (a) a.push({ c, h: f.halfLen });
        else lanes.set(key, [{ c, h: f.halfLen }]);
      }
    }
    for (const f of this.fleets) {
      if ((f.track === 'sub' && !this.showSubway) || (f.track === 'walk' && this.viewDist > 450)) {
        f.mesh.count = 0;
        if (f.mid) f.mid.count = 0;
        continue;
      }
      // 台数を目標に近づける
      let add = Math.min(30, f.target - f.cars.length);
      let occ = f.mid ? this.buildOcc(f) : null;
      while (add-- > 0) {
        const c = this.spawn(f);
        if (!c) continue;
        // 列車は、ほかの列車がいる場所には出さない
        if (occ && [c, ...c.hist].some((q) => { const o = occ!.get(CarLayer.occKey(q.from, q.d)); return o && o !== c; })) continue;
        f.cars.push(c);
        if (occ) occ = this.buildOcc(f);
      }
      if (f.cars.length > f.target) f.cars.length = Math.max(0, f.target);
      const walk = f.track === 'walk';
      const line = f.track !== 'road' && f.track !== 'bus' && !walk;
      let k = 0, hk = 0, mk = 0;
      for (const c of f.cars) {
        const def = ROADS[line ? 1 : g.nodeType(c.from)] || ROADS[1];
        // 曲がるときは減速する。ただし高速道路（都市高速を含む）の本線のカーブはそのままの速さ
        // ランプから本線への合流・本線からランプへの分岐も、減速しない（合流は本線の速さまで加速する）
        const tf = line || walk ? 0 : g.nodeType(c.from), tt = line || walk ? 0 : g.nodeType(c.to);
        const fast = (q: number) => isHighway(q) || q === RoadType.Ramp;
        // 高架鉄道はカーブでも減速しない
        const turning = c.din !== c.d && !(fast(tf) && fast(tt) && (isHighway(tf) || isHighway(tt))) && f.track !== 'erail';
        const merging = tf === RoadType.Ramp && isHighway(tt);
        const len = CarLayer.cellLen(c);
        const cg = line || walk ? 1 : Math.max(this.cong![c.from], 1);
        const kmh = walk ? 4.5 + (c.col % 3) * 0.6 : line ? LINES[f.track as LineKind].speedKmh * 1.2 : (merging ? ROADS[tt].speedKmh : def.speedKmh) * (f.track === 'bus' ? 0.8 : f.trailer ? 0.85 : 1);
        const speed = (((kmh / 3.6) * 0.9) / cg) * (turning ? 0.6 : 1);
        let adv = (dt * speed) / len;
        if (f.mid && occ) {
          const st = this.stations.get(f.track);
          if ((c.stop ?? 0) > 0) {
            // 駅で停車中
            c.stop! -= dt;
            adv = 0;
          } else {
            const inSt = !!st && st.has(c.from);
            if (!inSt) c.lastStop = -1;
            if (inSt) {
              // ホームでは速度を落とし、ホームの端のマスの中ほどで止まる
              adv *= 0.45;
              if (!st!.has(c.to) && c.lastStop !== c.from && c.t < 0.5 && c.t + adv >= 0.5) {
                c.t = 0.5;
                adv = 0;
                c.stop = 8;
                c.lastStop = c.from;
              }
            }
            // 前の列車との間隔：先の 2 マスに別の列車がいたら、マスの手前で待つ（長く詰まったら進む）
            const n = this.grid!.n;
            const ahead2 = (() => { const x = (c.to % n) + DX[c.d], y = ((c.to / n) | 0) + DY[c.d]; return this.grid!.inb(x, y) ? y * n + x : -1; })();
            const block = [c.to, ahead2].some((cell) => { if (cell < 0) return false; const o = occ!.get(CarLayer.occKey(cell, c.d)); return o && o !== c; });
            if (block && (c.wait ?? 0) < 25) {
              if (c.t + adv > 0.8) {
                adv = Math.max(0, 0.8 - c.t);
                c.wait = (c.wait ?? 0) + dt;
              }
            } else c.wait = 0;
          }
        }
        if (!line && !walk && adv > 0) {
          // 前の車（同じマスの先、または次のマス）との間をあける
          const lb = laneOf(c), me = f.halfLen;
          let gap = Infinity;
          for (const o of lanes.get((c.from * 8 + c.d) * 2 + lb) ?? []) if (o.c !== c && o.c.t > c.t) gap = Math.min(gap, (o.c.t - c.t) * len - o.h - me);
          if (gap === Infinity)
            for (let d = 0; d < 8; d++) {
              if (d === opp(c.d)) continue;
              for (const o of lanes.get((c.to * 8 + d) * 2 + lb) ?? []) if (o.c !== c) gap = Math.min(gap, (1 - c.t) * len + o.c.t * CarLayer.cellLen(o.c) - o.h - me);
            }
          const room = Math.max(0, gap - 1.5);
          if (room < adv * len) {
            // 長く詰まったら（交差点で行き詰まらないように）そのまま進む
            c.wait = (c.wait ?? 0) + dt;
            if (c.wait < 6) adv = room / len;
          } else c.wait = 0;
        }
        c.t += adv;
        let guard = 0;
        while (c.t >= 1 && guard++ < 3) {
          c.t -= 1;
          // ときどき入れ替えて、交通量の分布を保つ（トレーラーは途中で消えると目立つので、少なめに）
          if (!f.mid && Math.random() < (f.trailer ? 0.008 : 0.03)) {
            const nc = this.spawn(f);
            if (nc) Object.assign(c, nc);
            continue;
          }
          const nx = this.pickNext(f, c.to, c.d);
          if (!nx) {
            // 列車は行き止まりで止まり、しばらくして向きを変える（マップの端なら隣の都市へ出ていく）
            const g2 = this.grid!, ex = c.to % g2.n, ey = (c.to / g2.n) | 0;
            const edge = ex === 0 || ey === 0 || ex === g2.n - 1 || ey === g2.n - 1;
            if (f.mid && !edge) {
              if (c.revPending && (c.stop ?? 0) <= 0) {
                this.reverseTrain(f, c);
                c.revPending = false;
                continue;
              }
              if (!c.revPending) { c.revPending = true; c.stop = 14; }
              c.t = 1;
              break;
            }
            c.alive = false;
            break;
          }
          c.hist.unshift({ from: c.from, to: c.to, din: c.din, d: c.d, hA: c.hA });
          if (c.hist.length > 8) c.hist.length = 8;
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
        if (f.mid) {
          // 列車：車両ごとに、前と後ろの台車の位置から向きを決めて並べる
          const nCar = f.carsPer, sp = f.spacing, half = f.halfLen * 0.7;
          // 折り返しの手前の X 字の分岐器では、反対側の線路へ渡る
          const tb = this.endAhead(f, c);
          const laneAt = () => {
            if (!tb) return lane;
            const dist = (tb.ex - P.x) * tb.ux + (tb.ez - P.z) * tb.uz;
            const u = Math.max(0, Math.min(1, (tb.d0 - dist) / (tb.d0 - tb.d1)));
            return lane * (1 - 2 * u * u * (3 - 2 * u));
          };
          for (let j = 0; j < nCar; j++) {
            this.placeBack(f, c, Math.max(0, j * sp - half));
            const l0 = laneAt();
            const fx = P.x - P.tz * l0, fz = P.z + P.tx * l0, fh = P.h;
            this.placeBack(f, c, j * sp + half);
            const l1 = laneAt();
            const rx = P.x - P.tz * l1, rz = P.z + P.tx * l1, rh = P.h;
            let ang = Math.atan2(fx - rx, fz - rz);
            const tail = j === nCar - 1;
            if (tail) ang += Math.PI;
            this.v.set((fx + rx) / 2, (fh + rh) / 2, (fz + rz) / 2);
            this.q.setFromAxisAngle(this.up, ang);
            this.mtx.compose(this.v, this.q, this.s);
            if (j === 0 || tail) {
              if (hk < this.trainCap(f)) { f.mesh.setMatrixAt(hk, this.mtx); f.mesh.setColorAt(hk, f.colors[0]); hk++; }
            } else if (f.mid && mk < f.mid.instanceMatrix.count) {
              f.mid.setMatrixAt(mk, this.mtx);
              f.mid.setColorAt(mk, f.colors[0]);
              mk++;
            }
          }
          k++;
          if (k >= f.max) break;
          continue;
        }
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
      f.mesh.count = f.mid ? hk : k;
      if (f.mid) {
        f.mid.count = mk;
        f.mid.instanceMatrix.needsUpdate = true;
        if (f.mid.instanceColor) f.mid.instanceColor.needsUpdate = true;
      }
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
