// ツールの計画（プレビューと実行の両方で使う）
import { Grid } from './grid';
import { DX, DY, MAX_ROAD_GRADE, CELL, WATER_LEVEL, dirOf, isDiag, opp } from './constants';
import { ROADS, RoadType, ZoneType, ZONE_COST, POWER_LINE_COST, CIVIC, CivicId, BRIDGE_COST_MUL, MAX_BRIDGE } from './defs';

export interface LinePath {
  cells: number[]; // マスの番号
  dirs: number[]; // cells[k] → cells[k+1] の方向
}

// 始点から終点まで、斜め→直線の順で8方向の線を引く
export function planLine(g: Grid, x0: number, y0: number, x1: number, y1: number): LinePath {
  const cells: number[] = [];
  const dirs: number[] = [];
  let x = x0, y = y0;
  cells.push(g.idx(x, y));
  const dx = x1 - x0, dy = y1 - y0;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const ad = Math.abs(dx), bd = Math.abs(dy);
  const diag = Math.min(ad, bd);
  const straight = Math.max(ad, bd) - diag;
  // ほぼ斜めの場合は斜めを優先、ほぼ直線の場合は直線から始める
  const order: Array<[number, number, number]> = [];
  if (diag > 0 && straight > 0) {
    const sdx = ad > bd ? sx : 0, sdy = ad > bd ? 0 : sy;
    if (straight >= diag) {
      order.push([sdx, sdy, straight], [sx, sy, diag]);
    } else {
      order.push([sx, sy, diag], [sdx, sdy, straight]);
    }
  } else if (diag > 0) {
    order.push([sx, sy, diag]);
  } else if (straight > 0) {
    order.push([ad > bd ? sx : 0, ad > bd ? 0 : sy, straight]);
  }
  for (const [ox, oy, cnt] of order) {
    const d = dirOf(ox, oy);
    for (let k = 0; k < cnt; k++) {
      x += ox;
      y += oy;
      if (!g.inb(x, y)) break;
      dirs.push(d);
      cells.push(g.idx(x, y));
    }
  }
  return { cells, dirs };
}

export interface Lane {
  cells: number[];
  dirs: number[];
  oneWay: boolean;
}

export interface RoadPlan {
  ok: boolean;
  path: LinePath;
  lanes: Lane[];
  type: RoadType;
  cost: number;
  bad: Set<number>;
  vertexH: Map<number, number>; // 頂点番号 → 新しい高さ
  deck: Map<number, number>; // 橋のマス → 路面の高さ
  uturns: [number, number][]; // 大通りの端で折り返すための接続（from → to）
  reason: string;
  bridgeCells: number;
}

// 斜めの接続が、既存の逆向きの斜めの接続と交差するか
function crossesDiagonal(g: Grid, i: number, d: number) {
  const n = g.n;
  const x = i % n, y = (i / n) | 0;
  const ax = x + DX[d], ay = y; // 横の隣
  const bx = x, by = y + DY[d]; // 縦の隣
  if (!g.inb(ax, ay) || !g.inb(bx, by)) return false;
  const dd = dirOf(bx - ax, by - ay);
  return (g.conn[ay * n + ax] & (1 << dd)) !== 0;
}

// 進行方向の左側にある、並行するマスへのずれ（大通りの反対車線）
function leftOffset(d: number): [number, number] {
  if (!isDiag(d)) return [DY[d], -DX[d]];
  return [0, -DX[d]];
}

// 大通り：引いた線を右側の車線とし、左側に反対車線を作る
function avenueLanes(g: Grid, path: LinePath): { lanes: Lane[]; ok: boolean } {
  const { cells, dirs } = path;
  const n = g.n;
  const other: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const d = dirs[Math.min(k, dirs.length - 1)] ?? 0;
    const [ox, oy] = leftOffset(d);
    const x = (cells[k] % n) + ox, y = ((cells[k] / n) | 0) + oy;
    if (!g.inb(x, y)) return { lanes: [{ cells, dirs, oneWay: true }], ok: false };
    const c = y * n + x;
    if (other[other.length - 1] !== c) other.push(c);
  }
  // 反対車線は逆向きに進む
  other.reverse();
  const odirs: number[] = [];
  let ok = true;
  for (let k = 0; k + 1 < other.length; k++) {
    const dx = (other[k + 1] % n) - (other[k] % n);
    const dy = ((other[k + 1] / n) | 0) - ((other[k] / n) | 0);
    const d = dirOf(dx, dy);
    if (d < 0) ok = false;
    odirs.push(d < 0 ? 0 : d);
  }
  return { lanes: [{ cells, dirs, oneWay: true }, { cells: other, dirs: odirs, oneWay: true }], ok };
}

export function planRoad(g: Grid, path: LinePath, type: RoadType): RoadPlan {
  const def = ROADS[type];
  const bad = new Set<number>();
  const reasons: string[] = [];
  const why = (r: string) => reasons.push(r);
  let lanes: Lane[] = [{ cells: path.cells, dirs: path.dirs, oneWay: !!def.oneWay }];
  const uturns: [number, number][] = [];
  if (def.wide && path.cells.length > 1) {
    const av = avenueLanes(g, path);
    lanes = av.lanes;
    if (!av.ok) {
      for (const i of path.cells) bad.add(i);
      why('大通りは、この形には引けません（マップの端や急な曲がり）');
    } else {
      const a = lanes[0].cells, b = lanes[1].cells;
      uturns.push([a[a.length - 1], b[0]], [b[b.length - 1], a[0]]);
    }
  }
  let cost = 0;
  let bridgeCells = 0;
  const vacc = new Map<number, [number, number]>();
  const deck = new Map<number, number>();
  for (const lane of lanes) {
    const r = planLane(g, lane, type, bad, why, vacc, deck);
    cost += r.cost;
    bridgeCells += r.bridge;
  }
  const n = g.n, V = n + 1;
  // 既存の道路の頂点は動かさない
  const locked = new Set<number>();
  for (const lane of lanes)
    for (const i of lane.cells) {
      if (!g.road[i]) continue;
      const x = i % n, y = (i / n) | 0;
      for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) locked.add(vy * V + vx);
    }
  const vertexH = new Map<number, number>();
  let steep = false, sink = false;
  for (const [vi, [sum, c]] of vacc) {
    if (locked.has(vi)) continue;
    const nh = sum / c;
    const old = g.heights[vi];
    if (Math.abs(nh - old) > 0.05) {
      vertexH.set(vi, nh);
      cost += Math.abs(nh - old) * 1.5;
      if (Math.abs(nh - old) > 14) steep = true;
      if (nh < WATER_LEVEL + 0.5) sink = true;
    }
  }
  if (steep || sink) {
    for (const lane of lanes)
      for (const i of lane.cells) {
        const x = i % n, y = (i / n) | 0;
        if (deck.has(i)) continue;
        for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
          const vh = vertexH.get(vy * V + vx);
          if (vh !== undefined && (Math.abs(vh - g.heights[vy * V + vx]) > 14 || vh < WATER_LEVEL + 0.5)) bad.add(i);
        }
      }
    why(steep ? '地形の高低差が大きすぎます' : '水際の地面が低すぎます');
  }
  cost = Math.round(cost);
  return {
    ok: bad.size === 0 && path.cells.length > 1, path, lanes, type, cost, bad, vertexH, deck, uturns,
    reason: reasons[0] || '', bridgeCells,
  };
}

function planLane(
  g: Grid, lane: Lane, type: RoadType, bad: Set<number>, why: (r: string) => void,
  vacc: Map<number, [number, number]>, deck: Map<number, number>,
): { cost: number; bridge: number } {
  const def = ROADS[type];
  const n = g.n, V = n + 1;
  const { cells, dirs } = lane;
  const water = cells.map((i) => g.isWater(i % n, (i / n) | 0) || g.deck[i] > 0);
  let cost = 0, bridge = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (g.bldg[i]) { bad.add(i); why('建物があります。先に取り壊してください'); }
    const cur = g.road[i];
    const len = k > 0 && isDiag(dirs[k - 1]) ? 1.41 : 1;
    const mul = water[k] ? BRIDGE_COST_MUL : 1;
    if (cur === 0) cost += def.cost * len * mul;
    else if (ROADS[cur].rank < def.rank) cost += Math.max(0, def.cost - ROADS[cur].cost) * len * mul;
  }
  for (let k = 0; k < dirs.length; k++) {
    if (isDiag(dirs[k]) && crossesDiagonal(g, cells[k], dirs[k])) {
      bad.add(cells[k]);
      bad.add(cells[k + 1]);
      why('斜めの道路どうしは交差点なしで交差できません');
    }
  }

  // 橋（水の上の連続したマス）
  const t = cells.map((i) => g.roadH(i));
  const fixed = cells.map((i) => g.road[i] !== 0);
  for (let k = 0; k < cells.length; k++) {
    if (!water[k]) continue;
    let e = k;
    while (e + 1 < cells.length && water[e + 1]) e++;
    const run = cells.slice(k, e + 1);
    bridge += run.length;
    const markBad = (r: string) => { for (const c of run) bad.add(c); why(r); };
    if (k === 0 || e === cells.length - 1) markBad('橋の両端は陸地にしてください');
    else {
      const d0 = dirs[k - 1];
      for (let j = k - 1; j <= e; j++) if (dirs[j] !== d0) { markBad('橋はまっすぐに架けてください'); break; }
      if (run.length > MAX_BRIDGE) markBad(`橋が長すぎます（最大 ${MAX_BRIDGE} マス）`);
      // 既存の橋とは、同じ向きでしかつなげない
      for (const c of run) {
        const m = g.conn[c];
        if (m && (m & ~((1 << d0) | (1 << opp(d0))))) markBad('橋の上に交差点は作れません');
      }
      const h0 = g.roadH(cells[k - 1]), h1 = g.roadH(cells[e + 1]);
      const dh = Math.max(h0, h1, WATER_LEVEL + 3.5);
      for (let j = k; j <= e; j++) {
        const c = cells[j];
        const h = g.deck[c] > 0 ? g.deck[c] : dh;
        t[j] = h;
        fixed[j] = true;
        deck.set(c, h);
      }
    }
    k = e;
  }

  // 勾配の調整
  const segLen = (k: number) => (isDiag(dirs[k]) ? CELL * 1.414 : CELL);
  for (let k = 1; k < t.length; k++) {
    if (fixed[k]) continue;
    const m = MAX_ROAD_GRADE * segLen(k - 1);
    t[k] = Math.max(t[k - 1] - m, Math.min(t[k - 1] + m, t[k]));
  }
  for (let k = t.length - 2; k >= 0; k--) {
    if (fixed[k]) continue;
    const m = MAX_ROAD_GRADE * segLen(k);
    t[k] = Math.max(t[k + 1] - m, Math.min(t[k + 1] + m, t[k]));
  }
  for (let k = 1; k < t.length; k++) {
    const m = MAX_ROAD_GRADE * segLen(k - 1) * 1.6;
    if (Math.abs(t[k] - t[k - 1]) > m + 0.01) {
      bad.add(cells[k]);
      why('坂が急すぎます');
    }
  }
  for (let k = 0; k < cells.length; k++) {
    if (fixed[k]) continue;
    const i = cells[k];
    const x = i % n, y = (i / n) | 0;
    for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
      const vi = vy * V + vx;
      const a = vacc.get(vi) || [0, 0];
      a[0] += t[k];
      a[1] += 1;
      vacc.set(vi, a);
    }
  }
  return { cost, bridge };
}

export function applyRoad(g: Grid, plan: RoadPlan) {
  const def = ROADS[plan.type];
  for (const [vi, h] of plan.vertexH) g.heights[vi] = h;
  for (const [c, h] of plan.deck) g.deck[c] = h;
  for (const lane of plan.lanes) {
    const { cells, dirs } = lane;
    for (const i of cells) {
      const cur = g.road[i];
      if (!cur || ROADS[cur].rank < def.rank) g.road[i] = plan.type;
      g.zone[i] = 0;
      g.zden[i] = 0;
      g.tree[i] = 0;
    }
    for (let k = 0; k < dirs.length; k++) {
      const d = dirs[k];
      const a = cells[k], b = cells[k + 1];
      g.conn[a] |= 1 << d;
      g.conn[b] |= 1 << opp(d);
      g.flow[a] |= 1 << d;
      if (lane.oneWay) g.flow[b] &= ~(1 << opp(d));
      else g.flow[b] |= 1 << opp(d);
    }
  }
  // 大通りの端の折り返し
  const n = g.n;
  for (const [a, b] of plan.uturns) {
    const d = dirOf((b % n) - (a % n), ((b / n) | 0) - ((a / n) | 0));
    if (d < 0) continue;
    g.conn[a] |= 1 << d;
    g.conn[b] |= 1 << opp(d);
    g.flow[a] |= 1 << d;
  }
}

// ---- 範囲指定（ゾーン、取り壊し） ----
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export function normRect(x0: number, y0: number, x1: number, y1: number, n: number): Rect {
  return {
    x0: Math.max(0, Math.min(x0, x1)),
    y0: Math.max(0, Math.min(y0, y1)),
    x1: Math.min(n - 1, Math.max(x0, x1)),
    y1: Math.min(n - 1, Math.max(y0, y1)),
  };
}

export interface ZonePlan {
  cells: number[];
  skipped: number[];
  cost: number;
  zone: ZoneType;
  den: number;
}

export function planZone(g: Grid, r: Rect, zone: ZoneType, den: number): ZonePlan {
  const cells: number[] = [], skipped: number[] = [];
  let cost = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = g.idx(x, y);
      if (zone === ZoneType.None) {
        if (g.zone[i] && !g.bldg[i]) cells.push(i);
        continue;
      }
      const steep = g.cellMaxH(x, y) - g.cellMinH(x, y) > 7;
      if (g.road[i] || g.bldg[i] || g.isWater(x, y) || steep) {
        skipped.push(i);
        continue;
      }
      if (g.zone[i] === zone && g.zden[i] === den) continue;
      cells.push(i);
      cost += ZONE_COST[zone][den];
    }
  }
  return { cells, skipped, cost, zone, den };
}

export function applyZone(g: Grid, p: ZonePlan) {
  for (const i of p.cells) {
    g.zone[i] = p.zone;
    g.zden[i] = p.zone === ZoneType.None ? 0 : p.den;
  }
}

export interface BulldozePlan {
  roads: number[];
  lines: number[];
  buildings: number[];
  trees: number[];
  cost: number;
  cells: number[];
}

export function planBulldoze(
  g: Grid,
  r: Rect,
  bInfo: (id: number) => { civic: boolean; w: number; h: number } | undefined,
): BulldozePlan {
  const roads: number[] = [], lines: number[] = [], trees: number[] = [], cells: number[] = [];
  const bset = new Set<number>();
  let cost = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = g.idx(x, y);
      cells.push(i);
      if (g.road[i]) { roads.push(i); cost += 5; }
      if (g.pline[i]) { lines.push(i); cost += 1; }
      if (g.bldg[i]) bset.add(g.bldg[i]);
      else if (g.tree[i]) { trees.push(i); cost += 1; }
    }
  }
  for (const id of bset) {
    const b = bInfo(id);
    if (b) cost += b.civic ? 50 * b.w * b.h : 15 * b.w * b.h;
  }
  return { roads, lines, buildings: [...bset], trees, cost, cells };
}

// 送電線
export interface LinePlan {
  ok: boolean;
  path: LinePath;
  cost: number;
  bad: Set<number>;
  reason: string;
}
export function planPowerLine(g: Grid, path: LinePath): LinePlan {
  const bad = new Set<number>();
  let cost = 0, reason = '';
  for (const i of path.cells) {
    if (g.bldg[i]) { bad.add(i); reason = '建物の上には引けません'; }
    if (!g.pline[i]) cost += POWER_LINE_COST;
  }
  return { ok: bad.size === 0, path, cost, bad, reason };
}

// 公共施設の設置
export interface PlopPlan {
  ok: boolean;
  id: CivicId;
  x: number;
  y: number;
  cells: number[];
  cost: number;
  reason: string;
  flatH: number;
}
export function planPlop(g: Grid, id: CivicId, cx: number, cy: number): PlopPlan {
  const def = CIVIC[id];
  // 指の位置が中央になるようにする
  const x = Math.max(0, Math.min(g.n - def.w, cx - Math.floor((def.w - 1) / 2)));
  const y = Math.max(0, Math.min(g.n - def.h, cy - Math.floor((def.h - 1) / 2)));
  const cells: number[] = [];
  let reason = '';
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (let yy = y; yy < y + def.h; yy++) {
    for (let xx = x; xx < x + def.w; xx++) {
      const i = g.idx(xx, yy);
      cells.push(i);
      if (g.road[i]) reason = reason || '道路があります';
      if (g.bldg[i]) reason = reason || '建物があります';
      if (g.isWater(xx, yy)) reason = reason || '水の上には置けません';
      lo = Math.min(lo, g.cellMinH(xx, yy));
      hi = Math.max(hi, g.cellMaxH(xx, yy));
      sum += g.cellH(xx, yy);
    }
  }
  if (hi - lo > 10) reason = reason || '地面の傾きが大きすぎます';
  const flatH = sum / cells.length;
  const cost = def.cost + Math.round((hi - lo) * def.w * def.h * 2);
  return { ok: !reason, id, x, y, cells, cost, reason, flatH };
}

export function flattenRect(g: Grid, x: number, y: number, w: number, h: number, target: number) {
  const V = g.n + 1;
  for (let vy = y; vy <= y + h; vy++) for (let vx = x; vx <= x + w; vx++) {
    // 道路の頂点は動かさない
    let nearRoad = false;
    for (const [cx, cy] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]]) {
      if (g.inb(cx, cy) && g.road[g.idx(cx, cy)]) nearRoad = true;
    }
    if (!nearRoad) g.heights[vy * V + vx] = target;
  }
}
