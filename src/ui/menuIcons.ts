// メニューの項目の絵のうち、3D で描かないもの（道路・線路・送電線・地形など）。
// 3D の絵と同じ斜め上の向き（南東から 30°）で、地面の台の上に描く。平面の座標 (u, v) は -1..1、h は高さ（px）
type P3 = [number, number, number?];

const R = 14.5; // 平面の 1 の長さ（px）
const CX = 32, CY = 34;
const TH = 5; // 台の厚さ（px）
const xy = ([u, v, h = 0]: P3) => [CX + (u - v) * R, CY + (u + v) * R * 0.5 - h] as const;
const pts = (a: P3[]) => a.map((p) => xy(p).map((n) => n.toFixed(1)).join(',')).join(' ');

const poly = (a: P3[], fill: string, extra = '') => `<polygon points="${pts(a)}" fill="${fill}" ${extra}/>`;
const pline = (a: P3[], stroke: string, w: number, extra = '') => `<polyline points="${pts(a)}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
// 平面の帯（u の向きに、v0..v1 の幅）
const band = (u0: number, u1: number, v0: number, v1: number, h: number, fill: string) => poly([[u0, v0, h], [u1, v0, h], [u1, v1, h], [u0, v1, h]], fill);
// 弧（中心 (cu, cv)、半径 r、角度 a0..a1）
const arc = (cu: number, cv: number, r: number, a0: number, a1: number, h = 0, n = 18): P3[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cu + Math.cos(a) * r, cv + Math.sin(a) * r, h] as P3;
  });

const GRASS = '#86a85d', SIDE_L = '#6f5b45', SIDE_R = '#5b4a39';
const ASPH = '#5a5d62', ASPH2 = '#4c4f54', WALK = '#b9b6ad', WHITE = '#f4f4ef', CONC = '#c9c5bb', CONC_S = '#9a968d', WATER = '#4d93c4';

// 地面の台（上の面の色を変えられる）
function tile(top = GRASS) {
  return poly([[-1, 1], [1, 1], [1, 1, -TH], [-1, 1, -TH]], SIDE_L) + poly([[1, -1], [1, 1], [1, 1, -TH], [1, -1, -TH]], SIDE_R) + poly([[-1, -1], [1, -1], [1, 1], [-1, 1]], top);
}

// 地上の道路（u の向き）。w = 半分の幅、center = 中央線、walk = 歩道
function groundRoad(w: number, o: { center?: 'dash' | 'solid' | 'median' | 'barrier'; walk?: boolean; lanes?: number; arrows?: boolean; v?: number } = {}) {
  const v = o.v ?? 0;
  let s = '';
  if (o.walk) s += band(-1, 1, v - w - 0.1, v + w + 0.1, 0, WALK);
  s += band(-1, 1, v - w, v + w, 0, ASPH);
  if (o.center === 'dash') s += pline([[-0.95, v], [0.95, v]], WHITE, 1, 'stroke-dasharray="3 3"');
  if (o.center === 'solid') s += pline([[-0.95, v], [0.95, v]], '#f0c54a', 1.1);
  if (o.center === 'median') s += band(-1, 1, v - 0.06, v + 0.06, 0, '#6f9a4a');
  if (o.center === 'barrier') s += band(-1, 1, v - 0.025, v + 0.025, 1.4, '#d8d5cc');
  if (o.lanes) for (const k of [-1, 1]) for (let i = 1; i < o.lanes; i++) s += pline([[-0.95, v + k * (w * i) / o.lanes], [0.95, v + k * (w * i) / o.lanes]], WHITE, 0.8, 'stroke-dasharray="2.5 3" opacity="0.85"');
  if (o.arrows) for (const u of [-0.45, 0.45]) s += arrowU(u, v, 0);
  return s;
}
// 白い矢印（+u の向き）
const arrowU = (u: number, v: number, h: number) => pline([[u - 0.12, v - 0.1, h], [u + 0.08, v, h], [u - 0.12, v + 0.1, h]], WHITE, 1.3);

// 高架の道路（u の向き）
function elevRoad(w: number, h: number, o: { lanes?: number; arrows?: boolean; center?: boolean } = {}) {
  let s = '';
  // 柱
  for (const u of [-0.55, 0.45]) s += poly([[u - 0.05, -0.06, 0], [u + 0.05, -0.06, 0], [u + 0.05, -0.06, h], [u - 0.05, -0.06, h]], CONC_S) + poly([[u - 0.05, 0.06, 0], [u + 0.05, 0.06, 0], [u + 0.05, 0.06, h], [u - 0.05, 0.06, h]], CONC);
  // 影
  s += band(-1, 1, -w + 0.15, w + 0.15, 0, 'rgba(40,50,30,0.28)');
  // 桁の側面と路面
  s += poly([[-1, w, h], [1, w, h], [1, w, h - 3], [-1, w, h - 3]], CONC_S);
  s += band(-1, 1, -w, w, h, ASPH2);
  s += pline([[-1, w - 0.03, h + 0.8], [1, w - 0.03, h + 0.8]], '#e2dfd6', 1.2);
  s += pline([[-1, -w + 0.03, h + 0.8], [1, -w + 0.03, h + 0.8]], '#e2dfd6', 1.2);
  if (o.center) s += pline([[-0.95, 0, h], [0.95, 0, h]], '#f0c54a', 1);
  if (o.lanes) for (const k of [-1, 1]) for (let i = 1; i < o.lanes; i++) s += pline([[-0.95, (k * w * i) / o.lanes, h], [0.95, (k * w * i) / o.lanes, h]], WHITE, 0.8, 'stroke-dasharray="2.5 3"');
  if (o.arrows) for (const u of [-0.45, 0.45]) s += arrowU(u, 0, h);
  return s;
}

// 線路（u の向き）
function track(h: number, v = 0) {
  let s = band(-1, 1, v - 0.16, v + 0.16, h, '#8d877b');
  for (let u = -0.9; u <= 0.91; u += 0.15) s += pline([[u, v - 0.12, h], [u, v + 0.12, h]], '#5b4635', 1.4);
  s += pline([[-1, v - 0.07, h], [1, v - 0.07, h]], '#d4d6da', 0.9) + pline([[-1, v + 0.07, h], [1, v + 0.07, h]], '#d4d6da', 0.9);
  return s;
}
function viaduct(h: number, w: number) {
  let s = band(-1, 1, -w + 0.15, w + 0.15, 0, 'rgba(40,50,30,0.28)');
  for (const u of [-0.55, 0.45]) s += poly([[u - 0.05, 0.06, 0], [u + 0.05, 0.06, 0], [u + 0.05, 0.06, h], [u - 0.05, 0.06, h]], CONC);
  s += poly([[-1, w, h], [1, w, h], [1, w, h - 3], [-1, w, h - 3]], CONC_S) + band(-1, 1, -w, w, h, '#a39d91');
  return s;
}

// 送電鉄塔
function pylon(u: number, v: number, H: number) {
  const [x, y] = xy([u, v]);
  return `<path d="M${x - 3.2} ${y} L${x} ${y - H} L${x + 3.2} ${y} M${x - 2} ${y - H * 0.45} L${x + 2} ${y - H * 0.45} M${x - 4.5} ${y - H * 0.78} L${x + 4.5} ${y - H * 0.78} M${x - 3.5} ${y - H * 0.6} L${x + 3.5} ${y - H * 0.6}" stroke="#7b8088" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;
}

// 道路の交差（u の向きの高速道路と、v の向きの道路）
const crossV = (w: number, fill = ASPH) => poly([[-w, -1], [w, -1], [w, 1], [-w, 1]], fill);

const ICONS: Record<string, () => string> = {
  street: () => tile() + groundRoad(0.2, { walk: true }),
  road: () => tile() + groundRoad(0.28, { walk: true, center: 'dash' }),
  oneway: () => tile() + groundRoad(0.28, { walk: true, arrows: true }),
  avenue: () => tile() + groundRoad(0.55, { walk: true, center: 'median', lanes: 2 }),
  hw: () => tile() + elevRoad(0.45, 13, { lanes: 2 }),
  ghw: () => tile() + groundRoad(0.5, { center: 'barrier', lanes: 2 }),
  uhw: () => tile() + elevRoad(0.3, 12, { center: true }),
  ughw: () => tile() + groundRoad(0.32, { center: 'solid' }),
  uhw1: () => tile() + elevRoad(0.3, 12, { lanes: 2, arrows: true }),
  ughw1: () => tile() + groundRoad(0.32, { lanes: 2, arrows: true }),
  ramp: () =>
    tile() + groundRoad(0.36, { v: -0.3, center: 'barrier' }) +
    pline([[-0.7, 0.12], [-0.1, 0.12], [0.4, 0.3], [1, 0.62]], ASPH, 4.2, 'stroke-linecap="butt"') +
    pline([[-0.95, 0.06], [-0.6, 0.06]], WHITE, 0.8),
  uramp: () => {
    // 地上から高架へ上る坂
    let s = tile() + band(-1, 1, -0.05, 0.45, 0, 'rgba(40,50,30,0.25)');
    s += poly([[-1, 0.3, 0], [1, 0.3, 13], [1, 0.3, 10], [-0.6, 0.3, 0]], CONC_S);
    s += poly([[-1, -0.05, 0], [1, -0.05, 13], [1, 0.3, 13], [-1, 0.3, 0]], ASPH2);
    s += pline([[-0.9, 0.125, 1], [0.95, 0.125, 13.5]], WHITE, 0.9, 'stroke-dasharray="2.5 3"');
    return s;
  },
  diamond: () =>
    tile() + groundRoad(0.32, { center: 'barrier' }) + crossV(0.16, '#62656a') +
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => pline([[a * 0.2, b * 0.8], [a * 0.75, b * 0.36]], ASPH, 2.6)).join(''),
  clover: () => {
    let s = tile() + groundRoad(0.3, { center: 'barrier' });
    for (const [a, b] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) s += pline(arc(a * 0.55, b * 0.58, 0.3, 0, Math.PI * 2, 0, 28), ASPH, 2.4);
    s += crossV(0.14, '#62656a');
    return s;
  },
  jct_tee: () =>
    tile() + elevRoad(0.24, 13) +
    pline([[0.05, 1, 0], [0.05, 0.55, 4], ...arc(-0.4, 0.45, 0.45, 0, -Math.PI / 2, 13, 10).slice(0)], ASPH2, 3.6) +
    pline([[0.05, 1, 0], [0.05, 0.55, 4], ...arc(0.5, 0.45, 0.45, Math.PI, Math.PI * 1.5, 13, 10)], ASPH2, 3.6),
  jct_semi: () => {
    let s = tile() + groundRoad(0.24, {});
    s += pline(arc(0.55, 0.55, 0.4, Math.PI, Math.PI * 1.5, 6), ASPH2, 3.2) + pline(arc(-0.55, -0.55, 0.4, 0, Math.PI / 2, 6), ASPH2, 3.2);
    s += pline(arc(-0.55, 0.55, 0.4, -Math.PI / 2, 0, 6), ASPH2, 3.2) + pline(arc(0.55, -0.55, 0.4, Math.PI / 2, Math.PI, 6), ASPH2, 3.2);
    s += poly([[-0.22, -1, 12], [0.22, -1, 12], [0.22, 1, 12], [-0.22, 1, 12]], ASPH2) + poly([[-0.22, 1, 12], [0.22, 1, 12], [0.22, 1, 9], [-0.22, 1, 9]], CONC_S);
    return s;
  },
  jct_clover: () => {
    let s = tile() + groundRoad(0.22, {});
    for (const [a, b] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) s += pline(arc(a * 0.56, b * 0.56, 0.27, 0, Math.PI * 2, 5, 26), ASPH2, 2.6);
    s += poly([[-0.2, -1, 11], [0.2, -1, 11], [0.2, 1, 11], [-0.2, 1, 11]], ASPH2) + poly([[-0.2, 1, 11], [0.2, 1, 11], [0.2, 1, 8], [-0.2, 1, 8]], CONC_S);
    return s;
  },
  jct_turbine: () => {
    let s = tile() + groundRoad(0.2, {});
    for (let k = 0; k < 4; k++) s += pline(arc(0, 0, 0.72, (k * Math.PI) / 2 + 0.25, (k * Math.PI) / 2 + 1.75, 7, 18), ASPH2, 3);
    s += poly([[-0.2, -1, 13], [0.2, -1, 13], [0.2, 1, 13], [-0.2, 1, 13]], ASPH2) + poly([[-0.2, 1, 13], [0.2, 1, 13], [0.2, 1, 10], [-0.2, 1, 10]], CONC_S);
    return s;
  },
  dezone: () => {
    let s = tile();
    s += poly([[-0.62, -0.62], [0.62, -0.62], [0.62, 0.62], [-0.62, 0.62]], 'rgba(73,194,90,0.45)', 'stroke="#ffffff" stroke-width="1.2" stroke-dasharray="3 2.5"');
    s += pline([[-0.4, -0.4], [0.4, 0.4]], '#e5534b', 3) + pline([[0.4, -0.4], [-0.4, 0.4]], '#e5534b', 3);
    return s;
  },
  pline: () => {
    let s = tile() + pylon(-0.55, 0.1, 30) + pylon(0.6, 0.05, 30);
    const [ax, ay] = xy([-0.55, 0.1]), [bx, by] = xy([0.6, 0.05]);
    for (const [dx, dy] of [[-4.5, 0.78], [4.5, 0.78], [-3.5, 0.6], [3.5, 0.6]]) {
      const y1 = ay - 30 * dy, y2 = by - 30 * dy;
      s += `<path d="M${(ax + dx).toFixed(1)} ${y1.toFixed(1)} Q${((ax + bx) / 2 + dx).toFixed(1)} ${((y1 + y2) / 2 + 5).toFixed(1)} ${(bx + dx).toFixed(1)} ${y2.toFixed(1)}" stroke="#3b3e44" stroke-width="0.7" fill="none"/>`;
    }
    return s;
  },
  rail: () => tile() + track(0),
  erail: () => tile() + viaduct(12, 0.24) + track(12),
  estop: () => {
    let s = tile() + viaduct(12, 0.4) + track(12, -0.12);
    s += band(-0.6, 0.6, 0.06, 0.38, 13, '#d9d4c8');
    s += poly([[-0.6, 0.06, 20], [0.6, 0.06, 20], [0.6, 0.38, 20], [-0.6, 0.38, 20]], '#7fa3c2', 'opacity="0.9"');
    for (const u of [-0.5, 0.5]) s += pline([[u, 0.3, 13], [u, 0.3, 20]], '#8a8f96', 1);
    return s;
  },
  mono: () => {
    let s = tile() + band(-1, 1, 0.05, 0.25, 0, 'rgba(40,50,30,0.25)');
    for (const u of [-0.55, 0.45]) s += poly([[u - 0.05, 0.05, 0], [u + 0.05, 0.05, 0], [u + 0.05, 0.05, 15], [u - 0.05, 0.05, 15]], CONC);
    s += poly([[-1, 0.08, 18], [1, 0.08, 18], [1, 0.08, 14], [-1, 0.08, 14]], CONC_S) + band(-1, 1, -0.06, 0.08, 18, '#dcd8cf');
    return s;
  },
  sub: () => {
    // 地面の下の線路（台の側面を切り取って、トンネルを見せる）
    let s = tile();
    s += pline([[-0.95, 0], [0.95, 0]], 'rgba(255,255,255,0.75)', 1.2, 'stroke-dasharray="3 2.5"');
    s += poly([[-0.22, -0.18], [0.12, -0.18], [0.12, 0.16], [-0.22, 0.16]], '#3d4148') + poly([[-0.22, -0.18, 6], [0.12, -0.18, 6], [0.12, 0.16, 6], [-0.22, 0.16, 6]], '#4f86cc');
    s += poly([[-0.22, 0.16, 0], [0.12, 0.16, 0], [0.12, 0.16, 6], [-0.22, 0.16, 6]], '#5c6168') + poly([[0.12, -0.18, 0], [0.12, 0.16, 0], [0.12, 0.16, 6], [0.12, -0.18, 6]], '#474b52');
    const [mx, my] = xy([-0.05, -0.01, 6]);
    s += `<text x="${mx}" y="${my + 1.6}" font-size="5" font-weight="700" text-anchor="middle" fill="#fff" font-family="sans-serif">M</text>`;
    return s;
  },
  raise: () => {
    let s = tile();
    s += poly([[-0.5, 0.5], [0.5, 0.5], [0.3, 0.3, 10], [-0.3, 0.3, 10]], '#7d9a55') + poly([[0.5, -0.5], [0.5, 0.5], [0.3, 0.3, 10], [0.3, -0.3, 10]], '#6b8749');
    s += poly([[-0.3, -0.3, 10], [0.3, -0.3, 10], [0.3, 0.3, 10], [-0.3, 0.3, 10]], '#93b46a');
    const [x, y] = xy([0, 0, 10]);
    s += `<path d="M${x} ${y - 16} l-5 6 h3.2 v6 h3.6 v-6 h3.2 z" fill="#fff" stroke="rgba(0,0,0,0.25)" stroke-width="0.6"/>`;
    return s;
  },
  lower: () => {
    let s = tile();
    s += poly([[-0.55, -0.55], [0.55, -0.55], [0.3, -0.3, -8], [-0.3, -0.3, -8]], '#6a5844') + poly([[-0.55, -0.55], [-0.55, 0.55], [-0.3, 0.3, -8], [-0.3, -0.3, -8]], '#7c6851');
    s += poly([[-0.3, -0.3, -8], [0.3, -0.3, -8], [0.3, 0.3, -8], [-0.3, 0.3, -8]], '#5f7d43');
    const [x, y] = xy([0, 0, -8]);
    s += `<path d="M${x} ${y - 1} l-5 -6 h3.2 v-6 h3.6 v6 h3.2 z" fill="#fff" stroke="rgba(0,0,0,0.25)" stroke-width="0.6"/>`;
    return s;
  },
  level: () => {
    let s = tile();
    const [ax, ay] = xy([-0.75, 0.75, 3]), [bx, by] = xy([0.75, -0.75, 3]);
    s += `<path d="M${ax} ${ay} H${bx}" stroke="#fff" stroke-width="1.6"/>`;
    s += `<path d="M${ax + 5} ${ay - 4} L${ax} ${ay} L${ax + 5} ${ay + 4} M${bx - 5} ${by - 4} L${bx} ${by} L${bx - 5} ${by + 4}" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    return s;
  },
  reclaim1: () => {
    // 奥は水、手前は埋め立てた地面とコンクリートの岸壁
    let s = tile('#4d93c4');
    s += poly([[-1, -0.1], [1, -0.1], [1, 1], [-1, 1]], '#c4bfb3') + poly([[-1, -0.1, 0], [1, -0.1, 0], [1, -0.1, -0.1], [-1, -0.1, -0.1]], CONC_S);
    s += poly([[-1, -1], [1, -1], [1, -0.1], [-1, -0.1]], WATER, 'opacity="0.95"');
    s += pline([[-0.95, -0.1, 0.3], [0.95, -0.1, 0.3]], '#e9e6de', 1.3);
    for (const u of [-0.6, 0, 0.6]) s += poly([[u - 0.04, -0.06, 0], [u + 0.04, -0.06, 0], [u + 0.04, -0.06, 2.5], [u - 0.04, -0.06, 2.5]], '#e1b23a');
    return s;
  },
  reclaim2: () => {
    let s = tile('#4d93c4');
    s += poly([[-1, -1], [1, -1], [1, -0.1], [-1, -0.1]], WATER);
    s += poly([[-1, -0.1], [1, -0.1], [1, 0.25], [-1, 0.25]], '#d8c9a4') + poly([[-1, 0.25], [1, 0.25], [1, 1], [-1, 1]], GRASS);
    s += pline([[-0.95, -0.08, 2.4], [0.95, -0.08, 2.4]], '#f0ede4', 0.8);
    for (let u = -0.9; u <= 0.91; u += 0.3) s += pline([[u, -0.08, 0], [u, -0.08, 2.4]], '#f0ede4', 0.7);
    for (const [u, v] of [[-0.55, 0.62], [0.2, 0.55], [0.75, 0.7]]) {
      const [x, y] = xy([u, v]);
      s += `<ellipse cx="${x}" cy="${y + 0.5}" rx="3.2" ry="1.4" fill="rgba(30,40,20,0.3)"/><circle cx="${x}" cy="${y - 4}" r="3.6" fill="#4f7d35"/>`;
    }
    return s;
  },
};

export function menuIcon(id: string): string {
  const f = ICONS[id];
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${f ? f() : tile()}</svg>`;
}
export const MENU_ICON_IDS = Object.keys(ICONS);
