// 保存（IndexedDB）とファイルの書き出し・読み込み
import type { SaveData } from './sim/world';

const DB = 'pocket-metro';
const STORE = 'saves';

export interface SaveMeta {
  slot: string;
  name: string;
  population: number;
  day: number;
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(STORE);
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }),
  );
}

export function populationOf(d: SaveData) {
  let p = 0;
  for (const b of d.buildings) if (!b.civic && b.state === 1 && String(b.type).startsWith('R')) p += b.occ;
  return p;
}

export async function writeSave(slot: string, d: SaveData) {
  const meta: SaveMeta = { slot, name: d.name, population: populationOf(d), day: d.day, savedAt: Date.now() };
  await tx(STORE, 'readwrite', (s) => s.put(d, slot));
  await tx('meta', 'readwrite', (s) => s.put(meta, slot));
}

export function readSave(slot: string): Promise<SaveData | undefined> {
  return tx(STORE, 'readonly', (s) => s.get(slot) as IDBRequest<SaveData | undefined>);
}

export async function listSaves(): Promise<SaveMeta[]> {
  try {
    return await tx('meta', 'readonly', (s) => s.getAll() as IDBRequest<SaveMeta[]>);
  } catch {
    return [];
  }
}

// ---- ファイル ----
const TYPED = ['heights', 'road', 'conn', 'flow', 'deck', 'up', 'conn1', 'flow1', 'upH', 'ictl', 'isplit', 'iflags', 'pline', 'zone', 'zden', 'bldg', 'tree', 'congestion', 'traffic'] as const;

function toB64(a: ArrayBufferView): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export async function exportFile(d: SaveData): Promise<Blob> {
  const obj: Record<string, unknown> = { ...d, format: 'pocket-metro' };
  for (const k of TYPED) {
    const v = d[k];
    if (v) obj[k] = toB64(v);
  }
  const json = JSON.stringify(obj);
  if ('CompressionStream' in window) {
    const cs = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(cs).blob();
  }
  return new Blob([json], { type: 'application/json' });
}

export async function importFile(f: Blob): Promise<SaveData> {
  const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
  let text: string;
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const ds = f.stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(ds).text();
  } else text = await f.text();
  const obj = JSON.parse(text);
  if (obj.format !== 'pocket-metro') throw new Error('Pocket Metro の保存ファイルではありません');
  const out = obj as Record<string, unknown>;
  const types: Record<string, (b: ArrayBuffer) => ArrayBufferView> = {
    heights: (b) => new Float32Array(b), deck: (b) => new Float32Array(b), upH: (b) => new Float32Array(b), congestion: (b) => new Float32Array(b), traffic: (b) => new Float32Array(b),
    bldg: (b) => new Int32Array(b),
  };
  for (const k of TYPED) {
    if (!obj[k]) continue;
    const u = fromB64(obj[k]);
    const buf = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
    out[k] = types[k] ? types[k](buf) : new Uint8Array(buf);
  }
  return out as unknown as SaveData;
}
