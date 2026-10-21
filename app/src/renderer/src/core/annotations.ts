// Text added by hand to the video: captions shown over the whole frame for a while, and place labels that point at something in a view
// (a crossing, a building, a mountain) with a leader line and follow it until it leaves the view. A label's point is followed in the
// video (engine/tracker.ts): its direction on the sphere around the camera (rig coordinates) is stored every few frames.

/** A caption shown from t for dur seconds. All captions are shown in the same place: the "Captions" overlay layer */
export interface Caption {
  id: string
  /** Start [s, video time] */
  t: number
  /** How long it is shown [s] */
  dur: number
  text: string
}

/** A label pointing at a place in one view */
export interface PlaceLabel {
  id: string
  text: string
  /** View layer it was placed in (it is drawn there, and followed until the point leaves that view) */
  layerId: string
  /** Time it was placed [s] */
  t: number
  /** Direction of the point at t (rig coordinates, unit vector) */
  dir: [number, number, number]
  /**
   * The point followed in the video: directions (rig coordinates, x y z per sample, rounded) from t every step seconds.
   * Absent until it has been followed; the label is drawn while the samples last
   */
  track?: { step: number; dirs: number[]; end: 'left' | 'lost' | 'limit' }
}

export const CAPTION_DUR = 4
/**
 * Fade in and out of captions and labels [s]. They fade in just before their time, so they are fully there at the time they were placed
 * (placed while paused, they show at once)
 */
export const FADE = 0.3

/** Opacity of a caption at time t (0 = not shown) */
export function captionAlpha(c: Caption, t: number): number {
  if (t < c.t - FADE || t > c.t + c.dur) return 0
  return Math.max(0, Math.min(1, (t - c.t + FADE) / FADE, (c.t + c.dur - t) / FADE))
}

/** Time the label's samples end [s] (the label's own time when it has not been followed yet) */
export function labelEnd(l: PlaceLabel): number {
  return l.track ? l.t + (l.track.dirs.length / 3 - 1) * l.track.step : l.t
}

/** Direction of the label's point at time t and its opacity, or null when it is not shown */
export function labelAt(l: PlaceLabel, t: number): { dir: [number, number, number]; alpha: number } | null {
  const tr = l.track
  if (!tr || t < l.t - FADE) return null
  const n = tr.dirs.length / 3
  const x = Math.max(0, (t - l.t) / tr.step)
  if (x > n - 1 || n < 2) return null
  const i = Math.min(n - 2, Math.floor(x))
  const f = x - i
  const d = [0, 1, 2].map((k) => tr.dirs[i * 3 + k] * (1 - f) + tr.dirs[(i + 1) * 3 + k] * f)
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  const end = labelEnd(l)
  return { dir: [d[0] / len, d[1] / len, d[2] / len], alpha: Math.max(0, Math.min(1, (t - l.t + FADE) / FADE, (end - t) / FADE)) }
}

/** The label's samples before the step time t falls in (to follow it again from a corrected point: the new samples start at that step) */
export function trackBefore(l: PlaceLabel, t: number): number[] {
  if (!l.track || t <= l.t) return []
  const n = Math.min(l.track.dirs.length / 3, Math.floor((t - l.t) / l.track.step + 1e-6))
  return l.track.dirs.slice(0, n * 3)
}
