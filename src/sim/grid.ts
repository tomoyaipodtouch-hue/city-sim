// マス目のデータ。シミュレーション（Worker）と画面側の両方で使う。
import { CELL, DX, DY, WATER_LEVEL } from './constants';

export class Grid {
  readonly n: number;
  heights: Float32Array; // 頂点の高さ（(n+1)^2）
  road: Uint8Array; // 道路の種類
  conn: Uint8Array; // 道路の接続（8方向のビット）
  pline: Uint8Array; // 送電線
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
    this.pline = new Uint8Array(c);
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

  // 道路マスの隣接（接続されている方向）
  *roadNeighbors(i: number): Generator<[number, number]> {
    const n = this.n;
    const x = i % n, y = (i / n) | 0;
    const m = this.conn[i];
    for (let d = 0; d < 8; d++) {
      if (m & (1 << d)) {
        const nx = x + DX[d], ny = y + DY[d];
        if (this.inb(nx, ny)) yield [ny * n + nx, d];
      }
    }
  }

  clone(): Grid {
    const g = new Grid(this.n);
    g.heights.set(this.heights);
    g.road.set(this.road);
    g.conn.set(this.conn);
    g.pline.set(this.pline);
    g.zone.set(this.zone);
    g.zden.set(this.zden);
    g.bldg.set(this.bldg);
    g.tree.set(this.tree);
    return g;
  }
}
