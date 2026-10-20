// Mount orientation estimation (estimateMount in core/motion.ts): the forward direction is decided from the relation "leaning toward the side of the turn",
// so the test checks with a synthetic IMU that forward is found even when the lenses are mounted facing back or sideways.
// Run: npx tsx test/mount.test.ts
import assert from 'node:assert/strict'
import { estimateMount, IMU_TO_RIG } from '../src/renderer/src/core/motion'
import type { Imu } from '../src/renderer/src/core/insv'

/** Builds the IMU (1 kHz, 10 min) of a ride that turns alternately left and right, given the forward and up directions in rig coordinates */
function ride(fwd: number[], up: number[], seed = 1): Imu {
  const right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]]
  const n = 600_000
  const ts = new Float64Array(n)
  const acc = new Float32Array(n * 3)
  const gyro = new Float32Array(n * 3)
  let r = seed
  const rnd = (): number => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2
  for (let i = 0; i < n; i++) {
    const t = i / 1000
    ts[i] = t * 1e6
    // Turns right and left with a 20 s period. The yaw rate is positive counterclockwise seen from above (negative while turning right),
    // the lean angle is opposite to yaw (leaning right while turning right = positive about the forward axis)
    const w = 2 * Math.PI / 20
    const yaw = -20 * Math.sin(w * t)
    const rollRate = 30 * w * Math.cos(w * t) // derivative of the lean angle 30·sin(wt) [deg/s]
    const pitch = 3 * rnd() // small vibrations such as from the suspension
    const g = [0, 1, 2].map((k) => yaw * up[k] + rollRate * fwd[k] + pitch * right[k])
    const a = up
    // rig coordinates -> IMU coordinates (transpose of IMU_TO_RIG)
    for (let k = 0; k < 3; k++) {
      gyro[i * 3 + k] = IMU_TO_RIG[0 * 3 + k] * g[0] + IMU_TO_RIG[1 * 3 + k] * g[1] + IMU_TO_RIG[2 * 3 + k] * g[2]
      acc[i * 3 + k] = IMU_TO_RIG[0 * 3 + k] * a[0] + IMU_TO_RIG[1 * 3 + k] * a[1] + IMU_TO_RIG[2 * 3 + k] * a[2]
    }
  }
  return { ts, acc, gyro }
}
const fwdOf = (R: Float64Array): number[] => [R[2], R[5], R[8]]
const close = (a: number[], b: number[]): boolean => a.every((v, k) => Math.abs(v - b[k]) < 0.05)

// Lens 1 (rig -z) faces forward: forward with both the old and the current method
{
  const m = estimateMount(ride([0, 0, -1], [0, -1, 0]))
  assert.ok(close(fwdOf(m.R), [0, 0, -1]), `facing forward: ${fwdOf(m.R).map((v) => v.toFixed(2))}`)
  assert.equal(m.by, 'lean')
  assert.ok(m.coupling < -0.5)
  assert.equal(m.flippedFromLens, false)
}
// Lens 1 faces back (mounted behind the top case, filming forward): the old method took the lens direction (back) as forward
{
  const m = estimateMount(ride([0, 0, 1], [0, -1, 0]))
  assert.ok(close(fwdOf(m.R), [0, 0, 1]), `facing back: ${fwdOf(m.R).map((v) => v.toFixed(2))}`)
  assert.equal(m.flippedFromLens, true)
}
// Lens facing diagonally back, body lying on its side (up = toward rig x)
{
  const f = [0.6, 0, 0.8]
  const m = estimateMount(ride(f, [0.8, 0, -0.6]))
  assert.ok(close(fwdOf(m.R), f), `diagonal: ${fwdOf(m.R).map((v) => v.toFixed(2))}`)
}
console.log('mount.test: OK')

// ---- Mount orientation over time (core/mount.ts): even if the camera rotates 60° about the forward axis while riding, forward and up are found per time ----
{
  const { estimateMountTrack, mountFwdAt, mountUpAt } = await import('../src/renderer/src/core/mount')
  // Over 10 minutes, the camera rotates from 0 to 60° about the vehicle's longitudinal axis (in rig coordinates, the vehicle's up and right rotate).
  // Forward is rig -z (the lens 1 direction)
  const n = 600_000
  const ts = new Float64Array(n)
  const acc = new Float32Array(n * 3)
  const gyro = new Float32Array(n * 3)
  let r = 7
  const rnd = (): number => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2
  const fwd = [0, 0, -1]
  const upAt = (t: number): number[] => {
    const a = ((60 * t) / 600) * (Math.PI / 180)
    return [Math.sin(a), -Math.cos(a), 0] // up = rig −y at t = 0
  }
  for (let i = 0; i < n; i++) {
    const t = i / 1000
    ts[i] = t * 1e6
    const up = upAt(t)
    const right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]]
    const w = (2 * Math.PI) / 20
    const yaw = -20 * Math.sin(w * t)
    const rollRate = 30 * w * Math.cos(w * t) + 0.1 // + the part from the camera rotating (0.1°/s)
    const pitch = 3 * rnd()
    const g = [0, 1, 2].map((k) => yaw * up[k] + rollRate * fwd[k] + pitch * right[k])
    for (let k = 0; k < 3; k++) {
      gyro[i * 3 + k] = IMU_TO_RIG[k] * g[0] + IMU_TO_RIG[3 + k] * g[1] + IMU_TO_RIG[6 + k] * g[2]
      acc[i * 3 + k] = IMU_TO_RIG[k] * up[0] + IMU_TO_RIG[3 + k] * up[1] + IMU_TO_RIG[6 + k] * up[2]
    }
  }
  const tr = estimateMountTrack({ ts, acc, gyro })
  assert.equal(tr.fixed, false, 'mount orientation that varies over time')
  for (const t of [60, 300, 540]) {
    const u = mountUpAt(tr, t * 1e6)
    const f = mountFwdAt(tr, t * 1e6)
    const eu = (Math.acos(Math.min(1, u[0] * upAt(t)[0] + u[1] * upAt(t)[1] + u[2] * upAt(t)[2])) * 180) / Math.PI
    const ef = (Math.acos(Math.min(1, -f[2])) * 180) / Math.PI
    assert.ok(eu < 3 && ef < 3, `${t} s: up error ${eu.toFixed(1)}° forward error ${ef.toFixed(1)}°`)
  }
  // A fixed mount gives a single orientation
  assert.equal(estimateMountTrack(ride([0, 0, -1], [0, -1, 0])).fixed, true)
}
console.log('mount.test (time variation): OK')
