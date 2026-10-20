// 走行中の音を整えた音声（core/audiofx.ts）を作り、アプリのキャッシュのフォルダに .m4a で置く。プレビューと書き出しで使う。
// 重い処理（音割れの補修・エンジン音以外を抑える）だけをここで前もって作る。高い音を切る・音圧を抑えるは、鳴らすときに
// core/audiofx.ts の Dynamics でかける（設定がすぐに聞こえるように）
//   1. ffmpeg: 動画の音声をモノラルの 32bit 浮動小数点に（音割れの補修 adeclip もここで）
//   2. 解析スレッド: 倍音を残して雑音を抑える（20 秒ずつ、前後に余白を付けて）
//   3. ffmpeg: FX_BUILD_GAIN 倍して（音割れの補修で 1 を超えることがあるので）AAC に
import { AFX_HOP, AFX_N, audioFxKey, FX_BUILD_GAIN, type AudioFx } from '../core/audiofx'
import { demux, type FileReader, type Track } from '../core/mp4'
import { openLocal } from '../core/file'
import type { Session } from './session'
import { t } from '../i18n'

const FS = 48000
const CHUNK_SEC = 20
const MARGIN = AFX_N + 8 * AFX_HOP

/** 整えた音声（プレビューの AudioPlayer と書き出しに渡す） */
export interface FxAudio {
  path: string
  key: string
  file: FileReader & { close(): Promise<void> }
  track: Track
}

/** 文字列の短いハッシュ（キャッシュのファイル名に） */
function hash(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193)
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x5bd1e995)
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0')
}

const videoId = (s: Session): string => hash(`${s.path}|${s.file.size}`)
export const fxAudioKey = (s: Session, fx: AudioFx): string => `${videoId(s)}-${audioFxKey(fx).replace(/[^0-9a-z_-]/gi, 'm')}`

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { ok: (y: Float32Array) => void; ng: (e: Error) => void }>()
function process(x: Float32Array, noiseDb: number): Promise<Float32Array> {
  if (!worker) {
    worker = new Worker(new URL('./audiofx.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; y?: Float32Array; error?: string }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      if (e.data.ok) w.ok(e.data.y!)
      else w.ng(new Error(e.data.error))
    }
  }
  const id = nextId++
  return new Promise((ok, ng) => {
    waiting.set(id, { ok, ng })
    worker!.postMessage({ id, x, fs: FS, noiseDb, margin: MARGIN }, [x.buffer])
  })
}

async function openFx(path: string, key: string): Promise<FxAudio> {
  const file = await openLocal(path)
  try {
    const track = (await demux(file)).find((tr) => tr.kind === 'audio')
    if (!track) throw new Error(t('整えた音声を読めません'))
    return { path, key, file, track }
  } catch (e) {
    await file.close()
    throw e
  }
}

/** 作ってある整えた音声を開く（無ければ null） */
export async function loadFxAudio(s: Session, fx: AudioFx): Promise<FxAudio | null> {
  const key = fxAudioKey(s, fx)
  const path = window.api.path.join(await window.api.cacheDir(), `audio-${key}.m4a`)
  if (!(await window.api.exists(path))) return null
  try {
    return await openFx(path, key)
  } catch {
    return null
  }
}

/** 整えた音声を作る（キャッシュにあればそれを開く）。onProgress は 0〜1 と表示の文 */
export async function buildFxAudio(s: Session, fx: AudioFx, onProgress?: (frac: number, msg: string) => void, signal?: { aborted: boolean }): Promise<FxAudio> {
  const have = await loadFxAudio(s, fx)
  if (have) return have
  const dir = await window.api.cacheDir()
  const key = fxAudioKey(s, fx)
  const out = window.api.path.join(dir, `audio-${key}.m4a`)
  const tmpIn = window.api.path.join(dir, `tmp-${key}-in.f32`)
  const tmpOut = window.api.path.join(dir, `tmp-${key}-out.f32`)
  const stop = (): void => {
    if (signal?.aborted) throw new Error(t('中止しました'))
  }
  try {
    // 1. 取り出し（と音割れの補修）
    onProgress?.(0, fx.declip ? t('音声を取り出して音割れを補修しています') : t('音声を取り出しています'))
    let r = await window.api.runFfmpeg(['-y', '-v', 'error', '-i', s.path, '-map', '0:a:0', '-ac', '1', '-ar', String(FS), ...(fx.declip ? ['-af', 'adeclip'] : []), '-f', 'f32le', '-c:a', 'pcm_f32le', tmpIn])
    if (r.code !== 0) throw new Error(t('ffmpeg で音声を取り出せませんでした: {log}', { log: r.log.slice(-300) }))
    stop()
    // 2. 雑音を抑える（20 秒ずつ）
    const fin = await window.api.open(tmpIn, 'r')
    const fout = await window.api.open(tmpOut, 'w')
    try {
      const n = Math.floor(fin.size / 4)
      // 区切りはフーリエ変換のずらし幅の倍数に（フレームの位置が区切りの前後でそろい、つなぎ目で音が変わらない）
      const chunk = Math.round((CHUNK_SEC * FS) / AFX_HOP) * AFX_HOP
      for (let p = 0; p < n; p += chunk) {
        stop()
        onProgress?.(0.1 + (0.8 * p) / n, t('エンジン音以外を抑えています（{p}%）', { p: Math.round((100 * p) / n) }))
        const a = Math.max(0, p - MARGIN)
        const b = Math.min(n, p + chunk + MARGIN)
        const raw = await window.api.read(fin.id, a * 4, (b - a) * 4)
        const src = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
        // 前後の余白（動画の始まり・終わりでは 0 で埋める）
        const seg = new Float32Array(Math.min(chunk, n - p) + 2 * MARGIN)
        seg.set(src, MARGIN - (p - a))
        const y = await process(seg, fx.noiseDb)
        await window.api.write(fout.id, new Uint8Array(y.buffer, y.byteOffset, y.byteLength), p * 4)
      }
    } finally {
      await window.api.close(fin.id)
      await window.api.close(fout.id)
    }
    stop()
    // 3. 音圧を抑えて AAC に（左右に同じ音）
    onProgress?.(0.9, t('音声を書き出しています'))
    r = await window.api.runFfmpeg(['-y', '-v', 'error', '-f', 'f32le', '-ar', String(FS), '-ac', '1', '-i', tmpOut, '-af', `volume=${FX_BUILD_GAIN}`, '-ac', '2', '-c:a', 'aac', '-b:a', '192k', out])
    if (r.code !== 0) throw new Error(t('ffmpeg で音声を書き出せませんでした: {log}', { log: r.log.slice(-300) }))
    // 同じ動画の古い整えた音声を消す
    const prefix = `audio-${videoId(s)}-`
    for (const name of await window.api.listDir(dir)) if (name.startsWith(prefix) && name !== `audio-${key}.m4a`) await window.api.unlink(window.api.path.join(dir, name)).catch(() => undefined)
  } finally {
    await window.api.unlink(tmpIn).catch(() => undefined)
    await window.api.unlink(tmpOut).catch(() => undefined)
  }
  onProgress?.(1, '')
  return openFx(out, key)
}
