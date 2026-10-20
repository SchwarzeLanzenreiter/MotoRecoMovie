// 車両ログ無しの推定（core/imu-telemetry.ts）を、車両ログから作ったテレメトリーと比べる（実データ）。
// 実行: npx tsx test/imu-telemetry.test.ts <insv> <.dat|.csv> [<.ddf>]
import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMountTrack, refineMountWithLog } from '../src/renderer/src/core/mount'
import { bikeLogFromColumns, cameraRollRate, cameraYawRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { decodeDat, parseDdf } from '../src/renderer/src/core/motoreco-dat'
import { buildTelemetry } from '../src/renderer/src/core/telemetry'
import { detectRiding } from '../src/renderer/src/core/riding'
import { buildNav } from '../src/renderer/src/core/nav'
import { detectCorners } from '../src/renderer/src/core/corners'
import { buildImuTelemetry } from '../src/renderer/src/core/imu-telemetry'

const [path, logPath, ddf] = process.argv.slice(2)
const fh = await open(path, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const imu = await tr.imu()
const dur = (await tr.gyroFrameTimes(0)).length / tr.meta.fps // X5 は metadata のフレーム数が 0
const imuMount = estimateMountTrack(imu)

// ---- 正解: 車両ログから ----
const bl = logPath.toLowerCase().endsWith('.dat')
  ? (async () => {
      const tb = decodeDat(new Uint8Array(await readFile(logPath)), parseDdf(await readFile(ddf, 'utf-8')))
      return bikeLogFromColumns(tb.t, tb.columns)
    })()
  : (async () => parseMotoReco(await readFile(logPath, 'utf-8')))()
const L = await bl
const sync = syncLog(L, cameraRollRate(imu, imuMount, tr.meta.firstFrameUs))
const mount = refineMountWithLog(imuMount, imu, L, sync, tr.meta.firstFrameUs)
const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
const truth = buildTelemetry(L, sync, fuseLean(L, cam, sync), dur, 0)
truth.riding = detectRiding(truth)
const nav = buildNav(truth, cameraYawRate(imu, mount, tr.meta.firstFrameUs))
truth.corners = nav ? detectCorners(truth, nav, truth.riding) : []

// ---- 推定: IMU だけ（取り付け姿勢も IMU だけ）----
const t0 = performance.now()
const est = buildImuTelemetry(imu, imuMount, tr.meta.firstFrameUs, dur).telemetry
est.riding = detectRiding(est)
est.corners = detectCorners(est, est.nav!, est.riding)
console.log(`推定 ${(performance.now() - t0).toFixed(0)}ms`)

const n = Math.min(truth.n, est.n)
// リーン角
{
  let se = 0, c = 0, sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const a = truth.channels.lean?.[i] ?? NaN
    const b = est.channels.lean![i]
    const v = truth.channels.speed?.[i] ?? NaN
    if (!Number.isFinite(a) || !(v > 20)) continue
    se += (a - b) ** 2; c++; sxy += a * b; sxx += a * a; syy += b * b
  }
  console.log(`リーン角: 誤差の二乗平均 ${Math.sqrt(se / c).toFixed(1)}° 相関 ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`)
}
// 車速
{
  let se = 0, c = 0, sa = 0
  for (let i = 0; i < n; i++) {
    const a = truth.channels.speed?.[i] ?? NaN
    if (!Number.isFinite(a)) continue
    se += (a - est.channels.speed![i]) ** 2; sa += a; c++
  }
  console.log(`車速: 誤差の二乗平均 ${Math.sqrt(se / c).toFixed(1)} km/h（平均 ${(sa / c).toFixed(0)} km/h）`)
}
// 前後 G
{
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const a = truth.channels.accelG?.[i] ?? NaN
    if (!Number.isFinite(a)) continue
    const b = est.channels.accelG![i]
    sxy += a * b; sxx += a * a; syy += b * b
  }
  console.log(`前後 G: 相関 ${(sxy / Math.sqrt(sxx * syy)).toFixed(2)} 大きさの比 ${Math.sqrt(syy / sxx).toFixed(2)}`)
}
// 走行状態
{
  const names = ['巡航', '加速', '減速', 'コーナー', '停止']
  const conf = names.map(() => names.map(() => 0))
  for (let i = 0; i < n; i++) conf[truth.riding.state[i]][est.riding.state[i]]++
  let agree = 0
  for (let k = 0; k < 5; k++) agree += conf[k][k]
  console.log(`走行状態の一致 ${((agree / n) * 100).toFixed(0)}%`)
  for (let k = 0; k < 5; k++) {
    const tot = conf[k].reduce((a, b) => a + b, 0)
    if (tot) console.log(`  正解 ${names[k]}（${(tot / 100).toFixed(0)} 秒）→ 推定 ${conf[k].map((v, j) => `${names[j]} ${((v / tot) * 100).toFixed(0)}%`).join(' ')}`)
  }
}
// コーナーと曲線半径
{
  const tc = truth.corners
  const ec = est.corners
  let matched = 0
  const ratios: number[] = []
  for (const c of tc) {
    const m = ec.find((e) => e.apex > c.start - 1 && e.apex < c.end + 1 && e.dir === c.dir)
    if (!m) continue
    matched++
    ratios.push(m.radius / c.radius)
  }
  ratios.sort((a, b) => a - b)
  const med = ratios[ratios.length >> 1]
  const within = ratios.filter((r) => r > 0.7 && r < 1.4).length
  console.log(`コーナー: 正解 ${tc.length} 個、推定 ${ec.length} 個、対応 ${matched} 個。曲線半径の比（推定/正解）の中央値 ${med?.toFixed(2)}、±30〜40% 以内 ${within}/${ratios.length}`)
  assert.ok(matched >= tc.length * 0.6, 'コーナーの半分以上は見つかる')
}
console.log('imu-telemetry.test: OK')
await fh.close()
