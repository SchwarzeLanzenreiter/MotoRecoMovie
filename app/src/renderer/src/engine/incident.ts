// When a body disturbance occurs, automatically split into 2 screens and show the own bike.
//
//   Only in the section around a disturbance event (core/disturb.ts) with margins added, shrink the full-screen view (main) to half
//   and slide a view layer of the "own bike" (role = 'incident'; facing back, horizon-locked) into the freed half.
//   The switch moves smoothly over transition seconds. Export and preview use the same calculation.
import { disturbEvents, type DisturbCause, type DisturbTrack } from '../core/disturb'
import type { Rect } from './project'

export interface IncidentSettings {
  on: boolean
  /** Disturbance strength threshold (1.0 = the top 0.5% of that ride). Smaller is more sensitive */
  threshold: number
  /** lr = front on the left and own bike on the right, rl = own bike on the left and front on the right, tb = front on top and own bike on the bottom */
  layout: 'lr' | 'rl' | 'tb'
  /** Margin added before and after a disturbance [s] */
  pre: number
  post: number
  /** Shortest duration to switch to 2 screens [s] */
  minDur: number
  /** Time taken to switch [s] */
  transition: number
  /** Events not to switch to 2 screens for (the time of the strongest moment, rounded to 0.1 s) */
  skip: number[]
  /** Show the "disturbance" indicator on the own-bike screen */
  label: boolean
}

export const DEFAULT_INCIDENT: IncidentSettings = { on: false, threshold: 1.5, layout: 'lr', pre: 1.0, post: 2.5, minDur: 4, transition: 0.4, skip: [], label: true }

export function mergeIncident(saved: Partial<IncidentSettings> | undefined): IncidentSettings {
  return { ...DEFAULT_INCIDENT, ...saved, skip: saved?.skip ?? [] }
}

/** View of the own bike (facing back, wide angle, horizon-locked: the body lean and shake are visible as they are) */
export const RIDER_VIEW = { yaw: 180, pitch: 5, fov: 165, leanRatio: 0 }
/** Previous FOV of the own bike (keyframes still at this value get the new FOV when opened) */
export const OLD_RIDER_FOV = 120

export interface IncidentEvent {
  /** Range to switch to 2 screens [s] (including margins) */
  start: number
  end: number
  /** Time of the strongest moment, strength, and metric */
  peak: number
  score: number
  cause: DisturbCause
}

export const roundPeak = (t: number): number => Math.round(t * 10) / 10

/** Build the 2-screen sections from the disturbance events (merge overlapping or close ones; excluded ones are left out) */
export function incidentEvents(d: DisturbTrack, s: IncidentSettings, duration: number): IncidentEvent[] {
  const out: IncidentEvent[] = []
  const skip = new Set(s.skip.map(roundPeak))
  for (const e of disturbEvents(d, s.threshold)) {
    if (skip.has(roundPeak(e.peak))) continue
    let start = Math.max(0, e.start - s.pre)
    let end = Math.min(duration, e.end + s.post)
    if (end - start < s.minDur) {
      const c = (start + end) / 2
      start = Math.max(0, c - s.minDur / 2)
      end = Math.min(duration, start + s.minDur)
    }
    const prev = out[out.length - 1]
    // Switching would not settle, so join the ones with a short gap
    if (prev && start - prev.end < s.transition * 2 + 1) {
      prev.end = Math.max(prev.end, end)
      if (e.score > prev.score) Object.assign(prev, { peak: e.peak, score: e.score, cause: e.cause })
    } else out.push({ start, end, peak: e.peak, score: e.score, cause: e.cause })
  }
  return out
}

const ease = (x: number): number => x * x * (3 - 2 * x)
const lerp = (a: Rect, b: Rect, w: number): Rect => ({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, w: a.w + (b.w - a.w) * w, h: a.h + (b.h - a.h) * w })

/**
 * Split degree w at time t (0 = full screen, 1 = 2 screens), and the rectangles of main and own bike.
 * The own-bike screen slides in from outside
 */
export function incidentLayout(events: IncidentEvent[], s: IncidentSettings, t: number): { w: number; main: Rect; rider: Rect; event: IncidentEvent | null } {
  let w = 0
  let event: IncidentEvent | null = null
  for (const e of events) {
    if (t < e.start || t > e.end) continue
    const x = Math.min((t - e.start) / s.transition, (e.end - t) / s.transition, 1)
    if (x > w) {
      w = x
      event = e
    }
  }
  w = ease(Math.max(0, Math.min(1, w)))
  const full: Rect = { x: 0, y: 0, w: 1, h: 1 }
  let mainT: Rect
  let riderT: Rect
  let riderFrom: Rect
  if (s.layout === 'tb') {
    mainT = { x: 0, y: 0, w: 1, h: 0.5 }
    riderT = { x: 0, y: 0.5, w: 1, h: 0.5 }
    riderFrom = { x: 0, y: 1, w: 1, h: 0.5 }
  } else if (s.layout === 'rl') {
    mainT = { x: 0.5, y: 0, w: 0.5, h: 1 }
    riderT = { x: 0, y: 0, w: 0.5, h: 1 }
    riderFrom = { x: -0.5, y: 0, w: 0.5, h: 1 }
  } else {
    mainT = { x: 0, y: 0, w: 0.5, h: 1 }
    riderT = { x: 0.5, y: 0, w: 0.5, h: 1 }
    riderFrom = { x: 1, y: 0, w: 0.5, h: 1 }
  }
  return { w, main: w >= 1 ? mainT : lerp(full, mainT, w), rider: w >= 1 ? riderT : lerp(riderFrom, riderT, w), event }
}
