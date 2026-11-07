// 大公園の池：静かな水面（空が映り、さざ波は小さい）と、なめらかな曲線の岸辺。
// 頂点ごとに「池らしさ」の値を持たせ、シェーダーでその値のしきい値を境に岸と水面を切り分ける
// （三角形の中で値がなめらかに変わるので、岸の形が四角にならない）。
import * as THREE from 'three';

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
  get empty() {
    return this.idx.length === 0;
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

export function createGlowMaterial() {
  return new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
}

export function createPondMaterial() {
  const m = new THREE.MeshPhongMaterial({ color: 0xffffff, specular: 0x5a646c, shininess: 90 });
  const U = pondUniforms;
  const T = LAKE_T.toFixed(3), SH = SHORE.toFixed(3);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLk;\nvarying float vLk;\nvarying vec3 vPw;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvLk = aLk;\nvPw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uNight; uniform vec3 uSky;
        varying float vLk; varying vec3 vPw;
        float ph(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float wv(vec2 p, vec2 d, float f, float sp){ return sin(dot(p, d) * f + uTime * sp); }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vLk < ${T} - ${SH}) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wet = smoothstep(${T} - 0.006, ${T} + 0.006, vLk); // 0 = 岸辺、1 = 水面
        // 岸辺：砂利と小石（ところどころ色の違う石）。水ぎわは濡れて暗い
        vec2 q = floor(vPw.xz * 1.6);
        float n1 = ph(q), n2 = ph(floor(vPw.xz * 0.55) + 7.0);
        vec3 shore = mix(vec3(0.60, 0.57, 0.50), vec3(0.47, 0.46, 0.43), n1 * 0.7 + n2 * 0.3);
        shore *= mix(1.0, 0.68, smoothstep(${T} - 0.025, ${T}, vLk));
        // 草との境目は少し緑がかる
        shore = mix(shore, vec3(0.36, 0.45, 0.25), 1.0 - smoothstep(${T} - ${SH}, ${T} - ${SH} + 0.02, vLk));
        // 水面：浅いところは緑がかった茶色、深いところは暗い青緑。岸の近くには木の影が映ったような濃い緑
        float dk = smoothstep(${T}, ${T} + 0.32, vLk);
        vec3 water = mix(vec3(0.10, 0.15, 0.10), vec3(0.018, 0.05, 0.06), dk);
        water = mix(water, vec3(0.035, 0.075, 0.045), (1.0 - smoothstep(${T}, ${T} + 0.07, vLk)) * 0.55);
        diffuseColor.rgb = mix(shore, water, wet);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        specularStrength = wet * (1.0 - uNight * 0.85);
        {
          // 静かな池：ごく小さなさざ波だけ
          vec2 p = vPw.xz;
          float dx = 0.006 * wv(p, vec2(0.8, 0.6), 0.35, 0.7) + 0.004 * wv(p, vec2(-0.3, 0.95), 0.9, 1.3);
          float dz = 0.006 * wv(p, vec2(0.6, -0.8), 0.31, 0.6) + 0.004 * wv(p, vec2(0.95, 0.3), 0.8, 1.1);
          vec3 wn = normalize(vec3(dx * wet, 1.0, dz * wet));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // 鏡のように空が映る（斜めから見るほど強い）
          vec3 Vv = normalize(vViewPosition);
          float fres = 0.06 + 0.94 * pow(1.0 - max(dot(Vv, normal), 0.0), 4.0);
          totalEmissiveRadiance += uSky * fres * 0.3 * wet * (1.0 - uNight * 0.9);
        }`);
  };
  return m;
}
