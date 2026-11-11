// 空から作る環境マップ（ガラスや金属に映る空と、まわりから来るやわらかい光）
// PMREMGenerator は 256 四方より小さくできず重いので、小さなキューブマップの各段（ぼけ具合ごと）に、空を式で直接描く。
// 三つ目以降の段ほどぼけた空になり、いちばんぼけた段は「その向きの面が受けるまわりの光」になる（three.js の PMREM と同じ並び）。
import * as THREE from 'three';

const SIZE = 128;
const LODS = 5; // 128, 64, 32, 16, 8

const FRAG = /* glsl */ `
uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunCol, uGlow, uAmbSky, uAmbGround, uAmbSun;
uniform float uRough, uCloud, uSeed;
varying vec3 vWorldDirection;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int k = 0; k < 4; k++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
// 光のにじみ（pow(s, n)）を、粗さ r の分だけ広げる（明るさの合計はおおよそ保つ）
float lobe(float s, float n, float r){
  float a = max(r * r, 1e-4);
  float ng = 2.0 / (a * a) - 2.0;
  float m = 1.0 / (1.0 / n + 1.0 / max(ng, 1.0));
  return pow(s, m) * (m + 1.0) / (n + 1.0);
}
void main(){
  vec3 d = normalize(vWorldDirection);
  float r = uRough;
  float h = d.y;
  // 空：地平線から天頂へ。ぼけるほど地平線のさかいがなめらかになる
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  float s = max(dot(d, uSunDir), 0.0);
  sky += uSunCol * (lobe(s, 6.0, r) * 0.18 + lobe(s, 80.0, r) * 0.5 + lobe(s, 900.0, r) * 1.5);
  // 雲（ぼけるほど、まだらが平均の明るさに近づく）
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.12) * 1.6 + uSeed;
    float c = smoothstep(0.52, 0.78, fbm(uv));
    c = mix(c, 0.22, smoothstep(0.05, 0.45, r));
    vec3 cloud = mix(uHorizon, vec3(1.0), 0.75) * uCloud + uSunCol * pow(s, 4.0) * 0.25;
    sky = mix(sky, cloud, c * smoothstep(0.0, 0.25, h) * 0.85 * step(0.001, uCloud));
  }
  // 夜の街あかり（地平線のあたりがほんのり明るい）
  sky += uGlow * exp(-max(h, 0.0) * 7.0);
  // 地面：遠くはかすんで地平線の色、近く（真下）ほど街の色
  vec3 ground = mix(uHorizon * 0.75 + uGlow, uGround, smoothstep(0.0, 0.3, -h));
  float w = 0.02 + 0.7 * r * r;
  vec3 col = mix(ground, sky, smoothstep(-w, w, h));
  // まわりから来る光（いちばんぼけた段）。空の明るさだけでなく、建物や地面にはね返った光も入れて、決めた値にそろえる
  vec3 amb = mix(uAmbGround, uAmbSky, 0.5 + 0.5 * h) + uAmbSun * pow(0.5 + 0.5 * dot(d, uSunDir), 3.0);
  col = mix(col, amb, smoothstep(0.35, 1.0, r));
  gl_FragColor = vec4(col, 1.0);
}`;

export class SkyEnv {
  readonly texture: THREE.Texture;
  uniforms = {
    uZenith: { value: new THREE.Color(0x4f86cc) },
    uHorizon: { value: new THREE.Color(0xa9cbe6) },
    uGround: { value: new THREE.Color(0x404238) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(0xfff2d8) },
    uGlow: { value: new THREE.Color(0, 0, 0) },
    uAmbSky: { value: new THREE.Color(0.2, 0.24, 0.29) },
    uAmbGround: { value: new THREE.Color(0.05, 0.045, 0.035) },
    uAmbSun: { value: new THREE.Color(0, 0, 0) },
    uCloud: { value: 1 },
    uRough: { value: 0 },
    uSeed: { value: 0 },
  };
  private target: THREE.WebGLCubeRenderTarget;
  private cam: THREE.CubeCamera;
  private mesh: THREE.Mesh;

  constructor(renderer: THREE.WebGLRenderer) {
    // 浮動小数点の画像に描けない古い端末では、ふつうの 8bit で作る（明るさ 1 を超える部分が切れるだけ）
    const ext = renderer.extensions;
    const half = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    this.target = new THREE.WebGLCubeRenderTarget(SIZE, {
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
    });
    const tex = this.target.texture;
    const mips = tex.mipmaps as unknown[];
    for (let l = 0; l < LODS; l++) mips.push({ width: SIZE >> l, height: SIZE >> l });
    // three.js の PMREM と同じものとして扱わせる（各段 = 粗さ）
    (tex as unknown as { isPMREMTexture: boolean }).isPMREMTexture = true;
    tex.name = 'PMREM';
    this.texture = tex;
    this.cam = new THREE.CubeCamera(0.1, 10, this.target);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: THREE.ShaderChunk.cube_vert,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    this.mesh.frustumCulled = false;
  }

  // 全部の段を描き直す（6面 × 5段。小さいので軽い）
  update(renderer: THREE.WebGLRenderer) {
    const t = this.target;
    for (let l = 0; l < LODS; l++) {
      // PMREMGenerator.lodToRoughness と同じ
      this.uniforms.uRough.value = l === 0 ? 0 : 1 - Math.sqrt(1 - l / (LODS - 1));
      this.cam.activeMipmapLevel = l;
      const s = SIZE >> l;
      t.viewport.set(0, 0, s, s);
      this.cam.update(renderer, this.mesh);
    }
    t.viewport.set(0, 0, SIZE, SIZE);
  }

  dispose() {
    this.target.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
