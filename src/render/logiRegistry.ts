// 物流施設の形（倉庫業の建物：倉庫・配送センターなど）の一覧。
// 形を作る関数はそれぞれのファイルでここに登録する。
// 確認用：window.__logi = '名前' にすると、倉庫業・製造業・汚染型工業の建物をその形で描く（ふだんは何もしない）
import type { MeshBuilder } from './builder';
import type { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';

export type LogiFn = (mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, den: number) => void;
export const LOGI: Record<string, LogiFn> = {};

// 確認用：形を強制しているときは、その関数を返す
export function forcedLogi(): LogiFn | null {
  const k = (globalThis as { __logi?: string }).__logi;
  return k && LOGI[k] ? LOGI[k] : null;
}
