// マテリアル（建物の窓はシェーダーで描く）
// 光の計算は PBR（MeshStandardMaterial）。面ごとの粗さ・金属らしさ・ガラスの反射は、模様と素材の番号からシェーダーの中で決める
import * as THREE from 'three';
import { detailTexture, MAT_TILE_M } from './textures';

export const shared = {
  uNight: { value: 0 },
  // ガラスの映り込み用（昼夜で変わる）
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
  uSunCol: { value: new THREE.Color(1, 0.95, 0.85) },
  uSkyTop: { value: new THREE.Color(0.45, 0.62, 0.85) },
  uSkyHz: { value: new THREE.Color(0.75, 0.82, 0.9) },
  // ガラスに映る向かいの建物や街並みの明るさ
  uCity: { value: new THREE.Color(0.16, 0.17, 0.18) },
  // まわりからの光（環境マップのいちばんぼけた段と同じ値。建物ではテクスチャを読まずに式で求める）
  uAmbSky: { value: new THREE.Color(0.2, 0.24, 0.29) },
  uAmbGround: { value: new THREE.Color(0.05, 0.045, 0.035) },
  uAmbSun: { value: new THREE.Color(0, 0, 0) },
  uTime: { value: 0 }, // 光の冠の色を変えるのに使う（秒）
};

// 素材の番号（textures.ts の MAT）ごとの粗さと金属らしさ
// none, brick, concrete, plaster, siding, metal, membrane, gravel, shingle, ground
const ROUGH = [0.6, 0.9, 0.85, 0.8, 0.58, 0.55, 0.66, 0.95, 0.8, 0.92];
const METAL = [0.0, 0.0, 0.0, 0.0, 0.0, 0.35, 0.0, 0.0, 0.0, 0.0];
const arr = (a: number[]) => `float[${a.length}](${a.map((v) => v.toFixed(3)).join(', ')})`;

export function createBuildingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = shared.uNight;
    sh.uniforms.uSunDir = shared.uSunDir;
    sh.uniforms.uSunCol = shared.uSunCol;
    sh.uniforms.uSkyTop = shared.uSkyTop;
    sh.uniforms.uSkyHz = shared.uSkyHz;
    sh.uniforms.uCity = shared.uCity;
    sh.uniforms.uAmbSky = shared.uAmbSky;
    sh.uniforms.uAmbGround = shared.uAmbGround;
    sh.uniforms.uAmbSun = shared.uAmbSun;
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uDetail = { value: detailTexture() };
    sh.uniforms.uTile = { value: MAT_TILE_M };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aUvm;
        attribute float aPat;
        attribute float aMat;
        varying float vMat;
        varying vec2 vUvm;
        varying float vPat;
        varying vec3 vWp;
        varying float vNy;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vUvm = aUvm;
        vPat = aPat;
        vMat = aMat;
        vNy = normal.y;
        vWp = (modelMatrix * vec4(position, 1.0)).xyz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform vec3 uSunDir;
        uniform vec3 uSunCol;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHz;
        uniform vec3 uCity;
        uniform vec3 uAmbSky;
        uniform vec3 uAmbGround;
        uniform vec3 uAmbSun;
        uniform float uTime;
        // ガラスの映り込みに使う値（色を決めるところで決め、光の計算のところで使う）
        float gWin = 0.0;
        float gRefl = 0.0;
        vec3 gTint = vec3(0.0);
        float gGlow = 0.0;
        float gPane = 0.5;
        float gLit = 0.0;
        vec3 gLed = vec3(0.0);
        // PBR の値（面ごと）
        float gRough = 0.8;
        float gMetal = 0.0;
        float gAO = 1.0;
        uniform highp sampler2DArray uDetail;
        uniform float uTile[10];
        const float ROUGH[10] = ${arr(ROUGH)};
        const float METAL[10] = ${arr(METAL)};
        varying float vMat;
        varying vec2 vUvm;
        varying float vPat;
        varying vec3 vWp;
        varying float vNy;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        // a..b の範囲なら 1（ふちはなめらかにして、ギザギザとちらつきを抑える）
        float box1(float a, float b, float x, float w){ return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }
        // 窓のマスク: (u, v) はメートル、sp=間隔、ww=窓の幅、fh=階高、wh=窓の高さ、sill=窓の下端
        float winMask(vec2 uv, float sp, float ww, float fh, float wh, float sill){
          vec2 f = vec2(mod(uv.x, sp), mod(uv.y, fh));
          float x0 = (sp - ww) * 0.5;
          vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
          return box1(x0, x0 + ww, f.x, w.x) * box1(sill, sill + wh, f.y, w.y);
        }
        // 窓の上側の影（壁の奥にあるように見せる）
        float winTopShade(vec2 uv, float fh, float wh, float sill){
          float fy = mod(uv.y, fh);
          return smoothstep(sill + wh - 0.35, sill + wh, fy);
        }`,
      )
      .replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>
        // 映り込む空（環境マップ。なければ空の色の式）
        vec3 envSky(vec3 Rw, float rough){
          #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_PMREM )
            return textureLod(envMap, envMapRotation * Rw, roughnessToMip(rough)).rgb * envMapIntensity;
          #else
            return Rw.y > 0.0 ? mix(uSkyHz, uSkyTop, pow(Rw.y, 0.6)) : mix(uSkyHz * 0.6, uAmbGround * 3.0, clamp(-Rw.y * 4.0, 0.0, 1.0));
          #endif
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // 素材の模様（レンガ、コンクリート、屋上など）。壁は面の座標、上を向いた面は世界の座標で貼る
        float mat = floor(vMat + 0.5);
        int mi = int(mat);
        gRough = ROUGH[mi];
        gMetal = METAL[mi];
        if (mat > 0.5) {
          vec2 tuv = vNy > 0.2 ? vWp.xz : (abs(vUvm.x) + abs(vUvm.y) > 0.0001 ? vUvm : vec2(vWp.x + vWp.z, vWp.y));
          float det = texture(uDetail, vec3(tuv / uTile[mi], mat - 1.0)).r * 1.6;
          diffuseColor.rgb *= mix(1.0, det, 0.9);
          // 汚れて暗いところは少しざらざら、明るいところは少しなめらか
          gRough = clamp(gRough + (1.0 - det) * 0.25, 0.08, 1.0);
        }
        // 塗った金属（色の濃いもの）は金属らしさを弱める
        {
          vec3 c = vColor.rgb;
          float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
          gMetal *= 1.0 - smoothstep(0.1, 0.4, (mx - mn) / max(mx, 1e-3));
        }
        float pat = floor(vPat + 0.5);
        float aband = 0.0;
        if (pat > 19.5) { pat -= 20.0; aband = 1.0; }
        float win = 0.0;
        float lit = 0.0;
        vec2 uv = vUvm;
        vec2 cellId = vec2(0.0);
        float frame = 0.0;
        float shade = 0.0;
        float metalPart = 0.0; // 窓枠などの金属の部分
        if (pat > 0.5) {
          if (pat < 1.5) { // 住宅
            win = winMask(uv, 3.6, 1.3, 3.0, 1.3, 0.9);
            frame = winMask(uv + vec2(0.0, 0.12), 3.6, 1.6, 3.0, 1.55, 0.9) - win;
            shade = winTopShade(uv, 3.0, 1.3, 0.9);
            cellId = floor(vec2(uv.x / 3.6, uv.y / 3.0));
          } else if (pat < 2.5) { // 店舗: 1階はショーウィンドウ
            if (uv.y < 3.6) {
              float f = mod(uv.x, 2.4);
              vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
              win = box1(0.12, 2.28, f, w.x) * box1(0.35, 2.9, uv.y, w.y);
              cellId = vec2(floor(uv.x / 2.4), 0.0);
            } else {
              win = winMask(uv - vec2(0.0, 0.6), 3.0, 1.4, 3.0, 1.5, 0.9);
              frame = winMask(uv - vec2(0.0, 0.48), 3.0, 1.7, 3.0, 1.75, 0.9) - win;
              cellId = floor(vec2(uv.x / 3.0, (uv.y - 0.6) / 3.0));
            }
          } else if (pat < 3.5) { // オフィス
            win = winMask(uv, 1.6, 1.35, 3.4, 2.2, 0.7);
            shade = winTopShade(uv, 3.4, 2.2, 0.7) * 0.6;
            cellId = floor(vec2(uv.x / 1.6, uv.y / 3.4));
          } else if (pat < 4.5) { // 工場: 高い位置の横長窓
            float f = mod(uv.y, 7.0);
            vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
            win = box1(4.2, 5.6, f, w.y) * box1(0.5, 3.5, mod(uv.x, 4.0), w.x);
            cellId = floor(vec2(uv.x / 4.0, uv.y / 7.0));
          } else if (pat < 5.5) { // 集合住宅
            win = winMask(uv, 2.8, 1.5, 3.0, 1.5, 0.9);
            frame = winMask(uv + vec2(0.0, 0.12), 2.8, 1.8, 3.0, 1.75, 0.9) - win;
            shade = winTopShade(uv, 3.0, 1.5, 0.9);
            cellId = floor(vec2(uv.x / 2.8, uv.y / 3.0));
          } else if (pat > 6.5 && pat < 7.5) { // カーテンウォール
            vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
            float fy = mod(uv.y, 3.7);
            float spandrel = 1.0 - box1(0.8, 3.7, fy, w.y);
            float mull = 1.0 - box1(0.05, 1.45, mod(uv.x, 1.5), w.x);
            win = (1.0 - spandrel) * (1.0 - mull);
            // スパンドレル（階の間）は少し暗い不透明のガラス、窓枠は明るい金属
            diffuseColor.rgb = mix(diffuseColor.rgb * 0.5, vec3(0.62, 0.65, 0.68), mull);
            metalPart = mull;
            frame = 0.0;
            cellId = floor(vec2(uv.x / 4.5, uv.y / 3.7));
            gRefl = 1.25;
            // 不透明のガラスも、少し映り込む
            gWin = spandrel * (1.0 - mull) * 0.55;
          } else if (pat > 7.5 && pat < 8.5) { // 横長の連続窓
            vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
            float fy = mod(uv.y, 3.7);
            float band = 1.0 - box1(1.15, 3.35, fy, w.y);
            float mull = 1.0 - box1(0.04, 1.76, mod(uv.x, 1.8), w.x);
            win = (1.0 - band) * (1.0 - mull);
            vec3 bandCol = mix(vec3(0.86, 0.86, 0.84), diffuseColor.rgb, 0.2);
            diffuseColor.rgb = mix(diffuseColor.rgb * 0.6, bandCol, band);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.57, 0.6), mull * (1.0 - band));
            metalPart = mull * (1.0 - band);
            // 帯は白い金属の板（少しつやがある）
            gRough = mix(gRough, 0.4, band);
            cellId = floor(vec2(uv.x / 5.4, uv.y / 3.7));
            gRefl = 1.05;
          } else if (pat > 8.5 && pat < 9.5) { // 高層マンションのバルコニー
            vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
            float fy = mod(uv.y, 3.1);
            float slab = 1.0 - box1(0.28, 3.1, fy, w.y);
            float rail = box1(0.28, 1.3, fy, w.y);
            float pier = 1.0 - box1(0.5, 6.7, mod(uv.x, 7.2), w.x);
            float wn = box1(1.3, 2.95, fy, w.y) * (1.0 - pier);
            float mull = 1.0 - box1(0.05, 2.35, mod(uv.x, 2.4), w.x);
            win = wn * (1.0 - mull * 0.85);
            vec3 wallc = diffuseColor.rgb;
            diffuseColor.rgb = mix(wallc * 0.55, vec3(0.9, 0.9, 0.88), slab);
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.55, 0.68, 0.7), wallc, 0.3), rail * (1.0 - pier) * (1.0 - slab));
            diffuseColor.rgb = mix(diffuseColor.rgb, wallc, pier * (1.0 - slab));
            // 床の帯は白く塗ったコンクリート（なめらか）
            gRough = mix(gRough, 0.55, slab);
            cellId = floor(vec2(uv.x / 7.2, uv.y / 3.1));
            gRefl = 0.9;
            // ガラスの手すりも少し映り込む
            gWin = rail * (1.0 - pier) * (1.0 - slab) * 0.45;
          } else if (pat > 9.5 && pat < 10.5) { // ほぼガラスだけの外壁
            vec2 w = max(fwidth(uv) * 0.7, vec2(1e-4));
            float fy = mod(uv.y, 3.8);
            float line = 1.0 - box1(0.07, 3.8, fy, w.y);
            float mull = 1.0 - box1(0.035, 1.465, mod(uv.x, 1.5), w.x);
            win = 1.0 - max(line, mull) * 0.75;
            diffuseColor.rgb = mix(diffuseColor.rgb * 0.5, vec3(0.5, 0.53, 0.56), max(line, mull));
            metalPart = max(line, mull);
            cellId = floor(vec2(uv.x / 4.5, uv.y / 3.8));
            gRefl = 1.35;
          } else if (pat > 11.5 && pat < 12.5) { // 夜に照明で明るくなる面
            gLit = 1.0;
          } else if (pat > 12.5 && pat < 13.5) { // 夜に色がゆっくり変わる LED の面（光の冠）
            float hue = fract(uTime * 0.02 + vWp.y * 0.004 + (vWp.x + vWp.z) * 0.001);
            vec3 rgb = clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
            gLed = mix(vec3(1.0), rgb, 0.85);
            // 縦の細いすき間（穴のあいた金属の板）
            float slit = 1.0 - box1(0.08, 0.92, fract(uv.x / 1.2), max(fwidth(uv.x) * 0.7, 1e-4));
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6, slit);
            metalPart = 0.7;
          } else if (pat > 10.5 && pat < 11.5) { // 夜に光る帯
            gGlow = 1.0;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.82, 0.85), 0.5);
            metalPart = 0.5;
          } else { // 搬入口
            float f = mod(uv.x, 6.0);
            float door = step(1.0, f) * step(f, 5.0) * step(uv.y, 4.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45, 0.47, 0.5), door);
            metalPart = door * 0.6;
            win = 0.0;
          }
          float r = h21(cellId + floor(vWp.xz * 0.05));
          vec3 glass = mix(vec3(0.13, 0.17, 0.23), vec3(0.32, 0.4, 0.5), r * 0.6);
          bool modern = pat > 6.5 && pat < 10.5;
          // 近代的なガラスは、建物の色（ガラスの色合い）を暗くしたもの。映り込みは光の計算のところで足す
          // 一枚もののガラス：マスごとの色のばらつきはつけない（モザイクに見えないように）
          if (modern) glass = vColor.rgb * 0.42;
          // ふつうの窓：奥の部屋が見えて暗い（映り込みは光の計算で足す）
          if (!modern) glass = mix(glass, vec3(0.6, 0.7, 0.82), (0.08 + 0.07 * r) * (1.0 - uNight));
          // 空き家は窓が暗く、板でふさがれている
          if (aband > 0.5) glass = r > 0.5 ? vec3(0.28, 0.2, 0.12) : vec3(0.04);
          glass *= 1.0 - shade * 0.45;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.85, 0.82), clamp(frame, 0.0, 1.0) * 0.55 * (1.0 - aband));
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
          lit = win * step(0.45, r) * (1.0 - aband);
          if (modern) {
            // オフィスは天井の照明が帯のように光る（窓の上側が明るい）
            float fy2 = mod(uv.y, abs(pat - 9.0) < 0.5 ? 3.1 : abs(pat - 10.0) < 0.5 ? 3.8 : 3.7);
            lit *= 0.65 + 0.6 * smoothstep(2.2, 3.4, fy2);
          }
          if (gRefl < 0.01) gRefl = pat < 3.5 && pat > 2.5 ? 0.55 : 0.3;
          gWin = max(gWin, win) * (1.0 - aband);
          gTint = vColor.rgb;
          // ガラス1枚ごとに、映り込みの明るさを少し変える（板ガラスのわずかなゆがみ）
          gPane = h21(floor(vec2(uv.x / 1.5, uv.y / 3.7)) + floor(vWp.xz * 0.03));
          // 近代的なガラスは一枚ものに見えるよう、ばらつきをごく小さくする
          if (modern) gPane = 0.5 + (gPane - 0.5) * 0.12;
          // 窓枠などの金属（アルミ）
          gRough = mix(gRough, 0.38, metalPart);
          gMetal = mix(gMetal, 0.6, metalPart);
          // ガラス：なめらか（1枚ごとにほんの少し違う）
          float gr = modern ? 0.07 + 0.05 * gPane : 0.1 + 0.08 * r;
          gRough = mix(gRough, gr, clamp(gWin, 0.0, 1.0));
          gMetal *= 1.0 - clamp(gWin, 0.0, 1.0);
          if (aband > 0.5) { gRough = max(gRough, 0.85); gMetal = 0.0; }
        }
        // 壁の根元の陰（地面や下の屋根との境目）。まわりからの光ほど強くさえぎられる
        if (vNy < 0.5) {
          float k = smoothstep(0.0, 5.0, vUvm.y);
          gAO = mix(0.5, 1.0, k);
          diffuseColor.rgb *= mix(0.86, 1.0, k);
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = gRough;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = gMetal;`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        if (gWin > 0.001) {
          // ガラスの反射率。高層ビルのガラスは熱をはね返す膜があり、ふつうの窓ガラスよりよく映る（膜の色が少しつく）
          vec3 f0 = (0.04 + 0.27 * gRefl) * mix(vec3(1.0), gTint / max(max(gTint.r, max(gTint.g, gTint.b)), 0.05), 0.3);
          material.specularColor = mix(material.specularColor, f0, clamp(gWin, 0.0, 1.0));
          material.specularColorBlended = mix(material.specularColorBlended, f0, clamp(gWin, 0.0, 1.0));
        }`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `
        // まわりからの光：環境マップのいちばんぼけた段と同じ式（テクスチャを読まないぶん軽い）
        vec3 nW = inverseTransformDirection(geometryNormal, viewMatrix);
        iblIrradiance += PI * (mix(uAmbGround, uAmbSky, 0.5 + 0.5 * nW.y) + uAmbSun * pow(0.5 + 0.5 * dot(nW, uSunDir), 3.0));
        {
          // 映り込み（環境マップを1回だけ読む）
          float rr = material.roughness;
          vec3 Rv = normalize(mix(reflect(-geometryViewDir, geometryNormal), geometryNormal, rr * rr * rr * rr));
          vec3 Rw = inverseTransformDirection(Rv, viewMatrix);
          if (gWin > 0.001) {
            // ガラス：上の方は空（雲や太陽のまわりも）、下の方は向かいのビルや街並み。
            // 見下ろしていてもガラスに空が映るよう、空の方へ持ち上げた向きで読む（上の階ほど空が多い）
            float upper = smoothstep(0.0, 120.0, vWp.y);
            vec3 Rs = normalize(vec3(Rw.x, abs(Rw.y) * 0.55 + 0.05 + 0.15 * upper, Rw.z));
            vec3 sky = envSky(Rs, rr);
            // 向かいのビルが映っているように、ところどころ暗くする（ブロック状のむらにならないよう、なめらかに）
            float city = 0.5 + 0.5 * sin(vWp.y * 0.045 + (vWp.x + vWp.z) * 0.013) * sin(vWp.y * 0.017 - vWp.x * 0.021 + 1.3);
            float skyAmt = clamp(smoothstep(-0.5, 0.15, Rw.y) * 0.55 + 0.4 + 0.25 * upper, 0.0, 1.0);
            vec3 ge = mix(uCity * (0.55 + 0.45 * city), sky, skyAmt) * (0.85 + 0.3 * gPane);
            // 窓枠などのガラスでない部分は、下の街並みを映した暗めの色（枠の線がガラスの上で見えるように）
            radiance += mix(uCity, ge, clamp(gWin, 0.0, 1.0));
          } else {
            radiance += envSky(Rw, rr);
          }
        }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= gAO;
        reflectedLight.indirectSpecular *= mix(1.0, gAO, 0.6);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.82, 0.5) * lit * uNight * 0.9;
        totalEmissiveRadiance += vec3(0.75, 0.88, 1.0) * gGlow * uNight * 1.4;
        totalEmissiveRadiance += gLed * uNight * 1.3;
        totalEmissiveRadiance += diffuseColor.rgb * gLit * uNight * 1.1;`,
      );
  };
  m.customProgramCacheKey = () => 'bld-pbr';
  return m;
}
