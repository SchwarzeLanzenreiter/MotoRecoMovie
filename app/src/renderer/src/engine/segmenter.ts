// Instance segmentation (RTMDet-Ins tiny, COCO): vehicles for the overtake search, and the outline of the own bike and rider for hiding signs
// behind them. The model runs in segmenter.worker.ts; the model file is public/models/rtmdet_ins_tiny.onnx (npm run fetch-assets)
import type { SegInitRequest, SegResultInstance, SegRunRequest } from './segmenter.worker'

export type { SegResultInstance }

/** Load the model file (as an app: file: is read as a file; from the dev server, by fetch) */
async function loadModel(): Promise<Uint8Array> {
  const url = new URL('./models/rtmdet_ins_tiny.onnx', document.baseURI)
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

function call<T>(req: SegInitRequest | SegRunRequest, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./segmenter.worker.ts', import.meta.url), { type: 'module' })
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
export function initSegmenter(): Promise<string> {
  if (!ready) {
    ready = loadModel().then((model) => call<{ provider: string }>({ kind: 'init', model }, [model.buffer]).then((r) => r.provider))
    ready.catch(() => (ready = null))
  }
  return ready
}

/**
 * Instances of the given COCO classes in a SEG_SIZE square RGBA image (from the top row). The image is handed over (its buffer is transferred).
 * iou: overlap above which the weaker of two instances of a class is dropped. masks: also the masks (MASK_FEAT square probabilities).
 * prior / inside: only instances whose outline lies at least `inside` within the cells marked in prior (MASK_FEAT square).
 * anchor: only instances connected to these cells (directly or through other kept instances)
 */
export async function segment(
  rgba: Uint8Array,
  classes: number[],
  opts: { scoreThr?: number; iou?: number; masks?: boolean; prior?: Uint8Array; inside?: number; anchor?: Uint8Array } = {}
): Promise<SegResultInstance[]> {
  await initSegmenter()
  const req: SegRunRequest = { kind: 'run', rgba, classes, scoreThr: opts.scoreThr ?? 0.3, iou: opts.iou ?? 0.6, masks: !!opts.masks, prior: opts.prior, inside: opts.inside, anchor: opts.anchor }
  return call<SegResultInstance[]>(req, [rgba.buffer])
}
