// Drawing captions and place labels on the overlay canvas, in the look of the cyber gauges (render/hud.ts). See core/annotations.ts for what
// they are. All captions share one place: the "Captions" overlay layer, moved and sized on the screen like any overlay.
import { captionAlpha, labelAt, type Caption, type PlaceLabel } from '../core/annotations'
import type { Mat3 } from '../core/quat'
import type { CyberPal } from './cyber'
import type { PixelRect } from './gl-reframe'
import { hudCaption, hudLabel } from './hud'
import { focalFor, projectPoint, wideK } from './projection'

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Whether any caption is shown at time t */
export const captionsAt = (cs: Caption[], t: number): boolean => cs.some((c) => captionAlpha(c, t) > 0 && c.text.trim())

/** The caption shown at time t in rectangle r (when two overlap, the one that started last) */
export function drawCaptions(g: Ctx, cs: Caption[], t: number, r: PixelRect, P: CyberPal): void {
  let shown: Caption | null = null
  for (const c of cs) if (c.text.trim() && captionAlpha(c, t) > 0 && (!shown || c.t > shown.t)) shown = c
  if (shown) hudCaption(g, shown.text, r, captionAlpha(shown, t), P)
}

/** Whether any label of the view is shown at time t */
export const labelsAt = (ls: PlaceLabel[], layerId: string, t: number): boolean => ls.some((l) => l.layerId === layerId && l.text.trim() && labelAt(l, t))

/**
 * Labels of one view at time t. view: output camera -> rig (row-major) and fov of that view, drawn into rectangle r.
 * above: rectangles of views drawn on top of this one (labels do not show through them)
 */
export function drawPlaceLabels(g: Ctx, ls: PlaceLabel[], layerId: string, t: number, r: PixelRect, view: Mat3, fov: number, above: PixelRect[], P: CyberPal): void {
  const focal = focalFor(r.w, fov)
  const k = wideK(fov)
  const V = view
  const fs = Math.max(10, Math.min(r.w, r.h) * 0.036)
  g.save()
  g.beginPath()
  g.rect(r.x, r.y, r.w, r.h)
  for (const a of above) g.rect(a.x, a.y, a.w, a.h)
  g.clip('evenodd')
  for (const l of ls) {
    if (l.layerId !== layerId || !l.text.trim()) continue
    const at = labelAt(l, t)
    if (!at) continue
    const d = at.dir
    const c = [V[0] * d[0] + V[3] * d[1] + V[6] * d[2], V[1] * d[0] + V[4] * d[1] + V[7] * d[2], V[2] * d[0] + V[5] * d[1] + V[8] * d[2]]
    const p = projectPoint(c, focal, k)
    if (!p) continue
    const x = r.x + r.w / 2 + p[0]
    const y = r.y + r.h / 2 + p[1]
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue
    hudLabel(g, l.text, x, y, fs, at.alpha, r, P)
  }
  g.restore()
}
