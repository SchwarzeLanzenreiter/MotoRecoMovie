// Draws overlays (telemetry etc.) with Canvas 2D. Widgets are registered per kind.
import { CHANNELS, sampleAll, sampleChannel, type ChannelKey, type Telemetry } from '../core/telemetry'
import { STATES, weightsAt } from '../core/riding'
import type { OverlayLayer, Rect, WidgetKind } from '../engine/project'
import type { PixelRect } from './gl-reframe'
import { drawCompass, drawElevation, drawMap } from './gps'
import { DEFAULT_METER, drawMeter, type MeterOpts } from './meter'
import { getLang, tr, type Lang } from '../i18n'
import type { Caption } from '../core/annotations'
import { drawCaptions } from './annotations'
import type { Theme } from './theme'
import { getTheme } from './themes'

export interface OverlayFrame {
  t: number // video time [s]
  /** Captions of the project (set by the compositor; for the captions layer) */
  captions?: Caption[]
  /** The project's design theme */
  theme: Theme
  telemetry: Telemetry | null
  values: Partial<Record<ChannelKey, number>> // telemetry at that time (already computed)
  /** Weights of the riding states (in STATES order). Cruise only if there is no log */
  weights: number[]
  /** Maximum lean angle so far during the corner (null outside corners) */
  peakLean: number | null
  /** MAX hold of the lean angle (reset at a switchback) */
  leanHold: number | null
  outW: number
  outH: number
  /** Language of the text that goes into the video (project.export.textLang; the UI language if omitted) */
  lang: Lang
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
type Widget = (g: Ctx, r: PixelRect, f: OverlayFrame, props: Record<string, unknown>) => void

export const FONT = "'Yu Gothic UI', 'Meiryo UI', 'Segoe UI', sans-serif"

function roundRect(g: Ctx, r: PixelRect, rad: number): void {
  g.beginPath()
  g.roundRect(r.x, r.y, r.w, r.h, rad)
}

/** List of values (for checking the overlay path; the real meters will be added later) */
const readout: Widget = (g, r, f) => {
  roundRect(g, r, r.h * 0.05)
  g.fillStyle = 'rgba(10, 12, 16, 0.55)'
  g.fill()
  const keys: ChannelKey[] = ['speed', 'rpm', 'gear', 'lean', 'accelG', 'airTemp', 'alt', 'heading']
  const rows = f.telemetry ? keys.filter((k) => f.values[k] !== undefined) : []
  const pad = r.h * 0.06
  if (rows.length === 0) {
    g.fillStyle = '#ddd'
    g.font = `${Math.round(r.h * 0.1)}px ${FONT}`
    g.textBaseline = 'middle'
    g.fillText(tr(f.lang, 'No vehicle log'), r.x + pad, r.y + r.h / 2)
    return
  }
  const lh = (r.h - pad * 2) / rows.length
  g.textBaseline = 'middle'
  rows.forEach((k, i) => {
    const y = r.y + pad + lh * (i + 0.5)
    const v = f.values[k]!
    const info = CHANNELS[k]
    const txt =
      k === 'gear' ? (v === 0 ? 'N' : String(Math.round(v))) : k === 'accelG' ? (v >= 0 ? '+' : '') + v.toFixed(2) : k === 'lean' ? v.toFixed(1) : String(Math.round(v))
    g.font = `${Math.round(lh * 0.55)}px ${FONT}`
    g.fillStyle = '#9aa1ae'
    g.fillText(tr(f.lang, info.label), r.x + pad, y)
    g.textAlign = 'right'
    g.fillStyle = '#ffffff'
    g.font = `bold ${Math.round(lh * 0.62)}px ${FONT}`
    g.fillText(`${txt} ${info.unit}`, r.x + r.w - pad, y)
    g.textAlign = 'left'
  })
}

/** Index into the riding-state weights (in STATES order) */
const W = Object.fromEntries(STATES.map((s, i) => [s, i])) as Record<(typeof STATES)[number], number>

function noLog(g: Ctx, r: PixelRect, lang: Lang): void {
  g.fillStyle = 'rgba(10, 12, 16, 0.55)'
  g.fillRect(r.x, r.y, r.w, r.h)
  g.fillStyle = '#ddd'
  g.font = `${Math.round(Math.min(r.h * 0.25, r.w * 0.08))}px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(tr(lang, 'No vehicle log'), r.x + r.w / 2, r.y + r.h / 2)
  g.textAlign = 'left'
}

/** RPM treated as engine stopped [rpm], and the time over which the color switches at start and stop [s] */
const ENGINE_ON_RPM = 300
const ENGINE_FADE = 0.5

/**
 * How much the engine is running (the fraction of the last ENGINE_FADE seconds in which the RPM exceeded ENGINE_ON_RPM).
 * 1 if there is no RPM data (no effect)
 */
export function enginePower(tel: Telemetry | null, t: number): number {
  if (!tel?.channels.rpm) return 1
  const N = 6
  let on = 0
  for (let k = 0; k < N; k++) {
    const r = sampleChannel(tel, 'rpm', t - (ENGINE_FADE * k) / (N - 1))
    if (r === null || r > ENGINE_ON_RPM) on++
  }
  return on / N
}

/**
 * Motion when a digit changes: it scrolls vertically over ROLL seconds and swaps (the new digit grows a little while coming in),
 * then returns to its normal size over POP seconds from the moment it is replaced
 */
export const ROLL_TIME = 0.3
export const POP_TIME = 0.35

/** Midway through a change: the previous value and the time since the change [s] (0 to ROLL_TIME + POP_TIME) */
export interface Roll {
  prev: number
  e: number
}

/**
 * For a 100Hz value series `series`, if the value changed within the ROLL_TIME + POP_TIME seconds just before time t, the previous value and the elapsed time.
 * null if it did not change. Derived from the telemetry rather than from the previous frame's state, so that export gives the same result
 */
function lastChange(series: ArrayLike<number>, tel: Telemetry, t: number): Roll | null {
  const i = Math.min(series.length - 1, Math.floor((t - tel.t0) * tel.rate))
  if (i < 1) return null
  const back = Math.ceil((ROLL_TIME + POP_TIME) * tel.rate)
  for (let j = i; j > Math.max(0, i - back); j--) {
    const a = series[j - 1]
    const b = series[j]
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      const e = t - (tel.t0 + j / tel.rate)
      return e >= 0 && e < ROLL_TIME + POP_TIME ? { prev: a, e } : null
    }
  }
  return null
}

/** Gear change (null if none) */
export function gearShift(tel: Telemetry | null, t: number): Roll | null {
  const gear = tel?.channels.gear
  return tel && gear ? lastChange(gear, tel, t) : null
}

/**
 * Series of displayed outside air temperatures (integer [deg C]). The outside air temperature moves in 0.75 deg C steps and flips between two values near the display boundary (x.5 deg C),
 * so it changes only when it is AIR_HYST deg C or more away from the displayed integer (even when oscillating between two values 0.75 deg C apart, the digits do not keep scrolling after the first change)
 */
const AIR_HYST = 0.8
const shownAir = new WeakMap<Telemetry, Float32Array | null>()
export function airTempShown(tel: Telemetry): Float32Array | null {
  if (shownAir.has(tel)) return shownAir.get(tel)!
  const a = tel.channels.airTemp
  let out: Float32Array | null = null
  if (a) {
    out = new Float32Array(a.length).fill(NaN)
    let cur = NaN
    for (let i = 0; i < a.length; i++) {
      const v = a[i]
      if (!Number.isFinite(v)) {
        out[i] = cur
        continue
      }
      if (!Number.isFinite(cur) || Math.abs(v - cur) >= AIR_HYST) cur = Math.round(v)
      out[i] = cur
    }
  }
  shownAir.set(tel, out)
  return out
}

/** Outside air temperature display change (null if none) */
export function airShift(tel: Telemetry | null, t: number): Roll | null {
  const s = tel ? airTempShown(tel) : null
  return tel && s ? lastChange(s, tel, t) : null
}

/** Outside air temperature shown at time t (integer after flicker suppression). null if none */
function sampleShown(tel: Telemetry, t: number): number | null {
  const s = airTempShown(tel)
  if (!s) return null
  const v = s[Math.max(0, Math.min(s.length - 1, Math.floor((t - tel.t0) * tel.rate)))]
  return Number.isFinite(v) ? v : null
}

/** Time constant of the tachometer's lag behind the RPM, like the needle of an analog gauge [s] */
const TACH_LAG = 0.08

/** RPM shown by the tachometer: the RPM before t averaged with weights falling off by TACH_LAG (null without RPM) */
export function laggedRpm(tel: Telemetry, t: number): number | null {
  if (!tel.channels.rpm) return null
  let sum = 0
  let wsum = 0
  for (let k = 0; k < 8; k++) {
    const dt = (k / 8) * TACH_LAG * 3
    const v = sampleChannel(tel, 'rpm', t - dt)
    if (v === null) continue
    const w = Math.exp(-dt / TACH_LAG)
    sum += v * w
    wsum += w
  }
  return wsum > 0 ? sum / wsum : null
}

const meter: Widget = (g, r, f, props) => {
  if (!f.telemetry) return noLog(g, r, f.lang)
  const w = f.weights
  const rpm = laggedRpm(f.telemetry, f.t)
  drawMeter(
    g,
    r,
    rpm === null ? f.values : { ...f.values, rpm },
    { ...DEFAULT_METER, ...(props as Partial<MeterOpts>) },
    f.leanHold,
    {
      rpm: w[W.accel],
      throttle: w[W.accel],
      brake: w[W.brake],
      lean: w[W.corner]
    },
    f.theme,
    // Gray while the engine is stopped (from the vehicle log RPM; normal color if there is no RPM)
    enginePower(f.telemetry, f.t),
    // Gear and outside air temperature digit changes (scroll vertically and swap, then grow slightly at the moment of replacement)
    {
      gear: gearShift(f.telemetry, f.t),
      air: airShift(f.telemetry, f.t),
      airShown: sampleShown(f.telemetry, f.t)
    }
  )
}

const WIDGETS: Record<WidgetKind, Widget> = {
  meter,
  map: (g, r, f, props) => drawMap(g, r, f.telemetry, f.t, props, f.theme, f.lang),
  elevation: (g, r, f, props) => drawElevation(g, r, f.telemetry, f.t, props, f.theme, f.lang),
  compass: (g, r, f, props) => drawCompass(g, r, f.telemetry, f.t, props, f.theme, f.lang),
  readout,
  captions: (g, r, f) => {
    if (f.captions) drawCaptions(g, f.captions, f.t, r, f.theme)
  }
}

export const WIDGET_NAMES: Record<WidgetKind, string> = {
  meter: 'Gauges', // i18n-ignore
  map: 'Map', // i18n-ignore
  elevation: 'Elevation profile', // i18n-ignore
  compass: 'Compass tape', // i18n-ignore
  readout: 'Readout', // i18n-ignore
  captions: 'Captions' // i18n-ignore
}

/** Settings per overlay (edited in the side panel) */
export type PropDef =
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; default: string }
  | { key: string; label: string; type: 'number'; min: number; max: number; step: number; unit?: string; default: number }

const RPM_PROPS: PropDef[] = [
  { key: 'rpmMax', label: 'Tachometer max', type: 'number', min: 4000, max: 16000, step: 500, unit: 'rpm', default: 9000 }, // i18n-ignore
  { key: 'rpmRed', label: 'Redline', type: 'number', min: 3000, max: 16000, step: 250, unit: 'rpm', default: 8000 } // i18n-ignore
]

export const WIDGET_PROPS: Partial<Record<WidgetKind, PropDef[]>> = {
  meter: [
    ...RPM_PROPS,
    { key: 'brakeMax', label: 'Brake pressure max', type: 'number', min: 5, max: 60, step: 1, unit: 'bar', default: DEFAULT_METER.brakeMax }, // i18n-ignore
    { key: 'leanMax', label: 'Lean scale', type: 'number', min: 30, max: 70, step: 5, unit: '°', default: DEFAULT_METER.leanMax }, // i18n-ignore
    { key: 'gMax', label: 'Longitudinal G scale', type: 'number', min: 0.3, max: 2, step: 0.1, unit: 'G', default: DEFAULT_METER.gMax } // i18n-ignore
  ],
  map: [
    {
      key: 'mode',
      label: 'Display', // i18n-ignore
      type: 'select',
      options: [
        { value: 'local', label: 'Nearby (heading up)' }, // i18n-ignore
        { value: 'route', label: 'Whole route (north up)' } // i18n-ignore
      ],
      default: 'local'
    },
    { key: 'rangeM', label: 'Range (nearby)', type: 'number', min: 100, max: 5000, step: 100, unit: 'm', default: 600 }, // i18n-ignore
    {
      key: 'shape',
      label: 'Shape', // i18n-ignore
      type: 'select',
      options: [
        { value: 'circle', label: 'Circle' }, // i18n-ignore
        { value: 'rect', label: 'Rounded rectangle' } // i18n-ignore
      ],
      default: 'circle'
    }
  ],
  elevation: [{ key: 'windowKm', label: 'Width shown (0 = whole route)', type: 'number', min: 0, max: 50, step: 1, unit: 'km', default: 0 }], // i18n-ignore
  compass: [{ key: 'spanDeg', label: 'Visible angle span', type: 'number', min: 45, max: 360, step: 15, unit: '°', default: 120 }], // i18n-ignore

}

/** Initial position when added (adapted to the output aspect ratio aspect = width/height) */
export function defaultWidgetRect(w: WidgetKind, aspect: number): Rect {
  const tall = aspect < 1
  const box = (cx: number, cy: number, ww: number, hh: number): Rect => {
    // ww, hh are sizes relative to the "short side of the output"
    const sw = tall ? ww : ww / aspect
    const sh = tall ? hh * aspect : hh
    return { x: cx - sw / 2, y: cy - sh / 2, w: sw, h: sh }
  }
  switch (w) {
    case 'meter':
      return box(tall ? 0.5 : 0.84, tall ? 0.78 : 0.72, 0.42, 0.42)
    case 'map':
      return box(0.88, 0.2, 0.3, 0.3)
    case 'elevation':
      return box(0.16, 0.11, 0.42, 0.17)
    case 'compass':
      return box(0.5, 0.06, 0.5, 0.09)
    case 'captions':
      return tall ? { x: 0.05, y: 0.72, w: 0.9, h: 0.11 } : { x: 0.15, y: 0.75, w: 0.7, h: 0.2 }
    default:
      return box(0.14, 0.78, 0.26, 0.36)
  }
}

export function overlayFrame(t: number, telemetry: Telemetry | null, outW: number, outH: number, lang: Lang = getLang(), theme: Theme = getTheme(undefined)): OverlayFrame {
  const r = telemetry?.riding
  let peakLean: number | null = null
  let leanHold: number | null = null
  if (r) {
    const i = Math.max(0, Math.min(r.peakLean.length - 1, Math.round(t * r.rate)))
    peakLean = r.peakLean[i] !== 0 ? r.peakLean[i] : null
    leanHold = r.leanHold ? r.leanHold[i] : null
  }
  return {
    t,
    telemetry,
    values: telemetry ? sampleAll(telemetry, t) : {},
    weights: r ? weightsAt(r, t) : STATES.map((s) => (s === 'cruise' ? 1 : 0)),
    peakLean,
    leanHold,
    outW,
    outH,
    lang,
    theme
  }
}

export function drawOverlayLayer(g: Ctx, layer: OverlayLayer, r: PixelRect, f: OverlayFrame): void {
  const w = WIDGETS[layer.widget]
  if (!w) return
  g.save()
  g.beginPath()
  g.rect(r.x, r.y, r.w, r.h)
  g.clip()
  w(g, r, f, layer.props)
  g.restore()
}
