// 動く船と飛行機（フェリーは乗り場の間を行き来し、飛行機は空港から離陸する）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import { CIVIC, CivicId } from '../sim/defs';
import type { Building } from '../sim/world';
import { labelWater } from '../sim/plan';
import { MeshBuilder } from './builder';
import { createBuildingMaterial } from './materials';
import { planShipRoute, shipCycle, shipPose, ShipPose, ShipRoute, ShipSpec, SHIP_T } from './shipRoute';
import { airportLayout, bigContainerShip, bigNuclearScale, boat, containerShip, tugBoat, COOLING_TOWERS, INCIN_RAMP, plane, TERMINAL, terminalCranes } from './buildingGen';
import { boxTruck, garbageTruck, tractor, vc } from './vehicles';
import type { FxSpot } from './buildingGen';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

interface Route {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  speed: number;
  t: number;
  mesh: number; // 0 = 旅客船, 1 = カーフェリー
}
// 貨物船：外洋（マップの外）と港の岸壁の間を行き来する
interface Ship {
  route: ShipRoute; // 外洋 → 横に押しはじめる沖の点
  spec: ShipSpec;
  berth: [number, number]; // 接岸位置
  cycle: number; // ひとまわりの時間（秒）
  big?: boolean; // 大型コンテナターミナルの大きな船
  variant?: number; // 船体の色の種類
  sea: [number, number]; // 岸壁から沖への向き（単位ベクトル）
  t: number; // 周期の中の時刻（秒）
}
const SHIP_LEN = 110;
const BIG_LEN = 200, BIG_BEAM = 30;
const SMALL_SPEC: ShipSpec = { len: SHIP_LEN, beam: SHIP_LEN * 0.15, speed: 9 };
const BIG_SPEC: ShipSpec = { len: BIG_LEN, beam: BIG_BEAM, speed: 9 };
// 入港で止まるまでの残り時間（秒）
function arrivalLeft(s: Ship, P: ShipPose) {
  if (P.phase !== 'in') return Infinity;
  const L = s.route.acc[s.route.acc.length - 1], dec = Math.min(450, L * 0.6);
  return (1 - P.u) * ((L - dec) / s.spec.speed + (2 * dec) / s.spec.speed);
}
interface Runway {
  x: number;
  z: number;
  ux: number;
  uz: number;
  len: number;
  t: number;
  scale: number;
}

function geo(build: (mb: MeshBuilder) => void) {
  const mb = new MeshBuilder();
  mb.setTransform(0, 0, 0, 0);
  build(mb);
  return mb.toGeometry();
}

// 敷地のローカル座標（正面が +z）を世界座標にする
function lotToWorld(b: Building, lx: number, lz: number): [number, number] {
  const a = b.face === 0 ? -Math.PI / 2 : b.face === 4 ? Math.PI / 2 : b.face === 6 ? Math.PI : 0;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx = (b.x + b.w / 2) * CELL, cz = (b.y + b.h / 2) * CELL;
  return [lx * cos - lz * sin + cx, lx * sin + lz * cos + cz];
}
function lotDepth(b: Building) {
  const side = b.face === 0 || b.face === 4;
  return [(side ? b.h : b.w) * CELL, (side ? b.w : b.h) * CELL];
}

export class PropsLayer {
  group = new THREE.Group();
  private boats: THREE.InstancedMesh[];
  private planes: THREE.InstancedMesh;
  private routes: Route[] = [];
  private ships: Ship[] = [];
  private shipMesh: THREE.InstancedMesh;
  private bigShipMeshes!: THREE.InstancedMesh[];
  private tugs!: THREE.InstancedMesh;
  private ropes!: THREE.InstancedMesh;
  private wakes!: THREE.InstancedMesh;
  private trolleys!: THREE.InstancedMesh;
  private cables!: THREE.InstancedMesh;
  private boxes!: THREE.InstancedMesh;
  private yardTrucks!: THREE.InstancedMesh;
  private terminals: { b: Building; W: number; D: number; base: number; xs: number[]; t: number }[] = [];
  // 冷却塔の湯気（ふわっと膨らみながら上がって消える白いかたまり）
  private steam: THREE.InstancedMesh;
  private towers: { x: number; y: number; z: number; k: number }[] = [];
  private steamT = 0;
  // 大型焼却場のスロープを上り下りする収集車
  private ramps: { ax: number; az: number; ay: number; bx: number; bz: number; by: number; t: number }[] = [];
  private rampTrucks: THREE.InstancedMesh;
  private runways: Runway[] = [];
  // 工場の煙（煙突から上がって広がり、消える灰色のかたまり）、フレアの炎、敷地の中を行き来するトラック
  private smoke: THREE.InstancedMesh;
  private flames: THREE.InstancedMesh;
  private fxTrucks: THREE.InstancedMesh;
  private fx: FxSpot[] = [];
  private fxT = 0;
  private mtx = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.boats = [
      new THREE.InstancedMesh(geo((mb) => boat(mb, 0, 0, 14, 5, false, 0)), mat, 40),
      new THREE.InstancedMesh(geo((mb) => boat(mb, 0, 0, 26, 9, true, 0)), mat, 40),
    ];
    this.planes = new THREE.InstancedMesh(geo((mb) => plane(mb, 0, 0, 1)), mat, 20);
    this.shipMesh = new THREE.InstancedMesh(geo((mb) => containerShip(mb, SHIP_LEN, 7)), mat, 40);
    // 大きなコンテナ船：船体の色ちがいを 4 種類
    // 窓・夜の灯りが出るように、建物と同じマテリアル
    const bmat = createBuildingMaterial();
    this.bigShipMeshes = [0x1d2f4f, 0x1f4a35, 0x23466e, 0x6b1f22].map((c, i) => new THREE.InstancedMesh(geo((mb) => bigContainerShip(mb, BIG_LEN, BIG_BEAM, new THREE.Color(c), 31 + i * 7)), bmat, 8));
    this.tugs = new THREE.InstancedMesh(geo((mb) => tugBoat(mb)), bmat, 40);
    this.ropes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 0.18, 1).translate(0, 0, 0.5), new THREE.MeshLambertMaterial({ color: 0xd9d2b8 }), 80);
    // 航跡：船尾から後ろへ広がる白い三角（だんだん薄く）
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -1, 0, -1, 1, 0, -1, -0.15, 0, 0, 0.15, 0, 0, 0, 0, -1], 3));
    wg.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 0.55, 0.62, 0.66, 0.55, 0.62, 0.66, 1, 1, 1, 1, 1, 1, 0.55, 0.62, 0.66], 3));
    wg.setIndex([0, 2, 1]);
    this.wakes = new THREE.InstancedMesh(wg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }), 20);
    // ガントリークレーンのトロリー、吊り具とワイヤー、運ぶコンテナ、コンテナ車
    this.trolleys = new THREE.InstancedMesh(new THREE.BoxGeometry(5, 2.6, 6), new THREE.MeshLambertMaterial({ color: 0xf2f3f4 }), 60);
    this.cables = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1, 0.12).translate(0, -0.5, 0), new THREE.MeshLambertMaterial({ color: 0x30343a }), 120);
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(12.2, 2.6, 2.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), 120);
    const chassis = vc(new THREE.BoxGeometry(2.4, 0.4, 12.6).translate(0, 1.15, -7.6), 0x2a2d31);
    this.yardTrucks = new THREE.InstancedMesh(mergeGeometries([tractor(), chassis])!, mat, 60);
    for (const m of [...this.bigShipMeshes, this.tugs, this.ropes, this.wakes, this.trolleys, this.cables, this.boxes, this.yardTrucks]) {
      m.count = 0;
      m.castShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.steam = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshLambertMaterial({ color: 0xf4f4f2, transparent: true, opacity: 0.55, depthWrite: false }), 240);
    this.rampTrucks = new THREE.InstancedMesh(garbageTruck(), new THREE.MeshLambertMaterial({ vertexColors: true }), 40);
    this.rampTrucks.count = 0;
    this.rampTrucks.castShadow = true;
    this.rampTrucks.frustumCulled = false;
    this.rampTrucks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.rampTrucks);
    this.smoke = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshLambertMaterial({ color: 0xd9d9d6, transparent: true, opacity: 0.5, depthWrite: false }), 600);
    this.flames = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 3, 10).translate(0, 1.5, 0), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }), 80);
    this.fxTrucks = new THREE.InstancedMesh(boxTruck(), new THREE.MeshLambertMaterial({ vertexColors: true }), 160);
    for (const m of [this.smoke, this.flames, this.fxTrucks]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.smoke.setColorAt(0, new THREE.Color());
    this.fxTrucks.castShadow = true;
    this.steam.count = 0;
    this.steam.frustumCulled = false;
    this.steam.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.steam);
    for (const m of [...this.boats, this.planes, this.shipMesh]) {
      m.count = 0;
      m.castShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
  }

  setBuildings(g: Grid, list: Building[]) {
    const water = labelWater(g);
    this.towers = [];
    const oldT = this.terminals;
    this.terminals = [];
    for (const b of list) {
      if (b.type !== 'seaport_l') continue;
      const [W, D] = lotDepth(b);
      let base = -Infinity;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) base = Math.max(base, g.cellMaxH(x, y));
      const prev = oldT.find((o) => o.b.id === b.id);
      this.terminals.push({ b, W, D, base, xs: terminalCranes(W), t: prev?.t ?? Math.random() * 36 });
    }
    const oldRamps = this.ramps;
    this.ramps = [];
    for (const b of list) {
      if (b.type !== 'incinerator_l') continue;
      const [W, D] = lotDepth(b);
      let base = -Infinity;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) base = Math.max(base, g.cellMaxH(x, y));
      const [ax, az] = lotToWorld(b, INCIN_RAMP.x * W, INCIN_RAMP.z0 * D + 6);
      const [bx, bz] = lotToWorld(b, INCIN_RAMP.x * W, INCIN_RAMP.z1 * D - 4);
      const prev = oldRamps.find((r) => r.ax === ax && r.az === az);
      this.ramps.push({ ax, az, ay: base + 0.2, bx, bz, by: base + INCIN_RAMP.h + 0.4, t: prev?.t ?? Math.random() * 24 });
    }
    for (const b of list) {
      if (b.type !== 'nuclear_in') continue;
      const [W, D] = lotDepth(b);
      const k = bigNuclearScale(W, D);
      let base = -Infinity;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) base = Math.max(base, g.cellMaxH(x, y));
      for (const [lx, lz] of COOLING_TOWERS.pos) {
        const [x, z] = lotToWorld(b, lx * k, lz * k);
        this.towers.push({ x, y: base + COOLING_TOWERS.H * k, z, k });
      }
    }
    const oldShips = this.ships;
    this.ships = [];
    const terms: { b: Building; kind: string; body: number; px: number; pz: number }[] = [];
    this.runways = [];
    for (const b of list) {
      if (!b.civic) continue;
      const def = CIVIC[b.type as CivicId];
      if (def.ferry) {
        let body = -1;
        for (let yy = b.y - 1; yy <= b.y + b.h && body < 0; yy++)
          for (let xx = b.x - 1; xx <= b.x + b.w; xx++) if (g.inb(xx, yy) && water.label[g.idx(xx, yy)] >= 0) { body = water.label[g.idx(xx, yy)]; break; }
        const [, D] = lotDepth(b);
        const [px, pz] = lotToWorld(b, 0, -D / 2 - 18);
        terms.push({ b, kind: def.ferry, body, px, pz });
      }
      if (def.seaport) this.addShips(g, water, b, oldShips);
      if (def.airport) {
        const [W, D] = lotDepth(b);
        const Y = airportLayout(W, D, def.airport);
        const [l0x, l0z] = Y.P(Y.ra0 + 10, Y.rc), [l1x, l1z] = Y.P(Y.ra1 - 10, Y.rc);
        const [x0, z0] = lotToWorld(b, l0x, l0z), [x1, z1] = lotToWorld(b, l1x, l1z);
        const len = Math.hypot(x1 - x0, z1 - z0);
        this.runways.push({ x: x0, z: z0, ux: (x1 - x0) / len, uz: (z1 - z0) / len, len, t: Math.random(), scale: def.airport === 2 ? 1.5 : 1.0 });
      }
    }
    const old = this.routes;
    this.routes = [];
    for (let i = 0; i < terms.length; i++)
      for (let j = i + 1; j < terms.length; j++) {
        const A = terms[i], B = terms[j];
        if (A.kind !== B.kind || A.body < 0 || A.body !== B.body) continue;
        const prev = old.find((r) => r.ax === A.px && r.az === A.pz && r.bx === B.px && r.bz === B.pz);
        this.routes.push({ ax: A.px, az: A.pz, bx: B.px, bz: B.pz, speed: A.kind === 'car' ? 6 : 8, t: prev?.t ?? Math.random(), mesh: A.kind === 'car' ? 1 : 0 });
      }
  }

  // 港から外洋までの航路を探す（幅3マス以上の水面だけを通る）
  private addShips(g: Grid, water: { label: Int32Array; edge: Set<number> }, b: Building, old: Ship[]) {
    const n = g.n;
    let body = -1;
    for (let yy = b.y - 1; yy <= b.y + b.h && body < 0; yy++)
      for (let xx = b.x - 1; xx <= b.x + b.w; xx++)
        if (g.inb(xx, yy) && water.label[g.idx(xx, yy)] >= 0) { body = water.label[g.idx(xx, yy)]; break; }
    if (body < 0 || !water.edge.has(body)) return;
    const wet = (x: number, y: number) => !g.inb(x, y) || water.label[y * n + x] === body;
    const [, D] = lotDepth(b);
    const big = b.type === 'seaport_l';
    const spec = big ? BIG_SPEC : SMALL_SPEC;
    // 接岸位置（岸壁の前）と、横に押しはじめる沖の点
    const [bx, bz] = lotToWorld(b, 0, -D / 2 - (big ? 22 : 13));
    const S = lotToWorld(b, 0, -D / 2 - (big ? 92 : 55));
    const [f0x, f0z] = lotToWorld(b, 0, 0), [f1x, f1z] = lotToWorld(b, 1, 0), [s1x, s1z] = lotToWorld(b, 0, -1);
    const route = planShipRoute(n, wet, S, [f1x - f0x, f1z - f0z], spec, CELL);
    if (!route) return;
    const L = route.acc[route.acc.length - 1];
    const count = big ? 1 : L > 900 ? 2 : 1;
    const cycle = shipCycle(route, spec);
    for (let k = 0; k < count; k++) {
      const prevShip = old.find((s) => s.berth[0] === bx && s.berth[1] === bz && old.indexOf(s) % 2 === k % 2);
      this.ships.push({ route, spec, berth: [bx, bz], cycle, t: prevShip?.t ?? (k * cycle) / 2 + Math.random() * 20, big, variant: prevShip?.variant ?? Math.floor(Math.random() * 4), sea: [s1x - f0x, s1z - f0z] });
    }
  }

  // 船を 1 隻置く。タグボート・係留ロープ・航跡もここで
  private updateShip(s: Ship, dt: number, cnt: { small: number; big: number[]; tug: number; rope: number; wake: number }) {
    s.t = (s.t + dt) % s.cycle;
    const P = shipPose(s.route, s.spec, s.berth, s.t);
    if (P.phase === 'away') return;
    const { x, z, hd } = P, len = s.spec.len, beam = s.spec.beam, sea = s.sea;
    this.q.setFromAxisAngle(this.up, hd);
    this.mtx.compose(new THREE.Vector3(x, 0, z), this.q, new THREE.Vector3(1, 1, 1));
    if (s.big) {
      const vi = s.variant ?? 0;
      if (cnt.big[vi] < 8) this.bigShipMeshes[vi].setMatrixAt(cnt.big[vi]++, this.mtx);
    } else if (cnt.small < 40) this.shipMesh.setMatrixAt(cnt.small++, this.mtx);
    const fx = Math.sin(hd), fz = Math.cos(hd);
    // タグボート：[船の前後の位置（船の長さに対する割合）, 船の横の向き x, z, すき間]
    const tugs: [number, number, number, number][] = [];
    const a = arrivalLeft(s, P);
    if (P.phase === 'in' && a < 40) for (const k of [0.28, -0.28]) tugs.push([k, sea[0], sea[1], 4 + a * 1.5]);
    else if (P.phase === 'slideIn' || P.phase === 'slideOut') for (const k of [0.28, -0.28]) tugs.push([k, sea[0], sea[1], 0.5]);
    else if (P.phase === 'dock') {
      const t = P.u * SHIP_T.dock;
      const gap = t < 20 ? 0.5 + t * 2 : t > SHIP_T.dock - 20 ? 0.5 + (SHIP_T.dock - t) * 2 : -1;
      if (gap >= 0) for (const k of [0.28, -0.28]) tugs.push([k, sea[0], sea[1], gap]);
    } else if (P.phase === 'astern') {
      for (const k of [0.3, -0.3]) tugs.push([k, fz, -fx, 1]);
    } else if (P.phase === 'rotate' || P.phase === 'align') {
      // 船首と船尾を反対側から押して、その場で回す
      tugs.push([0.34, fz, -fx, 0.5], [-0.34, -fz, fx, 0.5]);
    } else if (P.phase === 'out' && P.u * (s.route.pivot + len * 2) < 120) {
      const g = P.u * (s.route.pivot + len * 2);
      tugs.push([0.34, fz, -fx, 0.5 + g * 0.5], [-0.34, -fz, fx, 0.5 + g * 0.5]);
    }
    for (const [k, sx, sz, gap] of tugs) {
      const off = beam / 2 + 8.5 + gap;
      const tx = x + fx * k * len + sx * off, tz = z + fz * k * len + sz * off;
      this.q.setFromAxisAngle(this.up, Math.atan2(-sx, -sz) + Math.sin(this.steamT * 0.7 + k * 10) * 0.04);
      this.mtx.compose(new THREE.Vector3(tx, 0, tz), this.q, new THREE.Vector3(1, 1, 1));
      if (cnt.tug < 40) this.tugs.setMatrixAt(cnt.tug++, this.mtx);
    }
    // 係留ロープ（船首・船尾・2 本のスプリング）
    if (P.phase === 'dock') {
      const toQuay = s.big ? 19 : 10.5, half = beam / 2, top = s.big ? 9.5 : 4;
      for (const [sa, qa] of [[0.44, 0.58], [-0.44, -0.58], [0.2, 0.02], [-0.2, -0.02]]) {
        const p = new THREE.Vector3(x + fx * sa * len - sea[0] * half, top, z + fz * sa * len - sea[1] * half);
        const q = new THREE.Vector3(x + fx * qa * len - sea[0] * toQuay, 0.8, z + fz * qa * len - sea[1] * toQuay);
        const dir = q.clone().sub(p), l = dir.length();
        this.mtx.compose(p, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()), new THREE.Vector3(1, 1, l));
        if (cnt.rope < 80) this.ropes.setMatrixAt(cnt.rope++, this.mtx);
      }
    }
    // 航跡（前に進んでいるとき、船尾から後ろへ。速いほど長い）
    if (P.speed > 0.8 && cnt.wake < 20) {
      this.q.setFromAxisAngle(this.up, hd);
      this.mtx.compose(new THREE.Vector3(x - fx * len * 0.5, 0.25, z - fz * len * 0.5), this.q, new THREE.Vector3(beam * 0.9, 1, (len * 0.85 * P.speed) / s.spec.speed));
      this.wakes.setMatrixAt(cnt.wake++, this.mtx);
    }
  }

  private updateShips(dt: number) {
    const cnt = { small: 0, big: [0, 0, 0, 0], tug: 0, rope: 0, wake: 0 };
    for (const s of this.ships) this.updateShip(s, dt, cnt);
    this.shipMesh.count = cnt.small;
    this.shipMesh.instanceMatrix.needsUpdate = true;
    this.bigShipMeshes.forEach((m, i) => { m.count = cnt.big[i]; m.instanceMatrix.needsUpdate = true; });
    this.tugs.count = cnt.tug; this.ropes.count = cnt.rope; this.wakes.count = cnt.wake;
    for (const m of [this.tugs, this.ropes, this.wakes]) m.instanceMatrix.needsUpdate = true;
  }

  setFx(list: FxSpot[]) {
    this.fx = list;
  }

  private updateFx(dt: number) {
    this.fxT += dt;
    const T = this.fxT;
    const v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    let ns = 0, nf = 0, nt = 0;
    this.q.identity();
    const P = 7, period = 11;
    for (let i = 0; i < this.fx.length; i++) {
      const f = this.fx[i];
      if (f.kind === 'smoke') {
        // 煙：煙突の口から上がりながら膨らみ、風で流れて薄れる
        for (let p = 0; p < P && ns < 600; p++) {
          const t = ((T / period + p / P + i * 0.271) % 1 + 1) % 1;
          const r = (1.4 + t * 7) * f.s * (1 - Math.max(0, (t - 0.75) / 0.25));
          if (r < 0.2) continue;
          v.set(f.x + t * 22 * f.s + Math.sin(p * 2.3 + i) * 1.2, f.y + 1 + t * 26 * f.s, f.z + t * 8 * f.s + Math.cos(p * 1.9 + i) * 1.2);
          sc.set(r, r * 0.85, r);
          this.mtx.compose(v, this.q, sc);
          this.smoke.setMatrixAt(ns, this.mtx);
          const g = f.dark ? 0.55 + t * 0.3 : 0.86 + t * 0.08;
          this.smoke.setColorAt(ns++, col.setRGB(g, g, g * 0.98));
        }
      } else if (f.kind === 'flare') {
        // 炎：ゆらゆら伸び縮みする
        if (nf >= 80) continue;
        const fl = 0.75 + 0.25 * Math.sin(T * 9 + i * 3) + 0.15 * Math.sin(T * 23 + i);
        v.set(f.x, f.y, f.z);
        sc.set(f.s * (0.9 + 0.2 * Math.sin(T * 13 + i)), f.s * fl * 1.4, f.s * (0.9 + 0.2 * Math.cos(T * 11 + i)));
        this.q.setFromAxisAngle(new THREE.Vector3(1, 0, 0.4).normalize(), Math.sin(T * 2 + i) * 0.12);
        this.mtx.compose(v, this.q, sc);
        this.flames.setMatrixAt(nf++, this.mtx);
        this.q.identity();
      } else if (nt < 160) {
        // トラック：点の列に沿って行き、止まって荷物を積み降ろしし、戻る
        const pts = f.pts, n = pts.length / 3;
        let L = 0;
        const seg: number[] = [];
        for (let k = 0; k < n - 1; k++) { const d = Math.hypot(pts[k * 3 + 3] - pts[k * 3], pts[k * 3 + 5] - pts[k * 3 + 2]); seg.push(d); L += d; }
        const sp = 7, go = L / sp, cyc = go * 2 + f.wait * 2;
        let t = ((T + i * 5.3) % cyc + cyc) % cyc, u: number, back = false;
        if (t < go) u = t / go;
        else if (t < go + f.wait) u = 1;
        else if (t < go * 2 + f.wait) { u = 1 - (t - go - f.wait) / go; back = true; }
        else u = 0;
        let d = u * L, k = 0;
        while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; }
        const a = k * 3, b = a + 3, w = seg[k] > 0 ? Math.min(1, d / seg[k]) : 0;
        v.set(pts[a] + (pts[b] - pts[a]) * w, pts[a + 1] + (pts[b + 1] - pts[a + 1]) * w, pts[a + 2] + (pts[b + 2] - pts[a + 2]) * w);
        const dx = pts[b] - pts[a], dz = pts[b + 2] - pts[a + 2], dy = pts[b + 1] - pts[a + 1];
        const pitch = Math.atan2(dy, Math.hypot(dx, dz) || 1);
        // 帰りは反対側の車線を、前向きに走る
        const yaw = Math.atan2(dx, dz) + (back ? Math.PI : 0);
        const off = back ? -1.7 : 1.7, l = Math.hypot(dx, dz) || 1;
        v.x += (dz / l) * off;
        v.z += (-dx / l) * off;
        this.q.setFromEuler(new THREE.Euler(back ? pitch : -pitch, yaw, 0, 'YXZ'));
        sc.set(1, 1, 1);
        this.mtx.compose(v, this.q, sc);
        this.fxTrucks.setMatrixAt(nt, this.mtx);
        this.fxTrucks.setColorAt(nt++, col.setHex(f.color));
        this.q.identity();
      }
    }
    this.smoke.count = ns;
    this.flames.count = nf;
    this.fxTrucks.count = nt;
    for (const m of [this.smoke, this.flames, this.fxTrucks]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  private updateSteam(dt: number) {
    this.steamT += dt;
    const P = 10, period = 16;
    let n = 0;
    const v = new THREE.Vector3(), sc = new THREE.Vector3();
    this.q.identity();
    for (let ti = 0; ti < this.towers.length && n < 240 - P; ti++) {
      const t0 = this.towers[ti];
      for (let p = 0; p < P; p++) {
        const t = ((this.steamT / period + p / P + ti * 0.37) % 1 + 1) % 1;
        const fade = 1 - Math.max(0, (t - 0.7) / 0.3);
        const r = (9 + t * 26) * t0.k * fade;
        if (r < 0.5) continue;
        // 風で少し流されながら上がる
        v.set(t0.x + t * 38 * t0.k + Math.sin(p * 2.1) * 3, t0.y + 4 + t * 75 * t0.k, t0.z + t * 14 * t0.k + Math.cos(p * 1.7) * 3);
        sc.set(r, r * 0.8, r);
        this.mtx.compose(v, this.q, sc);
        this.steam.setMatrixAt(n++, this.mtx);
      }
    }
    this.steam.count = n;
    this.steam.instanceMatrix.needsUpdate = true;
  }

  // 収集車：スロープを上がって入口に入り、しばらくして下りてくる（24 秒でひとまわり）
  private updateRampTrucks(dt: number) {
    let n = 0;
    const v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    for (const r of this.ramps) {
      r.t = (r.t + dt) % 24;
      const t = r.t;
      let u: number, down = false;
      if (t < 8) u = t / 8;
      else if (t < 14) continue; // 中でごみを降ろしている
      else if (t < 22) { u = 1 - (t - 14) / 8; down = true; }
      else continue;
      const s = u * u * (3 - 2 * u);
      // 下りは反対側の車線
      const dx = r.bx - r.ax, dz = r.bz - r.az, l = Math.hypot(dx, dz) || 1, px = -dz / l, pz = dx / l, o = down ? -1.6 : 1.6;
      v.set(r.ax + dx * s + px * o, r.ay + (r.by - r.ay) * s, r.az + dz * s + pz * o);
      this.q.setFromEuler(new THREE.Euler(down ? Math.atan2(r.by - r.ay, l) : -Math.atan2(r.by - r.ay, l), Math.atan2(dx, dz) + (down ? Math.PI : 0), 0, 'YXZ'));
      this.mtx.compose(v, this.q, one);
      this.rampTrucks.setMatrixAt(n, this.mtx);
      this.rampTrucks.setColorAt(n, new THREE.Color(0x2e8b57));
      n++;
      if (n >= 40) break;
    }
    this.rampTrucks.count = n;
    this.rampTrucks.instanceMatrix.needsUpdate = true;
    if (this.rampTrucks.instanceColor) this.rampTrucks.instanceColor.needsUpdate = true;
  }

  // コンテナターミナル：クレーンのトロリーが船から岸壁のトラックへコンテナを運び、トラックが受け取って出ていく（36 秒でひとまわり）
  private updateTerminals(dt: number) {
    const P = 36, T = TERMINAL;
    let nt = 0, nc = 0, nb = 0, nk = 0;
    const v = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
    const palette = [0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b, 0xd35400, 0x1f6f8b];
    for (const tm of this.terminals) {
      tm.t = (tm.t + dt) % P;
      const b = tm.b, hd = tm.D / 2;
      const a = b.face === 0 ? -Math.PI / 2 : b.face === 4 ? Math.PI / 2 : b.face === 6 ? Math.PI : 0;
      this.q.setFromAxisAngle(this.up, -a);
      const zShip = -hd - 26, zLand = -hd + 22.5, yTop = tm.base + T.boomY - 2.6;
      tm.xs.forEach((cx, ci) => {
        const u = ((tm.t / P + ci * 0.23) % 1 + 1) % 1;
        const ease = (x: number) => x * x * (3 - 2 * x);
        // トロリーの位置（z）と、吊り具の高さ（y）、コンテナを持っているか
        let z: number, y: number, carry: boolean;
        if (u < 0.15) { z = zShip; y = yTop - 6 - Math.sin((u / 0.15) * Math.PI) * 26; carry = u > 0.075; }
        else if (u < 0.35) { z = zShip + (zLand - zShip) * ease((u - 0.15) / 0.2); y = yTop - 6; carry = true; }
        else if (u < 0.5) { z = zLand; y = yTop - 6 - Math.sin(((u - 0.35) / 0.15) * Math.PI) * (T.boomY - 12); carry = u < 0.425; }
        else if (u < 0.7) { z = zLand + (zShip - zLand) * ease((u - 0.5) / 0.2); y = yTop - 6; carry = false; }
        else { z = zShip; y = yTop - 6; carry = false; }
        const ccol = palette[(ci + Math.floor(tm.t / P)) % palette.length];
        // トロリー
        const [tx, tz] = lotToWorld(b, cx, z);
        v.set(tx, yTop + 1.3, tz);
        this.mtx.compose(v, this.q, sc);
        if (nt < 60) this.trolleys.setMatrixAt(nt++, this.mtx);
        // ワイヤー 2 本
        const len = Math.max(0.5, yTop - y);
        for (const o of [-3, 3]) {
          const [wx, wz] = lotToWorld(b, cx + o, z);
          v.set(wx, yTop, wz);
          this.mtx.compose(v, this.q, new THREE.Vector3(1, len, 1));
          if (nc < 120) this.cables.setMatrixAt(nc++, this.mtx);
        }
        // 吊り具とコンテナ
        if (carry && nb < 120) {
          v.set(tx, y - 1.3, tz);
          this.mtx.compose(v, this.q, sc);
          this.boxes.setMatrixAt(nb, this.mtx);
          this.boxes.setColorAt(nb++, col.setHex(ccol));
        }
        // コンテナ車：u 0.25 に入ってきて、クレーンの下で待ち、コンテナを積んで出ていく
        if (u > 0.22 && u < 0.66 && nk < 60) {
          let x: number;
          if (u < 0.34) x = cx - 60 + 60 * ease((u - 0.22) / 0.12);
          else if (u < 0.5) x = cx;
          else x = cx + 70 * ease((u - 0.5) / 0.16);
          const truckFront = x + 6;
          const [kx, kz] = lotToWorld(b, truckFront, zLand);
          v.set(kx, tm.base + 0.1, kz);
          const qt = new THREE.Quaternion().setFromAxisAngle(this.up, -a + Math.PI / 2);
          this.mtx.compose(v, qt, sc);
          this.yardTrucks.setMatrixAt(nk++, this.mtx);
          if (u > 0.425 && nb < 120) {
            const [ox, oz] = lotToWorld(b, x, zLand);
            v.set(ox, tm.base + 2.7, oz);
            this.mtx.compose(v, this.q, sc);
            this.boxes.setMatrixAt(nb, this.mtx);
            this.boxes.setColorAt(nb++, col.setHex(ccol));
          }
        }
      });
    }
    this.trolleys.count = nt; this.cables.count = nc; this.boxes.count = nb; this.yardTrucks.count = nk;
    for (const m of [this.trolleys, this.cables, this.boxes, this.yardTrucks]) m.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    this.updateTerminals(dt);
    this.updateRampTrucks(dt);
    this.updateSteam(dt);
    this.updateFx(dt);
    this.updateShips(dt);
    const counts = [0, 0];
    for (const r of this.routes) {
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az) || 1;
      // 片道を行って帰る（t: 0..2）。両端では少し止まる
      r.t = (r.t + (dt * r.speed) / len) % 2.4;
      const ph = r.t < 1.2 ? Math.min(1, r.t / 1.0) : Math.max(0, 1 - (r.t - 1.2) / 1.0);
      const s = ph * ph * (3 - 2 * ph);
      const x = r.ax + (r.bx - r.ax) * s, z = r.az + (r.bz - r.az) * s;
      const dir = r.t < 1.2 ? 1 : -1;
      this.q.setFromAxisAngle(this.up, Math.atan2((r.bx - r.ax) * dir, (r.bz - r.az) * dir));
      this.mtx.compose(new THREE.Vector3(x, 0, z), this.q, new THREE.Vector3(1, 1, 1));
      const m = this.boats[r.mesh];
      if (counts[r.mesh] < 40) m.setMatrixAt(counts[r.mesh]++, this.mtx);
    }
    this.boats.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
    });
    let k = 0;
    for (const rw of this.runways) {
      // 離陸：滑走路を加速して走り、上昇して遠ざかる。60秒ごとにくり返す
      rw.t = (rw.t + dt / 60) % 1;
      const t = rw.t * 3;
      if (t > 1.6) continue;
      const d = t < 1 ? rw.len * 0.7 * t * t : rw.len * 0.7 + (t - 1) * 900;
      const y = t < 0.75 ? 0 : (t < 1 ? (t - 0.75) * 40 : 10 + (t - 1) * 260);
      const pitch = t < 0.75 ? 0 : 0.18;
      this.q.setFromEuler(new THREE.Euler(-pitch, Math.atan2(rw.ux, rw.uz), 0, 'YXZ'));
      this.mtx.compose(new THREE.Vector3(rw.x + rw.ux * d, y + 0.3, rw.z + rw.uz * d), this.q, new THREE.Vector3(rw.scale, rw.scale, rw.scale));
      this.planes.setMatrixAt(k++, this.mtx);
    }
    this.planes.count = k;
    this.planes.instanceMatrix.needsUpdate = true;
  }
}
