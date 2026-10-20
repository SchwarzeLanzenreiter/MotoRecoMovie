// Auto camera: decide "shots" from the riding state and markers, and output them as editable keyframes.
//
//   1. From the riding-state sections and markers, build shots (time range and view)
//   2. At each time pick the shot with the highest priority and make a sequence with cut points (drop shots that are too short)
//   3. At each cut point place two keyframes: "switch start (previous view)" and "switch complete (new view)"
//      (keyframes are interpolated with ease-in-out, so the switch becomes a smooth pan)
import type { RidingTrack, RidingState } from '../core/riding'
// project.ts and this module import each other, so do not use project.ts values during module initialization
// (viewAt is used only inside functions)
import { viewAt, type Keyframe } from './project'

type View = Omit<Keyframe, 't'>

export interface Marker {
  id: string
  t: number // video time [s]
  yaw: number // body coordinates [deg]
  pitch: number
  fov: number
  hold: number // how long to show [s]
}

/**
 * Default views to switch to in auto-generation (an app setting. Remembered on this computer and changed from "Auto-generated views" in the settings menu).
 * The direction (yaw) is an angle with the front of the body as 0° and right positive
 */
export interface ShotViews {
  /** Front (base view). Cruise and stop scenery varies slightly from this */
  front: View
  /**
   * Corner entry (① look slightly inward): from the front direction, look inward by lean angle × gain (up to max°).
   * Up/down, FOV, and the lean kept on screen are these values
   */
  corner: Omit<View, 'yaw'> & { gain: number; max: number }
  /** Side (③ directly beside, inside / ④ directly beside, outside): yaw is the angle to turn sideways (toward the inside / outside of the corner) */
  side: View
  /** Rear (② show the rider) */
  rear: View
}
export type ShotViewKind = keyof ShotViews
export const SHOT_VIEW_KINDS: ShotViewKind[] = ['front', 'corner', 'side', 'rear']

export const DEFAULT_SHOT_VIEWS: ShotViews = {
  front: { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 },
  corner: { gain: 0.6, max: 35, pitch: 0, fov: 110, leanRatio: 1 },
  // Directly beside / behind use a wide angle and fixed horizon (the screen stays level and the bike looks tilted)
  side: { yaw: 90, pitch: 0, fov: 165, leanRatio: 0 },
  rear: { yaw: 180, pitch: 0, fov: 165, leanRatio: 0 }
}

/** Fills missing items of the remembered values with defaults (non-numeric values also become defaults) */
export function mergeShotViews(saved: unknown): ShotViews {
  const d = structuredClone(DEFAULT_SHOT_VIEWS)
  const s = (saved ?? {}) as Partial<Record<ShotViewKind, Record<string, unknown>>>
  for (const k of SHOT_VIEW_KINDS) {
    const dst = d[k] as unknown as Record<string, number>
    for (const f of Object.keys(dst)) {
      const v = s[k]?.[f]
      if (typeof v === 'number' && Number.isFinite(v)) dst[f] = v
    }
  }
  return d
}

/**
 * Views shown in the settings screen (preview). Corner entry and side use, as an example, a right corner with lean angle lean° (inside = right),
 * and ④ outside if side = 'out'
 */
export function shotPreviewView(v: ShotViews, kind: ShotViewKind, lean = 30, side: 'in' | 'out' = 'in'): View {
  if (kind === 'corner') return cornerView(v, lean)
  if (kind === 'side') return { ...v.side, yaw: (side === 'in' ? 1 : -1) * Math.sign(lean || 1) * v.side.yaw }
  return { ...v[kind] }
}

/** View for corner entry (①): from lean angle pk° (right = positive) */
function cornerView(v: ShotViews, pk: number): View {
  const c = v.corner
  const yaw = Math.max(-c.max, Math.min(c.max, pk * c.gain))
  return { yaw: v.front.yaw + yaw, pitch: c.pitch, fov: c.fov, leanRatio: c.leanRatio }
}

export interface DirectorSettings {
  transition: number // time taken to switch [s]
  minShot: number // shots shorter than this are dropped [s]
  /**
   * Corner entry view. Normally ① look slightly inward (lean angle × gain, up to max°).
   * For every special.every long corners (special.minDur seconds or longer), insert in turn ② rider (fixed horizon, wide angle),
   * ③ directly beside, inside, ④ directly beside, outside (the corner entrance and the exit on one screen)
   */
  corner: {
    on: boolean
    /** side = ③ directly beside, inside; sideOut = ④ directly beside, outside (views are ShotViews) */
    special: { rider: boolean; side: boolean; sideOut: boolean; every: number; minDur: number; maxDur: number }
  }
  cruise: { on: boolean; interval: number; duration: number; yaw: number; fov: number }
  stop: { on: boolean; minDur: number; pitch: number; fov: number }
  /**
   * Overtake: while overtaking a car across the center line (core/overtake.ts), use a view where the road surface is not visible
   * (default: look at the sky and scenery above, fixed horizon). Overtake scenes are found by scanning the video (Session.scanOvertakes)
   */
  overtake: {
    on: boolean
    yaw: number
    pitch: number
    fov: number
    /** No switching for slower overtakes than this (average vehicle speed over the section [km/h]). 0 = always switch. If speed is unknown, switch */
    minSpeed: number
  }
}

export const DEFAULT_DIRECTOR: DirectorSettings = {
  transition: 0.8,
  minShot: 1.2,
  corner: { on: true, special: { rider: true, side: true, sideOut: true, every: 2, minDur: 2.5, maxDur: 5 } },
  cruise: { on: true, interval: 20, duration: 4, yaw: 75, fov: 100 },
  stop: { on: true, minDur: 3, pitch: -12, fov: 130 },
  overtake: { on: false, yaw: 0, pitch: 40, fov: 80, minSpeed: 40 }
}

/** Fills items added later into saved settings with defaults */
export function mergeDirector(saved: Partial<DirectorSettings> | undefined): DirectorSettings {
  const d = structuredClone(DEFAULT_DIRECTOR)
  if (!saved) return d
  // Previously the views (base view, amount of inward look at corners, FOV of side and rider) were kept here too. They are now app settings (ShotViews), so discard them
  // The switching for deceleration (move down the front view) and acceleration (zoom the front view) was removed (2026-10-20). Discard it even if saved
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { base: _base, brake: _brake, accel: _accel, ...rest } = saved as Partial<DirectorSettings> & { base?: unknown; brake?: unknown; accel?: unknown }
  const sp = { ...saved.corner?.special } as Record<string, unknown>
  delete sp.riderFov
  delete sp.sideFov
  return {
    ...d,
    ...rest,
    corner: {
      on: saved.corner?.on ?? d.corner.on,
      special: { ...d.corner.special, ...(sp as Partial<DirectorSettings['corner']['special']>) }
    },
    cruise: { ...d.cruise, ...saved.cruise },
    stop: { ...d.stop, ...saved.stop },
    overtake: { ...d.overtake, ...saved.overtake }
  }
}

/** Shot kinds and priorities (larger = higher priority) */
export const SHOT_PRIORITY = { overtake: 7, marker: 6, cornerRider: 3, cornerSide: 3, cornerSideOut: 3, corner: 3, stop: 2, cruise: 1, base: 0 } as const
export type ShotKind = keyof typeof SHOT_PRIORITY

/** Shot kind → keyframe tag (front, corner entry, side, rear, overtake. Markers are treated the same as hand-placed ones) */
export const SHOT_TAG: Record<ShotKind, Keyframe['tag']> = {
  overtake: 'overtake',
  marker: undefined,
  stop: 'front',
  base: 'front',
  corner: 'corner',
  cornerRider: 'rear',
  cornerSide: 'side',
  cornerSideOut: 'side',
  cruise: 'side'
}

export const SHOT_NAMES: Record<ShotKind, string> = {
  overtake: 'Overtake', // i18n-ignore
  marker: 'Markers', // i18n-ignore
  corner: 'Corner 1: inside', // i18n-ignore
  cornerRider: 'Corner 2: rider', // i18n-ignore
  cornerSide: 'Corner 3: side (inside)', // i18n-ignore
  cornerSideOut: 'Corner 4: side (outside)', // i18n-ignore
  stop: 'Stopped (scenery)', // i18n-ignore
  cruise: 'Cruise (side scenery)', // i18n-ignore
  base: 'Forward' // i18n-ignore
}

export interface Shot {
  kind: ShotKind
  start: number
  end: number
  view: View
  /** View that changes with time (follows a landmark). If present, view is the view at the start */
  track?: (t: number) => View
}

/** Lean angle at time t (uses the corner's maximum lean angle) */
function peakLeanIn(r: RidingTrack, start: number, end: number): number {
  let pk = 0
  const a = Math.max(0, Math.round(start * r.rate))
  const b = Math.min(r.peakLean.length - 1, Math.round(end * r.rate))
  for (let i = a; i <= b; i++) if (Math.abs(r.peakLean[i]) > Math.abs(pk)) pk = r.peakLean[i]
  return pk
}

/** Overtake section (from the last time in the own lane to the time the return was confirmed) */
export interface OvertakeSpan {
  start: number
  end: number
  /** Average vehicle speed over the section [km/h] (vehicle log; if absent, estimated from video motion; omitted if unknown) */
  speed?: number
}

/** Builds the list of shots from riding states and markers (and overtake sections) */
export function makeShots(
  r: RidingTrack | null,
  markers: Marker[],
  s: DirectorSettings,
  t0: number,
  t1: number,
  overtakes: OvertakeSpan[] = [],
  v: ShotViews = DEFAULT_SHOT_VIEWS
): Shot[] {
  const shots: Shot[] = []
  const B = v.front
  if (s.overtake.on) {
    // Start earlier by the switch time so the switch finishes before crossing the lane starts. Hold a little after returning
    const o = s.overtake
    for (const x of overtakes) {
      if (x.end < t0 || x.start > t1) continue
      // No switching for slow overtakes (in traffic jams, urban areas, etc.)
      if (o.minSpeed > 0 && x.speed !== undefined && x.speed < o.minSpeed) continue
      shots.push({ kind: 'overtake', start: Math.max(t0, x.start - s.transition), end: x.end + 0.5, view: { yaw: B.yaw + o.yaw, pitch: o.pitch, fov: o.fov, leanRatio: 0 } })
    }
  }
  const seg = (st: RidingState): RidingTrack['segments'] => (r ? r.segments.filter((x) => x.state === st && x.end > t0 && x.start < t1) : [])
  if (s.corner.on) {
    const sp = s.corner.special
    const specials: ShotKind[] = [
      ...(sp.rider ? ['cornerRider' as const] : []),
      ...(sp.side ? ['cornerSide' as const] : []),
      ...(sp.sideOut ? ['cornerSideOut' as const] : [])
    ]
    let longCount = 0
    let specialCount = 0
    for (const x of seg('corner')) {
      const pk = peakLeanIn(r!, x.start, x.end)
      const dir = Math.sign(pk) || 1 // inside of the corner (right lean = right)
      const long = x.end - x.start >= sp.minDur
      if (long) longCount++
      // For every "every" long corners, insert ② to ④ in turn
      if (long && specials.length && sp.every > 0 && longCount % sp.every === 0) {
        const kind = specials[specialCount++ % specials.length]
        const end = Math.min(x.end, x.start + sp.maxDur)
        if (kind === 'cornerRider') {
          // Show the rider (rear. Default is facing back, wide angle, fixed horizon; the screen stays level and the bike looks tilted)
          shots.push({ kind, start: x.start, end, view: { ...v.rear } })
        } else {
          // Directly beside (side. ③ inside / ④ outside), wide angle: fit the corner entrance and the exit on one screen.
          // When looking sideways the lean kept on screen naturally becomes 0 (motion-model.ts), but by default the horizon is fixed so it does not tilt during the switch
          const side = kind === 'cornerSide' ? dir : -dir
          shots.push({ kind, start: x.start, end, view: { ...v.side, yaw: side * v.side.yaw } })
        }
        continue
      }
      const cv = cornerView(v, pk)
      // If the inward look is small and the up/down, FOV, and lean are the same as the front, keep the front
      const differs = Math.abs(cv.pitch - B.pitch) >= 0.5 || Math.abs(cv.fov - B.fov) >= 0.5 || Math.abs(cv.leanRatio - B.leanRatio) >= 0.01
      if (Math.abs(cv.yaw - B.yaw) >= 3 || differs) shots.push({ kind: 'corner', start: x.start, end: x.end, view: cv })
    }
  }
  if (s.stop.on) {
    for (const x of seg('stop')) {
      if (x.end - x.start < s.stop.minDur) continue
      shots.push({ kind: 'stop', start: x.start, end: x.end, view: { ...B, pitch: s.stop.pitch, fov: s.stop.fov } })
    }
  }
  if (s.cruise.on) {
    // While cruising continues, insert left and right scenery alternately every interval
    let side = 1
    for (const x of seg('cruise')) {
      const len = x.end - x.start
      if (len < s.cruise.interval) continue
      for (let a = x.start + s.cruise.interval / 2; a + s.cruise.duration + s.transition <= x.end; a += s.cruise.interval) {
        shots.push({ kind: 'cruise', start: a, end: a + s.cruise.duration, view: { ...B, yaw: B.yaw + side * s.cruise.yaw, fov: s.cruise.fov } })
        side = -side
      }
    }
  }
  for (const m of markers) {
    if (m.t + m.hold < t0 || m.t > t1) continue
    shots.push({ kind: 'marker', start: m.t, end: m.t + m.hold, view: { yaw: m.yaw, pitch: m.pitch, fov: m.fov, leanRatio: B.leanRatio } })
  }
  return shots
}

/** At each time pick the shot with the highest priority and make a sequence of cut points (start, shot) */
export function resolveShots(shots: Shot[], s: DirectorSettings, t0: number, t1: number, v: ShotViews = DEFAULT_SHOT_VIEWS, dt = 0.05): { start: number; shot: Shot }[] {
  const base: Shot = { kind: 'base', start: t0, end: t1, view: v.front }
  const n = Math.max(1, Math.ceil((t1 - t0) / dt))
  const pick: Shot[] = new Array(n).fill(base)
  for (const sh of shots) {
    const a = Math.max(0, Math.floor((sh.start - t0) / dt))
    const b = Math.min(n, Math.ceil((sh.end - t0) / dt))
    for (let i = a; i < b; i++) if (SHOT_PRIORITY[sh.kind] > SHOT_PRIORITY[pick[i].kind]) pick[i] = sh
  }
  // Sequence of cut points
  let runs: { start: number; end: number; shot: Shot }[] = []
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1]
    if (last && last.shot === pick[i]) last.end = t0 + (i + 1) * dt
    else runs.push({ start: t0 + i * dt, end: t0 + (i + 1) * dt, shot: pick[i] })
  }
  // Drop shots that are too short (keep markers). Merge consecutive shots with the same view
  for (let pass = 0; pass < 3; pass++) {
    const out: typeof runs = []
    for (const r of runs) {
      // A brief return to the front (e.g. a special shot followed by 0.3 s of front, then the next shot) is also flicker, so front is included
      const short = r.end - r.start < s.minShot && r.shot.kind !== 'marker'
      const prev = out[out.length - 1]
      if (short && prev) prev.end = r.end
      else if (prev && !prev.shot.track && !r.shot.track && sameView(prev.shot.view, r.shot.view)) prev.end = r.end
      else if (short) out.push({ ...r, shot: base })
      else out.push({ ...r })
    }
    runs = out
  }
  return runs.map((r) => ({ start: r.start, shot: r.shot }))
}

function sameView(a: View, b: View): boolean {
  return Math.abs(a.yaw - b.yaw) < 0.5 && Math.abs(a.pitch - b.pitch) < 0.5 && Math.abs(a.fov - b.fov) < 0.5 && Math.abs(a.leanRatio - b.leanRatio) < 0.01
}

/**
 * Generates keyframes and replaces the [t0, t1] part of the existing keyframes.
 * Keyframes outside the range are kept, and both ends of the range connect to the original view.
 */
export function generateKeyframes(
  existing: Keyframe[],
  r: RidingTrack | null,
  markers: Marker[],
  s: DirectorSettings,
  t0: number,
  t1: number,
  overtakes: OvertakeSpan[] = [],
  views: ShotViews = DEFAULT_SHOT_VIEWS
): { keyframes: Keyframe[]; shots: { start: number; shot: Shot }[] } {
  const runs = resolveShots(makeShots(r, markers, s, t0, t1, overtakes, views), s, t0, t1, views)
  const keys: Keyframe[] = []
  const add = (t: number, v: View, linear = false, tag?: Keyframe['tag']): void => {
    if (t < t0 - 1e-6 || t > t1 + 1e-6) return
    const k: Keyframe = { t, ...v, ...(linear && { linear: true }), ...(tag && { tag }) }
    // For keyframes at the same time, the later one overwrites
    const i = keys.findIndex((x) => Math.abs(x.t - t) < 0.01)
    if (i >= 0) keys[i] = k
    else keys.push(k)
  }
  const viewOf = (run: (typeof runs)[number], t: number): View => (run.shot.track ? run.shot.track(t) : run.shot.view)
  // Tag keyframes with the shot kind (color-coded on the timeline)
  const tagOf = (run: (typeof runs)[number]): Keyframe['tag'] => SHOT_TAG[run.shot.kind]
  add(t0, viewOf(runs[0], t0), false, tagOf(runs[0]))
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]
    const cur = runs[i]
    const next = runs[i + 1]
    const end = next ? next.start : t1
    const room = end - cur.start
    const T = Math.min(s.transition, room / 2, (cur.start - prev.start) / 2)
    add(cur.start, viewOf(prev, cur.start), false, tagOf(prev)) // switch start (keep the previous view)
    if (cur.shot.track) {
      // Follow a landmark: connect keyframes every 0.4 s at constant speed
      for (let t = cur.start + T; t < end - 0.2; t += 0.4) add(t, cur.shot.track(t), true)
    } else add(cur.start + T, cur.shot.view, false, tagOf(cur)) // switch complete
  }
  add(t1, viewOf(runs[runs.length - 1], t1), false, tagOf(runs[runs.length - 1]))
  // Keep existing keyframes outside the range. The outer boundary of the range connects from the existing view to the generated view
  const outside = existing.filter((k) => k.t < t0 - 0.01 || k.t > t1 + 0.01)
  const before = existing.length ? viewAt(existing, t0) : null
  const merged = [...outside, ...keys].sort((a, b) => a.t - b.t)
  if (before && outside.some((k) => k.t < t0)) {
    // Right before the range keep the original view, then go to the generated view at the start of the range
    merged.splice(merged.findIndex((k) => k.t >= t0 - 0.01), 0, { t: Math.max(0, t0 - 0.02), ...before })
  }
  return { keyframes: merged, shots: runs }
}
