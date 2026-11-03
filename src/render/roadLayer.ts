// 道路と送電線の描画
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY } from '../sim/constants';
import { ROADS } from '../sim/defs';

// 道路のテクスチャ（左から 通り / 一般道 / 一方通行・大通り）
export const ROAD_STYLES = 4;
export function roadStyle(t: number) {
  return t === 1 ? 0 : t === 2 ? 1 : t === 5 || t === 6 ? 3 : 2;
}
function roadTexture(): THREE.CanvasTexture {
  const part = 128, W = part * ROAD_STYLES, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  for (let side = 0; side < ROAD_STYLES; side++) {
    const x0 = side * part;
    ctx.fillStyle = '#4a4c50';
    ctx.fillRect(x0, 0, part, H);
    // 路面のざらつき
    for (let k = 0; k < 500; k++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.05)`;
      ctx.fillRect(x0 + Math.random() * part, Math.random() * H, 2, 2);
    }
    const sw = side === 0 ? 0.13 : 0.12; // 歩道の幅（割合）
    ctx.fillStyle = '#b9b6ad';
    ctx.fillRect(x0, 0, part * sw, H);
    ctx.fillRect(x0 + part * (1 - sw), 0, part * sw, H);
    ctx.fillStyle = '#7d7b76';
    ctx.fillRect(x0 + part * sw - 2, 0, 2, H);
    ctx.fillRect(x0 + part * (1 - sw), 0, 2, H);
    if (side === 1) {
      // 中央の黄色い二重線と外側の白線
      ctx.fillStyle = '#e8c33a';
      ctx.fillRect(x0 + part / 2 - 3, 0, 2, H);
      ctx.fillRect(x0 + part / 2 + 1, 0, 2, H);
    }
    if (side >= 1) {
      ctx.fillStyle = '#e6e6e0';
      ctx.fillRect(x0 + part * sw + 3, 0, 1.5, H);
      ctx.fillRect(x0 + part * (1 - sw) - 4.5, 0, 1.5, H);
    }
    if (side === 2) {
      // 車線の境界の白い破線
      ctx.fillStyle = '#e6e6e0';
      for (let y = 0; y < H; y += 32) ctx.fillRect(x0 + part / 2 - 1, y, 2, 16);
    }
    if (side === 3) {
      // 高速道路：歩道の代わりにコンクリートの壁と路肩
      ctx.fillStyle = '#44464a';
      ctx.fillRect(x0, 0, part, H);
      ctx.fillStyle = '#c9c6bf';
      ctx.fillRect(x0, 0, part * 0.07, H);
      ctx.fillRect(x0 + part * 0.93, 0, part * 0.07, H);
      ctx.fillStyle = '#e8e8e2';
      ctx.fillRect(x0 + part * 0.13, 0, 2, H);
      ctx.fillRect(x0 + part * 0.87 - 2, 0, 2, H);
      for (let y = 0; y < H; y += 32) ctx.fillRect(x0 + part / 2 - 1, y, 2, 18);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const ROAD_LIFT = 0.3;

export class RoadLayer {
  group = new THREE.Group();
  private mesh: THREE.Mesh;
  private patches: THREE.Mesh;
  private poles: THREE.Mesh;
  private wires: THREE.LineSegments;
  private bridges: THREE.Mesh;
  private signals: THREE.Mesh;
  private islands: THREE.Mesh;
  jctl: Uint8Array = new Uint8Array(0); // 交差点の制御方式（シミュレーションで決まったもの）
  private mat: THREE.MeshLambertMaterial;

  constructor() {
    this.mat = new THREE.MeshLambertMaterial({ map: roadTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.receiveShadow = true;
    const pmat = new THREE.MeshLambertMaterial({ map: this.mat.map, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
    this.patches = new THREE.Mesh(new THREE.BufferGeometry(), pmat);
    this.patches.receiveShadow = true;
    this.poles = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x6b5b4a }));
    this.poles.castShadow = true;
    this.wires = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.7 }));
    this.bridges = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0xb3afa6 }));
    this.bridges.castShadow = true;
    this.bridges.receiveShadow = true;
    this.signals = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x3a3d40 }));
    this.signals.castShadow = true;
    this.islands = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x5f8f44, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
    this.group.add(this.mesh, this.patches, this.poles, this.wires, this.bridges, this.signals, this.islands);
  }

  static centerH(g: Grid, i: number) {
    return g.roadH(i) + ROAD_LIFT;
  }

  rebuild(g: Grid) {
    const n = g.n;
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    const PP: number[] = [], PN: number[] = [], PU: number[] = [], PI: number[] = [];
    const BP: number[] = [], BN: number[] = [], BI: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const base = BP.length / 3;
      BP.push(...a, ...b, ...c, ...d);
      for (let k = 0; k < 4; k++) BN.push(nx, ny, nz);
      BI.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2);
    };
    // 中心(c)から中間点(e)までの半分の橋。p は幅の半分のベクトル。
    const bridge = (cx: number, cz: number, ch: number, ex: number, ez: number, eh: number, px: number, pz: number, pier: boolean, bot = -6) => {
      const k = 1.25, th = 1.2;
      const L = [cx - px * k, cz - pz * k], R = [cx + px * k, cz + pz * k];
      const EL = [ex - px * k, ez - pz * k], ER = [ex + px * k, ez + pz * k];
      // 床版の側面と底
      quad([L[0], ch - 0.05, L[1]], [EL[0], eh - 0.05, EL[1]], [EL[0], eh - th, EL[1]], [L[0], ch - th, L[1]]);
      quad([R[0], ch - 0.05, R[1]], [ER[0], eh - 0.05, ER[1]], [ER[0], eh - th, ER[1]], [R[0], ch - th, R[1]]);
      quad([L[0], ch - th, L[1]], [EL[0], eh - th, EL[1]], [ER[0], eh - th, ER[1]], [R[0], ch - th, R[1]]);
      // 欄干
      quad([L[0], ch, L[1]], [EL[0], eh, EL[1]], [EL[0], eh + 1.0, EL[1]], [L[0], ch + 1.0, L[1]]);
      quad([R[0], ch, R[1]], [ER[0], eh, ER[1]], [ER[0], eh + 1.0, ER[1]], [R[0], ch + 1.0, R[1]]);
      // 橋脚（マスの中心に1本）
      if (pier) {
        const s = 1.1;
        const px2 = cx, pz2 = cz;
        quad([px2 - s, bot, pz2 + s], [px2 + s, bot, pz2 + s], [px2 + s, ch - th, pz2 + s], [px2 - s, ch - th, pz2 + s]);
        quad([px2 + s, bot, pz2 - s], [px2 - s, bot, pz2 - s], [px2 - s, ch - th, pz2 - s], [px2 + s, ch - th, pz2 - s]);
        quad([px2 + s, bot, pz2 + s], [px2 + s, bot, pz2 - s], [px2 + s, ch - th, pz2 - s], [px2 + s, ch - th, pz2 + s]);
        quad([px2 - s, bot, pz2 - s], [px2 - s, bot, pz2 + s], [px2 - s, ch - th, pz2 + s], [px2 - s, ch - th, pz2 - s]);
      }
    };
    const SP: number[] = [], SN: number[] = [], SI: number[] = []; // 信号
    const GP: number[] = [], GN: number[] = [], GI: number[] = []; // ラウンドアバウトの中央の島
    const boxInto = (Pa: number[], Na: number[], Ia: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      const faces: [number[], number[]][] = [
        [[0, 0, 1], [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]],
        [[0, 0, -1], [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0]],
        [[1, 0, 0], [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1]],
        [[-1, 0, 0], [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0]],
        [[0, 1, 0], [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0]],
      ];
      for (const [nrm, v] of faces) {
        const base = Pa.length / 3;
        Pa.push(...v);
        for (let k = 0; k < 4; k++) Na.push(...nrm);
        Ia.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    };
    const NC = n * n;
    for (let node = 0; node < 2 * NC; node++) {
      const level = node >= NC ? 1 : 0;
      const i = node - level * NC;
      const t = level ? g.up[i] : g.road[i];
      if (!t) continue;
      const x = i % n, y = (i / n) | 0;
      const cx = (x + 0.5) * CELL, cz = (y + 0.5) * CELL;
      const ch = g.nodeH(node) + ROAD_LIFT;
      const def = ROADS[t];
      const w = def.width;
      const su = 1 / ROAD_STYLES;
      const u0 = roadStyle(t) * su;
      const m = level ? g.conn1[i] : g.conn[i];
      const ground = g.cellH(x, y);
      let deg = 0;
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d))) continue;
        deg++;
        const nx = x + DX[d], ny = y + DY[d];
        if (!g.inb(nx, ny)) continue;
        const j = ny * n + nx;
        const nl = g.arriveLevel(level, j, d);
        const nh = g.nodeH(nl * NC + j) + ROAD_LIFT;
        // 中心から中間点まで
        const ex = cx + (DX[d] * CELL) / 2, ez = cz + (DY[d] * CELL) / 2;
        const eh = (ch + nh) / 2;
        const len = Math.hypot(ex - cx, ez - cz);
        const dx = (ex - cx) / len, dz = (ez - cz) / len;
        const px = -dz * (w / 2), pz = dx * (w / 2);
        const b = P.length / 3;
        P.push(cx - px, ch, cz - pz, cx + px, ch, cz + pz, ex + px, eh, ez + pz, ex - px, eh, ez - pz);
        N.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
        const vlen = len / 8;
        U.push(u0, 0, u0 + su, 0, u0 + su, vlen, u0, vlen);
        // 橋・高架：路面の下の床版と欄干、橋脚
        if (level === 0 && g.deck[i] > 0) bridge(cx, cz, ch, ex, ez, eh, px, pz, d < 4);
        else if (level === 1) bridge(cx, cz, ch, ex, ez, eh, px, pz, d < 4 && ch - ground > 4, ground - 0.5);
        // 頂点の並びで表裏が変わるので、上向きになるように
        const cross = (P[b * 3 + 3] - P[b * 3]) * (P[b * 3 + 11] - P[b * 3 + 2]) - (P[b * 3 + 5] - P[b * 3 + 2]) * (P[b * 3 + 9] - P[b * 3]);
        if (cross < 0) I.push(b, b + 1, b + 2, b, b + 2, b + 3);
        else I.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
      // 交差点、曲がり角、行き止まりはつなぎ目を覆う
      const straight = deg === 2 && [0, 1, 2, 3].some((d) => (m & (1 << d)) && (m & (1 << (d + 4))));
      const ctl = level === 0 && this.jctl.length === NC ? this.jctl[i] : 0;
      if (!straight) {
        const r = ctl === 4 ? w * 0.75 : w / 2;
        const seg = ctl === 4 ? 16 : 8;
        const b = PP.length / 3;
        PP.push(cx, ch, cz);
        PN.push(0, 1, 0);
        const uc = u0 + su * 0.34; // 車線の線がない部分
        PU.push(uc, 0.5);
        for (let s = 0; s < seg; s++) {
          const a = (s / seg) * Math.PI * 2 + Math.PI / 8;
          PP.push(cx + Math.cos(a) * r * 1.08, ch, cz + Math.sin(a) * r * 1.08);
          PN.push(0, 1, 0);
          PU.push(uc + Math.cos(a) * su * 0.04, 0.5 + Math.sin(a) * 0.1);
        }
        for (let s = 0; s < seg; s++) PI.push(b, b + 1 + ((s + 1) % seg), b + 1 + s);
      }
      if (ctl === 3) {
        // 信号：対角の2つの角に柱と腕
        const o = w / 2 + 0.8;
        for (const [sx, sz] of [[1, 1], [-1, -1]]) {
          const px = cx + sx * o, pz = cz + sz * o;
          boxInto(SP, SN, SI, px - 0.15, ch, pz - 0.15, px + 0.15, ch + 5.6, pz + 0.15);
          boxInto(SP, SN, SI, Math.min(px, px - sx * 4), ch + 5.4, pz - 0.1, Math.max(px, px - sx * 4), ch + 5.6, pz + 0.1);
          boxInto(SP, SN, SI, px - sx * 3.2 - 0.3, ch + 4.6, pz - 0.3, px - sx * 3.2 + 0.3, ch + 5.4, pz + 0.3);
        }
      } else if (ctl === 4) {
        // ラウンドアバウトの中央の島
        const r = w * 0.32, seg = 12, h = ch + 0.35;
        const base = GP.length / 3;
        GP.push(cx, h, cz);
        GN.push(0, 1, 0);
        for (let s = 0; s < seg; s++) {
          const a = (s / seg) * Math.PI * 2;
          GP.push(cx + Math.cos(a) * r, h, cz + Math.sin(a) * r);
          GN.push(0, 1, 0);
        }
        for (let s = 0; s < seg; s++) GI.push(base, base + 1 + ((s + 1) % seg), base + 1 + s);
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(SP, 3));
    sg.setAttribute('normal', new THREE.Float32BufferAttribute(SN, 3));
    sg.setIndex(SI);
    this.signals.geometry.dispose();
    this.signals.geometry = sg;
    const ig = new THREE.BufferGeometry();
    ig.setAttribute('position', new THREE.Float32BufferAttribute(GP, 3));
    ig.setAttribute('normal', new THREE.Float32BufferAttribute(GN, 3));
    ig.setIndex(GI);
    this.islands.geometry.dispose();
    this.islands.geometry = ig;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    geo.setIndex(I);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(PP, 3));
    pg.setAttribute('normal', new THREE.Float32BufferAttribute(PN, 3));
    pg.setAttribute('uv', new THREE.Float32BufferAttribute(PU, 2));
    pg.setIndex(PI);
    this.patches.geometry.dispose();
    this.patches.geometry = pg;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(BP, 3));
    bg.setAttribute('normal', new THREE.Float32BufferAttribute(BN, 3));
    bg.setIndex(BI);
    this.bridges.geometry.dispose();
    this.bridges.geometry = bg;
    this.rebuildLines(g);
  }

  private rebuildLines(g: Grid) {
    const n = g.n;
    const P: number[] = [], NN: number[] = [], I: number[] = [];
    const W: number[] = [];
    const poleH = 11;
    const top = (i: number) => {
      const x = i % n, y = (i / n) | 0;
      return [(x + 0.5) * CELL + (g.road[i] ? 6.5 : 0), (g.road[i] ? g.roadH(i) : g.cellH(x, y)) + poleH, (y + 0.5) * CELL + (g.road[i] ? 6.5 : 0)];
    };
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      const faces: [number[], number[]][] = [
        [[0, 0, 1], [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]],
        [[0, 0, -1], [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0]],
        [[1, 0, 0], [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1]],
        [[-1, 0, 0], [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0]],
        [[0, 1, 0], [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0]],
      ];
      for (const [nrm, v] of faces) {
        const b = P.length / 3;
        P.push(...v);
        for (let k = 0; k < 4; k++) NN.push(...nrm);
        I.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    };
    for (let i = 0; i < n * n; i++) {
      if (!g.pline[i]) continue;
      const x = i % n, y = (i / n) | 0;
      const [tx, ty, tz] = top(i);
      // 2マスに1本の電柱（すべてのマスに置くと多すぎる）
      box(tx - 0.2, ty - poleH, tz - 0.2, tx + 0.2, ty, tz + 0.2);
      box(tx - 1.4, ty - 1.0, tz - 0.12, tx + 1.4, ty - 0.75, tz + 0.12);
      // 電線（右・下・斜めの隣とつなぐ）
      for (const d of [0, 1, 2, 3]) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!g.inb(nx, ny)) continue;
        const j = ny * n + nx;
        if (!g.pline[j]) continue;
        if (d === 1 && (g.pline[y * n + x + 1] || g.pline[(y + 1) * n + x])) continue;
        if (d === 3 && (g.pline[y * n + x - 1] || g.pline[(y + 1) * n + x])) continue;
        const [sx, sy, sz] = top(j);
        for (const off of [-1.2, 1.2]) W.push(tx + off, ty - 0.9, tz, sx + off, sy - 0.9, sz);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(NN, 3));
    geo.setIndex(I);
    this.poles.geometry.dispose();
    this.poles.geometry = geo;
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(W, 3));
    this.wires.geometry.dispose();
    this.wires.geometry = wg;
  }
}
