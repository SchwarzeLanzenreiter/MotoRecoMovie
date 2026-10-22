// Fetches the large files that are not in the repository (the AI models and the bundled LGPL build of ffmpeg) from their sources.
// Usage (in the app folder): npm run fetch-assets   (files that already exist and match are not fetched again)
// Models are verified by SHA-256. ffmpeg is fetched from a dated release of BtbN/FFmpeg-Builds and verified by its version string
// (because the build zips are sometimes rebuilt). For sources and licenses see src/renderer/public/models/NOTICE.md and tools/notices.ts
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS = join(APP, 'src', 'renderer', 'public', 'models')
const FFMPEG = join(APP, 'resources', 'ffmpeg')

const models = [
  {
    // Converted from the mmdetection checkpoint by proto/export_rtmdet_ins.py (see public/models/NOTICE.md)
    file: 'rtmdet_ins_tiny.onnx',
    url: 'https://github.com/SchwarzeLanzenreiter/MotoRecoMovie/releases/download/models-1/rtmdet_ins_tiny.onnx',
    sha256: '49b20c38abc388d11c042cdfdacee12c74a69156a4c05acf675064f1e3b08794'
  },
  {
    file: 'neuflow_mixed.onnx',
    url: 'https://github.com/ibaiGorordo/ONNX-NeuFlowV2-Optical-Flow/releases/download/0.1.0/neuflow_mixed.onnx',
    sha256: '7a07929423133f9267e33aec322873ef1dfcb17224020f30c794e569d353624d'
  },
  {
    file: 'migan_pipeline_v2.onnx',
    url: 'https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx',
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b'
  },
  {
    file: 'yolo-v9-t-640-license-plates-end2end.onnx',
    url: 'https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-640-license-plates-end2end.onnx',
    sha256: 'c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076'
  },
  {
    file: 'lama_fp32.onnx',
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6'
  }
]

// ffmpeg 9.0 (LGPL v3, shared). Verified by its version string
const FF = {
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-19-13-06/ffmpeg-n9.0.2-28-g669f5ab083-win64-lgpl-shared-9.0.zip',
  version: 'n9.0.2-28-g669f5ab083',
  // What to keep (ffplay and ffprobe are not included)
  keep: (name: string): boolean => name === 'ffmpeg.exe' || name.toLowerCase().endsWith('.dll')
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

async function download(url: string, to: string): Promise<void> {
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok || !r.body) throw new Error(`${url}: ${r.status}`)
  writeFileSync(to, new Uint8Array(await r.arrayBuffer()))
}

mkdirSync(MODELS, { recursive: true })
for (const m of models) {
  const to = join(MODELS, m.file)
  if (existsSync(to) && sha(to) === m.sha256) {
    console.log(`${m.file}: already present`)
    continue
  }
  console.log(`${m.file}: downloading (${m.url})`)
  await download(m.url, to)
  const h = sha(to)
  if (h !== m.sha256) {
    rmSync(to)
    throw new Error(`${m.file}: SHA-256 mismatch (${h})`)
  }
}

const ffExe = join(FFMPEG, 'ffmpeg.exe')
const ffVersion = (): string => {
  try {
    return execFileSync(ffExe, ['-hide_banner', '-version'], { encoding: 'utf-8' }).split('\n')[0]
  } catch {
    return ''
  }
}
if (process.platform !== 'win32') {
  console.log('ffmpeg: only the Windows build is downloaded (on this OS, the ffmpeg on PATH is used)')
} else if (existsSync(ffExe) && ffVersion().includes(FF.version)) {
  console.log(`ffmpeg: already present (${ffVersion()})`)
} else {
  console.log(`ffmpeg: downloading (${FF.url})`)
  const work = join(tmpdir(), `motorecomovie-ffmpeg-${process.pid}`)
  mkdirSync(work, { recursive: true })
  try {
    const zip = join(work, 'ffmpeg.zip')
    await download(FF.url, zip)
    const zipSha = sha(zip)
    // tar (bsdtar) on Windows 10 and later can extract zip files
    execFileSync('tar', ['-xf', zip, '-C', work])
    const top = readdirSync(work).find((d) => d.startsWith('ffmpeg-'))
    if (!top) throw new Error('The zip contents are not as expected')
    rmSync(FFMPEG, { recursive: true, force: true })
    mkdirSync(FFMPEG, { recursive: true })
    for (const f of readdirSync(join(work, top, 'bin'))) if (FF.keep(f)) copyFileSync(join(work, top, 'bin', f), join(FFMPEG, f))
    copyFileSync(join(work, top, 'LICENSE.txt'), join(FFMPEG, 'LICENSE-LGPL-3.0.txt'))
    if (!ffVersion().includes(FF.version)) throw new Error(`ffmpeg version mismatch: ${ffVersion()}`)
    writeFileSync(join(FFMPEG, 'BUILD.json'), JSON.stringify({ zip: FF.url.split('/').pop(), url: FF.url, sha256: zipSha }, null, 2) + '\n')
    console.log(`ffmpeg: ${ffVersion()}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
console.log('Done.')
