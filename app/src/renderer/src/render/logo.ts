// The user's own image in the middle of the meter, in place of a theme's built-in emblem (settings in core/logo.ts, decoding and
// processing in engine/meter-logos.ts, which registers itself as the provider so that render/ does not import engine/).
import type { Ctx } from './meters'

export interface LogoImage {
  /** The round part of the image (a square canvas, transparent outside the circle) */
  img: CanvasImageSource
  /** 1 = fits the theme's emblem box */
  size: number
  opacity: number
}

type Provider = (themeId: string) => LogoImage | null

let provider: Provider = () => null

export function setLogoProvider(fn: Provider): void {
  provider = fn
}

/**
 * Draws the user's logo for the theme centered at (cx, cy) if there is one, as a square of side 2 * r * size (r = radius of the box the built-in emblem would use),
 * otherwise calls `fallback` to draw the built-in emblem. grey (0 to 1) greys the image while the engine is stopped, like the palette.
 */
export function emblemOr(g: Ctx, themeId: string, cx: number, cy: number, r: number, grey: number, fallback: () => void): void {
  const L = provider(themeId)
  if (!L) {
    fallback()
    return
  }
  const side = 2 * r * L.size
  g.save()
  g.globalAlpha *= L.opacity
  if (grey > 0) g.filter = `grayscale(${grey})`
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(L.img, cx - side / 2, cy - side / 2, side, side)
  g.restore()
}
