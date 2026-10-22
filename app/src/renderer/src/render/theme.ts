// Design themes: one look for everything drawn over the video (meter, corner signs, captions, place labels, opening title, map,
// elevation profile, compass), switched for the whole project at once (Project.theme). Each motorcycle maker has a theme in its colors
// and style (render/themes/), most with an emblem in the spirit of the maker's mark in the middle of the meter (render/themes/emblems.ts;
// simple vector shapes, not the makers' artwork). The user can replace the emblem with an image of their own (render/logo.ts).
import type { Ctx } from './meters'

export type ThemeId = 'bmw' | 'ducati' | 'honda' | 'kawasaki' | 'ktm' | 'suzuki' | 'triumph' | 'yamaha' | 'wafu' | 'ainu'

export interface ThemePal {
  line: string // main line color (lit tachometer, frames, leader lines)
  line2: string // second color (high-RPM side)
  hot: string // red zone, brake, MAX, tight corners
  thr: string // throttle
  lean: string // lean bar
  bg0: string // glass (center / top)
  bg1: string // glass (edge / bottom)
  dim: string // unlit segments, faint outlines
  text: string
  sub: string // small headings
  /** Colors of the maker's motif on the meter face (the theme's own use) */
  brand: string[]
  /** Small stripes in the maker's colors under captions, the title and the meter; null = none */
  stripes: string[] | null
}

/**
 * Outline of the glass panels behind captions, labels and signs. wafu: notched corners with a gold rule; ainu: rounded, edged with
 * thorns and swirls
 */
export type PanelShape = 'chamfer' | 'round' | 'slant' | 'tab' | 'classic' | 'wafu' | 'ainu'

export interface ThemeLook {
  /** Latin font family (Japanese falls back to Yu Gothic) */
  font: string
  weight: number
  italic: boolean
  /** Glow of lines and text (0 = none, 1 = neon) */
  glow: number
  /** Scan lines on the glass */
  scan: boolean
  panel: PanelShape
  /** Tachometer: lit blocks, a solid bar, or a pointer on a thin scale like an analog gauge */
  tach: 'blocks' | 'bar' | 'needle'
  /** Gear and air temperature sub-dials */
  sub: 'hex' | 'circle' | 'round' | 'slant'
}

export interface Theme {
  id: ThemeId
  /** Name in the UI (a maker's name as is; other names are translated) */
  name: string
  pal: ThemePal
  look: ThemeLook
  /** Meter face behind the scales: the maker's motif (center cx, cy, radius R). grey (0 to 1) = how grey the image of a user's logo is while the engine is stopped */
  face(g: Ctx, cx: number, cy: number, R: number, P: ThemePal, look: ThemeLook, grey: number): void
}

export const TAU = Math.PI * 2
export const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))

/** Font for canvas: the theme's Latin family, then Japanese fallbacks */
export function themeFont(look: ThemeLook, px: number, weight = look.weight, italic = look.italic): string {
  return `${italic ? 'italic ' : ''}${weight} ${Math.max(1, px).toFixed(1)}px ${look.font}, 'Yu Gothic UI', 'Meiryo UI', sans-serif`
}

// ---- Grey while the engine is stopped (the palette moved toward a grey that keeps its brightness) ----

function parseColor(c: string): [number, number, number, number] | null {
  const h = /^#([0-9a-f]{6})$/i.exec(c)
  if (h) {
    const n = parseInt(h[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(c)
  if (!m) return null
  const p = m[1].split(',').map((x) => parseFloat(x))
  return [p[0], p[1], p[2], p[3] ?? 1]
}

/** Moves color c toward grey by k (0 to 1). The grey keeps the brightness (luminance) and is slightly darker */
export function toGrey(c: string, k: number): string {
  const p = parseColor(c)
  if (!p) return c
  const l = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) * 0.85
  const mix = (v: number): number => Math.round(v + (l - v) * k)
  return `rgba(${mix(p[0])},${mix(p[1])},${mix(p[2])},${p[3]})`
}

/** The palette moved toward grey by k */
export function greyPal(P: ThemePal, k: number): ThemePal {
  const out = { ...P } as Record<string, unknown>
  for (const [key, v] of Object.entries(P)) {
    if (typeof v === 'string') out[key] = toGrey(v, k)
    else if (Array.isArray(v)) out[key] = v.map((c: string) => toGrey(c, k))
  }
  return out as unknown as ThemePal
}

/** Color of the outside air temperature [deg C]: light blue at 5 or below, yellow at 30 or above, orange at 35, red at 40, otherwise `normal` */
export function airTempColor(t: number | undefined, normal = '#ffffff'): string {
  if (t === undefined || !Number.isFinite(t)) return normal
  if (t >= 40) return '#ff3b30'
  if (t >= 35) return '#ff9500'
  if (t >= 30) return '#ffd60a'
  if (t <= 5) return '#7fd6ff'
  return normal
}

/** Corner sign color by radius: tight = hot, medium = amber, gentle = the main line color */
export function cornerColor(P: ThemePal, radius: number): string {
  return radius < 60 ? P.hot : radius < 120 ? '#ffb000' : P.line
}

// ---- Shapes shared by the themes ----

/** Outline path of a panel of the given shape (c = size of corner cuts and radii) */
export function panelPath(g: Ctx, shape: PanelShape, x: number, y: number, w: number, h: number, c: number): void {
  g.beginPath()
  switch (shape) {
    case 'chamfer':
      g.moveTo(x + c, y)
      g.lineTo(x + w, y)
      g.lineTo(x + w, y + h - c)
      g.lineTo(x + w - c, y + h)
      g.lineTo(x, y + h)
      g.lineTo(x, y + c)
      break
    case 'slant': {
      const s = Math.min(h * 0.3, w * 0.1)
      g.moveTo(x + s, y)
      g.lineTo(x + w, y)
      g.lineTo(x + w - s, y + h)
      g.lineTo(x, y + h)
      break
    }
    case 'wafu':
      // Corners notched inward by a small square
      g.moveTo(x + c, y)
      g.lineTo(x + w - c, y)
      g.lineTo(x + w - c, y + c)
      g.lineTo(x + w, y + c)
      g.lineTo(x + w, y + h - c)
      g.lineTo(x + w - c, y + h - c)
      g.lineTo(x + w - c, y + h)
      g.lineTo(x + c, y + h)
      g.lineTo(x + c, y + h - c)
      g.lineTo(x, y + h - c)
      g.lineTo(x, y + c)
      g.lineTo(x + c, y + c)
      break
    case 'round':
    case 'tab':
    case 'classic':
    case 'ainu':
      g.roundRect(x, y, w, h, Math.min(c, h / 2))
      break
  }
  g.closePath()
}

/** Corner size of panels for unit u (about the font size) */
export const panelCorner = (shape: PanelShape, u: number, h: number): number =>
  shape === 'chamfer' ? Math.min(h * 0.35, u * 0.6) : shape === 'classic' || shape === 'wafu' ? Math.min(h * 0.2, u * 0.3) : Math.min(h * 0.3, u * 0.45)

/**
 * Glass panel in the theme's style: dark gradient, scan lines (if the theme has them), outline, and the theme's decoration
 * (glowing brackets for chamfer, a colored bar on the left for tab, a double rule for classic, a top edge for the others).
 * u = unit size (about the font size); stripes: draw the maker's stripes at the bottom left
 */
export function drawPanel(g: Ctx, T: Theme, P: ThemePal, x: number, y: number, w: number, h: number, u: number, stripes = true, edge = P.line): void {
  const L = T.look
  const c = panelCorner(L.panel, u, h)
  const bg = g.createLinearGradient(x, y, x, y + h)
  bg.addColorStop(0, P.bg0)
  bg.addColorStop(1, P.bg1)
  panelPath(g, L.panel, x, y, w, h, c)
  g.fillStyle = bg
  g.fill()
  if (L.scan) {
    g.save()
    panelPath(g, L.panel, x, y, w, h, c)
    g.clip()
    g.fillStyle = 'rgba(255,255,255,0.035)'
    const sl = Math.max(2, u * 0.12)
    for (let yy = y; yy < y + h; yy += sl) g.fillRect(x, yy, w, sl * 0.3)
    g.restore()
  }
  const ruled = L.panel === 'classic' || L.panel === 'wafu' || L.panel === 'ainu'
  panelPath(g, L.panel, x, y, w, h, c)
  g.strokeStyle = ruled ? edge : P.dim
  g.lineWidth = Math.max(1, u * (ruled ? 0.05 : 0.04))
  g.stroke()
  g.save()
  g.strokeStyle = edge
  g.fillStyle = edge
  g.lineWidth = Math.max(1.5, u * 0.07)
  if (L.glow > 0) {
    g.shadowColor = edge
    g.shadowBlur = Math.min(18, u * 0.5 * L.glow)
  }
  g.lineCap = 'square'
  switch (L.panel) {
    case 'chamfer': {
      // Brackets along the cut corners
      const b = Math.min(w, h) * 0.45
      g.beginPath()
      g.moveTo(x, y + c + b)
      g.lineTo(x, y + c)
      g.lineTo(x + c, y)
      g.lineTo(x + c + b, y)
      g.moveTo(x + w, y + h - c - b)
      g.lineTo(x + w, y + h - c)
      g.lineTo(x + w - c, y + h)
      g.lineTo(x + w - c - b, y + h)
      g.stroke()
      break
    }
    case 'tab': {
      // Colored bar down the left side, inside the rounded corners
      g.save()
      panelPath(g, L.panel, x, y, w, h, c)
      g.clip()
      g.fillRect(x, y, Math.max(2, u * 0.22), h)
      g.restore()
      break
    }
    case 'classic':
    case 'wafu': {
      // A second thin rule just inside the outline
      const i = Math.max(2, u * 0.16)
      g.lineWidth = Math.max(1, u * 0.03)
      panelPath(g, L.panel, x + i, y + i, w - i * 2, h - i * 2, Math.max(0, c - i * 0.5))
      g.stroke()
      break
    }
    case 'ainu': {
      // Thorns along the top and bottom edges (pointing out), and a swirl at each end, in white over red
      const t = Math.max(3, u * 0.32)
      const n = Math.max(2, Math.floor((w - c * 2) / (t * 2.4)))
      const step = (w - c * 2) / n
      for (const [col, k] of [
        [P.hot, 1.6],
        [edge, 1]
      ] as [string, number][]) {
        g.fillStyle = col
        for (let j = 0; j < n; j++) {
          const tx = x + c + step * (j + 0.5)
          for (const [yy, d] of [
            [y, -1],
            [y + h, 1]
          ]) {
            g.beginPath()
            g.moveTo(tx - t * 0.3 * k, yy)
            g.lineTo(tx, yy + d * t * 0.75 * k)
            g.lineTo(tx + t * 0.3 * k, yy)
            g.closePath()
            g.fill()
          }
        }
        g.strokeStyle = col
        g.lineWidth = Math.max(1, u * 0.05 * k)
        // Small enough to stay in the padding before the text (also on the small tags of place labels)
        for (const [sx, dir] of [
          [x + c * 0.75, 1],
          [x + w - c * 0.75, -1]
        ]) {
          g.beginPath()
          for (let k2 = 0; k2 <= 30; k2++) {
            const f = k2 / 30
            const a = -Math.PI / 2 + dir * f * TAU * 1.3
            const rr = Math.min(h * 0.28, u * 0.38) * (1 - f * 0.85)
            const px = sx + Math.cos(a) * rr
            const py = y + h / 2 + Math.sin(a) * rr
            if (k2) g.lineTo(px, py)
            else g.moveTo(px, py)
          }
          g.stroke()
        }
      }
      break
    }
    case 'slant': {
      // Thick edge along the top
      const s = Math.min(h * 0.3, w * 0.1)
      g.beginPath()
      g.moveTo(x + s, y)
      g.lineTo(x + s + w * 0.45, y)
      g.stroke()
      g.beginPath()
      g.moveTo(x + w - s, y + h)
      g.lineTo(x + w - s - w * 0.2, y + h)
      g.stroke()
      break
    }
    case 'round': {
      // A short edge at the top left
      g.beginPath()
      g.moveTo(x + c, y)
      g.lineTo(x + c + Math.min(w * 0.3, u * 3), y)
      g.stroke()
      break
    }
  }
  g.restore()
  if (stripes && P.stripes) drawStripes(g, P.stripes, x + c * 0.6 + (L.panel === 'tab' ? u * 0.3 : 0), y + h - Math.max(1.5, u * 0.08) * 2.2, u * 0.9, Math.max(1.5, u * 0.08), L.panel === 'slant' || L.italic)
}

/** The maker's stripes side by side from (x, y): each sw wide and sh high, slanted if asked */
export function drawStripes(g: Ctx, cols: string[], x: number, y: number, sw: number, sh: number, slant = false): void {
  cols.forEach((col, k) => {
    g.save()
    g.fillStyle = col
    g.translate(x + k * sw * 1.15, y)
    if (slant) g.transform(1, 0, -0.5, 1, 0, 0)
    g.fillRect(0, 0, sw, sh)
    g.restore()
  })
}

/** Polished metal ring between radii r0 and r1 (chrome bezel) */
export function metalRing(g: Ctx, cx: number, cy: number, r0: number, r1: number, light = '#e8ebef', dark = '#5a5f68'): void {
  const gr = g.createLinearGradient(cx - r1, cy - r1, cx + r1, cy + r1)
  gr.addColorStop(0, light)
  gr.addColorStop(0.35, dark)
  gr.addColorStop(0.6, light)
  gr.addColorStop(1, dark)
  g.beginPath()
  g.arc(cx, cy, r1, 0, TAU)
  g.arc(cx, cy, r0, 0, TAU, true)
  g.fillStyle = gr
  g.fill()
}

/** Dark glass disc of radius r (radial gradient of the palette) with scan lines if the look has them */
export function glassDisc(g: Ctx, cx: number, cy: number, r: number, P: ThemePal, look: ThemeLook): void {
  const face = g.createRadialGradient(cx, cy - r * 0.25, r * 0.05, cx, cy, r)
  face.addColorStop(0, P.bg0)
  face.addColorStop(1, P.bg1)
  g.beginPath()
  g.arc(cx, cy, r, 0, TAU)
  g.fillStyle = face
  g.fill()
  if (look.scan) {
    g.save()
    g.beginPath()
    g.arc(cx, cy, r, 0, TAU)
    g.clip()
    g.fillStyle = 'rgba(255,255,255,0.03)'
    const sl = Math.max(2, r * 0.026)
    for (let y = cy - r; y < cy + r; y += sl) g.fillRect(cx - r, y, r * 2, sl * 0.3)
    g.restore()
  }
}

/** Ring stroke of radius r from angle a0 to a1 */
export function arcStroke(g: Ctx, cx: number, cy: number, r: number, a0: number, a1: number, w: number, col: string): void {
  if (Math.abs(a1 - a0) < 1e-4) return
  g.strokeStyle = col
  g.lineWidth = w
  g.beginPath()
  g.arc(cx, cy, r, Math.min(a0, a1), Math.max(a0, a1))
  g.stroke()
}

/** Filled annular sector between radii r0 < r1 from angle a0 to a1 */
export function sector(g: Ctx, cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, fill: string | CanvasGradient): void {
  g.beginPath()
  g.arc(cx, cy, r1, a0, a1)
  g.arc(cx, cy, r0, a1, a0, true)
  g.closePath()
  g.fillStyle = fill
  g.fill()
}
