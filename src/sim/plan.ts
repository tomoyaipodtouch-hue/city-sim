// ツールの計画（プレビューと実行の両方で使う）
import { Grid } from './grid';
import { DX, DY, MAX_ROAD_GRADE, CELL, WATER_LEVEL, dirOf, isDiag, opp } from './constants';
import { ROADS, RoadType, ZoneType, ZONE_COST, POWER_LINE_COST, CIVIC, CivicId, BRIDGE_COST_MUL, MAX_BRIDGE, OVERPASS_LIFT, RAMP_COST, isHighway, LINES, LineKind, BUS_STOP_COST } from './defs';

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
  levels: number[]; // マスごとの階層（0 = 地上, 1 = 上空）
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
  upH: Map<number, number>; // 上空のマス → 路面の高さ
  converts: number[]; // 上空（立体交差）へ移す既存の道路のマス
  uturns: [number, number][]; // 大通りの端で折り返すための接続（from → to）
  reason: string;
  bridgeCells: number;
}

// 斜めの接続が、既存の逆向きの斜めの接続と交差するか
function crossesDiagonal(g: Grid, i: number, d: number, level = 0) {
  const n = g.n;
  const x = i % n, y = (i / n) | 0;
  const ax = x + DX[d], ay = y; // 横の隣
  const bx = x, by = y + DY[d]; // 縦の隣
  if (!g.inb(ax, ay) || !g.inb(bx, by)) return false;
  const dd = dirOf(bx - ax, by - ay);
  const c = level ? g.conn1 : g.conn;
  return (c[ay * n + ax] & (1 << dd)) !== 0;
}

// 進行方向の左側にある、並行するマスへのずれ（大通りの反対車線）
function leftOffset(d: number): [number, number] {
  if (!isDiag(d)) return [DY[d], -DX[d]];
  return [0, -DX[d]];
}

// 大通り：引いた線を右側の車線とし、左側に反対車線を作る
function avenueLanes(g: Grid, path: LinePath): { lanes: { cells: number[]; dirs: number[] }[]; ok: boolean } {
  const { cells, dirs } = path;
  const n = g.n;
  const other: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const d = dirs[Math.min(k, dirs.length - 1)] ?? 0;
    const [ox, oy] = leftOffset(d);
    const x = (cells[k] % n) + ox, y = ((cells[k] / n) | 0) + oy;
    if (!g.inb(x, y)) return { lanes: [{ cells, dirs }], ok: false };
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
  return { lanes: [{ cells, dirs }, { cells: other, dirs: odirs }], ok };
}

// 道路の向き（そのマスで使っている方向の軸）。0 = 東西, 1 = 南北, 2 = 斜め
function axisOf(mask: number) {
  let ew = 0, ns = 0, dg = 0;
  for (let d = 0; d < 8; d++) {
    if (!(mask & (1 << d))) continue;
    if (d === 0 || d === 4) ew++;
    else if (d === 2 || d === 6) ns++;
    else dg++;
  }
  return { ew, ns, dg, deg: ew + ns + dg };
}

export function planRoad(g: Grid, path: LinePath, type: RoadType): RoadPlan {
  const def = ROADS[type];
  const bad = new Set<number>();
  const reasons: string[] = [];
  const why = (r: string) => reasons.push(r);
  let raw: { cells: number[]; dirs: number[] }[] = [{ cells: path.cells, dirs: path.dirs }];
  const uturns: [number, number][] = [];
  if (def.wide && path.cells.length > 1) {
    const av = avenueLanes(g, path);
    raw = av.lanes;
    if (!av.ok) {
      for (const i of path.cells) bad.add(i);
      why(`${def.name}は、この形には引けません（マップの端や急な曲がり）`);
    } else if (!def.highway) {
      const a = raw[0].cells, b = raw[1].cells;
      uturns.push([a[a.length - 1], b[0]], [b[b.length - 1], a[0]]);
    }
  }
  const lanes: Lane[] = raw.map((l) => ({ ...l, oneWay: !!def.oneWay, levels: [] }));
  let cost = 0;
  let bridgeCells = 0;
  const vacc = new Map<number, [number, number]>();
  const deck = new Map<number, number>();
  const upH = new Map<number, number>();
  const converts = new Set<number>();
  for (const lane of lanes) {
    const r = planLane(g, lane, type, bad, why, vacc, deck, upH, converts);
    cost += r.cost;
    bridgeCells += r.bridge;
  }
  const n = g.n, V = n + 1;
  // 既存の道路の頂点は動かさない
  const locked = new Set<number>();
  for (const lane of lanes)
    for (let k = 0; k < lane.cells.length; k++) {
      const i = lane.cells[k];
      if (!g.road[i] && lane.levels[k] === 0) continue;
      if (lane.levels[k] === 1 && !g.road[i]) continue;
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
    ok: bad.size === 0 && path.cells.length > 1, path, lanes, type, cost, bad, vertexH, deck, upH,
    converts: [...converts], uturns, reason: reasons[0] || '', bridgeCells,
  };
}

function planLane(
  g: Grid, lane: Lane, type: RoadType, bad: Set<number>, why: (r: string) => void,
  vacc: Map<number, [number, number]>, deck: Map<number, number>, upHs: Map<number, number>, converts: Set<number>,
): { cost: number; bridge: number } {
  const def = ROADS[type];
  const n = g.n, V = n + 1;
  const { cells, dirs } = lane;
  const last = cells.length - 1;
  const dirAt = (k: number) => dirs[Math.min(k, dirs.length - 1)] ?? 0;
  const axisOfDir = (d: number) => (d === 0 || d === 4 ? 0 : d === 2 || d === 6 ? 1 : 2);

  // 階層を決める
  const levels = cells.map((i, k) => {
    const end = k === 0 || k === last;
    if (def.elevated) {
      // 高架の端が地上の高速道路に重なる場合は、地上に降りてつながる
      if (end && g.road[i] === RoadType.GroundHighway && !g.up[i]) return 0;
      return 1;
    }
    if (type === RoadType.GroundHighway) {
      if (end && g.up[i] === RoadType.Highway && !g.road[i]) return 1;
      return 0;
    }
    // 一般の道路
    if (g.road[i] === RoadType.GroundHighway) return 1; // 立体交差でまたぐ
    if (g.up[i] === RoadType.Ramp && !g.road[i]) return 1;
    return 0;
  });
  lane.levels = levels;

  let cost = 0, bridge = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const L = levels[k];
    if (g.bldg[i]) { bad.add(i); why('建物があります。先に取り壊してください'); }
    const cur = L ? g.up[i] : g.road[i];
    const len = k > 0 && isDiag(dirs[k - 1]) ? 1.41 : 1;
    const isW = g.isWater(i % n, (i / n) | 0) || g.deck[i] > 0;
    const mul = isW && L === 0 ? BRIDGE_COST_MUL : 1;
    if (cur === 0) cost += def.cost * len * mul;
    else if (ROADS[cur].rank < def.rank) cost += Math.max(0, def.cost - ROADS[cur].cost) * len * mul;

    if (def.highway) {
      if (L === 0) {
        const r = g.road[i];
        if (r && !isHighway(r) && r !== RoadType.Ramp) {
          // 既存の道路は、高速道路の上を通る立体交差にする
          const ax = axisOf(g.conn[i]);
          const myAxis = axisOfDir(dirAt(k));
          const parallel = (myAxis === 0 && ax.ew > 0) || (myAxis === 1 && ax.ns > 0) || (myAxis === 2 && ax.dg > 0);
          if (ax.deg > 2 || ax.dg > 0 || parallel || g.up[i] || g.deck[i] > 0) {
            bad.add(i);
            why('交差点や斜めの道路、橋の上には高速道路を通せません');
          } else converts.add(i);
        }
        if (r === RoadType.Ramp) { bad.add(i); why('ランプの上には引けません'); }
      } else {
        const u = g.up[i];
        if (u && !isHighway(u)) { bad.add(i); why('高架の道路やランプと重なっています'); }
      }
    } else if (L === 1) {
      if (g.up[i] && g.up[i] !== RoadType.Ramp && !(g.up[i] === type)) { bad.add(i); why('ここには立体交差を作れません'); }
      if (k === 0 || k === last) { bad.add(i); why('高速道路の上で道路を止めることはできません'); }
      const ax = axisOf(g.conn[i]);
      const myAxis = axisOfDir(dirAt(k));
      if ((myAxis === 0 && ax.ew > 0) || (myAxis === 1 && ax.ns > 0)) { bad.add(i); why('高速道路には直接つなげません。ランプを使ってください'); }
    } else if (isHighway(g.road[i])) {
      bad.add(i);
      why('高速道路には直接つなげません。ランプを使ってください');
    }
    if (L === 0 && g.rail[i]) {
      // 踏切：まっすぐな線路と直角に交わる場合だけ
      const ra = axisOf(g.rail[i]);
      const myAxis = axisOfDir(dirAt(k));
      const ok = ra.deg === 2 && ra.dg === 0 && ((myAxis === 0 && ra.ns === 2) || (myAxis === 1 && ra.ew === 2)) && !def.highway;
      if (!ok) { bad.add(i); why('線路とは、まっすぐな場所で直角にしか交差できません（踏切）'); }
    }
  }
  for (let k = 0; k < dirs.length; k++) {
    if (isDiag(dirs[k]) && levels[k] === levels[k + 1] && crossesDiagonal(g, cells[k], dirs[k], levels[k])) {
      bad.add(cells[k]);
      bad.add(cells[k + 1]);
      why('斜めの道路どうしは交差点なしで交差できません');
    }
  }

  // 上空の高さ
  const lift = def.elevated ? def.lift! : OVERPASS_LIFT;
  const grade1 = def.elevated ? 0.07 : 0.5;
  const u: number[] = cells.map((i, k) => {
    if (levels[k] !== 1) return 0;
    if (g.up[i] && g.upH[i] > 0) return g.upH[i];
    return Math.max(g.cellH(i % n, (i / n) | 0), WATER_LEVEL) + lift;
  });
  const ufix = cells.map((i, k) => levels[k] === 1 && g.up[i] !== 0);
  for (let pass = 0; pass < 2; pass++) {
    const ks = pass === 0 ? [...cells.keys()].slice(1) : [...cells.keys()].reverse().slice(1);
    for (const k of ks) {
      const p = pass === 0 ? k - 1 : k + 1;
      if (levels[k] !== 1 || levels[p] !== 1 || ufix[k]) continue;
      const m = grade1 * CELL * 1.42;
      // 高架は地面より低くならないようにする
      const floor = Math.max(g.cellH(cells[k] % n, (cells[k] / n) | 0), WATER_LEVEL) + lift * 0.7;
      u[k] = Math.max(floor, Math.max(u[p] - m, Math.min(u[p] + m, u[k])));
    }
  }
  for (let k = 0; k < cells.length; k++) if (levels[k] === 1) upHs.set(cells[k], u[k]);
  for (const c of converts) if (!upHs.has(c)) upHs.set(c, g.cellH(c % n, (c / n) | 0) + OVERPASS_LIFT);

  // 地上の部分：橋（水の上の連続したマス）
  const water = cells.map((i, k) => levels[k] === 0 && (g.isWater(i % n, (i / n) | 0) || g.deck[i] > 0));
  const t = cells.map((i) => g.roadH(i));
  const fixed = cells.map((i, k) => levels[k] === 1 || g.road[i] !== 0);
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

  // 地上の部分：勾配の調整
  const segLen = (k: number) => (isDiag(dirs[k]) ? CELL * 1.414 : CELL);
  for (let k = 1; k < t.length; k++) {
    if (fixed[k] || levels[k - 1] === 1) continue;
    const m = MAX_ROAD_GRADE * segLen(k - 1);
    t[k] = Math.max(t[k - 1] - m, Math.min(t[k - 1] + m, t[k]));
  }
  for (let k = t.length - 2; k >= 0; k--) {
    if (fixed[k] || levels[k + 1] === 1) continue;
    const m = MAX_ROAD_GRADE * segLen(k);
    t[k] = Math.max(t[k + 1] - m, Math.min(t[k + 1] + m, t[k]));
  }
  for (let k = 1; k < t.length; k++) {
    if (levels[k] === 1 || levels[k - 1] === 1) continue;
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

// 2つのマスを、それぞれの階層でつなぐ
function link(g: Grid, a: number, la: number, b: number, lb: number, d: number, oneWay: boolean) {
  const ca = la ? g.conn1 : g.conn, fa = la ? g.flow1 : g.flow;
  const cb = lb ? g.conn1 : g.conn, fb = lb ? g.flow1 : g.flow;
  ca[a] |= 1 << d;
  cb[b] |= 1 << opp(d);
  fa[a] |= 1 << d;
  if (oneWay) fb[b] &= ~(1 << opp(d));
  else fb[b] |= 1 << opp(d);
}

export function applyRoad(g: Grid, plan: RoadPlan) {
  const def = ROADS[plan.type];
  for (const [vi, h] of plan.vertexH) g.heights[vi] = h;
  for (const [c, h] of plan.deck) g.deck[c] = h;
  // 既存の道路を上空へ移す（地上の高速道路をまたぐ立体交差）
  for (const c of plan.converts) {
    g.up[c] = g.road[c];
    g.conn1[c] = g.conn[c];
    g.flow1[c] = g.flow[c];
    g.upH[c] = plan.upH.get(c)!;
    g.road[c] = 0;
    g.conn[c] = 0;
    g.flow[c] = 0;
  }
  for (const lane of plan.lanes) {
    const { cells, dirs, levels } = lane;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      if (levels[k] === 1) {
        const cur = g.up[i];
        if (!cur || ROADS[cur].rank < def.rank) g.up[i] = plan.type;
        g.upH[i] = plan.upH.get(i) ?? g.upH[i];
      } else {
        const cur = g.road[i];
        if (!cur || ROADS[cur].rank < def.rank) g.road[i] = plan.type;
      }
      if (!def.elevated || levels[k] === 0) {
        g.zone[i] = 0;
        g.zden[i] = 0;
      }
      g.tree[i] = 0;
    }
    for (let k = 0; k < dirs.length; k++) link(g, cells[k], levels[k], cells[k + 1], levels[k + 1], dirs[k], lane.oneWay);
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

// ---- ランプ（高速道路の出入口） ----
export interface RampPlan {
  ok: boolean;
  reason: string;
  cell: number;
  level: number;
  hb: number; // ランプへ降りる高速道路のマス
  ha: number; // ランプから合流する高速道路のマス
  dOut: number; // hb → ランプ
  dIn: number; // ランプ → ha
  roads: number[]; // ランプとつなぐ一般の道路（地上）
  cost: number;
  h: number;
}

// 高速道路のマスの、そのマスでの進行方向
function laneDir(g: Grid, c: number, level: number): number {
  const f = level ? g.flow1[c] : g.flow[c];
  for (const d of [0, 2, 4, 6]) if (f & (1 << d)) return d;
  return -1;
}

export function planRamp(g: Grid, x: number, y: number): RampPlan {
  const fail = (reason: string): RampPlan => ({ ok: false, reason, cell: -1, level: 0, hb: -1, ha: -1, dOut: 0, dIn: 0, roads: [], cost: RAMP_COST, h: 0 });
  if (!g.inb(x, y)) return fail('マップの外です');
  const r = g.idx(x, y);
  if (g.road[r] || g.up[r] || g.bldg[r]) return fail('空いているマスに置いてください');
  if (g.isWater(x, y)) return fail('水の上には置けません');
  for (const s of [0, 2, 4, 6]) {
    const hx = x + DX[s], hy = y + DY[s];
    if (!g.inb(hx, hy)) continue;
    const h = g.idx(hx, hy);
    const level = g.up[h] === RoadType.Highway ? 1 : g.road[h] === RoadType.GroundHighway ? 0 : -1;
    if (level < 0) continue;
    const f = laneDir(g, h, level);
    if (f < 0 || f === s || f === opp(s)) continue;
    const bx = hx - DX[f], by = hy - DY[f], ax = hx + DX[f], ay = hy + DY[f];
    if (!g.inb(bx, by) || !g.inb(ax, ay)) continue;
    const hb = g.idx(bx, by), ha = g.idx(ax, ay);
    const same = (c: number) => (level ? g.up[c] === RoadType.Highway : g.road[c] === RoadType.GroundHighway);
    if (!same(hb) || !same(ha)) continue;
    const dOut = dirOf(x - bx, y - by), dIn = dirOf(ax - x, ay - y);
    if (dOut < 0 || dIn < 0) continue;
    if (crossesDiagonal(g, hb, dOut, level) || crossesDiagonal(g, r, dIn, level)) return fail('近くの斜めの道路と交差します');
    const roads: number[] = [];
    for (const d of [0, 2, 4, 6]) {
      if (d === s) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (!g.inb(nx, ny)) continue;
      const j = g.idx(nx, ny);
      const t = g.road[j];
      if (t && !isHighway(t) && t !== RoadType.Ramp) roads.push(j);
    }
    const hh = level ? (g.upH[h] + g.cellH(x, y)) / 2 : g.cellH(x, y);
    return { ok: true, reason: '', cell: r, level, hb, ha, dOut, dIn, roads, cost: RAMP_COST, h: hh };
  }
  return fail('高速道路の横に置いてください');
}

export function applyRamp(g: Grid, p: RampPlan) {
  const n = g.n;
  const r = p.cell;
  if (p.level) {
    g.up[r] = RoadType.Ramp;
    g.upH[r] = p.h;
  } else g.road[r] = RoadType.Ramp;
  g.zone[r] = 0;
  g.zden[r] = 0;
  g.tree[r] = 0;
  link(g, p.hb, p.level, r, p.level, p.dOut, true);
  link(g, r, p.level, p.ha, p.level, p.dIn, true);
  for (const j of p.roads) {
    const d = dirOf((j % n) - (r % n), ((j / n) | 0) - ((r / n) | 0));
    link(g, r, p.level, j, 0, d, false);
  }
}

// ---- ダイヤモンド型インターチェンジ ----
// 高速道路のマスをタップすると、その場所で一般道が高速道路と立体交差し、4本のランプでつながる。
// ランプは高速道路から斜めに3マス離れたあと並走し、一般道とのT字路につながる。
//
//   出口：本線 c-7f → 斜め → 斜め → 斜め → 並走 3マス → 一般道（c+3o）
//   入口：一般道（c+3o）→ 並走 3マス → 斜め → 斜め → 本線 c+6f
//   （f = 車線の進む向き、o = 車線の外側の向き）
export interface RampChain {
  cells: number[];
  dirs: number[];
  levels: number[];
  heights: number[]; // 上空のマスの路面の高さ
}

export interface DiamondPlan {
  ok: boolean;
  reason: string;
  cost: number;
  road: RoadPlan | null;
  chains: RampChain[];
  cells: number[];
  bad: Set<number>;
}

const DIAMOND_OUT = 3; // ランプが高速道路から離れるマス数
const DIAMOND_LEN = 7; // 出口ランプが本線から分かれる位置（交差点からのマス数）
const RAMP_CELL_COST = 80;

export function planDiamond(g: Grid, x: number, y: number): DiamondPlan {
  const bad = new Set<number>();
  const fail = (reason: string, cells: number[] = []): DiamondPlan => ({ ok: false, reason, cost: 0, road: null, chains: [], cells, bad });
  if (!g.inb(x, y)) return fail('マップの外です');
  const n = g.n;
  const c = g.idx(x, y);
  const level = g.up[c] === RoadType.Highway ? 1 : g.road[c] === RoadType.GroundHighway ? 0 : -1;
  if (level < 0) return fail('高速道路の上をタップしてください');
  const f = laneDir(g, c, level);
  if (f < 0) return fail('縦か横にまっすぐな高速道路の上に置いてください');
  // 反対車線を探す
  let side = -1;
  for (const s of [(f + 2) & 7, (f + 6) & 7]) {
    const ox = x + DX[s], oy = y + DY[s];
    if (!g.inb(ox, oy)) continue;
    const o = g.idx(ox, oy);
    const lv = level ? g.up[o] === RoadType.Highway : g.road[o] === RoadType.GroundHighway;
    if (lv && laneDir(g, o, level) === opp(f)) side = s;
  }
  if (side < 0) return fail('高速道路の向きがわかりません');
  const isLane = (cx: number, cy: number, dir: number) => {
    if (!g.inb(cx, cy)) return false;
    const i = g.idx(cx, cy);
    const ok = level ? g.up[i] === RoadType.Highway : g.road[i] === RoadType.GroundHighway;
    return ok && laneDir(g, i, level) === dir;
  };
  const D = DIAMOND_OUT, K = DIAMOND_LEN;
  const lanes: { x: number; y: number; f: number; o: number }[] = [
    { x, y, f, o: opp(side) },
    { x: x + DX[side], y: y + DY[side], f: opp(f), o: side },
  ];
  // 本線が、インターチェンジの範囲でまっすぐ続いているか
  for (const L of lanes) {
    for (let k = -K; k <= K; k++) {
      if (!isLane(L.x + DX[L.f] * k, L.y + DY[L.f] * k, L.f)) return fail('高速道路がインターチェンジの範囲（前後7マス）でまっすぐ続いていません');
    }
  }
  // 交差する一般道：ランプの並走部分より2マス外まで
  const so = opp(side);
  const x0 = x + DX[so] * (D + 2), y0 = y + DY[so] * (D + 2);
  const x1 = x + DX[side] * (D + 3), y1 = y + DY[side] * (D + 3);
  if (!g.inb(x0, y0) || !g.inb(x1, y1)) return fail('マップの端に近すぎます');
  const path = planLine(g, x0, y0, x1, y1);
  const road = planRoad(g, path, RoadType.Road);
  const cells = [...path.cells];
  if (!road.ok) {
    for (const b of road.bad) bad.add(b);
    return { ...fail(road.reason || '一般道を通せません', cells), road };
  }
  // ランプの道筋
  const chains: RampChain[] = [];
  let rampCells = 0;
  for (const L of lanes) {
    const at = (k: number, out: number): [number, number] => [L.x + DX[L.f] * k + DX[L.o] * out, L.y + DY[L.f] * k + DY[L.o] * out];
    // 出口：本線（-K）→ 斜めに D マス → 並走 → 一般道（0, D）
    const exitPts: [number, number][] = [at(-K, 0)];
    for (let k = 1; k <= D; k++) exitPts.push(at(-K + k, k));
    for (let k = -K + D + 1; k <= 0; k++) exitPts.push(at(k, D));
    // 入口：一般道（0, D）→ 並走 → 斜めに戻る → 本線
    const entryPts: [number, number][] = [];
    const parEnd = K - 1 - D; // 並走の最後
    for (let k = 0; k <= parEnd; k++) entryPts.push(at(k, D));
    for (let k = 1; k <= D; k++) entryPts.push(at(parEnd + k, D - k));
    for (const pts of [exitPts, entryPts]) {
      const cs = pts.map(([px, py]) => g.idx(px, py));
      const dirs: number[] = [];
      for (let k = 0; k + 1 < pts.length; k++) dirs.push(dirOf(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]));
      const isExit = pts === exitPts;
      // 階層：本線のマスは本線の階層、一般道のマスは地上、ランプは高架なら上空
      const levels = cs.map((ci, k) => {
        const onLane = isExit ? k === 0 : k === cs.length - 1;
        const onRoad = isExit ? k === cs.length - 1 : k === 0;
        if (onLane) return level;
        if (onRoad) return 0;
        return level;
      });
      // 高架の場合、ランプは本線の高さから地面へ少しずつ下がる
      const heights = cs.map((ci, k) => {
        if (!level) return 0;
        const tFromLane = isExit ? k / (cs.length - 1) : 1 - k / (cs.length - 1);
        const hw = g.upH[isExit ? cs[0] : cs[cs.length - 1]];
        const ground = g.cellH(ci % n, (ci / n) | 0);
        return lerpH(hw, ground + 0.6, tFromLane);
      });
      // ランプのマスが空いているか
      for (let k = 0; k < cs.length; k++) {
        const ci = cs[k];
        const onLane = isExit ? k === 0 : k === cs.length - 1;
        const onRoad = isExit ? k === cs.length - 1 : k === 0;
        if (onLane) continue;
        if (onRoad) {
          if (!path.cells.includes(ci)) { bad.add(ci); }
          continue;
        }
        const cx2 = ci % n, cy2 = (ci / n) | 0;
        rampCells++;
        if (g.bldg[ci]) { bad.add(ci); }
        else if (level === 0 && (g.road[ci] || g.isWater(cx2, cy2))) bad.add(ci);
        else if (level === 1 && (g.up[ci] || (k > 0 && g.road[ci] && levels[k] === 0))) bad.add(ci);
        cells.push(ci);
      }
      for (let k = 0; k < dirs.length; k++) {
        if (isDiag(dirs[k]) && crossesDiagonal(g, cs[k], dirs[k], levels[k])) bad.add(cs[k]);
      }
      chains.push({ cells: cs, dirs, levels, heights });
    }
  }
  if (bad.size) return { ok: false, reason: 'ランプを通す場所に、建物や道路、水があります', cost: 0, road, chains, cells, bad };
  const cost = road.cost + rampCells * RAMP_CELL_COST + 1500;
  return { ok: true, reason: '', cost, road, chains, cells, bad };
}

const lerpH = (a: number, b: number, t: number) => a + (b - a) * t;

export function applyDiamond(g: Grid, p: DiamondPlan) {
  if (!p.road) return;
  applyRoad(g, p.road);
  for (const ch of p.chains) {
    const last = ch.cells.length - 1;
    ch.cells.forEach((ci, k) => {
      if (k === 0 || k === last) return; // 本線と一般道のマスはそのまま
      if (ch.levels[k]) {
        g.up[ci] = RoadType.Ramp;
        g.upH[ci] = ch.heights[k];
      } else g.road[ci] = RoadType.Ramp;
      g.zone[ci] = 0;
      g.zden[ci] = 0;
      g.tree[ci] = 0;
    });
    for (let k = 0; k < ch.dirs.length; k++) link(g, ch.cells[k], ch.levels[k], ch.cells[k + 1], ch.levels[k + 1], ch.dirs[k], true);
  }
}

// ---- クローバー型インターチェンジ ----
// 地上の高速道路と高架の高速道路が交差する場所に置く。8方向の乗り換えを、
// 右折は外側の直結ランプ、左折は内側のループ（270°）でつなぐ。
// ランプの道筋は、周りの空いているマスから、45°より急に曲がらない最短の道を探して決める。
export interface CloverPlan {
  ok: boolean;
  reason: string;
  cost: number;
  chains: RampChain[];
  cells: number[];
  bad: Set<number>;
}

const CLOVER_R = 11; // 使う範囲（交差点から何マスまで）

interface HwLane {
  x: number; // 交差点のマス（この車線上）
  y: number;
  f: number; // 進む向き
  o: number; // 外側（反対車線と逆）の向き
  level: number;
  lo: number; // 相手の高速道路と重なる位置（f 方向に、x,y からのマス数）
  hi: number;
}

export function planCloverleaf(g: Grid, x: number, y: number): CloverPlan {
  const n = g.n;
  const bad = new Set<number>();
  const fail = (reason: string): CloverPlan => ({ ok: false, reason, cost: 0, chains: [], cells: [], bad });
  if (!g.inb(x, y)) return fail('マップの外です');
  const c = g.idx(x, y);
  if (g.road[c] !== RoadType.GroundHighway || g.up[c] !== RoadType.Highway)
    return fail('地上の高速道路と高架の高速道路が交差している場所をタップしてください');
  const f0 = laneDir(g, c, 0), f1 = laneDir(g, c, 1);
  if (f0 < 0 || f1 < 0 || (f0 & 3) === (f1 & 3)) return fail('縦と横にまっすぐ交差している場所に置いてください');
  // それぞれの高速道路の反対車線
  const partner = (level: number, f: number): number => {
    for (const s of [(f + 2) & 7, (f + 6) & 7]) {
      const ox = x + DX[s], oy = y + DY[s];
      if (!g.inb(ox, oy)) continue;
      const o = g.idx(ox, oy);
      const ok = level ? g.up[o] === RoadType.Highway : g.road[o] === RoadType.GroundHighway;
      if (ok && laneDir(g, o, level) === opp(f)) return s;
    }
    return -1;
  };
  const s0 = partner(0, f0), s1 = partner(1, f1);
  if (s0 < 0 || s1 < 0) return fail('高速道路の向きがわかりません');
  // 相手の高速道路の2車線と重なる位置（f 方向の位置）
  const span = (f: number, sOther: number) => {
    const d = DX[f] * DX[sOther] + DY[f] * DY[sOther];
    return [Math.min(0, d), Math.max(0, d)];
  };
  const lanes: HwLane[] = [];
  for (const [level, f, s, sOther] of [[0, f0, s0, s1], [1, f1, s1, s0]] as const) {
    const [lo, hi] = span(f, sOther);
    lanes.push({ x, y, f, o: opp(s), level, lo, hi });
    const [lo2, hi2] = span(opp(f), sOther);
    lanes.push({ x: x + DX[s], y: y + DY[s], f: opp(f), o: s, level, lo: lo2, hi: hi2 });
  }
  const R = CLOVER_R;
  const isLane = (L: HwLane, k: number) => {
    const px = L.x + DX[L.f] * k, py = L.y + DY[L.f] * k;
    if (!g.inb(px, py)) return false;
    const i = g.idx(px, py);
    const ok = L.level ? g.up[i] === RoadType.Highway : g.road[i] === RoadType.GroundHighway;
    return ok && laneDir(g, i, L.level) === L.f;
  };
  for (const L of lanes) for (let k = -R; k <= R; k++) if (!isLane(L, k)) return fail(`高速道路が交差点の前後 ${R} マスでまっすぐ続いていません`);

  // 空いているマス（ランプに使える）
  const used = new Set<number>();
  const free = (px: number, py: number) => {
    if (!g.inb(px, py) || Math.abs(px - x) > R + 1 || Math.abs(py - y) > R + 1) return false;
    const i = g.idx(px, py);
    if (used.has(i) || g.bldg[i] || g.road[i] || g.up[i] || g.isWater(px, py)) return false;
    return true;
  };
  const cellOf = (L: HwLane, k: number, out: number): [number, number] => [L.x + DX[L.f] * k + DX[L.o] * out, L.y + DY[L.f] * k + DY[L.o] * out];

  // 向きつきの最短経路（向きの変化は1回に45°まで）
  const route = (sx: number, sy: number, sd: number, tx: number, ty: number, td: number): number[] | null => {
    if (!free(sx, sy) || !free(tx, ty)) return null;
    const key = (px: number, py: number, d: number) => (py * n + px) * 8 + d;
    const dist = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap: [number, number][] = [];
    const push = (k: number, v: number) => {
      heap.push([v, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          let m = i;
          const l = 2 * i + 1, r = l + 1;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    const k0 = key(sx, sy, sd);
    dist.set(k0, 0);
    push(k0, 0);
    while (heap.length) {
      const [dcur, k] = pop();
      if (dcur > (dist.get(k) ?? Infinity)) continue;
      const d = k & 7, ci = k >> 3, px = ci % n, py = (ci / n) | 0;
      if (px === tx && py === ty && ((d - td + 8) & 7) <= 1 || (px === tx && py === ty && ((td - d + 8) & 7) <= 1)) {
        // 道筋を戻る
        const cells: number[] = [];
        let cur: number | undefined = k;
        while (cur !== undefined) {
          cells.push(cur >> 3);
          cur = prev.get(cur);
        }
        return cells.reverse();
      }
      for (const nd of [(d + 7) & 7, d, (d + 1) & 7]) {
        const nx = px + DX[nd], ny = py + DY[nd];
        if (!free(nx, ny)) continue;
        // 斜めに進むときは、隣の2マスの間をすり抜けないようにする
        if (isDiag(nd) && !free(px + DX[nd], py) && !free(px, py + DY[nd])) continue;
        const nk = key(nx, ny, nd);
        const nv = dcur + (isDiag(nd) ? 1.414 : 1) + (nd !== d ? 0.35 : 0);
        if (nv < (dist.get(nk) ?? Infinity) && nv < 80) {
          dist.set(nk, nv);
          prev.set(nk, k);
          push(nk, nv);
        }
      }
    }
    return null;
  };

  const chains: RampChain[] = [];
  const allCells: number[] = [];
  // 左折（ループ）を先に、内側に通す。その外側を右折のランプが回る
  const moves: { X: HwLane; Y: HwLane; left: boolean }[] = [];
  for (const X of lanes)
    for (const Y of lanes) {
      if (X.level === Y.level) continue;
      if (Y.f === ((X.f + 2) & 7)) moves.push({ X, Y, left: false });
      if (Y.f === ((X.f + 6) & 7)) moves.push({ X, Y, left: true });
    }
  moves.sort((a, b) => Number(b.left) - Number(a.left));
  for (const { X, Y, left } of moves) {
    // 右折：交差点の手前で分かれ、交差点の先で合流する。左折：交差点を過ぎてから分かれ、ループして手前で合流する
    const kx = left ? X.hi + 2 : X.lo - 6;
    const ky = left ? Y.lo - 2 : Y.hi + 6;
    const dOut = dirOf(DX[X.f] + DX[X.o], DY[X.f] + DY[X.o]);
    const dIn = dirOf(DX[Y.f] - DX[Y.o], DY[Y.f] - DY[Y.o]);
    const [sx, sy] = cellOf(X, kx + 1, 1);
    const [tx, ty] = cellOf(Y, ky - 1, 1);
    const path = route(sx, sy, dOut, tx, ty, dIn);
    if (!path) {
      for (const [px, py] of [[sx, sy], [tx, ty]]) if (g.inb(px, py)) bad.add(g.idx(px, py));
      return { ...fail(left ? '左折のループを通す広さがありません' : '右折のランプを通す広さがありません'), bad, cells: allCells };
    }
    for (const i of path) used.add(i);
    // 本線のマス → ランプ → 本線のマス
    const [ax, ay] = cellOf(X, kx, 0), [bx, by] = cellOf(Y, ky, 0);
    const cells = [g.idx(ax, ay), ...path, g.idx(bx, by)];
    const dirs: number[] = [];
    for (let k = 0; k + 1 < cells.length; k++) {
      const d = dirOf((cells[k + 1] % n) - (cells[k] % n), ((cells[k + 1] / n) | 0) - ((cells[k] / n) | 0));
      if (d < 0) return fail('ランプの道筋が作れません');
      dirs.push(d);
    }
    // 高さ：高架の側から地上の側へ少しずつ変える。ランプのマスは上空の階層に置く
    const hA = X.level ? g.upH[cells[0]] : g.roadH(cells[0]);
    const hB = Y.level ? g.upH[cells[cells.length - 1]] : g.roadH(cells[cells.length - 1]);
    const levels = cells.map((_, k) => (k === 0 ? X.level : k === cells.length - 1 ? Y.level : 1));
    const heights = cells.map((ci, k) => {
      const t = k / (cells.length - 1);
      const ground = g.cellH(ci % n, (ci / n) | 0);
      return Math.max(ground + 0.6, lerpH(hA, hB, t));
    });
    chains.push({ cells, dirs, levels, heights });
    allCells.push(...path);
  }
  const cost = allCells.length * RAMP_CELL_COST * 1.5 + 6000;
  return { ok: true, reason: '', cost: Math.round(cost), chains, cells: allCells, bad };
}

export function applyCloverleaf(g: Grid, p: CloverPlan) {
  for (const ch of p.chains) {
    const last = ch.cells.length - 1;
    ch.cells.forEach((ci, k) => {
      if (k === 0 || k === last) return;
      g.up[ci] = RoadType.Ramp;
      g.upH[ci] = ch.heights[k];
      g.zone[ci] = 0;
      g.zden[ci] = 0;
      g.tree[ci] = 0;
    });
    for (let k = 0; k < ch.dirs.length; k++) link(g, ch.cells[k], ch.levels[k], ch.cells[k + 1], ch.levels[k + 1], ch.dirs[k], true);
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
      if (g.road[i] || g.bldg[i] || g.isWater(x, y) || steep || hasSurfaceLine(g, i)) {
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
  transit: number[];
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
  const roads: number[] = [], lines: number[] = [], trees: number[] = [], cells: number[] = [], transit: number[] = [];
  const bset = new Set<number>();
  let cost = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = g.idx(x, y);
      cells.push(i);
      if (g.road[i] || g.up[i]) { roads.push(i); cost += g.up[i] && isHighway(g.up[i]) ? 20 : 5; }
      if (g.pline[i]) { lines.push(i); cost += 1; }
      if (g.rail[i] || g.erail[i] || g.mono[i] || g.sub[i]) { transit.push(i); cost += 10; }
      if (g.bldg[i]) bset.add(g.bldg[i]);
      else if (g.tree[i]) { trees.push(i); cost += 1; }
    }
  }
  for (const id of bset) {
    const b = bInfo(id);
    if (b) cost += b.civic ? 50 * b.w * b.h : 15 * b.w * b.h;
  }
  return { roads, lines, buildings: [...bset], trees, cost, cells, transit };
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
      if (hasSurfaceLine(g, i)) reason = reason || '線路があります';
      if (g.isWater(xx, yy)) reason = reason || '水の上には置けません';
      lo = Math.min(lo, g.cellMinH(xx, yy));
      hi = Math.max(hi, g.cellMaxH(xx, yy));
      sum += g.cellH(xx, yy);
    }
  }
  if (hi - lo > 10) reason = reason || '地面の傾きが大きすぎます';
  // 駅・停留所は、線路と道路に接している必要がある
  if (!reason && def.transit) {
    const around: number[] = [];
    for (let yy = y - 1; yy <= y + def.h; yy++)
      for (let xx = x - 1; xx <= x + def.w; xx++) if (g.inb(xx, yy) && !(xx >= x && xx < x + def.w && yy >= y && yy < y + def.h)) around.push(g.idx(xx, yy));
    const localRoad = (i: number) => g.road[i] !== 0 && !isHighway(g.road[i]) && g.road[i] !== RoadType.Ramp;
    if (!around.some(localRoad)) reason = '道路に接するように置いてください';
    else if (def.transit !== 'bus') {
      const mask = g[def.transit];
      const near = def.transit === 'sub' ? [...around, ...cells] : around;
      if (!near.some((i) => mask[i])) reason = `${LINES[def.transit].name}の線路に接するように置いてください`;
    }
  }
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

// 立体交差（地上の高速道路をまたぐ一般道）の前後の道路を、少しずつ持ち上げて坂をゆるやかにする
export function regradeApproaches(g: Grid) {
  const n = g.n;
  g.lift.fill(0);
  for (let c = 0; c < n * n; c++) {
    const u = g.up[c];
    if (!u || isHighway(u) || u === RoadType.Ramp) continue;
    const H = g.upH[c];
    const x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      if (!(g.conn1[c] & (1 << d))) continue;
      const j = (y + DY[d]) * n + (x + DX[d]);
      if (!g.inb(x + DX[d], y + DY[d]) || g.arriveLevel(1, j, d) === 1) continue;
      // まっすぐ続いている地上の道路のマスを、最大3マスまで探す
      const run: number[] = [];
      for (let k = 1; k <= 3; k++) {
        const ax = x + DX[d] * k, ay = y + DY[d] * k;
        if (!g.inb(ax, ay)) break;
        const a = ay * n + ax;
        const straight = (1 << d) | (1 << opp(d));
        if (!g.road[a] || g.up[a] || g.deck[a] > 0) break;
        if (k === 1 ? (g.conn[a] & ~straight) !== 0 : g.conn[a] !== straight) break;
        run.push(a);
      }
      run.forEach((a, k) => {
        const frac = 1 - (k + 1) / (run.length + 1);
        const rise = (H - g.cellH(a % n, (a / n) | 0)) * frac;
        if (rise > g.lift[a]) g.lift[a] = rise;
      });
    }
  }
}

// ---- 公共交通の線路 ----
// 地上を通る線路（地上の鉄道・高架鉄道・モノレール）があるか。地下鉄は地上に影響しない
export function hasSurfaceLine(g: Grid, i: number) {
  return g.rail[i] !== 0 || g.erail[i] !== 0 || g.mono[i] !== 0;
}

export interface TransitPlan {
  ok: boolean;
  kind: LineKind;
  path: LinePath;
  cost: number;
  bad: Set<number>;
  reason: string;
}

export function planTransitLine(g: Grid, path: LinePath, kind: LineKind): TransitPlan {
  const def = LINES[kind];
  const n = g.n;
  const bad = new Set<number>();
  let reason = '';
  const why = (r: string) => { reason = reason || r; };
  const mask = g[kind];
  let cost = 0;
  const { cells, dirs } = path;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const x = i % n, y = (i / n) | 0;
    const d = dirs[Math.min(k, dirs.length - 1)] ?? 0;
    const len = k > 0 && isDiag(dirs[k - 1]) ? 1.41 : 1;
    if (!mask[i]) cost += def.cost * len;
    if (kind === 'sub') continue;
    if (g.bldg[i]) { bad.add(i); why('建物があります。先に取り壊してください'); }
    if (kind === 'rail') {
      if (g.isWater(x, y)) { bad.add(i); why('地上の線路は水の上に引けません（高架鉄道を使ってください）'); }
      if (g.up[i] && !isHighway(g.up[i])) { bad.add(i); why('立体交差の道路があります'); }
      const r = g.road[i];
      if (r) {
        // 踏切：まっすぐな道路と直角に交わる場合だけ
        const ax = axisOf(g.conn[i]);
        const ok = !isHighway(r) && r !== RoadType.Ramp && ax.deg === 2 && ax.dg === 0 && !isDiag(d) && ((d === 0 || d === 4) ? ax.ns === 2 : ax.ew === 2);
        if (!ok) { bad.add(i); why('道路とは、まっすぐな場所で直角にしか交差できません（踏切）'); }
      }
    } else {
      // 高架：上空の道路とは重ねられない
      if (g.up[i]) { bad.add(i); why('高架の道路と重なっています'); }
      // 高架鉄道（8m）とモノレール（11m）は高さが違うので交差できる。ただし同じ向きに重ねて引くことはできない
      const other = kind === 'erail' ? g.mono : g.erail;
      if (other[i] && (other[i] & ((1 << d) | (1 << opp(d))))) { bad.add(i); why('ほかの高架の線路と重なっています'); }
    }
  }
  for (let k = 0; k < dirs.length; k++) {
    const d = dirs[k];
    if (!isDiag(d)) continue;
    const i = cells[k];
    const x = i % n, y = (i / n) | 0;
    const ax = x + DX[d], ay = y, bx = x, by = y + DY[d];
    if (!g.inb(ax, ay) || !g.inb(bx, by)) continue;
    const dd = dirOf(bx - ax, by - ay);
    if (mask[ay * n + ax] & (1 << dd)) { bad.add(i); why('斜めの線路どうしは交差できません'); }
  }
  return { ok: bad.size === 0 && cells.length > 1, kind, path, cost: Math.round(cost), bad, reason };
}

export function applyTransitLine(g: Grid, p: TransitPlan) {
  const mask = g[p.kind];
  const { cells, dirs } = p.path;
  for (let k = 0; k < dirs.length; k++) {
    mask[cells[k]] |= 1 << dirs[k];
    mask[cells[k + 1]] |= 1 << opp(dirs[k]);
  }
  if (p.kind !== 'sub') for (const i of cells) {
    g.tree[i] = 0;
    if (!g.road[i]) { g.zone[i] = 0; g.zden[i] = 0; }
  }
}

export function removeTransitAt(g: Grid, i: number) {
  const n = g.n;
  const x = i % n, y = (i / n) | 0;
  for (const kind of ['rail', 'erail', 'mono', 'sub'] as const) {
    const mask = g[kind];
    for (let d = 0; d < 8; d++) {
      if (!(mask[i] & (1 << d))) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (g.inb(nx, ny)) mask[ny * n + nx] &= ~(1 << opp(d));
    }
    mask[i] = 0;
  }
}

// ---- バス停（道路に重ねて置く） ----
export interface BusStopPlan {
  ok: boolean;
  cell: number;
  remove: boolean; // すでにあるバス停を外す
  reason: string;
  cost: number;
}
export function planBusStop(g: Grid, x: number, y: number): BusStopPlan {
  const fail = (reason: string): BusStopPlan => ({ ok: false, cell: -1, remove: false, reason, cost: 0 });
  if (!g.inb(x, y)) return fail('マップの外です');
  const i = g.idx(x, y);
  if (g.bstop[i]) return { ok: true, cell: i, remove: true, reason: '', cost: 0 };
  const t = g.road[i];
  if (!t || isHighway(t) || t === RoadType.Ramp) return fail('一般の道路の上に置いてください');
  return { ok: true, cell: i, remove: false, reason: '', cost: BUS_STOP_COST };
}
