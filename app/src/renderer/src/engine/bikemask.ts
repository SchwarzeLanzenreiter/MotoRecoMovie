// Builds the own-bike masks (core/bikemask.ts) from keyframes and keeps them in the app cache folder.
// Used to hide corner signs behind the bike and rider. Reading keyframes competes with playback for the disk,
// so the build waits while the video is playing; the statistics run in bikemask.worker.ts
import {
  bikeCrop,
  buildBikeMask,
  CUBE_FACES,
  decodeBikeMasks,
  encodeBikeMasks,
  FACE,
  facesToEquirectRgb,
  frameDifference,
  keepConsistent,
  MASK_H,
  MASK_W,
  MASK_WINDOW_SEC,
  masksFromCounts,
  type BikeMask,
  type BikeMaskTrack
} from '../core/bikemask'
import { decodeKeyframes } from './decoder'
import { seamBasis } from '../core/seamfit'
import { cropCamera, outlineToSphere, OWN_CLASSES, OWN_INSIDE, OWN_IOU, OWN_SCORE, planeInCrop } from '../core/owncrop'
import { MASK_FEAT, SEG_SIZE } from '../core/segment'
import { segment } from './segmenter'
import type { Mat3 } from '../core/quat'
import { sampleChannel } from '../core/telemetry'
import { GlReframer } from '../render/gl-reframe'
import type { Session } from './session'
import { t } from '../i18n'

/** Keyframes used per stretch of video */
const FRAMES_PER_WINDOW = 24
/** Keyframes slower than this [km/h] are not used */
const MIN_SPEED = 15
/** A keyframe that differs from the previous one by less than this (mean gray levels) was taken while stopped */
const STOPPED_DIFF = 8
const VERSION = 8

/** Key that checks whether saved masks belong to this video and this way of building them */
export function bikeMaskKey(s: Session): string {
  return [VERSION, s.path, s.file.size, s.frameCount, MASK_W, FRAMES_PER_WINDOW, MASK_WINDOW_SEC].join('|')
}

/** Short hash of a string (for the cache file name) */
function hash(str: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < str.length; i++) {
    h1 = Math.imul(h1 ^ str.charCodeAt(i), 0x01000193)
    h2 = Math.imul(h2 ^ str.charCodeAt(i), 0x5bd1e995)
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0')
}

async function cachePath(s: Session): Promise<string> {
  return window.api.path.join(await window.api.cacheDir(), `bikemask-${hash(`${s.path}|${s.file.size}`)}.bin`)
}

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { ok: (m: BikeMask | null) => void; ng: (e: Error) => void }>()
function buildInWorker(frames: Uint8Array[], seamAx: number[]): Promise<BikeMask | null> {
  if (!worker) {
    try {
      worker = new Worker(new URL('./bikemask.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      return Promise.resolve(buildBikeMask(frames, seamAx))
    }
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; mask?: BikeMask | null; error?: string }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      if (e.data.ok) w.ok(e.data.mask ?? null)
      else w.ng(new Error(e.data.error))
    }
  }
  const id = nextId++
  return new Promise((ok, ng) => {
    waiting.set(id, { ok, ng })
    worker!.postMessage({ id, frames, seamAx }, frames.map((f) => f.buffer))
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Builds the masks for the whole video. idle() is false while the video is playing (reading keyframes waits until it is true).
 * onProgress receives 0 to 1
 */
export async function buildBikeMasks(
  s: Session,
  opts: { signal?: { aborted: boolean }; idle?: () => boolean; onProgress?: (frac: number) => void } = {}
): Promise<BikeMaskTrack> {
  const idle = opts.idle ?? (() => true)
  const stop = (): void => {
    if (opts.signal?.aborted) throw new Error(t('Cancelled'))
  }
  const dur = s.frameCount / s.fps
  const keys = s.keyframeIndices()
  const nWin = Math.max(1, Math.round(dur / MASK_WINDOW_SEC))
  const win = dur / nWin
  const gl = new GlReframer(new OffscreenCanvas(FACE, FACE * 6))
  gl.setLenses(s.rig)
  gl.dynamicSeam = false
  gl.kOverride = 0
  const raw = new Uint8Array(FACE * FACE * 6 * 4)
  const img = new Uint8Array(raw.length)
  const row = FACE * 4
  const out: BikeMaskTrack = { windows: [], masks: [] }
  const masks: (BikeMask | null)[] = []
  /** Keyframes each stretch's mask was built from (looked at again by the segmentation model) */
  const used: number[][] = []
  const firsts: (Uint8Array | null)[] = []
  const tracks = s.decoders.map((d) => d.track)
  // The speed (vehicle log, or the estimate from the video's IMU that is computed just after opening) tells the stops apart; wait for it a little
  for (let k = 0; k < 120 && !s.telemetry(true); k++) {
    stop()
    await sleep(500)
  }
  const tel = s.telemetry(true)
  try {
    for (let w = 0; w < nWin; w++) {
      const t0 = w * win
      const t1 = (w + 1) * win
      // Keyframes taken while riding (with the vehicle log, or the speed estimated from the video; a stop makes the scenery look still)
      const inWin = keys.filter((i) => {
        const ti = i / s.fps
        if (ti < t0 || ti >= t1) return false
        const v = tel ? sampleChannel(tel, 'speed', s.motion.videoTime(i)) : null
        return v === null || !Number.isFinite(v) || v >= MIN_SPEED
      })
      // Candidates evenly spread over the stretch (twice as many as needed; frames taken while stopped are left out)
      const step = Math.max(1, inWin.length / (2 * FRAMES_PER_WINDOW))
      const pick: number[] = []
      for (let q = 0; q < 2 * FRAMES_PER_WINDOW && Math.floor(q * step) < inWin.length; q++) pick.push(inWin[Math.floor(q * step)])
      const frames: Uint8Array[] = []
      const usedHere: number[] = []
      let tried = 0
      for (const idx of pick) {
        if (frames.length >= FRAMES_PER_WINDOW) break
        tried++
        stop()
        while (!idle()) {
          await sleep(250)
          stop()
        }
        await decodeKeyframes(s.file, tracks, [idx], (i, fs) => {
          gl.upload([fs[0], fs[1]])
          gl.begin(FACE, FACE * 6)
          for (let k = 0; k < 6; k++) gl.draw({ view: Float64Array.from(CUBE_FACES[k]), rs: null, hfovDeg: 90 }, FACE, FACE * 6, { x: 0, y: k * FACE, w: FACE, h: FACE })
          gl.gl.readPixels(0, 0, FACE, FACE * 6, gl.gl.RGBA, gl.gl.UNSIGNED_BYTE, raw)
          // readPixels gives rows bottom-up
          for (let y = 0; y < FACE * 6; y++) img.set(raw.subarray((FACE * 6 - 1 - y) * row, (FACE * 6 - y) * row), y * row)
          const e = facesToEquirectRgb(img)
          if (!frames.length || frameDifference(e, frames[frames.length - 1]) > STOPPED_DIFF) {
            frames.push(e)
            usedHere.push(i)
          }
        })
        opts.onProgress?.((0.5 * (w + Math.max(frames.length / FRAMES_PER_WINDOW, tried / pick.length))) / nWin)
      }
      stop()
      // For checking (autotest bikeMaskDump): the first frame of each stretch with its mask
      const dump = (globalThis as { __bikeMaskDump?: string }).__bikeMaskDump
      const first = dump && frames[0] ? frames[0].slice() : null
      console.log(`Own-bike mask ${t0.toFixed(0)} to ${t1.toFixed(0)} s: ${inWin.length} keyframes while riding (speed from ${tel ? (tel.source ?? 'log') : 'none'}), ${frames.length} used`)
      masks.push(await buildInWorker(frames, seamBasis(s.rig).ax))
      used.push(usedHere)
      firsts.push(first)
      out.windows.push({ t0, t1, mask: -1 })
    }
    keepConsistent(masks)
    // Second look with the segmentation model: where its outlines of the bike and riders are is a much tighter answer than what stays still
    // (the road and the tree line ahead stay in place too). Without the model, the masks from the stillness are kept
    for (let w = 0; w < masks.length; w++) {
      const m = masks[w]
      if (m) await refineWithSegmentation(s, gl, m, used[w], { idle, stop, onProgress: (f) => opts.onProgress?.((0.5 + 0.5 * (w + f)) / nWin) })
    }
  } finally {
    gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  for (let w = 0; w < masks.length; w++) {
    const m = masks[w]
    const dump = (globalThis as { __bikeMaskDump?: string }).__bikeMaskDump
    const first = firsts[w]
    if (dump && first) await dumpPng(`${dump}-${w}.png`, first, m)
    if (!m) continue
    out.masks.push(m)
    out.windows[w].mask = out.masks.length - 1
  }
  opts.onProgress?.(1)
  return out
}

/**
 * Replace the stretch's core and envelope by where the segmentation model finds the own bike and riders in its keyframes: each is cropped
 * around the bike (owncrop.ts), the outlines connected to the bike are kept (as when drawing), and counted on the sphere. Returns whether
 * the masks were replaced
 */
async function refineWithSegmentation(
  s: Session,
  gl: GlReframer,
  m: BikeMask,
  indices: number[],
  o: { idle: () => boolean; stop: () => void; onProgress: (frac: number) => void }
): Promise<boolean> {
  const crop = bikeCrop(m)
  if (!crop || indices.length < MIN_REFINE) return false
  const N = MASK_W * MASK_H
  const seen = new Uint16Array(N)
  const hits = new Uint16Array(N)
  const tracks = s.decoders.map((d) => d.track)
  let runs = 0
  try {
    for (let k = 0; k < indices.length; k++) {
      o.stop()
      while (!o.idle()) {
        await sleep(250)
        o.stop()
      }
      let rgba: Uint8Array | null = null
      let view: Mat3 | null = null
      await decodeKeyframes(s.file, tracks, [indices[k]], (i, fs) => {
        gl.upload([fs[0], fs[1]])
        view = cropCamera(crop.dir, s.motion.bodyInRig(i))
        rgba = gl.renderCrop(view, crop.fov, SEG_SIZE)
      })
      if (!rgba || !view) continue
      const found = await segment(rgba, OWN_CLASSES, {
        scoreThr: OWN_SCORE,
        iou: OWN_IOU,
        masks: true,
        prior: planeInCrop(m.env, view, crop.fov),
        inside: OWN_INSIDE,
        anchor: planeInCrop(m.core, view, crop.fov)
      })
      const outline = new Float32Array(MASK_FEAT * MASK_FEAT)
      for (const f of found) if (f.mask) for (let p = 0; p < outline.length; p++) outline[p] = Math.max(outline[p], f.mask[p])
      outlineToSphere(outline, view, crop.fov, seen, hits)
      runs++
      o.onProgress((k + 1) / indices.length)
    }
  } catch (e) {
    if (e instanceof Error && e.message === t('Cancelled')) throw e
    console.warn('Could not look for the own bike with the segmentation model; the masks from the still parts are used', e)
    return false
  }
  const r = runs >= MIN_REFINE ? masksFromCounts(seen, hits, runs) : null
  if (!r) return false
  m.core.set(r.core)
  m.env.set(r.env)
  return true
}

/** Keyframes the segmentation model needs to have seen in a stretch */
const MIN_REFINE = 6

/** For checking: a frame (gray) with the core in red and the rest of the envelope in green, as an equirectangular PNG */
async function dumpPng(path: string, rgb: Uint8Array, mask: BikeMask | null): Promise<void> {
  const N = rgb.length / 3
  const H = N / MASK_W
  const cv = new OffscreenCanvas(MASK_W, H)
  const g = cv.getContext('2d')!
  const img = g.createImageData(MASK_W, H)
  for (let p = 0; p < N; p++) {
    const y = (rgb[p * 3] * 77 + rgb[p * 3 + 1] * 150 + rgb[p * 3 + 2] * 29) >> 8
    const c = mask?.core[p] ? 1 : 0
    const e = !c && mask?.env[p] ? 1 : 0
    img.data[p * 4] = c ? y * 0.5 + 128 : y * (1 - e * 0.4)
    img.data[p * 4 + 1] = e ? y * 0.6 + 100 : y * (1 - c * 0.5)
    img.data[p * 4 + 2] = y * (1 - (c + e) * 0.5)
    img.data[p * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  const blob = await cv.convertToBlob({ type: 'image/png' })
  await window.api.writeBinary(path, new Uint8Array(await blob.arrayBuffer()))
}

/** Saved masks of this video (null if there are none, or they are for another version) */
export async function loadBikeMasks(s: Session): Promise<BikeMaskTrack | null> {
  const p = await cachePath(s)
  if (!(await window.api.exists(p))) return null
  try {
    const { id, size } = await window.api.open(p, 'r')
    let gz: Uint8Array
    try {
      gz = await window.api.read(id, 0, size)
    } finally {
      await window.api.close(id)
    }
    const raw = new Uint8Array(await new Response(new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    return decodeBikeMasks(raw, bikeMaskKey(s))
  } catch {
    return null
  }
}

export async function saveBikeMasks(s: Session, tr: BikeMaskTrack): Promise<void> {
  const raw = encodeBikeMasks(tr, bikeMaskKey(s))
  const gz = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  await window.api.writeBinary(await cachePath(s), gz)
}
