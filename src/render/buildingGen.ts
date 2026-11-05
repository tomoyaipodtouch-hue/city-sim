// 建物の自動生成（アメリカの都市風）
import * as THREE from 'three';
import { MAT } from './textures';
import { MeshBuilder, PAT } from './builder';
import { Rng } from '../sim/rng';
import { CELL } from '../sim/constants';
import type { Building } from '../sim/world';
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
const flatRoof = () => curRoof;

export function generateBuilding(mb: MeshBuilder, b: Building, f: LotFrame, trees: TreeSpot[], isCpark: (x: number, y: number) => boolean = () => false) {
  const rng = new Rng(b.seed);
  curRoof = FLAT_ROOFS[b.seed % FLAT_ROOFS.length];
  mb.flatRoofMat = (b.seed >> 3) % 3 === 0 ? MAT.gravel : MAT.membrane;
  // 工場・発電所などの斜めの屋根は金属
  mb.slopeRoofMat = b.civic || b.type === 'ID' || b.type === 'IM' || b.type === 'IH' ? MAT.metal : MAT.shingle;
  mb.abandoned = b.state === BState.Abandoned;
  const tf = (lx: number, lz: number, s = 1, kind = 0) => {
    // ローカル座標から世界座標へ（MeshBuilder と同じ変換）
    const a = b.face === 0 ? -Math.PI / 2 : b.face === 4 ? Math.PI / 2 : b.face === 6 ? Math.PI : 0;
    const cos = Math.cos(a), sin = Math.sin(a);
    const cx = (b.x + b.w / 2) * CELL, cz = (b.y + b.h / 2) * CELL;
    trees.push({ x: lx * cos - lz * sin + cx, y: f.base, z: lx * sin + lz * cos + cz, s, kind });
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
    case 'police_s': civicBox(mb, f, rng, PALETTE.accent[2], 1, 'police'); break;
    case 'police_l': civicBox(mb, f, rng, PALETTE.accent[2], 3, 'police'); break;
    case 'fire_s': fireStation(mb, f, false); break;
    case 'fire_l': fireStation(mb, f, true); break;
    case 'clinic': civicBox(mb, f, rng, PALETTE.white, 2, 'health'); break;
    case 'hospital': hospital(mb, f); break;
    case 'school_e': school(mb, f, rng, 2); break;
    case 'school_h': school(mb, f, rng, 3); break;
    case 'college': college(mb, f, rng, tf); break;
    case 'library': library(mb, f, tf); break;
    case 'landfill': landfill(mb, f, rng); break;
    case 'incinerator': incinerator(mb, f); break;
    case 'recycling': recycling(mb, f, rng); break;
    case 'mayor_house': mansion(mb, f, rng, tf); break;
    case 'city_hall': cityHall(mb, f, tf); break;
    case 'statue': statue(mb, f, tf); break;
    case 'museum': museum(mb, f, tf); break;
    case 'stadium': stadium(mb, f, rng); break;
  }
  mb.abandoned = false;
}

type TF = (lx: number, lz: number, s?: number, kind?: number) => void;

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
  const dome = [[20, 10, 9.2], [24, 9.2, 7.2], [27, 7.2, 4.4], [28.6, 4.4, 0.01]];
  let y0 = 20;
  for (const [y1, r0, r1] of dome) {
    mb.cylinder(18, 18, y0, y1, r0, 24, PALETTE.white, r1 < 0.1 ? PALETTE.white : undefined, r1);
    y0 = y1;
  }
  // タービン建屋と事務所
  mb.box(-30, 0, 6, 4, 14, 28, PALETTE.indWall[1], PAT.industrial, PALETTE.steel);
  mb.box(-30, 0, 30, -12, 8, 37, PALETTE.white, PAT.office, PALETTE.roof[3]);
  mb.box(5, 0, 26, 7, 10, 28, PALETTE.steel);
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
  return { A, Cw, box, ground, tree, cyl };
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
const TOWER_WALL = [0xd4d0c6, 0xb9b4a8, 0xe6e1d6, 0x9fa4a8, 0xc7b79c].map(C);
const GLASS = [0x5d7f9e, 0x5f8f86, 0x8a7458, 0x3d4a56, 0x9aa6b0, 0x4f6f8f, 0x6b8aa8].map(C);

// 中層の集合住宅（3〜8階）
function apartments(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, kind: string) {
  lawn(mb, f, rng);
  const wall = rng.pick(APT_WALL);
  const fh = 3.0;
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
    mb.box(x0, 0, z0, x1, h, z1, wall, PAT.apartment, flatRoof());
    roofRim(mb, x0, z0, x1, z1, h, wall);
    roofUnits(mb, x0, z0, x1, z1, h, rng, 2 + rng.int(3));
  }
  // ベランダ（正面）
  const [bx0, , bx1, bz1] = blocks[0];
  const bal = rng.pick([PALETTE.concrete, PALETTE.white, PALETTE.steel]);
  for (let k = 1; k < floors; k++) mb.box(bx0 + 1, k * fh, bz1, bx1 - 1, k * fh + 0.18, bz1 + 1.0, bal);
  // 入口のひさし
  mb.box(-2, 2.8, bz1, 2, 3.1, bz1 + 2, kind === 'R3' ? PALETTE.dark : PALETTE.concrete);
  // 給水タンク
  if (rng.next() < 0.4) waterTank(mb, bx0 + 3, blocks[0][1] + 3, h, 1.4, rng);
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
  mb.box(-W / 2 + 0.3, g, z0 + 0.3, W / 2 - 0.3, h, z1 - 0.3, wall, upscale ? PAT.office : PAT.apartment, flatRoof());
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
  const frame = office ? rng.pick([PALETTE.steel, PALETTE.white, PALETTE.dark, PALETTE.concrete]) : rng.pick(APT_WALL);
  const pat = office ? PAT.office : PAT.apartment;
  // 低層部（ポディウム）
  const podium = floors >= 8 ? 1 + rng.int(3) : 0;
  const PW = f.W - 2, PD = f.D - 3;
  const pz1 = f.D / 2 - 1.5;
  let y = 0;
  if (podium) {
    const ph = 4.5 + (podium - 1) * 4;
    mb.box(-PW / 2, 0, pz1 - PD, PW / 2, ph, pz1, frame, PAT.shop, flatRoof());
    roofRim(mb, -PW / 2, pz1 - PD, PW / 2, pz1, ph, frame, 0.8);
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
      roofRim(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y + h, office ? frame : wall, 1.1);
      if (t < tiers - 1) roofUnits(mb, -tw / 2, cz - td / 2, tw / 2, cz + td / 2, y + h, rng, 2);
    }
    // 階ごとの帯（オフィスは縦の柱）
    if (office && !round) {
      for (let x = -tw / 2; x <= tw / 2 + 0.01; x += tw / Math.max(2, Math.round(tw / 6))) {
        mb.box(x - 0.18, y, cz + td / 2, x + 0.18, y + h, cz + td / 2 + 0.25, frame);
        mb.box(x - 0.18, y, cz - td / 2 - 0.25, x + 0.18, y + h, cz - td / 2, frame);
      }
    } else if (!office) {
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
  } else {
    mb.box(-tw / 3, y, cz - td / 3, tw / 3, y + 3.5, cz + td / 3, PALETTE.concrete, PAT.industrial, flatRoof());
    roofUnits(mb, -tw / 2 + 0.5, cz - td / 2 + 0.5, tw / 2 - 0.5, cz + td / 2 - 0.5, y, rng, 3);
    if (floors > 20 && crown < 0.6) mb.box(-0.25, y + 3.5, cz - 0.25, 0.25, y + 16, cz + 0.25, PALETTE.steel);
    if (!office) waterTank(mb, tw / 4, cz, y + 3.5, 1.6, rng);
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

// どの形のビルにするかを選ぶ
function highrise(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number, office: boolean, luxury: boolean) {
  const r = rng.next();
  const big = Math.min(f.W, f.D) >= 30;
  if (!office) {
    // 香港のような細長い十字形の集合住宅
    if (floors >= 22 && r < 0.45) return crossTowers(mb, f, rng, tf, floors);
    if (floors >= 28 && luxury && r < 0.75) return rng.next() < 0.5 ? roundTower(mb, f, rng, tf, floors, false) : steppedTower(mb, f, rng, tf, floors, false);
    return tower(mb, f, rng, tf, floors, office, luxury);
  }
  if (floors < 24 && r < 0.65) return tower(mb, f, rng, tf, floors, office, luxury);
  const designs = [twistedTower, taperedTower, steppedTower, roundTower, wedgeTower, twinTowers, tower];
  let k = Math.floor(rng.next() * designs.length);
  if (designs[k] === twinTowers && !(f.W >= 40 && floors >= 30)) k = (k + 1) % designs.length;
  if (designs[k] === tower && floors >= 45) k = 0;
  if (!big && designs[k] === twinTowers) k = 1;
  designs[k](mb, f, rng, tf, floors, office, luxury);
}

// 低層部（店舗やロビー）。上の塔の中心を返す
function podiumBase(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, color: THREE.Color, floors: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const PW = f.W - 2, PD = f.D - 3, pz1 = f.D / 2 - 1.5;
  const levels = floors >= 20 ? 1 + rng.int(2) : 1;
  const ph = 5 + (levels - 1) * 4.2;
  mb.box(-PW / 2, 0, pz1 - PD, PW / 2, ph, pz1, color, PAT.shop, flatRoof());
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
    mb.prism(pts, y, y + h, glass, PAT.office, k === segs - 1 ? flatRoof() : null);
    mb.prism(scaleP(pts, p.cx, p.cz, 1.025), y + h - 0.3, y + h, frame, PAT.none, k === segs - 1 ? flatRoof() : null);
    y += h;
  }
  const top = rect(p.cx, p.cz, side * 0.5, side * 0.5, twist);
  mb.prism(top, y, y + 6, frame, PAT.industrial, flatRoof());
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
    mb.prism(scaleP(base, p.cx, p.cz, k0), y, y + h, glass, PAT.office, null, scaleP(base, p.cx, p.cz, k1));
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
  const pat = office ? PAT.office : PAT.apartment;
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
    mb.prism(poly, y, y + h, glass, office ? PAT.office : PAT.apartment, null);
    mb.prism(ngon(p.cx, p.cz, R + 0.5, 20), y + h - 0.35, y + h + 0.05, band, PAT.none, null);
    y += h;
  }
  mb.prism(poly, y, y, glass, PAT.none, flatRoof());
  mb.prism(ngon(p.cx, p.cz, R * 0.55, 20), y, y + 7, band, PAT.industrial, flatRoof());
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
  mb.prism(pts, p.y, p.y + H, glass, PAT.office, glass, undefined, pts.map(([, z]) => p.y + H - cut * (0.5 - (z - p.cz) / d)));
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
    mb.prism(poly, p.y, p.y + H * 0.9, glass, PAT.office, flatRoof(), scaleP(poly, cx, p.cz, 0.92));
    mb.prism(scaleP(poly, cx, p.cz, 0.7), p.y + H * 0.9, p.y + H, frame, PAT.industrial, flatRoof());
    spire(mb, cx, p.cz, p.y + H, 12 + rng.next() * 8);
  }
  // 連絡通路（2階分）
  const by = p.y + H * 0.45;
  mb.box(p.cx - gap / 2 - 1, by, p.cz - 3, p.cx + gap / 2 + 1, by + 7, p.cz + 3, frame, PAT.office, flatRoof());
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
      mb.box(cx - span / 2, p.y, cz - arm / 2, cx + span / 2, top, cz + arm / 2, wall, PAT.apartment, flatRoof());
      mb.box(cx - arm / 2, p.y, cz - span / 2, cx + arm / 2, top, cz - arm / 2, wall, PAT.apartment, flatRoof());
      mb.box(cx - arm / 2, p.y, cz + arm / 2, cx + arm / 2, top, cz + span / 2, wall, PAT.apartment, flatRoof());
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
  const tH = big ? 18 : 11;
  L.box(ta0, 0, termC0, ta1, tH, termC1, PALETTE.glass, PAT.office, C(0xd8dadc));
  L.box(ta0 - 3, tH, termC0 - 4, ta1 + 3, tH + 1.2, termC1 + 2, C(0xe8e9ea));
  L.box(ta0 + 8, tH + 1.2, termC0 + 3, ta1 - 8, tH + 3, termC1 - 6, C(0xe8e9ea));
  L.box(ta0, 0, termC1, ta1, 4.5, termC1 + 3, C(0xd8dadc)); // 出発ロビーのひさし（道路の側）
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
const BRICK = new THREE.Color(0x9a4a35), BEIGE = new THREE.Color(0xd9ccb0), RED = new THREE.Color(0xc0392b), BLUE = new THREE.Color(0x2f5fa8), GREEN = new THREE.Color(0x3f7d3a);

function sign(mb: MeshBuilder, x: number, z: number, y: number, c: THREE.Color) {
  mb.box(x - 2, y, z, x + 2, y + 0.9, z + 0.25, c);
}

// 交番・警察署・診療所（シンプルな公共の建物）
function civicBox(mb: MeshBuilder, f: LotFrame, rng: Rng, accent: THREE.Color, floors: number, kind: 'police' | 'health') {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const wall = kind === 'police' ? rng.pick([BEIGE, PALETTE.concrete]) : PALETTE.white;
  const W = f.W - 3, D = Math.min(f.D - 5, 12 + floors * 2);
  const z1 = f.D / 2 - 3, z0 = z1 - D;
  const h = floors * 3.6 + 0.6;
  mb.box(-W / 2, 0, z0, W / 2, h, z1, wall, PAT.office, PALETTE.concrete);
  mb.box(-W / 2, h, z0, W / 2, h + 0.5, z1, accent);
  mb.box(-2.5, 2.8, z1, 2.5, 3.2, z1 + 2, accent);
  sign(mb, 0, z1 + 0.05, h - 1.6, accent);
  if (kind === 'police') {
    // パトカー
    for (let k = 0; k < Math.min(4, floors + 1); k++) {
      const x = -W / 2 + 2 + k * 3.2;
      mb.box(x, 0, z0 - 6, x + 1.9, 1.5, z0 - 1.6, PALETTE.white);
      mb.box(x + 0.3, 1.5, z0 - 4.6, x + 1.6, 1.8, z0 - 3.6, BLUE);
    }
  } else {
    mb.box(-0.5, h + 0.5, z0 + D / 2 - 2, 0.5, h + 3.5, z0 + D / 2 + 2, RED);
    mb.box(-2, h + 1.5, z0 + D / 2 - 0.5, 2, h + 2.5, z0 + D / 2 + 0.5, RED);
  }
}

function fireStation(mb: MeshBuilder, f: LotFrame, large: boolean) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const W = f.W - 3, D = f.D - 8, z1 = f.D / 2 - 5, z0 = z1 - D;
  const h = large ? 8 : 6.5;
  mb.box(-W / 2, 0, z0, W / 2, h, z1, BRICK, PAT.none, PALETTE.concrete);
  // 車庫の扉と消防車
  const doors = large ? 3 : 2;
  for (let k = 0; k < doors; k++) {
    const x = -W / 2 + 2 + k * ((W - 4) / doors);
    const dw = (W - 4) / doors - 1;
    mb.box(x, 0.05, z1, x + dw, 4.4, z1 + 0.06, PALETTE.white);
    mb.box(x + 0.6, 0, z1 + 0.5, x + dw - 0.6, 2.8, z1 + 4.5, RED);
  }
  // 訓練塔
  mb.box(W / 2 - 4, 0, z0 - 1, W / 2 - 1, large ? 18 : 14, z0 + 2, BRICK, PAT.house, PALETTE.dark);
}

function hospital(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const W = f.W - 4;
  mb.box(-W / 2, 0, -f.D / 2 + 3, W / 2, 20, 6, PALETTE.white, PAT.office, PALETTE.concrete);
  mb.box(-W / 2 + 4, 0, 6, W / 2 - 4, 9, f.D / 2 - 5, PALETTE.white, PAT.office, PALETTE.concrete);
  mb.box(-4, 3.5, f.D / 2 - 5, 4, 4, f.D / 2 - 1.5, RED);
  // 屋上のヘリポート
  mb.cylinder(0, -f.D / 4, 20, 20.3, 7, 16, PALETTE.dark, PALETTE.dark);
  mb.ground(-3, -f.D / 4 - 0.4, 3, -f.D / 4 + 0.4, 20.35, PALETTE.white);
  // 赤十字
  mb.box(-0.6, 20, 5.9, 0.6, 24, 6.2, RED);
  mb.box(-2, 21.4, 5.9, 2, 22.6, 6.2, RED);
}

function school(mb: MeshBuilder, f: LotFrame, rng: Rng, floors: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.07, PALETTE.lawn);
  const wall = rng.pick([BRICK, BEIGE]);
  const W = f.W - 4;
  const h = floors * 3.6;
  mb.box(-W / 2, 0, f.D / 2 - 14, W / 2, h, f.D / 2 - 3, wall, PAT.apartment, PALETTE.concrete);
  mb.box(-W / 2, 0, -f.D / 2 + 3, -W / 2 + 8, h, f.D / 2 - 14, wall, PAT.apartment, PALETTE.concrete);
  // 校庭（トラック）と旗
  mb.ground(-W / 2 + 10, -f.D / 2 + 3, W / 2, f.D / 2 - 17, 0.1, PALETTE.dirt);
  mb.ground(-W / 2 + 13, -f.D / 2 + 6, W / 2 - 3, f.D / 2 - 20, 0.12, PALETTE.lawn2);
  mb.box(W / 2 - 2, 0, f.D / 2 - 2.5, W / 2 - 1.85, 8, f.D / 2 - 2.35, PALETTE.steel);
  mb.box(W / 2 - 1.85, 6.5, f.D / 2 - 2.5, W / 2 + 0.2, 7.8, f.D / 2 - 2.4, BLUE);
  // スクールバス
  mb.box(-4, 0, f.D / 2 - 2.6, 5, 2.6, f.D / 2 - 0.4, new THREE.Color(0xf2b705));
}

function college(mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.07, PALETTE.lawn2);
  // 中庭を囲む校舎と、時計塔
  for (const [x0, z0, x1, z1] of [[-26, -26, 26, -16], [-26, 16, 26, 26], [-26, -16, -16, 16], [16, -16, 26, 16]]) {
    mb.box(x0, 0, z0, x1, 11, z1, BRICK, PAT.apartment, PALETTE.roof[3]);
    mb.hip(x0, z0, x1, z1, 11, 3, PALETTE.roof[3], 0.3);
  }
  mb.box(-3, 0, 20, 3, 26, 26, BRICK, PAT.house, PALETTE.dark);
  mb.hip(-3, 20, 3, 26, 26, 6, PALETTE.roof[0], 0.2);
  mb.ground(-2, -16, 2, 16, 0.1, PALETTE.pavement);
  mb.ground(-16, -2, 16, 2, 0.1, PALETTE.pavement);
  for (let k = 0; k < 10; k++) tf(-14 + rng.next() * 28, -14 + rng.next() * 28, 0.9 + rng.next() * 0.4);
}

function library(mb: MeshBuilder, f: LotFrame, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.lawn);
  mb.box(-11, 0, -8, 11, 1, 9, PALETTE.concrete);
  mb.box(-10, 1, -7, 10, 9, 6, BEIGE, PAT.house, PALETTE.concrete);
  for (let x = -8; x <= 8; x += 2.7) mb.cylinder(x, 7.5, 1, 9, 0.5, 8, PALETTE.white);
  mb.box(-10, 9, -7, 10, 10, 8.5, PALETTE.white);
  mb.quad([-10.5, 10, 8.6], [10.5, 10, 8.6], [0, 13, 8.6], [0, 13, 8.6], PALETTE.white);
  tf(-12, 12, 0.8);
  tf(12, 12, 0.8);
}

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

function incinerator(mb: MeshBuilder, f: LotFrame) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.concrete);
  mb.box(-18, 0, -10, 12, 16, 14, PALETTE.indWall[1], PAT.industrial, PALETTE.steel);
  mb.cylinder(16, -12, 0, 45, 2.6, 12, PALETTE.white, PALETTE.dark, 2);
  mb.cylinder(16, -12, 38, 42, 2.25, 12, RED, undefined, 2.15);
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

function museum(mb: MeshBuilder, f: LotFrame, tf: TF) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.08, PALETTE.pavement);
  const W = f.W - 6, z0 = -f.D / 2 + 3, z1 = f.D / 2 - 9;
  mb.box(-W / 2, 0, z0, W / 2, 1.5, z1 + 5, STONE);
  mb.box(-W / 2 + 1, 1.5, z0 + 1, W / 2 - 1, 12, z1, STONE, PAT.none, PALETTE.concrete);
  columns(mb, -W / 2 + 3, W / 2 - 3, z1 + 3, 11, 3.2);
  mb.box(-W / 2 + 1, 11, z1 - 0.5, W / 2 - 1, 12.2, z1 + 4.5, PALETTE.white);
  mb.quad([-W / 2 + 0.5, 12.2, z1 + 4.6], [W / 2 - 0.5, 12.2, z1 + 4.6], [0, 16.5, z1 + 4.6], [0, 16.5, z1 + 4.6], PALETTE.white);
  mb.gableX(-W / 2 + 1, z0 + 1, W / 2 - 1, z1, 12, 4.5, PALETTE.roof[1], STONE, 0.2);
  tf(-f.W / 2 + 2, f.D / 2 - 2, 0.9);
  tf(f.W / 2 - 2, f.D / 2 - 2, 0.9);
}

function stadium(mb: MeshBuilder, f: LotFrame, rng: Rng) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.07, PALETTE.asphalt);
  // 観客席（外側の壁と段）を八角形で
  const R = Math.min(f.W, f.D) / 2 - 3, seg = 16;
  const seat = new THREE.Color(0x2f86d0), wall = PALETTE.concrete;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    // 外壁
    mb.quad([c1 * R, 0, s1 * R], [c0 * R, 0, s0 * R], [c0 * R, 16, s0 * R], [c1 * R, 16, s1 * R], wall, PAT.industrial);
    // 段々の客席（内側へ下がる斜面）
    const r2 = R * 0.62;
    mb.quad([c0 * R, 16, s0 * R], [c1 * R, 16, s1 * R], [c1 * r2, 3, s1 * r2], [c0 * r2, 3, s0 * r2], k % 2 ? seat : new THREE.Color(0xe8e8e2));
  }
  // フィールド
  mb.ground(-R * 0.6, -R * 0.45, R * 0.6, R * 0.45, 3, PALETTE.lawn2);
  for (let x = -R * 0.5; x < R * 0.5; x += R * 0.2) mb.ground(x, -R * 0.45, x + R * 0.1, R * 0.45, 3.02, PALETTE.lawn);
  // 照明塔
  for (const [x, z] of [[-R, -R], [R, -R], [-R, R], [R, R]].map(([x, z]) => [x * 0.8, z * 0.8])) {
    mb.box(x - 0.4, 0, z - 0.4, x + 0.4, 30, z + 0.4, PALETTE.steel);
    mb.box(x - 2, 30, z - 0.6, x + 2, 32, z + 0.6, PALETTE.white);
  }
  void rng;
}
