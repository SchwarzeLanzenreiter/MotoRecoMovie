// 統一テレメトリーの確認と、GPS の遅れの実測。
// 実行: npx tsx test/telemetry.test.ts <insv> <csv>
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

// ---- GPS の遅れ: GPS の方位の変化率と、ジャイロのヨーレート（車体の上軸まわり）を突き合わせる ----
const up = [-mount[1], -mount[4], -mount[7]] // R_mount の第2列（下）を反転
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
  // 方位の変化率 [deg/s]（±180 の折り返しを考慮）
  let sxy = 0, sxx = 0, syy = 0, cnt = 0
  for (let i = 100; i < tel.n - 100; i += 5) {
    const dh = ((((h[i + 50] - h[i - 50]) % 360) + 540) % 360) - 180
    const rate = dh / 1.0
    const k = Math.round((i / TELEMETRY_RATE - yawT[0]) * 100)
    if (k < 0 || k >= yawLp.length) continue
    const sp = tel.channels.speed![i]
    const y = yawLp[k]
    if (!(sp >= 20) || Number.isNaN(rate)) continue // ログのない区間（NaN）を除く
    sxy += rate * y; sxx += rate * rate; syy += y * y; cnt++
  }
  const c = sxy / Math.sqrt(sxx * syy)
  if (Math.abs(c) > Math.abs(best.c) || best.c === -2) best = { c, d }
  console.log(`GPS遅れ ${d.toFixed(1)}s: 方位変化率とヨーレートの相関 ${c.toFixed(4)}`)
}
console.log(`→ 最良の GPS 遅れ ${best.d.toFixed(1)}s（相関 ${best.c.toFixed(4)}）`)

const est = estimateGpsDelay(buildTelemetry(log, sync, lean, dur, 0), cameraYawRate(imu, mount, tr.meta.firstFrameUs))
console.log(`estimateGpsDelay: ${est.delay}s（相関 ${est.corr.toFixed(4)}）  総当たりの結果 ${best.d.toFixed(1)}s`)
// 回帰テスト: ログのない区間の NaN が混ざっても推定できること（以前は常に 0 になっていた）
if (!(est.delay >= 0.85 && est.delay <= 1.15 && Math.abs(est.corr) > 0.9)) throw new Error(`GPS の遅れの推定が想定外: ${JSON.stringify(est)}`)
const tel = buildTelemetry(log, sync, lean, dur, est.delay)
console.log('チャンネル', Object.keys(tel.channels).join(', '), ' サンプル数', tel.n)
console.log('軌跡', tel.gps?.x.length, '点  範囲[m]', JSON.stringify(tel.gps?.bounds, (k, v) => (typeof v === 'number' ? Math.round(v) : v)))
for (const t of [60, 400, 1394, 1398, 1400]) {
  const s = sampleAll(tel, t)
  console.log(`t=${t}s`, Object.entries(s).map(([k, v]) => `${k}=${(v as number).toFixed(k === 'lat' || k === 'lon' ? 5 : 1)}`).join(' '))
}
await fh.close()
