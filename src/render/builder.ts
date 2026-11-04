// 建物などの形を組み立てるための簡単なジオメトリビルダー
import * as THREE from 'three';
import { MAT } from './textures';

// 模様の番号（シェーダーで窓などを描く）
export const PAT = {
  none: 0,
  house: 1,
  shop: 2,
  office: 3,
  industrial: 4,
  apartment: 5,
  dock: 6,
} as const;

export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uvm: number[] = [];
  pat: number[] = [];
  mat: number[] = [];
  idx: number[] = [];
  // 素材（textures.ts の MAT）。null なら面の向き・模様・色から自動で選ぶ
  matOverride: number | null = null;
  flatRoofMat: number = MAT.membrane;
  slopeRoofMat: number = MAT.shingle;

  // 変換（Y軸まわりの回転と平行移動）
  private cos = 1;
  private sin = 0;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  abandoned = false;

  setTransform(angle: number, tx: number, ty: number, tz: number) {
    this.cos = Math.cos(angle);
    this.sin = Math.sin(angle);
    this.tx = tx;
    this.ty = ty;
    this.tz = tz;
  }

  // 面の素材を自動で選ぶ
  private autoMat(ny: number, c: THREE.Color, p: number) {
    if (this.matOverride !== null) return this.matOverride;
    if (ny > 0.95) return this.flatRoofMat;
    if (ny > 0.2) return this.slopeRoofMat;
    if (ny < -0.5) return MAT.none;
    if (c.r > c.g * 1.3 && c.r > c.b * 1.45 && c.r > 0.12) return MAT.brick;
    const lum = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
    switch (p) {
      case PAT.industrial: return MAT.metal;
      case PAT.house: return lum > 0.45 ? MAT.siding : MAT.plaster;
      case PAT.office: return MAT.none; // ガラスの壁
      case PAT.apartment: case PAT.shop: return lum > 0.5 ? MAT.plaster : MAT.concrete;
      default: return MAT.plaster;
    }
  }

  private curMat = 0;
  private vtx(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color, u: number, v: number, p: number) {
    const { cos, sin } = this;
    this.pos.push(x * cos - z * sin + this.tx, y + this.ty, x * sin + z * cos + this.tz);
    this.nor.push(nx * cos - nz * sin, ny, nx * sin + nz * cos);
    const k = this.abandoned ? 0.62 : 1;
    this.col.push(c.r * k, c.g * k, c.b * k);
    this.uvm.push(u, v);
    this.pat.push(this.abandoned && p > 0 ? p + 10 : p);
    this.mat.push(this.curMat);
    return this.pos.length / 3 - 1;
  }

  // 4頂点の面（反時計回り）
  quad(
    a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number],
    color: THREE.Color, pat = 0, uw = 0, vh = 0, u0 = 0, v0 = 0,
  ) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.curMat = this.autoMat(ny, color, pat);
    const i0 = this.vtx(...a, nx, ny, nz, color, u0, v0, pat);
    const i1 = this.vtx(...b, nx, ny, nz, color, u0 + uw, v0, pat);
    const i2 = this.vtx(...c, nx, ny, nz, color, u0 + uw, v0 + vh, pat);
    const i3 = this.vtx(...d, nx, ny, nz, color, u0, v0 + vh, pat);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  tri(a: [number, number, number], b: [number, number, number], c: [number, number, number], color: THREE.Color) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.curMat = this.autoMat(ny, color, 0);
    const i0 = this.vtx(...a, nx, ny, nz, color, 0, 0, 0);
    const i1 = this.vtx(...b, nx, ny, nz, color, 0, 0, 0);
    const i2 = this.vtx(...c, nx, ny, nz, color, 0, 0, 0);
    this.idx.push(i0, i1, i2);
  }

  // 直方体。壁に模様、上面は roof の色。
  box(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    wall: THREE.Color, pat: number = PAT.none, roof?: THREE.Color, bottom = false,
  ) {
    const r = roof || wall;
    const h = y1 - y0;
    const wx = x1 - x0, wz = z1 - z0;
    // 南（+z）
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], wall, pat, wx, h);
    // 北（-z）
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], wall, pat, wx, h);
    // 東（+x）
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], wall, pat, wz, h);
    // 西（-x）
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], wall, pat, wz, h);
    // 上
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], r, 0);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], r, 0);
  }

  // 切妻屋根（棟は x 方向）
  gableX(x0: number, z0: number, x1: number, z1: number, y: number, rise: number, color: THREE.Color, gableWall: THREE.Color, overhang = 0.4) {
    const zm = (z0 + z1) / 2;
    const ox0 = x0 - overhang, ox1 = x1 + overhang, oz0 = z0 - overhang, oz1 = z1 + overhang;
    const yt = y + rise;
    const drop = (rise * overhang) / ((z1 - z0) / 2);
    this.quad([ox0, y - drop, oz1], [ox1, y - drop, oz1], [ox1, yt, zm], [ox0, yt, zm], color);
    this.quad([ox1, y - drop, oz0], [ox0, y - drop, oz0], [ox0, yt, zm], [ox1, yt, zm], color);
    this.tri([x1, y, z1], [x1, y, z0], [x1, yt, zm], gableWall);
    this.tri([x0, y, z0], [x0, y, z1], [x0, yt, zm], gableWall);
  }

  // 寄棟屋根
  hip(x0: number, z0: number, x1: number, z1: number, y: number, rise: number, color: THREE.Color, overhang = 0.4) {
    x0 -= overhang; z0 -= overhang; x1 += overhang; z1 += overhang;
    const w = x1 - x0, d = z1 - z0;
    const yt = y + rise;
    if (w >= d) {
      const inset = d / 2;
      const zm = (z0 + z1) / 2;
      this.quad([x0, y, z1], [x1, y, z1], [x1 - inset, yt, zm], [x0 + inset, yt, zm], color);
      this.quad([x1, y, z0], [x0, y, z0], [x0 + inset, yt, zm], [x1 - inset, yt, zm], color);
      this.tri([x1, y, z1], [x1, y, z0], [x1 - inset, yt, zm], color);
      this.tri([x0, y, z0], [x0, y, z1], [x0 + inset, yt, zm], color);
    } else {
      const inset = w / 2;
      const xm = (x0 + x1) / 2;
      this.quad([x1, y, z1], [x1, y, z0], [xm, yt, z0 + inset], [xm, yt, z1 - inset], color);
      this.quad([x0, y, z0], [x0, y, z1], [xm, yt, z1 - inset], [xm, yt, z0 + inset], color);
      this.tri([x0, y, z1], [x1, y, z1], [xm, yt, z1 - inset], color);
      this.tri([x1, y, z0], [x0, y, z0], [xm, yt, z0 + inset], color);
    }
  }

  // 円柱（側面のみ＋上面）
  cylinder(cx: number, cz: number, y0: number, y1: number, r: number, seg: number, color: THREE.Color, top?: THREE.Color, r1 = r) {
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const p0: [number, number, number] = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r];
      const p1: [number, number, number] = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
      const p2: [number, number, number] = [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1];
      const p3: [number, number, number] = [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1];
      this.quad(p1, p0, p3, p2, color);
      if (top) this.tri([cx, y1, cz], p2, p3, top);
    }
  }

  // 凸多角形の柱（base の各頂点 [x, z]）。top を渡すと上の形を変えられる（先細りなど）。
  // topY を渡すと上面の高さを頂点ごとに変えられる（斜めに切った屋上）
  prism(
    base: [number, number][], y0: number, y1: number, wall: THREE.Color, pat: number = PAT.none, roof?: THREE.Color | null,
    top?: [number, number][], topY?: number[],
  ) {
    const n = base.length;
    let t = top ?? base;
    let b = base;
    let ty = topY;
    // 外向きの順番にそろえる
    let cx = 0, cz = 0;
    for (const [x, z] of b) { cx += x / n; cz += z / n; }
    const [ax, az] = b[0], [bx, bz] = b[1];
    const dx = bx - ax, dz = bz - az, mx = (ax + bx) / 2 - cx, mz = (az + bz) / 2 - cz;
    if (-dz * mx + dx * mz < 0) {
      b = [...b].reverse();
      t = [...t].reverse();
      if (ty) ty = [...ty].reverse();
    }
    let u = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const len = Math.hypot(b[j][0] - b[i][0], b[j][1] - b[i][1]);
      const yi = ty ? ty[i] : y1, yj = ty ? ty[j] : y1;
      this.quad([b[i][0], y0, b[i][1]], [b[j][0], y0, b[j][1]], [t[j][0], yj, t[j][1]], [t[i][0], yi, t[i][1]], wall, pat, len, Math.max(yi, yj) - y0, u, 0);
      u += len;
    }
    if (roof === null) return;
    const rc = roof ?? wall;
    let tx = 0, tz = 0, tyc = 0;
    for (let i = 0; i < n; i++) { tx += t[i][0] / n; tz += t[i][1] / n; tyc += (ty ? ty[i] : y1) / n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.tri([tx, tyc, tz], [t[i][0], ty ? ty[i] : y1, t[i][1]], [t[j][0], ty ? ty[j] : y1, t[j][1]], rc);
    }
  }

  // 地面の板
  ground(x0: number, z0: number, x1: number, z1: number, y: number, color: THREE.Color) {
    const keep = this.matOverride;
    this.matOverride = MAT.ground;
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], color);
    this.matOverride = keep;
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aUvm', new THREE.Float32BufferAttribute(this.uvm, 2));
    g.setAttribute('aPat', new THREE.Float32BufferAttribute(this.pat, 1));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 1));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
