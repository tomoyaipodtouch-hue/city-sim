// 左のツールのメニュー（グループ → 見出し → 項目）。絵（サムネイル）の作り方と、費用・維持費・大きさもここで決める。
// DOM や three.js には触らない（テストから読める）
import { BUS_STOP_COST, CIVIC, CivicId, DENSITY_NAMES, ESTOP_COST, ESTOP_UPKEEP, LINES, LineKind, POWER_LINE_COST, POWER_LINE_UPKEEP, RAMP_COST, ROADS, RoadType, ZONE_COST, ZONE_NAMES } from '../sim/defs';
import type { GrowKind } from '../sim/defs';
import { TERRAIN_STEP, RECLAIM_COST, TREE_COST, ESTOP_LEN } from '../sim/plan';
import { REWARD_REQ } from '../sim/governance';

// 項目の絵：
//  civic = 公共施設の 3D の絵（建物を作る関数でそのまま作る）
//  grow  = ゾーンに建つ建物の見本（地面をゾーンの色にする）
//  trees = 木を植えた地面
//  icon  = 線で描いた絵（道路・線路・地形など。menuIcons.ts）
export type ThumbSpec =
  | { k: 'civic'; id: CivicId }
  | { k: 'grow'; type: GrowKind; den: number; floors: number; w: number; h: number; tint: number }
  | { k: 'trees' }
  | { k: 'airport'; size: 1 | 2 | 3 } // 空港：ターミナル・管制塔・駐機中の飛行機のあたりを切り取って描く
  | { k: 'icon'; icon: string };

export interface ToolItem {
  tool: string;
  name: string;
  thumb: ThumbSpec;
  cost?: number; // 建設費（perCell なら 1マスあたり）
  perCell?: boolean;
  upkeep?: number; // 月の維持費（perCell なら 1マスあたり）
  size?: string; // 「3×2」「幅2マス」など
  hint?: string; // 2行目の終わりに足す短い説明（「高速道路をタップ」など）
  req?: string; // 記念施設を建てられる条件（短い形）
  reward?: CivicId; // 記念施設（条件を満たすまで灰色）
  desc?: string; // 選んだときのトーストの説明
  disabled?: boolean;
}
export interface ToolSection {
  title: string;
  items: ToolItem[];
}
export interface ToolGroup {
  id: string;
  name: string;
  icon: string;
  sections?: ToolSection[];
  tool?: string; // 下位メニューがない場合
}

const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
export const yen = (v: number) => `§${fmt(v)}`;

// 2行目：「§4,000 ・ 維持 §220/月 ・ 3×2」
export function metaLine(it: ToolItem): string {
  return metaParts(it).join(' ・ ');
}
export function metaParts(it: ToolItem): string[] {
  const p: string[] = [];
  if (it.cost !== undefined) p.push(`${yen(it.cost)}${it.perCell ? '/マス' : ''}`);
  if (it.upkeep !== undefined && it.upkeep > 0) p.push(`維持 ${yen(it.upkeep)}${it.perCell ? '/マス' : ''}/月`);
  if (it.size) p.push(it.size);
  if (it.hint) p.push(it.hint);
  return p;
}

export function allItems(g: ToolGroup): ToolItem[] {
  return (g.sections || []).flatMap((s) => s.items);
}

// 公共施設（置くもの）
const civ = (id: CivicId, name?: string, extra: Partial<ToolItem> = {}): ToolItem => {
  const c = CIVIC[id];
  return {
    tool: `plop:${id}`, name: name ?? c.name, thumb: { k: 'civic', id }, cost: c.cost, upkeep: c.upkeep, size: `${c.w}×${c.h}`,
    hint: c.waterfront ? '水辺' : undefined, desc: c.desc, ...extra,
  };
};
// 記念施設
const REQ_SHORT: Record<string, string> = {
  mayor_house: '人口2千・評価55', statue: '人口5千・評価70', museum: '人口8千・評価55・教育90',
  city_hall: '人口1万・評価50', stadium: '人口3万・評価60', future_stadium: '人口3万・評価60',
};
const reward = (id: CivicId) => civ(id, undefined, { reward: id, req: REQ_SHORT[id] ?? REWARD_REQ[id]?.label });

// 道路（1マスあたり。2マス幅の道路は、引いた長さ 1マスあたりの費用）
const road = (t: RoadType, icon: string, extra: Partial<ToolItem> = {}): ToolItem => {
  const r = ROADS[t], k = r.wide ? 2 : 1;
  return { tool: `road:${t}`, name: r.name, thumb: { k: 'icon', icon }, cost: r.cost * k, upkeep: r.upkeep * k, perCell: true, size: r.wide ? '幅2マス' : undefined, ...extra };
};
const line = (kind: LineKind, name: string, icon: string): ToolItem => ({
  tool: `line:${kind}`, name, thumb: { k: 'icon', icon }, cost: LINES[kind].cost, upkeep: LINES[kind].upkeep, perCell: true,
});

// ゾーンの見本の建物：[種類, 密度, 階数, 幅, 奥行き]
const ZONE_SAMPLE: Record<number, [GrowKind, number, number, number, number][]> = {
  1: [['R2', 0, 0, 1, 1], ['R2', 1, 5, 2, 2], ['R3', 2, 22, 2, 2]],
  2: [['CS2', 0, 0, 2, 1], ['CS2', 1, 4, 2, 2], ['CO3', 2, 28, 2, 2]],
  3: [['ID', 0, 0, 3, 3], ['IM', 1, 0, 3, 3], ['IH', 2, 0, 3, 3]],
};
const ZONE_TINT = [0, 0x49c25a, 0x4a8ff0, 0xe9b52a];
const ZONE_DESC = [
  '',
  '住宅が建つ。密度が高いほど、高い集合住宅やタワーマンションになる',
  '店やオフィスが建つ。密度が高いほど、高いビルになる',
  '工場や倉庫が建つ。密度が高いほど、大きな工場やハイテク産業になる',
];
const zone = (z: number, d: number): ToolItem => {
  const [type, den, floors, w, h] = ZONE_SAMPLE[z][d];
  return {
    tool: `zone:${z}:${d}`, name: `${ZONE_NAMES[z]}（${DENSITY_NAMES[d]}）`, thumb: { k: 'grow', type, den, floors, w, h, tint: ZONE_TINT[z] },
    cost: ZONE_COST[z][d], perCell: true, desc: ZONE_DESC[z],
  };
};

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'road', name: '道路', icon: 'road', sections: [
      {
        title: '一般の道路', items: [
          road(RoadType.Street, 'street'),
          road(RoadType.Road, 'road'),
          road(RoadType.OneWay, 'oneway', { hint: '引いた向きに走る' }),
          road(RoadType.Avenue, 'avenue'),
        ],
      },
      {
        title: '高速道路', items: [
          road(RoadType.Highway, 'hw'),
          road(RoadType.GroundHighway, 'ghw'),
        ],
      },
      {
        title: '都市高速', items: [
          road(RoadType.UrbanHighway, 'uhw'),
          road(RoadType.UrbanGroundHighway, 'ughw'),
          road(RoadType.UrbanHighway1W, 'uhw1', { hint: '引いた向きに走る' }),
          road(RoadType.UrbanGroundHighway1W, 'ughw1', { hint: '引いた向きに走る' }),
        ],
      },
      {
        title: 'ランプ・インターチェンジ', items: [
          { tool: 'ramp', name: 'ランプ（出入口）', thumb: { k: 'icon', icon: 'ramp' }, cost: RAMP_COST, desc: '高速道路と一般の道路をつなぐ出入口' },
          { tool: 'uramp', name: 'ランプ（都市高速）', thumb: { k: 'icon', icon: 'uramp' }, cost: RAMP_COST * 3, size: '1×5', desc: '都市高速と一般の道路をつなぐ坂道' },
          { tool: 'diamond', name: 'ダイヤモンド型インターチェンジ', thumb: { k: 'icon', icon: 'diamond' }, hint: '高速道路をタップ' },
          { tool: 'clover', name: 'クローバー型インターチェンジ', thumb: { k: 'icon', icon: 'clover' }, hint: '高速道路の交差点をタップ' },
        ],
      },
      {
        title: 'ジャンクション', items: [
          { tool: 'jct:tee', name: 'T字・Y字', thumb: { k: 'icon', icon: 'jct_tee' }, hint: '都市高速が合わさるマスをタップ', desc: '都市高速どうしを T字・Y字につなぐジャンクション' },
          { tool: 'jct:semi', name: '十字・準直結型', thumb: { k: 'icon', icon: 'jct_semi' }, hint: '都市高速の交差をタップ', desc: '都市高速の十字の交差を、準直結型のジャンクションにする' },
          { tool: 'jct:clover', name: '十字・クローバー型', thumb: { k: 'icon', icon: 'jct_clover' }, hint: '集散路つき・交差をタップ', desc: '都市高速の十字の交差を、集散路つきのクローバー型ジャンクションにする' },
          { tool: 'jct:turbine', name: '十字・タービン型', thumb: { k: 'icon', icon: 'jct_turbine' }, hint: '都市高速の交差をタップ', desc: '都市高速の十字の交差を、タービン型のジャンクションにする' },
        ],
      },
    ],
  },
  {
    id: 'zone', name: 'ゾーン', icon: 'zone', sections: [
      { title: '住宅', items: [0, 1, 2].map((d) => zone(1, d)) },
      { title: '商業', items: [0, 1, 2].map((d) => zone(2, d)) },
      { title: '工業', items: [0, 1, 2].map((d) => zone(3, d)) },
      {
        title: '農地・ゾーン解除', items: [
          {
            tool: 'zone:4:0', name: '農地', thumb: { k: 'grow', type: 'IA', den: 0, floors: 0, w: 2, h: 2, tint: 0xb9a24e },
            cost: ZONE_COST[4][0], perCell: true, hint: '8×8ごとに農家1軒', desc: '8×8マスごとに農家が1軒建ち、残りは畑になる',
          },
          { tool: 'dezone', name: 'ゾーン解除', thumb: { k: 'icon', icon: 'dezone' }, hint: '空き地のみ', desc: '建物のない空き地のゾーンを外す' },
        ],
      },
    ],
  },
  {
    id: 'power', name: '電力', icon: 'power', sections: [
      {
        title: '送電', items: [
          { tool: 'pline', name: '送電線', thumb: { k: 'icon', icon: 'pline' }, cost: POWER_LINE_COST, upkeep: POWER_LINE_UPKEEP, perCell: true, desc: '発電所から離れた所へ電気を送る' },
        ],
      },
      { title: '火力発電', items: [civ('coal'), civ('gas'), civ('oil')] },
      { title: '再生可能エネルギー', items: [civ('wind'), civ('solar')] },
      { title: '原子力発電', items: [civ('nuclear'), civ('nuclear_in'), civ('nuclear_sea')] },
    ],
  },
  {
    id: 'water', name: '水道', icon: 'water', sections: [
      { title: 'ポンプ・給水塔', items: [civ('pump'), civ('tower')] },
      { title: '浄水施設', items: [civ('water_plant'), civ('desal')] },
    ],
  },
  {
    id: 'civic', name: '公共施設', icon: 'civic', sections: [
      {
        title: '公園', items: [
          civ('park_s'), civ('park_l'), civ('plaza'), civ('playground'), civ('greenway'), civ('sports'), civ('garden'),
          civ('cpark_a', undefined, { hint: 'つなげられる' }), civ('cpark_b', undefined, { hint: 'つなげられる' }),
        ],
      },
      { title: '警察', items: [civ('police_s'), civ('police_l')] },
      { title: '消防', items: [civ('fire_s'), civ('fire_l')] },
      { title: '医療', items: [civ('clinic'), civ('hospital')] },
      { title: '教育', items: [civ('school_e'), civ('school_h'), civ('college'), civ('library')] },
      { title: 'ごみ処理', items: [civ('landfill'), civ('incinerator'), civ('incinerator_l'), civ('recycling')] },
      { title: '霊園・斎場', items: [civ('cemetery'), civ('crematorium')] },
      { title: '税関（CIQ）', items: [civ('ciq')] },
      { title: '記念施設', items: [reward('mayor_house'), reward('statue'), reward('museum'), reward('city_hall'), reward('stadium'), reward('future_stadium')] },
    ],
  },
  {
    id: 'transit', name: '公共交通', icon: 'transit', sections: [
      {
        title: 'バス', items: [
          { tool: 'busstop', name: 'バス停', thumb: { k: 'civic', id: 'busstop' }, cost: BUS_STOP_COST, upkeep: CIVIC.busstop.upkeep, hint: '道路をタップ', desc: CIVIC.busstop.desc },
        ],
      },
      { title: '鉄道', items: [line('rail', '鉄道の線路', 'rail'), civ('station'), civ('freight_st')] },
      {
        title: '高架鉄道', items: [
          line('erail', '鉄道の線路（高架）', 'erail'),
          civ('el_station'),
          { tool: 'estop', name: '鉄道の駅（高架・線路の上）', thumb: { k: 'icon', icon: 'estop' }, cost: ESTOP_COST, upkeep: ESTOP_UPKEEP, size: `線路${ESTOP_LEN}マス`, hint: '線路をタップ', desc: '高架鉄道の線路の上だけに作る駅' },
        ],
      },
      { title: 'モノレール', items: [line('mono', 'モノレールの線路', 'mono'), civ('mono_station')] },
      { title: '地下鉄', items: [line('sub', '地下鉄の線路', 'sub'), civ('sub_station')] },
      { title: 'フェリー・港', items: [civ('ferry_p'), civ('ferry_c'), civ('seaport'), civ('seaport_l')] },
      // 以前の空港（airport_s・airport_l）はメニューから外した（保存データの空港はそのまま動く）
      { title: '空港', items: [civ('airport_1', undefined, { thumb: { k: 'airport', size: 1 }, hint: '斜め・海上も可' }), civ('airport_2', undefined, { thumb: { k: 'airport', size: 2 }, hint: '斜め・海上も可' })] },
    ],
  },
  {
    id: 'terrain', name: '地形', icon: 'terrain', sections: [
      {
        title: '地面の高さ', items: [
          { tool: 'terrain:raise', name: '地面を上げる', thumb: { k: 'icon', icon: 'raise' }, hint: `${TERRAIN_STEP}m ずつ` },
          { tool: 'terrain:lower', name: '地面を下げる', thumb: { k: 'icon', icon: 'lower' }, hint: `${TERRAIN_STEP}m ずつ` },
          { tool: 'terrain:level', name: '平らにする', thumb: { k: 'icon', icon: 'level' }, hint: '始点の高さにそろえる' },
        ],
      },
      {
        title: '埋め立て', items: [
          { tool: 'reclaim:1', name: '岸壁（コンクリート）', thumb: { k: 'icon', icon: 'reclaim1' }, cost: RECLAIM_COST, perCell: true, desc: '水面を埋め立てて、コンクリートの岸壁にする' },
          { tool: 'reclaim:2', name: '親水護岸（遊歩道）', thumb: { k: 'icon', icon: 'reclaim2' }, cost: RECLAIM_COST, perCell: true, desc: '水面を埋め立てて、遊歩道のある護岸にする' },
        ],
      },
      { title: '緑', items: [{ tool: 'trees', name: '木を植える', thumb: { k: 'trees' }, cost: TREE_COST, perCell: true }] },
    ],
  },
  { id: 'bulldoze', name: '取り壊し', icon: 'bulldoze', tool: 'bulldoze' },
  { id: 'query', name: '情報', icon: 'query', tool: 'query' },
];

// 3D の絵の覚えの鍵（作り方が同じなら同じ鍵）
export function thumbKey(t: ThumbSpec): string {
  switch (t.k) {
    case 'civic': return `c:${t.id}`;
    case 'grow': return `g:${t.type}.${t.den}.${t.floors}.${t.w}x${t.h}.${t.tint.toString(16)}`;
    case 'trees': return 'trees';
    case 'airport': return `a:${t.size}`;
    case 'icon': return `i:${t.icon}`;
  }
}
