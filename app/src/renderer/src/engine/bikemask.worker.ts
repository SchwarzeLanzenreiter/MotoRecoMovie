// Statistics of the own-bike mask (core/bikemask.ts), off the main thread
import { buildBikeMask } from '../core/bikemask'

self.onmessage = (e: MessageEvent<{ id: number; frames: Uint8Array[]; seamAx: number[] }>) => {
  const { id, frames, seamAx } = e.data
  try {
    const mask = buildBikeMask(frames, seamAx)
    ;(self as unknown as Worker).postMessage({ id, ok: true, mask }, mask ? [mask.core.buffer, mask.env.buffer, mask.lut.buffer] : [])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
