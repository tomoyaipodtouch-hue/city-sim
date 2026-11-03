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
export type GrowKind = 'R1' | 'R2' | 'R3' | 'CS1' | 'CS2' | 'CS3' | 'CO2' | 'CO3' | 'IA' | 'ID' | 'IM' | 'IH';
export const GROW_KINDS: GrowKind[] = ['R1', 'R2', 'R3', 'CS1', 'CS2', 'CS3', 'CO2', 'CO3', 'IA', 'ID', 'IM', 'IH'];

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
  IH: { kind: 'IH', zone: ZoneType.I, name: 'ハイテク産業', capPerCell: 10, floorCap: 0, wealth: 1.7, dens: [1, 2], sizes: [[], S_IND_MID, S_IND_HIGH], floors: [[1, 1], [1, 1], [1, 1]], pollution: 0.05, powerPer: 0.14, waterPer: 0.06 },
};

// 工業は密度で1マスあたりの雇用数が増える
export const IND_DENSITY_MUL = [1, 1.7, 2.6];

export const ZONE_KINDS: Record<number, GrowKind[]> = {
  [ZoneType.R]: ['R1', 'R2', 'R3'],
  [ZoneType.C]: ['CS1', 'CS2', 'CS3', 'CO2', 'CO3'],
  [ZoneType.I]: ['IA', 'ID', 'IM', 'IH'],
};

export const TAX_LABELS: Record<GrowKind, string> = {
  R1: '住宅 $', R2: '住宅 $$', R3: '住宅 $$$',
  CS1: '商業 $', CS2: '商業 $$', CS3: '商業 $$$',
  CO2: 'オフィス $$', CO3: 'オフィス $$$',
  IA: '農業', ID: '汚染型工業', IM: '製造業', IH: 'ハイテク産業',
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
// ---- 公共交通の線路 ----
export type LineKind = 'rail' | 'erail' | 'mono' | 'sub';
export const LINE_KINDS: LineKind[] = ['rail', 'erail', 'mono', 'sub'];
export interface LineDef {
  kind: LineKind;
  name: string;
  speedKmh: number; // 駅の停車も含めた平均の速さ
  cost: number; // 1マスの建設費
  upkeep: number; // 1マスの月額維持費
  lift: number; // 地面からの高さ（地下鉄はマイナス）
  wait: number; // 乗るときの平均の待ち時間（分）
}
export const LINES: Record<LineKind, LineDef> = {
  rail: { kind: 'rail', name: '鉄道', speedKmh: 60, cost: 40, upkeep: 0.4, lift: 0, wait: 4 },
  erail: { kind: 'erail', name: '高架鉄道', speedKmh: 55, cost: 120, upkeep: 0.8, lift: 8, wait: 3.5 },
  mono: { kind: 'mono', name: 'モノレール', speedKmh: 75, cost: 160, upkeep: 1.0, lift: 11, wait: 3 },
  sub: { kind: 'sub', name: '地下鉄', speedKmh: 55, cost: 200, upkeep: 1.2, lift: -9, wait: 3 },
};
export const BUS_WAIT = 5; // バスの平均の待ち時間（分）
export const BUS_STOP_COST = 150;
export const BUS_STOP_UPKEEP = 15;
export const FARE = 1.0; // 1日の乗客1人あたりの、月の運賃収入

// ---- 公共サービス ----
export type ServiceKind = 'police' | 'fire' | 'health' | 'school' | 'high' | 'college' | 'library' | 'landfill' | 'incinerator' | 'recycling';
// 予算の部門
export type Dept = 'police' | 'fire' | 'health' | 'education' | 'transit' | 'garbage';
export const DEPTS: Dept[] = ['police', 'fire', 'health', 'education', 'transit', 'garbage'];
export const DEPT_NAMES: Record<Dept, string> = { police: '警察', fire: '消防', health: '医療', education: '教育', transit: '公共交通', garbage: 'ゴミ処理' };
export const SERVICE_DEPT: Record<ServiceKind, Dept> = {
  police: 'police', fire: 'fire', health: 'health', school: 'education', high: 'education', college: 'education', library: 'education',
  landfill: 'garbage', incinerator: 'garbage', recycling: 'garbage',
};
// ゴミ（1人・1雇用あたり、月）
export const GARBAGE_PER_RES = 0.9;
export const GARBAGE_PER_JOB = 0.6;

export type CivicId = 'coal' | 'gas' | 'oil' | 'nuclear' | 'wind' | 'solar' | 'pump' | 'tower' | 'park_s' | 'park_l' | 'plaza' | 'busstop' | 'station' | 'el_station' | 'mono_station' | 'sub_station'
  | 'ferry_p' | 'ferry_c' | 'seaport' | 'airport_s' | 'airport_l' | 'freight_st'
  | 'police_s' | 'police_l' | 'fire_s' | 'fire_l' | 'clinic' | 'hospital' | 'school_e' | 'school_h' | 'college' | 'library'
  | 'landfill' | 'incinerator' | 'recycling'
  | 'mayor_house' | 'city_hall' | 'statue' | 'museum' | 'stadium';

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
  transit?: 'bus' | LineKind; // 公共交通の駅・停留所
  ferry?: 'passenger' | 'car'; // フェリー乗り場
  waterfront?: boolean; // 水辺に置く必要がある
  seaport?: boolean;
  airport?: number; // 空港の規模（1 = 小, 2 = 大）
  freightRail?: boolean; // 貨物駅
  service?: ServiceKind; // 公共サービス
  radius?: number; // 効果が届く範囲（マス）
  capacity?: number; // 受け入れ人数（学校の席、病院のベッドなど）／ゴミの処理量（月）
  reward?: boolean; // 記念施設（条件を満たすと建てられる）
  desc: string;
}

export const CIVIC: Record<CivicId, CivicDef> = {
  coal: { id: 'coal', name: '石炭火力発電所', w: 4, h: 4, cost: 12000, upkeep: 220, power: 900, pollution: 30, desc: '安くて発電量が多いが、大気汚染がひどい' },
  gas: { id: 'gas', name: 'ガス火力発電所', w: 3, h: 3, cost: 18000, upkeep: 260, power: 550, pollution: 8, desc: '汚染が少ないが、費用が高い' },
  oil: { id: 'oil', name: '石油火力発電所', w: 4, h: 4, cost: 15000, upkeep: 250, power: 700, pollution: 20, desc: '石炭より汚染が少なく、ガスより発電量が多い' },
  nuclear: { id: 'nuclear', name: '原子力発電所', w: 5, h: 5, cost: 60000, upkeep: 750, power: 3600, pollution: 0, desc: '発電量がとても多く、大気を汚さない。建設費と維持費が高い' },
  wind: { id: 'wind', name: '風力発電機', w: 1, h: 1, cost: 1500, upkeep: 20, power: 40, pollution: 0, desc: '小さくて汚染がない。高い場所ほど発電量が多い（最大 64 MW）' },
  solar: { id: 'solar', name: '太陽光発電所', w: 3, h: 3, cost: 20000, upkeep: 110, power: 300, pollution: 0, desc: '汚染がないが、広さの割に発電量が少ない' },
  pump: { id: 'pump', name: '揚水ポンプ', w: 2, h: 2, cost: 2500, upkeep: 80, water: 1200, needsPower: true, desc: '周りの道路に沿って水を送る。電力が必要' },
  tower: { id: 'tower', name: '給水塔', w: 1, h: 1, cost: 600, upkeep: 25, water: 350, needsPower: true, desc: '小さな給水施設。電力が必要' },
  park_s: { id: 'park_s', name: '小さな公園', w: 1, h: 1, cost: 150, upkeep: 6, park: 0.12, desc: '周りの地価が少し上がる' },
  park_l: { id: 'park_l', name: '大きな公園', w: 3, h: 3, cost: 1200, upkeep: 30, park: 0.3, desc: '周りの地価が上がる' },
  plaza: { id: 'plaza', name: '広場', w: 2, h: 2, cost: 500, upkeep: 12, park: 0.18, desc: '商業地の地価が上がる' },
  busstop: { id: 'busstop', name: 'バス停', w: 1, h: 1, cost: 150, upkeep: 15, transit: 'bus', desc: '道路沿いに置くと、近くの住人がバスを使う。路線は自動で決まる' },
  station: { id: 'station', name: '鉄道の駅', w: 2, h: 2, cost: 3000, upkeep: 60, transit: 'rail', desc: '線路と道路の両方に接するように置く' },
  el_station: { id: 'el_station', name: '高架鉄道の駅', w: 2, h: 2, cost: 4000, upkeep: 70, transit: 'erail', desc: '高架鉄道の線路と道路の両方に接するように置く' },
  mono_station: { id: 'mono_station', name: 'モノレールの駅', w: 2, h: 2, cost: 5000, upkeep: 80, transit: 'mono', desc: 'モノレールの線路と道路の両方に接するように置く' },
  sub_station: { id: 'sub_station', name: '地下鉄の駅', w: 1, h: 1, cost: 3500, upkeep: 70, transit: 'sub', desc: '地下鉄の線路の上か隣に、道路に接するように置く' },
  ferry_p: { id: 'ferry_p', name: '旅客フェリー乗り場', w: 2, h: 2, cost: 3000, upkeep: 60, ferry: 'passenger', waterfront: true, desc: '水辺に、道路に接するように置く。同じ水域の乗り場どうしが航路で結ばれる' },
  ferry_c: { id: 'ferry_c', name: 'カーフェリー乗り場', w: 3, h: 3, cost: 6000, upkeep: 110, ferry: 'car', waterfront: true, desc: '車ごと乗れるフェリー。水域がマップの端まで続いていれば、隣の都市へも行ける' },
  seaport: { id: 'seaport', name: '港', w: 4, h: 4, cost: 25000, upkeep: 300, seaport: true, waterfront: true, pollution: 6, desc: '工業の需要が上がり、トラックが荷物を運べる。水域がマップの端まで続いている必要がある' },
  airport_s: { id: 'airport_s', name: '空港（小）', w: 4, h: 10, cost: 30000, upkeep: 350, airport: 1, pollution: 4, desc: '商業とオフィスの需要が上がる。周りは騒音で地価が下がる' },
  airport_l: { id: 'airport_l', name: '空港（大）', w: 7, h: 16, cost: 90000, upkeep: 900, airport: 2, pollution: 10, desc: '商業とオフィスの需要が大きく上がる。周りは騒音で地価が下がる' },
  police_s: { id: 'police_s', name: '交番', w: 1, h: 1, cost: 800, upkeep: 60, service: 'police', radius: 9, desc: '周りの犯罪を減らす（小さな範囲）' },
  police_l: { id: 'police_l', name: '警察署', w: 3, h: 2, cost: 5000, upkeep: 260, service: 'police', radius: 20, desc: '広い範囲の犯罪を減らす' },
  fire_s: { id: 'fire_s', name: '消防分署', w: 2, h: 2, cost: 2500, upkeep: 120, service: 'fire', radius: 14, desc: '周りの火災の危険を減らす' },
  fire_l: { id: 'fire_l', name: '消防署', w: 3, h: 3, cost: 7000, upkeep: 300, service: 'fire', radius: 24, desc: '広い範囲の火災の危険を減らす' },
  clinic: { id: 'clinic', name: '診療所', w: 2, h: 2, cost: 3000, upkeep: 150, service: 'health', radius: 14, capacity: 2500, desc: '周りの住人の健康を守る（2,500人まで）' },
  hospital: { id: 'hospital', name: '病院', w: 3, h: 4, cost: 15000, upkeep: 600, service: 'health', radius: 28, capacity: 12000, desc: '広い範囲の住人の健康を守る（12,000人まで）' },
  school_e: { id: 'school_e', name: '小中学校', w: 3, h: 2, cost: 4000, upkeep: 220, service: 'school', radius: 18, capacity: 1200, desc: '子どもの教育水準を上げる（1,200人分の席）' },
  school_h: { id: 'school_h', name: '高校', w: 3, h: 3, cost: 8000, upkeep: 380, service: 'high', radius: 26, capacity: 1500, desc: '子どもの教育水準をさらに上げる（1,500人分の席）' },
  college: { id: 'college', name: '大学', w: 4, h: 4, cost: 30000, upkeep: 900, service: 'college', capacity: 5000, desc: '大人の教育水準を上げる。街全体に効く' },
  library: { id: 'library', name: '図書館', w: 2, h: 2, cost: 2500, upkeep: 100, service: 'library', radius: 16, desc: '周りの住人の教育水準を少し上げる' },
  landfill: { id: 'landfill', name: '埋立地', w: 4, h: 4, cost: 2000, upkeep: 80, service: 'landfill', capacity: 6000, pollution: 4, desc: '月 6,000 のゴミを処理する。周りの地価が下がる' },
  incinerator: { id: 'incinerator', name: '焼却場', w: 3, h: 3, cost: 9000, upkeep: 260, service: 'incinerator', capacity: 9000, pollution: 14, desc: '月 9,000 のゴミを処理する。大気汚染がある' },
  mayor_house: { id: 'mayor_house', name: '市長公邸', w: 2, h: 2, cost: 1000, upkeep: 20, park: 0.15, reward: true, desc: '記念施設。周りの地価が上がり、市長評価が上がる' },
  city_hall: { id: 'city_hall', name: '市役所', w: 4, h: 3, cost: 12000, upkeep: 120, park: 0.2, reward: true, desc: '記念施設。周りの地価が上がり、市長評価が上がる' },
  statue: { id: 'statue', name: '市長の銅像', w: 1, h: 1, cost: 500, upkeep: 5, park: 0.1, reward: true, desc: '記念施設。市長評価が上がる' },
  museum: { id: 'museum', name: '博物館', w: 3, h: 3, cost: 15000, upkeep: 200, park: 0.25, reward: true, desc: '記念施設。周りの地価と、大人の教育水準が上がる' },
  stadium: { id: 'stadium', name: 'スタジアム', w: 6, h: 6, cost: 40000, upkeep: 400, park: 0.1, reward: true, desc: '記念施設。商業の需要が上がり、市長評価が上がる' },
  recycling: { id: 'recycling', name: 'リサイクルセンター', w: 3, h: 2, cost: 6000, upkeep: 200, service: 'recycling', capacity: 4000, desc: 'ゴミを月 4,000 減らす' },
  freight_st: { id: 'freight_st', name: '貨物駅', w: 3, h: 2, cost: 8000, upkeep: 120, freightRail: true, desc: '線路と道路に接するように置く。線路がマップの端まで続いていれば、トラックの荷物を鉄道で運ぶ' },
};

export const DIFFICULTY = [
  { name: 'かんたん', funds: 200000, demand: 1.25 },
  { name: 'ふつう', funds: 100000, demand: 1.0 },
  { name: 'むずかしい', funds: 50000, demand: 0.8 },
] as const;

export const DEFAULT_TAX = 9; // 税率（%）

// 発電量（MW）。風力は高い場所ほど多い（地面の高さ 0m で半分、40m で 1.6 倍）
export function plantPower(id: CivicId, groundH: number) {
  const p = CIVIC[id].power ?? 0;
  if (id === 'wind') return Math.round(p * Math.max(0.5, Math.min(1.6, 0.5 + groundH / 36)));
  return p;
}
