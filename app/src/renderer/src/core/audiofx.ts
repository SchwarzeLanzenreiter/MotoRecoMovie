// 走行中の音の処理（docs/app.md「音声」）。
//
// Insta360 のマイクは、エンジン全開や風で音が割れ、雨・水しぶき・風切りの「サー」という広い帯域の雑音が乗る。
// エンジンの音は回転数の倍音（周波数の上で等間隔に並ぶ細い線）で、雑音は周波数の上で平らに広がっている。そこで:
//   1. 音割れの補修（ffmpeg の adeclip。振幅の上限に張り付いた所を前後から推定して戻す）
//   2. 倍音を残して雑音を抑える（このファイル）: 4096 点（85ms）の短時間フーリエ変換で、周波数方向の「床」
//      （±8 ビン ≈ ±94Hz の中で、細い山を削った値）より突き出た所（倍音）は残し、床の高さの所（雑音）は noiseDb だけ下げる。
//      エンジンの基音のあたり（200Hz 以下）は下げない（低い回転では倍音の間隔がビンの幅より狭く、線に見えないので）
//   3. 高い音を切る・音圧を下げる（このファイルの Dynamics。再生しながらかけるので、設定はすぐに聞こえる。書き出しも同じ処理）
// ffmpeg の afftdn（雑音の床を追いかけて下げる）も試したが、雨の日の X5 の動画ではエンジンの倍音まで消えた

export const AFX_N = 4096
export const AFX_HOP = 1024
const FLOOR_HALF = 8 // 床を求める幅（±ビン）
const LOW_KEEP_HZ = 200 // これ以下は下げない
const LOW_FULL_HZ = 400 // ここから全部効かせる
const T_NOISE = 1.2 // 床の 1.2 倍以下は雑音
const T_TONE = 2.5 // 床の 2.5 倍以上は倍音

/** 長さ n（2 のべき）の複素 FFT（その場で。inverse で逆変換、1/n はかけない） */
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
 * 倍音を残して雑音を抑える。x はモノラルの音（fs [Hz]）。区間の前後に余白（margin サンプル）を含めて渡すと、
 * 余白を除いた [margin, x.length − margin) の結果を返す（長い音を区切って処理するため。余白は AFX_N + 6·AFX_HOP 以上、
 * 区切りの位置は AFX_HOP の倍数にする。そうでないとフレームの位置が区切りの前後でずれ、つなぎ目でわずかに音が変わる）
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
  // 各フレームのスペクトル（複素）と大きさ
  const fft = new Fft(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const SR = new Float32Array(nfr * B)
  const SI = new Float32Array(nfr * B)
  const M = new Float32Array(nfr * B)
  // 実数のフレームを 2 つずつ 1 回の複素 FFT で（a を実部、b を虚部に入れて、あとで分ける）
  for (let f = 0; f < nfr; f += 2) {
    const g = f + 1 < nfr ? f + 1 : -1
    for (let i = 0; i < N; i++) {
      re[i] = x[f * H + i] * win[i]
      im[i] = g >= 0 ? x[g * H + i] * win[i] : 0
    }
    fft.run(re, im)
    for (let k = 0; k < B; k++) {
      const k2 = (N - k) % N
      // A = (Z[k] + conj(Z[N−k])) / 2、Bv = (Z[k] − conj(Z[N−k])) / 2i
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
  // 周波数方向の床: ±FLOOR_HALF ビンの、大きさの対数の平均（幾何平均）。雑音（レイリー分布）では中央値 ≈ 幾何平均 × 1.11。
  // 細い山（倍音）は対数で平均するのでほとんど床を持ち上げない。時間方向に 5 フレームならす
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
  // ゆらぎ（ミュージカルノイズ）を減らす: 時間方向に 3 フレームの最大値を取ってから 3 フレームでならす
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
  // 逆変換して重ね合わせる（2 フレームずつ: 実数の結果 a + i·b）
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
      // Z = A + i·B（エルミート対称の 2 つを 1 つの複素スペクトルに）
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

/** 音の処理の設定 */
export interface AudioFx {
  /** 処理する（false = 動画の音をそのまま） */
  on: boolean
  /** 音割れを補修する */
  declip: boolean
  /** エンジン音以外（広い帯域の雑音）を下げる量 [dB]（0 = 下げない） */
  noiseDb: number
  /** 音圧を抑えるしきい値 [dBFS]（これより大きい所を 1/3 に圧縮） */
  compThresholdDb: number
  /**
   * 排気音より高い音を切るローパスの周波数 [Hz]（0 = 切らない）。巡航で排気音が小さいとき、2〜8kHz の「サー」という雑音
   * （風切り・ロードノイズ）が目立つ。排気音（倍音）は 120〜500Hz に集まり、見えるのは 1.5kHz まで（0919 の 13:49）
   */
  lowpassHz?: number
}

export const DEFAULT_AUDIO_FX: AudioFx = { on: true, declip: true, noiseDb: 12, compThresholdDb: -20, lowpassHz: 2000 }

/** ffmpeg の、音圧を抑えるフィルター（コンプレッサー → 元の大きさの近くへ戻す → ピークを −1dBFS に） */
/** 以前の既定値（1500Hz）。聞き比べて 2000Hz に変えた（2026-10-20）。以前の版で保存した編集内容の 1500Hz は 2000Hz にする */
export const OLD_DEFAULT_LOWPASS_HZ = 1500

/** 裏で作る音声（音割れの補修・エンジン音以外を抑える）の大きさ。音割れの補修で 1 を超えることがあり、AAC にする前に下げておく。鳴らすときに戻す */
export const FX_BUILD_GAIN = 0.5

/** 裏で作る音声を決める設定だけの鍵（高い音を切る・音圧はリアルタイムにかけるので含めない） */
export function audioFxKey(fx: AudioFx): string {
  return [fx.declip ? 1 : 0, fx.noiseDb].join('_')
}

/**
 * 高い音を切る・音圧を抑える（リアルタイム。プレビューで再生しながら、書き出しでは区間を順に）。状態を持つので、音を時間の順に渡す。
 *   1. 高い音を切る: 2 次のバターワースのローパスを 2 段（4 次、遮断周波数で −6dB、その 2 倍で −24dB）
 *   2. 音圧を抑える: RMS（50ms）がしきい値を超えた分を 1/3 に（アタック 10ms・リリース 250ms）、下げた分の 4 割ほどを戻す
 *   3. リミッター: 5ms 先読みで、ピークを −1dBFS に（リリース 60ms）。最後に ±1 で切る
 * 設定は setFx で途中から変えられる（次に渡した音から効く）
 */
export class Dynamics {
  private fx: AudioFx
  private b = [0, 0, 0, 0, 0] // ローパスの係数 b0 b1 b2 a1 a2
  private z: Float64Array // チャンネルごと・2 段ぶんの状態（各 2）
  private env = 0 // RMS の 2 乗
  private grDb = 0 // 今のゲインの減り [dB]
  private lim = 1 // リミッターのゲイン
  private delay: Float32Array[] // 先読みのための遅延（チャンネルごと）
  private dpos = 0
  // リミッター: 必要なゲインの、直近 la+1 サンプルの最小値（単調な列で）と、その la サンプルの平均
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

  /** 設定を変える（高い音を切る周波数・しきい値） */
  setFx(fx: AudioFx, inGain = this.inGain): void {
    this.fx = fx
    this.inGain = inGain
    const f0 = fx.lowpassHz ?? 0
    if (f0 > 0 && f0 < this.fs / 2) {
      // RBJ のクックブック（Q = 1/√2）
      const w = (2 * Math.PI * f0) / this.fs
      const al = Math.sin(w) / (2 * Math.SQRT1_2)
      const c = Math.cos(w)
      const a0 = 1 + al
      this.b = [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0]
    }
  }

  /** チャンネルごとの音（同じ長さ）をその場で処理する */
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
      // 1. ローパス（転置直接形 II）
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
      // 2. コンプレッサー（左右の平均で RMS）
      const m = msum / C
      this.env = this.aEnv * this.env + (1 - this.aEnv) * m * m
      const lv = 10 * Math.log10(this.env + 1e-12)
      const tgt = -Math.max(0, lv - th) * (1 - 1 / 3)
      const a = tgt < this.grDb ? this.aAtt : this.aRel
      this.grDb = a * this.grDb + (1 - a) * tgt
      const g = 10 ** ((this.grDb + makeupDb) / 20)
      // 3. リミッター（先読み la サンプル）: 必要なゲインの直近 la+1 サンプルの最小値を、さらに la サンプルで平均すると、
      //    la 遅らせた音のどのサンプルでも必要なゲイン以下になる（ピークを必ず抑え、下げ方はなめらか）。戻すのはゆっくり（60ms）
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

  /** 先読みのぶん（la サンプル）遅れて出る。書き出しで頭をそろえるのに使う */
  get latency(): number {
    return this.la
  }
}
