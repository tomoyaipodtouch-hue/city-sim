// 鉄道・高架鉄道・モノレール・地下鉄の線路の描画
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, WATER_LEVEL } from '../sim/constants';
import { LINES, LineKind } from '../sim/defs';
import { Buf, ROAD_LIFT } from './roadLayer';

const COL = {
  ballast: new THREE.Color(0x8a8378),
  sleeper: new THREE.Color(0x5b4634),
  steel: new THREE.Color(0xc9ccd1),
  concrete: new THREE.Color(0xb5b1a8),
  beam: new THREE.Color(0xd6d3cc),
  tube: new THREE.Color(0xff8a3d),
};

interface P {
  x: number;
  z: number;
  h: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class RailLayer {
  group = new THREE.Group();
  private solid: THREE.Mesh;
  private underground: THREE.Mesh;
  showSubway = false;

  constructor() {
    this.solid = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    this.solid.castShadow = true;
    this.solid.receiveShadow = true;
    // 地下鉄は、地下の画面のときだけ地面の上に透かして描く
    this.underground = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.underground.renderOrder = 10;
    this.underground.visible = false;
    this.group.add(this.solid, this.underground);
  }

  setUnderground(on: boolean) {
    this.showSubway = on;
    this.underground.visible = on;
  }

  // 線路の高さ（マスの中心）
  static lineH(g: Grid, kind: LineKind, i: number) {
    const n = g.n;
    const ground = Math.max(g.cellH(i % n, (i / n) | 0), WATER_LEVEL);
    if (kind === 'rail') return g.road[i] ? g.roadH(i) + ROAD_LIFT : ground + 0.1;
    return ground + LINES[kind].lift;
  }

  rebuild(g: Grid) {
    const n = g.n, N = n * n;
    const B = new Buf(), U = new Buf();

    // 中心線に沿った帯（off = 中心からの横のずれ、w = 幅、dy = 高さのずれ）
    const strip = (buf: Buf, pts: P[], off: number, w: number, dy: number, c: THREE.Color) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
        const px = -dz / l, pz = dx / l;
        const o0 = off - w / 2, o1 = off + w / 2;
        const i0 = buf.v(a.x + px * o0, a.h + dy, a.z + pz * o0, c), i1 = buf.v(a.x + px * o1, a.h + dy, a.z + pz * o1, c);
        const i2 = buf.v(b.x + px * o1, b.h + dy, b.z + pz * o1, c), i3 = buf.v(b.x + px * o0, b.h + dy, b.z + pz * o0, c);
        buf.tri(i0, i1, i2);
        buf.tri(i0, i2, i3);
      }
    };
    // 帯の両側の縦の面
    const sides = (pts: P[], half: number, y0: number, y1: number, c: THREE.Color) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
        const px = -dz / l, pz = dx / l;
        for (const s of [-1, 1]) B.wall(a.x + s * px * half, a.z + s * pz * half, a.h + y0, a.h + y1, b.x + s * px * half, b.z + s * pz * half, b.h + y0, b.h + y1, c);
      }
    };
    // 枕木
    const sleepers = (pts: P[], dy: number) => {
      let acc = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
        if (l < 1e-3) continue;
        const ux = dx / l, uz = dz / l, px = -uz, pz = ux;
        for (let s = (0.8 - (acc % 0.8)) % 0.8; s < l; s += 0.8) {
          const cx = a.x + ux * s, cz = a.z + uz * s, h = lerp(a.h, b.h, s / l) + dy;
          const q = [[-0.13, -1.3], [0.13, -1.3], [0.13, 1.3], [-0.13, 1.3]].map(([f, o]) => B.v(cx + ux * f + px * o, h, cz + uz * f + pz * o, COL.sleeper));
          B.tri(q[0], q[1], q[2]);
          B.tri(q[0], q[2], q[3]);
        }
        acc += l;
      }
    };

    for (const kind of ['rail', 'erail', 'mono', 'sub'] as const) {
      const mask = g[kind];
      for (let i = 0; i < N; i++) {
        const m = mask[i];
        if (!m) continue;
        const x = i % n, y = (i / n) | 0;
        const cx = (x + 0.5) * CELL, cz = (y + 0.5) * CELL;
        const ch = kind === 'sub' ? g.cellH(x, y) + 0.6 : RailLayer.lineH(g, kind, i);
        const arms: { d: number; ex: number; ez: number; eh: number }[] = [];
        for (let d = 0; d < 8; d++) {
          if (!(m & (1 << d))) continue;
          const nx = x + DX[d], ny = y + DY[d];
          const j = ny * n + nx;
          const nh = g.inb(nx, ny) ? (kind === 'sub' ? g.cellH(nx, ny) + 0.6 : RailLayer.lineH(g, kind, j)) : ch;
          arms.push({ d, ex: cx + (DX[d] * CELL) / 2, ez: cz + (DY[d] * CELL) / 2, eh: (ch + nh) / 2 });
        }
        // 2本で向きが違えば曲線、それ以外は中心から腕ごとにまっすぐ
        const paths: P[][] = [];
        if (arms.length === 2 && ((arms[0].d + 4) & 7) !== arms[1].d) {
          const [a, b] = arms;
          const pts: P[] = [];
          for (let s = 0; s <= 8; s++) {
            const u = s / 8, p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
            pts.push({ x: p0 * a.ex + p1 * cx + p2 * b.ex, z: p0 * a.ez + p1 * cz + p2 * b.ez, h: p0 * a.eh + p1 * ch + p2 * b.eh });
          }
          paths.push(pts);
        } else for (const a of arms) paths.push([{ x: cx, z: cz, h: ch }, { x: a.ex, z: a.ez, h: a.eh }]);
        const ground = g.cellH(x, y);
        for (const pts of paths) {
          if (kind === 'sub') {
            strip(U, pts, 0, 4.5, 0, COL.tube);
            continue;
          }
          if (kind === 'rail') {
            if (!g.road[i]) {
              strip(B, pts, 0, 4.6, 0.05, COL.ballast);
              sides(pts, 2.3, -0.4, 0.05, COL.ballast);
              sleepers(pts, 0.12);
            }
            strip(B, pts, -0.72, 0.14, 0.3, COL.steel);
            strip(B, pts, 0.72, 0.14, 0.3, COL.steel);
          } else if (kind === 'erail') {
            strip(B, pts, 0, 5.4, 0, COL.concrete);
            sides(pts, 2.7, -1.1, 0.9, COL.concrete);
            sleepers(pts, 0.1);
            strip(B, pts, -0.72, 0.14, 0.28, COL.steel);
            strip(B, pts, 0.72, 0.14, 0.28, COL.steel);
          } else {
            // モノレール：コンクリートの桁（軌道けた）
            strip(B, pts, 0, 0.9, 0, COL.beam);
            sides(pts, 0.45, -1.5, 0, COL.beam);
          }
        }
        // 橋脚（マスの中心に1本）
        if (kind === 'erail' && ch - ground > 2) B.box(cx - 0.8, ground - 0.5, cz - 0.8, cx + 0.8, ch - 1.1, cz + 0.8, COL.concrete);
        if (kind === 'mono' && ch - ground > 2) {
          B.box(cx - 0.6, ground - 0.5, cz - 0.6, cx + 0.6, ch - 2.4, cz + 0.6, COL.beam);
          B.box(cx - 1.1, ch - 2.4, cz - 1.1, cx + 1.1, ch - 1.5, cz + 1.1, COL.beam);
        }
      }
    }
    for (const [mesh, buf] of [[this.solid, B], [this.underground, U]] as const) {
      mesh.geometry.dispose();
      mesh.geometry = buf.geometry();
    }
  }
}
