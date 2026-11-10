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
  curtain: 7, // 全面ガラス（カーテンウォール）：細い縦の窓枠と、階ごとの帯
  ribbon: 8, // 横長の連続窓：明るい帯とガラスが交互
  balcony: 9, // 高層マンション：床の帯、ガラスの手すり、奥の窓
  fullglass: 10, // ほぼガラスだけの外壁（極細の窓枠と、階ごとの細い線）
  glow: 11, // 夜に光る帯（頂部のライトアップ）
  lit: 12, // 夜に照明で明るくなる面（スタジアムのフィールド）。色はそのまま明るくなる
  led: 13, // 夜に色がゆっくり変わる LED の面（光の冠）
  // 庭の石や木（夜は灯籠やライトアップの明かりに照らされる）
  garden: 14,
  // 庭の地面：面の座標 (u, v) = (苔の割合, 小石の割合)
  gardenGround: 15,
  // 刈り込みの木や松の葉の房（細かい房のむら）
  gardenLeaf: 16,
  // 夜にともる面（灯籠の火袋、行灯の紙）
  gardenGlow: 17,
  // 畑（町はずれの田園）：面の座標 (u, v) = (畝の向きの角度[rad], 作物の番号)。畝や轍は世界の座標で描く
  field: 18,
} as const;

// 庭の模様（石・地面・葉・灯籠）なら、上の面にも「庭の石や木」の模様をつける（窓の模様などは上の面にはつけない）
const gardenPat = (p: number) => (p >= PAT.garden && p <= PAT.gardenGlow ? PAT.garden : 0);

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

  // 敷地の座標を世界の座標に直す（煙や炎などの動くものの位置を決めるときに使う）
  world(x: number, y: number, z: number): [number, number, number] {
    return [x * this.cos - z * this.sin + this.tx, y + this.ty, x * this.sin + z * this.cos + this.tz];
  }

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
    this.pat.push(this.abandoned && p > 0 ? p + 20 : p);
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

  // 4頂点の面（反時計回り）。頂点ごとの色（地面の色のむらをなめらかにつなぐ）。素材は mat、面の座標はすべての頂点で (u, v)
  quadC(
    a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number],
    ca: THREE.Color, cb: THREE.Color, cc: THREE.Color, cd: THREE.Color, mat: number, pat = 0, u = 0, v = 0,
  ) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.curMat = mat;
    const i0 = this.vtx(...a, nx, ny, nz, ca, u, v, pat);
    const i1 = this.vtx(...b, nx, ny, nz, cb, u, v, pat);
    const i2 = this.vtx(...c, nx, ny, nz, cc, u, v, pat);
    const i3 = this.vtx(...d, nx, ny, nz, cd, u, v, pat);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  // 4頂点の面（反時計回り）。頂点ごとの法線（曲面をなめらかに見せる）
  quadN(
    a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number],
    na: [number, number, number], nb: [number, number, number], nc: [number, number, number], nd: [number, number, number],
    color: THREE.Color, pat = 0, uw = 0, vh = 0, u0 = 0, v0 = 0,
  ) {
    this.curMat = this.autoMat((na[1] + nb[1] + nc[1] + nd[1]) / 4, color, pat);
    const i0 = this.vtx(...a, ...na, color, u0, v0, pat);
    const i1 = this.vtx(...b, ...nb, color, u0 + uw, v0, pat);
    const i2 = this.vtx(...c, ...nc, color, u0 + uw, v0 + vh, pat);
    const i3 = this.vtx(...d, ...nd, color, u0, v0 + vh, pat);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  // 半球のドーム（中心 cx, cz、根元の高さ y、半径 r、高さ h）。なめらかな法線
  dome(cx: number, cz: number, y: number, r: number, h: number, color: THREE.Color, seg = 32, rings = 10) {
    for (let k = 0; k < rings; k++) {
      const t0 = (k / rings) * Math.PI / 2, t1 = ((k + 1) / rings) * Math.PI / 2;
      const r0 = Math.cos(t0) * r, r1 = Math.cos(t1) * r, y0 = y + Math.sin(t0) * h, y1 = y + Math.sin(t1) * h;
      for (let sg = 0; sg < seg; sg++) {
        const a0 = (sg / seg) * Math.PI * 2, a1 = ((sg + 1) / seg) * Math.PI * 2;
        const P = (a: number, rr: number, yy: number): [number, number, number] => [cx + Math.cos(a) * rr, yy, cz + Math.sin(a) * rr];
        // 楕円体の法線
        const N = (a: number, t: number): [number, number, number] => {
          const nx = (Math.cos(t) / r) * Math.cos(a), ny = Math.sin(t) / h, nz = (Math.cos(t) / r) * Math.sin(a);
          const l = Math.hypot(nx, ny, nz) || 1;
          return [nx / l, ny / l, nz / l];
        };
        this.quadN(P(a1, r0, y0), P(a0, r0, y0), P(a0, r1, y1), P(a1, r1, y1), N(a1, t0), N(a0, t0), N(a0, t1), N(a1, t1), color);
      }
    }
  }

  tri(a: [number, number, number], b: [number, number, number], c: [number, number, number], color: THREE.Color, pat = 0) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.curMat = this.autoMat(ny, color, pat);
    const i0 = this.vtx(...a, nx, ny, nz, color, 0, 0, pat);
    const i1 = this.vtx(...b, nx, ny, nz, color, 0, 0, pat);
    const i2 = this.vtx(...c, nx, ny, nz, color, 0, 0, pat);
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
    // 上（庭の石や木は、上の面も夜の明かりに照らされる）
    const tp = gardenPat(pat);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], r, tp);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], r, tp);
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
      // なめらかな法線（側面の傾きも入れる）
      const h = y1 - y0, dr = r - r1;
      const N = (a: number): [number, number, number] => { const l = Math.hypot(h, dr) || 1; return [(Math.cos(a) * h) / l, dr / l, (Math.sin(a) * h) / l]; };
      this.quadN(p1, p0, p3, p2, N(a1), N(a0), N(a0), N(a1), color);
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
      if (n >= 12) {
        // 角の多い柱（丸い塔）は、中心から外向きの法線でなめらかに見せる
        // 頂点の法線 = となりの2つの辺の外向きの法線の平均（角の丸い四角でも、まっすぐな壁は平らに見える）
        const en = (k: number): [number, number] => { const k2 = (k + 1) % n, ex = b[k2][0] - b[k][0], ez = b[k2][1] - b[k][1], l = Math.hypot(ex, ez) || 1; return [ez / l, -ex / l]; };
        const nI = (k: number): [number, number, number] => { const [ax, az] = en((k + n - 1) % n), [bx2, bz2] = en(k); let x = ax + bx2, z = az + bz2; const l = Math.hypot(x, z) || 1; x /= l; z /= l; const dx = b[k][0] - cx, dz = b[k][1] - cz; if (x * dx + z * dz < 0) { x = -x; z = -z; } return [x, 0, z]; };
        this.quadN([b[i][0], y0, b[i][1]], [b[j][0], y0, b[j][1]], [t[j][0], yj, t[j][1]], [t[i][0], yi, t[i][1]], nI(i), nI(j), nI(j), nI(i), wall, pat, len, Math.max(yi, yj) - y0, u, 0);
      } else this.quad([b[i][0], y0, b[i][1]], [b[j][0], y0, b[j][1]], [t[j][0], yj, t[j][1]], [t[i][0], yi, t[i][1]], wall, pat, len, Math.max(yi, yj) - y0, u, 0);
      u += len;
    }
    if (roof === null) return;
    const rc = roof ?? wall;
    let tx = 0, tz = 0, tyc = 0;
    for (let i = 0; i < n; i++) { tx += t[i][0] / n; tz += t[i][1] / n; tyc += (ty ? ty[i] : y1) / n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.tri([tx, tyc, tz], [t[i][0], ty ? ty[i] : y1, t[i][1]], [t[j][0], ty ? ty[j] : y1, t[j][1]], rc, gardenPat(pat));
    }
  }

  // 地面の板
  ground(x0: number, z0: number, x1: number, z1: number, y: number, color: THREE.Color) {
    const keep = this.matOverride;
    this.matOverride = MAT.ground;
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], color);
    this.matOverride = keep;
  }

  // 地面の板（4つの角で色を変え、なめらかにつなぐ）。色は角 (x0,z0), (x1,z0), (x1,z1), (x0,z1) の順
  groundGrad(x0: number, z0: number, x1: number, z1: number, y: number, c00: THREE.Color, c10: THREE.Color, c11: THREE.Color, c01: THREE.Color) {
    this.curMat = MAT.ground;
    const i0 = this.vtx(x0, y, z1, 0, 1, 0, c01, 0, 0, 0);
    const i1 = this.vtx(x1, y, z1, 0, 1, 0, c11, 0, 0, 0);
    const i2 = this.vtx(x1, y, z0, 0, 1, 0, c10, 0, 0, 0);
    const i3 = this.vtx(x0, y, z0, 0, 1, 0, c00, 0, 0, 0);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  // 格子の面（頂点を共有する）。nx×nz マス、頂点は (nx+1)×(nz+1) 個で k = j*(nx+1)+i の順。
  // P = 位置、N = 法線（3つずつ）、Cl = 色（3つずつ）、U = 面の座標（2つずつ）。keep(i, j) が false のマスは描かない
  gridSurface(nx: number, nz: number, P: Float32Array, N: Float32Array, Cl: Float32Array, U: Float32Array, pat: number, mat: number, keep: (i: number, j: number) => boolean) {
    const base = this.pos.length / 3;
    this.curMat = mat;
    const col = new THREE.Color();
    const nv = (nx + 1) * (nz + 1);
    for (let k = 0; k < nv; k++) {
      col.setRGB(Cl[k * 3], Cl[k * 3 + 1], Cl[k * 3 + 2]);
      this.vtx(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], N[k * 3], N[k * 3 + 1], N[k * 3 + 2], col, U[k * 2], U[k * 2 + 1], pat);
    }
    const V = (i: number, j: number) => j * (nx + 1) + i;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        if (!keep(i, j)) continue;
        const a = V(i, j + 1), b = V(i + 1, j + 1), c = V(i + 1, j), d = V(i, j);
        // 対角線は高さの差が小さい方で切る（尾根や谷の線がなめらかになる）
        if (Math.abs(P[a * 3 + 1] - P[c * 3 + 1]) <= Math.abs(P[b * 3 + 1] - P[d * 3 + 1])) this.idx.push(base + a, base + b, base + c, base + a, base + c, base + d);
        else this.idx.push(base + b, base + c, base + d, base + b, base + d, base + a);
      }
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
