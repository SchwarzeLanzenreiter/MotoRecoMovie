// Captions and place labels: timing, following a point (patch matching, crop geometry), clicks to directions, and the project format
// Run: npx tsx test/annotations.test.ts
import assert from 'node:assert/strict'
import { captionAlpha, labelAt, labelEnd, trackBefore, type Caption, type PlaceLabel } from '../src/renderer/src/core/annotations'
import { CROP, cropPixelDir, cutPatch, lookAt, matchPatch, PATCH, trackFov } from '../src/renderer/src/core/track'
import { focalFor, projectPoint, unprojectPoint, wideK } from '../src/renderer/src/render/projection'
import { migrateProject, newProject, shiftProjectTimes } from '../src/renderer/src/engine/project'

const near = (a: number, b: number, tol: number, what: string): void => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)

// ---- Captions fade in and out ----
{
  const c: Caption = { id: 'c', t: 10, dur: 4, text: 'x' }
  assert.equal(captionAlpha(c, 9.6), 0)
  near(captionAlpha(c, 9.85), 0.5, 1e-9, 'half way into the fade in, just before its time')
  assert.equal(captionAlpha(c, 10), 1, 'fully there at its time (placed while paused, it shows at once)')
  assert.equal(captionAlpha(c, 12), 1)
  assert.equal(captionAlpha(c, 14.1), 0)
}

// ---- A label follows its samples, fades, and keeps the part before a correction ----
{
  // Turning from +x to +z over 1 s, sampled every 0.25 s
  const dirs: number[] = []
  for (let k = 0; k <= 4; k++) {
    const a = (k / 4) * (Math.PI / 2)
    dirs.push(Math.cos(a), 0, Math.sin(a))
  }
  const l: PlaceLabel = { id: 'l', text: 'Peak', layerId: 'v', t: 5, dir: [1, 0, 0], track: { step: 0.25, dirs, end: 'left' } }
  assert.equal(labelEnd(l), 6)
  assert.equal(labelAt(l, 4.6), null)
  assert.equal(labelAt(l, 5)!.alpha, 1, 'fully there when placed')
  assert.equal(labelAt(l, 6.1), null)
  const mid = labelAt(l, 5.5)!
  near(Math.hypot(...mid.dir), 1, 1e-9, 'unit direction')
  near(Math.atan2(mid.dir[2], mid.dir[0]), Math.PI / 4, 1e-9, 'half way along')
  assert.equal(mid.alpha, 1)
  near(labelAt(l, 4.85)!.alpha, 0.5, 1e-9, 'fades in just before')
  assert.equal(trackBefore(l, 5.6).length, 2 * 3, 'samples before the step the time falls in (5 and 5.25) are kept; following again starts at 5.5')
  assert.deepEqual(trackBefore(l, 4), [])
  assert.equal(labelAt({ ...l, track: undefined }, 5.5), null, 'not drawn before it is followed')
}

// ---- Crop camera: its center looks along the direction, level with the given down ----
{
  const dir: [number, number, number] = [0.3, -0.2, 0.93]
  const down: [number, number, number] = [0, 1, 0]
  const cam = lookAt(dir, down)
  const fov = trackFov(110)
  const c = cropPixelDir(cam, CROP, fov, CROP / 2, CROP / 2)
  const n = Math.hypot(...dir)
  dir.forEach((v, k) => near(c[k], v / n, 1e-12, 'center pixel'))
  // Right column is level (no down component), down column leans toward down
  near(cam[0] * down[0] + cam[3] * down[1] + cam[6] * down[2], 0, 1e-12, 'right is level')
  assert.ok(cam[1] * down[0] + cam[4] * down[1] + cam[7] * down[2] > 0.9, 'down points down')
  // Looking straight down still gives a camera
  const flat = lookAt([0, 1, 0], [0, 1, 0])
  assert.ok(flat.every(Number.isFinite))
}

// ---- A click on the screen gives back the direction that projects there (perspective and wide views) ----
for (const fov of [90, 140, 165]) {
  const f = focalFor(1920, fov)
  const k = wideK(fov)
  for (const [sx, sy] of [[0, 0], [400, -200], [-900, 500]]) {
    const ray = unprojectPoint(sx, sy, f, k)
    near(Math.hypot(...ray), 1, 1e-12, 'unit ray')
    const p = projectPoint(ray, f, k)!
    near(p[0], sx, 1e-6, `x at fov ${fov}`)
    near(p[1], sy, 1e-6, `y at fov ${fov}`)
  }
}

// ---- Patch matching finds a shifted patch to a fraction of a pixel ----
{
  // Smooth random texture
  let seed = 7
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const big = 160
  const noise = new Float32Array(big * big).map(() => rnd() * 255)
  const tex = new Float32Array(big * big)
  for (let y = 2; y < big - 2; y++)
    for (let x = 2; x < big - 2; x++) {
      let s = 0
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) s += noise[(y + j) * big + x + i]
      tex[y * big + x] = s / 25
    }
  // The crop is a window of the texture; the patch comes from another place in it
  const win = (ox: number, oy: number): Float32Array => {
    const out = new Float32Array(CROP * CROP)
    for (let y = 0; y < CROP; y++) for (let x = 0; x < CROP; x++) out[y * CROP + x] = tex[(oy + y) * big + ox + x]
    return out
  }
  const img = win(20, 30)
  const patch = cutPatch(win(20, 30), CROP, 50, 17)
  const m = matchPatch(img, CROP, patch)
  near(m.x, 50, 0.01, 'x')
  near(m.y, 17, 0.01, 'y')
  near(m.score, 1, 1e-4, 'score')
  // A flat patch (sky) cannot be matched
  assert.equal(matchPatch(img, CROP, new Float32Array(PATCH * PATCH).fill(128)).score, 0)
}

// ---- Project: older projects get empty lists; shifting times moves captions and labels ----
{
  const p = migrateProject({ version: 2, layers: newProject('a.insv').layers }, 'a.insv')
  assert.deepEqual(p.captions, [])
  assert.deepEqual(p.labels, [])
  const q = shiftProjectTimes(
    { ...p, captions: [{ id: 'c', t: 3, dur: 2, text: 'x' }], labels: [{ id: 'l', text: 'y', layerId: 'v', t: 4, dir: [0, 0, 1] }] },
    1.5
  )
  assert.equal(q.captions[0].t, 4.5)
  assert.equal(q.labels[0].t, 5.5)
}

console.log('annotations.test: OK')
