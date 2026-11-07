// 画面の向き：縦持ちのまま横画面で遊ぶ「横ロックモード」
// 縦持ちのとき、地図と UI を入れた #app を 90° 回して横画面として表示する。
// タッチの座標は回す前の座標（#app の中の座標）に直してから使う。
export type OrientMode = 'auto' | 'cw' | 'ccw';

let rot: 0 | 1 | -1 = 0; // 1 = 右に 90° 回す（スマホを左に倒して持つ）、-1 = 左に 90° 回す
let mode: OrientMode = 'auto';
const app = () => document.getElementById('app')!;

export function setOrientMode(m: OrientMode) {
  mode = m;
  applyOrient();
}

export function applyOrient() {
  const W = window.innerWidth, H = window.innerHeight;
  const portrait = H > W;
  rot = mode !== 'auto' && portrait ? (mode === 'cw' ? 1 : -1) : 0;
  const s = app().style;
  const root = document.documentElement;
  root.classList.toggle('rotated', rot !== 0);
  // 縦の配置は、縦向きで回していないときだけ
  root.classList.toggle('portrait', portrait && rot === 0);
  // ノッチやホームバーの余白も、回した向きに合わせて入れ替える
  for (const k of ['--sl', '--sr', '--st', '--sb']) s.removeProperty(k);
  if (rot === 0) {
    s.width = s.height = s.transform = '';
    return;
  }
  const top = 'calc(env(safe-area-inset-top, 0px) * 0.6)', bottom = 'calc(env(safe-area-inset-bottom, 0px) * 0.5)';
  s.setProperty('--sl', rot === 1 ? top : bottom);
  s.setProperty('--sr', rot === 1 ? bottom : top);
  s.setProperty('--st', '0px');
  s.setProperty('--sb', '0px');
  s.width = `${H}px`;
  s.height = `${W}px`;
  s.transform = rot === 1 ? `translateX(${W}px) rotate(90deg)` : `translateY(${H}px) rotate(-90deg)`;
}

// 画面の座標（clientX, clientY）を #app の中の座標に直す
export function toApp(cx: number, cy: number): [number, number] {
  if (rot === 1) return [cy, window.innerWidth - cx];
  if (rot === -1) return [window.innerHeight - cy, cx];
  return [cx, cy];
}

window.addEventListener('resize', () => applyOrient());
window.addEventListener('orientationchange', () => setTimeout(applyOrient, 200));
