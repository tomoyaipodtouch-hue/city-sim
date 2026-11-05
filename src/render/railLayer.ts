// 鉄道・高架鉄道・モノレール・地下鉄の線路の描画
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, WATER_LEVEL } from '../sim/constants';
import { CIVIC, CivicId, LINES, LineKind } from '../sim/defs';
import type { Building } from '../sim/world';
import { Buf, ROAD_LIFT } from './roadLayer';
import { estopGroup } from '../sim/plan';
import { addBridgeStructures } from './bridgeStyles';

const COL = {
  ballast: new THREE.Color(0x8a8378),
  sleeper: new THREE.Color(0x5b4634),
  steel: new THREE.Color(0xc9ccd1),
  concrete: new THREE.Color(0xb5b1a8),
  beam: new THREE.Color(0xd6d3cc),
  tube: new THREE.Color(0xff8a3d),
  slab: new THREE.Color(0xa7a59f), // スラブ軌道の板
  deck: new THREE.Color(0xc4c1b9),
  pad: new THREE.Color(0x6f6c66),
  barrierGlass: new THREE.Color(0x9cc9d4), // ガラスの防音壁
  barrierFrame: new THREE.Color(0x8d969c),
  pole: new THREE.Color(0x9aa1a7),
  wire: new THREE.Color(0x2c2f33),
};

interface P {
  x: number;
  z: number;
  h: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// 複線の、中心から片側の線路までの距離（m）
export const TRACK_GAP = 2.1;

export class RailLayer {
  group = new THREE.Group();
  private solid: THREE.Mesh;
  private underground: THREE.Mesh;
  private glass: THREE.Mesh; // ガラスの防音壁（半透明）
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
    this.glass = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide }));
    this.group.add(this.solid, this.underground, this.glass);
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
    // 高架（高架鉄道・モノレール）が水の上を渡るときは、両岸の高さを結んだ高さにする（川の上だけ低くならないように）
    if (g.isWater(i % n, (i / n) | 0)) {
      const banks = RailLayer.banks(g, kind, i);
      if (banks) return Math.max(ground, banks) + LINES[kind].lift;
    }
    return ground + LINES[kind].lift;
  }

  // 水の上の線路から、線路に沿って両側の岸まで進み、岸の高さを距離で内分した値を返す（岸が見つからなければ null）
  private static banks(g: Grid, kind: LineKind, i: number): number | null {
    const mask = g[kind], n = g.n;
    const ends: { h: number; d: number }[] = [];
    for (let d0 = 0; d0 < 8; d0++) {
      if (!(mask[i] & (1 << d0))) continue;
      let cur = i, dir = d0, dist = 0;
      for (let step = 0; step < 64; step++) {
        const x = cur % n + DX[dir], y = ((cur / n) | 0) + DY[dir];
        if (!g.inb(x, y)) break;
        const j = y * n + x;
        if (!mask[j]) break;
        dist += dir & 1 ? 1.41 : 1;
        cur = j;
        if (!g.isWater(x, y)) { ends.push({ h: g.cellH(x, y), d: dist }); break; }
        // まっすぐ進めなければ、来た向き以外のつながりへ
        if (!(mask[j] & (1 << dir))) {
          let nd = -1;
          for (let k = 0; k < 8; k++) if (mask[j] & (1 << k) && k !== ((dir + 4) & 7)) { nd = k; break; }
          if (nd < 0) break;
          dir = nd;
        }
      }
      if (ends.length >= 2) break;
    }
    if (ends.length >= 2) return ends[0].h + (ends[1].h - ends[0].h) * (ends[0].d / (ends[0].d + ends[1].d));
    return ends.length === 1 ? ends[0].h : null;
  }

  // stationCells：駅のホームがあるマス（防音壁を開ける）
  rebuild(g: Grid, stationCells: Set<number> = new Set()) {
    const n = g.n, N = n * n;
    const B = new Buf(), U = new Buf(), G = new Buf();
    // 向きのついた箱（中心 cx, cz、u = 線路の向き）
    const obox = (cx: number, cz: number, ux: number, uz: number, a0: number, a1: number, o0: number, o1: number, y0: number, y1: number, c: THREE.Color) => {
      const px = -uz, pz = ux;
      const P = (a: number, o: number) => [cx + ux * a + px * o, cz + uz * a + pz * o];
      const q = [P(a0, o0), P(a1, o0), P(a1, o1), P(a0, o1)];
      for (let k = 0; k < 4; k++) {
        const [x0, z0] = q[k], [x1, z1] = q[(k + 1) % 4];
        B.wall(x0, z0, y0, y1, x1, z1, y0, y1, c);
      }
      const t = q.map(([x, z]) => B.v(x, y1, z, c));
      B.tri(t[0], t[1], t[2]);
      B.tri(t[0], t[2], t[3]);
    };

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
    const sides = (pts: P[], half: number, y0: number, y1: number, c: THREE.Color, off = 0, buf: Buf = B) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
        const px = -dz / l, pz = dx / l;
        for (const s of [-1, 1]) {
          const o = off + s * half;
          buf.wall(a.x + px * o, a.z + pz * o, a.h + y0, a.h + y1, b.x + px * o, b.z + pz * o, b.h + y0, b.h + y1, c);
        }
      }
    };
    // 枕木（off = 線路の中心の横のずれ）
    const sleepers = (pts: P[], dy: number, off = 0) => {
      let acc = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
        if (l < 1e-3) continue;
        const ux = dx / l, uz = dz / l, px = -uz, pz = ux;
        for (let s = (0.8 - (acc % 0.8)) % 0.8; s < l; s += 0.8) {
          const cx = a.x + ux * s, cz = a.z + uz * s, h = lerp(a.h, b.h, s / l) + dy;
          const q = [[-0.13, off - 1.3], [0.13, off - 1.3], [0.13, off + 1.3], [-0.13, off + 1.3]].map(([f, o]) => B.v(cx + ux * f + px * o, h, cz + uz * f + pz * o, COL.sleeper));
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
          // 複線：上り線と下り線を、中心から左右に TRACK_GAP ずつずらして並べる
          const T = TRACK_GAP;
          if (kind === 'sub') {
            strip(U, pts, -T, 3.2, 0, COL.tube);
            strip(U, pts, T, 3.2, 0, COL.tube);
            continue;
          }
          if (kind === 'rail') {
            if (!g.road[i]) {
              strip(B, pts, 0, 9.0, 0.05, COL.ballast);
              sides(pts, 4.5, -0.4, 0.05, COL.ballast);
              sleepers(pts, 0.12, -T);
              sleepers(pts, 0.12, T);
            }
            for (const o of [-T, T]) {
              strip(B, pts, o - 0.72, 0.14, 0.3, COL.steel);
              strip(B, pts, o + 0.72, 0.14, 0.3, COL.steel);
            }
          } else if (kind === 'erail') {
            // 床版（厚みのある側面）
            strip(B, pts, 0, 9.6, 0, COL.deck);
            sides(pts, 4.8, -1.4, 0.6, COL.concrete);
            // スラブ軌道：コンクリートの板と、その上のレール
            for (const o of [-T, T]) {
              strip(B, pts, o, 2.5, 0.18, COL.slab);
              sides(pts, 1.25, 0, 0.18, COL.pad, o);
              strip(B, pts, o - 0.72, 0.16, 0.36, COL.steel);
              strip(B, pts, o + 0.72, 0.16, 0.36, COL.steel);
            }
            // ガラスの防音壁（駅のホームのところは開ける）
            if (!stationCells.has(i)) {
              sides(pts, 4.75, 0.6, 2.6, COL.barrierGlass, 0, G);
              sides(pts, 4.75, 2.6, 2.8, COL.barrierFrame);
              strip(B, pts, -4.75, 0.25, 2.8, COL.barrierFrame);
              strip(B, pts, 4.75, 0.25, 2.8, COL.barrierFrame);
            }
            // 架線（上り・下りの上に細い線）
            for (const o of [-T, T]) strip(B, pts, o, 0.07, 6.0, COL.wire);
          } else {
            // モノレール：コンクリートの桁（軌道けた）を2本
            for (const o of [-T, T]) {
              strip(B, pts, o, 0.9, 0, COL.beam);
              sides(pts, 0.45, -1.5, 0, COL.beam, o);
            }
          }
        }
        if (kind === 'erail') {
          // 線路の向き（まっすぐつながる向きを優先）
          let d = -1;
          for (let k = 0; k < 4; k++) if (m & (1 << k) && m & (1 << (k + 4))) { d = k; break; }
          if (d < 0) for (let k = 0; k < 8; k++) if (m & (1 << k)) { d = k & 3; break; }
          const len = Math.hypot(DX[d], DY[d]);
          const ux = DX[d] / len, uz = DY[d] / len;
          if (ch - ground > 2 && !(g.bstyle[i] && g.isWater(x, y))) {
            // ラーメン高架橋：左右2本の柱と横の梁。下が道路なら、柱は歩道の外側に
            const wide = g.road[i] !== 0;
            const co = wide ? 6.9 : 3.3, bh = ch - 1.4;
            for (const s of [-1, 1]) obox(cx, cz, ux, uz, -0.55, 0.55, s * co - 0.55, s * co + 0.55, ground - 0.5, bh, COL.concrete);
            obox(cx, cz, ux, uz, -0.6, 0.6, -co - 0.6, co + 0.6, bh - 1.1, bh, COL.concrete);
          }
          // 架線柱（2マスおきの門型）
          if ((x + y) % 2 === 0) {
            const top = ch + 6.6;
            for (const s of [-1, 1]) obox(cx, cz, ux, uz, -0.18, 0.18, s * 5.15 - 0.18, s * 5.15 + 0.18, ch + 0.6, top, COL.pole);
            obox(cx, cz, ux, uz, -0.14, 0.14, -5.3, 5.3, top - 0.35, top, COL.pole);
            for (const o of [-TRACK_GAP, TRACK_GAP]) obox(cx, cz, ux, uz, -0.05, 0.05, o - 0.05, o + 0.05, ch + 6.0, top - 0.35, COL.wire);
          }
        }
        if (kind === 'mono' && ch - ground > 2) {
          // T字の柱の上に、2本の桁を載せる
          B.box(cx - 0.6, ground - 0.5, cz - 0.6, cx + 0.6, ch - 2.4, cz + 0.6, COL.beam);
          B.box(cx - TRACK_GAP - 0.7, ch - 2.4, cz - TRACK_GAP - 0.7, cx + TRACK_GAP + 0.7, ch - 1.5, cz + TRACK_GAP + 0.7, COL.beam);
        }
      }
    }
    // 川を渡る高架鉄道の橋（情報ツールで選んだ形）
    addBridgeStructures(g, B, 0, { height: (c) => RailLayer.lineH(g, 'erail', c) });
    for (const [mesh, buf] of [[this.solid, B], [this.underground, U], [this.glass, G]] as const) {
      mesh.geometry.dispose();
      mesh.geometry = buf.geometry();
    }
  }
}

// ---------------- 駅のホーム ----------------
// 駅に接する線路のマスに、上り・下りの両側のホーム、屋根、跨線橋を作る

const PC = {
  slab: new THREE.Color(0xc9c5bc),
  edge: new THREE.Color(0xf0c419),
  roof: new THREE.Color(0x6d7781),
  post: new THREE.Color(0x8f969c),
  bridge: new THREE.Color(0xd9dcdf),
  glass: new THREE.Color(0x8fb4c9),
  hallWall: new THREE.Color(0xeeeeea),
  hallGlass: new THREE.Color(0x6f93ab),
  hallBand: new THREE.Color(0x2f86d0),
};

export class StationLayer {
  mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  constructor() {
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  rebuild(g: Grid, list: Building[]) {
    const B = new Buf();
    const n = g.n;
    // 向きのついた箱：中心 (cx, cz)、u = 線路の向き、p = 横の向き。a0..a1 は u 方向、o0..o1 は p 方向
    const obox = (cx: number, cz: number, ux: number, uz: number, a0: number, a1: number, o0: number, o1: number, y0: number, y1: number, c: THREE.Color) => {
      const px = -uz, pz = ux;
      const P = (a: number, o: number) => [cx + ux * a + px * o, cz + uz * a + pz * o];
      const q = [P(a0, o0), P(a1, o0), P(a1, o1), P(a0, o1)];
      for (let k = 0; k < 4; k++) {
        const [x0, z0] = q[k], [x1, z1] = q[(k + 1) % 4];
        B.wall(x0, z0, y0, y1, x1, z1, y0, y1, c);
      }
      const t = q.map(([x, z]) => B.v(x, y1, z, c));
      B.tri(t[0], t[1], t[2]);
      B.tri(t[0], t[2], t[3]);
    };
    // 駅：敷地のある駅（まわりの線路にホーム）と、線路の上だけの高架駅
    const groups: { kind: LineKind; cells: number[]; bx: number; bz: number; trackOnly: boolean }[] = [];
    for (const b of list) {
      if (!b.civic) continue;
      const kind = CIVIC[b.type as CivicId].transit;
      if (!kind || kind === 'bus' || kind === 'sub') continue;
      const mask = g[kind];
      const cells: number[] = [];
      for (let y = b.y - 1; y <= b.y + b.h; y++)
        for (let x = b.x - 1; x <= b.x + b.w; x++) if (g.inb(x, y) && mask[g.idx(x, y)]) cells.push(g.idx(x, y));
      if (cells.length) groups.push({ kind, cells, bx: (b.x + b.w / 2) * CELL, bz: (b.y + b.h / 2) * CELL, trackOnly: false });
    }
    {
      const seen = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) {
        if (!g.estn[i] || seen[i] || !g.erail[i]) continue;
        const cells = estopGroup(g, i).filter((c) => g.erail[c]);
        for (const c of cells) seen[c] = 1;
        const mid = cells[Math.min(1, cells.length - 1)];
        groups.push({ kind: 'erail', cells, bx: ((mid % n) + 0.5) * CELL, bz: (((mid / n) | 0) + 0.5) * CELL, trackOnly: true });
      }
    }
    for (const { kind, cells, bx, bz, trackOnly } of groups) {
      const mask = g[kind];
      // 跨線橋は、駅舎にいちばん近いマスに置く
      let bridgeCell = cells[0], bd = Infinity;
      for (const c of cells) {
        const d = Math.hypot(((c % n) + 0.5) * CELL - bx, (((c / n) | 0) + 0.5) * CELL - bz);
        if (d < bd) { bd = d; bridgeCell = c; }
      }
      for (const c of cells) {
        const m = mask[c];
        // 線路の向き：まっすぐつながる向きを優先
        let d = -1;
        for (let k = 0; k < 4; k++) if (m & (1 << k) && m & (1 << (k + 4))) { d = k; break; }
        if (d < 0) for (let k = 0; k < 8; k++) if (m & (1 << k)) { d = k & 3; break; }
        if (d < 0) continue;
        const len = Math.hypot(DX[d], DY[d]);
        const ux = DX[d] / len, uz = DY[d] / len;
        const cx = ((c % n) + 0.5) * CELL, cz = (((c / n) | 0) + 0.5) * CELL;
        const H = RailLayer.lineH(g, kind, c);
        const half = (CELL * len) / 2;
        const ground = Math.max(g.cellH(c % n, (c / n) | 0), WATER_LEVEL);
        const top = H + 1.1;
        const elevated = H - ground > 2;
        for (const s of [-1, 1]) {
          const o0 = s * 3.75, o1 = s * 6.7;
          const lo = Math.min(o0, o1), hi = Math.max(o0, o1);
          obox(cx, cz, ux, uz, -half, half, lo, hi, elevated ? top - 0.5 : ground - 0.5, top, PC.slab);
          // 黄色の線（点字ブロック）
          const e0 = s * 4.1, e1 = s * 4.45;
          obox(cx, cz, ux, uz, -half, half, Math.min(e0, e1), Math.max(e0, e1), top, top + 0.03, PC.edge);
          // 屋根と柱
          for (const a of [-half * 0.5, half * 0.5]) obox(cx, cz, ux, uz, a - 0.15, a + 0.15, s * 5.9 - 0.15, s * 5.9 + 0.15, top, top + 3.4, PC.post);
          const r0 = s * 3.9, r1 = s * 6.9;
          obox(cx, cz, ux, uz, -half, half, Math.min(r0, r1), Math.max(r0, r1), top + 3.4, top + 3.6, PC.roof);
        }
        if (elevated && trackOnly && g.road[c]) {
          // 道路の上の駅：高架下は道路のまま。ホームの外側に、歩道へ降りる階段の塔と、柱だけ
          for (const a of [-half * 0.7, half * 0.7]) for (const s of [-1, 1]) obox(cx, cz, ux, uz, a - 0.4, a + 0.4, s * 5.6 - 0.4, s * 5.6 + 0.4, ground, top - 0.5, PC.hallWall);
          if (c === bridgeCell) {
            for (const s of [-1, 1]) {
              const o0 = s * 6.7, o1 = s * 9.3;
              obox(cx, cz, ux, uz, -3.5, 3.5, Math.min(o0, o1), Math.max(o0, o1), ground, top + 0.2, PC.hallWall);
              obox(cx, cz, ux, uz, -3.3, 3.3, Math.min(o0, o1) + 0.1, Math.max(o0, o1) - 0.1, ground + 0.3, ground + 3.0, PC.hallGlass);
              obox(cx, cz, ux, uz, -3.6, 3.6, Math.min(o0, o1) - 0.1, Math.max(o0, o1) + 0.1, top + 0.2, top + 0.6, PC.hallBand);
            }
          }
        } else if (elevated) {
          // 高架下の駅舎：線路の真下に、ガラスの1階と白い壁、色の帯。ホームの床までを1つのかたまりにする
          const hallTop = top - 0.5;
          obox(cx, cz, ux, uz, -half, half, -6.6, 6.6, ground - 0.5, ground + 0.4, PC.slab);
          obox(cx, cz, ux, uz, -half, half, -6.4, 6.4, ground + 0.4, ground + 3.8, PC.hallGlass);
          // 線路の下は床版の下まで、ホームの下はホームの床まで
          obox(cx, cz, ux, uz, -half, half, -3.7, 3.7, ground + 3.8, H - 1.3, PC.hallWall);
          for (const s of [-1, 1]) obox(cx, cz, ux, uz, -half, half, Math.min(s * 3.7, s * 6.7), Math.max(s * 3.7, s * 6.7), ground + 3.8, hallTop, PC.hallWall);
          obox(cx, cz, ux, uz, -half, half, -6.75, 6.75, ground + 4.4, ground + 4.9, PC.hallBand);
          // 1階の柱（ガラスの区切り）
          for (const a of [-half * 0.66, 0, half * 0.66]) for (const s of [-1, 1]) obox(cx, cz, ux, uz, a - 0.25, a + 0.25, s * 6.45 - 0.2, s * 6.45 + 0.2, ground + 0.4, ground + 3.8, PC.hallWall);
          // 入口のひさし（駅前広場の側）
          if (c === bridgeCell && !trackOnly) {
            const side = Math.sign((bx - cx) * -uz + (bz - cz) * ux) || 1;
            const o0 = side * 6.7, o1 = side * 9.6;
            obox(cx, cz, ux, uz, -4, 4, Math.min(o0, o1), Math.max(o0, o1), ground + 3.6, ground + 3.9, PC.roof);
            obox(cx, cz, ux, uz, -3.2, 3.2, side * 6.72 - 0.05, side * 6.72 + 0.05, ground + 4.9, ground + 6.0, PC.hallBand);
          }
        }
        if (c === bridgeCell && !elevated) {
          // 跨線橋：両側のホームの階段の塔と、線路をまたぐ通路
          const by = top + 6.0;
          obox(cx, cz, ux, uz, -1.3, 1.3, -7.0, 7.0, by, by + 2.4, PC.bridge);
          obox(cx, cz, ux, uz, -1.32, 1.32, -6.9, 6.9, by + 0.9, by + 1.8, PC.glass);
          for (const s of [-1, 1]) obox(cx, cz, ux, uz, -1.3, 1.3, s * 5.3 - 1.1, s * 5.3 + 1.1, top, by + 2.4, PC.bridge);
        }
      }
    }
    this.mesh.geometry.dispose();
    this.mesh.geometry = B.geometry();
  }
}
