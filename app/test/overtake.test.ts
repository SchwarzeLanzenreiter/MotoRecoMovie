// Overtake effect: checks with synthetic data the sections that cross lanes, how overtakes are selected, post-processing of car detection, and shots.
// Run: npx tsx test/overtake.test.ts
import assert from 'node:assert/strict'
import { findLaneCrossings, laneSide, ownSide, type LaneSample } from '../src/renderer/src/core/lanes'
import { findOvertakes } from '../src/renderer/src/core/overtake'
import { decodeVehicles, sightingFromBox, DET_SIZE, type VehicleSighting } from '../src/renderer/src/core/vehicles'
import { DEFAULT_DIRECTOR, DEFAULT_SHOT_VIEWS, generateKeyframes } from '../src/renderer/src/engine/director'
import { viewAt } from '../src/renderer/src/engine/project'

// ---- Center line side from a single observation ----
assert.equal(laneSide({ yellow: { a: 1.5, b: 0, votes: 30 }, road: null }).side, 1)
assert.equal(laneSide({ yellow: { a: -2, b: 0, votes: 30 }, road: null }).side, -1)
assert.equal(laneSide({ yellow: null, road: { left: 1.5, right: 5, leftSeen: 1, rightSeen: 0 } }).side, 1, 'wider road on the right = own lane in left-hand traffic')
assert.equal(laneSide({ yellow: null, road: { left: 6, right: 6, leftSeen: 0, rightSeen: 0 } }).side, 0, 'unknown if the edges are not visible')

// ---- Lane-crossing sections from a sequence of observations ----
const Y = (t: number, a: number, bias = 0): LaneSample => ({ t, side: a >= 0 ? 1 : -1, yellow: true, a, bias })
const R = (t: number, side: -1 | 0 | 1, bias: number): LaneSample => ({ t, side, yellow: false, bias })
{
  const s: LaneSample[] = []
  for (let t = 0; t < 30; t++) s.push(Y(t, 1.5))
  // 30-32 s: opposite lane (overtake)
  s.push(Y(30, -2.8, -0.3), Y(31, -3, -0.25), Y(32, -1, -0.1))
  for (let t = 33; t < 50; t++) s.push(Y(t, 1.4))
  // 60 s: yellow far away just once (e.g. an arrow in the opposite lane) -> not used
  s.push(Y(50, 1.5), Y(51, -4.8), Y(52, 1.5))
  // 70 s: merely passed right over the line (|a| < 0.6) -> not used
  s.push(Y(70, 0.5), Y(71, -0.3), Y(72, 0.6))
  // 80 s: the road width says own lane, but there is a single yellow on the opposite side -> not used
  s.push(R(80, 1, 0.5), Y(81, -1.5, 0.45), R(82, 1, 0.5))
  // 90 s: opposite side twice in a row from road width alone (a road with a white center line) -> used
  s.push(R(90, 1, 0.4), R(91, -1, -0.3), R(92, -1, -0.35), R(93, 1, 0.3))
  // 100 s: opposite side from road width alone but the bias is weak (the paving of a roadside parking lot made the left look wide) -> not used
  s.push(R(100, 1, 0.3), R(101, -1, -0.2), R(102, -1, -0.22), R(103, -1, -0.22), R(104, 1, 0.3))
  assert.equal(ownSide(s), 1, 'left-hand traffic')
  const c = findLaneCrossings(s)
  assert.deepEqual(
    c.map((x) => [x.start, x.end]),
    [
      [29, 33],
      [90, 93]
    ]
  )
}
// Found the same way for right-hand traffic (center line on the left)
{
  const s: LaneSample[] = []
  for (let t = 0; t < 20; t++) s.push(Y(t, -1.5))
  s.push(Y(20, 2.5, 0.3), Y(21, 2.8, 0.3))
  for (let t = 22; t < 30; t++) s.push(Y(t, -1.5))
  assert.equal(ownSide(s), -1)
  assert.deepEqual(findLaneCrossings(s).map((x) => [x.start, x.end]), [[19, 22]])
}

// ---- How overtakes are selected: only sections where a car passed right beside on the overtaking side ----
{
  const crossings = [
    { start: 29, end: 33 }, // a car passes right beside on the left (overtake)
    { start: 60, end: 63 }, // an oncoming car merely passes on the right (opposite side)
    { start: 90, end: 93 } // only the own bike body (always appears large at the rear left)
  ]
  const v: VehicleSighting[] = [
    { t: 30, az: -16, size: 7, score: 0.8, cls: 2, low: 20 }, // front left (not yet directly beside)
    { t: 31, az: -97, size: 33, score: 0.9, cls: 2, low: 20 }, // directly beside on the left
    { t: 61, az: 95, size: 20, score: 0.9, cls: 2, low: 20 }, // oncoming car
    { t: 91, az: -127, size: 31, score: 0.7, cls: 2, low: 44.8 }, // only part of the own bike appearing at the rear left (sometimes classified as a passenger car; cut off at the bottom edge)
    { t: 92, az: -127, size: 31, score: 0.7, cls: 2, low: 44.3 },
    { t: 93, az: -126, size: 29, score: 0.6, cls: 2, low: 39.4 } // the cut-off is shallow but the direction is the same (the direction of the own bike body)
  ]
  // Own bike body: appears large at the rear left at most of the checked times
  for (let t = 0; t < 100; t += 2) v.push({ t, az: -122, size: 50, score: 0.7, cls: 3, low: 20 })
  const o = findOvertakes(crossings, v, 1, 50)
  assert.deepEqual(o.map((x) => [x.start, x.end]), [[29, 33]])
}

// ---- Post-processing of car detection (undo the grid, remove overlaps) ----
{
  const n = (416 / 8) ** 2 + (416 / 16) ** 2 + (416 / 32) ** 2
  assert.equal(n, 3549)
  const out = new Float32Array(n * 85)
  // A car (class 2) at (gx, gy) = (10, 20) of the 8-pixel grid. Center offset 0.5, width/height = exp(2)·8
  const k = 20 * 52 + 10
  out.set([0.5, 0.5, 2, 1.5, 0.9], k * 85)
  out[k * 85 + 5 + 2] = 0.95
  // An overlapping candidate of the same car right next to it (removed)
  out.set([0.6, 0.5, 2, 1.5, 0.8], (k + 1) * 85 - 85 + 85)
  out[(k + 1) * 85 + 5 + 2] = 0.9
  // People (class 0) are not counted
  out.set([0.5, 0.5, 1, 1, 0.9], (k + 5) * 85)
  out[(k + 5) * 85 + 5] = 0.9
  const d = decodeVehicles(out)
  assert.equal(d.length, 1)
  assert.ok(Math.abs(d[0].x - 84) < 1e-6 && Math.abs(d[0].y - 164) < 1e-6 && d[0].cls === 2)
  // If the box center is the image center, the direction of that image (right 90°)
  const s = sightingFromBox({ x: DET_SIZE / 2 - 0.5, y: DET_SIZE / 2 - 0.5, w: 10, h: 20, score: 0.9, cls: 2, low: 20 }, 5, 90, 90)
  assert.ok(Math.abs(s.az - 90) < 1e-6)
}

// ---- Shot: looks up during an overtake (horizon-locked). The switch finishes before the lane crossing starts ----
{
  const s = structuredClone(DEFAULT_DIRECTOR)
  const base = DEFAULT_SHOT_VIEWS.front
  s.overtake.on = true
  const g = generateKeyframes([{ t: 0, ...base }], null, [], s, 0, 60, [{ start: 20, end: 25 }])
  const v = viewAt(g.keyframes, 21)
  assert.equal(v.pitch, s.overtake.pitch)
  assert.equal(v.fov, s.overtake.fov)
  assert.equal(v.leanRatio, 0)
  assert.equal(viewAt(g.keyframes, 20).pitch, s.overtake.pitch, 'already switched by the time the crossing starts')
  assert.equal(viewAt(g.keyframes, 10).pitch, base.pitch)
  // Only the overtake view keyframes (switch completed, start of return) are marked (drawn in yellow on the timeline)
  const tagged = g.keyframes.filter((k) => k.tag === 'overtake')
  assert.equal(tagged.length, 2)
  assert.ok(tagged.every((k) => k.pitch === s.overtake.pitch && k.t >= 19 && k.t <= 26))
  assert.ok(g.keyframes.filter((k) => k.tag !== 'overtake').every((k) => k.pitch === base.pitch && k.tag === 'front'))
  // Does nothing when off
  s.overtake.on = false
  const g2 = generateKeyframes([{ t: 0, ...base }], null, [], s, 0, 60, [{ start: 20, end: 25 }])
  assert.equal(viewAt(g2.keyframes, 21).pitch, base.pitch)
}
// ---- No switch for a slow overtake (when the mean vehicle speed of the section is below overtake.minSpeed) ----
{
  const s = structuredClone(DEFAULT_DIRECTOR)
  const base = DEFAULT_SHOT_VIEWS.front
  s.overtake.on = true
  assert.equal(s.overtake.minSpeed, 40, 'default is 40 km/h')
  const pitchAt = (spans: { start: number; end: number; speed?: number }[]): number => viewAt(generateKeyframes([{ t: 0, ...base }], null, [], s, 0, 60, spans).keyframes, 21).pitch
  assert.equal(pitchAt([{ start: 20, end: 25, speed: 30 }]), base.pitch, 'a 30 km/h overtake does not switch')
  assert.equal(pitchAt([{ start: 20, end: 25, speed: 60 }]), s.overtake.pitch, '60 km/h switches')
  assert.equal(pitchAt([{ start: 20, end: 25 }]), s.overtake.pitch, 'switches if the vehicle speed is unknown')
  s.overtake.minSpeed = 0
  assert.equal(pitchAt([{ start: 20, end: 25, speed: 30 }]), s.overtake.pitch, '0 always switches')
  // Settings saved earlier (without minSpeed) are filled with the default
  const { mergeDirector } = await import('../src/renderer/src/engine/director')
  const old = structuredClone(DEFAULT_DIRECTOR) as unknown as { overtake: Record<string, unknown> }
  delete old.overtake.minSpeed
  assert.equal(mergeDirector(old as never).overtake.minSpeed, 40)
}
console.log('overtake.test: OK')
