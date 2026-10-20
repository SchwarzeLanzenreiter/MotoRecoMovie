// 車体挙動の乱れの検出: スリップ率の異常、6 軸（角速度・加速度）の乱れ、サスペンションのストロークの急な動きから、
// 時刻ごとの「乱れの強さ」（score）を作り、しきい値を超えた区間を事象として取り出す。
//
// 指標（100Hz の統一テレメトリーから）
//   slip     : スリップ率の急な変化（σ=1 秒の平滑からのずれ）と、走行全体の中央値からの大きなずれ（空転・ロック）
//   roll/yaw : 車両の角速度の 1.5〜12Hz 成分の実効値（0.4 秒）… ふらつき・振られ・ウォブル
//   x/y/zG   : 加速度の 1.5〜12Hz 成分の実効値（0.4 秒）… ログでは強く平滑化されているので補助
//   fr/rrSus : ストロークの速さ（15Hz で平滑して微分）の実効値（0.3 秒）… 大きな突き上げ・抜け・底付き
// それぞれを「その走行での 99.5 パーセンタイル」と「下限（静かな走行で事象が出すぎないための絶対値）」の大きい方で割り、
// いちばん大きいものをその時刻の強さにする。1.0 がその走行の上位 0.5% 相当。
import { fastGaussian, lowpassFiltfilt } from './dsp'
import type { Telemetry } from './telemetry'

export type DisturbCause = 'slip' | 'roll' | 'yaw' | 'xG' | 'yG' | 'zG' | 'frSus' | 'rrSus'
export const CAUSES: DisturbCause[] = ['slip', 'roll', 'yaw', 'xG', 'yG', 'zG', 'frSus', 'rrSus']

export const CAUSE_NAMES: Record<DisturbCause, string> = {
  slip: 'スリップ率', // i18n-ignore
  roll: 'ロール角速度', // i18n-ignore
  yaw: 'ヨー角速度', // i18n-ignore
  xG: '前後G', // i18n-ignore
  yG: '横G', // i18n-ignore
  zG: '上下G', // i18n-ignore
  frSus: 'フロントサス', // i18n-ignore
  rrSus: 'リアサス' // i18n-ignore
}

/** 指標の下限（このサンプルの走行の 99.5 パーセンタイル程度）。単位は各指標のもの */
const FLOOR: Record<DisturbCause, number> = { slip: 1.5, roll: 3.5, yaw: 2.0, xG: 0.008, yG: 0.003, zG: 0.025, frSus: 350, rrSus: 450 }
/** スリップ率の、走行全体の中央値からのずれの下限 [%]（これ以上の持続的な空転・ロックも乱れとみなす） */
const SLIP_ABS_FLOOR = 6

export interface DisturbTrack {
  rate: number
  /** 乱れの強さ（1.0 = その走行の上位 0.5% 相当）。走行していない時間は 0 */
  score: Float32Array
  /** その時刻にいちばん大きかった指標（CAUSES の番号） */
  cause: Uint8Array
  /** 指標ごとの基準（割った値）。表示用 */
  ref: Record<DisturbCause, number>
}

/** 移動実効値（窓 w サンプル） */
function movingRms(x: Float64Array, w: number): Float64Array {
  const n = x.length
  const cs = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i] * x[i]
  const h = Math.max(1, Math.floor(w / 2))
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h)
    const b = Math.min(n, i + h + 1)
    out[i] = Math.sqrt((cs[b] - cs[a]) / (b - a))
  }
  return out
}

/** NaN を 0 にした配列（フィルタに通すため）と、有効かどうか */
function clean(d: Float32Array | undefined, n: number): { x: Float64Array; ok: Uint8Array } | null {
  if (!d) return null
  const x = new Float64Array(n)
  const ok = new Uint8Array(n)
  let last = 0
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(d[i])) {
      last = d[i]
      ok[i] = 1
    }
    x[i] = last
  }
  return { x, ok }
}

/** 1.5〜12Hz の帯域の実効値 */
function bandRms(x: Float64Array, rate: number, win: number): Float64Array {
  const hi = lowpassFiltfilt(x, Math.min(12, rate * 0.45), rate)
  const lo = lowpassFiltfilt(x, 1.5, rate)
  return movingRms(
    hi.map((v, i) => v - lo[i]),
    Math.round(win * rate)
  )
}

/** 配列の p パーセンタイル（mask が 1 のところだけ。間引いて計算） */
function percentile(x: Float64Array, mask: Uint8Array, p: number): number {
  const v: number[] = []
  for (let i = 0; i < x.length; i += 3) if (mask[i]) v.push(x[i])
  if (!v.length) return 0
  v.sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]
}

export function disturbTrack(tel: Telemetry, minSpeed = 15, minSpeedSlip = 25): DisturbTrack | null {
  const n = tel.n
  const rate = tel.rate
  const ch = tel.channels
  if (!ch.speed) return null
  const moving = new Uint8Array(n)
  const movingFast = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    moving[i] = ch.speed[i] > minSpeed ? 1 : 0
    movingFast[i] = ch.speed[i] > minSpeedSlip ? 1 : 0
  }
  const metric: Partial<Record<DisturbCause, { x: Float64Array; mask: Uint8Array }>> = {}
  const andMask = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((v, i) => v & b[i])
  // スリップ率
  const sl = clean(ch.slip, n)
  if (sl) {
    const m = andMask(sl.ok, movingFast)
    const sm = fastGaussian(sl.x, rate * 1.0)
    const med = percentile(sl.x, m, 50)
    // 急な変化（平滑からのずれ）を基準の割合で、持続的なずれを SLIP_ABS_FLOOR で割ったものの大きい方を「下限で正規化した値 × FLOOR」に揃える
    const hp = sl.x.map((v, i) => Math.abs(v - sm[i]))
    const ab = sl.x.map((v) => (Math.abs(v - med) / SLIP_ABS_FLOOR) * FLOOR.slip)
    metric.slip = { x: hp.map((v, i) => Math.max(v, ab[i])), mask: m }
  }
  const imu: [DisturbCause, Float32Array | undefined][] = [
    ['roll', ch.rollRate],
    ['yaw', ch.yawRate],
    ['xG', ch.xG],
    ['yG', ch.latG],
    ['zG', ch.zG]
  ]
  for (const [k, d] of imu) {
    const c = clean(d, n)
    if (c) metric[k] = { x: bandRms(c.x, rate, 0.4), mask: andMask(c.ok, moving) }
  }
  const sus: [DisturbCause, Float32Array | undefined][] = [
    ['frSus', ch.frStroke],
    ['rrSus', ch.rrStroke]
  ]
  for (const [k, d] of sus) {
    const c = clean(d, n)
    if (!c) continue
    const s = lowpassFiltfilt(c.x, Math.min(15, rate * 0.45), rate)
    const vel = new Float64Array(n)
    for (let i = 1; i < n - 1; i++) vel[i] = ((s[i + 1] - s[i - 1]) * rate) / 2
    metric[k] = { x: movingRms(vel, Math.round(0.3 * rate)), mask: andMask(c.ok, moving) }
  }
  const score = new Float32Array(n)
  const cause = new Uint8Array(n)
  const ref = { ...FLOOR }
  CAUSES.forEach((k, ci) => {
    const m = metric[k]
    if (!m) return
    ref[k] = Math.max(FLOOR[k], percentile(m.x, m.mask, 99.5))
    for (let i = 0; i < n; i++) {
      if (!m.mask[i]) continue
      const s = m.x[i] / ref[k]
      if (s > score[i]) {
        score[i] = s
        cause[i] = ci
      }
    }
  })
  return { rate, score, cause, ref }
}

export interface DisturbEvent {
  /** 乱れがしきい値を超えていた範囲 [s] */
  start: number
  end: number
  /** いちばん強かった時刻・強さ・指標 */
  peak: number
  score: number
  cause: DisturbCause
}

/** 強さが threshold を超えた区間を事象にする（gap 秒以内の区間はひとつにまとめる） */
export function disturbEvents(d: DisturbTrack, threshold: number, gap = 1.5): DisturbEvent[] {
  const out: DisturbEvent[] = []
  const n = d.score.length
  let i = 0
  while (i < n) {
    if (d.score[i] <= threshold) {
      i++
      continue
    }
    let j = i
    let k = i
    while (j < n && d.score[j] > threshold) {
      if (d.score[j] > d.score[k]) k = j
      j++
    }
    const ev: DisturbEvent = { start: i / d.rate, end: j / d.rate, peak: k / d.rate, score: d.score[k], cause: CAUSES[d.cause[k]] }
    const prev = out[out.length - 1]
    if (prev && ev.start - prev.end < gap) {
      prev.end = ev.end
      if (ev.score > prev.score) {
        prev.peak = ev.peak
        prev.score = ev.score
        prev.cause = ev.cause
      }
    } else out.push(ev)
    i = j
  }
  return out
}
