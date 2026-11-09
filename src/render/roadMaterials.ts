// 道路のマテリアル：路面（アスファルト・コンクリート）、白線、歩道や壁
// 路面の頂点には aRd =（中心線からの横の位置 m、道に沿った位置 m、車道の半分の幅 m、模様の種類）を入れておく。
// 模様の種類 = 車線の数 + 4×素材（0 アスファルト / 1 コンクリート / 2 大通りのアスファルト）+ 16×縁石あり + 32×道ごとの乱数
// 交差点や円の路面は、横の位置 0、半分の幅の代わりに「ふちからの距離」を入れる
import * as THREE from 'three';
import { surfaceNoise, SURF_GLSL } from './surfaceNoise';
import { AO_DECL, aoExpr, aoUniforms } from './ao';
import { AMB_IRR_GLSL, AMB_IRR_PARS, ambUniforms } from './materials';

// avenue：大通り（車線が 3.25m と狭いので、縁石ぞいの側溝を細くする）
export const SURF = { asphalt: 0, concrete: 1, avenue: 2 } as const;
// 歩道・壁などの種類（aRd.w）。grass・hedge は大通りの中央分離帯の芝と植え込み
export const SOLID = { plain: 0, walk: 2, curb: 3, concrete: 4, grass: 5, hedge: 6 } as const;

export function surfCode(lanes: number, kind: number, curb: boolean, seed: number) {
  return lanes + 4 * kind + (curb ? 16 : 0) + 32 * (seed & 63);
}

function inject(m: THREE.Material, key: string, ao: number, body: string, decl = '') {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSurf = { value: surfaceNoise() };
    Object.assign(sh.uniforms, aoUniforms);
    ambUniforms(sh.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRd;\nvarying vec4 vRd;\nvarying vec3 vRw;\nvarying vec3 vRn;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvRw = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvRd = aRd;\nvRn = normalize(mat3(modelMatrix) * objectNormal);',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vRd;\nvarying vec3 vRw;\nvarying vec3 vRn;\n' + SURF_GLSL + AO_DECL + AMB_IRR_PARS + decl)
      // まわりからの光は式で（環境マップを読まない）
      .replace('#include <lights_fragment_maps>', AMB_IRR_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>\n{\n${body}\n}\n${ao > 0 ? `diffuseColor.rgb *= ${aoExpr('vRw', ao)};` : ''}`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

// 路面：骨材の粒、車輪のあとの黒ずみ、補修のあと、細いひび、縁石ぞいの側溝、道ごとの色の違い。
// コンクリートの路面（高速道路・高架）は、板の目地と板ごとの色の違い
export function createRoadSurfaceMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  return inject(m, 'road-surface-4', 0.32, `
    vec2 p = vRw.xz;
    float code = floor(vRd.w + 0.5);
    float lanes = mod(code, 4.0);
    float conc = mod(floor(code / 4.0), 4.0);
    float av = step(1.5, conc); // 大通り
    conc *= 1.0 - av;
    float gw = mix(0.42, 0.25, av); // 縁石ぞいの側溝の幅
    float curb = mod(floor(code / 16.0), 2.0);
    float seed = floor(code / 32.0);
    float lat = vRd.x;
    // 交差点など（車線なし）は、世界の座標で模様を置く
    float alg = lanes > 0.5 ? vRd.y : p.x;
    float acr = lanes > 0.5 ? lat : p.y;
    float de = vRd.z - abs(lat); // 路肩（縁石）からの距離
    float fw = max(length(fwidth(p)), 1e-3); // 1 画素の大きさ（m）
    float fa = max(fwidth(alg), 1e-4), fl = max(fwidth(acr), 1e-4);
    // 細かい模様（骨材の粒、車輪のあと、油のしみ、ひび、板の目地）は、1 画素が 0.5m より小さいときだけ描く。
    // 引いて見ると画素より小さくて見えないので、その分の計算とテクスチャの読み込みを省く（境目はなめらかに消す）
    float fine = 1.0 - smoothstep(0.3, 0.5, fw);
    vec2 pdx = dFdx(p), pdy = dFdy(p);
    vec4 nF = vec4(0.5), nC = vec4(0.5);
    if (fine > 0.0) {
      // 分岐の中なので、ミップマップの選び方は分岐の外で求めた変化量で決める
      nF = textureGrad(uSurf, p * (1.0 / 3.1), pdx * (1.0 / 3.1), pdy * (1.0 / 3.1));
      mat2 rC = mat2(0.6, 0.8, -0.8, 0.6) * (1.0 / 8.7);
      nC = textureGrad(uSurf, rC * p + 0.21, rC * pdx, rC * pdy);
    }
    vec4 nM = texture2D(uSurf, mat2(0.8, -0.6, 0.6, 0.8) * p * (1.0 / 23.0) + seed * 0.137);
    vec4 nL = texture2D(uSurf, p * (1.0 / 191.0) + 0.5);
    vec3 c = diffuseColor.rgb;
    // 道ごとの色の違い（舗装した時期の違い）
    float sv = sHash(vec2(seed * 0.37 + 0.11, 7.1));
    c *= 0.95 + 0.1 * sv;
    c *= mix(vec3(1.0), vec3(1.035, 1.0, 0.95), sHash(vec2(seed * 0.53 + 0.7, 3.3)));
    // 広いむらと汚れ
    c *= 0.88 + 0.24 * nL.a;
    c *= 0.9 + 0.2 * nM.g;
    // 車輪の通るところ（車線の中心の左右）の黒ずみと、車線の真ん中の油のしみ
    float trk = 0.0, oil = 0.0;
    if (lanes > 0.5 && fine > 0.0) {
      float span = vRd.z * 0.9;
      float lw = 2.0 * span / lanes;
      float x = lat + span;
      float lc = (fract(x / lw) - 0.5) * lw;
      float inside = 1.0 - smoothstep(span - 0.3, span, abs(lat));
      float var = 0.55 + 0.9 * nM.a;
      trk = (1.0 - smoothstep(0.1, 0.45 + fl, abs(abs(lc) - 0.85))) * inside * var * fine;
      oil = (1.0 - smoothstep(0.05, 0.35 + fl, abs(lc))) * inside * var * smoothstep(0.35, 0.65, nC.g) * fine;
      if (conc > 0.5) {
        // コンクリートの板：4.5m ごとの目地と、車線の境目の目地。板ごとに少し色が違う
        float ja = (fract(alg / 4.5 + 0.5) - 0.5) * 4.5;
        float jl = (fract(x / lw + 0.5) - 0.5) * lw;
        float joint = max(sLine(ja, 0.05, fa), sLine(jl, 0.04, fl) * inside);
        float slab = sHash(vec2(floor(alg / 4.5), floor(x / lw)) + seed * 0.07);
        c *= 1.0 + (slab - 0.5) * 0.09 * fine;
        c *= 1.0 - joint * 0.4 * fine;
      }
    }
    // 交差点の中：車の止まる真ん中ほど油で黒ずみ、むらがある
    if (lanes < 0.5) {
      c *= 1.0 - smoothstep(1.0, 4.0, de) * 0.07 * (0.5 + nC.g);
      c *= 0.94 + 0.12 * nC.a;
    }
    // 補修のあと（車線ごと、11m ごとに、ある確率で四角い継ぎはぎ）。数 m の大きさなので、もう少し引いても描く
    if (fw < 1.2) {
      vec2 cell = vec2(floor(alg / 11.0), floor((acr + 40.0) / 3.2));
      float h = sHash(cell + seed * 0.71 + 0.3);
      if (h < 0.16) {
        float u = alg - cell.x * 11.0, v = acr + 40.0 - cell.y * 3.2;
        float len = 1.6 + 6.0 * fract(h * 37.1), a0 = fract(h * 71.3) * (11.0 - len);
        float wid = 0.9 + 1.9 * fract(h * 53.7), b0 = fract(h * 19.9) * (3.2 - wid);
        float pt = sBox(a0, a0 + len, u, fa) * sBox(b0, b0 + wid, v, fl);
        float inner = sBox(a0 + 0.07, a0 + len - 0.07, u, fa) * sBox(b0 + 0.07, b0 + wid - 0.07, v, fl);
        float fresh = step(0.07, h); // 新しい継ぎはぎは黒く、古いものは明るい
        c = mix(c, c * (fresh > 0.5 ? 0.84 : 1.08), pt * (conc > 0.5 ? 0.5 : 1.0));
        c *= 1.0 - (pt - inner) * 0.35;
        trk *= 1.0 - pt * 0.6;
      }
    }
    // 細いひび（古い舗装のところだけ）
    float crack = nC.b * smoothstep(0.5, 0.7, nM.a + (sv - 0.5) * 0.3) * fine;
    // 縁石ぞいの側溝（コンクリートの帯）と、ごみのたまる黒ずみ。縁石のない道は路肩の汚れ
    if (curb > 0.5) {
      float gut = 1.0 - smoothstep(gw, gw + fw, de);
      c = mix(c, vec3(0.2, 0.196, 0.186) * (0.9 + 0.2 * nM.g), gut * 0.9);
      c *= 1.0 - sLine(de - gw, 0.04, fw) * 0.5;
      c *= 1.0 - (1.0 - smoothstep(gw, 1.0, de)) * (1.0 - gut) * 0.12 * (0.6 + 0.8 * nC.g);
      trk *= 1.0 - gut;
      crack *= 1.0 - gut;
    } else {
      c *= 1.0 - (1.0 - smoothstep(0.0, 0.7, de)) * 0.13 * (0.6 + 0.8 * nC.g);
    }
    // 骨材の粒（近くで見えるざらつき）。車輪のあとはすり減ってなめらか
    float grain = (nF.r - 0.5) * fine;
    c *= 1.0 + grain * (conc > 0.5 ? 0.16 : 0.42) * (1.0 - trk * 0.5);
    c *= 1.0 - trk * 0.16 - oil * 0.1;
    c *= 1.0 - crack * 0.3;
    diffuseColor.rgb = c;`);
}

// 白線・黄線：塗料のかすれ、骨材の粒が透けて見える
export function createMarkMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  return inject(m, 'road-marks-2', 0.32, `
    vec2 p = vRw.xz;
    vec4 nF = texture2D(uSurf, p * (1.0 / 2.3) + 0.4);
    vec4 nM = texture2D(uSurf, mat2(0.8, -0.6, 0.6, 0.8) * p * (1.0 / 11.0) + 0.17);
    float wear = smoothstep(0.52, 0.8, nM.g * 0.55 + nF.r * 0.45) * (0.6 + 0.5 * nM.a);
    vec3 c = diffuseColor.rgb;
    c = mix(c, vec3(0.085, 0.09, 0.095), clamp(wear, 0.0, 1.0) * 0.6);
    c *= 0.86 + 0.28 * nF.r;
    diffuseColor.rgb = c;`);
}

// 歩道（タイルの目地、縁石の石）、縁石の側面、コンクリートの壁・床版（細かいむらと雨の筋）
export function createRoadSolidMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  return inject(m, 'road-solid-4', 0.0, `
    float kind = floor(vRd.w + 0.5);
    // テクスチャと画素の大きさは、分岐の外で求める（分岐の中だとミップマップの選び方が乱れる）
    bool up = abs(vRn.y) > 0.5;
    // 縦の面は（横、高さ）、上を向いた面は世界の xz で模様を貼る
    vec2 q = up ? vRw.xz : vec2(vRw.x + vRw.z, vRw.y);
    vec4 nF = texture2D(uSurf, q * (1.0 / 2.9) + 0.3);
    vec4 nM = texture2D(uSurf, mat2(0.8, -0.6, 0.6, 0.8) * q * (1.0 / 17.0));
    float streak = texture2D(uSurf, vec2(q.x * (1.0 / 9.0), q.y * (1.0 / 60.0)) + 0.6).g;
    float fw = max(length(fwidth(vRw.xz)), 1e-3);
    float acr = vRd.x, alg = vRd.y;
    float fa = max(fwidth(alg), 1e-4), fl = max(fwidth(acr), 1e-4);
    if (kind > 1.5) {
      vec3 c = diffuseColor.rgb;
      if (kind < 2.5) {
        // 歩道：縁石の石（幅 0.2m）と、タイル（0.6m × 0.3m、半分ずつずらす）
        float stone = 1.0 - smoothstep(0.2 - fl, 0.2 + fl, acr);
        float row = floor((acr - 0.2) / 0.3);
        float ta = alg / 0.6 + mod(row, 2.0) * 0.5;
        float ga = (fract(ta + 0.5) - 0.5) * 0.6;
        float gl = (fract((acr - 0.2) / 0.3 + 0.5) - 0.5) * 0.3;
        float grout = max(sLine(ga, 0.025, fa), sLine(gl, 0.025, fl)) * (1.0 - stone);
        float tile = sHash(vec2(floor(ta), row) + 0.5);
        float near = 1.0 - smoothstep(0.08, 0.2, fw);
        c *= 1.0 + (tile - 0.5) * 0.1 * near * (1.0 - stone);
        c = mix(c, c * vec3(1.1, 1.1, 1.12), stone);
        c *= 1.0 - sLine(acr - 0.2, 0.03, fl) * 0.35;
        c *= 1.0 - grout * 0.22;
        // しみと汚れ
        c *= 0.92 + 0.16 * nM.g;
        c *= 1.0 - smoothstep(0.55, 0.8, nM.a) * 0.08;
        c *= 1.0 + (nF.r - 0.5) * 0.2;
      } else if (kind < 3.5) {
        // 縁石の側面
        c *= 1.0 + (nF.r - 0.5) * 0.18;
        c *= 0.94 + 0.12 * nM.g;
      } else if (kind < 4.5) {
        // コンクリート：細かいむらと、縦の面には雨の筋
        c *= 0.9 + 0.2 * nM.g;
        c *= 1.0 + (nF.r - 0.5) * 0.16;
        c *= 1.0 - smoothstep(0.5, 0.75, up ? 0.5 : streak) * 0.14;
      } else if (kind < 5.5) {
        // 分離帯の芝：まだらな緑と、ところどころ土の色
        float soil = smoothstep(0.62, 0.8, nM.a * 0.7 + nF.g * 0.3);
        c *= 0.82 + 0.3 * nM.g;
        c *= 1.0 + (nF.r - 0.5) * 0.35;
        c = mix(c, vec3(0.36, 0.3, 0.22), soil * 0.55);
      } else {
        // 植え込み：葉の明暗。下を向いた面ほど暗い
        c *= 0.7 + 0.55 * nF.r * (0.7 + 0.6 * nM.b);
        c *= 0.75 + 0.25 * clamp(vRn.y, 0.0, 1.0);
      }
      diffuseColor.rgb = c;
    }`);
}
