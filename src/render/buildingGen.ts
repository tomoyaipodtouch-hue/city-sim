// 建物の自動生成（アメリカの都市風）
import * as THREE from 'three';
import { MAT } from './textures';
import { MeshBuilder, PAT } from './builder';
import { Rng } from '../sim/rng';
import { CELL } from '../sim/constants';
import type { Building } from '../sim/world';
import type { Grid } from '../sim/grid';
import { BState } from '../sim/world';

export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  s: number;
  kind: number; // 0=広葉樹, 1=針葉樹
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

export function generateBuilding(mb: MeshBuilder, b: Building, f: LotFrame, trees: TreeSpot[], isCpark: (x: number, y: number) => boolean = () => false) {
  const rng = new Rng(b.seed);
  curRoof = FLAT_ROOFS[b.seed % FLAT_ROOFS.length];
  // 外壁のデザイン（建物ごとに選ぶ）：全面ガラス・横長の連続窓・ふつうの窓、縦ルーバーの有無、マンションのバルコニー
  const fr = ((b.seed >>> 5) % 100) / 100;
  officePat = fr < 0.35 ? PAT.curtain : fr < 0.65 ? PAT.fullglass : fr < 0.92 ? PAT.ribbon : PAT.office;
  louvers = ((b.seed >>> 9) % 100) < 35;
  resPat = ((b.seed >>> 12) % 100) < 80 ? PAT.balcony : PAT.apartment;
  mb.flatRoofMat = (b.seed >> 3) % 3 === 0 ? MAT.gravel : MAT.membrane;
  // 工場・発電所などの斜めの屋根は金属
  mb.slopeRoofMat = b.civic || b.type === 'ID' || b.type === 'IM' || b.type === 'IH' ? MAT.metal : MAT.shingle;
  mb.abandoned = b.state === BState.Abandoned;
  const tf = (lx: number, lz: number, s = 1, kind = 0, ly = 0) => {
    // ローカル座標から世界座標へ（MeshBuilder と同じ変換）
    const a = b.face === 0 ? -Math.PI / 2 : b.face === 4 ? Math.PI / 2 : b.face === 6 ? Math.PI : 0;
    const cos = Math.cos(a), sin = Math.sin(a);
    const cx = (b.x + b.w / 2) * CELL, cz = (b.y + b.h / 2) * CELL;
    trees.push({ x: lx * cos - lz * sin + cx, y: f.base + ly, z: lx * sin + lz * cos + cz, s, kind });
  };
  if (b.state === BState.Building) {
    construction(mb, f, rng);
    mb.abandoned = false;
    return;
  }
  const dense = b.den > 0 && b.floors > 0;
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
      if (dense) shopMid(mb, f, rng, tf, b.floors, b.type === 'CS3');
      else lowShop(mb, f, rng, tf, b.type === 'CS1' ? 1 : b.type === 'CS2' ? 2 : 3);
      break;
    case 'CO2': case 'CO3':
      highrise(mb, f, rng, tf, Math.max(3, b.floors), true, b.type === 'CO3');
      break;
    case 'IA': farm(mb, f, rng, tf); break;
    case 'ID': if (rng.next() < 0.45) chemicalPlant(mb, f, rng, b.den); else factory(mb, f, rng, true, b.den); break;
    case 'IM': if (rng.next() < 0.5) warehouse(mb, f, rng, b.den); else factory(mb, f, rng, false, b.den); break;
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
    case 'garden': pondGarden(mb, f, rng, tf); break;
    case 'cpark_a': case 'cpark_b': centralPark(mb, b, f, trees, isCpark); break;
    case 'busstop': busStop(mb, f); break;
    case 'station': station(mb, f, 0); break;
    case 'el_station': station(mb, f, 8); break;
    case 'mono_station': station(mb, f, 11); break;
    case 'sub_station': subwayEntrance(mb, f); break;
    case 'ferry_p': ferryTerminal(mb, f, false); break;
    case 'ferry_c': ferryTerminal(mb, f, true); break;
    case 'seaport': seaport(mb, f, rng); break;
    case 'airport_s': airport(mb, f, rng, 1, tf); break;
    case 'airport_l': airport(mb, f, rng, 2, tf); break;
    case 'freight_st': freightStation(mb, f, rng); break;
    case 'police_s': modernPolice(mb, f, tf, false); break;
    case 'police_l': modernPolice(mb, f, tf, true); break;
    case 'fire_s': modernFire(mb, f, tf, false); break;
    case 'fire_l': modernFire(mb, f, tf, true); break;
    case 'clinic': modernClinic(mb, f, tf); break;
    case 'hospital': modernHospital(mb, f, tf); break;
    case 'school_e': modernSchool(mb, f, tf, false); break;
    case 'school_h': modernSchool(mb, f, tf, true); break;
    case 'college': modernCollege(mb, f, tf); break;
    case 'library': modernLibrary(mb, f, tf); break;
    case 'landfill': landfill(mb, f, rng); break;
    case 'incinerator': incinerator(mb, f, tf, false); break;
    case 'incinerator_l': incinerator(mb, f, tf, true); break;
    case 'water_plant': waterPlant(mb, f, tf); break;
    case 'desal': desalPlant(mb, f, tf); break;
    case 'recycling': recycling(mb, f, rng); break;
    case 'mayor_house': mansion(mb, f, rng, tf); break;
    case 'city_hall': cityHall(mb, f, tf); break;
    case 'statue': statue(mb, f, tf); break;
    case 'museum': modernMuseum(mb, f, tf); break;
    case 'stadium': stadium(mb, f, rng); break;
    case 'future_stadium': futureStadium(mb, f); break;
  }
  mb.abandoned = false;
}

type TF = (lx: number, lz: number, s?: number, kind?: number, y?: number) => void;

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

// 屋上の設備（空調の室外機、換気口、天窓）
function roofUnits(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, rng: Rng, n: number) {
  const unit = C(0xb9bdc2), fan = C(0x3a3d42);
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

// ---------------- 工場の種類 ----------------
// 倉庫・物流センター：大きな箱、トラックの搬入口が並ぶ、コンテナ
function warehouse(mb: MeshBuilder, f: LotFrame, rng: Rng, den: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.concrete);
  const wall = rng.pick([C(0xcfd3d6), C(0xb9c2c9), C(0xd8d2c4), C(0x9fb0bc)]);
  const w = f.W - 4, d = f.D * 0.55;
  const z0 = -f.D / 2 + 2, z1 = z0 + d, h = 10 + den * 3;
  mb.box(-w / 2, 0, z0, w / 2, h, z1, wall, PAT.industrial, flatRoof());
  roofRim(mb, -w / 2, z0, w / 2, z1, h, wall, 0.6);
  // 帯（会社の色）と事務所の角
  const accent = rng.pick(PALETTE.accent);
  mb.box(-w / 2 - 0.05, h - 1.6, z1, w / 2 + 0.05, h - 0.9, z1 + 0.1, accent);
  mb.box(-w / 2, 0, z1, -w / 2 + 10, 7, z1 + 0.6, PALETTE.glass, PAT.office, wall);
  // 搬入口（シャッター、ひさし、止まっているトラック）
  for (let x = -w / 2 + 12; x < w / 2 - 3; x += 4.2) {
    mb.box(x, 0.0, z1, x + 3, 3.8, z1 + 0.12, C(0x6b7178));
    if (rng.next() < 0.45) {
      mb.box(x + 0.25, 0, z1 + 0.5, x + 2.75, 3.8, z1 + 10, PALETTE.white);
      mb.box(x + 0.35, 0, z1 + 10, x + 2.65, 3.1, z1 + 12.5, rng.pick(PALETTE.accent));
    }
  }
  mb.box(-w / 2 + 11, 4.2, z1, w / 2 - 2, 4.5, z1 + 2, PALETTE.steel);
  // 天窓の列
  for (let x = -w / 2 + 3; x < w / 2 - 3; x += 7) mb.box(x, h, z0 + 3, x + 1.4, h + 0.35, z1 - 3, PALETTE.glass);
  // コンテナ
  const cont = [0xb5452f, 0x2f6fb5, 0x3f8f4a, 0xd9a227, 0x7a7f86].map(C);
  for (let k = 0; k < 4; k++) {
    const x = -f.W / 2 + 3 + k * 3;
    for (let lv = 0; lv < 1 + rng.int(3); lv++) mb.box(x, lv * 2.6, f.D / 2 - 14, x + 2.4, lv * 2.6 + 2.55, f.D / 2 - 2, rng.pick(cont), PAT.industrial, rng.pick(cont));
  }
}

// 化学工場：タンク群、配管、蒸留塔、紅白の煙突
function chemicalPlant(mb: MeshBuilder, f: LotFrame, rng: Rng, den: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.concrete);
  const wall = rng.pick(PALETTE.indWall);
  const s = 1 + den * 0.3;
  // 制御棟
  mb.box(-f.W / 2 + 2, 0, f.D / 2 - 12, -f.W / 2 + 14, 8, f.D / 2 - 3, wall, PAT.industrial, flatRoof());
  roofRim(mb, -f.W / 2 + 2, f.D / 2 - 12, -f.W / 2 + 14, f.D / 2 - 3, 8, wall, 0.5);
  // 球形のタンクに見える丸いタンクと、円筒のタンク
  const tanks = Math.max(2, Math.floor((f.W - 18) / 9));
  for (let k = 0; k < tanks; k++) {
    const x = -f.W / 2 + 20 + k * 9, z = f.D / 2 - 8;
    mb.cylinder(x, z, 0, 7 * s, 3.6, 16, PALETTE.white, PALETTE.white);
    mb.cylinder(x, z, 7 * s, 7.8 * s, 3.6, 16, PALETTE.white, PALETTE.white, 2.2);
    mb.cylinder(x, z, 0, 0.8, 4.2, 16, PALETTE.concrete, PALETTE.concrete);
  }
  // 蒸留塔（細く高い塔）と足場
  for (let k = 0; k < 2 + rng.int(2); k++) {
    const x = -f.W / 2 + 6 + k * 5, z = -f.D / 2 + 8;
    const th = (18 + rng.next() * 10) * s;
    mb.cylinder(x, z, 0, th, 1.3, 12, C(0xc9ccd0), PALETTE.steel);
    for (let y = 4; y < th; y += 5) mb.cylinder(x, z, y, y + 0.25, 1.9, 12, PALETTE.steel, PALETTE.steel);
  }
  // 配管の橋
  for (const z of [-f.D / 2 + 13, -f.D / 2 + 13.8]) mb.box(-f.W / 2 + 4, 5, z - 0.25, f.W / 2 - 4, 5.5, z + 0.25, PALETTE.steel);
  for (let x = -f.W / 2 + 5; x < f.W / 2 - 4; x += 6) mb.box(x - 0.2, 0, -f.D / 2 + 12.8, x + 0.2, 5, -f.D / 2 + 14, PALETTE.steel);
  // 紅白の煙突
  const cx = f.W / 2 - 6, cz = -f.D / 2 + 6, ch = (30 + rng.next() * 12) * s;
  const bands = 6;
  for (let k = 0; k < bands; k++) mb.cylinder(cx, cz, (ch * k) / bands, (ch * (k + 1)) / bands, 1.6 - k * 0.1, 12, k % 2 ? PALETTE.white : C(0xc0392b), k === bands - 1 ? PALETTE.dark : undefined, 1.6 - (k + 1) * 0.1);
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

function factory(mb: MeshBuilder, f: LotFrame, rng: Rng, dirty: boolean, den = 0) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.concrete);
  const wall = rng.pick(PALETTE.indWall);
  const w = f.W - 6, d = f.D - 12;
  const x0 = -w / 2, x1 = w / 2, z0 = -f.D / 2 + 3, z1 = z0 + d;
  const h = (8 + rng.next() * 5) * (1 + den * 0.35);
  mb.box(x0, 0, z0, x1, h, z1, wall, dirty ? PAT.industrial : PAT.dock, PALETTE.steel);
  if (dirty) {
    // のこぎり屋根
    const teeth = Math.max(2, Math.floor(w / 6));
    const tw = w / teeth;
    for (let k = 0; k < teeth; k++) {
      const a = x0 + k * tw;
      // 両端の三角の壁
      mb.tri([a, h, z1], [a + tw, h, z1], [a + tw, h + 3, z1], wall);
      mb.tri([a + tw, h, z0], [a, h, z0], [a + tw, h + 3, z0], wall);
      mb.quad([a, h, z0], [a, h, z1], [a + tw, h + 3, z1], [a + tw, h + 3, z0], PALETTE.roof[3]);
      mb.quad([a + tw, h, z1], [a + tw, h, z0], [a + tw, h + 3, z0], [a + tw, h + 3, z1], PALETTE.glass);
    }
    // 煙突
    const n = 1 + rng.int(2);
    for (let k = 0; k < n; k++) {
      const cx = x0 + 3 + k * 5, cz = z0 + 3;
      mb.cylinder(cx, cz, h, h + 14 + rng.next() * 8, 1.1, 8, PALETTE.brick, PALETTE.dark, 0.8);
    }
    // タンク
    if (f.W >= 32) {
      mb.cylinder(x1 - 4, z1 + 4.5, 0, 6, 3, 12, PALETTE.white, PALETTE.white);
    }
    // 資材の山
    mb.hip(x0 + 1, z1 + 2, x0 + 7, z1 + 6, 0, 2, PALETTE.dirt, 0);
  } else {
    // 事務所棟と搬入口
    mb.box(x0, 0, z1, x0 + Math.min(12, w / 2), 7, z1 + 5, PALETTE.white, PAT.office, flatRoof());
    roofUnits(mb, x0, z0, x1, z1, h, rng, 3 + rng.int(3));
    stalls(mb, rng, x0 + 14, x1 - 3, 3, z1 + 1, z1 + 5.5, 0.55);
  }
  // トラック
  if (rng.next() < 0.7) {
    const tx = x1 - 8;
    mb.box(tx, 0, z1 + 1, tx + 2.5, 3.6, z1 + 9, PALETTE.white);
    mb.box(tx, 0, z1 + 9, tx + 2.5, 3, z1 + 11, rng.pick(PALETTE.accent));
  }
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
const cpLake = (x: number, z: number) => Math.sin(x / 61 + 1.3) * Math.sin(z / 47 + 0.4) + 0.45 * Math.sin((x - z) / 33);
const cpMeadow = (x: number, z: number) => Math.sin(x / 83 + 2.1) * Math.sin(z / 71 + 1.7);
const LAKE_T = 0.95;
function centralPark(mb: MeshBuilder, b: Building, f: LotFrame, trees: TreeSpot[], isCpark: (x: number, y: number) => boolean) {
  // 世界座標で描く
  mb.setTransform(0, 0, f.base, 0);
  const X0 = b.x * CELL, Z0 = b.y * CELL, X1 = (b.x + b.w) * CELL, Z1 = (b.y + b.h) * CELL;
  const tree = (x: number, z: number, s: number, kind = 0) => trees.push({ x, y: f.base, z, s, kind });
  const lake = (x: number, z: number) => cpLake(x, z) > LAKE_T;
  // 芝生（広い芝生広場は明るい色）
  const S = 4;
  for (let z = Z0; z < Z1; z += S)
    for (let x = X0; x < X1; x += S) {
      const cx = x + S / 2, cz = z + S / 2, v = cpLake(cx, cz);
      const col = v > LAKE_T ? PALETTE.water : v > LAKE_T - 0.08 ? C(0xb7ab92) : cpMeadow(cx, cz) > 0.55 ? PALETTE.lawn : PALETTE.lawn2;
      mb.ground(x + (x === X0 ? 0.1 : 0), z + (z === Z0 ? 0.1 : 0), x + S - (x + S >= X1 ? 0.1 : 0), z + S - (z + S >= Z1 ? 0.1 : 0), v > LAKE_T ? 0.06 : 0.08, col);
    }
  // 小道：3マスおきに東西・南北へ、ゆるく曲がりながら続く
  const pathCol = C(0xc8b896), PW = 1.6, step = 2;
  const onPath = (x: number, z: number) => {
    for (let j = Math.floor(z / (3 * CELL)) - 1; j <= Math.floor(z / (3 * CELL)) + 1; j++) if (Math.abs(z - ((3 * j + 1.5) * CELL + 9 * Math.sin(x / 41 + j * 1.9))) < PW + 1.5) return true;
    for (let i = Math.floor(x / (3 * CELL)) - 1; i <= Math.floor(x / (3 * CELL)) + 1; i++) if (Math.abs(x - ((3 * i + 1.5) * CELL + 9 * Math.sin(z / 37 + i * 2.3))) < PW + 1.5) return true;
    return false;
  };
  const seg = (x: number, z: number, horiz: boolean) => {
    if (x < X0 || x > X1 || z < Z0 || z > Z1 || lake(x, z)) return;
    const x0 = Math.max(X0, horiz ? x - step / 2 - 0.3 : x - PW), x1 = Math.min(X1, horiz ? x + step / 2 + 0.3 : x + PW);
    const z0 = Math.max(Z0, horiz ? z - PW : z - step / 2 - 0.3), z1 = Math.min(Z1, horiz ? z + PW : z + step / 2 + 0.3);
    if (x1 > x0 && z1 > z0) mb.ground(x0, z0, x1, z1, 0.11, pathCol);
    // ベンチと街灯
    const h = cpHash(Math.round(x / step), Math.round(z / step) * 7 + (horiz ? 1 : 2));
    if (h < 0.035) {
      const o = PW + 0.7;
      if (horiz) mb.box(x - 0.9, 0, z + o - 0.25, x + 0.9, 0.5, z + o + 0.25, PALETTE.wood);
      else mb.box(x + o - 0.25, 0, z - 0.9, x + o + 0.25, 0.5, z + 0.9, PALETTE.wood);
    } else if (h > 0.97) {
      const lx = horiz ? x : x - PW - 0.6, lz = horiz ? z - PW - 0.6 : z;
      mb.box(lx - 0.08, 0, lz - 0.08, lx + 0.08, 3.6, lz + 0.08, PALETTE.dark);
      mb.box(lx - 0.25, 3.6, lz - 0.25, lx + 0.25, 3.9, lz + 0.25, PALETTE.white);
    }
  };
  for (let j = Math.floor(Z0 / (3 * CELL)) - 1; j <= Math.ceil(Z1 / (3 * CELL)); j++)
    for (let x = Math.floor(X0 / step) * step + step / 2; x < X1; x += step) seg(x, (3 * j + 1.5) * CELL + 9 * Math.sin(x / 41 + j * 1.9), true);
  for (let i = Math.floor(X0 / (3 * CELL)) - 1; i <= Math.ceil(X1 / (3 * CELL)); i++)
    for (let z = Math.floor(Z0 / step) * step + step / 2; z < Z1; z += step) seg((3 * i + 1.5) * CELL + 9 * Math.sin(z / 37 + i * 2.3), z, false);
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
  // 木立：芝生広場・池・小道を避けて、ところどころ森のように
  for (let z = Z0 + 2; z < Z1 - 1; z += 4)
    for (let x = X0 + 2; x < X1 - 1; x += 4) {
      const h = cpHash(x, z);
      const tx = x + (cpHash(z, x) - 0.5) * 2.4, tz = z + (h - 0.5) * 2.4;
      if (tx < X0 + 3.5 || tx > X1 - 3.5 || tz < Z0 + 3.5 || tz > Z1 - 3.5) continue;
      if (cpLake(tx, tz) > LAKE_T - 0.14 || onPath(tx, tz)) continue;
      const m = cpMeadow(tx, tz);
      const dens = m > 0.45 ? 0.04 : 0.3 + 0.35 * Math.max(0, -m);
      if (h < dens) tree(tx, tz, 0.85 + cpHash(x + 3, z) * 0.6, cpHash(x, z + 9) < 0.25 ? 1 : 0);
    }
}

// 池のある庭園（2×3）：池、太鼓橋、東屋、灯籠、飛び石
function pondGarden(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  const L = longAxis(mb, f, tf);
  const A = L.A / 2, Cw = L.Cw / 2;
  L.ground(-A + 0.2, -Cw + 0.2, A - 0.2, Cw - 0.2, 0.08, C(0x6f9a4c));
  // 池（いくつかの板を重ねて、まるみのある形に）
  const water = PALETTE.water, shore = C(0xb7ab92);
  const pond: [number, number, number, number][] = [[-14, -9, 6, 3], [-17, -6, -11, 1], [2, -7, 9, -1], [-10, 3, -2, 6]];
  for (const [a0, c0, a1, c1] of pond) L.ground(a0 - 0.8, c0 - 0.8, a1 + 0.8, c1 + 0.8, 0.1, shore);
  for (const [a0, c0, a1, c1] of pond) L.ground(a0, c0, a1, c1, 0.13, water);
  // 太鼓橋（朱色）
  const red = C(0xb8402e);
  const steps = 6;
  for (let k = 0; k < steps; k++) {
    const t = (k + 0.5) / steps;
    const h = 0.4 + Math.sin(t * Math.PI) * 1.4;
    L.box(-4.5 + k * 1.1, h - 0.2, -4.4, -4.5 + (k + 1) * 1.1, h, -2.6, red);
  }
  for (const c of [-4.5, -2.5]) L.box(-4.5, 1.6, c - 0.06, 2.1, 1.75, c + 0.06, red);
  // 東屋
  L.box(A - 10, 0, Cw - 9, A - 4, 0.4, Cw - 3, PALETTE.wood);
  for (const [a, c] of [[A - 9.6, Cw - 8.6], [A - 4.4, Cw - 8.6], [A - 9.6, Cw - 3.4], [A - 4.4, Cw - 3.4]]) L.box(a - 0.15, 0.4, c - 0.15, a + 0.15, 2.8, c + 0.15, PALETTE.wood);
  {
    const alongX = f.W >= f.D;
    const [x0, z0] = alongX ? [A - 10.6, Cw - 9.6] : [Cw - 9.6, A - 10.6];
    const [x1, z1] = alongX ? [A - 3.4, Cw - 2.4] : [Cw - 2.4, A - 3.4];
    mb.hip(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), 2.8, 2.2, C(0x4a4d52), 0.3);
  }
  // 石灯籠と飛び石
  for (const [a, c] of [[8, 2], [-16, 5]]) {
    L.box(a - 0.3, 0, c - 0.3, a + 0.3, 0.9, c + 0.3, PALETTE.concrete);
    L.box(a - 0.5, 0.9, c - 0.5, a + 0.5, 1.4, c + 0.5, PALETTE.concrete);
    L.box(a - 0.6, 1.4, c - 0.6, a + 0.6, 1.6, c + 0.6, PALETTE.concrete);
  }
  for (let k = 0; k < 7; k++) L.ground(4 + k * 1.6, 3 + Math.sin(k) * 0.8, 4.9 + k * 1.6, 3.9 + Math.sin(k) * 0.8, 0.14, PALETTE.concrete);
  // 木（もみじ風の赤い木を少し）
  for (let k = 0; k < 16; k++) {
    const a = -A + 2 + rng.next() * (L.A - 4), c = -Cw + 2 + rng.next() * (L.Cw - 4);
    if (pond.some(([a0, c0, a1, c1]) => a > a0 - 2 && a < a1 + 2 && c > c0 - 2 && c < c1 + 2)) continue;
    if (a > A - 11 && c > Cw - 10) continue;
    L.tree(a, c, 0.7 + rng.next() * 0.6, rng.next() < 0.35 ? 1 : 0);
  }
  // 生け垣
  L.box(-A + 0.4, 0, -Cw + 0.4, A - 0.4, 1.1, -Cw + 1.2, PALETTE.hedge);
}

// ---------------- 中密度・高密度 ----------------
const APT_WALL = [0xb4624a, 0xc9b08c, 0xd9d2c3, 0x9b9a93, 0xa8735a, 0xe2d6bd, 0x8c8f94].map(C);
const TOWER_WALL = [0xd4d0c6, 0xb9b4a8, 0xe6e1d6, 0x9fa4a8, 0xc7b79c, 0xf0efeb, 0x6f767d, 0xdcdfe2].map(C);
// ガラスの色合い：青、緑、シルバー、ブロンズ、濃いグレー、青緑
// 青いガラスがビルらしく見えるので、約半分が青系になるように重ねて入れる
const GLASS = [0x4f7fae, 0x3f6f9a, 0x5a9a8e, 0x6f9aa0, 0xa8b4bf, 0x8f9aa6, 0x9a7a55, 0x7a6248, 0x3a4550, 0x4a5866, 0x4f8fa8, 0x6aa0c0, 0x3f6f9a, 0x4f7fae, 0x3f6f9a, 0x4f7fae, 0x45759f, 0x3a6896].map(C);

// 中層の集合住宅（3〜8階）
function apartments(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, kind: string) {
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
  for (const [x0, z0, x1, z1] of blocks) {
    mb.box(x0, 0, z0, x1, h, z1, wall, modernApt ? resPat : PAT.apartment, flatRoof());
    roofRim(mb, x0, z0, x1, z1, h, wall);
    roofUnits(mb, x0, z0, x1, z1, h, rng, 2 + rng.int(3));
  }
  // ベランダ（正面）
  const [bx0, , bx1, bz1] = blocks[0];
  const bal = rng.pick([PALETTE.concrete, PALETTE.white, PALETTE.steel]);
  if (!modernApt) for (let k = 1; k < floors; k++) mb.box(bx0 + 1, k * fh, bz1, bx1 - 1, k * fh + 0.18, bz1 + 1.0, bal);
  // 入口のひさし
  mb.box(-2, 2.8, bz1, 2, 3.1, bz1 + 2, kind === 'R3' ? PALETTE.dark : PALETTE.concrete);
  // 給水タンク
  if (!modernApt && rng.next() < 0.4) waterTank(mb, bx0 + 3, blocks[0][1] + 3, h, 1.4, rng);
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
  roofUnits(mb, -W / 2 + 0.7, z0 + 0.7, W / 2 - 0.7, z1 - 0.7, h, rng, 3 + rng.int(3));
  if (rng.next() < 0.5) tf(-f.W / 2 + 1.2, f.D / 2 - 1.0, 0.7);
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
  // 低層部（ポディウム）
  const podium = floors >= 8 ? 1 + rng.int(3) : 0;
  const PW = f.W - 2, PD = f.D - 3;
  const pz1 = f.D / 2 - 1.5;
  let y = 0;
  if (podium) {
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
  const round = office && luxury && rng.next() < 0.2;
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
    mb.box(-0.3, y, cz - 0.3, 0.3, y + Math.min(tw, td) * 0.9 + 18, cz + 0.3, PALETTE.steel);
  } else if (floors > 24 && crown < 0.75) {
    // 屋上の目隠しパネル（夜は光る帯）と、ヘリポート
    if (allGlass) glassParapet(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y, wall, 4);
    else crownScreen(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y, office ? 5 : 3.5, frame);
    if (office && Math.min(tw, td) > 16) helipad(mb, 0, cz, y + 0.3, Math.min(tw, td) * 0.42);
    else roofUnits(mb, -tw / 2 + 1, cz - td / 2 + 1, tw / 2 - 1, cz + td / 2 - 1, y, rng, 3);
  } else {
    mb.box(-tw / 3, y, cz - td / 3, tw / 3, y + 3.5, cz + td / 3, PALETTE.concrete, PAT.industrial, flatRoof());
    roofUnits(mb, -tw / 2 + 0.5, cz - td / 2 + 0.5, tw / 2 - 0.5, cz + td / 2 - 0.5, y, rng, 3);
    if (floors > 20 && crown < 0.6) mb.box(-0.25, y + 3.5, cz - 0.25, 0.25, y + 16, cz + 0.25, PALETTE.steel);
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
function helipad(mb: MeshBuilder, cx: number, cz: number, y: number, r: number) {
  mb.cylinder(cx, cz, y - 0.3, y, r, 24, C(0x4a4f55), C(0x4a4f55));
  mb.cylinder(cx, cz, y, y + 0.03, r * 0.82, 24, C(0xe9e4d4), C(0xe9e4d4));
  mb.cylinder(cx, cz, y + 0.03, y + 0.06, r * 0.74, 24, C(0x4a4f55), C(0x4a4f55));
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
  const r = rng.next();
  const big = Math.min(f.W, f.D) >= 30;
  // 近未来的な形（24 階以上の約 3 割）：楕円で上へ細くなる塔、しずく形の塔、ダイアグリッド（オフィスのみ）
  if (floors >= 24) {
    const r2 = rng.next();
    if (r2 < 0.3) {
      const pick = rng.next();
      if (!office) return pick < 0.5 ? bulletTower(mb, f, rng, tf, floors, false) : dropTower(mb, f, rng, tf, floors, false);
      return pick < 0.34 ? bulletTower(mb, f, rng, tf, floors, true) : pick < 0.67 ? dropTower(mb, f, rng, tf, floors, true) : diagridTower(mb, f, rng, tf, floors);
    }
  }
  if (!office) {
    // 香港のような細長い十字形の集合住宅
    if (floors >= 22 && r < 0.35) return crossTowers(mb, f, rng, tf, floors);
    if (floors >= 20 && r < 0.6) return chamferTower(mb, f, rng, tf, floors, false);
    if (floors >= 28 && luxury && r < 0.75) return rng.next() < 0.5 ? roundTower(mb, f, rng, tf, floors, false) : steppedTower(mb, f, rng, tf, floors, false);
    return tower(mb, f, rng, tf, floors, office, luxury);
  }
  if (floors >= 12 && officePat === PAT.fullglass && r < 0.6) return glassTower(mb, f, rng, tf, floors);
  if (floors < 24 && r < 0.65) return tower(mb, f, rng, tf, floors, office, luxury);
  // ほぼガラスだけの外壁を選んだビルは、半分以上をガラスの塔にする
  if (officePat === PAT.fullglass && r < 0.7) return glassTower(mb, f, rng, tf, floors);
  const designs = [twistedTower, taperedTower, steppedTower, roundTower, wedgeTower, twinTowers, tower, chamferTower, chamferTower, glassTower];
  let k = Math.floor(rng.next() * designs.length);
  if (designs[k] === twinTowers && !(f.W >= 40 && floors >= 30)) k = (k + 1) % designs.length;
  if (designs[k] === tower && floors >= 45) k = 0;
  if (!big && designs[k] === twinTowers) k = 1;
  designs[k](mb, f, rng, tf, floors, office, luxury);
}

// ---- 近未来的な高層ビル ----
// 楕円で上へなめらかに細くなり、頭が丸い塔（弾丸のような形）
function bulletTower(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean) {
  const glass = office ? rng.pick(GLASS) : rng.pick(TOWER_WALL);
  const p = podiumBase(mb, f, rng, tf, MW, floors);
  const fh = office ? 3.8 : 3.1, H = floors * fh;
  const Rx = Math.min(22, p.size * 0.42), Rz = Rx * (0.62 + rng.next() * 0.2);
  const ell = (k: number): P2[] => { const o: P2[] = []; for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; o.push([p.cx + Math.cos(a) * Rx * k, p.cz + Math.sin(a) * Rz * k]); } return o; };
  // 胴：上へいくほど細く（下 1.0 → 上 0.78）、頭：丸く閉じる
  const pat = office ? officePat === PAT.office ? PAT.curtain : officePat : resPat;
  const segs = 10;
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs, t1 = (k + 1) / segs;
    const s0 = 1 - 0.22 * t0 * t0, s1 = 1 - 0.22 * t1 * t1;
    mb.prism(ell(s0), p.y + H * 0.85 * t0, p.y + H * 0.85 * t1, glass, pat, null, ell(s1));
  }
  const capY = p.y + H * 0.85, cap = H * 0.15 + Rz * 0.4;
  const rings = 8;
  for (let k = 0; k < rings; k++) {
    const a0 = (k / rings) * Math.PI / 2, a1 = ((k + 1) / rings) * Math.PI / 2;
    const s0 = 0.78 * Math.cos(a0), s1 = Math.max(0.02, 0.78 * Math.cos(a1));
    mb.prism(ell(s0), capY + Math.sin(a0) * cap, capY + Math.sin(a1) * cap, glass, k < 3 ? pat : PAT.fullglass, k === rings - 1 ? MW2 : null, ell(s1));
  }
  // 頂部の光るリング
  mb.prism(ell(0.79), capY - 0.4, capY + 0.4, C(0xdfe6ee), PAT.glow, null, ell(0.79));
}

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
function podiumBase(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, color: THREE.Color, floors: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const PW = f.W - 2, PD = f.D - 3, pz1 = f.D / 2 - 1.5;
  const levels = floors >= 20 ? 1 + rng.int(2) : 1;
  const ph = 5 + (levels - 1) * 4.2;
  if (rng.next() < 0.55) {
    // ガラス張りの吹き抜けロビー（正面）と、石張りの低層部
    const lobbyD = Math.min(12, PD * 0.4);
    mb.box(-PW / 2, 0, pz1 - PD, PW / 2, ph, pz1 - lobbyD, color, PAT.shop, flatRoof());
    mb.box(-PW / 2 + 2, 0, pz1 - lobbyD, PW / 2 - 2, ph + 3, pz1, rng.pick(GLASS), PAT.curtain, flatRoof());
    mb.box(-PW / 2 + 1.5, ph + 3, pz1 - lobbyD - 0.5, PW / 2 - 1.5, ph + 3.6, pz1 + 0.6, color);
    for (const x of [-PW / 2 + 2, PW / 2 - 2]) mb.box(x - 0.35, 0, pz1 - 0.35, x + 0.35, ph + 3, pz1 + 0.35, color);
  } else mb.box(-PW / 2, 0, pz1 - PD, PW / 2, ph, pz1, color, PAT.shop, flatRoof());
  roofRim(mb, -PW / 2, pz1 - PD, PW / 2, pz1, ph, color, 0.8);
  // 入口のひさし
  mb.box(-4, 4.2, pz1, 4, 4.5, pz1 + 2.6, PALETTE.dark);
  tf(-f.W / 2 + 1.6, f.D / 2 - 1.0, 0.75);
  tf(f.W / 2 - 1.6, f.D / 2 - 1.0, 0.75);
  return { y: ph, cx: 0, cz: pz1 - PD / 2, size: Math.min(PW, PD) };
}

function spire(mb: MeshBuilder, cx: number, cz: number, y: number, h: number) {
  mb.cylinder(cx, cz, y, y + h, 0.7, 8, PALETTE.steel, PALETTE.steel, 0.15);
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
    else mb.quadN([x0, y0, a0], [x1, y0, a0], [x1, y1, a1], [x0, y1, a1], nrm(u0), nrm(u0), nrm(u1), nrm(u1), c);
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

function recycling(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.concrete);
  mb.box(-f.W / 2 + 3, 0, -f.D / 2 + 3, f.W / 2 - 12, 9, f.D / 2 - 5, GREEN, PAT.dock, PALETTE.steel);
  for (let k = 0; k < 4; k++) mb.box(f.W / 2 - 10, 0, -f.D / 2 + 3 + k * 6, f.W / 2 - 4, 2.4, -f.D / 2 + 7.5 + k * 6, rng.pick([BLUE, GREEN, PALETTE.accent[3]]));
}

// ハイテク産業：低層のガラスの研究所と、緑の多い敷地
function hightech(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.07, PALETTE.lawn2);
  const glass = rng.pick([new THREE.Color(0x5d8fb0), new THREE.Color(0x6aa3a0), new THREE.Color(0x8fa8c0)]);
  const W = f.W - 8, D = f.D - 12;
  const h = 7 + den * 4;
  mb.box(-W / 2, 0, -D / 2, W / 2 - 6, h, D / 2 - 4, glass, PAT.office, PALETTE.white);
  mb.box(W / 2 - 12, 0, D / 2 - 10, W / 2, h * 0.6, D / 2 + 2, PALETTE.white, PAT.office, PALETTE.steel);
  roofRim(mb, -W / 2, -D / 2, W / 2 - 6, D / 2 - 4, h, PALETTE.white, 0.7);
  // 屋上の太陽光パネル
  const panel = C(0x1d3557);
  for (let z = -D / 2 + 2; z < D / 2 - 7; z += 3.2)
    for (let x = -W / 2 + 2; x < W / 2 - 9; x += 5.5) {
      const x1 = Math.min(W / 2 - 8, x + 5);
      mb.quad([x, h + 0.5, z + 2.2], [x1, h + 0.5, z + 2.2], [x1, h + 1.3, z], [x, h + 1.3, z], panel);
    }
  // ガラスのアトリウム（入口）
  mb.box(-6, 0, D / 2 - 4, 4, h + 1.5, D / 2 - 1, PALETTE.glass, PAT.office, PALETTE.glass);
  mb.box(-6.3, h + 1.5, D / 2 - 4.3, 4.3, h + 1.8, D / 2 - 0.7, PALETTE.white);
  // 遊歩道と池
  mb.ground(-1.2, D / 2 - 1, 1.2, f.D / 2 - 5, 0.1, PALETTE.pavement);
  mb.ground(-f.W / 2 + 3, D / 2 - 1, -f.W / 2 + 10, D / 2 + 1.5, 0.12, PALETTE.water);
  mb.ground(-f.W / 2 + 1, f.D / 2 - 5, f.W / 2 - 1, f.D / 2 - 0.5, 0.1, PALETTE.asphalt);
  for (let k = 0; k < 6; k++) tf(-f.W / 2 + 2 + rng.next() * (f.W - 4), -f.D / 2 + 2 + rng.next() * 3, 0.8 + rng.next() * 0.4);
}

// ---------------- 記念施設 ----------------
const STONE = new THREE.Color(0xe4dccb), BRONZE = new THREE.Color(0x7a5a33), DOME = new THREE.Color(0x6f9a8c);

function columns(mb: MeshBuilder, x0: number, x1: number, z: number, h: number, step: number) {
  for (let x = x0; x <= x1 + 0.01; x += step) mb.cylinder(x, z, 1.2, h, 0.55, 8, PALETTE.white);
}

function cityHall(mb: MeshBuilder, f: LotFrame, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const W = f.W - 8, z0 = -f.D / 2 + 4, z1 = f.D / 2 - 10;
  mb.box(-W / 2, 0, z0, W / 2, 1.2, z1 + 4, STONE);
  mb.box(-W / 2 + 1, 1.2, z0 + 1, W / 2 - 1, 14, z1, STONE, PAT.house, PALETTE.concrete);
  columns(mb, -10, 10, z1 + 2, 12, 4);
  mb.box(-11.5, 12, z1 - 0.5, 11.5, 13, z1 + 3.5, PALETTE.white);
  mb.quad([-12, 13, z1 + 3.6], [12, 13, z1 + 3.6], [0, 17, z1 + 3.6], [0, 17, z1 + 3.6], PALETTE.white);
  // ドーム
  mb.cylinder(0, (z0 + z1) / 2, 14, 20, 6, 16, STONE);
  mb.cylinder(0, (z0 + z1) / 2, 20, 26, 6, 16, DOME, DOME, 1);
  mb.box(-0.15, 26, (z0 + z1) / 2 - 0.15, 0.15, 30, (z0 + z1) / 2 + 0.15, PALETTE.steel);
  for (const x of [-f.W / 2 + 3, f.W / 2 - 3]) tf(x, f.D / 2 - 3, 1.1);
}

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
// 角の丸い白い棟：ガラスの帯（横長の窓）と、上に少し張り出す屋根のふち
function whiteBlock(mb: MeshBuilder, cx: number, cz: number, w: number, d: number, h: number, r: number, pat: number = PAT.ribbon, col = MW) {
  mb.prism(rrect(cx, cz, w, d, r), 0, h, col, pat, MW2);
  mb.prism(rrect(cx, cz, w + 0.8, d + 0.8, r + 0.4), h, h + 0.6, MW, PAT.none, MW2);
}
// 夜に光る看板（色のまま光る）
const litSign = (mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color) => mb.box(x0, y0, z0, x1, y1, z1, c, PAT.lit, c);
// 赤十字（正面 +z に向けて）
function redCross(mb: MeshBuilder, x: number, y: number, z: number, s: number) {
  const red = C(0xe53935);
  litSign(mb, x - s * 0.5, y - s * 0.17, z, x + s * 0.5, y + s * 0.17, z + 0.3, red);
  litSign(mb, x - s * 0.17, y - s * 0.5, z, x + s * 0.17, y + s * 0.5, z + 0.3, red);
}

// 病院：低層部（外来）の上に、角の丸いガラスの病棟タワー。屋上ヘリポート、夜に光る赤十字、曲線の車寄せ
function modernHospital(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  mb.ground(-hw + 2, hd * 0.25, hw - 2, hd - 2, 0.09, PALETTE.pavement);
  const pw = f.W - 8, pd = f.D * 0.55, pz = -hd * 0.1;
  whiteBlock(mb, 0, pz, pw, pd, 9, 6);
  const tw = pw * 0.7, td = Math.min(pd * 0.6, 20);
  mb.prism(rrect(0, pz - 2, tw, td, td / 2), 9.6, 42, MGL, PAT.curtain, MW2);
  for (let y = 15; y < 42; y += 9) mb.prism(rrect(0, pz - 2, tw + 0.6, td + 0.6, td / 2 + 0.3), y, y + 0.7, MW, PAT.none, MW);
  mb.prism(rrect(0, pz - 2, tw + 0.8, td + 0.8, td / 2 + 0.4), 42, 43.2, MW, PAT.none, MW2);
  helipad(mb, 0, pz - 2, 43.4, Math.min(td * 0.42, 8));
  redCross(mb, tw * 0.25, 36, pz - 2 + td / 2 + 0.1, 6);
  // 曲線の車寄せ（薄い円盤の屋根と細い柱）
  const cz2 = pz + pd / 2 + 5;
  mb.cylinder(0, cz2, 5, 5.6, 9, 32, MW, MW2);
  for (const a of [0.4, 1.2, 1.9, 2.7]) mb.cylinder(Math.cos(a) * 7, cz2 + Math.sin(a) * 5, 0, 5, 0.25, 8, MW2);
  mb.box(-7, 0, pz + pd / 2, 7, 4.5, pz + pd / 2 + 0.6, MGL, PAT.fullglass, MW);
  for (const x of [-hw + 4, hw - 4]) tf(x, hd - 3, 0.9);
}

// クリニック：白い曲線の低層棟（2階）と、ガラスの入口、赤十字
function modernClinic(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  mb.ground(-4, 4, 4, hd - 0.5, 0.09, PALETTE.pavement);
  whiteBlock(mb, 0, -2, f.W - 7, f.D - 12, 8, 8);
  mb.prism(rrect(0, (f.D - 12) / 2 - 2, 9, 4, 1.8), 0, 4.5, MGL, PAT.fullglass, MW);
  redCross(mb, 0, 6.4, (f.D - 12) / 2 - 1.6, 2.8);
  tf(-hw + 3, hd - 3, 0.8);
  tf(hw - 3, hd - 3, 0.8);
}

// 学校：白い低層棟（教室）に、木のルーバーと屋上の太陽光パネル。弓なりの屋根の体育館と、校庭
function modernSchool(mb: MeshBuilder, f: LotFrame, tf: TF, high: boolean) {
  const hw = f.W / 2, hd = f.D / 2;
  const wood = C(0xb88a5a);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  // 校庭（奥）と、トラック
  const yz1 = -hd + (high ? f.D * 0.42 : f.D * 0.45);
  mb.ground(-hw + 2, -hd + 2, hw - 2, yz1, 0.09, C(0xc9a77a));
  if (high) {
    mb.ground(-hw + 5, -hd + 5, hw - 5, yz1 - 3, 0.1, C(0xb5523b));
    mb.ground(-hw + 8, -hd + 8, hw - 8, yz1 - 6, 0.11, PALETTE.lawn);
  }
  // 教室棟（正面、道路側）
  const cw = f.W * 0.62, cd = 12, cz = hd - 4 - cd / 2, ch = high ? 13 : 9.5;
  whiteBlock(mb, -hw + 3 + cw / 2, cz, cw, cd, ch, 3);
  for (let x = -hw + 4; x < -hw + 2 + cw; x += 1.6) mb.box(x, 0.5, cz + cd / 2 + 0.1, x + 0.35, ch - 0.6, cz + cd / 2 + 0.8, wood);
  // 屋上の太陽光パネル（少し傾けて並べる）
  for (let x = -hw + 5; x < -hw + cw - 1; x += 4.2) mb.quad([x, ch + 0.8, cz + 3], [x + 3.6, ch + 0.8, cz + 3], [x + 3.6, ch + 2.2, cz - 2], [x, ch + 2.2, cz - 2], C(0x22355a));
  // 体育館（弓なりの屋根）
  const gx0 = -hw + 5 + cw, gx1 = hw - 3, gz0 = yz1 + 2, gz1 = hd - 4;
  if (gx1 - gx0 > 8) {
    mb.box(gx0, 0, gz0, gx1, 7, gz1, MW, PAT.ribbon, MW2);
    archRoof(mb, gx0, gz0, gx1, gz1, 7, 4, MW2, false);
  }
  tf(-hw + 2, hd - 1.5, 0.8);
  tf(hw - 2, -hd + 3, 0.9);
}

// 大学：芝生のキャンパス。曲線のガラスの図書館棟（楕円）、白い研究棟、木と小道
function modernCollege(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn);
  mb.ground(-2, -hd + 2, 2, hd - 0.5, 0.09, PALETTE.pavement);
  mb.ground(-hw + 2, -2, hw - 2, 2, 0.09, PALETTE.pavement);
  // 図書館棟：楕円のガラスの塔と、白い屋根の円盤
  const ell: P2[] = [];
  for (let k = 0; k < 40; k++) { const a = (k / 40) * Math.PI * 2; ell.push([hw * 0.45 + Math.cos(a) * 11, hd * 0.4 + Math.sin(a) * 8]); }
  mb.prism(ell, 0, 18, MGL, PAT.curtain, MW2);
  mb.prism(ell.map(([x, z]) => [hw * 0.45 + (x - hw * 0.45) * 1.08, hd * 0.4 + (z - hd * 0.4) * 1.08] as P2), 18, 19.2, MW, PAT.none, MW2);
  // 研究棟：L 字に並ぶ白い棟
  whiteBlock(mb, -hw * 0.45, -hd * 0.45, f.W * 0.38, 14, 16, 4);
  whiteBlock(mb, -hw * 0.45, hd * 0.42, f.W * 0.36, 12, 12, 4);
  whiteBlock(mb, hw * 0.45, -hd * 0.45, f.W * 0.34, 14, 14, 7, PAT.curtain, MGL);
  for (let k = 0; k < 10; k++) tf(-hw + 4 + (k % 5) * (f.W - 8) / 4, k < 5 ? -4.5 : 4.5, 0.9);
}

// 図書館：ガラスの閲覧室の上に、波打つ白い屋根
function modernLibrary(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.lawn2);
  const x0 = -hw + 3, x1 = hw - 3, z0 = -hd + 4, z1 = hd - 5, h = 8;
  mb.box(x0, 0, z0, x1, h, z1, MGL, PAT.fullglass, MW2);
  // 波の屋根（x の向きに2つの波）。頂点ごとの法線でなめらかに
  const N = 24, amp = 1.8, waves = 2;
  const yAt = (u: number) => h + 1 + amp * (1 - Math.cos(u * Math.PI * 2 * waves)) / 2;
  const nAt = (u: number): [number, number, number] => { const sl = (amp * Math.PI * waves * Math.sin(u * Math.PI * 2 * waves)) / (x1 - x0 + 4); const l = Math.hypot(sl, 1); return [-sl / l, 1 / l, 0]; };
  for (let k = 0; k < N; k++) {
    const u0 = k / N, u1 = (k + 1) / N, a0 = x0 - 2 + (x1 - x0 + 4) * u0, a1 = x0 - 2 + (x1 - x0 + 4) * u1;
    mb.quadN([a0, yAt(u0), z1 + 2], [a1, yAt(u1), z1 + 2], [a1, yAt(u1), z0 - 2], [a0, yAt(u0), z0 - 2], nAt(u0), nAt(u1), nAt(u1), nAt(u0), MW);
    mb.quadN([a0, yAt(u0) - 0.5, z0 - 2], [a1, yAt(u1) - 0.5, z0 - 2], [a1, yAt(u1) - 0.5, z1 + 2], [a0, yAt(u0) - 0.5, z1 + 2], [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0], MW2);
  }
  for (const x of [x0 + 1, x1 - 1]) mb.cylinder(x, z1 + 1.5, 0, h + 1, 0.25, 10, MW2);
  tf(-hw + 2, hd - 2, 0.8);
  tf(hw - 2, hd - 2, 0.8);
}

// 博物館：白い曲面の建物。上が斜めに切れ、ガラスのスリットが走る。前に水盤
function modernMuseum(mb: MeshBuilder, f: LotFrame, tf: TF) {
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, PALETTE.pavement);
  const ell: P2[] = [];
  const R1 = hw - 5, R2 = hd * 0.55;
  for (let k = 0; k < 48; k++) { const a = (k / 48) * Math.PI * 2; ell.push([Math.cos(a) * R1, -4 + Math.sin(a) * R2]); }
  const topY = ell.map(([x]) => 12 + (x / R1) * 7);
  mb.prism(ell, 0, 19, MW, PAT.none, MW2, undefined, topY);
  // 斜めのガラスのスリット
  const sl = ell.map(([x, z]) => [x * 1.003, z * 1.003 - 0.01] as P2);
  mb.prism(sl, 4.5, 6, MGL, PAT.fullglass, null, undefined, sl.map(([x]) => 6 + (x / R1) * 4));
  // 入口（ガラス）と水盤
  mb.box(-7, 0, R2 - 4.5, 7, 5, R2 - 1.5, MGL, PAT.fullglass, MW);
  mb.ground(-hw + 4, R2, hw - 4, hd - 3, 0.12, PALETTE.water);
  tf(-hw + 2.5, hd - 1.5, 0.9);
  tf(hw - 2.5, hd - 1.5, 0.9);
}

// 警察：白とガラスの棟に青い帯。夜は青い帯と看板が光る。大きい署はガラスの塔つき
function modernPolice(mb: MeshBuilder, f: LotFrame, tf: TF, big: boolean) {
  const hw = f.W / 2, hd = f.D / 2;
  const blue = C(0x1f6fd0);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.pavement);
  if (!big) {
    whiteBlock(mb, 0, -1, f.W - 4, f.D - 6, 5, 2.5);
    mb.box(-3, 0, (f.D - 6) / 2 - 1, 3, 3.6, (f.D - 6) / 2 - 0.6, MGL, PAT.fullglass, MW);
    litSign(mb, -(f.W - 4) / 2, 4.2, (f.D - 6) / 2 - 0.9, (f.W - 4) / 2, 4.7, (f.D - 6) / 2 - 0.6, blue);
    return;
  }
  whiteBlock(mb, -hw * 0.25, -2, f.W * 0.65, f.D - 10, 10, 5);
  mb.prism(rrect(hw * 0.55, -4, f.W * 0.28, f.D * 0.45, 4), 0, 22, MGL, PAT.curtain, MW2);
  litSign(mb, -hw * 0.25 - f.W * 0.32, 8.6, (f.D - 10) / 2 - 1.8, -hw * 0.25 + f.W * 0.32, 9.3, (f.D - 10) / 2 - 1.5, blue);
  mb.box(-hw * 0.25 - 5, 0, (f.D - 10) / 2 - 2, -hw * 0.25 + 5, 4.5, (f.D - 10) / 2 - 1.5, MGL, PAT.fullglass, MW);
  tf(-hw + 2, hd - 1.5, 0.8);
}

// 消防：白い棟に赤い帯、ガラスの車庫扉（赤い枠）、訓練塔
function modernFire(mb: MeshBuilder, f: LotFrame, tf: TF, big: boolean) {
  const hw = f.W / 2, hd = f.D / 2;
  const red = C(0xd32f2f);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.08, PALETTE.concrete);
  const bw = f.W - (big ? 14 : 6), bd = f.D * (big ? 0.55 : 0.6), bz = hd - 9 - bd / 2, bh = big ? 11 : 8;
  const bx = big ? -5 : 0;
  whiteBlock(mb, bx, bz, bw, bd, bh, 3);
  litSign(mb, bx - bw / 2, bh - 1.6, bz + bd / 2 + 0.05, bx + bw / 2, bh - 0.9, bz + bd / 2 + 0.4, red);
  // 車庫扉（ガラス、赤い枠）
  const doors = big ? 4 : 2, dw = (bw - 4) / doors;
  for (let k = 0; k < doors; k++) {
    const x0 = bx - bw / 2 + 2 + k * dw + 0.6, x1 = x0 + dw - 1.2;
    mb.box(x0, 0, bz + bd / 2, x1, 5, bz + bd / 2 + 0.25, MGL, PAT.fullglass, MW);
    mb.box(x0 - 0.3, 0, bz + bd / 2 + 0.2, x0, 5.3, bz + bd / 2 + 0.45, red);
    mb.box(x1, 0, bz + bd / 2 + 0.2, x1 + 0.3, 5.3, bz + bd / 2 + 0.45, red);
    mb.box(x0 - 0.3, 5, bz + bd / 2 + 0.2, x1 + 0.3, 5.3, bz + bd / 2 + 0.45, red);
  }
  mb.ground(bx - bw / 2, bz + bd / 2, bx + bw / 2, hd - 0.5, 0.1, PALETTE.asphalt);
  // 訓練塔（白に赤い帯）
  const tx = big ? hw - 6 : hw - 4, tz = -hd + 5, th = big ? 22 : 15;
  mb.box(tx - 2.5, 0, tz - 2.5, tx + 2.5, th, tz + 2.5, MW, PAT.ribbon, MW2);
  mb.box(tx - 2.6, th - 3, tz - 2.6, tx + 2.6, th - 2, tz + 2.6, red);
  tf(-hw + 2, -hd + 2, 0.8);
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
