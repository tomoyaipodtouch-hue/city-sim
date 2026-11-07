// 建物の描画（16×16マスごとにまとめて1つのメッシュにする）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import type { Building } from '../sim/world';
import { MeshBuilder } from './builder';
import { generateBuilding, setupLot, TreeSpot, farmFields } from './buildingGen';
import { createBuildingMaterial } from './materials';
import { PondBuilder, createPondMaterial, createGlowMaterial } from './parkPond';
import { CIVIC, CivicId, FARM_TILE, ZoneType } from '../sim/defs';

const CHUNK = 16;

interface Chunk {
  key: string;
  mesh: THREE.Mesh | null;
  pond: THREE.Mesh | null; // 大公園の池の水面
  glow: THREE.Mesh | null; // 夜の街灯の光だまり
  trees: TreeSpot[];
  beacons: number[]; // 航空障害灯の位置（x, y, z の並び）
}

export class BuildingLayer {
  group = new THREE.Group();
  material = createBuildingMaterial();
  pondMaterial = createPondMaterial();
  glowMaterial = createGlowMaterial();
  // 夜の明るさ（0..1）に合わせて、街灯の光だまりを出す
  setNight(v: number) {
    this.glowMaterial.opacity = v;
    this.glowMaterial.visible = v > 0.02;
  }
  private chunks = new Map<number, Chunk>();
  private heightKeys = new Map<number, number>();

  // 変更があった区画だけ作り直す。木の位置が変わったら true を返す。
  update(g: Grid, list: Building[], heightsChanged: boolean): boolean {
    const n = g.n;
    const cpr = Math.ceil(n / CHUNK);
    const byChunk = new Map<number, Building[]>();
    for (const b of list) {
      const c = Math.floor(b.y / CHUNK) * cpr + Math.floor(b.x / CHUNK);
      let a = byChunk.get(c);
      if (!a) byChunk.set(c, (a = []));
      a.push(b);
    }
    let treesChanged = false;
    const groundAt = (x: number, y: number) => g.cellMaxH(x, y);
    const minAt = (x: number, y: number) => g.cellMinH(x, y);
    // つなげられる公園：隣が同じ公園かどうか（形が変わるので区画のキーにも入れる）
    const cparkIds = new Set<number>();
    for (const b of list) if (b.civic && CIVIC[b.type as CivicId]?.cpark) cparkIds.add(b.id);
    const isCpark = (x: number, y: number) => g.inb(x, y) && cparkIds.has(g.bldg[g.idx(x, y)]);
    const all = new Set<number>([...byChunk.keys(), ...this.chunks.keys()]);
    for (const c of all) {
      const bs = byChunk.get(c) || [];
      bs.sort((a, b) => a.id - b.id);
      let key = '';
      for (const b of bs) {
        key += `${b.id}.${b.state}.${b.face};`;
        if (b.type === 'IA') key += `f${farmEmpty(g, b).length};`;
        if (cparkIds.has(b.id)) {
          let m = 0;
          for (let x = b.x; x < b.x + b.w; x++) m = m * 4 + (isCpark(x, b.y - 1) ? 1 : 0) + (isCpark(x, b.y + b.h) ? 2 : 0);
          for (let y = b.y; y < b.y + b.h; y++) m = m * 4 + (isCpark(b.x - 1, y) ? 1 : 0) + (isCpark(b.x + b.w, y) ? 2 : 0);
          key += `c${m};`;
        }
      }
      // 区画の地形が変わったかどうか
      let hk = this.heightKeys.get(c) ?? 0;
      if (heightsChanged) {
        const cx = (c % cpr) * CHUNK, cy = Math.floor(c / cpr) * CHUNK;
        let s = 0;
        for (let y = cy; y <= Math.min(n, cy + CHUNK); y++)
          for (let x = cx; x <= Math.min(n, cx + CHUNK); x++) s = (s * 31 + Math.round(g.vh(x, y) * 10)) | 0;
        hk = s;
        this.heightKeys.set(c, s);
      }
      key += `h${hk}`;
      const old = this.chunks.get(c);
      if (old && old.key === key) continue;
      if (old?.mesh) {
        this.group.remove(old.mesh);
        old.mesh.geometry.dispose();
      }
      for (const m of [old?.pond, old?.glow]) {
        if (!m) continue;
        this.group.remove(m);
        m.geometry.dispose();
      }
      treesChanged = true;
      if (!bs.length) {
        this.chunks.delete(c);
        continue;
      }
      const mb = new MeshBuilder();
      const trees: TreeSpot[] = [];
      const beacons: number[] = [];
      const pb = new PondBuilder();
      for (const b of bs) {
        const f = setupLot(mb, b, groundAt, minAt);
        const v0 = mb.pos.length;
        generateBuilding(mb, b, f, trees, isCpark, pb);
        // 農家：同じ区画（8×8）の空いた農地を、ぜんぶ畑にする
        if (b.type === 'IA' && g.zone[g.idx(b.x, b.y)] === ZoneType.F) farmFields(mb, g, b, farmEmpty(g, b), trees);
        // 高さ 60m を超える建物のいちばん高いところに、航空障害灯を付ける
        let top = -Infinity, tx = 0, tz = 0;
        for (let k = v0; k < mb.pos.length; k += 3) if (mb.pos[k + 1] > top) { top = mb.pos[k + 1]; tx = mb.pos[k]; tz = mb.pos[k + 2]; }
        if (top - f.base > 60) beacons.push(tx, top + 0.6, tz);
      }
      const mesh = new THREE.Mesh(mb.toGeometry(), this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      let pond: THREE.Mesh | null = null;
      if (!pb.empty) {
        pond = new THREE.Mesh(pb.toGeometry(), this.pondMaterial);
        pond.receiveShadow = true;
        this.group.add(pond);
      }
      let glow: THREE.Mesh | null = null;
      const gg = pb.glowGeometry();
      if (gg) {
        glow = new THREE.Mesh(gg, this.glowMaterial);
        glow.renderOrder = 2;
        this.group.add(glow);
      }
      this.chunks.set(c, { key, mesh, pond, glow, trees, beacons });
    }
    return treesChanged;
  }

  allBeacons(): number[] {
    const out: number[] = [];
    for (const c of this.chunks.values()) out.push(...c.beacons);
    return out;
  }

  allTrees(): TreeSpot[] {
    const out: TreeSpot[] = [];
    for (const c of this.chunks.values()) out.push(...c.trees);
    return out;
  }
}

// 農家の区画（8×8）の中で、建物も道路もない農地のマス
function farmEmpty(g: Grid, b: Building): number[] {
  const n = g.n, out: number[] = [];
  const tx = Math.floor(b.x / FARM_TILE) * FARM_TILE, ty = Math.floor(b.y / FARM_TILE) * FARM_TILE;
  for (let y = ty; y < Math.min(n, ty + FARM_TILE); y++)
    for (let x = tx; x < Math.min(n, tx + FARM_TILE); x++) {
      const i = y * n + x;
      if (g.zone[i] === ZoneType.F && !g.bldg[i] && !g.road[i] && !g.rail[i] && !g.pline[i]) out.push(i);
    }
  return out;
}
