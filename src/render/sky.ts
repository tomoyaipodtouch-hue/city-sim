// 空：地平線から天頂へのグラデーション、太陽の光のにじみ、雲、夜の星
import * as THREE from 'three';

export class SkyDome {
  mesh: THREE.Mesh;
  uniforms = {
    uZenith: { value: new THREE.Color(0x5b8fd0) },
    uHorizon: { value: new THREE.Color(0xa9cbe6) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
    uDay: { value: 1 },
    uTime: { value: 0 },
  };
  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // いちばん奥に描く
        }`,
      fragmentShader: `
        uniform vec3 uZenith, uHorizon, uSunColor, uSunDir;
        uniform float uDay, uTime;
        varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int k = 0; k < 5; k++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
          // 太陽のまわりの光
          float s = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunColor * (pow(s, 6.0) * 0.18 + pow(s, 80.0) * 0.5 + pow(s, 900.0) * 1.5) * uDay;
          // 雲（空を平面とみなして、ゆっくり流れる）
          if (h > 0.0) {
            vec2 uv = d.xz / (h + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
            float c = smoothstep(0.52, 0.78, fbm(uv));
            float fade = smoothstep(0.0, 0.25, h);
            vec3 cloud = mix(vec3(0.16, 0.18, 0.25), mix(uHorizon, vec3(1.0), 0.75) + uSunColor * pow(s, 4.0) * 0.25, uDay);
            col = mix(col, cloud, c * fade * mix(0.35, 0.85, uDay));
            // 星
            vec2 g = floor(d.xz / (h + 0.3) * 180.0);
            float st = step(0.996, hash(g)) * (1.0 - uDay) * smoothstep(0.05, 0.4, h) * (1.0 - c);
            col += vec3(st);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
  }

  follow(camera: THREE.PerspectiveCamera) {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.5);
  }
}
