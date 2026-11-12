// ツールの定義と、ドラッグ中のプレビュー・確定
import { CIVIC, CivicId, LineKind, RoadType, ZoneType } from '../sim/defs';
import { normRect, planBulldoze, planBusStop, planCloverleaf, planTransitLine, planDiamond, planLine, planPlop, planPowerLine, planRamp, planRoadCmd, planZone, planURamp, planTerrain, TerrainOp, planTrees, planEStop, planReclaim, BULLDOZE_LAYERS, BULLDOZE_LAYER_NAMES } from '../sim/plan';
import type { BulldozeLayer } from '../sim/plan';
import { JCT_FORMS, planJct, JctForm } from '../sim/jct';
import type { PreviewArrow } from '../render/previewLayer';
import type { Command } from '../sim/world';
import type { GameClient } from '../game';
import type { CityRenderer } from '../render/renderer';
import { sfx } from '../sound';
import { planAirport } from '../sim/airport';

// 空港の向き（8 方向。陸側（ターミナル）が向く方角）の名前
const DIR_NAMES = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
export function airRotLabel(rot: number) {
  const axis = rot & 1 ? ((rot & 3) === 1 ? '北東―南西' : '北西―南東') : rot % 4 === 2 ? '東西' : '南北';
  return `滑走路 ${axis}・ターミナルは${DIR_NAMES[rot & 7]}側`;
}

export { TOOL_GROUPS } from './menu';
const yen = (v: number) => `§${Math.round(v).toLocaleString()}`;
export type { ToolItem, ToolGroup, ToolSection } from './menu';

export interface DragState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fx0: number; // 指の位置（マス単位の小数）
  fy0: number;
  fx1: number;
  fy1: number;
  line: [number, number, number, number] | null; // 線を引くツールの始点・終点（向きをそろえたあと。大通りは格子点）
  key: string; // 前回のプレビューと同じなら作り直さない
  noop?: boolean; // 引いても何も変わらない（すでに同じ大通りがある）
}

// 8方向（東から時計回り）
const DIR8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// 始点 (sx, sy) から指 (fx, fy) への向きを、いちばん近い8方向にそろえる。
// hard = 必ずそろえる（大通り）。そうでなければ、ほぼその向き（10°以内か、ずれが 0.75 マス以内）のときだけ
function snap8(sx: number, sy: number, fx: number, fy: number, hard: boolean): [number, number] | null {
  const vx = fx - sx, vy = fy - sy;
  const len = Math.hypot(vx, vy);
  if (len < 1e-6) return [sx, sy];
  let best = 0, bd = -Infinity;
  for (let d = 0; d < 8; d++) {
    const [ux, uy] = DIR8[d];
    const dot = (vx * ux + vy * uy) / Math.hypot(ux, uy);
    if (dot > bd) { bd = dot; best = d; }
  }
  const [ux, uy] = DIR8[best];
  const ul = Math.hypot(ux, uy);
  const off = Math.abs(vx * uy - vy * ux) / ul; // 線からのずれ（マス）
  const ang = Math.asin(Math.min(1, off / len));
  if (!hard && ang > (10 * Math.PI) / 180 && off > 0.75) return null;
  const k = Math.max(0, Math.round(bd / ul));
  return [sx + ux * k, sy + uy * k];
}

const LAYER_KEY = 'pm.bulldozeLayer';
function loadBulldozeLayer(): BulldozeLayer {
  try {
    const v = sessionStorage.getItem(LAYER_KEY) as BulldozeLayer | null;
    if (v && BULLDOZE_LAYERS.includes(v)) return v;
  } catch { /* 読めなければ地上 */ }
  return 'ground';
}

export interface PreviewInfo {
  text: string;
  bad: boolean;
  info?: boolean; // 失敗ではない知らせ（灰色で見せる）
}

const ZONE_HEX = [0, 0x49c25a, 0x4a8ff0, 0xe9b52a, 0xb9a24e];

export class ToolController {
  tool = '';
  drag: DragState | null = null;
  // 取り壊す階層（地上・高架・地下・すべて）。このセッションの間は覚えておく
  bulldozeLayer: BulldozeLayer = loadBulldozeLayer();
  onResult: ((ok: boolean, msg: string) => void) | null = null;
  // 空港を置く向き（8 方向。0 = 陸側が東、2 = 南、奇数は斜め）
  airRot = 2;
  isAirportTool() {
    return this.tool.startsWith('plop:') && !!CIVIC[this.tool.split(':')[1] as CivicId]?.airfield;
  }

  constructor(private game: GameClient, private r: CityRenderer) {}

  // ジャンクションの計画は重いので、同じ地図・同じマス・同じ形なら使い回す
  private jctCache: { key: string; grid: unknown; plan: ReturnType<typeof planJct> } | null = null;
  private jctPlan(form: JctForm, x: number, y: number) {
    const g = this.game.grid!;
    const key = `${form}:${x}:${y}:${this.game.gridSeq}`;
    if (this.jctCache && this.jctCache.key === key && this.jctCache.grid === g && this.jctCache.plan) return this.jctCache.plan;
    const plan = planJct(g, form, x, y);
    this.jctCache = { key, grid: g, plan };
    return plan;
  }

  setTool(t: string) {
    this.tool = t;
    this.drag = null;
    this.r.preview.clear();
    this.r.setShowGrid(!!t && t !== 'query');
    // 地下鉄の線路と駅のツールでは、地下の画面にする
    this.r.setUnderground(t === 'line:sub' || t === 'plop:sub_station' || (t === 'bulldoze' && this.bulldozeLayer === 'sub'));
    // 取り壊しモードのときは、画面の上に黄色と黒のしまを出す
    let band = document.getElementById('demo-band');
    if (!band) {
      band = document.createElement('div');
      band.id = 'demo-band';
      document.getElementById('app')!.append(band);
    }
    band.classList.toggle('on', t === 'bulldoze');
  }

  setBulldozeLayer(l: BulldozeLayer) {
    this.bulldozeLayer = l;
    try { sessionStorage.setItem(LAYER_KEY, l); } catch { /* 保存できなくても使える */ }
    // 地下を選んだら、地下の画面にする
    if (this.tool === 'bulldoze') this.r.setUnderground(l === 'sub');
    this.r.kick();
  }

  get isDragTool() {
    return !!this.tool && this.tool !== 'query';
  }

  // fx, fy = 指の位置（マス単位の小数）。省略するとマスの中心
  begin(x: number, y: number, fx = x + 0.5, fy = y + 0.5): PreviewInfo | null {
    this.drag = { x0: x, y0: y, x1: x, y1: y, fx0: fx, fy0: fy, fx1: fx, fy1: fy, line: null, key: '' };
    return this.update(x, y, fx, fy) ?? null;
  }

  // 線を引くツールの始点・終点。大通りは格子点（指に近い角）で、なぞった線が中心線。8方向にそろえる
  private lineEnds(d: DragState): [number, number, number, number] {
    const n = this.game.grid?.n ?? 1;
    if (this.tool === 'road:4') {
      const sx = Math.max(0, Math.min(n, Math.round(d.fx0))), sy = Math.max(0, Math.min(n, Math.round(d.fy0)));
      const e = snap8(sx, sy, d.fx1, d.fy1, true)!;
      return [sx, sy, Math.max(0, Math.min(n, e[0])), Math.max(0, Math.min(n, e[1]))];
    }
    const e = snap8(d.x0 + 0.5, d.y0 + 0.5, d.fx1, d.fy1, false);
    if (!e) return [d.x0, d.y0, d.x1, d.y1];
    return [d.x0, d.y0, Math.max(0, Math.min(n - 1, Math.floor(e[0]))), Math.max(0, Math.min(n - 1, Math.floor(e[1])))];
  }

  // プレビューを作り直す。前回と同じなら undefined（表示はそのまま）
  update(x: number, y: number, fx = x + 0.5, fy = y + 0.5): PreviewInfo | null | undefined {
    const g = this.game.grid;
    const d = this.drag;
    if (!g || !d) return null;
    d.x1 = x;
    d.y1 = y;
    d.fx1 = fx;
    d.fy1 = fy;
    const pv = this.r.preview;
    const t = this.tool;
    const lineTool = t.startsWith('road:') || t.startsWith('line:') || t === 'pline';
    d.line = lineTool ? this.lineEnds(d) : null;
    const key = d.line ? d.line.join(',') : `${x},${y}`;
    if (key === d.key) return undefined;
    d.key = key;
    this.r.kick();
    pv.setArrows(g, [], 0);
    pv.setLineColor(0xffffff);
    if (t.startsWith('road:') && d.line) {
      const type = Number(t.split(':')[1]) as RoadType;
      const [lx0, ly0, lx1, ly1] = d.line;
      const plan = planRoadCmd(g, type, lx0, ly0, lx1, ly1);
      // 大通りの横でつなぐ道路のマス（と、横に向いている大通りの行き止まりの端）も、つなぎ直すマスとして見せる
      const stemJ = (plan.stemJoins ?? []).flatMap((q) => [q[0], q[1]]);
      const sideJ = [...(plan.sideJoins ?? []).map((q) => q[0]), ...stemJ];
      const cells = [...plan.lanes.flatMap((l) => l.cells), ...sideJ];
      const conv = new Set([...plan.converts, ...sideJ]);
      const upper = new Set(plan.lanes.flatMap((l) => l.cells.filter((_, k) => l.levels[k] === 1)));
      pv.setTiles(g, cells, (i) =>
        plan.bad.has(i) ? 0xe5534b : conv.has(i) ? 0xffb347 : upper.has(i) ? 0xb9a6ff : plan.deck.has(i) ? 0x6fc3ff : type === RoadType.Street ? 0xcfd6dc : 0xffffff,
      );
      // 一方通行の車線（大通りの2本の車線も）は、進む向きを矢印で見せる
      const arrows: PreviewArrow[] = [];
      for (const l of plan.lanes) {
        if (!l.oneWay || l.cells.length < 2) continue;
        const step = l.cells.length > 24 ? 3 : 2;
        for (let k = 1; k < l.cells.length; k += step) arrows.push({ cell: l.cells[k], dir: l.dirs[Math.min(k, l.dirs.length - 1)] });
      }
      pv.setArrows(g, arrows, plan.ok ? 0x1f6fe0 : 0xffffff);
      if (type === RoadType.Avenue) {
        // 中心線（中央分離帯）を緑の線で見せる
        pv.setLineColor(plan.ok ? 0x2fa24a : plan.noop ? 0xb9bec5 : 0xe5534b);
        pv.setGridLine(g, plan.centre ?? [[lx0, ly0], [lx1, ly1]]);
        if (lx0 === lx1 && ly0 === ly1) return { text: 'ドラッグして大通りを引く（指の線が中央分離帯）', bad: false };
      } else {
        pv.setPath(g, plan.path.cells);
        if (plan.path.cells.length < 2) return { text: 'ドラッグして道路を引く', bad: false };
      }
      let extra = plan.bridgeCells ? `（橋 ${plan.bridgeCells} マス）` : '';
      // 端をつなぎ先へ寄せたときは、どうつなぐかを書き添える
      const kinds = [plan.startKind, plan.endKind];
      const join = kinds.includes('tee') || stemJ.length ? 'T字でつなぎます' : kinds.includes('avenue') ? '続けてつなぎます' : kinds.includes('road') ? '道路につなぎます' : sideJ.length ? '横の道路もつなぎます' : '';
      if (join) extra += `（${join}）`;
      if (plan.note) extra += `（${plan.note}）`;
      d.noop = !!plan.noop;
      if (plan.noop) return { text: plan.reason, bad: false, info: true };
      return plan.ok ? { text: `${yen(plan.cost)}${extra}`, bad: false } : { text: plan.reason || '引けません', bad: true };
    }
    if (t.startsWith('line:') && d.line) {
      const kind = t.split(':')[1] as LineKind;
      const path = planLine(g, d.line[0], d.line[1], d.line[2], d.line[3]);
      const plan = planTransitLine(g, path, kind);
      pv.setTiles(g, path.cells, (i) => (plan.bad.has(i) ? 0xe5534b : 0xffd27a));
      pv.setPath(g, path.cells);
      if (path.cells.length < 2) return { text: 'ドラッグして線路を引く', bad: false };
      return plan.ok ? { text: yen(plan.cost), bad: false } : { text: plan.reason || '引けません', bad: true };
    }
    if (t === 'pline' && d.line) {
      const path = planLine(g, d.line[0], d.line[1], d.line[2], d.line[3]);
      const plan = planPowerLine(g, path);
      pv.setTiles(g, path.cells, (i) => (plan.bad.has(i) ? 0xe5534b : 0xf0d040));
      pv.setPath(g, path.cells);
      return plan.ok ? { text: yen(plan.cost), bad: false } : { text: plan.reason, bad: true };
    }
    if (t.startsWith('zone:') || t === 'dezone') {
      const rect = normRect(d.x0, d.y0, x, y, g.n);
      const [, zs, ds] = t === 'dezone' ? ['', '0', '0'] : t.split(':');
      const zone = Number(zs) as ZoneType;
      const plan = planZone(g, rect, zone, Number(ds));
      pv.setTiles(g, plan.cells, () => (zone ? ZONE_HEX[zone] : 0x888888));
      pv.setPath(g, []);
      const w = rect.x1 - rect.x0 + 1, h = rect.y1 - rect.y0 + 1;
      if (!plan.cells.length) return { text: `${w}×${h}　指定できる場所がありません`, bad: true };
      return { text: `${w}×${h}　${zone ? yen(plan.cost) : 'ゾーン解除'}`, bad: false };
    }
    if (t === 'trees') {
      const plan = planTrees(g, d.x0, d.y0, x, y);
      pv.setTiles(g, plan.cells, () => 0x4f9a3c);
      pv.setPath(g, []);
      return plan.cells.length ? { text: `木を植える ${yen(plan.cost)}`, bad: false } : { text: '木を植えられる場所がありません', bad: true };
    }
    if (t.startsWith('reclaim:')) {
      const style = Number(t.split(':')[1]);
      const plan = planReclaim(g, style, d.x0, d.y0, x, y);
      const q = new Set(plan.quay);
      pv.setTiles(g, [...plan.fill, ...plan.quay], (i) => (q.has(i) ? (style === 2 ? 0x6fbf7a : 0xf2c200) : 0xc9a26b));
      pv.setPath(g, []);
      if (!plan.fill.length && !plan.quay.length) return { text: '埋め立てや岸壁にできる水辺がありません', bad: true };
      return { text: `埋め立て ${plan.fill.length} マス・${style === 2 ? '遊歩道' : '岸壁'} ${plan.quay.length} マス　${yen(plan.cost)}`, bad: false };
    }
    if (t.startsWith('terrain:')) {
      const op = t.split(':')[1] as TerrainOp;
      const plan = planTerrain(g, op, d.x0, d.y0, x, y);
      const lk = new Set(plan.locked);
      pv.setTiles(g, [...plan.cells, ...plan.locked], (i) => (lk.has(i) ? 0xe5534b : op === 'raise' ? 0xc9a26b : op === 'lower' ? 0x6b8fc9 : 0xb8c46b));
      pv.setPath(g, []);
      if (!plan.changes.size) return { text: plan.locked.length ? '道路や建物があるところは変えられません' : 'これ以上は変えられません', bad: true };
      return { text: `${yen(plan.cost)}${plan.locked.length ? '（赤いマスは変わりません）' : ''}`, bad: false };
    }
    if (t === 'bulldoze') {
      const rect = normRect(d.x0, d.y0, x, y, g.n);
      const layer = this.bulldozeLayer;
      const plan = planBulldoze(g, rect, (id) => this.game.buildings.get(id), layer);
      // 選んだ階層で取り壊すものがあるマスだけを光らせる
      const cells = new Set<number>([...plan.roads, ...plan.lines, ...plan.trees, ...plan.transit]);
      for (const id of plan.buildings) {
        const b = this.game.buildings.get(id);
        if (!b) continue;
        for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) if (g.bldg[g.idx(xx, yy)] === id) cells.add(g.idx(xx, yy));
      }
      const all = plan.cells.filter((i) => !cells.has(i));
      pv.setTiles(g, [...all, ...cells], (i) => (cells.has(i) ? 0xf07030 : 0x777777));
      pv.setPath(g, []);
      const what = layer === 'all' ? '' : `（${BULLDOZE_LAYER_NAMES[layer]}）`;
      return cells.size ? { text: `取り壊し${what} ${yen(plan.cost)}`, bad: false } : { text: layer === 'all' ? '取り壊すものがありません' : `${BULLDOZE_LAYER_NAMES[layer]}には取り壊すものがありません`, bad: true };
    }
    if (t === 'estop') {
      const plan = planEStop(g, x, y);
      pv.setTiles(g, plan.cells, () => (plan.ok ? (plan.remove ? 0xf0b429 : 0x5cc46a) : 0xe5534b));
      pv.setPath(g, []);
      return plan.ok ? { text: plan.remove ? '駅を外す' : `高架駅 ${yen(plan.cost)}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t === 'busstop') {
      const plan = planBusStop(g, x, y);
      pv.setTiles(g, [g.idx(x, y)], () => (plan.ok ? (plan.remove ? 0xf0b429 : 0x5cc46a) : 0xe5534b));
      pv.setPath(g, []);
      return plan.ok ? { text: plan.remove ? 'バス停を外す' : `バス停　${yen(plan.cost)}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t === 'ramp') {
      const plan = planRamp(g, x, y);
      pv.setTiles(g, [g.idx(x, y)], () => (plan.ok ? 0x5cc46a : 0xe5534b));
      pv.setPath(g, plan.ok ? [plan.hb, plan.cell, plan.ha] : []);
      return plan.ok ? { text: `ランプ　${yen(plan.cost)}${plan.roads.length ? '' : '（道路をつないでください）'}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t === 'uramp') {
      const plan = planURamp(g, x, y);
      pv.setTiles(g, plan.cells.length ? plan.cells : [g.idx(x, y)], () => (plan.ok ? 0x5cc46a : 0xe5534b));
      pv.setPath(g, []);
      return plan.ok ? { text: `都市高速のランプ　${yen(plan.cost)}${plan.road < 0 ? '（真ん中に一般道をつないでください）' : ''}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t === 'clover') {
      const plan = planCloverleaf(g, x, y);
      pv.setTiles(g, plan.cells.length ? plan.cells : [g.idx(x, y)], (i) => (plan.ok ? 0x5cc46a : plan.bad.has(i) || !plan.cells.length ? 0xe5534b : 0xf0b429));
      pv.setPath(g, []);
      return plan.ok ? { text: `クローバー型　${yen(plan.cost)}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t.startsWith('jct:')) {
      const form = t.split(':')[1] as JctForm;
      const plan = this.jctPlan(form, x, y);
      pv.setTiles(g, plan.ok ? plan.cells : plan.bad.size ? [...plan.bad] : [g.idx(x, y)], () => (plan.ok ? 0x5cc46a : 0xe5534b));
      pv.setPath(g, []);
      return plan.ok ? { text: `ジャンクション　${yen(plan.cost)}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t === 'diamond') {
      const plan = planDiamond(g, x, y);
      pv.setTiles(g, plan.cells.length ? plan.cells : [g.idx(x, y)], (i) => (!plan.ok && (plan.bad.has(i) || !plan.cells.length) ? 0xe5534b : plan.ok ? 0x5cc46a : 0xf0b429));
      pv.setPath(g, []);
      return plan.ok ? { text: `インターチェンジ　${yen(plan.cost)}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t.startsWith('plop:') && CIVIC[t.split(':')[1] as CivicId]?.airfield) {
      // 空港：敷地（緑）、埋め立て（土色）、置けないマス（赤）。空港駅の線路を引く場所（紫）と、都市高速をつなげる場所（水色）
      const id = t.split(':')[1] as CivicId;
      const plan = planAirport(g, CIVIC[id].airfield!, x, y, this.airRot);
      const fill = new Set(plan.fill), st = new Set(plan.ports.stationNear), lot = new Set(plan.cells);
      const hw = plan.ports.highwayNear.filter((i) => !st.has(i));
      pv.setTiles(g, [...plan.cells, ...st, ...hw], (i) => (plan.bad.has(i) ? 0xe5534b : st.has(i) ? 0xc45cff : !lot.has(i) ? 0x6fc3ff : fill.has(i) ? 0xc9a26b : plan.ok ? 0x5cc46a : 0x9fb7a0));
      pv.setPath(g, []);
      const extra = plan.fill.length ? `（埋め立て ${plan.fill.length} マス・岸壁 ${plan.quay.length} マス）` : '';
      return plan.ok ? { text: `${CIVIC[id].name}　${yen(plan.cost)}${extra}　紫＝駅の線路、水色＝都市高速をつなぐ場所`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t.startsWith('plop:')) {
      const id = t.split(':')[1] as CivicId;
      const plan = planPlop(g, id, x, y);
      pv.setTiles(g, plan.cells, () => (plan.ok ? 0x5cc46a : 0xe5534b));
      pv.setPath(g, []);
      return plan.ok ? { text: `${CIVIC[id].name}　${yen(plan.cost)}`, bad: false } : { text: plan.reason, bad: true };
    }
    return null;
  }

  async commit(): Promise<void> {
    const d = this.drag;
    this.drag = null;
    this.r.preview.clear();
    if (!d) return;
    const t = this.tool;
    let cmd: Command | null = null;
    const ln = d.line ?? this.lineEnds(d);
    if (t.startsWith('road:')) {
      // すでに同じ大通りがある（プレビューで灰色の知らせ）ときは、何もしない
      if ((ln[0] === ln[2] && ln[1] === ln[3]) || d.noop) return;
      cmd = { t: 'road', x0: ln[0], y0: ln[1], x1: ln[2], y1: ln[3], road: Number(t.split(':')[1]) as RoadType };
    } else if (t === 'pline') cmd = { t: 'pline', x0: ln[0], y0: ln[1], x1: ln[2], y1: ln[3] };
    else if (t.startsWith('line:')) {
      if (ln[0] === ln[2] && ln[1] === ln[3]) return;
      cmd = { t: 'transit', x0: ln[0], y0: ln[1], x1: ln[2], y1: ln[3], kind: t.split(':')[1] as LineKind };
    }
    else if (t.startsWith('zone:')) {
      const [, z, den] = t.split(':');
      cmd = { t: 'zone', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, zone: Number(z) as ZoneType, den: Number(den) };
    } else if (t === 'dezone') cmd = { t: 'zone', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, zone: ZoneType.None, den: 0 };
    else if (t.startsWith('reclaim:')) cmd = { t: 'reclaim', style: Number(t.split(':')[1]), x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    else if (t.startsWith('terrain:')) cmd = { t: 'terrain', op: t.split(':')[1] as TerrainOp, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    else if (t === 'trees') cmd = { t: 'trees', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    else if (t === 'bulldoze') cmd = { t: 'bulldoze', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, layer: this.bulldozeLayer };
    else if (t.startsWith('plop:')) cmd = { t: 'plop', id: t.split(':')[1] as CivicId, x: d.x1, y: d.y1, ...(this.isAirportTool() ? { rot: this.airRot } : {}) };
    else if (t === 'ramp') cmd = { t: 'ramp', x: d.x1, y: d.y1 };
    else if (t === 'uramp') cmd = { t: 'uramp', x: d.x1, y: d.y1 };
    else if (t === 'busstop') cmd = { t: 'busstop', x: d.x1, y: d.y1 };
    else if (t === 'estop') cmd = { t: 'estop', x: d.x1, y: d.y1 };
    else if (t === 'diamond') cmd = { t: 'diamond', x: d.x1, y: d.y1 };
    else if (t === 'clover') cmd = { t: 'clover', x: d.x1, y: d.y1 };
    else if (t.startsWith('jct:') && JCT_FORMS.includes(t.split(':')[1] as JctForm)) cmd = { t: 'jct', form: t.split(':')[1] as JctForm, x: d.x1, y: d.y1 };
    if (!cmd) return;
    const res = await this.game.exec(cmd);
    if (res.ok) {
      if (cmd.t === 'road' || cmd.t === 'pline' || cmd.t === 'ramp' || cmd.t === 'uramp' || cmd.t === 'diamond' || cmd.t === 'clover' || cmd.t === 'jct' || cmd.t === 'transit') sfx.road();
      else if (cmd.t === 'busstop' || cmd.t === 'estop') sfx.plop();
      else if (cmd.t === 'zone') sfx.zone();
      else if (cmd.t === 'bulldoze' || cmd.t === 'terrain') sfx.bulldoze();
      else sfx.plop();
      if (res.msg) this.onResult?.(false, res.msg);
    } else {
      sfx.error();
      this.onResult?.(false, res.msg || 'できませんでした');
    }
  }

  cancel() {
    this.drag = null;
    this.r.preview.clear();
  }
}
