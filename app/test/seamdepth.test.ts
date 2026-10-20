// Checks with synthetic data how the seam distance is chosen (dynamic stitching).
// Run: npx tsx test/seamdepth.test.ts
import assert from 'node:assert/strict'
import { blurSeamQ, chooseSeamCut, chooseSeamDepth, CUT_OFFS, groundPrior } from '../src/renderer/src/render/seamdepth'

const cand = [0, 0.12, 0.25, 0.4, 0.55, 0.75, 1.0, 1.3, 1.7, 2.2]
const bins = 32
const K = cand.length
// Match score: bins 10-14 match at 1.3 m (candidate 7), the others match at infinity (candidate 0). Bins 20-23 have no texture
const cost = new Float32Array(K * bins)
const texture = new Float32Array(bins).fill(0.5)
for (let b = 0; b < bins; b++) {
  const best = b >= 10 && b <= 14 ? 7 : 0
  for (let k = 0; k < K; k++) cost[k * bins + b] = Math.min(1, 0.02 + 0.08 * Math.abs(k - best))
}
for (let b = 20; b <= 23; b++) texture[b] = 0.01
const r = chooseSeamDepth(cost, texture, cand, bins, null, 100)
assert.ok(Math.abs(r.q[12] - 1.3) < 1e-6, `bins of near objects are 1.3m: ${1 / r.q[12]}`)
assert.equal(r.q[3], 0, 'distant-view bins are at infinity')
assert.equal(r.q[21], 0, 'textureless bins follow their neighbors (infinity)')
// On consecutive frames it approaches gradually (to prevent flicker). On a jump in frames it changes immediately
const zero = { q: new Float32Array(bins), frame: 99 }
const r2 = chooseSeamDepth(cost, texture, cand, bins, zero, 100)
assert.ok(r2.q[12] > 0.1 && r2.q[12] < 0.5, `gradually: ${r2.q[12]}`)
const r3 = chooseSeamDepth(cost, texture, cand, bins, zero, 500)
assert.ok(Math.abs(r3.q[12] - 1.3) < 1e-6)
// Ground reference: bins below the horizon (30-59) are 4 m from the ground. The road surface has poor, scattered match scores (0.3-0.6), so the ground distance is chosen.
// Only bin 40 has a near object (e.g. own bike) that clearly matches at 0.6 m (candidate 9), so that one is chosen
{
  const nb = 64
  const g = new Float32Array(nb)
  for (let b = 30; b < 60; b++) g[b] = 0.25
  const c2 = new Float32Array(K * nb)
  for (let b = 0; b < nb; b++)
    for (let k = 0; k < K; k++) {
      if (b >= 30 && b < 60) c2[k * nb + b] = 0.3 + 0.3 * (((b * 7 + k * 13) % 10) / 10) // scatter
      else c2[k * nb + b] = Math.min(1, 0.02 + 0.08 * k)
    }
  for (let k = 0; k < K; k++) c2[k * nb + 40] = Math.min(1, 0.03 + 0.1 * Math.abs(k - 9))
  const rg = chooseSeamDepth(c2, new Float32Array(nb).fill(0.5), cand, nb, null, 100, g)
  for (const b of [31, 35, 45, 50, 58]) assert.ok(Math.abs(rg.q[b] - 0.25) < 1e-6, `road bin ${b} is the ground distance: ${1 / rg.q[b]}m`)
  assert.ok(Math.abs(rg.q[40] - cand[9]) < 1e-6, `near object: ${1 / rg.q[40]}m`)
  assert.equal(rg.q[10], 0, 'above the horizon is unchanged')
  // Ground distance from the gravity direction: direction of azimuth φ = cos φ·e1 + sin φ·e2. If e1 points straight down, φ = 0 gives 1/height
  const gp = groundPrior([0, 1, 0], [1, 0, 0], [0, 1, 0], 360, 1.5)
  assert.ok(Math.abs(gp[0] - 1 / 1.5) < 1e-3 && gp[180] === 0 && gp[90] < 0.02)
}
// Bins with a poor match at every distance: 0.55 at infinity, and only the nearest candidate at 0.24 (an accidental match at the boundary with a bright sky or on weakly textured concrete).
// Setting just one bin to a near distance creates a triangular step at the edge of a wall a little away from the seam. It follows the neighbors (infinity).
// On the other hand, a near object that clearly matches (0.14) is chosen even in a single bin
{
  const c3 = new Float32Array(K * bins)
  for (let b = 0; b < bins; b++) for (let k = 0; k < K; k++) c3[k * bins + b] = Math.min(1, 0.02 + 0.08 * k)
  for (let k = 0; k < K; k++) c3[k * bins + 8] = k === 9 ? 0.24 : 0.55
  for (let k = 0; k < K; k++) c3[k * bins + 20] = k === 6 ? 0.14 : 0.35
  const rt = chooseSeamDepth(c3, new Float32Array(bins).fill(0.9), cand, bins, null, 100)
  assert.equal(rt.q[8], 0, `a poorly matching bin follows its neighbors: ${1 / rt.q[8]}m`)
  assert.ok(Math.abs(rt.q[20] - cand[6]) < 1e-6, `near object with a clear match: ${1 / rt.q[20]}m`)
}
// Blur along the seam: a uniform value stays as is, a value in only one bin spreads to its surroundings and becomes lower (the total is the same, circular)
{
  const one = blurSeamQ(new Float32Array(64).fill(0.5))
  assert.ok(one.every((v) => Math.abs(v - 0.5) < 1e-6))
  const spike = new Float32Array(64)
  spike[0] = 2
  const bl = blurSeamQ(spike)
  assert.ok(bl[0] < 0.5 && bl[63] > 0.1 && bl[63] === bl[1], `spreads: ${bl[0]} ${bl[1]} ${bl[63]}`)
  assert.ok(Math.abs(bl.reduce((a, v) => a + v, 0) - 2) < 1e-4)
}
// ---- Seam position and width (chooseSeamCut): only for azimuths where the images do not match, shift to a position with a small image difference and switch over a narrow width ----
{
  const n = 64
  const J = CUT_OFFS.length
  // Distance match score: bins 20-27 do not match at any distance (near objects, objects visible in only one lens), the others match well at infinity
  const c2 = new Float32Array(K * n)
  for (let b = 0; b < n; b++) for (let k = 0; k < K; k++) c2[k * n + b] = b >= 20 && b <= 27 ? 0.55 : Math.min(1, 0.03 + 0.08 * k)
  // Image difference per position candidate: in the non-matching bins there is an object on the geometric seam (0°), and the difference is small at +4° (road surface)
  const diff = new Float32Array(J * n)
  for (let b = 0; b < n; b++)
    for (let j = 0; j < J; j++) diff[j * n + b] = b >= 20 && b <= 27 ? (CUT_OFFS[j] === 4 ? 0.05 : 0.6) : 0.05
  const tex = new Float32Array(n).fill(0.5)
  const q = new Float32Array(n)
  const c = chooseSeamCut(diff, c2, tex, cand, q, n, null, 10)
  assert.ok(c.ghost[24] > 0.9 && c.ghost[5] === 0, `mismatch degree: ${c.ghost[24]} ${c.ghost[5]}`)
  assert.ok(c.width[24] < 0.35, `narrow where they do not match: ${c.width[24]}`)
  assert.equal(c.width[5], 1, 'matching places stay as is')
  assert.ok(Math.abs(c.off[24] - 4) < 0.5, `shift to a position with a small difference: ${c.off[24]}`)
  assert.ok(Math.abs(c.off[5]) < 1e-6 && Math.abs(c.off[45]) < 1e-6, 'matching places keep the geometric seam')
  // The position changes smoothly along the azimuth (small difference from the neighboring bin)
  for (let b = 1; b < n; b++) assert.ok(Math.abs(c.off[b] - c.off[b - 1]) <= 2.01, `bin ${b}: ${c.off[b - 1]} → ${c.off[b]}`)
  // Textureless places (sky) are not narrowed even if they do not match (a brightness difference would show up as a line)
  const flat = new Float32Array(n).fill(0.01)
  assert.equal(chooseSeamCut(diff, c2, flat, cand, q, n, null, 10).width[24], 1)
  // On consecutive frames it changes gradually
  const c3 = chooseSeamCut(diff, c2, tex, cand, q, n, { ...c, off: new Float32Array(n), width: new Float32Array(n).fill(1), frame: 9 }, 10)
  assert.ok(c3.off[24] > 0 && c3.off[24] < c.off[24], `gradually: ${c3.off[24]}`)
  // Image differences are smoothed over time: even if the difference at another position (−4°) becomes small for just one frame, it is not re-chosen
  const diff2 = new Float32Array(J * n)
  for (let b = 0; b < n; b++)
    for (let j = 0; j < J; j++) diff2[j * n + b] = b >= 20 && b <= 27 ? (CUT_OFFS[j] === -4 ? 0.05 : 0.6) : 0.05
  const c4 = chooseSeamCut(diff2, c2, tex, cand, q, n, { ...c, frame: 9 }, 10)
  assert.ok(c4.off[24] > 3, `not re-chosen after a single frame: ${c4.off[24]}`)
  // Re-chosen when it persists
  let s = c4
  for (let f = 11; f < 200; f++) s = chooseSeamCut(diff2, c2, tex, cand, q, n, s, f)
  assert.ok(s.off[24] < -3, `re-chosen if it continues: ${s.off[24]}`)
}
// When changing position to a neighboring bin, the image differences of the positions in between are also counted (it does not cut diagonally across an object)
{
  const n = 64
  const J = CUT_OFFS.length
  const c2 = new Float32Array(K * n).fill(0.55)
  // Positions with a small difference: bins 0-31 have −6° and +4°, bins 32-63 only +4°. In between (−4 to +2°) is on top of an object and the difference is large
  const diff = new Float32Array(J * n)
  for (let b = 0; b < n; b++)
    for (let j = 0; j < J; j++) {
      const o = CUT_OFFS[j]
      diff[j * n + b] = o === 4 ? 0.12 : o === -6 && b < 32 ? 0.02 : o < -4 || o > 4 ? 0.3 : 0.9
    }
  const c = chooseSeamCut(diff, c2, new Float32Array(n).fill(0.5), cand, new Float32Array(n), n, null, 10)
  for (let b = 0; b < n; b++) assert.ok(c.off[b] > 2, `bin ${b}: does not cross the object to switch to −6°: ${c.off[b]}`)
}
console.log('seamdepth.test: OK')
