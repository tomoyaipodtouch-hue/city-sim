// 建物の自動生成（アメリカの都市風）
import * as THREE from 'three';
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

export function generateBuilding(mb: MeshBuilder, b: Building, f: LotFrame, trees: TreeSpot[]) {
  const rng = new Rng(b.seed);
  curRoof = FLAT_ROOFS[b.seed % FLAT_ROOFS.length];
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
      if (dense && b.floors >= 9) tower(mb, f, rng, tf, b.floors, false, b.type === 'R3');
      else if (dense) apartments(mb, f, rng, tf, b.floors, b.type);
      else if (b.type === 'R1') houseLow(mb, f, rng, tf, b);
      else if (b.type === 'R2') houseMid(mb, f, rng, tf, b);
      else mansion(mb, f, rng, tf);
      break;
    case 'CS1': case 'CS2': case 'CS3':
      if (dense) shopMid(mb, f, rng, tf, b.floors, b.type === 'CS3');
      else shop(mb, f, rng, tf, b.type === 'CS1' ? 1 : b.type === 'CS2' ? 2 : 3);
      break;
    case 'CO2': case 'CO3':
      tower(mb, f, rng, tf, Math.max(3, b.floors), true, b.type === 'CO3');
      break;
    case 'IA': farm(mb, f, rng, tf); break;
    case 'ID': factory(mb, f, rng, true, b.den); break;
    case 'IM': factory(mb, f, rng, false, b.den); break;
    case 'coal': coalPlant(mb, f); break;
    case 'gas': gasPlant(mb, f); break;
    case 'pump': pump(mb, f); break;
    case 'tower': waterTower(mb, f); break;
    case 'park_s': park(mb, f, rng, tf, false); break;
    case 'park_l': park(mb, f, rng, tf, true); break;
    case 'plaza': plaza(mb, f, rng, tf); break;
    case 'busstop': busStop(mb, f); break;
    case 'station': station(mb, f, 0); break;
    case 'el_station': station(mb, f, 8); break;
    case 'mono_station': station(mb, f, 11); break;
    case 'sub_station': subwayEntrance(mb, f); break;
    case 'ferry_p': ferryTerminal(mb, f, false); break;
    case 'ferry_c': ferryTerminal(mb, f, true); break;
    case 'seaport': seaport(mb, f, rng); break;
    case 'airport_s': airport(mb, f, rng, 1); break;
    case 'airport_l': airport(mb, f, rng, 2); break;
    case 'freight_st': freightStation(mb, f, rng); break;
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

function roofUnits(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, rng: Rng, n: number) {
  for (let k = 0; k < n; k++) {
    const x = x0 + 1 + rng.next() * (x1 - x0 - 3), z = z0 + 1 + rng.next() * (z1 - z0 - 3);
    mb.box(x, y, z, x + 1.5, y + 1.1, z + 1.2, PALETTE.steel);
  }
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
  for (let x = -f.W / 2 + 2; x < f.W / 2 - 2; x += 2.8) mb.ground(x, z0 - 5.5, x + 0.15, z0 - 1, 0.12, PALETTE.white);
  if (rng.next() < 0.5) tf(-f.W / 2 + 1.5, -f.D / 2 + 1.5, 0.8);
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
      mb.quad([a, h, z1], [a + tw, h, z1], [a + tw, h + 3, z1], [a + tw, h + 3, z0], PALETTE.steel);
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
    for (let x = x0 + 14; x < x1 - 3; x += 3) mb.ground(x, z1 + 1, x + 0.15, z1 + 5.5, 0.12, PALETTE.white);
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
    mb.box(x0, h, z0, x1, h + 0.8, z0 + 0.3, wall);
    mb.box(x0, h, z1 - 0.3, x1, h + 0.8, z1, wall);
    roofUnits(mb, x0, z0, x1, z1, h, rng, 1 + rng.int(2));
  }
  // ベランダ（正面）
  const [bx0, , bx1, bz1] = blocks[0];
  const bal = rng.pick([PALETTE.concrete, PALETTE.white, PALETTE.steel]);
  for (let k = 1; k < floors; k++) mb.box(bx0 + 1, k * fh, bz1, bx1 - 1, k * fh + 0.18, bz1 + 1.0, bal);
  // 入口のひさし
  mb.box(-2, 2.8, bz1, 2, 3.1, bz1 + 2, kind === 'R3' ? PALETTE.dark : PALETTE.concrete);
  // 給水タンク
  if (rng.next() < 0.4) mb.cylinder(bx0 + 3, blocks[0][1] + 3, h, h + 3.5, 1.4, 8, PALETTE.wood, PALETTE.dark);
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
  mb.box(-W / 2 + 0.3, g, z0 + 0.3, W / 2 - 0.3, h, z1 - 0.3, wall, upscale ? PAT.office : PAT.apartment, PALETTE.dark);
  mb.box(-W / 2 + 0.3, h, z1 - 0.6, W / 2 - 0.3, h + 1.0, z1 - 0.3, wall);
  // 看板の帯と日よけ
  mb.box(-W / 2 + 0.4, g - 1.0, z1, W / 2 - 0.4, g - 0.2, z1 + 0.3, accent);
  mb.quad([-W / 2 + 0.4, 3.0, z1 + 1.6], [W / 2 - 0.4, 3.0, z1 + 1.6], [W / 2 - 0.4, 3.6, z1], [-W / 2 + 0.4, 3.6, z1], accent);
  // 縦の看板（ネオン風）
  if (rng.next() < 0.5 && floors >= 3) mb.box(W / 2 - 2, g, z1, W / 2 - 1.2, Math.min(h, g + 9), z1 + 1.2, rng.pick(PALETTE.accent));
  roofUnits(mb, -W / 2, z0, W / 2, z1, h, rng, 2 + rng.int(3));
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
    else mb.box(-tw / 2, y, cz - td / 2, tw / 2, y + h, cz + td / 2, wall, pat, PALETTE.dark);
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
    mb.box(-tw / 3, y, cz - td / 3, tw / 3, y + 3.5, cz + td / 3, PALETTE.concrete);
    if (floors > 20 && crown < 0.6) mb.box(-0.25, y + 3.5, cz - 0.25, 0.25, y + 16, cz + 0.25, PALETTE.steel);
    if (!office) mb.cylinder(tw / 4, cz, y + 3.5, y + 6, 1.6, 8, PALETTE.wood, PALETTE.dark);
  }
  // 入口と植え込み
  mb.box(-3, podium ? 4.3 : 3, pz1, 3, (podium ? 4.3 : 3) + 0.3, pz1 + 2.2, PALETTE.dark);
  tf(-f.W / 2 + 1.6, f.D / 2 - 1.0, 0.75);
  tf(f.W / 2 - 1.6, f.D / 2 - 1.0, 0.75);
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
  const wall = lift ? PALETTE.white : PALETTE.shopWall[2];
  // 駅舎
  mb.box(-f.W / 2 + 2, 0, 0, f.W / 2 - 2, 6, f.D / 2 - 3, wall, PAT.shop, PALETTE.steel);
  mb.box(-f.W / 2 + 1, 6, -1, f.W / 2 - 1, 6.5, f.D / 2 - 2, PALETTE.steel);
  mb.box(-3, 4.6, f.D / 2 - 3, 3, 5.6, f.D / 2 - 2.8, PALETTE.accent[2]);
  // ホームと屋根
  const ph = lift ? lift - 0.4 : 1.0;
  if (lift) {
    for (const x of [-f.W / 2 + 3, 0, f.W / 2 - 3]) mb.box(x - 0.5, 0, -f.D / 2 + 3, x + 0.5, ph, -f.D / 2 + 4, PALETTE.concrete);
    mb.box(-f.W / 2 + 1.5, 0, -2, -f.W / 2 + 4.5, ph + 3, 1, wall, PAT.office, PALETTE.steel);
  }
  mb.box(-f.W / 2 + 0.6, ph - 0.6, -f.D / 2 + 1.2, f.W / 2 - 0.6, ph, -f.D / 2 + 5.5, PALETTE.concrete);
  for (const x of [-f.W / 2 + 2, 0, f.W / 2 - 2]) mb.box(x - 0.12, ph, -f.D / 2 + 3.2, x + 0.12, ph + 3.2, -f.D / 2 + 3.5, PALETTE.steel);
  mb.box(-f.W / 2 + 0.6, ph + 3.2, -f.D / 2 + 1.5, f.W / 2 - 0.6, ph + 3.5, -f.D / 2 + 5.2, PALETTE.roof[3]);
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
  // 停泊中の貨物船
  mb.box(-f.W / 2 + 4, -2, -f.D / 2 - 14, f.W / 2 - 4, 3, -f.D / 2 - 5, PALETTE.dark);
  for (let k = 0; k < 5; k++) mb.box(-f.W / 2 + 6 + k * 9, 3, -f.D / 2 - 13, -f.W / 2 + 13 + k * 9, 5.5, -f.D / 2 - 6, rng.pick(cols));
  mb.box(f.W / 2 - 10, 3, -f.D / 2 - 13, f.W / 2 - 5, 12, -f.D / 2 - 6, PALETTE.white, PAT.apartment);
}

// 飛行機（停まっているもの）
export function plane(mb: MeshBuilder, x: number, z: number, s: number, y = 0) {
  mb.cylinder(x, z, y + 2.2 * s, y + 2.2 * s + 0.01, 0.01, 4, PALETTE.white);
  mb.box(x - 1.6 * s, y + 1.2 * s, z - 14 * s, x + 1.6 * s, y + 4.2 * s, z + 14 * s, PALETTE.white);
  mb.box(x - 14 * s, y + 2.0 * s, z - 2 * s, x + 14 * s, y + 2.5 * s, z + 3 * s, PALETTE.white);
  mb.box(x - 5 * s, y + 3.0 * s, z - 14 * s, x + 5 * s, y + 3.4 * s, z - 11 * s, PALETTE.white);
  mb.box(x - 0.2 * s, y + 4.2 * s, z - 14 * s, x + 0.2 * s, y + 9 * s, z - 10.5 * s, PALETTE.accent[2]);
  for (const sx of [-6, 6]) mb.box(x + sx * s - 0.9 * s, y + 0.6 * s, z - 1 * s, x + sx * s + 0.9 * s, y + 2.1 * s, z + 3 * s, PALETTE.steel);
}

function airport(mb: MeshBuilder, f: LotFrame, rng: Rng, size: number) {
  mb.ground(-f.W / 2 + 0.2, -f.D / 2 + 0.2, f.W / 2 - 0.2, f.D / 2 - 0.2, 0.06, PALETTE.lawn2);
  // 滑走路（奥行き方向）と中心線
  const rw = size === 2 ? 22 : 16;
  const rx = -f.W / 2 + rw / 2 + 4;
  mb.ground(rx - rw / 2, -f.D / 2 + 3, rx + rw / 2, f.D / 2 - 3, 0.1, PALETTE.asphalt);
  for (let z = -f.D / 2 + 8; z < f.D / 2 - 8; z += 12) mb.ground(rx - 0.4, z, rx + 0.4, z + 6, 0.14, PALETTE.white);
  for (const z of [-f.D / 2 + 4, f.D / 2 - 9]) for (let k = -3; k <= 3; k++) if (k) mb.ground(rx + k * (rw / 8) - 0.5, z, rx + k * (rw / 8) + 0.5, z + 5, 0.14, PALETTE.white);
  // 誘導路とエプロン
  const ax0 = rx + rw / 2 + 4, ax1 = f.W / 2 - 2;
  mb.ground(rx + rw / 2, -f.D / 4, ax0, -f.D / 4 + 8, 0.1, PALETTE.asphalt);
  mb.ground(ax0, -f.D / 2 + 10, ax1, f.D / 2 - 30, 0.1, PALETTE.pavement);
  // ターミナルと管制塔（道路側）
  mb.box(ax0, 0, f.D / 2 - 28, ax1, size === 2 ? 14 : 9, f.D / 2 - 4, PALETTE.white, PAT.office, PALETTE.steel);
  mb.cylinder(ax1 - 6, f.D / 2 - 34, 0, size === 2 ? 34 : 24, 2, 10, PALETTE.white);
  mb.box(ax1 - 9, size === 2 ? 34 : 24, f.D / 2 - 37, ax1 - 3, (size === 2 ? 34 : 24) + 4, f.D / 2 - 31, PALETTE.glass);
  // 停まっている飛行機
  const n = size === 2 ? 3 : 1;
  for (let k = 0; k < n; k++) plane(mb, (ax0 + ax1) / 2, -f.D / 2 + 26 + k * 34, size === 2 ? 1.0 : 0.7);
  void rng;
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
