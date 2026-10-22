// Meter logo: an image of the user's own that replaces the built-in emblem in the middle of the meter, chosen per design theme.
// Pure logic only (no DOM): the stored settings and their parsing, the circle of the image that is shown, and making the background
// transparent. The image itself is decoded and cached in engine/meter-logos.ts; drawing is in render/logo.ts.

export interface MeterLogo {
  /** File name inside the logo folder of the user data (copied there when the image is chosen) */
  file: string
  /**
   * The round part of the image that is shown (the meter's emblem is round). x, y = center in fractions of the image width and height;
   * r = radius in fractions of the image's LONG side, so the circle may extend past the edges (outside the image is transparent)
   */
  circle: { x: number; y: number; r: number }
  /** Make the background (the color around the edge of the image) transparent */
  keyBg: boolean
  /** Also make enclosed areas of the background color transparent (the holes of letters), not only what connects to the border */
  keyAll: boolean
  /** How far from the background color still counts as background (0 to 100) */
  tolerance: number
  /** 1 = fits the box of the theme's own emblem */
  size: number
  opacity: number
}

export const DEFAULT_LOGO: Omit<MeterLogo, 'file'> = { circle: { x: 0.5, y: 0.5, r: 0.5 }, keyBg: true, keyAll: false, tolerance: 20, size: 1, opacity: 0.6 }

export const MIN_R = 0.01
export const MAX_R = 0.75
export const SIZE_RANGE = [0.3, 1.5] as const
export const OPACITY_RANGE = [0.1, 1] as const

const num = (v: unknown, def: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def)

/** The circle with its center inside the image (0 to 1) and its radius within MIN_R to MAX_R */
export function clampCircle(c: { x: number; y: number; r: number }): { x: number; y: number; r: number } {
  return { x: num(c.x, 0.5, 0, 1), y: num(c.y, 0.5, 0, 1), r: num(c.r, 0.5, MIN_R, MAX_R) }
}

/** The circle that just fits inside a w x h image, centered (used when an image is chosen) */
export function defaultCircle(w: number, h: number): { x: number; y: number; r: number } {
  const m = Math.max(w, h)
  return m > 0 ? { x: 0.5, y: 0.5, r: (0.5 * Math.min(w, h)) / m } : { ...DEFAULT_LOGO.circle }
}

/** The square round the circle in pixels of a w x h image: top left (sx, sy) and side (may reach past the image) */
export function circleRect(c: { x: number; y: number; r: number }, w: number, h: number): { sx: number; sy: number; side: number } {
  const m = Math.max(w, h)
  return { sx: c.x * w - c.r * m, sy: c.y * h - c.r * m, side: 2 * c.r * m }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One stored entry, or null when it cannot be used. Every number is clamped to its range */
export function sanitizeLogo(v: unknown): MeterLogo | null {
  if (!isObj(v)) return null
  const file = v.file
  // A bare file name inside the logo folder (no folders)
  if (typeof file !== 'string' || !file || /[\\/]/.test(file) || file.includes('..')) return null
  const d = DEFAULT_LOGO
  const c = isObj(v.circle) ? v.circle : {}
  return {
    file,
    circle: clampCircle({ x: num(c.x, d.circle.x, 0, 1), y: num(c.y, d.circle.y, 0, 1), r: num(c.r, d.circle.r, MIN_R, MAX_R) }),
    keyBg: typeof v.keyBg === 'boolean' ? v.keyBg : d.keyBg,
    keyAll: typeof v.keyAll === 'boolean' ? v.keyAll : d.keyAll,
    tolerance: num(v.tolerance, d.tolerance, 0, 100),
    size: num(v.size, d.size, SIZE_RANGE[0], SIZE_RANGE[1]),
    opacity: num(v.opacity, d.opacity, OPACITY_RANGE[0], OPACITY_RANGE[1])
  }
}

/** logos.json: { version: 1, logos: { [themeId]: MeterLogo } }. Tolerant: unusable entries are dropped, numbers clamped, never throws */
export function parseLogos(text: string): Record<string, MeterLogo> {
  const out: Record<string, MeterLogo> = {}
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return out
  }
  if (!isObj(j) || !isObj(j.logos)) return out
  for (const [id, v] of Object.entries(j.logos)) {
    if (id === '__proto__') continue
    const l = sanitizeLogo(v)
    if (l) out[id] = l
  }
  return out
}

export function stringifyLogos(logos: Record<string, MeterLogo>): string {
  return JSON.stringify({ version: 1, logos }, null, 2)
}

/**
 * Makes the background of an RGBA image transparent, in place. The background color is the most common color along the border
 * (counted at 5 bits per channel, then the average of the border pixels in that bucket); a flood fill from the border takes every
 * connected pixel that is nearly transparent or within `tolerance` (0 to 100 = 0 to 255 in RGB distance) of it. Just outside that,
 * pixels up to 1.6 times as far get a partly transparent edge. Regions of the same color not connected to the border (highlights inside
 * the emblem) stay opaque, unless `everywhere`: then the fill also starts from every background-colored pixel, so enclosed areas (the
 * counters of letters) become transparent too, with the same soft edge.
 */
export function keyBackground(data: Uint8ClampedArray, w: number, h: number, tolerance: number, everywhere = false): void {
  if (w < 1 || h < 1 || data.length < w * h * 4) return
  const T = (Math.max(0, Math.min(100, tolerance)) / 100) * 255
  const T2 = T * T
  const S = T * 1.6
  const S2 = S * S
  // Reference color from the opaque border pixels (a border that is already transparent needs none)
  const count = new Map<number, number>()
  const sum = new Map<number, [number, number, number]>()
  const tally = (x: number, y: number): void => {
    const i = (y * w + x) * 4
    if (data[i + 3] < 16) return
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
    count.set(key, (count.get(key) ?? 0) + 1)
    const s = sum.get(key)
    if (s) {
      s[0] += data[i]
      s[1] += data[i + 1]
      s[2] += data[i + 2]
    } else sum.set(key, [data[i], data[i + 1], data[i + 2]])
  }
  for (let x = 0; x < w; x++) {
    tally(x, 0)
    if (h > 1) tally(x, h - 1)
  }
  for (let y = 1; y < h - 1; y++) {
    tally(0, y)
    if (w > 1) tally(w - 1, y)
  }
  let best = -1
  let bestN = 0
  for (const [k, n] of count) {
    if (n > bestN) {
      best = k
      bestN = n
    }
  }
  const ref = best < 0 ? null : sum.get(best)!.map((v) => v / bestN)
  const dist2 = (i: number): number => {
    if (!ref) return Infinity
    const dr = data[i] - ref[0]
    const dg = data[i + 1] - ref[1]
    const db = data[i + 2] - ref[2]
    return dr * dr + dg * dg + db * db
  }
  const isBg = (i: number): boolean => data[i + 3] < 16 || dist2(i) <= T2

  const seen = new Uint8Array(w * h) // 1 = background (in the fill), 2 = decided, not background
  const stack = new Int32Array(w * h)
  let sp = 0
  const seed = (x: number, y: number): void => {
    const p = y * w + x
    if (seen[p]) return
    if (isBg(p * 4)) {
      seen[p] = 1
      data[p * 4 + 3] = 0
      stack[sp++] = p
    }
  }
  for (let x = 0; x < w; x++) {
    seed(x, 0)
    seed(x, h - 1)
  }
  for (let y = 1; y < h - 1; y++) {
    seed(0, y)
    seed(w - 1, y)
  }
  if (everywhere) {
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) seed(x, y)
  }
  const visit = (q: number): void => {
    if (seen[q]) return
    const i = q * 4
    if (isBg(i)) {
      seen[q] = 1
      data[i + 3] = 0
      stack[sp++] = q
      return
    }
    seen[q] = 2
    // Soft edge: partly transparent between T and 1.6 T
    const d2 = dist2(i)
    if (d2 <= S2) data[i + 3] = Math.round(data[i + 3] * Math.max(0, Math.min(1, (Math.sqrt(d2) - T) / (0.6 * T))))
  }
  while (sp > 0) {
    const p = stack[--sp]
    const x = p % w
    const y = (p - x) / w
    if (x > 0) visit(p - 1)
    if (x < w - 1) visit(p + 1)
    if (y > 0) visit(p - w)
    if (y < h - 1) visit(p + w)
  }
}
