// Gyro integration, mount estimation, and attitude smoothing (port of proto/stabilize.py and proto/mount.py).
//
//   q(t)  : camera attitude from rig to world coordinates (gyro integration)
//   qs(t) : q Gaussian-smoothed per body axis (pitch/yaw/roll)
//   virtual camera = qs · [roll completion] · [horizon correction] · R_mount · R_view
import type { Imu } from './insv'
import { matT, matVec, qConj, qFromRotvec, qMul, qNormalize, qSlerp, qToMat, qToRotvec, type Mat3, type Quat, type Vec3 } from './quat'

/** IMU coordinates → rig coordinates (X6; estimated by matching against the video) */
export const IMU_TO_RIG: Mat3 = new Float64Array([0, 0, -1, 1, 0, 0, 0, -1, 0])

export interface Orientation {
  ts: Float64Array // us
  q: Float64Array // [x,y,z,w]×N
}

export function integrate(imu: Imu, M: Mat3 = IMU_TO_RIG): Orientation {
  const n = imu.ts.length
  const q = new Float64Array(n * 4)
  const d2r = Math.PI / 180
  let cur: Quat = [0, 0, 0, 1]
  let pw = rigRate(imu.gyro, 0, M)
  q.set(cur, 0)
  for (let i = 1; i < n; i++) {
    const w = rigRate(imu.gyro, i, M)
    const dt = (imu.ts[i] - imu.ts[i - 1]) / 1e6
    // Midpoint rule: the angular velocity over [i-1, i] is the average of the two endpoints
    const s = qFromRotvec(((w[0] + pw[0]) / 2) * d2r * dt, ((w[1] + pw[1]) / 2) * d2r * dt, ((w[2] + pw[2]) / 2) * d2r * dt)
    cur = qMul(cur, s)
    if ((i & 1023) === 0) cur = qNormalize(cur)
    q.set(cur, i * 4)
    pw = w
  }
  return { ts: imu.ts, q }
}

function rigRate(g: Float32Array, i: number, M: Mat3): [number, number, number] {
  return matVec(M, [g[i * 3], g[i * 3 + 1], g[i * 3 + 2]])
}

/** Attitude at time t [us] (spherical linear interpolation) */
export function sampleQ(o: Orientation, t: number): Quat {
  const ts = o.ts
  const n = ts.length
  if (t <= ts[0]) return Array.from(o.q.subarray(0, 4)) as Quat
  if (t >= ts[n - 1]) return Array.from(o.q.subarray((n - 1) * 4, n * 4)) as Quat
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (ts[m] <= t) lo = m
    else hi = m
  }
  const a = o.q.subarray(lo * 4, lo * 4 + 4)
  const b = o.q.subarray(hi * 4, hi * 4 + 4)
  return qSlerp(a, b, (t - ts[lo]) / (ts[hi] - ts[lo]))
}

// ---- Gravity direction ----

const G = 9.80665 // [m/s²]

/**
 * The acceleration in gyro (world) coordinates averaged over a sliding window, every second (gravityTrack). The opposite of what the
 * accelerometer reads, in g: gravity minus the bike's own acceleration
 */
export interface GravityTrack {
  t0: number // time of the first value [us]
  dt: number // [us]
  halfS: number // half the window [s]
  /** [x,y,z]×N, all 0 where unknown */
  mean: Float64Array
}

/**
 * Averages the acceleration moved into gyro coordinates over ±halfS seconds, for the gravity direction (gravityAt).
 * The gyro drifts too little within the window to matter
 */
export function gravityTrack(imu: Imu, ori: Orientation, halfS = 30, M: Mat3 = IMU_TO_RIG): GravityTrack {
  const n = imu.ts.length
  const t0 = imu.ts[0]
  const bins = n ? Math.floor((imu.ts[n - 1] - t0) / 1e6) + 1 : 0
  // Per-second sums and counts (prefix sums, so the window sum is one subtraction)
  const pre = new Float64Array((bins + 1) * 4)
  for (let i = 0; i < n; i += 4) {
    const k = Math.floor((imu.ts[i] - t0) / 1e6)
    const a = matVec(M, [imu.acc[i * 3], imu.acc[i * 3 + 1], imu.acc[i * 3 + 2]])
    const w = matVec(qToMat(ori.q.subarray(i * 4, i * 4 + 4)), a)
    for (let c = 0; c < 3; c++) pre[(k + 1) * 4 + c] -= w[c]
    pre[(k + 1) * 4 + 3]++
  }
  for (let k = 1; k <= bins; k++) for (let c = 0; c < 4; c++) pre[k * 4 + c] += pre[(k - 1) * 4 + c]
  const mean = new Float64Array(bins * 3)
  for (let k = 0; k < bins; k++) {
    const [a, b] = gravityWindow(bins, halfS, k)
    const cnt = pre[b * 4 + 3] - pre[a * 4 + 3]
    if (cnt > 0) for (let c = 0; c < 3; c++) mean[k * 3 + c] = (pre[b * 4 + c] - pre[a * 4 + c]) / cnt
  }
  return { t0, dt: 1e6, halfS, mean }
}

/** Bins [a, b) averaged for bin k */
function gravityWindow(bins: number, halfS: number, k: number): [number, number] {
  return [Math.max(0, k - halfS), Math.min(bins, k + halfS + 1)]
}

/**
 * Gravity "down" at time t [us] in gyro coordinates (unit vector; null where unknown).
 * The window average still holds the bike's own acceleration, which over the window adds up to the change in velocity: braking and
 * accelerating, and in corners the push outward, which does not cancel when the road turns one way (a hairpin tilts "down" by about 3°).
 * vel(t) gives the velocity in gyro coordinates [m/s] to take it out; without it the average is used as it is
 */
export function gravityAt(g: GravityTrack, t: number, vel?: (t: number) => Vec3 | null): Vec3 | null {
  const n = g.mean.length / 3
  if (!n) return null
  const k = Math.max(0, Math.min(n - 1, Math.round((t - g.t0) / g.dt)))
  const v: Vec3 = [g.mean[k * 3], g.mean[k * 3 + 1], g.mean[k * 3 + 2]]
  if (vel) {
    const [a, b] = gravityWindow(n, g.halfS, k)
    const va = vel(g.t0 + a * g.dt)
    const vb = vel(g.t0 + b * g.dt)
    // mean(gravity) = mean(-reading) + mean(acceleration) = mean(-reading) + Δv / window
    const T = ((b - a) * g.dt) / 1e6
    if (va && vb) for (let c = 0; c < 3; c++) v[c] += (vb[c] - va[c]) / (T * G)
  }
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0.5 ? [v[0] / len, v[1] / len, v[2] / len] : null
}

// ---- Mount estimation ----

/** Eigendecomposition of a symmetric 3×3 matrix (Jacobi method). Returns eigenvalues in ascending order */
export function eigSym3(a: number[][]): { values: number[]; vectors: number[][] } {
  const A = a.map((r) => r.slice())
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ]
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += A[p][q] * A[p][q]
    if (off < 1e-20) break
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < 3; k++) {
          const akp = A[k][p]
          const akq = A[k][q]
          A[k][p] = c * akp - s * akq
          A[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < 3; k++) {
          const apk = A[p][k]
          const aqk = A[q][k]
          A[p][k] = c * apk - s * aqk
          A[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p]
          const vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq
          V[k][q] = s * vkp + c * vkq
        }
      }
  }
  const idx = [0, 1, 2].sort((i, j) => A[i][i] - A[j][j])
  return { values: idx.map((i) => A[i][i]), vectors: idx.map((i) => [V[0][i], V[1][i], V[2][i]]) }
}

const cross = (a: number[], b: number[]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: number[]): [number, number, number] => {
  const n = Math.hypot(a[0], a[1], a[2])
  return [a[0] / n, a[1] / n, a[2] / n]
}

/** Strength of the correlation between lean angle and yaw rate, needed to decide the front/back direction from the "leans into the turn" relationship (if weaker than this, the lens direction decides) */
export const FWD_MIN_CORR = 0.1

/**
 * Estimates the camera mount attitude. Returns a row-major matrix whose columns are the body's right, down, and forward (rig coordinates).
 * Up = the mean acceleration (a bike's resultant force stays along the body's vertical even while leaning),
 * front/back axis = the principal component of the 0.5 s-averaged gyro, perpendicular to up (the lean roll rotation is largest).
 * Front/back direction = a bike leans into the turn, so the lean angle about the forward axis (the integral of the roll rate) leans right while turning right.
 * The direction is decided by this relationship (the correlation coupling between lean angle and yaw rate; negative for the correct direction). It works even if the lenses are mounted facing sideways, up/down, or backward.
 * Only when there are few turns and the relationship is weak (|coupling| < FWD_MIN_CORR) does it fall back to the previous method (whichever is closer to the lens 1 direction forwardHint).
 * byHint = whether the front/back direction came out opposite to the previous method's (to check the difference from edits made with the previous version)
 */
export function estimateMount(
  imu: Imu,
  M: Mat3 = IMU_TO_RIG,
  forwardHint: number[] = [0, 0, -1]
): { R: Mat3; ratio: number; coupling: number; by: 'lean' | 'lens'; flippedFromLens: boolean } {
  const n = imu.ts.length
  let up = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const a = matVec(M, [imu.acc[i * 3], imu.acc[i * 3 + 1], imu.acc[i * 3 + 2]])
    up[0] += a[0]
    up[1] += a[1]
    up[2] += a[2]
  }
  up = unit(up)
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  const B = 500
  for (let s = 0; s + B <= n; s += B) {
    const m = [0, 0, 0]
    for (let i = s; i < s + B; i++) {
      const g = matVec(M, [imu.gyro[i * 3], imu.gyro[i * 3 + 1], imu.gyro[i * 3 + 2]])
      m[0] += g[0]
      m[1] += g[1]
      m[2] += g[2]
    }
    const k = dot(m, up)
    const p = [(m[0] - k * up[0]) / B, (m[1] - k * up[1]) / B, (m[2] - k * up[2]) / B]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += p[a] * p[b]
  }
  const e = eigSym3(C)
  let fwd = e.vectors[2]
  const kk = dot(fwd, up)
  fwd = unit([fwd[0] - up[0] * kk, fwd[1] - up[1] * kk, fwd[2] - up[2] * kk])
  const lensSays = dot(fwd, forwardHint) < 0 // previous method: whichever is closer to the lens 1 direction
  const coupling = leanYawCoupling(imu, M, fwd, up)
  const by = Math.abs(coupling) >= FWD_MIN_CORR ? 'lean' : 'lens'
  const flip = by === 'lean' ? coupling > 0 : lensSays
  if (flip) fwd = [-fwd[0], -fwd[1], -fwd[2]]
  const right = cross(fwd, up)
  const down = [-up[0], -up[1], -up[2]]
  const R = new Float64Array([right[0], down[0], fwd[0], right[1], down[1], fwd[1], right[2], down[2], fwd[2]])
  return { R, ratio: e.values[2] / Math.max(e.values[1], 1e-12), coupling: flip ? -coupling : coupling, by, flippedFromLens: flip !== lensSays }
}

/**
 * Correlation coefficient between the lean angle about axis fwd (roll rate integrated at 100 Hz, minus a 10 s moving average to remove drift) and
 * the yaw rate about up. If fwd is truly forward it is negative (turning right = clockwise from above = while yaw is negative, leaning right = roll positive)
 */
export function leanYawCoupling(imu: Imu, M: Mat3, fwd: number[], up: number[]): number {
  const n = imu.ts.length
  if (n < 2) return 0
  const rate = (n - 1) / ((imu.ts[n - 1] - imu.ts[0]) / 1e6)
  const B = Math.max(1, Math.round(rate / 100)) // bin down to 100 Hz
  const m = Math.floor(n / B)
  const roll = new Float64Array(m)
  const yaw = new Float64Array(m)
  for (let b = 0; b < m; b++) {
    let r = 0
    let y = 0
    for (let i = b * B; i < (b + 1) * B; i++) {
      const g = matVec(M, [imu.gyro[i * 3], imu.gyro[i * 3 + 1], imu.gyro[i * 3 + 2]])
      r += dot(g, fwd)
      y += dot(g, up)
    }
    roll[b] = r / B
    yaw[b] = y / B
  }
  const ang = new Float64Array(m)
  for (let i = 1; i < m; i++) ang[i] = ang[i - 1] + roll[i] / 100
  const cs = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) cs[i + 1] = cs[i] + ang[i]
  const W = 1000
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - W / 2)
    const b = Math.min(m, i + W / 2)
    const lean = ang[i] - (cs[b] - cs[a]) / (b - a)
    sxy += lean * yaw[i]
    sxx += lean * lean
    syy += yaw[i] * yaw[i]
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
}

// ---- Smoothing ----

/**
 * For each time in times [us], returns the attitude averaged over the surrounding attitudes with a Gaussian window per body axis (no phase lag).
 * sigma = [pitch, yaw, roll] in seconds. axes = R_mount (columns = body right, down, forward).
 */
export function smooth(
  o: Orientation,
  times: Float64Array,
  sigma: [number, number, number],
  axes: Mat3 | ((t: number) => Mat3),
  stepUs = 5000
): Float64Array {
  const smax = Math.max(...sigma)
  const half = Math.ceil((3 * smax * 1e6) / stepUs)
  const w: number[][] = [[], [], []]
  for (let j = 0; j < 3; j++) {
    let sum = 0
    for (let k = -half; k <= half; k++) {
      const dt = (k * stepUs) / 1e6
      const v = Math.exp(-0.5 * (dt / Math.max(sigma[j], 1e-6)) ** 2)
      w[j].push(v)
      sum += v
    }
    w[j] = w[j].map((v) => v / sum)
  }
  // Precompute the attitudes on a uniform grid
  const tmin = times[0] - (half + 2) * stepUs
  const tmax = times[times.length - 1] + (half + 2) * stepUs
  const ng = Math.floor((tmax - tmin) / stepUs) + 1
  const grid = new Float64Array(ng * 4)
  for (let i = 0; i < ng; i++) grid.set(sampleQ(o, tmin + i * stepUs), i * 4)
  // Body axes (if the mount attitude changes over time, the one at that time)
  const axesAt = typeof axes === 'function' ? axes : (): Mat3 => axes
  const out = new Float64Array(times.length * 4)
  for (let f = 0; f < times.length; f++) {
    const t = times[f]
    const ax = axesAt(t)
    const axT = matT(ax) // rows = body right, down, forward
    const center = sampleQ(o, t)
    const ci = qConj(center)
    const c = Math.round((t - tmin) / stepUs)
    let a0 = 0
    let a1 = 0
    let a2 = 0
    for (let k = -half; k <= half; k++) {
      const gi = Math.min(Math.max(c + k, 0), ng - 1)
      const rel = qToRotvec(qMul(ci, grid.subarray(gi * 4, gi * 4 + 4)))
      const b = matVec(axT, rel) // body-axis components
      const wi = k + half
      a0 += w[0][wi] * b[0]
      a1 += w[1][wi] * b[1]
      a2 += w[2][wi] * b[2]
    }
    const avg = matVec(ax, [a0, a1, a2])
    out.set(qMul(center, qFromRotvec(avg[0], avg[1], avg[2])), f * 4)
  }
  return out
}

/** Returns the relative rotation (rotation vector, rig coordinates) of the K times during readout, relative to the frame center */
export function readoutRotations(o: Orientation, tc: number, readoutUs: number, K = 17): Float32Array {
  const qc = qConj(sampleQ(o, tc))
  const out = new Float32Array(K * 3)
  for (let k = 0; k < K; k++) {
    const t = tc + (k / (K - 1) - 0.5) * readoutUs
    const r = qToRotvec(qMul(qc, sampleQ(o, t)))
    out.set(r, k * 3)
  }
  return out
}
