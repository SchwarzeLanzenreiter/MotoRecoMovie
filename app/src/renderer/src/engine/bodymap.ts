// Builds the own-bike seam template per video section (core/bodymap.ts).
// Reads keyframes with a dedicated decoder, builds the band images of both lenses on the GPU, and leaves the AI processing to bodymap.worker.ts.
// The built template is saved next to the video as .motorecomovie-body.bin and read back the next time it is opened
import { BAND_STEP, BAND_W, decodeBodyTrack, encodeBodyTrack, type BodyTrack } from '../core/bodymap'
import { TrackDecoder } from './decoder'
import { GlReframer } from '../render/gl-reframe'
import type { Session } from './session'
import type { BodyInitRequest, BodyWindowRequest, BodyWindowResult, InpaintKind } from './bodymap.worker'
import { t } from '../i18n'

/** Section length [s]. Long enough to be treated as stationary within a section even for videos where the camera mount rotates slowly (1 to 3 degrees per minute) */
export const BODY_WINDOW_SEC = 30

export const bodyPathFor = (insv: string): string => insv + '.motorecomovie-body.bin'

/** Key that checks whether a template belongs to the current video and lens correction (seam fitting) */
export function bodyKey(session: Session): string {
  const L = session.rig[1]
  return [session.file.size, session.frameCount, BAND_W, BAND_STEP, Array.from(L.camFromRig, (v) => v.toFixed(5)).join(','), (L.edge ?? 0).toFixed(5)].join('|')
}

/** Load the model file (as an app: file: is read as a file; from the dev server, by fetch) */
async function loadModel(name: string): Promise<Uint8Array> {
  const url = new URL(`./models/${name}`, document.baseURI)
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
let initDone: Promise<string> | null = null
let initKind: InpaintKind | null = null

function call<T>(req: BodyInitRequest | BodyWindowRequest | { kind: 'reset' }, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./bodymap.worker.ts', import.meta.url), { type: 'module' })
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

/** Load the AI model (only once. Reload if the inpainting model changes) */
function init(kind: InpaintKind): Promise<string> {
  if (initDone && initKind === kind) return initDone
  initKind = kind
  initDone = (async () => {
    const flow = await loadModel('neuflow_mixed.onnx')
    const inpaint = await loadModel(kind === 'migan' ? 'migan_pipeline_v2.onnx' : 'lama_fp32.onnx')
    const r = await call<{ provider: string }>({ kind: 'init', flow, inpaint, inpaintKind: kind }, [flow.buffer, inpaint.buffer])
    return r.provider
  })()
  initDone.catch(() => (initDone = null))
  return initDone
}

export interface BodyBuildOptions {
  /** Range to build [s] (the whole video if omitted) */
  from?: number
  to?: number
  windowSec?: number
  inpaint?: InpaintKind
  /** For verification: make the own-bike part inside this rectangle (band pixels) a hole */
  forceHole?: number[] | null
  /** Cancel signal */
  signal?: { aborted: boolean }
}

/**
 * Builds the own-bike seam template per section. onProgress receives progress 0 to 1 and a message
 */
export async function buildBodyTrack(session: Session, opts: BodyBuildOptions = {}, onProgress?: (frac: number, msg: string) => void): Promise<BodyTrack> {
  const provider = await init(opts.inpaint ?? 'lama')
  await call({ kind: 'reset' })
  const win = opts.windowSec ?? BODY_WINDOW_SEC
  const dur = session.frameCount / session.fps
  const from = Math.max(0, opts.from ?? 0)
  const to = Math.min(dur, opts.to ?? dur)
  const track = session.decoders[0].track
  const gl = new GlReframer(new OffscreenCanvas(16, 16))
  gl.setLenses(session.rig)
  const decs = session.decoders.map((d) => new TrackDecoder(session.file, d.track))
  const out: BodyTrack = { windows: [], maps: [] }
  const n = Math.max(1, Math.ceil((to - from) / win))
  try {
    for (let k = 0; k < n; k++) {
      if (opts.signal?.aborted) throw new Error(t('Cancelled'))
      const t0 = from + k * win
      const t1 = Math.min(to, t0 + win)
      onProgress?.(k / n, t('Building the body seam map ({k}/{n}, AI: {p})', { k: k + 1, n, p: provider === 'webgpu' ? 'GPU' : 'CPU' }))
      // Keyframes of the section (thinned if too many)
      const i0 = Math.max(0, Math.floor(t0 * session.fps))
      const i1 = Math.min(session.frameCount, Math.ceil(t1 * session.fps))
      let keys: number[] = []
      for (let i = i0; i < i1; i++) if (track.keyframes[i]) keys.push(i)
      if (keys.length > 9) keys = keys.filter((_, j) => j % Math.ceil(keys.length / 9) === 0)
      if (keys.length < 2) {
        out.windows.push({ t0, t1, map: -1 })
        continue
      }
      const bands0: Uint8Array[] = []
      const bands1: Uint8Array[] = []
      for (const i of keys) {
        const [f0, f1] = await Promise.all([decs[0].get(i), decs[1].get(i)])
        gl.upload([f0, f1])
        f0.close()
        f1.close()
        bands0.push(gl.renderBand(0))
        bands1.push(gl.renderBand(1))
      }
      const r = await call<BodyWindowResult>({ kind: 'window', bands0, bands1, forceHole: opts.forceHole ?? null }, [...bands0, ...bands1].map((b) => b.buffer))
      let idx = -1
      if (r.map) {
        if (r.reused && out.maps.length) idx = out.maps.length - 1
        else {
          out.maps.push(r.map)
          idx = out.maps.length - 1
        }
      }
      out.windows.push({ t0, t1, map: idx })
      console.log(`Own-bike seam ${t0.toFixed(0)} to ${t1.toFixed(0)} s: ${keys.length} keyframes, ${r.reused ? 'same as the previous section' : r.map ? `template ${r.map.w} columns` : 'no own-bike part'}, holes ${r.holes} pixels`, JSON.stringify(r.ms))
    }
  } finally {
    for (const d of decs) d.close()
  }
  onProgress?.(1, '')
  return out
}

/** Load a saved template (null if missing, outdated, or from another video) */
export async function loadBodyTrack(session: Session): Promise<BodyTrack | null> {
  const p = bodyPathFor(session.path)
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
    return decodeBodyTrack(raw, bodyKey(session))
  } catch (e) {
    console.warn('Cannot read the own-bike seam template', e)
    return null
  }
}

/** Save the template next to the video (gzip) */
export async function saveBodyTrack(session: Session, track: BodyTrack): Promise<void> {
  const raw = encodeBodyTrack(track, bodyKey(session))
  const gz = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  await window.api.writeBinary(bodyPathFor(session.path), gz)
}
