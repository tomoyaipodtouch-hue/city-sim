// 近代的なマンション（中高層・高層）の形の一覧。形を作る関数はそれぞれのファイル（resModernA・B）でここに登録する。
// minF・maxF：その形で描く階数の範囲。
// 確認用：window.__res = '名前' にすると、住宅の中高層・高層の建物をその形で描く（ふだんは何もしない）
import type { MeshBuilder } from './builder';
import type { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';

export type ResFn = (mb: MeshBuilder, f: LotFrame, rng: Rng, tf: TF, floors: number) => void;
export interface ResStyle { fn: ResFn; minF: number; maxF: number }
export const RES: Record<string, ResStyle> = {};

export function forcedRes(): ResFn | null {
  const k = (globalThis as { __res?: string }).__res;
  return k && RES[k] ? RES[k].fn : null;
}

// 階数に合う形を 1 つ選ぶ（なければ null）
export function pickRes(rng: Rng, floors: number): ResFn | null {
  const ok = Object.values(RES).filter((s) => floors >= s.minF && floors <= s.maxF);
  return ok.length ? ok[Math.floor(rng.next() * ok.length)].fn : null;
}
