// ツールのプレビュー（マスの色分け）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';

const MAX = 128 * 128;

export class PreviewLayer {
  mesh: THREE.InstancedMesh;
  line: THREE.Line;
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
  }

  setTiles(g: Grid, cells: number[], colorOf: (i: number) => number) {
    const n = g.n;
    const c = new THREE.Color();
    let k = 0;
    for (const i of cells) {
      if (k >= MAX) break;
      const x = i % n, y = (i / n) | 0;
      this.mtx.makeTranslation((x + 0.5) * CELL, g.cellMaxH(x, y) + 0.7, (y + 0.5) * CELL);
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
    const pts = cells.map((i) => new THREE.Vector3(((i % n) + 0.5) * CELL, g.cellH(i % n, (i / n) | 0) + 1.2, (((i / n) | 0) + 0.5) * CELL));
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  clear() {
    this.mesh.count = 0;
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry();
  }
}
