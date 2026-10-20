// Generates the license notices shipped with the distribution (THIRD-PARTY-NOTICES.txt). Run by npm run dist before electron-builder.
// Contents: the npm packages built into the app (excluding type-definition-only packages), MotoRecoViewer, the AI models, ffmpeg (full text of LGPL v3 and GPL v3),
// Electron and Chromium (pointing to LICENSE.electron.txt and LICENSES.chromium.html in the same folder)
// Usage: npx tsx tools/notices.ts [output path] (default: build/THIRD-PARTY-NOTICES.txt)
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

// ---- npm packages (those built into the app = production dependencies and their dependencies; type-definition-only packages excluded) ----
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
// Packages that ship without a license text (taken from the license field in package.json and the author)
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
  if (!text) throw new Error(`${name}: no license text (add it to MISSING)`)
  npmBodies.push(`--- ${name} ${ver} (${pj.license ?? '?'})${repo ? `\n${repo.replace(/^git\+/, '')}` : ''}\n\n${text.trim()}\n`)
}

// ---- Output ----
const header = `Licenses of the third-party software and data included in MotoRecoMovie

This file is generated by tools/notices.ts.

Contents:
  1. ffmpeg (LGPL v3; resources/ffmpeg)
  2. AI models (models in resources/app.asar)
  3. MotoRecoViewer (the origin of the .dat reader port)
  4. npm packages built into the app
  5. Electron and Chromium
  Appendix A. GNU Lesser General Public License v3
  Appendix B. GNU General Public License v3
`
parts.push(header)

const ffDir = join(APP, 'resources', 'ffmpeg')
if (!existsSync(join(ffDir, 'ffmpeg.exe'))) throw new Error('resources/ffmpeg/ffmpeg.exe is missing')
// Which zip it was taken from (written by tools/fetch-assets.ts)
const build = JSON.parse(readFileSync(join(ffDir, 'BUILD.json'), 'utf-8')) as { zip: string; url: string; sha256: string }
let ffVer = ''
try {
  ffVer = execSync(`"${join(ffDir, 'ffmpeg.exe')}" -hide_banner -version`, { encoding: 'utf-8' }).split('\n').slice(0, 3).join('\n')
} catch {
  ffVer = '(could not run ffmpeg -version)'
}
push(
  '1. ffmpeg',
  `ffmpeg.exe and the DLLs (avcodec, avdevice, avfilter, avformat, avutil, swresample, swscale) in resources/ffmpeg are FFmpeg.
FFmpeg is licensed under the GNU Lesser General Public License version 3 (LGPL v3) in this build
(--enable-version3; no GPL components are included). The full texts are in Appendix A (LGPL v3) and Appendix B (GPL v3).

${ffVer}

- Build: ${build.zip} from BtbN/FFmpeg-Builds (SHA-256 ${build.sha256})
  ${build.url}
  https://github.com/BtbN/FFmpeg-Builds (build instructions and scripts)
- Source code: the commit of the version above (n9.0.2-28-g669f5ab083) in https://git.ffmpeg.org/ffmpeg.git, or https://ffmpeg.org/download.html
  The locations of the sources of the external libraries used by this build (dav1d, libvorbis, freetype, etc.) are given in the build scripts above
- This app runs ffmpeg.exe as a separate process (it is not linked). Users can replace the DLLs with a different build
- Modifications: none (the downloaded files are used as is; ffplay.exe and ffprobe.exe are not included)`
)

const notice = readFileSync(join(APP, 'src', 'renderer', 'public', 'models', 'NOTICE.md'), 'utf-8')
const apache = readFileSync(join(APP, 'node_modules', 'flatbuffers', 'LICENSE'), 'utf-8')
push(
  '2. AI models',
  `${notice.trim()}

About training data: YOLOX was trained on COCO, NeuFlow v2 (mixed) on a combination of FlyingChairs, FlyingThings3D, Sintel, KITTI, HD1K and others,
and LaMa and MI-GAN on Places2. Many of these datasets are available on condition of research or non-commercial use.
This app is distributed free of charge and for non-commercial use.

--- MI-GAN (Picsart AI Research): MIT License

${MIT('2024 Picsart AI Research (PAIR)')}

--- ONNX-NeuFlowV2-Optical-Flow (conversion to ONNX, ibaiGorordo): MIT License
https://github.com/ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow

${MIT('Ibai Gorordo')}

--- YOLOX (Megvii), NeuFlow v2 (neufieldrobotics), LaMa (advimman; Carve/LaMa-ONNX): Apache License 2.0

${apache.trim()}`
)

push(
  '3. MotoRecoViewer',
  `The .dat decoding procedure and the built-in formula rules in core/motoreco-dat.ts are ported from the MotoRecoViewer source.
https://github.com/SchwarzeLanzenreiter/MotoRecoViewer

${readFileSync(join(APP, 'licenses', 'MotoRecoViewer-MIT.txt'), 'utf-8').trim()}`
)

push('4. npm packages built into the app', npmBodies.join('\n'))

push(
  '5. Electron and Chromium',
  `This app runs on Electron (MIT License). The licenses of Electron and of the components it includes, such as Chromium, V8 and ffmpeg.dll (the LGPL build in Chromium),
are in LICENSE.electron.txt and LICENSES.chromium.html in the same folder as the app.
https://github.com/electron/electron`
)

push('Appendix A. GNU Lesser General Public License v3', readFileSync(join(ffDir, 'LICENSE-LGPL-3.0.txt'), 'utf-8'))
push('Appendix B. GNU General Public License v3', readFileSync(join(APP, 'licenses', 'GPL-3.0.txt'), 'utf-8'))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, '﻿' + parts.join('\n').replace(/\r?\n/g, '\r\n'))
console.log(`-> ${out} (${npmBodies.length} npm packages)`)
