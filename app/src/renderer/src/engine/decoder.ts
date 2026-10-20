// Decode one video track with WebCodecs and fetch arbitrary frame numbers.
// For a frame slightly ahead, decoding continues from where it is; for a distant one, it restarts from the preceding keyframe.
import { keyframeBefore, type FileReader, type Track } from '../core/mp4'
import { t } from '../i18n'

const FRAME_US = 20000 // timestamp (frame number x 20 ms). The real time is not used
const READY_MAX = 12 // upper limit on frames that are already output but not yet used

export class TrackDecoder {
  private dec: VideoDecoder | null = null
  private next = 0 // next sample to feed
  private lastOut = -1 // frame number output last
  private wanted = -1 // frame number currently requested (frames before it are no longer used)
  private ready = new Map<number, VideoFrame>()
  private waiters = new Map<number, (f: VideoFrame) => void>()
  private lock: Promise<unknown> = Promise.resolve()
  private error: unknown = null
  /** Diagnostic counters: restarts from a keyframe, samples fed, frames output but never used */
  stats = { resets: 0, fed: 0, dropped: 0, outOfOrder: 0, why: {} as Record<string, number> }

  constructor(
    private f: FileReader,
    readonly track: Track
  ) {}

  private config(): VideoDecoderConfig {
    return {
      codec: this.track.codec,
      description: this.track.description ?? undefined,
      codedWidth: this.track.width,
      codedHeight: this.track.height,
      hardwareAcceleration: 'prefer-hardware'
    }
  }

  private reset(at: number): void {
    this.stats.resets++
    this.dec?.close()
    for (const fr of this.ready.values()) fr.close()
    this.ready.clear()
    this.error = null
    this.dec = new VideoDecoder({
      output: (fr) => {
        const i = Math.round(fr.timestamp / FRAME_US)
        if (i < this.lastOut) this.stats.outOfOrder++
        this.lastOut = i
        const w = this.waiters.get(i)
        if (w) {
          this.waiters.delete(i)
          w(fr)
        } else {
          this.ready.set(i, fr)
          // Release frames that are no longer used (before the requested position) early (the hardware decoder buffer would clog).
          // It used to discard frames "2 or more before the output position", but a hardware decoder may output several at once,
          // so when the consumer lags a little (e.g. preparing the shader for the first export) it also discarded frames about to be used,
          // restarts from a keyframe chained, and export became extremely slow (235 ms per frame)
          for (const k of [...this.ready.keys()]) if (k < this.wanted) (this.ready.get(k)!.close(), this.ready.delete(k), this.stats.dropped++)
          // Just in case, release the oldest first if too many pile up
          while (this.ready.size > READY_MAX) {
            const k = Math.min(...this.ready.keys())
            this.ready.get(k)!.close()
            this.ready.delete(k)
            this.stats.dropped++
          }
        }
      },
      error: (e) => {
        this.error = e
      }
    })
    this.dec.configure(this.config())
    this.next = keyframeBefore(this.track, at)
    this.lastOut = this.next - 1
  }

  private async feed(upTo: number): Promise<void> {
    const t = this.track
    while (this.next <= upTo && this.next < t.sizes.length) {
      const i = this.next++
      this.stats.fed++
      const data = await this.f.read(t.offsets[i], t.sizes[i])
      this.dec!.decode(new EncodedVideoChunk({ type: t.keyframes[i] ? 'key' : 'delta', timestamp: i * FRAME_US, data }))
      while (this.dec!.decodeQueueSize > 6) await new Promise((r) => setTimeout(r, 0))
    }
  }

  /**
   * Returns frame i (the caller must close() it).
   * ahead is the number of frames to feed ahead, but piling up decoded frames clogs the hardware decoder
   * output buffer and slows things greatly (measured 115 fps -> 13 fps), so normally leave it at 0.
   */
  get(i: number, ahead = 0): Promise<VideoFrame> {
    const run = async (): Promise<VideoFrame> => {
      this.wanted = i
      const last = this.track.sizes.length - 1
      const have = this.ready.get(i)
      if (have) {
        this.ready.delete(i)
        await this.feed(Math.min(i + ahead, last))
        return have
      }
      // Reachable by continuing: not yet output (not going backwards) and not too far from the feed position
      const reachable = this.dec && !this.error && i > this.lastOut && i - this.next < 60
      if (!reachable) {
        const why = !this.dec ? 'none' : this.error ? `error: ${String(this.error).slice(0, 80)}` : i <= this.lastOut ? `backward(i=${i}, output=${this.lastOut})` : `far(${i - this.next})`
        const key = why.replace(/\d+/g, '#')
        this.stats.why[key] = (this.stats.why[key] ?? 0) + 1
        this.reset(i)
      }
      const box: { fr: VideoFrame | null } = { fr: null }
      this.waiters.set(i, (fr) => (box.fr = fr))
      await this.feed(Math.min(i + ahead, last))
      // A hardware decoder outputs only after buffering a few frames, so keep adding following frames one by one until output appears.
      // (flush() would allow resuming only from a keyframe, so do not use it except at the end)
      const t0 = performance.now()
      while (!box.fr) {
        if (this.error) throw this.error
        if (this.next <= last) {
          if (this.dec!.decodeQueueSize === 0) await this.feed(this.next)
        } else {
          // End: make it flush the rest. After that it must be rebuilt
          await this.dec!.flush()
          this.dec!.close()
          this.dec = null
          if (!box.fr) throw new Error(t('Frame {i} was not decoded', { i }))
          break
        }
        if (!box.fr) await new Promise((r) => setTimeout(r, 2))
        if (performance.now() - t0 > 10000) throw new Error(t('Decoding frame {i} timed out', { i }))
      }
      return box.fr!
    }
    const r = this.lock.then(run, run)
    this.lock = r.catch(() => undefined)
    return r
  }

  close(): void {
    this.dec?.close()
    this.dec = null
    for (const fr of this.ready.values()) fr.close()
    this.ready.clear()
  }
}

/**
 * Decode only the keyframes of several tracks in turn, and call onFrames whenever a set with the same frame number is complete
 * (onFrames may be async. Close the frames afterwards). A keyframe can be decoded alone, so the frames in between are not read.
 * For scanning the whole video roughly (lane detection, car detection, etc.)
 */
export async function decodeKeyframes(
  f: FileReader,
  tracks: Track[],
  indices: number[],
  onFrames: (i: number, frames: VideoFrame[]) => void | Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const got = tracks.map(() => new Map<number, VideoFrame>())
  const complete: number[] = [] // frame numbers for which all tracks are present
  let error: unknown = null
  const decs = tracks.map((track, k) => {
    const d = new VideoDecoder({
      output: (fr) => {
        const i = Math.round(fr.timestamp / FRAME_US)
        got[k].set(i, fr)
        if (got.every((m) => m.has(i))) complete.push(i)
      },
      error: (e) => {
        error = e
      }
    })
    d.configure({ codec: track.codec, description: track.description ?? undefined, codedWidth: track.width, codedHeight: track.height, hardwareAcceleration: 'prefer-hardware' })
    return d
  })
  const drain = async (): Promise<void> => {
    while (complete.length) {
      const i = complete.shift()!
      const frs = got.map((m) => m.get(i)!)
      got.forEach((m) => m.delete(i))
      try {
        await onFrames(i, frs)
      } finally {
        frs.forEach((fr) => fr.close())
      }
    }
  }
  try {
    for (const i of indices) {
      if (error) throw error
      if (signal?.aborted) throw new Error(t('Cancelled'))
      for (let k = 0; k < tracks.length; k++) {
        const tr = tracks[k]
        const data = await f.read(tr.offsets[i], tr.sizes[i])
        decs[k].decode(new EncodedVideoChunk({ type: 'key', timestamp: i * FRAME_US, data }))
      }
      await drain()
      // Do not feed too much (the hardware decoder buffer would clog)
      while (!error && (decs.some((d) => d.decodeQueueSize > 2) || got.some((m) => m.size > 3))) {
        await new Promise((r) => setTimeout(r, 1))
        await drain()
      }
    }
    await Promise.all(decs.map((d) => d.flush()))
    await drain()
    if (error) throw error
  } finally {
    decs.forEach((d) => d.state !== 'closed' && d.close())
    got.forEach((m) => m.forEach((fr) => fr.close()))
  }
}
