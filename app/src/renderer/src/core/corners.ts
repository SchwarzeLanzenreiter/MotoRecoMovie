// Detection of upcoming corners and estimation of curve radius (the content and position of floating signs in the air).
//
// Corner = a cornering section of the riding state (lean angle > 15°). The curve radius is
//   R = speed ÷ angular rate of turning about the vertical axis (gyro)
// taken as the median over the part where the turn is strongest (80% or more of the maximum).
// For validation it also keeps an estimate from the curvature of the GPS track and an estimate from R = v² / (g·tan L) (compared in test/corners.test.ts).
import type { NavTrack } from './nav'
import type { RidingTrack } from './riding'
import type { Telemetry } from './telemetry'

export interface Corner {
  /** Entry time [s] (start of the cornering section) */
  start: number
  end: number
  /** Time [s] of the strongest turn */
  apex: number
  /** Right = +1, left = -1 */
  dir: 1 | -1
  /** Curve radius [m] (rounded to 5 m) */
  radius: number
  /** For validation: from the GPS track curvature / from the lean angle (before rounding) */
  radiusGps: number
  radiusLean: number
  /**
   * Riding path around the entry point (every PATH_STEP m). s = distance along the path from the entry point [m] (negative before it).
   * Used to decide where to place the sign (signPlace)
   */
  path: { s: number[]; x: number[]; y: number[]; alt: number[]; heading: number[]; t: number[] }
  /** Entry point (fused position, m). Used to display the remaining distance */
  ex: number
  ey: number
}

const G = 9.80665

/** Range over which the path is kept (before and after the entry point [m]) and the spacing */
export const PATH_BEFORE = 120
export const PATH_AFTER = 60
const PATH_STEP = 2

/** Sign placement point: ahead m along the path from the entry point (before it if negative). The end if outside the path */
export function signPlace(c: Corner, ahead: number): { x: number; y: number; alt: number; heading: number; t: number } | null {
  const p = c.path
  const n = p.s.length
  if (!n) return null
  if (n === 1) return { x: p.x[0], y: p.y[0], alt: p.alt[0], heading: p.heading[0], t: p.t[0] }
  let k = 0
  while (k < n - 2 && p.s[k + 1] < ahead) k++
  const f = Math.max(0, Math.min(1, (ahead - p.s[k]) / (p.s[k + 1] - p.s[k] || 1)))
  const lerp = (a: number[]): number => a[k] + (a[k + 1] - a[k]) * f
  const dh = ((((p.heading[k + 1] - p.heading[k]) % 360) + 540) % 360) - 180
  return { x: lerp(p.x), y: lerp(p.y), alt: lerp(p.alt), heading: p.heading[k] + dh * f, t: lerp(p.t) }
}

function median(a: number[]): number {
  if (!a.length) return NaN
  const s = [...a].sort((p, q) => p - q)
  return s[s.length >> 1]
}

export function detectCorners(tel: Telemetry, nav: NavTrack, riding: RidingTrack, minRadius = 10, maxRadius = 600): Corner[] {
  const ch = tel.channels
  const rate = tel.rate
  const out: Corner[] = []
  if (!ch.speed) return out
  // Distance along the riding path [m] (integral of the front wheel speed). Used to place signs before and after the entry point
  const along = new Float64Array(tel.n)
  for (let i = 1; i < tel.n; i++) along[i] = along[i - 1] + (Number.isNaN(ch.speed[i]) ? 0 : ch.speed[i] / 3.6 / rate)
  const d2r = Math.PI / 180
  for (const sg of riding.segments) {
    if (sg.state !== 'corner') continue
    const a = Math.max(1, Math.round(sg.start * rate))
    const b = Math.min(tel.n - 2, Math.round(sg.end * rate))
    if (b - a < rate * 0.8) continue
    // Maximum turn angular rate, and the section at 80% or more of it
    let wMax = 0
    let iMax = a
    for (let i = a; i <= b; i++) {
      const w = Math.abs(nav.turnRate[i])
      if (w > wMax) {
        wMax = w
        iMax = i
      }
    }
    if (wMax < 2) continue
    const rW: number[] = []
    const rL: number[] = []
    const rG: number[] = []
    let dirSum = 0
    for (let i = a; i <= b; i++) {
      const w = nav.turnRate[i]
      dirSum += w
      if (Math.abs(w) < 0.8 * wMax) continue
      const v = ch.speed[i] / 3.6
      if (!(v > 3)) continue
      rW.push(v / (Math.abs(w) * d2r))
      const L = ch.lean ? Math.abs(ch.lean[i]) : 0
      if (L > 3) rL.push((v * v) / (G * Math.tan(L * d2r)))
      // Curvature of the GPS track: from the rate of change of heading (GPS)
      const h0 = ch.heading?.[i - 1]
      const h1 = ch.heading?.[i + 1]
      if (h0 !== undefined && h1 !== undefined && !Number.isNaN(h0) && !Number.isNaN(h1)) {
        const dh = Math.abs(((((h1 - h0) % 360) + 540) % 360) - 180) * (rate / 2)
        if (dh > 1) rG.push(v / (dh * d2r))
      }
    }
    const R = median(rW)
    if (!(R >= minRadius && R <= maxRadius)) continue
    // Path around the entry point (every PATH_STEP m)
    let k0 = a
    while (k0 > 0 && along[a] - along[k0] < PATH_BEFORE) k0--
    const path: Corner['path'] = { s: [], x: [], y: [], alt: [], heading: [], t: [] }
    let next = -Infinity
    for (let k = k0; k < tel.n && along[k] - along[a] <= PATH_AFTER; k++) {
      const s = along[k] - along[a]
      if (s < next) continue
      next = s + PATH_STEP
      path.s.push(s)
      path.x.push(nav.x[k])
      path.y.push(nav.y[k])
      path.alt.push(ch.alt && !Number.isNaN(ch.alt[k]) ? ch.alt[k] : 0)
      path.heading.push(nav.heading[k])
      path.t.push(k / rate)
    }
    out.push({
      start: sg.start,
      end: sg.end,
      apex: iMax / rate,
      dir: dirSum >= 0 ? 1 : -1,
      radius: Math.round(R / 5) * 5,
      radiusGps: median(rG),
      radiusLean: median(rL),
      path,
      ex: nav.x[a],
      ey: nav.y[a]
    })
  }
  return out
}
