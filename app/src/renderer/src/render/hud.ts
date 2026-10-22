// Text in the project's design theme (render/theme.ts): glass panels in the theme's shape, its colors, type and glow. Used for
// captions, place labels and the opening title.
import type { Project } from '../engine/project'
import type { PixelRect } from './gl-reframe'
import { drawPanel, drawStripes, themeFont, type Theme, type ThemePal } from './theme'
import { getTheme } from './themes'

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** The project's design theme */
export const themeOf = (p: Project): Theme => getTheme(p.theme)

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))
const ease = (x: number): number => {
  const c = clamp(x, 0, 1)
  return c * c * (3 - 2 * c)
}

function font(g: Ctx, T: Theme, px: number, weight: number, spacing: number): void {
  g.font = themeFont(T.look, px, weight)
  ;(g as CanvasRenderingContext2D).letterSpacing = `${(px * spacing).toFixed(1)}px`
}
const noSpacing = (g: Ctx): void => {
  ;(g as CanvasRenderingContext2D).letterSpacing = '0px'
}

/** Text with the theme's glow (plain when the theme has none) */
function glowText(g: Ctx, T: Theme, s: string, x: number, y: number, col: string, glow: string, blur: number): void {
  if (T.look.glow > 0) {
    g.save()
    g.shadowColor = glow
    g.shadowBlur = blur * T.look.glow
    g.fillStyle = col
    g.fillText(s, x, y)
    g.restore()
  }
  g.fillStyle = col
  g.fillText(s, x, y)
}

/** Captions (several lines) on a glass panel, as large as fits in rectangle r and centered in it */
export function hudCaption(g: Ctx, text: string, r: PixelRect, alpha: number, T: Theme, P: ThemePal = T.pal): void {
  const lines = text.split('\n')
  const n = lines.length
  const W = T.look.weight
  let fs = Math.min(r.h / (n * 1.3 + 0.9), r.h * 0.34)
  font(g, T, fs, W, 0.04)
  const widest = Math.max(...lines.map((s) => g.measureText(s).width))
  const fit = (r.w - fs * 2.4) / Math.max(1, widest)
  if (fit < 1) {
    fs *= fit
    font(g, T, fs, W, 0.04)
  }
  const tw = Math.max(...lines.map((s) => g.measureText(s).width))
  const padX = fs * 1.1
  const lineH = fs * 1.3
  const w = tw + padX * 2
  const h = n * lineH + fs * 0.8
  const x = r.x + (r.w - w) / 2
  const y = r.y + (r.h - h) / 2
  g.save()
  g.globalAlpha = alpha
  drawPanel(g, T, P, x, y, w, h, fs)
  font(g, T, fs, W, 0.04)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  lines.forEach((s, k) => glowText(g, T, s, x + w / 2, y + fs * 0.4 + lineH * (k + 0.5), P.text, P.line, fs * 0.35))
  noSpacing(g)
  g.restore()
}

/** A place label: a ring on the point (x, y), a leader line up (or down) to the side, and the name on a glass tag over a line */
export function hudLabel(g: Ctx, text: string, x: number, y: number, fs: number, alpha: number, r: PixelRect, T: Theme, P: ThemePal = T.pal): void {
  g.save()
  g.globalAlpha = alpha
  font(g, T, fs, T.look.weight, 0.06)
  const lines = text.split('\n')
  const tw = Math.max(...lines.map((s) => g.measureText(s).width))
  const lineH = fs * 1.25
  const pad = fs * 0.45
  const tagH = lines.length * lineH + pad * 0.8
  // Lead to the right, or to the left near the right edge; up, or down near the top edge
  const side = x + fs * 1.6 + tw + pad * 2 > r.x + r.w - fs * 0.5 ? -1 : 1
  const rise = fs * 2.2
  const down = y - rise - tagH < r.y
  const ex = x + side * fs * 1.4
  const ey = down ? y + rise : y - rise
  const x1 = ex + side * (tw + pad * 2)
  // Glass tag behind the name (above the line, or below it when the line goes down)
  const tx0 = Math.min(ex, x1)
  const ty0 = down ? ey : ey - tagH
  drawPanel(g, T, P, tx0, ty0, Math.abs(x1 - ex), tagH, fs * 0.6, false)
  // Leader line and the line under the name
  g.save()
  g.strokeStyle = P.line
  g.lineWidth = Math.max(1.5, fs * 0.08)
  if (T.look.glow > 0) {
    g.shadowColor = P.line
    g.shadowBlur = Math.min(16, fs * 0.5 * T.look.glow)
  }
  g.lineJoin = 'miter'
  g.beginPath()
  g.moveTo(x, y)
  g.lineTo(ex, ey)
  g.lineTo(x1, ey)
  g.stroke()
  // Ring on the point and a dot in it
  g.beginPath()
  g.arc(x, y, Math.max(3, fs * 0.32), 0, Math.PI * 2)
  g.stroke()
  g.restore()
  g.fillStyle = P.text
  g.beginPath()
  g.arc(x, y, Math.max(1.5, fs * 0.11), 0, Math.PI * 2)
  g.fill()
  // A small square at the end of the line
  const q = Math.max(2, fs * 0.16)
  g.fillStyle = P.hot
  g.fillRect(x1 - q / 2, ey - q / 2, q, q)
  font(g, T, fs, T.look.weight, 0.06)
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  const indent = T.look.panel === 'tab' ? fs * 0.3 : 0
  lines.forEach((s, k) => glowText(g, T, s, tx0 + pad + indent, ty0 + pad * 0.4 + lineH * (k + 0.5), P.text, P.line, fs * 0.3))
  noSpacing(g)
  g.restore()
}

/** How long the opening title takes to come in and to go [s] */
export const TITLE_IN = 0.9
export const TITLE_OUT = 0.8

/**
 * Opening title over the w×h frame, `at` seconds into it, shown for dur seconds: a large title in the middle and a subtitle below it at 1/3 the
 * size, on a glass band; lines draw out from the title to the sides as it comes in
 */
export function hudTitle(g: Ctx, title: string, sub: string, w: number, h: number, at: number, dur: number, T: Theme, P: ThemePal = T.pal): void {
  if (at < 0 || at > dur || (!title.trim() && !sub.trim())) return
  const a = Math.min(ease(at / TITLE_IN), ease((dur - at) / TITLE_OUT))
  const draw = ease(at / TITLE_IN)
  const fs = Math.min(h * 0.11, w * 0.07)
  const ss = fs / 3
  const cy = h * 0.5
  const tY = sub.trim() ? cy - ss * 0.9 : cy
  const sY = tY + fs * 0.62 + ss * 1.1
  g.save()
  g.globalAlpha = a
  // Band: glass that fades out toward the sides
  const top = tY - fs * 0.95
  const bh = sY + ss * 1.6 - top
  const band = g.createLinearGradient(0, 0, w, 0)
  band.addColorStop(0, 'rgba(2,6,14,0)')
  band.addColorStop(0.25, P.bg1)
  band.addColorStop(0.75, P.bg1)
  band.addColorStop(1, 'rgba(2,6,14,0)')
  g.fillStyle = band
  g.fillRect(0, top, w, bh)
  if (T.look.scan) {
    g.fillStyle = 'rgba(255,255,255,0.03)'
    const sl = Math.max(2, fs * 0.06)
    for (let y = top; y < top + bh; y += sl) g.fillRect(w * 0.1, y, w * 0.8, sl * 0.3)
  }
  // Title
  font(g, T, fs, 700, 0.08)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const tw = title.trim() ? g.measureText(title).width : 0
  if (tw) glowText(g, T, title, w / 2, tY, P.text, P.line, fs * 0.4)
  // Lines drawn out from the title toward the sides, with end marks
  g.save()
  g.strokeStyle = P.line
  if (T.look.glow > 0) {
    g.shadowColor = P.line
    g.shadowBlur = Math.min(24, fs * 0.3 * T.look.glow)
  }
  g.lineWidth = Math.max(1.5, fs * 0.025)
  const gap = (tw || w * 0.2) / 2 + fs * 0.5
  const len = (w * 0.36 - gap) * draw
  const ly = tY
  for (const sgn of [-1, 1]) {
    if (len <= 0) break
    const x0 = w / 2 + sgn * gap
    const x1 = x0 + sgn * len
    g.beginPath()
    g.moveTo(x0, ly)
    g.lineTo(x1, ly)
    if (T.look.panel === 'classic' || T.look.panel === 'wafu' || T.look.panel === 'ainu') {
      // A small diamond at the end
      const d = fs * 0.12
      g.moveTo(x1 + sgn * d, ly)
      g.lineTo(x1, ly - d)
      g.lineTo(x1 - sgn * d, ly)
      g.lineTo(x1, ly + d)
      g.closePath()
    } else if (T.look.panel === 'slant' || T.look.italic) {
      g.moveTo(x1 + fs * 0.12, ly - fs * 0.28)
      g.lineTo(x1 - fs * 0.12, ly + fs * 0.28)
    } else {
      g.moveTo(x1, ly - fs * 0.28)
      g.lineTo(x1, ly + fs * 0.28)
    }
    g.stroke()
  }
  // Thin lines along the top and bottom of the band
  const half = w * 0.3 * draw
  g.globalAlpha = a * 0.6
  g.lineWidth = Math.max(1, fs * 0.012)
  g.beginPath()
  g.moveTo(w / 2 - half, top)
  g.lineTo(w / 2 + half, top)
  g.moveTo(w / 2 - half, top + bh)
  g.lineTo(w / 2 + half, top + bh)
  g.stroke()
  g.restore()
  // Subtitle (1/3 the size, wide letter spacing)
  if (sub.trim()) {
    font(g, T, ss, 600, 0.35)
    g.fillStyle = P.sub
    g.fillText(sub, w / 2 + ss * 0.17, sY)
  }
  if (P.stripes) {
    const sw = fs * 0.5
    const sh = Math.max(1.5, fs * 0.04)
    drawStripes(g, P.stripes, w / 2 - (P.stripes.length * sw * 1.15 - sw * 0.15) / 2, top + bh - sh * 3, sw, sh, T.look.italic)
  }
  noSpacing(g)
  g.restore()
}
