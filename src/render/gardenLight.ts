// 庭園などの夜の明かり（石灯籠・東屋の行灯・木のライトアップ・公園の街灯）と、滝つぼの波紋の位置。
// 街じゅうの明かりのうち、画面の中心に近いものを GL_MAX 個まで選んでシェーダーに渡す。
// 受け取る側：木（下から照らされる）、庭の苔や石（灯籠のまわりが明るい）、池の水面（明かりが映る）、滝
import * as THREE from 'three';

export const GL_MAX = 16;
const FALL_MAX = 4;

export const gardenU = {
  // 明かりの位置と届く半径。半径が負なら上向きのライトアップ（光より上だけを照らす）
  uGL: { value: Array.from({ length: GL_MAX }, () => new THREE.Vector4()) },
  // 明かりの色と強さ（夜の暗さに合わせて強める）
  uGC: { value: Array.from({ length: GL_MAX }, () => new THREE.Vector3()) },
  uGLn: { value: 0 },
  // 選んだ明かりを全部囲む球（遠いところは計算を飛ばす）
  uGLB: { value: new THREE.Vector4(0, 0, 0, -1) },
  // 滝つぼ（xyz と強さ）。水面に波紋と白い泡を出す
  uFall: { value: Array.from({ length: FALL_MAX }, () => new THREE.Vector4()) },
  uFalln: { value: 0 },
};

// 明かりから届く光（P = 世界の位置、N = 世界の向きの法線、wrap = 葉のように光が回りこむ度合い）
export const GARDEN_LIGHT_PARS = /* glsl */ `
#define GDN_LMAX ${GL_MAX}
uniform vec4 uGL[GDN_LMAX];
uniform vec3 uGC[GDN_LMAX];
uniform int uGLn;
uniform vec4 uGLB;
vec3 gardenLight(vec3 P, vec3 N, float wrap) {
  vec3 acc = vec3(0.0);
  if (uGLn == 0) return acc;
  vec3 db = P - uGLB.xyz;
  if (dot(db, db) > uGLB.w * uGLB.w) return acc;
  for (int i = 0; i < GDN_LMAX; i++) {
    if (i >= uGLn) break;
    vec4 L = uGL[i];
    vec3 d = L.xyz - P;
    float r = abs(L.w);
    float d2 = dot(d, d);
    if (d2 > r * r) continue;
    vec3 l = d * inversesqrt(max(d2, 1e-4));
    float nl = clamp((dot(N, l) + wrap) / (1.0 + wrap), 0.0, 1.0);
    float x = d2 / (r * r);
    float att = (1.0 - x) * (1.0 - x) / (1.0 + d2 * 0.08);
    // ライトアップ：光より上のものだけ（足もとの地面はほとんど照らさない）
    if (L.w < 0.0) att *= smoothstep(0.15, 0.7, -l.y);
    acc += uGC[i] * nl * att;
  }
  return acc;
}`;

export const FALL_PARS = /* glsl */ `
#define FALL_MAX ${FALL_MAX}
uniform vec4 uFall[FALL_MAX];
uniform int uFalln;`;

export function gardenUniforms(u: Record<string, THREE.IUniform>) {
  u.uGL = gardenU.uGL;
  u.uGC = gardenU.uGC;
  u.uGLn = gardenU.uGLn;
  u.uGLB = gardenU.uGLB;
}

export function fallUniforms(u: Record<string, THREE.IUniform>) {
  u.uFall = gardenU.uFall;
  u.uFalln = gardenU.uFalln;
}

// 明かりの並び：x, y, z, 半径（負ならライトアップ）, r, g, b（7つずつ）。滝つぼ：x, y, z, 強さ（4つずつ）
export const LIGHT_STRIDE = 7;
const order: number[] = [];
const dist: number[] = [];

// 画面の中心（cx, cz）に近い明かりと滝つぼを選ぶ。夜でなければ明かりは使わない
export function updateGardenLights(L: number[], falls: number[], cx: number, cz: number, night: number) {
  const n = L.length / LIGHT_STRIDE;
  let cnt = 0;
  if (night > 0.02 && n > 0) {
    order.length = 0;
    dist.length = n;
    for (let k = 0; k < n; k++) {
      const dx = L[k * LIGHT_STRIDE] - cx, dz = L[k * LIGHT_STRIDE + 2] - cz;
      dist[k] = dx * dx + dz * dz;
      order.push(k);
    }
    if (n > GL_MAX) order.sort((a, b) => dist[a] - dist[b]);
    cnt = Math.min(GL_MAX, n);
    let bx = 0, by = 0, bz = 0;
    for (let i = 0; i < cnt; i++) {
      const o = order[i] * LIGHT_STRIDE;
      gardenU.uGL.value[i].set(L[o], L[o + 1], L[o + 2], L[o + 3]);
      gardenU.uGC.value[i].set(L[o + 4] * night, L[o + 5] * night, L[o + 6] * night);
      bx += L[o] / cnt; by += L[o + 1] / cnt; bz += L[o + 2] / cnt;
    }
    let br = 0;
    for (let i = 0; i < cnt; i++) {
      const v = gardenU.uGL.value[i];
      br = Math.max(br, Math.hypot(v.x - bx, v.y - by, v.z - bz) + Math.abs(v.w) + 1);
    }
    gardenU.uGLB.value.set(bx, by, bz, br);
  }
  gardenU.uGLn.value = cnt;
  // 滝つぼ（昼も夜も）
  const nf = falls.length / 4;
  let fc = 0;
  if (nf > 0) {
    const fo = Array.from({ length: nf }, (_, k) => k);
    if (nf > FALL_MAX) fo.sort((a, b) => Math.hypot(falls[a * 4] - cx, falls[a * 4 + 2] - cz) - Math.hypot(falls[b * 4] - cx, falls[b * 4 + 2] - cz));
    fc = Math.min(FALL_MAX, nf);
    for (let i = 0; i < fc; i++) {
      const o = fo[i] * 4;
      gardenU.uFall.value[i].set(falls[o], falls[o + 1], falls[o + 2], falls[o + 3]);
    }
  }
  gardenU.uFalln.value = fc;
}
