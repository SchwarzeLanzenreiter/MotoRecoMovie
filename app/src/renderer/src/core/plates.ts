// License plates for the privacy mosaic. The plate detector (YOLOv9 tiny, 640² input, from open-image-models; see public/models/NOTICE.md)
// runs on perspective crops of the 360° video a few times a second (engine/plates.ts). Each plate is kept as the directions of its four
// corners in gyro (world) coordinates, so it can be drawn in any view; between scans the corners are interpolated, and a plate seen
// shortly before or after is still covered, a little enlarged, so the mosaic does not flicker off between detections.
// The own bike's plate is small and often found with a low score, but it stays at the same place relative to the bike: weak
// detections that keep coming back at one place in bike coordinates while riding are taken for it (ownPlates) and covered all the time,
// where the detections of it nearest in time put it (ownAt). Boxes drawn by hand around it (PlateMark) count as detections of it.
// Bike coordinates, not camera (rig) ones: the camera mount may turn on the way (core/mount.ts).
// Only scans while moving count: when stopped, everything around stays at one place relative to the camera too. So that it is known
// early (a video often starts at a stop), short stretches spread over the whole video are scanned first (surveyTimes).
import { matVec, type Mat3, type Vec3 } from './quat'

export const PLATE_MODEL = 'yolo-v9-t-640-license-plates-end2end.onnx'
export const PLATE_SIZE = 640
/** Scans per second of video */
export const PLATE_RATE = 5
/** Detections below this score are ignored */
export const PLATE_SCORE = 0.35
/** Weaker detections down to this score are kept in rig coordinates, to find the own bike's plate */
export const OWN_SCORE = 0.15
/**
 * A crop where nothing was found is looked at again only every EMPTY_EVERY scans; the downward crops (close plates, the own bike's)
 * every DOWN_EVERY scans. PLATE_HOLD covers the time until a new plate is found
 */
export const EMPTY_EVERY = 2
export const DOWN_EVERY = 5
/** A plate is still covered this long [s] before its first and after its last detection nearby in time */
export const PLATE_HOLD = 0.45
/** Corners pushed out from the center by this factor (the box is tight, and the plate moves between scans) */
export const PLATE_PAD = 1.4

/**
 * Crops the detector looks through (yaw, pitch [deg], with the lean undone; 90° FOV): the horizon all round, and down to the front and
 * back and straight down for plates close by (the own bike's included)
 */
export const PLATE_CROPS: { yaw: number; pitch: number }[] = [
  { yaw: 0, pitch: -8 },
  { yaw: 90, pitch: -8 },
  { yaw: 180, pitch: -8 },
  { yaw: -90, pitch: -8 },
  { yaw: 0, pitch: -55 },
  { yaw: 180, pitch: -55 },
  { yaw: 0, pitch: -90 }
]
export const PLATE_FOV = 90

/** A detection in a crop [pixels of the 640² input] */
export interface PlateBox {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
}

/** RGBA (640², from the top row) -> the model input: RGB planes 0 to 1 */
export function toPlateInput(rgba: Uint8Array, size = PLATE_SIZE): Float32Array {
  const n = size * size
  const out = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    out[i] = rgba[i * 4] / 255
    out[n + i] = rgba[i * 4 + 1] / 255
    out[2 * n + i] = rgba[i * 4 + 2] / 255
  }
  return out
}

/** Rows of the model output [batch, x1, y1, x2, y2, class, score] (already through non-maximum suppression) -> boxes */
export function parsePlates(out: Float32Array, rows: number, scoreThr = PLATE_SCORE): PlateBox[] {
  const res: PlateBox[] = []
  for (let r = 0; r < rows; r++) {
    const o = r * 7
    if (out[o + 6] < scoreThr) continue
    res.push({ x0: out[o + 1], y0: out[o + 2], x1: out[o + 3], y1: out[o + 4], score: out[o + 6] })
  }
  return res
}

const norm = (v: number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * The four corners of a box (top left, top right, bottom right, bottom left) as unit directions in world coordinates.
 * view: crop camera -> rig (row-major, columns = right, down, forward), drawn as a plain perspective crop of `fov` and `size`;
 * toWorld: rig -> world at that frame
 */
export function boxToWorld(b: PlateBox, view: Mat3, fov: number, size: number, toWorld: Mat3): Vec3[] {
  const f = size / 2 / Math.tan((fov * Math.PI) / 360)
  return [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x1, b.y1],
    [b.x0, b.y1]
  ].map(([x, y]) => norm(matVec(toWorld, matVec(view, [(x - size / 2) / f, (y - size / 2) / f, 1]))))
}

/** Plates found in one scan: corners of each (12 numbers: 4 world directions) */
export interface PlateScan {
  t: number // video time [s]
  quads: number[][]
}

const center = (q: number[]): Vec3 => norm([q[0] + q[3] + q[6] + q[9], q[1] + q[4] + q[7] + q[10], q[2] + q[5] + q[8] + q[11]])
const angle = (a: Vec3, b: Vec3): number => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
/** Angular size of a plate: its diagonal */
const extent = (q: number[]): number => angle(norm(q.slice(0, 3)), norm(q.slice(6, 9)))

/**
 * Same detections seen in two overlapping crops: keep the higher scoring one of plates whose centers lie within half their size
 * (in place, quads with scores)
 */
export function mergeOverlapping(found: { quad: number[]; score: number }[]): number[][] {
  const keep: { quad: number[]; score: number }[] = []
  for (const f of [...found].sort((a, b) => b.score - a.score)) {
    const c = center(f.quad)
    if (keep.some((k) => angle(center(k.quad), c) < 0.5 * Math.max(extent(k.quad), extent(f.quad)))) continue
    keep.push(f)
  }
  return keep.map((k) => k.quad)
}

function lerpQuad(a: number[], b: number[], f: number): number[] {
  const out: number[] = []
  for (let k = 0; k < 4; k++) out.push(...norm([0, 1, 2].map((c) => a[k * 3 + c] * (1 - f) + b[k * 3 + c] * f)))
  return out
}

/** Corners pushed out from the center by `pad` */
function padQuad(q: number[], pad: number): number[] {
  const c = center(q)
  const out: number[] = []
  for (let k = 0; k < 4; k++) out.push(...norm([0, 1, 2].map((i) => c[i] + (q[k * 3 + i] - c[i]) * pad)))
  return out
}

/**
 * Plates to cover at time t (corners in world coordinates, enlarged by PLATE_PAD). scans: sorted by time.
 * A plate found in the scans just before and just after t is interpolated between them (matched by the nearest center within twice its
 * size); one found only on one side is kept where it was, if it was seen within PLATE_HOLD of t
 */
export function platesAt(scans: PlateScan[], t: number): number[][] {
  if (!scans.length) return []
  // The last scan at or before t
  let lo = 0
  let hi = scans.length - 1
  if (scans[0].t > t) hi = -1
  else {
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (scans[m].t <= t) lo = m
      else hi = m - 1
    }
  }
  const a = hi >= 0 ? scans[hi] : null
  const b = hi + 1 < scans.length ? scans[hi + 1] : null
  const out: number[][] = []
  const usedB = new Set<number>()
  if (a) {
    for (const qa of a.quads) {
      const ca = center(qa)
      let best = -1
      let bestD = 2 * extent(qa) + 0.02
      b?.quads.forEach((qb, k) => {
        const d = angle(ca, center(qb))
        if (!usedB.has(k) && d < bestD) {
          best = k
          bestD = d
        }
      })
      // Only between neighbouring scans (only scans with plates are kept, so the next one may be much later)
      if (best >= 0 && b && b.t - a.t <= 2.5 / PLATE_RATE) {
        usedB.add(best)
        out.push(lerpQuad(qa, b.quads[best], (t - a.t) / Math.max(1e-6, b.t - a.t)))
      } else if (t - a.t <= PLATE_HOLD) out.push(qa)
    }
  }
  if (b) b.quads.forEach((qb, k) => !usedB.has(k) && b.t - t <= PLATE_HOLD && out.push(qb))
  // Scans further back and ahead within PLATE_HOLD (a plate missed by the scan next to t)
  for (let j = hi - 1; j >= 0 && t - scans[j].t <= PLATE_HOLD; j--) for (const q of scans[j].quads) if (!out.some((o) => angle(center(o), center(q)) < extent(q))) out.push(q)
  for (let j = hi + 2; j < scans.length && scans[j].t - t <= PLATE_HOLD; j++) for (const q of scans[j].quads) if (!out.some((o) => angle(center(o), center(q)) < extent(q))) out.push(q)
  return out.map((q) => padQuad(q, PLATE_PAD))
}

/** Cache file contents (JSON) */
export interface PlateCache {
  key: string
  /** Video times scanned, as [start, end] ranges [s] */
  ranges: [number, number][]
  scans: PlateScan[]
  /** Every detection down to OWN_SCORE in rig coordinates: [t, 12 corner numbers] (for ownPlates) */
  rig: number[][]
  /** Times of the scans taken while moving [s] */
  moving: number[]
  /** Whether the stretches of surveyTimes have been scanned */
  surveyed?: boolean
}

/** Moving: at least this speed [km/h] (scans while slower do not count for the own bike's plate) */
export const OWN_MIN_SPEED = 10

/**
 * Detections at one place in bike coordinates count as the own bike's plate when they come back in at least OWN_SHARE of the
 * stretches scanned while moving (and at least 3 of them). The stretches are pieces of the scanned time of up to OWN_BUCKET seconds,
 * shorter when little is scanned yet (a tenth of it, at least 2 s), so a short export range or the survey finds the plate too; a wrong
 * pick from a short range drops out as more of the video is scanned.
 * One place: within OWN_CLUSTER of the mean. The mount orientation is estimated (core/mount.ts) and may be off by several degrees for a
 * while, so the place is wide; where to cover at a time comes from the detections nearest in time (ownAt), where that error is about
 * the same
 */
export const OWN_BUCKET = 10
export const OWN_SHARE = 0.4
const OWN_CLUSTER = (12 * Math.PI) / 180
/** Away from any detection of the own plate, its cover grows by up to OWN_PAD_GROW, fully at OWN_PAD_SEC [s] away */
export const OWN_PAD_GROW = 0.8
export const OWN_PAD_SEC = 60

/** The own bike's plate: its detections in bike coordinates [t, 12 corner numbers], sorted by time (also those while stopped) */
export interface OwnPlate {
  hits: number[][]
}

/** The own bike's plate marked by hand: a box drawn around it in the video at time t (corners in rig coordinates, 12 numbers) */
export interface PlateMark {
  t: number
  quad: number[]
}

/**
 * The own bike's plate (and anything else fixed to the bike that looks like one): places in bike coordinates where detections came back
 * again and again over the ride.
 * rig: detections in rig coordinates; moving: times of the scans while moving (only those count for finding the place); toBike(t): the
 * mount orientation at video time t (columns = body right, down, forward in rig coordinates; core/mount.ts). Without it, everything
 * stays in rig coordinates. marks: boxes drawn by hand; each joins the nearest place found, or makes one of its own
 */
export function ownPlates(rig: number[][], moving: number[], toBike?: (t: number) => Mat3, marks: PlateMark[] = []): OwnPlate[] {
  const bike = (hs: number[][]): number[][] =>
    toBike
      ? hs.map((h) => {
          const M = toBike(h[0])
          const out = [h[0]]
          for (let j = 0; j < 4; j++) {
            const [x, y, z] = h.slice(1 + j * 3, 4 + j * 3)
            out.push(M[0] * x + M[3] * y + M[6] * z, M[1] * x + M[4] * y + M[7] * z, M[2] * x + M[5] * y + M[8] * z)
          }
          return out
        })
      : hs
  rig = bike(rig)
  const marked = bike(marks.map((m) => [m.t, ...m.quad]))
  const total = moving.length / PLATE_RATE
  const bucket = Math.min(OWN_BUCKET, Math.max(2, total / 10))
  // Stretches: a new one starts after bucket seconds or after a gap (between survey stretches, or ranges scanned apart)
  const starts: number[] = []
  let prev = -Infinity
  for (const t of [...moving].sort((a, b) => a - b)) {
    const s = starts[starts.length - 1]
    if (s === undefined || t - s > bucket + 1e-6 || t - prev > 1) starts.push(t)
    prev = t
  }
  const scanned = starts.length
  const stretchOf = (t: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (starts[m] <= t + 0.01) lo = m
      else hi = m - 1
    }
    return lo
  }
  const isMoving = new Set(moving.map((t) => Math.round(t * 1e4)))
  // Places: each detection while moving joins the nearest place within OWN_CLUSTER of its mean (in time order, so the mean follows a
  // slow drift of the mount estimate), or starts a new one
  const places: { sum: Vec3; c: Vec3; stretches: Set<number> }[] = []
  for (const h of [...rig].sort((a, b) => a[0] - b[0])) {
    if (!isMoving.has(Math.round(h[0] * 1e4))) continue
    const c = center(h.slice(1))
    let best: (typeof places)[number] | null = null
    for (const p of places) if (angle(p.c, c) < OWN_CLUSTER && (!best || angle(p.c, c) < angle(best.c, c))) best = p
    if (!best) places.push((best = { sum: [0, 0, 0], c, stretches: new Set() }))
    best.sum = [best.sum[0] + c[0], best.sum[1] + c[1], best.sum[2] + c[2]]
    best.c = norm(best.sum)
    best.stretches.add(stretchOf(h[0]))
  }
  const own = places.filter((p) => p.stretches.size >= Math.max(3, OWN_SHARE * scanned))
  const nearest = (ps: { c: Vec3 }[], c: Vec3): number => {
    let k = -1
    ps.forEach((p, j) => {
      if (angle(p.c, c) < OWN_CLUSTER && (k < 0 || angle(p.c, c) < angle(ps[k].c, c))) k = j
    })
    return k
  }
  // Every detection (moving or not) near a place found is kept with the nearest one, to tell where it is at each time
  const out: OwnPlate[] = own.map(() => ({ hits: [] }))
  for (const h of rig) {
    const k = nearest(own, center(h.slice(1)))
    if (k >= 0) out[k].hits.push(h)
  }
  // Boxes drawn by hand: with the nearest place found, or together in places of their own (only boxes: no detection is needed)
  const alone: { c: Vec3; hits: number[][] }[] = []
  for (const m of marked) {
    const c = center(m.slice(1))
    const k = nearest(own, c)
    if (k >= 0) out[k].hits.push(m)
    else {
      const a = nearest(alone, c)
      if (a >= 0) alone[a].hits.push(m)
      else alone.push({ c, hits: [m] })
    }
  }
  out.push(...alone.map((a) => ({ hits: a.hits })))
  for (const o of out) o.hits.sort((a, b) => a[0] - b[0])
  return out
}

/**
 * Where the own bike's plate is at video time t (corners in the coordinates of its hits, enlarged): interpolated between the detections
 * just before and after t, or the nearest one; covered wider the further away in time that is
 */
export function ownAt(o: OwnPlate, t: number): number[] {
  const h = o.hits
  let lo = 0
  let hi = h.length - 1
  if (h[0][0] > t) hi = -1
  else {
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (h[m][0] <= t) lo = m
      else hi = m - 1
    }
  }
  const a = hi >= 0 ? h[hi] : null
  const b = hi + 1 < h.length ? h[hi + 1] : null
  let q: number[]
  let gap: number
  if (a && b) {
    q = lerpQuad(a.slice(1), b.slice(1), (t - a[0]) / Math.max(1e-6, b[0] - a[0]))
    gap = Math.min(t - a[0], b[0] - t)
  } else {
    const n = (a ?? b)!
    q = n.slice(1)
    gap = Math.abs(t - n[0])
  }
  return padQuad(q, PLATE_PAD + OWN_PAD_GROW * Math.min(1, gap / OWN_PAD_SEC))
}

/** Survey for the own bike's plate: this many stretches of OWN_SURVEY_LEN seconds, spread over the video, while moving */
export const OWN_SURVEY = 12
export const OWN_SURVEY_LEN = 1.8

/**
 * Start times of the survey stretches in a video of dur seconds: one in each of OWN_SURVEY equal parts, the first time from its
 * middle on (then from its start) where the speed is at least OWN_MIN_SPEED through the stretch. speedAt: km/h, or null without a speed
 * (then the middle of each part)
 */
export function surveyTimes(dur: number, speedAt: ((t: number) => number) | null): number[] {
  const out: number[] = []
  const part = dur / OWN_SURVEY
  if (part < OWN_SURVEY_LEN) return out
  for (let k = 0; k < OWN_SURVEY; k++) {
    const a = k * part
    const mid = a + part / 2
    if (!speedAt) {
      out.push(mid)
      continue
    }
    const moving = (t: number): boolean => [0, 0.5, 1].every((f) => speedAt(t + f * OWN_SURVEY_LEN) >= OWN_MIN_SPEED)
    const cands: number[] = []
    for (let t = mid; t + OWN_SURVEY_LEN <= a + part; t += 1) cands.push(t)
    for (let t = a; t < mid; t += 1) cands.push(t)
    const t = cands.find(moving)
    if (t !== undefined) out.push(Math.round(t * 100) / 100)
  }
  return out
}

/** Merge a newly scanned range into the list of ranges */
export function addRange(ranges: [number, number][], r: [number, number]): [number, number][] {
  const all = [...ranges, r].sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const x of all) {
    const last = out[out.length - 1]
    if (last && x[0] <= last[1] + 1 / PLATE_RATE + 1e-6) last[1] = Math.max(last[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}

/** Parts of [t0, t1] not yet scanned */
export function missingRanges(ranges: [number, number][], t0: number, t1: number): [number, number][] {
  const out: [number, number][] = []
  let cur = t0
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (b < cur) continue
    if (a > t1) break
    if (a > cur + 1e-6) out.push([cur, Math.min(a, t1)])
    cur = Math.max(cur, b)
  }
  if (cur < t1 - 1e-6) out.push([cur, t1])
  return out
}
