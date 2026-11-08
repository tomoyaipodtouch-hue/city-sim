// 画面の UI（左のツール、下のバー、シート、タイトル画面）
import type { GameClient } from '../game';
import type { CityRenderer } from '../render/renderer';
import { DATA_VIEWS, DataView } from '../render/overlay';
import { ToolController, TOOL_GROUPS, PreviewInfo } from './tools';
import { ADVISORS, AdvisorId, LOAN_AMOUNTS, MAX_LOANS, ordinanceCost, ORDINANCES } from '../sim/governance';
import { CIVIC, CivicId, plantPower, DENSITY_NAMES, DEPTS, DEPT_NAMES, DIFFICULTY, isHighway, LINES, GROW, GROW_KINDS, GrowKind, ROADS, TAX_LABELS, ZONE_NAMES } from '../sim/defs';
import { BState } from '../sim/world';
import type { Stats } from '../sim/world';
import { sfx, soundSettings } from '../sound';
import type { SaveMeta } from '../save';
import type { MapStyle } from '../sim/terrain';
import type { NewCityOpts } from '../sim/protocol';
import { BRIDGE_STYLES } from '../render/bridgeStyles';
import { platformCells } from '../sim/plan';
import { OrientMode, toApp } from './orient';

const ICONS: Record<string, string> = {
  road: '<path d="M8 21 10.5 3M16 21 13.5 3M12 6v2M12 11v2M12 16v2"/>',
  zone: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  power: '<path d="M13 2 5 13h6l-1 9 8-11h-6z"/>',
  water: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  civic: '<path d="M3 9 12 4l9 5M5 9v9M19 9v9M9.5 9v9M14.5 9v9M3 20h18"/>',
  transit: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l1.5-4M16 21l-1.5-4"/><circle cx="8.5" cy="14" r=".6"/><circle cx="15.5" cy="14" r=".6"/>',
  terrain: '<path d="M2 20 9 8l4 6 3-4 6 10z"/>',
  bulldoze: '<rect x="4" y="15" width="12" height="5" rx="2.5"/><circle cx="6.5" cy="17.5" r=".8"/><circle cx="10" cy="17.5" r=".8"/><circle cx="13.5" cy="17.5" r=".8"/><path d="M5 15v-3h6.5l1.5 3M7 12V7.5h4.5V12"/><path d="M16 15.5l2.5-2"/><path d="M18.5 9.5c1.6 1.6 2 5.5 1.2 9.5"/><path d="M18.5 9.5l1.2 9.5"/>',
  query: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  hide: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  show: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pause: '<rect x="5" y="4" width="4.5" height="16" rx="1"/><rect x="14.5" y="4" width="4.5" height="16" rx="1"/>',
  play1: '<path d="M7 4v16l12-8z"/>',
  play2: '<path d="M3 5v14l9-7zM12 5v14l9-7z"/>',
  play3: '<path d="M1 5v14l7-7zM8 5v14l7-7zM15 5v14l7-7z"/>',
};
const svg = (k: string, filled = false) =>
  `<svg viewBox="0 0 24 24" ${filled ? 'style="fill:currentColor;stroke:none"' : ''}>${ICONS[k]}</svg>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const yen = (v: number) => `§${Math.round(v).toLocaleString()}`;
const num = (v: number) => Math.round(v).toLocaleString();

export function formatDate(day: number) {
  const y = Math.floor(day / 360) + 1;
  const m = Math.floor((day % 360) / 30) + 1;
  return `${y}年 ${m}月`;
}

export interface Settings {
  shadows: boolean;
  lowRes: boolean;
  cars: boolean;
  sound: boolean;
  fps: boolean;
  hq: boolean;
  bgm: boolean;
  bgmVol: number; // 0..100
  dayNight: 'auto' | 'day' | 'night';
  camPitch: number; // カメラの角度のずれ（度）。マイナスで地面に近く（横から）、プラスで真上寄り
  orient: OrientMode; // 縦持ちのときの表示（auto = 縦の配置、cw / ccw = 横ロックモード）
}

export interface HudActions {
  saveSlot: (slot: string) => Promise<void>;
  loadSlot: (slot: string) => Promise<void>;
  exportFile: () => Promise<void>;
  importFile: (f: File) => Promise<void>;
  listSaves: () => Promise<SaveMeta[]>;
  toTitle: () => void;
  applySettings: (s: Settings) => void;
  startNew: (o: NewCityOpts) => void;
  continueAuto: () => Promise<void>;
}

export class Hud {
  root: HTMLElement;
  private toolbar = el('div', 'toolbar');
  private sub = el('div', 'sub hidden');
  private bar = el('div', 'bar');
  private news = el('div', 'news');
  private info = el('div', 'info hidden');
  private toast = el('div', 'toast hidden');
  private cost = el('div', 'cost hidden');
  private cancelZone = el('div', 'cancel hidden', '✕　ここで指を離すとキャンセル');
  private chips = el('div', 'chips hidden');
  private restore = el('button', 'restore hidden', svg('show'));
  private fpsEl = el('div', 'fps hidden');
  private sheetBg = el('div', 'sheet-bg hidden');
  private sheet = el('div', 'sheet hidden');
  private title = el('div', 'title hidden');
  private group = ''; // 選んでいるツールのグループ
  private subGroup = ''; // 開いているサブメニューのグループ
  private toastTimer = 0;
  private newsQueue: string[] = [];
  private newsTimer = 0;
  private stats: Stats | null = null;
  private sheetTab = 'budget';
  private infoCell: { x: number; y: number } | null = null;
  private hidden = false;
  private barEls: Record<string, HTMLElement> = {};
  nowPlaying = '';
  settings: Settings = { shadows: true, lowRes: false, cars: true, sound: true, fps: false, hq: false, bgm: true, bgmVol: 50, dayNight: 'auto', camPitch: 0, orient: 'auto' };

  constructor(private game: GameClient, private r: CityRenderer, private tools: ToolController, private act: HudActions) {
    this.root = document.getElementById('ui')!;
    this.buildToolbar();
    this.buildBar();
    this.root.append(this.toolbar, this.sub, this.bar, this.news, this.info, this.chips, this.cancelZone, this.cost, this.toast, this.restore, this.fpsEl, this.sheetBg, this.sheet, this.title);
    this.restore.onclick = () => this.setHidden(false);
    this.sheetBg.onclick = () => this.closeSheet();
    this.setInGame(false);
    setInterval(() => {
      if (this.settings.fps) this.fpsEl.textContent = `${this.r.fps} fps`;
      if (this.infoCell && !this.info.classList.contains('hidden') && !this.junctionOpen) this.renderInfo();
    }, 1000);
  }

  setInGame(on: boolean) {
    for (const e of [this.toolbar, this.bar, this.news]) e.classList.toggle('hidden', !on || this.hidden);
    if (!on) {
      this.closeSub();
      this.info.classList.add('hidden');
      this.chips.classList.add('hidden');
      this.closeSheet();
    }
    this.restore.classList.toggle('hidden', !on || !this.hidden);
  }

  // ---------------- 左のツール ----------------
  private buildToolbar() {
    for (const g of TOOL_GROUPS) {
      const b = el('button', 'tbtn' + (g.id === 'bulldoze' ? ' demo' : ''), `${svg(g.icon)}<span>${g.name}</span>`);
      b.dataset.g = g.id;
      b.onclick = () => {
        sfx.click();
        b.blur();
        if (g.tool) {
          this.closeSub();
          const on = this.tools.tool !== g.tool;
          this.selectTool(on ? g.tool : '', g.id);
        } else if (this.subGroup === g.id && !this.sub.classList.contains('hidden')) {
          this.closeSub();
        } else this.openSub(g.id);
      };
      this.toolbar.append(b);
    }
  }

  private openSub(id: string) {
    const g = TOOL_GROUPS.find((x) => x.id === id)!;
    this.subGroup = id;
    this.sub.innerHTML = '';
    this.sub.append(el('h3', '', g.name));
    for (const it of g.items || []) {
      const b = el('button', 'sitem' + (it.tool && it.tool === this.tools.tool ? ' on' : ''));
      b.innerHTML = `<span class="l">${it.swatch ? `<i class="sw" style="background:${it.swatch}"></i>` : ''}<span class="nm">${it.name}</span></span><span class="nt">${it.note || ''}</span>`;
      b.disabled = !!it.disabled;
      b.onclick = () => {
        sfx.click();
        this.selectTool(it.tool!, id);
        this.closeSub();
        const desc = it.tool?.startsWith('plop:') ? CIVIC[it.tool.split(':')[1] as CivicId].desc : '';
        this.showToast(`${it.name}${desc ? '：' + desc : ''}`);
      };
      this.sub.append(b);
    }
    this.sub.classList.remove('hidden');
    this.highlightToolbar();
  }

  private closeSub() {
    this.sub.classList.add('hidden');
    this.subGroup = '';
    this.highlightToolbar();
  }

  selectTool(t: string, group = '') {
    this.tools.setTool(t);
    this.group = t ? group : '';
    if (t !== 'query') this.info.classList.add('hidden');
    this.highlightToolbar();
  }

  private highlightToolbar() {
    const subOpen = !this.sub.classList.contains('hidden');
    for (const b of this.toolbar.querySelectorAll<HTMLElement>('.tbtn')) {
      // サブメニューを開いている間はそのグループだけ、閉じているときは選んでいるツールのグループだけを光らせる
      const active = subOpen ? b.dataset.g === this.subGroup : !!this.tools.tool && b.dataset.g === this.group;
      b.classList.toggle('on', active);
    }
  }

  // ---------------- 下のバー ----------------
  private buildBar() {
    const st = (k: string, key: string, extra = '') => {
      const s = el('div', 'stat', `<span class="k">${k}</span><span class="v" data-v="${key}">-</span>${extra}`);
      return s;
    };
    const funds = st('資金', 'funds', '<span class="d" data-v="delta"></span>');
    const pop = st('人口', 'pop', '<span class="d" data-v="rating"></span>');
    const date = st('日付', 'date');
    const speed = el('div', 'speed');
    // 一時停止、1倍、2倍、4倍（車や列車の動き・昼夜も同じ倍率で速くなる）
    ['pause', '1×', '2×', '4×'].forEach((k, i) => {
      const b = el('button', i ? 'mul' : '', i ? k : svg(k, true));
      b.dataset.s = String(i);
      b.title = ['一時停止', '1倍速', '2倍速', '4倍速'][i];
      b.onclick = () => {
        sfx.click();
        this.game.setSpeed(i);
      };
      speed.append(b);
    });
    const rci = el('div', 'rci');
    rci.title = '需要';
    for (const [k, c] of [['R', 'var(--r)'], ['C', 'var(--c)'], ['I', 'var(--i)']]) {
      rci.append(el('div', 'col', `<div class="track"><i class="fill" data-v="d${k}" style="background:${c}"></i></div><span class="lb" style="color:${c}">${k}</span>`));
    }
    const data = el('button', 'bbtn', 'データ表示');
    data.onclick = () => {
      sfx.click();
      this.toggleChips();
    };
    const budget = el('button', 'bbtn', '予算');
    budget.onclick = () => this.openSheet('budget');
    const menu = el('button', 'bbtn', 'メニュー');
    menu.onclick = () => this.openSheet('save');
    const hide = el('button', 'bbtn icon', svg('hide'));
    hide.title = 'UIを隠す';
    hide.onclick = () => this.setHidden(true);
    this.barEls.data = data;
    this.bar.append(funds, el('div', 'sep'), pop, el('div', 'sep'), date, speed, el('div', 'sep'), rci, el('div', 'grow'), data, budget, menu, hide);
  }

  setHidden(h: boolean) {
    this.hidden = h;
    for (const e of [this.toolbar, this.bar, this.news]) e.classList.toggle('hidden', h);
    if (h) {
      this.closeSub();
      this.info.classList.add('hidden');
      this.chips.classList.add('hidden');
    }
    this.restore.classList.toggle('hidden', !h);
  }

  updateStats(s: Stats) {
    this.stats = s;
    const set = (k: string, v: string) => {
      const e = this.bar.querySelector<HTMLElement>(`[data-v="${k}"]`);
      if (e && e.textContent !== v) e.textContent = v;
    };
    set('funds', this.game.sandbox ? '∞' : yen(s.funds));
    const net = s.lastIncome - s.lastExpense;
    const d = this.bar.querySelector<HTMLElement>('[data-v="delta"]')!;
    const dt = s.lastIncome || s.lastExpense ? `${net >= 0 ? '+' : ''}${num(net)}/月` : '';
    if (d.textContent !== dt) {
      d.textContent = dt;
      d.className = 'd ' + (net >= 0 ? 'pos' : 'neg');
    }
    set('pop', num(s.population));
    const rt = this.bar.querySelector<HTMLElement>('[data-v="rating"]')!;
    const rtext = `市長評価 ${s.rating ?? '-'}`;
    if (rt.textContent !== rtext) {
      rt.textContent = rtext;
      rt.className = 'd ' + ((s.rating ?? 50) >= 50 ? 'pos' : 'neg');
    }
    set('date', formatDate(s.day));
    for (const b of this.bar.querySelectorAll<HTMLElement>('.speed button')) b.classList.toggle('on', Number(b.dataset.s) === s.speed);
    ['R', 'C', 'I'].forEach((k, i) => {
      const f = this.bar.querySelector<HTMLElement>(`[data-v="d${k}"]`)!;
      const v = Math.max(-1, Math.min(1, s.demandRCI[i]));
      const h = Math.abs(v) * 50;
      f.style.height = `${h}%`;
      f.style.top = v >= 0 ? `${50 - h}%` : '50%';
      f.style.opacity = v >= 0 ? '1' : '0.55';
    });
    if (!this.sheet.classList.contains('hidden') && (this.sheetTab === 'budget' || this.sheetTab === 'tax') && !this.deptDrag) this.refreshSheetLive();
  }

  // ---------------- ニュース ----------------
  pushNews(items: string[]) {
    this.newsQueue.push(...items);
    if (!this.newsTimer) this.nextNews();
  }
  private nextNews() {
    const m = this.newsQueue.shift();
    if (!m) {
      this.newsTimer = 0;
      return;
    }
    sfx.news();
    this.news.innerHTML = `<b>ニュース</b>${m}`;
    this.newsTimer = window.setTimeout(() => this.nextNews(), this.newsQueue.length ? 4000 : 9000);
  }

  // ---------------- トーストと費用 ----------------
  showToast(msg: string, err = false) {
    this.toast.textContent = msg;
    this.toast.classList.toggle('err', err);
    this.toast.classList.remove('hidden');
    this.toast.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.style.opacity = '0';
      setTimeout(() => this.toast.classList.add('hidden'), 300);
    }, 2600);
  }

  showDragUI(on: boolean) {
    this.cancelZone.classList.toggle('hidden', !on);
    this.cancelZone.classList.remove('over');
    if (!on) this.cost.classList.add('hidden');
  }

  showPreview(info: PreviewInfo | null | undefined, x: number, y: number, over: boolean) {
    this.cancelZone.classList.toggle('over', over);
    if (info === null) {
      this.cost.classList.add('hidden');
      return;
    }
    if (info) {
      this.cost.textContent = over ? 'キャンセル' : info.text;
      this.cost.classList.toggle('bad', info.bad || over);
    } else if (over) {
      this.cost.textContent = 'キャンセル';
      this.cost.classList.add('bad');
    }
    this.cost.style.left = `${x}px`;
    this.cost.style.top = `${y - 30}px`;
    this.cost.classList.remove('hidden');
  }

  isOverCancel(x: number, y: number) {
    if (this.cancelZone.classList.contains('hidden')) return false;
    // 画面を回していることがあるので、#app の中の座標に直して比べる
    const b = this.cancelZone.getBoundingClientRect();
    const [x0, y0] = toApp(b.left, b.top), [x1, y1] = toApp(b.right, b.bottom);
    const r = { left: Math.min(x0, x1), right: Math.max(x0, x1), top: Math.min(y0, y1), bottom: Math.max(y0, y1) };
    return x >= r.left - 10 && x <= r.right + 10 && y >= r.top - 10 && y <= r.bottom + 14;
  }

  // ---------------- データ表示 ----------------
  private toggleChips() {
    if (!this.chips.classList.contains('hidden')) {
      this.chips.classList.add('hidden');
      return;
    }
    this.renderChips();
    this.chips.classList.remove('hidden');
  }

  private renderChips() {
    this.chips.innerHTML = '';
    for (const v of DATA_VIEWS) {
      const c = el('button', 'chip' + (this.r.dataView === v.id ? ' on' : ''), v.name);
      c.onclick = () => {
        sfx.click();
        this.r.setDataView(v.id);
        this.barEls.data.classList.toggle('on', v.id !== 'none');
        this.renderChips();
      };
      this.chips.append(c);
    }
    const legend = LEGENDS[this.r.dataView];
    if (legend) this.chips.append(el('div', 'legend', legend));
  }

  // ---------------- 情報 ----------------
  showInfo(x: number, y: number) {
    this.infoCell = { x, y };
    this.renderInfo();
    this.info.classList.remove('hidden');
  }

  private renderInfo() {
    const g = this.game.grid, m = this.game.maps;
    const c = this.infoCell;
    if (!g || !c) return;
    const i = g.idx(c.x, c.y);
    const rows: [string, string][] = [];
    let title = '空き地';
    const bid = g.bldg[i];
    const meter = (v: number, color: string) => `<div class="meter"><i style="width:${Math.round(Math.max(0, Math.min(1, v)) * 100)}%;background:${color}"></i></div>`;
    if (bid) {
      const b = this.game.buildings.get(bid);
      if (b) {
        if (b.civic) {
          const def = CIVIC[b.type as CivicId];
          title = def.name;
          if (def.power) rows.push(['発電量', `${plantPower(b.type as CivicId, g.cellH(b.x, b.y))} MW`]);
          if (def.power && def.pollution === 0) rows.push(['大気汚染', 'なし']);
          if (def.water) rows.push(['給水量', `${def.water}`], ['電力', b.powered ? 'あり' : '<span class="neg">なし</span>']);
          if (def.pollution) rows.push(['大気汚染', def.pollution > 20 ? 'ひどい' : 'ややある']);
          if (def.transit && m) {
            // 駅のまわりの線路（バス停は道路）の乗客数
            const N = g.n * g.n;
            const l = def.transit === 'bus' ? 0 : ['rail', 'erail', 'mono', 'sub'].indexOf(def.transit) + 1;
            let v = 0;
            for (let yy = b.y - 1; yy <= b.y + b.h; yy++) for (let xx = b.x - 1; xx <= b.x + b.w; xx++) if (g.inb(xx, yy)) v = Math.max(v, m.riders[l * N + g.idx(xx, yy)]);
            rows.push(['近くの乗客数', `${num(v)} 人/日`]);
          }
          if (b.note) rows.push(['状態', b.note]);
          if (def.service) this.facilityId = b.id;
          rows.push(['維持費', `${yen(def.upkeep)}/月`]);
        } else {
          const def = GROW[b.type as GrowKind];
          const isR = def.zone === 1;
          title = def.name;
          if (b.state === BState.Building) rows.push(['状態', '建設中']);
          else if (b.state === BState.Abandoned) rows.push(['状態', '<span class="neg">空き家</span>']);
          rows.push([isR ? '住人' : '働く人', `${num(b.occ)} / ${num(b.cap)}`]);
          rows.push(['密度', DENSITY_NAMES[b.den] + (b.floors ? `・${b.floors}階建て` : '')]);
          rows.push(['電力', b.powered ? 'あり' : '<span class="neg">なし</span>'], ['水道', b.watered ? 'あり' : '<span class="neg">なし</span>']);
          if (b.customers !== undefined && b.state === BState.Normal) rows.push(['買い物客', `${Math.round(b.customers * 100)}%`]);
          if (b.freight !== undefined && b.state === BState.Normal) rows.push(['貨物の輸送', b.freight >= 0.95 ? `できている（${(b.freightTime ?? 0).toFixed(0)} 分）` : `<span class="neg">${Math.round(b.freight * 100)}%</span>`]);
          if (m && b.state === BState.Normal) rows.push(['犯罪', `${Math.round((m.crime[g.idx(b.x, b.y)] / 255) * 100)}`]);
          if (isR && b.state === BState.Normal) {
            rows.push(['職のある人', `${Math.round(b.employed * 100)}%`]);
            rows.push(['通勤時間', b.commute ? `${b.commute.toFixed(0)} 分` : '-']);
          }
        }
      }
    } else if (g.road[i] || g.up[i]) {
      const N = g.n * g.n;
      const levels: [number, number][] = [];
      if (g.road[i]) levels.push([g.road[i], i]);
      if (g.up[i]) levels.push([g.up[i], i + N]);
      title = levels.map(([t]) => ROADS[t].name).join(' ／ ');
      for (const [t, node] of levels) {
        const def = ROADS[t];
        const vol = m ? m.traffic[node] : 0;
        const ratio = vol / def.capacity;
        const pre = levels.length > 1 ? `${def.name}：` : '';
        rows.push([`${pre}交通量`, `${num(vol)} 台/日`]);
        rows.push([`${pre}混雑度`, `${Math.round(ratio * 100)}%${meter(ratio, ratio > 1 ? 'var(--bad)' : ratio > 0.7 ? 'var(--warn)' : 'var(--good)')}`]);
      }
      rows.push(['制限速度', levels.map(([t]) => `${ROADS[t].speedKmh} km/h`).join(' ／ ')]);
      if (g.bstop[i]) rows.push(['バス停', m ? `あり（バスの乗客 ${num(m.riders[i])} 人/日）` : 'あり']);
      if (m && m.jctl[i]) rows.push(['交差点', CTL_NAMES[m.jctl[i]] + (g.ictl[i] === 0 ? '（自動）' : '')]);
    } else if (g.rail[i] || g.erail[i] || g.mono[i]) {
      const kinds = (['rail', 'erail', 'mono'] as const).filter((k) => g[k][i]);
      title = kinds.map((k) => LINES[k].name).join(' ／ ');
      if (m) for (const k of kinds) rows.push([`${LINES[k].name}の乗客`, `${num(m.riders[(['rail', 'erail', 'mono', 'sub'].indexOf(k) + 1) * g.n * g.n + i])} 人/日`]);
    }
    if (!bid && !g.road[i] && !g.up[i] && g.sub[i] && m) rows.push(['地下鉄の乗客', `${num(m.riders[4 * g.n * g.n + i])} 人/日`]);
    if (bid || g.road[i] || g.up[i] || g.rail[i] || g.erail[i] || g.mono[i]) {
      // 上で処理済み
    } else if (g.isWater(c.x, c.y)) {
      title = '水域';
    } else if (g.zone[i]) {
      title = `${ZONE_NAMES[g.zone[i]]}ゾーン（空き地）`;
    }
    if (m && !g.isWater(c.x, c.y)) {
      const lv = m.landValue[i] / 255;
      rows.push(['地価', `${Math.round(lv * 100)}${meter(lv, 'var(--accent)')}`]);
      const p = Math.min(1, m.pollution[i] / 140);
      rows.push(['大気汚染', `${Math.round(p * 100)}${meter(p, '#b07a3a')}`]);
      if (!bid && g.zone[i]) rows.push(['電力', m.power[i] ? 'あり' : '<span class="neg">なし</span>'], ['水道', m.water[i] ? 'あり' : 'なし']);
    }
    rows.push(['場所', `${c.x}, ${c.y}`]);
    this.info.innerHTML = `<h4><span>${title}</span><button class="x">✕</button></h4><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    this.info.querySelector<HTMLElement>('.x')!.onclick = () => this.info.classList.add('hidden');
    // 公共サービスの施設ごとの予算
    if (this.facilityId && bid === this.facilityId) {
      const b = this.game.buildings.get(bid)!;
      const box = el('div', 'jpanel');
      box.innerHTML = `<h5>この施設の予算</h5><div class="jrow"><input type="range" min="0" max="150" step="5" value="${b.fund ?? 100}"><span class="v">${b.fund ?? 100}%</span></div>`;
      const input = box.querySelector('input')!;
      const v = box.querySelector<HTMLElement>('.v')!;
      input.onchange = () => void this.game.exec({ t: 'facilityFund', id: b.id, value: Number(input.value) });
      input.oninput = () => (v.textContent = `${input.value}%`);
      this.info.append(box);
      this.junctionOpen = true; // 操作中に作り直さないようにする
    }
    this.facilityId = 0;
    // 建物の向き
    if (bid) {
      const b = this.game.buildings.get(bid);
      if (b) {
        const box = el('div', 'jpanel');
        const btn = el('button', 'btn', b.w === b.h ? '向きを変える（90°）' : '向きを変える（180°）');
        btn.onclick = () => { sfx.click(); void this.game.exec({ t: 'rotate', id: b.id }); };
        box.append(btn);
        this.info.append(box);
      }
    }
    // 交差点の設定（地上の一般道で、3方向以上につながっている場所）
    this.junctionOpen = false;
    // 高架鉄道の駅のホームの形
    if (g.erail[i] && platformCells(g, i, [...this.game.buildings.values()]).length) {
      const box = el('div', 'jpanel');
      box.append(el('h5', '', 'ホームの形'));
      const seg = el('div', 'seg');
      ['相対式', '島式'].forEach((name, k) => {
        const b = el('button', g.pstyle[i] === k ? 'on' : '', name);
        b.onclick = () => {
          sfx.click();
          seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          void this.game.exec({ t: 'platformStyle', cell: i, style: k });
        };
        seg.append(b);
      });
      box.append(seg);
      box.append(el('p', 'muted', '島式は、駅の前後で線路が左右に広がり、線路の間に広いホームができます。'));
      this.info.append(box);
      this.junctionOpen = true;
    }
    if ((g.road[i] && g.deck[i] > 0) || (g.erail[i] && g.isWater(c.x, c.y))) {
      this.junctionOpen = true;
      this.info.append(this.bridgePanel(i));
    }
    if (g.road[i] && !isHighway(g.road[i]) && g.road[i] !== 7) {
      let deg = 0;
      for (let d = 0; d < 8; d++) if (g.conn[i] & (1 << d)) deg++;
      if (deg >= 3) {
        this.junctionOpen = true;
        this.info.append(this.junctionPanel(i));
      }
    }
  }

  private junctionOpen = false;
  private facilityId = 0;

  // 橋の形
  private bridgePanel(cell: number): HTMLElement {
    const g = this.game.grid!;
    const box = el('div', 'jpanel');
    box.append(el('h5', '', '橋の形'));
    const seg = el('div', 'seg wrap');
    BRIDGE_STYLES.forEach((name, k) => {
      const b = el('button', g.bstyle[cell] === k ? 'on' : '', name);
      b.onclick = () => {
        sfx.click();
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        void this.game.exec({ t: 'bridgeStyle', cell, style: k });
      };
      seg.append(b);
    });
    box.append(seg);
    box.append(el('p', 'muted', '見た目だけが変わります（費用はかかりません）。'));
    return box;
  }

  private junctionPanel(cell: number): HTMLElement {
    const g = this.game.grid!;
    const box = el('div', 'jpanel');
    const state = { ctl: g.ictl[cell], split: g.isplit[cell], flags: g.iflags[cell] };
    const send = () => {
      void this.game.exec({ t: 'junction', cell, ctl: state.ctl, split: state.split, flags: state.flags });
    };
    box.append(el('h5', '', '交差点の設定'));
    const seg = el('div', 'seg wrap');
    CTL_NAMES.forEach((name, k) => {
      const b = el('button', state.ctl === k ? 'on' : '', name);
      b.onclick = () => {
        sfx.click();
        state.ctl = k;
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        splitRow.classList.toggle('hidden', k !== 3);
        send();
      };
      seg.append(b);
    });
    box.append(seg);
    const splitRow = el('div', 'jrow' + (state.ctl === 3 ? '' : ' hidden'));
    splitRow.innerHTML = `<span>信号の時間配分</span><span class="muted">南北</span><input type="range" min="10" max="90" step="5" value="${state.split}"><span class="muted">東西</span>`;
    splitRow.querySelector('input')!.onchange = (e) => {
      state.split = Number((e.target as HTMLInputElement).value);
      send();
    };
    box.append(splitRow);
    const flags: [number, string][] = [[1, '左折レーン'], [2, '右折レーン'], [4, '左折禁止'], [8, '右折禁止'], [16, '直進のみ']];
    const fl = el('div', 'chips-inline');
    for (const [bit, name] of flags) {
      const b = el('button', 'chip' + (state.flags & bit ? ' on' : ''), name);
      b.onclick = () => {
        sfx.click();
        state.flags ^= bit;
        b.classList.toggle('on', !!(state.flags & bit));
        send();
      };
      fl.append(b);
    }
    box.append(fl);
    box.append(el('p', 'muted', '「自動」は交通量に合わせて、信号なし・一時停止・信号を切り替えます。'));
    return box;
  }

  // ---------------- シート ----------------
  openSheet(tab: string) {
    sfx.click();
    this.sheetTab = tab;
    this.sheetBg.classList.remove('hidden');
    this.sheet.classList.remove('hidden');
    void this.renderSheet();
  }

  closeSheet() {
    this.sheet.classList.add('hidden');
    this.sheetBg.classList.add('hidden');
  }

  private async renderSheet() {
    const tabs: [string, string][] = [['budget', '予算'], ['tax', '税金'], ['ord', '条例'], ['loan', '借入'], ['advisor', 'アドバイザー'], ['save', '保存'], ['settings', '設定'], ['city', '街']];
    const head = el('div', 'sheet-h');
    for (const [id, name] of tabs) {
      const t = el('button', 'tab' + (id === this.sheetTab ? ' on' : ''), name);
      t.onclick = () => {
        this.sheetTab = id;
        void this.renderSheet();
      };
      head.append(t);
    }
    head.append(el('div', 'grow'));
    const close = el('button', 'close', '✕');
    close.onclick = () => this.closeSheet();
    head.append(close);
    const body = el('div', 'sheet-b');
    this.sheet.innerHTML = '';
    this.sheet.append(head, body);
    if (this.sheetTab === 'budget' || this.sheetTab === 'tax') this.refreshSheetLive();
    else if (this.sheetTab === 'ord') this.renderOrdinances(body);
    else if (this.sheetTab === 'loan') this.renderLoans(body);
    else if (this.sheetTab === 'advisor') this.renderAdvisors(body);
    else if (this.sheetTab === 'save') await this.renderSave(body);
    else if (this.sheetTab === 'settings') this.renderSettings(body);
    else this.renderCity(body);
  }

  private refreshSheetLive() {
    const body = this.sheet.querySelector<HTMLElement>('.sheet-b');
    const s = this.stats;
    if (!body || !s) return;
    if (this.sheetTab === 'budget') {
      const inc = s.incomeBreakdown, exp = s.expenseBreakdown;
      const rows = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `<tr><td>${k}</td><td>${yen(v)}</td></tr>`).join('');
      const unemp = s.workers > 0 ? Math.max(0, 1 - s.employed / s.workers) : 0;
      body.innerHTML = `
        <div class="cols">
          <div><h5>収入（先月）</h5><table class="tbl">${rows(inc) || '<tr><td>まだありません</td><td></td></tr>'}<tr class="total"><td>合計</td><td>${yen(s.lastIncome)}</td></tr></table>
          <h5 style="margin-top:14px">支出（先月）</h5><table class="tbl">${rows(exp) || '<tr><td>まだありません</td><td></td></tr>'}<tr class="total"><td>合計</td><td>${yen(s.lastExpense)}</td></tr></table></div>
          <div><h5>街の状況</h5><table class="tbl">
            <tr><td>資金</td><td>${this.game.sandbox ? '∞（サンドボックス）' : yen(s.funds)}</td></tr>
            <tr><td>収支</td><td class="${s.lastIncome - s.lastExpense >= 0 ? 'pos' : 'neg'}">${yen(s.lastIncome - s.lastExpense)}/月</td></tr>
            <tr><td>人口</td><td>${num(s.population)} 人</td></tr>
            <tr><td>雇用</td><td>${num(s.jobs)} 人分</td></tr>
            <tr><td>失業率</td><td>${Math.round(unemp * 100)}%</td></tr>
            <tr><td>通勤の交通手段</td><td>車 ${Math.round((s.modeShare?.car ?? 0) * 100)}%・公共交通 ${Math.round((s.modeShare?.transit ?? 0) * 100)}%・徒歩 ${Math.round((s.modeShare?.walk ?? 0) * 100)}%</td></tr>
            <tr><td>公共交通の乗客</td><td>${num(s.transitRiders ?? 0)} 人/日</td></tr>
            <tr><td>平均通勤時間</td><td>${s.avgCommute ? s.avgCommute.toFixed(1) + ' 分' : '-'}</td></tr>
            <tr><td>電力（使用 / 発電）</td><td class="${s.powerDemand > s.powerSupply ? 'neg' : ''}">${num(s.powerDemand)} / ${num(s.powerSupply)} MW</td></tr>
            <tr><td>水道（使用 / 給水）</td><td class="${s.waterDemand > s.waterSupply ? 'neg' : ''}">${num(s.waterDemand)} / ${num(s.waterSupply)}</td></tr>
            <tr><td>隣の都市との道路</td><td>${s.neighborConnected ? 'つながっている' : '<span class="neg">つながっていない</span>'}</td></tr>
          </table>
          </div>
        </div>
        <h5 style="margin-top:14px">公共サービス</h5>
        <table class="tbl">
          <tr><td>教育水準（子ども／大人／高齢者）</td><td>${Math.round(s.services.eq.child)} ／ ${Math.round(s.services.eq.adult)} ／ ${Math.round(s.services.eq.elderly)}</td></tr>
          <tr><td>健康度・平均寿命</td><td>${Math.round(s.services.hq)} ・ ${s.services.lifeExp.toFixed(0)} 歳</td></tr>
          <tr><td>犯罪（住人が感じる度合い）</td><td>${Math.round(s.services.crime * 100)}</td></tr>
          <tr><td>ゴミ（出る量／処理／残り）</td><td class="${s.services.garbage.excess > 0 ? 'neg' : ''}">${num(s.services.garbage.produced)} ／ ${num(s.services.garbage.handled)} ／ ${num(s.services.garbage.excess)} /月</td></tr>
        </table>
        <h5 style="margin-top:14px">部門ごとの予算</h5>
        <p class="muted" style="margin:0 0 8px">100% が標準です。下げると費用が減りますが効き目も下がり、60%未満が6か月続くとストライキが起きます。</p>
        <div class="depts"></div>
        `;
      this.renderDepts(body.querySelector<HTMLElement>('.depts')!, s);
    } else {
      // 税金のスライダーは作り直すと操作中に途切れるので、値だけ更新する
      if (!body.querySelector('.tax')) {
        body.innerHTML = '<h5>税率（ゾーンの種類と所得層ごと）</h5><p class="muted" style="margin:0 0 8px">税率を上げると収入が増えますが、その種類の需要が下がります。標準は 9% です。</p>';
        for (const k of GROW_KINDS) {
          const row = el('div', 'tax');
          row.innerHTML = `<span>${TAX_LABELS[k]}</span><input type="range" min="0" max="20" step="0.5" value="9"><span class="v"></span><span class="dm" data-k="${k}"></span>`;
          const input = row.querySelector('input')!;
          const v = row.querySelector<HTMLElement>('.v')!;
          input.dataset.k = k;
          input.oninput = () => {
            v.textContent = `${Number(input.value).toFixed(1)}%`;
            void this.game.exec({ t: 'tax', kind: k, rate: Number(input.value) });
            this.taxCache[k] = Number(input.value);
          };
          const rate = this.taxCache[k] ?? 9;
          input.value = String(rate);
          v.textContent = `${rate.toFixed(1)}%`;
          body.append(row);
        }
      }
      for (const k of GROW_KINDS) {
        const d = body.querySelector<HTMLElement>(`.dm[data-k="${k}"]`);
        const v = s.demand[k];
        if (d) {
          d.textContent = `需要 ${v >= 0 ? '+' : ''}${Math.round(v * 100)}`;
          d.className = 'dm ' + (v >= 0 ? 'pos' : 'neg');
        }
      }
    }
  }
  taxCache: Partial<Record<GrowKind, number>> = {};
  private deptDrag = false;

  private renderDepts(box: HTMLElement, s: Stats) {
    for (const d of DEPTS) {
      const row = el('div', 'tax');
      const strike = s.services.strike[d] > 0;
      row.innerHTML = `<span>${DEPT_NAMES[d]}</span><input type="range" min="0" max="150" step="5" value="${s.services.funding[d]}"><span class="v">${s.services.funding[d]}%</span><span class="dm ${strike ? 'neg' : ''}">${strike ? 'スト中' : ''}</span>`;
      const input = row.querySelector('input')!;
      const v = row.querySelector<HTMLElement>('.v')!;
      input.oninput = () => {
        v.textContent = `${input.value}%`;
        void this.game.exec({ t: 'funding', dept: d, value: Number(input.value) });
      };
      input.onpointerdown = () => (this.deptDrag = true);
      input.onpointerup = () => (this.deptDrag = false);
      box.append(row);
    }
  }

  private renderOrdinances(body: HTMLElement) {
    const s = this.stats;
    if (!s) return;
    const on = new Set(s.ordinances);
    body.innerHTML = '<h5>条例</h5><p class="muted" style="margin:0 0 8px">施行すると毎月の費用がかかります（カジノは収入になります）。費用は人口に合わせて変わります。</p>';
    for (const o of ORDINANCES) {
      const cost = ordinanceCost(o.id, s.population);
      const locked = s.population < o.minPop && !on.has(o.id);
      const row = el('div', 'row', `<div><div>${o.name}</div><div class="desc">${o.desc}　${cost < 0 ? `収入 §${num(-cost)}/月` : `費用 §${num(cost)}/月`}${locked ? `　（人口 ${num(o.minPop)} 人から）` : ''}</div></div>`);
      const t = el('button', 'toggle' + (on.has(o.id) ? ' on' : ''));
      t.disabled = locked;
      t.onclick = async () => {
        const r = await this.game.exec({ t: 'ordinance', id: o.id, on: !on.has(o.id) });
        if (!r.ok) this.showToast(r.msg || 'できませんでした', true);
        else {
          if (on.has(o.id)) on.delete(o.id);
          else on.add(o.id);
          t.classList.toggle('on', on.has(o.id));
        }
      };
      row.append(t);
      body.append(row);
    }
  }

  private renderLoans(body: HTMLElement) {
    const s = this.stats;
    if (!s) return;
    body.innerHTML = `<h5>借入（債券）</h5><p class="muted" style="margin:0 0 8px">10年かけて毎月返済します。今の金利は年 ${s.loanRate.toFixed(1)}% です（財政状態がよいほど低くなります）。最大 ${MAX_LOANS} 件まで。</p>`;
    const btns = el('div', 'btns');
    for (const a of LOAN_AMOUNTS) {
      const b = el('button', 'btn', `§${num(a)} 借りる`);
      b.disabled = s.loans.length >= MAX_LOANS || this.game.sandbox;
      b.onclick = async () => {
        if (!confirm(`§${num(a)} を年利 ${s.loanRate.toFixed(1)}% で借りますか？`)) return;
        const r = await this.game.exec({ t: 'loan', amount: a });
        this.showToast(r.msg || '', !r.ok);
        setTimeout(() => void this.renderSheet(), 300);
      };
      btns.append(b);
    }
    body.append(btns);
    body.append(el('h5', '', '借りているお金'));
    if (!s.loans.length) body.append(el('p', 'muted', 'ありません'));
    for (const l of s.loans) {
      const row = el('div', 'row', `<div><div>§${num(l.principal)}（年利 ${l.rate.toFixed(1)}%）</div><div class="desc">残り §${num(l.remaining)}・毎月 §${num(l.payment)}・あと ${l.months} か月</div></div>`);
      const b = el('button', 'btn', '全額を返す');
      b.onclick = async () => {
        const r = await this.game.exec({ t: 'repay', id: l.id });
        this.showToast(r.msg || '', !r.ok);
        setTimeout(() => void this.renderSheet(), 300);
      };
      row.append(b);
      body.append(row);
    }
  }

  private renderAdvisors(body: HTMLElement) {
    const s = this.stats;
    if (!s) return;
    const color = ['var(--good)', 'var(--warn)', 'var(--bad)'];
    const parts = s.ratingParts.slice().sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join('、');
    body.innerHTML = `<h5>市長評価 ${s.rating}</h5><p class="muted" style="margin:0 0 10px">${parts || '特に大きな理由はありません'}</p><h5>アドバイザーからの助言</h5>`;
    const order: AdvisorId[] = ['finance', 'planning', 'traffic', 'safety', 'health', 'utility'];
    for (const id of order) {
      for (const a of s.advice.filter((x) => x.advisor === id).sort((p, q) => q.level - p.level)) {
        body.append(el('div', 'adv', `<i class="dot" style="background:${color[a.level]}"></i><div><b>${ADVISORS[id]}</b>${a.text}</div>`));
      }
    }
  }

  private async renderSave(body: HTMLElement) {
    const saves = await this.act.listSaves();
    const by = new Map(saves.map((s) => [s.slot, s]));
    body.innerHTML = '<h5>保存スロット</h5>';
    for (const slot of ['slot1', 'slot2', 'slot3', 'auto']) {
      const m = by.get(slot);
      const label = slot === 'auto' ? '自動保存' : `スロット ${slot.slice(-1)}`;
      const row = el('div', 'row');
      row.innerHTML = `<div><div>${label}</div><div class="desc">${m ? `${m.name}・人口 ${num(m.population)}・${formatDate(m.day)}・${new Date(m.savedAt).toLocaleString('ja-JP')}` : '空き'}</div></div>`;
      const btns = el('div', 'btns');
      if (slot !== 'auto') {
        const sb = el('button', 'btn pri', '保存');
        sb.onclick = async () => {
          await this.act.saveSlot(slot);
          this.showToast(`${label}に保存しました`);
          void this.renderSheet();
        };
        btns.append(sb);
      }
      if (m) {
        const lb = el('button', 'btn', '読み込む');
        lb.onclick = async () => {
          if (!confirm(`${label}を読み込みますか？\n今の街の保存していない変更は失われます。`)) return;
          await this.act.loadSlot(slot);
          this.closeSheet();
        };
        btns.append(lb);
      }
      row.append(btns);
      body.append(row);
    }
    body.append(el('h5', '', 'ファイル'));
    const fr = el('div', 'row');
    fr.innerHTML = '<div><div>ファイルに書き出す・読み込む</div><div class="desc">機種変更やバックアップに使えます</div></div>';
    const fb = el('div', 'btns');
    const ex = el('button', 'btn', '書き出す');
    ex.onclick = () => void this.act.exportFile();
    const im = el('button', 'btn', '読み込む');
    const input = el('input');
    input.type = 'file';
    input.accept = '.pmcity,application/gzip,application/json';
    input.style.display = 'none';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        await this.act.importFile(f);
        this.closeSheet();
      } catch (e) {
        this.showToast(String((e as Error).message || e), true);
      }
    };
    im.onclick = () => input.click();
    fb.append(ex, im, input);
    fr.append(fb);
    body.append(fr);
  }

  private renderSettings(body: HTMLElement) {
    body.innerHTML = '';
    // 昼と夜
    const dn = el('div', 'row', '<div><div>昼と夜</div><div class="desc">「自動」は時間が進んでいる間、約8分で1日が回ります</div></div>');
    const seg = el('div', 'seg');
    for (const [v, label] of [['auto', '自動'], ['day', '昼だけ'], ['night', '夜だけ']] as const) {
      const b = el('button', this.settings.dayNight === v ? 'on' : '', label);
      b.onclick = () => {
        this.settings.dayNight = v;
        for (const c of seg.children) c.classList.toggle('on', c === b);
        this.applySettings();
      };
      seg.append(b);
    }
    dn.append(seg);
    body.append(dn);
    // 縦持ちのときの表示（横ロックモード）
    const om = el('div', 'row', '<div><div>縦持ちのとき</div><div class="desc">「横ロック」にすると、スマホを縦向きに固定したままでも横画面で表示します。スマホを倒す向きを選んでください</div></div>');
    const oseg = el('div', 'seg wrap');
    for (const [v, label] of [['auto', '縦画面'], ['cw', '横ロック（左に倒す）'], ['ccw', '横ロック（右に倒す）']] as const) {
      const b = el('button', (this.settings.orient ?? 'auto') === v ? 'on' : '', label);
      b.onclick = () => {
        this.settings.orient = v as OrientMode;
        for (const c of oseg.children) c.classList.toggle('on', c === b);
        this.applySettings();
      };
      oseg.append(b);
    }
    om.append(oseg);
    body.append(om);
    // BGM の音量
    const bv = el('div', 'row', `<div><div>BGM の音量</div><div class="desc">静かなアンビエントの4曲を順番にくり返し流します${this.nowPlaying ? `（再生中：${this.nowPlaying}）` : ''}。BGM がオンのときは、iPhone の消音スイッチがオンでも BGM と効果音が鳴ります。BGM をオフにすると、効果音は消音スイッチにしたがいます</div></div>`);
    const vbox = el('div', 'jrow');
    vbox.style.minWidth = '190px';
    vbox.innerHTML = `<input type="range" min="0" max="100" step="5" value="${this.settings.bgmVol ?? 50}"><span class="v">${this.settings.bgmVol ?? 50}</span>`;
    const vr = vbox.querySelector('input')!, vv = vbox.querySelector('.v')!;
    vr.oninput = () => {
      this.settings.bgmVol = Number(vr.value);
      vv.textContent = vr.value;
      this.applySettings();
    };
    bv.append(vbox);
    body.append(bv);
    // カメラの角度
    const cp = el('div', 'row', '<div><div>カメラの角度</div><div class="desc">左にすると地面に近い横からの眺め、右にすると真上寄りになります。2本指で画面を上下にスワイプしても変えられます</div></div>');
    const box = el('div', 'jrow');
    box.style.minWidth = '190px';
    const label = (v: number) => (v === 0 ? '標準' : v < 0 ? `横から ${-v}°` : `真上寄り ${v}°`);
    box.innerHTML = `<input type="range" min="-30" max="15" step="1" value="${this.settings.camPitch ?? 0}"><span class="v">${label(this.settings.camPitch ?? 0)}</span>`;
    const range = box.querySelector('input')!, val = box.querySelector('.v')!;
    range.oninput = () => {
      this.settings.camPitch = Number(range.value);
      val.textContent = label(this.settings.camPitch);
      this.applySettings();
    };
    cp.append(box);
    body.append(cp);
    const items: [Exclude<keyof Settings, 'dayNight' | 'camPitch' | 'bgmVol' | 'orient'>, string, string][] = [
      ['hq', '高画質', '夜の窓や街灯の光のにじみ、色の調整、なめらかな輪郭。動作が重くなります'],
      ['shadows', '影', '建物や木の影を表示します。オフにすると動作が軽くなります'],
      ['lowRes', '解像度を下げる', '画面の細かさを下げて、動作を軽くします'],
      ['cars', '車の表示', '道路を走る車を表示します'],
      ['bgm', 'BGM', ''],
      ['sound', '効果音', ''],
      ['fps', 'フレームレートの表示', '動作の重さを確認するときに使います'],
    ];
    for (const [k, name, desc] of items) {
      const row = el('div', 'row', `<div><div>${name}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`);
      const t = el('button', 'toggle' + (this.settings[k] ? ' on' : ''));
      t.onclick = () => {
        this.settings[k] = !this.settings[k];
        t.classList.toggle('on', this.settings[k]);
        this.applySettings();
      };
      row.append(t);
      body.append(row);
    }
    body.append(el('p', 'muted', '操作：1本指でドラッグ＝地図を動かす（ツールを選んでいるときは道路を引くなど）、2本指でドラッグ＝地図を動かす、2本指で上下にスワイプ＝カメラの傾き、ピンチ＝ズーム、2本指でひねる＝回転（30°ずつ）、タップ＝情報'));
  }

  applySettings() {
    soundSettings.enabled = this.settings.sound;
    this.fpsEl.classList.toggle('hidden', !this.settings.fps);
    this.act.applySettings(this.settings);
  }

  private renderCity(body: HTMLElement) {
    body.innerHTML = `<h5>${this.game.name}</h5>`;
    const r1 = el('div', 'row', '<div><div>タイトル画面に戻る</div><div class="desc">今の街は自動保存されます</div></div>');
    const b1 = el('button', 'btn', '戻る');
    b1.onclick = () => this.act.toTitle();
    r1.append(b1);
    body.append(r1);
  }

  // ---------------- タイトル画面 ----------------
  async showTitle() {
    this.setInGame(false);
    const saves = await this.act.listSaves();
    const auto = saves.find((s) => s.slot === 'auto');
    this.title.innerHTML = '';
    const inner = el('div', 'title-in');
    const left = el('div', '', `<div class="logo">Pocket<span> Metro</span></div><div class="tag">道路を引き、ゾーンを指定して、街を育てる都市開発シミュレーション。<br>交通、電力、水道、税金をやりくりしましょう。</div>
      <div class="hint">ホーム画面に追加すると、全画面でオフラインでも遊べます。</div>`);
    const right = el('div', 'menu');
    if (auto) {
      const c = el('button', 'btn pri', `続きから（${auto.name}・${formatDate(auto.day)}）`);
      c.onclick = () => void this.act.continueAuto();
      right.append(c);
    }
    const nb = el('button', 'btn' + (auto ? '' : ' pri'), '新しい街を作る');
    nb.onclick = () => this.showNewForm();
    right.append(nb);
    const others = saves.filter((s) => s.slot !== 'auto');
    for (const s of others) {
      const b = el('button', 'btn', `読み込む：${s.name}（スロット ${s.slot.slice(-1)}）`);
      b.onclick = () => void this.act.loadSlot(s.slot);
      right.append(b);
    }
    const input = el('input');
    input.type = 'file';
    input.style.display = 'none';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        await this.act.importFile(f);
      } catch (e) {
        this.showToast(String((e as Error).message || e), true);
      }
    };
    const fb = el('button', 'btn', 'ファイルから読み込む');
    fb.onclick = () => input.click();
    right.append(fb, input);
    inner.append(left, right);
    this.title.append(inner);
    this.title.classList.remove('hidden');
  }

  hideTitle() {
    this.title.classList.add('hidden');
  }

  private showNewForm() {
    const right = this.title.querySelector('.menu')!;
    const state = { style: 'river' as MapStyle, difficulty: 1, sandbox: false, n: 128 };
    const form = el('div', 'form');
    const seg = (items: [string, string][], cur: string, on: (v: string) => void) => {
      const s = el('div', 'seg');
      for (const [v, name] of items) {
        const b = el('button', v === cur ? 'on' : '', name);
        b.onclick = () => {
          s.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          on(v);
        };
        s.append(b);
      }
      return s;
    };
    const nameWrap = el('div', '', '<label>街の名前</label>');
    const name = el('input');
    name.type = 'text';
    name.value = '新しい街';
    name.maxLength = 20;
    nameWrap.append(name);
    const terr = el('div', '', '<label>地形</label>');
    terr.append(seg([['river', '川'], ['coast', '海岸'], ['lakes', '湖']], 'river', (v) => (state.style = v as MapStyle)));
    const size = el('div', '', '<label>マップの広さ</label>');
    size.append(seg([['128', '中（2km）'], ['256', '大（4km）']], '128', (v) => (state.n = Number(v))));
    const diff = el('div', '', '<label>難易度</label>');
    diff.append(seg(DIFFICULTY.map((d, i) => [String(i), d.name] as [string, string]).concat([['sb', 'サンドボックス']]), '1', (v) => {
      state.sandbox = v === 'sb';
      state.difficulty = v === 'sb' ? 1 : Number(v);
    }));
    const btns = el('div', 'btns');
    const back = el('button', 'btn', '戻る');
    back.onclick = () => void this.showTitle();
    const go = el('button', 'btn pri', 'この設定で始める');
    go.onclick = () => {
      this.act.startNew({ name: name.value.trim() || '新しい街', seed: Math.floor(Math.random() * 1e9), style: state.style, difficulty: state.difficulty, sandbox: state.sandbox, n: state.n });
    };
    btns.append(back, go);
    form.append(nameWrap, terr, size, diff, btns);
    right.innerHTML = '';
    right.append(form);
  }
}

const CTL_NAMES = ['自動', '信号なし', '一時停止', '信号', 'ラウンドアバウト'];

const LEGENDS: Partial<Record<DataView, string>> = {
  traffic: '少ない<i class="grad" style="background:linear-gradient(90deg,#3cc85a,#f0dc3c,#f07828,#c81e28)"></i>渋滞',
  landValue: '低い<i class="grad" style="background:linear-gradient(90deg,#5a3c8c,#3c78c8,#46be78,#f0dc50,#fa8c3c)"></i>高い',
  pollution: 'きれい<i class="grad" style="background:linear-gradient(90deg,rgba(200,190,120,.2),#aa783c,#783c28)"></i>汚い',
  transit: '少ない<i class="grad" style="background:linear-gradient(90deg,#78c8ff,#3c6ef0,#963cdc)"></i>多い（乗客数）',
  power: '<span style="color:#fadc3c">■</span> 電力あり　<span style="color:#dc3232">■</span> 電力なし',
  water: '<span style="color:#3c96f0">■</span> 水あり　<span style="color:#dc463c">■</span> 水なし',
  crime: '少ない<i class="grad" style="background:linear-gradient(90deg,#f0dc78,#e6783c,#aa1e3c)"></i>多い',
  garbage: '<span style="color:#5ab96e">■</span> 処理できている　残る割合 低<i class="grad" style="background:linear-gradient(90deg,#f0c846,#e16e28,#a0281e)"></i>高（濃いほど量が多い）',
  fireRisk: '低い<i class="grad" style="background:linear-gradient(90deg,#fae678,#f08c28,#c82814)"></i>高い',
  health: '<span style="color:#c84638">■</span> 範囲外　弱い<i class="grad" style="background:linear-gradient(90deg,#b4e6c8,#3cbe78,#148250)"></i>強い',
  edu: '<span style="color:#c84638">■</span> 範囲外　弱い<i class="grad" style="background:linear-gradient(90deg,#c8d2ff,#648cf0,#3c3cc8)"></i>強い',
  zones: '<span style="color:var(--r)">■</span> 住宅　<span style="color:var(--c)">■</span> 商業　<span style="color:var(--i)">■</span> 工業',
};
