// ゲーム内のデータ定義（道路、ゾーン、建物、公共施設）

// ---- 道路 ----
export enum RoadType {
  None = 0,
  Street = 1,
  Road = 2,
}

export interface RoadDef {
  id: RoadType;
  name: string;
  speedKmh: number; // 制限速度
  capacity: number; // 1日あたりの容量（台）
  cost: number; // 1マスの建設費
  upkeep: number; // 1マスの月額維持費
  width: number; // 描画上の幅（m）
}

export const ROADS: Record<number, RoadDef> = {
  [RoadType.Street]: { id: RoadType.Street, name: '通り', speedKmh: 30, capacity: 900, cost: 10, upkeep: 0.1, width: 7 },
  [RoadType.Road]: { id: RoadType.Road, name: '一般道', speedKmh: 50, capacity: 2400, cost: 20, upkeep: 0.2, width: 10 },
};

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
export const ZONE_COST = [0, 4, 5, 6]; // 1マスあたり（低密度）

// ---- 成長する建物の種類（SC4 と同じ区分） ----
export type GrowKind = 'R1' | 'R2' | 'R3' | 'CS1' | 'CS2' | 'CS3' | 'IA' | 'ID' | 'IM';
export const GROW_KINDS: GrowKind[] = ['R1', 'R2', 'R3', 'CS1', 'CS2', 'CS3', 'IA', 'ID', 'IM'];

export interface GrowDef {
  kind: GrowKind;
  zone: ZoneType;
  name: string;
  capPerCell: number; // 1マスあたりの住人数 or 雇用数（低密度）
  wealth: number; // 税収の係数
  sizes: [number, number][]; // 敷地の候補（w, h）
  pollution: number; // 1マスあたりの大気汚染
  powerPer: number; // 住人/雇用1あたりの電力
  waterPer: number; // 住人/雇用1あたりの水
}

export const GROW: Record<GrowKind, GrowDef> = {
  R1: { kind: 'R1', zone: ZoneType.R, name: '住宅（低所得）', capPerCell: 14, wealth: 0.6, sizes: [[1, 1], [1, 1], [1, 2], [2, 1]], pollution: 0, powerPer: 0.05, waterPer: 0.1 },
  R2: { kind: 'R2', zone: ZoneType.R, name: '住宅（中所得）', capPerCell: 10, wealth: 1.0, sizes: [[1, 1], [1, 2], [2, 1], [2, 2]], pollution: 0, powerPer: 0.06, waterPer: 0.12 },
  R3: { kind: 'R3', zone: ZoneType.R, name: '住宅（高所得）', capPerCell: 6, wealth: 1.8, sizes: [[2, 2], [1, 2], [2, 1]], pollution: 0, powerPer: 0.08, waterPer: 0.15 },
  CS1: { kind: 'CS1', zone: ZoneType.C, name: '商業（低所得向け）', capPerCell: 9, wealth: 0.7, sizes: [[1, 1], [1, 1], [2, 1], [1, 2]], pollution: 0.05, powerPer: 0.06, waterPer: 0.05 },
  CS2: { kind: 'CS2', zone: ZoneType.C, name: '商業（中所得向け）', capPerCell: 8, wealth: 1.0, sizes: [[1, 1], [2, 1], [1, 2], [2, 2]], pollution: 0.05, powerPer: 0.07, waterPer: 0.05 },
  CS3: { kind: 'CS3', zone: ZoneType.C, name: '商業（高所得向け）', capPerCell: 6, wealth: 1.6, sizes: [[1, 1], [2, 1], [1, 2], [2, 2]], pollution: 0.03, powerPer: 0.08, waterPer: 0.06 },
  IA: { kind: 'IA', zone: ZoneType.I, name: '農業', capPerCell: 1.5, wealth: 0.5, sizes: [[3, 3], [2, 3], [3, 2], [4, 4], [2, 2]], pollution: 0.05, powerPer: 0.05, waterPer: 0.3 },
  ID: { kind: 'ID', zone: ZoneType.I, name: '汚染型工業', capPerCell: 18, wealth: 0.8, sizes: [[2, 2], [3, 2], [2, 3], [3, 3], [1, 2]], pollution: 1.0, powerPer: 0.12, waterPer: 0.1 },
  IM: { kind: 'IM', zone: ZoneType.I, name: '製造業', capPerCell: 14, wealth: 1.1, sizes: [[2, 2], [3, 2], [2, 3], [3, 3]], pollution: 0.45, powerPer: 0.1, waterPer: 0.1 },
};

export const ZONE_KINDS: Record<number, GrowKind[]> = {
  [ZoneType.R]: ['R1', 'R2', 'R3'],
  [ZoneType.C]: ['CS1', 'CS2', 'CS3'],
  [ZoneType.I]: ['IA', 'ID', 'IM'],
};

export const TAX_LABELS: Record<GrowKind, string> = {
  R1: '住宅 $', R2: '住宅 $$', R3: '住宅 $$$',
  CS1: '商業 $', CS2: '商業 $$', CS3: '商業 $$$',
  IA: '農業', ID: '汚染型工業', IM: '製造業',
};

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
