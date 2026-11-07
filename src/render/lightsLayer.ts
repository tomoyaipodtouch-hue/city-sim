// 夜の街灯（道路に沿った光の点と、路面を照らす光のにじみ）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY } from '../sim/constants';
import { ROADS } from '../sim/defs';

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 街灯の柱（腕は +x の向き、長さ 2m）
function poleGeo() {
  const parts = [
    new THREE.CylinderGeometry(0.09, 0.13, 7.6, 6).translate(0, 3.8, 0),
    new THREE.BoxGeometry(2.2, 0.1, 0.1).translate(1.0, 7.45, 0),
    new THREE.BoxGeometry(0.7, 0.16, 0.32).translate(2.0, 7.38, 0),
  ].map((g) => g.toNonIndexed());
  parts.forEach((g) => g.deleteAttribute('uv'));
  return mergeGeometries(parts)!;
}

export class StreetLights {
  group = new THREE.Group(); // 昼も見える柱と、夜だけの光
  points = new THREE.Group();
  // 柱は亜鉛めっきの鉄（少しつやのある金属）
  private poles = new THREE.InstancedMesh(poleGeo(), new THREE.MeshStandardMaterial({ color: 0x80878e, roughness: 0.5, metalness: 0.55 }), 8192 * 6);
  // 航空障害灯（高い建物のてっぺんの赤いランプ）
  private beacons: THREE.Points;
  private beaconMat: THREE.PointsMaterial;
  private lamps: THREE.Points;
  private pools: THREE.InstancedMesh;
  private lampMat: THREE.PointsMaterial;
  constructor() {
    const tex = glowTexture();
    const mk = (size: number, color: number) =>
      new THREE.PointsMaterial({ map: tex, size, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: true });
    this.lampMat = mk(12, 0xffd9a0);
    this.lamps = new THREE.Points(new THREE.BufferGeometry(), this.lampMat);
    // 路面を照らす光：地面に平らに置いた丸い光（建物や地面に食い込まないように）
    this.pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, color: 0xffb870, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }),
      8192 * 6,
    );
    this.pools.count = 0;
    this.lamps.frustumCulled = this.pools.frustumCulled = false;
    this.points.add(this.pools, this.lamps);
    this.points.visible = false;
    this.poles.count = 0;
    this.poles.castShadow = true;
    this.poles.frustumCulled = false;
    this.beaconMat = new THREE.PointsMaterial({ map: tex, size: 7, color: 0xff2a1a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: true });
    this.beacons = new THREE.Points(new THREE.BufferGeometry(), this.beaconMat);
    this.beacons.frustumCulled = false;
    this.group.add(this.poles, this.points, this.beacons);
  }

  setBeacons(pos: number[]) {
    this.beacons.geometry.dispose();
    this.beacons.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }

  // 航空障害灯の点滅（約1.5秒ごと）。昼は小さく暗い
  private night = 0;
  update(time: number) {
    const on = (time % 1.5) < 0.75 ? 1 : 0.15;
    this.beaconMat.opacity = on * (0.35 + 0.65 * this.night);
    this.beaconMat.size = 8 + 18 * this.night;
  }

  rebuild(g: Grid) {
    const n = g.n, N = n * n;
    const lamp: number[] = [], pool: number[] = [], poles: number[] = [];
    for (let node = 0; node < 2 * N; node++) {
      const level = node >= N ? 1 : 0;
      const i = node - level * N;
      const t = level ? g.up[i] : g.road[i];
      if (!t) continue;
      const x = i % n, y = (i / n) | 0;
      // 1マスおきに、左右交互に立てる
      if ((x + y) & 1) continue;
      const m = level ? g.conn1[i] : g.conn[i];
      let d = 0;
      while (d < 8 && !(m & (1 << d))) d++;
      if (d === 8) d = 0;
      let px = -DY[d], pz = DX[d];
      const l = Math.hypot(px, pz) || 1;
      const side = x & 1 ? -1 : 1;
      const off = (ROADS[t].width / 2 + 0.6) * side;
      px = (px / l) * off;
      pz = (pz / l) * off;
      const cx = (x + 0.5) * CELL + px, cz = (y + 0.5) * CELL + pz;
      const h = g.nodeH(node);
      // 腕は道路の中心の向き
      const dl = Math.hypot(px, pz) || 1, dx = -px / dl, dz = -pz / dl;
      lamp.push(cx + dx * 2.0, h + 7.2, cz + dz * 2.0);
      pool.push(cx - px * 0.6, h + 0.25, cz - pz * 0.6);
      poles.push(cx, h, cz, Math.atan2(-dz, dx));
    }
    {
      const m2 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      const pc = Math.min(this.poles.instanceMatrix.count, poles.length / 4);
      for (let k = 0; k < pc; k++) {
        v2.set(poles[k * 4], poles[k * 4 + 1], poles[k * 4 + 2]);
        q2.setFromAxisAngle(up, poles[k * 4 + 3]);
        this.poles.setMatrixAt(k, m2.compose(v2, q2, one));
      }
      this.poles.count = pc;
      this.poles.instanceMatrix.needsUpdate = true;
    }
    this.lamps.geometry.dispose();
    this.lamps.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lamp, 3));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(11, 1, 11), v = new THREE.Vector3();
    const cnt = Math.min(this.pools.instanceMatrix.count, pool.length / 3);
    for (let k = 0; k < cnt; k++) {
      v.set(pool[k * 3], pool[k * 3 + 1], pool[k * 3 + 2]);
      this.pools.setMatrixAt(k, m.compose(v, q, sc));
    }
    this.pools.count = cnt;
    this.pools.instanceMatrix.needsUpdate = true;
  }

  setNight(k: number) {
    this.night = k;
    this.points.visible = k > 0.02;
    this.lampMat.opacity = k;
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.3 * k;
  }
}
