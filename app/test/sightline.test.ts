// Checks the line-of-sight judgment for floating signs (core/sightline.ts) on synthetic roads.
// Run: npx tsx test/sightline.test.ts
import assert from 'node:assert/strict'
import { sightVisibility, type RoadTrack } from '../src/renderer/src/core/sightline'

/** Builds a road from a point sequence (x, y, alt) (1 point = 0.1 s) */
function road(pts: [number, number, number][]): RoadTrack {
  return {
    t: Float64Array.from(pts, (_, i) => i * 0.1),
    x: Float64Array.from(pts, (p) => p[0]),
    y: Float64Array.from(pts, (p) => p[1]),
    alt: Float64Array.from(pts, (p) => p[2])
  }
}
const at = (r: RoadTrack, i: number, h: number): { x: number; y: number; h: number } => ({ x: r.x[i], y: r.y[i], h: r.alt[i] + h })
const EYE = 1.2
const TOP = 4.5

// 1. Straight flat road: a sign 300 m ahead is visible too
{
  const r = road(Array.from({ length: 200 }, (_, i) => [0, i * 2, 100] as [number, number, number]))
  assert.equal(sightVisibility(r, 0, r.t[150], at(r, 0, EYE), at(r, 150, TOP)), 1)
}

// 2. Hairpin: go 150 m north, turn back with a 30 m radius and return south. A sign beyond the turn (60 m to the side, the line of sight crosses the mountain slope) is not visible
{
  const pts: [number, number, number][] = []
  for (let y = 0; y <= 150; y += 2) pts.push([0, y, 100])
  for (let a = 0; a <= 180; a += 4) pts.push([30 - 30 * Math.cos((a * Math.PI) / 180), 150 + 30 * Math.sin((a * Math.PI) / 180), 100])
  for (let y = 150; y >= 0; y -= 2) pts.push([60, y, 100])
  const r = road(pts)
  // A sign at y=20 after the turn, seen from the near side (y=0)
  const iSign = pts.findIndex((p, i) => i > 100 && p[0] === 60 && p[1] <= 20)
  const v = sightVisibility(r, 0, r.t[iSign], at(r, 0, EYE), at(r, iSign, TOP))
  assert.equal(v, 0, `sign beyond the hairpin ${v}`)
  // A sign at the hairpin entrance (further along the same straight) is visible
  const iEntry = pts.findIndex((p) => p[1] >= 140)
  assert.equal(sightVisibility(r, 0, r.t[iEntry], at(r, 0, EYE), at(r, iEntry, TOP)), 1)
}

// 3. Mountain pass summit: the summit 150 m ahead is 15 m higher, and the next 100 m is downhill. A sign beyond the summit is not visible. A sign before the summit is visible
{
  const pts: [number, number, number][] = []
  for (let y = 0; y <= 300; y += 2) pts.push([0, y, y <= 150 ? 100 + y * 0.1 : 115 - (y - 150) * 0.15])
  const r = road(pts)
  const iFar = pts.findIndex((p) => p[1] >= 280)
  const iNear = pts.findIndex((p) => p[1] >= 120)
  assert.equal(sightVisibility(r, 0, r.t[iFar], at(r, 0, EYE), at(r, iFar, TOP)), 0, 'beyond the summit')
  assert.equal(sightVisibility(r, 0, r.t[iNear], at(r, 0, EYE), at(r, iNear, TOP)), 1, 'before the summit')
}

// 4. Gentle curve (600 m radius): 200 m ahead is visible too
{
  const R = 600
  const pts: [number, number, number][] = []
  for (let s = 0; s <= 300; s += 2) pts.push([R - R * Math.cos(s / R), R * Math.sin(s / R), 100])
  const r = road(pts)
  const i = pts.findIndex((_, k) => k * 2 >= 200)
  assert.equal(sightVisibility(r, 0, r.t[i], at(r, 0, EYE), at(r, i, TOP)), 1)
}
console.log('sightline.test: OK')
