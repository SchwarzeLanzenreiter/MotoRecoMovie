// Check of the unified telemetry, and measurement of the GPS delay.
// Run: npx tsx test/telemetry.test.ts <insv> <csv>
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMount, IMU_TO_RIG } from '../src/renderer/src/core/motion'
import { cameraRollRate, cameraYawRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { buildTelemetry, estimateGpsDelay, sampleAll, TELEMETRY_RATE } from '../src/renderer/src/core/telemetry'
import { lowpassFiltfilt } from '../src/renderer/src/core/dsp'
import { matVec } from '../src/renderer/src/core/quat'

const [insvPath, csvPath] = process.argv.slice(2)
const fh = await open(insvPath, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const imu = await tr.imu()
const mount = estimateMount(imu).R
const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
const sync = syncLog(log, cam)
const lean = fuseLean(log, cam, sync)
const dur = tr.meta.frameCount / tr.meta.fps

// ---- GPS delay: match the rate of change of the GPS heading against the gyro yaw rate (about the vehicle's up axis) ----
const up = [-mount[1], -mount[4], -mount[7]] // invert the 2nd column of R_mount (down)
const B = 10
const m = Math.floor(imu.ts.length / B)
const yawT = new Float64Array(m)
const yawR = new Float64Array(m)
for (let b = 0; b < m; b++) {
  let ts = 0
  let acc = 0
  for (let i = b * B; i < (b + 1) * B; i++) {
    ts += imu.ts[i]
    const g = matVec(IMU_TO_RIG, [imu.gyro[i * 3], imu.gyro[i * 3 + 1], imu.gyro[i * 3 + 2]])
    acc += g[0] * up[0] + g[1] * up[1] + g[2] * up[2]
  }
  yawT[b] = (ts / B - tr.meta.firstFrameUs) / 1e6
  yawR[b] = acc / B
}
const yawLp = lowpassFiltfilt(yawR, 0.5, 100)
let best = { c: -2, d: 0 }
for (let d = -0.5; d <= 2.5001; d += 0.1) {
  const tel = buildTelemetry(log, sync, lean, dur, d)
  const h = tel.channels.heading!
  // Rate of change of heading [deg/s] (accounting for the ±180 wrap)
  let sxy = 0, sxx = 0, syy = 0, cnt = 0
  for (let i = 100; i < tel.n - 100; i += 5) {
    const dh = ((((h[i + 50] - h[i - 50]) % 360) + 540) % 360) - 180
    const rate = dh / 1.0
    const k = Math.round((i / TELEMETRY_RATE - yawT[0]) * 100)
    if (k < 0 || k >= yawLp.length) continue
    const sp = tel.channels.speed![i]
    const y = yawLp[k]
    if (!(sp >= 20) || Number.isNaN(rate)) continue // skip sections without a log (NaN)
    sxy += rate * y; sxx += rate * rate; syy += y * y; cnt++
  }
  const c = sxy / Math.sqrt(sxx * syy)
  if (Math.abs(c) > Math.abs(best.c) || best.c === -2) best = { c, d }
  console.log(`GPS delay ${d.toFixed(1)}s: correlation between the heading rate and the yaw rate ${c.toFixed(4)}`)
}
console.log(`-> best GPS delay ${best.d.toFixed(1)}s (correlation ${best.c.toFixed(4)})`)

const est = estimateGpsDelay(buildTelemetry(log, sync, lean, dur, 0), cameraYawRate(imu, mount, tr.meta.firstFrameUs))
console.log(`estimateGpsDelay: ${est.delay}s (correlation ${est.corr.toFixed(4)})  brute-force result ${best.d.toFixed(1)}s`)
// Regression test: the estimate must work even when NaN from sections without a log is mixed in (it used to always be 0)
if (!(est.delay >= 0.85 && est.delay <= 1.15 && Math.abs(est.corr) > 0.9)) throw new Error(`unexpected GPS delay estimate: ${JSON.stringify(est)}`)
const tel = buildTelemetry(log, sync, lean, dur, est.delay)
console.log('channels', Object.keys(tel.channels).join(', '), ' sample count', tel.n)
console.log('track', tel.gps?.x.length, 'points  range [m]', JSON.stringify(tel.gps?.bounds, (k, v) => (typeof v === 'number' ? Math.round(v) : v)))
for (const t of [60, 400, 1394, 1398, 1400]) {
  const s = sampleAll(tel, t)
  console.log(`t=${t}s`, Object.entries(s).map(([k, v]) => `${k}=${(v as number).toFixed(k === 'lat' || k === 'lon' ? 5 : 1)}`).join(' '))
}
await fh.close()
