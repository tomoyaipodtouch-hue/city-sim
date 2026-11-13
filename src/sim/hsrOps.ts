// 高速鉄道の列車の運行（画面の列車の動き）。three.js を使わないので、テストからも動かせる。
//
// 路線（hsrRoutes）ごとに、決まった本数の列車が走る。乗客が多いほど本数と両数が多い（8〜12 両）。
//   ・ターミナル駅（路線の端の駅）：着いた列車は止まり、向きを変えて折り返す
//   ・中間駅：各駅に止まる列車（副本線のホームに入る）と、止まらずに本線を通過する列車がある
//   ・マップの端：列車は隣の都市へ出ていき、隣の都市から入ってくる
// 右側通行：進む向き（道のり s が増える向き +1）の右側の線路を走る。駅に止まる列車はホームのある外側の線路（HSR_PLAT）へ移る。
import { Grid } from './grid';
import { CELL } from './constants';
import { HSR_PLAT, HSR_STN_LEN, HSR_TRACK, hsrPoly, hsrRoutes, HsrPoly, stnCell, type HsrStn } from './hsr';

export const HSR_CAR_L = 25; // 1 両の長さ（m）
export const HSR_CAR_GAP = 0.6;
export const HSR_VMAX = 72; // 最高の速さ（m/s、約 260 km/h。画面の上の速さ）
export const HSR_ACC = 1.6; // 加速（m/s²）
export const HSR_DEC = 2.4; // 減速
export const HSR_DWELL = 30; // 駅に止まる時間（秒）
export const HSR_TURN_DWELL = 45; // 折り返しの時間
export const HSR_SHIFT = 110; // 本線と副本線のあいだを移る長さ（m）
const GAP = 140; // 前の列車との間隔（m）
const OFF = 120; // マップの端の外へ出てから消えるまで（m）

export interface OpsStop { id: number; s0: number; s1: number; term: boolean } // 道のり s0..s1 が駅（ホームの範囲）
export interface OpsRoute { poly: HsrPoly; stops: OpsStop[]; endA: 'edge' | 'end'; endB: 'edge' | 'end'; loop: boolean; riders: number }
export interface OpsTrain {
  id: number;
  route: number;
  s: number; // 先頭の道のり
  dir: 1 | -1;
  v: number;
  cars: number;
  express: boolean; // 中間駅を通過する
  dwell: number; // 止まっている残りの秒数（0 = 走っている）
  next: number; // 次に止まる駅（stops の番号、-1 = なし）
  last: number; // 最後に止まった駅
  platN: number; // 次の駅で入るホームの側（+1 / -1）
  platL: number; // 最後の駅のホームの側
  turned: boolean; // 終点で折り返す
  gone: boolean;
}

export const trainLen = (cars: number) => cars * HSR_CAR_L + (cars - 1) * HSR_CAR_GAP;
// 乗客の数から、1 本の両数
export const hsrCars = (riders: number) => (riders < 1500 ? 8 : riders < 5000 ? 10 : 12);
// 路線の長さと乗客の数から、走らせる列車の数（両方向の合計）
export function hsrTrainCount(len: number, riders: number) {
  const base = Math.max(2, Math.ceil(len / 1400));
  return Math.min(14, Math.max(2, Math.round(base * (1 + Math.min(1.5, riders / 2500)))));
}
// 向き：はじめに並べるときは k で交互、あとから出すときは出した数で交互
const initialDir = (_k: number, q: number) => (q % 2 === 0 ? 1 : -1);
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class HsrOps {
  routes: OpsRoute[] = [];
  trains: OpsTrain[] = [];
  private nextId = 1;
  private seq = new Map<string, number>(); // 路線ごとに出した列車の数（向きと、通過する列車かを交互に決める）
  private rnd = 0x2545f491;
  private random() {
    this.rnd ^= this.rnd << 13; this.rnd ^= this.rnd >>> 17; this.rnd ^= this.rnd << 5;
    return ((this.rnd >>> 0) % 10000) / 10000;
  }

  // 線路と駅から路線を作り直す。riders = 高速鉄道の乗客（マスごと。なければ少なめ）。
  // 前と同じ路線（同じマスの並び）の列車は、そのまま走らせる
  build(g: Grid, stations: { id: number; x: number; y: number; hsr?: HsrStn }[], riders?: Float32Array) {
    const pin = new Map<number, number>();
    const stnOf = new Map<number, number>(); // ホームのマス → 駅の id
    for (const b of stations) {
      if (!b.hsr) continue;
      for (let a = 0; a < HSR_STN_LEN; a++) {
        const c = stnCell(g, b.x, b.y, b.hsr.axis, a, b.hsr.row);
        pin.set(c, b.hsr.deck);
        stnOf.set(c, b.id);
      }
    }
    const old = new Map(this.routes.map((r, i) => [r.poly.cells.join(','), i]));
    const routes: OpsRoute[] = [];
    for (const R of hsrRoutes(g)) {
      const poly = hsrPoly(g, R.cells, pin, -1, -1, R.loop);
      // 駅：路線の上の、同じ駅のホームのマスのまとまり
      const stops: OpsStop[] = [];
      for (let k = 0; k < R.cells.length; k++) {
        const id = stnOf.get(R.cells[k]);
        if (id === undefined) continue;
        const last = stops[stops.length - 1];
        const s = poly.cellS[k];
        if (last && last.id === id) { last.s0 = Math.min(last.s0, s - CELL / 2); last.s1 = Math.max(last.s1, s + CELL / 2); }
        else stops.push({ id, s0: s - CELL / 2, s1: s + CELL / 2, term: false });
      }
      // 路線の端にかかる駅はターミナル駅
      for (const st of stops) st.term = !R.loop && ((st.s0 <= CELL && R.endA === 'end') || (st.s1 >= poly.len - CELL && R.endB === 'end'));
      let rd = 0;
      if (riders) for (const c of R.cells) rd = Math.max(rd, riders[c] ?? 0);
      routes.push({ poly, stops, endA: R.endA, endB: R.endB, loop: R.loop, riders: rd });
    }
    // 列車を引き継ぐ（路線の番号を付け直す）。なくなった路線の列車は消す
    const remap = new Map<number, number>();
    routes.forEach((r, i) => { const o = old.get(r.poly.cells.join(',')); if (o !== undefined) remap.set(o, i); });
    this.trains = this.trains.filter((t) => remap.has(t.route));
    for (const t of this.trains) t.route = remap.get(t.route)!;
    this.routes = routes;
    for (const t of this.trains) { t.cars = hsrCars(routes[t.route].riders); this.retarget(t); }
    this.fill(true);
  }

  // 路線ごとの列車の数を合わせる（足りなければ出す）
  private fill(initial = false) {
    this.routes.forEach((r, ri) => {
      if (r.poly.len < 200) return;
      const want = hsrTrainCount(r.poly.len, r.riders);
      let have = 0;
      for (const t of this.trains) if (t.route === ri && !t.gone) have++;
      for (let k = have; k < want; k++) {
        const t = this.spawn(ri, k, initial ? (k + 0.5) / want : -1);
        if (t) this.trains.push(t);
        else break;
      }
    });
    this.trains = this.trains.filter((t) => !t.gone);
  }

  // 列車を出す。at = 路線の上の場所の割合（はじめに並べるとき）。-1 = 端から
  private spawn(ri: number, k: number, at: number): OpsTrain | null {
    const r = this.routes[ri], P = r.poly;
    const cars = hsrCars(r.riders);
    const L = trainLen(cars);
    const key = r.poly.cells.join(',');
    const q = this.seq.get(key) ?? 0;
    const dir: 1 | -1 = (initialDir(k, q)) > 0 ? 1 : -1;
    const express = r.stops.some((s) => !s.term) && (q >> 1) % 2 === 1;
    const t: OpsTrain = { id: this.nextId++, route: ri, s: 0, dir, v: 0, cars, express, dwell: 0, next: -1, last: -1, platN: dir, platL: dir, turned: false, gone: false };
    if (at >= 0) {
      t.s = Math.max(L, Math.min(P.len - 1, P.len * at));
      t.v = HSR_VMAX * 0.6;
    } else {
      const startEnd = dir > 0 ? r.endA : r.endB;
      if (startEnd === 'edge' || r.loop) t.s = dir > 0 ? -OFF : P.len + OFF;
      else {
        // ターミナル駅から出る
        const st = dir > 0 ? r.stops[0] : r.stops[r.stops.length - 1];
        if (!st || !st.term) t.s = dir > 0 ? L : P.len - L;
        else {
          t.s = dir > 0 ? Math.min(st.s1 - 12, st.s0 + L + 8) : Math.max(st.s0 + 12, st.s1 - L - 8);
          t.last = dir > 0 ? 0 : r.stops.length - 1;
          t.platL = dir;
        }
        t.dwell = HSR_TURN_DWELL * (0.3 + 0.7 * this.random());
      }
      t.v = t.dwell > 0 ? 0 : HSR_VMAX * 0.7;
      // 出す場所の近くに同じ向きの列車がいれば、あとで
      for (const o of this.trains) if (o.route === ri && o.dir === dir && Math.abs(o.s - t.s) < L + GAP * 2) return null;
    }
    this.seq.set(key, q + 1);
    this.retarget(t);
    return t;
  }

  // 次に止まる駅を決める
  private retarget(t: OpsTrain) {
    const r = this.routes[t.route];
    t.next = -1;
    const order = t.dir > 0 ? r.stops.map((_, i) => i) : r.stops.map((_, i) => r.stops.length - 1 - i);
    for (const i of order) {
      const st = r.stops[i];
      if (i === t.last) continue;
      if (t.express && !st.term) continue;
      const stopAt = this.stopPoint(t, st);
      if ((stopAt - t.s) * t.dir > -1) { t.next = i; break; }
    }
    t.platN = t.dir;
  }

  // 駅で止まる先頭の位置：ターミナル駅は車止めの手前、中間駅は列車の真ん中をホームの真ん中に
  stopPoint(t: OpsTrain, st: OpsStop) {
    const L = trainLen(t.cars);
    if (st.term) {
      const P = this.routes[t.route].poly;
      return t.dir > 0 ? Math.min(st.s1, P.len + CELL / 2) - 14 : Math.max(st.s0, -CELL / 2) + 14;
    }
    return (st.s0 + st.s1) / 2 + (t.dir * L) / 2;
  }

  // 道のり s での、列車 t の線路の横の位置（m、右が +。進む向きは道のりが増える向き）
  laneOffset(t: OpsTrain, s: number) {
    const r = this.routes[t.route];
    const base = t.dir * HSR_TRACK;
    let o = base;
    for (const [i, side] of [[t.next, t.platN], [t.last, t.platL]] as const) {
      if (i < 0) continue;
      const st = r.stops[i];
      const w = stationWeight(st, s);
      if (w > 0) o = o + (side * HSR_PLAT - o) * w;
    }
    return o;
  }

  step(dt: number) {
    if (dt <= 0) return;
    // 同じ路線・同じ向きの列車を、進む順に並べて、前の列車に近づきすぎないようにする
    const byRoute = new Map<number, OpsTrain[]>();
    for (const t of this.trains) {
      const k = t.route * 2 + (t.dir > 0 ? 0 : 1);
      (byRoute.get(k) ?? byRoute.set(k, []).get(k)!).push(t);
    }
    for (const list of byRoute.values()) list.sort((a, b) => (b.s - a.s) * b.dir);
    for (const list of byRoute.values()) {
      for (let k = 0; k < list.length; k++) {
        const t = list[k];
        const r = this.routes[t.route], P = r.poly;
        if (t.dwell > 0) {
          t.dwell -= dt;
          if (t.dwell <= 0) this.depart(t);
          continue;
        }
        // 止まる所までの距離
        let limit = Infinity;
        if (t.next >= 0) limit = (this.stopPoint(t, r.stops[t.next]) - t.s) * t.dir;
        // 前の列車（通過する列車は、駅のホームに止まっている列車を追い越せる）
        for (let j = k - 1; j >= 0; j--) {
          const o = list[j];
          if (t.express && o.dwell > 0 && o.last >= 0 && !r.stops[o.last].term) continue;
          if (o.dir !== t.dir) continue;
          const gap = (o.s - t.s) * t.dir - trainLen(o.cars) - GAP;
          limit = Math.min(limit, gap);
          break;
        }
        // 減速して止まれる速さ
        const vStop = limit === Infinity ? HSR_VMAX : Math.sqrt(Math.max(0, 2 * HSR_DEC * Math.max(0, limit)));
        const vt = Math.min(HSR_VMAX, vStop);
        t.v = t.v < vt ? Math.min(vt, t.v + HSR_ACC * dt) : Math.max(vt, t.v - HSR_DEC * 1.5 * dt);
        let adv = t.v * dt;
        if (limit !== Infinity) adv = Math.min(adv, Math.max(0, limit));
        t.s += adv * t.dir;
        // 駅に着いた
        if (t.next >= 0 && limit - adv < 0.5 && t.v < 3) {
          const st = r.stops[t.next];
          if (Math.abs(this.stopPoint(t, st) - t.s) < 1) {
            t.v = 0;
            t.last = t.next;
            t.platL = t.platN;
            t.turned = st.term;
            t.dwell = st.term ? HSR_TURN_DWELL : HSR_DWELL;
            t.next = -1;
          }
        }
        // マップの端から出ていった
        if (t.s < -OFF - trainLen(t.cars) || t.s > P.len + OFF + trainLen(t.cars)) {
          if (r.loop) t.s = t.dir > 0 ? t.s - P.len : t.s + P.len;
          else t.gone = true;
        }
      }
    }
    // 出ていった列車の代わりを出す（出す場所がふさがっていれば、少しあとで）
    this.refill -= dt;
    if (this.refill <= 0 || this.trains.some((t) => t.gone)) { this.refill = 4; this.fill(); }
  }
  private refill = 4;

  // 駅を出る。ターミナル駅では向きを変える（先頭は今までの最後尾）
  private depart(t: OpsTrain) {
    t.dwell = 0;
    if (t.turned) {
      t.s = t.s - t.dir * trainLen(t.cars);
      t.dir = t.dir > 0 ? -1 : 1;
      t.turned = false;
    }
    this.retarget(t);
  }
}

// 駅のホームの範囲で 1、前後 HSR_SHIFT で 0 になる重み（副本線へ移る所）。線路の形（hsrLayer）と列車で同じ
export function stationWeight(st: { s0: number; s1: number }, s: number) {
  if (s >= st.s0 && s <= st.s1) return 1;
  const d = s < st.s0 ? st.s0 - s : s - st.s1;
  return 1 - smooth(d / HSR_SHIFT);
}
