// 木（インスタンス描画）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import { ROADS, RoadType } from '../sim/defs';
import { hash2 } from '../sim/rng';
import type { TreeSpot } from './buildingGen';

const MAX_TREES = 64000;

function colored(geo: THREE.BufferGeometry, color: number) {
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

// 葉の塊：頂点を少しずらしてでこぼこにし、下ほど暗く上ほど明るくする（立体感）
function blob(r: number, sy: number, x: number, y: number, z: number, seed: number, detail = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail).toNonIndexed();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  // 同じ位置の頂点は同じだけずらす（すき間ができないように）
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const k = 1 + (hash2(Math.round(vx * 10) + seed, Math.round(vy * 10) * 7 + Math.round(vz * 10) * 13, 5) - 0.5) * 0.28;
    p.setXYZ(i, vx * k + x, vy * k * sy + y, vz * k + z);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  const n = p.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (p.getY(i) - (y - r * sy)) / (2 * r * sy)));
    const v = 0.62 + 0.55 * t;
    col.set([v, v, v * 0.96], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// 遠くから見るときの軽い形（塊1つ）
function broadleafFar() {
  const trunk = colored(new THREE.CylinderGeometry(0.2, 0.32, 3.4, 4).translate(0, 1.7, 0), 0x5a4330);
  return mergeGeometries([trunk.toNonIndexed(), blob(2.6, 1.1, 0, 4.7, 0, 1)])!;
}
function coniferFar() {
  const trunk = colored(new THREE.CylinderGeometry(0.16, 0.28, 2, 4).translate(0, 1, 0), 0x5a4330);
  const g = new THREE.ConeGeometry(2.1, 7.5, 6).translate(0, 5.2, 0).toNonIndexed();
  g.deleteAttribute('uv');
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const v = 0.6 + 0.5 * ((p.getY(i) - 1.45) / 7.5); col.set([v, v, v * 0.96], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return mergeGeometries([trunk.toNonIndexed(), g])!;
}

function broadleafGeo() {
  const trunk = colored(new THREE.CylinderGeometry(0.18, 0.32, 3.4, 5).translate(0, 1.7, 0), 0x5a4330);
  // 大きな塊を中心に、小さな塊を2つ重ねる
  const parts = [blob(2.3, 1.05, 0, 4.7, 0, 1), blob(1.6, 1.0, 1.3, 4.1, 0.6, 2), blob(1.5, 1.0, -1.1, 5.4, -0.7, 3)];
  return mergeGeometries([trunk.toNonIndexed(), ...parts])!;
}
function coniferGeo() {
  const trunk = colored(new THREE.CylinderGeometry(0.16, 0.28, 2, 5).translate(0, 1, 0), 0x5a4330);
  // 3段の円すい（下ほど広く、暗い）
  const tiers: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const r = 2.3 - k * 0.6, h = 3.6 - k * 0.5, y = 2.2 + k * 1.9 + h / 2;
    const g = new THREE.ConeGeometry(r, h, 7).translate(0, y, 0).toNonIndexed();
    g.deleteAttribute('uv');
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) - (y - h / 2)) / h;
      const v = 0.6 + 0.25 * k + 0.25 * t;
      col.set([v, v, v * 0.96], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    tiers.push(g);
  }
  return mergeGeometries([trunk.toNonIndexed(), ...tiers])!;
}

// 木は 24×24 マスの区画ごとに分けて描く（画面の外の区画は描かない）。
// 遠くから見るときは、形を簡単にし、本数を間引く
const CHUNK = 24;

export class TreeLayer {
  group = new THREE.Group();
  private near = [broadleafGeo(), coniferGeo()];
  private far = [broadleafFar(), coniferFar()];
  private mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private chunks: { meshes: THREE.InstancedMesh[]; totals: number[] }[] = [];
  private lodFar = false;
  private keep = 1;
  private shadows = true;

  // ズームに合わせて、木の形の細かさと本数を切り替える
  setLod(dist: number) {
    const far = dist > 450;
    const keep = dist > 2600 ? 0.1 : dist > 1800 ? 0.16 : dist > 1100 ? 0.3 : dist > 700 ? 0.55 : 1;
    const shadows = dist < 600;
    if (far === this.lodFar && keep === this.keep && shadows === this.shadows) return;
    this.lodFar = far;
    this.keep = keep;
    this.shadows = shadows;
    for (const c of this.chunks)
      c.meshes.forEach((m, k) => {
        m.geometry = (far ? this.far : this.near)[k];
        m.count = Math.ceil(c.totals[k] * keep);
        m.castShadow = shadows;
      });
  }

  rebuild(g: Grid, extra: TreeSpot[]) {
    const n = g.n;
    for (const c of this.chunks) for (const m of c.meshes) { this.group.remove(m); m.dispose(); }
    this.chunks = [];
    const cn = Math.ceil(n / CHUNK);
    // 区画ごとに [種類][行列とシード]
    const lists: { m: number[]; seed: number[] }[][] = Array.from({ length: cn * cn }, () => [{ m: [], seed: [] }, { m: [], seed: [] }]);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3(), sc = new THREE.Vector3();
    const put = (kind: number, x: number, y: number, z: number, s: number, seed: number) => {
      const cx = Math.min(cn - 1, Math.max(0, Math.floor(x / CELL / CHUNK))), cz = Math.min(cn - 1, Math.max(0, Math.floor(z / CELL / CHUNK)));
      const L = lists[cz * cn + cx][kind];
      if (L.seed.length >= MAX_TREES) return;
      q.setFromAxisAngle(up, seed * 6.28);
      mtx.compose(v.set(x, y, z), q, sc.set(s, s * (0.85 + seed * 0.3), s));
      L.m.push(...mtx.elements);
      L.seed.push(seed);
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
    // 街路樹：まっすぐな一般道・一方通行・大通り・街路の歩道に、街灯と1マスずつ交互に植える
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (!((x + y) & 1)) continue;
        const i = y * n + x;
        const t = g.road[i];
        if (!(t === RoadType.Street || t === RoadType.Road || t === RoadType.OneWay || t === RoadType.Avenue)) continue;
        if (g.up[i] || g.deck[i] > 0 || g.lift[i] > 0.3 || g.bstop[i] || g.rail[i]) continue;
        const m = g.conn[i];
        const ew = m === ((1 << 0) | (1 << 4)) || m === (1 << 0) || m === (1 << 4);
        const ns = m === ((1 << 2) | (1 << 6)) || m === (1 << 2) || m === (1 << 6);
        if (!ew && !ns) continue;
        const off = ROADS[t].width / 2 + (t === RoadType.Street ? 0.85 : 1.0);
        for (const sd of [-1, 1]) {
          // 横のマスが道路（大通りの反対車線など）なら、そちらには植えない
          const ox = ew ? 0 : sd, oy = ew ? sd : 0;
          if (g.inb(x + ox, y + oy) && g.road[(y + oy) * n + x + ox]) continue;
          const hs = hash2(x * 3 + sd, y * 7, 11);
          if (hs < 0.15) continue;
          const wx = (x + 0.5) * CELL + ox * off, wz = (y + 0.5) * CELL + oy * off;
          put(0, wx, g.roadH(i) + 0.45, wz, 0.5 + hs * 0.15, hs);
        }
      }
    // 広葉樹は明るい緑から黄緑、針葉樹は濃い緑
    const greens = [0x4f7a32, 0x5d8a3a, 0x3f6b2b, 0x6a9443, 0x56803a, 0x7a9a3c, 0x4a7040, 0x8a9a44, 0x5e7f2f, 0x6f8a36].map((c) => new THREE.Color(c));
    const darkGreens = [0x2f5a32, 0x3a6338, 0x2c4f2e, 0x355c3c, 0x41663a].map((c) => new THREE.Color(c));
    const col = new THREE.Color();
    for (const L of lists) {
      if (!L[0].seed.length && !L[1].seed.length) continue;
      const meshes: THREE.InstancedMesh[] = [];
      const totals: number[] = [];
      L.forEach((list, kind) => {
        const cnt = list.seed.length;
        const m = new THREE.InstancedMesh((this.lodFar ? this.far : this.near)[kind], this.mat, Math.max(1, cnt));
        // 間引くときに場所が偏らないよう、並びを混ぜる（シードの順）
        const order = list.seed.map((_, k) => k).sort((a2, b2) => ((list.seed[a2] * 7919) % 1) - ((list.seed[b2] * 7919) % 1));
        order.forEach((src, k) => {
          mtx.fromArray(list.m, src * 16);
          m.setMatrixAt(k, mtx);
          const sd = list.seed[src];
          col.copy(kind === 0 ? greens[Math.floor(sd * 97) % greens.length] : darkGreens[Math.floor(sd * 89) % darkGreens.length]);
          m.setColorAt(k, col);
        });
        m.computeBoundingSphere();
        if (m.boundingSphere) m.boundingSphere.radius += 12;
        m.count = Math.ceil(cnt * this.keep);
        m.castShadow = this.shadows;
        m.receiveShadow = true;
        this.group.add(m);
        meshes.push(m);
        totals.push(cnt);
      });
      this.chunks.push({ meshes, totals });
    }
  }
}
