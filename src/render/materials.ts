// マテリアル（建物の窓はシェーダーで描く）
// 光の計算は PBR（MeshStandardMaterial）。面ごとの粗さ・金属らしさ・ガラスの反射は、模様と素材の番号からシェーダーの中で決める
import * as THREE from 'three';
import { detailTexture, MAT_TILE_M } from './textures';
import { surfaceNoise } from './surfaceNoise';
import { GARDEN_LIGHT_PARS, gardenUniforms } from './gardenLight';

export const shared = {
  uNight: { value: 0 },
  // 夜の更け具合（0 = 夜の早い時間 19〜21時、1 = 深夜 1〜4時）。窓の明かりの数を減らす
  uLate: { value: 0 },
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

// 高画質かどうか（CityRenderer.setQuality が決める）。ふつうの画質では、ガラス以外の映り込みを式で求めて軽くする
export const bldQuality = { hq: false };

// まわりからの光：環境マップのいちばんぼけた段と同じ値を式で求める（テクスチャを読まないぶん軽い）。
// Lambert・Phong のマテリアルの '#include <lights_fragment_maps>' と置きかえて使う
export const AMB_IRR_PARS = `
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uAmbSun;
uniform vec3 uSunDir;`;
export const AMB_IRR_GLSL = `
{
  vec3 nWa = inverseTransformDirection(geometryNormal, viewMatrix);
  iblIrradiance += PI * (mix(uAmbGround, uAmbSky, 0.5 + 0.5 * nWa.y) + uAmbSun * pow(0.5 + 0.5 * dot(nWa, uSunDir), 3.0));
}`;
export function ambUniforms(u: Record<string, THREE.IUniform>) {
  u.uAmbSky = shared.uAmbSky;
  u.uAmbGround = shared.uAmbGround;
  u.uAmbSun = shared.uAmbSun;
  u.uSunDir = shared.uSunDir;
}

// 素材の番号（textures.ts の MAT）ごとの粗さと金属らしさ
// none, brick, concrete, plaster, siding, metal, membrane, gravel, shingle, ground
const ROUGH = [0.6, 0.95, 0.85, 0.8, 0.58, 0.55, 0.66, 0.95, 0.95, 0.92];
const METAL = [0.0, 0.0, 0.0, 0.0, 0.0, 0.35, 0.0, 0.0, 0.0, 0.0];
const arr = (a: number[]) => `float[${a.length}](${a.map((v) => v.toFixed(3)).join(', ')})`;

export function createBuildingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    const hq = bldQuality.hq;
    sh.uniforms.uNight = shared.uNight;
    sh.uniforms.uLate = shared.uLate;
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
    sh.uniforms.uSurf = { value: surfaceNoise() };
    gardenUniforms(sh.uniforms);
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
        ${hq ? '#define BLD_HQ' : ''}
        uniform float uNight;
        uniform float uLate;
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
        // 庭（苔・小石・石・葉の房）と、夜にともる灯籠の火袋
        float gGarden = 0.0;
        float gFol = 0.0;
        vec3 gBump = vec3(0.0); // 畑の畝の凹凸（世界の向き）。光の計算の前に面の向きに足す
        float gGlowG = 0.0;
        ${GARDEN_LIGHT_PARS}
        uniform highp sampler2DArray uDetail;
        uniform sampler2D uSurf;
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
        }
        // 映り込む空を式で（ガラス以外の、ざらついた面用。環境マップと同じ作り方を簡単にしたもの）
        vec3 envLite(vec3 Rw, float rough){
          float h = Rw.y;
          vec3 sky = mix(uSkyHz, uSkyTop, sqrt(clamp(h, 0.0, 1.0)));
          vec3 gnd = mix(uSkyHz * 0.75, uCity, clamp(-h * 3.3, 0.0, 1.0));
          float w = 0.02 + 0.7 * rough * rough;
          vec3 col = mix(gnd, sky, smoothstep(-w, w, h));
          vec3 amb = mix(uAmbGround, uAmbSky, 0.5 + 0.5 * h) + uAmbSun * pow(0.5 + 0.5 * dot(Rw, uSunDir), 3.0);
          return mix(col, amb, smoothstep(0.35, 1.0, rough));
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
        // 敷地の芝生：まわりの地面（groundMaterial）と同じ色合いとむらにそろえる（浮いて見えないように）。
        // 地面の板（mi == 9）と、模様のない上向きの緑の面（植え込みの上など）。世界の座標のノイズなので、となりの区画となめらかにつながる
        if (vNy > 0.5 && (mi == 9 || floor(vPat + 0.5) < 0.5)) {
          vec3 c = diffuseColor.rgb;
          // 緑で、青みの強くないもの（人工芝のコートや水色の面は除く）
          float grassy = clamp((c.g - max(c.r, c.b)) * 14.0, 0.0, 1.0) * clamp((c.r * 1.15 - c.b) * 12.0, 0.0, 1.0);
          if (grassy > 0.01) {
            vec2 p = vWp.xz;
            vec4 nL = texture2D(uSurf, p * (1.0 / 733.0) + vec2(0.13, 0.71));
            vec4 nM = texture2D(uSurf, mat2(0.8, -0.6, 0.6, 0.8) * p * (1.0 / 151.0));
            vec4 nS = texture2D(uSurf, mat2(0.28, 0.96, -0.96, 0.28) * p * (1.0 / 31.0) + 0.37);
            vec4 nP = texture2D(uSurf, mat2(-0.6, 0.8, -0.8, -0.6) * p * (1.0 / 11.0) + 0.53);
            // 細かいむら（5m）：遠くて1画素が 2.5m を超えると、ならした値（0.5）に寄せる。
            // 読み出しは分岐の外で毎回行う（iPhone の GPU では、読み出しを if で囲むと、いつも読むより遅くなる）
            float fl = length(fwidth(p));
            vec4 nF = mix(texture2D(uSurf, mat2(0.6, 0.8, -0.8, 0.6) * p * (1.0 / 5.3)), vec4(0.5), smoothstep(1.6, 2.5, fl));
            float macro = nL.a * 0.6 + nM.g * 0.4;
            float mid = nS.g;
            vec3 g = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, 0.84) * vec3(0.88, 0.86, 0.76);
            // 乾いた草（黄色っぽい）と、しげった草（深い緑）：地面と同じ式
            float dry = smoothstep(0.48, 0.78, macro + (mid - 0.5) * 0.6);
            float lush = smoothstep(0.55, 0.2, nM.a + (mid - 0.5) * 0.6);
            g *= mix(vec3(1.0), vec3(1.2, 1.07, 0.7), dry * 0.7);
            g *= mix(vec3(1.0), vec3(0.72, 0.88, 0.76), lush * 0.6);
            // まだらの色むら（数 m の斑点）：明るい黄緑、少し乾いたオリーブ色、濃い緑
            float pa = nP.g + (nF.r - 0.5) * 0.35;
            g *= mix(vec3(1.0), vec3(1.1, 1.12, 0.86), smoothstep(0.58, 0.8, pa) * 0.8);
            g *= mix(vec3(1.0), vec3(1.06, 0.97, 0.72), smoothstep(0.6, 0.85, nP.a + (nF.g - 0.5) * 0.3) * 0.75);
            g *= mix(vec3(1.0), vec3(0.8, 0.88, 0.8), smoothstep(0.42, 0.18, pa) * 0.7);
            // 草むらの明るさのむら（中くらい、細かい）。細かいものは遠くでは消す
            float ff = 1.0 - smoothstep(0.15, 0.6, fl);
            g *= 0.84 + 0.32 * mid;
            g *= mix(1.0, 0.84 + 0.32 * nF.g, ff);
            g *= mix(1.0, 0.92 + 0.16 * nF.r, ff);
            diffuseColor.rgb = mix(c, g, grassy);
            gRough = mix(gRough, 0.95, grassy);
          }
        }
        // 塗った金属（色の濃いもの）は金属らしさを弱め、つやを消す（赤い屋根などが空を映して白っぽくあせないように）
        {
          vec3 c = vColor.rgb;
          float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
          float paint = smoothstep(0.1, 0.4, (mx - mn) / max(mx, 1e-3));
          gMetal *= 1.0 - paint;
          if (mi == 5) gRough = mix(gRough, 0.85, paint);
        }
        float pat = floor(vPat + 0.5);
        // 住宅の印（+40）と空き家の印（+20）
        float resd = step(39.5, pat);
        pat -= 40.0 * resd;
        float aband = 0.0;
        if (pat > 19.5) { pat -= 20.0; aband = 1.0; }
        float win = 0.0;
        float lit = 0.0;
        vec3 litCol = vec3(0.0);
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
          } else if (pat > 13.5 && pat < 17.5) { // 庭（14 = 石や木、15 = 地面、16 = 葉の房、17 = 夜にともる面）
            gGarden = 1.0;
            vec2 gp = vWp.xz;
            if (pat > 16.5) {
              // 灯籠の火袋・行灯の紙（夜にともる）
              gGlowG = 1.0;
            } else if (pat > 14.5 && pat < 15.5) {
              // 地面：苔・土・小石
              float moss = clamp(vUvm.x, 0.0, 1.0), peb = clamp(vUvm.y, 0.0, 1.0);
              vec4 n1 = texture2D(uSurf, gp * (1.0 / 13.0));
              vec4 n2 = texture2D(uSurf, mat2(0.8, -0.6, 0.6, 0.8) * gp * (1.0 / 3.1) + 0.31);
              vec3 c = diffuseColor.rgb * (0.86 + 0.28 * n2.r);
              // 苔：こんもりした株は明るい黄緑、すき間は暗い
              float cush = smoothstep(0.32, 0.72, n2.g * 0.65 + n1.a * 0.35);
              vec3 mc = diffuseColor.rgb * mix(vec3(0.74, 0.8, 0.76), vec3(1.14, 1.12, 0.88), cush) * (0.9 + 0.2 * n1.g);
              c = mix(c, mc, moss);
              if (peb > 0.01) {
                // 小石（州浜）。遠くでは平均の色にする（ちらつかないように）
                vec2 q = gp * 5.5;
                vec2 iq = floor(q), fq = fract(q);
                float d1 = 8.0, d2 = 8.0;
                vec2 id = vec2(0.0);
                for (int j = -1; j <= 1; j++)
                  for (int i = -1; i <= 1; i++) {
                    vec2 o = vec2(float(i), float(j));
                    vec2 hh = vec2(h21(iq + o), h21(iq + o + 17.3));
                    vec2 rr = o + 0.15 + 0.7 * hh - fq;
                    float dd = dot(rr, rr);
                    if (dd < d1) { d2 = d1; d1 = dd; id = iq + o; } else if (dd < d2) d2 = dd;
                  }
                float edge = sqrt(d2) - sqrt(d1);
                float fade = 1.0 - smoothstep(0.08, 0.3, length(fwidth(q)));
                float tone = h21(id + 3.7);
                vec3 pc = diffuseColor.rgb * mix(0.74, 1.16, tone) * mix(vec3(1.0), vec3(1.07, 1.0, 0.9), step(0.7, h21(id + 9.1)));
                pc *= mix(0.55, 1.0, smoothstep(0.02, 0.14, edge));
                pc = mix(diffuseColor.rgb * 0.93, pc, fade);
                c = mix(c, pc, peb);
              }
              diffuseColor.rgb = c;
              gRough = mix(mix(0.9, 1.0, moss), 0.62, peb);
            } else if (pat > 15.5) {
              // 刈り込みの木・松の葉の房：細かい房のむら
              gFol = 1.0;
              vec4 n1 = texture2D(uSurf, vec2(gp.x + vWp.y * 0.7, gp.y - vWp.y * 0.5) * (1.0 / 1.7));
              diffuseColor.rgb *= 0.7 + 0.6 * n1.r;
              gRough = 0.95;
            }
          } else if (pat > 17.5 && pat < 18.5) { // 畑：面の座標 = (畝を横切る向き[rad] + 4 × 轍のずれ, 作物の模様)
            // 1 = 耕した畑, 2 = トウモロコシ, 3 = 麦, 4 = 菜の花, 5 = 牧草地, 6 = 刈り取りあと, 7 = ビート・ジャガイモ
            // 色のむら（湿り気・育ちぐあい）、細かい粒、作業の帯ごとの濃淡、轍、畝の凹凸（日の向きで陰ができる）。遠くでは平均の色に
            float crop = floor(uv.y + 0.5);
            float off = floor(uv.x / 4.0);
            float ang = uv.x - off * 4.0;
            vec2 fd = vec2(cos(ang), sin(ang));
            vec2 fp = vWp.xz;
            float s = dot(fp, fd) + off * 4.1;
            float tr = dot(fp, vec2(-fd.y, fd.x));
            vec4 nL = texture2D(uSurf, fp * (1.0 / 127.0) + 0.17);
            vec4 nM = texture2D(uSurf, mat2(0.8, -0.6, 0.6, 0.8) * fp * (1.0 / 41.0) + 0.41);
            vec4 nF = texture2D(uSurf, mat2(0.28, 0.96, -0.96, 0.28) * fp * (1.0 / 2.7) + 0.77);
            float fs = max(fwidth(s), 1e-4);
            vec3 c = diffuseColor.rgb;
            // 大きなむら：湿ったところは濃く青み、乾いたところは明るく黄み
            float moist = nL.a * 0.55 + nM.g * 0.45;
            c *= mix(vec3(0.84, 0.88, 0.9), vec3(1.12, 1.07, 0.92), smoothstep(0.2, 0.8, moist));
            c *= 0.92 + 0.16 * nM.r;
            // 細かい粒（遠くでは消す）
            float fg = 1.0 - smoothstep(0.08, 0.5, fs);
            c *= 1.0 + (nF.g - 0.5) * 0.2 * fg;
            // 作業の帯（種まき機の幅 3m）ごとの、わずかな濃淡
            float pass = h21(vec2(floor(s / 3.0), off + crop * 7.0));
            float pa = 1.0 - smoothstep(0.3, 1.2, fs);
            vec3 bump = vec3(0.0);
            // 轍（24m ごとに、1.8m 離れた2本）
            float q = abs(fract(s / 24.0) - 0.5) * 24.0;
            // 線の幅より画面の1ピクセルが大きいときは、線を太らせて薄くする（遠くでも細い線として残る）
            float ww = max(0.32, fs * 1.5);
            float wheel = (1.0 - smoothstep(ww * 0.5, ww * 0.5 + fs * 0.6, abs(q - 0.9))) * (0.32 / ww) * (1.0 - smoothstep(2.0, 4.0, fs));
            if (crop < 1.5) { // 耕した畑：0.9m の畝。凹凸に日が当たる
              float a = 1.0 - smoothstep(0.12, 0.4, fs / 0.9);
              float ph = s * 6.2832 / 0.9;
              // 鋤の通った帯（5m）ごとの濃淡と、土くれ
              float land = h21(vec2(floor(s / 5.0), off + 3.0));
              float la = 1.0 - smoothstep(0.4, 1.6, fs);
              c *= 1.0 + a * 0.16 * sin(ph) + (nF.r - 0.5) * 0.3 * fg + (land - 0.5) * 0.2 * la;
              bump = vec3(fd.x, 0.0, fd.y) * cos(ph) * 0.75 * a;
            } else if (crop < 2.5) { // トウモロコシ：0.75m の列と、すき間の暗い土
              float a = 1.0 - smoothstep(0.12, 0.4, fs / 0.75);
              float ph = s * 6.2832 / 0.75;
              c = mix(c, c * vec3(0.55, 0.52, 0.45), a * smoothstep(0.2, 0.9, -sin(ph)) * 0.6);
              // 遠くからは、列が細い線の束に見える（6m の帯ごとの濃淡）
              float band = h21(vec2(floor(s / 6.0), off + 5.0));
              c *= 1.0 + (band - 0.5) * 0.16 * (1.0 - smoothstep(0.5, 2.0, fs)) + 0.05 * sin(s * 6.2832 / 1.5) * (1.0 - smoothstep(0.2, 0.7, fs));
              bump = vec3(fd.x, 0.0, fd.y) * cos(ph) * 0.35 * a;
            } else if (crop < 4.5) { // 麦・菜の花：轍、帯の濃淡、風になびくむら
              c *= 1.0 + (pass - 0.5) * 0.12 * pa;
              c *= 0.92 + 0.16 * smoothstep(0.3, 0.7, nM.a);
              if (crop > 3.5) {
                // 菜の花：花の咲きぐあいのむら（緑の茎が見えるところ）
                c = mix(c, c * vec3(0.72, 0.9, 0.62), smoothstep(0.55, 0.3, nM.b + (nF.r - 0.5) * 0.3 * fg) * 0.7);
              }
              c = mix(c, c * vec3(0.58, 0.58, 0.52), wheel * 0.85);
              bump = vec3(fd.x, 0.0, fd.y) * sign(q - 0.9) * wheel * 0.25;
            } else if (crop < 5.5) { // 牧草地：刈ったあとの縞と、草の株
              float a = 1.0 - smoothstep(0.4, 1.4, fs / 6.0);
              c *= 1.0 + a * 0.06 * sign(fract(s / 12.0) - 0.5);
              c *= 1.0 + (nF.b - 0.5) * 0.25 * fg;
              c = mix(c, c * vec3(0.8, 0.86, 0.72), smoothstep(0.62, 0.8, nM.a) * 0.5);
            } else if (crop < 6.5) { // 刈り取りあと：明るい麦わらの列、刈り株の筋、うすい轍
              float a = 1.0 - smoothstep(0.15, 0.6, fs / 1.6);
              float sw = 1.0 - smoothstep(0.25, 0.75, abs(fract(s / 7.2) - 0.5) * 7.2);
              c = mix(c, c * 1.15 + vec3(0.03, 0.025, 0.0), sw * a * 0.8);
              c *= 1.0 + fg * 0.07 * sin(s * 6.2832 / 0.18);
              c = mix(c, c * vec3(0.78, 0.76, 0.7), wheel * 0.5);
              bump = vec3(fd.x, 0.0, fd.y) * cos(s * 6.2832 / 7.2) * 0.2 * a;
            } else { // ビート・ジャガイモ：0.5m の畝（盛り上がった列）と、すき間の土
              float a = 1.0 - smoothstep(0.1, 0.35, fs / 0.5);
              float ph = s * 6.2832 / 0.5;
              c = mix(c, vec3(0.2, 0.16, 0.11), a * smoothstep(0.1, 0.9, -sin(ph)) * 0.45);
              c *= 1.0 + (pass - 0.5) * 0.12 * pa;
              bump = vec3(fd.x, 0.0, fd.y) * cos(ph) * 0.45 * a;
            }
            diffuseColor.rgb = c;
            gBump = bump;
            gRough = 0.95;
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
          // 夜の窓の明かり（数と色は実際の街に合わせる）。
          //  住宅：夜の早い時間は 4 割ほど、深夜は 1 割ほど。家ごとに 昼白色（5000K）と 電球色（2700K、カーテン越し）が半々、両方の家も
          //  オフィス：早い時間は 2 割ほど、深夜は数 %。階ごとにまとめて点く（ばらばらの点ではなく）。色は 4000〜5000K
          //  店：1階のショーウィンドウ。3000〜3500K、閉店後は減る
          // 色は線形の値で、ACES のトーンマップ（夜の露出 1.05）と sRGB を通したときに、その色温度の色味になるように逆算したもの。
          // ACES は暗いところで色が濃くなるので、ふつうの明るさの 0.75 倍で色味が合うようにしてある。
          //  住宅 昼白色 ≈ (180,164,150)、電球色（カーテン越し、あせた色）≈ (181,144,108)、オフィス 4000K ≈ (198,167,138)〜5000K ≈ (197,181,167)、店 ≈ (216,162,104)〜(215,174,129)
          vec2 bs = floor(vWp.xz * 0.05);
          float hb = h21(bs + 7.13);
          float hw = h21(cellId * 1.37 + bs + 3.71);
          float hf = h21(vec2(cellId.y * 0.731, hb * 37.0) + bs);
          float isRes = max(resd, float(abs(pat - 1.0) < 0.5 || abs(pat - 5.0) < 0.5 || abs(pat - 9.0) < 0.5));
          float isShow = (1.0 - isRes) * float(abs(pat - 2.0) < 0.5 && uv.y < 3.6);
          // 店の上の階は住まいの明かり
          isRes = max(isRes, (1.0 - isShow) * float(abs(pat - 2.0) < 0.5));
          float isOff = (1.0 - isRes) * (1.0 - isShow);
          float pRes = mix(0.42, 0.1, uLate);
          float pShow = mix(0.85, 0.2, uLate);
          // オフィス：建物ごとの忙しさ（0.5〜1.5倍）。点いた階では 85% の区画が点く
          float pOff = mix(0.21, 0.03, uLate) * (0.5 + hb) * (1.0 / 0.85);
          float litOn = isRes * step(hw, pRes) + isShow * step(hw, pShow) + isOff * step(hf, pOff) * step(hw, 0.85);
          lit = win * litOn * (1.0 - aband);
          // 色：住宅は家ごと（0..1 = 昼白色..電球色、両方の家は 0.5）、オフィスは階ごとに 4000〜5000K、店は 3000〜3500K
          float hc = fract(hw * 13.7 + hf * 3.1);
          float warm = step(0.45, hc) - 0.5 * step(0.86, hc);
          vec3 cRes = mix(vec3(0.362, 0.281, 0.227), vec3(0.365, 0.213, 0.117), warm);
          vec3 cOff = mix(vec3(0.482, 0.29, 0.183), vec3(0.484, 0.359, 0.284), hf);
          vec3 cShow = mix(vec3(0.641, 0.265, 0.097), vec3(0.651, 0.319, 0.15), hb);
          // 明るさのばらつき（照明の数、カーテンの厚さ）
          litCol = (isRes * cRes + isOff * cOff + isShow * cShow) * (0.75 + 0.5 * fract(hw * 7.31));
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
        // 壁の座標を持たない面（円柱やドーム、斜めの部材など）は高さがわからないので、陰をつけない
        if (vNy < 0.5 && gGarden < 0.5 && abs(vUvm.x) + abs(vUvm.y) > 1e-4) {
          float k = smoothstep(0.0, 5.0, vUvm.y);
          gAO = mix(0.5, 1.0, k);
          diffuseColor.rgb *= mix(0.86, 1.0, k);
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (dot(gBump, gBump) > 1e-6) normal = normalize(normal + (viewMatrix * vec4(gBump, 0.0)).xyz);`,
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
            // ざらついた面ほど、空の映り込みは凹凸や汚れにさえぎられて弱い（色があせて見えないように）
            float so = mix(1.0, 0.35, smoothstep(0.45, 0.9, rr));
            #ifdef BLD_HQ
              radiance += envSky(Rw, rr) * so;
            #else
              radiance += envLite(Rw, rr) * so;
            #endif
          }
        }`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // 庭：灯籠やライトアップの明かり
        if (gGarden > 0.5 && uGLn > 0) reflectedLight.directDiffuse += gardenLight(vWp, inverseTransformDirection(normal, viewMatrix), gFol * 0.45) * material.diffuseColor;`,
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
        totalEmissiveRadiance += litCol * lit * uNight;
        totalEmissiveRadiance += vec3(0.75, 0.88, 1.0) * gGlow * uNight * 1.4;
        totalEmissiveRadiance += gLed * uNight * 1.3;
        totalEmissiveRadiance += diffuseColor.rgb * gLit * uNight * 1.1;
        totalEmissiveRadiance += vec3(1.0, 0.68, 0.36) * gGlowG * uNight * 2.2;`,
      );
  };
  m.customProgramCacheKey = () => 'bld-pbr-' + (bldQuality.hq ? 1 : 0);
  return m;
}
