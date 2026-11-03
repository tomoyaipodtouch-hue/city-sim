// 地形、水面、データ表示（オーバーレイ）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, WATER_LEVEL } from '../sim/constants';
import { hash2 } from '../sim/rng';

export class TerrainLayer {
  group = new THREE.Group();
  geom: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  overlay: THREE.Mesh;
  overlayTex: THREE.DataTexture;
  overlayData: Uint8Array;
  skirt: THREE.Mesh;
  water: THREE.Mesh;
  private n: number;
  overlayMat: THREE.ShaderMaterial;

  constructor(n: number) {
    this.n = n;
    const V = n + 1;
    const pos = new Float32Array(V * V * 3);
    const col = new Float32Array(V * V * 3);
    for (let y = 0; y < V; y++)
      for (let x = 0; x < V; x++) {
        const i = (y * V + x) * 3;
        pos[i] = x * CELL;
        pos[i + 2] = y * CELL;
      }
    const idx = new Uint32Array(n * n * 6);
    let k = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = y * V + x, b = a + 1, c = a + V, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geom.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(this.geom, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);

    // オーバーレイ（ゾーンの色やデータ表示）
    this.overlayData = new Uint8Array(n * n * 4);
    this.overlayTex = new THREE.DataTexture(this.overlayData, n, n, THREE.RGBAFormat);
    this.overlayTex.magFilter = THREE.NearestFilter;
    this.overlayTex.minFilter = THREE.NearestFilter;
    this.overlayTex.needsUpdate = true;
    this.overlayMat = new THREE.ShaderMaterial({
      uniforms: { uData: { value: this.overlayTex }, uN: { value: n }, uGrid: { value: 0 }, uSmooth: { value: 0 } },
      vertexShader: `
        varying vec3 vW;
        void main(){
          vec3 p = position; p.y += 0.25;
          vec4 w = modelMatrix * vec4(p, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform sampler2D uData; uniform float uN; uniform float uGrid;
        varying vec3 vW;
        void main(){
          vec2 cell = vW.xz / ${CELL.toFixed(1)};
          vec4 c = texture2D(uData, cell / uN);
          vec2 f = abs(fract(cell) - 0.5);
          float line = step(0.47, max(f.x, f.y)) * uGrid;
          vec3 rgb = mix(c.rgb, vec3(1.0), line * 0.6);
          float a = max(c.a, line * 0.35);
          if (a < 0.01) discard;
          gl_FragColor = vec4(rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.overlay = new THREE.Mesh(this.geom, this.overlayMat);
    this.overlay.renderOrder = 2;
    this.group.add(this.overlay);

    // 地形の側面
    this.skirt = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x6b5a45 }));
    this.group.add(this.skirt);

    // 水面
    const size = n * CELL;
    const wg = new THREE.PlaneGeometry(size, size, 1, 1);
    wg.rotateX(-Math.PI / 2);
    wg.translate(size / 2, WATER_LEVEL, size / 2);
    this.water = new THREE.Mesh(
      wg,
      new THREE.MeshPhongMaterial({ color: 0x2b6f96, specular: 0xb0d4e8, shininess: 90, transparent: true, opacity: 0.86 }),
    );
    this.water.renderOrder = 1;
    this.water.receiveShadow = true;
    this.group.add(this.water);

    // マップの外側の地面
    const outside = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 8, size * 8).rotateX(-Math.PI / 2).translate(size / 2, -30, size / 2),
      new THREE.MeshLambertMaterial({ color: 0x55603f }),
    );
    this.group.add(outside);
  }

  updateHeights(g: Grid) {
    const n = this.n, V = n + 1;
    const pos = this.geom.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geom.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    const grassA = new THREE.Color(0x6d8f45), grassB = new THREE.Color(0x87a052), dry = new THREE.Color(0xa29a62);
    const sand = new THREE.Color(0xc9b98a), rock = new THREE.Color(0x8c8577), bed = new THREE.Color(0x5e6b55);
    for (let y = 0; y < V; y++)
      for (let x = 0; x < V; x++) {
        const vi = y * V + x;
        const h = g.heights[vi];
        pos.setY(vi, h);
        // 傾き
        const hx = g.heights[y * V + Math.min(n, x + 1)] - g.heights[y * V + Math.max(0, x - 1)];
        const hy = g.heights[Math.min(n, y + 1) * V + x] - g.heights[Math.max(0, y - 1) * V + x];
        const slope = Math.hypot(hx, hy) / (CELL * 2);
        const nz = hash2(x, y, 7);
        c.copy(grassA).lerp(grassB, nz * 0.7);
        if (h > 40) c.lerp(dry, Math.min(1, (h - 40) / 40));
        if (h < WATER_LEVEL + 2.2) c.lerp(sand, Math.min(1, (WATER_LEVEL + 2.2 - h) / 1.6));
        if (h < WATER_LEVEL - 0.5) c.copy(bed);
        if (slope > 0.35) c.lerp(rock, Math.min(1, (slope - 0.35) * 2.5));
        col.setXYZ(vi, c.r, c.g, c.b);
      }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geom.computeVertexNormals();
    this.geom.computeBoundingSphere();
    this.buildSkirt(g);
  }

  private buildSkirt(g: Grid) {
    const n = this.n, V = n + 1;
    const p: number[] = [];
    const add = (x0: number, z0: number, h0: number, x1: number, z1: number, h1: number) => {
      const b = -30;
      p.push(x0, h0, z0, x0, b, z0, x1, b, z1, x0, h0, z0, x1, b, z1, x1, h1, z1);
    };
    for (let k = 0; k < n; k++) {
      // 北（z=0）、南、西、東
      add((k + 1) * CELL, 0, g.heights[k + 1], k * CELL, 0, g.heights[k]);
      add(k * CELL, n * CELL, g.heights[n * V + k], (k + 1) * CELL, n * CELL, g.heights[n * V + k + 1]);
      add(0, k * CELL, g.heights[k * V], 0, (k + 1) * CELL, g.heights[(k + 1) * V]);
      add(n * CELL, (k + 1) * CELL, g.heights[(k + 1) * V + n], n * CELL, k * CELL, g.heights[k * V + n]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.computeVertexNormals();
    this.skirt.geometry.dispose();
    this.skirt.geometry = geo;
    (this.skirt.material as THREE.Material).side = THREE.DoubleSide;
  }

  setGrid(on: boolean) {
    this.overlayMat.uniforms.uGrid.value = on ? 1 : 0;
  }

  commitOverlay() {
    this.overlayTex.needsUpdate = true;
  }
}
