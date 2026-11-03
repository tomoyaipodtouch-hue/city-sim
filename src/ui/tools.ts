// ツールの定義と、ドラッグ中のプレビュー・確定
import { CIVIC, CivicId, DENSITY_NAMES, ROADS, RoadType, ZoneType, ZONE_COST, ZONE_NAMES, POWER_LINE_COST, RAMP_COST } from '../sim/defs';
import { normRect, planBulldoze, planDiamond, planLine, planPlop, planPowerLine, planRamp, planRoad, planZone } from '../sim/plan';
import type { Command } from '../sim/world';
import type { GameClient } from '../game';
import type { CityRenderer } from '../render/renderer';
import { sfx } from '../sound';

export interface ToolItem {
  tool?: string;
  name: string;
  note?: string;
  swatch?: string;
  disabled?: boolean;
}
export interface ToolGroup {
  id: string;
  name: string;
  icon: string;
  items?: ToolItem[];
  tool?: string; // 下位メニューがない場合
  soon?: string;
}

const yen = (v: number) => `§${Math.round(v).toLocaleString()}`;

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'road', name: '道路', icon: 'road', items: [
      { tool: 'road:1', name: ROADS[RoadType.Street].name, note: `${yen(ROADS[1].cost)}/マス` },
      { tool: 'road:2', name: ROADS[RoadType.Road].name, note: `${yen(ROADS[2].cost)}/マス` },
      { tool: 'road:3', name: ROADS[RoadType.OneWay].name, note: `${yen(ROADS[3].cost)}/マス` },
      { tool: 'road:4', name: `${ROADS[RoadType.Avenue].name}（2マス幅）`, note: `${yen(ROADS[4].cost * 2)}/マス` },
      { tool: 'road:5', name: `${ROADS[RoadType.Highway].name}（2マス幅）`, note: `${yen(ROADS[5].cost * 2)}/マス` },
      { tool: 'road:6', name: `${ROADS[RoadType.GroundHighway].name}（2マス幅）`, note: `${yen(ROADS[6].cost * 2)}/マス` },
      { tool: 'ramp', name: 'ランプ（出入口）', note: yen(RAMP_COST) },
      { tool: 'diamond', name: 'ダイヤモンド型インターチェンジ', note: '高速道路をタップ' },
      { name: 'クローバー型インターチェンジ', note: '今後追加', disabled: true },
    ],
  },
  {
    id: 'zone', name: 'ゾーン', icon: 'zone', items: [
      ...[1, 2, 3].flatMap((z) =>
        [0, 1, 2].map((d) => ({
          tool: `zone:${z}:${d}`,
          name: `${ZONE_NAMES[z]}（${DENSITY_NAMES[d]}）`,
          note: `${yen(ZONE_COST[z][d])}/マス`,
          swatch: `color-mix(in srgb, ${['', 'var(--r)', 'var(--c)', 'var(--i)'][z]} ${[55, 80, 100][d]}%, #000)`,
        })),
      ),
      { tool: 'dezone', name: 'ゾーン解除', note: '空き地のみ' },
    ],
  },
  {
    id: 'power', name: '電力', icon: 'power', items: [
      { tool: 'pline', name: '送電線', note: `${yen(POWER_LINE_COST)}/マス` },
      { tool: 'plop:coal', name: CIVIC.coal.name, note: yen(CIVIC.coal.cost) },
      { tool: 'plop:gas', name: CIVIC.gas.name, note: yen(CIVIC.gas.cost) },
    ],
  },
  {
    id: 'water', name: '水道', icon: 'water', items: [
      { tool: 'plop:pump', name: CIVIC.pump.name, note: yen(CIVIC.pump.cost) },
      { tool: 'plop:tower', name: CIVIC.tower.name, note: yen(CIVIC.tower.cost) },
    ],
  },
  {
    id: 'civic', name: '公共施設', icon: 'civic', items: [
      { tool: 'plop:park_s', name: CIVIC.park_s.name, note: yen(CIVIC.park_s.cost) },
      { tool: 'plop:park_l', name: CIVIC.park_l.name, note: yen(CIVIC.park_l.cost) },
      { tool: 'plop:plaza', name: CIVIC.plaza.name, note: yen(CIVIC.plaza.cost) },
      { name: '警察・消防・学校・病院', note: '今後追加', disabled: true },
    ],
  },
  {
    id: 'transit', name: '公共交通', icon: 'transit', items: [
      { name: 'バス停', note: '今後追加', disabled: true },
      { name: '鉄道・地下鉄', note: '今後追加', disabled: true },
      { name: '高架鉄道・モノレール', note: '今後追加', disabled: true },
      { name: 'フェリー・空港・港', note: '今後追加', disabled: true },
    ],
  },
  {
    id: 'terrain', name: '地形', icon: 'terrain', items: [
      { name: '地面を上げる・下げる', note: '今後追加', disabled: true },
      { name: '平らにする', note: '今後追加', disabled: true },
    ],
  },
  { id: 'bulldoze', name: '取り壊し', icon: 'bulldoze', tool: 'bulldoze' },
  { id: 'query', name: '情報', icon: 'query', tool: 'query' },
];

export interface DragState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PreviewInfo {
  text: string;
  bad: boolean;
}

const ZONE_HEX = [0, 0x49c25a, 0x4a8ff0, 0xe9b52a];

export class ToolController {
  tool = '';
  drag: DragState | null = null;
  onResult: ((ok: boolean, msg: string) => void) | null = null;

  constructor(private game: GameClient, private r: CityRenderer) {}

  setTool(t: string) {
    this.tool = t;
    this.drag = null;
    this.r.preview.clear();
    this.r.setShowGrid(!!t && t !== 'query');
  }

  get isDragTool() {
    return !!this.tool && this.tool !== 'query';
  }

  begin(x: number, y: number): PreviewInfo | null {
    this.drag = { x0: x, y0: y, x1: x, y1: y };
    return this.update(x, y);
  }

  update(x: number, y: number): PreviewInfo | null {
    const g = this.game.grid;
    const d = this.drag;
    if (!g || !d) return null;
    d.x1 = x;
    d.y1 = y;
    const pv = this.r.preview;
    const t = this.tool;
    this.r.kick();
    if (t.startsWith('road:')) {
      const type = Number(t.split(':')[1]) as RoadType;
      const path = planLine(g, d.x0, d.y0, x, y);
      const plan = planRoad(g, path, type);
      const cells = plan.lanes.flatMap((l) => l.cells);
      const conv = new Set(plan.converts);
      const upper = new Set(plan.lanes.flatMap((l) => l.cells.filter((_, k) => l.levels[k] === 1)));
      pv.setTiles(g, cells, (i) =>
        plan.bad.has(i) ? 0xe5534b : conv.has(i) ? 0xffb347 : upper.has(i) ? 0xb9a6ff : plan.deck.has(i) ? 0x6fc3ff : type === RoadType.Street ? 0xcfd6dc : 0xffffff,
      );
      pv.setPath(g, path.cells);
      if (path.cells.length < 2) return { text: 'ドラッグして道路を引く', bad: false };
      const extra = plan.bridgeCells ? `（橋 ${plan.bridgeCells} マス）` : '';
      return plan.ok ? { text: `${yen(plan.cost)}${extra}`, bad: false } : { text: plan.reason || '引けません', bad: true };
    }
    if (t === 'pline') {
      const path = planLine(g, d.x0, d.y0, x, y);
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
    if (t === 'bulldoze') {
      const rect = normRect(d.x0, d.y0, x, y, g.n);
      const plan = planBulldoze(g, rect, (id) => this.game.buildings.get(id));
      const cells = new Set<number>([...plan.roads, ...plan.lines, ...plan.trees]);
      for (const id of plan.buildings) {
        const b = this.game.buildings.get(id);
        if (!b) continue;
        for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) cells.add(g.idx(xx, yy));
      }
      const all = plan.cells.filter((i) => !cells.has(i));
      pv.setTiles(g, [...all, ...cells], (i) => (cells.has(i) ? 0xf07030 : 0x777777));
      pv.setPath(g, []);
      return cells.size ? { text: `取り壊し ${yen(plan.cost)}`, bad: false } : { text: '取り壊すものがありません', bad: true };
    }
    if (t === 'ramp') {
      const plan = planRamp(g, x, y);
      pv.setTiles(g, [g.idx(x, y)], () => (plan.ok ? 0x5cc46a : 0xe5534b));
      pv.setPath(g, plan.ok ? [plan.hb, plan.cell, plan.ha] : []);
      return plan.ok ? { text: `ランプ　${yen(plan.cost)}${plan.roads.length ? '' : '（道路をつないでください）'}`, bad: false } : { text: plan.reason, bad: true };
    }
    if (t === 'diamond') {
      const plan = planDiamond(g, x, y);
      pv.setTiles(g, plan.cells.length ? plan.cells : [g.idx(x, y)], (i) => (!plan.ok && (plan.bad.has(i) || !plan.cells.length) ? 0xe5534b : plan.ok ? 0x5cc46a : 0xf0b429));
      pv.setPath(g, []);
      return plan.ok ? { text: `インターチェンジ　${yen(plan.cost)}`, bad: false } : { text: plan.reason, bad: true };
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
    if (t.startsWith('road:')) {
      if (d.x0 === d.x1 && d.y0 === d.y1) return;
      cmd = { t: 'road', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, road: Number(t.split(':')[1]) as RoadType };
    } else if (t === 'pline') cmd = { t: 'pline', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    else if (t.startsWith('zone:')) {
      const [, z, den] = t.split(':');
      cmd = { t: 'zone', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, zone: Number(z) as ZoneType, den: Number(den) };
    } else if (t === 'dezone') cmd = { t: 'zone', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, zone: ZoneType.None, den: 0 };
    else if (t === 'bulldoze') cmd = { t: 'bulldoze', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    else if (t.startsWith('plop:')) cmd = { t: 'plop', id: t.split(':')[1] as CivicId, x: d.x1, y: d.y1 };
    else if (t === 'ramp') cmd = { t: 'ramp', x: d.x1, y: d.y1 };
    else if (t === 'diamond') cmd = { t: 'diamond', x: d.x1, y: d.y1 };
    if (!cmd) return;
    const res = await this.game.exec(cmd);
    if (res.ok) {
      if (cmd.t === 'road' || cmd.t === 'pline' || cmd.t === 'ramp' || cmd.t === 'diamond') sfx.road();
      else if (cmd.t === 'zone') sfx.zone();
      else if (cmd.t === 'bulldoze') sfx.bulldoze();
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
