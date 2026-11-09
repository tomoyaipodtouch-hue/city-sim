// 橋の形（情報モードで橋をタップして選ぶ）。橋の路面の下や上に、形ごとの構造物を作る。
// 構造物は、道路のつながりから決めた橋の向き（道に沿った軸）にそろえ、床版の本当の幅に合わせる。
// 大通り（一方通行のマスが2本並ぶ）は、2本の車線で1枚の床版なので、構造物も2本の車線をまとめて1つにする。
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, WATER_LEVEL, isDiag, opp } from '../sim/constants';
import { ROADS, RoadType, isHighway } from '../sim/defs';
import { AV_SW, AV_SW_BRIDGE, AV_W, ROAD_LIFT, type Buf } from './roadLayer';
import { createInfraMaterial, matColor, PbrBuf, RM } from './infraMaterial';

export const BRIDGE_STYLES = ['桁橋', '吊り橋', '斜張橋', 'トラス橋', 'アーチ橋', 'ラーメン橋'] as const;

// 色と素材（PBR の粗さ・金属らしさ）
const STEEL = matColor(0xc8473c, RM.paintSteel); // 赤く塗った鋼のトラス
const WHITE = matColor(0xe8e6df, RM.whiteConc); // 斜張橋の白い主塔
const ARCH = matColor(0xe8e6df, RM.whiteSteel); // 白く塗った鋼のアーチ
const CABLE = matColor(0xd9d6cc, RM.cable);
const CONC = matColor(0xb3afa6, RM.concrete);
const TOWER = matColor(0xd4d0c6, RM.paintSteel); // 吊り橋の鋼の主塔
const GIRDER = matColor(0xc9c6bd, RM.whiteSteel); // 吊り橋・斜張橋の、床版の縁の桁

// 道路の橋の構造物（橋脚・主塔・ケーブル・トラスなど）。道路を作り直すたびに作り直す
export class BridgeLayer {
  mesh = new THREE.Mesh(new THREE.BufferGeometry(), createInfraMaterial());
  constructor() {
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }
  rebuild(g: Grid) {
    const B = new PbrBuf();
    addBridgeStructures(g, B, ROAD_LIFT);
    this.mesh.geometry.dispose();
    this.mesh.geometry = B.geometry();
  }
}

// 1つの橋（構造物をまとめて作る単位）。s は道に沿った長さ（橋の端から）、q は中心線からの横の位置（p の向きが +）
export interface BridgeFrame {
  cells: number[];
  t: number; // 道路の種類（鉄道は 0）
  d: number; // 道に沿った軸（0..3。鉄道は -1）
  sx: number; // 中心線の始まり（橋の端）
  sz: number;
  ux: number; // 道に沿った向き
  uz: number;
  px: number; // 横向き
  pz: number;
  L: number;
  e: number; // 2本の車線の中心の間隔の半分（1本の橋は 0）
  Wd: number; // 中心から床版の外側の縁まで
  gap: number; // まん中の、床版のない幅の半分（高速道路の2本の床版。大通りは 1枚なので 0）
  prof: [number, number][][]; // 横の -側・+側の路面の高さ（[s, 高さ] の並び）
  span: [number, number][]; // 横の -側・+側の床版のある範囲（s）
  Hc: number; // 橋の中ほどの路面の高さ
  T: number; // 路面から床版の下面まで（道路は roadLayer の床版の厚さ、鉄道は高架の桁の下まで）
}

// 床版の、車線の中心から外側の縁までの長さ（roadLayer の床版と同じ寸法）
// 大通り：車道 7m の半分と、橋の上の歩道 4m（立体交差は地上と同じ 4.5m）。高速道路：車道の半分と壁の 0.6m
function deckEdge(t: number, diag: boolean, level: number) {
  if (t === RoadType.Avenue) return AV_W / 2 + (level ? AV_SW : AV_SW_BRIDGE);
  const def = ROADS[t];
  let w = def?.width ?? 10;
  if (def?.wide && diag) w = Math.min(w, 10.7);
  const sw = t === RoadType.Street ? 1.7 : t === RoadType.Road || t === RoadType.OneWay ? 2.0 : 0.6;
  return w / 2 + sw;
}

// マスのつながりから、道に沿った軸（0..3：東西、南東、南北、南西）。つながりがなければ -1
function axisOf(m: number) {
  for (let d = 0; d < 4; d++) if (m & (1 << d) && m & (1 << (d + 4))) return d;
  for (let d = 0; d < 8; d++) if (m & (1 << d)) return d & 3;
  return -1;
}

// 橋（立体交差）の車線を読むための情報
interface LaneSrc {
  level: number; // 0：地上の道路（橋）、1：上空の道路（立体交差）
  ok: (i: number) => boolean;
  type: (i: number) => number;
  conn: Uint8Array;
  flow: Uint8Array;
  h: (i: number) => number; // 路面の高さ
}
// 道に沿ってまっすぐ並んだ、同じ種類の橋のマス（1本の車線）
interface Lane {
  cells: number[];
  t: number;
  d: number; // 軸
  fwd: number; // 流れの向き（0..7）
}

// 車線をまとめて橋にする。2マス幅の道路（大通り・高速道路）は、反対向きの車線と組にする。
// 右側通行なので、反対車線は進む向きの左側にある
function laneGroups(g: Grid, S: LaneSrc): Lane[][] {
  const n = g.n, N = n * n;
  const laneOf = new Int32Array(N).fill(-1);
  const lanes: Lane[] = [];
  const nb = (c: number, d: number) => {
    const x = (c % n) + DX[d], y = ((c / n) | 0) + DY[d];
    return g.inb(x, y) ? y * n + x : -1;
  };
  // c から向き dd へ、同じ車線が続くか
  const step = (c: number, dd: number, d: number) => {
    if (!(S.conn[c] & (1 << dd))) return -1;
    const j = nb(c, dd);
    return j >= 0 && laneOf[j] < 0 && S.ok(j) && S.type(j) === S.type(c) && axisOf(S.conn[j]) === d ? j : -1;
  };
  for (let i = 0; i < N; i++) {
    if (laneOf[i] >= 0 || !S.ok(i)) continue;
    const d = axisOf(S.conn[i]);
    const cells: number[] = [];
    if (d < 0) {
      cells.push(i);
      laneOf[i] = lanes.length;
    } else {
      // 後ろの端までたどってから、前へ並べる
      let s = i;
      for (let k = 0; k < n; k++) {
        const j = step(s, opp(d), d);
        if (j < 0 || j === i) break;
        s = j;
      }
      for (let c = s; c >= 0; c = step(c, d, d)) {
        cells.push(c);
        laneOf[c] = lanes.length;
      }
    }
    const dd = Math.max(0, d);
    let f = 0, b = 0;
    for (const c of cells) {
      if (S.flow[c] & (1 << dd)) f++;
      if (S.flow[c] & (1 << opp(dd))) b++;
    }
    lanes.push({ cells, t: S.type(i), d: dd, fwd: b > f ? opp(dd) : dd });
  }
  const meanH = (l: Lane) => l.cells.reduce((a, c) => a + S.h(c), 0) / l.cells.length;
  // 横（side 0：進む向きの左、1：右）で隣り合う、反対向きの車線（いちばん多く隣り合うもの）
  const twinOf = (a: number, side: number) => {
    const A = lanes[a];
    if (!ROADS[A.t]?.wide) return -1;
    const f = side ? opp(A.fwd) : A.fwd;
    const dirs = isDiag(f) ? [(f + 5) & 7, (f + 7) & 7] : [(f + 6) & 7];
    const votes = new Map<number, number>();
    for (const c of A.cells)
      for (const dd of dirs) {
        const j = nb(c, dd);
        const k = j >= 0 ? laneOf[j] : -1;
        if (k < 0 || k === a) continue;
        const B = lanes[k];
        if (B.t === A.t && B.d === A.d && B.fwd === opp(A.fwd)) votes.set(k, (votes.get(k) ?? 0) + 1);
      }
    let best = -1, bv = 0;
    for (const [k, v] of votes) if (v > bv) { best = k; bv = v; }
    return best;
  };
  const out: Lane[][] = [];
  const used = new Uint8Array(lanes.length);
  // おたがいに反対車線で、高さがほぼ同じなら1つの橋。右側通行なので、まず左側の車線と組にする。
  // 組にならなかった車線どうしは、右側でも組にする（古い保存データなどで向きが逆のとき）
  for (const side of [0, 1]) {
    const tw = lanes.map((_, a) => (used[a] ? -1 : twinOf(a, side)));
    for (let a = 0; a < lanes.length; a++) {
      const b = tw[a];
      if (used[a] || b < 0 || used[b] || tw[b] !== a || Math.abs(meanH(lanes[a]) - meanH(lanes[b])) >= 2.5) continue;
      used[a] = used[b] = 1;
      out.push([lanes[a], lanes[b]]);
    }
  }
  for (let a = 0; a < lanes.length; a++) if (!used[a]) out.push([lanes[a]]);
  return out;
}

// 車線の組から、橋の枠（軸・幅・路面の高さ）を作る
function laneFrame(g: Grid, S: LaneSrc, ls: Lane[], lift: number): BridgeFrame {
  const n = g.n, N = n * n;
  const d = ls[0].d, diag = isDiag(d);
  const len = diag ? Math.SQRT2 : 1;
  const ux = DX[d] / len, uz = DY[d] / len, px = -uz, pz = ux;
  const cx = (c: number) => ((c % n) + 0.5) * CELL, cz = (c: number) => (((c / n) | 0) + 0.5) * CELL;
  const along = (c: number) => cx(c) * ux + cz(c) * uz;
  const perp = (c: number) => cx(c) * px + cz(c) * pz;
  const qs = ls.map((l) => perp(l.cells[0]));
  const o = qs.reduce((a, b) => a + b, 0) / qs.length;
  const e = ls.length > 1 ? Math.abs(qs[0] - qs[1]) / 2 : 0;
  const hl = (CELL * len) / 2; // 半マス（道に沿って）
  let lo = Infinity, hi = -Infinity;
  for (const l of ls) for (const c of l.cells) { lo = Math.min(lo, along(c) - hl); hi = Math.max(hi, along(c) + hl); }
  // 車線の路面の高さ：マスの中心は橋の高さ、端は隣の陸のマスとの中間（roadLayer の床版と同じ）
  const profOf = (l: Lane): [number, number][] => {
    const cs = [...l.cells].sort((a, b) => along(a) - along(b));
    const endH = (c: number, dd: number) => {
      const x = (c % n) + DX[dd], y = ((c / n) | 0) + DY[dd];
      if (!g.inb(x, y)) return S.h(c);
      const j = y * n + x;
      const lv = g.arriveLevel(S.level, j, dd);
      if (!(lv ? g.up[j] : g.road[j])) return S.h(c);
      return (S.h(c) + g.nodeH(lv * N + j)) / 2;
    };
    // 道に沿って s の増える向きが d
    const pts: [number, number][] = [[along(cs[0]) - hl - lo, endH(cs[0], opp(d)) + lift]];
    for (const c of cs) pts.push([along(c) - lo, S.h(c) + lift]);
    pts.push([along(cs[cs.length - 1]) + hl - lo, endH(cs[cs.length - 1], d) + lift]);
    // 同じ高さが続くところは、まとめる
    return pts.filter((p, k) => k === 0 || k === pts.length - 1 || Math.abs(p[1] - pts[k - 1][1]) > 1e-3 || Math.abs(p[1] - pts[k + 1][1]) > 1e-3);
  };
  const profs = ls.map(profOf);
  const spans = ls.map((l) => {
    const ss = l.cells.map(along);
    return [Math.min(...ss) - hl - lo, Math.max(...ss) + hl - lo] as [number, number];
  });
  // 横の -側（q < 0）と +側
  const neg = ls.length > 1 && qs[1] < qs[0] ? 1 : 0;
  const pos = ls.length > 1 ? 1 - neg : 0;
  const cells = ls.flatMap((l) => l.cells);
  const Hc = cells.reduce((a, c) => a + S.h(c), 0) / cells.length + lift;
  const t = ls[0].t;
  const edge = deckEdge(t, diag, S.level);
  return {
    cells, t, d, sx: ux * lo + px * o, sz: uz * lo + pz * o, ux, uz, px, pz, L: hi - lo, e,
    Wd: e + edge, gap: t === RoadType.Avenue ? 0 : Math.max(0, e - edge),
    prof: [profs[neg], profs[pos]], span: [spans[neg], spans[pos]], Hc, T: 1.2,
  };
}

// 地上の道路の橋（deck > 0）を、道路の種類と向きごとにまとめる
export function roadBridgeFrames(g: Grid, lift = ROAD_LIFT): BridgeFrame[] {
  const S: LaneSrc = {
    level: 0, ok: (i) => g.road[i] !== 0 && g.deck[i] > 0, type: (i) => g.road[i], conn: g.conn, flow: g.flow, h: (i) => g.deck[i],
  };
  return laneGroups(g, S).map((ls) => laneFrame(g, S, ls, lift));
}

// 橋の路面のマスを、1つの橋ごとにまとめる（道路の種類と向きが同じで、道に沿ってつながるもの。大通りは2本の車線で1つ）
export function bridgeGroups(g: Grid): number[][] {
  return roadBridgeFrames(g).map((f) => f.cells);
}

// 高架鉄道の、水の上の区間（川を渡る橋）
export function railBridgeGroups(g: Grid): number[][] {
  const n = g.n, N = n * n, seen = new Uint8Array(N), out: number[][] = [];
  const isB = (i: number) => g.erail[i] !== 0 && g.isWater(i % n, (i / n) | 0);
  for (let i = 0; i < N; i++) {
    if (seen[i] || !isB(i)) continue;
    const comp: number[] = [], st = [i];
    seen[i] = 1;
    while (st.length) {
      const c = st.pop()!;
      comp.push(c);
      const x = c % n, y = (c / n) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!g.inb(x + dx, y + dy)) continue;
          const j = (y + dy) * n + x + dx;
          if (!seen[j] && isB(j)) { seen[j] = 1; st.push(j); }
        }
    }
    out.push(comp);
  }
  return out;
}

// 高架鉄道の橋の枠（いちばん離れた2マスを結ぶ向き）
function railFrames(g: Grid, height: (c: number) => number): BridgeFrame[] {
  const n = g.n;
  return railBridgeGroups(g).map((comp) => {
    let A = comp[0], B = comp[0];
    if (comp.length > 1) {
      const far = (s: number) => {
        let m = s, md = -1;
        for (const c of comp) {
          const d = (c % n - s % n) ** 2 + (((c / n) | 0) - ((s / n) | 0)) ** 2;
          if (d > md) { md = d; m = c; }
        }
        return m;
      };
      A = far(comp[0]);
      B = far(A);
    }
    const ax = (A % n + 0.5) * CELL, az = (((A / n) | 0) + 0.5) * CELL;
    const bx = (B % n + 0.5) * CELL, bz = (((B / n) | 0) + 0.5) * CELL;
    let L = Math.hypot(bx - ax, bz - az);
    const ux = L > 0 ? (bx - ax) / L : 1, uz = L > 0 ? (bz - az) / L : 0;
    const px = -uz, pz = ux;
    L += CELL;
    // 2本の線路のまん中を中心にする
    let off = 0;
    for (const c of comp) off += ((c % n + 0.5) * CELL - (ax + bx) / 2) * px + ((((c / n) | 0) + 0.5) * CELL - (az + bz) / 2) * pz;
    off /= comp.length;
    const H = comp.reduce((a, c) => a + height(c), 0) / comp.length;
    const prof: [number, number][] = [[0, H], [L, H]];
    return {
      cells: comp, t: 0, d: -1, sx: ax - ux * CELL * 0.5 + px * off, sz: az - uz * CELL * 0.5 + pz * off, ux, uz, px, pz, L, e: 0,
      Wd: 5.7, gap: 0, prof: [prof, prof], span: [[0, L], [0, L]], Hc: H, T: 1.4,
    };
  });
}

// 立体交差（地上の高速道路をまたぐ道路）の枠
function overpassFrames(g: Grid, lift: number): BridgeFrame[] {
  const local = (t: number) => t === RoadType.Street || t === RoadType.Road || t === RoadType.OneWay || t === RoadType.Avenue;
  const S: LaneSrc = { level: 1, ok: (i) => local(g.up[i]) && g.conn1[i] !== 0, type: (i) => g.up[i], conn: g.conn1, flow: g.flow1, h: (i) => g.upH[i] };
  return laneGroups(g, S).map((ls) => laneFrame(g, S, ls, lift));
}

// 路面の高さ（横の side 側。範囲の外は端の高さのまま）
function deckH(F: BridgeFrame, s: number, side: number) {
  const pr = F.prof[side];
  if (s <= pr[0][0]) return pr[0][1];
  for (let k = 1; k < pr.length; k++)
    if (s <= pr[k][0]) {
      const [s0, h0] = pr[k - 1], [s1, h1] = pr[k];
      return h0 + ((h1 - h0) * (s - s0)) / (s1 - s0 || 1);
    }
  return pr[pr.length - 1][1];
}

type V3 = [number, number, number];

// 立体を作る道具（O に頂点と三角形を足す）
function shapes(O: Buf) {
  // 三角形の向きを、外向きの向き (ox, oy, oz) に合わせて足す
  const quad = (a: number, b: number, c: number, d: number, ox: number, oy: number, oz: number) => {
    const P = O.P;
    const e1x = P[c * 3] - P[a * 3], e1y = P[c * 3 + 1] - P[a * 3 + 1], e1z = P[c * 3 + 2] - P[a * 3 + 2];
    const e2x = P[d * 3] - P[b * 3], e2y = P[d * 3 + 1] - P[b * 3 + 1], e2z = P[d * 3 + 2] - P[b * 3 + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (nx * ox + ny * oy + nz * oz >= 0) O.I.push(a, b, c, a, c, d);
    else O.I.push(a, c, b, a, d, c);
  };
  const tri = (a: number, b: number, d: number, ox: number, oy: number, oz: number) => {
    const P = O.P;
    const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[d * 3] - P[a * 3], e2y = P[d * 3 + 1] - P[a * 3 + 1], e2z = P[d * 3 + 2] - P[a * 3 + 2];
    const tx = e1y * e2z - e1z * e2y, ty = e1z * e2x - e1x * e2z, tz = e1x * e2y - e1y * e2x;
    if (tx * ox + ty * oy + tz * oz >= 0) O.I.push(a, b, d);
    else O.I.push(a, d, b);
  };
  // 2つの輪（同じ数の角、凸）をつないだ角柱。面ごとに平らな法線。capA / capB：輪の面を閉じるか
  const prism = (ra: V3[], rb: V3[], c: THREE.Color, capA = true, capB = true) => {
    const k = ra.length;
    let mx = 0, my = 0, mz = 0;
    for (const p of [...ra, ...rb]) { mx += p[0]; my += p[1]; mz += p[2]; }
    mx /= 2 * k; my /= 2 * k; mz /= 2 * k;
    const face = (pts: V3[]) => {
      // 面の法線（ニューエルの方法）を、立体の中心から外へ向ける
      let nx = 0, ny = 0, nz = 0, fx = 0, fy = 0, fz = 0;
      for (let j = 0; j < pts.length; j++) {
        const a = pts[j], b = pts[(j + 1) % pts.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
        fx += a[0]; fy += a[1]; fz += a[2];
      }
      fx /= pts.length; fy /= pts.length; fz /= pts.length;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) return;
      nx /= l; ny /= l; nz /= l;
      if (nx * (fx - mx) + ny * (fy - my) + nz * (fz - mz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const ids = pts.map((p) => O.v(p[0], p[1], p[2], c, nx, ny, nz));
      if (ids.length === 4) quad(ids[0], ids[1], ids[2], ids[3], nx, ny, nz);
      else for (let j = 1; j + 1 < ids.length; j++) tri(ids[0], ids[j], ids[j + 1], nx, ny, nz);
    };
    for (let j = 0; j < k; j++) {
      const j2 = (j + 1) % k;
      face([ra[j], ra[j2], rb[j2], rb[j]]);
    }
    if (capA) face(ra);
    if (capB) face(rb);
  };
  // 凸の多角形の面（外向きの向き o）
  const poly = (pts: V3[], c: THREE.Color, ox: number, oy: number, oz: number) => {
    const l = Math.hypot(ox, oy, oz) || 1;
    const ids = pts.map((p) => O.v(p[0], p[1], p[2], c, ox / l, oy / l, oz / l));
    for (let j = 1; j + 1 < ids.length; j++) tri(ids[0], ids[j], ids[j + 1], ox, oy, oz);
  };
  // 細い部材（四角い断面の棒）
  const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, c: THREE.Color) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const l = Math.hypot(ux, uy, uz) || 1;
    // 部材に直交する2つの向き
    let p1x = -uz, p1z = ux;
    let pl = Math.hypot(p1x, p1z);
    if (pl < 1e-3) { p1x = 1; p1z = 0; pl = 1; }
    p1x /= pl; p1z /= pl;
    const p2x = (uy * p1z) / l, p2y = (uz * p1x - ux * p1z) / l, p2z = (-uy * p1x) / l;
    const ring = (x: number, y: number, z: number): V3[] =>
      [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s1, s2]) => [x + (p1x * s1 + p2x * s2) * r, y + p2y * s2 * r, z + (p1z * s1 + p2z * s2) * r]);
    prism(ring(ax, ay, az), ring(bx, by, bz), c, false, false);
  };
  return { quad, prism, beam, poly };
}

// 道路の橋（rail がなければ）と立体交差の橋脚、または高架鉄道の橋（rail を渡すと、水の上の区間。height = 線路の高さ）に構造物を付ける
export function addBridgeStructures(g: Grid, O: Buf, lift: number, rail?: { height: (c: number) => number }) {
  if (rail) {
    for (const F of railFrames(g, rail.height)) {
      const style = g.bstyle[F.cells[0]];
      // 高架鉄道の桁橋は、ふつうの高架の柱（ラーメン高架橋）のままにする
      if (style !== 0) addStyle(g, O, F, style);
    }
    return;
  }
  for (const F of roadBridgeFrames(g, lift)) addStyle(g, O, F, g.bstyle[F.cells[0]]);
  for (const F of overpassFrames(g, lift)) addOverpassPiers(g, O, F);
}

// 1つの橋の構造物
function addStyle(g: Grid, O: Buf, F: BridgeFrame, style: number) {
  const { quad, prism, beam, poly } = shapes(O);
  const L = F.L, Wd = F.Wd, Hm = F.Hc, DECK_T = F.T;
  const P = (s: number, q: number, y: number): V3 => [F.sx + F.ux * s + F.px * q, y, F.sz + F.uz * s + F.pz * q];
  const gnd = (s: number, q: number) => {
    const p = P(s, q, 0);
    return g.groundAt(p[0], p[2]);
  };
  const sideOf = (q: number) => (q < 0 ? 0 : 1);
  const H = (s: number, sd: number) => deckH(F, s, sd);
  // s が、両側の床版の範囲に m 以上入っているか
  const inside = (s: number, m: number) => F.span.every(([a, b]) => s >= a + m && s <= b - m);
  // 横の side 側の床版の範囲の、割合 u の位置（斜めの大通りでは、2本の車線の橋の端がずれる）
  const at = (sd: number, u: number) => F.span[sd][0] + (F.span[sd][1] - F.span[sd][0]) * u;
  const seg = (s0: number, q0: number, y0: number, s1: number, q1: number, y1: number, r: number, c: THREE.Color) => {
    const a = P(s0, q0, y0), b = P(s1, q1, y1);
    beam(a[0], a[1], a[2], b[0], b[1], b[2], r, c);
  };
  // 道に沿った箱（s0..s1、横 q0..q1、高さ y0..y1）
  const box = (s0: number, s1: number, q0: number, q1: number, y0: number, y1: number, c: THREE.Color) => {
    const ring = (s: number): V3[] => [P(s, q0, y0), P(s, q1, y0), P(s, q1, y1), P(s, q0, y1)];
    prism(ring(s0), ring(s1), c);
  };
  // 横断面の形（q, y の凸の多角形）を、道に沿って s0..s1 にのばす
  const extrude = (poly: [number, number][], s0: number, s1: number, c: THREE.Color) => {
    prism(poly.map(([q, y]) => P(s0, q, y)), poly.map(([q, y]) => P(s1, q, y)), c);
  };
  // 楕円の柱（なめらかな法線）。ru：道に沿った半径、rp：横の半径
  const column = (s: number, q: number, y0: number, y1: number, ru: number, rp: number, c: THREE.Color) => {
    const k = 12, bot: number[] = [], top: number[] = [];
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      let nu = ca / ru, np = sa / rp;
      const nl = Math.hypot(nu, np);
      nu /= nl; np /= nl;
      const p = P(s + ca * ru, q + sa * rp, 0);
      const nx = F.ux * nu + F.px * np, nz = F.uz * nu + F.pz * np;
      bot.push(O.v(p[0], y0, p[2], c, nx, 0, nz));
      top.push(O.v(p[0], y1, p[2], c, nx, 0, nz));
    }
    for (let j = 0; j < k; j++) {
      const j2 = (j + 1) % k;
      const a = ((j + 0.5) / k) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      quad(bot[j], bot[j2], top[j2], top[j], F.ux * ca + F.px * sa, 0, F.uz * ca + F.pz * sa);
    }
    const ring = Array.from({ length: k }, (_, j) => {
      const a = (j / k) * Math.PI * 2;
      return P(s + Math.cos(a) * ru, q + Math.sin(a) * rp, y1);
    });
    poly(ring, c, 0, 1, 0);
  };
  // 橋脚の下の基礎（陸の上で見えるときだけ）
  const footing = (s: number, q: number, ru: number, rp: number) => {
    const h = gnd(s, q);
    if (h < WATER_LEVEL - 0.2) return;
    box(s - ru - 0.7, s + ru + 0.7, q - rp - 0.7, q + rp + 0.7, h - 0.6, h + 0.3, CONC);
  };

  // 橋脚：床版の下の横梁と、車線の下の柱。横梁は床版の縁より内側に収め、上は床版の下面にそろえる
  const pier = (s: number) => {
    if (!inside(s, 3)) return;
    const qe = Wd - 0.9; // 横梁の端
    const cols = F.e > 0 ? [-F.e, F.e] : [0];
    const rp = F.e > 0 ? Math.min(1.9, F.e * 0.32) : Math.min(2.4, Wd * 0.34);
    const ru = 1.0, hu = 1.1;
    const qc = Math.min(qe - 0.6, F.e + rp + 0.6);
    const depth = 1.7, tip = 0.8;
    for (const sd of [0, 1]) {
      const top = H(s, sd) - DECK_T + 0.05, m = sd ? 1 : -1;
      extrude([[0, top], [m * qe, top], [m * qe, top - tip], [m * qc, top - depth], [0, top - depth]], s - hu, s + hu, CONC);
    }
    for (const q of cols) {
      const top = H(s, sideOf(q)) - DECK_T - depth + 0.15;
      const base = gnd(s, q) - 0.8;
      if (top - base < 0.3) continue;
      column(s, q, base, top, ru, rp, CONC);
      footing(s, q, ru, rp);
    }
  };
  // 床版の下の、道に沿った桁（桁橋）。床版の下面にそわせる
  const girders = () => {
    const lim = Wd - 1.4;
    const k = Math.max(2, Math.round((2 * lim) / 4.6));
    for (let j = 0; j <= k; j++) {
      const q = -lim + (2 * lim * j) / k;
      if (Math.abs(q) < F.gap + 0.5) continue;
      const pr = F.prof[sideOf(q)];
      for (let m = 1; m < pr.length; m++) {
        const [sa, ha] = pr[m - 1], [sb, hb] = pr[m];
        const ring = (s: number, h: number): V3[] => [P(s, q - 0.3, h - DECK_T - 0.9), P(s, q + 0.3, h - DECK_T - 0.9), P(s, q + 0.3, h - DECK_T + 0.05), P(s, q - 0.3, h - DECK_T + 0.05)];
        prism(ring(sa, ha), ring(sb, hb), CONC, m === 1, m === pr.length - 1);
      }
    }
  };
  // 床版の外側の縁にそう桁（吊り橋の補剛桁、アーチ橋のタイ）。q0..q1 は床版の縁からの横の位置、dy0..dy1 は路面からの高さ
  const edgeGirder = (q0: number, q1: number, dy0: number, dy1: number, c: THREE.Color) => {
    for (const sd of [0, 1]) {
      const m = sd ? 1 : -1, pr = F.prof[sd];
      const a = m * (Wd + q0), b = m * (Wd + q1);
      for (let k = 1; k < pr.length; k++) {
        const [sa, ha] = pr[k - 1], [sb, hb] = pr[k];
        const ring = (s: number, h: number): V3[] => [P(s, a, h + dy0), P(s, b, h + dy0), P(s, b, h + dy1), P(s, a, h + dy1)];
        prism(ring(sa, ha), ring(sb, hb), c, k === 1, k === pr.length - 1);
      }
    }
  };

  switch (style) {
    case 0: {
      // 桁橋：床版の下の桁と、等間隔の橋脚
      if (F.t) girders();
      const k = Math.max(1, Math.round(L / 40));
      for (let j = 1; j < k; j++) pier((L * j) / k);
      break;
    }
    case 1: {
      // 吊り橋：床版の外に立つ2本の主塔と、たるんだ主ケーブル、縦のハンガー、床版の縁の補剛桁
      const t0 = L * (L < 60 ? 0.25 : 0.2), t1 = L - t0;
      const qL = Wd + 1.2; // 主塔の脚と主ケーブルの面
      const Ht = Math.max(18, L * 0.16, qL * 1.5);
      edgeGirder(-0.15, 1.8, -1.5, 0.35, GIRDER);
      for (const t of [t0, t1]) {
        for (const m of [-1, 1]) {
          const base = gnd(t, m * qL) - 0.6;
          box(t - 1.1, t + 1.1, m * qL - 1.1, m * qL + 1.1, base, Hm + Ht, TOWER);
        }
        seg(t, -qL, Hm + Ht - 1, t, qL, Hm + Ht - 1, 0.9, TOWER);
        seg(t, -qL, Hm + Ht * 0.55, t, qL, Hm + Ht * 0.55, 0.7, TOWER);
        seg(t, -qL, Math.min(H(t, 0), H(t, 1)) - DECK_T - 1.1, t, qL, Math.min(H(t, 0), H(t, 1)) - DECK_T - 1.1, 0.9, TOWER);
      }
      for (const sd of [0, 1]) {
        const m = sd ? 1 : -1, a = F.span[sd][0], b = F.span[sd][1];
        const ya = H(a, sd) + 0.6, yb = H(b, sd) + 0.6, top = Hm + Ht - 0.2;
        const cy = (s: number) => {
          if (s <= t0) return ya + (top - ya) * ((s - a) / (t0 - a || 1));
          if (s >= t1) return yb + (top - yb) * ((b - s) / (b - t1 || 1));
          const u = (s - t0) / (t1 - t0);
          return Hm + 2.2 + (top - Hm - 2.2) * (2 * u - 1) ** 2;
        };
        const steps = 40;
        for (let j = 0; j < steps; j++) {
          const s0 = a + ((b - a) * j) / steps, s1 = a + ((b - a) * (j + 1)) / steps;
          seg(s0, m * qL, cy(s0), s1, m * qL, cy(s1), 0.35, CABLE);
        }
        for (let s = a + 4; s < b - 2; s += 5)
          if (Math.abs(s - t0) > 1.5 && Math.abs(s - t1) > 1.5 && cy(s) - H(s, sd) > 1.2) seg(s, m * qL, H(s, sd) + 0.3, s, m * qL, cy(s), 0.08, CABLE);
      }
      break;
    }
    case 2: {
      // 斜張橋：A字の主塔から扇形に張ったケーブル。脚は路面の高さで床版の外を通る
      const two = L > 170;
      const towers = two ? [L * 0.28, L * 0.72] : [L * 0.5];
      const Ht = Math.max(20, two ? L * 0.15 : L * 0.24, Wd * 1.8);
      const reach = two ? L * 0.26 : L * 0.46;
      const qA = Wd + 2.0, qTop = 1.0;
      edgeGirder(-0.15, 0.7, -1.5, 0.35, GIRDER);
      for (const t of towers) {
        const top = Hm + Ht;
        const legQ = (y: number) => qTop + ((qA - qTop) * (top - y)) / (top - Hm); // 高さ y での脚の横の位置
        for (const m of [-1, 1]) {
          const base = gnd(t, m * legQ(Hm - 10)) - 0.6;
          const b0 = P(t, m * legQ(base), base), tp = P(t, m * qTop, top);
          beam(b0[0], b0[1], b0[2], tp[0], tp[1], tp[2], 1.2, WHITE);
        }
        const yb = Math.min(H(t, 0), H(t, 1)) - DECK_T - 0.9;
        seg(t, -legQ(yb), yb, t, legQ(yb), yb, 1.0, WHITE);
        const nC = 9;
        for (const sd of [0, 1]) {
          const m = sd ? 1 : -1;
          for (const dir of [-1, 1])
            for (let j = 1; j <= nC; j++) {
              const s = t + (dir * (reach * j)) / nC;
              if (s < F.span[sd][0] + 1 || s > F.span[sd][1] - 1) continue;
              const y = Hm + Ht * (0.62 + (0.36 * j) / nC);
              const a = P(t, m * legQ(y), y), b = P(s, m * (Wd + 0.3), H(s, sd) + 0.35);
              beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.1, CABLE);
            }
        }
      }
      if (!two) for (const s of [L * 0.04, L * 0.96]) pier(s);
      break;
    }
    case 3: {
      // トラス橋（ワーレントラス）：床版の両側の上弦材・下弦材と斜材、上の横つなぎ
      const Ht = Math.max(8, 4.5 + Wd * 0.35);
      const qT = Wd + 0.45;
      const panels = Math.max(2, Math.round(L / 9));
      const top = Hm + Ht;
      const pts = [0, 1].map((sd) => Array.from({ length: panels + 1 }, (_, j) => at(sd, j / panels)));
      for (const sd of [0, 1]) {
        const m = sd ? 1 : -1, ss = pts[sd];
        const y0 = (j: number) => H(ss[j], sd);
        for (let j = 0; j < panels; j++) {
          const s0 = ss[j], s1 = ss[j + 1];
          seg(s0, m * qT, y0(j), s1, m * qT, y0(j + 1), 0.35, STEEL);
          if (j > 0 && j < panels - 1) seg(s0, m * qT, top, s1, m * qT, top, 0.4, STEEL);
          if (j === 0) seg(s0, m * qT, y0(j), s1, m * qT, top, 0.35, STEEL);
          else if (j === panels - 1) seg(s0, m * qT, top, s1, m * qT, y0(j + 1), 0.35, STEEL);
          else if (j % 2) seg(s0, m * qT, top, s1, m * qT, y0(j + 1), 0.25, STEEL);
          else seg(s0, m * qT, y0(j), s1, m * qT, top, 0.25, STEEL);
          if (j > 0) seg(s0, m * qT, y0(j), s0, m * qT, top, 0.22, STEEL);
        }
      }
      for (let j = 1; j < panels; j++) seg(pts[0][j], -qT, top, pts[1][j], qT, top, 0.22, STEEL);
      for (let j = 1; j < panels - 1; j += 2) {
        seg(pts[0][j], -qT, top, pts[1][j + 1], qT, top, 0.12, STEEL);
        seg(pts[1][j], qT, top, pts[0][j + 1], -qT, top, 0.12, STEEL);
      }
      if (L > 120) { const k = Math.round(L / 60); for (let j = 1; j < k; j++) pier((L * j) / k); }
      break;
    }
    case 4: {
      // アーチ橋（タイドアーチ）：床版の両側の弧と縦の吊り材。アーチの足は、床版の縁の桁（タイ）でつなぐ
      const R = Math.min(L * 0.2, 45) + 4;
      const qa = Wd + 0.6;
      edgeGirder(-0.15, 1.3, -1.5, 0.45, ARCH);
      const ay = (sd: number, u: number) => {
        const a = F.span[sd][0], b = F.span[sd][1];
        return H(a, sd) + 0.45 + (H(b, sd) - H(a, sd)) * u + R * 4 * u * (1 - u);
      };
      const steps = 32;
      for (const sd of [0, 1]) {
        const m = sd ? 1 : -1;
        for (let j = 0; j < steps; j++) {
          const u0 = j / steps, u1 = (j + 1) / steps;
          seg(at(sd, u0), m * qa, ay(sd, u0), at(sd, u1), m * qa, ay(sd, u1), 0.7, ARCH);
        }
        const len = F.span[sd][1] - F.span[sd][0];
        for (let s = 6; s < len - 4; s += 6) {
          const u = s / len, ss = at(sd, u);
          if (ay(sd, u) - H(ss, sd) > 2) seg(ss, m * qa, H(ss, sd) + 0.4, ss, m * qa, ay(sd, u), 0.1, CABLE);
        }
      }
      for (let u = 0.22; u < 0.79; u += Math.max(8, L * 0.09) / L) {
        const y = (ay(0, u) + ay(1, u)) / 2;
        if (y - Hm > 7) seg(at(0, u), -qa, ay(0, u), at(1, u), qa, ay(1, u), 0.35, ARCH);
      }
      break;
    }
    case 5: {
      // ラーメン橋：橋脚と桁が一体。橋脚の上で桁が深くなる（ハンチ）
      const k = Math.max(2, Math.round(L / 45));
      const sp = L / k;
      // 水面に近い橋でも見えるように、桁の深さは水面までに収める
      const deep = Math.max(0.6, Math.min(4.5, Hm - WATER_LEVEL - 2.2));
      const depth = (s: number) => {
        const u = (((s % sp) + sp) % sp) / sp; // 0..1（橋脚から橋脚）
        const d = Math.min(u, 1 - u) * 2; // 橋脚で 0、真ん中で 1
        return 1.3 + deep * (1 - d) ** 2;
      };
      const qw = Wd * 0.72; // 箱桁の側面
      const steps = Math.max(12, k * 10);
      for (let j = 0; j < steps; j++) {
        const u0 = j / steps, u1 = (j + 1) / steps;
        const bot: V3[] = [];
        for (const sd of [0, 1]) {
          const m = sd ? 1 : -1;
          const s0 = at(sd, u0), s1 = at(sd, u1);
          const a = P(s0, m * qw, 0), b = P(s1, m * qw, 0);
          O.wall(a[0], a[2], H(s0, sd) - depth(s0), H(s0, sd) - 1.0, b[0], b[2], H(s1, sd) - depth(s1), H(s1, sd) - 1.0, CONC);
          bot.push(P(s0, m * qw, H(s0, sd) - depth(s0)), P(s1, m * qw, H(s1, sd) - depth(s1)));
        }
        // 箱桁の底
        const ids = [bot[0], bot[2], bot[3], bot[1]].map((p) => O.v(p[0], p[1], p[2], CONC, 0, -1, 0));
        quad(ids[0], ids[1], ids[2], ids[3], 0, -1, 0);
      }
      // 下に広がる V 字の脚（2本の車線の橋は、片側に2本ずつ）
      const legs = F.e > 0 ? [-0.62, -0.25, 0.25, 0.62] : [-0.45, 0.45];
      const r = F.e > 0 ? 1.15 : 1.0;
      for (let j = 1; j < k; j++) {
        const s = j * sp;
        if (!inside(s, 8)) continue;
        for (const dir of [-1, 1])
          for (const f of legs) {
            const q = f * Wd, sd = sideOf(q), s2 = s + dir * 7;
            seg(s, q, gnd(s, q) - 0.6, s2, q, H(s2, sd) - depth(s2) + 0.3, r, CONC);
          }
        // 橋脚の上は、桁を厚くして一体に見せる
        for (const m of [-1, 1]) {
          const sd = m > 0 ? 1 : 0;
          seg(s - 6, m * qw, H(s, sd) - 1.3 - deep, s + 6, m * qw, H(s, sd) - 1.3 - deep, 0.6, CONC);
        }
      }
      break;
    }
  }
}

// 立体交差の橋脚：下の高速道路の中央分離帯に、道路の幅いっぱいの壁の橋脚を立てる（2本の車線の下にまとめて1つ）
function addOverpassPiers(g: Grid, O: Buf, F: BridgeFrame) {
  const { prism } = shapes(O);
  const n = g.n;
  const P = (s: number, q: number, y: number): V3 => [F.sx + F.ux * s + F.px * q, y, F.sz + F.uz * s + F.pz * q];
  const d = F.d;
  if (d < 0) return;
  // 道に沿って隣り合う上空のマスの下が、地上の2マス幅の高速道路の、反対向きの2本の車線（間が中央分離帯）
  const sx0 = F.sx, sz0 = F.sz;
  const pos: number[] = [];
  for (const c of F.cells) {
    const x = (c % n) + DX[d], y = ((c / n) | 0) + DY[d];
    if (!g.inb(x, y)) continue;
    const j = y * n + x;
    if (!F.cells.includes(j)) continue;
    const ra = g.road[c], rb = g.road[j];
    if (!ra || ra !== rb || !isHighway(ra) || !ROADS[ra]?.wide) continue;
    if (g.conn[c] & (1 << d)) continue; // 同じ車線が続く（分離帯ではない）
    const ha = axisOf(g.conn[c]);
    if (ha < 0 || ((ha - (d & 3)) & 3) !== 2) continue; // 直角に交わるときだけ
    const mx = (((c % n) + x) / 2 + 0.5) * CELL, mz = ((((c / n) | 0) + y) / 2 + 0.5) * CELL;
    const s = (mx - sx0) * F.ux + (mz - sz0) * F.uz;
    if (!pos.some((p) => Math.abs(p - s) < 3)) pos.push(s);
  }
  for (const s of pos) {
    const lim = F.Wd - 2.2;
    let base = Infinity;
    for (const q of [-lim, 0, lim]) {
      const p = P(s, q, 0);
      base = Math.min(base, g.groundAt(p[0], p[2]));
    }
    base -= 0.3;
    for (const sd of [0, 1]) {
      if (s < F.span[sd][0] + 2 || s > F.span[sd][1] - 2) continue;
      const m = sd ? 1 : -1, top = deckH(F, s, sd) - F.T + 0.05;
      if (top - base < 1) continue;
      // 壁の端は、角を落とした形にする
      const hu = 0.9, c0 = 0.45;
      const poly: [number, number][] = [[-hu, 0], [hu, 0], [hu, m * (lim - c0)], [hu - c0, m * lim], [-hu + c0, m * lim], [-hu, m * (lim - c0)]];
      const ring = (y: number) => poly.map(([u, q]) => P(s + u, q, y));
      prism(ring(base), ring(top), CONC, false, true);
    }
  }
}
