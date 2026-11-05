// 橋の形（情報モードで橋をタップして選ぶ）。橋の路面の下や上に、形ごとの構造物を作る。
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, WATER_LEVEL } from '../sim/constants';
import type { Buf } from './roadLayer';

export const BRIDGE_STYLES = ['桁橋', '吊り橋', '斜張橋', 'トラス橋', 'アーチ橋', 'ラーメン橋'] as const;

const STEEL = new THREE.Color(0xc8473c); // 赤いトラス・アーチ
const WHITE = new THREE.Color(0xe8e6df);
const CABLE = new THREE.Color(0xd9d6cc);
const CONC = new THREE.Color(0xb3afa6);
const TOWER = new THREE.Color(0xd4d0c6);

// 橋の路面のマス（地上の道路で deck > 0）を、隣り合うものどうしでまとめる
export function bridgeGroups(g: Grid): number[][] {
  const n = g.n, N = n * n;
  const seen = new Uint8Array(N);
  const out: number[][] = [];
  for (let i = 0; i < N; i++) {
    if (seen[i] || !g.road[i] || !(g.deck[i] > 0)) continue;
    const comp: number[] = [];
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const c = st.pop()!;
      comp.push(c);
      const x = c % n, y = (c / n) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (!g.inb(xx, yy)) continue;
          const j = yy * n + xx;
          if (seen[j] || !g.road[j] || !(g.deck[j] > 0)) continue;
          seen[j] = 1;
          st.push(j);
        }
    }
    out.push(comp);
  }
  return out;
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

// rail を渡すと、高架鉄道の橋（水の上の区間）に構造物を付ける。height = 線路の高さ
export function addBridgeStructures(g: Grid, O: Buf, lift: number, rail?: { height: (c: number) => number }) {
  const n = g.n;
  // 細い部材（両面の角柱）
  const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, c: THREE.Color) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const l = Math.hypot(ux, uy, uz) || 1;
    // 部材に直交する2つの向き
    let p1x = -uz, p1y = 0, p1z = ux;
    let pl = Math.hypot(p1x, p1z);
    if (pl < 1e-3) { p1x = 1; p1z = 0; pl = 1; }
    p1x /= pl; p1z /= pl;
    const p2x = (uy * p1z - uz * p1y) / l, p2y = (uz * p1x - ux * p1z) / l, p2z = (ux * p1y - uy * p1x) / l;
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    const ia: number[] = [], ib: number[] = [];
    for (const [s1, s2] of corners) {
      const ox = (p1x * s1 + p2x * s2) * r, oy = (p1y * s1 + p2y * s2) * r, oz = (p1z * s1 + p2z * s2) * r;
      const nx = ox / r, ny = oy / r, nz = oz / r;
      ia.push(O.v(ax + ox, ay + oy, az + oz, c, nx, ny, nz));
      ib.push(O.v(bx + ox, by + oy, bz + oz, c, nx, ny, nz));
    }
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) & 3;
      O.I.push(ia[k], ib[k], ib[k2], ia[k], ib[k2], ia[k2], ia[k], ib[k2], ib[k], ia[k], ia[k2], ib[k2]);
    }
  };

  for (const comp of rail ? railBridgeGroups(g) : bridgeGroups(g)) {
    const style = g.bstyle[comp[0]];
    // 高架鉄道の桁橋は、ふつうの高架の柱（ラーメン高架橋）のままにする
    if (rail && style === 0) continue;
    // 橋の向き：いちばん離れた2マス
    let A = comp[0], B = comp[0], best = -1;
    if (comp.length > 1) {
      const far = (s: number) => {
        let m = s, md = -1;
        for (const c of comp) {
          const d = (c % n - s % n) ** 2 + (((c / n) | 0) - ((s / n) | 0)) ** 2;
          if (d > md) { md = d; m = c; }
        }
        return [m, md] as const;
      };
      [A] = far(comp[0]);
      [B, best] = far(A);
    }
    const ax = (A % n + 0.5) * CELL, az = (((A / n) | 0) + 0.5) * CELL;
    const bx = (B % n + 0.5) * CELL, bz = (((B / n) | 0) + 0.5) * CELL;
    let L = Math.hypot(bx - ax, bz - az);
    const ux = L > 0 ? (bx - ax) / L : 1, uz = L > 0 ? (bz - az) / L : 0;
    const px = -uz, pz = ux;
    // 両端を半マス延ばす（路面の端まで）
    const sx = ax - ux * CELL * 0.5, sz = az - uz * CELL * 0.5;
    L += CELL;
    void best;
    // 幅：橋の中心線からいちばん遠いマス
    let half = 0;
    for (const c of comp) {
      const cx = (c % n + 0.5) * CELL - sx, cz = (((c / n) | 0) + 0.5) * CELL - sz;
      half = Math.max(half, Math.abs(cx * px + cz * pz));
    }
    const mx = (ax + bx) / 2 + px * 0, mz = (az + bz) / 2;
    // 平行な2車線（大通りなど）は、真ん中を中心にする
    let off = 0;
    {
      let s = 0;
      for (const c of comp) s += ((c % n + 0.5) * CELL - mx) * px + ((((c / n) | 0) + 0.5) * CELL - mz) * pz;
      off = s / comp.length;
    }
    const W = rail ? 6.2 : Math.max(half - Math.abs(off), 0) + 6.5; // 中心から構造物までの距離
    let hs = 0;
    for (const c of comp) hs += rail ? rail.height(c) : g.deck[c];
    const H = hs / comp.length + (rail ? 0 : lift); // 路面の高さ
    const base = WATER_LEVEL - 2;
    const P = (s: number, side: number, y: number): [number, number, number] => [sx + ux * s + px * (off + side * W), y, sz + uz * s + pz * (off + side * W)];
    const seg = (s0: number, side0: number, y0: number, s1: number, side1: number, y1: number, r: number, c: THREE.Color) => {
      const a = P(s0, side0, y0), b = P(s1, side1, y1);
      beam(a[0], a[1], a[2], b[0], b[1], b[2], r, c);
    };
    const pier = (s: number, w: number) => {
      // 路面の下の橋脚（横に長い壁柱）
      const c = P(s, 0, 0);
      const ex = px * w, ez = pz * w;
      beam(c[0] - ex, H - 1.2, c[2] - ez, c[0] + ex, H - 1.2, c[2] + ez, 0.8, CONC);
      for (const sd of [-1, 1]) beam(c[0] + ex * sd * 0.6, base, c[2] + ez * sd * 0.6, c[0] + ex * sd * 0.6, H - 1.2, c[2] + ez * sd * 0.6, 1.1, CONC);
    };

    switch (style) {
      case 0: {
        // 桁橋：等間隔の橋脚
        const k = Math.max(1, Math.round(L / 40));
        for (let j = 1; j < k; j++) pier((L * j) / k, W - 2);
        break;
      }
      case 1: {
        // 吊り橋：2本の主塔と、たるんだ主ケーブル、縦のハンガー
        const t0 = L * (L < 60 ? 0.25 : 0.2), t1 = L - t0;
        const Ht = Math.max(18, L * 0.16);
        for (const t of [t0, t1]) {
          for (const sd of [-1, 1]) seg(t, sd, base, t, sd, H + Ht, 1.1, TOWER);
          seg(t, -1, H + Ht - 1, t, 1, H + Ht - 1, 0.9, TOWER);
          seg(t, -1, H + Ht * 0.55, t, 1, H + Ht * 0.55, 0.7, TOWER);
          seg(t, -1, H - 1.4, t, 1, H - 1.4, 0.9, TOWER);
        }
        const cy = (s: number) => {
          if (s <= t0) return H + 1 + (Ht - 1) * (s / t0);
          if (s >= t1) return H + 1 + (Ht - 1) * ((L - s) / t0);
          const u = (s - t0) / (t1 - t0);
          return H + 2 + (Ht - 2) * (2 * u - 1) ** 2;
        };
        const steps = 40;
        for (const sd of [-1, 1]) {
          for (let j = 0; j < steps; j++) {
            const s0 = (L * j) / steps, s1 = (L * (j + 1)) / steps;
            seg(s0, sd, cy(s0), s1, sd, cy(s1), 0.35, CABLE);
          }
          for (let s = 4; s < L - 2; s += 5) if (Math.abs(s - t0) > 1.5 && Math.abs(s - t1) > 1.5 && cy(s) - H > 1.2) seg(s, sd, H + 0.3, s, sd, cy(s), 0.08, CABLE);
        }
        break;
      }
      case 2: {
        // 斜張橋：主塔から扇形に張ったケーブル
        const two = L > 170;
        const towers = two ? [L * 0.28, L * 0.72] : [L * 0.5];
        const Ht = Math.max(20, two ? L * 0.15 : L * 0.24);
        const reach = two ? L * 0.26 : L * 0.46;
        for (const t of towers) {
          // A字の主塔
          for (const sd of [-1, 1]) {
            const b0 = P(t, sd * 1.15, base), top = P(t, sd * 0.12, H + Ht);
            beam(b0[0], b0[1], b0[2], top[0], top[1], top[2], 1.2, WHITE);
          }
          seg(t, -1.05, H - 1.4, t, 1.05, H - 1.4, 1.0, WHITE);
          const nC = 9;
          for (const sd of [-1, 1])
            for (const dir of [-1, 1])
              for (let j = 1; j <= nC; j++) {
                const s = t + dir * (reach * j) / nC;
                if (s < 1 || s > L - 1) continue;
                const top = P(t, sd * 0.12, H + Ht * (0.62 + (0.36 * j) / nC));
                const bot = P(s, sd, H + 0.3);
                beam(top[0], top[1], top[2], bot[0], bot[1], bot[2], 0.1, CABLE);
              }
        }
        if (!two) for (const s of [L * 0.04, L * 0.96]) pier(s, W - 2);
        break;
      }
      case 3: {
        // トラス橋（ワーレントラス）：両側の上弦材・下弦材と斜材、上の横つなぎ
        const Ht = 8;
        const panels = Math.max(2, Math.round(L / 9));
        const pl = L / panels;
        for (const sd of [-1, 1]) {
          seg(0, sd, H, L, sd, H, 0.35, STEEL);
          seg(pl, sd, H + Ht, L - pl, sd, H + Ht, 0.4, STEEL);
          for (let j = 0; j < panels; j++) {
            const s0 = j * pl, s1 = (j + 1) * pl;
            if (j === 0) seg(s0, sd, H, s1, sd, H + Ht, 0.35, STEEL);
            else if (j === panels - 1) seg(s0, sd, H + Ht, s1, sd, H, 0.35, STEEL);
            else if (j % 2) seg(s0, sd, H + Ht, s1, sd, H, 0.25, STEEL);
            else seg(s0, sd, H, s1, sd, H + Ht, 0.25, STEEL);
            if (j > 0) seg(s0, sd, H, s0, sd, H + Ht, 0.22, STEEL);
          }
        }
        for (let j = 1; j < panels; j++) seg(j * pl, -1, H + Ht, j * pl, 1, H + Ht, 0.22, STEEL);
        for (let j = 1; j < panels - 1; j += 2) {
          seg(j * pl, -1, H + Ht, (j + 1) * pl, 1, H + Ht, 0.12, STEEL);
          seg(j * pl, 1, H + Ht, (j + 1) * pl, -1, H + Ht, 0.12, STEEL);
        }
        if (L > 120) { const k = Math.round(L / 60); for (let j = 1; j < k; j++) pier((L * j) / k, W - 2); }
        break;
      }
      case 4: {
        // アーチ橋（タイドアーチ）：路面の上に弧を描くアーチと、縦の吊り材
        const R = Math.min(L * 0.2, 45) + 4;
        const ay = (s: number) => H + R * 4 * (s / L) * (1 - s / L);
        const steps = 32;
        for (const sd of [-1, 1]) {
          for (let j = 0; j < steps; j++) {
            const s0 = (L * j) / steps, s1 = (L * (j + 1)) / steps;
            seg(s0, sd * 0.95, ay(s0), s1, sd * 0.95, ay(s1), 0.7, WHITE);
          }
          for (let s = 6; s < L - 4; s += 6) if (ay(s) - H > 2) seg(s, sd * 0.95, H + 0.3, s, sd * 0.95, ay(s), 0.1, CABLE);
        }
        for (let s = L * 0.22; s < L * 0.79; s += Math.max(8, L * 0.09)) if (ay(s) - H > 7) seg(s, -0.95, ay(s), s, 0.95, ay(s), 0.35, WHITE);
        break;
      }
      case 5: {
        // ラーメン橋：橋脚と桁が一体。橋脚の上で桁が深くなる（ハンチ）
        const k = Math.max(2, Math.round(L / 45));
        const sp = L / k;
        // 水面に近い橋でも見えるように、桁の深さは水面までに収める
        const deep = Math.max(0.6, Math.min(4.5, H - WATER_LEVEL - 2.2));
        const depth = (s: number) => {
          const u = (s % sp) / sp; // 0..1（橋脚から橋脚）
          const d = Math.min(u, 1 - u) * 2; // 橋脚で 0、真ん中で 1
          return 1.3 + deep * (1 - d) ** 2;
        };
        const steps = Math.max(12, k * 10);
        for (let j = 0; j < steps; j++) {
          const s0 = (L * j) / steps, s1 = (L * (j + 1)) / steps;
          for (const sd of [-1, 1]) {
            const a = P(s0, sd * 0.78, 0), b = P(s1, sd * 0.78, 0);
            O.wall(a[0], a[2], H - depth(s0), H - 1.0, b[0], b[2], H - depth(s1), H - 1.0, CONC);
          }
          const a0 = P(s0, -0.78, 0), a1 = P(s0, 0.78, 0), b0 = P(s1, -0.78, 0), b1 = P(s1, 0.78, 0);
          const i0 = O.v(a0[0], H - depth(s0), a0[2], CONC, 0, -1, 0), i1 = O.v(a1[0], H - depth(s0), a1[2], CONC, 0, -1, 0);
          const i2 = O.v(b1[0], H - depth(s1), b1[2], CONC, 0, -1, 0), i3 = O.v(b0[0], H - depth(s1), b0[2], CONC, 0, -1, 0);
          O.I.push(i0, i1, i2, i0, i2, i3, i0, i2, i1, i0, i3, i2);
        }
        for (let j = 1; j < k; j++) {
          const s = j * sp;
          // 下に広がる V 字の脚
          for (const dir of [-1, 1]) for (const sd of [-0.5, 0.5]) seg(s, sd, base, s + dir * 7, sd, H - depth(s + dir * 7) + 0.3, 1.0, CONC);
          // 橋脚の上は、桁を厚くして一体に見せる
          for (const sd of [-0.78, 0.78]) seg(s - 6, sd, H - 1.3 - deep, s + 6, sd, H - 1.3 - deep, 0.6, CONC);
        }
        break;
      }
    }
  }
}
