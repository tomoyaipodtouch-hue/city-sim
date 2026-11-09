// タッチとマウスの操作
import * as THREE from 'three';
import type { CityRenderer } from '../render/renderer';
import type { ToolController, PreviewInfo } from './tools';
import { toApp } from './orient';
import { CELL } from '../sim/constants';

// 画面を回しているときは、#app の中の座標に直して使う
const ax = (e: MouseEvent) => toApp(e.clientX, e.clientY)[0];
const ay = (e: MouseEvent) => toApp(e.clientX, e.clientY)[1];

// 2本指でこれだけひねるごとに、カメラを 30° 回す（ラジアン）
const TWIST_STEP = 0.4;
// ツールでなぞっているとき、指が地図の端からこの幅（px）に入って少し止まると、その向きへ地図を動かす
const EDGE_BAND = 32;
const EDGE_DWELL = 0.25; // 動かし始めるまでの時間（秒）。端の近くを通り過ぎるだけでは動かさない
const EDGE_SPEED = 480; // いちばん端での速さ（px/秒、地図をなぞって動かすのと同じ単位）
const wrapAngle = (a: number) => (a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a);

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  button: number;
}

export interface InputHooks {
  onTap: (cell: { x: number; y: number }, clientX: number, clientY: number) => void;
  onDragUI: (show: boolean) => void;
  // info が undefined のときは表示内容を変えず、位置だけ更新する
  onPreview: (info: PreviewInfo | null | undefined, clientX: number, clientY: number, overCancel: boolean) => void;
  isOverCancel: (clientX: number, clientY: number) => boolean;
  onCancelled: () => void;
  onInteract: () => void;
  onPitch?: (offsetDeg: number) => void; // 2本指の上下スワイプでカメラの傾きを変えたとき
}

type Mode = 'idle' | 'pan' | 'tool' | 'gesture' | 'ending';

export class Input {
  private ptrs = new Map<number, Ptr>();
  private mode: Mode = 'idle';
  private g0 = { dist: 0, angle: 0, mx: 0, my: 0, rotAcc: 0 };
  // 2本指の操作の種類：動かし始めで決める（そろって上下 = 傾き、それ以外 = 移動・ズーム・回転）
  private gKind: 'undecided' | 'tilt' | 'pz' = 'undecided';
  private gStart = { ax: 0, ay: 0, bx: 0, by: 0, dist: 0 };
  private toolPos = { x: 0, y: 0 }; // なぞっている指の位置
  private edgeRaf = 0;
  private edgeT = 0;
  private edgeAge = 0; // 端に入ってからの時間（秒）
  private view = { left: 0, top: 0, right: 0, bottom: 0 }; // なぞり始めたときの、地図が見えている範囲

  constructor(private canvas: HTMLCanvasElement, private r: CityRenderer, private tools: ToolController, private hooks: InputHooks) {
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.cancel);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    window.addEventListener('keydown', this.key);
  }

  private down = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.ptrs.set(e.pointerId, { x: ax(e), y: ay(e), sx: ax(e), sy: ay(e), t0: performance.now(), button: e.button });
    this.hooks.onInteract();
    this.r.kick();
    if (this.ptrs.size === 1) {
      const mouseAlt = e.pointerType === 'mouse' && e.button !== 0;
      if (this.tools.isDragTool && !mouseAlt) {
        const c = this.r.pick(ax(e), ay(e));
        if (c) {
          this.mode = 'tool';
          this.toolPos = { x: ax(e), y: ay(e) };
          this.view = this.viewRect();
          const info = this.tools.begin(c.x, c.y, c.point.x / CELL, c.point.z / CELL);
          this.hooks.onDragUI(true);
          this.hooks.onPreview(info, ax(e), ay(e), false);
          return;
        }
      }
      this.mode = 'pan';
    } else if (this.ptrs.size === 2) {
      this.stopEdgePan();
      if (this.mode === 'tool') {
        this.tools.cancel();
        this.hooks.onDragUI(false);
        this.hooks.onPreview(null, 0, 0, false);
      }
      this.mode = 'gesture';
      const [a, b] = [...this.ptrs.values()];
      this.g0 = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        rotAcc: 0,
      };
      this.gKind = 'undecided';
      this.gStart = { ax: a.x, ay: a.y, bx: b.x, by: b.y, dist: this.g0.dist };
    }
  };

  private move = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const dx = ax(e) - p.x, dy = ay(e) - p.y;
    p.x = ax(e);
    p.y = ay(e);
    this.r.kick();
    if (this.mode === 'tool') {
      this.toolPos = { x: ax(e), y: ay(e) };
      this.toolMove();
      this.edgePan();
      return;
    }
    if (this.mode === 'pan') {
      this.r.rig.pan(dx, dy, this.canvas.clientHeight);
      return;
    }
    if (this.mode === 'gesture' && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this.gKind === 'undecided') {
        const S = this.gStart;
        const dax = a.x - S.ax, day = a.y - S.ay, dbx = b.x - S.bx, dby = b.y - S.by;
        if (Math.max(Math.hypot(dax, day), Math.hypot(dbx, dby)) > 14) {
          const vertical = day * dby > 0 && Math.abs(day) > 1.5 * Math.abs(dax) && Math.abs(dby) > 1.5 * Math.abs(dbx);
          this.gKind = vertical && Math.abs(dist - S.dist) < 30 ? 'tilt' : 'pz';
        }
        if (this.gKind === 'undecided') return;
        // 決まるまでにひねった分も、回転には数える
        this.g0.rotAcc = this.gKind === 'pz' ? wrapAngle(angle - this.g0.angle) : 0;
        this.g0.dist = dist;
        this.g0.angle = angle;
        this.g0.mx = mx;
        this.g0.my = my;
      }
      if (this.gKind === 'tilt') {
        // 上へスワイプ = 地面に近い横からの眺め、下へ = 真上寄り
        const rig = this.r.rig;
        rig.pitchOffset = Math.max(-30, Math.min(15, rig.pitchOffset + (my - this.g0.my) * 0.12));
        this.hooks.onPitch?.(Math.round(rig.pitchOffset));
        this.g0.my = my;
        this.g0.mx = mx;
        return;
      }
      this.r.rig.pan(mx - this.g0.mx, my - this.g0.my, this.canvas.clientHeight);
      if (dist > 10 && this.g0.dist > 10) {
        const anchor = this.r.pick(mx, my)?.point || null;
        this.r.rig.zoom(this.g0.dist / dist, anchor);
      }
      const da = wrapAngle(angle - this.g0.angle);
      // ひねった角度がたまるごとに 30° ずつ回す（大きくひねると何段も回る。余りは次に持ちこす）
      this.g0.rotAcc += da;
      while (Math.abs(this.g0.rotAcc) >= TWIST_STEP) {
        const s = Math.sign(this.g0.rotAcc);
        this.r.rig.rotate(s);
        this.g0.rotAcc -= s * TWIST_STEP;
      }
      this.g0.dist = dist;
      this.g0.angle = angle;
      this.g0.mx = mx;
      this.g0.my = my;
    }
  };

  // なぞっている指の下のマスで、ツールのプレビューを更新する（同じ場所なら、ラベルの位置だけ動かす）
  private toolMove() {
    const { x, y } = this.toolPos;
    const over = this.hooks.isOverCancel(x, y);
    const c = over ? null : this.r.pick(x, y);
    const info = c ? this.tools.update(c.x, c.y, c.point.x / CELL, c.point.z / CELL) : undefined;
    this.hooks.onPreview(info, x, y, over);
  }

  // 地図が見えている範囲（左や下のツールバー・情報バーを除く）。#app の中の座標
  private viewRect() {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const r = { left: 0, top: 0, right: W, bottom: H };
    for (const sel of ['.toolbar', '.bar']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const [x0, y0] = toApp(b.left, b.top), [x1, y1] = toApp(b.right, b.bottom);
      const L = Math.min(x0, x1), R = Math.max(x0, x1), T = Math.min(y0, y1), B = Math.max(y0, y1);
      if (B - T > R - L && L < W / 2) r.left = Math.max(r.left, R); // 左の縦長のバー
      else if (R - L >= B - T && T > H / 2) r.bottom = Math.min(r.bottom, T); // 下の横長のバー
    }
    return r;
  }

  // 指が地図の端の近くにあれば、その向きへ地図を動かし続ける（キャンセルの枠の上では動かさない）
  private edgeVec(): [number, number] {
    const { x, y } = this.toolPos;
    if (this.hooks.isOverCancel(x, y)) return [0, 0];
    const r = this.view;
    const k = (d: number) => Math.max(0, Math.min(1, 1 - d / EDGE_BAND));
    return [k(r.right - x) - k(x - r.left), k(r.bottom - y) - k(y - r.top)];
  }

  private edgePan() {
    if (this.edgeRaf || this.mode !== 'tool') return;
    const [vx, vy] = this.edgeVec();
    if (!vx && !vy) return;
    this.edgeT = performance.now();
    this.edgeAge = 0;
    const step = () => {
      this.edgeRaf = 0;
      if (this.mode !== 'tool') return;
      const [ex, ey] = this.edgeVec();
      if (!ex && !ey) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.edgeT) / 1000);
      this.edgeT = now;
      this.edgeAge += dt;
      if (this.edgeAge > EDGE_DWELL) {
        // 指の向こうが見えるように地図を動かす（地図は指と反対へ流れる）。動き始めは少しずつ速くする
        const sp = EDGE_SPEED * dt * Math.min(1, (this.edgeAge - EDGE_DWELL) / 0.4);
        this.r.rig.pan(-ex * sp, -ey * sp, this.canvas.clientHeight);
        this.r.kick();
        this.toolMove();
      }
      this.edgeRaf = requestAnimationFrame(step);
    };
    this.edgeRaf = requestAnimationFrame(step);
  }

  private stopEdgePan() {
    if (this.edgeRaf) cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = 0;
  }

  private up = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    if (!p) return;
    if (this.mode === 'tool') this.stopEdgePan();
    if (this.mode === 'tool') {
      // キャンセル枠を隠す前に、枠の上で指を離したかを判定する
      const cancelled = this.hooks.isOverCancel(ax(e), ay(e));
      this.hooks.onDragUI(false);
      this.hooks.onPreview(null, 0, 0, false);
      if (cancelled) {
        this.tools.cancel();
        this.hooks.onCancelled();
      } else void this.tools.commit();
      this.mode = 'idle';
      return;
    }
    if (this.mode === 'pan') {
      const moved = Math.hypot(ax(e) - p.sx, ay(e) - p.sy);
      if (moved < 8 && performance.now() - p.t0 < 400) {
        const c = this.r.pick(ax(e), ay(e));
        if (c) this.hooks.onTap(c, ax(e), ay(e));
      }
      this.mode = 'idle';
      return;
    }
    if (this.mode === 'gesture') {
      this.mode = this.ptrs.size ? 'ending' : 'idle';
      return;
    }
    if (!this.ptrs.size) this.mode = 'idle';
  };

  private cancel = (e: PointerEvent) => {
    this.ptrs.delete(e.pointerId);
    this.stopEdgePan();
    if (this.mode === 'tool') {
      this.tools.cancel();
      this.hooks.onDragUI(false);
      this.hooks.onPreview(null, 0, 0, false);
    }
    if (!this.ptrs.size) this.mode = 'idle';
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const anchor = this.r.pick(ax(e), ay(e))?.point || null;
    this.r.rig.zoom(Math.exp(e.deltaY * 0.0015), anchor as THREE.Vector3 | null);
    this.r.kick();
  };

  private key = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const rig = this.r.rig;
    if (e.key === 'q' || e.key === 'Q') rig.rotate(-1);
    else if (e.key === 'e' || e.key === 'E') rig.rotate(1);
    else if (e.key === 'ArrowLeft') rig.pan(80, 0, this.canvas.clientHeight);
    else if (e.key === 'ArrowRight') rig.pan(-80, 0, this.canvas.clientHeight);
    else if (e.key === 'ArrowUp') rig.pan(0, 80, this.canvas.clientHeight);
    else if (e.key === 'ArrowDown') rig.pan(0, -80, this.canvas.clientHeight);
    else if (e.key === '+' || e.key === '=') rig.zoom(0.8);
    else if (e.key === '-') rig.zoom(1.25);
    else return;
    this.r.kick();
  };
}
