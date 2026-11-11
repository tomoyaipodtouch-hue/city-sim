import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // ビルドごとの印（メニューの絵の覚えを、ビルドが変わったら作り直す）
  define: { __BUILD__: JSON.stringify(String(Date.now())) },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: true },
});
