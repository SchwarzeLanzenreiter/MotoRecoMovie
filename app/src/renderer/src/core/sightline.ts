// Determining whether a floating sign in the air is visible (line of sight) from the current position.
//
// There is no terrain data, so it is decided only from the roads ridden so far and about to be ridden (fused position and altitude):
//   1. Sight path: if the line of sight from the bike to the sign (a segment on the map) strays far from the road in between,
//      the line crosses outside the road (on a pass, a mountain slope or forest) → treat it as not visible (prevents signs beyond a mountain from showing on a winding pass)
//   2. Pass crest: if the road under the line of sight is higher than the line, it is hidden by the rise of the road → treat it as not visible
// Neither flips on or off suddenly: fade between 0 and 1 according to the amount of the excess.
import type { Telemetry } from './telemetry'

/** Road points (every ROAD_STEP m) */
export interface RoadTrack {
  t: Float64Array // video time [s]
  x: Float64Array // east [m]
  y: Float64Array // north [m]
  alt: Float64Array // altitude [m] (approximate road surface height)
}

const ROAD_STEP = 2

export const SIGHT = {
  /** Visible until the line of sight strays this far from the road [m] */
  corridorNear: 10,
  /** Not visible beyond this distance [m] (fades in between) */
  corridorFar: 25,
  /** Visible until the road under the line of sight rises this much above it [m] (allows for GPS altitude error) */
  crestNear: 2,
  crestFar: 6,
  /** Spacing of points along the line of sight [m] */
  step: 5
}

/** Builds the road point list from the fused position (nav) and altitude */
export function roadTrack(tel: Telemetry): RoadTrack | null {
  const nav = tel.nav
  if (!nav) return null
  const alt = tel.channels.alt
  const t: number[] = []
  const x: number[] = []
  const y: number[] = []
  const a: number[] = []
  let px = NaN
  let py = NaN
  for (let i = 0; i < tel.n; i++) {
    const nx = nav.x[i]
    const ny = nav.y[i]
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue
    if (t.length && Math.hypot(nx - px, ny - py) < ROAD_STEP && i < tel.n - 1) continue
    t.push(i / tel.rate)
    x.push(nx)
    y.push(ny)
    a.push(alt && Number.isFinite(alt[i]) ? alt[i] : NaN)
    px = nx
    py = ny
  }
  if (t.length < 2) return null
  return { t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), alt: Float64Array.from(a) }
}

/** Index of the latest point at or before time t */
function indexAt(road: RoadTrack, t: number): number {
  let lo = 0
  let hi = road.t.length - 1
  if (t <= road.t[0]) return 0
  if (t >= road.t[hi]) return hi
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (road.t[m] <= t) lo = m
    else hi = m
  }
  return lo
}

/**
 * Whether the sign target (height of the part to see), standing at the point passed at time tSign, is visible from position eye (eye height) at time tNow.
 * 1 = visible, 0 = not visible (faded in between)
 */
export function sightVisibility(
  road: RoadTrack,
  tNow: number,
  tSign: number,
  eye: { x: number; y: number; h: number },
  target: { x: number; y: number; h: number }
): number {
  const dx = target.x - eye.x
  const dy = target.y - eye.y
  const L2 = dx * dx + dy * dy
  const L = Math.sqrt(L2)
  if (L < SIGHT.corridorNear * 1.5) return 1
  const i0 = indexAt(road, tNow)
  // Road a little beyond the sign (the sign stands before the entry point; the road inside the corner is also near the line of sight)
  const i1 = Math.min(road.t.length - 1, indexAt(road, tSign) + Math.ceil(30 / ROAD_STEP))
  if (i1 - i0 < 2) return 1
  // 1. Sight path: the maximum, over points on the line of sight, of the distance to the nearest road point
  let worst = 0
  const m = Math.max(2, Math.ceil(L / SIGHT.step))
  for (let k = 1; k < m; k++) {
    const u = k / m
    const px = eye.x + dx * u
    const py = eye.y + dy * u
    let best = Infinity
    for (let j = i0; j <= i1; j++) {
      const ex = road.x[j] - px
      const ey = road.y[j] - py
      const d2 = ex * ex + ey * ey
      if (d2 < best) best = d2
    }
    worst = Math.max(worst, Math.sqrt(best))
  }
  const aCorridor = clamp01((SIGHT.corridorFar - worst) / (SIGHT.corridorFar - SIGHT.corridorNear))
  if (aCorridor === 0) return 0
  // 2. Pass crest: whether the road right under the line of sight is higher than the line
  let excess = -Infinity
  for (let j = i0; j <= i1; j++) {
    const al = road.alt[j]
    if (!Number.isFinite(al)) continue
    const ex = road.x[j] - eye.x
    const ey = road.y[j] - eye.y
    const u = (ex * dx + ey * dy) / L2
    if (u < 0.05 || u > 0.95) continue
    const lat = Math.abs(ex * dy - ey * dx) / L
    if (lat > SIGHT.corridorNear) continue
    excess = Math.max(excess, al - (eye.h + (target.h - eye.h) * u))
  }
  const aCrest = clamp01((SIGHT.crestFar - excess) / (SIGHT.crestFar - SIGHT.crestNear))
  return aCorridor * aCrest
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
