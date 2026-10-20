// Fusion of heading and position (to draw signs fixed at points on the map).
//
// GPS is 1 Hz with some delay, so used as is the position and heading are jerky and signs drift around on screen.
//   Heading: integrate the gyro yaw rate (body up-axis rate ÷ cos(lean) to convert to about the vertical axis), and correct it
//            only at low frequencies with the GPS heading (complementary filter)
//   Position: dead reckoning accumulated from front wheel speed and the heading above, corrected only at low frequencies with the GPS position
// Both are smoothed with a symmetric Gaussian since the whole ride is known at export time (no lag).
import { fastGaussian as gaussianFilter, interpSorted } from './dsp'
import type { Telemetry } from './telemetry'

export interface NavTrack {
  x: Float32Array // east [m] (same origin as the GPS plane coordinates)
  y: Float32Array // north [m]
  heading: Float32Array // heading [deg] (north = 0, east = 90, clockwise)
  /** Angular rate of turning about the vertical axis [deg/s] (right turn positive; smoothed with σ=0.3 s to remove vibration) */
  turnRate: Float32Array
}

const CORRECT_SIGMA_S = 3 // range of low frequencies corrected with GPS (Gaussian σ, seconds)

/** Fills NaN sections by linear interpolation of the surrounding values (ends take the nearest value) */
function fillNaN(a: Float64Array): Float64Array {
  const out = a.slice()
  const n = a.length
  let last = -1
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(out[i])) continue
    if (last < 0) for (let k = 0; k < i; k++) out[k] = out[i]
    else if (i - last > 1) for (let k = last + 1; k < i; k++) out[k] = out[last] + ((out[i] - out[last]) * (k - last)) / (i - last)
    last = i
  }
  if (last >= 0) for (let k = last + 1; k < n; k++) out[k] = out[last]
  else out.fill(0)
  return out
}

/**
 * @param yaw Camera gyro projected onto the body's up axis (100 Hz, deg/s. Positive = counterclockwise from above = left turn)
 */
export function buildNav(tel: Telemetry, yaw: { t: Float64Array; r: Float64Array }): NavTrack | null {
  const ch = tel.channels
  if (!ch.heading || !ch.gpsX || !ch.gpsY || !ch.speed) return null
  const n = tel.n
  const rate = tel.rate
  const dt = 1 / rate
  const grid = new Float64Array(n).map((_, i) => i / rate)
  const d2r = Math.PI / 180
  // Turn rate about the vertical axis (right turn = direction in which heading increases is positive)
  const yr = interpSorted(grid, yaw.t, yaw.r)
  const turn = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const L = ch.lean ? ch.lean[i] : 0
    const c = Math.cos(Math.min(Math.abs(L), 60) * d2r)
    turn[i] = -yr[i] / c
  }
  // ---- Heading ----
  const hg = new Float64Array(n)
  for (let i = 1; i < n; i++) hg[i] = hg[i - 1] + turn[i] * dt
  // Deviation from the GPS heading (unwrapped to be continuous). GPS heading is unreliable when slow, so exclude those
  const diff = new Float64Array(n).fill(NaN)
  let prev = NaN
  for (let i = 0; i < n; i++) {
    const h = ch.heading[i]
    const v = ch.speed[i]
    if (Number.isNaN(h) || !(v > 15)) continue
    let d = h - hg[i]
    if (!Number.isNaN(prev)) d = prev + ((((d - prev) % 360) + 540) % 360) - 180
    diff[i] = d
    prev = d
  }
  const off = gaussianFilter(fillNaN(diff), CORRECT_SIGMA_S * rate)
  const heading = new Float32Array(n)
  for (let i = 0; i < n; i++) heading[i] = (((hg[i] + off[i]) % 360) + 360) % 360
  // ---- Position (dead reckoning + GPS correction) ----
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const v = Number.isNaN(ch.speed[i]) ? 0 : ch.speed[i] / 3.6
    const h = (hg[i] + off[i]) * d2r
    px[i] = px[i - 1] + v * Math.sin(h) * dt
    py[i] = py[i - 1] + v * Math.cos(h) * dt
  }
  const ex = new Float64Array(n)
  const ey = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    ex[i] = Number.isNaN(ch.gpsX[i]) ? NaN : ch.gpsX[i] - px[i]
    ey[i] = Number.isNaN(ch.gpsY[i]) ? NaN : ch.gpsY[i] - py[i]
  }
  const cx = gaussianFilter(fillNaN(ex), CORRECT_SIGMA_S * rate)
  const cy = gaussianFilter(fillNaN(ey), CORRECT_SIGMA_S * rate)
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = px[i] + cx[i]
    y[i] = py[i] + cy[i]
  }
  // The turn angular rate includes stick vibration (about ±20°/s), so smooth it before using it for curve radius etc.
  return { x, y, heading, turnRate: Float32Array.from(gaussianFilter(turn, 0.3 * rate)) }
}
