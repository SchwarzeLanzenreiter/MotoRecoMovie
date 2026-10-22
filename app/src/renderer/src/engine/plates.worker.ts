// Worker that runs the license plate detector (core/plates.ts). WebGPU if available, otherwise CPU
import * as ort from 'onnxruntime-web/webgpu'
import { parsePlates, PLATE_SIZE, toPlateInput, type PlateBox } from '../core/plates'

export interface PlateInitRequest {
  kind: 'init'
  model: Uint8Array
}

export interface PlateRunRequest {
  kind: 'run'
  /** PLATE_SIZE square RGBA, from the top row */
  rgba: Uint8Array
  scoreThr: number
}

let session: ort.InferenceSession | null = null
let provider = ''

async function createSession(model: Uint8Array): Promise<ort.InferenceSession> {
  ort.env.wasm.numThreads = 1
  const nav = navigator as Navigator & { gpu?: unknown }
  if (nav.gpu) {
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] })
      provider = 'webgpu'
      return s
    } catch (e) {
      console.warn('Cannot run the plate detector on WebGPU, running it on CPU', e)
    }
  }
  provider = 'wasm'
  return ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
}

async function run(r: PlateRunRequest): Promise<PlateBox[]> {
  const s = session!
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', toPlateInput(r.rgba), [1, 3, PLATE_SIZE, PLATE_SIZE]) })
  const o = out[s.outputNames[0]]
  return parsePlates(o.data as Float32Array, o.dims[0], r.scoreThr)
}

// Requests are handled one at a time (the session cannot run twice at once; the next image may arrive while one is running)
let queue: Promise<void> = Promise.resolve()
self.onmessage = (e: MessageEvent<{ id: number; req: PlateInitRequest | PlateRunRequest }>) => {
  queue = queue.then(() => handle(e.data.id, e.data.req))
}

async function handle(id: number, req: PlateInitRequest | PlateRunRequest): Promise<void> {
  const post = (msg: unknown): void => (self as unknown as Worker).postMessage(msg)
  try {
    if (req.kind === 'init') {
      if (!session) {
        session = await createSession(req.model)
        await run({ kind: 'run', rgba: new Uint8Array(PLATE_SIZE * PLATE_SIZE * 4), scoreThr: 0.99 })
      }
      post({ id, ok: true, result: { provider } })
    } else post({ id, ok: true, result: await run(req) })
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
