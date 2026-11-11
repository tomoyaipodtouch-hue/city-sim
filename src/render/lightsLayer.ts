// 夜の街灯（道路に沿った光の点と、路面を照らす光のにじみ）
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Grid } from '../sim/grid';
import { CELL, DX, DY } from '../sim/constants';
import { ROADS, RoadType, isHighway, isUrbanElevated } from '../sim/defs';
import { AV_W, ROAD_LIFT, avLampBlock, avenueMedianDir, inRegion, junctionLamps, junctionPools } from './roadLayer';
import { findURamps, urampAt, UR_END, UR_HALF } from './uramp';
import { findJctChains, jAt, JR_HALF } from './jctCurve';

// soft = 街灯の光：中心が明るく、外へ長くうすく消える（寄ったとき、ふちのはっきりした円盤に見えないように）
function glowTexture(soft = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  if (soft) {
    gr.addColorStop(0.12, 'rgba(255,255,255,0.7)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.22)');
    gr.addColorStop(0.65, 'rgba(255,255,255,0.06)');
  } else gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 上空の大通り（立体交差）のマスの、反対車線のある向き（まっすぐなマスだけ。斜めのマスも。なければ -1）
function upperMedianDir(g: Grid, i: number): number {
  const n = g.n, x = i % n, y = (i / n) | 0, m = g.conn1[i];
  const isAv = (d: number) => {
    const qx = x + DX[d], qy = y + DY[d];
    return g.inb(qx, qy) && g.up[qy * n + qx] === RoadType.Avenue;
  };
  for (const a of [0, 1, 2, 3]) {
    if (!(m & (1 << a)) || !(m & (1 << (a + 4)))) continue;
    if (!(a & 1)) {
      for (const d of [(a + 2) & 7, (a + 6) & 7]) if (isAv(d)) return d;
      continue;
    }
    // 斜めの車線の反対車線は、軸の向きの隣のマス
    if (isAv((a + 1) & 7) || isAv((a + 3) & 7)) return (a + 2) & 7;
    if (isAv((a + 5) & 7) || isAv((a + 7) & 7)) return (a + 6) & 7;
  }
  return -1;
}

// 街灯の柱（腕は +x の向き、長さ 2m）
function poleGeo() {
  const parts = [
    new THREE.CylinderGeometry(0.09, 0.13, 7.6, 6).translate(0, 3.8, 0),
    new THREE.BoxGeometry(2.2, 0.1, 0.1).translate(1.0, 7.45, 0),
    new THREE.BoxGeometry(0.7, 0.16, 0.32).translate(2.0, 7.38, 0),
  ].map((g) => g.toNonIndexed());
  parts.forEach((g) => g.deleteAttribute('uv'));
  return mergeGeometries(parts)!;
}

export class StreetLights {
  group = new THREE.Group(); // 昼も見える柱と、夜だけの光
  points = new THREE.Group();
  // 柱は亜鉛めっきの鉄（少しつやのある金属）
  private poles = new THREE.InstancedMesh(poleGeo(), new THREE.MeshStandardMaterial({ color: 0x80878e, roughness: 0.5, metalness: 0.55 }), 8192 * 6);
  // 航空障害灯（高い建物のてっぺんの赤いランプ）
  private beacons: THREE.Points;
  private beaconMat: THREE.PointsMaterial;
  private lamps: THREE.Points;
  private pools: THREE.InstancedMesh;
  private lampMat: THREE.PointsMaterial;
  constructor() {
    const tex = glowTexture();
    const mk = (size: number, color: number) =>
      new THREE.PointsMaterial({ map: tex, size, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: true });
    this.lampMat = mk(14, 0xffd9a0);
    this.lampMat.map = glowTexture(true);
    // 寄って見ても、光のにじみは画面の上で一定の大きさまで（大きな円盤にならないように）。scale は画面の高さの半分（画素）
    this.lampMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <logdepthbuf_vertex>', 'gl_PointSize = min(gl_PointSize, scale * 0.16);\n#include <logdepthbuf_vertex>');
    };
    this.lampMat.customProgramCacheKey = () => 'lamp-halo';
    this.lamps = new THREE.Points(new THREE.BufferGeometry(), this.lampMat);
    // 路面を照らす光：地面に平らに置いた丸い光（建物や地面に食い込まないように）
    this.pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, color: 0xffb870, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }),
      8192 * 6,
    );
    this.pools.count = 0;
    this.lamps.frustumCulled = this.pools.frustumCulled = false;
    this.points.add(this.pools, this.lamps);
    this.points.visible = false;
    this.poles.count = 0;
    this.poles.castShadow = true;
    this.poles.frustumCulled = false;
    this.beaconMat = new THREE.PointsMaterial({ map: tex, size: 7, color: 0xff2a1a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: true });
    this.beacons = new THREE.Points(new THREE.BufferGeometry(), this.beaconMat);
    this.beacons.frustumCulled = false;
    this.group.add(this.poles, this.points, this.beacons);
  }

  setBeacons(pos: number[]) {
    this.beacons.geometry.dispose();
    this.beacons.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }

  // 航空障害灯の点滅（約1.5秒ごと）。昼は小さく暗い
  private night = 0;
  update(time: number) {
    const on = (time % 1.5) < 0.75 ? 1 : 0.15;
    this.beaconMat.opacity = on * (0.35 + 0.65 * this.night);
    this.beaconMat.size = 8 + 18 * this.night;
  }

  rebuild(g: Grid) {
    const n = g.n, N = n * n;
    const lamp: number[] = [], pool: number[] = [], poles: number[] = [];
    // 都市高速のランプ（1×5マス）は、描いた曲線の外側の欄干の上に立てる（マスごとには立てない）
    const uramps = findURamps(g, ROAD_LIFT);
    const urCells = new Set<number>();
    const urSide = new Map<number, number[]>(); // ランプが分かれる本線のマス：ランプのある側（横向き）
    for (const U of uramps) {
      U.cells.forEach((c, k) => urCells.add((U.level && k !== 2 ? N : 0) + c));
      for (const k of [0, 1, 5, 6]) {
        const nd = U.level * N + U.hw[k];
        (urSide.get(nd) ?? urSide.set(nd, []).get(nd)!).push(U.sx, U.sz);
      }
      for (const s of [-(UR_END - 26), UR_END - 26]) {
        const P = urampAt(U, s);
        let nx = -P.tz, nz = P.tx;
        if (nx * U.sx + nz * U.sz < 0) { nx = -nx; nz = -nz; }
        const off = UR_HALF + 0.12, cx = P.x + nx * off, cz = P.z + nz * off;
        const base = P.h + 0.9;
        lamp.push(cx - nx * 2.0, base + 7.2, cz - nz * 2.0);
        pool.push(cx - nx * 2.6, P.h + 0.05, cz - nz * 2.6, 11);
        poles.push(cx, base, cz, Math.atan2(nz, -nx));
      }
    }
    // ジャンクションのランプ：描いた曲線の右側の欄干の上に、約 40m ごとに立てる（マスごとには立てない）
    for (const C of findJctChains(g, ROAD_LIFT)) {
      for (const v of C.nodes) if (g.nodeType(v) === RoadType.Ramp) urCells.add(v);
      for (let sv = C.draw0 + 20; sv < C.draw1 - 10; sv += 40) {
        const P = jAt(C, sv);
        const nx = -P.tz, nz = P.tx, off = JR_HALF + 0.12, cx = P.x + nx * off, cz = P.z + nz * off;
        const base = P.h + 0.9;
        lamp.push(cx - nx * 2.0, base + 7.2, cz - nz * 2.0);
        pool.push(cx - nx * 2.6, P.h + 0.05, cz - nz * 2.6, 11);
        poles.push(cx, base, cz, Math.atan2(nz, -nx));
      }
    }
    // ジャンクションのランプのとなりの本線のマスでは、ランプの側には立てない
    const jSide = (node: number, sx: number, sz: number) => {
      const lv = node >= N ? 1 : 0, c = node - lv * N, x = c % n, y = (c / n) | 0;
      for (let d = 0; d < 8; d++) {
        if (DX[d] * sx + DY[d] * sz <= 0.3 || !g.inb(x + DX[d], y + DY[d])) continue;
        const j = (y + DY[d]) * n + x + DX[d];
        if (g.jct[j]) return true;
      }
      return false;
    };
    for (let node = 0; node < 2 * N; node++) {
      const level = node >= N ? 1 : 0;
      const i = node - level * N;
      const t = level ? g.up[i] : g.road[i];
      if (!t) continue;
      const x = i % n, y = (i / n) | 0;
      const m = level ? g.conn1[i] : g.conn[i];
      const h = g.nodeH(node);
      if (t === RoadType.Avenue) {
        // 大通り：外側（分離帯と反対の側）の歩道に、32m ごとに立てて車道へ腕をのばす。
        // 交差点・曲がり角（分離帯の向きが決まらないマス）には立てない（車道の中に立たないように）。
        // 地上の高速道路をまたぐ上空の大通りも、外側の歩道だけ（分離帯の上には立てない）
        let deg = 0;
        for (let d = 0; d < 8; d++) if (m & (1 << d)) deg++;
        // 斜めと縦横の腕がまざるマス（45° の曲がり、斜めの行き止まりの折り返し）にも立てない
        if (deg >= 3 || (m & 0xaa && m & 0x55)) continue;
        const md = level ? upperMedianDir(g, i) : avenueMedianDir(g, i);
        if (md < 0) continue;
        // 斜めの車線は x と y の和の偶奇が変わらないので、x の偶奇で間引く
        if ((md & 1 ? x : x + y) & 1) continue;
        const ol = Math.hypot(DX[md], DY[md]);
        const ox = -DX[md] / ol, oz = -DY[md] / ol; // 外向き
        // バス停の待合所と重ならないよう、道に沿って少しずらす
        const sh = g.bstop[i] ? 4.5 : 0;
        const bx = (x + 0.5) * CELL + oz * sh, bz = (y + 0.5) * CELL - ox * sh;
        const off = AV_W / 2 + 0.8;
        const cx = bx + ox * off, cz = bz + oz * off;
        // 斜めの大通りの交差点の、角の丸みや車道になったところには立てない
        if (avLampBlock.some((R) => inRegion(R, cx, cz))) continue;
        lamp.push(cx - ox * 2.0, h + 7.2, cz - oz * 2.0);
        poles.push(cx, h, cz, Math.atan2(oz, -ox));
        // 路面と、歩道を照らす光
        // 路面の光は路面より少しだけ上に置く（真上から見ても路面に隠れないように）
        pool.push(bx + ox * (AV_W / 2 - 0.6), h + ROAD_LIFT + 0.05, bz + oz * (AV_W / 2 - 0.6), 11);
        pool.push(bx + ox * (AV_W / 2 + 2.4), h + 0.5, bz + oz * (AV_W / 2 + 2.4), 8.5);
        continue;
      }
      // 1マスおきに、左右交互に立てる
      if ((x + y) & 1 || urCells.has(node)) continue;
      let d = 0;
      while (d < 8 && !(m & (1 << d))) d++;
      if (d === 8) d = 0;
      let px = -DY[d], pz = DX[d];
      const l = Math.hypot(px, pz) || 1;
      let side = x & 1 ? -1 : 1;
      // 都市高速の高架は、細い欄干の上に立てる。ランプが分かれる側（欄干のない所）は避ける
      const via = level === 1 && isUrbanElevated(t);
      const rs = urSide.get(node);
      if (rs) {
        const toward = (sg: number) => rs.some((_, q) => q % 2 === 0 && (px * rs[q] + pz * rs[q + 1]) * sg > 0);
        if (toward(side)) side = -side;
        if (toward(side)) continue;
      }
      if (isHighway(t) && jSide(node, px * side, pz * side)) {
        side = -side;
        if (jSide(node, px * side, pz * side)) continue;
      }
      const off = (via ? ROADS[t].width / 2 + 0.12 : ROADS[t].width / 2 + 0.6) * side;
      const hb = via ? h + ROAD_LIFT + 0.9 : h;
      px = (px / l) * off;
      pz = (pz / l) * off;
      const cx = (x + 0.5) * CELL + px, cz = (y + 0.5) * CELL + pz;
      // 腕は道路の中心の向き
      const dl = Math.hypot(px, pz) || 1, dx = -px / dl, dz = -pz / dl;
      lamp.push(cx + dx * 2.0, hb + 7.2, cz + dz * 2.0);
      pool.push(cx - px * 0.6, h + 0.25, cz - pz * 0.6, 11);
      poles.push(cx, hb, cz, Math.atan2(-dz, dx));
    }
    // 大通りの交差点の角の街灯（道路の層が、交差点を作るときに置き場所を決める）
    for (let k = 0; k + 5 < junctionLamps.length; k += 6) {
      const [cx, h, cz, dx, dz, ph] = junctionLamps.slice(k, k + 6);
      lamp.push(cx + dx * 2.0, h + 7.2, cz + dz * 2.0);
      poles.push(cx, h, cz, Math.atan2(-dz, dx));
      // 光は交差点の中ほどまで届かせる（光の板は、届く範囲でいちばん高い路面の高さ）
      pool.push(cx + dx * 9, ph + ROAD_LIFT + 0.05, cz + dz * 9, 18);
    }
    for (let k = 0; k + 3 < junctionPools.length; k += 4) pool.push(junctionPools[k], junctionPools[k + 1] + ROAD_LIFT + 0.05, junctionPools[k + 2], junctionPools[k + 3]);
    {
      const m2 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      const pc = Math.min(this.poles.instanceMatrix.count, poles.length / 4);
      for (let k = 0; k < pc; k++) {
        v2.set(poles[k * 4], poles[k * 4 + 1], poles[k * 4 + 2]);
        q2.setFromAxisAngle(up, poles[k * 4 + 3]);
        this.poles.setMatrixAt(k, m2.compose(v2, q2, one));
      }
      this.poles.count = pc;
      this.poles.instanceMatrix.needsUpdate = true;
    }
    this.lamps.geometry.dispose();
    this.lamps.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lamp, 3));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), v = new THREE.Vector3();
    const cnt = Math.min(this.pools.instanceMatrix.count, pool.length / 4);
    for (let k = 0; k < cnt; k++) {
      v.set(pool[k * 4], pool[k * 4 + 1], pool[k * 4 + 2]);
      sc.set(pool[k * 4 + 3], 1, pool[k * 4 + 3]);
      this.pools.setMatrixAt(k, m.compose(v, q, sc));
    }
    this.pools.count = cnt;
    this.pools.instanceMatrix.needsUpdate = true;
  }

  setNight(k: number) {
    this.night = k;
    this.points.visible = k > 0.02;
    this.lampMat.opacity = k;
    (this.pools.material as THREE.MeshBasicMaterial).opacity = 0.3 * k;
  }
}
