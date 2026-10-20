// プレビューの音声再生。.insv の AAC を WebCodecs でデコードし、WebAudio で先読みしながら鳴らす。
// 再生中はこの音声の時計（AudioContext）を基準に映像を合わせる。
import type { FileReader, Track } from '../core/mp4'
import { Dynamics, type AudioFx } from '../core/audiofx'

// これだけ先まで常にスケジュールしておく。高い音を切る・音圧を抑える（Dynamics）はデコードした音にかけるので、
// 設定を変えるとこの時間のうちに聞こえ方が変わる（以前は 1.0 秒）
const AHEAD_SEC = 0.5
const START_DELAY = 0.08 // 再生開始までの余裕（最初のデコードが間に合うように）

export class AudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private dec: AudioDecoder | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private timer = 0
  private gen = 0 // 開始ごとに増やし、古い出力を捨てる
  private fromSec = 0
  private ctxStart = 0 // fromSec が鳴る AudioContext の時刻
  private nextSample = 0
  private scheduledUntil = 0 // メディア時刻 [s]
  private running = false
  private pumping = false
  private muted = false
  stats = { buffers: 0, errors: 0, lastRms: 0 }
  /** 高い音を切る・音圧を抑える（null = かけない） */
  private fx: AudioFx | null = null
  private dyn: Dynamics | null = null

  /**
   * @param inGain 音の元の大きさの倍率（裏で作った整えた音声は core/audiofx.ts の FX_BUILD_GAIN 倍で保存してあるので、その逆数）
   */
  constructor(
    private f: FileReader,
    readonly track: Track,
    private inGain = 1
  ) {}

  /** 高い音を切る・音圧を抑える設定（null = かけない）。次にデコードした音から効く */
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

  /** メディア時刻 sec の位置にある AAC フレーム（直前） */
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

  /** メディア時刻 sec から再生を始める */
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
    // AAC は前のフレームと重ね合わせて復元するので、2フレーム前から流し込む
    this.nextSample = Math.max(0, this.sampleAt(sec) - 2)
    // 状態（ローパス・音圧の包絡）は始めからやり直す（流し込み用の 2 フレームで落ち着く）
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
    // タイマーと重なって並行に走ると投入順が入れ替わるので排他する
    if (this.pumping) return
    this.pumping = true
    try {
      const t = this.track
      // 「投入済みサンプルの時刻」が再生位置より AHEAD_SEC 先になるまで流し込む
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
      if (ts + dur <= this.fromSec) return // 開始位置より前（流し込み用）
      let when = this.ctxStart + (ts - this.fromSec)
      let offset = 0
      // 開始位置をまたぐフレーム、または間に合わなかったフレームは途中から鳴らす
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

  /** 今聞こえているメディア時刻 [s]。再生していなければ null */
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
        /* 未開始のものは無視 */
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
