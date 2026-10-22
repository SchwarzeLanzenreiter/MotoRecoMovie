// Settings screen "Meter logo": the image shown in the middle of a theme's meter in place of its built-in emblem. The round part of the image
// to show is chosen on the image itself (drag the circle, its edge or handle, or press outside it to start a new one; the circle may reach
// past the image, which is shown with a margin); the video preview and the small meter below change as it is edited. Cancel brings back
// what the theme had when this opened; OK writes it to this PC.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { clampCircle, MIN_R, type MeterLogo } from '../core/logo'
import { getLogoSource, getMeterLogo, restoreMeterLogo, subscribeLogos, updateMeterLogo } from '../engine/meter-logos'
import { t } from '../i18n'
import { DEFAULT_METER, drawMeter } from '../render/meter'
import { getTheme } from '../render/themes'
import { Slider } from './Slider'
import { useLang } from './useLang'

interface Props {
  themeId: string
  /** What the theme had when this opened (null = no logo), brought back by Cancel */
  restore: MeterLogo | null
  /** Choose another image (the dialog stays open for the new one) */
  onChoose: () => void
  onClose: () => void
}

type Circle = MeterLogo['circle']
/** move: the circle follows the pointer from (x, y) [canvas px]; size: the radius follows the distance from the fixed center (cx, cy) [fractions of the image] */
type Drag = { mode: 'move'; x: number; y: number; c: Circle } | { mode: 'size'; cx: number; cy: number }

/** Largest the image area is shown [CSS px] */
const MAX_H = 300
const FALLBACK_W = 290
const METER = 220
/** Margin round the image, as a fraction of its long side, so that a circle past the edge can be seen and grabbed */
const PAD = 0.25
const HANDLE = 5 // radius of the round handle
const GRAB = 9 // how close to the handle grabs it
const EDGE = 8 // how close to the outline grabs it

export function LogoDialog(p: Props): React.JSX.Element {
  useLang()
  const id = p.themeId
  const theme = getTheme(id)
  const logo = useSyncExternalStore(subscribeLogos, () => getMeterLogo(id))
  const src = logo ? getLogoSource(id) : null
  const wrap = useRef<HTMLDivElement>(null)
  const srcCv = useRef<HTMLCanvasElement>(null)
  const meterCv = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Drag | null>(null)
  const [avail, setAvail] = useState(FALLBACK_W)
  useLayoutEffect(() => {
    const w = wrap.current?.clientWidth
    if (w && w > 40) setAvail(w)
  }, [])
  // The image with its margin fits in avail x MAX_H (aspect kept); k = display px per image px
  const L = src ? Math.max(src.w, src.h) : 1
  const pad = L * PAD
  const tw = src ? src.w + pad * 2 : 1
  const th = src ? src.h + pad * 2 : 1
  const k = src ? Math.min(avail / tw, MAX_H / th) : 1
  const dw = src ? Math.max(1, Math.round(tw * k)) : avail
  const dh = src ? Math.max(1, Math.round(th * k)) : 1
  /** The circle on the canvas [CSS px] */
  const geom = (c: Circle): { cx: number; cy: number; R: number } => ({ cx: (c.x * (src?.w ?? 1) + pad) * k, cy: (c.y * (src?.h ?? 1) + pad) * k, R: c.r * L * k })

  // The settings were removed (or could not be read): nothing to adjust
  useEffect(() => {
    if (!logo) p.onClose()
  }, [logo]) // eslint-disable-line react-hooks/exhaustive-deps

  // The whole image with the circle
  const circle = logo?.circle
  useEffect(() => {
    const cv = srcCv.current
    if (!cv || !src || !circle) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(dw * dpr)
    cv.height = Math.round(dh * dpr)
    const g = cv.getContext('2d')!
    g.scale(dpr, dpr)
    // Margin: plain and dark. The image: over a checkerboard, so that transparent parts show
    g.fillStyle = '#232323'
    g.fillRect(0, 0, dw, dh)
    const ix = pad * k
    const iy = pad * k
    const iw = src.w * k
    const ih = src.h * k
    const s = 8
    for (let y = 0; y < ih; y += s) {
      for (let x = 0; x < iw; x += s) {
        g.fillStyle = ((x + y) / s) % 2 ? '#8a8a8a' : '#b8b8b8'
        g.fillRect(ix + x, iy + y, Math.min(s, iw - x), Math.min(s, ih - y))
      }
    }
    g.imageSmoothingQuality = 'high'
    g.drawImage(src.img, ix, iy, iw, ih)
    const { cx, cy, R } = geom(circle)
    // Dim everything outside the circle
    g.fillStyle = 'rgba(0,0,0,0.55)'
    g.beginPath()
    g.rect(0, 0, dw, dh)
    g.moveTo(cx + R, cy)
    g.arc(cx, cy, R, 0, Math.PI * 2)
    g.fill('evenodd')
    g.lineWidth = 1
    g.strokeStyle = 'rgba(0,0,0,0.7)'
    g.beginPath()
    g.arc(cx, cy, R + 1.25, 0, Math.PI * 2)
    g.stroke()
    g.lineWidth = 1.5
    g.strokeStyle = '#ffffff'
    g.beginPath()
    g.arc(cx, cy, R, 0, Math.PI * 2)
    g.stroke()
    // Handle at the bottom right (45 degrees)
    g.beginPath()
    g.arc(cx + R * Math.SQRT1_2, cy + R * Math.SQRT1_2, HANDLE, 0, Math.PI * 2)
    g.fillStyle = '#ffffff'
    g.fill()
    g.lineWidth = 1
    g.strokeStyle = '#000000'
    g.stroke()
  }, [src, circle, dw, dh, k]) // eslint-disable-line react-hooks/exhaustive-deps

  // The meter with the logo (the same drawing as the video)
  useEffect(() => {
    const cv = meterCv.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(METER * dpr)
    cv.height = Math.round(METER * dpr)
    const g = cv.getContext('2d')!
    g.scale(dpr, dpr)
    const bg = g.createLinearGradient(0, 0, 0, METER)
    bg.addColorStop(0, '#8a8a8a')
    bg.addColorStop(1, '#3d3d3d')
    g.fillStyle = bg
    g.fillRect(0, 0, METER, METER)
    drawMeter(g, { x: 6, y: 6, w: METER - 12, h: METER - 12 }, { rpm: 7300, throttle: 68, brakeFront: 6.5, lean: 38, gear: 4, airTemp: 22 }, DEFAULT_METER, 41, { rpm: 0.6, throttle: 0.6, brake: 0, lean: 1 }, theme, 1, null)
  }, [logo, theme])

  // ---- Dragging on the image ----
  const setCircle = (c: Circle): void => updateMeterLogo(id, { circle: clampCircle(c) }, false)
  const pos = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = srcCv.current!.getBoundingClientRect()
    return [((e.clientX - r.left) * dw) / r.width, ((e.clientY - r.top) * dh) / r.height]
  }
  /** What is under the pointer: the outline or the handle (resize), the inside (move) or the outside */
  const hit = (x: number, y: number, c: Circle): 'edge' | 'in' | 'out' => {
    const { cx, cy, R } = geom(c)
    const d = Math.hypot(x - cx, y - cy)
    if (Math.hypot(x - (cx + R * Math.SQRT1_2), y - (cy + R * Math.SQRT1_2)) <= GRAB || Math.abs(d - R) <= Math.min(EDGE, R * 0.5)) return 'edge'
    return d < R ? 'in' : 'out'
  }
  /** Radius for a pointer at (x, y) with the circle centered at (cx, cy) [fractions of the image] */
  const radiusAt = (x: number, y: number, cx: number, cy: number): number => {
    const g = geom({ x: cx, y: cy, r: 0 })
    return Math.hypot(x - g.cx, y - g.cy) / (L * k)
  }
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!circle || !src) return
    const [x, y] = pos(e)
    const h = hit(x, y, circle)
    if (h === 'edge') drag.current = { mode: 'size', cx: circle.x, cy: circle.y }
    else if (h === 'in') drag.current = { mode: 'move', x, y, c: circle }
    else {
      // A new circle centered at the press point (kept inside the image), sized by dragging
      const c = clampCircle({ x: (x / k - pad) / src.w, y: (y / k - pad) / src.h, r: MIN_R })
      drag.current = { mode: 'size', cx: c.x, cy: c.y }
      setCircle(c)
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!circle || !src) return
    const [x, y] = pos(e)
    const d = drag.current
    if (!d) {
      const h = hit(x, y, circle)
      e.currentTarget.style.cursor = h === 'edge' ? 'nwse-resize' : h === 'in' ? 'move' : 'crosshair'
    } else if (d.mode === 'move') setCircle({ ...d.c, x: d.c.x + (x - d.x) / (k * src.w), y: d.c.y + (y - d.y) / (k * src.h) })
    else setCircle({ x: d.cx, y: d.cy, r: radiusAt(x, y, d.cx, d.cy) })
  }
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  // The mouse wheel over the image changes the radius by 5 % per notch (a native listener: React's wheel handlers cannot prevent scrolling)
  const wheel = useRef<(e: WheelEvent) => void>(() => {})
  wheel.current = (e) => {
    e.preventDefault()
    if (!circle) return
    const step = Math.max(-3, Math.min(3, -e.deltaY / 100))
    setCircle({ ...circle, r: circle.r * Math.pow(1.05, step) })
  }
  useEffect(() => {
    const cv = srcCv.current
    if (!cv) return
    const f = (e: WheelEvent): void => wheel.current(e)
    cv.addEventListener('wheel', f, { passive: false })
    return () => cv.removeEventListener('wheel', f)
  }, [])

  const cancel = (): void => {
    void restoreMeterLogo(id, p.restore)
    p.onClose()
  }
  const ok = (): void => {
    updateMeterLogo(id, {}, true)
    p.onClose()
  }
  const set = (patch: Partial<Omit<MeterLogo, 'file'>>): void => updateMeterLogo(id, patch, false)

  return (
    <div className="dialog meter-logo" data-dialog="meter-logo">
      <div className="dialog-head">
        <h3>{t('Meter logo')}</h3>
        <button className="mini" data-action="meter-logo-close" onClick={cancel} title={t('Close')}>
          ✕
        </button>
      </div>
      <div className="note">{t(theme.name)}</div>
      <div className="note">{t('Drag on the image to choose the round part shown in the meter. Drag inside the circle to move it, its edge or handle to resize it (or use the mouse wheel).')}</div>
      <div className="logo-stage" ref={wrap}>
        <canvas ref={srcCv} className="logo-src" data-role="logo-source" style={{ width: dw, height: dh }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      </div>
      <div className="logo-stage">
        <canvas ref={meterCv} className="logo-meter" data-role="logo-meter" style={{ width: METER, height: METER }} />
      </div>
      {logo && (
        <>
          <div className="row">
            <label className="rule">
              <input type="checkbox" data-action="meter-logo-key" checked={logo.keyBg} onChange={(e) => set({ keyBg: e.target.checked })} /> {t('Make the background transparent')}
            </label>
          </div>
          <div className="row">
            <label className="rule">
              <input type="checkbox" data-action="meter-logo-key-all" checked={logo.keyAll} disabled={!logo.keyBg} onChange={(e) => set({ keyAll: e.target.checked })} /> {t('Also inside enclosed areas')}
            </label>
          </div>
          <Slider name={t('Tolerance')} value={logo.tolerance} min={0} max={100} step={1} disabled={!logo.keyBg} onChange={(x) => set({ tolerance: x })} />
          <Slider name={t('Size')} value={Math.round(logo.size * 100)} min={30} max={150} step={5} unit="%" onChange={(x) => set({ size: x / 100 })} />
          <Slider name={t('Opacity')} value={Math.round(logo.opacity * 100)} min={10} max={100} step={5} unit="%" onChange={(x) => set({ opacity: x / 100 })} />
        </>
      )}
      <div className="row logo-buttons">
        <button data-action="meter-logo-choose" onClick={p.onChoose}>
          {t('Choose another image…')}
        </button>
        <span style={{ flex: 1 }} />
        <button data-action="meter-logo-cancel" onClick={cancel}>
          {t('Cancel')}
        </button>
        <button data-action="meter-logo-ok" className="primary" onClick={ok}>
          {t('OK')}
        </button>
      </div>
    </div>
  )
}
