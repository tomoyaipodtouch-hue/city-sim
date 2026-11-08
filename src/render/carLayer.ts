// 車・トラック・バス・電車・歩く人の表示（交通量に比例した台数を走らせる）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, opp } from '../sim/constants';
import { CIVIC, CivicId, isHighway, LINES, LineKind, ROADS, RoadType, ZoneType } from '../sim/defs';
import type { Building } from '../sim/world';
import { RailLayer, TRACK_GAP } from './railLayer';
import { isUrbanHighway, urbanTurnOk } from '../sim/traffic';
import { ROAD_LIFT } from './roadLayer';
import { findTurnbacks, Turnback, Island, islandSpread, ISLAND_GAP } from './turnback';
import { BOGIE, boxTruck, cityBus, garbageTruck, TRAIN_SPEC, TrainKind, hatchback, kei, minivan, person, pickup, sedan, suv, taxi, tractor, trailerBox, trailerTank, trainCar, vc } from './vehicles';
import { createVehicleMaterial, vehicleUniforms } from './vehicleMaterial';

const MAX_CARS = 1500;
const MAX_TRUCKS = 300;
const MAX_PEOPLE = 700;
const MAX_LIGHTS = (MAX_CARS + MAX_TRUCKS + 200) * 2;
// カーブで減速する割合（乗用車・列車、バス・大きいトラック、トレーラー）
const TURN_CAR = 0.8, TURN_BIG = 0.75, TURN_TRAILER = 0.7;
const JACKKNIFE = (80 * Math.PI) / 180; // トレーラーが折れ曲がる角度の上限
const KINGPIN = 1.6; // トラクターの中心から連結部までの距離
const TRAILER_AXLE = 12.2; // 連結部から後ろの車輪までの距離
const TRAILER_REAR = KINGPIN + 14.2; // トラクターの中心から荷台の後ろの端までの距離
const TRAIN_ACC = 1.5; // 終点を出る列車の加速（m/s²）
const LEFT_TERMINAL = -2; // lastStop：終点の駅で向きを変えて、その駅を出ていくところ（駅を出るまで止まらない）
const FIX_LEN = 16; // 向きを変えたときの横のずれを、この道のり（m）でなくす
const A_LAT = 8; // 道路の曲がり角で、横にかかる加速度の上限（m/s²）

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
  tbFor?: Turnback | null; // tbSide を決めた折り返し
  tbSide?: 0 | 1; // 終点のどちらのホームに入るか（0 = 分岐器で渡った先、1 = 渡らずにそのまま）
  // 向きを変えて出ていくときに反対側の線路へ移るところ（止まった点からの道のりで d1〜d0）と、先頭のいまの道のり s
  dep?: { d0: number; d1: number; s: number } | null;
  // 終点で向きを変えて出ていく途中、ふさいでいる区間（ホームと分岐器）。最後尾がそこを出たら null。
  // 着く列車は、ぶつかる向きならその手前で待つ（tb がないのは分岐器のない行き止まり。cells はマスと出ていく向き）
  leave?: { tb: Turnback | null; side: 0 | 1; cells: Map<number, number>; s: number; d0: number } | null;
  hw?: number; // 終点の分岐器の手前で待っている秒数（長く待ったら進む）
  served?: number; // 最後に止まった駅のマス（終点で向きを変えるとき、その駅にもう止まったかを見る）
  acc?: number; // 終点で向きを変えて出ていく列車のいまの速さ（m/s）。止まった位置からゆっくり加速する
  flip?: boolean; // 中間の車両が逆向き（向きを変えるたびに入れ替わる）
  lanes?: Float32Array; // 台車ごとの、線路の中心からの横の位置（前のコマ。前の車両の前の台車から順に）
  // 向きを変えたときの、横の位置のずれ（台車ごと）。短い路線で分岐器が重なるときなどに出る。進んだ道のり s のあいだに少しずつなくす
  fix?: { k: Float32Array; s: number; set: boolean } | null;
  vs?: number; // 見た目の乱数（人の背の高さ・歩く周期）
  sk?: number; // 今の速さの割合（カーブに入る・出るところでなめらかに変える）
  lo?: number; // 今の車線の横の位置（道路の種類が変わるところで、横に跳ばずに移る）
  rx?: number; // トレーラーの後ろの車軸の位置（連結部に引かれて動く）
  rz?: number;
  rs?: number; // 後ろの車軸にいちばん近い道の上の点の、トラクターからの道のり（後ろの車との間隔に使う）
  nx?: [number, number] | null; // 道路の車：次に進むノードと向き（マスの後半で先に決めておく）
  ly?: number; // 車線を移るあいだの、車体の向きのずれ（ラジアン）
}

// 走る場所：道路（車・トラック・バス）、歩道、線路（鉄道・高架鉄道・モノレール・地下鉄）
type Track = 'road' | 'bus' | 'walk' | LineKind;

// 車両の材質（全部の車両で共有）と、歩く人の材質
const VEH_MAT = createVehicleMaterial();
const WALK_MAT = createVehicleMaterial(true);
// 形の大きさ：[幅, 長さ, 中心の前後の位置]（車の下の影に使う）
const footOf = (g: THREE.BufferGeometry): [number, number, number] => {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return [b.max.x - b.min.x, b.max.z - b.min.z, (b.max.z + b.min.z) / 2];
};

class Fleet {
  mesh: THREE.InstancedMesh;
  foot: [number, number, number];
  tfoot: [number, number, number] = [0, 0, 0];
  trailer: THREE.InstancedMesh | null = null;
  // 列車：先頭と最後尾は mesh（運転台つき）、中間の車両は mid
  mid: THREE.InstancedMesh | null = null;
  carsPer = 1;
  spacing = 0;
  trailerColors: THREE.Color[] = [];
  axle = 0; // トレーラーの連結部から後ろの車軸（2軸の真ん中）までの距離
  lamp: [number, number] = [0, 0]; // 尾灯の位置（連結部から後ろへの距離、高さ）
  cars: Car[] = [];
  cdf = new Float32Array(0);
  nodes = new Int32Array(0);
  target = 0;
  vol: Float32Array = new Float32Array(0); // 次の行き先を選ぶときの重み
  // 列車：つながった線路（路線）ごとの番号と、路線ごとの出す場所・目標の本数
  comp: Int32Array | null = null;
  lines: { nodes: Int32Array; cdf: Float32Array; quota: number }[] = [];
  colors: THREE.Color[];
  constructor(geo: THREE.BufferGeometry, public max: number, palette: number[], public track: Track = 'road', public halfLen = 2.3, public share = 1) {
    this.colors = palette.map((h) => new THREE.Color(h));
    this.mesh = this.makeMesh(geo, max);
    this.foot = footOf(geo);
  }
  makeMesh(geo: THREE.BufferGeometry, max: number) {
    const m = new THREE.InstancedMesh(geo, this.track === 'walk' ? WALK_MAT : VEH_MAT, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.receiveShadow = true;
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
  withTrailer(geo: THREE.BufferGeometry, palette: number[], axle: number, lamp: [number, number]) {
    this.trailer = this.makeMesh(geo, this.max);
    this.trailerColors = palette.map((h) => new THREE.Color(h));
    this.tfoot = footOf(geo);
    this.axle = axle;
    this.lamp = lamp;
    return this;
  }
}

// 車の色：実際の街に多い色ほど多く入れる（白・黒・銀・灰が中心）
const CAR_COLORS = [0xeef0f0, 0xeef0f0, 0xeef0f0, 0xeef0f0, 0xf6f6f3, 0xf6f6f3, 0x141619, 0x141619, 0x141619, 0xa9adb2, 0xa9adb2, 0xc4c8cc, 0x5b6067, 0x5b6067, 0x26324d, 0x2b4f86, 0x8c1d22, 0x6a5442, 0xbfb49c, 0x3d4a40];
// 軽自動車は明るい色も多い
const KEI_COLORS = [0xeef0f0, 0xeef0f0, 0xeef0f0, 0x141619, 0xa9adb2, 0xd9cdb4, 0xd9cdb4, 0x9cc1d1, 0xc98f8b, 0x7f9a7c, 0x5b6067, 0xd3b064];
// タクシー：濃い藍色が多く、黒・黄・緑・白
const TAXI_COLORS = [0x1d2340, 0x1d2340, 0x1d2340, 0x1d2340, 0x141619, 0x141619, 0xd6a72c, 0x2f6b4f, 0xeef0f0];
const CAB_COLORS = [0xeef0f0, 0xeef0f0, 0xeef0f0, 0x2b4f86, 0x8c1d22, 0x3e6b45, 0xd9a42a, 0x5b6067];
// 人の服の色（ズボン・肌・髪は材質の中で選ぶ）
const CLOTH_COLORS = [0xe9e9e6, 0xe9e9e6, 0x26272a, 0x26272a, 0x2b3a55, 0x7d8288, 0xc8b89a, 0x5d6a48, 0x7a2e35, 0x9db8d2, 0xc99a2e, 0xb23a33, 0xd99aa5, 0x7a5a42];
const MAX_BLOBS = 2600;
// 描いた台数の分だけ GPU へ送る（画面の外を省くので、送る量も減る）
const flush = (a: THREE.BufferAttribute | null | undefined, n: number, size: number) => {
  if (!a || !n) return;
  a.clearUpdateRanges();
  a.addUpdateRange(0, n * size);
  a.needsUpdate = true;
};

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
  // 車の下の柔らかい影（全部の車で 1 回の描画）
  private blob: THREE.InstancedMesh;
  private nb = 0;
  // 夜の前照灯が道路を照らす光（加算で重ねる、1 回の描画）
  private beams: THREE.InstancedMesh;
  private nbm = 0;
  // 画面の外の車は描かない（カメラは描画のときに受け取る）
  private cam: THREE.PerspectiveCamera | null = null;
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sph = new THREE.Sphere();
  private cull = false;
  private bs = new THREE.Vector3();
  private grabCam = (_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera) => {
    const c = cam as THREE.PerspectiveCamera;
    if (c.isPerspectiveCamera && c.fov < 80) this.cam = c;
  };
  private lightsHead: THREE.Points;
  private lightsTail: THREE.Points;
  private grid: Grid | null = null;
  private traffic: Float32Array | null = null;
  private cong: Float32Array | null = null;
  private mtx = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private eu = new THREE.Euler(0, 0, 0, 'YXZ');
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private pt = { x: 0, z: 0, h: 0, tx: 0, tz: 1 };
  private ptNode = 0; // pt があるマスのノード
  private ptCell: Cell | null = null; // pt があるマス
  enabled = true;
  showSubway = false;
  viewDist = 500;

  // 高画質では、前照灯の光（足し合わせ）がトーンマッピングの前に入って強く見えるので、少し弱める
  private hq = false;
  setHq(on: boolean) {
    this.hq = on;
    this.setNight(this.night);
  }
  // 夜は車が暗くなりすぎないように、少し光らせる。前後のライトは光の点で描く
  setNight(k: number) {
    this.night = k;
    vehicleUniforms.uNightK.value = k;
    (this.beams.material as THREE.MeshBasicMaterial).opacity = 0.3 * k * (this.hq ? 0.6 : 1);
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
    // 自家用車の種類と割合（台数の上限の合計は前と同じくらい）
    this.cars = [
      new Fleet(sedan(), 410, CAR_COLORS, 'road', 2.3, 0.22),
      new Fleet(hatchback(), 260, CAR_COLORS, 'road', 2.0, 0.14),
      new Fleet(suv(), 372, CAR_COLORS, 'road', 2.4, 0.2),
      new Fleet(pickup(), 75, [0xeef0f0, 0x141619, 0xa9adb2, 0x5b6067, 0x8c1d22, 0x2b4f86], 'road', 2.7, 0.04),
      new Fleet(minivan(), 205, CAR_COLORS, 'road', 2.4, 0.11),
      new Fleet(kei(), 354, KEI_COLORS, 'road', 1.7, 0.19),
      new Fleet(taxi(), 186, TAXI_COLORS, 'road', 2.2, 0.1),
    ];
    // トラック：箱型、箱型のトレーラー、タンクのトレーラー
    // （後ろの車軸は形の車輪の真ん中：箱 z = -11.6/-12.8、タンク -11.2/-12.4。尾灯は箱 z = -14.1・高さ 1.05、タンク -13.5・1.32）
    this.trucks = [
      new Fleet(boxTruck(), 160, CAB_COLORS, 'road', 4.4, 0.45),
      new Fleet(tractor(), 140, CAB_COLORS, 'road', 3.1, 0.4).withTrailer(trailerBox(), [0xf0f1f0, 0xe2e4e6, 0xcfd3d7, 0xa8432f, 0x2d5f9a], TRAILER_AXLE, [14.1, 1.05]),
      new Fleet(tractor(), 60, CAB_COLORS, 'road', 3.1, 0.15).withTrailer(trailerTank(), [0xd8dce0, 0xc8ccd0, 0xe8eaec], 11.8, [13.5, 1.32]),
    ];
    this.packers = new Fleet(garbageTruck(), 60, [0x2e7d4f, 0x2e6da4, 0x3f7f3f, 0x5b6067], 'road', 3.7);
    this.bus = new Fleet(cityBus(), 200, [0x1f7a4a, 0x1f5fa8, 0xc8702a, 0xa3262e, 0x2f3a4a], 'bus', 6.0);
    this.lineFleets = [
      new Fleet(train, 60, [0xffffff], 'rail').asTrain('rail'),
      new Fleet(train, 60, [0xffffff], 'erail').asTrain('erail'),
      new Fleet(mono, 50, [0xffffff], 'mono').asTrain('mono'),
      new Fleet(train, 60, [0xffffff], 'sub').asTrain('sub'),
    ];
    this.people = new Fleet(person(), MAX_PEOPLE, CLOTH_COLORS, 'walk');
    this.fleets = [...this.cars, ...this.trucks, this.packers, this.bus, ...this.lineFleets, this.people];
    this.lightsHead = this.makeLights(0xfff1c8, 3.2);
    this.lightsTail = this.makeLights(0xff3020, 2.2);
    this.group.add(this.lightsHead, this.lightsTail);
    for (const f of this.fleets) {
      for (const m of [f.mesh, f.trailer, f.mid]) {
        if (!m) continue;
        m.onBeforeRender = this.grabCam;
        this.group.add(m);
      }
    }
    this.blob = this.makeBlob();
    this.beams = this.makeBeams();
    this.group.add(this.blob, this.beams);
  }

  // 前照灯の光：車の前から先へ広がりながら薄くなる（テクスチャの上が車に近い側）
  private makeBeams() {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d')!, img = x.createImageData(S, S);
    const sm = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const t = (j + 0.5) / S, u = Math.abs((i + 0.5) / S - 0.5) * 2;
        const hw = 0.32 + 0.68 * t;
        const a = Math.pow(1 - t, 1.4) * sm(0, 0.1, t) * (1 - sm(hw * 0.5, hw, u));
        const v = Math.round(255 * a);
        img.data.set([v, v, v, 255], (j * S + i) * 4);
      }
    x.putImageData(img, 0, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xfff3e0, alphaMap: new THREE.CanvasTexture(c), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), mat, MAX_BLOBS);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = 2;
    return m;
  }

  // 車の下の影：角の丸い四角が外へ向かって薄くなる
  private makeBlob() {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d')!, img = x.createImageData(S, S);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const px = Math.abs((i + 0.5) / S - 0.5) * 2, pz = Math.abs((j + 0.5) / S - 0.5) * 2;
        const bx = 0.62, bz = 0.78;
        const dx = Math.max(px - bx, 0), dz = Math.max(pz - bz, 0);
        const d = Math.hypot(dx, dz) + Math.min(Math.max(px - bx, pz - bz), 0);
        const a = Math.max(0, Math.min(1, 1 - (d + 0.12) / 0.34));
        const v = Math.round(255 * a * a * (3 - 2 * a));
        img.data.set([v, v, v, 255], (j * S + i) * 4);
      }
    x.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.62, alphaMap: tex, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, MAX_BLOBS);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = 1;
    m.onBeforeRender = this.grabCam;
    return m;
  }
  // 影を 1 つ置く（向きは this.q）。f = [幅, 長さ, 中心の前後]
  private addBlob(x: number, h: number, z: number, tx: number, tz: number, f: [number, number, number]) {
    if (this.nb >= MAX_BLOBS) return;
    this.v.set(x + tx * f[2], h + 0.04, z + tz * f[2]);
    this.bs.set(f[0] * 1.12, 1, f[1] * 1.06);
    this.mtx.compose(this.v, this.q, this.bs);
    this.blob.setMatrixAt(this.nb++, this.mtx);
  }
  // 画面の中（少し広め）に入っているか
  private seen(x: number, y: number, z: number, r: number) {
    if (!this.cull) return true;
    this.sph.center.set(x, y, z);
    this.sph.radius = r;
    return this.frustum.intersectsSphere(this.sph);
  }

  setData(g: Grid, traffic: Float32Array, cong: Float32Array, freight: Float32Array, riders?: Float32Array, garbage?: Uint8Array, garbageLeft?: Uint8Array) {
    this.grid = g;
    this.traffic = traffic;
    this.cong = cong;
    // 道路が変わったかもしれないので、先に決めた行き先は決め直す
    for (const f of this.fleets) for (const c of f.cars) c.nx = undefined;
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
    // 歩く人は、交通量の多い一般の道路の歩道に多い（寄って見たとき、街に人がいるとわかるくらい）。
    // 人数には上限があるので、店の並ぶ通りや密度の高い住宅地のそばに集める（街なかで人が見えるように）
    {
      const n = g.n, pv = new Float32Array(traffic.length);
      for (let i = 0; i < N; i++) {
        if (traffic[i] <= 0 || !walkable(i)) continue;
        const x = i % n, y = (i / n) | 0;
        let k = 1;
        for (let d = 0; d < 8; d += 2) {
          if (!g.inb(x + DX[d], y + DY[d])) continue;
          const j = (y + DY[d]) * n + x + DX[d];
          if (g.zone[j] === ZoneType.C) k += 1.5;
          else if (g.zone[j] === ZoneType.R && g.zden[j] > 0) k += 0.6;
        }
        pv[i] = traffic[i] * k;
      }
      build(this.people, pv, 0.012);
    }
    if (riders && riders.length === 5 * N) {
      // バスは40人に1台、電車は1両に乗る人数を多めに見て台数を決める
      // バスは前の 4 割の台数にし、バス停の数の 1.5 倍までにする
      build(this.bus, riders.subarray(0, N), 0.0008);
      let stops = 0;
      for (let i = 0; i < N; i++) if (g.bstop[i]) stops++;
      stops += this.busStopBuildings;
      this.bus.target = Math.min(this.bus.target, Math.max(1, Math.ceil(stops * 1.5)));
      // 高架鉄道（i = 1）は本数を 4 割に（4両編成）
      this.lineFleets.forEach((f, i) => {
        build(f, riders.subarray((i + 1) * N, (i + 2) * N), (0.0012 / f.carsPer) * (i === 1 ? 0.4 : 1));
        this.splitLines(g, f);
      });
    }
  }

  // 線路をつながりごとの路線に分け、乗る人が少ない路線にも列車が走るように路線ごとの本数を決める
  private splitLines(g: Grid, f: Fleet) {
    const n = g.n, N = n * n, mask = g[f.track as LineKind];
    const comp = f.comp && f.comp.length === N ? f.comp.fill(-1) : (f.comp = new Int32Array(N).fill(-1));
    const lines: { cells: number[]; riders: number }[] = [];
    const stack: number[] = [];
    for (let s = 0; s < N; s++) {
      if (!mask[s] || comp[s] >= 0) continue;
      const id = lines.length, L = { cells: [] as number[], riders: 0 };
      lines.push(L);
      comp[s] = id;
      stack.push(s);
      while (stack.length) {
        const c = stack.pop()!;
        L.cells.push(c);
        L.riders += f.vol[c] || 0;
        const x = c % n, y = (c / n) | 0, m = mask[c];
        for (let d = 0; d < 8; d++) {
          if (!(m & (1 << d)) || !g.inb(x + DX[d], y + DY[d])) continue;
          const j = (y + DY[d]) * n + x + DX[d];
          if (mask[j] && comp[j] < 0) { comp[j] = id; stack.push(j); }
        }
      }
    }
    // 駅のある路線だけに走らせる
    const st = this.stations.get(f.track);
    const big = lines.filter((L) => L.cells.length >= 4 && !!st && L.cells.some((c) => st.has(c)));
    const sumR = big.reduce((a, L) => a + L.riders, 0) || 1;
    // 本数は乗る人の割合で分け、どの路線にも長さに応じて最低 1〜4 本は走らせる
    // 線路の長さで走れる本数には限りがある（多すぎると前の列車に詰まる）。高架鉄道（長さ 55.6m）でおよそ 8 マスに 1 本
    const per = Math.max(6, (2.3 * ((f.carsPer - 1) * f.spacing + 2 * f.halfLen)) / CELL);
    let quotas = big.map((L) => {
      const cap = Math.max(1, Math.floor(L.cells.length / per));
      return Math.min(cap, Math.max(Math.min(4, 1 + Math.floor(L.cells.length / 25)), Math.round((f.target * L.riders) / sumR)));
    });
    const sum = quotas.reduce((a, q) => a + q, 0);
    if (sum > f.max) quotas = quotas.map((q) => Math.max(1, Math.floor((q * f.max) / sum)));
    f.target = Math.min(f.max, quotas.reduce((a, q) => a + q, 0));
    f.lines = lines.map((L) => {
      const k = big.indexOf(L);
      let t = 0;
      const cdf = Float32Array.from(L.cells, (c) => (t += (f.vol[c] || 0) + 1));
      return { nodes: Int32Array.from(L.cells), cdf, quota: k >= 0 ? quotas[k] : 0 };
    });
    // 路線ごとの本数より多い列車は消す（路線が分かれた・短くなったとき）
    const have = new Array(lines.length).fill(0);
    f.cars = f.cars.filter((c) => { const k = comp[c.from]; if (k < 0) return false; return ++have[k] <= f.lines[k].quota; });
  }

  // 列車を出す路線：目標の本数にいちばん足りていない路線
  private pickLine(f: Fleet) {
    if (!f.comp || !f.lines.length) return null;
    const have = new Array(f.lines.length).fill(0);
    for (const c of f.cars) { const k = f.comp[c.from % f.comp.length]; if (k >= 0) have[k]++; }
    let best = -1, bd = 0;
    f.lines.forEach((L, k) => { const d = (L.quota - have[k]) / Math.max(1, L.quota); if (L.quota > have[k] && d > bd) { bd = d; best = k; } });
    return best >= 0 ? f.lines[best] : null;
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
    const L = f.mid ? this.pickLine(f) : null;
    if (f.mid && !L) return null;
    const nodes = L ? L.nodes : f.nodes, cdf = L ? L.cdf : f.cdf;
    if (!nodes.length) return null;
    const total = cdf[cdf.length - 1];
    const r = Math.random() * total;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const from = nodes[lo];
    const nx = this.pickNext(f, from, -1);
    if (!nx) return null;
    if (f.trailer) {
      // トレーラーは、まっすぐ後ろにつながる道のある場所にだけ出す（荷台が道の外へ突き出さないように）
      const g = this.grid!, n = g.n, N = n * n, cc = from % N, bx = (cc % n) - DX[nx[1]], by = ((cc / n) | 0) - DY[nx[1]];
      if (!g.inb(bx, by)) return null;
      let ok = false;
      for (const lv of [0, 1]) g.forEachOut(lv * N + by * n + bx, (v, d) => { if (v === from && d === nx[1]) ok = true; });
      if (!ok) return null;
    }
    const car: Car = {
      from, to: nx[0], din: nx[1], d: nx[1], t: Math.random(), hA: this.trackH(f, from), alive: true, lane: Math.random() < 0.5 ? 0 : 1,
      col: (Math.random() * f.colors.length) | 0, col2: (Math.random() * Math.max(1, f.trailerColors.length)) | 0, hist: [],
    };
    if (f.mid) {
      this.seedHistory(f, car);
      // 行き止まりのすぐ近くでは、後ろの車両が線路の外にはみ出すので出さない（ほかの場所で出し直す）
      // ただし、列車が収まる場所のないごく短い路線では、そのまま出す
      const need = CarLayer.trainBogies(f);
      let room = car.t * CarLayer.cellLen(car);
      for (const h of car.hist) room += CarLayer.cellLen(h);
      if (room < need && L && L.nodes.length * CELL > need + 2 * CELL) return null;
    }
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
      // 入口の高さは、走ってきたときと同じく前後のマスの間（向きを変えたときに高さがずれないように）
      cur.hA = (this.trackH(f, j) + this.trackH(f, cur.from)) / 2;
      c.hist.push(prev);
      cur = prev;
    }
  }

  // node へ向き d で入ると、2 マス先までに 135° の折り返しを通るしかないか（トレーラーが避ける）
  private hairpinAhead(node: number, d: number) {
    if (this.sharpOnly(node, d)) return true;
    let any = false, ok = false;
    this.grid!.forEachOut(node, (v2, d2) => {
      const t = (d2 - d) & 7;
      if (t === 4) return;
      any = true;
      if (t !== 3 && t !== 5 && !this.sharpOnly(v2, d2)) ok = true;
    });
    return any && !ok;
  }
  // node へ向き d で入ったあと、出ていける向きが 135° の折り返しだけか
  private sharpOnly(node: number, d: number) {
    let any = false, ok = false;
    this.grid!.forEachOut(node, (_, d2) => {
      const t = (d2 - d) & 7;
      if (t === 4) return;
      any = true;
      if (t !== 3 && t !== 5) ok = true;
    });
    return any && !ok;
  }
  // 次のノードを、交通量の多い方を選びやすくして決める（Uターンはしない）
  private pickNext(f: Fleet, node: number, din: number): [number, number] | null {
    const g = this.grid!, tr = f.track === 'road' && f !== this.packers ? this.traffic! : f.vol;
    const opts: [number, number][] = [];
    const ws: number[] = [];
    const sharp: [number, number, number][] = [];
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
      // トレーラーは、ほかに行けるところがあれば 135° の急な折り返しを通らない（荷台が大きく振られて、後ろの車輪が横にすべるので）。
      // その先が急な折り返ししかないマスにも入らない
      const turn = (d - din) & 7;
      if (f.trailer && ((din >= 0 && (turn === 3 || turn === 5)) || this.hairpinAhead(v, d))) {
        sharp.push([v, d, w]);
        return;
      }
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
    if (!opts.length)
      for (const [v, d, w] of sharp) {
        opts.push([v, d]);
        ws.push(w);
        total += w;
      }
    if (!opts.length) return null;
    // 列車は分かれ道で、行き先を順番に変える（どちらの路線にも列車が行くように）
    if (f.mid && opts.length > 1 && din >= 0) {
      const key = node * 8 + din, k = this.forkTurn.get(key) ?? (Math.random() * opts.length) | 0;
      this.forkTurn.set(key, k + 1);
      return opts.slice().sort((a, b) => a[1] - b[1])[k % opts.length];
    }
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
  private forkTurn = new Map<number, number>();
  private busStopBuildings = 0;
  // 線路の行き止まり（折り返し）。線路が変わったときに呼ぶ
  private turnbacks = new Map<string, Map<number, Turnback>>();
  private islands: Island[] = [];
  setIslands(islands: Island[]) { this.islands = islands; }
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
      if (tb && tb.ux * DX[d] + tb.uz * DY[d] > 0.5) {
        c.tb = tb;
        // 空いているホームを選ぶ（ふだんは渡った先、そこがふさがっていればそのまま入る）。分岐器に着くまでは選び直す
        const cx = ((c.to % n) + 0.5) * CELL, cz = (((c.to / n) | 0) + 0.5) * CELL;
        if (c.tbFor !== tb || (tb.ex - cx) * tb.ux + (tb.ez - cz) * tb.uz > tb.d0 + CELL) {
          c.tbFor = tb;
          c.tbSide = this.freeSide(f, c, tb) ?? 0;
        }
        return tb;
      }
      if (!(mask[i] & (1 << d))) break;
      x += DX[d]; y += DY[d];
      if (!g.inb(x, y)) break;
    }
    // 折り返しへ向かっていたが、分かれ道でそれた
    if (c.tbFor && !c.revPending) { c.tbFor = null; c.tbSide = undefined; }
    return null;
  }
  // 先頭の台車から、折り返しの止まる点までの道のり（まっすぐな区間として）
  private headDist(o: Car, tb: Turnback) {
    const n = this.grid!.n, ox = ((o.from % n) + 0.5) * CELL, oz = (((o.from / n) | 0) + 0.5) * CELL;
    return (tb.ex - ox) * tb.ux + (tb.ez - oz) * tb.uz - (o.t - 0.5) * Math.hypot(DX[o.d], DY[o.d]) * CELL;
  }
  // 終点の空いているホーム（0 = 渡った先、1 = そのまま）。先に着いた列車・出ていく途中の列車がいるホームは使わない。
  // 渡らずに入ったホームから出ていく列車は分岐器を斜めに渡るので、出終わるまでどちらにも入れない
  private freeSide(f: Fleet, c: Car, tb: Turnback): 0 | 1 | null {
    const used = [false, false], me = this.headDist(c, tb);
    for (const o of f.cars) {
      if (o === c) continue;
      if (o.tbFor === tb && o.tbSide !== undefined && (o.revPending || this.headDist(o, tb) < me)) used[o.tbSide] = true;
      if (o.leave && o.leave.tb === tb) { used[o.leave.side] = true; if (o.leave.side === 1) used[0] = true; }
    }
    return !used[0] ? 0 : !used[1] ? 1 : null;
  }
  // 終点へ着く列車 c が、分岐器の手前で待つか（入るホームがふさがっている・出ていく列車とぶつかる）。
  // c 自身がまだ反対側の終点を出ていく途中なら待たない（ごく短い路線で、両端で待ち合って動けなくならないように）
  private throatHold(f: Fleet, c: Car, tb: Turnback) {
    if (c.tbSide === undefined || c.leave) return false;
    const me = this.headDist(c, tb);
    for (const o of f.cars) {
      if (o === c) continue;
      if (o.tbFor === tb && o.tbSide === c.tbSide && (o.revPending || this.headDist(o, tb) < me)) return true;
      // 渡った先から出ていく列車と、渡らずに入る列車だけは、別の線路なのでそのまま行ける
      if (o.leave && o.leave.tb === tb && !(c.tbSide === 1 && o.leave.side === 0)) return true;
    }
    return false;
  }
  // 終点で向きを変えて出ていく列車 c の道に、もう分岐器の中まで来ている着く列車がいるか
  // （入るホームに止まっている列車がいて先へ進めない列車は待たない。待ち合って動けなくならないように）
  private departHold(f: Fleet, c: Car, tb: Turnback) {
    const side = c.tbFor === tb && c.tbSide !== 1 ? 0 : 1;
    for (const o of f.cars) {
      if (o === c || o.tbFor !== tb || o.revPending || o.tbSide === undefined || (o.tbSide === 1 && side === 0) || this.headDist(o, tb) >= tb.d0) continue;
      if (f.cars.some((q) => q !== o && q.revPending && q.tbFor === tb && q.tbSide === o.tbSide)) continue;
      return true;
    }
    return false;
  }
  // 分岐器のない行き止まりから出ていく列車 o の区間へ、c が向かい合って入ろうとしているか
  private static intoLeave(o: Car, c: Car, cell: number) {
    const d = o.leave!.cells.get(cell);
    if (d === undefined) return false;
    const t = (c.d - d) & 7;
    return t >= 3 && t <= 5;
  }
  // 先の列車 o が、終点の別のホームへ入っていて、後ろの列車 c の線路をもうふさいでいないか
  // （分岐器を最後尾まで渡り終えていれば、走っていても止まっていても、c はそのまま空いているホームへ入れる）
  private otherPlatform(f: Fleet, o: Car, c: Car) {
    const tb = o.tbFor;
    if (!tb || tb !== c.tbFor || o.tbSide === undefined || c.tbSide === undefined || o.tbSide === c.tbSide) return false;
    if (o.revPending || (o.stop ?? 0) > 0) return true;
    const n = this.grid!.n, ox = ((o.from % n) + 0.5) * CELL, oz = (((o.from / n) | 0) + 0.5) * CELL;
    const step = Math.hypot(DX[o.d], DY[o.d]) * CELL;
    const head = (tb.ex - ox) * tb.ux + (tb.ez - oz) * tb.uz - (o.t - 0.5) * step;
    const tail = head + CarLayer.trainBack(f);
    return tail < (tb.d0 + tb.d1) / 2;
  }
  // 列車の位置（c）は先頭の車両の前の台車。そこから最後尾の車両の後ろの台車まで・後ろの端までの長さ
  private static trainBogies(f: Fleet) {
    return (f.carsPer - 1) * f.spacing + 2 * f.halfLen * BOGIE;
  }
  private static trainBack(f: Fleet) {
    return (f.carsPer - 1) * f.spacing + f.halfLen * (1 + BOGIE);
  }
  // 行き止まりで向きを変える：最後尾の車両の後ろの台車が新しい先頭になり、来た道を戻る（右側通行なので、渡った先の線路をそのまま走る）
  // 列車は同じ場所にとどまる（車両の並びが前後で入れ替わるだけ）。先頭は行き止まりのマスの入口（t = 1）で止まっている
  private reverseTrain(f: Fleet, c: Car) {
    const rev = (q: Cell): Cell => {
      const n = this.grid!.n, x = (q.from % n) - DX[q.din], y = ((q.from / n) | 0) - DY[q.din];
      const to = this.grid!.inb(x, y) ? y * n + x : q.from;
      // 入口の高さは、もとの出口の高さ
      return { from: q.from, to, din: opp(q.d), d: opp(q.din), hA: (this.trackH(f, q.from) + this.trackH(f, q.to)) / 2 };
    };
    const len = CarLayer.trainBogies(f);
    // 分岐器で渡って入ったホームなら、そのまま右側の線路。渡らずに入ったホームや分岐器のない行き止まりからは、
    // 出ていく途中で反対側の線路へ移る（止まっていた線路から少しずつ）
    const tb = this.turnbacks.get(f.track)?.get(c.to);
    const side: 0 | 1 = tb && c.tbFor === tb && c.tbSide !== 1 ? 0 : 1;
    c.dep = side === 0 ? null : tb ? { d0: tb.d0, d1: tb.d1, s: len } : { d0: len + CELL * 1.6, d1: len, s: len };
    const segs: Cell[] = [c, ...c.hist];
    // 出ていくあいだふさぐ区間：止まった点から分岐器の終わりまでのマス（出ていく向きつき）。
    // 分岐器のない行き止まりでは、線路を移り終えたあと 2 マス先まで（着く列車がすぐ手前のカーブで待って、すれ違う列車と重ならないように）
    const zone = tb ? tb.d0 : len + CELL * 3.6;
    const cells = new Map<number, number>([[c.to, opp(c.d)]]);
    for (let j = 0, acc = 0; j < segs.length && acc < zone; j++) {
      cells.set(segs[j].from, opp(segs[j].din));
      acc += CarLayer.cellLen(segs[j]);
    }
    c.leave = { tb: tb ?? null, side, cells, s: len, d0: zone };
    let rem = len;
    let k = 0, tf = 0;
    for (; k < segs.length; k++) {
      const L = CarLayer.cellLen(segs[k]);
      const avail = (k === 0 ? c.t : 1) * L;
      if (rem <= avail || k === segs.length - 1) { tf = Math.max(0, (avail - Math.min(rem, avail)) / L); break; }
      rem -= avail;
    }
    // その駅にもう止まったか：先頭がホームにいる、または止まった駅のマスに列車がまだかかっていて、列車の 2 割以上がホームの上にある
    // （ホームの先の短い行き止まりで向きを変えたとき）。それなら、出ていくときにその駅ではもう止まらない（新しい先頭がそのホームにいるとき）。
    // 行き止まりからホームまで離れていれば（途中の駅）、反対向きでもう一度止まる
    const st = this.stations.get(f.track);
    let onSt = 0;
    if (st) for (let j = 0; j <= k; j++) if (st.has(segs[j].from)) onSt += j === k ? (1 - tf) * CarLayer.cellLen(segs[j]) : (j === 0 ? c.t : 1) * CarLayer.cellLen(segs[j]);
    const served = !!st && (st.has(c.from) || (c.served !== undefined && onSt >= 0.2 * len && segs.slice(0, k + 1).some((q) => q.from === c.served)));
    c.served = undefined;
    const head = rev(segs[k]);
    const hist: Cell[] = [];
    for (let j = k - 1; j >= 0; j--) hist.push(rev(segs[j]));
    c.from = head.from; c.to = head.to; c.din = head.din; c.d = head.d; c.hA = head.hA;
    c.t = 1 - tf;
    c.hist = hist;
    c.tbFor = null;
    c.tbSide = undefined;
    c.tbKey = -1;
    // 駅にいれば、駅を出るまでもう止まらない。止まった位置から加速する。中間の車両は向きを変えない
    c.lastStop = served && st!.has(c.from) ? LEFT_TERMINAL : -1;
    c.hw = 0;
    c.acc = 0;
    c.flip = !c.flip;
    // 横の位置も向きを変える前のまま（台車の並びは前後が逆になる）。計算とのずれは次に並べるときに求める
    const m = c.lanes?.length ?? 0;
    c.fix = null;
    if (m === 2 * f.carsPer) {
      const k = new Float32Array(m);
      for (let i = 0; i < m; i++) k[i] = -c.lanes![m - 1 - i];
      c.fix = { k, s: 0, set: false };
    }
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
    this.ptNode = c.from;
    this.ptCell = c;
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
      this.blob.count = 0;
      this.beams.count = 0;
      return;
    }
    const lit = this.night > 0.05;
    // 歩く動きの時間（一時停止中は止まる）
    vehicleUniforms.uWalk.value += dt;
    // 画面の外の車は描かない（影の分だけ少し広めに見る）。近づいたときだけ車と人の影を落とす
    if (this.cam) {
      this.cam.updateMatrixWorld();
      this.pm.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.pm);
      this.cull = true;
    }
    const near = this.viewDist < 360;
    for (const f of this.fleets)
      for (const m of [f.mesh, f.trailer, f.mid]) if (m) m.castShadow = f.track === 'walk' ? this.viewDist < 160 : f.mid ? this.viewDist < 900 : near;
    this.nb = 0;
    this.nbm = 0;
    const hp = this.lightsHead.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tp = this.lightsTail.geometry.getAttribute('position') as THREE.BufferAttribute;
    let nh = 0, nt = 0;
    const P = this.pt;
    // 車どうしの間隔：同じマス・同じ向き・同じ車線にいる車を集めておく（前の車に追いついたら待つ）。
    // t = マスの中の位置、r = そこから車の後ろの端までの長さ、L = そのマスの長さ。
    // トレーラーは荷台が後ろのマスまでのびているので、荷台がかかるマスにも後ろの端を入れておく（後ろの車が荷台にめりこまないように）
    const lanes = new Map<number, { c: Car; t: number; r: number; L: number }[]>();
    const laneAt = (c: Car, from: number) => ((ROADS[g.nodeType(from)] || ROADS[1]).oneWay ? c.lane : 0);
    const laneOf = (c: Car) => laneAt(c, c.from);
    const addLane = (key: number, e: { c: Car; t: number; r: number; L: number }) => {
      const a = lanes.get(key);
      if (a) a.push(e);
      else lanes.set(key, [e]);
    };
    for (const f of this.fleets) {
      if (f.track !== 'road' && f.track !== 'bus') continue;
      for (const c of f.cars) {
        const len = CarLayer.cellLen(c);
        // トレーラーの荷台の後ろの端：カーブでは荷台が遅れてついてくるので、後ろの車軸の位置から求める
        const rear = f.trailer ? Math.max(TRAILER_REAR, c.rs !== undefined ? c.rs + f.lamp[0] - f.axle : 0) : f.halfLen;
        addLane((c.from * 8 + c.d) * 2 + laneOf(c), { c, t: c.t, r: rear, L: len });
        if (f.trailer) {
          let rem = rear - c.t * len;
          for (const h of c.hist) {
            if (rem <= 0) break;
            const pl = CarLayer.cellLen(h);
            addLane((h.from * 8 + h.d) * 2 + laneAt(c, h.from), { c, t: Math.max(0, 1 - rem / pl), r: 0, L: pl });
            rem -= pl;
          }
        }
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
        const road = !line && !walk;
        // 道路の車は、マスの後半で次の行き先を先に決めておく（曲がり角の手前から減速できるように）
        if (road && c.t >= 0.5 && c.nx === undefined) c.nx = this.pickNext(f, c.to, c.d);
        const tf = line || walk ? 0 : g.nodeType(c.from), tt = line || walk ? 0 : g.nodeType(c.to);
        const fast = (q: number) => isHighway(q) || q === RoadType.Ramp;
        const hwCurve = (a: number, b: number) => fast(a) && fast(b) && (isHighway(a) || isHighway(b));
        // 高架鉄道はカーブでも減速しない
        const turning = c.din !== c.d && !hwCurve(tf, tt) && f.track !== 'erail';
        // 次のマスで曲がる（マスの後半から減速を始める）
        const nextTurn = road && !!c.nx && c.nx[1] !== c.d && !hwCurve(tt, g.nodeType(c.nx[0]));
        const merging = tf === RoadType.Ramp && isHighway(tt);
        const len = CarLayer.cellLen(c);
        const cg = line || walk ? 1 : Math.max(this.cong![c.from], 1);
        const kmh = walk ? 4.5 + (c.col % 3) * 0.6 : line ? LINES[f.track as LineKind].speedKmh * 1.2 : (merging ? ROADS[tt].speedKmh : def.speedKmh) * (f.track === 'bus' ? 0.8 : f.trailer ? 0.85 : 1);
        // カーブの速さの割合は車の種類ごと。マスの境目で急に変わらないよう、なめらかに近づける（一時停止中は変わらない）
        const turnK = walk ? 0.6 : line || f.halfLen <= 3 ? TURN_CAR : f.trailer ? TURN_TRAILER : TURN_BIG;
        const vNom = ((kmh / 3.6) * 0.9) / cg;
        let sk = turning || nextTurn ? turnK : 1;
        if (road && (turning || nextTurn)) {
          // 道路の曲がり角は、横にかかる加速度が A_LAT までの速さにする（きつく曲がるほど遅く。曲がり具合からおよその半径を決める）
          const rad = (tr: number) => (tr === 1 || tr === 7 ? 22 : tr === 2 || tr === 6 ? 5.7 : 3);
          const r = Math.min(turning ? rad((c.d - c.din) & 7) : 99, nextTurn ? rad((c.nx![1] - c.d) & 7) : 99);
          sk = Math.min(sk, Math.sqrt(A_LAT * r) / vNom);
        }
        if (walk || c.sk === undefined) c.sk = sk;
        else c.sk += (sk - c.sk) * (1 - Math.exp(-dt * 3));
        const speed = vNom * c.sk;
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
              // ホームでは速度を落とし、ホームの端のマスで、先頭がホームの端の 3m 手前に来るところで止まる
              adv *= 0.45;
              const stopT = Math.max(0.5, 1 - (3 + f.halfLen * (1 - BOGIE)) / len);
              if (!st!.has(c.to) && c.lastStop !== c.from && c.lastStop !== LEFT_TERMINAL && c.t < stopT && c.t + adv >= stopT) {
                c.t = stopT;
                adv = 0;
                c.stop = 5;
                c.lastStop = c.served = c.from;
              }
            }
            // 前の列車との間隔：先の 2 マスに別の列車がいたら、マスの手前で待つ（長く詰まったら進む）
            const n = this.grid!.n;
            const ahead2 = (() => { const x = (c.to % n) + DX[c.d], y = ((c.to / n) | 0) + DY[c.d]; return this.grid!.inb(x, y) ? y * n + x : -1; })();
            const block = [c.to, ahead2].some((cell) => {
              if (cell < 0) return false;
              const o = occ!.get(CarLayer.occKey(cell, c.d));
              // 分岐器のない行き止まりから出ていく列車とは、同じ線路で向かい合う
              return (o && o !== c && !this.otherPlatform(f, o, c)) || f.cars.some((q) => q !== c && q.leave && !q.leave.tb && CarLayer.intoLeave(q, c, cell));
            });
            if (block && (c.wait ?? 0) < 25) {
              if (c.t + adv > 0.8) {
                adv = Math.max(0, 0.8 - c.t);
                c.wait = (c.wait ?? 0) + dt;
              }
            } else c.wait = 0;
            // 終点に着く列車は、入るホームがふさがっているとき・出ていく列車とぶつかるときは、分岐器の手前で待つ
            const tb = !c.revPending ? this.endAhead(f, c) : null;
            if (tb && c.tbFor === tb) {
              const hd = this.headDist(c, tb);
              if (hd > tb.d0) {
                // 分岐器に入るまでは、空いたホームを選び直す
                const fs = this.freeSide(f, c, tb);
                if (fs !== null) c.tbSide = fs;
                const want = hd - adv * len < tb.d0 + 4 && this.throatHold(f, c, tb);
                if (want && (c.hw ?? 0) < 60) {
                  adv = Math.max(0, (hd - tb.d0 - 4) / len);
                  c.hw = (c.hw ?? 0) + dt;
                } else if (!want) c.hw = 0;
              }
            }
            // 終点で向きを変えたあとは、止まった位置からゆっくり加速する（線路の速さに届いたら終わり）
            if (c.acc !== undefined && dt > 0) {
              const v = Math.min((adv * len) / dt, c.acc + TRAIN_ACC * dt);
              adv = (v * dt) / len;
              c.acc = v >= speed ? undefined : v;
            }
          }
          // 向きを変えたあと反対側の線路へ移るところ：先頭が進んだ道のり。最後尾まで移り終えたら終わり
          if (c.dep) {
            c.dep.s += adv * len;
            if (c.dep.s - CarLayer.trainBogies(f) > c.dep.d0) c.dep = null;
          }
          if (c.leave && (c.leave.s += adv * len) - CarLayer.trainBack(f) > c.leave.d0 + 2) c.leave = null;
          if (c.fix && c.fix.set && (c.fix.s += adv * len) >= FIX_LEN) c.fix = null;
        }
        if (!line && !walk && adv > 0) {
          // 前の車（同じマスの先、または次のマス）との間をあける
          const lb = laneOf(c), me = f.halfLen;
          let gap = Infinity;
          for (const o of lanes.get((c.from * 8 + c.d) * 2 + lb) ?? []) if (o.c !== c && o.t > c.t) gap = Math.min(gap, (o.t - c.t) * len - o.r - me);
          if (gap === Infinity)
            for (let d = 0; d < 8; d++) {
              if (d === opp(c.d)) continue;
              for (const o of lanes.get((c.to * 8 + d) * 2 + lb) ?? []) if (o.c !== c) gap = Math.min(gap, (1 - c.t) * len + o.t * o.L - o.r - me);
            }
          const room = Math.max(0, gap - 1.5);
          if (room < adv * len) {
            // 長く詰まったら（交差点で行き詰まらないように）そのまま進む
            c.wait = (c.wait ?? 0) + dt;
            if (c.wait < 6) adv = room / len;
          } else c.wait = 0;
        }
        const moved = adv * len; // このコマで進んだ道のり（m）
        c.t += adv;
        let guard = 0;
        while (c.t >= 1 && guard++ < 3) {
          c.t -= 1;
          // ときどき入れ替えて、交通量の分布を保つ（トレーラーは途中で消えると目立つので、少なめに）
          if (!f.mid && Math.random() < (f.trailer ? 0.008 : 0.03)) {
            const nc = this.spawn(f);
            if (nc) {
              Object.assign(c, nc);
              // 別の場所へ移ったので、車線の位置・トレーラーの向き・速さは新しく決め直す
              c.sk = c.lo = c.rx = c.rz = c.rs = c.ly = c.nx = undefined;
            }
            continue;
          }
          const nx = c.nx !== undefined ? c.nx : this.pickNext(f, c.to, c.d);
          c.nx = undefined;
          if (!nx) {
            // 列車は行き止まりで止まり、しばらくして向きを変える（マップの端なら隣の都市へ出ていく）
            const g2 = this.grid!, ex = c.to % g2.n, ey = (c.to / g2.n) | 0;
            const edge = ex === 0 || ey === 0 || ex === g2.n - 1 || ey === g2.n - 1;
            if (f.mid && !edge) {
              const tbE = this.turnbacks.get(f.track)?.get(c.to);
              if (c.revPending && (c.stop ?? 0) <= 0 && tbE && (c.hw ?? 0) < 20 && this.departHold(f, c, tbE)) {
                // 着く列車がもう分岐器の中にいれば、通り過ぎるまで待つ（長く待ったら出る）
                c.hw = (c.hw ?? 0) + 0.2;
                c.stop = 0.2;
                c.t = 1;
                break;
              }
              if (c.revPending && (c.stop ?? 0) <= 0) {
                // 止まっていた位置（マスの終わり）から向きを変える
                c.t = 1;
                this.reverseTrain(f, c);
                c.revPending = false;
                continue;
              }
              if (!c.revPending) { c.revPending = true; c.stop = c.lastStop === c.from ? 1.5 : 6; }
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
        const rd = line || walk ? def : ROADS[g.nodeType(c.from)] || ROADS[1]; // マスが変わったときは新しいマスの道路
        let lane = walk ? (def.width / 2 + 0.9) * (c.lane ? 1 : -1) : line ? TRACK_GAP : rd.oneWay ? (c.lane ? 1 : -1) * rd.width * 0.2 : (rd.width / 2) * 0.48;
        if (!walk && !line) {
          // 道路の種類が変わるところ（2車線と1車線など）では、横に跳ばずに少しずつ移る（1 m 進むあいだに 0.3 m まで）
          if (c.lo === undefined) c.lo = lane;
          else {
            const dl = Math.max(-0.3 * moved, Math.min(0.3 * moved, (lane - c.lo) * (1 - Math.exp(-moved / 3))));
            c.lo += dl;
            // 横へ移るあいだは、車体を移る向きへ少し向ける（向きはそのままで横へすべって見えないように）。なめらかに変える
            if (moved > 1e-4) c.ly = (c.ly ?? 0) + (-Math.atan2(dl, moved) - (c.ly ?? 0)) * (1 - Math.exp(-moved / 0.6));
          }
          lane = c.lo;
        }
        const x = P.x - P.tz * lane, z = P.z + P.tx * lane, h = P.h;
        let tx = P.tx, tz = P.tz;
        if (!line && !walk && c.ly) {
          const cs = Math.cos(c.ly), sn = Math.sin(c.ly);
          [tx, tz] = [tx * cs + tz * sn, tz * cs - tx * sn];
        }
        if (f.mid) {
          // 列車：車両ごとに、前と後ろの台車の位置から向きを決めて並べる（c は先頭の車両の前の台車）
          const nCar = f.carsPer, sp = f.spacing, half = f.halfLen * BOGIE;
          // 折り返しの手前の X 字の分岐器では、反対側の線路へ渡る
          const tb = this.endAhead(f, c);
          const isl = f.track === 'erail' && this.islands.length ? this.islands : null;
          // 止まった点からの道のり dist が d0 から d1 へ進むあいだに、反対側の線路へ移る（-1 倍になる）
          const cross = (dist: number, d0: number, d1: number) => {
            const u = Math.max(0, Math.min(1, (d0 - dist) / (d0 - d1)));
            return 1 - 2 * u * u * (3 - 2 * u);
          };
          const lanes = c.lanes?.length === 2 * nCar ? c.lanes : (c.lanes = new Float32Array(2 * nCar));
          const fix = c.fix, fu = fix ? Math.min(1, fix.s / FIX_LEN) : 1, fw = 1 - fu * fu * (3 - 2 * fu);
          // 先頭から back だけ後ろ（いまの P）にある i 番目の台車の、線路の中心からの横の位置
          const laneAt = (back: number, i: number) => {
            // 島式の駅の前後では、線路が左右に広がる
            const base = isl ? lane + (ISLAND_GAP - lane) * islandSpread(isl, P.x, P.z) : lane;
            let sg = 1;
            // 渡らずに入るときは分岐器を通らない
            if (tb && c.tbSide !== 1) sg *= cross((tb.ex - P.x) * tb.ux + (tb.ez - P.z) * tb.uz, tb.d0, tb.d1);
            // 渡らずに入った終点・分岐器のない行き止まりから出るときは、止まっていた線路から出ていく途中で移る
            if (c.dep) sg *= cross(c.dep.s - back, c.dep.d0, c.dep.d1);
            let l = base * sg;
            // 向きを変えた直後は、向きを変える前の横の位置から始める
            if (fix) {
              if (!fix.set) fix.k[i] -= l;
              l += fix.k[i] * fw;
            }
            return (lanes[i] = l);
          };
          for (let j = 0; j < nCar; j++) {
            this.placeBack(f, c, j * sp);
            const l0 = laneAt(j * sp, 2 * j);
            const fx = P.x - P.tz * l0, fz = P.z + P.tx * l0, fh = P.h;
            this.placeBack(f, c, j * sp + 2 * half);
            const l1 = laneAt(j * sp + 2 * half, 2 * j + 1);
            const rx = P.x - P.tz * l1, rz = P.z + P.tx * l1, rh = P.h;
            let ang = Math.atan2(fx - rx, fz - rz);
            const tail = j === nCar - 1;
            // 最後尾の車両は後ろ向き。中間の車両は、向きを変えても同じ向きのまま（パンタグラフの位置が変わらないように）
            if (tail || (j > 0 && c.flip)) ang += Math.PI;
            this.v.set((fx + rx) / 2, (fh + rh) / 2, (fz + rz) / 2);
            if (!this.seen(this.v.x, this.v.y, this.v.z, f.halfLen + 4)) continue;
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
          if (fix) fix.set = true;
          k++;
          if (k >= f.max) break;
          continue;
        }
        // トレーラー：連結部はトラクターの第五輪（中心から KINGPIN 後ろ）。後ろの車軸は連結部に引かれて、車軸の向きにだけ転がる（横にすべらない）。
        // カーブでは後ろの車軸が内側を通る。ただし狭い曲がり角では内側へ入りすぎるので、道の上の点
        // （道に沿って後ろにある、連結部から車軸の長さだけ離れた点）の向きへ、離れた量と進んだ道のりに応じて少しずつ回す。
        // 向き（角度）で動かすので、連結部から車軸までの長さはいつも同じ。画面の外でも動きを続ける
        let rh = h;
        if (f.trailer) {
          const ax = f.axle, kx = x - tx * KINGPIN, kz = z - tz * KINGPIN;
          let sb = KINGPIN + ax, sp = sb, px = 0, pz = 0;
          for (let it = 0; it < 3; it++) {
            this.placeBack(f, c, sb);
            sp = sb;
            px = P.x - P.tz * lane;
            pz = P.z + P.tx * lane;
            // カーブでは道のりより直線の距離が短いので、その分だけ後ろを探す（きつい折り返しで遠くへ行かないよう範囲を決める）
            sb = Math.max(ax * 0.5, Math.min(KINGPIN + ax * 1.5, sb + ax - Math.hypot(px - kx, pz - kz)));
          }
          const ptx = P.tx, ptz = P.tz;
          const toPath = Math.atan2(kx - px, kz - pz);
          // 前のコマの後ろの車軸から、今の連結部への向き。初めて置くとき・別の場所へ移ったとき
          // （連結部からの長さが大きく変わったとき）・数がおかしくなったときは、道の上の点から
          const d0 = c.rx === undefined ? NaN : Math.hypot(kx - c.rx, kz - c.rz!);
          let a0 = d0 > ax * 0.5 && d0 < ax * 1.5 ? Math.atan2(kx - c.rx!, kz - c.rz!) : toPath;
          let da = toPath - a0;
          da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
          // 道の上の点から 60° 以上（車軸の長さ以上）ずれたときも、道の上へ戻す（道路が作り直されたときなど）
          if (!(Math.abs(da) < Math.PI / 3)) {
            a0 = toPath;
            da = 0;
          }
          // 戻す割合：進んだ道のり × √(離れた量) ÷ (道路の幅 × 0.7)。大きく進んだコマでも行き過ぎない形にする
          const u = (moved * Math.sqrt(2 * ax * Math.abs(Math.sin(da / 2)))) / (0.7 * rd.width);
          let a = a0 + (da * u) / (1 + u);
          // 高速道路・ランプでは道の端からはみ出さない（両側に壁がある）：後ろの車軸の、道の上の点からの横のずれを、
          // そこの道の幅の余裕（タイヤの外側まで）にとどめる。一般の道路は、引き戻す力だけで足りる。
          // ずれは向きの差にほぼ比例するので、向きの差を縮める（道の幅が変わるところで跳ばないよう、進んだ道のりに応じて少しずつ）
          const pty = g.nodeType(this.ptNode), pc = this.ptCell!;
          if (isHighway(pty) || pty === RoadType.Ramp) {
            // 本線とランプが分かれる・合わさるマスでは、曲がって通る車はランプの幅の上を走る
            let w = (ROADS[pty] || rd).width;
            if (pc.din !== pc.d) {
              const NN = g.n * g.n, pcc = pc.from % NN, bx = (pcc % g.n) - DX[pc.din], bz = ((pcc / g.n) | 0) - DY[pc.din];
              const back = g.inb(bx, bz) ? g.idx(bx, bz) : -1;
              if (g.nodeType(pc.to) === RoadType.Ramp || (back >= 0 && (g.road[back] === RoadType.Ramp || g.up[back] === RoadType.Ramp))) w = Math.min(w, ROADS[RoadType.Ramp].width);
            }
            const m = Math.max(0, w / 2 - Math.abs(lane) - 1.45);
            const off = Math.abs((kx - Math.sin(a) * ax - px) * -ptz + (kz - Math.cos(a) * ax - pz) * ptx);
            if (off > m) {
              const to = Math.max(m, off - 1.2 * moved);
              let dd = a - toPath;
              dd -= Math.round(dd / (2 * Math.PI)) * 2 * Math.PI;
              a = toPath + (dd * to) / off;
            }
          }
          // 折れ曲がりは 80° まで（きつい折り返しでも、トラクターに重なるほど折れない）
          let bend = a - Math.atan2(tx, tz);
          bend -= Math.round(bend / (2 * Math.PI)) * 2 * Math.PI;
          if (Math.abs(bend) > JACKKNIFE) a += Math.sign(bend) * JACKKNIFE - bend;
          c.rx = kx - Math.sin(a) * ax;
          c.rz = kz - Math.cos(a) * ax;
          // 後ろの車軸の高さ（坂・橋・ランプ）と道のりは、車軸にいちばん近い道の上の点から（カーブでは車軸が内側を通るので、sb の点とずれる）
          let sr = sp, qx = px, qz = pz, qtx = ptx, qtz = ptz;
          for (let it = 0; it < 2; it++) {
            sr = Math.max(ax * 0.5, Math.min(KINGPIN + ax * 1.5, sr - ((c.rx - qx) * qtx + (c.rz - qz) * qtz)));
            this.placeBack(f, c, sr);
            qx = P.x - P.tz * lane;
            qz = P.z + P.tx * lane;
            qtx = P.tx;
            qtz = P.tz;
          }
          rh = P.h;
          c.rs = sr;
        }
        // 画面の外の車・人は描かない（トレーラーは後ろへ長いので広めに見る）
        if (!this.seen(x, h, z, f.halfLen + (f.trailer ? 18 : 4))) {
          if (k >= f.max) break;
          continue;
        }
        this.v.set(x, h, z);
        this.q.setFromAxisAngle(this.up, Math.atan2(tx, tz));
        if (walk) {
          // 人は背の高さを少しずつ変える（この大きさから歩く周期と服の色も決まる）
          const ks = 0.9 + 0.2 * (c.vs ??= Math.random());
          this.bs.set(ks, ks, ks);
          this.mtx.compose(this.v, this.q, this.bs);
        } else this.mtx.compose(this.v, this.q, this.s);
        f.mesh.setColorAt(k, f.colors[c.col]);
        f.mesh.setMatrixAt(k, this.mtx);
        if (!walk) this.addBlob(x, h, z, tx, tz, f.foot);
        // トレーラー：連結部から後ろの車軸へ向けて置く。坂では後ろの車軸の高さに合わせて傾ける
        if (f.trailer) {
          const ax = f.axle, kx = x - tx * KINGPIN, kz = z - tz * KINGPIN;
          const bx = (kx - c.rx!) / ax, bz = (kz - c.rz!) / ax; // トレーラーの向き（長さ 1）
          const yaw = Math.atan2(bx, bz);
          this.v.set(kx, h, kz);
          this.eu.set(Math.asin(Math.max(-0.4, Math.min(0.4, (rh - h) / ax))), yaw, 0);
          this.q.setFromEuler(this.eu);
          this.mtx.compose(this.v, this.q, this.s);
          f.trailer.setMatrixAt(k, this.mtx);
          f.trailer.setColorAt(k, f.trailerColors[c.col2 % f.trailerColors.length]);
          this.q.setFromAxisAngle(this.up, yaw);
          this.addBlob(kx, h - ((rh - h) * f.tfoot[2]) / ax, kz, bx, bz, f.tfoot);
          if (lit && nt < MAX_LIGHTS - 2) {
            const tb = f.lamp[0], th = h + ((rh - h) * tb) / ax + f.lamp[1];
            tp.setXYZ(nt++, kx - bx * tb + bz * 0.9, th, kz - bz * tb - bx * 0.9);
            tp.setXYZ(nt++, kx - bx * tb - bz * 0.9, th, kz - bz * tb + bx * 0.9);
          }
        }
        k++;
        // 夜は前照灯で道路の先を照らす
        if (lit && !walk && !line && this.nbm < MAX_BLOBS) {
          const fw = f.halfLen - 0.1, wd = f.track === 'bus' || f.trailer || f.halfLen > 3.2 ? 5.0 : 4.2;
          this.v.set(x + tx * fw, h + 0.05, z + tz * fw);
          this.q.setFromAxisAngle(this.up, Math.atan2(tx, tz));
          this.bs.set(wd, 1, 11);
          this.mtx.compose(this.v, this.q, this.bs);
          this.beams.setMatrixAt(this.nbm++, this.mtx);
        }
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
        flush(f.mid.instanceMatrix, mk, 16);
        flush(f.mid.instanceColor, mk, 3);
      }
      flush(f.mesh.instanceMatrix, f.mesh.count, 16);
      flush(f.mesh.instanceColor, f.mesh.count, 3);
      if (f.trailer) {
        f.trailer.count = k;
        flush(f.trailer.instanceMatrix, k, 16);
        flush(f.trailer.instanceColor, k, 3);
      }
    }
    this.blob.count = this.nb;
    flush(this.blob.instanceMatrix, this.nb, 16);
    this.beams.count = this.nbm;
    this.beams.visible = lit;
    flush(this.beams.instanceMatrix, this.nbm, 16);
    this.lightsHead.geometry.setDrawRange(0, nh);
    this.lightsTail.geometry.setDrawRange(0, nt);
    hp.needsUpdate = tp.needsUpdate = nh + nt > 0;
    this.lightsHead.visible = this.lightsTail.visible = lit;
  }
}
