// 情報ツールの、空港（小・中・大）の行：便数、利用者、貨物、空港駅と都市高速のつながり、収入と維持費
import { LINES, type LineKind } from '../sim/defs';
import { AIRPORT_SPECS, type AirportSize, type AirStats } from '../sim/airport';

const num = (v: number) => Math.round(v).toLocaleString();
const yen = (v: number) => `§${Math.round(v).toLocaleString()}`;

export function airportRows(size: AirportSize, air: AirStats | undefined, upkeep: number): [string, string][] {
  const spec = AIRPORT_SPECS[size];
  const rows: [string, string][] = [];
  if (!air) {
    rows.push(['状態', '準備中（来月から運航）']);
    rows.push(['維持費', `${yen(upkeep)}/月`]);
    return rows;
  }
  rows.push(['便数', air.open ? `${num(air.flights + air.cargoFlights)} 便/日${air.cargoFlights ? `（うち貨物便 ${num(air.cargoFlights)}）` : ''}` : '<span class="neg">運航していません</span>']);
  rows.push(['利用者', `${num(air.pax)} / ${num(spec.paxCap)} 人/日${air.paxRail ? `（鉄道などで ${num(air.paxRail)} 人）` : ''}`]);
  rows.push(['航空貨物', air.freight ? `${num(air.freight)} t/日` : 'なし（ハイテク産業の荷物を運ぶ）']);
  rows.push(['空港駅', air.lines.length ? `${air.lines.map((k: LineKind) => LINES[k].name).join('・')}とつながっている` : '<span class="neg">つながっていません</span>（ターミナル前の陸側のふちに線路を引く）']);
  rows.push(['都市高速', air.highway ? '都市高速とつながっている（空港専用ランプ）' : 'つながっていません（陸側のふちの水色のマスに都市高速を通す）']);
  const bal = air.income - upkeep;
  rows.push(['収入', `着陸料など ${yen(air.income)}/月・維持費 ${yen(upkeep)}/月（${bal >= 0 ? `<span class="pos">+${yen(bal)}</span>` : `<span class="neg">${yen(bal)}</span>`}）`]);
  return rows;
}
