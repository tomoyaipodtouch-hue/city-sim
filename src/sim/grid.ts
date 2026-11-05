// マス目のデータ。シミュレーション（Worker）と画面側の両方で使う。
//
// 道路は2つの階層を持つ。
//   地上（level 0）: road / conn / flow / deck
//   上空（level 1）: up / conn1 / flow1 / upH（高架の高速道路、立体交差の道路、高架のランプ）
// 経路探索のノード番号は「level * n * n + マス番号」。
// あるマスから方向 d の隣のマスへ進むとき、隣のマスの上空に d の反対向きの接続があり、
// 地上にはない場合は上空へ、それ以外は地上へ進む（坂道でつながる）。
import { CELL, DX, DY, WATER_LEVEL, opp } from './constants';

// 同期・保存の対象になる配列の名前
export const GRID_U8 = ['road', 'conn', 'flow', 'pline', 'zone', 'zden', 'tree', 'up', 'conn1', 'flow1', 'ictl', 'isplit', 'iflags', 'rail', 'erail', 'mono', 'sub', 'bstop', 'bstyle'] as const;
export const GRID_F32 = ['deck', 'upH', 'lift'] as const;
export const GRID_I32 = ['bldg'] as const;
export type GridU8Key = (typeof GRID_U8)[number];
export type GridF32Key = (typeof GRID_F32)[number];

// 交差点の制御方式
export enum Ctl {
  Auto = 0,
  None = 1,
  Stop = 2,
  Signal = 3,
  Roundabout = 4,
}
// 交差点のフラグ
export const JF = {
  leftLane: 1, // 左折レーン
  rightLane: 2, // 右折レーン
  noLeft: 4, // 左折禁止
  noRight: 8, // 右折禁止
  straightOnly: 16, // 直進のみ
} as const;

export class Grid {
  readonly n: number;
  heights: Float32Array; // 頂点の高さ（(n+1)^2）
  road: Uint8Array; // 地上の道路の種類
  conn: Uint8Array; // 地上の道路の接続（8方向のビット）
  flow: Uint8Array; // 地上で通行できる向き（このマスから出ていける方向。一方通行は片方だけ）
  deck: Float32Array; // 橋の路面の高さ（0 = 橋ではない）
  up: Uint8Array; // 上空の道路の種類
  conn1: Uint8Array; // 上空の接続
  flow1: Uint8Array; // 上空で通行できる向き
  upH: Float32Array; // 上空の路面の高さ
  lift: Float32Array; // 立体交差の取り付け部分で、地上の道路を持ち上げる高さ
  ictl: Uint8Array; // 交差点の制御方式（Ctl）
  isplit: Uint8Array; // 信号の時間配分（東西方向の青の割合、0..100。50 = 半々）
  iflags: Uint8Array; // 交差点のフラグ（JF）
  pline: Uint8Array; // 送電線
  // 公共交通の線路（8方向の接続ビット。両方向に通れる）
  rail: Uint8Array; // 地上の鉄道
  erail: Uint8Array; // 高架鉄道
  mono: Uint8Array; // モノレール
  sub: Uint8Array; // 地下鉄
  bstop: Uint8Array; // 道路に重ねて置いたバス停（1 = あり）
  bstyle: Uint8Array; // 橋の形（0 = 桁橋、1 = 吊り橋、2 = 斜張橋、3 = トラス橋、4 = アーチ橋、5 = ラーメン橋）
  zone: Uint8Array; // ゾーンの種類
  zden: Uint8Array; // ゾーンの密度
  bldg: Int32Array; // 建物ID（0 = なし）
  tree: Uint8Array; // 木の量（0..3）

  constructor(n: number) {
    this.n = n;
    const c = n * n;
    this.heights = new Float32Array((n + 1) * (n + 1));
    this.road = new Uint8Array(c);
    this.conn = new Uint8Array(c);
    this.flow = new Uint8Array(c);
    this.deck = new Float32Array(c);
    this.up = new Uint8Array(c);
    this.conn1 = new Uint8Array(c);
    this.flow1 = new Uint8Array(c);
    this.upH = new Float32Array(c);
    this.lift = new Float32Array(c);
    this.ictl = new Uint8Array(c);
    this.bstyle = new Uint8Array(c);
    this.isplit = new Uint8Array(c).fill(50);
    this.iflags = new Uint8Array(c);
    this.pline = new Uint8Array(c);
    this.rail = new Uint8Array(c);
    this.erail = new Uint8Array(c);
    this.mono = new Uint8Array(c);
    this.sub = new Uint8Array(c);
    this.bstop = new Uint8Array(c);
    this.zone = new Uint8Array(c);
    this.zden = new Uint8Array(c);
    this.bldg = new Int32Array(c);
    this.tree = new Uint8Array(c);
  }

  idx(x: number, y: number) {
    return y * this.n + x;
  }
  inb(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.n && y < this.n;
  }
  vh(vx: number, vy: number) {
    return this.heights[vy * (this.n + 1) + vx];
  }
  setVh(vx: number, vy: number, h: number) {
    this.heights[vy * (this.n + 1) + vx] = h;
  }
  // マスの中心の高さ（4隅の平均）
  cellH(x: number, y: number) {
    return (this.vh(x, y) + this.vh(x + 1, y) + this.vh(x, y + 1) + this.vh(x + 1, y + 1)) * 0.25;
  }
  // 地上の道路の路面の高さ（橋なら橋の高さ）
  roadH(i: number) {
    const d = this.deck[i];
    return d > 0 ? d : this.cellH(i % this.n, (i / this.n) | 0) + this.lift[i];
  }
  // ノード（階層つき）の路面の高さ
  nodeH(node: number) {
    const N = this.n * this.n;
    return node >= N ? this.upH[node - N] : this.roadH(node);
  }
  nodeType(node: number) {
    const N = this.n * this.n;
    return node >= N ? this.up[node - N] : this.road[node];
  }
  cellMinH(x: number, y: number) {
    return Math.min(this.vh(x, y), this.vh(x + 1, y), this.vh(x, y + 1), this.vh(x + 1, y + 1));
  }
  cellMaxH(x: number, y: number) {
    return Math.max(this.vh(x, y), this.vh(x + 1, y), this.vh(x, y + 1), this.vh(x + 1, y + 1));
  }
  isWater(x: number, y: number) {
    return this.cellMinH(x, y) < WATER_LEVEL + 0.3;
  }
  // 世界座標（m）での地面の高さ
  groundAt(wx: number, wz: number) {
    const n = this.n;
    const fx = Math.max(0, Math.min(n - 1e-4, wx / CELL));
    const fy = Math.max(0, Math.min(n - 1e-4, wz / CELL));
    const x = Math.floor(fx), y = Math.floor(fy);
    const tx = fx - x, ty = fy - y;
    const a = this.vh(x, y), b = this.vh(x + 1, y), c = this.vh(x, y + 1), d = this.vh(x + 1, y + 1);
    // 三角形分割（左上-右下の対角）に合わせる
    if (tx + ty <= 1) return a + (b - a) * tx + (c - a) * ty;
    return d + (c - d) * (1 - tx) + (b - d) * (1 - ty);
  }

  // マス j に方向 d から入るとき、どちらの階層に着くか
  arriveLevel(fromLevel: number, j: number, d: number) {
    const b = 1 << opp(d);
    if (this.conn1[j] & b) {
      if (fromLevel === 1 || !(this.conn[j] & b)) return 1;
    }
    return 0;
  }

  // ノードから進める隣のノード（通行できる向きだけ）
  forEachOut(node: number, cb: (next: number, d: number) => void) {
    const n = this.n, N = n * n;
    const level = node >= N ? 1 : 0;
    const c = node - level * N;
    const m = level ? this.flow1[c] : this.flow[c];
    if (!m) return;
    const x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      const lv = this.arriveLevel(level, j, d);
      if (lv === 0 && !this.road[j]) continue;
      if (lv === 1 && !this.up[j]) continue;
      cb(lv * N + j, d);
    }
  }

  // 地上か上空に何かの道路があるか
  anyRoad(i: number) {
    return this.road[i] !== 0 || this.up[i] !== 0;
  }

  clone(): Grid {
    const g = new Grid(this.n);
    g.heights.set(this.heights);
    for (const k of GRID_U8) g[k].set(this[k]);
    for (const k of GRID_F32) g[k].set(this[k]);
    g.bldg.set(this.bldg);
    return g;
  }
}
