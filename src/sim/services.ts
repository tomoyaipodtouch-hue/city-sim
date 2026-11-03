// 公共サービス（警察・消防・医療・教育・ゴミ）の計算
import { Grid } from './grid';
import { CIVIC, CivicId, DEPTS, Dept, DEPT_NAMES, GARBAGE_PER_JOB, GARBAGE_PER_RES, GROW, GrowKind, SERVICE_DEPT, ZoneType } from './defs';
import type { Building } from './world';

export interface ServiceState {
  funding: Record<Dept, number>; // 部門ごとの予算（%）
  lowMonths: Record<Dept, number>; // 予算が60%未満の月数
  strike: Record<Dept, number>; // ストライキの残りの月数
  eq: { child: number; adult: number; elderly: number }; // 年齢層ごとの教育水準（0..150）
  hq: number; // 健康度（0..100）
  garbage: { produced: number; handled: number; excess: number };
}

export function defaultServiceState(): ServiceState {
  const r = (v: number) => Object.fromEntries(DEPTS.map((d) => [d, v])) as Record<Dept, number>;
  return { funding: r(100), lowMonths: r(0), strike: r(0), eq: { child: 30, adult: 30, elderly: 25 }, hq: 50, garbage: { produced: 0, handled: 0, excess: 0 } };
}

export interface ServiceMaps {
  police: Uint8Array; // 警察の守る範囲（0..255）
  fire: Uint8Array; // 消防の守る範囲
  health: Uint8Array; // 医療の範囲
  edu: Uint8Array; // 教育施設（学校・図書館）の範囲
  crime: Uint8Array; // 犯罪（0..255）
  fireRisk: Uint8Array; // 火災の危険
}

export function makeServiceMaps(N: number): ServiceMaps {
  return { police: new Uint8Array(N), fire: new Uint8Array(N), health: new Uint8Array(N), edu: new Uint8Array(N), crime: new Uint8Array(N), fireRisk: new Uint8Array(N) };
}

// 部門の効き目（予算の多さとストライキ）
export function deptEffect(s: ServiceState, d: Dept) {
  if (s.strike[d] > 0) return 0;
  return Math.min(1.3, Math.pow(Math.max(0, s.funding[d]) / 100, 0.7));
}
// 施設の効き目（部門の予算 × 施設ごとの予算 × 電力）
export function facilityEffect(s: ServiceState, b: Building) {
  const def = CIVIC[b.type as CivicId];
  if (!def.service) return 1;
  const fund = b.fund ?? 100;
  return deptEffect(s, SERVICE_DEPT[def.service]) * Math.pow(fund / 100, 0.7) * (b.powered ? 1 : 0.3);
}

export interface ServiceResult {
  news: string[];
  pop: number;
  lifeExp: number;
  crimeAvg: number; // 住人が感じる犯罪（0..1）
  garbageLevel: number; // 処理しきれないゴミの割合（0..1）
}

export function updateServices(
  g: Grid, buildings: Iterable<Building>, s: ServiceState, m: ServiceMaps,
  ctx: { pollution: Uint8Array; landValue: Uint8Array; resDensity: Float32Array },
): ServiceResult {
  const n = g.n, N = n * n;
  const news: string[] = [];
  // ストライキ
  for (const d of DEPTS) {
    if (s.strike[d] > 0) {
      s.strike[d]--;
      if (!s.strike[d]) news.push(`${DEPT_NAMES[d]}のストライキが終わりました。`);
      continue;
    }
    s.lowMonths[d] = s.funding[d] < 60 ? s.lowMonths[d] + 1 : 0;
    if (s.lowMonths[d] >= 6) {
      s.strike[d] = 3;
      s.lowMonths[d] = 0;
      news.push(`${DEPT_NAMES[d]}の職員がストライキを始めました。予算を増やしましょう。`);
    }
  }
  // 範囲の地図
  const cover = (arr: Float32Array, b: Building, r: number, eff: number) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(n - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(n - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r) continue;
        const v = eff * (1 - 0.6 * (d / r));
        const i = y * n + x;
        if (v > arr[i]) arr[i] = v;
      }
  };
  const police = new Float32Array(N), fire = new Float32Array(N), health = new Float32Array(N), lib = new Float32Array(N), school = new Float32Array(N);
  let pop = 0, jobs = 0, healthCap = 0, seatsE = 0, seatsH = 0, seatsC = 0, recycle = 0, dispose = 0;
  const homes: Building[] = [];
  const all = [...buildings];
  for (const b of all) {
    if (b.civic) continue;
    if (b.state !== 1) continue;
    if (GROW[b.type as GrowKind].zone === ZoneType.R) {
      pop += b.occ;
      homes.push(b);
    } else jobs += b.occ;
  }
  for (const b of all) {
    if (!b.civic) continue;
    const def = CIVIC[b.type as CivicId];
    if (!def.service) continue;
    const eff = facilityEffect(s, b);
    const r = def.radius ?? 0;
    switch (def.service) {
      case 'police': cover(police, b, r, eff); break;
      case 'fire': cover(fire, b, r, eff); break;
      case 'health': cover(health, b, r, eff); healthCap += (def.capacity ?? 0) * eff; break;
      case 'school': cover(school, b, r, eff); seatsE += (def.capacity ?? 0) * eff; break;
      case 'high': cover(school, b, r, eff); seatsH += (def.capacity ?? 0) * eff; break;
      case 'college': seatsC += (def.capacity ?? 0) * eff; break;
      case 'library': cover(lib, b, r, eff); break;
      case 'landfill':
      case 'incinerator': dispose += (def.capacity ?? 0) * eff; break;
      case 'recycling': recycle += (def.capacity ?? 0) * eff; break;
    }
  }
  // 医療：範囲内の住人に対して、受け入れ人数が足りているか
  let covered = 0;
  for (const b of homes) if (health[g.idx(b.x, b.y)] > 0) covered += b.occ;
  const healthRatio = covered > 0 ? Math.min(1, healthCap / covered) : 0;
  for (let i = 0; i < N; i++) health[i] *= healthRatio;

  // 犯罪と火災の危険。犯罪は人口が増えるほど起きやすい（小さな町ではあまり起きない）
  const crimeScale = Math.max(0.25, Math.min(1, pop / 6000));
  for (let i = 0; i < N; i++) {
    const bid = g.bldg[i];
    const dense = Math.min(1, ctx.resDensity[i] / 60);
    const lv = ctx.landValue[i] / 255;
    let crimeBase = 0, fireBase = 0;
    if (bid || g.zone[i]) {
      crimeBase = (0.08 + 0.4 * dense + 0.3 * (1 - lv)) * crimeScale;
      fireBase = 0.2 + 0.4 * dense + (g.zone[i] === ZoneType.I ? 0.4 : 0);
    }
    m.crime[i] = Math.round(Math.max(0, crimeBase * (1 - 0.85 * Math.min(1, police[i]))) * 255);
    m.fireRisk[i] = Math.round(Math.max(0, fireBase * (1 - 0.9 * Math.min(1, fire[i]))) * 255);
    m.police[i] = Math.round(Math.min(1, police[i]) * 255);
    m.fire[i] = Math.round(Math.min(1, fire[i]) * 255);
    m.health[i] = Math.round(Math.min(1, health[i]) * 255);
    m.edu[i] = Math.round(Math.min(1, Math.max(school[i], lib[i])) * 255);
  }
  // 健康度（医療の範囲と大気汚染）
  let hqSum = 0, libSum = 0, crimeSum = 0;
  for (const b of homes) {
    const i = g.idx(b.x, b.y);
    hqSum += b.occ * Math.max(0, 0.35 + 0.65 * (m.health[i] / 255) - 0.5 * Math.min(1, ctx.pollution[i] / 140));
    libSum += b.occ * (lib[i] > 0 ? Math.min(1, lib[i]) : 0);
    crimeSum += b.occ * (m.crime[i] / 255);
  }
  const hqTarget = pop > 0 ? (hqSum / pop) * 100 : 50;
  s.hq += (hqTarget - s.hq) / 6;
  // 教育水準（子ども → 大人 → 高齢者）
  const children = pop * 0.22, adults = pop * 0.6;
  const elem = children > 0 ? Math.min(1, seatsE / children) : 0;
  const high = children > 0 ? Math.min(1, seatsH / (children * 0.45)) : 0;
  const libr = pop > 0 ? libSum / pop : 0;
  const coll = adults > 0 ? Math.min(1, seatsC / (adults * 0.08)) : 0;
  const childTarget = 20 + 55 * elem + 45 * high + 10 * libr;
  s.eq.child += (childTarget - s.eq.child) / 18;
  const adultTarget = s.eq.child * 0.85 + 35 * coll + 10 * libr;
  s.eq.adult += (adultTarget - s.eq.adult) / 60;
  s.eq.elderly += (s.eq.adult - s.eq.elderly) / 120;
  // ゴミ
  const produced = pop * GARBAGE_PER_RES + jobs * GARBAGE_PER_JOB;
  const afterRecycle = Math.max(0, produced - recycle);
  const excess = Math.max(0, afterRecycle - dispose);
  const prevExcess = s.garbage.excess;
  s.garbage = { produced: Math.round(produced), handled: Math.round(Math.min(afterRecycle, dispose) + Math.min(produced, recycle)), excess: Math.round(excess) };
  if (excess > 50 && prevExcess <= 50) news.push('ゴミが処理しきれず、街が汚れています。埋立地や焼却場を作りましょう。');
  return {
    news,
    pop,
    lifeExp: 58 + 0.28 * s.hq,
    crimeAvg: pop > 0 ? crimeSum / pop : 0,
    // 小さな町ではゴミの問題は目立たない（ゴミの量が月 3,000 を超えると本格的になる）
    garbageLevel: produced > 0 ? Math.min(1, excess / produced) * Math.min(1, produced / 3000) : 0,
  };
}
