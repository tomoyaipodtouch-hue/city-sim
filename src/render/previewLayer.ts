// ツールのプレビュー（マスの色分け、線、車線の向きの矢印）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY } from '../sim/constants';

const MAX = 256 * 256;
const MAX_ARROWS = 1024;

export interface PreviewArrow {
  cell: number;
  dir: number; // 8方向
}

export class PreviewLayer {
  mesh: THREE.InstancedMesh;
  line: THREE.Line;
  arrows: THREE.InstancedMesh;
  private mtx = new THREE.Matrix4();

  constructor() {
    const geo = new THREE.PlaneGeometry(CELL - 1.2, CELL - 1.2).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false, depthTest: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0;
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color());
    this.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.line.renderOrder = 6;
    this.line.frustumCulled = false;
    // 車線の向きの矢印（+x 向きの「＞」形。地面に寝かせる）
    const s = CELL * 0.22;
    const shape = new THREE.Shape();
    shape.moveTo(s, 0);
    shape.lineTo(-s * 0.7, s * 0.85);
    shape.lineTo(-s * 0.25, 0);
    shape.lineTo(-s * 0.7, -s * 0.85);
    shape.closePath();
    const ageo = new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);
    this.arrows = new THREE.InstancedMesh(ageo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false, depthTest: false, side: THREE.DoubleSide }), MAX_ARROWS);
    this.arrows.count = 0;
    this.arrows.renderOrder = 7;
    this.arrows.frustumCulled = false;
    this.arrows.setColorAt(0, new THREE.Color());
    this.line.add(this.arrows); // シーンには line といっしょに入る
  }

  setTiles(g: Grid, cells: number[], colorOf: (i: number) => number) {
    const n = g.n;
    const c = new THREE.Color();
    let k = 0;
    for (const i of cells) {
      if (k >= MAX) break;
      const x = i % n, y = (i / n) | 0;
      this.mtx.makeTranslation((x + 0.5) * CELL, Math.max(g.cellMaxH(x, y), g.deck[i] || 0, 0) + 0.7, (y + 0.5) * CELL);
      this.mesh.setMatrixAt(k, this.mtx);
      c.setHex(colorOf(i));
      this.mesh.setColorAt(k, c);
      k++;
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setPath(g: Grid, cells: number[]) {
    const n = g.n;
    this.setLine(cells.map((i) => new THREE.Vector3(((i % n) + 0.5) * CELL, Math.max(g.roadH(i), 0) + 1.2, (((i / n) | 0) + 0.5) * CELL)));
  }

  // 格子点（マスの角）を結ぶ線。大通りの中心線
  setGridLine(g: Grid, pts: [number, number][]) {
    const n = g.n;
    const at = (x: number, y: number) => Math.max(g.vh(Math.max(0, Math.min(n, x)), Math.max(0, Math.min(n, y))), 0);
    const out: THREE.Vector3[] = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
      const steps = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let s = k ? 1 : 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps), y = Math.round(y0 + ((y1 - y0) * s) / steps);
        out.push(new THREE.Vector3(x * CELL, at(x, y) + 1.2, y * CELL));
      }
    }
    this.setLine(out);
  }

  setLineColor(hex: number) {
    (this.line.material as THREE.LineBasicMaterial).color.setHex(hex);
  }

  setLine(pts: THREE.Vector3[]) {
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  // 車線の向きの矢印
  setArrows(g: Grid, list: PreviewArrow[], color: number) {
    const n = g.n;
    const c = new THREE.Color(color);
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    let k = 0;
    for (const a of list) {
      if (k >= MAX_ARROWS) break;
      const x = a.cell % n, y = (a.cell / n) | 0;
      p.set((x + 0.5) * CELL, Math.max(g.cellMaxH(x, y), g.deck[a.cell] || 0, 0) + 1.0, (y + 0.5) * CELL);
      q.setFromAxisAngle(up, -Math.atan2(DY[a.dir], DX[a.dir]));
      this.mtx.compose(p, q, sc);
      this.arrows.setMatrixAt(k, this.mtx);
      this.arrows.setColorAt(k, c);
      k++;
    }
    this.arrows.count = k;
    this.arrows.instanceMatrix.needsUpdate = true;
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
  }

  clear() {
    this.mesh.count = 0;
    this.arrows.count = 0;
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry();
  }
}
