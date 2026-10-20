// Checks the body map (core/bodymap.ts) using synthetic band images
import assert from 'node:assert/strict'
import {
  BAND_H,
  BAND_W,
  bandRow,
  bandStats,
  bandTheta,
  bodyAt,
  buildStitch,
  compactStitch,
  decodeBodyTrack,
  encodeBodyTrack,
  type BodyTrack
} from '../src/renderer/src/core/bodymap'

const N = BAND_W * BAND_H

// Band coordinates
assert.ok(Math.abs(bandTheta(bandRow(90)) - 90) < 1e-9)
assert.ok(Math.abs(bandTheta(0) - 68.475) < 1e-9)

// ---- The part that does not change over time (the own-bike part) ----
// Columns 0-599 have the same pattern every frame (the own-bike part; only the brightness varies per frame = how the sun hits it), the rest differ every frame (flowing road surface)
{
  let seed = 1
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const fixed = new Float32Array(N)
  for (let i = 0; i < N; i++) fixed[i] = rnd()
  const frames = [0, 1, 2, 3, 4, 5].map((k) => {
    const f = new Uint8Array(N * 4)
    for (let y = 0; y < BAND_H; y++)
      for (let x = 0; x < BAND_W; x++) {
        const i = y * BAND_W + x
        const v = x < 600 ? 40 + 120 * fixed[i] * (0.8 + 0.08 * k) : 40 + 160 * rnd()
        f[i * 4] = f[i * 4 + 1] = f[i * 4 + 2] = Math.round(v)
        f[i * 4 + 3] = 255
      }
    return f
  })
  const s = bandStats(frames)
  const mean = (x0: number, x1: number): number => {
    let a = 0
    let n = 0
    for (let y = 20; y < BAND_H - 20; y++)
      for (let x = x0; x < x1; x++) {
        a += s.stat[y * BAND_W + x]
        n++
      }
    return a / n
  }
  assert.ok(mean(100, 500) > 0.9, `own-bike part does not change: ${mean(100, 500)}`)
  assert.ok(mean(900, 1500) < 0.1, `road surface changes: ${mean(900, 1500)}`)

  // ---- Seam ----
  // If both lenses have the same template (offset 0), the seam is near 90°, the lens 0 side is 0, the lens 1 side is 1, and the offset is 0
  const zero = { fx: new Float32Array(N), fy: new Float32Array(N) }
  const st = buildStitch(s, s, zero, zero)
  for (const x of [100, 300, 500]) assert.ok(Math.abs(bandTheta(st.cut[x]) - 90) < 1, `column ${x} seam ${bandTheta(st.cut[x])}°`)
  const r85 = Math.round(bandRow(85))
  const r95 = Math.round(bandRow(95))
  assert.equal(st.w1[r85 * BAND_W + 300], 0)
  assert.equal(st.w1[r95 * BAND_W + 300], 1)
  assert.ok(st.m[bandRow(90) * BAND_W + 300] > 0.9 || st.m[Math.round(bandRow(90)) * BAND_W + 300] > 0.9, 'own-bike part')
  assert.ok(st.m[Math.round(bandRow(90)) * BAND_W + 1200] < 0.1, 'road surface is not the own-bike part')
  assert.ok(st.dx.every((v) => v === 0) && st.dy.every((v) => v === 0))

  // Cut out only the columns of the own-bike part
  const c = compactStitch(st, null, null)!
  assert.ok(c.w > 600 && c.w < 700, `cropped columns ${c.w}`)
  assert.ok(c.x0 > BAND_W - 50 || c.x0 < 10, `start of cropped columns ${c.x0}`)
  assert.equal(c.fill, undefined)

  // Save and read back
  const track: BodyTrack = { windows: [{ t0: 0, t1: 30, map: 0 }, { t0: 30, t1: 60, map: -1 }], maps: [c] }
  const buf = encodeBodyTrack(track, 'key')
  const back = decodeBodyTrack(buf, 'key')!
  assert.deepEqual(back.windows, track.windows)
  assert.equal(back.maps[0].w, c.w)
  assert.deepEqual(Array.from(back.maps[0].m), Array.from(c.m))
  assert.deepEqual(Array.from(back.maps[0].dy), Array.from(c.dy))
  assert.equal(decodeBodyTrack(buf, 'other'), null, 'does not read the template of another video')
}

// ---- Per-time templates ----
{
  const tr: BodyTrack = { windows: [{ t0: 0, t1: 30, map: 0 }, { t0: 30, t1: 60, map: 1 }, { t0: 60, t1: 90, map: -1 }], maps: [] }
  assert.deepEqual(bodyAt(tr, 5), { a: 0, b: 0, mix: 0 })
  const m = bodyAt(tr, 30)
  assert.equal(m.a, 0)
  assert.equal(m.b, 1)
  assert.ok(Math.abs(m.mix - 0.5) < 1e-9)
  assert.deepEqual(bodyAt(tr, 100), { a: -1, b: -1, mix: 0 })
  assert.deepEqual(bodyAt({ windows: [], maps: [] }, 3), { a: -1, b: -1, mix: 0 })
}

console.log('bodymap.test: OK')
