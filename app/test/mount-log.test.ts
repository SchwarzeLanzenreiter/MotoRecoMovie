// 取り付け姿勢（core/mount.ts）を、車両ログから求めた正解と 1 分ごとに比べる（実データ）。
//   正解の上 = 走っていて（20km/h 以上）リーンしていない間の加速度の平均
//   正解の前 = 上に垂直な面で、カメラのジャイロのうち車体のロール角速度（ログ）に最も合う向き
// IMU だけの推定（estimateMountTrack）と、ログで詰めたもの（REFINE=1 で refineMountWithLog）を確かめる。
// 実行: npx tsx test/mount-log.test.ts <insv> <.dat> <.ddf>
//   例: VID_20261011_092151_00_002.insv（走行中にカメラの向きが 80° 近く変わる）↔ 20261011_094441.dat
import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMount, IMU_TO_RIG } from '../src/renderer/src/core/motion'
import { estimateMountTrack, mountFwdAt, mountUpAt, refineMountWithLog } from '../src/renderer/src/core/mount'
import { cameraRollRate, bikeLogFromColumns, syncLog } from '../src/renderer/src/core/motoreco'
import { decodeDat, parseDdf } from '../src/renderer/src/core/motoreco-dat'

const [path, logPath, ddf] = process.argv.slice(2)
const fh = await open(path, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const imu = await tr.imu()
const whole = estimateMount(imu)
const t0 = performance.now()
let track = estimateMountTrack(imu)
console.log(`取り付け姿勢の時間変化: ${(performance.now() - t0).toFixed(0)}ms ${track.fixed ? '1 つの姿勢' : '時間で変わる'} 最大の変化 ${track.maxDeg.toFixed(1)}° 前後の決め方 ${track.by}`)
const tb = decodeDat(new Uint8Array(await readFile(logPath)), parseDdf(await readFile(ddf, 'utf-8')))
const log = bikeLogFromColumns(tb.t, tb.columns)
const sync = syncLog(log, cameraRollRate(imu, whole.R, tr.meta.firstFrameUs))
console.log(`同期のピーク比 ${sync.peakRatio.toFixed(2)}`)
if (process.env.REFINE) { const t1 = performance.now(); track = refineMountWithLog(track, imu, log, sync, tr.meta.firstFrameUs); console.log(`ログで詰めた: ${(performance.now() - t1).toFixed(0)}ms ${track.fixed ? '1 つ' : '時刻ごと'} 変化 ${track.maxDeg.toFixed(1)}°`) }
const col = (k: string): Float64Array => tb.columns.get(k)!
const LG = [col('X_Axis_G'), col('Y_Axis_G'), col('Z_Axis_G')]
const RR = col('RollRate')
const logAt = (arr: Float64Array, tv: number): number => {
  const lt = sync.a * tv + sync.b
  let lo = 0
  let hi = log.t.length - 1
  if (lt < log.t[0] || lt > log.t[hi]) return NaN
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (log.t[mid] < lt) lo = mid
    else hi = mid
  }
  return arr[lo]
}
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: number[]): number[] => { const k = Math.hypot(a[0], a[1], a[2]); return a.map((v) => v / k) }
const deg = (r: number): number => (r * 180) / Math.PI
// 10Hz のカメラの加速度・ジャイロ（リグ座標）
const n = imu.ts.length
const B = Math.round(((n - 1) / ((imu.ts[n - 1] - imu.ts[0]) / 1e6)) / 10)
const m = Math.floor(n / B)
const rig = (arr: Float32Array, i: number): number[] => [0, 1, 2].map((r) => IMU_TO_RIG[r * 3] * arr[i * 3] + IMU_TO_RIG[r * 3 + 1] * arr[i * 3 + 1] + IMU_TO_RIG[r * 3 + 2] * arr[i * 3 + 2])
const S = { ts: new Float64Array(m), acc: [] as number[][], gyr: [] as number[][] }
for (let b = 0; b < m; b++) {
  const a = [0, 0, 0], g = [0, 0, 0]
  let t = 0
  for (let i = b * B; i < (b + 1) * B; i++) { const x = rig(imu.acc, i), y = rig(imu.gyro, i); for (let r = 0; r < 3; r++) { a[r] += x[r] / B; g[r] += y[r] / B }; t += imu.ts[i] / B }
  S.ts[b] = t; S.acc.push(a); S.gyr.push(g)
}
// 正解（1 分ごと）: 上 = 直立して走っている間の加速度の平均。前 = 上に垂直な面で、カメラのジャイロのうちログのロール角速度に最も合う向き
const lines: string[] = []
let sumUp = 0, sumF = 0, cnt = 0
for (let w0 = 0; w0 + 600 <= m; w0 += 600) {
  const su = [0, 0, 0]
  let cu = 0
  for (let b = w0; b < w0 + 600; b++) {
    const tv = (S.ts[b] - tr.meta.firstFrameUs) / 1e6
    const sp = logAt(log.speed, tv), ln = logAt(log.lean, tv)
    if (sp > 20 && Math.abs(ln) < 3) { for (let r = 0; r < 3; r++) su[r] += S.acc[b][r]; cu++ }
  }
  if (cu < 100) continue
  const up = unit(su)
  // ロール角速度との回帰で前方（上に垂直な成分）
  const c = [0, 0, 0]
  for (let b = w0; b < w0 + 600; b++) {
    const tv = (S.ts[b] - tr.meta.firstFrameUs) / 1e6
    const r = logAt(RR, tv)
    if (!Number.isFinite(r)) continue
    for (let k = 0; k < 3; k++) c[k] += S.gyr[b][k] * r
  }
  const kk = dot(c, up)
  const fT = unit(c.map((v, k) => -(v - kk * up[k]))) // ログのロール角速度は右へ倒れるのが負
  const tc = S.ts[w0 + 300]
  const fE = mountFwdAt(track, tc), uE = mountUpAt(track, tc)
  const eUp = deg(Math.acos(Math.min(1, dot(up, uE))))
  const eF = deg(Math.acos(Math.max(-1, Math.min(1, dot(fT, fE)))))
  sumUp += eUp; sumF += eF; cnt++
  lines.push(`${((tc - tr.meta.firstFrameUs) / 6e7).toFixed(0)}分: 上のずれ ${eUp.toFixed(1)}°  前のずれ ${eF.toFixed(1)}°  （全体で 1 つの推定なら 上 ${deg(Math.acos(Math.min(1, dot(up, [-whole.R[1], -whole.R[4], -whole.R[7]])))).toFixed(1)}° 前 ${deg(Math.acos(Math.max(-1, Math.min(1, dot(fT, [whole.R[2], whole.R[5], whole.R[8]]))))).toFixed(1)}°）`)
}
console.log(lines.join('\n'))
console.log(`平均: 上のずれ ${(sumUp / cnt).toFixed(1)}°  前のずれ ${(sumF / cnt).toFixed(1)}°`)
// 正解の側にも 2〜4° のばらつきがある
assert.ok(sync.peakRatio > 2, 'ログと映像の同期が取れていない（別の走行のログ）')
assert.ok(sumUp / cnt < 3, '上のずれが大きい')
assert.ok(sumF / cnt < (process.env.REFINE ? 6 : 8), '前のずれが大きい')
console.log('mount-log.test: OK')
await fh.close()
