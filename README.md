# Pocket Metro

スマホのブラウザで遊べる都市開発シミュレーション（iPhone 13 の Safari を基準に、横向きで遊ぶ）。

- 遊ぶ：https://tomoyaipodtouch-hue.github.io/city-sim/
- 要件定義書：[docs/requirements.md](docs/requirements.md)

## 開発

```bash
npm install
npm run dev     # 開発サーバー
npm test        # シミュレーションのテスト
npm run build   # 本番用のビルド（dist/）
```

## 構成

| フォルダ | 内容 |
|---|---|
| `src/sim/` | シミュレーション（Web Worker で動く）。地形、道路、ゾーン、電力、水道、需要、建物の成長、通勤の交通、予算 |
| `src/render/` | 3D 描画（Three.js）。地形、道路、建物の自動生成、木、車、カメラ |
| `src/ui/` | 画面の UI、タッチ操作、ツール |
| `public/` | PWA（manifest、Service Worker、アイコン） |
