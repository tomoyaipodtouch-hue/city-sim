// Worker とのやりとりと、画面側の状態
import { Grid } from './sim/grid';
import type { Building, CmdResult, Command, Maps, SaveData, Stats } from './sim/world';
import type { FromWorker, NewCityOpts, ToWorker } from './sim/protocol';

export class GameClient {
  worker: Worker;
  grid: Grid | null = null;
  buildings = new Map<number, Building>();
  buildingList: Building[] = [];
  maps: Maps | null = null;
  stats: Stats | null = null;
  name = '';
  sandbox = false;
  private req = 1;
  private pending = new Map<number, (v: unknown) => void>();

  onReady: (() => void) | null = null;
  onGrid: ((g: Grid, heightsChanged: boolean) => void) | null = null;
  onBuildings: ((list: Building[]) => void) | null = null;
  onMaps: ((m: Maps) => void) | null = null;
  onStats: ((s: Stats) => void) | null = null;
  onNews: ((items: string[]) => void) | null = null;
  onError: ((msg: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
  }

  private post(m: ToWorker) {
    this.worker.postMessage(m);
  }

  private handle(m: FromWorker) {
    switch (m.t) {
      case 'ready':
        this.grid = new Grid(m.n);
        this.name = m.name;
        this.sandbox = m.sandbox;
        this.buildings.clear();
        this.buildingList = [];
        this.maps = null;
        this.onReady?.();
        break;
      case 'grid': {
        if (!this.grid || this.grid.n !== m.n) this.grid = new Grid(m.n);
        const g = this.grid;
        if (m.heights) g.heights.set(m.heights);
        const rec = g as unknown as Record<string, { set(a: ArrayLike<number>): void }>;
        for (const k in m.arrays) rec[k]?.set(m.arrays[k]);
        this.onGrid?.(g, !!m.heights);
        break;
      }
      case 'buildings':
        this.buildingList = m.list;
        this.buildings = new Map(m.list.map((b) => [b.id, b]));
        this.onBuildings?.(m.list);
        break;
      case 'maps':
        this.maps = m.maps;
        this.onMaps?.(m.maps);
        break;
      case 'stats':
        this.stats = m.stats;
        this.onStats?.(m.stats);
        break;
      case 'news':
        this.onNews?.(m.items);
        break;
      case 'result':
      case 'saved': {
        const r = this.pending.get(m.req);
        this.pending.delete(m.req);
        r?.(m.t === 'result' ? m.res : m.data);
        break;
      }
      case 'error':
        console.error(m.msg);
        this.onError?.(m.msg);
        break;
    }
  }

  newCity(opts: NewCityOpts) {
    this.post({ t: 'new', opts });
  }
  load(data: SaveData) {
    this.post({ t: 'load', data });
  }
  speed = 0;
  setSpeed(s: number) {
    this.speed = s;
    this.post({ t: 'speed', s });
  }
  exec(cmd: Command): Promise<CmdResult> {
    const req = this.req++;
    return new Promise((res) => {
      this.pending.set(req, res as (v: unknown) => void);
      this.post({ t: 'cmd', req, cmd });
    });
  }
  save(): Promise<SaveData> {
    const req = this.req++;
    return new Promise((res) => {
      this.pending.set(req, res as (v: unknown) => void);
      this.post({ t: 'save', req });
    });
  }
}
