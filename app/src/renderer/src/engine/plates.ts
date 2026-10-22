// License plate scan for the privacy mosaic (core/plates.ts): the detector runs in plates.worker.ts on perspective crops round the bike,
// PLATE_RATE times a second; the plates found are cached per video in the user data folder (plates-<hash>.json.gz) with the ranges scanned.
// The model file is public/models/<PLATE_MODEL> (npm run fetch-assets)
import {
  addRange,
  boxToWorld,
  DOWN_EVERY,
  EMPTY_EVERY,
  mergeOverlapping,
  missingRanges,
  OWN_MIN_SPEED,
  ownPlates,
  OWN_SCORE,
  OWN_SURVEY_LEN,
  PLATE_CROPS,
  PLATE_FOV,
  PLATE_MODEL,
  PLATE_RATE,
  PLATE_SCORE,
  PLATE_SIZE,
  surveyTimes,
  type OwnPlate,
  type PlateBox,
  type PlateCache,
  type PlateScan
} from '../core/plates'
import { sampleQ } from '../core/motion'
import { mountAt } from '../core/mount'
import { sampleChannel } from '../core/telemetry'
import { qToMat, type Mat3 } from '../core/quat'
import { GlReframer } from '../render/gl-reframe'
import { TrackDecoder } from './decoder'
import type { PlateInitRequest, PlateRunRequest } from './plates.worker'
import type { Session } from './session'

const VERSION = 3

/** Load the model file (as an app: file: is read as a file; from the dev server, by fetch) */
async function loadModel(): Promise<Uint8Array> {
  const url = new URL(`./models/${PLATE_MODEL}`, document.baseURI)
  if (url.protocol === 'file:') {
    const path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
    const { id, size } = await window.api.open(path, 'r')
    try {
      return await window.api.read(id, 0, size)
    } finally {
      await window.api.close(id)
    }
  }
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { ok: (v: unknown) => void; ng: (e: Error) => void }>()
let ready: Promise<string> | null = null

function call<T>(req: PlateInitRequest | PlateRunRequest, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./plates.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      waiting.delete(e.data.id)
      if (e.data.ok) w.ok(e.data.result)
      else w.ng(new Error(e.data.error))
    }
  }
  const id = nextId++
  return new Promise<T>((ok, ng) => {
    waiting.set(id, { ok: ok as (v: unknown) => void, ng })
    worker!.postMessage({ id, req }, transfer)
  })
}

/** Load the model once (returns 'webgpu' or 'wasm') */
export function initPlates(): Promise<string> {
  if (!ready) {
    ready = loadModel().then((model) => call<{ provider: string }>({ kind: 'init', model }, [model.buffer]).then((r) => r.provider))
    ready.catch(() => (ready = null))
  }
  return ready
}

/** Plates in a PLATE_SIZE square RGBA image (from the top row; its buffer is handed over) */
export async function detectPlates(rgba: Uint8Array, scoreThr = PLATE_SCORE): Promise<PlateBox[]> {
  await initPlates()
  return call<PlateBox[]>({ kind: 'run', rgba, scoreThr }, [rgba.buffer])
}

/** Key that checks whether saved plates belong to this video and this way of scanning */
export function plateKey(s: Session): string {
  return [VERSION, s.path, s.file.size, s.frameCount, PLATE_RATE, PLATE_MODEL, PLATE_SCORE].join('|')
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
  return window.api.path.join(await window.api.cacheDir(), `plates-${hash(`${s.path}|${s.file.size}`)}.json.gz`)
}

/** Saved plates of this video (an empty cache if there are none, or they are for another version) */
export async function loadPlates(s: Session): Promise<PlateCache> {
  const empty: PlateCache = { key: plateKey(s), ranges: [], scans: [], rig: [], moving: [] }
  const p = await cachePath(s)
  if (!(await window.api.exists(p))) return empty
  try {
    const { id, size } = await window.api.open(p, 'r')
    let gz: Uint8Array
    try {
      gz = await window.api.read(id, 0, size)
    } finally {
      await window.api.close(id)
    }
    const text = await new Response(new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    const c = JSON.parse(text) as PlateCache
    return c.key === empty.key ? c : empty
  } catch {
    return empty
  }
}

export async function savePlates(s: Session, c: PlateCache): Promise<void> {
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(c)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  await window.api.writeBinary(await cachePath(s), gz)
}

const IDENTITY: Mat3 = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4

/**
 * Plates in the chosen crops round frame i (already uploaded to gl): corners in world directions of those scoring PLATE_SCORE, and
 * every detection down to OWN_SCORE in rig directions ([t, 12 numbers], for the own bike's plate). found[k]: whether crop k had any
 */
async function platesInFrame(s: Session, gl: GlReframer, i: number, crops: number[]): Promise<{ quads: number[][]; rig: number[][]; found: Set<number> }> {
  const t = s.motion.videoTime(i)
  const toWorld = qToMat(sampleQ(s.ori, s.motion.tc(i)))
  const world: { quad: number[]; score: number }[] = []
  const rig: number[][] = []
  const found = new Set<number>()
  // All crops are drawn and handed to the detector first, so drawing overlaps with the detection of the ones before
  const views = crops.map((k) => s.motion.frame(i, { yaw: PLATE_CROPS[k].yaw, pitch: PLATE_CROPS[k].pitch, fov: PLATE_FOV, leanRatio: 0 }).view)
  const results = views.map((view) => detectPlates(gl.renderCrop(view, PLATE_FOV, PLATE_SIZE), OWN_SCORE))
  for (let n = 0; n < crops.length; n++) {
    const k = crops[n]
    const view = views[n]
    for (const b of await results[n]) {
      rig.push([t, ...boxToWorld(b, view, PLATE_FOV, PLATE_SIZE, IDENTITY).flat()].map(round4))
      if (b.score < PLATE_SCORE) continue
      found.add(k)
      world.push({ quad: boxToWorld(b, view, PLATE_FOV, PLATE_SIZE, toWorld).flat().map(round4), score: b.score })
    }
  }
  return { quads: mergeOverlapping(world), rig, found }
}

/**
 * Scans [t0, t1] of the video into cache c (in place; saved every few seconds of video and at the end). Frames come from decoders of
 * its own, so playback is not disturbed; while idle() is false (playing) it waits.
 * onScan: called with each scan that found plates (to show them before the scan is over); onSave: after each save on the way.
 * allCrops: every crop at every scan (for the survey of the own bike's plate)
 */
export async function scanPlates(
  s: Session,
  c: PlateCache,
  t0: number,
  t1: number,
  opts: {
    onProgress?: (frac: number) => void
    onScan?: (scan: PlateScan) => void
    onSave?: () => void
    signal?: AbortSignal
    idle?: () => boolean
    allCrops?: boolean
  } = {}
): Promise<void> {
  await initPlates()
  const gl = new GlReframer(new OffscreenCanvas(PLATE_SIZE, PLATE_SIZE))
  gl.setLenses(s.rig)
  gl.dynamicSeam = false
  const decs = s.decoders.map((d) => new TrackDecoder(s.file, d.track))
  const step = Math.max(1, Math.round(s.meta.fps / PLATE_RATE))
  const i0 = s.frameOf(t0)
  const i1 = s.frameOf(t1)
  let from = s.motion.videoTime(i0)
  let lastSave = from
  // Crops with plates in their last look are looked at every scan; others every EMPTY_EVERY scans (staggered), the downward ones every DOWN_EVERY
  const busy = new Set<number>()
  // Vehicle speed from the log (or estimated from the video); without it every scan counts as moving
  const tel = s.telemetry(true)
  let n = 0
  // The next frames are decoded while the plates in the current ones are looked for
  const fetch = (i: number): Promise<VideoFrame[]> | null => (i <= i1 ? Promise.all(decs.map((d) => d.get(i))) : null)
  let pending = fetch(i0)
  try {
    for (let i = i0; i <= i1; i += step, n++) {
      if (opts.signal?.aborted) break
      while (opts.idle && !opts.idle()) {
        await new Promise((r) => setTimeout(r, 300))
        if (opts.signal?.aborted) break
      }
      if (opts.signal?.aborted) break
      const frames = await pending!
      pending = fetch(i + step)
      try {
        gl.upload([frames[0], frames[1]])
      } finally {
        for (const f of frames) f.close()
      }
      const t = s.motion.videoTime(i)
      const crops = PLATE_CROPS.map((_, k) => k).filter(
        (k) => opts.allCrops || busy.has(k) || (PLATE_CROPS[k].pitch < -30 ? n % DOWN_EVERY === 0 : (n + k) % EMPTY_EVERY === 0)
      )
      const r = await platesInFrame(s, gl, i, crops)
      for (const k of crops) {
        if (r.found.has(k)) busy.add(k)
        else busy.delete(k)
      }
      c.rig.push(...r.rig)
      if (!tel?.channels.speed || (sampleChannel(tel, 'speed', t) ?? 0) >= OWN_MIN_SPEED) c.moving.push(round4(t))
      if (r.quads.length) {
        const scan = { t, quads: r.quads }
        c.scans.push(scan)
        opts.onScan?.(scan)
      }
      opts.onProgress?.((i - i0) / Math.max(1, i1 - i0))
      if (t - lastSave > 30) {
        c.ranges = addRange(c.ranges, [from, t])
        c.scans.sort((a, b) => a.t - b.t)
        await savePlates(s, c)
        from = t
        lastSave = t
        opts.onSave?.()
      }
    }
    if (!opts.signal?.aborted) c.ranges = addRange(c.ranges, [from, s.motion.videoTime(i1)])
  } finally {
    await pending?.then((fs) => fs.forEach((f) => f.close())).catch(() => undefined)
    for (const d of decs) d.close()
    gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
    c.scans.sort((a, b) => a.t - b.t)
    await savePlates(s, c)
  }
}

/** The own bike's plates of the session (bike coordinates, with the current mount orientation; with the boxes drawn by hand) */
export function ownPlatesOf(s: Session): OwnPlate[] {
  const c = s.plates!.cache
  return ownPlates(c.rig, c.moving, (t) => mountAt(s.motion.mount, s.motion.tc(s.frameOf(t))), s.plateMarks)
}

/** The plates of the session, read from the cache the first time */
export async function sessionPlates(s: Session): Promise<NonNullable<Session['plates']>> {
  if (!s.plates) {
    s.plates = { cache: await loadPlates(s), own: [] }
    s.plates.own = ownPlatesOf(s)
  }
  return s.plates
}

/** Whether [t0, t1] still has parts to scan */
export async function platesMissing(s: Session, t0: number, t1: number): Promise<boolean> {
  return missingRanges((await sessionPlates(s)).cache.ranges, t0, t1).length > 0
}

/**
 * Scans the parts of [t0, t1] not scanned yet (onProgress over those parts), working out the own bike's plate again on the way.
 * The first time for a video, the survey stretches for the own bike's plate (surveyTimes) are scanned before.
 * onScan: called as plates are found or the own bike's plate changes (to redraw)
 */
export async function ensurePlates(
  s: Session,
  t0: number,
  t1: number,
  opts: { onProgress?: (frac: number) => void; onScan?: () => void; signal?: AbortSignal; idle?: () => boolean } = {}
): Promise<void> {
  const p = await sessionPlates(s)
  const own = (): void => {
    p.own = ownPlatesOf(s)
    opts.onScan?.()
  }
  const survey: [number, number][] = []
  if (!p.cache.surveyed) {
    const tel = s.telemetry(true)
    const speedAt = tel?.channels.speed ? (t: number): number => sampleChannel(tel, 'speed', t) ?? 0 : null
    for (const a of surveyTimes(s.motion.videoTime(s.frameCount - 1), speedAt)) survey.push(...missingRanges(p.cache.ranges, a, a + OWN_SURVEY_LEN))
  }
  const miss = missingRanges(p.cache.ranges, t0, t1)
  const total = [...survey, ...miss].reduce((n, [a, b]) => n + (b - a), 0)
  let done = 0
  const scan = async (a: number, b: number, allCrops: boolean): Promise<void> => {
    await scanPlates(s, p.cache, a, b, {
      signal: opts.signal,
      idle: opts.idle,
      allCrops,
      onScan: opts.onScan,
      onSave: own,
      onProgress: (f) => opts.onProgress?.((done + f * (b - a)) / Math.max(1e-6, total))
    })
    done += b - a
  }
  if (!p.cache.surveyed) {
    for (const [a, b] of survey) {
      if (opts.signal?.aborted) return
      await scan(a, b, true)
    }
    if (opts.signal?.aborted) return
    p.cache.surveyed = true
    await savePlates(s, p.cache)
    own()
  }
  for (const [a, b] of miss) {
    if (opts.signal?.aborted) break
    // Without the parts the survey scanned
    for (const [a2, b2] of missingRanges(p.cache.ranges, a, b)) {
      if (opts.signal?.aborted) break
      await scan(a2, b2, false)
    }
    own()
  }
}

/** Debug: the crops round frame i with the plates found (for the autotest) */
export async function debugPlateCrops(s: Session, i: number): Promise<{ yaw: number; pitch: number; rgba: Uint8Array; boxes: PlateBox[] }[]> {
  await initPlates()
  const gl = new GlReframer(new OffscreenCanvas(PLATE_SIZE, PLATE_SIZE))
  gl.setLenses(s.rig)
  gl.dynamicSeam = false
  const decs = s.decoders.map((d) => new TrackDecoder(s.file, d.track))
  const out: { yaw: number; pitch: number; rgba: Uint8Array; boxes: PlateBox[] }[] = []
  try {
    const frames = await Promise.all(decs.map((d) => d.get(i)))
    gl.upload([frames[0], frames[1]])
    for (const f of frames) f.close()
    for (const c of PLATE_CROPS) {
      const view = s.motion.frame(i, { yaw: c.yaw, pitch: c.pitch, fov: PLATE_FOV, leanRatio: 0 }).view
      const img = gl.renderCrop(view, PLATE_FOV, PLATE_SIZE)
      const copy = img.slice()
      const t0 = performance.now()
      const boxes = await detectPlates(img, OWN_SCORE)
      console.log(`  crop ${c.yaw}/${c.pitch}: ${(performance.now() - t0).toFixed(1)}ms`)
      out.push({ ...c, rgba: copy, boxes })
    }
  } finally {
    for (const d of decs) d.close()
    gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  return out
}
