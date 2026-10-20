// Audio processing while riding (docs/app.md "Audio").
//
// The Insta360 microphone clips at full engine throttle or in wind, and picks up broadband noise (rain, spray, wind noise) that sounds like a steady "hiss".
// Engine sound is harmonics of the rotation speed (thin lines evenly spaced along frequency), while noise is spread flat along frequency. So:
//   1. Declip (ffmpeg adeclip. Places stuck at the amplitude limit are estimated from their surroundings and restored)
//   2. Suppress noise while keeping harmonics (this file): with a 4096-point (85 ms) short-time Fourier transform, keep the places that stick out above the "floor" along frequency
//      (the value within ±8 bins ≈ ±94 Hz with the thin peaks removed) (harmonics), and lower the places at the floor level (noise) by noiseDb.
//      Around the engine fundamental (200 Hz and below) is not lowered (at low rpm the harmonic spacing is narrower than the bin width, so they do not look like lines)
//   3. Cut the high frequencies and reduce the sound pressure (Dynamics in this file. It is applied during playback, so settings can be heard immediately. Export uses the same processing)
// I also tried ffmpeg's afftdn (tracks and lowers the noise floor), but on a rainy-day X5 video it removed even the engine harmonics

export const AFX_N = 4096
export const AFX_HOP = 1024
const FLOOR_HALF = 8 // width for finding the floor (±bins)
const LOW_KEEP_HZ = 200 // not lowered below this
const LOW_FULL_HZ = 400 // fully effective from here
const T_NOISE = 1.2 // at or below 1.2 times the floor is noise
const T_TONE = 2.5 // at or above 2.5 times the floor is a harmonic

/** Complex FFT of length n (a power of 2) (in place. inverse does the inverse transform, without the 1/n factor) */
export class Fft {
  private cos: Float64Array
  private sin: Float64Array
  private rev: Uint32Array
  constructor(readonly n: number) {
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = Math.sin((2 * Math.PI * i) / n)
    }
    this.rev = new Uint32Array(n)
    const bits = Math.log2(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
  }
  run(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.n
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    const sg = inverse ? 1 : -1
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]
          const si = sg * this.sin[k * step]
          const a = s + k
          const b = a + half
          const xr = re[b] * c - im[b] * si
          const xi = re[b] * si + im[b] * c
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}

/**
 * Suppress noise while keeping harmonics. x is mono audio (fs [Hz]). Pass it with margins (margin samples) before and after the segment, and
 * the result excluding the margins, [margin, x.length - margin), is returned (so that long audio can be processed in chunks. The margin must be at least AFX_N + 6·AFX_HOP,
 * and chunk boundaries must be multiples of AFX_HOP. Otherwise the frame positions shift across the boundary and the sound changes slightly at the seam)
 */
export function suppressNoise(x: Float32Array, fs: number, noiseDb: number, margin = 0): Float32Array {
  const N = AFX_N
  const H = AFX_HOP
  const B = N / 2 + 1
  const out = new Float32Array(x.length)
  if (noiseDb <= 0) {
    out.set(x)
    return out.subarray(margin, x.length - margin)
  }
  const win = new Float64Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  const nfr = Math.max(0, Math.floor((x.length - N) / H) + 1)
  // Spectrum (complex) and magnitude of each frame
  const fft = new Fft(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const SR = new Float32Array(nfr * B)
  const SI = new Float32Array(nfr * B)
  const M = new Float32Array(nfr * B)
  // Two real frames at a time with one complex FFT (put a in the real part and b in the imaginary part, and separate them afterwards)
  for (let f = 0; f < nfr; f += 2) {
    const g = f + 1 < nfr ? f + 1 : -1
    for (let i = 0; i < N; i++) {
      re[i] = x[f * H + i] * win[i]
      im[i] = g >= 0 ? x[g * H + i] * win[i] : 0
    }
    fft.run(re, im)
    for (let k = 0; k < B; k++) {
      const k2 = (N - k) % N
      // A = (Z[k] + conj(Z[N−k])) / 2, Bv = (Z[k] − conj(Z[N−k])) / 2i
      const ar = (re[k] + re[k2]) / 2
      const ai = (im[k] - im[k2]) / 2
      const br = (im[k] + im[k2]) / 2
      const bi = -(re[k] - re[k2]) / 2
      SR[f * B + k] = ar
      SI[f * B + k] = ai
      M[f * B + k] = Math.hypot(ar, ai) + 1e-9
      if (g >= 0) {
        SR[g * B + k] = br
        SI[g * B + k] = bi
        M[g * B + k] = Math.hypot(br, bi) + 1e-9
      }
    }
  }
  // Floor along frequency: the mean (geometric mean) of the log magnitude within ±FLOOR_HALF bins. For noise (Rayleigh distribution), median ≈ geometric mean × 1.11.
  // Thin peaks (harmonics) barely raise the floor because the log is averaged. Smooth over 5 frames in time
  const floor0 = new Float32Array(nfr * B)
  const cum = new Float64Array(B + 1)
  for (let f = 0; f < nfr; f++) {
    for (let k = 0; k < B; k++) cum[k + 1] = cum[k] + Math.log(M[f * B + k])
    for (let k = 0; k < B; k++) {
      const a0 = Math.max(0, k - FLOOR_HALF)
      const a1 = Math.min(B, k + FLOOR_HALF + 1)
      floor0[f * B + k] = Math.exp((cum[a1] - cum[a0]) / (a1 - a0)) * 1.11
    }
  }
  const gmin = 10 ** (-noiseDb / 20)
  const G = new Float32Array(nfr * B)
  for (let f = 0; f < nfr; f++) {
    for (let k = 0; k < B; k++) {
      let fl = 0
      let c = 0
      for (let d = -2; d <= 2; d++) {
        const ff = f + d
        if (ff < 0 || ff >= nfr) continue
        fl += floor0[ff * B + k]
        c++
      }
      fl /= c
      const T = M[f * B + k] / (fl + 1e-9)
      const g = Math.min(1, Math.max(0, (T - T_NOISE) / (T_TONE - T_NOISE)))
      let gain = gmin + (1 - gmin) * g
      const hz = (k * fs) / N
      const w = Math.min(1, Math.max(0, (hz - LOW_KEEP_HZ) / (LOW_FULL_HZ - LOW_KEEP_HZ)))
      gain = 1 - (1 - gain) * w
      G[f * B + k] = gain
    }
  }
  // Reduce fluctuation (musical noise): take the maximum over 3 frames in time, then smooth over 3 frames
  const G2 = new Float32Array(nfr * B)
  for (let f = 0; f < nfr; f++)
    for (let k = 0; k < B; k++) {
      let m = 0
      for (let d = -1; d <= 1; d++) {
        const ff = Math.min(nfr - 1, Math.max(0, f + d))
        if (G[ff * B + k] > m) m = G[ff * B + k]
      }
      G2[f * B + k] = m
    }
  for (let f = 0; f < nfr; f++)
    for (let k = 0; k < B; k++) {
      let s = 0
      for (let d = -1; d <= 1; d++) s += G2[Math.min(nfr - 1, Math.max(0, f + d)) * B + k]
      G[f * B + k] = s / 3
    }
  // Inverse transform and overlap-add (two frames at a time: real result a + i·b)
  const acc = new Float64Array(x.length)
  const norm = new Float64Array(x.length)
  for (let f = 0; f < nfr; f += 2) {
    const g = f + 1 < nfr ? f + 1 : -1
    re.fill(0)
    im.fill(0)
    for (let k = 0; k < B; k++) {
      const ga = G[f * B + k]
      const ar = SR[f * B + k] * ga
      const ai = SI[f * B + k] * ga
      let br = 0
      let bi = 0
      if (g >= 0) {
        const gb = G[g * B + k]
        br = SR[g * B + k] * gb
        bi = SI[g * B + k] * gb
      }
      // Z = A + i·B (two Hermitian-symmetric spectra into one complex spectrum)
      re[k] = ar - bi
      im[k] = ai + br
      if (k > 0 && k < N / 2) {
        re[N - k] = ar + bi
        im[N - k] = -ai + br
      }
    }
    fft.run(re, im, true)
    for (let i = 0; i < N; i++) {
      const p = f * H + i
      acc[p] += (re[i] / N) * win[i]
      norm[p] += win[i] * win[i]
      if (g >= 0) {
        const q = g * H + i
        acc[q] += (im[i] / N) * win[i]
        norm[q] += win[i] * win[i]
      }
    }
  }
  for (let i = 0; i < x.length; i++) out[i] = norm[i] > 1e-3 ? acc[i] / norm[i] : x[i]
  return out.subarray(margin, x.length - margin)
}

/** Audio processing settings */
export interface AudioFx {
  /** Process (false = the video's audio as is) */
  on: boolean
  /** Declip */
  declip: boolean
  /** Amount to lower sound other than the engine (broadband noise) [dB] (0 = do not lower) */
  noiseDb: number
  /** Threshold for reducing the sound pressure [dBFS] (anything louder is compressed to 1/3) */
  compThresholdDb: number
  /**
   * Lowpass frequency to cut sound higher than the exhaust note [Hz] (0 = do not cut). When the exhaust is quiet while cruising, the 2-8 kHz "hiss"
   * (wind noise, road noise) stands out. The exhaust note (harmonics) is concentrated at 120-500 Hz, and what is visible goes up to 1.5 kHz (0919 at 13:49)
   */
  lowpassHz?: number
}

export const DEFAULT_AUDIO_FX: AudioFx = { on: true, declip: true, noiseDb: 12, compThresholdDb: -20, lowpassHz: 2000 }

/** ffmpeg filter that reduces the sound pressure (compressor → bring back near the original level → peak to -1 dBFS) */
/** The previous default (1500 Hz). Changed to 2000 Hz after A/B listening (2026-10-20). A 1500 Hz in edits saved by an older version becomes 2000 Hz */
export const OLD_DEFAULT_LOWPASS_HZ = 1500

/** Size of the background-made audio (declip, suppress non-engine sound). Declipping can exceed 1, so it is lowered before AAC. Restored on playback */
export const FX_BUILD_GAIN = 0.5

/** Key of only the settings that determine the background-made audio (cutting highs and sound pressure are applied in real time, so they are not included) */
export function audioFxKey(fx: AudioFx): string {
  return [fx.declip ? 1 : 0, fx.noiseDb].join('_')
}

/**
 * Cut the highs and reduce the sound pressure (real time. During preview playback; in export, segment by segment in order). It holds state, so feed audio in time order.
 *   1. Cut highs: a 2nd-order Butterworth lowpass, 2 stages (4th order, -6 dB at the cutoff frequency, -24 dB at twice that)
 *   2. Reduce sound pressure: the part where the RMS (50 ms) exceeds the threshold goes to 1/3 (attack 10 ms, release 250 ms), and about 40% of the reduction is restored
 *   3. Limiter: peak to -1 dBFS with 5 ms lookahead (release 60 ms). Finally clip at ±1
 * Settings can be changed midway with setFx (they take effect from the next audio passed)
 */
export class Dynamics {
  private fx: AudioFx
  private b = [0, 0, 0, 0, 0] // lowpass coefficients b0 b1 b2 a1 a2
  private z: Float64Array // state per channel and per stage (2 each)
  private env = 0 // RMS squared
  private grDb = 0 // current gain reduction [dB]
  private lim = 1 // limiter gain
  private delay: Float32Array[] // delay for lookahead (per channel)
  private dpos = 0
  // Limiter: the minimum of the required gain over the most recent la+1 samples (as a monotonic sequence), and its mean over la samples
  private dq: Float64Array
  private dqIdx: Float64Array
  private dqHead = 0
  private dqLen = 0
  private boxBuf: Float64Array
  private boxSum = 0
  private sampleNo = 0
  private readonly la: number
  private readonly aEnv: number
  private readonly aAtt: number
  private readonly aRel: number
  private readonly aLimRel: number

  constructor(readonly fs: number, fx: AudioFx, readonly channels: number, private inGain = 1) {
    this.fx = fx
    this.z = new Float64Array(channels * 4)
    this.la = Math.round(0.005 * fs)
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.la))
    this.dq = new Float64Array(this.la + 2)
    this.dqIdx = new Float64Array(this.la + 2)
    this.boxBuf = new Float64Array(this.la).fill(1)
    this.boxSum = this.la
    this.aEnv = Math.exp(-1 / (0.05 * fs))
    this.aAtt = Math.exp(-1 / (0.01 * fs))
    this.aRel = Math.exp(-1 / (0.25 * fs))
    this.aLimRel = Math.exp(-1 / (0.06 * fs))
    this.setFx(fx)
  }

  /** Change the settings (lowpass frequency to cut highs, threshold) */
  setFx(fx: AudioFx, inGain = this.inGain): void {
    this.fx = fx
    this.inGain = inGain
    const f0 = fx.lowpassHz ?? 0
    if (f0 > 0 && f0 < this.fs / 2) {
      // RBJ cookbook (Q = 1/√2)
      const w = (2 * Math.PI * f0) / this.fs
      const al = Math.sin(w) / (2 * Math.SQRT1_2)
      const c = Math.cos(w)
      const a0 = 1 + al
      this.b = [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0]
    }
  }

  /** Process each channel's audio (same length) in place */
  process(ch: Float32Array[]): void {
    const n = ch[0].length
    const C = this.channels
    const fx = this.fx
    const lp = (fx.lowpassHz ?? 0) > 0
    const [b0, b1, b2, a1, a2] = this.b
    const th = fx.compThresholdDb
    const makeupDb = Math.max(0, -th * (2 / 3) * 0.4)
    const LIMIT = 0.891
    const z = this.z
    for (let i = 0; i < n; i++) {
      // 1. Lowpass (transposed direct form II)
      let msum = 0
      for (let c = 0; c < C; c++) {
        let x = ch[c][i] * this.inGain
        if (lp) {
          for (let st = 0; st < 2; st++) {
            const k = c * 4 + st * 2
            const y = b0 * x + z[k]
            z[k] = b1 * x - a1 * y + z[k + 1]
            z[k + 1] = b2 * x - a2 * y
            x = y
          }
        }
        ch[c][i] = x
        msum += x
      }
      // 2. Compressor (RMS of the left-right mean)
      const m = msum / C
      this.env = this.aEnv * this.env + (1 - this.aEnv) * m * m
      const lv = 10 * Math.log10(this.env + 1e-12)
      const tgt = -Math.max(0, lv - th) * (1 - 1 / 3)
      const a = tgt < this.grDb ? this.aAtt : this.aRel
      this.grDb = a * this.grDb + (1 - a) * tgt
      const g = 10 ** ((this.grDb + makeupDb) / 20)
      // 3. Limiter (lookahead la samples): taking the minimum of the required gain over the most recent la+1 samples, then averaging it over la samples,
      //    gives a gain at or below the required gain at every sample of the audio delayed by la (the peak is always held down, and the reduction is smooth). Recovery is slow (60 ms)
      let pk = 0
      for (let c = 0; c < C; c++) pk = Math.max(pk, Math.abs(ch[c][i] * g))
      const req = pk > LIMIT ? LIMIT / pk : 1
      const L = this.la
      const cap = L + 2
      const no = this.sampleNo++
      while (this.dqLen > 0 && this.dq[(this.dqHead + this.dqLen - 1) % cap] >= req) this.dqLen--
      this.dq[(this.dqHead + this.dqLen) % cap] = req
      this.dqIdx[(this.dqHead + this.dqLen) % cap] = no
      this.dqLen++
      while (this.dqIdx[this.dqHead] < no - L) {
        this.dqHead = (this.dqHead + 1) % cap
        this.dqLen--
      }
      const mn = this.dq[this.dqHead]
      const bi = no % L
      this.boxSum += mn - this.boxBuf[bi]
      this.boxBuf[bi] = mn
      const box = this.boxSum / L
      this.lim = box < this.lim ? box : this.lim + (box - this.lim) * (1 - this.aLimRel)
      for (let c = 0; c < C; c++) {
        const d = this.delay[c]
        const out = d[this.dpos]
        d[this.dpos] = ch[c][i] * g
        const y = out * this.lim
        ch[c][i] = y > 1 ? 1 : y < -1 ? -1 : y
      }
      this.dpos = (this.dpos + 1) % this.la
    }
  }

  /** Output is delayed by the lookahead amount (la samples). Used to align the start in export */
  get latency(): number {
    return this.la
  }
}
