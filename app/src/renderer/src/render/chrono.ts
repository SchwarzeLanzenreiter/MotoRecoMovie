// Chronograph-style meter (does not show speed).
//
//   Outermost, upper half: tachometer (9 o'clock -> 12 o'clock -> 3 o'clock, with a red zone)
//   Outermost, lower half: arcs extending outward from 6 o'clock. Right = throttle opening, left = brake pressure
//   Inner, upper half    : lean meter (straight up is 0°, a right lean goes to the right). The MAX hold resets at a switchback
//   Center               : current lean angle (large) and MAX
//   Inner, lower half    : sub-dials for gear and outside air temperature
// Matching the riding state: tachometer and throttle light up while accelerating, brake while decelerating, lean while cornering.
import type { Ctx, Values } from './meters'

const NUM = "Bahnschrift, 'Segoe UI', sans-serif"

export interface ChronoOpts {
  rpmMax: number
  rpmRed: number
  brakeMax: number // upper limit of the brake pressure scale [bar]
  leanMax: number // upper limit of the lean meter scale [deg]
  theme: MeterTheme
}

export const DEFAULT_CHRONO: ChronoOpts = { rpmMax: 9000, rpmRed: 8000, brakeMax: 20, leanMax: 60, theme: 'bmw' }

export interface ChronoEmphasis {
  rpm: number // accelerating
  throttle: number
  brake: number // decelerating
  lean: number // cornering
}

/** BMW's M colors (light blue, dark blue, red). No logo is drawn; only the color scheme is used */
export const M_COLORS = { light: '#5cb8ff', dark: '#1c69d4', red: '#e7222e' }

/** Color of the outside air temperature [deg C] text: light blue at 5 deg C or below, yellow at 30 or above, orange at 35 or above, red at 40 or above, otherwise white */
export function airTempColor(t: number | undefined): string {
  if (t === undefined || !Number.isFinite(t)) return '#ffffff'
  if (t >= 40) return '#ff3b30'
  if (t >= 35) return '#ff9500'
  if (t >= 30) return '#ffd60a'
  if (t <= 5) return '#7fd6ff'
  return '#ffffff'
}

export type MeterTheme = 'bmw' | 'standard'

interface Palette {
  face0: string
  face1: string
  tick: string
  tickDim: string
  track: string
  rpm: string
  red: string
  redZone: string
  throttle: string
  brake: string
  lean: string
  hold: string
  text: string
  sub: string
  /** Stripes placed below the dial (BMW theme only) */
  stripes: string[] | null
}

const PALETTES: Record<MeterTheme, Palette> = {
  bmw: {
    face0: '#1d2433',
    face1: '#06080c',
    tick: 'rgba(255,255,255,0.8)',
    tickDim: 'rgba(255,255,255,0.3)',
    track: 'rgba(92,184,255,0.10)',
    rpm: M_COLORS.light,
    red: M_COLORS.red,
    redZone: 'rgba(231,34,46,0.3)',
    throttle: M_COLORS.light,
    brake: M_COLORS.red,
    lean: '#3d8bff',
    hold: '#ffffff',
    text: '#ffffff',
    sub: 'rgba(200,220,255,0.6)',
    stripes: [M_COLORS.light, M_COLORS.dark, M_COLORS.red]
  },
  standard: {
    face0: '#20242c',
    face1: '#08090c',
    tick: 'rgba(255,255,255,0.75)',
    tickDim: 'rgba(255,255,255,0.3)',
    track: 'rgba(255,255,255,0.08)',
    rpm: '#f2f2f2',
    red: '#ff3b30',
    redZone: 'rgba(255,59,48,0.28)',
    throttle: '#3ddc84',
    brake: '#ff4b4b',
    lean: '#36b4ff',
    hold: '#ffb347',
    text: '#ffffff',
    sub: 'rgba(255,255,255,0.55)',
    stripes: null
  }
}

/** Color scheme used while drawing (switched at the start of drawChrono) */
let C: Palette = PALETTES.bmw

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))
const TAU = Math.PI * 2

function font(g: Ctx, px: number, weight = 700, italic = false): void {
  g.font = `${italic ? 'italic ' : ''}${weight} ${Math.max(1, px).toFixed(1)}px ${NUM}`
}

/** Draws an arc with a thick stroke (canvas angle: 0 = 3 o'clock, clockwise) */
function arc(g: Ctx, cx: number, cy: number, r: number, a0: number, a1: number, w: number, color: string, glow = 0): void {
  if (Math.abs(a1 - a0) < 1e-4) return
  g.save()
  g.strokeStyle = color
  g.lineWidth = w
  g.lineCap = 'butt'
  if (glow > 0.01) {
    g.shadowColor = color
    g.shadowBlur = w * 2.2 * glow
  }
  g.beginPath()
  g.arc(cx, cy, r, Math.min(a0, a1), Math.max(a0, a1))
  g.stroke()
  g.restore()
}

function tick(g: Ctx, cx: number, cy: number, r0: number, r1: number, a: number, w: number, color: string): void {
  g.strokeStyle = color
  g.lineWidth = w
  g.beginPath()
  g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
  g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
  g.stroke()
}

function label(g: Ctx, text: string, x: number, y: number, px: number, color: string, weight = 600, italic = false): void {
  font(g, px, weight, italic)
  g.fillStyle = color
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, x, y)
}

export function drawChrono(
  g: Ctx,
  rect: { x: number; y: number; w: number; h: number },
  v: Values,
  o: ChronoOpts,
  hold: number | null,
  em: ChronoEmphasis
): void {
  C = PALETTES[o.theme] ?? PALETTES.bmw
  const R = Math.min(rect.w, rect.h) / 2
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  g.save()

  // ---- Bezel and dial ----
  const bezel = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
  bezel.addColorStop(0, '#d9dde3')
  bezel.addColorStop(0.35, '#7d838d')
  bezel.addColorStop(0.6, '#e8ebef')
  bezel.addColorStop(1, '#5a5f68')
  g.beginPath()
  g.arc(cx, cy, R, 0, TAU)
  g.fillStyle = bezel
  g.fill()
  const face = g.createRadialGradient(cx, cy - R * 0.3, R * 0.1, cx, cy, R * 0.94)
  face.addColorStop(0, C.face0)
  face.addColorStop(1, C.face1)
  g.beginPath()
  g.arc(cx, cy, R * 0.93, 0, TAU)
  g.fillStyle = face
  g.fill()

  // ---- Outermost, upper half: tachometer ----
  const rO = R * 0.82 // radius of the outer arc
  const wO = R * 0.075
  const rpmAng = (rpm: number): number => Math.PI + clamp(rpm / o.rpmMax, 0, 1) * Math.PI
  arc(g, cx, cy, rO, Math.PI, TAU, wO, C.track)
  arc(g, cx, cy, rO, rpmAng(o.rpmRed), TAU, wO, C.redZone) // red zone
  const rpm = v.rpm
  if (rpm !== undefined) {
    const a = rpmAng(rpm)
    const lit = Math.min(a, rpmAng(o.rpmRed))
    arc(g, cx, cy, rO, Math.PI, lit, wO, C.rpm, em.rpm)
    if (a > rpmAng(o.rpmRed)) arc(g, cx, cy, rO, rpmAng(o.rpmRed), a, wO, C.red, Math.max(em.rpm, 0.6))
  }
  // Ticks (numbers every 1000rpm, minor ticks every 500rpm)
  for (let r = 0; r <= o.rpmMax + 1; r += 500) {
    const a = rpmAng(r)
    const major = r % 1000 === 0
    tick(g, cx, cy, rO - wO * 0.5 - R * (major ? 0.07 : 0.035), rO - wO * 0.5, a, R * (major ? 0.012 : 0.007), r >= o.rpmRed ? C.red : major ? C.tick : C.tickDim)
    if (major) label(g, String(r / 1000), cx + Math.cos(a) * R * 0.66, cy + Math.sin(a) * R * 0.66, R * 0.075, r >= o.rpmRed ? C.red : C.tick, 700)
  }
  label(g, 'x1000 rpm', cx, cy - R * 0.5, R * 0.045, C.sub, 600)

  // ---- Outermost, lower half: throttle opening (right) and brake pressure (left). Extend outward from 6 o'clock ----
  const bottom = Math.PI / 2
  const gap = 0.06 // gap at 3 o'clock and 9 o'clock [rad]
  const quarter = Math.PI / 2 - gap
  arc(g, cx, cy, rO, bottom - quarter, bottom, wO, C.track)
  arc(g, cx, cy, rO, bottom, bottom + quarter, wO, C.track)
  const thr = v.throttle
  if (thr !== undefined) arc(g, cx, cy, rO, bottom - clamp(thr / 100, 0, 1) * quarter, bottom, wO, C.throttle, Math.max(em.throttle, 0.15))
  const brk = Math.max(v.brakeFront ?? 0, v.brakeRear ?? 0)
  if (v.brakeFront !== undefined || v.brakeRear !== undefined) arc(g, cx, cy, rO, bottom, bottom + clamp(brk / o.brakeMax, 0, 1) * quarter, wO, C.brake, Math.max(em.brake, 0.15))
  for (let k = 0; k <= 4; k++) {
    tick(g, cx, cy, rO - wO * 0.5 - R * 0.035, rO - wO * 0.5, bottom - (k / 4) * quarter, R * 0.007, C.tickDim)
    tick(g, cx, cy, rO - wO * 0.5 - R * 0.035, rO - wO * 0.5, bottom + (k / 4) * quarter, R * 0.007, C.tickDim)
  }
  // Place the numbers inside the arc, around 45° diagonally below (a position that does not overlap the sub-dials)
  const vx = R * 0.47
  const vy = R * 0.47
  label(g, 'THROTTLE', cx + vx, cy + vy - R * 0.075, R * 0.042, C.throttle, 700)
  label(g, thr !== undefined ? `${Math.round(thr)}%` : '--', cx + vx, cy + vy, R * 0.08, C.text, 700, true)
  label(g, 'BRAKE', cx - vx, cy + vy - R * 0.075, R * 0.042, C.brake, 700)
  label(g, v.brakeFront !== undefined || v.brakeRear !== undefined ? `${brk.toFixed(1)}` : '--', cx - vx, cy + vy, R * 0.08, C.text, 700, true)
  label(g, 'bar', cx - vx, cy + vy + R * 0.06, R * 0.035, C.sub)

  // ---- Inner, upper half: lean meter ----
  const rI = R * 0.5
  const wI = R * 0.05
  const top = -Math.PI / 2
  const leanAng = (d: number): number => top + clamp(d / o.leanMax, -1, 1) * (Math.PI / 2)
  arc(g, cx, cy, rI, Math.PI, TAU, wI, C.track)
  for (let d = -o.leanMax; d <= o.leanMax + 0.1; d += 15) {
    const major = d % 30 === 0
    tick(g, cx, cy, rI + wI * 0.5, rI + wI * 0.5 + R * (major ? 0.05 : 0.025), leanAng(d), R * (major ? 0.01 : 0.006), major ? C.tick : C.tickDim)
    // Do not show the numbers at the ends (±leanMax); they overlap the L and R letters
    if (major && d !== 0 && Math.abs(d) < o.leanMax - 0.1) label(g, String(Math.abs(d)), cx + Math.cos(leanAng(d)) * R * 0.39, cy + Math.sin(leanAng(d)) * R * 0.39, R * 0.045, C.sub)
  }
  label(g, 'L', cx - rI, cy + R * 0.075, R * 0.05, C.sub, 700)
  label(g, 'R', cx + rI, cy + R * 0.075, R * 0.05, C.sub, 700)
  const lean = v.lean
  if (lean !== undefined) {
    arc(g, cx, cy, rI, Math.min(top, leanAng(lean)), Math.max(top, leanAng(lean)), wI, C.lean, Math.max(em.lean, 0.2))
    // Needle (from the outside of the ring to the inside)
    const a = leanAng(lean)
    g.save()
    g.shadowColor = C.lean
    g.shadowBlur = R * 0.04 * (0.4 + em.lean)
    tick(g, cx, cy, rI - wI * 1.6, rI + wI * 1.4, a, R * 0.018, '#ffffff')
    g.restore()
  }
  // MAX hold marker
  if (hold !== null && Math.abs(hold) > 1) {
    const a = leanAng(hold)
    const px = cx + Math.cos(a) * (rI + wI * 1.6)
    const py = cy + Math.sin(a) * (rI + wI * 1.6)
    g.save()
    g.translate(px, py)
    g.rotate(a + Math.PI / 2)
    g.fillStyle = C.hold
    g.beginPath()
    g.moveTo(0, R * 0.02)
    g.lineTo(-R * 0.03, -R * 0.035)
    g.lineTo(R * 0.03, -R * 0.035)
    g.closePath()
    g.fill()
    g.restore()
  }

  // ---- Center: current lean angle and MAX ----
  if (lean !== undefined) {
    g.save()
    g.shadowColor = C.lean
    g.shadowBlur = R * 0.06 * em.lean
    label(g, `${Math.abs(lean).toFixed(0)}°`, cx, cy - R * 0.13, R * 0.2, C.text, 700, true)
    g.restore()
    label(g, 'LEAN', cx, cy - R * 0.29, R * 0.042, C.sub)
    if (hold !== null && Math.abs(hold) > 1) label(g, `MAX ${Math.abs(hold).toFixed(0)}° ${hold > 0 ? 'R' : 'L'}`, cx, cy + R * 0.02, R * 0.055, C.hold, 700, true)
  }

  // ---- Inner, lower half: sub-dials for gear and outside air temperature ----
  const sub = (sx: number, title: string, text: string, color: string): void => {
    const sy = cy + R * 0.36
    const sr = R * 0.135
    g.beginPath()
    g.arc(sx, sy, sr, 0, TAU)
    g.fillStyle = 'rgba(255,255,255,0.05)'
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,0.35)'
    g.lineWidth = R * 0.008
    g.stroke()
    label(g, title, sx, sy - sr * 0.55, R * 0.038, C.sub)
    label(g, text, sx, sy + sr * 0.12, R * (text.length > 3 ? 0.075 : 0.12), color, 700, true)
  }
  const gear = v.gear
  sub(cx - R * 0.17, 'GEAR', gear === undefined ? '--' : gear <= 0 ? 'N' : String(Math.round(gear)), '#ffffff')
  const temp = v.airTemp
  // Outside air temperature [deg C]. The unit is omitted because it does not fit
  sub(cx + R * 0.17, 'TEMP', temp === undefined ? '--' : temp.toFixed(0), airTempColor(temp))

  // M color stripes (BMW theme)
  if (C.stripes) {
    const sw = R * 0.05
    const sh = R * 0.022
    C.stripes.forEach((col, k) => {
      g.fillStyle = col
      g.save()
      g.translate(cx + (k - 1) * sw * 1.15, cy + R * 0.58)
      g.transform(1, 0, -0.35, 1, 0, 0) // slant
      g.fillRect(-sw / 2, -sh / 2, sw, sh * 3)
      g.restore()
    })
  }
  // Center axis (for the chronograph look)
  g.beginPath()
  g.arc(cx, cy + R * 0.1, R * 0.018, 0, TAU)
  g.fillStyle = '#c9ced6'
  g.fill()
  g.restore()
}
