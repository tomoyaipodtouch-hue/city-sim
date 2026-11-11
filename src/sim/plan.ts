// ツールの計画（プレビューと実行の両方で使う）
import { Grid } from './grid';
import { DX, DY, MAX_ROAD_GRADE, CELL, WATER_LEVEL, QUAY_LAND, dirOf, isDiag, opp } from './constants';
import { ROADS, RoadType, ZoneType, ZONE_COST, POWER_LINE_COST, CIVIC, CivicId, BRIDGE_COST_MUL, MAX_BRIDGE, OVERPASS_LIFT, RAMP_COST, isHighway, isGroundHighway, isUrbanElevated, isUrbanGround, LINES, LineKind, BUS_STOP_COST, ESTOP_COST } from './defs';

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
  joins?: Set<number>; // 高速道路の端で、一般の道路に直接つなぐマス（道路の種類は変えない）
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
  centre?: [number, number][]; // 大通りの中心線（格子点の折れ線）。プレビュー用
  unlinks?: [number, number][]; // 取り除く既存の折り返し（from → to）。大通りの続きを引いたとき
  // 大通りの横の両方向の道路を、近い車線と反対車線の両方につなぐ（T字と同じ）。[道路のマス, 近い車線, 反対車線, 道路 → 車線の向き]
  sideJoins?: [number, number, number, number][];
  // 大通りの外側の横に向いている、ほかの大通りの行き止まりの端を、2本の車線へつなぐ（T字と同じ）。[端の X, 端の Y, 端の向き a]（AvenueEnd）
  stemJoins?: [number, number, number][];
  startKind?: string; // 大通りの端のつなぎ方（'avenue' 続き、'tee' T字、'road' 道路）。プレビューの説明用
  endKind?: string;
  noop?: boolean; // 何も変わらない（すでに同じ大通りがある）。失敗ではないので、プレビューは灰色で見せて、指を離しても何もしない
  note?: string; // プレビューに書き添える注意（引くのは止めない）
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

// 進行方向の左側にある、並行するマスへのずれ（2マス幅の高速道路の反対車線）
function leftOffset(d: number): [number, number] {
  if (!isDiag(d)) return [DY[d], -DX[d]];
  return [0, -DX[d]];
}

// 2マス幅の高速道路：引いたマスを右側の車線とし、左側に反対車線を作る（大通りは planAvenue で、なぞった線を中心線にする）
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

const degreeOf = (m: number) => { let k = 0; for (let d = 0; d < 8; d++) if (m & (1 << d)) k++; return k; };

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
  return finishRoadPlan(g, path, lanes, type, bad, reasons, uturns);
}

// 車線が決まったあとの計画（費用、階層、橋、勾配、地形）。pairDeck = 大通りの2本の車線で共通の橋の高さ。
// 橋の高さは岸の道路の高さから決めるが、坂をならしたあとの岸の道路が橋より高くなったときは（斜めの橋の急な岸など）、
// 橋をその高さまで上げて計画し直す（橋と岸の間に段ができたり、岸の地面が床版を突きぬけたりしないように）
function finishRoadPlan(
  g: Grid, path: LinePath, lanes: Lane[], type: RoadType, bad: Set<number>, reasons: string[], uturns: [number, number][],
  pairDeck?: Map<number, number>, extra?: Partial<RoadPlan>,
): RoadPlan {
  const bad0 = new Set(bad), reasons0 = [...reasons];
  let plan = finishRoadPlanOnce(g, path, lanes, type, bad, reasons, uturns, pairDeck, extra);
  if (!plan.ok || !plan.deck.size) return plan;
  // 橋を上げると岸の坂のならし方も変わるので、高さが落ち着くまで（3回まで）
  for (let k = 0; k < 3; k++) {
    const raised = raiseDecks(g, plan);
    if (!raised) break;
    const fresh = lanes.map((l) => ({ cells: l.cells, dirs: l.dirs, oneWay: l.oneWay, levels: [] }));
    const again = finishRoadPlanOnce(g, path, fresh, type, new Set(bad0), [...reasons0], uturns, raised, extra);
    if (!again.ok) break;
    plan = again;
  }
  return plan;
}

// 橋（つながった床版のマス）ごとに、岸の道路の頂点（橋のマスと岸のマスの両方の角）の、ならしたあとの高さを調べる。
// 橋より 0.3m 以上高ければ、その橋を岸の高さまで上げた高さの表を返す（上げなくてよければ null）。すでにある橋は変えない
function raiseDecks(g: Grid, plan: RoadPlan): Map<number, number> | null {
  const n = g.n, V = n + 1;
  const deck = plan.deck;
  const laneCells = new Set(plan.lanes.flatMap((l) => l.cells.filter((_, k) => l.levels[k] === 0)));
  const corners = (c: number) => {
    const x = c % n, y = (c / n) | 0;
    return [y * V + x, y * V + x + 1, (y + 1) * V + x, (y + 1) * V + x + 1];
  };
  // 岸の道路のマスの角
  const shore = new Set<number>();
  for (const c of laneCells) if (!deck.has(c)) for (const v of corners(c)) shore.add(v);
  const out = new Map(deck);
  const seen = new Set<number>();
  let changed = false;
  for (const [c0, h0] of deck) {
    if (seen.has(c0)) continue;
    const comp = [c0];
    seen.add(c0);
    for (let q = 0; q < comp.length; q++)
      for (let d = 0; d < 8; d++) {
        const j = nb(g, comp[q], d);
        if (j >= 0 && deck.has(j) && !seen.has(j)) { seen.add(j); comp.push(j); }
      }
    if (comp.some((c) => g.deck[c] > 0)) continue;
    let top = -Infinity;
    for (const c of comp) for (const v of corners(c)) if (shore.has(v)) top = Math.max(top, plan.vertexH.get(v) ?? g.heights[v]);
    // 上げすぎない（大きな段は、ほかの理由。反対の岸の坂がきつくなりすぎる）
    if (top > h0 + 0.3 && top < h0 + 6) {
      for (const c of comp) out.set(c, top);
      changed = true;
    }
  }
  return changed ? out : null;
}

function finishRoadPlanOnce(
  g: Grid, path: LinePath, lanes: Lane[], type: RoadType, bad: Set<number>, reasons: string[], uturns: [number, number][],
  pairDeck?: Map<number, number>, extra?: Partial<RoadPlan>,
): RoadPlan {
  const why = (r: string) => reasons.push(r);
  let cost = 0;
  let bridgeCells = 0;
  const vacc = new Map<number, [number, number]>();
  const deck = new Map<number, number>();
  const upH = new Map<number, number>();
  const converts = new Set<number>();
  for (const lane of lanes) {
    const r = planLane(g, lane, type, bad, why, vacc, deck, upH, converts, pairDeck);
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
    converts: [...converts], uturns, reason: reasons[0] || '', bridgeCells, ...extra,
  };
}

function planLane(
  g: Grid, lane: Lane, type: RoadType, bad: Set<number>, why: (r: string) => void,
  vacc: Map<number, [number, number]>, deck: Map<number, number>, upHs: Map<number, number>, converts: Set<number>,
  pairDeck?: Map<number, number>,
): { cost: number; bridge: number } {
  const def = ROADS[type];
  const n = g.n, V = n + 1;
  const { cells, dirs } = lane;
  const last = cells.length - 1;
  const dirAt = (k: number) => dirs[Math.min(k, dirs.length - 1)] ?? 0;
  const axisOfDir = (d: number) => (d === 0 || d === 4 ? 0 : d === 2 || d === 6 ? 1 : 2);

  // 高速道路の端を、一般の道路（地上）に直接つなぐ場所
  const localRoad = (t: number) => t !== 0 && !isHighway(t) && t !== RoadType.Ramp;
  // 端のマスの一般道が、線に沿って隣のマス（線の内側）へ続いているときは、道路の上を並んで走っている（大通りの真上の高架など）。
  // 道路に突き当たって終わるのではないので、つながない（つなぐのはランプだけ）
  const runsAlong = (k: number) => last > 0 && (g.conn[cells[k]] & (1 << (k === 0 ? dirAt(0) : opp(dirAt(last - 1))))) !== 0;
  const joinsLocal = (k: number) =>
    def.highway && (k === 0 || k === last) && localRoad(g.road[cells[k]]) && !g.up[cells[k]] && g.deck[cells[k]] <= 0 && !runsAlong(k);
  // 階層を決める
  const levels = cells.map((i, k) => {
    const end = k === 0 || k === last;
    if (joinsLocal(k)) return 0;
    if (def.elevated) {
      // 高架の端が地上の高速道路に重なる場合は、地上に降りてつながる
      if (end && isGroundHighway(g.road[i]) && !g.up[i]) return 0;
      return 1;
    }
    if (def.highway) {
      if (end && (g.up[i] === RoadType.Highway || isUrbanElevated(g.up[i])) && !g.road[i]) return 1;
      return 0;
    }
    // 一般の道路
    if (isGroundHighway(g.road[i])) {
      // 高速道路の行き止まりの端なら、そこにつなぐ。それ以外は立体交差でまたぐ
      if (end && degreeOf(g.conn[i]) <= 1) return 0;
      return 1;
    }
    if (g.up[i] === RoadType.Ramp && !g.road[i] && !(g.jct[i] & 2)) return 1; // ジャンクションの高架のランプは、下をくぐる
    return 0;
  });
  lane.levels = levels;

  let cost = 0, bridge = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const L = levels[k];
    if (g.bldg[i]) { bad.add(i); why('建物があります。先に取り壊してください'); }
    if (L === 0 && g.jct[i] & 2 && g.upH[i] - g.cellH(i % n, (i / n) | 0) < 5) { bad.add(i); why('ジャンクションのランプが低く、下を通せません'); }
    const cur = L ? g.up[i] : g.road[i];
    const len = k > 0 && isDiag(dirs[k - 1]) ? 1.41 : 1;
    const isW = pairDeck ? pairDeck.has(i) : g.isWater(i % n, (i / n) | 0) || g.deck[i] > 0;
    const mul = isW && L === 0 ? BRIDGE_COST_MUL : 1;
    if (cur === 0) cost += def.cost * len * mul;
    else if (ROADS[cur].rank < def.rank) cost += Math.max(0, def.cost - ROADS[cur].cost) * len * mul;

    if (def.highway) {
      if (L === 0 && joinsLocal(k)) {
        lane.joins = lane.joins ?? new Set();
        lane.joins.add(i);
      } else if (L === 0) {
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
    } else if (isHighway(g.road[i]) && !((k === 0 || k === last) && degreeOf(g.conn[i]) <= 1)) {
      bad.add(i);
      why('高速道路には、行き止まりの端か、ランプでつないでください');
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
    // 地上の一般の道路どうしは、斜めのまま X 字に交差できる（マスの角が交差点になる）
    const localX = (c: number) => g.road[c] !== 0 && !isHighway(g.road[c]) && g.road[c] !== RoadType.Ramp && !(g.deck[c] > 0);
    const xOk = () => {
      if (levels[k] || levels[k + 1] || def.highway || def.wide) return false;
      const x = cells[k] % n, y = (cells[k] / n) | 0, d = dirs[k];
      const c1 = y * n + x + DX[d], c2 = (y + DY[d]) * n + x;
      return localX(c1) && localX(c2) && !ROADS[g.road[c1]].wide && !ROADS[g.road[c2]].wide;
    };
    if (isDiag(dirs[k]) && levels[k] === levels[k + 1] && crossesDiagonal(g, cells[k], dirs[k], levels[k]) && !xOk()) {
      bad.add(cells[k]);
      bad.add(cells[k + 1]);
      why('斜めの道路どうしは交差点なしで交差できません');
    }
  }

  // 上空の高さ
  const lift = def.elevated ? def.lift! : OVERPASS_LIFT;
  const grade1 = def.elevated ? 0.07 : 0.5;
  // 高さの基準の地面。高架が水の上を渡るときは、両岸の高さを結んだ高さにする（川の上だけ低くならないように。高架鉄道と同じ）
  const base = cells.map((i, k) => {
    const ground = Math.max(g.cellH(i % n, (i / n) | 0), WATER_LEVEL);
    if (!def.elevated || !g.isWater(i % n, (i / n) | 0)) return ground;
    const banks = pathBanks(g, cells, k);
    return banks === null ? ground : Math.max(ground, banks);
  });
  const u: number[] = cells.map((i, k) => {
    if (levels[k] !== 1) return 0;
    if (g.up[i] && g.upH[i] > 0) return g.upH[i];
    return base[k] + lift;
  });
  const ufix = cells.map((i, k) => levels[k] === 1 && g.up[i] !== 0);
  for (let pass = 0; pass < 2; pass++) {
    const ks = pass === 0 ? [...cells.keys()].slice(1) : [...cells.keys()].reverse().slice(1);
    for (const k of ks) {
      const p = pass === 0 ? k - 1 : k + 1;
      if (levels[k] !== 1 || levels[p] !== 1 || ufix[k]) continue;
      const m = grade1 * CELL * 1.42;
      // 高架は地面より低くならないようにする
      const floor = base[k] + lift * 0.7;
      u[k] = Math.max(floor, Math.max(u[p] - m, Math.min(u[p] + m, u[k])));
    }
  }
  // 高架が地上の道路に降りる端は、手前から少しずつ下げる（約 1.5m / マス）
  if (def.elevated) {
    const touch = cells.map((_, k) => k).filter((k) => (k === 0 || k === last) && levels[k] === 0);
    if (touch.length)
      for (let k = 0; k < cells.length; k++) {
        if (levels[k] !== 1 || ufix[k]) continue;
        const dmin = Math.min(...touch.map((t2) => Math.abs(k - t2)));
        const gh = Math.max(g.cellH(cells[k] % n, (cells[k] / n) | 0), WATER_LEVEL);
        u[k] = Math.min(u[k], gh + 0.3 + dmin * 1.5);
      }
    // 水の上は、両岸の路面を結んだ線より低くしない
    for (let k = 0; k < cells.length; k++) {
      if (levels[k] !== 1 || !g.isWater(cells[k] % n, (cells[k] / n) | 0)) continue;
      let e = k;
      while (e + 1 < cells.length && levels[e + 1] === 1 && g.isWater(cells[e + 1] % n, (cells[e + 1] / n) | 0)) e++;
      const a = k - 1, b = e + 1;
      if (a >= 0 && b < cells.length && levels[a] === 1 && levels[b] === 1)
        for (let j = k; j <= e; j++) if (!ufix[j]) u[j] = Math.max(u[j], u[a] + ((u[b] - u[a]) * (j - a)) / (b - a));
      k = e;
    }
  }
  for (let k = 0; k < cells.length; k++) if (levels[k] === 1) upHs.set(cells[k], u[k]);
  for (const c of converts) if (!upHs.has(c)) upHs.set(c, g.cellH(c % n, (c / n) | 0) + OVERPASS_LIFT);

  // 地上の部分：橋（水の上の連続したマス）。大通りは、2本の車線で決めた橋（pairDeck）を使う
  const water = cells.map((i, k) => levels[k] === 0 && (pairDeck ? pairDeck.has(i) : g.isWater(i % n, (i / n) | 0) || g.deck[i] > 0));
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
        const h = pairDeck?.get(c) ?? (g.deck[c] > 0 ? g.deck[c] : dh);
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

// 道に沿って水の上のマス k から両側の岸（最初の陸のマス）まで進み、岸の高さを距離で内分した値（岸がなければ null）
function pathBanks(g: Grid, cells: number[], k: number): number | null {
  const n = g.n;
  const ends: { h: number; d: number }[] = [];
  for (const s of [-1, 1]) {
    for (let j = k + s; j >= 0 && j < cells.length; j += s) {
      const x = cells[j] % n, y = (cells[j] / n) | 0;
      if (!g.isWater(x, y)) { ends.push({ h: g.cellH(x, y), d: Math.abs(j - k) }); break; }
    }
  }
  if (ends.length >= 2) return ends[0].h + (ends[1].h - ends[0].h) * (ends[0].d / (ends[0].d + ends[1].d));
  return ends.length === 1 ? ends[0].h : null;
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
  const avenue = plan.type === RoadType.Avenue;
  // 大通りの車線が通るマスのまわりにある、既存の大通りの行き止まりの端（あとで続きになったかを見る）
  const oldEnds: AvenueEnd[] = [];
  if (avenue) {
    const seen = new Set<number>();
    for (const lane of plan.lanes)
      for (const c of lane.cells)
        for (let d = -1; d < 8; d++) {
          const j = d < 0 ? c : nb(g, c, d);
          if (j < 0 || seen.has(j)) continue;
          seen.add(j);
          const e = avenueEndAt(g, j);
          if (e) oldEnds.push(e);
        }
  }
  for (const [a, b] of plan.unlinks ?? []) unlinkFlow(g, a, b);
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
        if ((!cur || ROADS[cur].rank < def.rank) && !lane.joins?.has(i) && cur !== RoadType.Ramp) g.road[i] = plan.type;
      }
      if (!def.elevated || levels[k] === 0) {
        g.zone[i] = 0;
        g.zden[i] = 0;
      }
      g.tree[i] = 0;
    }
    for (let k = 0; k < dirs.length; k++) link(g, cells[k], levels[k], cells[k + 1], levels[k + 1], dirs[k], lane.oneWay);
    // 道路を大通りにしたとき：最初のマスに残った逆向きの流れ（外の両方向の道路へ）を消す
    if (avenue && dirs.length && levels[0] === 0) {
      const b = nb(g, cells[0], opp(dirs[0]));
      if (b >= 0 && twoWayLocal(g.road[b])) g.flow[cells[0]] &= ~(1 << opp(dirs[0]));
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
  if (avenue) {
    // 今回引いた車線のつながり（これは消さない）
    const mine = new Set<number>();
    for (const l of plan.lanes) for (let k = 0; k < l.dirs.length; k++) mine.add(l.cells[k] * 8 + l.dirs[k]);
    // 横に向いている大通りの行き止まりの端を、近い車線と、分離帯をこえて遠い車線へつなぐ（端の折り返しは、すぐ下で外れる）
    for (const [X, Y, a] of plan.stemJoins ?? []) {
      const Xa = nb(g, X, a), Ya = nb(g, Y, a);
      link(g, X, 0, Xa, 0, a, true);
      link(g, Xa, 0, nb(g, Xa, a), 0, a, true);
      link(g, nb(g, Ya, a), 0, Ya, 0, opp(a), true);
      link(g, Ya, 0, Y, 0, opp(a), true);
    }
    // 古い端の先に大通りが続いたら、その端の折り返しを外す
    for (const e of oldEnds) {
      if (mine.has(e.X * 8 + e.p)) continue;
      const xa = nb(g, e.X, e.a), ya = nb(g, e.Y, e.a);
      const goes = xa >= 0 && g.road[xa] === RoadType.Avenue && (g.flow[e.X] & (1 << e.a)) !== 0;
      const comes = ya >= 0 && g.road[ya] === RoadType.Avenue && (g.flow[ya] & (1 << opp(e.a))) !== 0;
      if (goes || comes) unlinkFlow(g, e.X, e.Y);
    }
  }
  // 横の道路（道路をなぞって大通りにしたときの交わる道、大通りに突き当たっていた行き止まり）を、2本の車線につなぐ
  for (const [s, c, f, d] of plan.sideJoins ?? []) {
    link(g, s, 0, c, 0, d, false);
    link(g, c, 0, f, 0, d, false);
  }
  // 大通りの端に、両方向の道路が続く場合のつなぎ目
  linkAvenueEnds(g, plan.lanes.flatMap((l) => [l.cells[0], l.cells[l.cells.length - 1]]));
}

// a → b の流れを外す（逆向きの流れもなければ、つながりも外す）
function unlinkFlow(g: Grid, a: number, b: number) {
  const n = g.n;
  const d = dirOf((b % n) - (a % n), ((b / n) | 0) - ((a / n) | 0));
  if (d < 0) return;
  g.flow[a] &= ~(1 << d);
  if (!(g.flow[b] & (1 << opp(d)))) {
    g.conn[a] &= ~(1 << d);
    g.conn[b] &= ~(1 << opp(d));
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
      if (g.road[i] || g.bldg[i] || g.isWater(x, y) || steep || hasSurfaceLine(g, i) || g.quay[i] === 2) {
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

// 取り壊す階層。
//   ground（地上）：地上の道路（橋・地上のランプ・バス停・交差点の設定を含む）、地上の鉄道、建物、木、送電線
//   up（高架）：上空の道路（高架の高速道路・都市高速・立体交差の道路・高架のランプ・ジャンクションの上空のランプ）、高架鉄道（駅のホームも）、モノレール
//   sub（地下）：地下鉄の線路と、地下鉄の駅
//   all（すべて）：そのマスのものを全部
export type BulldozeLayer = 'ground' | 'up' | 'sub' | 'all';
export const BULLDOZE_LAYERS: BulldozeLayer[] = ['ground', 'up', 'sub', 'all'];
export const TRANSIT_LAYER: Record<'rail' | 'erail' | 'mono' | 'sub', BulldozeLayer> = { rail: 'ground', erail: 'up', mono: 'up', sub: 'sub' };

export interface BulldozePlan {
  layer: BulldozeLayer;
  transit: number[]; // 線路を外すマス（layer の階層の線路だけ）
  roads: number[]; // 道路を外すマス（layer の階層の道路だけ）
  lines: number[];
  buildings: number[];
  trees: number[];
  cost: number;
  cells: number[];
}

// 建物の階層：地下鉄の駅は地下（地上にあるのは入口だけ）、それ以外は地上
export const buildingLayer = (type: string | undefined): BulldozeLayer => (type === 'sub_station' ? 'sub' : 'ground');

export function planBulldoze(
  g: Grid,
  r: Rect,
  bInfo: (id: number) => { civic: boolean; w: number; h: number; type?: string } | undefined,
  layer: BulldozeLayer = 'ground',
): BulldozePlan {
  const roads: number[] = [], lines: number[] = [], trees: number[] = [], cells: number[] = [], transit: number[] = [];
  const bset = new Set<number>();
  const all = layer === 'all', ground = all || layer === 'ground', up = all || layer === 'up';
  const kinds = (['rail', 'erail', 'mono', 'sub'] as const).filter((k) => all || TRANSIT_LAYER[k] === layer);
  let cost = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = g.idx(x, y);
      cells.push(i);
      const gr = ground && g.road[i] !== 0, ur = up && g.up[i] !== 0;
      if (gr || ur) { roads.push(i); cost += ur && isHighway(g.up[i]) ? 20 : 5; }
      if (ground && g.pline[i]) { lines.push(i); cost += 1; }
      if (kinds.some((k) => g[k][i])) { transit.push(i); cost += 10; }
      const b = g.bldg[i];
      if (b) {
        if (all || buildingLayer(bInfo(b)?.type) === layer) bset.add(b);
      } else if (ground && g.tree[i]) { trees.push(i); cost += 1; }
    }
  }
  for (const id of bset) {
    const b = bInfo(id);
    if (b) cost += b.civic ? 50 * b.w * b.h : 15 * b.w * b.h;
  }
  return { layer, roads, lines, buildings: [...bset], trees, cost, cells, transit };
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
  w: number;
  h: number;
}
// 細長い公園などは、長い辺が道路に面する向きに自動で回す
export function planPlop(g: Grid, id: CivicId, cx: number, cy: number): PlopPlan {
  const def = CIVIC[id];
  const a = planPlopSized(g, id, cx, cy, def.w, def.h);
  if (!def.rotate || def.w === def.h) return a;
  const b = planPlopSized(g, id, cx, cy, def.h, def.w);
  if (a.ok !== b.ok) return a.ok ? a : b;
  const roads = (p: PlopPlan) => {
    let k = 0;
    for (let yy = p.y - 1; yy <= p.y + p.h; yy++)
      for (let xx = p.x - 1; xx <= p.x + p.w; xx++) {
        if (!g.inb(xx, yy) || (xx >= p.x && xx < p.x + p.w && yy >= p.y && yy < p.y + p.h)) continue;
        const t = g.road[g.idx(xx, yy)];
        if (t && !isHighway(t)) k++;
      }
    return k;
  };
  return roads(b) > roads(a) ? b : a;
}
function planPlopSized(g: Grid, id: CivicId, cx: number, cy: number, W: number, H: number): PlopPlan {
  const def = { ...CIVIC[id], w: W, h: H };
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
      if (g.quay[i] === 2) reason = reason || '遊歩道があります';
      lo = Math.min(lo, g.cellMinH(xx, yy));
      hi = Math.max(hi, g.cellMaxH(xx, yy));
      sum += g.cellH(xx, yy);
    }
  }
  // 水辺の施設は川岸の斜面に置くことが多いので、より傾いた土地でも造成して置ける
  if (hi - lo > (def.waterfront ? 22 : def.airport ? 26 : 10)) reason = reason || '地面の傾きが大きすぎます';
  // 駅・停留所・フェリー乗り場・港・貨物駅は、線路や水辺、道路に接している必要がある
  if (!reason && (def.transit || def.waterfront || def.freightRail || def.airport)) {
    const around: number[] = [];
    for (let yy = y - 1; yy <= y + def.h; yy++)
      for (let xx = x - 1; xx <= x + def.w; xx++) if (g.inb(xx, yy) && !(xx >= x && xx < x + def.w && yy >= y && yy < y + def.h)) around.push(g.idx(xx, yy));
    const localRoad = (i: number) => g.road[i] !== 0 && !isHighway(g.road[i]) && g.road[i] !== RoadType.Ramp;
    if (!around.some(localRoad)) reason = '道路に接するように置いてください';
    else if (def.waterfront && !around.some((i) => g.isWater(i % g.n, (i / g.n) | 0))) reason = '水辺に置いてください';
    else if (def.freightRail && !around.some((i) => g.rail[i])) reason = '鉄道の線路に接するように置いてください';
    else if (def.transit && def.transit !== 'bus') {
      const mask = g[def.transit];
      const near = def.transit === 'sub' ? [...around, ...cells] : around;
      if (!near.some((i) => mask[i])) reason = `${LINES[def.transit].name}の線路に接するように置いてください`;
    }
  }
  const flatH = sum / cells.length;
  const cost = def.cost + Math.round((hi - lo) * def.w * def.h * 2);
  return { ok: !reason, id, x, y, cells, cost, reason, flatH, w: W, h: H };
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
  // 上空のマス c から向き d へ、上空の道路が終わる（地上へ降りる）か
  const endAt = (c: number, d: number) => {
    const x = c % n, y = (c / n) | 0;
    if (!(g.conn1[c] & (1 << d)) || !g.inb(x + DX[d], y + DY[d])) return false;
    return g.arriveLevel(1, (y + DY[d]) * n + x + DX[d], d) !== 1;
  };
  // まっすぐ続いている地上の道路のマスを、最大3マスまで探す
  const runOf = (c: number, d: number) => {
    const x = c % n, y = (c / n) | 0;
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
    return run;
  };
  for (let c = 0; c < n * n; c++) {
    const u = g.up[c];
    if (!u || isHighway(u) || u === RoadType.Ramp) continue;
    const H = g.upH[c];
    const x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      if (!endAt(c, d)) continue;
      const run = runOf(c, d);
      // 坂の割合（k 番目のマス）：ふつうは上空のマスから地面まで、マスごとに同じだけ下げる
      let frac = (k: number) => 1 - (k + 1) / (run.length + 1);
      if (u === RoadType.Avenue && isDiag(d)) {
        // 斜めの大通り：2本の車線は道に沿って半マス（約 11m）ずれている。反対車線の坂と、道に沿った同じ位置で同じ高さになるよう、
        // 2本の車線の坂の始まりと終わりの平均を通る1本の坂にする（位置は半マスの長さを 1 とした、上空のマスの中心からの距離）
        for (const e of [(d + 1) & 7, (d + 7) & 7, (d + 3) & 7, (d + 5) & 7]) {
          const tx = x + DX[e], ty = y + DY[e];
          if (!g.inb(tx, ty)) continue;
          const c2 = ty * n + tx;
          if (g.up[c2] !== RoadType.Avenue || !endAt(c2, d)) continue;
          const s = DX[e] * DX[d] + DY[e] * DY[d]; // 反対車線の上空のマスが、向き d へ ±1 ずれている
          const run2 = runOf(c2, d);
          const u0 = s / 2, ug = (2 * (run.length + 1) + s + 2 * (run2.length + 1)) / 2;
          frac = (k: number) => Math.max(0, Math.min(1, (ug - 2 * (k + 1)) / (ug - u0)));
          break;
        }
      }
      run.forEach((a, k) => {
        const rise = (H - g.cellH(a % n, (a / n) | 0)) * frac(k);
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

export function removeTransitAt(g: Grid, i: number, layer: BulldozeLayer = 'all') {
  const n = g.n;
  const x = i % n, y = (i / n) | 0;
  for (const kind of ['rail', 'erail', 'mono', 'sub'] as const) {
    if (layer !== 'all' && TRANSIT_LAYER[kind] !== layer) continue;
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

// ---- 水域 ----
// 水のマスをつながりごとに番号をつける（-1 = 陸）。edge は、マップの端に届いている水域の番号
export function labelWater(g: Grid): { label: Int32Array; edge: Set<number> } {
  const n = g.n;
  const label = new Int32Array(n * n).fill(-1);
  const edge = new Set<number>();
  let id = 0;
  const q: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (label[i] >= 0 || !g.isWater(i % n, (i / n) | 0)) continue;
    label[i] = id;
    q.push(i);
    while (q.length) {
      const c = q.pop()!;
      const x = c % n, y = (c / n) | 0;
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1) edge.add(id);
      for (let d = 0; d < 8; d += 2) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!g.inb(nx, ny)) continue;
        const j = ny * n + nx;
        if (label[j] >= 0 || !g.isWater(nx, ny)) continue;
        label[j] = id;
        q.push(j);
      }
    }
    id++;
  }
  return { label, edge };
}

// 地上の鉄道・高架鉄道のうち、マップの端までつながっているマス
export function railReachEdge(g: Grid): Uint8Array {
  const n = g.n;
  const reach = new Uint8Array(n * n);
  const q: number[] = [];
  for (let i = 0; i < n * n; i++) {
    const x = i % n, y = (i / n) | 0;
    if ((x === 0 || y === 0 || x === n - 1 || y === n - 1) && (g.rail[i] || g.erail[i])) {
      reach[i] = 1;
      q.push(i);
    }
  }
  while (q.length) {
    const c = q.pop()!;
    const x = c % n, y = (c / n) | 0;
    const m = g.rail[c] | g.erail[c];
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (!g.inb(nx, ny)) continue;
      const j = ny * n + nx;
      if (!reach[j]) { reach[j] = 1; q.push(j); }
    }
  }
  return reach;
}

// ---------------- 地形の編集 ----------------
export type TerrainOp = 'raise' | 'lower' | 'level';
export const TERRAIN_STEP = 3; // 1回で上げ下げする高さ（m）
export const TERRAIN_MIN = -24, TERRAIN_MAX = 160;
const TERRAIN_COST = 2; // 頂点 1つを 1m 動かす費用（円）

export interface TerrainPlan {
  changes: Map<number, number>; // 頂点の番号 → 新しい高さ
  cells: number[]; // 変わるマス（表示用）
  locked: number[]; // 道路や建物があって動かせないマス
  cost: number;
}

// 道路・線路・建物のあるマスに接する頂点は動かさない
function vertexLocked(g: Grid, vx: number, vy: number) {
  for (const [cx, cy] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]]) {
    if (!g.inb(cx, cy)) continue;
    const i = g.idx(cx, cy);
    if (g.road[i] || g.up[i] || g.bldg[i] || g.rail[i] || g.erail[i] || g.mono[i] || g.pline[i]) return true;
  }
  return false;
}

// 範囲の頂点を上げる・下げる（まわり 2 頂点はなだらかにする）、または始点の高さにそろえる
export function planTerrain(g: Grid, op: TerrainOp, sx: number, sy: number, ex: number, ey: number): TerrainPlan {
  const r = normRect(sx, sy, ex, ey, g.n);
  const V = g.n + 1;
  const changes = new Map<number, number>();
  const target = g.cellH(Math.max(0, Math.min(g.n - 1, sx)), Math.max(0, Math.min(g.n - 1, sy)));
  const ring = op === 'level' ? 0 : 2;
  for (let vy = r.y0 - ring; vy <= r.y1 + 1 + ring; vy++)
    for (let vx = r.x0 - ring; vx <= r.x1 + 1 + ring; vx++) {
      if (vx < 0 || vy < 0 || vx > g.n || vy > g.n) continue;
      if (vertexLocked(g, vx, vy)) continue;
      const h = g.vh(vx, vy);
      let nh: number;
      if (op === 'level') nh = target;
      else {
        // 範囲からの距離（頂点の数）で、上げ下げの量を弱める
        const dx = Math.max(r.x0 - vx, vx - (r.x1 + 1), 0), dy = Math.max(r.y0 - vy, vy - (r.y1 + 1), 0);
        const k = 1 - Math.max(dx, dy) / (ring + 1);
        nh = h + (op === 'raise' ? 1 : -1) * TERRAIN_STEP * k;
      }
      nh = Math.max(TERRAIN_MIN, Math.min(TERRAIN_MAX, nh));
      if (Math.abs(nh - h) > 0.01) changes.set(vy * V + vx, nh);
    }
  let cost = 0;
  for (const [v, nh] of changes) cost += Math.abs(nh - g.heights[v]) * TERRAIN_COST;
  const cells: number[] = [], locked: number[] = [];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) {
      const i = g.idx(x, y);
      if (g.road[i] || g.up[i] || g.bldg[i] || g.rail[i] || g.erail[i] || g.mono[i] || g.pline[i]) locked.push(i);
      else cells.push(i);
    }
  return { changes, cells, locked, cost: Math.round(cost) };
}

export function applyTerrain(g: Grid, plan: TerrainPlan) {
  const V = g.n + 1;
  const touched = new Set<number>();
  for (const [v, nh] of plan.changes) {
    g.heights[v] = nh;
    const vx = v % V, vy = (v / V) | 0;
    for (const [cx, cy] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]]) if (g.inb(cx, cy)) touched.add(g.idx(cx, cy));
  }
  // 水に沈んだマスのゾーンと木はなくなる
  for (const i of touched) {
    const x = i % g.n, y = (i / g.n) | 0;
    if (g.isWater(x, y)) {
      g.zone[i] = 0;
      g.zden[i] = 0;
      g.tree[i] = 0;
    }
  }
  refreshQuay(g);
}

// ---------------- 埋め立てと岸壁 ----------------
// 四角く囲んだ範囲の水を埋め立てて平らな陸（QUAY_LAND）にし、水に面した陸のマスを岸壁にする。
// style 1 = コンクリートの岸壁、2 = 親水護岸・遊歩道。範囲の中の今の水際も岸壁になる
export const RECLAIM_COST = 400; // 埋め立て 1 マス
export const QUAY_COST = [0, 150, 300]; // 岸壁 1 マス（種類ごと）
export interface ReclaimPlan {
  fill: number[]; // 埋め立てるマス
  quay: number[]; // 岸壁になるマス
  changes: Map<number, number>; // 頂点 → 新しい高さ
  cost: number;
}
const occupied = (g: Grid, i: number) => !!(g.road[i] || g.up[i] || g.bldg[i] || g.rail[i] || g.erail[i] || g.mono[i] || g.pline[i]);
export function planReclaim(g: Grid, style: number, sx: number, sy: number, ex: number, ey: number): ReclaimPlan {
  const r = normRect(sx, sy, ex, ey, g.n);
  const n = g.n, V = n + 1;
  const changes = new Map<number, number>();
  const hAt = (vx: number, vy: number) => changes.get(vy * V + vx) ?? g.vh(vx, vy);
  const raise = (x: number, y: number) => {
    for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
      if (vertexLocked(g, vx, vy)) continue;
      if (g.vh(vx, vy) < QUAY_LAND) changes.set(vy * V + vx, QUAY_LAND);
    }
  };
  const fill: number[] = [];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) {
      const i = y * n + x;
      if (!g.isWater(x, y) || occupied(g, i)) continue;
      fill.push(i);
      raise(x, y);
    }
  // 埋め立てたあとに陸になっているか
  const landAfter = (x: number, y: number) => {
    if (!g.inb(x, y)) return false;
    return Math.min(hAt(x, y), hAt(x + 1, y), hAt(x, y + 1), hAt(x + 1, y + 1)) >= WATER_LEVEL + 0.3;
  };
  // 範囲の中で、埋め立てたあとも水に面している陸のマスが岸壁（平らにそろえる）
  const quay: number[] = [];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) {
      const i = y * n + x;
      if (!landAfter(x, y)) continue;
      let wet = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (g.inb(x + dx, y + dy) && !landAfter(x + dx, y + dy)) wet = true;
      if (!wet || g.quay[i] === style) continue;
      if (g.bldg[i]) continue;
      quay.push(i);
      raise(x, y);
    }
  const realFill = fill.filter((i) => landAfter(i % n, (i / n) | 0));
  const cost = realFill.length * RECLAIM_COST + quay.length * (QUAY_COST[style] ?? 0);
  return { fill: realFill, quay, changes, cost };
}
export function applyReclaim(g: Grid, plan: ReclaimPlan, style: number) {
  for (const [v, h] of plan.changes) g.heights[v] = h;
  for (const i of plan.fill) { g.tree[i] = 0; g.zone[i] = 0; g.zden[i] = 0; }
  for (const i of plan.quay) {
    g.quay[i] = style;
    // 遊歩道にはゾーンを置かない
    if (style === 2) { g.zone[i] = 0; g.zden[i] = 0; g.tree[i] = 0; }
  }
  refreshQuay(g);
}
// 水に面していない岸壁（埋め立てを広げた、地形を変えた）の印を消す
export function refreshQuay(g: Grid) {
  const n = g.n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!g.quay[i]) continue;
      if (g.isWater(x, y)) { g.quay[i] = 0; continue; }
      let wet = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (g.inb(x + dx, y + dy) && g.isWater(x + dx, y + dy)) wet = true;
      if (!wet) g.quay[i] = 0;
    }
}

// ---------------- 道路の始点・終点の自動補正 ----------------
// 少しずれた場所をタップしても、近くの道路の端（大通りは正しい車線）につながるように直す
export function snapRoadEnds(g: Grid, type: RoadType, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  if (x0 === x1 && y0 === y1) return [x0, y0, x1, y1];
  const n = g.n;
  const def = ROADS[type];
  // ドラッグの向き（8方向）
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const dd = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  const degree = (c: number) => { let k = 0; for (let d = 0; d < 8; d++) if (g.conn[c] & (1 << d)) k++; return k; };
  const pick = (x: number, y: number, score: (c: number) => number) => {
    let best = -1, bx = x, by = y;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const cx = x + ox, cy = y + oy;
        if (!g.inb(cx, cy)) continue;
        const c = cy * n + cx;
        const s = score(c) - (ox || oy ? 0.5 : 0); // 同じくらいなら、タップしたマスを優先
        if (s > best) { best = s; bx = cx; by = cy; }
      }
    return best > 0 ? [bx, by] : [x, y];
  };
  const back = (c: number, d: number) => {
    const x = (c % n) - DX[d], y = ((c / n) | 0) - DY[d];
    return g.inb(x, y) ? y * n + x : -1;
  };
  const ahead = (c: number, d: number) => {
    const x = (c % n) + DX[d], y = ((c / n) | 0) + DY[d];
    return g.inb(x, y) ? y * n + x : -1;
  };
  if (def.wide) {
    // 2マス幅の高速道路：始点は「ドラッグの向きに流れてきて、そこで終わる車線」、
    // 終点は「ドラッグの向きに流れ出していく車線」に合わせる
    const s = pick(x0, y0, (c) => {
      if (g.road[c] !== type) return 0;
      const b = back(c, dd);
      const inflow = b >= 0 && g.road[b] === type && (g.flow[b] & (1 << dd)) !== 0;
      const a = ahead(c, dd);
      const continues = a >= 0 && g.road[a] === type && (g.flow[c] & (1 << dd)) !== 0;
      return inflow && !continues ? 3 : inflow ? 1 : 0;
    });
    const e = pick(x1, y1, (c) => {
      if (g.road[c] !== type) return 0;
      const a = ahead(c, dd);
      const outflow = a >= 0 && g.road[a] === type && (g.flow[c] & (1 << dd)) !== 0;
      const b = back(c, dd);
      const fed = b >= 0 && g.road[b] === type && (g.flow[b] & (1 << dd)) !== 0;
      return outflow && !fed ? 3 : outflow ? 1 : 0;
    });
    return [s[0], s[1], e[0], e[1]];
  }
  // ふつうの道路：大通りに突き当てるときは、向こう側の車線まで延ばす（手前の車線や、3マス手前で止めても）
  const tee = (x: number, y: number, u: number): [number, number] | null => {
    if (isDiag(u) || def.highway || def.wide || type === RoadType.Ramp) return null;
    for (let t = 0; t <= 3; t++) {
      const cx = x + DX[u] * t, cy = y + DY[u] * t;
      if (!g.inb(cx, cy)) return null;
      const c = cy * n + cx;
      if (!g.road[c]) continue;
      if (g.road[c] !== RoadType.Avenue || g.up[c]) return null;
      // c は手前の車線、その先が反対向きの車線（大通りは2マス幅）
      const f = ahead(c, u);
      if (f < 0 || g.road[f] !== RoadType.Avenue) return null;
      const beyond = ahead(f, u);
      if (beyond >= 0 && g.road[beyond] === RoadType.Avenue) return null;
      for (const m of [(u + 2) & 7, (u + 6) & 7])
        if (g.flow[c] & (1 << m) && g.flow[f] & (1 << opp(m)) && !(g.flow[c] & (1 << opp(m)))) return [f % n, (f / n) | 0];
      return null;
    }
    return null;
  };
  const ts = tee(x0, y0, opp(dd)), te = tee(x1, y1, dd);
  // タップしたマスが道路でなければ、すぐ隣の道路の端（行き止まり）につなぐ
  const endScore = (c: number) => (g.road[c] && !isHighway(g.road[c]) && g.road[c] !== RoadType.Ramp && degree(c) <= 1 ? 2 : 0);
  const s = ts ?? (g.road[y0 * n + x0] ? [x0, y0] : pick(x0, y0, endScore));
  const e = te ?? (g.road[y1 * n + x1] ? [x1, y1] : pick(x1, y1, endScore));
  return [s[0], s[1], e[0], e[1]];
}

// ---------------- 大通りの行き止まりの端 ----------------
const nb = (g: Grid, c: number, d: number) => {
  const x = (c % g.n) + DX[d], y = ((c / g.n) | 0) + DY[d];
  return g.inb(x, y) ? y * g.n + x : -1;
};
// 両方向に通れる一般の道路（細い道・道路）
const twoWayLocal = (t: number) => t !== 0 && !!ROADS[t] && !ROADS[t].wide && !ROADS[t].oneWay && !isHighway(t) && t !== RoadType.Ramp;

// マス c に、allow 以外のマスから流れ込んでいないか
function onlyFrom(g: Grid, c: number, allow: number[]) {
  for (let d = 0; d < 8; d++) {
    const j = nb(g, c, opp(d));
    if (j < 0 || !g.road[j] || !(g.flow[j] & (1 << d))) continue;
    if (!allow.includes(j)) return false;
  }
  return true;
}

// 大通りの行き止まりの端（折り返しのある端）
export interface AvenueEnd {
  X: number; // 端に着く車線のマス（ここで折り返す）
  Y: number; // 端から出ていく車線のマス（X の隣）
  a: number; // X の車線の進む向き（端の外向き）
  p: number; // 折り返しの向き（X → Y）
}

// マス X が大通りの行き止まりの端なら、その端を返す。交差点や、続いている車線は端ではない
export function avenueEndAt(g: Grid, X: number): AvenueEnd | null {
  if (X < 0 || g.road[X] !== RoadType.Avenue) return null;
  const fx = g.flow[X];
  for (const p of [0, 2, 4, 6]) {
    if (!(fx & (1 << p))) continue;
    const Y = nb(g, X, p);
    if (Y < 0 || g.road[Y] !== RoadType.Avenue) continue;
    // 反対車線は進む向きの左側（右側通行）。斜めの車線では、折り返しは斜め45°ずれる
    for (const a of [(p + 2) & 7, (p + 1) & 7, (p + 3) & 7]) {
      const B = nb(g, X, opp(a));
      if (B < 0 || !g.road[B] || !(g.flow[B] & (1 << a))) continue;
      if (!(g.flow[Y] & (1 << opp(a)))) continue;
      const Yn = nb(g, Y, opp(a));
      if (Yn < 0 || !g.road[Yn]) continue;
      const Xa = nb(g, X, a), Ya = nb(g, Y, a);
      if (Xa >= 0 && g.road[Xa] === RoadType.Avenue && fx & (1 << a)) continue; // 先へ続いている
      if (fx & ~((1 << p) | (1 << a)) || g.flow[Y] & ~((1 << opp(a)) | (1 << a))) continue; // ほかの向きへも出ていく
      if (!onlyFrom(g, X, [B, Xa]) || !onlyFrom(g, Y, [X, Ya])) continue; // ほかから入ってくる（交差点）
      return { X, Y, a, p };
    }
  }
  return null;
}

// 端の中心線の格子点（斜めの車線では、2つの候補）
function avenueEndPoints(g: Grid, e: AvenueEnd): Pt[] {
  const n = g.n;
  const mx = ((e.X % n) + (e.Y % n)) / 2 + 0.5, my = (((e.X / n) | 0) + ((e.Y / n) | 0)) / 2 + 0.5;
  const ax = mx + DX[e.a] * 0.5, ay = my + DY[e.a] * 0.5;
  if (!isDiag(e.a)) return [[Math.round(ax), Math.round(ay)]];
  return [[ax + DX[e.p] * 0.5, ay + DY[e.p] * 0.5], [ax - DX[e.p] * 0.5, ay - DY[e.p] * 0.5]];
}

// ---------------- 大通りの端と、両方向の道路のつなぎ目 ----------------
// 大通りの行き止まりの端の先に、両方向に通れる道路があれば、折り返しをやめて道路につなぐ：
//   ・同じ列の道路へ：出ていく車線 → 道路（まっすぐ）、道路 → 入ってくる車線（斜め）
//   ・横切る道路へ：両方の車線を、それぞれ前の道路のマスにつなぐ（T字路）
// dry = true なら何も変えずに、つなぐところがあるかだけを返す
export function linkAvenueEnds(g: Grid, around: Iterable<number>, dry = false): boolean {
  const n = g.n;
  const seen = new Set<number>();
  const ok = (R: number) => R >= 0 && twoWayLocal(g.road[R]) && !g.up[R] && !(g.deck[R] > 0);
  const dir = (a: number, b: number) => dirOf((b % n) - (a % n), ((b / n) | 0) - ((a / n) | 0));
  for (const c0 of around)
    for (let oy = -2; oy <= 2; oy++)
      for (let ox = -2; ox <= 2; ox++) {
        const x = (c0 % n) + ox, y = ((c0 / n) | 0) + oy;
        if (!g.inb(x, y)) continue;
        const X = y * n + x;
        if (seen.has(X)) continue;
        seen.add(X);
        const e = avenueEndAt(g, X);
        if (!e || isDiag(e.a)) continue;
        const { Y, a } = e;
        const R1 = nb(g, X, a), R2 = nb(g, Y, a);
        const r1 = ok(R1), r2 = ok(R2);
        if (!r1 && !r2) continue;
        if (dry) return true;
        unlinkFlow(g, X, Y);
        if (r1) link(g, X, 0, R1, 0, a, true);
        if (r2) link(g, R2, 0, Y, 0, opp(a), true);
        if (r1 && !r2) link(g, R1, 0, Y, 0, dir(R1, Y), true);
        if (r2 && !r1) link(g, X, 0, R2, 0, dir(X, R2), true);
      }
  return false;
}

// ---------------- 大通り（指でなぞった線 = 中央分離帯） ----------------
// 座標は格子点（マスの角）。格子点 (x, y) は、マス (x, y) の北西の角。
// 東西の線 y：北側の行 y-1 が西向き、南側の行 y が東向き。南北の線 x：西側の列 x-1 が南向き、東側の列 x が北向き。
// どちらもドラッグの向きによらない（右側通行：進む向きの右側の車線を走る）。
// 斜めの部分は、隣の直線の車線をそのまま斜めにずらして続ける（直線がなければ、西の端に東西の直線があるとみなす）。
type Pt = [number, number];

// 1回のドラッグの折れ線（planLine と同じ順：直線の方が長ければ直線→斜め、そうでなければ斜め→直線）
export function avenuePolyline(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const dx = x1 - x0, dy = y1 - y0, ad = Math.abs(dx), bd = Math.abs(dy);
  const diag = Math.min(ad, bd), straight = Math.max(ad, bd) - diag;
  if (!diag || !straight) return [[x0, y0], [x1, y1]];
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const f: Pt = straight >= diag ? (ad > bd ? [sx * straight, 0] : [0, sy * straight]) : [sx * diag, sy * diag];
  return [[x0, y0], [x0 + f[0], y0 + f[1]], [x1, y1]];
}
const segDir = (a: Pt, b: Pt) => dirOf(Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1]));

// 中心線の1区間ぶんの車線のマス。f = 進む向きの車線、b = 反対車線（f と同じ並び）
interface AvSeg { d: number; f: number[]; b: number[] }
// 既存の大通りの端につなぐときの、つなぎ先のマス（f = 行きの車線の隣、b = 帰りの車線の隣。どちらも行きの並び）
interface AvAnchor { f: number; b: number; d: number }

function avenueSegs(g: Grid, pts: Pt[], sA: AvAnchor | null, eA: AvAnchor | null): AvSeg[] | null {
  const n = g.n;
  const at = (x: number, y: number) => (g.inb(x, y) ? y * n + x : -1);
  const segs: (AvSeg | null)[] = [];
  const geo = pts.slice(0, -1).map((a, s) => {
    const b = pts[s + 1];
    const ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1]);
    return { a, b, ux, uy, L: Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])), d: dirOf(ux, uy) };
  });
  // 直線：線の右側が行き、左側が帰り
  for (const s of geo) {
    if (isDiag(s.d)) { segs.push(null); continue; }
    const rx = -s.uy, ry = s.ux;
    const f: number[] = [], b: number[] = [];
    for (let k = 0; k < s.L; k++) {
      const px = s.a[0] + s.ux * (k + 0.5), py = s.a[1] + s.uy * (k + 0.5);
      const fc = at(Math.floor(px + rx * 0.5), Math.floor(py + ry * 0.5)), bc = at(Math.floor(px - rx * 0.5), Math.floor(py - ry * 0.5));
      if (fc < 0 || bc < 0) return null;
      f.push(fc);
      b.push(bc);
    }
    segs.push({ d: s.d, f, b });
  }
  // 斜め：前（なければ後ろ）の直線の車線のマスから、斜めにずらして続ける
  const xy = (c: number): Pt => [c % n, (c / n) | 0];
  for (let s = 0; s < geo.length; s++) {
    if (segs[s]) continue;
    const { a, b, ux, uy, L, d } = geo[s];
    const prev = s > 0 ? segs[s - 1] : null, next = s + 1 < segs.length ? segs[s + 1] : null;
    let F: Pt, B: Pt, fromPrev: boolean;
    if (prev) { F = xy(prev.f[prev.f.length - 1]); B = xy(prev.b[prev.b.length - 1]); fromPrev = true; }
    else if (sA) { F = xy(sA.f); B = xy(sA.b); fromPrev = true; }
    else if (next) { F = xy(next.f[0]); B = xy(next.b[0]); fromPrev = false; }
    else if (eA) { F = xy(eA.f); B = xy(eA.b); fromPrev = false; }
    else if (ux > 0) { F = [a[0] - 1, a[1]]; B = [a[0] - 1, a[1] - 1]; fromPrev = true; } // 西の端に東向きの直線があるとみなす
    else { F = [b[0] - 1, b[1] - 1]; B = [b[0] - 1, b[1]]; fromPrev = false; } // 西の端に西向きの直線が続くとみなす
    const f: number[] = [], bb: number[] = [];
    for (let k = 0; k < L; k++) {
      const m = fromPrev ? k + 1 : k - L;
      const fc = at(F[0] + ux * m, F[1] + uy * m), bc = at(B[0] + ux * m, B[1] + uy * m);
      if (fc < 0 || bc < 0) return null;
      f.push(fc);
      bb.push(bc);
    }
    segs[s] = { d, f, b: bb };
  }
  return segs as AvSeg[];
}

// 車線の部分をつなぐ。同じマスは1つにし、直角に曲がるところは外側の角のマスを入れ、1マスあいていれば間を埋める
function stitchLane(g: Grid, pieces: { cells: number[]; d: number }[], fwd: boolean): number[] | null {
  const n = g.n;
  const out: number[] = [];
  let prevD = -1;
  for (const pc of pieces) {
    if (!pc.cells.length) continue;
    let cells = pc.cells;
    if (out.length) {
      const P = out[out.length - 1], Q = cells[0];
      const px = P % n, py = (P / n) | 0, qx = Q % n, qy = (Q / n) | 0;
      const dist = Math.max(Math.abs(qx - px), Math.abs(qy - py));
      if (dist === 0) cells = cells.slice(1);
      else if (dist === 1) {
        if (qx !== px && qy !== py && !isDiag(prevD) && !isDiag(pc.d) && prevD !== pc.d) {
          // 直角の曲がり角：まっすぐ進んでから曲がる（外側の角のマスを通る）
          const C = fwd ? nb(g, P, prevD) : nb(g, Q, opp(pc.d));
          if (C < 0) return null;
          out.push(C);
        }
      } else if (dist === 2) {
        const mx = px + Math.sign(qx - px), my = py + Math.sign(qy - py);
        out.push(g.idx(mx, my));
      } else return null;
    }
    out.push(...cells);
    prevD = pc.d;
  }
  return out;
}

// 格子点 Q を中心線が通る、外向き w に直交する大通り（T字の相手）があるか：Q のまわりの4マスが、続いている車線
function teeAt(g: Grid, qx: number, qy: number, w: number) {
  if (isDiag(w)) return false;
  const cell = (x: number, y: number) => (g.inb(x, y) ? g.idx(x, y) : -1);
  const thru = (c: number, d: number) => {
    if (c < 0 || g.road[c] !== RoadType.Avenue || !(g.flow[c] & (1 << d))) return false;
    const b = nb(g, c, opp(d));
    return b >= 0 && g.road[b] === RoadType.Avenue && (g.flow[b] & (1 << d)) !== 0;
  };
  if (w === 2 || w === 6) return thru(cell(qx - 1, qy - 1), 4) && thru(cell(qx, qy - 1), 4) && thru(cell(qx - 1, qy), 0) && thru(cell(qx, qy), 0);
  return thru(cell(qx - 1, qy - 1), 2) && thru(cell(qx - 1, qy), 2) && thru(cell(qx, qy - 1), 6) && thru(cell(qx, qy), 6);
}

// 両方向の道路の行き止まりのマスの外向き（道路が続いていない向き）。行き止まりでなければ -1
function roadEndDir(g: Grid, c: number) {
  if (c < 0 || !twoWayLocal(g.road[c]) || g.up[c] || g.deck[c] > 0) return -1;
  const m = g.conn[c];
  if (!m || m & (m - 1)) return -1;
  const q = 31 - Math.clz32(m);
  return isDiag(q) ? -1 : opp(q);
}

// 格子点 Q で終わる大通り（外向き w）の端のすぐ先を、両方向の道路が横切っているか
function roadSideAt(g: Grid, qx: number, qy: number, w: number) {
  if (isDiag(w)) return false;
  const ux = DX[w], uy = DY[w], rx = -uy, ry = ux;
  const cell = (x: number, y: number) => (g.inb(Math.floor(x), Math.floor(y)) ? g.idx(Math.floor(x), Math.floor(y)) : -1);
  const c1 = cell(qx - ux * 0.5 + rx * 0.5, qy - uy * 0.5 + ry * 0.5), c2 = cell(qx - ux * 0.5 - rx * 0.5, qy - uy * 0.5 - ry * 0.5);
  if (c1 < 0 || c2 < 0) return false;
  const r1 = nb(g, c1, w), r2 = nb(g, c2, w);
  const ok = (c: number) => c >= 0 && twoWayLocal(g.road[c]) && !g.up[c] && !(g.deck[c] > 0);
  if (!ok(r1) || !ok(r2)) return false;
  const n = g.n;
  const d = dirOf((r2 % n) - (r1 % n), ((r2 / n) | 0) - ((r1 / n) | 0));
  return d >= 0 && (g.conn[r1] & (1 << d)) !== 0;
}

interface AvJoin { kind: 'avenue' | 'tee' | 'road' | 'sharp'; pt: Pt; end?: AvenueEnd }

// 大通りの端 P のつなぎ先を探す。body = 端から大通りの本体へ向かう向き
// 優先：既存の大通りの端（続き・45°・直角） > T字（相手の中心線まで延ばす／縮める） > 道路の行き止まり > 横切る道路
function avenueJoinAt(g: Grid, P: Pt, body: number): AvJoin | null {
  const [px, py] = P;
  const w = opp(body);
  const d2 = (q: Pt) => Math.hypot(q[0] - px, q[1] - py);
  // 既存の大通りの端：まっすぐか45°なら2マス以内、直角なら1マス以内
  let best: AvJoin | null = null, bs = Infinity;
  let sharp: AvJoin | null = null;
  for (let y = py - 3; y <= py + 2; y++)
    for (let x = px - 3; x <= px + 2; x++) {
      if (!g.inb(x, y)) continue;
      const e = avenueEndAt(g, g.idx(x, y));
      if (!e) continue;
      const diff = (body - e.a + 8) & 7;
      // 直角は縦と横の大通りだけ（斜めどうしの直角は、車線が交差してしまう）
      const right = (diff === 2 || diff === 6) && !isDiag(e.a);
      const tol = diff === 0 || diff === 1 || diff === 7 ? 2 : right ? 1 : -1;
      for (const V of avenueEndPoints(g, e)) {
        const cheb = Math.max(Math.abs(V[0] - px), Math.abs(V[1] - py));
        // 端から急に折り返す向き
        if (tol < 0 && diff !== 4 && cheb <= 1) sharp = { kind: 'sharp', pt: V };
        if (cheb > tol) continue;
        const s = cheb * 10 + d2(V);
        if (s < bs) { bs = s; best = { kind: 'avenue', pt: V, end: e }; }
      }
    }
  if (best) return best;
  if (sharp) return sharp;
  if (isDiag(body)) return null;
  // T字：相手の大通りの上（向こう側の車線の1マス先まで）か、3マス手前まで
  for (const t of [0, 1, -1, 2, -2, 3]) {
    const qx = px + DX[w] * t, qy = py + DY[w] * t;
    if (teeAt(g, qx, qy, w)) return { kind: 'tee', pt: [qx, qy] };
  }
  // 道路の行き止まりの続き：道路が2本の車線のどちらかにそろうように、1マス以内でつなぐ
  for (let y = py - 2; y <= py + 1; y++)
    for (let x = px - 2; x <= px + 1; x++) {
      if (!g.inb(x, y)) continue;
      const c = g.idx(x, y);
      if (roadEndDir(g, c) !== body) continue;
      const ox = x + 0.5 + DX[body] * 0.5, oy = y + 0.5 + DY[body] * 0.5;
      const sx = -DY[body] * 0.5, sy = DX[body] * 0.5;
      for (const V of [[ox + sx, oy + sy], [ox - sx, oy - sy]] as Pt[]) {
        const cheb = Math.max(Math.abs(V[0] - px), Math.abs(V[1] - py));
        if (cheb > 1) continue;
        const s = cheb * 10 + d2(V);
        if (s < bs) { bs = s; best = { kind: 'road', pt: V }; }
      }
    }
  if (best) return best;
  // 横切る道路：端がちょうど道路の手前に来るように
  for (const t of [0, 1, -1, 2]) {
    const qx = px + DX[w] * t, qy = py + DY[w] * t;
    if (roadSideAt(g, qx, qy, w)) return { kind: 'road', pt: [qx, qy] };
  }
  return null;
}

export interface AvenueSnap { x0: number; y0: number; x1: number; y1: number; start: AvJoin | null; end: AvJoin | null }

// 大通りの始点・終点を、つなぎ先にそろえる。片方だけそろえたときは、まっすぐな線のままになるように、もう片方も横にずらす
export function snapAvenue(g: Grid, x0: number, y0: number, x1: number, y1: number): AvenueSnap {
  if (x0 === x1 && y0 === y1) return { x0, y0, x1, y1, start: null, end: null };
  const pts = avenuePolyline(x0, y0, x1, y1);
  const d0 = segDir(pts[0], pts[1]), d1 = segDir(pts[pts.length - 2], pts[pts.length - 1]);
  const s = avenueJoinAt(g, [x0, y0], d0);
  const e = avenueJoinAt(g, [x1, y1], opp(d1));
  let [sx, sy] = s ? s.pt : [x0, y0];
  let [ex, ey] = e ? e.pt : [x1, y1];
  const dx = x1 - x0, dy = y1 - y0;
  const aligned = dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
  // 線の向きに直交する分だけずらす
  const side = (ox: number, oy: number): Pt => {
    const ux = Math.sign(dx), uy = Math.sign(dy);
    if (!ux) return [ox, 0];
    if (!uy) return [0, oy];
    const k = Math.round((ox * ux - oy * uy) / 2);
    return [k * ux, -k * uy];
  };
  if (s?.kind === 'sharp' || e?.kind === 'sharp') return { x0, y0, x1, y1, start: s, end: e };
  if (aligned && s && !e && s.kind !== 'tee') {
    const [ox, oy] = side(sx - x0, sy - y0);
    ex += ox;
    ey += oy;
  } else if (aligned && e && !s && e.kind !== 'tee') {
    const [ox, oy] = side(ex - x1, ey - y1);
    sx += ox;
    sy += oy;
  }
  // マップの端の1マス手前で終わる端（つなぎ先がなく、縦か横にまっすぐ外へ向かう）は、マップの端までのばす（隣の都市へ続く）
  const toEdge = (P: Pt, out: number): Pt => {
    if (isDiag(out)) return P;
    const q: Pt = [P[0] + DX[out], P[1] + DY[out]];
    const onEdge = (v: number, dv: number) => (dv > 0 ? v === g.n : dv < 0 ? v === 0 : true);
    return onEdge(q[0], DX[out]) && onEdge(q[1], DY[out]) ? q : P;
  };
  const same = (a: Pt[], b: Pt[]) => a.length === b.length && a.every((p, k) => k === 0 || segDir(a[k - 1], p) === segDir(b[k - 1], b[k]));
  if (!e) {
    const q = toEdge([ex, ey], d1);
    if (same(avenuePolyline(sx, sy, q[0], q[1]), avenuePolyline(sx, sy, ex, ey))) [ex, ey] = q;
  }
  if (!s) {
    const q = toEdge([sx, sy], opp(d0));
    if (same(avenuePolyline(q[0], q[1], ex, ey), avenuePolyline(sx, sy, ex, ey))) [sx, sy] = q;
  }
  return { x0: sx, y0: sy, x1: ex, y1: ey, start: s, end: e };
}

// 大通りの橋：2本の車線の、同じ位置のマスどうしを1枚の床版にする。
// どちらかの車線が水の上なら両方とも橋にし、高さは両岸（両方の車線）でいちばん高い路面に合わせる
function avenueDecks(g: Grid, segs: AvSeg[], sA: AvAnchor | null, eA: AvAnchor | null): Map<number, number> {
  const n = g.n;
  const st: [number, number][] = [];
  for (const s of segs) for (let k = 0; k < s.f.length; k++) st.push([s.f[k], s.b[k]]);
  const isW = (c: number) => g.isWater(c % n, (c / n) | 0) || g.deck[c] > 0;
  const wet = st.map(([f, b]) => isW(f) || isW(b));
  const deck = new Map<number, number>();
  for (let k = 0; k < st.length; k++) {
    if (!wet[k]) continue;
    let e = k;
    while (e + 1 < st.length && wet[e + 1]) e++;
    const hs: number[] = [WATER_LEVEL + 3.5];
    if (k > 0) hs.push(g.roadH(st[k - 1][0]), g.roadH(st[k - 1][1]));
    else if (sA) hs.push(g.roadH(sA.f), g.roadH(sA.b));
    if (e + 1 < st.length) hs.push(g.roadH(st[e + 1][0]), g.roadH(st[e + 1][1]));
    else if (eA) hs.push(g.roadH(eA.f), g.roadH(eA.b));
    let H = Math.max(...hs);
    // すでにある橋の上に引き直すときは、その高さのまま
    let old = 0;
    for (let j = k; j <= e; j++) for (const c of st[j]) old = Math.max(old, g.deck[c]);
    if (old > 0) H = old;
    for (let j = k; j <= e; j++) for (const c of st[j]) deck.set(c, H);
    k = e;
  }
  return deck;
}

const SHARP_MSG = '大通りどうしは、この角度ではつなげません（45°までの曲がりか、縦と横の直角だけ）';

function emptyPlan(type: RoadType, reason: string, cells: number[] = [], centre?: Pt[]): RoadPlan {
  return {
    ok: false, path: { cells, dirs: [] }, lanes: [], type, cost: 0, bad: new Set(cells), vertexH: new Map(), deck: new Map(), upH: new Map(),
    converts: [], uturns: [], reason, bridgeCells: 0, centre,
  };
}

// 大通りの計画。(x0, y0) → (x1, y1) は格子点で、なぞった線が中心線になる
export function planAvenue(g: Grid, x0: number, y0: number, x1: number, y1: number): RoadPlan {
  const type = RoadType.Avenue;
  const n = g.n;
  const sn = snapAvenue(g, x0, y0, x1, y1);
  if (sn.x0 === sn.x1 && sn.y0 === sn.y1) return emptyPlan(type, '');
  if (sn.start?.kind === 'sharp' || sn.end?.kind === 'sharp') return emptyPlan(type, SHARP_MSG, [], avenuePolyline(x0, y0, x1, y1));
  const pts = avenuePolyline(sn.x0, sn.y0, sn.x1, sn.y1);
  const last = pts.length - 1;
  const d0 = segDir(pts[0], pts[1]), d1 = segDir(pts[last - 1], pts[last]);
  // 既存の大通りの端へのつなぎ：45°までの曲がりと直角だけ
  const sharp = (dd: number) => { const k = (dd + 8) & 7; return k === 3 || k === 4 || k === 5; };
  const se = sn.start?.kind === 'avenue' ? sn.start.end! : null;
  const ee = sn.end?.kind === 'avenue' ? sn.end.end! : null;
  if ((se && sharp(d0 - se.a)) || (ee && sharp(opp(ee.a) - d1))) return emptyPlan(type, SHARP_MSG, [], pts);
  const sA: AvAnchor | null = se ? { f: se.X, b: se.Y, d: se.a } : null;
  const eA: AvAnchor | null = ee ? { f: ee.Y, b: ee.X, d: opp(ee.a) } : null;
  // 川岸が斜めで、端のマスの片方だけが水の上になるときは、両方の車線が陸に届くまで端を延ばす（3マスまで）
  const wetAt = ([f, b]: [number, number]) => g.isWater(f % n, (f / n) | 0) || g.isWater(b % n, (b / n) | 0);
  for (const atStart of [true, false]) {
    if (atStart ? sn.start : sn.end) continue;
    for (let k = 0; k <= 3; k++) {
      const tryPts = pts.map((p) => [p[0], p[1]] as Pt);
      if (atStart) tryPts[0] = [pts[0][0] - DX[d0] * k, pts[0][1] - DY[d0] * k];
      else tryPts[last] = [pts[last][0] + DX[d1] * k, pts[last][1] + DY[d1] * k];
      const sg = avenueSegs(g, tryPts, sA, eA);
      if (!sg) break;
      const s0 = atStart ? sg[0] : sg[sg.length - 1];
      const end: [number, number] = atStart ? [s0.f[0], s0.b[0]] : [s0.f[s0.f.length - 1], s0.b[s0.b.length - 1]];
      if (!wetAt(end)) {
        if (k) pts.splice(0, pts.length, ...tryPts);
        break;
      }
    }
  }
  const centre = pts.map((p) => [p[0], p[1]] as Pt);
  // T字：相手の向こう側の車線まで延ばす（折り返しは作らない）
  if (sn.start?.kind === 'tee') pts[0] = [pts[0][0] - DX[d0], pts[0][1] - DY[d0]];
  if (sn.end?.kind === 'tee') pts[last] = [pts[last][0] + DX[d1], pts[last][1] + DY[d1]];
  const segs = avenueSegs(g, pts, sA, eA);
  if (!segs) return emptyPlan(type, '大通りがマップの端からはみ出します', [], centre);
  const fp: { cells: number[]; d: number }[] = [], bp: { cells: number[]; d: number }[] = [];
  if (sA) { fp.push({ cells: [sA.f], d: sA.d }); bp.push({ cells: [sA.b], d: sA.d }); }
  for (const s of segs) { fp.push({ cells: s.f, d: s.d }); bp.push({ cells: s.b, d: s.d }); }
  if (eA) { fp.push({ cells: [eA.f], d: eA.d }); bp.push({ cells: [eA.b], d: eA.d }); }
  const fwd = stitchLane(g, fp, true), bwdF = stitchLane(g, bp, false);
  const all = segs.flatMap((s) => [...s.f, ...s.b]);
  if (!fwd || !bwdF) return emptyPlan(type, '大通りは、この形にはつなげません', all, centre);
  const bwd = bwdF.slice().reverse();
  const dirsOf = (cs: number[]) => cs.slice(1).map((c, k) => dirOf((c % n) - (cs[k] % n), ((c / n) | 0) - ((cs[k] / n) | 0)));
  const fd = dirsOf(fwd), bd = dirsOf(bwd);
  const bad = new Set<number>();
  const reasons: string[] = [];
  const why = (r: string) => reasons.push(r);
  // 行きと帰りの車線は、同じマスを通らない
  const fs = new Set(fwd);
  if (fd.some((d) => d < 0) || bd.some((d) => d < 0) || fs.size !== fwd.length || new Set(bwd).size !== bwd.length || bwd.some((c) => fs.has(c))) {
    for (const c of all) bad.add(c);
    why('大通りは、この形には引けません（急な曲がりや、重なり）');
  }
  // 反対向きに流れる一方通行の車線と重ならない（つなぎ先のマスは除く）
  const anchors = new Set([sA?.f, sA?.b, eA?.f, eA?.b].filter((c): c is number => c !== undefined));
  for (const [cs, ds] of [[fwd, fd], [bwd, bd]] as const)
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      if (anchors.has(c)) continue;
      const t = g.road[c];
      if (!t || !(ROADS[t].oneWay || ROADS[t].wide)) continue;
      const d = ds[Math.min(k, ds.length - 1)];
      if (d >= 0 && g.flow[c] & (1 << opp(d)) && !(g.flow[c] & (1 << d))) {
        bad.add(c);
        // 既存の大通りに平行で、半マスずれている（中心線が大通りの中央にない）
        why(t === RoadType.Avenue ? '既存の大通りと半分重なっています。緑の中心線を大通りの中央に合わせてください' : '反対向きの一方通行の車線と重なっています');
      }
    }
  // 端の折り返し（つなぎ先がない端だけ。既存の大通りがそのまま続く場合も作らない）
  const uturns: [number, number][] = [];
  // 端のマスから、今回の車線の外の大通りへ流れていく（まっすぐ続く、または角で曲がって続く）
  const laneSet = new Set([...fwd, ...bwd]);
  const continues = (c: number) => {
    if (g.road[c] !== RoadType.Avenue) return false;
    for (let d = 0; d < 8; d++) {
      const j = nb(g, c, d);
      if (g.flow[c] & (1 << d) && j >= 0 && g.road[j] === RoadType.Avenue && !laneSet.has(j)) return true;
    }
    return false;
  };
  const startFree = !sn.start || sn.start.kind === 'road';
  const endFree = !sn.end || sn.end.kind === 'road';
  // マップの端で外へ向いている端は、隣の都市へ続くので折り返さない（両方の車線の端のマスの先が、マップの外）
  const offMap = (c: number, d: number | undefined) => d !== undefined && d >= 0 && nb(g, c, d) < 0;
  const startOut = offMap(fwd[0], fd.length ? opp(fd[0]) : undefined) && offMap(bwd[bwd.length - 1], bd[bd.length - 1]);
  const endOut = offMap(fwd[fwd.length - 1], fd[fd.length - 1]) && offMap(bwd[0], bd.length ? opp(bd[0]) : undefined);
  if (startFree && !startOut && !continues(bwd[bwd.length - 1])) uturns.push([bwd[bwd.length - 1], fwd[0]]);
  if (endFree && !endOut && !continues(fwd[fwd.length - 1])) uturns.push([fwd[fwd.length - 1], bwd[0]]);
  // 橋（2本の車線で1枚）
  const pairDeck = avenueDecks(g, segs, sA, eA);
  for (const c of [...fwd, ...bwd])
    if (!pairDeck.has(c) && !anchors.has(c) && g.isWater(c % n, (c / n) | 0)) {
      bad.add(c);
      why('橋はまっすぐに架けてください');
    }
  const lanes: Lane[] = [
    { cells: fwd, dirs: fd, oneWay: true, levels: [] },
    { cells: bwd, dirs: bd, oneWay: true, levels: [] },
  ];
  const unlinks: [number, number][] = [];
  if (se) unlinks.push([se.X, se.Y]);
  if (ee) unlinks.push([ee.X, ee.Y]);
  // マップの端の端に、前に作った折り返しが残っていれば外す（古い保存データなど）
  const hasFlow = (a: number, b: number) => {
    const d = dirOf((b % n) - (a % n), ((b / n) | 0) - ((a / n) | 0));
    return d >= 0 && g.road[a] === RoadType.Avenue && g.road[b] === RoadType.Avenue && (g.flow[a] & (1 << d)) !== 0;
  };
  if (startOut && hasFlow(bwd[bwd.length - 1], fwd[0])) unlinks.push([bwd[bwd.length - 1], fwd[0]]);
  if (endOut && hasFlow(fwd[fwd.length - 1], bwd[0])) unlinks.push([fwd[fwd.length - 1], bwd[0]]);
  const plan = finishRoadPlan(g, { cells: fwd, dirs: fd }, lanes, type, bad, reasons, uturns, pairDeck, { centre, unlinks });
  plan.bridgeCells = Math.ceil(plan.bridgeCells / 2); // 橋の長さ（2本の車線で1枚）
  plan.startKind = sn.start?.kind;
  plan.endKind = sn.end?.kind;
  plan.sideJoins = avenueSideJoins(g, plan);
  plan.stemJoins = avenueStemJoins(g, plan);
  // すでに同じ大通りがあって、引いても何も変わらない：何もしない（失敗ではなく、知らせるだけ）。
  // 足りない折り返しやつなぎ目があれば（大通りの途中を取り壊したあとなど）、引き直すとつながるので、ふつうに引く
  if (plan.ok && avenueUnchanged(g, plan)) {
    const p0 = emptyPlan(type, 'すでに大通りです', [], centre);
    p0.noop = true;
    return p0;
  }
  // 外側の隣のマスが、平行な別の大通りの車線：歩道どうしがくっつく（止めはしないが、知らせる）。
  // 行き止まりの端の折り返しのような、続いていない流れは平行な車線とみなさない
  if (plan.ok) {
    const mine = new Set([...fwd, ...bwd]);
    const along = (c: number, e: number) => {
      const j = nb(g, c, e), i = nb(g, c, opp(e));
      return (j >= 0 && g.road[j] === RoadType.Avenue && (g.flow[j] & (1 << e)) !== 0) || (i >= 0 && g.road[i] === RoadType.Avenue && (g.flow[i] & (1 << e)) !== 0);
    };
    for (const [cs, ds] of [[fwd, fd], [bwd, bd]] as const) {
      const other = cs === fwd ? new Set(bwd) : new Set(fwd);
      for (let k = 0; k < cs.length && !plan.note; k++) {
        const d = ds[Math.min(k, ds.length - 1)];
        if (d < 0 || isDiag(d)) continue;
        for (const sd of [(d + 2) & 7, (d + 6) & 7]) {
          const twin = nb(g, cs[k], opp(sd)), out = nb(g, cs[k], sd);
          if (twin < 0 || out < 0 || !other.has(twin) || mine.has(out) || g.road[out] !== RoadType.Avenue) continue;
          for (const e of [d, opp(d)]) if (g.flow[out] & (1 << e) && along(out, e)) plan.note = 'となりの大通りと歩道が重なります';
        }
      }
    }
  }
  return plan;
}

// 大通りの計画が、今の道路を何も変えないか（すでに同じ大通りがあり、折り返しやつなぎ目もそろっている）
function avenueUnchanged(g: Grid, plan: RoadPlan) {
  const n = g.n;
  if (plan.converts.length || plan.vertexH.size || plan.stemJoins?.length) return false;
  for (const [c, h] of plan.deck) if (Math.abs(g.deck[c] - h) > 0.01) return false;
  for (const [c, h] of plan.upH) if (Math.abs(g.upH[c] - h) > 0.01) return false;
  // 車線：それぞれのマスの階層（地上・上空）に、大通りの同じ向きの流れがある（最後のマスは、大通りのマスであることだけ）
  for (const l of plan.lanes)
    for (let k = 0; k < l.cells.length; k++) {
      const c = l.cells[k], up = l.levels[k] === 1;
      if ((up ? g.up[c] : g.road[c]) !== RoadType.Avenue) return false;
      if (k < l.dirs.length && !((up ? g.flow1[c] : g.flow[c]) & (1 << l.dirs[k]))) return false;
    }
  const flows = (a: number, b: number) => {
    const d = dirOf((b % n) - (a % n), ((b / n) | 0) - ((a / n) | 0));
    return d >= 0 && (g.flow[a] & (1 << d)) !== 0;
  };
  // 端の折り返し（端の先の道路につないであれば、折り返しはなくてよい）
  const toRoad = (a: number) => {
    for (let d = 0; d < 8; d++) {
      const j = nb(g, a, d);
      if (j >= 0 && g.flow[a] & (1 << d) && twoWayLocal(g.road[j])) return true;
    }
    return false;
  };
  if (plan.uturns.some(([a, b]) => !flows(a, b) && !toRoad(a))) return false;
  if ((plan.unlinks ?? []).some(([a, b]) => flows(a, b))) return false;
  if ((plan.sideJoins ?? []).some(([s, c, f]) => !flows(s, c) || !flows(c, s) || !flows(c, f) || !flows(f, c))) return false;
  return !linkAvenueEnds(g, plan.lanes.flatMap((l) => [l.cells[0], l.cells[l.cells.length - 1]]), true);
}

// 大通りのまっすぐな区間の横で、両方向の道路がすでに車線のマスにつながっているか（道路をなぞって大通りにしたとき）、
// 行き止まりの先が車線のマスに向いているときは、近い車線と反対車線の両方へつなぐ（あとから道路を突き当てたT字と同じ形）
function avenueSideJoins(g: Grid, plan: RoadPlan): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (plan.lanes.length !== 2) return out;
  const laneOf = new Map<number, number>();
  plan.lanes.forEach((l, li) => l.cells.forEach((c) => laneOf.set(c, li)));
  plan.lanes.forEach((l, li) =>
    l.cells.forEach((c, k) => {
      if (l.levels[k] !== 0 || plan.deck.has(c) || plan.bad.has(c)) return;
      const ds = [k > 0 ? l.dirs[k - 1] : -1, k < l.dirs.length ? l.dirs[k] : -1].filter((d) => d >= 0);
      if (!ds.length || ds.some((d) => isDiag(d) || d !== ds[0])) return;
      for (const d of [(ds[0] + 2) & 7, (ds[0] + 6) & 7]) {
        const s = nb(g, c, d), f = nb(g, c, opp(d));
        if (s < 0 || f < 0 || laneOf.get(f) !== 1 - li || laneOf.has(s)) continue;
        if (!twoWayLocal(g.road[s]) || g.up[s] || g.deck[s] > 0) continue;
        if (!(g.conn[s] & (1 << opp(d))) && roadEndDir(g, s) !== opp(d)) continue;
        out.push([s, c, f, opp(d)]);
      }
    }),
  );
  return out;
}

// 大通りのまっすぐな区間の外側の横に、ほかの大通りの行き止まりの端が直角に向いているとき（横切る大通りをあとから引いたT字）：
// 端の2本の車線の先が、こちらの近い車線と、その先の遠い車線になっていれば、つなぐ端として返す（先に突き当てたT字と同じ形）
function avenueStemJoins(g: Grid, plan: RoadPlan): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (plan.lanes.length !== 2) return out;
  // 地上の、橋でもだめでもないマスの、車線の番号とまっすぐな向き（曲がるマスは -1）
  const laneOf = new Map<number, number>(), dirAt = new Map<number, number>();
  plan.lanes.forEach((l, li) =>
    l.cells.forEach((c, k) => {
      if (l.levels[k] !== 0 || plan.deck.has(c) || plan.bad.has(c)) return;
      const ds = [k > 0 ? l.dirs[k - 1] : -1, k < l.dirs.length ? l.dirs[k] : -1].filter((d) => d >= 0);
      laneOf.set(c, li);
      dirAt.set(c, ds.length && ds.every((d) => !isDiag(d) && d === ds[0]) ? ds[0] : -1);
    }),
  );
  const seen = new Set<number>();
  for (const [c, li] of laneOf) {
    const d = dirAt.get(c)!;
    if (d < 0) continue;
    for (const sd of [(d + 2) & 7, (d + 6) & 7]) {
      const X = nb(g, c, sd);
      if (X < 0 || seen.has(X) || laneOf.has(X)) continue;
      const e = avenueEndAt(g, X);
      if (!e || e.a !== opp(sd)) continue;
      const Xa = nb(g, e.X, e.a), Ya = nb(g, e.Y, e.a);
      const Xf = Xa < 0 ? -1 : nb(g, Xa, e.a), Yf = Ya < 0 ? -1 : nb(g, Ya, e.a);
      const ok = (q: number, lane: number) => q >= 0 && laneOf.get(q) === lane && (dirAt.get(q)! & 3) === (d & 3);
      if (!ok(Xa, li) || !ok(Ya, li) || !ok(Xf, 1 - li) || !ok(Yf, 1 - li)) continue;
      seen.add(X);
      out.push([e.X, e.Y, e.a]);
    }
  }
  return out;
}

// 道路のコマンドの計画（プレビューと実行で同じものを使う）。大通りは格子点、それ以外はマスの座標
export function planRoadCmd(g: Grid, type: RoadType, x0: number, y0: number, x1: number, y1: number): RoadPlan {
  if (type === RoadType.Avenue) return planAvenue(g, x0, y0, x1, y1);
  const [sx0, sy0, sx1, sy1] = snapRoadEnds(g, type, x0, y0, x1, y1);
  return planRoad(g, planLine(g, sx0, sy0, sx1, sy1), type);
}

// 古い保存データ：大通りの橋の2本の車線の高さが違うものを、1枚の床版にそろえる（平均の高さ）
export function levelAvenueDecks(g: Grid) {
  const N = g.n * g.n;
  const seen = new Uint8Array(N);
  const isDeck = (c: number) => c >= 0 && g.road[c] === RoadType.Avenue && g.deck[c] > 0;
  for (let i = 0; i < N; i++) {
    if (seen[i] || !isDeck(i)) continue;
    // 車線に沿ってつながる橋のマスと、横に並ぶ反対車線の橋のマス
    const comp = [i];
    seen[i] = 1;
    for (let q = 0; q < comp.length; q++) {
      const c = comp[q];
      for (let d = 0; d < 8; d++) {
        const j = nb(g, c, d);
        if (!isDeck(j) || seen[j] || (isDiag(d) && !(g.conn[c] & (1 << d)))) continue;
        seen[j] = 1;
        comp.push(j);
      }
    }
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const c of comp) { lo = Math.min(lo, g.deck[c]); hi = Math.max(hi, g.deck[c]); sum += g.deck[c]; }
    if (hi - lo < 0.02) continue;
    const h = Math.max(WATER_LEVEL + 3.5, sum / comp.length);
    for (const c of comp) g.deck[c] = h;
  }
}

// 高架の高速道路が水の上で低くなっている所を、両岸の路面を結んだ高さまで上げる（以前の版は川の上で沈んでいた）
export function levelViaductsOverWater(g: Grid) {
  const n = g.n, N = n * n;
  const wet = (c: number) => g.isWater(c % n, (c / n) | 0);
  const viaduct = (c: number) => !!ROADS[g.up[c]]?.elevated && g.upH[c] > 0;
  const raise = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    if (!viaduct(i) || !wet(i)) continue;
    const ends: { h: number; d: number }[] = [];
    for (let d0 = 0; d0 < 8 && ends.length < 2; d0++) {
      if (!(g.conn1[i] & (1 << d0))) continue;
      let cur = i, dir = d0, dist = 0;
      for (let step = 0; step < 64; step++) {
        const x = (cur % n) + DX[dir], y = ((cur / n) | 0) + DY[dir];
        if (!g.inb(x, y)) break;
        const j = y * n + x;
        if (!viaduct(j) || !(g.conn1[j] & (1 << opp(dir)))) break;
        dist += isDiag(dir) ? 1.41 : 1;
        cur = j;
        if (!wet(j)) { ends.push({ h: g.upH[j], d: dist }); break; }
        // まっすぐ進めなければ、来た向き以外のつながりへ
        if (!(g.conn1[j] & (1 << dir))) {
          let nd = -1;
          for (let k = 0; k < 8; k++) if (g.conn1[j] & (1 << k) && k !== opp(dir)) { nd = k; break; }
          if (nd < 0) break;
          dir = nd;
        }
      }
    }
    if (ends.length < 2) continue;
    const h = ends[0].h + (ends[1].h - ends[0].h) * (ends[0].d / (ends[0].d + ends[1].d));
    if (h > g.upH[i] + 0.01) raise.set(i, h);
  }
  for (const [c, h] of raise) g.upH[c] = h;
}

// ---- 都市高速（片側1車線）のランプ：高速道路の横に1×5マス ----
// タップしたマスが真ん中。右側通行なので、置いた側を走る向きの出口（手前の端）と入口（先の端）になる。
// 真ん中のマスは、外側の一般道と直角につながる。高架の場合、真ん中は地上で、両端に向かって上がる。
export interface URampPlan {
  ok: boolean;
  reason: string;
  cells: number[]; // R[-2..2]
  hw: number[]; // H[-3..3]
  level: number;
  a: number; // 本線の進む向き（この側の車線）
  s: number; // ランプ → 本線の向き
  heights: number[];
  road: number; // 真ん中につなぐ一般道（なければ -1）
  cost: number;
}
export function planURamp(g: Grid, x: number, y: number): URampPlan {
  const n = g.n;
  const fail = (reason: string, cells: number[] = []): URampPlan => ({ ok: false, reason, cells, hw: [], level: 0, a: 0, s: 0, heights: [], road: -1, cost: RAMP_COST * 3 });
  if (!g.inb(x, y)) return fail('マップの外です');
  let lastCells: number[] = [];
  for (const s of [0, 2, 4, 6]) {
    const hx = x + DX[s], hy = y + DY[s];
    if (!g.inb(hx, hy)) continue;
    const h0 = g.idx(hx, hy);
    const level = isUrbanElevated(g.up[h0]) ? 1 : isUrbanGround(g.road[h0]) ? 0 : -1;
    if (level < 0) continue;
    const type = level ? g.up[h0] : g.road[h0];
    // 片側1車線は、置いた側を走る向き（右側通行）。一方通行は、走る向きに合わせる（どちら側にも置ける）
    let a = (s + 2) & 7;
    if (ROADS[type].oneWay) {
      const f = level ? g.flow1[h0] : g.flow[h0];
      const b1 = (s + 2) & 7, b2 = (s + 6) & 7;
      if (f & (1 << b1) && !(f & (1 << b2))) a = b1;
      else if (f & (1 << b2) && !(f & (1 << b1))) a = b2;
      else continue;
    }
    const at = (bx: number, by: number, k: number) => {
      const xx = bx + DX[a] * k, yy = by + DY[a] * k;
      return g.inb(xx, yy) ? g.idx(xx, yy) : -1;
    };
    const cells = [-2, -1, 0, 1, 2].map((k) => at(x, y, k));
    const hw = [-3, -2, -1, 0, 1, 2, 3].map((k) => at(hx, hy, k));
    lastCells = cells.filter((c) => c >= 0);
    if (cells.some((c) => c < 0) || hw.some((c) => c < 0)) return fail('マップの端に近すぎます', lastCells);
    const conn = level ? g.conn1 : g.conn;
    const along = (1 << a) | (1 << opp(a));
    for (const c of hw) {
      if ((level ? g.up[c] : g.road[c]) !== type) return fail('都市高速のまっすぐな区間（7マス）の横に置いてください', lastCells);
      // まっすぐ以外のつながりは、ランプ（反対側などにすでに置いたもの）へのものだけ認める
      const cx0 = c % n, cy0 = (c / n) | 0;
      for (let d = 0; d < 8; d++) {
        if (!(conn[c] & ~along & (1 << d))) continue;
        const nx = cx0 + DX[d], ny = cy0 + DY[d];
        const j = g.inb(nx, ny) ? g.idx(nx, ny) : -1;
        if (j < 0 || (g.road[j] !== RoadType.Ramp && g.up[j] !== RoadType.Ramp))
          return fail('都市高速のまっすぐな区間に置いてください（交差点や曲がり角の横には置けません）', lastCells);
      }
    }
    for (const c of cells) {
      const cx = c % n, cy = (c / n) | 0;
      if (g.road[c] || g.up[c] || g.bldg[c] || hasSurfaceLine(g, c)) return fail('空いているマス（5マス）に置いてください', lastCells);
      if (g.isWater(cx, cy)) return fail('水の上には置けません', lastCells);
    }
    const dOut = dirOf((cells[0] % n) - (hw[0] % n), ((cells[0] / n) | 0) - ((hw[0] / n) | 0));
    const dIn = dirOf((hw[6] % n) - (cells[4] % n), ((hw[6] / n) | 0) - ((cells[4] / n) | 0));
    if (crossesDiagonal(g, hw[0], dOut, level) || crossesDiagonal(g, cells[4], dIn, level)) return fail('近くの斜めの道路と交差します', lastCells);
    // 真ん中の外側の一般道
    const ox = x - DX[s], oy = y - DY[s];
    let road = -1;
    if (g.inb(ox, oy)) {
      const j = g.idx(ox, oy), t = g.road[j];
      if (t && !isHighway(t) && t !== RoadType.Ramp && !g.up[j]) road = j;
    }
    const gh = g.cellH(x, y);
    const hu = level ? g.upH[hw[3]] : gh;
    const heights = [0.8, 0.45, 0, 0.45, 0.8].map((k) => gh + (hu - gh) * k);
    return { ok: true, reason: '', cells, hw, level, a, s, heights, road, cost: RAMP_COST * 3 };
  }
  return fail('都市高速（片側1車線）の横に置いてください', lastCells.length ? lastCells : [g.idx(x, y)]);
}

// 高架の都市高速の行き止まりの端の下に、後から一般道を引いたとき：端のマスを地上の一般道にして、高架から降りてつながるようにする
export function linkUrbanEnds(g: Grid) {
  const n = g.n;
  for (let c = 0; c < n * n; c++) {
    const ut = g.up[c];
    if (!isUrbanElevated(ut)) continue;
    const t = g.road[c];
    if (!t || isHighway(t) || t === RoadType.Ramp) continue;
    const m = g.conn1[c];
    if (!m || m & (m - 1)) continue; // つながりが1つだけ（行き止まり）
    const b = 31 - Math.clz32(m);
    // 下の一般道が高架に沿って内側へ続いている（大通りの真上を走る高架など）なら、つながない
    if (g.conn[c] & (1 << b)) continue;
    const px = (c % n) + DX[b], py = ((c / n) | 0) + DY[b];
    if (!g.inb(px, py)) continue;
    const p = g.idx(px, py);
    if (g.up[p] !== ut) continue;
    const outward = !!(g.flow1[p] & (1 << opp(b))), inward = !!(g.flow1[c] & (1 << b));
    g.up[c] = 0;
    g.conn1[c] = 0;
    g.flow1[c] = 0;
    g.upH[c] = 0;
    // 一方通行は、走る向きのとおりにだけつなぐ
    if (!ROADS[ut].oneWay || (outward && inward)) link(g, p, 1, c, 0, opp(b), false);
    else if (outward) link(g, p, 1, c, 0, opp(b), true);
    else link(g, c, 0, p, 1, b, true);
    // 端に向かって、高架をなめらかに下げる（引いたときの始まり側と同じ勾配）
    let cur = p, from = c;
    for (let k = 0; k < 40; k++) {
      const x = cur % n, y = (cur / n) | 0;
      const h = g.cellH(x, y) + 1.8 + 1.5 * k;
      if (g.upH[cur] <= h) break;
      g.upH[cur] = h;
      let next = -1;
      for (let d = 0; d < 8; d++) {
        if (!(g.conn1[cur] & (1 << d)) || !g.inb(x + DX[d], y + DY[d])) continue;
        const j = g.idx(x + DX[d], y + DY[d]);
        if (j !== from && g.up[j] === ut) { next = j; break; }
      }
      if (next < 0) break;
      from = cur;
      cur = next;
    }
  }
}

// 以前の版：一般道（大通りなど）の真上に沿って引いた高架の高速道路の端が、下の道路に降りてつながっていた。
// 端のマスを高架に戻し（降りていた坂も元の高さへ）、下の道路の流れを元に戻す
export function unjoinAlongEnds(g: Grid) {
  const n = g.n;
  const local = (t: number) => t !== 0 && !isHighway(t) && t !== RoadType.Ramp;
  for (let c = 0; c < n * n; c++) {
    if (!local(g.road[c]) || g.up[c]) continue;
    const x = c % n, y = (c / n) | 0;
    for (let b = 0; b < 8; b++) {
      if (!g.inb(x + DX[b], y + DY[b])) continue;
      const p = g.idx(x + DX[b], y + DY[b]), o = opp(b), ut = g.up[p];
      if (!isHighway(ut) || !ROADS[ut].elevated || !local(g.road[p])) continue;
      // 高架 p から地上の c へ降りるつながりと、地上の道路どうしの p - c のつながりが両方ある
      if (!(g.conn1[p] & (1 << o)) || !(g.conn[p] & (1 << o)) || !(g.conn[c] & (1 << b))) continue;
      const out = (g.flow1[p] & (1 << o)) !== 0;
      g.up[c] = ut;
      g.conn1[c] = 1 << b;
      g.flow1[c] = !ROADS[ut].oneWay || !out ? 1 << b : 0;
      // 地上の道路の c → p の流れ（一方通行の車線は、p → c の流れがなければ c → p）
      if (!ROADS[g.road[c]].oneWay || !(g.flow[p] & (1 << o))) g.flow[c] |= 1 << b;
      else g.flow[c] &= ~(1 << b);
      // 端に向かって下げてあった高架を、元の高さに戻す
      const lift = ROADS[ut].lift ?? 9;
      let cur = c, from = -1;
      for (let k = 0; k < 16 && cur >= 0; k++) {
        const cx = cur % n, cy = (cur / n) | 0;
        const h = Math.max(g.cellH(cx, cy), WATER_LEVEL) + lift;
        if (cur !== c && g.upH[cur] >= h - 0.05) break;
        g.upH[cur] = Math.max(g.upH[cur], h);
        let next = -1;
        for (let d = 0; d < 8; d++) {
          if (!(g.conn1[cur] & (1 << d)) || !g.inb(cx + DX[d], cy + DY[d])) continue;
          const j = g.idx(cx + DX[d], cy + DY[d]);
          if (j !== from && g.up[j] === ut) { next = j; break; }
        }
        from = cur;
        cur = next;
      }
      break;
    }
  }
}

// 都市高速のランプの真ん中のマスを、外側に後から引いた一般道（横切る道でも、平行な道でも）とつなぐ
export function linkURampMiddles(g: Grid) {
  const n = g.n;
  const isRamp = (x: number, y: number) => g.inb(x, y) && (g.road[g.idx(x, y)] === RoadType.Ramp || g.up[g.idx(x, y)] === RoadType.Ramp);
  const isUrban = (x: number, y: number) => g.inb(x, y) && (isUrbanGround(g.road[g.idx(x, y)]) || isUrbanElevated(g.up[g.idx(x, y)]));
  for (let c = 0; c < n * n; c++) {
    if (g.road[c] !== RoadType.Ramp || g.conn[c] & 0b10101010 || g.jct[c] & 1) continue; // ジャンクションのランプは一般道につながない
    const x = c % n, y = (c / n) | 0;
    for (const a of [0, 2]) {
      const b = opp(a);
      if (!(g.conn[c] & (1 << a)) || !(g.conn[c] & (1 << b))) continue;
      if (![1, 2].every((k) => isRamp(x + DX[a] * k, y + DY[a] * k) && isRamp(x + DX[b] * k, y + DY[b] * k))) continue;
      for (const s of [(a + 2) & 7, (a + 6) & 7]) {
        if (!isUrban(x + DX[s], y + DY[s])) continue;
        const o = opp(s), ox = x + DX[o], oy = y + DY[o];
        if (!g.inb(ox, oy)) continue;
        const j = g.idx(ox, oy), t = g.road[j];
        if (!t || isHighway(t) || t === RoadType.Ramp || g.up[j]) continue;
        if ((g.flow[c] & (1 << o)) && (g.flow[j] & (1 << s))) continue;
        link(g, c, 0, j, 0, o, false);
      }
    }
  }
}

export function applyURamp(g: Grid, p: URampPlan) {
  const n = g.n;
  const { cells, hw, level, a } = p;
  cells.forEach((c, k) => {
    const L = level && k !== 2 ? 1 : 0;
    if (L) {
      g.up[c] = RoadType.Ramp;
      g.upH[c] = p.heights[k];
    } else g.road[c] = RoadType.Ramp;
    g.zone[c] = 0;
    g.zden[c] = 0;
    g.tree[c] = 0;
  });
  const lv = (k: number) => (level && k !== 2 ? 1 : 0);
  const dir = (from: number, to: number) => dirOf((to % n) - (from % n), ((to / n) | 0) - ((from / n) | 0));
  // 出口：本線 H[-3] → R[-2] → R[-1] → R[0]
  link(g, hw[0], level, cells[0], lv(0), dir(hw[0], cells[0]), true);
  link(g, cells[0], lv(0), cells[1], lv(1), a, true);
  link(g, cells[1], lv(1), cells[2], lv(2), a, true);
  // 入口：R[0] → R[1] → R[2] → 本線 H[3]
  link(g, cells[2], lv(2), cells[3], lv(3), a, true);
  link(g, cells[3], lv(3), cells[4], lv(4), a, true);
  link(g, cells[4], lv(4), hw[6], level, dir(cells[4], hw[6]), true);
  if (p.road >= 0) link(g, cells[2], 0, p.road, 0, dir(cells[2], p.road), false);
}

// 木を植える：道路・建物・線路・送電線・水のないマスに、木をいっぱいに植える（すでに満杯のマスは除く）
export const TREE_COST = 3; // 1マス
export function planTrees(g: Grid, x0: number, y0: number, x1: number, y1: number) {
  const r = normRect(x0, y0, x1, y1, g.n);
  const cells: number[] = [];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) {
      const i = g.idx(x, y);
      if (g.road[i] || g.up[i] || g.bldg[i] || g.pline[i] || g.tree[i] >= 3 || hasSurfaceLine(g, i) || g.isWater(x, y)) continue;
      cells.push(i);
    }
  return { cells, cost: cells.length * TREE_COST };
}

// ---- 線路の上だけの高架駅（敷地なし）----
// 高架鉄道のまっすぐな区間（斜めでもよい）の 4 マスにホームを作る。すでにある駅をタップすると外す
export interface EStopPlan { ok: boolean; cells: number[]; remove: boolean; reason: string; cost: number }
export const ESTOP_LEN = 4;
export function estopGroup(g: Grid, start: number): number[] {
  const n = g.n, out: number[] = [], seen = new Set([start]), st = [start];
  while (st.length) {
    const c = st.pop()!;
    out.push(c);
    const x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      // 線路でつながっているホームだけを 1 つの駅とみなす（隣に並べた別の線の駅とは分ける）
      if (!(g.erail[c] & (1 << d))) continue;
      const nx = x + DX[d], ny = y + DY[d];
      if (!g.inb(nx, ny)) continue;
      const j = ny * n + nx;
      if (seen.has(j) || !g.estn[j]) continue;
      seen.add(j);
      st.push(j);
    }
  }
  return out;
}
// 駅から歩いて出入りできる一般の道路（ホームの下か、すぐ横）
export function estopRoads(g: Grid, cells: number[]): number[] {
  const n = g.n, out = new Set<number>();
  // 隣に並んだ駅（別の線）のホームからも出入りできる（乗り換えできる）
  const all = new Set(cells);
  for (const c of cells) {
    const x = c % n, y = (c / n) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (g.inb(x + dx, y + dy) && g.estn[g.idx(x + dx, y + dy)]) all.add(g.idx(x + dx, y + dy));
  }
  for (const c of all) {
    const x = c % n, y = (c / n) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!g.inb(x + dx, y + dy)) continue;
        const j = g.idx(x + dx, y + dy), t = g.road[j];
        if (t && !isHighway(t) && t !== RoadType.Ramp) out.add(j);
      }
  }
  return [...out];
}
export function planEStop(g: Grid, x: number, y: number): EStopPlan {
  const fail = (reason: string, cells: number[] = []): EStopPlan => ({ ok: false, cells, remove: false, reason, cost: 0 });
  if (!g.inb(x, y)) return fail('マップの外です');
  const i = g.idx(x, y);
  if (g.estn[i]) return { ok: true, cells: estopGroup(g, i), remove: true, reason: '', cost: 0 };
  const m = g.erail[i];
  if (!m) return fail('高架鉄道の線路の上に置いてください', [i]);
  const n = g.n;
  let last: number[] = [i];
  for (let d = 0; d < 4; d++) {
    const along = (1 << d) | (1 << opp(d));
    if ((m & along) !== along) continue;
    // 4マスの並べ方：タップしたマスがなるべく真ん中になるように
    for (const k0 of [-1, -2, 0, -3]) {
      const cells: number[] = [];
      let ok = true;
      for (let k = k0; k < k0 + ESTOP_LEN; k++) {
        const cx = x + DX[d] * k, cy = y + DY[d] * k;
        if (!g.inb(cx, cy)) { ok = false; break; }
        const c = cy * n + cx;
        cells.push(c);
        const mk = g.erail[c];
        // まっすぐな区間だけ（分岐や曲がり角には置けない）。端のマスは外側へ曲がっていてもよい
        const inner = k > k0 && k < k0 + ESTOP_LEN - 1;
        if (!mk || (mk & along) === 0 || (inner && (mk & ~along) !== 0) || (inner && (mk & along) !== along)) ok = false;
      }
      last = cells;
      if (!ok) continue;
      // 端どうしもつながっていること
      for (let k = 0; k + 1 < cells.length && ok; k++) if (!(g.erail[cells[k]] & (1 << d))) ok = false;
      if (!ok) continue;
      // 同じ線路の上で、ほかの駅と重なったり、すぐ続いたりはできない（隣の線路に並べるのはよい）
      const ends = [cells[0], cells[cells.length - 1]].flatMap((c, k) => { const cx = (c % n) + DX[d] * (k ? 1 : -1), cy = ((c / n) | 0) + DY[d] * (k ? 1 : -1); return g.inb(cx, cy) ? [g.idx(cx, cy)] : []; });
      if (cells.some((c) => g.estn[c]) || ends.some((c) => g.estn[c] !== 0)) return fail('同じ線路の上に、すでに駅があります', cells);
      if (!estopRoads(g, cells).length) return fail('ホームの下か横に、一般の道路が必要です（歩いて出入りするため）', cells);
      return { ok: true, cells, remove: false, reason: '', cost: ESTOP_COST };
    }
  }
  return fail('高架鉄道のまっすぐな区間（4マス）に置いてください', last);
}

// 高架鉄道の駅のホームのマス（線路の上だけの駅か、敷地のある高架駅のまわり）。駅でなければ空
export function platformCells(g: Grid, cell: number, list: { type: string; x: number; y: number; w: number; h: number }[]): number[] {
  const n = g.n;
  if (!g.erail[cell]) return [];
  if (g.estn[cell]) return estopGroup(g, cell).filter((c) => g.erail[c]);
  const x = cell % n, y = (cell / n) | 0;
  for (const b of list) {
    if (b.type !== 'el_station') continue;
    if (x < b.x - 1 || x > b.x + b.w || y < b.y - 1 || y > b.y + b.h) continue;
    const out: number[] = [];
    for (let yy = b.y - 1; yy <= b.y + b.h; yy++) for (let xx = b.x - 1; xx <= b.x + b.w; xx++) if (g.inb(xx, yy) && g.erail[g.idx(xx, yy)]) out.push(g.idx(xx, yy));
    return out;
  }
  return [];
}
