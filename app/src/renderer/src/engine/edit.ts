// Project editing operations (keyframes are per view layer)
import { newId, newViewLayer, viewAt, type Keyframe, type Layer, type OverlayLayer, type Project, type Rect, type ViewLayer, type WidgetKind } from './project'

export type ViewPatch = Partial<Omit<Keyframe, 't'>>

/** Time difference at which two keyframes are considered the same [s] (less than 1 frame) */
const SAME = 0.01

/**
 * Index of the keyframe at time t (the time of the frame currently displayed) (-1 if none). The nearest one within tol.
 * On screen, tol is 0.6 times the frame interval (keyTolerance). The time of an auto-generated keyframe is not on a frame boundary
 * (e.g. at 50 fps, 32.55 s = frame 1627.5), so with 0.01 s the keyframe was not found even while on its frame, and it could be neither deleted nor edited
 */
export function keyIndex(keys: Keyframe[], t: number, tol = SAME): number {
  let best = -1
  let bd = tol
  keys.forEach((k, i) => {
    const d = Math.abs(k.t - t)
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best
}

/** Time difference regarded as "the keyframe of this frame" in UI operations [s]: 0.6 times the frame interval (does not overlap with the keyframe of an adjacent frame) */
export function keyTolerance(fps: number): number {
  return 0.6 / fps
}

function mapView(p: Project, layerId: string, f: (l: ViewLayer) => ViewLayer): Project {
  return { ...p, layers: p.layers.map((l) => (l.id === layerId && l.type === 'view' ? f(l) : l)) }
}

/**
 * Change the view of a view layer. If there is only one keyframe, change it directly (= the view of the whole layer),
 * and if there are two or more, change the keyframe at the current time (adding one made from the interpolated value if none).
 */
export function editView(p: Project, layerId: string, t: number, patch: ViewPatch | ((cur: Omit<Keyframe, 't'>) => ViewPatch), tol = SAME): Project {
  return mapView(p, layerId, (l) => {
    const keys = l.keyframes.map((k) => ({ ...k }))
    let idx = keys.length === 1 ? 0 : keyIndex(keys, t, tol)
    if (idx < 0) {
      keys.push({ t, ...viewAt(l.keyframes, t) })
      idx = keys.length - 1
    }
    const cur = keys[idx]
    const d = typeof patch === 'function' ? patch(cur) : patch
    keys[idx] = { ...cur, ...d, t: cur.t }
    keys.sort((a, b) => a.t - b.t)
    return { ...l, keyframes: keys }
  })
}

export function addKey(p: Project, layerId: string, t: number, tol = SAME): Project {
  return mapView(p, layerId, (l) => {
    if (keyIndex(l.keyframes, t, tol) >= 0) return l
    return { ...l, keyframes: [...l.keyframes, { t, ...viewAt(l.keyframes, t) }].sort((a, b) => a.t - b.t) }
  })
}

export function removeKey(p: Project, layerId: string, t: number, tol = SAME): Project {
  return mapView(p, layerId, (l) => {
    const i = keyIndex(l.keyframes, t, tol)
    if (i < 0 || l.keyframes.length <= 1) return l
    return { ...l, keyframes: l.keyframes.filter((_, k) => k !== i) }
  })
}

// ---- Layers ----

export function updateLayer(p: Project, id: string, patch: Partial<Layer>): Project {
  return { ...p, layers: p.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) }
}

export function addViewLayer(p: Project, name: string, rect: Rect, t: number, from?: ViewLayer): Project {
  const l = newViewLayer(name, rect, from ? viewAt(from.keyframes, t) : undefined)
  return { ...p, layers: [...p.layers, l] }
}

export function addOverlayLayer(p: Project, widget: WidgetKind, name: string, rect: Rect, props: Record<string, unknown> = {}): Project {
  const l: OverlayLayer = { id: newId(), type: 'overlay', name, rect: { ...rect }, visible: true, widget, props }
  return { ...p, layers: [...p.layers, l] }
}

export function removeLayer(p: Project, id: string): Project {
  // Keep at least one view layer
  const target = p.layers.find((l) => l.id === id)
  if (!target) return p
  if (target.type === 'view' && p.layers.filter((l) => l.type === 'view').length <= 1) return p
  return { ...p, layers: p.layers.filter((l) => l.id !== id) }
}

/** Reorder the draw order (dir = +1 moves it to the front) */
export function moveLayer(p: Project, id: string, dir: 1 | -1): Project {
  const i = p.layers.findIndex((l) => l.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= p.layers.length) return p
  const layers = [...p.layers]
  ;[layers[i], layers[j]] = [layers[j], layers[i]]
  return { ...p, layers }
}
