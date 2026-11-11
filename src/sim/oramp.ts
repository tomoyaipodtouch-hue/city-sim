// ---- 重ねランプ：高架の都市高速の真下を一般道が同じ向きに通るところで、高架から真下の一般道へ降りる（上る）短いランプ ----
// 首都高の出入口のように、高架の横を下りて、下の道路の車線（道の端か、道の真ん中）に入る。
//
// シミュレーションでは、ランプは「本線のマスの上空のノード」と「ORAMP_LEN マス先の地上のノード」を直接結ぶ 1本のつながり
// （出口は高架 → 地上、入口は地上 → 高架）。マスの道路はそのままで、ランプの始まりのマスに印（grid.oramp）をつける。
//   ・ランプの範囲（始まりから ORAMP_LEN マス先まで）は、本線も下の道路もまっすぐ（ほかのつながりがない）
//   ・下の道路：一般道（片側1車線）・一方通行・大通り。一方通行と大通りは、ランプと同じ向きに走る車線。
//     大通りの、高架の下ではない側の車線（反対車線）には、本線の右隣のマスへ降りる（ORAMP_PARTNER）
//   ・一般道・一方通行の上は、ランプが車線を1本ふさぐので、そのマスの容量を減らす
// 置き方：1回のタップで、出口と入口の組（向きごとに、手前に出口、先に入口）。片側1車線の本線は両方の向き。1本ずつも置ける。
import { Grid, ORAMP_ENTRY, ORAMP_LEN, ORAMP_MEDIAN, ORAMP_ON, ORAMP_PARTNER } from './grid';
import { CELL, DX, DY, isDiag, opp } from './constants';
import { RAMP_COST, RoadType, isUrbanElevated } from './defs';

export { ORAMP_LEN } from './grid';
export type ORampMode = 'set' | 'exit' | 'entry';
export const ORAMP_COST = RAMP_COST * 2; // 1本
// 一般道・一方通行の上で、ランプが車線をふさぐマスの容量の割合
export const ORAMP_NARROW_CAP = 0.5;

export interface ORampSpec {
  start: number; // ランプの始まりのマス（本線の側）
  a: number; // 本線の進む向き（= ランプを走る向き）
  entry: boolean;
  median: boolean;
  partner: boolean; // 一般道は本線の右隣のマス（大通りの反対車線）
}
export interface ORampPlan {
  ok: boolean;
  reason: string;
  ramps: ORampSpec[];
  cells: number[]; // プレビューで見せるマス
  bad: number[]; // 置けない理由のマス
  cost: number;
  note?: string;
}

export const orampUnder = (t: number) => t === RoadType.Road || t === RoadType.OneWay || t === RoadType.Avenue;
const bit = (d: number) => 1 << (d & 7);

export function encodeORamp(r: ORampSpec) {
  return ORAMP_ON | (r.a & 7) | (r.entry ? ORAMP_ENTRY : 0) | (r.median ? ORAMP_MEDIAN : 0) | (r.partner ? ORAMP_PARTNER : 0);
}
export function decodeORamp(g: Grid, start: number): ORampSpec | null {
  const v = g.oramp[start];
  if (!(v & ORAMP_ON)) return null;
  return { start, a: v & 7, entry: !!(v & ORAMP_ENTRY), median: !!(v & ORAMP_MEDIAN), partner: !!(v & ORAMP_PARTNER) };
}
export function step(g: Grid, c: number, d: number, k = 1) {
  const n = g.n, x = (c % n) + DX[d & 7] * k, y = ((c / n) | 0) + DY[d & 7] * k;
  return g.inb(x, y) ? y * n + x : -1;
}
// 本線のマス k（0..ORAMP_LEN）と、その下の一般道のマス
export function orampHw(g: Grid, r: ORampSpec): number[] {
  return Array.from({ length: ORAMP_LEN + 1 }, (_, k) => step(g, r.start, r.a, k));
}
export function orampGround(g: Grid, r: ORampSpec): number[] {
  return orampHw(g, r).map((c) => (c < 0 ? -1 : r.partner ? step(g, c, (r.a + 2) & 7) : c));
}
// ランプが本線のどちら側の横を通るか（+1 = 進む向きの右、-1 = 左）。片側1車線の本線は、いつも自分の車線の側（右）
export function orampSide(g: Grid, r: ORampSpec) {
  const t = g.up[r.start];
  if (t === RoadType.UrbanHighway1W && r.median) return -1;
  return 1;
}

// 本線のマスで、向き a の車線があり、まっすぐ（ほかのつながりがない）か
function hwOk(g: Grid, c: number, a: number) {
  if (c < 0 || !isUrbanElevated(g.up[c])) return false;
  const axis = bit(a) | bit(opp(a));
  return (g.conn1[c] & ~axis) === 0 && (g.conn1[c] & axis) === axis && (g.flow1[c] & bit(a)) !== 0;
}
// 下の一般道のマスで、向き a に走れて、まっすぐか
function groundOk(g: Grid, c: number, a: number) {
  if (c < 0 || !orampUnder(g.road[c]) || g.up[c] && !isUrbanElevated(g.up[c])) return false;
  const axis = bit(a) | bit(opp(a));
  return (g.conn[c] & ~axis) === 0 && (g.conn[c] & axis) === axis && (g.flow[c] & bit(a)) !== 0;
}
// 本線のマス c の真下で、向き a の車が走る一般道のマス（真下か、大通りの反対車線）。なければ -1
export function groundFor(g: Grid, c: number, a: number): { cell: number; partner: boolean } | null {
  if (groundOk(g, c, a)) return { cell: c, partner: false };
  if (g.road[c] === RoadType.Avenue && !isDiag(a)) {
    const p = step(g, c, (a + 2) & 7);
    if (p >= 0 && g.road[p] === RoadType.Avenue && groundOk(g, p, a)) return { cell: p, partner: true };
  }
  return null;
}

// ランプが本線の横で使う場所（マスと、本線から見た向き）。ほかのランプと重ならないようにする
function occupancy(g: Grid, r: ORampSpec): number[] {
  const sd = orampSide(g, r) > 0 ? (r.a + 2) & 7 : (r.a + 6) & 7;
  const out: number[] = [];
  for (let k = 0; k < ORAMP_LEN; k++) {
    const c = step(g, r.start, r.a, k);
    if (c >= 0) out.push(c * 8 + sd);
  }
  return out;
}

// 1本のランプを確かめる。others = ほかのランプ（重なりを調べる）
export function checkORamp(g: Grid, r: ORampSpec, others: ORampSpec[] | null): { reason: string; bad: number[] } {
  const hw = orampHw(g, r);
  if (hw.some((c) => c < 0)) return { reason: 'マップの端に近すぎます', bad: hw.filter((c) => c >= 0) };
  const badHw = hw.filter((c) => !hwOk(g, c, r.a));
  if (badHw.length) return { reason: `高架の都市高速のまっすぐな区間（${ORAMP_LEN + 1}マス）に置いてください（分かれ道・曲がり角・ランプの近くには置けません）`, bad: badHw };
  const gr = orampGround(g, r);
  const badG = hw.filter((c, k) => gr[k] < 0 || !groundOk(g, gr[k], r.a));
  if (badG.length) return { reason: `真下に、同じ向きに走る一般道・一方通行・大通りがまっすぐ（${ORAMP_LEN + 1}マス）続いている所に置いてください（交差点には置けません）`, bad: badG };
  if (others) {
    const occ = new Set(occupancy(g, r));
    for (const o of others) {
      if (o.start === r.start || occupancy(g, o).some((q) => occ.has(q))) return { reason: 'ほかの重ねランプと重なります', bad: hw.slice(0, ORAMP_LEN) };
    }
  }
  return { reason: '', bad: [] };
}

export function listORamps(g: Grid): ORampSpec[] {
  const out: ORampSpec[] = [];
  for (let c = 0; c < g.oramp.length; c++) if (g.oramp[c] & ORAMP_ON) out.push(decodeORamp(g, c)!);
  return out;
}

// 本線のつながりや下の道路がなくなった重ねランプを取り除く（取り壊し・道路の引き直しのあと）
export function pruneORamps(g: Grid) {
  let k = 0;
  for (let c = 0; c < g.oramp.length; c++) {
    if (!g.oramp[c]) continue;
    const r = decodeORamp(g, c);
    if (!r || checkORamp(g, r, null).reason) { g.oramp[c] = 0; k++; }
  }
  return k;
}

// ---- 組（セット）の並び ----
// 基準のマス T と、本線の軸の向き a0（0..3）から、ランプの場所を決める。
//   a0 の向き：出口 T-4 … T、入口 T … T+4
//   反対の向き b：出口 T+3 … T-1、入口 T-1 … T-5（本線の反対側の横）
export interface ORampSlot { a: number; entry: boolean; start: number }
export function orampSlots(g: Grid, T: number, a0: number): ORampSlot[] {
  const b = opp(a0);
  const twoWay = g.up[T] === RoadType.UrbanHighway;
  const out: ORampSlot[] = [];
  const dirs = twoWay ? [a0, b] : [a0, b].filter((a) => g.flow1[T] & bit(a));
  for (const a of dirs) {
    if (a === a0) out.push({ a, entry: false, start: step(g, T, a0, -ORAMP_LEN) }, { a, entry: true, start: T });
    else out.push({ a, entry: false, start: step(g, T, a0, ORAMP_LEN - 1) }, { a, entry: true, start: step(g, T, a0, -1) });
  }
  return out;
}
// ランプから、その組の基準のマス T と軸 a0
export function orampAnchor(g: Grid, r: ORampSpec): { T: number; a0: number } {
  const a0 = r.a & 3;
  const L = ORAMP_LEN;
  let T: number;
  if (r.a === a0) T = r.entry ? r.start : step(g, r.start, a0, L);
  else T = r.entry ? step(g, r.start, a0, 1) : step(g, r.start, a0, -(L - 1));
  return { T, a0 };
}

// タップしたマスの、本線の軸の向き（0..3）
function axisAt(g: Grid, c: number) {
  for (let d = 0; d < 4; d++) if ((g.conn1[c] & bit(d)) && (g.conn1[c] & bit(d + 4))) return d;
  return -1;
}

export function planORamp(g: Grid, mode: ORampMode, x: number, y: number, fx = x + 0.5, fy = y + 0.5): ORampPlan {
  const fail = (reason: string, bad: number[] = []): ORampPlan => ({ ok: false, reason, ramps: [], cells: bad, bad, cost: 0 });
  if (!g.inb(x, y)) return fail('マップの外です');
  const T = g.idx(x, y);
  if (!isUrbanElevated(g.up[T]) || !orampUnder(g.road[T])) return fail('高架の都市高速の真下を一般道・一方通行・大通りが通っているマスをタップしてください', [T]);
  const a0 = axisAt(g, T);
  if (a0 < 0) return fail('高架の都市高速のまっすぐな区間をタップしてください', [T]);
  if (isDiag(a0) && g.road[T] === RoadType.Avenue) return fail('斜めの大通りの上には、重ねランプは置けません', [T]);
  const ground = (a: number) => groundFor(g, T, a) !== null;
  const existing = listORamps(g);
  const specs: ORampSpec[] = [];
  const mk = (a: number, entry: boolean, start: number): ORampSpec => ({ start, a, entry, median: false, partner: !!groundFor(g, T, a)?.partner });
  let note = '';
  if (mode === 'set') {
    const slots = orampSlots(g, T, a0);
    const okDirs = new Set(slots.map((s) => s.a).filter(ground));
    if (!okDirs.size) return fail('真下の道路が、高架と同じ向きに走っていません', [T]);
    for (const s of slots) if (okDirs.has(s.a)) specs.push(mk(s.a, s.entry, s.start));
    if (okDirs.size < new Set(slots.map((s) => s.a)).size) note = '下の道路が一方通行なので、片方の向きだけ';
  } else {
    // 向き：一方通行の本線はその向き。片側1車線の本線は、タップした位置に近い側の車線（右側通行なので、その側を走る向き）
    const cand = [a0, opp(a0)].filter((a) => g.flow1[T] & bit(a));
    let a = cand[0];
    if (cand.length === 2) {
      const rx = -DY[a0], ry = DX[a0]; // a0 の右
      const side = (fx - (x + 0.5)) * rx + (fy - (y + 0.5)) * ry;
      a = side >= 0 ? a0 : opp(a0);
      if (!ground(a) && ground(opp(a))) a = opp(a);
    }
    if (!ground(a)) return fail('真下の道路が、高架と同じ向きに走っていません', [T]);
    specs.push(mk(a, mode === 'entry', step(g, T, a, -2)));
  }
  const cells = new Set<number>();
  for (const r of specs) {
    if (r.start < 0) return fail('マップの端に近すぎます', [T]);
    const chk = checkORamp(g, r, [...existing, ...specs.filter((q) => q !== r)]);
    for (const c of orampHw(g, r)) if (c >= 0) cells.add(c);
    if (chk.reason) return { ok: false, reason: chk.reason, ramps: specs, cells: [...cells, ...chk.bad], bad: chk.bad, cost: 0 };
  }
  return { ok: true, reason: '', ramps: specs, cells: [...cells], bad: [], cost: specs.length * ORAMP_COST, note };
}

export function applyORamp(g: Grid, p: ORampPlan) {
  for (const r of p.ramps) g.oramp[r.start] = encodeORamp(r);
}

// 重ねランプが通るマス（本線のマスと下の一般道のマス）にかかっているランプ
export function orampsAt(g: Grid, cell: number): ORampSpec[] {
  const out: ORampSpec[] = [];
  for (const r of listORamps(g)) {
    const hw = orampHw(g, r), gr = orampGround(g, r);
    if (hw.includes(cell) || gr.includes(cell)) out.push(r);
  }
  return out;
}

// 情報ツールから：組の、向き a のランプを want（1 = 出口、2 = 入口）にする。median は新しく置くランプの降りる位置
export function editORampDir(g: Grid, T: number, a0: number, a: number, want: number): { ok: boolean; reason: string; added: number; removed: number } {
  const slots = orampSlots(g, T, a0).filter((s) => s.a === a);
  if (!slots.length) return { ok: false, reason: 'この向きには置けません', added: 0, removed: 0 };
  const cur = slots.map((s) => (s.start >= 0 ? decodeORamp(g, s.start) : null)).map((r, k) => (r && r.a === a && r.entry === slots[k].entry ? r : null));
  const sib = cur.find((r) => r);
  const median = sib ? sib.median : false;
  const gf = groundFor(g, T, a);
  const others = listORamps(g).filter((o) => !slots.some((s) => s.start === o.start));
  const adds: ORampSpec[] = [];
  let removed = 0;
  slots.forEach((s, k) => {
    const on = (want & (s.entry ? 2 : 1)) !== 0;
    if (!on && cur[k]) removed++;
    if (on && !cur[k]) adds.push({ start: s.start, a, entry: s.entry, median, partner: !!gf?.partner });
  });
  for (const r of adds) {
    if (r.start < 0 || !gf) return { ok: false, reason: 'ここには置けません（マップの端か、下の道路の向きが合いません）', added: 0, removed: 0 };
    const keep = cur.filter((q, k) => q && (want & (slots[k].entry ? 2 : 1))) as ORampSpec[];
    const chk = checkORamp(g, r, [...others, ...keep, ...adds.filter((q) => q !== r)]);
    if (chk.reason) return { ok: false, reason: chk.reason, added: 0, removed: 0 };
  }
  slots.forEach((s, k) => { if (cur[k] && !(want & (s.entry ? 2 : 1))) g.oramp[s.start] = 0; });
  for (const r of adds) g.oramp[r.start] = encodeORamp(r);
  return { ok: true, reason: '', added: adds.length, removed };
}

// 降りる（上る）位置を変える
export function setORampSide(g: Grid, start: number, median: boolean): { ok: boolean; reason: string } {
  const r = decodeORamp(g, start);
  if (!r) return { ok: false, reason: '重ねランプが見つかりません' };
  const nr = { ...r, median };
  const chk = checkORamp(g, nr, listORamps(g).filter((o) => o.start !== start));
  if (chk.reason) return { ok: false, reason: chk.reason };
  g.oramp[start] = encodeORamp(nr);
  return { ok: true, reason: '' };
}

// 容量の割合（ノードごと、1 = そのまま）。一般道・一方通行の上で、ランプが車線をふさぐマス
export function orampCapScale(g: Grid): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of listORamps(g)) {
    const gr = orampGround(g, r);
    const ks = r.entry ? [0, 1] : [ORAMP_LEN - 2, ORAMP_LEN - 1];
    for (const k of ks) {
      const c = gr[k];
      if (c >= 0 && (g.road[c] === RoadType.Road || g.road[c] === RoadType.OneWay)) m.set(c, ORAMP_NARROW_CAP);
    }
  }
  return m;
}

// ランプを走る長さ（m）
export function orampLength(a: number) {
  return ORAMP_LEN * (isDiag(a) ? CELL * Math.SQRT2 : CELL);
}
export const ORAMP_SPEED = 40; // ランプの制限速度（km/h）
// 方角の名前（向きごと）
export const DIR_NAMES = ['東行き', '南東行き', '南行き', '南西行き', '西行き', '北西行き', '北行き', '北東行き'];
