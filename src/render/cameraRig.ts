// カメラ（斜め見下ろし、90°ごとに回転、なめらかなズーム）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';

export const MIN_DIST = 30;
export const MAX_DIST = 2600;

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  dist = 520;
  yaw = Math.PI / 4;
  yawTarget = Math.PI / 4;
  pitchOffset = 0; // 設定で変えられる角度のずれ（度）
  private size = 2048;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(38, aspect, 2, 12000);
  }

  // 一番遠くまで離れたときの距離（マップが大きいほど遠くまで）
  maxDist = MAX_DIST;
  setMap(n: number) {
    this.size = n * CELL;
    this.maxDist = MAX_DIST * Math.max(1, n / 128) * 0.85 + (n > 128 ? 0 : MAX_DIST * 0.15);
    this.target.set(this.size / 2, 0, this.size / 2);
  }

  get pitch() {
    const t = Math.min(1, Math.log(this.dist / MIN_DIST) / Math.log(MAX_DIST / MIN_DIST));
    // 近づいたときも地面がつぶれすぎないよう、真上寄りの角度にする（近く 48°〜遠く 72°）
    return THREE.MathUtils.degToRad(Math.max(18, Math.min(86, 48 + t * 24 + this.pitchOffset)));
  }

  update(dt: number, g: Grid | null) {
    // 回転のアニメーション
    const k = 1 - Math.exp(-dt * 10);
    this.yaw += (this.yawTarget - this.yaw) * k;
    const s = this.size;
    this.target.x = Math.max(0, Math.min(s, this.target.x));
    this.target.z = Math.max(0, Math.min(s, this.target.z));
    if (g) {
      const gh = Math.max(0, g.groundAt(this.target.x, this.target.z));
      this.target.y += (gh - this.target.y) * k;
    }
    const p = this.pitch;
    const d = this.dist;
    const cam = this.camera;
    cam.position.set(
      this.target.x + Math.sin(this.yaw) * Math.cos(p) * d,
      this.target.y + Math.sin(p) * d,
      this.target.z + Math.cos(this.yaw) * Math.cos(p) * d,
    );
    cam.lookAt(this.target);
    cam.near = Math.max(1, d * 0.05);
    cam.far = d * 12 + 4000;
    cam.updateProjectionMatrix();
  }

  pan(dx: number, dy: number, viewH: number) {
    const scale = (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / viewH;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(fwd, (dy * scale) / Math.sin(this.pitch));
  }

  // anchor（地面の点）を中心に拡大・縮小
  zoom(factor: number, anchor?: THREE.Vector3 | null) {
    const nd = Math.max(MIN_DIST, Math.min(this.maxDist, this.dist * factor));
    const real = nd / this.dist;
    if (anchor) {
      this.target.x = anchor.x + (this.target.x - anchor.x) * real;
      this.target.z = anchor.z + (this.target.z - anchor.z) * real;
    }
    this.dist = nd;
  }

  rotate(step: number) {
    this.yawTarget += (step * Math.PI) / 2;
  }
}

// 画面の点から地面の位置を求める（高さマップに沿ってレイを進める）
export function pickGround(cam: THREE.Camera, ndcX: number, ndcY: number, g: Grid): THREE.Vector3 | null {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
  const o = ray.ray.origin, d = ray.ray.direction;
  if (d.y >= -1e-4) return null;
  // 高さ 120m の面から始める
  const top = 140;
  let t = o.y > top ? (top - o.y) / d.y : 0;
  const step = 6;
  const p = new THREE.Vector3();
  const size = g.n * CELL;
  let prevT = t;
  for (let k = 0; k < 3000; k++) {
    p.copy(o).addScaledVector(d, t);
    const inside = p.x >= 0 && p.z >= 0 && p.x <= size && p.z <= size;
    const gh = inside ? Math.max(g.groundAt(p.x, p.z), -1) : 0;
    if (p.y <= gh) {
      // 二分探索で詰める
      let a = prevT, b = t;
      for (let i = 0; i < 10; i++) {
        const m = (a + b) / 2;
        p.copy(o).addScaledVector(d, m);
        const h = Math.max(g.groundAt(Math.max(0, Math.min(size, p.x)), Math.max(0, Math.min(size, p.z))), -1);
        if (p.y <= h) b = m;
        else a = m;
      }
      p.copy(o).addScaledVector(d, b);
      return p;
    }
    prevT = t;
    t += step;
    if (p.y < -40) return null;
  }
  return null;
}
