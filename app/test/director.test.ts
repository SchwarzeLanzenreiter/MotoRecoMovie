// Check of auto camera. Run: npx tsx test/director.test.ts [<insv> <csv>]
import assert from 'node:assert/strict'
import { DEFAULT_DIRECTOR, DEFAULT_SHOT_VIEWS, mergeDirector, mergeShotViews, generateKeyframes, resolveShots, makeShots, shotPreviewView, SHOT_NAMES, changeShot, choiceView, shotPair } from '../src/renderer/src/engine/director'
import { newProject, viewAt, type ViewLayer } from '../src/renderer/src/engine/project'
import { editView } from '../src/renderer/src/engine/edit'
import { splitAtReversals, type RidingTrack } from '../src/renderer/src/core/riding'

// ---- Synthetic data: 0-10 cruise, 10-14 decelerate, 14-20 right corner (max 30°), 20-23 accelerate, 23-60 cruise ----
const rate = 100
const n = 60 * rate
const peak = new Float32Array(n)
for (let i = 14 * rate; i < 20 * rate; i++) peak[i] = Math.min(30, (i - 14 * rate) / 10)
const r: RidingTrack = {
  rate,
  state: new Uint8Array(n),
  weights: [],
  peakLean: peak,
  segments: [
    { state: 'cruise', start: 0, end: 10 },
    { state: 'brake', start: 10, end: 14 },
    { state: 'corner', start: 14, end: 20 },
    { state: 'accel', start: 20, end: 23 },
    { state: 'cruise', start: 23, end: 60 }
  ]
}
const S = DEFAULT_DIRECTOR
const { keyframes } = generateKeyframes([{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }], r, S, 0, 60)
const at = (t: number) => viewAt(keyframes, t)
assert.equal(at(5).yaw, 0) // cruise (the first scenery shot comes after interval/2 = 10 s, so cruises shorter than 10 s do not get one)
// No switching while decelerating/accelerating (stays forward; removed on 2026-10-20)
assert.equal(at(12).pitch, 0)
assert.equal(at(12).fov, 110)
assert.equal(at(18).yaw, 18) // right corner: max lean 30° × 0.6
assert.equal(at(21.5).yaw, 0)
assert.equal(at(21.5).fov, 110)
assert.equal(at(35).yaw, 75) // long cruise (from 23 s): scenery to the right from 23+10 = 33 s
assert.equal(at(55).yaw, -75) // next scenery (from 53 s) alternates left/right, so left
assert.equal(at(59).yaw, 0) // back to forward when the scenery ends
// The switch is a 0.8 s pan (intermediate values midway)
const mid = at(14.4).yaw
assert.ok(mid > 0 && mid < 18, `should be mid-switch: ${mid}`)
// Range: keyframes outside the range are kept
const existing = [{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }, { t: 50, yaw: 90, pitch: 0, fov: 110, leanRatio: 1 }]
const part = generateKeyframes(existing, r, S, 10, 30).keyframes
assert.ok(part.some((k) => k.t === 50 && k.yaw === 90))
assert.equal(viewAt(part, 18).yaw, 18)
// Short shots are dropped
const short = resolveShots(makeShots({ ...r, segments: [{ state: 'stop', start: 1, end: 2.1 }] }, { ...S, stop: { ...S.stop, minDur: 0 } }, 0, 10), S, 0, 10)
assert.ok(short.every((x) => x.shot.kind !== 'stop'), 'a 1.1 s stop is dropped')
// Settings saved earlier (decelerate/accelerate) can still be read
assert.ok(!('brake' in mergeDirector({ brake: { on: true }, accel: { on: true } } as never)))
// ---- Three corner-entry patterns: for every 2 long corners, alternate between ② rider and ③ side view ----
const corners: RidingTrack['segments'] = []
const pk2 = new Float32Array(n)
const signs = [1, -1, 1, -1]
signs.forEach((sg, k) => {
  const a = 5 + k * 12
  corners.push({ state: 'corner', start: a, end: a + 4 })
  for (let i = a * rate; i < (a + 4) * rate; i++) pk2[i] = sg * 30
})
const r2: RidingTrack = { ...r, peakLean: pk2, segments: corners }
const g2 = generateKeyframes([{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }], r2, S, 0, 60).keyframes
const v2 = (t: number) => viewAt(g2, t)
assert.equal(v2(8).yaw, 18) // 1st (right): ① slightly inside
assert.deepEqual([v2(20).yaw, v2(20).fov, v2(20).leanRatio], [-180, 165, 0]) // 2nd (left): ② rider (horizon-locked, wide FOV), turned round to the left
// ② turns round through the inside of the corner: half way through the switch it looks to the inside
{
  const g6 = generateKeyframes([], r2, { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, side: false, sideOut: false } } }, 0, 60).keyframes
  const T = S.transition
  signs.forEach((sg, k) => {
    const a = 5 + k * 12
    const mid = viewAt(g6, a + T / 2).yaw
    assert.ok(sg * mid > 45 && sg * mid < 135, `corner ${k + 1} (${sg > 0 ? 'right' : 'left'}) turns through the inside: ${mid}`)
    assert.equal(Math.abs(viewAt(g6, a + 2).yaw), 180)
  })
}
// Reading settings from before (the project also held the view), the view fields are dropped and the rest is kept as is
{
  const old = { ...S, base: { yaw: 5, pitch: 0, fov: 100, leanRatio: 1 }, corner: { on: false, gain: 0.3, max: 20, special: { ...S.corner.special, every: 3, riderFov: 130, sideFov: 140 } } }
  const m = mergeDirector(old as unknown as typeof S) as unknown as Record<string, unknown> & typeof S
  assert.equal(m.base, undefined)
  assert.deepEqual(m.corner, { on: false, special: { ...S.corner.special, every: 3 } })
}
assert.equal(v2(32).yaw, 18) // 3rd (right): ①
assert.deepEqual([v2(44).yaw, v2(44).fov, v2(44).leanRatio], [-90, 165, 0]) // 4th (left): ③ side view (inside = left, horizon-locked, wide FOV)
// With the interval set to 1 every corner gets a special shot; turning ② off leaves only ③
const g3 = generateKeyframes([], r2, { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, rider: false, sideOut: false } } }, 0, 60).keyframes
assert.deepEqual([viewAt(g3, 8).yaw, viewAt(g3, 20).yaw], [90, -90])
// Alternate ③ inside and ④ outside (outside of a right corner = left -90°, outside of a left corner = right +90°)
const g4 = generateKeyframes([], r2, { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, rider: false } } }, 0, 60).keyframes
assert.deepEqual([8, 20, 32, 44].map((t) => viewAt(g4, t).yaw), [90, 90, 90, 90]) // right ③ inside = +90, left ④ outside = +90, right ③ inside = +90, left ④ outside = +90
assert.deepEqual([8, 20].map((t) => viewAt(g4, t).leanRatio), [0, 0])
const g5 = generateKeyframes([], r2, { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, rider: false, side: false } } }, 0, 60).keyframes
assert.deepEqual([8, 20].map((t) => viewAt(g5, t).yaw), [-90, 90]) // ④ only: left for a right corner, right for a left corner

// ---- Default views (ShotViews): changing forward / corner entry / side / rear changes the view of the generated keyframes ----
{
  const V = structuredClone(DEFAULT_SHOT_VIEWS)
  V.front = { yaw: 0, pitch: 3, fov: 100, leanRatio: 0.8 }
  V.corner = { gain: 1, max: 20, pitch: -5, fov: 120, leanRatio: 0.5 }
  V.side = { yaw: 70, pitch: 10, fov: 150, leanRatio: 0.2 }
  V.rear = { yaw: 170, pitch: -8, fov: 140, leanRatio: 0.1 }
  const sp = { ...S, corner: { ...S.corner, special: { ...S.corner.special, every: 1, sideOut: false } } }
  const g = generateKeyframes([], r2, sp, 0, 60, [], V).keyframes
  const v = (t: number) => viewAt(g, t)
  assert.deepEqual(v(2), { yaw: 0, pitch: 3, fov: 100, leanRatio: 0.8 }, 'forward')
  // For every long corner: ② -> ③ -> ② -> ③ (every: 1)
  assert.deepEqual(v(8), { ...V.rear }, '1st: rear')
  assert.deepEqual(v(20), { yaw: -70, pitch: 10, fov: 150, leanRatio: 0.2 }, '2nd (left): side, inside = left')
  // Corner entry: a short corner (not eligible for special shots), lean 30° × 100% -> max 20°
  const short: RidingTrack = { ...r, peakLean: pk2, segments: [{ state: 'corner', start: 5, end: 7 }] }
  const gc = generateKeyframes([], short, S, 0, 20, [], V).keyframes
  assert.deepEqual(viewAt(gc, 6.5), { yaw: 20, pitch: -5, fov: 120, leanRatio: 0.5 }, 'corner entry')
  // Stays forward during deceleration too
  assert.equal(viewAt(generateKeyframes([], r, S, 0, 60, [], V).keyframes, 12).fov, 100)
  // Keyframe marks (timeline color coding): forward, corner entry, side, rear
  const tags = new Set(g.map((k) => k.tag))
  assert.ok(tags.has('front') && tags.has('side') && tags.has('rear'), [...tags].join(','))
  assert.ok(gc.some((k) => k.tag === 'corner'))
  assert.ok(g.filter((k) => k.tag === 'rear').every((k) => Math.abs(k.yaw) === 170))
  // Preview view (e.g. a right corner with 30° lean)
  assert.deepEqual(shotPreviewView(V, 'corner'), { yaw: 20, pitch: -5, fov: 120, leanRatio: 0.5 })
  assert.equal(shotPreviewView(V, 'side').yaw, 70)
  assert.equal(shotPreviewView(V, 'side', 30, 'out').yaw, -70)
  assert.deepEqual(shotPreviewView(V, 'rear'), V.rear)
  // Remembered values: missing items and non-numeric values are filled with defaults
  assert.deepEqual(mergeShotViews(null), DEFAULT_SHOT_VIEWS)
  const m = mergeShotViews({ rear: { fov: 120, pitch: 'x' }, side: null })
  assert.equal(m.rear.fov, 120)
  assert.equal(m.rear.pitch, DEFAULT_SHOT_VIEWS.rear.pitch)
  assert.deepEqual(m.side, DEFAULT_SHOT_VIEWS.side)
  // The defaults match the earlier behavior (base view 110°, ① 0.6 / max 35°, ②③④ 165° / horizon-locked)
  assert.deepEqual(DEFAULT_SHOT_VIEWS.front, { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 })
}
// ---- Changing a generated shot from the timeline: the keyframe and its pair (same view, same tag) change together ----
{
  const V = DEFAULT_SHOT_VIEWS
  const front = { ...V.front, tag: 'front' as const }
  const side = { ...V.side, tag: 'side' as const }
  // front 0-10, switch to the side 10-11, side held 11-20, back to front 20-21
  const keys = [
    { t: 0, ...front },
    { t: 10, ...front },
    { t: 11, ...side },
    { t: 20, ...side },
    { t: 21, ...front },
    { t: 30, ...front }
  ]
  assert.deepEqual(shotPair(keys, 11), [2, 3], 'switch complete pairs with the next switch start')
  assert.deepEqual(shotPair(keys, 20), [2, 3], 'and the other way round')
  assert.deepEqual(shotPair(keys, 0), [0, 1])
  assert.deepEqual(shotPair(keys, 5), [], 'no keyframe there')
  const { view, tag } = choiceView('rear', V, DEFAULT_DIRECTOR)
  const out = changeShot(keys, 20, view, tag)
  assert.equal(out[2].yaw, V.rear.yaw)
  assert.equal(out[3].yaw, V.rear.yaw)
  assert.equal(out[2].tag, 'rear')
  assert.equal(out[3].t, 20, 'times stay')
  assert.deepEqual(out[1], keys[1], 'other shots stay')
  assert.deepEqual(out[4], keys[4])
  // Left and right, and corner entry by the lean
  assert.equal(choiceView('sideLeft', V, DEFAULT_DIRECTOR).view.yaw, -Math.abs(V.side.yaw))
  assert.ok(choiceView('cornerRight', V, DEFAULT_DIRECTOR, 30).view.yaw > 0)
  assert.ok(choiceView('cornerLeft', V, DEFAULT_DIRECTOR, 30).view.yaw < 0)
  assert.equal(choiceView('overtake', V, DEFAULT_DIRECTOR).view.pitch, DEFAULT_DIRECTOR.overtake.pitch)
}
// ---- S bend: a short left corner (looking left), then a long right corner showing the rider: the view turns to the rear through the
// right (the inside), not the short way through the left, and comes back the same way (0830 Shiretoko pass, 10:37) ----
{
  const pk = new Float32Array(n)
  const segs: RidingTrack['segments'] = [
    { state: 'cruise', start: 0, end: 5 },
    { state: 'corner', start: 5, end: 7 }, // short (below minDur): ① slightly inside, to the left
    { state: 'corner', start: 7.2, end: 12 }, // long: ② the rider
    { state: 'cruise', start: 12, end: 60 }
  ]
  for (let i = 5 * rate; i < 7 * rate; i++) pk[i] = -30
  for (let i = Math.round(7.2 * rate); i < 12 * rate; i++) pk[i] = 30
  const rs: RidingTrack = { ...r, peakLean: pk, segments: segs }
  const sp = { ...S, cruise: { ...S.cruise, on: false }, corner: { ...S.corner, special: { ...S.corner.special, every: 1, side: false, sideOut: false } } }
  const g = generateKeyframes([], rs, sp, 0, 60).keyframes
  const T = S.transition
  assert.ok(viewAt(g, 6.5).yaw < 0, 'looking left in the left corner')
  const mid = viewAt(g, 7.2 + T / 2).yaw
  assert.ok(mid > 0 && mid < 180, `turns to the rear through the right: ${mid}`)
  assert.equal(Math.abs(viewAt(g, 10).yaw), 180)
  const back = g.find((k) => k.t > 10 && k.tag === 'front')!
  const before = [...g].reverse().find((k) => k.t < back.t)!
  const out = viewAt(g, (before.t + back.t) / 2).yaw
  assert.ok(out > 0 && out < 180, `turns back through the right as well: ${out}`)
}

// ---- An S-bend in one corner section is two corners, split where the lean crosses zero ----
{
  // left to -34°, through zero at index 30, right to +36°
  const lean = Float32Array.from({ length: 60 }, (_, i) => (i < 30 ? -34 * Math.sin((Math.PI * i) / 30) : 36 * Math.sin((Math.PI * (i - 30)) / 30)) || 0.0)
  lean[30] = 0.5
  assert.deepEqual(splitAtReversals(lean, 0, 60, 15), [[0, 30], [30, 60]])
  // A wobble to the other side that never passes the corner threshold is not a new corner
  const wob = Float32Array.from({ length: 60 }, (_, i) => (i > 28 && i < 32 ? 8 : -25))
  assert.deepEqual(splitAtReversals(wob, 0, 60, 15), [[0, 60]])
}

// ---- Hand-placed keyframes are kept by auto generation; the view pans to them and back ----
{
  const T = S.transition
  const hand = { yaw: 120, pitch: -10, fov: 90, leanRatio: 0 }
  const existing = [
    { t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }, // the layer's own first keyframe: not counted as hand-placed
    { t: 10, yaw: 75, pitch: 0, fov: 165, leanRatio: 0, tag: 'side' as const }, // from an earlier generation: replaced
    { t: 30, ...hand },
    { t: 33, ...hand }, // same view: one stretch held 30-33
    { t: 45, yaw: -60, pitch: 0, fov: 100, leanRatio: 1 } // a single look
  ]
  const g = generateKeyframes(existing, r, S, 0, 60).keyframes
  const at = (t: number) => viewAt(g, t)
  assert.ok(!g.some((k) => k.t === 10 && k.tag === 'side'), 'generated keyframes of an earlier run are replaced')
  assert.equal(at(31.5).yaw, 120, 'held between the two hand-placed keyframes')
  assert.equal(at(45).yaw, -60)
  assert.ok(g.some((k) => Math.abs(k.t - (30 - T)) < 1e-6 && k.tag) && g.some((k) => Math.abs(k.t - (33 + T)) < 1e-6 && k.tag), 'generated view T before and after')
  assert.ok(!g.some((k) => k.t > 30 - T + 1e-6 && k.t < 33 + T - 1e-6 && k.tag), 'nothing generated inside the stretch')
  assert.notEqual(g.find((k) => k.t === 0)?.tag, undefined, 'the start is generated')
  // Generating again keeps the same hand-placed keyframes once
  const g2b = generateKeyframes(g, r, S, 0, 60).keyframes
  assert.equal(g2b.filter((k) => !k.tag && !k.linear && !k.joint).length, 3)
  assert.deepEqual(g2b.map((k) => [k.t, k.yaw]), g.map((k) => [k.t, k.yaw]))
  // A generated keyframe changed by hand becomes a hand-placed one
  const p = newProject('a.insv')
  const lay = p.layers[0] as ViewLayer
  lay.keyframes = [{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1, tag: 'front' }, { t: 5, yaw: 75, pitch: 0, fov: 165, leanRatio: 0, tag: 'side' }]
  const q = editView(p, lay.id, 5, { yaw: 60 })
  const k5 = (q.layers[0] as ViewLayer).keyframes[1]
  assert.equal(k5.yaw, 60)
  assert.equal(k5.tag, undefined)
}
console.log('director (synthetic data): OK')

// ---- Real data ----
const [insvPath, csvPath] = process.argv.slice(2)
if (insvPath) {
  const { open } = await import('node:fs/promises')
  const { readFileSync } = await import('node:fs')
  const { InsvTrailer } = await import('../src/renderer/src/core/insv')
  const { estimateMount } = await import('../src/renderer/src/core/motion')
  const { cameraRollRate, fuseLean, parseMotoReco, syncLog } = await import('../src/renderer/src/core/motoreco')
  const { buildTelemetry } = await import('../src/renderer/src/core/telemetry')
  const { detectRiding } = await import('../src/renderer/src/core/riding')
  const fh = await open(insvPath, 'r')
  const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
  const tr = await InsvTrailer.open(reader)
  const imu = await tr.imu()
  const mount = estimateMount(imu).R
  const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
  const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
  const sync = syncLog(log, cam)
  const lean = fuseLean(log, cam, sync)
  const dur = tr.meta.frameCount / tr.meta.fps
  const tel = buildTelemetry(log, sync, lean, dur, 0.95)
  const rt = detectRiding(tel)
  const t0 = performance.now()
  const g = generateKeyframes([{ t: 0, yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }], rt, S, 0, dur)
  console.log(`real data: ${(performance.now() - t0).toFixed(0)}ms, keyframes ${g.keyframes.length}, shots ${g.shots.length} (per minute ${((g.shots.length / dur) * 60).toFixed(1)})`)
  const tot: Record<string, number> = {}
  g.shots.forEach((x, i) => {
    const end = g.shots[i + 1]?.start ?? dur
    tot[x.shot.kind] = (tot[x.shot.kind] ?? 0) + end - x.start
  })
  console.log('shot breakdown (seconds)', Object.entries(tot).map(([k, v]) => `${SHOT_NAMES[k as keyof typeof SHOT_NAMES]} ${v.toFixed(0)}`).join(' / '))
  for (const x of g.shots.filter((x) => x.start > 1380 && x.start < 1415)) console.log(`  ${x.start.toFixed(1)}s ${SHOT_NAMES[x.shot.kind]} yaw ${x.shot.view.yaw.toFixed(0)} pitch ${x.shot.view.pitch} fov ${x.shot.view.fov}`)
  await fh.close()
}
