// Web Worker that runs the instance segmentation model (core/segment.ts) on onnxruntime-web: GPU (WebGPU) if available, otherwise CPU (WebAssembly)
import * as ort from 'onnxruntime-web/webgpu'
import { boxRegion, decodeInstances, instanceMask, MASK_FEAT, SEG_SIZE, toSegInput, type SegOutputs } from '../core/segment'

export interface SegInitRequest {
  kind: 'init'
  model: Uint8Array
}

export interface SegRunRequest {
  kind: 'run'
  /** SEG_SIZE square RGBA (from the top row) */
  rgba: Uint8Array
  classes: number[]
  scoreThr: number
  /** Overlap above which the weaker of two instances of a class is dropped */
  iou: number
  /** Also compute the masks of the instances found */
  masks: boolean
  /**
   * Only instances that lie mostly where this grid (MASK_FEAT square, 1 = may be) allows: at least `inside` of the outline. Their masks are
   * computed only around their boxes, and instances whose box holds none of it are skipped without a mask
   */
  prior?: Uint8Array
  inside?: number
  /**
   * Cells that are surely the own bike (MASK_FEAT square). If any lie in the image, only instances connected to them are kept: touching them
   * or an instance already kept (rider, passenger). A person or pole further away that happens to lie in the prior area is dropped
   */
  anchor?: Uint8Array
}

/** An instance as sent back (box in pixels of the 640 input; mask MASK_FEAT square, if requested) */
export interface SegResultInstance {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
  cls: number
  mask: Float32Array | null
}

let session: ort.InferenceSession | null = null
let provider = ''

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
      console.warn('Cannot run the segmentation on WebGPU, running it on CPU', e)
    }
  }
  provider = 'wasm'
  return ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
}

async function run(r: SegRunRequest): Promise<SegResultInstance[]> {
  const s = session!
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', toSegInput(r.rgba), [1, 3, SEG_SIZE, SEG_SIZE]) })
  const tensor = (name: string): Float32Array => out[name].data as Float32Array
  const o: SegOutputs = {
    cls: ['cls8', 'cls16', 'cls32'].map(tensor),
    box: ['box8', 'box16', 'box32'].map(tensor),
    kernel: ['kernel8', 'kernel16', 'kernel32'].map(tensor),
    maskFeat: tensor('mask_feat')
  }
  const out2: SegResultInstance[] = []
  for (const d of decodeInstances(o, { scoreThr: r.scoreThr, iou: r.iou, classes: r.classes, maxDet: 30 })) {
    let mask: Float32Array | null = null
    if (r.masks) {
      const region = r.prior ? boxRegion(d) : undefined
      if (r.prior && region) {
        let any = false
        for (let gy = region.gy0; gy < region.gy1 && !any; gy++) for (let gx = region.gx0; gx < region.gx1; gx++) if (r.prior[gy * MASK_FEAT + gx]) any = true
        if (!any) continue
      }
      mask = instanceMask(d, o.maskFeat, region)
      if (r.prior) {
        let all = 0
        let inside = 0
        for (let p = 0; p < mask.length; p++) {
          if (mask[p] < 0.5) continue
          all++
          if (r.prior[p]) inside++
        }
        if (!all || inside < (r.inside ?? 0) * all) continue
      }
    }
    out2.push({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, score: d.score, cls: d.cls, mask })
  }
  if (!r.masks || !r.anchor) return out2
  return connected(merged(out2), r.anchor)
}

/** Boxes overlapping this much (IoU) with the same class are the same object found several times */
const SAME_OBJECT = 0.5

/**
 * One instance per object: the model finds the rider several times with slightly different outlines (scores 0.15 to 0.7), and a few of
 * them reach into something next to the rider (a roadside pole). The masks of each group are averaged weighted by score, so only what most
 * of them agree on remains
 */
function merged(found: SegResultInstance[]): SegResultInstance[] {
  const iou = (a: SegResultInstance, b: SegResultInstance): number => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
    const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
    const i = ix * iy
    return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i + 1e-9)
  }
  const groups: SegResultInstance[][] = []
  // Highest score first: each group is led by its best instance
  for (const f of [...found].sort((a, b) => b.score - a.score)) {
    const g = groups.find((x) => x[0].cls === f.cls && iou(x[0], f) >= SAME_OBJECT)
    if (g) g.push(f)
    else groups.push([f])
  }
  return groups.map((g) => {
    if (g.length === 1 || !g[0].mask) return g[0]
    const mask = new Float32Array(g[0].mask.length)
    let w = 0
    for (const f of g) {
      if (!f.mask) continue
      for (let p = 0; p < mask.length; p++) mask[p] += f.mask[p] * f.score
      w += f.score
    }
    for (let p = 0; p < mask.length; p++) mask[p] /= w
    return { ...g[0], mask }
  })
}

/** Instances connected to the anchor cells, directly or through other kept instances (one cell of contact is enough) */
function connected(found: SegResultInstance[], anchor: Uint8Array): SegResultInstance[] {
  const N = MASK_FEAT
  if (!anchor.some((v) => v)) return found
  // Cells next to an instance already kept (outlines that meet but do not overlap still count as touching)
  const reach = new Uint8Array(N * N)
  const kept = new Set<SegResultInstance>()
  const byScore = [...found].sort((a, b) => b.score - a.score)
  for (let changed = true; changed; ) {
    changed = false
    for (const f of byScore) {
      if (kept.has(f) || !f.mask) continue
      // The pieces of the outline that overlap the sure part of the bike by a few cells, or touch a kept instance. An outline can come in
      // pieces, and a piece elsewhere (a roadside pole behind the passenger) is not theirs. Merely touching the sure part is not enough:
      // it can reach a little into the scenery
      // Only fairly confident instances may start from the sure part (it can reach a little into the scenery, where weak detections of
      // poles and bushes lie); weak ones have to touch an instance already kept
      const fromAnchor = f.score >= ANCHOR_SCORE
      const part = connectedPieces(f.mask, (piece) => {
        let onAnchor = 0
        for (const p of piece) {
          if (reach[p]) return true
          if (fromAnchor && anchor[p] && ++onAnchor >= ANCHOR_CELLS) return true
        }
        return false
      })
      if (!part) continue
      // Keep those pieces and the soft edge just outside them (cells below 0.5); other pieces are dropped even next to them
      const near = grow(part, 2)
      for (let p = 0; p < N * N; p++) if (!near[p] || (f.mask[p] >= 0.5 && !part[p])) f.mask[p] = 0
      kept.add(f)
      const g = grow(part, 1)
      for (let p = 0; p < N * N; p++) if (g[p]) reach[p] = 1
      changed = true
    }
  }
  return found.filter((f) => kept.has(f))
}

/** Cells of the sure part a piece has to cover, and the score an instance needs to start from it */
const ANCHOR_CELLS = 3
const ANCHOR_SCORE = 0.3

/** Cells of the outline (>= 0.5) in the connected pieces that pass keep; null if none does */
function connectedPieces(mask: Float32Array, keep: (piece: number[]) => boolean): Uint8Array | null {
  const N = MASK_FEAT
  const out = new Uint8Array(N * N)
  const seen = new Uint8Array(N * N)
  let any = false
  for (let p0 = 0; p0 < N * N; p0++) {
    if (seen[p0] || mask[p0] < 0.5) continue
    const piece: number[] = []
    const stack = [p0]
    seen[p0] = 1
    while (stack.length) {
      const p = stack.pop()!
      piece.push(p)
      const y = (p / N) | 0
      const x = p - y * N
      for (const q of [x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1, y > 0 ? p - N : -1, y < N - 1 ? p + N : -1]) {
        if (q < 0 || seen[q] || mask[q] < 0.5) continue
        seen[q] = 1
        stack.push(q)
      }
    }
    if (!keep(piece)) continue
    any = true
    for (const p of piece) out[p] = 1
  }
  return any ? out : null
}

/** Cells within r (square) of the set ones */
function grow(m: Uint8Array, r: number): Uint8Array {
  const N = MASK_FEAT
  const out = new Uint8Array(N * N)
  for (let p = 0; p < N * N; p++) {
    if (!m[p]) continue
    const y = (p / N) | 0
    const x = p - y * N
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy
      const xx = x + dx
      if (yy >= 0 && yy < N && xx >= 0 && xx < N) out[yy * N + xx] = 1
    }
  }
  return out
}

self.onmessage = async (e: MessageEvent<{ id: number; req: SegInitRequest | SegRunRequest }>) => {
  const { id, req } = e.data
  const post = (msg: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer)
  try {
    if (req.kind === 'init') {
      if (!session) {
        session = await createSession(req.model)
        // One run on an empty image, so the first real one does not wait for the GPU to prepare
        await run({ kind: 'run', rgba: new Uint8Array(SEG_SIZE * SEG_SIZE * 4), classes: [0], scoreThr: 0.99, iou: 0.6, masks: false })
      }
      post({ id, ok: true, result: { provider } })
    } else {
      const result = await run(req)
      post({ id, ok: true, result }, result.flatMap((x) => (x.mask ? [x.mask.buffer] : [])))
    }
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
