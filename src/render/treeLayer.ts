// 木（インスタンス描画）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import { hash2 } from '../sim/rng';
import type { TreeSpot } from './buildingGen';

const MAX_TREES = 24000;

function colored(geo: THREE.BufferGeometry, color: number) {
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function broadleafGeo() {
  const trunk = colored(new THREE.CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0), 0x5a4330);
  const crown = colored(new THREE.IcosahedronGeometry(2.6, 0).scale(1, 1.15, 1).translate(0, 4.6, 0), 0xffffff);
  return mergeGeometries([trunk.toNonIndexed(), crown.toNonIndexed()])!;
}
function coniferGeo() {
  const trunk = colored(new THREE.CylinderGeometry(0.2, 0.3, 2, 5).translate(0, 1, 0), 0x5a4330);
  const crown = colored(new THREE.ConeGeometry(2.1, 7.5, 6).translate(0, 5.2, 0), 0xffffff);
  return mergeGeometries([trunk.toNonIndexed(), crown.toNonIndexed()])!;
}

export class TreeLayer {
  group = new THREE.Group();
  private meshes: THREE.InstancedMesh[];

  constructor() {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.meshes = [broadleafGeo(), coniferGeo()].map((g) => {
      const m = new THREE.InstancedMesh(g, mat, MAX_TREES);
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
  }

  rebuild(g: Grid, extra: TreeSpot[]) {
    const n = g.n;
    const counts = [0, 0];
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const greens = [0x4f7a32, 0x5d8a3a, 0x3f6b2b, 0x6a9443, 0x56803a].map((c) => new THREE.Color(c));
    const darkGreens = [0x2f5a32, 0x3a6338, 0x2c4f2e].map((c) => new THREE.Color(c));
    const put = (kind: number, x: number, y: number, z: number, s: number, seed: number) => {
      const m = this.meshes[kind];
      const k = counts[kind];
      if (k >= MAX_TREES) return;
      q.setFromAxisAngle(up, seed * 6.28);
      mtx.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s * (0.85 + seed * 0.3), s));
      m.setMatrixAt(k, mtx);
      col.copy(kind === 0 ? greens[Math.floor(seed * 5) % 5] : darkGreens[Math.floor(seed * 3) % 3]);
      m.setColorAt(k, col);
      counts[kind]++;
    };
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const t = g.tree[i];
        if (!t || g.road[i] || g.bldg[i] || g.pline[i]) continue;
        const per = t * 2;
        for (let k = 0; k < per; k++) {
          const hx = hash2(x * 7 + k, y * 13, 1), hz = hash2(x * 11, y * 5 + k, 2), hs = hash2(x + k * 31, y, 3);
          const wx = (x + 0.1 + hx * 0.8) * CELL, wz = (y + 0.1 + hz * 0.8) * CELL;
          const wy = g.groundAt(wx, wz);
          if (wy < 0.4) continue;
          const kind = hash2(x, y, 9) < 0.4 + (wy > 30 ? 0.4 : 0) ? 1 : 0;
          put(kind, wx, wy, wz, 0.8 + hs * 0.6, hs);
        }
      }
    for (const t of extra) put(t.kind, t.x, t.y, t.z, t.s, hash2(Math.floor(t.x), Math.floor(t.z), 4));
    this.meshes.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
  }
}
