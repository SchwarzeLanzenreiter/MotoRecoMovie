// Meter: checks the grey-out decision while the engine is stopped (enginePower), the rolling digits and the air temperature colors with
// synthetic data, and that every design theme is complete.
// Run: npx tsx test/meter.test.ts [<.insv> <MotoReco .csv>]   given real data, it prints the sections where the engine is stopped
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { airShift, airTempShown, enginePower, gearShift, POP_TIME, ROLL_TIME } from '../src/renderer/src/render/overlay'
import type { Telemetry } from '../src/renderer/src/core/telemetry'
import { airTempColor } from '../src/renderer/src/render/theme'
import { getTheme, THEMES } from '../src/renderer/src/render/themes'
import { drawMeter, DEFAULT_METER, type MeterEmphasis } from '../src/renderer/src/render/meter'

// Stopped for 0-10 s (0 rpm), starts at 10 s (1100 rpm), stops at 30 s
const rate = 100
const n = 40 * rate
const rpm = new Float32Array(n).map((_, i) => (i >= 10 * rate && i < 30 * rate ? 1100 : 0))
const tel = { rate, n, t0: 0, channels: { rpm }, gps: null } as unknown as Telemetry
assert.equal(enginePower(tel, 5), 0, '0 while stopped (gray)')
assert.equal(enginePower(tel, 20), 1, '1 while running (normal color)')
const mid = enginePower(tel, 10.25)
assert.ok(mid > 0 && mid < 1, `right after starting, it gradually returns from gray: ${mid}`)
assert.equal(enginePower(tel, 10.6), 1, 'normal color 0.5 s after starting')
assert.ok(enginePower(tel, 30.25) > 0 && enginePower(tel, 30.25) < 1, 'right after stopping, it gradually turns gray')
assert.equal(enginePower(tel, 31), 0)
// No effect when there is no rpm data (no vehicle log, or the log has no rpm)
assert.equal(enginePower(null, 5), 1)
assert.equal(enginePower({ ...tel, channels: {} } as Telemetry, 5), 1)

// ---- Digit change: gear 6 -> 5 at 20 s. For ROLL_TIME + POP_TIME seconds it returns the previous value and the elapsed time ----
{
  const gear = new Float32Array(n).map((_, i) => (i < 20 * rate ? 6 : 5))
  const tg = { rate, n, t0: 0, channels: { gear } } as unknown as Telemetry
  assert.equal(gearShift(tg, 19.9), null, 'before the change')
  const s = gearShift(tg, 20.1)
  assert.ok(s && s.prev === 6 && Math.abs(s.e - 0.1) < 0.02, `midway: ${JSON.stringify(s)}`)
  assert.equal(gearShift(tg, 20 + ROLL_TIME + POP_TIME + 0.05), null, 'after the change is over')
  assert.equal(gearShift({ ...tg, channels: {} } as Telemetry, 20.1), null, 'no gear data')
}
// ---- Outside temperature: even when the value alternates between two values 0.75℃ apart, the displayed digit does not go back and forth once it has changed ----
{
  const air = new Float32Array(n).map((_, i) => (i < 10 * rate ? 20.25 : i < 20 * rate ? (Math.floor(i / 50) % 2 ? 21.0 : 20.25) : 22.5))
  const ta = { rate, n, t0: 0, channels: { airTemp: air } } as unknown as Telemetry
  const shown = airTempShown(ta)!
  assert.equal(shown[5 * rate], 20)
  let changes = 0
  for (let i = 10 * rate + 1; i < 20 * rate; i++) if (shown[i] !== shown[i - 1]) changes++
  assert.ok(changes <= 1, `the digit does not oscillate even when the value alternates between 20.25 and 21.0: ${changes} changes`)
  assert.equal(shown[25 * rate], 23)
  const r = airShift(ta, 20.2)
  assert.ok(r && r.prev === 21, `at 22.5℃ it rolls from 21 to 23: ${JSON.stringify(r)}`)
}

// ---- Outside temperature color: light blue at 5℃ or below, yellow at 30℃ or above, orange at 35℃ or above, red at 40℃ or above, white otherwise ----
{
  const white = airTempColor(20)
  assert.equal(white, '#ffffff')
  assert.equal(airTempColor(5), airTempColor(-3), '5℃ or below is the same light blue')
  assert.notEqual(airTempColor(5), white)
  assert.equal(airTempColor(6), white)
  assert.equal(airTempColor(29), white)
  const y = airTempColor(30)
  const o = airTempColor(35)
  const r = airTempColor(40)
  assert.ok(new Set([white, airTempColor(5), y, o, r]).size === 5, 'all five colors differ')
  assert.equal(airTempColor(34), y)
  assert.equal(airTempColor(39), o)
  assert.equal(airTempColor(45), r)
  assert.equal(airTempColor(undefined), white)
  assert.equal(airTempColor(20, '#f6eedb'), '#f6eedb', 'the normal color is the theme text color')
}

// ---- Design themes: one per maker, with distinct ids, and every palette color in a form the grey-out can read ----
{
  assert.deepEqual(
    THEMES.map((x) => x.id),
    ['bmw', 'ducati', 'honda', 'kawasaki', 'ktm', 'suzuki', 'triumph', 'yamaha', 'wafu', 'ainu']
  )
  const color = /^(#[0-9a-f]{6}|rgba?\([^)]+\))$/i
  for (const x of THEMES) {
    for (const [k, v] of Object.entries(x.pal)) {
      const list = Array.isArray(v) ? v : v === null ? [] : [v]
      for (const c of list) assert.ok(color.test(c), `${x.id}.${k}: ${c}`)
    }
    assert.ok(x.look.glow >= 0 && x.look.glow <= 1, `${x.id}: glow`)
  }
  assert.equal(getTheme(undefined).id, 'bmw', 'BMW when the project has no theme')
  assert.equal(getTheme('nope').id, 'bmw')
}

// ---- Longitudinal G meter: scale default, and that it draws without a numeric readout for no data / acceleration / braking on a recording stub context ----
{
  assert.equal(DEFAULT_METER.gMax, 1)
  const em: MeterEmphasis = { rpm: 0, throttle: 0, brake: 0, lean: 0 }
  const draw = (accelG: number | undefined): string[] => {
    const texts: string[] = []
    const stub: unknown = new Proxy(function () {}, {
      get: (_t, k) => (k === 'fillText' ? (s: string) => texts.push(s) : () => stub),
      set: () => true,
      apply: () => stub
    })
    for (const T of THEMES) drawMeter(stub as CanvasRenderingContext2D, { x: 0, y: 0, w: 400, h: 400 }, { rpm: 5000, lean: 20, gear: 3, airTemp: 20, accelG }, DEFAULT_METER, null, em, T)
    return texts
  }
  // drawMeter runs with no data, acceleration and braking, and none of them draws a G readout (the meter shows it by the bar alone)
  for (const a of [undefined, 0.32, -0.85]) assert.ok(!draw(a).some((x) => / G$/.test(x) || x === '--'), `no G readout text for accelG ${a}`)
  const labels = draw(undefined)
  for (const l of ['THR', '%', 'BRK', 'bar']) assert.ok(labels.includes(l), `arc label ${l}`)
  assert.ok(!labels.some((x) => /^\d+%$/.test(x)), 'no numeric throttle readout')
  assert.ok(draw(undefined).includes('0.5') && draw(undefined).includes('ACC') && draw(undefined).includes('DEC'), 'track numbers and end labels without data')
}

// ---- A short 0 in the middle of a shift keeps the previous gear (no flicker as in 1 -> N -> 2). A long 0 from stopping and shifting into neutral is kept ----
{
  const { holdThroughShift } = await import('../src/renderer/src/core/telemetry')
  const g = new Float32Array([1, 1, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3])
  // rate 10Hz: a 0.2 s run of 0 is filled, a 1.0 s run of 0 is kept
  assert.deepEqual(Array.from(holdThroughShift(g, 10)), [1, 1, 1, 1, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3])
}

// Real data: sections where the engine is stopped (video time)
const [insvPath, csvPath] = process.argv.slice(2)
if (insvPath && csvPath) {
  const { InsvTrailer } = await import('../src/renderer/src/core/insv')
  const { estimateMount } = await import('../src/renderer/src/core/motion')
  const { cameraRollRate, fuseLean, parseMotoReco, syncLog } = await import('../src/renderer/src/core/motoreco')
  const { buildTelemetry } = await import('../src/renderer/src/core/telemetry')
  const fh = await open(insvPath, 'r')
  const reader = { size: (await fh.stat()).size, read: async (o: number, l: number) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b } }
  const tr = await InsvTrailer.open(reader)
  const imu = await tr.imu()
  const mount = estimateMount(imu).R
  const log = parseMotoReco(readFileSync(csvPath, 'utf-8'))
  const cam = cameraRollRate(imu, mount, tr.meta.firstFrameUs)
  const sync = syncLog(log, cam)
  const real = buildTelemetry(log, sync, fuseLean(log, cam, sync), tr.meta.frameCount / tr.meta.fps, 0)
  let start = -1
  const out: string[] = []
  const fmt = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
  for (let s = 0; s < real.n / real.rate; s += 0.1) {
    const off = enginePower(real, s) === 0
    if (off && start < 0) start = s
    if (!off && start >= 0) {
      out.push(`${fmt(start)}-${fmt(s)}`)
      start = -1
    }
  }
  if (start >= 0) out.push(`${fmt(start)}-end`)
  console.log('engine stopped:', out.join(' ') || 'none')
  const shifts: string[] = []
  for (let s = 0; s < real.n / real.rate && shifts.length < 6; s += 0.01) {
    const g = gearShift(real, s)
    if (g && g.e < 0.01) {
      shifts.push(`${fmt(s)} (${g.prev}->${real.channels.gear![Math.floor(s * real.rate)]})`)
      s += 1
    }
  }
  console.log('gear changes:', shifts.join(' '))
  const airs: string[] = []
  const shownAir = airTempShown(real)
  for (let i = 1; shownAir && i < shownAir.length && airs.length < 6; i++)
    if (shownAir[i] !== shownAir[i - 1] && Number.isFinite(shownAir[i - 1])) airs.push(`${fmt(i / real.rate)} (${shownAir[i - 1]}->${shownAir[i]}℃)`)
  console.log('outside temperature display changes:', airs.join(' ') || 'none')
  await fh.close()
}
console.log('meter.test: OK')
