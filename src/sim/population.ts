// 年齢層（子ども・働く世代・高齢者）と、出生・死亡・葬送（斎場と霊園）
// 一人ひとりは計算せず、住宅の建物ごとに年齢層の割合だけを持つ（軽い計算）。
// 人の数そのものは住宅の入居（引っ越し）で決まり、出生・死亡・年を取ることは割合を少しずつ動かす
import { CIVIC, CivicId, GROW, GrowKind, ZoneType } from './defs';
import type { Building } from './world';

export type Ages = [number, number, number]; // [子ども 0〜17, 働く世代 18〜64, 高齢者 65〜]
// 引っ越してくる世帯（若い家族が多い）
export const MOVER_AGES: Ages = [0.24, 0.66, 0.1];
// 割合を持っていない建物（前のセーブデータ）
export const DEFAULT_AGES: Ages = [0.2, 0.62, 0.18];
// 働く世代のうち、通勤して働く人の割合（今までの「住人の半分が通勤」と同じになるように）
export const WORK_RATE = 0.5 / DEFAULT_AGES[1];
// 月あたりの割合
const GROW_UP = 1 / (18 * 12); // 子ども → 働く世代
const RETIRE = 1 / (47 * 12); // 働く世代 → 高齢者
const BIRTH = 0.022 / 12; // 働く世代 1 人あたりの出生
const TURNOVER = 0.002; // 毎月の入れかわり（出ていく人と、引っ越してくる若い世帯）
// 霊園に納める割合（ほかは寺の墓や、ほかの街の墓へ）
export const GRAVE_SHARE = 0.8;

export interface FuneralState {
  deaths: number; // この月に亡くなった人
  births: number; // この月に生まれた人
  waiting: number; // 火葬を待っている人
  ashes: number; // 霊園に空きがなく、納骨を待っている人
  cremated: number; // この月に火葬した人
  capacity: number; // 斎場の受け入れ（月）
  graves: number; // 霊園の区画（全部）
  graveFree: number; // 霊園の空き区画
  shortage: number; // 葬送が足りない度合い（0..1）
  ages: Ages; // 街全体の年齢層の割合
}

export function defaultFuneral(): FuneralState {
  return { deaths: 0, births: 0, waiting: 0, ashes: 0, cremated: 0, capacity: 0, graves: 0, graveFree: 0, shortage: 0, ages: [...DEFAULT_AGES] };
}

export const agesOf = (b: Building): Ages => b.ages ?? DEFAULT_AGES;
// 通勤して働く人の数
export const workersOf = (b: Building) => b.occ * agesOf(b)[1] * WORK_RATE;
// 住宅の税：働く世代がいちばん多く納め、高齢者（年金）と子どもは少し
export function taxFactor(b: Building) {
  const [c, w, e] = agesOf(b);
  const [c0, w0, e0] = DEFAULT_AGES;
  return (1.3 * w + 0.45 * e + 0.1 * c) / (1.3 * w0 + 0.45 * e0 + 0.1 * c0);
}

// 1 か月ぶん、住宅の年齢層を進める。hq = 健康度（0..100）。亡くなった人と生まれた人を返す
export function stepAges(b: Building, hq: number): { deaths: number; births: number } {
  const occ = b.occ;
  let [c, w, e] = b.ages ?? (b.occ > 0 ? MOVER_AGES : DEFAULT_AGES);
  const prev = b.aOcc ?? 0;
  // 増えた分は、引っ越してきた若い世帯
  if (occ > prev && occ > 0) {
    const k = (occ - prev) / occ;
    c += (MOVER_AGES[0] - c) * k; w += (MOVER_AGES[1] - w) * k; e += (MOVER_AGES[2] - e) * k;
  }
  b.aOcc = occ;
  if (occ <= 0) { b.ages = [c, w, e]; return { deaths: 0, births: 0 }; }
  // 入れかわり
  c += (MOVER_AGES[0] - c) * TURNOVER; w += (MOVER_AGES[1] - w) * TURNOVER; e += (MOVER_AGES[2] - e) * TURNOVER;
  // 死亡（健康度が高いほど長生き）
  const mE = (0.06 * (1.6 - Math.min(100, Math.max(0, hq)) / 100)) / 12, mW = 0.002 / 12, mC = 0.0005 / 12;
  const dead = c * mC + w * mW + e * mE;
  const born = w * BIRTH;
  const up = c * GROW_UP, ret = w * RETIRE;
  c += born - up - c * mC;
  w += up - ret - w * mW;
  e += ret - e * mE;
  const s = c + w + e || 1;
  b.ages = [c / s, w / s, e / s];
  return { deaths: dead * occ, births: born * occ };
}

// 1 か月ぶんの年齢層・出生・死亡・葬送。eff = 施設の効き目
export function updatePopulation(all: Iterable<Building>, f: FuneralState, hq: number, eff: (b: Building) => number, pop: number) {
  let deaths = 0, births = 0, cap = 0, graves = 0;
  let sc = 0, sw = 0, se = 0, n = 0;
  const cems: Building[] = [];
  for (const b of all) {
    if (b.civic) {
      const def = CIVIC[b.type as CivicId];
      if (def.service === 'crematorium') cap += (def.capacity ?? 0) * eff(b);
      else if (def.service === 'cemetery') { cems.push(b); graves += def.capacity ?? 0; }
      continue;
    }
    if (b.state !== 1 || GROW[b.type as GrowKind].zone !== ZoneType.R) continue;
    const r = stepAges(b, hq);
    deaths += r.deaths;
    births += r.births;
    const a = agesOf(b);
    sc += b.occ * a[0]; sw += b.occ * a[1]; se += b.occ * a[2]; n += b.occ;
  }
  // 火葬：待っている人から順に
  f.waiting += deaths;
  const cremated = Math.min(f.waiting, cap);
  f.waiting -= cremated;
  // 長く待たせると、家族が隣の街の斎場を探す（待ちは少しずつ減る）
  f.waiting *= 0.9;
  // 霊園へ納骨（空きのある霊園から）
  let toGrave = cremated * GRAVE_SHARE + f.ashes;
  f.ashes = 0;
  let free = 0;
  for (const b of cems) {
    const cp = CIVIC[b.type as CivicId].capacity ?? 0;
    const k = Math.min(toGrave, Math.max(0, cp - b.occ));
    b.occ += k;
    toGrave -= k;
    free += Math.max(0, cp - b.occ);
  }
  // 霊園に空きがない人は、納骨を待つ（家族がほかの墓を探すので、少しずつ減る）
  f.ashes = toGrave * 0.92;
  // 足りない度合い：待っている人が、ふだんの月の死亡のどれくらいか。小さな町では目立たない
  const backlog = f.waiting + f.ashes;
  const need = Math.max(4, deaths * 2);
  f.shortage = Math.min(1, backlog / need) * Math.min(1, Math.max(0, (pop - 2500) / 7500));
  f.deaths = deaths;
  f.births = births;
  f.cremated = cremated;
  f.capacity = cap;
  f.graves = graves;
  f.graveFree = free;
  if (n > 0) f.ages = [sc / n, sw / n, se / n];
  return { children: sc, workers: sw, elderly: se };
}
