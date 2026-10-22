// License plates for the mosaic (core/plates.ts): model output, boxes to directions, interpolation between scans, the own bike's plate
// and the scanned ranges, with synthetic data.
// Run: npx tsx test/plates.test.ts
import assert from 'node:assert/strict'
import {
  addRange,
  boxToWorld,
  mergeOverlapping,
  missingRanges,
  OWN_PAD_GROW,
  OWN_SURVEY,
  OWN_SURVEY_LEN,
  ownAt,
  ownPlates,
  parsePlates,
  PLATE_HOLD,
  PLATE_RATE,
  platesAt,
  surveyTimes,
  toPlateInput,
  type PlateScan
} from '../src/renderer/src/core/plates'
import type { Mat3 } from '../src/renderer/src/core/quat'

const I: Mat3 = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps
const deg = Math.PI / 180

// ---- Model output: rows of [batch, x1, y1, x2, y2, class, score]; weak ones dropped ----
{
  const out = new Float32Array([0, 10, 20, 50, 35, 0, 0.8, 0, 100, 100, 120, 110, 0, 0.2])
  assert.deepEqual(parsePlates(out, 2, 0.35), [{ x0: 10, y0: 20, x1: 50, y1: 35, score: Math.fround(0.8) }])
  assert.equal(parsePlates(out, 2, 0.1).length, 2)
}
// ---- Input: RGB planes 0 to 1 ----
{
  const rgba = new Uint8Array([255, 0, 51, 255, 0, 255, 0, 255])
  const x = toPlateInput(rgba, 1)
  assert.deepEqual(Array.from(x).map((v) => +v.toFixed(2)), [1, 0, 0.2])
}
// ---- Box -> directions: the center of a straight-ahead crop is straight ahead; corners spread by the field of view ----
{
  const q = boxToWorld({ x0: 310, y0: 310, x1: 330, y1: 330, score: 1 }, I, 90, 640, I)
  for (const c of q) assert.ok(c[2] > 0.999, 'near the center, looking forward')
  const edge = boxToWorld({ x0: 0, y0: 320, x1: 640, y1: 320, score: 1 }, I, 90, 640, I)
  assert.ok(near(Math.atan2(edge[0][0], edge[0][2]), -45 * deg, 1e-9) && near(Math.atan2(edge[1][0], edge[1][2]), 45 * deg, 1e-9), 'edges of a 90° crop are ±45°')
}

/** A plate centered at azimuth az (rad, about the down axis y) and elevation 0, width w and height h (rad) */
const plate = (az: number, w = 2 * deg, h = 1 * deg): number[] => {
  const out: number[] = []
  for (const [dx, dy] of [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2]
  ]) {
    const a = az + dx
    out.push(Math.sin(a) * Math.cos(dy), Math.sin(dy), Math.cos(a) * Math.cos(dy))
  }
  return out
}
const az = (q: number[]): number => {
  let x = 0
  let z = 0
  for (let k = 0; k < 4; k++) {
    x += q[k * 3]
    z += q[k * 3 + 2]
  }
  return Math.atan2(x, z)
}

// ---- The same plate seen in two overlapping crops is kept once ----
assert.equal(mergeOverlapping([{ quad: plate(10 * deg), score: 0.5 }, { quad: plate(10.2 * deg), score: 0.9 }, { quad: plate(40 * deg), score: 0.6 }]).length, 2)

// ---- Interpolation between neighbouring scans, hold before and after, no jump over a long gap ----
{
  const dt = 1 / PLATE_RATE
  const scans: PlateScan[] = [
    { t: 10, quads: [plate(0)] },
    { t: 10 + dt, quads: [plate(2 * deg)] }
  ]
  const mid = platesAt(scans, 10 + dt / 2)
  assert.equal(mid.length, 1)
  assert.ok(near(az(mid[0]), 1 * deg, 0.05 * deg), `halfway between: ${az(mid[0]) / deg}°`)
  assert.equal(platesAt(scans, 10 - PLATE_HOLD + 0.01).length, 1, 'covered shortly before it is first found')
  assert.equal(platesAt(scans, 10 + dt + PLATE_HOLD - 0.01).length, 1, 'and shortly after it is last found')
  assert.equal(platesAt(scans, 10 + dt + PLATE_HOLD + 0.05).length, 0)
  assert.equal(platesAt(scans, 9).length, 0)
  // Enlarged (PLATE_PAD): wider than the box found
  const w = (q: number[]): number => Math.acos(q[0] * q[3] + q[1] * q[4] + q[2] * q[5])
  assert.ok(w(mid[0]) > 2.5 * deg)
  // Scans far apart are not interpolated (the plate stays put, then the next one appears)
  const far: PlateScan[] = [
    { t: 10, quads: [plate(0)] },
    { t: 13, quads: [plate(2 * deg)] }
  ]
  assert.ok(near(az(platesAt(far, 10.2)[0]), 0, 0.01 * deg))
  // Two plates: each matched to its own
  const two: PlateScan[] = [
    { t: 10, quads: [plate(0), plate(30 * deg)] },
    { t: 10 + dt, quads: [plate(31 * deg), plate(1 * deg)] }
  ]
  const m2 = platesAt(two, 10 + dt / 2).map(az).sort((a, b) => a - b)
  assert.ok(near(m2[0], 0.5 * deg, 0.05 * deg) && near(m2[1], 30.5 * deg, 0.05 * deg), `${m2.map((x) => x / deg)}`)
}

// ---- Own bike's plate: weak detections at one place through the ride; a parked car seen during one stop is not ----
{
  const rig: number[][] = []
  // Own plate behind (azimuth 180°), found now and then over 10 minutes
  for (let t = 0; t < 600; t += 7) rig.push([t, ...plate(Math.PI + (t % 3) * 0.2 * deg)])
  // A parked car during a 60 s stop
  for (let t = 300; t < 360; t += 0.4) rig.push([t, ...plate(40 * deg)])
  const moving = Array.from({ length: 600 * PLATE_RATE }, (_, k) => k / PLATE_RATE)
  const own = ownPlates(rig, moving)
  assert.equal(own.length, 1, 'only the own plate')
  assert.ok(near(Math.abs(az(ownAt(own[0], 100))), Math.PI, 1 * deg), `behind: ${az(ownAt(own[0], 100)) / deg}°`)
  // Covered wider away from its detections
  const w = (q: number[]): number => Math.acos(q[0] * q[3] + q[1] * q[4] + q[2] * q[5])
  assert.ok(w(ownAt(own[0], 700)) > w(ownAt(own[0], 98)) * (1 + OWN_PAD_GROW / 2))
  // A short scanned range (an export of 12 s): found too, from shorter stretches; a single detection is not enough
  const short: number[][] = []
  for (let t = 100; t < 112; t += 0.4) short.push([t, ...plate(Math.PI)])
  assert.equal(ownPlates(short, Array.from({ length: 12 * PLATE_RATE }, (_, k) => 100 + k / PLATE_RATE)).length, 1)
  assert.equal(ownPlates([[1, ...plate(0)]], Array.from({ length: 10 * PLATE_RATE }, (_, k) => k / PLATE_RATE)).length, 0)
}

// ---- Survey: short stretches while moving over the whole video; the own plate is found from them, a car at one stop is not ----
{
  // 40 min ride, stopped for the first 3 minutes and from 20 to 22 min
  const speed = (t: number): number => (t < 180 || (t > 1200 && t < 1320) ? 0 : 50)
  const ts = surveyTimes(2400, speed)
  assert.equal(ts.length, OWN_SURVEY)
  for (const t of ts) assert.ok(speed(t) > 0 && speed(t + OWN_SURVEY_LEN) > 0, `moving at ${t}`)
  assert.ok(ts[0] >= 180 && ts[ts.length - 1] > 2000, `spread: ${ts}`)
  assert.equal(surveyTimes(2400, () => 0).length, 0, 'no stretch while stopped')
  assert.equal(surveyTimes(2400, null).length, OWN_SURVEY, 'without a speed: the middle of each part')
  // Scans of the survey stretches; the own plate found in half of the scans, a parked car only in the first stretch
  const moving: number[] = []
  const rig: number[][] = []
  for (const a of ts)
    for (let k = 0; k * (1 / PLATE_RATE) <= OWN_SURVEY_LEN + 1e-9; k++) {
      const t = Math.round((a + k / PLATE_RATE) * 100) / 100
      moving.push(t)
      if (k % 2 === 0) rig.push([t, ...plate(Math.PI)])
      if (a === ts[0]) rig.push([t, ...plate(40 * deg)])
    }
  const own = ownPlates(rig, moving)
  assert.equal(own.length, 1, 'only the own plate')
  assert.ok(near(Math.abs(az(ownAt(own[0], ts[3]))), Math.PI, 1 * deg))

  // The camera mount turns on the way (90° about the down axis over the video): in rig coordinates the plate moves, in bike
  // coordinates it stays
  const turn = (t: number): Mat3 => {
    const a = (t / 2400) * 90 * deg
    // Columns: body right, down, forward in rig coordinates
    return new Float64Array([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)])
  }
  const turned = rig.filter((h) => near(Math.abs(az(h.slice(1))), Math.PI, 1 * deg)).map((h) => {
    const M = turn(h[0])
    const q = h.slice(1)
    const out = [h[0]]
    for (let j = 0; j < 4; j++) {
      const [x, y, z] = q.slice(j * 3, j * 3 + 3)
      out.push(M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z)
    }
    return out
  })
  assert.equal(ownPlates(turned, moving).length, 0, 'spread in rig coordinates')
  const inBike = ownPlates(turned, moving, turn)
  assert.equal(inBike.length, 1, 'found in bike coordinates')
  assert.ok(near(Math.abs(az(ownAt(inBike[0], ts[5]))), Math.PI, 1 * deg))

  // The mount estimate off by up to 6° for a while: still one place, and where to cover follows the detections nearest in time
  const off = (t: number): Mat3 => {
    const a = (t / 2400) * 90 * deg + 6 * deg * Math.sin(t / 300)
    return new Float64Array([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)])
  }
  const est = ownPlates(turned, moving, off)
  assert.equal(est.length, 1, 'one place despite the error')
  for (const t of ts) {
    const q = ownAt(est[0], t + 0.5)
    const M = off(t + 0.5)
    // Back to rig coordinates with the same (wrong) mount: where the plate was seen
    const r: number[] = []
    for (let j = 0; j < 4; j++) r.push(M[0] * q[j * 3] + M[1] * q[j * 3 + 1] + M[2] * q[j * 3 + 2], 0, M[6] * q[j * 3] + M[7] * q[j * 3 + 1] + M[8] * q[j * 3 + 2])
    const seen = Math.PI + (t / 2400) * 90 * deg
    assert.ok(Math.abs(Math.atan2(Math.sin(az(r) - seen), Math.cos(az(r) - seen))) < 0.5 * deg, `at ${t}: ${az(r) / deg} vs ${seen / deg}`)
  }
}

// ---- Boxes drawn by hand: a place of their own without detections; with detections, they join the place found ----
{
  const none = ownPlates([], [], undefined, [{ t: 5, quad: plate(Math.PI) }])
  assert.equal(none.length, 1, 'a box alone is enough')
  assert.ok(near(Math.abs(az(ownAt(none[0], 500))), Math.PI, 1e-6), 'held from its time on')
  const rig: number[][] = []
  for (let t = 0; t < 600; t += 7) rig.push([t, ...plate(Math.PI + 3 * deg)])
  const moving = Array.from({ length: 600 * PLATE_RATE }, (_, k) => k / PLATE_RATE)
  const both = ownPlates(rig, moving, undefined, [{ t: 100.5, quad: plate(Math.PI) }])
  assert.equal(both.length, 1, 'joined the place found')
  assert.ok(near(Math.abs(az(ownAt(both[0], 100.5))), Math.PI, 1e-6), 'where the box is at its time')
}

// ---- Ranges: merged when they touch, and the parts still to scan ----
{
  let r: [number, number][] = []
  r = addRange(r, [0, 10])
  r = addRange(r, [10.1, 20])
  r = addRange(r, [40, 50])
  assert.deepEqual(r, [
    [0, 20],
    [40, 50]
  ])
  assert.deepEqual(missingRanges(r, 5, 60), [
    [20, 40],
    [50, 60]
  ])
  assert.deepEqual(missingRanges(r, 2, 18), [])
}
console.log('plates.test: OK')
