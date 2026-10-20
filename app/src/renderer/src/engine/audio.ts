// Audio playback for the preview. Decodes the AAC of the .insv with WebCodecs and plays it with WebAudio, scheduling ahead.
// During playback the video is synchronized to this audio clock (AudioContext).
import type { FileReader, Track } from '../core/mp4'
import { Dynamics, type AudioFx } from '../core/audiofx'

// Always keep this much scheduled ahead. Cutting high sounds and reducing loudness (Dynamics) are applied to the decoded audio,
// so changing the settings changes how it sounds within this time (it used to be 1.0 s)
const AHEAD_SEC = 0.5
const START_DELAY = 0.08 // margin before playback starts (so the first decode is in time)

export class AudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private dec: AudioDecoder | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private timer = 0
  private gen = 0 // incremented at each start to discard stale output
  private fromSec = 0
  private ctxStart = 0 // AudioContext time at which fromSec plays
  private nextSample = 0
  private scheduledUntil = 0 // media time [s]
  private running = false
  private pumping = false
  private muted = false
  stats = { buffers: 0, errors: 0, lastRms: 0 }
  /** Cut high sounds / reduce loudness (null = not applied) */
  private fx: AudioFx | null = null
  private dyn: Dynamics | null = null

  /**
   * @param inGain multiplier for the original loudness (the tidied audio built in the background is stored at FX_BUILD_GAIN times in core/audiofx.ts, so this is its inverse)
   */
  constructor(
    private f: FileReader,
    readonly track: Track,
    private inGain = 1
  ) {}

  /** Settings for cutting high sounds / reducing loudness (null = not applied). Takes effect from the next decoded audio */
  setFx(fx: AudioFx | null): void {
    this.fx = fx
    if (!fx) this.dyn = null
    else if (this.dyn) this.dyn.setFx(fx, this.inGain)
  }

  private config(): AudioDecoderConfig {
    return {
      codec: this.track.codec,
      sampleRate: this.track.sampleRate,
      numberOfChannels: this.track.channels,
      description: this.track.description ?? undefined
    }
  }

  private sampleTime(i: number): number {
    return this.track.cts[i] / this.track.timescale
  }

  /** The AAC frame at media time sec (the one just before) */
  private sampleAt(sec: number): number {
    const t = sec * this.track.timescale
    let lo = 0
    let hi = this.track.cts.length - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (this.track.cts[m] <= t) lo = m
      else hi = m
    }
    return lo
  }

  /** Start playback from media time sec */
  async start(sec: number): Promise<void> {
    this.stop()
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.track.sampleRate, latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.muted ? 0 : 1
      this.gain.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    const gen = ++this.gen
    this.fromSec = sec
    this.ctxStart = this.ctx.currentTime + START_DELAY
    // AAC is reconstructed by overlapping with the previous frame, so feed from 2 frames earlier
    this.nextSample = Math.max(0, this.sampleAt(sec) - 2)
    // Restart the state (lowpass, loudness envelope) from the beginning (the 2 lead-in frames let it settle)
    this.dyn = this.fx ? new Dynamics(this.track.sampleRate, this.fx, this.track.channels, this.inGain) : null
    this.scheduledUntil = sec
    this.running = true
    this.dec = new AudioDecoder({
      output: (d) => this.onOutput(d, gen),
      error: () => {
        this.stats.errors++
      }
    })
    this.dec.configure(this.config())
    await this.pumpDecode(gen)
    this.timer = window.setInterval(() => void this.pumpDecode(gen), 100)
  }

  private async pumpDecode(gen: number): Promise<void> {
    // Serialize, since running in parallel with the timer would reorder the feeding
    if (this.pumping) return
    this.pumping = true
    try {
      const t = this.track
      // Feed until the "time of fed samples" is AHEAD_SEC ahead of the playback position
      while (this.running && gen === this.gen && this.nextSample < t.sizes.length) {
        const pos = this.position() ?? this.fromSec
        if (this.sampleTime(this.nextSample) > pos + AHEAD_SEC) break
        const i = this.nextSample++
        const data = await this.f.read(t.offsets[i], t.sizes[i])
        if (gen !== this.gen || !this.dec || this.dec.state !== 'configured') return
        this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(this.sampleTime(i) * 1e6), data }))
      }
    } finally {
      this.pumping = false
    }
  }

  private onOutput(d: AudioData, gen: number): void {
    try {
      if (gen !== this.gen || !this.ctx || !this.gain) return
      const ctx = this.ctx
      const n = d.numberOfFrames
      const buf = ctx.createBuffer(d.numberOfChannels, n, d.sampleRate)
      let sum = 0
      const chans: Float32Array<ArrayBuffer>[] = []
      for (let ch = 0; ch < d.numberOfChannels; ch++) {
        const arr = new Float32Array(n)
        d.copyTo(arr, { planeIndex: ch, format: 'f32-planar' })
        chans.push(arr)
      }
      if (this.dyn && chans.length === this.dyn.channels) this.dyn.process(chans)
      else if (this.inGain !== 1) for (const arr of chans) for (let k = 0; k < n; k++) arr[k] *= this.inGain
      chans.forEach((arr, ch) => {
        buf.copyToChannel(arr, ch)
        if (ch === 0) for (let k = 0; k < n; k += 8) sum += arr[k] * arr[k]
      })
      this.stats.lastRms = Math.sqrt(sum / (n / 8))
      const ts = d.timestamp / 1e6
      const dur = n / d.sampleRate
      if (ts + dur <= this.fromSec) return // before the start position (lead-in)
      let when = this.ctxStart + (ts - this.fromSec)
      let offset = 0
      // Frames that straddle the start position, or that were late, are played from partway through
      const earliest = Math.max(ctx.currentTime, this.ctxStart)
      if (when < earliest) {
        offset = earliest - when
        when = earliest
      }
      if (offset >= dur) return
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.gain)
      src.onended = () => this.sources.delete(src)
      src.start(when, offset)
      this.sources.add(src)
      this.scheduledUntil = Math.max(this.scheduledUntil, ts + dur)
      this.stats.buffers++
    } finally {
      d.close()
    }
  }

  /** Media time currently being heard [s]. null if not playing */
  position(): number | null {
    if (!this.running || !this.ctx) return null
    const heard = this.ctx.currentTime - (this.ctx.outputLatency || 0)
    return this.fromSec + Math.max(0, heard - this.ctxStart)
  }

  stop(): void {
    this.running = false
    this.pumping = false
    this.gen++
    clearInterval(this.timer)
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* ignore ones not started yet */
      }
    }
    this.sources.clear()
    if (this.dec && this.dec.state !== 'closed') this.dec.close()
    this.dec = null
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.gain) this.gain.gain.value = m ? 0 : 1
  }

  dispose(): void {
    this.stop()
    void this.ctx?.close()
    this.ctx = null
  }
}
