// オーバーレイの色（ゾーンの色、データ表示）
import { Grid } from '../sim/grid';
import { ROADS } from '../sim/defs';
import type { Maps } from '../sim/world';

export type DataView = 'none' | 'zones' | 'traffic' | 'landValue' | 'pollution' | 'power' | 'water';

export const DATA_VIEWS: { id: DataView; name: string }[] = [
  { id: 'none', name: '通常' },
  { id: 'zones', name: 'ゾーン' },
  { id: 'traffic', name: '交通量' },
  { id: 'landValue', name: '地価' },
  { id: 'pollution', name: '大気汚染' },
  { id: 'power', name: '電力' },
  { id: 'water', name: '水道' },
];

const ZONE_RGB: [number, number, number][] = [
  [0, 0, 0],
  [70, 200, 80],
  [60, 120, 235],
  [235, 190, 40],
];

function ramp(t: number, stops: [number, number, number][]): [number, number, number] {
  t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const TRAFFIC_RAMP: [number, number, number][] = [[60, 200, 90], [240, 220, 60], [240, 120, 40], [200, 30, 40]];
const LV_RAMP: [number, number, number][] = [[90, 60, 140], [60, 120, 200], [70, 190, 120], [240, 220, 80], [250, 140, 60]];
const POL_RAMP: [number, number, number][] = [[200, 190, 120], [170, 120, 60], [120, 60, 40]];

export function buildOverlay(out: Uint8Array, g: Grid, maps: Maps | null, view: DataView) {
  const N = g.n * g.n;
  for (let i = 0; i < N; i++) {
    let r = 0, gg = 0, b = 0, a = 0;
    const x = i % g.n, y = (i / g.n) | 0;
    const water = g.isWater(x, y);
    const z = g.zone[i];
    const built = g.bldg[i] !== 0;
    if (view === 'none' || view === 'zones') {
      if (z && (!built || view === 'zones')) {
        const k = [1, 0.78, 0.6][g.zden[i]] ?? 1;
        [r, gg, b] = ZONE_RGB[z].map((c) => c * k) as [number, number, number];
        a = built ? 120 : 62 + g.zden[i] * 18;
      }
    } else if (maps) {
      if (view === 'traffic') {
        if (g.road[i]) {
          const ratio = maps.traffic[i] / ROADS[g.road[i]].capacity;
          [r, gg, b] = ramp(ratio / 1.2, TRAFFIC_RAMP);
          a = maps.traffic[i] > 0.5 ? 230 : 90;
        } else if (!water) {
          r = gg = b = 20;
          a = 90;
        }
      } else if (view === 'landValue' && !water) {
        [r, gg, b] = ramp(maps.landValue[i] / 255, LV_RAMP);
        a = 150;
      } else if (view === 'pollution' && !water) {
        const p = maps.pollution[i] / 140;
        [r, gg, b] = ramp(p, POL_RAMP);
        a = Math.min(200, p * 260);
      } else if (view === 'power') {
        if (z || built || g.pline[i]) {
          if (maps.power[i]) [r, gg, b, a] = [250, 220, 60, 150];
          else [r, gg, b, a] = [220, 50, 50, 150];
        }
      } else if (view === 'water') {
        if (g.road[i] && maps.water[i]) [r, gg, b, a] = [60, 150, 240, 200];
        else if (z || built) {
          if (maps.water[i]) [r, gg, b, a] = [80, 170, 250, 130];
          else [r, gg, b, a] = [220, 70, 60, 130];
        }
      }
    }
    if (water && view !== 'traffic') a = 0;
    const k = i * 4;
    out[k] = r;
    out[k + 1] = gg;
    out[k + 2] = b;
    out[k + 3] = a;
  }
}
