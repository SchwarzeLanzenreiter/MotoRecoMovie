// Web Worker that builds the own-bike seam template (core/bodymap.ts). Runs the heavy work (template median, AI optical flow, image inpainting)
// on a thread separate from the UI. The AI runs on onnxruntime-web: GPU (WebGPU) if available, otherwise CPU (WebAssembly)
import * as ort from 'onnxruntime-web/webgpu'
import {
  BAND_H,
  BAND_W,
  bandStats,
  buildStitch,
  compactStitch,
  findHoles,
  FLOW_H,
  FLOW_W,
  flowInput,
  flowToBand,
  stitchedTemplate,
  type BandStats,
  type BodyMapC
} from '../core/bodymap'

export type InpaintKind = 'lama' | 'migan'

export interface BodyInitRequest {
  kind: 'init'
  flow: Uint8Array
  inpaint: Uint8Array | null
  inpaintKind: InpaintKind
}

export interface BodyWindowRequest {
  kind: 'window'
  /** Images of the keyframe bands of the section (RGBA, lens 0 and lens 1) */
  bands0: Uint8Array[]
  bands1: Uint8Array[]
  /** For verification: make the own-bike part inside this rectangle [x0, y0, x1, y1] (band pixels) a hole */
  forceHole?: number[] | null
}

export interface BodyWindowResult {
  map: BodyMapC | null
  /** Whether the same template as the previous section was reused */
  reused: boolean
  holes: number
  ms: Record<string, number>
}

let flowSession: ort.InferenceSession | null = null
let inpaintSession: ort.InferenceSession | null = null
let inpaintKind: InpaintKind = 'lama'
let provider = ''
/** Previous section (for the reuse check) */
let prev: { lum: Float32Array; m: Uint8Array; map: BodyMapC | null } | null = null

async function createSession(model: Uint8Array): Promise<ort.InferenceSession> {
  // If GPU (WebGPU) is unavailable, use CPU (1 thread; multiple threads need SharedArrayBuffer)
  ort.env.wasm.numThreads = 1
  const nav = navigator as Navigator & { gpu?: unknown }
  if (nav.gpu) {
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] })
      provider = 'webgpu'
      return s
    } catch (e) {
      console.warn('Cannot run the AI on WebGPU, running it on CPU', e)
    }
  }
  provider = 'wasm'
  return ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
}

async function runFlow(a: Float32Array, b: Float32Array): Promise<Float32Array> {
  const s = flowSession!
  const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', a, [1, 3, FLOW_H, FLOW_W]), [s.inputNames[1]]: new ort.Tensor('float32', b, [1, 3, FLOW_H, FLOW_W]) })
  return r[s.outputNames[0]].data as Float32Array
}

/** Left edges of the flow tiles covering the columns that contain the own-bike part (FLOW_W columns each, slightly overlapping) */
function tilesFor(s0: BandStats, s1: BandStats): number[] {
  const col = new Uint8Array(BAND_W)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      if ((s0.valid[i] && s0.stat[i] > 0.5) || (s1.valid[i] && s1.stat[i] > 0.5)) col[x] = 1
    }
  // Cover the arc, excluding the longest run of columns without the own-bike part, with tiles (96 extra columns at each end)
  let bestLen = 0
  let bestStart = 0
  for (let x = 0; x < BAND_W; x++) {
    if (col[x] || !col[(x - 1 + BAND_W) % BAND_W]) continue
    let n = 0
    while (n < BAND_W && !col[(x + n) % BAND_W]) n++
    if (n > bestLen) {
      bestLen = n
      bestStart = x
    }
  }
  if (!col.some((v) => v)) return []
  const arcStart = (bestStart + bestLen) % BAND_W
  const arcLen = BAND_W - bestLen + 192
  const step = FLOW_W - 96
  const n = Math.max(1, Math.ceil((arcLen - FLOW_W) / step) + 1)
  const out: number[] = []
  // Center on the middle of the arc
  const span = (n - 1) * step + FLOW_W
  const start = arcStart - 96 - Math.floor((span - arcLen) / 2)
  for (let k = 0; k < n; k++) out.push((((start + k * step) % BAND_W) + BAND_W) % BAND_W)
  return out
}

/** Fill the holes with the AI (512 square at a time; the 288 rows of the band are extended to 512 rows by duplicating the top and bottom rows) */
async function inpaint(img: Uint8Array, holes: Uint8Array): Promise<Uint8Array> {
  const out = img.slice()
  const s = inpaintSession
  if (!s) return out
  const S = 512
  const pad = (S - BAND_H) >> 1
  // Group the columns with holes into chunks of 400 columns and place a 512-column window at the center
  const col = new Uint8Array(BAND_W)
  for (let y = 0; y < BAND_H; y++) for (let x = 0; x < BAND_W; x++) if (holes[y * BAND_W + x]) col[x] = 1
  const centers: number[] = []
  for (let x = 0; x < BAND_W; ) {
    if (!col[x]) {
      x++
      continue
    }
    let e = x
    while (e < BAND_W && col[e] && e - x < 400) e++
    centers.push((x + e) >> 1)
    x = e
  }
  for (const cx of centers) {
    const x0 = cx - S / 2
    const rgb = new Uint8Array(3 * S * S)
    const keep = new Uint8Array(S * S)
    for (let y = 0; y < S; y++) {
      const by = Math.min(BAND_H - 1, Math.max(0, y - pad))
      for (let x = 0; x < S; x++) {
        const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
        const i = by * BAND_W + bx
        for (let c = 0; c < 3; c++) rgb[c * S * S + y * S + x] = out[i * 3 + c]
        keep[y * S + x] = holes[i] && y - pad === by ? 0 : 1
      }
    }
    let res: Uint8Array
    if (inpaintKind === 'migan') {
      // MI-GAN (with pre/post-processing): a uint8 image and a mask with 255 = keep / 0 = fill
      const r = await s.run({ image: new ort.Tensor('uint8', rgb, [1, 3, S, S]), mask: new ort.Tensor('uint8', keep.map((v) => v * 255), [1, 1, S, S]) })
      res = r[s.outputNames[0]].data as Uint8Array
    } else {
      // LaMa: a 0 to 1 image and a mask with 1 = fill. The output is 0 to 255
      const fimg = new Float32Array(rgb.length)
      for (let i = 0; i < rgb.length; i++) fimg[i] = rgb[i] / 255
      const fm = new Float32Array(S * S)
      for (let i = 0; i < fm.length; i++) fm[i] = keep[i] ? 0 : 1
      const r = await s.run({ image: new ort.Tensor('float32', fimg, [1, 3, S, S]), mask: new ort.Tensor('float32', fm, [1, 1, S, S]) })
      const d = r[s.outputNames[0]].data as Float32Array
      res = new Uint8Array(d.length)
      for (let i = 0; i < d.length; i++) res[i] = Math.max(0, Math.min(255, Math.round(d[i])))
    }
    for (let y = pad; y < pad + BAND_H; y++)
      for (let x = 0; x < S; x++) {
        const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
        const i = (y - pad) * BAND_W + bx
        if (!holes[i]) continue
        for (let c = 0; c < 3; c++) out[i * 3 + c] = res[c * S * S + y * S + x]
      }
  }
  return out
}

/** Whether the same template as the previous section can be used: in the own-bike part of the previous section, the lens 0 template brightness is nearly the same (the camera mount has not rotated) */
function sameAsPrev(lum: Float32Array): boolean {
  if (!prev) return false
  let s = 0
  let n = 0
  for (let i = 0; i < lum.length; i++) {
    if (prev.m[i] < 128) continue
    s += Math.abs(lum[i] - prev.lum[i])
    n++
  }
  return n > 1000 && s / n < 0.025
}

async function handleWindow(req: BodyWindowRequest): Promise<BodyWindowResult> {
  const ms: Record<string, number> = {}
  let t = performance.now()
  const lap = (k: string): void => {
    const n = performance.now()
    ms[k] = Math.round(n - t)
    t = n
  }
  const s0 = bandStats(req.bands0)
  const s1 = bandStats(req.bands1)
  lap('template')
  const N = BAND_W * BAND_H
  const lum = new Float32Array(N)
  for (let i = 0; i < N; i++) lum[i] = (s0.med[i * 3] + s0.med[i * 3 + 1] + s0.med[i * 3 + 2]) / (3 * 255)
  if (!req.forceHole && sameAsPrev(lum)) return { map: prev!.map, reused: true, holes: 0, ms }
  const tiles = tilesFor(s0, s1)
  const acc = () => ({ fx: new Float32Array(N), fy: new Float32Array(N), w: new Float32Array(N) })
  const fwd = acc()
  const bwd = acc()
  for (const x0 of tiles) {
    const a = flowInput(s0.med, x0)
    const b = flowInput(s1.med, x0)
    flowToBand(await runFlow(a, b), x0, fwd.fx, fwd.fy, fwd.w)
    flowToBand(await runFlow(b, a), x0, bwd.fx, bwd.fy, bwd.w)
  }
  for (const f of [fwd, bwd])
    for (let i = 0; i < N; i++)
      if (f.w[i] > 0) {
        f.fx[i] /= f.w[i]
        f.fy[i] /= f.w[i]
      }
  lap(`flow (${tiles.length} tiles, ${provider})`)
  const st = buildStitch(s0, s1, fwd, bwd)
  lap('seam')
  const holes = findHoles(s0, s1, st, req.forceHole ?? null)
  let nh = 0
  for (let i = 0; i < N; i++) nh += holes[i]
  let fill: Uint8Array | null = null
  if (nh > 0) {
    fill = await inpaint(stitchedTemplate(s0, s1, st), holes)
    lap(`inpaint (${inpaintKind})`)
  }
  const map = compactStitch(st, holes, fill)
  const m = new Uint8Array(N)
  for (let i = 0; i < N; i++) m[i] = Math.round(st.m[i] * 255)
  prev = { lum, m, map }
  return { map, reused: false, holes: nh, ms }
}

self.onmessage = async (e: MessageEvent<{ id: number; req: BodyInitRequest | BodyWindowRequest | { kind: 'reset' } }>) => {
  const { id, req } = e.data
  try {
    if (req.kind === 'init') {
      flowSession = await createSession(req.flow)
      inpaintKind = req.inpaintKind
      inpaintSession = req.inpaint ? await createSession(req.inpaint) : null
      self.postMessage({ id, ok: true, result: { provider } })
    } else if (req.kind === 'reset') {
      prev = null
      self.postMessage({ id, ok: true, result: null })
    } else {
      const r = await handleWindow(req)
      self.postMessage({ id, ok: true, result: r })
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
