// 音の処理（core/audiofx.ts の suppressNoise）を画面と別のスレッドで行う
import { suppressNoise } from '../core/audiofx'

self.onmessage = (e: MessageEvent<{ id: number; x: Float32Array; fs: number; noiseDb: number; margin: number }>) => {
  const { id, x, fs, noiseDb, margin } = e.data
  try {
    const y = suppressNoise(x, fs, noiseDb, margin).slice()
    self.postMessage({ id, ok: true, y }, { transfer: [y.buffer] })
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
