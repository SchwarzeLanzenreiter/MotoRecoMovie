// Telemetry unification: gather each column of the vehicle log and the fused lean angle into evenly spaced (100 Hz)
// channels aligned to the video time. Used both for the gauge display (overlay) and for riding-state detection (auto camera).
//
// See docs/telemetry.md for how columns are chosen (e.g. speed uses the 10 ms-update front wheel speed FrSpeed1, not the 1 s-update Speed).
import type { DisturbTrack } from './disturb'
import { gaussianFilter, interpSorted, lowpassFiltfilt } from './dsp'
import { isRateInvalid } from './motoreco-dat'
import type { BikeLog, LeanTrack, SyncResult } from './motoreco'
import type { RidingTrack } from './riding'
import type { NavTrack } from './nav'
import type { Corner } from './corners'

export const TELEMETRY_RATE = 100 // Hz

export type ChannelKey =
  | 'speed'
  | 'rpm'
  | 'gear'
  | 'lean'
  | 'airTemp'
  | 'accelG'
  | 'latG'
  | 'throttle'
  | 'brakeFront'
  | 'brakeRear'
  | 'lat'
  | 'lon'
  | 'alt'
  | 'heading'
  | 'grade'
  | 'distance'
  | 'gpsX'
  | 'gpsY'
  | 'slip'
  | 'frStroke'
  | 'rrStroke'
  | 'rollRate'
  | 'yawRate'
  | 'xG'
  | 'zG'

export interface ChannelInfo {
  label: string
  unit: string
  /** 'step' = stepwise value (gear, etc.). Not interpolated; the previous value is used */
  interp: 'linear' | 'step' | 'angle'
}

export const CHANNELS: Record<ChannelKey, ChannelInfo> = {
  speed: { label: 'Speed', unit: 'km/h', interp: 'linear' }, // i18n-ignore
  rpm: { label: 'Engine RPM', unit: 'rpm', interp: 'linear' }, // i18n-ignore
  gear: { label: 'Gear', unit: '', interp: 'step' }, // i18n-ignore
  lean: { label: 'Lean angle', unit: '°', interp: 'linear' }, // i18n-ignore
  airTemp: { label: 'Air temperature', unit: '℃', interp: 'linear' }, // i18n-ignore
  accelG: { label: 'Longitudinal accel', unit: 'G', interp: 'linear' }, // i18n-ignore
  latG: { label: 'Lateral accel', unit: 'G', interp: 'linear' }, // i18n-ignore
  throttle: { label: 'Throttle', unit: '%', interp: 'linear' }, // i18n-ignore
  brakeFront: { label: 'Front brake', unit: 'bar', interp: 'linear' }, // i18n-ignore
  brakeRear: { label: 'Rear brake', unit: 'bar', interp: 'linear' }, // i18n-ignore
  lat: { label: 'Latitude', unit: '°', interp: 'linear' }, // i18n-ignore
  lon: { label: 'Longitude', unit: '°', interp: 'linear' }, // i18n-ignore
  alt: { label: 'Elevation', unit: 'm', interp: 'linear' }, // i18n-ignore
  heading: { label: 'Heading', unit: '°', interp: 'angle' }, // i18n-ignore
  grade: { label: 'Grade', unit: '%', interp: 'linear' }, // i18n-ignore
  distance: { label: 'Distance', unit: 'km', interp: 'linear' }, // i18n-ignore
  gpsX: { label: 'East-west position', unit: 'm', interp: 'linear' }, // i18n-ignore
  gpsY: { label: 'North-south position', unit: 'm', interp: 'linear' }, // i18n-ignore
  slip: { label: 'Slip ratio', unit: '%', interp: 'linear' }, // i18n-ignore
  frStroke: { label: 'Front stroke', unit: 'mm', interp: 'linear' }, // i18n-ignore
  rrStroke: { label: 'Rear stroke', unit: 'mm', interp: 'linear' }, // i18n-ignore
  rollRate: { label: 'Roll rate (vehicle)', unit: '°/s', interp: 'linear' }, // i18n-ignore
  yawRate: { label: 'Yaw rate (vehicle)', unit: '°/s', interp: 'linear' }, // i18n-ignore
  xG: { label: 'Longitudinal G (vehicle sensor)', unit: 'G', interp: 'linear' }, // i18n-ignore
  zG: { label: 'Vertical G (vehicle sensor)', unit: 'G', interp: 'linear' } // i18n-ignore
}

export interface GpsTrack {
  /** Origin (the first valid fix) */
  lat0: number
  lon0: number
  /** Plane coordinates [m] (east, north). A trajectory smoothly connecting the 1 Hz fixes (every 1 s, for drawing the map) */
  x: Float32Array
  y: Float32Array
  t: Float32Array // video time [s]
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
}

export interface Telemetry {
  rate: number
  n: number
  /** Video time of the start of the grid [s] (= 0) */
  t0: number
  channels: Partial<Record<ChannelKey, Float32Array>>
  gps: GpsTrack | null
  /** Riding state (accelerating, decelerating, etc.). Used to switch the gauge appearance */
  riding?: RidingTrack
  /** Fused heading and position (gyro + front wheel speed + GPS). Used to draw signs fixed to a location */
  nav?: NavTrack
  /** List of corners and curve radii */
  corners?: Corner[]
  /** Strength of the bike's disturbance (per time) */
  disturb?: DisturbTrack
  /**
   * Where it was made from. 'imu' = estimated from the video's IMU because there is no vehicle log (core/imu-telemetry.ts. Only lean angle, vehicle speed, longitudinal G and the shape of the road traveled).
   * Not used for the gauges (so that estimated vehicle speed etc. is not shown as if it were measured)
   */
  source?: 'log' | 'imu'
}

const R_EARTH = 6378137

/** Median filter to remove outliers (single spikes) */
function median(x: Float64Array, half: number): Float64Array {
  const out = new Float64Array(x.length)
  const w: number[] = []
  for (let i = 0; i < x.length; i++) {
    w.length = 0
    for (let k = Math.max(0, i - half); k <= Math.min(x.length - 1, i + half); k++) w.push(x[k])
    w.sort((a, b) => a - b)
    out[i] = w[w.length >> 1]
  }
  return out
}

/** Extract only the rows where the value actually changed (removes duplicates such as 1 s-update GPS) */
function changes(t: Float64Array, ...cols: Float64Array[]): { t: Float64Array; v: Float64Array[] } {
  const idx: number[] = []
  for (let i = 0; i < t.length; i++) {
    if (cols.some((c) => !Number.isFinite(c[i]))) continue
    if (idx.length === 0 || cols.some((c) => c[i] !== c[idx[idx.length - 1]])) idx.push(i)
  }
  return { t: Float64Array.from(idx, (i) => t[i]), v: cols.map((c) => Float64Array.from(idx, (i) => c[i])) }
}

/** Cubic Hermite (Catmull-Rom) interpolation. Smoothly connects the 1 Hz GPS */
function catmullRom(xs: Float64Array, ys: Float64Array, xq: Float64Array): Float64Array {
  const n = xs.length
  const out = new Float64Array(xq.length)
  if (n < 2) return out.fill(n ? ys[0] : NaN)
  const slope = (i: number): number => {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    return (ys[b] - ys[a]) / (xs[b] - xs[a])
  }
  let j = 0
  for (let q = 0; q < xq.length; q++) {
    const x = xq[q]
    if (x <= xs[0]) {
      out[q] = ys[0]
      continue
    }
    if (x >= xs[n - 1]) {
      out[q] = ys[n - 1]
      continue
    }
    while (j < n - 2 && xs[j + 1] < x) j++
    const h = xs[j + 1] - xs[j]
    const s = (x - xs[j]) / h
    const s2 = s * s
    const s3 = s2 * s
    out[q] = (2 * s3 - 3 * s2 + 1) * ys[j] + (s3 - 2 * s2 + s) * h * slope(j) + (-2 * s3 + 3 * s2) * ys[j + 1] + (s3 - s2) * h * slope(j + 1)
  }
  return out
}

/**
 * Keep a short 0 (neutral) in the middle of a gear shift at the previous gear. The gear signal sends 0 for only 0.1-0.2 s during a shift,
 * so as is it flickers "1 → N → 2". Only 0s shorter than SHIFT_GAP seconds between gears are filled (long 0s from stopping and shifting into neutral are kept)
 */
const SHIFT_GAP = 0.5
export function holdThroughShift(gear: Float32Array, rate: number): Float32Array {
  const out = gear.slice()
  const maxLen = Math.round(SHIFT_GAP * rate)
  let i = 0
  while (i < out.length) {
    if (out[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < out.length && out[j] === 0) j++
    if (i > 0 && j < out.length && out[i - 1] > 0 && out[j] > 0 && j - i < maxLen) out.fill(out[i - 1], i, j)
    i = j
  }
  return out
}

/**
 * From the vehicle log and the fused lean angle, build the unified telemetry for video time 0 to durationSec.
 * If lean is null (no log), the lean angle channel is not made.
 */
export function buildTelemetry(log: BikeLog, sync: SyncResult, lean: LeanTrack | null, durationSec: number, gpsDelaySec = 0): Telemetry {
  const rate = TELEMETRY_RATE
  const n = Math.floor(durationSec * rate) + 1
  const grid = new Float64Array(n).map((_, i) => i / rate)
  // Log time → video time
  const tv = log.t.map((t) => (t - sync.b) / sync.a)
  const col = (name: string): Float64Array | null => log.columns.get(name) ?? null
  const ch: Telemetry['channels'] = {}
  const linear = (v: Float64Array): Float32Array => Float32Array.from(interpSorted(grid, tv, v))
  const stepOf = (v: Float64Array): Float32Array => {
    const out = new Float32Array(n)
    let j = 0
    for (let i = 0; i < n; i++) {
      while (j < tv.length - 1 && tv[j + 1] <= grid[i]) j++
      out[i] = v[j]
    }
    return out
  }

  // Speed: front wheel speed (10 ms update). Remove single spikes (up to 469 km/h, etc.) with the median
  const fr = col('FrSpeed1') ?? col('Speed')
  if (fr) {
    ch.speed = linear(median(fr, 4))
    // Longitudinal acceleration [G]: from the rate of change of speed. The log's X_Axis_G includes the gravity component of slopes (regression against gradient 0.94),
    // and also saturates at -0.45 G (mean -0.455 during hard braking), so it is not used
    const sm = gaussianFilter(Float64Array.from(ch.speed), 0.15 * rate)
    const acc = new Float64Array(n)
    for (let i = 1; i < n - 1; i++) acc[i] = ((sm[i + 1] - sm[i - 1]) * rate) / 2 / 3.6 / 9.80665
    acc[0] = acc[1]
    acc[n - 1] = acc[n - 2]
    ch.accelG = Float32Array.from(gaussianFilter(acc, 0.1 * rate))
  }
  const rpm = col('RPM')
  if (rpm) ch.rpm = linear(rpm)
  const gear = col('Gear')
  if (gear) ch.gear = holdThroughShift(stepOf(gear), rate)
  const air = col('AirTemp')
  if (air) ch.airTemp = linear(air)
  // Lateral acceleration: remove the invalid values at the start (around -3.7)
  const fixG = (v: Float64Array): Float64Array => v.map((x) => (x < -3 ? 0 : x))
  const yg = col('Y_Axis_G')
  if (yg) ch.latG = Float32Array.from(gaussianFilter(interpSorted(grid, tv, fixG(yg)), 5))
  const thr = col('ThrottelPosition')
  if (thr) ch.throttle = linear(thr)
  const bfu = col('FrBrakeUp')
  const bfd = col('FrBrakeDown')
  if (bfu || bfd) {
    const a = bfu ?? bfd!
    const b = bfd ?? bfu!
    ch.brakeFront = linear(a.map((v, i) => Math.max(v, b[i])))
  }
  const br = col('RrBrake1')
  if (br) ch.brakeRear = linear(br)
  // For detecting bike disturbance (core/disturb.ts): slip ratio, suspension stroke, and the vehicle's 6-axis sensor (raw values)
  const raw: [ChannelKey, string, boolean][] = [
    ['slip', 'SlipRate', false],
    ['frStroke', 'FrStroke', false],
    ['rrStroke', 'RrStroke', false],
    ['rollRate', 'RollRate', false],
    ['yawRate', 'YawRate', false],
    ['xG', 'X_Axis_G', true],
    ['zG', 'Z_Axis_G', true]
  ]
  // Rates: also remove the invalid values at the start ("no reading", isRateInvalid)
  const fixRate = (v: Float64Array): Float64Array => v.map((x) => (isRateInvalid(x) ? 0 : x))
  for (const [k, name, isG] of raw) {
    const v = col(name)
    if (v) ch[k] = linear(isG ? fixG(v) : k === 'rollRate' || k === 'yawRate' ? fixRate(v) : v)
  }
  if (lean) ch.lean = Float32Array.from(interpSorted(grid, lean.t, lean.lean))

  // ---- GPS (1 Hz) ----
  let gps: GpsTrack | null = null
  const la = col('lat (deg)')
  const lo = col('lon (deg)')
  if (la && lo) {
    const valid = (i: number): boolean => Number.isFinite(la[i]) && Number.isFinite(lo[i]) && (la[i] !== 0 || lo[i] !== 0)
    const okIdx = tv.map((_, i) => (valid(i) ? 1 : 0))
    const tOk = Float64Array.from(tv.filter((_, i) => okIdx[i]))
    const laOk = Float64Array.from(la.filter((_, i) => okIdx[i]))
    const loOk = Float64Array.from(lo.filter((_, i) => okIdx[i]))
    const c = changes(tOk, laOk, loOk)
    if (c.t.length >= 2) {
      const lat0 = c.v[0][0]
      const lon0 = c.v[1][0]
      const kx = ((Math.PI / 180) * R_EARTH * Math.cos((lat0 * Math.PI) / 180))
      const ky = (Math.PI / 180) * R_EARTH
      const ex = c.v[1].map((v) => (v - lon0) * kx)
      const ny = c.v[0].map((v) => (v - lat0) * ky)
      // Fix time = the time the value changed in the log - gpsDelay (the delay from the fix to appearing in the log)
      const tFix = c.t.map((t) => t - gpsDelaySec)
      const gx = catmullRom(tFix, ex, grid)
      const gy = catmullRom(tFix, ny, grid)
      ch.lat = Float32Array.from(gy, (y) => lat0 + y / ky)
      ch.lon = Float32Array.from(gx, (x) => lon0 + x / kx)
      // Plane coordinates for drawing the map [m] (origin = first fix, east = +x, north = +y)
      ch.gpsX = Float32Array.from(gx)
      ch.gpsY = Float32Array.from(gy)
      // Heading: from the difference with 0.5 s ahead (north = 0°, east = 90°). While stopped, keep the previous value
      const head = new Float32Array(n)
      const L = Math.round(0.5 * rate)
      let last = 0
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - L)
        const b = Math.min(n - 1, i + L)
        const dx = gx[b] - gx[a]
        const dy = gy[b] - gy[a]
        if (Math.hypot(dx, dy) > 1.0) last = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
        head[i] = last
      }
      ch.heading = head
      // Distance traveled [km]
      const dist = new Float32Array(n)
      for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(gx[i] - gx[i - 1], gy[i] - gy[i - 1]) / 1000
      ch.distance = dist
      // Trajectory for the map (every 1 s)
      const m = Math.floor(durationSec) + 1
      const tx = new Float32Array(m)
      const ty = new Float32Array(m)
      const tt = new Float32Array(m)
      let b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
      for (let i = 0; i < m; i++) {
        const gi = Math.min(n - 1, i * rate)
        tx[i] = gx[gi]
        ty[i] = gy[gi]
        tt[i] = i
        b = { minX: Math.min(b.minX, tx[i]), maxX: Math.max(b.maxX, tx[i]), minY: Math.min(b.minY, ty[i]), maxY: Math.max(b.maxY, ty[i]) }
      }
      gps = { lat0, lon0, x: tx, y: ty, t: tt, bounds: b }
    }
    // Altitude and gradient
    const alt = col('alt (m)')
    if (alt) {
      const altOk = Float64Array.from(alt.filter((_, i) => okIdx[i]))
      const ca = changes(tOk, altOk)
      if (ca.t.length >= 2) {
        const g = gaussianFilter(catmullRom(ca.t.map((t) => t - gpsDelaySec), ca.v[0], grid), 1.0 * rate)
        ch.alt = Float32Array.from(g)
        if (ch.distance) {
          // Gradient [%] = altitude difference / distance traveled (from the difference over 3 s before and after. Unstable when slow, so treated as 0)
          const grade = new Float32Array(n)
          const W = 3 * rate
          for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - W)
            const bb = Math.min(n - 1, i + W)
            const dd = (ch.distance[bb] - ch.distance[a]) * 1000
            grade[i] = dd > 20 ? ((g[bb] - g[a]) / dd) * 100 : 0
          }
          ch.grade = grade
        }
      }
    }
  }
  // Time ranges where the log does not exist (e.g. where the recording started before the log) and the first 0.5 s after the log starts up
  // (invalid values go in. e.g. front wheel speed 469 km/h) are made "no data" (NaN). Lean angle is available for the whole range from the gyro
  const tStart = tv[0] + 0.5
  const tEnd = tv[tv.length - 1]
  for (const [k, d] of Object.entries(ch) as [ChannelKey, Float32Array][]) {
    if (k === 'lean') continue
    const margin = k === 'accelG' ? 0.5 : 0 // derived values keep edge effects, so a little wider
    for (let i = 0; i < n; i++) if (grid[i] < tStart + margin || grid[i] > tEnd - margin) d[i] = NaN
  }
  return { rate, n, t0: 0, channels: ch, gps }
}

/** Value of a channel at video time t [s] (null if there is none or in a no-data range) */
export function sampleChannel(tel: Telemetry, key: ChannelKey, t: number): number | null {
  const d = tel.channels[key]
  if (!d) return null
  const x = (t - tel.t0) * tel.rate
  const ok = (v: number): number | null => (Number.isNaN(v) ? null : v)
  if (x <= 0) return ok(d[0])
  if (x >= tel.n - 1) return ok(d[tel.n - 1])
  const i = Math.floor(x)
  const f = x - i
  if (Number.isNaN(d[i]) || Number.isNaN(d[i + 1])) return null
  const info = CHANNELS[key]
  if (info.interp === 'step') return d[i]
  if (info.interp === 'angle') {
    const dd = ((((d[i + 1] - d[i]) % 360) + 540) % 360) - 180
    return (d[i] + dd * f + 360) % 360
  }
  return d[i] + (d[i + 1] - d[i]) * f
}

/** Values of all channels at the given time */
export function sampleAll(tel: Telemetry, t: number): Partial<Record<ChannelKey, number>> {
  const out: Partial<Record<ChannelKey, number>> = {}
  for (const k of Object.keys(tel.channels) as ChannelKey[]) {
    const v = sampleChannel(tel, k, t)
    if (v !== null) out[k] = v
  }
  return out
}

/**
 * Estimate the GPS delay (from the fix to appearing in the log) [s].
 * Find the shift at which the rate of change of GPS heading best matches the gyro yaw rate (around the body's up axis).
 * About 1.0 s in this sample (correlation 0.93). tel is the one made with delay 0.
 */
export function estimateGpsDelay(tel: Telemetry, yaw: { t: Float64Array; r: Float64Array }): { delay: number; corr: number } {
  const h = tel.channels.heading
  const sp = tel.channels.speed
  if (!h || !sp) return { delay: 0, corr: 0 }
  const rate = tel.rate
  const n = tel.n
  // Heading change rate [deg/s] (1 s-wide difference, accounting for the ±180 wrap-around)
  const hr = new Float64Array(n)
  const H = Math.round(rate / 2)
  for (let i = H; i < n - H; i++) hr[i] = ((((h[i + H] - h[i - H]) % 360) + 540) % 360) - 180
  const yawLp = lowpassFiltfilt(yaw.r, 0.5, 100)
  const y = interpSorted(new Float64Array(n).map((_, i) => i / rate), yaw.t, yawLp)
  let best = { delay: 0, corr: 0 }
  for (let d = -0.5; d <= 3.0001; d += 0.05) {
    // Correlation between the heading change rate corrected for delay d, hr(t + d), and the yaw rate y(t)
    const k = Math.round(d * rate)
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let i = rate; i < n - rate; i += 5) {
      const j = i + k
      // Exclude ranges with no log (NaN). If mixed in, the correlation becomes NaN and the estimate is always 0
      if (j < H || j >= n - H || !(sp[i] >= 20) || Number.isNaN(hr[j]) || Number.isNaN(y[i])) continue
      sxy += hr[j] * y[i]
      sxx += hr[j] * hr[j]
      syy += y[i] * y[i]
    }
    const c = sxy / Math.sqrt(sxx * syy + 1e-12)
    if (Math.abs(c) > Math.abs(best.corr)) best = { delay: Math.round(d * 100) / 100, corr: c }
  }
  return best
}
