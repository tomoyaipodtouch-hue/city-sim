// 建物の描画（16×16マスごとにまとめて1つのメッシュにする）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { BState, type Building } from '../sim/world';
import { MeshBuilder, PackedGeo } from './builder';
import { generateBuilding, setupLot, TreeSpot, farmFields, FxSpot, cemeteryStage } from './buildingGen';
import { forcedLogi } from './logiRegistry';
import { createBuildingMaterial } from './materials';
import { PondBuilder, createPondMaterial, createGlowMaterial, createFallMaterial } from './parkPond';
import { CIVIC, CivicId, FARM_TILE, LOGI_REACH, logiLook, ZoneType } from '../sim/defs';

type BCacheEntry = { key: string; geo: PackedGeo; trees: TreeSpot[]; fx: FxSpot[]; beacon: number[] | null };
// 建物ごとの形の覚えの上限（バイト）。こえた分は長く使っていない建物から捨てる（捨てた建物は、次に区画を作り直すときに作る）
const BCACHE_MAX = 24 << 20;
const packedBytes = (p: PackedGeo) => p.pos.byteLength + p.nor.byteLength + p.col.byteLength + p.uvm.byteLength + p.pat.byteLength + p.mat.byteLength + p.idx.byteLength;

const CHUNK = 16;

// 倉庫業（IL）の建物の形は、港・貨物駅への近さで変わる。施設と近さのはかり方は、シミュレーション（倉庫業が建つ場所）と
// 同じ defs の LOGI_REACH を使う（形には look の近さを使う）
export const PORT_STEPS = 8; // 近さの段階の数（段階を区画のキーに入れる）

// 港・貨物駅への近さ（0..PORT_STEPS の段階）。建物の中心から施設の四角のいちばん近いところまでの距離で決める
export function portLevel(b: Building, ports: Building[]): number {
  return Math.round(logiLook(ports, b.x + b.w / 2, b.y + b.h / 2) * PORT_STEPS);
}

// 物流施設の連結：港の近くで、同じ向き・同じ大きさの倉庫業（IL）の敷地が、道路にそった横の辺をぴったり共有して並んでいれば、
// 1 つの長い建物として描く（実際の大型物流施設は 150〜350m の長さがある）。seed = 連結の種（いちばん小さい種）、
// L / R = 敷地の -x / +x の側がつながる、lead = 看板を描く敷地、port・den = 連結の中でいちばん大きい値。
// 連結はいちばん高い敷地の地面にそろえて建てるので、地面の高さ（base）の差が JOIN_DH を超えるところではつなげない。
// 奥行きが 5 マス以上の敷地はつなげない（長い辺が道路と直角なので、横につなぐと形がくずれる）
export interface Campus { seed: number; den: number; port: number; L: boolean; R: boolean; lead: boolean }
// 倉庫業の建物かどうか
const isIL = (b: Building) => !b.civic && b.type === 'IL';
// 敷地の奥行き（マス。道路と直角の向き）
const depth = (b: Building) => (b.face === 0 || b.face === 4 ? b.w : b.h);
// 向きごとの、敷地の +x の向き（マスの x, y）
const RIGHT: Record<number, [number, number]> = { 2: [1, 0], 6: [-1, 0], 0: [0, -1], 4: [0, 1] };
const JOIN_DH = 1.5; // 連結の中の地面の高さの差の上限（m）
export function campuses(list: Building[], lv: Map<number, number>, any = false, base: (b: Building) => number = () => 0): Map<number, Campus> {
  const ok = (b: Building) => isIL(b) && b.state !== BState.Building && RIGHT[b.face] !== undefined && depth(b) <= 4 && (any || (lv.get(b.id) ?? 0) >= 2);
  const at = new Map<string, Building>();
  for (const b of list) if (ok(b)) at.set(`${b.x},${b.y}`, b);
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const L = new Set<number>(), R = new Set<number>(), byId = new Map<number, Building>();
  // 連結ごとの地面の高さのいちばん低い値・高い値（根の id ごと）
  const lo = new Map<number, number>(), hi = new Map<number, number>();
  for (const b of at.values()) {
    const [dx, dy] = RIGHT[b.face];
    const nb = at.get(`${b.x + dx * b.w},${b.y + dy * b.h}`);
    if (!nb || nb.face !== b.face || nb.w !== b.w || nb.h !== b.h) continue;
    for (const q of [b, nb]) if (!parent.has(q.id) && !lo.has(q.id)) { const h = base(q); lo.set(q.id, h); hi.set(q.id, h); }
    const ra = parent.has(b.id) ? find(b.id) : b.id, rb = parent.has(nb.id) ? find(nb.id) : nb.id;
    const l = Math.min(lo.get(ra)!, lo.get(rb)!), h = Math.max(hi.get(ra)!, hi.get(rb)!);
    if (h - l > JOIN_DH) continue;
    for (const q of [b, nb]) if (!parent.has(q.id)) { parent.set(q.id, q.id); byId.set(q.id, q); }
    R.add(b.id);
    L.add(nb.id);
    parent.set(ra, rb);
    lo.set(rb, l);
    hi.set(rb, h);
  }
  // 連結ごとに、種・密度・近さをまとめる
  const groups = new Map<number, Building[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(byId.get(id)!);
  }
  const out = new Map<number, Campus>();
  for (const g of groups.values()) {
    let head = g[0];
    for (const b of g) if (b.seed < head.seed || (b.seed === head.seed && b.id < head.id)) head = b;
    const den = Math.max(...g.map((b) => b.den)), port = Math.max(...g.map((b) => lv.get(b.id) ?? 0));
    for (const b of g) out.set(b.id, { seed: head.seed, den, port, L: L.has(b.id), R: R.has(b.id), lead: b === head });
  }
  return out;
}

interface Chunk {
  key: string;
  mesh: THREE.Mesh | null;
  pond: THREE.Mesh | null; // 大公園の池の水面
  glow: THREE.Mesh | null; // 夜の街灯の光だまり
  fall: THREE.Mesh | null; // 庭園の滝の水と、滝つぼの泡
  lights: number[]; // 夜の明かり（庭の灯籠・ライトアップ・公園の街灯）
  falls: number[]; // 滝つぼ（水面の波紋）
  trees: TreeSpot[];
  beacons: number[]; // 航空障害灯の位置（x, y, z の並び）
  fx: FxSpot[]; // 煙、炎、トラックの道すじ
}

export class BuildingLayer {
  group = new THREE.Group();
  material = createBuildingMaterial();
  pondMaterial = createPondMaterial();
  glowMaterial = createGlowMaterial();
  fallMaterial = createFallMaterial();
  // 全部の区画の明かりと滝つぼ（区画が変わったら集め直す）
  private lightsAll: number[] = [];
  private fallsAll: number[] = [];
  private gatherDirty = true;
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
    // 港・貨物駅（倉庫業の建物の形を選ぶのに使う）と、建物ごとの近さの段階、物流施設の連結
    const ports = list.filter((b) => b.civic && LOGI_REACH[b.type as CivicId]);
    const plv = new Map<number, number>();
    if (ports.length) for (const b of list) if (isIL(b)) plv.set(b.id, portLevel(b, ports));
    // 確認用に物流施設の形を強制しているときは、港から遠くてもつなげる
    const lotBase = (b: Building) => {
      let h = -Infinity;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) h = Math.max(h, groundAt(x, y));
      return h;
    };
    const camp = campuses(list, plv, !!forcedLogi(), lotBase);
    // 連結した建物は同じ高さの地面に建てる（敷地ごとに地面の高さが違うと、つなぎ目に段ができる）
    const cbase = new Map<number, number>();
    for (const b of list) {
      const cp = camp.get(b.id);
      if (cp) cbase.set(cp.seed, Math.max(cbase.get(cp.seed) ?? -Infinity, lotBase(b)));
    }
    const all = new Set<number>([...byChunk.keys(), ...this.chunks.keys()]);
    for (const c of all) {
      const bs = byChunk.get(c) || [];
      bs.sort((a, b) => a.id - b.id);
      let key = '';
      const lv: number[] = []; // 建物ごとの港への近さの段階
      for (const b of bs) {
        key += `${b.id}.${b.state}.${b.face};`;
        if (b.hsr) key += `s${Math.round(b.hsr.deck * 8)};`;
        const cp = camp.get(b.id);
        const p = cp ? cp.port : plv.get(b.id) ?? 0;
        lv.push(p);
        if (p) key += `p${p};`;
        if (cp) key += `j${cp.seed}.${cp.den}.${cp.L ? 1 : 0}${cp.R ? 1 : 0}${cp.lead ? 1 : 0}.${Math.round((cbase.get(cp.seed) ?? 0) * 10)};`;
        if (b.type === 'IA') key += `f${farmEmpty(g, b).length};`;
        if (b.type === 'cemetery') key += `g${cemeteryStage(b)};`;
        if (cparkIds.has(b.id)) {
          let m = 0;
          for (let x = b.x; x < b.x + b.w; x++) m = m * 4 + (isCpark(x, b.y - 1) ? 1 : 0) + (isCpark(x, b.y + b.h) ? 2 : 0);
          for (let y = b.y; y < b.y + b.h; y++) m = m * 4 + (isCpark(b.x - 1, y) ? 1 : 0) + (isCpark(b.x + b.w, y) ? 2 : 0);
          key += `c${m};`;
        }
      }
      // 区画の地形が変わったかどうか（区画からはみ出す大きな建物の下の地形も見る）
      let hk = this.heightKeys.get(c) ?? 0;
      if (heightsChanged) {
        const cx = (c % cpr) * CHUNK, cy = Math.floor(c / cpr) * CHUNK;
        let ex = cx + CHUNK, ey = cy + CHUNK;
        for (const b of bs) { ex = Math.max(ex, b.x + b.w); ey = Math.max(ey, b.y + b.h); }
        let s = 0;
        for (let y = cy; y <= Math.min(n, ey); y++)
          for (let x = cx; x <= Math.min(n, ex); x++) s = (s * 31 + Math.round(g.vh(x, y) * 10)) | 0;
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
      this.gatherDirty = true;
      for (const m of [old?.pond, old?.glow, old?.fall]) {
        if (!m) continue;
        this.group.remove(m);
        m.geometry.dispose();
      }
      treesChanged = true;
      if (!bs.length) {
        this.chunks.delete(c);
        continue;
      }
      const parts: PackedGeo[] = [];
      const trees: TreeSpot[] = [];
      const beacons: number[] = [];
      const pb = new PondBuilder();
      const fx: FxSpot[] = [];
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const cp = camp.get(b.id), cb = cp ? cbase.get(cp.seed) : undefined;
        // 建物ごとの形の覚え：同じ建物・同じ地面なら、前に作った形をそのまま使う（区画の中の1軒が建つたびに、
        // 区画の全部の建物を作り直さない）。池・滝・明かりのある公園と農家は、毎回作る
        const bk = this.buildingKey(g, b, lv[i], cp, cb, cparkIds.size ? isCpark : null);
        const hit = this.bcache.get(b.id);
        if (hit && hit.key === bk) {
          // 使った覚えは新しい方へ（覚えの上限をこえたら、長く使っていないものから捨てる）
          this.bcache.delete(b.id);
          this.bcache.set(b.id, hit);
          parts.push(hit.geo);
          for (const t of hit.trees) trees.push(t);
          for (const q of hit.fx) fx.push(q);
          if (hit.beacon) beacons.push(...hit.beacon);
          continue;
        }
        const one = new MeshBuilder();
        const tr0 = trees.length, fx0 = fx.length;
        const pond0 = pb.pos.length + pb.lights.length + pb.falls.length + pb.glows.length;
        const f = setupLot(one, b, cb !== undefined ? () => cb : groundAt, minAt);
        if (cp) Object.assign(f, { campus: cp.seed, joinL: cp.L, joinR: cp.R, lead: cp.lead, cden: cp.den });
        generateBuilding(one, b, f, trees, isCpark, pb, fx, lv[i] / PORT_STEPS);
        // 農家：同じ区画（8×8）の空いた農地を、ぜんぶ畑にする
        const farm = b.type === 'IA' && g.zone[g.idx(b.x, b.y)] === ZoneType.F;
        if (farm) farmFields(one, g, b, farmEmpty(g, b), trees);
        // 高さ 60m を超える建物のいちばん高いところに、航空障害灯を付ける
        let top = -Infinity, tx = 0, tz = 0;
        for (let k = 0; k < one.pos.length; k += 3) if (one.pos[k + 1] > top) { top = one.pos[k + 1]; tx = one.pos[k]; tz = one.pos[k + 2]; }
        const beacon = top - f.base > 60 ? [tx, top + 0.6, tz] : null;
        if (beacon) beacons.push(...beacon);
        const geo = one.pack();
        parts.push(geo);
        const pond1 = pb.pos.length + pb.lights.length + pb.falls.length + pb.glows.length;
        if (!farm && pond1 === pond0) {
          this.cacheSet(b.id, { key: bk, geo, trees: trees.slice(tr0), fx: fx.slice(fx0), beacon });
        } else this.cacheDel(b.id);
      }
      const mesh = new THREE.Mesh(MeshBuilder.mergePacked(parts), this.material);
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
      let fall: THREE.Mesh | null = null;
      const fg = pb.fallGeometry();
      if (fg) {
        fall = new THREE.Mesh(fg, this.fallMaterial);
        fall.renderOrder = 3;
        // 地下を見るときは、透かさずに隠す
        fall.userData.fx = true;
        this.group.add(fall);
      }
      this.chunks.set(c, { key, mesh, pond, glow, fall, trees, beacons, fx, lights: pb.lights, falls: pb.falls });
    }
    // もう無い建物（取り壊し・建て替え）の覚えを捨てる
    {
      const alive = new Set<number>();
      for (const b of list) alive.add(b.id);
      for (const id of [...this.bcache.keys()]) if (!alive.has(id)) this.cacheDel(id);
      // 覚えの大きさの上限（iPhone の Safari はメモリが少ない：大きな街で全部の建物の形を覚えると、描画用の形と合わせて倍になる）
      for (const id of this.bcache.keys()) {
        if (this.bcacheBytes <= BCACHE_MAX) break;
        this.cacheDel(id);
      }
    }
    return treesChanged;
  }

  // 建物ごとの形の覚え（建物の id → 形を決める値と、作った形）
  private bcache = new Map<number, BCacheEntry>();
  private bcacheBytes = 0;
  private cacheSet(id: number, e: BCacheEntry) {
    this.cacheDel(id);
    this.bcache.set(id, e);
    this.bcacheBytes += packedBytes(e.geo);
  }
  private cacheDel(id: number) {
    const e = this.bcache.get(id);
    if (!e) return;
    this.bcache.delete(id);
    this.bcacheBytes -= packedBytes(e.geo);
  }
  // 建物の形を決める値：種類・状態・向き・大きさ・階数・密度、港への近さ、連結、敷地の地面の高さ、となりの公園
  private buildingKey(g: Grid, b: Building, lv: number, cp: Campus | undefined, cb: number | undefined, isCpark: ((x: number, y: number) => boolean) | null) {
    let k = `${b.type}.${b.state}.${b.face}.${b.x}.${b.y}.${b.w}.${b.h}.${b.floors}.${b.den}.${b.seed}.${b.civic ? 1 : 0}.p${lv}`;
    if (cp) k += `.j${cp.seed}.${cp.den}.${cp.port}.${cp.L ? 1 : 0}${cp.R ? 1 : 0}${cp.lead ? 1 : 0}.${cb ?? 0}`;
    if (b.type === 'cemetery') k += `.g${cemeteryStage(b)}`;
    if (b.hsr) k += `.hsr${b.hsr.row}.${Math.round(b.hsr.deck * 8)}.${b.hsr.ground ? 1 : 0}`;
    let h = 0;
    for (let y = b.y; y <= b.y + b.h; y++) for (let x = b.x; x <= b.x + b.w; x++) h = Math.imul(h ^ Math.round(g.vh(x, y) * 64), 16777619);
    k += `.h${h}`;
    if (isCpark) {
      let m = 0;
      for (let x = b.x - 1; x <= b.x + b.w; x++) m = Math.imul(m ^ ((isCpark(x, b.y - 1) ? 1 : 0) + (isCpark(x, b.y + b.h) ? 2 : 0)), 31) + 7;
      for (let y = b.y; y < b.y + b.h; y++) m = Math.imul(m ^ ((isCpark(b.x - 1, y) ? 1 : 0) + (isCpark(b.x + b.w, y) ? 2 : 0)), 31) + 7;
      k += `.c${m}`;
    }
    return k;
  }

  private gather() {
    if (!this.gatherDirty) return;
    this.gatherDirty = false;
    this.lightsAll = [];
    this.fallsAll = [];
    for (const c of this.chunks.values()) {
      for (const v of c.lights) this.lightsAll.push(v);
      for (const v of c.falls) this.fallsAll.push(v);
    }
  }
  gardenLights(): number[] {
    this.gather();
    return this.lightsAll;
  }
  gardenFalls(): number[] {
    this.gather();
    return this.fallsAll;
  }

  allBeacons(): number[] {
    const out: number[] = [];
    for (const c of this.chunks.values()) out.push(...c.beacons);
    return out;
  }

  allFx(): FxSpot[] {
    const out: FxSpot[] = [];
    for (const c of this.chunks.values()) out.push(...c.fx);
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
