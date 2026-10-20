# MotoRecoMovie

Insta360 X6 / X5 の 360° 動画（.insv）を、バイクの車載映像向けにリフレームして書き出す Windows のアプリ（Electron）。
MotoReco の車両ログ（.dat / CSV）があれば、リーン角・車速などのメーター、コーナーの浮遊標識、画角の自動切り替えに使う。

- 水平線を固定しないスタビライズ（リーンの傾きを残す割合を選べる）と、キーフレームでの視点の切り替え
- 前後のレンズのつなぎ目の合わせ込み（近い物の視差の補正、像が合わない所のつなぎ目の位置ずらし）
- 走行状態（加速・減速・コーナー・巡航・停止）と追い越しの検出からの画角の自動切り替え
- 走行中の音を整える（音割れの補修・エンジン音以外を抑える・高い音を切る・音圧を抑える）

詳しくは [docs/app.md](docs/app.md)。.insv の中身は [docs/insv-x6-format.md](docs/insv-x6-format.md)、
MotoReco のログは [docs/telemetry.md](docs/telemetry.md)・[docs/motoreco-dat.md](docs/motoreco-dat.md)・[docs/motoreco-lean.md](docs/motoreco-lean.md)。

## 動かす（app フォルダで）

Node.js（22 以降）が要る。

```bash
npm ci
npm run fetch-assets
npm run dev
```

`npm run fetch-assets` は、リポジトリに入れていない大きなファイル（AI のモデル 4 つ、計 280MB と、同梱する LGPL 版の ffmpeg、150MB）を
出典から取ってくる（モデルは SHA-256、ffmpeg は版の文字列で確かめる）。

配布物（`dist/win-unpacked` とインストーラー）は `npm run dist` で作る。

## フォルダ

| フォルダ | 中身 |
|---|---|
| `app/` | アプリ（`src/main` Electron の本体、`src/preload`、`src/renderer` 画面と処理）、`test/`、`tools/` |
| `docs/` | 仕組みと調べた結果 |
| `proto/` | Python の試作（.insv の読み込み・レンズ・同期・リーン角の融合） |

## ライセンス

このアプリのソースコードは MIT License（[LICENSE](LICENSE)）。

ほかの人が作ったソフトウェアとデータ（ffmpeg、AI のモデル、npm のパッケージ、Electron など）のライセンスは、
`npm run notices` で作る `app/build/THIRD-PARTY-NOTICES.txt`（配布物ではアプリと同じフォルダ、アプリのメニューの「ヘルプ › ライセンス情報…」）にまとめている。
AI のモデルの学習データには研究・非商用が条件のものが含まれるので、配布は無償・非商用を前提にしている。
