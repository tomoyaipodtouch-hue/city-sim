// 公園と庭園の池：静かな水面（空が映り、さざ波は小さい）と、なめらかな曲線の岸辺。
// 頂点ごとに「池らしさ」の値を持たせ、シェーダーでその値のしきい値を境に岸と水面を切り分ける
// （三角形の中で値がなめらかに変わるので、岸の形が四角にならない）。
// 水面は PBR（MeshStandardMaterial）：空の映り込みは環境マップから、角度による映り込みの強さはフレネルの式で決まる。
// 夜は灯籠などの明かりが水面に映り、滝つぼには波紋が広がる
import * as THREE from 'three';
import { GARDEN_LIGHT_PARS, FALL_PARS, gardenUniforms, fallUniforms, LIGHT_STRIDE } from './gardenLight';

export const LAKE_T = 0.95; // これより大きいところが水面
export const SHORE = 0.07; // 水面のまわりの岸辺（石と砂利）の幅（値の差）

// 池の形（マップ全体で決まっているので、隣どうしの公園で池がつながる）
export const cpLake = (x: number, z: number) =>
  Math.sin(x / 61 + 1.3) * Math.sin(z / 47 + 0.4) + 0.45 * Math.sin((x - z) / 33) +
  // 岸の形を自然な入り江や岬にする小さなゆらぎ
  0.13 * Math.sin(x / 17 + z / 23 + 0.7) + 0.09 * Math.sin(z / 11 - x / 29 + 2.1) + 0.05 * Math.sin((x + z) / 7.3);

export const pondUniforms = {
  uTime: { value: 0 },
  uSky: { value: new THREE.Color(0xa9cbe6) },
  uNight: { value: 0 },
};

type V3 = [number, number, number];

export class PondBuilder {
  pos: number[] = [];
  lk: number[] = [];
  idx: number[] = [];
  // 範囲の中で、池と岸辺にかかるところに細かい板を敷く
  add(X0: number, Z0: number, X1: number, Z1: number, y: number) {
    const S = 1.25;
    const nx = Math.max(1, Math.round((X1 - X0) / S)), nz = Math.max(1, Math.round((Z1 - Z0) / S));
    const sx = (X1 - X0) / nx, sz = (Z1 - Z0) / nz;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const x0 = X0 + i * sx, z0 = Z0 + j * sz, x1 = x0 + sx, z1 = z0 + sz;
        const v = [cpLake(x0, z0), cpLake(x1, z0), cpLake(x1, z1), cpLake(x0, z1)];
        if (Math.max(...v) < LAKE_T - SHORE) continue;
        const b = this.pos.length / 3;
        this.pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
        this.lk.push(...v);
        this.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
  }
  // 敷地の座標で範囲を区切って水面を敷く。field は敷地の座標の関数（値は cpLake と同じ尺度）、toWorld で世界の座標へ
  addLocal(x0: number, z0: number, x1: number, z1: number, y: number, field: (x: number, z: number) => number, toWorld: (x: number, y: number, z: number) => V3, S = 1) {
    const nx = Math.max(1, Math.round((x1 - x0) / S)), nz = Math.max(1, Math.round((z1 - z0) / S));
    const sx = (x1 - x0) / nx, sz = (z1 - z0) / nz;
    const F = new Float32Array((nx + 1) * (nz + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) F[j * (nx + 1) + i] = field(x0 + i * sx, z0 + j * sz);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * (nx + 1) + i;
        const v = [F[k], F[k + 1], F[k + nx + 2], F[k + nx + 1]];
        if (Math.max(...v) < LAKE_T - SHORE) continue;
        const xa = x0 + i * sx, za = z0 + j * sz, xb = xa + sx, zb = za + sz;
        const b = this.pos.length / 3;
        this.pos.push(...toWorld(xa, y, za), ...toWorld(xb, y, za), ...toWorld(xb, y, zb), ...toWorld(xa, y, zb));
        this.lk.push(...v);
        this.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
  }
  get empty() {
    return this.idx.length === 0;
  }
  // 夜の明かり（世界の座標）。r が負なら上向きのライトアップ。col は色と強さ
  lights: number[] = [];
  addLight(x: number, y: number, z: number, r: number, cr: number, cg: number, cb: number) {
    this.lights.push(x, y, z, r, cr, cg, cb);
  }
  // 滝つぼ（世界の座標）：水面の波紋と泡
  falls: number[] = [];
  // 滝の水の帯と、滝つぼの泡（世界の座標）。aF = (横の位置 0..1, 上からの位置 0..1, 0) か、泡は (中心からの x/R, z/R, 1)
  private fPos: number[] = [];
  private fNor: number[] = [];
  private fF: number[] = [];
  private fIdx: number[] = [];
  // 滝の水の帯：pts = 上から下への中心線、side = 横向き（単位ベクトル）、wid = 点ごとの幅
  fallSheet(pts: V3[], side: [number, number], wid: number[]) {
    const n = pts.length;
    const b = this.fPos.length / 3;
    for (let k = 0; k < n; k++) {
      const p = pts[k], q = pts[Math.min(n - 1, k + 1)], o = pts[Math.max(0, k - 1)];
      // 流れの向きと横向きから、表の向き（池の方）を求める
      const tx = q[0] - o[0], ty = q[1] - o[1], tz = q[2] - o[2];
      // n = t × s（s = (side[0], 0, side[1])）
      const nx = ty * side[1], ny = tz * side[0] - tx * side[1], nz = -ty * side[0];
      const l = Math.hypot(nx, ny, nz) || 1;
      const v = k / (n - 1);
      for (const u of [0, 1]) {
        const s = (u - 0.5) * wid[k];
        this.fPos.push(p[0] + side[0] * s, p[1], p[2] + side[1] * s);
        this.fNor.push(nx / l, ny / l, nz / l);
        this.fF.push(u, v, 0);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      const a = b + k * 2;
      this.fIdx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  // 滝つぼの泡（水面の上の円）
  foam(x: number, y: number, z: number, R: number) {
    const SEG = 20, b = this.fPos.length / 3;
    this.fPos.push(x, y, z);
    this.fNor.push(0, 1, 0);
    this.fF.push(0, 0, 1);
    for (let q = 0; q < SEG; q++) {
      const a = (q / SEG) * Math.PI * 2;
      this.fPos.push(x + Math.cos(a) * R, y, z + Math.sin(a) * R);
      this.fNor.push(0, 1, 0);
      this.fF.push(Math.cos(a), Math.sin(a), 1);
    }
    for (let q = 0; q < SEG; q++) this.fIdx.push(b, b + 1 + ((q + 1) % SEG), b + 1 + q);
  }
  fallGeometry(): THREE.BufferGeometry | null {
    if (!this.fIdx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.fPos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.fNor, 3));
    g.setAttribute('aF', new THREE.Float32BufferAttribute(this.fF, 3));
    g.setIndex(this.fIdx);
    g.computeBoundingSphere();
    return g;
  }
  // 夜の街灯の光だまり（中心が明るく、外へ向かって消える円）
  glows: number[] = [];
  addGlow(x: number, y: number, z: number) {
    this.glows.push(x, y, z);
  }
  glowGeometry(): THREE.BufferGeometry | null {
    if (!this.glows.length) return null;
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    // 中心から外へ：明るい → 半分ほど → 消える（2重の輪で、なめらかに暗くなる）
    const SEG = 16, RINGS: [number, number][] = [[2.4, 0.55], [4.6, 0.18], [6.5, 0]];
    for (let k = 0; k < this.glows.length; k += 3) {
      const [x, y, z] = [this.glows[k], this.glows[k + 1], this.glows[k + 2]];
      const c = pos.length / 3;
      pos.push(x, y, z);
      col.push(0.2, 0.15, 0.08);
      for (const [r, f] of RINGS)
        for (let q = 0; q < SEG; q++) {
          const a = (q / SEG) * Math.PI * 2;
          pos.push(x + Math.cos(a) * r, y, z + Math.sin(a) * r);
          col.push(0.2 * f, 0.15 * f, 0.08 * f);
        }
      for (let q = 0; q < SEG; q++) {
        const q1 = (q + 1) % SEG;
        idx.push(c, c + 1 + q1, c + 1 + q);
        for (let r = 0; r < RINGS.length - 1; r++) {
          const i0 = c + 1 + r * SEG, i1 = c + 1 + (r + 1) * SEG;
          idx.push(i0 + q, i0 + q1, i1 + q1, i0 + q, i1 + q1, i1 + q);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }
  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    const nor = new Float32Array(this.pos.length);
    for (let k = 1; k < nor.length; k += 3) nor[k] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aLk', new THREE.Float32BufferAttribute(this.lk, 1));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}
export { LIGHT_STRIDE };

export function createGlowMaterial() {
  return new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
}

// 小さな値ノイズ（滝と泡の模様）
const VNOISE = /* glsl */ `
float vh(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vh(i), vh(i + vec2(1.0, 0.0)), u.x), mix(vh(i + vec2(0.0, 1.0)), vh(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

export function createPondMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0 });
  const U = pondUniforms;
  const T = LAKE_T.toFixed(3), SH = SHORE.toFixed(3);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    gardenUniforms(sh.uniforms);
    fallUniforms(sh.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLk;\nvarying float vLk;\nvarying vec3 vPw;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvLk = aLk;\nvPw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uNight; uniform vec3 uSky;
        varying float vLk; varying vec3 vPw;
        ${GARDEN_LIGHT_PARS}
        ${FALL_PARS}
        ${VNOISE}
        float ph(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float wv(vec2 p, vec2 d, float f, float sp){ return sin(dot(p, d) * f + uTime * sp); }
        float gWet = 0.0;
        float gFoam = 0.0;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vLk < ${T} - ${SH}) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wet = smoothstep(${T} - 0.006, ${T} + 0.006, vLk); // 0 = 岸辺、1 = 水面
        gWet = wet;
        // 岸辺：砂利と小石（ところどころ色の違う石）。水ぎわは濡れて暗い
        vec2 q = floor(vPw.xz * 1.6);
        float n1 = ph(q), n2 = ph(floor(vPw.xz * 0.55) + 7.0);
        vec3 shore = mix(vec3(0.60, 0.57, 0.50), vec3(0.47, 0.46, 0.43), n1 * 0.7 + n2 * 0.3);
        shore *= mix(1.0, 0.68, smoothstep(${T} - 0.025, ${T}, vLk));
        // 草との境目は少し緑がかる
        shore = mix(shore, vec3(0.36, 0.45, 0.25), 1.0 - smoothstep(${T} - ${SH}, ${T} - ${SH} + 0.02, vLk));
        // 水面：浅いところは緑がかった茶色、深いところは暗い青緑。岸の近くには木の影が映ったような濃い緑
        float dk = smoothstep(${T}, ${T} + 0.32, vLk);
        vec3 water = mix(vec3(0.075, 0.11, 0.075), vec3(0.014, 0.038, 0.045), dk);
        water = mix(water, vec3(0.026, 0.056, 0.034), (1.0 - smoothstep(${T}, ${T} + 0.07, vLk)) * 0.55);
        // 滝つぼの白い泡（くずれながら広がる）
        for (int i = 0; i < FALL_MAX; i++) {
          if (i >= uFalln) break;
          vec2 fd = vPw.xz - uFall[i].xz;
          float r = length(fd);
          vec2 dir = fd / max(r, 1e-3);
          float n = vnoise(vPw.xz * 3.1 - dir * uTime * 0.9) * 0.6 + vnoise(vPw.xz * 7.3 + uTime * 0.4) * 0.4;
          gFoam += uFall[i].w * (1.0 - smoothstep(0.3, 1.9, r)) * smoothstep(0.38, 0.62, n + 0.25 * (1.0 - r));
        }
        gFoam = clamp(gFoam, 0.0, 1.0) * wet;
        water = mix(water, vec3(0.62, 0.66, 0.64), gFoam * 0.75);
        diffuseColor.rgb = mix(shore, water, wet);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.85, 0.08 + 0.4 * gFoam, gWet);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // 静かな池：ごく小さなさざ波だけ
          vec2 p = vPw.xz;
          float dx = 0.006 * wv(p, vec2(0.8, 0.6), 0.35, 0.7) + 0.004 * wv(p, vec2(-0.3, 0.95), 0.9, 1.3);
          float dz = 0.006 * wv(p, vec2(0.6, -0.8), 0.31, 0.6) + 0.004 * wv(p, vec2(0.95, 0.3), 0.8, 1.1);
          // 滝つぼから広がる波紋
          for (int i = 0; i < FALL_MAX; i++) {
            if (i >= uFalln) break;
            vec2 fd = p - uFall[i].xz;
            float r = length(fd);
            vec2 dir = fd / max(r, 1e-3);
            float a = uFall[i].w * 0.035 * exp(-r * 1.1) * smoothstep(0.2, 0.9, r);
            float w = cos(r * 5.5 - uTime * 4.2) + 0.5 * cos(r * 9.0 - uTime * 6.3 + 1.7);
            dx += a * w * dir.x;
            dz += a * w * dir.y;
          }
          vec3 wn = normalize(vec3(dx * gWet, 1.0, dz * gWet));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // 岸の木や土手が空をさえぎるので、岸に近いほど空の映り込みは弱い（中ほどは空がよく映る）
        reflectedLight.indirectSpecular *= mix(0.4, 0.75, smoothstep(${T}, ${T} + 0.3, vLk));
        if (uGLn > 0) {
          vec3 Nw = inverseTransformDirection(normal, viewMatrix);
          // 岸辺の石や泡は、明かりに照らされる
          reflectedLight.directDiffuse += gardenLight(vPw, Nw, 0.0) * material.diffuseColor;
          // 水面に映る明かり（灯籠・行灯・街灯）：さざ波でゆらめく光の筋。ライトアップの器具は低く隠れているので映さない
          vec3 Vw = normalize(cameraPosition - vPw);
          vec3 Rw = reflect(-Vw, Nw);
          float fres = 0.25 + 0.75 * pow(1.0 - max(dot(Vw, Nw), 0.0), 5.0);
          vec3 acc = vec3(0.0);
          for (int i = 0; i < GDN_LMAX; i++) {
            if (i >= uGLn) break;
            vec4 L = uGL[i];
            if (L.w < 0.0) continue;
            vec3 d = L.xyz - vPw;
            float d2 = dot(d, d);
            float s = max(dot(Rw, d * inversesqrt(max(d2, 1e-4))), 0.0);
            acc += uGC[i] * (pow(s, 800.0) * 9.0 + pow(s, 90.0) * 0.9) / (1.0 + d2 * 0.004);
          }
          reflectedLight.directSpecular += acc * fres * gWet;
        }`);
  };
  m.customProgramCacheKey = () => 'pond-pbr';
  return m;
}

// 滝の水の帯と、滝つぼの泡。上は透きとおった水、落ちるにつれて白い筋が増え、下は泡になる
export function createFallMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = pondUniforms.uTime;
    sh.uniforms.uNight = pondUniforms.uNight;
    gardenUniforms(sh.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aF;\nvarying vec3 vF;\nvarying vec3 vPw;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvF = aF;\nvPw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uNight;
        varying vec3 vF; varying vec3 vPw;
        ${GARDEN_LIGHT_PARS}
        ${VNOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vF.z < 0.5) {
          // 水の帯：上から下へ流れる筋
          float u = vF.x, v = vF.y;
          float s1 = vnoise(vec2(u * 7.0, v * 2.4 - uTime * 2.6));
          float s2 = vnoise(vec2(u * 19.0 + 3.1, v * 6.0 - uTime * 4.1));
          float st = s1 * 0.6 + s2 * 0.4;
          float edge = smoothstep(0.0, 0.14, u) * smoothstep(1.0, 0.86, u);
          float white = smoothstep(0.42, 0.72, st) * (0.45 + 0.55 * v);
          diffuseColor.rgb = mix(vec3(0.42, 0.5, 0.5), vec3(0.92, 0.95, 0.95), clamp(white + 0.15 + v * 0.3, 0.0, 1.0));
          diffuseColor.a = (0.5 + 0.45 * smoothstep(0.3, 0.7, st) + 0.2 * v) * edge * smoothstep(0.0, 0.06, v);
        } else {
          // 泡：中心は白く、外へ向かってくずれて消える
          float r = length(vF.xy);
          vec2 dir = vF.xy / max(r, 1e-3);
          float n = vnoise(vPw.xz * 3.6 - dir * uTime * 1.1) * 0.6 + vnoise(vPw.xz * 8.0 + uTime * 0.5) * 0.4;
          diffuseColor.rgb = vec3(0.88, 0.91, 0.9);
          diffuseColor.a = (1.0 - smoothstep(0.25, 1.0, r)) * smoothstep(0.35, 0.65, n + 0.3 * (1.0 - r)) * 0.85;
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        if (uGLn > 0) reflectedLight.directDiffuse += gardenLight(vPw, inverseTransformDirection(normal, viewMatrix), 0.6) * material.diffuseColor;`);
  };
  m.customProgramCacheKey = () => 'garden-fall';
  return m;
}
