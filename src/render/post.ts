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

// 画面の陰は半分の解像度で求める（ぼかしてから重ねるので、細かさはいらない）
class HalfGTAOPass extends GTAOPass {
  setSize(w: number, h: number) {
    super.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
  }
}

export class PostFX {
  composer: EffectComposer;
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
    this.gtao.blendIntensity = 1.0;
    this.gtao.updateGtaoMaterial({ radius: 8, distanceExponent: 1.2, thickness: 12, scale: 1.7, samples: 12, distanceFallOff: 0.6 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
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
  // 夜ほど強くにじませる（昼は白い屋根などがまぶしくならないように弱く）
  setNight(k: number) {
    this.bloom.strength = 0.12 + 0.42 * k;
    this.bloom.threshold = 1.5 - 0.7 * k;
    // 夜は窓や街灯の明かりまで暗くしないよう、画面の陰を弱める
    this.gtao.blendIntensity = 1.0 - 0.6 * k;
  }
  // 陰の届く距離は、見ている距離に合わせる（引いて見ると、通りや街区の単位で陰ができる）
  private lastDist = -1;
  setView(dist: number) {
    if (Math.abs(dist - this.lastDist) < 0.5) return;
    this.lastDist = dist;
    const r = Math.min(45, Math.max(5, dist * 0.06));
    this.gtao.updateGtaoMaterial({ radius: r, thickness: r * 1.5 });
  }
  render(dt: number) {
    // 場面を描いた方のバッファの奥行きを使う（バッファは毎回入れ替わる）
    const depth = this.composer.readBuffer.depthTexture;
    const gm = this.gtao.gtaoMaterial.uniforms, pm = this.gtao.pdMaterial.uniforms;
    if (gm.tDepth.value !== depth) {
      gm.tDepth.value = depth;
      pm.tDepth.value = depth;
    }
    this.composer.render(dt);
  }
  dispose() {
    this.gtao.dispose();
    this.composer.dispose();
  }
}
