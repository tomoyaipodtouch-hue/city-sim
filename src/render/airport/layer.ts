// 新しい空港の描画：
//  ・動かない形（舗装・表示・建物）は、256m の区画ごとのメッシュに分ける（区画ごとの範囲で、画面の外は描かない）。建物と同じマテリアル
//  ・夜の灯火は、全部の空港をまとめて 1 回で描く（光の点）。地面を照らす光（照明塔・街灯）も 1 回
//  ・飛行機（機体の種類ごと）と地上の車両（種類ごと）は InstancedMesh。毎フレーム新しいオブジェクトを作らない
import * as THREE from 'three';
import { Grid } from '../../sim/grid';
import { CELL, DX, DY } from '../../sim/constants';
import { CIVIC, CivicId } from '../../sim/defs';
import type { Building } from '../../sim/world';
import { standDir, AIRPORT_SPECS, airportCells, airportLayout, airportPorts, frameOf, gateLink, stationLines, toLocal, AirFrame, AirportLayout } from '../../sim/airport';
import { MeshBuilder } from '../builder';
import { createBuildingMaterial } from '../materials';
import type { TreeSpot } from '../buildingGen';
import { buildAirportGeometry, LIGHT } from './geometry';
import { AC, AC_TYPES, ALL_LIVERIES, AcType, aircraftGeometry, aircraftMaterial } from './aircraft';
import { GSE_TYPES, GseType, gseGeometry } from './gse';
import { AirOps } from './ops';
import { forecourtPlan } from '../../sim/forecourt';
import { lotToLand } from '../../sim/airport';

const CHUNK_M = 400; // 区画の大きさ（m）：画面の外は描かない。小さすぎると描画の回数が増える
type LiveryAttrs = { tail: THREE.InstancedBufferAttribute; stripe: THREE.InstancedBufferAttribute; win: THREE.InstancedBufferAttribute };
const AC_CAP = 16, GSE_CAP = 40, PAX_CAP = 80;
const DYN_PER_AC = 5;
const ALL_KEYS: string[] = [...AC_TYPES, ...GSE_TYPES, 'tunnel', 'cab', 'leg'];
const BRIDGE_CAP = 48;
const ROT_H = 5.3; // 搭乗橋の付け根（回転する部屋）の高さ
const smooth = (x: number) => x * x * (3 - 2 * x);
// 飛行機の灯火の色（毎フレーム配列を作らない）
const NAV_RED = [1, 0.15, 0.1], NAV_GREEN = [0.2, 1, 0.4], WHITE = [1, 1, 1], BEACON = [1, 0.12, 0.08], OFF = [0, 0, 0], LANDING = [1, 0.97, 0.9]; // 飛行機の灯火（左の赤、右の緑、尾の白、赤い衝突防止灯、着陸灯）

export const isAirfield = (b: Building) => b.civic && !!CIVIC[b.type as CivicId]?.airfield;

interface Entry {
  key: string;
  b: Building;
  L: AirportLayout;
  f: AirFrame;
  base: number;
  meshes: THREE.Mesh[];
  ops: AirOps;
  lights: number[];
  centre: { idx: number; a: number; rw: number }[];
  beacons: number[];
  pools: number[];
  trees: TreeSpot[];
  lightOff: number; // 全体の光の点の中の、この空港の始まり
}

// 三角形を、重心の位置で区画ごとに分ける
function splitChunks(mb: MeshBuilder): THREE.BufferGeometry[] {
  const P = mb.pos, I = mb.idx;
  const groups = new Map<number, number[]>();
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const x = (P[a] + P[b] + P[c]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const k = Math.floor(x / CHUNK_M) * 4096 + Math.floor(z / CHUNK_M);
    let gl = groups.get(k);
    if (!gl) groups.set(k, (gl = []));
    gl.push(t);
  }
  const out: THREE.BufferGeometry[] = [];
  const remap = new Int32Array(P.length / 3).fill(-1);
  for (const tris of groups.values()) {
    const used: number[] = [];
    const idx: number[] = [];
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const v = I[t + k];
      if (remap[v] < 0) { remap[v] = used.length; used.push(v); }
      idx.push(remap[v]);
    }
    const nv = used.length;
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), uvm = new Float32Array(nv * 2), pat = new Float32Array(nv), mat = new Float32Array(nv);
    used.forEach((v, j) => {
      for (let q = 0; q < 3; q++) { pos[j * 3 + q] = P[v * 3 + q]; nor[j * 3 + q] = mb.nor[v * 3 + q]; col[j * 3 + q] = mb.col[v * 3 + q]; }
      uvm[j * 2] = mb.uvm[v * 2]; uvm[j * 2 + 1] = mb.uvm[v * 2 + 1];
      pat[j] = mb.pat[v]; mat[j] = mb.mat[v];
    });
    for (const v of used) remap[v] = -1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aUvm', new THREE.BufferAttribute(uvm, 2));
    g.setAttribute('aPat', new THREE.BufferAttribute(pat, 1));
    g.setAttribute('aMat', new THREE.BufferAttribute(mat, 1));
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}

// 光の点（灯火）のマテリアル：点ごとの色と大きさ。夜だけ光る
function lightMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 }, uNight: { value: 0 } },
    vertexShader: `
      attribute vec3 color;
      attribute float size;
      uniform float uScale;
      varying vec3 vCol;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // 遠くでも点として見える（最小 1.6 画素）。近くでは大きくなりすぎない
        gl_PointSize = clamp(1.8 * size * uScale / max(1.0, -mv.z), 2.2, 40.0);
        vCol = color;
      }`,
    fragmentShader: `
      uniform float uNight;
      varying vec3 vCol;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        float a = exp(-r2 * 3.2) + 0.6 * exp(-r2 * 26.0);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vCol * uNight * 2.2, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function glowTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class AirportLayer {
  group = new THREE.Group();
  material = createBuildingMaterial();
  private entries = new Map<number, Entry>();

  // 灯火
  private pts: THREE.Points;
  private ptsMat = lightMaterial();
  private staticCount = 0;
  private dynStart = 0;
  private pools: THREE.InstancedMesh;
  // 飛行機と地上の車両
  private acMesh: Record<AcType, THREE.InstancedMesh>;
  private gseMesh: Record<GseType, THREE.InstancedMesh>;
  private livery: Record<AcType, LiveryAttrs>;
  private colors = ALL_LIVERIES.map((l) => [new THREE.Color(l.tail), new THREE.Color(l.stripe), new THREE.Color(l.win)]);
  private paxCols = [0xc8342c, 0x2f6fb2, 0xf2c230, 0x3d8a4a, 0xeeeeee, 0x333333, 0xe8772e, 0x8e5aa8].map((h) => new THREE.Color(h));
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private cnt: Record<string, number> = {};
  private box: Record<string, [number, number, number, number, number, number]> = {};
  private time = 0;
  private night = 0;
  private listVersion = 0;

  constructor() {
    this.pts = new THREE.Points(new THREE.BufferGeometry(), this.ptsMat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 4;
    this.pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glowTex(), color: 0xffd8a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }),
      512,
    );
    this.pools.count = 0;
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 3;
    const am = aircraftMaterial();
    this.acMesh = {} as Record<AcType, THREE.InstancedMesh>;
    this.livery = {} as Record<AcType, LiveryAttrs>;
    for (const t of AC_TYPES) {
      const g = aircraftGeometry(t);
      const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(AC_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const L = { tail: mk(), stripe: mk(), win: mk() };
      g.setAttribute('iTail', L.tail);
      g.setAttribute('iStripe', L.stripe);
      g.setAttribute('iWin', L.win);
      this.livery[t] = L;
      const m = new THREE.InstancedMesh(g, am, AC_CAP);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.boundingSphere = new THREE.Sphere();
      this.acMesh[t] = m;
      this.group.add(m);
    }
    const gm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 });
    this.gseMesh = {} as Record<GseType, THREE.InstancedMesh>;
    for (const t of GSE_TYPES) {
      const m = new THREE.InstancedMesh(gseGeometry(t), gm, t === 'pax' ? PAX_CAP : GSE_CAP);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.castShadow = t === 'bus' || t === 'fuel'; // 小さな車両と人は影を落とさない（影の描画の回数を減らす）
      m.receiveShadow = true;
      m.boundingSphere = new THREE.Sphere();
      if (t === 'pax') { for (let k = 0; k < PAX_CAP; k++) m.setColorAt(k, this.paxCols[k % this.paxCols.length]); }
      this.gseMesh[t] = m;
      this.group.add(m);
    }
    // 搭乗橋（のび縮みする通路・扉につく運転室・車輪のついた脚）
    const bm = new THREE.MeshStandardMaterial({ color: 0xc4c9ce, roughness: 0.45, metalness: 0.35 });
    const mk = (g: THREE.BufferGeometry, mat: THREE.Material = bm) => {
      const m = new THREE.InstancedMesh(g, mat, BRIDGE_CAP);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0; m.castShadow = true; m.receiveShadow = true; m.boundingSphere = new THREE.Sphere();
      this.group.add(m);
      return m;
    };
    this.tunnel = mk(new THREE.BoxGeometry(2.8, 2.9, 1).translate(0, 0, 0.5));
    this.cab = mk(new THREE.BoxGeometry(3.6, 3.2, 3.4).translate(0, 0, 1.7), new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.5, metalness: 0.3 }));
    this.leg = mk(new THREE.BoxGeometry(2.2, 1, 0.9).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x5c6167, roughness: 0.6, metalness: 0.4 }));
    this.cab.castShadow = this.leg.castShadow = false;
    this.group.add(this.pools, this.pts);
  }

  get count() {
    return this.entries.size;
  }

  // 空港の一覧・地形・線路・道路が変わったら呼ぶ。木の位置が変わったら true
  update(g: Grid, list: Building[]): boolean {

    const seen = new Set<number>();
    let changed = false;
    for (const b of list) {
      if (!isAirfield(b)) continue;
      seen.add(b.id);
      const size = CIVIC[b.type as CivicId].airfield!;
      const spec = AIRPORT_SPECS[size], L = airportLayout(size), f = frameOf(b, spec);
      const cells = airportCells(g.n, b, spec);
      const lot = new Set(cells);
      let hsum = 0;
      for (const i of cells) hsum += g.cellMaxH(i % g.n, (i / g.n) | 0);
      const base = Math.round((hsum / cells.length) * 100) / 100;
      const P = airportPorts(g.n, f, L, cells, (i) => lot.has(i));
      const lines = [...stationLines(g, P).keys()].sort();
      // 門（正門・通用門）：門のマスの中心（敷地の座標）、外へ向かう向き、つながっているもの、路面の高さ
      const gateOf = (gc: typeof P.gate, main: boolean) => {
        if (!gc) return null;
        const lk = gateLink(g, gc, main);
        const [a, c] = toLocal(f, (gc.x + 0.5) * CELL, (gc.y + 0.5) * CELL);
        const wx = DX[gc.d], wz = DY[gc.d], l = Math.hypot(wx, wz);
        const da = (wx * f.cos + wz * f.sin) / l, dc = (-wx * f.sin + wz * f.cos) / l;
        return { a, c, da, dc, kind: lk?.kind ?? null, h: lk ? g.nodeH(lk.node) - base : 0, diag: (gc.d & 1) === 1 };
      };
      const gate = gateOf(P.gate, true), svc = gateOf(P.svc, false);
      const key = `${b.x}.${b.y}.${b.w}.${b.h}.${b.face}.${base}.${lines.join(',')}.${gate?.kind}${Math.round(gate?.h ?? 0)}.${svc?.kind}.${b.airFc ? 1 : 0}${b.airLevel ?? 0}${b.airH ?? 9}`;
      const old = this.entries.get(b.id);
      if (old && old.key === key) { old.b = b; this.feed(old); continue; }
      if (old) this.drop(old);
      // ターミナル前の道路（フォアコート）の計画（シミュレーションと同じ。道路のマスはシミュレーションが置いたもの）
      let fc = null;
      if (b.airFc && P.gate) {
        const plan = forecourtPlan(g.n, f, L, cells, (i) => lot.has(i), P.gate, b.airLevel ?? 0, b.airH ?? 9);
        if (plan.ok) {
          const pts = new Map<string, [number, number, number][]>();
          for (const p of plan.paths) pts.set(p.name, p.cells.map((i, k) => { const [la, lc] = toLocal(f, ((i % g.n) + 0.5) * CELL, (((i / g.n) | 0) + 0.5) * CELL), [a, c] = lotToLand(L, la, lc); return [a, c, p.h[k]]; }));
          fc = { plan, pts };
        }
      }
      const geo = buildAirportGeometry(L, f, { cells, n: g.n, base, seed: b.seed, gate, svc, lines, fc });
      const meshes = splitChunks(geo.mb).map((gg) => {
        const m = new THREE.Mesh(gg, this.material);
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        return m;
      });
      // 進入・上昇でマップの外へ出るまでの長さ（敷地の中心から、a の向き・逆向き）
      const span = g.n * CELL;
      const exit = (dx: number, dz: number) => {
        let t = Infinity;
        if (dx > 1e-6) t = Math.min(t, (span - f.cx) / dx); else if (dx < -1e-6) t = Math.min(t, -f.cx / dx);
        if (dz > 1e-6) t = Math.min(t, (span - f.cz) / dz); else if (dz < -1e-6) t = Math.min(t, -f.cz / dz);
        return Math.max(t, L.A / 2) + 700;
      };
      const ops = old?.ops && old.f.rot === f.rot && old.L === L ? old.ops : new AirOps(L, { pos: exit(f.cos, f.sin), neg: exit(-f.cos, -f.sin) }, b.seed);
      const e: Entry = { key, b, L, f, base, meshes, ops, lights: geo.lights, centre: geo.centre, beacons: geo.beacons, pools: geo.pools, trees: geo.trees, lightOff: 0 };
      ops.onDirChange = () => this.recolourCentre(e);
      this.feed(e);
      if (!old) ops.seed();
      this.entries.set(b.id, e);
      changed = true;
    }
    for (const [id, e] of this.entries) if (!seen.has(id)) { this.drop(e); this.entries.delete(id); changed = true; }
    if (changed) { this.list = [...this.entries.values()]; this.rebuildLights(); }
    if (changed) this.listVersion++;
    return changed;
  }

  // シミュレーションの数字を運航へ
  // 確認用：便数を決めて動かす（null で元に戻す）
  forceFlights: number | null = null;
  // 確認用：時間を進める（0.1 秒ずつ）
  advance(sec: number, tod = 0.5) {
    for (let t = 0; t < sec; t += 0.1) this.tick(0.1, tod);
  }
  force(n: number | null) {
    this.forceFlights = n;
    for (const e of this.entries.values()) this.feed(e);
  }
  private feed(e: Entry) {
    const a = e.b.air;
    if (this.forceFlights !== null) { e.ops.open = true; e.ops.flights = this.forceFlights; e.ops.cargoFlights = Math.round(this.forceFlights / 5); return; }
    e.ops.open = a ? a.open : e.b.powered;
    e.ops.flights = a ? a.flights : 6;
    e.ops.cargoFlights = a ? a.cargoFlights : 0;
  }

  private drop(e: Entry) {
    for (const m of e.meshes) { this.group.remove(m); m.geometry.dispose(); }
    e.meshes = [];
  }

  // 全部の空港の灯火を 1 つの点の集まりにする（最後に飛行機の灯火の分をあけておく）
  private rebuildLights() {
    let n = 0, dyn = 0;
    for (const e of this.entries.values()) { e.lightOff = n; n += e.lights.length / 7; dyn += e.L.spec.maxAircraft * DYN_PER_AC; }
    this.staticCount = n;
    this.dynStart = n;
    const total = n + dyn;
    const pos = new Float32Array(total * 3), col = new Float32Array(total * 3), size = new Float32Array(total);
    let k = 0;
    for (const e of this.entries.values()) {
      const l = e.lights;
      for (let i = 0; i < l.length; i += 7, k++) {
        pos[k * 3] = l[i]; pos[k * 3 + 1] = l[i + 1]; pos[k * 3 + 2] = l[i + 2];
        col[k * 3] = l[i + 3]; col[k * 3 + 1] = l[i + 4]; col[k * 3 + 2] = l[i + 5];
        size[k] = l[i + 6];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, n);
    this.pts.geometry.dispose();
    this.pts.geometry = g;
    for (const e of this.entries.values()) this.recolourCentre(e, false);
    // 地面を照らす光
    let p = 0;
    for (const e of this.entries.values()) for (let i = 0; i + 3 < e.pools.length && p < this.pools.instanceMatrix.count; i += 4) {
      this.v.set(e.pools[i], e.pools[i + 1], e.pools[i + 2]);
      this.m4.compose(this.v, this.q.identity(), new THREE.Vector3(e.pools[i + 3], 1, e.pools[i + 3]));
      this.pools.setMatrixAt(p++, this.m4);
    }
    this.pools.count = p;
    this.pools.instanceMatrix.needsUpdate = true;
  }

  // 滑走路の中心線灯：使っている向きの奥の端から 300m は赤、600m までは赤と白が交互、ほかは白
  private recolourCentre(e: Entry, upload = true) {
    const col = this.pts.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!col) return;
    const dir = e.ops.dir;
    e.centre.forEach((cl, j) => {
      const r = e.L.runways[cl.rw];
      const d = dir > 0 ? r.a1 - cl.a : cl.a - r.a0;
      const red = d < 300 || (d < 600 && j % 2 === 0);
      const c = red ? LIGHT.clRed : LIGHT.clWhite;
      col.setXYZ(e.lightOff + cl.idx, c[0], c[1], c[2]);
    });
    if (upload) col.needsUpdate = true;
  }

  beacons(): number[] {
    const out: number[] = [];
    for (const e of this.entries.values()) for (const v of e.beacons) out.push(v);
    return out;
  }
  trees(): TreeSpot[] {
    const out: TreeSpot[] = [];
    for (const e of this.entries.values()) for (const t of e.trees) out.push(t);
    return out;
  }
  // 確認用：今いる飛行機
  debug() {
    return [...this.entries.values()].map((e) => ({ id: e.b.id, dir: e.ops.dir, ac: e.ops.aircraft.map((a) => ({ type: a.type, phase: a.phase, a: Math.round(a.a), c: Math.round(a.c), y: Math.round(a.y), X: Math.round(a.a * e.f.cos - a.c * e.f.sin + e.f.cx), Z: Math.round(a.a * e.f.sin + a.c * e.f.cos + e.f.cz), livery: ALL_LIVERIES[a.livery].name })), trips: e.ops.trips.filter((t) => t.live).map((t) => t.type) }));
  }
  get version() {
    return this.listVersion;
  }

  setNight(k: number, pxScale: number) {
    this.night = k;
    this.ptsMat.uniforms.uNight.value = k;
    this.ptsMat.uniforms.uScale.value = pxScale;
    this.pts.visible = k > 0.02 && this.staticCount > 0;
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.42 * k;
    this.pools.visible = k > 0.02;
  }

  // 毎フレーム：運航をすすめ、飛行機と車両を置く（dt = ゲームの速さをかけた秒、tod = 1 日の時刻 0..1）
  tick(dt: number, tod: number) {
    this.time += dt;
    for (let i = 0; i < ALL_KEYS.length; i++) { const k = ALL_KEYS[i]; this.cnt[k] = 0; const b = (this.box[k] ??= [0, 0, 0, 0, 0, 0]); b[0] = b[1] = b[2] = Infinity; b[3] = b[4] = b[5] = -Infinity; }
    if (!this.list.length) { for (const t of AC_TYPES) this.acMesh[t].count = 0; for (const t of GSE_TYPES) this.gseMesh[t].count = 0; for (const [m] of this.bridgeMeshes) m.count = 0; return; }
    const pos = this.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.pts.geometry.getAttribute('color') as THREE.BufferAttribute;
    const size = this.pts.geometry.getAttribute('size') as THREE.BufferAttribute;
    let dyn = this.dynStart;
    const blink = (this.time % 1.2) < 0.12;
    for (let ei = 0; ei < this.list.length; ei++) {
      const e = this.list[ei];
      e.ops.update(dt, tod);
      const f = e.f, base = e.base;
      for (let ai = 0; ai < e.ops.aircraft.length; ai++) {
        const ac = e.ops.aircraft[ai];
        const t = ac.type, k = this.cnt[t];
        if (k >= AC_CAP) continue;
        const X = ac.a * f.cos - ac.c * f.sin + f.cx, Z = ac.a * f.sin + ac.c * f.cos + f.cz, Y = base + ac.y + 0.12;
        const dx = ac.ha * f.cos - ac.hc * f.sin, dz = ac.ha * f.sin + ac.hc * f.cos;
        const yaw = Math.atan2(dx, dz);
        this.e.set(-ac.pitch, yaw, 0, 'YXZ');
        this.q.setFromEuler(this.e);
        this.v.set(X, Y, Z);
        this.m4.compose(this.v, this.q, this.one);
        const m = this.acMesh[t];
        m.setMatrixAt(k, this.m4);
        const [ct, cs, cw] = this.colors[ac.livery], L = this.livery[t];
        L.tail.setXYZ(k, ct.r, ct.g, ct.b); L.stripe.setXYZ(k, cs.r, cs.g, cs.b); L.win.setXYZ(k, cw.r, cw.g, cw.b);
        this.cnt[t] = k + 1;
        this.grow(t, X, Y, Z);
        // 飛行機の灯火（夜）
        if (this.night > 0.02 && pos && dyn + DYN_PER_AC <= pos.count) {
          const d = AC[t];
          this.lx = X; this.ly = Y; this.lz = Z; this.lyaw = yaw; this.lpitch = ac.pitch;
          const wy = d.high ? d.fy + d.R : d.fy - d.R * 0.2;
          this.putLight(dyn++, d.span / 2, wy, -1, NAV_RED, 3.5);
          this.putLight(dyn++, -d.span / 2, wy, -1, NAV_GREEN, 3.5);
          this.putLight(dyn++, 0, d.fy + d.R * 0.5, -d.len / 2, WHITE, 3);
          this.putLight(dyn++, 0, d.fy + d.R + 0.2, 0, blink ? BEACON : OFF, 5);
          this.putLight(dyn++, 0, d.fy - d.R, d.len / 2 - 2, ac.lights ? LANDING : OFF, ac.lights ? 16 : 0);
        }
      }
      this.curEntry = e;
      e.ops.eachGse(this.time, this.emitGse);
      this.placeBridges(e);
    }
    for (const [m, t] of this.bridgeMeshes) {
      m.count = this.cnt[t];
      m.visible = m.count > 0;
      if (m.count) m.instanceMatrix.needsUpdate = true;
      this.fitSphere(m, 'tunnel', 30);
    }
    for (const t of AC_TYPES) {
      const m = this.acMesh[t];
      m.count = this.cnt[t];
      m.visible = m.count > 0;
      if (m.count) {
        m.instanceMatrix.needsUpdate = true;
        const L = this.livery[t];
        L.tail.needsUpdate = L.stripe.needsUpdate = L.win.needsUpdate = true;
      }
      this.fitSphere(m, t, 30);
    }
    for (const t of GSE_TYPES) {
      const m = this.gseMesh[t];
      m.count = this.cnt[t];
      m.visible = m.count > 0;
      if (m.count) m.instanceMatrix.needsUpdate = true;
      this.fitSphere(m, t, 10);
    }
    if (pos) {
      (this.pts.geometry as THREE.BufferGeometry).setDrawRange(0, this.night > 0.02 ? dyn : this.staticCount);
      if (dyn > this.dynStart) { pos.needsUpdate = col.needsUpdate = size.needsUpdate = true; pos.addUpdateRange(this.dynStart * 3, (dyn - this.dynStart) * 3); }
    }
  }
  private tunnel!: THREE.InstancedMesh;
  private cab!: THREE.InstancedMesh;
  private leg!: THREE.InstancedMesh;
  private door = new Float32Array(3);
  private sc = new THREE.Vector3();
  // 搭乗橋：付け根（回転する部屋）から、運転室（扉につく先）まで。ext = のび（0..1）
  private placeBridges(e: Entry) {
    const f = e.f, L = e.L;
    for (let k = 0; k < L.stands.length; k++) {
      const st = L.stands[k];
      if (!st.rot) continue;
      const nb = this.cnt.tunnel;
      if (nb >= BRIDGE_CAP) return;
      const x = smooth(e.ops.bridge[k]);
      e.ops.bridgeDoor(k, this.door);
      const [ra, rc] = st.rot;
      // 縮んだとき：付け根からエプロンの側へ短く。のびたとき：運転室の前が扉の横
      // 縮んだとき：付け根から機体の側へ 8m・横へ 2m。のびたとき：扉の横（左へ 1.9m）
      const [ua, uc] = standDir(st), la0 = uc, lc0 = -ua;
      const ra0 = ra - ua * 8 - la0 * 2, rc0 = rc - uc * 8 - lc0 * 2;
      const ca = ra0 + (this.door[0] + la0 * 1.9 - ra0) * x, cc = rc0 + (this.door[1] + lc0 * 1.9 - rc0) * x;
      const cy = 4.4 + (this.door[2] - 4.4) * x;
      // 付け根の部屋のふちから運転室まで（敷地の座標）
      let da = ca - ra, dc = cc - rc;
      const dl = Math.hypot(da, dc) || 1;
      da /= dl; dc /= dl;
      const sa = ra + da * 2.3, sc = rc + dc * 2.3, sy = ROT_H - 0.2;
      const len = Math.max(0.5, Math.hypot(ca - sa, cc - sc) - 1.2);
      const W = (a: number, c: number, y: number) => this.v.set(a * f.cos - c * f.sin + f.cx, e.base + y, a * f.sin + c * f.cos + f.cz);
      const wx = da * f.cos - dc * f.sin, wz = da * f.sin + dc * f.cos, yaw = Math.atan2(wx, wz);
      const pitch = Math.atan2(sy - cy, len);
      this.e.set(pitch, yaw, 0, 'YXZ');
      this.q.setFromEuler(this.e);
      W(sa, sc, sy);
      this.m4.compose(this.v, this.q, this.sc.set(1, 1, len));
      this.tunnel.setMatrixAt(nb, this.m4);
      this.grow('tunnel', this.v.x, this.v.y, this.v.z);
      // 運転室（扉の横、通路の先）
      this.e.set(0, yaw, 0, 'YXZ');
      this.q.setFromEuler(this.e);
      W(ca - da * 1.8, cc - dc * 1.8, cy - 0.1);
      this.m4.compose(this.v, this.q, this.sc.set(1, 1, 1));
      this.cab.setMatrixAt(nb, this.m4);
      // 車輪のついた脚（通路の 7 割のところ）
      const la = sa + (ca - sa) * 0.7, lcc = sc + (cc - sc) * 0.7, ly = sy + (cy - sy) * 0.7 - 1.5;
      W(la, lcc, 0);
      this.m4.compose(this.v, this.q, this.sc.set(1, Math.max(0.5, ly), 1));
      this.leg.setMatrixAt(nb, this.m4);
      this.cnt.tunnel = this.cnt.cab = this.cnt.leg = nb + 1;
    }
  }
  private curEntry: Entry | null = null;
  private list: Entry[] = [];
  private get bridgeMeshes(): [THREE.InstancedMesh, string][] {
    return (this._bm ??= [[this.tunnel, 'tunnel'], [this.cab, 'cab'], [this.leg, 'leg']]);
  }
  private _bm: [THREE.InstancedMesh, string][] | null = null;
  private lx = 0; private ly = 0; private lz = 0; private lyaw = 0; private lpitch = 0;
  // 飛行機の灯火 1 つ（機体の座標 lx = 左右（+ が左の翼）、ly = 高さ、lz = 前後）
  private putLight(i: number, lx: number, ly: number, lz: number, c: number[], s: number) {
    const g = this.pts.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute, col = g.getAttribute('color') as THREE.BufferAttribute, size = g.getAttribute('size') as THREE.BufferAttribute;
    const sx = Math.cos(this.lyaw), sz = -Math.sin(this.lyaw), fx = Math.sin(this.lyaw), fz = Math.cos(this.lyaw);
    pos.setXYZ(i, this.lx + sx * lx + fx * lz, this.ly + ly + lz * Math.sin(this.lpitch), this.lz + sz * lx + fz * lz);
    col.setXYZ(i, c[0], c[1], c[2]);
    size.setX(i, s);
  }
  private emitGse = (type: GseType, a: number, c: number, ha: number, hc: number, y = 0) => {
    // 今まわしている空港の変換（eachGse の中で呼ばれる）
    const e = this.curEntryFor();
    const f = e.f;
    const k = this.cnt[type], m = this.gseMesh[type];
    if (k >= (type === 'pax' ? PAX_CAP : GSE_CAP)) return;
    const X = a * f.cos - c * f.sin + f.cx, Z = a * f.sin + c * f.cos + f.cz, Y = e.base + 0.12 + y;
    const dx = ha * f.cos - hc * f.sin, dz = ha * f.sin + hc * f.cos;
    this.q.setFromAxisAngle(this.up, Math.atan2(dx, dz));
    this.v.set(X, Y, Z);
    this.m4.compose(this.v, this.q, this.one);
    m.setMatrixAt(k, this.m4);
    this.cnt[type] = k + 1;
    this.grow(type, X, Y, Z);
  };
  private up = new THREE.Vector3(0, 1, 0);
  private curEntryFor(): Entry {
    return this.curEntry!;
  }
  private grow(t: string, x: number, y: number, z: number) {
    const b = this.box[t];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
    if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
  }
  // 動くもの全体を囲む球（画面の外なら描かない）
  private fitSphere(m: THREE.InstancedMesh, t: string, pad: number) {
    const b = this.box[t], s = m.boundingSphere!;
    if (!m.count) { s.center.set(0, -1e5, 0); s.radius = 0; return; }
    s.center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    s.radius = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 + pad;
  }
}
