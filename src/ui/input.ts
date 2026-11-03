// タッチとマウスの操作
import * as THREE from 'three';
import type { CityRenderer } from '../render/renderer';
import type { ToolController, PreviewInfo } from './tools';

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
}

type Mode = 'idle' | 'pan' | 'tool' | 'gesture' | 'ending';

export class Input {
  private ptrs = new Map<number, Ptr>();
  private mode: Mode = 'idle';
  private g0 = { dist: 0, angle: 0, mx: 0, my: 0, rotAcc: 0 };
  private lastCell = { x: -1, y: -1 };

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
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t0: performance.now(), button: e.button });
    this.hooks.onInteract();
    this.r.kick();
    if (this.ptrs.size === 1) {
      const mouseAlt = e.pointerType === 'mouse' && e.button !== 0;
      if (this.tools.isDragTool && !mouseAlt) {
        const c = this.r.pick(e.clientX, e.clientY);
        if (c) {
          this.mode = 'tool';
          this.lastCell = { x: c.x, y: c.y };
          const info = this.tools.begin(c.x, c.y);
          this.hooks.onDragUI(true);
          this.hooks.onPreview(info, e.clientX, e.clientY, false);
          return;
        }
      }
      this.mode = 'pan';
    } else if (this.ptrs.size === 2) {
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
    }
  };

  private move = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    this.r.kick();
    if (this.mode === 'tool') {
      const over = this.hooks.isOverCancel(e.clientX, e.clientY);
      const c = over ? null : this.r.pick(e.clientX, e.clientY);
      if (c && (c.x !== this.lastCell.x || c.y !== this.lastCell.y)) {
        this.lastCell = { x: c.x, y: c.y };
        const info = this.tools.update(c.x, c.y);
        this.hooks.onPreview(info, e.clientX, e.clientY, over);
      } else this.hooks.onPreview(undefined, e.clientX, e.clientY, over);
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
      this.r.rig.pan(mx - this.g0.mx, my - this.g0.my, this.canvas.clientHeight);
      if (dist > 10 && this.g0.dist > 10) {
        const anchor = this.r.pick(mx, my)?.point || null;
        this.r.rig.zoom(this.g0.dist / dist, anchor);
      }
      let da = angle - this.g0.angle;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      this.g0.rotAcc += da;
      if (Math.abs(this.g0.rotAcc) > 0.55) {
        this.r.rig.rotate(this.g0.rotAcc > 0 ? 1 : -1);
        this.g0.rotAcc = 0;
      }
      this.g0.dist = dist;
      this.g0.angle = angle;
      this.g0.mx = mx;
      this.g0.my = my;
    }
  };

  private up = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    if (!p) return;
    if (this.mode === 'tool') {
      // キャンセル枠を隠す前に、枠の上で指を離したかを判定する
      const cancelled = this.hooks.isOverCancel(e.clientX, e.clientY);
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
      const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
      if (moved < 8 && performance.now() - p.t0 < 400) {
        const c = this.r.pick(e.clientX, e.clientY);
        if (c) this.hooks.onTap(c, e.clientX, e.clientY);
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
    if (this.mode === 'tool') {
      this.tools.cancel();
      this.hooks.onDragUI(false);
      this.hooks.onPreview(null, 0, 0, false);
    }
    if (!this.ptrs.size) this.mode = 'idle';
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const anchor = this.r.pick(e.clientX, e.clientY)?.point || null;
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
