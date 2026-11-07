// 3D 描画のまとめ役
import * as THREE from 'three';
import { Grid } from '../sim/grid';
import { CELL } from '../sim/constants';
import type { Building, Maps } from '../sim/world';
import { TerrainLayer } from './terrainLayer';
import { RoadLayer } from './roadLayer';
import { RailLayer, StationLayer } from './railLayer';
import { PropsLayer } from './propsLayer';
import { BuildingLayer } from './buildingLayer';
import { TreeLayer } from './treeLayer';
import { CarLayer } from './carLayer';
import { PreviewLayer } from './previewLayer';
import { CameraRig, pickGround } from './cameraRig';
import { buildOverlay, DataView } from './overlay';
import { StreetLights } from './lightsLayer';
import { SkyDome } from './sky';
import { updateAO } from './ao';
import { PostFX } from './post';
import { shared } from './materials';
import { findIslands } from './turnback';
import { pondUniforms } from './parkPond';

export interface Quality {
  shadows: boolean;
  pixelRatio: number;
  cars: boolean;
  hq?: boolean; // 高画質（光のにじみ、色の調整）
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class CityRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  rig: CameraRig;
  terrain: TerrainLayer | null = null;
  roads = new RoadLayer();
  rails = new RailLayer();
  props = new PropsLayer();
  underground = false;
  buildings = new BuildingLayer();
  trees = new TreeLayer();
  cars = new CarLayer();
  preview = new PreviewLayer();
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  // 昼と夜：timeOfDay は 0..1（0.5 が正午）。auto のときは時間が進んでいる間だけ回る
  dayMode: 'auto' | 'day' | 'night' = 'auto';
  timeOfDay = 0.36;
  // 時間の進む倍率（0 = 一時停止、1・2・4 = 倍速）。車・列車・船・波・雲・昼夜に掛ける
  timeScale: () => number = () => 0;
  private night = 0;
  get nightAmount() {
    return this.night;
  }
  private sunDir = new THREE.Vector3(-0.62, 0.52, 0.42).normalize();
  lights = new StreetLights();
  sky = new SkyDome();
  stationsMesh = new StationLayer();
  private post: PostFX | null = null;
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
    // コントラストを上げて、立体感を出す
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.rig = new CameraRig(1);
    const sky = new THREE.Color(0xa9cbe6);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 1500, 7000);
    // 環境光は弱め、太陽を強めにして、日なたと日かげの差をはっきりさせる
    this.hemi = new THREE.HemisphereLight(0xcfe0f2, 0x4f4a3e, 0.85);
    this.scene.add(this.hemi, this.lights.group, this.sky.mesh, this.stationsMesh.mesh);
    this.sun = new THREE.DirectionalLight(0xffeed6, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.roads.group, this.rails.group, this.props.group, this.buildings.group, this.trees.group, this.cars.group, this.preview.mesh, this.preview.line);
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
    if (this.quality.hq && !this.post) this.post = new PostFX(this.renderer, this.scene, this.rig.camera);
    if (!this.quality.hq && this.post) { this.post.dispose(); this.post = null; }
    this.resize();
  }

  private sizeKey = '';
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.sizeKey = `${w}x${h}`;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h, this.quality.pixelRatio);
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
    // 交差点の制御方式が変わったら道路を作り直す（信号やラウンドアバウトの表示）
    const old = this.roads.jctl;
    if (old.length !== m.jctl.length || old.some((v, i) => v !== m.jctl[i])) {
      this.roads.jctl = m.jctl;
      this.dirty.grid = true;
    }
    if (this.grid) this.cars.setData(this.grid, m.traffic, m.congestion, m.freight, m.riders, m.garbage, m.garbageLeft);
    this.kick();
  }

  setDataView(v: DataView) {
    this.dataView = v;
    this.dirty.overlay = true;
    this.kick();
  }

  // 地下の画面：地上を透かして、地下鉄の線路を見せる
  setUnderground(on: boolean) {
    if (this.underground === on) return;
    this.underground = on;
    this.rails.setUnderground(on);
    this.cars.showSubway = on;
    const fade = (m: THREE.Material | THREE.Material[] | undefined, op: number) => {
      for (const mm of Array.isArray(m) ? m : m ? [m] : []) {
        mm.transparent = op < 1;
        mm.opacity = op;
        mm.depthWrite = op >= 1;
        mm.needsUpdate = true;
      }
    };
    if (this.terrain) fade((this.terrain.mesh as THREE.Mesh).material, on ? 0.35 : 1);
    this.buildings.group.traverse((o) => fade((o as THREE.Mesh).material, on ? 0.2 : 1));
    fade(this.buildings.material, on ? 0.2 : 1);
    this.roads.group.traverse((o) => fade((o as THREE.Mesh).material, on ? 0.35 : 1));
    this.trees.group.visible = !on;
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
    // 座標は #app の中の座標（画面を回していても、地図の左上が 0, 0）
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const nx = (clientX / w) * 2 - 1;
    const ny = -(clientY / h) * 2 + 1;
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
    if (this.dirty.grid) {
      // 建物が建つたびに grid は更新されるので、道路に関係する部分が変わったときだけ作り直す
      const key = this.roadKey(g);
      if (key !== this.lastRoadKey || heights) {
        this.lastRoadKey = key;
        this.roads.rebuild(g);
        const isl = findIslands(g, this.buildingList);
        this.rails.rebuild(g, this.stationCells(), isl);
        this.cars.setTurnbacks(g);
        this.cars.setIslands(isl);
        this.lights.rebuild(g);
        this.dirty.trees = true; // 街路樹
        this.stationsMesh.rebuild(g, this.buildingList);
      }
    }
    if (this.dirty.buildings || heights) {
      // 駅が増えたり減ったりしたら、防音壁を開け直す
      const sc = this.stationCells();
      const sig = [...sc].sort((a, b) => a - b).join(',');
      if (sig !== this.lastStationSig) { this.lastStationSig = sig; const isl = findIslands(g, this.buildingList); this.rails.rebuild(g, sc, isl); this.cars.setIslands(isl); }
      if (this.buildings.update(g, this.buildingList, heights)) this.dirty.trees = true;
      updateAO(g, this.buildingList);
      this.lights.setBeacons(this.buildings.allBeacons());
      this.props.setFx(this.buildings.allFx());
      this.props.setBuildings(g, this.buildingList);
      this.cars.setStations(g, this.buildingList);
      this.stationsMesh.rebuild(g, this.buildingList);
    }
    if (this.dirty.trees) this.trees.rebuild(g, this.buildings.allTrees());
    if (this.dirty.overlay) {
      buildOverlay(this.terrain.overlayData, g, this.maps, this.dataView);
      this.terrain.commitOverlay();
    }
    this.dirty = { heights: false, grid: false, buildings: false, overlay: false, trees: false };
  }

  private lastRoadKey = -1;
  private lastStationSig = '';
  // 高架鉄道の駅のホームがあるマス（敷地のある駅のまわりと、線路の上だけの駅）
  private stationCells(): Set<number> {
    const g = this.grid!, out = new Set<number>();
    for (const b of this.buildingList) {
      if (!b.civic || b.type !== 'el_station') continue;
      for (let y = b.y - 1; y <= b.y + b.h; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) if (g.inb(x, y) && g.erail[g.idx(x, y)]) out.add(g.idx(x, y));
    }
    for (let i = 0; i < g.estn.length; i++) if (g.estn[i]) out.add(i);
    return out;
  }
  private roadKey(g: Grid) {
    let h = 2166136261;
    const mix = (v: number) => { h = Math.imul(h ^ v, 16777619); };
    const N = g.n * g.n;
    for (let i = 0; i < N; i++) {
      if (!(g.road[i] | g.up[i] | g.pline[i] | g.rail[i] | g.erail[i] | g.mono[i] | g.sub[i] | g.bstop[i])) continue;
      mix(g.rail[i] | (g.erail[i] << 8) | (g.mono[i] << 16) | (g.sub[i] << 24)); mix(g.bstop[i]); mix(g.bstyle[i]); mix(g.estn[i]); mix(g.pstyle[i]);
      mix(i); mix(g.road[i]); mix(g.conn[i]); mix(g.up[i]); mix(g.conn1[i]); mix(g.pline[i]); mix(Math.round(g.upH[i] * 4)); mix(Math.round(g.deck[i] * 4)); mix(Math.round(g.lift[i] * 4));
    }
    if (this.roads.jctl.length) for (let i = 0; i < N; i++) if (this.roads.jctl[i]) { mix(i); mix(this.roads.jctl[i]); }
    return h;
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    // 画面を回したとき、iPhone は大きさが決まる前に resize を送ることがあるので、毎フレーム確かめて直す
    const cw = this.canvas.clientWidth, chh = this.canvas.clientHeight;
    if (cw > 0 && chh > 0 && (`${cw}x${chh}` !== this.sizeKey || Math.abs(this.rig.camera.aspect - cw / chh) > 0.01)) this.resize();
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
    this.cars.viewDist = this.rig.dist;
    // 一時停止中は、車・列車・船・飛行機・雲・波も止める
    const mdt = dt * this.timeScale();
    if (carsMoving) {
      // 倍速で1コマの進みが大きいときは、細かく刻んで動かす（列車の間隔や停車がずれないように）
      const n = Math.min(4, Math.ceil(mdt / 0.1 - 1e-6) || 1);
      for (let k = 0; k < n; k++) this.cars.update(mdt / n);
    }
    this.cars.group.visible = carsMoving;
    this.props.update(mdt);
    this.updateDayNight(dt);
    this.updateShadow();
    // 遠くほど空の色に溶け込む（ズームに合わせて霧の距離を変える）
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.rig.dist * 0.9 + 300;
    fog.far = this.rig.dist * 4.2 + 2600;
    this.sky.uniforms.uTime.value += mdt;
    if (this.terrain) {
      const wu = this.terrain.waterUniforms;
      wu.uTime.value += mdt;
      wu.uSky.value.copy(this.sky.uniforms.uHorizon.value).lerp(this.sky.uniforms.uZenith.value, 0.3);
      wu.uNight.value = this.night;
      pondUniforms.uTime.value = wu.uTime.value;
      pondUniforms.uSky.value.copy(wu.uSky.value);
      pondUniforms.uNight.value = this.night;
    }
    this.sky.follow(this.rig.camera);
    this.lights.update(now / 1000);
    this.trees.setLod(this.rig.dist);
    if (this.post) {
      this.post.setNight(this.night);
      this.post.render(dt);
    } else this.renderer.render(this.scene, this.rig.camera);
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
    // 太陽はやや低めにして、影を長く出す（立体感のため）
    const dir = this.sunDir;
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
    this.sun.castShadow = this.quality.shadows && d < 1800 && this.night < 0.75;
  }

  // 1日の長さ（実時間の秒）
  static DAY_SECONDS = 480;
  private lastNightKey = -1;
  private updateDayNight(dt: number) {
    if (this.dayMode === 'auto') {
      this.timeOfDay = (this.timeOfDay + (dt * this.timeScale()) / CityRenderer.DAY_SECONDS) % 1;
    } else this.timeOfDay = this.dayMode === 'day' ? 0.4 : 0.95;
    const tod = this.timeOfDay;
    // 太陽の高さ（6時に昇り、18時に沈む）
    const elev = Math.sin((tod - 0.25) * Math.PI * 2);
    const day = smooth(-0.1, 0.22, elev);
    const night = 1 - day;
    const key = Math.round(tod * 2000);
    if (key === this.lastNightKey) return;
    this.lastNightKey = key;
    this.night = night;
    // 夕方・朝方は赤っぽく
    const dusk = Math.max(0, 1 - Math.abs(elev) / 0.3) * day;
    // 太陽の向き：東から昇って西へ。影が見やすいように、高さは低めに抑える
    const az = (tod - 0.25) * Math.PI;
    const h = day > 0 ? Math.max(0.28, Math.min(0.62, elev)) : 0.6;
    if (day > 0.02) this.sunDir.set(-Math.cos(az) * 0.8, h, 0.45 - Math.sin(az) * 0.25).normalize();
    else this.sunDir.set(0.35, 0.7, -0.4).normalize(); // 月明かり
    const C = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t);
    const sunCol = C(0xffeed6, 0xff9a5a, dusk).lerp(new THREE.Color(0x8fa6e8), night);
    this.sun.color.copy(sunCol);
    this.sun.intensity = 3.0 * day + 0.55 * night;
    this.hemi.intensity = 1.05 * day + 0.42 * night;
    this.hemi.color.copy(C(0xcfe0f2, 0xf0c0a0, dusk).lerp(new THREE.Color(0x5a6ea8), night));
    this.hemi.groundColor.copy(C(0x6e675a, 0x1a1c28, night));
    const sky = C(0xa9cbe6, 0xe8a27c, dusk).lerp(new THREE.Color(0x0c1528), night);
    (this.scene.background as THREE.Color).copy(sky);
    this.scene.fog!.color.copy(sky);
    const su = this.sky.uniforms;
    su.uHorizon.value.copy(sky);
    su.uZenith.value.copy(C(0x4f86cc, 0x5a6aa8, dusk).lerp(new THREE.Color(0x030812), night));
    su.uSunColor.value.copy(C(0xfff2d8, 0xffa060, dusk));
    su.uDay.value = day;
    if (day > 0.02) su.uSunDir.value.set(-Math.cos(az), Math.max(-0.05, elev), 0.45 - Math.sin(az) * 0.25).normalize();
    this.renderer.toneMappingExposure = 1.15 - 0.1 * night;
    shared.uNight.value = smooth(0.25, 0.85, night);
    this.stationsMesh.lights.visible = shared.uNight.value > 0.3;
    this.buildings.setNight(shared.uNight.value);
    // ガラスに映る空と太陽
    shared.uSunDir.value.copy(this.sunDir);
    shared.uSunCol.value.copy(sunCol).multiplyScalar(day);
    shared.uSkyTop.value.copy(su.uZenith.value).lerp(new THREE.Color(1, 1, 1), 0.12);
    shared.uSkyHz.value.copy(sky);
    this.lights.setNight(smooth(0.35, 0.9, night));
    this.cars.setNight(smooth(0.35, 0.9, night));
  }
}
