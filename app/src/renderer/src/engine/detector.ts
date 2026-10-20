// 車の検出モデル（YOLOX-Nano）を onnxruntime-web で動かす。モデルは public/models/yolox_nano.onnx（ビルドで out/renderer/models へ）
import * as ort from 'onnxruntime-web'
import { DET_SIZE, decodeVehicles, toModelInput, type Detection } from '../core/vehicles'

let session: Promise<ort.InferenceSession> | null = null

/** モデルのファイルを読む（アプリとして開いたとき = file: はファイルとして、開発用のサーバーからは fetch で） */
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
    // 複数スレッドは SharedArrayBuffer（クロスオリジン分離）が要るので 1 スレッドで動かす
    ort.env.wasm.numThreads = 1
    session = loadModel().then((m) => ort.InferenceSession.create(m, { executionProviders: ['wasm'] }))
    session.catch(() => (session = null))
  }
  return session
}

/** DET_SIZE 四方の RGBA 画像（上の行から）から車を探す */
export async function detectVehicles(rgba: Uint8Array | Uint8ClampedArray): Promise<Detection[]> {
  const s = await getSession()
  const input = new ort.Tensor('float32', toModelInput(rgba), [1, 3, DET_SIZE, DET_SIZE])
  const r = await s.run({ [s.inputNames[0]]: input })
  const out = r[s.outputNames[0]].data as Float32Array
  return decodeVehicles(out)
}
