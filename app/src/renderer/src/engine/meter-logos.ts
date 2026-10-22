// The user's own logos for the meter (core/logo.ts; one per design theme, remembered on this PC and not in the project or settings file).
// logos.json and the copied images live in the logos folder of the user data. This module keeps the settings, decodes each image once,
// builds the round image the meter draws, and registers itself with render/logo.ts. Two cached levels per theme: the whole image with its
// background made transparent (rebuilt only when the file or the keying change), and the circle cut from it (cheap, so that dragging the
// circle in the dialog stays smooth).
import { circleRect, DEFAULT_LOGO, defaultCircle, keyBackground, parseLogos, sanitizeLogo, stringifyLogos, type MeterLogo } from '../core/logo'
import { setLogoProvider } from '../render/logo'

/** Longest side of a decoded SVG and of the circle image [px] */
const MAX_SIDE = 1024
/** Longest side of the whole image once its background is keyed [px] */
const KEY_SIDE = 2048

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' }

type Surface = OffscreenCanvas | HTMLCanvasElement
interface Source {
  file: string
  img: CanvasImageSource
  w: number
  h: number
}
interface Keyed {
  key: string
  img: CanvasImageSource
  w: number
  h: number
}
interface Built {
  key: string
  canvas: Surface
}

let store: Record<string, MeterLogo> = {}
const sources = new Map<string, Source>()
const keyed = new Map<string, Keyed>()
const built = new Map<string, Built>()
const listeners = new Set<() => void>()
/** Files of the logos.json last written (or read) */
let committed = new Set<string>()
/** Files nothing uses any more but that are kept until the change is written (Cancel can bring them back) */
const garbage = new Set<string>()
let initP: Promise<void> | null = null
let busy: Promise<unknown> = Promise.resolve()
let dirP: Promise<string> | null = null

const logoDir = (): Promise<string> => (dirP ??= window.api.logoDir())
const warn = (what: string, e: unknown): void => console.warn(`Meter logo: ${what}`, e)
const emit = (): void => {
  for (const f of [...listeners]) f()
}
/** Runs the steps that touch the files one after another */
const queue = <T>(f: () => Promise<T>): Promise<T> => {
  const r = busy.then(f, f)
  busy = r.catch(() => undefined)
  return r
}
const without = (o: Record<string, MeterLogo>, id: string): Record<string, MeterLogo> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== id))
const surface = (w: number, h: number): Surface => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }))
const ctxOf = (c: Surface): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D => c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
const extOf = (path: string): string => /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? ''

/** Decodes an image file. A vector image is drawn onto a canvas whose long side is MAX_SIDE */
async function decode(path: string, file: string): Promise<Source> {
  const ext = extOf(file)
  const type = MIME[ext]
  if (!type) throw new Error(`Unsupported image type: ${file}`)
  const blob = new Blob([(await window.api.readBinary(path)) as Uint8Array<ArrayBuffer>], { type })
  if (ext !== 'svg') {
    const bmp = await createImageBitmap(blob)
    return { file, img: bmp, w: bmp.width, h: bmp.height }
  }
  const url = URL.createObjectURL(blob)
  try {
    const im = new Image()
    await new Promise<void>((ok, ng) => {
      im.onload = () => ok()
      im.onerror = () => ng(new Error(`Cannot load ${file}`))
      im.src = url
    })
    // An SVG may declare a tiny size (or none), so it is drawn at a size of our own
    const nw = im.naturalWidth || MAX_SIDE
    const nh = im.naturalHeight || MAX_SIDE
    const k = MAX_SIDE / Math.max(nw, nh)
    const w = Math.max(1, Math.round(nw * k))
    const h = Math.max(1, Math.round(nh * k))
    const c = surface(w, h)
    ctxOf(c).drawImage(im, 0, 0, w, h)
    return { file, img: c, w, h }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function loadSource(themeId: string, file: string): Promise<boolean> {
  try {
    sources.set(themeId, await decode(window.api.path.join(await logoDir(), file), file))
    return true
  } catch (e) {
    warn(`cannot read ${file}`, e)
    sources.delete(themeId)
    return false
  }
}

/** The whole image with its background made transparent (the reference color comes from the image's own border) */
function keyedImage(themeId: string, l: MeterLogo, s: Source): Keyed | null {
  const key = `${l.file}|${l.keyBg ? l.tolerance + (l.keyAll ? 'all' : '') : 'off'}`
  const old = keyed.get(themeId)
  if (old && old.key === key) return old
  try {
    let k: Keyed
    if (!l.keyBg) k = { key, img: s.img, w: s.w, h: s.h }
    else {
      const f = Math.min(1, KEY_SIDE / Math.max(s.w, s.h))
      const w = Math.max(1, Math.round(s.w * f))
      const h = Math.max(1, Math.round(s.h * f))
      const c = surface(w, h)
      const g = ctxOf(c)
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.drawImage(s.img, 0, 0, w, h)
      const d = g.getImageData(0, 0, w, h)
      keyBackground(d.data, w, h, l.tolerance, l.keyAll)
      g.putImageData(d, 0, 0)
      k = { key, img: c, w, h }
    }
    keyed.set(themeId, k)
    built.delete(themeId)
    return k
  } catch (e) {
    warn('cannot process the image', e)
    return null
  }
}

/** The circle of the keyed image as a square canvas, transparent outside the circle and outside the image */
function build(themeId: string, l: MeterLogo, s: Source): Built | null {
  const k = keyedImage(themeId, l, s)
  if (!k) return null
  const key = `${k.key}|${l.circle.x},${l.circle.y},${l.circle.r}`
  const old = built.get(themeId)
  if (old && old.key === key) return old
  try {
    const q = circleRect(l.circle, k.w, k.h)
    const side = Math.max(1, Math.round(Math.min(MAX_SIDE, q.side)))
    const f = side / q.side
    const c = surface(side, side)
    const g = ctxOf(c)
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    // Only the part of the square that lies on the image is drawn (nothing is stretched); the rest stays transparent
    const x0 = Math.max(0, q.sx)
    const y0 = Math.max(0, q.sy)
    const x1 = Math.min(k.w, q.sx + q.side)
    const y1 = Math.min(k.h, q.sy + q.side)
    if (x1 > x0 && y1 > y0) g.drawImage(k.img, x0, y0, x1 - x0, y1 - y0, (x0 - q.sx) * f, (y0 - q.sy) * f, (x1 - x0) * f, (y1 - y0) * f)
    g.globalCompositeOperation = 'destination-in'
    g.beginPath()
    g.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2)
    g.fill()
    g.globalCompositeOperation = 'source-over'
    const b = { key, canvas: c }
    built.set(themeId, b)
    return b
  } catch (e) {
    warn('cannot process the image', e)
    return null
  }
}

setLogoProvider((themeId) => {
  const l = store[themeId]
  const s = sources.get(themeId)
  if (!l || !s || s.file !== l.file) return null
  const b = build(themeId, l, s)
  return b ? { img: b.canvas, size: l.size, opacity: l.opacity } : null
})

const unlinkQuiet = async (file: string): Promise<void> => {
  try {
    await window.api.unlink(window.api.path.join(await logoDir(), file))
  } catch {
    /* already gone */
  }
}

/** Writes logos.json, then deletes the files that nothing uses any more */
function persist(): Promise<void> {
  return queue(async () => {
    try {
      await window.api.writeText(window.api.path.join(await logoDir(), 'logos.json'), stringifyLogos(store))
      committed = new Set(Object.values(store).map((l) => l.file))
      for (const f of [...garbage]) {
        garbage.delete(f)
        if (!committed.has(f)) await unlinkQuiet(f)
      }
    } catch (e) {
      warn('cannot save', e)
    }
  })
}

/** A file that a theme stops using: deleted at once if it was never written to logos.json, otherwise when the change is written */
function release(file: string | undefined, keep?: string): void {
  if (!file || file === keep) return
  if (committed.has(file)) garbage.add(file)
  else void queue(() => unlinkQuiet(file))
}

/** Loads logos.json and decodes the images. Call once at the start of the app */
export function initMeterLogos(): Promise<void> {
  return (initP ??= (async () => {
    try {
      const p = window.api.path.join(await logoDir(), 'logos.json')
      store = (await window.api.exists(p)) ? parseLogos(await window.api.readText(p)) : {}
    } catch (e) {
      warn('cannot read logos.json', e)
      store = {}
    }
    committed = new Set(Object.values(store).map((l) => l.file))
    await Promise.all(
      Object.entries(store).map(async ([id, l]) => {
        // An image that cannot be read counts as no logo for that theme
        if (!(await loadSource(id, l.file))) store = without(store, id)
      })
    )
    emit()
  })())
}

/** Resolves when the saved logos are decoded (the export waits for it) and any change in progress is done */
export async function logosReady(): Promise<void> {
  await initP
  await busy
}

export const getMeterLogo = (themeId: string): MeterLogo | null => store[themeId] ?? null

/** The decoded whole image (for choosing the circle) */
export function getLogoSource(themeId: string): { img: CanvasImageSource; w: number; h: number } | null {
  const s = sources.get(themeId)
  return s && store[themeId]?.file === s.file ? s : null
}

export function subscribeLogos(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Copies an image into the logo folder and makes it the theme's logo with the defaults (the inscribed circle; the circle and the rest of the previous logo are
 * not kept). Nothing is written to logos.json yet: updateMeterLogo(…, true) does that, restoreMeterLogo brings the previous one back.
 * Throws (keeping the previous logo) when the image cannot be read
 */
export function chooseLogoFile(themeId: string, srcPath: string): Promise<void> {
  return queue(async () => {
    const ext = extOf(srcPath)
    if (!MIME[ext]) throw new Error(`Unsupported image type: ${srcPath}`)
    const file = `${themeId}-${Date.now()}.${ext}`
    const dst = window.api.path.join(await logoDir(), file)
    await window.api.copyFile(srcPath, dst)
    let s: Source
    try {
      s = await decode(dst, file)
    } catch (e) {
      await unlinkQuiet(file)
      throw e
    }
    release(store[themeId]?.file, file)
    sources.set(themeId, s)
    keyed.delete(themeId)
    built.delete(themeId)
    store = { ...store, [themeId]: { file, ...structuredClone(DEFAULT_LOGO), circle: defaultCircle(s.w, s.h) } }
    emit()
  })
}

/** Applies a change at once (the preview redraws); logos.json is written only when `persistNow` */
export function updateMeterLogo(themeId: string, patch: Partial<Omit<MeterLogo, 'file'>>, persistNow: boolean): void {
  const cur = store[themeId]
  if (!cur) return
  const next = sanitizeLogo({ ...cur, ...patch })
  if (next) {
    store = { ...store, [themeId]: next }
    emit()
  }
  if (persistNow) void persist()
}

/** Brings back the logo a theme had (null = none), for Cancel. The image is decoded again if another one was chosen meanwhile */
export function restoreMeterLogo(themeId: string, logo: MeterLogo | null): Promise<void> {
  return queue(async () => {
    release(store[themeId]?.file, logo?.file)
    if (logo) garbage.delete(logo.file)
    if (logo && sources.get(themeId)?.file !== logo.file) {
      keyed.delete(themeId)
      built.delete(themeId)
      if (!(await loadSource(themeId, logo.file))) logo = null
    }
    if (logo) store = { ...store, [themeId]: logo }
    else {
      store = without(store, themeId)
      sources.delete(themeId)
      keyed.delete(themeId)
      built.delete(themeId)
    }
    emit()
  })
}

/** Removes the theme's logo (the built-in emblem is back) and deletes its image */
export function removeMeterLogo(themeId: string): void {
  const old = store[themeId]
  if (!old) return
  store = without(store, themeId)
  sources.delete(themeId)
  keyed.delete(themeId)
  built.delete(themeId)
  garbage.add(old.file)
  emit()
  void persist()
}
