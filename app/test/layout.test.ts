// Unit test for split screen (templates, move, resize, snapping). Run: npx tsx test/layout.test.ts
import assert from 'node:assert/strict'
import { newProject, type ViewLayer } from '../src/renderer/src/engine/project'
import { addOverlayLayer, editView } from '../src/renderer/src/engine/edit'
import { applyTemplate, dragRect, snapTargets } from '../src/renderer/src/engine/layout'

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps
let p = newProject('x.insv')
p = editView(p, p.layers[0].id, 0, { yaw: 20 })
p = addOverlayLayer(p, 'readout', 'Telemetry', { x: 0, y: 0.7, w: 0.2, h: 0.2 })
const views = (): ViewLayer[] => p.layers.filter((l): l is ViewLayer => l.type === 'view')

// 4-way split: there are 4 views, and the 2nd onward face back, left and right. The original view direction (yaw 20) is the reference
p = applyTemplate(p, 'grid4', 0)
assert.equal(views().length, 4)
assert.deepEqual(views().map((v) => v.keyframes[0].yaw), [20, 180, -90, 90])
assert.ok(views().every((v) => v.visible && v.border))
// The overlay stays frontmost
assert.equal(p.layers[p.layers.length - 1].type, 'overlay')
// With a 2-way split, the 2 extra ones are hidden, not deleted
const ids = views().map((v) => v.id)
p = applyTemplate(p, 'lr', 0)
assert.deepEqual(views().map((v) => v.id), ids)
assert.deepEqual(views().map((v) => v.visible), [true, true, false, false])
assert.deepEqual(views()[1].rect, { x: 0.5, y: 0, w: 0.5, h: 1 })
// Inset window: no border on the full-screen main, a border on the inset
p = applyTemplate(p, 'pip', 0)
assert.equal(views()[0].border, undefined)
assert.ok(views()[1].border)
// Splitting into 4 again reuses the hidden views (their keyframes are kept)
p = applyTemplate(p, 'grid4', 0)
assert.deepEqual(views().map((v) => v.id), ids)
assert.equal(views()[2].keyframes[0].yaw, -90)

// ---- Drag ----
const T = snapTargets([{ x: 0, y: 0, w: 1, h: 1 }])
const tol = 0.01
// Move: snaps when the right edge approaches 1
let r = dragRect({ x: 0.6, y: 0.1, w: 0.3, h: 0.3 }, 'move', 0.095, 0, T, tol, tol)
assert.ok(near(r.x + r.w, 1), `right edge should snap to 1: ${r.x + r.w}`)
// Move: no snapping when far away
r = dragRect({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 'move', 0.04, 0.02, T, tol, tol)
assert.ok(near(r.x, 0.24) && near(r.y, 0.22))
// Resize (bottom right): only the moved edges change, and it snaps to the center
r = dragRect({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 'se', 0.105, 0.0, T, tol, tol)
assert.ok(near(r.x, 0.1) && near(r.y, 0.1) && near(r.x + r.w, 0.5) && near(r.h, 0.3))
// Resize: never gets smaller than the minimum size
r = dragRect({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 'w', 0.5, 0, T, tol, tol)
assert.ok(r.w >= 0.05 - 1e-9 && near(r.x + r.w, 0.4))
// Also snaps to the edges of other layers
const T2 = snapTargets([{ x: 0.42, y: 0, w: 0.1, h: 1 }])
r = dragRect({ x: 0.0, y: 0.0, w: 0.4, h: 0.4 }, 'e', 0.015, 0, T2, tol, tol)
assert.ok(near(r.x + r.w, 0.42))
console.log('layout.test: OK')

// ---- Lean angle MAX hold (reset on a flick) ----
import { leanHoldTrack } from '../src/renderer/src/core/riding'
const lean = [0, 5, 20, 35, 30, 10, 2, -1, -4, -20, -40, -25, -2, 1, 2.5, -30]
const hold = Array.from(leanHoldTrack(lean))
// Lean right and hold a max of 35° -> reset when flicked left (-4°) -> hold the left max of -40° -> 2.5° to the right is below the threshold, so the hold stays
assert.deepEqual(hold, [0, 5, 20, 35, 35, 35, 35, 35, -4, -20, -40, -40, -40, -40, -40, -40])
console.log('leanHold: OK')
