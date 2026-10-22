// Settings file (engine/settings-file.ts): when saved and loaded into the project of another video, the settings and the positions of meters etc. carry over,
// while the per-video items (main keyframes, seam estimate, export range, the disturbance "don't split" selection) are kept.
// Run: npx tsx test/settings.test.ts
import assert from 'node:assert/strict'
import { applySettings, parseSettings, settingsFromProject } from '../src/renderer/src/engine/settings-file'
import { newProject, newViewLayer, type OverlayLayer, type ViewLayer } from '../src/renderer/src/engine/project'
import { t } from '../src/renderer/src/i18n'

// ---- Saving side: the meter is placed at the bottom right, the rear view is an inset at the top left, export is 4K, and stabilization is weakened ----
const a = newProject('a.insv')
const mainA = a.layers[0] as ViewLayer
mainA.keyframes = [
  { t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 },
  { t: 10, yaw: 30, pitch: 0, fov: 110, leanRatio: 1 }
]
const rearA = newViewLayer('Rear', { x: 0, y: 0, w: 0.3, h: 0.3 }, { yaw: 180, pitch: 5, fov: 150, leanRatio: 0 })
rearA.border = { width: 0.004, color: '#ffffff' }
const riderA = { ...newViewLayer('Own bike (disturbance)', { x: 0.5, y: 0, w: 0.5, h: 1 }, { yaw: 170, pitch: 0, fov: 160, leanRatio: 0 }), role: 'incident' as const }
const meterA: OverlayLayer = { id: 'm1', type: 'overlay', name: 'My meter', rect: { x: 0.7, y: 0.6, w: 0.25, h: 0.4 }, visible: true, widget: 'meter', props: { rpmMax: 12000 } }
a.layers = [mainA, rearA, riderA, meterA]
a.theme = 'ktm'
a.stab = { ...a.stab, sigma: [1, 0.5, 0.3], seam: { rot: [0.1, 0, 0], edge: 1.9 }, seamBlend: 14 }
a.export = { ...a.export, width: 3840, height: 2160, bitrateMbps: 60, inSec: 5, outSec: 50, textLang: 'en', title: { text: 'Pass', sub: 'Day 1', dur: 5 }, fadeOutSec: 3 }
a.director = { ...a.director, transition: 1.2, overtake: { ...a.director.overtake, on: true } }
a.incident = { ...a.incident, on: true, threshold: 2, skip: [12.3] }
a.captions = [{ id: 'k', t: 3, dur: 2, text: 'x' }]

const file = settingsFromProject(a)
// File contents: per-video items are not included
const text = JSON.stringify(file)
assert.ok(!text.includes('"seam":{') && !text.includes('"skip"') && !text.includes('"inSec"') && !text.includes('"captions"') && !text.includes('"title"') && text.includes('"fadeOutSec":3') && !text.includes('keyframes'))
assert.equal(file.layers.length, 4)

// ---- Loading side: another video. The main layer has 3 keyframes, the meter is at a different position, and the seam estimate, export range and disturbance selection differ ----
const b = newProject('b.insv')
const mainB = b.layers[0] as ViewLayer
mainB.name = 'Main' // a project created in English (the default name is treated as the same across languages)
mainB.keyframes = [
  { t: 0, yaw: 0, pitch: 0, fov: 100, leanRatio: 1 },
  { t: 4, yaw: -20, pitch: 0, fov: 100, leanRatio: 1 },
  { t: 8, yaw: 0, pitch: 0, fov: 100, leanRatio: 1 }
]
const meterB: OverlayLayer = { id: 'm2', type: 'overlay', name: 'Gauges', rect: { x: 0.4, y: 0.6, w: 0.2, h: 0.4 }, visible: true, widget: 'meter', props: {} }
b.layers = [mainB, meterB]
b.stab = { ...b.stab, seam: { rot: [0.2, 0.1, 0], edge: 1.7 } }
b.export = { ...b.export, inSec: 100, outSec: 200 }
b.incident = { ...b.incident, skip: [77.7] }
b.captions = [{ id: 'z', t: 9, dur: 2, text: 'y' }]

const sameName = (x: string, y: string): boolean => x === y || ([mainA.name, 'Main'].includes(x) && [mainA.name, 'Main'].includes(y))
const c = applySettings(b, parseSettings(JSON.stringify(file)), sameName)

// Layers follow the order in the file (main, rear, own bike, meter)
assert.deepEqual(
  c.layers.map((l) => `${l.type}:${l.name}`),
  [`view:${mainA.name}`, 'view:Rear', 'view:Own bike (disturbance)', 'overlay:My meter']
)
// The design theme follows the file
assert.equal(c.theme, 'ktm')
// Main is the layer of the destination (same id), and keeps its animated keyframes
const mainC = c.layers[0] as ViewLayer
assert.equal(mainC.id, mainB.id)
assert.deepEqual(mainC.keyframes, mainB.keyframes)
// The rear and own-bike views are newly created, and their direction, position, border and role follow the file
const rearC = c.layers[1] as ViewLayer
assert.deepEqual(rearC.rect, { x: 0, y: 0, w: 0.3, h: 0.3 })
assert.deepEqual(rearC.keyframes, [{ t: 0, yaw: 180, pitch: 5, fov: 150, leanRatio: 0 }])
assert.deepEqual(rearC.border, { width: 0.004, color: '#ffffff' })
assert.equal((c.layers[2] as ViewLayer).role, 'incident')
// The meter type, position and settings follow the file (the destination's meter is replaced)
const meterC = c.layers[3] as OverlayLayer
assert.equal(meterC.widget, 'meter')
assert.deepEqual(meterC.rect, { x: 0.7, y: 0.6, w: 0.25, h: 0.4 })
assert.deepEqual(meterC.props, { rpmMax: 12000 })
// Settings follow the file, and per-video items stay as in the destination
assert.deepEqual(c.stab.sigma, [1, 0.5, 0.3])
assert.equal(c.stab.seamBlend, 14)
assert.deepEqual(c.stab.seam, b.stab.seam)
assert.equal(c.export.width, 3840)
assert.equal(c.export.textLang, 'en')
assert.equal(c.export.inSec, 100)
assert.equal(c.export.outSec, 200)
assert.equal(c.director.transition, 1.2)
assert.equal(c.director.overtake.on, true)
assert.equal(c.incident.threshold, 2)
assert.deepEqual(c.incident.skip, [77.7])
assert.deepEqual(c.captions, b.captions)

// A settings file without view layers keeps the current view layers
{
  const onlyMeter = { ...file, layers: file.layers.filter((l) => l.type === 'overlay') }
  const d = applySettings(b, onlyMeter, sameName)
  assert.ok(d.layers.some((l) => l.id === mainB.id))
}
// Meters of earlier versions (cyber, chronograph) become the themed meter: their color scheme is dropped, a default name gets the new one,
// and the theme of the project is kept when the file has none
{
  const old = JSON.parse(JSON.stringify(file))
  delete old.theme
  old.layers[3] = { ...old.layers[3], widget: 'cyber', name: 'Cyber gauges', props: { theme: 'neon', rpmMax: 10000 } }
  old.layers.push({ ...old.layers[3], widget: 'chrono', name: 'Mine', props: { theme: 'standard' } })
  const e = applySettings({ ...b, theme: 'honda' }, parseSettings(JSON.stringify(old)), sameName)
  const m = e.layers.slice(3) as OverlayLayer[]
  assert.deepEqual(
    m.map((l) => [l.widget, l.name, l.props]),
    [
      ['meter', t('Gauges'), { rpmMax: 10000 }],
      ['meter', 'Mine', {}]
    ]
  )
  assert.equal(e.theme, 'honda')
}
// Settings files saved under the previous name (Insta360 Reframe) are also read
assert.equal(parseSettings(JSON.stringify({ ...file, app: 'insta360-reframe' })).layers.length, 4)
assert.equal(file.app, 'motorecomovie')
// Anything that is not a settings file is not read
assert.throws(() => parseSettings('{"version":2,"layers":[]}'))
assert.throws(() => parseSettings('not json'))
assert.throws(() => parseSettings(JSON.stringify({ ...file, version: 9 })))
console.log('settings.test: OK')
