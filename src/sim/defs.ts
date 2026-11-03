// ゲーム内のデータ定義（道路、ゾーン、建物、公共施設）

// ---- 道路 ----
export enum RoadType {
  None = 0,
  Street = 1,
  Road = 2,
  OneWay = 3,
  Avenue = 4,
  Highway = 5, // 高架の高速道路（上空の階層）
  GroundHighway = 6, // 地上の高速道路
  Ramp = 7, // ランプ（高速道路の出入口）
}

export interface RoadDef {
  id: RoadType;
  name: string;
  speedKmh: number; // 制限速度
  capacity: number; // 1日あたりの容量（台、1マスあたり）
  cost: number; // 1マスの建設費
  upkeep: number; // 1マスの月額維持費
  width: number; // 描画上の幅（m）
  oneWay?: boolean; // 一方向だけ通れる
  wide?: boolean; // 2マス幅（大通り）
  rank: number; // 上書きするときの優先度
  highway?: boolean; // 高速道路（一般の道路とは直接つながらない）
  elevated?: boolean; // 上空の階層に作る
  lift?: number; // 地面からの高さ（上空の階層）
}

export const ROADS: Record<number, RoadDef> = {
  [RoadType.Street]: { id: RoadType.Street, name: '街路', speedKmh: 30, capacity: 900, cost: 10, upkeep: 0.1, width: 7, rank: 1 },
  [RoadType.Road]: { id: RoadType.Road, name: '一般道', speedKmh: 50, capacity: 2400, cost: 20, upkeep: 0.2, width: 10, rank: 2 },
  [RoadType.OneWay]: { id: RoadType.OneWay, name: '一方通行', speedKmh: 50, capacity: 3000, cost: 25, upkeep: 0.25, width: 10, oneWay: true, rank: 3 },
  [RoadType.Avenue]: { id: RoadType.Avenue, name: '大通り', speedKmh: 60, capacity: 3600, cost: 30, upkeep: 0.3, width: 11, oneWay: true, wide: true, rank: 4 },
  [RoadType.Highway]: { id: RoadType.Highway, name: '高架高速道路', speedKmh: 100, capacity: 7000, cost: 120, upkeep: 1.0, width: 13, oneWay: true, wide: true, rank: 6, highway: true, elevated: true, lift: 10 },
  [RoadType.GroundHighway]: { id: RoadType.GroundHighway, name: '地上の高速道路', speedKmh: 90, capacity: 6500, cost: 60, upkeep: 0.6, width: 13, oneWay: true, wide: true, rank: 5, highway: true },
  [RoadType.Ramp]: { id: RoadType.Ramp, name: 'ランプ', speedKmh: 50, capacity: 3000, cost: 0, upkeep: 0.3, width: 9, rank: 0 },
};

export const OVERPASS_LIFT = 7.5; // 地上の高速道路をまたぐ道路の高さ
export const RAMP_COST = 600; // ランプ1か所
export const isHighway = (t: number) => t === RoadType.Highway || t === RoadType.GroundHighway;

export const BRIDGE_COST_MUL = 6; // 橋は建設費が何倍か
export const MAX_BRIDGE = 24; // 橋の最大の長さ（マス）

export const POWER_LINE_COST = 4;
export const POWER_LINE_UPKEEP = 0.03;

// ---- ゾーン ----
export enum ZoneType {
  None = 0,
  R = 1,
  C = 2,
  I = 3,
}
export const ZONE_NAMES = ['なし', '住宅', '商業', '工業'];
export const DENSITY_NAMES = ['低密度', '中密度', '高密度'];
// 1マスあたりのゾーン指定の費用 [ゾーン][密度]
export const ZONE_COST = [
  [0, 0, 0],
  [4, 8, 15],
  [5, 10, 18],
  [6, 12, 20],
];

// ---- 成長する建物の種類（SC4 と同じ区分） ----
export type GrowKind = 'R1' | 'R2' | 'R3' | 'CS1' | 'CS2' | 'CS3' | 'CO2' | 'CO3' | 'IA' | 'ID' | 'IM';
export const GROW_KINDS: GrowKind[] = ['R1', 'R2', 'R3', 'CS1', 'CS2', 'CS3', 'CO2', 'CO3', 'IA', 'ID', 'IM'];

type Size = [number, number];
export interface GrowDef {
  kind: GrowKind;
  zone: ZoneType;
  name: string;
  capPerCell: number; // 1マスあたりの住人数 or 雇用数（低密度）
  floorCap: number; // 中・高密度で、1階・1マスあたりの住人数 or 雇用数
  wealth: number; // 税収の係数
  dens: number[]; // 建つことができる密度
  sizes: Size[][]; // 密度ごとの敷地の候補（w, h）
  floors: [number, number][]; // 密度ごとの階数の範囲（低密度は参考）
  pollution: number; // 1マスあたりの大気汚染
  powerPer: number; // 住人/雇用1あたりの電力
  waterPer: number; // 住人/雇用1あたりの水
}

const S_LOW_R: Size[] = [[1, 1], [1, 1], [1, 2], [2, 1]];
const S_MID: Size[] = [[1, 1], [1, 2], [2, 1], [2, 2], [2, 2], [3, 2], [2, 3]];
const S_HIGH: Size[] = [[1, 1], [2, 1], [1, 2], [2, 2], [2, 2], [3, 3], [3, 2], [2, 3]];
const S_IND_MID: Size[] = [[2, 2], [3, 2], [2, 3], [3, 3], [4, 3]];
const S_IND_HIGH: Size[] = [[3, 3], [4, 3], [3, 4], [4, 4]];

export const GROW: Record<GrowKind, GrowDef> = {
  R1: { kind: 'R1', zone: ZoneType.R, name: '住宅（低所得）', capPerCell: 14, floorCap: 5, wealth: 0.6, dens: [0, 1, 2], sizes: [S_LOW_R, S_MID, S_HIGH], floors: [[1, 2], [3, 6], [8, 24]], pollution: 0, powerPer: 0.05, waterPer: 0.1 },
  R2: { kind: 'R2', zone: ZoneType.R, name: '住宅（中所得）', capPerCell: 10, floorCap: 4, wealth: 1.0, dens: [0, 1, 2], sizes: [[[1, 1], [1, 2], [2, 1], [2, 2]], S_MID, S_HIGH], floors: [[1, 2], [3, 8], [10, 36]], pollution: 0, powerPer: 0.06, waterPer: 0.12 },
  R3: { kind: 'R3', zone: ZoneType.R, name: '住宅（高所得）', capPerCell: 6, floorCap: 3, wealth: 1.8, dens: [0, 1, 2], sizes: [[[2, 2], [1, 2], [2, 1]], S_MID, S_HIGH], floors: [[2, 3], [3, 8], [12, 45]], pollution: 0, powerPer: 0.08, waterPer: 0.15 },
  CS1: { kind: 'CS1', zone: ZoneType.C, name: '商業（低所得向け）', capPerCell: 9, floorCap: 3, wealth: 0.7, dens: [0, 1, 2], sizes: [[[1, 1], [1, 1], [2, 1], [1, 2]], S_MID, S_MID], floors: [[1, 1], [2, 4], [3, 8]], pollution: 0.05, powerPer: 0.06, waterPer: 0.05 },
  CS2: { kind: 'CS2', zone: ZoneType.C, name: '商業（中所得向け）', capPerCell: 8, floorCap: 3, wealth: 1.0, dens: [0, 1, 2], sizes: [[[1, 1], [2, 1], [1, 2], [2, 2]], S_MID, S_HIGH], floors: [[1, 2], [2, 5], [4, 14]], pollution: 0.05, powerPer: 0.07, waterPer: 0.05 },
  CS3: { kind: 'CS3', zone: ZoneType.C, name: '商業（高所得向け）', capPerCell: 6, floorCap: 3, wealth: 1.6, dens: [0, 1, 2], sizes: [[[1, 1], [2, 1], [1, 2], [2, 2]], S_MID, S_HIGH], floors: [[1, 2], [2, 6], [5, 20]], pollution: 0.03, powerPer: 0.08, waterPer: 0.06 },
  CO2: { kind: 'CO2', zone: ZoneType.C, name: 'オフィス（中所得）', capPerCell: 0, floorCap: 8, wealth: 1.2, dens: [1, 2], sizes: [[], S_MID, S_HIGH], floors: [[1, 1], [4, 10], [10, 30]], pollution: 0.02, powerPer: 0.08, waterPer: 0.04 },
  CO3: { kind: 'CO3', zone: ZoneType.C, name: 'オフィス（高所得）', capPerCell: 0, floorCap: 8, wealth: 1.8, dens: [1, 2], sizes: [[], S_MID, S_HIGH], floors: [[1, 1], [5, 12], [15, 60]], pollution: 0.02, powerPer: 0.09, waterPer: 0.04 },
  IA: { kind: 'IA', zone: ZoneType.I, name: '農業', capPerCell: 1.5, floorCap: 0, wealth: 0.5, dens: [0], sizes: [[[3, 3], [2, 3], [3, 2], [4, 4], [2, 2]]], floors: [[1, 1]], pollution: 0.05, powerPer: 0.05, waterPer: 0.3 },
  ID: { kind: 'ID', zone: ZoneType.I, name: '汚染型工業', capPerCell: 18, floorCap: 0, wealth: 0.8, dens: [0, 1, 2], sizes: [[[2, 2], [3, 2], [2, 3], [3, 3], [1, 2]], S_IND_MID, S_IND_HIGH], floors: [[1, 1], [1, 1], [1, 1]], pollution: 1.0, powerPer: 0.12, waterPer: 0.1 },
  IM: { kind: 'IM', zone: ZoneType.I, name: '製造業', capPerCell: 14, floorCap: 0, wealth: 1.1, dens: [0, 1, 2], sizes: [[[2, 2], [3, 2], [2, 3], [3, 3]], S_IND_MID, S_IND_HIGH], floors: [[1, 1], [1, 1], [1, 1]], pollution: 0.45, powerPer: 0.1, waterPer: 0.1 },
};

// 工業は密度で1マスあたりの雇用数が増える
export const IND_DENSITY_MUL = [1, 1.7, 2.6];

export const ZONE_KINDS: Record<number, GrowKind[]> = {
  [ZoneType.R]: ['R1', 'R2', 'R3'],
  [ZoneType.C]: ['CS1', 'CS2', 'CS3', 'CO2', 'CO3'],
  [ZoneType.I]: ['IA', 'ID', 'IM'],
};

export const TAX_LABELS: Record<GrowKind, string> = {
  R1: '住宅 $', R2: '住宅 $$', R3: '住宅 $$$',
  CS1: '商業 $', CS2: '商業 $$', CS3: '商業 $$$',
  CO2: 'オフィス $$', CO3: 'オフィス $$$',
  IA: '農業', ID: '汚染型工業', IM: '製造業',
};

// 人口に応じた最大の階数（小さな街に超高層ビルは建たない）
export function maxFloorsFor(pop: number) {
  if (pop < 2000) return 6;
  if (pop < 6000) return 12;
  if (pop < 15000) return 20;
  if (pop < 40000) return 35;
  if (pop < 90000) return 50;
  return 60;
}

// ---- 公共施設 ----
export type CivicId = 'coal' | 'gas' | 'pump' | 'tower' | 'park_s' | 'park_l' | 'plaza';

export interface CivicDef {
  id: CivicId;
  name: string;
  w: number;
  h: number;
  cost: number;
  upkeep: number;
  power?: number; // 発電量（MW）
  water?: number; // 給水量
  pollution?: number; // 大気汚染（施設全体）
  park?: number; // 地価への効果
  needsPower?: boolean;
  desc: string;
}

export const CIVIC: Record<CivicId, CivicDef> = {
  coal: { id: 'coal', name: '石炭火力発電所', w: 4, h: 4, cost: 12000, upkeep: 220, power: 900, pollution: 30, desc: '安くて発電量が多いが、大気汚染がひどい' },
  gas: { id: 'gas', name: 'ガス火力発電所', w: 3, h: 3, cost: 18000, upkeep: 260, power: 550, pollution: 8, desc: '汚染が少ないが、費用が高い' },
  pump: { id: 'pump', name: '揚水ポンプ', w: 2, h: 2, cost: 2500, upkeep: 80, water: 1200, needsPower: true, desc: '周りの道路に沿って水を送る。電力が必要' },
  tower: { id: 'tower', name: '給水塔', w: 1, h: 1, cost: 600, upkeep: 25, water: 350, needsPower: true, desc: '小さな給水施設。電力が必要' },
  park_s: { id: 'park_s', name: '小さな公園', w: 1, h: 1, cost: 150, upkeep: 6, park: 0.12, desc: '周りの地価が少し上がる' },
  park_l: { id: 'park_l', name: '大きな公園', w: 3, h: 3, cost: 1200, upkeep: 30, park: 0.3, desc: '周りの地価が上がる' },
  plaza: { id: 'plaza', name: '広場', w: 2, h: 2, cost: 500, upkeep: 12, park: 0.18, desc: '商業地の地価が上がる' },
};

export const DIFFICULTY = [
  { name: 'かんたん', funds: 200000, demand: 1.25 },
  { name: 'ふつう', funds: 100000, demand: 1.0 },
  { name: 'むずかしい', funds: 50000, demand: 0.8 },
] as const;

export const DEFAULT_TAX = 9; // 税率（%）
