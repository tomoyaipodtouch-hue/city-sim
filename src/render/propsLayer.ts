// 動く船と飛行機（フェリーは乗り場の間を行き来し、飛行機は空港から離陸する）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import { CIVIC, CivicId } from '../sim/defs';
import type { Building } from '../sim/world';
import { labelWater } from '../sim/plan';
import { MeshBuilder } from './builder';
import { boat, plane } from './buildingGen';

interface Route {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  speed: number;
  t: number;
  mesh: number; // 0 = 旅客船, 1 = カーフェリー
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
    for (const m of [...this.boats, this.planes]) {
      m.count = 0;
      m.castShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
  }

  setBuildings(g: Grid, list: Building[]) {
    const water = labelWater(g);
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
      if (def.airport) {
        const [W, D] = lotDepth(b);
        const rw = def.airport === 2 ? 22 : 16;
        const rx = -W / 2 + rw / 2 + 4;
        const [x0, z0] = lotToWorld(b, rx, D / 2 - 6), [x1, z1] = lotToWorld(b, rx, -D / 2 + 6);
        const len = Math.hypot(x1 - x0, z1 - z0);
        this.runways.push({ x: x0, z: z0, ux: (x1 - x0) / len, uz: (z1 - z0) / len, len, t: Math.random(), scale: def.airport === 2 ? 1 : 0.7 });
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

  update(dt: number) {
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
      const d = t < 1 ? rw.len * t * t : rw.len + (t - 1) * 900;
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
