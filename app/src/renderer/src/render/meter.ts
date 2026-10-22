// Meter in the project's design theme (render/theme.ts). The layout is the same for every theme (does not show speed); the theme gives
// the face (the maker's motif), colors, type and how the tachometer and sub-dials are drawn.
//
//   Outermost, upper half: tachometer (lit blocks, a solid bar or a pointer, with a red zone)
//   Outermost, lower half: arcs extending outward from 6 o'clock. Right = throttle opening, left = brake pressure
//                          (labelled THR % and BRK bar below the G meter, without values)
//   Inner, upper half    : lean meter (straight up is 0°). The MAX hold resets at a switchback
//   Center               : current lean angle (large) and MAX
//   Inner, lower half    : longitudinal G meter (straight down is 0 G; acceleration to the right, braking to the left),
//                          (no numeric value), and gear and outside air temperature (sub-dials) inside it
// Matching the riding state, the tachometer and throttle glow more while accelerating, the brake while decelerating, the lean while cornering.
import { POP_TIME, ROLL_TIME, type Roll } from './overlay'
import type { Ctx, Values } from './meters'
import { airTempColor, arcStroke, clamp, drawStripes, greyPal, TAU, themeFont, toGrey, type Theme } from './theme'

export interface MeterOpts {
  rpmMax: number
  rpmRed: number
  brakeMax: number // upper limit of the brake pressure scale [bar]
  leanMax: number // upper limit of the lean meter scale [deg]
  gMax: number // upper limit of the longitudinal G meter scale [G]
}

export const DEFAULT_METER: MeterOpts = { rpmMax: 9000, rpmRed: 8000, brakeMax: 20, leanMax: 60, gMax: 1 }

/** How much each part is emphasized by the riding state (0 to 1) */
export interface MeterEmphasis {
  rpm: number // accelerating
  throttle: number
  brake: number // decelerating
  lean: number // cornering
}

/** Text size multiplier */
const TEXT_SCALE = 1.5
/** Amount of enlargement at the moment a digit is replaced (1 + this value, times) */
const POP_SCALE = 0.4

/**
 * power: how much the engine is running (1 = running, 0 = stopped). While stopped, the colors turn grey.
 * rolls: gear and outside air temperature digit changes (gearShift and airShift in overlay.ts), and the displayed outside air temperature
 * (integer after flicker suppression). When the number increases, the previous digit moves out upward and the new one comes in from below;
 * when it decreases, the reverse. The new digit looks slightly larger at the moment of replacement
 */
export function drawMeter(
  g: Ctx,
  rect: { x: number; y: number; w: number; h: number },
  v: Values,
  o: MeterOpts,
  hold: number | null,
  em: MeterEmphasis,
  T: Theme,
  power = 1,
  rolls: { gear: Roll | null; air: Roll | null; airShown: number | null } | null = null
): void {
  const L = T.look
  const P = power >= 1 ? T.pal : greyPal(T.pal, 1 - clamp(power, 0, 1))
  const R = Math.min(rect.w, rect.h) / 2
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  g.save()

  const glow = (col: string, amt: number): void => {
    if (L.glow <= 0) return
    g.shadowColor = col
    g.shadowBlur = Math.min(28, R * 0.05 * amt * L.glow)
  }
  const noGlow = (): void => {
    g.shadowBlur = 0
  }
  const text = (s: string, x: number, y: number, px0: number, col: string, weight = L.weight, spacing = 0.12): void => {
    const px = px0 * TEXT_SCALE
    g.font = themeFont(L, px, weight)
    ;(g as CanvasRenderingContext2D).letterSpacing = `${(px * spacing).toFixed(1)}px`
    g.fillStyle = col
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(s, x, y)
    ;(g as CanvasRenderingContext2D).letterSpacing = '0px'
  }
  const ring = (r: number, a0: number, a1: number, w: number, col: string): void => arcStroke(g, cx, cy, r, a0, a1, w, col)
  const tick = (r0: number, r1: number, a: number, w: number, col: string): void => {
    g.strokeStyle = col
    g.lineWidth = w
    g.beginPath()
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
    g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
    g.stroke()
  }
  /** Segmented arc. Split from `from` to `to` into n segments, lighting the first `lit` of them */
  const segArc = (r: number, from: number, to: number, n: number, lit: number, w: number, color: (frac: number) => string, amt: number): void => {
    const step = (to - from) / n
    const gap = Math.abs(step) * 0.22
    g.lineCap = 'butt'
    for (let s = 0; s < n; s++) {
      const a0 = from + s * step
      const a1 = a0 + step
      const on = s < lit
      const col = on ? color((s + 0.5) / n) : P.dim
      if (on && amt > 0.02) glow(col, amt)
      ring(r, Math.min(a0, a1) + gap / 2, Math.max(a0, a1) - gap / 2, w, col)
      noGlow()
    }
  }
  /** Solid arc from `from` toward `to`, lit over fraction f (track drawn dim) */
  const barArc = (r: number, from: number, to: number, f: number, w: number, color: (frac: number) => string, amt: number, splits: number[] = []): void => {
    g.lineCap = 'butt'
    ring(r, from, to, w, P.dim)
    if (f <= 0) return
    // Lit part in pieces of one color each (boundaries at `splits`, fractions of the arc)
    const cuts = [0, ...splits.filter((s) => s < f), f]
    for (let k = 0; k + 1 < cuts.length; k++) {
      const col = color((cuts[k] + cuts[k + 1]) / 2)
      glow(col, amt)
      ring(r, from + (to - from) * cuts[k], from + (to - from) * cuts[k + 1], w, col)
      noGlow()
    }
  }

  // ---- Face: the maker's motif ----
  T.face(g, cx, cy, R, P, L, 1 - clamp(power, 0, 1))

  // ---- Outermost, upper half: tachometer ----
  const rO = R * 0.81
  const wO = R * 0.085
  const red = clamp(o.rpmRed / o.rpmMax, 0, 1)
  const rpm = v.rpm
  const fR = rpm === undefined ? 0 : clamp(rpm / o.rpmMax, 0, 1)
  const overRed = rpm !== undefined && rpm >= o.rpmRed
  const rpmCol = (f: number): string => (f >= red ? P.hot : f > 0.6 ? P.line2 : P.line)
  const rpmGlow = overRed ? 1.6 : em.rpm * 1.4
  if (L.tach === 'blocks') segArc(rO, Math.PI, TAU, 45, fR * 45, wO, rpmCol, rpmGlow)
  else if (L.tach === 'bar') barArc(rO, Math.PI, TAU, fR, wO, rpmCol, rpmGlow, [0.6, red])
  else {
    // Pointer on a fine scale: a thin lit arc and a needle across it
    ring(rO, Math.PI, TAU, wO * 0.2, P.dim)
    ring(rO, Math.PI + red * Math.PI, TAU, wO * 0.55, P.hot)
    if (rpm !== undefined) {
      const a = Math.PI + fR * Math.PI
      ring(rO, Math.PI, a, wO * 0.2, P.line)
      g.save()
      g.translate(cx + Math.cos(a) * rO, cy + Math.sin(a) * rO)
      g.rotate(a)
      g.fillStyle = overRed ? P.hot : P.text
      g.beginPath()
      g.moveTo(wO * 0.9, 0)
      g.lineTo(-wO * 1.6, -R * 0.012)
      g.lineTo(-wO * 1.6, R * 0.012)
      g.closePath()
      g.fill()
      g.restore()
    }
  }
  // Thin red line inside the red zone
  const fine = L.tach === 'needle'
  if (!fine) ring(rO - wO * 0.75, Math.PI + red * Math.PI, TAU, R * 0.01, P.hot)
  for (let r = 0; r <= o.rpmMax + 1; r += 500) {
    const a = Math.PI + (r / o.rpmMax) * Math.PI
    const hot = r >= o.rpmRed
    const major = r % 1000 === 0
    if (!major && !fine) continue
    tick(rO - wO * 0.6, rO - wO * 0.6 - R * (major ? 0.05 : 0.025), a, R * (major ? 0.01 : 0.006), hot ? P.hot : P.line)
    if (major) text(String(r / 1000), cx + Math.cos(a) * R * 0.66, cy + Math.sin(a) * R * 0.66, R * 0.07, hot ? P.hot : P.text, 700, 0)
  }
  text('RPM x1000', cx, cy - R * 0.6, R * 0.034, P.sub, 600, 0.22)

  // ---- Outermost, lower half: throttle opening (right) and brake pressure (left). Extend outward from 6 o'clock ----
  const bottom = Math.PI / 2
  const quarter = Math.PI / 2 - 0.08
  const thr = v.throttle
  const brk = Math.max(v.brakeFront ?? 0, v.brakeRear ?? 0)
  const hasBrk = v.brakeFront !== undefined || v.brakeRear !== undefined
  const fT = thr === undefined ? 0 : clamp(thr / 100, 0, 1)
  const fB = hasBrk ? clamp(brk / o.brakeMax, 0, 1) : 0
  if (L.tach === 'blocks') {
    segArc(rO, bottom, bottom - quarter, 16, fT * 16, wO, () => P.thr, Math.max(em.throttle * 1.4, 0.3))
    segArc(rO, bottom, bottom + quarter, 16, fB * 16, wO, () => P.hot, Math.max(em.brake * 1.4, 0.3))
  } else {
    const w = fine ? wO * 0.45 : wO
    barArc(rO, bottom, bottom - quarter, fT, w, () => P.thr, Math.max(em.throttle * 1.4, 0.3))
    barArc(rO, bottom, bottom + quarter, fB, w, () => P.hot, Math.max(em.brake * 1.4, 0.3))
  }
  // Labels and units of the two arcs (no values), in the space between the G meter's numbers and the arcs
  const lx = R * 0.25
  const ly = R * 0.6
  text('THR', cx + lx, cy + ly, R * 0.04, P.sub, 600, 0.3)
  text('%', cx + lx, cy + ly + R * 0.055, R * 0.034, P.sub, 600, 0.2)
  text('BRK', cx - lx, cy + ly, R * 0.04, P.sub, 600, 0.3)
  text('bar', cx - lx, cy + ly + R * 0.055, R * 0.034, P.sub, 600, 0.2)

  // ---- Inner, upper half: lean meter ----
  const rI = R * 0.5
  const wI = R * 0.03
  /** Indicator: a triangle riding on the inner ring (pointing outward) */
  const pointer = (a: number, glowCol: string): void => {
    g.save()
    g.translate(cx + Math.cos(a) * rI, cy + Math.sin(a) * rI)
    g.rotate(a + Math.PI / 2)
    glow(glowCol, 1.2)
    g.fillStyle = P.text
    g.beginPath()
    g.moveTo(0, -R * 0.075)
    g.lineTo(-R * 0.035, R * 0.01)
    g.lineTo(R * 0.035, R * 0.01)
    g.closePath()
    g.fill()
    noGlow()
    g.restore()
  }
  const top = -Math.PI / 2
  const leanAng = (d: number): number => top + clamp(d / o.leanMax, -1, 1) * (Math.PI / 2)
  ring(rI, Math.PI, TAU, wI, P.dim)
  for (let d = -o.leanMax; d <= o.leanMax + 0.1; d += 5) {
    const major = d % 30 === 0
    const mid = d % 15 === 0
    tick(rI + wI, rI + wI + R * (major ? 0.055 : mid ? 0.035 : 0.018), leanAng(d), R * (major ? 0.01 : 0.005), major ? P.line : P.sub)
    // Do not show the numbers at the ends (±leanMax); they overlap the L and R letters
    if (major && d !== 0 && Math.abs(d) < o.leanMax - 0.1) text(String(Math.abs(d)), cx + Math.cos(leanAng(d)) * R * 0.4, cy + Math.sin(leanAng(d)) * R * 0.4, R * 0.042, P.sub, 600, 0)
  }
  text('L', cx - rI, cy + R * 0.075, R * 0.05, P.sub, 700, 0)
  text('R', cx + rI, cy + R * 0.075, R * 0.05, P.sub, 700, 0)
  const lean = v.lean
  if (lean !== undefined) {
    const a = leanAng(lean)
    glow(P.lean, 1 + em.lean * 2)
    ring(rI, top, a, wI * 2.2, P.lean)
    noGlow()
    pointer(a, P.lean)
  }
  // MAX hold marker (chevron)
  if (hold !== null && Math.abs(hold) > 1) {
    const a = leanAng(hold)
    g.save()
    g.translate(cx + Math.cos(a) * (rI + R * 0.085), cy + Math.sin(a) * (rI + R * 0.085))
    g.rotate(a + Math.PI / 2)
    g.strokeStyle = P.hot
    g.lineWidth = R * 0.012
    glow(P.hot, 0.8)
    g.beginPath()
    g.moveTo(-R * 0.03, -R * 0.02)
    g.lineTo(0, R * 0.015)
    g.lineTo(R * 0.03, -R * 0.02)
    g.stroke()
    noGlow()
    g.restore()
  }

  // ---- Center: current lean angle and MAX ----
  if (lean !== undefined) {
    text('LEAN', cx, cy - R * 0.315, R * 0.04, P.sub, 600, 0.35)
    // A soft dark shadow keeps the large digits readable over light parts of the face
    g.save()
    g.shadowColor = 'rgba(0,0,0,0.6)'
    g.shadowBlur = R * 0.04
    text(`${Math.abs(lean).toFixed(0)}°`, cx, cy - R * 0.13, R * 0.2, P.text, 700, 0)
    g.restore()
    if (L.glow > 0) {
      glow(P.lean, 0.8 + em.lean * 1.6)
      text(`${Math.abs(lean).toFixed(0)}°`, cx, cy - R * 0.13, R * 0.2, P.text, 700, 0)
      noGlow()
    }
    if (hold !== null && Math.abs(hold) > 1) text(`MAX ${Math.abs(hold).toFixed(0)}° ${hold > 0 ? 'R' : 'L'}`, cx, cy + R * 0.02, R * 0.05, P.hot, 700, 0.12)
  }

  // ---- Inner, lower half: longitudinal G meter. Mirrors the lean meter; 0 G at 6 o'clock, acceleration to the right and braking to the left
  // like the throttle and brake arcs. The ends stop short of the horizontal so that they stay clear of the L and R letters ----
  const GSPAN = Math.PI / 2 - 0.35
  const gAng = (x: number): number => bottom - clamp(x / o.gMax, -1, 1) * GSPAN
  ring(rI, bottom - GSPAN, bottom + GSPAN, wI, P.dim)
  for (let k = -Math.round(o.gMax * 10); k <= Math.round(o.gMax * 10); k++) {
    const x = k / 10
    const major = k % 5 === 0
    tick(rI + wI, rI + wI + R * (major ? 0.055 : 0.018), gAng(x), R * (major ? 0.01 : 0.005), major ? P.line : P.sub)
    // The numbers go outside the ring (the sub-dials are inside); none at 0 and at the ends
    if (major && k !== 0 && Math.abs(x) < o.gMax - 0.01) text(Math.abs(x).toFixed(1), cx + Math.cos(gAng(x)) * R * 0.64, cy + Math.sin(gAng(x)) * R * 0.64, R * 0.042, P.sub, 600, 0)
  }
  // End labels on the end angles, outside the end ticks (next to the ring they run into the L and R letters, inside into the sub-dials)
  text('ACC', cx + Math.cos(gAng(o.gMax)) * R * 0.68, cy + Math.sin(gAng(o.gMax)) * R * 0.68, R * 0.034, P.sub, 700, 0.1)
  text('DEC', cx + Math.cos(gAng(-o.gMax)) * R * 0.68, cy + Math.sin(gAng(-o.gMax)) * R * 0.68, R * 0.034, P.sub, 700, 0.1)
  const accG = v.accelG
  if (accG !== undefined) {
    const a = gAng(accG)
    const col = accG >= 0 ? P.thr : P.hot
    glow(col, 1 + (accG >= 0 ? em.throttle : em.brake) * 2)
    ring(rI, bottom, a, wI * 2.2, col)
    noGlow()
    pointer(a, col)
  }

  // ---- Inner, lower half: gear and outside air temperature ----
  const sub = (sx: number, title: string, val: string, col: string, amt: number, roll: { prev: string; e: number; dir: number; col?: string } | null = null): void => {
    const sy = cy + R * 0.25
    const sr = R * 0.14
    const path = (r: number): void => {
      g.beginPath()
      switch (L.sub) {
        case 'hex':
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i
            if (i) g.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r)
            else g.moveTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r)
          }
          g.closePath()
          break
        case 'circle':
          g.arc(sx, sy, r * 0.97, 0, TAU)
          break
        case 'round':
          g.roundRect(sx - r * 0.9, sy - r * 0.85, r * 1.8, r * 1.7, r * 0.35)
          break
        case 'slant': {
          const s = r * 0.3
          g.moveTo(sx - r * 0.9 + s, sy - r * 0.8)
          g.lineTo(sx + r * 0.9 + s, sy - r * 0.8)
          g.lineTo(sx + r * 0.9 - s, sy + r * 0.8)
          g.lineTo(sx - r * 0.9 - s, sy + r * 0.8)
          g.closePath()
          break
        }
      }
    }
    path(sr)
    g.fillStyle = 'rgba(0,0,0,0.35)'
    g.fill()
    g.strokeStyle = P.line
    g.lineWidth = R * 0.008
    glow(P.line, 0.5 + amt)
    g.stroke()
    noGlow()
    text(title, sx, sy - sr * 0.55, R * 0.034, P.sub, 600, 0.3)
    glow(col, 0.4 + amt)
    const big = (s: string, y = 0, scale = 1, c = col): void => {
      const px = R * (s.length > 3 ? 0.07 : 0.11)
      if (scale === 1) return text(s, sx, sy + sr * 0.15 + y, px, c, 700, 0)
      // When enlarging, scale about the center of the text
      g.save()
      g.translate(sx, sy + sr * 0.15 + y)
      g.scale(scale, scale)
      text(s, 0, 0, px, c, 700, 0)
      g.restore()
    }
    if (roll && roll.prev !== val) {
      if (roll.e < ROLL_TIME) {
        // Scroll vertically and swap (drawn only inside the frame). The new digit grows while coming in
        const k0 = roll.e / ROLL_TIME
        const k = k0 * k0 * (3 - 2 * k0)
        const d = sr * 1.5 // scroll distance (slightly longer than the frame height, so it fully exits)
        g.save()
        path(sr * 0.93)
        g.clip()
        big(roll.prev, -roll.dir * d * k, 1, roll.col ?? col)
        big(val, roll.dir * d * (1 - k), 1 + POP_SCALE * k)
        g.restore()
      } else {
        // Large at the moment of replacement, returning to normal size over POP_TIME seconds (may stick out of the frame a little)
        const p = Math.min(1, (roll.e - ROLL_TIME) / POP_TIME)
        big(val, 0, 1 + POP_SCALE * (1 - p) * (1 - p))
      }
    } else big(val)
    noGlow()
  }
  const gearText = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? '--' : x <= 0 ? 'N' : String(Math.round(x)))
  const gear = v.gear
  // When the number increases (upshift, temperature rise) the previous digit moves out upward and the new one comes in from below; when it decreases, the reverse
  const gr = rolls?.gear
  sub(cx - R * 0.17, 'GEAR', gearText(gear), P.text, em.rpm, gr && gear !== undefined ? { prev: gearText(gr.prev), e: gr.e, dir: gear >= gr.prev ? 1 : -1 } : null)
  // Outside air temperature: the integer after flicker suppression (otherwise the measured value rounded)
  const temp = rolls?.airShown ?? (v.airTemp === undefined ? undefined : Math.round(v.airTemp))
  // The unit (deg C) is omitted because it does not fit in the sub-dial
  const tempText = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? '--' : x.toFixed(0))
  // Color changes with temperature (light blue at 5 deg C or below, yellow at 30 or above, orange at 35, red at 40, otherwise the text color). Grey while the engine is stopped
  const tCol = (x: number | undefined): string => (power >= 1 ? airTempColor(x, T.pal.text) : toGrey(airTempColor(x, T.pal.text), 1 - clamp(power, 0, 1)))
  const ar = rolls?.air
  sub(cx + R * 0.17, 'AIR', tempText(temp), tCol(temp), 0, ar && temp !== undefined ? { prev: tempText(ar.prev), e: ar.e, dir: temp >= ar.prev ? 1 : -1, col: tCol(ar.prev) } : null)

  // The maker's stripes
  if (P.stripes) {
    const sw = R * 0.06
    drawStripes(g, P.stripes, cx - (P.stripes.length * sw * 1.15 - sw * 0.15) / 2, cy + R * 0.6, sw, R * 0.014, L.italic)
  }
  g.restore()
}
