// Builds the tidied riding audio (core/audiofx.ts) and places it as .m4a in the app cache folder. Used by the preview and export.
// Only the heavy processing (declip, suppress non-engine sound) is built ahead of time here. Cutting high sounds and reducing loudness are applied
// at playback time by Dynamics in core/audiofx.ts (so settings are heard immediately)
//   1. Copy the audio samples out of the .insv into an ADTS .aac file in the cache, then ffmpeg: to mono 32-bit float
//      (declip adeclip also happens here). The samples are spread over the whole video file (about 12,000 places in a
//      25-minute video), so reading them competes with playback for the disk; the copy pauses while the video is playing
//   2. analysis thread: suppress noise while keeping harmonics (20 s at a time, with margins before and after).
//      It takes CPU from playback, so it also waits while the video is playing. The ffmpeg steps run at idle priority
//   3. ffmpeg: multiply by FX_BUILD_GAIN (declip can exceed 1) and encode to AAC
import { AFX_HOP, AFX_N, audioFxKey, FX_BUILD_GAIN, type AudioFx } from '../core/audiofx'
import { demux, type FileReader, type Track } from '../core/mp4'
import { openLocal } from '../core/file'
import type { Session } from './session'
import { t } from '../i18n'

const FS = 48000
const CHUNK_SEC = 20
const MARGIN = AFX_N + 8 * AFX_HOP

/** Tidied audio (passed to the preview AudioPlayer and to export) */
export interface FxAudio {
  path: string
  key: string
  file: FileReader & { close(): Promise<void> }
  track: Track
}

/** Short hash of a string (for the cache file name) */
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
    if (!track) throw new Error(t('Cannot read the cleaned-up audio'))
    return { path, key, file, track }
  } catch (e) {
    await file.close()
    throw e
  }
}

/** Open the tidied audio if already built (null if not) */
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** ADTS header fields from the AudioSpecificConfig (null if it cannot be written as ADTS) */
function adtsConfig(tr: Track): { profile: number; freq: number; ch: number } | null {
  const d = tr.description
  if (!tr.codec.startsWith('mp4a.40.') || !d || d.length < 2) return null
  const objectType = d[0] >> 3
  const freq = ((d[0] & 7) << 1) | (d[1] >> 7)
  const ch = (d[1] >> 3) & 15
  if (objectType < 1 || objectType > 4 || freq > 12 || ch < 1 || ch > 7) return null
  return { profile: objectType - 1, freq, ch }
}

/**
 * Copy the audio track of the video to an ADTS .aac file. Contiguous samples are read in one go;
 * while idle() is false (the video is playing) it waits, so playback keeps the disk to itself
 */
async function extractAac(s: Session, path: string, idle: () => boolean, stop: () => void, onProgress?: (frac: number) => void): Promise<boolean> {
  const tr = s.audioTrack
  const cfg = tr && adtsConfig(tr)
  if (!tr || !cfg) return false
  const out = await window.api.open(path, 'w')
  try {
    const n = tr.sizes.length
    let buf = new Uint8Array(1 << 20)
    let used = 0
    let pos = 0
    let runs = 0
    const flush = async (): Promise<void> => {
      await window.api.write(out.id, buf.subarray(0, used), pos)
      pos += used
      used = 0
    }
    for (let i = 0; i < n; ) {
      stop()
      while (!idle()) {
        await sleep(250)
        stop()
      }
      // One run of contiguous samples (one MP4 chunk)
      let j = i + 1
      while (j < n && tr.offsets[j] === tr.offsets[j - 1] + tr.sizes[j - 1]) j++
      const data = await s.file.read(tr.offsets[i], tr.offsets[j - 1] + tr.sizes[j - 1] - tr.offsets[i])
      let off = 0
      for (let k = i; k < j; k++) {
        const size = tr.sizes[k]
        const len = size + 7
        if (used + len > buf.length) {
          await flush()
          if (len > buf.length) buf = new Uint8Array(len)
        }
        buf[used] = 0xff
        buf[used + 1] = 0xf1
        buf[used + 2] = (cfg.profile << 6) | (cfg.freq << 2) | (cfg.ch >> 2)
        buf[used + 3] = ((cfg.ch & 3) << 6) | (len >> 11)
        buf[used + 4] = (len >> 3) & 0xff
        buf[used + 5] = ((len & 7) << 5) | 0x1f
        buf[used + 6] = 0xfc
        buf.set(data.subarray(off, off + size), used + 7)
        used += len
        off += size
      }
      i = j
      if (++runs % 64 === 0) onProgress?.(i / n)
    }
    await flush()
  } finally {
    await window.api.close(out.id)
  }
  return true
}

/**
 * Build the tidied audio (open it if it is in the cache). onProgress receives 0 to 1 and a message.
 * idle() is false while the video is playing; reading the video file and suppressing noise wait until it is true
 */
export async function buildFxAudio(s: Session, fx: AudioFx, onProgress?: (frac: number, msg: string) => void, signal?: { aborted: boolean }, idle: () => boolean = () => true): Promise<FxAudio> {
  const have = await loadFxAudio(s, fx)
  if (have) return have
  const dir = await window.api.cacheDir()
  const key = fxAudioKey(s, fx)
  const out = window.api.path.join(dir, `audio-${key}.m4a`)
  const tmpAac = window.api.path.join(dir, `tmp-${key}-in.aac`)
  const tmpIn = window.api.path.join(dir, `tmp-${key}-in.f32`)
  const tmpOut = window.api.path.join(dir, `tmp-${key}-out.f32`)
  const stop = (): void => {
    if (signal?.aborted) throw new Error(t('Cancelled'))
  }
  // Temporary files of this video left by a build that was cut off (the app was closed while building)
  const tmpPrefix = `tmp-${videoId(s)}-`
  for (const name of await window.api.listDir(dir)) if (name.startsWith(tmpPrefix)) await window.api.unlink(window.api.path.join(dir, name)).catch(() => undefined)
  try {
    // 1. Extract (and declip)
    onProgress?.(0, t('Extracting audio'))
    const copied = await extractAac(s, tmpAac, idle, stop, (f) => onProgress?.(0.08 * f, t('Extracting audio')))
    stop()
    if (fx.declip) onProgress?.(0.08, t('Extracting audio and repairing clipping'))
    let r = await window.api.runFfmpeg(['-y', '-v', 'error', ...(copied ? ['-f', 'aac', '-i', tmpAac] : ['-i', s.path]), '-map', '0:a:0', '-ac', '1', '-ar', String(FS), ...(fx.declip ? ['-af', 'adeclip'] : []), '-f', 'f32le', '-c:a', 'pcm_f32le', tmpIn], { background: true })
    if (r.code !== 0) throw new Error(t('ffmpeg could not extract the audio: {log}', { log: r.log.slice(-300) }))
    stop()
    // 2. Suppress noise (20 s at a time)
    const fin = await window.api.open(tmpIn, 'r')
    const fout = await window.api.open(tmpOut, 'w')
    try {
      const n = Math.floor(fin.size / 4)
      // Chunk boundaries are multiples of the Fourier transform hop (frame positions line up across boundaries, so the sound does not change at the seams)
      const chunk = Math.round((CHUNK_SEC * FS) / AFX_HOP) * AFX_HOP
      for (let p = 0; p < n; p += chunk) {
        stop()
        while (!idle()) {
          await sleep(250)
          stop()
        }
        onProgress?.(0.1 + (0.8 * p) / n, t('Reducing non-engine noise ({p}%)', { p: Math.round((100 * p) / n) }))
        const a = Math.max(0, p - MARGIN)
        const b = Math.min(n, p + chunk + MARGIN)
        const raw = await window.api.read(fin.id, a * 4, (b - a) * 4)
        const src = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
        // Margins before and after (zero-filled at the start and end of the video)
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
    // 3. Reduce loudness and encode to AAC (same sound on left and right)
    onProgress?.(0.9, t('Encoding the audio'))
    r = await window.api.runFfmpeg(['-y', '-v', 'error', '-f', 'f32le', '-ar', String(FS), '-ac', '1', '-i', tmpOut, '-af', `volume=${FX_BUILD_GAIN}`, '-ac', '2', '-c:a', 'aac', '-b:a', '192k', out], { background: true })
    if (r.code !== 0) throw new Error(t('ffmpeg could not encode the audio: {log}', { log: r.log.slice(-300) }))
    // Delete old tidied audio of the same video
    const prefix = `audio-${videoId(s)}-`
    for (const name of await window.api.listDir(dir)) if (name.startsWith(prefix) && name !== `audio-${key}.m4a`) await window.api.unlink(window.api.path.join(dir, name)).catch(() => undefined)
  } finally {
    await window.api.unlink(tmpAac).catch(() => undefined)
    await window.api.unlink(tmpIn).catch(() => undefined)
    await window.api.unlink(tmpOut).catch(() => undefined)
  }
  onProgress?.(1, '')
  return openFx(out, key)
}
