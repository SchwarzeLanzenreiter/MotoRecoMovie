// Decode the raw MotoReco log (.dat) with the same conversion rules (.ddf) as MotoRecoViewer.
// The built-in rule formulas and the steps up to the table (sorting, smoothing, accumulation, the 10 ms table) are a port of MotoRecoViewer's source
// (DecodeRule.cs, Model/ChData.cs, Analysis/ChannelAnalyzer.cs, FormMain.Data.cs, FormMain.Export.cs).
// The output is a table with the same column names and the same 10 ms step as MotoRecoViewer's CSV ("TO Custom v1"), and can be used as a BikeLog as is. See docs/motoreco-dat.md

/** One .dat record = 16 bytes: u32 seconds, u16 milliseconds, u16 CAN ID (all little-endian), 8 bytes of data */
export const DAT_RECORD = 16

/** One .ddf row: name, CAN ID (hex), rule, color, min, max, display, ..., smoothing, cutoff [Hz] */
export interface DdfChannel {
  name: string
  id: number
  rule: string
  /** Column 9: whether to apply smoothing (2nd-order Butterworth, forward and backward) */
  filter: boolean
  /** Column 10: smoothing cutoff frequency [Hz] */
  cutoffHz: number
}

export function parseDdf(text: string): DdfChannel[] {
  const out: DdfChannel[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const f = line.split(',')
    if (f.length < 3) continue
    const id = parseInt(f[1].trim(), 16)
    if (!Number.isFinite(id)) continue
    const cutoff = parseFloat(f[9] ?? '')
    out.push({ name: f[0].trim(), id, rule: f[2].trim(), filter: (f[8] ?? '').trim().toLowerCase() === 'true', cutoffHz: Number.isFinite(cutoff) ? cutoff : 0 })
  }
  if (!out.length) throw new Error('The .ddf has no channels')
  return out
}

/** Function that computes a value from 8 bytes of data (d[o] to d[o+7]) */
type Fn = (d: Uint8Array, o: number) => number

// ---- Formula rules (Data1-8, LoData1-8, HiData1-8, numbers, + - * / and parentheses) ----
export function compileFormula(src: string): Fn {
  const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|[-+*/()]/gi) ?? []
  if (toks.join('') !== src.replace(/\s+/g, '')) throw new Error(`Cannot read the formula: ${src}`)
  let p = 0
  const peek = (): string | undefined => toks[p]
  const expr = (): Fn => {
    let a = term()
    while (peek() === '+' || peek() === '-') {
      const op = toks[p++]
      const l = a
      const r = term()
      a = op === '+' ? (d, o) => l(d, o) + r(d, o) : (d, o) => l(d, o) - r(d, o)
    }
    return a
  }
  const term = (): Fn => {
    let a = unary()
    while (peek() === '*' || peek() === '/') {
      const op = toks[p++]
      const l = a
      const r = unary()
      a = op === '*' ? (d, o) => l(d, o) * r(d, o) : (d, o) => l(d, o) / r(d, o)
    }
    return a
  }
  const unary = (): Fn => {
    if (peek() === '-') {
      p++
      const a = unary()
      return (d, o) => -a(d, o)
    }
    if (peek() === '+') p++
    return atom()
  }
  const atom = (): Fn => {
    const tk = toks[p++]
    if (tk === undefined) throw new Error(`Cannot read the formula: ${src}`)
    if (tk === '(') {
      const a = expr()
      if (toks[p++] !== ')') throw new Error(`Cannot read the formula: ${src}`)
      return a
    }
    if (/^[\d.]/.test(tk)) {
      const v = parseFloat(tk)
      return () => v
    }
    const m = /^(lo|hi)?data([1-8])$/i.exec(tk)
    if (!m) throw new Error(`Cannot read the formula: ${src}`)
    const i = Number(m[2]) - 1
    const part = m[1]?.toLowerCase()
    if (part === 'lo') return (d, o) => d[o + i] & 15
    if (part === 'hi') return (d, o) => d[o + i] >> 4
    return (d, o) => d[o + i]
  }
  const f = expr()
  if (p !== toks.length) throw new Error(`Cannot read the formula: ${src}`)
  return f
}

// ---- Built-in rules (the same formulas as MotoRecoViewer's DecodeRule.FixedFormula) ----
const D = (d: Uint8Array, o: number, n: number): number => d[o + n - 1]
const LO = (d: Uint8Array, o: number, n: number): number => d[o + n - 1] & 15
const HI = (d: Uint8Array, o: number, n: number): number => d[o + n - 1] >> 4
const U32 = (d: Uint8Array, o: number, n: number): number => d[o + n - 1] + d[o + n] * 256 + d[o + n + 1] * 65536 + d[o + n + 2] * 16777216
/**
 * CAN IDs 0x174 / 0x178 / 0x17C are the messages of a Bosch Motorsport MM5.10 IMU, and its data sheet gives the encoding: every
 * signal is 16-bit offset binary about 0x8000, 0.005 deg/s per count for the yaw and roll rate (range +-163 deg/s) and
 * 0.0001274 g per count for the accelerations (+-4.2 g). The data sheet puts the accelerations in bytes 2-3; in the bike's log
 * they are in bytes 4-5 (Data5 low, Data6 high), where Z averages one gravity. The same rules as MotoRecoViewer's DecodeRule
 * (commit 352b6bc).
 *
 * The rules used before were inferred, not specified: D2*125/127 + D1/255 - 125 for the rates and (D6 + D5/255 - 128)/32 for the
 * accelerations. They put the rates at about 3/4 of the true value with the zero one count off, and the accelerations about 4% low.
 * The rate error had been measured from the data before the data sheet was found (MotoRecoViewer commits 60db916 and dfec59b):
 *   - GPS track curvature against the rate over the 110 corners of 20260919_143356.dat, and d(LeanAngle)/dt against the camera
 *     gyro (docs/motoreco-lean.md), both put the old rule at 3/4 of true. The data sheet scale is within 2% of that.
 *   - The roll rate integrated over a ride has to come back near zero, because the bike is upright at both ends: 2190.8 deg
 *     (6.1 revolutions) with the zero at count 127 of the high byte, 54 deg with the data sheet's 0x8000.
 * It went unnoticed because nothing here compared these channels to an absolute reference: the roll rate is only
 * cross-correlated against the camera gyro to align the log to the video, which does not care about scale, and the turn rate used
 * for geometry comes from the camera.
 */
export const IMU_OFFSET = 0x8000
/** Yaw and roll rate [deg/s per count] */
export const IMU_RATE_QUANT = 0.005
/** X, Y and Z acceleration [g per count] */
export const IMU_ACC_QUANT = 0.0001274
/** What an all-zero frame decodes to: "the sensor has nothing yet", not a real -163.84 deg/s */
export const RATE_INVALID = -IMU_OFFSET * IMU_RATE_QUANT
/**
 * Whether a roll / yaw rate means "no reading". Besides RATE_INVALID, CSVs exported by older MotoRecoViewer builds carry -125 (the
 * original rule) or -166.67 (its 4/3 correction, 60db916 to dfec59b); neither is a rate the sensor can report (+-163 deg/s, and
 * the original rule read 3/4 of true)
 */
export function isRateInvalid(r: number): boolean {
  return r <= RATE_INVALID + 0.01 || r === -125
}
/** Angular rate [deg/s]: Data2 high byte, Data1 low byte. RATE_INVALID means no reading */
const RATE: Fn = (d, o) => (D(d, o, 2) * 256 + D(d, o, 1) - IMU_OFFSET) * IMU_RATE_QUANT
/** Acceleration [G]: Data6 high byte, Data5 low byte */
const ACCEL: Fn = (d, o) => (D(d, o, 6) * 256 + D(d, o, 5) - IMU_OFFSET) * IMU_ACC_QUANT
const FR_SPEED1: Fn = (d, o) => (LO(d, o, 5) * 256 + D(d, o, 4)) / 8
const RR_SPEED: Fn = (d, o) => (LO(d, o, 2) * 256 + D(d, o, 1)) / 8
/** Gear: upper 4 bits of Data6 → gear. Anything else is 0 (neutral / unknown) */
const GEAR: Record<number, number> = { 1: 1, 4: 2, 7: 3, 8: 4, 11: 5, 13: 6 }
/** Accumulated values, fuel economy, etc. are computed in post-processing (0 here) */
const LATER: Fn = () => 0

const BUILTIN: Record<string, Fn> = {
  BMW_RPM: (d, o) => (LO(d, o, 4) * 256 + D(d, o, 3)) * 5,
  BMW_ThrottelValvePosition: (d, o) => (D(d, o, 6) / 255) * 100,
  BMW_ThrottelPosition: (d, o) => (D(d, o, 8) / 255) * 100,
  BMW_ThrottelGripPosition: (d, o) => (D(d, o, 6) / 255) * 100,
  BMW_FrBrake1: (d, o) => D(d, o, 3) / 4,
  BMW_FrBrake2: (d, o) => D(d, o, 5) / 4,
  BMW_RrBrake1: (d, o) => D(d, o, 4) / 2,
  BMW_RrBrake2: (d, o) => D(d, o, 6) / 2,
  BMW_FrStroke: (d, o) => (LO(d, o, 7) * 256 + D(d, o, 6)) / 5,
  BMW_RrStroke: (d, o) => (D(d, o, 8) * 16 + HI(d, o, 7)) / 3,
  // Data5 is 8-bit offset binary about count 128 (2^7, as the IMU's 0x8000), full scale +-90 deg. 0x10C is another module with no
  // data sheet; the log starts at count 128 with the bike upright (MotoRecoViewer commit c7cfc27)
  BMW_LeanAngle: (d, o) => (D(d, o, 5) * 90) / 128 - 90,
  BMW_RrSpeed: RR_SPEED,
  BMW_FrSpeed2: (d, o) => (D(d, o, 3) * 16 + HI(d, o, 2)) / 8,
  BMW_FrSpeed1: FR_SPEED1,
  BMW_DistFrSpeed1: LATER,
  BMW_SlipRate: (d, o) => {
    const fr = FR_SPEED1(d, o)
    return fr === 0 ? 0 : (RR_SPEED(d, o) / fr) * 100 - 100
  },
  BMW_Gear: (d, o) => GEAR[HI(d, o, 6)] ?? 0,
  BMW_YawRate: RATE,
  BMW_YAxisG: ACCEL,
  BMW_RollRate: RATE,
  BMW_XAxisG: ACCEL,
  BMW_ZAxisG: ACCEL,
  BMW_AirTemp: (d, o) => D(d, o, 1) * 0.75 - 48,
  BMW_OilTemp: (d, o) => D(d, o, 2) - 25,
  BMW_WaterTemp: (d, o) => D(d, o, 3) * 0.76 - 25,
  BMW_DistCountFr: (d, o) => LO(d, o, 5) * 253 + D(d, o, 4),
  BMW_AccumulatedDistCountFr: LATER,
  BMW_DistCountRr: (d, o) => D(d, o, 3),
  BMW_AccumulatedDistCountRr: LATER,
  BMW_FuelCount: (d, o) => D(d, o, 5) * 256 + D(d, o, 4),
  BMW_AccumulatedFuelCount: LATER,
  BMW_FuelLevel: (d, o) => ((D(d, o, 2) * 256 + D(d, o, 1)) / 562) * 100,
  BMW_OdMeter: (d, o) => D(d, o, 4) * 65536 + D(d, o, 3) * 256 + D(d, o, 2),
  BMW_FuelConsumption: LATER,
  BMW_Range: LATER,
  GPS_Latitude: (d, o) => (U32(d, o, 5) - 90000000) / 1000000,
  GPS_Longitude: (d, o) => (U32(d, o, 1) - 180000000) / 1000000,
  // Unit is 10⁶ times m/s → km/h
  GPS_Speed: (d, o) => ((U32(d, o, 5) / 1000000) * 3600) / 1000,
  // The logger records altitude·10000 + 10000000 (a .dat recorded with the old spec of altitude·10⁶ + 10⁹ cannot be read correctly)
  GPS_Altitude: (d, o) => (U32(d, o, 1) - 10000000) / 10000,
  GPS_Distance: LATER
}
// #Data1-#Data8, #HiData1-, #LoData1- (usable with any ID)
for (let n = 1; n <= 8; n++) {
  BUILTIN[`Data${n}`] = (d, o) => D(d, o, n)
  BUILTIN[`HiData${n}`] = (d, o) => HI(d, o, n)
  BUILTIN[`LoData${n}`] = (d, o) => LO(d, o, n)
}

/** Column names of the built-in rules in BMW.ddf (the app reads by these names) */
const COLUMN: Record<string, string> = {
  BMW_RPM: 'RPM',
  BMW_ThrottelValvePosition: 'ThrottelValvePosition',
  BMW_ThrottelPosition: 'ThrottelPosition',
  BMW_ThrottelGripPosition: 'Throttel Grip Position',
  BMW_FrBrake1: 'FrBrakeDown',
  BMW_FrBrake2: 'FrBrakeUp',
  BMW_RrBrake1: 'RrBrake1',
  BMW_RrBrake2: 'RrBrake2',
  BMW_FrStroke: 'FrStroke',
  BMW_RrStroke: 'RrStroke',
  BMW_LeanAngle: 'LeanAngle',
  BMW_FrSpeed1: 'FrSpeed1',
  BMW_FrSpeed2: 'FrSpeed2',
  BMW_RrSpeed: 'RrSpeed',
  BMW_DistFrSpeed1: 'DistFrSpeed1',
  BMW_SlipRate: 'SlipRate',
  BMW_Gear: 'Gear',
  BMW_XAxisG: 'X_Axis_G',
  BMW_YAxisG: 'Y_Axis_G',
  BMW_ZAxisG: 'Z_Axis_G',
  BMW_RollRate: 'RollRate',
  BMW_YawRate: 'YawRate',
  BMW_AirTemp: 'AirTemp',
  BMW_WaterTemp: 'WaterTemp',
  BMW_OilTemp: 'OilTemp',
  BMW_DistCountFr: 'DistCountFr',
  BMW_AccumulatedDistCountFr: 'AccumulatedDistCountFr',
  BMW_DistCountRr: 'DistCountRr',
  BMW_AccumulatedDistCountRr: 'AccumulatedDistCountRr',
  BMW_FuelCount: 'FuelCounter',
  BMW_AccumulatedFuelCount: 'AccumulatedFuelCounter',
  BMW_FuelLevel: 'FuelLevel',
  BMW_OdMeter: 'OdMeter',
  BMW_FuelConsumption: 'FuelConsumption',
  BMW_Range: 'Range',
  GPS_Latitude: 'lat (deg)',
  GPS_Longitude: 'lon (deg)',
  GPS_Speed: 'Speed',
  GPS_Altitude: 'alt (m)',
  GPS_Distance: 'Distance'
}

/** Channels that are read even if missing from the .ddf, because they are always needed for sync and lean angle */
const REQUIRED: DdfChannel[] = [
  { name: 'LeanAngle', id: 0x10c, rule: '#BMW_LeanAngle', filter: false, cutoffHz: 0 },
  { name: 'RollRate', id: 0x178, rule: '#BMW_RollRate', filter: false, cutoffHz: 0 }
]

/**
 * Name of a built-in rule (after the #). #K51_* is treated the same as #BMW_* (the old .ddf notation. In the current MotoRecoViewer it becomes 0).
 * undefined if it is not built-in (a formula), null if the name is unknown
 */
function builtinKey(rule: string): string | null | undefined {
  if (!rule.startsWith('#')) return undefined
  const name = rule.slice(1).replace(/^K51_/i, 'BMW_')
  const key = Object.keys(BUILTIN).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ?? null
}

// ---- Reading records ----

/** Records per ID (in time order). As in MotoRecoViewer, records with the same time stay in file order */
interface IdIndex {
  /** Time [s] = seconds + milliseconds/1000 */
  time: Float64Array
  /** Position of the 8 bytes of data */
  off: Uint32Array
}
function indexById(buf: Uint8Array, want?: Set<number>): { byId: Map<number, IdIndex>; start: number; end: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const n = Math.floor(buf.byteLength / DAT_RECORD)
  const timeAt = (o: number): number => v.getUint32(o, true) + v.getUint16(o + 4, true) / 1000
  const count = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const id = v.getUint16(i * DAT_RECORD + 6, true)
    if (want && !want.has(id)) continue
    count.set(id, (count.get(id) ?? 0) + 1)
  }
  const byId = new Map<number, IdIndex & { k: number; sorted: boolean }>()
  for (const [id, c] of count) byId.set(id, { time: new Float64Array(c), off: new Uint32Array(c), k: 0, sorted: true })
  for (let i = 0; i < n; i++) {
    const o = i * DAT_RECORD
    const e = byId.get(v.getUint16(o + 6, true))
    if (!e) continue
    const t = timeAt(o)
    if (e.k > 0 && t < e.time[e.k - 1]) e.sorted = false
    e.time[e.k] = t
    e.off[e.k] = o + 8
    e.k++
  }
  // GPS records are written a little late, so the time order is shuffled. Stable sort (same time stays in file order)
  for (const e of byId.values()) {
    if (e.sorted) continue
    const order = Array.from(e.time.keys()).sort((a, b) => e.time[a] - e.time[b])
    const time = Float64Array.from(order, (i) => e.time[i])
    const off = Uint32Array.from(order, (i) => e.off[i])
    e.time = time
    e.off = off
  }
  // The table range is the time of the first and last records in the file (MotoRecoViewer's startTime and endTime)
  return { byId, start: n ? timeAt(0) : 0, end: n ? timeAt((n - 1) * DAT_RECORD) : 0 }
}

/** Index of the record on the left of time x (the latest at or before x). Same as MotoRecoViewer's ChData.FindLeftIndex (including handling of out-of-range) */
function findLeftIndex(time: Float64Array, x: number): number {
  const n = time.length
  if (n < 3) return 0
  let first = 0
  let last = n - 1
  let mid = 0
  do {
    mid = first + Math.floor((last - first) / 2)
    if (mid === n - 1) return mid
    if (time[mid] <= x && x < time[mid + 1]) return mid
    if (x > time[mid]) first = mid + 1
    else last = mid - 1
  } while (first <= last)
  return mid
}

/**
 * Forward-backward 2nd-order Butterworth smoothing. A port of MotoRecoViewer's ChData.Butterworth
 * (each end is extended by 2 points of the edge value. The last point is not smoothed). dt is the sample interval [s]
 */
export function butterworthFiltfilt(x: Float64Array, dt: number, cutoffHz: number): Float64Array {
  const out = x.slice()
  if (cutoffHz === 0 || x.length === 0) return out
  const fs = 1 / dt
  const dF2 = x.length - 1
  const dat2 = new Float64Array(dF2 + 4)
  for (let r = 0; r < dF2; r++) dat2[2 + r] = x[r]
  dat2[1] = dat2[0] = x[0]
  dat2[dF2 + 3] = dat2[dF2 + 2] = x[dF2]
  const pi = 3.14159265358979
  const wc = Math.tan((cutoffHz * pi) / fs)
  const k1 = 1.414213562 * wc
  const k2 = wc * wc
  const a = k2 / (1 + k1 + k2)
  const b = 2 * a
  const c = a
  const k3 = b / k2
  const d = -2 * a + k3
  const e = 1 - 2 * a - k3
  const y = new Float64Array(dF2 + 4)
  y[1] = y[0] = x[0]
  for (let s = 2; s < dF2 + 2; s++) y[s] = a * dat2[s] + b * dat2[s - 1] + c * dat2[s - 2] + d * y[s - 1] + e * y[s - 2]
  y[dF2 + 3] = y[dF2 + 2] = y[dF2 + 1]
  const z = new Float64Array(dF2 + 2)
  z[dF2] = y[dF2 + 2]
  z[dF2 + 1] = y[dF2 + 3]
  for (let t = -dF2 + 1; t <= 0; t++) z[-t] = a * y[-t + 2] + b * y[-t + 3] + c * y[-t + 4] + d * z[-t + 1] + e * z[-t + 2]
  for (let p = 0; p < dF2; p++) out[p] = z[p]
  return out
}

/** Sample interval [s]: the mean of the first 100 (same as MotoRecoViewer's ChData.FilterData) */
function sampleInterval(time: Float64Array): number {
  const j = Math.min(time.length, 100)
  let sum = 0
  let i = 0
  for (; i < j - 1; i++) sum += time[i + 1] - time[i]
  return sum / i
}

/** The list of records of one channel (in time order) */
interface Channel {
  def: DdfChannel
  key: string | null | undefined
  time: Float64Array
  value: Float64Array
}

// ---- Accumulation, fuel economy, range (same as MotoRecoViewer's ChannelAnalyzer. Computed later from the decoded values) ----
function calcDerived(chs: Channel[]): void {
  // Look up by rule (the first one if several have the same rule)
  const by = (key: string): Channel | undefined => chs.find((c) => c.key === key)
  /** Integrate the speed [km/h] per record as "that speed × time since the previous record" [km] */
  const integrate = (speedKey: string, distKey: string): void => {
    const s = by(speedKey)
    const dist = by(distKey)
    if (!s || !dist) return
    const n = Math.min(s.value.length, dist.value.length)
    dist.value[0] = 0
    for (let i = 1; i < n; i++) dist.value[i] = dist.value[i - 1] + (s.value[i] / 3600) * (s.time[i] - s.time[i - 1])
  }
  /** Accumulate counter increments. Only when it wraps (increment below wrapBelow) add wrap; any other decrease (engine stop, etc.) is 0 */
  const accumulate = (countKey: string, accKey: string, wrapBelow: number, wrap: number, scale: number): void => {
    const cnt = by(countKey)
    const acc = by(accKey)
    if (!cnt || !acc) return
    const n = Math.min(cnt.value.length, acc.value.length)
    let total = 0
    acc.value[0] = 0
    for (let i = 1; i < n; i++) {
      let d = cnt.value[i] - cnt.value[i - 1]
      if (d < 0) d = d < wrapBelow ? d + wrap : 0
      total += d
      acc.value[i] = total * scale
    }
  }
  integrate('GPS_Speed', 'GPS_Distance')
  integrate('BMW_FrSpeed1', 'BMW_DistFrSpeed1')
  // The front wheel distance counter has a max of 3951; ×0.000255 gives the same distance as integrating the front wheel speed [km]
  accumulate('BMW_DistCountFr', 'BMW_AccumulatedDistCountFr', -3900, 3951, 0.000255)
  // The rear wheel distance counter has a max of 255; ×0.004 gives a rough distance [km] (a little longer because the rear wheel slips when accelerating)
  accumulate('BMW_DistCountRr', 'BMW_AccumulatedDistCountRr', -250, 255, 0.004)
  // The fuel counter is 16 bits; /10⁶ gives the fuel consumed [L]
  accumulate('BMW_FuelCount', 'BMW_AccumulatedFuelCount', -65000, 65536, 1 / 1000000)
  // Fuel economy [km/L] = accumulated distance (front wheel counter) / fuel consumed. For each time of the fuel counter's records
  const fuel = by('BMW_AccumulatedFuelCount')
  const dist = by('BMW_AccumulatedDistCountFr')
  const cons = by('BMW_FuelConsumption')
  if (fuel && dist && cons) {
    const n = Math.min(cons.value.length, fuel.value.length)
    for (let i = 0; i < n; i++) {
      const f = fuel.value[i]
      const km = dist.value[findLeftIndex(dist.time, fuel.time[i])]
      cons.value[i] = f !== 0 ? km / f : 0
    }
  }
  // Range [km] = tank capacity 30 L × remaining fuel [%] × fuel economy
  const level = by('BMW_FuelLevel')
  const range = by('BMW_Range')
  if (cons && level && range) {
    const n = Math.min(range.value.length, cons.value.length)
    for (let i = 0; i < n; i++) {
      const fc = cons.value[i]
      const lv = level.value[findLeftIndex(level.time, cons.time[i])]
      range.value[i] = fc !== 0 ? 30 * (lv / 100) * fc : 0
    }
  }
}

export interface DatTable {
  /** Seconds (10 ms step. From the time of the first record in the log) */
  t: Float64Array
  columns: Map<string, Float64Array>
  /** Built-in rules that were in the .ddf but are unknown (no column is made) */
  unsupported: string[]
}

/**
 * Decode the .dat with the .ddf rules into the same table as MotoRecoViewer's CSV export.
 * The steps are also the same as MotoRecoViewer: compute values per record → sort by time per ID → smoothing (on the record series) →
 * post-processing such as accumulation → for each time stepping 0.01 s from the first record's time, the value of the latest record at or before that time
 */
function decodeTable(buf: Uint8Array, ddf: DdfChannel[], addRequired: boolean): DatTable {
  if (buf.byteLength < DAT_RECORD || buf.byteLength % DAT_RECORD !== 0) throw new Error('Not a MotoReco .dat (size is not a multiple of 16 bytes)')
  const defs = [...ddf]
  if (addRequired) for (const req of REQUIRED) if (!defs.some((c) => c.name === req.name || builtinKey(c.rule) === builtinKey(req.rule))) defs.push(req)
  const unsupported: string[] = []
  const { byId, start, end } = indexById(buf, new Set(defs.map((c) => c.id)))
  const chs: Channel[] = []
  for (const def of defs) {
    const key = builtinKey(def.rule)
    if (key === null) {
      unsupported.push(`${def.name} (${def.rule})`)
      continue
    }
    const idx = byId.get(def.id)
    if (!idx) continue // do not make columns for IDs that send no data (same as MotoRecoViewer)
    const fn = key ? BUILTIN[key] : compileFormula(def.rule)
    const value = new Float64Array(idx.time.length)
    for (let i = 0; i < value.length; i++) value[i] = fn(buf, idx.off[i])
    chs.push({ def, key, time: idx.time, value })
  }
  calcDerived(chs)
  // The 10 ms table. Time keeps adding 0.01 (including the floating-point error, giving the same rows and values as MotoRecoViewer)
  const stamps: number[] = []
  for (let ts = start; ts < end; ts += 0.01) stamps.push(ts)
  const columns = new Map<string, Float64Array>()
  const canonical = new Map<string, Float64Array>()
  for (const c of chs) {
    // Smoothing is applied to the record series (for accumulated columns, to the value after accumulation)
    const v = c.def.filter ? butterworthFiltfilt(c.value, sampleInterval(c.time), c.def.cutoffHz) : c.value
    const col = new Float64Array(stamps.length)
    for (let r = 0; r < stamps.length; r++) col[r] = v[findLeftIndex(c.time, stamps[r])]
    let name = c.def.name
    for (let k = 2; columns.has(name); k++) name = `${c.def.name} (${k})`
    columns.set(name, col)
    const cn = c.key ? COLUMN[c.key] : undefined
    if (cn && !canonical.has(cn)) canonical.set(cn, col)
  }
  // Columns of the built-in rules can be looked up by their BMW.ddf column name even if the name in the .ddf differs
  for (const [name, v] of canonical) if (!columns.has(name)) columns.set(name, v)
  // The CSV's time (ms) is "an integer of time×1000", so the seconds are aligned to that too
  const t = Float64Array.from(stamps, (s) => Math.round(s * 1000) / 1000)
  return { t, columns, unsupported }
}

/** Decode the .dat with the .ddf rules into the same table as the CSV (LeanAngle and RollRate used for sync are read even if missing from the .ddf) */
export function decodeDat(buf: Uint8Array, ddf: DdfChannel[]): DatTable {
  return decodeTable(buf, ddf, true)
}

/** Recording start time (local time in ms) from the file name (YYYYMMDD_HHMMSS.dat). null if unreadable */
export function datStartFromName(name: string): number | null {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

/** Recording length [s] from the last few records in the file */
export function datDurationFromTail(tail: Uint8Array): number {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let s = 0
  for (let o = tail.byteLength - DAT_RECORD; o >= 0; o -= DAT_RECORD) s = Math.max(s, v.getUint32(o, true) + v.getUint16(o + 4, true) / 1000)
  return s
}

/** For matching with the video, extract only the roll rate at a 10 ms step (invalid value is NaN) */
export function datRollRate(buf: Uint8Array, ddf: DdfChannel[] | null): { t: Float64Array; rollRate: Float64Array } {
  const def = ddf?.find((x) => builtinKey(x.rule) === 'BMW_RollRate') ?? REQUIRED[1]
  const table = decodeTable(buf, [{ ...def, name: 'RollRate', filter: false }], false)
  const v = table.columns.get('RollRate') ?? new Float64Array(table.t.length).fill(RATE_INVALID)
  return { t: table.t, rollRate: v.map((x) => (isRateInvalid(x) ? NaN : x)) }
}
