// 空中の標識の投影に使うカメラの向き（cameraInMap）を実データで確認する。
//   1. 以前の方法（融合した方位・勾配 + 理想の視点）と、ゆっくりした成分が一致すること（座標の取り方が正しい）
//   2. 以前の方法は映像に対して細かく揺れていた（標識がプルプル動く原因）こと。新しい方法は映像と同じ回転なので揺れない
// 実行: npx tsx test/signview.test.ts <insv> <csv>
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMount, integrate } from '../src/renderer/src/core/motion'
import { fixedMount } from '../src/renderer/src/core/mount'
import { cameraRollRate, cameraYawRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { buildTelemetry, estimateGpsDelay } from '../src/renderer/src/core/telemetry'
import { buildNav } from '../src/renderer/src/core/nav'
import { matMul, matT, matToQ, qFromRotvec, qMul, qToMat, qToRotvec, type Mat3 } from '../src/renderer/src/core/quat'
import { MotionModel } from '../src/renderer/src/engine/motion-model'
import { newProject } from '../src/renderer/src/engine/project'

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
const nav = buildNav(tel, yaw)!
const ft = await tr.gyroFrameTimes(0)
const mm = new MotionModel(tr.meta, integrate(imu), fixedMount(mount), ft, lean, newProject('x').stab)
let t0 = performance.now()
mm.setNav({ rate: tel.rate, heading: nav.heading, grade: tel.channels.grade ?? null })
console.log(`地図への回転の計算 ${(performance.now() - t0).toFixed(0)}ms`)

const d2r = Math.PI / 180
const view = { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }
const pxPerDeg = 960 / Math.tan(55 * d2r) * d2r // 幅 1920px・画角 110° の画面中央で 1° あたりの画素数
// 以前の方法: 方位 h・勾配の水平な車体 · Rz(割合·L)（ヨー・ピッチ 0）
const oldCam = (i: number): Mat3 => {
  const tv = mm.videoTime(i)
  const k = Math.min(tel.n - 1, Math.round(tv * tel.rate))
  const g = tel.channels.grade?.[k]
  const th = Math.atan((Number.isFinite(g) ? g! : 0) / 100)
  const L = mm.leanAt(i)! * d2r
  return qToMat(qMul(qMul(qFromRotvec(0, nav.heading[k] * d2r, 0), qFromRotvec(th, 0, 0)), qFromRotvec(0, 0, view.leanRatio * L)))
}

// 走行中の 2 区間（各 60 秒・全フレーム）で、新旧の向きの差をカメラ座標の回転ベクトル（ピッチ・ヨー・ロール）で見る
for (const start of [600, 1400]) {
  const fps = tr.meta.fps
  const i0 = Math.round(start * fps)
  const n = Math.round(60 * fps)
  const d: number[][] = []
  for (let i = i0; i < i0 + n; i++) {
    const fp = mm.frame(i, view)
    const nw = mm.cameraInMap(i, fp.world)!
    const rv = qToRotvec(matToQ(matMul(matT(oldCam(i)), nw)))
    d.push(rv.map((x) => x / d2r))
  }
  const mean = [0, 1, 2].map((c) => d.reduce((s, x) => s + x[c], 0) / n)
  // 細かい揺れ: 0.5 秒の移動平均からのずれ
  const w = Math.round(fps / 4)
  const jit = [0, 1, 2].map((c) => {
    let s = 0
    let cnt = 0
    for (let k = w; k < n - w; k++) {
      let m = 0
      for (let j = -w; j <= w; j++) m += d[k + j][c]
      s += (d[k][c] - m / (2 * w + 1)) ** 2
      cnt++
    }
    return Math.sqrt(s / cnt)
  })
  const names = ['ピッチ', 'ヨー', 'ロール']
  console.log(`t=${start}〜${start + 60}s  新旧の差の平均 ${mean.map((x, c) => `${names[c]} ${x.toFixed(2)}°`).join('  ')}`)
  console.log(`  以前の方法の映像に対する細かい揺れ（RMS）${jit.map((x, c) => `${names[c]} ${x.toFixed(2)}°`).join('  ')}  = 画面中央で 縦 ${(jit[0] * pxPerDeg).toFixed(1)}px・横 ${(jit[1] * pxPerDeg).toFixed(1)}px（1920 幅）`)
  // 座標の取り方が合っていれば、平均の差は数度以内（方位・勾配・リーンの推定の差だけ）
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(mean[c]) < 4, `${names[c]} の平均の差 ${mean[c].toFixed(2)}° が大きい`)
}
console.log('signview.test: OK')
await fh.close()
