// コア計算（TypeScript）を Python プロトタイプの結果と突き合わせる。
// 実行: npx tsx test/core.test.ts <insv> <csv>
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { makeRig, projectCam } from '../src/renderer/src/core/lens'
import { estimateMount, integrate, sampleQ, smooth } from '../src/renderer/src/core/motion'
import { cameraRollRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { interp } from '../src/renderer/src/core/dsp'
import { qConj, qMul, qToRotvec } from '../src/renderer/src/core/quat'

const [insvPath, csvPath] = process.argv.slice(2)
const fh = await open(insvPath, 'r')
const size = (await fh.stat()).size
const reader = {
  size,
  async read(offset: number, length: number) {
    const b = new Uint8Array(length)
    await fh.read(b, 0, length, offset)
    return b
  }
}
const time = async <T>(label: string, f: () => T | Promise<T>): Promise<T> => {
  const t = performance.now()
  const r = await f()
  console.log(`  (${label}: ${(performance.now() - t).toFixed(0)}ms)`)
  return r
}

const tr = await InsvTrailer.open(reader)
const m = tr.meta
console.log('機種', m.model, 'FW', m.firmware, 'fps', m.fps, 'フレーム', m.frameCount, 'readout', m.readoutMs, 'ms', 'gyroOffset', m.gyroOffsetMs, 'ms', 'streamType', m.streamType)
console.log('IMUレンジ', m.accRangeG, 'g', m.gyroRangeDps, 'dps', 'キャリブ V' + m.calibration.version, 'ミラー', m.calibration.mirrorLens0)

const rig = makeRig(m.calibration, 3840)
// Python: lens.py の project と同じ点で比較（リグ座標の光線 → 画素）
for (const [i, L] of rig.entries()) {
  const ray: [number, number, number] = i === 0 ? [0.3, -0.2, 1] : [0.3, -0.2, -1]
  const c = [0, 1, 2].map((r) => L.camFromRig[r * 3] * ray[0] + L.camFromRig[r * 3 + 1] * ray[1] + L.camFromRig[r * 3 + 2] * ray[2]) as [number, number, number]
  console.log(`lens${i} 光線 ${JSON.stringify(ray)} → 画素 ${projectCam(L, c).map((v) => v.toFixed(3)).join(', ')}`)
}

const imu = await time('IMU読み込み', () => tr.imu())
const ft0 = await tr.frameTimes(0)
console.log('IMU', imu.ts.length, 'サンプル  フレーム時刻', ft0.length, '件  先頭', ft0[0])
const mount = await time('取り付け推定', () => estimateMount(imu))
console.log('R_mount（列=右,下,前）', Array.from(mount.R).map((v) => v.toFixed(4)).join(' '), ' 固有値比', mount.ratio.toFixed(2))

const ori = await time('ジャイロ積分', () => integrate(imu))
// 1396〜1397秒の相対回転（Python の integrate と比較できる量）
const ta = ft0[1396 * 50]
const tb = ft0[1397 * 50]
const rel = qToRotvec(qMul(qConj(sampleQ(ori, ta)), sampleQ(ori, tb))).map((v) => ((v * 180) / Math.PI).toFixed(4))
console.log('1396→1397秒の相対回転[deg]', rel.join(', '))
const tc = new Float64Array([ft0[1400 * 50] + m.gyroOffsetMs * 1000])
const qs = await time('平滑化(1フレーム)', () => smooth(ori, tc, [0.6, 0.3, 0.2], mount.R))
const dev = qToRotvec(qMul(qConj(sampleQ(ori, tc[0])), qs.subarray(0, 4))).map((v) => ((v * 180) / Math.PI).toFixed(4))
console.log('1400秒: q⁻¹·qs [deg]', dev.join(', '))
const many = new Float64Array(3000).map((_, i) => ft0[1300 * 50 + i] + m.gyroOffsetMs * 1000)
await time('平滑化(3000フレーム)', () => smooth(ori, many, [0.6, 0.3, 0.2], mount.R))

if (csvPath) {
  const log = await time('CSV読み込み', () => parseMotoReco(readFileSync(csvPath, 'utf-8')))
  const cam = cameraRollRate(imu, mount.R, m.firstFrameUs)
  const sync = await time('同期', () => syncLog(log, cam))
  console.log(`同期: ログ時刻 = ${sync.a.toFixed(8)}·動画時刻 ${sync.b >= 0 ? '+' : ''}${sync.b.toFixed(4)}s  第2ピーク比 ${sync.peakRatio.toFixed(2)}  窓 ${sync.windows.length}  残差 ${sync.residualMs.toFixed(1)}ms`)
  const lean = await time('リーン融合', () => fuseLean(log, cam, sync))
  console.log(`k = ${lean.k.toFixed(4)}  相関 ${lean.rateCorr.toFixed(3)}`)
  for (const tv of [64.5, 65.5, 66.5, 1394, 1398, 1400]) {
    console.log(`  動画 ${tv}s  融合リーン ${interp(tv, lean.t, lean.lean).toFixed(2)}°  ±${interp(tv, lean.t, lean.sd).toFixed(2)}`)
  }
}
await fh.close()
