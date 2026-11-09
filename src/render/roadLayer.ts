// 道路と送電線の描画
//
// 道路はマスごとに「腕」（つながっている方向）を調べて形を作る。
//   1本：行き止まり（街路は丸い転回場）
//   2本：まっすぐ、またはなめらかなカーブ
//   3本以上：交差点（角が丸い路面、停止線、横断歩道）
// 大通り（一方通行2車線のマスが2本並ぶ）は、グリーンベルト型の断面にする。
//   1マス（16m）の中に、外側の歩道 4.5m、車道 7m（3.25m の2車線と路肩）、植え込みの中央分離帯の半分 4.5m。
//   2本の車線の分離帯がまん中で合わさって、約 9m の分離帯になる（斜めの区間は約 4m）。
//   大通りの交差点（交差点のマスのかたまり）は、まとめて1つの交差点として描く。行き止まりは2本の車線で1つの転回場にする。
// 路面、白線・黄線、歩道や壁などの立体物は、それぞれ別のメッシュにまとめる。
import * as THREE from 'three';
import { createMarkMaterial, createRoadSolidMaterial, createRoadSurfaceMaterial, SOLID, SURF, surfCode } from './roadMaterials';
import { Grid } from '../sim/grid';
import { CELL, DX, DY, dirOf, isDiag, opp } from '../sim/constants';
import { ROADS, RoadType, isHighway, isUrbanElevated } from '../sim/defs';
import type { TreeSpot } from './buildingGen';
import { findURamps, URamp, UR_END, UR_HALF, urampAt, urampS, urGore, urHw, urStart, UPt } from './uramp';

export const ROAD_LIFT = 0.3;
const DIAG_LANE_W = 10.7; // 斜めの区間の、2マス幅の高速道路の1車線分の幅

// 大通り（グリーンベルト型）の寸法
export const AV_W = 7.0; // 車道（3.25m の2車線と、両側の路肩）。マスの中心にそろえる
export const AV_SW = 4.5; // 外側の歩道
export const AV_SW_BRIDGE = 4.0; // 橋の上の歩道（床版の外側の縁は前と同じ位置）
const AV_MED = (CELL - AV_W) / 2; // 分離帯の半分の幅（まっすぐな区間、4.5m）
const AV_MED_DIAG = (CELL / Math.SQRT2 - AV_W) / 2; // 斜めの区間（車線の間隔が約 11.3m なので約 2.2m）
const CORNER_R = 6; // 大通りの交差点の角の縁石の半径
export const SIG_STOP = 5.6; // 信号のある大通りの交差点の停止線：横切る車道の縁からの長さ（横断歩道の外）
const KERB = 0.18; // 分離帯の縁石と植え込みの高さ

const COL = {
  white: new THREE.Color(0xecece6),
  yellow: new THREE.Color(0xe3b62e),
  walk: new THREE.Color(0xb8b5ac),
  curb: new THREE.Color(0x8f8c85),
  barrier: new THREE.Color(0xc4c1b9),
  concrete: new THREE.Color(0xb3afa6),
  signal: new THREE.Color(0x3a3d40),
  island: new THREE.Color(0x5f8f44),
  glass: new THREE.Color(0x8fb4c9),
  busSign: new THREE.Color(0x2f86d0),
  asphalt: new THREE.Color(0x515457),
  asphaltStreet: new THREE.Color(0x5a5c5f),
  slab: new THREE.Color(0x6b6a66), // コンクリートの路面（高速道路）
  // 都市高速の高架：明るい欄干と床版の縁、陰になる暗い下面と桁、擁壁
  parapet: new THREE.Color(0xd9d6ce),
  groove: new THREE.Color(0x66645f),
  soffit: new THREE.Color(0x6a6863),
  girder: new THREE.Color(0x77756f),
  pier: new THREE.Color(0xb8b4ab),
  wall: new THREE.Color(0xaaa69d),
  footing: new THREE.Color(0x8e8a80),
  grass: new THREE.Color(0x66843f), // 分離帯の芝と土
  hedge: new THREE.Color(0x3d6a2c), // 分離帯の低い植え込み（サツキなど）
};
const VIA_COLS = new Set([COL.parapet, COL.groove, COL.soffit, COL.girder, COL.pier, COL.wall, COL.footing]);
const AUX0: [number, number, number, number] = [0, 0, 0, 0];
const ZELKOVA = [0x557a2c, 0x5f8434, 0x587d36, 0x4f7034]; // 分離帯の並木の葉の色
// 分離帯の植え込みの断面の各点の向き（横＝分離帯へ向かう向き、上）
const HEDGE_N: [number, number][] = [[-0.85, 0.53], [-0.6, 0.8], [0, 1], [0.6, 0.8], [0.85, 0.53]];

// 道路の種類ごとの見た目
function sidewalkOf(t: number) {
  return t === RoadType.Street ? 1.7 : t === RoadType.Road || t === RoadType.OneWay ? 2.0 : t === RoadType.Avenue ? AV_SW : 0;
}
// 描画上の車道の幅（大通りは片側2車線の 7m。シミュレーションの幅とは別）
export function drawWidth(t: number) {
  return t === RoadType.Avenue ? AV_W : ROADS[t]?.width ?? 10;
}
function hasBarrier(t: number) {
  return isHighway(t) || t === RoadType.Ramp;
}

// 車線の数（路面の車輪のあとを描くのに使う）
function lanesOf(t: number) {
  if (t === RoadType.Ramp) return 1;
  if (t === RoadType.Highway || t === RoadType.GroundHighway) return 3;
  return 2;
}
// 整数2つから乱数（道ごとの色の違いなど）
function hashInt(a: number, b: number) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// 大通りのマスの、中央分離帯（反対向きの車線）のある向き（0..7）。ない・分からないときは -1。
// 右側通行なので、進む向きの左側が分離帯。まっすぐなマス（斜めも）だけを見る
export function avenueMedianDir(g: Grid, i: number): number {
  if (g.road[i] !== RoadType.Avenue) return -1;
  const n = g.n, x = i % n, y = (i / n) | 0;
  const isAv = (d: number) => {
    const qx = x + DX[d], qy = y + DY[d];
    return g.inb(qx, qy) && g.road[qy * n + qx] === RoadType.Avenue;
  };
  const m = g.conn[i];
  let along = -1;
  for (let d = 0; d < 4; d++) if (m & (1 << d) && m & (1 << (d + 4))) along = d;
  if (along < 0) {
    // 端のマス：まっすぐな腕が1本だけ。または、もう1本が反対車線への折り返し（同じ向きへ続く横の車線へのつなぎ）
    const ax = [0, 2, 4, 6].filter((d) => m & (1 << d));
    if (ax.length === 2 && ax[1] - ax[0] !== 4) {
      for (const [a, b] of [[ax[0], ax[1]], [ax[1], ax[0]]]) {
        const qx = x + DX[b], qy = y + DY[b];
        if (g.inb(qx, qy) && g.road[qy * n + qx] === RoadType.Avenue && g.conn[qy * n + qx] & (1 << a)) return b;
      }
      return -1;
    }
    if (ax.length !== 1) return -1;
    along = ax[0];
  }
  // 進む向き（流れのある方）が along の逆なら、左右を入れかえる
  const back = !(g.flow[i] & (1 << along)) && !!(g.flow[i] & (1 << opp(along)));
  // 左（along から見て）と右の向き、そちらにある隣のマス（斜めの車線の反対車線は、軸の向きの隣）
  const dirL = (along + 6) & 7, dirR = (along + 2) & 7;
  const nbL = isDiag(along) ? [(along + 5) & 7, (along + 7) & 7] : [dirL];
  const nbR = isDiag(along) ? [(along + 1) & 7, (along + 3) & 7] : [dirR];
  const order: [number, number[]][] = back ? [[dirR, nbR], [dirL, nbL]] : [[dirL, nbL], [dirR, nbR]];
  for (const [dir, cells] of order) if (cells.some(isAv)) return dir;
  return -1;
}

// 地面の上の凸な範囲：半平面 a*x + b*z <= c の組（[a0, b0, c0, a1, b1, c1, ...]）
export type Region = number[];
export function inRegion(R: Region, x: number, z: number) {
  for (let k = 0; k < R.length; k += 3) if (R[k] * x + R[k + 1] * z > R[k + 2] + 1e-6) return false;
  return true;
}
// 頂点の番号の多角形を、半平面 sg*(a*x + b*z - c) <= 0 の側だけ残す（切り口には新しい頂点を作る）
function clipIdx(B: Buf, P: number[], poly: number[], a: number, b: number, c: number, sg: number) {
  const out: number[] = [];
  const f = (v: number) => sg * (a * P[v * 3] + b * P[v * 3 + 2] - c);
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp <= 1e-9) out.push(p);
    if ((fp < -1e-9 && fq > 1e-9) || (fp > 1e-9 && fq < -1e-9)) out.push(B.mix(p, q, fp / (fp - fq)));
  }
  return out;
}
// 凸な多角形から、凸な範囲 R を取り除いた残り（凸な多角形のいくつか）を out に加える
function subtractIdx(B: Buf, P: number[], poly: number[], R: Region, out: number[][]) {
  // 全部が範囲の外（どれかの半平面の外）なら、そのまま
  for (let k = 0; k < R.length; k += 3) {
    let allOut = true;
    for (const v of poly) if (R[k] * P[v * 3] + R[k + 1] * P[v * 3 + 2] <= R[k + 2] + 1e-9) { allOut = false; break; }
    if (allOut) { out.push(poly); return; }
  }
  let rest = poly;
  for (let k = 0; k < R.length && rest.length >= 3; k += 3) {
    const piece = clipIdx(B, P, rest, R[k], R[k + 1], R[k + 2], -1);
    if (piece.length >= 3) out.push(piece);
    rest = clipIdx(B, P, rest, R[k], R[k + 1], R[k + 2], 1);
  }
}

// 頂点を貯めてメッシュにするための入れ物
export class Buf {
  P: number[] = [];
  N: number[] = [];
  C: number[] = [];
  U: number[] = [];
  I: number[] = [];
  owner = -1; // いま作っている道路のノード（路面の三角形ごとに記録する）
  T: number[] = [];
  // 路面・歩道の模様のための値（withAux のとき、v() で頂点ごとに aux を記録する）
  withAux = false;
  A: number[] = [];
  aux: [number, number, number, number] = AUX0;
  kindOf: ((c: THREE.Color) => number) | null = null; // 色から模様の種類を決める（aux の 4 番目）
  withUV = true; // uv を使わないメッシュ（道路）は false にして、記録を省く
  v(x: number, y: number, z: number, c: THREE.Color, nx = 0, ny = 1, nz = 0) {
    this.P.push(x, y, z);
    this.N.push(nx, ny, nz);
    this.C.push(c.r, c.g, c.b);
    if (this.withUV) this.U.push(x / 7, z / 7);
    if (this.withAux) {
      const a = this.aux;
      this.A.push(a[0], a[1], a[2], this.kindOf ? this.kindOf(c) : a[3]);
    }
    return this.P.length / 3 - 1;
  }
  // 上向きの面になるように三角形を追加
  tri(a: number, b: number, c: number) {
    const P = this.P;
    const e1x = P[b * 3] - P[a * 3], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3], e2z = P[c * 3 + 2] - P[a * 3 + 2];
    if (e1z * e2x - e1x * e2z >= 0) this.I.push(a, b, c);
    else this.I.push(a, c, b);
    this.T.push(this.owner);
  }
  // 縦の面（両面）
  wall(ax: number, az: number, ay0: number, ay1: number, bx: number, bz: number, by0: number, by1: number, c: THREE.Color) {
    const nx = bz - az, nz = -(bx - ax);
    const l = Math.hypot(nx, nz) || 1;
    const i0 = this.v(ax, ay0, az, c, nx / l, 0, nz / l), i1 = this.v(bx, by0, bz, c, nx / l, 0, nz / l);
    const i2 = this.v(bx, by1, bz, c, nx / l, 0, nz / l), i3 = this.v(ax, ay1, az, c, nx / l, 0, nz / l);
    this.I.push(i0, i1, i2, i0, i2, i3, i0, i2, i1, i0, i3, i2);
  }
  // 頂点 i と j の間（t の位置）に、新しい頂点を作る（位置・向き・色・模様の値をまぜる）
  mix(i: number, j: number, t: number) {
    const L = (a: number[], k: number) => {
      for (let q = 0; q < k; q++) a.push(a[i * k + q] + (a[j * k + q] - a[i * k + q]) * t);
    };
    L(this.P, 3);
    L(this.N, 3);
    L(this.C, 3);
    if (this.withUV) L(this.U, 2);
    if (this.withAux) L(this.A, 4);
    return this.P.length / 3 - 1;
  }
  // 三角形の番号 t0 から後ろの三角形から、範囲 regs（どれも凸）に入る部分を取り除く（はみ出す三角形は切って残す）
  clipFrom(t0: number, regs: Region[]) {
    if (!regs.length) return;
    const I = this.I, T = this.T, nT = I.length / 3, hasT = T.length === nT;
    const tris: number[] = I.slice(t0 * 3), own = hasT ? T.slice(t0) : [];
    I.length = t0 * 3;
    if (hasT) T.length = t0;
    const P = this.P;
    for (let k = 0; k < tris.length / 3; k++) {
      let pieces: number[][] = [[tris[k * 3], tris[k * 3 + 1], tris[k * 3 + 2]]];
      for (const R of regs) {
        const next: number[][] = [];
        for (const poly of pieces) subtractIdx(this, P, poly, R, next);
        pieces = next;
        if (!pieces.length) break;
      }
      for (const poly of pieces)
        for (let q = 1; q + 1 < poly.length; q++) {
          I.push(poly[0], poly[q], poly[q + 1]);
          if (hasT) T.push(own[k]);
        }
    }
  }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color) {
    this.wall(x0, z1, y0, y1, x1, z1, y0, y1, c);
    this.wall(x1, z0, y0, y1, x0, z0, y0, y1, c);
    this.wall(x1, z1, y0, y1, x1, z0, y0, y1, c);
    this.wall(x0, z0, y0, y1, x0, z1, y0, y1, c);
    const a = this.v(x0, y1, z0, c), b = this.v(x1, y1, z0, c), d = this.v(x1, y1, z1, c), e = this.v(x0, y1, z1, c);
    this.tri(a, b, d);
    this.tri(a, d, e);
  }
  geometry(uv = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    if (this.withAux) g.setAttribute('aRd', new THREE.Float32BufferAttribute(this.A, 4));
    g.setIndex(this.I);
    return g;
  }
}

// 道路の中心線上の点（位置、高さ、車道の半分の幅、歩道の幅、道路の種類）
interface RP {
  x: number;
  z: number;
  h: number;
  hw: number;
  sw: number;
  t: number;
  fw?: number; // 地面に合わせる帯でも、この割合だけ h の高さ（平らな隣の帯との境目でそろえる）
}

interface Arm {
  d: number;
  ux: number;
  uz: number;
  L: number; // 中心から中間点までの長さ
  ang: number;
  w: number; // このマスでの車道の幅
  wm: number; // 中間点での車道の幅（隣の道路との平均）
  sw: number;
  swm: number;
  eh: number; // 中間点の高さ
  t: number;
  tn: number; // 隣の道路の種類
  ng: boolean; // 隣も地上の道路か（橋や高架につながる腕は、地面に合わせない）
  nn: number; // 隣のノード（なければ -1）
}

// 帯の横に付けるもの：true 歩道（高速道路は壁）、false なし、'med' 中央分離帯
type Side = boolean | 'med';
// 帯の横のものを描かない範囲（side：0 = 点の並びの左、1 = 右。s0..s1 は帯の始まりからの長さ）
interface Cut {
  side: number;
  s0: number;
  s1: number;
}
// 中央分離帯の縁石の点（縁石の位置、分離帯へ向かう向き、幅、高さの代わり、道に沿った位置）
// 帯の一部（s0..s1）だけ、分離帯の形を変える（mode は median と同じ）
interface MedZone {
  s0: number;
  s1: number;
  mode: number;
}
interface MP {
  x: number;
  z: number;
  nx: number;
  nz: number;
  w: number;
  h: number;
  al: number;
  free?: boolean; // 反対車線が見つからなかった（外側の縁で地面とのすき間を隠す）
  fw?: number; // RP の fw と同じ
}

// 大通りの交差点（マスのかたまり）の腕。横の位置は、かたまりの中心からの p 向きの距離
interface CLane {
  o: number; // 車道の中心の横の位置
  hw: number;
  entry: boolean; // 交差点へ入ってくる向きに流れる
  exit: boolean;
  nn: number; // 隣のマス
  trim: boolean; // 隣のマスの歩道・分離帯を、交差点の側で削れるか（まっすぐなマス）
}
interface CArm {
  d: number;
  ux: number;
  uz: number;
  px: number; // p：角度の増える向きの横向き
  pz: number;
  ang: number;
  mouth: number; // かたまりの中心から縁までの長さ
  lanes: CLane[]; // 横の位置の小さい順
  lo: number; // 車道の両端の縁石の横の位置
  hi: number;
  swLo: number; // 縁石の外の歩道の幅（0 = 分離帯の側）
  swHi: number;
  pair: boolean; // 分離帯をはさんだ大通りの2本の車線
  K: number; // 横切る道路の縁石までの長さ
  xw0: number; // 横断歩道の始まり
  tip: number; // 分離帯の先（安全地帯）の始まり
  mEnd: number; // 植え込みの始まり
  stop: number; // 停止線
}
interface Corner {
  a: CArm;
  b: CArm;
  arc: boolean; // 角（直角）か、腕のないまっすぐな辺か
  r: number;
  ka: number; // a の縁石の横の位置
  kb: number; // b の縁石の、a に沿った位置
  med: boolean; // まっすぐな辺が、反対車線との間の分離帯
}
interface Cluster {
  cells: number[];
  cx: number;
  cz: number;
  hx: number; // かたまりの半分の大きさ（x、z の向き）
  hz: number;
  arms: CArm[];
  corners: Corner[];
  ctl: number;
  lift: number;
}

// 斜めに交わる大通りの交差点の、片方の大通りの帯。道に沿った向き u（+u が向き d）、横向き n（u を 90° まわした向き）
interface DBand {
  d: number;
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  q: [number, number]; // 2本の車線の中心の横の位置（小さい順）
  arm: [boolean, boolean]; // +u の側、-u の側に腕があるか
  flow: [number, number]; // 車線ごとの流れ（+1 = +u の向き、-1 = -u の向き、0 = 分からない）
  lo: number; // 外側の縁石の横の位置
  hi: number;
}
// 描かない範囲：路面、分離帯、歩道、線（どれも凸な範囲のリスト）
interface ClipSet {
  surf: Region[];
  med: Region[];
  walk: Region[];
  line: Region[];
}
interface DCluster {
  cells: number[];
  A: DBand; // 縦横の大通り
  B: DBand; // 斜めの大通り
  ctl: number;
  lift: number;
  cx: number; // 2本の帯の中心線の交わる点
  cz: number;
  clip?: [ClipSet, ClipSet]; // A の車線、B の車線の描かない範囲
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// 大通りの交差点の角の街灯（x, 高さ, z, 腕の向き x, z, 光の届く路面の高さ の並び）。道路を作り直すたびに入れかわる（街灯の層が読む）
export const junctionLamps: number[] = [];
// 大通りの交差点の中を照らす光（x, 高さ, z, 大きさ）。交差点の中に柱は立てず、角の街灯の光が届くものとして路面を照らす
export const junctionPools: number[] = [];
// 大通りの街灯を立てない範囲（斜めの大通りの交差点の、角の丸みや車道になったところ）
export const avLampBlock: Region[] = [];

export class RoadLayer {
  group = new THREE.Group();
  private surface: THREE.Mesh;
  private marks: THREE.Mesh;
  private solid: THREE.Mesh;
  private poles: THREE.Mesh;
  private wires: THREE.LineSegments;
  jctl: Uint8Array = new Uint8Array(0); // 交差点の制御方式（シミュレーションで決まったもの）
  // 大通りの中央分離帯の並木（ケヤキ、2列）。木の層に、建物の庭の木と同じように渡して植える
  medianTrees: TreeSpot[] = [];

  constructor() {
    this.surface = new THREE.Mesh(new THREE.BufferGeometry(), createRoadSurfaceMaterial());
    this.surface.receiveShadow = true;
    this.marks = new THREE.Mesh(new THREE.BufferGeometry(), createMarkMaterial());
    this.marks.receiveShadow = true;
    this.solid = new THREE.Mesh(new THREE.BufferGeometry(), createRoadSolidMaterial());
    this.solid.castShadow = true;
    this.solid.receiveShadow = true;
    this.poles = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x6b5b4a }));
    this.poles.castShadow = true;
    this.wires = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.7 }));
    this.group.add(this.surface, this.marks, this.solid, this.poles, this.wires);
  }

  static centerH(g: Grid, i: number) {
    return g.roadH(i) + ROAD_LIFT;
  }

  rebuild(g: Grid) {
    const n = g.n, NC = n * n;
    const S = new Buf(), M = new Buf(), O = new Buf();
    S.withAux = O.withAux = true;
    S.withUV = M.withUV = O.withUV = false;
    // 歩道・縁石・コンクリート・植え込みは色で見分けて、模様の種類を記録する
    O.kindOf = (c) =>
      c === COL.walk ? SOLID.walk : c === COL.curb ? SOLID.curb : c === COL.grass ? SOLID.grass : c === COL.hedge ? SOLID.hedge : c === COL.barrier || c.equals(COL.concrete) || VIA_COLS.has(c) ? SOLID.concrete : SOLID.plain;
    // いまのマスの円の路面の模様の種類と、坂の傾き（地面に合わせない円を、腕の坂に合わせて傾ける）
    let discCode = 0, gradX = 0, gradZ = 0;
    // 高速道路とランプはコンクリートの路面にする
    const isConc = (t: number) => isHighway(t) || t === RoadType.Ramp;
    const surfCol = (t: number, conc: boolean) => (conc ? COL.slab : t === RoadType.Street ? COL.asphaltStreet : COL.asphalt);
    // 地上の道路は、路面・歩道・線の高さを地面（造成した地形）に合わせる。
    // マスの中心の高さだけで描くと、坂道や、坂道どうしの交差点で地面が路面より上に出てしまうため
    let onGround = false, liftCur = 0;
    let medSkirt = false; // 分離帯の外側の縁（反対車線との境）にも、下へのびる縁を付ける
    // 歩道・分離帯と線は、いったんためておき、最後に「ほかの道路の路面の上に重なるもの」を取り除いてから描く
    const walkQ: { p: number[]; w: number[][]; o?: number }[] = [];
    const medQ: { p: number[]; draw: () => void; trees?: TreeSpot[]; o?: number }[] = [];
    const lineQ: { p: number[]; c: THREE.Color; o: number; o2: number; zb: boolean; k?: boolean }[] = [];
    let lineAlso = -1, lineZb = false; // 線を消すかを調べるとき、自分のほかに「同じ道路」とみなすノード（横断歩道は隣のマスにかかる）
    let lineKeep = false; // ほかの道路の路面の上でも消さない（斜めの大通りの交差点の横断歩道・停止線）
    // 横断歩道の範囲（中心 c から向き u に s1..s2、横は ±hw）。車線の線は、この中では引かない
    const zebra: { cx: number; cz: number; ux: number; uz: number; s1: number; s2: number; hw: number }[] = [];
    const H = (x: number, z: number, fb: number, fw = 0) => (onGround ? (fw > 0 ? lerp(g.groundAt(x, z) + ROAD_LIFT + liftCur, fb, fw) : g.groundAt(x, z) + ROAD_LIFT + liftCur) : fb);
    const trees: TreeSpot[] = [];
    junctionLamps.length = 0;
    junctionPools.length = 0;
    avLampBlock.length = 0;

    // ---- 大通りの下ごしらえ ----
    const AV = RoadType.Avenue;
    const wideLocal = (tt: number) => tt !== 0 && !!ROADS[tt]?.wide && !isHighway(tt);
    const nb = (c: number, d: number) => {
      const qx = (c % n) + DX[d], qy = ((c / n) | 0) + DY[d];
      return g.inb(qx, qy) ? qy * n + qx : -1;
    };
    const groundCell = (c: number) => g.deck[c] === 0 && g.lift[c] <= 0.3;
    // 地上のマスの描く腕。大通りの端の折り返しや、大通り側の斜めのつなぎは描かない
    const armsOf = (i: number) => {
      const t = g.road[i], m = g.conn[i];
      const skip = new Set<number>();
      let taper: { d: number; side: number } | null = null; // この道路の腕 d が、横（side の向き）に広がって大通りにつながる
      let openEnd = -1; // 大通りの車線が、ここで1車線の道路に合流する（反対向きに、マスの端までのばす）
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d))) continue;
        const j = nb(i, d);
        if (j < 0) continue;
        if (!wideLocal(t) && wideLocal(g.road[j]) && !isDiag(d)) {
          // 隣が大通りの車線で、その横の車線にも斜めにつながっている → 広がりながらつなぐ
          for (const p of [(d + 2) & 7, (d + 6) & 7]) {
            const Y = nb(j, p);
            if (Y < 0 || g.road[Y] !== g.road[j]) continue;
            const diag = [1, 3, 5, 7].find((dd) => nb(i, dd) === Y);
            if (diag !== undefined && m & (1 << diag)) {
              taper = { d, side: p };
              skip.add(diag);
            }
          }
        }
        // 大通り側の斜めのつなぎは描かない（地上どうしのつなぎだけ。上空の大通りへ上がる腕は描く）
        if (wideLocal(t) && isDiag(d) && g.arriveLevel(0, j, d) === 0 && !wideLocal(g.road[j]) && g.road[j]) skip.add(d);
        // 大通りの端の折り返し（横の車線へのつなぎ）は描かない。横の車線も同じ向きへ続くときだけ（L字の角のつなぎは描く）
        if (wideLocal(t) && !isDiag(d) && g.road[j] === t && !(m & (1 << ((d + 4) & 7)))) {
          const along = [0, 2, 4, 6].filter((q) => q !== d && q !== ((d + 4) & 7) && m & (1 << q));
          if (along.length === 1 && g.conn[j] & (1 << along[0])) skip.add(d);
        }
      }
      if (wideLocal(t)) {
        // 斜めに1車線の道路へつながっている車線：腕は後ろだけなので、前へのばす
        const diagTo = [1, 3, 5, 7].some((dd) => m & (1 << dd) && skip.has(dd));
        const straight = [0, 2, 4, 6].filter((q) => m & (1 << q) && !skip.has(q));
        if (diagTo && straight.length === 1) openEnd = (straight[0] + 4) & 7;
      }
      const dirs: number[] = [];
      for (let d = 0; d < 8; d++) if (m & (1 << d) && !skip.has(d)) dirs.push(d);
      return { skip, taper, openEnd, dirs };
    };
    const armCache = new Map<number, ReturnType<typeof armsOf>>();
    const arms0 = (i: number) => {
      let a = armCache.get(i);
      if (!a) armCache.set(i, (a = armsOf(i)));
      return a;
    };
    const jcl = this.jctl.length === NC ? this.jctl : null;
    // 地上のマスでも、橋・高架・持ち上げた道路につながるマスは、地面に合わせずに平らに描く（下のマスごとの描き方と同じ判定）
    const ngOf = (j: number, d: number) => {
      const k = nb(j, d);
      return k < 0 || (g.arriveLevel(0, k, d) === 0 && g.deck[k] === 0 && g.lift[k] <= 0.3);
    };
    const flatDrawn = (j: number) => {
      if (j < 0 || j >= NC || !g.road[j] || !groundCell(j)) return false;
      const ds = arms0(j).dirs;
      return ds.length > 0 && ds.length < 3 && ds.some((d) => !ngOf(j, d));
    };

    // 交差点のマス（地上、腕が3本以上）。1 = 大通り、3 = ほかの一般の道路。+1 = 斜めの腕もある（まとめずに、マスごとに描く）
    const jc = new Uint8Array(NC);
    for (let i = 0; i < NC; i++) {
      const t = g.road[i];
      if (!t || isHighway(t) || t === RoadType.Ramp || !groundCell(i)) continue;
      const A = arms0(i);
      if (A.dirs.length >= 3) jc[i] = (t === AV ? 1 : 3) + (A.dirs.some(isDiag) ? 1 : 0);
    }
    // 交差点の側で、歩道や分離帯を削れる隣のマス（地上のまっすぐなマス）
    const clusterOf = new Int32Array(NC).fill(-1);
    const canTrim = (j: number, d: number) => {
      if (j < 0 || jc[j] || !groundCell(j) || g.bstop[j] || g.rail[j]) return false;
      const t = g.road[j];
      if (!t || isHighway(t) || t === RoadType.Ramp) return false;
      const A = arms0(j);
      return A.dirs.length === 2 && !A.taper && A.openEnd < 0 && A.dirs.includes(d) && A.dirs.includes(opp(d));
    };
    // 隣のマスの、交差点の側の端から len だけ、歩道・分離帯を描かない（idx 0：向き d から見て +p 側、1：-p 側）
    const trims = new Map<number, { d: number; len: [number, number] }[]>();
    const addTrim = (j: number, d: number, idx: number, len: number) => {
      let list = trims.get(j);
      if (!list) trims.set(j, (list = []));
      let e = list.find((q) => q.d === d);
      if (!e) list.push((e = { d, len: [0, 0] }));
      e.len[idx] = Math.max(e.len[idx], len);
    };
    // マスのかたまりから交差点の形を作る（まとめられない形なら null）
    const makeCluster = (cells: number[]): Cluster | null => {
      let x0 = n, y0 = n, x1 = -1, y1 = -1;
      for (const c of cells) {
        const x = c % n, y = (c / n) | 0;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw > 2 || bh > 2 || cells.length !== bw * bh) return null;
      const ccx = ((x0 + x1 + 1) / 2) * CELL, ccz = ((y0 + y1 + 1) / 2) * CELL;
      const inSet = new Set(cells);
      const arms: CArm[] = [];
      for (const s of [0, 2, 4, 6]) {
        const ux = DX[s], uz = DY[s], px = -uz, pz = ux;
        const outs = cells
          .filter((c) => !inSet.has(nb(c, s)) && arms0(c).dirs.includes(s))
          .map((c) => ({ c, j: nb(c, s), o: ((c % n) + 0.5) * CELL * px + (((c / n) | 0) + 0.5) * CELL * pz - (ccx * px + ccz * pz) }))
          .sort((p, q) => p.o - q.o);
        if (!outs.length) continue;
        if (outs.length > 2 || outs.some((q) => q.j < 0)) return null;
        const tns = outs.map((q) => g.road[q.j]);
        if (tns.some((tt) => !tt || isHighway(tt) || tt === RoadType.Ramp)) return null;
        const mouth = ((s === 0 || s === 4 ? bw : bh) * CELL) / 2;
        const lane = (q: (typeof outs)[number], hw: number): CLane => ({
          o: q.o, hw, entry: !!(g.flow[q.j] & (1 << opp(s))), exit: !!(g.flow[q.c] & (1 << s)), nn: q.j, trim: false,
        });
        const base = { d: s, ux, uz, px, pz, ang: Math.atan2(uz, ux), mouth, K: 0, xw0: 0, tip: 0, mEnd: 0, stop: 0 };
        if (outs.length === 2) {
          // 分離帯をはさんだ大通りの2本の車線
          if (tns.some((tt) => tt !== AV)) return null;
          const hw = AV_W / 2;
          arms.push({ ...base, lanes: outs.map((q) => lane(q, hw)), lo: outs[0].o - hw, hi: outs[1].o + hw, swLo: AV_SW, swHi: AV_SW, pair: true });
        } else {
          const q = outs[0], tt = tns[0], hw = drawWidth(tt) / 2;
          let swLo = sidewalkOf(tt), swHi = swLo;
          if (tt === AV) {
            // 大通りの1本の車線（反対車線は、かたまりの外を通る）：反対車線の側は分離帯
            const dp = dirOf(px, pz);
            const isAvAt = (dd: number) => {
              const k = nb(q.j, dd);
              return k >= 0 && g.road[k] === AV;
            };
            if (isAvAt(dp)) swHi = 0;
            else if (isAvAt(opp(dp))) swLo = 0;
          }
          arms.push({ ...base, lanes: [lane(q, hw)], lo: q.o - hw, hi: q.o + hw, swLo, swHi, pair: false });
        }
      }
      if (arms.length < 3) return null;
      arms.sort((p, q) => p.ang - q.ang);
      // 制御方式は、かたまりのマスで一番強いもの。大通りの交差点にロータリーは描かない（信号として描く）
      let ctl = 0;
      for (const c of cells) {
        const v = jcl ? jcl[c] : 0;
        ctl = Math.max(ctl, v === 4 ? 3 : v);
      }
      return { cells, cx: ccx, cz: ccz, hx: (bw * CELL) / 2, hz: (bh * CELL) / 2, arms, corners: [], ctl, lift: cells.reduce((s, c) => s + g.lift[c], 0) / cells.length };
    };
    // 大通りの交差点のマスのかたまり。大通りの車線が一般の道路に突き当たるところ（交差点のマスが一般の道路）は、
    // 一般の道路の交差点のマスのかたまりに、分離帯をはさんだ大通りの2本の車線がつながるときだけまとめる
    const clusters: Cluster[] = [];
    {
      const seen = new Uint8Array(NC);
      for (const kind of [1, 3]) {
        for (let i = 0; i < NC; i++) {
          if ((jc[i] !== kind && jc[i] !== kind + 1) || seen[i]) continue;
          const comp: number[] = [];
          const st = [i];
          seen[i] = 1;
          while (st.length) {
            const c = st.pop()!;
            comp.push(c);
            for (const d of [0, 2, 4, 6]) {
              if (!(g.conn[c] & (1 << d))) continue;
              const j = nb(c, d);
              if (j < 0 || seen[j] || (jc[j] !== kind && jc[j] !== kind + 1)) continue;
              seen[j] = 1;
              st.push(j);
            }
          }
          const cl = comp.some((c) => jc[c] === kind + 1) ? null : makeCluster(comp);
          if (!cl || (kind === 3 && !cl.arms.some((a) => a.pair))) continue;
          for (const c of comp) clusterOf[c] = clusters.length;
          clusters.push(cl);
        }
      }
    }
    // 交差点の角の丸み・横断歩道・分離帯の先の位置を決め、隣のマスの歩道と分離帯を削る長さを記録する
    for (const cl of clusters) {
      const A = cl.arms;
      for (const a of A) for (const l of a.lanes) l.trim = canTrim(l.nn, opp(a.d));
      for (let k = 0; k < A.length; k++) {
        const a = A[k], b = A[(k + 1) % A.length];
        const gap = (b.ang - a.ang + Math.PI * 4) % (Math.PI * 2);
        const ka = a.hi, kb = -b.lo;
        if (gap < Math.PI * 0.75) {
          const la = a.lanes[a.lanes.length - 1], lb = b.lanes[0];
          // 隣のマスへ 6m まではみ出してよい（その分、隣の歩道を削る）
          const r = Math.max(0.8, Math.min(CORNER_R, a.mouth + (la.trim ? 6 : 0) - kb, b.mouth + (lb.trim ? 6 : 0) - ka));
          cl.corners.push({ a, b, arc: true, r, ka, kb, med: false });
          if (kb + r > a.mouth + 0.01) addTrim(la.nn, opp(a.d), 1, kb + r - a.mouth);
          if (ka + r > b.mouth + 0.01) addTrim(lb.nn, opp(b.d), 0, ka + r - b.mouth);
        } else cl.corners.push({ a, b, arc: false, r: 0, ka, kb, med: a.swHi === 0 || b.swLo === 0 });
      }
      const sig = cl.ctl === 3;
      for (let k = 0; k < A.length; k++) {
        const a = A[k], next = cl.corners[k], prev = cl.corners[(k + A.length - 1) % A.length];
        a.K = Math.max(next.arc ? next.kb : 0, prev.arc ? prev.ka : 0);
        a.xw0 = a.K + 1.0;
        a.tip = a.K + (sig ? 0.6 : 0.8);
        a.mEnd = a.K + (sig ? 5.5 : 3.5);
        a.stop = a.K + (sig ? SIG_STOP : 1.6);
        if (!a.pair) continue;
        if (!a.lanes.every((l) => l.trim)) {
          a.mEnd = Math.min(a.mEnd, a.mouth);
          a.tip = Math.min(a.tip, a.mEnd - 2);
        }
        // 2本の車線の隣のマスは、分離帯の側（かたまりの中心の側）を削る
        if (a.mEnd > a.mouth + 0.01) {
          addTrim(a.lanes[0].nn, opp(a.d), 1, a.mEnd - a.mouth);
          addTrim(a.lanes[1].nn, opp(a.d), 0, a.mEnd - a.mouth);
        }
      }
    }
    // 大通りの行き止まり：同じ向きに終わる2本の車線を、1つの転回場にまとめる
    const capOf = new Int32Array(NC).fill(-1);
    const caps: { a: number; b: number; d: number; diag?: boolean }[] = [];
    for (let i = 0; i < NC; i++) {
      if (g.road[i] !== AV || !groundCell(i) || clusterOf[i] >= 0 || capOf[i] >= 0) continue;
      const A = arms0(i);
      // 斜めの大通りの行き止まり：斜めの腕と、横の反対車線への折り返しの腕
      if (A.dirs.length === 2 && A.openEnd < 0 && !A.taper) {
        const back = A.dirs.find(isDiag), sd = A.dirs.find((q) => !isDiag(q));
        if (back === undefined || sd === undefined) continue;
        const j = nb(i, sd);
        if (j < 0 || g.road[j] !== AV || !groundCell(j) || capOf[j] >= 0 || clusterOf[j] >= 0) continue;
        const B = arms0(j);
        if (B.dirs.length !== 2 || !B.dirs.includes(back) || !B.dirs.includes(opp(sd)) || B.openEnd >= 0 || B.taper) continue;
        capOf[i] = capOf[j] = caps.length;
        caps.push({ a: i, b: j, d: opp(back), diag: true });
        continue;
      }
      if (A.dirs.length !== 1 || isDiag(A.dirs[0]) || A.openEnd >= 0) continue;
      const back = A.dirs[0];
      for (const sd of [(back + 2) & 7, (back + 6) & 7]) {
        const j = nb(i, sd);
        if (j < 0 || g.road[j] !== AV || !groundCell(j) || capOf[j] >= 0 || clusterOf[j] >= 0) continue;
        const B = arms0(j);
        if (B.dirs.length !== 1 || B.dirs[0] !== back || B.openEnd >= 0) continue;
        capOf[i] = capOf[j] = caps.length;
        caps.push({ a: i, b: j, d: opp(back) });
        break;
      }
    }
    // ---- 斜めの大通りと縦横の大通りの交差点（マスのかたまりが斜めに並ぶ）----
    // 2本の大通りの帯（縁石から縁石まで）が重なる平行四辺形を1つの交差点にする。まわりのマスの歩道・分離帯・線は、
    // 交差点の側を「描かない範囲」で切り取る（斜めの縁でも、ぴったり切れるように）
    const dcls: DCluster[] = [];
    const dclOf = new Int32Array(NC).fill(-1);
    const clipOf = new Map<number, ClipSet>(); // ノード → 描かない範囲
    const cenOf = (c: number): [number, number] => [((c % n) + 0.5) * CELL, (((c / n) | 0) + 0.5) * CELL];
    // 半平面 lo <= n·p <= hi の帯
    const strip = (nx: number, nz: number, lo: number, hi: number): Region => [-nx, -nz, -lo, nx, nz, hi];
    // n1·p = a と n2·p = b の交わる点
    const meet = (n1x: number, n1z: number, a: number, n2x: number, n2z: number, b: number): [number, number] => {
      const det = n1x * n2z - n1z * n2x;
      return [(a * n2z - n1z * b) / det, (n1x * b - a * n2x) / det];
    };
    const makeDiag = (comp: number[]): DCluster | null => {
      if (comp.length > 6) return null;
      const inSet = new Set(comp);
      const bands: DBand[] = [];
      for (const d of [0, 2, 1, 3]) {
        const l = Math.hypot(DX[d], DY[d]), ux = DX[d] / l, uz = DY[d] / l, nx = -uz, nz = ux;
        const qs: number[] = [];
        const outs: { q: number; side: number; j: number }[] = [];
        for (const c of comp) {
          const ds = arms0(c).dirs;
          if (!ds.includes(d) && !ds.includes(opp(d))) continue;
          const [x, z] = cenOf(c), q = x * nx + z * nz;
          if (!qs.some((v) => Math.abs(v - q) < 0.5)) qs.push(q);
          for (const [dd, side] of [[d, 0], [opp(d), 1]]) {
            const j = nb(c, dd);
            if (!ds.includes(dd) || j < 0 || inSet.has(j)) continue;
            if (g.road[j] !== AV || !groundCell(j)) return null;
            outs.push({ q, side, j });
          }
        }
        if (!outs.length) continue; // 中の折り返しのつなぎだけ
        if (qs.length !== 2 || Math.abs(Math.abs(qs[0] - qs[1]) - CELL / l) > 0.5) return null;
        qs.sort((a, b) => a - b);
        const arm: [boolean, boolean] = [false, false];
        for (const side of [0, 1]) {
          const k = qs.filter((q) => outs.some((o) => o.side === side && Math.abs(o.q - q) < 0.5)).length;
          if (k === 1) return null;
          arm[side] = k === 2;
        }
        const flow: [number, number] = [0, 0];
        qs.forEach((q, li) => {
          const o = outs.find((v) => Math.abs(v.q - q) < 0.5);
          if (o) flow[li] = g.flow[o.j] & (1 << d) ? 1 : g.flow[o.j] & (1 << opp(d)) ? -1 : 0;
        });
        const hw = AV_W / 2;
        bands.push({ d, ux, uz, nx, nz, q: [qs[0], qs[1]], arm, flow, lo: qs[0] - hw, hi: qs[1] + hw });
      }
      if (bands.length !== 2 || isDiag(bands[0].d) || !isDiag(bands[1].d)) return null;
      const [A, B] = bands;
      if (+A.arm[0] + +A.arm[1] + +B.arm[0] + +B.arm[1] < 3) return null;
      // どのマスも、どちらかの帯の車線の上にある
      for (const c of comp) {
        const [x, z] = cenOf(c);
        if (![A, B].some((b) => b.q.some((q) => Math.abs(x * b.nx + z * b.nz - q) < 0.5))) return null;
      }
      let ctl = 0;
      for (const c of comp) {
        const v = jcl ? jcl[c] : 0;
        ctl = Math.max(ctl, v === 4 ? 3 : v);
      }
      const [cx, cz] = meet(A.nx, A.nz, (A.q[0] + A.q[1]) / 2, B.nx, B.nz, (B.q[0] + B.q[1]) / 2);
      return { cells: comp, A, B, ctl, lift: comp.reduce((sm, c) => sm + g.lift[c], 0) / comp.length, cx, cz };
    };
    {
      const seen = new Uint8Array(NC);
      for (let i = 0; i < NC; i++) {
        if (jc[i] !== 2 || seen[i]) continue;
        const comp: number[] = [];
        const st = [i];
        seen[i] = 1;
        let ok = true;
        while (st.length) {
          const c = st.pop()!;
          comp.push(c);
          for (let d = 0; d < 8; d++) {
            if (!(g.conn[c] & (1 << d))) continue;
            const j = nb(c, d);
            if (j < 0 || seen[j]) continue;
            if (jc[j] === 1) ok = false; // 斜めの腕のない大通りの交差点のマスとつながる形は、まとめない
            if (jc[j] !== 2) continue;
            seen[j] = 1;
            st.push(j);
          }
        }
        const dc = ok ? makeDiag(comp) : null;
        if (!dc) continue;
        for (const c of comp) dclOf[c] = dcls.length;
        dcls.push(dc);
      }
    }
    // 交差点の形の値：帯 X の腕（side 0 = +u の側）が、もう片方の帯 Y のどちらの側（0 = lo、1 = hi）にあるか
    const sideOn = (X: DBand, side: number, Y: DBand) => ((side === 0 ? 1 : -1) * (X.ux * Y.nx + X.uz * Y.nz) > 0 ? 1 : 0);
    // 帯 X が、Y の側 sy に腕をのばしているか
    const armTo = (X: DBand, Y: DBand, sy: number) => (X.arm[0] && sideOn(X, 0, Y) === sy) || (X.arm[1] && sideOn(X, 1, Y) === sy);
    // 角（A の縁石 sx と B の縁石 sy の交わる点）の形
    interface DCorner { sx: number; sy: number; K: [number, number]; dA: [number, number]; dB: [number, number]; phi: number; r: number; t: number; Ta: [number, number]; Tb: [number, number]; O: [number, number]; bis: [number, number] }
    const cornersOf = (dc: DCluster): DCorner[] => {
      const { A, B } = dc;
      const out: DCorner[] = [];
      for (const sx of [0, 1])
        for (const sy of [0, 1]) {
          if (!armTo(A, B, sy) || !armTo(B, A, sx)) continue;
          const K = meet(A.nx, A.nz, sx ? A.hi : A.lo, B.nx, B.nz, sy ? B.hi : B.lo);
          // A の腕の外向き（B の側 sy へ）、B の腕の外向き（A の側 sx へ）
          const ga = (A.ux * B.nx + A.uz * B.nz > 0) === (sy === 1) ? 1 : -1, gb = (B.ux * A.nx + B.uz * A.nz > 0) === (sx === 1) ? 1 : -1;
          const dA: [number, number] = [A.ux * ga, A.uz * ga], dB: [number, number] = [B.ux * gb, B.uz * gb];
          const phi = Math.acos(Math.max(-1, Math.min(1, dA[0] * dB[0] + dA[1] * dB[1])));
          // 鋭い角（45°）は、歩道の外側の縁がちょうど交わる半径（両側の歩道が重ならない）。鈍い角はふつうの半径
          const r = phi < Math.PI / 2 - 0.01 ? Math.max(AV_SW, 4.5) : CORNER_R;
          const t = r / Math.tan(phi / 2);
          let bx = dA[0] + dB[0], bz = dA[1] + dB[1];
          const bl = Math.hypot(bx, bz) || 1;
          bx /= bl;
          bz /= bl;
          const oc = r / Math.sin(phi / 2);
          out.push({ sx, sy, K, dA, dB, phi, r, t, Ta: [K[0] + dA[0] * t, K[1] + dA[1] * t], Tb: [K[0] + dB[0] * t, K[1] + dB[1] * t], O: [K[0] + bx * oc, K[1] + bz * oc], bis: [bx, bz] });
        }
      return out;
    };
    // 描かない範囲を作る
    for (const dc of dcls) {
      const { A, B } = dc;
      const corners = cornersOf(dc);
      const box = [...strip(A.nx, A.nz, A.lo, A.hi), ...strip(B.nx, B.nz, B.lo, B.hi)];
      const setOf = (X: DBand, Y: DBand, isA: boolean): ClipSet => {
        const walk: Region[] = [];
        for (const sx of [0, 1]) {
          if (!armTo(Y, X, sx)) continue;
          // 縁石の外（側 sx）の歩道の幅の帯で、両側の角の丸みの始まりの間
          const bounds: number[] = [];
          for (const sy of [0, 1]) {
            const cn = corners.find((q) => (isA ? q.sx === sx && q.sy === sy : q.sy === sx && q.sx === sy));
            if (cn) {
              const T = isA ? cn.Ta : cn.Tb;
              bounds.push(T[0] * X.ux + T[1] * X.uz);
            } else {
              // 角がない（X が Y のこの側へのびていない）：Y の縁石の先まで（交差点のマスの中の X の歩道の切れ端を消す）
              const K = meet(X.nx, X.nz, sx ? X.hi : X.lo, Y.nx, Y.nz, sy ? Y.hi : Y.lo);
              const toward = (X.ux * Y.nx + X.uz * Y.nz > 0) === (sy === 1) ? 1 : -1;
              bounds.push(K[0] * X.ux + K[1] * X.uz + toward * 10);
            }
          }
          const wide = AV_SW + 1.5;
          walk.push([...(sx ? strip(X.nx, X.nz, X.hi, X.hi + wide) : strip(X.nx, X.nz, X.lo - wide, X.lo)), ...strip(X.ux, X.uz, Math.min(...bounds), Math.max(...bounds))]);
        }
        return {
          surf: [box],
          med: [[...strip(X.nx, X.nz, X.lo, X.hi), ...strip(Y.nx, Y.nz, Y.lo - 5.5, Y.hi + 5.5)]],
          walk,
          line: [[...strip(X.nx, X.nz, X.lo, X.hi), ...strip(Y.nx, Y.nz, Y.lo - 1, Y.hi + 1)]],
        };
      };
      const sA = setOf(A, B, true), sB = setOf(B, A, false);
      dc.clip = [sA, sB];
      avLampBlock.push(box, ...sA.walk, ...sB.walk);
      // まわりのマス：どちらの帯の車線か（腕の向きと、車線の中心の位置）
      const x0 = Math.min(...dc.cells.map((c) => c % n)) - 3, x1 = Math.max(...dc.cells.map((c) => c % n)) + 3;
      const y0 = Math.min(...dc.cells.map((c) => (c / n) | 0)) - 3, y1 = Math.max(...dc.cells.map((c) => (c / n) | 0)) + 3;
      for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++)
        for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) {
          const c = y * n + x;
          if (dclOf[c] >= 0) continue;
          if (g.road[c] !== AV || !groundCell(c)) continue;
          const ds = arms0(c).dirs, [px, pz] = cenOf(c);
          for (const [X, set] of [[A, sA], [B, sB]] as const)
            if ((ds.includes(X.d) || ds.includes(opp(X.d))) && X.q.some((q) => Math.abs(px * X.nx + pz * X.nz - q) < 0.5)) {
              clipOf.set(c, set);
              break;
            }
        }
    }

    // 斜めの転回場の形：2本の車線の中心の真ん中 o、外向き u、横向き p。車線の横の位置 la・lb、マスの中心の位置 sa・sb、
    // 折り返しの半円の中心の位置 sC、車線の中心の間隔の半分 e
    const diagCap = (c: { a: number; b: number; d: number }) => {
      const ux = DX[c.d] * Math.SQRT1_2, uz = DY[c.d] * Math.SQRT1_2, px = -uz, pz = ux;
      const ax = ((c.a % n) + 0.5) * CELL, az = (((c.a / n) | 0) + 0.5) * CELL, bx = ((c.b % n) + 0.5) * CELL, bz = (((c.b / n) | 0) + 0.5) * CELL;
      const ox = (ax + bx) / 2, oz = (az + bz) / 2;
      const la = (ax - ox) * px + (az - oz) * pz, lb = -la, sa = (ax - ox) * ux + (az - oz) * uz, sb = -sa;
      const P = (s2: number, l: number): [number, number] => [ox + ux * s2 + px * l, oz + uz * s2 + pz * l];
      return { ux, uz, px, pz, la, lb, sa, sb, sC: Math.max(sa, sb) - 1.5, e: Math.abs(la), half: (CELL * Math.SQRT2) / 2, P };
    };
    // 大通りの車線の中心線（反対車線までの距離から、分離帯の幅を決める）
    const segs: number[] = []; // x0, z0, x1, z1, マス
    const segAt = new Map<number, number[]>();
    const addSeg = (x0: number, z0: number, x1: number, z1: number, owner: number) => {
      const id = segs.length / 5;
      segs.push(x0, z0, x1, z1, owner);
      for (let by = Math.floor((Math.min(z0, z1) - 0.01) / CELL); by <= Math.floor((Math.max(z0, z1) + 0.01) / CELL); by++)
        for (let bx = Math.floor((Math.min(x0, x1) - 0.01) / CELL); bx <= Math.floor((Math.max(x0, x1) + 0.01) / CELL); bx++) {
          const key = by * 4096 + bx;
          (segAt.get(key) ?? segAt.set(key, []).get(key)!).push(id);
        }
    };
    // 地上のマスと、上空のマス（地上の高速道路をまたぐ大通り。ノードはマス + NC）
    for (let node = 0; node < 2 * NC; node++) {
      const up = node >= NC, i = up ? node - NC : node;
      if (up ? g.up[i] !== AV : g.road[i] !== AV || clusterOf[i] >= 0) continue;
      if (!up && capOf[i] >= 0 && caps[capOf[i]].diag) {
        // 斜めの転回場：車線の中心線は、後ろの端から折り返しの半円の手前まで
        const c = caps[capOf[i]], q = diagCap(c), mine = c.a === i;
        const [x0, z0] = q.P((mine ? q.sa : q.sb) - q.half, mine ? q.la : q.lb), [x1, z1] = q.P(q.sC, mine ? q.la : q.lb);
        addSeg(x0, z0, x1, z1, node);
        continue;
      }
      const A = up ? { dirs: [0, 1, 2, 3, 4, 5, 6, 7].filter((d) => g.conn1[i] & (1 << d)), openEnd: -1 } : arms0(i);
      const cx = ((i % n) + 0.5) * CELL, cz = (((i / n) | 0) + 0.5) * CELL;
      const ex = (d: number) => cx + (DX[d] * CELL) / 2, ez = (d: number) => cz + (DY[d] * CELL) / 2;
      if (A.dirs.length === 2 && A.dirs[1] !== opp(A.dirs[0])) {
        const [a, b] = A.dirs;
        let qx0 = ex(a), qz0 = ez(a);
        for (let s = 1; s <= 8; s++) {
          const u = s / 8, p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
          const qx = p0 * ex(a) + p1 * cx + p2 * ex(b), qz = p0 * ez(a) + p1 * cz + p2 * ez(b);
          addSeg(qx0, qz0, qx, qz, node);
          qx0 = qx;
          qz0 = qz;
        }
      } else for (const d of A.dirs) addSeg(cx, cz, ex(d), ez(d), node);
      if (A.openEnd >= 0) addSeg(cx, cz, ex(A.openEnd), ez(A.openEnd), node);
    }
    // 点 (x, z) から向き (dx, dz) へのばした線が、ほかのマスの大通りの中心線に当たるまでの距離（なければ Infinity）。
    // 同じ階層（地上どうし、上空どうし）の大通りだけを見る
    const rayHit = (x: number, z: number, dx: number, dz: number, maxD: number, owner: number) => {
      let best = Infinity;
      const ex = x + dx * maxD, ez = z + dz * maxD;
      for (let by = Math.floor(Math.min(z, ez) / CELL); by <= Math.floor(Math.max(z, ez) / CELL); by++)
        for (let bx = Math.floor(Math.min(x, ex) / CELL); bx <= Math.floor(Math.max(x, ex) / CELL); bx++) {
          const list = segAt.get(by * 4096 + bx);
          if (!list) continue;
          for (const id of list) {
            const so = segs[id * 5 + 4];
            if (so === owner || (so >= NC) !== (owner >= NC)) continue;
            const ax = segs[id * 5], az = segs[id * 5 + 1], e2x = segs[id * 5 + 2] - ax, e2z = segs[id * 5 + 3] - az;
            const den = dx * e2z - dz * e2x;
            if (Math.abs(den) < 1e-6) continue;
            const qx = ax - x, qz = az - z;
            const tt = (qx * e2z - qz * e2x) / den, s = (qx * dz - qz * dx) / den;
            if (s >= -1e-3 && s <= 1.001 && tt > 0.8 && tt < best) best = tt;
          }
        }
      return best <= maxD ? best : Infinity;
    };
    // 分離帯の側に反対車線があるか
    const twinAt = (x: number, z: number, nx: number, nz: number, owner: number, range = 22) => {
      if (rayHit(x, z, nx, nz, range, owner) < range) return true;
      const qx = Math.floor((x + nx * 10) / CELL), qz = Math.floor((z + nz * 10) / CELL);
      if (!g.inb(qx, qz)) return false;
      const j = qz * n + qx;
      return owner >= NC ? j !== owner - NC && g.up[j] === AV : j !== owner && g.road[j] === AV;
    };
    // 分離帯の半分の幅：反対車線の中心線までの距離から、2本の車道の分を引いて半分に
    const medWAt = (x: number, z: number, nx: number, nz: number, hw: number, diag: boolean, owner: number) => {
      const d = rayHit(x, z, nx, nz, 26, owner);
      if (d === Infinity) return -(diag ? AV_MED_DIAG : AV_MED); // 負：反対車線が見つからない
      // 反対車線の分離帯と少しだけ重ねる（境目にすき間が見えないように）
      return Math.max(0, Math.min(8, (d - 2 * hw) / 2 + 0.06));
    };

    // ---- 部品 ----
    // 中心線に沿った帯（路面・歩道・線）を作る
    // sides: [左（-p 側）, 右（+p 側）] に歩道や壁、分離帯を付けるか。p は点の並び順に対して右向き
    // 地面に合わせるときは、点を細かくして地形の折れ目に沿わせる
    const densify = (pts: RP[], step: number): RP[] => {
      const out: RP[] = [pts[0]];
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const m = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step);
        for (let s2 = 1; s2 <= m; s2++) {
          const u = s2 / m;
          out.push({ x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), h: lerp(a.h, b.h, u), hw: lerp(a.hw, b.hw, u), sw: lerp(a.sw, b.sw, u), t: b.t, fw: lerp(a.fw ?? 0, b.fw ?? 0, u) });
        }
      }
      return out;
    };
    // 帯の始まりから s の位置に点を入れる（歩道や分離帯を、ちょうどそこで切るため）
    const splitAt = (pts: RP[], cuts: number[]): RP[] => {
      const out: RP[] = [pts[0]];
      let acc = 0;
      const list = [...new Set(cuts)].sort((a, b) => a - b);
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        for (const s of list) {
          const u = (s - acc) / (l || 1);
          if (u > 0.01 && u < 0.99) out.push({ x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), h: lerp(a.h, b.h, u), hw: lerp(a.hw, b.hw, u), sw: lerp(a.sw, b.sw, u), t: b.t, fw: lerp(a.fw ?? 0, b.fw ?? 0, u) });
        }
        out.push(b);
        acc += l;
      }
      return out;
    };
    // 中央分離帯（縁石の線 mp から、分離帯の向きに幅 w）。mode 0：植え込み、1：橋（舗装と低い壁）、2：踏切（舗装だけ）
    const median = (mp: MP[], mode: number, skipSeg: (k: number) => boolean) => {
      const asph = COL.asphalt;
      for (let k = 1; k < mp.length; k++) {
        if (skipSeg(k)) continue;
        const a = mp[k - 1], b = mp[k];
        if (a.w < 0.3 && b.w < 0.3) continue;
        const at = (q: MP, l: number): [number, number] => [q.x + q.nx * l, q.z + q.nz * l];
        if (mode === 3) {
          // 安全地帯：横断歩道が分離帯を渡るところは、縁石の高さの舗装（帯の最後は縁石で閉じる）
          const I0 = at(a, 0), I1 = at(b, 0), O0 = at(a, a.w), O1 = at(b, b.w);
          const h = [I0, O0, O1, I1].map(([x, z], c) => H(x, z, c === 0 || c === 1 ? a.h : b.h));
          O.wall(I0[0], I0[1], h[0] - 0.05, h[0] + KERB, I1[0], I1[1], h[3] - 0.05, h[3] + KERB, COL.curb);
          if (k === mp.length - 1) O.wall(I1[0], I1[1], h[3] - 0.05, h[3] + KERB, O1[0], O1[1], h[2] - 0.05, h[2] + KERB, COL.curb);
          O.aux = [1, a.al, 0, 0];
          const v0 = O.v(I0[0], h[0] + KERB, I0[1], COL.walk), v1 = O.v(O0[0], h[1] + KERB, O0[1], COL.walk);
          O.aux = [1, b.al, 0, 0];
          const v2 = O.v(O1[0], h[2] + KERB, O1[1], COL.walk), v3 = O.v(I1[0], h[3] + KERB, I1[1], COL.walk);
          O.aux = AUX0;
          O.tri(v0, v1, v2);
          O.tri(v0, v2, v3);
          continue;
        }
        if (mode === 2) {
          // 踏切：分離帯の幅も路面にする
          const q = [at(a, 0), at(a, a.w), at(b, b.w), at(b, 0)];
          S.aux = [0, 0, 2, discCode];
          const ids = q.map(([x, z], c) => S.v(x, H(x, z, c < 2 ? a.h : b.h), z, asph));
          S.tri(ids[0], ids[1], ids[2]);
          S.tri(ids[0], ids[2], ids[3]);
          S.aux = AUX0;
          continue;
        }
        if (mode === 1) {
          // 橋：分離帯の幅は車道と同じ高さの路面にして、白いしまの導流帯を描く（歩道に見えないように）。
          // 反対車線との境だけ、幅 1m（半分ずつ）の低いコンクリートの帯に、低い壁を1本
          const sw2 = Math.min(0.5, a.w, b.w), bw = Math.min(0.25, sw2);
          const I0 = at(a, 0), I1 = at(b, 0), K0 = at(a, a.w - sw2), K1 = at(b, b.w - sw2), O0 = at(a, a.w), O1 = at(b, b.w), B0 = at(a, a.w - bw), B1 = at(b, b.w - bw);
          const ha = H(I0[0], I0[1], a.h), hb = H(I1[0], I1[1], b.h);
          // 路面（縁石の線から、コンクリートの帯まで）
          S.aux = [0, 0, 2, discCode];
          const rs = [I0, K0, K1, I1].map(([x, z], c) => S.v(x, c === 0 || c === 1 ? ha : hb, z, asph));
          S.tri(rs[0], rs[1], rs[2]);
          S.tri(rs[0], rs[2], rs[3]);
          S.aux = AUX0;
          // 導流帯のしま：45° に 4m ごと。2本の車線の分がまん中でつながる（同じ向きの斜めの線になる）
          {
            let tx = b.x - a.x, tz = b.z - a.z;
            const tl = Math.hypot(tx, tz) || 1;
            tx /= tl;
            tz /= tl;
            if (b.al < a.al) { tx = -tx; tz = -tz; }
            const nx = (a.nx + b.nx) / 2, nz = (a.nz + b.nz) / 2;
            const sg = nx * tz - nz * tx > 0 ? 1 : -1;
            const w0 = 0.3, w1 = Math.min(a.w, b.w) - sw2 - 0.15;
            const lo = Math.min(a.al, b.al), hi = Math.max(a.al, b.al);
            // 斜めの区間の細い分離帯には描かない（短いしまが散らばって見えるので）
            if (w1 > w0 + 2)
              for (let s = Math.ceil((lo - (w1 - w0)) / 4) * 4; s < hi + (w1 - w0); s += 4) {
                // しまの始まり s（縁石の線の上）から、分離帯の向きへ w、道に沿って sg*(w - w0) 進む
                const P = (w: number): RP | null => {
                  const al = s + sg * (w - w0);
                  if (al < lo || al > hi) return null;
                  const u = (al - a.al) / (b.al - a.al || 1);
                  return { x: lerp(a.x, b.x, u) + nx * w, z: lerp(a.z, b.z, u) + nz * w, h: lerp(a.h, b.h, u), hw: 0, sw: 0, t: 0 };
                };
                // 区間の中に入る部分だけ
                const ws = Math.max(w0, sg > 0 ? w0 + lo - s : w0 + s - hi) + 1e-4, we = Math.min(w1, sg > 0 ? w0 + hi - s : w0 + s - lo) - 1e-4;
                const pa = P(ws), pb = P(we);
                if (!pa || !pb || we - ws < 0.2) continue;
                // 高さは区間の中の位置から（床版の坂の上でも路面に埋もれないように）
                line([pa, pb], () => 0, COL.white, 0.45);
              }
          }
          // コンクリートの帯と低い壁
          const hK0 = ha + KERB, hK1 = hb + KERB;
          O.wall(K0[0], K0[1], ha - 0.05, hK0, K1[0], K1[1], hb - 0.05, hK1, COL.curb);
          if (medSkirt) O.wall(O0[0], O0[1], ha - 1.2, hK0, O1[0], O1[1], hb - 1.2, hK1, COL.concrete);
          const v = [O.v(K0[0], hK0, K0[1], COL.concrete), O.v(O0[0], hK0, O0[1], COL.concrete), O.v(O1[0], hK1, O1[1], COL.concrete), O.v(K1[0], hK1, K1[1], COL.concrete)];
          O.tri(v[0], v[1], v[2]);
          O.tri(v[0], v[2], v[3]);
          if (bw > 0.05) {
            const up = 0.8;
            O.wall(B0[0], B0[1], hK0 - 0.02, hK0 + up, B1[0], B1[1], hK1 - 0.02, hK1 + up, COL.barrier);
            const u = [O.v(B0[0], hK0 + up, B0[1], COL.barrier), O.v(O0[0], hK0 + up, O0[1], COL.barrier), O.v(O1[0], hK1 + up, O1[1], COL.barrier), O.v(B1[0], hK1 + up, B1[1], COL.barrier)];
            O.tri(u[0], u[1], u[2]);
            O.tri(u[0], u[2], u[3]);
          }
          continue;
        }
        // 植え込み：縁石（0.25m の石）と芝、縁石ぞいの低い植え込み
        const st = (q: MP) => Math.min(0.25, q.w);
        const I0 = at(a, 0), I1 = at(b, 0), T0 = at(a, st(a)), T1 = at(b, st(b)), O0 = at(a, a.w), O1 = at(b, b.w);
        const hI0 = H(I0[0], I0[1], a.h, a.fw), hI1 = H(I1[0], I1[1], b.h, b.fw), hT0 = H(T0[0], T0[1], a.h, a.fw), hT1 = H(T1[0], T1[1], b.h, b.fw);
        const hO0 = H(O0[0], O0[1], a.h, a.fw), hO1 = H(O1[0], O1[1], b.h, b.fw);
        const gr = onGround && (a.free || b.free), skirt = medSkirt;
        // 縁石ぞいの植え込み（幅が 2m 以上のところ）
        let hedge: number[][] | null = null;
        if (a.w >= 2 && b.w >= 2) {
          const l0 = 0.65, l1a = Math.min(1.85, a.w - 0.35), l1b = Math.min(1.85, b.w - 0.35);
          const hh = (q: MP) => 0.55 + 0.25 * ((hashInt(Math.round(q.x * 2), Math.round(q.z * 2)) & 255) / 255);
          const sec = (q: MP, l1: number) => {
            const prof = [[l0, 0], [l0 + 0.15, 0.62], [(l0 + l1) / 2, 1], [l1 - 0.15, 0.62], [l1, 0]];
            const hq = hh(q);
            return prof.map(([l, f]) => {
              const [x, z] = at(q, l);
              return [x, H(x, z, q.h, q.fw) + KERB + f * hq, z, l, f * hq];
            });
          };
          hedge = [...sec(a, l1a), ...sec(b, l1b)];
        }
        // 並木（ケヤキ）の位置：道に沿って 8m ごと、縁石から 2.75m（2本の車線の分で2列になる）
        const tq: TreeSpot[] = [];
        if (a.w >= 3 && b.w >= 3) {
          for (let s = Math.ceil((Math.min(a.al, b.al) - 4) / 8) * 8 + 4; s < Math.max(a.al, b.al); s += 8) {
            const u = (s - a.al) / (b.al - a.al || 1);
            if (u < 0 || u >= 1) continue;
            const x = lerp(a.x, b.x, u) + lerp(a.nx, b.nx, u) * 2.75, z = lerp(a.z, b.z, u) + lerp(a.nz, b.nz, u) * 2.75;
            const hs = (hashInt(Math.round(x), Math.round(z)) & 255) / 255;
            // 形は丸い広葉樹（ケヤキ）にそろえ、葉の色は夏の緑の中で少しだけ変える
            tq.push({ x, y: H(x, z, lerp(a.h, b.h, u), lerp(a.fw ?? 0, b.fw ?? 0, u)) + KERB, z, s: 0.85 + hs * 0.2, kind: 0, shape: 0, col: ZELKOVA[(hs * ZELKOVA.length) | 0] });
          }
        }
        const nx = (a.nx + b.nx) / 2, nz = (a.nz + b.nz) / 2;
        medQ.push({
          o: S.owner,
          trees: tq,
          p: [T0[0], hT0, T0[1], O0[0], hO0, O0[1], O1[0], hO1, O1[1], T1[0], hT1, T1[1]],
          draw: () => {
            O.wall(I0[0], I0[1], hI0 - 0.05, hI0 + KERB, I1[0], I1[1], hI1 - 0.05, hI1 + KERB, COL.curb);
            O.aux = [0, a.al, 0, 0];
            const s0 = O.v(I0[0], hI0 + KERB, I0[1], COL.walk), s1 = O.v(T0[0], hT0 + KERB, T0[1], COL.walk);
            O.aux = [0, b.al, 0, 0];
            const s2 = O.v(T1[0], hT1 + KERB, T1[1], COL.walk), s3 = O.v(I1[0], hI1 + KERB, I1[1], COL.walk);
            O.aux = AUX0;
            O.tri(s0, s1, s2);
            O.tri(s0, s2, s3);
            const g0 = O.v(T0[0], hT0 + KERB, T0[1], COL.grass), g1 = O.v(O0[0], hO0 + KERB, O0[1], COL.grass);
            const g2 = O.v(O1[0], hO1 + KERB, O1[1], COL.grass), g3 = O.v(T1[0], hT1 + KERB, T1[1], COL.grass);
            O.tri(g0, g1, g2);
            O.tri(g0, g2, g3);
            // 外側の縁（反対車線の分離帯と合わさらないところで、地面とのすき間を隠す）
            if (gr || skirt) O.wall(O0[0], O0[1], hO0 - 1.2, hO0 + KERB - 0.03, O1[0], O1[1], hO1 - 1.2, hO1 + KERB - 0.03, COL.curb);
            if (hedge) {
              // 丸い断面（5点）を、なめらかな向きの頂点でつなぐ（両端の断面で 10 頂点）
              const ids = hedge.map((q, k) => {
                const nl = HEDGE_N[k % 5];
                return O.v(q[0], q[1], q[2], COL.hedge, nx * nl[0], nl[1], nz * nl[0]);
              });
              for (let f = 0; f < 4; f++) {
                O.tri(ids[f], ids[f + 1], ids[f + 6]);
                O.tri(ids[f], ids[f + 6], ids[f + 5]);
              }
            }
          },
        });
      }
    };
    // 分離帯の先（植え込みの丸い端の、片側の車線の分）。e：帯の端の中心線上の点、u：外向き、n：分離帯の向き
    const noseQ = (ex: number, ez: number, fb: number, ux: number, uz: number, nx: number, nz: number, hw: number, mw: number) => {
      const P = (s: number, l: number): [number, number] => [ex + ux * s + nx * l, ez + uz * s + nz * l];
      // 先の横の路面
      const q = [P(-mw, hw), P(-mw, hw + mw), P(0, hw + mw), P(0, hw)];
      S.aux = [0, 0, 2, discCode];
      const ids = q.map(([x, z]) => S.v(x, H(x, z, fb), z, COL.asphalt));
      S.tri(ids[0], ids[1], ids[2]);
      S.tri(ids[0], ids[2], ids[3]);
      S.aux = AUX0;
      // 丸い先：中心は反対車線との境
      const [kx, kz] = P(-mw, hw + mw);
      const seg = 8;
      const arc: [number, number][] = [], inner: [number, number][] = [];
      for (let s = 0; s <= seg; s++) {
        const th = (s / seg) * (Math.PI / 2);
        arc.push(P(-mw + mw * Math.sin(th), hw + mw - mw * Math.cos(th)));
        const r2 = Math.max(0.1, mw - 0.25);
        inner.push(P(-mw + r2 * Math.sin(th), hw + mw - r2 * Math.cos(th)));
      }
      const hk = H(kx, kz, fb) + KERB;
      const c0 = O.v(kx, hk, kz, COL.grass);
      for (let s = 0; s < seg; s++) {
        const [x0, z0] = arc[s], [x1, z1] = arc[s + 1], [i0x, i0z] = inner[s], [i1x, i1z] = inner[s + 1];
        const h0 = H(x0, z0, fb), h1 = H(x1, z1, fb), hi0 = H(i0x, i0z, fb), hi1 = H(i1x, i1z, fb);
        O.wall(x0, z0, h0 - 0.05, h0 + KERB, x1, z1, h1 - 0.05, h1 + KERB, COL.curb);
        const s0 = O.v(x0, h0 + KERB, z0, COL.walk), s1 = O.v(x1, h1 + KERB, z1, COL.walk), s2 = O.v(i1x, hi1 + KERB, i1z, COL.walk), s3 = O.v(i0x, hi0 + KERB, i0z, COL.walk);
        O.tri(s0, s1, s2);
        O.tri(s0, s2, s3);
        O.tri(c0, O.v(i0x, hi0 + KERB, i0z, COL.grass), O.v(i1x, hi1 + KERB, i1z, COL.grass));
      }
    };
    // 縁石の線に沿った歩道（外向きの向きと幅つき）
    const walkAlong = (pts: { x: number; z: number; nx: number; nz: number; w: number }[], fb: number) => {
      let prev: number[] | null = null;
      for (const q of pts) {
        const ox = q.x + q.nx * q.w, oz = q.z + q.nz * q.w;
        const hi = H(q.x, q.z, fb), ho = H(ox, oz, fb);
        if (prev) {
          const walls = [[prev[0], prev[1], prev[2] - 0.05, prev[2] + 0.16, q.x, q.z, hi - 0.05, hi + 0.16]];
          if (onGround) walls.push([prev[3], prev[4], prev[5] - 1.2, prev[5] + 0.16, ox, oz, ho - 1.2, ho + 0.16]);
          walkQ.push({ p: [prev[0], prev[2] + 0.16, prev[1], prev[3], prev[5] + 0.16, prev[4], ox, ho + 0.16, oz, q.x, hi + 0.16, q.z], w: walls, o: S.owner });
        }
        prev = [q.x, q.z, hi, ox, oz, ho];
      }
    };
    // drop：ほかの帯の下に置く分（m）。分かれ道の帯が本線と重なるところで、本線の模様を見せる
    // ex.endN：帯の両端の横向き（カーブの帯の端の断面を、隣のマスのまっすぐな帯とそろえて、すき間をなくす）
    const ribbon = (pts0: RP[], t: number, sides: [Side, Side] = [true, true], fixedN?: [number, number], drop = 0, ex?: { cut?: Cut[]; medMode?: number; endN?: [number, number][]; zones?: MedZone[] }) => {
      if (pts0.length < 2) return;
      const cut = ex?.cut ?? [];
      const zones = ex?.zones ?? [];
      const splits = [...cut.flatMap((c) => [c.s0, c.s1]), ...zones.flatMap((z) => [z.s0, z.s1])];
      const src = splits.length ? splitAt(pts0, splits) : pts0;
      const pts = onGround && !fixedN ? densify(src, 3.5) : src;
      const conc = isConc(t);
      const asph = surfCol(t, conc);
      const L: number[] = [], R: number[] = [];
      const nrm = pts.map((p, k) => {
        if (fixedN) return fixedN;
        if (ex?.endN && (k === 0 || k === pts.length - 1)) return ex.endN[k === 0 ? 0 : 1];
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        return [-dz / l, dx / l];
      });
      // 路面の模様の座標（横の位置、道に沿った位置）。隣のマスの帯と模様がつながるよう、向きをそろえる
      const first = pts[0], last = pts[pts.length - 1];
      const flip = last.x - first.x < -1e-3 || (Math.abs(last.x - first.x) <= 1e-3 && last.z < first.z);
      const sgn = flip ? -1 : 1;
      const tanAt = (k: number) => [nrm[k][1] * sgn, -nrm[k][0] * sgn];
      const acc = [0];
      for (let k = 1; k < pts.length; k++) acc.push(acc[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      const tot = acc[acc.length - 1];
      const k0 = flip ? pts.length - 1 : 0;
      const t0 = tanAt(k0);
      const a0 = pts[k0].x * t0[0] + pts[k0].z * t0[1];
      const along = acc.map((s0) => a0 + (flip ? tot - s0 : s0));
      // 同じまっすぐな道は同じ乱数（道ごとの色の違い）
      const seed = hashInt(Math.round((pts[k0].z * t0[0] - pts[k0].x * t0[1]) / 4), Math.round(Math.atan2(t0[1], t0[0]) * 4));
      const kind = conc ? SURF.concrete : t === AV ? SURF.avenue : SURF.asphalt;
      const code = surfCode(lanesOf(t), kind, sidewalkOf(t) > 0 && !hasBarrier(t), seed);
      pts.forEach((p, k) => {
        const [px, pz] = nrm[k];
        const lx = p.x - px * p.hw, lz = p.z - pz * p.hw, rx = p.x + px * p.hw, rz = p.z + pz * p.hw;
        S.aux = [-p.hw * sgn, along[k], p.hw, code];
        L.push(S.v(lx, H(lx, lz, p.h, p.fw) - drop, lz, asph));
        S.aux = [p.hw * sgn, along[k], p.hw, code];
        R.push(S.v(rx, H(rx, rz, p.h, p.fw) - drop, rz, asph));
      });
      S.aux = AUX0;
      for (let k = 0; k + 1 < pts.length; k++) {
        S.tri(L[k], R[k], R[k + 1]);
        S.tri(L[k], R[k + 1], L[k + 1]);
      }
      // 都市高速の高架：欄干と桁を、新しい断面で（cut の範囲は欄干を付けない）
      if (viaCur && hasBarrier(t)) {
        // 区間 k（点 k から k+1）の真ん中が cut の中なら、欄干を付けない
        const segOk = (si: number, k: number) => sides[si] === true && (k + 1 >= pts.length || !cut.some((c) => c.side === si && (acc[k] + acc[k + 1]) / 2 > c.s0 && (acc[k] + acc[k + 1]) / 2 < c.s1));
        via(pts.map((p, k): VP => ({ x: p.x, z: p.z, h: p.h - drop, nx: nrm[k][0], nz: nrm[k][1], e: [p.hw, p.hw], hs: [p.h - drop, p.h - drop], para: [sides[0] === true, sides[1] === true], sp: [segOk(0, k), segOk(1, k)] })));
        return;
      }
      // 歩道（縁石つき）、高速道路の壁、または中央分離帯
      for (const side of [-1, 1]) {
        const si = side < 0 ? 0 : 1;
        const sk = sides[si];
        if (!sk) continue;
        const cutSeg = (k: number) => {
          const mid = (acc[k - 1] + acc[k]) / 2;
          return cut.some((c) => c.side === si && mid > c.s0 && mid < c.s1);
        };
        if (sk === 'med') {
          const mp = pts.map((p, k): MP => {
            const nx = side * nrm[k][0], nz = side * nrm[k][1];
            const diag = Math.abs(nrm[k][0]) > 0.3 && Math.abs(nrm[k][1]) > 0.3;
            const mw = medWAt(p.x, p.z, nx, nz, p.hw, diag, S.owner);
            return { x: p.x + nx * p.hw, z: p.z + nz * p.hw, nx, nz, w: Math.abs(mw), h: p.h, al: along[k], free: mw < 0, fw: p.fw };
          });
          if (zones.length) {
            // 帯の z.s0..z.s1 の分離帯は、別の形（安全地帯の舗装、橋と同じ低い壁など）
            const zoneOf = (k: number) => {
              const mid = (acc[k - 1] + acc[k]) / 2;
              return zones.find((z) => mid > z.s0 && mid < z.s1);
            };
            median(mp, ex?.medMode ?? 0, (k) => cutSeg(k) || !!zoneOf(k));
            for (const z of zones) median(mp, z.mode, (k) => cutSeg(k) || zoneOf(k) !== z);
          } else median(mp, ex?.medMode ?? 0, cutSeg);
          continue;
        }
        const walk = pts.map((p) => p.sw);
        const barrier = hasBarrier(t);
        if (!barrier && walk.every((w) => w <= 0)) continue;
        let prevIn = -1, prevOut = -1;
        let prev: number[] | null = null; // [内側 x, z, 高さ, 外側 x, z, 高さ]
        const up = barrier ? 0.95 : 0.16;
        pts.forEach((p, k) => {
          const [px, pz] = nrm[k];
          const ix = p.x + side * px * p.hw, iz = p.z + side * pz * p.hw;
          const wv = barrier ? 0.55 : p.sw;
          const ox = ix + side * px * wv, oz = iz + side * pz * wv;
          const hi = H(ix, iz, p.h, p.fw), ho = H(ox, oz, p.h, p.fw);
          if (barrier) {
            const a = O.v(ix, hi + up, iz, COL.barrier), b = O.v(ox, ho + up, oz, COL.barrier);
            if (k > 0 && prev && !cutSeg(k)) {
              O.tri(prevIn, prevOut, b);
              O.tri(prevIn, b, a);
              O.wall(prev[0], prev[1], prev[2] - 0.05, prev[2] + up, ix, iz, hi - 0.05, hi + up, COL.barrier);
            }
            prevIn = a;
            prevOut = b;
          } else if (prev && (p.sw > 0.05 || pts[k - 1].sw > 0.05) && !cutSeg(k)) {
            const walls = [[prev[0], prev[1], prev[2] - 0.05, prev[2] + up, ix, iz, hi - 0.05, hi + up]];
            // 歩道の外側の縁（地面とのすき間を隠す）
            if (onGround) walls.push([prev[3], prev[4], prev[5] - 1.2, prev[5] + up, ox, oz, ho - 1.2, ho + up]);
            walkQ.push({ p: [prev[0], prev[2] + up, prev[1], prev[3], prev[5] + up, prev[4], ox, ho + up, oz, ix, hi + up, iz], w: walls, o: S.owner });
          }
          prev = [ix, iz, hi, ox, oz, ho];
        });
      }
    };
    // 中心線からの距離 off の位置に線を引く（dash = 破線）
    let lineN: [number, number] | null = null; // 線の横向きを固定する（広がるつなぎ目）
    let lineEnds: [[number, number], [number, number]] | null = null; // 両端の横向き（カーブの帯の端を、隣のマスの帯とそろえる）
    const line = (pts: RP[], off: (p: RP) => number, c: THREE.Color, width = 0.16, dash = false) => {
      if (pts.length < 2) return;
      // 点ごとの横向き：両隣の区間の向きの間（角の外側で線が切れないよう、1/cos(半分の角) だけのばす）
      const sn: ([number, number] | null)[] = [];
      for (let k = 0; k + 1 < pts.length; k++) {
        const dx = pts[k + 1].x - pts[k].x, dz = pts[k + 1].z - pts[k].z, l = Math.hypot(dx, dz);
        sn.push(l < 1e-3 ? null : [-dz / l, dx / l]);
      }
      const segN = (k: number): [number, number] => {
        for (let q = k; q >= 0; q--) if (sn[q]) return sn[q]!;
        for (let q = k; q < sn.length; q++) if (sn[q]) return sn[q]!;
        return [1, 0];
      };
      const vn = pts.map((_, k): [number, number] => {
        if (lineN) return lineN;
        if (k === 0) return lineEnds ? lineEnds[0] : segN(0);
        if (k === pts.length - 1) return lineEnds ? lineEnds[1] : segN(k - 1);
        const p = segN(k - 1), q = sn[k] ?? p;
        const mx = p[0] + q[0], mz = p[1] + q[1], ml = Math.hypot(mx, mz);
        if (ml < 1e-3) return p;
        const ux = mx / ml, uz = mz / ml, cs = Math.max(0.5, ux * p[0] + uz * p[1]);
        return [ux / cs, uz / cs];
      });
      let acc = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz);
        if (l < 1e-3) continue;
        const na = vn[k], nb2 = vn[k + 1];
        // 破線は 3m 引いて 6m 空ける
        const steps = dash ? Math.max(1, Math.ceil(l / 1.5)) : onGround ? Math.max(1, Math.ceil(l / 3.5)) : 1;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const mid = acc + l * (t0 + t1) * 0.5;
          if (dash && mid % 9 > 3) continue;
          const pa = { x: lerp(a.x, b.x, t0), z: lerp(a.z, b.z, t0), h: lerp(a.h, b.h, t0), o: lerp(off(a), off(b), t0), t: t0, fw: lerp(a.fw ?? 0, b.fw ?? 0, t0) };
          const pb = { x: lerp(a.x, b.x, t1), z: lerp(a.z, b.z, t1), h: lerp(a.h, b.h, t1), o: lerp(off(a), off(b), t1), t: t1, fw: lerp(a.fw ?? 0, b.fw ?? 0, t1) };
          const mv = (q: { x: number; z: number; h: number; o: number; t: number; fw: number }, o: number) => {
            const px = lerp(na[0], nb2[0], q.t), pz = lerp(na[1], nb2[1], q.t);
            const vx = q.x + px * o, vz = q.z + pz * o;
            return [vx, H(vx, vz, q.h, q.fw) + 0.02, vz];
          };
          lineQ.push({ p: [...mv(pa, pa.o - width / 2), ...mv(pa, pa.o + width / 2), ...mv(pb, pb.o + width / 2), ...mv(pb, pb.o - width / 2)], c, o: S.owner, o2: lineAlso, zb: lineZb, k: lineKeep });
        }
        acc += l;
      }
    };
    // 2点を結ぶ線（横断歩道のしま、停止線など）
    const seg2 = (x0: number, z0: number, x1: number, z1: number, h: number, c: THREE.Color, width: number) =>
      line([{ x: x0, z: z0, h, hw: 0, sw: 0, t: 0 }, { x: x1, z: z1, h, hw: 0, sw: 0, t: 0 }], () => 0, c, width);
    // 道路の種類ごとの線
    const markings = (pts: RP[], t: number) => {
      const edge = (side: number) => (p: RP) => side * (p.hw - 0.35);
      switch (t) {
        case RoadType.Road:
          line(pts, () => -0.16, COL.yellow, 0.13);
          line(pts, () => 0.16, COL.yellow, 0.13);
          line(pts, edge(-1), COL.white, 0.14);
          line(pts, edge(1), COL.white, 0.14);
          break;
        case RoadType.OneWay:
          line(pts, () => 0, COL.white, 0.14, true);
          line(pts, edge(-1), COL.white, 0.14);
          line(pts, edge(1), COL.white, 0.14);
          break;
        case RoadType.Avenue:
          // 片側2車線：車線の境の破線と、両側の外側線（路肩 0.25m の内側）
          line(pts, () => 0, COL.white, 0.14, true);
          line(pts, (p) => -(p.hw - 0.33), COL.white, 0.15);
          line(pts, (p) => p.hw - 0.33, COL.white, 0.15);
          break;
        case RoadType.Highway:
        case RoadType.GroundHighway:
          line(pts, (p) => -p.hw / 3 + 0.4, COL.white, 0.15, true);
          line(pts, (p) => p.hw / 3 - 0.4, COL.white, 0.15, true);
          line(pts, (p) => -(p.hw - 0.9), COL.yellow, 0.16);
          line(pts, (p) => p.hw - 0.9, COL.white, 0.16);
          break;
        case RoadType.UrbanHighway:
        case RoadType.UrbanGroundHighway:
          // 片側1車線：中央の黄色の2本線と、両端の白線
          line(pts, () => -0.16, COL.yellow, 0.14);
          line(pts, () => 0.16, COL.yellow, 0.14);
          line(pts, (p) => -(p.hw - 0.45), COL.white, 0.15);
          line(pts, (p) => p.hw - 0.45, COL.white, 0.15);
          break;
        case RoadType.UrbanHighway1W:
        case RoadType.UrbanGroundHighway1W:
          // 一方通行2車線：真ん中に白の破線、両端に白線
          line(pts, () => 0, COL.white, 0.14, true);
          line(pts, (p) => -(p.hw - 0.45), COL.white, 0.15);
          line(pts, (p) => p.hw - 0.45, COL.white, 0.15);
          break;
        case RoadType.Ramp:
          // ランプ：両端の白線（真ん中の線はない1車線）
          line(pts, (p) => -(p.hw - 0.4), COL.white, 0.15);
          line(pts, (p) => p.hw - 0.4, COL.white, 0.15);
          break;
      }
    };
    // 円（転回場、ラウンドアバウト、つなぎ目）
    // 路面の円は、すき間を埋めるためのものなので、帯より少しだけ下に置く（重なったところは帯の模様を見せる）
    const disc = (cx: number, cz: number, h: number, r: number, c: THREE.Color, buf: Buf = S, seg = 20, drop = buf === S ? (onGround ? 0.03 : 0.4) : 0) => {
      const dh = h - H(cx, cz, h) - drop; // 島など、路面より高いものはその分だけ持ち上げる
      if (buf === S) S.aux = [0, 0, r, discCode]; // ふちからの距離（中心で r）
      const ci = buf.v(cx, h - drop, cz, c);
      if (buf === S) S.aux = [0, 0, 0, discCode];
      const ring: number[] = [];
      const tilt = buf === S && !onGround;
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const rx = cx + Math.cos(a) * r, rz = cz + Math.sin(a) * r;
        ring.push(buf.v(rx, H(rx, rz, h) + dh + (tilt ? gradX * (rx - cx) + gradZ * (rz - cz) : 0), rz, c));
      }
      for (let s = 0; s < seg; s++) buf.tri(ci, ring[s], ring[(s + 1) % seg]);
      if (buf === S) S.aux = AUX0;
    };
    // 円弧の歩道
    const ringWalk = (cx: number, cz: number, h: number, r0: number, r1: number, a0: number, a1: number) => {
      const seg = 16;
      for (let s = 0; s <= seg; s++) {
        const a = a0 + ((a1 - a0) * s) / seg;
        const cs = Math.cos(a), sn = Math.sin(a);
        const ix = cx + cs * r0, iz = cz + sn * r0, ox = cx + cs * r1, oz = cz + sn * r1;
        const hi = H(ix, iz, h), ho = H(ox, oz, h);
        if (s > 0) {
          const ap = a0 + ((a1 - a0) * (s - 1)) / seg;
          const qx = cx + Math.cos(ap) * r0, qz = cz + Math.sin(ap) * r0, hq = H(qx, qz, h);
          const rx = cx + Math.cos(ap) * r1, rz = cz + Math.sin(ap) * r1, hr = H(rx, rz, h);
          const walls = [[qx, qz, hq - 0.05, hq + 0.16, ix, iz, hi - 0.05, hi + 0.16]];
          if (onGround) walls.push([rx, rz, hr - 1.2, hr + 0.16, ox, oz, ho - 1.2, ho + 0.16]);
          walkQ.push({ p: [qx, hq + 0.16, qz, rx, hr + 0.16, rz, ox, ho + 0.16, oz, ix, hi + 0.16, iz], w: walls, o: S.owner });
        }
      }
    };
    // ---- 都市高速の高架の断面 ----
    // 路面の縁に細い欄干（高さ 0.9m、厚さ 0.25m）と、そのまま下に続く床版の縁（路面から 0.38m）。境に小さな水切りの溝。
    // 床版は 1.3〜1.5m 張り出し、その奥に下すぼまりの桁（側面は 18° の傾き）。下面と桁は暗くして、陰で薄く見せる。
    // 路面が地面から 2.5m より低いところは、桁の代わりに地面まで擁壁を立てる（桁との境は橋台の面でふさぐ）
    // 頂点は点ごとに共有して、カーブでも面がすき間なくつながるようにする
    const PAR_H = 0.9, PAR_T = 0.25, FAS = 0.38, WALL_H = 2.5;
    const VIA_MAIN = { over: 1.5, depth: 1.25 }, VIA_RAMP = { over: 1.3, depth: 1.0 };
    const SL_C = Math.cos((18 * Math.PI) / 180), SL_S = Math.sin((18 * Math.PI) / 180), SL_T = Math.tan((18 * Math.PI) / 180);
    let viaCur = false; // いまのノードは都市高速の高架（欄干と桁を、この断面で描く）
    // 外向きの向き (ox, oy, oz) に合わせて、四角形を足す
    const quadO = (a: number, b: number, c: number, d: number, ox: number, oy: number, oz: number) => {
      const P = O.P;
      const e1x = P[c * 3] - P[a * 3], e1y = P[c * 3 + 1] - P[a * 3 + 1], e1z = P[c * 3 + 2] - P[a * 3 + 2];
      const e2x = P[d * 3] - P[b * 3], e2y = P[d * 3 + 1] - P[b * 3 + 1], e2z = P[d * 3 + 2] - P[b * 3 + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (nx * ox + ny * oy + nz * oz >= 0) O.I.push(a, b, c, a, c, d);
      else O.I.push(a, c, b, a, d, c);
    };
    // 両面の四角形（橋台の面、欄干の端など）
    const quad2 = (q: number[][], c: THREE.Color) => {
      const ids = q.map((p) => O.v(p[0], p[1], p[2], c, 0, 0, 0));
      const P = q;
      const e1 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]], e2 = [P[3][0] - P[1][0], P[3][1] - P[1][1], P[3][2] - P[1][2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      ids.forEach((v) => { O.N[v * 3] = nx; O.N[v * 3 + 1] = ny; O.N[v * 3 + 2] = nz; });
      O.I.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3], ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
    };
    interface VP {
      x: number; z: number; h: number;
      nx: number; nz: number; // 右（+ の側）向きの横向き（両隣の区間の平均）
      e: [number, number]; // 中心から路面の縁まで（左、右）
      hs: [number, number]; // 縁の路面の高さ
      para: [boolean, boolean]; // 欄干があるか（ない側は、床版の縁だけ）。区間は両端の点にあるときだけ
      sp?: [boolean, boolean]; // 点 k から次の点までの区間に、欄干があるか（あれば para より優先）
    }
    const via = (V: VP[], spec = VIA_MAIN) => {
      const nP = V.length;
      if (nP < 2) return;
      const gr = V.map((p) => p.h - g.groundAt(p.x, p.z));
      // 区間の形：0 = 桁、1 = 擁壁、2 = 薄い床版（幅が狭い所。本線と合わさるランプの端）
      const style = (k: number) => (gr[k] < WALL_H || gr[k + 1] < WALL_H ? 1 : Math.min(V[k].e[0] + V[k].e[1], V[k + 1].e[0] + V[k + 1].e[1]) < 4 ? 2 : 0);
      const cache = new Map<number, number>();
      // 点 k の断面の位置（横 o、高さ y）の頂点。rail ごとに点で共有する
      const vx = (rail: number, k: number, si: number, o: number, y: number, c: THREE.Color, nh: number, ny: number) => {
        const key = (rail * 2 + si) * 100000 + k;
        let v = cache.get(key);
        if (v === undefined) {
          const p = V[k], sg = si ? 1 : -1;
          v = O.v(p.x + sg * p.nx * o, y, p.z + sg * p.nz * o, c, sg * p.nx * nh, ny, sg * p.nz * nh);
          cache.set(key, v);
        }
        return v;
      };
      const ou = (p: VP, si: number, para: boolean) => p.e[si] + (para ? PAR_T : 0);
      const gtOf = (p: VP, si: number) => Math.max(0.5, p.e[si] + PAR_T - spec.over);
      const gbOf = (p: VP, si: number) => Math.max(0.35, gtOf(p, si) - spec.depth * SL_T);
      // 面：rail a と b（点 k と k+1）を結ぶ
      const face = (k: number, ra: number, rb: number, si: number, A: (p: VP) => [number, number], B: (p: VP) => [number, number], c: THREE.Color, nh: number, ny: number) => {
        const a0 = vx(ra, k, si, ...A(V[k]), c, nh, ny), a1 = vx(ra, k + 1, si, ...A(V[k + 1]), c, nh, ny);
        const b0 = vx(rb, k, si, ...B(V[k]), c, nh, ny), b1 = vx(rb, k + 1, si, ...B(V[k + 1]), c, nh, ny);
        const p = V[k], sg = si ? 1 : -1;
        quadO(a0, b0, b1, a1, sg * p.nx * nh, ny, sg * p.nz * nh);
      };
      const segPara = (k: number, si: number) => (V[k].sp ? V[k].sp![si] : V[k].para[si] && V[k + 1].para[si]);
      for (let k = 0; k + 1 < nP; k++) {
        const st = style(k);
        for (const si of [0, 1]) {
          const pa = segPara(k, si);
          const R0 = pa ? 0 : 20; // 欄干のない側は、縁の位置が違うので別の頂点
          if (pa) {
            // 欄干：内側の面、上の面、外側の面、水切りの溝
            face(k, 1, 2, si, (p) => [p.e[si], p.hs[si] - 0.05], (p) => [p.e[si], p.hs[si] + PAR_H], COL.parapet, -1, 0);
            face(k, 3, 4, si, (p) => [p.e[si], p.hs[si] + PAR_H], (p) => [p.e[si] + PAR_T, p.hs[si] + PAR_H], COL.parapet, 0, 1);
            face(k, 5, 6, si, (p) => [p.e[si] + PAR_T, p.hs[si] + PAR_H], (p) => [p.e[si] + PAR_T, p.hs[si] + 0.05], COL.parapet, 1, 0);
            face(k, 7, 8, si, (p) => [p.e[si] + PAR_T, p.hs[si] + 0.05], (p) => [p.e[si] + PAR_T, p.hs[si] - 0.04], COL.groove, 1, 0);
          }
          const top = (p: VP): [number, number] => [ou(p, si, pa), p.hs[si] - (pa ? 0.04 : 0)];
          const fb = (p: VP): [number, number] => [ou(p, si, pa), p.hs[si] - FAS];
          // 床版の縁
          face(k, R0 + 9, R0 + 10, si, top, fb, COL.parapet, 1, 0);
          if (st === 1) {
            // 擁壁：縁の下から少し引っこめて、地面まで
            const wt = (p: VP): [number, number] => [ou(p, si, pa) - 0.06, p.hs[si] - FAS];
            face(k, R0 + 11, R0 + 12, si, fb, wt, COL.soffit, 0, -1);
            face(k, R0 + 13, R0 + 14, si, wt, (p) => [ou(p, si, pa) - 0.06 + 0.1, g.groundAt(p.x + (si ? 1 : -1) * p.nx * ou(p, si, pa), p.z + (si ? 1 : -1) * p.nz * ou(p, si, pa)) - 0.4], COL.wall, 1, 0);
          } else if (st === 2) {
            // 薄い床版：下面を中心まで
            face(k, R0 + 11, 15, si, fb, (p) => [0, (p.hs[0] + p.hs[1]) / 2 - FAS], COL.soffit, 0, -1);
          } else {
            // 張り出しの下面と、桁の傾いた側面
            const gt = (p: VP): [number, number] => [gtOf(p, si), p.hs[si] - FAS];
            const gb = (p: VP): [number, number] => [gbOf(p, si), p.hs[si] - FAS - spec.depth];
            face(k, R0 + 11, 16, si, fb, gt, COL.soffit, 0, -1);
            face(k, 17, 18, si, gt, gb, COL.girder, SL_C, -SL_S);
          }
          // 欄干の端：断面の面でふさぐ
          for (const [kk, other] of [[k, k - 1], [k + 1, k + 1]] as const) {
            if (!pa || (other >= 0 && other + 1 < nP && segPara(other, si))) continue;
            if (other < 0 || other + 1 >= nP) continue;
            const p = V[kk], sg = si ? 1 : -1;
            const P = (o: number, y: number) => [p.x + sg * p.nx * o, y, p.z + sg * p.nz * o];
            quad2([P(p.e[si], p.hs[si] - FAS), P(p.e[si], p.hs[si] + PAR_H), P(p.e[si] + PAR_T, p.hs[si] + PAR_H), P(p.e[si] + PAR_T, p.hs[si] - FAS)], COL.parapet);
          }
        }
        if (st === 0) {
          // 桁の下面
          const b0 = vx(19, k, 0, gbOf(V[k], 0), V[k].hs[0] - FAS - spec.depth, COL.girder, 0, -1), b1 = vx(19, k + 1, 0, gbOf(V[k + 1], 0), V[k + 1].hs[0] - FAS - spec.depth, COL.girder, 0, -1);
          const c0 = vx(19, k, 1, gbOf(V[k], 1), V[k].hs[1] - FAS - spec.depth, COL.girder, 0, -1), c1 = vx(19, k + 1, 1, gbOf(V[k + 1], 1), V[k + 1].hs[1] - FAS - spec.depth, COL.girder, 0, -1);
          quadO(b0, c0, c1, b1, 0, -1, 0);
        }
        // 桁と擁壁の境：橋台の面
        if (k > 0 && (style(k - 1) === 1) !== (st === 1)) {
          const p = V[k];
          const P = (si: number, y: number | null) => {
            const sg = si ? 1 : -1, o = p.e[si] + PAR_T, x = p.x + sg * p.nx * o, z = p.z + sg * p.nz * o;
            return [x, y ?? g.groundAt(x, z) - 0.4, z];
          };
          quad2([P(0, p.hs[0] - FAS), P(1, p.hs[1] - FAS), P(1, null), P(0, null)], COL.wall);
        }
      }
    };
    // 橋脚（丸みのある1本柱）：輪の列（高さ、道に沿った半径、横の半径、角の丸み p：2 = だ円、大きいほど角ばる）をつないだ形
    const pier = (x: number, z: number, ux: number, uz: number, rings: [number, number, number, number][], c: THREE.Color) => {
      const SEG = 12, px = -uz, pz = ux;
      const ringPts = (r: [number, number, number, number]) => {
        const out: number[][] = [];
        for (let q = 0; q < SEG; q++) {
          const th = (q / SEG) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
          const e = 2 / r[3];
          const a = Math.sign(cs) * Math.pow(Math.abs(cs), e) * r[1], b = Math.sign(sn) * Math.pow(Math.abs(sn), e) * r[2];
          // 外向きの横向き（超だ円の勾配）
          let na = (Math.sign(cs) * Math.pow(Math.abs(a / r[1]), r[3] - 1)) / r[1], nb = (Math.sign(sn) * Math.pow(Math.abs(b / r[2]), r[3] - 1)) / r[2];
          const nl = Math.hypot(na, nb) || 1;
          na /= nl;
          nb /= nl;
          out.push([x + ux * a + px * b, r[0], z + uz * a + pz * b, ux * na + px * nb, uz * na + pz * nb]);
        }
        return out;
      };
      const R = rings.map(ringPts);
      const ids = R.map((ring, j) =>
        ring.map((p, q) => {
          // 広がる所では、面を下へ向ける
          const pr = R[Math.max(0, j - 1)][q], nx2 = R[Math.min(R.length - 1, j + 1)][q];
          const dy = nx2[1] - pr[1] || 1, grow = ((nx2[0] - pr[0]) * p[3] + (nx2[2] - pr[2]) * p[4]) / dy;
          const l = Math.hypot(1, grow);
          return O.v(p[0], p[1], p[2], c, p[3] / l, -grow / l, p[4] / l);
        }),
      );
      for (let j = 0; j + 1 < R.length; j++)
        for (let q = 0; q < SEG; q++) {
          const q2 = (q + 1) % SEG, p = R[j][q];
          quadO(ids[j][q], ids[j][q2], ids[j + 1][q2], ids[j + 1][q], p[3], 0, p[4]);
        }
    };
    // 橋脚の基礎（地面からわずかに出る、角を落とした台。上から見て目立たない色）
    const footing = (x: number, z: number, ux: number, uz: number, ha: number, hb: number, y: number) => {
      pier(x, z, ux, uz, [[y - 0.8, ha, hb, 6], [y + 0.08, ha, hb, 6]], COL.footing);
      const P = (a: number, b: number) => [x + ux * a - uz * b, y + 0.08, z + uz * a + ux * b];
      const SEG = 12, c = O.v(x, y + 0.08, z, COL.footing);
      const ring: number[] = [];
      for (let q = 0; q < SEG; q++) {
        const th = (q / SEG) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
        const p = P(Math.sign(cs) * Math.pow(Math.abs(cs), 1 / 3) * ha, Math.sign(sn) * Math.pow(Math.abs(sn), 1 / 3) * hb);
        ring.push(O.v(p[0], p[1], p[2], COL.footing));
      }
      for (let q = 0; q < SEG; q++) O.tri(c, ring[q], ring[(q + 1) % SEG]);
    };
    // 橋・高架の床版と橋脚。med：分離帯の側（0/1、-1 = なし）。大通りは2本の車線で1枚の床版なので、その側は反対車線との境までのばし、欄干は付けない。
    // 大通りの橋脚は、2本の車線をまとめて橋の層（bridgeStyles）が立てるので、ここでは立てない
    const deckUnder = (pts: RP[], bot: number | null, med = -1) => {
      if (viaCur) return; // 都市高速の高架は、帯（ribbon）が断面を描き、橋脚はあとでまとめて立てる
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const px = -dz / l, pz = dx / l;
        const mw = Math.abs(px) > 0.3 && Math.abs(pz) > 0.3 ? AV_MED_DIAG : AV_MED;
        const th = 1.2;
        const wOf = (q: RP, sd: number) => q.hw + (med === (sd < 0 ? 0 : 1) ? mw : Math.max(q.sw, 0.6));
        for (const sd of [-1, 1]) {
          if (med === (sd < 0 ? 0 : 1)) continue;
          const wa = wOf(a, sd), wb = wOf(b, sd);
          O.wall(a.x + sd * px * wa, a.z + sd * pz * wa, a.h - th, a.h + 0.1, b.x + sd * px * wb, b.z + sd * pz * wb, b.h - th, b.h + 0.1, COL.concrete);
        }
        const la = wOf(a, -1), ra = wOf(a, 1), lb = wOf(b, -1), rb = wOf(b, 1);
        const i0 = O.v(a.x - px * la, a.h - th, a.z - pz * la, COL.concrete, 0, -1, 0), i1 = O.v(a.x + px * ra, a.h - th, a.z + pz * ra, COL.concrete, 0, -1, 0);
        const i2 = O.v(b.x + px * rb, b.h - th, b.z + pz * rb, COL.concrete, 0, -1, 0), i3 = O.v(b.x - px * lb, b.h - th, b.z - pz * lb, COL.concrete, 0, -1, 0);
        O.I.push(i0, i2, i1, i0, i3, i2);
        // 欄干（歩道のない橋・高架は壁があるので省く）
        if (a.sw > 0)
          for (const sd of [-1, 1]) {
            if (med === (sd < 0 ? 0 : 1)) continue;
            const wa = wOf(a, sd), wb = wOf(b, sd);
            O.wall(a.x + sd * px * wa, a.z + sd * pz * wa, a.h + 0.1, a.h + 1.1, b.x + sd * px * wb, b.z + sd * pz * wb, b.h + 0.1, b.h + 1.1, COL.concrete);
          }
      }
      if (bot !== null && pts[0].t !== AV) {
        const p = pts[0];
        if (p.h - bot > 3) O.box(p.x - 1.0, bot, p.z - 1.0, p.x + 1.0, p.h - 1.2, p.z + 1.0, COL.concrete);
      }
    };

    // 路面の矢印（2車線分）
    const arrow = (x0: number, z0: number, h: number, ux: number, uz: number, w: number) => {
      const px = -uz, pz = ux;
      for (const o of [-w * 0.2, w * 0.2]) {
        const bx = x0 + px * o, bz = z0 + pz * o;
        const at = (s: number, l: number) => [bx + ux * s + px * l, bz + uz * s + pz * l];
        const q = [at(-2.6, -0.2), at(0.6, -0.2), at(0.6, 0.2), at(-2.6, 0.2)].map(([qx, qz]) => M.v(qx, H(qx, qz, h) + 0.03, qz, COL.white));
        M.tri(q[0], q[1], q[2]);
        M.tri(q[0], q[2], q[3]);
        const hd = [at(0.6, -0.85), at(2.8, 0), at(0.6, 0.85)].map(([qx, qz]) => M.v(qx, H(qx, qz, h) + 0.03, qz, COL.white));
        M.tri(hd[0], hd[1], hd[2]);
      }
    };

    // 持ち上げた道路（立体交差の取り付け部分）の両側の壁。med の側（大通りの分離帯）は省く
    const embank = (pts: RP[], med = -1) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const px = -dz / l, pz = dx / l;
        for (const sd of [-1, 1]) {
          if (med === (sd < 0 ? 0 : 1)) continue;
          const wa = a.hw + a.sw, wb = b.hw + b.sw;
          const ax = a.x + sd * px * wa, az = a.z + sd * pz * wa, bx = b.x + sd * px * wb, bz = b.z + sd * pz * wb;
          O.wall(ax, az, g.groundAt(ax, az) - 0.5, a.h + 0.16, bx, bz, g.groundAt(bx, bz) - 0.5, b.h + 0.16, COL.concrete);
        }
      }
    };
    // 信号機：柱と、横へのばした腕の先の横長の灯器。腕の向き (ax, az) は軸に沿った向き
    const signalPole = (x: number, z: number, h: number, ax: number, az: number, len: number, ht = 5.6) => {
      O.box(x - 0.12, h, z - 0.12, x + 0.12, h + ht, z + 0.12, COL.signal);
      // 歩行者用の信号
      O.box(x - 0.2, h + 2.3, z - 0.2, x + 0.2, h + 3.0, z + 0.2, COL.signal);
      const lx = Math.abs(ax) > 0.5 ? 0.6 : 0.18, lz = Math.abs(az) > 0.5 ? 0.6 : 0.18;
      if (len > 0.5) {
        const ex = x + ax * len, ez = z + az * len;
        O.box(Math.min(x, ex) - 0.07, h + ht - 0.18, Math.min(z, ez) - 0.07, Math.max(x, ex) + 0.07, h + ht, Math.max(z, ez) + 0.07, COL.signal);
        const hx = x + ax * (len - 0.7), hz = z + az * (len - 0.7);
        O.box(hx - lx, h + ht - 0.75, hz - lz, hx + lx, h + ht - 0.2, hz + lz, COL.signal);
      } else O.box(x - lx, h + ht - 0.55, z - lz, x + lx, h + ht, z + lz, COL.signal);
    };
    // 向きのある細長い箱（中心線 (x0, z0)-(x1, z1)、幅の半分 hw、高さ y0..y1）
    const orientBox = (x0: number, z0: number, x1: number, z1: number, hw: number, y0: number, y1: number, c: THREE.Color) => {
      const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1, px = (-dz / l) * hw, pz = (dx / l) * hw;
      const q = [[x0 - px, z0 - pz], [x1 - px, z1 - pz], [x1 + px, z1 + pz], [x0 + px, z0 + pz]];
      for (let k = 0; k < 4; k++) {
        const a = q[k], b = q[(k + 1) % 4];
        O.wall(a[0], a[1], y0, y1, b[0], b[1], y0, y1, c);
      }
      const v = q.map(([x, z]) => O.v(x, y1, z, c));
      O.tri(v[0], v[1], v[2]);
      O.tri(v[0], v[2], v[3]);
    };
    // 信号機（腕が斜めの向きでもよいもの）
    const signalPoleR = (x: number, z: number, h: number, ax: number, az: number, len: number, ht = 5.6) => {
      O.box(x - 0.12, h, z - 0.12, x + 0.12, h + ht, z + 0.12, COL.signal);
      O.box(x - 0.2, h + 2.3, z - 0.2, x + 0.2, h + 3.0, z + 0.2, COL.signal);
      orientBox(x, z, x + ax * len, z + az * len, 0.07, h + ht - 0.18, h + ht, COL.signal);
      const hx = x + ax * (len - 0.7), hz = z + az * (len - 0.7);
      orientBox(hx - ax * 0.6, hz - az * 0.6, hx + ax * 0.6, hz + az * 0.6, 0.18, h + ht - 0.75, h + ht - 0.2, COL.signal);
    };
    // 交差点の中を照らす光：地面の坂に沈まないよう、光の板の範囲でいちばん高い路面の高さに置く
    const poolAt = (x: number, z: number, size: number, hOf: (x: number, z: number) => number) => {
      let hm = -Infinity;
      for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) hm = Math.max(hm, hOf(x + a * size * 0.45, z + b * size * 0.45));
      junctionPools.push(x, hm - ROAD_LIFT, z, size);
    };

    // ---- 大通りの交差点（マスのかたまり）を1つの交差点として描く ----
    const drawCluster = (cl: Cluster) => {
      S.owner = cl.cells[0];
      onGround = true;
      liftCur = cl.lift;
      discCode = surfCode(0, SURF.asphalt, true, hashInt(cl.cells[0], 77));
      const asph = COL.asphalt;
      const A = cl.arms;
      const P = (a: CArm, s: number, l: number): [number, number] => [cl.cx + a.ux * s + a.px * l, cl.cz + a.uz * s + a.pz * l];
      const hAt = (x: number, z: number) => H(x, z, 0);
      const ov = (q: [number, number], de: number) => {
        S.aux = [0, 0, de, discCode];
        return S.v(q[0], hAt(q[0], q[1]), q[1], asph);
      };
      S.aux = [0, 0, Math.min(...A.map((a) => (a.hi - a.lo) / 2)), discCode];
      const ci = S.v(cl.cx, hAt(cl.cx, cl.cz), cl.cz, asph);
      const outline: number[] = [];
      const fan = (c0: number, list: number[]) => {
        for (let k = 0; k + 1 < list.length; k++) S.tri(c0, list[k], list[k + 1]);
      };
      const N = 10;
      for (let k = 0; k < A.length; k++) {
        const a = A[k], cn = cl.corners[k], b = cn.b;
        const prev = cl.corners[(k + A.length - 1) % A.length];
        // 角の円弧（a の座標：沿う向き s、横 l）。th = 0 が a の縁石の上、π/2 が b の縁石の上
        const arcOf = (c: Corner) => (th: number): [number, number] => [c.kb + c.r - c.r * Math.sin(th), c.ka + c.r - c.r * Math.cos(th)];
        const thA = (c: Corner) => Math.asin(Math.min(1, Math.max(0, (c.kb + c.r - c.a.mouth) / c.r)));
        const thB = (c: Corner) => Math.acos(Math.min(1, Math.max(0, (c.ka + c.r - c.b.mouth) / c.r)));
        // 腕の口（かたまりの縁）。円弧が隣のマスへはみ出すところは、縁石から少し離れている
        const deLo = prev.arc ? Math.max(0, arcOf(prev)(thB(prev))[0] - prev.kb) : 0;
        const deHi = cn.arc ? Math.max(0, arcOf(cn)(thA(cn))[1] - cn.ka) : 0;
        outline.push(ov(P(a, a.mouth, a.lo), deLo));
        a.lanes.forEach((l, li) => {
          if (li > 0) outline.push(ov(P(a, a.mouth, (a.lanes[0].o + l.o) / 2), 2));
          outline.push(ov(P(a, a.mouth, l.o), l.hw));
        });
        const rm = ov(P(a, a.mouth, a.hi), deHi);
        outline.push(rm);
        if (cn.arc) {
          const arc = arcOf(cn), t0 = thA(cn), t1 = thB(cn);
          const toW = (q: [number, number]) => P(a, q[0], q[1]);
          // かたまりの中の部分
          for (let s = 0; s <= N; s++) outline.push(ov(toW(arc(t0 + ((t1 - t0) * s) / N)), 0));
          // 隣のマスへはみ出す部分は、腕の口の角から扇形で埋める
          if (t0 > 1e-3) {
            const list: number[] = [];
            for (let s = 0; s <= 4; s++) list.push(ov(toW(arc((t0 * s) / 4)), 0));
            fan(ov(P(a, a.mouth, a.hi), deHi), list);
          }
          if (t1 < Math.PI / 2 - 1e-3) {
            const list: number[] = [];
            for (let s = 0; s <= 4; s++) list.push(ov(toW(arc(t1 + ((Math.PI / 2 - t1) * s) / 4)), 0));
            const dB = Math.max(0, arc(t1)[0] - cn.kb);
            fan(ov(P(b, b.mouth, b.lo), dB), list);
          }
          // 角の歩道：円弧から、2本の腕の歩道の外側の縁が交わる角まで
          const swA = a.swHi, swB = b.swLo;
          if (swA > 0 && swB > 0) {
            const r = cn.r, wa = Math.min(swA, r), wb = Math.min(swB, r);
            const Ao: [number, number] = [cn.kb + r, cn.ka + wa], Co: [number, number] = [cn.kb + wb, cn.ka + wa], Bo: [number, number] = [cn.kb + wb, cn.ka + r];
            const l1 = Math.hypot(Ao[0] - Co[0], Ao[1] - Co[1]), l2 = Math.hypot(Bo[0] - Co[0], Bo[1] - Co[1]);
            let prevQ: number[] | null = null;
            for (let s = 0; s <= N; s++) {
              const f = s / N, th = (f * Math.PI) / 2;
              const [is, il] = arc(th);
              const dd = f * (l1 + l2);
              const o: [number, number] = dd <= l1 ? [lerp(Ao[0], Co[0], dd / (l1 || 1)), lerp(Ao[1], Co[1], dd / (l1 || 1))] : [lerp(Co[0], Bo[0], (dd - l1) / (l2 || 1)), lerp(Co[1], Bo[1], (dd - l1) / (l2 || 1))];
              const [ix, iz] = P(a, is, il), [ox, oz] = P(a, o[0], o[1]);
              const hi = hAt(ix, iz), ho = hAt(ox, oz);
              if (prevQ) {
                const walls = [[prevQ[0], prevQ[1], prevQ[2] - 0.05, prevQ[2] + 0.16, ix, iz, hi - 0.05, hi + 0.16], [prevQ[3], prevQ[4], prevQ[5] - 1.2, prevQ[5] + 0.16, ox, oz, ho - 1.2, ho + 0.16]];
                walkQ.push({ p: [prevQ[0], prevQ[2] + 0.16, prevQ[1], prevQ[3], prevQ[5] + 0.16, prevQ[4], ox, ho + 0.16, oz, ix, hi + 0.16, iz], w: walls, o: S.owner });
              }
              prevQ = [ix, iz, hi, ox, oz, ho];
            }
          }
        } else {
          // 腕のないまっすぐな辺：歩道、または反対車線との間の分離帯
          const [x0, z0] = P(a, a.mouth, a.hi), [x1, z1] = P(b, b.mouth, b.lo);
          const len = Math.hypot(x1 - x0, z1 - z0), m = Math.max(1, Math.ceil(len / 3.5));
          const half = Math.abs(a.px) > 0.5 ? cl.hx : cl.hz; // かたまりの縁までの長さ（p の向き）
          const wd = Math.max(0, half - a.hi);
          if (cn.med) {
            const mp: MP[] = [];
            for (let s = 0; s <= m; s++) mp.push({ x: lerp(x0, x1, s / m), z: lerp(z0, z1, s / m), nx: a.px, nz: a.pz, w: wd, h: 0, al: lerp(x0, x1, s / m) * -a.ux + lerp(z0, z1, s / m) * -a.uz });
            median(mp, 0, () => false);
          } else {
            const pts: { x: number; z: number; nx: number; nz: number; w: number }[] = [];
            for (let s = 0; s <= m; s++) pts.push({ x: lerp(x0, x1, s / m), z: lerp(z0, z1, s / m), nx: a.px, nz: a.pz, w: Math.min(a.swHi || wd, wd) });
            walkAlong(pts, 0);
          }
        }
      }
      for (let s = 0; s < outline.length; s++) S.tri(ci, outline[s], outline[(s + 1) % outline.length]);
      S.aux = AUX0;

      // 横断歩道（外側の入口だけ）、停止線（入ってくる車線だけ）、分離帯の先の安全地帯、信号機
      const sig = cl.ctl === 3, stopLine = sig || cl.ctl === 2;
      const hc = hAt(cl.cx, cl.cz);
      lineZb = true;
      for (const a of A) {
        if (sig) {
          const mid = (a.lo + a.hi) / 2;
          zebra.push({ cx: cl.cx + a.px * mid, cz: cl.cz + a.pz * mid, ux: a.ux, uz: a.uz, s1: a.xw0 - 0.6, s2: a.xw0 + 4.6, hw: (a.hi - a.lo) / 2 + 0.5 });
          for (const l of a.lanes) {
            lineAlso = l.nn;
            for (let o = l.o - l.hw + 0.55; o < l.o + l.hw - 0.3; o += 1.0) {
              const [x0, z0] = P(a, a.xw0, o), [x1, z1] = P(a, a.xw0 + 4.0, o);
              seg2(x0, z0, x1, z1, hc, COL.white, 0.5);
            }
          }
        }
        if (stopLine)
          for (const l of a.lanes) {
            if (!l.entry) continue;
            lineAlso = l.nn;
            // 一方通行の車線は幅いっぱい、両方向の道路は入ってくる側（腕の向きから見て -p 側）の半分
            const o0 = l.o - l.hw + 0.3, o1 = l.exit ? l.o - 0.15 : l.o + l.hw - 0.3;
            const [x0, z0] = P(a, a.stop, o0), [x1, z1] = P(a, a.stop, o1);
            seg2(x0, z0, x1, z1, hc, COL.white, 0.45);
          }
        lineAlso = -1;
        if (a.pair) {
          // 分離帯の先：舗装した安全地帯（横断歩道を渡る人が待つ）。先の角は丸く
          const m0 = a.lanes[0].o + a.lanes[0].hw, m1 = a.lanes[1].o - a.lanes[1].hw;
          const s0 = a.tip, s1 = a.mEnd, rr = Math.min(1.6, (m1 - m0) / 2, (s1 - s0) / 2);
          const ring: [number, number][] = [[s1, m0]];
          for (let q = 0; q <= 4; q++) {
            const th = (q / 4) * (Math.PI / 2);
            ring.push([s0 + rr - rr * Math.sin(th), m0 + rr - rr * Math.cos(th)]);
          }
          for (let q = 0; q <= 4; q++) {
            const th = (q / 4) * (Math.PI / 2);
            ring.push([s0 + rr - rr * Math.cos(th), m1 - rr + rr * Math.sin(th)]);
          }
          ring.push([s1, m1]);
          const cs = (s0 + s1) / 2, cm = (m0 + m1) / 2;
          const [ccx, ccz] = P(a, cs, cm);
          // タイルの模様：道に沿った向きをそろえ、縁石の石の筋は付けない
          O.aux = [1, cs, 0, 0];
          const c0 = O.v(ccx, hAt(ccx, ccz) + KERB, ccz, COL.walk);
          const vs = ring.map(([s, l]) => {
            const [x, z] = P(a, s, l);
            O.aux = [1, s, 0, 0];
            return O.v(x, hAt(x, z) + KERB, z, COL.walk);
          });
          O.aux = AUX0;
          for (let q = 0; q + 1 < vs.length; q++) O.tri(c0, vs[q], vs[q + 1]);
          // 植え込みの側の辺も閉じる（中心から見て最後と最初の点の間。開けておくと V 字のすき間が見える）
          O.tri(c0, vs[vs.length - 1], vs[0]);
          for (let q = 0; q + 1 < ring.length; q++) {
            const [x0, z0] = P(a, ring[q][0], ring[q][1]), [x1, z1] = P(a, ring[q + 1][0], ring[q + 1][1]);
            const h0 = hAt(x0, z0), h1 = hAt(x1, z1);
            O.wall(x0, z0, h0 - 0.05, h0 + KERB, x1, z1, h1 - 0.05, h1 + KERB, COL.curb);
          }
          // 分離帯の先の信号（入ってくる内側の車線の上へ短い腕）
          if (sig) {
            const [qx, qz] = P(a, s0 + 1.0, cm);
            signalPole(qx, qz, hAt(qx, qz) + KERB, -a.px, -a.pz, 3.2, 5.0);
          }
        }
      }
      lineZb = false;
      // 外側の角の信号：b の入ってくる車線の上へ腕をのばす
      if (sig)
        for (const cn of cl.corners) {
          if (!cn.arc || cn.a.swHi <= 0 || cn.b.swLo <= 0) continue;
          const { a, b, r } = cn;
          const th = Math.PI * 0.42;
          const s = cn.kb + r - r * Math.sin(th) + Math.sin(th) * 1.0, l = cn.ka + r - r * Math.cos(th) + Math.cos(th) * 1.0;
          const [qx, qz] = P(a, s, l);
          const ent = b.lanes.filter((q) => q.entry);
          const reach = ent.length ? Math.max(...ent.map((q) => (q.exit ? q.o : q.o + q.hw) - b.lo)) : 0;
          signalPole(qx, qz, hAt(qx, qz) + 0.16, b.px, b.pz, Math.max(2.5, Math.min(8, reach + 0.5)));
        }
      // 角の歩道の街灯（交差点の中を照らす。腕は交差点の中心へ）
      for (const cn of cl.corners) {
        if (!cn.arc || cn.a.swHi <= 0 || cn.b.swLo <= 0) continue;
        const th = Math.PI * 0.25, r = cn.r, back = Math.min(1.6, Math.min(cn.a.swHi, cn.b.swLo) * 0.4);
        const [qx, qz] = P(cn.a, cn.kb + r - r * Math.sin(th) + Math.sin(th) * back, cn.ka + r - r * Math.cos(th) + Math.cos(th) * back);
        const dx = cl.cx - qx, dz = cl.cz - qz, dl = Math.hypot(dx, dz) || 1;
        // 光の届く路面の高さ（光の板の中でいちばん高いところ。坂で光が路面の下に沈まないように）
        let ph = -Infinity;
        for (const f of [0, 4.5, 9, 13.5]) for (const w of [-4, 0, 4]) ph = Math.max(ph, hAt(qx + (dx / dl) * f - (dz / dl) * w, qz + (dz / dl) * f + (dx / dl) * w));
        junctionLamps.push(qx, hAt(qx, qz) - ROAD_LIFT, qz, dx / dl, dz / dl, ph - ROAD_LIFT);
      }
      // 交差点の中（信号のある大通りの交差点は、まわりの道でいちばん明るい）。4つに分けて、それぞれの場所の路面の高さに置く
      // （4つの光が重なって、まん中も明るくなる大きさ）
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) poolAt(cl.cx + (sx * cl.hx) / 3, cl.cz + (sz * cl.hz) / 3, Math.hypot(cl.hx, cl.hz) * 1.25, hAt);
      onGround = false;
      liftCur = 0;
    };

    // ---- 大通りの行き止まり：2本の車線で1つの転回場（分離帯の先は丸く） ----
    const drawCap = (c: { a: number; b: number; d: number }) => {
      S.owner = c.a;
      onGround = true;
      liftCur = (g.lift[c.a] + g.lift[c.b]) / 2;
      discCode = surfCode(0, SURF.asphalt, true, hashInt(c.a, 77));
      const ux = DX[c.d], uz = DY[c.d], px = -uz, pz = ux;
      const ox = ((c.a % n) + (c.b % n) + 1) * (CELL / 2), oz = (((c.a / n) | 0) + ((c.b / n) | 0) + 1) * (CELL / 2);
      const P = (s: number, l: number): [number, number] => [ox + ux * s + px * l, oz + uz * s + pz * l];
      const hAt = (q: [number, number]) => H(q[0], q[1], 0);
      const hw = AV_W / 2, half = CELL / 2, ko = half + hw; // 外側の縁石の横の位置
      const swE = 3.5, sEnd = half - swE, rc = 7.5, sK = sEnd - rc;
      // 縁石の線（-ko の側の後ろ端から、先をまわって +ko の側の後ろ端まで）と、外向きの向き、歩道の幅
      const kerb: { s: number; l: number; ns: number; nl: number; w: number }[] = [];
      kerb.push({ s: -half, l: -ko, ns: 0, nl: -1, w: AV_SW });
      for (let q = 0; q <= 8; q++) {
        const ph = -Math.PI / 2 + (q / 8) * (Math.PI / 2);
        kerb.push({ s: sK + rc * Math.cos(ph), l: -(ko - rc) + rc * Math.sin(ph), ns: Math.cos(ph), nl: Math.sin(ph), w: lerp(AV_SW, swE, q / 8) });
      }
      for (let q = 0; q <= 8; q++) {
        const ph = (q / 8) * (Math.PI / 2);
        kerb.push({ s: sK + rc * Math.cos(ph), l: ko - rc + rc * Math.sin(ph), ns: Math.cos(ph), nl: Math.sin(ph), w: lerp(swE, AV_SW, q / 8) });
      }
      kerb.push({ s: -half, l: ko, ns: 0, nl: 1, w: AV_SW });
      // 路面
      const asph = COL.asphalt;
      const vtx = (q: [number, number], de: number) => {
        S.aux = [0, 0, de, discCode];
        return S.v(q[0], hAt(q), q[1], asph);
      };
      const ci = vtx(P(sK * 0.5, 0), hw);
      const out = kerb.map((q) => vtx(P(q.s, q.l), 0));
      out.push(vtx(P(-half, half), hw), vtx(P(-half, 0), 2), vtx(P(-half, -half), hw));
      for (let q = 0; q < out.length; q++) S.tri(ci, out[q], out[(q + 1) % out.length]);
      S.aux = AUX0;
      // 歩道
      walkAlong(kerb.map((q) => { const [x, z] = P(q.s, q.l); return { x, z, nx: ux * q.ns + px * q.nl, nz: uz * q.ns + pz * q.nl, w: q.w }; }), 0);
      // 線（それぞれの車線の破線と外側線。転回するところの手前まで）
      for (const lc of [-half, half]) {
        const pts: RP[] = [-half, -1.5].map((s) => { const [x, z] = P(s, lc); return { x, z, h: 0, hw, sw: 0, t: AV }; });
        lineAlso = -1;
        line(pts, () => 0, COL.white, 0.14, true);
        line(pts, () => -(hw - 0.33), COL.white, 0.15);
        line(pts, () => hw - 0.33, COL.white, 0.15);
      }
      // 分離帯の先（後ろの端から 2m のばして、半円で丸める）
      const mw = half - hw, sc = -half + 2;
      const ring: [number, number][] = [[-half, -mw]];
      for (let q = 0; q <= 12; q++) {
        const ph = -Math.PI / 2 + (q / 12) * Math.PI;
        ring.push([sc + mw * Math.cos(ph), mw * Math.sin(ph)]);
      }
      ring.push([-half, mw]);
      const inner = ring.map(([s, l]): [number, number] => {
        const ds = s - Math.max(-half, Math.min(sc, s)), r = Math.hypot(ds, l) || 1;
        const k = Math.max(0, r - 0.25) / r;
        return [s <= sc ? s : sc + ds * k, l * k];
      });
      const [kx, kz] = P(sc - 1, 0);
      const c0 = O.v(kx, H(kx, kz, 0) + KERB, kz, COL.grass);
      for (let q = 0; q + 1 < ring.length; q++) {
        const [x0, z0] = P(ring[q][0], ring[q][1]), [x1, z1] = P(ring[q + 1][0], ring[q + 1][1]);
        const [i0x, i0z] = P(inner[q][0], inner[q][1]), [i1x, i1z] = P(inner[q + 1][0], inner[q + 1][1]);
        const h0 = H(x0, z0, 0), h1 = H(x1, z1, 0), hi0 = H(i0x, i0z, 0), hi1 = H(i1x, i1z, 0);
        O.wall(x0, z0, h0 - 0.05, h0 + KERB, x1, z1, h1 - 0.05, h1 + KERB, COL.curb);
        const v0 = O.v(x0, h0 + KERB, z0, COL.walk), v1 = O.v(x1, h1 + KERB, z1, COL.walk), v2 = O.v(i1x, hi1 + KERB, i1z, COL.walk), v3 = O.v(i0x, hi0 + KERB, i0z, COL.walk);
        O.tri(v0, v1, v2);
        O.tri(v0, v2, v3);
        O.tri(c0, O.v(i0x, hi0 + KERB, i0z, COL.grass), O.v(i1x, hi1 + KERB, i1z, COL.grass));
      }
      // 後ろの端（隣のマスの分離帯へ続く）も芝でふさぐ
      {
        const [ax, az] = P(inner[0][0], inner[0][1]), [bx, bz] = P(inner[inner.length - 1][0], inner[inner.length - 1][1]);
        O.tri(c0, O.v(ax, H(ax, az, 0) + KERB, az, COL.grass), O.v(bx, H(bx, bz, 0) + KERB, bz, COL.grass));
      }
      onGround = false;
      liftCur = 0;
    };

    // ---- 斜めの大通りの行き止まり：2本の車線をまっすぐ延ばし、半円で折り返す（分離帯の先は丸く） ----
    const drawDiagCap = (c: { a: number; b: number; d: number }) => {
      const q = diagCap(c);
      onGround = true;
      liftCur = (g.lift[c.a] + g.lift[c.b]) / 2;
      const hw = AV_W / 2;
      // 分離帯の側：車線が横の位置 l > 0 なら、帯の左（-p）側
      const sides: [Side, Side] = q.la > 0 ? ['med', true] : [true, 'med'];
      const RPt = (s2: number, l: number, sw = AV_SW): RP => {
        const [x, z] = q.P(s2, l);
        return { x, z, h: 0, hw, sw, t: AV };
      };
      const nA: [number, number] = [q.px, q.pz], nB: [number, number] = [-q.px, -q.pz];
      // まっすぐな部分（行き：a は後ろから前へ、帰り：b は前から後ろへ）
      const ptsA = [RPt(q.sa - q.half, q.la), RPt(q.sC, q.la)], ptsB = [RPt(q.sC, q.lb), RPt(q.sb - q.half, q.lb)];
      // 半円（車線の中心の半径 e）。先の歩道は少し細くして、マスの外へ出ないように
      const arc: RP[] = [];
      const SEG = 12;
      for (let k = 0; k <= SEG; k++) {
        const th = (k / SEG) * Math.PI;
        arc.push(RPt(q.sC + q.e * Math.sin(th), q.la * Math.cos(th), lerp(AV_SW, 3.0, Math.sin(th))));
      }
      S.owner = c.a;
      discCode = surfCode(0, SURF.asphalt, true, hashInt(c.a, 77));
      ribbon(ptsA, AV, sides);
      ribbon(arc, AV, [false, false], undefined, 0, { endN: [nA, nB] });
      // 外側の歩道：折り返しの半円と同じ中心の半円（両端でまっすぐな歩道につながる。先は少し細くして、マスの外へ出ないように）
      {
        const kerb: { x: number; z: number; nx: number; nz: number; w: number }[] = [];
        for (let k = 0; k <= SEG * 2; k++) {
          const th = (k / (SEG * 2)) * Math.PI, ns = Math.sin(th), nl = (q.la / q.e) * Math.cos(th);
          const [x, z] = q.P(q.sC + (q.e + hw) * ns, (q.e + hw) * nl);
          kerb.push({ x, z, nx: q.ux * ns + q.px * nl, nz: q.uz * ns + q.pz * nl, w: lerp(AV_SW, 3.0, ns) });
        }
        walkAlong(kerb, 0);
      }
      // 分離帯の先：半円（縁石、縁の石、芝）
      {
        const r0 = Math.max(0.5, q.e - hw - 0.04), seg = 10;
        const [kx, kz] = q.P(q.sC, 0);
        const c0 = O.v(kx, H(kx, kz, 0) + KERB, kz, COL.grass);
        for (let k = 0; k < seg; k++) {
          const t0 = (k / seg) * Math.PI - Math.PI / 2, t1 = ((k + 1) / seg) * Math.PI - Math.PI / 2;
          const [x0, z0] = q.P(q.sC + r0 * Math.cos(t0), r0 * Math.sin(t0)), [x1, z1] = q.P(q.sC + r0 * Math.cos(t1), r0 * Math.sin(t1));
          const r1 = r0 - 0.25;
          const [i0x, i0z] = q.P(q.sC + r1 * Math.cos(t0), r1 * Math.sin(t0)), [i1x, i1z] = q.P(q.sC + r1 * Math.cos(t1), r1 * Math.sin(t1));
          const h0 = H(x0, z0, 0), h1 = H(x1, z1, 0), hi0 = H(i0x, i0z, 0), hi1 = H(i1x, i1z, 0);
          O.wall(x0, z0, h0 - 0.05, h0 + KERB, x1, z1, h1 - 0.05, h1 + KERB, COL.curb);
          const v0 = O.v(x0, h0 + KERB, z0, COL.walk), v1 = O.v(x1, h1 + KERB, z1, COL.walk), v2 = O.v(i1x, hi1 + KERB, i1z, COL.walk), v3 = O.v(i0x, hi0 + KERB, i0z, COL.walk);
          O.tri(v0, v1, v2);
          O.tri(v0, v2, v3);
          O.tri(c0, O.v(i0x, hi0 + KERB, i0z, COL.grass), O.v(i1x, hi1 + KERB, i1z, COL.grass));
        }
      }
      lineEnds = [nA, nB];
      // 半円では、外側の線だけ（車線の境の線と分離帯の側の線は、折り返しの手前で終わる）
      const outer = q.la > 0 ? 1 : -1;
      line(arc, (p) => outer * (p.hw - 0.33), COL.white, 0.15);
      lineEnds = null;
      markings(ptsA, AV);
      S.owner = c.b;
      ribbon(ptsB, AV, sides);
      markings(ptsB, AV);
      onGround = false;
      liftCur = 0;
    };

    // ---- 斜めの大通りと縦横の大通りの交差点を、1つの交差点として描く ----
    const drawDiag = (dc: DCluster) => {
      const { A, B } = dc;
      onGround = true;
      liftCur = dc.lift;
      const hw = AV_W / 2, sw = AV_SW;
      const hAt = (x: number, z: number) => H(x, z, 0);
      // かたまりのマスの中の車線（縦横と斜め）：ふつうのまっすぐなマスと同じ帯にして、交差点の側は描かない範囲で切る
      for (const c of dc.cells) {
        S.owner = c;
        discCode = surfCode(0, SURF.asphalt, true, hashInt(c, 77));
        const [x, z] = cenOf(c), ds = arms0(c).dirs;
        for (const X of [A, B]) {
          const li = X.q.findIndex((q) => Math.abs(x * X.nx + z * X.nz - q) < 0.5);
          if (li < 0) continue;
          const hasP = ds.includes(X.d), hasN = ds.includes(opp(X.d));
          if (!hasP && !hasN) continue;
          const half = (CELL * Math.hypot(DX[X.d], DY[X.d])) / 2, h = g.roadH(c) + ROAD_LIFT;
          const at = (sv: number): RP => ({ x: x + X.ux * sv, z: z + X.uz * sv, h, hw, sw, t: AV });
          const pts = [at(hasN ? -half : 0), ...(hasN && hasP ? [at(0)] : []), at(hasP ? half : 0)];
          const t0 = S.T.length, w0 = walkQ.length, m0 = medQ.length, l0 = lineQ.length;
          // 点の並びは +u の向きなので、右（+p）は +n。反対車線の側を分離帯に
          ribbon(pts, AV, li === 0 ? [true, 'med'] : ['med', true]);
          markings(pts, AV);
          // 2本の帯で描かない範囲が違うので、帯ごとに別の持ち主の番号にする
          const id = -(10 + c * 2 + (X === A ? 0 : 1));
          for (let k = t0; k < S.T.length; k++) S.T[k] = id;
          for (let k = w0; k < walkQ.length; k++) walkQ[k].o = id;
          for (let k = m0; k < medQ.length; k++) medQ[k].o = id;
          for (let k = l0; k < lineQ.length; k++) lineQ[k].o = id;
          clipOf.set(id, dc.clip![X === A ? 0 : 1]);
        }
      }
      S.owner = -7;
      discCode = surfCode(0, SURF.asphalt, true, hashInt(dc.cells[0], 77));
      const asph = COL.asphalt;
      // 平行四辺形の路面。地面の起伏に沿うよう、約 3.5m ごとの格子に分ける（広い交差点の中で地面が路面の上に出ないように）
      const poly = (q: [number, number][], de = 3) => {
        S.aux = [0, 0, de, discCode];
        const nu = Math.max(1, Math.ceil(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) / 3.5));
        const nv = Math.max(1, Math.ceil(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) / 3.5));
        const ids: number[] = [];
        for (let b = 0; b <= nv; b++)
          for (let a = 0; a <= nu; a++) {
            const u = a / nu, v = b / nv;
            const x = q[0][0] + (q[1][0] - q[0][0]) * u + (q[3][0] - q[0][0]) * v, z = q[0][1] + (q[1][1] - q[0][1]) * u + (q[3][1] - q[0][1]) * v;
            ids.push(S.v(x, hAt(x, z), z, asph));
          }
        for (let b = 0; b < nv; b++)
          for (let a = 0; a < nu; a++) {
            const i0 = b * (nu + 1) + a;
            S.tri(ids[i0], ids[i0 + 1], ids[i0 + nu + 2]);
            S.tri(ids[i0], ids[i0 + nu + 2], ids[i0 + nu + 1]);
          }
        S.aux = AUX0;
      };
      // X の横の位置 a0..a1 と、Y の横の位置 b0..b1 の平行四辺形
      const quad = (X: DBand, a0: number, a1: number, Y: DBand, b0: number, b1: number): [number, number][] => [
        meet(X.nx, X.nz, a0, Y.nx, Y.nz, b0), meet(X.nx, X.nz, a1, Y.nx, Y.nz, b0), meet(X.nx, X.nz, a1, Y.nx, Y.nz, b1), meet(X.nx, X.nz, a0, Y.nx, Y.nz, b1),
      ];
      // 2本の帯が重なる平行四辺形（交差点の中）
      poly(quad(A, A.lo, A.hi, B, B.lo, B.hi));
      const corners = cornersOf(dc);
      const arcPts = (cn: DCorner, N: number): [number, number][] => {
        const a0 = Math.atan2(cn.Ta[1] - cn.O[1], cn.Ta[0] - cn.O[0]);
        let da = Math.atan2(cn.Tb[1] - cn.O[1], cn.Tb[0] - cn.O[0]) - a0;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        return Array.from({ length: N + 1 }, (_, k): [number, number] => [cn.O[0] + Math.cos(a0 + (da * k) / N) * cn.r, cn.O[1] + Math.sin(a0 + (da * k) / N) * cn.r]);
      };
      const sig = dc.ctl === 3, stopLine = sig || dc.ctl === 2;
      // 角：縁石の丸み（路面）と角の歩道、信号機と街灯
      for (const cn of corners) {
        const arc = arcPts(cn, 10);
        // 縁石の丸みの路面：角の点から円弧まで、扇形を3つの輪に分ける（地面に沿わせる）
        S.aux = [0, 0, 0, discCode];
        const rows = [0, 1 / 3, 2 / 3, 1].map((f) =>
          arc.map(([x, z]) => {
            const px = cn.K[0] + (x - cn.K[0]) * f, pz = cn.K[1] + (z - cn.K[1]) * f;
            return S.v(px, hAt(px, pz), pz, asph);
          }),
        );
        for (let r2 = 0; r2 < 3; r2++)
          for (let k = 0; k + 1 < arc.length; k++) {
            S.tri(rows[r2][k], rows[r2 + 1][k], rows[r2 + 1][k + 1]);
            if (r2 > 0) S.tri(rows[r2][k], rows[r2 + 1][k + 1], rows[r2][k + 1]);
          }
        S.aux = AUX0;
        // 歩道：円弧から、2本の歩道の外側の縁まで（鋭い角では、外側の縁が交わる1点まで）
        const nA = cn.sx ? [A.nx, A.nz] : [-A.nx, -A.nz], nB = cn.sy ? [B.nx, B.nz] : [-B.nx, -B.nz];
        const Ao: [number, number] = [cn.Ta[0] + nA[0] * sw, cn.Ta[1] + nA[1] * sw], Bo: [number, number] = [cn.Tb[0] + nB[0] * sw, cn.Tb[1] + nB[1] * sw];
        const co = sw / Math.sin(cn.phi / 2), Co: [number, number] = [cn.K[0] + cn.bis[0] * co, cn.K[1] + cn.bis[1] * co];
        const path = Math.hypot(Ao[0] - Co[0], Ao[1] - Co[1]) < 0.05 ? [Co, Co] : [Ao, Co, Bo];
        const segL = path.slice(1).map((q, k) => Math.hypot(q[0] - path[k][0], q[1] - path[k][1]));
        const tot = segL.reduce((a, b) => a + b, 0);
        const outerAt = (f: number): [number, number] => {
          let d = f * tot;
          for (let k = 0; k < segL.length; k++) {
            if (d <= segL[k] || k === segL.length - 1) {
              const u = segL[k] > 1e-6 ? Math.min(1, d / segL[k]) : 0;
              return [lerp(path[k][0], path[k + 1][0], u), lerp(path[k][1], path[k + 1][1], u)];
            }
            d -= segL[k];
          }
          return path[path.length - 1];
        };
        let prevQ: number[] | null = null;
        arc.forEach(([ix, iz], k) => {
          const [ox, oz] = outerAt(k / (arc.length - 1));
          const hi = hAt(ix, iz), ho = hAt(ox, oz);
          if (prevQ) {
            const walls = [[prevQ[0], prevQ[1], prevQ[2] - 0.05, prevQ[2] + 0.16, ix, iz, hi - 0.05, hi + 0.16], [prevQ[3], prevQ[4], prevQ[5] - 1.2, prevQ[5] + 0.16, ox, oz, ho - 1.2, ho + 0.16]];
            walkQ.push({ p: [prevQ[0], prevQ[2] + 0.16, prevQ[1], prevQ[3], prevQ[5] + 0.16, prevQ[4], ox, ho + 0.16, oz, ix, hi + 0.16, iz], w: walls, o: -7 });
          }
          prevQ = [ix, iz, hi, ox, oz, ho];
        });
        // 円弧の上の点（f：Ta = 0、Tb = 1）を、歩道の側へ back だけ入れた位置
        const onWalk = (f: number, back: number): [number, number] => {
          const [x, z] = arc[Math.round(f * (arc.length - 1))];
          const dx = cn.O[0] - x, dz = cn.O[1] - z, l = Math.hypot(dx, dz) || 1;
          return [x + (dx / l) * back, z + (dz / l) * back];
        };
        if (sig) {
          // この角の横を通って交差点へ入る車線（右側通行なので、角の横は入ってくる車線か出ていく車線）の上へ腕をのばす
          const ga = cn.dA[0] * A.ux + cn.dA[1] * A.uz > 0 ? 1 : -1, gb = cn.dB[0] * B.ux + cn.dB[1] * B.uz > 0 ? 1 : -1;
          const useA = A.flow[cn.sx] === -ga, useB = !useA && B.flow[cn.sy] === -gb;
          if (useA || useB) {
            const X = useA ? A : B, li = useA ? cn.sx : cn.sy;
            const [px, pz] = onWalk(useA ? 0.25 : 0.75, 1.0);
            const into = li ? -1 : 1; // 縁石から車道の中へ（横の位置が増える向きなら 1）
            const pn = px * X.nx + pz * X.nz, far = X.q[li] + into * hw;
            signalPoleR(px, pz, hAt(px, pz) + 0.16, X.nx * into, X.nz * into, Math.max(2.5, Math.min(9, Math.abs(far - pn) - 0.6)));
          }
        }
        const [lx, lz] = onWalk(0.5, Math.min(1.6, sw * 0.4));
        const dx = dc.cx - lx, dz = dc.cz - lz, dl = Math.hypot(dx, dz) || 1;
        const lh = hAt(lx, lz);
        // 角の街灯の光の届く路面の高さ（光の板の中でいちばん高いところ）
        let ph = -Infinity;
        for (const f of [0, 4.5, 9, 13.5]) for (const w of [-4, 0, 4]) ph = Math.max(ph, hAt(lx + (dx / dl) * f - (dz / dl) * w, lz + (dz / dl) * f + (dx / dl) * w));
        junctionLamps.push(lx, lh - ROAD_LIFT, lz, dx / dl, dz / dl, ph - ROAD_LIFT);
      }
      // 腕ごと：分離帯の先の安全地帯、横断歩道（外側の入口）、停止線（入ってくる車線だけ）、分離帯の先の信号機
      lineZb = true;
      lineKeep = true;
      for (const [X, Y] of [[A, B], [B, A]] as const)
        for (const side of [0, 1]) {
          if (!X.arm[side]) continue;
          const sy = sideOn(X, side, Y), e = sy ? Y.hi : Y.lo, sg = sy ? 1 : -1, out = side === 0 ? 1 : -1;
          const m0 = X.q[0] + hw, m1 = X.q[1] - hw;
          const P = (a: number, b: number) => meet(X.nx, X.nz, a, Y.nx, Y.nz, b);
          // 交差点の縁から分離帯の植え込みまでの路面
          poly(quad(X, m0, m1, Y, e, e + sg * 5.6));
          // 安全地帯（縁石の高さの舗装）。植え込みの側は、切り取った植え込みにつながる
          {
            const q4 = [P(m0, e + sg * 0.6), P(m1, e + sg * 0.6), P(m1, e + sg * 5.5), P(m0, e + sg * 5.5)];
            const vs = q4.map(([x, z]) => {
              O.aux = [1, x * X.ux + z * X.uz, 0, 0];
              return O.v(x, hAt(x, z) + KERB, z, COL.walk);
            });
            O.aux = AUX0;
            O.tri(vs[0], vs[1], vs[2]);
            O.tri(vs[0], vs[2], vs[3]);
            for (const [a, b] of [[3, 0], [0, 1], [1, 2]]) {
              const [x0, z0] = q4[a], [x1, z1] = q4[b], h0 = hAt(x0, z0), h1 = hAt(x1, z1);
              O.wall(x0, z0, h0 - 0.05, h0 + KERB, x1, z1, h1 - 0.05, h1 + KERB, COL.curb);
            }
          }
          if (sig) {
            // 横断歩道：横切る大通りの縁石に平行な帯（しまは車の進む向き）
            for (const li of [0, 1])
              for (let o = X.q[li] - hw + 0.55; o < X.q[li] + hw - 0.3; o += 1.0) {
                const [x0, z0] = P(o, e + sg * 1.05), [x1, z1] = P(o, e + sg * 4.95);
                seg2(x0, z0, x1, z1, 0, COL.white, 0.5);
              }
            const [zx, zz] = P((X.q[0] + X.q[1]) / 2, e);
            zebra.push({ cx: zx, cz: zz, ux: Y.nx * sg, uz: Y.nz * sg, s1: 0.9, s2: 5.1, hw: 24 });
            // 分離帯の先の信号（入ってくる車線の上へ短い腕）
            const le = X.flow[0] === -out ? 0 : X.flow[1] === -out ? 1 : -1;
            if (le >= 0) {
              const [qx, qz] = P((m0 + m1) / 2, e + sg * 0.95);
              const into = le === 0 ? -1 : 1;
              signalPoleR(qx, qz, hAt(qx, qz) + KERB, X.nx * into, X.nz * into, 3.2, 5.0);
            }
          }
          if (stopLine) {
            const uy = X.ux * Y.nx + X.uz * Y.nz, ny = X.nx * Y.nx + X.nz * Y.nz;
            const v = e + sg * (sig ? 5.6 : 1.6);
            for (const li of [0, 1]) {
              if (X.flow[li] !== -out) continue;
              const o0 = X.q[li] - hw + 0.3, o1 = X.q[li] + hw - 0.3;
              const aOf = (o: number) => (v - o * ny) / uy;
              const a = out > 0 ? Math.max(aOf(o0), aOf(o1)) : Math.min(aOf(o0), aOf(o1));
              const pt = (o: number): [number, number] => [X.ux * a + X.nx * o, X.uz * a + X.nz * o];
              const [x0, z0] = pt(o0), [x1, z1] = pt(o1);
              seg2(x0, z0, x1, z1, 0, COL.white, 0.45);
            }
          }
        }
      lineZb = false;
      lineKeep = false;
      // 交差点の中を照らす光（4つに分けて、それぞれの場所の路面の高さに）
      {
        const bq = quad(A, A.lo, A.hi, B, B.lo, B.hi);
        const size = Math.max(...bq.map(([x, z]) => Math.hypot(x - dc.cx, z - dc.cz))) * 1.1;
        for (const [x, z] of bq) poolAt(dc.cx + (x - dc.cx) / 3, dc.cz + (z - dc.cz) / 3, size, hAt);
      }
      onGround = false;
      liftCur = 0;
    };

    // ---- 都市高速のランプ（1×5マス）は、マスごとではなく1本の曲線として、あとでまとめて描く ----
    const uramps = findURamps(g, ROAD_LIFT);
    const urSkip = new Set<number>(); // マスごとには描かないノード
    const urMid = new Map<number, URamp>(); // 真ん中のマス（一般道へつながる腕と、つなぎ目の円だけ描く）
    const urHwCells = new Map<number, URamp[]>(); // ランプが分かれる・合わさる本線のマス（その側の欄干を切る）
    for (const U of uramps) {
      U.cells.forEach((c, k) => (k === 2 ? urMid.set(c, U) : urSkip.add((U.level ? NC : 0) + c)));
      for (const k of [0, 1, 5, 6]) {
        const nd = (U.level ? NC : 0) + U.hw[k];
        (urHwCells.get(nd) ?? urHwCells.set(nd, []).get(nd)!).push(U);
      }
    }
    const urNode = (nd: number) => urSkip.has(nd) || (nd >= 0 && nd < NC && urMid.has(nd));
    // ランプが分かれる・合わさる本線のまっすぐな帯（3点）で、ランプの側の欄干を切る範囲（分かれ始めから、分かれ目の先端まで）
    const urCut = (node: number, pts: RP[], hwHalf: number): Cut[] => {
      const cut: Cut[] = [];
      const last = pts[pts.length - 1];
      const tot = Math.hypot(last.x - pts[0].x, last.z - pts[0].z);
      const [px, pz] = [-(last.z - pts[0].z) / (tot || 1), (last.x - pts[0].x) / (tot || 1)];
      const rg = urGore(hwHalf, PAR_T), r0 = urStart(hwHalf);
      for (const U of urHwCells.get(node) ?? []) {
        const s0 = urampS(U, pts[0].x, pts[0].z);
        const dir = (last.x - pts[0].x) * U.ax + (last.z - pts[0].z) * U.az > 0 ? 1 : -1;
        for (const [lo, hi] of [[-UR_END + r0, -UR_END + rg], [UR_END - rg, UR_END - r0]]) {
          const c0 = (lo - s0) * dir, c1 = (hi - s0) * dir;
          const q0 = Math.max(0, Math.min(c0, c1)), q1 = Math.min(tot, Math.max(c0, c1));
          if (q1 > q0 + 0.01) cut.push({ side: U.sx * px + U.sz * pz > 0 ? 1 : 0, s0: q0, s1: q1 });
        }
      }
      return cut;
    };

    // ---- マス（ノード）ごと ----
    for (let node = 0; node < 2 * NC; node++) {
      const level = node >= NC ? 1 : 0;
      const i = node - level * NC;
      const t = level ? g.up[i] : g.road[i];
      if (!t) continue;
      // 大通りの交差点と転回場は、あとでまとめて描く
      if (level === 0 && (clusterOf[i] >= 0 || capOf[i] >= 0 || dclOf[i] >= 0)) continue;
      if (urSkip.has(node)) continue;
      S.owner = node;
      viaCur = level === 1 && isUrbanElevated(t);
      const x = i % n, y = (i / n) | 0;
      const cx = (x + 0.5) * CELL, cz = (y + 0.5) * CELL;
      const ch = g.nodeH(node) + ROAD_LIFT;
      const w = drawWidth(t);
      const swOf = (tt: number, c: number) => (tt === AV && g.deck[c] > 0 ? AV_SW_BRIDGE : sidewalkOf(tt));
      const sw = level ? sidewalkOf(t) : swOf(t, i);
      const m = level ? g.conn1[i] : g.conn[i];
      const ground = g.cellH(x, y);
      const elevated = level === 1 || g.deck[i] > 0;
      const raised = level === 0 && g.lift[i] > 0.3;
      const nodeGround = !elevated && !raised;
      // 上空の大通り（地上の高速道路をまたぐ立体交差）も、2本の車線で1枚の床版の大通りとして描く
      const isAv = t === AV;
      onGround = nodeGround;
      discCode = surfCode(0, isConc(t) ? SURF.concrete : SURF.asphalt, sw > 0 && !hasBarrier(t), hashInt(node, 77));
      liftCur = level === 0 ? g.lift[i] : 0;
      const arms: Arm[] = [];
      // 2車線（大通り）と1車線の道路のつなぎ目
      const info = level === 0 ? arms0(i) : null;
      const taper = info ? info.taper : null;
      const openEnd = info ? info.openEnd : -1;
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d)) || (info && info.skip.has(d))) continue;
        const nx = x + DX[d], ny = y + DY[d];
        const len = Math.hypot(DX[d], DY[d]);
        let tn = t, eh = ch, ng = true, nn = -1, swn = sw;
        if (g.inb(nx, ny)) {
          const j = ny * n + nx;
          const nl = g.arriveLevel(level, j, d);
          nn = nl * NC + j;
          tn = (nl ? g.up[j] : g.road[j]) || t;
          eh = (ch + g.nodeH(nl * NC + j) + ROAD_LIFT) / 2;
          ng = nl === 0 && g.deck[j] === 0 && g.lift[j] <= 0.3;
          swn = nl ? sidewalkOf(tn) : swOf(tn, j);
        }
        // 2マス幅の道路（高速道路）は、斜めだと車線の間隔が約11.3mになるので細くする
        const capW = (tt: number, ww: number) => (ROADS[tt]?.wide && isDiag(d) ? Math.min(ww, DIAG_LANE_W) : ww);
        const wa = capW(t, w);
        const wn = capW(tn, drawWidth(tn));
        // 大通りとほかの道路のつなぎ目では、どちらも自分の幅のまま（交わる道路の幅は変えない）
        const own = wideLocal(t) !== wideLocal(tn);
        const keepW = own || (taper && taper.d === d);
        arms.push({
          d, ux: DX[d] / len, uz: DY[d] / len, L: (CELL * len) / 2, ang: Math.atan2(DY[d], DX[d]),
          w: wa, wm: keepW ? wa : (wa + wn) / 2, sw, swm: own ? sw : (sw + swn) / 2, eh, t, tn, ng, nn,
        });
      }
      // 腕の端の高さから、マスの坂の傾きを求める（最小二乗）。高速道路では、ランプへの腕は使わない
      {
        let sxx = 1e-3, sxz = 0, szz = 1e-3, sxh = 0, szh = 0;
        const main = t !== RoadType.Ramp && arms.some((a) => a.tn !== RoadType.Ramp) ? arms.filter((a) => a.tn !== RoadType.Ramp) : arms;
        for (const a of main) {
          const dx = a.ux * a.L, dz = a.uz * a.L, dh = a.eh - ch;
          sxx += dx * dx; sxz += dx * dz; szz += dz * dz; sxh += dx * dh; szh += dz * dh;
        }
        const det = sxx * szz - sxz * sxz;
        gradX = (sxh * szz - szh * sxz) / det;
        gradZ = (szh * sxx - sxh * sxz) / det;
      }
      const armPts = (a: Arm, s0: number): RP[] => {
        const k = s0 / a.L;
        return [
          { x: cx + a.ux * s0, z: cz + a.uz * s0, h: lerp(ch, a.eh, k), hw: lerp(a.w, a.wm, k) / 2, sw: lerp(a.sw, a.swm, k), t },
          { x: cx + a.ux * a.L, z: cz + a.uz * a.L, h: a.eh, hw: a.wm / 2, sw: a.swm, t },
        ];
      };
      const k = arms.length;
      // 橋や高架につながるマスは、地面に合わせずに中心の高さで描く
      onGround = nodeGround && (arms.length >= 3 || arms.every((a) => a.ng));
      const ctlRaw = level === 0 && jcl ? jcl[i] : 0;
      // 大通りの交差点にロータリーは描かない（信号として描く）
      const ctl = isAv && ctlRaw === 4 ? 3 : ctlRaw;
      const asph = surfCol(t, isConc(t));

      // 大通りの帯：分離帯の側を調べて、外側に歩道、内側に分離帯を付ける。
      // fwd：点の並びが流れの向きか（分からなければ null）。ends：点の並びの最初と最後の腕。openAt：その端で広がる道路に合流する
      // refugeEnd：その長さ（m）だけ、帯の最後の分離帯を舗装した安全地帯にする（マスごとに描く交差点の、横断歩道のある腕）
      const avRibbon = (pts: RP[], fwd: boolean | null, ends: [Arm | null, Arm | null], openAt: [boolean, boolean] = [false, false], endN?: [number, number][], refugeEnd = 0) => {
        const kM = Math.floor(pts.length / 2);
        const pm = pts[kM], pA = pts[Math.max(0, kM - 1)], pB = pts[Math.min(pts.length - 1, kM + 1)];
        let tx = pB.x - pA.x, tz = pB.z - pA.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        // 流れが分かるときは、進む向きの左側を先に（曲がり角では反対車線が遠いので、遠くまで調べる）
        let med = -1;
        for (const si of fwd === false ? [1, 0] : [0, 1]) {
          const sg = si ? 1 : -1;
          if (twinAt(pm.x, pm.z, -tz * sg, tx * sg, node, fwd !== null && si === (fwd ? 0 : 1) ? 30 : 22)) {
            med = si;
            break;
          }
        }
        const sides: [Side, Side] = [true, true];
        if (med >= 0) sides[med] = 'med';
        const medMode = elevated ? 1 : g.rail[i] ? 2 : 0;
        let tot = 0;
        for (let q = 1; q < pts.length; q++) tot += Math.hypot(pts[q].x - pts[q - 1].x, pts[q].z - pts[q - 1].z);
        const cut: Cut[] = [];
        const noses: number[][] = [];
        const zones: MedZone[] = [];
        // 帯の始まりから sv の位置の点
        const ptAt = (sv: number): RP => {
          let acc = 0;
          for (let q = 1; q < pts.length; q++) {
            const a = pts[q - 1], b = pts[q], l = Math.hypot(b.x - a.x, b.z - a.z);
            if (acc + l >= sv || q === pts.length - 1) {
              const u = Math.max(0, Math.min(1, (sv - acc) / (l || 1)));
              return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), h: lerp(a.h, b.h, u), hw: lerp(a.hw, b.hw, u), sw: lerp(a.sw, b.sw, u), t: b.t };
            }
            acc += l;
          }
          return pts[0];
        };
        for (const e of [0, 1]) {
          const A = ends[e], atS = e === 0;
          if (A) {
            const tr = trims.get(node)?.find((q) => q.d === A.d);
            if (tr)
              for (const si of [0, 1]) {
                const Lt = tr.len[atS ? si : 1 - si];
                if (Lt > 0.01) cut.push({ side: si, s0: atS ? 0 : tot - Lt, s1: atS ? Lt : tot + 1 });
              }
          }
          if (med < 0 || medMode !== 0) continue;
          // 隣が大通りでない（ほかの道路、橋、踏切）ところでは、分離帯の先を丸める
          let open = openAt[e];
          if (A && A.nn >= 0) {
            const j = A.nn % NC;
            if (clusterOf[j] < 0 && capOf[j] < 0 && (A.nn >= NC || A.tn !== AV || g.rail[j] || g.deck[j] > 0)) open = true;
          }
          if (!open) continue;
          const p0 = atS ? pts[0] : pts[pts.length - 1], p1 = atS ? pts[1] : pts[pts.length - 2];
          let ux = p0.x - p1.x, uz = p0.z - p1.z;
          const ul = Math.hypot(ux, uz) || 1;
          ux /= ul;
          uz /= ul;
          // 点の並びの向きに対する右向き
          const ox = atS ? -ux : ux, oz = atS ? -uz : uz;
          const sg = med ? 1 : -1, nx = -oz * sg, nz = ox * sg;
          const diag = Math.abs(ux) > 0.3 && Math.abs(uz) > 0.3;
          // 斜めの大通りが上空の大通り（立体交差）へ上がるところ：2本の車線は半マスずれているので、
          // 反対車線がもう上空にいる位置なら、分離帯の先を半マス手前にして、そこから先は橋と同じ低い壁の分離帯にする
          let pull = 0;
          if (diag && A && A.nn >= NC && g.up[A.nn - NC] === AV) {
            const hd = CELL * Math.SQRT1_2;
            const qx = Math.floor((p0.x - ux * hd * 0.5 + nx * hd) / CELL), qz = Math.floor((p0.z - uz * hd * 0.5 + nz * hd) / CELL);
            if (g.inb(qx, qz) && g.up[qz * n + qx] === AV) pull = Math.min(hd, tot * 0.5);
          }
          const pe = pull > 0 ? ptAt(atS ? pull : tot - pull) : p0;
          const mw = Math.abs(medWAt(pe.x, pe.z, nx, nz, pe.hw, diag, node));
          if (mw < 0.8) continue;
          cut.push({ side: med, s0: atS ? pull : tot - pull - mw, s1: atS ? pull + mw : pull > 0 ? tot - pull : tot + 1 });
          if (pull > 0) zones.push({ s0: atS ? -1 : tot - pull, s1: atS ? pull : tot + 1, mode: 1 });
          noses.push([pe.x, pe.z, pe.h, ux, uz, nx, nz, pe.hw, mw]);
        }
        if (refugeEnd > 0 && medMode === 0) zones.push({ s0: Math.max(0, tot - refugeEnd), s1: tot + 1, mode: 3 });
        // 持ち上げた取り付け部分：反対車線と高さが少し違っても、分離帯のまん中にすき間が見えないように縁を下までのばす
        medSkirt = raised;
        ribbon(pts, t, sides, undefined, 0, { cut, medMode, endN, zones });
        medSkirt = false;
        for (const q of noses) noseQ(q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[8]);
        return med;
      };

      // バス停：歩道に待合所、車道の端に停車スペースの印
      if (level === 0 && g.bstop[i] && arms.length) {
        const a0 = arms.find((q) => !isDiag(q.d)) ?? arms[0];
        const ux = a0.ux, uz = a0.uz;
        let px = -uz, pz = ux;
        // 大通りは外側（分離帯と反対の側）の歩道に
        if (isAv) {
          const md = avenueMedianDir(g, i);
          if (md >= 0 && DX[md] * px + DY[md] * pz > 0) {
            px = -px;
            pz = -pz;
          }
        }
        // 大通りの広い歩道では、待合所を縁石の近くに置く（人は待合所のうしろを歩く）
        const hw = w / 2, so = isAv ? hw + 1.05 : hw + Math.max(sw, 1.2) * 0.55;
        const dep = 0.8, back = isAv ? 0.6 : 0.5; // 大通りの屋根の奥行きの半分、うしろの柱とガラスの位置
        const at = (s2: number, o: number): [number, number] => [cx + ux * s2 + px * o, cz + uz * s2 + pz * o];
        // 停車スペース（黄色の枠）
        const box: [number, number][] = [at(-4.5, hw - 2.8), at(4.5, hw - 2.8), at(4.5, hw - 0.4), at(-4.5, hw - 0.4)];
        for (let e = 0; e < 4; e++) {
          const [x0, z0] = box[e], [x1, z1] = box[(e + 1) % 4];
          line([{ x: x0, z: z0, h: ch, hw: 0, sw: 0, t }, { x: x1, z: z1, h: ch, hw: 0, sw: 0, t }], () => 0, COL.yellow, 0.18);
        }
        // 待合所
        const [sx, sz] = at(0, so);
        const y0 = ch + 0.16;
        for (const s2 of [-1.4, 1.4]) {
          const [qx, qz] = at(s2, so + back);
          O.box(qx - 0.06, y0, qz - 0.06, qx + 0.06, y0 + 2.5, qz + 0.06, COL.signal);
        }
        const [bx0, bz0] = at(-1.5, so + back + 0.05), [bx1, bz1] = at(1.5, so + back + 0.05);
        O.wall(bx0, bz0, y0, y0 + 2.3, bx1, bz1, y0, y0 + 2.3, COL.glass);
        // 屋根（大通りは道に沿った細長い屋根。ほかは 3.2m 四方）
        const [rx0, rz0] = isAv ? at(-1.6, so - dep) : [sx - 1.6, sz - 1.6], [rx1, rz1] = isAv ? at(1.6, so + dep) : [sx + 1.6, sz + 1.6];
        O.box(Math.min(rx0, rx1), y0 + 2.5, Math.min(rz0, rz1), Math.max(rx0, rx1), y0 + 2.65, Math.max(rz0, rz1), COL.signal);
        const [gx, gz] = at(2.4, so - 0.2);
        O.box(gx - 0.05, y0, gz - 0.05, gx + 0.05, y0 + 2.8, gz + 0.05, COL.signal);
        O.box(gx - 0.35, y0 + 2.3, gz - 0.35, gx + 0.35, y0 + 3.0, gz + 0.35, COL.busSign);
      }

      if (k === 0) {
        disc(cx, cz, ch, w / 2, asph);
        continue;
      }
      const opposite = k === 2 && ((arms[0].d + 4) & 7) === arms[1].d;
      if (k === 1 && openEnd >= 0) {
        // 大通りの車線の端：1車線の道路へ広がって合流するので、マスの端までまっすぐのばす
        const a = arms[0];
        const fx = DX[openEnd], fz = DY[openEnd];
        const pts: RP[] = [...armPts(a, 0).reverse(), { x: cx + fx * CELL * 0.5, z: cz + fz * CELL * 0.5, h: ch, hw: a.w / 2, sw: a.sw, t }];
        // 中央分離帯の側（相手の車線の側）には歩道を付けず、合流する端で分離帯を丸める
        const fwd = g.flow[i] & (1 << a.d) ? false : g.flow[i] ? true : null;
        if (isAv) avRibbon(pts, fwd, [a, null], [false, true]);
        else ribbon(pts, t);
        markings(pts, t);
        continue;
      }
      if (k === 2 && opposite && taper) {
        // 1車線の道路が、大通りの2つの車線の幅に広がってつながる
        // マス全体（後ろの端から前の端まで）で、大通りの側にだけ広げる。外側の縁はまっすぐ
        const ta = arms.find((q) => q.d === taper!.d)!, other = arms.find((q) => q !== ta)!;
        const sx = DX[taper.side], sz = DY[taper.side];
        const wn = drawWidth(ta.tn);
        const tp: RP[] = [];
        for (let s2 = 0; s2 <= 12; s2++) {
          const f = s2 / 12, e = f * f * (3 - 2 * f);
          const along = -other.L + (other.L + ta.L) * f;
          const half = lerp(w / 2, CELL / 2 + wn / 2, e);
          const shift = half - w / 2 - lerp(0, (wn - w) / 2, e); // 外側の縁が、道路の縁から大通りの外側の縁へ少しだけ動く
          tp.push({ x: cx + ta.ux * along + sx * shift, z: cz + ta.uz * along + sz * shift, h: lerp(other.eh, ta.eh, f), hw: half, sw: lerp(other.swm, swOf(ta.tn, ta.nn % NC), e), t });
        }
        // 帯の右向き（進む向きに対して）が、広がる側かどうかで符号を合わせる
        const rx = -ta.uz, rz = ta.ux;
        const N: [number, number] = [rx, rz];
        ribbon(tp, t, [true, true], N);
        lineN = N;
        markings(tp, t);
        lineN = null;
        continue;
      }
      if (k === 1) {
        // 行き止まり
        const a = arms[0];
        const pts = armPts(a, 0).reverse();
        const back = Math.atan2(-a.uz, -a.ux);
        if (t === RoadType.Street) {
          // 袋小路の転回場。腕の歩道は、転回場の円と交わるところで止める
          const r = w * 0.95, off = 1.5;
          const hw = a.w / 2;
          const cut = Math.sqrt(Math.max(0, r * r - hw * hw)) - off; // 中心から、歩道が円にぶつかるまでの距離
          const P: RP = { x: cx + a.ux * cut, z: cz + a.uz * cut, h: lerp(ch, a.eh, cut / a.L), hw, sw: a.sw, t };
          ribbon([pts[0], P], t);
          ribbon([P, pts[1]], t, [false, false]);
          markings(pts, t);
          if (elevated) deckUnder(pts, level ? ground : null);
          disc(cx - a.ux * off, cz - a.uz * off, ch, r, asph);
          const open = Math.asin(Math.min(1, hw / r));
          ringWalk(cx - a.ux * off, cz - a.uz * off, ch, r, r + sw, back - (Math.PI - open), back + (Math.PI - open));
          continue;
        }
        let med = -1;
        if (isAv) med = avRibbon(pts, g.flow[i] & (1 << a.d) ? false : g.flow[i] ? true : null, [a, null]);
        else ribbon(pts, t);
        markings(pts, t);
        if (elevated) deckUnder(pts, level ? ground : null, med);
        if (hasBarrier(t)) {
          disc(cx, cz, ch, w / 2, asph);
          O.wall(cx - a.uz * (w / 2 + 0.5), cz + a.ux * (w / 2 + 0.5), ch - 0.05, ch + 0.95, cx + a.uz * (w / 2 + 0.5), cz - a.ux * (w / 2 + 0.5), ch - 0.05, ch + 0.95, COL.barrier);
        } else {
          disc(cx, cz, ch, w / 2, asph);
          if (sw > 0 && !isAv) ringWalk(cx, cz, ch, w / 2, w / 2 + sw, back - Math.PI / 2, back + Math.PI / 2);
        }
        continue;
      }
      if (k === 2 && t !== RoadType.Ramp && !arms.some((q) => q.tn === RoadType.Ramp && hasBarrier(t))) {
        const [a, b] = arms;
        let pts: RP[];
        // カーブの帯の両端の横向き：腕の向きに直交（隣のマスのまっすぐな帯の端と同じ断面にする）
        let endN: [number, number][] | undefined;
        if (opposite) {
          pts = [...armPts(a, 0).reverse(), ...armPts(b, 0).slice(1)];
          pts[1] = { ...pts[1], hw: Math.min(a.w, b.w) / 2, sw };
        } else {
          // なめらかなカーブ（2次ベジェ曲線）
          pts = [];
          endN = [[a.uz, -a.ux], [-b.uz, b.ux]];
          const ax = cx + a.ux * a.L, az = cz + a.uz * a.L, bx = cx + b.ux * b.L, bz = cz + b.uz * b.L;
          const seg = 10;
          for (let s = 0; s <= seg; s++) {
            const u = s / seg;
            const p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
            const wc = Math.min(a.w, b.w);
            const half = u < 0.5 ? lerp(a.wm, wc, u * 2) : lerp(wc, b.wm, u * 2 - 1);
            const swv = u < 0.5 ? lerp(a.swm, sw, u * 2) : lerp(sw, b.swm, u * 2 - 1);
            pts.push({ x: p0 * ax + p1 * cx + p2 * bx, z: p0 * az + p1 * cz + p2 * bz, h: p0 * a.eh + p1 * ch + p2 * b.eh, hw: half / 2, sw: swv, t });
          }
        }
        // 地面に合わせる帯が、平らに描く隣のマスにつながる端：最後の 3m で、隣と同じ平らな高さへ移る（境目にすき間や段ができないように）
        if (onGround)
          for (const [e, q] of [[0, a], [1, b]] as const) {
            if (!q.ng || !flatDrawn(q.nn)) continue;
            let acc = 0;
            const order = e === 0 ? pts : [...pts].reverse();
            let k2 = 1;
            for (; k2 < order.length; k2++) {
              const l = Math.hypot(order[k2].x - order[k2 - 1].x, order[k2].z - order[k2 - 1].z);
              if (acc + l >= 3) {
                const u = (3 - acc) / (l || 1), A0 = order[k2 - 1], B0 = order[k2];
                order.splice(k2, 0, { x: lerp(A0.x, B0.x, u), z: lerp(A0.z, B0.z, u), h: lerp(A0.h, B0.h, u), hw: lerp(A0.hw, B0.hw, u), sw: lerp(A0.sw, B0.sw, u), t: B0.t, fw: 0 });
                break;
              }
              acc += l;
            }
            order[0] = { ...order[0], fw: 1 };
            pts = e === 0 ? order : order.reverse();
          }
        // 大通り：進む向きから見て左側が中央分離帯（反対車線）
        let med = -1;
        if (isAv) {
          const fl = g.flow[i] | g.flow1[i];
          med = avRibbon(pts, fl & (1 << b.d) ? true : fl & (1 << a.d) ? false : null, [a, b], undefined, endN);
        } else ribbon(pts, t, undefined, undefined, 0, { endN, cut: opposite && urHwCells.has(node) ? urCut(node, pts, Math.min(a.w, b.w) / 2) : undefined });
        lineEnds = endN ? [endN[0], endN[1]] : null;
        markings(pts, t);
        lineEnds = null;
        if (t === RoadType.OneWay && opposite) {
          // 一方通行の起点・終点（隣が一方通行のまっすぐな道路でない場所）に、進む向きの矢印を描く
          const straightOW = (q: Arm) => {
            const qx = x + DX[q.d], qy = y + DY[q.d];
            if (!g.inb(qx, qy)) return false;
            const j = qy * n + qx;
            return g.road[j] === RoadType.OneWay && g.conn[j] === ((1 << a.d) | (1 << b.d));
          };
          if (!straightOW(a) || !straightOW(b)) {
            const out = g.flow[i] & (1 << b.d) ? b : a;
            arrow(cx, cz, ch, out.ux, out.uz, w);
          }
        }
        if (elevated) deckUnder(pts, level ? ground : null, med);
        if (!elevated && (raised || pts.some((p) => p.h - ROAD_LIFT > g.groundAt(p.x, p.z) + 0.8))) embank(pts, med);
        continue;
      }

      // ---- 高速道路とランプの分岐・合流：交差点の形にせず、帯をそのままつなぐ ----
      if (hasBarrier(t)) {
        // 帯の右向きの法線
        const rightOf = (pts: RP[]) => {
          const p = pts[0], q = pts[pts.length - 1];
          const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
          return [-dz / l, dx / l];
        };
        if (level === 0 && urMid.has(i)) {
          // 都市高速のランプの真ん中（地上）：ランプの曲線は別に描くので、一般道へつながる腕と、つなぎ目の円だけ
          const side = arms.filter((q) => !urNode(q.nn));
          for (const a of side) {
            onGround = nodeGround && a.ng;
            ribbon(armPts(a, 0).reverse(), t, [false, false]);
          }
          onGround = nodeGround;
          if (side.length) disc(cx, cz, ch, UR_HALF, asph);
          continue;
        }
        if (t === RoadType.Ramp && k === 2) {
          // ランプの途中：まっすぐか曲線の帯。高速道路のすぐ横なら、そちら側の壁は省く
          const [a, b] = arms;
          const pts: RP[] = [];
          const ax = cx + a.ux * a.L, az = cz + a.uz * a.L, bx = cx + b.ux * b.L, bz = cz + b.uz * b.L;
          for (let s2 = 0; s2 <= 10; s2++) {
            const u = s2 / 10, p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
            const half = u < 0.5 ? lerp(a.wm, w, u * 2) : lerp(w, b.wm, u * 2 - 1);
            pts.push({ x: p0 * ax + p1 * cx + p2 * bx, z: p0 * az + p1 * cz + p2 * bz, h: p0 * a.eh + p1 * ch + p2 * b.eh, hw: Math.min(half, w) / 2, sw: 0, t });
          }
          const [px, pz] = rightOf(pts);
          const sides: [boolean, boolean] = [true, true];
          for (const sd of [0, 2, 4, 6]) {
            const qx = x + DX[sd], qy = y + DY[sd];
            if (!g.inb(qx, qy)) continue;
            const j = qy * n + qx;
            if (isHighway(level ? g.up[j] : g.road[j])) sides[DX[sd] * px + DY[sd] * pz > 0 ? 1 : 0] = false;
          }
          ribbon(pts, t, sides);
          markings(pts, t);
          if (elevated) deckUnder(pts, level ? ground : null);
          continue;
        }
        if (t === RoadType.Ramp) {
          // ランプ：高速道路へ向かう2本の腕を曲線でつなぎ、高速道路と反対側にだけ壁を付ける
          const hw = arms.filter((q) => isHighway(q.tn));
          const others = arms.filter((q) => !isHighway(q.tn));
          if (hw.length === 2) {
            const [a, b] = hw;
            const pts: RP[] = [];
            const ax = cx + a.ux * a.L, az = cz + a.uz * a.L, bx = cx + b.ux * b.L, bz = cz + b.uz * b.L;
            for (let s2 = 0; s2 <= 10; s2++) {
              const u = s2 / 10, p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
              pts.push({ x: p0 * ax + p1 * cx + p2 * bx, z: p0 * az + p1 * cz + p2 * bz, h: p0 * a.eh + p1 * ch + p2 * b.eh, hw: w / 2, sw: 0, t });
            }
            // 2本の腕の向きの和が、高速道路のある側
            const sx = a.ux + b.ux, sz = a.uz + b.uz;
            const [px, pz] = rightOf(pts);
            const hwRight = sx * px + sz * pz > 0;
            ribbon(pts, t, hwRight ? [true, false] : [false, true]);
            if (elevated) deckUnder(pts, level ? ground : null);
          } else for (const a of hw) ribbon(armPts(a, 0).reverse(), t, [false, false]);
          for (const a of others) {
            onGround = nodeGround && a.ng; // 高架へ上がる腕は、地面に合わせない
            const pts = armPts(a, 0).reverse();
            ribbon(pts, t, [false, false]);
            if (elevated) deckUnder(pts, level ? ground : null);
          }
          onGround = nodeGround;
          disc(cx, cz, ch, w / 2, asph);
          continue;
        }
        // 高速道路：本線（反対向きの2本）はまっすぐな帯にして、ランプが分かれる側だけ壁を切る
        // （都市高速のランプ（1×5マス）は別に描くので、ここでは分かれ道を描かず、分かれ目の先端までの欄干だけ切る）
        const ramps = arms.filter((q) => q.tn === RoadType.Ramp && !urNode(q.nn));
        const main = arms.filter((q) => q.tn !== RoadType.Ramp);
        const pair = main.length === 2 && ((main[0].d + 4) & 7) === main[1].d ? main : null;
        if (pair) {
          const [a, b] = pair;
          const pts = [...armPts(a, 0).reverse(), ...armPts(b, 0).slice(1)];
          pts[1] = { ...pts[1], hw: Math.min(a.w, b.w) / 2 };
          const [px, pz] = rightOf(pts);
          const sides: [boolean, boolean] = [true, true];
          for (const r of ramps) sides[r.ux * px + r.uz * pz > 0 ? 1 : 0] = false;
          const cut = urCut(node, pts, Math.min(a.w, b.w) / 2);
          ribbon(pts, t, sides, undefined, 0, cut.length ? { cut } : undefined);
          markings(pts, t);
          if (elevated) deckUnder(pts, level ? ground : null);
        } else {
          for (const a of main) {
            const pts = armPts(a, 0).reverse();
            ribbon(pts, t, ramps.length ? [false, false] : [true, true]);
            if (!isDiag(a.d)) markings(pts, t);
            if (elevated) deckUnder(pts, level ? ground : null);
          }
        }
        // ランプへ分かれる部分：壁のない路面。ランプの外側の縁に白線を続ける（本線側は本線の車線にかかるので引かない）
        const mu = pair ? [pair[0].ux, pair[0].uz] : main.length ? [main[0].ux, main[0].uz] : null;
        // 本線がまっすぐなときは、分かれ道の帯を本線のふちから始める（本線と重ならないように）
        const mainHalf = pair ? Math.min(...pair.map((q) => q.w)) / 2 - 0.3 : 0;
        for (const a of ramps) {
          const pts = armPts(a, Math.min(a.L * 0.8, mainHalf)).reverse();
          ribbon(pts, t, [false, false], undefined, onGround ? 0.03 : 0.12);
          if (!mu) continue;
          const p0 = pts[0], p1 = pts[pts.length - 1];
          const dx = p1.x - p0.x, dz = p1.z - p0.z, l = Math.hypot(dx, dz) || 1;
          const nx = -dz / l, nz = dx / l;
          const far = (sd: number) => Math.abs((p0.x + nx * sd * 3 - cx) * mu[1] - (p0.z + nz * sd * 3 - cz) * mu[0]);
          const outer = far(1) > far(-1) ? 1 : -1;
          line(pts, (p) => outer * (p.hw - 0.4), COL.white, 0.15);
        }
        disc(cx, cz, Math.min(...arms.map((q) => q.w)) / 2 > 0 ? ch : ch, Math.min(...arms.map((q) => q.w)) / 2, asph);
        continue;
      }

      // ---- 交差点（3本以上） ----
      arms.sort((p, q) => p.ang - q.ang);
      // 大通りどうしの曲がり角など、大通りの中だけの形（交差点の設備は付けない）
      const bend = isAv && arms.every((q) => q.tn === AV);
      const maxHalf = Math.max(...arms.map((a) => a.w / 2 + (hasBarrier(a.t) ? 0.6 : a.sw)));
      const round = ctl === 4;
      const R = round ? maxHalf + 3 : 0;
      const starts = arms.map((a) => Math.min(a.L * 0.85, round ? R - 1 : maxHalf + 0.6));
      // 交差点の大通りの車線で、反対車線へ向かう腕（大通りの中の交差点のマスへの腕）
      // 大通りが斜めに交わる交差点など、マスごとに描く交差点では、となりの交差点のマスへの腕も中の腕（停止線・横断歩道を付けない）
      const innerArm = (a: Arm) => {
        if (a.nn < 0 || a.nn >= NC) return false;
        const j = a.nn;
        if (!isAv && !wideLocal(g.road[j])) return false;
        if (!groundCell(j) || !g.road[j] || isHighway(g.road[j]) || g.road[j] === RoadType.Ramp) return false;
        let dg = 0;
        for (let q = 0; q < 8; q++) if (g.conn[j] & (1 << q)) dg++;
        return dg >= 3;
      };
      arms.forEach((a, k2) => {
        const pts = armPts(a, starts[k2]).reverse();
        onGround = nodeGround && a.ng;
        // 信号のある交差点の、横断歩道のある腕：分離帯の先を安全地帯にする
        if (isAv) avRibbon(pts, null, [a, null], undefined, undefined, ctl === 3 && !innerArm(a) ? 4.4 : 0);
        else ribbon(pts, t);
        markings(pts, t);
        if (elevated) deckUnder(pts, level ? ground : null);
      });
      onGround = nodeGround;
      if (round) {
        disc(cx, cz, ch, R, asph, S, 32);
        const ri = R * 0.45, ra = R * 0.6; // 中央の島、トラック用のエプロン（少し高い石畳）
        disc(cx, cz, ch + 0.12, ra, COL.concrete, O, 28);
        for (let s2 = 0; s2 < 28; s2++) {
          const a0 = (s2 / 28) * Math.PI * 2, a1 = ((s2 + 1) / 28) * Math.PI * 2;
          O.wall(cx + Math.cos(a0) * ra, cz + Math.sin(a0) * ra, ch - 0.05, ch + 0.12, cx + Math.cos(a1) * ra, cz + Math.sin(a1) * ra, ch - 0.05, ch + 0.12, COL.curb);
          O.wall(cx + Math.cos(a0) * ri, cz + Math.sin(a0) * ri, ch + 0.1, ch + 0.4, cx + Math.cos(a1) * ri, cz + Math.sin(a1) * ri, ch + 0.1, ch + 0.4, COL.curb);
        }
        disc(cx, cz, ch + 0.4, ri, COL.island, O, 24);
        // 島の植え込みと記念塔
        disc(cx, cz, ch + 0.45, ri * 0.55, new THREE.Color(0xc26f8e), O, 16);
        disc(cx, cz, ch + 0.5, ri * 0.32, new THREE.Color(0xe8c54a), O, 12);
        O.box(cx - 0.6, ch + 0.4, cz - 0.6, cx + 0.6, ch + 3.2, cz + 0.6, COL.barrier);
        O.box(cx - 0.9, ch + 3.2, cz - 0.9, cx + 0.9, ch + 3.5, cz + 0.9, COL.barrier);
        // 外側の白線（円）
        const ring: RP[] = [];
        for (let s2 = 0; s2 <= 40; s2++) {
          const a0 = (s2 / 40) * Math.PI * 2;
          ring.push({ x: cx + Math.cos(a0) * (R - 0.6), z: cz + Math.sin(a0) * (R - 0.6), h: ch, hw: 0, sw: 0, t });
        }
        // 腕の入口の部分は線を引かない
        const angs = arms.map((q) => q.ang);
        const near = (p: RP) => angs.some((an) => { let d = Math.atan2(p.z - cz, p.x - cx) - an; d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.abs(d) < 0.62; });
        let seg: RP[] = [];
        for (const p of ring) {
          if (near(p)) { if (seg.length > 1) line(seg, () => 0, COL.white, 0.15); seg = []; } else seg.push(p);
        }
        if (seg.length > 1) line(seg, () => 0, COL.white, 0.15);
        for (const a of arms) {
          const px = -a.uz, pz = a.ux;
          const s0 = R + 0.2;
          // ゆずれの線（入ってくる車線、-p 側）：白い三角の列
          for (let o = -a.w / 2 + 0.5; o < -0.4; o += 0.9) {
            const bx = cx + a.ux * s0 + px * o, bz = cz + a.uz * s0 + pz * o;
            line([{ x: bx, z: bz, h: ch, hw: 0, sw: 0, t }, { x: bx + a.ux * 0.6, z: bz + a.uz * 0.6, h: ch, hw: 0, sw: 0, t }], () => 0, COL.white, 0.4);
          }
          // 分離島（両方向の道路だけ）：入口の真ん中の細長い島
          if (!ROADS[a.t]?.oneWay && !ROADS[a.tn]?.oneWay) {
            const s1 = R + 0.6, s2 = Math.min(a.L - 0.3, R + 5.5);
            if (s2 > s1 + 1) {
              const P = (sAlong: number, o: number) => [cx + a.ux * sAlong + px * o, cz + a.uz * sAlong + pz * o];
              const q = [P(s1, 0), P(s1 + 1.2, -0.9), P(s2, -0.5), P(s2, 0.5), P(s1 + 1.2, 0.9)];
              const top = q.map(([x, z]) => O.v(x, ch + 0.25, z, COL.island));
              for (let e = 1; e + 1 < top.length; e++) O.tri(top[0], top[e], top[e + 1]);
              for (let e = 0; e < q.length; e++) {
                const [x0, z0] = q[e], [x1, z1] = q[(e + 1) % q.length];
                O.wall(x0, z0, ch - 0.05, ch + 0.25, x1, z1, ch - 0.05, ch + 0.25, COL.curb);
              }
            }
          }
        }
        // 腕と腕の間の歩道
        const sorted = [...arms].sort((p, q) => p.ang - q.ang);
        for (let k2 = 0; k2 < sorted.length; k2++) {
          const a = sorted[k2], b = sorted[(k2 + 1) % sorted.length];
          const ga = Math.asin(Math.min(0.95, (a.w / 2 + 0.4) / R)), gb = Math.asin(Math.min(0.95, (b.w / 2 + 0.4) / R));
          let a0 = a.ang + ga, a1 = b.ang - gb;
          if (k2 === sorted.length - 1) a1 += Math.PI * 2;
          const swr = Math.min(sidewalkOf(a.t) || 0, sidewalkOf(b.t) || 0) || 1.6;
          if (a1 - a0 > 0.1) ringWalk(cx, cz, ch, R, R + swr, a0, a1);
        }
        continue;
      }
      // 角の丸い路面：腕の端の角どうしを曲線でつなぐ
      // 模様のため、頂点に「ふちからの距離」を入れる（中心は車道の半分の幅、縁石の曲線は 0、腕の入口の真ん中は腕の半分の幅）
      S.aux = [0, 0, Math.min(...arms.map((q) => q.w / 2)), discCode];
      const ci = S.v(cx, H(cx, cz, ch), cz, asph);
      const outline: number[] = [];
      for (let k2 = 0; k2 < arms.length; k2++) {
        const a = arms[k2], b = arms[(k2 + 1) % arms.length];
        const sa = starts[k2], sb = starts[(k2 + 1) % arms.length];
        {
          const mx = cx + a.ux * sa, mz = cz + a.uz * sa;
          S.aux = [0, 0, a.w / 2, discCode];
          outline.push(S.v(mx, H(mx, mz, ch), mz, asph));
          S.aux = [0, 0, 0, discCode];
        }
        const pa = [-a.uz, a.ux], pb = [-b.uz, b.ux];
        // 45° の鋭い角：角を丸めず、歩道も付けない（ほかの道路の上にはみ出すため）
        const gap = (b.ang - a.ang + Math.PI * 4) % (Math.PI * 2);
        const acute = gap < 1.2;
        const Ra = [cx + a.ux * sa + pa[0] * (a.w / 2), cz + a.uz * sa + pa[1] * (a.w / 2)];
        const Lb = [cx + b.ux * sb - pb[0] * (b.w / 2), cz + b.uz * sb - pb[1] * (b.w / 2)];
        // 2本の道路の端の線が交わる点を、曲線の制御点にする
        const det = a.ux * b.uz - a.uz * b.ux;
        let K = [(Ra[0] + Lb[0]) / 2, (Ra[1] + Lb[1]) / 2];
        if (Math.abs(det) > 1e-3) {
          const dx = Lb[0] - Ra[0], dz = Lb[1] - Ra[1];
          const tA = (dx * b.uz - dz * b.ux) / det;
          const cand = [Ra[0] + a.ux * tA, Ra[1] + a.uz * tA];
          if (!acute && Math.hypot(cand[0] - cx, cand[1] - cz) < maxHalf * 2.2) K = cand;
        }
        const seg = 6;
        const curve: [number, number][] = [];
        for (let s = 0; s <= seg; s++) {
          const u = s / seg;
          const p0 = (1 - u) * (1 - u), p1 = 2 * u * (1 - u), p2 = u * u;
          curve.push([p0 * Ra[0] + p1 * K[0] + p2 * Lb[0], p0 * Ra[1] + p1 * K[1] + p2 * Lb[1]]);
        }
        for (const [px, pz] of curve) outline.push(S.v(px, H(px, pz, ch), pz, asph));
        // 角の歩道（大通りの車線どうしの角や、反対車線へ向かう側の角には付けない）
        const swc = Math.min(sidewalkOf(a.t) || 0, sidewalkOf(b.t) || 0);
        const toTwin = isAv && (bend || (innerArm(a) && innerArm(b)) || (() => {
          const [mx, mz] = curve[seg >> 1];
          const dx = mx - cx, dz = mz - cz, dl = Math.hypot(dx, dz) || 1;
          return rayHit(mx, mz, dx / dl, dz / dl, 12, i) < 12;
        })());
        if (swc > 0 && !acute && !toTwin) {
          let prev: number[] | null = null;
          curve.forEach(([px, pz], ci2) => {
            // 歩道の向きは曲線の接線に直角（T字路のまっすぐな縁でも、扇形に広がらないように）
            const A2 = curve[Math.max(0, ci2 - 1)], B2 = curve[Math.min(curve.length - 1, ci2 + 1)];
            let dx = B2[1] - A2[1], dz = -(B2[0] - A2[0]);
            if (dx * (px - cx) + dz * (pz - cz) < 0) {
              dx = -dx;
              dz = -dz;
            }
            const l = Math.hypot(dx, dz) || 1;
            const ox = px + (dx / l) * swc, oz = pz + (dz / l) * swc;
            const hi = H(px, pz, ch), ho = H(ox, oz, ch);
            if (prev) {
              const walls = [[prev[0], prev[1], prev[2] - 0.05, prev[2] + 0.16, px, pz, hi - 0.05, hi + 0.16]];
              if (onGround) walls.push([prev[3], prev[4], prev[5] - 1.2, prev[5] + 0.16, ox, oz, ho - 1.2, ho + 0.16]);
              walkQ.push({ p: [prev[0], prev[2] + 0.16, prev[1], prev[3], prev[5] + 0.16, prev[4], ox, ho + 0.16, oz, px, hi + 0.16, pz], w: walls, o: S.owner });
            }
            prev = [px, pz, hi, ox, oz, ho];
          });
        }
      }
      S.aux = AUX0;
      for (let s = 0; s < outline.length; s++) S.tri(ci, outline[s], outline[(s + 1) % outline.length]);
      if (elevated) deckUnder([{ x: cx, z: cz, h: ch, hw: maxHalf, sw: 0, t }, { x: cx + 0.01, z: cz, h: ch, hw: maxHalf, sw: 0, t }], level ? ground : null);
      if (bend) continue;

      // 停止線と横断歩道（信号・一時停止）
      arms.forEach((a, k2) => {
        const s0 = starts[k2];
        const px = -a.uz, pz = a.ux;
        lineAlso = a.nn;
        lineZb = true; // 停止線と横断歩道（切り取らない）
        if (innerArm(a)) return;
        // 一方通行の車線（大通り）は、入ってくる車線なら幅いっぱい、出ていく車線には引かない
        const ow = !!ROADS[t]?.oneWay, nnc = a.nn >= 0 && a.nn < NC ? a.nn : -1;
        const entering = !ow || (nnc >= 0 && !!(g.flow[nnc] & (1 << opp(a.d))));
        if ((ctl === 2 || ctl === 3) && entering) {
          // 交差点に入ってくる車線は、腕の向きから見て右側（-p 側）
          const sd = s0 + (ctl === 3 ? 4.2 : 0.6), o1 = ow ? a.w / 2 - 0.3 : 0;
          line([{ x: cx + a.ux * sd - px * (a.w / 2 - 0.3), z: cz + a.uz * sd - pz * (a.w / 2 - 0.3), h: ch, hw: 0, sw: 0, t }, { x: cx + a.ux * sd + px * o1, z: cz + a.uz * sd + pz * o1, h: ch, hw: 0, sw: 0, t }], () => 0, COL.white, 0.45);
        }
        if (ctl === 3 && a.t !== RoadType.Street && !arms.some((q) => q.tn === RoadType.Ramp)) {
          zebra.push({ cx, cz, ux: a.ux, uz: a.uz, s1: s0 - 1.0, s2: s0 + 3.95, hw: a.w / 2 + 0.5 });
          // 横断歩道（しま模様）
          for (let o = -a.w / 2 + 0.6; o < a.w / 2 - 0.3; o += 1.0) {
            const s1 = s0 + 0.6, s2 = s0 + 3.4;
            line([{ x: cx + a.ux * s1 + px * o, z: cz + a.uz * s1 + pz * o, h: ch, hw: 0, sw: 0, t }, { x: cx + a.ux * s2 + px * o, z: cz + a.uz * s2 + pz * o, h: ch, hw: 0, sw: 0, t }], () => 0, COL.white, 0.5);
          }
        }
      });
      lineAlso = -1;
      lineZb = false;
      // 優先道路のセンターラインは交差点の中も続ける（信号のない交差点）
      if (ctl !== 3) {
        const rank = (a: Arm) => ROADS[a.t].rank * 10 + a.w;
        for (const a of arms) {
          const b = arms.find((q) => q.d === ((a.d + 4) & 7));
          if (!b || a.d > b.d) continue;
          const others = arms.filter((q) => q !== a && q !== b);
          if (others.every((q) => rank(q) < rank(a)) || others.length === 1) {
            const sa = starts[arms.indexOf(a)], sb = starts[arms.indexOf(b)];
            const pts: RP[] = [
              { x: cx + a.ux * sa, z: cz + a.uz * sa, h: ch, hw: a.w / 2, sw: 0, t },
              { x: cx + b.ux * sb, z: cz + b.uz * sb, h: ch, hw: b.w / 2, sw: 0, t },
            ];
            if (t === RoadType.Road) {
              line(pts, () => -0.16, COL.yellow, 0.13);
              line(pts, () => 0.16, COL.yellow, 0.13);
            } else if (t === RoadType.OneWay || t === RoadType.Avenue) line(pts, () => 0, COL.white, 0.14, true);
            break;
          }
        }
      }
      // 信号機
      if (ctl === 3) {
        const o = maxHalf + 0.3;
        for (const [sx, sz] of [[1, 1], [-1, -1]]) {
          const qx = cx + sx * o, qz = cz + sz * o;
          O.box(qx - 0.15, ch, qz - 0.15, qx + 0.15, ch + 5.6, qz + 0.15, COL.signal);
          O.box(Math.min(qx, qx - sx * 4), ch + 5.4, qz - 0.1, Math.max(qx, qx - sx * 4), ch + 5.6, qz + 0.1, COL.signal);
          O.box(qx - sx * 3.2 - 0.3, ch + 4.6, qz - 0.3, qx - sx * 3.2 + 0.3, ch + 5.4, qz + 0.3, COL.signal);
        }
      }
    }
    // ---- 都市高速のランプ：1本のなめらかな曲線の帯と、高架の断面（低い所は擁壁）、橋脚 ----
    viaCur = false;
    onGround = false;
    liftCur = 0;
    for (const U of uramps) {
      const hwHalf = drawWidth(U.level ? g.up[U.hw[3]] : g.road[U.hw[3]]) / 2;
      const rg = urGore(hwHalf, PAR_T), r0 = urStart(hwHalf);
      S.owner = (U.level ? NC : 0) + U.cells[0];
      const mid = U.cells[2];
      // 真ん中のマスで、外側の一般道へつながっているか（そこは外側の欄干を付けない）
      const hasRoad = !!(g.conn[mid] & (1 << dirOf(U.sx, U.sz)));
      const ss: number[] = [];
      for (let q = 0; q <= 72; q++) ss.push(-UR_END + (2 * UR_END * q) / 72);
      ss.push(-UR_END + rg, UR_END - rg, -UR_END + r0, UR_END - r0, -9.5, 9.5);
      ss.sort((p, q) => p - q);
      interface US { x: number; z: number; h: number; nx: number; nz: number; half: number; hi: number; ho: number; pi: boolean; po: boolean; oi: number; oo: number; s: number }
      const L: US[] = [];
      const P: UPt = { x: 0, z: 0, h: 0, tx: 0, tz: 1, o: 0 };
      for (const s of ss) {
        if (L.length && Math.abs(L[L.length - 1].s - s) < 0.2) continue;
        urampAt(U, s, P);
        const r = UR_END - Math.abs(s);
        if (r < r0 - 0.01) continue;
        const oo = P.o + UR_HALF, oi = r < rg ? Math.max(P.o - UR_HALF, hwHalf - 0.1) : P.o - UR_HALF;
        // ランプの側への横向き（進む向きに直角）
        let nx = -P.tz, nz = P.tx;
        if (nx * U.sx + nz * U.sz < 0) { nx = -nx; nz = -nz; }
        const m = (oi + oo) / 2 - P.o, half = (oo - oi) / 2;
        const x = P.x + nx * m, z = P.z + nz * m;
        // 分かれ目の手前では、本線の側の縁を本線の高さにそろえる（段差を作らない）
        let hi = P.h, ho = P.h;
        if (r < rg) hi = P.h + (urHw(U, s) - P.h) * (1 - Math.min(1, Math.max(0, (r - rg + 6) / 6)));
        // 地上に近いところは、地面に合わせる
        const gc = g.groundAt(x, z) + ROAD_LIFT;
        const fw = U.level ? Math.min(1, Math.max(0, (P.h - gc) / 1.2)) : 0;
        const gAt = (o: number) => g.groundAt(x + nx * o, z + nz * o) + ROAD_LIFT;
        hi = lerp(gAt(-half), hi, fw);
        ho = lerp(gAt(half), ho, fw);
        const h = lerp(gc, P.h, fw);
        const cl = P.h - gc;
        const hp = !U.level || cl >= 0.5;
        L.push({ x, z, h, nx, nz, half, hi, ho, pi: r >= rg && hp, po: !(hasRoad && Math.abs(s) < 9.4) && hp, oi, oo, s });
      }
      if (L.length < 2) continue;
      // 路面（進む向きの右の向き。点の並びは s の増える向き）
      const rx0 = -urampAt(U, 0, P).tz, rz0 = P.tx;
      const outRight = rx0 * U.sx + rz0 * U.sz > 0; // 右がランプの外側
      const code = surfCode(lanesOf(RoadType.Ramp), SURF.concrete, false, hashInt(U.cells[0], 5));
      let along = 0;
      const ids: [number, number][] = [];
      L.forEach((q, k) => {
        if (k) along += Math.hypot(q.x - L[k - 1].x, q.z - L[k - 1].z);
        S.aux = [-q.half, along, q.half, code];
        const a = S.v(q.x - q.nx * q.half, q.hi, q.z - q.nz * q.half, COL.slab);
        S.aux = [q.half, along, q.half, code];
        const b = S.v(q.x + q.nx * q.half, q.ho, q.z + q.nz * q.half, COL.slab);
        ids.push([a, b]);
      });
      S.aux = AUX0;
      for (let k = 0; k + 1 < ids.length; k++) {
        S.tri(ids[k][0], ids[k][1], ids[k + 1][1]);
        S.tri(ids[k][0], ids[k + 1][1], ids[k + 1][0]);
      }
      // 両端の白線（外側は本線の路面より外だけ。本線の側は分かれ目の先から）
      const runs = (ok: (q: US) => boolean, sg: number) => {
        let run: RP[] = [];
        const flush = () => { if (run.length > 1) line(run, () => 0, COL.white, 0.15); run = []; };
        for (const q of L) {
          if (!ok(q)) { flush(); continue; }
          const o = sg * (q.half - 0.4);
          run.push({ x: q.x + q.nx * o, z: q.z + q.nz * o, h: sg > 0 ? q.ho : q.hi, hw: 0, sw: 0, t: RoadType.Ramp });
        }
        flush();
      };
      runs((q) => q.oo - 0.4 > hwHalf + 0.15, 1);
      lineAlso = mid;
      runs((q) => UR_END - Math.abs(q.s) >= rg, -1);
      lineAlso = -1;
      // 断面（VP の右 = 進む向きの右）
      const V: VP[] = L.map((q) => {
        const nx = outRight ? q.nx : -q.nx, nz = outRight ? q.nz : -q.nz;
        const io = outRight ? 0 : 1; // 本線の側
        const hs: [number, number] = io === 0 ? [q.hi, q.ho] : [q.ho, q.hi];
        const para: [boolean, boolean] = io === 0 ? [q.pi, q.po] : [q.po, q.pi];
        return { x: q.x, z: q.z, h: q.h, nx, nz, e: [q.half, q.half], hs, para };
      });
      via(V, VIA_RAMP);
      // 橋脚：本線から 24m（1本）。低い所（擁壁）には立てない
      if (U.level)
        for (const s of [-(UR_END - 24), UR_END - 24]) {
          urampAt(U, s, P);
          const bot = P.h - FAS - VIA_RAMP.depth, gnd = g.groundAt(P.x, P.z);
          const cx2 = Math.floor(P.x / CELL), cz2 = Math.floor(P.z / CELL);
          if (bot - gnd < 1.2 || !g.inb(cx2, cz2) || g.road[cz2 * n + cx2] || g.rail[cz2 * n + cx2]) continue;
          const top = bot + 0.15, gw = UR_HALF + PAR_T - VIA_RAMP.over - VIA_RAMP.depth * SL_T;
          const rings: [number, number, number, number][] = [[gnd - 0.6, 0.7, 0.9, 2], [Math.max(gnd, top - 1.6), 0.7, 0.9, 2]];
          if (top - 1.6 > gnd + 0.5) rings.push([top - 0.7, 0.74, 1.15, 2.4], [top, 0.78, Math.min(1.5, gw - 0.2), 3]);
          else rings.push([top, 0.7, 0.9, 2]);
          pier(P.x, P.z, P.tx, P.tz, rings, COL.pier);
          footing(P.x, P.z, P.tx, P.tz, 1.1, 1.3, gnd);
        }
    }
    // ---- 都市高速の高架の橋脚：まっすぐな区間の、マスの境（偶数番目）ごとに1本（32m）。下の道路・線路をよける ----
    {
      const gw = (t: number) => drawWidth(t) / 2 + PAR_T - VIA_MAIN.over - VIA_MAIN.depth * SL_T;
      const pierAt = (x: number, z: number, ux: number, uz: number, hTop: number, t: number) => {
        const top = hTop - FAS - VIA_MAIN.depth + 0.15, gnd = g.groundAt(x, z);
        if (top - gnd < 1.4) return;
        const rings: [number, number, number, number][] = [[gnd - 0.6, 0.9, 1.2, 2]];
        // 上の張り出し（T 形の梁）：柱から桁の下面の幅まで、なめらかに広がる
        if (top - gnd > 4) rings.push([top - 2.0, 0.9, 1.2, 2], [top - 1.1, 0.94, 1.55, 2.3], [top - 0.45, 1.0, gw(t) - 0.55, 3], [top, 1.02, gw(t) - 0.35, 3.4]);
        else rings.push([top, 0.9, 1.2, 2]);
        pier(x, z, ux, uz, rings, COL.pier);
        footing(x, z, ux, uz, 1.4, 1.75, gnd);
      };
      // マス A と、向き d の隣 B の境：下を道路・線路が通るか
      const blocked = (A: number, d: number) => (g.road[A] !== 0 && (g.conn[A] & (1 << d)) !== 0) || (g.rail[A] & (1 << d)) !== 0;
      const straight = (c: number, d: number) => c >= 0 && isUrbanElevated(g.up[c]) && (g.conn1[c] & (1 << d)) !== 0 && (g.conn1[c] & (1 << opp(d))) !== 0;
      const tryEdge = (A: number, d: number) => {
        const B = nb(A, d);
        if (!straight(A, d) || !straight(B, d) || blocked(A, d)) return false;
        const x = (A % n) + 0.5 + DX[d] / 2, y = ((A / n) | 0) + 0.5 + DY[d] / 2;
        pierAt(x * CELL, y * CELL, DX[d], DY[d], (g.upH[A] + g.upH[B]) / 2 + ROAD_LIFT, g.up[A]);
        return true;
      };
      for (let i = 0; i < NC; i++) {
        if (!isUrbanElevated(g.up[i])) continue;
        const x = i % n, y = (i / n) | 0;
        for (const d of [0, 2]) {
          if (((d === 0 ? x : y) + 1) & 1) continue;
          // 偶数番目の境に立てられなければ、その先の境に
          if (!tryEdge(i, d) && straight(i, d)) tryEdge(nb(i, d), d);
        }
        // 斜めの区間：x が偶数のマスの中心（約 45m ごと）
        for (const d of [1, 3])
          if (!(x & 1) && straight(i, d) && !g.road[i] && !g.rail[i]) pierAt((x + 0.5) * CELL, (y + 0.5) * CELL, DX[d] * Math.SQRT1_2, DY[d] * Math.SQRT1_2, g.upH[i] + ROAD_LIFT, g.up[i]);
      }
    }
    // ---- 大通りの交差点と転回場 ----
    for (const cl of clusters) drawCluster(cl);
    for (const c of caps) (c.diag ? drawDiagCap : drawCap)(c);
    for (const dc of dcls) drawDiag(dc);
    // ---- 斜めの道路どうしが X 字に交わる角：交差点の路面 ----
    for (let i = 0; i < NC; i++) {
      const t = g.road[i];
      if (!t || g.up[i]) continue;
      const x = i % n, y = (i / n) | 0;
      for (const d of [1, 3]) {
        if (!(g.conn[i] & (1 << d))) continue;
        const ax = x + DX[d], ay = y, bx = x, by = y + DY[d];
        if (!g.inb(ax, ay) || !g.inb(bx, by)) continue;
        const dd = d === 1 ? 3 : 1; // (ax,ay) → (bx,by) の向き
        if (!(g.conn[ay * n + ax] & (1 << dd))) continue;
        const t2 = g.road[ay * n + ax];
        const cx = (x + 0.5 + DX[d] / 2) * CELL, cz = (y + 0.5 + DY[d] / 2) * CELL;
        const w = Math.max(drawWidth(t), t2 ? drawWidth(t2) : 0);
        S.owner = -3;
        onGround = true;
        liftCur = 0;
        const asph = t === RoadType.Street || t2 === RoadType.Street ? COL.asphaltStreet : COL.asphalt;
        discCode = surfCode(0, SURF.asphalt, false, hashInt(i, 91));
        disc(cx, cz, g.groundAt(cx, cz) + ROAD_LIFT + 0.04, w * 0.78, asph, S, 24, 0);
      }
    }
    onGround = false;

    // ---- 斜めの大通りの交差点のまわり：交差点の側の路面を切り取る ----
    if (clipOf.size) {
      const I0 = S.I.slice(), T0 = S.T.slice();
      S.I.length = 0;
      S.T.length = 0;
      for (let t3 = 0; t3 < T0.length; t3++) {
        S.I.push(I0[t3 * 3], I0[t3 * 3 + 1], I0[t3 * 3 + 2]);
        S.T.push(T0[t3]);
        const cs = clipOf.get(T0[t3]);
        if (cs) S.clipFrom(S.T.length - 1, cs.surf);
      }
    }
    // ---- 重なりの取り除き ----
    // 路面の三角形を、マスごとの入れ物に分けておく
    const buckets = new Map<number, number[]>();
    const SP = S.P, SI = S.I;
    const TB = new Float32Array((SI.length / 3) * 4); // 三角形の範囲（先にこれで外れを除く）
    for (let t3 = 0; t3 < SI.length / 3; t3++) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let q = 0; q < 3; q++) {
        const vi = SI[t3 * 3 + q];
        x0 = Math.min(x0, SP[vi * 3]); x1 = Math.max(x1, SP[vi * 3]);
        z0 = Math.min(z0, SP[vi * 3 + 2]); z1 = Math.max(z1, SP[vi * 3 + 2]);
      }
      TB[t3 * 4] = x0; TB[t3 * 4 + 1] = x1; TB[t3 * 4 + 2] = z0; TB[t3 * 4 + 3] = z1;
      for (let by = Math.floor(z0 / CELL); by <= Math.floor(z1 / CELL); by++)
        for (let bx = Math.floor(x0 / CELL); bx <= Math.floor(x1 / CELL); bx++) {
          const key = by * 4096 + bx;
          (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(t3);
        }
    }
    // 点 (x, z) が、owner 以外の道路の路面の内側（ふちから少し内側）にあるか。
    // y があれば、高さが近い（2m 以内の）路面だけを見る（立体交差の上の歩道や線を、下の道路で消さないように）
    const onOtherRoad = (x: number, z: number, owner: number, also = -1, y = NaN) => {
      const list = buckets.get(Math.floor(z / CELL) * 4096 + Math.floor(x / CELL));
      if (!list) return false;
      for (const t3 of list) {
        if (x < TB[t3 * 4] || x > TB[t3 * 4 + 1] || z < TB[t3 * 4 + 2] || z > TB[t3 * 4 + 3]) continue;
        if (S.T[t3] === owner || S.T[t3] === also) continue;
        const a = SI[t3 * 3], b = SI[t3 * 3 + 1], c = SI[t3 * 3 + 2];
        if (y === y && Math.abs(y - (SP[a * 3 + 1] + SP[b * 3 + 1] + SP[c * 3 + 1]) / 3) > 2) continue;
        const ax = SP[a * 3], az = SP[a * 3 + 2], bx = SP[b * 3], bz = SP[b * 3 + 2], cx = SP[c * 3], cz = SP[c * 3 + 2];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-6) continue;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 > 0.02 && l2 > 0.02 && l3 > 0.02) return true;
      }
      return false;
    };
    // 中心と4つの角のうち、2つ以上がほかの道路の上にあれば重なっているとみなす
    const overlaps = (p: number[], owner: number) => {
      const mx = (p[0] + p[3] + p[6] + p[9]) / 4, mz = (p[2] + p[5] + p[8] + p[11]) / 4, my = (p[1] + p[4] + p[7] + p[10]) / 4;
      let k = onOtherRoad(mx, mz, owner, -1, my) ? 1 : 0;
      for (let c = 0; c < 4 && k < 2; c++) if (onOtherRoad(p[c * 3] * 0.8 + mx * 0.2, p[c * 3 + 2] * 0.8 + mz * 0.2, owner, -1, my)) k++;
      return k >= 2;
    };
    for (const q of walkQ) {
      const p = q.p;
      if (overlaps(p, -2)) continue;
      const cw = q.o !== undefined ? clipOf.get(q.o)?.walk : undefined;
      if (cw && cw.some((R) => inRegion(R, (p[0] + p[6]) / 2, (p[2] + p[8]) / 2) && inRegion(R, p[0], p[2]) && inRegion(R, p[3], p[5]) && inRegion(R, p[6], p[8]) && inRegion(R, p[9], p[11]))) continue;
      const w0 = O.I.length / 3;
      // タイルの模様の座標：縁石からの距離と、歩道に沿った位置（隣とつながるよう、向きをそろえる）
      let tx = p[9] - p[0], tz = p[11] - p[2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      if (tx < -1e-3 || (Math.abs(tx) <= 1e-3 && tz < 0)) { tx = -tx; tz = -tz; }
      const ids = [0, 1, 2, 3].map((k) => {
        const x = p[k * 3], z = p[k * 3 + 2];
        const ik = k === 1 ? 0 : k === 2 ? 3 : k; // 外側の点に対応する、縁石側の点
        O.aux = [Math.hypot(x - p[ik * 3], z - p[ik * 3 + 2]), x * tx + z * tz, 0, 0];
        return O.v(x, p[k * 3 + 1], z, COL.walk);
      });
      O.aux = AUX0;
      O.tri(ids[0], ids[1], ids[2]);
      O.tri(ids[0], ids[2], ids[3]);
      for (const w of q.w) O.wall(w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], COL.curb);
      if (cw) O.clipFrom(w0, cw);
    }
    // 分離帯の植え込み（ほかの道路の路面に重なるところは描かない）
    // 上を高架の道路・鉄道・モノレールが通るところには、木を植えない（高架につきぬけないように）
    const overhead = (x: number, z: number) => {
      const qx = Math.floor(x / CELL), qz = Math.floor(z / CELL);
      if (!g.inb(qx, qz)) return true;
      const j = qz * n + qx;
      return !!(g.up[j] || g.erail[j] || g.mono[j]);
    };
    for (const q of medQ) {
      if (overlaps(q.p, -2)) continue;
      const cm = q.o !== undefined ? clipOf.get(q.o)?.med : undefined;
      const m0 = O.I.length / 3;
      q.draw();
      if (cm) O.clipFrom(m0, cm);
      if (q.trees) for (const t of q.trees) if (!overhead(t.x, t.z) && !(cm && cm.some((R) => inRegion(R, t.x, t.z)))) trees.push(t);
    }
    // 横断歩道の範囲を、マスごとの入れ物に分けておく
    const zebraAt = new Map<number, typeof zebra>();
    for (const z of zebra) {
      const px = -z.uz, pz = z.ux;
      const xs: number[] = [], zz: number[] = [];
      for (const s0 of [z.s1, z.s2]) for (const o of [-z.hw, z.hw]) { xs.push(z.cx + z.ux * s0 + px * o); zz.push(z.cz + z.uz * s0 + pz * o); }
      for (let by = Math.floor(Math.min(...zz) / CELL); by <= Math.floor(Math.max(...zz) / CELL); by++)
        for (let bx = Math.floor(Math.min(...xs) / CELL); bx <= Math.floor(Math.max(...xs) / CELL); bx++) {
          const key = by * 4096 + bx;
          (zebraAt.get(key) ?? zebraAt.set(key, []).get(key)!).push(z);
        }
    }
    for (const q of lineQ) {
      const p = q.p;
      // 線は細いので、両端と中心のどれかがほかの道路の上なら消す
      const mx = (p[0] + p[3] + p[6] + p[9]) / 4, mz = (p[2] + p[5] + p[8] + p[11]) / 4;
      const ax = (p[0] + p[3]) / 2, az = (p[2] + p[5]) / 2, bx = (p[6] + p[9]) / 2, bz = (p[8] + p[11]) / 2, my = (p[1] + p[4] + p[7] + p[10]) / 4;
      if (!q.k && (onOtherRoad(mx, mz, q.o, q.o2, my) || onOtherRoad(ax * 0.9 + mx * 0.1, az * 0.9 + mz * 0.1, q.o, q.o2, my) || onOtherRoad(bx * 0.9 + mx * 0.1, bz * 0.9 + mz * 0.1, q.o, q.o2, my))) continue;
      const cl = clipOf.get(q.o)?.line;
      const l0 = M.I.length / 3;
      // 車線の線が横断歩道にかかるところは切り取る（線を 0..1 の区間に分けて残す）
      let keep: [number, number][] = [[0, 1]];
      // 両端のマスの入れ物を調べる（同じ範囲で2回切っても結果は同じ）
      const za = q.zb ? undefined : zebraAt.get(Math.floor(az / CELL) * 4096 + Math.floor(ax / CELL));
      const zb = q.zb ? undefined : zebraAt.get(Math.floor(bz / CELL) * 4096 + Math.floor(bx / CELL));
      for (const zl of za === zb ? [za] : [za, zb]) {
        if (!zl) continue;
        for (const z of zl) {
          const px = -z.uz, pz = z.ux;
          const sa = (ax - z.cx) * z.ux + (az - z.cz) * z.uz, sb = (bx - z.cx) * z.ux + (bz - z.cz) * z.uz;
          const la = (ax - z.cx) * px + (az - z.cz) * pz, lb = (bx - z.cx) * px + (bz - z.cz) * pz;
          if (Math.abs(la) > z.hw || Math.abs(lb) > z.hw || Math.abs(sb - sa) < 1e-4) continue;
          let t1 = (z.s1 - sa) / (sb - sa), t2 = (z.s2 - sa) / (sb - sa);
          if (t1 > t2) [t1, t2] = [t2, t1];
          const next: [number, number][] = [];
          for (const [u0, u1] of keep) {
            if (t2 <= u0 || t1 >= u1) { next.push([u0, u1]); continue; }
            if (t1 > u0) next.push([u0, t1]);
            if (t2 < u1) next.push([t2, u1]);
          }
          keep = next;
        }
      }
      for (const [u0, u1] of keep) {
        if (u1 - u0 < 0.02) continue;
        const at = (c0: number, c1: number, u: number) => [0, 1, 2].map((k) => p[c0 * 3 + k] + (p[c1 * 3 + k] - p[c0 * 3 + k]) * u);
        const corners = [at(0, 3, u0), at(1, 2, u0), at(1, 2, u1), at(0, 3, u1)];
        const ids = corners.map((v) => M.v(v[0], v[1], v[2], q.c));
        M.tri(ids[0], ids[1], ids[2]);
        M.tri(ids[0], ids[2], ids[3]);
      }
      if (cl) M.clipFrom(l0, cl);
    }
    // 橋の構造物は BridgeLayer（PBR のマテリアル）で描く
    for (const [mesh, buf] of [[this.surface, S], [this.marks, M], [this.solid, O]] as const) {
      mesh.geometry.dispose();
      mesh.geometry = buf.geometry();
    }
    this.medianTrees = trees;
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
