// 配布物に入れるライセンス表示（THIRD-PARTY-NOTICES.txt）を作る。npm run dist で electron-builder の前に動かす。
// 入れるもの: アプリに組み込まれる npm のパッケージ（型定義だけのものは除く）、MotoRecoViewer、AI のモデル、ffmpeg（LGPL v3 と GPL v3 の全文）、
// Electron と Chromium（同じフォルダの LICENSE.electron.txt・LICENSES.chromium.html を指す）
// 使い方: npx tsx tools/notices.ts [出力先]（既定 build/THIRD-PARTY-NOTICES.txt）
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? join(APP, 'build', 'THIRD-PARTY-NOTICES.txt')
const LINE = '='.repeat(78)
const parts: string[] = []
const push = (title: string, body: string): void => {
  parts.push(`${LINE}\n${title}\n${LINE}\n\n${body.trim()}\n`)
}

// ---- npm のパッケージ（アプリに組み込まれるもの = 本番の依存とその依存。型定義だけのものは除く）----
type Node = { version?: string; dependencies?: Record<string, Node> }
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { cwd: APP, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })) as Node
const pkgs = new Map<string, string>()
const walk = (n: Node): void => {
  for (const [name, d] of Object.entries(n.dependencies ?? {})) {
    if (pkgs.has(name)) continue
    pkgs.set(name, d.version ?? '')
    walk(d)
  }
}
walk(tree)
const TYPES_ONLY = (name: string): boolean => name.startsWith('@types/') || name === 'undici-types'
// パッケージにライセンスの文が入っていないもの（package.json の license と作者から）
const MIT = (holder: string): string => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
const ISC = (holder: string): string => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`
const MISSING: Record<string, string> = {
  'onnxruntime-web': MIT('Microsoft Corporation') + '\n\nThe ONNX Runtime WebAssembly binaries include third-party components listed in\nhttps://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt',
  'onnxruntime-common': MIT('Microsoft Corporation'),
  'guid-typescript': ISC('nicolas (https://github.com/NicolasDeveloper/guid-typescript)')
}
const npmBodies: string[] = []
for (const [name, ver] of [...pkgs].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (TYPES_ONLY(name)) continue
  const dir = join(APP, 'node_modules', name)
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { license?: string; repository?: string | { url?: string }; homepage?: string }
  const repo = typeof pj.repository === 'string' ? pj.repository : (pj.repository?.url ?? pj.homepage ?? '')
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
  const text = file ? readFileSync(join(dir, file), 'utf-8') : MISSING[name]
  if (!text) throw new Error(`${name}: ライセンスの文がありません（MISSING に足す）`)
  npmBodies.push(`--- ${name} ${ver}（${pj.license ?? '?'}）${repo ? `\n${repo.replace(/^git\+/, '')}` : ''}\n\n${text.trim()}\n`)
}

// ---- 書き出し ----
const header = `MotoRecoMovie に含まれる、ほかの人が作ったソフトウェアとデータのライセンス
（Third-party software and data included in MotoRecoMovie）

このファイルは tools/notices.ts で作っています。

目次:
  1. ffmpeg（LGPL v3。resources/ffmpeg）
  2. AI のモデル（resources/app.asar の models）
  3. MotoRecoViewer（.dat の読み込みの移植元）
  4. アプリに組み込まれている npm のパッケージ
  5. Electron と Chromium
  付録 A. GNU Lesser General Public License v3
  付録 B. GNU General Public License v3
`
parts.push(header)

const ffDir = join(APP, 'resources', 'ffmpeg')
if (!existsSync(join(ffDir, 'ffmpeg.exe'))) throw new Error('resources/ffmpeg/ffmpeg.exe がありません')
// どの zip から取ったか（tools/fetch-assets.ts が書く）
const build = JSON.parse(readFileSync(join(ffDir, 'BUILD.json'), 'utf-8')) as { zip: string; url: string; sha256: string }
let ffVer = ''
try {
  ffVer = execSync(`"${join(ffDir, 'ffmpeg.exe')}" -hide_banner -version`, { encoding: 'utf-8' }).split('\n').slice(0, 3).join('\n')
} catch {
  ffVer = '(ffmpeg -version を実行できませんでした)'
}
push(
  '1. ffmpeg',
  `resources/ffmpeg の ffmpeg.exe と DLL（avcodec・avdevice・avfilter・avformat・avutil・swresample・swscale）は FFmpeg です。
FFmpeg is licensed under the GNU Lesser General Public License version 3 (LGPL v3) in this build
（--enable-version3、GPL の部品は含みません）。全文は付録 A（LGPL v3）と付録 B（GPL v3）にあります。

${ffVer}

- ビルド: BtbN/FFmpeg-Builds の ${build.zip}（SHA-256 ${build.sha256}）
  ${build.url}
  https://github.com/BtbN/FFmpeg-Builds （ビルドの手順とスクリプト）
- ソースコード: https://git.ffmpeg.org/ffmpeg.git の上記のバージョンのコミット（n9.0.2-28-g669f5ab083）、または https://ffmpeg.org/download.html
  このビルドが使っている外部のライブラリ（dav1d・libvorbis・freetype など）のソースの場所は、上記のビルドのスクリプトに書かれています
- このアプリは ffmpeg.exe を別のプロセスとして起動して使っています（リンクしていません）。DLL は利用者が別のビルドに差し替えられます
- 変更: なし（ダウンロードしたファイルをそのまま使っています。ffplay.exe・ffprobe.exe は入れていません）`
)

const notice = readFileSync(join(APP, 'src', 'renderer', 'public', 'models', 'NOTICE.md'), 'utf-8')
const apache = readFileSync(join(APP, 'node_modules', 'flatbuffers', 'LICENSE'), 'utf-8')
push(
  '2. AI のモデル',
  `${notice.trim()}

学習データについて: YOLOX は COCO、NeuFlow v2（mixed）は FlyingChairs・FlyingThings3D・Sintel・KITTI・HD1K などの組み合わせ、
LaMa と MI-GAN は Places2 で学習されています。これらのデータセットの多くは研究・非商用の利用を条件にしています。
このアプリは無償・非商用で配布します。

--- MI-GAN（Picsart AI Research）: MIT License

${MIT('2024 Picsart AI Research (PAIR)')}

--- ONNX-NeuFlowV2-Optical-Flow（ONNX への変換。ibaiGorordo）: MIT License
https://github.com/ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow

${MIT('Ibai Gorordo')}

--- YOLOX（Megvii）・NeuFlow v2（neufieldrobotics）・LaMa（advimman、Carve/LaMa-ONNX）: Apache License 2.0

${apache.trim()}`
)

push(
  '3. MotoRecoViewer',
  `core/motoreco-dat.ts の .dat のデコードの手順と組み込みの規則の式は、MotoRecoViewer のソースの移植です。
https://github.com/SchwarzeLanzenreiter/MotoRecoViewer

${readFileSync(join(APP, 'licenses', 'MotoRecoViewer-MIT.txt'), 'utf-8').trim()}`
)

push('4. アプリに組み込まれている npm のパッケージ', npmBodies.join('\n'))

push(
  '5. Electron と Chromium',
  `このアプリは Electron（MIT License）で動いています。Electron と、それに含まれる Chromium・V8・ffmpeg.dll（Chromium のビルドの LGPL 版）などの
ライセンスは、アプリと同じフォルダの LICENSE.electron.txt と LICENSES.chromium.html にあります。
https://github.com/electron/electron`
)

push('付録 A. GNU Lesser General Public License v3', readFileSync(join(ffDir, 'LICENSE-LGPL-3.0.txt'), 'utf-8'))
push('付録 B. GNU General Public License v3', readFileSync(join(APP, 'licenses', 'GPL-3.0.txt'), 'utf-8'))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, '﻿' + parts.join('\n').replace(/\r?\n/g, '\r\n'))
console.log(`→ ${out}（npm のパッケージ ${npmBodies.length} 個）`)
