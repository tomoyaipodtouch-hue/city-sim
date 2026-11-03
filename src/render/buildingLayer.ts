// 建物の描画（16×16マスごとにまとめて1つのメッシュにする）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import type { Building } from '../sim/world';
import { MeshBuilder } from './builder';
import { generateBuilding, setupLot, TreeSpot } from './buildingGen';
import { createBuildingMaterial } from './materials';

const CHUNK = 16;

interface Chunk {
  key: string;
  mesh: THREE.Mesh | null;
  trees: TreeSpot[];
}

export class BuildingLayer {
  group = new THREE.Group();
  material = createBuildingMaterial();
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
    const all = new Set<number>([...byChunk.keys(), ...this.chunks.keys()]);
    for (const c of all) {
      const bs = byChunk.get(c) || [];
      bs.sort((a, b) => a.id - b.id);
      let key = '';
      for (const b of bs) key += `${b.id}.${b.state}.${b.face};`;
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
      treesChanged = true;
      if (!bs.length) {
        this.chunks.delete(c);
        continue;
      }
      const mb = new MeshBuilder();
      const trees: TreeSpot[] = [];
      for (const b of bs) {
        const f = setupLot(mb, b, groundAt, minAt);
        generateBuilding(mb, b, f, trees);
      }
      const mesh = new THREE.Mesh(mb.toGeometry(), this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.chunks.set(c, { key, mesh, trees });
    }
    return treesChanged;
  }

  allTrees(): TreeSpot[] {
    const out: TreeSpot[] = [];
    for (const c of this.chunks.values()) out.push(...c.trees);
    return out;
  }
}
