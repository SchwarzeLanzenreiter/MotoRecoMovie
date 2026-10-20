// リポジトリに入れていない大きなファイル（AI のモデルと、同梱する LGPL 版の ffmpeg）を、出典から取ってくる。
// 使い方（app フォルダで）: npm run fetch-assets   （すでにあって中身が合っているものは取り直さない）
// モデルは SHA-256 で確かめる。ffmpeg は BtbN/FFmpeg-Builds の日付つきのリリースから取り、版の文字列で確かめる
// （ビルドの zip は作り直されることがあるので）。出典とライセンスは src/renderer/public/models/NOTICE.md と tools/notices.ts を参照
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
    file: 'yolox_nano.onnx',
    url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx',
    sha256: 'c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d'
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
    file: 'lama_fp32.onnx',
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6'
  }
]

// ffmpeg 9.0（LGPL v3、shared）。版の文字列で確かめる
const FF = {
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-19-13-06/ffmpeg-n9.0.2-28-g669f5ab083-win64-lgpl-shared-9.0.zip',
  version: 'n9.0.2-28-g669f5ab083',
  // 入れるもの（ffplay・ffprobe は入れない）
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
    console.log(`${m.file}: あります`)
    continue
  }
  console.log(`${m.file}: 取っています（${m.url}）`)
  await download(m.url, to)
  const h = sha(to)
  if (h !== m.sha256) {
    rmSync(to)
    throw new Error(`${m.file}: SHA-256 が合いません（${h}）`)
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
  console.log('ffmpeg: Windows 用のビルドだけを取ります（この OS では PATH の ffmpeg を使います）')
} else if (existsSync(ffExe) && ffVersion().includes(FF.version)) {
  console.log(`ffmpeg: あります（${ffVersion()}）`)
} else {
  console.log(`ffmpeg: 取っています（${FF.url}）`)
  const work = join(tmpdir(), `motorecomovie-ffmpeg-${process.pid}`)
  mkdirSync(work, { recursive: true })
  try {
    const zip = join(work, 'ffmpeg.zip')
    await download(FF.url, zip)
    const zipSha = sha(zip)
    // Windows 10 以降の tar（bsdtar）は zip を展開できる
    execFileSync('tar', ['-xf', zip, '-C', work])
    const top = readdirSync(work).find((d) => d.startsWith('ffmpeg-'))
    if (!top) throw new Error('zip の中身が想定と違います')
    rmSync(FFMPEG, { recursive: true, force: true })
    mkdirSync(FFMPEG, { recursive: true })
    for (const f of readdirSync(join(work, top, 'bin'))) if (FF.keep(f)) copyFileSync(join(work, top, 'bin', f), join(FFMPEG, f))
    copyFileSync(join(work, top, 'LICENSE.txt'), join(FFMPEG, 'LICENSE-LGPL-3.0.txt'))
    if (!ffVersion().includes(FF.version)) throw new Error(`ffmpeg の版が違います: ${ffVersion()}`)
    writeFileSync(join(FFMPEG, 'BUILD.json'), JSON.stringify({ zip: FF.url.split('/').pop(), url: FF.url, sha256: zipSha }, null, 2) + '\n')
    console.log(`ffmpeg: ${ffVersion()}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
console.log('完了')
