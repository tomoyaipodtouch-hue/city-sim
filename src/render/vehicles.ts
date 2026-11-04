// 車両の形。前は +z、幅は x。0xffffff の部分が車体の色（インスタンスの色）になる。
// 横から見た輪郭を押し出して、傾いたフロントガラスやボンネットを作る
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const PAINT = 0xffffff, GLASS = 0x222c36, TIRE = 0x161616, HUB = 0x9aa0a6, TRIM = 0x2a2a2a, HEAD = 0xfff4d6, TAIL = 0xd02020, CHROME = 0xc8ccd0;

export function vc(geo: THREE.BufferGeometry, hex: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
type P = [number, number];
// 横から見た輪郭（[前後, 高さ]）を、幅 w に押し出す
function side(pts: P[], w: number, color: number) {
  const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: w, bevelEnabled: false, curveSegments: 1 });
  g.rotateY(-Math.PI / 2);
  g.translate(w / 2, 0, 0);
  return vc(g, color);
}
const box = (w: number, h: number, l: number, x: number, y: number, z: number, color: number) => vc(new THREE.BoxGeometry(w, h, l).translate(x, y, z), color);
function wheels(r: number, track: number, zs: number[], width = 0.26) {
  const out: THREE.BufferGeometry[] = [];
  for (const z of zs)
    for (const s of [-1, 1]) {
      out.push(vc(new THREE.CylinderGeometry(r, r, width, 10).rotateZ(Math.PI / 2).translate((s * track) / 2, r, z), TIRE));
      out.push(vc(new THREE.CylinderGeometry(r * 0.55, r * 0.55, width + 0.02, 8).rotateZ(Math.PI / 2).translate((s * track) / 2, r, z), HUB));
    }
  return out;
}
function lights(w: number, yF: number, zF: number, yR: number, zR: number) {
  return [
    box(0.42, 0.16, 0.06, -w / 2 + 0.32, yF, zF, HEAD), box(0.42, 0.16, 0.06, w / 2 - 0.32, yF, zF, HEAD),
    box(0.36, 0.18, 0.06, -w / 2 + 0.28, yR, zR, TAIL), box(0.36, 0.18, 0.06, w / 2 - 0.28, yR, zR, TAIL),
  ];
}
// 乗用車の共通の作り：下の車体、窓まわり（ガラス）、屋根、柱、タイヤ、ライト、バンパー
function passenger(o: { L: number; W: number; lower: P[]; cabin: P[]; roof: [number, number, number]; r: number; axles: [number, number]; beltY: number; extra?: THREE.BufferGeometry[] }) {
  const { L, W } = o;
  const parts = [
    side(o.lower, W, PAINT),
    side(o.cabin, W - 0.12, GLASS),
    box(W - 0.16, 0.07, o.roof[1] - o.roof[0], 0, o.roof[2], (o.roof[0] + o.roof[1]) / 2, PAINT),
    // 真ん中の柱
    box(W - 0.1, (o.roof[2] - o.beltY) * 0.95, 0.14, 0, (o.roof[2] + o.beltY) / 2, (o.roof[0] + o.roof[1]) / 2 - 0.1, PAINT),
    box(W + 0.02, 0.22, 0.12, 0, 0.42, L / 2 - 0.02, TRIM), box(W + 0.02, 0.22, 0.12, 0, 0.42, -L / 2 + 0.02, TRIM),
    ...wheels(o.r, W - 0.12, o.axles),
    ...lights(W, o.beltY - 0.12, L / 2 - 0.04, o.beltY - 0.1, -L / 2 + 0.04),
    ...(o.extra ?? []),
  ];
  return mergeGeometries(parts)!;
}

export function sedan() {
  return passenger({
    L: 4.6, W: 1.82, r: 0.33, axles: [1.38, -1.38], beltY: 0.95,
    lower: [[-2.3, 0.3], [2.3, 0.3], [2.33, 0.6], [2.2, 0.82], [1.1, 0.96], [-1.55, 0.99], [-2.25, 0.94], [-2.33, 0.62]],
    cabin: [[-1.5, 0.97], [1.12, 0.95], [0.48, 1.4], [-0.84, 1.42]],
    roof: [-0.82, 0.46, 1.43],
  });
}
export function hatchback() {
  return passenger({
    L: 4.05, W: 1.76, r: 0.32, axles: [1.25, -1.25], beltY: 0.95,
    lower: [[-2.02, 0.3], [2.02, 0.3], [2.05, 0.6], [1.9, 0.8], [0.95, 0.95], [-1.95, 0.98], [-2.04, 0.62]],
    cabin: [[-1.95, 0.97], [0.98, 0.94], [0.38, 1.44], [-1.72, 1.46]],
    roof: [-1.7, 0.36, 1.47],
  });
}
export function suv() {
  return passenger({
    L: 4.75, W: 1.95, r: 0.4, axles: [1.45, -1.45], beltY: 1.12,
    lower: [[-2.37, 0.42], [2.37, 0.42], [2.4, 0.78], [2.25, 1.02], [1.3, 1.12], [-2.3, 1.14], [-2.4, 0.8]],
    cabin: [[-2.28, 1.12], [1.32, 1.1], [0.72, 1.72], [-2.18, 1.74]],
    roof: [-2.15, 0.7, 1.75],
    extra: [box(0.06, 0.06, 2.6, -0.8, 1.83, -0.7, CHROME), box(0.06, 0.06, 2.6, 0.8, 1.83, -0.7, CHROME)],
  });
}
export function minivan() {
  return passenger({
    L: 5.0, W: 1.95, r: 0.36, axles: [1.6, -1.55], beltY: 1.06,
    lower: [[-2.5, 0.35], [2.5, 0.35], [2.53, 0.7], [2.35, 0.95], [1.6, 1.05], [-2.45, 1.08], [-2.52, 0.72]],
    cabin: [[-2.44, 1.06], [1.65, 1.04], [0.8, 1.83], [-2.38, 1.86]],
    roof: [-2.35, 0.78, 1.87],
  });
}
export function pickup() {
  const W = 1.98;
  return mergeGeometries([
    side([[-2.72, 0.42], [2.72, 0.42], [2.75, 0.8], [2.6, 1.06], [1.55, 1.16], [-0.4, 1.18], [-0.4, 1.0], [-2.72, 1.0]], W, PAINT),
    side([[-0.36, 1.16], [1.58, 1.14], [1.04, 1.76], [-0.3, 1.78]], W - 0.12, GLASS),
    box(W - 0.16, 0.07, 1.3, 0, 1.8, 0.37, PAINT),
    // 荷台（側面の壁と後ろのあおり）
    box(0.08, 0.42, 2.3, -W / 2 + 0.04, 1.2, -1.55, PAINT), box(0.08, 0.42, 2.3, W / 2 - 0.04, 1.2, -1.55, PAINT),
    box(W, 0.42, 0.08, 0, 1.2, -2.68, PAINT), box(W - 0.16, 0.04, 2.25, 0, 1.0, -1.55, TRIM),
    box(W + 0.04, 0.24, 0.14, 0, 0.5, 2.72, CHROME), box(W + 0.04, 0.24, 0.14, 0, 0.5, -2.74, TRIM),
    ...wheels(0.42, W - 0.12, [1.75, -1.75]),
    ...lights(W, 0.95, 2.74, 1.15, -2.74),
  ])!;
}

// 路線バス：窓の帯、屋根の冷房装置、ドア、行き先表示
export function cityBus() {
  const L = 12, W = 2.55;
  return mergeGeometries([
    side([[-6, 0.38], [6, 0.38], [6.03, 1.2], [-6, 1.2]], W, PAINT),
    side([[-5.95, 1.2], [6.03, 1.2], [5.9, 2.75], [-5.95, 2.75]], W - 0.06, GLASS),
    box(W, 0.4, L - 0.15, 0, 2.95, -0.07, PAINT),
    // 窓の間の柱
    ...[-4.6, -3.0, -1.4, 0.2, 1.8, 3.4].flatMap((z) => [box(W - 0.02, 1.55, 0.18, 0, 1.97, z, PAINT)]),
    box(1.6, 0.35, 2.6, 0, 3.32, -1.5, 0xd8dade), // 冷房装置
    box(W - 0.4, 0.32, 0.06, 0, 2.6, 6.04, 0xff9a2a), // 行き先表示
    box(0.06, 2.1, 1.2, -W / 2 - 0.01, 1.4, 4.6, GLASS), box(0.06, 2.1, 1.2, -W / 2 - 0.01, 1.4, -0.6, GLASS), // ドア
    box(W + 0.04, 0.3, 0.14, 0, 0.5, 6.02, TRIM), box(W + 0.04, 0.3, 0.14, 0, 0.5, -6.02, TRIM),
    ...wheels(0.5, W - 0.2, [3.9, -3.6], 0.32),
    ...lights(W, 0.85, 6.04, 0.95, -6.04),
  ])!;
}

// 箱型のトラック（運転台＋荷箱）
export function boxTruck() {
  const W = 2.45;
  return mergeGeometries([
    box(W - 0.3, 0.4, 7.8, 0, 0.75, -0.2, TRIM), // シャシー
    side([[2.0, 0.9], [4.25, 0.9], [4.3, 1.8], [4.0, 2.75], [2.0, 2.8]], W, PAINT),
    side([[2.6, 1.85], [4.24, 1.82], [3.98, 2.6], [2.6, 2.62]], W - 0.1, GLASS),
    box(W + 0.05, 2.9, 6.3, 0, 2.5, -1.25, 0xf2f2f0), // 荷箱
    box(W + 0.07, 0.25, 6.3, 0, 1.25, -1.25, PAINT), // 荷箱の帯（会社の色）
    box(W + 0.04, 0.28, 0.14, 0, 0.7, 4.3, TRIM),
    ...wheels(0.5, W - 0.25, [3.3, -2.5, -3.6], 0.36),
    ...lights(W, 1.0, 4.32, 1.0, -4.42),
  ])!;
}
// トレーラーを引く車（トラクター）。連結部は z = -1.6
export function tractor() {
  const W = 2.5;
  return mergeGeometries([
    box(W - 0.4, 0.45, 6.2, 0, 0.75, 0, TRIM),
    side([[1.6, 0.95], [3.1, 0.95], [3.12, 1.75], [2.9, 1.95], [1.6, 2.0]], W - 0.4, PAINT), // ボンネット
    side([[-1.0, 0.95], [1.65, 0.95], [1.65, 2.05], [1.3, 3.0], [-1.0, 3.3]], W, PAINT), // 運転台と寝台
    side([[0.9, 2.08], [1.62, 2.06], [1.3, 2.9], [0.9, 2.92]], W - 0.08, GLASS),
    box(W - 0.2, 0.06, 1.4, 0, 1.0, -2.1, 0x3a3a3a), // 連結器
    vc(new THREE.CylinderGeometry(0.12, 0.12, 2.6, 8).translate(-W / 2 - 0.05, 2.5, 0.6), CHROME), // 排気管
    vc(new THREE.CylinderGeometry(0.12, 0.12, 2.6, 8).translate(W / 2 + 0.05, 2.5, 0.6), CHROME),
    box(W - 0.2, 0.5, 0.15, 0, 1.3, 3.12, CHROME), // グリル
    ...wheels(0.52, W - 0.3, [2.4, -1.3, -2.5], 0.36),
    ...lights(W - 0.2, 1.25, 3.14, 1.0, -3.1),
  ])!;
}
// 箱型のトレーラー（連結部が原点、後ろ向きに伸びる）
export function trailerBox() {
  const W = 2.55;
  return mergeGeometries([
    box(W, 2.85, 14.4, 0, 2.6, -6.9, PAINT),
    box(W - 0.6, 0.3, 13.6, 0, 1.05, -7.0, TRIM),
    box(0.15, 0.9, 0.15, -0.8, 0.6, -2.0, TRIM), box(0.15, 0.9, 0.15, 0.8, 0.6, -2.0, TRIM), // 補助脚
    ...wheels(0.5, W - 0.3, [-11.6, -12.8], 0.36),
    box(0.3, 0.16, 0.06, -W / 2 + 0.25, 1.05, -14.12, TAIL), box(0.3, 0.16, 0.06, W / 2 - 0.25, 1.05, -14.12, TAIL),
  ])!;
}
// タンクのトレーラー
export function trailerTank() {
  const W = 2.5;
  const tank = vc(new THREE.CylinderGeometry(1.15, 1.15, 11.6, 14).rotateX(Math.PI / 2).translate(0, 2.35, -7.2), PAINT);
  return mergeGeometries([
    tank,
    vc(new THREE.SphereGeometry(1.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).translate(0, 2.35, -1.4), PAINT),
    vc(new THREE.SphereGeometry(1.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2).translate(0, 2.35, -13.0), PAINT),
    box(W - 0.7, 0.3, 13.2, 0, 1.05, -7.2, TRIM),
    box(0.6, 0.14, 9, 0, 3.55, -7.2, CHROME), // 上の通路
    ...wheels(0.5, W - 0.3, [-11.2, -12.4], 0.36),
    box(0.3, 0.16, 0.06, -W / 2 + 0.25, 1.05, -13.85, TAIL), box(0.3, 0.16, 0.06, W / 2 - 0.25, 1.05, -13.85, TAIL),
  ])!;
}

// ゴミ収集車（パッカー車）：運転台が前にあり、丸みのある荷箱と、後ろの投入口
export function garbageTruck() {
  const W = 2.4;
  return mergeGeometries([
    box(W - 0.3, 0.4, 7.4, 0, 0.75, 0, TRIM),
    side([[2.2, 0.9], [3.65, 0.9], [3.7, 1.9], [3.5, 2.8], [2.2, 2.85]], W, PAINT), // 運転台
    side([[2.75, 1.95], [3.68, 1.92], [3.48, 2.7], [2.75, 2.72]], W - 0.08, GLASS),
    // 荷箱（上が丸い）
    side([[-2.7, 1.0], [2.1, 1.0], [2.1, 2.85], [1.8, 3.15], [-2.4, 3.15], [-2.7, 2.85]], W + 0.04, 0xf2f2ee),
    box(W + 0.08, 0.35, 4.6, 0, 1.55, -0.3, PAINT), // 帯
    // 後ろの投入口（少し暗い色、斜め）
    side([[-3.65, 0.95], [-2.65, 0.95], [-2.65, 3.0], [-3.1, 2.9], [-3.7, 1.9]], W - 0.05, 0xb9bcc0),
    box(W - 0.5, 0.6, 0.08, 0, 1.45, -3.66, 0x3a3d42),
    box(0.1, 2.0, 0.1, -W / 2 + 0.1, 2.0, -3.3, 0xf0a020), box(0.1, 2.0, 0.1, W / 2 - 0.1, 2.0, -3.3, 0xf0a020), // 黄色の手すり
    box(0.5, 0.18, 0.3, 0, 2.95, 3.0, 0xf0a020), // 回転灯
    ...wheels(0.48, W - 0.25, [2.6, -1.9], 0.34),
    ...lights(W, 1.05, 3.72, 1.1, -3.72),
  ])!;
}
