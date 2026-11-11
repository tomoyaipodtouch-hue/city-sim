// 学校・大学・市役所（ヨーロッパの現代建築風）。建物の種（seed）で形の種類を選ぶ（となりどうしで違う形になる）
// 敷地の座標：x は横、z は奥行き（+z が正面＝道路側）、y は高さ（地面 = 0）
import * as THREE from 'three';
import { PAT } from './builder';
import type { MeshBuilder } from './builder';
import { MAT } from './textures';
import { Rng } from '../sim/rng';
import type { LotFrame, TF } from './buildingGen';

const C = (h: number) => new THREE.Color(h);
type P2 = [number, number];

// ---- 色 ----
const GLASS = C(0x4c6b86), GLASS_D = C(0x33465a), GLASS_L = C(0x86a9c0);
const WHITE = C(0xf2f1ec), WHITE2 = C(0xdedcd5), ROOF = C(0xb7b4ac);
const PAVE = C(0xc9c4b8), PAVE2 = C(0xb3ada1), YARD = C(0x9a978f), LAWN = C(0x7aa553), LAWN_D = C(0x6e9a4a);
const LINE = C(0xf4f4f0), DARK = C(0x3a3d41), STEEL = C(0x8d939a), WATER = C(0x3b6c86);
const PV = C(0x22324e);

// ---- 面の部品 ----
// 長方形の4つの面（外から見て左から右へ t が増える）。P(t, o) = 面の上の点 [x, z]（o は外への距離）
interface Side { L: number; P: (t: number, o: number) => P2 }
function sides(x0: number, z0: number, x1: number, z1: number): Side[] {
  return [
    { L: x1 - x0, P: (t, o) => [x0 + t, z1 + o] }, // 正面 +z
    { L: z1 - z0, P: (t, o) => [x1 + o, z1 - t] }, // +x
    { L: x1 - x0, P: (t, o) => [x1 - t, z0 - o] }, // 奥 -z
    { L: z1 - z0, P: (t, o) => [x0 - o, z0 + t] }, // -x
  ];
}
// 面に貼る四角（窓・板など）
function fq(mb: MeshBuilder, s: Side, t0: number, t1: number, y0: number, y1: number, o: number, col: THREE.Color, pat = 0) {
  const a = s.P(t0, o), b = s.P(t1, o);
  mb.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], col, pat, t1 - t0, y1 - y0, t0, y0);
}
// 面から外へ出るひれ（前と左右の3面。上は屋根のひさしで隠す）
function fin(mb: MeshBuilder, s: Side, t: number, w: number, dep: number, y0: number, y1: number, col: THREE.Color, side = col) {
  fq(mb, s, t - w / 2, t + w / 2, y0, y1, dep, col);
  const a0 = s.P(t - w / 2, 0), a1 = s.P(t - w / 2, dep), b0 = s.P(t + w / 2, 0), b1 = s.P(t + w / 2, dep);
  mb.quad([a0[0], y0, a0[1]], [a1[0], y0, a1[1]], [a1[0], y1, a1[1]], [a0[0], y1, a0[1]], side);
  mb.quad([b1[0], y0, b1[1]], [b0[0], y0, b0[1]], [b0[0], y1, b0[1]], [b1[0], y1, b1[1]], side);
}
// 面の上の自由な形（(t, y) の反時計回りの4点）
function fpoly(mb: MeshBuilder, s: Side, pts: P2[], o: number, col: THREE.Color, pat = 0) {
  const q = pts.map(([t, y]) => { const p = s.P(t, o); return [p[0], y, p[1]] as [number, number, number]; });
  mb.quad(q[0], q[1], q[2], q[3], col, pat);
}
// 面の上の円（時計の文字盤など）
function fdisc(mb: MeshBuilder, s: Side, t: number, y: number, r: number, o: number, col: THREE.Color, pat = 0, n = 18) {
  const c = s.P(t, o);
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
    const p0 = s.P(t + Math.cos(a0) * r, o), p1 = s.P(t + Math.cos(a1) * r, o);
    mb.tri([c[0], y, c[1]], [p0[0], y + Math.sin(a0) * r, p0[1]], [p1[0], y + Math.sin(a1) * r, p1[1]], col, pat);
  }
}
// 平らな屋根のスラブ（ふちの色と上の色）
function slab(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, t: number, ov: number, edge: THREE.Color, top: THREE.Color) {
  mb.box(x0 - ov, y, z0 - ov, x1 + ov, y + t, z1 + ov, edge, PAT.none, top);
}
// 建物をぐるりと巻く帯（窓の帯など）。上の面は建物の中に隠れる
function wrap(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, col: THREE.Color, pat: number, out = 0.06) {
  mb.box(x0 - out, y0, z0 - out, x1 + out, y1, z1 + out, col, pat, col);
}
// 素材を決めて箱を描く
function matBox(mb: MeshBuilder, mat: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: THREE.Color, pat = 0) {
  const keep = mb.matOverride;
  mb.matOverride = mat;
  mb.box(x0, y0, z0, x1, y1, z1, col, pat, col);
  mb.matOverride = keep;
}
// 屋上の太陽光パネル（南向きに少し傾けた列）
function pvRows(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number) {
  for (let z = z0 + 0.6; z + 1.8 < z1; z += 2.6) {
    mb.quad([x0, y + 0.3, z + 1.8], [x1, y + 0.3, z + 1.8], [x1, y + 1.0, z], [x0, y + 1.0, z], PV);
    mb.quad([x0, y + 1.0, z], [x1, y + 1.0, z], [x1, y + 0.3, z], [x0, y + 0.3, z], DARK);
  }
}
// 緑の屋根（セダム）：砂利のふちの内側に緑の面、小さな天窓
const SEDUM = C(0x7f9455), GRAVEL = C(0xa9a69e);
function greenRoof(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, sky = true) {
  mb.ground(x0 + 1, z0 + 1, x1 - 1, z1 - 1, y + 0.03, GRAVEL);
  mb.ground(x0 + 1.8, z0 + 1.8, x1 - 1.8, z1 - 1.8, y + 0.06, SEDUM);
  if (sky) for (let x = x0 + 4; x + 2 < x1 - 3; x += 7) mb.box(x, y, (z0 + z1) / 2 - 1, x + 2, y + 0.5, (z0 + z1) / 2 + 1, WHITE2, PAT.none, GLASS_L);
}
// 切妻屋根（棟は x か z の向き）。妻の三角は gableCol
function gable(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number, rise: number, roof: THREE.Color, gableCol: THREE.Color, alongX: boolean, ov = 0.6) {
  if (alongX) {
    mb.gableX(x0, z0, x1, z1, y, rise, roof, gableCol, ov);
    // 軒先の厚み
    const drop = (rise * ov) / ((z1 - z0) / 2);
    mb.box(x0 - ov, y - drop - 0.25, z1 + ov - 0.12, x1 + ov, y - drop, z1 + ov, WHITE2);
    mb.box(x0 - ov, y - drop - 0.25, z0 - ov, x1 + ov, y - drop, z0 - ov + 0.12, WHITE2);
    return;
  }
  const xm = (x0 + x1) / 2, yt = y + rise, drop = (rise * ov) / ((x1 - x0) / 2);
  const X0 = x0 - ov, X1 = x1 + ov, Z0 = z0 - ov, Z1 = z1 + ov, yd = y - drop;
  mb.quad([X0, yd, Z0], [X0, yd, Z1], [xm, yt, Z1], [xm, yt, Z0], roof);
  mb.quad([X1, yd, Z1], [X1, yd, Z0], [xm, yt, Z0], [xm, yt, Z1], roof);
  mb.tri([x0, y, z1], [x1, y, z1], [xm, yt, z1], gableCol);
  mb.tri([x1, y, z0], [x0, y, z0], [xm, yt, z0], gableCol);
  mb.box(X0, yd - 0.25, Z0, X0 + 0.12, yd, Z1, WHITE2);
  mb.box(X1 - 0.12, yd - 0.25, Z0, X1, yd, Z1, WHITE2);
}

// ---- 外構の部品 ----
// 運動場のコート（x 向き、長さ L、幅 w）。まわりの帯、白線、センターサークル、ゴールエリア
function court(mb: MeshBuilder, cx: number, cz: number, L: number, w: number, col: THREE.Color, rim: THREE.Color, hoops = true) {
  mb.ground(cx - L / 2 - 1.5, cz - w / 2 - 1.5, cx + L / 2 + 1.5, cz + w / 2 + 1.5, 0.1, rim);
  mb.ground(cx - L / 2, cz - w / 2, cx + L / 2, cz + w / 2, 0.11, col);
  const y = 0.12, lw = 0.14;
  const ln = (x0: number, z0: number, x1: number, z1: number) => mb.ground(x0, z0, x1, z1, y, LINE);
  ln(cx - L / 2, cz - w / 2, cx + L / 2, cz - w / 2 + lw);
  ln(cx - L / 2, cz + w / 2 - lw, cx + L / 2, cz + w / 2);
  ln(cx - L / 2, cz - w / 2, cx - L / 2 + lw, cz + w / 2);
  ln(cx + L / 2 - lw, cz - w / 2, cx + L / 2, cz + w / 2);
  ln(cx - lw / 2, cz - w / 2, cx + lw / 2, cz + w / 2);
  const arc = (ox: number, r: number, a0: number, a1: number, n: number) => {
    for (let k = 0; k < n; k++) {
      const b0 = a0 + ((a1 - a0) * k) / n, b1 = a0 + ((a1 - a0) * (k + 1)) / n;
      const p = (a: number, rr: number): [number, number, number] => [ox + Math.cos(a) * rr, y, cz + Math.sin(a) * rr];
      mb.quad(p(b0, r), p(b1, r), p(b1, r - lw), p(b0, r - lw), LINE);
    }
  };
  // quad の向き（上向き）をそろえるため、角度は減る向きに回す
  arc(cx, Math.min(2.2, w * 0.2), Math.PI * 2, 0, 16);
  const r = Math.min(w * 0.36, L * 0.18);
  arc(cx - L / 2, r, Math.PI / 2, -Math.PI / 2, 10);
  arc(cx + L / 2, r, Math.PI * 1.5, Math.PI / 2, 10);
  if (hoops) for (const s of [-1, 1]) {
    const x = cx + s * (L / 2 + 0.6);
    mb.box(x - 0.08, 0, cz - 0.08, x + 0.08, 3.2, cz + 0.08, STEEL);
    mb.box(x - (s > 0 ? 0.3 : -0.2) - 0.05, 2.7, cz - 0.9, x - (s > 0 ? 0.3 : -0.2) + 0.05, 3.8, cz + 0.9, LINE);
  }
}
// 自転車置き場（屋根と自転車）。x 向き
function bikeShelter(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number) {
  for (const x of [x0 + 0.3, x1 - 0.3]) for (const z of [z0 + 0.3]) mb.box(x - 0.07, 0, z - 0.07, x + 0.07, 2.3, z + 0.07, STEEL);
  mb.box(x0, 2.3, z0, x1, 2.45, z1, C(0xd8dcdf), PAT.none, C(0x6f8f4e));
  const bike = C(0x2b2f35), bc = [C(0x2f6fb0), C(0xc0392b), C(0x2b2f35), C(0x3f7d4a), C(0xd8d8d8)];
  let k = 0;
  for (let x = x0 + 0.6; x < x1 - 0.4; x += 0.75, k++) {
    mb.box(x - 0.03, 0.15, z0 + 0.4, x + 0.03, 1.0, z1 - 0.3, bc[k % bc.length]);
    mb.box(x - 0.05, 0, z0 + 0.4, x + 0.05, 0.15, z1 - 0.3, bike);
  }
}
// 植え込みのベンチ（低い箱）
function bench(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number) {
  mb.box(x0, 0, z0, x1, 0.45, z1, C(0xa88458), PAT.none, C(0xb8946a));
}
// 街灯（夜は頭が光る）
function lamp(mb: MeshBuilder, x: number, z: number, h = 4.5) {
  mb.box(x - 0.06, 0, z - 0.06, x + 0.06, h, z + 0.06, DARK);
  mb.box(x - 0.18, h, z - 0.18, x + 0.18, h + 0.3, z + 0.18, C(0xfff2d0), PAT.lit, DARK);
}
// 入口のひさし（薄い板と2本の細い柱、下面は夜に光る）
function entryCanopy(mb: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number, col = WHITE) {
  mb.box(x0, y, z0, x1, y + 0.35, z1, col, PAT.none, WHITE2);
  mb.quad([x0 + 0.3, y - 0.01, z0 + 0.3], [x1 - 0.3, y - 0.01, z0 + 0.3], [x1 - 0.3, y - 0.01, z1 - 0.3], [x0 + 0.3, y - 0.01, z1 - 0.3], C(0xfff1d6), PAT.lit);
  for (const x of [x0 + 0.4, x1 - 0.4]) mb.box(x - 0.09, 0, z1 - 0.5, x + 0.09, y, z1 - 0.32, STEEL);
}
// 校舎の前の舗装と植え込み
function forecourt(mb: MeshBuilder, tf: TF, x0: number, z0: number, x1: number, z1: number, rng: Rng) {
  mb.ground(x0, z0, x1, z1, 0.09, PAVE);
  const n = Math.max(2, Math.round((x1 - x0) / 12));
  for (let k = 0; k < n; k++) {
    const x = x0 + ((k + 0.5) * (x1 - x0)) / n;
    if (Math.abs(x) < 6) continue;
    mb.box(x - 1.6, 0, z1 - 2.4, x + 1.6, 0.45, z1 - 0.8, C(0xc2bdb2), PAT.none, LAWN_D);
    tf(x, z1 - 1.6, 0.6 + rng.next() * 0.25);
  }
}

// ================= 学校 =================
// 3 種類：A = 明るいレンガと横長の窓の帯（ケルン・リントヴァイラー）、B = コンクリートの基壇と縦張りのカラマツ・切妻（オーストリア・アウ）、
// C = 縦の木のルーバーで包んだ箱（ルクセンブルク・エテルブリュック）。高校（3×3）は大きく、体育館の棟がつく
export function eduSchool(mb: MeshBuilder, f: LotFrame, tf: TF, high: boolean, seed: number) {
  mb.flatRoofMat = MAT.membrane;
  const v = (seed >>> 7) % 3;
  const rng = new Rng(seed ^ 0x5c1001);
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, LAWN);
  if (v === 0) schoolBrick(mb, f, tf, high, rng);
  else if (v === 1) schoolTimberGable(mb, f, tf, high, rng);
  else schoolSlats(mb, f, tf, high, rng);
}

const COURT_COLS: [THREE.Color, THREE.Color][] = [
  [C(0x3f7d5a), C(0xb4573f)],
  [C(0x2f6d9e), C(0x3f7d5a)],
  [C(0x4f8a4a), C(0x8f8d88)],
];
const schoolCourt = (mb: MeshBuilder, rng: Rng, cx: number, cz: number, L: number, w: number) => {
  const [c, r] = COURT_COLS[rng.int(COURT_COLS.length)];
  court(mb, cx, cz, L, w, c, r);
};

// A：明るいレンガ（クリーム色）、各階の横長の窓の帯（木とアルミの枠）、薄くシャープな平屋根
const BRICK_CREAM = [0xdccaa6, 0xd6c29c, 0xe1d2b4].map(C);
function brickVol(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, floors: number, ff: number, brick: THREE.Color, opt: { clere?: boolean; pv?: boolean } = {}) {
  const h = floors * ff;
  matBox(mb, MAT.brick, x0, 0, z0, x1, h, z1, brick);
  const frame = C(0x9b7553);
  if (opt.clere) {
    // 体育館：高い位置の窓の帯、屋根に細長い天窓
    for (let x = x0 + 3; x + 1.6 < x1 - 2; x += 4.5) mb.box(x, h + 0.32, z0 + 2.5, x + 1.6, h + 0.9, z1 - 2.5, WHITE2, PAT.none, GLASS_L);
    wrap(mb, x0, z0, x1, z1, h - 2.4, h - 0.7, GLASS, PAT.fullglass);
    wrap(mb, x0, z0, x1, z1, h - 2.55, h - 2.4, frame, PAT.none, 0.1);
  } else for (let i = 0; i < floors; i++) {
    const y0 = i * ff + 0.95, y1 = i * ff + ff - 0.6;
    wrap(mb, x0, z0, x1, z1, y0, y1, GLASS, PAT.fullglass);
    // 木の窓台と、窓の上の細いアルミの水切り
    wrap(mb, x0, z0, x1, z1, y0 - 0.16, y0, frame, PAT.none, 0.1);
    wrap(mb, x0, z0, x1, z1, y1, y1 + 0.1, C(0xc9cdd0), PAT.none, 0.09);
  }
  // 屋根：薄い笠木（明るい金属）
  slab(mb, x0, z0, x1, z1, h, 0.32, 0.12, C(0xd9d8d3), ROOF);
  if (opt.pv && x1 - x0 > 12) pvRows(mb, x0 + 2, z0 + 1.5, x1 - 2, z1 - 1.5, h + 0.32);
  return h;
}
function schoolBrick(mb: MeshBuilder, f: LotFrame, tf: TF, high: boolean, rng: Rng) {
  const hw = f.W / 2, hd = f.D / 2, ff = 3.8;
  const brick = BRICK_CREAM[rng.int(BRICK_CREAM.length)];
  if (!high) {
    // 2階建ての横長の教室棟（正面）と、奥へのびる体育館の棟（L字）。後ろに校庭
    const mz0 = -2, mz1 = 9;
    forecourt(mb, tf, -hw + 1, mz1, hw - 1, hd - 0.4, rng);
    brickVol(mb, -hw + 3, mz0, 10, mz1, 2, ff, brick, { pv: true });
    brickVol(mb, 10, -hd + 3, hw - 2.5, mz1 - 1, 1, 7.2, brick, { clere: true });
    // 入口：ガラスの出っ張りとひさし
    mb.box(-5, 0, mz1 - 0.2, 3, 3.6, mz1 + 0.5, GLASS, PAT.fullglass, WHITE2);
    entryCanopy(mb, -7, 5, mz1, mz1 + 4, 3.7);
    mb.ground(-hw + 2.5, -hd + 2.5, 8.5, mz0 - 1, 0.09, YARD);
    schoolCourt(mb, rng, -6, -9.2, 18, 8.5);
    bikeShelter(mb, -hw + 3, mz1 + 1.2, -hw + 10, mz1 + 3.6);
    tf(-hw + 2, -hd + 2, 1.0); tf(-hw + 1.8, 0, 0.9); tf(hw - 1.2, hd - 1.6, 0.7);
  } else {
    // 3階建て：正面の教室棟、左の棟、奥の体育館がまんなかの中庭を囲む（シュトゥットガルト・シュタムハイムのクラスター）
    const mz0 = 4, mz1 = 15;
    forecourt(mb, tf, -hw + 1, mz1, hw - 1, hd - 0.4, rng);
    brickVol(mb, -hw + 3, mz0, hw - 3, mz1, 3, ff, brick, { pv: true });
    brickVol(mb, -hw + 3, -9, -10, mz0, 3, ff, brick);
    brickVol(mb, 1, -hd + 3, hw - 3, -6, 1, 8.4, brick, { clere: true });
    // 体育館と校舎をつなぐガラスの廊下
    mb.box(13, 0, -6, 19, 4, mz0, GLASS, PAT.fullglass, ROOF);
    slab(mb, 13, -6, 19, mz0, 4, 0.3, 0.2, WHITE2, ROOF);
    // 中庭：芝と木
    mb.ground(-10, -6, 13, mz0, 0.09, LAWN_D);
    mb.ground(-10, -1.2, 13, 0.6, 0.1, PAVE2);
    tf(-5, -3.5, 0.9); tf(3, 2.4, 0.8); tf(8, -3.8, 0.85);
    mb.box(-6, 0, mz1 - 0.2, 6, 3.6, mz1 + 0.5, GLASS, PAT.fullglass, WHITE2);
    entryCanopy(mb, -8, 8, mz1, mz1 + 4.5, 3.8);
    mb.ground(-hw + 2.5, -hd + 2.5, -1, -10, 0.09, YARD);
    schoolCourt(mb, rng, -12.3, -17, 18, 8.5);
    bikeShelter(mb, hw - 11, mz1 + 1.2, hw - 3, mz1 + 3.6);
    tf(-hw + 1.8, -hd + 2, 1.0); tf(-hw + 1.8, -10.5, 0.9); tf(hw - 1.8, -2, 0.9);
  }
}

// B：コンクリートの基壇（1階）と、縦張りのカラマツの上階、緩い切妻の金属屋根
const LARCH = [0xa9835a, 0xb48d62, 0x9c7b58].map(C);
function timberBar(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, upper: number, rng: Rng, roofCol: THREE.Color, flat = false) {
  const wood = LARCH[rng.int(LARCH.length)], batten = wood.clone().multiplyScalar(0.82);
  const conc = C(0xbcb8af), pH = 3.9, fh = 3.4, h = pH + upper * fh;
  // 基壇：打ち放しコンクリートと大きな窓
  matBox(mb, MAT.concrete, x0, 0, z0, x1, pH, z1, conc);
  const S = sides(x0, z0, x1, z1);
  for (const s of S) {
    const n = Math.max(1, Math.floor(s.L / 5));
    const step = s.L / n;
    for (let k = 0; k < n; k++) fq(mb, s, k * step + 0.8, (k + 1) * step - 0.8, 0.6, pH - 0.5, 0.04, GLASS, PAT.fullglass);
  }
  // 上階：カラマツの縦張り（細い目板）と縦長の窓
  mb.box(x0 - 0.1, pH, z0 - 0.1, x1 + 0.1, h, z1 + 0.1, wood, PAT.none, wood);
  for (const s of S) {
    for (let t = 0.5; t < s.L - 0.2; t += 0.8) fq(mb, s, t, t + 0.12, pH, h, 0.14, batten);
    const n = Math.max(1, Math.floor(s.L / 3.6));
    const step = s.L / n;
    for (let i = 0; i < upper; i++)
      for (let k = 0; k < n; k++) {
        const t0 = k * step + (step - 1.6) / 2;
        fq(mb, s, t0, t0 + 1.6, pH + i * fh + 0.7, pH + i * fh + 3.0, 0.17, GLASS_D, PAT.fullglass);
      }
  }
  if (flat) slab(mb, x0, z0, x1, z1, h, 0.35, 0.5, WHITE2, ROOF);
  else gable(mb, x0 - 0.15, z0 - 0.15, x1 + 0.15, z1 + 0.15, h, Math.min(3.2, (z1 - z0) * 0.27), roofCol, wood, true, 0.7);
  return h;
}
function schoolTimberGable(mb: MeshBuilder, f: LotFrame, tf: TF, high: boolean, rng: Rng) {
  const hw = f.W / 2, hd = f.D / 2;
  const roof = rng.pick([C(0x5c6166), C(0x6e6a64), C(0x4e5358)]);
  if (!high) {
    const z0 = -1, z1 = 9;
    forecourt(mb, tf, -hw + 1, z1, hw - 1, hd - 0.4, rng);
    timberBar(mb, -hw + 3, z0, 13, z1, 1, rng, roof);
    // 体育館（低い平屋根の木の箱）
    timberBar(mb, 6, -hd + 2.5, hw - 2.5, -3.5, 0, rng, roof, true);
    entryCanopy(mb, -6, 2, z1, z1 + 3.6, 3.4, C(0xcfcac0));
    mb.ground(-hw + 2.5, -hd + 2.5, 4, z0 - 1.2, 0.09, YARD);
    schoolCourt(mb, rng, -8, -8.6, 18, 8.5);
    bikeShelter(mb, 5, z1 + 1.2, 13, z1 + 3.6);
    tf(-hw + 2, -hd + 2, 1.0, 1); tf(hw - 2, 4, 0.9); tf(-hw + 1.6, 3, 0.85, 1); tf(hw - 3, -hd + 1.8, 0.9);
  } else {
    // ずらした2本の切妻の棟と、ガラスの渡り廊下、木の体育館
    const z1 = 15;
    forecourt(mb, tf, -hw + 1, z1, hw - 1, hd - 0.4, rng);
    timberBar(mb, -hw + 3, 5, 10, z1, 2, rng, roof);
    timberBar(mb, -3, -10, hw - 3, 0, 2, rng, roof);
    mb.box(1, 0, 0, 7, 3.9, 5, GLASS, PAT.fullglass, ROOF);
    slab(mb, 1, 0, 7, 5, 3.9, 0.3, 0.3, WHITE2, ROOF);
    timberBar(mb, -hw + 3, -hd + 2.5, -6, -5, 1, rng, roof, true);
    entryCanopy(mb, -9, -1, z1, z1 + 3.8, 3.5, C(0xcfcac0));
    mb.ground(-4, -hd + 2.5, hw - 2.5, -12.5, 0.09, YARD);
    schoolCourt(mb, rng, 10, -18, 18, 8.5);
    mb.ground(-hw + 3, -3.5, -5, 4, 0.09, LAWN_D);
    tf(-14, 0, 0.9); tf(-8, -2, 0.8, 1); tf(15, 3, 0.9); tf(hw - 2, 10, 0.8, 1);
    bikeShelter(mb, 12, z1 + 1.2, 20, z1 + 3.6);
  }
}

// C：縦の木のルーバー（トウヒ）で包んだ2〜3階の箱。1階は少し奥まったガラス
const SPRUCE = [0xd6b98c, 0xcdb084, 0xdcc49c].map(C);
function slatBox(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, floors: number, rng: Rng, opt: { gap?: [number, number]; skip?: number[] } = {}) {
  const ff = 3.7, h = floors * ff;
  const wood = SPRUCE[rng.int(SPRUCE.length)], side = wood.clone().multiplyScalar(0.8);
  // 中の壁：ガラスとスパンドレル。各階の床の帯（木の幕板）
  mb.box(x0, 0, z0, x1, h, z1, GLASS_D, PAT.curtain, ROOF);
  for (let i = 1; i < floors; i++) wrap(mb, x0, z0, x1, z1, i * ff - 0.25, i * ff + 0.25, side, PAT.none, 0.45);
  // ルーバー（正面の入口のところはあける）
  const S = sides(x0, z0, x1, z1);
  S.forEach((s, k) => {
    if (opt.skip?.includes(k)) return;
    for (let t = 0.35; t < s.L - 0.2; t += 0.75) {
      if (k === 0 && opt.gap && t > opt.gap[0] - x0 && t < opt.gap[1] - x0) continue;
      fin(mb, s, t, 0.16, 0.42, 0, h, wood, side);
    }
  });
  slab(mb, x0, z0, x1, z1, h, 0.45, 0.55, wood, ROOF);
  if (x1 - x0 > 7 && z1 - z0 > 7) greenRoof(mb, x0, z0, x1, z1, h + 0.45, false);
  return h;
}
function schoolSlats(mb: MeshBuilder, f: LotFrame, tf: TF, high: boolean, rng: Rng) {
  const hw = f.W / 2, hd = f.D / 2;
  if (!high) {
    const z0 = -3, z1 = 9;
    forecourt(mb, tf, -hw + 1, z1, hw - 1, hd - 0.4, rng);
    slatBox(mb, -hw + 3, z0, 12, z1, 2, rng, { gap: [-3, 3] });
    mb.box(-3, 0, z1, 3, 3.6, z1 + 0.3, GLASS, PAT.fullglass, WHITE2);
    entryCanopy(mb, -4, 4, z1, z1 + 3.2, 3.7, C(0xd6b98c));
    // 食堂（平屋のルーバーの箱）
    slatBox(mb, 12.5, -hd + 3, hw - 3, 4, 1, rng);
    mb.ground(-hw + 2.5, -hd + 2.5, 10.5, z0 - 1.2, 0.09, YARD);
    schoolCourt(mb, rng, -5, -10, 18, 8.5);
    bikeShelter(mb, 5, z1 + 1.2, 12, z1 + 3.6);
    tf(-hw + 2, -hd + 2, 1.0); tf(-hw + 1.6, -3.5, 0.8, 1); tf(hw - 1.8, 8, 0.9); tf(hw - 1.8, -hd + 1.6, 0.8);
  } else {
    // 中庭のまわりの4つの棟（中央にガラス屋根のホール）。奥に体育館と運動場
    const X0 = -hw + 3, X1 = hw - 3, Z0 = -8, Z1 = 15;
    forecourt(mb, tf, -hw + 1, Z1, hw - 1, hd - 0.4, rng);
    const g: [number, number] = [-3, 3];
    slatBox(mb, X0, Z1 - 9, X1, Z1, 3, rng, { gap: g });
    slatBox(mb, X0, Z0, X1, Z0 + 8, 3, rng);
    slatBox(mb, X0, Z0 + 8, X0 + 9, Z1 - 9, 3, rng, { skip: [0, 2] });
    slatBox(mb, X1 - 9, Z0 + 8, X1, Z1 - 9, 3, rng, { skip: [0, 2] });
    // 中央のホール（低いガラスの屋根）
    const ix0 = X0 + 9, ix1 = X1 - 9, iz0 = Z0 + 8, iz1 = Z1 - 9;
    mb.box(ix0, 0, iz0, ix1, 7.5, iz1, GLASS, PAT.fullglass, GLASS_L);
    for (let x = ix0 + 2; x < ix1; x += 2.5) mb.box(x - 0.08, 7.5, iz0, x + 0.08, 7.75, iz1, WHITE2);
    mb.box(-3, 0, Z1, 3, 3.6, Z1 + 0.3, GLASS, PAT.fullglass, WHITE2);
    entryCanopy(mb, -4, 4, Z1, Z1 + 3.4, 3.7, C(0xd6b98c));
    // 体育館
    slatBox(mb, 3, -hd + 2.5, X1, Z0 - 2.5, 2, rng);
    mb.ground(-hw + 2.5, -hd + 2.5, 1.5, Z0 - 1.5, 0.09, YARD);
    schoolCourt(mb, rng, -10.5, -17.5, 18, 8.5);
    bikeShelter(mb, 8, Z1 + 1.2, 16, Z1 + 3.6);
    tf(-hw + 1.8, -hd + 2, 0.9); tf(-hw + 1.8, Z0 + 2, 0.9, 1); tf(hw - 1.8, Z0 - 1.5, 0.9);
  }
}

// ================= 大学（4×4） =================
// 3 種類：A = 細い縦のひれの高い塔と広い基壇（ルクセンブルク・メゾン・デュ・サヴォワール）、
// B = 細い鉄骨と全面ガラスの開いたパビリオン（ブラウンシュヴァイク・スタディ・パビリオン）、C = 明るい低層の棟と大きなガラスの玄関ホール（北欧のキャンパス）
export function eduCollege(mb: MeshBuilder, f: LotFrame, tf: TF, seed: number) {
  mb.flatRoofMat = MAT.membrane;
  const v = (seed >>> 7) % 3;
  const rng = new Rng(seed ^ 0xc011e9e);
  const hw = f.W / 2, hd = f.D / 2;
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, LAWN);
  if (v === 0) collegeTower(mb, f, tf, rng);
  else if (v === 1) collegePavilion(mb, f, tf, rng);
  else collegeNordic(mb, f, tf, rng);
}

// キャンパスの広場：舗装、芝の区画、並木、ベンチ、街灯
function campusPlaza(mb: MeshBuilder, tf: TF, x0: number, z0: number, x1: number, z1: number, rng: Rng) {
  mb.ground(x0, z0, x1, z1, 0.09, PAVE);
  // 舗装の目地（細い線）
  for (let x = x0 + 6; x < x1 - 1; x += 6) mb.ground(x - 0.06, z0, x + 0.06, z1, 0.095, PAVE2);
  const n = Math.max(2, Math.floor((x1 - x0) / 11));
  for (let k = 0; k < n; k++) {
    const x = x0 + ((k + 0.5) * (x1 - x0)) / n;
    if (Math.abs(x) < 5) continue;
    const z = z1 - 3.5;
    mb.box(x - 2.2, 0, z - 1.5, x + 2.2, 0.4, z + 1.5, C(0xbdb7ab), PAT.none, LAWN_D);
    tf(x, z, 0.85 + rng.next() * 0.25);
    bench(mb, x - 2, z - 2.5, x + 2, z - 1.9);
  }
}

// A：広い基壇の上に、細い縦のひれで包んだ細長い塔
function collegeTower(mb: MeshBuilder, f: LotFrame, tf: TF, rng: Rng) {
  const hw = f.W / 2, hd = f.D / 2;
  const fins = C(0xeceae4), conc = C(0xd9d6cf);
  campusPlaza(mb, tf, -hw + 1, 7, hw - 1, hd - 0.4, rng);
  // 基壇（2層）：奥まったガラスの1階と、明るいコンクリートに横長の窓
  const px0 = -hw + 4, px1 = hw - 4, pz0 = -hd + 4, pz1 = 6, pH = 9.6;
  mb.box(px0 + 1.2, 0, pz0 + 1.2, px1 - 1.2, 4.6, pz1 - 1.2, GLASS, PAT.fullglass, ROOF);
  for (const s of sides(px0, pz0, px1, pz1)) for (let t = 0.6; t < s.L; t += 6.4) { const p = s.P(t, -0.6); mb.box(p[0] - 0.3, 0, p[1] - 0.3, p[0] + 0.3, 4.6, p[1] + 0.3, conc); }
  mb.box(px0, 4.6, pz0, px1, pH, pz1, conc, PAT.ribbon, conc);
  slab(mb, px0, pz0, px1, pz1, pH, 0.5, 0.25, WHITE, ROOF);
  // 基壇の屋上庭園
  mb.ground(px0 + 2, pz0 + 2, -9, pz1 - 2, pH + 0.52, LAWN_D);
  mb.ground(16, pz0 + 2, px1 - 2, pz1 - 2, pH + 0.52, LAWN_D);
  tf(-16, -8, 0.7, 0, pH + 0.5); tf(-22, -2, 0.6, 0, pH + 0.5); tf(21, -10, 0.65, 0, pH + 0.5);
  // 塔：細長い平面、ガラスの中身と、密な縦のひれ
  const tx0 = -6, tx1 = 12, tz0 = -18, tz1 = -6, tTop = 62;
  mb.box(tx0, pH + 0.5, tz0, tx1, tTop, tz1, GLASS, PAT.curtain, ROOF);
  for (const s of sides(tx0, tz0, tx1, tz1)) for (let t = 0.3; t < s.L - 0.1; t += 0.75) fin(mb, s, t, 0.16, 0.65, pH + 0.5, tTop + 2.4, fins, C(0xd2d0ca));
  slab(mb, tx0 + 0.3, tz0 + 0.3, tx1 - 0.3, tz1 - 0.3, tTop, 0.3, 0, ROOF, ROOF);
  // ひれの上端をそろえる薄い枠（頂部）
  wrap(mb, tx0, tz0, tx1, tz1, tTop + 2.4, tTop + 2.8, fins, PAT.none, 0.7);
  mb.box(tx0 + 3, tTop, tz0 + 3, tx1 - 3, tTop + 2.2, tz1 - 3, C(0xc9cdd2), PAT.industrial, C(0xb9bfc5));
  // 入口：大きなひさし
  entryCanopy(mb, -9, 9, pz1, pz1 + 5, 4.8);
  mb.ground(-4, hd - 1, 4, pz1, 0.1, PAVE2);
  // 広場の芝の区画と木立
  for (const sx of [-1, 1]) {
    const a = sx < 0 ? -hw + 3 : 9, b = sx < 0 ? -9 : hw - 3;
    mb.box(a, 0, 11, b, 0.35, 19, C(0xbdb7ab), PAT.none, LAWN_D);
    for (let x = a + 3; x < b - 1; x += 6.5) tf(x, 13.5 + ((x * 7) % 3), 0.8 + rng.next() * 0.3);
    bench(mb, a + 1, 19.4, b - 1, 20);
  }
  // 横の芝と木
  mb.ground(-hw + 1, -hd + 1, px0 - 0.3, pz1, 0.09, LAWN_D);
  for (let z = -hd + 4; z < pz1; z += 9) { tf(-hw + 2, z, 0.85 + rng.next() * 0.2); tf(hw - 2, z + 4, 0.85 + rng.next() * 0.2); }
  for (let x = -hw + 6; x < hw - 4; x += 10) lamp(mb, x, 7.6);
}

// B：細い鉄骨の柱と全面ガラス、薄い平屋根の2階建てのパビリオン（まわりは開いた広場）
function collegePavilion(mb: MeshBuilder, f: LotFrame, tf: TF, rng: Rng) {
  const hw = f.W / 2, hd = f.D / 2;
  const steel = C(0xe6e8ea), steelS = C(0xc4c8cc);
  // 広場（全体）と芝の区画
  mb.ground(-hw + 1, -8, hw - 1, hd - 0.4, 0.09, PAVE);
  for (let x = -hw + 5; x < hw - 1; x += 5) mb.ground(x - 0.05, -8, x + 0.05, hd - 0.4, 0.095, PAVE2);
  // 奥：既存の学部棟（白い4階建て、横長の窓）
  const bz0 = -hd + 3, bz1 = -12;
  mb.box(-hw + 4, 0, bz0, hw - 4, 15, bz1, WHITE, PAT.ribbon, ROOF);
  slab(mb, -hw + 4, bz0, hw - 4, bz1, 15, 0.5, 0.3, WHITE2, ROOF);
  mb.box(-6, 15.5, bz0 + 3, 6, 17.5, bz1 - 3, C(0xc9cdd2), PAT.industrial, C(0xb9bfc5));
  mb.ground(-hw + 1, bz1, hw - 1, -8, 0.09, LAWN_D);
  for (let x = -hw + 6; x < hw - 4; x += 8) tf(x, -10, 0.75 + rng.next() * 0.2);
  // パビリオン：外の柱（3.6m ごと）、ガラスの壁は 1.6m 奥
  const x0 = -21.6, x1 = 21.6, z0 = -5, z1 = 16.6, fh = 4.4, H = fh * 2;
  const ins = 1.6;
  mb.box(x0 + ins, 0, z0 + ins, x1 - ins, H, z1 - ins, GLASS_L, PAT.fullglass, ROOF);
  // 中の床（明るい床の帯）と、まわりを巡るバルコニー（細い手すり）
  slab(mb, x0, z0, x1, z1, fh - 0.15, 0.3, 0, steel, steel);
  wrap(mb, x0, z0, x1, z1, fh + 0.15, fh + 1.15, C(0x9ec3d1), PAT.none, 0);
  // 柱
  for (const s of sides(x0, z0, x1, z1)) for (let t = 0; t < s.L - 0.1; t += 3.6) { const p = s.P(t, -0.15); mb.box(p[0] - 0.13, 0, p[1] - 0.13, p[0] + 0.13, H, p[1] + 0.13, steelS); }
  // 薄い屋根（白いふち）と、屋上の天窓・太陽光パネル
  slab(mb, x0, z0, x1, z1, H, 0.55, 0.6, steel, C(0xc9c7c0));
  pvRows(mb, x0 + 3, z0 + 3, -3, z1 - 3, H + 0.55);
  for (let x = 3; x < x1 - 3; x += 4.5) mb.box(x, H + 0.55, z0 + 4, x + 2.4, H + 1.2, z1 - 4, GLASS_L, PAT.none, GLASS_L);
  // 中の家具の気配（色のついた低い箱がガラス越しに見える）
  const cols = [C(0xe0a24a), C(0x5f8f5a), C(0xd0d3d6)];
  for (let k = 0; k < 6; k++) { const x = x0 + 4 + k * 6.6; mb.box(x, 0, z1 - ins - 3, x + 3.5, 1.0, z1 - ins - 1.2, cols[k % 3]); }
  // 広場：木の列とベンチ、自転車置き場
  for (let x = -hw + 4; x < hw - 2; x += 9) { tf(x, hd - 3.5, 0.85 + rng.next() * 0.2); }
  tf(-hw + 3, 4, 0.95); tf(hw - 3, 9, 0.9); tf(hw - 3.5, -2, 0.8);
  for (let x = -18; x < 18; x += 12) bench(mb, x, hd - 7, x + 4, hd - 6.4);
  bikeShelter(mb, -hw + 3, -7, -hw + 12, -4.5);
  for (const x of [-12, 0, 12]) lamp(mb, x, hd - 5);
}

// C：明るい低層の棟（白いスラブの帯の棟と、明るい木の縦ルーバーの棟）を、大きなガラスの玄関ホールがつなぐ
function collegeNordic(mb: MeshBuilder, f: LotFrame, tf: TF, rng: Rng) {
  const hw = f.W / 2, hd = f.D / 2;
  const birch = C(0xdcc7a3), birchS = C(0xbfa985);
  // 前の芝と小道、広場
  mb.ground(-hw + 1, 12, hw - 1, hd - 0.4, 0.085, LAWN_D);
  mb.ground(-7, 9, 9, hd - 0.4, 0.09, PAVE);
  mb.quad([-hw + 2, 0.095, hd - 1], [-hw + 5.5, 0.095, hd - 1], [-6, 0.095, 15], [-7, 0.095, 12.5], PAVE2);
  mb.quad([9, 0.095, 12.5], [10, 0.095, 15], [hw - 2, 0.095, hd - 1.5], [hw - 2, 0.095, hd - 4.5], PAVE2);
  // 左の棟：白いスラブの帯と横長のガラスの帯（3階）
  const lx0 = -hw + 3, lx1 = -7, lz0 = -hd + 3, lz1 = 12, ff = 3.8;
  mb.box(lx0 + 0.6, 0, lz0 + 0.6, lx1 - 0.6, 3 * ff, lz1 - 0.6, GLASS, PAT.fullglass, ROOF);
  for (let i = 1; i <= 3; i++) slab(mb, lx0, lz0, lx1, lz1, i * ff - 0.55, 0.55, 0, WHITE, WHITE2);
  wrap(mb, lx0, lz0, lx1, lz1, 0, 0.9, WHITE, PAT.none, 0);
  for (let i = 0; i < 3; i++) wrap(mb, lx0, lz0, lx1, lz1, i * ff + 0.1, i * ff + 1.0, WHITE, PAT.none, -0.05);
  // 屋上の白い手すり
  {
    const y0 = 3 * ff, y1 = y0 + 0.9, t = 0.3;
    mb.box(lx0, y0, lz0, lx1, y1, lz0 + t, WHITE); mb.box(lx0, y0, lz1 - t, lx1, y1, lz1, WHITE);
    mb.box(lx0, y0, lz0 + t, lx0 + t, y1, lz1 - t, WHITE); mb.box(lx1 - t, y0, lz0 + t, lx1, y1, lz1 - t, WHITE);
    mb.ground(lx0 + 0.3, lz0 + 0.3, lx1 - 0.3, lz1 - 0.3, y0 + 0.01, ROOF);
  }
  greenRoof(mb, lx0, lz0, lx1, lz1, 3 * ff + 0.02);
  // 右の棟：明るい木の縦ルーバー（4階）。正面は少し低い2階の張り出し
  const rx0 = 9, rx1 = hw - 3, rz0 = -hd + 3, rz1 = 2, rH = 4 * ff;
  mb.box(rx0, 0, rz0, rx1, rH, rz1, GLASS_D, PAT.curtain, ROOF);
  for (const s of sides(rx0, rz0, rx1, rz1)) for (let t = 0.4; t < s.L - 0.2; t += 1.1) fin(mb, s, t, 0.22, 0.5, 0, rH, birch, birchS);
  slab(mb, rx0, rz0, rx1, rz1, rH, 0.4, 0.6, WHITE, ROOF);
  greenRoof(mb, rx0, rz0, rx1, rz1, rH + 0.4);
  mb.box(rx0 + 5, rH + 0.4, rz0 + 4, rx0 + 11, rH + 2.6, rz0 + 9, C(0xc9cdd2), PAT.industrial, C(0xb9bfc5));
  const fx0 = rx0 + 2, fx1 = rx1, fz1 = 12;
  mb.box(fx0, 0, rz1, fx1, 2 * ff, fz1, GLASS, PAT.fullglass, ROOF);
  for (const s of sides(fx0, rz1, fx1, fz1)) for (let t = 0.4; t < s.L - 0.2; t += 1.1) fin(mb, s, t, 0.22, 0.5, 0, 2 * ff, birch, birchS);
  slab(mb, fx0, rz1, fx1, fz1, 2 * ff, 0.4, 0.6, WHITE, C(0x6f8f4e));
  // 玄関ホール：背の高いガラスの箱、前へ上がる片流れの白い屋根
  const hx0 = -7, hx1 = 9, hz0 = -14, hz1 = 9, hy0 = 12.5, hy1 = 15.5;
  mb.prism([[hx0, hz0], [hx1, hz0], [hx1, hz1], [hx0, hz1]], 0, hy0, GLASS_L, PAT.fullglass, null, undefined, [hy0, hy0, hy1, hy1]);
  {
    const o = 1.2, X0 = hx0 - o, X1 = hx1 + o, Z0 = hz0, Z1 = hz1 + 2.5;
    const yA = hy0, yB = hy1 + ((hy1 - hy0) * 2.5) / (hz1 - hz0), t = 0.5;
    mb.quad([X0, yB + t, Z1], [X1, yB + t, Z1], [X1, yA + t, Z0], [X0, yA + t, Z0], C(0xd9d8d2));
    mb.quad([X0, yB, Z1], [X1, yB, Z1], [X1, yB + t, Z1], [X0, yB + t, Z1], WHITE);
    mb.quad([X1, yA, Z0], [X0, yA, Z0], [X0, yA + t, Z0], [X1, yA + t, Z0], WHITE);
    mb.quad([X1, yB, Z1], [X1, yA, Z0], [X1, yA + t, Z0], [X1, yB + t, Z1], WHITE);
    mb.quad([X0, yA, Z0], [X0, yB, Z1], [X0, yB + t, Z1], [X0, yA + t, Z0], WHITE);
    mb.quad([X0, yA, Z0], [X1, yA, Z0], [X1, yB, Z1], [X0, yB, Z1], WHITE2);
    for (const x of [hx0 + 0.5, hx1 - 0.5]) mb.box(x - 0.15, 0, Z1 - 0.6, x + 0.15, yB, Z1 - 0.3, WHITE2);
  }
  // ホールの中の吹き抜けの階段とバルコニー（ガラス越しの気配）
  mb.box(hx0 + 1, 4.2, hz0 + 2, hx1 - 1, 4.5, hz0 + 7, WHITE);
  // 木：針葉樹と広葉樹（北欧らしく）
  tf(-hw + 2, hd - 2, 0.9, 1); tf(-hw + 6, hd - 6, 0.8); tf(-14, hd - 3, 0.9, 1); tf(16, hd - 4, 0.85, 1); tf(24, hd - 7, 0.9);
  tf(hw - 2, 6, 0.8, 1); tf(-hw + 1.6, -6, 0.85, 1); tf(hw - 2, hd - 2, 0.9);
  for (const x of [-4, 6]) lamp(mb, x, hd - 3);
  bench(mb, -5, 13.5, -1, 14.1);
  bench(mb, 3, 13.5, 7, 14.1);
}

// ================= 市役所（4×3） =================
// ヒルフェルスム市庁舎（デュドック）風：黄色いレンガの水平な箱を組み合わせ、細い時計塔、前に水盤。ガラスのロビーと広場
export function townHall(mb: MeshBuilder, f: LotFrame, tf: TF) {
  mb.flatRoofMat = MAT.membrane;
  const hw = f.W / 2, hd = f.D / 2;
  const yb = C(0xd9bf85), cope = C(0xf1ede2), frame = C(0x2c3f5c), glassD = C(0x2f4257);
  mb.ground(-hw + 0.2, -hd + 0.2, hw - 0.2, hd - 0.2, 0.07, LAWN);
  // 黄色いレンガの箱：白い笠木と、窓の帯（区切った横長の窓）
  const vol = (x0: number, z0: number, x1: number, z1: number, y0: number, h: number, ff: number) => {
    matBox(mb, MAT.brick, x0, y0, z0, x1, h, z1, yb);
    const floors = Math.round((h - y0) / ff);
    for (const s of sides(x0, z0, x1, z1)) {
      const n = Math.max(1, Math.round(s.L / 7));
      const step = s.L / n;
      for (let i = 0; i < floors; i++)
        for (let k = 0; k < n; k++) {
          const t0 = k * step + 0.9, t1 = (k + 1) * step - 0.9;
          if (t1 - t0 < 1.5) continue;
          const y = y0 + i * ff;
          fq(mb, s, t0, t1, y + 1.0, y + ff - 0.8, 0.04, glassD, PAT.fullglass);
          fq(mb, s, t0 - 0.12, t1 + 0.12, y + 0.86, y + 1.0, 0.06, cope);
        }
    }
    slab(mb, x0, z0, x1, z1, h, 0.45, 0.35, cope, ROOF);
  };
  vol(-28, -20, 12, -4, 0, 12.6, 4.2); // 主棟（3階）
  vol(-20, -16, 2, -6, 13.05, 17.25, 4.2); // 上に重ねた箱
  vol(-28, -4, -8, 5, 0, 8.4, 4.2); // 左前の低い棟
  vol(12, -20, 28, -3, 0, 8.4, 4.2); // 右の棟
  vol(-27, -23.6, -12, -20, 0, 4.2, 4.2); // 奥の小さな箱
  // デュドックらしい水平の張り出し（細い白いひさし）
  mb.box(-29, 4.0, 5, -7, 4.25, 7.2, cope);
  mb.box(-29, 8.4, -5, -27, 8.55, 6, cope);
  mb.box(12, 8.85, -3, 29, 9.05, -1.2, cope);
  // ガラスのロビー（主棟の前、白い薄い屋根が前へ張り出す）
  const lx0 = -8, lx1 = 12, lz0 = -4, lz1 = 6, lH = 8.2;
  mb.box(lx0, 0, lz0, lx1, lH, lz1, GLASS, PAT.fullglass, ROOF);
  for (let x = lx0 + 2.5; x < lx1; x += 2.5) mb.box(x - 0.08, 0, lz1, x + 0.08, lH, lz1 + 0.18, C(0xe3e4e2));
  slab(mb, lx0 - 1, lz0, lx1 + 1, lz1 + 4.5, lH, 0.45, 0, WHITE, ROOF);
  mb.quad([lx0, lH - 0.01, lz1 + 0.2], [lx1, lH - 0.01, lz1 + 0.2], [lx1, lH - 0.01, lz1 + 4.2], [lx0, lH - 0.01, lz1 + 4.2], C(0xfff1d6), PAT.lit);
  for (const x of [lx0 + 1, (lx0 + lx1) / 2, lx1 - 1]) mb.box(x - 0.12, 0, lz1 + 3.8, x + 0.12, lH, lz1 + 4.05, C(0xe3e4e2));
  // 時計塔：細い四角の塔、縦の細い窓、上に時計と展望の柱、旗竿
  const tx0 = 13, tx1 = 19, tz0 = -2.5, tz1 = 3.5, tH = 40;
  matBox(mb, MAT.brick, tx0 - 0.6, 0, tz0 - 0.6, tx1 + 0.6, 9, tz1 + 0.6, yb);
  slab(mb, tx0 - 0.6, tz0 - 0.6, tx1 + 0.6, tz1 + 0.6, 9, 0.3, 0.2, cope, cope);
  matBox(mb, MAT.brick, tx0, 9, tz0, tx1, tH, tz1, yb);
  const T = sides(tx0, tz0, tx1, tz1);
  for (const s of T) {
    fq(mb, s, 2.4, 3.6, 12, 34, 0.04, glassD, PAT.fullglass);
    for (let y = 14; y < 34; y += 4) fq(mb, s, 2.3, 3.7, y, y + 0.18, 0.06, frame);
  }
  // 時計の部分（白い帯の上）
  slab(mb, tx0, tz0, tx1, tz1, tH, 0.3, 0.25, cope, cope);
  matBox(mb, MAT.brick, tx0 + 0.3, tH + 0.3, tz0 + 0.3, tx1 - 0.3, tH + 5.6, tz1 - 0.3, yb);
  const T2 = sides(tx0 + 0.3, tz0 + 0.3, tx1 - 0.3, tz1 - 0.3);
  for (const s of T2) {
    const c = s.L / 2, cy = tH + 3;
    fdisc(mb, s, c, cy, 2.0, 0.05, frame);
    fdisc(mb, s, c, cy, 1.75, 0.08, C(0xf5efdc), PAT.lit);
    // 針（10時10分）
    const hand = (a: number, len: number, w: number) => {
      const ca = Math.cos(a), sa = Math.sin(a), nx = -sa * w, ny = ca * w;
      fpoly(mb, s, [[c + nx, cy + ny], [c - nx, cy - ny], [c + ca * len - nx, cy + sa * len - ny], [c + ca * len + nx, cy + sa * len + ny]], 0.1, DARK);
    };
    hand(Math.PI * 0.5 + 0.52, 1.5, 0.07);
    hand(Math.PI * 0.5 - 1.05, 1.1, 0.1);
  }
  // 展望の柱（四隅）と薄い屋根、頂部の小さな箱と旗竿
  slab(mb, tx0, tz0, tx1, tz1, tH + 5.6, 0.3, 0.25, cope, cope);
  for (const [x, z] of [[tx0, tz0], [tx1 - 0.8, tz0], [tx0, tz1 - 0.8], [tx1 - 0.8, tz1 - 0.8]]) matBox(mb, MAT.brick, x, tH + 5.9, z, x + 0.8, tH + 9.4, z + 0.8, yb);
  mb.box(tx0 + 1.4, tH + 5.9, tz0 + 1.4, tx1 - 1.4, tH + 8.6, tz1 - 1.4, glassD, PAT.fullglass, frame);
  slab(mb, tx0, tz0, tx1, tz1, tH + 9.4, 0.35, 0.3, cope, ROOF);
  matBox(mb, MAT.brick, tx0 + 1.6, tH + 9.75, tz0 + 1.6, tx1 - 1.6, tH + 11.2, tz1 - 1.6, yb);
  mb.box(tx0 + 1.4, tH + 11.2, tz0 + 1.4, tx1 - 1.4, tH + 11.45, tz1 - 1.4, cope);
  const cx = (tx0 + tx1) / 2, cz = (tz0 + tz1) / 2;
  mb.box(cx - 0.06, tH + 11.45, cz - 0.06, cx + 0.06, tH + 16, cz + 0.06, C(0xe8e8e8));
  mb.box(cx + 0.06, tH + 14.6, cz - 0.02, cx + 2.2, tH + 15.9, cz + 0.02, C(0xc8102e));
  // 水盤（細い石のふち）
  const px0 = -27, px1 = -6, pz0 = 9.5, pz1 = 19.5;
  mb.ground(px0 - 1.5, pz0 - 1.5, px1 + 1.5, pz1 + 1.5, 0.09, PAVE);
  mb.box(px0, 0, pz0, px1, 0.4, pz0 + 0.35, cope); mb.box(px0, 0, pz1 - 0.35, px1, 0.4, pz1, cope);
  mb.box(px0, 0, pz0, px0 + 0.35, 0.4, pz1, cope); mb.box(px1 - 0.35, 0, pz0, px1, 0.4, pz1, cope);
  mb.ground(px0 + 0.35, pz0 + 0.35, px1 - 0.35, pz1 - 0.35, 0.28, WATER);
  // 前の芝（水盤の左右）と、ロビー前の広場
  mb.ground(-hw + 1, 7, -6, 8, 0.1, PAVE2);
  mb.ground(-6, 7, hw - 1, hd - 0.4, 0.09, PAVE);
  for (let x = -5; x < hw - 1; x += 4) mb.ground(x - 0.05, 7, x + 0.05, hd - 0.4, 0.095, PAVE2);
  mb.ground(-6, lz1, lx1 + 1, 7, 0.09, PAVE);
  mb.ground(lx1 + 1, -1, 30, 7, 0.09, PAVE);
  // 広場の並木と旗竿、ベンチ、街灯
  for (const x of [16, 23, 29]) for (const z of [11, 18]) tf(x, z, 0.85, 0);
  for (const [k, x] of [[0, -3], [1, 0], [2, 3]] as [number, number][]) {
    mb.box(x - 0.07, 0, 18.4, x + 0.07, 10, 18.54, C(0xe8e8e8));
    mb.box(x + 0.07, 8.4, 18.45, x + 1.9, 9.8, 18.49, [C(0x1f4fa0), C(0xc8102e), C(0xf2c200)][k]);
  }
  for (const x of [8, 20]) bench(mb, x, 14.5, x + 4, 15.1);
  for (const x of [-25, -15, -8]) lamp(mb, x, 21.5);
  for (const x of [10, 26]) lamp(mb, x, 21.5);
  // 奥と横の木
  tf(-hw + 2, -hd + 2, 1.0); tf(hw - 2, -hd + 2, 0.95); tf(-hw + 1.8, 0, 0.9, 1); tf(hw - 1.8, 4, 0.9);
  tf(-hw + 1.8, 20, 0.9); tf(-hw + 1.8, 13, 0.85);
}
