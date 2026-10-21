// Own-bike mask (core/bikemask.ts) on synthetic color frames:
//   1. a textured object that stays in place (wandering by a pixel) with a flat dark inside, over moving scenery -> its core and envelope
//      cover it, the scenery is not covered, and the color table tells its color from the sky's
//   2. no object at all (camera that does not see the bike) -> nothing covered
//   3. a patch that is still in only one stretch is dropped by keepConsistent; binary round trip
// Run: npx tsx test/bikemask.test.ts
import assert from 'node:assert/strict'
import { bikeMaskAt, buildBikeMask, decodeBikeMasks, encodeBikeMasks, keepConsistent, lutIndex, maskAt, maskDir, MASK_H, MASK_W } from '../src/renderer/src/core/bikemask'

let seed = 1
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
const N = MASK_W * MASK_H
const SKY = [120, 170, 230]

/** Scenery: a blue sky above, random gray texture below, scrolled sideways by `shift` (the heading changes between keyframes) */
function scenery(shift: number): Uint8Array {
  const f = new Uint8Array(N * 3)
  const tex = new Uint8Array(N)
  for (let p = 0; p < N; p++) tex[p] = 60 + rnd() * 120
  for (let v = 0; v < MASK_H; v++) {
    for (let u = 0; u < MASK_W; u++) {
      const p = v * MASK_W + u
      if (v < MASK_H * 0.45) for (let c = 0; c < 3; c++) f[p * 3 + c] = SKY[c] + (v / MASK_H) * 30 + rnd() * 3
      else f.fill(tex[v * MASK_W + ((u + shift) % MASK_W)], p * 3, p * 3 + 3)
    }
  }
  return f
}

/** The "bike": a rectangle with a textured border and a flat dark inside, at (u0, v0), wandering by (du, dv) */
const OBJ = { u0: 230, v0: 60, w: 50, h: 70 }
const DARK = [25, 25, 40]
const pattern = Array.from({ length: (OBJ.w + 4) * (OBJ.h + 4) }, () => 20 + rnd() * 200)
function addObject(f: Uint8Array, du: number, dv: number): void {
  for (let y = 0; y < OBJ.h; y++) {
    for (let x = 0; x < OBJ.w; x++) {
      const p = (OBJ.v0 + y + dv) * MASK_W + OBJ.u0 + x + du
      const edge = x < 6 || y < 6 || x >= OBJ.w - 6 || y >= OBJ.h - 6
      for (let c = 0; c < 3; c++) f[p * 3 + c] = edge ? pattern[y * (OBJ.w + 4) + x] : DARK[c]
    }
  }
}

const K = 16
const withBike: Uint8Array[] = []
const withoutBike: Uint8Array[] = []
for (let k = 0; k < K; k++) {
  const s = Math.floor(rnd() * MASK_W)
  const a = scenery(s)
  addObject(a, Math.round(rnd() * 2 - 1), Math.round(rnd() * 2 - 1))
  withBike.push(a)
  withoutBike.push(scenery(s))
}

// 1. The object is covered (its flat inside too); scenery is not
const m = buildBikeMask(withBike.map((f) => f.slice()))!
assert.ok(m, 'mask built')
const inside = (u: number, v: number): boolean => u >= OBJ.u0 && u < OBJ.u0 + OBJ.w && v >= OBJ.v0 && v < OBJ.v0 + OBJ.h
// The envelope may reach ENV_REACH + ENV_MARGIN (40) pixels beyond the core, which itself reaches a little past the object
const far = (u: number, v: number): boolean => u < OBJ.u0 - 70 || u > OBJ.u0 + OBJ.w + 70 || v < OBJ.v0 - 70 || v > OBJ.v0 + OBJ.h + 70
let objCore = 0
let objN = 0
let farCore = 0
let farEnv = 0
let farN = 0
for (let v = 0; v < MASK_H; v++) {
  for (let u = 0; u < MASK_W; u++) {
    const p = v * MASK_W + u
    if (inside(u, v)) {
      objN++
      if (m.core[p]) objCore++
      assert.equal(m.env[p], 255, 'the envelope holds the whole object')
    } else if (far(u, v)) {
      farN++
      if (m.core[p]) farCore++
      if (m.env[p]) farEnv++
    }
  }
}
console.log(`object in the core ${((100 * objCore) / objN).toFixed(1)}%, scenery in the core ${((100 * farCore) / farN).toFixed(2)}%, in the envelope ${((100 * farEnv) / farN).toFixed(2)}%`)
assert.ok(objCore / objN > 0.95, 'the object (including its flat inside) is in the core')
assert.ok(farCore / farN < 0.01, 'the scenery is not in the core')
assert.ok(farEnv / farN < 0.01, 'the envelope stays around the object')
// Color table: the object's dark color is the bike, the sky is not
assert.ok(m.lut[lutIndex(DARK[0], DARK[1], DARK[2])] >= 200, 'dark object color -> bike')
assert.ok(m.lut[lutIndex(SKY[0] + 10, SKY[1] + 10, SKY[2] + 10)] <= 50, 'sky color -> scenery')

// 2. No bike in view: nothing (or next to nothing) is covered
const none = buildBikeMask(withoutBike.map((f) => f.slice()))!
const covered = none.env.reduce((s, x) => s + (x ? 1 : 0), 0)
console.log(`without the bike: ${covered} pixels in the envelope`)
assert.ok(covered < N * 0.002, 'nothing is hidden when the camera does not see the bike')

// Too few frames: no mask
assert.equal(buildBikeMask(withBike.slice(0, 4)), null)

// 3. A part present in only one of three stretches is dropped (with its envelope); the object (in all three) stays
const copy = (x: typeof m): typeof m => ({ core: x.core.slice(), env: x.env.slice(), lut: x.lut.slice() })
const a = copy(m)
const b = copy(m)
const c = copy(m)
for (let v = 180; v < 210; v++) {
  for (let u = 400; u < 460; u++) {
    b.core[v * MASK_W + u] = 255
    b.env[v * MASK_W + u] = 255
  }
}
keepConsistent([a, b, c])
assert.equal(b.core[190 * MASK_W + 420], 0, 'a patch seen in one stretch only is dropped')
assert.equal(b.env[190 * MASK_W + 420], 0, 'its envelope goes with it')
assert.equal(b.core[(OBJ.v0 + 30) * MASK_W + OBJ.u0 + 20], 255, 'the bike seen in every stretch stays')

// Lookup by direction matches the pixel
const pc = (OBJ.v0 + 30) * MASK_W + OBJ.u0 + 20
const d = maskDir(OBJ.u0 + 20, OBJ.v0 + 30)
assert.equal(maskAt(m.core, d[0], d[1], d[2]), m.core[pc] / 255)

// Round trip and the key check
const tr = { windows: [{ t0: 0, t1: 300, mask: 0 }, { t0: 300, t1: 600, mask: -1 }], masks: [m] }
const back = decodeBikeMasks(encodeBikeMasks(tr, 'video-a'), 'video-a')!
assert.deepEqual(back.windows, tr.windows)
assert.deepEqual(back.masks[0].core, m.core)
assert.deepEqual(back.masks[0].env, m.env)
assert.deepEqual(back.masks[0].lut, m.lut)
assert.equal(decodeBikeMasks(encodeBikeMasks(tr, 'video-a'), 'video-b'), null)
assert.equal(bikeMaskAt(back, 450), back.masks[0], 'a stretch without a mask uses the nearest one')
console.log('bikemask.test: OK')

// Masks from the segmentation model's outlines counted over the frames: often covered = sure part, sometimes = where it can be
{
  const { masksFromCounts } = await import('../src/renderer/src/core/bikemask')
  const seen = new Uint16Array(N).fill(20)
  const hits = new Uint16Array(N)
  const at = (u: number, v: number): number => v * MASK_W + u
  for (let v = 100; v < 140; v++) for (let u = 200; u < 240; u++) hits[at(u, v)] = 18 // the bike: in nearly every frame
  for (let v = 90; v < 100; v++) for (let u = 210; u < 230; u++) hits[at(u, v)] = 5 // the rider's head moving: sometimes
  for (let v = 10; v < 20; v++) for (let u = 10; u < 20; u++) hits[at(u, v)] = 5 // a pole far away: sometimes, but not connected
  const r = masksFromCounts(seen, hits, 20)!
  assert.equal(r.core[at(220, 120)], 255, 'the bike is the sure part')
  assert.equal(r.core[at(220, 95)], 0, 'the moving head is not the sure part')
  assert.equal(r.env[at(220, 95)], 255, 'but it is where the rider can be')
  assert.equal(r.env[at(15, 15)], 0, 'a part not connected to the bike is dropped')
  assert.equal(r.env[at(300, 200)], 0, 'nothing elsewhere')
  assert.equal(masksFromCounts(seen, new Uint16Array(N), 20), null, 'no outlines: null')
  console.log('bikemask.test (counted outlines): OK')
}
