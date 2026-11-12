// シミュレーションを動かす Web Worker
import { World } from './world';
import { SPEED_MONTH_SECONDS, DAYS_PER_MONTH } from './constants';
import type { FromWorker, GridMsg, ToWorker } from './protocol';
import { GRID_F32, GRID_I32, GRID_U8 } from './grid';

let world: World | null = null;
let acc = 0;
let last = performance.now();
let sent = { gv: -1, hv: -1, bv: -1, mv: -1 };
let lastBuildingSend = 0;

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function sync(force = false) {
  if (!world) return;
  const w = world;
  const g = w.g;
  const now = performance.now();
  if (w.gridVersion !== sent.gv || w.heightVersion !== sent.hv) {
    const heights = w.heightVersion !== sent.hv ? g.heights.slice() : undefined;
    const arrays: GridMsg['arrays'] = {};
    for (const k of [...GRID_U8, ...GRID_F32, ...GRID_I32]) arrays[k] = g[k].slice();
    post({ t: 'grid', n: g.n, heights, arrays });
    sent.gv = w.gridVersion;
    sent.hv = w.heightVersion;
  }
  if (w.buildingVersion !== sent.bv && (force || now - lastBuildingSend > 250)) {
    post({ t: 'buildings', list: [...w.buildings.values()] });
    sent.bv = w.buildingVersion;
    lastBuildingSend = now;
  }
  if (w.mapsVersion !== sent.mv) {
    const m = w.maps;
    post({
      t: 'maps',
      maps: {
        power: m.power.slice(), water: m.water.slice(), landValue: m.landValue.slice(), pollution: m.pollution.slice(),
        traffic: m.traffic.slice(), freight: m.freight.slice(), jctl: m.jctl.slice(), riders: m.riders.slice(), congestion: m.congestion.slice(),
        police: m.police.slice(), fire: m.fire.slice(), health: m.health.slice(), edu: m.edu.slice(), crime: m.crime.slice(), fireRisk: m.fireRisk.slice(),
        garbage: m.garbage.slice(), garbageLeft: m.garbageLeft.slice(), noise: m.noise.slice(),
      },
    });
    sent.mv = w.mapsVersion;
  }
  if (w.news.length) {
    post({ t: 'news', items: w.news.splice(0) });
  }
  post({ t: 'stats', stats: w.stats });
}

function start(w: World) {
  world = w;
  sent = { gv: -1, hv: -1, bv: -1, mv: -1 };
  acc = 0;
  last = performance.now();
  post({ t: 'ready', n: w.g.n, name: w.name, sandbox: w.sandbox, seed: w.seed });
  sync(true);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.t) {
      case 'new':
        start(World.create(m.opts));
        break;
      case 'load':
        start(World.load(m.data));
        break;
      case 'cmd': {
        if (!world) return;
        const res = world.exec(m.cmd);
        post({ t: 'result', req: m.req, res });
        sync(true);
        break;
      }
      case 'speed':
        if (world) {
          world.speed = m.s;
          world.updateStats();
          sync();
        }
        break;
      case 'save':
        if (world) post({ t: 'saved', req: m.req, data: world.serialize() });
        break;
    }
  } catch (err) {
    post({ t: 'error', msg: String((err as Error)?.stack || err) });
    // コマンドの途中で失敗した場合も、画面側が返事を待ち続けないようにする
    if (m.t === 'cmd') post({ t: 'result', req: m.req, res: { ok: false, msg: 'エラーが発生しました' } });
  }
};

setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.5, (now - last) / 1000);
  last = now;
  if (!world) return;
  const sec = SPEED_MONTH_SECONDS[world.speed];
  if (sec > 0) {
    acc += (dt * DAYS_PER_MONTH) / sec;
    let steps = 0;
    while (acc >= 1 && steps < 6) {
      world.stepDay();
      acc -= 1;
      steps++;
    }
    if (steps >= 6) acc = 0;
  }
  sync();
}, 100);
