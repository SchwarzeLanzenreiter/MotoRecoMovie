// Compares the result of decoding a MotoReco .dat with the .ddf rules against the CSV from MotoRecoViewer.
// Run: npx tsx test/motoreco-dat.test.ts [dat ddf csv] [insv]
//   given an insv, also checks the matching score used to pick the .dat that fits the video (same ride / different ride)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { compileFormula, datRollRate, decodeDat, parseDdf } from '../src/renderer/src/core/motoreco-dat'
import { bikeLogFromColumns, cameraRollRate, logMatchScore, parseMotoReco } from '../src/renderer/src/core/motoreco'

// ---- Formula rules ----
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

// ---- Real data: compare with the CSV (the same .dat converted by MotoRecoViewer with BMW.ddf) ----
const [datPath, ddfPath, csvPath, insvPath] = process.argv.slice(2)
const DAT = datPath ?? String.raw`E:\R1200GSA\CAN Log\2026\20260919_143356.dat`
const DDF = ddfPath ?? String.raw`E:\R1200GSA\CAN Log\BMW.ddf`
const CSV = csvPath ?? String.raw`E:\R1200GSA\Movie\2026\0919宗谷丘陵\0919.csv` // i18n-ignore
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
const csv = parseMotoReco(readFileSync(CSV, 'utf-8'))
assert.equal(table.t.length, csv.t.length, 'row count matches the CSV')

// Same procedure as MotoRecoViewer, so every column and row of the CSV should match (apart from decimal rounding differences)
assert.equal(table.unsupported.length, 0, 'no unknown rules')
let cols = 0
for (const [name, b] of csv.columns) {
  if (name === 'time (ms)') continue
  const a = table.columns.get(name)
  assert.ok(a, `column ${name}`)
  let bad = 0
  let worst = 0
  for (let i = 0; i < b.length; i++) {
    const e = Math.abs(a[i] - b[i])
    // The CSV is written in the .NET default format (15 significant digits)
    if (!(e <= 1e-9 * Math.max(1, Math.abs(b[i])))) bad++
    worst = Math.max(worst, e)
  }
  console.log(`  ${name.padEnd(24)} mismatches ${bad} rows  max error ${worst.toPrecision(3)}`)
  assert.equal(bad, 0, `${name} does not match the CSV`)
  cols++
}
for (let i = 0; i < csv.t.length; i++) assert.ok(Math.abs(table.t[i] - csv.t[i]) < 1e-9, `time of row ${i}`)
console.log(`  ${cols} columns × ${csv.t.length} rows match`)
// Can be converted to the form the app uses (BikeLog)
const log = bikeLogFromColumns(table.t, table.columns)
assert.equal(log.t.length, table.t.length)

// ---- Matching score for picking the .dat that fits the video ----
if (insvPath) {
  const { InsvTrailer } = await import('../src/renderer/src/core/insv')
  const { estimateMount } = await import('../src/renderer/src/core/motion')
  const fh = await open(insvPath, 'r')
  const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
  const tr = await InsvTrailer.open(reader)
  const imu = await tr.imu()
  const cam = cameraRollRate(imu, estimateMount(imu).R, tr.meta.firstFrameUs)
  for (const p of process.argv.slice(6).concat([DAT])) {
    const t1 = performance.now()
    const rr = datRollRate(new Uint8Array(readFileSync(p)), null)
    const s = logMatchScore(rr.t, rr.rollRate, cam)
    console.log(`  match ${p.split(/[\\/]/).pop()}: main peak/2nd peak ${s.peakRatio.toFixed(2)}  offset ${s.offset.toFixed(2)}s  (${(performance.now() - t1).toFixed(0)}ms)`)
  }
  await fh.close()
}
console.log('ok')
