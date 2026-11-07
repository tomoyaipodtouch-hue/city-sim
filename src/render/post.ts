// 高画質モード：画面の陰（GTAO）、光のにじみ（ブルーム）、色の調整、なめらかな輪郭（MSAA）
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.16 }, uSat: { value: 1.05 }, uCon: { value: 1.06 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVig, uSat, uCon; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uSat);
      // 暗いところはわずかに青く、明るいところはわずかに暖かく（写真のような色味）
      c += mix(vec3(-0.008, 0.0, 0.014), vec3(0.012, 0.004, -0.012), smoothstep(0.15, 0.75, l));
      c = (c - 0.5) * uCon + 0.5;
      float v = smoothstep(0.85, 0.3, length(vUv - 0.5));
      c *= mix(1.0 - uVig, 1.0, v);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// 半分の解像度の陰を、元の解像度の奥行きを見ながら重ねる（ただ引きのばすと、建物の輪郭に段々の黒い帯が出る）。
// 近くの4つの陰のうち、奥行きがこの画素に近いものだけを使う
const BLEND_FRAG = /* glsl */ `
  uniform float intensity;
  uniform sampler2D tDiffuse;
  uniform highp sampler2D tDepth;
  uniform vec2 aoSize;
  uniform float cameraNear, cameraFar;
  varying vec2 vUv;
  #include <packing>
  float lz(vec2 uv) { return -perspectiveDepthToViewZ(textureLod(tDepth, uv, 0.0).r, cameraNear, cameraFar); }
  void main() {
    float z0 = lz(vUv);
    vec2 p = vUv * aoSize - 0.5;
    vec2 i = floor(p), f = p - i;
    float tol = z0 * 0.02 + 0.2;
    float ao = 0.0, wsum = 0.0, best = 1e9, aoBest = 1.0;
    for (int k = 0; k < 4; k++) {
      vec2 o = vec2(float(k - (k / 2) * 2), float(k / 2));
      vec2 uv = (i + o + 0.5) / aoSize;
      float a = textureLod(tDiffuse, uv, 0.0).r;
      float dz = abs(lz(uv) - z0);
      float wb = mix(1.0 - f.x, f.x, o.x) * mix(1.0 - f.y, f.y, o.y);
      float w = (wb + 0.02) * max(0.0, 1.0 - dz / tol);
      ao += a * w;
      wsum += w;
      if (dz < best) { best = dz; aoBest = a; }
    }
    float v = wsum > 1e-4 ? ao / wsum : aoBest;
    gl_FragColor = vec4(vec3(mix(1.0, v, intensity)), 1.0);
  }`;

// 画面の陰は半分の解像度で求める（ぼかしてから重ねるので、細かさはいらない）
class HalfGTAOPass extends GTAOPass {
  setSize(w: number, h: number) {
    const hw = Math.max(1, Math.round(w / 2)), hh = Math.max(1, Math.round(h / 2));
    super.setSize(hw, hh);
    this.blendMaterial.uniforms.aoSize?.value.set(hw, hh);
  }
}

// 昼の画面の陰の強さ
const DAY_AO = 0.65;

export class PostFX {
  composer: EffectComposer;
  private cam: THREE.PerspectiveCamera;
  private bloom: UnrealBloomPass;
  private gtao: HalfGTAOPass;
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    // 奥行きを画面の陰に使う（場面をもう一度描かずに、奥行きから面の向きも求める）
    rt.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.gtao = new HalfGTAOPass(scene, camera, Math.round(size.x / 2), Math.round(size.y / 2), { depthTexture: rt.depthTexture });
    // 陰はまわりからの光だけを弱めるのが本当なので、日なたまで暗くならないよう控えめに重ねる
    this.gtao.blendIntensity = DAY_AO;
    // thickness：手前にあるものを陰として数える奥行きの幅（大きいと、木や手前の建物のうしろの壁にすすのような陰が出る）
    this.gtao.updateGtaoMaterial({ radius: 8, distanceExponent: 1.2, thickness: 3, scale: 1.1, samples: 8, distanceFallOff: 0.6 });
    // ぼかしは輪郭（奥行きや面の向きが変わるところ）で止める
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 0.7, normalPhi: 8, radius: 6, rings: 2, samples: 8 });
    const bm = this.gtao.blendMaterial;
    Object.assign(bm.uniforms, {
      tDepth: { value: rt.depthTexture },
      aoSize: { value: new THREE.Vector2(Math.round(size.x / 2), Math.round(size.y / 2)) },
      cameraNear: { value: 1 },
      cameraFar: { value: 1000 },
    });
    bm.fragmentShader = BLEND_FRAG;
    bm.needsUpdate = true;
    this.cam = camera as THREE.PerspectiveCamera;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.3, 0.45, 1.2);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(GradeShader));
  }
  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }
  // 夜ほど強くにじませる（昼は光るもの以外がにじまないよう、しきい値を高く。日の当たる白い車や屋根がまぶしく広がらない）
  setNight(k: number) {
    this.bloom.strength = 0.12 + 0.42 * k;
    this.bloom.threshold = 2.2 - 1.4 * k;
    // 夜は窓や街灯の明かりまで暗くしないよう、画面の陰を弱め、暗くなったら止める（そのぶん軽い）
    const s = Math.max(0, Math.min(1, (k - 0.25) / 0.5));
    this.gtao.blendIntensity = DAY_AO * (1 - s * s * (3 - 2 * s));
    this.gtao.enabled = this.gtao.blendIntensity > 0.01;
  }
  // 陰の届く距離は、見ている距離に合わせる（引いて見ると、通りや街区の単位で陰ができる）
  private lastDist = -1;
  setView(dist: number) {
    if (Math.abs(dist - this.lastDist) < 0.5) return;
    this.lastDist = dist;
    const r = Math.min(45, Math.max(5, dist * 0.06));
    this.gtao.updateGtaoMaterial({ radius: r, thickness: Math.min(10, Math.max(2, r * 0.4)) });
  }
  render(dt: number) {
    // 場面を描いた方のバッファの奥行きを使う（バッファは毎回入れ替わる）
    const depth = this.composer.readBuffer.depthTexture;
    const gm = this.gtao.gtaoMaterial.uniforms, pm = this.gtao.pdMaterial.uniforms;
    const bu = this.gtao.blendMaterial.uniforms;
    if (gm.tDepth.value !== depth) {
      gm.tDepth.value = depth;
      pm.tDepth.value = depth;
      bu.tDepth.value = depth;
    }
    bu.cameraNear.value = this.cam.near;
    bu.cameraFar.value = this.cam.far;
    this.composer.render(dt);
  }
  dispose() {
    this.gtao.dispose();
    this.composer.dispose();
  }
}
