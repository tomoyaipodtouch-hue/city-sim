// ツールの定義と、ドラッグ中のプレビュー・確定
import { BUS_STOP_COST, CIVIC, CivicId, DENSITY_NAMES, LINES, LineKind, ROADS, RoadType, ZoneType, ZONE_COST, ZONE_NAMES, POWER_LINE_COST, RAMP_COST } from '../sim/defs';
import { normRect, planBulldoze, planBusStop, planCloverleaf, planTransitLine, planDiamond, planLine, planPlop, planPowerLine, planRamp, planRoad, planZone, planURamp, planTerrain, TERRAIN_STEP, TerrainOp, snapRoadEnds } from '../sim/plan';
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
      { tool: 'road:8', name: ROADS[RoadType.UrbanHighway].name, note: `${yen(ROADS[8].cost)}/マス` },
      { tool: 'road:9', name: ROADS[RoadType.UrbanGroundHighway].name, note: `${yen(ROADS[9].cost)}/マス` },
      { tool: 'ramp', name: 'ランプ（出入口）', note: yen(RAMP_COST) },
      { tool: 'uramp', name: '都市高速のランプ（1×5）', note: yen(RAMP_COST * 3) },
      { tool: 'diamond', name: 'ダイヤモンド型インターチェンジ', note: '高速道路をタップ' },
      { tool: 'clover', name: 'クローバー型インターチェンジ', note: '高速道路の交差点をタップ' },
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
      { tool: 'plop:oil', name: CIVIC.oil.name, note: yen(CIVIC.oil.cost) },
      { tool: 'plop:wind', name: CIVIC.wind.name, note: yen(CIVIC.wind.cost) },
      { tool: 'plop:solar', name: CIVIC.solar.name, note: yen(CIVIC.solar.cost) },
      { tool: 'plop:nuclear', name: CIVIC.nuclear.name, note: yen(CIVIC.nuclear.cost) },
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
      { tool: 'plop:playground', name: `${CIVIC.playground.name}（1×2）`, note: yen(CIVIC.playground.cost) },
      { tool: 'plop:greenway', name: `${CIVIC.greenway.name}（1×3）`, note: yen(CIVIC.greenway.cost) },
      { tool: 'plop:sports', name: `${CIVIC.sports.name}（2×3）`, note: yen(CIVIC.sports.cost) },
      { tool: 'plop:garden', name: `${CIVIC.garden.name}（2×3）`, note: yen(CIVIC.garden.cost) },
      { tool: 'plop:cpark_a', name: `${CIVIC.cpark_a.name}（3×3・つなげられる）`, note: yen(CIVIC.cpark_a.cost) },
      { tool: 'plop:cpark_b', name: `${CIVIC.cpark_b.name}（3×4・つなげられる）`, note: yen(CIVIC.cpark_b.cost) },
      { tool: 'plop:police_s', name: CIVIC.police_s.name, note: yen(CIVIC.police_s.cost) },
      { tool: 'plop:police_l', name: CIVIC.police_l.name, note: yen(CIVIC.police_l.cost) },
      { tool: 'plop:fire_s', name: CIVIC.fire_s.name, note: yen(CIVIC.fire_s.cost) },
      { tool: 'plop:fire_l', name: CIVIC.fire_l.name, note: yen(CIVIC.fire_l.cost) },
      { tool: 'plop:clinic', name: CIVIC.clinic.name, note: yen(CIVIC.clinic.cost) },
      { tool: 'plop:hospital', name: CIVIC.hospital.name, note: yen(CIVIC.hospital.cost) },
      { tool: 'plop:school_e', name: CIVIC.school_e.name, note: yen(CIVIC.school_e.cost) },
      { tool: 'plop:school_h', name: CIVIC.school_h.name, note: yen(CIVIC.school_h.cost) },
      { tool: 'plop:college', name: CIVIC.college.name, note: yen(CIVIC.college.cost) },
      { tool: 'plop:library', name: CIVIC.library.name, note: yen(CIVIC.library.cost) },
      { tool: 'plop:landfill', name: CIVIC.landfill.name, note: yen(CIVIC.landfill.cost) },
      { tool: 'plop:incinerator', name: CIVIC.incinerator.name, note: yen(CIVIC.incinerator.cost) },
      { tool: 'plop:recycling', name: CIVIC.recycling.name, note: yen(CIVIC.recycling.cost) },
      { tool: 'plop:mayor_house', name: `記念：${CIVIC.mayor_house.name}`, note: '人口2千・評価55' },
      { tool: 'plop:statue', name: `記念：${CIVIC.statue.name}`, note: '人口5千・評価70' },
      { tool: 'plop:museum', name: `記念：${CIVIC.museum.name}`, note: '人口8千・評価55・教育90' },
      { tool: 'plop:city_hall', name: `記念：${CIVIC.city_hall.name}`, note: '人口1万・評価50' },
      { tool: 'plop:stadium', name: `記念：${CIVIC.stadium.name}`, note: '人口3万・評価60' },
    ],
  },
  {
    id: 'transit', name: '公共交通', icon: 'transit', items: [
      { tool: 'busstop', name: 'バス停（道路をタップ）', note: yen(BUS_STOP_COST) },
      { tool: 'line:rail', name: '鉄道の線路', note: `${yen(LINES.rail.cost)}/マス` },
      { tool: 'plop:station', name: CIVIC.station.name, note: yen(CIVIC.station.cost) },
      { tool: 'line:erail', name: '高架鉄道の線路', note: `${yen(LINES.erail.cost)}/マス` },
      { tool: 'plop:el_station', name: CIVIC.el_station.name, note: yen(CIVIC.el_station.cost) },
      { tool: 'line:mono', name: 'モノレールの線路', note: `${yen(LINES.mono.cost)}/マス` },
      { tool: 'plop:mono_station', name: CIVIC.mono_station.name, note: yen(CIVIC.mono_station.cost) },
      { tool: 'line:sub', name: '地下鉄の線路', note: `${yen(LINES.sub.cost)}/マス` },
      { tool: 'plop:sub_station', name: CIVIC.sub_station.name, note: yen(CIVIC.sub_station.cost) },
      { tool: 'plop:freight_st', name: CIVIC.freight_st.name, note: yen(CIVIC.freight_st.cost) },
      { tool: 'plop:ferry_p', name: CIVIC.ferry_p.name, note: yen(CIVIC.ferry_p.cost) },
      { tool: 'plop:ferry_c', name: CIVIC.ferry_c.name, note: yen(CIVIC.ferry_c.cost) },
      { tool: 'plop:seaport', name: CIVIC.seaport.name, note: yen(CIVIC.seaport.cost) },
      { tool: 'plop:airport_s', name: `${CIVIC.airport_s.name}（11×44）`, note: yen(CIVIC.airport_s.cost) },
      { tool: 'plop:airport_l', name: `${CIVIC.airport_l.name}（17×80）`, note: yen(CIVIC.airport_l.cost) },
    ],
  },
  {
    id: 'terrain', name: '地形', icon: 'terrain', items: [
      { tool: 'terrain:raise', name: '地面を上げる', note: `${TERRAIN_STEP}m ずつ` },
      { tool: 'terrain:lower', name: '地面を下げる', note: `${TERRAIN_STEP}m ずつ` },
      { tool: 'terrain:level', name: '平らにする', note: '始点の高さにそろえる' },
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
    // 地下鉄の線路と駅のツールでは、地下の画面にする
    this.r.setUnderground(t === 'line:sub' || t === 'plop:sub_station');
    // 取り壊しモードのときは、画面の上に黄色と黒のしまを出す
    let band = document.getElementById('demo-band');
    if (!band) {
      band = document.createElement('div');
      band.id = 'demo-band';
      document.body.append(band);
    }
    band.classList.toggle('on', t === 'bulldoze');
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
      const [sx0, sy0, sx1, sy1] = snapRoadEnds(g, type, d.x0, d.y0, x, y);
      const path = planLine(g, sx0, sy0, sx1, sy1);
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
    if (t.startsWith('line:')) {
      const kind = t.split(':')[1] as LineKind;
      const path = planLine(g, d.x0, d.y0, x, y);
      const plan = planTransitLine(g, path, kind);
      pv.setTiles(g, path.cells, (i) => (plan.bad.has(i) ? 0xe5534b : 0xffd27a));
      pv.setPath(g, path.cells);
      if (path.cells.length < 2) return { text: 'ドラッグして線路を引く', bad: false };
      return plan.ok ? { text: yen(plan.cost), bad: false } : { text: plan.reason || '引けません', bad: true };
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
    else if (t.startsWith('line:')) {
      if (d.x0 === d.x1 && d.y0 === d.y1) return;
      cmd = { t: 'transit', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, kind: t.split(':')[1] as LineKind };
    }
    else if (t.startsWith('zone:')) {
      const [, z, den] = t.split(':');
      cmd = { t: 'zone', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, zone: Number(z) as ZoneType, den: Number(den) };
    } else if (t === 'dezone') cmd = { t: 'zone', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, zone: ZoneType.None, den: 0 };
    else if (t.startsWith('terrain:')) cmd = { t: 'terrain', op: t.split(':')[1] as TerrainOp, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    else if (t === 'bulldoze') cmd = { t: 'bulldoze', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    else if (t.startsWith('plop:')) cmd = { t: 'plop', id: t.split(':')[1] as CivicId, x: d.x1, y: d.y1 };
    else if (t === 'ramp') cmd = { t: 'ramp', x: d.x1, y: d.y1 };
    else if (t === 'uramp') cmd = { t: 'uramp', x: d.x1, y: d.y1 };
    else if (t === 'busstop') cmd = { t: 'busstop', x: d.x1, y: d.y1 };
    else if (t === 'diamond') cmd = { t: 'diamond', x: d.x1, y: d.y1 };
    else if (t === 'clover') cmd = { t: 'clover', x: d.x1, y: d.y1 };
    if (!cmd) return;
    const res = await this.game.exec(cmd);
    if (res.ok) {
      if (cmd.t === 'road' || cmd.t === 'pline' || cmd.t === 'ramp' || cmd.t === 'uramp' || cmd.t === 'diamond' || cmd.t === 'clover' || cmd.t === 'transit') sfx.road();
      else if (cmd.t === 'busstop') sfx.plop();
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
