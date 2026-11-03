// Pocket Metro の起動
import './ui/style.css';
import { GameClient } from './game';
import { CityRenderer } from './render/renderer';
import { ToolController } from './ui/tools';
import { Hud, Settings } from './ui/hud';
import { Input } from './ui/input';
import { exportFile, importFile, listSaves, readSave, writeSave } from './save';
import type { SaveData } from './sim/world';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const game = new GameClient();
const renderer = new CityRenderer(canvas);
const tools = new ToolController(game, renderer);
let inGame = false;

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
    renderer.setQuality({
      shadows: s.shadows,
      cars: s.cars,
      pixelRatio: s.lowRes ? 1 : Math.min(2, window.devicePixelRatio || 1),
    });
    storeSettings(s);
  },
  startNew: (o) => startWith(() => game.newCity(o)),
});

Object.assign(hud.settings, loadSettings());
hud.applySettings();

tools.onResult = (_ok, msg) => hud.showToast(msg, true);

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
