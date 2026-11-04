// 夜の街灯（道路に沿った光の点と、路面を照らす光のにじみ）
import * as THREE from 'three';
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

export class StreetLights {
  points = new THREE.Group();
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
  }

  rebuild(g: Grid) {
    const n = g.n, N = n * n;
    const lamp: number[] = [], pool: number[] = [];
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
      lamp.push(cx, h + 7.5, cz);
      pool.push(cx - px * 0.6, h + 0.25, cz - pz * 0.6);
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
    this.points.visible = k > 0.02;
    this.lampMat.opacity = k;
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.3 * k;
  }
}
