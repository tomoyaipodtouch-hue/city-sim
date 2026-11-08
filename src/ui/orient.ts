// 画面の向き：縦持ちのまま横画面で遊ぶ「横ロックモード」
// 縦持ちのとき、地図と UI を入れた #app を 90° 回して横画面として表示する。
// 画面のいちばん上（iPhone の時計などが出る帯。iOS がぼかしや色をかける）には #app を重ねず、
// その下だけを使う。帯はページの背景色のまま残す。
// タッチの座標は回す前の座標（#app の中の座標）に直してから使う。
export type OrientMode = 'auto' | 'cw' | 'ccw';

let rot: 0 | 1 | -1 = 0; // 1 = 右に 90° 回す（スマホを左に倒して持つ）、-1 = 左に 90° 回す
let mode: OrientMode = 'auto';
let topPx = 0; // 回しているとき、上の帯として空けている高さ（px）
let vw = 0, vh = 0; // 回したときの画面の大きさ（座標を直すときも同じ値を使う）
const app = () => document.getElementById('app')!;

// 上の帯（safe-area-inset-top）の高さを px で測る
let probe: HTMLDivElement | null = null;
function safeTop() {
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 'safe-probe';
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top, 0px)';
    document.body.append(probe);
  }
  const v = parseFloat(getComputedStyle(probe).paddingTop);
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

export function setOrientMode(m: OrientMode) {
  mode = m;
  applyOrient();
}

export function applyOrient() {
  const W = window.innerWidth, H = window.innerHeight;
  vw = W;
  vh = H;
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
    topPx = 0;
    s.width = s.height = s.transform = '';
    return;
  }
  // 上の帯の下だけを使う（横画面の幅 = 縦の高さ - 帯の高さ）。帯の側の余白はもういらない
  topPx = Math.min(safeTop(), Math.floor(H / 3));
  const bottom = 'calc(env(safe-area-inset-bottom, 0px) * 0.5)';
  s.setProperty('--sl', rot === 1 ? '0px' : bottom);
  s.setProperty('--sr', rot === 1 ? bottom : '0px');
  s.setProperty('--st', '0px');
  s.setProperty('--sb', '0px');
  s.width = `${H - topPx}px`;
  s.height = `${W}px`;
  s.transform = rot === 1 ? `translate(${W}px, ${topPx}px) rotate(90deg)` : `translateY(${H}px) rotate(-90deg)`;
}

// 画面の座標（clientX, clientY）を #app の中の座標に直す
export function toApp(cx: number, cy: number): [number, number] {
  if (rot === 1) return [cy - topPx, vw - cx];
  if (rot === -1) return [vh - cy, cx];
  return [cx, cy];
}

window.addEventListener('resize', () => applyOrient());
window.addEventListener('orientationchange', () => setTimeout(applyOrient, 200));
