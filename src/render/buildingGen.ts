// 建物の自動生成（アメリカの都市風）
import * as THREE from 'three';
import { MAT } from './textures';
import { MeshBuilder, PAT } from './builder';
import { Rng } from '../sim/rng';
import { CELL } from '../sim/constants';
import type { Building } from '../sim/world';
import type { Grid } from '../sim/grid';
import { BState } from '../sim/world';
import { PondBuilder, cpLake, LAKE_T } from './parkPond';
import { kyotoGarden } from './gardenGen';
import { forcedLogi, LOGI } from './logiRegistry';
import './logisticsA';
import './logisticsB';
import './resModernA';
import './resModernB';
import { forcedRes, pickRes } from './resRegistry';
import { ciqOffice } from './ciqGen';
import { eduSchool, eduCollege, townHall } from './civicEduGen';
import { CIVIC } from '../sim/defs';

// 動くもの（煙、フレアの炎、トラックの道すじ）の位置。世界の座標
export type FxSpot =
  | { kind: 'smoke'; x: number; y: number; z: number; s: number; dark: boolean }
  | { kind: 'flare'; x: number; y: number; z: number; s: number }
  | { kind: 'truck'; pts: number[]; wait: number; color: number };
let fxOut: FxSpot[] | null = null;
const fxSmoke = (mb: MeshBuilder, x: number, y: number, z: number, s = 1, dark = false) => { if (fxOut) { const [wx, wy, wz] = mb.world(x, y, z); fxOut.push({ kind: 'smoke', x: wx, y: wy, z: wz, s, dark }); } };
const fxFlare = (mb: MeshBuilder, x: number, y: number, z: number, s = 1) => { if (fxOut) { const [wx, wy, wz] = mb.world(x, y, z); fxOut.push({ kind: 'flare', x: wx, y: wy, z: wz, s }); } };
// トラックの道すじ（敷地の座標の点の列 [x, y, z, ...]）。行って、wait 秒止まって、戻る
const fxTruck = (mb: MeshBuilder, pts: [number, number, number][], wait = 6, color = 0xf2f2f2) => { if (fxOut) { const o: number[] = []; for (const [x, y, z] of pts) o.push(...mb.world(x, y, z)); fxOut.push({ kind: 'truck', pts: o, wait, color }); } };

export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  s: number;
  kind: number; // 0=広葉樹, 1=針葉樹
  col?: number; // 葉の色を決める（庭の青もみじなど）
  shape?: number; // 形を決める（treeLayer の SHAPE の番号）
}

const C = (hex: number) => new THREE.Color(hex);

const PALETTE = {
  houseWall: [0xf2efe6, 0xe9dfc7, 0xd8cdb4, 0xc9d6dc, 0xefe2b8, 0xcfd3cf, 0xb9c4a8, 0xa65e46, 0xdcc9b0, 0xb7c7d9].map(C),
  roof: [0x4a4d52, 0x5b4a3e, 0x6e3b2f, 0x3f4a57, 0x5d5f62, 0x77685a].map(C),
  shopWall: [0xb05a3c, 0x9c4f36, 0xd6c3a1, 0xc8b28e, 0xe0dccf, 0x8f8a80, 0xa4583d].map(C),
  accent: [0xc0392b, 0x2e7d32, 0x1f5fa8, 0xe0a800, 0x6a3d9a, 0x00897b, 0xd35400].map(C),
  indWall: [0xb9bec4, 0xa9b3bd, 0xcac4b5, 0x9ea8a8, 0xd2cbb8, 0x8d9aa6].map(C),
  concrete: C(0xb8b4aa),
  asphalt: C(0x3d3f42),
  pavement: C(0x9c9b96),
  lawn: C(0x6e9a4a),
  lawn2: C(0x7aa553),
  dirt: C(0x8a6e4b),
  water: C(0x3c8fc0),
  hedge: C(0x3e6b2f),
  white: C(0xf4f4f0),
  dark: C(0x2a2b2e),
  glass: C(0x5c7387),
  brick: C(0x8e3b2a),
  wood: C(0xa57c4f),
  steel: C(0x7a8088),
  barn: C(0xa23b2c),
  crop: [0x9fb04a, 0xc8b45a, 0x6f9a3a, 0xb4a24c, 0x88a845].map(C),
};

export interface LotFrame {
  W: number; // 正面の幅（m）
  D: number; // 奥行き（m）
  base: number; // 地面の高さ
  // 物流施設の連結（となりの同じ大きさの敷地と 1 つの長い建物にする。buildingLayer で決める）
  campus?: number; // 連結の種（形・色・高さをそろえる）
  joinL?: boolean; // -x の側（敷地の座標）がとなりとつながる
  joinR?: boolean; // +x の側がつながる
  lead?: boolean; // 看板を描く敷地（連結の中で 1 つ）
  cden?: number; // 連結の密度（高さをそろえる）
}

// 敷地の向きに合わせた変換を設定する
export function setupLot(mb: MeshBuilder, b: Building, groundAt: (x: number, y: number) => number, minAt: (x: number, y: number) => number): LotFrame {
  const cx = (b.x + b.w / 2) * CELL, cz = (b.y + b.h / 2) * CELL;
  let base = -Infinity, lo = Infinity;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      base = Math.max(base, groundAt(x, y));
      lo = Math.min(lo, minAt(x, y));
    }
  const angle = b.face === 0 ? -Math.PI / 2 : b.face === 4 ? Math.PI / 2 : b.face === 6 ? Math.PI : 0;
  mb.setTransform(angle, cx, base, cz);
  const side = b.face === 0 || b.face === 4;
  const W = (side ? b.h : b.w) * CELL;
  const D = (side ? b.w : b.h) * CELL;
  // 傾斜地の基礎
  if (base - lo > 0.3) mb.box(-W / 2 + 0.3, lo - base - 0.5, -D / 2 + 0.3, W / 2 - 0.3, 0, D / 2 - 0.3, PALETTE.concrete);
  return { W, D, base };
}

// 平らな屋上の色（建物ごとに選ぶ。真っ黒だと形がつぶれて見えるので明るめにする）
const FLAT_ROOFS = [0x9b9891, 0x8a8a86, 0xb5b2aa, 0xcfcfc8, 0x7d7f80, 0xa59d8c].map((h) => new THREE.Color(h));
let curRoof = FLAT_ROOFS[0];
let officePat: number = PAT.curtain;
let resPat: number = PAT.balcony;
let louvers = false;
const flatRoof = () => curRoof;

// port = 港・貨物駅への近さ（0..1、buildingLayer で決める）。倉庫業の建物の形の選び方に使う
export function generateBuilding(mb: MeshBuilder, b: Building, f: LotFrame, trees: TreeSpot[], isCpark: (x: number, y: number) => boolean = () => false, pond?: PondBuilder, fx?: FxSpot[], port = 0) {
  fxOut = fx ?? null;
  const rng = new Rng(b.seed);
  curRoof = FLAT_ROOFS[b.seed % FLAT_ROOFS.length];
  // 外壁のデザイン（建物ごとに選ぶ）：全面ガラス・横長の連続窓・ふつうの窓、縦ルーバーの有無、マンションのバルコニー
  const fr = ((b.seed >>> 5) % 100) / 100;
  officePat = fr < 0.35 ? PAT.curtain : fr < 0.65 ? PAT.fullglass : fr < 0.92 ? PAT.ribbon : PAT.office;
  louvers = ((b.seed >>> 9) % 100) < 35;
  resPat = ((b.seed >>> 12) % 100) < 80 ? PAT.balcony : PAT.apartment;
  mb.flatRoofMat = (b.seed >> 3) % 3 === 0 ? MAT.gravel : MAT.membrane;
  // 工場・発電所などの斜めの屋根は金属
  mb.slopeRoofMat = b.civic || b.type === 'ID' || b.type === 'IM' || b.type === 'IH' || b.type === 'IL' ? MAT.metal : MAT.shingle;
  mb.abandoned = b.state === BState.Abandoned;
  const tf = (lx: number, lz: number, s = 1, kind = 0, ly = 0, col?: number, shape?: number) => {
    // ローカル座標から世界座標へ（MeshBuilder と同じ変換）
    const a = b.face === 0 ? -Math.PI / 2 : b.face === 4 ? Math.PI / 2 : b.face === 6 ? Math.PI : 0;
    const cos = Math.cos(a), sin = Math.sin(a);
    const cx = (b.x + b.w / 2) * CELL, cz = (b.y + b.h / 2) * CELL;
    trees.push({ x: lx * cos - lz * sin + cx, y: f.base + ly, z: lx * sin + lz * cos + cz, s, kind, col, shape });
    feet.push(lx, lz, ly, s);
  };
  const feet: number[] = []; // 木の足元（敷地の座標 x, z, 高さ, 大きさ）
  if (b.state === BState.Building) {
    construction(mb, f, rng);
    mb.abandoned = false;
    return;
  }
  const dense = b.den > 0 && b.floors > 0;
  // 芝生の縁を暗くし、木の足元に陰を落とす（この建物のあいだだけ）
  mb.beginLot(f.W / 2, f.D / 2);
  switch (b.type) {
    case 'R1':
    case 'R2':
    case 'R3':
      if (dense && b.floors >= 9) highrise(mb, f, rng, tf, b.floors, false, b.type === 'R3');
      else if (dense) apartments(mb, f, rng, tf, b.floors, b.type);
      else if (b.type === 'R1') houseLow(mb, f, rng, tf, b);
      else if (b.type === 'R2') houseMid(mb, f, rng, tf, b);
      else mansion(mb, f, rng, tf);
      break;
    case 'CS1': case 'CS2': case 'CS3':
      if (dense && Math.min(f.W, f.D) >= 28) commercialMid(mb, f, rng, tf, b.floors, b.type === 'CS3');
      else if (dense) shopMid(mb, f, rng, tf, b.floors, b.type === 'CS3');
      else lowShop(mb, f, rng, tf, b.type === 'CS1' ? 1 : b.type === 'CS2' ? 2 : 3);
      break;
    case 'CO2': case 'CO3':
      highrise(mb, f, rng, tf, Math.max(3, b.floors), true, b.type === 'CO3');
      break;
    case 'IA': farm(mb, f, rng, tf); break;
    case 'ID': dirtyIndustry(mb, f, rng, tf, b.den); break;
    case 'IM': mfgIndustry(mb, f, rng, tf, b.den); break;
    case 'IL': warehousing(mb, f, rng, tf, b.den, b.seed, port); break;
    case 'IH': hightech(mb, f, rng, tf, b.den); break;
    case 'coal': coalPlant(mb, f); break;
    case 'gas': gasPlant(mb, f); break;
    case 'oil': oilPlant(mb, f); break;
    case 'nuclear': nuclearPlant(mb, f); break;
    case 'nuclear_in': bigNuclear(mb, f, tf, false); break;
    case 'nuclear_sea': bigNuclear(mb, f, tf, true); break;
    case 'wind': windTurbine(mb, f, rng); break;
    case 'solar': solarFarm(mb, f); break;
    case 'pump': pump(mb, f); break;
    case 'tower': waterTower(mb, f); break;
    case 'park_s': park(mb, f, rng, tf, false); break;
    case 'park_l': park(mb, f, rng, tf, true); break;
    case 'plaza': plaza(mb, f, rng, tf); break;
    case 'playground': playground(mb, f, rng, tf); break;
    case 'greenway': greenway(mb, f, rng, tf); break;
    case 'sports': sportsPark(mb, f, rng, tf); break;
    case 'garden': kyotoGarden(mb, f, rng, tf, pond); break;
    case 'cpark_a': case 'cpark_b': centralPark(mb, b, f, trees, isCpark, pond); break;
    case 'busstop': busStop(mb, f); break;
    case 'station': station(mb, f, 0); break;
    case 'el_station': station(mb, f, 8); break;
    case 'mono_station': station(mb, f, 11); break;
    case 'sub_station': subwayEntrance(mb, f); break;
    case 'ferry_p': ferryTerminal(mb, f, false); break;
    case 'ferry_c': ferryTerminal(mb, f, true); break;
    case 'seaport': seaport(mb, f, rng); break;
    case 'seaport_l': containerTerminal(mb, f, rng, tf); break;
    case 'airport_s': airport(mb, f, rng, 1, tf); break;
    case 'airport_l': airport(mb, f, rng, 2, tf); break;
    case 'freight_st': freightStation(mb, f, rng); break;
    case 'police_s': modernPolice(mb, f, tf, false); break;
    case 'police_l': modernPolice(mb, f, tf, true); break;
    case 'fire_s': modernFire(mb, f, tf, false); break;
    case 'fire_l': modernFire(mb, f, tf, true); break;
    case 'clinic': modernClinic(mb, f, tf); break;
    case 'hospital': modernHospital(mb, f, tf); break;
    case 'school_e': eduSchool(mb, f, tf, false, b.seed); break;
    case 'school_h': eduSchool(mb, f, tf, true, b.seed); break;
    case 'college': eduCollege(mb, f, tf, b.seed); break;
    case 'library': modernLibrary(mb, f, tf); break;
    case 'landfill': landfill(mb, f, rng); break;
    case 'incinerator': incinerator(mb, f, tf, false); break;
    case 'incinerator_l': incinerator(mb, f, tf, true); break;
    case 'water_plant': waterPlant(mb, f, tf); break;
    case 'desal': desalPlant(mb, f, tf); break;
    case 'recycling': recycling(mb, f, rng, tf); break;
    case 'cemetery': cemetery(mb, f, rng, tf, cemeteryStage(b)); break;
    case 'crematorium': crematorium(mb, f, rng, tf, pond); break;
    case 'mayor_house': mansion(mb, f, rng, tf); break;
    case 'city_hall': townHall(mb, f, tf); break;
    case 'statue': statue(mb, f, tf); break;
    case 'museum': modernMuseum(mb, f, tf); break;
    case 'stadium': stadium(mb, f, rng); break;
    case 'future_stadium': futureStadium(mb, f); break;
    case 'ciq': ciqOffice(mb, f, rng, tf); break;
  }
  for (let k = 0; k < feet.length; k += 4) mb.treeFoot(feet[k], feet[k + 1], feet[k + 2], feet[k + 3]);
  mb.endLot();
  mb.abandoned = false;
}

export type TF = (lx: number, lz: number, s?: number, kind?: number, y?: number, col?: number, shape?: number) => void;

function lawn(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.06, rng.next() < 0.5 ? PALETTE.lawn : PALETTE.lawn2);
}

function driveway(mb: MeshBuilder, f: LotFrame, x: number, w: number, zEnd: number) {
  mb.ground(x - w / 2, zEnd, x + w / 2, f.D / 2 - 0.1, 0.1, PALETTE.pavement);
}

// 一戸建て（屋根の形を選べる）
function house(mb: MeshBuilder, x: number, z: number, w: number, d: number, floors: number, wall: THREE.Color, roof: THREE.Color, rng: Rng, hip = false) {
  const fh = 3.0;
  const h = floors * fh + 0.4;
  mb.box(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, wall, PAT.house);
  const rise = Math.min(w, d) * (0.28 + rng.next() * 0.12);
  if (hip) mb.hip(x - w / 2, z - d / 2, x + w / 2, z + d / 2, h, rise, roof);
  else if (w >= d) mb.gableX(x - w / 2, z - d / 2, x + w / 2, z + d / 2, h, rise, roof, wall);
  else {
    // 棟を z 方向にするため、回転した切妻を近似（寄棟で代用）
    mb.hip(x - w / 2, z - d / 2, x + w / 2, z + d / 2, h, rise, roof, 0.4);
  }
  // 玄関
  mb.box(x - 0.6, 0, z + d / 2, x + 0.6, 2.2, z + d / 2 + 0.08, PALETTE.wood);
  // 煙突
  if (rng.next() < 0.4) mb.box(x + w / 4, h, z - 0.4, x + w / 4 + 0.8, h + rise + 0.6, z + 0.4, PALETTE.brick);
}

function houseLow(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, b: Building) {
  lawn(mb, f, rng);
  const wall = rng.pick(PALETTE.houseWall), roof = rng.pick(PALETTE.roof);
  const cells = b.w * b.h;
  if (cells >= 2 && rng.next() < 0.55) {
    // 低層の集合住宅（ウォークアップ）
    const floors = 2 + rng.int(2);
    const w = f.W - 5, d = f.D - 7;
    mb.box(-w / 2, 0, -d / 2 - 1, w / 2, floors * 3 + 0.5, d / 2 - 1, wall, PAT.apartment, flatRoof());
    mb.box(-w / 2, floors * 3 + 0.5, -d / 2 - 1, w / 2, floors * 3 + 1.0, -d / 2 - 0.7, wall);
    // 駐車場
    mb.ground(-f.W / 2 + 1, d / 2 - 0.5, f.W / 2 - 1, f.D / 2 - 0.3, 0.1, PALETTE.asphalt);
    tf(-w / 2 - 1, -d / 2, 0.8);
    return;
  }
  // 小さな一戸建て（区画が大きい場合は2軒）
  const count = cells >= 2 ? 2 : 1;
  const span = f.W / count;
  for (let k = 0; k < count; k++) {
    const cxl = -f.W / 2 + span * (k + 0.5);
    const w = Math.min(span - 4, 7 + rng.next() * 3), d = 6.5 + rng.next() * 2.5;
    const z = f.D / 2 - 4.5 - d / 2 - rng.next() * 1.5;
    house(mb, cxl - 1, z, w, d, 1 + (rng.next() < 0.3 ? 1 : 0), k === 0 ? wall : rng.pick(PALETTE.houseWall), roof, rng);
    driveway(mb, f, cxl + w / 2 + 0.4, 2.6, z - d / 2 + 1);
    if (rng.next() < 0.8) tf(cxl - span / 2 + 2.5 + rng.next() * 2, -f.D / 2 + 2.5 + rng.next() * 2, 0.8 + rng.next() * 0.5);
    if (rng.next() < 0.4) tf(cxl + 2, -f.D / 2 + 3, 0.7);
  }
  // 裏のフェンス
  mb.box(-f.W / 2 + 0.3, 0, -f.D / 2 + 0.3, f.W / 2 - 0.3, 1.2, -f.D / 2 + 0.45, PALETTE.wood);
}

function houseMid(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, b: Building) {
  lawn(mb, f, rng);
  const wall = rng.pick(PALETTE.houseWall), roof = rng.pick(PALETTE.roof);
  if (b.w * b.h === 2 && rng.next() < 0.45) {
    // タウンハウス
    const units = Math.round(f.W / 6);
    const uw = (f.W - 3) / units;
    for (let k = 0; k < units; k++) {
      const x = -f.W / 2 + 1.5 + uw * (k + 0.5);
      const wcol = k % 2 ? wall : rng.pick(PALETTE.houseWall);
      mb.box(x - uw / 2, 0, -3.5, x + uw / 2, 6.6, 3.5, wcol, PAT.house);
      mb.gableX(x - uw / 2, -3.5, x + uw / 2, 3.5, 6.6, 2.2, roof, wcol, 0.05);
      mb.ground(x - 1, 3.5, x + 1, f.D / 2 - 0.1, 0.1, PALETTE.pavement);
    }
    tf(-f.W / 2 + 2, -f.D / 2 + 2.5);
    tf(f.W / 2 - 2, -f.D / 2 + 2.5);
    return;
  }
  const w = Math.min(f.W - 6, 10 + rng.next() * 3), d = Math.min(f.D - 7, 8 + rng.next() * 2);
  const z = f.D / 2 - 5.5 - d / 2;
  const x = -1.5;
  house(mb, x, z, w, d, 2, wall, roof, rng, rng.next() < 0.5);
  // ガレージ
  const gx = x + w / 2 + 2.3;
  mb.box(gx - 2.3, 0, z - d / 2 + 2, gx + 2.3, 2.9, z + d / 2, wall, PAT.none);
  mb.box(gx - 1.8, 0.05, z + d / 2, gx + 1.8, 2.4, z + d / 2 + 0.05, PALETTE.white);
  mb.hip(gx - 2.3, z - d / 2 + 2, gx + 2.3, z + d / 2, 2.9, 1.2, roof, 0.3);
  driveway(mb, f, gx, 3.6, z + d / 2);
  tf(-f.W / 2 + 2.5, -f.D / 2 + 3, 1.1);
  if (f.W > 20) tf(f.W / 2 - 3, -f.D / 2 + 3, 1.0);
  tf(-f.W / 2 + 2, f.D / 2 - 2.5, 0.7);
}

function mansion(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  lawn(mb, f, rng);
  const wall = rng.pick([PALETTE.houseWall[0], PALETTE.houseWall[1], PALETTE.houseWall[2], PALETTE.houseWall[9]]);
  const roof = rng.pick(PALETTE.roof);
  const w = Math.min(f.W - 10, 16 + rng.next() * 4), d = Math.min(f.D - 12, 10 + rng.next() * 3);
  const z = -1;
  mb.box(-w / 2, 0, z - d / 2, w / 2, 7, z + d / 2, wall, PAT.house);
  mb.hip(-w / 2, z - d / 2, w / 2, z + d / 2, 7, 3.2, roof, 0.5);
  // 両翼
  mb.box(-w / 2 - 5, 0, z - d / 2 + 1, -w / 2, 4, z + d / 2 - 1, wall, PAT.house);
  mb.hip(-w / 2 - 5, z - d / 2 + 1, -w / 2, z + d / 2 - 1, 4, 2, roof);
  // 玄関の柱
  for (const px of [-2, -0.7, 0.7, 2]) mb.box(px - 0.2, 0, z + d / 2, px + 0.2, 5, z + d / 2 + 2, PALETTE.white);
  mb.box(-2.6, 5, z + d / 2, 2.6, 5.4, z + d / 2 + 2.3, PALETTE.white);
  // プール
  if (f.D > 20) {
    mb.ground(w / 2 - 6, -f.D / 2 + 3, w / 2 + 2, -f.D / 2 + 7.5, 0.1, PALETTE.white);
    mb.ground(w / 2 - 5.5, -f.D / 2 + 3.5, w / 2 + 1.5, -f.D / 2 + 7, 0.14, PALETTE.water);
  }
  // 車寄せ
  mb.ground(-1.6, z + d / 2 + 2, 1.6, f.D / 2 - 0.1, 0.1, PALETTE.pavement);
  // 生け垣
  mb.box(-f.W / 2 + 0.5, 0, f.D / 2 - 1.3, -2, 1.3, f.D / 2 - 0.5, PALETTE.hedge);
  mb.box(2, 0, f.D / 2 - 1.3, f.W / 2 - 0.5, 1.3, f.D / 2 - 0.5, PALETTE.hedge);
  for (let k = 0; k < 6; k++) tf(-f.W / 2 + 3 + rng.next() * (f.W - 6), -f.D / 2 + 2 + rng.next() * 4, 1 + rng.next() * 0.6, rng.next() < 0.3 ? 1 : 0);
  tf(-f.W / 2 + 3, f.D / 2 - 4, 1.2);
  tf(f.W / 2 - 3, f.D / 2 - 4, 1.2);
}

// 大きな平らな屋上の設備：階段室（エレベーターの機械室）、室外機をまとめて置いた一角とそのダクト。
// 使った幅と、右側（x1 の側）に置いたかを返す。残りの場所に小さな設備を散らす
function roofPlant(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, rng: Rng) {
  const W = x1 - x0, D = z1 - z0;
  const flip = rng.next() < 0.5;
  const X = (x: number) => (flip ? x1 - (x - x0) : x);
  const bx = (a: number, b: number, za: number, zb: number, ya: number, yb: number, c: THREE.Color, roof?: THREE.Color) =>
    mb.box(Math.min(X(a), X(b)), ya, za, Math.max(X(a), X(b)), yb, zb, c, PAT.none, roof);
  const wall = C(0xd2cfc8), unit = C(0xb9bdc2), fan = C(0x3a3d42), duct = C(0xa7acb2);
  // 階段室：屋上より一段高い小さな箱と、扉
  const sw = 4 + rng.next() * 1.5, sd = 5 + rng.next() * 2;
  const sz0 = z0 + 2 + rng.next() * Math.max(0.1, D - sd - 4);
  bx(x0 + 2, x0 + 2 + sw, sz0, sz0 + sd, y, y + 3.3, wall, C(0xa9a69f));
  mb.box(Math.min(X(x0 + 2 + sw), X(x0 + 2 + sw + 0.05)), y, sz0 + sd / 2 - 0.5, Math.max(X(x0 + 2 + sw), X(x0 + 2 + sw + 0.05)), y + 2.2, sz0 + sd / 2 + 0.5, C(0x5a6066));
  // 室外機の一角：2 列に並べる
  const ux0 = x0 + 4 + sw, cols = W > 30 ? 3 : 2, rows = D > 26 ? 3 : 2;
  const uz0 = z0 + 2.5 + rng.next() * Math.max(0.1, D - rows * 2.4 - 5);
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const ux = ux0 + i * 3.0, uz = uz0 + j * 2.4;
      bx(ux, ux + 2.4, uz, uz + 1.5, y, y + 1.3, unit);
      const fx = X(ux + 1.2);
      mb.cylinder(fx, uz + 0.75, y + 1.3, y + 1.36, 0.55, 8, fan, fan);
    }
  // ダクト：室外機の一角から階段室へ
  const dz = uz0 + rows * 2.4 + 0.2;
  if (dz + 0.7 < z1 - 1) bx(x0 + 2 + sw, ux0 + cols * 3.0, dz, dz + 0.7, y + 0.3, y + 1.0, duct);
  return { w: 4 + sw + cols * 3.0 + 1, flip };
}

// 屋上の設備（空調の室外機、換気口、天窓）。plant = 大きな屋上には階段室と室外機の一角も置く（屋上にほかの物がない建物だけ）
function roofUnits(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, rng: Rng, n: number, plant = false) {
  const unit = C(0xb9bdc2), fan = C(0x3a3d42);
  if (plant && x1 - x0 >= 22 && z1 - z0 >= 16) {
    const { w, flip } = roofPlant(mb, x0, z0, x1, z1, y, rng);
    // 残りの場所に散らす（設備の一角と重ならないように、反対の側へ）
    if (x1 - x0 - w < 6) return;
    if (flip) x1 = x1 - w; else x0 = x0 + w;
    n = Math.max(1, n - 1);
  }
  for (let k = 0; k < n; k++) {
    const x = x0 + 1.2 + rng.next() * Math.max(0.1, x1 - x0 - 4), z = z0 + 1.2 + rng.next() * Math.max(0.1, z1 - z0 - 4);
    const kind = rng.next();
    if (kind < 0.5) {
      // 室外機（ファンつき）
      mb.box(x, y, z, x + 2.2, y + 1.2, z + 1.4, unit);
      mb.cylinder(x + 0.65, z + 0.7, y + 1.2, y + 1.25, 0.5, 10, fan, fan);
      mb.cylinder(x + 1.55, z + 0.7, y + 1.2, y + 1.25, 0.5, 10, fan, fan);
    } else if (kind < 0.8) {
      // 換気口
      mb.box(x, y, z, x + 0.9, y + 0.9, z + 0.9, PALETTE.steel);
      mb.box(x - 0.15, y + 0.9, z - 0.15, x + 1.05, y + 1.05, z + 1.05, unit);
    } else {
      // 天窓
      mb.box(x, y, z, x + 2.6, y + 0.35, z + 1.8, PALETTE.glass);
    }
  }
}

// 屋上のふち（パラペット）。上面は明るい笠木
function roofRim(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, wall: THREE.Color, h = 0.9) {
  const t = 0.35, cap = C(0xd6d3cb);
  mb.box(x0, y, z1 - t, x1, y + h, z1, wall, PAT.none, cap);
  mb.box(x0, y, z0, x1, y + h, z0 + t, wall, PAT.none, cap);
  mb.box(x0, y, z0 + t, x0 + t, y + h, z1 - t, wall, PAT.none, cap);
  mb.box(x1 - t, y, z0 + t, x1, y + h, z1 - t, wall, PAT.none, cap);
}

function shop(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, tier: number) {
  // 駐車場と歩道
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.asphalt);
  mb.ground(-f.W / 2 + 0.2, f.D / 2 - 2.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.1, PALETTE.pavement);
  const accent = rng.pick(PALETTE.accent);
  if (tier === 1 && f.W <= 16 && rng.next() < 0.25) {
    // ガソリンスタンド
    mb.box(-6, 5, -1, 4, 5.6, 6, PALETTE.white, PAT.none, PALETTE.white);
    mb.box(-6, 5.0, 5.8, 4, 5.6, 6.05, accent);
    for (const px of [-5, 3]) for (const pz of [0, 5]) mb.box(px - 0.2, 0, pz - 0.2, px + 0.2, 5, pz + 0.2, PALETTE.steel);
    for (const px of [-3, 1]) mb.box(px - 0.4, 0, 2.2, px + 0.4, 1.5, 2.8, PALETTE.white);
    mb.box(-7, 0, -7, 2, 3.6, -2.5, PALETTE.shopWall[4], PAT.shop, flatRoof());
    mb.box(5.6, 0, 6, 6.2, 7, 6.6, PALETTE.steel);
    mb.box(4.9, 6, 6, 6.9, 7.6, 6.65, accent);
    return;
  }
  const floors = tier === 1 ? 1 : tier === 2 ? 1 + rng.int(2) : 2 + rng.int(2);
  const fh = 4.2;
  const w = f.W - 2.5, d = Math.min(f.D - 6, 9 + rng.next() * (f.D - 15));
  const z0 = f.D / 2 - 3 - d, z1 = f.D / 2 - 3;
  const wall = tier === 3 ? rng.pick([PALETTE.shopWall[2], PALETTE.shopWall[4], PALETTE.concrete]) : rng.pick(PALETTE.shopWall);
  const h = floors * fh;
  if (tier === 3 && rng.next() < 0.5) {
    mb.box(-w / 2, 0, z0, w / 2, h, z1, PALETTE.glass, PAT.office, flatRoof());
  } else {
    mb.box(-w / 2, 0, z0, w / 2, h, z1, wall, PAT.shop, flatRoof());
  }
  // パラペット
  mb.box(-w / 2, h, z1 - 0.3, w / 2, h + 0.9, z1, wall);
  // 看板と日よけ
  mb.box(-w / 2 + 0.5, 3.3, z1, w / 2 - 0.5, 4.0, z1 + 0.25, accent);
  if (rng.next() < 0.6) mb.quad([-w / 2 + 0.5, 3.2, z1 + 1.4], [w / 2 - 0.5, 3.2, z1 + 1.4], [w / 2 - 0.5, 3.8, z1], [-w / 2 + 0.5, 3.8, z1], accent);
  roofUnits(mb, -w / 2, z0, w / 2, z1, h, rng, 1 + rng.int(3));
  // 駐車場の白線
  stalls(mb, rng, -f.W / 2 + 2, f.W / 2 - 2, 2.8, z0 - 5.5, z0 - 1, 0.5);
  if (rng.next() < 0.5) tf(-f.W / 2 + 1.5, -f.D / 2 + 1.5, 0.8);
}



// ---------------- 駐車場（白線と、停まっている車） ----------------
const CAR_PAINT = [0xd8d8d8, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xf2f2f2, 0x3b5d3a, 0xc9a227, 0xb8bcc0, 0x101820, 0x7a1f2b, 0x4a6a8a].map((h) => new THREE.Color(h));
const CAR_GLASS = new THREE.Color(0x26303a);
function parkedCar(mb: MeshBuilder, x: number, z0: number, z1: number, rng: Rng) {
  const len = 4.3, w = 1.8;
  const front = rng.next() < 0.5; // 前向きか後ろ向きに停める
  const zc = (z0 + z1) / 2 + (front ? 0.2 : -0.2);
  const c = rng.pick(CAR_PAINT);
  mb.box(x - w / 2, 0.3, zc - len / 2, x + w / 2, 0.95, zc + len / 2, c);
  const cz = zc + (front ? -0.25 : 0.25);
  mb.box(x - w / 2 + 0.1, 0.95, cz - 1.05, x + w / 2 - 0.1, 1.45, cz + 1.05, CAR_GLASS, PAT.none, c);
}
// 区画の線（x0..x1 を step ごと、奥行き z0..z1）と、fill の割合で車を停める
function stalls(mb: MeshBuilder, rng: Rng, x0: number, x1: number, step: number, z0: number, z1: number, fill: number, y = 0.12) {
  for (let x = x0; x < x1; x += step) {
    mb.ground(x, z0, x + 0.14, z1, y, PALETTE.white);
    if (x + step < x1 + 0.01 && rng.next() < fill) parkedCar(mb, x + step / 2 + 0.07, z0, z1, rng);
  }
}

// ---------------- 細かい部品 ----------------
// 屋上の給水タンク：脚の上に円筒、円すいの屋根、たが（帯）
function waterTank(mb: MeshBuilder, x: number, z: number, y: number, r: number, rng: Rng) {
  const wood = rng.next() < 0.5, body = wood ? C(0x8a6a48) : C(0xb9bdc2), band = wood ? PALETTE.dark : PALETTE.steel;
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mb.box(x + dx * r * 0.65 - 0.1, y, z + dz * r * 0.65 - 0.1, x + dx * r * 0.65 + 0.1, y + 1.6, z + dz * r * 0.65 + 0.1, PALETTE.steel);
  mb.box(x - r * 0.8, y + 1.5, z - r * 0.8, x + r * 0.8, y + 1.65, z + r * 0.8, PALETTE.steel);
  mb.cylinder(x, z, y + 1.65, y + 4.4, r, 12, body);
  for (const by of [2.3, 3.4]) mb.cylinder(x, z, y + by, y + by + 0.1, r + 0.04, 12, band);
  mb.cylinder(x, z, y + 4.4, y + 5.4, r + 0.1, 12, PALETTE.roof[0], PALETTE.roof[0], 0.08);
}

// 店の看板：色の板と、文字に見える明るい線
function signBoard(mb: MeshBuilder, x0: number, x1: number, y: number, z: number, color: THREE.Color, rng: Rng) {
  mb.box(x0, y, z, x1, y + 0.8, z + 0.22, color);
  const w = x1 - x0, n = Math.max(2, Math.floor(w / 1.1));
  const lw = Math.min(0.75, (w * 0.7) / n);
  const start = x0 + (w - n * lw * 1.25) / 2;
  for (let k = 0; k < n; k++) {
    if (rng.next() < 0.15) continue;
    const lx = start + k * lw * 1.25;
    mb.box(lx, y + 0.2, z + 0.22, lx + lw, y + 0.6, z + 0.26, PALETTE.white);
  }
}

// しま模様の日よけ
function awning(mb: MeshBuilder, x0: number, x1: number, y: number, z: number, depth: number, a: THREE.Color, b: THREE.Color) {
  const n = Math.max(2, Math.round((x1 - x0) / 0.9));
  const sw = (x1 - x0) / n;
  for (let k = 0; k < n; k++) {
    const c = k % 2 ? a : b;
    const u0 = x0 + k * sw, u1 = u0 + sw;
    mb.quad([u0, y - 0.7, z + depth], [u1, y - 0.7, z + depth], [u1, y, z], [u0, y, z], c);
    mb.quad([u0, y - 0.7, z + depth], [u0, y, z], [u1, y, z], [u1, y - 0.7, z + depth], c);
    mb.quad([u0, y - 1.0, z + depth], [u1, y - 1.0, z + depth], [u1, y - 0.7, z + depth], [u0, y - 0.7, z + depth], c);
  }
}

// ---------------- 低層の店舗 ----------------
function lowShop(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, tier: number) {
  const r = rng.next();
  if (tier === 1 && f.W <= 16 && r < 0.25) return shop(mb, f, rng, tf, tier); // ガソリンスタンド
  if (f.W >= 30 && f.D >= 30 && tier >= 2 && r < 0.5) return supermarket(mb, f, rng, tf);
  if (f.W >= 28 && r < 0.6) return stripMall(mb, f, rng, tf);
  if (f.W <= 20 && r < 0.75) return mainStreetShop(mb, f, rng, tf, tier);
  if (r < 0.85) return cornerStore(mb, f, rng, tf);
  return shop(mb, f, rng, tf, tier);
}

// 商店街の2〜3階建て：1階は店、上は住まいや事務所。飾りのついた屋上のふち
function mainStreetShop(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, tier: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.09, PALETTE.pavement);
  const wall = rng.pick([PALETTE.brick, ...PALETTE.shopWall, C(0xe8dcc2)]);
  const trim = C(0xe9e4d6), accent = rng.pick(PALETTE.accent);
  const floors = 2 + (tier >= 2 && rng.next() < 0.5 ? 1 : 0);
  const g = 4.2, fh = 3.3, h = g + (floors - 1) * fh;
  const w = f.W - 1, z1 = f.D / 2 - 1.2, z0 = z1 - Math.min(f.D - 4, 14 + rng.next() * 6);
  mb.box(-w / 2, 0, z0, w / 2, g, z1, wall, PAT.shop, flatRoof());
  mb.box(-w / 2, g, z0, w / 2, h, z1, wall, PAT.house, flatRoof());
  // 1階と2階の境目の帯、屋上のふち（中央が高い）
  mb.box(-w / 2 - 0.1, g - 0.2, z1, w / 2 + 0.1, g + 0.3, z1 + 0.25, trim);
  mb.box(-w / 2, h, z1 - 0.35, w / 2, h + 1.0, z1, wall, PAT.none, trim);
  mb.box(-w / 6, h + 1.0, z1 - 0.35, w / 6, h + 1.8, z1, wall, PAT.none, trim);
  mb.box(-w / 2 - 0.15, h + 0.9, z1 - 0.4, w / 2 + 0.15, h + 1.1, z1 + 0.15, trim);
  roofRim(mb, -w / 2, z0, w / 2, z1 - 0.35, h, wall, 0.7);
  signBoard(mb, -w / 2 + 0.8, w / 2 - 0.8, g - 1.3, z1, accent, rng);
  if (rng.next() < 0.7) awning(mb, -w / 2 + 0.6, w / 2 - 0.6, g - 1.4, z1, 1.4, accent, PALETTE.white);
  roofUnits(mb, -w / 2 + 0.5, z0 + 0.5, w / 2 - 0.5, z1 - 1, h, rng, 1 + rng.int(2));
  if (rng.next() < 0.3) waterTank(mb, -w / 4, z0 + 3, h, 1.2, rng);
  // 裏の小さな駐車場
  mb.ground(-f.W / 2 + 0.5, -f.D / 2 + 0.5, f.W / 2 - 0.5, z0 - 0.5, 0.1, PALETTE.asphalt);
  void tf;
}

// テナントが並ぶ平屋の商店街：区画ごとに看板の色が違う。前に駐車場
function stripMall(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.asphalt);
  const wall = rng.pick([C(0xd9cdb4), C(0xc8b89a), C(0xe3ddd0), C(0xb5a38a)]);
  const w = f.W - 3, d = Math.min(14, f.D * 0.42);
  const z0 = -f.D / 2 + 1.5, z1 = z0 + d, h = 5.2;
  mb.box(-w / 2, 0, z0, w / 2, h, z1, wall, PAT.shop, flatRoof());
  roofRim(mb, -w / 2, z0, w / 2, z1, h, wall, 0.8);
  // 屋根つきの通路（柱）
  mb.box(-w / 2, h - 1.2, z1, w / 2, h - 0.8, z1 + 3, C(0xe9e4d6));
  for (let x = -w / 2 + 0.3; x <= w / 2; x += 6) mb.box(x - 0.2, 0, z1 + 2.6, x + 0.2, h - 1.2, z1 + 3, C(0xe9e4d6));
  // テナントの看板と、中央の高い看板壁
  const units = Math.max(3, Math.round(w / 8)), uw = w / units;
  for (let k = 0; k < units; k++) {
    const x0 = -w / 2 + k * uw;
    signBoard(mb, x0 + 0.8, x0 + uw - 0.8, h - 0.75, z1 + 3, rng.pick(PALETTE.accent), rng);
  }
  mb.box(-5, h, z1 - 0.4, 5, h + 2.4, z1, wall, PAT.none, C(0xe9e4d6));
  // 駐車場の白線と、道路沿いの看板の柱
  stalls(mb, rng, -f.W / 2 + 2, f.W / 2 - 2, 2.7, z1 + 5, z1 + 10, 0.6);
  stalls(mb, rng, -f.W / 2 + 2, f.W / 2 - 2, 2.7, f.D / 2 - 6.5, f.D / 2 - 1.5, 0.45);
  mb.box(f.W / 2 - 3, 0, f.D / 2 - 1.5, f.W / 2 - 2.6, 6, f.D / 2 - 1.1, PALETTE.steel);
  mb.box(f.W / 2 - 4.5, 6, f.D / 2 - 1.5, f.W / 2 - 1.1, 8.5, f.D / 2 - 1.1, rng.pick(PALETTE.accent));
  tf(-f.W / 2 + 1.5, f.D / 2 - 1.5, 0.8);
}

// 大型スーパー：大きな箱と、ガラスの入口、カート置き場、大きな駐車場
function supermarket(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.asphalt);
  const wall = rng.pick([C(0xe6e1d6), C(0xd2c7b3), C(0xc9ccd0)]), accent = rng.pick(PALETTE.accent);
  const w = f.W - 4, d = Math.min(f.D * 0.55, 30);
  const z0 = -f.D / 2 + 2, z1 = z0 + d, h = 8;
  mb.box(-w / 2, 0, z0, w / 2, h, z1, wall, PAT.dock, flatRoof());
  roofRim(mb, -w / 2, z0, w / 2, z1, h, wall, 0.9);
  // 入口（ガラス）とひさし、ロゴの帯
  mb.box(-7, 0, z1, 7, 5.5, z1 + 2.5, PALETTE.glass, PAT.shop, wall);
  mb.box(-8, 5.5, z1, 8, 6.2, z1 + 3.5, accent);
  signBoard(mb, -6, 6, 6.6, z1, accent, rng);
  // 屋上の天窓の列と室外機
  for (let x = -w / 2 + 4; x < w / 2 - 4; x += 6) mb.box(x, h, z0 + 4, x + 2.5, h + 0.4, z1 - 4, PALETTE.glass);
  roofUnits(mb, -w / 2 + 1, z0 + 1, w / 2 - 1, z0 + 4, h, rng, 4);
  // 駐車場
  for (let x = -f.W / 2 + 2; x < f.W / 2 - 2; x += 2.7) {
    mb.ground(x, z1 + 6, x + 0.14, z1 + 11, 0.12, PALETTE.white);
    if (x + 2.7 < f.W / 2 - 2 && rng.next() < 0.65) parkedCar(mb, x + 1.42, z1 + 6, z1 + 11, rng);
    if (z1 + 18 < f.D / 2 - 1) {
      mb.ground(x, z1 + 13, x + 0.14, z1 + 18, 0.12, PALETTE.white);
      if (x + 2.7 < f.W / 2 - 2 && rng.next() < 0.45) parkedCar(mb, x + 1.42, z1 + 13, z1 + 18, rng);
    }
  }
  mb.box(9, 0, z1 + 4, 11.5, 1.1, z1 + 5, PALETTE.steel); // カート置き場
  for (const x of [-f.W / 2 + 2, f.W / 2 - 2]) tf(x, f.D / 2 - 2, 0.8);
}

// コンビニ風の小さな店：大きなガラス窓と、屋根の上の看板
function cornerStore(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.asphalt);
  const accent = rng.pick(PALETTE.accent), wall = rng.pick([PALETTE.white, C(0xe9e4d6), C(0xd8dde2)]);
  const w = Math.min(f.W - 4, 14), d = Math.min(f.D - 8, 10);
  const z1 = f.D / 2 - 6, z0 = z1 - d, h = 4.2;
  mb.box(-w / 2, 0, z0, w / 2, h, z1, wall, PAT.shop, flatRoof());
  // 色の帯（2本）
  mb.box(-w / 2 - 0.05, h - 1.0, z0 - 0.05, w / 2 + 0.05, h - 0.6, z1 + 0.05, accent);
  mb.box(-w / 2 - 0.05, h - 0.55, z0 - 0.05, w / 2 + 0.05, h - 0.35, z1 + 0.05, rng.pick(PALETTE.accent));
  roofRim(mb, -w / 2, z0, w / 2, z1, h, wall, 0.5);
  roofUnits(mb, -w / 2 + 0.5, z0 + 0.5, w / 2 - 0.5, z1 - 0.5, h, rng, 2);
  // 前の駐車場
  stalls(mb, rng, -w / 2, w / 2, 2.7, z1 + 1, z1 + 5.5, 0.55);
  // 道路沿いの看板
  mb.box(f.W / 2 - 2.2, 0, f.D / 2 - 1.4, f.W / 2 - 1.9, 4.5, f.D / 2 - 1.1, PALETTE.steel);
  mb.box(f.W / 2 - 3.2, 4.5, f.D / 2 - 1.4, f.W / 2 - 0.9, 6.3, f.D / 2 - 1.1, accent);
  tf(-f.W / 2 + 1.5, -f.D / 2 + 1.5, 0.7);
}

function farm(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  // 畑の畝
  const crop = rng.pick(PALETTE.crop), crop2 = rng.pick(PALETTE.crop);
  const rows = Math.floor(f.W / 2.2);
  const hx = f.W / 2 - 0.4, hz = f.D / 2 - 0.4;
  const yardD = 14;
  for (let k = 0; k < rows; k++) {
    const x0 = -hx + k * 2.2;
    mb.ground(x0, -hz, x0 + 1.4, hz - yardD, 0.08, k % 2 ? crop : crop2);
    mb.ground(x0 + 1.4, -hz, x0 + 2.2, hz - yardD, 0.06, PALETTE.dirt);
  }
  // 農場の建物
  mb.ground(-hx, hz - yardD, hx, hz, 0.07, PALETTE.dirt);
  mb.box(-10, 0, hz - 12, -2, 6, hz - 4, PALETTE.barn, PAT.none);
  mb.gableX(-10, hz - 12, -2, hz - 4, 6, 3.5, PALETTE.roof[0], PALETTE.barn, 0.3);
  mb.box(-7, 0.05, hz - 4, -5, 4, hz - 3.95, PALETTE.white);
  mb.cylinder(2, hz - 9, 0, 13, 2.2, 10, PALETTE.steel);
  mb.cylinder(2, hz - 9, 13, 14.5, 2.2, 10, PALETTE.steel, PALETTE.steel, 0.3);
  if (f.W > 40) mb.cylinder(7, hz - 9, 0, 11, 1.8, 10, PALETTE.concrete, PALETTE.concrete);
  house(mb, 9, hz - 6, 7, 6, 1, rng.pick(PALETTE.houseWall), rng.pick(PALETTE.roof), rng);
  tf(13, hz - 3, 1.2);
  tf(-13, hz - 2, 1.0);
}

function construction(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.5, -f.D / 2 + 0.5, f.W / 2 - 0.5, f.D / 2 - 0.5, 0.08, PALETTE.dirt);
  const w = f.W - 6, d = f.D - 7;
  const h = 3 + rng.next() * 4;
  mb.box(-w / 2, 0, -d / 2, w / 2, h, d / 2, PALETTE.concrete);
  // 足場
  const step = 2.5;
  for (let x = -w / 2 - 0.8; x <= w / 2 + 0.8; x += step) {
    mb.box(x, 0, d / 2 + 0.6, x + 0.15, h + 2, d / 2 + 0.75, PALETTE.wood);
    mb.box(x, 0, -d / 2 - 0.75, x + 0.15, h + 2, -d / 2 - 0.6, PALETTE.wood);
  }
  mb.box(-w / 2 - 0.8, h + 1.8, d / 2 + 0.6, w / 2 + 0.8, h + 2, d / 2 + 0.75, PALETTE.wood);
  mb.box(-w / 2 - 0.8, h + 1.8, -d / 2 - 0.75, w / 2 + 0.8, h + 2, -d / 2 - 0.6, PALETTE.wood);
  // クレーン
  if (f.W * f.D >= 512) {
    const cy = h + 14;
    mb.box(-w / 2 + 1, 0, -d / 2 + 1, -w / 2 + 1.8, cy, -d / 2 + 1.8, PALETTE.accent[3]);
    mb.box(-w / 2 - 4, cy, -d / 2 + 1, -w / 2 + 16, cy + 0.8, -d / 2 + 1.8, PALETTE.accent[3]);
  }
}

function coalPlant(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.3, -f.D / 2 + 0.3, f.W / 2 - 0.3, f.D / 2 - 0.3, 0.08, PALETTE.concrete);
  mb.box(-24, 0, -6, 6, 18, 16, PALETTE.indWall[1], PAT.industrial, PALETTE.steel);
  mb.box(-20, 18, -4, -2, 28, 10, PALETTE.indWall[0], PAT.industrial, PALETTE.steel);
  mb.cylinder(14, -14, 0, 60, 3.2, 14, PALETTE.white, PALETTE.dark, 2.4);
  mb.cylinder(14, -14, 50, 56, 2.65, 14, PALETTE.accent[0], undefined, 2.5);
  mb.cylinder(22, -4, 0, 55, 3, 14, PALETTE.white, PALETTE.dark, 2.3);
  mb.cylinder(22, -4, 46, 51, 2.5, 14, PALETTE.accent[0], undefined, 2.4);
  // 石炭の山
  mb.hip(-26, -28, -4, -14, 0, 5, PALETTE.dark, 0);
  mb.hip(-2, -28, 12, -18, 0, 4, PALETTE.dark, 0);
  // ベルトコンベア
  mb.quad([-8, 1, -14], [-6, 1, -14], [-6, 14, -6], [-8, 14, -6], PALETTE.steel);
  // 変電所
  for (let x = 10; x < 28; x += 4) for (let z = 10; z < 26; z += 5) mb.box(x, 0, z, x + 0.4, 6, z + 0.4, PALETTE.steel);
}

function gasPlant(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.3, -f.D / 2 + 0.3, f.W / 2 - 0.3, f.D / 2 - 0.3, 0.08, PALETTE.concrete);
  mb.box(-18, 0, -2, 8, 14, 14, PALETTE.indWall[2], PAT.industrial, PALETTE.steel);
  mb.cylinder(-12, -12, 0, 32, 1.8, 10, PALETTE.steel, PALETTE.dark);
  mb.cylinder(-4, -12, 0, 32, 1.8, 10, PALETTE.steel, PALETTE.dark);
  mb.cylinder(14, -10, 0, 9, 6, 16, PALETTE.white, PALETTE.white);
  mb.cylinder(14, 8, 0, 9, 5, 16, PALETTE.white, PALETTE.white);
}

function oilPlant(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.3, -f.D / 2 + 0.3, f.W / 2 - 0.3, f.D / 2 - 0.3, 0.08, PALETTE.concrete);
  mb.box(-26, 0, -4, 4, 16, 18, PALETTE.indWall[3], PAT.industrial, PALETTE.steel);
  mb.box(-22, 16, 0, -6, 24, 12, PALETTE.indWall[1], PAT.industrial, PALETTE.steel);
  mb.cylinder(16, 14, 0, 48, 2.6, 14, PALETTE.indWall[0], PALETTE.dark, 2.0);
  mb.cylinder(16, 14, 40, 44, 2.2, 14, PALETTE.accent[0], undefined, 2.1);
  // 石油のタンク
  for (const [x, z] of [[-18, -20], [-4, -20], [10, -20], [22, -6]]) {
    mb.cylinder(x, z, 0, 9, 5.5, 18, PALETTE.white, PALETTE.indWall[0]);
    mb.cylinder(x, z, 0, 1.2, 6.2, 18, PALETTE.concrete, PALETTE.concrete);
  }
  mb.box(-24, 2, -13, 24, 2.6, -12.4, PALETTE.steel); // 配管
}

function nuclearPlant(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.3, -f.D / 2 + 0.3, f.W / 2 - 0.3, f.D / 2 - 0.3, 0.08, PALETTE.concrete);
  mb.ground(-f.W / 2 + 2, -f.D / 2 + 2, f.W / 2 - 2, -f.D / 2 + 4, 0.1, PALETTE.lawn); // 植え込み
  // 冷却塔（くびれた形）
  for (const [x, z] of [[-20, -18], [6, -20]]) {
    const tw = C(0xe6e3da);
    mb.cylinder(x, z, 0, 22, 13, 24, tw, undefined, 9.5);
    mb.cylinder(x, z, 22, 34, 9.5, 24, tw, undefined, 9);
    mb.cylinder(x, z, 34, 43, 9, 24, tw, undefined, 10.2);
    mb.cylinder(x, z, 43, 44, 10.2, 24, C(0xbdb8ac), C(0x4a4c50), 10.2);
  }
  // 原子炉の建屋（円筒と丸い屋根）
  mb.cylinder(18, 18, 0, 20, 10, 24, PALETTE.white, undefined);
  mb.dome(18, 18, 20, 10, 8.6, PALETTE.white, 32, 10);
  // タービン建屋と事務所
  mb.box(-30, 0, 6, 4, 14, 28, PALETTE.indWall[1], PAT.industrial, PALETTE.steel);
  mb.box(-30, 0, 30, -12, 8, 37, PALETTE.white, PAT.office, PALETTE.roof[3]);
  mb.box(5, 0, 26, 7, 10, 28, PALETTE.steel);
}

// 冷却塔（双曲線の形）。設計図（160×128m）での位置と大きさ。湯気の位置は propsLayer でも使う
export const COOLING_TOWERS = { H: 118, R: 31, pos: [[-47, -32], [47, -32]] as [number, number][] };
export const bigNuclearScale = (W: number, D: number) => Math.min(W / 160, D / 128);

// 大型の原子力発電所（原子炉2基）。sea = 臨海型（冷却塔なし、奥（-z）が水辺）。設計図は 160×128m で、敷地に合わせて縮める
function bigNuclear(mb: MeshBuilder, f: LotFrame, tf: TF, sea: boolean) {
  const k = bigNuclearScale(f.W, f.D);
  const white = C(0xf2f1ec), lightBlue = C(0xb9d3e6), grey = C(0x9da3a8), dark = C(0x5c636a), glow = C(0xfff3d0);
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color, pat: number = PAT.none, roof?: THREE.Color) => mb.box(x0 * k, y0 * k, z0 * k, x1 * k, y1 * k, z1 * k, c, pat, roof);
  const gnd = (x0: number, z0: number, x1: number, z1: number, y: number, c: THREE.Color) => mb.ground(x0 * k, z0 * k, x1 * k, z1 * k, y, c);
  const cyl = (x: number, z: number, y0: number, y1: number, r0: number, c: THREE.Color, top?: THREE.Color, r1 = r0, seg = 32) => mb.cylinder(x * k, z * k, y0 * k, y1 * k, r0 * k, seg, c, top, r1 * k);
  mb.ground(-f.W / 2 + 0.3, -f.D / 2 + 0.3, f.W / 2 - 0.3, f.D / 2 - 0.3, 0.08, PALETTE.concrete);
  // 構内道路
  gnd(-74, 36, 74, 40, 0.1, PALETTE.asphalt);
  gnd(-3, -60, 3, 62, 0.1, PALETTE.asphalt);
  // 二重のフェンスと、正面の警備ゲート
  for (const ins of [1.5, 3.5]) {
    const x0 = -80 + ins, x1 = 80 - ins, z0 = -64 + ins, z1 = 64 - ins;
    box(x0, 0, z0, x1, 2.6, z0 + 0.12, grey);
    box(x0, 0, z0, x0 + 0.12, 2.6, z1, grey);
    box(x1 - 0.12, 0, z0, x1, 2.6, z1, grey);
    box(x0, 0, z1 - 0.12, -6, 2.6, z1, grey);
    box(6, 0, z1 - 0.12, x1, 2.6, z1, grey);
  }
  box(7, 0, 54, 14, 3.5, 59, white, PAT.office, PALETTE.roof[3]); // 詰所
  box(-6, 3.6, 56, 6, 4.1, 61, dark); // ゲートの屋根
  box(-5.5, 0, 59.5, 5.5, 1.1, 59.9, C(0xd9a400)); // 遮断機
  // 事務棟と駐車場（正面の左）
  box(-74, 0, 46, -42, 13, 58, white, PAT.office, PALETTE.roof[3]);
  gnd(-38, 46, -10, 58, 0.11, PALETTE.asphalt);
  for (let x = -37; x < -11; x += 2.6) gnd(x, 46, x + 0.12, 51, 0.13, PALETTE.white);
  if (!sea) {
    // ---- 内陸型：ドームの原子炉2基、真ん中にタービン建屋、奥に巨大な冷却塔2本 ----
    for (const sx of [-1, 1]) {
      const rx = sx * 46, rz = 18;
      cyl(rx, rz, 0, 38, 16, white);
      mb.dome(rx * k, rz * k, 38 * k, 16 * k, 16.5 * k, white, 40, 12);
      box(rx + sx * 16, 0, rz - 8, rx + sx * 24, 26, rz + 8, grey, PAT.industrial, PALETTE.steel); // 補助建屋
    }
    box(-25, 0, 4, 25, 26, 32, lightBlue, PAT.industrial, PALETTE.steel); // タービン建屋
    box(-25.1, 23, 3.9, 25.1, 24, 32.1, dark);
    // 冷却塔：根元が広く、上の 4 分の 3 でくびれ、上でまた少し広がる
    const { H, R } = COOLING_TOWERS;
    const rad = (t: number) => (t <= 0.75 ? R * (0.62 + 0.38 * ((0.75 - t) / 0.75) ** 2) : R * (0.62 + 0.1 * ((t - 0.75) / 0.25)));
    for (const [x, z] of COOLING_TOWERS.pos) {
      const tw = C(0xe9e6de), band = C(0xd2cdc0);
      const RINGS = 28;
      for (let s2 = 0; s2 < RINGS; s2++) {
        const t0 = s2 / RINGS, t1 = (s2 + 1) / RINGS;
        cyl(x, z, t0 * H, t1 * H, rad(t0), s2 === 18 ? band : tw, undefined, rad(t1), 48);
      }
      cyl(x, z, H, H + 0.7, rad(1), band, C(0x3e4044), rad(1) - 1.4);
      cyl(x, z, -0.5, 3.5, R + 0.8, C(0xb9b4a8), undefined, R);
    }
  } else {
    // ---- 臨海型：角型の原子炉建屋2基（上部は明るい色）、海側にタービン建屋、排気筒、取水口と防潮堤 ----
    for (const sx of [-1, 1]) {
      const rx = sx * 36, rz = 14;
      box(rx - 21, 0, rz - 19, rx + 21, 46, rz + 19, white, PAT.industrial, white);
      box(rx - 21.2, 34, rz - 19.2, rx + 21.2, 46, rz + 19.2, lightBlue, PAT.none, lightBlue);
      box(rx - 21.3, 46, rz - 19.3, rx + 21.3, 47, rz + 19.3, dark);
      box(rx - 24, 0, -50, rx + 24, 28, -8, C(0xdfe7ee), PAT.industrial, PALETTE.steel); // タービン建屋
      box(rx - 24.1, 26, -50.1, rx + 24.1, 27, -7.9, C(0x4f7fae));
    }
    // 排気筒（紅白の筒と、支える鉄塔）
    const sh = 120;
    for (let s2 = 0; s2 < 8; s2++) cyl(0, 14, (s2 * sh) / 8, ((s2 + 1) * sh) / 8, 2.2, s2 % 2 ? C(0xd23a3a) : white, s2 === 7 ? dark : undefined, 2.2, 12);
    for (const [px, pz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) box(px - 0.3, 0, 14 + pz - 0.3, px + 0.3, sh * 0.85, 14 + pz + 0.3, grey);
    // 取水口（奥の水辺へのびる水路）と防潮堤
    gnd(-12, -96, 12, -54, 0.05, PALETTE.water);
    for (const sx of [-1, 1]) box(sx * 12 - 1.5, -5, -100, sx * 12 + 1.5, 2.2, -54, PALETTE.concrete);
    box(-80, -5, -68, 80, 4, -63, PALETTE.concrete);
  }
  // 変電所（正面の右）と送電鉄塔
  gnd(30, 42, 74, 60, 0.11, C(0x8a8378));
  for (let x = 34; x < 72; x += 7)
    for (let z = 50; z < 59; z += 7) {
      box(x - 0.25, 0, z - 0.25, x + 0.25, 9, z + 0.25, grey);
      box(x - 2.5, 8.5, z - 0.15, x + 2.5, 8.8, z + 0.15, grey);
      box(x - 0.8, 0, z - 4.2, x + 0.8, 3, z - 2.5, dark); // 変圧器
    }
  for (const px of [38, 66]) {
    const pz = 43;
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(px + ox - 0.25, 0, pz + oz - 0.25, px + ox + 0.25, 46, pz + oz + 0.25, grey);
    for (const y of [30, 37, 44]) box(px - 7, y, pz - 0.3, px + 7, y + 0.6, pz + 0.3, grey);
  }
  // 夜の照明（構内の照明塔。上が光る）
  for (const [x, z] of [[-74, -58], [74, -58], [-74, 34], [74, 34], [0, -8]]) {
    box(x - 0.3, 0, z - 0.3, x + 0.3, 24, z + 0.3, grey);
    box(x - 1.6, 24, z - 0.6, x + 1.6, 25.2, z + 0.6, glow, PAT.glow);
  }
  tf(-70 * k, 62 * k, 1.0);
  tf(-50 * k, 62 * k, 1.0);
  tf(70 * k, 62 * k, 1.0);
}

function windTurbine(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  void f;
  mb.ground(-7.5, -7.5, 7.5, 7.5, 0.08, PALETTE.lawn);
  mb.cylinder(0, 0, 0, 1, 3, 12, PALETTE.concrete, PALETTE.concrete);
  mb.cylinder(0, 0, 1, 42, 1.3, 12, PALETTE.white, undefined, 0.7);
  mb.box(-1.2, 41.2, -3.5, 1.2, 43.6, 2, PALETTE.white);
  // 羽根（3枚、正面は -z 向き）。両面から見えるように裏表を作る
  const hub: [number, number, number] = [0, 42.4, -3.8];
  const rot = rng.next() * Math.PI * 2;
  for (let k = 0; k < 3; k++) {
    const a = rot + (k * Math.PI * 2) / 3;
    const ux = Math.cos(a), uy = Math.sin(a), px = -uy * 0.9, py = ux * 0.9;
    const L = 19;
    const p0: [number, number, number] = [hub[0] + px, hub[1] + py, hub[2]];
    const p1: [number, number, number] = [hub[0] - px, hub[1] - py, hub[2]];
    const p2: [number, number, number] = [hub[0] + ux * L - px * 0.3, hub[1] + uy * L - py * 0.3, hub[2]];
    const p3: [number, number, number] = [hub[0] + ux * L + px * 0.3, hub[1] + uy * L + py * 0.3, hub[2]];
    mb.quad(p0, p1, p2, p3, PALETTE.white);
    mb.quad(p3, p2, p1, p0, PALETTE.white);
  }
  mb.cylinder(0, -3.8, 41.6, 43.2, 0.9, 10, PALETTE.white, PALETTE.white);
}

function solarFarm(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.3, -f.D / 2 + 0.3, f.W / 2 - 0.3, f.D / 2 - 0.3, 0.08, C(0x8c9a6a));
  const panel = C(0x1d3557), frame = C(0xaab4be);
  // 南（+z）向きに傾けたパネルの列
  for (let z = -f.D / 2 + 4; z < f.D / 2 - 4; z += 5.2) {
    for (let x = -f.W / 2 + 2.5; x < f.W / 2 - 2.5; x += 9.5) {
      const x1 = Math.min(f.W / 2 - 2.5, x + 9);
      const a: [number, number, number] = [x, 2.4, z], b: [number, number, number] = [x1, 2.4, z];
      const c: [number, number, number] = [x1, 0.7, z + 3.2], d: [number, number, number] = [x, 0.7, z + 3.2];
      mb.quad(d, c, b, a, panel);
      mb.quad(a, b, c, d, frame);
      mb.box(x + 0.3, 0, z + 0.2, x + 0.6, 2.4, z + 0.5, frame);
      mb.box(x1 - 0.6, 0, z + 0.2, x1 - 0.3, 2.4, z + 0.5, frame);
    }
  }
  mb.box(f.W / 2 - 9, 0, -f.D / 2 + 1, f.W / 2 - 2, 3.5, -f.D / 2 + 4, PALETTE.indWall[4], PAT.industrial, PALETTE.steel); // 変電設備
}

function pump(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.3, -f.D / 2 + 0.3, f.W / 2 - 0.3, f.D / 2 - 0.3, 0.08, PALETTE.lawn);
  mb.box(-8, 0, 2, 4, 5, 10, PALETTE.indWall[4], PAT.industrial, PALETTE.roof[3]);
  mb.cylinder(6, -6, 0, 6, 6, 16, PALETTE.indWall[0], PALETTE.steel);
  mb.box(-4, 0.5, -8, 6, 1.5, -7, PALETTE.steel);
  mb.box(-5, 0.5, -8, -4, 1.5, 2, PALETTE.steel);
}

function waterTower(mb: MeshBuilder, f: LotFrame) {
  void f;
  mb.ground(-7, -7, 7, 7, 0.08, PALETTE.lawn);
  for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) mb.box(x - 0.3, 0, z - 0.3, x + 0.3, 16, z + 0.3, PALETTE.steel);
  mb.cylinder(0, 0, 16, 23, 5, 16, PALETTE.indWall[0], undefined);
  mb.cylinder(0, 0, 23, 26, 5, 16, PALETTE.indWall[0], PALETTE.indWall[0], 0.5);
}

function park(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, large: boolean) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.lawn2);
  // 小道
  mb.ground(-1, -f.D / 2 + 0.2, 1, f.D / 2 - 0.2, 0.11, PALETTE.pavement);
  mb.ground(-f.W / 2 + 0.2, -1, f.W / 2 - 0.2, 1, 0.11, PALETTE.pavement);
  if (large) {
    // 池と東屋
    mb.ground(-f.W / 2 + 4, -f.D / 2 + 4, -4, -4, 0.12, PALETTE.water);
    mb.box(8, 0, 8, 14, 3, 14, PALETTE.white, PAT.none);
    mb.hip(8, 8, 14, 14, 3, 2, PALETTE.roof[1]);
    for (let k = 0; k < 18; k++) {
      const x = -f.W / 2 + 2 + rng.next() * (f.W - 4), z = -f.D / 2 + 2 + rng.next() * (f.D - 4);
      if (Math.abs(x) < 2 || Math.abs(z) < 2) continue;
      if (x < -3 && z < -3) continue;
      tf(x, z, 0.9 + rng.next() * 0.7, rng.next() < 0.3 ? 1 : 0);
    }
  } else {
    mb.cylinder(0, 0, 0, 0.6, 1.6, 12, PALETTE.white, PALETTE.water);
    for (const [x, z] of [[-4.5, -4.5], [4.5, -4.5], [-4.5, 4.5], [4.5, 4.5]]) tf(x, z, 0.8 + rng.next() * 0.4);
  }
  // ベンチ
  mb.box(1.5, 0, 3, 2.2, 0.5, 5, PALETTE.wood);
  mb.box(-2.2, 0, -5, -1.5, 0.5, -3, PALETTE.wood);
}

function plaza(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.09, PALETTE.pavement);
  mb.cylinder(0, 0, 0, 0.8, 4, 16, PALETTE.white, PALETTE.water);
  mb.cylinder(0, 0, 0.8, 3, 0.4, 8, PALETTE.white, PALETTE.white);
  for (const [x, z] of [[-10, -10], [10, -10], [-10, 10], [10, 10], [0, -11], [0, 11], [-11, 0], [11, 0]]) {
    mb.box(x - 1.2, 0, z - 1.2, x + 1.2, 0.6, z + 1.2, PALETTE.concrete);
    tf(x, z, 0.8 + rng.next() * 0.3);
  }
}


// ---- 細長い公園：a = 長い辺の方向、c = 短い辺の方向で書き、敷地の向きに合わせて x, z に直す ----
function longAxis(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const alongX = f.W >= f.D;
  const A = alongX ? f.W : f.D, Cw = alongX ? f.D : f.W;
  const P = (a: number, c: number): [number, number] => (alongX ? [a, c] : [c, a]);
  const box = (a0: number, y0: number, c0: number, a1: number, y1: number, c1: number, col: THREE.Color, pat: number = PAT.none, roof?: THREE.Color) => {
    const [x0, z0] = P(a0, c0), [x1, z1] = P(a1, c1);
    mb.box(Math.min(x0, x1), y0, Math.min(z0, z1), Math.max(x0, x1), y1, Math.max(z0, z1), col, pat, roof);
  };
  const ground = (a0: number, c0: number, a1: number, c1: number, y: number, col: THREE.Color) => {
    const [x0, z0] = P(a0, c0), [x1, z1] = P(a1, c1);
    mb.ground(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), y, col);
  };
  const tree = (a: number, c: number, sc = 1, kind = 0) => { const [x, z] = P(a, c); tf(x, z, sc, kind); };
  const cyl = (a: number, c: number, y0: number, y1: number, r: number, col: THREE.Color, top?: THREE.Color) => { const [x, z] = P(a, c); mb.cylinder(x, z, y0, y1, r, 10, col, top); };
  // 頂点ごとの法線つきの面（a, y, c の座標）。向きを入れ替えると裏返るので、そのときは順番を逆にする
  type V3 = [number, number, number];
  const map = (v: V3): V3 => { const [x, z] = P(v[0], v[2]); return [x, v[1], z]; };
  const quadN = (p0: V3, p1: V3, p2: V3, p3: V3, n0: V3, n1: V3, n2: V3, n3: V3, col: THREE.Color, pat = 0) => {
    if (alongX) mb.quadN(map(p0), map(p1), map(p2), map(p3), map(n0), map(n1), map(n2), map(n3), col, pat);
    else mb.quadN(map(p0), map(p3), map(p2), map(p1), map(n0), map(n3), map(n2), map(n1), col, pat);
  };
  return { A, Cw, box, ground, tree, cyl, quadN };
}
const bench = (L: ReturnType<typeof longAxis>, a: number, c: number) => {
  L.box(a - 0.9, 0, c - 0.25, a + 0.9, 0.45, c + 0.25, PALETTE.wood);
  L.box(a - 0.9, 0.45, c + 0.15, a + 0.9, 0.9, c + 0.25, PALETTE.wood);
};
const lampPost = (L: ReturnType<typeof longAxis>, a: number, c: number) => {
  L.box(a - 0.08, 0, c - 0.08, a + 0.08, 3.6, c + 0.08, PALETTE.dark);
  L.box(a - 0.25, 3.6, c - 0.25, a + 0.25, 3.9, c + 0.25, PALETTE.white);
};

// 遊び場（1×2）：砂場、ブランコ、すべり台、ジャングルジム
function playground(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  const L = longAxis(mb, f, tf);
  const A = L.A / 2, Cw = L.Cw / 2;
  L.ground(-A + 0.2, -Cw + 0.2, A - 0.2, Cw - 0.2, 0.08, PALETTE.lawn2);
  L.ground(-A + 3, -Cw + 2.5, A - 3, Cw - 2.5, 0.1, C(0xc9b48a)); // 砂地
  L.ground(-A + 0.2, Cw - 2, A - 0.2, Cw - 0.6, 0.11, PALETTE.pavement);
  // ブランコ
  const red = C(0xd0453a), blue = C(0x3a78c8), yellow = C(0xf0c030);
  for (const a of [-A + 4, -A + 9]) for (const c of [-0.9, 0.9]) L.box(a - 0.08, 0, c - 0.08, a + 0.08, 2.6, c + 0.08, red);
  L.box(-A + 4, 2.5, -0.08, -A + 9, 2.65, 0.08, red);
  for (const a of [-A + 5.6, -A + 7.4]) {
    for (const c of [-0.25, 0.25]) L.box(a - 0.03, 0.6, c - 0.03, a + 0.03, 2.5, c + 0.03, PALETTE.steel);
    L.box(a - 0.25, 0.5, -0.3, a + 0.25, 0.6, 0.3, PALETTE.dark);
  }
  // すべり台
  L.box(1, 0, -1, 2.4, 2.2, 0.4, blue);
  L.box(2.4, 0, -0.9, 6, 0.2, 0.3, yellow);
  L.box(2.4, 0.2, -0.9, 3.6, 1.6, 0.3, yellow);
  L.box(3.6, 0.2, -0.9, 4.8, 0.9, 0.3, yellow);
  // ジャングルジム
  for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) L.box(A - 8 + i * 1.3 - 0.06, 0, -1.3 + j * 1.3 - 0.06, A - 8 + i * 1.3 + 0.06, 2.6, -1.3 + j * 1.3 + 0.06, blue);
  for (const y of [1.3, 2.6]) L.box(A - 8, y - 0.06, -1.3, A - 5.4, y + 0.06, 1.3, blue);
  bench(L, -A + 3, Cw - 3);
  bench(L, A - 4, Cw - 3);
  // 低い柵と木
  L.box(-A + 0.3, 0, -Cw + 0.3, A - 0.3, 0.8, -Cw + 0.45, PALETTE.wood);
  for (const a of [-A + 1.8, A - 1.8]) L.tree(a, -Cw + 2, 0.8 + rng.next() * 0.4);
  L.tree(0, -Cw + 2, 0.9);
}

// 緑道（1×3）：まっすぐな遊歩道と並木、ベンチと街灯
function greenway(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  const L = longAxis(mb, f, tf);
  const A = L.A / 2, Cw = L.Cw / 2;
  L.ground(-A + 0.2, -Cw + 0.2, A - 0.2, Cw - 0.2, 0.08, PALETTE.lawn2);
  L.ground(-A + 0.2, -1.6, A - 0.2, 1.6, 0.11, C(0xb9a98c)); // 遊歩道
  L.ground(-A + 0.2, -1.75, A - 0.2, -1.6, 0.12, PALETTE.concrete);
  L.ground(-A + 0.2, 1.6, A - 0.2, 1.75, 0.12, PALETTE.concrete);
  // 花壇
  const flowers = [0xd9534f, 0xf0ad4e, 0xe78fb3, 0xf5f0e1].map(C);
  for (let a = -A + 4; a < A - 3; a += 8) L.ground(a, -Cw + 1.2, a + 3, -Cw + 3, 0.14, rng.pick(flowers));
  for (let a = -A + 3; a < A - 1; a += 6) {
    L.tree(a, 4.2, 0.85 + rng.next() * 0.35, rng.next() < 0.2 ? 1 : 0);
    L.tree(a + 3, -4.2, 0.85 + rng.next() * 0.35);
  }
  for (let a = -A + 6; a < A - 4; a += 12) { bench(L, a, 2.4); lampPost(L, a + 6, -2.3); }
}

// 運動場（2×3）：サッカー場とテニスコート、小さなクラブハウス
function sportsPark(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  const L = longAxis(mb, f, tf);
  const A = L.A / 2, Cw = L.Cw / 2;
  const line = PALETTE.white;
  L.ground(-A + 0.2, -Cw + 0.2, A - 0.2, Cw - 0.2, 0.08, PALETTE.lawn);
  // サッカー場（縞の芝）
  const fa0 = -A + 2, fa1 = A - 15, fc0 = -Cw + 2, fc1 = Cw - 2;
  const stripe = C(0x5f9a45);
  for (let a = fa0, k = 0; a < fa1; a += 3, k++) if (k % 2) L.ground(a, fc0, Math.min(fa1, a + 3), fc1, 0.1, stripe);
  const w = 0.12, Y = 0.13;
  L.ground(fa0, fc0, fa1, fc0 + w, Y, line); L.ground(fa0, fc1 - w, fa1, fc1, Y, line);
  L.ground(fa0, fc0, fa0 + w, fc1, Y, line); L.ground(fa1 - w, fc0, fa1, fc1, Y, line);
  const mid = (fa0 + fa1) / 2;
  L.ground(mid - w / 2, fc0, mid + w / 2, fc1, Y, line);
  for (const [a0, s] of [[fa0, 1], [fa1, -1]] as const) {
    const a1 = a0 + s * 4.5;
    L.ground(Math.min(a0, a1), -5, Math.max(a0, a1), -5 + w, Y, line);
    L.ground(Math.min(a0, a1), 5 - w, Math.max(a0, a1), 5, Y, line);
    L.ground(a1 - w / 2, -5, a1 + w / 2, 5, Y, line);
    // ゴール
    L.box(a0 - s * 0.1 - 0.05, 0, -2.5, a0 - s * 0.1 + 0.05, 2.2, -2.4, line);
    L.box(a0 - s * 0.1 - 0.05, 0, 2.4, a0 - s * 0.1 + 0.05, 2.2, 2.5, line);
    L.box(a0 - s * 0.1 - 0.05, 2.1, -2.5, a0 - s * 0.1 + 0.05, 2.2, 2.5, line);
  }
  // テニスコート
  const ta0 = A - 13, ta1 = A - 2, tc0 = -Cw + 2, tc1 = Cw - 9;
  L.ground(ta0, tc0, ta1, tc1, 0.1, C(0x3d7f6a));
  L.ground(ta0 + 1, tc0 + 1, ta1 - 1, tc1 - 1, 0.11, C(0x3f66a8));
  const tm = (tc0 + tc1) / 2;
  L.ground(ta0 + 1, tm - 0.05, ta1 - 1, tm + 0.05, 0.12, line);
  L.box(ta0 + 1, 0, tm - 0.04, ta1 - 1, 1.0, tm + 0.04, PALETTE.dark);
  // 金網
  for (let a = ta0; a <= ta1 + 0.01; a += (ta1 - ta0) / 4) for (const c of [tc0, tc1]) L.box(a - 0.06, 0, c - 0.06, a + 0.06, 3.2, c + 0.06, PALETTE.steel);
  L.box(ta0, 3.0, tc0 - 0.05, ta1, 3.2, tc0 + 0.05, PALETTE.steel);
  L.box(ta0, 3.0, tc1 - 0.05, ta1, 3.2, tc1 + 0.05, PALETTE.steel);
  // クラブハウス
  L.box(ta0 + 1, 0, Cw - 7.5, ta1 - 1, 3.4, Cw - 2, C(0xe6dfcf), PAT.house, flatRoof());
  L.tree(ta0 - 0.5, Cw - 2.5, 0.9);
  L.tree(-A + 1.5, -Cw + 1.5, 0.8 + rng.next() * 0.4);
}

// つなげられる大公園：模様はマップ全体で決まっているので、隣どうしで小道・池・芝生がつながる。
// 外周（隣が大公園でない辺）だけに石垣と並木を付ける。
const cpHash = (x: number, z: number) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const cpMeadow = (x: number, z: number) => Math.sin(x / 83 + 2.1) * Math.sin(z / 71 + 1.7);
// 小道の中心線：3マスおきに東西（j）・南北（i）へ、ゆるく曲がりながら続く
const pathZ = (x: number, j: number) => (3 * j + 1.5) * CELL + 9 * Math.sin(x / 41 + j * 1.9);
const pathX = (z: number, i: number) => (3 * i + 1.5) * CELL + 9 * Math.sin(z / 37 + i * 2.3);
const CP = {
  lawnSun: C(0x7fb054), lawn: C(0x6a9a46), lawn2: C(0x73a24c), forest: C(0x557d3a),
  path: C(0xb9b3a7), curb: C(0xdcd8cf), stone: C(0xc2baa9), stoneDark: C(0x8f887b),
  rock: [C(0x8d8a83), C(0x7a7771), C(0x9c978c)], reed: [C(0x7c8c45), C(0x95985a), C(0x6b7d3c)],
  pole: C(0x26332b), lamp: C(0xffe3a6), bench: C(0x8a5e3a), iron: C(0x2b2f2c),
  flowers: [C(0xd8475a), C(0xf2c94c), C(0xe58fb6), C(0xf7f3ea), C(0x9b6fd0)], bed: C(0x5b4632),
  boathouse: C(0xe9e4d8), roof: C(0x51605a), deck: C(0x8f6b45),
  boats: [C(0xf2f0ea), C(0xb9392f), C(0x2f6f8f), C(0x3e7a4a)],
};
function centralPark(mb: MeshBuilder, b: Building, f: LotFrame, trees: TreeSpot[], isCpark: (x: number, y: number) => boolean, pond?: PondBuilder) {
  // 世界座標で描く
  mb.setTransform(0, 0, f.base, 0);
  const X0 = b.x * CELL, Z0 = b.y * CELL, X1 = (b.x + b.w) * CELL, Z1 = (b.y + b.h) * CELL;
  const tree = (x: number, z: number, s: number, kind = 0) => trees.push({ x, y: f.base, z, s, kind });
  const lake = (x: number, z: number) => cpLake(x, z) > LAKE_T;
  const inside = (x: number, z: number, m = 0) => x > X0 + m && x < X1 - m && z > Z0 + m && z < Z1 - m;
  // 池と岸辺（なめらかな曲線の岸。水面は別のメッシュ）
  pond?.add(X0, Z0, X1, Z1, f.base + 0.13);
  // 芝生：日の当たる芝生広場は明るく、森の中は暗く、場所ごとに少しずつ色を変える
  const S = 4;
  const lawnAt = (x: number, z: number) => {
    // 芝生広場（明るい）→ ふつうの芝生 → 森の中（暗い）へ、なめらかに変わる。ところどころ少しむらがある
    const m = cpMeadow(x, z), w = 0.5 + 0.5 * Math.sin(x / 9.3 + z / 13.7) * Math.sin(z / 8.1 - x / 15.2);
    const c = m > 0.2 ? CP.lawn.clone().lerp(CP.lawnSun, Math.min(1, (m - 0.2) / 0.35)) : CP.lawn.clone().lerp(CP.forest, Math.min(1, (0.2 - m) / 0.5));
    return c.lerp(CP.lawn2, w * 0.35);
  };
  for (let z = Z0; z < Z1; z += S)
    for (let x = X0; x < X1; x += S) {
      // 隣の大公園とすき間なくつながるように、端まで敷く
      const xa = x, za = z, xb = Math.min(X1, x + S), zb = Math.min(Z1, z + S);
      mb.groundGrad(xa, za, xb, zb, 0.08, lawnAt(x, z), lawnAt(x + S, z), lawnAt(x + S, z + S), lawnAt(x, z + S));
    }
  // 小道：なめらかな帯の舗装路と縁石。池の上は石の橋になる（池の中ほど高く、アーチのように）
  const PW = 1.7, ST = 1.5;
  const flat = (a: number[], bb: number[], c: number[], d: number[], col: THREE.Color) => {
    const keep = mb.matOverride;
    mb.matOverride = MAT.ground;
    mb.quad(a as [number, number, number], bb as [number, number, number], c as [number, number, number], d as [number, number, number], col);
    mb.matOverride = keep;
  };
  const bridgeH = (x: number, z: number) => 0.14 + 1.1 * Math.max(0, Math.min(1, (cpLake(x, z) - (LAKE_T - 0.05)) / 0.12));
  const lamps: [number, number][] = [];
  // 交わるもう一方の小道の上かどうか
  const crossing = (x: number, z: number, horiz: boolean) => {
    if (horiz) { for (let i = Math.floor(x / (3 * CELL)) - 1; i <= Math.floor(x / (3 * CELL)) + 1; i++) if (Math.abs(x - pathX(z, i)) < PW + 0.6) return true; }
    else for (let j = Math.floor(z / (3 * CELL)) - 1; j <= Math.floor(z / (3 * CELL)) + 1; j++) if (Math.abs(z - pathZ(x, j)) < PW + 0.6) return true;
    return false;
  };
  const ribbon = (pt: (s: number) => [number, number], s0: number, s1: number, seed: number, horiz: boolean) => {
    // 点はマップ全体で同じ位置（ST おき）に取る。隣の公園と同じ点になり、つなぎ目で道がずれない
    const k0 = Math.floor(s0 / ST), k1 = Math.ceil(s1 / ST);
    let prev: { x: number; z: number; px: number; pz: number; h: number; skip: boolean } | null = null;
    // 池を渡る区間：短ければ石の橋、長ければ橋を架けずに小道は岸で終わる
    const wetS: [number, number][] = [];
    {
      let a = NaN;
      for (let s = s0 - 40; s <= s1 + 40; s += 0.5) {
        const [x, z] = pt(s), w = cpLake(x, z) > LAKE_T - 0.03;
        if (w && isNaN(a)) a = s;
        if (!w && !isNaN(a)) { wetS.push([a, s]); a = NaN; }
      }
      if (!isNaN(a)) wetS.push([a, s1 + 40]);
    }
    const inLongLake = (s: number) => wetS.some(([a, c]) => c - a > 20 && s > a - 1.5 && s < c + 1.5);
    for (let k = k0; k <= k1; k++) {
      const s = k * ST;
      const [x, z] = pt(s), [xa, za] = pt(s + 0.3);
      let tx = xa - x, tz = za - z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const cur = { x, z, px: -tz, pz: tx, h: bridgeH(x, z), skip: inLongLake(s) };
      // 区間のまん中が公園の中にあるものだけ描く（隣の公園の区間と少し重なって、すき間ができない）
      const mx = prev ? (prev.x + x) / 2 : x, mz = prev ? (prev.z + z) / 2 : z;
      const out = mx < X0 || mx > X1 || mz < Z0 || mz > Z1;
      if (prev && !out && !cur.skip && !prev.skip) {
        const P = (q: typeof cur, o: number, y: number) => [q.x + q.px * o, y, q.z + q.pz * o];
        const onBridge = prev.h > 0.2 || cur.h > 0.2;
        if (onBridge) {
          // 石の橋：床、側面、欄干
          flat(P(prev, -PW, prev.h), P(prev, PW, prev.h), P(cur, PW, cur.h), P(cur, -PW, cur.h), CP.stone);
          for (const o of [-PW, PW]) {
            const a = P(prev, o, prev.h), c = P(cur, o, cur.h);
            mb.quad(o < 0 ? [c[0], 0, c[2]] : [a[0], 0, a[2]], o < 0 ? [a[0], 0, a[2]] : [c[0], 0, c[2]], o < 0 ? (a as [number, number, number]) : (c as [number, number, number]), o < 0 ? (c as [number, number, number]) : (a as [number, number, number]), CP.stoneDark);
            const w = 0.22, hh = 0.75;
            const a0 = P(prev, o - Math.sign(o) * w, prev.h), c0 = P(cur, o - Math.sign(o) * w, cur.h);
            mb.quad([a[0], a[1] + hh, a[2]], [c[0], c[1] + hh, c[2]], [c0[0], c0[1] + hh, c0[2]], [a0[0], a0[1] + hh, a0[2]], CP.stone);
            mb.quad(o < 0 ? [c[0], c[1], c[2]] : [a[0], a[1], a[2]], o < 0 ? [a[0], a[1], a[2]] : [c[0], c[1], c[2]], o < 0 ? [a[0], a[1] + hh, a[2]] : [c[0], c[1] + hh, c[2]], o < 0 ? [c[0], c[1] + hh, c[2]] : [a[0], a[1] + hh, a[2]], CP.stoneDark);
            mb.quad(o < 0 ? [a0[0], a0[1], a0[2]] : [c0[0], c0[1], c0[2]], o < 0 ? [c0[0], c0[1], c0[2]] : [a0[0], a0[1], a0[2]], o < 0 ? [c0[0], c0[1] + hh, c0[2]] : [a0[0], a0[1] + hh, a0[2]], o < 0 ? [a0[0], a0[1] + hh, a0[2]] : [c0[0], c0[1] + hh, c0[2]], CP.stone);
          }
        } else {
          flat(P(prev, -PW, 0.11), P(prev, PW, 0.11), P(cur, PW, 0.11), P(cur, -PW, 0.11), CP.path);
          // 縁石（交差点の中には付けない）
          if (!crossing(x, z, horiz) && !crossing(prev.x, prev.z, horiz))
            for (const o of [-PW - 0.3, PW]) flat(P(prev, o, 0.12), P(prev, o + 0.3, 0.12), P(cur, o + 0.3, 0.12), P(cur, o, 0.12), CP.curb);
          // 街灯とベンチ（道の脇に、決まった間隔で）
          const h = cpHash(Math.round(x * 2), Math.round(z * 2) + seed);
          if (inside(x, z, 2.5)) {
            if (((k % 18) + 18) % 18 === 4 || ((k % 18) + 18) % 18 === 13) lamps.push([x + cur.px * (PW + 0.9) * (((k % 18) + 18) % 18 < 9 ? 1 : -1), z + cur.pz * (PW + 0.9) * (((k % 18) + 18) % 18 < 9 ? 1 : -1)]);
            else if (h < 0.09 && ((k % 9) + 9) % 9 !== 3 && ((k % 9) + 9) % 9 !== 5) {
              // ベンチ：道に背を向けずに道の方を向く
              const sd = h < 0.045 ? 1 : -1, bx = x + cur.px * (PW + 1.0) * sd, bz = z + cur.pz * (PW + 1.0) * sd;
              const ax = tx * 0.85, az = tz * 0.85, nx = cur.px * sd, nz = cur.pz * sd;
              const Q = (u: number, v: number, y: number): [number, number, number] => [bx + ax * u + nx * v, y, bz + az * u + nz * v];
              mb.quad(Q(-1, -0.25, 0.45), Q(1, -0.25, 0.45), Q(1, 0.25, 0.45), Q(-1, 0.25, 0.45), CP.bench);
              mb.quad(Q(1, -0.25, 0.45), Q(-1, -0.25, 0.45), Q(-1, -0.25, 0.42), Q(1, -0.25, 0.42), CP.bench);
              mb.quad(Q(-1, 0.3, 0.5), Q(1, 0.3, 0.5), Q(1, 0.33, 0.95), Q(-1, 0.33, 0.95), CP.bench);
              mb.quad(Q(1, 0.36, 0.5), Q(-1, 0.36, 0.5), Q(-1, 0.39, 0.95), Q(1, 0.39, 0.95), CP.bench);
              for (const u of [-0.85, 0.85]) {
                const [lx, , lz] = Q(u, 0, 0);
                mb.box(lx - 0.05, 0, lz - 0.05, lx + 0.05, 0.45, lz + 0.05, CP.iron);
              }
            }
          }
          // 花壇：日の当たる広場の道ばたに、ときどき
          if (h > 0.985 && cpMeadow(x, z) > 0.2 && inside(x, z, 6)) {
            const sd = h > 0.9925 ? 1 : -1, fx = x + cur.px * (PW + 2.6) * sd, fz = z + cur.pz * (PW + 2.6) * sd;
            if (!lake(fx, fz)) {
              mb.box(fx - 2.2, 0, fz - 1.2, fx + 2.2, 0.28, fz + 1.2, CP.stoneDark, PAT.none, CP.bed);
              for (let q = 0; q < 10; q++) {
                const u = -1.8 + (q % 5) * 0.9, v = q < 5 ? -0.5 : 0.5;
                mb.box(fx + u - 0.38, 0.28, fz + v - 0.38, fx + u + 0.38, 0.5, fz + v + 0.38, CP.flowers[(Math.floor(h * 1000) + q) % CP.flowers.length]);
              }
            }
          }
        }
      }
      prev = cur;
    }
  };
  for (let j = Math.floor(Z0 / (3 * CELL)) - 1; j <= Math.ceil(Z1 / (3 * CELL)); j++) {
    // 公園の中を通る区間だけ
    let s0 = Infinity, s1 = -Infinity;
    for (let x = X0; x <= X1; x += 1) { const z = pathZ(x, j); if (z > Z0 - PW && z < Z1 + PW) { s0 = Math.min(s0, x); s1 = Math.max(s1, x); } }
    if (s1 > s0) ribbon((s) => [s, pathZ(s, j)], s0, s1, j * 7 + 1, true);
  }
  for (let i = Math.floor(X0 / (3 * CELL)) - 1; i <= Math.ceil(X1 / (3 * CELL)); i++) {
    let s0 = Infinity, s1 = -Infinity;
    for (let z = Z0; z <= Z1; z += 1) { const x = pathX(z, i); if (x > X0 - PW && x < X1 + PW) { s0 = Math.min(s0, z); s1 = Math.max(s1, z); } }
    if (s1 > s0) ribbon((s) => [pathX(s, i), s], s0, s1, i * 13 + 2, false);
  }
  const onPath = (x: number, z: number, m = 1.5) => {
    for (let j = Math.floor(z / (3 * CELL)) - 1; j <= Math.floor(z / (3 * CELL)) + 1; j++) if (Math.abs(z - pathZ(x, j)) < PW + m) return true;
    for (let i = Math.floor(x / (3 * CELL)) - 1; i <= Math.floor(x / (3 * CELL)) + 1; i++) if (Math.abs(x - pathX(z, i)) < PW + m) return true;
    return false;
  };
  // 街灯：細い柱に、夜にともる灯り
  for (const [lx, lz] of lamps) {
    if (lake(lx, lz) || cpLake(lx, lz) > LAKE_T - 0.03) continue;
    mb.box(lx - 0.09, 0, lz - 0.09, lx + 0.09, 3.6, lz + 0.09, CP.pole);
    mb.box(lx - 0.2, 3.6, lz - 0.2, lx + 0.2, 3.7, lz + 0.2, CP.pole);
    mb.box(lx - 0.17, 3.7, lz - 0.17, lx + 0.17, 4.15, lz + 0.17, CP.lamp, PAT.lit);
    mb.box(lx - 0.22, 4.15, lz - 0.22, lx + 0.22, 4.25, lz + 0.22, CP.pole);
    pond?.addGlow(lx, f.base + 0.16, lz);
    // 街灯の明かりは、まわりの木や池の水面にも届く
    pond?.addLight(lx, f.base + 4.0, lz, 9, 1.0, 0.8, 0.52);
  }
  // 池のまわり：岸の石や岩、水ぎわの葦
  for (let z = Z0 + 1; z < Z1 - 1; z += 2.2)
    for (let x = X0 + 1; x < X1 - 1; x += 2.2) {
      const h = cpHash(Math.round(x * 3) + 11, Math.round(z * 3));
      const px = x + (cpHash(Math.round(z), Math.round(x)) - 0.5) * 1.6, pz = z + (h - 0.5) * 1.6;
      const v = cpLake(px, pz);
      if (onPath(px, pz, 0.6)) continue;
      if (v > LAKE_T - 0.06 && v < LAKE_T - 0.005 && h < 0.42) {
        const r = 0.45 + h * 1.6;
        mb.dome(px, pz, 0.05, r, r * (0.45 + cpHash(Math.round(px), 3) * 0.35), CP.rock[Math.floor(h * 30) % 3], 7, 3);
      } else if (v > LAKE_T - 0.004 && v < LAKE_T + 0.035 && h < 0.3) {
        // 葦の茂み
        for (let q = 0; q < 7; q++) {
          const rx = px + (cpHash(q, Math.round(px * 7)) - 0.5) * 1.6, rz = pz + (cpHash(Math.round(pz * 7), q) - 0.5) * 1.6;
          const hh = 0.9 + cpHash(q * 3, Math.round(rx * 5)) * 0.9, w = 0.05;
          mb.box(rx - w, 0.1, rz - w, rx + w, hh, rz + w, CP.reed[q % 3]);
        }
      }
    }
  // ボート小屋と桟橋：池の岸のうち、小道から離れた場所に1つ（公園ごと）
  let best: [number, number, number, number] | null = null, bs = -1;
  for (let z = Z0 + 8; z < Z1 - 8; z += 2)
    for (let x = X0 + 8; x < X1 - 8; x += 2) {
      const v = cpLake(x, z);
      if (v < LAKE_T - 0.09 || v > LAKE_T - 0.05 || onPath(x, z, 4)) continue;
      const gx = cpLake(x + 1, z) - cpLake(x - 1, z), gz = cpLake(x, z + 1) - cpLake(x, z - 1), gl = Math.hypot(gx, gz) || 1;
      const sc = gl + cpHash(Math.round(x), Math.round(z)) * 0.02;
      if (sc > bs && !onPath(x - (gx / gl) * 5, z - (gz / gl) * 5, 3)) { bs = sc; best = [x, z, gx / gl, gz / gl]; }
    }
  if (best && cpHash(b.x * 7 + 1, b.y * 13 + 5) < 0.5) {
    const [hx, hz, ux, uz] = best, vx = -uz, vz = ux;
    const Q = (a: number, c: number): [number, number] => [hx - ux * a + vx * c, hz - uz * a + vz * c];
    const boxR = (a0: number, c0: number, a1: number, c1: number, y0: number, y1: number, col: THREE.Color) => {
      const p = [Q(a0, c0), Q(a1, c0), Q(a1, c1), Q(a0, c1)];
      const top = (k: number): [number, number, number] => [p[k][0], y1, p[k][1]], bot = (k: number): [number, number, number] => [p[k][0], y0, p[k][1]];
      for (let k = 0; k < 4; k++) mb.quad(bot((k + 1) % 4), bot(k), top(k), top((k + 1) % 4), col);
      mb.quad(top(0), top(1), top(2), top(3), col);
    };
    // 小屋（白い壁、窓の帯、緑がかった屋根）
    boxR(1.5, -4, 7.5, 4, 0, 3.2, CP.boathouse);
    boxR(1.45, -3.6, 7.55, 3.6, 1.4, 2.3, C(0x50606a));
    boxR(1.2, -4.4, 7.8, 4.4, 3.2, 3.45, CP.roof);
    boxR(2.4, -3.4, 6.6, 3.4, 3.45, 4.4, CP.roof);
    // 桟橋（池の上へ）
    boxR(-6, -1.2, 1.5, 1.2, 0.3, 0.45, CP.deck);
    for (const a of [-5.5, -2.5]) for (const c of [-1.1, 1.1]) boxR(a - 0.12, c - 0.12, a + 0.12, c + 0.12, 0, 0.3, CP.deck);
    // 桟橋につないだボート
    for (const [a, c, k] of [[-4, 2.2, 0], [-4, -2.2, 1]] as const) {
      const [bx, bz] = Q(a, c), col = CP.boats[(k + Math.floor(hx)) % CP.boats.length];
      const B = (u: number, w: number): [number, number] => [bx - ux * u + vx * w, bz - uz * u + vz * w];
      const pts = [B(-1.5, 0), B(-0.6, 0.6), B(1.3, 0.55), B(1.3, -0.55), B(-0.6, -0.6)];
      for (let q = 0; q < 5; q++) {
        const a0 = pts[q], a1 = pts[(q + 1) % 5];
        mb.quad([a1[0], 0.15, a1[1]], [a0[0], 0.15, a0[1]], [a0[0], 0.55, a0[1]], [a1[0], 0.55, a1[1]], col);
      }
      const ctr = B(0, 0);
      for (let q = 0; q < 5; q++) mb.tri([ctr[0], 0.3, ctr[1]], [pts[(q + 1) % 5][0], 0.5, pts[(q + 1) % 5][1]], [pts[q][0], 0.5, pts[q][1]], C(0x6a4a30));
    }
  }
  // 池に浮かぶボート（深いところに、少しだけ）
  for (let z = Z0 + 6; z < Z1 - 6; z += 9)
    for (let x = X0 + 6; x < X1 - 6; x += 9) {
      const h = cpHash(Math.round(x) + 5, Math.round(z) + 3);
      if (h > 0.12 || cpLake(x, z) < LAKE_T + 0.12) continue;
      const ang = h * 50, ca = Math.cos(ang), sa = Math.sin(ang), col = CP.boats[Math.floor(h * 400) % CP.boats.length];
      const B = (u: number, w: number): [number, number] => [x + ca * u - sa * w, z + sa * u + ca * w];
      const pts = [B(1.5, 0), B(0.6, 0.6), B(-1.3, 0.55), B(-1.3, -0.55), B(0.6, -0.6)];
      for (let q = 0; q < 5; q++) {
        const a0 = pts[q], a1 = pts[(q + 1) % 5];
        mb.quad([a0[0], 0.15, a0[1]], [a1[0], 0.15, a1[1]], [a1[0], 0.55, a1[1]], [a0[0], 0.55, a0[1]], col);
      }
      const ctr = B(0, 0);
      for (let q = 0; q < 5; q++) mb.tri([ctr[0], 0.3, ctr[1]], [pts[q][0], 0.5, pts[q][1]], [pts[(q + 1) % 5][0], 0.5, pts[(q + 1) % 5][1]], C(0x6a4a30));
    }
  // 外周：隣が大公園でない辺に、低い石垣と並木
  const wall = C(0x9a948a);
  for (let x = b.x; x < b.x + b.w; x++) {
    if (!isCpark(x, b.y - 1)) { mb.box(x * CELL, 0, Z0 + 0.2, (x + 1) * CELL, 0.9, Z0 + 0.7, wall); for (const o of [4, 12]) tree(x * CELL + o, Z0 + 2.6, 0.9 + cpHash(x, o) * 0.3); }
    if (!isCpark(x, b.y + b.h)) { mb.box(x * CELL, 0, Z1 - 0.7, (x + 1) * CELL, 0.9, Z1 - 0.2, wall); for (const o of [4, 12]) tree(x * CELL + o, Z1 - 2.6, 0.9 + cpHash(x, o + 50) * 0.3); }
  }
  for (let y = b.y; y < b.y + b.h; y++) {
    if (!isCpark(b.x - 1, y)) { mb.box(X0 + 0.2, 0, y * CELL, X0 + 0.7, 0.9, (y + 1) * CELL, wall); for (const o of [8]) tree(X0 + 2.6, y * CELL + o, 0.9 + cpHash(o, y) * 0.3); }
    if (!isCpark(b.x + b.w, y)) { mb.box(X1 - 0.7, 0, y * CELL, X1 - 0.2, 0.9, (y + 1) * CELL, wall); for (const o of [8]) tree(X1 - 2.6, y * CELL + o, 0.9 + cpHash(o + 50, y) * 0.3); }
  }
  // 木立：芝生広場はまばらに、森の部分は密に（池・小道は避ける）
  for (let z = Z0 + 1.5; z < Z1 - 1; z += 3)
    for (let x = X0 + 1.5; x < X1 - 1; x += 3) {
      const h = cpHash(x, z);
      const tx = x + (cpHash(z, x) - 0.5) * 2.2, tz = z + (h - 0.5) * 2.2;
      if (tx < X0 + 3.5 || tx > X1 - 3.5 || tz < Z0 + 3.5 || tz > Z1 - 3.5) continue;
      if (cpLake(tx, tz) > LAKE_T - 0.1 || onPath(tx, tz, 1.2)) continue;
      const m = cpMeadow(tx, tz);
      const dens = m > 0.45 ? 0.025 : m > 0.1 ? 0.18 : 0.42 + 0.4 * Math.max(0, -m);
      if (h < dens) tree(tx, tz, 0.8 + cpHash(x + 3, z) * 0.7, cpHash(x, z + 9) < 0.22 ? 1 : 0);
    }
}

// ---------------- 中密度・高密度 ----------------
const APT_WALL = [0xb4624a, 0xc9b08c, 0xd9d2c3, 0x9b9a93, 0xa8735a, 0xe2d6bd, 0x8c8f94].map(C);
const TOWER_WALL = [0xd4d0c6, 0xb9b4a8, 0xe6e1d6, 0x9fa4a8, 0xc7b79c, 0xf0efeb, 0x6f767d, 0xdcdfe2].map(C);
// ガラスの色合い：青、緑、シルバー、ブロンズ、濃いグレー、青緑
// 青いガラスがビルらしく見えるので、約半分が青系になるように重ねて入れる
const GLASS = [0x4f7fae, 0x3f6f9a, 0x5a9a8e, 0x6f9aa0, 0xa8b4bf, 0x8f9aa6, 0x9a7a55, 0x7a6248, 0x3a4550, 0x4a5866, 0x4f8fa8, 0x6aa0c0, 0x3f6f9a, 0x4f7fae, 0x3f6f9a, 0x4f7fae, 0x45759f, 0x3a6896].map(C);

// 中層の集合住宅（3〜8階）
function apartments(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, kind: string) {
  // 近代的なマンション（中所得・高所得の約半分）。確認用に形を強制しているときはその形
  { const fr = forcedRes(); if (fr) return fr(mb, f, rng, tf, floors); }
  if (kind !== 'R1' && rng.next() < 0.5) { const fn = pickRes(rng, floors); if (fn) return fn(mb, f, rng, tf, floors); }
  lawn(mb, f, rng);
  // 中高層（R2・R3）の多くは、白やグレーの近代的なマンション（ガラスの手すりのバルコニー）
  const modernApt = kind !== 'R1' && resPat === PAT.balcony;
  const wall = modernApt ? rng.pick(TOWER_WALL) : rng.pick(APT_WALL);
  const fh = modernApt ? 3.1 : 3.0;
  const h = floors * fh + 0.6;
  const W = f.W - 4, D = f.D - 6;
  const zf = f.D / 2 - 3; // 正面の壁
  mb.ground(-f.W / 2 + 0.2, zf, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.1, PALETTE.pavement);
  const blocks: [number, number, number, number][] = [];
  if (f.W >= 32 && f.D >= 32 && rng.next() < 0.6) {
    // コの字型（中庭あり）
    const t = 11;
    blocks.push([-W / 2, zf - t, W / 2, zf]);
    blocks.push([-W / 2, zf - D, -W / 2 + t, zf - t]);
    blocks.push([W / 2 - t, zf - D, W / 2, zf - t]);
    tf(0, zf - D / 2 - 4, 1.1);
    tf(-3, zf - D + 4, 0.9);
  } else {
    blocks.push([-W / 2, zf - Math.min(D, 14 + rng.next() * 6), W / 2, zf]);
  }
  const tank = !modernApt && rng.next() < 0.4;
  for (const [x0, z0, x1, z1] of blocks) {
    mb.box(x0, 0, z0, x1, h, z1, wall, modernApt ? resPat : PAT.apartment, flatRoof());
    roofRim(mb, x0, z0, x1, z1, h, wall);
    roofUnits(mb, x0, z0, x1, z1, h, rng, 2 + rng.int(3), !tank);
  }
  // ベランダ（正面）
  const [bx0, , bx1, bz1] = blocks[0];
  const bal = rng.pick([PALETTE.concrete, PALETTE.white, PALETTE.steel]);
  if (!modernApt) for (let k = 1; k < floors; k++) mb.box(bx0 + 1, k * fh, bz1, bx1 - 1, k * fh + 0.18, bz1 + 1.0, bal);
  // 入口のひさし
  mb.box(-2, 2.8, bz1, 2, 3.1, bz1 + 2, kind === 'R3' ? PALETTE.dark : PALETTE.concrete);
  // 給水タンク
  if (tank) waterTank(mb, bx0 + 3, blocks[0][1] + 3, h, 1.4, rng);
  tf(-f.W / 2 + 1.6, f.D / 2 - 1.6, 0.8);
  tf(f.W / 2 - 1.6, f.D / 2 - 1.6, 0.8);
}

// 中層の商業ビル（1階が店舗）
function shopMid(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, upscale: boolean) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const wall = upscale ? rng.pick(TOWER_WALL) : rng.pick(PALETTE.shopWall);
  const accent = rng.pick(PALETTE.accent);
  const W = f.W - 2, D = f.D - 4;
  const z1 = f.D / 2 - 2, z0 = z1 - D;
  const g = 4.4, fh = 3.4;
  const h = g + (floors - 1) * fh;
  mb.box(-W / 2, 0, z0, W / 2, g, z1, wall, PAT.shop, flatRoof());
  mb.box(-W / 2 + 0.3, g, z0 + 0.3, W / 2 - 0.3, h, z1 - 0.3, wall, upscale ? officePat : resPat, flatRoof());
  roofRim(mb, -W / 2 + 0.3, z0 + 0.3, W / 2 - 0.3, z1 - 0.3, h, wall, 1.0);
  // 階の境目の帯（コーニス）
  mb.box(-W / 2 + 0.1, g - 0.15, z1 - 0.1, W / 2 - 0.1, g + 0.25, z1 + 0.1, C(0xd6d3cb));
  // 看板の帯と日よけ
  mb.box(-W / 2 + 0.4, g - 1.0, z1, W / 2 - 0.4, g - 0.2, z1 + 0.3, accent);
  mb.quad([-W / 2 + 0.4, 3.0, z1 + 1.6], [W / 2 - 0.4, 3.0, z1 + 1.6], [W / 2 - 0.4, 3.6, z1], [-W / 2 + 0.4, 3.6, z1], accent);
  // 縦の看板（ネオン風）
  if (rng.next() < 0.5 && floors >= 3) mb.box(W / 2 - 2, g, z1, W / 2 - 1.2, Math.min(h, g + 9), z1 + 1.2, rng.pick(PALETTE.accent));
  roofUnits(mb, -W / 2 + 0.7, z0 + 0.7, W / 2 - 0.7, z1 - 0.7, h, rng, 3 + rng.int(3), true);
  if (rng.next() < 0.5) tf(-f.W / 2 + 1.2, f.D / 2 - 1.0, 0.7);
}

// ---- 商業の中高層（2×2 以上の敷地） ----
//  ・映像と光のモール：正面の大きな映像スクリーン（色の帯が夜に光る）、縦の光の帯、屋上のサイン
//  ・吹き抜けとテラスのモール：正面に何層もの高さのガラスの吹き抜け、上の階ほど下がるテラス（芝生と木）
//  ・複合ビル：上のどちらかを低層部にして、その上にホテルかオフィスの塔
const AD_COLORS = [0xff3d7f, 0x22d3ee, 0xffc83d, 0x7c5cff, 0x34d399, 0xff7a45, 0xf5f5f5].map(C);
function commercialMid(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, upscale: boolean) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const W = f.W - 2, D = f.D - 3, z1 = f.D / 2 - 1.5, z0 = z1 - D;
  const mixed = floors >= 9 && rng.next() < 0.55;
  // 複合でないモールは、百貨店くらいの高さ（7階）まで
  const mallFloors = mixed ? 4 + rng.int(2) : Math.min(7, floors);
  const led = rng.next() < 0.5;
  // 上に塔が立つときは、屋上の大きな設備は置かない
  const top = led ? ledMall(mb, rng, -W / 2, z0, W / 2, z1, mallFloors, !mixed) : atriumMall(mb, rng, tf, -W / 2, z0, W / 2, z1, mallFloors, !mixed);
  if (mixed) mixedTower(mb, rng, -W / 2, z0, W / 2, z1, top, floors - mallFloors, upscale);
  tf(-f.W / 2 + 1.2, f.D / 2 - 0.8, 0.7);
  tf(f.W / 2 - 1.2, f.D / 2 - 0.8, 0.7);
}

// 正面（+z）の広告スクリーン：色の帯を並べた絵。夜は明るく光る
function adScreen(mb: MeshBuilder, rng: Rng, x0: number, x1: number, y0: number, y1: number, z: number) {
  mb.box(x0 - 0.3, y0 - 0.3, z, x1 + 0.3, y1 + 0.3, z + 0.35, C(0x1a1d21));
  const n = 3 + rng.int(3), cols = [rng.pick(AD_COLORS), rng.pick(AD_COLORS), rng.pick(AD_COLORS)];
  for (let k = 0; k < n; k++) {
    const a = x0 + ((x1 - x0) * k) / n, b = x0 + ((x1 - x0) * (k + 1)) / n;
    const split = y0 + (y1 - y0) * (0.35 + rng.next() * 0.3);
    litSign(mb, a, y0, z + 0.35, b, split, z + 0.45, cols[k % 3]);
    litSign(mb, a, split, z + 0.35, b, y1, z + 0.45, cols[(k + 1) % 3]);
  }
}

function ledMall(mb: MeshBuilder, rng: Rng, x0: number, z0: number, x1: number, z1: number, floors: number, plant = true) {
  const g = 5, fh = 4.4, h = g + (floors - 1) * fh;
  const skin = rng.pick([MW, C(0x2c3036), C(0xd9d6cf), C(0x3d4752)]);
  // 1階のショーウィンドウと、上の階の壁
  mb.box(x0 + 0.8, 0, z0 + 0.8, x1 - 0.8, g, z1 - 0.8, MGL, PAT.shop, skin);
  mb.box(x0, g, z0, x1, h, z1, skin, PAT.none, flatRoof());
  // 縦の光の帯（全面に一定間隔、夜は光る）
  const glow = rng.pick([C(0xbfe8ff), C(0xffd1f0), C(0xd9fff1)]);
  for (let x = x0 + 2; x < x1 - 1; x += 3.2) {
    mb.box(x - 0.15, g + 0.5, z1, x + 0.15, h - 0.6, z1 + 0.25, glow, PAT.glow);
    mb.box(x - 0.15, g + 0.5, z0 - 0.25, x + 0.15, h - 0.6, z0, glow, PAT.glow);
  }
  for (let z = z0 + 2; z < z1 - 1; z += 3.2) {
    mb.box(x1, g + 0.5, z - 0.15, x1 + 0.25, h - 0.6, z + 0.15, glow, PAT.glow);
    mb.box(x0 - 0.25, g + 0.5, z - 0.15, x0, h - 0.6, z + 0.15, glow, PAT.glow);
  }
  // 正面の大きな映像スクリーン（角寄り）
  const sw = Math.min(16, (x1 - x0) * 0.42), sh = Math.min(h - g - 2, sw * 0.7);
  const sx = rng.next() < 0.5 ? x0 + 1.5 : x1 - 1.5 - sw;
  adScreen(mb, rng, sx, sx + sw, h - 1 - sh, h - 1, z1 + 0.3);
  // 入口のひさしと、屋上のサイン
  const ex = (x0 + x1) / 2;
  mb.box(ex - 6, 4.2, z1 - 0.5, ex + 6, 4.6, z1 + 3.2, skin, PAT.none, MW2);
  litSign(mb, ex - 5, 4.6, z1 + 3.0, ex + 5, 5.3, z1 + 3.2, rng.pick(AD_COLORS));
  roofRim(mb, x0, z0, x1, z1, h, skin, 1.0);
  roofUnits(mb, x0 + 2, z0 + 2, x1 - 2, z1 - 2, h, rng, 3, plant);
  return h;
}

function atriumMall(mb: MeshBuilder, rng: Rng, tf: TF, x0: number, z0: number, x1: number, z1: number, floors: number, plant = true) {
  const g = 5, fh = 4.4;
  const wall = rng.pick([MW, C(0xe9e4da), C(0xd4d0c8)]);
  // 上の階ほど奥へ下がる（段の上はテラス）
  const steps = Math.min(3, Math.max(1, Math.round(floors / 3)));
  let y = 0, zf = z1, left = floors;
  for (let k = 0; k < steps; k++) {
    const n = k === steps - 1 ? left : Math.max(1, Math.round(floors / steps));
    left -= n;
    const h = (k === 0 ? g + (n - 1) * fh : n * fh);
    mb.box(x0 + k * 1.5, y, z0 + k * 1.5, x1 - k * 1.5, y + h, zf, wall, PAT.none, flatRoof());
    // 1階はショーウィンドウ（少し奥まる）、上の階は白い壁に横長のガラスの帯（階ごと）
    if (k === 0) mb.box(x0 - 0.1, 0, z0 - 0.1, x1 + 0.1, g - 0.6, zf + 0.1, MGL, PAT.shop, wall);
    for (let yy = (k === 0 ? g : y) + 1.2; yy < y + h - 1; yy += fh) mb.box(x0 + k * 1.5 - 0.1, yy, z0 + k * 1.5 - 0.1, x1 - k * 1.5 + 0.1, yy + 1.8, zf + 0.1, MGL, PAT.fullglass, MGL);
    y += h;
    if (k < steps - 1) {
      // テラス：前の帯に芝生と木、ガラスの手すり
      const zt = zf - 6;
      mb.ground(x0 + k * 1.5 + 0.5, zt, x1 - k * 1.5 - 0.5, zf - 0.4, y + 0.06, PALETTE.lawn);
      mb.box(x0 + k * 1.5, y, zf - 0.15, x1 - k * 1.5, y + 1.1, zf, C(0x9fc4d0));
      for (let x = x0 + 4; x < x1 - 3; x += 7) tf(x, zf - 3, 0.6 + rng.next() * 0.2, 0, y);
      zf = zt;
    }
  }
  roofRim(mb, x0 + (steps - 1) * 1.5, z0 + (steps - 1) * 1.5, x1 - (steps - 1) * 1.5, zf, y, wall, 1.0);
  if (plant) roofUnits(mb, x0 + (steps - 1) * 1.5 + 1.5, z0 + (steps - 1) * 1.5 + 1.5, x1 - (steps - 1) * 1.5 - 1.5, zf - 1.5, y, rng, 3, true);
  // 正面の吹き抜け（ガラス、何層もの高さ）
  const aw = Math.min(14, (x1 - x0) * 0.35), ah = Math.min(y + 2, g + fh * 3);
  const ax = (x0 + x1) / 2;
  mb.box(ax - aw / 2, 0, z1 - 4, ax + aw / 2, ah, z1 + 1.2, MGL, PAT.fullglass, MW2);
  mb.box(ax - aw / 2 - 0.4, ah, z1 - 4.4, ax + aw / 2 + 0.4, ah + 0.5, z1 + 1.6, MW, PAT.none, MW2);
  litSign(mb, ax - aw / 2 + 1, ah - 2.2, z1 + 1.25, ax + aw / 2 - 1, ah - 1.2, z1 + 1.4, rng.pick(AD_COLORS));
  return y;
}

// 複合ビルの塔：ホテル（バルコニーの帯）かオフィス（ガラス）。低層部の上に、少し下がって立つ。頂部は光る帯
function mixedTower(mb: MeshBuilder, rng: Rng, x0: number, z0: number, x1: number, z1: number, y: number, floors: number, upscale: boolean) {
  const hotel = rng.next() < 0.5;
  const fh = hotel ? 3.2 : 3.8, h = Math.max(4, floors) * fh;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2 - 1;
  const w = Math.min(34, (x1 - x0) * 0.6), d = Math.min(26, (z1 - z0) * 0.55);
  const glass = rng.pick(GLASS);
  mb.box(cx - w / 2, y, cz - d / 2, cx + w / 2, y + h, cz + d / 2, hotel ? rng.pick(TOWER_WALL) : glass, hotel ? PAT.balcony : upscale ? PAT.fullglass : PAT.curtain, flatRoof());
  // 塔と低層部のつなぎ目のスカイロビー（ガラス、夜に光る帯）
  mb.box(cx - w / 2 - 0.3, y, cz - d / 2 - 0.3, cx + w / 2 + 0.3, y + 0.5, cz + d / 2 + 0.3, MW, PAT.glow);
  mb.box(cx - w / 2 - 0.2, y + h, cz - d / 2 - 0.2, cx + w / 2 + 0.2, y + h + 3, cz + d / 2 + 0.2, MW, PAT.none, flatRoof());
  mb.box(cx - w / 2 - 0.25, y + h + 2.2, cz - d / 2 - 0.25, cx + w / 2 + 0.25, y + h + 2.7, cz + d / 2 + 0.25, C(0xe8f0f6), PAT.glow);
  // ホテルの名前（縦の光るサイン）
  if (hotel) litSign(mb, cx + w / 2 - 1.2, y + h - 14, cz + d / 2, cx + w / 2 - 0.4, y + h - 2, cz + d / 2 + 0.3, rng.pick(AD_COLORS));
}

// 高層ビル（オフィス・高層マンション）
function tower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean, luxury: boolean) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const fh = office ? 3.6 : 3.1;
  const wall = office ? rng.pick(GLASS) : rng.pick(TOWER_WALL);
  const frame0 = office ? rng.pick([PALETTE.steel, PALETTE.white, PALETTE.dark, PALETTE.concrete]) : rng.pick(APT_WALL);
  const pat = office ? officePat : resPat;
  // ほぼガラスだけのビルは、帯や柱もガラスにする
  const allGlass = office && officePat === PAT.fullglass;
  const frame = allGlass ? wall : frame0;
  // 低層部（ポディウム）。オフィスは石とガラスの基壇
  const podium = floors >= 8 ? 1 + rng.int(3) : 0;
  const PW = f.W - 2, PD = f.D - 3;
  const pz1 = f.D / 2 - 1.5;
  let y = 0;
  if (podium && office && !allGlass) y = podiumBase(mb, f, rng, tf, frame, floors).y;
  else if (podium) {
    const ph = 4.5 + (podium - 1) * 4;
    mb.box(-PW / 2, 0, pz1 - PD, PW / 2, ph, pz1, frame, allGlass ? PAT.fullglass : PAT.shop, flatRoof());
    if (!allGlass) roofRim(mb, -PW / 2, pz1 - PD, PW / 2, pz1, ph, frame, 0.8);
    y = ph;
  }
  // 塔の部分。高いほど段々に細くする
  const minSide = Math.min(f.W, f.D);
  let tw = Math.min(f.W - 4, minSide * (0.55 + rng.next() * 0.2) * (f.W / minSide > 1.4 ? 1.5 : 1));
  let td = Math.min(f.D - 5, minSide * (0.55 + rng.next() * 0.2) * (f.D / minSide > 1.4 ? 1.5 : 1));
  const cz = pz1 - PD / 2 - (podium ? 0 : 0);
  const tiers = floors > 30 ? 3 : floors > 16 ? 2 : 1;
  let remaining = floors - podium;
  const round = office && luxury && rng.next() < 0.04;
  for (let t = 0; t < tiers; t++) {
    const fl = t === tiers - 1 ? remaining : Math.round(remaining * (0.55 + rng.next() * 0.15));
    remaining -= fl;
    const h = fl * fh;
    if (round) mb.cylinder(0, cz, y, y + h, Math.min(tw, td) / 2, 16, wall, flatRoof());
    else {
      mb.box(-tw / 2, y, cz - td / 2, tw / 2, y + h, cz + td / 2, wall, pat, flatRoof());
      // ガラスのビルは、屋上のふちもガラスの手すり（外壁がそのまま上まで続いて見える）
      if (allGlass) glassParapet(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y + h, wall, 1.4);
      else roofRim(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y + h, office ? frame : wall, 1.1);
      if (t < tiers - 1) roofUnits(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y + h, rng, 2);
    }
    // 縦ルーバー（細いひれを密に並べる）か、ふつうの窓のビルは太い柱
    if (office && !round && louvers && !allGlass) fins(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y, y + h, frame);
    else if (office && !round && officePat === PAT.office) {
      for (let x = -tw / 2; x <= tw / 2 + 0.01; x += tw / Math.max(2, Math.round(tw / 6))) {
        mb.box(x - 0.18, y, cz + td / 2, x + 0.18, y + h, cz + td / 2 + 0.25, frame);
        mb.box(x - 0.18, y, cz - td / 2 - 0.25, x + 0.18, y + h, cz - td / 2, frame);
      }
    } else if (!office && resPat !== PAT.balcony) {
      for (let k = 1; k < fl; k += 1) mb.box(-tw / 2 - 0.5, y + k * fh, cz + td / 2, tw / 2 + 0.5, y + k * fh + 0.2, cz + td / 2 + 0.9, frame);
    }
    y += h;
    tw *= 0.78;
    td *= 0.78;
  }
  // 屋上（機械室、アンテナ、とがった屋根）
  const crown = rng.next();
  if (office && luxury && floors > 30 && crown < 0.4) {
    mb.hip(-tw / 2, cz - td / 2, tw / 2, cz + td / 2, y, Math.min(tw, td) * 0.9, wall, 0);
    mb.box(-0.12, y, cz - 0.12, 0.12, y + Math.min(tw, td) * 0.9 + 6, cz + 0.12, PALETTE.steel);
  } else if (floors > 24 && crown < 0.75) {
    // 屋上の目隠しパネル（夜は光る帯）と、ヘリポート
    if (allGlass) glassParapet(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y, wall, 4);
    else crownScreen(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y, office ? 5 : 3.5, frame);
    if (office && Math.min(tw, td) > 16) helipad(mb, 0, cz, y + 0.3, Math.min(tw, td) * 0.42);
    else roofUnits(mb, -tw / 2 + 1, cz - td / 2 + 1, tw / 2 - 1, cz + td / 2 - 1, y, rng, 3);
  } else {
    mb.box(-tw / 3, y, cz - td / 3, tw / 3, y + 3.5, cz + td / 3, PALETTE.concrete, PAT.industrial, flatRoof());
    roofUnits(mb, -tw / 2 + 0.5, cz - td / 2 + 0.5, tw / 2 - 0.5, cz + td / 2 - 0.5, y, rng, 3);
    if (floors > 20 && crown < 0.6) mb.box(-0.1, y + 3.5, cz - 0.1, 0.1, y + 9, cz + 0.1, PALETTE.steel);
    if (!office && resPat !== PAT.balcony) waterTank(mb, tw / 4, cz, y + 3.5, 1.6, rng);
  }
  // 入口と植え込み
  mb.box(-3, podium ? 4.3 : 3, pz1, 3, (podium ? 4.3 : 3) + 0.3, pz1 + 2.2, PALETTE.dark);
  tf(-f.W / 2 + 1.6, f.D / 2 - 1.0, 0.75);
  tf(f.W / 2 - 1.6, f.D / 2 - 1.0, 0.75);
}


// ---------------- 超高層ビル・デザインのあるビル ----------------
type P2 = [number, number];
// 正多角形（中心 cx, cz、半径 r、n 角、回転 rot）
function ngon(cx: number, cz: number, r: number, n: number, rot = 0): P2[] {
  const out: P2[] = [];
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}
// 中心のまわりに回した長方形
function rect(cx: number, cz: number, w: number, d: number, rot = 0): P2[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  return ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as P2[]).map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c]);
}
const scaleP = (pts: P2[], cx: number, cz: number, k: number): P2[] => pts.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k]);

// ガラスの手すり（屋上のふち）。外壁のガラスがそのまま上に伸びて見える
function glassParapet(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, col: THREE.Color, h: number) {
  const t = 0.15;
  mb.box(x0, y, z1 - t, x1, y + h, z1, col, PAT.fullglass, col);
  mb.box(x0, y, z0, x1, y + h, z0 + t, col, PAT.fullglass, col);
  mb.box(x0, y, z0 + t, x0 + t, y + h, z1 - t, col, PAT.fullglass, col);
  mb.box(x1 - t, y, z0 + t, x1, y + h, z1 - t, col, PAT.fullglass, col);
}

// ほぼガラスだけの塔：角を丸めた（多角形の）ガラスの箱、斜めに切った頂部、ガラスのロビー
function glassTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const glass = rng.pick(GLASS);
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const PW = f.W - 3, PD = f.D - 4, pz1 = f.D / 2 - 2;
  const cz = pz1 - PD / 2;
  // ガラスの低層部（2層吹き抜け）と、薄い大きなひさし
  const ph = 9;
  mb.box(-PW / 2, 0, pz1 - PD, PW / 2, ph, pz1, glass, PAT.fullglass, flatRoof());
  mb.box(-PW / 2 - 0.5, ph, pz1 - PD - 0.5, PW / 2 + 0.5, ph + 0.4, pz1 + 2.5, C(0xe8e8e6));
  const fh = 3.8, H = (floors - 2) * fh;
  const w = Math.min(44, PW * (0.62 + rng.next() * 0.15)), d = Math.min(36, PD * (0.6 + rng.next() * 0.12));
  const shape = rng.next();
  // 角を大きく落とした8角形（角の丸いガラスの箱に見える）か、細長い長方形
  const c = shape < 0.5 ? Math.min(w, d) * 0.22 : 0.01;
  const base: P2[] = [[-w / 2 + c, cz - d / 2], [w / 2 - c, cz - d / 2], [w / 2, cz - d / 2 + c], [w / 2, cz + d / 2 - c], [w / 2 - c, cz + d / 2], [-w / 2 + c, cz + d / 2], [-w / 2, cz + d / 2 - c], [-w / 2, cz - d / 2 + c]];
  const taper = 0.9 + rng.next() * 0.1;
  const topP = scaleP(base, 0, cz, taper);
  // 頂部を斜めに切る（半分くらいのビル）
  const slope = rng.next() < 0.5 ? Math.min(30, H * 0.12) : 0;
  const topY = topP.map(([x]) => ph + H - slope * (0.5 - x / w));
  mb.prism(base, ph, ph + H, glass, PAT.fullglass, glass, topP, slope ? topY : undefined);
  if (!slope) {
    glassParapet(mb, -w * taper / 2 + 1, cz - d * taper / 2 + 1, w * taper / 2 - 1, cz + d * taper / 2 - 1, ph + H, glass, 3.5);
    if (floors >= 30) helipad(mb, 0, cz, ph + H + 0.4, Math.min(w, d) * taper * 0.3);
  }
  // 夜は頂部のふちが光る
  mb.prism(scaleP(topP, 0, cz, 1.005), ph + H - 0.6, ph + H - 0.2, C(0xdfe6ee), PAT.glow, null);
  tf(-f.W / 2 + 1.6, f.D / 2 - 1.0, 0.75);
  tf(f.W / 2 - 1.6, f.D / 2 - 1.0, 0.75);
}

// 縦ルーバー：四方の面に細いひれを密に並べる
function fins(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, col: THREE.Color) {
  const sp = 1.8, dep = 0.7, t = 0.12;
  for (let x = x0 + sp / 2; x < x1; x += sp) {
    mb.box(x - t, y0, z1, x + t, y1, z1 + dep, col);
    mb.box(x - t, y0, z0 - dep, x + t, y1, z0, col);
  }
  for (let z = z0 + sp / 2; z < z1; z += sp) {
    mb.box(x1, y0, z - t, x1 + dep, y1, z + t, col);
    mb.box(x0 - dep, y0, z - t, x0, y1, z + t, col);
  }
}

// 屋上の目隠しパネル（機械を隠す）。上のふちは夜に光る
function crownScreen(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, h: number, col: THREE.Color) {
  const t = 0.4, i = 1.2;
  const X0 = x0 + i, X1 = x1 - i, Z0 = z0 + i, Z1 = z1 - i;
  mb.box(X0, y, Z1 - t, X1, y + h, Z1, col, PAT.ribbon, flatRoof());
  mb.box(X0, y, Z0, X1, y + h, Z0 + t, col, PAT.ribbon, flatRoof());
  mb.box(X0, y, Z0 + t, X0 + t, y + h, Z1 - t, col, PAT.ribbon, flatRoof());
  mb.box(X1 - t, y, Z0 + t, X1, y + h, Z1 - t, col, PAT.ribbon, flatRoof());
  const g = C(0xdfe6ee);
  mb.box(X0 - 0.05, y + h - 0.35, Z1 - 0.05, X1 + 0.05, y + h, Z1 + 0.05, g, PAT.glow);
  mb.box(X0 - 0.05, y + h - 0.35, Z0 - 0.05, X1 + 0.05, y + h, Z0 + 0.05, g, PAT.glow);
  mb.box(X0 - 0.05, y + h - 0.35, Z0, X0 + 0.05, y + h, Z1, g, PAT.glow);
  mb.box(X1 - 0.05, y + h - 0.35, Z0, X1 + 0.05, y + h, Z1, g, PAT.glow);
}

// ヘリポート（屋上の円と H）
// ヘリポート：四角い台、白いふちと黄色の線、中央に H（夜はふちの灯りが光る）
function helipad(mb: MeshBuilder, cx: number, cz: number, y: number, r: number) {
  const g = C(0x4a4f55), W = PALETTE.white, yel = C(0xf2c200);
  mb.box(cx - r, y - 0.3, cz - r, cx + r, y, cz + r, g, PAT.none, g);
  const e = r * 0.08;
  for (const [x0, z0, x1, z1] of [[cx - r, cz - r, cx + r, cz - r + e], [cx - r, cz + r - e, cx + r, cz + r], [cx - r, cz - r, cx - r + e, cz + r], [cx + r - e, cz - r, cx + r, cz + r]]) mb.box(x0, y, z0, x1, y + 0.03, z1, W, PAT.none, W);
  const i = r * 0.8, t2 = r * 0.04;
  for (const [x0, z0, x1, z1] of [[cx - i, cz - i, cx + i, cz - i + t2], [cx - i, cz + i - t2, cx + i, cz + i], [cx - i, cz - i, cx - i + t2, cz + i], [cx + i - t2, cz - i, cx + i, cz + i]]) mb.box(x0, y, z0, x1, y + 0.04, z1, yel, PAT.none, yel);
  // 四隅の灯り
  for (const [x, z] of [[cx - r, cz - r], [cx + r, cz - r], [cx - r, cz + r], [cx + r, cz + r]]) mb.box(x - 0.25, y, z - 0.25, x + 0.25, y + 0.35, z + 0.25, C(0x9fe08a), PAT.glow);
  const hw = r * 0.28, hh = r * 0.4, t = r * 0.08, Y = PALETTE.white;
  mb.box(cx - hw - t, y + 0.06, cz - hh, cx - hw + t, y + 0.09, cz + hh, Y);
  mb.box(cx + hw - t, y + 0.06, cz - hh, cx + hw + t, y + 0.09, cz + hh, Y);
  mb.box(cx - hw, y + 0.06, cz - t, cx + hw, y + 0.09, cz + t, Y);
}

// 角を落とした塔（深圳・上海・香港風）：段々に細くなり、途中にスカイガーデン、頂部はライトアップ
function chamferTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean) {
  const glass = office ? rng.pick(GLASS) : rng.pick(TOWER_WALL);
  const frame = rng.pick([PALETTE.white, PALETTE.steel, C(0x8a9097), C(0xd8d4ca)]);
  const p = podiumBase(mb, f, rng, tf, frame, floors);
  const fh = office ? 3.8 : 3.1;
  const S0 = Math.min(40, p.size * 0.66);
  const cham = (cx: number, cz: number, s: number): P2[] => {
    const c = s * 0.18, h2 = s / 2;
    return [[cx - h2 + c, cz - h2], [cx + h2 - c, cz - h2], [cx + h2, cz - h2 + c], [cx + h2, cz + h2 - c], [cx + h2 - c, cz + h2], [cx - h2 + c, cz + h2], [cx - h2, cz + h2 - c], [cx - h2, cz - h2 + c]];
  };
  const pat = office ? officePat : resPat;
  const tiers = floors >= 50 ? 4 : floors >= 30 ? 3 : 2;
  let y = p.y, s = S0, left = floors;
  for (let t = 0; t < tiers; t++) {
    const fl = t === tiers - 1 ? left : Math.round(left * (0.5 + rng.next() * 0.12));
    left -= fl;
    const h = fl * fh;
    const poly = cham(p.cx, p.cz, s);
    mb.prism(poly, y, y + h, glass, pat, flatRoof(), cham(p.cx, p.cz, s * 0.97));
    y += h;
    if (t < tiers - 1) {
      // スカイガーデン（2階分の吹き抜け：細い芯と、木）
      const gh = fh * 2;
      mb.prism(cham(p.cx, p.cz, s * 0.97), y, y + 0.5, frame, PAT.none, flatRoof());
      mb.prism(cham(p.cx, p.cz, s * 0.45), y + 0.5, y + gh, C(0x3a4550), PAT.curtain, null);
      for (const [gx, gz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        mb.box(p.cx + gx * s * 0.36 - 0.5, y + 0.5, p.cz + gz * s * 0.36 - 0.5, p.cx + gx * s * 0.36 + 0.5, y + gh, p.cz + gz * s * 0.36 + 0.5, frame);
        tf(p.cx + gx * s * 0.25, p.cz + gz * s * 0.1, 0.7, 0, y + 0.5);
      }
      mb.ground(p.cx - s * 0.4, p.cz - s * 0.4, p.cx + s * 0.4, p.cz + s * 0.4, y + 0.55, PALETTE.lawn);
      mb.prism(cham(p.cx, p.cz, s * 0.97), y + gh - 0.5, y + gh, frame, PAT.none, null);
      y += gh;
      s *= 0.84;
    }
  }
  // 頂部：細い光る帯を重ねた冠と、アンテナ
  const top = cham(p.cx, p.cz, s * 0.8);
  for (let k = 0; k < 4; k++) {
    mb.prism(scaleP(top, p.cx, p.cz, 1 - k * 0.12), y + k * 3, y + k * 3 + 2.4, frame, PAT.ribbon, flatRoof());
    mb.prism(scaleP(top, p.cx, p.cz, 1.01 - k * 0.12), y + k * 3 + 2.4, y + k * 3 + 3, C(0xdfe6ee), PAT.glow, flatRoof());
  }
  if (floors >= 40) spire(mb, p.cx, p.cz, y + 12, 16 + rng.next() * 24);
  else if (office) helipad(mb, p.cx, p.cz, y + 12.1, s * 0.22);
}

// どの形のビルにするかを選ぶ
function highrise(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean, luxury: boolean) {
  // モダンなオフィスの塔（新しい形を多めに）
  if (office && floors >= 18 && rng.next() < (floors >= 28 ? 0.66 : 0.45)) {
    const ds: ((mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) => void)[] = [trapTwistTower, exoTower, foldedTower, crownTower, cantileverTower];
    // 近代建築（モダニズム）の塔
    ds.push(miesTower, leverTower, brutalTower);
    if (floors >= 25) ds.push(skyGardenTower);
    if (floors >= 30) ds.push(spiralTaperTower, shardTower);
    return ds[Math.floor(rng.next() * ds.length)](mb, f, rng, tf, floors);
  }
  if (!office) {
    // 近代的なマンション（高層の約 3 割）
    const fr = forcedRes(); if (fr) return fr(mb, f, rng, tf, floors);
    if (rng.next() < 0.3) { const fn = pickRes(rng, floors); if (fn) return fn(mb, f, rng, tf, floors); }
  }
  const r = rng.next();
  const big = Math.min(f.W, f.D) >= 30;
  // 近未来的な形（24 階以上の約 3 割）：楕円で上へ細くなる塔、しずく形の塔、ダイアグリッド（オフィスのみ）
  if (floors >= 24) {
    const r2 = rng.next();
    // 丸い形（しずく形）はまれに。オフィスはダイアグリッドが中心
    if (office && r2 < 0.25) return rng.next() < 0.15 ? dropTower(mb, f, rng, tf, floors, true) : diagridTower(mb, f, rng, tf, floors);
    if (!office && r2 < 0.04) return dropTower(mb, f, rng, tf, floors, false);
  }
  if (!office) {
    // タワーマンションが中心。広い敷地では、まれに積み木の集合住宅
    const rr = rng.next();
    if (Math.min(f.W, f.D) >= 46 && floors >= 12 && rr < 0.18) return stackedBlocks(mb, f, rng, tf, floors);
    if (floors >= 15 && (rr < 0.62 || Math.min(f.W, f.D) < 30)) {
      // タワマンの種類：今のタワマン、波打つバルコニー、らせん、ジェンガ、ツイン（広い敷地だけ）を同じくらいの割合で
      // 波・らせん・ジェンガは、幅が 2 マス以上の敷地だけ（細い敷地だと塔が細くなりすぎる）
      const kinds = Math.min(f.W, f.D) >= 30 ? [towerMansion, waveTower, twistTower, jengaTower] : [towerMansion];
      if (Math.max(f.W, f.D) >= 44 && floors >= 20) kinds.push(twinMansion);
      return kinds[Math.floor(rng.next() * kinds.length)](mb, f, rng, tf, floors);
    }
    // 香港のような細長い十字形の集合住宅
    if (floors >= 22 && r < 0.35) return crossTowers(mb, f, rng, tf, floors);
    if (floors >= 20 && r < 0.6) return chamferTower(mb, f, rng, tf, floors, false);
    if (floors >= 28 && luxury && r < 0.75) return rng.next() < 0.1 ? roundTower(mb, f, rng, tf, floors, false) : steppedTower(mb, f, rng, tf, floors, false);
    return tower(mb, f, rng, tf, floors, office, luxury);
  }
  if (floors >= 12 && officePat === PAT.fullglass && r < 0.6) return glassTower(mb, f, rng, tf, floors);
  if (floors < 24 && r < 0.65) return tower(mb, f, rng, tf, floors, office, luxury);
  // ほぼガラスだけの外壁を選んだビルは、半分以上をガラスの塔にする
  if (officePat === PAT.fullglass && r < 0.7) return glassTower(mb, f, rng, tf, floors);
  // 四角が基本。丸い塔（円筒・先細りの八角形）はまれ
  const designs = [twistedTower, steppedTower, wedgeTower, twinTowers, tower, tower, chamferTower, chamferTower, glassTower, glassTower, diagridTower, diagridTower, lotusTower, lotusTower, notchTower, notchTower, ...(rng.next() < 0.3 ? [taperedTower, roundTower] : [])];
  let k = Math.floor(rng.next() * designs.length);
  if (designs[k] === twinTowers && !(f.W >= 40 && floors >= 30)) k = (k + 1) % designs.length;
  if (designs[k] === tower && floors >= 45) k = 0;
  if (!big && designs[k] === twinTowers) k = 1;
  designs[k](mb, f, rng, tf, floors, office, luxury);
}

// ---- 近未来的な高層ビル ----
// しずく形の塔：片側がとがった平面で、上へいくほど少しずつねじれる
function dropTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean) {
  const glass = office ? rng.pick(GLASS) : rng.pick(TOWER_WALL);
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const fh = office ? 3.8 : 3.1, H = floors * fh;
  const R = Math.min(15, p.size * 0.3), tip = R * 1.9;
  const twist = (0.5 + rng.next() * 0.5) * (rng.next() < 0.5 ? 1 : -1);
  // 円と、とがった先をなめらかにつなぐ（凸な形）
  const shape = (rot: number, k: number): P2[] => {
    const o: P2[] = [];
    const ta = Math.acos(R / tip); // 接線の角度
    for (let i = 0; i <= 32; i++) {
      const a = ta + (i / 32) * (Math.PI * 2 - 2 * ta);
      o.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    o.push([tip, 0]);
    return o.map(([x, z]) => { const c = Math.cos(rot), s = Math.sin(rot); return [p.cx - tip * 0.25 * k + (x * c - z * s) * k, p.cz + (x * s + z * c) * k] as P2; });
  };
  const pat = office ? officePat === PAT.office ? PAT.curtain : officePat : resPat;
  const segs = 12;
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs, t1 = (k + 1) / segs;
    mb.prism(shape(twist * t0, 1 - 0.12 * t0), p.y + H * t0, p.y + H * t1, glass, pat, k === segs - 1 ? MW2 : null, shape(twist * t1, 1 - 0.12 * t1));
  }
  // 頂部：とがった先が上へのびる細いアンテナ
  mb.prism(shape(twist, 0.88).map(([x, z]) => [x, z] as P2), p.y + H, p.y + H + 0.6, C(0xdfe6ee), PAT.glow, MW2);
  spire(mb, p.cx, p.cz, p.y + H, 14 + rng.next() * 16);
}

// ダイアグリッド：角の丸い四角のガラスの塔に、外側の斜め格子の骨組み（白い太い格子か、シルバーの細い格子）
function diagridTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const glass = rng.pick(GLASS);
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const H = floors * 3.8;
  const w = Math.min(34, p.size * 0.62), d = Math.min(30, p.size * 0.55);
  const thick = rng.next() < 0.5;
  const col = thick ? MW : C(0xb8bfc6), bw = thick ? 1.1 : 0.45;
  mb.prism(rrect(p.cx, p.cz, w, d, 3), p.y, p.y + H, glass, PAT.fullglass, MW2);
  // 斜め格子：各面に、45 度の帯を X 字に交差させる（面の少し外側）
  const M = thick ? 16 : 11; // 格子のひとこまの高さ
  const faces: [number, number, number, number, number, number][] = [
    [p.cx - w / 2 + 3, p.cz + d / 2 + 0.25, p.cx + w / 2 - 3, p.cz + d / 2 + 0.25, 0, 1],
    [p.cx + w / 2 - 3, p.cz - d / 2 - 0.25, p.cx - w / 2 + 3, p.cz - d / 2 - 0.25, 0, -1],
    [p.cx + w / 2 + 0.25, p.cz + d / 2 - 3, p.cx + w / 2 + 0.25, p.cz - d / 2 + 3, 1, 0],
    [p.cx - w / 2 - 0.25, p.cz - d / 2 + 3, p.cx - w / 2 - 0.25, p.cz + d / 2 - 3, -1, 0],
  ];
  for (const [ax, az, bx, bz, nx, nz] of faces) {
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    const n = Math.max(2, Math.round(L / M));
    const cw = L / n; // ひとこまの幅
    const P = (u: number, y: number): [number, number, number] => [ax + ux * u + nx * 0.05, y, az + uz * u + nz * 0.05];
    const strut = (u0: number, y0: number, u1: number, y1: number) => {
      // 斜めの帯（幅 bw）を、面に沿った細い四角形で描く
      const dl = Math.hypot(u1 - u0, y1 - y0), pu = (-(y1 - y0) / dl) * bw / 2, py = ((u1 - u0) / dl) * bw / 2;
      const a = P(u0 - pu, y0 - py), b = P(u1 - pu, y1 - py), c = P(u1 + pu, y1 + py), e = P(u0 + pu, y0 + py);
      // 面の外向き（nx, nz）に表が向くように、頂点の順番を選ぶ
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
      const cxn = e1[1] * e2[2] - e1[2] * e2[1], czn = e1[0] * e2[1] - e1[1] * e2[0];
      const nn: [number, number, number] = [nx, 0, nz];
      if (cxn * nx + czn * nz > 0) mb.quadN(a, b, c, e, nn, nn, nn, nn, col);
      else mb.quadN(a, e, c, b, nn, nn, nn, nn, col);
    };
    for (let y = p.y; y < p.y + H - 0.1; y += M) {
      const y1 = Math.min(p.y + H, y + M);
      for (let i = 0; i < n; i++) {
        const u0 = i * cw, u1 = (i + 1) * cw;
        strut(u0, y, u1, y1);
        strut(u1, y, u0, y1);
      }
      // 節（横の帯）
      mb.box(Math.min(ax, bx) - (nx ? 0.15 : 0), y1 - bw / 2, Math.min(az, bz) - (nz ? 0.15 : 0), Math.max(ax, bx) + (nx ? 0.15 : 0), y1 + bw / 2, Math.max(az, bz) + (nz ? 0.15 : 0), col);
    }
  }
  glassParapet(mb, p.cx - w / 2 + 1, p.cz - d / 2 + 1, p.cx + w / 2 - 1, p.cz + d / 2 - 1, p.y + H, glass, 3);
  if (floors >= 30) helipad(mb, p.cx, p.cz, p.y + H + 0.4, Math.min(w, d) * 0.3);
}

// 低層部（店舗やロビー）。上の塔の中心を返す
// 低層部（基壇）：1階は石の柱の奥のガラス、上の階は帯の窓。正面にガラスの吹き抜けロビーと、柱のない薄いひさし。
// 基壇の屋上は庭（芝生と木）、入口の前は石畳の広場と植え込み
const STONE_TONES = [0xd9d3c7, 0xc8c2b6, 0x9a958c, 0xe6e2da, 0x6f7276].map(C);
function podiumBase(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, color: THREE.Color, floors: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const PW = f.W - 2, PD = f.D - 3, pz1 = f.D / 2 - 1.5, pz0 = pz1 - PD;
  const levels = floors >= 20 ? 2 + rng.int(2) : 1;
  const ph = 5 + (levels - 1) * 4.2;
  const stone = rng.next() < 0.5 ? rng.pick(STONE_TONES) : color;
  // 1階：1.2m 奥まったガラスと、外側の石の柱
  mb.box(-PW / 2 + 1.2, 0, pz0 + 1.2, PW / 2 - 1.2, 5, pz1 - 1.2, MGL, PAT.fullglass, stone);
  const pier = (x: number, z: number) => mb.box(x - 0.45, 0, z - 0.45, x + 0.45, 5, z + 0.45, stone);
  const nx = Math.max(2, Math.round(PW / 4.5)), nz = Math.max(2, Math.round(PD / 4.5));
  for (let i = 0; i <= nx; i++) { const x = -PW / 2 + 0.45 + (i * (PW - 0.9)) / nx; pier(x, pz1 - 0.45); pier(x, pz0 + 0.45); }
  for (let i = 1; i < nz; i++) { const z = pz0 + 0.45 + (i * (PD - 0.9)) / nz; pier(-PW / 2 + 0.45, z); pier(PW / 2 - 0.45, z); }
  mb.box(-PW / 2, 5, pz0, PW / 2, 5.6, pz1, stone, PAT.none, stone);
  // 上の階（帯の窓）
  if (ph > 5.6) mb.box(-PW / 2, 5.6, pz0, PW / 2, ph, pz1, stone, PAT.ribbon, flatRoof());
  roofRim(mb, -PW / 2, pz0, PW / 2, pz1, ph, stone, 1.0);
  // 基壇の屋上の庭（四隅に芝生と木）
  if (PW > 24 && PD > 20) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = sx * (PW / 2 - 4), cz = (pz0 + pz1) / 2 + sz * (PD / 2 - 4);
      mb.ground(cx - 3, cz - 3, cx + 3, cz + 3, ph + 0.08, PALETTE.lawn);
      tf(cx, cz, 0.6 + rng.next() * 0.25, 0, ph);
    }
  }
  // 正面のガラスの吹き抜けロビー（基壇より少し高い）
  const lw = Math.min(18, PW * 0.42), lobbyD = Math.min(9, PD * 0.3);
  mb.box(-lw / 2, 0, pz1 - lobbyD, lw / 2, ph + 2.5, pz1 + 0.6, MGL, PAT.fullglass, MW2);
  mb.box(-lw / 2 - 0.3, ph + 2.5, pz1 - lobbyD - 0.3, lw / 2 + 0.3, ph + 3.0, pz1 + 0.9, MW, PAT.none, MW2);
  // 柱のない薄いひさし
  mb.box(-lw / 2 - 1, 4.4, pz1 + 0.6, lw / 2 + 1, 4.7, pz1 + 4.2, MW, PAT.none, MW2);
  // 入口の前の石畳と植え込み
  for (let x = -lw / 2; x < lw / 2; x += 2) mb.ground(x, pz1 + 0.6, x + 0.08, f.D / 2 - 0.3, 0.1, C(0xb9b4aa));
  planter(mb, tf, -PW / 2 + 0.5, pz1 + 0.3, -lw / 2 - 2, pz1 + 1.3);
  planter(mb, tf, lw / 2 + 2, pz1 + 0.3, PW / 2 - 0.5, pz1 + 1.3);
  return { y: ph, cx: 0, cz: (pz0 + pz1) / 2, size: Math.min(PW, PD) };
}

// タワーマンション：角の丸い白いバルコニーのスラブが各階を巡り、その上にガラスの手すり。奥の壁はガラス。
// 各面のまん中に縦の白い柱、頂部は白い枠（夜に光る帯）。足元は石とガラスの基壇
// タワーマンションの色の組み合わせ（バルコニーのスラブ、ガラスの手すり、奥のガラスの壁）
interface MansionColors { slab: THREE.Color; rail: THREE.Color; core: THREE.Color }
function mansionColors(rng: Rng): MansionColors {
  const k = rng.next();
  if (k < 0.5) return { slab: rng.pick([MW, C(0xece8df), C(0xdcdcd8)]), rail: rng.pick([C(0x8fb0bf), C(0x9db7c2), C(0x7f9fb3)]), core: rng.pick([C(0x5a7184), C(0x4c6275), C(0x6b7f8c)]) };
  if (k < 0.67) return { slab: rng.pick([C(0xd8c79a), C(0xcdb98a)]), rail: C(0xa9b8ad), core: C(0x5c5a52) }; // シャンパンゴールド
  if (k < 0.84) return { slab: rng.pick([C(0x4a4f55), C(0x3d4248)]), rail: C(0x9fb6c4), core: C(0x2f3a45) }; // ダークグレー
  return { slab: rng.pick([C(0xa4784e), C(0x8f6a46)]), rail: C(0xa7bcc4), core: C(0x4f5e68) }; // 木目調
}
// 平面の形：角の丸い四角、八角形、角が大きく丸い楕円に近い形
function mansionPlan(rng: Rng, cx: number, cz: number, S: number, D: number): P2[] {
  const k = rng.next();
  if (k < 0.45) return rrect(cx, cz, S, D, 3 + rng.next() * 3, 3);
  if (k < 0.72) {
    const c = Math.min(S, D) * 0.29;
    return [[cx - S / 2 + c, cz - D / 2], [cx + S / 2 - c, cz - D / 2], [cx + S / 2, cz - D / 2 + c], [cx + S / 2, cz + D / 2 - c], [cx + S / 2 - c, cz + D / 2], [cx - S / 2 + c, cz + D / 2], [cx - S / 2, cz + D / 2 - c], [cx - S / 2, cz - D / 2 + c]];
  }
  return rrect(cx, cz, S, D, Math.min(S, D) * 0.46, 6);
}
// 辺を細かく分ける（波打つ形やねじれに使う）
function densify(poly: P2[], step: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}
const rotP = (pts: P2[], cx: number, cz: number, a: number): P2[] => { const c = Math.cos(a), s = Math.sin(a); return pts.map(([x, z]) => [cx + (x - cx) * c - (z - cz) * s, cz + (x - cx) * s + (z - cz) * c]); };
// バルコニーの塔の共通部分：階ごとに slabAt(k) の形のスラブとガラスの手すり、coreAt(k) の形の奥のガラスの壁。頂部の枠と光る帯
function balconyFloors(mb: MeshBuilder, y0: number, floors: number, fh: number, col: MansionColors, slabAt: (k: number) => P2[], coreAt: (k: number) => P2[], cx: number, cz: number, uniformCore: boolean) {
  if (uniformCore) mb.prism(coreAt(0), y0, y0 + floors * fh, col.core, PAT.curtain, flatRoof());
  for (let k = 0; k < floors; k++) {
    const y = y0 + k * fh;
    if (!uniformCore) mb.prism(coreAt(k), y, y + fh, col.core, PAT.curtain, flatRoof());
    if (k === 0) continue;
    const sl = slabAt(k);
    mb.prism(sl, y - 0.3, y, col.slab, PAT.none, col.slab);
    mb.prism(scaleP(sl, cx, cz, 0.995), y, y + 1.05, col.rail, PAT.none, null);
  }
  const top = y0 + floors * fh, last = slabAt(floors - 1);
  mb.prism(last, top, top + 0.6, col.slab, PAT.none, flatRoof());
  mb.prism(scaleP(last, cx, cz, 1.01), top + 0.6, top + 3.5, col.slab, PAT.none, null);
  mb.prism(scaleP(last, cx, cz, 1.015), top + 2.4, top + 2.9, C(0xe8f0f6), PAT.glow, null);
  return top;
}

// タワーマンション：角の丸い白いバルコニーのスラブが各階を巡り、その上にガラスの手すり。奥の壁はガラス。
// 各面のまん中に縦の柱、頂部は枠（夜に光る帯）。足元は石とガラスの基壇。平面の形と色はいくつかの中から選ぶ
function towerMansion(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, Math.min(floors, 19));
  const fh = 3.1;
  // 幅が 1 マスの細い敷地では、塔を敷地いっぱいに広げ、高さも細すぎない程度（幅の 9 倍まで）にする
  const narrow = Math.min(f.W, f.D) < 30;
  let S = Math.min(40, p.size * (0.62 + rng.next() * 0.1));
  let D = S * (0.8 + rng.next() * 0.2);
  if (narrow) {
    S = Math.min(40, (f.W - 2) * 0.88);
    D = Math.min(40, (f.D - 3) * 0.88);
    floors = Math.min(floors, Math.max(15, Math.round((Math.min(S, D) * 9) / fh)));
  }
  const col = mansionColors(rng);
  const outer = mansionPlan(rng, p.cx, p.cz, S, D);
  // バルコニーの奥行き（細い塔では浅くして、奥のガラスの壁が細くなりすぎないように）
  const inner = scaleP(outer, p.cx, p.cz, 1 - Math.min(3.6, S * 0.16) / S);
  const H = floors * fh;
  const top = balconyFloors(mb, p.y, floors, fh, col, () => outer, () => inner, p.cx, p.cz, true);
  // 各面のまん中の縦の柱
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const ex = p.cx + nx * ((nx ? S : 0) / 2 - 1.2), ez = p.cz + nz * ((nz ? D : 0) / 2 - 1.2);
    mb.box(ex - (nz ? 1.0 : 1.2), p.y, ez - (nx ? 1.0 : 1.2), ex + (nz ? 1.0 : 1.2), p.y + H + 3, ez + (nx ? 1.0 : 1.2), col.slab);
  }
  // 屋上の救助用スペース
  mb.ground(p.cx - S * 0.2, p.cz - S * 0.2, p.cx + S * 0.2, p.cz + S * 0.2, top + 0.65, C(0x8a8f96));
  mb.ground(p.cx - S * 0.2 + 0.6, p.cz - S * 0.2 + 0.6, p.cx - S * 0.2 + 1.0, p.cz + S * 0.2 - 0.6, top + 0.7, MW);
}

// 波打つバルコニーの塔（シカゴのアクアタワーのような）：階ごとにバルコニーの張り出しが少しずつ違い、
// 外壁全体が水面のように波打って見える。奥はガラスの壁
function waveTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, Math.min(floors, 19));
  const fh = 3.1, S = Math.min(38, p.size * (0.6 + rng.next() * 0.08)), D = S * (0.75 + rng.next() * 0.2);
  const col = mansionColors(rng);
  if (rng.next() < 0.6) col.slab = MW;
  const ins = Math.min(3, Math.min(S, D) * 0.14), amp = Math.min(1, Math.min(S, D) / 20);
  const core = rrect(p.cx, p.cz, S - 2 * ins, D - 2 * ins, 2, 2);
  const ring = densify(core, 1.6);
  const ph = rng.next() * 10, L = (S + D) * 2;
  // 外周に沿った位置 u と階 k で、張り出しの長さが波のように変わる
  const slabAt = (k: number): P2[] => {
    let u = 0;
    return ring.map(([x, z], i) => {
      const [nx2, nz2] = ring[(i + 1) % ring.length];
      const dx = x - p.cx, dz = z - p.cz, l = Math.hypot(dx, dz) || 1;
      const w = Math.sin((u / L) * Math.PI * 2 * 3 + k * 0.33 + ph) * Math.sin((u / L) * Math.PI * 2 * 1.3 - k * 0.19 + ph * 0.7);
      u += Math.hypot(nx2 - x, nz2 - z);
      const o = (1.0 + 2.6 * (0.5 + 0.5 * w)) * amp;
      return [x + (dx / l) * o, z + (dz / l) * o] as P2;
    });
  };
  balconyFloors(mb, p.y, floors, fh, col, slabAt, () => core, p.cx, p.cz, true);
}

// らせんにねじれる塔：階ごとに平面が少しずつ回り、バルコニーの帯がらせんを描く（全体で 90〜120°）
function twistTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, Math.min(floors, 19));
  const fh = 3.1, S = Math.min(36, p.size * 0.58), D = S * (0.62 + rng.next() * 0.15);
  const col = mansionColors(rng);
  const plan = rng.next() < 0.5 ? rrect(p.cx, p.cz, S, D, Math.min(S, D) * 0.46, 4) : rrect(p.cx, p.cz, S, D, 3, 2);
  const core = scaleP(plan, p.cx, p.cz, 1 - Math.min(4, Math.min(S, D) * 0.3) / S);
  const total = ((90 + rng.next() * 30) * Math.PI) / 180 * (rng.next() < 0.5 ? 1 : -1);
  const ang = (k: number) => (total * k) / floors;
  balconyFloors(mb, p.y, floors, fh, col, (k) => rotP(plan, p.cx, p.cz, ang(k)), (k) => rotP(core, p.cx, p.cz, ang(k)), p.cx, p.cz, false);
}

// ジェンガの塔（ニューヨークの 56 レナード・ストリートのような）：ガラスの箱の住戸が、上へいくほどバラバラに飛び出して積み重なる。
// 階ごとに白いスラブのふち、飛び出した部分の上はテラス
function jengaTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, Math.min(floors, 19));
  const fh = 3.4, S = Math.min(32, p.size * 0.52);
  const glass = rng.pick([C(0x5a7184), C(0x4c6275), C(0x6f8796)]), slab = rng.pick([MW, C(0xe6e2da)]);
  // 2階ずつの箱。上へいくほど飛び出しが大きい
  let y = p.y;
  const g = 2;
  for (let k = 0; k < floors; k += g) {
    const t = k / floors, n = Math.min(g, floors - k), h = n * fh;
    const amp = (0.6 + t * 5.5) * Math.min(1, S / 24);
    const o = [0, 0, 0, 0].map(() => (rng.next() * 2 - 1) * amp);
    const x0 = p.cx - S / 2 + o[0], x1 = p.cx + S / 2 + o[1], z0 = p.cz - S / 2 + o[2], z1 = p.cz + S / 2 + o[3];
    mb.box(x0, y, z0, x1, y + h - 0.4, z1, glass, PAT.fullglass, slab);
    mb.box(x0 - 0.15, y + h - 0.4, z0 - 0.15, x1 + 0.15, y + h, z1 + 0.15, slab, PAT.none, slab);
    // 飛び出した箱の上のテラスの手すり（次の箱より外にはみ出す側だけ、ふちに低いガラス）
    mb.box(x0, y + h, z1 - 0.1, x1, y + h + 1, z1, C(0x9fc4d0));
    y += h;
  }
  // 頂部の段々（細い箱を2つ）
  mb.box(p.cx - S * 0.35, y, p.cz - S * 0.3, p.cx + S * 0.15, y + 6, p.cz + S * 0.3, glass, PAT.fullglass, slab);
  mb.box(p.cx - S * 0.1, y, p.cz - S * 0.4, p.cx + S * 0.38, y + 3.4, p.cz + S * 0.2, glass, PAT.fullglass, slab);
}

// ツインタワー＋空中の渡り廊下：細めのタワマン2棟を並べ、上の方をガラスの渡り廊下（スカイラウンジ）でつなぐ。広い敷地で
function twinMansion(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, Math.min(floors, 19));
  const alongX = f.W >= f.D;
  const L = alongX ? f.W - 4 : f.D - 5, Wd = Math.min(f.W, f.D) - 6;
  const S = Math.min(26, L * 0.36), D = Math.min(S, Wd * 0.7);
  const gap = Math.min(L - 2 * S - 4, S * 0.9);
  const col = mansionColors(rng);
  const fh = 3.1;
  const fl2 = Math.max(10, floors - 2 - rng.int(5));
  const tops: number[] = [];
  for (const sd of [-1, 1]) {
    const off = sd * (gap / 2 + S / 2);
    const cx = p.cx + (alongX ? off : 0), cz = p.cz + (alongX ? 0 : off);
    const outer = alongX ? rrect(cx, cz, S, D, 3, 3) : rrect(cx, cz, D, S, 3, 3);
    const inner = scaleP(outer, cx, cz, 1 - Math.min(3.6, Math.min(S, D) * 0.16) / S);
    tops.push(balconyFloors(mb, p.y, sd < 0 ? floors : fl2, fh, col, () => outer, () => inner, cx, cz, true));
  }
  // 渡り廊下（2層分、ガラス。夜は光る帯）と、下の方にもう1本
  const by = p.y + Math.min(fl2 - 4, Math.round(fl2 * 0.82)) * fh;
  const bridge = (y: number, h: number) => {
    const half = gap / 2 + 1, bw = D * 0.42;
    if (alongX) {
      mb.box(p.cx - half, y, p.cz - bw / 2, p.cx + half, y + h, p.cz + bw / 2, MGL, PAT.fullglass, col.slab);
      mb.box(p.cx - half, y - 0.6, p.cz - bw / 2 - 0.2, p.cx + half, y, p.cz + bw / 2 + 0.2, col.slab, PAT.glow, col.slab);
    } else {
      mb.box(p.cx - bw / 2, y, p.cz - half, p.cx + bw / 2, y + h, p.cz + half, MGL, PAT.fullglass, col.slab);
      mb.box(p.cx - bw / 2 - 0.2, y - 0.6, p.cz - half, p.cx + bw / 2 + 0.2, y, p.cz + half, col.slab, PAT.glow, col.slab);
    }
  };
  bridge(by, fh * 2);
  if (fl2 > 24) bridge(p.y + Math.round(fl2 * 0.45) * fh, fh);
}

// 積み木の集合住宅（シンガポールのインターレースのような）：6階建ての細長い棟を、60° ずつ回しながら積む。
// 棟の屋上は庭（芝生と木）、下の中庭は芝生とプール
function stackedBlocks(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  const fh = 3.1, BH = 6 * fh, levels = Math.max(2, Math.min(3, Math.round(floors / 6)));
  const M = Math.min(f.W, f.D), L = M * 0.74, B = 10, R = M * 0.24;
  const wall = rng.pick([MW, C(0xeeeae2), C(0xe2e4e6)]);
  const block = (cx: number, cz: number, ang: number, y: number) => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const pt = (u: number, v: number): P2 => [cx + ca * u - sa * v, cz + sa * u + ca * v];
    const base = [pt(-L / 2, -B / 2), pt(L / 2, -B / 2), pt(L / 2, B / 2), pt(-L / 2, B / 2)];
    mb.prism(base, y, y + BH, wall, PAT.balcony, PALETTE.lawn);
    // 屋上の庭：木を数本
    for (const u of [-L / 3, 0, L / 3]) { const [tx, tz] = pt(u, 0); tf(tx, tz, 0.55 + rng.next() * 0.2, 0, y + BH); }
  };
  // プールのある中庭（真ん中の六角形の中）
  mb.ground(-R * 0.7, -R * 0.45, R * 0.7, R * 0.45, 0.1, C(0x5fb8d6));
  // 各段は3棟で三角形を作り、上の段は 60° ずらす（重なって六角形の中庭を囲む）。いちばん上の段は2棟
  for (let k = 0; k < levels; k++) {
    const n = k === levels - 1 && levels > 2 ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const ang = (i * 2 * Math.PI) / 3 + (k % 2 ? Math.PI / 3 : 0) + 0.15;
      block(-Math.sin(ang) * R, Math.cos(ang) * R, ang, k * BH);
    }
  }
  for (const [x, z] of [[-hw + 3, -hd + 3], [hw - 3, -hd + 3], [-hw + 3, hd - 3], [hw - 3, hd - 3]]) tf(x, z, 0.9);
}

// ---- モダンなオフィスの塔（8種類） ----
const OFH = 3.8; // オフィスの階高

// ねじれる台形の塔（虎ノ門ヒルズ ステーションタワーのような）：下は手前が広い台形、上は奥が広い台形。間はなめらかにねじれてつながる
function trapTwistTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick(GLASS), H = floors * OFH;
  const W = Math.min(46, p.size * 0.78), D = Math.min(34, p.size * 0.6), w2 = W * 0.55;
  const A: P2[] = [[p.cx - W / 2, p.cz + D / 2], [p.cx + W / 2, p.cz + D / 2], [p.cx + w2 / 2, p.cz - D / 2], [p.cx - w2 / 2, p.cz - D / 2]];
  const B: P2[] = [[p.cx - w2 / 2, p.cz + D / 2], [p.cx + w2 / 2, p.cz + D / 2], [p.cx + W / 2, p.cz - D / 2], [p.cx - W / 2, p.cz - D / 2]];
  const lerpP = (t: number): P2[] => A.map(([x, z], i) => [x + (B[i][0] - x) * t, z + (B[i][1] - z) * t]);
  const N = 8, h0 = H * 0.36, h1 = H * 0.66;
  mb.prism(A, p.y, p.y + h0, glass, PAT.fullglass, flatRoof());
  for (let k = 0; k < N; k++) {
    const t0 = k / N, t1 = (k + 1) / N, s0 = t0 * t0 * (3 - 2 * t0), s1 = t1 * t1 * (3 - 2 * t1);
    mb.prism(lerpP(s0), p.y + h0 + (h1 - h0) * t0, p.y + h0 + (h1 - h0) * t1, glass, PAT.fullglass, flatRoof(), lerpP(s1));
  }
  mb.prism(B, p.y + h1, p.y + H, glass, PAT.fullglass, flatRoof());
  // 正面と背面のまん中を上まで通る白い縦の帯
  for (const z of [p.cz + D / 2, p.cz - D / 2]) mb.box(p.cx - 1.2, p.y, z - 0.5, p.cx + 1.2, p.y + H + 4, z + 0.5, MW);
  glassParapet(mb, p.cx - W / 2 + 1, p.cz - D / 2 + 1, p.cx + W / 2 - 1, p.cz + D / 2 - 1, p.y + H, glass, 3);
  mb.prism(scaleP(B, p.cx, p.cz, 1.004), p.y + H - 0.6, p.y + H - 0.1, C(0xdfe6ee), PAT.glow, null);
}

// 空中庭園の吹き抜けの塔（シンガポールのキャピタスプリングのような）：縦のフィンの塔の中ほどが大きくえぐれ、
// 柱のあいだに木が茂る空中の森になっている。屋上も庭
function skyGardenTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick(GLASS), fin = rng.pick([MW, C(0xd8d2c4), C(0x9aa3ab)]);
  const S = Math.min(40, p.size * 0.66), D = S * 0.82;
  const x0 = p.cx - S / 2, x1 = p.cx + S / 2, z0 = p.cz - D / 2, z1 = p.cz + D / 2;
  const gStart = Math.round(floors * 0.45), gN = Math.max(4, Math.round(floors * 0.12));
  const y0 = p.y, yg0 = y0 + gStart * OFH, yg1 = yg0 + gN * OFH, yt = y0 + floors * OFH;
  const block = (ya: number, yb: number) => {
    mb.box(x0, ya, z0, x1, yb, z1, glass, PAT.curtain, flatRoof());
    fins(mb, x0, z0, x1, z1, ya, yb, fin);
  };
  block(y0, yg0);
  block(yg1, yt);
  // 吹き抜け：床のスラブ（芝生）と天井のスラブ、細い柱と、まん中の芯
  mb.box(x0 - 0.8, yg0, z0 - 0.8, x1 + 0.8, yg0 + 0.8, z1 + 0.8, fin, PAT.none, PALETTE.lawn);
  mb.box(x0 - 0.8, yg1 - 0.8, z0 - 0.8, x1 + 0.8, yg1, z1 + 0.8, fin, PAT.none, fin);
  mb.box(p.cx - S * 0.18, yg0, p.cz - D * 0.18, p.cx + S * 0.18, yg1, p.cz + D * 0.18, glass, PAT.fullglass, glass);
  for (const [cx, cz] of [[x0 + 1, z0 + 1], [x1 - 1, z0 + 1], [x0 + 1, z1 - 1], [x1 - 1, z1 - 1], [p.cx, z1 - 1], [p.cx, z0 + 1]]) mb.box(cx - 0.5, yg0, cz - 0.5, cx + 0.5, yg1, cz + 0.5, fin);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2, rr = 0.36 + rng.next() * 0.08;
    tf(p.cx + Math.cos(a) * S * rr, p.cz + Math.sin(a) * D * rr, 0.8 + rng.next() * 0.5, rng.next() < 0.2 ? 1 : 0, yg0 + 0.8 - f.base * 0);
  }
  // 吹き抜けの夜の明かり（天井）
  mb.box(x0 + 2, yg1 - 1.0, z0 + 2, x1 - 2, yg1 - 0.8, z1 - 2, C(0xfff1d6), PAT.lit);
  // 屋上の庭
  mb.ground(x0 + 1, z0 + 1, x1 - 1, z1 - 1, yt + 0.1, PALETTE.lawn);
  for (let k = 0; k < 6; k++) tf(x0 + 3 + rng.next() * (S - 6), z0 + 3 + rng.next() * (D - 6), 0.6 + rng.next() * 0.3, 0, yt + 0.1);
  mb.box(x0, yt, z1 - 0.15, x1, yt + 1.2, z1, C(0x9fc4d0));
}

// らせんに細くなる塔（ワン・ヴァンダービルトのような）：4つのガラスの塊が、外側の面を内へ傾けながら細くなり、
// それぞれ違う高さで終わる（らせんの階段のように）。階の間にテラコッタ色の帯。いちばん上に細い尖塔
function spiralTaperTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick([C(0x7d93a6), C(0x8aa0b2), C(0x6f8799)]), terra = C(0xc9a58a);
  const S = Math.min(44, p.size * 0.72), H = floors * OFH;
  const quads: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const ends = [0.72, 0.82, 0.91, 1.0];
  const start = rng.int(4);
  for (let q = 0; q < 4; q++) {
    const [sx, sz] = quads[(q + start) % 4], h = H * ends[q];
    // 四分の一の平面（中心側の角は塔の中心）
    const base: P2[] = [[p.cx, p.cz], [p.cx + sx * S / 2, p.cz], [p.cx + sx * S / 2, p.cz + sz * S / 2], [p.cx, p.cz + sz * S / 2]];
    const k = 0.62 + 0.1 * q / 3;
    const top = scaleP(base, p.cx, p.cz, k);
    mb.prism(base, p.y, p.y + h, glass, PAT.curtain, flatRoof(), top);
    // テラコッタ色の帯（4階ごと）
    for (let y = 4 * OFH; y < h - 2; y += 4 * OFH) {
      const t = y / h, sc = 1 + (k - 1) * t;
      mb.prism(scaleP(base, p.cx, p.cz, sc * 1.006), p.y + y, p.y + y + 0.5, terra, PAT.none, null);
    }
    mb.prism(scaleP(top, p.cx, p.cz, 1.006), p.y + h - 0.5, p.y + h, C(0xdfe6ee), PAT.glow, flatRoof());
  }
  spire(mb, p.cx + S * 0.06, p.cz + S * 0.06, p.y + H, 30 + rng.next() * 20);
}

// 外骨格の塔（ドバイの 0-14 タワーのような）：ガラスの塔を、丸い穴がたくさんあいた白いコンクリートの殻が少し離れて包む
function exoTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick(GLASS), shell = rng.pick([MW, C(0xe8e4dc)]);
  const S = Math.min(34, p.size * 0.6), D = S * (0.85 + rng.next() * 0.15), H = Math.min(floors, 30) * OFH;
  const x0 = p.cx - S / 2, x1 = p.cx + S / 2, z0 = p.cz - D / 2, z1 = p.cz + D / 2;
  mb.box(x0 + 1.4, p.y, z0 + 1.4, x1 - 1.4, p.y + H, z1 - 1.4, glass, PAT.curtain, flatRoof());
  // 殻：面ごとにマス目に分け、穴のマスと板のマスを決める。穴のマスは角に三角の板を付けて丸く見せる
  const cell = 3.8, t = 0.6;
  const face = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
    const nu = Math.max(2, Math.round(L / cell)), nv = Math.round(H / cell), cu = L / nu, cv = H / nv;
    const P = (u: number, v: number, o = 0): [number, number, number] => [ax + tx * u + nx * o, p.y + v, az + tz * u + nz * o];
    for (let j = 0; j < nv; j++) {
      let run0 = -1;
      for (let i = 0; i <= nu; i++) {
        const edge = i === 0 || i === nu - 1 || j === nv - 1 || j < 2;
        const hole = i < nu && !edge && rng.next() < 0.72 + 0.18 * Math.sin(i * 0.9 + j * 0.37);
        const solid = i < nu && !hole;
        if (solid && run0 < 0) run0 = i;
        if ((!solid || i === nu) && run0 >= 0) {
          // 板のマスを横につなげて1つの箱に
          const [qx0, , qz0] = P(run0 * cu, 0), [qx1, , qz1] = P(i * cu, 0);
          mb.box(Math.min(qx0, qx1) - (nz ? 0 : t / 2), p.y + j * cv, Math.min(qz0, qz1) - (nx ? 0 : t / 2), Math.max(qx0, qx1) + (nz ? 0 : t / 2), p.y + (j + 1) * cv, Math.max(qz0, qz1) + (nx ? 0 : t / 2), shell);
          run0 = -1;
        }
        if (hole) {
          const u0 = i * cu, u1 = u0 + cu, v0 = j * cv, v1 = v0 + cv, c = cu * 0.4, o = t / 2;
          for (const [cu0, cv0, du, dv] of [[u0, v0, 1, 1], [u1, v0, -1, 1], [u0, v1, 1, -1], [u1, v1, -1, -1]] as const) {
            const a = P(cu0, cv0, o), b = P(cu0 + du * c, cv0, o), d = P(cu0, cv0 + dv * c, o);
            if (du * dv > 0) mb.tri(a, b, d, shell); else mb.tri(a, d, b, shell);
          }
        }
      }
    }
  };
  const g = 1.2;
  face(x0 - g, z1 + g, x1 + g, z1 + g, 0, 1);
  face(x1 + g, z0 - g, x0 - g, z0 - g, 0, -1);
  face(x1 + g, z1 + g, x1 + g, z0 - g, 1, 0);
  face(x0 - g, z0 - g, x0 - g, z1 + g, -1, 0);
  mb.box(x0 - g - 0.3, p.y + H, z0 - g - 0.3, x1 + g + 0.3, p.y + H + 0.8, z1 + g + 0.3, shell, PAT.none, flatRoof());
}

// 折り紙のひだの外壁の塔（深圳エナジー・マンションのような）：正面と背面が、白い壁とガラスが交互にジグザグに折れた外壁。
// 広い敷地では高さの違う2棟を、低層部でつなぐ
function foldedTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick(GLASS), white = rng.pick([MW, C(0xece8df)]);
  const twin = Math.max(f.W, f.D) >= 46 && floors >= 24;
  const alongX = f.W >= f.D;
  const one = (cx: number, cz: number, W: number, D: number, fl: number) => {
    const H = fl * OFH, x0 = cx - W / 2, x1 = cx + W / 2, z0 = cz - D / 2, z1 = cz + D / 2, y0 = p.y, y1 = p.y + H;
    // 奥の芯と、横の面（白い壁）
    mb.box(x0 + 0.1, y0, z0 + 0.1, x1 - 0.1, y1, z1 - 0.1, glass, PAT.curtain, flatRoof());
    mb.box(x0, y0, z0, x0 + 0.6, y1, z1, white, PAT.none, white);
    mb.box(x1 - 0.6, y0, z0, x1, y1, z1, white, PAT.none, white);
    // ひだ：幅 3m ごとに、外へ 1.4m 折れる
    const bay = 3, n = Math.max(2, Math.round(W / bay)), bw = W / n;
    for (const [z, out] of [[z1, 1], [z0, -1]] as const) {
      for (let i = 0; i < n; i++) {
        const xa = x0 + i * bw, xm = xa + bw * 0.62, xb = xa + bw;
        const pk = z + out * 1.4;
        const A = (x: number, zz: number, y: number): [number, number, number] => [x, y, zz];
        // 白い壁の面（斜め）とガラスの面（斜め）
        const f1 = out > 0 ? [A(xa, z, y0), A(xm, pk, y0), A(xm, pk, y1), A(xa, z, y1)] : [A(xm, pk, y0), A(xa, z, y0), A(xa, z, y1), A(xm, pk, y1)];
        const f2 = out > 0 ? [A(xm, pk, y0), A(xb, z, y0), A(xb, z, y1), A(xm, pk, y1)] : [A(xb, z, y0), A(xm, pk, y0), A(xm, pk, y1), A(xb, z, y1)];
        mb.quad(f1[0], f1[1], f1[2], f1[3], white, PAT.none, Math.hypot(xm - xa, 1.4), H);
        mb.quad(f2[0], f2[1], f2[2], f2[3], glass, PAT.fullglass, Math.hypot(xb - xm, 1.4), H);
        // 屋上のふた（三角）
        if (out > 0) mb.tri(A(xa, z, y1), A(xb, z, y1), A(xm, pk, y1), flatRoof());
        else mb.tri(A(xb, z, y1), A(xa, z, y1), A(xm, pk, y1), flatRoof());
      }
    }
    roofRim(mb, x0, z0, x1, z1, y1, white, 1.2);
    roofUnits(mb, x0 + 1, z0 + 1, x1 - 1, z1 - 1, y1, rng, 2);
  };
  if (!twin) return one(p.cx, p.cz, Math.min(42, p.size * 0.7), Math.min(26, p.size * 0.48), floors);
  const L = (alongX ? f.W : f.D) - 6, W = Math.min(34, L * 0.42), D = Math.min(24, Math.min(f.W, f.D) * 0.45);
  const off = L * 0.26;
  if (alongX) { one(p.cx - off, p.cz, W, D, floors); one(p.cx + off, p.cz, W, D, Math.round(floors * 0.55)); }
  else { one(p.cx, p.cz - off, W, D, floors); one(p.cx, p.cz + off, W, D, Math.round(floors * 0.55)); }
}

// ガラスの破片の塔（ロンドンのザ・シャードのような）：何枚もの斜めのガラスの面が上で尖り、頂上で面がバラバラに開いて終わる
function shardTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick([C(0x9fb4c4), C(0xa9bccb), C(0x8ea6b8)]);
  const R = Math.min(26, p.size * 0.42), H = floors * OFH * 1.05, n = 8;
  const base: P2[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + Math.PI / 8, r = R * (0.85 + 0.15 * ((k * 37) % 5) / 4);
    base.push([p.cx + Math.cos(a) * r, p.cz + Math.sin(a) * r * 0.8]);
  }
  const topK = 0.12, Hm = H * 0.9;
  mb.prism(base, p.y, p.y + Hm, glass, PAT.fullglass, flatRoof(), scaleP(base, p.cx, p.cz, topK + (1 - topK) * 0.1));
  // 頂上の破片：各面がそのまま上へ伸び、細くなりながら互いに離れて終わる（両面）
  const at = (t: number, k: number): P2 => { const [x, z] = base[k % n], s = 1 + (topK - 1) * t; return [p.cx + (x - p.cx) * s, p.cz + (z - p.cz) * s]; };
  for (let k = 0; k < n; k++) {
    const t0 = 0.9, t1 = 0.98 + 0.08 * ((k * 3) % 4) / 3;
    const a0 = at(t0, k), b0 = at(t0, k + 1), a1 = at(t1, k), b1 = at(t1, k + 1);
    const mx = (a1[0] + b1[0]) / 2, mz = (a1[1] + b1[1]) / 2;
    const ia1: P2 = [a1[0] + (mx - a1[0]) * 0.3, a1[1] + (mz - a1[1]) * 0.3], ib1: P2 = [b1[0] + (mx - b1[0]) * 0.3, b1[1] + (mz - b1[1]) * 0.3];
    const y0 = p.y + H * t0 * (Hm / (H * 0.9)), y1 = p.y + H * t1;
    const q = [[a0[0], y0, a0[1]], [b0[0], y0, b0[1]], [ib1[0], y1, ib1[1]], [ia1[0], y1, ia1[1]]] as [number, number, number][];
    mb.quad(q[0], q[1], q[2], q[3], glass, PAT.fullglass, 6, y1 - y0);
    mb.quad(q[1], q[0], q[3], q[2], glass, PAT.fullglass, 6, y1 - y0);
  }
  // 面の継ぎ目（縦の細い線）は夜に少し光る
  for (let k = 0; k < n; k += 2) {
    const [x, z] = base[k];
    mb.quad([x, p.y, z], [x + (p.cx - x) * 0.02, p.y, z + (p.cz - z) * 0.02], [p.cx + (x - p.cx) * 0.2, p.y + Hm, p.cz + (z - p.cz) * 0.2], [p.cx + (x - p.cx) * 0.21, p.y + Hm, p.cz + (z - p.cz) * 0.21], C(0xdfe6ee), PAT.glow);
  }
}

// 光の冠の塔（サンフランシスコのセールスフォース・タワーのような）：角の丸い四角が上へ少し細くなり、
// 頂部は穴のあいた金属の冠（中は空洞）。夜は冠が LED で色をゆっくり変える
function crownTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick([C(0x9fb0bd), C(0xb3bec7), C(0x8fa3b3)]);
  const S = Math.min(40, p.size * 0.68), H = floors * OFH, Hc = Math.max(18, H * 0.12);
  const plan = rrect(p.cx, p.cz, S, S, S * 0.18, 4);
  const sc = (t: number) => 1 - 0.18 * t;
  // 白い縦の細いひれ（角の丸い四角に沿って）と、ガラスの塔
  mb.prism(plan, p.y, p.y + H, glass, PAT.fullglass, flatRoof(), scaleP(plan, p.cx, p.cz, sc(H / (H + Hc))));
  const topPlan = scaleP(plan, p.cx, p.cz, sc(H / (H + Hc)));
  // 冠：外側は穴のあいた金属（LED）、上へもう少し細くなって、上は開いている
  const crownTop = scaleP(plan, p.cx, p.cz, sc(1) * 0.96);
  mb.prism(scaleP(topPlan, p.cx, p.cz, 1.01), p.y + H, p.y + H + Hc, C(0xd9dde1), PAT.led, null, scaleP(crownTop, p.cx, p.cz, 1.01));
  mb.prism(scaleP(topPlan, p.cx, p.cz, 0.97), p.y + H, p.y + H + Hc * 0.6, C(0x3a4048), PAT.none, C(0x2f3438), scaleP(crownTop, p.cx, p.cz, 0.97));
  mb.prism(scaleP(crownTop, p.cx, p.cz, 1.012), p.y + H + Hc - 0.5, p.y + H + Hc, C(0xe8eef2), PAT.glow, null);
}

// ---- 近代建築（モダニズム）のオフィス ----
// ミース風の黒いガラスの塔（シーグラム・ビルのような）：前は池のある石の広場、塔は奥に下がって立つ。
// 足元は奥まったガラスのロビーと柱、塔はブロンズ色の細い縦のI形鋼が上まで並ぶ黒っぽいガラスの直方体
function miesTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const hw = f.W / 2, hd = f.D / 2;
  const plaza = C(0xc9c2b4), bronze = C(0x4a3a2a), glass = rng.pick([C(0x3c3a33), C(0x3a3f3e), C(0x45433a)]);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, plaza);
  for (let x = -hw + 2; x < hw - 1; x += 3) mb.ground(x, -hd + 0.5, x + 0.06, hd - 0.5, 0.09, C(0xb5ae9f)); // 石の目地
  const W = Math.min(42, f.W * 0.62), D = Math.min(28, f.D * 0.48), H = floors * OFH;
  const cz = -hd + 2 + D / 2 + Math.max(0, (f.D - D) * 0.12);
  const x0 = -W / 2, x1 = W / 2, z0 = cz - D / 2, z1 = cz + D / 2;
  // 広場の前の 2 つの池と、低い石の縁
  const pz0 = z1 + 3, pz1 = hd - 3;
  if (pz1 - pz0 > 5) {
    for (const sx of [-1, 1]) {
      const a = sx < 0 ? -hw + 3 : 4, b = sx < 0 ? -4 : hw - 3;
      if (b - a < 6) continue;
      mb.box(a, 0, pz0, b, 0.55, pz1, C(0xd3ccbe), PAT.none, C(0x4f6d7a));
      for (let x = a + 3; x < b - 2; x += 6) tf(x, pz0 - 1.2, 0.55, 0);
    }
  }
  // 1 階：奥まったガラスのロビー（4m 内側）と、外まわりのブロンズの柱
  const lh = 7.6;
  mb.box(x0 + 3.5, 0, z0 + 3.5, x1 - 3.5, lh, z1 - 3.5, C(0x9fb3b8), PAT.fullglass, bronze);
  for (const [a, b, z] of [[x0, x1, z0], [x0, x1, z1]] as const) for (let x = a; x <= b + 0.01; x += (b - a) / Math.max(2, Math.round((b - a) / 8))) mb.box(x - 0.45, 0, z - 0.45, x + 0.45, lh, z + 0.45, bronze);
  for (const x of [x0, x1]) for (let z = z0; z <= z1 + 0.01; z += (z1 - z0) / Math.max(2, Math.round((z1 - z0) / 8))) mb.box(x - 0.45, 0, z - 0.45, x + 0.45, lh, z + 0.45, bronze);
  // 塔：黒っぽいガラスの箱
  mb.box(x0, lh, z0, x1, H, z1, glass, PAT.curtain, C(0x2e2c28));
  // 縦の I 形鋼（1.6m ごと、外へ少し出る）
  const st = 1.6, out = 0.32;
  for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / Math.round((x1 - x0) / st)) {
    mb.box(x - 0.09, lh, z1, x + 0.09, H - 0.3, z1 + out, bronze);
    mb.box(x - 0.09, lh, z0 - out, x + 0.09, H - 0.3, z0, bronze);
  }
  for (let z = z0; z <= z1 + 0.01; z += (z1 - z0) / Math.round((z1 - z0) / st)) {
    mb.box(x1, lh, z - 0.09, x1 + out, H - 0.3, z + 0.09, bronze);
    mb.box(x0 - out, lh, z - 0.09, x0, H - 0.3, z + 0.09, bronze);
  }
  // 頂部の機械室：2 階ぶんのブロンズのルーバーの帯
  mb.box(x0 - 0.05, H - 2 * OFH, z0 - 0.05, x1 + 0.05, H, z1 + 0.05, C(0x3a2e22), PAT.industrial, C(0x2e2c28));
  mb.box(x0 + 0.2, H - 0.1, z0 + 0.2, x1 - 0.2, H - 0.05, z1 - 0.2, C(0xe8d9b5), PAT.glow, C(0x2e2c28));
}

// レバーハウス型：1 階は細い柱だけで開いた広場（ピロティ）、その上に 1 層の横長のガラスの基壇（中庭つき）。
// 基壇の上に、薄い板のようなガラスの塔が通りと直角に立つ。青緑のガラスとステンレスの細い帯
function leverTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const hw = f.W / 2, hd = f.D / 2;
  const steel = C(0xc9cfd3), glass = rng.pick([C(0x5f9a8f), C(0x5a8f94), C(0x6aa29a)]), dark = C(0x3a4a4c);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, C(0xd8d4cc));
  const PW = f.W - 2, PD = f.D - 2, px0 = -PW / 2, px1 = PW / 2, pz0 = -hd + 1, pz1 = hd - 1;
  const y0 = 5.2, y1 = 9.6; // 基壇の下の面と上の面
  // 中庭（基壇の真ん中の穴）
  const cw = Math.max(0, PW * 0.36), cd = Math.max(0, PD * 0.34), ccz = (pz0 + pz1) / 2 + PD * 0.08;
  const hole: [number, number, number, number] = [-cw / 2, ccz - cd / 2, cw / 2, ccz + cd / 2];
  const ring = (ya: number, yb: number, col: THREE.Color, pat: number, top: THREE.Color) => {
    mb.box(px0, ya, pz0, px1, yb, hole[1], col, pat, top);
    mb.box(px0, ya, hole[3], px1, yb, pz1, col, pat, top);
    mb.box(px0, ya, hole[1], hole[0], yb, hole[3], col, pat, top);
    mb.box(hole[2], ya, hole[1], px1, yb, hole[3], col, pat, top);
  };
  ring(y0, y1, glass, PAT.ribbon, flatRoof());
  ring(y0 - 0.5, y0, steel, PAT.none, steel); // 基壇の底のステンレスの帯
  ring(y1 - 0.25, y1, steel, PAT.none, flatRoof());
  // ピロティの柱と、奥まった小さなガラスのロビー
  for (let x = px0 + 1; x <= px1 - 0.9; x += Math.max(5, PW / 8)) for (const z of [pz0 + 1, pz1 - 1]) mb.box(x - 0.3, 0, z - 0.3, x + 0.3, y0 - 0.5, z + 0.3, steel);
  mb.box(px0 + 4, 0, pz0 + 3, px0 + PW * 0.32, 4.6, pz0 + PD * 0.45, C(0xa9c3c0), PAT.fullglass, steel);
  // 中庭の植え込みと木
  mb.ground(hole[0] + 1, hole[1] + 1, hole[2] - 1, hole[3] - 1, 0.1, PALETTE.lawn);
  tf((hole[0] + hole[2]) / 2, (hole[1] + hole[3]) / 2, 0.65, 0);
  // 板の塔：通りと直角（奥へ長い）。基壇の左寄り
  const TW = Math.min(14, PW * 0.3), TD = Math.min(PD - 4, Math.max(24, PD * 0.78)), H = floors * OFH;
  const tx0 = px0 + 2, tx1 = tx0 + TW, tz0 = pz0 + 2, tz1 = tz0 + TD;
  mb.box(tx0, y1, tz0, tx1, H, tz1, glass, PAT.curtain, flatRoof());
  // 各階のステンレスの細い帯（腰壁）と、角の縦の枠
  for (let y = y1 + OFH; y < H - 0.5; y += OFH) {
    mb.box(tx0 - 0.08, y - 0.35, tz0 - 0.08, tx1 + 0.08, y, tz1 + 0.08, steel);
  }
  for (const [x, z] of [[tx0, tz0], [tx1, tz0], [tx0, tz1], [tx1, tz1]]) mb.box(x - 0.18, y1, z - 0.18, x + 0.18, H, z + 0.18, steel);
  // 屋上の機械室（少し下がった、ステンレスの箱）
  mb.box(tx0 + 1.5, H, tz0 + 2, tx1 - 1.5, H + 2 * OFH, tz1 - 2, dark, PAT.industrial, steel);
  mb.box(tx0 + 1.6, H + 2 * OFH - 0.4, tz0 + 2.1, tx1 - 1.6, H + 2 * OFH - 0.1, tz1 - 2.1, C(0xdfe8ea), PAT.glow, steel);
}

// ブルータリズムの塔：打放しコンクリート。下の段は細く、上の 2 段は外へ張り出す（逆さの段々）。
// 外壁は彫りの深い格子（縦のひれと、各階の厚い床の帯）で、窓は奥まった黒いガラス
function brutalTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const hw = f.W / 2, hd = f.D / 2;
  const conc = rng.pick([C(0xb3afa7), C(0xa9a59d), C(0xbbb6ac)]), concD = conc.clone().multiplyScalar(0.88), win = C(0x2f3436);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, C(0xbdb7ab));
  const cbox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col = conc, top?: THREE.Color) => {
    mb.matOverride = MAT.concrete;
    mb.box(x0, y0, z0, x1, y1, z1, col, PAT.none, top ?? col);
    mb.matOverride = null;
  };
  const S = Math.min(38, Math.min(f.W, f.D) * 0.66), H = floors * OFH, cz = 0;
  // 段：[下の高さ, 上の高さ, 大きさの倍率]
  const tiers: [number, number, number][] = [[0, H * 0.34, 0.74], [H * 0.34, H * 0.68, 0.9], [H * 0.68, H, 1]];
  // 1 階：太いコンクリートの柱（ピロティ）と、奥まったガラスのロビー
  const s0 = S * tiers[0][2];
  mb.box(-s0 / 2 + 2.5, 0, cz - s0 / 2 + 2.5, s0 / 2 - 2.5, 6, cz + s0 / 2 - 2.5, C(0x8a9a9c), PAT.fullglass, concD);
  tiers.forEach(([ya, yb, k], ti) => {
    const s = S * k, x0 = -s / 2, x1 = s / 2, z0 = cz - s / 2, z1 = cz + s / 2;
    const yStart = ti === 0 ? 6 : ya;
    // 奥の黒い窓の箱
    mb.box(x0 + 0.9, yStart, z0 + 0.9, x1 - 0.9, yb, z1 - 0.9, win, PAT.curtain, win);
    // 段の下の面（張り出しの裏）
    if (ti > 0) cbox(x0, ya - 0.9, z0, x1, ya, z1, concD);
    // 各階の厚い床の帯（外へ出る）
    for (let y = yStart; y <= yb + 0.01; y += OFH) {
      const t = 0.55;
      cbox(x0, y - t, z0, x1, y, z0 + 1.0);
      cbox(x0, y - t, z1 - 1.0, x1, y, z1);
      cbox(x0, y - t, z0 + 1.0, x0 + 1.0, y, z1 - 1.0);
      cbox(x1 - 1.0, y - t, z0 + 1.0, x1, y, z1 - 1.0);
    }
    // 縦のひれ（3m ごと、奥行き 1m）
    const n = Math.max(3, Math.round(s / 3));
    for (let i = 0; i <= n; i++) {
      const u = x0 + (s * i) / n, w = i === 0 || i === n ? 0.8 : 0.35;
      cbox(u - w, yStart, z1 - 1.0, u + w, yb, z1);
      cbox(u - w, yStart, z0, u + w, yb, z0 + 1.0);
      const v = z0 + (s * i) / n;
      cbox(x1 - 1.0, yStart, v - w, x1, yb, v + w);
      cbox(x0, yStart, v - w, x0 + 1.0, yb, v + w);
    }
    if (ti === 0) for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) cbox(x - 1.2, 0, z - 1.2, x + 1.2, 6, z + 1.2);
  });
  // 屋上：コンクリートの機械室と階段室
  cbox(-S * 0.25, H, cz - S * 0.2, S * 0.25, H + 2.2 * OFH, cz + S * 0.2, concD);
  cbox(S * 0.28, H, cz - S * 0.1, S * 0.4, H + 3 * OFH, cz + S * 0.05, concD);
  // 前庭の植え込み
  planter(mb, tf, -hw + 1, hd - 3, -S * 0.2, hd - 1.5);
}

// 空中の張り出しの塔（台中銀行本社のような）：ガラスの塔の途中から、芝生と木の載ったガラスの箱が横に大きく飛び出す（高さ違いで2つのことも）
function cantileverTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const glass = rng.pick(GLASS), frame = rng.pick([MW, C(0x5f6a72), C(0xd8d2c4)]);
  const W = Math.min(28, p.size * 0.48), D = Math.min(28, p.size * 0.48), H = floors * OFH;
  const x0 = p.cx - W / 2, x1 = p.cx + W / 2, z0 = p.cz - D / 2, z1 = p.cz + D / 2;
  mb.box(x0, p.y, z0, x1, p.y + H, z1, glass, PAT.curtain, flatRoof());
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) mb.box(x - 0.7, p.y, z - 0.7, x + 0.7, p.y + H + 1.5, z + 0.7, frame);
  roofRim(mb, x0, z0, x1, z1, p.y + H, frame, 1.5);
  const box = (yk: number, side: number, len: number) => {
    const y = p.y + yk * OFH, h = 3 * OFH;
    const [bx0, bx1, bz0, bz1] = side === 0 ? [x1 - 4, x1 + len, z0 + 2, z1 - 2] : side === 1 ? [x0 - len, x0 + 4, z0 + 2, z1 - 2] : [x0 + 2, x1 - 2, z1 - 4, z1 + len];
    mb.box(bx0, y, bz0, bx1, y + h, bz1, MGL, PAT.fullglass, PALETTE.lawn);
    mb.box(bx0 - 0.3, y - 0.8, bz0 - 0.3, bx1 + 0.3, y, bz1 + 0.3, frame, PAT.glow, frame);
    // 斜めの支え
    const sx = side === 0 ? x1 : side === 1 ? x0 : (bx0 + bx1) / 2, sz = side === 2 ? z1 : (bz0 + bz1) / 2;
    const ex = side === 0 ? bx1 - 1 : side === 1 ? bx0 + 1 : sx, ez = side === 2 ? bz1 - 1 : sz;
    for (const d of [-4, 4]) {
      const ox = side === 2 ? d : 0, oz = side === 2 ? 0 : d;
      mb.quad([sx + ox - 0.3, y - 12, sz + oz - 0.3], [sx + ox + 0.3, y - 12, sz + oz + 0.3], [ex + ox + 0.3, y - 0.8, ez + oz + 0.3], [ex + ox - 0.3, y - 0.8, ez + oz - 0.3], frame);
    }
    // 屋上の空中庭園
    for (let k = 0; k < 4; k++) tf(bx0 + 2 + rng.next() * (bx1 - bx0 - 4), bz0 + 2 + rng.next() * (bz1 - bz0 - 4), 0.6 + rng.next() * 0.3, 0, y + h);
    mb.box(bx0, y + h, bz1 - 0.12, bx1, y + h + 1.1, bz1, C(0x9fc4d0));
  };
  const len = Math.min(12, (p.size - W) / 2 + 4);
  box(Math.round(floors * 0.62), rng.int(2), len);
  if (floors >= 30) box(Math.round(floors * 0.32), 2, Math.min(9, len));
}

// 花びらの塔（麻布台ヒルズ森JPタワーのような）：角の丸い四角。足元はすぼまり、中ほどがいちばん太く、上へ細くなる。
// 真珠色のガラス。頂部は4枚の花びらのように、ガラスの面が外へ反りながら伸びる（ふちは夜に光る）
function lotusTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const pearl = rng.pick([C(0xbcc6cd), C(0xc7ced3), C(0xaebcc8)]);
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const S = Math.min(46, p.size * 0.72), fh = 3.8;
  const plan = rrect(p.cx, p.cz, S, S, S * 0.2, 4);
  const sc = (t: number) => (t < 0.28 ? 0.8 + 0.2 * Math.sin((t / 0.28) * Math.PI / 2) : 1 - 0.24 * Math.pow((t - 0.28) / 0.72, 1.3));
  const NS = 9, per = Math.max(1, Math.round(floors / NS));
  let y = p.y, fl = 0;
  for (let k = 0; k < NS && fl < floors; k++) {
    const n = k === NS - 1 ? floors - fl : Math.min(per, floors - fl);
    const t0 = fl / floors, t1 = (fl + n) / floors;
    mb.prism(scaleP(plan, p.cx, p.cz, sc(t0)), y, y + n * fh, pearl, PAT.fullglass, flatRoof(), scaleP(plan, p.cx, p.cz, sc(t1)));
    y += n * fh;
    fl += n;
  }
  const half = (S * sc(1)) / 2, Hc = Math.min(22, floors * 0.4);
  // 屋上の機械を隠す低い壁
  mb.prism(scaleP(plan, p.cx, p.cz, sc(1) * 0.9), y, y + 3, MW2, PAT.industrial, flatRoof());
  // 花びら（両面から見えるように表と裏を貼る）
  const NU = 6, NV = 6;
  for (const [nx, nz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    const tx = -nz, tz = nx;
    const P = (u: number, v: number): [number, number, number] => {
      const w = half * 0.68 * (1 - 0.55 * Math.pow(v, 1.6)), o = 5 * v * v - 0.4;
      return [p.cx + nx * (half + o) + tx * u * w, y + v * Hc, p.cz + nz * (half + o) + tz * u * w];
    };
    for (let i = 0; i < NU; i++)
      for (let j = 0; j < NV; j++) {
        const u0 = -1 + (2 * i) / NU, u1 = -1 + (2 * (i + 1)) / NU, v0 = j / NV, v1 = (j + 1) / NV;
        const a = P(u0, v0), b = P(u1, v0), c = P(u1, v1), d = P(u0, v1);
        mb.quad(a, b, c, d, pearl, PAT.fullglass, 2 * half / NU, Hc / NV);
        mb.quad(b, a, d, c, pearl, PAT.fullglass, 2 * half / NU, Hc / NV);
      }
    // 花びらのふち（夜に光る）
    for (let i = 0; i < NU; i++) {
      const a = P(-1 + (2 * i) / NU, 1), b = P(-1 + (2 * (i + 1)) / NU, 1);
      mb.box(Math.min(a[0], b[0]) - 0.15, a[1] - 0.3, Math.min(a[2], b[2]) - 0.15, Math.max(a[0], b[0]) + 0.15, a[1] + 0.1, Math.max(a[2], b[2]) + 0.15, C(0xe8f0f6), PAT.glow);
    }
  }
}

// 角が段々に欠ける塔：十字形の平面で、上の段ほど角の欠けが深く、少し細くなる。段の上は光る帯、頂上はガラスのランタンと尖塔
function notchTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean) {
  const glass = office ? rng.pick(GLASS) : rng.pick(TOWER_WALL), trim = rng.pick([MW, C(0xd8d2c4), C(0x5f6a72)]);
  const p = podiumBase(mb, f, rng, tf, trim, floors);
  const fh = office ? 3.8 : 3.1, pat = office ? (rng.next() < 0.5 ? PAT.curtain : PAT.fullglass) : resPat;
  const S0 = Math.min(42, p.size * 0.72), frac = [0.4, 0.27, 0.2, 0.13], notch = [0.08, 0.15, 0.22, 0.29];
  let y = p.y, fl = 0;
  for (let k = 0; k < 4; k++) {
    const n = k === 3 ? floors - fl : Math.round(floors * frac[k]);
    if (n <= 0) continue;
    const S = S0 * (1 - k * 0.06), nd = S * notch[k], h = n * fh;
    const x0 = p.cx - S / 2, x1 = p.cx + S / 2, z0 = p.cz - S / 2, z1 = p.cz + S / 2;
    mb.box(x0, y, z0 + nd, x1, y + h, z1 - nd, glass, pat, flatRoof());
    mb.box(x0 + nd, y, z0, x1 - nd, y + h, z1, glass, pat, flatRoof());
    // 欠けた角の内側の縦の柱
    for (const [cx, cz] of [[x0 + nd, z0 + nd], [x1 - nd, z0 + nd], [x0 + nd, z1 - nd], [x1 - nd, z1 - nd]]) mb.box(cx - 0.5, y, cz - 0.5, cx + 0.5, y + h, cz + 0.5, trim);
    y += h;
    fl += n;
    // 段の上の帯（夜に光る）
    mb.box(x0 + nd - 0.2, y, z0 - 0.2, x1 - nd + 0.2, y + 0.7, z1 + 0.2, trim, PAT.glow);
    mb.box(x0 - 0.2, y, z0 + nd - 0.2, x1 + 0.2, y + 0.7, z1 - nd + 0.2, trim, PAT.glow);
  }
  // ガラスのランタンと尖塔
  const L = S0 * 0.28;
  mb.box(p.cx - L / 2, y + 0.7, p.cz - L / 2, p.cx + L / 2, y + 7, p.cz + L / 2, C(0xdfe8ef), PAT.glow, trim);
  spire(mb, p.cx, p.cz, y + 7, 14 + rng.next() * 18);
}

function spire(mb: MeshBuilder, cx: number, cz: number, y: number, h: number) {
  // 避雷針・アンテナ：細く短く（指定の高さの 3 割ほど、最大 9m）
  const hh = Math.min(9, Math.max(3.5, h * 0.3));
  mb.cylinder(cx, cz, y, y + 0.6, 0.35, 8, PALETTE.steel, PALETTE.steel, 0.25);
  mb.cylinder(cx, cz, y + 0.6, y + hh, 0.14, 6, PALETTE.steel, PALETTE.steel, 0.04);
}

// ねじれた塔：階ごとに少しずつ回る
function twistedTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const glass = rng.pick(GLASS), frame = rng.pick([PALETTE.white, PALETTE.steel, PALETTE.concrete]);
  const p = podiumBase(mb, f, rng, tf, frame, floors);
  const fh = 3.8, segF = 2;
  const side = Math.min(36, p.size * 0.62);
  const twist = (0.7 + rng.next() * 0.7) * (rng.next() < 0.5 ? 1 : -1);
  const segs = Math.ceil(floors / segF);
  let y = p.y;
  for (let k = 0; k < segs; k++) {
    const t = k / segs;
    const sd = side * (1 - 0.22 * t);
    const pts = rect(p.cx, p.cz, sd, sd, twist * t);
    const h = Math.min(segF, floors - k * segF) * fh;
    mb.prism(pts, y, y + h, glass, officePat, k === segs - 1 ? flatRoof() : null);
    mb.prism(scaleP(pts, p.cx, p.cz, 1.025), y + h - 0.3, y + h, frame, PAT.none, k === segs - 1 ? flatRoof() : null);
    y += h;
  }
  const top = rect(p.cx, p.cz, side * 0.5, side * 0.5, twist);
  mb.prism(top, y, y + 6, frame, PAT.ribbon, flatRoof());
  mb.prism(scaleP(top, p.cx, p.cz, 1.02), y + 5.6, y + 6.2, C(0xdfe6ee), PAT.glow, flatRoof());
  spire(mb, p.cx, p.cz, y + 6, 14 + rng.next() * 16);
}

// 先細りの八角形の塔と、斜めのガラスの頂部
function taperedTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const glass = rng.pick(GLASS), frame = rng.pick([PALETTE.white, PALETTE.steel]);
  const p = podiumBase(mb, f, rng, tf, frame, floors);
  const fh = 3.8;
  const R = Math.min(20, p.size * 0.38);
  const H = floors * fh;
  const rot = Math.PI / 8;
  const base = ngon(p.cx, p.cz, R, 8, rot);
  // 3段に分けて、少しずつ細くする（段の境目に帯）
  let y = p.y, k0 = 1;
  for (let s = 0; s < 3; s++) {
    const h = H * (s === 2 ? 0.3 : 0.35);
    const k1 = k0 - 0.14;
    mb.prism(scaleP(base, p.cx, p.cz, k0), y, y + h, glass, officePat, null, scaleP(base, p.cx, p.cz, k1));
    mb.prism(scaleP(base, p.cx, p.cz, k1 + 0.02), y + h - 0.4, y + h + 0.2, frame, PAT.none, s === 2 ? null : flatRoof());
    y += h;
    k0 = k1;
  }
  // 斜めに切ったガラスの頂部
  const crown = scaleP(base, p.cx, p.cz, k0);
  const ch = R * 0.9;
  mb.prism(crown, y, y + ch, glass, PAT.none, glass, undefined, crown.map(([x]) => y + ((x - p.cx) / R + 1) * 0.5 * ch + 1));
  spire(mb, p.cx + R * k0 * 0.5, p.cz, y + ch, 10 + rng.next() * 12);
}

// 段々の塔（アールデコ風）：上に行くほど細くなり、段ごとに飾りの帯
function steppedTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean) {
  const wall = rng.pick(TOWER_WALL), trim = rng.pick([C(0xe8e2d2), C(0x8c7a5c), C(0x5f6a72)]);
  const p = podiumBase(mb, f, rng, tf, wall, floors);
  const fh = office ? 3.7 : 3.1;
  const pat = office ? officePat : resPat;
  const widths = [1, 0.82, 0.66, 0.5, 0.34], frac = [0.36, 0.26, 0.18, 0.12, 0.08];
  const S = Math.min(38, p.size * 0.7);
  let y = p.y;
  for (let k = 0; k < widths.length; k++) {
    const s = S * widths[k];
    const h = floors * fh * frac[k];
    const x0 = p.cx - s / 2, x1 = p.cx + s / 2, z0 = p.cz - s / 2, z1 = p.cz + s / 2;
    mb.box(x0, y, z0, x1, y + h, z1, wall, pat, flatRoof());
    // 角の柱と、段の上の帯
    for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) mb.box(px - 0.6, y, pz - 0.6, px + 0.6, y + h + 0.8, pz + 0.6, trim, PAT.none, trim);
    roofRim(mb, x0, z0, x1, z1, y + h, trim, 1.2);
    if (k < widths.length - 1) roofUnits(mb, x0, z0, x1, z1, y + h, rng, 1);
    y += h;
  }
  spire(mb, p.cx, p.cz, y, 20 + rng.next() * 25);
}

// 円筒形の塔：階ごとの白い帯と、細い頂部
function roundTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean) {
  const glass = office ? rng.pick(GLASS) : rng.pick(TOWER_WALL), band = rng.pick([PALETTE.white, C(0xd9d4c7), PALETTE.steel]);
  const p = podiumBase(mb, f, rng, tf, band, floors);
  const fh = office ? 3.8 : 3.1;
  const R = Math.min(18, p.size * 0.36);
  const poly = ngon(p.cx, p.cz, R, 20);
  const step = 4;
  let y = p.y;
  for (let k = 0; k < floors; k += step) {
    const h = Math.min(step, floors - k) * fh;
    mb.prism(poly, y, y + h, glass, office ? officePat : resPat, null);
    mb.prism(ngon(p.cx, p.cz, R + 0.5, 20), y + h - 0.35, y + h + 0.05, band, PAT.none, null);
    y += h;
  }
  mb.prism(poly, y, y, glass, PAT.none, flatRoof());
  mb.prism(ngon(p.cx, p.cz, R * 0.55, 20), y, y + 7, band, PAT.ribbon, flatRoof());
  mb.prism(ngon(p.cx, p.cz, R * 0.57, 20), y + 6.4, y + 7.1, C(0xdfe6ee), PAT.glow, flatRoof());
  if (floors >= 40) spire(mb, p.cx, p.cz, y + 7, 18 + rng.next() * 20);
}

// 屋上を斜めに切った塔と、縦のひれ
function wedgeTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const glass = rng.pick(GLASS), frame = rng.pick([PALETTE.white, PALETTE.steel, PALETTE.dark]);
  const p = podiumBase(mb, f, rng, tf, frame, floors);
  const fh = 3.8;
  const w = Math.min(40, p.size * 0.72), d = Math.min(26, p.size * 0.5);
  const H = floors * fh;
  const pts = rect(p.cx, p.cz, w, d);
  const cut = Math.min(40, H * 0.14);
  // 正面（+z）側が高く、後ろに向かって下がる
  mb.prism(pts, p.y, p.y + H, glass, officePat, glass, undefined, pts.map(([, z]) => p.y + H - cut * (0.5 - (z - p.cz) / d)));
  // 縦のひれ（両側面）
  for (const sx of [-1, 1]) mb.box(p.cx + sx * (w / 2) - 0.4, p.y, p.cz - d / 2 - 1.2, p.cx + sx * (w / 2) + 0.4, p.y + H - cut * 0.2, p.cz + d / 2 + 1.2, frame);
}

// ふたごの塔と空中の連絡通路
function twinTowers(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const glass = rng.pick(GLASS), frame = rng.pick([PALETTE.white, PALETTE.steel, PALETTE.concrete]);
  const p = podiumBase(mb, f, rng, tf, frame, floors);
  const fh = 3.8, H = floors * fh;
  const s = Math.min(18, (f.W - 6) * 0.36);
  const gap = Math.max(6, f.W - 6 - 2 * s) * 0.6;
  const octa = rng.next() < 0.5;
  for (const sx of [-1, 1]) {
    const cx = p.cx + sx * (gap / 2 + s / 2);
    const poly = octa ? ngon(cx, p.cz, s / 2, 8, Math.PI / 8) : rect(cx, p.cz, s, s);
    mb.prism(poly, p.y, p.y + H * 0.9, glass, officePat, flatRoof(), scaleP(poly, cx, p.cz, 0.92));
    mb.prism(scaleP(poly, cx, p.cz, 0.7), p.y + H * 0.9, p.y + H, frame, PAT.industrial, flatRoof());
    spire(mb, cx, p.cz, p.y + H, 12 + rng.next() * 8);
  }
  // 連絡通路（2階分）
  const by = p.y + H * 0.45;
  mb.box(p.cx - gap / 2 - 1, by, p.cz - 3, p.cx + gap / 2 + 1, by + 7, p.cz + 3, frame, officePat, flatRoof());
}

// 香港のような十字形の高層集合住宅を、低層部の上に 1〜4 棟
function crossTowers(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) {
  const pastel = [0xeae3d2, 0xe9c9c0, 0xc9d9e6, 0xf2eee6, 0xd8e2c8, 0xe6d6a8].map(C);
  const wall = rng.pick(pastel), base = rng.pick(PALETTE.shopWall);
  const p = podiumBase(mb, f, rng, tf, base, 20);
  const fh = 2.9, H = floors * fh;
  const nx = f.W >= 44 ? 2 : 1, nz = f.D >= 44 ? 2 : 1;
  const cellW = (f.W - 4) / nx, cellD = (f.D - 6) / nz;
  const arm = Math.min(9, Math.min(cellW, cellD) * 0.3), span = Math.min(cellW, cellD) * 0.86;
  for (let ix = 0; ix < nx; ix++)
    for (let iz = 0; iz < nz; iz++) {
      const cx = -f.W / 2 + 2 + cellW * (ix + 0.5), cz = p.cz - (f.D - 6) / 2 + cellD * (iz + 0.5);
      const h = H * (0.85 + rng.next() * 0.15);
      const top = p.y + h;
      // 十字形：横長の箱と、その前後に伸びる翼
      mb.box(cx - span / 2, p.y, cz - arm / 2, cx + span / 2, top, cz + arm / 2, wall, resPat, flatRoof());
      mb.box(cx - arm / 2, p.y, cz - span / 2, cx + arm / 2, top, cz - arm / 2, wall, resPat, flatRoof());
      mb.box(cx - arm / 2, p.y, cz + arm / 2, cx + arm / 2, top, cz + span / 2, wall, resPat, flatRoof());
      // へこみ（採光の溝）に沿った縦の線
      for (const [px, pz] of [[cx - arm / 2, cz - arm / 2], [cx + arm / 2, cz - arm / 2], [cx - arm / 2, cz + arm / 2], [cx + arm / 2, cz + arm / 2]])
        mb.box(px - 0.25, p.y, pz - 0.25, px + 0.25, top + 0.6, pz + 0.25, PALETTE.white);
      roofRim(mb, cx - span / 2, cz - arm / 2, cx + span / 2, cz + arm / 2, top, wall, 1.0);
      // 屋上の給水タンクと飾りの枠
      mb.box(cx - arm / 2 + 0.5, top, cz - arm / 2 + 0.5, cx + arm / 2 - 0.5, top + 4, cz + arm / 2 - 0.5, PALETTE.concrete, PAT.industrial, flatRoof());
      mb.box(cx - span / 2 + 1, top, cz - 1, cx - span / 2 + 3, top + 2.2, cz + 1, PALETTE.white);
      mb.box(cx + span / 2 - 3, top, cz - 1, cx + span / 2 - 1, top + 2.2, cz + 1, PALETTE.white);
    }
}

// ---------------- 公共交通 ----------------
function busStop(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.09, PALETTE.pavement);
  const z = f.D / 2 - 2.5;
  // 屋根つきの待合所とベンチ、標識
  for (const x of [-2.2, 2.2]) mb.box(x - 0.08, 0, z - 0.9, x + 0.08, 2.6, z - 0.75, PALETTE.steel);
  mb.box(-2.4, 0, z - 1.0, 2.4, 2.4, z - 0.92, PALETTE.glass);
  mb.box(-2.6, 2.6, z - 1.2, 2.6, 2.8, z + 0.6, PALETTE.steel);
  mb.box(-1.6, 0, z - 0.8, 1.6, 0.5, z - 0.3, PALETTE.wood);
  mb.box(3.2, 0, z + 0.8, 3.32, 3, z + 0.92, PALETTE.steel);
  mb.box(2.9, 2.4, z + 0.8, 3.62, 3.1, z + 0.95, PALETTE.accent[2]);
}

// 駅：駅舎と、線路の高さのホーム（地上の駅は lift = 0）
function station(mb: MeshBuilder, f: LotFrame, lift: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.09, PALETTE.pavement);
  if (lift) {
    // 高架駅：駅舎は線路の下（railLayer の StationLayer）。敷地は駅前広場（ロータリー、植え込み、時計の柱）
    mb.ground(-f.W / 2 + 2, -f.D / 2 + 4, f.W / 2 - 2, f.D / 2 - 2, 0.11, PALETTE.asphalt);
    mb.cylinder(0, 1, 0, 0.5, Math.min(f.W, f.D) * 0.18, 16, PALETTE.hedge, PALETTE.lawn2);
    mb.box(-0.2, 0.5, 0.8, 0.2, 5, 1.2, PALETTE.steel);
    mb.box(-0.6, 4.4, 0.6, 0.6, 5.4, 1.4, PALETTE.white);
    // 屋根つきの歩道（線路の側へ）
    mb.box(-f.W / 2 + 1, 2.9, -f.D / 2 + 0.3, f.W / 2 - 1, 3.1, -f.D / 2 + 3.5, PALETTE.roof[3]);
    for (const x of [-f.W / 2 + 1.5, 0, f.W / 2 - 1.5]) mb.box(x - 0.1, 0, -f.D / 2 + 3.2, x + 0.1, 2.9, -f.D / 2 + 3.4, PALETTE.steel);
    // バス・タクシー乗り場の印
    for (let x = -f.W / 2 + 3; x < f.W / 2 - 3; x += 3) mb.ground(x, f.D / 2 - 4, x + 0.15, f.D / 2 - 2.5, 0.13, PALETTE.white);
    return;
  }
  const wall = PALETTE.shopWall[2];
  // 駅舎
  mb.box(-f.W / 2 + 2, 0, 0, f.W / 2 - 2, 6, f.D / 2 - 3, wall, PAT.shop, PALETTE.steel);
  mb.box(-f.W / 2 + 1, 6, -1, f.W / 2 - 1, 6.5, f.D / 2 - 2, PALETTE.steel);
  mb.box(-3, 4.6, f.D / 2 - 3, 3, 5.6, f.D / 2 - 2.8, PALETTE.accent[2]);
  // ホームは線路の側に、上り・下りの両方を描く（railLayer の StationLayer）。駅舎からホームへの通路だけ置く
  mb.box(-3, 0.6, -f.D / 2 + 0.3, 3, 1.0, 0, PALETTE.concrete);
  mb.box(-3, 3.8, -f.D / 2 + 0.3, 3, 4.0, 0, PALETTE.roof[3]);
}

function subwayEntrance(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.09, PALETTE.pavement);
  // 地下への階段の囲いと屋根、目印の柱
  mb.box(-2.2, 0, -3, -1.9, 1.1, 3, PALETTE.steel);
  mb.box(1.9, 0, -3, 2.2, 1.1, 3, PALETTE.steel);
  mb.ground(-1.9, -3, 1.9, 3, 0.05, PALETTE.dark);
  mb.box(-2.4, 2.6, -3.2, 2.4, 2.9, 1.5, PALETTE.glass);
  for (const [x, z] of [[-2.3, -3], [2.3, -3], [-2.3, 1.4], [2.3, 1.4]]) mb.box(x - 0.08, 0, z - 0.08, x + 0.08, 2.6, z + 0.08, PALETTE.steel);
  mb.box(3.2, 0, 3, 3.45, 3.6, 3.25, PALETTE.steel);
  mb.box(2.9, 3.6, 2.9, 3.75, 4.5, 3.35, PALETTE.accent[0]);
}

// ---------------- 水運と空 ----------------
// 小さな船（docked = 停泊中）
export function boat(mb: MeshBuilder, x: number, z: number, len: number, wid: number, car: boolean, y = -0.2) {
  mb.box(x - wid / 2, y - 1, z - len / 2, x + wid / 2, y + 1.6, z + len / 2, PALETTE.white);
  mb.box(x - wid / 2 + 0.2, y + 1.6, z - len / 2 + 0.6, x + wid / 2 - 0.2, y + 1.75, z + len / 2 - 0.6, car ? PALETTE.dark : PALETTE.pavement);
  mb.box(x - wid / 2 + 0.6, y + 1.6, z - len / 4, x + wid / 2 - 0.6, y + (car ? 5 : 4), z + len / 6, PALETTE.white, PAT.apartment);
  mb.box(x - wid / 2 + 0.1, y + 0.6, z - len / 2, x + wid / 2 - 0.1, y + 1.0, z + len / 2, PALETTE.accent[2]);
}

function ferryTerminal(mb: MeshBuilder, f: LotFrame, car: boolean) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.09, car ? PALETTE.asphalt : PALETTE.pavement);
  // 待合所（道路側）
  mb.box(-f.W / 2 + 2, 0, 1, f.W / 2 - 2, car ? 6 : 5, f.D / 2 - 2, PALETTE.white, PAT.shop, PALETTE.roof[3]);
  mb.box(-3, 4, f.D / 2 - 2, 3, 4.8, f.D / 2 - 1.8, PALETTE.accent[2]);
  // 桟橋（水側に張り出す）
  const pw = car ? 6 : 3;
  mb.box(-pw / 2, -3, -f.D / 2 - 14, pw / 2, 0.4, -f.D / 2 + 1, PALETTE.concrete);
  for (const z of [-f.D / 2 - 12, -f.D / 2 - 6]) for (const x of [-pw / 2, pw / 2]) mb.box(x - 0.3, -6, z - 0.3, x + 0.3, 0.4, z + 0.3, PALETTE.concrete);
  if (car) for (let x = -f.W / 2 + 2; x < f.W / 2 - 2; x += 2.8) mb.ground(x, -f.D / 2 + 1, x + 0.15, 0, 0.12, PALETTE.white);
}

function seaport(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.concrete);
  // 岸壁（水側）
  mb.box(-f.W / 2, -4, -f.D / 2 - 4, f.W / 2, 0.3, -f.D / 2 + 0.5, PALETTE.concrete);
  // コンテナの山
  const cols = [0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b, 0x7f8c8d, 0xd35400].map((h) => new THREE.Color(h));
  for (let row = 0; row < 4; row++)
    for (let k = 0; k < 6; k++) {
      const x = -f.W / 2 + 6 + k * 8, z = -6 + row * 5;
      const hgt = 1 + rng.int(3);
      for (let lv = 0; lv < hgt; lv++) mb.box(x, lv * 2.6, z, x + 6, lv * 2.6 + 2.5, z + 2.4, rng.pick(cols));
    }
  // 岸壁クレーン（ガントリークレーン）2基
  for (const cx of [-f.W / 4, f.W / 4]) {
    for (const x of [cx - 5, cx + 5]) for (const z of [-f.D / 2 + 1, -f.D / 2 + 9]) mb.box(x - 0.5, 0, z - 0.5, x + 0.5, 26, z + 0.5, PALETTE.accent[0]);
    mb.box(cx - 6, 26, -f.D / 2 - 18, cx + 6, 28.5, -f.D / 2 + 12, PALETTE.accent[0]);
  }
  // 倉庫
  mb.box(-f.W / 2 + 3, 0, f.D / 2 - 14, f.W / 2 - 3, 9, f.D / 2 - 3, PALETTE.indWall[1], PAT.dock, PALETTE.steel);
  // 貨物船は外洋から行き来する（propsLayer）
}

// コンテナ船（船首が +z、長さ len m）
export function containerShip(mb: MeshBuilder, len: number, seed = 1) {
  const rng = new Rng(seed);
  const w = len * 0.15, h = len / 2;
  const hull = new THREE.Color(0x1f3550), red = new THREE.Color(0x8e2b22);
  // 船体（喫水線の下は赤、上は紺）。船首は段々に細くする
  mb.box(-w / 2, -3, -h, w / 2, -0.2, h - w, red);
  mb.box(-w / 2, -0.2, -h, w / 2, 4, h - w, hull);
  for (let k = 0; k < 3; k++) {
    const ww = w * (0.8 - k * 0.25), z0 = h - w + k * (w / 3);
    mb.box(-ww / 2, -2.5, z0, ww / 2, 4.2, z0 + w / 3, hull);
  }
  mb.box(-w / 2 + 0.3, 4, -h + 0.3, w / 2 - 0.3, 4.3, h - w, PALETTE.dark);
  // コンテナ（列ごとに積む）
  const cols = [0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b, 0x7f8c8d, 0xd35400, 0xe8e8e8].map((c) => new THREE.Color(c));
  const bay = 6.4;
  for (let z = -h + len * 0.2; z + bay < h - w; z += bay + 0.4)
    for (let x = -w / 2 + 0.6; x + 2.5 <= w / 2 - 0.5; x += 2.5) {
      const lv = 2 + rng.int(3);
      for (let k = 0; k < lv; k++) mb.box(x, 4.3 + k * 2.6, z, x + 2.4, 4.3 + k * 2.6 + 2.5, z + bay, rng.pick(cols));
    }
  // 船橋（船尾）と煙突
  const b0 = -h + len * 0.06, b1 = -h + len * 0.16;
  mb.box(-w / 2 + 0.4, 4.3, b0, w / 2 - 0.4, 16, b1, PALETTE.white, PAT.apartment);
  mb.box(-w / 2 - 1, 15, b1 - 3, w / 2 + 1, 16.5, b1, PALETTE.white);
  mb.box(-1.5, 16, b0, 1.5, 21, b0 + 3, red);
}

// 飛行機（停まっているもの）
// 飛んでいる旅客機（鼻先が +z）
export function plane(mb: MeshBuilder, x: number, z: number, s: number, y = 0) {
  const box = (a0: number, y0: number, c0: number, a1: number, y1: number, c1: number, col: THREE.Color) => mb.box(x + a0 * s, y + y0 * s, z + c0 * s, x + a1 * s, y + y1 * s, z + c1 * s, col);
  const W = PALETTE.white;
  box(-1.9, 1.4, -17, 1.9, 5.2, 17, W);
  box(-1.5, 1.8, 17, 1.5, 4.6, 19.5, W);
  box(-1.0, 3.6, 18.6, 1.0, 4.4, 19.6, PALETTE.dark);
  box(-1.95, 3.7, -15, 1.95, 4.15, 16, new THREE.Color(0x2a3440));
  box(-1.96, 2.0, -15, 1.96, 2.4, 16, PALETTE.accent[2]);
  box(-17, 2.4, -3, 17, 3.0, 5, W);
  box(-6.5, 4.6, -18, 6.5, 5.0, -14.5, W);
  box(-0.3, 5.0, -19, 0.3, 12, -13.5, PALETTE.accent[2]);
  for (const e of [-7, 7]) box(e - 1.2, 0.9, 0, e + 1.2, 2.5, 5.5, PALETTE.steel);
}

// 空港の配置（敷地の長い方向に滑走路）。ローカル座標：a = 長い方向、c = 短い方向（+c が道路・ターミナルの側）
// 短い方向は、滑走路 → 誘導路 → エプロン（駐機場）→ ターミナル → 駐車場 の帯に分けて、重ならないようにする
export function airportLayout(W: number, D: number, size: number) {
  const alongX = W >= D;
  const A = alongX ? W : D, C = alongX ? D : W;
  const big = size === 2;
  const s = big ? 1.5 : 1.0; // 旅客機の大きさ
  const rwW = big ? 46 : 30; // 滑走路の幅（m）
  const rc = -C / 2 + (big ? 10 : 8) + rwW / 2; // 滑走路の中心
  const ra0 = -A / 2 + 30, ra1 = A / 2 - 30; // 滑走路の両端
  const tw = big ? 18 : 12; // 誘導路の幅
  const tc = rc + rwW / 2 + (big ? 45 : 30) + tw / 2; // 平行誘導路の中心
  const apC0 = tc + tw / 2 + (big ? 6 : 5); // エプロンの始まり
  const termC0 = apC0 + 40 * s + 16; // ターミナルの正面（エプロンの終わり）
  const termC1 = Math.min(C / 2 - 12, termC0 + (big ? 32 : 20)); // ターミナルの裏
  const P = (a: number, c: number): [number, number] => (alongX ? [a, c] : [c, a]);
  return { alongX, A, C, big, s, rwW, rc, ra0, ra1, tw, tc, apC0, termC0, termC1, P };
}

// 旅客機（鼻先が +c 向き）
function jet(L: ReturnType<typeof longAxis>, a: number, c: number, s: number, tail: THREE.Color, dir = 1) {
  const q = (v: number) => c + v * s * dir;
  const box = (a0: number, y0: number, c0: number, a1: number, y1: number, c1: number, col: THREE.Color) =>
    L.box(a + a0 * s, y0 * s, Math.min(q(c0), q(c1)), a + a1 * s, y1 * s, Math.max(q(c0), q(c1)), col);
  const W = PALETTE.white, G = PALETTE.steel;
  box(-1.9, 1.4, -17, 1.9, 5.2, 17, W); // 胴体
  box(-1.5, 1.8, 17, 1.5, 4.6, 19.5, W); // 機首
  box(-1.0, 3.6, 18.6, 1.0, 4.4, 19.6, PALETTE.dark); // 操縦席の窓
  box(-1.95, 3.7, -15, 1.95, 4.15, 16, new THREE.Color(0x2a3440)); // 客室の窓の帯
  box(-1.96, 2.0, -15, 1.96, 2.4, 16, tail); // 胴体の帯
  box(-17, 2.4, -3, 17, 3.0, 5, W); // 主翼
  box(-6.5, 4.6, -18, 6.5, 5.0, -14.5, W); // 水平尾翼
  box(-0.3, 5.0, -19, 0.3, 12, -13.5, tail); // 垂直尾翼
  for (const e of [-7, 7]) box(e - 1.2, 0.9, 0, e + 1.2, 2.5, 5.5, G); // エンジン
  box(-0.4, 0, 12, 0.4, 1.4, 13, PALETTE.dark); // 前脚
  for (const e of [-3, 3]) box(e - 0.6, 0, -1, e + 0.6, 1.4, 1, PALETTE.dark);
}

function airport(mb: MeshBuilder, f: LotFrame, rng: Rng, size: number, tf: TF) {
  const L = longAxis(mb, f, tf);
  const Y = airportLayout(f.W, f.D, size);
  const { A, C: CW, big, s, rwW, rc, ra0, ra1, tw, tc, apC0, termC0, termC1 } = Y;
  const grass = C(0x7fa357), grass2 = C(0x8fb062), asph = C(0x3b3e42), shoulder = C(0x5f6266), conc = C(0xb9b6ae), yel = C(0xe3b62e), W = PALETTE.white;
  const ln = (a0: number, c0: number, a1: number, c1: number, col = W) => L.ground(Math.min(a0, a1), Math.min(c0, c1), Math.max(a0, a1), Math.max(c0, c1), 0.13, col);
  // 草地（刈り込みのしま）
  L.ground(-A / 2 + 0.2, -CW / 2 + 0.2, A / 2 - 0.2, CW / 2 - 0.2, 0.05, grass);
  for (let a = -A / 2 + 6; a < A / 2 - 6; a += 32) L.ground(a, -CW / 2 + 1, a + 16, apC0 - 2, 0.06, grass2);
  // ---- 滑走路 ----
  L.ground(ra0 - 8, rc - rwW / 2 - 5, ra1 + 8, rc + rwW / 2 + 5, 0.08, shoulder);
  L.ground(ra0, rc - rwW / 2, ra1, rc + rwW / 2, 0.1, asph);
  ln(ra0, rc - rwW / 2 + 0.8, ra1, rc - rwW / 2 + 1.6);
  ln(ra0, rc + rwW / 2 - 1.6, ra1, rc + rwW / 2 - 0.8);
  for (let a = ra0 + 60; a < ra1 - 60; a += 40) ln(a, rc - 0.5, a + 24, rc + 0.5);
  for (const [end, dir] of [[ra0, 1], [ra1, -1]] as const) {
    const keys = big ? 12 : 8, kw = (rwW - 8) / keys;
    for (let k = 0; k < keys; k++) {
      const c0 = rc - rwW / 2 + 4 + k * kw + kw * 0.2;
      ln(end + dir * 4, c0, end + dir * 40, c0 + kw * 0.6);
    }
    // 滑走路の番号（太い線で簡単に）
    const na = end + dir * 50;
    ln(na, rc - 6, na + dir * 18, rc - 4.2);
    ln(na, rc + 1.2, na + dir * 18, rc + 3);
    ln(na, rc + 1.2, na + dir * 1.8, rc + 6);
    ln(na + dir * 16.2, rc + 1.2, na + dir * 18, rc + 6);
    // 接地帯の印と目標点
    for (let k = 0; k < (big ? 3 : 2); k++) {
      const za = end + dir * (100 + k * 50);
      for (const sd of [-1, 1]) ln(za, rc + sd * 8 - 1.2, za + dir * 22, rc + sd * 8 + 1.2);
    }
    const aim = end + dir * (big ? 210 : 150);
    for (const sd of [-1, 1]) ln(aim, rc + sd * 10 - 2.6, aim + dir * 45, rc + sd * 10 + 2.6);
    // 進入灯（滑走路の手前の草地）
    for (let k = 1; k <= 5; k++) L.box(end - dir * (4 + k * 4.5) - 0.3, 0, rc - 8, end - dir * (4 + k * 4.5) + 0.3, 0.6, rc + 8, C(0xf6f1d0));
  }
  // ---- 平行誘導路と、滑走路へのつなぎ ----
  L.ground(ra0 - 4, tc - tw / 2, ra1 + 4, tc + tw / 2, 0.1, asph);
  ln(ra0 - 4, tc - 0.2, ra1 + 4, tc + 0.2, yel);
  const nLinks = big ? 5 : 3;
  for (let k = 0; k < nLinks; k++) {
    const a = k === 0 ? ra0 + 2 : k === nLinks - 1 ? ra1 - 2 - tw : ra0 + ((ra1 - ra0) * k) / (nLinks - 1) - tw / 2;
    L.ground(a, rc + rwW / 2, a + tw, tc - tw / 2, 0.1, asph);
    ln(a + tw / 2 - 0.2, rc + rwW / 2, a + tw / 2 + 0.2, tc, yel);
    ln(a, rc + rwW / 2 + 6, a + tw, rc + rwW / 2 + 6.8, yel); // 停止線
    ln(a, rc + rwW / 2 + 7.6, a + tw, rc + rwW / 2 + 8.4, yel);
  }
  // ---- エプロン（駐機場）：ターミナルの前 ----
  const ta0 = -A * 0.27, ta1 = A * 0.27;
  L.ground(-A / 2 + 20, apC0, A / 2 - 20, termC0, 0.09, conc);
  // エプロンと誘導路をつなぐ
  for (const a of [ta0 - 10, (ta0 + ta1) / 2, ta1 + 10 - tw]) L.ground(a, tc + tw / 2, a + tw, apC0, 0.1, asph);
  ln(-A / 2 + 22, apC0 + 7 - 0.2, A / 2 - 22, apC0 + 7 + 0.2, yel); // エプロンの通り道
  // ---- ターミナル ----
  // ガラス張りの箱の上に、前後にのびる大きな弓なりの屋根（白い膜と、光を通す細い帯）。道路側は大きなひさし
  const tH = big ? 16 : 10;
  const tGlass = C(0x5f8fb8), roofW = C(0xeef0f2), roofU = C(0xc9cfd5);
  L.box(ta0, 0, termC0, ta1, tH, termC1, tGlass, PAT.fullglass, roofU);
  const rc0 = termC0 - (big ? 8 : 5), rc1 = termC1 + (big ? 14 : 9), rise = big ? 11 : 7;
  const ra0r = ta0 - (big ? 8 : 5), ra1r = ta1 + (big ? 8 : 5);
  const NR = 24, span = rc1 - rc0;
  const ry = (u: number) => tH + 1 + rise * Math.sin(Math.PI * u);
  const rn = (u: number): [number, number, number] => { const sl = (rise * Math.PI * Math.cos(Math.PI * u)) / span, l = Math.hypot(sl, 1); return [0, 1 / l, -sl / l]; };
  for (let k = 0; k < NR; k++) {
    const u0 = k / NR, u1 = (k + 1) / NR, c0 = rc0 + span * u0, c1 = rc0 + span * u1, y0 = ry(u0), y1 = ry(u1);
    const col = k % 6 === 3 ? C(0x9fc0d8) : roofW; // 天窓の帯
    L.quadN([ra0r, y0, c0], [ra0r, y1, c1], [ra1r, y1, c1], [ra1r, y0, c0], rn(u0), rn(u1), rn(u1), rn(u0), col);
    // 屋根の裏（下から見たとき）
    L.quadN([ra0r, y0 - 0.6, c0], [ra1r, y0 - 0.6, c0], [ra1r, y1 - 0.6, c1], [ra0r, y1 - 0.6, c1], [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0], roofU);
  }
  // 屋根の両端（弧の下の三日月形の帯）と、ガラスの妻壁
  for (const a of [ra0r, ra1r]) for (let k = 0; k < NR; k++) {
    const u0 = k / NR, u1 = (k + 1) / NR, c0 = rc0 + span * u0, c1 = rc0 + span * u1;
    const sd = a === ra0r ? -1 : 1;
    const nn: [number, number, number] = [sd, 0, 0];
    if (sd > 0) L.quadN([a, ry(u0) - 0.6, c0], [a, ry(u0), c0], [a, ry(u1), c1], [a, ry(u1) - 0.6, c1], nn, nn, nn, nn, roofU);
    else L.quadN([a, ry(u0) - 0.6, c0], [a, ry(u1) - 0.6, c1], [a, ry(u1), c1], [a, ry(u0), c0], nn, nn, nn, nn, roofU);
  }
  // 屋根を支える木のような柱（ひさしの下と、エプロン側）
  for (let a = ta0; a <= ta1 + 0.1; a += big ? 24 : 18) for (const c of [termC1 + (big ? 9 : 6), termC0 - (big ? 4 : 3)]) {
    L.box(a - 0.35, 0, c - 0.35, a + 0.35, tH * 0.6, c + 0.35, C(0xdfe3e7));
    L.box(a - 2.4, tH * 0.6, c - 0.2, a + 2.4, tH * 0.6 + 0.4, c + 0.2, C(0xdfe3e7));
  }
  L.box(ta0, 0, termC1, ta1, 0.25, termC1 + (big ? 12 : 8), C(0xb9b6ae)); // 出発ロビーの前の歩道
  // ---- 搭乗橋と旅客機（鼻先がターミナルを向く） ----
  const tails = [PALETTE.accent[2], PALETTE.accent[0], PALETTE.accent[5], PALETTE.accent[3], C(0x1d3557), PALETTE.accent[4]];
  const gateGap = 34 * s + 12;
  const jc = termC0 - 5 - 19.6 * s; // 旅客機の中心
  for (let a = ta0 + gateGap / 2; a <= ta1 - gateGap / 2 + 0.1; a += gateGap) {
    L.box(a + 2.0 * s + 0.2, 4.0 * s, jc + 13 * s, a + 2.0 * s + 3.4, 4.0 * s + 2.6, termC0, C(0xc9ccd0)); // 搭乗橋
    L.box(a + 2.0 * s + 1.3, 0, jc + 13.5 * s, a + 2.0 * s + 2.3, 4.0 * s, jc + 14.5 * s, PALETTE.steel);
    ln(a - 0.2, apC0 + 8, a + 0.2, termC0 - 2, yel); // 駐機位置へ入る線
    if (rng.next() < 0.85) jet(L, a, jc, s, rng.pick(tails));
  }
  // ---- 管制塔（ターミナルの端の横） ----
  const towA = ta1 + 26, towC = (termC0 + termC1) / 2;
  const th = big ? 62 : 38;
  L.cyl(towA, towC, 0, th, big ? 3.4 : 2.6, C(0xe4e6e8));
  L.cyl(towA, towC, th, th + 1, big ? 6.8 : 5, C(0xd0d3d6));
  L.cyl(towA, towC, th + 1, th + 5.5, big ? 6.3 : 4.6, C(0x3d5a70));
  L.cyl(towA, towC, th + 5.5, th + 7, big ? 6.9 : 5.2, C(0xd0d3d6), C(0xd0d3d6));
  // ---- 格納庫（片側の端）と貨物ターミナル（反対の端） ----
  const hw = big ? 50 : 36;
  for (let k = 0; k < (big ? 3 : 1); k++) {
    const a1 = ta0 - 16 - k * (hw + 8), a0 = a1 - hw;
    if (a0 < -A / 2 + 22) break;
    L.box(a0, 0, apC0 + 30, a1, big ? 18 : 12, termC1, C(0xc5c9cc), PAT.industrial, C(0x9aa1a7));
    L.box(a0 + 2, 0, apC0 + 29.8, a1 - 2, big ? 15 : 10, apC0 + 30.1, C(0x6b7178)); // 扉
  }
  if (big) {
    const ca0 = towA + 22, ca1 = Math.min(A / 2 - 24, ca0 + 120);
    if (ca1 - ca0 > 50) {
      L.box(ca0, 0, termC0 + 2, ca1, 13, termC1, PALETTE.indWall[1], PAT.dock, PALETTE.steel);
      for (let a = ca0 + 26; a < ca1 - 20; a += 60) jet(L, a, termC0 - 5 - 19.6 * 1.4, 1.4, PALETTE.accent[3]);
    }
  }
  // ---- 道路の側：送迎の道と駐車場 ----
  L.ground(ta0 - 6, termC1 + 3, ta1 + 6, termC1 + 10, 0.1, PALETTE.asphalt);
  const pc0 = termC1 + 11, pc1 = CW / 2 - 1.5;
  if (pc1 - pc0 > 5) {
    L.ground(ta0, pc0, ta1, pc1, 0.1, PALETTE.asphalt);
    for (let a = ta0 + 1; a < ta1 - 1; a += 2.7) {
      L.ground(a, pc0 + 0.5, a + 0.14, pc0 + 5.5, 0.12, W);
      if (rng.next() < 0.55) {
        const col = rng.pick(CAR_PAINT);
        L.box(a + 0.45, 0.3, pc0 + 0.8, a + 2.25, 0.95, pc0 + 5.1, col);
        L.box(a + 0.55, 0.95, pc0 + 1.8, a + 2.15, 1.45, pc0 + 4.0, CAR_GLASS);
      }
    }
  }
  for (const a of [ta0 - 8, ta1 + 8]) L.tree(a, CW / 2 - 4, 0.9);
}

function freightStation(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.concrete);
  // 側線
  for (const z of [-f.D / 2 + 3, -f.D / 2 + 7]) mb.ground(-f.W / 2 + 0.5, z - 1.2, f.W / 2 - 0.5, z + 1.2, 0.12, PALETTE.dirt);
  const cols = [0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b].map((h) => new THREE.Color(h));
  for (let k = 0; k < 6; k++) mb.box(-f.W / 2 + 3 + k * 7.5, 0, 2, -f.W / 2 + 9 + k * 7.5, 2.5 * (1 + rng.int(2)), 4.4, rng.pick(cols));
  // 門型クレーン
  for (const x of [-f.W / 2 + 4, f.W / 2 - 4]) for (const z of [-f.D / 2 + 1, 6]) mb.box(x - 0.4, 0, z - 0.4, x + 0.4, 12, z + 0.4, PALETTE.accent[3]);
  mb.box(-f.W / 2 + 3.5, 12, -f.D / 2 + 0.5, f.W / 2 - 3.5, 13.5, 6.5, PALETTE.accent[3]);
  mb.box(-6, 0, 8, 6, 5, f.D / 2 - 1.5, PALETTE.indWall[0], PAT.dock, PALETTE.steel);
}

// ---------------- 公共サービス ----------------
const BLUE = new THREE.Color(0x2f5fa8), GREEN = new THREE.Color(0x3f7d3a);

function landfill(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.07, PALETTE.dirt);
  const trash = [0x6d6457, 0x8a7d66, 0x5d6a58, 0x7b6f63].map((h) => new THREE.Color(h));
  for (let k = 0; k < 7; k++) {
    const x = -f.W / 2 + 6 + rng.next() * (f.W - 16), z = -f.D / 2 + 6 + rng.next() * (f.D - 18);
    mb.hip(x, z, x + 8 + rng.next() * 6, z + 8 + rng.next() * 6, 0, 2 + rng.next() * 3, rng.pick(trash), 0);
  }
  mb.box(f.W / 2 - 10, 0, f.D / 2 - 8, f.W / 2 - 3, 3.5, f.D / 2 - 3, PALETTE.indWall[0]);
  mb.box(-f.W / 2 + 0.5, 0, f.D / 2 - 1, f.W / 2 - 0.5, 2, f.D / 2 - 0.8, PALETTE.steel);
}

// 弓なりの屋根（x0..x1 の方向に弧を描く。幅を細かく切った箱を並べる）
function archRoof(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, rise: number, c: THREE.Color, alongX = true) {
  // 弧に沿ってなめらかな曲面を張り、両端は弧の形の壁でふさぐ
  const N = 20;
  const span = alongX ? x1 - x0 : z1 - z0;
  const pt = (u: number) => y + rise * Math.sin(Math.PI * u);
  const nrm = (u: number): [number, number, number] => {
    const slope = (rise * Math.PI * Math.cos(Math.PI * u)) / span;
    const l = Math.hypot(slope, 1);
    return alongX ? [-slope / l, 1 / l, 0] : [0, 1 / l, -slope / l];
  };
  for (let k = 0; k < N; k++) {
    const u0 = k / N, u1 = (k + 1) / N;
    const a0 = (alongX ? x0 : z0) + span * u0, a1 = (alongX ? x0 : z0) + span * u1;
    const y0 = pt(u0), y1 = pt(u1);
    if (alongX) mb.quadN([a0, y0, z1], [a1, y1, z1], [a1, y1, z0], [a0, y0, z0], nrm(u0), nrm(u1), nrm(u1), nrm(u0), c);
    else mb.quadN([x0, y0, a0], [x0, y1, a1], [x1, y1, a1], [x1, y0, a0], nrm(u0), nrm(u1), nrm(u1), nrm(u0), c);
    // 端の壁（弧の下）
    if (alongX) {
      mb.quad([a0, y, z1], [a1, y, z1], [a1, y1, z1], [a0, y0, z1], c);
      mb.quad([a1, y, z0], [a0, y, z0], [a0, y0, z0], [a1, y1, z0], c);
    } else {
      mb.quad([x0, y, a0], [x0, y, a1], [x0, y1, a1], [x0, y0, a0], c);
      mb.quad([x1, y, a1], [x1, y, a0], [x1, y0, a0], [x1, y1, a1], c);
    }
  }
}

// ごみ焼却場（クリーンセンター）。big = 大型（4×6）。白と銀の建屋、ガラスの正面、弓なりの屋根、
// 細い煙突（大型は展望室のリングつき）、収集車が上がるスロープ。スロープの位置は propsLayer の INCIN_RAMP と合わせる
export const INCIN_RAMP = { x: 0.36, z0: 0.5, z1: -0.02, h: 9 }; // 敷地の幅・奥行きに対する割合。h はプラットホームの高さ（m）
function incinerator(mb: MeshBuilder, f: LotFrame, tf: TF, big: boolean) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const white = C(0xf1f1ee), silver = C(0xc4cad0), dark = C(0x4a5058), glass = C(0x4f7fae);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  mb.ground(-hw + 1, hd - 9, hw - 1, hd - 1, 0.1, PALETTE.lawn2);
  // 本館（ごみピットと炉）：横長の白い箱と、弓なりの銀色の屋根
  const bx0 = -hw + 3, bx1 = hw * (big ? 0.18 : 0.3), bz0 = -hd + 4, bz1 = hd * (big ? 0.0 : 0.15);
  const H = big ? 30 : 20;
  mb.box(bx0, 0, bz0, bx1, H, bz1, white, PAT.ribbon, silver);
  archRoof(mb, bx0, bz0, bx1, bz1, H, big ? 9 : 6, silver, false);
  // 正面のガラスの見学ロビー（2層吹き抜け）
  mb.box(bx0 + 2, 0, bz1, bx1 - 2, big ? 12 : 8, bz1 + (big ? 10 : 6), glass, PAT.fullglass, white);
  mb.box(bx0 + 1, big ? 12 : 8, bz1 - 0.5, bx1 - 1, (big ? 12 : 8) + 0.6, bz1 + (big ? 12 : 7), white);
  // 横の排ガス処理棟と、発電棟（大型）
  mb.box(bx1, 0, bz0 + 4, bx1 + (big ? 14 : 8), H * 0.7, bz0 + (big ? 30 : 18), silver, PAT.industrial, dark);
  if (big) {
    mb.box(bx1 + 16, 0, bz0 + 2, hw - 3, 16, bz0 + 22, white, PAT.ribbon, silver);
    // 屋上の空冷の復水器（ファンの列）
    for (let x = bx1 + 18; x < hw - 6; x += 6) for (const z of [bz0 + 7, bz0 + 15]) {
      mb.box(x, 16, z - 2.5, x + 5, 18, z + 2.5, C(0x9aa1a7));
      mb.cylinder(x + 2.5, z, 18, 18.1, 2, 12, dark, dark);
    }
  }
  // 煙突：細くて高い銀色の筒。大型は展望室のリング
  const cx = bx1 + (big ? 7 : 4), cz = bz0 + (big ? 17 : 11), ch = big ? 100 : 60;
  mb.cylinder(cx, cz, 0, ch, big ? 3.4 : 2.4, 20, silver, dark, big ? 2.8 : 2.0);
  mb.cylinder(cx, cz, ch - 6, ch - 4.5, big ? 2.95 : 2.15, 20, C(0x2f86d0));
  if (big) {
    mb.cylinder(cx, cz, 72, 79, 7.5, 24, glass, white, 7.5);
    mb.cylinder(cx, cz, 79, 80, 8, 24, white, white, 8);
    mb.cylinder(cx, cz, 71, 72, 8, 24, white, white, 8);
  }
  // 収集車のスロープ（道路からプラットホームへ）と入口
  const rx = INCIN_RAMP.x * W, rz0 = INCIN_RAMP.z0 * D - 1, rz1 = INCIN_RAMP.z1 * D, rh = big ? INCIN_RAMP.h : 6;
  const rw = 3.5;
  mb.quad([rx - rw, 0.15, rz0], [rx + rw, 0.15, rz0], [rx + rw, rh, rz1], [rx - rw, rh, rz1], PALETTE.asphalt);
  for (const sx of [-1, 1]) {
    mb.quad([rx + sx * rw, 0, rz0], [rx + sx * rw, 0.9, rz0], [rx + sx * rw, rh + 0.9, rz1], [rx + sx * rw, rh, rz1], silver);
    mb.box(rx + sx * rw - 0.3, 0, rz1 - 0.3, rx + sx * rw + 0.3, rh, rz1 + 0.3, C(0xb5b1a8));
  }
  mb.box(rx - rw - 1, rh, rz1 - 8, rx + rw + 1, rh + 0.4, rz1, PALETTE.asphalt);
  mb.box(rx - rw - 1, 0, rz1 - 8, rx + rw + 1, rh, rz1 - 7.6, C(0xb5b1a8));
  mb.box(Math.min(rx - rw - 2, bx1), rh, rz1 - 9, rx + rw + 2, rh + 7, rz1 - 8, dark); // プラットホームの入口
  // 植え込み
  for (let x = -hw + 4; x < hw - 4; x += 8) tf(x, hd - 4, 0.8 + ((x * 7) % 3) * 0.1);
}

// 浄水場（4×6、奥（-z）が水辺）：川の中の取水塔、青緑の沈殿池・ろ過池の列、ふた付きの浄水池、ポンプ棟、管理棟
function waterPlant(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const rim = C(0xc9c5bc), basinA = C(0x6f9a8a), basinB = C(0x4f9fa8), white = C(0xf1f0ea);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.lawn2);
  mb.ground(-3, -hd + 1, 3, hd - 1, 0.1, PALETTE.asphalt);
  // 取水塔（水の中）と、岸への連絡橋
  mb.cylinder(0, -hd - 16, -4, 12, 4.2, 16, white, C(0x5c636a));
  mb.box(-1.2, 9, -hd - 12, 1.2, 10, -hd + 2, C(0x9da3a8));
  // 池：中央の道の左右に、沈殿池（くすんだ緑）とろ過池（青）を並べる
  const z0 = -hd + 6, z1 = hd * 0.35;
  const rows = Math.max(2, Math.floor((z1 - z0) / 15));
  const rh = (z1 - z0) / rows;
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -hw + 3 : 5, x1 = side < 0 ? -5 : hw - 3;
    for (let r = 0; r < rows; r++) {
      const a = z0 + r * rh + 1, b = z0 + (r + 1) * rh - 1;
      mb.box(x0, 0, a, x1, 1.4, b, rim, PAT.none, rim);
      mb.ground(x0 + 0.8, a + 0.8, x1 - 0.8, b - 0.8, 1.45, r % 2 ? basinB : basinA);
      // 池をまたぐ通路
      mb.box(x0, 1.4, (a + b) / 2 - 0.5, x1, 1.7, (a + b) / 2 + 0.5, C(0x9da3a8));
    }
  }
  // ふた付きの浄水池（芝生の屋上）と、ポンプ棟・管理棟
  mb.box(-hw + 3, 0, z1 + 2, -5, 4, hd - 14, rim, PAT.none, PALETTE.lawn);
  mb.box(5, 0, z1 + 2, hw - 3, 10, hd - 16, white, PAT.dock, C(0x6d7781));
  mb.box(5, 0, hd - 14, hw - 3, 9, hd - 4, white, PAT.office, PALETTE.roof[3]);
  // 薬品のタンク
  for (const x of [-hw + 6, -hw + 11]) mb.cylinder(x, hd - 9, 0, 7, 2.2, 12, white, white);
  tf(-hw + 3, hd - 3, 0.9);
  tf(-8, hd - 3, 0.9);
}

// 海水淡水化プラント（4×6、奥（-z）が海）：取水管と放水管、前処理の池、膜処理の長い建屋、青いタンクの列、白い水タンク
function desalPlant(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const white = C(0xf2f2ee), silver = C(0xc4cad0), blue = C(0x2e6da4), dark = C(0x4a5058);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  // 取水管と放水管（海へのびる）
  for (const x of [-hw * 0.5, hw * 0.5]) {
    mb.box(x - 1.2, -1, -hd - 26, x + 1.2, 1.4, -hd + 6, C(0x8f969c));
    mb.cylinder(x, -hd - 26, -3, 2.5, 3, 12, white, dark);
  }
  // 前処理の池（海側）
  mb.box(-hw + 3, 0, -hd + 4, hw - 3, 1.4, -hd + 18, C(0xc9c5bc), PAT.none, C(0xc9c5bc));
  mb.ground(-hw + 4, -hd + 5, hw - 4, -hd + 17, 1.45, C(0x3f8fa0));
  // 膜処理の建屋：銀色の長い建屋と、弓なりの屋根。正面はガラス
  const z0 = -hd + 22, z1 = hd * 0.3;
  mb.box(-hw + 3, 0, z0, hw - 3, 14, z1, silver, PAT.ribbon, silver);
  archRoof(mb, -hw + 3, z0, hw - 3, z1, 14, 5, white, true);
  mb.box(-hw + 6, 0, z1, hw - 6, 9, z1 + 3, C(0x4f7fae), PAT.fullglass, white);
  // 青いタンクの列（高圧ポンプと膜の容器）と、白い水タンク
  for (let x = -hw + 6; x < hw - 4; x += 6) mb.cylinder(x, z1 + 8, 0, 6, 2.2, 12, blue, blue);
  for (const x of [-hw * 0.45, hw * 0.45]) {
    mb.cylinder(x, hd - 12, 0, 12, 7, 20, white, C(0xdcdcd6));
    mb.cylinder(x, hd - 12, 3, 3.6, 7.05, 20, blue);
  }
  mb.box(-5, 0, hd - 9, 5, 7, hd - 3, white, PAT.office, PALETTE.roof[3]);
  tf(-hw + 3, hd - 2, 0.8);
  tf(hw - 3, hd - 2, 0.8);
}

// リサイクルセンター（日本のリサイクルプラザ型）：道路側に白い外壁の見学棟（2 階にガラスの見学通路、入口は壁面緑化）、
// 奥に背の高い金属の選別・圧縮棟と収集車の搬入口。横は収集車の通る構内道路と計量台、奥にベール（つぶして固めた
// ペットボトル・缶・古紙）を積んだ屋根付きのストックヤード
function recycling(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  const hw = f.W / 2, hd = f.D / 2;
  const white = C(0xf1f1ee), offW = C(0xe4e5e2), grey = C(0xb9bec4), asph = C(0x4d5054);
  const leaf = C(0x4f7a3a), accent = C(0x2f9a5a), glass = C(0xcfe0ea);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.concrete);
  // 構内道路（右側、手前から奥へ）と計量台
  const rx0 = hw - 13, rx1 = hw - 1;
  mb.ground(rx0, -hd + 1, rx1, hd - 0.4, 0.09, asph);
  mb.ground(rx0 + 5.8, -hd + 3, rx0 + 6.2, hd - 2, 0.1, C(0xe8e8e2));
  mb.ground(rx0 + 1.2, hd - 12, rx0 + 5.2, hd - 4, 0.12, C(0x6d7378)); // 計量台
  for (const z of [hd - 12, hd - 4]) mb.ground(rx0 + 1.2, z - 0.15, rx0 + 5.2, z + 0.15, 0.13, C(0xf2c200));
  mb.box(rx0 - 2.2, 0, hd - 10, rx0 - 0.4, 2.8, hd - 6.5, white, PAT.office, grey); // 計量の詰所
  // ---- 奥：選別・圧縮棟（金属の外壁、背が高い）----
  const px0 = -hw + 2, px1 = rx0 - 1, pz0 = -hd + 2, pz1 = -hd + 15;
  mb.matOverride = MAT.metal;
  mb.box(px0, 0, pz0, px1, 15, pz1, offW, PAT.industrial, C(0xc9ccd0));
  // 屋根の換気モニター
  mb.box(px0 + 4, 15, (pz0 + pz1) / 2 - 1.6, px1 - 4, 16.6, (pz0 + pz1) / 2 + 1.6, grey, PAT.ribbon, grey);
  // 構内道路側の搬入口（大きなシャッター 2 つ）
  for (const z of [pz0 + 2.2, pz0 + 7.6]) mb.box(px1 - 0.05, 0, z, px1 + 0.15, 5.6, z + 4.6, C(0x5c6168));
  mb.box(px1, 6, pz0 + 1, px1 + 3.2, 6.4, pz1 - 1, grey); // ひさし
  mb.matOverride = null;
  // 集じん機のダクトと小さな排気筒
  mb.box(px0 + 2, 15, pz0 + 1.5, px0 + 4, 17.5, pz0 + 3.5, grey);
  mb.cylinder(px0 + 3, pz0 + 2.5, 17.5, 21, 0.45, 10, C(0xd8dadd));
  // ---- 手前：見学棟（白い外壁、2 階にガラスの見学通路）----
  const vx0 = -hw + 2, vx1 = rx0 - 1, vz0 = pz1, vz1 = hd - 4;
  mb.box(vx0, 0, vz0, vx1, 10, vz1, white, PAT.none, C(0xd9dcd8));
  // 1 階：ガラスの入口とロビー（左側）、2 階：通りに面した横長のガラスの見学通路
  mb.box(vx0 + 1.5, 0.2, vz1 - 0.05, vx0 + 12, 3.6, vz1 + 0.25, glass, PAT.fullglass, white);
  mb.box(vx0 + 1, 4.6, vz1 - 0.05, vx1 - 1, 8.4, vz1 + 0.35, glass, PAT.curtain, white);
  // 見学通路の床と庇の白い帯、緑のライン（夜は光る）
  mb.box(vx0 + 0.6, 4.2, vz1, vx1 - 0.6, 4.6, vz1 + 0.9, white);
  mb.box(vx0 + 0.6, 8.4, vz1, vx1 - 0.6, 9.0, vz1 + 1.2, white);
  mb.box(vx0 + 0.6, 9.0, vz1 + 1.1, vx1 - 0.6, 9.3, vz1 + 1.25, accent, PAT.glow, accent);
  // 入口の壁面緑化（縦長の緑の壁）と、入口の庇
  mb.box(vx0 + 12.5, 0.2, vz1, vx0 + 18.5, 8.2, vz1 + 0.5, leaf, PAT.gardenLeaf, leaf);
  mb.box(vx0 + 1, 3.6, vz1, vx0 + 12.5, 3.9, vz1 + 3.2, white);
  // 横の壁にも見学通路の窓（構内道路側）
  mb.box(vx1 - 0.05, 4.6, vz0 + 2, vx1 + 0.25, 8.4, vz1 - 1.5, glass, PAT.curtain, white);
  // 屋根：太陽光パネルと屋上の手すり
  for (let x = vx0 + 2; x + 2.2 < vx1 - 2; x += 2.6) mb.box(x, 10.4, vz0 + 2, x + 2.2, 10.8, vz1 - 2, C(0x22385a), PAT.none, C(0x2a4166));
  mb.box(vx0, 10, vz1 - 0.15, vx1, 11, vz1, C(0xd0d4d8));
  // 前庭：植え込みと、見学者のバス・車の止まるところ
  mb.ground(vx0, vz1 + 0.4, vx1, hd - 0.4, 0.08, C(0xcfc9bd));
  mb.box(vx0 + 18.8, 0, vz1 + 0.6, vx1 - 1, 0.6, vz1 + 2.6, C(0xbfc3c0), PAT.none, leaf);
  tf(vx0 + 21, vz1 + 1.6, 0.8);
  tf(vx1 - 3, vz1 + 1.6, 0.7);
  // ---- ストックヤード：構内道路の奥、屋根だけの鉄骨の棚にベールを積む ----
  const sx0 = rx0 + 1, sx1 = rx1 - 0.5, sz0 = -hd + 1.5, sz1 = -hd + 13;
  mb.matOverride = MAT.metal;
  for (const x of [sx0, sx1 - 0.4]) for (let z = sz0; z <= sz1; z += (sz1 - sz0) / 2) mb.box(x, 0, z - 0.2, x + 0.4, 7, z + 0.2, grey);
  mb.box(sx0 - 0.3, 7, sz0 - 0.6, sx1 + 0.3, 7.5, sz1 + 0.6, C(0xd2d5d8), PAT.none, C(0xc3c7cb));
  mb.matOverride = null;
  // 区切りのコンクリート壁と、ベール（ペットボトル：青みの白、缶：銀、古紙：茶、ガラスくず：緑）
  const kinds = [C(0xcfe3ee), C(0xb7bcc2), C(0xb59a72), C(0x8faa7c)];
  const bay = (sz1 - sz0) / 4;
  for (let k = 0; k < 4; k++) {
    const z0 = sz0 + k * bay;
    mb.box(sx0 + 0.4, 0, z0, sx1 - 0.4, 2.2, z0 + 0.3, C(0xa8a49b));
    const col = kinds[k];
    const rows = 2 + rng.int(2);
    for (let r = 0; r < rows; r++) for (let c = 0; c < 3; c++) {
      if (rng.next() < 0.15) continue;
      const bx = sx1 - 1.2 - c * 1.35;
      const y = r * 1.05;
      const tint = col.clone().multiplyScalar(0.9 + rng.next() * 0.15);
      mb.box(bx - 1.2, y, z0 + 0.6, bx, y + 1.0, z0 + bay - 0.4, tint, PAT.none, tint);
    }
  }
  // 構内に止まっている収集車の荷台とコンテナ（色分け）
  for (let k = 0; k < 3; k++) mb.box(rx0 + 7, 0, -hd + 16 + k * 3.2, rx1 - 1, 2.0, -hd + 18.6 + k * 3.2, [BLUE, GREEN, C(0xd9a400)][k]);
  // 敷地のまわりの低い塀（構内道路の入口は開ける）
  mb.box(-hw + 0.4, 0, -hd + 0.4, -hw + 0.7, 1.6, hd - 0.4, C(0xc8c4bb));
  mb.box(-hw + 0.4, 0, -hd + 0.4, hw - 0.4, 1.6, -hd + 0.7, C(0xc8c4bb));
}


// ---------------- 霊園（公園墓地）----------------
// 埋葬の進み具合の段階（0..4）。buildingLayer の区画の鍵も同じ式を使う（段階が変わったら作り直す）
export function cemeteryStage(b: Building) {
  const cap = CIVIC.cemetery?.capacity || 1;
  const fill = Math.max(0, Math.min(1, (b.occ || 0) / cap));
  return Math.round(fill * 4);
}
// 段階ごとの、墓石の立っている区画の割合
const CEM_FILL = [0.06, 0.3, 0.55, 0.8, 1];
const GRANITE = [0x8f9192, 0xa3a4a2, 0x7d8082, 0x2f3033, 0x3a3b3e, 0x2a2b2d, 0xb1aba3, 0x6b6e70].map(C);
const FLOWER = [0xd8443c, 0xf0c63a, 0xf3f1ea, 0xc85a9c, 0xe9853a].map(C);

// 芝生と木の多い公園墓地。道路側の入口から、ゆるく曲がった園路が奥の合葬墓（樹木葬の丘）へ続く。
// 入口の左に管理事務所（白い箱、木のルーバー、ガラス）、右に屋根のある休憩所と駐車場。
// 墓所は生垣で区切った区画に、背中合わせの 2 列で並ぶ（和型の墓石：外柵・台石・竿石、ときどき洋型）。
// stage が上がるほど入口に近い区画から墓石が増える。まだ空いている区画は、外柵と玉砂利だけか、芝生の区画
function cemetery(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, stage: number) {
  const hw = f.W / 2, hd = f.D / 2;
  const lawn = C(0x74a04e), lawnPlot = C(0x84ad5a), pave = C(0xd6d1c7), path2 = C(0xbcb5a6);
  const granite = C(0x8e8f8f), hedge = C(0x3d6831), wood = C(0xb5875a), white = C(0xf3f3f0), white2 = C(0xe2e4e5);
  const glass = C(0x7d9fb6), dark = C(0x2c2f32), warm = C(0xffd9a0);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.06, lawn);
  const flat = (x0: number, z0: number, x1: number, z1: number, y: number, col: THREE.Color) => mb.ground(x0, z0, x1, z1, y, col);

  // ---- 園路：入口から奥の合葬墓の広場へ、ゆるい S 字 ----
  const gateZ = hd - 0.4, monZ = -hd + 10, monR = 8;
  const pz1 = monZ + monR - 0.5;
  const pathX = (z: number) => 3.0 * Math.sin((2 * Math.PI * (gateZ - z)) / (gateZ - pz1));
  const ribbon = (half: number, y: number, col: THREE.Color) => {
    const n = 40;
    mb.matOverride = MAT.ground;
    for (let k = 0; k < n; k++) {
      const za = gateZ - ((gateZ - pz1) * k) / n, zb = gateZ - ((gateZ - pz1) * (k + 1)) / n;
      const xa = pathX(za), xb = pathX(zb);
      mb.quad([xa - half, y, za], [xa + half, y, za], [xb + half, y, zb], [xb - half, y, zb], col);
    }
    mb.matOverride = null;
  };

  // ---- 墓所の区画（4 列 × 6 段、各段は背中合わせの 2 列）----
  const colsX: [number, number][] = [[-hw + 2.4, -18.4], [-17.0, -6.6], [6.6, 17.0], [18.4, hw - 2.4]];
  const rowTop = 17.4, rowD = 6.2, gap = 2.0, rows = 6;
  interface Lot { x: number; z: number; s: number; w: number; key: number; kind: number; col: THREE.Color; h: number; fl: THREE.Color }
  const lots: Lot[] = [];
  const rowZ: [number, number][] = [];
  for (let r = 0; r < rows; r++) rowZ.push([rowTop - r * (rowD + gap) - rowD, rowTop - r * (rowD + gap)]);
  // 区画の間の砂利の通路（横）と、列の間の通路（縦）
  for (let r = 0; r < rows; r++) {
    const zg = rowZ[r][0];
    flat(-hw + 1.6, zg - gap + 0.1, hw - 1.6, zg - 0.1, 0.075, path2);
  }
  flat(-hw + 1.6, rowTop + 0.1, hw - 1.6, rowTop + 1.9, 0.075, path2);
  for (const x of [-17.7, 17.7]) flat(x - 0.6, rowZ[rows - 1][0] - 1.5, x + 0.6, rowTop + 1.9, 0.078, path2);
  for (const [cx0, cx1] of colsX) {
    const lx0 = cx0 + 0.6, lx1 = cx1 - 0.6;
    const n = Math.max(1, Math.floor((lx1 - lx0) / 2.2)), lw = (lx1 - lx0) / n;
    for (let r = 0; r < rows; r++) {
      const [z0, z1] = rowZ[r], zm = (z0 + z1) / 2;
      let any = false;
      for (const s of [1, -1]) for (let i = 0; i < n; i++) {
        const x = lx0 + (i + 0.5) * lw, z = zm + s * (rowD / 4);
        if (Math.hypot(x, z - monZ) < monR + 2.6) continue;
        if (Math.abs(x - pathX(z)) - lw / 2 < 2.4) continue;
        any = true;
        rng.next(); // 以前は石の色（黒か灰色）を選んでいた。並びが変わらないよう乱数だけ進める
        lots.push({
          x, z, s, w: lw,
          key: Math.hypot(x * 1.15, z - gateZ) + rng.next() * 7,
          kind: Math.floor(rng.next() * 5), // 墓石の形（5 種類）
          col: (rng.next() < 0.5 ? GRANITE[rng.pick([3, 4, 5, 7])] : GRANITE[rng.pick([0, 1, 2, 6])].clone().lerp(C(0xd4d5d3), 0.3)).clone().multiplyScalar(0.94 + rng.next() * 0.1), // 黒っぽい石と明るい灰色の石
          h: 0.9 + rng.next() * 0.35,
          fl: rng.pick(FLOWER),
        });
      }
      if (!any) continue;
      // 区画の両端の生垣（刈り込んだ低い木）
      for (const x of [cx0 + 0.05, cx1 - 0.5]) mb.box(x, 0, z0 + 0.15, x + 0.45, 0.75, z1 - 0.15, hedge, PAT.gardenLeaf, hedge);
      // 区画の中央の背中合わせの境目（低い縁石）
      mb.box(lx0, 0, zm - 0.06, lx1, 0.22, zm + 0.06, granite);
    }
  }
  lots.sort((a, b) => a.key - b.key);
  const nFull = Math.round(lots.length * CEM_FILL[Math.max(0, Math.min(4, stage))]);
  const nPrep = Math.min(lots.length, nFull + Math.round(lots.length * 0.16));
  lots.forEach((L, k) => {
    const x0 = L.x - L.w / 2 + 0.14, x1 = L.x + L.w / 2 - 0.14;
    const za = L.z - rowD / 4 + 0.12, zb = L.z + rowD / 4 - 0.12;
    if (k >= nPrep) {
      // まだ整えていない区画：芝生の四角
      flat(x0 + 0.1, za + 0.1, x1 - 0.1, zb - 0.1, 0.07, lawnPlot);
      return;
    }
    // 墓：芝生の上の小さな植え込みの床と、奥に小さな墓石（台石はなし）。ヨーロッパの墓地のように
    if (k >= nFull) { flat(x0 + 0.1, za + 0.1, x1 - 0.1, zb - 0.1, 0.07, lawnPlot); return; }
    const c = L.col, s = L.s;
    const zs = L.z - s * 0.55; // 墓石は区画の奥（通路と反対側）
    const bx = (xa: number, ya: number, dza: number, xb: number, yb: number, dzb: number, col: THREE.Color, pat: number = PAT.none) =>
      mb.box(L.x + xa, ya, zs + Math.min(dza, dzb), L.x + xb, yb, zs + Math.max(dza, dzb), col, pat, col);
    // 植え込みの床（濃い緑の地被）
    const bz0 = Math.min(zs, L.z + s * 0.9), bz1 = Math.max(zs, L.z + s * 0.9);
    flat(L.x - 0.55, bz0, L.x + 0.55, bz1, 0.075, C(0x4f7f3a));
    // 小さな墓石：形は 5 種類（四角、上が丸い、横長で低い、十字架、細長い）
    const h = L.h * 0.75; // 0.7〜0.95m
    const t = 0.13, sy = 0.06;
    switch (L.kind) {
      case 0: bx(-0.3, sy, -t, 0.3, h, t, c); break;
      case 1: // 上が丸い（段を重ねて丸く見せる）
        bx(-0.3, sy, -t, 0.3, h - 0.12, t, c);
        bx(-0.24, h - 0.12, -t, 0.24, h - 0.04, t, c);
        bx(-0.14, h - 0.04, -t, 0.14, h + 0.02, t, c);
        break;
      case 2: bx(-0.45, sy, -t, 0.45, 0.5, t, c); break;
      case 3: // 十字架
        bx(-0.06, sy, -0.08, 0.06, h + 0.1, 0.08, c);
        bx(-0.24, h - 0.22, -0.08, 0.24, h - 0.1, 0.08, c);
        break;
      default: bx(-0.2, sy, -t, 0.2, h + 0.25, t, c); break;
    }
    // 小さな刈り込みの木（ところどころ）
    if ((L.key * 7.3) % 1 < 0.35) bx(0.35, 0, s * 0.25, 0.65, 0.4, s * 0.55, hedge, PAT.gardenLeaf);
  });

  // 園路（区画の通路の上に描く）と、園路の灯り（夜にほのかに光る）
  ribbon(1.8, 0.095, pave);
  ribbon(1.95, 0.085, C(0xb9b3a7));
  for (let k = 1; k < 6; k++) {
    const z = gateZ - ((gateZ - pz1) * k) / 6, sx = k % 2 ? 1 : -1, x = pathX(z) + sx * 2.3;
    mb.box(x - 0.07, 0, z - 0.07, x + 0.07, 2.6, z + 0.07, dark);
    mb.box(x - 0.16, 2.6, z - 0.16, x + 0.16, 2.95, z + 0.16, warm, PAT.glow, dark);
  }

  // ---- 園路ぞいの木 ----
  for (let r = 0; r < rows; r++) {
    const zg = rowZ[r][0] - gap / 2, sd = r % 2 ? 1 : -1;
    if (r > 0) tf(pathX(zg) - sd * 3.6, zg, 0.75 + 0.15 * rng.next(), 0, 0, undefined, 3);
  }

  // ---- 奥：合葬墓（芝生の丘、てっぺんにシンボルツリー）と石の広場 ----
  mb.matOverride = MAT.ground;
  mb.cylinder(0, monZ, 0.0, 0.1, monR, 48, pave, pave);
  mb.matOverride = null;
  mb.cylinder(0, monZ, 0.1, 0.6, 5.4, 48, C(0xa9a8a4), C(0xa9a8a4));
  mb.matOverride = MAT.ground;
  mb.dome(0, monZ, 0.6, 5.2, 1.5, C(0x6f9b4a), 40, 8);
  mb.matOverride = null;
  tf(0, monZ, 1.35, 0, 2.0, 0x5f8434, 3);
  // 黒御影の碑と献花台
  mb.box(-1.0, 0.1, monZ + 5.6, 1.0, 0.35, monZ + 6.4, granite);
  mb.box(-1.8, 0.1, monZ + 6.6, 1.8, 0.4, monZ + 7.0, granite);
  mb.box(-1.6, 0.4, monZ + 6.7, 1.6, 2.1, monZ + 6.9, C(0x1f2022));
  mb.box(-1.1, 0.1, monZ + 7.3, 1.1, 0.85, monZ + 7.7, C(0x4a4c4f), PAT.none, C(0x9ea0a2));
  // 広場のベンチと、うしろの林
  for (const a of [0.35, 0.65]) {
    const bxp = Math.cos(a * Math.PI) * (monR - 0.9), bzp = monZ + Math.sin(a * Math.PI) * (monR - 0.9);
    mb.box(bxp - 0.9, 0, bzp - 0.25, bxp + 0.9, 0.45, bzp + 0.25, wood);
  }
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (1.08 + (i / 8) * 0.84);
    tf(Math.cos(a) * (monR + 1.4), monZ + Math.sin(a) * (monR + 1.4), 0.8 + 0.3 * rng.next(), i % 3 === 1 ? 1 : 0);
  }

  // ---- まわりの生垣と木（横と奥）----
  mb.box(-hw + 0.5, 0, -hd + 0.5, hw - 0.5, 1.2, -hd + 1.4, hedge, PAT.gardenLeaf, hedge);
  for (const sx of [-1, 1]) mb.box(sx < 0 ? -hw + 0.5 : hw - 1.4, 0, -hd + 1.4, sx < 0 ? -hw + 1.4 : hw - 0.5, 1.2, hd - 1.6, hedge, PAT.gardenLeaf, hedge);
  for (let z = -hd + 2; z < hd - 13; z += 5.5) for (const sx of [-1, 1]) tf(sx * (hw - 1), z + rng.next() * 1.5, 0.75 + 0.3 * rng.next(), rng.next() < 0.55 ? 1 : 0);
  for (let x = -hw + 3; x < hw - 2; x += 5) if (Math.abs(x) > monR + 3) tf(x + rng.next(), -hd + 1, 0.8 + 0.3 * rng.next(), rng.next() < 0.6 ? 1 : 0);

  // ---- 手前：入口の広場、門柱、低い石の塀 ----
  flat(-8, rowTop + 1.9, 8, hd - 0.3, 0.09, pave);
  const wallC = C(0xb7b4ad);
  for (const [a, b2] of [[-hw + 0.5, -4.6], [4.6, 21.2], [29.6, hw - 0.5]] as [number, number][]) mb.box(a, 0, hd - 1.4, b2, 0.9, hd - 0.8, wallC, PAT.none, C(0xc9c6bf));
  for (const sx of [-1, 1]) {
    mb.box(sx * 4.6 - 0.4, 0, hd - 1.6, sx * 4.6 + 0.4, 2.3, hd - 0.6, C(0x6c6f72));
    mb.box(sx * 4.6 - 0.3, 2.3, hd - 1.45, sx * 4.6 + 0.3, 2.42, hd - 0.75, warm, PAT.glow, warm);
  }
  mb.box(-5.0, 0.9, hd - 0.58, -4.2, 2.0, hd - 0.55, C(0xd9d6cc)); // 表札

  // 管理事務所：白い薄い屋根、木のルーバー、ガラス
  const ox0 = -hw + 2.5, ox1 = -14.5, oz0 = rowTop + 3.4, oz1 = hd - 3.2;
  mb.box(ox0 - 0.3, 0, oz0 - 0.3, ox1 + 0.3, 0.3, oz1 + 0.3, white2);
  mb.box(ox0, 0.3, oz0, ox0 + 5.5, 3.6, oz1, white, PAT.none, white2);
  mb.box(ox0 + 5.5, 0.3, oz0 + 0.4, ox1, 3.6, oz1 - 0.4, glass, PAT.fullglass, white2);
  for (let x = ox0 + 5.9; x < ox1 - 0.2; x += 0.5) if (x < ox1 - 4.6 || x > ox1 - 2.0) mb.box(x, 0.3, oz1 - 0.15, x + 0.12, 3.6, oz1 + 0.05, wood);
  mb.box(ox0 - 0.9, 3.6, oz0 - 0.8, ox1 + 1.2, 3.95, oz1 + 1.4, white, PAT.none, C(0xe9eaea));
  mb.box(ox0 + 0.8, 1.7, oz1, ox0 + 4.6, 2.3, oz1 + 0.06, C(0x3b3d40));
  tf(ox0 + 2, rowTop + 2.6, 0.55);
  tf(ox1 - 1, rowTop + 2.6, 0.6, 0, 0, undefined, 2);

  // 休憩所：細い柱と白い薄い屋根、木のベンチと背の板
  const rx0 = 8.6, rx1 = 18.6, rz0 = rowTop + 4.2, rz1 = hd - 3.6;
  flat(rx0 - 0.5, rz0 - 0.5, rx1 + 0.5, rz1 + 0.8, 0.1, C(0xcbc6bc));
  for (const x of [rx0 + 0.3, rx1 - 0.3]) for (const z of [rz0 + 0.3, rz1 - 0.3]) mb.box(x - 0.08, 0, z - 0.08, x + 0.08, 3.0, z + 0.08, dark);
  mb.box(rx0 - 0.6, 3.0, rz0 - 0.6, rx1 + 0.6, 3.25, rz1 + 0.9, white, PAT.none, C(0xe9eaea));
  mb.box(rx0 + 0.6, 0, rz0 + 0.2, rx1 - 0.6, 2.2, rz0 + 0.45, wood);
  mb.box(rx0 + 1.0, 0, rz0 + 1.3, rx1 - 1.0, 0.45, rz0 + 1.9, wood);
  mb.box(rx0 + 1.0, 0, rz1 - 1.6, rx0 + 4.0, 0.45, rz1 - 1.0, wood);
  mb.box(rx0 + 0.2, 2.95, rz1 + 0.6, rx1 - 0.2, 3.0, rz1 + 0.8, warm, PAT.glow, warm);

  // 駐車場（入口の右）
  const cx0 = 21.6, cx1 = hw - 1.4, cz0 = rowTop + 2.2;
  flat(cx0, cz0, cx1, hd - 0.3, 0.09, C(0x4a4d51));
  for (let x = cx0 + 0.3; x < cx1; x += 2.6) flat(x, cz0 + 0.4, x + 0.12, cz0 + 5.2, 0.1, PALETTE.white);
  parkedCar(mb, cx0 + 1.6, cz0 + 0.4, cz0 + 5.2, rng);
  if (stage > 1) parkedCar(mb, cx0 + 6.8, cz0 + 0.4, cz0 + 5.2, rng);
  tf(cx0 - 0.6, hd - 2.4, 0.7);
}

// ---------------- 斎場（火葬場）----------------
// 打ち放しコンクリートとガラスの斎場。低く長い一つの箱（KAAN「Siesegem」）が道路に面し、
// 正面は深い列柱（コンクリートの柱の列）とその奥の全面ガラス。箱には中庭を 2 つ切り込む（白い砂利の庭と水の庭。木は植えない）。
// 全体は同じ低い高さ。中央の告別ホールには細い丸柱がランダムに立つ「柱の森」があり、ガラス越しに見える
// （Schultes Frank「Baumschulenweg」）。柱の頭のまわりの天井は光の輪（屋上には何も出さない）。
// 火葬炉はホールの奥に同じ箱の一部として入れ、排気は屋上の低い囲いの中（煙突は見せない）
function crematorium(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, pond?: PondBuilder) {
  const hw = f.W / 2, hd = f.D / 2;
  const conc = C(0xbdbab3), concD = C(0xb0ada6), joint = C(0xa6a39c), concL = C(0xc9c6bf);
  const glass = C(0x5d7686), mull = C(0x3a3d40), pave = C(0xd3cfc6), lawn = C(0x72a04d), asph = C(0x46494d);
  const roofG = C(0x9b9993), warm = C(0xffdca6), floorC = C(0xb9b4aa);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.06, lawn);

  // ---- 箱の寸法 ----
  const X0 = -hw + 5, X1 = hw - 5, Z0 = -hd + 4, Z1 = hd - 14; // 低い棟の外形
  const H = 6; // 低い棟の高さ
  const hx = Math.min(9.5, (X1 - X0) * 0.18), hz0 = Z0 + 6, hz1 = Z1; // 中央の告別ホール（ほかと同じ低い高さ、正面もそろえる）
  const colD = 3.4; // 列柱の奥行き（ガラスはこれだけ奥）

  // コンクリートの箱（打ち放しの素材）と、目地（型枠の継ぎ目）の細い線
  const cbox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col = conc, bottom = false) => {
    mb.matOverride = MAT.concrete;
    mb.box(x0, y0, z0, x1, y1, z1, col, PAT.none, col, bottom);
    mb.matOverride = null;
  };
  // 壁の面（+x, -x, +z, -z のどれか）に目地：横は 1.2m ごと、縦は 2.4m ごと
  const joints = (side: 'px' | 'nx' | 'pz' | 'nz', a0: number, a1: number, y0: number, y1: number, p: number) => {
    mb.matOverride = MAT.concrete;
    const o = side === 'px' || side === 'pz' ? 0.03 : -0.03;
    const put = (u0: number, v0: number, u1: number, v1: number) => {
      if (side === 'px' || side === 'nx') mb.box(Math.min(p, p + o), v0, u0, Math.max(p, p + o), v1, u1, joint);
      else mb.box(u0, v0, Math.min(p, p + o), u1, v1, Math.max(p, p + o), joint);
    };
    for (let y = y0 + 1.2; y < y1 - 0.4; y += 1.2) put(a0 + 0.05, y - 0.03, a1 - 0.05, y + 0.03);
    for (let a = a0 + 2.4; a < a1 - 0.5; a += 2.4) put(a - 0.03, y0 + 0.05, a + 0.03, y1 - 0.05);
    mb.matOverride = null;
  };
  // 屋上：内側に一段低く見える砂利の面と、まわりのパラペット（立ち上がり）
  // skipX：その x の辺（ホールとつながる側）には立ち上がりを付けない（屋根を一続きに見せる）
  const roofTop = (x0: number, z0: number, x1: number, z1: number, y: number, hole?: [number, number, number, number], skipX?: number) => {
    mb.matOverride = MAT.gravel;
    const gq = (a0: number, b0: number, a1: number, b1: number) => { if (a1 > a0 && b1 > b0) mb.quad([a0, y + 0.01, b1], [a1, y + 0.01, b1], [a1, y + 0.01, b0], [a0, y + 0.01, b0], roofG); };
    const ix0 = x0 + 0.35, ix1 = x1 - 0.35, iz0 = z0 + 0.35, iz1 = z1 - 0.35;
    if (!hole) gq(ix0, iz0, ix1, iz1);
    else {
      const [hx0, hz0, hx1, hz1] = hole;
      gq(ix0, iz0, ix1, hz0 - 0.35);
      gq(ix0, hz1 + 0.35, ix1, iz1);
      gq(ix0, hz0 - 0.35, hx0 - 0.35, hz1 + 0.35);
      gq(hx1 + 0.35, hz0 - 0.35, ix1, hz1 + 0.35);
    }
    mb.matOverride = null;
    const rim = (a0: number, b0: number, a1: number, b1: number) => {
      cbox(a0, y, b0, a1, y + 0.45, b0 + 0.35, concL);
      cbox(a0, y, b1 - 0.35, a1, y + 0.45, b1, concL);
      if (a0 !== skipX) cbox(a0, y, b0 + 0.35, a0 + 0.35, y + 0.45, b1 - 0.35, concL);
      if (a1 !== skipX) cbox(a1 - 0.35, y, b0 + 0.35, a1, y + 0.45, b1 - 0.35, concL);
    };
    rim(x0, z0, x1, z1);
    if (hole) rim(hole[0] - 0.35, hole[1] - 0.35, hole[2] + 0.35, hole[3] + 0.35);
  };
  // 枠に入ったガラス（縦の細い方立て）。面は z = z、x0..x1
  const glassZ = (x0: number, x1: number, y0: number, y1: number, z: number, step = 1.5) => {
    mb.box(x0, y0, z - 0.06, x1, y1, z + 0.06, glass, PAT.fullglass, mull);
    const n = Math.max(1, Math.round((x1 - x0) / step));
    for (let i = 0; i <= n; i++) { const x = x0 + ((x1 - x0) * i) / n; mb.box(x - 0.05, y0, z - 0.1, x + 0.05, y1, z + 0.1, mull); }
  };
  const glassX = (z0: number, z1: number, y0: number, y1: number, x: number, step = 1.5) => {
    mb.box(x - 0.06, y0, z0, x + 0.06, y1, z1, glass, PAT.fullglass, mull);
    const n = Math.max(1, Math.round((z1 - z0) / step));
    for (let i = 0; i <= n; i++) { const z = z0 + ((z1 - z0) * i) / n; mb.box(x - 0.1, y0, z - 0.05, x + 0.1, y1, z + 0.05, mull); }
  };

  // ---- 足元の基壇と前庭 ----
  mb.ground(X0 - 1.2, Z0 - 1.2, X1 + 1.2, hz1 + 3.2, 0.09, pave);
  // 正面の車寄せ（前庭をよこぎる）と、道路への 2 本の出入り口、右の駐車場
  const lz0 = hz1 + 3.2, lz1 = lz0 + 5;
  const ex0 = -hx - 9, ex1 = hx + 5;
  mb.ground(ex0, lz0, ex1, lz1, 0.1, asph);
  mb.ground(ex0, lz1, ex0 + 5, hd - 0.3, 0.1, asph);
  mb.ground(ex1 - 5, lz1, ex1, hd - 0.3, 0.1, asph);
  const px0 = ex1 + 2, px1 = hw - 1.5;
  if (px1 - px0 > 6) {
    mb.ground(px0, lz0 - 1, px1, hd - 0.3, 0.1, asph);
    for (let x = px0 + 0.4; x < px1; x += 2.6) mb.ground(x, hd - 5.6, x + 0.12, hd - 0.8, 0.12, PALETTE.white);
    for (let k = 0; k < 4; k++) if (rng.next() < 0.6) parkedCar(mb, px0 + 1.7 + k * 2.6, hd - 5.6, hd - 0.8, rng);
  }
  // 車止めの低い柱（夜は足元を照らす）
  for (let x = ex0 + 1; x <= ex1 - 1; x += 3) mb.cylinder(x, lz0 - 0.3, 0, 0.8, 0.13, 8, concD, warm);
  // 入口の島：低いコンクリートの壁に施設名、木
  cbox(ex0 + 6.5, 0, hd - 3.2, ex1 - 6.5, 0.9, hd - 2.7, concD);
  mb.box(ex0 + 7, 0.35, hd - 2.72, ex0 + 13, 0.55, hd - 2.68, warm, PAT.glow, warm);

  // ---- 左右の低い棟（中庭を切り込んだ、穴のあいた箱）----
  // 穴 (cx0..cx1, cz0..cz1) を残して 4 つの箱で囲む。中庭に面するところはガラス
  const wing = (x0: number, x1: number, c: [number, number, number, number], water: boolean) => {
    const [cx0, cz0, cx1, cz1] = c;
    const zb = Z1 - colD; // ガラスの面（列柱の奥）
    // 本体（中庭の穴をあける）
    cbox(x0, 0, Z0, x1, H, cz0);
    cbox(x0, 0, cz1, x1, H, zb);
    cbox(x0, 0, cz0, cx0, H, cz1);
    cbox(cx1, 0, cz0, x1, H, cz1);
    // 中庭のガラス（上の 0.9m はコンクリートの梁）
    glassZ(cx0, cx1, 0.1, H - 0.9, cz0 - 0.02);
    glassZ(cx0, cx1, 0.1, H - 0.9, cz1 + 0.02);
    glassX(cz0, cz1, 0.1, H - 0.9, cx0 - 0.02);
    glassX(cz0, cz1, 0.1, H - 0.9, cx1 + 0.02);
    // 正面：奥まった全面ガラス、深い庇（屋根の板）と列柱
    glassZ(x0 + 0.4, x1 - 0.4, 0.1, H - 1.0, zb + 0.08, 1.8);
    cbox(x0, H - 1.0, zb, x1, H, Z1, conc, true);
    const n = Math.max(2, Math.round((x1 - x0) / 3.2));
    for (let i = 0; i <= n; i++) {
      const x = x0 + 0.35 + ((x1 - x0 - 0.7) * i) / n;
      cbox(x - 0.35, 0, Z1 - 0.9, x + 0.35, H - 1.0, Z1 - 0.1);
    }
    // 列柱の下の石の床（夜は庇の下の明かり）
    mb.ground(x0, zb, x1, Z1, 0.11, C(0xbdb9b0));
    mb.box(x0 + 0.6, H - 1.04, zb + 0.6, x1 - 0.6, H - 1.0, zb + 0.9, warm, PAT.glow, warm);
    roofTop(x0, Z0, x1, Z1, H, c, x0 < 0 ? x1 : x0);
    // 中庭の中：木と苔、または水盤
    if (water) {
      mb.ground(cx0, cz0, cx1, cz1, 0.1, C(0x3a4044));
      if (pond) {
        const sd = (x: number, z: number) => Math.min(x - cx0 - 0.6, cx1 - 0.6 - x, z - cz0 - 0.6, cz1 - 0.6 - z);
        pond.addLocal(cx0, cz0, cx1, cz1, 0.14, (x, z) => LAKE_T + 0.012 + sd(x, z) * 0.6, (x, y, z) => mb.world(x, y, z), 0.6);
      } else mb.ground(cx0 + 0.6, cz0 + 0.6, cx1 - 0.6, cz1 - 0.6, 0.14, PALETTE.water);
      mb.ground(cx0, cz0, cx1, cz0 + 0.6, 0.18, C(0x9c9a95));
      mb.ground(cx0, cz1 - 0.6, cx1, cz1, 0.18, C(0x9c9a95));
      mb.ground(cx0, cz0, cx0 + 0.6, cz1, 0.18, C(0x9c9a95));
      mb.ground(cx1 - 0.6, cz0, cx1, cz1, 0.18, C(0x9c9a95));
    } else {
      // 白い砂利の中庭（木は植えない）と、低い石の板
      mb.ground(cx0, cz0, cx1, cz1, 0.1, C(0xd9d5cc));
      cbox((cx0 + cx1) / 2 - 2.2, 0, (cz0 + cz1) / 2 - 0.5, (cx0 + cx1) / 2 + 2.2, 0.45, (cz0 + cz1) / 2 + 0.5, concD);
    }
    // 外側の妻壁の目地と、細い縦のスリット窓
    const ex = x0 < 0 ? x0 : x1, side = x0 < 0 ? 'nx' : 'px';
    joints(side, Z0, Z1 - colD, 0, H, ex);
    for (let z = Z0 + 3; z < Z1 - colD - 2; z += 4.2) mb.box(ex - 0.05, 0.6, z, ex + 0.05, H - 1.2, z + 0.45, glass, PAT.fullglass, glass);
    joints('nz', x0, x1, 0, H, Z0);
  };
  const ww = (X1 - X0) / 2 - hx;
  const cw = Math.min(9, ww * 0.42), cd = Math.min(9, (Z1 - colD - Z0) * 0.32);
  const lc = X0 + ww * 0.42, rc = X1 - ww * 0.48;
  wing(X0, -hx, [lc - cw / 2, Z0 + 5.5, lc + cw / 2, Z0 + 5.5 + cd], false);
  wing(hx, X1, [rc - cw / 2, Z1 - colD - 3 - cd, rc + cw / 2, Z1 - colD - 3], true);

  // ---- 中央の告別ホール：左右の棟と同じ低い高さ。正面の列柱とガラスも続け、中に細い丸柱の「柱の森」----
  const zb = Z1 - colD, wt = 0.8;
  cbox(-hx, H - 0.9, hz0, hx, H, zb, concD, true); // 屋根の板（下の面も描く）
  mb.matOverride = MAT.gravel;
  mb.quad([-hx, H + 0.01, Z1 - 0.35], [hx, H + 0.01, Z1 - 0.35], [hx, H + 0.01, hz0], [-hx, H + 0.01, hz0], roofG);
  mb.matOverride = null;
  cbox(-hx, H, Z1 - 0.35, hx, H + 0.45, Z1, concL); // 正面のパラペット（左右の棟とつながる）
  // 正面：奥まった全面ガラスと、深い庇・列柱（左右の棟と同じ）
  glassZ(-hx + 0.4, hx - 0.4, 0.1, H - 1.0, zb + 0.08, 1.8);
  cbox(-hx, H - 1.0, zb, hx, H, Z1, conc, true);
  { const n = Math.max(2, Math.round((2 * hx) / 3.2)); for (let i = 1; i < n; i++) { const x = -hx + (2 * hx * i) / n; cbox(x - 0.35, 0, Z1 - 0.9, x + 0.35, H - 1.0, Z1 - 0.1); } }
  mb.ground(-hx, zb, hx, Z1, 0.11, C(0xbdb9b0));
  mb.box(-hx + 0.6, H - 1.04, zb + 0.6, hx - 0.6, H - 1.0, zb + 0.9, warm, PAT.glow, warm);
  // ホールの床と、奥の壁の内側（夜はほのかに明るい）
  mb.box(-hx, 0, hz0 + wt, hx, 0.15, zb - 0.2, floorC, PAT.none, C(0x9a9083));
  { const gy = 0.16, gc = C(0x7d6f58); mb.quad([-hx + 0.5, gy, zb - 0.8], [hx - 0.5, gy, zb - 0.8], [hx - 0.5, gy, hz0 + wt + 0.5], [-hx + 0.5, gy, hz0 + wt + 0.5], gc, PAT.glow); }
  mb.box(-hx, 0.15, hz0 + wt, hx, H - 1.0, hz0 + wt + 0.05, C(0xd6c8aa), PAT.glow, C(0xd6c8aa));
  // 柱の森：細い丸柱をランダムに。頭のまわりの天井に光の輪
  const cols: [number, number][] = [];
  const ix0 = -hx + 1.2, ix1 = hx - 1.2, iz0 = hz0 + wt + 1.2, iz1 = zb - 1.6;
  for (let t = 0; t < 400 && cols.length < 18; t++) {
    const x = ix0 + rng.next() * (ix1 - ix0), z = iz0 + rng.next() * (iz1 - iz0);
    if (cols.every(([a2, b2]) => Math.hypot(a2 - x, b2 - z) > 2.4)) cols.push([x, z]);
  }
  const yC = H - 0.9;
  const disc = (cx: number, cz: number, y: number, r: number, col: THREE.Color, pat: number, up: boolean) => {
    const n = 18;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const p0: [number, number, number] = [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], p1: [number, number, number] = [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r];
      if (up) mb.tri([cx, y, cz], p1, p0, col, pat); else mb.tri([cx, y, cz], p0, p1, col, pat);
    }
  };
  for (const [x, z] of cols) {
    mb.matOverride = MAT.concrete;
    mb.cylinder(x, z, 0.15, yC, 0.26, 12, concL);
    mb.matOverride = null;
    disc(x, z, yC - 0.02, 1.0, C(0xfff1d6), PAT.glow, false);
  }

  // ---- 奥：火葬炉の棟（同じ高さの箱の一部）と、低い排気の囲い ----
  cbox(-hx, 0, Z0, hx, H, hz0 + wt, concD);
  mb.matOverride = MAT.gravel;
  mb.quad([-hx, H + 0.01, hz0 + wt], [hx, H + 0.01, hz0 + wt], [hx, H + 0.01, Z0 + 0.35], [-hx, H + 0.01, Z0 + 0.35], roofG);
  mb.matOverride = null;
  cbox(-hx, H, Z0, hx, H + 0.45, Z0 + 0.35, concL);
  joints('nz', -hx, hx, 0, H, Z0);
  cbox(-2.5, H, Z0 + 1.5, 2.5, H + 1.0, Z0 + 4, conc);
  for (let x = -2.2; x < 2.3; x += 0.45) mb.box(x, H + 0.15, Z0 + 3.98, x + 0.2, H + 0.85, Z0 + 4.08, mull);
  mb.box(-2.5, 0, Z0 - 0.06, 2.5, 3.8, Z0, C(0x4a4e52)); // 裏の霊柩車の出入り口

  // ---- まわりの林（敷地を静かに囲む）----
  for (let z = -hd + 2; z < lz0 - 1; z += 4.2) for (const sx of [-1, 1]) tf(sx * (hw - 1.8) + (rng.next() - 0.5), z + rng.next(), 0.8 + 0.3 * rng.next(), rng.next() < 0.5 ? 1 : 0);
  for (let x = -hw + 4; x < hw - 3; x += 4.2) tf(x + rng.next(), -hd + 1.6, 0.85 + 0.3 * rng.next(), rng.next() < 0.45 ? 1 : 0);
  for (let x = -hw + 3; x < ex0 - 1; x += 4.5) tf(x, hd - 2.5, 0.8, 0, 0, undefined, 3);
  tf((ex0 + 5 + ex1 - 5) / 2 - 4, lz1 + 2.5, 0.75);
  tf((ex0 + 5 + ex1 - 5) / 2 + 5, lz1 + 3, 0.7, 0, 0, undefined, 2);
}

// ---------------- 工業（汚染型・製造業・倉庫業） ----------------
// 汚染型：大きい敷地は製鉄所か石油化学プラント、中くらいは石油化学か煙突の工場、小さい敷地は煙突の工場。
// 製造業：大きい敷地は自動車工場か現代の工場、ほかは現代の工場（のこぎり屋根の天窓）。
// 倉庫業：いつも物流施設（形は logisticsA・B）。
// 確認用：window.__logi で物流施設の形を強制しているときは、どれもその形で描く
function dirtyIndustry(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const dbg = forcedLogi();
  if (dbg) return dbg(mb, f, rng, tf, den);
  const cells = Math.round((f.W * f.D) / (CELL * CELL)), r = rng.next();
  if (cells >= 9) return r < 0.5 ? steelMill(mb, f, rng, den) : petrochem(mb, f, rng, den);
  // 石油化学は正面の幅が 3 マス以上のときだけ（蒸留塔と加熱炉が横に並ぶので、2 マスでは敷地からはみ出す）
  if (cells >= 6) return r < 0.45 && f.W >= 48 ? petrochem(mb, f, rng, den) : stackFactory(mb, f, rng, tf, den);
  return stackFactory(mb, f, rng, tf, den);
}
function mfgIndustry(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const dbg = forcedLogi();
  if (dbg) return dbg(mb, f, rng, tf, den);
  const cells = Math.round((f.W * f.D) / (CELL * CELL)), r = rng.next();
  if (cells >= 9) return r < 0.6 ? autoPlant(mb, f, rng, tf, den) : modernFactory(mb, f, rng, tf, den);
  return modernFactory(mb, f, rng, tf, den);
}
// 倉庫業。連結した敷地（buildingLayer で決める）は、連結の種と密度で決める（種類・高さがそろう）
// port = 港・貨物駅への近さ（0..1）
function warehousing(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number, seed: number, port: number) {
  const cs = f.campus ?? seed, cden = f.cden ?? den;
  const dbg = forcedLogi();
  if (dbg) return dbg(mb, f, rng, tf, cden);
  if (logiPick(mb, f, rng, tf, cden, cs, port)) return;
  modernFactory(mb, f, rng, tf, den);
}
// 種から決まる 0..1 の値（k ごとに別の値）
function seedRoll(seed: number, k: number) {
  let h = (seed ^ Math.imul(k, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// 倉庫業の建物の種類を選んで建てる（形は logisticsA・B）。近さで帯に分ける：岸壁のすぐそばはコンテナヤード、
// その外に冷凍・冷蔵倉庫、さらに外に配送センターと背の高いマルチテナント型（岸壁から外へ、低い→高いの順に並ぶ）。
// 内陸は配送センターとマルチテナント型が中心で、冷凍・冷蔵倉庫が少し。マルチテナント型は 3×3 以上だけ。
// 冷凍・冷蔵倉庫の帯でも、ふつうの大きさの敷地は半分ほどにとどめる（窓のない白い箱ばかりが並ばないように）。
// 港のそばの大きな敷地（長い辺が 5 マス以上）は、長いマルチテナント型と長い配送センター・トラックターミナルが多い。
// 種類は種から決める（建物の rng の並びは変えない）。連結した敷地はどれも同じ種・大きさ・近さなので、同じ種類になる。登録がなければ false
function logiPick(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number, seed: number, port: number): boolean {
  const cells = Math.round((f.W * f.D) / (CELL * CELL));
  const wide = Math.min(f.W, f.D) >= 60, mid = cells >= 9, big = Math.max(f.W, f.D) >= 5 * CELL;
  const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const bell = (c: number, s: number) => Math.exp(-(((port - c) / s) ** 2));
  const near = ss(0.75, 1, port);
  // 連結した敷地（1 つの長い建物にする）はコンテナヤードにしない（ヤードは敷地ごとに柵で囲むので、つながらない）
  const joined = !!(f.joinL || f.joinR);
  const w: [string, number][] = [
    ['containerYard', joined ? 0 : (big ? 1.8 : 3) * near],
    ['coldStorage', big ? 0.7 * (0.3 + 2.2 * bell(0.65, 0.2)) : 0.3 + 1.1 * bell(0.65, 0.2)],
    ['distCenter', (big ? 1.6 : 1) * (0.7 + 1.2 * bell(0.45, 0.3))],
    ['multiTenant', mid ? (big ? (wide ? 2.2 : 1.6) : wide ? 1 : 0.5) * (0.6 + 1.2 * bell(0.35, 0.3)) : 0],
  ];
  const ok = w.filter(([k, v]) => v > 0 && LOGI[k]);
  if (!ok.length) return false;
  let u = seedRoll(seed, 2) * ok.reduce((s, [, v]) => s + v, 0);
  let k = ok[ok.length - 1][0];
  for (const [n, v] of ok) if ((u -= v) < 0) { k = n; break; }
  LOGI[k](mb, f, rng, tf, den);
  return true;
}

const IND = {
  rust: C(0x8a5a44), darkMetal: C(0x4a4f55), metal: [C(0xd5d9dc), C(0xc4cacf), C(0xb9c0c6), C(0xe4e6e8)], steel: C(0x7a8088), pipe: C(0x9aa1a8),
  ore: C(0x8b4a32), coal: C(0x2b2b2e), lime: C(0xcfc8b8), white: C(0xeef0f2), tankGreen: C(0xd9dfd6), yellow: C(0xe0b31a), lamp: C(0xffe1a3),
  red: C(0xc0392b),
};

// 夜の設備の明かり（小さな光る点を並べる）
function plantLights(mb: MeshBuilder, x: number, z: number, y0: number, y1: number, r: number) {
  for (let y = y0; y < y1; y += 5) for (const a of [0, 2.1, 4.2]) litSign(mb, x + Math.cos(a + y) * r - 0.15, y, z + Math.sin(a + y) * r - 0.15, x + Math.cos(a + y) * r + 0.15, y + 0.3, z + Math.sin(a + y) * r + 0.15, IND.lamp);
}
// 紅白の煙突（口から煙）
function redWhiteStack(mb: MeshBuilder, x: number, z: number, y0: number, h: number, r: number, smoke = true, dark = false) {
  const bands = 6;
  for (let k = 0; k < bands; k++) mb.cylinder(x, z, y0 + (h * k) / bands, y0 + (h * (k + 1)) / bands, r * (1 - k * 0.05), 14, k % 2 ? IND.white : IND.red, k === bands - 1 ? PALETTE.dark : undefined, r * (1 - (k + 1) * 0.05));
  litSign(mb, x - 0.25, y0 + h, z - r - 0.1, x + 0.25, y0 + h + 0.5, z - r + 0.3, C(0xff3b30));
  if (smoke) fxSmoke(mb, x, y0 + h, z, Math.max(0.8, r * 0.7), dark);
}
// 傾いたベルトコンベア（a から b へ、屋根つきの箱と支柱）
function conveyor(mb: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w = 1.6) {
  const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, px = (-dz / l) * w / 2, pz = (dx / l) * w / 2;
  const P = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const top = 1.2;
  mb.quad(P(ax - px, ay + top, az - pz), P(ax + px, ay + top, az + pz), P(bx + px, by + top, bz + pz), P(bx - px, by + top, bz - pz), IND.metal[1]);
  mb.quad(P(ax + px, ay, az + pz), P(ax + px, ay + top, az + pz), P(bx + px, by + top, bz + pz), P(bx + px, by, bz + pz), IND.metal[2]);
  mb.quad(P(bx - px, by, bz - pz), P(bx - px, by + top, bz - pz), P(ax - px, ay + top, az - pz), P(ax - px, ay, az - pz), IND.metal[2]);
  mb.quad(P(ax - px, ay, az - pz), P(bx - px, by, bz - pz), P(bx + px, by, bz + pz), P(ax + px, ay, az + pz), IND.darkMetal);
  const n = Math.max(1, Math.floor(l / 9));
  for (let k = 1; k < n; k++) {
    const t = k / n, x = ax + dx * t, z = az + dz * t, y = ay + (by - ay) * t;
    mb.box(x - 0.3, 0, z - 0.3, x + 0.3, y, z + 0.3, IND.steel);
  }
}
// 円錐の山（鉱石・石炭・石灰）
function pile(mb: MeshBuilder, x: number, z: number, r: number, h: number, col: THREE.Color) {
  mb.cylinder(x, z, 0, h, r, 14, col, col, 0.4);
}
// 球形タンク（脚つき）
function sphereTank(mb: MeshBuilder, x: number, z: number, r: number) {
  const y = r + 2;
  mb.dome(x, z, y, r, r, IND.white, 18, 6);
  // 下半分（裏返したドーム）：小さく作って下から見えるように
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    mb.box(x + Math.cos(a) * r * 0.85 - 0.2, 0, z + Math.sin(a) * r * 0.85 - 0.2, x + Math.cos(a) * r * 0.85 + 0.2, y, z + Math.sin(a) * r * 0.85 + 0.2, IND.steel);
  }
  mb.cylinder(x, z, y - r * 0.7, y, r * 0.72, 18, IND.white, IND.white, r);
  mb.cylinder(x, z, 2, y - r * 0.7, r * 0.2, 12, IND.white, IND.white, r * 0.72);
  // 頂上への階段（らせん状に見える細い帯）
  mb.box(x + r - 0.1, 0, z - 0.4, x + r + 0.6, y + r * 0.6, z + 0.4, IND.yellow);
}

// 製鉄所：高炉（骨組みの塔と、横の熱風炉3基）、鉱石と石炭の山、山から高炉の上へのベルトコンベア、長い圧延工場、紅白の煙突
function steelMill(mb: MeshBuilder, f: LotFrame, rng: Rng, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, C(0x8f8a80));
  const s = 1 + den * 0.15;
  // 圧延工場（手前の長い建屋、切妻の金属屋根）
  const mz0 = hd - 18, mz1 = hd - 4;
  mb.box(-hw + 3, 0, mz0, hw - 3, 14, mz1, IND.metal[2], PAT.industrial, IND.rust);
  mb.gableX(-hw + 3, mz0, hw - 3, mz1, 14, 3, IND.rust, IND.metal[2], 0.5);
  for (let x = -hw + 8; x < hw - 6; x += 10) mb.box(x - 1.2, 17, (mz0 + mz1) / 2 - 1, x + 1.2, 18.6, (mz0 + mz1) / 2 + 1, IND.metal[0]);
  // 高炉
  const bx = -hw * 0.25, bz = -hd * 0.25, bh = 34 * s;
  mb.cylinder(bx, bz, 0, 10, 6, 18, IND.darkMetal, IND.darkMetal, 7);
  mb.cylinder(bx, bz, 10, bh * 0.7, 7, 18, IND.rust, IND.rust, 4.5);
  mb.cylinder(bx, bz, bh * 0.7, bh, 4.5, 14, IND.darkMetal, IND.darkMetal, 2.4);
  // 骨組み（四隅の柱と横の梁）
  for (const [ox, oz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) mb.box(bx + ox - 0.35, 0, bz + oz - 0.35, bx + ox + 0.35, bh + 6, bz + oz + 0.35, IND.steel);
  for (let y = 8; y < bh + 6; y += 8) {
    mb.box(bx - 8.4, y, bz - 8.4, bx + 8.4, y + 0.4, bz - 7.6, IND.steel);
    mb.box(bx - 8.4, y, bz + 7.6, bx + 8.4, y + 0.4, bz + 8.4, IND.steel);
    mb.box(bx - 8.4, y, bz - 8.4, bx - 7.6, y + 0.4, bz + 8.4, IND.steel);
    mb.box(bx + 7.6, y, bz - 8.4, bx + 8.4, y + 0.4, bz + 8.4, IND.steel);
  }
  // 炉頂のガス管（下へ）
  mb.box(bx - 0.8, bh, bz - 0.8, bx + 0.8, bh + 6, bz + 0.8, IND.pipe);
  mb.box(bx, bh + 5, bz - 0.8, bx + 14, bh + 6.6, bz + 0.8, IND.pipe);
  fxSmoke(mb, bx, bh + 6, bz, 1.0, true);
  plantLights(mb, bx, bz, 6, bh, 8.2);
  // 熱風炉（ドームの円筒が3基）
  for (let k = 0; k < 3; k++) {
    const x = bx + 14, z = bz - 9 + k * 7.5;
    mb.cylinder(x, z, 0, bh * 0.8, 3.2, 16, IND.metal[2], IND.metal[2]);
    mb.dome(x, z, bh * 0.8, 3.2, 3.2, IND.metal[2], 16, 5);
  }
  // 鉱石・石炭・石灰の山と、高炉の上へのベルトコンベア
  const px0 = hw - 14;
  pile(mb, px0, -hd + 9, 7, 6, IND.ore);
  pile(mb, px0 - 3, -hd + 22, 6, 5, IND.coal);
  pile(mb, -hw + 10, -hd + 9, 5, 4, IND.lime);
  conveyor(mb, px0 - 6, 0.5, -hd + 12, bx + 5, bh + 1, bz);
  // 紅白の煙突
  redWhiteStack(mb, hw - 7, mz0 - 6, 0, 46 * s, 2.2, true, true);
  // トラック（鉱石の山へ）
  fxTruck(mb, [[hw - 2, 0, hd - 1], [hw - 2, 0, mz0 - 3], [px0 + 4, 0, -hd + 16]], 8, 0x9a6b3a);
  void rng;
}

// 石油化学プラント：球形タンク、浮き屋根の円筒タンク、蒸留塔（足場とプラットフォーム、夜の明かり）、パイプラック、フレアスタック（炎）
function petrochem(mb: MeshBuilder, f: LotFrame, rng: Rng, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const s = 1 + den * 0.2;
  // 球形タンク（奥の列）
  const nS = Math.max(2, Math.floor((f.W - 16) / 12));
  for (let k = 0; k < nS; k++) sphereTank(mb, -hw + 9 + k * 12, -hd + 8, 4.2);
  // 浮き屋根の円筒タンク（手前右）
  for (let k = 0; k < Math.max(1, Math.floor(f.W / 26)); k++) {
    const x = hw - 9 - k * 15, z = hd - 10;
    mb.cylinder(x, z, 0, 9, 6.5, 22, IND.tankGreen, C(0xb9beb6));
    mb.cylinder(x, z, 8.6, 9.1, 6.6, 22, IND.white, IND.white);
    // 防油堤
    mb.box(x - 8, 0, z - 8, x + 8, 1, z - 7.6, PALETTE.concrete);
    mb.box(x - 8, 0, z + 7.6, x + 8, 1, z + 8, PALETTE.concrete);
  }
  // 蒸留塔と足場（中央）
  const cx0 = -hw + 10, cz = -hd + 22;
  const nC = 2 + rng.int(3);
  for (let k = 0; k < nC; k++) {
    const x = cx0 + k * 6, th = (22 + rng.next() * 14) * s, r = 1.4 + rng.next() * 0.8;
    mb.cylinder(x, cz, 0, th, r, 14, C(0xd3d6d9), IND.steel);
    mb.dome(x, cz, th, r, r * 0.6, C(0xd3d6d9), 14, 3);
    for (let y = 6; y < th; y += 6) mb.cylinder(x, cz, y, y + 0.3, r + 0.8, 14, IND.yellow, IND.yellow);
    plantLights(mb, x, cz, 6, th, r + 0.9);
  }
  // 加熱炉（箱と短い煙突）
  const hx = cx0 + nC * 6 + 4;
  mb.box(hx, 0, cz - 4, hx + 8, 10, cz + 4, IND.metal[1], PAT.industrial, IND.metal[2]);
  mb.cylinder(hx + 4, cz, 10, 22 * s, 0.9, 10, IND.metal[0], PALETTE.dark);
  fxSmoke(mb, hx + 4, 22 * s, cz, 0.7);
  // パイプラック（中央を横切る、配管の束）
  const rz = cz + 8;
  for (let x = -hw + 4; x < hw - 4; x += 7) mb.box(x - 0.3, 0, rz - 2, x + 0.3, 7, rz + 2, IND.steel);
  for (const [y, c] of [[6.2, IND.pipe], [6.9, C(0x6f8fae)], [5.5, C(0xb9a06a)]] as [number, THREE.Color][]) for (const dz of [-1.2, 0, 1.2]) mb.box(-hw + 4, y, rz + dz - 0.3, hw - 4, y + 0.55, rz + dz + 0.3, c);
  // フレアスタック（細い塔、先で炎が燃える）
  const fx0 = hw - 5, fz0 = -hd + 5, fh = (40 + rng.next() * 10) * s;
  mb.cylinder(fx0, fz0, 0, fh, 0.7, 10, IND.steel, PALETTE.dark, 0.5);
  for (const [ox, oz] of [[-3, -3], [3, -3], [0, 3.5]]) mb.quad([fx0 + ox - 0.2, 0, fz0 + oz], [fx0 + ox + 0.2, 0, fz0 + oz], [fx0 + 0.2, fh * 0.8, fz0], [fx0 - 0.2, fh * 0.8, fz0], IND.steel);
  fxFlare(mb, fx0, fh + 0.3, fz0, 1.2);
  // 制御棟
  mb.box(-hw + 2, 0, hd - 10, -hw + 14, 6, hd - 2, IND.metal[0], PAT.office, flatRoof());
  // タンクローリー
  fxTruck(mb, [[-hw + 18, 0, hd - 0.5], [-hw + 18, 0, rz + 5], [0, 0, rz + 5]], 10, 0xe8e8e8);
}

// 煙突の工場（作り直し）：金属パネルの建屋（屋根の換気モニター）、集じん機（円錐の底のサイロ）と太いダクト、紅白の煙突、事務所
function stackFactory(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const wall = rng.pick(IND.metal), roof = rng.pick([C(0x5c6b78), C(0x7d8a94), C(0x4f6a5a)]);
  const x0 = -hw + 3, x1 = hw - 3 - Math.min(9, f.W * 0.25), z0 = -hd + 3, z1 = hd - 9;
  const h = (10 + rng.next() * 3) * (1 + den * 0.25);
  mb.box(x0, 0, z0, x1, h, z1, wall, PAT.industrial, roof);
  mb.gableX(x0, z0, x1, z1, h, 2.2, roof, wall, 0.4);
  // 屋根の換気モニター（棟の上の細長い箱）
  mb.box(x0 + 3, h + 2.2, (z0 + z1) / 2 - 1.4, x1 - 3, h + 3.6, (z0 + z1) / 2 + 1.4, wall, PAT.industrial, roof);
  // 集じん機とダクト（1 マス幅の敷地でも、はみ出さないように）
  const sx = Math.min(x1 + 4.5, hw - 2.7), sz = z0 + 6;
  mb.cylinder(sx, sz, 4, 13, 2.6, 14, IND.metal[0], IND.metal[0]);
  mb.cylinder(sx, sz, 1.5, 4, 0.6, 14, IND.metal[0], IND.metal[0], 2.6);
  for (const [ox, oz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) mb.box(sx + ox - 0.15, 0, sz + oz - 0.15, sx + ox + 0.15, 4, sz + oz + 0.15, IND.steel);
  mb.box(x1, h - 2, sz - 0.8, sx - 2.6, h - 0.4, sz + 0.8, IND.pipe);
  // 煙突
  redWhiteStack(mb, sx, Math.min(sz + 7, hd - 1.5), 0, (26 + rng.next() * 10) * (1 + den * 0.3), 1.4, true, rng.next() < 0.4);
  // 事務所と搬入口
  mb.box(x0, 0, z1, x0 + Math.min(12, (x1 - x0) / 2), 7, z1 + 4.5, MW, PAT.ribbon, flatRoof());
  for (let x = x0 + 14; x < x1 - 4; x += 5) mb.box(x, 0, z1, x + 3.6, 4, z1 + 0.15, C(0x6b7178));
  fxTruck(mb, [[x1 - 4, 0, hd - 0.5], [x1 - 4, 0, z1 + 5]], 7, 0xf2f2f2);
  tf(-hw + 1.5, hd - 1.5, 0.8);
}

// 現代の工場：白か黒の金属パネル、のこぎり屋根の天窓（北向きのガラス）、ガラスの事務棟、荷積み場（ひさしとトラック）、駐車場
function modernFactory(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const black = rng.next() < 0.3;
  const wall = black ? C(0x2e3236) : rng.pick([MW, C(0xe4e6e8), C(0xd5d9dc)]);
  const accent = rng.pick([C(0x1f6fd0), C(0xd23a3a), C(0x2e9e5b), C(0xe0a800)]);
  const big = f.D >= 40;
  const x0 = -hw + 3, x1 = hw - 3, z0 = -hd + 3, z1 = hd - (big ? 20 : 11);
  const h = 11 + den * 2;
  mb.box(x0, 0, z0, x1, h, z1, wall, PAT.industrial, C(0xbfc5ca));
  // 会社の色の帯
  mb.box(x0 - 0.05, h - 2, z0 - 0.05, x1 + 0.05, h - 1.2, z1 + 0.05, accent);
  // のこぎり屋根：北（-z）向きのガラス面
  const teeth = Math.max(2, Math.floor((z1 - z0) / 7)), tw = (z1 - z0) / teeth;
  for (let k = 0; k < teeth; k++) {
    const a = z0 + k * tw, b = a + tw;
    mb.quad([x0, h, b], [x1, h, b], [x1, h + 3.2, a], [x0, h + 3.2, a], C(0xc9cfd5));
    mb.quad([x1, h, a], [x0, h, a], [x0, h + 3.2, a], [x1, h + 3.2, a], MGL, PAT.fullglass);
    mb.tri([x0, h, a], [x0, h, b], [x0, h + 3.2, a], wall);
    mb.tri([x1, h, b], [x1, h, a], [x1, h + 3.2, a], wall);
  }
  // ガラスの事務棟（角）
  const ow = Math.min(18, (x1 - x0) * 0.35);
  mb.box(x0, 0, z1, x0 + ow, 8, z1 + 6, MGL, PAT.fullglass, MW);
  mb.box(x0 - 0.3, 8, z1 - 0.3, x0 + ow + 0.3, 8.6, z1 + 6.3, MW, PAT.none, MW2);
  litSign(mb, x0 + 1, 6.6, z1 + 6.05, x0 + ow - 1, 7.5, z1 + 6.2, accent);
  // 荷積み場（シャッターとひさし）
  const dockX0 = x0 + ow + 3;
  for (let x = dockX0; x < x1 - 4; x += 4.6) mb.box(x, 0.8, z1, x + 3.4, 4.6, z1 + 0.15, C(0x6b7178));
  mb.box(dockX0 - 1, 5.2, z1, x1 - 1, 5.5, z1 + 3, MW, PAT.none, MW2);
  mb.box(dockX0 - 1, 0, z1, x1 - 1, 0.8, z1 + 1.5, PALETTE.concrete);
  // 荷積み場に出入りするトラック（2台）
  for (let k = 0; k < 2; k++) {
    const x = dockX0 + 1.7 + k * 9.2;
    if (x > x1 - 6) break;
    fxTruck(mb, [[x - 1.7, 0, hd - 0.5], [x - 1.7, 0, z1 + 14], [x, 0, z1 + 9.5]], 9 + k * 3, rng.pick([0xf2f2f2, 0x1d3f8a, 0x9a1d1d]));
  }
  if (big) ihParking(mb, rng, x0, z1 + 7, x0 + ow + 2, hd - 0.6);
  tf(hw - 1.5, hd - 1.5, 0.8);
}

// 自動車工場：長い組み立て棟、背の高い塗装棟（排気筒と煙）、プレス棟、完成車がずらりと並ぶ駐車場、運ぶキャリアカー
function autoPlant(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const wall = rng.pick([MW, C(0xe4e6e8)]), accent = rng.pick([C(0x1f6fd0), C(0xd23a3a), C(0x1f1f1f)]);
  const lotD = Math.min(22, f.D * 0.35);
  const z0 = -hd + 3, z1 = hd - lotD - 3;
  // 組み立て棟（左、長い）
  const ax1 = hw * 0.25;
  mb.box(-hw + 3, 0, z0, ax1, 13 + den, z1, wall, PAT.industrial, C(0xbfc5ca));
  mb.box(-hw + 2.95, 11, z0 - 0.05, ax1 + 0.05, 12, z1 + 0.05, accent);
  for (let x = -hw + 8; x < ax1 - 4; x += 9) mb.box(x, 13 + den, z0 + 3, x + 2, 14.5 + den, z1 - 3, MGL, PAT.fullglass, MGL);
  // 塗装棟（右奥、背が高い）と排気筒
  const px0 = ax1 + 3, pz1 = (z0 + z1) / 2;
  mb.box(px0, 0, z0, hw - 3, 20, pz1, C(0xd5d9dc), PAT.industrial, C(0xb4bac1));
  for (let x = px0 + 3; x < hw - 4; x += 7) {
    mb.cylinder(x, z0 + 4, 20, 30, 0.8, 10, IND.metal[0], PALETTE.dark);
    if (x < px0 + 10) fxSmoke(mb, x, 30, z0 + 4, 0.6);
  }
  // プレス棟（右手前）
  mb.box(px0, 0, pz1 + 2, hw - 3, 15, z1, IND.metal[2], PAT.industrial, C(0x9aa1a7));
  // 2つの棟をつなぐ渡り廊下（車体を運ぶ）
  mb.box(ax1, 8, z0 + 6, px0, 11, z0 + 10, IND.metal[1]);
  litSign(mb, -hw + 6, 9, z1 + 0.05, -hw + 22, 10.4, z1 + 0.2, accent);
  // 完成車の駐車場（色とりどりの車が並ぶ）
  const cars = [0xf2f2f2, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xd8d8d8, 0x3b5d3a, 0xb8bcc0].map(C);
  const ly0 = hd - lotD - 1, ly1 = hd - 4;
  mb.ground(-hw + 2, ly0, hw - 12, ly1, 0.1, PALETTE.asphalt);
  for (let z = ly0 + 1.5; z < ly1 - 2; z += 5.5)
    for (let x = -hw + 3; x < hw - 14; x += 2.3) {
      if (rng.next() < 0.1) continue;
      const col = cars[Math.floor(rng.next() * cars.length)];
      mb.box(x, 0.25, z, x + 1.7, 1.0, z + 4.2, col);
      mb.box(x + 0.1, 1.0, z + 1.1, x + 1.6, 1.45, z + 3.1, C(0x2a3440), PAT.none, col);
    }
  // キャリアカー（完成車を運び出す）
  fxTruck(mb, [[hw - 6, 0, hd - 0.5], [hw - 6, 0, ly0 + 2], [hw - 16, 0, ly0 + 2]], 12, 0xd23a3a);
  fxTruck(mb, [[hw - 9, 0, hd - 0.5], [hw - 9, 0, z1 + 3], [px0 + 4, 0, z1 + 3]], 8, 0xf2f2f2);
  tf(hw - 2, -hd + 2, 0.8);
}

// ハイテク産業：敷地の大きさで種類を変える（どれも白・ガラス・四角が基本）
//  ・小さい敷地（1×2・2×1）：縦のフィンの研究棟
//  ・2×2：縦のフィンの研究棟、またはデータセンター
//  ・3×2・2×3：研究キャンパス（2棟を渡り廊下でつなぎ、間は緑の中庭）、またはデータセンター
//  ・3×3 以上：半導体工場（白い大きな棟、屋上の設備、事務棟、設備棟、ガスのタンク）、または波打つ大屋根のテック本社
function hightech(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const cells = Math.round((f.W * f.D) / (CELL * CELL));
  const r = rng.next();
  if (cells <= 2) return finLabLot(mb, f, rng, tf, den);
  if (cells <= 4) return r < 0.6 ? finLabLot(mb, f, rng, tf, den) : dataCenter(mb, f, rng, tf, den);
  if (cells <= 6) return r < 0.55 ? labCampus(mb, f, rng, tf, den) : dataCenter(mb, f, rng, tf, den);
  return r < 0.65 ? semiFab(mb, f, rng, tf, den) : techHQ(mb, f, rng, tf);
}

const IH = {
  glass: C(0x46647f), deepGlass: C(0x3a5570), panel: [C(0xdedcd5), C(0xcfccc3), C(0xe8e6e0), C(0xc3c0b7)],
  solar: C(0x22385a), silver: [C(0xa9b6c4), C(0xb6c2cf), C(0x9eacbb)], blue: C(0x4fb3ff), red: C(0xff3b30),
  fence: C(0x8d949b), tank: C(0xeef0f2), cars: [0xf2f2f2, 0x2b2b2b, 0x9a1d1d, 0x1d3f8a, 0x8a8f96, 0xd8d8d8, 0x3b5d3a, 0x101820, 0xb8bcc0].map(C),
};

// 駐車場：白線の区画と、止まっている車（7割ほど）。区画は手前（+z）向きと奥向きの2列
function ihParking(mb: MeshBuilder, rng: Rng, x0: number, z0: number, x1: number, z1: number) {
  mb.ground(x0, z0, x1, z1, 0.1, PALETTE.asphalt);
  const rows: [number, number][] = z1 - z0 >= 15 ? [[z0 + 0.4, z0 + 5.4], [z1 - 5.4, z1 - 0.4]] : [[z0 + 0.4, z0 + 5.4]];
  for (const [ra, rb] of rows)
    for (let x = x0 + 1; x + 2.5 < x1 - 0.5; x += 2.6) {
      mb.ground(x, ra, x + 0.12, rb, 0.12, PALETTE.white);
      if (rng.next() < 0.7) {
        const cx = x + 1.3, cz = (ra + rb) / 2, col = IH.cars[Math.floor(rng.next() * IH.cars.length)];
        mb.box(cx - 0.85, 0.25, cz - 2.1, cx + 0.85, 1.0, cz + 2.1, col);
        mb.box(cx - 0.75, 1.0, cz - 1.0, cx + 0.75, 1.45, cz + 1.1, C(0x2a3440), PAT.none, col);
      }
    }
}

// 縦のフィンの研究棟：1階は奥まったガラス、上の階は濃いガラスの壁の前に、深さがなめらかに変わる白い縦のフィン（4面）
function finLab(mb: MeshBuilder, rng: Rng, x0: number, z0: number, x1: number, z1: number, h: number) {
  const gH = 4.2, y0 = gH + 0.5;
  mb.box(x0 + 1, 0, z0 + 1, x1 - 1, gH, z1 - 1, MGL, PAT.fullglass, MW2);
  mb.box(x0, gH, z0, x1, y0, z1, MW, PAT.none, MW);
  mb.box(x0 + 0.3, y0, z0 + 0.3, x1 - 0.3, h, z1 - 0.3, IH.glass, PAT.curtain, MW2);
  const ph = rng.next() * 6, S = 1.3, T = 0.13;
  const depth = (t: number) => 0.35 + 1.1 * (0.5 + 0.5 * Math.sin(t * 0.21 + ph));
  const W = x1 - x0, D = z1 - z0;
  for (let x = x0 + 0.8; x < x1 - 0.5; x += S) {
    const t = x - x0;
    mb.box(x - T, y0, z1 - 0.3, x + T, h, z1 - 0.3 + depth(t), MW);
    mb.box(x - T, y0, z0 + 0.3 - depth(2 * W + D - t), x + T, h, z0 + 0.3, MW);
  }
  for (let z = z0 + 0.8; z < z1 - 0.5; z += S) {
    const t = z - z0;
    mb.box(x1 - 0.3, y0, z - T, x1 - 0.3 + depth(W + D - t), h, z + T, MW);
    mb.box(x0 + 0.3 - depth(2 * W + D + t), y0, z - T, x0 + 0.3, h, z + T, MW);
  }
  // 屋根のスラブ（張り出し）と、屋上の太陽光パネル、機械室
  mb.box(x0 - 0.8, h, z0 - 0.8, x1 + 0.8, h + 0.8, z1 + 0.8, MW, PAT.none, MW2);
  for (let z = z0 + 1.5; z < z1 - 2; z += 2.6) mb.box(x0 + 1.5, h + 0.8, z, x1 - 1.5, h + 1.25, z + 1.6, IH.solar, PAT.none, IH.solar);
  if (W > 14 && D > 12) mb.box((x0 + x1) / 2 - 3, h + 0.8, (z0 + z1) / 2 - 2, (x0 + x1) / 2 + 3, h + 3, (z0 + z1) / 2 + 2, MW2, PAT.industrial, C(0xc9cdd2));
}

// 入口のひさしと、光る社名サイン
function ihEntrance(mb: MeshBuilder, cx: number, z: number, accent: THREE.Color) {
  mb.box(cx - 5, 3.6, z - 0.5, cx + 5, 4.1, z + 3.5, MW, PAT.none, MW2);
  for (const x of [cx - 4.6, cx + 4.6]) mb.box(x - 0.12, 0, z + 3.0, x + 0.12, 3.6, z + 3.3, MW2);
  litSign(mb, cx - 3, 4.15, z + 3.3, cx + 3, 4.75, z + 3.45, accent);
}

const IH_ACCENT = [C(0x4fb3ff), C(0x35d0ba), C(0xf2f4f7), C(0x7c9cff)];

// 縦のフィンの研究棟だけの敷地（小さい敷地・2×2）
function finLabLot(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  const small = f.W < 20 || f.D < 20;
  const park = small ? 0 : 10;
  const x0 = -hw + 2.5, x1 = hw - 2.5, z0 = -hd + 2.5, z1 = hd - 3 - park;
  const h = 11 + den * 3.5 + Math.floor(rng.next() * 2) * 3.5;
  finLab(mb, rng, x0, z0, x1, z1, h);
  ihEntrance(mb, 0, z1 + 0.8, rng.pick(IH_ACCENT));
  if (park) ihParking(mb, rng, -hw + 1.5, hd - park, hw - 1.5, hd - 0.6);
  else mb.ground(-3, z1 + 1, 3, hd - 0.3, 0.1, PALETTE.pavement);
  for (const x of [-hw + 1.2, hw - 1.2]) tf(x, (z0 + z1) / 2, 0.8 + rng.next() * 0.3);
}

// 研究キャンパス：2棟の研究棟を、2階の高さのガラスの渡り廊下でつなぐ。間は芝生と小道と水盤の中庭
function labCampus(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  ihParking(mb, rng, -hw + 1.5, hd - 10, hw - 1.5, hd - 0.6);
  const zb = hd - 12, h1 = 11 + den * 3.5, h2 = h1 + 3.5 * (1 + Math.floor(rng.next() * 2));
  const gap = 10;
  let A: [number, number, number, number], B: [number, number, number, number];
  if (f.W >= f.D) {
    const mid = rng.next() * 4 - 2;
    A = [-hw + 2.5, -hd + 2.5, mid - gap / 2, zb];
    B = [mid + gap / 2, -hd + 2.5, hw - 2.5, zb];
  } else {
    const mid = (zb - hd) / 2 + rng.next() * 4 - 2;
    A = [-hw + 2.5, -hd + 2.5, hw - 2.5, mid - gap / 2];
    B = [-hw + 2.5, mid + gap / 2, hw - 2.5, zb];
  }
  finLab(mb, rng, A[0], A[1], A[2], A[3], h2);
  // もう1棟は、白い横長の窓の帯の研究棟（形を変えて単調にしない）
  mBlock(mb, B[0], B[1], B[2], B[3], h1, { pat: PAT.ribbon, overhang: 1.2, band: rng.pick(IH_ACCENT) });
  // 中庭：芝生、小道、水盤、木
  const alongX = f.W >= f.D;
  const c0 = alongX ? A[2] : A[3], c1 = alongX ? B[0] : B[1];
  if (alongX) {
    mb.ground(c0 + 0.5, -hd + 2.5, c1 - 0.5, zb, 0.09, PALETTE.lawn);
    mb.ground((c0 + c1) / 2 - 1.2, -hd + 2.5, (c0 + c1) / 2 + 1.2, hd - 10, 0.1, PALETTE.pavement);
    mb.ground(c0 + 1.2, -hd + 5, (c0 + c1) / 2 - 1.8, -hd + 12, 0.11, PALETTE.water);
    for (let z = -hd + 15; z < zb - 2; z += 7) tf(c1 - 2.2, z, 0.7 + rng.next() * 0.3);
  } else {
    mb.ground(-hw + 2.5, c0 + 0.5, hw - 2.5, c1 - 0.5, 0.09, PALETTE.lawn);
    mb.ground(-1.2, c0 + 0.5, 1.2, hd - 10, 0.1, PALETTE.pavement);
    mb.ground(-hw + 5, c0 + 1.2, -3, (c0 + c1) / 2 + 1, 0.11, PALETTE.water);
    for (let x = 4; x < hw - 3; x += 6) tf(x, (c0 + c1) / 2, 0.7 + rng.next() * 0.3);
  }
  // ガラスの渡り廊下（2〜3階の高さ）
  const by0 = 5.5, by1 = 9;
  if (alongX) {
    const z = (-hd + 2.5 + zb) / 2;
    mb.box(c0 - 0.2, by0, z - 2.2, c1 + 0.2, by1, z + 2.2, MGL, PAT.fullglass, MW);
    mb.box(c0 - 0.2, by0 - 0.5, z - 2.4, c1 + 0.2, by0, z + 2.4, MW, PAT.none, MW);
  } else {
    mb.box(-2.2, by0, c0 - 0.2, 2.2, by1, c1 + 0.2, MGL, PAT.fullglass, MW);
    mb.box(-2.4, by0 - 0.5, c0 - 0.2, 2.4, by0, c1 + 0.2, MW, PAT.none, MW);
  }
  ihEntrance(mb, alongX ? (B[0] + B[2]) / 2 : 0, zb + 0.3, rng.pick(IH_ACCENT));
}

// データセンター：ランダムな濃淡と出っ張りのコンクリートパネルの壁。正面に飛び出したガラスの入口。
// パネルのすき間の一部は夜に青く光る。屋上の冷却ファン、横の設備ヤード（チラー、発電機、目隠しの柵）
function dataCenter(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const h = 11 + den * 3;
  const yard = f.W >= 40 ? 13 : 0;
  const x0 = -hw + 3, x1 = hw - 3 - yard, z0 = -hd + 3, z1 = hd - (f.D >= 40 ? 13 : 9);
  // 中の箱と屋上
  mb.box(x0 + 0.4, 0, z0 + 0.4, x1 - 0.4, h, z1 - 0.4, C(0xb9b6ad), PAT.none, C(0xd5d9dd));
  // パネル（幅 3.2m、高さいっぱい）
  const PW = 3.2;
  const panelFace = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / PW)), tx = (bx - ax) / L, tz = (bz - az) / L;
    for (let k = 0; k < n; k++) {
      const s0 = (k / n) * L + 0.05, s1 = ((k + 1) / n) * L - 0.05;
      const out = [0, 0.15, 0.3][Math.floor(rng.next() * 3)], col = IH.panel[Math.floor(rng.next() * IH.panel.length)];
      const px0 = ax + tx * s0, pz0 = az + tz * s0, px1 = ax + tx * s1, pz1 = az + tz * s1;
      const ox = nx * out, oz = nz * out;
      mb.box(Math.min(px0, px1 + ox), 0, Math.min(pz0, pz1 + oz), Math.max(px0, px1 + ox), h, Math.max(pz0, pz1 + oz), col, PAT.none, C(0xd5d9dd));
      // パネルのすき間の青い光の筋（ところどころ）
      if (k % 4 === 2) {
        const gx = ax + tx * (s1 + 0.05), gz = az + tz * (s1 + 0.05);
        litSign(mb, gx - 0.06 + nx * 0.05, 1.2, gz - 0.06 + nz * 0.05, gx + 0.06 + nx * 0.1, h - 1.2, gz + 0.06 + nz * 0.1, IH.blue);
      }
    }
  };
  panelFace(x0, z1, x1, z1, 0, 1);
  panelFace(x0, z0, x1, z0, 0, -1);
  panelFace(x1, z0, x1, z1, 1, 0);
  panelFace(x0, z0, x0, z1, -1, 0);
  mb.box(x0 - 0.1, h, z0 - 0.1, x1 + 0.1, h + 0.6, z1 + 0.1, C(0xd9d7d0), PAT.none, C(0xd5d9dd));
  // ガラスの入口（正面に飛び出す）
  const ex = (x0 + x1) / 2;
  mb.box(ex - 5, 0, z1, ex + 5, 6.5, z1 + 3.5, MGL, PAT.fullglass, MW);
  mb.box(ex - 5.4, 6.5, z1 - 0.2, ex + 5.4, 7.1, z1 + 3.9, MW, PAT.none, MW2);
  litSign(mb, ex - 3, 5.2, z1 + 3.5, ex + 3, 5.8, z1 + 3.65, IH.blue);
  // 屋上の冷却ファン
  const dark = C(0x3c434b);
  for (let x = x0 + 4; x < x1 - 3; x += 5.5) for (let z = z0 + 4; z < z1 - 3; z += 5.5) {
    mb.box(x - 2, h + 0.6, z - 2, x + 2, h + 2, z + 2, C(0xb9bfc5));
    mb.cylinder(x, z, h + 2, h + 2.1, 1.5, 16, dark, dark);
  }
  // 設備ヤード（右側）：チラーの列、非常用発電機（コンテナ）、目隠しの柵
  if (yard) {
    const yx0 = x1 + 2, yx1 = hw - 2;
    for (let z = z0 + 1; z < z1 - 6; z += 7) {
      mb.box(yx0, 0, z, yx0 + 4.5, 2.6, z + 6, C(0xd6d9dc), PAT.industrial, C(0xc9cdd2));
      for (const dz of [1.5, 4.5]) mb.cylinder(yx0 + 2.25, z + dz, 2.6, 2.7, 1.1, 14, dark, dark);
      mb.box(yx1 - 3.2, 0, z + 0.5, yx1, 3, z + 5.5, MW, PAT.industrial, C(0x9aa1a7));
      mb.box(yx1 - 1, 3, z + 4, yx1 - 0.4, 4.6, z + 4.6, dark);
    }
    mb.box(yx0 - 0.6, 0, z1 - 0.2, yx1 + 0.4, 3.4, z1, IH.fence, PAT.industrial);
  }
  if (f.D >= 40) ihParking(mb, rng, -hw + 1.5, hd - 10.5, hw - 1.5, hd - 0.6);
  else mb.ground(-hw + 1, hd - 4, hw - 1, hd - 0.5, 0.1, PALETTE.asphalt);
  tf(-hw + 1.5, z1 - 2, 0.8);
  tf(-hw + 1.5, z0 + 3, 0.8);
}

// 半導体工場：窓のない白い大きな工場棟（横の細い溝、上に青い光の帯）。屋上に空調機の列と四角い排気ダクト、
// 正面にガラスの事務棟（縦のフィン）と渡り廊下、横に設備棟（屋上の冷却塔）、ガスのタンクの柵の囲い。夜は屋上の角に赤い航空灯
function semiFab(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const cub = 12; // 設備棟の幅
  const fx0 = -hw + 3, fx1 = hw - 3 - cub - 2, fz0 = -hd + 3, fz1 = hd - 27;
  const h = 20 + den * 3;
  // 工場棟
  mb.box(fx0, 0, fz0, fx1, h, fz1, MW, PAT.none, C(0xd5d9dd));
  for (let y = 3.5; y < h - 2; y += 3.2) mb.box(fx0 - 0.05, y, fz0 - 0.05, fx1 + 0.05, y + 0.12, fz1 + 0.05, C(0xd9dde1));
  litSign(mb, fx0 - 0.1, h - 2.2, fz0 - 0.1, fx1 + 0.1, h - 1.6, fz1 + 0.1, IH.blue);
  mb.box(fx0 - 0.2, h, fz0 - 0.2, fx1 + 0.2, h + 0.8, fz1 + 0.2, MW2, PAT.none, C(0xd5d9dd));
  // 屋上：空調機の列と、四角い排気ダクト、長いダクト
  const ry = h + 0.8;
  for (let z = fz0 + 3; z < fz1 - 5; z += 7)
    for (let x = fx0 + 3; x < fx1 - 7; x += 9) mb.box(x, ry, z, x + 6.5, ry + 2.6, z + 3.4, C(0xc3c8ce), PAT.industrial, C(0xb4bac1));
  mb.box(fx0 + 2, ry, fz1 - 4, fx1 - 2, ry + 1.6, fz1 - 2.4, C(0xa9b0b8));
  for (let x = fx0 + 5; x < fx1 - 3; x += 8) {
    mb.box(x - 0.7, ry, fz1 - 3.9, x + 0.7, ry + 5.5, fz1 - 2.5, C(0xe1e4e7));
    mb.box(x - 0.85, ry + 5.5, fz1 - 4.05, x + 0.85, ry + 5.9, fz1 - 2.35, C(0x8d949b));
  }
  // 航空灯（屋上の四隅、夜に赤く光る）
  for (const [x, z] of [[fx0, fz0], [fx1, fz0], [fx0, fz1], [fx1, fz1]]) litSign(mb, x - 0.3, ry, z - 0.3, x + 0.3, ry + 0.6, z + 0.3, IH.red);
  // 設備棟（右）：屋上に冷却塔の列
  const ux0 = hw - 3 - cub, ux1 = hw - 3, uh = 9;
  mb.box(ux0, 0, fz0, ux1, uh, fz1, MW2, PAT.industrial, C(0xc9cdd2));
  const dark = C(0x3c434b);
  for (let z = fz0 + 2; z < fz1 - 4; z += 5.5) {
    mb.box(ux0 + 1.5, uh, z, ux1 - 1.5, uh + 2.6, z + 4.5, C(0xd6d9dc), PAT.industrial, C(0xc9cdd2));
    mb.cylinder((ux0 + ux1) / 2, z + 2.25, uh + 2.6, uh + 3.3, 1.8, 16, dark, dark);
  }
  // 工場棟と設備棟をつなぐ配管ラック
  for (const y of [6, 7.4]) mb.box(fx1, y, fz1 - 6, ux0, y + 0.8, fz1 - 4.5, C(0x9aa1a7));
  // 正面：事務棟（縦のフィン）と渡り廊下
  const ox1 = -hw + 3 + Math.min(30, f.W * 0.45);
  const oz0 = fz1 + 6, oz1 = hd - 13;
  finLab(mb, rng, -hw + 3, oz0, ox1, oz1, 15 + den * 3.5);
  mb.box(-hw + 3 + (ox1 + hw - 3) / 2 - 2.2, 6, fz1 - 0.2, -hw + 3 + (ox1 + hw - 3) / 2 + 2.2, 9.5, oz0 + 0.2, MGL, PAT.fullglass, MW);
  ihEntrance(mb, (-hw + 3 + ox1) / 2, oz1 + 0.6, rng.pick(IH_ACCENT));
  // ガスのタンク（柵の囲い）
  const gx0 = ox1 + 4, gx1 = hw - 3;
  if (gx1 - gx0 > 8) {
    mb.ground(gx0, oz0, gx1, oz1, 0.1, PALETTE.pavement);
    for (let x = gx0 + 2.5; x < gx1 - 2; x += 4.5) {
      mb.cylinder(x, (oz0 + oz1) / 2 - 1.5, 0, 8.5, 1.4, 16, IH.tank, IH.tank);
      mb.box(x - 0.2, 0, (oz0 + oz1) / 2 + 1, x + 0.2, 4, (oz0 + oz1) / 2 + 1.4, IH.fence);
    }
    for (const [a, b, c, d] of [[gx0, oz0, gx1, oz0 + 0.12], [gx0, oz1 - 0.12, gx1, oz1], [gx0, oz0, gx0 + 0.12, oz1], [gx1 - 0.12, oz0, gx1, oz1]])
      mb.box(a, 0, b, c, 2.4, d, IH.fence, PAT.industrial);
  }
  // 駐車場と並木
  ihParking(mb, rng, -hw + 1.5, hd - 11, hw - 1.5, hd - 0.6);
  for (let x = -hw + 4; x < hw - 3; x += 9) tf(x, hd - 12, 0.75 + rng.next() * 0.3);
}

// テック本社：ガラスの低層棟の上に、波打つテントのような大屋根（銀色の太陽光パネル、少しずつ色の違ううろこ模様）。
// 屋根のふちは白い帯、まわりは芝生と池、正面に駐車場
function techHQ(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  const x0 = -hw + 5, x1 = hw - 5, z0 = -hd + 5, z1 = hd - 15;
  const H = 8; // ガラスの壁の高さ（2階建て）
  // ガラスの壁（1m 奥まる）と白い柱
  mb.box(x0 + 1, 0, z0 + 1, x1 - 1, H, z1 - 1, MGL, PAT.fullglass, MW2);
  mb.box(x0 + 1, 3.8, z0 + 1, x1 - 1, 4.3, z1 - 1, MW, PAT.none, MW);
  // 屋根：ベイ（約16m）ごとに、まん中が持ち上がったテント形の曲面
  const nx = Math.max(2, Math.round((x1 - x0) / 15)), nz = Math.max(2, Math.round((z1 - z0) / 15));
  const bw = (x1 - x0) / nx, bd = (z1 - z0) / nz, rise = 5, N = 8;
  const hAt = (x: number, z: number) => {
    const u = ((x - x0) / bw) % 1, v = ((z - z0) / bd) % 1;
    const b = Math.sin(Math.PI * Math.min(1, Math.max(0, u))) * Math.sin(Math.PI * Math.min(1, Math.max(0, v)));
    return H + 0.6 + rise * Math.pow(b, 0.75);
  };
  const nAt = (x: number, z: number): [number, number, number] => {
    const e = 0.25, dx = (hAt(x + e, z) - hAt(x - e, z)) / (2 * e), dz = (hAt(x, z + e) - hAt(x, z - e)) / (2 * e), l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  };
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++)
      for (let a = 0; a < N; a++)
        for (let c = 0; c < N; c++) {
          const xa = x0 + i * bw + (a / N) * bw + 0.01, xb = x0 + i * bw + ((a + 1) / N) * bw - 0.01;
          const za = z0 + j * bd + (c / N) * bd + 0.01, zb = z0 + j * bd + ((c + 1) / N) * bd - 0.01;
          const col = IH.silver[(a * 7 + c * 3 + i + j * 2) % IH.silver.length];
          mb.quadN([xa, hAt(xa, zb), zb], [xb, hAt(xb, zb), zb], [xb, hAt(xb, za), za], [xa, hAt(xa, za), za], nAt(xa, zb), nAt(xb, zb), nAt(xb, za), nAt(xa, za), col);
        }
  // 屋根のふちの白い帯（ガラスの壁の上）
  mb.box(x0, H, z0, x1, H + 0.6, z1, MW, PAT.none, MW);
  // 屋根の頂の小さな高窓（夜に光る）
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const cx = x0 + (i + 0.5) * bw, cz = z0 + (j + 0.5) * bd, y = H + 0.6 + rise;
      litSign(mb, cx - 1.6, y - 0.1, cz - 1.6, cx + 1.6, y + 0.35, cz + 1.6, C(0xe8f4ff));
    }
  // 池と木
  mb.ground(x1 - 12, z0 - 4.5, hw - 1, z0 - 1.5, 0.1, PALETTE.water);
  for (let x = -hw + 3; x < hw - 2; x += 8) tf(x, -hd + 2.2, 0.8 + rng.next() * 0.4);
  for (let z = z0 + 4; z < z1 - 2; z += 8) { tf(-hw + 2.2, z, 0.8 + rng.next() * 0.3); tf(hw - 2.2, z, 0.8 + rng.next() * 0.3); }
  ihEntrance(mb, 0, z1 - 0.6, rng.pick(IH_ACCENT));
  ihParking(mb, rng, -hw + 1.5, hd - 11.5, hw - 1.5, hd - 0.6);
}

// ---------------- 記念施設 ----------------
const STONE = new THREE.Color(0xe4dccb), BRONZE = new THREE.Color(0x7a5a33);

function statue(mb: MeshBuilder, f: LotFrame, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.lawn2);
  mb.box(-2, 0, -2, 2, 2.5, 2, STONE);
  mb.box(-0.6, 2.5, -0.4, 0.6, 4.8, 0.4, BRONZE);
  mb.box(-0.45, 4.8, -0.35, 0.45, 5.6, 0.35, BRONZE);
  mb.box(0.6, 4.0, -0.15, 1.6, 4.3, 0.15, BRONZE);
  for (const [x, z] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) tf(x, z, 0.7);
}


// スタジアム：なめらかな楕円のすり鉢。白い縦のリブの外壁と、真ん中の開いた輪の屋根（ふちは夜に光る）
function stadium(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.07, PALETTE.pavement);
  const Rx = f.W / 2 - 5, Rz = f.D / 2 - 5, SEG = 72;
  const white = C(0xf2f3f4), rib = C(0xdfe3e7), glassBand = C(0x5f8fb8), roof = C(0xf6f7f8), roofU = C(0xc9cfd5);
  const seatA = C(0x2f86d0), seatB = C(0x1f5f9e), concourse = C(0xb9b6ae);
  const E = (a: number, k: number, y: number): [number, number, number] => [Math.cos(a) * Rx * k, y, Math.sin(a) * Rz * k];
  // 楕円の外向きの法線
  const NO = (a: number, ny = 0): [number, number, number] => { const nx = Math.cos(a) / Rx, nz = Math.sin(a) / Rz, l = Math.hypot(nx, nz) || 1; const h = Math.sqrt(Math.max(0, 1 - ny * ny)); return [(nx / l) * h, ny, (nz / l) * h]; };
  const H = 30;
  for (let k = 0; k < SEG; k++) {
    const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
    // 外壁：下は暗いガラスの帯、上は白い膜
    mb.quadN(E(a1, 1, 0), E(a0, 1, 0), E(a0, 1, 7), E(a1, 1, 7), NO(a1), NO(a0), NO(a0), NO(a1), glassBand, PAT.fullglass);
    mb.quadN(E(a1, 1, 7), E(a0, 1, 7), E(a0, 1.03, H - 4), E(a1, 1.03, H - 4), NO(a1, 0.1), NO(a0, 0.1), NO(a0, 0.1), NO(a1, 0.1), white);
    // 縦のリブ（2区画ごと）
    if (k % 2 === 0) {
      const [x, , z] = E(a0, 1.045, 0);
      mb.box(x - 0.35, 0, z - 0.35, x + 0.35, H - 2, z + 0.35, rib);
    }
    // 客席：外側の高いところから、フィールドのふちへ下がる2層のすり鉢（なめらかな斜面）
    const tiers: [number, number, number, number, THREE.Color][] = [[0.97, H - 6, 0.8, 14, seatB], [0.8, 13, 0.62, 2, seatA]];
    for (const [k0, y0, k1, y1, col] of tiers) {
      const slope = (y0 - y1) / ((k0 - k1) * Math.min(Rx, Rz));
      const nUp = (a: number): [number, number, number] => { const o = NO(a), l = Math.hypot(slope, 1); return [(-o[0] * slope) / l, 1 / l, (-o[2] * slope) / l]; };
      mb.quadN(E(a1, k0, y0), E(a0, k0, y0), E(a0, k1, y1), E(a1, k1, y1), nUp(a1), nUp(a0), nUp(a0), nUp(a1), col);
    }
    // 上下の層の間の通路
    mb.quadN(E(a1, 0.8, 14), E(a0, 0.8, 14), E(a0, 0.78, 13), E(a1, 0.78, 13), [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], concourse);
    // 輪の屋根：外のふちから内側へ、少し上がりながらのびる（真ん中は開いている）
    const ri = 0.86;
    mb.quadN(E(a1, 1.05, H - 4), E(a0, 1.05, H - 4), E(a0, ri, H + 2), E(a1, ri, H + 2), [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], roof);
    mb.quadN(E(a0, 1.05, H - 4.6), E(a1, 1.05, H - 4.6), E(a1, ri, H + 1.4), E(a0, ri, H + 1.4), [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0], roofU);
    // 屋根の内側のふち（夜に光る）
    mb.quadN(E(a1, ri, H + 1.4), E(a0, ri, H + 1.4), E(a0, ri, H + 2.1), E(a1, ri, H + 2.1), NO(a1), NO(a0), NO(a0), NO(a1), C(0xdfe6ee), PAT.glow);
    // 外壁の上の LED の帯
    mb.quadN(E(a1, 1.035, H - 5.2), E(a0, 1.035, H - 5.2), E(a0, 1.035, H - 4.4), E(a1, 1.035, H - 4.4), NO(a1), NO(a0), NO(a0), NO(a1), C(0xbfe0ff), PAT.glow);
  }
  // フィールド（縞の芝と白線）
  const fx = Rx * 0.55, fz = Rz * 0.4;
  mb.ground(-Rx * 0.62, -Rz * 0.62, Rx * 0.62, Rz * 0.62, 2, PALETTE.lawn2);
  for (let x = -fx; x < fx; x += fx / 5) mb.ground(x, -fz, x + fx / 10, fz, 2.02, PALETTE.lawn);
  const ln = (x0: number, z0: number, x1: number, z1: number) => mb.ground(x0, z0, x1, z1, 2.04, PALETTE.white);
  ln(-fx, -fz, fx, -fz + 0.25); ln(-fx, fz - 0.25, fx, fz); ln(-fx, -fz, -fx + 0.25, fz); ln(fx - 0.25, -fz, fx, fz); ln(-0.12, -fz, 0.12, fz);
  mb.cylinder(0, 0, 2.03, 2.05, fz * 0.3, 32, PALETTE.white, PALETTE.lawn2);
  // 入口の大階段（正面）
  for (let k = 0; k < 6; k++) mb.box(-10 + k * 0.6, k * 1.1, Rz - 1 + (6 - k) * 1.2, 10 - k * 0.6, (k + 1) * 1.1, Rz + 6, concourse);
  void rng;
}

// 近未来スタジアム（8×8）：角の丸い四角の白い殻。正面の右側を斜めにえぐって、内側のガラスの帯と柱を見せる。
// 正面にガラスの入口棟、全体は低い基壇の上。屋根は内側へ下がる輪で、放射状のリブ。フィールドは夜に明るく光る
function futureStadium(mb: MeshBuilder, f: LotFrame) {
  const hw = f.W / 2, hd = f.D / 2;
  const white = C(0xf4f5f6), shade = C(0xe1e4e7), grey = C(0x8a9097), dark = C(0x3c434b), glass = C(0x6f93ae);
  const seatU = C(0x5a6169), seatL = C(0x6c737b), concourse = C(0xc9ccd0);
  // 基壇（低い台）と、正面の階段
  const PB = 1.6;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.06, PALETTE.pavement);
  mb.box(-hw + 2, 0, -hd + 2, hw - 2, PB, hd - 2, C(0xe9eaeb), PAT.none, C(0xdcdfe2));
  for (let k = 0; k < 4; k++) mb.box(-22, 0, hd - 2 + (3 - k) * 0.9, 22, (k + 1) * 0.4, hd - 2 + (4 - k) * 0.9, C(0xdcdfe2));
  // 角の丸い四角（スーパー楕円）。k = 外周に対する大きさ
  const Rx = hw - 7, Rz = hd - 9, P = 5;
  const sq = (t: number) => Math.sign(t) * Math.pow(Math.abs(t), 2 / P);
  const E = (a: number, k: number, y: number): [number, number, number] => [sq(Math.cos(a)) * Rx * k, y, sq(Math.sin(a)) * Rz * k - 2];
  const NO = (a: number, ny = 0): [number, number, number] => {
    const [x, , z0] = E(a, 1, 0), z = z0 + 2;
    const gx = Math.sign(x) * Math.pow(Math.abs(x / Rx), P - 1) / Rx, gz = Math.sign(z) * Math.pow(Math.abs(z / Rz), P - 1) / Rz;
    const l = Math.hypot(gx, gz) || 1, h = Math.sqrt(Math.max(0, 1 - ny * ny));
    return [(gx / l) * h, ny, (gz / l) * h];
  };
  const up: [number, number, number] = [0, 1, 0], dn: [number, number, number] = [0, -1, 0];
  const SEG = 120, H = 34, B = PB;
  // えぐれ：正面の右から右側面にかけて、白い殻の下のふちが斜めに上がる（なめらかな山）
  const cut = (a: number) => {
    const c = 0.35; // 中心の角度（ラジアン、+x 寄りの正面側）
    let d = Math.atan2(Math.sin(a - c), Math.cos(a - c));
    const w = d < 0 ? 0.9 : 1.6; // 片側は急に、反対側はゆっくり
    d /= w;
    return Math.abs(d) < 1 ? Math.pow(Math.cos((d * Math.PI) / 2), 2) : 0;
  };
  const low = (a: number) => B + 6 + cut(a) * 18; // 白い殻の下のふち
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2, a1 = ((i + 1) / SEG) * Math.PI * 2;
    // 1階：少し奥まった暗いガラス
    mb.quadN(E(a1, 0.975, B), E(a0, 0.975, B), E(a0, 0.975, B + 6), E(a1, 0.975, B + 6), NO(a1), NO(a0), NO(a0), NO(a1), dark, PAT.fullglass);
    // えぐれた所：奥のガラスの帯
    const l0 = low(a0), l1 = low(a1);
    if (l0 > B + 6.05 || l1 > B + 6.05) {
      mb.quadN(E(a1, 0.955, B + 6), E(a0, 0.955, B + 6), E(a0, 0.955, Math.max(l0, B + 6)), E(a1, 0.955, Math.max(l1, B + 6)), NO(a1), NO(a0), NO(a0), NO(a1), glass, PAT.fullglass);
      // えぐれの中の柱（斜めにならぶ）
      if (i % 3 === 0 && l0 > B + 8) {
        const [x, , z] = E(a0, 0.985, 0);
        mb.box(x - 0.3, B + 6, z - 0.3, x + 0.3, l0, z + 0.3, white);
      }
      // えぐれの下面（殻の厚み）
      mb.quadN(E(a1, 0.955, l1), E(a0, 0.955, l0), E(a0, 1.0, l0), E(a1, 1.0, l1), dn, dn, dn, dn, shade);
    }
    // 白い殻：下のふちから上へ、少しふくらんで、上で内側へまるく巻き込む
    const prof: [number, number][] = [[1.0, 0], [1.012, 0.35], [1.015, 0.7], [1.0, 0.9], [0.975, 1.0]];
    for (let k = 0; k + 1 < prof.length; k++) {
      const [k0, t0] = prof[k], [k1, t1] = prof[k + 1];
      const ya0 = l0 + (B + H - l0) * t0, ya1 = l1 + (B + H - l1) * t0, yb0 = l0 + (B + H - l0) * t1, yb1 = l1 + (B + H - l1) * t1;
      const ny = Math.max(-0.2, Math.min(0.9, (k0 - k1) * 25));
      mb.quadN(E(a1, k1 === k0 ? k0 : k0, ya1), E(a0, k0, ya0), E(a0, k1, yb0), E(a1, k1, yb1), NO(a1, ny * 0.5), NO(a0, ny * 0.5), NO(a0, ny), NO(a1, ny), white);
    }
    // 屋根：ふちから内側へ下がる輪（白）と、下面
    const ro = 0.975, ri = 0.8, yo = B + H, yi = B + H - 5;
    mb.quadN(E(a1, ro, yo), E(a0, ro, yo), E(a0, ri, yi), E(a1, ri, yi), up, up, up, up, white);
    mb.quadN(E(a0, ro, yo - 0.8), E(a1, ro, yo - 0.8), E(a1, ri, yi - 0.8), E(a0, ri, yi - 0.8), dn, dn, dn, dn, shade);
    // 放射状のリブ（細い盛り上がり）
    if (i % 4 === 0) {
      const am = a0 + 0.004;
      mb.quadN(E(am, ro - 0.003, yo + 0.25), E(a0, ro - 0.003, yo + 0.25), E(a0, ri, yi + 0.25), E(am, ri, yi + 0.25), up, up, up, up, C(0xc9cdd2));
    }
    // 屋根の内側のふち（夜に光る）
    const inw = (n: [number, number, number]): [number, number, number] => [-n[0], 0, -n[2]];
    mb.quadN(E(a0, ri, yi - 0.8), E(a1, ri, yi - 0.8), E(a1, ri, yi), E(a0, ri, yi), inw(NO(a0)), inw(NO(a1)), inw(NO(a1)), inw(NO(a0)), C(0xdfe6ee), PAT.glow);
    // 客席：上の層と下の層（内側へ下がる）
    const tiers: [number, number, number, number, THREE.Color][] = [[0.95, B + H - 6, 0.76, B + 15, seatU], [0.74, B + 13, 0.6, B + 2.5, seatL]];
    for (const [k0, y0, k1, y1, col] of tiers) {
      const n0 = NO(a0), n1 = NO(a1), sl = (y0 - y1) / ((k0 - k1) * Math.min(Rx, Rz)), L = Math.hypot(sl, 1);
      const nU = (n: [number, number, number]): [number, number, number] => [(-n[0] * sl) / L, 1 / L, (-n[2] * sl) / L];
      mb.quadN(E(a1, k0, y0), E(a0, k0, y0), E(a0, k1, y1), E(a1, k1, y1), nU(n1), nU(n0), nU(n0), nU(n1), col);
    }
    mb.quadN(E(a1, 0.76, B + 15), E(a0, 0.76, B + 15), E(a0, 0.74, B + 13), E(a1, 0.74, B + 13), up, up, up, up, concourse);
  }
  // フィールド（緑の縞と白線）。夜は照明で明るい
  const fx = Rx * 0.48, fz = Rz * 0.36, fy = B + 2.5, cz = -2;
  mb.ground(-Rx * 0.6, cz - Rz * 0.6, Rx * 0.6, cz + Rz * 0.6, fy - 0.02, C(0x4f8a3c));
  for (let k = 0; k < 10; k++) {
    const x0 = -fx + (k * 2 * fx) / 10, x1 = -fx + ((k + 1) * 2 * fx) / 10;
    const col = k % 2 ? C(0x5f9f45) : C(0x6aad4e);
    mb.quad([x0, fy, cz + fz], [x1, fy, cz + fz], [x1, fy, cz - fz], [x0, fy, cz - fz], col, PAT.lit);
  }
  const ln = (x0: number, z0: number, x1: number, z1: number) => mb.quad([x0, fy + 0.03, z1], [x1, fy + 0.03, z1], [x1, fy + 0.03, z0], [x0, fy + 0.03, z0], PALETTE.white, PAT.lit);
  ln(-fx, cz - fz, fx, cz - fz + 0.3); ln(-fx, cz + fz - 0.3, fx, cz + fz); ln(-fx, cz - fz, -fx + 0.3, cz + fz); ln(fx - 0.3, cz - fz, fx, cz + fz); ln(-0.15, cz - fz, 0.15, cz + fz);
  // 正面のガラスの入口棟（白い枠）
  const ez0 = E(Math.PI / 2, 1, 0)[2] - 4, ez1 = hd - 6;
  mb.box(-20, B, ez0, 20, B + 20, ez1, glass, PAT.fullglass, white);
  mb.box(-20.6, B + 20, ez0, 20.6, B + 21.2, ez1 + 0.6, white);
  for (const x of [-20.3, 20.3]) mb.box(x - 0.6, B, ez0, x + 0.6, B + 20, ez1 + 0.6, white);
  for (let x = -14; x <= 14; x += 7) mb.box(x - 0.2, B, ez1 - 0.1, x + 0.2, B + 20, ez1 + 0.3, white);
  mb.box(-24, B + 6, ez1, 24, B + 6.6, ez1 + 5, white); // ひさし
  void grey;
}

// ================= モダンな公共施設（白＋ガラス＋曲線。施設ごとのアクセント色） =================
// 角の丸い四角（中心 cx, cz、幅 w、奥行き d、角の半径 r）
function rrect(cx: number, cz: number, w: number, d: number, r: number, n = 6): P2[] {
  const out: P2[] = [];
  r = Math.min(r, w / 2 - 0.01, d / 2 - 0.01);
  const cs: [number, number, number][] = [[cx + w / 2 - r, cz + d / 2 - r, 0], [cx - w / 2 + r, cz + d / 2 - r, Math.PI / 2], [cx - w / 2 + r, cz - d / 2 + r, Math.PI], [cx + w / 2 - r, cz - d / 2 + r, Math.PI * 1.5]];
  for (const [x, z, a0] of cs) for (let k = 0; k <= n; k++) { const a = a0 + (k / n) * (Math.PI / 2); out.push([x + Math.cos(a) * r, z + Math.sin(a) * r]); }
  return out;
}
const MW = C(0xf3f4f5), MW2 = C(0xe2e5e8), MGL = C(0x5f8fb8);
// ---- 四角を基本に、凹凸で影を作る部品 ----
// 白い棟：1階は奥まったガラスと柱、上の階は外壁の模様、屋上は張り出したスラブと低い手すり、屋上の機械
interface MBOpt { pat?: number; wall?: THREE.Color; glassBase?: boolean; overhang?: number; fins?: boolean; roofKit?: boolean; band?: THREE.Color }
function mBlock(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, h: number, o: MBOpt = {}) {
  const wall = o.wall ?? MW, pat = o.pat ?? PAT.ribbon, ov = o.overhang ?? 1.0;
  const gH = o.glassBase === false ? 0 : Math.min(4.5, h * 0.45);
  if (gH > 0) {
    // 1階：1m 奥まったガラスと、外側の柱
    mb.box(x0 + 1, 0, z0 + 1, x1 - 1, gH, z1 - 1, MGL, PAT.fullglass, MW2);
    const step = 6;
    for (let x = x0 + 0.4; x <= x1 - 0.39; x += Math.max(3, (x1 - x0 - 0.8) / Math.max(1, Math.round((x1 - x0) / step)))) {
      mb.box(x - 0.3, 0, z1 - 0.7, x + 0.3, gH, z1 - 0.1, wall);
      mb.box(x - 0.3, 0, z0 + 0.1, x + 0.3, gH, z0 + 0.7, wall);
    }
    mb.box(x0, gH, z0, x1, gH + 0.6, z1, wall, PAT.none, wall); // 2階の床の帯
  }
  mb.box(x0, gH + 0.6, z0, x1, h, z1, wall, pat, MW2);
  if (o.band) mb.box(x0 - 0.06, h - 1.6, z0 - 0.06, x1 + 0.06, h - 1.0, z1 + 0.06, o.band, PAT.lit, o.band);
  // 縦のひれ（正面）
  if (o.fins) for (let x = x0 + 1.2; x < x1 - 0.6; x += 1.8) mb.box(x - 0.12, gH + 0.6, z1, x + 0.12, h, z1 + 0.8, wall);
  // 張り出した屋根のスラブ（厚み）と、手すり
  mb.box(x0 - ov, h, z0 - ov, x1 + ov, h + 0.7, z1 + ov, wall, PAT.none, MW2);
  mb.box(x0 - ov, h + 0.7, z1 + ov - 0.15, x1 + ov, h + 1.6, z1 + ov, C(0x9cc9d4));
  if (o.roofKit !== false && x1 - x0 > 10 && z1 - z0 > 8) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    mb.box(cx - 4, h + 0.7, cz - 2.5, cx + 2, h + 3, cz + 2.5, MW2, PAT.industrial, C(0xc9cdd2));
    for (const dx of [-7, 5]) if (cx + dx > x0 + 1 && cx + dx + 2 < x1 - 1) mb.box(cx + dx, h + 0.7, cz - 1, cx + dx + 2.2, h + 1.9, cz + 0.4, C(0xb9bfc5));
  }
}
// ひさし（薄い板と細い柱）
function canopy(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number) {
  mb.box(x0, y, z0, x1, y + 0.45, z1, MW, PAT.none, MW2);
  for (const x of [x0 + 0.5, x1 - 0.5]) mb.box(x - 0.15, 0, z1 - 0.65, x + 0.15, y, z1 - 0.35, MW2);
}
// 駐車場（白線）
function parking(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number) {
  mb.ground(x0, z0, x1, z1, 0.1, PALETTE.asphalt);
  for (let x = x0 + 1; x < x1 - 1; x += 2.6) mb.ground(x, z0 + 0.5, x + 0.12, z0 + 5, 0.12, PALETTE.white);
}
// 植え込み（低い箱と木）
function planter(mb: MeshBuilder, tf: TF, x0: number, z0: number, x1: number, z1: number) {
  mb.box(x0, 0, z0, x1, 0.5, z1, C(0xc9c5bc), PAT.none, PALETTE.hedge);
  tf((x0 + x1) / 2, (z0 + z1) / 2, 0.7);
}
// 夜に光る看板（色のまま光る）
const litSign = (mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color) => mb.box(x0, y0, z0, x1, y1, z1, c, PAT.lit, c);
// 赤十字（正面 +z に向けて）
function redCross(mb: MeshBuilder, x: number, y: number, z: number, s: number) {
  const red = C(0xe53935);
  litSign(mb, x - s * 0.5, y - s * 0.17, z, x + s * 0.5, y + s * 0.17, z + 0.3, red);
  litSign(mb, x - s * 0.17, y - s * 0.5, z, x + s * 0.17, y + s * 0.5, z + 0.3, red);
}
const civicStart = (mb: MeshBuilder) => { mb.flatRoofMat = MAT.none; };

// 病院：横長の低層部（外来）と、その上の四角い病棟（縦のひれ、上に光る帯）。屋上ヘリポート、車寄せのひさし、駐車場
function modernHospital(mb: MeshBuilder, f: LotFrame, tf: TF) {
  civicStart(mb);
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.pavement);
  const pz0 = -hd + 3, pz1 = hd * 0.3;
  mBlock(mb, -hw + 3, pz0, hw - 3, pz1, 10, { pat: PAT.ribbon });
  // 病棟（低層部の上に、少しずらして）
  const tx0 = -hw + 5, tx1 = hw * 0.35, tz0 = pz0 + 2, tz1 = pz0 + 16;
  mb.box(tx0, 10.7, tz0, tx1, 40, tz1, MW, PAT.curtain, MW2);
  for (let x = tx0 + 1; x < tx1 - 0.5; x += 2) mb.box(x - 0.15, 10.7, tz1, x + 0.15, 40, tz1 + 0.9, MW);
  mb.box(tx0 - 0.8, 40, tz0 - 0.8, tx1 + 0.8, 41, tz1 + 0.8, MW, PAT.none, MW2);
  litSign(mb, tx0 - 0.82, 39.2, tz1 + 0.78, tx1 + 0.82, 39.8, tz1 + 0.84, C(0xbfe0ff));
  helipad(mb, (tx0 + tx1) / 2, (tz0 + tz1) / 2, 41.2, Math.min(7, (tz1 - tz0) * 0.42));
  redCross(mb, tx1 - 3.5, 34, tz1 + 0.9, 5);
  // 裏側の赤十字（奥 -z に向ける）
  {
    const red = C(0xe53935), x = tx1 - 3.5, y = 34, z = tz0 - 0.3, sz = 5;
    litSign(mb, x - sz * 0.5, y - sz * 0.17, z, x + sz * 0.5, y + sz * 0.17, z + 0.3, red);
    litSign(mb, x - sz * 0.17, y - sz * 0.5, z, x + sz * 0.17, y + sz * 0.5, z + 0.3, red);
  }
  // 車寄せ（正面）と駐車場
  canopy(mb, -9, pz1, 9, pz1 + 7, 5);
  mb.ground(-hw + 2, pz1, hw - 2, pz1 + 8, 0.09, PALETTE.asphalt);
  parking(mb, -hw + 2, pz1 + 9, hw - 2, hd - 2);
  planter(mb, tf, -hw + 2, pz1 + 0.5, -hw + 6, pz1 + 3);
  planter(mb, tf, hw - 6, pz1 + 0.5, hw - 2, pz1 + 3);
}

// クリニック：2階建ての白い棟（ガラスの1階）、入口のひさし、赤十字、駐車場
function modernClinic(mb: MeshBuilder, f: LotFrame, tf: TF) {
  civicStart(mb);
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  const z1 = hd * 0.2;
  mBlock(mb, -hw + 3, -hd + 3, hw - 3, z1, 8.5, { pat: PAT.ribbon });
  canopy(mb, -4, z1, 4, z1 + 3.5, 4);
  redCross(mb, hw - 6, 6.8, z1 + 0.05, 2.6);
  parking(mb, -hw + 2, z1 + 4.5, hw - 2, hd - 1);
  planter(mb, tf, -hw + 2, z1 + 0.5, -hw + 5, z1 + 3);
}

// 図書館：ガラスの閲覧室の上に、張り出した波の屋根（細い柱で支える）
function modernLibrary(mb: MeshBuilder, f: LotFrame, tf: TF) {
  civicStart(mb);
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  mb.ground(-hw + 2, hd - 6, hw - 2, hd - 1, 0.09, PALETTE.pavement);
  const x0 = -hw + 4, x1 = hw - 4, z0 = -hd + 4, z1 = hd - 7, h = 8;
  mb.box(x0, 0, z0, x1, h, z1, MGL, PAT.fullglass, MW2);
  for (let x = x0; x <= x1; x += (x1 - x0) / 5) mb.box(x - 0.12, 0, z1, x + 0.12, h, z1 + 0.2, MW);
  const N = 24, amp = 1.6, waves = 2, ax0 = x0 - 2.5, ax1 = x1 + 2.5;
  const yAt = (u: number) => h + 0.8 + amp * (1 - Math.cos(u * Math.PI * 2 * waves)) / 2;
  const nAt = (u: number): [number, number, number] => { const sl = (amp * Math.PI * waves * Math.sin(u * Math.PI * 2 * waves)) / (ax1 - ax0); const l = Math.hypot(sl, 1); return [-sl / l, 1 / l, 0]; };
  for (let k = 0; k < N; k++) {
    const u0 = k / N, u1 = (k + 1) / N, a0 = ax0 + (ax1 - ax0) * u0, a1 = ax0 + (ax1 - ax0) * u1;
    mb.quadN([a0, yAt(u0), z1 + 3], [a1, yAt(u1), z1 + 3], [a1, yAt(u1), z0 - 2], [a0, yAt(u0), z0 - 2], nAt(u0), nAt(u1), nAt(u1), nAt(u0), MW);
    mb.quadN([a0, yAt(u0) - 0.6, z0 - 2], [a1, yAt(u1) - 0.6, z0 - 2], [a1, yAt(u1) - 0.6, z1 + 3], [a0, yAt(u0) - 0.6, z1 + 3], [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0], MW2);
    // 屋根のふち（正面と背面の厚み）
    mb.quad([a0, yAt(u0) - 0.6, z1 + 3], [a1, yAt(u1) - 0.6, z1 + 3], [a1, yAt(u1), z1 + 3], [a0, yAt(u0), z1 + 3], MW);
  }
  for (const x of [x0 - 1.5, (x0 + x1) / 2, x1 + 1.5]) mb.box(x - 0.15, 0, z1 + 2.2, x + 0.15, h + 0.8, z1 + 2.5, MW2);
  planter(mb, tf, -hw + 2, hd - 5, -hw + 5, hd - 2);
  planter(mb, tf, hw - 5, hd - 5, hw - 2, hd - 2);
}

// 博物館：ずらして積んだ白い箱（片持ちで張り出す上の箱）、ガラスのスリット、前に水盤
function modernMuseum(mb: MeshBuilder, f: LotFrame, tf: TF) {
  civicStart(mb);
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.pavement);
  mb.box(-hw + 4, 0, -hd + 4, hw - 10, 9, hd * 0.25, MW, PAT.none, MW2);
  mb.box(-hw + 4, 4, hd * 0.25 - 0.1, hw - 10, 5.2, hd * 0.25 + 0.1, MGL, PAT.fullglass, MGL);
  mb.box(-hw + 10, 9, -hd + 2, hw - 3, 17, hd * 0.25 - 6, MW, PAT.none, MW2);
  mb.box(-hw + 10, 12.4, hd * 0.25 - 6.1, hw - 3, 13.4, hd * 0.25 - 5.9, MGL, PAT.fullglass, MGL);
  mb.box(-6, 0, hd * 0.25, 6, 5, hd * 0.25 + 4, MGL, PAT.fullglass, MW);
  mb.box(-8, 5, hd * 0.25, 8, 5.5, hd * 0.25 + 6, MW, PAT.none, MW2);
  mb.ground(-hw + 4, hd * 0.25 + 7, hw - 4, hd - 3, 0.12, PALETTE.water);
  tf(-hw + 2.5, hd - 1.5, 0.9);
  tf(hw - 2.5, hd - 1.5, 0.9);
}

// 警察：白い棟、ガラスの1階、青い帯（夜に光る）。大きい署は奥にもう1棟と駐車場
function modernPolice(mb: MeshBuilder, f: LotFrame, tf: TF, big: boolean) {
  civicStart(mb);
  const hw = f.W / 2, hd = f.D / 2;
  const blue = C(0x1f6fd0);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.pavement);
  if (!big) {
    mBlock(mb, -hw + 2.5, -hd + 2.5, hw - 2.5, hd - 4, 5.5, { pat: PAT.none, band: blue, roofKit: false, overhang: 0.8 });
    return;
  }
  mBlock(mb, -hw + 3, -hd + 3, hw * 0.4, hd - 6, 12, { pat: PAT.ribbon, band: blue });
  mBlock(mb, hw * 0.4 + 2, -hd + 3, hw - 3, -1, 8, { pat: PAT.ribbon, band: blue });
  parking(mb, hw * 0.4 + 2, 0, hw - 2, hd - 2);
  canopy(mb, -6, hd - 6, 2, hd - 2.5, 4);
  tf(-hw + 2, hd - 1.5, 0.8);
}

// 消防：白い棟に赤い帯、赤い枠のガラスの車庫扉、訓練塔
function modernFire(mb: MeshBuilder, f: LotFrame, tf: TF, big: boolean) {
  civicStart(mb);
  const hw = f.W / 2, hd = f.D / 2;
  const red = C(0xd32f2f);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const bx0 = -hw + 3, bx1 = big ? hw - 11 : hw - 3, bz0 = -hd + 3, bz1 = hd - 9, bh = big ? 11 : 8;
  mBlock(mb, bx0, bz0, bx1, bz1, bh, { pat: PAT.ribbon, glassBase: false, band: red, roofKit: big });
  const doors = big ? 3 : 2, dw = (bx1 - bx0 - 2) / doors;
  for (let k = 0; k < doors; k++) {
    const x0 = bx0 + 1 + k * dw + 0.5, x1 = x0 + dw - 1;
    mb.box(x0, 0, bz1, x1, 5, bz1 + 0.15, MGL, PAT.fullglass, MW);
    mb.box(x0 - 0.3, 0, bz1 + 0.1, x0, 5.3, bz1 + 0.4, red);
    mb.box(x1, 0, bz1 + 0.1, x1 + 0.3, 5.3, bz1 + 0.4, red);
    mb.box(x0 - 0.3, 5, bz1 + 0.1, x1 + 0.3, 5.3, bz1 + 0.4, red);
  }
  mb.ground(bx0, bz1, bx1, hd - 0.5, 0.1, PALETTE.asphalt);
  const tx = big ? hw - 6 : hw - 4, tz = -hd + 5, th = big ? 22 : 15;
  mb.box(tx - 2.5, 0, tz - 2.5, tx + 2.5, th, tz + 2.5, MW, PAT.ribbon, MW2);
  mb.box(tx - 2.7, th - 3, tz - 2.7, tx + 2.7, th - 2, tz + 2.7, red);
  tf(-hw + 2, -hd + 2, 0.8);
}

// ================= 大型コンテナ船（船首が +z、喫水線が y = 0）=================
// hull = 会社カラー。船体は先がとがった形、喫水線の下は赤、境目に黒い帯。甲板には区画ごとにコンテナとラッシングブリッジ、
// 後ろ寄りに白い居住区（窓）と張り出した操舵室、帯の入った煙突。夜は航海灯（左舷 赤・右舷 緑）と甲板の照明
export function bigContainerShip(mb: MeshBuilder, L: number, B: number, hull: THREE.Color, seed: number) {
  const rng = new Rng(seed);
  const deckY = 9, botY = -12;
  const red = C(0x9a2a22), black = C(0x1c1f22), deckC = C(0x55595e), white = C(0xf2f3f1), grey = C(0x9aa1a7);
  const N = 40;
  // 船の幅（半分）：船尾は少しだけ細く、船首の 2 割でとがる
  const half = (u: number) => {
    if (u < 0.04) return (B / 2) * (0.86 + 0.14 * (u / 0.04));
    if (u > 0.8) { const t = (u - 0.8) / 0.2; return (B / 2) * Math.max(0.02, Math.sqrt(1 - t * t * t)); }
    return B / 2;
  };
  const zAt = (u: number) => -L / 2 + u * L;
  // 側面：3 つの色の帯（赤・黒・会社カラー）。船首は上へ少し反る
  const bands: [number, number, THREE.Color][] = [[botY, 1.4, red], [1.4, 2.6, black], [2.6, deckY, hull]];
  for (let i = 0; i < N; i++) {
    const u0 = i / N, u1 = (i + 1) / N, z0 = zAt(u0), z1 = zAt(u1), w0 = half(u0), w1 = half(u1);
    const sheer = (u: number) => (u > 0.85 ? ((u - 0.85) / 0.15) * 2.5 : 0);
    for (const [ya, yb, col] of bands) {
      const yb0 = yb === deckY ? deckY + sheer(u0) : yb, yb1 = yb === deckY ? deckY + sheer(u1) : yb;
      for (const sd of [-1, 1]) {
        // 外向きの法線：(sd, 0, -sd·w')
        const wp = (w1 - w0) / (z1 - z0), l = Math.hypot(1, wp), n: [number, number, number] = [sd / l, 0, (-sd * wp) / l];
        const A: [number, number, number] = [sd * w0, ya, z0], Bp: [number, number, number] = [sd * w1, ya, z1], Cp: [number, number, number] = [sd * w1, yb1, z1], Dp: [number, number, number] = [sd * w0, yb0, z0];
        if (sd > 0) mb.quadN(Bp, A, Dp, Cp, n, n, n, n, col); else mb.quadN(A, Bp, Cp, Dp, n, n, n, n, col);
      }
    }
    // 甲板
    const s0 = deckY + (u0 > 0.85 ? ((u0 - 0.85) / 0.15) * 2.5 : 0), s1 = deckY + (u1 > 0.85 ? ((u1 - 0.85) / 0.15) * 2.5 : 0);
    mb.quad([-w0, s0, z0], [-w1, s1, z1], [w1, s1, z1], [w0, s0, z0], deckC);
  }
  // 船尾の平らな面（トランサム）
  for (const [ya, yb, col] of bands) mb.quad([half(0), ya, -L / 2], [-half(0), ya, -L / 2], [-half(0), yb, -L / 2], [half(0), yb, -L / 2], col);
  // 船首楼の波よけ（白）
  const zf = zAt(0.84);
  mb.box(-half(0.84) + 0.5, deckY + 1.5, zf - 1, half(0.84) - 0.5, deckY + 5, zf, white);
  // 居住区（後ろ寄り）と操舵室、マスト、煙突
  const za = zAt(0.16);
  mb.box(-B / 2 + 4, deckY, za - 8, B / 2 - 4, deckY + 26, za + 6, white, PAT.apartment, white);
  mb.box(-B / 2 - 2, deckY + 26, za - 4, B / 2 + 2, deckY + 29, za + 6, white, PAT.none, white);
  mb.box(-B / 2 + 3, deckY + 26.4, za + 6, B / 2 - 3, deckY + 28.6, za + 6.3, C(0x2a3440), PAT.fullglass);
  mb.box(-0.4, deckY + 29, za, 0.4, deckY + 38, za + 0.8, grey);
  mb.box(-0.6, deckY + 38, za - 0.2, 0.6, deckY + 39, za + 1, C(0xfffbe8), PAT.glow); // マストの白い灯り
  litBox(mb, B / 2 + 1.4, deckY + 27, za + 5, 0.6, C(0xff3030)); // 左舷（船首から見て左 = +x）は赤
  litBox(mb, -B / 2 - 1.4, deckY + 27, za + 5, 0.6, C(0x30ff60)); // 右舷は緑
  const zfun = za - 14;
  mb.box(-4.5, deckY, zfun - 4, 4.5, deckY + 34, zfun + 4, hull);
  mb.box(-4.6, deckY + 26, zfun - 4.1, 4.6, deckY + 29, zfun + 4.1, white);
  mb.box(-4.6, deckY + 34, zfun - 4.1, 4.6, deckY + 35, zfun + 4.1, black);
  // コンテナ：区画（40 フィート = 12.2m）ごとに、ハッチの上に積む。区画の間にラッシングブリッジ
  const cols = [0xc0392b, 0x2e6da4, 0xd9a400, 0x4c7a3b, 0x8a9097, 0xd35400, 0xe8e8e8, 0x1f6f8b, 0x7a3e9d, 0x8b5a2b].map((h) => new THREE.Color(h));
  const bayL = 12.6, gap = 1.6;
  const zStart = za + 10, zEnd = zf - 6;
  for (let z = zStart; z + bayL <= zEnd; z += bayL + gap) {
    const u = (z + bayL / 2 + L / 2) / L, w = Math.min(half(u), half((z + bayL + L / 2) / L)) - 1.2;
    const rows = Math.max(2, Math.floor((2 * w) / 2.5));
    const x0 = -(rows * 2.5) / 2;
    mb.box(x0 - 0.3, deckY, z, -x0 + 0.3, deckY + 1.2, z + bayL, grey); // ハッチ
    for (let r = 0; r < rows; r++) {
      const tiers = 3 + rng.int(4) - (r === 0 || r === rows - 1 ? 1 : 0);
      for (let t = 0; t < tiers; t++) mb.box(x0 + r * 2.5 + 0.05, deckY + 1.2 + t * 2.6, z + 0.1, x0 + (r + 1) * 2.5 - 0.05, deckY + 1.2 + t * 2.6 + 2.5, z + bayL - 0.1, rng.pick(cols));
    }
    // ラッシングブリッジ（区画の後ろ側）と、甲板の照明
    const zb = z - gap / 2;
    for (const x of [x0, 0, -x0]) mb.box(x - 0.2, deckY, zb - 0.2, x + 0.2, deckY + 8, zb + 0.2, grey);
    mb.box(x0, deckY + 7.6, zb - 0.3, -x0, deckY + 8, zb + 0.3, grey);
    mb.box(-0.4, deckY + 8, zb - 0.3, 0.4, deckY + 8.5, zb + 0.3, C(0xfff3d0), PAT.glow);
  }
}
const litBox = (mb: MeshBuilder, x: number, y: number, z: number, r: number, c: THREE.Color) => mb.box(x - r, y - r, z - r, x + r, y + r, z + r, c, PAT.glow, c);

// タグボート（船首が +z）：赤い船体、白い操舵室、黒い防舷材
export function tugBoat(mb: MeshBuilder) {
  const red = C(0xc0392b), white = C(0xf2f3f1), black = C(0x1c1f22);
  mb.prism([[-3.2, -6], [3.2, -6], [3.4, 4], [0, 8], [-3.4, 4]], -1.5, 2.2, red, PAT.none, C(0x55595e));
  mb.prism([[-3.5, -6.3], [3.5, -6.3], [3.7, 4.2], [0, 8.4], [-3.7, 4.2]], 1.2, 2.0, black, PAT.none, black);
  mb.box(-2, 2.2, -1.5, 2, 5.5, 3, white, PAT.apartment, white);
  mb.box(-1.6, 5.5, 0, 1.6, 7, 2.6, white, PAT.none, white);
  mb.box(-0.6, 5.5, -3.5, 0.6, 9, -2.5, C(0xd9a400));
}

// ================= 大型コンテナターミナル =================
// 敷地の奥（-z）が岸壁。長い方向（x）に沿って岸壁があり、ガントリークレーンが並ぶ。
// クレーンの位置と高さは propsLayer（トロリーの動き）でも使う
export const TERMINAL = { boomY: 46, apron: 40, seaRail: 6, landRail: 36, boomOut: 52 };
export function terminalCranes(W: number): number[] {
  // 実際のターミナルのように、クレーンどうしは 50m 以上あける（岸壁 192m で 3 基、256m で 4 基）
  const n = Math.max(2, Math.min(4, Math.floor(W / 64)));
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(-W / 2 + 22 + ((W - 44) * (k + 0.5)) / n);
  return out;
}
// 太さのある細長い部材（両端の点のあいだ）
function strut(mb: MeshBuilder, a: [number, number, number], b: [number, number, number], r: number, col: THREE.Color) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], l = Math.hypot(ux, uy, uz) || 1;
  let p1x = -uz, p1z = ux, pl = Math.hypot(p1x, p1z);
  if (pl < 1e-3) { p1x = 1; p1z = 0; pl = 1; }
  p1x /= pl; p1z /= pl;
  const p2x = (uy * p1z) / l, p2y = (uz * p1x - ux * p1z) / l, p2z = (-uy * p1x) / l;
  const cs: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const P = (o: [number, number, number], s1: number, s2: number): [number, number, number] => [o[0] + (p1x * s1 + p2x * s2) * r, o[1] + p2y * s2 * r, o[2] + (p1z * s1 + p2z * s2) * r];
  for (let k = 0; k < 4; k++) {
    const [s1, s2] = cs[k], [t1, t2] = cs[(k + 1) & 3];
    mb.quad(P(a, s1, s2), P(a, t1, t2), P(b, t1, t2), P(b, s1, s2), col);
    mb.quad(P(a, s1, s2), P(b, s1, s2), P(b, t1, t2), P(a, t1, t2), col);
  }
}
// ---- コンテナターミナルの細部（地面の塗装・汚れ、いろいろなコンテナ、荷役機械）----
// 地面に貼る凸多角形（[x, z] の並び。回る向きはどちらでもよい）
function ctFlat(mb: MeshBuilder, pts: [number, number][], y: number, col: THREE.Color) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  const keep = mb.matOverride;
  mb.matOverride = MAT.ground;
  const P = (k: number): [number, number, number] => [pts[k][0], y, pts[k][1]];
  for (let i = 1; i + 1 < pts.length; i++) {
    if (a > 0) mb.tri(P(0), P(i + 1), P(i), col);
    else mb.tri(P(0), P(i), P(i + 1), col);
  }
  mb.matOverride = keep;
}
// 地面の細い帯（2 点のあいだ、幅 w）
function ctStrip(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, w: number, y: number, col: THREE.Color) {
  const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * (w / 2), nz = (dx / l) * (w / 2);
  ctFlat(mb, [[x0 + nx, z0 + nz], [x1 + nx, z1 + nz], [x1 - nx, z1 - nz], [x0 - nx, z0 - nz]], y, col);
}
// 油じみ（ふちがでこぼこした、ひらたいしみ）
function ctBlob(mb: MeshBuilder, rng: Rng, x: number, z: number, r: number, y: number, col: THREE.Color) {
  const n = 9, pts: [number, number, number][] = [];
  const sx = 0.8 + rng.next() * 0.6;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2, rr = r * (0.55 + rng.next() * 0.55);
    pts.push([x + Math.cos(a) * rr * sx, y, z + Math.sin(a) * rr]);
  }
  const keep = mb.matOverride;
  mb.matOverride = MAT.ground;
  for (let k = 0; k < n; k++) mb.tri([x, y, z], pts[(k + 1) % n], pts[k], col);
  mb.matOverride = keep;
}
// タイヤのあと（中心 cx, cz の円弧を 2 本。a0..a1 はラジアン）
function ctTyreArc(mb: MeshBuilder, cx: number, cz: number, r: number, a0: number, a1: number, y: number, col: THREE.Color) {
  const n = 7;
  for (const rr of [r - 1, r + 1]) for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n, t1 = a0 + ((a1 - a0) * (k + 1)) / n;
    ctStrip(mb, cx + Math.cos(t0) * rr, cz + Math.sin(t0) * rr, cx + Math.cos(t1) * rr, cz + Math.sin(t1) * rr, 0.32, y, col);
  }
}
// 斜線のゼブラ（立入禁止などの区画）。枠線つき
function ctHatch(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, col: THREE.Color, pitch = 1.6, w = 0.5) {
  const t = 0.2;
  mb.ground(x0, z0, x1, z0 + t, y, col);
  mb.ground(x0, z1 - t, x1, z1, y, col);
  mb.ground(x0, z0 + t, x0 + t, z1 - t, y, col);
  mb.ground(x1 - t, z0 + t, x1, z1 - t, y, col);
  const seg = (c: number): [number, number][] | null => {
    const xa = Math.max(x0, c - z1), xb = Math.min(x1, c - z0);
    return xa < xb - 0.05 ? [[xa, c - xa], [xb, c - xb]] : null;
  };
  for (let c = x0 + z0 + pitch * 0.5; c + w < x1 + z1; c += pitch) {
    const A = seg(c), B = seg(c + w);
    if (A && B) ctFlat(mb, [A[0], A[1], B[1], B[0]], y, col);
  }
}
// 地面に描く文字（7 本の線の字）。左下が (x, z)、字の上は -z の向き
const CT_SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  A: 'abcefg', B: 'cdefg', C: 'adef', D: 'bcdeg', E: 'adefg', F: 'aefg', G: 'acdef', H: 'bcefg',
};
function ctText(mb: MeshBuilder, s: string, x: number, z: number, h: number, y: number, col: THREE.Color) {
  const w = h * 0.56, t = h * 0.14;
  let cx = x;
  for (const ch of s) {
    const sg = CT_SEG[ch] ?? '';
    const R = (u0: number, v0: number, u1: number, v1: number) => mb.ground(cx + u0, z - v1, cx + u1, z - v0, y, col);
    if (sg.includes('a')) R(0, h - t, w, h);
    if (sg.includes('b')) R(w - t, h / 2, w, h - t);
    if (sg.includes('c')) R(w - t, t, w, h / 2);
    if (sg.includes('d')) R(0, 0, w, t);
    if (sg.includes('e')) R(0, t, t, h / 2);
    if (sg.includes('f')) R(0, h / 2, t, h - t);
    if (sg.includes('g')) R(t, h / 2 - t / 2, w - t, h / 2 + t / 2);
    cx += w + h * 0.3;
  }
}
// コンテナの色：船会社の色に、日焼けと汚れのむら
const CT_LINES = [0xa8352c, 0x2a5f93, 0x1e6f7c, 0xc98a2a, 0x3f6440, 0x7c8288, 0x6b3a2e, 0xd8d6cf, 0x1d3a5e, 0x5d6670, 0xb8662a, 0x3d6b5a, 0x8f969c, 0x2a5f93];
function ctCol(rng: Rng, hex: number) {
  const c = new THREE.Color(hex), k = rng.next();
  const l = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
  c.lerp(new THREE.Color(l, l, l), 0.18); // 少し色あせ
  c.lerp(new THREE.Color(0x8a8378), k * k * 0.4);
  return c.multiplyScalar(0.86 + rng.next() * 0.16);
}
// コンテナ 1 個（波板の金属の模様）
function ctBox(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, z1: number, col: THREE.Color, h = 2.5) {
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  mb.box(x0, y0, z0, x1, y0 + h, z1, col);
  mb.matOverride = keep;
}
// 向きのある箱：alongZ = false なら長さの向き u が x、true なら u が z（v はその横）
function oBox(mb: MeshBuilder, cx: number, cz: number, alongZ: boolean, u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, col: THREE.Color, pat: number = PAT.none, roof?: THREE.Color) {
  const ua = Math.min(u0, u1), ub = Math.max(u0, u1), va = Math.min(v0, v1), vb = Math.max(v0, v1);
  if (alongZ) mb.box(cx + va, y0, cz + ua, cx + vb, y1, cz + ub, col, pat, roof);
  else mb.box(cx + ua, y0, cz + va, cx + ub, y1, cz + vb, col, pat, roof);
}
// x の向きの横倒しの円筒（タンクコンテナの胴）。両端にふた
function ctCylX(mb: MeshBuilder, xa: number, xb: number, cy: number, cz: number, r: number, seg: number, col: THREE.Color, cap: THREE.Color) {
  const P = (a: number, x: number): [number, number, number] => [x, cy + Math.cos(a) * r, cz + Math.sin(a) * r];
  const N = (a: number): [number, number, number] => [0, Math.cos(a), Math.sin(a)];
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
    mb.quadN(P(a0, xa), P(a1, xa), P(a1, xb), P(a0, xb), N(a0), N(a1), N(a1), N(a0), col);
    mb.tri([xb, cy, cz], P(a0, xb), P(a1, xb), cap);
    mb.tri([xa, cy, cz], P(a1, xa), P(a0, xa), cap);
  }
}
// タンクコンテナ（20 フィートの枠の中に、横倒しのタンク）
function ctTank(mb: MeshBuilder, x0: number, y0: number, z0: number, frame: THREE.Color, tank: THREE.Color) {
  const x1 = x0 + 6.06, z1 = z0 + 2.44, h = 2.5, t = 0.16;
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  for (const x of [x0, x1 - t]) for (const z of [z0, z1 - t]) mb.box(x, y0, z, x + t, y0 + h, z + t, frame);
  for (const y of [y0, y0 + h - t]) {
    for (const z of [z0, z1 - t]) mb.box(x0 + t, y, z, x1 - t, y + t, z + t, frame);
    for (const x of [x0, x1 - t]) mb.box(x, y, z0 + t, x + t, y + t, z1 - t, frame);
  }
  mb.matOverride = keep;
  ctCylX(mb, x0 + 0.3, x1 - 0.3, y0 + h / 2, (z0 + z1) / 2, 1.08, 10, tank, tank.clone().multiplyScalar(0.85));
  mb.box(x0 + 2.6, y0 + h - 0.06, z0 + 0.9, x0 + 3.4, y0 + h + 0.05, z1 - 0.9, frame); // 上の歩み板（マンホール）
}
// フラットラック（床と両端の壁だけのコンテナ）。積み荷 kind：0 なし、1 木箱、2 鋼管、3 シートをかけた機械
function ctFlatRack(mb: MeshBuilder, x0: number, y0: number, z0: number, len: number, col: THREE.Color, kind: number) {
  const x1 = x0 + len, z1 = z0 + 2.44;
  ctBox(mb, x0, y0, z0, x1, z1, col, 0.55);
  ctBox(mb, x0, y0 + 0.55, z0, x0 + 0.3, z1, col, 1.95);
  ctBox(mb, x1 - 0.3, y0 + 0.55, z0, x1, z1, col, 1.95);
  const y = y0 + 0.55;
  if (kind === 1) {
    mb.box(x0 + 0.8, y, z0 + 0.2, x0 + len * 0.48, y + 1.7, z1 - 0.2, C(0xa8865a));
    mb.box(x0 + len * 0.52, y, z0 + 0.3, x1 - 0.8, y + 1.3, z1 - 0.3, C(0x9a7a52));
  } else if (kind === 2) {
    for (let k = 0; k < 4; k++) mb.box(x0 + 0.5, y + (k >> 1) * 0.55, z0 + 0.25 + (k & 1) * 1.0, x1 - 0.5, y + 0.5 + (k >> 1) * 0.55, z0 + 1.2 + (k & 1) * 1.0, C(0x5b5f63));
  } else if (kind === 3) {
    mb.box(x0 + 0.8, y, z0 + 0.15, x1 - 0.8, y + 2.1, z1 - 0.15, C(0x34503f));
    mb.box(x0 + 1.4, y + 2.1, z0 + 0.5, x1 - 1.4, y + 2.5, z1 - 0.5, C(0x34503f));
  }
}
// 冷凍コンテナ（白）。alongZ = false なら長さが x の向きで、end = +1 なら +x の端に冷凍機（-1 なら -x）。alongZ = true なら z の向き
function ctReefer(mb: MeshBuilder, rng: Rng, x0: number, y0: number, z0: number, x1: number, z1: number, end: number, alongZ = false) {
  ctBox(mb, x0, y0, z0, x1, z1, ctCol(rng, rng.next() < 0.8 ? 0xeeeee8 : 0xd8dcd8));
  const panel = C(0x6a7077), fan = C(0x2c3035);
  if (!alongZ) {
    const xe = end > 0 ? x1 : x0;
    mb.box(Math.min(xe, xe + end * 0.1), y0 + 0.15, z0 + 0.15, Math.max(xe, xe + end * 0.1), y0 + 2.35, z1 - 0.15, panel);
    mb.box(Math.min(xe, xe + end * 0.14), y0 + 1.2, z0 + 0.5, Math.max(xe, xe + end * 0.14), y0 + 2.0, z0 + 1.3, fan); // ファン
  } else {
    const ze = end > 0 ? z1 : z0;
    mb.box(x0 + 0.15, y0 + 0.15, Math.min(ze, ze + end * 0.1), x1 - 0.15, y0 + 2.35, Math.max(ze, ze + end * 0.1), panel);
    mb.box(x0 + 0.5, y0 + 1.2, Math.min(ze, ze + end * 0.14), x0 + 1.3, y0 + 2.0, Math.max(ze, ze + end * 0.14), fan);
  }
}
// 冷凍コンテナの電源ラック（長い鉄骨。段ごとに歩廊、上にケーブルの棚、始まりの端に階段）。
// alongZ = true なら x = c の線にそって z = a..b、false なら z = c の線にそって x = a..b
function ctReeferRack(mb: MeshBuilder, c: number, a: number, b: number, tiers: number, alongZ = true) {
  const st = C(0x8d959c), grate = C(0x5d6369), yel = C(0xf2c200);
  // u = 長さの向き、v = 横の向き
  const B = (u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, col: THREE.Color, pat: number = PAT.none, roof?: THREE.Color) => {
    if (alongZ) mb.box(c + v0, y0, u0, c + v1, y1, u1, col, pat, roof);
    else mb.box(u0, y0, c + v0, u1, y1, c + v1, col, pat, roof);
  };
  const P = (u: number, y: number, v: number): [number, number, number] => (alongZ ? [c + v, y, u] : [u, y, c + v]);
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  const n = Math.max(2, Math.round((b - a) / 5));
  for (let i = 0; i <= n; i++) {
    const u = a + ((b - a) * i) / n;
    for (const dv of [-0.85, 0.85]) B(u - 0.12, 0, dv - 0.12, u + 0.12, 9.2, dv + 0.12, st);
    B(u - 0.1, 8.6, -0.95, u + 0.1, 8.8, 0.95, st);
    if (i < n) B(u + 1.2, 0, -0.45, u + 2.0, 1.8, 0.45, C(0xb7bec4), PAT.none, C(0x9aa1a7)); // 電源盤
  }
  for (let lv = 1; lv < tiers; lv++) {
    const y = lv * 2.6 + 0.2;
    B(a, y - 0.15, -0.85, b, y, 0.85, grate);
    for (const dv of [-0.82, 0.82]) B(a, y + 1.0, dv - 0.03, b, y + 1.08, dv + 0.03, yel);
  }
  B(a - 0.3, 8.8, -1.05, b + 0.3, 9.25, 1.05, st); // ケーブルの棚
  mb.matOverride = keep;
  // 階段（a の端、地面から 1 段目の歩廊へ）
  const steps = 8, run = 3.2;
  for (let i = 0; i < steps; i++) {
    const u0 = a - run + (run * i) / steps;
    B(u0, 0, -0.5, u0 + run / steps + 0.02, ((i + 1) * 2.8) / steps, 0.5, grate);
  }
  for (const dv of [-0.52, 0.52]) strut(mb, P(a - run, 1.0, dv), P(a, 3.8, dv), 0.04, yel);
}
// AGV（無人搬送車。電池で走る低い台車）。中心 (cx, cz)、長さの向き alongZ。load があればコンテナを載せる
function ctAgv(mb: MeshBuilder, cx: number, cz: number, alongZ: boolean, load: THREE.Color | null) {
  const body = C(0xe4e7ea), dk = C(0x2a2d31), acc = C(0x2e6da4);
  const B = (u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, c: THREE.Color, pat: number = PAT.none) => oBox(mb, cx, cz, alongZ, u0, y0, v0, u1, y1, v1, c, pat);
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  B(-7.4, 0.35, -1.5, 7.4, 1.55, 1.5, body);
  B(-7.4, 0.35, -1.52, 7.4, 0.75, 1.52, acc); // 側面の青い帯（電池の箱）
  for (const u of [-7.5, 7.5]) B(u - 0.12, 0.3, -1.4, u + 0.12, 1.1, 1.4, dk); // バンパー
  for (const u of [-5.6, 5.6]) for (const v of [-1.1, 1.1]) B(u - 0.5, 0, v - 0.3, u + 0.5, 0.75, v + 0.3, dk);
  mb.matOverride = keep;
  for (const u of [-7.3, 7.3]) for (const v of [-1.35, 1.35]) B(u - 0.12, 1.55, v - 0.12, u + 0.12, 1.75, v + 0.12, C(0xffb020), PAT.glow); // 回転灯
  if (load) {
    if (alongZ) ctBox(mb, cx - 1.22, 1.55, cz - 6.1, cx + 1.22, cz + 6.1, load);
    else ctBox(mb, cx - 6.1, 1.55, cz - 1.22, cx + 6.1, cz + 1.22, load);
  }
}
// 自動のレール式門型クレーン（ARMG / ASC）。x0..x1 のレールの上（z の向きに走る）、中心 z = cz。
// 白とグレーの門型、上に横行するトロリーと吊り具、脚の下に車輪の台車、横にケーブルリール
function ctArmg(mb: MeshBuilder, x0: number, x1: number, cz: number, h: number, tx: number, hookY: number, load: THREE.Color | null) {
  const wh = C(0xeef0f1), gr = C(0x8f979e), dk = C(0x3c434b);
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  for (const x of [x0, x1]) {
    for (const dz of [-3.4, 3.4]) mb.box(x - 0.45, 1.2, cz + dz - 0.45, x + 0.45, h, cz + dz + 0.45, wh);
    mb.box(x - 0.6, 0, cz - 4.4, x + 0.6, 1.2, cz + 4.4, dk); // 台車
    mb.box(x - 0.35, 5, cz - 3.4, x + 0.35, 5.6, cz + 3.4, wh); // 脚のつなぎ
    strut(mb, [x, 1.4, cz - 3.4], [x, h - 1, cz + 3.4], 0.18, gr);
  }
  for (const dz of [-3.4, 3.4]) mb.box(x0 - 0.8, h, cz + dz - 0.7, x1 + 0.8, h + 1.8, cz + dz + 0.7, wh); // 2 本の桁
  for (const x of [x0, x1]) mb.box(x - 0.8, h, cz - 3.4, x + 0.8, h + 1.8, cz + 3.4, gr);
  mb.box(x0 - 0.9, h + 1.8, cz - 4.1, x1 + 0.9, h + 2.0, cz - 3.9, gr); // 歩廊
  // トロリー（機械室）
  mb.box(tx - 2.6, h + 1.8, cz - 3.0, tx + 2.6, h + 3.6, cz + 3.0, wh, PAT.industrial, C(0xc9ccd1));
  mb.box(tx - 2.4, hookY, cz - 6.0, tx + 2.4, hookY + 0.4, cz + 6.0, C(0xe0a21a)); // 吊り具
  for (const dz of [-2.5, 2.5]) mb.box(tx - 0.05, hookY + 0.4, cz + dz - 0.05, tx + 0.05, h + 1.8, cz + dz + 0.05, C(0x30343a));
  // ケーブルリール（電気で動く）
  mb.cylinder(x1 + 1.3, cz, 1.0, 3.4, 1.1, 10, gr, gr);
  mb.box(x1 + 0.4, 1.0, cz - 0.4, x1 + 1.8, 4.6, cz + 0.4, wh);
  mb.matOverride = keep;
  if (load) ctBox(mb, tx - 1.22, hookY - 2.5, cz - 6.1, tx + 1.22, cz + 6.1, load);
  mb.box(x0 - 0.3, h + 2.0, cz - 0.3, x0 + 0.3, h + 2.5, cz + 0.3, C(0xff4040), PAT.glow);
}
// 屋上の太陽光パネル（x の向きの列）
function ctSolar(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number) {
  const pv = C(0x1d2c44), fr = C(0xb7bec4);
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  for (let z = z0; z + 1.8 <= z1; z += 2.6) {
    mb.quad([x0, y + 0.25, z + 1.8], [x1, y + 0.25, z + 1.8], [x1, y + 0.75, z], [x0, y + 0.75, z], pv);
    mb.box(x0, y, z + 1.75, x1, y + 0.25, z + 1.85, fr);
    for (let x = x0; x < x1 - 0.5; x += 5) mb.quad([x, y + 0.26, z + 1.8], [x + 0.06, y + 0.26, z + 1.8], [x + 0.06, y + 0.76, z], [x, y + 0.76, z], fr);
  }
  mb.matOverride = keep;
}
// 90 度まわした向きで描く（x の向きの部品を z の向きに置く）。中で描いた点 (px, pz) は敷地の (-pz, px) になる
function ctTurned(mb: MeshBuilder, draw: () => void) {
  const o = mb.world(0, 0, 0), ex = mb.world(1, 0, 0);
  const ang = Math.atan2(ex[2] - o[2], ex[0] - o[0]);
  mb.setTransform(ang + Math.PI / 2, o[0], o[1], o[2]);
  draw();
  mb.setTransform(ang, o[0], o[1], o[2]);
}
// リーチスタッカー（前に長い腕をのばしてコンテナをつかむ車）。dir = +1 なら +x を向く
function reachStacker(mb: MeshBuilder, cx: number, cz: number, dir: number, col: THREE.Color, load: THREE.Color | null) {
  const dk = C(0x26292d);
  const B = (u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, c: THREE.Color, pat: number = PAT.none) => oBox(mb, cx, cz, false, u0 * dir, y0, v0, u1 * dir, y1, v1, c, pat);
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  B(-3.6, 0.7, -1.8, 3.4, 2.3, 1.8, col);
  B(-4.3, 0.7, -1.7, -3.2, 3.3, 1.7, C(0x4a4f55)); // 後ろのおもり
  for (const [u, r] of [[2.4, 0.95], [-2.4, 0.8]] as [number, number][]) for (const v of [-1.85, 1.85]) B(u - r, 0, v - 0.45, u + r, r * 2, v + 0.45, dk);
  mb.matOverride = keep;
  B(-0.6, 2.3, -1.75, 1.3, 5.0, -0.25, C(0x3d5468), PAT.fullglass); // 運転室
  B(-0.7, 5.0, -1.85, 1.4, 5.2, -0.15, col);
  const P = (u: number, y: number, v: number): [number, number, number] => [cx + u * dir, y, cz + v];
  strut(mb, P(-3.0, 3.2, 0.55), P(6.6, 11.4, 0.55), 0.5, col);
  strut(mb, P(-0.5, 2.3, 0.55), P(2.2, 6.0, 0.55), 0.22, C(0x8a9097)); // 油圧シリンダ
  const tu = 6.6, ty = 11.4;
  mb.matOverride = MAT.metal;
  B(tu - 0.5, ty - 1.0, -6.0, tu + 0.5, ty - 0.55, 6.0, C(0xe0a21a)); // 吊り具（横向き）
  mb.matOverride = keep;
  if (load) ctBox(mb, cx + (tu * dir) - 1.22, ty - 3.6, cz - 6.1, cx + (tu * dir) + 1.22, cz + 6.1, load);
}
// コンテナ用のシャーシ（x の向き、x0 が後ろ）と、つないだヤードトラクター（tractor = true）
function ctChassis(mb: MeshBuilder, x0: number, cz: number, load: THREE.Color | null, tractor: THREE.Color | null) {
  const x1 = x0 + 12.4, fr = C(0x3a3e43), dk = C(0x222528);
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  for (const v of [-0.55, 0.55]) mb.box(x0, 1.05, cz + v - 0.15, x1, 1.4, cz + v + 0.15, fr);
  for (const x of [x0, x0 + 6.0, x1 - 0.3]) mb.box(x, 1.1, cz - 1.2, x + 0.3, 1.38, cz + 1.2, fr);
  for (const x of [x0 + 0.8, x0 + 2.2]) for (const v of [-1.0, 1.0]) mb.box(x - 0.52, 0, cz + v - 0.25, x + 0.52, 1.04, cz + v + 0.25, dk);
  for (const v of [-0.6, 0.6]) mb.box(x1 - 3.4, 0, cz + v - 0.08, x1 - 3.25, 1.05, cz + v + 0.08, C(0x8a9097));
  mb.matOverride = keep;
  if (load) ctBox(mb, x0 + 0.1, 1.4, cz - 1.22, x0 + 12.3, cz + 1.22, load);
  if (tractor) {
    const t0 = x1 - 1.0;
    mb.box(t0, 0.5, cz - 1.2, t0 + 5.4, 1.3, cz + 1.2, fr);
    mb.box(t0 + 3.6, 1.3, cz - 1.25, t0 + 5.4, 3.3, cz + 0.2, tractor, PAT.fullglass, tractor);
    for (const x of [t0 + 1.1, t0 + 4.4]) for (const v of [-1.05, 1.05]) mb.box(x - 0.55, 0, cz + v - 0.3, x + 0.55, 1.1, cz + v + 0.3, dk);
  }
}
// ラッシングケージ（固定金具を入れておく、黄色い枠の網のかご）
function lashCage(mb: MeshBuilder, x: number, z: number) {
  const yel = C(0xe8b923);
  mb.box(x - 1.25, 0, z - 1.0, x + 1.25, 0.22, z + 1.0, yel);
  mb.box(x - 1.1, 0.22, z - 0.85, x + 1.1, 1.9, z + 0.85, C(0x4d5258));
  for (const dx of [-1.15, 1.15]) for (const dz of [-0.9, 0.9]) mb.box(x + dx - 0.08, 0.22, z + dz - 0.08, x + dx + 0.08, 2.0, z + dz + 0.08, yel);
  mb.box(x - 1.2, 1.95, z - 0.95, x + 1.2, 2.05, z + 0.95, yel);
}
// 小屋（現場の詰所・休憩所）
function ctHut(mb: MeshBuilder, x: number, z: number, w: number, d: number, col: THREE.Color) {
  mb.box(x - w / 2, 0, z - d / 2, x + w / 2, 2.6, z + d / 2, col, PAT.house, C(0x9aa1a7));
  mb.box(x - w / 2 - 0.15, 2.6, z - d / 2 - 0.15, x + w / 2 + 0.15, 2.8, z + d / 2 + 0.15, C(0x8a9097));
  mb.box(x + w / 2, 1.6, z - 0.4, x + w / 2 + 0.35, 2.2, z + 0.4, C(0xd5d9dd)); // エアコンの室外機
}
// 金網のフェンス（軸にそった直線。柱と 3 本の横棒）
function ctFence(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, h = 2.4) {
  const col = C(0x7b8289), L = Math.hypot(x1 - x0, z1 - z0);
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  const n = Math.max(1, Math.round(L / 3.5));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, z = z0 + ((z1 - z0) * i) / n;
    mb.box(x - 0.06, 0, z - 0.06, x + 0.06, h + 0.3, z + 0.06, col);
  }
  const xa = Math.min(x0, x1) - 0.03, xb = Math.max(x0, x1) + 0.03, za = Math.min(z0, z1) - 0.03, zb = Math.max(z0, z1) + 0.03;
  for (const y of [0.15, h * 0.5, h - 0.06]) mb.box(xa, y, za, xb, y + 0.06, zb, col);
  mb.box(xa, h + 0.22, za, xb, h + 0.26, zb, C(0x55595e)); // 有刺鉄線
  mb.matOverride = keep;
}
// 照明塔（高いマストと、上の灯具の輪）
function ctMast(mb: MeshBuilder, x: number, z: number, h = 32) {
  const g = C(0x9aa1a7);
  mb.box(x - 0.9, 0, z - 0.9, x + 0.9, 0.6, z + 0.9, C(0xa8a49b));
  const keep = mb.matOverride;
  mb.matOverride = MAT.metal;
  mb.cylinder(x, z, 0.6, h, 0.6, 8, g, undefined, 0.32);
  mb.box(x - 2.4, h, z - 2.4, x + 2.4, h + 0.3, z + 2.4, g);
  mb.box(x - 0.3, h + 0.3, z - 0.3, x + 0.3, h + 2.4, z + 0.3, g);
  mb.matOverride = keep;
  for (const [dx, dz] of [[-1.7, -2.3], [0, -2.3], [1.7, -2.3], [-1.7, 2.3], [0, 2.3], [1.7, 2.3]]) mb.box(x + dx - 0.65, h + 0.3, z + dz - 0.35, x + dx + 0.65, h + 1.3, z + dz + 0.35, C(0xfff3d0), PAT.glow);
  mb.box(x - 0.15, h + 2.4, z - 0.15, x + 0.15, h + 2.8, z + 0.15, C(0xff4040), PAT.glow); // 航空障害灯
}
function containerTerminal(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  mb.flatRoofMat = MAT.none;
  const W = f.W, D = f.D, hw = W / 2, hd = D / 2;
  const T = TERMINAL;
  const conc = C(0xbdb8ad), asph = C(0x4a4d51), yel = C(0xf2c200), white = PALETTE.white;
  const paint = C(0xeeeeea), yPaint = C(0xe6b800);
  const mo = mb.matOverride;
  const lineCol = () => ctCol(rng, rng.pick(CT_LINES));
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, conc);
  // 岸壁（水側に張り出す厚い壁）とフェンダー
  mb.box(-hw, -5, -hd - 3, hw, 0.4, -hd + 1, C(0xa8a49b));
  for (let x = -hw + 6; x < hw - 4; x += 12) mb.box(x - 1, -2.5, -hd - 3.6, x + 1, 0.2, -hd - 3, C(0x2a2d31));
  // 岸壁のエプロン（クレーンのレールと、トラックの通り道）
  mb.ground(-hw + 1, -hd + 1, hw - 1, -hd + T.apron, 0.09, asph);
  for (const z of [-hd + T.seaRail, -hd + T.landRail]) for (const o of [-0.5, 0.5]) mb.ground(-hw + 1, z + o - 0.08, hw - 1, z + o + 0.08, 0.11, C(0xc9ccd1));
  mb.ground(-hw + 1, -hd + 18.6, hw - 1, -hd + 18.9, 0.11, yel);
  mb.ground(-hw + 1, -hd + 26.6, hw - 1, -hd + 26.9, 0.11, yel);
  // ---- エプロンの細部：補修したアスファルト、油じみ、岸壁のふちの線と係船柱、ゼブラ ----
  for (let k = 0; k < 14; k++) {
    const x = -hw + 4 + rng.next() * (W - 16), z = -hd + 2 + rng.next() * (T.apron - 6), w = 3 + rng.next() * 9, d = 2 + rng.next() * 4;
    mb.ground(x, z, x + w, Math.min(-hd + T.apron - 0.5, z + d), 0.095, rng.next() < 0.5 ? C(0x404347) : C(0x56595d));
  }
  for (let k = 0; k < 26; k++) ctBlob(mb, rng, -hw + 4 + rng.next() * (W - 8), -hd + 19.5 + rng.next() * 6.5, 0.5 + rng.next() * 1.1, 0.1, C(0x2c2e31));
  for (let k = 0; k < 10; k++) ctBlob(mb, rng, -hw + 4 + rng.next() * (W - 8), -hd + 8 + rng.next() * 9, 0.4 + rng.next() * 0.8, 0.1, C(0x333538));
  mb.ground(-hw + 1, -hd + 1.6, hw - 1, -hd + 1.9, 0.11, yel);
  for (let x = -hw + 4; x < hw - 2; x += 14) {
    mb.box(x - 0.35, 0.09, -hd + 0.6, x + 0.35, 0.75, -hd + 1.3, C(0x2a2d31));
    mb.box(x - 0.5, 0.75, -hd + 0.45, x + 0.5, 0.95, -hd + 1.45, C(0x2a2d31));
  }
  ctHatch(mb, -hw + 2, -hd + 8, -hw + 15, -hd + 17, 0.11, yel);
  ctHatch(mb, hw - 15, -hd + 8, hw - 2, -hd + 17, 0.11, yel);
  // ---- ガントリークレーン（STS）----
  const craneCol = rng.next() < 0.5 ? C(0x2f6fb0) : C(0xd9472b);
  const cxs = terminalCranes(W);
  for (const cx of cxs) {
    const y0 = 0, yp = T.boomY - 4, yb = T.boomY;
    const zs = -hd + T.seaRail, zl = -hd + T.landRail;
    mb.matOverride = MAT.metal;
    // 4 本の脚と、下の横つなぎ
    for (const z of [zs, zl]) for (const sx of [-9, 9]) mb.box(cx + sx - 0.8, y0, z - 0.8, cx + sx + 0.8, yp, z + 0.8, craneCol);
    for (const z of [zs, zl]) mb.box(cx - 9.8, 12, z - 0.7, cx + 9.8, 14, z + 0.7, craneCol);
    for (const sx of [-9, 9]) mb.box(cx + sx - 0.7, yp - 2, zs, cx + sx + 0.7, yp, zl, craneCol);
    for (const sx of [-9, 9]) for (const z of [zs, zl]) mb.box(cx + sx - 1.4, 0, z - 1.4, cx + sx + 1.4, 1.6, z + 1.4, C(0x3c434b)); // 台車
    // ブーム（2 本の桁）：陸側の後ろから、海の上へ大きく張り出す
    const zBack = zl + 16, zTip = -hd - T.boomOut;
    for (const sx of [-2.2, 2.2]) mb.box(cx + sx - 0.7, yb - 2, zTip, cx + sx + 0.7, yb, zBack, craneCol);
    for (let z = zTip + 4; z < zBack; z += 8) mb.box(cx - 2.9, yb - 0.6, z - 0.3, cx + 2.9, yb - 0.2, z + 0.3, craneCol);
    // A 字の塔と、ブームを吊る斜めの引き綱
    const apex: [number, number, number] = [cx, yb + 24, zs + 8];
    for (const sx of [-8, 8]) for (const z of [zs + 2, zl - 6]) strut(mb, [cx + sx, yp, z], apex, 0.7, craneCol);
    for (const zt of [zTip + 2, zTip + 22]) strut(mb, apex, [cx, yb, zt], 0.25, C(0x30343a));
    strut(mb, apex, [cx, yb, zBack - 2], 0.25, C(0x30343a));
    // 機械室（陸側の後ろ）
    mb.box(cx - 5, yb, zBack - 12, cx + 5, yb + 6, zBack, white, PAT.industrial, C(0xc9ccd1));
    mb.matOverride = mo;
    // 電気で動く（運転室はない）：陸側の脚にケーブルリール
    mb.matOverride = MAT.metal;
    mb.cylinder(cx + 9, zl + 2.6, 1.2, 4.6, 1.4, 10, C(0x8f979e), C(0x8f979e));
    mb.matOverride = mo;
    // 夜の灯り（ブームの先）
    mb.box(cx - 0.5, yb + 0.5, zTip - 0.5, cx + 0.5, yb + 1.3, zTip + 0.5, C(0xff4040), PAT.glow);
    // 脚のまわりの立入禁止の印
    for (const sx of [-9, 9]) ctHatch(mb, cx + sx - 2.6, zl + 1.6, cx + sx + 2.6, zl + 3.4, 0.11, yel, 1.2, 0.4);
  }
  // クレーンの間：船のハッチカバー、ラッシングケージ、詰所（トラックの通り道とレールの間）
  const gapsX: number[] = [];
  for (let k = 0; k + 1 < cxs.length; k++) gapsX.push((cxs[k] + cxs[k + 1]) / 2);
  for (const gx of gapsX) {
    const hc = C(0x5c6670);
    const keep = mb.matOverride;
    mb.matOverride = MAT.metal;
    mb.box(gx - 6.2, 0.09, -hd + 8.2, gx + 3.8, 1.1, -hd + 16.4, hc);
    mb.box(gx - 5.9, 1.1, -hd + 8.6, gx + 3.5, 1.35, -hd + 16.0, hc.clone().multiplyScalar(1.12));
    mb.box(gx - 5.6, 1.35, -hd + 9.0, gx + 2.6, 2.3, -hd + 15.4, hc);
    mb.matOverride = keep;
    for (let k = 0; k < 3; k++) lashCage(mb, gx + 6.2 + (k % 2) * 2.8, -hd + 9.8 + k * 2.4);
  }
  for (const s of [-1, 1]) {
    ctHut(mb, s * (hw - 8.5), -hd + 12.5, 3.2, 2.4, C(0xe9eae6));
    lashCage(mb, s * (hw - 12.5), -hd + 10.4);
    lashCage(mb, s * (hw - 12.5), -hd + 14.6);
  }

  // ---- 自動化ヤード（シンガポールのトゥアス・パシルパンジャン風）----
  // 岸壁 → AGV の走る帯（黒いアスファルトに格子の線）→ 岸壁に直角な長い区画（両端に受け渡しの場所、ARMG がまたぐ）→ ゲート。
  // 大きさは W, D から決める（敷地の大きさが変わっても並ぶように）
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const apronEnd = -hd + T.apron;
  const gateD = clamp(D * 0.16, 16, 34), gateZ = hd - gateD;
  const agvD = clamp(D * 0.1, 10, 24);
  const yard0 = apronEnd + agvD; // 区画の海側の端
  let tzD = 15, ltzD = 13;
  const room = gateZ - 1 - yard0;
  if (room - tzD - ltzD < 12.4) { const k = Math.max(0.3, (room - 12.4) / (tzD + ltzD)); tzD *= k; ltzD *= k; }
  const stack0 = yard0 + tzD, yard1 = gateZ - 1 - ltzD; // コンテナを積むところ（z = stack0..yard1）
  const depotX1 = -hw + Math.min(36, W * 0.19); // 西の端：空コンテナの置き場と管理棟
  const pitchW = 2.5, nr = 8, bw = nr * pitchW, pitch = bw + 6;
  const bx0 = depotX1 + 2, bx1 = hw - 6;
  const nb = Math.max(1, Math.floor((bx1 - bx0 + 6) / pitch));
  const off = (bx1 - bx0 - (nb * pitch - 6)) / 2;
  const blocks: number[] = [];
  for (let i = 0; i < nb; i++) blocks.push(bx0 + off + i * pitch);
  const railA = (x: number) => x - 1.5, railB = (x: number) => x + bw + 1.4;
  const darkAs = C(0x3f4246), gridLine = C(0x7d8186);
  // AGV の帯：黒いアスファルト、6m ごとの格子の線、走る向きの破線、タイヤのあと
  mb.ground(-hw + 1, apronEnd + 0.35, hw - 1, yard0, 0.09, darkAs);
  for (let x = -hw + 6; x < hw - 1; x += 6) mb.ground(x - 0.05, apronEnd + 0.6, x + 0.05, yard0 - 0.3, 0.1, gridLine);
  for (let z = apronEnd + 3; z < yard0 - 0.5; z += 3.2) mb.ground(-hw + 2, z - 0.05, hw - 2, z + 0.05, 0.1, gridLine);
  mb.ground(-hw + 2, apronEnd + 0.6, hw - 2, apronEnd + 0.78, 0.1, yPaint);
  mb.ground(-hw + 2, yard0 - 0.6, hw - 2, yard0 - 0.42, 0.1, yPaint);
  for (let k = 0; k < 30; k++) ctBlob(mb, rng, -hw + 4 + rng.next() * (W - 8), apronEnd + 1 + rng.next() * (agvD - 2), 0.4 + rng.next() * 0.9, 0.097, C(0x2c2e31));
  const tyreD = C(0x34363a);
  for (const x of blocks) {
    if (rng.next() < 0.7) ctTyreArc(mb, x + 4, yard0 - 6.5, 6, Math.PI * 0.5, Math.PI, 0.095, tyreD);
    if (rng.next() < 0.7) ctTyreArc(mb, x + bw - 4, yard0 - 6.5, 6, 0, Math.PI * 0.5, 0.095, tyreD);
  }
  for (const o of [-2.1, -0.9, 1.0, 2.2]) mb.ground(-hw + 3, (apronEnd + yard0) / 2 + o - 0.3, hw - 3, (apronEnd + yard0) / 2 + o + 0.3, 0.095, C(0x393b3f));
  // AGV：帯の中を走るもの（止めて描く）
  const nAgv = 3 + rng.int(3);
  for (let k = 0; k < nAgv; k++) {
    const x = -hw + 14 + ((W - 28) * (k + rng.next() * 0.5)) / nAgv, z = apronEnd + 2.5 + rng.next() * Math.max(0, agvD - 5);
    ctAgv(mb, x, z, false, rng.next() < 0.65 ? lineCol() : null);
  }
  // コンクリートの板：色むらと目地（区画と、陸側の受け渡しの場所）
  const slab = 6;
  for (let z = yard0; z < gateZ - 0.1; z += slab) for (let x = -hw + 0.2; x < hw - 0.3; x += slab) {
    const p = rng.next();
    if (p > 0.24) continue;
    const c = p < 0.08 ? C(0xc9c4b9) : p < 0.16 ? C(0xb1aca2) : p < 0.2 ? C(0xc4baa5) : C(0xa9a49a);
    mb.ground(x + 0.05, z + 0.05, Math.min(hw - 0.2, x + slab) - 0.05, Math.min(gateZ, z + slab) - 0.05, 0.08, c);
  }
  const joint = C(0x9d988f);
  for (let z = yard0 + slab; z < gateZ; z += slab) mb.ground(-hw + 0.2, z - 0.05, hw - 0.2, z + 0.05, 0.09, joint);
  for (let x = -hw + slab; x < hw - 0.5; x += slab) mb.ground(x - 0.05, yard0, x + 0.05, gateZ, 0.09, joint);
  mb.ground(-hw + 1, apronEnd - 0.05, hw - 1, apronEnd + 0.35, 0.09, C(0x8f8b84)); // エプロンとの境目

  // ---- 区画ごと ----
  const reeferIdx = 0;
  const specialIdx = nb > 2 ? 1 + rng.int(nb - 2) : -1;
  const lineBase = [rng.pick(CT_LINES), rng.pick(CT_LINES), rng.pick(CT_LINES)];
  const stackL = yard1 - stack0;
  blocks.forEach((x, bi) => {
    const xa = railA(x), xb = railB(x);
    // レール（コンクリートの梁と、鋼のレール）
    for (const rx of [xa, xb]) {
      mb.ground(rx - 0.6, yard0, rx + 0.6, gateZ - 0.5, 0.085, C(0xa8a39a));
      mb.ground(rx - 0.12, yard0, rx + 0.12, gateZ - 0.5, 0.11, C(0x5d6369));
    }
    // 海側の受け渡し：アスファルトに AGV の枠、区画の名前、ゼブラ
    mb.ground(x - 0.4, yard0, x + bw + 0.4, stack0 - 0.6, 0.092, darkAs);
    for (let k = 0; k <= 5; k++) mb.ground(x + k * 4 - 0.08, yard0 + 0.4, x + k * 4 + 0.08, stack0 - 1.2, 0.1, paint);
    ctHatch(mb, x - 0.3, stack0 - 1.4, x + bw + 0.3, stack0 - 0.1, 0.1, yPaint, 1.2, 0.4);
    const name = (bi + 1 < 10 ? '0' : '') + (bi + 1);
    ctText(mb, name, x + bw / 2 - 2.6, stack0 - 2.2, Math.min(4, tzD * 0.3), 0.1, paint);
    for (let k = 0; k < 5; k++) {
      if (rng.next() < 0.3) ctAgv(mb, x + k * 4 + 2, yard0 + tzD / 2 - 0.4, true, rng.next() < 0.6 ? lineCol() : null);
      else if (rng.next() < 0.4) ctBlob(mb, rng, x + k * 4 + 2, yard0 + 2 + rng.next() * (tzD - 4), 0.5 + rng.next() * 0.6, 0.097, C(0x2c2e31));
    }
    // 陸側の受け渡し：トラックの枠（コンテナの車が後ろから入る）
    for (let k = 0; k <= 5; k++) mb.ground(x + k * 4 - 0.08, yard1 + 1.2, x + k * 4 + 0.08, gateZ - 0.6, 0.1, paint);
    ctHatch(mb, x - 0.3, yard1 + 0.1, x + bw + 0.3, yard1 + 1.2, 0.1, yPaint, 1.2, 0.4);
    if (ltzD >= 12.6) for (let k = 0; k < 5; k++) {
      const p = rng.next();
      if (p < 0.45) continue;
      // シャーシは z の向き（後ろが区画の側）。トラクターの頭はゲートの側
      ctTurned(mb, () => ctChassis(mb, yard1 + 0.4, -(x + k * 4 + 2), p < 0.8 ? lineCol() : null, p > 0.6 ? rng.pick([C(0xe9eae6), C(0x2e6da4), C(0xc0392b)]) : null));
      ctBlob(mb, rng, x + k * 4 + 2, yard1 + 3, 0.5, 0.097, C(0x7d786f));
    }
    // コンテナの置き場：白い枠
    for (let r = 0; r <= nr; r++) mb.ground(x + r * pitchW - 0.11, stack0 - 0.1, x + r * pitchW - 0.01, yard1 + 0.1, 0.1, paint);
    // 積むところの長さを 40 フィート（12.2m）と 20 フィート（6.06m）に分ける
    const bays: [number, number][] = [];
    for (let z = stack0; ; ) {
      if (z + 12.2 <= yard1) { bays.push([z, 12.2]); z += 12.3; } else if (z + 6.06 <= yard1) { bays.push([z, 6.06]); z += 6.16; } else break;
    }
    for (const [z] of bays) mb.ground(x - 0.4, z - 0.11, x + bw + 0.4, z - 0.01, 0.1, paint);
    // ARMG の通るところの汚れ
    for (const rx of [xa, xb]) for (let k = 0; k < 3; k++) ctBlob(mb, rng, rx + (rng.next() - 0.5) * 1.2, stack0 + rng.next() * stackL, 0.35 + rng.next() * 0.4, 0.097, C(0x8a857b));
    const base = 3 + rng.int(2);
    if (bi === reeferIdx && stackL >= 26.4) {
      // 冷凍コンテナの区画：まん中に横切る電源ラック、両側から冷凍機の端を向けて並べる
      const zr = stack0 + 13.2, tiers = 3;
      ctReeferRack(mb, zr, x - 0.4, x + bw + 0.4, tiers, false);
      for (let r = 0; r < nr; r++) {
        const rx = x + r * pitchW;
        for (const [z0, end] of [[stack0, 1], [stack0 + 14.2, -1]] as [number, number][]) {
          if (rng.next() < 0.1) continue;
          const n = 1 + rng.int(tiers);
          for (let lv = 0; lv < n; lv++) {
            ctReefer(mb, rng, rx, lv * 2.6, z0, rx + 2.44, z0 + 12.2, end, true);
            const ze = end > 0 ? z0 + 12.3 : z0 - 0.1, zc = zr - end * 0.85;
            strut(mb, [rx + 1.9, lv * 2.6 + 1.9, ze], [rx + 1.6, lv * 2.6 + 2.45, zc], 0.035, C(0x1d1f22));
          }
        }
      }
      for (let z = stack0 + 26.5; z + 12.2 <= yard1; z += 12.3) for (let r = 0; r < nr; r++) {
        const n = 1 + rng.int(base);
        for (let lv = 0; lv < n; lv++) ctBox(mb, x + r * pitchW, lv * 2.6, z, x + r * pitchW + 2.44, z + 12.2, lineCol());
      }
    } else {
      const special = bi === specialIdx;
      for (let r = 0; r < nr; r++) {
        const rx = x + r * pitchW;
        for (const [z0, l] of bays) {
          const p = rng.next();
          if (p < 0.08) continue; // 空いた置き場
          const t = Math.max(1, Math.min(5, base + rng.int(3) - 1 - (r === 0 || r === nr - 1 ? 1 : 0)));
          if (special && p < 0.6) {
            if (p < 0.35) {
              // タンクコンテナ（20 フィート）
              const fr = rng.pick([C(0x2b4f7a), C(0xd2691e), C(0x3a3d42), C(0x4c7a3b)]);
              const tank = rng.next() < 0.6 ? C(0xc9ccce) : C(0xeeeeea);
              for (let hz = 0; hz + 6.06 <= l + 0.01; hz += 6.14) {
                const n = 1 + rng.int(2);
                for (let lv = 0; lv < n; lv++) ctTurned(mb, () => ctTank(mb, z0 + hz, lv * 2.6, -(rx + 2.44), fr, tank));
              }
            } else {
              const c = lineCol(), kind = rng.int(4);
              if (kind === 0) for (let lv = 0; lv < 4; lv++) ctBox(mb, rx, lv * 0.62, z0, rx + 2.44, z0 + l, c, 0.58); // たたんだラックの山
              else ctTurned(mb, () => ctFlatRack(mb, z0, 0, -(rx + 2.44), l, c, kind));
            }
            continue;
          }
          if (l > 7 && p < 0.3) {
            // 20 フィートを 2 つ
            for (const hz of [0, 6.14]) {
              const n = Math.max(0, t - rng.int(3));
              for (let lv = 0; lv < n; lv++) ctBox(mb, rx, lv * 2.6, z0 + hz, rx + 2.44, z0 + hz + 6.06, lineCol());
            }
          } else {
            for (let lv = 0; lv < t; lv++) {
              const hc = rng.next() < 0.3 && lv === t - 1; // 背の高いハイキューブ
              ctBox(mb, rx, lv * 2.6, z0, rx + 2.44, z0 + l, rng.next() < 0.35 ? ctCol(rng, lineBase[(r + bi) % 3]) : lineCol(), hc ? 2.8 : 2.5);
            }
          }
        }
      }
    }
    // ARMG：海側と陸側に 1 基ずつ（受け渡しの場所の上か、積むところの上）
    const armgH = 19;
    const zs = [stack0 + 2 + rng.next() * Math.max(0, Math.min(6, stackL - 6)), yard1 - 2 - rng.next() * Math.max(0, Math.min(6, stackL - 6))];
    if (stackL < 20) zs.length = 1;
    for (const [k, cz] of zs.entries()) {
      const tx = x + 1.2 + (rng.int(nr)) * pitchW + 0.0;
      const busy = rng.next() < 0.6;
      ctArmg(mb, xa, xb, k === 0 ? Math.min(cz, stack0 + 6) - (busy ? 4 : 0) : cz, armgH, tx, busy ? 9 + rng.next() * 6 : armgH - 3, busy ? lineCol() : null);
    }
  });
  // 区画の間の照明塔（海側と陸側）
  for (let i = 0; i + 1 < blocks.length; i++) {
    const lx = (railB(blocks[i]) + railA(blocks[i + 1])) / 2;
    for (const z of [yard0 + 2.5, Math.min(gateZ - 2.5, yard1 + ltzD * 0.5)]) {
      ctMast(mb, lx, z, 32);
      ctHatch(mb, lx - 1.3, z - 1.8, lx + 1.3, z + 1.8, 0.1, yPaint, 1.0, 0.35);
    }
  }

  // ---- 西の端：空コンテナの高い山（5〜6 段）とリーチスタッカー ----
  const dRows = Math.max(2, Math.floor((depotX1 - 13 - (-hw + 3)) / pitchW));
  const dz0 = yard0 + 2, dz1 = hd - 32;
  const dLine = [rng.pick(CT_LINES), rng.pick(CT_LINES)];
  for (let z = dz0; z + 12.2 <= dz1; z += 12.6) {
    const lc = dLine[Math.floor((z - dz0) / 12.6) & 1];
    for (let r = 0; r < dRows; r++) {
      if (rng.next() < 0.08) continue;
      const rx = -hw + 3 + r * pitchW, t = 6 - rng.int(2) - (r === dRows - 1 ? rng.int(3) : 0);
      for (let lv = 0; lv < t; lv++) ctBox(mb, rx, lv * 2.6, z, rx + 2.44, z + 12.2, ctCol(rng, rng.next() < 0.82 ? lc : rng.pick(CT_LINES)));
    }
    mb.ground(-hw + 2.6, z - 0.11, -hw + 3 + dRows * pitchW, z - 0.01, 0.1, paint);
  }
  const xe = -hw + 3 + dRows * pitchW;
  reachStacker(mb, xe + 8.2, dz0 + 9, -1, C(0xd9472b), rng.next() < 0.6 ? ctCol(rng, dLine[0]) : null);
  ctHatch(mb, xe + 0.8, dz0 - 1, depotX1, dz0 + 1, 0.1, yPaint, 1.4, 0.45);
  for (let k = 0; k < 8; k++) ctBlob(mb, rng, xe + 2 + rng.next() * (depotX1 - xe - 3), dz0 + rng.next() * (dz1 - dz0), 0.5 + rng.next() * 0.8, 0.097, C(0x7d786f));
  ctMast(mb, depotX1 - 1, dz1 - 2, 32);
  ctHut(mb, -hw + 2.8, (apronEnd + yard0) / 2, 2.4, 4.6, C(0x2e6da4));
  // まわりのフェンス（両側）
  for (const s of [-1, 1]) ctFence(mb, s * (hw - 0.6), apronEnd + 2, s * (hw - 0.6), hd - 1.5);

  // ---- 管理棟（屋上に太陽光パネル）、ゲート（道路側）----
  const adX1 = Math.min(-hw + 34, depotX1 - 2);
  mBlock(mb, -hw + 6, hd - 30, adX1, hd - 8, 14, { pat: PAT.ribbon });
  mb.box(-hw + 18, 14.7, hd - 22, -hw + 22, 30, hd - 18, white, PAT.none, white); // 管制塔の軸
  mb.box(-hw + 15, 30, hd - 25, -hw + 25, 35, hd - 15, C(0x5f8fb8), PAT.fullglass, white);
  ctSolar(mb, -hw + 7.5, hd - 28.5, -hw + 14, hd - 9.5, 14.1);
  if (adX1 - 1.5 > -hw + 27) ctSolar(mb, -hw + 27, hd - 28.5, adX1 - 1.5, hd - 9.5, 14.1);
  // ゲート：トラックのレーンと、太陽光パネルの屋根、詰所
  const gx0 = Math.max(depotX1 + 6, -hw + 44), gx1 = hw - 8;
  mb.ground(gx0, gateZ, gx1, hd - 1, 0.1, asph);
  const gm = (gateZ + hd) / 2; // ゲートのまん中
  for (let x = gx0 + 6; x < gx1 - 2; x += 8) {
    mb.ground(x - 0.1, gateZ + 2, x + 0.1, hd - 3, 0.12, white);
    mb.box(x - 1.2, 0, gm - 1.5, x + 1.2, 3, gm + 1.5, C(0xf2f3f4), PAT.office, C(0x9aa1a7));
    ctBlob(mb, rng, x + 4 + (rng.next() - 0.5), gm + (rng.next() - 0.5) * (gateD - 6), 0.6 + rng.next() * 0.6, 0.11, C(0x303235));
    mb.ground(x + 1.2, gateZ + 2.2, x + 6.8, gateZ + 2.6, 0.12, white); // 停止線
  }
  const cz0 = gm - Math.min(5.5, gateD * 0.3), cz1 = gm + Math.min(5.5, gateD * 0.3);
  mb.box(gx0, 7, cz0, gx1, 7.8, cz1, white, PAT.none, C(0xd5d9dd));
  ctSolar(mb, gx0 + 0.5, cz0 + 0.3, gx1 - 0.5, cz1 - 0.3, 7.8);
  for (let x = gx0 + 2; x < gx1; x += 16) mb.box(x - 0.3, 0, gm - 0.3, x + 0.3, 7, gm + 0.3, C(0x9aa1a7));
  tf(-hw + 3, hd - 3, 0.9);
  tf(hw - 3, hd - 3, 0.9);
}

// ---- 農地の畑（農家の区画の空いたマス全部）----
// 畑の種類：0 = 麦、1 = 野菜、2 = 水田、3 = 牧草地（牛）、4 = 果樹園。農家ごとに決まり、畝の向きも農家ごと
export const FARM_KINDS = ['麦畑', '野菜畑', '水田', '牧草地', '果樹園'] as const;
export function farmFields(mb: MeshBuilder, g: Grid, b: Building, cells: number[], trees: TreeSpot[]) {
  const n = g.n;
  const kind = (b.seed >>> 4) % 5;
  const alongX = ((b.seed >>> 8) & 1) === 0;
  mb.setTransform(0, 0, 0, 0);
  const keep = mb.matOverride;
  mb.matOverride = MAT.ground;
  const H = (x: number, z: number) => g.groundAt(x, z) + 0.09;
  // 畝の帯（世界座標で続くので、隣のマスとつながる）
  const strip = (x0: number, z0: number, x1: number, z1: number, c: THREE.Color, dy = 0) =>
    mb.quad([x0, H(x0, z1) + dy, z1], [x1, H(x1, z1) + dy, z1], [x1, H(x1, z0) + dy, z0], [x0, H(x0, z0) + dy, z0], c);
  const wheat = [C(0xd8b55a), C(0xcda64c)], veg = [C(0x5f9a3c), C(0x4c8a34), C(0x7a5a3a)];
  const paddy = C(0x6f9f86), levee = C(0xa89a70), grass = C(0x82b04e), grass2 = C(0x76a447);
  const hsh = (a: number, c: number) => { let h = Math.imul(a, 374761393) ^ Math.imul(c, 668265263) ^ b.seed; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  for (const c of cells) {
    const cx = c % n, cy = (c / n) | 0;
    if (g.isWater(cx, cy)) continue;
    const X0 = cx * CELL, Z0 = cy * CELL, X1 = X0 + CELL, Z1 = Z0 + CELL;
    const band = (w: number, cols: THREE.Color[]) => {
      for (let t = 0; t < CELL; t += w) {
        const k = Math.floor(((alongX ? Z0 : X0) + t) / w) % cols.length;
        if (alongX) strip(X0, Z0 + t, X1, Z0 + Math.min(CELL, t + w), cols[k]);
        else strip(X0 + t, Z0, X0 + Math.min(CELL, t + w), Z1, cols[k]);
      }
    };
    // 区画（8×8）の境目に、あぜ道（隣の農家との境）
    const path = C(0xa58f68), pw = 1.1;
    if (cx % 8 === 0) strip(X0, Z0, X0 + pw, Z1, path, 0.02);
    if (cy % 8 === 0) strip(X0, Z0, X1, Z0 + pw, path, 0.02);
    if (kind === 0) band(2, wheat);
    else if (kind === 1) band(1.6, veg);
    else if (kind === 2) {
      // 水田：あぜ道で区切った水面
      strip(X0, Z0, X1, Z1, levee);
      strip(X0 + 0.6, Z0 + 0.6, X1 - 0.6, Z1 - 0.6, paddy, 0.03);
    } else if (kind === 3) {
      band(4, [grass, grass2]);
      // 牛（白黒のかたまり）
      for (let k = 0; k < 2; k++) {
        if (hsh(c, k) > 0.45) continue;
        const x = X0 + 3 + hsh(c, k + 7) * 10, z = Z0 + 3 + hsh(c, k + 11) * 10, y = H(x, z);
        const col = hsh(c, k + 3) < 0.5 ? C(0xf2f0ea) : C(0x3a2e28);
        if (alongX) mb.box(x - 1.1, y, z - 0.4, x + 1.1, y + 1.3, z + 0.4, col);
        else mb.box(x - 0.4, y, z - 1.1, x + 0.4, y + 1.3, z + 1.1, col);
      }
    } else {
      // 果樹園：草地に、まっすぐな列の低い木
      strip(X0, Z0, X1, Z1, grass2);
      for (let a = 2.5; a < CELL; a += 5) for (let d = 2.5; d < CELL; d += 5) {
        const x = X0 + (alongX ? a : d), z = Z0 + (alongX ? d : a);
        trees.push({ x, y: g.groundAt(x, z), z, s: 0.55 + hsh(Math.round(x), Math.round(z)) * 0.15, kind: 0 });
      }
    }
  }
  mb.matOverride = keep;
}
