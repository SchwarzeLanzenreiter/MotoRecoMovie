// "Telemetry estimated from the video's IMU" for when there is no vehicle log.
// So that auto camera (riding state) and floating signs (corner curve radius, shape of the road traveled) still work without a log, at lower accuracy.
//
//   Lean angle:  integrate the rotation (gyro) around the forward axis. The integral drifts, so find the drift where riding straight
//                (not turning = lean should be 0) and subtract it
//   Turning:     rotation around up ÷ cos(lean) = turn rate around the vertical axis
//   Vehicle speed: in corners, from the lean angle and the turn rate, v = g·tan(lean) / turn rate (a bike leans in the direction of the resultant of the turning force and gravity).
//                Between those, accumulate with the longitudinal acceleration, and set to 0 while stopped (forward-backward symmetric Kalman smoothing)
//   Longitudinal G: the forward component of the camera acceleration (subtract the slow variation to remove the gravity component of slopes)
//   Stop:        while the gyro is hardly moving
//   Heading/position: heading from integrating the turn (initial direction = north) and position accumulated from vehicle speed (there is no GPS, so it does not match a map)
// The mount orientation uses the estimate (per time) from core/mount.ts
import { fastGaussian as gaussianFilter } from './dsp'
import { IMU_TO_RIG } from './motion'
import { mountAt, type MountTrack } from './mount'
import type { Imu } from './insv'
import type { LeanTrack } from './motoreco'
import type { NavTrack } from './nav'
import type { Telemetry } from './telemetry'
import type { Mat3 } from './quat'

const RATE = 100
const G = 9.80665
// Riding or not: whether the 2 s mean square of the gyro (including vibration) is larger than this, or the slow sway (0.3 s average) is large, or it is turning [deg/s].
// Even when stopped the engine vibration shakes it by 8-15 deg/s, but while riding the road vibration makes it 20 deg/s or more.
// While riding slowly (below 20 km/h) the vibration is small, but the body sways finely left and right (2-3 deg/s while stopped, 7-11 deg/s while riding slowly. In my video)
const MOVING_DPS = 16
const MOVING_SWAY_DPS = 4.5
const MOVING_TURN_DPS = 3
const STRAIGHT_DPS = 2 // if the turn is slower than this, treat it as straight (lean 0) [deg/s]
const LEAN_ANCHOR_SIGMA = 4 // width for smoothing the lean angle drift [s]
const SPEED_MIN_LEAN = 12 // lower limit of the lean angle used to find vehicle speed [deg]
const SPEED_MIN_TURN = 4 // likewise, lower limit of the turn rate [deg/s]
const ACC_DETREND = 20 // width of the slow variation subtracted from longitudinal G (slopes, camera tilt offset) [s]
// The fraction of the body's lean angle that matches the direction of the resultant of the turning force and gravity (ratio of tan). Tires have width, so the body leans slightly deeper than theory.
// With v = g·tan(lean)/turn unchanged, the vehicle speed in corners came out 15-17% too high (compared with the front wheel speed in the vehicle log)
const LEAN_EFFECTIVE = 0.86
// The forward component of the camera acceleration came out 1.1-1.2 times larger than the vehicle's longitudinal G (change in front wheel speed) (camera mount shake), so match it
const ACC_SCALE = 0.87

export interface ImuTelemetry {
  telemetry: Telemetry
  /** Lean angle (used for MotionModel's horizon correction) */
  lean: LeanTrack
}

/**
 * @param durationSec video length [s] (output time axis = video time, 100 Hz)
 */
export function buildImuTelemetry(imu: Imu, mount: MountTrack, firstFrameUs: number, durationSec: number, M: Mat3 = IMU_TO_RIG): ImuTelemetry {
  const n = Math.floor(durationSec * RATE) + 1
  const d2r = Math.PI / 180
  // ---- 1. To 100 Hz video time: roll around forward, yaw around up, forward acceleration, gyro magnitude ----
  const roll = new Float64Array(n)
  const yawUp = new Float64Array(n)
  const accF = new Float64Array(n)
  const gyr2 = new Float64Array(n)
  const gx = new Float64Array(n)
  const gy = new Float64Array(n)
  const gz = new Float64Array(n)
  const cnt = new Float64Array(n)
  let R = mountAt(mount, imu.ts[0])
  let lastK = -1
  for (let i = 0; i < imu.ts.length; i++) {
    const k = Math.round(((imu.ts[i] - firstFrameUs) / 1e6) * RATE)
    if (k < 0 || k >= n) continue
    if (k !== lastK && (k & 7) === 0) R = mountAt(mount, imu.ts[i]) // updating the mount orientation every 80 ms is enough
    lastK = k
    const g = [0, 1, 2].map((r) => M[r * 3] * imu.gyro[i * 3] + M[r * 3 + 1] * imu.gyro[i * 3 + 1] + M[r * 3 + 2] * imu.gyro[i * 3 + 2])
    const a = [0, 1, 2].map((r) => M[r * 3] * imu.acc[i * 3] + M[r * 3 + 1] * imu.acc[i * 3 + 1] + M[r * 3 + 2] * imu.acc[i * 3 + 2])
    // Columns of R = right, down, forward (rig coordinates)
    roll[k] += g[0] * R[2] + g[1] * R[5] + g[2] * R[8]
    yawUp[k] -= g[0] * R[1] + g[1] * R[4] + g[2] * R[7]
    accF[k] += a[0] * R[2] + a[1] * R[5] + a[2] * R[8]
    gyr2[k] += g[0] * g[0] + g[1] * g[1] + g[2] * g[2]
    gx[k] += g[0]
    gy[k] += g[1]
    gz[k] += g[2]
    cnt[k]++
  }
  fillAverage(roll, cnt)
  fillAverage(yawUp, cnt)
  fillAverage(accF, cnt)
  fillAverage(gyr2, cnt)
  fillAverage(gx, cnt)
  fillAverage(gy, cnt)
  fillAverage(gz, cnt)
  // ---- 2. Riding or not ----
  const moving = new Uint8Array(n)
  {
    const cs = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + gyr2[i]
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - RATE)
      const hi = Math.min(n, i + RATE + 1)
      moving[i] = Math.sqrt((cs[hi] - cs[lo]) / (hi - lo)) > MOVING_DPS ? 1 : 0
    }
  }
  const yawS = gaussianFilter(yawUp, 0.5 * RATE)
  {
    // Slow sway: the 2 s mean square of the gyro magnitude averaged over 0.3 s
    const sm = [gx, gy, gz].map((a) => gaussianFilter(a, 0.15 * RATE))
    const cs = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + sm[0][i] ** 2 + sm[1][i] ** 2 + sm[2][i] ** 2
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - RATE)
      const hi = Math.min(n, i + RATE + 1)
      if (Math.sqrt((cs[hi] - cs[lo]) / (hi - lo)) > MOVING_SWAY_DPS || Math.abs(yawS[i]) > MOVING_TURN_DPS) moving[i] = 1
    }
  }
  // ---- 3. Lean angle: from the roll integral, subtract the drift found where riding straight ----
  const ang = new Float64Array(n)
  for (let i = 1; i < n; i++) ang[i] = ang[i - 1] + roll[i] / RATE
  const anchorW = new Float64Array(n)
  const anchorV = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    // Where riding straight (not turning) or stopped, lean (body tilt) should be 0
    const straight = Math.abs(yawS[i]) < STRAIGHT_DPS
    anchorW[i] = straight ? 1 : 0
    anchorV[i] = straight ? ang[i] : 0
  }
  const drift = weightedSmooth(anchorV, anchorW, LEAN_ANCHOR_SIGMA * RATE)
  const lean = new Float64Array(n)
  for (let i = 0; i < n; i++) lean[i] = ang[i] - drift[i]
  const leanS = gaussianFilter(lean, 0.05 * RATE)
  // ---- 4. Turning (around the vertical axis, right turn positive) and heading ----
  const turn = new Float64Array(n)
  for (let i = 0; i < n; i++) turn[i] = -yawS[i] / Math.cos(Math.min(Math.abs(leanS[i]), 60) * d2r)
  // ---- 5. Longitudinal G (subtract the slow variation) ----
  const accS = gaussianFilter(accF, 0.3 * RATE)
  const accTrend = gaussianFilter(accF, ACC_DETREND * RATE)
  const accelG = new Float32Array(n)
  for (let i = 0; i < n; i++) accelG[i] = moving[i] ? (accS[i] - accTrend[i]) * ACC_SCALE : 0
  // ---- 6. Vehicle speed: the estimate in corners (v = g·tan L / ω) and 0 while stopped, connected with the longitudinal acceleration ----
  const meas = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    if (!moving[i]) {
      meas[i] = 0
      continue
    }
    const L = leanS[i]
    const w = turn[i]
    // Only when the lean and turn directions agree (leaning right and turning right)
    if (Math.abs(L) >= SPEED_MIN_LEAN && Math.abs(w) >= SPEED_MIN_TURN && Math.sign(L) === Math.sign(w)) {
      const v = (G * LEAN_EFFECTIVE * Math.tan(Math.abs(L) * d2r)) / (Math.abs(w) * d2r)
      if (v > 2 && v < 70) meas[i] = v
    }
  }
  const speedMs = kalmanSpeed(meas, accelG, moving)
  const speed = new Float32Array(n)
  for (let i = 0; i < n; i++) speed[i] = Math.max(0, speedMs[i]) * 3.6
  // ---- 7. Heading and position (dead reckoning) ----
  const heading = new Float32Array(n)
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  let h = 0
  for (let i = 1; i < n; i++) {
    h += turn[i] / RATE
    heading[i] = ((h % 360) + 360) % 360
    const v = speed[i] / 3.6
    x[i] = x[i - 1] + (v * Math.sin(h * d2r)) / RATE
    y[i] = y[i - 1] + (v * Math.cos(h * d2r)) / RATE
  }
  const nav: NavTrack = { x, y, heading, turnRate: Float32Array.from(gaussianFilter(turn, 0.3 * RATE)) }
  const telemetry: Telemetry = {
    rate: RATE,
    n,
    t0: 0,
    channels: { lean: Float32Array.from(leanS), speed, accelG },
    gps: null,
    nav,
    source: 'imu'
  }
  const t = new Float64Array(n).map((_, i) => i / RATE)
  return { telemetry, lean: { t, lean: leanS, sd: new Float64Array(n).fill(3), k: 1, rateCorr: 0 } }
}

/** Divide the accumulated sum by the number of samples (where there are no samples, the previous value) */
function fillAverage(a: Float64Array, cnt: Float64Array): void {
  let last = 0
  for (let i = 0; i < a.length; i++) {
    if (cnt[i] > 0) last = a[i] / cnt[i]
    a[i] = last
  }
}

/** Weighted Gaussian mean (where there is no weight, fill with the value of a nearby place that has weight) */
function weightedSmooth(v: Float64Array, w: Float64Array, sigma: number): Float64Array {
  const num = gaussianFilter(Float64Array.from(v, (x, i) => x * w[i]), sigma)
  const den = gaussianFilter(w, sigma)
  const wide = gaussianFilter(Float64Array.from(v, (x, i) => x * w[i]), sigma * 8)
  const wideD = gaussianFilter(w, sigma * 8)
  const out = new Float64Array(v.length)
  let last = 0
  for (let i = 0; i < v.length; i++) {
    if (den[i] > 0.05) out[i] = num[i] / den[i]
    else if (wideD[i] > 1e-3) out[i] = wide[i] / wideD[i]
    else out[i] = last
    last = out[i]
  }
  return out
}

/**
 * Vehicle speed [m/s]: state = velocity, prediction = longitudinal acceleration, observation = the estimate in corners and 0 while stopped. Forward-backward symmetric (RTS smoothing)
 * @param meas observations (NaN = none)
 * @param acc longitudinal acceleration [G]
 */
function kalmanSpeed(meas: Float64Array, acc: Float32Array, moving: Uint8Array): Float64Array {
  const n = meas.length
  const dt = 1 / RATE
  const Q = 0.04 // growth of variance per sample due to acceleration error (slopes, offset) [(m/s)²]
  const Rm = 9 // error of the estimate in corners [(m/s)²]
  const R0 = 0.01 // the 0 while stopped
  const xf = new Float64Array(n)
  const pf = new Float64Array(n)
  const xp = new Float64Array(n)
  const pp = new Float64Array(n)
  let x = 15
  let p = 400
  for (let i = 0; i < n; i++) {
    // Predict
    x = x + acc[i] * G * dt
    p = p + Q
    if (!moving[i]) x = Math.min(x, 3)
    xp[i] = x
    pp[i] = p
    // Update
    const z = meas[i]
    if (!Number.isNaN(z)) {
      const r = z === 0 ? R0 : Rm
      const k = p / (p + r)
      x = x + k * (z - x)
      p = (1 - k) * p
    }
    xf[i] = x
    pf[i] = p
  }
  // Smooth backward
  const xs = new Float64Array(n)
  xs[n - 1] = xf[n - 1]
  for (let i = n - 2; i >= 0; i--) {
    const c = pf[i] / pp[i + 1]
    xs[i] = xf[i] + c * (xs[i + 1] - xp[i + 1])
  }
  return xs
}
