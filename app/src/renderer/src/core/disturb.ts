// Detection of vehicle behavior disturbances: from slip-ratio anomalies, 6-axis (angular rate and acceleration) disturbances, and sudden suspension stroke movements,
// build a per-time disturbance strength (score) and extract the sections exceeding the threshold as events.
//
// Metrics (from the 100 Hz unified telemetry)
//   slip     : sudden changes in slip ratio (deviation from a σ=1 s smoothing) and large deviations from the whole ride's median (spin, lock)
//   roll/yaw : RMS (0.4 s) of the 1.5-12 Hz component of the vehicle's angular rate ... wandering, being shaken, wobble
//   x/y/zG   : RMS (0.4 s) of the 1.5-12 Hz component of acceleration ... auxiliary, since the log is heavily smoothed
//   fr/rrSus : RMS (0.3 s) of stroke speed (smoothed at 15 Hz, then differentiated) ... big bumps, drops, bottoming out
// Each is divided by the larger of "that ride's 99.5th percentile" and a "floor" (an absolute value so that quiet rides do not produce too many events),
// and the largest one becomes the strength at that time. 1.0 corresponds to the top 0.5% of that ride.
import { fastGaussian, lowpassFiltfilt } from './dsp'
import type { Telemetry } from './telemetry'

export type DisturbCause = 'slip' | 'roll' | 'yaw' | 'xG' | 'yG' | 'zG' | 'frSus' | 'rrSus'
export const CAUSES: DisturbCause[] = ['slip', 'roll', 'yaw', 'xG', 'yG', 'zG', 'frSus', 'rrSus']

export const CAUSE_NAMES: Record<DisturbCause, string> = {
  slip: 'Slip ratio', // i18n-ignore
  roll: 'Roll rate', // i18n-ignore
  yaw: 'Yaw rate', // i18n-ignore
  xG: 'Longitudinal G', // i18n-ignore
  yG: 'Lateral G', // i18n-ignore
  zG: 'Vertical G', // i18n-ignore
  frSus: 'Front suspension', // i18n-ignore
  rrSus: 'Rear suspension' // i18n-ignore
}

/** Floor for each metric (about the 99.5th percentile of the sample ride). Units are each metric's own */
const FLOOR: Record<DisturbCause, number> = { slip: 1.5, roll: 3.5, yaw: 2.0, xG: 0.008, yG: 0.003, zG: 0.025, frSus: 350, rrSus: 450 }
/** Floor for the slip-ratio deviation from the whole-ride median [%] (sustained spin or lock beyond this is also regarded as a disturbance) */
const SLIP_ABS_FLOOR = 6

export interface DisturbTrack {
  rate: number
  /** Disturbance strength (1.0 = top 0.5% of that ride). 0 while not riding */
  score: Float32Array
  /** Metric that was largest at that time (index into CAUSES) */
  cause: Uint8Array
  /** Reference for each metric (the divisor). For display */
  ref: Record<DisturbCause, number>
}

/** Moving RMS (window of w samples) */
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

/** Array with NaN replaced by 0 (to pass through a filter), and whether each sample is valid */
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

/** RMS of the 1.5-12 Hz band */
function bandRms(x: Float64Array, rate: number, win: number): Float64Array {
  const hi = lowpassFiltfilt(x, Math.min(12, rate * 0.45), rate)
  const lo = lowpassFiltfilt(x, 1.5, rate)
  return movingRms(
    hi.map((v, i) => v - lo[i]),
    Math.round(win * rate)
  )
}

/** p-th percentile of an array (only where mask is 1; computed on a decimated copy) */
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
  // Slip ratio
  const sl = clean(ch.slip, n)
  if (sl) {
    const m = andMask(sl.ok, movingFast)
    const sm = fastGaussian(sl.x, rate * 1.0)
    const med = percentile(sl.x, m, 50)
    // Take the larger of the sudden change (deviation from the smoothing) as a fraction of the reference and the sustained deviation divided by SLIP_ABS_FLOOR, aligned to "floor-normalized value × FLOOR"
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
  /** Range [s] over which the disturbance exceeded the threshold */
  start: number
  end: number
  /** Time, strength, and metric of the strongest point */
  peak: number
  score: number
  cause: DisturbCause
}

/** Turns sections where the strength exceeded threshold into events (sections within gap seconds are merged into one) */
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
