// 都市のシミュレーション本体（Worker 上で動く）
import { Grid, GRID_U8, GRID_F32, Ctl } from './grid';
import { Rng } from './rng';
import { DAYS_PER_MONTH, DX, DY } from './constants';
import {
  CIVIC, CivicId, plantPower, DEFAULT_TAX, DEPT_NAMES, Dept, DIFFICULTY, isHighway, SERVICE_DEPT, LineKind, LINES, FARE, BUS_STOP_UPKEEP, ESTOP_UPKEEP, GROW, GROW_KINDS, GrowKind, IND_DENSITY_MUL, maxFloorsFor, POWER_LINE_UPKEEP, ROADS, RoadType,
  ZONE_KINDS, ZoneType, FARM_TILE, IL_BIG_SIZES, LOGI_REACH, logiReach,
} from './defs';
import { generateTerrain, MapStyle } from './terrain';
import {
  applyCloverleaf, applyDiamond, applyTerrain, applyReclaim, planReclaim, applyURamp, linkURampMiddles, linkUrbanEnds, planTrees, planEStop, estopGroup, estopRoads, platformCells, planURamp, planTerrain, TerrainOp, applyRamp, planRoadCmd, levelAvenueDecks, applyTransitLine, levelViaductsOverWater, hasSurfaceLine, labelWater, planBusStop, railReachEdge, planTransitLine, removeTransitAt, planCloverleaf, applyRoad, applyZone, regradeApproaches, flattenRect, normRect, planBulldoze, planDiamond, planLine, planPlop, planPowerLine, planRamp, planZone,
} from './plan';
import { CELL } from './constants';
import { ADVISORS, Advice, computeRating, Loan, LOAN_AMOUNTS, loanRate, makeAdvice, MAX_LOANS, newLoan, ordinanceCost, ordinanceEffects, OrdinanceEffects, OrdinanceId, ORDINANCES, payLoan, rewardUnlocked, REWARD_REQ } from './governance';
import { defaultServiceState, facilityEffect, makeServiceMaps, ServiceMaps, ServiceState, updateServices } from './services';
import { Ages, agesOf, FuneralState, taxFactor, updatePopulation, WORK_RATE, workersOf } from './population';
import { assignTrips, buildJunctions, buildRoadGraph, buildTransitModel, congestionFactor, Destination, junctionGroup, LAYER, normalizeAvenueJunctions, Origin } from './traffic';

export enum BState {
  Building = 0,
  Normal = 1,
  Abandoned = 2,
}

export interface Building {
  id: number;
  civic: boolean;
  type: GrowKind | CivicId;
  x: number;
  y: number;
  w: number;
  h: number;
  face: number; // 正面の方向（0=東, 2=南, 4=西, 6=北）
  seed: number;
  den: number;
  cap: number; // 住人数 or 雇用数
  occ: number; // 現在の人数
  state: BState;
  stateDays: number;
  powered: boolean;
  watered: boolean;
  floors: number; // 階数（0 = 描画側で決める）
  commute: number; // 平均通勤時間（分）
  customers?: number; // 買い物客の充足率（商業）
  freight?: number; // 貨物を運べた割合（工業）
  freightTime?: number; // 貨物の輸送時間（分）
  note?: string; // 公共施設の状態（情報の画面に出す）
  fund?: number; // 施設ごとの予算（%、公共サービス）
  employed: number; // 職のある住人の割合（住宅）
  badMonths: number;
  ages?: Ages; // 住宅：年齢層の割合 [子ども, 働く世代, 高齢者]
  aOcc?: number; // 住宅：前の月の住人数（増えた分を引っ越してきた世帯として数える）
}

export interface Stats {
  day: number; // 通算日数
  funds: number;
  population: number;
  jobs: number;
  workers: number;
  employed: number;
  demand: Record<GrowKind, number>;
  demandRCI: [number, number, number];
  powerSupply: number;
  powerDemand: number;
  waterSupply: number;
  waterDemand: number;
  lastIncome: number;
  lastExpense: number;
  incomeBreakdown: Record<string, number>;
  expenseBreakdown: Record<string, number>;
  avgCommute: number;
  speed: number;
  neighborConnected: boolean;
  transitRiders: number;
  modeShare: { car: number; transit: number; walk: number };
  rating: number;
  ratingParts: [string, number][];
  advice: Advice[];
  ordinances: OrdinanceId[];
  loans: Loan[];
  loanRate: number;
  services: { funding: Record<Dept, number>; strike: Record<Dept, number>; eq: { child: number; adult: number; elderly: number }; hq: number; lifeExp: number; crime: number; garbage: { produced: number; handled: number; excess: number }; funeral: FuneralState };
}

export interface Maps extends ServiceMaps {
  power: Uint8Array;
  water: Uint8Array;
  landValue: Uint8Array;
  pollution: Uint8Array;
  traffic: Float32Array;
  freight: Float32Array; // トラックの交通量（見た目用）
  jctl: Uint8Array; // 交差点の実際の制御方式（自動の場合は交通量で決まったもの）
  riders: Float32Array; // 公共交通の1日の乗客数（バス、鉄道、高架鉄道、モノレール、地下鉄の順に n*n ずつ）
  congestion: Float32Array;
}

export interface SaveData {
  version: number;
  name: string;
  seed: number;
  style: MapStyle;
  difficulty: number;
  sandbox: boolean;
  day: number;
  funds: number;
  taxes: Record<GrowKind, number>;
  n: number;
  heights: Float32Array;
  road: Uint8Array;
  conn: Uint8Array;
  flow?: Uint8Array;
  deck?: Float32Array;
  up?: Uint8Array;
  conn1?: Uint8Array;
  flow1?: Uint8Array;
  upH?: Float32Array;
  lift?: Float32Array;
  rail?: Uint8Array;
  erail?: Uint8Array;
  mono?: Uint8Array;
  sub?: Uint8Array;
  bstop?: Uint8Array;
  ictl?: Uint8Array;
  isplit?: Uint8Array;
  iflags?: Uint8Array;
  pline: Uint8Array;
  zone: Uint8Array;
  zden: Uint8Array;
  bldg: Int32Array;
  tree: Uint8Array;
  buildings: Building[];
  nextId: number;
  rng: number;
  demand: Record<GrowKind, number>;
  congestion: Float32Array;
  traffic: Float32Array;
  history: { pop: number; funds: number }[];
  milestones: number[];
  services?: ServiceState;
  ordinances?: OrdinanceId[];
  loans?: Loan[];
  rating?: number;
  ilInland?: number; // 内陸の倉庫業の需要（古い保存データにはない）
}

export interface CmdResult {
  ok: boolean;
  msg?: string;
  cost?: number;
}

export type Command =
  | { t: 'road'; x0: number; y0: number; x1: number; y1: number; road: RoadType }
  | { t: 'zone'; x0: number; y0: number; x1: number; y1: number; zone: ZoneType; den: number }
  | { t: 'bulldoze'; x0: number; y0: number; x1: number; y1: number }
  | { t: 'pline'; x0: number; y0: number; x1: number; y1: number }
  | { t: 'plop'; id: CivicId; x: number; y: number }
  | { t: 'tax'; kind: GrowKind; rate: number }
  | { t: 'ramp'; x: number; y: number }
  | { t: 'diamond'; x: number; y: number }
  | { t: 'clover'; x: number; y: number }
  | { t: 'transit'; x0: number; y0: number; x1: number; y1: number; kind: LineKind }
  | { t: 'busstop'; x: number; y: number }
  | { t: 'junction'; cell: number; ctl: number; split: number; flags: number }
  | { t: 'bridgeStyle'; cell: number; style: number }
  | { t: 'estop'; x: number; y: number }
  | { t: 'funding'; dept: Dept; value: number }
  | { t: 'facilityFund'; id: number; value: number }
  | { t: 'rotate'; id: number }
  | { t: 'platformStyle'; cell: number; style: number }
  | { t: 'ordinance'; id: OrdinanceId; on: boolean }
  | { t: 'loan'; amount: number }
  | { t: 'repay'; id: number }
  | { t: 'uramp'; x: number; y: number }
  | { t: 'terrain'; op: TerrainOp; x0: number; y0: number; x1: number; y1: number }
  | { t: 'reclaim'; style: number; x0: number; y0: number; x1: number; y1: number }
  | { t: 'trees'; x0: number; y0: number; x1: number; y1: number };

// 倉庫業の魅力：港・貨物駅のすぐ近く（近さ 1）と、幹線道路・高速道路の近くで足す値
const LOGI_PORT_W = 1.0;
const LOGI_ROAD_W = 0.15;
// 倉庫業の需要：街の荷物（工業と店の雇用）に対する割合（港がないとき）、港 1 つあたりの割合と、港 1 つあたりの量、港の効果の割合
const IL_WANT_BASE = 0.03;
const IL_WANT_PORT = 0.06;
const IL_WANT_PORT_FLAT = 100;
const IL_PORT_SHARE = 0.5;
// 港・貨物駅への近さが 0.3 以上なら、港の分の需要も使える（それより遠いと少しずつ減る）
const ilPortMix = (near: number) => Math.min(1, near / 0.3);
// CIQ庁舎のまわり：需要が足りないときでも、毎日これだけの回数は倉庫業が建つのをためす。種類を選ぶときの需要の下限
const CIQ_TRIES = 2;
const CIQ_DEMAND = 0.6;
// 範囲の中の工場（汚染型・製造業・ハイテク）を倉庫業に建て替える：1軒・1日あたりの確率（平均でおよそ 1 年半〜2 年）、
// 建ってからの日数の下限、古い順に何軒から選ぶか
const CIQ_REDEV_P = 1 / 600;
const CIQ_REDEV_AGE = 180;
const CIQ_REDEV_PICK = 3;

const emptyKinds = (v: number) => Object.fromEntries(GROW_KINDS.map((k) => [k, v])) as Record<GrowKind, number>;

export class World {
  g: Grid;
  name = '新しい街';
  seed = 1;
  style: MapStyle = 'river';
  difficulty = 1;
  sandbox = false;
  day = 0;
  funds = 100000;
  taxes = emptyKinds(DEFAULT_TAX);
  buildings = new Map<number, Building>();
  nextId = 1;
  rng = new Rng(1);
  demand = emptyKinds(0);
  history: { pop: number; funds: number }[] = [];
  milestones: number[] = [];

  maps: Maps;
  stats!: Stats;
  news: string[] = [];

  // 変更の通知用
  gridVersion = 1;
  heightVersion = 1;
  private waterCache: { v: number; w: ReturnType<typeof labelWater> } | null = null;
  buildingVersion = 1;
  mapsVersion = 1;

  private candidates: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] };
  private upgrades: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] };
  // CIQ庁舎の範囲の中の、工業ゾーンの空き地と、倉庫業に建て替える工場（古い順）
  private ciqCands: number[] = [];
  private ciqOld: number[] = [];
  private candidatesDirty = true;
  private resDensity = new Float32Array(0);
  private commuteAtCell = new Float32Array(0);
  private lastMonthIncome = 0;
  private lastMonthExpense = 0;
  private incomeBreakdown: Record<string, number> = {};
  private expenseBreakdown: Record<string, number> = {};
  private avgCommute = 0;
  private employedTotal = 0;
  private powerSupply = 0;
  private powerDemand = 0;
  private waterSupply = 0;
  private waterDemand = 0;
  private neighborConnected = false;
  private warnedPower = false;
  private warnedWater = false;
  speed = 2;
  private cachedPop = 0;

  constructor(n = 128) {
    this.g = new Grid(n);
    this.maps = this.makeMaps(n);
    this.resDensity = new Float32Array(n * n);
    this.commuteAtCell = new Float32Array(n * n);
    this.updateStats();
  }

  private makeMaps(n: number): Maps {
    const c = n * n;
    // 交通量と混雑度は、地上と上空の2階層分
    const congestion = new Float32Array(c * 2);
    congestion.fill(1);
    return {
      power: new Uint8Array(c),
      water: new Uint8Array(c),
      landValue: new Uint8Array(c),
      pollution: new Uint8Array(c),
      traffic: new Float32Array(c * 2),
      freight: new Float32Array(c * 2),
      jctl: new Uint8Array(c),
      riders: new Float32Array(c * 5),
      ...makeServiceMaps(c),
      congestion,
    };
  }

  static create(opts: { name: string; seed: number; style: MapStyle; difficulty: number; sandbox: boolean; n?: number }) {
    const w = new World(opts.n ?? 128);
    w.name = opts.name;
    w.seed = opts.seed;
    w.style = opts.style;
    w.difficulty = opts.difficulty;
    w.sandbox = opts.sandbox;
    w.funds = opts.sandbox ? 99999999 : DIFFICULTY[opts.difficulty].funds;
    w.rng = new Rng(opts.seed ^ 0x9e3779b9);
    generateTerrain(w.g, opts.seed, opts.style);
    w.recomputeAll();
    w.pushNews(`「${w.name}」の市長に就任しました。まずは道路を引いて、ゾーンを指定しましょう。`);
    return w;
  }

  // ---------------- 保存と読み込み ----------------
  serialize(): SaveData {
    const g = this.g;
    return {
      version: 1,
      name: this.name,
      seed: this.seed,
      style: this.style,
      difficulty: this.difficulty,
      sandbox: this.sandbox,
      day: this.day,
      funds: this.funds,
      taxes: { ...this.taxes },
      n: g.n,
      heights: g.heights.slice(),
      ...(Object.fromEntries([...GRID_U8, ...GRID_F32].map((k) => [k, g[k].slice()])) as Pick<SaveData, 'road' | 'conn' | 'pline' | 'zone' | 'zden' | 'tree'>),
      bldg: g.bldg.slice(),
      buildings: [...this.buildings.values()].map((b) => ({ ...b })),
      nextId: this.nextId,
      rng: this.rng.state,
      demand: { ...this.demand },
      congestion: this.maps.congestion.slice(),
      traffic: this.maps.traffic.slice(),
      history: this.history.slice(),
      milestones: this.milestones.slice(),
      services: JSON.parse(JSON.stringify(this.services)),
      ordinances: [...this.ordinances],
      loans: this.loans.map((l) => ({ ...l })),
      rating: this.rating,
      ilInland: this.ilInland,
    };
  }

  static load(d: SaveData): World {
    const w = new World(d.n);
    const g = w.g;
    w.name = d.name;
    w.seed = d.seed;
    w.style = d.style;
    w.difficulty = d.difficulty;
    w.sandbox = d.sandbox;
    w.day = d.day;
    w.funds = d.funds;
    w.taxes = { ...emptyKinds(DEFAULT_TAX), ...d.taxes };
    g.heights.set(d.heights);
    const rec = d as unknown as Record<string, ArrayLike<number> | undefined>;
    for (const k of [...GRID_U8, ...GRID_F32]) {
      const v = rec[k];
      if (v && v.length === g[k].length) g[k].set(v);
    }
    // 古い保存データには flow がないので、すべて両方向にする
    if (!d.flow) g.flow.set(d.conn);
    g.bldg.set(d.bldg);
    for (const b of d.buildings) w.buildings.set(b.id, { ...b, floors: b.floors ?? 0 });
    w.nextId = d.nextId;
    w.rng.state = d.rng;
    w.demand = { ...emptyKinds(0), ...d.demand };
    w.ilInland = d.ilInland ?? w.demand.IL; // 古い保存データは街全体の需要から始める
    if (d.congestion && d.congestion.length === w.maps.congestion.length) w.maps.congestion.set(d.congestion);
    if (d.traffic && d.traffic.length === w.maps.traffic.length) w.maps.traffic.set(d.traffic);
    w.history = d.history || [];
    w.milestones = d.milestones || [];
    if (d.services) w.services = { ...defaultServiceState(), ...d.services };
    if (!w.services.funeral) w.services.funeral = defaultServiceState().funeral;
    w.ordinances = new Set(d.ordinances ?? []);
    w.fx = ordinanceEffects(w.ordinances);
    w.loans = (d.loans ?? []).map((l) => ({ ...l }));
    w.nextLoanId = Math.max(1, ...w.loans.map((l) => l.id + 1));
    w.rating = d.rating ?? 55;
    linkUrbanEnds(g);
    linkURampMiddles(g); // 以前の版で、ランプの横に後から引いた一般道がつながっていなかった
    levelViaductsOverWater(g); // 高架の高速道路は、川の上でも両岸の高さを保つ（以前の版は水の上で沈んでいた）
    levelAvenueDecks(g); // 大通りの橋は、2本の車線で1枚の床版（以前の版は車線ごとに高さが違った）
    normalizeAvenueJunctions(g); // 大通りの交差点は1つの制御。ロータリーは信号にする
    w.recomputeAll();
    // 高層ビル街の中心ほど高くなるように、高密度の建物の高さを合わせ直す
    w.reshapeSkyline();
    w.recomputeAll();
    return w;
  }

  // ---------------- お知らせ ----------------
  pushNews(s: string) {
    this.news.push(s);
  }

  // ---------------- コマンド ----------------
  private spend(cost: number): boolean {
    if (this.sandbox) return true;
    if (cost > this.funds) return false;
    this.funds -= cost;
    return true;
  }

  exec(c: Command): CmdResult {
    const g = this.g;
    switch (c.t) {
      case 'road': {
        // 大通りは格子点（なぞった線が中心線）、それ以外はマスの座標
        const plan = planRoadCmd(g, c.road, c.x0, c.y0, c.x1, c.y1);
        if (!plan.ok) return { ok: false, msg: plan.reason || '道路を引けません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyRoad(g, plan);
        linkURampMiddles(g);
        linkUrbanEnds(g);
        if (plan.vertexH.size) this.heightVersion++;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'uramp': {
        const plan = planURamp(g, c.x, c.y);
        if (!plan.ok) return { ok: false, msg: plan.reason };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyURamp(g, plan);
        this.afterGridChange();
        return { ok: true, cost: plan.cost, msg: plan.road < 0 ? '真ん中のマスの外側に一般道をつないでください' : undefined };
      }
      case 'trees': {
        const plan = planTrees(g, c.x0, c.y0, c.x1, c.y1);
        if (!plan.cells.length) return { ok: false, msg: '木を植えられる場所がありません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        for (const i of plan.cells) g.tree[i] = 3;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'terrain': {
        const plan = planTerrain(g, c.op, c.x0, c.y0, c.x1, c.y1);
        if (!plan.changes.size) return { ok: false, msg: plan.locked.length ? '道路や建物があるところは変えられません' : 'これ以上は変えられません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyTerrain(g, plan);
        this.heightVersion++;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'reclaim': {
        const style = c.style === 2 ? 2 : 1;
        const plan = planReclaim(g, style, c.x0, c.y0, c.x1, c.y1);
        if (!plan.fill.length && !plan.quay.length) return { ok: false, msg: '埋め立てや岸壁にできる水辺がありません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyReclaim(g, plan, style);
        this.heightVersion++;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'zone': {
        const r = normRect(c.x0, c.y0, c.x1, c.y1, g.n);
        const plan = planZone(g, r, c.zone, c.den);
        if (!plan.cells.length) return { ok: false, msg: 'ゾーンを指定できる場所がありません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyZone(g, plan);
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'bulldoze': {
        const r = normRect(c.x0, c.y0, c.x1, c.y1, g.n);
        const plan = planBulldoze(g, r, (id) => this.buildings.get(id));
        if (!plan.roads.length && !plan.lines.length && !plan.buildings.length && !plan.trees.length && !plan.transit.length)
          return { ok: false, msg: '取り壊すものがありません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        for (const id of plan.buildings) this.removeBuilding(id);
        for (const i of plan.roads) this.removeRoad(i);
        for (const i of plan.lines) g.pline[i] = 0;
        for (const i of plan.transit) removeTransitAt(g, i);
        for (const i of plan.trees) g.tree[i] = 0;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'pline': {
        const path = planLine(g, c.x0, c.y0, c.x1, c.y1);
        const plan = planPowerLine(g, path);
        if (!plan.ok) return { ok: false, msg: plan.reason };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        for (const i of path.cells) {
          g.pline[i] = 1;
          g.tree[i] = 0;
        }
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'plop': {
        const plan = planPlop(g, c.id, c.x, c.y);
        if (!plan.ok) return { ok: false, msg: plan.reason };
        if (REWARD_REQ[c.id]) {
          if ([...this.buildings.values()].some((b) => b.type === c.id)) return { ok: false, msg: `${CIVIC[c.id].name}は1つしか建てられません` };
          // サンドボックスでは条件なしで建てられる
          if (!this.sandbox && !rewardUnlocked(c.id, this.population(), this.rating, this.services.eq.adult)) return { ok: false, msg: `まだ建てられません（条件：${REWARD_REQ[c.id].label}）` };
        }
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        const def = CIVIC[c.id];
        flattenRect(g, plan.x, plan.y, plan.w, plan.h, plan.flatH);
        this.heightVersion++;
        const b: Building = {
          id: this.nextId++, civic: true, type: c.id, x: plan.x, y: plan.y, w: plan.w, h: plan.h,
          face: def.waterfront ? this.waterFace(plan.x, plan.y, plan.w, plan.h) : this.findFace(plan.x, plan.y, plan.w, plan.h), seed: this.rng.int(1e9), den: 0, cap: 0, occ: 0,
          state: BState.Normal, stateDays: 0, powered: false, watered: false, floors: 0, commute: 0, employed: 1, badMonths: 0,
        };
        this.placeBuilding(b);
        this.afterGridChange();
        let msg: string | undefined;
        if (def.water && !this.accessCells(b).length) msg = '道路に面していないので、水を送れません';
        return { ok: true, cost: plan.cost, msg };
      }
      case 'ramp': {
        const plan = planRamp(g, c.x, c.y);
        if (!plan.ok) return { ok: false, msg: plan.reason };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyRamp(g, plan);
        this.afterGridChange();
        return { ok: true, cost: plan.cost, msg: plan.roads.length ? undefined : 'ランプを置きました。一般の道路をつないでください' };
      }
      case 'diamond': {
        const plan = planDiamond(g, c.x, c.y);
        if (!plan.ok || !plan.road) return { ok: false, msg: plan.reason };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyDiamond(g, plan);
        this.heightVersion++;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'estop': {
        const plan = planEStop(g, c.x, c.y);
        if (!plan.ok) return { ok: false, msg: plan.reason };
        if (plan.remove) {
          for (const i of plan.cells) g.estn[i] = 0;
          this.afterGridChange();
          return { ok: true, msg: '駅を外しました' };
        }
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        for (const i of plan.cells) g.estn[i] = 1;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'busstop': {
        const plan = planBusStop(g, c.x, c.y);
        if (!plan.ok) return { ok: false, msg: plan.reason };
        if (plan.remove) {
          g.bstop[plan.cell] = 0;
          this.afterGridChange();
          return { ok: true, msg: 'バス停を外しました' };
        }
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        g.bstop[plan.cell] = 1;
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'transit': {
        const path = planLine(g, c.x0, c.y0, c.x1, c.y1);
        const plan = planTransitLine(g, path, c.kind);
        if (!plan.ok) return { ok: false, msg: plan.reason || '線路を引けません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyTransitLine(g, plan);
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'clover': {
        const plan = planCloverleaf(g, c.x, c.y);
        if (!plan.ok) return { ok: false, msg: plan.reason };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyCloverleaf(g, plan);
        this.afterGridChange();
        return { ok: true, cost: plan.cost };
      }
      case 'bridgeStyle': {
        // つながっている橋のマス全部の形を変える
        const n = g.n;
        if (c.cell < 0 || c.cell >= n * n) return { ok: false, msg: '橋が見つかりません' };
        // 道路の橋か、川を渡る高架鉄道
        const railB = (i: number) => g.erail[i] !== 0 && g.isWater(i % n, (i / n) | 0);
        const roadB = (i: number) => g.road[i] !== 0 && g.deck[i] > 0;
        const same = railB(c.cell) && !roadB(c.cell) ? railB : roadB;
        if (!same(c.cell)) return { ok: false, msg: '橋が見つかりません' };
        const st = [c.cell], seen = new Set(st);
        while (st.length) {
          const i = st.pop()!;
          g.bstyle[i] = Math.max(0, Math.min(5, c.style | 0));
          const x = i % n, y = (i / n) | 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!g.inb(x + dx, y + dy)) continue;
              const j = g.idx(x + dx, y + dy);
              if (seen.has(j) || !same(j)) continue;
              seen.add(j);
              st.push(j);
            }
        }
        this.gridVersion++;
        return { ok: true };
      }
      case 'junction': {
        if (c.cell < 0 || c.cell >= g.n * g.n || !g.road[c.cell]) return { ok: false, msg: '交差点が見つかりません' };
        // 大通りの交差点は、まとまりのマスすべてに同じ設定をする（ロータリーにはできないので信号にする）
        const grp = junctionGroup(g, c.cell);
        const ctl = grp.avenue && c.ctl === Ctl.Roundabout ? Ctl.Signal : c.ctl;
        for (const cell of grp.cells) {
          g.ictl[cell] = ctl;
          g.isplit[cell] = Math.max(10, Math.min(90, Math.round(c.split)));
          g.iflags[cell] = c.flags;
        }
        this.maps.jctl.set(buildJunctions(g, this.maps.traffic).ctl);
        this.mapsVersion++;
        this.gridVersion++;
        return { ok: true };
      }
      case 'ordinance': {
        const def = ORDINANCES.find((o) => o.id === c.id);
        if (!def) return { ok: false, msg: '条例が見つかりません' };
        if (c.on && this.population() < def.minPop) return { ok: false, msg: `人口が ${def.minPop.toLocaleString()} 人を超えると施行できます` };
        if (c.on) this.ordinances.add(c.id);
        else this.ordinances.delete(c.id);
        this.fx = ordinanceEffects(this.ordinances);
        this.updateStats();
        return { ok: true, msg: `${def.name}を${c.on ? '施行' : '廃止'}しました` };
      }
      case 'loan': {
        if (!LOAN_AMOUNTS.includes(c.amount)) return { ok: false, msg: '金額が正しくありません' };
        if (this.loans.length >= MAX_LOANS) return { ok: false, msg: `借入は ${MAX_LOANS} 件までです` };
        const rate = loanRate(this.funds, this.lastMonthIncome - this.lastMonthExpense, this.loans.length);
        const l = newLoan(this.nextLoanId++, c.amount, rate);
        this.loans.push(l);
        if (!this.sandbox) this.funds += c.amount;
        this.updateStats();
        return { ok: true, msg: `§${c.amount.toLocaleString()} を年利 ${rate.toFixed(1)}% で借りました（毎月 §${Math.round(l.payment).toLocaleString()} を10年間返済）` };
      }
      case 'repay': {
        const l = this.loans.find((x) => x.id === c.id);
        if (!l) return { ok: false, msg: '借入が見つかりません' };
        const amount = Math.round(l.remaining);
        if (!this.spend(amount)) return { ok: false, msg: '資金が足りません' };
        this.loans = this.loans.filter((x) => x !== l);
        this.updateStats();
        return { ok: true, msg: `§${amount.toLocaleString()} を返して、借入を終えました` };
      }
      case 'funding': {
        this.services.funding[c.dept] = Math.max(0, Math.min(150, Math.round(c.value)));
        this.updateStats();
        return { ok: true };
      }
      case 'platformStyle': {
        const cells = platformCells(g, c.cell, [...this.buildings.values()]);
        if (!cells.length) return { ok: false, msg: '駅が見つかりません' };
        for (const i of cells) g.pstyle[i] = c.style ? 1 : 0;
        this.gridVersion++;
        return { ok: true };
      }
      case 'rotate': {
        // 見た目の向きだけを変える（正方形の敷地は 90 度ずつ、長方形は 180 度）。道路への出入りは向きに関係ない
        const b = this.buildings.get(c.id);
        if (!b) return { ok: false, msg: '建物が見つかりません' };
        const order = [2, 0, 6, 4]; // 南 → 東 → 北 → 西
        const k = Math.max(0, order.indexOf(b.face));
        b.face = b.w === b.h ? order[(k + 1) % 4] : (b.face + 4) & 7;
        this.buildingVersion++;
        return { ok: true };
      }
      case 'facilityFund': {
        const b = this.buildings.get(c.id);
        if (!b || !b.civic) return { ok: false, msg: '施設が見つかりません' };
        b.fund = Math.max(0, Math.min(150, Math.round(c.value)));
        this.buildingVersion++;
        return { ok: true };
      }
      case 'tax': {
        this.taxes[c.kind] = Math.max(0, Math.min(20, Math.round(c.rate * 10) / 10));
        return { ok: true };
      }
    }
  }

  private afterGridChange() {
    regradeApproaches(this.g);
    // 線路がなくなった駅のホームは消す
    for (let i = 0; i < this.g.estn.length; i++) if (this.g.estn[i] && !this.g.erail[i]) this.g.estn[i] = 0;
    this.gridVersion++;
    this.candidatesDirty = true;
    this.logiRoadsDirty = true;
    this.updatePower();
    this.updateWater();
    this.mapsVersion++;
    this.buildingVersion++;
    this.updateStats();
  }

  private removeRoad(i: number) {
    const g = this.g, n = g.n;
    const x = i % n, y = (i / n) | 0;
    const m = g.conn[i] | g.conn1[i];
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (!g.inb(nx, ny)) continue;
      const j = ny * n + nx, b = ~(1 << ((d + 4) & 7));
      g.conn[j] &= b;
      g.flow[j] &= b;
      g.conn1[j] &= b;
      g.flow1[j] &= b;
      // 上空の道路がどこにもつながらなくなったら消す（立体交差の残り）
      if (g.up[j] && !g.conn1[j]) { g.up[j] = 0; g.upH[j] = 0; }
    }
    g.road[i] = 0;
    g.conn[i] = 0;
    g.flow[i] = 0;
    g.deck[i] = 0;
    g.bstop[i] = 0;
    g.up[i] = 0;
    g.conn1[i] = 0;
    g.flow1[i] = 0;
    g.upH[i] = 0;
    g.ictl[i] = 0;
    g.isplit[i] = 50;
    g.iflags[i] = 0;
  }

  private placeBuilding(b: Building) {
    const g = this.g;
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = g.idx(x, y);
        g.bldg[i] = b.id;
        g.tree[i] = 0;
        if (b.civic) {
          g.zone[i] = 0;
          g.zden[i] = 0;
        }
      }
    this.buildings.set(b.id, b);
    this.buildingVersion++;
    if (b.civic && LOGI_REACH[b.type as CivicId]) this.logiPortsDirty = this.candidatesDirty = true;
  }

  private removeBuilding(id: number) {
    const b = this.buildings.get(id);
    if (!b) return;
    const g = this.g;
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = g.idx(x, y);
        if (g.bldg[i] === id) g.bldg[i] = 0;
      }
    this.buildings.delete(id);
    this.buildingVersion++;
    this.gridVersion++;
    this.candidatesDirty = true;
    if (b.civic && LOGI_REACH[b.type as CivicId]) this.logiPortsDirty = true;
  }

  // 敷地の正面（道路に面した辺）を探す
  private findFace(x: number, y: number, w: number, h: number): number {
    const g = this.g;
    const score = [0, 0, 0, 0, 0, 0, 0, 0];
    const has = (cx: number, cy: number) => g.inb(cx, cy) && g.road[g.idx(cx, cy)] !== 0;
    for (let k = 0; k < h; k++) {
      if (has(x + w, y + k)) score[0]++;
      if (has(x - 1, y + k)) score[4]++;
    }
    for (let k = 0; k < w; k++) {
      if (has(x + k, y + h)) score[2]++;
      if (has(x + k, y - 1)) score[6]++;
    }
    let best = 2, bs = -1;
    for (const d of [2, 0, 6, 4]) if (score[d] > bs) { bs = score[d]; best = d; }
    if (bs > 0) return best;
    // 角の斜めの道路
    if (has(x + w, y + h)) return 2;
    if (has(x - 1, y + h)) return 2;
    if (has(x + w, y - 1)) return 6;
    if (has(x - 1, y - 1)) return 6;
    return 2;
  }

  // 水辺の施設は、裏側（桟橋や岸壁）が水のほうを向くようにする
  private waterFace(x: number, y: number, w: number, h: number): number {
    const g = this.g;
    const wet = (cx: number, cy: number) => (g.inb(cx, cy) && g.isWater(cx, cy) ? 1 : 0);
    const score = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < h; k++) {
      score[0] += wet(x + w, y + k);
      score[4] += wet(x - 1, y + k);
    }
    for (let k = 0; k < w; k++) {
      score[2] += wet(x + k, y + h);
      score[6] += wet(x + k, y - 1);
    }
    let best = 2, bs = -1;
    for (const d of [0, 2, 4, 6]) if (score[d] > bs) { bs = score[d]; best = d; }
    return (best + 4) & 7;
  }

  // 敷地の周りにある道路マス
  accessCells(b: { x: number; y: number; w: number; h: number }): number[] {
    const g = this.g;
    const out: number[] = [];
    for (let y = b.y - 1; y <= b.y + b.h; y++)
      for (let x = b.x - 1; x <= b.x + b.w; x++) {
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) continue;
        if (g.inb(x, y) && this.isLocalRoad(g.road[g.idx(x, y)])) out.push(g.idx(x, y));
      }
    return out;
  }

  private isLocalRoad(t: number) {
    return t !== 0 && !isHighway(t) && t !== RoadType.Ramp;
  }

  private hasRoadAccess(x: number, y: number) {
    const g = this.g;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (g.inb(nx, ny) && this.isLocalRoad(g.road[g.idx(nx, ny)])) return true;
    }
    return false;
  }

  // ---------------- 時間を進める ----------------
  // 1日進める
  stepDay() {
    this.day++;
    this.growthStep();
    this.constructionStep();
    if (this.day % DAYS_PER_MONTH === 0) this.monthly();
    this.updateStats();
  }

  private constructionStep() {
    for (const b of this.buildings.values()) {
      b.stateDays++;
      if (b.state === BState.Building && b.stateDays >= 20 + (b.seed % 15)) {
        b.state = BState.Normal;
        b.stateDays = 0;
        const def = GROW[b.type as GrowKind];
        // 住宅はすぐに入居、職場は通勤の計算で埋まる
        if (def.zone === ZoneType.R) b.occ = b.cap;
        else b.occ = Math.round(b.cap * 0.5);
        this.buildingVersion++;
        if (this.buildings.size < 3 && !this.milestones.includes(0)) {
          this.milestones.push(0);
          this.pushNews('最初の建物が完成しました！');
        }
      }
    }
  }

  // ---------------- 建物の成長 ----------------
  private rebuildCandidates() {
    const g = this.g, n = g.n;
    this.candidates = { 1: [], 2: [], 3: [], 4: [] };
    // 建て替えの候補：ゾーンの密度が建物より高い、または古くなった中・高密度の建物
    this.upgrades = { 1: [], 2: [], 3: [], 4: [] };
    for (const b of this.buildings.values()) {
      if (b.civic || b.state !== BState.Normal) continue;
      const z = GROW[b.type as GrowKind].zone;
      const zd = g.zden[g.idx(b.x, b.y)];
      if (g.zone[g.idx(b.x, b.y)] !== z) continue;
      // ハイテク産業の需要があるときは、古くなった工場（1年以上）も建て替えの候補にする
      const oldFactory = (b.type === 'ID' || b.type === 'IM') && zd > 0 && b.stateDays > 360 && this.demand.IH > 0.1;
      if (zd > b.den || (zd > 0 && b.stateDays > 720) || oldFactory) this.upgrades[z].push(b.id);
    }
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const z = g.zone[i];
        if (!z || g.bldg[i] || g.road[i] || hasSurfaceLine(g, i)) continue;
        if (!this.hasRoadAccess(x, y)) continue;
        this.candidates[z].push(i);
      }
    // CIQ庁舎の範囲の中
    this.ciqCands = [];
    this.ciqOld = [];
    const ciq = this.logiField().ciq;
    if (this.hasCiq) {
      for (const i of this.candidates[ZoneType.I]) if (ciq[i]) this.ciqCands.push(i);
      const old: Building[] = [];
      for (const b of this.buildings.values()) {
        if (b.civic || b.state !== BState.Normal || b.type === 'IL' || GROW[b.type as GrowKind].zone !== ZoneType.I) continue;
        if (ciq[g.idx(b.x + (b.w >> 1), b.y + (b.h >> 1))]) old.push(b);
      }
      old.sort((a, b) => b.stateDays - a.stateDays || a.id - b.id);
      this.ciqOld = old.map((b) => b.id);
    }
    this.candidatesDirty = false;
  }

  desirability(kind: GrowKind, i: number): number {
    const lv = this.maps.landValue[i] / 255;
    const pol = this.maps.pollution[i] / 100;
    const cm = this.commuteAtCell[i] || 8;
    const commutePen = Math.max(0, (cm - 20) / 60);
    const res = Math.min(1, this.resDensity[i] / 40);
    const traffic = Math.min(1, this.maps.traffic[i] / 1200);
    const water = this.maps.water[i] ? 0 : 0.15;
    // 公共サービス：犯罪・火災の危険・ゴミは魅力を下げ、医療と教育は上げる
    const crime = this.maps.crime[i] / 255, fire = this.maps.fireRisk[i] / 255;
    const hlt = this.maps.health[i] / 255, edu = this.maps.edu[i] / 255;
    const garbage = this.svc.garbageLevel;
    const eq = this.services.eq.adult;
    const svcR = -0.45 * crime - 0.25 * fire - 0.35 * garbage + 0.15 * hlt + 0.1 * edu + this.fx.rDesire - 0.3 * this.services.funeral.shortage;
    const svcC = -0.3 * crime - 0.2 * fire - 0.25 * garbage;
    let base = this.desirabilityBase(kind, lv, pol, commutePen, res, traffic, water, eq);
    const zone = GROW[kind].zone;
    if (zone === ZoneType.C) {
      // オフィスは高層ビル街の中心と、ほかのオフィスの近くに集まる。店舗は中心をさけ、住宅の近く・地区の外側に
      const core = this.coreMap()[i], office = this.officeNear![i];
      if (kind === 'CO2' || kind === 'CO3') base += 0.7 * core + 0.8 * office - 0.25 * res;
      else base += -0.6 * core * (kind === 'CS1' ? 1.2 : 1) - 0.5 * office + 0.15 * res;
    } else if (kind === 'IL') {
      // 倉庫業は港・貨物駅のすぐ近くに集まる。幹線道路・高速道路の近くも少し好む
      const f = this.logiField();
      base += LOGI_PORT_W * f.near[i] + LOGI_ROAD_W * f.major[i];
    }
    return base + (zone === ZoneType.R ? svcR * (kind === 'R1' ? 0.6 : kind === 'R3' ? 1.4 : 1) : zone === ZoneType.C ? svcC : -0.15 * fire - 0.2 * garbage);
  }

  private desirabilityBase(kind: GrowKind, lv: number, pol: number, commutePen: number, res: number, traffic: number, water: number, eq: number): number {
    switch (kind) {
      case 'R1': return 0.7 + 0.1 * lv - 0.4 * pol - commutePen - water * 0.5;
      case 'R2': return 0.3 + 0.7 * lv - 0.9 * pol - commutePen * 1.2 - water;
      case 'R3': return -0.25 + 1.3 * lv - 1.6 * pol - commutePen * 1.5 - water * 1.5;
      case 'CS1': return 0.35 + 0.5 * res + 0.3 * traffic - 0.2 * pol - water * 0.5;
      case 'CS2': return 0.15 + 0.5 * res + 0.3 * traffic + 0.4 * lv - 0.4 * pol - water;
      case 'CS3': return -0.3 + 0.4 * res + 0.2 * traffic + 1.0 * lv - 0.8 * pol - water * 1.5;
      case 'CO2': return 0.2 + 0.5 * lv + 0.4 * traffic + 0.2 * res - 0.5 * pol - water;
      case 'CO3': return -0.25 + 1.0 * lv + 0.4 * traffic + 0.1 * res - 0.8 * pol - water * 1.5;
      case 'IA': return 0.75 - 0.6 * lv - 0.5 * res;
      case 'ID': return 0.7 - 0.2 * lv - water * 0.5;
      case 'IM': return 0.5 + 0.1 * lv - 0.3 * pol - water;
      // 倉庫業：内陸では製造業より少し低い（港・貨物駅の近さの分は desirability で足す。内陸に建つ量は内陸の需要で決まる）
      case 'IL': return 0.45 + 0.1 * lv - 0.1 * pol - water * 0.8;
      // 汚れた工場の近くはきらうが、工業地域でも建てられるくらいに（汚染の少ない工業地域ほど建ちやすい）
      case 'IH': return 0.52 + 0.5 * lv - 0.45 * pol - water * 1.2 + Math.max(0, (eq - 50) / 100);
    }
  }

  // 倉庫業の立地：港・貨物駅への近さ（near, 0..1）、大きな敷地が建つ範囲（full）、幹線道路・高速道路の近さ（major, 0..1）。
  // 港・貨物駅が変わったとき、道路が変わったときだけ作り直す
  // ciq = CIQ庁舎の範囲の中（倉庫業だけが建つ）
  private logi: { near: Float32Array; full: Uint8Array; major: Float32Array; ciq: Uint8Array } | null = null;
  private hasCiq = false;
  private logiPortsDirty = true;
  private logiRoadsDirty = true;
  logiField() {
    const g = this.g, n = g.n, N = n * n;
    let f = this.logi;
    if (!f || f.near.length !== N) {
      f = this.logi = { near: new Float32Array(N), full: new Uint8Array(N), major: new Float32Array(N), ciq: new Uint8Array(N) };
      this.logiPortsDirty = this.logiRoadsDirty = true;
    }
    if (this.logiPortsDirty) {
      f.near.fill(0);
      f.full.fill(0);
      f.ciq.fill(0);
      this.hasCiq = false;
      for (const b of this.buildings.values()) {
        const r = b.civic ? LOGI_REACH[b.type as CivicId]?.grow : undefined;
        if (!r) continue;
        const isCiq = !!CIVIC[b.type as CivicId].ciq;
        if (isCiq) this.hasCiq = true;
        const R = Math.ceil(r[2]);
        const xa = Math.max(0, b.x - R), xb = Math.min(n - 1, b.x + b.w + R), ya = Math.max(0, b.y - R), yb = Math.min(n - 1, b.y + b.h + R);
        for (let y = ya; y <= yb; y++)
          for (let x = xa; x <= xb; x++) {
            const i = y * n + x, c = logiReach(b, x + 0.5, y + 0.5);
            if (c.v > f.near[i]) f.near[i] = c.v;
            if (c.full) f.full[i] = 1;
            if (isCiq && c.full) f.ciq[i] = 1;
          }
      }
      this.logiPortsDirty = false;
    }
    if (this.logiRoadsDirty) {
      // ランプ（高速道路の出入口）、高速道路、大通りのまわり
      const src = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const t = g.road[i];
        src[i] = t === RoadType.Ramp ? 1 : isHighway(t) || isHighway(g.up[i]) ? 0.6 : t === RoadType.Avenue ? 0.5 : 0;
      }
      const b = blur(src, n, 3, 2);
      for (let i = 0; i < N; i++) f.major[i] = Math.min(1, b[i] * 5);
      this.logiRoadsDirty = false;
    }
    return f;
  }

  // 倉庫業の需要（場所ごと）：港・貨物駅の近くは街全体の需要、遠い内陸は街の荷物の分（港の分を除く）だけ
  private ilInland = 0;
  private ilDemandAt(i: number) {
    const t = ilPortMix(this.logiField().near[i]);
    const inland = Math.min(this.ilInland, this.demand.IL);
    return inland + (this.demand.IL - inland) * t;
  }

  private growthStep() {
    if (this.candidatesDirty) this.rebuildCandidates();
    const g = this.g;
    const pop = this.cachedPop;
    for (const z of [ZoneType.R, ZoneType.C, ZoneType.I, ZoneType.F]) {
      const kindsAll = ZONE_KINDS[z];
      const maxDem = Math.max(...kindsAll.map((k) => this.demand[k]));
      if (maxDem <= 0.02) continue;
      const list = this.candidates[z];
      const ups = this.upgrades[z];
      const attempts = Math.ceil(maxDem * 2);
      for (let a = 0; a < attempts; a++) {
        // 空き地か、建て替え（需要が高いときほど起きやすい）
        let i: number, replace = 0;
        // 工業はハイテク産業の需要があるとき、建て替えを多めにためす（空き地は小さなすき間が多く、ハイテク産業が入れない）
        const upRate = z === ZoneType.I && this.demand.IH > 0.1 ? 0.5 : 0.25;
        if (ups.length && (!list.length || this.rng.next() < upRate * maxDem)) {
          const b = this.buildings.get(ups[this.rng.int(ups.length)]);
          if (!b || b.state !== BState.Normal) continue;
          i = g.idx(b.x + this.rng.int(b.w), b.y + this.rng.int(b.h));
          replace = b.id;
        } else {
          if (!list.length) continue;
          i = list[this.rng.int(list.length)];
          if (g.bldg[i]) continue;
        }
        if (g.zone[i] !== z) continue;
        if (!this.maps.power[i] && z !== ZoneType.F) continue; // 電力がないと建たない（農業はなくてもよい）
        const den = g.zden[i];
        // CIQ庁舎の範囲の中の工業ゾーンは、倉庫業だけ（需要が少なくても建つ）
        const ciq = z === ZoneType.I && this.hasCiq && this.logiField().ciq[i] === 1;
        const kinds = ciq ? (['IL'] as GrowKind[]) : kindsAll.filter((k) => GROW[k].dens.includes(den));
        // 種類を選ぶ
        let total = 0;
        const scores: number[] = [];
        for (const k of kinds) {
          const dem = ciq ? Math.max(CIQ_DEMAND, this.ilDemandAt(i)) : k === 'IL' ? this.ilDemandAt(i) : this.demand[k];
          let s = Math.max(0, dem) * Math.max(0, this.desirability(k, i));
          // 古い工場の建て替えでは、ハイテク産業になりやすい（産業の高度化）
          if (replace && k === 'IH') s *= 3;
          scores.push(s);
          total += s;
        }
        if (total <= 0) continue;
        let r = this.rng.next() * total;
        let kind = kinds[0];
        for (let k = 0; k < kinds.length; k++) {
          r -= scores[k];
          if (r <= 0) { kind = kinds[k]; break; }
        }
        const des = this.desirability(kind, i);
        if (des < 0.15 || this.rng.next() > des + 0.2) continue;
        if (replace && this.rng.next() > 0.5) continue;
        this.trySpawn(kind, i, pop, replace);
      }
    }
    if (this.hasCiq) this.ciqStep(pop);
  }

  // CIQ庁舎のまわり：工業ゾーンの空き地に倉庫業を建て（需要に関係なく）、古い工場から順に倉庫業へ建て替える
  private ciqStep(pop: number) {
    const g = this.g;
    const list = this.ciqCands;
    for (let a = 0; a < CIQ_TRIES && list.length; a++) {
      const i = list[this.rng.int(list.length)];
      if (g.bldg[i] || g.zone[i] !== ZoneType.I || !this.maps.power[i]) continue;
      this.trySpawn('IL', i, pop);
    }
    const old = this.ciqOld;
    if (!old.length || this.rng.next() > old.length * CIQ_REDEV_P) return;
    const b = this.buildings.get(old[this.rng.int(Math.min(CIQ_REDEV_PICK, old.length))]);
    if (!b || b.state !== BState.Normal || b.stateDays < CIQ_REDEV_AGE) return;
    const i = g.idx(b.x, b.y);
    if (g.zone[i] !== ZoneType.I || !this.maps.power[i]) return;
    // 同じ敷地のまま倉庫業にする（働く人が減っても建て替える）
    const watered = this.maps.water[i] > 0;
    this.spawnLot('IL', b.x, b.y, b.w, b.h, watered ? g.zden[i] : 0, watered, pop, b.id, b, false, true);
  }

  // 高層ビル街の「中心らしさ」（0..1）。高密度の住宅・商業ゾーンが集まっているほど高く、
  // 近くの高密度地区の中でいちばん集まっている地点が 1 になる（地区ごとに山ができる）
  private core: Float32Array | null = null;
  private officeNear: Float32Array | null = null;
  private coreDay = -1e9;
  coreMap(force = false): Float32Array {
    if (this.core && !force && this.day - this.coreDay < 30) return this.core;
    const g = this.g, n = g.n, N = n * n;
    let a = new Float32Array(N);
    for (let i = 0; i < N; i++) if (g.zden[i] === 2 && (g.zone[i] === ZoneType.R || g.zone[i] === ZoneType.C)) a[i] = 1;
    // ぼかし（横・縦の平均を2回）で、集まり具合にする
    const blur = (src: Float32Array, r: number) => {
      const tmp = new Float32Array(N), out = new Float32Array(N);
      for (let y = 0; y < n; y++) {
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += x >= 0 && x < n ? src[y * n + x] : 0;
        for (let x = 0; x < n; x++) {
          tmp[y * n + x] = acc / (2 * r + 1);
          const xo = x - r, xi = x + r + 1;
          if (xo >= 0) acc -= src[y * n + xo];
          if (xi < n) acc += src[y * n + xi];
        }
      }
      for (let x = 0; x < n; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += y >= 0 && y < n ? tmp[y * n + x] : 0;
        for (let y = 0; y < n; y++) {
          out[y * n + x] = acc / (2 * r + 1);
          const yo = y - r, yi = y + r + 1;
          if (yo >= 0) acc -= tmp[yo * n + x];
          if (yi < n) acc += tmp[yi * n + x];
        }
      }
      return out;
    };
    a = blur(blur(a, 8), 8);
    // 近く（半径 24 マス）でいちばん高い値
    const R = 24;
    const mx = (src: Float32Array) => {
      const tmp = new Float32Array(N), out = new Float32Array(N);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        let m = 0;
        for (let k = Math.max(0, x - R); k <= Math.min(n - 1, x + R); k += 2) m = Math.max(m, src[y * n + k]);
        tmp[y * n + x] = m;
      }
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
        let m = 0;
        for (let k = Math.max(0, y - R); k <= Math.min(n - 1, y + R); k += 2) m = Math.max(m, tmp[k * n + x]);
        out[y * n + x] = m;
      }
      return out;
    };
    const peak = mx(a);
    const core = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (peak[i] <= 0) continue;
      // 小さな高密度地区は、山も低い
      const big = Math.min(1, peak[i] / 0.45);
      core[i] = (a[i] / peak[i]) * (0.4 + 0.6 * big);
    }
    this.core = core;
    // オフィスの集まり具合（0..1）：オフィスはオフィスの近くに集まる
    const o = new Float32Array(N);
    for (const b of this.buildings.values()) {
      if (b.type !== 'CO2' && b.type !== 'CO3') continue;
      for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) o[yy * n + xx] = 1;
    }
    const ob = blur(blur(o, 4), 4);
    for (let i = 0; i < N; i++) ob[i] = Math.min(1, ob[i] * 2.5);
    this.officeNear = ob;
    this.coreDay = this.day;
    return core;
  }

  // 高密度の建物の階数：中心ほど上限に近く、外側ほど低い（ばらつきは少し）
  private floorsFor(range: [number, number], pop: number, cx: number, cy: number, rnd: number) {
    const [fmin, fmax] = range;
    const top = Math.max(fmin, Math.min(fmax, maxFloorsFor(pop)));
    const c = this.coreMap()[cy * this.g.n + cx];
    const t = Math.min(1, Math.pow(c, 2.8) * 0.9 + rnd * 0.12);
    return Math.max(fmin, Math.round(fmin + (top - fmin) * t));
  }

  // 読み込んだとき、高密度の建物の高さを高層ビル街の形に合わせて建て替える
  private reshapeSkyline() {
    const pop = this.stats?.population ?? 0;
    this.coreMap(true);
    for (const b of this.buildings.values()) {
      if (b.civic || b.den < 2 || !b.floors) continue;
      const def = GROW[b.type as GrowKind];
      if (!def || def.zone === ZoneType.I) continue;
      const rnd = ((b.seed >>> 3) % 1000) / 1000;
      const nf = this.floorsFor(def.floors[b.den], Math.max(pop, this.popForFloors(b.floors)), b.x + (b.w >> 1), b.y + (b.h >> 1), rnd);
      if (nf === b.floors) continue;
      b.cap = Math.max(1, Math.round((b.cap / b.floors) * nf));
      b.occ = Math.min(b.occ, b.cap);
      b.floors = nf;
    }
  }

  // その階数が建てられる人口（今の建物を、読み込んだだけで低くしすぎないように）
  private popForFloors(floors: number) {
    let p = 0;
    while (p < 1e7 && maxFloorsFor(p) < floors) p = Math.max(1000, p * 1.5);
    return p;
  }

  // 農地の区画（8×8）の中の、農地ゾーンのマス
  farmCells(x: number, y: number): number[] {
    const g = this.g, n = g.n, out: number[] = [];
    const tx = Math.floor(x / FARM_TILE) * FARM_TILE, ty = Math.floor(y / FARM_TILE) * FARM_TILE;
    for (let yy = ty; yy < Math.min(n, ty + FARM_TILE); yy++)
      for (let xx = tx; xx < Math.min(n, tx + FARM_TILE); xx++) if (g.zone[yy * n + xx] === ZoneType.F) out.push(yy * n + xx);
    return out;
  }
  private farmInTile(x: number, y: number): boolean {
    for (const c of this.farmCells(x, y)) {
      const id = this.g.bldg[c];
      if (id && this.buildings.get(id)?.type === 'IA') return true;
    }
    return false;
  }

  // 敷地を決めて建物を建てる。replace は建て替える建物のID。
  private trySpawn(kind: GrowKind, i: number, pop: number, replace = 0): boolean {
    const g = this.g, n = g.n;
    const def = GROW[kind];
    const x0 = i % n, y0 = (i / n) | 0;
    const watered = this.maps.water[i] > 0;
    // 水がないと、低密度の小さな建物しか建たない
    let den = g.zden[i];
    if (!watered) den = 0;
    if (!def.dens.includes(den)) return false;
    let sizes = def.sizes[den] || [];
    if (!watered && def.zone !== ZoneType.F) sizes = sizes.filter(([w, h]) => w * h <= 2); // 農家は水道がなくてもよい
    if (!sizes.length) return false;
    const [sw, sh] = sizes[this.rng.int(sizes.length)];
    const old = replace ? this.buildings.get(replace) : undefined;
    // 農家は 8×8 マスの区画ごとに1軒だけ
    if (def.zone === ZoneType.F && !old && this.farmInTile(x0, y0)) return false;
    // 倉庫業は、港・貨物駅のすぐ近くでは大きな敷地（6×4 まで）になりやすい。入らなければ、ふつうの大きさでもう一度ためす
    if (kind === 'IL' && watered && this.logiField().full[i] && this.rng.next() < 0.6) {
      const [bw, bh] = IL_BIG_SIZES[this.rng.int(IL_BIG_SIZES.length)];
      if (this.spawnLot(kind, x0, y0, bw, bh, den, watered, pop, replace, old, true)) return true;
    }
    return this.spawnLot(kind, x0, y0, sw, sh, den, watered, pop, replace, old);
  }

  // (x0, y0) を含む sw×sh の敷地を探して建てる。big = 倉庫業の大きな敷地
  // force = CIQ庁舎のまわりの、工場から倉庫業への建て替え（働く人が減ってもよい）
  private spawnLot(kind: GrowKind, x0: number, y0: number, sw: number, sh: number, den: number, watered: boolean, pop: number, replace: number, old: Building | undefined, big = false, force = false): boolean {
    const g = this.g, n = g.n;
    const def = GROW[kind];
    // この位置を含む敷地を探す
    const tries: [number, number][] = [];
    for (let oy = 0; oy < sh; oy++) for (let ox = 0; ox < sw; ox++) tries.push([x0 - ox, y0 - oy]);
    // 大きな敷地は、敷地の中心が港・貨物駅のいちばん強い範囲の中のときだけ（描画の近さと同じく中心ではかる）
    const ports = big ? [...this.buildings.values()].filter((b) => b.civic && LOGI_REACH[b.type as CivicId]) : [];
    for (const [x, y] of tries) {
      if (x < 0 || y < 0 || x + sw > n || y + sh > n) continue;
      if (big && !ports.some((p) => logiReach(p, x + sw / 2, y + sh / 2).full)) continue;
      let ok = true;
      let lo = Infinity, hi = -Infinity;
      for (let yy = y; yy < y + sh && ok; yy++)
        for (let xx = x; xx < x + sw; xx++) {
          const j = yy * n + xx;
          const occupied = g.bldg[j] && g.bldg[j] !== replace;
          if (g.zone[j] !== def.zone || occupied || g.road[j] || hasSurfaceLine(g, j) || g.isWater(xx, yy)) { ok = false; break; }
          lo = Math.min(lo, g.cellMinH(xx, yy));
          hi = Math.max(hi, g.cellMaxH(xx, yy));
        }
      if (!ok || hi - lo > 8) continue;
      const lot = { x, y, w: sw, h: sh };
      if (!this.accessCells(lot).length) continue;
      const area = sw * sh;
      let cap: number, floors = 0;
      const jitter = 0.85 + this.rng.next() * 0.3;
      if (def.zone === ZoneType.F) {
        // 農家の働く人は、区画の中の農地のマス数で決まる（畑はすべて農家のもの）
        cap = def.capPerCell * Math.max(4, this.farmCells(x, y).length) * jitter;
      } else if (den === 0) {
        cap = def.capPerCell * area * jitter * (watered ? 1 : 0.7);
      } else if (def.zone === ZoneType.I) {
        cap = def.capPerCell * area * IND_DENSITY_MUL[den] * jitter;
      } else {
        // 階数は人口の上限の範囲で、高層ビル街の中心に近いほど高い
        floors = this.floorsFor(def.floors[den], pop, x + (sw >> 1), y + (sh >> 1), this.rng.next());
        cap = def.floorCap * area * floors * jitter;
      }
      cap = Math.max(1, Math.round(cap));
      // 建て替えは、今より大きくなる場合だけ。ただし、より豊かな産業への入れ替え（工場 → ハイテク産業など）は、
      // 働く人が少し減っても認める（ハイテク産業は1マスあたりの人数が少ないので、これがないと工場と入れ替われない）
      const upgradeKind = !!old && GROW[kind].wealth > GROW[old.type as GrowKind].wealth * 1.2 && cap >= old.cap * 0.5;
      if (old && cap <= old.cap * 1.15 && !upgradeKind && !force) return false;
      if (old) this.removeBuilding(old.id);
      const b: Building = {
        id: this.nextId++, civic: false, type: kind, x, y, w: sw, h: sh, face: this.findFace(x, y, sw, sh),
        seed: this.rng.int(1e9), den, cap, occ: 0, state: BState.Building, stateDays: 0,
        powered: true, watered, floors, commute: 0, employed: 1, badMonths: 0,
      };
      this.placeBuilding(b);
      // 内陸の倉庫業は需要が小さいので、建てたらすぐに内陸の需要を下げる（次の月の計算までに建ちすぎないように）
      if (kind === 'IL') {
        const added = cap - (old?.type === 'IL' ? old.cap : 0);
        this.ilInland = Math.max(-1, this.ilInland - ((1 - ilPortMix(this.logiField().near[g.idx(x + (sw >> 1), y + (sh >> 1))])) * added) / 60);
      }
      this.gridVersion++;
      this.candidatesDirty = true;
      return true;
    }
    return false;
  }

  // ---------------- 電力 ----------------
  updatePower() {
    const g = this.g, n = g.n;
    const power = this.maps.power;
    power.fill(0);
    const comp = new Int32Array(n * n).fill(-1);
    // 送電線、建物、ゾーン、道路が電気を通す（道路をまたいで隣の区画に届く）
    const conductive = (i: number) => g.pline[i] !== 0 || g.bldg[i] !== 0 || g.zone[i] !== 0 || g.road[i] !== 0;
    let supplyTotal = 0, demandTotal = 0;
    let cid = 0;
    const queue: number[] = [];
    for (const b of this.buildings.values()) b.powered = false;
    for (const plant of this.buildings.values()) {
      if (!plant.civic) continue;
      const def = CIVIC[plant.type as CivicId];
      if (!def.power) continue;
      const start = g.idx(plant.x, plant.y);
      if (comp[start] >= 0) continue;
      // この発電所からつながる範囲を探す
      const cells: number[] = [];
      comp[start] = cid;
      queue.length = 0;
      queue.push(start);
      while (queue.length) {
        const i = queue.pop()!;
        cells.push(i);
        const x = i % n, y = (i / n) | 0;
        for (let d = 0; d < 8; d += 2) {
          const nx = x + DX[d], ny = y + DY[d];
          if (!g.inb(nx, ny)) continue;
          const j = ny * n + nx;
          if (comp[j] >= 0 || !conductive(j)) continue;
          comp[j] = cid;
          queue.push(j);
        }
      }
      // 範囲内の発電量と消費量
      const ids = new Set<number>();
      for (const i of cells) if (g.bldg[i]) ids.add(g.bldg[i]);
      let supply = 0;
      const consumers: Building[] = [];
      for (const id of ids) {
        const b = this.buildings.get(id)!;
        if (b.civic && CIVIC[b.type as CivicId].power) supply += plantPower(b.type as CivicId, g.cellH(b.x, b.y));
        else consumers.push(b);
      }
      let need = 0;
      for (const b of consumers) need += this.powerNeed(b);
      supplyTotal += supply;
      demandTotal += need;
      // 足りない場合は一部だけ送電
      let remain = supply;
      const ratio = need > 0 ? Math.min(1, supply / need) : 1;
      for (const b of consumers) {
        const p = this.powerNeed(b);
        if (ratio >= 1 || remain >= p) {
          b.powered = true;
          remain -= p;
        }
      }
      for (const id of ids) {
        const b = this.buildings.get(id)!;
        if (b.civic && CIVIC[b.type as CivicId].power) b.powered = true;
      }
      for (const i of cells) {
        const id = g.bldg[i];
        if (id) power[i] = this.buildings.get(id)!.powered ? 2 : 1;
        else power[i] = remain > 0 ? 2 : 1;
      }
      cid++;
    }
    // 電力の値: 0=なし, 1=不足, 2=供給あり
    for (let i = 0; i < n * n; i++) power[i] = power[i] === 2 ? 1 : 0;
    this.powerSupply = supplyTotal;
    this.powerDemand = demandTotal;
    if (demandTotal > supplyTotal && supplyTotal > 0) {
      if (!this.warnedPower) this.pushNews('電力が不足しています。発電所を増やしましょう。');
      this.warnedPower = true;
    } else this.warnedPower = false;
  }

  private powerNeed(b: Building) {
    if (b.civic) return b.type === 'pump' ? 25 : b.type === 'tower' ? 8 : 0;
    const def = GROW[b.type as GrowKind];
    return Math.max(1, (b.state === BState.Building ? b.cap : b.occ || b.cap) * def.powerPer * this.fx.power);
  }

  // ---------------- 水道 ----------------
  updateWater() {
    const g = this.g, n = g.n;
    const water = this.maps.water;
    water.fill(0);
    const visited = new Uint8Array(n * n);
    let supplyTotal = 0, demandTotal = 0;
    for (const s of this.buildings.values()) {
      if (!s.civic) continue;
      const def = CIVIC[s.type as CivicId];
      if (!def.water) continue;
      const starts = this.accessCells(s).filter((i) => !visited[i]);
      if (!starts.length) continue;
      // 道路に沿って水が届く範囲
      const roadCells: number[] = [];
      const q = starts.slice();
      for (const i of starts) visited[i] = 1;
      while (q.length) {
        const i = q.pop()!;
        roadCells.push(i);
        const x = i % n, y = (i / n) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (!g.inb(nx, ny)) continue;
          const j = ny * n + nx;
          if (visited[j] || !g.road[j]) continue;
          visited[j] = 1;
          q.push(j);
        }
      }
      // この範囲の給水施設をまとめる
      const sources = new Set<number>();
      const consumers = new Set<number>();
      for (const i of roadCells) {
        const x = i % n, y = (i / n) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (!g.inb(nx, ny)) continue;
          const id = g.bldg[ny * n + nx];
          if (!id) continue;
          const b = this.buildings.get(id)!;
          if (b.civic && CIVIC[b.type as CivicId].water) sources.add(id);
          else consumers.add(id);
        }
      }
      let supply = 0;
      for (const id of sources) {
        const b = this.buildings.get(id)!;
        if (b.powered) supply += CIVIC[b.type as CivicId].water!;
      }
      let need = 0;
      const cons = [...consumers].map((id) => this.buildings.get(id)!);
      for (const b of cons) need += this.waterNeed(b);
      supplyTotal += supply;
      demandTotal += need;
      let remain = supply;
      for (const b of cons) {
        const w = this.waterNeed(b);
        b.watered = remain >= w;
        if (b.watered) remain -= w;
      }
      if (supply > 0) {
        for (const i of roadCells) water[i] = 1;
        for (const b of cons) {
          if (!b.watered) continue;
          for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) water[g.idx(x, y)] = 1;
        }
        // 空き地のゾーンも道路の隣なら水が届く
        for (const i of roadCells) {
          const x = i % n, y = (i / n) | 0;
          for (let d = 0; d < 8; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            if (g.inb(nx, ny) && g.zone[ny * n + nx] && !g.bldg[ny * n + nx]) water[ny * n + nx] = remain > 0 ? 1 : 0;
          }
        }
      }
    }
    for (const b of this.buildings.values()) {
      if (b.civic) continue;
      if (!water[this.g.idx(b.x, b.y)]) b.watered = false;
    }
    this.waterSupply = supplyTotal;
    this.waterDemand = demandTotal;
    if (demandTotal > supplyTotal && supplyTotal > 0) {
      if (!this.warnedWater) this.pushNews('水が不足しています。揚水ポンプを増やしましょう。');
      this.warnedWater = true;
    } else this.warnedWater = false;
  }

  private waterNeed(b: Building) {
    if (b.civic) return 0;
    const def = GROW[b.type as GrowKind];
    return Math.max(1, (b.occ || b.cap) * def.waterPer * this.fx.water);
  }

  // ---------------- 汚染と地価 ----------------
  private updatePollutionAndLandValue() {
    const g = this.g, n = g.n, N = n * n;
    const src = new Float32Array(N);
    const park = new Float32Array(N);
    const gloom = new Float32Array(N);
    const res = new Float32Array(N);
    for (const b of this.buildings.values()) {
      if (b.state === BState.Building) continue;
      const area = b.w * b.h;
      let p = 0, pk = 0;
      if (b.civic) {
        const def = CIVIC[b.type as CivicId];
        p = (def.pollution || 0) / area;
        pk = def.park || 0;
        if (def.gloom) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) gloom[g.idx(x, y)] = def.gloom;
      } else {
        const def = GROW[b.type as GrowKind];
        p = (b.state === BState.Abandoned ? def.pollution * 0.2 : def.pollution * (b.occ / Math.max(1, b.cap))) * (def.zone === ZoneType.I ? this.fx.indPollution : 1);
        if (def.zone === ZoneType.R) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) res[g.idx(x, y)] = b.occ / area;
      }
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        src[g.idx(x, y)] += p;
        if (pk) park[g.idx(x, y)] = Math.max(park[g.idx(x, y)], pk);
      }
    }
    // 親水護岸・遊歩道は公園と同じように周りの地価を上げる
    for (let i = 0; i < N; i++) if (g.quay[i] === 2) park[i] = Math.max(park[i], 0.2);
    for (let i = 0; i < N; i++) if (g.anyRoad(i)) src[i] += Math.min(0.6, (this.maps.traffic[i] + this.maps.traffic[i + N]) / 3000) * this.fx.roadPollution;
    const pol = blur(src, n, 3, 3);
    for (let i = 0; i < N; i++) this.maps.pollution[i] = Math.min(255, Math.round(pol[i] * 140));

    this.resDensity = blur(res, n, 4, 2);
    for (let i = 0; i < N; i++) this.resDensity[i] *= 9;

    // 公園の効果（半径6マス）
    const parkFx = blur(park, n, 5, 2);
    // 霊園・斎場（半径 4 マスくらい、少しだけ地価が下がる）
    const gloomFx = blur(gloom, n, 3, 2);
    // 水辺
    const waterNear = new Float32Array(N);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (g.isWater(x, y)) waterNear[y * n + x] = 1;
    const wn = blur(waterNear, n, 3, 2);
    const lv = new Float32Array(N);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const h = g.cellH(x, y);
        let v = 0.3 + Math.min(0.12, Math.max(0, h / 300));
        v += Math.min(0.28, wn[i] * 1.2) * (g.isWater(x, y) ? 0 : 1);
        v += Math.min(0.35, parkFx[i] * 6);
        v -= Math.min(0.12, gloomFx[i] * 4);
        v += g.tree[i] ? 0.04 : 0;
        v -= Math.min(0.6, pol[i] * 0.9);
        v -= (this.maps.crime[i] / 255) * 0.25 + this.svc.garbageLevel * 0.15;
        v += (this.maps.health[i] / 255) * 0.05 + (this.maps.edu[i] / 255) * 0.06;
        const cm = this.commuteAtCell[i];
        if (cm > 25) v -= Math.min(0.25, (cm - 25) / 120);
        lv[i] = Math.max(0, Math.min(1, v));
      }
    const lvb = blur(lv, n, 1, 1);
    for (let i = 0; i < N; i++) this.maps.landValue[i] = Math.round(Math.max(0, Math.min(1, lvb[i])) * 255);
  }

  // ---------------- 交通（通勤・買い物・貨物） ----------------
  private updateTraffic() {
    const g = this.g, n = g.n, N = n * n;
    const commuters = new Map<number, Origin>();
    const shoppers = new Map<number, Origin>();
    const trucks = new Map<number, Origin>();
    const jobsAt = new Map<number, Destination[]>();
    const shopsAt = new Map<number, Destination[]>();
    // 車を持たない人の割合（所得が低いほど多い）。車を持たない人は、公共交通か徒歩しか使えない
    const NO_CAR: Record<string, number> = { R1: 0.4, R2: 0.15, R3: 0.05 };
    const NO_CAR_PENALTY = 999;
    const addOrigin = (m: Map<number, Origin>, cell: number, id: number, trips: number, carPenalty = 0) => {
      const key = cell * 4 + Math.round(carPenalty);
      let o = m.get(key);
      if (!o) m.set(key, (o = { cell, trips: 0, buildings: [], carPenalty }));
      o.trips += trips;
      o.buildings.push({ id, trips });
    };
    const addDest = (m: Map<number, Destination[]>, acc: number[], d: Destination) => {
      for (const c of acc) {
        let l = m.get(c);
        if (!l) m.set(c, (l = []));
        l.push(d);
      }
    };
    // 住宅の出発地は、3×3 マスの区画ごと（道路がつながっている場合だけ）にまとめて計算する（計算を軽くするため）
    const comp = groundRoadComponents(g);
    const rep = new Map<number, number>();
    const BLK = 3, bw = Math.ceil(n / BLK);
    const repCell = (c: number) => {
      const key = comp[c] * bw * bw + (((c / n) | 0) / BLK | 0) * bw + ((c % n) / BLK | 0);
      let r = rep.get(key);
      if (r === undefined) rep.set(key, (r = c));
      return r;
    };
    for (const b of this.buildings.values()) {
      if (b.civic || b.state !== BState.Normal) continue;
      const def = GROW[b.type as GrowKind];
      const acc = this.accessCells(b);
      if (!acc.length) continue;
      let cell = acc[b.seed % acc.length];
      if (def.zone === ZoneType.R) {
        cell = repCell(cell);
        const f = NO_CAR[b.type] ?? 0;
        const workers = workersOf(b), shop = b.occ * 0.2;
        addOrigin(commuters, cell, b.id, Math.round(workers * (1 - f)), 0);
        addOrigin(commuters, cell, b.id, Math.round(workers * f), NO_CAR_PENALTY);
        addOrigin(shoppers, cell, b.id, Math.round(shop * (1 - f)), 0);
        addOrigin(shoppers, cell, b.id, Math.round(shop * f), NO_CAR_PENALTY);
      } else {
        addDest(jobsAt, acc, { id: b.id, free: b.cap });
        if (b.type === 'CS1' || b.type === 'CS2' || b.type === 'CS3') addDest(shopsAt, acc, { id: b.id, free: b.cap * 6 });
        if (def.zone === ZoneType.I || def.zone === ZoneType.F) addOrigin(trucks, cell, b.id, Math.max(1, Math.round(b.occ * (b.type === 'IA' ? 0.05 : 0.12))));
      }
    }
    const pop = this.population();
    const hwy = this.highwayConnected ? 1.5 : 1;
    const external = this.neighborConnected ? Math.round((200 + pop * 0.25) * hwy) : 0;
    const traffic = this.maps.traffic, cong = this.maps.congestion;
    const junctions = buildJunctions(g, traffic);
    const rnd = () => this.rng.next();
    // 駅とバス停
    const stations: { kind: 'bus' | LineKind; roadCells: number[]; lineCells: number[] }[] = [];
    for (const b of this.buildings.values()) {
      if (!b.civic) continue;
      const def = CIVIC[b.type as CivicId];
      if (!def.transit) continue;
      const roadCells = this.accessCells(b);
      if (!roadCells.length) continue;
      const lineCells: number[] = [];
      if (def.transit !== 'bus') {
        const mask = g[def.transit];
        for (let yy = b.y - 1; yy <= b.y + b.h; yy++)
          for (let xx = b.x - 1; xx <= b.x + b.w; xx++) if (g.inb(xx, yy) && mask[g.idx(xx, yy)]) lineCells.push(g.idx(xx, yy));
        if (!lineCells.length) continue;
      }
      stations.push({ kind: def.transit, roadCells, lineCells });
    }
    // 線路の上だけの高架駅
    {
      const seen = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        if (!g.estn[i] || seen[i]) continue;
        const cells = estopGroup(g, i);
        for (const c of cells) seen[c] = 1;
        const roadCells = estopRoads(g, cells);
        if (roadCells.length) stations.push({ kind: 'erail', roadCells, lineCells: cells.filter((c) => g.erail[c]) });
      }
    }
    // 道路に重ねたバス停
    const roadStops: number[] = [];
    for (let i = 0; i < N; i++) if (g.bstop[i] && g.road[i]) roadStops.push(i);
    if (roadStops.length) stations.push({ kind: 'bus', roadCells: roadStops, lineCells: [] });
    const tm = buildTransitModel(g, stations);
    // ---- フェリー・港・貨物駅 ----
    // 水域の番号づけは、地形が変わったときだけやり直す
    if (this.waterCache?.v !== this.heightVersion) this.waterCache = { v: this.heightVersion, w: labelWater(g) };
    const water = this.waterCache.w;
    const railEdge = railReachEdge(g);
    const freightAt = new Map<number, Destination[]>();
    const terminals: { b: Building; kind: 'passenger' | 'car'; body: number; road: number }[] = [];
    let airportBoost = 0, seaportBoost = 0, freightBoost = 0;
    for (const b of this.buildings.values()) {
      if (!b.civic) continue;
      const def = CIVIC[b.type as CivicId];
      if (!def.ferry && !def.seaport && !def.freightRail && !def.airport) continue;
      const acc = this.accessCells(b);
      // 隣の水域
      let body = -1;
      for (let yy = b.y - 1; yy <= b.y + b.h && body < 0; yy++)
        for (let xx = b.x - 1; xx <= b.x + b.w; xx++) if (g.inb(xx, yy) && water.label[g.idx(xx, yy)] >= 0) { body = water.label[g.idx(xx, yy)]; break; }
      if (!acc.length) { b.note = '道路に接していません'; continue; }
      if (def.ferry) {
        terminals.push({ b, kind: def.ferry, body, road: acc[0] });
      } else if (def.seaport) {
        if (body >= 0 && water.edge.has(body)) {
          for (const c of acc) (freightAt.get(c) ?? freightAt.set(c, []).get(c)!).push({ id: b.id, free: 1e9 });
          seaportBoost += 0.25 * (def.portScale ?? 1);
          b.note = '外洋につながっている';
        } else b.note = '<span class="neg">水域がマップの端までつながっていません</span>';
      } else if (def.freightRail) {
        let ok = false;
        for (let yy = b.y - 1; yy <= b.y + b.h; yy++) for (let xx = b.x - 1; xx <= b.x + b.w; xx++) if (g.inb(xx, yy) && railEdge[g.idx(xx, yy)]) ok = true;
        if (ok) {
          for (const c of acc) (freightAt.get(c) ?? freightAt.set(c, []).get(c)!).push({ id: b.id, free: 1e9 });
          freightBoost += 0.15; // 倉庫業の需要が上がる
          b.note = '鉄道で隣の都市へ荷物を運んでいる';
        } else b.note = '<span class="neg">線路がマップの端までつながっていません</span>';
      } else if (def.airport) {
        airportBoost += def.airport === 2 ? 0.35 : 0.15;
        b.note = b.powered ? '運航中' : '<span class="neg">電力がないので運航していません</span>';
        if (!b.powered) airportBoost -= def.airport === 2 ? 0.35 : 0.15;
      }
    }
    // 同じ水域にある、同じ種類の乗り場どうしを航路で結ぶ
    for (const A of terminals) {
      let routes = 0;
      for (const B of terminals) {
        if (A === B || A.kind !== B.kind || A.body < 0 || A.body !== B.body) continue;
        const dist = Math.hypot(A.b.x - B.b.x, A.b.y - B.b.y) * CELL;
        if (A.kind === 'passenger') {
          const m = dist / 420 + 8; // 25km/h、待ち8分
          const from = LAYER.walk * N + A.road, to = LAYER.walk * N + B.road;
          (tm.walkLinks.get(from) ?? tm.walkLinks.set(from, []).get(from)!).push([to, m]);
        } else {
          const m = dist / 330 + 10; // 20km/h、待ち10分
          (tm.carLinks.get(A.road) ?? tm.carLinks.set(A.road, []).get(A.road)!).push([B.road, m]);
        }
        routes++;
      }
      const toNeighbor = A.kind === 'car' && A.body >= 0 && water.edge.has(A.body);
      if (toNeighbor) tm.carToExt.set(A.road, 25);
      A.b.note = A.body < 0 ? '<span class="neg">水辺に接していません</span>' : `航路 ${routes} 本${toNeighbor ? '・隣の都市への航路あり' : ''}`;
    }
    this.airportBoost = airportBoost;
    this.seaportBoost = seaportBoost;
    this.freightBoost = freightBoost;
    const graph = buildRoadGraph(g, cong, junctions);
    const rc = assignTrips(g, [...commuters.values()], jobsAt, cong, junctions, rnd, { externalCap: external, maxMinutes: 80, weight: 1 }, tm, graph);
    const rs = assignTrips(g, [...shoppers.values()], shopsAt, cong, junctions, rnd, { externalCap: this.neighborConnected ? pop * 0.03 : 0, maxMinutes: 30, weight: 0.5 }, tm, graph);
    // 公共交通の乗客数（バス、鉄道、高架鉄道、モノレール、地下鉄の順に N マスずつ）
    const riders = this.maps.riders;
    for (let l = 0; l < 5; l++) {
      const base = (LAYER.bus + l) * N;
      for (let i = 0; i < N; i++) riders[l * N + i] = riders[l * N + i] * 0.4 + (rc.volume[base + i] + rs.volume[base + i] * 2) * 0.6;
    }
    this.transitRiders = Math.round(rc.modes.transit + rs.modes.transit);
    const tot = Math.max(1, rc.modes.car + rc.modes.transit + rc.modes.walk);
    this.modeShare = { car: rc.modes.car / tot, transit: rc.modes.transit / tot, walk: rc.modes.walk / tot };
    // 貨物：隣の都市（道路・高速道路）、港、貨物駅のうち近いところへ
    const rf = assignTrips(g, [...trucks.values()], freightAt, cong, junctions, rnd, { externalCap: 1e9, externalOnly: freightAt.size === 0, carOnly: true, maxMinutes: 90, weight: 2.5 }, undefined, graph);
    // 交通量と混雑度（前の月と平均してなめらかにする）
    for (let v = 0; v < 2 * N; v++) {
      const t = g.nodeType(v);
      if (!t) { traffic[v] = 0; cong[v] = 1; this.maps.freight[v] = 0; continue; }
      const vol = (rc.volume[v] + rs.volume[v] + rf.volume[v]) * this.fx.traffic;
      traffic[v] = traffic[v] * 0.4 + vol * 0.6;
      this.maps.freight[v] = this.maps.freight[v] * 0.4 + rf.volume[v] * 0.6;
      const cap = ROADS[t].capacity;
      cong[v] = cong[v] * 0.5 + congestionFactor(traffic[v], cap) * 0.5;
    }
    let employed = 0;
    for (const b of this.buildings.values()) {
      if (b.civic || b.state !== BState.Normal) continue;
      const def = GROW[b.type as GrowKind];
      if (def.zone === ZoneType.R) {
        const workers = Math.round(workersOf(b));
        const e = rc.served.get(b.id);
        if (e === undefined) {
          b.employed = 0;
          b.commute = 0;
        } else {
          b.employed = workers > 0 ? e / workers : 1;
          b.commute = rc.time.get(b.id) || 0;
          employed += e;
        }
      } else {
        const f = rc.filled.get(b.id) || 0;
        // 隣の都市からの通勤者もいる
        const outside = this.neighborConnected ? Math.min(b.cap - f, b.cap * 0.2) : 0;
        b.occ = Math.round(b.occ * 0.4 + (f + outside) * 0.6);
        // 買い物客と貨物の輸送
        if (b.type === 'CS1' || b.type === 'CS2' || b.type === 'CS3') {
          b.customers = Math.min(1, (rs.filled.get(b.id) || 0) / Math.max(1, b.cap * 6) + (this.neighborConnected ? 0.15 : 0));
        }
        if (def.zone === ZoneType.I || def.zone === ZoneType.F) {
          const shipped = rf.served.get(b.id);
          b.freight = shipped === undefined ? 1 : Math.min(1, shipped / Math.max(1, Math.round(b.occ * 0.12)));
          b.freightTime = rf.time.get(b.id) || 0;
        }
      }
    }
    this.employedTotal = employed;
    this.avgCommute = rc.avgTime;
    this.tripStats = { shopping: Math.round(rs.avgTime * 10) / 10, freight: Math.round(rf.avgTime * 10) / 10, trucks: Math.round([...trucks.values()].reduce((a, o) => a + o.trips, 0)) };
    // マスごとの通勤時間（近くの空き地の魅力に使う）
    const cm = new Float32Array(N);
    const cnt = new Float32Array(N);
    for (const b of this.buildings.values()) {
      if (b.civic || GROW[b.type as GrowKind].zone !== ZoneType.R || !b.commute) continue;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        cm[g.idx(x, y)] = b.commute;
        cnt[g.idx(x, y)] = 1;
      }
    }
    const bc = blur(cm, n, 4, 2), bn = blur(cnt, n, 4, 2);
    for (let i = 0; i < N; i++) this.commuteAtCell[i] = bn[i] > 0.01 ? bc[i] / bn[i] : 0;
    // 自動の交差点の制御方式（表示用）
    this.junctionCtl = junctions.ctl;
    this.maps.jctl.set(junctions.ctl);
  }
  junctionCtl: Uint8Array = new Uint8Array(0);
  transitRiders = 0; // 1日の公共交通の乗客数
  services: ServiceState = defaultServiceState();
  ordinances = new Set<OrdinanceId>();
  loans: Loan[] = [];
  private nextLoanId = 1;
  rating = 55;
  private ratingParts: [string, number][] = [];
  private advice: Advice[] = [];
  private fx: OrdinanceEffects = ordinanceEffects(new Set());
  private lastBad = new Set<string>();
  private svc = { lifeExp: 72, crimeAvg: 0, garbageLevel: 0 };
  private svcCover = { police: 0, fire: 0, health: 0 };
  private schoolSeats = 1;
  private airportBoost = 0;
  zoneDemand: [number, number, number] = [0, 0, 0];
  private seaportBoost = 0;
  private freightBoost = 0; // 貨物駅（倉庫業の需要）
  modeShare = { car: 0, transit: 0, walk: 0 };
  static readonly CTL_AUTO = Ctl.Auto;
  tripStats = { shopping: 0, freight: 0, trucks: 0 };

  // ---------------- 需要 ----------------
  private updateDemand() {
    let pop = 0, popR1 = 0, popR2 = 0, popR3 = 0;
    const capK = emptyKinds(0);
    const lf = this.logiField();
    let capILIn = 0; // 内陸（港・貨物駅から遠いところ）の倉庫業の雇用
    let capILCiq = 0; // CIQ庁舎の範囲の中の倉庫業の雇用（街の倉庫業の需要には数えない）
    for (const b of this.buildings.values()) {
      if (b.civic || b.state === BState.Abandoned) continue;
      const k = b.type as GrowKind;
      if (GROW[k].zone === ZoneType.R) {
        pop += b.occ;
        if (k === 'R1') popR1 += b.occ;
        else if (k === 'R2') popR2 += b.occ;
        else popR3 += b.occ;
      } else capK[k] += b.cap;
      if (k === 'IL') {
        const i = this.g.idx(b.x + (b.w >> 1), b.y + (b.h >> 1));
        if (lf.ciq[i]) capILCiq += b.cap;
        else capILIn += b.cap * (1 - ilPortMix(lf.near[i]));
      }
    }
    const jobs = capK.CS1 + capK.CS2 + capK.CS3 + capK.CO2 + capK.CO3 + capK.IA + capK.ID + capK.IM + capK.IL + capK.IH;
    const ext = this.neighborConnected ? 200 + pop * 0.25 : 0;
    const workers = pop * this.services.funeral.ages[1] * WORK_RATE;
    const unemployment = workers > 50 ? Math.max(0, (workers - this.employedTotal) / workers) : 0;
    const rBase = ((jobs + ext + 250) * 2 - pop) / Math.max(400, pop * 0.4);
    const raw = emptyKinds(0);
    raw.R1 = rBase;
    raw.R2 = rBase * 0.95 - 0.05;
    raw.R3 = pop > 600 ? rBase * 0.8 - 0.1 : -0.2;
    const desiredC = pop * 0.14 + 30 + ext * 0.08;
    const totalR = Math.max(1, popR1 + popR2 + popR3);
    const share = [0.5 + (popR1 / totalR) * 0.5, 0.3 + (popR2 / totalR) * 0.7, 0.1 + (popR3 / totalR) * 0.9];
    const cKinds: GrowKind[] = ['CS1', 'CS2', 'CS3'];
    cKinds.forEach((k, idx) => {
      const want = desiredC * share[idx] * 0.75;
      raw[k] = (want - capK[k]) / Math.max(30, want * 0.6);
    });
    const wantCO = { CO2: pop > 800 ? pop * 0.07 + ext * 0.05 : 0, CO3: pop > 3000 ? pop * 0.05 + ext * 0.03 : 0 };
    for (const k of ['CO2', 'CO3'] as const) {
      raw[k] = wantCO[k] > 0 ? (wantCO[k] - capK[k]) / Math.max(60, wantCO[k] * 0.5) : -0.3;
    }
    const eqA = this.services.eq.adult;
    // ハイテク産業：大人の教育水準が 25 を超えると少しずつ来はじめ、高いほど多い（以前は 70 からで、ほとんど建たなかった）
    const wantIH = pop > 1500 && eqA > 25 ? pop * 0.07 * Math.min(1.6, (eqA - 25) / 50) : 0;
    raw.IH = wantIH > 0 ? (wantIH - capK.IH) / Math.max(60, wantIH * 0.5) + unemployment * 0.6 : -0.3;
    // オフィスは教育水準が高いほど来やすい
    raw.CO2 += (eqA - 70) / 200;
    raw.CO3 += (eqA - 90) / 150;
    const want = { IA: 180 + pop * 0.02, ID: 260 + pop * 0.12 + ext * 0.15, IM: pop > 1200 ? pop * 0.09 : 0 };
    for (const k of ['IA', 'ID', 'IM'] as const) {
      raw[k] = want[k] > 0 ? (want[k] - capK[k]) / Math.max(60, want[k] * 0.5) : -0.3;
      raw[k] += unemployment * 1.2;
    }
    // 倉庫業：街の工業と店が大きいほど（保管して配る荷物が多い）、港と貨物駅があるほど多い。
    // 港の数え方：港 1、大型コンテナターミナル 3、貨物駅 0.6（4 で頭打ち）
    const portUnits = Math.min(4, (this.seaportBoost + this.freightBoost) / 0.25);
    const goods = capK.ID + capK.IM + capK.IH + (capK.CS1 + capK.CS2 + capK.CS3) * 0.5;
    const wantILIn = pop > 600 ? goods * IL_WANT_BASE : 0;
    const wantIL = wantILIn + portUnits * (IL_WANT_PORT_FLAT + goods * IL_WANT_PORT);
    raw.IL = wantIL > 0 ? (wantIL - (capK.IL - capILCiq)) / Math.max(60, wantIL * 0.5) + unemployment : -0.3;
    // 内陸の倉庫業は、街の荷物の分だけ（港があっても内陸にはあまり建たない）
    const rawILIn = (wantILIn > 0 ? (wantILIn - capILIn) / Math.max(60, wantILIn * 0.5) + unemployment : -0.3) + this.fx.demand.I;
    // 空港と港（港の効果は、ほとんどが倉庫業に向かう）
    for (const k of ['CS2', 'CS3', 'CO2', 'CO3'] as const) raw[k] += this.airportBoost;
    raw.CS1 += this.airportBoost * 0.5;
    raw.ID += this.seaportBoost * 0.3;
    raw.IM += this.seaportBoost * 0.4;
    raw.IL += (this.seaportBoost + this.freightBoost) * IL_PORT_SHARE;
    // 記念施設
    const has = (t: string) => [...this.buildings.values()].some((b) => b.type === t);
    if (has('stadium') || has('future_stadium')) for (const k of ['CS1', 'CS2', 'CS3'] as const) raw[k] += 0.1;
    if (has('museum')) this.services.eq.adult = Math.min(150, this.services.eq.adult + 0.05);
    // 条例
    for (const k of ['R1', 'R2', 'R3'] as const) raw[k] += this.fx.demand.R + (this.rating - 50) / 250;
    for (const k of ['CS1', 'CS2', 'CS3', 'CO2', 'CO3'] as const) raw[k] += this.fx.demand.C;
    for (const k of ['ID', 'IM', 'IL', 'IH', 'IA'] as const) raw[k] += this.fx.demand.I;
    raw.ID += this.fx.demand.ID;
    raw.R1 -= unemployment * 1.5;
    raw.R2 -= unemployment * 1.5;
    raw.R3 -= unemployment * 1.5;
    const mul = DIFFICULTY[this.difficulty].demand;
    const settle = (prev: number, r: number, k: GrowKind) => {
      let v = r - (this.taxes[k] - DEFAULT_TAX) * 0.08;
      if (v > 0) v *= mul;
      // なめらかに頭打ちにする（すぐに ±1 に張り付かないように）
      v = Math.tanh(v * 1.1);
      return prev * 0.5 + v * 0.5;
    };
    for (const k of GROW_KINDS) this.demand[k] = settle(this.demand[k], raw[k], k);
    this.ilInland = settle(this.ilInland, rawILIn, 'IL');
    // 画面の R・C・I のグラフ：種類ごとの需要を、その種類の街での大きさで重みをつけて平均する。
    // （以前はいちばん大きい種類を出していたので、建たない種類（工業地域が全部高密度のときの農業など）が
    //   いつも上限になり、グラフが動かなかった）
    // 農業（農地ゾーン）の需要も、I のグラフにまとめる（農地ゾーンがあるときだけ）
    let lowI = false;
    for (let i = 0; i < this.g.zden.length; i++) if (this.g.zone[i] === ZoneType.F) { lowI = true; break; }
    const wmean = (ks: GrowKind[], ws: number[]) => {
      let a = 0, w = 0;
      ks.forEach((k, j) => { a += this.demand[k] * ws[j]; w += ws[j]; });
      return w > 0 ? a / w : 0;
    };
    this.zoneDemand = [
      wmean(['R1', 'R2', 'R3'], [0.5, 0.35, pop > 600 ? 0.15 : 0]),
      wmean(['CS1', 'CS2', 'CS3', 'CO2', 'CO3'], [desiredC * share[0], desiredC * share[1], desiredC * share[2], wantCO.CO2, wantCO.CO3]),
      wmean(['IA', 'ID', 'IM', 'IL', 'IH'], [lowI ? want.IA : 0, want.ID, want.IM, wantIL, wantIH]),
    ];
  }

  // ---------------- 建物の状態（入居、空き家） ----------------
  private updateOccupancy() {
    const toRemove: number[] = [];
    for (const b of this.buildings.values()) {
      if (b.civic) continue;
      const def = GROW[b.type as GrowKind];
      if (b.state === BState.Abandoned) {
        if (b.stateDays > 240) toRemove.push(b.id);
        continue;
      }
      if (b.state !== BState.Normal) continue;
      let bad = false;
      if (!b.powered && def.zone !== ZoneType.F) bad = true;
      if (def.zone === ZoneType.R) {
        const dem = this.demand[b.type as GrowKind];
        if (b.employed < 0.5 && dem < 0) bad = true;
        if (b.commute > 60) bad = true;
        const target = b.cap * (b.powered ? 1 : 0.6) * (b.employed < 0.5 && dem < 0 ? 0.85 : 1);
        b.occ = Math.round(b.occ + (target - b.occ) * 0.3);
      } else {
        if (b.occ < b.cap * 0.3 && b.stateDays > 180) bad = true;
        if (b.customers !== undefined && b.customers < 0.2 && b.stateDays > 240) bad = true;
        if (b.freight !== undefined && b.freight < 0.3 && b.stateDays > 180) bad = true;
      }
      b.badMonths = bad ? b.badMonths + 1 : Math.max(0, b.badMonths - 1);
      if (b.badMonths >= 6) {
        b.state = BState.Abandoned;
        b.stateDays = 0;
        b.occ = 0;
        this.buildingVersion++;
      }
    }
    for (const id of toRemove) this.removeBuilding(id);
  }

  // ---------------- 予算 ----------------
  private updateBudget() {
    const inc: Record<string, number> = { 住宅: 0, 商業: 0, 工業: 0, 運賃: Math.round(this.transitRiders * FARE) };
    const exp: Record<string, number> = { 道路: 0, 公共交通: 0, 電力: 0, 水道: 0, 公園: 0 };
    for (const b of this.buildings.values()) {
      if (b.civic) {
        const def = CIVIC[b.type as CivicId];
        if (def.service) {
          const dept = SERVICE_DEPT[def.service];
          const k = DEPT_NAMES[dept];
          exp[k] = (exp[k] || 0) + def.upkeep * (this.services.funding[dept] / 100) * ((b.fund ?? 100) / 100);
          continue;
        }
        const cat = def.power ? '電力' : def.water ? '水道' : def.transit ? '公共交通' : '公園';
        exp[cat] += def.upkeep * (def.transit ? this.services.funding.transit / 100 : 1);
        continue;
      }
      if (b.state !== BState.Normal) continue;
      const def = GROW[b.type as GrowKind];
      const rate = this.taxes[b.type as GrowKind] / 100;
      const v = b.occ * rate * def.wealth * 3 * (def.zone === ZoneType.R ? taxFactor(b) : 1);
      if (def.zone === ZoneType.R) inc.住宅 += v;
      else if (def.zone === ZoneType.C) inc.商業 += v;
      else inc.工業 += v;
    }
    const g = this.g;
    for (let i = 0; i < g.n * g.n; i++) {
      if (g.road[i]) exp.道路 += ROADS[g.road[i]].upkeep;
      if (g.up[i]) exp.道路 += ROADS[g.up[i]].upkeep;
      for (const k of ['rail', 'erail', 'mono', 'sub'] as const) if (g[k][i]) exp.公共交通 += LINES[k].upkeep;
      if (g.bstop[i]) exp.公共交通 += BUS_STOP_UPKEEP;
      if (g.estn[i]) exp.公共交通 += ESTOP_UPKEEP / 4;
      if (g.pline[i]) exp.電力 += POWER_LINE_UPKEEP;
    }
    // 条例（カジノは収入）
    const pop = this.population();
    for (const id of this.ordinances) {
      const c = ordinanceCost(id, pop);
      if (c < 0) inc.カジノ = (inc.カジノ || 0) - c;
      else exp.条例 = (exp.条例 || 0) + c;
    }
    // 借入の返済
    if (!this.sandbox) {
      for (const l of this.loans) exp.借入の返済 = (exp.借入の返済 || 0) + payLoan(l);
      const done = this.loans.filter((l) => l.months <= 0 || l.remaining <= 0.5);
      if (done.length) this.pushNews(`借入の返済が ${done.length} 件終わりました。`);
      this.loans = this.loans.filter((l) => !done.includes(l));
    }
    let income = 0, expense = 0;
    for (const k in inc) { inc[k] = Math.round(inc[k]); income += inc[k]; }
    for (const k in exp) { exp[k] = Math.round(exp[k]); expense += exp[k]; }
    if (!this.sandbox) this.funds += income - expense;
    this.lastMonthIncome = income;
    this.lastMonthExpense = expense;
    this.incomeBreakdown = inc;
    this.expenseBreakdown = exp;
    if (this.funds < 0 && !this.sandbox) this.pushNews('資金がマイナスです。税率を上げるか、支出を減らしましょう。');
  }

  private checkNeighbor() {
    const g = this.g, n = g.n;
    let found = false, hwy = false;
    for (let k = 0; k < n; k++) {
      for (const i of [k, (n - 1) * n + k, k * n, k * n + n - 1]) {
        if (g.anyRoad(i)) found = true;
        if (isHighway(g.road[i]) || isHighway(g.up[i])) hwy = true;
      }
    }
    if (found && !this.neighborConnected) this.pushNews('道路が隣の都市とつながりました。通勤や取引が始まります。');
    if (hwy && !this.highwayConnected) this.pushNews('高速道路が隣の都市とつながりました。通勤と貨物の輸送が便利になります。');
    this.neighborConnected = found;
    this.highwayConnected = hwy;
  }
  private highwayConnected = false;

  population() {
    let p = 0;
    for (const b of this.buildings.values()) {
      if (!b.civic && b.state === BState.Normal && GROW[b.type as GrowKind].zone === ZoneType.R) p += b.occ;
    }
    return p;
  }

  private updateServicesMonthly() {
    const r = updateServices(this.g, this.buildings.values(), this.services, this.maps, {
      pollution: this.maps.pollution, landValue: this.maps.landValue, resDensity: this.resDensity,
      crimeMul: this.fx.crime, fireMul: this.fx.fire, hqBonus: this.fx.hqBonus, garbageMul: this.fx.garbage, ages: agesOf,
    });
    // 年齢層・出生・死亡と、斎場・霊園
    const f = this.services.funeral;
    const before = f.shortage;
    const fill = (): string => [...this.buildings.values()].filter((b) => b.type === 'cemetery').map((b) => Math.floor((b.occ / 3000) * 5)).join(',');
    const f0 = fill();
    updatePopulation(this.buildings.values(), f, this.services.hq, (b) => facilityEffect(this.services, b), r.pop);
    if (fill() !== f0) this.buildingVersion++; // 霊園の埋まり具合が変わったら描き直す
    if (f.shortage > 0.3 && before <= 0.3) this.pushNews(f.waiting > f.ashes ? '斎場が足りず、火葬を待つ人が増えています。斎場を作りましょう。' : '霊園がいっぱいで、納骨を待つ人が増えています。霊園を作りましょう。');
    for (const b of this.buildings.values()) {
      if (b.type === 'crematorium') b.note = `月 ${Math.round(f.cremated)} 人を火葬（受け入れ ${Math.round(f.capacity)} 人）${f.waiting >= 1 ? `・<span class="neg">待っている人 ${Math.round(f.waiting)} 人</span>` : ''}`;
      if (b.type === 'cemetery') b.note = `${Math.round(b.occ).toLocaleString()} / ${(CIVIC.cemetery.capacity ?? 0).toLocaleString()} 区画`;
    }
    this.svcCover = r.cover;
    this.schoolSeats = r.schoolSeats;
    for (const msg of r.news) this.pushNews(msg);
    this.svc = { lifeExp: r.lifeExp, crimeAvg: r.crimeAvg, garbageLevel: r.garbageLevel };
  }

  private updateRating() {
    const pop = this.population();
    let polSum = 0, n = 0;
    for (const b of this.buildings.values()) {
      if (b.civic || b.state !== BState.Normal || GROW[b.type as GrowKind].zone !== ZoneType.R) continue;
      polSum += b.occ * Math.min(1, this.maps.pollution[this.g.idx(b.x, b.y)] / 140);
      n += b.occ;
    }
    const taxes = Object.values(this.taxes);
    let workers = 0;
    for (const b of this.buildings.values()) if (!b.civic && b.state === BState.Normal && GROW[b.type as GrowKind].zone === ZoneType.R) workers += workersOf(b);
    const r = computeRating({
      pop, avgTax: taxes.reduce((a, b) => a + b, 0) / taxes.length, crime: this.svc.crimeAvg, pollution: n ? polSum / n : 0,
      commute: this.avgCommute, unemployment: workers > 50 ? Math.max(0, 1 - this.employedTotal / workers) : 0,
      garbage: this.svc.garbageLevel, powerShort: this.powerDemand > this.powerSupply && this.powerSupply > 0,
      waterShort: this.waterDemand > this.waterSupply && this.waterSupply > 0, health: this.services.hq, eq: this.services.eq.adult,
      funds: this.funds, ordinanceBonus: this.fx.rating, funeral: this.services.funeral.shortage,
      rewards: [...this.buildings.values()].filter((b) => REWARD_REQ[b.type as string]).length,
    });
    this.rating += (r.value - this.rating) * 0.25;
    this.ratingParts = r.parts;
    // アドバイザー
    const free = { R: 0, C: 0, I: 0 };
    const g = this.g;
    for (let i = 0; i < g.n * g.n; i++) if (g.zone[i] && !g.bldg[i]) free[(['', 'R', 'C', 'I'] as const)[g.zone[i]] as 'R' | 'C' | 'I']++;
    let congested = 0, roads = 0;
    for (let i = 0; i < g.n * g.n; i++) if (g.road[i]) { roads++; if (this.maps.congestion[i] > 1.6) congested++; }
    this.advice = makeAdvice({
      pop, funds: this.funds, net: this.lastMonthIncome - this.lastMonthExpense, avgTax: taxes.reduce((a, b) => a + b, 0) / taxes.length,
      loans: this.loans.length, demandR: this.zoneDemand[0], demandC: this.zoneDemand[1],
      demandI: this.zoneDemand[2], freeZones: free, commute: this.avgCommute, congested: roads ? congested / roads : 0,
      transitShare: this.modeShare.transit, crime: this.svc.crimeAvg, fireRisk: 0, policeCover: this.svcCover.police,
      fireCover: this.svcCover.fire, healthCover: this.svcCover.health, hq: this.services.hq, eqChild: this.services.eq.child,
      eqAdult: this.services.eq.adult, schoolSeats: this.schoolSeats,
      powerShort: this.powerDemand > this.powerSupply && this.powerSupply > 0, waterShort: this.waterDemand > this.waterSupply && this.waterSupply > 0,
      powerMargin: this.powerSupply > 0 ? 1 - this.powerDemand / this.powerSupply : 1, waterMargin: this.waterSupply > 0 ? 1 - this.waterDemand / this.waterSupply : 1,
      garbage: this.svc.garbageLevel, pollution: n ? polSum / n : 0,
      funeral: this.services.funeral, elderly: this.services.funeral.ages[2],
      strikes: Object.entries(this.services.strike).filter(([, v]) => v > 0).map(([k]) => DEPT_NAMES[k as Dept]),
      rating: this.rating,
      sandbox: this.sandbox,
    });
    // 新しく出た「問題」は、アドバイザーからのニュースとして知らせる
    const bad = new Set(this.advice.filter((a) => a.level === 2).map((a) => a.text));
    for (const a of this.advice) if (a.level === 2 && !this.lastBad.has(a.text)) this.pushNews(`${ADVISORS[a.advisor]}アドバイザー：${a.text}`);
    this.lastBad = bad;
  }

  private monthly() {
    this.checkNeighbor();
    this.updatePower();
    this.updateWater();
    this.updateTraffic();
    this.updatePollutionAndLandValue();
    this.updateServicesMonthly();
    this.updateDemand();
    this.updateOccupancy();
    this.updateBudget();
    this.updateRating();
    this.candidatesDirty = true;
    this.mapsVersion++;
    this.buildingVersion++;
    const pop = this.population();
    this.cachedPop = pop;
    this.history.push({ pop, funds: this.funds });
    if (this.history.length > 600) this.history.shift();
    for (const m of [100, 500, 1000, 2000, 5000, 10000, 20000, 50000]) {
      if (pop >= m && !this.milestones.includes(m)) {
        this.milestones.push(m);
        this.pushNews(`人口が ${m.toLocaleString()} 人を超えました！`);
      }
    }
    // 需要が高いのにゾーンがない
    if (this.day % (DAYS_PER_MONTH * 6) === 0) {
      if (this.demand.R1 > 0.6 && !this.candidates[1].length) this.pushNews('住宅の需要が高まっています。住宅ゾーンを指定しましょう。');
      else if (Math.max(this.demand.ID, this.demand.IL, this.demand.IA) > 0.6 && !this.candidates[3].length) this.pushNews('工業の需要が高まっています。工業ゾーンを指定しましょう。');
      else if (Math.max(this.demand.CS1, this.demand.CS2) > 0.6 && !this.candidates[2].length) this.pushNews('商業の需要が高まっています。商業ゾーンを指定しましょう。');
    }
  }

  recomputeAll() {
    regradeApproaches(this.g);
    this.cachedPop = this.population();
    this.checkNeighbor();
    this.updatePower();
    this.updateWater();
    this.updatePollutionAndLandValue();
    this.candidatesDirty = true;
    this.updateStats();
  }

  updateStats() {
    let pop = 0, jobs = 0;
    for (const b of this.buildings.values()) {
      if (b.civic || b.state !== BState.Normal) continue;
      if (GROW[b.type as GrowKind].zone === ZoneType.R) pop += b.occ;
      else jobs += b.cap;
    }
    const d = this.demand;
    this.stats = {
      day: this.day,
      funds: Math.round(this.funds),
      population: pop,
      jobs,
      workers: Math.round([...this.buildings.values()].reduce((t, b) => t + (!b.civic && b.state === BState.Normal && GROW[b.type as GrowKind].zone === ZoneType.R ? workersOf(b) : 0), 0)),
      employed: Math.round(this.employedTotal),
      demand: { ...d },
      demandRCI: [...this.zoneDemand] as [number, number, number],
      powerSupply: this.powerSupply,
      powerDemand: Math.round(this.powerDemand),
      waterSupply: this.waterSupply,
      waterDemand: Math.round(this.waterDemand),
      lastIncome: this.lastMonthIncome,
      lastExpense: this.lastMonthExpense,
      incomeBreakdown: this.incomeBreakdown,
      expenseBreakdown: this.expenseBreakdown,
      avgCommute: this.avgCommute,
      speed: this.speed,
      neighborConnected: this.neighborConnected,
      transitRiders: this.transitRiders,
      modeShare: this.modeShare,
      services: {
        funding: { ...this.services.funding }, strike: { ...this.services.strike }, eq: { ...this.services.eq }, hq: this.services.hq,
        lifeExp: this.svc.lifeExp, crime: this.svc.crimeAvg, garbage: { ...this.services.garbage },
        funeral: { ...this.services.funeral, ages: [...this.services.funeral.ages] as Ages },
      },
      rating: Math.round(this.rating),
      ratingParts: this.ratingParts,
      advice: this.advice,
      ordinances: [...this.ordinances],
      loans: this.loans.map((l) => ({ ...l })),
      loanRate: loanRate(this.funds, this.lastMonthIncome - this.lastMonthExpense, this.loans.length),
    };
  }
}

// 箱型のぼかし（radius マス、passes 回）
export function blur(src: Float32Array, n: number, radius: number, passes: number): Float32Array<ArrayBuffer> {
  const a = new Float32Array(src);
  const b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    // 横
    for (let y = 0; y < n; y++) {
      let s = 0;
      const row = y * n;
      for (let x = -radius; x <= radius; x++) s += x >= 0 && x < n ? a[row + x] : 0;
      for (let x = 0; x < n; x++) {
        b[row + x] = s / (2 * radius + 1);
        const out = x - radius, inn = x + radius + 1;
        if (out >= 0) s -= a[row + out];
        if (inn < n) s += a[row + inn];
      }
    }
    // 縦
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let y = -radius; y <= radius; y++) s += y >= 0 && y < n ? b[y * n + x] : 0;
      for (let y = 0; y < n; y++) {
        a[y * n + x] = s / (2 * radius + 1);
        const out = y - radius, inn = y + radius + 1;
        if (out >= 0) s -= b[out * n + x];
        if (inn < n) s += b[inn * n + x];
      }
    }
  }
  return a;
}

// 地上の道路がつながっているまとまりに番号をつける（道路のないマスは -1）
function groundRoadComponents(g: Grid): Int32Array {
  const n = g.n, N = n * n;
  const comp = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  let k = 0;
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0 || !g.road[s]) continue;
    comp[s] = k;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      const m = g.conn[c], x = c % n, y = (c / n) | 0;
      for (let d = 0; d < 8; d++) {
        if (!(m & (1 << d))) continue;
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (comp[j] >= 0 || !g.road[j]) continue;
        comp[j] = k;
        stack.push(j);
      }
    }
    k++;
  }
  return comp;
}
