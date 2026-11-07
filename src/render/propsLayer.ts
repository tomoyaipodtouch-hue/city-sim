// 動く船と飛行機（フェリーは乗り場の間を行き来し、飛行機は空港から離陸する）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY } from '../sim/constants';
import { CIVIC, CivicId } from '../sim/defs';
import type { Building } from '../sim/world';
import { labelWater } from '../sim/plan';
import { MeshBuilder } from './builder';
import { airportLayout, bigNuclearScale, boat, containerShip, COOLING_TOWERS, INCIN_RAMP, plane, TERMINAL, terminalCranes } from './buildingGen';
import { garbageTruck, tractor, vc } from './vehicles';
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
  px: Float32Array; // 航路（外洋 → 岸壁の手前）
  pz: Float32Array;
  acc: Float32Array; // 先頭からの距離
  berth: [number, number, number]; // 岸壁での位置と向き
  big?: boolean; // 大型コンテナターミナルの大きな船
  t: number; // 周期の中の時刻（秒）
  hd: number; // 今の向き
}
const SHIP_LEN = 110, SHIP_SPEED = 9, DOCK_SECS = 70, AWAY_SECS = 50;
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
  private bigShipMesh!: THREE.InstancedMesh;
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
    this.bigShipMesh = new THREE.InstancedMesh(geo((mb) => containerShip(mb, 230, 11)), mat, 20);
    // ガントリークレーンのトロリー、吊り具とワイヤー、運ぶコンテナ、コンテナ車
    this.trolleys = new THREE.InstancedMesh(new THREE.BoxGeometry(5, 2.6, 6), new THREE.MeshLambertMaterial({ color: 0xf2f3f4 }), 60);
    this.cables = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1, 0.12).translate(0, -0.5, 0), new THREE.MeshLambertMaterial({ color: 0x30343a }), 120);
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(12.2, 2.6, 2.5), new THREE.MeshLambertMaterial({ color: 0xffffff }), 120);
    const chassis = vc(new THREE.BoxGeometry(2.4, 0.4, 12.6).translate(0, 1.15, -7.6), 0x2a2d31);
    this.yardTrucks = new THREE.InstancedMesh(mergeGeometries([tractor(), chassis])!, mat, 60);
    for (const m of [this.bigShipMesh, this.trolleys, this.cables, this.boxes, this.yardTrucks]) {
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
    const start: number[] = [];
    for (let yy = b.y - 1; yy <= b.y + b.h; yy++)
      for (let xx = b.x - 1; xx <= b.x + b.w; xx++)
        if (g.inb(xx, yy) && water.label[g.idx(xx, yy)] >= 0) { body = water.label[g.idx(xx, yy)]; start.push(g.idx(xx, yy)); }
    if (body < 0 || !water.edge.has(body)) return;
    const wet = (x: number, y: number) => !g.inb(x, y) || water.label[y * n + x] === body;
    const nav = new Uint8Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let ok = water.label[y * n + x] === body;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) if (!wet(x + dx, y + dy)) ok = false;
        nav[y * n + x] = ok ? 1 : 0;
      }
    // 岸壁の前から幅広い水面へは、どの水面も通れる。幅広い水面に入ったらそこだけを通ってマップの端へ
    const prev = new Int32Array(n * n).fill(-2);
    const q: number[] = [];
    for (const c of start) { prev[c] = -1; q.push(c); }
    let end = -1;
    for (let h = 0; h < q.length && end < 0; h++) {
      const c = q[h], x = c % n, y = (c / n) | 0;
      if (nav[c] && (x === 0 || y === 0 || x === n - 1 || y === n - 1)) { end = c; break; }
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!g.inb(nx, ny)) continue;
        const j = ny * n + nx;
        if (prev[j] !== -2 || water.label[j] !== body) continue;
        if (nav[c] && !nav[j]) continue; // 一度広い水面に出たら、狭いところへは戻らない
        if (d & 1 && nav[c] && (!nav[y * n + nx] || !nav[ny * n + x])) continue;
        if (d & 1 && (water.label[y * n + nx] !== body || water.label[ny * n + x] !== body)) continue;
        prev[j] = c;
        q.push(j);
      }
    }
    if (end < 0) return;
    // マスの列（外洋側から港へ）
    const cells: number[] = [];
    for (let c = end; c >= 0; c = prev[c]) cells.push(c);
    const ex = end % n, ey = (end / n) | 0;
    // 見通しのきくところは直線にする
    const clear = (a: number, c: number) => {
      const ax = a % n + 0.5, ay = ((a / n) | 0) + 0.5, cx = c % n + 0.5, cy = ((c / n) | 0) + 0.5;
      const steps = Math.ceil(Math.hypot(cx - ax, cy - ay) * 3);
      for (let k = 0; k <= steps; k++) {
        const x = Math.floor(ax + ((cx - ax) * k) / steps), y = Math.floor(ay + ((cy - ay) * k) / steps);
        if (!g.inb(x, y) || water.label[y * n + x] !== body) return false;
        if (nav[a] && nav[c] && !nav[y * n + x]) return false;
      }
      return true;
    };
    const keep = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = cells.length - 1;
      while (j > i + 1 && !clear(cells[i], cells[j])) j--;
      keep.push(cells[j]);
      i = j;
    }
    const pts: [number, number][] = [];
    // マップの外から入ってくる
    const ox = ex === 0 ? -1 : ex === n - 1 ? 1 : 0, oy = ey === 0 ? -1 : ey === n - 1 ? 1 : 0;
    pts.push([(ex + 0.5 + ox * 25) * CELL, (ey + 0.5 + oy * 25) * CELL]);
    for (const c of keep) pts.push([(c % n + 0.5) * CELL, (((c / n) | 0) + 0.5) * CELL]);
    // 岸壁：敷地の水側に横付けする（向きは岸壁に沿う）
    const [W, D] = lotDepth(b);
    const big = b.type === 'seaport_l';
    const [bx, bz] = lotToWorld(b, 0, -D / 2 - (big ? 22 : 13));
    const [ax, az] = lotToWorld(b, 0, -D / 2 - (big ? 110 : 55));
    const acx = Math.floor(ax / CELL), acy = Math.floor(az / CELL);
    if (g.inb(acx, acy) && water.label[acy * n + acx] === body && clear(acy * n + acx, keep[keep.length - 2] ?? keep[0])) {
      pts.pop();
      pts.push([ax, az]);
    }
    void W;
    const [fx, fz] = lotToWorld(b, 1, 0), [f0x, f0z] = lotToWorld(b, 0, 0);
    const berthHd = Math.atan2(-(fx - f0x), -(fz - f0z)); // 敷地の -x 向き（到着した向きのまま）
    const px = new Float32Array(pts.length), pz = new Float32Array(pts.length), acc = new Float32Array(pts.length);
    pts.forEach(([x, z], k) => {
      px[k] = x; pz[k] = z;
      if (k) acc[k] = acc[k - 1] + Math.hypot(x - px[k - 1], z - pz[k - 1]);
    });
    const L = acc[pts.length - 1];
    const count = big ? 1 : L > 900 ? 2 : 1;
    const cycle = (2 * L) / SHIP_SPEED + DOCK_SECS + AWAY_SECS + 40;
    for (let k = 0; k < count; k++) {
      const prevShip = old.find((s) => s.berth[0] === bx && s.berth[1] === bz && old.indexOf(s) % 2 === k % 2);
      this.ships.push({ px, pz, acc, berth: [bx, bz, berthHd], t: prevShip?.t ?? (k * cycle) / 2 + Math.random() * 20, hd: prevShip?.hd ?? 0, big });
    }
  }

  // 航路の距離 d の位置
  private along(s: Ship, d: number): [number, number, number] {
    const m = s.acc.length;
    let k = 1;
    while (k < m - 1 && s.acc[k] < d) k++;
    const seg = s.acc[k] - s.acc[k - 1] || 1, u = Math.max(0, Math.min(1, (d - s.acc[k - 1]) / seg));
    const dx = s.px[k] - s.px[k - 1], dz = s.pz[k] - s.pz[k - 1];
    return [s.px[k - 1] + dx * u, s.pz[k - 1] + dz * u, Math.atan2(dx, dz)];
  }

  private updateShips(dt: number) {
    let k = 0, kb = 0;
    for (const s of this.ships) {
      const L = s.acc[s.acc.length - 1], run = L / SHIP_SPEED, fin = 20; // fin = 岸壁に寄せる時間
      const cycle = 2 * run + 2 * fin + DOCK_SECS + AWAY_SECS;
      s.t = (s.t + dt) % cycle;
      let t = s.t, x: number, z: number, hd: number;
      if (t < run) {
        [x, z, hd] = this.along(s, t * SHIP_SPEED);
      } else if ((t -= run) < fin * 2 + DOCK_SECS) {
        // 岸壁へ寄せる → 停泊 → 離れる
        const e = s.acc.length - 1;
        const u = t < fin ? t / fin : t < fin + DOCK_SECS ? 1 : 1 - (t - fin - DOCK_SECS) / fin;
        const sm = u * u * (3 - 2 * u);
        x = s.px[e] + (s.berth[0] - s.px[e]) * sm;
        z = s.pz[e] + (s.berth[1] - s.pz[e]) * sm;
        hd = s.berth[2];
      } else if ((t -= fin * 2 + DOCK_SECS) < run) {
        [x, z, hd] = this.along(s, L - t * SHIP_SPEED);
        hd += Math.PI;
      } else continue; // 外洋にいる
      // 向きはなめらかに変える
      let dh = hd - s.hd;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      s.hd += dh * Math.min(1, dt * 0.6);
      if (dt === 0 && s.hd === 0) s.hd = hd;
      if (k >= 40) break;
      this.q.setFromAxisAngle(this.up, s.hd);
      this.mtx.compose(new THREE.Vector3(x, 0, z), this.q, new THREE.Vector3(1, 1, 1));
      if (s.big) { if (kb < 20) this.bigShipMesh.setMatrixAt(kb++, this.mtx); }
      else this.shipMesh.setMatrixAt(k++, this.mtx);
    }
    this.shipMesh.count = k;
    this.shipMesh.instanceMatrix.needsUpdate = true;
    this.bigShipMesh.count = kb;
    this.bigShipMesh.instanceMatrix.needsUpdate = true;
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
