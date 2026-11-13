// 情報ツールの、空港（小・中・大）の行：便数、利用者、貨物、空港駅と都市高速のつながり、収入と維持費
import { LINES, type LineKind } from '../sim/defs';
import { AIRPORT_SPECS, type AirportSize, type AirStats } from '../sim/airport';

// 門から外へ向かう向き（DX/DY の番号）の方角：道路はこちらから引いてくる
const DIRS = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
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
  const from = air.gateDir !== undefined ? DIRS[air.gateDir] : '外';
  rows.push(['正門', air.gate === 'hw' ? '都市高速とつながっている（正門で都市高速がそのまま続きます）' : air.gate === 'road' ? '一般道とつながっている（都市高速をつなぐと、もっと遠くから人が来る）'
    : air.legacy ? `<span class="neg">つながっていません</span>（以前の空港：道路を正門へつなぎ直せませんでした。正門の${from}から都市高速か道路を引いて、正門のマスで終わらせる）`
    : `<span class="neg">つながっていません</span>（正門の${from}から都市高速か道路を引いて、正門のマスで終わらせる）`]);
  if (air.noFc) rows.push(['ターミナル前の道路', '<span class="neg">作れませんでした</span>（敷地にほかのものがあります。正門から直接ターミナルへ）']);
  rows.push(['通用門', air.svc ? '一般道とつながっている（貨物・整備地区）' : `つながっていません（貨物のトラックは正門から）`]);
  const bal = air.income - upkeep;
  rows.push(['収入', `着陸料など ${yen(air.income)}/月・維持費 ${yen(upkeep)}/月（${bal >= 0 ? `<span class="pos">+${yen(bal)}</span>` : `<span class="neg">${yen(bal)}</span>`}）`]);
  return rows;
}
