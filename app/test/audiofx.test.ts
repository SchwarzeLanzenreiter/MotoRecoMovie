// 走行中の音を整える処理（core/audiofx.ts）の確かめ: 合成した音（エンジンのような倍音 + 広い帯域の雑音）で
import assert from 'node:assert/strict'
import { AFX_HOP, AFX_N, Dynamics, Fft, suppressNoise, DEFAULT_AUDIO_FX, audioFxKey } from '../src/renderer/src/core/audiofx'

// FFT: 逆変換で戻る
{
  const f = new Fft(16)
  const re = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i) + i * 0.1)
  const im = new Float64Array(16)
  const r0 = re.slice()
  f.run(re, im)
  f.run(re, im, true)
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(re[i] / 16 - r0[i]) < 1e-9 && Math.abs(im[i] / 16) < 1e-9)
}

const fs = 48000
const n = fs * 6
let seed = 7
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
// 倍音: 基音 60Hz の 2〜40 倍（120〜2400Hz）。雑音: 白色雑音
const tone = new Float32Array(n)
const noise = new Float32Array(n)
for (let i = 0; i < n; i++) {
  let s = 0
  for (let h = 2; h <= 40; h++) s += Math.sin((2 * Math.PI * 60 * h * i) / fs + h) / h
  tone[i] = 0.3 * s
  noise[i] = 0.05 * rnd()
}
const x = tone.map((v, i) => v + noise[i])

// 周波数の帯ごとのエネルギー（倍音の所と、その間）
function bandEnergy(y: Float32Array, onHarm: boolean): number {
  const N = 8192
  const f = new Fft(N)
  let e = 0
  for (let s = fs; s + N < y.length - fs; s += N) {
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = y[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
    f.run(re, im)
    for (let k = 0; k < N / 2; k++) {
      const hz = (k * fs) / N
      if (hz < 600 || hz > 2400) continue
      const d = Math.abs(hz / 60 - Math.round(hz / 60)) * 60 // 最も近い倍音からの距離 [Hz]
      if (onHarm ? d < 4 : d > 15 && d < 45) e += re[k] ** 2 + im[k] ** 2
    }
  }
  return e
}
const y = suppressNoise(x, fs, 12)
const db = (a: number, b: number): number => 10 * Math.log10(a / b)
const harm = db(bandEnergy(y, true), bandEnergy(x, true))
const gap = db(bandEnergy(y, false), bandEnergy(x, false))
console.log(`倍音の所 ${harm.toFixed(1)} dB、倍音の間（雑音）${gap.toFixed(1)} dB`)
assert.ok(harm > -2, `倍音は残す: ${harm.toFixed(1)} dB`)
assert.ok(gap < -6, `雑音は下げる: ${gap.toFixed(1)} dB`)
// 0 dB なら何もしない
assert.deepEqual(Array.from(suppressNoise(x, fs, 0).subarray(1000, 1010)), Array.from(x.subarray(1000, 1010)))

// 区切って処理しても、まとめて処理したのと同じ（余白の付け方）
{
  const margin = AFX_N + 8 * AFX_HOP
  const chunk = Math.round((fs * 2) / AFX_HOP) * AFX_HOP // ずらし幅の倍数（engine/audiofx.ts と同じ）
  const z = new Float32Array(n)
  for (let p = 0; p < n; p += chunk) {
    const a = Math.max(0, p - margin)
    const b = Math.min(n, p + chunk + margin)
    const seg = new Float32Array(Math.min(chunk, n - p) + 2 * margin)
    seg.set(x.subarray(a, b), margin - (p - a))
    z.set(suppressNoise(seg, fs, 12, margin), p)
  }
  const whole = suppressNoise(new Float32Array([...new Float32Array(margin), ...x, ...new Float32Array(margin)]), fs, 12, margin)
  let maxd = 0
  for (let i = 0; i < n; i++) maxd = Math.max(maxd, Math.abs(z[i] - whole[i]))
  console.log(`区切った処理とまとめた処理の差の最大 ${maxd.toExponential(2)}`)
  assert.ok(maxd < 1e-4)
}

// 高い音を切る・音圧を抑える（Dynamics）
{
  const rms = (a: Float32Array, from = 0): number => Math.sqrt(a.subarray(from).reduce((q, v) => q + v * v, 0) / (a.length - from))
  const sine = (hz: number, amp: number, len = fs): Float32Array => Float32Array.from({ length: len }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / fs))
  // ローパス 2000Hz: 500Hz はほぼそのまま、4000Hz は −24dB 前後（音圧は抑えない設定で）
  const quiet = { ...DEFAULT_AUDIO_FX, compThresholdDb: 0 }
  const pass = (hz: number): number => {
    const x = sine(hz, 0.1)
    const d = new Dynamics(fs, quiet, 1)
    const y = x.slice()
    d.process([y])
    return 20 * Math.log10(rms(y, fs / 2) / rms(x, fs / 2))
  }
  const p500 = pass(500)
  const p4k = pass(4000)
  console.log(`ローパス 2000Hz: 500Hz ${p500.toFixed(1)} dB、4000Hz ${p4k.toFixed(1)} dB`)
  assert.ok(Math.abs(p500) < 0.5 && p4k < -20 && p4k > -28)
  // 音圧: −20dBFS より大きい音は抑え、ピークは −1dBFS（0.891）あたりまで
  const loud = sine(200, 0.95, fs * 2)
  const d = new Dynamics(fs, DEFAULT_AUDIO_FX, 1)
  const y = loud.slice()
  d.process([y])
  const pk = Math.max(...y.subarray(fs).map(Math.abs))
  const gain = 20 * Math.log10(rms(y, fs) / rms(loud, fs))
  console.log(`大きい音（−0.4dBFS）: ${gain.toFixed(1)} dB、ピーク ${pk.toFixed(3)}`)
  assert.ok(gain < -4 && pk <= 0.95) // RMS −3.4dBFS → しきい値を 16.6dB 超え → 11dB 下げて 5.3dB 戻す ≈ −5.7dB
  // 区切って渡しても、まとめて渡したのと同じ（状態を引き継ぐ）
  const x = Float32Array.from({ length: fs }, (_, i) => 0.6 * Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.9))
  const a1 = x.slice()
  new Dynamics(fs, DEFAULT_AUDIO_FX, 1).process([a1])
  const a2 = x.slice()
  const dd = new Dynamics(fs, DEFAULT_AUDIO_FX, 1)
  for (let p = 0; p < fs; p += 1024) dd.process([a2.subarray(p, Math.min(fs, p + 1024))])
  assert.deepEqual(Array.from(a1.subarray(4000, 4010)), Array.from(a2.subarray(4000, 4010)))
  // 裏で作る音声の鍵は、高い音を切る・音圧を含めない（変えても作り直さない）
  assert.equal(audioFxKey(DEFAULT_AUDIO_FX), audioFxKey({ ...DEFAULT_AUDIO_FX, lowpassHz: 3000, compThresholdDb: -10 }))
}
console.log('audiofx.test: OK')
