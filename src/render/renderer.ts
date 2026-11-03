// 3D 描画のまとめ役
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import type { Building, Maps } from '../sim/world';
import { TerrainLayer } from './terrainLayer';
import { RoadLayer } from './roadLayer';
import { BuildingLayer } from './buildingLayer';
import { TreeLayer } from './treeLayer';
import { CarLayer } from './carLayer';
import { PreviewLayer } from './previewLayer';
import { CameraRig, pickGround } from './cameraRig';
import { buildOverlay, DataView } from './overlay';

export interface Quality {
  shadows: boolean;
  pixelRatio: number;
  cars: boolean;
}

export class CityRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  rig: CameraRig;
  terrain: TerrainLayer | null = null;
  roads = new RoadLayer();
  buildings = new BuildingLayer();
  trees = new TreeLayer();
  cars = new CarLayer();
  preview = new PreviewLayer();
  sun: THREE.DirectionalLight;
  grid: Grid | null = null;
  maps: Maps | null = null;
  buildingList: Building[] = [];
  dataView: DataView = 'none';
  showGrid = false;
  private last = performance.now();
  private dirty = { heights: false, grid: false, buildings: false, overlay: false, trees: false };
  private canvas: HTMLCanvasElement;
  quality: Quality = { shadows: true, pixelRatio: Math.min(2, window.devicePixelRatio || 1), cars: true };
  fps = 60;
  private fpsAcc = 0;
  private fpsN = 0;
  private idleFrames = 0;
  onFrame: ((dt: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.rig = new CameraRig(1);
    const sky = new THREE.Color(0xa9cbe6);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 1500, 7000);
    this.scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x5b5a48, 1.25));
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.roads.group, this.buildings.group, this.trees.group, this.cars.mesh, this.preview.mesh, this.preview.line);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame(this.loop);
  }

  setQuality(q: Partial<Quality>) {
    Object.assign(this.quality, q);
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.sun.castShadow = this.quality.shadows;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
    this.cars.enabled = this.quality.cars;
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
    this.kick();
  }

  // 新しい都市のときに呼ぶ
  init(n: number) {
    if (this.terrain) this.scene.remove(this.terrain.group);
    this.terrain = new TerrainLayer(n);
    this.scene.add(this.terrain.group);
    this.grid = new Grid(n);
    this.rig.setMap(n);
    this.scene.remove(this.buildings.group);
    this.buildings = new BuildingLayer();
    this.scene.add(this.buildings.group);
  }

  setGrid(g: Grid, heightsChanged: boolean) {
    this.grid = g;
    if (heightsChanged) this.dirty.heights = true;
    this.dirty.grid = true;
    this.dirty.overlay = true;
    this.dirty.trees = true;
    this.kick();
  }

  setBuildings(list: Building[]) {
    this.buildingList = list;
    this.dirty.buildings = true;
    this.kick();
  }

  setMaps(m: Maps) {
    this.maps = m;
    this.dirty.overlay = true;
    if (this.grid) this.cars.setData(this.grid, m.traffic, m.congestion);
    this.kick();
  }

  setDataView(v: DataView) {
    this.dataView = v;
    this.dirty.overlay = true;
    this.kick();
  }

  setShowGrid(on: boolean) {
    this.showGrid = on;
    this.terrain?.setGrid(on);
    this.kick();
  }

  // しばらく操作がなくても描画を続ける
  kick() {
    this.idleFrames = 0;
  }

  pick(clientX: number, clientY: number) {
    if (!this.grid) return null;
    const r = this.canvas.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = -((clientY - r.top) / r.height) * 2 + 1;
    const p = pickGround(this.rig.camera, nx, ny, this.grid);
    if (!p) return null;
    const n = this.grid.n;
    const x = Math.floor(p.x / CELL), y = Math.floor(p.z / CELL);
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    return { x, y, point: p };
  }

  private flush() {
    const g = this.grid;
    if (!g || !this.terrain) return;
    const heights = this.dirty.heights;
    if (heights) this.terrain.updateHeights(g);
    if (this.dirty.grid) this.roads.rebuild(g);
    if (this.dirty.buildings || heights) {
      if (this.buildings.update(g, this.buildingList, heights)) this.dirty.trees = true;
    }
    if (this.dirty.trees) this.trees.rebuild(g, this.buildings.allTrees());
    if (this.dirty.overlay) {
      buildOverlay(this.terrain.overlayData, g, this.maps, this.dataView);
      this.terrain.commitOverlay();
    }
    this.dirty = { heights: false, grid: false, buildings: false, overlay: false, trees: false };
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.onFrame?.(dt);
    this.flush();
    const animating = Math.abs(this.rig.yawTarget - this.rig.yaw) > 1e-3;
    if (animating) this.kick();
    // 車があるときは描画を続ける。何も動かないときは描画を間引く（発熱対策）
    const carsMoving = this.quality.cars && this.rig.dist < 1400;
    this.idleFrames++;
    if (!carsMoving && this.idleFrames > 30 && this.idleFrames % 10 !== 0) return;
    this.rig.update(dt, this.grid);
    if (carsMoving) this.cars.update(dt);
    else this.cars.mesh.count = 0;
    this.updateShadow();
    this.renderer.render(this.scene, this.rig.camera);
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 1) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
  };

  private updateShadow() {
    const t = this.rig.target;
    const d = this.rig.dist;
    const span = Math.min(1600, Math.max(120, d * 1.3));
    const dir = new THREE.Vector3(-0.55, 0.75, 0.38).normalize();
    this.sun.position.copy(t).addScaledVector(dir, span * 2);
    this.sun.target.position.copy(t);
    const cam = this.sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = span * 4;
    cam.updateProjectionMatrix();
    // 遠くからは影を省く
    this.sun.castShadow = this.quality.shadows && d < 1800;
  }
}
