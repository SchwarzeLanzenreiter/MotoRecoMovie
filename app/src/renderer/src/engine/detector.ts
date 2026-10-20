// Runs the car detection model (YOLOX-Nano) with onnxruntime-web. The model is public/models/yolox_nano.onnx (copied to out/renderer/models by the build)
import * as ort from 'onnxruntime-web'
import { DET_SIZE, decodeVehicles, toModelInput, type Detection } from '../core/vehicles'

let session: Promise<ort.InferenceSession> | null = null

/** Load the model file (as an app: file: is read as a file; from the dev server, by fetch) */
async function loadModel(): Promise<Uint8Array> {
  const url = new URL('./models/yolox_nano.onnx', document.baseURI)
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

function getSession(): Promise<ort.InferenceSession> {
  if (!session) {
    // Multiple threads need SharedArrayBuffer (cross-origin isolation), so run with 1 thread
    ort.env.wasm.numThreads = 1
    session = loadModel().then((m) => ort.InferenceSession.create(m, { executionProviders: ['wasm'] }))
    session.catch(() => (session = null))
  }
  return session
}

/** Find cars in a DET_SIZE-square RGBA image (from the top row) */
export async function detectVehicles(rgba: Uint8Array | Uint8ClampedArray): Promise<Detection[]> {
  const s = await getSession()
  const input = new ort.Tensor('float32', toModelInput(rgba), [1, 3, DET_SIZE, DET_SIZE])
  const r = await s.run({ [s.inputNames[0]]: input })
  const out = r[s.outputNames[0]].data as Float32Array
  return decodeVehicles(out)
}
