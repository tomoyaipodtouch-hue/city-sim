// 画面と Worker の間のメッセージ
import type { Building, Command, CmdResult, Maps, SaveData, Stats } from './world';
import type { MapStyle } from './terrain';

export interface NewCityOpts {
  name: string;
  seed: number;
  style: MapStyle;
  difficulty: number;
  sandbox: boolean;
  n?: number; // マップの広さ（128 = 中、256 = 大）
}

export type ToWorker =
  | { t: 'new'; opts: NewCityOpts }
  | { t: 'load'; data: SaveData }
  | { t: 'cmd'; req: number; cmd: Command }
  | { t: 'speed'; s: number }
  | { t: 'save'; req: number };

export interface GridMsg {
  t: 'grid';
  n: number;
  heights?: Float32Array;
  arrays: Record<string, Uint8Array | Float32Array | Int32Array>; // GRID_U8 / GRID_F32 / GRID_I32 の配列
}

export type FromWorker =
  | { t: 'ready'; n: number; name: string; sandbox: boolean; seed: number }
  | GridMsg
  | { t: 'buildings'; list: Building[] }
  | { t: 'maps'; maps: Maps }
  | { t: 'stats'; stats: Stats }
  | { t: 'news'; items: string[] }
  | { t: 'result'; req: number; res: CmdResult }
  | { t: 'saved'; req: number; data: SaveData }
  | { t: 'error'; msg: string };
