// 方位・位置の融合と、コーナーの曲線半径の推定を実データで確認する。
// 実行: npx tsx test/corners.test.ts <insv> <csv>
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMount } from '../src/renderer/src/core/motion'
import { cameraRollRate, cameraYawRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { buildTelemetry, estimateGpsDelay } from '../src/renderer/src/core/telemetry'
import { detectRiding } from '../src/renderer/src/core/riding'
import { buildNav } from '../src/renderer/src/core/nav'
import { detectCorners } from '../src/renderer/src/core/corners'

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
const yaw = cameraYawRate(imu, mount, tr.meta.firstFrameUs)
const est = estimateGpsDelay(buildTelemetry(log, sync, lean, dur, 0), yaw)
const tel = buildTelemetry(log, sync, lean, dur, est.delay)
const riding = detectRiding(tel)
let t0 = performance.now()
const nav = buildNav(tel, yaw)!
console.log(`融合 ${(performance.now() - t0).toFixed(0)}ms`)

// 融合した位置と GPS の差（GPS が有効な区間）、方位の差
let se = 0, sh = 0, cnt = 0
for (let i = 1000; i < tel.n - 1000; i += 10) {
  if (Number.isNaN(tel.channels.gpsX![i]) || !(tel.channels.speed![i] > 15)) continue
  se += (nav.x[i] - tel.channels.gpsX![i]) ** 2 + (nav.y[i] - tel.channels.gpsY![i]) ** 2
  const dh = ((((nav.heading[i] - tel.channels.heading![i]) % 360) + 540) % 360) - 180
  sh += dh * dh
  cnt++
}
console.log(`融合位置と GPS の差 RMS ${Math.sqrt(se / cnt).toFixed(1)}m  方位の差 RMS ${Math.sqrt(sh / cnt).toFixed(1)}°`)
// 滑らかさ: 1フレームあたりの位置の変化の「ぶれ」（2階差分）を GPS と比べる
const jerk = (x: ArrayLike<number>, y: ArrayLike<number>): number => {
  let s = 0, c = 0
  for (let i = 2000; i < tel.n - 2000; i += 2) {
    const ax = x[i + 2] - 2 * x[i] + x[i - 2]
    const ay = y[i + 2] - 2 * y[i] + y[i - 2]
    if (Number.isNaN(ax) || Number.isNaN(ay)) continue
    s += ax * ax + ay * ay
    c++
  }
  return Math.sqrt(s / c) * 1000
}
console.log(`位置の2階差分（ぶれ）RMS [mm]: GPS ${jerk(tel.channels.gpsX!, tel.channels.gpsY!).toFixed(2)}  融合 ${jerk(nav.x, nav.y).toFixed(2)}`)

t0 = performance.now()
const corners = detectCorners(tel, nav, riding)
console.log(`コーナー ${corners.length} 本（${(performance.now() - t0).toFixed(0)}ms）`)
// 3つの推定の比較
const ratios = corners.filter((c) => c.radiusGps > 0 && c.radiusLean > 0).map((c) => [c.radius / c.radiusGps, c.radius / c.radiusLean])
const med = (a: number[]): number => [...a].sort((p, q) => p - q)[a.length >> 1]
console.log(`半径の比（ジャイロ ÷ GPS 軌跡）中央値 ${med(ratios.map((r) => r[0])).toFixed(2)}   （ジャイロ ÷ リーン角）中央値 ${med(ratios.map((r) => r[1])).toFixed(2)}`)
const rs = corners.map((c) => c.radius).sort((a, b) => a - b)
console.log(`半径の分布: 最小 ${rs[0]}m  25% ${rs[rs.length >> 2]}m  中央 ${rs[rs.length >> 1]}m  75% ${rs[(rs.length * 3) >> 2]}m  最大 ${rs[rs.length - 1]}m`)
for (const c of corners.filter((c) => c.start > 1385 && c.start < 1415)) {
  console.log(`  ${c.start.toFixed(1)}s ${c.dir > 0 ? '右' : '左'} R=${c.radius}m（GPS ${c.radiusGps.toFixed(0)} / リーン ${c.radiusLean.toFixed(0)}）`)
}
assert.ok(corners.length > 50)
assert.ok(Math.abs(med(ratios.map((r) => r[0])) - 1) < 0.25, 'ジャイロと GPS の半径が大きく食い違う')
console.log('corners.test: OK')
await fh.close()
