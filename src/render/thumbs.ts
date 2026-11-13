// メニューの項目の絵（サムネイル）：ゲームの建物を作る関数で作った形を、昼の光で、決まった斜め上の向きから小さく描く。
// 画面の描画とは別のシーンを、画面と同じ WebGLRenderer で小さな描画先（128px）に描き、画素を読み出して返す。
// 描画先・環境マップ・影の地図は、まとめて描くあいだだけ持ち、終わったら捨てる（end）
import * as THREE from 'three';
import { CELL } from '../sim/constants';
import { CIVIC } from '../sim/defs';
import { BState, type Building } from '../sim/world';
import type { ThumbSpec } from '../ui/menu';
import { MeshBuilder } from './builder';
import { generateBuilding, setupLot, type TreeSpot } from './buildingGen';
import { createBuildingMaterial, shared } from './materials';
import { MAT } from './textures';
import { PondBuilder, createPondMaterial, createFallMaterial, pondUniforms } from './parkPond';
import { gardenU } from './gardenLight';
import { SkyEnv } from './env';
import { airportThumbModel, airportThumbCells } from './airport/thumb';

export const THUMB_PX = 128;
const SEED = 20240611; // 絵が毎回同じになるよう、建物の種は決めておく
const AZ = Math.PI / 4; // カメラの向き（南東から）
const EL = (30 * Math.PI) / 180; // カメラの高さの角度
const EXPOSURE = 1.15;
const SUN = new THREE.Vector3(-0.42, 0.78, 0.6).normalize(); // 左手前の上から（正面が明るく、右の面が日かげ）

const C = (h: number) => new THREE.Color(h);

// 昼の光（renderer.ts の updateDayNight・updateEnv の昼の値と同じ作り方）
function dayLight() {
  const sunCol = C(0xffeed6), sunI = 3.0;
  const hemiI = 1.05, hemiCol = C(0xcfe0f2), hemiGround = C(0x6e675a);
  const sky = C(0xa9cbe6), zenith = C(0x4f86cc);
  const hi = hemiI / Math.PI;
  const ambSky = hemiCol.clone().multiplyScalar(hi);
  const bounce = sunCol.clone().multiplyScalar(sunI * Math.max(0, SUN.y)).add(ambSky.clone().multiplyScalar(Math.PI));
  bounce.multiply(new THREE.Color(0.17, 0.16, 0.13)).multiplyScalar(1 / Math.PI);
  const ambGround = hemiGround.clone().multiplyScalar(hi * 0.5).add(bounce.multiplyScalar(0.5));
  const ambSun = sunCol.clone().multiplyScalar(0.05);
  const city = sunCol.clone().multiplyScalar(sunI * 0.45).add(ambSky.clone().multiplyScalar(Math.PI)).multiplyScalar(0.24 / Math.PI);
  return { sunCol, sunI, sky, zenith, skySun: C(0xfff2d8), ambSky, ambGround, ambSun, city, skyTop: zenith.clone().lerp(new THREE.Color(1, 1, 1), 0.12) };
}

// 描く前に共有の値（昼夜で変わる）を昼にし、描いたあとで戻す
type Saved = { k: { value: unknown }; v: unknown }[];
function saveSet(list: [{ value: unknown }, unknown][]): Saved {
  const out: Saved = [];
  for (const [k, v] of list) {
    const cur = k.value as { clone?: () => unknown };
    out.push({ k, v: cur && typeof cur === 'object' && cur.clone ? cur.clone() : cur });
    const t = k.value as { copy?: (x: unknown) => void };
    if (t && typeof t === 'object' && t.copy) t.copy(v);
    else k.value = v;
  }
  return out;
}
function restore(s: Saved) {
  for (const { k, v } of s) {
    const t = k.value as { copy?: (x: unknown) => void };
    if (t && typeof t === 'object' && t.copy) t.copy(v);
    else k.value = v;
  }
}

// 色を合わせて、トーンマップ（ACES、画面と同じ）と sRGB にする。透明なところ（背景）はそのまま
const OUT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uExp;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 IM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= uExp / 0.6;
  c = OM * RRTAndODTFit(IM * c);
  return clamp(c, 0.0, 1.0);
}
void main() {
  vec4 t = texture2D(tDiffuse, vUv);
  // 縁は背景（透明）と混ざっているので、色を戻してから変える
  vec3 c = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
  c = aces(c);
  c = mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
  gl_FragColor = vec4(c, t.a);
}`;

// 木（ゲームの木の層の代わりに、幹と葉の簡単な形で）
function addTrees(mb: MeshBuilder, trees: TreeSpot[]) {
  mb.setTransform(0, 0, 0, 0);
  const keep = mb.matOverride;
  mb.matOverride = MAT.none;
  const trunk = C(0x6b5038);
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const s = t.s;
    const v = 0.88 + ((i * 37) % 11) / 40;
    if (t.kind === 1) {
      const leaf = (t.col !== undefined ? C(t.col) : C(0x3d6332)).multiplyScalar(v);
      mb.cylinder(t.x, t.z, t.y, t.y + 1.6 * s, 0.22 * s, 5, trunk);
      mb.cylinder(t.x, t.z, t.y + 1.2 * s, t.y + 8.5 * s, 2.0 * s, 8, leaf, undefined, 0.05);
    } else {
      const leaf = (t.col !== undefined ? C(t.col) : C(0x5a8a3a)).multiplyScalar(v);
      mb.cylinder(t.x, t.z, t.y, t.y + 2.6 * s, 0.25 * s, 5, trunk);
      mb.dome(t.x, t.z, t.y + 2.2 * s, 2.5 * s, 4.6 * s, leaf, 10, 4);
    }
  }
  mb.matOverride = keep;
}

// 項目の絵の形を作る（建物 + 地面の台 + 木 + 池）
function buildModel(spec: ThumbSpec) {
  const mb = spec.k === 'airport' ? airportThumbModel(spec.size) : new MeshBuilder();
  const trees: TreeSpot[] = [];
  const pb = new PondBuilder();
  let w = 2, h = 2, tint: THREE.Color | null = null;
  let ext = { n: 0, s: 0 }; // 敷地の奥（-z）・手前（+z）に足した線路や道路の幅（m）
  if (spec.k === 'civic' || spec.k === 'grow') {
    let b: Building;
    const base = { id: 1, x: 0, y: 0, face: 2, seed: SEED, cap: 100, occ: 50, state: BState.Normal, stateDays: 0, powered: true, watered: true, commute: 0, employed: 1, badMonths: 0 };
    if (spec.k === 'civic') {
      const c = CIVIC[spec.id];
      w = c.w; h = c.h;
      b = { ...base, civic: true, type: spec.id, w, h, den: 0, floors: 0, cap: c.capacity ?? 100, occ: (c.capacity ?? 100) * 0.5 };
    } else {
      w = spec.w; h = spec.h;
      tint = C(spec.tint);
      b = { ...base, civic: false, type: spec.type, w, h, den: spec.den, floors: spec.floors };
    }
    const f = setupLot(mb, b, () => 0, () => 0);
    generateBuilding(mb, b, f, trees, () => false, pb, [], 0);
    if (spec.k === 'civic') ext = context(mb, spec.id, f.W, f.D);
  } else if (spec.k === 'airport') {
    ({ w, h } = airportThumbCells(spec.size));
  } else if (spec.k === 'trees') {
    w = h = 2;
    const S = 2 * CELL;
    const pts = [[0.28, 0.3, 1.05, 0], [0.7, 0.24, 0.9, 1], [0.5, 0.62, 1.1, 0], [0.18, 0.74, 0.85, 1], [0.8, 0.72, 0.95, 0]];
    for (const [x, z, s, k] of pts) trees.push({ x: x * S, y: 0.05, z: z * S, s: s * 1.3, kind: k });
  }
  // 地面の台（敷地のまわりに少し余白をとる）。ゾーンの見本は、ゾーンの色の地面にする
  mb.setTransform(0, 0, 0, 0);
  const W = w * CELL, D = h * CELL, m = Math.max(2.5, Math.min(W, D) * 0.12), th = 0.6 + Math.max(W, D) * 0.035;
  const top = tint ? C(0x7a9a55).lerp(tint, 0.55) : C(0x7a9a55);
  mb.matOverride = MAT.ground;
  const z0 = -m - ext.n, z1 = D + m + ext.s;
  mb.ground(-m, z0, W + m, z1, -0.04, top);
  mb.matOverride = MAT.none;
  const soil = C(0x6e5a44);
  mb.box(-m, -0.04 - th, z0, W + m, -0.05, z1, soil, 0, soil);
  mb.matOverride = null;
  addTrees(mb, trees);
  return { geo: mb.toGeometry(), pond: pb.empty ? null : pb.toGeometry(), fall: pb.fallGeometry(), w, h };
}

// 駅のホームと線路、バス停の前の道路など、ゲームでは別の層が描くものを、絵のためだけに簡単に足す（敷地の座標。奥が -z）
function context(mb: MeshBuilder, id: string, W: number, D: number) {
  const conc = C(0xc2beb4), concS = C(0x9a968d), steel = C(0x7a8088), ballast = C(0x8a8478), roof = C(0x3f4a57), plat = C(0xd3cdbf), asph = C(0x3d3f42);
  const L = W + 12, x0 = -L / 2, x1 = L / 2, zc = -D / 2 - 5.5; // 線路の中心（敷地の奥）
  const rails = (z: number, y: number) => {
    mb.box(x0, y, z - 1.3, x1, y + 0.25, z + 1.3, ballast);
    for (const dz of [-0.72, 0.72]) mb.box(x0, y + 0.25, z + dz - 0.08, x1, y + 0.45, z + dz + 0.08, steel);
  };
  const platform = (y: number) => {
    mb.box(x0 + 3, y, zc - 1.6, x1 - 3, y + 1, zc + 1.6, plat);
    for (const x of [x0 + 5, 0, x1 - 5]) mb.box(x - 0.12, y + 1, zc - 0.12, x + 0.12, y + 4.2, zc + 0.12, steel);
    mb.box(x0 + 3, y + 4.2, zc - 2.2, x1 - 3, y + 4.5, zc + 2.2, roof);
  };
  switch (id) {
    case 'station':
      rails(zc - 3.4, 0.05);
      rails(zc + 3.4, 0.05);
      platform(0.05);
      return { n: 11, s: 0 };
    case 'el_station': {
      const y = 8;
      for (const x of [x0 + 3, x1 - 3]) mb.box(x - 0.9, 0, zc - 0.9, x + 0.9, y - 1, zc + 0.9, conc);
      mb.box(x0, y - 1.4, zc - 5.2, x1, y, zc + 5.2, concS, 0, conc);
      rails(zc - 3.4, y);
      rails(zc + 3.4, y);
      platform(y);
      return { n: 11, s: 0 };
    }
    case 'mono_station': {
      const y = 11;
      for (const x of [x0 + 3, x1 - 3]) {
        mb.box(x - 0.8, 0, zc - 0.8, x + 0.8, y - 1.6, zc + 0.8, conc);
        mb.box(x - 0.8, y - 2.4, zc - 4.6, x + 0.8, y - 1.6, zc + 4.6, conc);
      }
      for (const dz of [-3.4, 3.4]) mb.box(x0, y - 1.6, zc + dz - 0.45, x1, y, zc + dz + 0.45, C(0xe4e1da));
      platform(y - 1);
      return { n: 11, s: 0 };
    }
    case 'hsr_station': {
      // 高架橋の上の線路（駅の中は 4 本）と、駅の外の橋脚
      const y = 18, tz = -8, X0 = -W / 2 - 18, X1 = W / 2 + 18;
      mb.box(X0, y - 2.4, tz - 6.4, X1, y, tz + 6.4, conc, 0, concS);
      mb.box(-W / 2, y - 1, tz - 11.4, W / 2, y, tz + 11.4, conc, 0, concS);
      for (const o of [-7.5, -2.5, 2.5, 7.5]) for (const dz of [-0.75, 0.75]) mb.box(Math.abs(o) > 5 ? -W / 2 : X0, y, tz + o + dz - 0.08, Math.abs(o) > 5 ? W / 2 : X1, y + 0.36, tz + o + dz + 0.08, steel);
      for (const x of [X0 + 4, X1 - 4]) mb.box(x - 1, 0, tz - 1.7, x + 1, y - 2.4, tz + 1.7, conc);
      return { n: 0, s: 0 };
    }
    case 'busstop':
      // 前の道路（白い線と、バス停の印）
      mb.ground(-W / 2 - 4, D / 2, W / 2 + 4, D / 2 + 7, 0.1, asph);
      mb.ground(-W / 2 - 4, D / 2 + 3.4, W / 2 + 4, D / 2 + 3.6, 0.12, C(0xf0f0ea));
      return { n: 0, s: 7 };
  }
  return { n: 0, s: 0 };
}

export class ThumbRenderer {
  private mat = createBuildingMaterial();
  private pondMat: THREE.Material | null = null;
  private fallMat: THREE.Material | null = null;
  private outMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uExp: { value: EXPOSURE } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: OUT_FRAG,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  private quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.outMat);
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // まとめて描くあいだだけ持つもの
  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget | null = null;
  private env: SkyEnv | null = null;
  private light: THREE.DirectionalLight | null = null;
  private day = dayLight();
  private buf = new Uint8Array(THUMB_PX * THUMB_PX * 4);
  genMs = 0; // 直前の 1 枚の形を作るのにかかった時間（確認用）

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private begin() {
    if (this.rtA) return;
    const r = this.renderer, ext = r.extensions;
    const half = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    this.rtA = new THREE.WebGLRenderTarget(THUMB_PX, THUMB_PX, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: 4, depthBuffer: true });
    this.rtB = new THREE.WebGLRenderTarget(THUMB_PX, THUMB_PX, { type: THREE.UnsignedByteType, depthBuffer: false });
    // 昼の空の環境マップ（ガラスや水の映り込み、まわりからの光）
    const env = (this.env = new SkyEnv(r));
    const d = this.day, eu = env.uniforms;
    eu.uZenith.value.copy(d.zenith);
    eu.uHorizon.value.copy(d.sky);
    eu.uSunDir.value.copy(SUN);
    eu.uSunCol.value.copy(d.skySun);
    eu.uCloud.value = 1;
    eu.uGlow.value.setRGB(0, 0, 0);
    eu.uAmbSky.value.copy(d.ambSky);
    eu.uAmbGround.value.copy(d.ambGround);
    eu.uAmbSun.value.copy(d.ambSun);
    eu.uGround.value.copy(d.city);
    env.update(r);
    const L = (this.light = new THREE.DirectionalLight(d.sunCol, d.sunI));
    L.castShadow = true;
    L.shadow.mapSize.set(512, 512);
  }

  // まとめて描き終わったら、描画先・環境マップ・影の地図を捨てる（マテリアルは次に開いたとき用に残す）
  end() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.env?.dispose();
    this.light?.shadow.map?.dispose();
    this.light?.dispose();
    this.rtA = this.rtB = null;
    this.env = null;
    this.light = null;
  }

  // 1枚描いて、画素（上の行から、RGBA）を返す。返す配列は次に描くと上書きされる
  render(spec: ThumbSpec): Uint8Array {
    this.begin();
    const r = this.renderer;
    const g0 = performance.now();
    const model = buildModel(spec);
    this.genMs = performance.now() - g0;
    const scene = new THREE.Scene();
    scene.environment = this.env!.texture;
    const meshes: THREE.Mesh[] = [];
    const add = (g: THREE.BufferGeometry | null, m: THREE.Material, shadow: boolean) => {
      if (!g) return;
      const me = new THREE.Mesh(g, m);
      me.castShadow = shadow;
      me.receiveShadow = true;
      scene.add(me);
      meshes.push(me);
    };
    add(model.geo, this.mat, true);
    if (model.pond) add(model.pond, (this.pondMat ??= createPondMaterial()), false);
    if (model.fall) add(model.fall, (this.fallMat ??= createFallMaterial()), false);

    // 形を囲む箱から、カメラの向きと写す範囲を決める（建物が真ん中で、枠いっぱいに写るように）
    const box = new THREE.Box3().setFromBufferAttribute(model.geo.getAttribute('position') as THREE.BufferAttribute);
    const ctr = box.getCenter(new THREE.Vector3());
    const rad = box.getSize(new THREE.Vector3()).length() / 2;
    // 細長いもの（空港・緑道など）は、長い辺が横になる向きから見る。
    // とても細長いもの（空港）は、上から見下ろして両端を切り、真ん中を大きく写す
    const ratio = Math.max(model.w / model.h, model.h / model.w), long = ratio > 3.5;
    const az = model.h / model.w > 2.2 ? Math.PI / 2 - 0.42 : model.w / model.h > 2.2 ? 0.42 : AZ;
    const el = long ? (55 * Math.PI) / 180 : EL;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, rad * 4 + 10);
    cam.position.copy(ctr).addScaledVector(dir, rad * 2 + 5);
    cam.lookAt(ctr);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse, v = new THREE.Vector3(), P = model.geo.getAttribute('position');
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(inv);
      if (v.x < x0) x0 = v.x;
      if (v.x > x1) x1 = v.x;
      if (v.y < y0) y0 = v.y;
      if (v.y > y1) y1 = v.y;
    }
    const half = long ? Math.max((y1 - y0) * 0.58, (x1 - x0) * 0.22) : (Math.max(x1 - x0, y1 - y0) / 2) * 1.04;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    cam.left = cx - half; cam.right = cx + half; cam.bottom = cy - half; cam.top = cy + half;
    cam.updateProjectionMatrix();

    // 太陽と影（形を囲む球がちょうど入る範囲）
    const L = this.light!;
    L.position.copy(ctr).addScaledVector(SUN, rad + 10);
    L.target.position.copy(ctr);
    const sc = L.shadow.camera;
    sc.left = -rad; sc.right = rad; sc.bottom = -rad; sc.top = rad; sc.near = 1; sc.far = rad * 2 + 20;
    sc.updateProjectionMatrix();
    L.shadow.normalBias = ((rad * 2) / 512) * 0.9 + 0.04;
    L.shadow.bias = -0.0005;
    scene.add(L, L.target);

    // 共有の値（昼夜で変わる）を昼にして描く
    const d = this.day;
    const saved = saveSet([
      [shared.uNight, 0], [shared.uSunDir, SUN], [shared.uSunCol, d.sunCol], [shared.uSkyTop, d.skyTop], [shared.uSkyHz, d.sky],
      [shared.uCity, d.city], [shared.uAmbSky, d.ambSky], [shared.uAmbGround, d.ambGround], [shared.uAmbSun, d.ambSun],
      [pondUniforms.uNight, 0], [pondUniforms.uSky, d.sky], [gardenU.uGLn, 0], [gardenU.uFalln, 0],
    ]);
    const prevRT = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    try {
      r.setRenderTarget(this.rtA);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      r.render(scene, cam);
      this.outMat.uniforms.tDiffuse.value = this.rtA!.texture;
      r.setRenderTarget(this.rtB);
      r.render(this.quadScene, this.quadCam);
      r.readRenderTargetPixels(this.rtB!, 0, 0, THUMB_PX, THUMB_PX, this.buf);
    } finally {
      r.setRenderTarget(prevRT);
      r.setClearColor(prevClear, prevAlpha);
      restore(saved);
      scene.remove(L, L.target);
      for (const me of meshes) me.geometry.dispose();
    }
    // 読み出した画素は下の行からなので、上下を入れかえる
    const out = new Uint8Array(this.buf.length), row = THUMB_PX * 4;
    for (let y = 0; y < THUMB_PX; y++) out.set(this.buf.subarray((THUMB_PX - 1 - y) * row, (THUMB_PX - y) * row), y * row);
    return out;
  }

  dispose() {
    this.end();
    this.mat.dispose();
    this.pondMat?.dispose();
    this.fallMat?.dispose();
    this.outMat.dispose();
    this.quad.geometry.dispose();
  }
}
