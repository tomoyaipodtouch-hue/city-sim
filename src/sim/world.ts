// 都市のシミュレーション本体（Worker 上で動く）
import { Grid } from './grid';
import { Rng } from './rng';
import { DAYS_PER_MONTH, DX, DY } from './constants';
import {
  CIVIC, CivicId, DEFAULT_TAX, DIFFICULTY, GROW, GROW_KINDS, GrowKind, POWER_LINE_UPKEEP, ROADS, RoadType,
  ZONE_KINDS, ZoneType,
} from './defs';
import { generateTerrain, MapStyle } from './terrain';
import {
  applyRoad, applyZone, flattenRect, normRect, planBulldoze, planLine, planPlop, planPowerLine, planRoad, planZone,
} from './plan';
import { assignCommute, congestionFactor, Destination, Origin } from './traffic';

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
  commute: number; // 平均通勤時間（分）
  employed: number; // 職のある住人の割合（住宅）
  badMonths: number;
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
}

export interface Maps {
  power: Uint8Array;
  water: Uint8Array;
  landValue: Uint8Array;
  pollution: Uint8Array;
  traffic: Float32Array;
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
  | { t: 'tax'; kind: GrowKind; rate: number };

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
  buildingVersion = 1;
  mapsVersion = 1;

  private candidates: Record<number, number[]> = { 1: [], 2: [], 3: [] };
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

  constructor(n = 128) {
    this.g = new Grid(n);
    this.maps = this.makeMaps(n);
    this.resDensity = new Float32Array(n * n);
    this.commuteAtCell = new Float32Array(n * n);
    this.updateStats();
  }

  private makeMaps(n: number): Maps {
    const c = n * n;
    const congestion = new Float32Array(c);
    congestion.fill(1);
    return {
      power: new Uint8Array(c),
      water: new Uint8Array(c),
      landValue: new Uint8Array(c),
      pollution: new Uint8Array(c),
      traffic: new Float32Array(c),
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
      road: g.road.slice(),
      conn: g.conn.slice(),
      pline: g.pline.slice(),
      zone: g.zone.slice(),
      zden: g.zden.slice(),
      bldg: g.bldg.slice(),
      tree: g.tree.slice(),
      buildings: [...this.buildings.values()].map((b) => ({ ...b })),
      nextId: this.nextId,
      rng: this.rng.state,
      demand: { ...this.demand },
      congestion: this.maps.congestion.slice(),
      traffic: this.maps.traffic.slice(),
      history: this.history.slice(),
      milestones: this.milestones.slice(),
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
    g.road.set(d.road);
    g.conn.set(d.conn);
    g.pline.set(d.pline);
    g.zone.set(d.zone);
    g.zden.set(d.zden);
    g.bldg.set(d.bldg);
    g.tree.set(d.tree);
    for (const b of d.buildings) w.buildings.set(b.id, { ...b });
    w.nextId = d.nextId;
    w.rng.state = d.rng;
    w.demand = { ...emptyKinds(0), ...d.demand };
    if (d.congestion) w.maps.congestion.set(d.congestion);
    if (d.traffic) w.maps.traffic.set(d.traffic);
    w.history = d.history || [];
    w.milestones = d.milestones || [];
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
        const path = planLine(g, c.x0, c.y0, c.x1, c.y1);
        const plan = planRoad(g, path, c.road);
        if (!plan.ok) return { ok: false, msg: plan.reason || '道路を引けません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        applyRoad(g, plan);
        if (plan.vertexH.size) this.heightVersion++;
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
        if (!plan.roads.length && !plan.lines.length && !plan.buildings.length && !plan.trees.length)
          return { ok: false, msg: '取り壊すものがありません' };
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        for (const id of plan.buildings) this.removeBuilding(id);
        for (const i of plan.roads) this.removeRoad(i);
        for (const i of plan.lines) g.pline[i] = 0;
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
        if (!this.spend(plan.cost)) return { ok: false, msg: '資金が足りません' };
        const def = CIVIC[c.id];
        flattenRect(g, plan.x, plan.y, def.w, def.h, plan.flatH);
        this.heightVersion++;
        const b: Building = {
          id: this.nextId++, civic: true, type: c.id, x: plan.x, y: plan.y, w: def.w, h: def.h,
          face: this.findFace(plan.x, plan.y, def.w, def.h), seed: this.rng.int(1e9), den: 0, cap: 0, occ: 0,
          state: BState.Normal, stateDays: 0, powered: false, watered: false, commute: 0, employed: 1, badMonths: 0,
        };
        this.placeBuilding(b);
        this.afterGridChange();
        let msg: string | undefined;
        if (def.water && !this.accessCells(b).length) msg = '道路に面していないので、水を送れません';
        return { ok: true, cost: plan.cost, msg };
      }
      case 'tax': {
        this.taxes[c.kind] = Math.max(0, Math.min(20, Math.round(c.rate * 10) / 10));
        return { ok: true };
      }
    }
  }

  private afterGridChange() {
    this.gridVersion++;
    this.candidatesDirty = true;
    this.updatePower();
    this.updateWater();
    this.mapsVersion++;
    this.buildingVersion++;
    this.updateStats();
  }

  private removeRoad(i: number) {
    const g = this.g, n = g.n;
    const x = i % n, y = (i / n) | 0;
    for (let d = 0; d < 8; d++) {
      if (g.conn[i] & (1 << d)) {
        const nx = x + DX[d], ny = y + DY[d];
        if (g.inb(nx, ny)) g.conn[ny * n + nx] &= ~(1 << ((d + 4) & 7));
      }
    }
    g.road[i] = 0;
    g.conn[i] = 0;
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

  // 敷地の周りにある道路マス
  accessCells(b: { x: number; y: number; w: number; h: number }): number[] {
    const g = this.g;
    const out: number[] = [];
    for (let y = b.y - 1; y <= b.y + b.h; y++)
      for (let x = b.x - 1; x <= b.x + b.w; x++) {
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) continue;
        if (g.inb(x, y) && g.road[g.idx(x, y)]) out.push(g.idx(x, y));
      }
    return out;
  }

  private hasRoadAccess(x: number, y: number) {
    const g = this.g;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (g.inb(nx, ny) && g.road[g.idx(nx, ny)]) return true;
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
    this.candidates = { 1: [], 2: [], 3: [] };
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const z = g.zone[i];
        if (!z || g.bldg[i] || g.road[i]) continue;
        if (!this.hasRoadAccess(x, y)) continue;
        this.candidates[z].push(i);
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
    switch (kind) {
      case 'R1': return 0.7 + 0.1 * lv - 0.4 * pol - commutePen - water * 0.5;
      case 'R2': return 0.3 + 0.7 * lv - 0.9 * pol - commutePen * 1.2 - water;
      case 'R3': return -0.25 + 1.3 * lv - 1.6 * pol - commutePen * 1.5 - water * 1.5;
      case 'CS1': return 0.35 + 0.5 * res + 0.3 * traffic - 0.2 * pol - water * 0.5;
      case 'CS2': return 0.15 + 0.5 * res + 0.3 * traffic + 0.4 * lv - 0.4 * pol - water;
      case 'CS3': return -0.3 + 0.4 * res + 0.2 * traffic + 1.0 * lv - 0.8 * pol - water * 1.5;
      case 'IA': return 0.75 - 0.6 * lv - 0.5 * res;
      case 'ID': return 0.7 - 0.2 * lv - water * 0.5;
      case 'IM': return 0.5 + 0.1 * lv - 0.3 * pol - water;
    }
  }

  private growthStep() {
    if (this.candidatesDirty) this.rebuildCandidates();
    const g = this.g;
    for (const z of [ZoneType.R, ZoneType.C, ZoneType.I]) {
      const list = this.candidates[z];
      if (!list.length) continue;
      const kinds = ZONE_KINDS[z];
      const maxDem = Math.max(...kinds.map((k) => this.demand[k]));
      if (maxDem <= 0.02) continue;
      const attempts = Math.ceil(maxDem * 2);
      for (let a = 0; a < attempts; a++) {
        const i = list[this.rng.int(list.length)];
        if (g.bldg[i] || g.zone[i] !== z) continue;
        if (!this.maps.power[i]) continue; // 電力がないと建たない
        // 種類を選ぶ
        let total = 0;
        const scores: number[] = [];
        for (const k of kinds) {
          const s = Math.max(0, this.demand[k]) * Math.max(0, this.desirability(k, i));
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
        this.trySpawn(kind, i);
      }
    }
  }

  private trySpawn(kind: GrowKind, i: number) {
    const g = this.g, n = g.n;
    const def = GROW[kind];
    const x0 = i % n, y0 = (i / n) | 0;
    const watered = this.maps.water[i] > 0;
    const sizes = watered ? def.sizes : def.sizes.filter(([w, h]) => w * h <= 2);
    if (!sizes.length) return;
    const [sw, sh] = sizes[this.rng.int(sizes.length)];
    // この位置を含む敷地を探す
    const tries: [number, number][] = [];
    for (let oy = 0; oy < sh; oy++) for (let ox = 0; ox < sw; ox++) tries.push([x0 - ox, y0 - oy]);
    for (const [x, y] of tries) {
      if (x < 0 || y < 0 || x + sw > n || y + sh > n) continue;
      let ok = true;
      let lo = Infinity, hi = -Infinity;
      for (let yy = y; yy < y + sh && ok; yy++)
        for (let xx = x; xx < x + sw; xx++) {
          const j = yy * n + xx;
          if (g.zone[j] !== def.zone || g.bldg[j] || g.road[j] || g.isWater(xx, yy)) { ok = false; break; }
          lo = Math.min(lo, g.cellMinH(xx, yy));
          hi = Math.max(hi, g.cellMaxH(xx, yy));
        }
      if (!ok || hi - lo > 8) continue;
      const lot = { x, y, w: sw, h: sh };
      if (!this.accessCells(lot).length) continue;
      const cap = Math.max(1, Math.round(def.capPerCell * sw * sh * (0.8 + this.rng.next() * 0.4) * (watered ? 1 : 0.7)));
      const b: Building = {
        id: this.nextId++, civic: false, type: kind, x, y, w: sw, h: sh, face: this.findFace(x, y, sw, sh),
        seed: this.rng.int(1e9), den: g.zden[i], cap, occ: 0, state: BState.Building, stateDays: 0,
        powered: true, watered, commute: 0, employed: 1, badMonths: 0,
      };
      this.placeBuilding(b);
      this.gridVersion++;
      this.candidatesDirty = true;
      return;
    }
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
        if (b.civic && CIVIC[b.type as CivicId].power) supply += CIVIC[b.type as CivicId].power!;
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
    return Math.max(1, (b.state === BState.Building ? b.cap : b.occ || b.cap) * def.powerPer);
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
    return Math.max(1, (b.occ || b.cap) * def.waterPer);
  }

  // ---------------- 汚染と地価 ----------------
  private updatePollutionAndLandValue() {
    const g = this.g, n = g.n, N = n * n;
    const src = new Float32Array(N);
    const park = new Float32Array(N);
    const res = new Float32Array(N);
    for (const b of this.buildings.values()) {
      if (b.state === BState.Building) continue;
      const area = b.w * b.h;
      let p = 0, pk = 0;
      if (b.civic) {
        const def = CIVIC[b.type as CivicId];
        p = (def.pollution || 0) / area;
        pk = def.park || 0;
      } else {
        const def = GROW[b.type as GrowKind];
        p = b.state === BState.Abandoned ? def.pollution * 0.2 : def.pollution * (b.occ / Math.max(1, b.cap));
        if (def.zone === ZoneType.R) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) res[g.idx(x, y)] = b.occ / area;
      }
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        src[g.idx(x, y)] += p;
        if (pk) park[g.idx(x, y)] = Math.max(park[g.idx(x, y)], pk);
      }
    }
    for (let i = 0; i < N; i++) if (g.road[i]) src[i] += Math.min(0.6, this.maps.traffic[i] / 3000);
    const pol = blur(src, n, 3, 3);
    for (let i = 0; i < N; i++) this.maps.pollution[i] = Math.min(255, Math.round(pol[i] * 140));

    this.resDensity = blur(res, n, 4, 2);
    for (let i = 0; i < N; i++) this.resDensity[i] *= 9;

    // 公園の効果（半径6マス）
    const parkFx = blur(park, n, 5, 2);
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
        v += g.tree[i] ? 0.04 : 0;
        v -= Math.min(0.6, pol[i] * 0.9);
        const cm = this.commuteAtCell[i];
        if (cm > 25) v -= Math.min(0.25, (cm - 25) / 120);
        lv[i] = Math.max(0, Math.min(1, v));
      }
    const lvb = blur(lv, n, 1, 1);
    for (let i = 0; i < N; i++) this.maps.landValue[i] = Math.round(Math.max(0, Math.min(1, lvb[i])) * 255);
  }

  // ---------------- 通勤 ----------------
  private updateTraffic() {
    const g = this.g, n = g.n;
    const origins = new Map<number, Origin>();
    const jobsAt = new Map<number, Destination[]>();
    for (const b of this.buildings.values()) {
      if (b.civic || b.state !== BState.Normal) continue;
      const def = GROW[b.type as GrowKind];
      const acc = this.accessCells(b);
      if (!acc.length) continue;
      if (def.zone === ZoneType.R) {
        const workers = Math.round(b.occ * 0.5);
        const cell = acc[b.seed % acc.length];
        let o = origins.get(cell);
        if (!o) origins.set(cell, (o = { cell, workers: 0, buildings: [] }));
        o.workers += workers;
        o.buildings.push({ id: b.id, workers });
      } else {
        const dest = { id: b.id, free: b.cap };
        for (const c of acc) {
          let l = jobsAt.get(c);
          if (!l) jobsAt.set(c, (l = []));
          l.push(dest);
        }
      }
    }
    const pop = this.population();
    const external = this.neighborConnected ? Math.round(200 + pop * 0.25) : 0;
    const r = assignCommute(g, [...origins.values()], jobsAt, external, this.maps.congestion, () => this.rng.next());
    // 交通量と混雑度（前の月と平均してなめらかにする）
    const traffic = this.maps.traffic, cong = this.maps.congestion;
    for (let i = 0; i < n * n; i++) {
      if (!g.road[i]) { traffic[i] = 0; cong[i] = 1; continue; }
      traffic[i] = traffic[i] * 0.4 + r.volume[i] * 0.6;
      const cap = ROADS[g.road[i]].capacity;
      cong[i] = cong[i] * 0.5 + congestionFactor(traffic[i], cap) * 0.5;
    }
    let employed = 0;
    for (const b of this.buildings.values()) {
      if (b.civic || b.state !== BState.Normal) continue;
      const def = GROW[b.type as GrowKind];
      if (def.zone === ZoneType.R) {
        const workers = Math.round(b.occ * 0.5);
        const e = r.employed.get(b.id);
        if (e === undefined) {
          b.employed = 0;
          b.commute = 0;
        } else {
          b.employed = workers > 0 ? e / workers : 1;
          b.commute = r.commute.get(b.id) || 0;
          employed += e;
        }
      } else {
        const f = r.filled.get(b.id) || 0;
        // 隣の都市からの通勤者もいる
        const outside = this.neighborConnected ? Math.min(b.cap - f, b.cap * 0.2) : 0;
        b.occ = Math.round(b.occ * 0.4 + (f + outside) * 0.6);
      }
    }
    this.employedTotal = employed;
    this.avgCommute = r.avgCommute;
    // 道路マスごとの通勤時間（近くの空き地の魅力に使う）
    const cm = new Float32Array(n * n);
    const cnt = new Float32Array(n * n);
    for (const b of this.buildings.values()) {
      if (b.civic || GROW[b.type as GrowKind].zone !== ZoneType.R || !b.commute) continue;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        cm[g.idx(x, y)] = b.commute;
        cnt[g.idx(x, y)] = 1;
      }
    }
    const bc = blur(cm, n, 4, 2), bn = blur(cnt, n, 4, 2);
    for (let i = 0; i < n * n; i++) this.commuteAtCell[i] = bn[i] > 0.01 ? bc[i] / bn[i] : 0;
  }

  // ---------------- 需要 ----------------
  private updateDemand() {
    let pop = 0, popR1 = 0, popR2 = 0, popR3 = 0;
    const capK = emptyKinds(0);
    for (const b of this.buildings.values()) {
      if (b.civic || b.state === BState.Abandoned) continue;
      const k = b.type as GrowKind;
      if (GROW[k].zone === ZoneType.R) {
        pop += b.occ;
        if (k === 'R1') popR1 += b.occ;
        else if (k === 'R2') popR2 += b.occ;
        else popR3 += b.occ;
      } else capK[k] += b.cap;
    }
    const jobs = capK.CS1 + capK.CS2 + capK.CS3 + capK.IA + capK.ID + capK.IM;
    const ext = this.neighborConnected ? 200 + pop * 0.25 : 0;
    const workers = pop * 0.5;
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
    const want = { IA: 180 + pop * 0.02, ID: 260 + pop * 0.12 + ext * 0.15, IM: pop > 1200 ? pop * 0.09 : 0 };
    for (const k of ['IA', 'ID', 'IM'] as const) {
      raw[k] = want[k] > 0 ? (want[k] - capK[k]) / Math.max(60, want[k] * 0.5) : -0.3;
      raw[k] += unemployment * 1.2;
    }
    raw.R1 -= unemployment * 1.5;
    raw.R2 -= unemployment * 1.5;
    raw.R3 -= unemployment * 1.5;
    const mul = DIFFICULTY[this.difficulty].demand;
    for (const k of GROW_KINDS) {
      let v = raw[k] - (this.taxes[k] - DEFAULT_TAX) * 0.08;
      if (v > 0) v *= mul;
      v = Math.max(-1, Math.min(1, v));
      this.demand[k] = this.demand[k] * 0.5 + v * 0.5;
    }
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
      if (!b.powered) bad = true;
      if (def.zone === ZoneType.R) {
        const dem = this.demand[b.type as GrowKind];
        if (b.employed < 0.5 && dem < 0) bad = true;
        if (b.commute > 60) bad = true;
        const target = b.cap * (b.powered ? 1 : 0.6) * (b.employed < 0.5 && dem < 0 ? 0.85 : 1);
        b.occ = Math.round(b.occ + (target - b.occ) * 0.3);
      } else {
        if (b.occ < b.cap * 0.3 && b.stateDays > 180) bad = true;
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
    const inc: Record<string, number> = { 住宅: 0, 商業: 0, 工業: 0 };
    const exp: Record<string, number> = { 道路: 0, 電力: 0, 水道: 0, 公園: 0 };
    for (const b of this.buildings.values()) {
      if (b.civic) {
        const def = CIVIC[b.type as CivicId];
        const cat = def.power ? '電力' : def.water ? '水道' : '公園';
        exp[cat] += def.upkeep;
        continue;
      }
      if (b.state !== BState.Normal) continue;
      const def = GROW[b.type as GrowKind];
      const rate = this.taxes[b.type as GrowKind] / 100;
      const v = b.occ * rate * def.wealth * 3;
      if (def.zone === ZoneType.R) inc.住宅 += v;
      else if (def.zone === ZoneType.C) inc.商業 += v;
      else inc.工業 += v;
    }
    const g = this.g;
    for (let i = 0; i < g.n * g.n; i++) {
      if (g.road[i]) exp.道路 += ROADS[g.road[i]].upkeep;
      if (g.pline[i]) exp.電力 += POWER_LINE_UPKEEP;
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
    let found = false;
    for (let k = 0; k < n && !found; k++) {
      if (g.road[k] || g.road[(n - 1) * n + k] || g.road[k * n] || g.road[k * n + n - 1]) found = true;
    }
    if (found && !this.neighborConnected) this.pushNews('道路が隣の都市とつながりました。通勤や取引が始まります。');
    this.neighborConnected = found;
  }

  population() {
    let p = 0;
    for (const b of this.buildings.values()) {
      if (!b.civic && b.state === BState.Normal && GROW[b.type as GrowKind].zone === ZoneType.R) p += b.occ;
    }
    return p;
  }

  private monthly() {
    this.checkNeighbor();
    this.updatePower();
    this.updateWater();
    this.updateTraffic();
    this.updatePollutionAndLandValue();
    this.updateDemand();
    this.updateOccupancy();
    this.updateBudget();
    this.candidatesDirty = true;
    this.mapsVersion++;
    this.buildingVersion++;
    const pop = this.population();
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
      else if (Math.max(this.demand.ID, this.demand.IA) > 0.6 && !this.candidates[3].length) this.pushNews('工業の需要が高まっています。工業ゾーンを指定しましょう。');
      else if (Math.max(this.demand.CS1, this.demand.CS2) > 0.6 && !this.candidates[2].length) this.pushNews('商業の需要が高まっています。商業ゾーンを指定しましょう。');
    }
  }

  recomputeAll() {
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
      workers: Math.round(pop * 0.5),
      employed: Math.round(this.employedTotal),
      demand: { ...d },
      demandRCI: [Math.max(d.R1, d.R2, d.R3), Math.max(d.CS1, d.CS2, d.CS3), Math.max(d.IA, d.ID, d.IM)],
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
