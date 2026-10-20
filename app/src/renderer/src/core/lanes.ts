// Determine from the video which side of the lane we are riding on (left or right of the center line).
// Used for "overtake" in auto camera (a view that does not show the road surface while straddling the lane).
//
//   1. Draw a small image looking down at the road ahead of the bike (LANE_VIEW) (in the orientation with horizon and lean undone)
//   2. Map each row's pixels back to positions on the road (lateral L, forward F [m]) (intersection with the plane at camera height LANE_CAM_HEIGHT)
//   3. There are two cues:
//      - Yellow/orange center line: fit a straight line L = a + b·F to points that are a thin band (width 0.45 m or less, hue 12-48°) with gray road on both sides
//        (Hough transform). a = lateral position of the line directly under the bike. Roadside grass is yellow-green and wide, so it is not included
//      - Road extent: how far the gray road continues left and right from directly under the bike. In left-hand traffic, the right side is wider when in our own lane.
//        A white center line shows up as "one on each side" whether in our own lane or the opposite lane, so they cannot be told apart; so use the road extent rather than the line
// If there is a yellow line, decide by that; otherwise decide by the bias in the road extent.

/** Viewpoint looking down at the road (35° down from horizontal, horizontal FOV 120° = the upper limit of perspective projection) and the image size */
export const LANE_VIEW = { pitch: -35, fov: 120, width: 320, height: 180 }
/** Camera height above the road [m] (approximate. It only affects the scale of the lateral position, not the left/right decision) */
export const LANE_CAM_HEIGHT = 1.5

const F_MIN = 2 // forward range to search for lines [m]
const F_MAX = 10
const F_ROAD_MIN = 4 // forward range to look at the road extent [m]
const F_ROAD_MAX = 9
const MAX_WIDTH = 0.45 // upper limit of line width [m]
const EDGE = 0.25 // width on both sides of a line over which to check for road [m]
const ROAD_GAP = 0.6 // the road edge is where this many non-road pixels continue [m]
const ROAD_BIAS = 0.2 // if the bias in the road extent is at least this, judge it to be that side
const SINGLE_MIN = 0.6 // distance from the line at which a yellow line seen on the opposite side only once is taken to mean we straddled the lane [m]
const SINGLE_MAX = 2
const YELLOW_FAR = 4.5 // yellow farther than this is taken not to be the center line (e.g. an arrow in the opposite lane) [m]
const ROAD_CONTRADICT = 0.25 // if the road extent is biased toward our own lane by at least this, do not use yellow seen on the opposite side
const ROAD_RUN_BIAS = 0.3 // in a run decided by the road extent alone, if the bias moves to the opposite side by at least this, take it as straddling the lane
const RUN_MIN_A = 1.1 // in a run decided by the yellow line alone, if the line moves away from the bike by at least this, take it as straddling the lane [m]

export interface LaneLine {
  /** Lateral position directly under the bike [m] (right is positive) */
  a: number
  /** Lateral change per 1 m forward */
  b: number
  /** Number of fitted points */
  votes: number
}

export interface LaneObservation {
  yellow: LaneLine | null
  /** Left/right extent of the road [m] (median), and the fraction of rows where the edge was visible */
  road: { left: number; right: number; leftSeen: number; rightSeen: number } | null
}

/** From the downward-looking image (RGBA, from the top row), find the yellow line and the road extent */
export function observeLanes(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, camHeight = LANE_CAM_HEIGHT): LaneObservation {
  const pitch = (-LANE_VIEW.pitch * Math.PI) / 180
  const f = w / 2 / Math.tan((LANE_VIEW.fov * Math.PI) / 360)
  const cs = Math.cos(pitch)
  const sn = Math.sin(pitch)
  const cx = w / 2 - 0.5
  const pts: number[] = [] // points on the yellow line (pairs of F, L)
  const hue = new Float32Array(w)
  const sat = new Float32Array(w)
  const val = new Float32Array(w)
  const road = new Uint8Array(w)
  const lefts: number[] = []
  const rights: number[] = []
  let leftSeen = 0
  let rightSeen = 0
  let rows = 0
  for (let yy = 0; yy < h; yy++) {
    const y = yy - (h / 2 - 0.5)
    const ly = y * cs + f * sn
    if (ly <= 0) continue
    const t = camHeight / ly // lateral length per pixel [m]
    const F = t * (-y * sn + f * cs)
    if (F < F_MIN || F > F_MAX) continue
    let nRoad = 0
    for (let x = 0; x < w; x++) {
      const o = (yy * w + x) * 4
      const r = rgba[o] / 255
      const g = rgba[o + 1] / 255
      const b = rgba[o + 2] / 255
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const d = Math.max(mx - mn, 1e-6)
      val[x] = mx
      sat[x] = mx > 0 ? (mx - mn) / mx : 0
      hue[x] = (mx === r ? (((g - b) / d) % 6 + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
      road[x] = sat[x] < 0.12 && mx > 0.12 ? 1 : 0
      nRoad += road[x]
    }
    const cand = (x: number): boolean => hue[x] >= 12 && hue[x] <= 48 && sat[x] >= 0.14 && val[x] >= 0.5
    // For the road extent, also count yellow lines (a double line is about 0.5 m wide) and pixels with blurred edges as road
    const roadish = (x: number): boolean => road[x] === 1 || sat[x] < 0.2 || cand(x)
    // Road extent: from directly under to the left and right, until ROAD_GAP non-road pixels continue (thin lines are skipped over)
    if (F >= F_ROAD_MIN && F <= F_ROAD_MAX) {
      const gap = Math.max(1, Math.round(ROAD_GAP / t))
      for (const dir of [-1, 1]) {
        let x = Math.round(cx)
        let miss = 0
        let last = x
        let seen = false
        for (; x >= 0 && x < w; x += dir) {
          if (roadish(x)) {
            miss = 0
            last = x
          } else if (++miss >= gap) {
            seen = true
            break
          }
        }
        const ext = Math.abs(last - cx) * t
        if (dir < 0) {
          lefts.push(ext)
          if (seen) leftSeen++
        } else {
          rights.push(ext)
          if (seen) rightSeen++
        }
      }
    }
    // Yellow line candidates
    if (nRoad < w * 0.3) continue
    rows++
    const e = Math.max(1, Math.round(EDGE / t))
    let x = 0
    while (x < w) {
      if (!cand(x)) {
        x++
        continue
      }
      const x0 = x
      while (x < w && cand(x)) x++
      const x1 = x
      // Whether both sides are road (skip the one blurred pixel at the edge of the line)
      if ((x1 - x0) * t > MAX_WIDTH || x0 - e - 1 < 0 || x1 + e + 1 > w) continue
      let l = 0
      let r = 0
      for (let k = x0 - e - 1; k < x0 - 1; k++) l += sat[k] < 0.18 ? 1 : 0
      for (let k = x1 + 1; k < x1 + e + 1; k++) r += sat[k] < 0.18 ? 1 : 0
      if (l < 0.6 * e || r < 0.6 * e) continue
      pts.push(F, t * ((x0 + x1 - 1) / 2 - cx))
    }
  }
  const yl = houghLine(pts)
  const median = (a: number[]): number => [...a].sort((p, q) => p - q)[a.length >> 1]
  return {
    yellow: yl && yl.votes >= Math.max(8, rows * 0.25) ? yl : null,
    road: lefts.length ? { left: median(lefts), right: median(rights), leftSeen: leftSeen / lefts.length, rightSeen: rightSeen / rights.length } : null
  }
}

/** Fit a straight line L = a + b·F to pairs of points (F, L) (Hough transform). The line with the most votes */
function houghLine(pts: number[]): LaneLine | null {
  const A0 = -7
  const DA = 0.15
  const NA = Math.round(14 / DA) + 1
  const B = 0.7
  const DB = 0.025
  const NB = Math.round((2 * B) / DB) + 1
  const acc = new Int32Array(NA * NB)
  for (let p = 0; p < pts.length; p += 2) {
    const F = pts[p]
    const L = pts[p + 1]
    for (let j = 0; j < NB; j++) {
      const ia = Math.round((L - (-B + j * DB) * F - A0) / DA)
      if (ia >= 0 && ia < NA) acc[ia * NB + j]++
    }
  }
  let best = 0
  for (let k = 1; k < acc.length; k++) if (acc[k] > acc[best]) best = k
  if (acc[best] < 3) return null
  return { a: A0 + Math.floor(best / NB) * DA, b: -B + (best % NB) * DB, votes: acc[best] }
}

export interface LaneSample {
  /** Video time [s] */
  t: number
  /** Side of the center line (right = +1, left = -1, unknown = 0). In left-hand traffic, +1 is our own lane */
  side: -1 | 0 | 1
  /** Whether it was decided from a yellow line (more reliable than the estimate from the road extent) */
  yellow: boolean
  /** For inspection: position directly under the yellow line [m] and the bias of the road extent (positive if the right is wider) */
  a?: number
  bias?: number
}

/** From one observation, decide the side of the center line */
export function laneSide(o: LaneObservation): { side: -1 | 0 | 1; yellow: boolean; a?: number; bias?: number } {
  const r = o.road
  const bias = r ? (r.right - r.left) / Math.max(r.right + r.left, 1e-6) : undefined
  if (o.yellow) return { side: o.yellow.a >= 0 ? 1 : -1, yellow: true, a: o.yellow.a, bias }
  // Road extent: when at least one side's edge is visible and the bias is clear
  if (!r || bias === undefined || (r.leftSeen < 0.5 && r.rightSeen < 0.5)) return { side: 0, yellow: false, bias }
  return { side: bias >= ROAD_BIAS ? 1 : bias <= -ROAD_BIAS ? -1 : 0, yellow: false, bias }
}

/**
 * Side of the center line in our own lane (left-hand traffic = +1, right-hand traffic = -1). The one with more observations. If there are enough yellow line observations, decide by them.
 * 0 if there are too few observations
 */
export function ownSide(samples: LaneSample[]): -1 | 0 | 1 {
  let pos = 0
  let neg = 0
  let yp = 0
  let yn = 0
  for (const s of samples) {
    if (s.side > 0) pos++
    else if (s.side < 0) neg++
    if (s.yellow) s.side > 0 ? yp++ : yn++
  }
  if (pos + neg < 5) return 0
  return yp + yn >= 10 ? (yp >= yn ? 1 : -1) : pos >= neg ? 1 : -1
}

export interface LaneCrossing {
  /** Last time we were in our own lane [s] (after this, we start straddling the lane before the next observation) */
  start: number
  /** Time when we were confirmed to be back in our own lane [s] */
  end: number
}

/**
 * From the sequence of observations, find the runs in which we were across the center line in the opposite lane.
 * Our own side (the center line on the right in left-hand traffic) is taken to be the one with more observations (so it works for both left- and right-hand traffic).
 * The estimate from the road extent is error-prone, so the opposite-side decision is used only when either neighbor is also on the opposite side
 */
export function findLaneCrossings(samples: LaneSample[], maxDur = 30): LaneCrossing[] {
  const own = ownSide(samples)
  if (!own) return []
  const st = samples.map((s, i) => {
    if (s.side === 0) return 0
    if (s.side === own) return s.side
    if (s.yellow) {
      const a = Math.abs(s.a ?? 0)
      // Do not use yellow that is too far (markings such as an arrow in the opposite lane) or when the road extent clearly indicates our own lane
      if (a > YELLOW_FAR || (s.bias ?? 0) * own >= ROAD_CONTRADICT) return 0
      // Also do not use something that appears only once with no yellow line before or after (other yellow objects)
      const tracked = [samples[i - 1], samples[i + 1]].some((x) => x && x.yellow)
      return tracked ? s.side : 0
    }
    const nb = [samples[i - 1], samples[i + 1]].some((x) => x && x.side === s.side)
    return nb ? s.side : 0
  })
  const out: LaneCrossing[] = []
  let lastOwn = -1
  for (let i = 0; i < samples.length; i++) {
    if (st[i] !== -own) {
      if (st[i] === own) lastOwn = i
      continue
    }
    // Run in the opposite lane: until we are next judged to be on our own side
    let k = i + 1
    let n = 1
    while (k < samples.length && st[k] !== own) {
      if (st[k] === -own) n++
      k++
    }
    // If the opposite side appears only once, do not use it when the line is directly under the bike (just drove over the line) or far (other yellow markings)
    const a = Math.abs(samples[i].a ?? NaN)
    const single = n === 1 && !(samples[i].yellow && a >= SINGLE_MIN && a <= SINGLE_MAX)
    // A run decided by the yellow line alone only when the line moved far enough from the bike, or the road extent also indicates the opposite side
    let maxA = 0
    let minBias = Infinity
    let yellowOnly = true
    let anyYellow = false
    for (let q = i; q < k; q++) {
      if (st[q] !== -own) continue
      if (!samples[q].yellow) yellowOnly = false
      else anyYellow = true
      maxA = Math.max(maxA, Math.abs(samples[q].a ?? 0))
      minBias = Math.min(minBias, (samples[q].bias ?? 0) * own)
    }
    // A run decided by the road extent alone only when the bias is clear (the left-right width can change with paving such as a roadside parking lot)
    const weak = (yellowOnly && maxA < RUN_MIN_A && minBias > -0.1) || (!anyYellow && minBias > -ROAD_RUN_BIAS)
    if (!single && !weak && lastOwn >= 0 && k < samples.length && samples[k].t - samples[lastOwn].t <= maxDur) out.push({ start: samples[lastOwn].t, end: samples[k].t })
    i = k - 1
  }
  return out
}
