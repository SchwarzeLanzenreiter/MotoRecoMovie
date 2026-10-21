// Checks the .dat decode against the .ddf rules, reading the .dat directly. No CSV needed.
// Run: npx tsx test/motoreco-dat.test.ts [dat] [ddf] [insv] [other dat…] [--csv <csv>]
//   given an insv, also checks the matching score used to pick the .dat that fits the video
//   (same ride / different ride)
//
// Three layers, in order of what they can prove:
//
//   1. Formula rules — unit checks on the expression compiler. No data needed.
//   2. Physical invariants — things that can only hold if the decode is right, and that need no
//      external reference. **This is what a CSV comparison cannot do.** When a built-in rule is
//      itself wrong, MotoRecoViewer's CSV is wrong in the same way and a row-by-row comparison
//      still passes: that is how the roll and yaw rate sat at 3/4 of the true rate, with the zero
//      point one count off, without anyone noticing (see IMU_OFFSET in core/motoreco-dat.ts; the rules
//      now follow the IMU's data sheet). The roll-rate integral below is the check that exposed it.
//   3. Golden statistics — per-column min/max/mean for the reference ride, as a regression guard.
//      Catches a change too small for an invariant to notice, such as the G low byte moving
//      between /255 and /256, which is about 1e-4 g.
//
// Passing --csv <path> additionally does the row-by-row comparison against a MotoRecoViewer
// export. That is the only check that can confirm the two implementations still agree, so it is
// worth running after either side's rules change — but it needs a CSV exported from the *current*
// MotoRecoViewer, and a stale one fails on whichever channels have been corrected since.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { compileFormula, datRollRate, decodeDat, parseDdf } from '../src/renderer/src/core/motoreco-dat'
import { bikeLogFromColumns, cameraRollRate, logMatchScore, parseMotoReco } from '../src/renderer/src/core/motoreco'

// ---- 1. Formula rules ----
{
  const d = new Uint8Array([0x10, 0x20, 0x34, 0, 0, 0, 0, 0])
  assert.equal(compileFormula('Data1')(d, 0), 16)
  assert.equal(compileFormula('LoData3*256+Data2')(d, 0), 4 * 256 + 32)
  assert.equal(compileFormula('HiData3')(d, 0), 3)
  assert.equal(compileFormula('(Data1 + Data2) / 2 - -1')(d, 0), 25)
  assert.equal(compileFormula('Data2*125/128+Data1/256-125')(d, 0), (32 * 125) / 128 + 16 / 256 - 125)
  assert.throws(() => compileFormula('Data9'))
  assert.throws(() => compileFormula('Data1 +'))
  const ddf = parseDdf('\uFEFFRPM,10C,#BMW_RPM,-2866,0,10000,True,True,False,3\r\nX_Axis_G,178,#K51_XAxisG,-1,-2,2,False,True,True,1\r\n\r\n')
  assert.deepEqual(ddf.map((c) => [c.name, c.id, c.rule, c.filter, c.cutoffHz]), [
    ['RPM', 0x10c, '#BMW_RPM', false, 3],
    ['X_Axis_G', 0x178, '#K51_XAxisG', true, 1]
  ])
}

// ---- Arguments ----
const argv = process.argv.slice(2)
const csvAt = argv.indexOf('--csv')
const CSV = csvAt >= 0 ? argv[csvAt + 1] : null
const positional = csvAt >= 0 ? [...argv.slice(0, csvAt), ...argv.slice(csvAt + 2)] : argv
const [datPath, ddfPath, insvPath, ...otherDats] = positional
const DAT = datPath ?? String.raw`E:\R1200GSA\CAN Log\2026\20260919_143356.dat`
const DDF = ddfPath ?? String.raw`E:\R1200GSA\CAN Log\BMW.ddf`

let buf: Uint8Array
try {
  buf = new Uint8Array(readFileSync(DAT))
} catch {
  console.log(`real data ${DAT} not found, so only the formula check is done`)
  process.exit(0)
}
const t0 = performance.now()
const table = decodeDat(buf, parseDdf(readFileSync(DDF, 'utf-8')))
console.log(`decode ${(performance.now() - t0).toFixed(0)}ms  ${table.t.length} rows × ${table.columns.size} columns  unsupported: ${table.unsupported.join(', ') || 'none'}`)
assert.equal(table.unsupported.length, 0, 'no unknown rules')

const t = table.t
const dur = t[t.length - 1] - t[0]
const col = (n: string): Float64Array | undefined => table.columns.get(n)
const need = (n: string): Float64Array => {
  const v = col(n)
  assert.ok(v, `column ${n} is missing`)
  return v
}
const mean = (a: Float64Array): number => a.reduce((s, x) => s + x, 0) / a.length
const near = (got: number, want: number, tol: number, what: string): void => {
  console.log(`  ${what.padEnd(34)} ${got.toFixed(6).padStart(12)}   want ${want} +-${tol}`)
  assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} is not ${want} +-${tol}`)
}

// ---- 2. Physical invariants ----
console.log('invariants:')

// The vertical axis always carries one gravity. Pins the acceleration formula and its offset. With the data
// sheet scale this ride reads 1.047 (the original 1/32 g per count read 1.003; MotoRecoViewer's longer sample
// went from 0.964 to 1.006), so the bound is about what the scale and the mounting leave.
near(mean(need('Z_Axis_G')), 1.0, 0.05, 'mean Z_Axis_G [g]')

// Front wheel speed integrated, against the distance GPS reports. Two independent sensors, and two
// independent decode paths: the CAN wheel-speed rule, and the GPS fixed-point encoding.
const wheelKm = (mean(need('FrSpeed1')) * dur) / 3600
const gpsKm = need('Distance')[t.length - 1]
near(wheelKm / gpsKm, 1.0, 0.05, 'wheel km / GPS km')

// The bike is upright at the start and at the end of a ride, so the roll rate has to integrate
// back to nothing. This is the invariant that exposed the zero point sitting at count 127: it came
// to several revolutions. Normalized by duration so the bound does not depend on ride length.
const rr = need('RollRate')
const lean = need('LeanAngle')
let integ = 0
for (let i = 1; i < t.length; i++) integ += rr[i] * (t[i] - t[i - 1])
console.log(`  ${'integral of RollRate'.padEnd(34)} ${integ.toFixed(1).padStart(12)} deg = ${(integ / 360).toFixed(2)} revolutions`)
near(integ / dur, 0, 0.3, 'integral of RollRate / duration')
assert.ok(Math.abs(lean[0]) < 15 && Math.abs(lean[t.length - 1]) < 15, 'the bike is upright at both ends of the ride')

// Roll rate and lean angle are separate channels on separate CAN IDs watching the same motion, so
// d(LeanAngle) has to track the integral of RollRate. Fitting a drift term alongside it separates a
// scale error, which moves the slope, from a zero-point error, which moves the drift.
{
  const W = 100 // one second
  let sxx = 0, sxy = 0, sxt = 0, stt = 0, sty = 0, n = 0
  for (let i = 0; i + W < t.length; i += W) {
    let q = 0
    for (let k = i + 1; k <= i + W; k++) q += rr[k] * (t[k] - t[k - 1])
    const y = lean[i + W] - lean[i]
    const dt = t[i + W] - t[i]
    sxx += q * q; sxy += q * y; sxt += q * dt; stt += dt * dt; sty += dt * y
    n++
  }
  const det = sxx * stt - sxt * sxt
  const a = (sxy * stt - sty * sxt) / det
  const b = (sty * sxx - sxy * sxt) / det
  console.log(`  d(LeanAngle) = a*int(RollRate) + b*T over ${n} one-second windows`)
  // The slope is negative because the two channels use opposite sign conventions. Its magnitude
  // near 1 pins the rate scale: the original rule (125/127 deg/s per count of the high byte) takes it to about 1.17.
  near(-a, 0.93, 0.13, 'slope -a')
  // The drift term pins the zero point: with it at count 127 this sat at about +1.3 deg/s.
  near(b, 0, 0.5, 'drift b [deg/s]')
}

// ---- 3. Golden statistics for the reference ride ----
// [column, min, max, mean]. If a rule changes on purpose, print the same three numbers again to
// regenerate this, and say in the commit which channels moved and why.
const GOLDEN_DAT = '20260919_143356.dat'
const GOLDEN_ROWS = 150093
const GOLDEN: [string, number, number, number][] = [
  ['AccumulatedDistCountFr', 0, 40.17831, 20.6444361366],
  ['AccumulatedDistCountRr', 0, 40.688, 20.9086855216],
  ['AccumulatedFuelCounter', 0, 2.77232, 1.44359210741],
  ['AirTemp', 20.25, 23.25, 20.8735234155],
  ['DistCountFr', 0, 3951, 1903.24670704],
  ['DistCountRr', 0, 249, 124.99264456],
  ['DistFrSpeed1', 0, 40.0788176042, 20.5987033756],
  ['Distance', 0, 40.2991491253, 20.6650541506],
  ['FrBrakeDown', 0, 30, 0.286379111617],
  ['FrBrakeUp', 0, 30, 0.288339562804],
  ['FrSpeed1', 0, 469.75, 96.1328992691],
  ['FrSpeed2', 0, 469.75, 96.150228525],
  ['FrStroke', 18.4, 157.2, 81.0312139807],
  ['FuelConsumption', 0, 15.2828667855, 13.9305055827],
  ['FuelCounter', 0, 65534, 33342.7308802],
  ['FuelLevel', 63.8790035587, 74.1992882562, 68.9976579882],
  ['Gear', 0, 6, 5.02793601301],
  ['LeanAngle', -39.375, 36.5625, -0.54568511273],
  ['OdMeter', 60135, 60176, 60155.8781555],
  ['OilTemp', 79, 95, 91.0400684909],
  ['RPM', 0, 6925, 4005.5722119],
  ['Range', 0, 336.114294428, 287.766586554],
  ['RollRate', -163.84, 44.22, -0.0175938917871],
  ['RrBrake1', 0, 29, 0.496272311167],
  ['RrBrake2', 0, 15, 0.457149900395],
  ['RrSpeed', 0, 463.75, 97.7249388712],
  ['RrStroke', 33.3333333333, 243.666666667, 106.466075478],
  ['SlipRate', -52.8631404107, 20.6375115777, 1.3546167168],
  ['Speed', 0, 184.3665984, 96.6831632763],
  ['Throttel Grip Position', 11.7647058824, 92.5490196078, 36.4973036979],
  ['ThrottelPosition', 0, 99.6078431373, 19.172881441],
  ['ThrottelValvePosition', 1.56862745098, 99.6078431373, 21.8848575321],
  ['WaterTemp', 73.8, 95.08, 81.8025453553],
  ['X_Axis_G', -3.89125672142, 0.435400638803, -0.0186138190276],
  ['Y_Axis_G', -3.90077812609, 0.129179273352, -0.000389779865291],
  ['YawRate', -163.84, 62.335, 0.0326590847008],
  ['Z_Axis_G', -3.82384837801, 1.37402267611, 1.04667645882],
  ['alt (m)', 14.9, 98.8, 63.3678412717],
  ['lat (deg)', 45.403258, 45.496678, 45.4526292009],
  ['lon (deg)', 141.917536, 141.963585, 141.944992245]
]

if (basename(DAT) === GOLDEN_DAT) {
  assert.equal(table.t.length, GOLDEN_ROWS, 'row count')
  assert.equal(table.columns.size, GOLDEN.length, 'column count')
  let worstName = ''
  let worst = 0
  for (const [name, gmin, gmax, gmean] of GOLDEN) {
    const v = need(name)
    let mn = Infinity
    let mx = -Infinity
    let s = 0
    for (const x of v) {
      if (x < mn) mn = x
      if (x > mx) mx = x
      s += x
    }
    const stats: [number, number, string][] = [
      [mn, gmin, 'min'],
      [mx, gmax, 'max'],
      [s / v.length, gmean, 'mean']
    ]
    for (const [got, want, what] of stats) {
      const e = Math.abs(got - want) / Math.max(1, Math.abs(want))
      if (e > worst) {
        worst = e
        worstName = `${name} ${what}`
      }
      assert.ok(e <= 1e-9, `${name} ${what}: ${got.toPrecision(12)} != golden ${want}`)
    }
  }
  console.log(`golden: ${GOLDEN.length} columns × 3 statistics match (worst relative error ${worst.toPrecision(3)} on ${worstName})`)
} else {
  console.log(`golden: skipped, the statistics are recorded for ${GOLDEN_DAT} only`)
}

// Can be converted to the form the app uses (BikeLog)
const log = bikeLogFromColumns(table.t, table.columns)
assert.equal(log.t.length, table.t.length)

// ---- Optional: row-by-row against a MotoRecoViewer export ----
if (CSV) {
  const csv = parseMotoReco(readFileSync(CSV, 'utf-8'))
  assert.equal(table.t.length, csv.t.length, 'row count matches the CSV')
  let cols = 0
  for (const [name, b] of csv.columns) {
    if (name === 'time (ms)') continue
    const a = need(name)
    let bad = 0
    let worstErr = 0
    for (let i = 0; i < b.length; i++) {
      const e = Math.abs(a[i] - b[i])
      // The CSV is written in the .NET default format (15 significant digits)
      if (!(e <= 1e-9 * Math.max(1, Math.abs(b[i])))) bad++
      worstErr = Math.max(worstErr, e)
    }
    console.log(`  ${name.padEnd(24)} mismatches ${bad} rows  max error ${worstErr.toPrecision(3)}`)
    assert.equal(bad, 0, `${name} does not match the CSV. If a rule changed after this CSV was exported, re-export it`)
    cols++
  }
  for (let i = 0; i < csv.t.length; i++) assert.ok(Math.abs(table.t[i] - csv.t[i]) < 1e-9, `time of row ${i}`)
  console.log(`  ${cols} columns × ${csv.t.length} rows match the CSV`)
}

// ---- Matching score for picking the .dat that fits the video ----
if (insvPath) {
  const { InsvTrailer } = await import('../src/renderer/src/core/insv')
  const { estimateMount } = await import('../src/renderer/src/core/motion')
  const fh = await open(insvPath, 'r')
  const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
  const tr = await InsvTrailer.open(reader)
  const imu = await tr.imu()
  const cam = cameraRollRate(imu, estimateMount(imu).R, tr.meta.firstFrameUs)
  for (const p of otherDats.concat([DAT])) {
    const t1 = performance.now()
    const one = datRollRate(new Uint8Array(readFileSync(p)), null)
    const s = logMatchScore(one.t, one.rollRate, cam)
    console.log(`  match ${p.split(/[\\/]/).pop()}: main peak/2nd peak ${s.peakRatio.toFixed(2)}  offset ${s.offset.toFixed(2)}s  (${(performance.now() - t1).toFixed(0)}ms)`)
  }
  await fh.close()
}
console.log('ok')
