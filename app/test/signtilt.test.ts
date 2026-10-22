// Floating sign tilt (real data): how much the "map down" used to project the signs differs in tilt (roll) and pitch from the true gravity
// direction derived from acceleration. Signs are projected with MotionModel.cameraInMap (leveled by gravityTrack, heading from the vehicle log).
// The true gravity is computed here on its own: the acceleration moved into ground-fixed coordinates using the gyro orientation, averaged over
// 60 s, with the bike's own acceleration over the window (the change in velocity, from the logged speed) taken out.
// Leveling by the GPS grade instead (before) was off by 2.7° RMS in pitch on 0919, which made far signs float.
// Run: npx tsx test/signtilt.test.ts <insv> <.dat|.csv> [<.ddf>]
import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMountTrack, mountQAt, refineMountWithLog } from '../src/renderer/src/core/mount'
import { bikeLogFromColumns, cameraRollRate, cameraYawRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { decodeDat, parseDdf } from '../src/renderer/src/core/motoreco-dat'
import { buildTelemetry, estimateGpsDelay } from '../src/renderer/src/core/telemetry'
import { buildNav } from '../src/renderer/src/core/nav'
import { gravityTrack, IMU_TO_RIG, integrate, sampleQ } from '../src/renderer/src/core/motion'
import { matVec, qMul, qToMat } from '../src/renderer/src/core/quat'
import { MotionModel } from '../src/renderer/src/engine/motion-model'
import { newProject } from '../src/renderer/src/engine/project'

const [path, logPath, ddf] = process.argv.slice(2)
const fh = await open(path, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const imu = await tr.imu()
const ft = await tr.gyroFrameTimes(0)
const dur = (ft[ft.length - 1] - ft[0]) / 1e6
const first = tr.meta.firstFrameUs
const imuMount = estimateMountTrack(imu)
const L = logPath.toLowerCase().endsWith('.dat')
  ? (await (async () => {
      const tb = decodeDat(new Uint8Array(await readFile(logPath)), parseDdf(await readFile(ddf, 'utf-8')))
      return bikeLogFromColumns(tb.t, tb.columns)
    })())
  : parseMotoReco(await readFile(logPath, 'utf-8'))
const sync = syncLog(L, cameraRollRate(imu, imuMount, first))
const mount = refineMountWithLog(imuMount, imu, L, sync, first)
const cam = cameraRollRate(imu, mount, first)
const lean = fuseLean(L, cam, sync)
const yaw = cameraYawRate(imu, mount, first)
const gd = estimateGpsDelay(buildTelemetry(L, sync, lean, dur, 0), yaw)
const tel = buildTelemetry(L, sync, lean, dur, gd.delay)
const nav = buildNav(tel, yaw)!
const ori = integrate(imu)
const stab = newProject('x').stab
const mm = new MotionModel(tr.meta, ori, mount, ft, lean, stab)
mm.setNav({ rate: tel.rate, heading: nav.heading, grade: tel.channels.grade ?? null, speed: tel.channels.speed ?? null })
mm.setGravity(gravityTrack(imu, ori))
console.log(`${tr.meta.model}: sync a=${sync.a.toFixed(5)} b=${sync.b.toFixed(2)} confidence ${sync.peakRatio.toFixed(2)} residual ${sync.residualMs.toFixed(0)}ms sign ${sync.sign}  lean scale k=${lean.k.toFixed(3)} correlation ${lean.rateCorr.toFixed(3)}  GPS delay ${gd.delay.toFixed(2)}s`)
{
  const lg = (L as unknown as { leanAngle?: Float64Array; lean?: Float64Array })
  const la = lg.leanAngle ?? lg.lean
  if (la) { let mn = 1e9, mx = -1e9; for (const v of la) if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v) } ; console.log(`log lean angle ${mn.toFixed(1)}-${mx.toFixed(1)}°, log length ${((L as unknown as {t: Float64Array}).t.at(-1)! - (L as unknown as {t: Float64Array}).t[0]).toFixed(0)}s, video ${dur.toFixed(0)}s`) }
  let mn = 1e9, mx = -1e9; for (const v of lean.lean) { mn = Math.min(mn, v); mx = Math.max(mx, v) }; console.log(`fused lean angle ${mn.toFixed(1)}-${mx.toFixed(1)}°`)
  console.log('sync windows', sync.windows.slice(0, 8).map((w) => `${w.t.toFixed(0)}s:${w.offset.toFixed(2)}(${w.corr.toFixed(2)})`).join(' '))
}

// Move the acceleration into ground-fixed coordinates (the gyro orientation frame) and average every 1 s
const n1 = Math.floor((imu.ts[imu.ts.length - 1] - imu.ts[0]) / 1e6)
const acc1 = new Float64Array(n1 * 3)
const cnt = new Float64Array(n1)
for (let i = 0; i < imu.ts.length; i += 5) {
  const k = Math.floor((imu.ts[i] - imu.ts[0]) / 1e6)
  if (k >= n1) break
  const a = matVec(IMU_TO_RIG, [imu.acc[i * 3], imu.acc[i * 3 + 1], imu.acc[i * 3 + 2]])
  const R = qToMat(sampleQ(ori, imu.ts[i]))
  const w = matVec(R, a)
  for (let c = 0; c < 3; c++) acc1[k * 3 + c] += w[c]
  cnt[k]++
}
// Velocity in ground-fixed coordinates [m/s]: the logged speed along the body forward
const t0Us = first + tr.meta.gyroOffsetMs * 1000
const velAt = (tUs: number): number[] => {
  const sp = tel.channels.speed![Math.max(0, Math.min(tel.n - 1, Math.round(((tUs - t0Us) / 1e6) * tel.rate)))]
  const B = qToMat(qMul(sampleQ(ori, tUs), mountQAt(mount, tUs)))
  const v = Number.isFinite(sp) ? sp / 3.6 : 0
  return [B[2] * v, B[5] * v, B[8] * v]
}
// Up (the accelerometer reads the push holding it up) = mean reading − mean acceleration; the mean acceleration is Δv over the window
const gAt = (tUs: number): number[] => {
  const k = Math.floor((tUs - imu.ts[0]) / 1e6)
  const a = Math.max(0, k - 30)
  const b = Math.min(n1, k + 30)
  const g = [0, 0, 0]
  let m = 0
  for (let j = a; j < b; j++) {
    for (let c = 0; c < 3; c++) g[c] += acc1[j * 3 + c]
    m += cnt[j]
  }
  const va = velAt(imu.ts[0] + a * 1e6)
  const vb = velAt(imu.ts[0] + b * 1e6)
  for (let c = 0; c < 3; c++) g[c] = g[c] / m - (vb[c] - va[c]) / ((b - a) * 9.80665)
  const nn = Math.hypot(g[0], g[1], g[2])
  return g.map((v) => v / nn)
}
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const deg = (r: number): number => (r * 180) / Math.PI
const fps = tr.meta.fps
const rows: { t: number; lean: number; err: number; errMap: number; pitchErr: number }[] = []
for (let t = 30; t < dur - 30; t += 1) {
  const i = Math.round(t * fps)
  const fr = mm.frame(i, { yaw: 0, pitch: 0, fov: 100, leanRatio: 1 })
  const Rw = qToMat(fr.world) // columns = camera right, down, forward (gyro orientation frame)
  const right = [Rw[0], Rw[3], Rw[6]]
  const down = [Rw[1], Rw[4], Rw[7]]
  const fwd = [Rw[2], Rw[5], Rw[8]]
  // The accelerometer measures the opposite of gravity (upward), so down = −mean
  const g = gAt(mm.tc(i)).map((v) => -v)
  const trueTilt = deg(Math.atan2(dot(g, right), dot(g, down)))
  const Rm = mm.cameraInMap(i, fr.world)!
  const mRight = [Rm[0], Rm[3], Rm[6]]
  const mDown = [Rm[1], Rm[4], Rm[7]]
  const mapTilt = deg(Math.atan2(dot([0, 1, 0], mRight), dot([0, 1, 0], mDown)))
  // Pitch: how far the line of sight points below the horizon (+ = down)
  const pitchErr = deg(Math.asin(Rm[5])) - deg(Math.asin(dot(g, fwd)))
  const L0 = mm.leanAt(i) ?? 0
  rows.push({ t, lean: L0, err: mapTilt - trueTilt, errMap: mapTilt, pitchErr })
}
const rms = (a: number[]): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length))
const st = rows.filter((r) => Math.abs(r.lean) < 5)
const co = rows.filter((r) => Math.abs(r.lean) > 15)
const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
console.log(`sign tilt mismatch (sign − true gravity): overall RMS ${rms(rows.map((r) => r.err)).toFixed(1)}° mean ${mean(rows.map((r) => r.err)).toFixed(1)}°`)
console.log(`  straight (|lean| < 5°) ${st.length} points: mean ${mean(st.map((r) => r.err)).toFixed(1)}° RMS ${rms(st.map((r) => r.err)).toFixed(1)}°`)
console.log(`  corner (|lean| > 15°) ${co.length} points: mean ${mean(co.map((r) => r.err)).toFixed(1)}° RMS ${rms(co.map((r) => r.err)).toFixed(1)}°`)
console.log(`sign pitch mismatch: mean ${mean(rows.map((r) => r.pitchErr)).toFixed(2)}° RMS ${rms(rows.map((r) => r.pitchErr)).toFixed(2)}°`)
// Relation to lean (tilt = k × lean + c)
{
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const r of rows) { sx += r.lean; sy += r.err; sxx += r.lean * r.lean; sxy += r.lean * r.err }
  const n = rows.length
  const k = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  console.log(`  mismatch ≈ ${k.toFixed(3)} × lean + ${((sy - k * sx) / n).toFixed(1)}°`)
}
for (const r of rows.filter((_, j) => j % 60 === 0)) console.log(`  ${r.t}s lean ${r.lean.toFixed(1)}° mismatch ${r.err.toFixed(1)}°`)
assert.ok(rms(rows.map((r) => r.err)) < 1, 'sign tilt differs from the true gravity by 1° RMS or more')
assert.ok(rms(rows.map((r) => r.pitchErr)) < 1, 'sign pitch differs from the true gravity by 1° RMS or more')
console.log('signtilt.test: OK')
await fh.close()
