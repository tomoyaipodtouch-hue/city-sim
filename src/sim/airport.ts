// 空港（小・中・大）の共通の仕組み：敷地の形（縦横と斜め）、空港の配置（滑走路・誘導路・駐機場・建物）、
// 置く場所の計画（埋め立て・岸壁・赤いマスと理由）、空港駅と高速道路の出入口、騒音の範囲、運航の数字。
// シミュレーション（Worker）と画面の両方で使う（three.js には触らない）。
//
// 座標：空港の「敷地の座標」は m。a = 滑走路の向き（長い辺）、c = 横の向き。+c が陸側（ターミナル・道路・駅）、-c が滑走路の側。
// 敷地の中心が (0, 0)。向き rot は 8 方向（DX/DY の番号）で、陸側が向く方角。偶数は縦横、奇数は斜め（45°）。
// 世界の座標（X = 東、Z = 南、m）へは、角度 θ = (rot - 2)·π/4 で回す（建物の正面 face と同じ決まり：rot 2 = 陸側が南）。
import { CELL, DX, DY, QUAY_LAND, WATER_LEVEL } from './constants';
import type { Grid } from './grid';
import { isHighway, RoadType } from './defs';
import type { LineKind } from './defs';

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
}
export const AIRPORT_SPECS: Record<AirportSize, AirportSpec> = {
  1: { size: 1, L: 60, W: 12, cost: 80000, upkeep: 650, pollution: 5, boost: 0.15, paxCap: 1600, paxPerFlight: 55, maxAircraft: 3, freightShare: 0.25, noiseLen: 1300, noiseWidth: 230 },
  2: { size: 2, L: 85, W: 18, cost: 300000, upkeep: 2200, pollution: 9, boost: 0.25, paxCap: 6000, paxPerFlight: 120, maxAircraft: 6, freightShare: 0.5, noiseLen: 2000, noiseWidth: 320 },
  3: { size: 3, L: 100, W: 40, cost: 1000000, upkeep: 7000, pollution: 14, boost: 0.35, paxCap: 20000, paxPerFlight: 180, maxAircraft: 12, freightShare: 0.65, noiseLen: 2600, noiseWidth: 420 },
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
  highway: boolean; // 高速道路と直結している
  road: boolean; // 一般道につながっている
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
export interface LRect { a0: number; c0: number; a1: number; c1: number }
export interface RunwayDef {
  c: number; // 中心線
  a0: number; // 両端
  a1: number;
  width: number;
  links: number[]; // 誘導路とつなぐ取付誘導路の位置（a）
  holdC: number; // 停止位置（c）
}
export interface StandDef {
  a: number; // 駐機スポットの中心線（a）
  noseC: number; // 機首が止まる位置（c）
  cargo: boolean;
}
export type AirBldKind = 'terminal' | 'pier' | 'tower' | 'hotel' | 'office' | 'carpark' | 'station' | 'hangar' | 'fuel' | 'fire' | 'cargo';
export interface AirBld { kind: AirBldKind; r: LRect; h: number }
export interface AirportLayout {
  spec: AirportSpec;
  A: number;
  C: number;
  runways: RunwayDef[];
  taxiC: number; // 平行誘導路の中心線（c）
  taxiW: number;
  taxiA0: number; // 平行誘導路の両端（a）
  taxiA1: number;
  aprons: LRect[];
  stands: StandDef[];
  serviceC: number; // エプロンの構内道路（c）
  depot: [number, number]; // 地上の車両の車庫（a, c）
  buildings: AirBld[];
  roadC: [number, number]; // 陸側の道路（c の範囲）
  roadA: [number, number];
  viaduct: { a0: number; a1: number; c0: number; c1: number; h: number; ramp: number }; // 高架の出発ロビー前の道路
  station: LRect; // 空港駅（線路をつなぐ所）
  stationPort: LRect; // 線路が接していればよい範囲（敷地のマスの中心が入る範囲）
  highwayC: number; // 高速道路の出入口：この c より陸側の敷地のマスに接する高速道路
  tower: [number, number, number]; // 管制塔（a, c, 高さ）
  glide: number; // 進入角（度）
}

const layouts = new Map<AirportSize, AirportLayout>();
export function airportLayout(size: AirportSize): AirportLayout {
  let L = layouts.get(size);
  if (!L) layouts.set(size, (L = makeLayout(AIRPORT_SPECS[size])));
  return L;
}

// 小：ロンドン・シティ空港のような街なかの空港。滑走路 800m（建物が少しデフォルメなので短め）、搭乗橋なしで歩いて乗る
function makeLayout(spec: AirportSpec): AirportLayout {
  const A = spec.L * CELL, C = spec.W * CELL;
  // ここでは「小」の配置を作る（中・大は同じ形の表を作る関数を足す）
  const rwLen = 800, rwW = 30, rc = -C / 2 + 30;
  const taxiC = -22, taxiW = 15;
  const linkA = rwLen / 2 - 15;
  const runway: RunwayDef = { c: rc, a0: -rwLen / 2, a1: rwLen / 2, width: rwW, links: [-linkA, linkA], holdC: rc + rwW / 2 + 9 };
  const apronC0 = taxiC + taxiW / 2;
  return {
    spec, A, C,
    runways: [runway],
    taxiC, taxiW, taxiA0: -linkA, taxiA1: linkA,
    aprons: [
      { a0: -150, c0: apronC0, a1: 150, c1: 38 }, // 旅客ターミナルの前
      { a0: 235, c0: apronC0, a1: 335, c1: 24 }, // 貨物
      { a0: -372, c0: apronC0, a1: -282, c1: 10 }, // 格納庫の前
      { a0: -258, c0: apronC0, a1: -200, c1: 4 }, // 消防署の前
    ],
    stands: [
      { a: -55, noseC: 27, cargo: false },
      { a: 0, noseC: 27, cargo: false },
      { a: 55, noseC: 27, cargo: false },
      { a: 285, noseC: 16, cargo: true },
    ],
    serviceC: 32,
    depot: [118, 14],
    buildings: [
      { kind: 'pier', r: { a0: -88, c0: 38, a1: 88, c1: 46 }, h: 6 },
      { kind: 'terminal', r: { a0: -88, c0: 46, a1: 88, c1: 66 }, h: 13 },
      { kind: 'tower', r: { a0: 100, c0: 36, a1: 136, c1: 62 }, h: 8 },
      { kind: 'hotel', r: { a0: 150, c0: 30, a1: 196, c1: 64 }, h: 31 },
      { kind: 'office', r: { a0: 206, c0: 36, a1: 236, c1: 64 }, h: 22 },
      { kind: 'carpark', r: { a0: -192, c0: 32, a1: -110, c1: 64 }, h: 14 },
      { kind: 'station', r: { a0: -66, c0: 85, a1: 66, c1: 95 }, h: 7 },
      { kind: 'hangar', r: { a0: -365, c0: 10, a1: -290, c1: 58 }, h: 19 },
      { kind: 'fuel', r: { a0: -272, c0: 38, a1: -214, c1: 64 }, h: 12 },
      { kind: 'fire', r: { a0: -256, c0: 4, a1: -204, c1: 30 }, h: 8 },
      { kind: 'cargo', r: { a0: 240, c0: 26, a1: 334, c1: 64 }, h: 12 },
    ],
    roadC: [69, 83],
    roadA: [-340, 340],
    viaduct: { a0: -92, a1: 92, c0: 67, c1: 77, h: 6.5, ramp: 62 },
    station: { a0: -66, c0: 85, a1: 66, c1: 95 },
    stationPort: { a0: -80, c0: 72, a1: 80, c1: C / 2 + 1 },
    highwayC: 30,
    tower: [118, 49, 46],
    glide: 5.5,
  };
}

// ---- 空港駅と高速道路の出入口 ----
// 敷地のマスの、敷地の座標での中心
export function cellLocal(f: AirFrame, n: number, i: number): [number, number] {
  return toLocal(f, ((i % n) + 0.5) * CELL, (((i / n) | 0) + 0.5) * CELL);
}
const inRect = (r: LRect, a: number, c: number) => a >= r.a0 && a <= r.a1 && c >= r.c0 && c <= r.c1;

export interface AirPorts {
  stationCells: number[]; // 空港駅の範囲の敷地のマス
  stationNear: number[]; // 線路を接して引くマス（空港駅の範囲のまわりの、敷地の外のマス）
  highwayNear: number[]; // 高速道路が接していればよいマス（陸側の、敷地の外のマス）
}
export function airportPorts(n: number, f: AirFrame, L: AirportLayout, cells: number[], inLot: (i: number) => boolean): AirPorts {
  const stationCells: number[] = [], st = new Set<number>(), hw = new Set<number>();
  for (const i of cells) {
    const [a, c] = cellLocal(f, n, i);
    const sp = inRect(L.stationPort, a, c);
    if (sp) stationCells.push(i);
    const land = c >= L.highwayC;
    if (!sp && !land) continue;
    const x = i % n, y = (i / n) | 0;
    for (let d = 0; d < 8; d++) {
      const qx = x + DX[d], qy = y + DY[d];
      if (qx < 0 || qy < 0 || qx >= n || qy >= n) continue;
      const j = qy * n + qx;
      if (inLot(j)) continue;
      if (sp) st.add(j);
      if (land) hw.add(j);
    }
  }
  return { stationCells, stationNear: [...st], highwayNear: [...hw] };
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

// 敷地に接している高速道路のノード（車の経路のノード番号：地上 = マス、上空 = N + マス）
export function highwayNodes(g: Grid, P: AirPorts): number[] {
  const N = g.n * g.n, out: number[] = [];
  for (const i of P.highwayNear) {
    if (isHighway(g.road[i])) out.push(i);
    if (isHighway(g.up[i])) out.push(N + i);
  }
  return out;
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
const localRoad = (t: number) => t !== 0 && !isHighway(t) && t !== RoadType.Ramp;
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
  else {
    // ほかの公共施設と同じく、敷地のまわりに一般道が必要
    let road = false;
    for (const i of fp.cells) {
      const x = i % n, y = (i / n) | 0;
      for (let d = 0; d < 8 && !road; d++) {
        const qx = x + DX[d], qy = y + DY[d];
        if (qx < 0 || qy < 0 || qx >= n || qy >= n) continue;
        const j = qy * n + qx;
        if (!inLot[j] && localRoad(g.road[j])) road = true;
      }
      if (road) break;
    }
    if (!road) reason = '道路に接するように置いてください';
  }
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
