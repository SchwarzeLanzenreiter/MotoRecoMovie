import { useEffect, useRef, useState } from 'react'
import type { Keyframe } from '../engine/project'
import { STATE_COLORS, STATE_NAMES, STATES, type RidingTrack } from '../core/riding'
import { t } from '../i18n'
import { useLang } from './useLang'
import { KEY_COLORS, KEY_TAG_NAMES, keyColor } from './keyColors'

interface Props {
  frameCount: number
  fps: number
  frame: number
  keyframes: Keyframe[]
  inSec: number
  outSec: number
  lean: { t: Float64Array; v: Float64Array } | null
  /** Vehicle speed [km/h] (overlaid on the lean angle graph) */
  speed: { t: Float64Array; v: Float64Array } | null
  riding: RidingTrack | null
  markers: { t: number }[]
  /** Ranges split into 2 screens because of a bike disturbance */
  incidents?: { start: number; end: number }[]
  onSeek: (frame: number) => void
  /** Time [s] -> nearest frame (using the actual frame times; if omitted, round time x fps) */
  frameOf?: (t: number) => number
}

const fmt = (s: number, step: number): string => {
  const m = Math.floor(s / 60)
  const ss = s - m * 60
  return step < 1 ? `${m}:${ss.toFixed(1).padStart(4, '0')}` : `${m}:${ss.toFixed(0).padStart(2, '0')}`
}

const PAD = 12 // left and right margin [px]
const BAND = 14 // thickness of the riding-state band [px]
const GRAPH_TOP = 44 // top of the graph (below the ticks, keyframes and disturbance band)
const LEAN_COLOR = '#f5b84a'
const SPEED_COLOR = '#62d6e8'
/** Zoom limit: the shortest span shown across the screen width [s] */
const MIN_SPAN = 2

/** Per-column min and max over the range t0 to t1 (thins the graph down to the pixel count) */
function columns(d: { t: Float64Array; v: Float64Array }, t0: number, t1: number, cols: number): { mn: Float32Array; mx: Float32Array } {
  const mn = new Float32Array(cols).fill(Infinity)
  const mx = new Float32Array(cols).fill(-Infinity)
  // find the start of the range by binary search
  let lo = 0
  let hi = d.t.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (d.t[m] < t0) lo = m + 1
    else hi = m
  }
  for (let i = Math.max(0, lo - 1); i < d.t.length && d.t[i] <= t1; i++) {
    const v = d.v[i]
    if (!Number.isFinite(v)) continue
    const c = Math.floor(((d.t[i] - t0) / (t1 - t0)) * cols)
    if (c < 0 || c >= cols) continue
    if (v < mn[c]) mn[c] = v
    if (v > mx[c]) mx[c] = v
  }
  return { mn, mx }
}

/** Order in which keyframes are drawn (later = in front): hand-placed ones and front at the bottom, then corner entry, side, rear, with overtake in front */
const KEY_ORDER: (Keyframe['tag'] | undefined)[] = [undefined, 'front', 'corner', 'side', 'rear', 'overtake']

/**
 * Time axis: ticks, lean angle and vehicle speed graphs, export range, keyframes, playhead, riding-state band.
 * Zoom with the wheel (centered on the mouse position); scroll left and right with Shift+wheel, horizontal scroll or the scrollbar at the bottom
 */
export function Timeline({ frameCount, fps, frame, keyframes, inSec, outSec, lean, speed, riding, markers, incidents, onSeek, frameOf }: Props): React.JSX.Element {
  // redraw when the language changes (the drawing effect runs on every render)
  useLang()
  const ref = useRef<HTMLCanvasElement>(null)
  const dur = frameCount / fps
  // visible range [s]
  const [view, setView] = useState<{ v0: number; v1: number }>({ v0: 0, v1: dur })
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  // show the whole video when the video changes
  useEffect(() => setView({ v0: 0, v1: dur }), [dur])
  const clampView = (v0: number, v1: number): { v0: number; v1: number } => {
    let span = Math.min(dur, Math.max(Math.min(MIN_SPAN, dur), v1 - v0))
    if (!(span > 0)) span = dur
    let a = Math.max(0, Math.min(dur - span, v0))
    if (!Number.isFinite(a)) a = 0
    return { v0: a, v1: a + span }
  }
  const zoomed = view.v1 - view.v0 < dur - 1e-6
  /** Zoom by a factor of k (k < 1 zooms in). The center is `at`; if absent, the playhead (if visible) or the center of the view */
  const zoomBy = (k: number, at?: number): void => {
    const { v0, v1 } = viewRef.current
    const now = tNowRef.current
    const c = at ?? (now >= v0 && now <= v1 ? now : (v0 + v1) / 2)
    const next = clampView(c - (c - v0) * k, c + (v1 - c) * k)
    viewRef.current = next // use it for the next zoom without waiting for a redraw when keys are pressed in a row
    setView(next)
  }

  // follow the playhead when it leaves the visible range (only while zoomed in)
  const tNow = frame / fps
  const tNowRef = useRef(tNow)
  tNowRef.current = tNow
  useEffect(() => {
    const { v0, v1 } = viewRef.current
    if (v1 - v0 >= dur - 1e-6) return
    if (tNow < v0 || tNow > v1) {
      const span = v1 - v0
      setView(clampView(tNow - span * 0.1, tNow - span * 0.1 + span))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tNow, dur])

  // time -> frame (the function is recreated on every render, so hold it in a ref; as a dependency it would recreate the mouse handling during a drag)
  const frameOfRef = useRef(frameOf)
  frameOfRef.current = frameOf

  // tooltip (kind) when the mouse is over a keyframe
  const [tip, setTip] = useState<{ x: number; y: number; k: Keyframe } | null>(null)

  // redraw when the size changes
  const [, setTick] = useState(0)
  useEffect(() => {
    const ro = new ResizeObserver(() => setTick((n) => n + 1))
    ro.observe(ref.current!)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    const W = c.clientWidth
    const H = c.clientHeight
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.fillStyle = '#1b1e24'
    g.fillRect(0, 0, W, H)
    const { v0, v1 } = view
    const span = v1 - v0
    const IW = W - 2 * PAD
    const x = (s: number): number => PAD + ((s - v0) / span) * IW
    // graph range (above the riding-state band)
    const gBottom = riding ? H - BAND - 4 : H - 4
    // export range
    const o = outSec < 0 ? dur : outSec
    g.fillStyle = 'rgba(79,156,249,0.12)'
    g.fillRect(x(inSec), 0, x(o) - x(inSec), H)
    // ticks
    g.fillStyle = '#9aa1ae'
    g.strokeStyle = '#343946'
    g.lineWidth = 1
    g.font = '11px Yu Gothic UI, sans-serif'
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]
    const step = steps.find((s) => (IW / span) * s > 70) ?? 600
    for (let s = Math.ceil(v0 / step - 1e-9) * step; s <= v1 + 1e-9; s += step) {
      g.beginPath()
      g.moveTo(x(s), 0)
      g.lineTo(x(s), 8)
      g.stroke()
      g.fillText(fmt(s, step), x(s) + 3, 11)
    }
    // lean angle (center line = 0 deg, +-45 deg up and down)
    const mid = (GRAPH_TOP + gBottom) / 2
    const amp = (gBottom - GRAPH_TOP) / 2 / 45
    g.strokeStyle = '#343946'
    g.beginPath()
    g.moveTo(PAD, mid)
    g.lineTo(W - PAD, mid)
    g.stroke()
    const drawSeries = (d: { t: Float64Array; v: Float64Array }, color: string, yOf: (v: number) => number): void => {
      const cols = Math.max(1, Math.floor(IW))
      const { mn, mx } = columns(d, v0, v1, cols)
      g.strokeStyle = color
      g.lineWidth = 1
      g.beginPath()
      for (let k = 0; k < cols; k++) {
        if (!Number.isFinite(mn[k])) continue
        const px = PAD + k + 0.5
        g.moveTo(px, yOf(mx[k]))
        g.lineTo(px, yOf(mn[k]) + 0.5)
      }
      g.stroke()
    }
    // vehicle speed (bottom = 0 km/h, top = the top speed in this video). Drawn behind the lean angle
    const labels: [string, string][] = []
    if (speed && speed.v.length) {
      let vmax = 0
      for (const v of speed.v) if (Number.isFinite(v) && v > vmax) vmax = v
      const top = Math.max(40, Math.ceil(vmax / 20) * 20)
      drawSeries(speed, SPEED_COLOR, (v) => gBottom - (Math.max(0, v) / top) * (gBottom - GRAPH_TOP))
      g.fillStyle = SPEED_COLOR
      g.font = '10px Yu Gothic UI, sans-serif'
      g.fillText(`${top} km/h`, PAD + 2, GRAPH_TOP + 9)
      labels.push([t('Speed'), SPEED_COLOR])
    }
    // legend of keyframe colors (top left of the graph; only kinds that auto-generation produced)
    {
      const tags = KEY_ORDER.filter((tg): tg is NonNullable<typeof tg> => !!tg && keyframes.some((k) => k.tag === tg))
      g.font = '10px Yu Gothic UI, sans-serif'
      let lx = PAD + 2 + (speed && speed.v.length ? g.measureText('000 km/h').width + 14 : 0)
      for (const tg of tags) {
        g.fillStyle = KEY_COLORS[tg]
        g.beginPath()
        g.moveTo(lx + 4, GRAPH_TOP + 1)
        g.lineTo(lx + 8, GRAPH_TOP + 5)
        g.lineTo(lx + 4, GRAPH_TOP + 9)
        g.lineTo(lx, GRAPH_TOP + 5)
        g.closePath()
        g.fill()
        const name = t(KEY_TAG_NAMES[tg])
        g.fillText(name, lx + 11, GRAPH_TOP + 9)
        lx += 20 + g.measureText(name).width
      }
    }
    if (lean) {
      drawSeries(lean, LEAN_COLOR, (v) => mid - v * amp)
      labels.push([t('Lean angle'), LEAN_COLOR])
    }
    // graph names (bottom right)
    g.font = '11px Yu Gothic UI, sans-serif'
    let lxr = W - PAD - 4
    for (const [name, color] of labels.reverse()) {
      g.fillStyle = color
      const w = g.measureText(name).width
      g.fillText(name, lxr - w, gBottom - 4)
      lxr -= w + 12
    }
    // riding-state band (bottom) and legend
    if (riding) {
      for (const sg of riding.segments) {
        if (sg.end < v0 || sg.start > v1) continue
        g.fillStyle = STATE_COLORS[sg.state]
        const a = Math.max(PAD, x(sg.start))
        g.fillRect(a, H - BAND, Math.max(1, Math.min(W - PAD, x(sg.end)) - a), BAND)
      }
      g.font = '10px Yu Gothic UI, sans-serif'
      let lx = PAD
      for (const st of STATES) {
        g.fillStyle = STATE_COLORS[st]
        g.fillRect(lx, gBottom - 12, 8, 8)
        g.fillStyle = '#9aa1ae'
        const name = t(STATE_NAMES[st])
        g.fillText(name, lx + 11, gBottom - 4)
        lx += 18 + g.measureText(name).width
      }
    }
    // keyframes: colored by kind of auto-generated shot (front, corner entry, side, rear, overtake). Hand-placed ones are blue
    for (const k of KEY_ORDER.flatMap((tg) => keyframes.filter((k) => k.tag === tg))) {
      if (k.t < v0 - span * 0.02 || k.t > v1 + span * 0.02) continue
      const kx = x(k.t)
      g.fillStyle = keyColor(k.tag)
      g.beginPath()
      g.moveTo(kx, 16)
      g.lineTo(kx + 6, 22)
      g.lineTo(kx, 28)
      g.lineTo(kx - 6, 22)
      g.closePath()
      g.fill()
    }
    // ranges split into 2 screens because of a bike disturbance (red)
    for (const c of incidents ?? []) {
      if (c.end < v0 || c.start > v1) continue
      g.fillStyle = '#ff4b4b'
      const a = x(c.start)
      g.fillRect(a, 37, Math.max(2, x(c.end) - a), 4)
    }
    // markers (flags)
    for (const m of markers) {
      if (m.t < v0 || m.t > v1) continue
      const mx = x(m.t)
      g.strokeStyle = '#f5b84a'
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(mx, 14)
      g.lineTo(mx, H - BAND)
      g.stroke()
      g.fillStyle = '#f5b84a'
      g.beginPath()
      g.moveTo(mx, 14)
      g.lineTo(mx + 9, 18)
      g.lineTo(mx, 22)
      g.closePath()
      g.fill()
    }
    // playhead
    if (tNow >= v0 && tNow <= v1) {
      const px = x(tNow)
      g.strokeStyle = '#ffffff'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(px, 0)
      g.lineTo(px, H)
      g.stroke()
    }
  })

  // click/drag to seek; wheel to zoom and scroll left and right
  useEffect(() => {
    const c = ref.current!
    let down = false
    const timeAt = (clientX: number): number => {
      const r = c.getBoundingClientRect()
      const { v0, v1 } = viewRef.current
      return v0 + ((clientX - r.left - PAD) / (r.width - 2 * PAD)) * (v1 - v0)
    }
    const seekAt = (e: PointerEvent): void => {
      const r = c.getBoundingClientRect()
      const { v0, v1 } = viewRef.current
      const s = Math.max(0, Math.min(dur, timeAt(e.clientX)))
      // clicking near a keyframe snaps to it
      const near = [...keyframes, ...markers].find((k) => Math.abs(((k.t - s) / (v1 - v0)) * (r.width - 2 * PAD)) < 6)
      const ts = near ? near.t : s
      onSeek(frameOfRef.current ? frameOfRef.current(ts) : Math.round(ts * fps))
    }
    const pd = (e: PointerEvent): void => {
      down = true
      c.setPointerCapture(e.pointerId)
      seekAt(e)
    }
    const pm = (e: PointerEvent): void => {
      if (down) {
        seekAt(e)
        setTip(null)
        return
      }
      // if the pointer is on the keyframe row (above and below the diamond), show a description of the nearest keyframe
      const r = c.getBoundingClientRect()
      const y = e.clientY - r.top
      const { v0, v1 } = viewRef.current
      const IW = r.width - 2 * PAD
      let best: Keyframe | null = null
      let bd = 7
      if (y >= 12 && y <= 32)
        for (const k of keyframes) {
          const d = Math.abs(PAD + ((k.t - v0) / (v1 - v0)) * IW - (e.clientX - r.left))
          if (d < bd) {
            bd = d
            best = k
          }
        }
      // place it right above the mouse cursor
      setTip(best ? { x: e.clientX - r.left, y, k: best } : null)
    }
    const pl = (): void => setTip(null)
    const pu = (): void => {
      down = false
    }
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { v0, v1 } = viewRef.current
      const span = v1 - v0
      const r = c.getBoundingClientRect()
      // horizontal scroll (touchpad) and Shift+wheel: scroll left and right
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (dx) {
        const d = (dx / (r.width - 2 * PAD)) * span
        const next = clampView(v0 + d, v1 + d)
        viewRef.current = next
        setView(next)
        return
      }
      // wheel: zoom centered on the mouse position
      zoomBy(Math.exp(e.deltaY * 0.0015), timeAt(e.clientX))
    }
    c.addEventListener('pointerdown', pd)
    c.addEventListener('pointermove', pm)
    c.addEventListener('pointerup', pu)
    c.addEventListener('pointerleave', pl)
    c.addEventListener('wheel', wheel, { passive: false })
    return () => {
      c.removeEventListener('pointerdown', pd)
      c.removeEventListener('pointermove', pm)
      c.removeEventListener('pointerup', pu)
      c.removeEventListener('pointerleave', pl)
      c.removeEventListener('wheel', wheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dur, fps, keyframes, markers, onSeek])

  // ---- Scrollbar (bottom): drag the thumb to scroll left and right. Pressing outside the thumb jumps there, and you can keep dragging ----
  const barRef = useRef<HTMLDivElement>(null)
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const bar = barRef.current
    if (!bar || !zoomed) return
    e.preventDefault()
    const r = bar.getBoundingClientRect()
    const { v0, v1 } = viewRef.current
    const span = v1 - v0
    const at = ((e.clientX - r.left) / r.width) * dur
    // if pressed outside the thumb, jump so that the pressed point becomes the center of the thumb
    const onThumb = at >= v0 && at <= v1
    const start = onThumb ? v0 : at - span / 2
    const first = clampView(start, start + span)
    viewRef.current = first
    setView(first)
    const x0 = e.clientX
    const move = (ev: PointerEvent): void => {
      const d = ((ev.clientX - x0) / r.width) * dur
      const next = clampView(first.v0 + d, first.v0 + d + span)
      viewRef.current = next
      setView(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="track">
      <canvas ref={ref} />
      {tip && (
        <div className="tl-tip" data-tip="keyframe" style={{ left: Math.max(50, tip.x), top: tip.y - 10 }}>
          <span className="swatch" style={{ background: keyColor(tip.k.tag) }} />
          {tip.k.tag ? t(KEY_TAG_NAMES[tip.k.tag]) : t('Manual / marker')}
        </div>
      )}
      <div ref={barRef} className={`tl-scroll${zoomed ? '' : ' full'}`} data-handle="tl-scroll" onPointerDown={onBarDown} title={zoomed ? t('Drag to scroll left and right') : ''}>
        <div className="thumb" style={{ left: `${(view.v0 / dur) * 100}%`, width: `${((view.v1 - view.v0) / dur) * 100}%` }} />
      </div>
      <div className="tl-zoom">
        <button className="mini" data-action="tl-zoom-out" onClick={() => zoomBy(1.6)} title={t('Zoom out (or use the wheel; Shift+wheel to scroll)')}>
          −
        </button>
        <button className="mini" data-action="tl-zoom-in" onClick={() => zoomBy(1 / 1.6)} title={t('Zoom in (or use the wheel; Shift+wheel to scroll)')}>
          +
        </button>
        <button className="mini" data-action="tl-zoom-fit" onClick={() => setView({ v0: 0, v1: dur })} disabled={!zoomed} title={t('Show all')}>
          {t('All')}
        </button>
      </div>
    </div>
  )
}
