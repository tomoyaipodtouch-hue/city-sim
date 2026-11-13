// 空港（小・中・大）の共通の仕組み：敷地の形（縦横と斜め）、空港の配置（滑走路・誘導路・駐機場・建物）、
// 置く場所の計画（埋め立て・岸壁・赤いマスと理由）、空港駅と高速道路の出入口、騒音の範囲、運航の数字。
// シミュレーション（Worker）と画面の両方で使う（three.js には触らない）。
//
// 座標：空港の「敷地の座標」は m。a = 滑走路の向き（長い辺）、c = 横の向き。+c が陸側（ターミナル・道路・駅）、-c が滑走路の側。
// 敷地の中心が (0, 0)。向き rot は 8 方向（DX/DY の番号）で、陸側が向く方角。偶数は縦横、奇数は斜め（45°）。
// 世界の座標（X = 東、Z = 南、m）へは、角度 θ = (rot - 2)·π/4 で回す（建物の正面 face と同じ決まり：rot 2 = 陸側が南）。
import { CELL, DX, DY, QUAY_LAND, WATER_LEVEL } from './constants';
import type { Grid } from './grid';
import { isHighway, isUrbanElevated, isUrbanGround, RoadType } from './defs';
import type { LineKind } from './defs';
import type { FcSpec } from './forecourt';

export type AirportSize = 1 | 2 | 3;

// ---- 規模ごとの数字 ----
export interface AirportSpec {
  size: AirportSize;
  L: number; // 長い辺（マス）
  W: number; // 短い辺（マス）
  cost: number;
  upkeep: number; // 月
  pollution: number;
  boost: number; // 商業・オフィスの需要（いちばん使われているとき）
  paxCap: number; // 1日の利用者の上限
  paxPerFlight: number; // 1便あたりの平均の乗客
  maxAircraft: number; // 画面に同時に出す飛行機（駐機・走行・飛行の合計）
  freightShare: number; // ハイテク産業の貨物のうち、空港へ運ぶ割合
  noiseLen: number; // 騒音の範囲：滑走路の端から先へのびる長さ（m）
  noiseWidth: number; // 騒音の範囲：滑走路の中心線からの横の幅（m）
  draw: number; // 行き先（便の多さ）による利用者の集まりやすさ（小 = 1）。大きい空港ほど、同じ街から多くの人が使う
}
export const AIRPORT_SPECS: Record<AirportSize, AirportSpec> = {
  1: { size: 1, L: 60, W: 12, cost: 80000, upkeep: 650, pollution: 5, boost: 0.15, paxCap: 1600, paxPerFlight: 55, maxAircraft: 3, freightShare: 0.25, noiseLen: 1300, noiseWidth: 230, draw: 1 },
  2: { size: 2, L: 85, W: 18, cost: 300000, upkeep: 1500, pollution: 9, boost: 0.25, paxCap: 6000, paxPerFlight: 120, maxAircraft: 6, freightShare: 0.35, noiseLen: 2000, noiseWidth: 320, draw: 2.5 },
  3: { size: 3, L: 100, W: 40, cost: 1000000, upkeep: 5000, pollution: 14, boost: 0.35, paxCap: 20000, paxPerFlight: 180, maxAircraft: 12, freightShare: 0.45, noiseLen: 2600, noiseWidth: 420, draw: 5 },
};

// 利用者・貨物・収入の計算に使う値（world.ts）
export const AIR_TRIP_RES = 0.02; // 住人 1 人・1 日あたりの空港への旅行（往復の片道）
export const AIR_TRIP_OFFICE = 0.04; // オフィスで働く 1 人・1 日あたりの出張
export const AIR_FEE_PAX = 0.55; // 利用者 1 人（1 日あたり）の月の収入（着陸料・旅客施設使用料）
export const AIR_FEE_FLIGHT = 4; // 1 便（1 日あたり）の月の着陸料
export const AIR_FEE_FREIGHT = 1.5; // 貨物のトラック 1 台（1 日あたり）の月の収入
export const AIR_FREIGHT_TONS = 1.5; // 航空貨物のトラック 1 台の荷物（t。軽くて高価なもの）
export const AIR_BELLY_TONS = 1.5; // 旅客便 1 便の床下の貨物室に積む荷物（t）
export const AIR_CARGO_TONS_PER_FLIGHT = 8; // 貨物機 1 便の荷物（t）
// 所要時間による利用のしやすさ（短いほど、この空港を使う）
export const airTimeWeight = (min: number) => Math.max(0.2, Math.min(1, 1.25 - min / 60));

// 空港の運航の様子（シミュレーションが月ごとに決める。画面と情報ツールで使う）
export interface AirStats {
  open: boolean; // 運航している（電力と道路がある）
  pax: number; // 1日の利用者
  paxRail: number; // そのうち鉄道・地下鉄などで来た人
  flights: number; // 1日の便数（旅客）
  cargoFlights: number; // 1日の貨物便
  freight: number; // 1日の貨物（t）
  lines: LineKind[]; // 空港駅につながっている線
  highway: boolean; // 正門に都市高速がつながっている
  road: boolean; // 正門に一般道がつながっている
  gate?: 'hw' | 'road' | null; // 正門につながっているもの
  svc?: boolean; // 通用門（貨物・整備地区）に一般道がつながっている
  legacy?: boolean; // 以前の空港：道路・都市高速を正門へつなぎ直せなかった
  noFc?: boolean; // ターミナル前の道路のマスを作れなかった（以前の空港で、敷地にほかのものがあった）。正門から直接ターミナルへ
  gateDir?: number; // 正門から外へ向かう向き（DX/DY の番号）
  income: number; // 月の収入
  note?: string;
}

// ---- 敷地の形 ----
export interface AirFrame {
  rot: number;
  cx: number; // 敷地の中心（世界の座標、m）
  cz: number;
  cos: number;
  sin: number;
  A: number; // 長い辺（m）
  C: number; // 短い辺（m）
}
export const rotAngle = (rot: number) => ((rot - 2) * Math.PI) / 4;
export function makeFrame(spec: AirportSpec, rot: number, cx: number, cz: number): AirFrame {
  const t = rotAngle(rot);
  return { rot, cx, cz, cos: Math.cos(t), sin: Math.sin(t), A: spec.L * CELL, C: spec.W * CELL };
}
// 建物（敷地の外の四角 x, y, w, h と、向き face = rot）から
export function frameOf(b: { x: number; y: number; w: number; h: number; face: number }, spec: AirportSpec): AirFrame {
  return makeFrame(spec, b.face & 7, (b.x + b.w / 2) * CELL, (b.y + b.h / 2) * CELL);
}
export function toWorld(f: AirFrame, a: number, c: number): [number, number] {
  return [a * f.cos - c * f.sin + f.cx, a * f.sin + c * f.cos + f.cz];
}
export function toLocal(f: AirFrame, X: number, Z: number): [number, number] {
  const dx = X - f.cx, dz = Z - f.cz;
  return [dx * f.cos + dz * f.sin, -dx * f.sin + dz * f.cos];
}

// マス (x, y) の四角が、敷地の長方形（少し内側に縮めたもの）と重なるか（分離軸の判定）
function cellHits(f: AirFrame, x: number, y: number, shrink = 0.5): boolean {
  const ha = f.A / 2 - shrink, hc = f.C / 2 - shrink;
  const qx = (x + 0.5) * CELL, qz = (y + 0.5) * CELL, hs = CELL / 2;
  // 長方形の軸に投影
  const [a, c] = toLocal(f, qx, qz);
  const ra = hs * (Math.abs(f.cos) + Math.abs(f.sin)); // マスの半分の大きさを、長方形の軸に投影したもの
  if (Math.abs(a) > ha + ra || Math.abs(c) > hc + ra) return false;
  // 世界の軸に投影（長方形の半分の大きさ）
  const rx = ha * Math.abs(f.cos) + hc * Math.abs(f.sin), rz = ha * Math.abs(f.sin) + hc * Math.abs(f.cos);
  return Math.abs(qx - f.cx) <= rx + hs && Math.abs(qz - f.cz) <= rz + hs;
}

export interface Footprint {
  x: number; // 外の四角
  y: number;
  w: number;
  h: number;
  cells: number[]; // 敷地のマス（マス番号）
  out: boolean; // マップからはみ出している
}
// 中心（世界の座標）と向きから、敷地のマス
export function footprintAt(n: number, spec: AirportSpec, rot: number, cx: number, cz: number): Footprint {
  const f = makeFrame(spec, rot, cx, cz);
  const rx = (f.A / 2) * Math.abs(f.cos) + (f.C / 2) * Math.abs(f.sin), rz = (f.A / 2) * Math.abs(f.sin) + (f.C / 2) * Math.abs(f.cos);
  const x0 = Math.floor((cx - rx) / CELL) - 1, x1 = Math.ceil((cx + rx) / CELL) + 1;
  const y0 = Math.floor((cz - rz) / CELL) - 1, y1 = Math.ceil((cz + rz) / CELL) + 1;
  const cells: number[] = [];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, out = false;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!cellHits(f, x, y)) continue;
      if (x < 0 || y < 0 || x >= n || y >= n) { out = true; continue; }
      cells.push(y * n + x);
      bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
    }
  return { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1, cells, out };
}

// 指でさしたマス (tx, ty) と向きから、敷地の中心。マップからはみ出さないように内側へずらす
export function placeCentre(n: number, spec: AirportSpec, rot: number, tx: number, ty: number): [number, number] {
  if (!(rot & 1)) {
    const along = rot === 0 || rot === 4 ? false : true; // 陸側が南北 → 長い辺は東西
    const w = along ? spec.L : spec.W, h = along ? spec.W : spec.L;
    const x = Math.max(0, Math.min(n - w, tx - Math.floor((w - 1) / 2)));
    const y = Math.max(0, Math.min(n - h, ty - Math.floor((h - 1) / 2)));
    return [(x + w / 2) * CELL, (y + h / 2) * CELL];
  }
  // 斜め：マスの中心を敷地の中心にする（敷地のマスが中心について対称になり、外の四角の中心とも一致する）
  const probe = footprintAt(1 << 12, spec, rot, (2048 + 0.5) * CELL, (2048 + 0.5) * CELL);
  const dx0 = probe.x - 2048, dx1 = probe.x + probe.w - 1 - 2048, dy0 = probe.y - 2048, dy1 = probe.y + probe.h - 1 - 2048;
  const x = Math.max(-dx0, Math.min(n - 1 - dx1, tx)), y = Math.max(-dy0, Math.min(n - 1 - dy1, ty));
  return [(x + 0.5) * CELL, (y + 0.5) * CELL];
}

// 置いた空港の敷地のマス（建物から）
export function airportCells(n: number, b: { x: number; y: number; w: number; h: number; face: number }, spec: AirportSpec): number[] {
  return footprintAt(n, spec, b.face & 7, (b.x + b.w / 2) * CELL, (b.y + b.h / 2) * CELL).cells;
}

// ---- 空港の配置（敷地の座標、m） ----
// 小・中・大の共通の形：滑走路、誘導路の網（ノードと辺）、出口（取付誘導路・高速脱出誘導路）、駐機スポット、建物の区画、陸側の道路と駅。
// 飛行機の動き（render/airport/ops.ts）と形（geometry.ts）はこの表だけを見る
export interface LRect { a0: number; c0: number; a1: number; c1: number }
// 滑走路から誘導路へ出る道（着陸した飛行機）。dir = 着陸の向き、pts = 滑走路の上の曲がりはじめから、止まる場所（node）まで
export interface ExitDef { dir: 1 | -1; a: number; pts: [number, number][]; node: number; speed: number; rapid: boolean }
export interface RunwayDef {
  c: number; // 中心線
  a0: number; // 両端
  a1: number;
  width: number;
  links: number[]; // 両端の取付誘導路の位置（a。[西, 東]）
  holdC: number; // 滑走路の手前の停止位置の標示（滑走路の側のふち、c）。出発機はこの手前の平行誘導路の上で待つ
  taxiC: number; // この滑走路の平行誘導路（c）
  side: 1 | -1; // 平行誘導路のある側（+1 = c の大きい側）
  junction: [number, number]; // 取付誘導路と平行誘導路の交わるノード（両端）
  exits: ExitDef[];
  td: number; // 滑走路の端から接地点まで（m）。目標点の標識（長さ 45m）は td - 40 から。滑走路の長さの 18% ほど（実際の空港の割合）
}
export interface StandDef {
  a: number; // 駐機スポットの中心線（a）。dir があるときは機首が止まる位置の a
  noseC: number; // 機首が止まる位置（c）
  dir?: [number, number]; // 機首の向き（なければ +c）
  cargo: boolean;
  wide: boolean; // ワイドボディが入れる
  bridge: boolean; // 搭乗橋がある
  node: number; // 誘導路の網の、スポットの入口のノード
  rot?: [number, number]; // 搭乗橋の回転する付け根（a, c）
}
// 駐機スポットの点：機首が止まる位置から、機首の向きと反対に back、左（機体の左の翼の側）へ side
export const standDir = (st: StandDef): [number, number] => st.dir ?? [0, 1];
export function standPt(st: StandDef, back: number, side = 0): [number, number] {
  const [ua, uc] = standDir(st);
  return [st.a - ua * back + uc * side, st.noseC - uc * back - ua * side];
}
// 機首から、スポットの前の誘導路（の中心線）までの距離
export function standLaneBack(L: AirportLayout, st: StandDef): number {
  if (!st.dir) return st.noseC - L.laneC;
  const [na, nc] = L.net.nodes[st.node], [ua, uc] = st.dir;
  return (st.a - na) * ua + (st.noseC - nc) * uc;
}
// 機首から、尾翼の後ろの構内道路（大）までの距離
export const standTailBack = (L: AirportLayout, st: StandDef) => standLaneBack(L, st) - L.taxiW / 2 - 12;
export interface TaxiNet {
  nodes: [number, number][];
  edges: [number, number][];
  width: number[]; // 辺ごとの幅（m）
}
export type AirBldKind = 'terminal' | 'pier' | 'concourse' | 'tower' | 'hotel' | 'office' | 'carpark' | 'station' | 'hangar' | 'fuel' | 'fire' | 'cargo' | 'plaza';
// sub = 陸側の座標（land）で置く。flip = 区画の中心で 180° 回す。ac = 格納庫の中の機体
export interface AirBld { kind: AirBldKind; r: LRect; h: number; sub?: boolean; flip?: boolean; ac?: AcKind; loop?: boolean }
export type AcKind = 'atr' | 'a220' | 'e190' | 'a320' | 'b737' | 'b787' | 'b777' | 'a350';
export interface AirportLayout {
  spec: AirportSpec;
  A: number;
  C: number;
  runways: RunwayDef[];
  net: TaxiNet;
  taxiC: number; // 平行誘導路の中心線（c）
  taxiW: number;
  laneC: number; // エプロンの誘導路（駐機スポットの前）
  aprons: LRect[];
  stands: StandDef[];
  types: AcKind[]; // 旅客便の機材（重みは並べた回数）
  wideTypes: AcKind[]; // ワイドボディのスポットだけに入る機材
  cargoTypes: AcKind[];
  walk: boolean; // 乗客が歩いて乗る（搭乗橋なし）
  serviceC: number; // エプロンの構内道路（c）。NaN = 大（尾翼の後ろの道路と、エプロンのふちの道路 gseRoad を通る）
  gseRoad?: number; // 大：エプロンのふちの構内道路（c）
  depot: [number, number]; // 地上の車両の車庫（a, c）
  buildings: AirBld[];
  roadC: [number, number]; // 陸側の道路（c の範囲）
  viaduct: { a0: number; a1: number; c0: number; c1: number; h: number; ramp: number }; // 高架の出発ロビー前の道路
  station: LRect; // 空港駅のホーム
  stationPort: LRect; // 線路が接していればよい範囲（敷地のマスの中心が入る範囲）
  gate: number; // 正門：陸側のふち（land の座標で c = edge）の a。ここから空港の大通りが入る
  svcGate: { a: number; c: number; na: number; nc: number }; // 通用門（貨物・整備地区）：敷地の座標の、ふちの点と外向きの向き
  svcRoads: [number, number][][]; // 通用門からの構内道路（敷地の座標。はじめの道の最初の点が門）
  land: { oa: number; oc: number; rot: number; A: number; edge: number }; // 陸側（道路・駅・ターミナル）の座標の置き方（敷地の座標で原点と回転）。A = 道路の長さ、edge = 陸側のふち
  parallel: boolean; // 着陸と出発を別の滑走路で同時に（大）。false なら地上は着陸と出発を交互に
  tower: [number, number, number]; // 管制塔（a, c, 高さ）
  masts: [number, number][]; // エプロンの照明塔
  glide: number; // 進入角（度）
  hangarType: AcKind; // 格納庫の中の機体
  fc: FcSpec; // ターミナル前の道路（フォアコート。forecourt.ts）
}

const layouts = new Map<AirportSize, AirportLayout>();
export function airportLayout(size: AirportSize): AirportLayout {
  let L = layouts.get(size);
  if (!L) layouts.set(size, (L = size === 1 ? layoutS(AIRPORT_SPECS[1]) : size === 2 ? layoutM(AIRPORT_SPECS[2]) : layoutL(AIRPORT_SPECS[3])));
  return L;
}

// 誘導路の網を組み立てる道具
function netBuilder() {
  const net: TaxiNet = { nodes: [], edges: [], width: [] };
  const node = (a: number, c: number) => {
    const k = net.nodes.findIndex(([x, y]) => Math.abs(x - a) < 0.01 && Math.abs(y - c) < 0.01);
    if (k >= 0) return k;
    net.nodes.push([a, c]);
    return net.nodes.length - 1;
  };
  const edge = (i: number, j: number, w: number) => { net.edges.push([i, j]); net.width.push(w); };
  // 同じ c の上の点を、a の順につなぐ
  const line = (c: number, as: number[], w: number) => {
    const ks = [...new Set(as)].sort((x, y) => x - y).map((a) => node(a, c));
    for (let k = 0; k + 1 < ks.length; k++) edge(ks[k], ks[k + 1], w);
    return ks;
  };
  // 同じ a の上の点を、c の順につなぐ（a に直角な誘導路）
  const vline = (a: number, cs: number[], w: number) => {
    const ks = [...new Set(cs)].sort((x, y) => x - y).map((c) => node(a, c));
    for (let k = 0; k + 1 < ks.length; k++) edge(ks[k], ks[k + 1], w);
    return ks;
  };
  return { net, node, edge, line, vline };
}

// 小：ロンドン・シティ空港のような街なかの空港。滑走路 800m（建物が少しデフォルメなので短め）、搭乗橋なしで歩いて乗る
function layoutS(spec: AirportSpec): AirportLayout {
  const A = spec.L * CELL, C = spec.W * CELL;
  const rwLen = 800, rwW = 30, rc = -C / 2 + 30;
  // 平行誘導路は、駐機している飛行機の尾と、誘導路を通る飛行機の翼が重ならない位置（翼端のすき間 2m 以上）
  const taxiC = -28, taxiW = 15;
  const linkA = rwLen / 2 - 15;
  const holdC = rc + rwW / 2 + 5;
  const standAs = [-55, 0, 55, 285];
  const { net, node, line } = netBuilder();
  line(taxiC, [-linkA, ...standAs, linkA], taxiW);
  const J = [node(-linkA, taxiC), node(linkA, taxiC)] as [number, number];
  const exits: ExitDef[] = [1, -1].map((dir) => {
    const far = dir > 0 ? linkA : -linkA, k = dir > 0 ? 1 : 0;
    return { dir: dir as 1 | -1, a: far - dir * 30, pts: [[far - dir * 30, rc], [far, rc], [far, taxiC]], node: J[k], speed: 11, rapid: false };
  });
  const runway: RunwayDef = { c: rc, a0: -rwLen / 2, a1: rwLen / 2, width: rwW, links: [-linkA, linkA], holdC, taxiC, side: 1, junction: J, exits, td: 150 };
  const stands: StandDef[] = standAs.map((a, k) => ({ a, noseC: k === 3 ? 20 : 31, cargo: k === 3, wide: false, bridge: false, node: node(a, taxiC) }));
  return {
    spec, A, C,
    runways: [runway], net,
    taxiC, taxiW, laneC: taxiC,
    aprons: [
      { a0: -150, c0: taxiC + taxiW / 2, a1: 150, c1: 38 }, // 旅客ターミナルの前
      { a0: 235, c0: taxiC + taxiW / 2, a1: 335, c1: 24 }, // 貨物
      { a0: -372, c0: taxiC + taxiW / 2, a1: -282, c1: 10 }, // 格納庫の前
      { a0: 410, c0: taxiC + taxiW / 2, a1: 468, c1: 4 }, // 消防署の前
    ],
    stands,
    types: ['atr', 'a220', 'e190'], wideTypes: [], cargoTypes: ['atr'], walk: true,
    serviceC: 34.5,
    depot: [118, 14],
    buildings: [
      { kind: 'pier', r: { a0: -88, c0: 38, a1: 88, c1: 46 }, h: 6 },
      { kind: 'terminal', r: { a0: -88, c0: 46, a1: 88, c1: 60 }, h: 13 },
      { kind: 'tower', r: { a0: 100, c0: 30, a1: 136, c1: 46 }, h: 8 },
      { kind: 'hotel', r: { a0: 150, c0: 28, a1: 196, c1: 46 }, h: 31 },
      { kind: 'office', r: { a0: 206, c0: 30, a1: 236, c1: 46 }, h: 22 },
      { kind: 'carpark', r: { a0: 312, c0: 62, a1: 378, c1: 84 }, h: 11, loop: true },
      { kind: 'station', r: { a0: -66, c0: 86, a1: 66, c1: 95 }, h: 7 },
      { kind: 'hangar', r: { a0: -365, c0: 10, a1: -290, c1: 58 }, h: 19 },
      { kind: 'fuel', r: { a0: 344, c0: 26, a1: 404, c1: 56 }, h: 12 },
      { kind: 'fire', r: { a0: 412, c0: 4, a1: 464, c1: 30 }, h: 8 },
      { kind: 'cargo', r: { a0: 240, c0: 26, a1: 334, c1: 62 }, h: 12 },
    ],
    roadC: [64, 85],
    viaduct: { a0: -92, a1: 92, c0: 62, c1: 77, h: 6.5, ramp: 62 },
    station: { a0: -66, c0: 86, a1: 66, c1: 95 },
    stationPort: { a0: -80, c0: 72, a1: 80, c1: C / 2 + 1 },
    gate: 290, svcGate: { a: 420, c: C / 2, na: 0, nc: 1 }, svcRoads: [[[420, C / 2], [420, 66], [300, 66]]],
    land: { oa: 0, oc: 0, rot: 0, A, edge: C / 2 }, parallel: false,
    tower: [118, 38, 46],
    masts: [[-110, 36.5], [-27.5, 36.5], [27.5, 36.5], [110, 36.5], [239, 22], [-286, 8]],
    glide: 5.5,
    hangarType: 'a220',
    fc: { cF: 72, cR: 88, cD: 56, aDiv: [236, 140], variant: 'merge', cM: 56, aMerge: [-96, -200], aU: -146, cTop: 24 },
  };
}

// 中：チューリッヒのような地方空港。滑走路 1,200m（幅 45m）、全長の平行誘導路と高速脱出誘導路、エプロンの誘導路、
// 桟橋（ピア）に搭乗橋 8 か所（ワイドボディ 2）、バスで乗るスポット 2、貨物のスポット 2
function layoutM(spec: AirportSpec): AirportLayout {
  const A = spec.L * CELL, C = spec.W * CELL;
  // 滑走路・平行誘導路・エプロンの誘導路の間隔：通る飛行機の翼が、滑走路の飛行機・駐機している飛行機の尾と重ならない
  const rwLen = 1200, rwW = 45, rc = -121;
  const taxiC = -60, taxiW = 20, laneC = -34;
  const linkA = rwLen / 2 - 15;
  const holdC = rc + rwW / 2 + 4.5;
  const retA = 120, retJ = retA + (taxiC - rc) / Math.tan(Math.PI / 6);
  const pier = { a0: -225, a1: 190, c0: 66, c1: 80 };
  const stDefs: { a: number; wide?: boolean; bridge?: boolean; cargo?: boolean }[] = [
    { a: -190, wide: true, bridge: true }, { a: -132, bridge: true }, { a: -86, bridge: true }, { a: -40, bridge: true },
    { a: 6, bridge: true }, { a: 52, bridge: true }, { a: 98, bridge: true }, { a: 156, wide: true, bridge: true },
    { a: 232 }, { a: 278 }, // バスで乗るスポット
    { a: 425, wide: true, cargo: true }, { a: 505, cargo: true }, // 貨物：平行誘導路から直接入る
  ];
  const conns = [-300, -63, 330];
  const { net, node, edge, line } = netBuilder();
  const cargoAs = stDefs.filter((s) => s.cargo).map((s) => s.a);
  line(taxiC, [-linkA, -retJ, -retJ - 25, ...conns, retJ, retJ + 25, ...cargoAs, linkA], taxiW);
  line(laneC, [conns[0], ...stDefs.filter((s) => !s.cargo).map((s) => s.a), conns[1], conns[2]], 18);
  for (const a of conns) edge(node(a, taxiC), node(a, laneC), 18);
  const J = [node(-linkA, taxiC), node(linkA, taxiC)] as [number, number];
  const exits: ExitDef[] = [];
  for (const dir of [1, -1] as const) {
    const far = dir > 0 ? linkA : -linkA, k = dir > 0 ? 1 : 0;
    // 高速脱出誘導路（30°）：接地からおよそ 600m で出る
    const ra = dir * retA, rj = dir * retJ;
    exits.push({ dir, a: ra - dir * 20, pts: [[ra - dir * 20, rc], [ra, rc], [rj, taxiC], [rj + dir * 25, taxiC]], node: node(rj + dir * 25, taxiC), speed: 22, rapid: true });
    exits.push({ dir, a: far - dir * 40, pts: [[far - dir * 40, rc], [far, rc], [far, taxiC]], node: J[k], speed: 11, rapid: false });
  }
  const runway: RunwayDef = { c: rc, a0: -rwLen / 2, a1: rwLen / 2, width: rwW, links: [-linkA, linkA], holdC, taxiC, side: 1, junction: J, exits, td: 220 };
  const stands: StandDef[] = stDefs.map((s) => ({
    a: s.a, noseC: s.cargo ? 38 : s.wide ? 62 : 58, cargo: !!s.cargo, wide: !!s.wide, bridge: !!s.bridge, node: node(s.a, s.cargo ? taxiC : laneC),
    rot: s.bridge ? [s.a + (s.wide ? 26 : 19), 63] : undefined,
  }));
  return {
    spec, A, C,
    runways: [runway], net,
    taxiC, taxiW, laneC,
    aprons: [
      { a0: -320, c0: taxiC + taxiW / 2, a1: 360, c1: 66 }, // ターミナルの前
      { a0: 360, c0: taxiC + taxiW / 2, a1: 580, c1: 42 }, // 貨物
      { a0: -650, c0: taxiC + taxiW / 2, a1: -490, c1: 4 }, // 整備地区
      { a0: -470, c0: taxiC + taxiW / 2, a1: -380, c1: -6 }, // 消防署
    ],
    stands,
    types: ['a320', 'a320', 'b737', 'b737', 'a320', 'e190', 'a220'], wideTypes: ['b787'], cargoTypes: ['b737', 'b787'], walk: false,
    serviceC: 62.5,
    depot: [-268, 30],
    buildings: [
      { kind: 'pier', r: pier, h: 9 },
      { kind: 'terminal', r: { a0: -150, c0: 80, a1: 150, c1: 92 }, h: 16 },
      { kind: 'tower', r: { a0: -470, c0: 70, a1: -400, c1: 100 }, h: 10 },
      { kind: 'hotel', r: { a0: 380, c0: 66, a1: 440, c1: 96 }, h: 40 },
      { kind: 'office', r: { a0: 450, c0: 74, a1: 500, c1: 96 }, h: 28 },
      { kind: 'carpark', r: { a0: -472, c0: 104, a1: -412, c1: 140 }, h: 17 },
      { kind: 'carpark', r: { a0: 415, c0: 104, a1: 485, c1: 128 }, h: 14, loop: true },
      { kind: 'station', r: { a0: -95, c0: 131, a1: 95, c1: 143 }, h: 7 },
      { kind: 'hangar', r: { a0: -640, c0: 4, a1: -500, c1: 84 }, h: 30 },
      { kind: 'fuel', r: { a0: 520, c0: 70, a1: 610, c1: 100 }, h: 14 },
      { kind: 'fire', r: { a0: -462, c0: -6, a1: -388, c1: 26 }, h: 9 },
      { kind: 'cargo', r: { a0: 380, c0: 42, a1: 570, c1: 64 }, h: 14 },
    ],
    roadC: [102, 129],
    viaduct: { a0: -160, a1: 160, c0: 100, c1: 115, h: 7, ramp: 75 },
    station: { a0: -95, c0: 131, a1: 95, c1: 143 },
    stationPort: { a0: -110, c0: 80, a1: 110, c1: C / 2 + 1 }, // 地下鉄はターミナルの下まで入れる
    gate: 400, svcGate: { a: 510, c: C / 2, na: 0, nc: 1 }, svcRoads: [[[510, C / 2], [510, 68], [446, 68]]],
    land: { oa: 0, oc: 0, rot: 0, A, edge: C / 2 }, parallel: false,
    tower: [-435, 89, 64],
    masts: [[-250, 64], [-110, 64], [30, 64], [175, 64], [300, 64], [372, 40], [-495, 2]],
    glide: 3.2,
    hangarType: 'b787',
    fc: { cF: 104, cR: 120, cD: 88, aDiv: [336, 200], variant: 'merge', cM: 88, aMerge: [-160, -272], aU: -248, cTop: 56 },
  };
}

// 大：ミュンヘンのようなハブ空港。平行な滑走路 2 本（1,400m、北 = 着陸、南 = 出発）、滑走路のあいだに本館とサテライト、
// 搭乗橋 21 か所（ワイドボディ 6）、バスで乗るスポット 6、貨物のスポット 3。陸側（道路・駅・駐車場・エアポートセンター）は西の端
function layoutL(spec: AirportSpec): AirportLayout {
  const A = spec.L * CELL, C = spec.W * CELL;
  const rwLen = 1400, rwW = 45, rcN = -282, rcS = 282, txN = -215, txS = 215, taxiW = 23;
  const linkA = rwLen / 2 - 15;
  const L1 = -500, L2 = -170; // エプロンの誘導路（滑走路と直角）
  const cs = [-147, -92, -46, 0, 46, 92, 147]; // 本館・サテライトのスポット（c）。両端はワイドボディ
  const remote = [-120, -74, -28, 18, 64, 110]; // バスで乗るスポット
  const cargoA = [200, 280, 350];
  const retA = 160, retJ = retA + (txN - rcN) / Math.tan(Math.PI / 6);
  const { net, node, line, vline } = netBuilder();
  line(txN, [-linkA, L1, L2, -retJ - 25, retJ + 25, linkA], taxiW);
  // 南の誘導路は 100m ほどの区間に分ける（出発機が前の機体の後ろで順番を待てる）
  line(txS, [-linkA, -590, L1, -335, L2, 0, ...cargoA, 470, 590, linkA], taxiW);
  vline(L1, [txN, ...cs, txS], taxiW);
  vline(L2, [txN, ...cs, ...remote, txS], taxiW);
  const JN = [node(-linkA, txN), node(linkA, txN)] as [number, number];
  const JS = [node(-linkA, txS), node(linkA, txS)] as [number, number];
  const exitsN: ExitDef[] = [];
  for (const dir of [1, -1] as const) {
    const far = dir > 0 ? linkA : -linkA, k = dir > 0 ? 1 : 0;
    const ra = dir * retA, rj = dir * retJ;
    exitsN.push({ dir, a: ra - dir * 20, pts: [[ra - dir * 20, rcN], [ra, rcN], [rj, txN], [rj + dir * 25, txN]], node: node(rj + dir * 25, txN), speed: 22, rapid: true });
    exitsN.push({ dir, a: far - dir * 40, pts: [[far - dir * 40, rcN], [far, rcN], [far, txN]], node: JN[k], speed: 11, rapid: false });
  }
  const exitsS: ExitDef[] = [1, -1].map((dir) => {
    const far = dir > 0 ? linkA : -linkA, k = dir > 0 ? 1 : 0;
    return { dir: dir as 1 | -1, a: far - dir * 40, pts: [[far - dir * 40, rcS], [far, rcS], [far, txS]], node: JS[k], speed: 11, rapid: false };
  });
  const rwN: RunwayDef = { c: rcN, a0: -rwLen / 2, a1: rwLen / 2, width: rwW, links: [-linkA, linkA], holdC: rcN + rwW / 2 + 4.5, taxiC: txN, side: 1, junction: JN, exits: exitsN, td: 250 };
  const rwS: RunwayDef = { c: rcS, a0: -rwLen / 2, a1: rwLen / 2, width: rwW, links: [-linkA, linkA], holdC: rcS - rwW / 2 - 4.5, taxiC: txS, side: -1, junction: JS, exits: exitsS, td: 250 };
  const stands: StandDef[] = [];
  const st = (a: number, c: number, dir: [number, number], laneA: number | null, o: { wide?: boolean; bridge?: boolean; cargo?: boolean }) => {
    const s0: StandDef = { a, noseC: c, dir, cargo: !!o.cargo, wide: !!o.wide, bridge: !!o.bridge, node: laneA === null ? node(a, txS) : node(laneA, c) };
    if (o.bridge) s0.rot = standPt(s0, -3, o.wide ? 28 : 19);
    stands.push(s0);
  };
  for (const c of cs) st(-662, c, [-1, 0], L1, { wide: Math.abs(c) > 140, bridge: true }); // 本館
  for (const c of cs) st(-338, c, [1, 0], L1, { wide: Math.abs(c) > 140, bridge: true }); // サテライトの西
  for (const c of cs) st(-282, c, [-1, 0], L2, { wide: Math.abs(c) > 140, bridge: true }); // サテライトの東
  for (const c of remote) st(-90, c, [1, 0], L2, {}); // バスで乗るスポット
  cargoA.forEach((a, k) => st(a, 100, [0, -1], null, { cargo: true, wide: k < 2 }));
  const ap = txS - taxiW / 2;
  return {
    spec, A, C,
    runways: [rwN, rwS], net,
    taxiC: txN, taxiW, laneC: txN,
    aprons: [
      { a0: -670, c0: -ap, a1: -60, c1: ap }, // 本館・サテライト・バスのスポット
      { a0: 160, c0: 92, a1: 400, c1: ap }, // 貨物
      { a0: 400, c0: -ap, a1: 690, c1: -185 }, // 整備地区
    ],
    stands,
    types: ['a320', 'b737', 'a320', 'b737', 'a220', 'e190'], wideTypes: ['b787', 'b777', 'a350'], cargoTypes: ['b737', 'b777'], walk: false,
    serviceC: NaN, gseRoad: 192,
    depot: [-105, 175],
    buildings: [
      { kind: 'concourse', r: { a0: -684, c0: -180, a1: -670, c1: 180 }, h: 10 },
      { kind: 'concourse', r: { a0: -330, c0: -180, a1: -290, c1: 180 }, h: 15 },
      { kind: 'terminal', r: { a0: -180, c0: 14, a1: 180, c1: 46 }, h: 18, sub: true },
      { kind: 'station', r: { a0: -110, c0: 118, a1: 110, c1: 129 }, h: 8, sub: true },
      { kind: 'carpark', r: { a0: -205, c0: 100, a1: -150, c1: 128 }, h: 20, sub: true, loop: true },
      { kind: 'hotel', r: { a0: -146, c0: 100, a1: -114, c1: 128 }, h: 48, sub: true },
      { kind: 'office', r: { a0: 114, c0: 100, a1: 146, c1: 128 }, h: 36, sub: true },
      { kind: 'plaza', r: { a0: -106, c0: 100, a1: 106, c1: 116 }, h: 0, sub: true },
      { kind: 'tower', r: { a0: 30, c0: -22, a1: 90, c1: 22 }, h: 12 },
      { kind: 'hangar', r: { a0: 405, c0: -185, a1: 540, c1: -95 }, h: 34, ac: 'b777' },
      { kind: 'hangar', r: { a0: 555, c0: -185, a1: 690, c1: -95 }, h: 34, ac: 'a350' },
      { kind: 'cargo', r: { a0: 160, c0: 40, a1: 390, c1: 92 }, h: 16, flip: true },
      { kind: 'fuel', r: { a0: 440, c0: -40, a1: 540, c1: 30 }, h: 14 },
      { kind: 'fire', r: { a0: -40, c0: -190, a1: 30, c1: -150 }, h: 10 },
      { kind: 'fire', r: { a0: 600, c0: 120, a1: 670, c1: 170 }, h: 10, flip: true },
    ],
    roadC: [46, 70],
    viaduct: { a0: -110, a1: 110, c0: 44, c1: 59, h: 7.5, ramp: 40 },
    station: { a0: -110, c0: 118, a1: 110, c1: 129 },
    stationPort: { a0: -A / 2 - 20, c0: -115, a1: -680, c1: 115 }, // 地下鉄はターミナルの下まで入れる
    gate: 225, svcGate: { a: A / 2, c: 0, na: 1, nc: 0 }, svcRoads: [[[A / 2, 0], [560, 0], [560, 34], [160, 34]], [[560, 0], [560, -90], [405, -90]]],
    land: { oa: -670, oc: 0, rot: Math.PI / 2, A: 480, edge: 130 }, parallel: true,
    tower: [60, 0, 95],
    fc: { cF: 58, cR: 90, cD: 74, aDiv: [200, 80], variant: 'stack', cM: 74, aMerge: [-80, 40], aU: -200, cTop: 42 },
    masts: [[-590, -190], [-590, 0], [-590, 190], [-410, -190], [-410, 190], [-230, -190], [-230, 190], [-60, -190], [-60, 190], [165, 195], [395, 195]],
    glide: 3.0,
    hangarType: 'b777',
  };
}

// ---- 空港駅と高速道路の出入口 ----
// 敷地のマスの、敷地の座標での中心
export function cellLocal(f: AirFrame, n: number, i: number): [number, number] {
  return toLocal(f, ((i % n) + 0.5) * CELL, (((i / n) | 0) + 0.5) * CELL);
}
const inRect = (r: LRect, a: number, c: number) => a >= r.a0 && a <= r.a1 && c >= r.c0 && c <= r.c1;

// 陸側の座標（land）→ 敷地の座標
export function landToLot(L: AirportLayout, a: number, c: number): [number, number] {
  const co = Math.cos(L.land.rot), si = Math.sin(L.land.rot);
  return [L.land.oa + a * co - c * si, L.land.oc + a * si + c * co];
}
export function lotToLand(L: AirportLayout, a: number, c: number): [number, number] {
  const co = Math.cos(L.land.rot), si = Math.sin(L.land.rot), da = a - L.land.oa, dc = c - L.land.oc;
  return [da * co + dc * si, -da * si + dc * co];
}
// 正門・通用門の、敷地の座標でのふちの点と外向きの向き
export function gatePoints(L: AirportLayout) {
  const [ma, mc] = landToLot(L, L.gate, L.land.edge);
  const co = Math.cos(L.land.rot), si = Math.sin(L.land.rot);
  const s = L.svcGate;
  return { main: { a: ma, c: mc, na: -si, nc: co }, svc: { a: s.a, c: s.c, na: s.na, nc: s.nc } };
}
// 門のマス：敷地のふちのすぐ外のマス。d = 外へ向かう向き（DX/DY の番号。斜めの敷地では斜め）。
// 道路・都市高速は、外から d の逆向きに引いてきて、このマスで終わらせる（このマスに道路があればつながる）
export interface GateCell { cell: number; d: number; inner: number; x: number; y: number }
function gateCellAt(n: number, f: AirFrame, a: number, c: number, na: number, nc: number, inLot: (i: number) => boolean): GateCell | null {
  const wx = na * f.cos - nc * f.sin, wz = na * f.sin + nc * f.cos, m = Math.max(Math.abs(wx), Math.abs(wz));
  const dx = Math.round(wx / m), dy = Math.round(wz / m);
  let d = 0;
  for (let k = 0; k < 8; k++) if (DX[k] === dx && DY[k] === dy) d = k;
  const [X, Z] = toWorld(f, a - na * 4, c - nc * 4);
  let x = Math.floor(X / CELL), y = Math.floor(Z / CELL);
  for (let k = 0; k < 6 && x >= 0 && y >= 0 && x < n && y < n && inLot(y * n + x); k++) { x += dx; y += dy; }
  if (x < 0 || y < 0 || x >= n || y >= n || inLot(y * n + x)) return null;
  const ix = x - dx, iy = y - dy;
  return { cell: y * n + x, d, inner: iy * n + ix, x, y };
}

export interface AirPorts {
  stationCells: number[]; // 空港駅の範囲の敷地のマス
  stationNear: number[]; // 線路を接して引くマス（空港駅の範囲のまわりの、敷地の外のマス）
  gate: GateCell | null; // 正門（都市高速・一般道）
  svc: GateCell | null; // 通用門（一般道）
}
export function airportPorts(n: number, f: AirFrame, L: AirportLayout, cells: number[], inLot: (i: number) => boolean): AirPorts {
  const stationCells: number[] = [], st = new Set<number>();
  for (const i of cells) {
    const [a, c] = cellLocal(f, n, i);
    if (!inRect(L.stationPort, a, c)) continue;
    stationCells.push(i);
    const x = i % n, y = (i / n) | 0;
    for (let d = 0; d < 8; d++) {
      const qx = x + DX[d], qy = y + DY[d];
      if (qx < 0 || qy < 0 || qx >= n || qy >= n) continue;
      const j = qy * n + qx;
      if (!inLot(j)) st.add(j);
    }
  }
  const G = gatePoints(L);
  const gate = gateCellAt(n, f, G.main.a, G.main.c, G.main.na, G.main.nc, inLot);
  const svc = gateCellAt(n, f, G.svc.a, G.svc.c, G.svc.na, G.svc.nc, inLot);
  return { stationCells, stationNear: [...st], gate, svc };
}

// 空港駅につながっている線の種類と、その線路のマス
export function stationLines(g: Grid, P: AirPorts): Map<LineKind, number[]> {
  const out = new Map<LineKind, number[]>();
  for (const kind of ['rail', 'erail', 'mono', 'sub'] as const) {
    const mask = g[kind];
    const cells: number[] = [];
    for (const i of P.stationNear) if (mask[i]) cells.push(i);
    if (kind === 'sub') for (const i of P.stationCells) if (mask[i]) cells.push(i); // 地下鉄はターミナルの下まで入れる
    if (cells.length) out.set(kind, cells);
  }
  return out;
}

// 空港の門のマス（正門・通用門）の一覧：建物の一覧から（道路を引くときの端の寄せ方に使う）
export function airportGateCells(n: number, list: Iterable<{ x: number; y: number; w: number; h: number; face: number; size: AirportSize }>): Set<number> {
  const out = new Set<number>();
  for (const b of list) {
    const spec = AIRPORT_SPECS[b.size], cells = airportCells(n, b, spec), lot = new Set(cells);
    const P = airportPorts(n, frameOf(b, spec), airportLayout(b.size), cells, (i) => lot.has(i));
    if (P.gate) out.add(P.gate.cell);
    if (P.svc) out.add(P.svc.cell);
  }
  return out;
}

// 門につながっている道路（車の経路のノード番号：地上 = マス、上空 = N + マス）。
// 正門：都市高速（高架・地上、片側 1 車線・一方通行 2 車線）か一般道（細い道・道路・一方通行・大通り）。ふつうの高速道路はつながない。
// 通用門：一般道だけ
export const isUrbanHw = (t: number) => isUrbanElevated(t) || isUrbanGround(t);
export const isLocalRoadType = (t: number) => t !== 0 && !isHighway(t) && t !== RoadType.Ramp;
export interface GateLink { node: number; kind: 'hw' | 'road' }
export function gateLink(g: Grid, gc: GateCell | null, main: boolean): GateLink | null {
  if (!gc) return null;
  const i = gc.cell, N = g.n * g.n;
  // 門のマスから、空港の道路（フォアコート）でないマスへのつながりがあるか（門のマスに置いた目印の道路だけなら、つながっていない）
  const n = g.n, x = i % n, y = (i / n) | 0;
  // （空港の道路でないマスの道路が、都市高速か一般道のときだけ。ふつうの高速道路が門のマスを通っても、つながらない）
  const out = (m: number, up = false) => {
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const xx = x + DX[d], yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= n || yy >= n || g.aport[yy * n + xx]) continue;
      const j = yy * n + xx, L = g.arriveLevel(up ? 1 : 0, j, d), t = L ? g.up[j] : g.road[j];
      if (isUrbanHw(t) || isLocalRoadType(t)) return true;
    }
    return false;
  };
  if (main && isUrbanHw(g.up[i]) && out(g.conn1[i], true)) return { node: N + i, kind: 'hw' };
  if (main && isUrbanHw(g.road[i]) && out(g.conn[i])) {
    // 一般道が正門のマスの都市高速（地上）に続いている：一般道でつながっている
    let local = false;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (g.conn[i] & (1 << d) && xx >= 0 && yy >= 0 && xx < n && yy < n && !g.aport[yy * n + xx] && isLocalRoadType(g.road[yy * n + xx])) local = true;
    }
    return { node: i, kind: local ? 'road' : 'hw' };
  }
  if (isLocalRoadType(g.road[i]) && out(g.conn[i])) return { node: i, kind: 'road' };
  return null;
}

// ---- 置く場所の計画 ----
export const AIRPORT_SLOPE = 12; // 敷地をならすときの、地面の高さの差の上限（m、マスごと）
export const AIRPORT_EARTH_COST = 3; // 地面を 1m 動かす費用（1 マスあたり）
export interface AirPlan {
  ok: boolean;
  size: AirportSize;
  rot: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cz: number;
  cells: number[];
  bad: Map<number, string>; // 置けないマスと理由
  fill: number[]; // 埋め立てる水のマス
  quay: number[]; // 岸壁になるマス
  flatH: number;
  cost: number;
  reason: string;
  ports: AirPorts;
}
// 埋め立ての費用（1マス）と岸壁（1マス）。地形の埋め立てのツールと同じ値（plan.ts の RECLAIM_COST・QUAY_COST[1]）
export const AIR_RECLAIM_COST = 400;
export const AIR_QUAY_COST = 150;
export function planAirport(g: Grid, size: AirportSize, tx: number, ty: number, rot: number): AirPlan {
  const n = g.n, spec = AIRPORT_SPECS[size];
  rot &= 7;
  const [cx, cz] = placeCentre(n, spec, rot, tx, ty);
  const fp = footprintAt(n, spec, rot, cx, cz);
  const bad = new Map<number, string>();
  const inLot = new Uint8Array(n * n);
  for (const i of fp.cells) inLot[i] = 1;
  const fill: number[] = [];
  let sum = 0, cnt = 0;
  for (const i of fp.cells) {
    const x = i % n, y = (i / n) | 0;
    if (g.road[i] || g.up[i]) bad.set(i, '道路があります');
    else if (g.bldg[i]) bad.set(i, '建物があります');
    else if (g.rail[i] || g.erail[i] || g.mono[i]) bad.set(i, '線路があります');
    if (g.isWater(x, y)) fill.push(i);
    else { sum += g.cellH(x, y); cnt++; }
  }
  // ならす高さ：陸の平均。水があれば、埋め立ての高さより低くしない
  let flatH = cnt ? sum / cnt : QUAY_LAND;
  if (fill.length) flatH = Math.max(flatH, QUAY_LAND);
  let earth = 0;
  for (const i of fp.cells) {
    const x = i % n, y = (i / n) | 0;
    if (g.isWater(x, y)) continue;
    const d = Math.max(Math.abs(g.cellMaxH(x, y) - flatH), Math.abs(g.cellMinH(x, y) - flatH));
    if (d > AIRPORT_SLOPE && !bad.has(i)) bad.set(i, '地面の傾きが大きすぎます');
    earth += Math.abs(g.cellH(x, y) - flatH);
  }
  // 岸壁：埋め立てたあと、水に面する敷地のマス
  const quay: number[] = [];
  if (fill.length || fp.cells.some((i) => hasWaterNb(g, i))) {
    for (const i of fp.cells) {
      const x = i % n, y = (i / n) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const qx = x + dx, qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= n || qy >= n) continue;
        const j = qy * n + qx;
        if (!inLot[j] && g.isWater(qx, qy)) { quay.push(i); break; }
      }
    }
  }
  const lot = (i: number) => inLot[i] === 1;
  const ports = airportPorts(n, makeFrame(spec, rot, cx, cz), airportLayout(size), fp.cells, lot);
  let reason = '';
  if (fp.out) reason = 'マップに入りきりません';
  else if (bad.size) reason = [...new Set(bad.values())].join('・') + '（赤いマス）';
  else if (!ports.gate) reason = 'マップに入りきりません（正門）';
  const cost = spec.cost + Math.round(earth * AIRPORT_EARTH_COST) + fill.length * AIR_RECLAIM_COST + quay.length * AIR_QUAY_COST;
  return { ok: !reason, size, rot, x: fp.x, y: fp.y, w: fp.w, h: fp.h, cx, cz, cells: fp.cells, bad, fill, quay, flatH, cost, reason, ports };
}
function hasWaterNb(g: Grid, i: number) {
  const n = g.n, x = i % n, y = (i / n) | 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (g.inb(x + dx, y + dy) && g.isWater(x + dx, y + dy)) return true;
  return false;
}

// 計画どおりに地面をならし、水を埋め立て、岸壁の印をつける（建物の印は world.ts がつける）
export function applyAirportGround(g: Grid, p: AirPlan) {
  const n = g.n, V = n + 1;
  const verts = new Set<number>();
  for (const i of p.cells) {
    const x = i % n, y = (i / n) | 0;
    verts.add(y * V + x); verts.add(y * V + x + 1); verts.add((y + 1) * V + x); verts.add((y + 1) * V + x + 1);
  }
  for (const v of verts) {
    const vx = v % V, vy = (v / V) | 0;
    // 道路の頂点は動かさない
    let nearRoad = false;
    for (const [cx, cy] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]]) if (g.inb(cx, cy) && (g.road[g.idx(cx, cy)] || g.up[g.idx(cx, cy)])) nearRoad = true;
    if (!nearRoad) g.heights[v] = p.flatH;
  }
  for (const i of p.cells) { g.tree[i] = 0; g.zone[i] = 0; g.zden[i] = 0; if (g.quay[i] === 2) g.quay[i] = 0; }
  for (const i of p.quay) g.quay[i] = 1;
}

// ---- 騒音 ----
// 滑走路の向きに沿ってのびる範囲（0..1）。activity = 運航の多さ（0..1）
export function noiseAt(f: AirFrame, L: AirportLayout, X: number, Z: number, activity: number): number {
  const [a, c] = toLocal(f, X, Z);
  const sp = L.spec;
  let v = 0;
  for (const r of L.runways) {
    const beyond = Math.max(0, r.a0 - a, a - r.a1);
    if (beyond > sp.noiseLen) continue;
    const half = sp.noiseWidth + beyond * 0.12;
    const lat = Math.abs(c - r.c);
    if (lat > half) continue;
    const k = (1 - lat / half) * (1 - beyond / sp.noiseLen);
    v = Math.max(v, Math.min(1, k * 1.4));
  }
  return v * (0.35 + 0.65 * Math.max(0, Math.min(1, activity)));
}

// 滑走路の番号（世界の向き → 01..36）。北 = -Z。dx, dz = 離着陸の向き
export function runwayNumber(dx: number, dz: number): string {
  let h = (Math.atan2(dx, -dz) * 180) / Math.PI;
  if (h <= 0) h += 360;
  let k = Math.round(h / 10);
  if (k === 0) k = 36;
  return String(k).padStart(2, '0');
}

export const isWaterLevel = (h: number) => h < WATER_LEVEL + 0.3;
