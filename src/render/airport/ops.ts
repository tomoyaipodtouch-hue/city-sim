// 空港の運航：飛行機の動き（進入 → フレア → 接地 → 減速 → 誘導路 → 駐機スポット → 折り返し → プッシュバック → 誘導路 →
// 停止位置 → 滑走路へ → 離陸滑走 → 上昇 → マップの外へ）、便の出し方（人口・利用者、深夜は少ない）、風向きによる滑走路の向きの入れ替え、
// 駐機中の地上の車両（バス・給油車・荷物の車・トーイングカー）と歩いて乗り降りする人。
// three.js には触らない。位置はすべて空港の敷地の座標（a, c, 高さ）。毎フレームの計算で新しい配列やオブジェクトを作らない。
import type { AirportLayout } from '../../sim/airport';
import { AC, ALL_LIVERIES, AcType, CARGO_LIVERY, LIVERIES } from './aircraft';
import type { GseType } from './gse';

// ---- 道すじ（折れ線の角を円弧で丸めたもの） ----
export interface Path { a: Float32Array; c: Float32Array; s: Float32Array; len: number }
export function makePath(pts: [number, number][], radius = 0): Path {
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    let ux = ax - bx, uy = ay - by, vx = cx - bx, vy = cy - by;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (radius <= 0 || lu < 1e-6 || lv < 1e-6) { out.push(pts[i]); continue; }
    ux /= lu; uy /= lu; vx /= lv; vy /= lv;
    const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy));
    const ang = Math.acos(cos); // 角の内角
    if (ang > Math.PI - 1e-3) { out.push(pts[i]); continue; }
    const t = Math.min(radius / Math.tan(ang / 2), lu * 0.5, lv * 0.5);
    const r = t * Math.tan(ang / 2);
    const p0x = bx + ux * t, p0y = by + uy * t, p1x = bx + vx * t, p1y = by + vy * t;
    // 円弧の中心
    let bxx = ux + vx, byy = uy + vy;
    const lb = Math.hypot(bxx, byy);
    bxx /= lb; byy /= lb;
    const dc = r / Math.sin(ang / 2);
    const ox = bx + bxx * dc, oy = by + byy * dc;
    const a0 = Math.atan2(p0y - oy, p0x - ox);
    let a1 = Math.atan2(p1y - oy, p1x - ox);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    a1 = a0 + da;
    const k = Math.max(3, Math.ceil(Math.abs(da) / 0.12));
    for (let j = 0; j <= k; j++) {
      const a = a0 + (da * j) / k;
      out.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
    }
  }
  out.push(pts[pts.length - 1]);
  const n = out.length;
  const A = new Float32Array(n), Cc = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    A[i] = out[i][0]; Cc[i] = out[i][1];
    if (i) S[i] = S[i - 1] + Math.hypot(A[i] - A[i - 1], Cc[i] - Cc[i - 1]);
  }
  return { a: A, c: Cc, s: S, len: S[n - 1] };
}
// 道すじの上の位置と向き（単位ベクトル）。out = [a, c, ta, tc]
export function samplePath(p: Path, s: number, out: Float32Array) {
  const n = p.s.length;
  if (s <= 0) { out[0] = p.a[0]; out[1] = p.c[0]; seg(p, 0, out); return; }
  if (s >= p.len) { out[0] = p.a[n - 1]; out[1] = p.c[n - 1]; seg(p, n - 2, out); return; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.s[m] <= s) lo = m; else hi = m; }
  const t = (s - p.s[lo]) / Math.max(1e-6, p.s[hi] - p.s[lo]);
  out[0] = p.a[lo] + (p.a[hi] - p.a[lo]) * t;
  out[1] = p.c[lo] + (p.c[hi] - p.c[lo]) * t;
  seg(p, lo, out);
}
function seg(p: Path, i: number, out: Float32Array) {
  const da = p.a[i + 1] - p.a[i], dc = p.c[i + 1] - p.c[i], l = Math.hypot(da, dc) || 1;
  out[2] = da / l; out[3] = dc / l;
}

// ---- 速さの変化（台形：v0 から加速して vmax、減速して v1） ----
export interface Move { path: Path; v0: number; vm: number; v1: number; acc: number; dec: number; t1: number; t2: number; T: number; d1: number; d2: number; vp: number }
export function makeMove(path: Path, v0: number, vmax: number, v1: number, acc: number, dec: number): Move {
  const L = path.len;
  let vp = vmax;
  let d1 = Math.max(0, (vp * vp - v0 * v0) / (2 * acc)), d3 = Math.max(0, (vp * vp - v1 * v1) / (2 * dec));
  if (d1 + d3 > L) {
    vp = Math.sqrt(Math.max(0, (2 * acc * dec * L + dec * v0 * v0 + acc * v1 * v1) / (acc + dec)));
    vp = Math.max(vp, v0, v1, 0.5);
    d1 = Math.max(0, (vp * vp - v0 * v0) / (2 * acc));
    d3 = Math.max(0, (vp * vp - v1 * v1) / (2 * dec));
  }
  const d2 = Math.max(0, L - d1 - d3);
  const t1 = vp > v0 ? (vp - v0) / acc : 0, t2 = t1 + d2 / Math.max(0.1, vp), T = t2 + (vp > v1 ? (vp - v1) / dec : 0);
  return { path, v0, vm: vmax, v1, acc, dec, t1, t2, T, d1, d2, vp };
}
// 時刻 t の道のり
export function moveS(m: Move, t: number): number {
  if (t <= 0) return 0;
  if (t >= m.T) return m.path.len;
  if (t < m.t1) return m.v0 * t + 0.5 * m.acc * t * t;
  if (t < m.t2) return m.d1 + m.vp * (t - m.t1);
  const u = t - m.t2;
  return Math.min(m.path.len, m.d1 + m.d2 + m.vp * u - 0.5 * m.dec * u * u);
}
export function moveV(m: Move, t: number): number {
  if (t <= 0) return m.v0;
  if (t >= m.T) return m.v1;
  if (t < m.t1) return m.v0 + m.acc * t;
  if (t < m.t2) return m.vp;
  return Math.max(0, m.vp - m.dec * (t - m.t2));
}

// ---- 地上の車両の行き来（車庫 ⇔ 駐機スポットのそば） ----
export interface Trip { type: GseType; path: Path; t: number; drive: number; stay: number; carts: number; live: boolean; attach: number; oneWay: boolean; ac: Ac | null }

// ---- 飛行機 ----
export type Phase = 'approach' | 'rollout' | 'exit' | 'holdIn' | 'taxiIn' | 'park' | 'ready' | 'push' | 'pushed' | 'taxiOut' | 'holdOut' | 'lineup' | 'takeoff' | 'gone';
export interface Ac {
  type: AcType;
  livery: number; // ALL_LIVERIES の番号
  cargo: boolean;
  stand: number;
  dir: number; // 使っている滑走路の向き（+1 = a が増える向きへ離着陸）
  phase: Phase;
  move: Move | null;
  t: number; // 段階の中の時刻（秒）
  T: number; // 駐機の時間（秒）
  // 今の姿勢（敷地の座標）
  a: number; c: number; y: number; ha: number; hc: number; pitch: number;
  rev: boolean; // 後ろ向きに動いている（プッシュバック）
  lights: boolean; // 着陸灯をつけている
  moving: boolean;
}

const TD = 120; // 滑走路の端から接地点まで（m）
const V_APP = 64, V_TD = 60, V_EXIT = 11, V_TAXI = 9, V_ROT = 62;
const TAKEOFF_ACC = 3.0, CLIMB = 0.16;

// 1 つの空港の運航
export class AirOps {
  L: AirportLayout;
  dir = 1;
  aircraft: Ac[] = [];
  trips: Trip[] = [];
  // 入力（シミュレーションの数字）
  flights = 0;
  cargoFlights = 0;
  open = false;
  private spawnT = 10;
  private flipPending = false;
  private windT = 420;
  private groundBusy: Ac | null = null; // 誘導路を使っている飛行機（1 機ずつ）
  private standUsed: (Ac | null)[];
  private rnd: () => number;
  // 道すじ（向きごと、スポットごと）
  private P: { appr: Path; roll: Path[]; exit: Path[]; taxiIn: Path[][]; push: Path[][]; taxiOut: Path[][]; lineup: Path[]; take: Path; outLen: number; inLen: number }[] = [];
  private gsePaths: { fuel: Path[]; bags: Path[]; bus: Path[]; tug: Path[][] } | null = null;
  private walk: Path[] = [];
  onDirChange: ((dir: number) => void) | null = null;
  // 進入・上昇のマップの外までの長さ（m）。向き（-1, +1）ごと
  constructor(L: AirportLayout, out: { neg: number; pos: number }, seed: number) {
    this.L = L;
    let s = seed >>> 0 || 1;
    this.rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    this.standUsed = L.stands.map(() => null);
    this.build(out);
    this.dir = this.rnd() < 0.5 ? 1 : -1;
    this.windT = 300 + this.rnd() * 300;
  }

  private standC(k: number, type: AcType) {
    return this.L.stands[k].noseC - AC[type].len / 2;
  }

  private build(out: { neg: number; pos: number }) {
    const L = this.L, r = L.runways[0], tc = L.taxiC;
    for (const dir of [1, -1]) {
      const thr = dir > 0 ? r.a0 : r.a1;
      const far = dir > 0 ? r.links[1] : r.links[0];
      const start = dir > 0 ? r.links[0] : r.links[1];
      // 進入：マップの外（着陸する向きの反対側）から接地点まで
      const inLen = (dir > 0 ? out.neg : out.pos) + Math.abs(thr);
      const appr = makePath([[thr - dir * inLen, r.c], [thr + dir * TD, r.c]]);
      const roll: Path[] = [], exit: Path[] = [], taxiIn: Path[][] = [], push: Path[][] = [], taxiOut: Path[][] = [], lineup: Path[] = [];
      // 減速して取付誘導路の手前まで
      roll.push(makePath([[thr + dir * TD, r.c], [far - dir * 30, r.c]]));
      // 滑走路を出て、誘導路の手前で止まる
      exit.push(makePath([[far - dir * 30, r.c], [far, r.c], [far, tc - 13]], 22));
      for (const type of ['atr', 'a220', 'e190'] as AcType[]) {
        const ti: Path[] = [], pu: Path[] = [], to: Path[] = [];
        L.stands.forEach((st, k) => {
          const sc = this.standC(k, type);
          ti.push(makePath([[far, tc - 13], [far, tc], [st.a, tc], [st.a, sc]], 24));
          // プッシュバック：スポットから後ろ向きに誘導路まで（機首が出発する端を向く）。道すじは前向きに書いて、逆にたどる
          const away = Math.sign(st.a - start) || 1;
          const p0: [number, number] = [st.a + away * 32, tc];
          pu.push(makePath([p0, [st.a, tc], [st.a, sc]], 24));
          to.push(makePath([p0, [start, tc], [start, r.holdC]], 24));
        });
        taxiIn.push(ti); push.push(pu); taxiOut.push(to);
      }
      lineup.push(makePath([[start, r.holdC], [start, r.c], [start + dir * 40, r.c]], 18));
      const outLen = (dir > 0 ? out.pos : out.neg) + Math.abs(start) + 400;
      const take = makePath([[start + dir * 40, r.c], [start + dir * (40 + outLen), r.c]]);
      this.P.push({ appr, roll, exit, taxiIn, push, taxiOut, lineup, take, outLen, inLen });
    }
    // 地上の車両：車庫 → 構内道路 → スポットのそば
    const [da, dc] = L.depot, sv = L.serviceC;
    const toStand = (k: number, off: number, endC: number) => makePath([[da, dc], [da, sv], [L.stands[k].a + off, sv], [L.stands[k].a + off, endC]], 7);
    const fuel: Path[] = [], bags: Path[] = [], bus: Path[] = [], tug: Path[][] = [];
    L.stands.forEach((st, k) => {
      const typ: AcType = st.cargo ? 'atr' : 'a220';
      const cc = this.standC(k, typ), len = AC[typ].len;
      fuel.push(toStand(k, -10, cc + 2));
      bags.push(toStand(k, 6, cc - len * 0.22));
      bus.push(toStand(k, 15, cc + len * 0.18));
      // 人が歩く：ターミナルの出口から、前の左の扉（機首が +c のとき左は +a）
      this.walk.push(makePath([[st.a + 7, L.buildings[0].r.c0 + 0.5], [st.a + 7, sv], [st.a + AC[typ].R + 1.4, st.noseC - 4.5]]));
    });
    for (let q = 0; q < 2; q++) tug.push(L.stands.map((st) => makePath([[da, dc], [da, sv], [st.a, sv], [st.a, st.noseC + 4.5]], 7)));
    this.gsePaths = { fuel, bags, bus, tug };
  }

  private anyPhase(p1: Phase, p2: Phase) {
    for (let i = 0; i < this.aircraft.length; i++) { const ph = this.aircraft[i].phase; if (ph === p1 || ph === p2) return true; }
    return false;
  }
  private di(dir: number) {
    return dir > 0 ? 0 : 1;
  }

  // 便の多さ（0..1）
  busy() {
    const cap = this.L.spec.paxCap / this.L.spec.paxPerFlight;
    return Math.min(1, (this.flights + this.cargoFlights) / Math.max(1, cap));
  }

  // 最初に駐機している飛行機（街を開いたとき、空港が空っぽに見えないように）
  seed() {
    const k = this.open ? Math.round(1 + this.busy() * 1.4) : 1;
    for (let q = 0; q < Math.min(k, this.L.spec.maxAircraft - 1); q++) {
      const cargo = this.cargoFlights > 0 && q === 1;
      const st = this.freeStand(cargo);
      if (st < 0) break;
      const ac = this.newAc(cargo, st);
      ac.phase = 'park';
      ac.T = this.turnTime(cargo);
      ac.t = this.open ? this.rnd() * ac.T * 0.8 : 0;
      this.placeAtStand(ac);
      this.aircraft.push(ac);
      // 折り返しの途中から：地上の車両も途中から
      if (this.open) {
        const n0 = this.trips.length;
        this.serviceStart(ac);
        for (let k = n0; k < this.trips.length; k++) this.trips[k].t = ac.t;
      }
    }
  }

  private turnTime(cargo: boolean) {
    return (cargo ? 95 : 70) + this.rnd() * 30;
  }

  private freeStand(cargo: boolean) {
    const ks: number[] = [];
    this.L.stands.forEach((s, k) => { if (s.cargo === cargo && !this.standUsed[k]) ks.push(k); });
    return ks.length ? ks[Math.floor(this.rnd() * ks.length)] : -1;
  }

  private newAc(cargo: boolean, stand: number): Ac {
    const li = cargo ? ALL_LIVERIES.indexOf(CARGO_LIVERY) : Math.floor(this.rnd() * LIVERIES.length);
    const liv = ALL_LIVERIES[li];
    const type = liv.fleet[Math.floor(this.rnd() * liv.fleet.length)];
    this.standUsed[stand] = null;
    const ac: Ac = { type, livery: li, cargo, stand, dir: this.dir, phase: 'approach', move: null, t: 0, T: 0, a: 0, c: 0, y: 0, ha: 0, hc: 1, pitch: 0, rev: false, lights: false, moving: false };
    this.standUsed[stand] = ac;
    return ac;
  }

  private placeAtStand(ac: Ac) {
    const st = this.L.stands[ac.stand];
    ac.a = st.a; ac.c = this.standC(ac.stand, ac.type); ac.y = 0; ac.ha = 0; ac.hc = 1; ac.pitch = 0; ac.rev = false; ac.moving = false; ac.lights = false;
  }

  private typeIdx(t: AcType) {
    return t === 'atr' ? 0 : t === 'a220' ? 1 : 2;
  }

  // 滑走路が使われているか（着陸・離陸の飛行機）
  private runwayBusy(forArrival: boolean) {
    for (const ac of this.aircraft) {
      if (ac.phase === 'rollout' || ac.phase === 'exit' || ac.phase === 'lineup') return true;
      if (ac.phase === 'takeoff' && ac.y < 250) return true;
      if (ac.phase === 'approach') {
        if (forArrival) return true;
        // 接地まで 45 秒より近い着陸機がいれば、離陸を待つ
        if (ac.move && ac.move.T - ac.t < 45) return true;
      }
    }
    return false;
  }

  private nightFactor(tod: number) {
    // 深夜（0 時〜5 時半）は便が少ない
    const h = tod * 24;
    if (h < 5.5) return 0.2;
    if (h < 6.5) return 0.2 + 0.8 * (h - 5.5);
    if (h > 23) return 1 - 0.8 * (h - 23);
    return 1;
  }

  private startMove(ac: Ac, m: Move, phase: Phase) {
    ac.move = m;
    ac.t = 0;
    ac.phase = phase;
  }

  // dt 秒すすめる（tod = 1 日のうちの時刻 0..1）
  update(dt: number, tod: number) {
    if (dt <= 0) return;
    const sp = this.L.spec;
    // 風向きが変わる（滑走路を使う向きを入れかえる）：滑走路と誘導路を使う飛行機がいないとき
    // 入れかえの時刻が来たら、新しい着陸と出発を止めて、動いている飛行機がいなくなるのを待つ
    this.windT -= dt;
    this.flipPending = this.windT <= 0;
    if (this.flipPending) {
      let quiet = true;
      for (let i = 0; i < this.aircraft.length; i++) { const a = this.aircraft[i]; if (!(a.phase === 'park' || a.phase === 'ready' || (a.phase === 'takeoff' && a.y > 300))) quiet = false; }
      if (quiet) {
        this.dir = -this.dir;
        this.windT = 360 + this.rnd() * 420;
        this.flipPending = false;
        this.onDirChange?.(this.dir);
      }
    }
    // 新しい便（着陸）
    const rate = this.open ? this.flights + this.cargoFlights : 0;
    if (rate > 0 && !this.flipPending) {
      this.spawnT -= dt * this.nightFactor(tod);
      if (this.spawnT <= 0) {
        const cargo = this.cargoFlights > 0 && this.rnd() < this.cargoFlights / rate;
        const st = this.freeStand(cargo);
        const waiting = this.anyPhase('holdOut', 'holdOut');
        if (st >= 0 && this.aircraft.length < sp.maxAircraft && !this.runwayBusy(true) && !waiting) {
          const ac = this.newAc(cargo, st);
          ac.dir = this.dir;
          const P = this.P[this.di(ac.dir)];
          this.startMove(ac, makeMoveCached(P.appr, V_APP, V_APP, V_TD), 'approach');
          ac.lights = true;
          this.aircraft.push(ac);
          const b = this.busy();
          this.spawnT = (160 - 105 * b) * (0.7 + 0.6 * this.rnd());
        } else this.spawnT = 6;
      }
    }
    for (let i = 0; i < this.aircraft.length; i++) this.step(this.aircraft[i], dt);
    // いなくなった飛行機を外す（配列を作り直さない）
    let w = 0;
    for (let i = 0; i < this.aircraft.length; i++) if (this.aircraft[i].phase !== 'gone') this.aircraft[w++] = this.aircraft[i];
    this.aircraft.length = w;
    // 地上の車両
    for (let i = 0; i < this.trips.length; i++) {
      const tr = this.trips[i];
      if (!tr.live) continue;
      tr.t += dt;
      if (tr.attach < 0 && tr.t > (tr.oneWay ? tr.drive : tr.drive * 2 + tr.stay)) tr.live = false;
    }
  }

  private step(ac: Ac, dt: number) {
    ac.t += dt;
    const P = this.P[this.di(ac.dir)], ti = this.typeIdx(ac.type);
    const done = ac.move ? ac.t >= ac.move.T : false;
    switch (ac.phase) {
      case 'approach':
        if (done) this.startMove(ac, makeMoveCached(P.roll[0], V_TD, V_TD, V_EXIT, 1, ((V_TD * V_TD - V_EXIT * V_EXIT) / (2 * P.roll[0].len))), 'rollout');
        break;
      case 'rollout':
        if (done) this.startMove(ac, makeMoveCached(P.exit[0], V_EXIT, V_EXIT, 0, 1, 1.2), 'exit');
        break;
      case 'exit':
        if (done) { ac.phase = 'holdIn'; ac.t = 0; ac.lights = false; }
        break;
      case 'holdIn':
        if (!this.groundBusy) { this.groundBusy = ac; this.startMove(ac, makeMoveCached(P.taxiIn[ti][ac.stand], 2, V_TAXI, 0, 0.8, 0.7), 'taxiIn'); }
        break;
      case 'taxiIn':
        if (done) {
          if (this.groundBusy === ac) this.groundBusy = null;
          ac.phase = 'park'; ac.t = 0; ac.T = this.turnTime(ac.cargo); ac.move = null;
          this.serviceStart(ac);
        }
        break;
      case 'park':
        if (ac.t > ac.T - 14 && ac.t - dt <= ac.T - 14) this.tugIn(ac);
        if (ac.t >= ac.T) { ac.phase = 'ready'; ac.t = 0; }
        break;
      case 'ready':
        // 誘導路が空いていて、着陸機がこのあと誘導路に入ってこないとき
        if (!this.flipPending && !this.groundBusy && !this.anyPhase('exit', 'holdIn')) {
          // 駐機中に風向きが変わったら、新しい向きで出発する
          ac.dir = this.dir;
          this.groundBusy = ac;
          this.startMove(ac, makeMoveCached(this.P[this.di(ac.dir)].push[ti][ac.stand], 0, 1.4, 0, 0.3, 0.3), 'push');
          ac.rev = true;
          this.standUsed[ac.stand] = null;
        }
        break;
      case 'push':
        if (done) { ac.phase = 'pushed'; ac.t = 0; ac.rev = false; this.tugAway(ac); }
        break;
      case 'pushed':
        if (ac.t > 4) this.startMove(ac, makeMoveCached(P.taxiOut[ti][ac.stand], 0, V_TAXI, 0, 0.6, 0.7), 'taxiOut');
        break;
      case 'taxiOut':
        if (done) { if (this.groundBusy === ac) this.groundBusy = null; ac.phase = 'holdOut'; ac.t = 0; }
        break;
      case 'holdOut':
        if (ac.t > 3 && !this.runwayBusy(false)) { this.startMove(ac, makeMoveCached(P.lineup[0], 0, 6, 4, 0.6, 0.8), 'lineup'); ac.lights = true; }
        break;
      case 'lineup':
        if (done) this.startMove(ac, makeMoveCached(P.take, 4, 82, 82, TAKEOFF_ACC, 1), 'takeoff');
        break;
      case 'takeoff':
        if (done) ac.phase = 'gone';
        break;
    }
    this.pose(ac);
  }

  // 今の位置と姿勢
  private tmp = new Float32Array(4);
  private pose(ac: Ac) {
    const m = ac.move;
    if (ac.phase === 'park' || ac.phase === 'ready' || ac.phase === 'holdIn' || ac.phase === 'holdOut' || ac.phase === 'pushed' || !m) { ac.moving = false; if (ac.phase !== 'park' && ac.phase !== 'ready') return; this.placeAtStand(ac); return; }
    const t = Math.min(ac.t, m.T);
    const s = moveS(m, t);
    const o = this.tmp;
    samplePath(m.path, ac.rev ? m.path.len - s : s, o);
    ac.a = o[0]; ac.c = o[1];
    // 後ろ向きに進むとき（プッシュバック）は、道すじを逆にたどる。機首は道すじの前の向き
    ac.ha = o[2]; ac.hc = o[3];
    ac.moving = true;
    ac.y = 0;
    ac.pitch = 0;
    const tg = Math.tan((this.L.glide * Math.PI) / 180);
    if (ac.phase === 'approach') {
      // 進入角 5.5°（ロンドン・シティ空港のような急な進入）。接地の手前で引き起こす（フレア）
      const d = m.path.len - s;
      ac.y = tg * (d - 40 + 40 * Math.exp(-d / 40));
      ac.pitch = 0.035 + 0.06 * Math.exp(-d / 60);
    } else if (ac.phase === 'takeoff') {
      const v = moveV(m, t);
      const slo = (V_ROT * V_ROT - 16) / (2 * TAKEOFF_ACC);
      if (s > slo) {
        const x = s - slo, R = 1500, xs = CLIMB * R;
        ac.y = x < xs ? (x * x) / (2 * R) : (xs * xs) / (2 * R) + (x - xs) * CLIMB;
        ac.pitch = Math.min(0.17, 0.05 + x / 600);
      } else if (v > V_ROT - 6) ac.pitch = ((v - (V_ROT - 6)) / 6) * 0.08;
    } else if (ac.phase === 'rollout') {
      ac.pitch = Math.max(0, 0.02 - t * 0.01);
    }
  }

  // ---- 地上の車両 ----
  private trip(type: GseType, path: Path, stay: number, carts = 0, speed = 6): Trip {
    let tr = this.trips.find((q) => !q.live);
    if (!tr) { tr = { type, path, t: 0, drive: 0, stay: 0, carts: 0, live: false, attach: -1, oneWay: false, ac: null }; this.trips.push(tr); }
    tr.type = type; tr.path = path; tr.t = 0; tr.drive = path.len / speed; tr.stay = stay; tr.carts = carts; tr.live = true; tr.attach = -1; tr.oneWay = false; tr.ac = null;
    return tr;
  }
  private serviceStart(ac: Ac) {
    const g = this.gsePaths!, k = ac.stand;
    this.trip('fuel', g.fuel[k], ac.T * 0.5);
    this.trip('tractor', g.bags[k], ac.T - 34, 2, 5);
    if (!ac.cargo) this.trip('bus', g.bus[k], ac.T * 0.3, 0, 5.5);
  }
  private tugIn(ac: Ac) {
    const tr = this.trip('tug', this.gsePaths!.tug[this.di(this.dir)][ac.stand], 1e9, 0, 4);
    tr.attach = 1;
    tr.ac = ac;
  }
  private tugAway(ac: Ac) {
    const tr = this.trips.find((q) => q.live && q.ac === ac);
    if (!tr) return;
    tr.ac = null;
    // 押し終えたら、今いる所（機首の前）から車庫へ戻る（出発ごとに 1 回だけ道すじを作る）
    const L = AC[ac.type].len / 2 + 4.2, ta = ac.a + ac.ha * L, tcc = ac.c + ac.hc * L;
    const [da, dc] = this.L.depot, sv = this.L.serviceC;
    const back = makePath([[ta, tcc], [ta + ac.ha * 9, tcc + 12], [ta + ac.ha * 9, sv], [da, sv], [da, dc]], 8);
    tr.path = back; tr.t = 0; tr.drive = back.len / 5; tr.stay = 0; tr.attach = -1; tr.oneWay = true;
  }

  // 地上の車両と歩く人の姿勢を書き出す。emit(type, a, c, ha, hc)
  eachGse(time: number, emit: (t: GseType, a: number, c: number, ha: number, hc: number) => void) {
    const o = this.tmp;
    for (let i = 0; i < this.trips.length; i++) {
      const tr = this.trips[i];
      if (!tr.live) continue;
      // 押しているトーイングカー：飛行機の機首の前
      if (tr.attach >= 0) {
        const ac = tr.ac && tr.ac.phase !== 'gone' ? tr.ac : null;
        if (ac && (ac.phase === 'push' || ac.phase === 'ready' || (ac.phase === 'park' && tr.t >= tr.drive))) {
          const L = AC[ac.type].len / 2 + 4.2;
          emit('tug', ac.a + ac.ha * L, ac.c + ac.hc * L, -ac.ha, -ac.hc);
          continue;
        }
        if (!ac) { tr.live = false; continue; }
      }
      let s: number, rev = false;
      if (tr.oneWay) s = Math.min(1, tr.t / tr.drive) * tr.path.len;
      else if (tr.t < tr.drive) s = (tr.t / tr.drive) * tr.path.len;
      else if (tr.t < tr.drive + tr.stay) s = tr.path.len;
      else { s = tr.path.len - ((tr.t - tr.drive - tr.stay) / tr.drive) * tr.path.len; rev = true; }
      samplePath(tr.path, s, o);
      // 戻りも前向きに走る（向きを逆に）
      const ha = rev ? -o[2] : o[2], hc = rev ? -o[3] : o[3];
      emit(tr.type, o[0], o[1], ha, hc);
      for (let k = 1; k <= tr.carts; k++) {
        samplePath(tr.path, rev ? s + k * 3.7 : s - k * 3.7, o);
        emit('cart', o[0], o[1], rev ? -o[2] : o[2], rev ? -o[3] : o[3]);
      }
    }
    // 歩いて乗り降りする人：降りる（駐機の始め）、乗る（駐機の終わり）
    for (let i = 0; i < this.aircraft.length; i++) {
      const ac = this.aircraft[i];
      if (ac.phase !== 'park' || ac.cargo) continue;
      const p = this.walk[ac.stand];
      const t = ac.t, T = ac.T;
      const off = t < 30 ? 8 : T - 38, end = t < 30 ? 26 : T - 16;
      if (t < off || t > end) continue;
      const out = t < 30;
      for (let k = 0; k < 10; k++) {
        const u = (t - off) * 1.3 - k * 2.6;
        if (u < 0 || u > p.len) continue;
        samplePath(p, out ? p.len - u : u, o);
        // 列の中で少し横にずらす
        const side = ((k * 7) % 5 - 2) * 0.35;
        emit('pax', o[0] - o[3] * side, o[1] + o[2] * side, out ? -o[2] : o[2], out ? -o[3] : o[3]);
      }
    }
    void time;
  }
}

// 同じ道すじと速さの組み合わせは、作った Move を使い回す（離着陸のたびに作らない）
const moveCache = new WeakMap<Path, Map<string, Move>>();
function makeMoveCached(path: Path, v0: number, vmax: number, v1: number, acc = 1, dec = 1): Move {
  let m = moveCache.get(path);
  if (!m) moveCache.set(path, (m = new Map()));
  const key = `${v0},${vmax},${v1},${acc},${dec}`;
  let mv = m.get(key);
  if (!mv) m.set(key, (mv = makeMove(path, v0, vmax, v1, acc, dec)));
  return mv;
}
