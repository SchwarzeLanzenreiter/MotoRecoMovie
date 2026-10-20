// Checks on real data that the line of sight does not drop toward the ground when looking sideways while leaning (horizon-referenced yaw).
// Run: npx tsx test/view.test.ts <insv> <csv>
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { InsvTrailer } from '../src/renderer/src/core/insv'
import { estimateMount, integrate } from '../src/renderer/src/core/motion'
import { cameraRollRate, fuseLean, parseMotoReco, syncLog } from '../src/renderer/src/core/motoreco'
import { matVec, qAxisAngle, qRotate } from '../src/renderer/src/core/quat'
import { MotionModel } from '../src/renderer/src/engine/motion-model'
import { fixedMount } from '../src/renderer/src/core/mount'
import { newProject } from '../src/renderer/src/engine/project'

const [insvPath, csvPath] = process.argv.slice(2)
const fh = await open(insvPath, 'r')
const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
const tr = await InsvTrailer.open(reader)
const imu = await tr.imu()
const mount = estimateMount(imu).R
const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
const lean = fuseLean(log, cam, syncLog(log, cam))
const ft = await tr.gyroFrameTimes(0)
const stab = newProject('x').stab
const mm = new MotionModel(tr.meta, integrate(imu), fixedMount(mount), ft, lean, stab)
const i = 1400 * 50
const L = mm.leanAt(i)!
// The rig-coordinates "straight up" = the vehicle's up direction rotated by -L about the longitudinal axis (same as validate_tilt.py)
const fwd = [mount[2], mount[5], mount[8]]
const upB = [-mount[1], -mount[4], -mount[7]]
const up = qRotate(qAxisAngle(fwd, (-L * Math.PI) / 180), upB)
const deg = (r: number): number => (r * 180) / Math.PI
const measure = (yaw: number, ratio: number): { elev: number; tilt: number } => {
  const V = mm.frame(i, { yaw, pitch: 0, fov: 100, leanRatio: ratio }).view // columns = right, down, forward (rig coordinates)
  const f = matVec(V, [0, 0, 1])
  const rgt = matVec(V, [1, 0, 0])
  const dn = matVec(V, [0, 1, 0])
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return { elev: deg(Math.asin(dot(f, up))), tilt: deg(Math.atan2(dot(up, rgt), -dot(up, dn))) }
}
console.log(`t=1400s lean ${L.toFixed(1)}°`)
// Screen tilt of a camera fixed to the vehicle (no stabilization): keep lean 100% tilts in the same direction as this, facing front or back
const rigid = new MotionModel(tr.meta, integrate(imu), fixedMount(mount), ft, lean, { ...stab, enabled: false })
const rigidTilt = (yaw: number): number => {
  const V = rigid.frame(i, { yaw, pitch: 0, fov: 100, leanRatio: 1 }).view
  const rgt = matVec(V, [1, 0, 0])
  const dn = matVec(V, [0, 1, 0])
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return deg(Math.atan2(dot(up, rgt), -dot(up, dn)))
}
for (const ratio of [1, 0]) {
  for (const yaw of [0, 30, 60, 90, 180]) {
    const m = measure(yaw, ratio)
    console.log(`  keep lean ${ratio * 100}%  yaw ${String(yaw).padStart(3)}°: gaze elevation ${m.elev.toFixed(1).padStart(6)}°  screen tilt ${m.tilt.toFixed(1).padStart(6)}°`)
    // The line of sight stays level even when looking sideways (it deviates slightly by the vertical movement of the vehicle)
    assert.ok(Math.abs(m.elev) < 6, `at yaw ${yaw}° the line of sight is off vertically by ${m.elev.toFixed(1)}°`)
    // Screen tilt is "keep ratio × cos(yaw) × lean angle". Level when facing directly sideways, and opposite when facing back versus forward
    // (a line of sight facing back is opposite to the vehicle's longitudinal axis, so even a camera fixed to the vehicle looks tilted the other way)
    const expect = -ratio * Math.cos((yaw * Math.PI) / 180) * L
    assert.ok(Math.abs(m.tilt - expect) < 4, `tilt at yaw ${yaw}°: ${m.tilt.toFixed(1)}° (expected ${expect.toFixed(1)}°)`)
  }
}
for (const yaw of [0, 180]) {
  const k = measure(yaw, 1).tilt
  const r = rigidTilt(yaw)
  console.log(`  yaw ${yaw}°: keep lean 100% ${k.toFixed(1)}°, camera fixed to the vehicle ${r.toFixed(1)}°`)
  assert.ok(Math.sign(k) === Math.sign(r) && Math.abs(k - r) < 8, `at yaw ${yaw}° the tilt direction differs from the camera fixed to the vehicle`)
}
console.log('view.test: OK')
await fh.close()
