// Split screen: layout templates, and the calculation of moving and resizing (with snapping) on the preview.
import { t } from '../i18n'
import { newViewLayer, viewAt, type Keyframe, type Project, type Rect, type ViewLayer } from './project'

export interface LayoutTemplate {
  id: string
  name: string
  rects: Rect[]
}

/** Templates. Coordinates are fractions of the output, so they work for both landscape and portrait outputs */
export const TEMPLATES: LayoutTemplate[] = [
  { id: 'full', name: 'Full screen', rects: [{ x: 0, y: 0, w: 1, h: 1 }] }, // i18n-ignore
  { id: 'pip', name: 'Picture-in-picture', rects: [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0.66, y: 0.04, w: 0.3, h: 0.3 }] }, // i18n-ignore
  {
    id: 'lr',
    name: 'Split left/right', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 }
    ]
  },
  {
    id: 'tb',
    name: 'Split top/bottom', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 }
    ]
  },
  {
    id: 'main2',
    name: '1 large + 2 small', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 2 / 3, h: 1 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 }
    ]
  },
  {
    id: 'tb3',
    name: 'Split into 3 rows', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 1, h: 1 / 3 },
      { x: 0, y: 1 / 3, w: 1, h: 1 / 3 },
      { x: 0, y: 2 / 3, w: 1, h: 1 / 3 }
    ]
  },
  {
    id: 'grid4',
    name: 'Split into 4', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    ]
  }
]

/** Initial direction when a template adds views (2nd onward: back, left, right) */
const SLOT_VIEWS: Partial<Omit<Keyframe, 't'>>[] = [{}, { yaw: 180, fov: 90 }, { yaw: -90, fov: 90 }, { yaw: 90, fov: 90 }]
const SLOT_NAMES = ['Main', 'Back', 'Left', 'Right'] // i18n-ignore

export const DEFAULT_BORDER = { width: 0.004, color: '#ffffff' }

/**
 * Apply a template. Assigns the existing view layers in order, adds more if short,
 * and hides surplus views so their keyframes are not lost. Overlay layers are left as they are.
 */
export function applyTemplate(p: Project, templateId: string, time: number): Project {
  const tpl = TEMPLATES.find((x) => x.id === templateId)
  if (!tpl) return p
  const views = p.layers.filter((l): l is ViewLayer => l.type === 'view' && !l.role)
  const layers = [...p.layers]
  const split = tpl.rects.length > 1
  tpl.rects.forEach((rect, k) => {
    // Do not add a border to a screen covering the whole frame (only to small windows and split screens)
    const covers = rect.w >= 0.999 && rect.h >= 0.999
    const border = split && !covers ? { ...DEFAULT_BORDER } : undefined
    if (k < views.length) {
      const i = layers.findIndex((l) => l.id === views[k].id)
      layers[i] = { ...views[k], rect: { ...rect }, visible: true, border }
    } else {
      const base = views[0] ? viewAt(views[0].keyframes, time) : undefined
      const nl = newViewLayer(SLOT_NAMES[k] !== undefined ? t(SLOT_NAMES[k]) : t('View {n}', { n: k + 1 }), rect, base ? { ...base, ...SLOT_VIEWS[k] } : undefined)
      nl.border = border
      // Place views behind overlays (insert right after the last view layer)
      const lastView = layers.reduce((acc, l, i) => (l.type === 'view' ? i : acc), -1)
      layers.splice(lastView + 1, 0, nl)
    }
  })
  for (const v of views.slice(tpl.rects.length)) {
    const i = layers.findIndex((l) => l.id === v.id)
    layers[i] = { ...v, visible: false }
  }
  return { ...p, layers }
}

// ---- Move / resize ----

/** Drag kind: move, or resize by an edge or corner (a combination of n/s/e/w) */
export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN = 0.05 // minimum width / height (fraction of the output)

/**
 * Snap candidates: screen edges, 1/3, center, 2/3, and the edges of other layers.
 * tol is the snap distance (fraction). Specified separately for x and y (the pixel counts differ between width and height).
 */
export function snapTargets(others: Rect[]): { xs: number[]; ys: number[] } {
  const base = [0, 1 / 3, 0.5, 2 / 3, 1]
  const xs = [...base]
  const ys = [...base]
  for (const r of others) {
    xs.push(r.x, r.x + r.w)
    ys.push(r.y, r.y + r.h)
  }
  return { xs, ys }
}

function snap1(v: number, cands: number[], tol: number): number {
  let best = v
  let d = tol
  for (const c of cands) {
    if (Math.abs(c - v) < d) {
      d = Math.abs(c - v)
      best = c
    }
  }
  return best
}

/**
 * Returns the rectangle obtained by dragging the starting rectangle r0 by (dx, dy) (fractions) with handle h.
 * A move snaps if either edge is near a candidate; a resize snaps only the edge being moved.
 */
export function dragRect(r0: Rect, h: Handle, dx: number, dy: number, targets: { xs: number[]; ys: number[] }, tolX: number, tolY: number): Rect {
  let { x, y, w, h: hh } = r0
  if (h === 'move') {
    x = r0.x + dx
    y = r0.y + dy
    // Snap with whichever of the left and right edges is nearer
    const sl = snap1(x, targets.xs, tolX)
    const sr = snap1(x + w, targets.xs, tolX)
    if (sl !== x && (sr === x + w || Math.abs(sl - x) <= Math.abs(sr - (x + w)))) x = sl
    else if (sr !== x + w) x = sr - w
    const st = snap1(y, targets.ys, tolY)
    const sb = snap1(y + hh, targets.ys, tolY)
    if (st !== y && (sb === y + hh || Math.abs(st - y) <= Math.abs(sb - (y + hh)))) y = st
    else if (sb !== y + hh) y = sb - hh
    x = Math.min(Math.max(x, -w + MIN), 1 - MIN)
    y = Math.min(Math.max(y, -hh + MIN), 1 - MIN)
    return { x, y, w, h: hh }
  }
  let left = r0.x
  let right = r0.x + r0.w
  let top = r0.y
  let bottom = r0.y + r0.h
  if (h.includes('w')) left = Math.min(snap1(r0.x + dx, targets.xs, tolX), right - MIN)
  if (h.includes('e')) right = Math.max(snap1(r0.x + r0.w + dx, targets.xs, tolX), left + MIN)
  if (h.includes('n')) top = Math.min(snap1(r0.y + dy, targets.ys, tolY), bottom - MIN)
  if (h.includes('s')) bottom = Math.max(snap1(r0.y + r0.h + dy, targets.ys, tolY), top + MIN)
  x = left
  y = top
  w = right - left
  hh = bottom - top
  return { x, y, w, h: hh }
}

export function isFull(r: Rect): boolean {
  return r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999
}
