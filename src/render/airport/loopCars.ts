// 陸側の U 字のループを走る車（自家用車・タクシー・リムジンバス）。正門から入り、出発（高架）か到着（地上）の車寄せに止まって
// 人を降ろし・乗せ、奥の U ターンを回って正門へ戻る。正門の外は街の車（carLayer）が走る。
// 道すじは敷地の座標の折れ線 + 高さ。車の姿勢は（a, c, 高さ, 向き）で書き出し、地上の車両と同じインスタンスで描く
import { landLoop, landToLot, loopRoute, lotToLand, type AirportLayout, type LoopKind } from '../../sim/airport';
import { makePath, samplePath, type Path } from './ops';
import type { GseType } from './gse';
import { Rng } from '../../sim/rng';

interface Route { path: Path; sv: number[]; y: number[]; stop: number; kind: LoopKind }
interface LCar { r: Route; s: number; v: number; wait: number; type: GseType; dwell: number; slot: string }

const V_MAX = 9, ACC = 1.6, DEC = 2.2, MAX_CARS = 22;

export class LoopCars {
  private routes = new Map<string, Route>();
  private cars: LCar[] = [];
  private spawnT = 1;
  private rng: Rng;
  private used = new Set<string>();
  private slots: Record<'curbArr' | 'curbDep' | 'busArr' | 'busDep' | 'taxiArr' | 'taxiDep', number[]>;
  private tmp = new Float32Array(4);
  constructor(private L: AirportLayout, private gate: [number, number, number], seed: number) {
    this.rng = new Rng(seed ^ 0x5a5a);
    const P = landLoop(L, gate[2] > 2), V = L.viaduct;
    const span = (a0: number, a1: number, step: number) => { const o: number[] = []; for (let a = a0; a <= a1; a += step) o.push(Math.round(a)); return o; };
    const islA0 = P.aUg + 40, islA1 = V.a1, dA0 = V.a0 - 30, dA1 = V.a1 - 10;
    this.slots = {
      curbArr: span(P.aUg + 75, V.a1 - 35, 16), curbDep: span(V.a0 + 45, V.a1 - 45, 16),
      busArr: [0, 1, 2].map((k) => islA0 + 19.5 + k * 20), busDep: [0, 1, 2].map((k) => dA0 + 19.5 + k * 20),
      taxiArr: span((islA0 + islA1) / 2 + 4, islA1 - 12, 13), taxiDep: span((dA0 + dA1) / 2 + 4, dA1 - 12, 13),
    };
  }
  // 正門のマスの中心（敷地の座標）
  static gateLand(L: AirportLayout, a: number, c: number, h: number): [number, number, number] {
    const [la, lc] = lotToLand(L, a, c);
    return [la, lc, h];
  }
  private route(kind: LoopKind, stopA: number): Route {
    const key = `${kind}.${stopA}`;
    let r = this.routes.get(key);
    if (r) return r;
    const R = loopRoute(this.L, kind, stopA, this.gate);
    const pts = R.pts.map((p) => landToLot(this.L, p[0], p[1]));
    const path = makePath(pts, 6);
    const sv = pts.map((p) => near(path, p[0], p[1]));
    let stop = -1;
    if (R.stop !== null) {
      // 止まる位置：車寄せの車線の上の、stopA に近いところ
      const k = R.pts.findIndex((p, i) => i > 0 && Math.abs(p[1] - R.pts[i - 1][1]) < 0.01 && p[0] < R.pts[i - 1][0] && R.pts[i - 1][0] >= stopA - 25 && p[0] <= stopA + 25);
      stop = k > 0 ? (sv[k - 1] + sv[k]) / 2 : -1;
    }
    r = { path, sv, y: R.pts.map((p) => p[2]), stop, kind };
    this.routes.set(key, r);
    return r;
  }
  private yAt(r: Route, s: number) {
    let k = 0;
    while (k + 2 < r.sv.length && s > r.sv[k + 1]) k++;
    const u = Math.max(0, Math.min(1, (s - r.sv[k]) / Math.max(1e-3, r.sv[k + 1] - r.sv[k])));
    return r.y[k] + (r.y[k + 1] - r.y[k]) * u * u * (3 - 2 * u);
  }
  private spawn() {
    const x = this.rng.next();
    const dep = this.rng.next() < 0.55;
    let kind: LoopKind, type: GseType, slotKey: keyof LoopCars['slots'] | null, dwell: number;
    if (x < 0.62) { kind = dep ? 'depCar' : 'arrCar'; type = this.rng.next() < 0.5 ? 'car' : 'car2'; slotKey = dep ? 'curbDep' : 'curbArr'; dwell = dep ? 14 : 24; }
    else if (x < 0.82) { kind = dep ? 'depTaxi' : 'arrTaxi'; type = 'taxi'; slotKey = dep ? 'taxiDep' : 'taxiArr'; dwell = dep ? 12 : 20; }
    else if (x < 0.9) { kind = dep ? 'depBus' : 'arrBus'; type = 'coach'; slotKey = dep ? 'busDep' : 'busArr'; dwell = 30; }
    else { kind = this.rng.next() < 0.5 ? 'park' : 'unpark'; type = this.rng.next() < 0.5 ? 'car' : 'car2'; slotKey = null; dwell = 0; }
    let stopA = 0, slot = '';
    if (slotKey) {
      const free = this.slots[slotKey].filter((a) => !this.used.has(`${slotKey}.${a}`));
      if (!free.length) return;
      stopA = free[Math.floor(this.rng.next() * free.length)];
      slot = `${slotKey}.${stopA}`;
      this.used.add(slot);
    }
    // 入口が詰まっていなければ
    const r = this.route(kind, stopA);
    if (this.cars.some((c) => c.r.path === r.path ? c.s < 14 : c.s < 10 && c.r.kind !== 'unpark' && kind !== 'unpark')) { if (slot) this.used.delete(slot); return; }
    this.cars.push({ r, s: 0, v: kind === 'unpark' ? 0 : 6, wait: 0, type, dwell, slot });
  }
  // rate = 1 分あたりの台数のめやす
  update(dt: number, rate: number) {
    if (rate <= 0 && !this.cars.length) return;
    this.spawnT -= dt;
    if (this.spawnT <= 0 && rate > 0) {
      if (this.cars.length < MAX_CARS) this.spawn();
      this.spawnT = (60 / rate) * (0.5 + this.rng.next());
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i], r = c.r;
      if (c.wait > 0) {
        c.wait -= dt;
        if (c.wait <= 0 && c.slot) { this.used.delete(c.slot); c.slot = ''; }
        continue;
      }
      // 前の車（同じ道すじ）との間隔
      let lead = Infinity;
      for (const o of this.cars) if (o !== c && o.r.path === r.path && o.s > c.s) lead = Math.min(lead, o.s - c.s);
      let vt = V_MAX;
      if (r.stop > c.s && c.slot) vt = Math.min(vt, Math.sqrt(2 * DEC * Math.max(0, r.stop - c.s)));
      if (lead < 40) vt = Math.min(vt, Math.max(0, (lead - 9) * 0.6));
      c.v = c.v < vt ? Math.min(vt, c.v + ACC * dt) : Math.max(vt, c.v - DEC * 1.5 * dt);
      c.s += c.v * dt;
      if (c.slot && r.stop > 0 && c.s >= r.stop - 0.3) { c.s = r.stop; c.v = 0; c.wait = c.dwell; }
      if (c.s >= r.path.len) { if (c.slot) this.used.delete(c.slot); this.cars.splice(i, 1); }
    }
  }
  each(emit: (type: GseType, a: number, c: number, ha: number, hc: number, y: number) => void) {
    const o = this.tmp;
    for (const c of this.cars) {
      samplePath(c.r.path, c.s, o);
      emit(c.type, o[0], o[1], o[2], o[3], this.yAt(c.r, c.s));
    }
  }
  get count() { return this.cars.length; }
}

function near(p: Path, a: number, c: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < p.s.length; i++) { const d = (p.a[i] - a) ** 2 + (p.c[i] - c) ** 2; if (d < bd) { bd = d; best = p.s[i]; } }
  return best;
}
