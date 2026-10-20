// Checks on real data the camera orientation used to project floating signs (cameraInMap).
//   1. The slow component matches the earlier method (fused heading and slope + ideal view), i.e. the coordinate convention is correct
//   2. The earlier method jittered finely relative to the video (the cause of signs trembling). The new method uses the same rotation as the video, so it does not jitter
// Run: npx tsx test/signview.test.ts <insv> <csv>
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
console.log(`computing the rotation to the map ${(performance.now() - t0).toFixed(0)}ms`)

const d2r = Math.PI / 180
const view = { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }
const pxPerDeg = 960 / Math.tan(55 * d2r) * d2r // pixels per 1° at the center of a screen 1920 px wide with a 110° FOV
// Earlier method: a level body with heading h and slope · Rz(ratio·L) (yaw and pitch 0)
const oldCam = (i: number): Mat3 => {
  const tv = mm.videoTime(i)
  const k = Math.min(tel.n - 1, Math.round(tv * tel.rate))
  const g = tel.channels.grade?.[k]
  const th = Math.atan((Number.isFinite(g) ? g! : 0) / 100)
  const L = mm.leanAt(i)! * d2r
  return qToMat(qMul(qMul(qFromRotvec(0, nav.heading[k] * d2r, 0), qFromRotvec(th, 0, 0)), qFromRotvec(0, 0, view.leanRatio * L)))
}

// In 2 sections while riding (60 s each, all frames), look at the difference between the new and old orientation as a rotation vector in camera coordinates (pitch, yaw, roll)
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
  // Fine jitter: deviation from the 0.5 s moving average
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
  const names = ['pitch', 'yaw', 'roll']
  console.log(`t=${start}-${start + 60}s  mean old/new difference ${mean.map((x, c) => `${names[c]} ${x.toFixed(2)}°`).join('  ')}`)
  console.log(`  fine jitter of the earlier method relative to the video (RMS) ${jit.map((x, c) => `${names[c]} ${x.toFixed(2)}°`).join('  ')}  = at screen center: vertical ${(jit[0] * pxPerDeg).toFixed(1)}px, horizontal ${(jit[1] * pxPerDeg).toFixed(1)}px (1920 wide)`)
  // If the coordinate convention is right, the mean difference is within a few degrees (only the estimation differences of heading, slope and lean)
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(mean[c]) < 4, `${names[c]} mean difference ${mean[c].toFixed(2)}° is large`)
}
console.log('signview.test: OK')
await fh.close()
