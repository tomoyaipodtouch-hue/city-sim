// 都市経営：条例、借入（債券）、市長評価、アドバイザー、記念施設
import type { FuneralState } from './population';

// ---------------- 条例 ----------------
export type OrdinanceId =
  | 'smoking' | 'watch' | 'curfew' | 'gambling' | 'power' | 'water' | 'recycle' | 'cleanAir'
  | 'emission' | 'carpool' | 'tourism' | 'industry' | 'smoke' | 'clinic';

export interface OrdinanceDef {
  id: OrdinanceId;
  name: string;
  desc: string;
  costPerPop: number; // 人口1人あたりの月の費用（マイナスは収入）
  minPop: number; // 施行できる人口
}

export const ORDINANCES: OrdinanceDef[] = [
  { id: 'smoking', name: '禁煙条例', desc: '健康度が上がる。商業の需要が少し下がる', costPerPop: 0.004, minPop: 500 },
  { id: 'watch', name: '地域見回りの支援', desc: '犯罪が10%減る', costPerPop: 0.006, minPop: 1000 },
  { id: 'curfew', name: '青少年の夜間外出制限', desc: '犯罪が8%減る。住宅の魅力が少し下がる', costPerPop: 0.003, minPop: 2000 },
  { id: 'gambling', name: 'カジノの合法化', desc: '収入が入る。犯罪が15%増え、市長評価が下がる', costPerPop: -0.04, minPop: 3000 },
  { id: 'power', name: '省エネの推進', desc: '電力の使用量が15%減る', costPerPop: 0.004, minPop: 500 },
  { id: 'water', name: '節水の推進', desc: '水の使用量が15%減る', costPerPop: 0.003, minPop: 500 },
  { id: 'recycle', name: '分別収集', desc: 'ゴミが15%減る', costPerPop: 0.005, minPop: 1000 },
  { id: 'cleanAir', name: '大気汚染防止法', desc: '工業の大気汚染が25%減る。汚染型工業の需要が下がる', costPerPop: 0.005, minPop: 2000 },
  { id: 'emission', name: '自動車の排出ガス規制', desc: '道路の大気汚染が30%減る', costPerPop: 0.004, minPop: 2000 },
  { id: 'carpool', name: '相乗りの推進', desc: '道路の交通量が8%減る', costPerPop: 0.003, minPop: 3000 },
  { id: 'tourism', name: '観光の宣伝', desc: '商業の需要が上がる', costPerPop: 0.006, minPop: 2000 },
  { id: 'industry', name: '工業の誘致', desc: '工業の需要が上がる。市長評価が少し下がる', costPerPop: 0.006, minPop: 1000 },
  { id: 'smoke', name: '火災報知器の設置義務', desc: '火災の危険が15%減る', costPerPop: 0.003, minPop: 1000 },
  { id: 'clinic', name: '無料の健康診断', desc: '健康度が上がる', costPerPop: 0.007, minPop: 3000 },
];

export const ordinanceCost = (id: OrdinanceId, pop: number) => {
  const d = ORDINANCES.find((o) => o.id === id)!;
  return Math.round(d.costPerPop * Math.max(pop, 500) * 10) / 10;
};

// 条例の効き目（係数）。world の各計算が参照する
export interface OrdinanceEffects {
  crime: number; // 犯罪の倍率
  fire: number;
  hqBonus: number; // 健康度に足す
  power: number; // 電力の使用量の倍率
  water: number;
  garbage: number;
  indPollution: number;
  roadPollution: number;
  traffic: number; // 交通量の倍率
  demand: { R: number; C: number; I: number; ID: number }; // 需要に足す
  rating: number; // 市長評価に足す
  rDesire: number; // 住宅の魅力に足す
}

export function ordinanceEffects(on: Set<OrdinanceId>): OrdinanceEffects {
  const e: OrdinanceEffects = {
    crime: 1, fire: 1, hqBonus: 0, power: 1, water: 1, garbage: 1, indPollution: 1, roadPollution: 1, traffic: 1,
    demand: { R: 0, C: 0, I: 0, ID: 0 }, rating: 0, rDesire: 0,
  };
  if (on.has('smoking')) { e.hqBonus += 5; e.demand.C -= 0.03; }
  if (on.has('watch')) e.crime *= 0.9;
  if (on.has('curfew')) { e.crime *= 0.92; e.rDesire -= 0.02; }
  if (on.has('gambling')) { e.crime *= 1.15; e.rating -= 4; }
  if (on.has('power')) e.power *= 0.85;
  if (on.has('water')) e.water *= 0.85;
  if (on.has('recycle')) e.garbage *= 0.85;
  if (on.has('cleanAir')) { e.indPollution *= 0.75; e.demand.ID -= 0.1; }
  if (on.has('emission')) e.roadPollution *= 0.7;
  if (on.has('carpool')) e.traffic *= 0.92;
  if (on.has('tourism')) e.demand.C += 0.08;
  if (on.has('industry')) { e.demand.I += 0.08; e.rating -= 2; }
  if (on.has('smoke')) e.fire *= 0.85;
  if (on.has('clinic')) e.hqBonus += 6;
  // 住人に喜ばれる条例は評価が少し上がる
  for (const id of ['smoking', 'watch', 'smoke', 'clinic', 'recycle', 'cleanAir'] as const) if (on.has(id)) e.rating += 1;
  return e;
}

// ---------------- 借入（債券） ----------------
export interface Loan {
  id: number;
  principal: number; // 借りた額
  rate: number; // 年利（%）
  remaining: number; // 残りの元金
  months: number; // 残りの月数
  payment: number; // 毎月の返済額
}
export const LOAN_AMOUNTS = [25000, 50000, 100000];
export const LOAN_MONTHS = 120;
export const MAX_LOANS = 5;

// 金利：資金と収支がよいほど低い（4〜9%）
export function loanRate(funds: number, net: number, loans: number) {
  let r = 5;
  if (funds < 0) r += 2;
  if (net < 0) r += 1;
  r += loans * 0.5;
  return Math.min(9, Math.max(4, r));
}

export function newLoan(id: number, amount: number, rate: number): Loan {
  const i = rate / 100 / 12;
  const payment = (amount * i) / (1 - Math.pow(1 + i, -LOAN_MONTHS));
  return { id, principal: amount, rate, remaining: amount, months: LOAN_MONTHS, payment: Math.round(payment * 100) / 100 };
}

// 1か月分を返済する。返済額を返す
export function payLoan(l: Loan): number {
  const interest = l.remaining * (l.rate / 100 / 12);
  const pay = Math.min(l.payment, l.remaining + interest);
  l.remaining = Math.max(0, l.remaining + interest - pay);
  l.months--;
  return pay;
}

// ---------------- 市長評価 ----------------
export interface RatingInput {
  pop: number;
  avgTax: number;
  crime: number; // 0..1
  pollution: number; // 住人が感じる大気汚染（0..1）
  commute: number; // 分
  unemployment: number; // 0..1
  garbage: number; // 0..1
  powerShort: boolean;
  waterShort: boolean;
  health: number; // 0..100
  eq: number; // 0..150
  funds: number;
  ordinanceBonus: number;
  rewards: number; // 建てた記念施設の数
  funeral?: number; // 斎場・霊園の足りない度合い（0..1）
}

export interface RatingResult {
  value: number;
  parts: [string, number][]; // 理由と、評価への影響
}

export function computeRating(r: RatingInput): RatingResult {
  const parts: [string, number][] = [];
  const add = (name: string, v: number) => {
    if (Math.abs(v) >= 0.5) parts.push([name, Math.round(v)]);
    return v;
  };
  let v = 60;
  v += add('税率', (9 - r.avgTax) * 2.5);
  v += add('犯罪', -r.crime * 20);
  v += add('大気汚染', -r.pollution * 20);
  v += add('通勤時間', -Math.max(0, r.commute - 20) * 0.6);
  v += add('失業', -r.unemployment * 25);
  v += add('ゴミ', -r.garbage * 12);
  v += add('斎場・霊園', -(r.funeral ?? 0) * 10);
  if (r.powerShort) v += add('電力不足', -12);
  if (r.waterShort) v += add('水不足', -10);
  v += add('医療', (r.health - 50) * 0.15);
  v += add('教育', (r.eq - 60) * 0.08);
  if (r.funds < 0) v += add('財政難', -6);
  v += add('条例', r.ordinanceBonus);
  v += add('記念施設', r.rewards * 2);
  return { value: Math.max(0, Math.min(100, v)), parts };
}

// ---------------- 記念施設 ----------------
export interface RewardReq {
  pop: number;
  rating: number;
  eq?: number;
}
export const REWARD_REQ: Record<string, RewardReq & { label: string }> = {
  mayor_house: { pop: 2000, rating: 55, label: '人口 2,000人・市長評価 55以上' },
  city_hall: { pop: 10000, rating: 50, label: '人口 10,000人・市長評価 50以上' },
  statue: { pop: 5000, rating: 70, label: '人口 5,000人・市長評価 70以上' },
  museum: { pop: 8000, rating: 55, eq: 90, label: '人口 8,000人・市長評価 55以上・大人の教育水準 90以上' },
  stadium: { pop: 30000, rating: 60, label: '人口 30,000人・市長評価 60以上' },
  future_stadium: { pop: 30000, rating: 60, label: '人口 30,000人・市長評価 60以上' },
};

export function rewardUnlocked(id: string, pop: number, rating: number, eq: number) {
  const r = REWARD_REQ[id];
  if (!r) return true;
  return pop >= r.pop && rating >= r.rating && (r.eq === undefined || eq >= r.eq);
}

// ---------------- アドバイザー ----------------
export type AdvisorId = 'finance' | 'planning' | 'traffic' | 'safety' | 'health' | 'utility';
export const ADVISORS: Record<AdvisorId, string> = {
  finance: '財政', planning: '都市計画', traffic: '交通', safety: '安全', health: '健康・教育', utility: '環境・インフラ',
};

export interface Advice {
  advisor: AdvisorId;
  level: 0 | 1 | 2; // 0 = よい, 1 = 注意, 2 = 問題
  text: string;
}

export interface AdviceInput {
  pop: number;
  funds: number;
  net: number;
  avgTax: number;
  loans: number;
  demandR: number;
  demandC: number;
  demandI: number;
  freeZones: { R: number; C: number; I: number };
  commute: number;
  congested: number; // 渋滞している道路マスの割合（0..1）
  transitShare: number;
  crime: number;
  fireRisk: number;
  policeCover: number; // 住人のうち警察の範囲内の割合
  fireCover: number;
  healthCover: number;
  hq: number;
  eqChild: number;
  eqAdult: number;
  schoolSeats: number; // 子どもの数に対する席の割合
  powerShort: boolean;
  waterShort: boolean;
  powerMargin: number; // 発電量の余裕（0..）
  waterMargin: number;
  garbage: number;
  pollution: number;
  funeral?: FuneralState;
  elderly?: number; // 高齢者の割合
  strikes: string[];
  rating: number;
  sandbox?: boolean;
}

export function makeAdvice(a: AdviceInput): Advice[] {
  const out: Advice[] = [];
  const say = (advisor: AdvisorId, level: 0 | 1 | 2, text: string) => out.push({ advisor, level, text });
  // 財政（サンドボックスでは出さない）
  if (a.sandbox) { /* お金は無限 */ }
  else if (a.funds < 0) say('finance', 2, '資金がマイナスです。税率を少し上げるか、部門の予算を見直しましょう。借入も一つの手です。');
  else if (a.net < 0) say('finance', 1, `毎月 §${Math.round(-a.net).toLocaleString()} の赤字です。このままだと資金が減り続けます。`);
  else say('finance', 0, `収支は黒字です（毎月 +§${Math.round(a.net).toLocaleString()}）。`);
  if (a.avgTax > 11) say('finance', 1, '税率が高めです。市長評価と需要が下がっています。');
  if (a.loans >= 3) say('finance', 1, '借入が多くなっています。返済で毎月の支出が増えます。');
  // 都市計画
  for (const [k, name, d, free] of [['R', '住宅', a.demandR, a.freeZones.R], ['C', '商業', a.demandC, a.freeZones.C], ['I', '工業', a.demandI, a.freeZones.I]] as const) {
    void k;
    if (d > 0.5 && free < 10) say('planning', 1, `${name}の需要が高いのに、空いている${name}ゾーンがほとんどありません。ゾーンを増やしましょう。`);
    else if (d < -0.5 && free > 60) say('planning', 1, `${name}の需要が低く、${name}ゾーンが余っています。`);
  }
  if (!out.some((o) => o.advisor === 'planning')) say('planning', 0, '需要とゾーンのバランスはよい状態です。');
  // 交通
  if (a.commute > 40) say('traffic', 2, `平均通勤時間が ${a.commute.toFixed(0)} 分と長くなっています。道路を増やすか、公共交通を整えましょう。`);
  else if (a.congested > 0.1) say('traffic', 1, '渋滞している道路が増えています。「データ表示」の「交通量」で確かめましょう。');
  else say('traffic', 0, `交通は順調です（平均通勤時間 ${a.commute.toFixed(0)} 分）。`);
  if (a.pop > 8000 && a.transitShare < 0.05) say('traffic', 1, '公共交通がほとんど使われていません。駅やバス停を増やすと渋滞が減ります。');
  // 安全
  if (a.pop > 1000 && a.policeCover < 0.5) say('safety', a.crime > 0.3 ? 2 : 1, '警察の守る範囲が足りません。交番や警察署を置きましょう。');
  if (a.pop > 1000 && a.fireCover < 0.5) say('safety', 1, '消防の守る範囲が足りません。消防署を置きましょう。');
  if (!out.some((o) => o.advisor === 'safety')) say('safety', 0, '治安と防災は保たれています。');
  // 健康・教育
  if (a.pop > 1500 && a.healthCover < 0.5) say('health', 1, '医療の範囲が足りません。診療所や病院を置きましょう。');
  if (a.pop > 1500 && a.schoolSeats < 0.7) say('health', 1, '学校の席が足りません。教育水準が上がらず、ハイテク産業やオフィスが来にくくなります。');
  if (a.eqAdult > 90) say('health', 0, `大人の教育水準が高く（${Math.round(a.eqAdult)}）、ハイテク産業が来やすい街です。`);
  const f = a.funeral;
  if (f && a.pop > 3000) {
    if (f.capacity <= 0 && f.deaths > 0.5) say('health', f.shortage > 0.3 ? 2 : 1, `毎月 ${Math.round(f.deaths)} 人ほどが亡くなっていますが、斎場がありません。斎場を作りましょう。`);
    else if (f.waiting > Math.max(3, f.capacity * 0.3)) say('health', 2, `斎場が足りず、${Math.round(f.waiting)} 人が火葬を待っています。斎場を増やしましょう。`);
    if (f.graves <= 0 && f.cremated > 0.5) say('health', 1, '霊園がありません。納骨の場所が足りなくなります。');
    else if (f.graves > 0 && f.graveFree < Math.max(30, f.deaths * 12)) say('health', f.ashes > 3 ? 2 : 1, `霊園の空きが残りわずかです（${Math.round(f.graveFree)} 区画）。新しい霊園を作りましょう。`);
  }
  if (a.elderly !== undefined && a.pop > 3000 && a.elderly > 0.3) say('health', 1, `高齢化が進んでいます（高齢者 ${Math.round(a.elderly * 100)}%）。働く人が減り、税収が下がります。病院も多く必要です。`);
  if (!out.some((o) => o.advisor === 'health')) say('health', 0, `健康度 ${Math.round(a.hq)}、子どもの教育水準 ${Math.round(a.eqChild)} です。`);
  // 環境・インフラ
  if (a.powerShort) say('utility', 2, '電力が足りません。発電所を増やしましょう。');
  else if (a.powerMargin < 0.15 && a.pop > 500) say('utility', 1, '発電量の余裕が少なくなっています。');
  if (a.waterShort) say('utility', 2, '水が足りません。揚水ポンプや給水塔を増やしましょう。');
  else if (a.waterMargin < 0.15 && a.pop > 500) say('utility', 1, '給水量の余裕が少なくなっています。');
  if (a.garbage > 0.1) say('utility', 2, 'ゴミが処理しきれていません。埋立地や焼却場を作りましょう。');
  if (a.pollution > 0.35) say('utility', 1, '大気汚染がひどくなっています。汚染型工業や石炭火力発電所の場所を見直しましょう。');
  if (!out.some((o) => o.advisor === 'utility')) say('utility', 0, '電力・水道・ゴミ処理は足りています。');
  for (const s of a.strikes) say('finance', 2, `${s}の職員がストライキ中です。予算を60%以上に戻しましょう。`);
  return out;
}
