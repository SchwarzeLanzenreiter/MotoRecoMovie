// Unit test for the project (layers, keyframes). Run: npx tsx test/project.test.ts
import assert from 'node:assert/strict'
import { migrateProject, newProject, shiftProjectTimes, viewAt, viewLayers, type ViewLayer } from '../src/renderer/src/engine/project'
import { addKey, addOverlayLayer, addViewLayer, editView, keyIndex, keyTolerance, moveLayer, removeKey, removeLayer } from '../src/renderer/src/engine/edit'

let p = newProject('x.insv')
const main = p.layers[0].id
const keys = (q = p, id = main): number[] => (q.layers.find((l) => l.id === id) as ViewLayer).keyframes.map((k) => k.t)
const layer = (id: string): ViewLayer => p.layers.find((l) => l.id === id) as ViewLayer

// A single keyframe: edited directly as the view of the whole layer
p = editView(p, main, 10, { yaw: 30 })
assert.deepEqual(keys(), [0])
assert.equal(layer(main).keyframes[0].yaw, 30)
// An added keyframe keeps the specified time (it is not overwritten by the t of an end keyframe)
p = addKey(p, main, 100)
assert.deepEqual(keys(), [0, 100])
p = editView(p, main, 100, { yaw: -150 })
assert.equal(layer(main).keyframes[1].yaw, -150)
// With two or more, editing at a time without a keyframe creates a new keyframe
p = editView(p, main, 50, { pitch: 10 })
assert.deepEqual(keys(), [0, 50, 100])
p = removeKey(p, main, 50)
assert.deepEqual(keys(), [0, 100])

// Yaw turns the short way (170° -> -170° is only 20°)
const mid = viewAt([{ t: 0, yaw: 170, pitch: 0, fov: 100, leanRatio: 1 }, { t: 1, yaw: -170, pitch: 0, fov: 100, leanRatio: 1 }], 0.5).yaw
assert.ok(Math.abs(Math.abs(mid) - 180) < 1e-9, `the middle yaw should be ±180°: ${mid}`)
assert.equal('t' in viewAt(layer(main).keyframes, -5), false)

// Layers: an added view inherits the original view, and keyframes are independent
p = addViewLayer(p, 'Sub', { x: 0.65, y: 0.65, w: 0.3, h: 0.3 }, 0, layer(main))
const sub = p.layers[1].id
assert.equal(layer(sub).keyframes[0].yaw, 30)
p = editView(p, sub, 0, { yaw: 180 })
assert.equal(layer(sub).keyframes[0].yaw, 180)
assert.equal(layer(main).keyframes[0].yaw, 30)
p = addOverlayLayer(p, 'readout', 'Telemetry', { x: 0.02, y: 0.7, w: 0.3, h: 0.25 })
assert.equal(p.layers.length, 3)
p = moveLayer(p, sub, 1)
assert.deepEqual(p.layers.map((l) => l.type), ['view', 'overlay', 'view'])
// At least one view layer always remains
p = removeLayer(p, sub)
p = removeLayer(p, main)
assert.equal(viewLayers(p).length, 1)

// Loading the v1 format (keyframes directly at the top level)
const v1 = { version: 1, insvPath: 'old', logPath: null, logEnabled: false, keyframes: [{ t: 0, yaw: 5, pitch: 0, fov: 90, leanRatio: 1 }, { t: 3, yaw: 50, pitch: 0, fov: 90, leanRatio: 0 }], export: { width: 1080, height: 1920, codec: 'avc', bitrateMbps: 20, inSec: 1, outSec: 9 } }
const m = migrateProject(v1, 'new.insv')
assert.equal(m.version, 2)
assert.equal(m.insvPath, 'new.insv')
assert.equal(m.logEnabled, false)
assert.equal(m.export.height, 1920)
assert.equal(m.layers.length, 1)
assert.deepEqual((m.layers[0] as ViewLayer).keyframes.map((k) => k.yaw), [5, 50])
assert.equal('keyframes' in m, false)
// The riding-spot commentary (captions) was removed from the app: the commentary and caption layers of old projects are discarded on load
{
  const old = { ...newProject('x.insv'), commentary: [{ id: 'a', kind: 'spot', title: 'Maruyama', text: '…', start: 1, end: 9, look: true, enabled: true }], commentaryLang: 'en' } as Record<string, unknown>
  ;(old.layers as unknown[]).push({ id: 'c', type: 'overlay', name: 'Riding spot commentary (captions)', rect: { x: 0, y: 0, w: 1, h: 0.2 }, visible: true, widget: 'caption', props: {} })
  const mm = migrateProject(JSON.parse(JSON.stringify(old)), 'x.insv')
  assert.equal('commentary' in mm, false)
  assert.equal('commentaryLang' in mm, false)
  assert.ok(mm.layers.every((l) => !(l.type === 'overlay' && (l.widget as string) === 'caption')))
  assert.equal(mm.layers.length, 1)
}
// ---- Keyframes that are not on a frame boundary (auto-generated) can also be deleted/edited while the playhead is on that frame ----
{
  const tol = keyTolerance(50) // 12ms
  let q = newProject('x.insv')
  const id = q.layers[0].id
  q = { ...q, layers: q.layers.map((l) => (l.type === 'view' ? { ...l, keyframes: [{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }, { t: 32.55, yaw: 30, pitch: 0, fov: 110, leanRatio: 1 }, { t: 40, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }] } : l)) }
  // 32.55 s is frame 1627.5. Clicking the ◆ moves to frame 1628 (32.56 s)
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.56), -1, 'was not found with the 0.01 s rule')
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.56, tol), 1)
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.54, tol), 1)
  assert.equal(keyIndex((q.layers[0] as ViewLayer).keyframes, 32.58, tol), -1, 'not treated as a keyframe of the adjacent frame')
  const r = removeKey(q, id, 32.56, tol)
  assert.deepEqual((r.layers[0] as ViewLayer).keyframes.map((k) => k.t), [0, 40])
  // Edit: fix that keyframe instead of adding a new one next to it
  const e = editView(q, id, 32.56, { yaw: 45 }, tol)
  assert.deepEqual((e.layers[0] as ViewLayer).keyframes.map((k) => [k.t, k.yaw]), [[0, 0], [32.55, 45], [40, 0]])
  // Add: do not add if one already exists
  assert.equal((addKey(q, id, 32.56, tol).layers[0] as ViewLayer).keyframes.length, 3)
}
// Time base: a new project uses 1; one saved by an earlier version (has none) is read as having none and shifted when opened
{
  assert.equal(newProject('a.insv').timeBase, 1)
  const old = migrateProject({ ...newProject('a.insv'), timeBase: undefined } as unknown as Record<string, unknown>, 'a.insv')
  assert.equal(old.timeBase, undefined)
  const p = newProject('a.insv')
  const v = p.layers[0] as ViewLayer
  v.keyframes = [{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }, { t: 10, yaw: 30, pitch: 0, fov: 110, leanRatio: 1 }]
  p.markers = [{ t: 5 } as never]
  p.export = { ...p.export, inSec: 2, outSec: -1 }
  p.overtakes = [{ start: 20, end: 25 }]
  p.incident = { ...p.incident, skip: [30] }
  const q = shiftProjectTimes(p, 0.7675)
  assert.deepEqual((q.layers[0] as ViewLayer).keyframes.map((k) => k.t), [0, 10.7675], 'the first keyframe (0 s) stays at the start of the video')
  assert.equal(q.markers[0].t, 5.7675)
  assert.equal(q.export.inSec, 2.7675)
  assert.equal(q.export.outSec, -1, 'to the end (−1) is kept as is')
  assert.deepEqual(q.overtakes, [{ start: 20.7675, end: 25.7675 }])
  assert.deepEqual(q.incident.skip, [30.7675])
  assert.equal(shiftProjectTimes(p, 0), p)
}
// The earlier default lowpass (1500Hz) becomes the new default. Other values are kept
{
  const a = migrateProject({ ...newProject('a.insv'), audioFx: { on: true, declip: true, noiseDb: 12, compThresholdDb: -20, lowpassHz: 1500 } } as unknown as Record<string, unknown>, 'a.insv')
  assert.equal(a.audioFx.lowpassHz, 2000)
  const b = migrateProject({ ...newProject('a.insv'), audioFx: { on: true, declip: true, noiseDb: 12, compThresholdDb: -20, lowpassHz: 3000 } } as unknown as Record<string, unknown>, 'a.insv')
  assert.equal(b.audioFx.lowpassHz, 3000)
}
console.log('project.test: OK')
