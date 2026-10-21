// Loading the MotoReco vehicle log (CSV "TO Custom v1"), syncing it with the video, and fusing the lean angle.
// A port of proto/motoreco.py and proto/leanfusion.py. See docs/motoreco-lean.md for how it works.
import type { Imu } from './insv'
import { crossCorrelate, interpSorted, lowpassFiltfilt } from './dsp'
import { isRateInvalid } from './motoreco-dat'
import { matVec, type Mat3 } from './quat'
import { IMU_TO_RIG } from './motion'
import { mountFwdAt, mountUpAt, type MountTrack } from './mount'

export interface BikeLog {
  t: Float64Array // seconds (from the start of the log)
  lean: Float64Array // LeanAngle [deg]
  leanUpdated: Uint8Array // whether the value was updated on that row
  rollRate: Float64Array // invalid values are NaN
  speed: Float64Array
  lat: Float64Array
  lon: Float64Array
  /** All numeric columns (column name → values). Used for the telemetry display */
  columns: Map<string, Float64Array>
}

const FS = 100

export function parseMotoReco(text: string): BikeLog {
  const lines = text.split(/\r?\n/)
  let h = 0
  while (h < lines.length && !lines[h].startsWith('time')) h++
  if (h >= lines.length) throw new Error('Not a MotoReco CSV (no time column)')
  const cols = lines[h].split(',').map((c) => c.trim())
  const it = cols.indexOf('time (ms)')
  if (it < 0) throw new Error('Not a MotoReco CSV (no time column)')
  const rows = lines.length - h - 1
  const all = cols.map(() => new Float64Array(rows))
  let n = 0
  for (let i = h + 1; i < lines.length; i++) {
    const s = lines[i]
    if (!s) continue
    const v = s.split(',')
    for (let c = 0; c < cols.length; c++) all[c][n] = parseFloat(v[c])
    n++
  }
  const t = all[it].slice(0, n).map((v) => v / 1000)
  return bikeLogFromColumns(t, new Map(cols.map((c, i) => [c, all[i].slice(0, n)])))
}

/** Build a BikeLog from a table of column name → values (a decoded CSV or .dat). t is in seconds */
export function bikeLogFromColumns(t: Float64Array, columns: Map<string, Float64Array>): BikeLog {
  const need = (name: string): Float64Array => {
    const v = columns.get(name)
    if (!v) throw new Error(`Column ${name} is missing`)
    return v
  }
  const n = t.length
  const lean = need('LeanAngle')
  // "No reading" differs between the .dat decode and CSVs from older MotoRecoViewer builds (isRateInvalid)
  const rr = need('RollRate').map((r) => (isRateInvalid(r) ? NaN : r))
  const opt = (name: string): Float64Array => columns.get(name) ?? new Float64Array(n).fill(NaN)
  const upd = new Uint8Array(n)
  upd[0] = 1
  for (let i = 1; i < n; i++) upd[i] = lean[i] !== lean[i - 1] ? 1 : 0
  return { t, lean, leanUpdated: upd, rollRate: rr, speed: opt('Speed'), lat: opt('lat (deg)'), lon: opt('lon (deg)'), columns }
}

/** Project the camera gyro onto the body roll axis and make it 100 Hz (video time [s], deg/s) */
export function cameraRollRate(imu: Imu, mount: Mat3 | MountTrack, firstFrameUs: number, M: Mat3 = IMU_TO_RIG): { t: Float64Array; r: Float64Array } {
  if (!(mount instanceof Float64Array)) return cameraRate(imu, (t) => mountFwdAt(mount, t), firstFrameUs, M)
  return cameraRate(imu, [mount[2], mount[5], mount[8]], firstFrameUs, M) // 3rd column of R_mount = forward direction
}

/** Project the camera gyro onto the body yaw axis (up direction) and make it 100 Hz */
export function cameraYawRate(imu: Imu, mount: Mat3 | MountTrack, firstFrameUs: number, M: Mat3 = IMU_TO_RIG): { t: Float64Array; r: Float64Array } {
  if (!(mount instanceof Float64Array)) return cameraRate(imu, (t) => mountUpAt(mount, t), firstFrameUs, M)
  return cameraRate(imu, [-mount[1], -mount[4], -mount[7]], firstFrameUs, M) // the opposite of the 2nd column (down) of R_mount
}

/** Project the camera gyro onto the given axis (rig coordinates) and make it 100 Hz (video time [s], deg/s) */
export function cameraRate(imu: Imu, axis: number[] | ((tUs: number) => number[]), firstFrameUs: number, M: Mat3 = IMU_TO_RIG): { t: Float64Array; r: Float64Array } {
  // Split by video time into 10 ms bins and average (t is evenly spaced). It used to group 10 samples at a time, but the X5 IMU is not 1000 Hz but
  // about 996 Hz, so where it is treated as evenly spaced (cross-correlation in coarse sync, lean angle fusion) the time scale was off by 0.4%, and a 13-minute video was off by 2 s and could not be synced
  const n = imu.ts.length
  if (!n) return { t: new Float64Array(0), r: new Float64Array(0) }
  const t0 = Math.ceil(((imu.ts[0] - firstFrameUs) / 1e6) * FS) / FS
  const m = Math.max(0, Math.floor(((imu.ts[n - 1] - firstFrameUs) / 1e6 - t0) * FS))
  const t = new Float64Array(m)
  const r = new Float64Array(m)
  const cnt = new Float64Array(m)
  let fb = -1
  let f: number[] = typeof axis === 'function' ? [0, 0, 1] : axis
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((imu.ts[i] - firstFrameUs) / 1e6 - t0) * FS + 0.5)
    if (b < 0 || b >= m) continue
    // When the axis changes with time (time variation of the mount orientation), use the axis of each bin
    if (typeof axis === 'function' && b !== fb) {
      f = axis(firstFrameUs + (t0 + b / FS) * 1e6)
      fb = b
    }
    const g = matVec(M, [imu.gyro[i * 3], imu.gyro[i * 3 + 1], imu.gyro[i * 3 + 2]])
    r[b] += g[0] * f[0] + g[1] * f[1] + g[2] * f[2]
    cnt[b]++
  }
  // Fill empty bins (missing samples) from the neighbors
  let last = -1
  for (let b = 0; b < m; b++) {
    t[b] = t0 + b / FS
    if (cnt[b]) {
      r[b] /= cnt[b]
      if (last >= 0 && b - last > 1) for (let k = last + 1; k < b; k++) r[k] = r[last] + ((r[b] - r[last]) * (k - last)) / (b - last)
      last = b
    }
  }
  for (let b = last + 1; b < m; b++) r[b] = last >= 0 ? r[last] : 0
  return { t, r }
}

export interface SyncResult {
  a: number // log time = a·video time + b
  b: number
  sign: number
  peakRatio: number // main peak / second peak (sync confidence. 2 or more is generally reliable)
  windows: { t: number; offset: number; corr: number }[]
  residualMs: number
}

function corr(a: Float64Array, b: Float64Array, mask: Uint8Array): number {
  let n = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < a.length; i++)
    if (mask[i]) {
      n++
      sa += a[i]
      sb += b[i]
    }
  if (n < 10) return 0
  const ma = sa / n
  const mb = sb / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < a.length; i++)
    if (mask[i]) {
      const x = a[i] - ma
      const y = b[i] - mb
      sab += x * y
      saa += x * x
      sbb += y * y
    }
  return sab / Math.sqrt(saa * sbb + 1e-12)
}

/** Coarse sync: cross-correlation over the full range between the log roll rate and the camera roll rate (smoothed) */
function coarseSync(logT: Float64Array, rollRate: Float64Array, cr: Float64Array, camT0: number): { coarse: number; sign: number; peakRatio: number; peak: number } {
  const ng = Math.floor(logT[logT.length - 1] * FS)
  const grid = new Float64Array(ng).map((_, i) => i / FS)
  const rrClean = rollRate.map((v) => (Number.isNaN(v) ? 0 : v))
  const validF = rollRate.map((v) => (Number.isNaN(v) ? 0 : 1))
  const rr = interpSorted(grid, logT, rrClean)
  const valid = interpSorted(grid, logT, validF)
  for (let i = 0; i < ng; i++) if (valid[i] < 0.99) rr[i] = 0
  const norm = (x: Float64Array): Float64Array => {
    let m = 0
    for (const v of x) m += v
    m /= x.length
    let s = 0
    for (const v of x) s += (v - m) ** 2
    s = Math.sqrt(s / x.length) + 1e-12
    return x.map((v) => (v - m) / s)
  }
  const c = crossCorrelate(norm(rr), norm(cr))
  const L = cr.length - 1
  let j = 0
  for (let i = 1; i < c.length; i++) if (Math.abs(c[i]) > Math.abs(c[j])) j = i
  let second = 0
  for (let i = 0; i < c.length; i++) if (Math.abs(i - j) > 2 * FS) second = Math.max(second, Math.abs(c[i]))
  return { coarse: (j - L) / FS - camT0, sign: Math.sign(c[j]), peakRatio: Math.abs(c[j]) / (second + 1e-12), peak: Math.abs(c[j]) }
}

/**
 * A measure of whether the log is from the same ride as the video (coarse sync main peak / second peak. 2 or more is generally reliable).
 * Used to choose the .dat that matches the video from a folder
 */
export function logMatchScore(logT: Float64Array, rollRate: Float64Array, cam: { t: Float64Array; r: Float64Array }): { peakRatio: number; peak: number; offset: number } {
  if (logT.length < FS * 10) return { peakRatio: 0, peak: 0, offset: 0 }
  const r = coarseSync(logT, rollRate, lowpassFiltfilt(cam.r, 3, FS), cam.t[0])
  return { peakRatio: r.peakRatio, peak: r.peak, offset: r.coarse }
}

// Range of the shift to search per window [s] (from the coarse sync shift). If the camera clock and the log clock run at different rates, the shift changes within the video
// (X5 video of 2026-08-13: 2.9 s over 13 minutes, 0.37%. 0 on the X6). Chosen so a 25-minute video is reachable up to 0.5%
const SYNC_SEARCH_S = 4

export function syncLog(log: BikeLog, cam: { t: Float64Array; r: Float64Array }, windowS = 30): SyncResult {
  const cr = lowpassFiltfilt(cam.r, 3, FS) // remove stick vibration
  const rrClean = log.rollRate.map((v) => (Number.isNaN(v) ? 0 : v))
  const validF = log.rollRate.map((v) => (Number.isNaN(v) ? 0 : 1))
  // ---- 1. Coarse sync (full-range FFT cross-correlation) ----
  const { coarse, sign, peakRatio } = coarseSync(log.t, log.rollRate, cr, cam.t[0])

  // ---- 2. Refine per window ----
  // First search the coarse sync shift ±SYNC_SEARCH_S in 50 ms steps (decimated points), and fit a line to the window shifts (difference in clock rate).
  // Then refine ±60 ms around that line in 10 ms steps → 1 ms steps. It used to search only ±0.3 s around the coarse sync shift,
  // so with a camera whose clock runs at a different rate (X5), most windows were not found and sync failed (the lean angle became ±120° and the floating sign tilted)
  type Win = { t: number; tc: Float64Array; rc: Float64Array }
  const wins: Win[] = []
  for (let w0 = cam.t[0]; w0 + windowS < cam.t[cam.t.length - 1]; w0 += windowS / 2) {
    const i0 = Math.ceil((w0 - cam.t[0]) * FS)
    const i1 = i0 + Math.round(windowS * FS)
    const tc = cam.t.subarray(i0, i1)
    const rc = cr.subarray(i0, i1)
    let mean = 0
    for (const v of rc) mean += v
    mean /= rc.length
    let sd = 0
    for (const v of rc) sd += (v - mean) ** 2
    if (Math.sqrt(sd / rc.length) < 2) continue // a section that is all straight has no cues
    wins.push({ t: w0 + windowS / 2, tc, rc })
  }
  const evalOff = (w: Win, off: number, step = 1): number => {
    const tc = step > 1 ? w.tc.filter((_, i) => i % step === 0) : w.tc
    const rc = step > 1 ? w.rc.filter((_, i) => i % step === 0) : w.rc
    const tq = tc.map((v) => v + off)
    const lv = interpSorted(tq, log.t, rrClean)
    const ok = interpSorted(tq, log.t, validF)
    const mask = new Uint8Array(ok.length)
    let cnt = 0
    for (let i = 0; i < ok.length; i++) if (ok[i] > 0.99) (mask[i] = 1), cnt++
    if (cnt < 0.9 * ok.length) return -2
    return corr(lv, rc, mask) * sign
  }
  // Wide search
  const rough: { t: number; off: number; c: number }[] = []
  for (const w of wins) {
    let best = { c: -2, off: coarse }
    for (let off = coarse - SYNC_SEARCH_S; off <= coarse + SYNC_SEARCH_S; off += 0.05) {
      const v = evalOff(w, off, 5)
      if (v > best.c) best = { c: v, off }
    }
    if (best.c > 0.5) rough.push({ t: w.t, off: best.off, c: best.c })
  }
  // Robustly fit window shift = slope·t + intercept (median slope)
  let predict = (_t: number): number => coarse
  if (rough.length >= 3) {
    const slopes: number[] = []
    for (let i = 0; i < rough.length; i++) for (let j = i + 1; j < rough.length; j++) if (rough[j].t - rough[i].t > windowS) slopes.push((rough[j].off - rough[i].off) / (rough[j].t - rough[i].t))
    slopes.sort((x, y) => x - y)
    const slope = slopes.length ? slopes[slopes.length >> 1] : 0
    const ics = rough.map((r) => r.off - slope * r.t).sort((x, y) => x - y)
    const ic = ics[ics.length >> 1]
    predict = (t) => slope * t + ic
  }
  // Refine
  const windows: SyncResult['windows'] = []
  for (const w of wins) {
    const p0 = predict(w.t)
    let best = { c: -2, off: p0 }
    for (let off = p0 - 0.06; off <= p0 + 0.06; off += 0.01) {
      const v = evalOff(w, off)
      if (v > best.c) best = { c: v, off }
    }
    const base = best.off
    for (let off = base - 0.01; off <= base + 0.01; off += 0.001) {
      const v = evalOff(w, off)
      if (v > best.c) best = { c: v, off }
    }
    if (best.c > 0.5) windows.push({ t: w.t, offset: best.off, corr: best.c })
  }
  // Robustly fit t_log = t_v + off(t_v), off = (a-1)·t_v + b
  let a = 1
  let b = coarse
  let residualMs = NaN
  if (windows.length >= 3) {
    let use = windows.map(() => true)
    let coef = [0, coarse]
    for (let it = 0; it < 3; it++) {
      let sx = 0
      let sy = 0
      let sxx = 0
      let sxy = 0
      let n = 0
      windows.forEach((w, i) => {
        if (!use[i]) return
        sx += w.t
        sy += w.offset
        sxx += w.t * w.t
        sxy += w.t * w.offset
        n++
      })
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
      coef = [slope, (sy - slope * sx) / n]
      const res = windows.map((w) => Math.abs(w.offset - (coef[0] * w.t + coef[1])))
      const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)]
      use = res.map((r) => r < Math.max(3 * med, 0.002))
    }
    a = 1 + coef[0]
    b = coef[1]
    const res = windows.map((w) => w.offset - (coef[0] * w.t + coef[1]))
    residualMs = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length) * 1000
  }
  return { a, b, sign, peakRatio, windows, residualMs }
}

export interface LeanTrack {
  t: Float64Array // video time [s] (100 Hz)
  lean: Float64Array // actual lean angle [deg] (gyro scale)
  sd: Float64Array
  k: number // d(LeanAngle)/dt = k·ω_roll (correction of the log's scale)
  rateCorr: number
}

/** Fuse the gyro and the log's lean angle (Kalman filter + RTS smoothing) */
export function fuseLean(log: BikeLog, cam: { t: Float64Array; r: Float64Array }, sync: SyncResult): LeanTrack {
  const n = cam.t.length
  const logOnVideo = log.t.map((t) => (t - sync.b) / sync.a)
  // ---- Scale k: d(Lean)/dt ≈ k·ω_roll ----
  const L = interpSorted(cam.t, logOnVideo, log.lean)
  const Lf = lowpassFiltfilt(L, 1, FS)
  const wf = lowpassFiltfilt(cam.r, 1, FS)
  let swd = 0
  let sww = 0
  let sdd = 0
  for (let i = 1; i < n - 1; i++) {
    const dL = ((Lf[i + 1] - Lf[i - 1]) * FS) / 2
    if (Math.abs(wf[i]) > 200) continue
    swd += wf[i] * dL
    sww += wf[i] * wf[i]
    sdd += dL * dL
  }
  const k = swd / sww
  const rateCorr = swd / Math.sqrt(sww * sdd)

  // ---- Observations (only at times when the log value was updated, multiplied by 1/k to get the actual angle) ----
  const z = new Float64Array(n).fill(NaN)
  for (let i = 0; i < log.t.length; i++) {
    if (!log.leanUpdated[i]) continue
    const gi = Math.round((logOnVideo[i] - cam.t[0]) * FS)
    if (gi >= 0 && gi < n) z[gi] = log.lean[i] / k
  }
  const u = lowpassFiltfilt(cam.r, 3, FS)
  const dt = 1 / FS
  const q0 = (3 * dt) ** 2
  const q1 = (0.05 * dt) ** 2
  const R = (0.6 / k) ** 2
  // State [L, bias], F = [[1,-dt],[0,1]]
  const xs = new Float64Array(n * 2)
  const Ps = new Float64Array(n * 4)
  const xp = new Float64Array(n * 2)
  const Pp = new Float64Array(n * 4)
  let first = 0
  while (first < n && Number.isNaN(z[first])) first++
  let x0 = Number.isNaN(z[first]) ? 0 : z[first]
  let x1 = 0
  let p00 = 25
  let p01 = 0
  let p11 = 1
  for (let i = 0; i < n; i++) {
    // Predict
    x0 = x0 - dt * x1 + u[i] * dt
    const n00 = p00 - 2 * dt * p01 + dt * dt * p11 + q0
    const n01 = p01 - dt * p11
    const n11 = p11 + q1
    p00 = n00
    p01 = n01
    p11 = n11
    xp[i * 2] = x0
    xp[i * 2 + 1] = x1
    Pp.set([p00, p01, p01, p11], i * 4)
    // Update
    if (!Number.isNaN(z[i])) {
      const S = p00 + R
      const K0 = p00 / S
      const K1 = p01 / S
      const y = z[i] - x0
      x0 += K0 * y
      x1 += K1 * y
      const m00 = (1 - K0) * p00
      const m01 = (1 - K0) * p01
      const m11 = p11 - K1 * p01
      p00 = m00
      p01 = m01
      p11 = m11
    }
    xs[i * 2] = x0
    xs[i * 2 + 1] = x1
    Ps.set([p00, p01, p01, p11], i * 4)
  }
  // RTS smoothing
  for (let i = n - 2; i >= 0; i--) {
    const P = Ps.subarray(i * 4, i * 4 + 4)
    const Pn = Pp.subarray((i + 1) * 4, (i + 1) * 4 + 4)
    // C = P F^T Pn^-1
    const pf00 = P[0] - dt * P[1]
    const pf01 = P[1]
    const pf10 = P[2] - dt * P[3]
    const pf11 = P[3]
    const det = Pn[0] * Pn[3] - Pn[1] * Pn[2]
    const i00 = Pn[3] / det
    const i01 = -Pn[1] / det
    const i10 = -Pn[2] / det
    const i11 = Pn[0] / det
    const c00 = pf00 * i00 + pf01 * i10
    const c01 = pf00 * i01 + pf01 * i11
    const c10 = pf10 * i00 + pf11 * i10
    const c11 = pf10 * i01 + pf11 * i11
    const d0 = xs[(i + 1) * 2] - xp[(i + 1) * 2]
    const d1 = xs[(i + 1) * 2 + 1] - xp[(i + 1) * 2 + 1]
    xs[i * 2] += c00 * d0 + c01 * d1
    xs[i * 2 + 1] += c10 * d0 + c11 * d1
    // P = P + C (Ps_next - Pn) C^T
    const Psn = Ps.subarray((i + 1) * 4, (i + 1) * 4 + 4)
    const e00 = Psn[0] - Pn[0]
    const e01 = Psn[1] - Pn[1]
    const e10 = Psn[2] - Pn[2]
    const e11 = Psn[3] - Pn[3]
    const t00 = c00 * e00 + c01 * e10
    const t01 = c00 * e01 + c01 * e11
    const t10 = c10 * e00 + c11 * e10
    const t11 = c10 * e01 + c11 * e11
    Ps[i * 4] = P[0] + t00 * c00 + t01 * c01
    Ps[i * 4 + 1] = P[1] + t00 * c10 + t01 * c11
    Ps[i * 4 + 2] = P[2] + t10 * c00 + t11 * c01
    Ps[i * 4 + 3] = P[3] + t10 * c10 + t11 * c11
  }
  const lean = new Float64Array(n)
  const sd = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lean[i] = xs[i * 2]
    sd[i] = Math.sqrt(Math.max(Ps[i * 4], 0))
  }
  return { t: cam.t, lean, sd, k, rateCorr }
}
