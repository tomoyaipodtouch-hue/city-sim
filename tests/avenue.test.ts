// 大通り（RoadType.Avenue）を引くときの決まりを、テストとして書いたもの。
// プレイヤーと同じように World.exec の road コマンドで引き、道路の流れ（flow）でつながり方を見る。
//
// ■ 今の実装で通らないテスト
//   KNOWN_BROKEN に名前を入れて it.fails にしてある。直したら名前を消す（消し忘れると it.fails が失敗して知らせる）。
//   AVENUE_STRICT=1 npx vitest run tests/avenue.test.ts とすると、全部ふつうのテストとして走り、失敗の理由と地図が見える。
//
// ■ 中心線の決まり（このテストの前提）
// ・大通りの road コマンドの (x0, y0) → (x1, y1) は、指でなぞった線 = 大通りの中心線（中央分離帯）。
// ・座標は格子点（マスの角）。格子点 (x, y) は、マス (x, y) の北西（左上）の角。
//   画面では、大通りのときだけ、指の位置をいちばん近い格子点に丸める（Math.round(ワールド座標 / CELL)）。
//   こうすると、大通りの中心が指の下（半マス以内）に来る。
// ・東西の線（y が一定）：線の北側のマス（行 y-1）が西向き、南側のマス（行 y）が東向き。
// ・南北の線（x が一定）：線の西側のマス（列 x-1）が南向き、東側のマス（列 x）が北向き。
//   どちらもドラッグの向きによらない。右側通行：進む向きの右側の車線を走る。
//   マスで言いかえると「なぞったマスと、その北（東西の線）か西（南北の線）の隣のマス」。
// ・大通りは、2つの格子点のちょうど間にある（(8,24) → (40,24) なら、マス x = 8..39）。
//   テストは、端から1マス内側までと、端の先に飛び出したマスがないことだけを見る。
// ・斜めの部分の置き方は決めない。テストは、大通りのマスの中心が線から1マス（折れ線は1.25マス）以内にあること、
//   2本の車線（行きと帰り）が両方あること、つながっていることだけを見る。
// ・1回のドラッグの折れ線は planLine と同じ（直線の方が長ければ直線→斜め、斜めの方が長ければ斜め→直線）。
// ・ふつうの道路（大通り以外）の座標は、今までどおりマス。
//
// ■ つなぐときの決まり（指が少しずれても正しくつなぐ）
// ・続き：始点か終点が、ほかの大通りの端の格子点から2マス以内なら、その格子点にそろえる（逆向きに引いても同じ）。
// ・L字：2回目の始点が、1本目の端の格子点から1マス以内なら、その格子点から曲がる。角は交差点にしない。
// ・T字：突き当てる線の端が、相手の大通りの上か、2マス手前までなら、相手の中心線まで延ばして（縮めて）つなぐ。
//   相手の向こう側に飛び出さない。相手の2本の車線は、交差点を通り抜けて続く。
// ・道路の端から引く・道路の端で止める：道路と大通りの両方の車線がつながる。道路そのものは変えない。
// ・道路の上をなぞる：その道路が大通りの車線の1本になる（3本目の車線を作らない）。交わる道もそのままつながる。
// ・交差点（T字、十字）では、どの腕から入っても、ほかのどの腕へも、交差点のまわり（±7マス）だけで行ける
//   （行き止まりの端で折り返さないと行けないのはだめ）。
// ・橋：2本の車線は1枚の床版。同じ場所から同じ場所まで、同じ高さ。ふつうの道路を架けられる場所には架けられる。
// ・大通りの交差点には、ロータリー（Ctl.Roundabout）を設定できない。古い保存データのロータリーは信号として扱う。
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { RoadType } from '../src/sim/defs';
import { Ctl } from '../src/sim/grid';
import { DX, DY, dirOf, opp } from '../src/sim/constants';
import { buildJunctions } from '../src/sim/traffic';
import { planRoadCmd } from '../src/sim/plan';

type P = [number, number];
type Line = [number, number, number, number]; // 格子点 (x0, y0) → (x1, y1)
type Box = [number, number, number, number]; // マス x0..x1, y0..y1（両端を含む）

const AV = RoadType.Avenue, RD = RoadType.Road, ST = RoadType.Street;
const E = 0, S = 2, SW = 3, W = 4, N = 6, NE = 7;
const NAME = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

// 今の実装で通らないテスト（直ったら消す）
const KNOWN_BROKEN = new Set<string>([]);

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const STRICT = env.AVENUE_STRICT === '1';
const declared = new Set<string>();
function spec(name: string, fn: () => void) {
  declared.add(name);
  (KNOWN_BROKEN.has(name) && !STRICT ? it.fails : it)(name, fn);
}

// ---------------- 街と道路 ----------------
function flat(n = 48, h = 6) {
  const w = new World(n);
  w.g.heights.fill(h);
  w.funds = 1e9;
  return w;
}
function draw(w: World, [x0, y0, x1, y1]: Line, road: RoadType = AV) {
  const r = w.exec({ t: 'road', x0, y0, x1, y1, road });
  expect(r.ok, `road ${road} (${x0},${y0})→(${x1},${y1}): ${r.msg}`).toBe(true);
}

const bit = (m: number, d: number) => (m & (1 << d)) !== 0;
const degree = (m: number) => {
  let k = 0;
  for (let d = 0; d < 8; d++) if (bit(m, d)) k++;
  return k;
};
const at = (w: World, c: number) => `(${c % w.g.n},${(c / w.g.n) | 0})`;
const cells = (w: World, cs: number[]) => cs.slice(0, 8).map((c) => at(w, c)).join(' ') + (cs.length > 8 ? ' …' : '');

// 地図（失敗したときに見る）。A = 大通り、R = 道路、S = 細い道、矢印 = 進める向き、= = 橋
const ARW = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
function dump(w: World, [x0, y0, x1, y1]: Box) {
  const g = w.g;
  const rows = ['     ' + Array.from({ length: x1 - x0 + 1 }, (_, k) => String(x0 + k).padStart(5)).join('')];
  for (let y = y0; y <= y1; y++) {
    let s = String(y).padStart(4) + ' ';
    for (let x = x0; x <= x1; x++) {
      if (!g.inb(x, y)) { s += '     '; continue; }
      const i = g.idx(x, y), t = g.road[i];
      let c = g.isWater(x, y) ? '~' : '.';
      if (t) {
        let a = '';
        for (let d = 0; d < 8; d++) if (bit(g.flow[i], d)) a += ARW[d];
        c = (t === AV ? 'A' : t === RD ? 'R' : t === ST ? 'S' : String(t)) + (g.deck[i] > 0 ? '=' : '') + a;
      }
      s += c.slice(0, 5).padStart(5);
    }
    rows.push(s);
  }
  return rows.join('\n');
}
function clean(w: World, issues: string[], box: Box) {
  expect(issues, issues.length ? '\n' + issues.join('\n') + '\n' + dump(w, box) + '\n' : '').toEqual([]);
}

// ---------------- 道路の流れ ----------------
// 地上の道路を、進める向き（flow）でたどる。back = 逆向きにたどる（そこへ来られるマス）
function reach(w: World, from: number, keep: (x: number, y: number) => boolean = () => true, back = false) {
  const g = w.g, n = g.n;
  const seen = new Set([from]);
  const st = [from];
  while (st.length) {
    const c = st.pop()!;
    const x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      const jx = x + DX[d], jy = y + DY[d];
      if (!g.inb(jx, jy) || !keep(jx, jy)) continue;
      const j = jy * n + jx;
      if (!g.road[j] || seen.has(j)) continue;
      if (back ? bit(g.flow[j], opp(d)) : bit(g.flow[c], d)) {
        seen.add(j);
        st.push(j);
      }
    }
  }
  return seen;
}

// どのマスからも、どのマスへも行けるか（道路網が強連結か）
function connected(w: World): string[] {
  const g = w.g;
  const all: number[] = [];
  for (let i = 0; i < g.road.length; i++) if (g.road[i]) all.push(i);
  if (!all.length) return ['no roads'];
  const f = reach(w, all[0]), b = reach(w, all[0], undefined, true);
  const u = all.filter((c) => !f.has(c)), v = all.filter((c) => !b.has(c));
  const out: string[] = [];
  if (u.length) out.push(`${u.length} cells cannot be reached from ${at(w, all[0])}: ${cells(w, u)}`);
  if (v.length) out.push(`${v.length} cells cannot get back to ${at(w, all[0])}: ${cells(w, v)}`);
  return out;
}

// 交差点（3方向以上につながるマス）。skip の中は数えない
function junctions(w: World, skip?: Box): string[] {
  const g = w.g, n = g.n;
  const bad: number[] = [];
  for (let i = 0; i < g.road.length; i++) {
    if (!g.road[i] || degree(g.conn[i]) < 3) continue;
    const x = i % n, y = (i / n) | 0;
    if (skip && x >= skip[0] && x <= skip[2] && y >= skip[1] && y <= skip[3]) continue;
    bad.push(i);
  }
  return bad.length ? [`unexpected junction cells: ${cells(w, bad)}`] : [];
}

// 大通りの車線は一方通行：逆向きの流れを両方持つマスがない
function twoWay(w: World): string[] {
  const g = w.g;
  const bad: number[] = [];
  for (let i = 0; i < g.road.length; i++) {
    if (g.road[i] !== AV || degree(g.conn[i]) >= 3) continue;
    for (let d = 0; d < 4; d++) if (bit(g.flow[i], d) && bit(g.flow[i], d + 4)) { bad.push(i); break; }
  }
  return bad.length ? [`avenue cells used by both directions: ${cells(w, bad)}`] : [];
}

// 点 (x, y) のまわり（±3 マス）で、向き d へ進める道路のいちばん近いマス（大通りなら、その向きの車線）
function laneAt(w: World, x: number, y: number, d: number): number {
  const g = w.g;
  let best = -1, bs = Infinity;
  for (let oy = -3; oy <= 3; oy++)
    for (let ox = -3; ox <= 3; ox++) {
      const cx = x + ox, cy = y + oy;
      if (!g.inb(cx, cy)) continue;
      const c = g.idx(cx, cy);
      if (!g.road[c] || !bit(g.flow[c], d)) continue;
      const s = Math.hypot(ox, oy) + (bit(g.flow[c], opp(d)) ? 0.5 : 0);
      if (s < bs) { bs = s; best = c; }
    }
  return best;
}

// 交差点の動き：格子点 c のまわり（±box マス）だけを使って、どの腕から入っても、ほかのどの腕へも出られるか。
// 腕 a = 中心から向き a へ延びる道。入る車線は向き opp(a) へ、出る車線は向き a へ流れる（腕の d マス先で調べる）
function moves(w: World, [cx, cy]: P, arms: number[], d = 5, box = 7): string[] {
  const keep = (x: number, y: number) => Math.abs(x + 0.5 - cx) <= box && Math.abs(y + 0.5 - cy) <= box;
  const out = new Set<string>();
  for (const a of arms) {
    const src = laneAt(w, cx + DX[a] * d, cy + DY[a] * d, opp(a));
    if (src < 0) { out.add(`no lane into the junction on the ${NAME[a]} arm`); continue; }
    const seen = reach(w, src, keep);
    for (const b of arms) {
      if (b === a) continue;
      const dst = laneAt(w, cx + DX[b] * d, cy + DY[b] * d, b);
      if (dst < 0) out.add(`no lane out of the junction on the ${NAME[b]} arm`);
      else if (!seen.has(dst)) out.add(`cannot drive from the ${NAME[a]} arm to the ${NAME[b]} arm`);
    }
  }
  return [...out];
}

// ---------------- なぞった線と、大通りの置き方 ----------------
function segDist(px: number, py: number, a: P, b: P) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  const t = L ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / L)) : 0;
  return Math.hypot(px - a[0] - vx * t, py - a[1] - vy * t);
}

// 1回のドラッグの折れ線（planLine と同じ順：直線の方が長ければ直線→斜め、そうでなければ斜め→直線）
function polyline([x0, y0, x1, y1]: Line): P[] {
  const dx = x1 - x0, dy = y1 - y0, ad = Math.abs(dx), bd = Math.abs(dy);
  const diag = Math.min(ad, bd), straight = Math.max(ad, bd) - diag;
  if (!diag || !straight) return [[x0, y0], [x1, y1]];
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const first: P = straight >= diag ? (ad > bd ? [sx * straight, 0] : [0, sy * straight]) : [sx * diag, sy * diag];
  return [[x0, y0], [x0 + first[0], y0 + first[1]], [x1, y1]];
}

// 大通りのマスの中心が、どれかの線から tol マス以内にあるか（3本目の車線や、角の先に飛び出したマスがない）
function footprint(w: World, lines: P[][], tol: number): string[] {
  const g = w.g, n = g.n;
  const bad: number[] = [];
  for (let c = 0; c < g.road.length; c++) {
    if (g.road[c] !== AV) continue;
    const px = (c % n) + 0.5, py = ((c / n) | 0) + 0.5;
    let best = Infinity;
    for (const pl of lines) for (let k = 0; k + 1 < pl.length; k++) best = Math.min(best, segDist(px, py, pl[k], pl[k + 1]));
    if (best > tol + 1e-6) bad.push(c);
  }
  return bad.length ? [`avenue cells farther than ${tol} cell from the dragged line: ${cells(w, bad)}`] : [];
}

// 東西・南北の線の両側に、正しい向きの車線が1本ずつあるか。右側の車線は進む向き、左側は逆向き。
// 端の1マスと、skip（線の上の点で判定）の場所は見ない。斜めの線は見ない
function sides(w: World, a: P, b: P, skip: (px: number, py: number) => boolean = () => false): string[] {
  const g = w.g;
  const ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1]);
  if (ux && uy) return [];
  const d = dirOf(ux, uy);
  const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
  const rx = -uy, ry = ux; // 進む向きの右（y は下向き）
  const bad = new Map<string, number[]>();
  const add = (k: string, c: number) => { if (!bad.has(k)) bad.set(k, []); bad.get(k)!.push(c); };
  for (let k = 1; k < len - 1; k++) {
    const px = a[0] + ux * (k + 0.5), py = a[1] + uy * (k + 0.5);
    if (skip(px, py)) continue;
    const cell = (s: number) => {
      const x = Math.floor(px + rx * s), y = Math.floor(py + ry * s);
      return g.inb(x, y) ? g.idx(x, y) : -1;
    };
    const lane = (c: number, dir: number, side: string) => {
      if (c < 0) add(`no ${side} lane (map edge)`, 0);
      else if (g.road[c] !== AV) add(`no avenue lane on the ${side} of the ${NAME[d]} line`, c);
      else if (!bit(g.flow[c], dir) || bit(g.flow[c], opp(dir))) add(`${side} lane should flow ${NAME[dir]} only`, c);
    };
    lane(cell(0.5), d, 'right');
    lane(cell(-0.5), opp(d), 'left');
    for (const c of [cell(1.5), cell(-1.5)]) if (c >= 0 && g.road[c] === AV) add('third lane', c);
  }
  return [...bad].map(([k, cs]) => `${k}: ${cells(w, cs)}`);
}

// 線の真ん中あたりに、行きと帰りの2本の車線があるか（斜めの線にも使う）
function bothWays(w: World, a: P, b: P): string[] {
  const g = w.g, n = g.n;
  const ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1]);
  const d = dirOf(ux, uy);
  const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let fwd = 0, bwd = 0;
  for (let c = 0; c < g.road.length; c++) {
    if (g.road[c] !== AV) continue;
    const px = (c % n) + 0.5, py = ((c / n) | 0) + 0.5;
    if (Math.hypot(px - m[0], py - m[1]) > 1.6 || segDist(px, py, a, b) > 1.0) continue;
    const f = bit(g.flow[c], d), r = bit(g.flow[c], opp(d));
    if (f && !r) fwd++;
    if (r && !f) bwd++;
  }
  return fwd && bwd ? [] : [`near (${m[0]},${m[1]}) the ${NAME[d]} line needs a ${NAME[d]} lane (${fwd}) and a ${NAME[opp(d)]} lane (${bwd})`];
}

const near = ([cx, cy]: P, r: number) => (px: number, py: number) => Math.max(Math.abs(px - cx), Math.abs(py - cy)) <= r;
const around = ([cx, cy]: P, r: number): Box => [cx - r, cy - r, cx + r - 1, cy + r - 1];
function emptyBox(w: World, [x0, y0, x1, y1]: Box, what: string): string[] {
  const bad: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (w.g.inb(x, y) && w.g.road[w.g.idx(x, y)]) bad.push(w.g.idx(x, y));
  return bad.length ? [`${what}: ${cells(w, bad)}`] : [];
}

// 大通りの車線が使っている行（列 x0..x1 の範囲）
function avenueRows(w: World, x0: number, x1: number) {
  const g = w.g, rows = new Set<number>();
  for (let y = 0; y < g.n; y++) for (let x = x0; x <= x1; x++) if (g.road[g.idx(x, y)] === AV) rows.add(y);
  return [...rows].sort((a, b) => a - b);
}

// ---------------- 橋 ----------------
// 線に沿った大通りの橋：2本の車線が、同じ場所から同じ場所まで、同じ高さの橋か（1枚の床版）
function bridgeIssues(w: World, [x0, y0, x1, y1]: Line): string[] {
  const g = w.g, n = g.n;
  const ux = Math.sign(x1 - x0), uy = Math.sign(y1 - y0);
  const d = dirOf(ux, uy);
  const diag = ux !== 0 && uy !== 0;
  const out: string[] = [];
  const fwd: P[] = [], bwd: P[] = []; // [線に沿った位置, 路面の高さ]
  for (let c = 0; c < g.road.length; c++) {
    if (g.road[c] !== AV || !(g.deck[c] > 0)) continue;
    const px = (c % n) + 0.5, py = ((c / n) | 0) + 0.5;
    if (segDist(px, py, [x0, y0], [x1, y1]) > 1.25) continue;
    const t = ((px - x0) * ux + (py - y0) * uy) / (diag ? 2 : 1);
    const f = bit(g.flow[c], d), b = bit(g.flow[c], opp(d));
    if (f && !b) fwd.push([t, g.deck[c]]);
    else if (b && !f) bwd.push([t, g.deck[c]]);
    else out.push(`bridge cell ${at(w, c)} is not one-way`);
  }
  if (!fwd.length || !bwd.length) return [...out, `both lanes along the line must be bridges (${NAME[d]} lane ${fwd.length} cells, ${NAME[opp(d)]} lane ${bwd.length} cells)`];
  const span = (a: P[]) => [Math.min(...a.map((v) => v[0])), Math.max(...a.map((v) => v[0]))];
  const [fa, fb] = span(fwd), [ba, bb] = span(bwd);
  const tol = (diag ? 0.5 : 0) + 1e-6;
  if (Math.abs(fa - ba) > tol || Math.abs(fb - bb) > tol) out.push(`bridge spans differ: ${NAME[d]} lane ${fa}..${fb}, ${NAME[opp(d)]} lane ${ba}..${bb}`);
  let worst = 0;
  for (const [t, h] of fwd) {
    let bt = Infinity, bh = h;
    for (const [t2, h2] of bwd) if (Math.abs(t2 - t) < bt) { bt = Math.abs(t2 - t); bh = h2; }
    worst = Math.max(worst, Math.abs(h - bh));
  }
  if (worst > 0.05) out.push(`deck heights of the two lanes differ by ${worst.toFixed(2)} m`);
  return out;
}

// 南北に流れる川（格子点 x = 20..26 が水、マス 19..26 が水面）。東岸は南ほど少し高い
function riverNS(n = 48) {
  const w = flat(n);
  for (let vy = 0; vy <= n; vy++)
    for (let vx = 0; vx <= n; vx++) {
      if (vx >= 20 && vx <= 26) w.g.setVh(vx, vy, -3);
      else if (vx > 26) w.g.setVh(vx, vy, 6 + 0.1 * vy);
    }
  return w;
}
// 東西に流れる川（格子点 y = 20..26 が水）。南岸は東ほど少し高い
function riverEW(n = 48) {
  const w = flat(n);
  for (let vy = 0; vy <= n; vy++)
    for (let vx = 0; vx <= n; vx++) {
      if (vy >= 20 && vy <= 26) w.g.setVh(vx, vy, -3);
      else if (vy > 26) w.g.setVh(vx, vy, 6 + 0.1 * vx);
    }
  return w;
}
// 斜めに流れる川（格子点で 6 <= x - y <= 12 が水）。東西の大通りの2本の車線で、水の上の場所が1マスずれる
function riverDiag(n = 64) {
  const w = flat(n);
  for (let vy = 0; vy <= n; vy++)
    for (let vx = 0; vx <= n; vx++) {
      const k = vx - vy;
      if (k >= 6 && k <= 12) w.g.setVh(vx, vy, -3);
      else if (k > 12) w.g.setVh(vx, vy, 6 + 0.1 * vy);
    }
  return w;
}
const waterRun = (w: World, y: number) => {
  const xs: number[] = [];
  for (let x = 0; x < w.g.n; x++) if (w.g.isWater(x, y)) xs.push(x);
  return `${xs[0]}..${xs[xs.length - 1]}`;
};

// seed 4242 の川のマップ（一度だけ作って、保存データから読み込み直す）
let riverSave: ReturnType<World['serialize']> | null = null;
function riverMap() {
  if (!riverSave) riverSave = World.create({ name: 't', seed: 4242, style: 'river', difficulty: 0, sandbox: true }).serialize();
  return World.load(riverSave);
}
// 東西に川を渡る線（中心線 y、車線は行 y-1 と y）。
// both = 2本の車線の場所（行 y-1 と y）のどちらにも、ふつうの道路の橋なら架けられる（両端のまわりも陸）
// one = 行 y にだけ、ふつうの道路の橋を架けられる（行 y-1 の端は水でもよい）
function riverCrossings(max: number, mode: 'both' | 'one'): Line[] {
  const g = riverMap().g, n = g.n;
  const rows = mode === 'both' ? [-1, 0] : [0];
  const wet = (x: number, y: number) => rows.some((r) => g.isWater(x, y + r));
  const dry = (x: number, y: number) => {
    const ys = mode === 'both' ? [y - 2, y - 1, y, y + 1] : [y];
    for (const yy of ys) for (let xx = x - 1; xx <= x + 1; xx++) if (!g.inb(xx, yy) || g.isWater(xx, yy)) return false;
    return true;
  };
  const pad = mode === 'both' ? 4 : 2;
  const out: Line[] = [];
  let w = riverMap();
  for (let y = 8; y < n - 8 && out.length < max; y += mode === 'both' ? 5 : 3) {
    for (let x = 1; x < n - 1 && out.length < max; x++) {
      if (!wet(x, y) || wet(x - 1, y)) continue;
      // x..e が1つの水の帯。その両側は陸
      let e = x;
      while (e + 1 < n && wet(e + 1, y)) e++;
      const x0 = x - pad, x1 = e + pad;
      if (e - x > 17 || x0 < 2 || x1 > n - 3 || !dry(x0, y) || !dry(x1, y)) continue;
      let alone = true;
      for (let k = x0; k <= x1; k++) if ((k < x || k > e) && wet(k, y)) alone = false;
      if (!alone) continue;
      let ok = true;
      for (const r of rows) {
        if (w.exec({ t: 'road', x0, y0: y + r, x1, y1: y + r, road: RD }).ok) w = riverMap();
        else ok = false;
      }
      if (ok) out.push([x0, y, x1, y]);
    }
  }
  return out;
}

// =====================================================================
describe('avenue: the dragged line is the centreline', () => {
  const straight: [string, Line][] = [
    ['straight avenue dragged east sits on both sides of the line', [8, 24, 40, 24]],
    ['straight avenue dragged west sits on both sides of the line', [40, 24, 8, 24]],
    ['straight avenue dragged south sits on both sides of the line', [24, 8, 24, 40]],
    ['straight avenue dragged north sits on both sides of the line', [24, 40, 24, 8]],
  ];
  for (const [name, l] of straight)
    spec(name, () => {
      const w = flat();
      draw(w, l);
      const [a, b] = polyline(l);
      clean(w, [...sides(w, a, b), ...footprint(w, [[a, b]], 1.0), ...connected(w), ...junctions(w), ...twoWay(w)], [4, 20, 44, 27]);
    });

  const pairs: [string, Line, Line][] = [
    ['east and west drags along the same line give the same avenue', [8, 24, 40, 24], [40, 24, 8, 24]],
    ['south and north drags along the same line give the same avenue', [24, 8, 24, 40], [24, 40, 24, 8]],
  ];
  for (const [name, l1, l2] of pairs)
    spec(name, () => {
      const w1 = flat(), w2 = flat();
      draw(w1, l1);
      draw(w2, l2);
      const set = (w: World) => [...w.g.road.keys()].filter((i) => w.g.road[i]).map((i) => at(w, i)).sort();
      expect(set(w2)).toEqual(set(w1));
    });
});

// =====================================================================
describe('avenue: L corners drawn with two drags', () => {
  const U: P[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (const u of U)
    for (const turn of ['left', 'right'] as const)
      for (const off of [0, 1, -1]) {
        const v: P = turn === 'left' ? [u[1], -u[0]] : [-u[1], u[0]];
        const du = dirOf(u[0], u[1]), dv = dirOf(v[0], v[1]);
        const p1: P = [24, 24];
        const p0: P = [24 - 10 * u[0], 24 - 10 * u[1]];
        const p2: P = [24 + 10 * v[0], 24 + 10 * v[1]];
        // 2回目のドラッグの始点：角ちょうど / 1マス行き過ぎ / 1マス手前
        const s: P = [24 + off * u[0], 24 + off * u[1]];
        const e: P = [p2[0] + off * u[0], p2[1] + off * u[1]];
        const tail = off === 0 ? '' : off > 0 ? ', second drag starts 1 cell past the corner' : ', second drag starts 1 cell before the corner';
        spec(`L corner: ${NAME[du]} then ${turn} (${NAME[dv]})${tail}`, () => {
          const w = flat();
          draw(w, [p0[0], p0[1], p1[0], p1[1]]);
          draw(w, [s[0], s[1], e[0], e[1]]);
          const corner = near(p1, 1.5);
          clean(w, [
            ...connected(w),
            ...moves(w, p1, [opp(du), dv]),
            ...footprint(w, [[p0, p1], [p1, p2], [p2, e]], 1.0),
            ...sides(w, p0, p1, corner),
            ...sides(w, p1, p2, corner),
            ...junctions(w),
            ...twoWay(w),
          ], [10, 10, 38, 38]);
        });
      }
});

// =====================================================================
describe('avenue: 45° bends', () => {
  // 1回のドラッグ（直線と斜めの折れ線）
  const offs: P[] = [[12, 4], [12, -4], [-12, 4], [-12, -4], [4, 12], [-4, 12], [4, -12], [-4, -12], [12, 8], [12, -8], [-12, 8], [-12, -8], [8, 12], [-8, 12], [8, -12], [-8, -12]];
  for (const [dx, dy] of offs) {
    const l: Line = [24, 24, 24 + dx, 24 + dy];
    const pl = polyline(l);
    const d1 = dirOf(Math.sign(pl[1][0] - pl[0][0]), Math.sign(pl[1][1] - pl[0][1]));
    const d2 = dirOf(Math.sign(pl[2][0] - pl[1][0]), Math.sign(pl[2][1] - pl[1][1]));
    spec(`one-drag bend ${NAME[d1]}→${NAME[d2]} (drag by ${dx},${dy})`, () => {
      const w = flat();
      draw(w, l);
      const bend = near(pl[1], 1.5);
      clean(w, [
        ...connected(w),
        ...footprint(w, [pl], 1.25),
        ...sides(w, pl[0], pl[1], bend),
        ...sides(w, pl[1], pl[2], bend),
        ...bothWays(w, pl[0], pl[1]),
        ...bothWays(w, pl[1], pl[2]),
        ...junctions(w),
        ...twoWay(w),
      ], [8, 8, 40, 40]);
    });
  }

  // 2回のドラッグ：直線のあとに斜め
  const two: [number, P, P][] = [
    [E, [10, 24], [34, 14]], [E, [10, 24], [34, 34]],
    [S, [24, 10], [34, 34]], [S, [24, 10], [14, 34]],
    [W, [38, 24], [14, 14]], [W, [38, 24], [14, 34]],
    [N, [24, 38], [34, 14]], [N, [24, 38], [14, 14]],
  ];
  for (const [d, p0, p2] of two) {
    const d2 = dirOf(Math.sign(p2[0] - 24), Math.sign(p2[1] - 24));
    spec(`two-drag bend ${NAME[d]} then ${NAME[d2]}`, () => {
      const w = flat();
      draw(w, [p0[0], p0[1], 24, 24]);
      draw(w, [24, 24, p2[0], p2[1]]);
      const joint = near([24, 24], 1.5);
      clean(w, [
        ...connected(w),
        ...footprint(w, [[p0, [24, 24]], [[24, 24], p2]], 1.25),
        ...sides(w, p0, [24, 24], joint),
        ...bothWays(w, [24, 24], p2),
        ...junctions(w),
        ...twoWay(w),
      ], [8, 8, 40, 40]);
    });
  }
});

// =====================================================================
describe('avenue: T junctions into an avenue', () => {
  // 東西の大通り（中心線 y = 24：北の行 23 が西向き、南の行 24 が東向き）に、南北の大通りを突き当てる
  const main: Line = [4, 24, 44, 24];
  const ends: [string, number, number][] = [
    // [指が止まった場所, 始点の y, 終点の y]
    ['from the south, finger stops 2 cells short (y=27)', 40, 27],
    ['from the south, finger stops 1 cell short (y=26)', 40, 26],
    ['from the south, finger stops on the near lane (y=25)', 40, 25],
    ['from the south, finger stops on the centreline (y=24)', 40, 24],
    ['from the south, finger stops on the far lane (y=23)', 40, 23],
    ['from the north, finger stops 2 cells short (y=21)', 8, 21],
    ['from the north, finger stops 1 cell short (y=22)', 8, 22],
    ['from the north, finger stops on the near lane (y=23)', 8, 23],
    ['from the north, finger stops on the centreline (y=24)', 8, 24],
    ['from the north, finger stops on the far lane (y=25)', 8, 25],
  ];
  for (const [what, y0, y1] of ends)
    spec(`T into an avenue ${what}`, () => {
      const w = flat();
      draw(w, main);
      draw(w, [24, y0, 24, y1]);
      const c: P = [24, 24];
      const arm = y0 > 24 ? S : N;
      clean(w, [
        ...connected(w),
        ...moves(w, c, [E, W, arm]),
        ...footprint(w, [[[4, 24], [44, 24]], [[24, y0], c]], 1.0),
        ...sides(w, [4, 24], [44, 24], near(c, 2.5)),
        ...sides(w, [24, y0], c, near(c, 2.5)),
        ...junctions(w, around(c, 3)),
        ...twoWay(w),
      ], [14, 14, 34, 34]);
    });

  // 南北の大通り（中心線 x = 24）の横から、東西の大通りを引き始める
  const vmain: Line = [24, 4, 24, 44];
  const starts: [string, number, number][] = [
    ['eastwards, finger starts 2 cells off (x=27)', 27, 40],
    ['eastwards, finger starts 1 cell off (x=26)', 26, 40],
    ['eastwards, finger starts on the near lane (x=25)', 25, 40],
    ['eastwards, finger starts on the centreline (x=24)', 24, 40],
    ['eastwards, finger starts on the far lane (x=23)', 23, 40],
    ['westwards, finger starts 2 cells off (x=21)', 21, 8],
    ['westwards, finger starts 1 cell off (x=22)', 22, 8],
    ['westwards, finger starts on the near lane (x=23)', 23, 8],
    ['westwards, finger starts on the centreline (x=24)', 24, 8],
    ['westwards, finger starts on the far lane (x=25)', 25, 8],
  ];
  for (const [what, x0, x1] of starts)
    spec(`T out of an avenue ${what}`, () => {
      const w = flat();
      draw(w, vmain);
      draw(w, [x0, 20, x1, 20]);
      const c: P = [24, 20];
      const arm = x1 > 24 ? E : W;
      clean(w, [
        ...connected(w),
        ...moves(w, c, [N, S, arm]),
        ...footprint(w, [[[24, 4], [24, 44]], [c, [x1, 20]]], 1.0),
        ...sides(w, [24, 4], [24, 44], near(c, 2.5)),
        ...sides(w, c, [x1, 20], near(c, 2.5)),
        ...junctions(w, around(c, 3)),
        ...twoWay(w),
      ], [10, 10, 38, 30]);
    });

  // ふつうの道路（マスの座標）を、大通りに突き当てる
  const roads: [string, number, number][] = [
    ['from the south, ending next to the avenue (y=25)', 40, 25],
    ['from the south, ending on the near lane (y=24)', 40, 24],
    ['from the south, ending on the far lane (y=23)', 40, 23],
    ['from the north, ending next to the avenue (y=22)', 8, 22],
    ['from the north, ending on the near lane (y=23)', 8, 23],
    ['from the north, ending on the far lane (y=24)', 8, 24],
  ];
  for (const [what, y0, y1] of roads)
    spec(`road T into an avenue ${what}`, () => {
      const w = flat();
      draw(w, main);
      draw(w, [24, y0, 24, y1], RD);
      const c: P = [24, 24];
      const arm = y0 > 24 ? S : N;
      // 大通りの向こう側に、道路がはみ出していない
      const beyond: Box = y0 > 24 ? [20, 14, 28, 22] : [20, 25, 28, 33];
      clean(w, [
        ...connected(w),
        ...moves(w, c, [E, W, arm]),
        ...emptyBox(w, beyond, 'road sticks out past the avenue'),
        ...footprint(w, [[[4, 24], [44, 24]]], 1.0),
        ...sides(w, [4, 24], [44, 24], near(c, 1.5)),
        ...junctions(w, around(c, 3)),
      ], [14, 14, 34, 34]);
    });
});

// =====================================================================
describe('avenue: crossings', () => {
  const main: Line = [4, 24, 44, 24];
  const c: P = [24, 24];
  for (const [name, cross] of [
    ['avenue × avenue crossing (second avenue dragged north)', [24, 40, 24, 8]],
    ['avenue × avenue crossing (second avenue dragged south)', [24, 8, 24, 40]],
  ] as [string, Line][])
    spec(name, () => {
      const w = flat();
      draw(w, main);
      draw(w, cross);
      const [a, b] = polyline(cross);
      clean(w, [
        ...connected(w),
        ...moves(w, c, [E, S, W, N]),
        ...footprint(w, [[[4, 24], [44, 24]], [a, b]], 1.0),
        ...sides(w, [4, 24], [44, 24], near(c, 2.5)),
        ...sides(w, a, b, near(c, 2.5)),
        ...junctions(w, around(c, 3)),
        ...twoWay(w),
      ], [14, 14, 34, 34]);
    });

  for (const [name, order] of [
    ['avenue × road crossing (road first, then the avenue across it)', 'road'],
    ['avenue × road crossing (avenue first, then the road across it)', 'avenue'],
  ] as [string, string][])
    spec(name, () => {
      const w = flat();
      if (order === 'road') draw(w, [24, 4, 24, 44], RD);
      draw(w, main);
      if (order === 'avenue') draw(w, [24, 40, 24, 8], RD);
      clean(w, [
        ...connected(w),
        ...moves(w, c, [E, S, W, N]),
        ...footprint(w, [[[4, 24], [44, 24]]], 1.0),
        ...sides(w, [4, 24], [44, 24], near(c, 1.5)),
        ...junctions(w, around(c, 3)),
        ...twoWay(w),
      ], [14, 14, 34, 34]);
    });

  spec('diagonal avenue × avenue crossing', () => {
    const w = flat();
    draw(w, [2, 24, 46, 24]);
    draw(w, [8, 40, 40, 8]);
    clean(w, [
      ...connected(w),
      ...moves(w, c, [E, W, NE, SW]),
      ...footprint(w, [[[2, 24], [46, 24]], [[8, 40], [40, 8]]], 1.25),
      ...junctions(w, around(c, 4)),
      ...twoWay(w),
    ], [12, 12, 36, 36]);
  });
});

// =====================================================================
describe('avenue: continuing and joining', () => {
  // 1本目：中心線 y = 24 の (10,24) → (24,24)。2本目で続きを引く
  const lineChecks = (w: World, a: P, b: P, joint: P) => [
    ...connected(w),
    ...sides(w, a, b),
    ...footprint(w, [[a, b]], 1.0),
    ...junctions(w),
    ...twoWay(w),
    ...(avenueRows(w, 0, w.g.n - 1).join(',') === '23,24' ? [] : [`avenue uses rows ${avenueRows(w, 0, w.g.n - 1).join(',')} (should be 23,24)`]),
    ...moves(w, joint, [E, W], 4),
  ];
  const forward: [string, Line][] = [
    ['continuing an avenue from its end', [24, 24, 40, 24]],
    ['continuing an avenue, finger starts 1 cell past the end', [25, 24, 40, 24]],
    ['continuing an avenue, finger starts 2 cells past the end', [26, 24, 40, 24]],
    ['continuing an avenue, finger starts 1 cell back on the avenue', [23, 24, 40, 24]],
    ['continuing an avenue, finger starts 1 cell north of the end', [24, 23, 40, 24]],
    ['continuing an avenue, finger starts 1 cell south of the end', [24, 25, 40, 24]],
    ['reverse continuation: dragged back to the end of the first avenue', [40, 24, 24, 24]],
    ['reverse continuation: dragged back to 1 cell short of the end', [40, 24, 25, 24]],
    ['reverse continuation: dragged back to 2 cells short of the end', [40, 24, 26, 24]],
  ];
  for (const [name, l] of forward)
    spec(name, () => {
      const w = flat();
      draw(w, [10, 24, 24, 24]);
      draw(w, l);
      clean(w, lineChecks(w, [10, 24], [40, 24], [24, 24]), [6, 20, 44, 27]);
    });

  for (const [name, gap] of [
    ['closing the gap between avenues drawn in opposite directions', [14, 24, 26, 24]],
    ['closing the gap between avenues drawn in opposite directions, dragged west', [26, 24, 14, 24]],
  ] as [string, Line][])
    spec(name, () => {
      const w = flat();
      draw(w, [2, 24, 14, 24]);
      draw(w, [40, 24, 26, 24]);
      draw(w, gap);
      clean(w, [...lineChecks(w, [2, 24], [40, 24], [14, 24]), ...moves(w, [26, 24], [E, W], 4)], [0, 20, 44, 27]);
    });

  // 道路（マス (10,24)〜(24,24)）の端から大通りを引く・道路の端で大通りを止める
  const fromRoad: [string, Line][] = [
    ['avenue continuing from a road end', [24, 24, 40, 24]],
    ['avenue continuing from a road end, finger starts 1 cell past it', [25, 24, 40, 24]],
    ['avenue continuing from a road end, centreline on the south edge of the road', [24, 25, 40, 25]],
    ['avenue continuing from a road end, 1 cell past, centreline on the south edge', [25, 25, 40, 25]],
    ['avenue dragged west ending on a road end', [40, 24, 24, 24]],
    ['avenue dragged west ending on a road end, centreline on the south edge', [40, 25, 24, 25]],
  ];
  for (const [name, l] of fromRoad)
    spec(name, () => {
      const w = flat();
      draw(w, [10, 24, 24, 24], RD);
      draw(w, l);
      const g = w.g;
      const road: number[] = [];
      for (let x = 11; x <= 22; x++) if (g.road[g.idx(x, 24)] !== RD) road.push(g.idx(x, 24));
      const [a, b] = polyline(l);
      clean(w, [
        ...connected(w),
        ...(road.length ? [`the road was changed: ${cells(w, road)}`] : []),
        ...sides(w, a, b, (px) => px < 27),
        ...footprint(w, [[[24, l[1]], [40, l[1]]]], 1.0),
        ...moves(w, [24, 24], [E, W], 5),
      ], [6, 20, 44, 28]);
    });

  for (const [name, l] of [
    ['road continuing from an avenue end', [24, 24, 40, 24]],
    ['road continuing from the other lane of an avenue end', [24, 23, 40, 23]],
  ] as [string, Line][])
    spec(name, () => {
      const w = flat();
      draw(w, [10, 24, 24, 24]);
      draw(w, l, RD);
      clean(w, [...connected(w), ...moves(w, [24, 24], [E, W], 5)], [6, 20, 44, 27]);
    });
});

// =====================================================================
describe('avenue: upgrading a road by dragging along it', () => {
  // 道路（行 24、x = 4..32）に、細い道が x = 10, 18, 26 で交差している
  for (const [name, l] of [
    ['upgrading a road: avenue dragged east along it', [6, 24, 30, 24]],
    ['upgrading a road: avenue dragged west along it', [30, 24, 6, 24]],
    ['upgrading a road: avenue dragged east along its south edge', [6, 25, 30, 25]],
    ['upgrading a road: avenue dragged west along its south edge', [30, 25, 6, 25]],
  ] as [string, Line][])
    spec(name, () => {
      const w = flat();
      draw(w, [4, 24, 32, 24], RD);
      for (const x of [10, 18, 26]) draw(w, [x, 18, x, 30], ST);
      draw(w, l);
      const g = w.g;
      const issues = [...connected(w)];
      const rows = avenueRows(w, 8, 28);
      if (rows.length !== 2 || rows[1] - rows[0] !== 1 || !rows.includes(24)) issues.push(`avenue rows ${rows.join(',')} (should be the road row 24 and one row next to it)`);
      else
        for (let x = 8; x <= 28; x++) {
          if (x === 10 || x === 18 || x === 26) continue;
          const s = g.idx(x, rows[1]), nn = g.idx(x, rows[0]);
          if (g.road[s] !== AV || !bit(g.flow[s], E) || bit(g.flow[s], W)) issues.push(`south lane ${at(w, s)} should be an eastbound avenue`);
          if (g.road[nn] !== AV || !bit(g.flow[nn], W) || bit(g.flow[nn], E)) issues.push(`north lane ${at(w, nn)} should be a westbound avenue`);
        }
      for (const x of [10, 18, 26]) issues.push(...moves(w, [x, rows[1] ?? 24], [N, S, E, W], 4, 5).map((s) => `street x=${x}: ${s}`));
      clean(w, issues, [2, 17, 34, 31]);
    });
  // 道路（列 24、y = 4..40）に、西から x = 16..24 の道が y = 14 で、東から x = 24..32 の道が y = 26 で突き当たっている。
  // どちらの側の道も、大通りの2本の車線の両方へつながる（左折できる）
  for (const [name, l] of [
    ['upgrading a road with side streets on both sides: new lane on its west side', [24, 6, 24, 38]],
    ['upgrading a road with side streets on both sides: new lane on its east side, dragged north', [25, 38, 25, 6]],
  ] as [string, Line][])
    spec(name, () => {
      const w = flat();
      draw(w, [24, 4, 24, 40], RD);
      draw(w, [16, 14, 24, 14], RD);
      draw(w, [32, 26, 24, 26], RD);
      draw(w, l);
      const g = w.g;
      const issues = [...connected(w)];
      const cols = new Set<number>();
      for (let y = 8; y <= 36; y++) for (let x = 20; x <= 28; x++) if (g.road[g.idx(x, y)] === AV) cols.add(x);
      const cs = [...cols].sort((a, b) => a - b);
      if (cs.length !== 2 || !cs.includes(24)) issues.push(`avenue columns ${cs.join(',')} (should be the road column 24 and one next to it)`);
      else
        for (const [y, side] of [[14, -1], [26, 1]] as [number, number][]) {
          const s = g.idx(side < 0 ? cs[0] - 1 : cs[1] + 1, y);
          for (const x of cs) {
            const c = g.idx(x, y);
            if (!reach(w, s, (qx, qy) => Math.abs(qy - y) <= 1 && qx >= cs[0] - 1 && qx <= cs[1] + 1).has(c)) issues.push(`side street ${at(w, s)} cannot reach lane ${at(w, c)}`);
            if (!reach(w, s, (qx, qy) => Math.abs(qy - y) <= 1 && qx >= cs[0] - 1 && qx <= cs[1] + 1, true).has(c)) issues.push(`lane ${at(w, c)} cannot reach side street ${at(w, s)}`);
          }
          issues.push(...moves(w, [cs[1], y], [N, S, side < 0 ? W : E], 4, 5).map((q) => `side street y=${y}: ${q}`));
        }
      clean(w, issues, [14, 2, 34, 42]);
    });
  spec('a road dead end touching the outer side of a new avenue is joined to both lanes', () => {
    const w = flat();
    draw(w, [10, 20, 17, 20], RD); // 東の端 (17,20) が、あとで引く大通りの西側の車線 (18,20) に向いている
    draw(w, [19, 6, 19, 36]);
    const g = w.g;
    const issues = [...connected(w)];
    const s = g.idx(17, 20);
    for (const x of [18, 19]) {
      const c = g.idx(x, 20);
      if (!reach(w, s, (qx, qy) => Math.abs(qy - 20) <= 1 && qx >= 17 && qx <= 19).has(c)) issues.push(`road end cannot reach lane ${at(w, c)}`);
      if (!reach(w, s, (qx, qy) => Math.abs(qy - 20) <= 1 && qx >= 17 && qx <= 19, true).has(c)) issues.push(`lane ${at(w, c)} cannot reach the road end`);
    }
    clean(w, issues, [8, 4, 22, 38]);
  });
});

// =====================================================================
describe('avenue: bridges are one deck for both directions', () => {
  const cases: [string, () => World, Line][] = [
    ['avenue across a river dragged east', riverNS, [8, 24, 40, 24]],
    ['avenue across a river dragged west', riverNS, [40, 24, 8, 24]],
    ['avenue across a river dragged south', riverEW, [24, 8, 24, 40]],
    ['avenue across a river dragged north', riverEW, [24, 40, 24, 8]],
    ['avenue across a slanting river (water under the two lanes is offset) dragged east', riverDiag, [16, 24, 52, 24]],
    ['avenue across a slanting river (water under the two lanes is offset) dragged west', riverDiag, [52, 24, 16, 24]],
    ['diagonal avenue across a river (south-east)', riverNS, [6, 6, 40, 40]],
    ['diagonal avenue across a river (north-east)', riverNS, [6, 40, 40, 6]],
  ];
  for (const [name, make, l] of cases)
    spec(`${name}: both lanes are bridges with the same span and deck height`, () => {
      const w = make();
      if (make === riverDiag) expect(waterRun(w, 23)).not.toBe(waterRun(w, 24)); // 前提：2本の車線で水の場所がずれる
      draw(w, l);
      const [a, b] = polyline(l);
      clean(w, [...connected(w), ...bridgeIssues(w, l), ...sides(w, a, b), ...twoWay(w)], [Math.min(l[0], l[2]) - 1, Math.min(l[1], l[3]) - 2, Math.max(l[0], l[2]) + 1, Math.max(l[1], l[3]) + 1]);
    });

  // 両方の向きに引いて、問題を集める
  const bothDirs = (lines: Line[], check: (w: World, l: Line) => string[]) => {
    const issues: string[] = [];
    for (const l of lines)
      for (const ll of [l, [l[2], l[3], l[0], l[1]] as Line]) {
        const w = riverMap();
        const r = w.exec({ t: 'road', x0: ll[0], y0: ll[1], x1: ll[2], y1: ll[3], road: AV });
        const found = r.ok ? check(w, ll) : [`cannot build: ${r.msg}`];
        issues.push(...found.map((s) => `(${ll[0]},${ll[1]})→(${ll[2]},${ll[3]}): ${s}`));
      }
    return issues;
  };

  spec('seed 4242 river map: an avenue can cross the river wherever roads along both of its lanes can', () => {
    const lines = riverCrossings(6, 'both');
    expect(lines.length).toBeGreaterThan(2);
    expect(bothDirs(lines, connected)).toEqual([]);
  });

  spec('seed 4242 river map: an avenue can cross the river wherever a road along the same line can', () => {
    const lines = riverCrossings(8, 'one');
    expect(lines.length).toBeGreaterThan(2);
    expect(bothDirs(lines, connected)).toEqual([]);
  });

  spec('seed 4242 river map: straight avenue bridges are one deck (same span and height for both lanes)', () => {
    expect(bothDirs(riverCrossings(6, 'both'), bridgeIssues)).toEqual([]);
  });

  spec('seed 4242 river map: diagonal avenue bridges are one deck', () => {
    expect(bothDirs([[34, 64, 56, 42], [36, 49, 58, 71]], (w, l) => [...bridgeIssues(w, l), ...connected(w)])).toEqual([]);
  });

  spec('loading a save levels the two decks of an avenue bridge', () => {
    const w = riverNS();
    const l: Line = [8, 24, 40, 24];
    draw(w, l);
    // 古い保存データ：西向きの車線の橋だけ高さが違う
    const g = w.g;
    for (let i = 0; i < g.road.length; i++) if (g.road[i] === AV && g.deck[i] > 0 && bit(g.flow[i], W)) g.deck[i] += 0.6;
    const w2 = World.load(w.serialize());
    clean(w2, bridgeIssues(w2, l), [6, 21, 42, 26]);
  });
});

// =====================================================================
describe('avenue: diagonal overpass over a ground highway', () => {
  spec('the two lanes of a diagonal overpass ramp rise together (same height at the same place along the avenue)', () => {
    const w = flat(64);
    // 地面に坂をつける（取り付け部分の高さが、マスの地面の高さにも左右されるように）
    const g = w.g;
    for (let vy = 0; vy <= g.n; vy++) for (let vx = 0; vx <= g.n; vx++) g.setVh(vx, vy, 6 + vx * 0.15 + vy * 0.05);
    draw(w, [32, 2, 32, 62], RoadType.UrbanGroundHighway);
    draw(w, [16, 16, 48, 48]);
    // 斜めの車線のマスの、道に沿った位置（x + y）ごとの路面の高さ。2本の車線は x + y の偶奇が違う
    const h = new Map<number, number>();
    for (let i = 0; i < g.road.length; i++) {
      if (g.road[i] !== AV || g.up[i]) continue;
      const x = i % g.n, y = (i / g.n) | 0;
      if (Math.abs(x - y) > 2 || g.lift[i] <= 0.3) continue;
      h.set(x + y, g.roadH(i));
    }
    let decks = 0;
    for (let i = 0; i < g.road.length; i++) if (g.up[i] === AV) decks++;
    // 坂の途中（前後 2 マスも持ち上がった取り付け部分のところ）で、片方の車線の高さが、もう片方の車線の前後の平均とそろう
    const issues: string[] = [];
    let checked = 0;
    for (const [u, hu] of h) {
      const a = h.get(u - 1), b = h.get(u + 1);
      if (a === undefined || b === undefined || !h.has(u - 2) || !h.has(u + 2)) continue;
      checked++;
      if (Math.abs(hu - (a + b) / 2) > 0.2) issues.push(`x+y=${u}: ${hu.toFixed(2)} vs other lane ${((a + b) / 2).toFixed(2)}`);
    }
    expect(decks).toBe(2);
    expect(checked).toBeGreaterThan(1);
    clean(w, issues, [14, 14, 50, 50]);
  });
});

describe('avenue: drawing feedback', () => {
  spec('dragging along an existing avenue (either way) changes nothing and says so', () => {
    for (const l of [[8, 24, 40, 24], [40, 24, 8, 24]] as Line[]) {
      const w = flat();
      draw(w, [8, 24, 40, 24]);
      const before = Array.from(w.g.flow);
      const plan = planRoadCmd(w.g, AV, ...l);
      expect(plan.noop).toBe(true);
      expect(plan.reason).toBe('すでに大通りです');
      const r = w.exec({ t: 'road', x0: l[0], y0: l[1], x1: l[2], y1: l[3], road: AV });
      expect(r.ok).toBe(false);
      expect(Array.from(w.g.flow)).toEqual(before);
    }
  });

  spec('an avenue drawn right beside another one is allowed, with a note about the touching sidewalks', () => {
    const w = flat();
    draw(w, [8, 20, 40, 20]);
    const plan = planRoadCmd(w.g, AV, 8, 22, 40, 22);
    expect(plan.ok).toBe(true);
    expect(plan.note).toBe('となりの大通りと歩道が重なります');
    expect(planRoadCmd(w.g, AV, 8, 30, 40, 30).note).toBeUndefined();
  });
});

// =====================================================================
describe('avenue: junction control', () => {
  const jcells = (w: World, [cx, cy]: P, r = 3) => {
    const g = w.g, out: number[] = [];
    for (let y = cy - r; y < cy + r; y++) for (let x = cx - r; x < cx + r; x++) if (g.road[g.idx(x, y)] && degree(g.conn[g.idx(x, y)]) >= 3) out.push(g.idx(x, y));
    return out;
  };
  const ctlNow = (w: World, cs: number[]) => {
    const j = buildJunctions(w.g, w.maps.traffic);
    return cs.map((c) => j.ctl[c]);
  };
  const roundabout = (w: World, cs: number[]) => {
    for (const cell of cs) w.exec({ t: 'junction', cell, ctl: Ctl.Roundabout, split: 50, flags: 0 });
    return ctlNow(w, cs).filter((c) => c === Ctl.Roundabout).length;
  };
  const builds: [string, (w: World) => void][] = [
    ['avenue × avenue', (w) => { draw(w, [4, 24, 44, 24]); draw(w, [24, 40, 24, 8]); }],
    ['avenue × road', (w) => { draw(w, [4, 24, 44, 24]); draw(w, [24, 40, 24, 8], RD); }],
    ['avenue T', (w) => { draw(w, [4, 24, 44, 24]); draw(w, [24, 40, 24, 24]); }],
  ];
  for (const [what, build] of builds)
    spec(`no roundabout can be set on an ${what} junction`, () => {
      const w = flat();
      build(w);
      const cs = jcells(w, [24, 24]);
      expect(cs.length).toBeGreaterThan(0);
      expect(roundabout(w, cs)).toBe(0);
    });

  it('a plain road × road junction can still be a roundabout', () => {
    const w = flat();
    draw(w, [4, 24, 44, 24], RD);
    draw(w, [24, 4, 24, 44], RD);
    const cs = jcells(w, [24, 24]);
    expect(cs.map((c) => at(w, c))).toEqual(['(24,24)']);
    expect(roundabout(w, cs)).toBe(1);
  });

  spec('old saves with a roundabout on an avenue junction load as signals', () => {
    const w = flat();
    draw(w, [4, 24, 44, 24]);
    draw(w, [24, 40, 24, 8]);
    const cs = jcells(w, [24, 24]);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) w.g.ictl[c] = Ctl.Roundabout;
    const w2 = World.load(w.serialize());
    expect(ctlNow(w2, cs)).toEqual(cs.map(() => Ctl.Signal));
  });
});

it('every KNOWN_BROKEN entry names a test in this file', () => {
  expect([...KNOWN_BROKEN].filter((n) => !declared.has(n))).toEqual([]);
});
