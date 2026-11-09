// Pocket Metro の起動
import { bgm, bgmSettings, SONGS } from './bgm';
import './ui/style.css';
import { GameClient } from './game';
import { CityRenderer } from './render/renderer';
import { ToolController } from './ui/tools';
import { Hud, Settings } from './ui/hud';
import { Input } from './ui/input';
import { setOrientMode } from './ui/orient';
import { SPEED_SCALE } from './sim/constants';
import { exportFile, importFile, listSaves, readSave, writeSave } from './save';
import type { SaveData } from './sim/world';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const game = new GameClient();
const renderer = new CityRenderer(canvas);
const tools = new ToolController(game, renderer);
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__pm = { game, renderer };
let inGame = false;
let qualityKey = '';

// 画面を自動で消さない（Wake Lock）。画面が隠れると外れるので、戻ったときやタップのたびに取り直す
let keepAwake = true;
let wakeLock: { release: () => Promise<void> } | null = null;
let wakeBusy = false;
async function updateWakeLock() {
  if (wakeBusy) return;
  wakeBusy = true;
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void>; addEventListener: (e: string, f: () => void) => void }> } };
    if (keepAwake && !document.hidden) {
      if (!wakeLock && nav.wakeLock) {
        const l = await nav.wakeLock.request('screen');
        l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
        wakeLock = l;
      }
    } else if (wakeLock) {
      const l = wakeLock;
      wakeLock = null;
      await l.release();
    }
  } catch { /* 対応していない、または許可されなかった */ }
  wakeBusy = false;
}
document.addEventListener('visibilitychange', () => void updateWakeLock());

const SETTINGS_KEY = 'pocket-metro-settings';
function loadSettings(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}
function storeSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 保存できない環境では無視する */
  }
}

async function autosave() {
  if (!inGame) return;
  try {
    const d = await game.save();
    await writeSave('auto', d);
  } catch (e) {
    console.warn('自動保存に失敗しました', e);
  }
}

function startWith(fn: () => void) {
  hud.hideTitle();
  hud.selectTool('');
  fn();
}

const hud: Hud = new Hud(game, renderer, tools, {
  saveSlot: async (slot) => {
    const d = await game.save();
    await writeSave(slot, d);
  },
  loadSlot: async (slot): Promise<void> => {
    const d = await readSave(slot);
    if (!d) return hud.showToast('保存データが見つかりません', true);
    startWith(() => game.load(d));
  },
  continueAuto: async (): Promise<void> => {
    const d = await readSave('auto');
    if (!d) return hud.showToast('自動保存のデータが見つかりません', true);
    startWith(() => game.load(d));
  },
  exportFile: async () => {
    const d = await game.save();
    const blob = await exportFile(d);
    const name = `${d.name.replace(/[\\/:*?"<>|]/g, '_')}.pmcity`;
    const file = new File([blob], name, { type: 'application/octet-stream' });
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch {
        /* キャンセルされたらダウンロードに切り替える */
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  importFile: async (f) => {
    const d: SaveData = await importFile(f);
    startWith(() => game.load(d));
  },
  listSaves,
  toTitle: async () => {
    await autosave();
    inGame = false;
    game.setSpeed(0);
    void hud.showTitle();
  },
  applySettings: (s) => {
    // 画質は変わったときだけ作り直す（音量のスライダーなどを動かすたびに重い処理をしない）
    const q = { shadows: s.shadows, cars: s.cars, hq: s.hq, pixelRatio: s.lowRes ? 1 : Math.min(2, window.devicePixelRatio || 1) };
    const qk = JSON.stringify(q);
    if (qk !== qualityKey) {
      qualityKey = qk;
      renderer.setQuality(q);
    }
    renderer.dayMode = s.dayNight ?? 'auto';
    // ほかのアプリの音楽を流すときは、BGM を止める（音の出し方もほかの音とまざる形になる）
    bgmSettings.enabled = (s.bgm ?? true) && !s.mixMusic;
    keepAwake = s.keepAwake ?? true;
    void updateWakeLock();
    bgmSettings.volume = (s.bgmVol ?? 50) / 100;
    bgm.applyVolume();
    renderer.rig.pitchOffset = s.camPitch ?? 0;
    setOrientMode(s.orient ?? 'auto');
    renderer.kick();
    storeSettings(s);
  },
  startNew: (o) => startWith(() => game.newCity(o)),
});

Object.assign(hud.settings, loadSettings());
renderer.timeScale = () => (inGame ? SPEED_SCALE[game.speed] ?? 1 : 0);
hud.applySettings();

tools.onResult = (_ok, msg) => hud.showToast(msg, true);

let pitchSave = 0;
new Input(canvas, renderer, tools, {
  onTap: (c) => {
    if (!inGame) return;
    if (tools.tool && tools.tool !== 'query') return;
    hud.showInfo(c.x, c.y);
  },
  onDragUI: (on) => hud.showDragUI(on),
  onPreview: (info, x, y, over) => hud.showPreview(info, x, y, over),
  isOverCancel: (x, y) => hud.isOverCancel(x, y),
  onCancelled: () => hud.showToast('キャンセルしました'),
  onInteract: () => {},
  // 2本指で傾きを変えたら、設定にも反映して保存する（保存は少し待ってからまとめて）
  onPitch: (v) => {
    hud.settings.camPitch = v;
    clearTimeout(pitchSave);
    pitchSave = window.setTimeout(() => storeSettings(hud.settings), 400);
  },
});

game.onReady = () => {
  renderer.init(game.grid!.n);
  inGame = true;
  hud.taxCache = {};
  hud.setInGame(true);
};
game.onGrid = (g, h) => renderer.setGrid(g, h);
game.onBuildings = (list) => renderer.setBuildings(list);
game.onMaps = (m) => renderer.setMaps(m);
game.onStats = (s) => hud.updateStats(s);
game.onNews = (items) => hud.pushNews(items);
game.onError = (msg) => hud.showToast('エラーが発生しました：' + msg.split('\n')[0], true);

// 自動保存（3分ごと、アプリを閉じるとき）
setInterval(() => void autosave(), 180000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void autosave();
});

void hud.showTitle();

// タイトル画面の背景に街の地形を表示する
game.newCity({ name: 'タイトル', seed: 20261103, style: 'river', difficulty: 1, sandbox: false });
game.setSpeed(0);
const titleReady = game.onReady;
game.onReady = () => {
  renderer.init(game.grid!.n);
  game.onReady = titleReady;
  renderer.rig.dist = 900;
};

// オフライン対応
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// 開発用
(window as unknown as Record<string, unknown>).__pm = { game, renderer, tools, hud };


// 音（BGM と効果音）：タップしたときに始める（iPhone は「指をはなした」ときでないと音を出させてくれない）。
// 電話やほかのアプリの音で止められることがあるので、ずっと見張って、止まっていたら次のタップで動かし直す
const unlockAudio = () => {
  bgm.unlock();
  void updateWakeLock();
};
for (const ev of ['touchend', 'click', 'keydown'] as const) window.addEventListener(ev, unlockAudio, true);
bgm.onSong = (name) => (hud.nowPlaying = name);

(window as unknown as { __bgm: unknown }).__bgm = { Bgm: bgm.constructor as unknown, bgm, songs: SONGS };
