// Time variation of the camera mount orientation (MountTrack): find the mount orientation so that forward = the bike's direction of travel,
// up = the top of the bike body when not leaning. When the camera orientation relative to the bike changes gradually while riding (the mount rotates or loosens), it is found for each time.
//
//   up(t)      = time average of the acceleration while riding (Gaussian window UP_SIGMA s). The bike's resultant force points along the body's vertical even while leaning, so this is the body's up
//   fore-aft(t) = the axis, in the plane perpendicular to up, that combines the following 3 cues (Gaussian window FWD_SIGMA s)
//     - Falling-over rotation: principal component of the gyro averaged over 0.5 s. Accurate if clear, but if the mount shakes it picks up the shake axis
//     - Acceleration/deceleration: principal component of the horizontal acceleration (even while leaning, almost no lateral force appears, so horizontal acceleration is fore-aft). Works on straights too
//     - Relation to yaw: direction of the coefficient from regressing the yaw rate on the tilt. Only the axis that leans into the turn counts, so it is robust to mount shake (coarse)
//   Front vs. back = the relation of leaning into the turn (same idea as leanYawCoupling in core/motion.ts), decided once for the whole video
//   The per-time estimates are weighted by confidence and smoothed (SMOOTH_SIGMA s), and stopped periods are filled with the nearby confident estimates
// If the orientation hardly changes through the video (below FIXED_DEG), a single mount orientation for the whole video (estimateMount) is used.
// Once the vehicle log is loaded, refine it with refineMountWithLog (using the log's vehicle speed, lean angle and roll rate).
// For verification see test/mount.test.ts (synthetic data) and test/mount-log.test.ts (real data and log)
import type { Imu } from './insv'
import { eigSym3, estimateMount, FWD_MIN_CORR, IMU_TO_RIG } from './motion'
import { matToQ, qSlerp, qToMat, type Mat3, type Quat } from './quat'

export interface MountTrack {
  /** Time of the first point [us] (gyro time axis) and the interval [us] */
  t0: number
  dt: number
  /** Quaternion [x,y,z,w]×N of the mount orientation (columns = body right, down, forward; rig-coordinate matrix) */
  q: Float64Array
  /** Whether it is a single orientation through the video */
  fixed: boolean
  /** How the fore-aft direction was determined (lean = relation of leaning into the turn, lens = lens orientation, log = refined with the vehicle log) */
  by: 'lean' | 'lens' | 'log'
  /** The largest angle [deg] by which forward/up changed within the video */
  maxDeg: number
}

const UP_SIGMA = 15 // time average of the up direction [s]
const FWD_SIGMA = 40 // time window of the fore-aft axis [s]
const STEP = 1 // output interval [s]
const SMOOTH_SIGMA = 30 // width for smoothing the per-time estimates weighted by confidence [s]
const MOVING_DPS = 1.5 // riding if the 2 s mean square of the gyro is at or above this [deg/s]
export const FIXED_DEG = 12 // use a single orientation if the change is smaller than this [deg]

type V3 = [number, number, number]
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: ArrayLike<number>): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}
const angleDeg = (a: ArrayLike<number>, b: ArrayLike<number>): number => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI

/** Mount orientation matrix from forward/up (rig coordinates) (columns = right, down, forward) */
function mountMat(fwd: ArrayLike<number>, up: ArrayLike<number>): Mat3 {
  const f = unit(fwd)
  const right = cross(f, up)
  const down = [-up[0], -up[1], -up[2]]
  return new Float64Array([right[0], down[0], f[0], right[1], down[1], f[1], right[2], down[2], f[2]])
}

/** Mount orientation at time t [us] */
export function mountAt(m: MountTrack, t: number): Mat3 {
  return qToMat(mountQAt(m, t))
}
export function mountQAt(m: MountTrack, t: number): Quat {
  const n = m.q.length / 4
  const x = Math.max(0, Math.min(n - 1, (t - m.t0) / m.dt))
  const k = Math.min(n - 2, Math.floor(x))
  if (n < 2) return Array.from(m.q.subarray(0, 4)) as Quat
  return qSlerp(m.q.subarray(k * 4, k * 4 + 4), m.q.subarray(k * 4 + 4, k * 4 + 8), x - k)
}
/** Forward direction at time t [us] (rig coordinates) */
export function mountFwdAt(m: MountTrack, t: number): V3 {
  const R = mountAt(m, t)
  return [R[2], R[5], R[8]]
}
/** Up direction at time t [us] (rig coordinates) */
export function mountUpAt(m: MountTrack, t: number): V3 {
  const R = mountAt(m, t)
  return [-R[1], -R[4], -R[7]]
}

/** MountTrack for a single orientation */
export function fixedMount(R: Mat3, t0 = 0): MountTrack {
  return { t0, dt: 1e6, q: new Float64Array(matToQ(R)), fixed: true, by: 'lens', maxDeg: 0 }
}

/** Find the time variation of the mount orientation from the IMU */
export function estimateMountTrack(imu: Imu, M: Mat3 = IMU_TO_RIG): MountTrack {
  const whole = estimateMount(imu, M)
  const n = imu.ts.length
  const rate = (n - 1) / ((imu.ts[n - 1] - imu.ts[0]) / 1e6)
  // Acceleration and gyro (rig coordinates) aggregated to 10 Hz
  const B = Math.max(1, Math.round(rate / 10))
  const m = Math.floor(n / B)
  const ts = new Float64Array(m)
  const acc = new Float64Array(m * 3)
  const gyr = new Float64Array(m * 3)
  for (let b = 0; b < m; b++) {
    let t = 0
    for (let i = b * B; i < (b + 1) * B; i++) {
      t += imu.ts[i]
      for (let r = 0; r < 3; r++) {
        acc[b * 3 + r] += M[r * 3] * imu.acc[i * 3] + M[r * 3 + 1] * imu.acc[i * 3 + 1] + M[r * 3 + 2] * imu.acc[i * 3 + 2]
        gyr[b * 3 + r] += M[r * 3] * imu.gyro[i * 3] + M[r * 3 + 1] * imu.gyro[i * 3 + 1] + M[r * 3 + 2] * imu.gyro[i * 3 + 2]
      }
    }
    ts[b] = t / B
    for (let r = 0; r < 3; r++) {
      acc[b * 3 + r] /= B
      gyr[b * 3 + r] /= B
    }
  }
  const dur = (ts[m - 1] - ts[0]) / 1e6
  const K = Math.max(2, Math.floor(dur / STEP) + 1)
  const tOut = (k: number): number => ts[0] + k * STEP * 1e6
  const dtb = (ts[m - 1] - ts[0]) / (m - 1)
  const idx = (t: number): number => Math.max(0, Math.min(m - 1, Math.round((t - ts[0]) / dtb)))
  // Riding or not: mean square of the gyro magnitude over 2 s (the orientation hardly changes while stopped).
  // Stopped periods (before departure, breaks, on the side stand) determine neither up nor fore-aft, so they are not used
  const moving = new Uint8Array(m)
  {
    const e = new Float64Array(m + 1)
    for (let b = 0; b < m; b++) e[b + 1] = e[b] + gyr[b * 3] ** 2 + gyr[b * 3 + 1] ** 2 + gyr[b * 3 + 2] ** 2
    for (let b = 0; b < m; b++) {
      const lo = Math.max(0, b - 10)
      const hi = Math.min(m, b + 11)
      moving[b] = Math.sqrt((e[hi] - e[lo]) / (hi - lo)) > MOVING_DPS ? 1 : 0
    }
  }
  // Gyro averaged over 0.5 s (only while riding)
  const H = 5
  const g5: V3[] = []
  const t5: number[] = []
  for (let b = 0; b + H <= m; b += H) {
    let mv = 0
    const s: V3 = [0, 0, 0]
    for (let j = b; j < b + H; j++) {
      mv += moving[j]
      for (let r = 0; r < 3; r++) s[r] += gyr[j * 3 + r] / H
    }
    if (mv < H) continue
    g5.push(s)
    t5.push(ts[b + (H >> 1)])
  }
  // Per-time estimates and their confidence (up = time spent riding, fore-aft = how much larger the falling-over rotation is than the other rotations)
  // Acceleration averaged over 1 s
  const acc1 = new Float64Array(m * 3)
  {
    const cs = new Float64Array((m + 1) * 3)
    for (let b = 0; b < m; b++) for (let r = 0; r < 3; r++) cs[(b + 1) * 3 + r] = cs[b * 3 + r] + acc[b * 3 + r]
    for (let b = 0; b < m; b++) {
      const lo = Math.max(0, b - 5)
      const hi = Math.min(m, b + 6)
      for (let r = 0; r < 3; r++) acc1[b * 3 + r] = (cs[hi * 3 + r] - cs[lo * 3 + r]) / (hi - lo)
    }
  }
  const ups: V3[] = []
  const upW: number[] = []
  const fwds: V3[] = []
  const fW: number[] = []
  for (let k = 0; k < K; k++) {
    const tc = tOut(k)
    const a0 = idx(tc - 3 * UP_SIGMA * 1e6)
    const a1 = idx(tc + 3 * UP_SIGMA * 1e6)
    const u: V3 = [0, 0, 0]
    let wu = 0
    for (let b = a0; b <= a1; b++) {
      if (!moving[b]) continue
      const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / UP_SIGMA) ** 2)
      wu += w
      for (let r = 0; r < 3; r++) u[r] += w * acc[b * 3 + r]
    }
    ups.push(wu > 0 ? unit(u) : ([-whole.R[1], -whole.R[4], -whole.R[7]] as V3))
    upW.push(wu)
  }
  // Relation between falling over and yaw: at each 10 Hz point, the yaw rate around up (the estimate at that time) and the integral of the rotation perpendicular to up (tilt.
  // The 10 s moving average is subtracted to remove drift). While turning, the bike tilts toward the inside of the turn around the axis of travel,
  // so the opposite of the direction of the coefficient from regressing the yaw rate on the tilt is forward. Mount shake (swinging fore-aft, etc.) is unrelated to how the bike turns, so it has no effect
  const kOf = (b: number): number => Math.max(0, Math.min(K - 1, Math.round((ts[b] - ts[0]) / 1e6 / STEP)))
  const tilt = new Float64Array(m * 3)
  const yawR = new Float64Array(m)
  {
    const ang: V3 = [0, 0, 0]
    const raw = new Float64Array(m * 3)
    for (let b = 0; b < m; b++) {
      const up = ups[kOf(b)]
      const g = gyr.subarray(b * 3, b * 3 + 3)
      const kk = dot(g, up)
      yawR[b] = kk
      for (let r = 0; r < 3; r++) {
        ang[r] += (g[r] - kk * up[r]) / 10
        raw[b * 3 + r] = ang[r]
      }
    }
    const cs = new Float64Array((m + 1) * 3)
    for (let b = 0; b < m; b++) for (let r = 0; r < 3; r++) cs[(b + 1) * 3 + r] = cs[b * 3 + r] + raw[b * 3 + r]
    for (let b = 0; b < m; b++) {
      const lo = Math.max(0, b - 50)
      const hi = Math.min(m, b + 51)
      for (let r = 0; r < 3; r++) tilt[b * 3 + r] = raw[b * 3 + r] - (cs[hi * 3 + r] - cs[lo * 3 + r]) / (hi - lo)
    }
  }
  const fwdsC: V3[] = []
  const qC: number[] = []
  let j5 = 0
  for (let k = 0; k < K; k++) {
    const tc = tOut(k)
    const up = ups[k]
    const C = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]
    while (j5 < t5.length && t5[j5] < tc - 3 * FWD_SIGMA * 1e6) j5++
    for (let j = j5; j < t5.length && t5[j] <= tc + 3 * FWD_SIGMA * 1e6; j++) {
      const w = Math.exp(-0.5 * ((t5[j] - tc) / 1e6 / FWD_SIGMA) ** 2)
      const g = g5[j]
      const kk = dot(g, up)
      const p = [g[0] - kk * up[0], g[1] - kk * up[1], g[2] - kk * up[2]]
      for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) C[a][c] += w * p[a] * p[c]
    }
    const e = eigSym3(C)
    let f = e.vectors[2]
    let kk = dot(f, up)
    f = unit([f[0] - kk * up[0], f[1] - kk * up[1], f[2] - kk * up[2]])
    // Acceleration/deceleration: principal component of the spread of the acceleration perpendicular to up (1 s average) around the window mean. Even while leaning, the bike has almost no lateral force,
    // so horizontal acceleration shows up in the fore-aft direction (accelerating, braking). The fore-aft axis is known even on straights with little turning
    const D = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]
    const mean: V3 = [0, 0, 0]
    let wsum = 0
    const lo = idx(tc - 3 * FWD_SIGMA * 1e6)
    const hi = idx(tc + 3 * FWD_SIGMA * 1e6)
    for (let pass = 0; pass < 2; pass++) {
      for (let b = lo; b <= hi; b++) {
        if (!moving[b]) continue
        const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / FWD_SIGMA) ** 2)
        // Remove gravity using the up at that time (because when the camera is rotating, up is off at the window edges)
        const a = acc1.subarray(b * 3, b * 3 + 3)
        const ub = ups[kOf(b)]
        const ka = dot(a, ub)
        const h = [a[0] - ka * ub[0] - mean[0], a[1] - ka * ub[1] - mean[1], a[2] - ka * ub[2] - mean[2]]
        if (pass === 0) {
          for (let r = 0; r < 3; r++) mean[r] += w * h[r]
          wsum += w
        } else for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) D[x][y] += w * h[x] * h[y]
      }
      if (pass === 0 && wsum > 0) for (let r = 0; r < 3; r++) mean[r] /= wsum
    }
    const ea = eigSym3(D)
    let fa = ea.vectors[2]
    kk = dot(fa, up)
    fa = unit([fa[0] - kk * up[0], fa[1] - kk * up[1], fa[2] - kk * up[2]])
    // Least squares of yaw rate ≈ β·tilt (2-D in the plane perpendicular to up). Forward = the direction of -β
    {
      const e1 = f as V3
      const e2 = cross(up, e1)
      let s11 = 0
      let s12 = 0
      let s22 = 0
      let c1 = 0
      let c2 = 0
      let syy = 0
      for (let b = lo; b <= hi; b++) {
        if (!moving[b]) continue
        const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / FWD_SIGMA) ** 2)
        const tv = tilt.subarray(b * 3, b * 3 + 3)
        const x1 = dot(tv, e1)
        const x2 = dot(tv, e2)
        const y = yawR[b]
        s11 += w * x1 * x1
        s12 += w * x1 * x2
        s22 += w * x2 * x2
        c1 += w * x1 * y
        c2 += w * x2 * y
        syy += w * y * y
      }
      // With almost no lateral tilt the regression becomes unstable, so suppress it slightly (ridge regression)
      const ridge = 0.05 * (s11 + s22)
      s11 += ridge
      s22 += ridge
      const det = s11 * s22 - s12 * s12
      if (det > 0 && syy > 0) {
        const b1 = (s22 * c1 - s12 * c2) / det
        const b2 = (s11 * c2 - s12 * c1) / det
        fwdsC.push(unit([-(b1 * e1[0] + b2 * e2[0]), -(b1 * e1[1] + b2 * e2[1]), -(b1 * e1[2] + b2 * e2[2])]))
        qC.push(Math.max(0, (b1 * c1 + b2 * c2) / syy)) // coefficient of determination
      } else {
        fwdsC.push(e1)
        qC.push(0)
      }
    }
    // Confidence: how much clearer the principal component is than the second (0-1)
    const qg = e.values[2] > 0 ? (e.values[2] - e.values[1]) / (e.values[2] + e.values[1]) : 0
    // With almost no acceleration/deceleration (spread below 0.01 g), it is not used as a cue
    const qa = wsum > 0 && ea.values[2] / wsum > 1e-4 ? (ea.values[2] - ea.values[1]) / (ea.values[2] + ea.values[1]) : 0
    // Combine the two: the falling-over rotation is accurate (1-3°) if clear, but it is off where there is little turning.
    // Acceleration/deceleration is known even on straights, but is off by a few degrees on slopes or with shake. Weight the clearer one more
    // When the falling-over rotation axis disagrees strongly with the regression axis from yaw, it is picking up mount shake (swinging fore-aft, etc.), so it is not used
    // When the acceleration/deceleration axis is clear and disagrees strongly with the falling-over rotation axis, the acceleration/deceleration one is also taken
    // (In my video, the acceleration/deceleration axis was off by up to 26°, while the falling-over rotation axis was off by 60-90° due to mount shake)
    const c30 = Math.cos((30 * Math.PI) / 180)
    const cG = fwdsC[k] && qC[k] > 0.1 ? Math.abs(dot(f, fwdsC[k])) : 1
    const offA = qa > 0.5 && Math.abs(dot(f, fa)) < c30
    const wg = cG < c30 || offA ? 0 : Math.max(0, qg - 0.1) ** 2
    const wa = 0.4 * Math.max(0, qa - 0.3) ** 2
    const sa = dot(fa, f) < 0 ? -1 : 1
    const fused = wg + wa > 0 ? unit([wg * f[0] + wa * sa * fa[0], wg * f[1] + wa * sa * fa[1], wg * f[2] + wa * sa * fa[2]]) : (f as V3)
    fwds.push(fused)
    fW.push(wg + wa)
  }
  // Align the fore-aft direction: chain the confident points in order, matching the immediately preceding confident direction
  const wMed = [...fW].sort((x, y) => x - y)[Math.floor(K / 2)]
  let ref: V3 = [whole.R[2], whole.R[5], whole.R[8]]
  for (let k = 0; k < K; k++) {
    if (dot(fwds[k], ref) < 0) fwds[k] = [-fwds[k][0], -fwds[k][1], -fwds[k][2]]
    if (fW[k] >= wMed) ref = fwds[k]
  }
  // Smooth in time weighted by confidence (stopped periods and places with little turning are filled with the nearby confident estimates)
  const smoothV = (v: V3[], w: number[], sigma: number): V3[] => {
    const out: V3[] = []
    for (let k = 0; k < K; k++) {
      let r = Math.ceil((3 * sigma) / STEP)
      for (;;) {
        const s: V3 = [0, 0, 0]
        let sw = 0
        for (let j = Math.max(0, k - r); j <= Math.min(K - 1, k + r); j++) {
          const g = w[j] * Math.exp(-0.5 * (((j - k) * STEP) / sigma) ** 2)
          sw += g
          for (let c = 0; c < 3; c++) s[c] += g * v[j][c]
        }
        if (sw > 1e-9 || r >= K) {
          out.push(sw > 1e-9 ? unit(s) : v[k])
          break
        }
        r *= 4 // if there is no confident point nearby, widen the search
      }
    }
    return out
  }
  const upS = smoothV(ups, upW, SMOOTH_SIGMA)
  const fS = smoothV(fwds, fW, SMOOTH_SIGMA).map((f, k) => {
    const u = upS[k]
    const kk = dot(f, u)
    return unit([f[0] - kk * u[0], f[1] - kk * u[1], f[2] - kk * u[2]])
  })
  for (let k = 0; k < K; k++) {
    ups[k] = upS[k]
    fwds[k] = fS[k]
  }
  // Points while riding (used to measure the size of the change)
  const movingK = upW.map((w) => w > 0)
  // Front vs. back: the relation of leaning into the turn (with the per-time forward/up: lean angle = integral of rotation around forward, yaw = angular velocity around up)
  const roll = new Float64Array(m)
  const yaw = new Float64Array(m)
  for (let b = 0; b < m; b++) {
    const k = Math.max(0, Math.min(K - 1, Math.round((ts[b] - ts[0]) / 1e6 / STEP)))
    const g = gyr.subarray(b * 3, b * 3 + 3)
    roll[b] = dot(g, fwds[k])
    yaw[b] = dot(g, ups[k])
  }
  const coupling = correlateLeanYaw(roll, yaw, 10)
  const by: 'lean' | 'lens' = Math.abs(coupling) >= FWD_MIN_CORR ? 'lean' : 'lens'
  const wholeF = [whole.R[2], whole.R[5], whole.R[8]]
  let flip = by === 'lean' ? coupling > 0 : false
  if (by === 'lens') {
    // When the turn relation is weak, align with the whole-video estimate (also decided by the lens orientation)
    let s = 0
    for (const f of fwds) s += dot(f, wholeF)
    flip = s < 0
  }
  if (flip) for (let k = 0; k < K; k++) fwds[k] = [-fwds[k][0], -fwds[k][1], -fwds[k][2]]
  // Size of the change: maximum difference from the whole-video estimate
  const wholeUp = [-whole.R[1], -whole.R[4], -whole.R[7]]
  let maxDeg = 0
  for (let k = 0; k < K; k++) {
    if (!movingK[k]) continue
    maxDeg = Math.max(maxDeg, angleDeg(ups[k], wholeUp), angleDeg(fwds[k], dot(fwds[k], wholeF) >= 0 ? wholeF : wholeF.map((v) => -v)))
  }
  const sameDir = by === whole.by || dot(fwds[0], wholeF) > 0
  if (maxDeg < FIXED_DEG && sameDir) return { ...fixedMount(whole.R, ts[0]), by: whole.by, maxDeg }
  if (maxDeg < FIXED_DEG) {
    // The change is small but the fore-aft decision differs: the whole-video estimate with front and back swapped
    const f = wholeF.map((v) => (dot(fwds[0], wholeF) >= 0 ? v : -v))
    return { ...fixedMount(mountMat(f, wholeUp), ts[0]), by, maxDeg }
  }
  const q = new Float64Array(K * 4)
  let prev: Quat | null = null
  for (let k = 0; k < K; k++) {
    let qk = matToQ(mountMat(fwds[k], ups[k]))
    // Align quaternion signs (so interpolation does not take the long way around)
    if (prev && qk[0] * prev[0] + qk[1] * prev[1] + qk[2] * prev[2] + qk[3] * prev[3] < 0) qk = [-qk[0], -qk[1], -qk[2], -qk[3]]
    q.set(qk, k * 4)
    prev = qk
  }
  return { t0: ts[0], dt: STEP * 1e6, q, fixed: false, by, maxDeg }
}

/** Correlation between the roll rate (integrated to lean angle; subtract a moving average over drift seconds) and the yaw rate. Samples are 10 Hz */
function correlateLeanYaw(roll: Float64Array, yaw: Float64Array, hz: number, drift = 10): number {
  const m = roll.length
  const ang = new Float64Array(m)
  for (let i = 1; i < m; i++) ang[i] = ang[i - 1] + roll[i] / hz
  const cs = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) cs[i + 1] = cs[i] + ang[i]
  const W = drift * hz
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

/**
 * Refine the mount orientation with the vehicle log (after the log and video are synchronized). For each time,
 *   up       = mean acceleration while riding (20 km/h or more) and not leaning (|lean angle| < 3°)
 *   fore-aft = in the plane perpendicular to up, the direction of the camera gyro that best matches the body roll rate (log). Front vs. back is also decided
 * are found with a Gaussian window (LOG_SIGMA s). At times with few cues from the log (stopped, long straights), the IMU-only estimate is kept.
 * More accurate than the IMU-only estimate (in my video, up 1-2°, forward 2-4°)
 */
const LOG_SIGMA = 30
/** When refined with the log the estimate spread is small, so use a single orientation if the change is smaller than this [deg] */
const LOG_FIXED_DEG = 9
export function refineMountWithLog(
  base: MountTrack,
  imu: Imu,
  log: { t: Float64Array; speed: Float64Array; lean: Float64Array; rollRate: Float64Array },
  sync: { a: number; b: number; sign: number },
  firstFrameUs: number,
  M: Mat3 = IMU_TO_RIG
): MountTrack {
  const n = imu.ts.length
  const rate = (n - 1) / ((imu.ts[n - 1] - imu.ts[0]) / 1e6)
  const B = Math.max(1, Math.round(rate / 10))
  const m = Math.floor(n / B)
  // Camera acceleration and gyro at 10 Hz, and the log at that time (vehicle speed, lean angle, roll rate)
  const ts = new Float64Array(m)
  const acc = new Float64Array(m * 3)
  const gyr = new Float64Array(m * 3)
  const sp = new Float64Array(m)
  const ln = new Float64Array(m)
  const rr = new Float64Array(m)
  let j = 0
  for (let b = 0; b < m; b++) {
    let t = 0
    for (let i = b * B; i < (b + 1) * B; i++) {
      t += imu.ts[i]
      for (let r = 0; r < 3; r++) {
        acc[b * 3 + r] += (M[r * 3] * imu.acc[i * 3] + M[r * 3 + 1] * imu.acc[i * 3 + 1] + M[r * 3 + 2] * imu.acc[i * 3 + 2]) / B
        gyr[b * 3 + r] += (M[r * 3] * imu.gyro[i * 3] + M[r * 3 + 1] * imu.gyro[i * 3 + 1] + M[r * 3 + 2] * imu.gyro[i * 3 + 2]) / B
      }
    }
    ts[b] = t / B
    const lt = sync.a * ((ts[b] - firstFrameUs) / 1e6) + sync.b
    while (j + 1 < log.t.length && log.t[j + 1] <= lt) j++
    const ok = lt >= log.t[0] && lt <= log.t[log.t.length - 1]
    sp[b] = ok ? log.speed[j] : NaN
    ln[b] = ok ? log.lean[j] : NaN
    rr[b] = ok ? log.rollRate[j] : NaN
  }
  // Sequence of times: if the original is a single orientation, every STEP s across the whole video
  const T0 = base.fixed ? ts[0] : base.t0
  const DT = base.fixed ? STEP * 1e6 : base.dt
  const K = base.fixed ? Math.max(2, Math.floor((ts[m - 1] - ts[0]) / DT) + 1) : base.q.length / 4
  const ups: V3[] = []
  const upW: number[] = []
  const fwds: V3[] = []
  const fW: number[] = []
  const dtb = (ts[m - 1] - ts[0]) / (m - 1)
  const idx = (t: number): number => Math.max(0, Math.min(m - 1, Math.round((t - ts[0]) / dtb)))
  for (let k = 0; k < K; k++) {
    const tc = T0 + k * DT
    const lo = idx(tc - 3 * LOG_SIGMA * 1e6)
    const hi = idx(tc + 3 * LOG_SIGMA * 1e6)
    const u: V3 = [0, 0, 0]
    let wu = 0
    const c: V3 = [0, 0, 0]
    let wr = 0
    for (let b = lo; b <= hi; b++) {
      const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / LOG_SIGMA) ** 2)
      if (sp[b] > 20 && Math.abs(ln[b]) < 3) {
        wu += w
        for (let r = 0; r < 3; r++) u[r] += w * acc[b * 3 + r]
      }
      if (Number.isFinite(rr[b])) {
        // The sign relation between the log roll rate and the camera roll rate is known from synchronization (sign)
        const x = sync.sign * rr[b]
        wr += w * x * x
        for (let r = 0; r < 3; r++) c[r] += w * gyr[b * 3 + r] * x
      }
    }
    const baseUp = mountUpAt(base, tc)
    const up = wu > 5 ? unit(u) : baseUp
    ups.push(up)
    upW.push(wu > 5 ? wu : 0)
    const kk = dot(c, up)
    const f = unit([c[0] - kk * up[0], c[1] - kk * up[1], c[2] - kk * up[2]])
    // The closer the regression magnitude (camera rotation per 1°/s of roll rate) is to 1, the more confident
    const gain = wr > 0 ? Math.hypot(c[0] - kk * up[0], c[1] - kk * up[1], c[2] - kk * up[2]) / wr : 0
    const okF = wr > 50 && gain > 0.5
    fwds.push(okF ? f : mountFwdAt(base, tc))
    fW.push(okF ? wr : 0)
  }
  // Fill unconfident times with the IMU-only estimate while smoothing in time
  const blend = (v: V3[], w: number[], baseAt: (t: number) => V3): V3[] => {
    const out: V3[] = []
    const wMax = Math.max(1e-9, ...w)
    for (let k = 0; k < K; k++) {
      const s: V3 = [0, 0, 0]
      const r = Math.ceil((2 * LOG_SIGMA * 1e6) / DT)
      for (let i = Math.max(0, k - r); i <= Math.min(K - 1, k + r); i++) {
        const g = (w[i] / wMax) * Math.exp(-0.5 * (((i - k) * DT) / 1e6 / LOG_SIGMA) ** 2)
        for (let x = 0; x < 3; x++) s[x] += g * v[i][x]
      }
      // Pull places with weak cues toward the IMU-only estimate
      const b0 = baseAt(T0 + k * DT)
      const wb = 0.05
      for (let x = 0; x < 3; x++) s[x] += wb * b0[x]
      out.push(unit(s))
    }
    return out
  }
  const upS = blend(ups, upW, (t) => mountUpAt(base, t))
  const fS = blend(fwds, fW, (t) => mountFwdAt(base, t))
  const q = new Float64Array(K * 4)
  let prev: Quat | null = null
  // Size of the change: maximum difference from the mean direction at times when the log had cues
  const meanOf = (v: V3[], w: number[]): V3 => {
    const s: V3 = [0, 0, 0]
    for (let k = 0; k < K; k++) for (let x = 0; x < 3; x++) s[x] += (w[k] > 0 ? 1 : 0) * v[k][x]
    return unit(s)
  }
  const f0 = meanOf(fS, fW)
  const u0 = meanOf(upS, upW)
  let maxDeg = 0
  for (let k = 0; k < K; k++) {
    const u = upS[k]
    const kk = dot(fS[k], u)
    const f = unit([fS[k][0] - kk * u[0], fS[k][1] - kk * u[1], fS[k][2] - kk * u[2]])
    if (fW[k] > 0) maxDeg = Math.max(maxDeg, angleDeg(f, f0))
    if (upW[k] > 0) maxDeg = Math.max(maxDeg, angleDeg(u, u0))
    let qk = matToQ(mountMat(f, u))
    if (prev && qk[0] * prev[0] + qk[1] * prev[1] + qk[2] * prev[2] + qk[3] * prev[3] < 0) qk = [-qk[0], -qk[1], -qk[2], -qk[3]]
    q.set(qk, k * 4)
    prev = qk
  }
  if (maxDeg < LOG_FIXED_DEG) {
    // If it hardly changes through the video, a single orientation (mean of forward/up per time)
    const mu: V3 = [0, 0, 0]
    const mf: V3 = [0, 0, 0]
    for (let k = 0; k < K; k++)
      for (let x = 0; x < 3; x++) {
        mu[x] += upS[k][x]
        mf[x] += fS[k][x]
      }
    const u = unit(mu)
    const kk = dot(mf, u)
    return { ...fixedMount(mountMat(unit([mf[0] - kk * u[0], mf[1] - kk * u[1], mf[2] - kk * u[2]]), u), T0), by: 'log', maxDeg }
  }
  return { t0: T0, dt: DT, q, fixed: false, by: 'log', maxDeg }
}
