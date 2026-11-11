// メニューの項目の絵の用意：はじめてメニューを開いたときに、少しずつ（1フレームに数ミリ秒まで）3D で描く。
// 描いた絵は PNG にして覚え（メモリ）、IndexedDB にもビルドごとにしまう（次に起動したときはすぐ出せる）
import type * as THREE from 'three';
import type { ThumbSpec } from './menu';
import { thumbKey } from './menu';
import { menuIcon } from './menuIcons';
import type { ThumbRenderer } from '../render/thumbs';

declare const __BUILD__: string;
const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
const DB = 'pm-thumbs', STORE = 'img';
const BUDGET_MS = 8; // 1回に使う時間の目安（1枚は必ず描く）

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}

interface Job {
  key: string;
  spec: ThumbSpec;
  imgs: Set<HTMLImageElement>;
}

export class ThumbService {
  private urls = new Map<string, string>(); // 鍵 → 絵の URL（blob:）
  private blobs = new Map<string, Blob>(); // IndexedDB から読んだ絵（URL はつかうときに作る）
  private queue: Job[] = [];
  private jobs = new Map<string, Job>();
  private running = false;
  private tr: ThumbRenderer | null = null;
  private trLoading: Promise<ThumbRenderer> | null = null;
  private db: Promise<IDBDatabase | null> | null = null;
  private loaded: Promise<void> | null = null;
  private endTimer = 0;
  private canvas: HTMLCanvasElement | null = null;
  // 計測（確認用）
  stats = { rendered: 0, ms: 0, maxMs: 0, genMs: 0, maxGenMs: 0, slowest: '', fromDb: 0 };

  constructor(private getRenderer: () => THREE.WebGLRenderer) {}

  // 項目の絵の入れ物（.th）に絵を入れる。3D の絵がまだなら、下地のまま描くのを待つ
  fill(box: HTMLElement, spec: ThumbSpec) {
    if (spec.k === 'icon') {
      box.innerHTML = menuIcon(spec.icon);
      return;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    box.append(img);
    const key = thumbKey(spec);
    const url = this.url(key);
    if (url) {
      img.src = url;
      box.classList.add('ready');
      return;
    }
    let j = this.jobs.get(key);
    if (!j) {
      j = { key, spec, imgs: new Set() };
      this.jobs.set(key, j);
      this.queue.push(j);
    }
    j.imgs.add(img);
    this.kick();
  }

  private url(key: string) {
    let u = this.urls.get(key);
    if (!u) {
      const b = this.blobs.get(key);
      if (b) {
        u = URL.createObjectURL(b);
        this.urls.set(key, u);
        this.blobs.delete(key);
      }
    }
    return u;
  }

  // IndexedDB から、このビルドの絵を全部読む（ほかのビルドの絵は捨てる）
  private loadDb() {
    this.db ??= openDb();
    return (this.loaded ??= this.db.then(
      (db) =>
        new Promise<void>((res) => {
          if (!db) return res();
          try {
            const tx = db.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
            const rq = st.openCursor();
            rq.onsuccess = () => {
              const c = rq.result;
              if (!c) return;
              const k = String(c.key);
              if (k.startsWith(BUILD + '|') && c.value instanceof Blob) {
                this.blobs.set(k.slice(BUILD.length + 1), c.value);
                this.stats.fromDb++;
              } else c.delete();
              c.continue();
            };
            tx.oncomplete = () => res();
            tx.onerror = () => res();
          } catch {
            res();
          }
        }),
    ));
  }

  private save(key: string, blob: Blob) {
    this.db?.then((db) => {
      try {
        db?.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, `${BUILD}|${key}`);
      } catch {
        /* しまえなくても、覚えだけで続ける */
      }
    });
  }

  private kick() {
    if (this.running) return;
    this.running = true;
    clearTimeout(this.endTimer);
    void this.loadDb().then(() => this.next());
  }

  private next() {
    // 開いているメニューにない絵（メニューを閉じた）は描かない。次に開いたときにまた頼まれる
    const done = (j: Job) => {
      this.jobs.delete(j.key);
      const u = this.url(j.key);
      if (u) for (const img of j.imgs) { img.src = u; img.parentElement?.classList.add('ready'); }
    };
    while (this.queue.length) {
      const j = this.queue[0];
      for (const img of [...j.imgs]) if (!img.isConnected) j.imgs.delete(img);
      if (!j.imgs.size) { this.queue.shift(); this.jobs.delete(j.key); continue; }
      if (this.url(j.key)) { this.queue.shift(); done(j); continue; }
      break;
    }
    if (!this.queue.length) {
      this.running = false;
      // しばらく頼まれなければ、描画先などを捨てる
      this.endTimer = window.setTimeout(() => this.tr?.end(), 1500);
      return;
    }
    requestAnimationFrame(() => {
      // 画面の描画（同じフレームの requestAnimationFrame）が終わってから描く
      setTimeout(() => void this.step(done), 0);
    });
  }

  private async step(done: (j: Job) => void) {
    const tr = this.tr ?? (await (this.trLoading ??= import('../render/thumbs').then((m) => (this.tr = new m.ThumbRenderer(this.getRenderer())))));
    const t0 = performance.now();
    while (this.queue.length) {
      const j = this.queue[0];
      for (const img of [...j.imgs]) if (!img.isConnected) j.imgs.delete(img);
      if (!j.imgs.size) { this.queue.shift(); this.jobs.delete(j.key); continue; }
      const s0 = performance.now();
      let px: Uint8Array | null = null;
      try {
        px = tr.render(j.spec);
      } catch (e) {
        console.warn('thumb', j.key, e);
      }
      const ms = performance.now() - s0;
      this.stats.rendered++;
      this.stats.ms += ms;
      this.stats.maxMs = Math.max(this.stats.maxMs, ms);
      this.stats.genMs += tr.genMs;
      if (tr.genMs > this.stats.maxGenMs) { this.stats.maxGenMs = tr.genMs; this.stats.slowest = j.key; }
      this.queue.shift();
      if (px) {
        const blob = await this.toBlob(px);
        if (blob) {
          this.urls.set(j.key, URL.createObjectURL(blob));
          this.save(j.key, blob);
        }
      }
      done(j);
      if (performance.now() - t0 > BUDGET_MS) break;
    }
    this.next();
  }

  private toBlob(px: Uint8Array): Promise<Blob | null> {
    const THUMB_PX = Math.round(Math.sqrt(px.length / 4));
    const c = (this.canvas ??= document.createElement('canvas'));
    c.width = c.height = THUMB_PX;
    const ctx = c.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px), THUMB_PX, THUMB_PX), 0, 0);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
  }
}
