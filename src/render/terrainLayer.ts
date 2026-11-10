// 地形、水面、データ表示（オーバーレイ）
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL, QUAY_BED, WATER_LEVEL } from '../sim/constants';
import { hash2 } from '../sim/rng';
import { createGroundMaterial } from './groundMaterial';
import { AMB_IRR_GLSL, AMB_IRR_PARS, ambUniforms } from './materials';

export class TerrainLayer {
  group = new THREE.Group();
  geom: THREE.BufferGeometry;
  // オーバーレイ用（地形と同じ頂点。岸壁の前の縦の面は入れない）
  private ovGeom: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  overlay: THREE.Mesh;
  overlayTex: THREE.DataTexture;
  overlayData: Uint8Array;
  skirt: THREE.Mesh;
  water: THREE.Mesh;
  private n: number;
  overlayMat: THREE.ShaderMaterial;
  // 水の深さを求めるための地面の高さ（頂点ごと）
  private heightTex: THREE.DataTexture;
  private heightData: Uint16Array;
  waterUniforms = { uTime: { value: 0 }, uHeights: { value: null as THREE.DataTexture | null }, uSky: { value: new THREE.Color(0xa9cbe6) }, uNight: { value: 0 } };

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
    this.mesh = new THREE.Mesh(this.geom, createGroundMaterial({ vertexColors: true }));
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);

    // オーバーレイ（ゾーンの色やデータ表示）
    this.overlayData = new Uint8Array(n * n * 4);
    this.overlayTex = new THREE.DataTexture(this.overlayData, n, n, THREE.RGBAFormat);
    this.overlayTex.magFilter = THREE.NearestFilter;
    this.overlayTex.minFilter = THREE.NearestFilter;
    this.overlayTex.needsUpdate = true;
    this.overlayMat = new THREE.ShaderMaterial({
      // uLit：夜の明るさ（ゾーンの色を暗くする）、uDim：1 = ふだんの画面（ゾーンの色）、0 = データ表示（夜でも明るいまま）
      uniforms: { uData: { value: this.overlayTex }, uN: { value: n }, uGrid: { value: 0 }, uSmooth: { value: 0 }, uLit: { value: 1 }, uDim: { value: 1 } },
      vertexShader: `
        varying vec3 vW;
        void main(){
          vec3 p = position; p.y += 0.25;
          vec4 w = modelMatrix * vec4(p, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform sampler2D uData; uniform float uN; uniform float uGrid; uniform float uLit; uniform float uDim;
        varying vec3 vW;
        void main(){
          vec2 cell = vW.xz / ${CELL.toFixed(1)};
          vec4 c = texture2D(uData, cell / uN);
          // マスの線：画面の上で約1ピクセルの細い線（ふちはなめらか）。引いて見てマスが小さくなるほど薄くし、遠くでは消す
          vec2 fw = max(fwidth(cell), vec2(1e-4));
          vec2 d = abs(fract(cell - 0.5) - 0.5) / fw;
          float l = 1.0 - smoothstep(0.0, 1.2, min(d.x, d.y));
          float px = 1.0 / max(fw.x, fw.y); // 1マスが画面で何ピクセルか
          float line = l * smoothstep(16.0, 44.0, px) * uGrid;
          // データ表示がないところ（色が黒）は、線だけを白く重ねる。色は線形にして、ほかと同じ色の変換を通す
          // （高画質のときも同じ色になり、夜はゾーンの色が地面より明るく浮かない）
          // 線の白は、色の変換（トーンマッピング）のあとも白く残るよう少し明るめ
          vec3 base = c.a > 0.01 ? pow(c.rgb, vec3(2.2)) * mix(1.0, uLit, uDim) : vec3(1.35);
          vec3 rgb = mix(base, vec3(1.35), line * 0.6);
          float a = max(c.a, line * 0.21);
          if (a < 0.01) discard;
          gl_FragColor = vec4(rgb, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.ovGeom = new THREE.BufferGeometry();
    this.ovGeom.setAttribute('position', this.geom.getAttribute('position'));
    this.ovGeom.setIndex(this.geom.getIndex());
    this.overlay = new THREE.Mesh(this.ovGeom, this.overlayMat);
    this.overlay.renderOrder = 2;
    this.group.add(this.overlay);

    // 地形の側面
    this.skirt = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x6b5a45 }));
    this.group.add(this.skirt);

    // 水面：深さで色が変わり、波が動き、岸辺に白い波が立つ
    const size = n * CELL;
    this.heightData = new Uint16Array(V * V);
    this.heightTex = new THREE.DataTexture(this.heightData, V, V, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.magFilter = this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.needsUpdate = true;
    this.waterUniforms.uHeights.value = this.heightTex;
    const wg = new THREE.PlaneGeometry(size, size, 1, 1);
    wg.rotateX(-Math.PI / 2);
    wg.translate(size / 2, WATER_LEVEL, size / 2);
    const wm = new THREE.MeshPhongMaterial({ color: 0x2b6f96, specular: 0x3a4650, shininess: 60, transparent: true, opacity: 0.9 });
    const U = this.waterUniforms;
    wm.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      ambUniforms(sh.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWw;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        // まわりからの光は式で（環境マップを読まない）
        .replace('#include <lights_fragment_maps>', AMB_IRR_GLSL)
        .replace('#include <common>', `#include <common>
          ${AMB_IRR_PARS}
          uniform float uTime, uNight; uniform sampler2D uHeights; uniform vec3 uSky;
          varying vec3 vWw;
          float wv(vec2 p, vec2 d, float f, float sp){ return sin(dot(p, d) * f + uTime * sp); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 huv = (vWw.xz / ${CELL.toFixed(1)} + 0.5) / ${V.toFixed(1)};
          bool inside = huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0;
          float depth = inside ? ${WATER_LEVEL.toFixed(1)} - texture2D(uHeights, huv).r : 20.0;
          float dk = smoothstep(0.0, 7.0, depth);
          diffuseColor.rgb = mix(vec3(0.045, 0.17, 0.17), vec3(0.008, 0.045, 0.09), dk);
          diffuseColor.a = mix(0.5, 0.93, smoothstep(0.0, 3.0, depth));
          // 岸辺の白い波
          float foamBand = 1.0 - smoothstep(0.02, 0.35, depth);
          float foam = foamBand * (0.6 + 0.4 * sin(uTime * 1.3 + depth * 9.0 + vWw.x * 0.11 + vWw.z * 0.07)) * (1.0 - uNight * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.6, 0.62), foam * 0.45);
          diffuseColor.a = max(diffuseColor.a, foam * 0.6);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          specularStrength = 1.0 - uNight * 0.9;
          {
            vec2 p = vWw.xz;
            float dx = 0.025 * wv(p, vec2(0.8, 0.6), 0.09, 1.1) + 0.016 * wv(p, vec2(-0.3, 0.95), 0.17, 1.7) + 0.008 * wv(p, vec2(0.6, -0.8), 0.41, 2.6);
            float dz = 0.025 * wv(p, vec2(0.6, -0.8), 0.08, 0.9) + 0.016 * wv(p, vec2(0.95, 0.3), 0.19, 1.5) + 0.008 * wv(p, vec2(-0.7, -0.7), 0.37, 2.3);
            vec3 wn = normalize(vec3(dx, 1.0, dz));
            normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            // 空の映り込み（斜めから見るほど強い）
            vec3 V = normalize(vViewPosition);
            float fres = pow(1.0 - max(dot(V, normal), 0.0), 4.0);
            totalEmissiveRadiance += uSky * fres * 0.3 * (1.0 - uNight);
          }`);
    };
    this.water = new THREE.Mesh(wg, wm);
    this.water.renderOrder = 1;
    this.water.receiveShadow = true;
    this.group.add(this.water);

    // マップの外側の地面
    const outside = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 8, size * 8).rotateX(-Math.PI / 2).translate(size / 2, -30, size / 2),
      createGroundMaterial({ color: 0x5f6e44 }, false),
    );
    outside.receiveShadow = true;
    this.group.add(outside);
  }

  // skip：自分で岸壁を描く水辺の施設（港など）のマス。そこは岸壁として扱わない
  updateHeights(g: Grid, skip?: Uint8Array) {
    const n = this.n, V = n + 1;
    // 岸壁（埋め立て地の、水に面した陸のマス）
    const isQuay = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && g.quay[y * n + x] > 0 && !(skip && skip[y * n + x]) && !g.isWater(x, y);
    const water = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) water[y * n + x] = g.isWater(x, y) ? 1 : 0;
    // 岸壁のマスにふれる頂点（qv）と、そのうち水のマスにもふれる頂点（qw = 岸壁のすぐ前）
    const qv = new Uint8Array(V * V), qw = new Uint8Array(V * V);
    let anyQuay = false;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (!isQuay(x, y)) continue;
        anyQuay = true;
        qv[y * V + x] = qv[y * V + x + 1] = qv[(y + 1) * V + x] = qv[(y + 1) * V + x + 1] = 1;
      }
    if (anyQuay)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          if (!water[y * n + x]) continue;
          for (const v of [y * V + x, y * V + x + 1, (y + 1) * V + x, (y + 1) * V + x + 1]) if (qv[v]) qw[v] = 1;
        }
    // 岸壁の前の水のマス（岸壁にふれる頂点をもつ水のマス）は、自分だけの頂点で深い海底まで下げる（砂浜のような坂にしない）
    const basin: number[] = [];
    if (anyQuay)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++)
          if (water[y * n + x] && (qw[y * V + x] || qw[y * V + x + 1] || qw[(y + 1) * V + x] || qw[(y + 1) * V + x + 1])) basin.push(y * n + x);
    const isBasin = new Uint8Array(n * n);
    for (const i of basin) isBasin[i] = 1;
    const bedH = (vx: number, vy: number) => { const v = vy * V + vx, h = g.heights[v]; return qw[v] ? Math.min(h, QUAY_BED) : h; };
    // 岸壁でない陸と、下げた水のマスのあいだのすき間をふさぐ縦の面（岸壁のマスは岸壁の層が壁を描く）
    const fill: number[] = []; // [ax, az, aTop, aBot, bx, az, bTop, bBot, 内向きの dx, dz]
    for (const i of basin) {
      const x = i % n, y = (i / n) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const qx = x + dx, qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= n || qy >= n) continue;
        const j = qy * n + qx;
        if (water[j] || isQuay(qx, qy)) continue;
        // 辺の2つの頂点
        const ax = dx === 1 ? x + 1 : x, ay = dy === 1 ? y + 1 : y;
        const bx = dx === 0 ? ax + 1 : ax, by = dx === 0 ? ay : ay + 1;
        const at = g.vh(ax, ay), ab = bedH(ax, ay), bt = g.vh(bx, by), bb = bedH(bx, by);
        if (at - ab < 0.01 && bt - bb < 0.01) continue;
        fill.push(ax, ay, at, ab, bx, by, bt, bb, -dx, -dy);
      }
    }
    const NV = V * V + basin.length * 4 + (fill.length / 10) * 4;
    let pos = this.geom.getAttribute('position') as THREE.BufferAttribute;
    let col = this.geom.getAttribute('color') as THREE.BufferAttribute;
    if (pos.count !== NV) {
      const p = new Float32Array(NV * 3);
      p.set((pos.array as Float32Array).subarray(0, V * V * 3));
      pos = new THREE.BufferAttribute(p, 3);
      col = new THREE.BufferAttribute(new Float32Array(NV * 3), 3);
      this.geom.setAttribute('position', pos);
      this.geom.setAttribute('color', col);
      this.geom.deleteAttribute('normal');
      this.ovGeom.setAttribute('position', pos);
    }
    const c = new THREE.Color();
    const grassA = new THREE.Color(0x6d8f45), grassB = new THREE.Color(0x87a052), dry = new THREE.Color(0xa29a62);
    const sand = new THREE.Color(0xc9b98a), rock = new THREE.Color(0x8c8577), bed = new THREE.Color(0x5e6b55);
    for (let y = 0; y < V; y++)
      for (let x = 0; x < V; x++) {
        const vi = y * V + x;
        const h = g.heights[vi];
        pos.setXYZ(vi, x * CELL, h, y * CELL);
        // 岸壁のすぐ前の水は深い（白い波の帯を出さない）
        this.heightData[vi] = THREE.DataUtils.toHalfFloat(qw[vi] ? Math.min(h, QUAY_BED) : h);
        // 傾き
        const hx = g.heights[y * V + Math.min(n, x + 1)] - g.heights[y * V + Math.max(0, x - 1)];
        const hy = g.heights[Math.min(n, y + 1) * V + x] - g.heights[Math.max(0, y - 1) * V + x];
        const slope = Math.hypot(hx, hy) / (CELL * 2);
        const nz = hash2(x, y, 7);
        c.copy(grassA).lerp(grassB, nz * 0.7);
        if (h > 40) c.lerp(dry, Math.min(1, (h - 40) / 40));
        // 岸壁の地面はふつうの地面の色（砂浜や岩の色にしない）
        if (!qv[vi]) {
          if (h < WATER_LEVEL + 2.2) c.lerp(sand, Math.min(1, (WATER_LEVEL + 2.2 - h) / 1.6));
          if (h < WATER_LEVEL - 0.5) c.copy(bed);
          if (slope > 0.35) c.lerp(rock, Math.min(1, (slope - 0.35) * 2.5));
        }
        col.setXYZ(vi, c.r, c.g, c.b);
      }
    // 三角形：ふつうのマスは共有の頂点、岸壁の前の水のマスは自分の頂点、最後にすき間をふさぐ面
    const idx = new Uint32Array(n * n * 6 + (fill.length / 10) * 6);
    let k = 0, nv = V * V;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (isBasin[y * n + x]) continue;
        const a = y * V + x, b = a + 1, cc = a + V, d = cc + 1;
        idx[k++] = a; idx[k++] = cc; idx[k++] = b;
        idx[k++] = b; idx[k++] = cc; idx[k++] = d;
      }
    for (const i of basin) {
      const x = i % n, y = (i / n) | 0;
      const a = nv, b = nv + 1, cc = nv + 2, d = nv + 3;
      for (const [q, vx, vy] of [[a, x, y], [b, x + 1, y], [cc, x, y + 1], [d, x + 1, y + 1]]) {
        pos.setXYZ(q, vx * CELL, bedH(vx, vy), vy * CELL);
        col.setXYZ(q, bed.r, bed.g, bed.b);
      }
      nv += 4;
      idx[k++] = a; idx[k++] = cc; idx[k++] = b;
      idx[k++] = b; idx[k++] = cc; idx[k++] = d;
    }
    const ovCount = k;
    const wall = new THREE.Color(0x6f6a5f);
    for (let f = 0; f < fill.length; f += 10) {
      const [ax, ay, at, ab, bx, by, bt, bb, ix, iy] = fill.slice(f, f + 10);
      const q = nv;
      pos.setXYZ(q, ax * CELL, at, ay * CELL);
      pos.setXYZ(q + 1, ax * CELL, ab, ay * CELL);
      pos.setXYZ(q + 2, bx * CELL, bt, by * CELL);
      pos.setXYZ(q + 3, bx * CELL, bb, by * CELL);
      for (let m = 0; m < 4; m++) col.setXYZ(q + m, wall.r, wall.g, wall.b);
      nv += 4;
      // 面の向き：水のマスの側（ix, iy）を向くように
      const ex = (bx - ax), ez = (by - ay);
      // (a_top -> a_bot -> b_top) の法線の水平成分 = (ez, -ex) の向き
      const flip = ez * ix - ex * iy < 0;
      if (!flip) { idx[k++] = q; idx[k++] = q + 1; idx[k++] = q + 2; idx[k++] = q + 2; idx[k++] = q + 1; idx[k++] = q + 3; }
      else { idx[k++] = q; idx[k++] = q + 2; idx[k++] = q + 1; idx[k++] = q + 2; idx[k++] = q + 3; idx[k++] = q + 1; }
    }
    const index = new THREE.BufferAttribute(idx, 1);
    this.geom.setIndex(index);
    this.ovGeom.setIndex(index);
    this.ovGeom.setDrawRange(0, ovCount);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.heightTex.needsUpdate = true;
    this.geom.computeVertexNormals();
    this.geom.computeBoundingSphere();
    this.ovGeom.boundingSphere = this.geom.boundingSphere;
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
