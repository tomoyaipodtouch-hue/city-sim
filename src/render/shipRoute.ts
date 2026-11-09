// 貨物船の航路と動き（本物の接岸の手順に合わせる）
// 入港：船の幅ぶん岸から離れた水面を通り、最後は岸壁と平行にまっすぐ進んで、接岸位置の沖で止まる
//       → タグボートが真横に押して接岸する
// 出港：タグボートが真横に引き離す → 広い水面までゆっくり後進 → タグボートでその場で向きを変える → 外洋へ
// 船体の向きは、航路の前後 2 点を結ぶ向き（船首と船尾が航路の上にのる）。角は大きな円弧で丸める

export interface ShipSpec {
  len: number; // 船の長さ（m）
  beam: number; // 船の幅（m）
  speed: number; // 外洋での速さ（m/秒）
}

export interface ShipRoute {
  px: Float32Array; // 外洋 → 接岸位置の沖（S）までの、細かく区切った点
  pz: Float32Array;
  acc: Float32Array;
  hd: number; // 接岸中の向き
  align: number; // 沖で止まってから接岸の向きまで回す角度（岸壁と平行に入ってこられないとき）
  pivot: number; // 向きを変える場所（航路の先頭からの距離）
}

const CELL_DEFAULT = 16;

// 水面の判定：wet(x, y) はマップの外も水として true を返す
export function planShipRoute(
  n: number, wet: (x: number, y: number) => boolean,
  S: [number, number], axis: [number, number], spec: ShipSpec, CELL = CELL_DEFAULT,
): ShipRoute | null {
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n;
  const cellOf = (x: number, z: number) => [Math.floor(x / CELL), Math.floor(z / CELL)] as const;
  // 半径 r マスの円の中がすべて水のマス
  const clearMask = (r: number) => {
    const m = new Uint8Array(n * n);
    const offs: [number, number][] = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) offs.push([dx, dy]);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let ok = true;
      for (const [dx, dy] of offs) if (!wet(x + dx, y + dy)) { ok = false; break; }
      m[y * n + x] = ok ? 1 : 0;
    }
    return m;
  };
  const okAt = (m: Uint8Array, x: number, z: number) => {
    const [cx, cy] = cellOf(x, z);
    return inb(cx, cy) ? m[cy * n + cx] === 1 : true;
  };
  const lineOk = (m: Uint8Array, ax: number, az: number, bx: number, bz: number) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (CELL / 3)));
    for (let k = 0; k <= steps; k++) if (!okAt(m, ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps)) return false;
    return true;
  };
  const rMax = Math.max(0, Math.ceil((spec.beam / 2 + 8) / CELL));
  for (let r = rMax; r >= 0; r--)
  for (const leadK of [1.2, 0.6, 0]) {
    const lead = spec.len * leadK;
    const m = clearMask(r);
    // 接岸位置の沖で、岸壁と平行な船体が水の上にあること（船体の幅は岸壁側に少しはみ出してもよいので、中心線だけ見る）
    const wm = r > 0 ? clearMask(Math.max(0, r - 1)) : m;
    if (!lineOk(wm, S[0] - axis[0] * spec.len * 0.5, S[1] - axis[1] * spec.len * 0.5, S[0] + axis[0] * spec.len * 0.5, S[1] + axis[1] * spec.len * 0.5)) continue;
    let best: { pts: [number, number][]; hd: number; align: number; len: number } | null = null;
    for (const sg of [1, -1]) {
      // P：岸壁と平行にまっすぐ入ってくる手前の点（進む向きは sg * axis）
      if (!lead && sg < 0) continue;
      const P: [number, number] = [S[0] - sg * axis[0] * lead, S[1] - sg * axis[1] * lead];
      if (lead && (!lineOk(wm, P[0], P[1], S[0], S[1]) || !okAt(m, P[0], P[1]))) continue;
      const cells = bfsToEdge(n, m, cellOf(P[0], P[1]));
      if (!cells) continue;
      // 見通しのきくところは直線に
      const pts: [number, number][] = [];
      const ctr = (c: number): [number, number] => [((c % n) + 0.5) * CELL, (((c / n) | 0) + 0.5) * CELL];
      const e = cells[0], ex = e % n, ey = (e / n) | 0;
      const ox = ex === 0 ? -1 : ex === n - 1 ? 1 : 0, oy = ey === 0 ? -1 : ey === n - 1 ? 1 : 0;
      pts.push([(ex + 0.5 + ox * 25) * CELL, (ey + 0.5 + oy * 25) * CELL]);
      let cur = ctr(cells[0]);
      pts.push(cur);
      let i = 0;
      while (i < cells.length - 1) {
        let j = cells.length - 1;
        while (j > i + 1 && !lineOk(m, cur[0], cur[1], ...ctr(cells[j]))) j--;
        cur = ctr(cells[j]);
        pts.push(cur);
        i = j;
      }
      // 最後のマスの中心から P へ（見通しがきくなら、手前のマスから直接 P へ）
      while (pts.length > 2 && lineOk(m, pts[pts.length - 2][0], pts[pts.length - 2][1], P[0], P[1])) pts.pop();
      if (lead) pts.push(P, S);
      else {
        // 沖の点へまっすぐ入ってくる（向きは、そこでタグボートが回す）
        while (pts.length > 2 && lineOk(wm, pts[pts.length - 2][0], pts[pts.length - 2][1], S[0], S[1])) pts.pop();
        pts.push(S);
      }
      let L = 0;
      for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      let hd = Math.atan2(sg * axis[0], sg * axis[1]), align = 0;
      if (!lead) {
        const A = pts[pts.length - 2], h0 = Math.atan2(S[0] - A[0], S[1] - A[1]);
        const d1 = wrap(hd - h0), d2 = wrap(hd + Math.PI - h0);
        if (Math.abs(d2) < Math.abs(d1)) { hd = wrap(hd + Math.PI); align = d2; } else align = d1;
      }
      if (!best || L < best.len) best = { pts, hd, align, len: L };
    }
    if (!best) continue;
    const dense = roundCorners(best.pts, spec.len * 0.9, (x, z) => okAt(wm, x, z));
    const px = new Float32Array(dense.length), pz = new Float32Array(dense.length), acc = new Float32Array(dense.length);
    dense.forEach(([x, z], k) => { px[k] = x; pz[k] = z; if (k) acc[k] = acc[k - 1] + Math.hypot(x - px[k - 1], z - pz[k - 1]); });
    const route: ShipRoute = { px, pz, acc, hd: best.hd, align: best.align, pivot: 0 };
    route.pivot = findPivot(route, spec, wet, CELL);
    return route;
  }
  return null;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// マス p から、通れるマス（m）だけを通ってマップの端までの最短のマスの列（端 → p の順）
function bfsToEdge(n: number, m: Uint8Array, p: readonly [number, number]): number[] | null {
  const [px, py] = p;
  if (px < 0 || py < 0 || px >= n || py >= n || !m[py * n + px]) return null;
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const prev = new Int32Array(n * n).fill(-2);
  const s = py * n + px;
  prev[s] = -1;
  const q = [s];
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = c % n, y = (c / n) | 0;
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) {
      const out: number[] = [];
      for (let k = c; k >= 0; k = prev[k]) out.push(k);
      return out;
    }
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (prev[j] !== -2 || !m[j]) continue;
      if (d & 1 && (!m[y * n + nx] || !m[ny * n + x])) continue;
      prev[j] = c;
      q.push(j);
    }
  }
  return null;
}

// 折れ線の角を 2 次ベジェ曲線で丸め、約 8m ごとの点にする。曲線が陸にかかるときは丸めを小さくする
function roundCorners(pts: [number, number][], R: number, ok: (x: number, z: number) => boolean) {
  const out: [number, number][] = [pts[0]];
  const seg = (a: [number, number], b: [number, number], step = 8) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(L / step));
    for (let i = 1; i <= k; i++) out.push([a[0] + ((b[0] - a[0]) * i) / k, a[1] + ((b[1] - a[1]) * i) / k]);
  };
  let from = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1], V = pts[i], B = pts[i + 1];
    const la = Math.hypot(V[0] - A[0], V[1] - A[1]), lb = Math.hypot(B[0] - V[0], B[1] - V[1]);
    // 最後の直線（P → S）は丸めない
    const lastStraight = i === pts.length - 2;
    let d = Math.min(R, la * 0.5, lastStraight ? 0 : lb * 0.5);
    let curve: [number, number][] = [];
    while (d > 4) {
      const p0: [number, number] = [V[0] - ((V[0] - A[0]) / la) * d, V[1] - ((V[1] - A[1]) / la) * d];
      const p2: [number, number] = [V[0] + ((B[0] - V[0]) / lb) * d, V[1] + ((B[1] - V[1]) / lb) * d];
      const k = Math.max(4, Math.ceil(d / 6));
      curve = [];
      let good = true;
      for (let j = 0; j <= k; j++) {
        const u = j / k, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
        const p: [number, number] = [a * p0[0] + b * V[0] + c * p2[0], a * p0[1] + b * V[1] + c * p2[1]];
        if (!ok(p[0], p[1])) { good = false; break; }
        curve.push(p);
      }
      if (good) break;
      d *= 0.5;
      curve = [];
    }
    if (curve.length) {
      seg(from, curve[0]);
      for (let j = 1; j < curve.length; j++) out.push(curve[j]);
      from = curve[curve.length - 1];
    } else {
      seg(from, V);
      from = V;
    }
  }
  seg(from, pts[pts.length - 1]);
  return out;
}

// 航路上の距離 d の位置（両端の外は端の向きにのばす）
export function routeAt(r: ShipRoute, d: number): [number, number] {
  const m = r.acc.length, L = r.acc[m - 1];
  if (d <= 0) {
    const l = r.acc[1] || 1;
    return [r.px[0] + ((r.px[1] - r.px[0]) / l) * d, r.pz[0] + ((r.pz[1] - r.pz[0]) / l) * d];
  }
  if (d >= L) {
    const l = L - r.acc[m - 2] || 1;
    return [r.px[m - 1] + ((r.px[m - 1] - r.px[m - 2]) / l) * (d - L), r.pz[m - 1] + ((r.pz[m - 1] - r.pz[m - 2]) / l) * (d - L)];
  }
  let lo = 0, hi = m - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (r.acc[mid] < d) lo = mid; else hi = mid; }
  const u = (d - r.acc[lo]) / (r.acc[hi] - r.acc[lo] || 1);
  return [r.px[lo] + (r.px[hi] - r.px[lo]) * u, r.pz[lo] + (r.pz[hi] - r.pz[lo]) * u];
}

// 船首と船尾を航路にのせたときの向き
export function routeHeading(r: ShipRoute, d: number, len: number): number {
  const [ax, az] = routeAt(r, d - len * 0.4), [bx, bz] = routeAt(r, d + len * 0.4);
  return Math.atan2(bx - ax, bz - az);
}

// 向きを変える場所：接岸位置の沖から外洋の方へさかのぼって、船が回れる広さのある最初の点。
// どこにもなければ、いちばん広いところ
function findPivot(r: ShipRoute, spec: ShipSpec, wet: (x: number, y: number) => boolean, CELL: number) {
  const L = r.acc[r.acc.length - 1];
  const need = spec.len / 2 + 10;
  const freeR = (x: number, z: number) => {
    const R = Math.ceil(need / CELL) + 1;
    const cx = x / CELL, cz = z / CELL;
    let best = need;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const gx = Math.floor(cx) + dx, gy = Math.floor(cz) + dy;
      if (wet(gx, gy)) continue;
      // マスのいちばん近い点までの距離
      const nx = Math.max(gx, Math.min(cx, gx + 1)), ny = Math.max(gy, Math.min(cz, gy + 1));
      best = Math.min(best, Math.hypot(nx - cx, ny - cz) * CELL);
    }
    return best;
  };
  let bestD = L, bestR = -1;
  for (let back = 0; back <= L; back += 16) {
    const d = L - back;
    const [x, z] = routeAt(r, d);
    const f = freeR(x, z);
    if (f >= need) return d;
    if (f > bestR) { bestR = f; bestD = d; }
  }
  return bestD;
}

// ---- 動き ----
export const SHIP_T = { slideIn: 50, dock: 110, slideOut: 38, rotate: 70, away: 50 };

export interface ShipPose {
  x: number; z: number; hd: number;
  phase: 'in' | 'align' | 'slideIn' | 'dock' | 'slideOut' | 'astern' | 'rotate' | 'out' | 'away';
  u: number; // その段階の進み具合（0〜1）
  speed: number; // 前に進む速さ（航跡の強さ）
}

// 入港の最後の減速区間と時間
function arrival(r: ShipRoute, spec: ShipSpec) {
  const L = r.acc[r.acc.length - 1];
  const dec = Math.min(450, L * 0.6);
  const tCruise = (L - dec) / spec.speed, tDec = (2 * dec) / spec.speed;
  return { L, dec, tCruise, tDec, total: tCruise + tDec };
}
function astern(r: ShipRoute, spec: ShipSpec) {
  const L = r.acc[r.acc.length - 1], dist = Math.max(0, L - r.pivot);
  const v = spec.speed * 0.3;
  return { dist, t: dist > 1 ? (2 * dist) / v : 0 };
}
const alignT = (r: ShipRoute) => (r.align ? 15 + (Math.abs(r.align) / Math.PI) * 60 : 0);
export function shipCycle(r: ShipRoute, spec: ShipSpec) {
  const a = arrival(r, spec), b = astern(r, spec);
  const al = alignT(r);
  const tOut = 15 + (r.pivot + spec.len * 2) / spec.speed;
  return a.total + al + SHIP_T.slideIn + SHIP_T.dock + SHIP_T.slideOut + b.t + SHIP_T.rotate + tOut + SHIP_T.away;
}

// t：周期の中の時刻。S → 接岸位置への動きは berth（接岸位置）を使う
export function shipPose(r: ShipRoute, spec: ShipSpec, berth: [number, number], t: number): ShipPose {
  const ease = (u: number) => u * u * (3 - 2 * u);
  const a = arrival(r, spec);
  const S: [number, number] = [r.px[r.px.length - 1], r.pz[r.pz.length - 1]];
  if (t < a.total) {
    let d: number, v: number;
    if (t < a.tCruise) { d = t * spec.speed; v = spec.speed; }
    else {
      const tau = t - a.tCruise;
      d = a.L - a.dec + spec.speed * tau - (spec.speed * spec.speed * tau * tau) / (4 * a.dec);
      v = Math.max(0, spec.speed - (spec.speed * spec.speed * tau) / (2 * a.dec));
    }
    const [x, z] = routeAt(r, d);
    return { x, z, hd: routeHeading(r, d, spec.len), phase: 'in', u: t / a.total, speed: v };
  }
  t -= a.total;
  const al = alignT(r);
  if (t < al) {
    const u = ease(t / al);
    return { x: S[0], z: S[1], hd: r.hd - r.align * (1 - u), phase: 'align', u: t / al, speed: 0 };
  }
  t -= al;
  if (t < SHIP_T.slideIn) {
    const u = ease(t / SHIP_T.slideIn);
    return { x: S[0] + (berth[0] - S[0]) * u, z: S[1] + (berth[1] - S[1]) * u, hd: r.hd, phase: 'slideIn', u: t / SHIP_T.slideIn, speed: 0 };
  }
  t -= SHIP_T.slideIn;
  if (t < SHIP_T.dock) return { x: berth[0], z: berth[1], hd: r.hd, phase: 'dock', u: t / SHIP_T.dock, speed: 0 };
  t -= SHIP_T.dock;
  if (t < SHIP_T.slideOut) {
    const u = ease(t / SHIP_T.slideOut);
    return { x: berth[0] + (S[0] - berth[0]) * u, z: berth[1] + (S[1] - berth[1]) * u, hd: r.hd, phase: 'slideOut', u: t / SHIP_T.slideOut, speed: 0 };
  }
  t -= SHIP_T.slideOut;
  const b = astern(r, spec);
  if (t < b.t) {
    // ゆっくり加速して、ゆっくり止まる後進
    const u = ease(t / b.t), d = a.L - b.dist * u;
    const [x, z] = routeAt(r, d);
    return { x, z, hd: routeHeading(r, d, spec.len), phase: 'astern', u: t / b.t, speed: 0 };
  }
  t -= b.t;
  const hp = routeHeading(r, r.pivot, spec.len);
  const [qx, qz] = routeAt(r, r.pivot);
  if (t < SHIP_T.rotate) {
    const u = ease(t / SHIP_T.rotate);
    return { x: qx, z: qz, hd: hp + Math.PI * u, phase: 'rotate', u: t / SHIP_T.rotate, speed: 0 };
  }
  t -= SHIP_T.rotate;
  // 外洋へ：最初の 30 秒でゆっくり加速
  const acc = 30, v = spec.speed;
  const dist = t < acc ? (v * t * t) / (2 * acc) : (v * acc) / 2 + v * (t - acc);
  if (dist < r.pivot + spec.len * 2) {
    const d = r.pivot - dist;
    const [x, z] = routeAt(r, d);
    return { x, z, hd: routeHeading(r, d, spec.len) + Math.PI, phase: 'out', u: dist / (r.pivot + spec.len * 2), speed: t < acc ? (v * t) / acc : v };
  }
  return { x: 0, z: 0, hd: 0, phase: 'away', u: 0, speed: 0 };
}
