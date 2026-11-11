// 岸壁（埋め立て地の水ぎわ）：水に面したマスの辺に、海底から地面までの垂直な壁を立てる。
// 1 = コンクリートの岸壁（笠石と黄色の線、防舷材、係船柱、はしご、エプロンの舗装）
// 2 = 親水護岸・遊歩道（石の壁、手すり、石とウッドデッキの遊歩道、ベンチ、街灯、並木、水に下りる階段）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, QUAY_BED } from '../sim/constants';
import { CIVIC, type CivicId } from '../sim/defs';
import type { Building } from '../sim/world';
import { hash2 } from '../sim/rng';
import { MeshBuilder, PAT } from './builder';
import { MAT } from './textures';
import { createBuildingMaterial } from './materials';
import { PondBuilder, createGlowMaterial } from './parkPond';
import type { TreeSpot } from './buildingGen';

const CHUNK = 16;
const C = (hex: number) => new THREE.Color(hex);
const COL = {
  concrete: C(0xa8a49b), // 岸壁の壁（コンクリート）
  wet: C(0x4a4d45), // 水につかるところ（ぬれて暗い、藻）
  cope: C(0xbdb9b0), // 笠石（コンクリート）
  yellow: C(0xe0b326), // 安全の黄色の線
  apron: C(0xb1ada4), // エプロンの舗装
  fender: C(0x1d1e20), // 防舷材（黒いゴム）
  bollard: C(0x34373b), // 係船柱（黒く塗った鉄）
  ladder: C(0x9aa0a5), // はしご（ステンレス）
  stone: C(0xbfb6a6), // 親水護岸の石の壁
  stoneCap: C(0xd6cfc2), // 御影石の笠石
  granite: C(0xc9c3b8), // 石の舗装
  wood: C(0x7b6655), // ウッドデッキ
  rail: C(0xc9ced3), // ステンレスの手すり
  benchBase: C(0xb4aea4),
  pole: C(0x5d6267), // 街灯の柱（濃い灰色）
  lamp: C(0xfff0cf),
  step: C(0xcbc4b6), // 階段の石
};

// 4方向（東・南・西・北）：外向き n、辺に沿う向き t（どちらもマスの単位）、辺の始まりの頂点、回転
const DIRS = [
  { nx: 1, ny: 0, tx: 0, ty: -1, sx: 1, sy: 1, ang: -Math.PI / 2, primary: true },
  { nx: 0, ny: 1, tx: 1, ty: 0, sx: 0, sy: 1, ang: 0, primary: false },
  { nx: -1, ny: 0, tx: 0, ty: 1, sx: 0, sy: 0, ang: Math.PI / 2, primary: true },
  { nx: 0, ny: -1, tx: -1, ty: 0, sx: 1, sy: 0, ang: Math.PI, primary: false },
];

// 辺の端の形：0 = 途切れる、1 = まっすぐ続く、2 = 出隅（同じマスの隣の辺も水）、3 = 入隅（水が入りこむ角）
const FREE = 0, STRAIGHT = 1, OUTER = 2, INNER = 3;

// 辺に沿う帯（外向きの位置 zi..zo）の端を、角でどれだけのばす（ちぢめる）か。
// 出隅・入隅で、東西の辺（primary）と南北の辺が重ならず、すき間もなくつながるように決める
function ext(type: number, primary: boolean, zi: number, zo: number) {
  if (type === OUTER) return primary ? zo : zi;
  if (type === INNER) return primary ? -zi : -zo;
  return 0;
}

interface Chunk {
  sig: number;
  mesh: THREE.Mesh | null;
  glow: THREE.Mesh | null;
  trees: TreeSpot[];
}

// 自分で岸壁を描く水辺の施設（港・フェリー乗り場など）のマス
export function waterfrontMask(g: Grid, list: Building[]): Uint8Array {
  const n = g.n, out = new Uint8Array(n * n);
  for (const b of list) {
    if (!b.civic || !CIVIC[b.type as CivicId]?.waterfront) continue;
    // 岸壁の上に建てたときは、岸壁（壁・深い水・舗装の色）をそのまま残す
    let onQuay = false;
    for (let y = b.y; y < b.y + b.h && !onQuay; y++) for (let x = b.x; x < b.x + b.w; x++) if (g.inb(x, y) && g.quay[y * n + x]) { onQuay = true; break; }
    if (onQuay) continue;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (g.inb(x, y)) out[y * n + x] = 1;
  }
  return out;
}

export class QuayLayer {
  group = new THREE.Group();
  material = createBuildingMaterial();
  glowMaterial = createGlowMaterial();
  private chunks = new Map<number, Chunk>();
  private sigN = 0;

  setNight(v: number) {
    this.glowMaterial.opacity = v;
    this.glowMaterial.visible = v > 0.02;
  }

  allTrees(): TreeSpot[] {
    const out: TreeSpot[] = [];
    for (const c of this.chunks.values()) out.push(...c.trees);
    return out;
  }

  // 変わった区画だけ作り直す。木の位置が変わったら true
  rebuild(g: Grid, skip: Uint8Array): boolean {
    const n = g.n, V = n + 1, cn = Math.ceil(n / CHUNK);
    if (this.sigN !== n) { this.clear(); this.sigN = n; }
    const water = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) water[y * n + x] = g.isWater(x, y) ? 1 : 0;
    const quayAt = (x: number, y: number) => (g.inb(x, y) && !water[y * n + x] && !skip[y * n + x] ? g.quay[y * n + x] : 0);
    let treesChanged = false;
    for (let cz = 0; cz < cn; cz++)
      for (let cx = 0; cx < cn; cx++) {
        const ci = cz * cn + cx;
        const x0 = cx * CHUNK, y0 = cz * CHUNK, x1 = Math.min(n, x0 + CHUNK), y1 = Math.min(n, y0 + CHUNK);
        // 区画の中身の印（まわり 1 マスも含める）
        let h = 0x811c9dc5 | 0, any = false;
        const mix = (v: number) => { h = Math.imul(h ^ v, 16777619); };
        for (let y = Math.max(0, y0 - 1); y < Math.min(n, y1 + 1); y++)
          for (let x = Math.max(0, x0 - 1); x < Math.min(n, x1 + 1); x++) {
            const i = y * n + x;
            if (g.quay[i] && x >= x0 && x < x1 && y >= y0 && y < y1) any = true;
            mix(i); mix(g.quay[i] | (water[i] << 3) | (skip[i] << 4) | ((g.road[i] ? 1 : 0) << 5) | ((g.bldg[i] ? 1 : 0) << 6));
            if (g.quay[i]) for (const v of [y * V + x, y * V + x + 1, (y + 1) * V + x, (y + 1) * V + x + 1]) mix(Math.round(g.heights[v] * 32));
          }
        const sig = any ? h : 0;
        const old = this.chunks.get(ci);
        if (old && old.sig === sig) continue;
        if (!old && !any) continue;
        if (old) this.drop(old);
        this.chunks.delete(ci);
        if (old?.trees.length) treesChanged = true;
        if (!any) continue;
        const ch = this.build(g, x0, y0, x1, y1, water, quayAt);
        ch.sig = sig;
        if (ch.trees.length) treesChanged = true;
        this.chunks.set(ci, ch);
      }
    return treesChanged;
  }

  private drop(c: Chunk) {
    for (const m of [c.mesh, c.glow]) if (m) { this.group.remove(m); m.geometry.dispose(); }
  }
  private clear() {
    for (const c of this.chunks.values()) this.drop(c);
    this.chunks.clear();
  }

  private build(g: Grid, X0: number, Y0: number, X1: number, Y1: number, water: Uint8Array, quayAt: (x: number, y: number) => number): Chunk {
    const n = g.n;
    const mb = new MeshBuilder();
    const pond = new PondBuilder();
    const trees: TreeSpot[] = [];
    const isW = (x: number, y: number) => g.inb(x, y) && water[y * n + x] === 1;
    // 飾り（舗装・ベンチなど）を置けるマス：道路も建物もない
    const free = (x: number, y: number) => g.inb(x, y) && !water[y * n + x] && !g.road[y * n + x] && !g.bldg[y * n + x];
    const L = CELL;
    for (let y = Y0; y < Y1; y++)
      for (let x = X0; x < X1; x++) {
        const style = quayAt(x, y);
        if (!style) continue;
        const deco = free(x, y);
        for (let k = 0; k < 4; k++) {
          const D = DIRS[k];
          if (!isW(x + D.nx, y + D.ny)) continue;
          // 端の形（壁の形と、同じ種類の岸壁どうしの飾りの形）
          const endType = (sg: number): [number, number] => {
            const tx = x + D.tx * sg, ty = y + D.ty * sg;
            if (!g.inb(tx, ty)) return [FREE, FREE];
            if (isW(tx, ty)) return [OUTER, OUTER];
            const ts = quayAt(tx, ty);
            if (ts && isW(tx + D.nx, ty + D.ny)) return [STRAIGHT, ts === style ? STRAIGHT : FREE];
            const ds = quayAt(tx + D.nx, ty + D.ny);
            if (ds) return [INNER, ds === style ? INNER : FREE];
            return [FREE, FREE];
          };
          const [wS, dS] = endType(-1), [wE, dE] = endType(1);
          // 入隅で隣のマス（辺の先の陸）に舗装をのばしてよいか
          const tFree = (sg: number) => free(x + D.tx * sg, y + D.ty * sg);
          const vx0 = x + D.sx, vy0 = y + D.sy, vx1 = vx0 + D.tx, vy1 = vy0 + D.ty;
          const h0 = g.vh(vx0, vy0), h1 = g.vh(vx1, vy1), top = Math.max(h0, h1);
          mb.setTransform(D.ang, vx0 * CELL, 0, vy0 * CELL);
          const P = D.primary;
          // 帯（外向きの位置 zi..zo、高さ yb..yt）。角の形に合わせて両端をのばす。wide = 入隅で隣の陸にのばす幅の大きい帯
          const band = (zi: number, zo: number, yb: number, yt: number, col: THREE.Color, mat: number, decoEnds = true, wide = false) => {
            const sT = decoEnds ? dS : wS, eT = decoEnds ? dE : wE;
            const es = sT === INNER && P && wide && !tFree(-1) ? 0 : ext(sT, P, zi, zo);
            const ee = eT === INNER && P && wide && !tFree(1) ? 0 : ext(eT, P, zi, zo);
            const a0 = -es, a1 = L + ee;
            if (a1 - a0 < 0.05) return;
            mb.matOverride = mat;
            mb.box(a0, yb, zi, a1, yt, zo, col, PAT.none, col);
          };
          // ---- 壁：海底から地面まで（水につかるところは暗く） ----
          mb.matOverride = MAT.concrete;
          const wallCol = style === 1 ? COL.concrete : COL.stone;
          const yb = QUAY_BED - 1.5, yw = 0.35;
          const u0 = (vx0 + vy0) * CELL;
          mb.quad([0, yb, 0], [L, yb, 0], [L, yw, 0], [0, yw, 0], COL.wet, PAT.none, L, yw - yb, u0, 0);
          mb.quad([0, yw, 0], [L, yw, 0], [L, h1, 0], [0, h0, 0], wallCol, PAT.none, L, top - yw, u0, yw - yb);
          // 斜めに見たとき壁の裏が抜けないよう、壁の端の小口（途切れるところ）をふさぐ
          if (wS === FREE) mb.quad([0, yb, -0.6], [0, yb, 0], [0, h0, 0], [0, h0, -0.6], wallCol);
          if (wE === FREE) mb.quad([L, yb, 0], [L, yb, -0.6], [L, h1, -0.6], [L, h1, 0], wallCol);
          const hs = hash2(x * 3 + k, y * 5, 31);
          if (style === 1) {
            // ---- コンクリートの岸壁 ----
            band(-0.6, 0.12, top - 0.35, top + 0.18, COL.cope, MAT.concrete, false);
            band(-0.24, 0.12, top + 0.18, top + 0.2, COL.yellow, MAT.none, false);
            if (deco) band(-5.5, -0.6, top - 0.3, top + 0.05, COL.apron, MAT.concrete, true, true);
            // 防舷材（8m ごと）
            mb.matOverride = MAT.none;
            for (const s of [4, 12]) mb.box(s - 0.45, -0.9, 0, s + 0.45, top - 0.4, 0.42, COL.fender, PAT.none, COL.fender);
            // 係船柱（辺の中ほど）
            mb.matOverride = MAT.metal;
            mb.cylinder(8, -0.3, top + 0.18, top + 0.62, 0.16, 10, COL.bollard, undefined, 0.14);
            mb.cylinder(8, -0.3, top + 0.62, top + 0.74, 0.25, 12, COL.bollard, COL.bollard);
            // はしご（ところどころ）
            if (hs < 0.34) {
              mb.matOverride = MAT.metal;
              for (const s of [9.75, 10.25]) mb.box(s - 0.03, -1.6, 0.06, s + 0.03, top + 0.18, 0.12, COL.ladder, PAT.none, COL.ladder);
              for (let ry = -1.4; ry < top; ry += 0.3) mb.box(9.75, ry, 0.07, 10.25, ry + 0.035, 0.11, COL.ladder, PAT.none, COL.ladder);
            }
          } else {
            // ---- 親水護岸・遊歩道 ----
            band(-0.45, 0.1, top - 0.3, top + 0.1, COL.stoneCap, MAT.concrete, false);
            // 親水階段（およそ 32m ごと、まっすぐな辺の中ほど）
            const steps = deco && wS === STRAIGHT && wE === STRAIGHT && (x + y) % 3 === 0;
            const S0 = 5, S1 = 11;
            if (steps) {
              mb.matOverride = MAT.concrete;
              let k2 = 0;
              for (let yt = top - 0.3; yt > -1.4; yt -= 0.38, k2++) mb.box(S0, QUAY_BED - 1, 0.1 + k2 * 0.72, S1, yt, 0.1 + (k2 + 1) * 0.72, COL.step, PAT.none, COL.step);
            }
            // 手すり（ステンレス：柱と3本の横棒）。階段のところはあける
            {
              const zr = -0.22;
              const r0 = -ext(dS, P, zr, zr), r1 = L + ext(dE, P, zr, zr);
              const segs: [number, number][] = steps ? [[r0, S0], [S1, r1]] : [[r0, r1]];
              mb.matOverride = MAT.metal;
              for (const [a, b] of segs) {
                if (b - a < 0.3) continue;
                mb.box(a, top + 1.08, zr - 0.035, b, top + 1.15, zr + 0.035, COL.rail, PAT.none, COL.rail);
                for (const ry of [0.42, 0.75]) mb.box(a, top + ry, zr - 0.012, b, top + ry + 0.025, zr + 0.012, COL.rail, PAT.none, COL.rail);
                const np = Math.max(1, Math.round((b - a) / 2));
                for (let q = 0; q <= np; q++) {
                  const s = a + ((b - a) * q) / np;
                  // 角の柱は primary の辺だけが立てる（2本重ならないように）。まっすぐ続く辺の始まりは、前の辺の終わりの柱を使う
                  const corner = (e: number) => e === OUTER || e === INNER;
                  if (q === 0 && a === r0 && (dS === STRAIGHT || (corner(dS) && !P))) continue;
                  if (q === np && b === r1 && corner(dE) && !P) continue;
                  mb.box(s - 0.035, top + 0.1, zr - 0.035, s + 0.035, top + 1.08, zr + 0.035, COL.rail, PAT.none, COL.rail);
                }
              }
            }
            if (deco) {
              // 遊歩道の舗装：水ぎわはウッドデッキ、内側は石
              band(-3.2, -0.45, top - 0.3, top + 0.1, COL.wood, MAT.siding, true, true);
              band(-6, -3.2, top - 0.3, top + 0.1, COL.granite, MAT.concrete, true, true);
              const yd = top + 0.1;
              // 角の近くは、となりの辺のものと重ならないようにあける
              const nearCorner = (s: number) => (s < 6.5 && (dS === OUTER || dS === INNER)) || (s > L - 6.5 && (dE === OUTER || dE === INNER));
              // ベンチ（水のほうを向く）
              for (const s of [3.5, 12.5]) {
                if (nearCorner(s)) continue;
                mb.matOverride = MAT.concrete;
                mb.box(s - 0.75, yd, -4.8, s + 0.75, yd + 0.38, -4.35, COL.benchBase, PAT.none, COL.benchBase);
                mb.matOverride = MAT.siding;
                mb.box(s - 0.95, yd + 0.38, -4.9, s + 0.95, yd + 0.46, -4.25, COL.wood, PAT.none, COL.wood);
                mb.box(s - 0.95, yd + 0.5, -4.98, s + 0.95, yd + 0.92, -4.9, COL.wood, PAT.none, COL.wood);
              }
              // 細い街灯（夜にともる）
              {
                const s = 8, z = -5.5;
                mb.matOverride = MAT.metal;
                mb.box(s - 0.06, yd, z - 0.06, s + 0.06, yd + 4.3, z + 0.06, COL.pole, PAT.none, COL.pole);
                mb.box(s - 0.13, yd + 4.3, z - 0.13, s + 0.13, yd + 4.4, z + 0.13, COL.pole, PAT.none, COL.pole);
                mb.matOverride = MAT.none;
                mb.box(s - 0.1, yd + 3.75, z - 0.1, s + 0.1, yd + 4.3, z + 0.1, COL.lamp, PAT.lit, COL.lamp);
                const [wx, , wz] = mb.world(s, 0, z + 1.2);
                pond.addGlow(wx, yd + 0.04, wz);
              }
              // 並木（遊歩道の内側）
              if (!(dS === OUTER || dS === INNER) && hs < 0.8) {
                const [wx, , wz] = mb.world(0.5, 0, -8.2);
                trees.push({ x: wx, y: top, z: wz, s: 0.6 + hs * 0.15, kind: 0 });
              }
            }
          }
          mb.matOverride = null;
        }
      }
    const ch: Chunk = { sig: 0, mesh: null, glow: null, trees };
    if (mb.vertexCount) {
      const m = new THREE.Mesh(mb.toGeometry(), this.material);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      ch.mesh = m;
    }
    const gg = pond.glowGeometry();
    if (gg) {
      const m = new THREE.Mesh(gg, this.glowMaterial);
      m.renderOrder = 3;
      this.group.add(m);
      ch.glow = m;
    }
    return ch;
  }
}
