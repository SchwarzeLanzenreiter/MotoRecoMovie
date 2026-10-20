// Compositing one frame: draw each view layer into its own rectangle, then composite the overlay layers last.
// Preview and export both use this, so what you see is what gets exported.
import { incidentEvents, incidentLayout, type IncidentEvent } from '../engine/incident'
import { bodyAt, type BodyTrack } from '../core/bodymap'
import { isFull } from '../engine/layout'
import { CAUSE_NAMES } from '../core/disturb'
import type { Telemetry } from '../core/telemetry'
import type { LensModel } from '../core/lens'
import type { MotionModel } from '../engine/motion-model'
import { viewAt, type Project, type Rect } from '../engine/project'
import { GlReframer, type PixelRect } from './gl-reframe'
import type { Mat3 } from '../core/quat'
import { drawOverlayLayer, overlayFrame } from './overlay'
import { DEFAULT_SIGN_AHEAD, drawCornerSigns } from './signs'
import { roadTrack, type RoadTrack } from '../core/sightline'
import { sampleChannel } from '../core/telemetry'
import { getLang, tr, type Lang } from '../i18n'

/** Road polyline used for the sign visibility test (built once per telemetry) */
const roads = new WeakMap<Telemetry, RoadTrack | null>()
function roadOf(tel: Telemetry): RoadTrack | null {
  if (!roads.has(tel)) roads.set(tel, roadTrack(tel))
  return roads.get(tel) ?? null
}


export interface ViewInfo {
  layerId: string
  correctionDeg: number
}

export function toPixels(r: Rect, w: number, h: number): PixelRect {
  const x = Math.round(r.x * w)
  const y = Math.round(r.y * h)
  return { x, y, w: Math.max(1, Math.round((r.x + r.w) * w) - x), h: Math.max(1, Math.round((r.y + r.h) * h) - y) }
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1]
}

export class Compositor {
  readonly gl: GlReframer
  /** Seam template of the own bike (Session.body; null if absent) */
  body: BodyTrack | null = null
  private ov: OffscreenCanvas
  private og: OffscreenCanvasRenderingContext2D

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = new GlReframer(canvas)
    this.ov = new OffscreenCanvas(2, 2)
    this.og = this.ov.getContext('2d')!
  }

  setLenses(rig: LensModel[]): void {
    this.gl.setLenses(rig)
  }

  upload(frames: [TexImageSource, TexImageSource]): void {
    this.gl.upload(frames)
  }

  private incCache: { key: unknown[]; events: IncidentEvent[] } | null = null

  /** State of the 2-screen layout at time t (null when there is no disturbance detection, it is off, or there is no full-screen main) */
  private incident(project: Project, telemetry: Telemetry | null, motion: MotionModel, t: number): (ReturnType<typeof incidentLayout> & { mainId: string }) | null {
    const s = project.incident
    const d = telemetry?.disturb
    if (!s?.on || !d) return null
    const main = project.layers.find((l) => l.type === 'view' && l.visible && !l.role)
    if (!main || !isFull(main.rect) || !project.layers.some((l) => l.type === 'view' && l.visible && l.role === 'incident')) return null
    const dur = motion.videoTime(motion.frameCount - 1)
    const key = [d, s.threshold, s.pre, s.post, s.minDur, s.transition, s.skip.join(','), dur]
    if (!this.incCache || this.incCache.key.some((k, j) => k !== key[j])) this.incCache = { key, events: incidentEvents(d, s, dur) }
    return { ...incidentLayout(this.incCache.events, s, t), mainId: main.id }
  }

  /** Composites frame i at output size w×h. Returns the correction amount of each view layer */
  render(i: number, project: Project, motion: MotionModel, telemetry: Telemetry | null, w: number, h: number): ViewInfo[] {
    const gl = this.gl
    gl.dynamicSeam = project.stab.dynamicSeam !== false
    gl.blendDeg = project.stab.seamBlend ?? 12
    // For debugging (seamDebug / seamCut in automated tests): switches seam display and the seam-shifting processing
    const dbg = globalThis as { __seamDebug?: number; __seamCut?: boolean }
    gl.debug = dbg.__seamDebug ?? 0
    gl.adaptiveCut = dbg.__seamCut ?? true
    gl.updateSeam(i, gl.dynamicSeam ? motion.downInRig(i) : null)
    gl.begin(w, h)
    const t = motion.videoTime(i)
    // The own-bike parts (top case, license plate, etc.) are drawn with the seam of the template built for each section
    const body = project.stab.bodyStitch === true ? this.body : null
    if (body) {
      const ba = bodyAt(body, t)
      gl.setBody(body.maps[ba.a] ?? null, body.maps[ba.b] ?? null, ba.mix)
    } else gl.setBody(null, null, 0)
    const info: ViewInfo[] = []
    let hasOverlay = false
    const signViews: { l: (typeof project.layers)[number] & { type: 'view' }; v: ReturnType<typeof viewAt>; pr: PixelRect; rot: Mat3 }[] = []
    // Signs are projected with the same camera direction as the video (the map heading is passed to MotionModel beforehand)
    const nav = telemetry?.nav
    motion.setNav(nav && telemetry ? { rate: telemetry.rate, heading: nav.heading, grade: telemetry.channels.grade ?? null } : null)
    // 2-screen layout on a vehicle body disturbance (shrinks the full-screen main and slides in the own-bike screen)
    // Telemetry estimated from the video IMU (no vehicle log) is used only for signs and the FOV, not for the meters or the disturbance display
    const real = telemetry?.source === 'imu' ? null : telemetry
    const inc = this.incident(project, real, motion, t)
    for (const l of project.layers) {
      if (!l.visible) continue
      if (l.type === 'overlay') {
        hasOverlay = true
        continue
      }
      let rect = l.rect
      if (l.role === 'incident') {
        if (!inc || inc.w <= 0) continue
        rect = inc.rider
      } else if (inc && inc.w > 0 && l.id === inc.mainId) rect = inc.main
      const v = viewAt(l.keyframes, t)
      const fp = motion.frame(i, v)
      const pr = toPixels(rect, w, h)
      gl.draw({ view: fp.view, rs: fp.rs, hfovDeg: v.fov }, w, h, pr)
      if (l.border && l.border.width > 0) gl.strokeRect(pr, w, h, l.border.width * Math.min(w, h), hexToRgb(l.border.color))
      if (l.signs && telemetry?.nav && telemetry.corners?.length) {
        const rot = motion.cameraInMap(i, fp.world)
        if (rot) signViews.push({ l, v, pr, rot })
      }
      info.push({ layerId: l.id, correctionDeg: fp.correctionDeg })
    }
    const incLabel = inc && inc.w > 0 && inc.event && project.incident.label ? inc : null
    if (hasOverlay || signViews.length || incLabel) {
      if (this.ov.width !== w || this.ov.height !== h) {
        this.ov.width = w
        this.ov.height = h
      }
      const g = this.og
      g.clearRect(0, 0, w, h)
      // Floating signs in the air (per view; drawn behind overlays such as the meters)
      if (signViews.length && telemetry?.nav && telemetry.corners) {
        const nav = telemetry.nav
        const k = Math.max(0, Math.min(telemetry.n - 2, t * telemetry.rate))
        const k0 = Math.floor(k)
        const f = k - k0
        const lerp = (a: Float32Array): number => a[k0] + (a[k0 + 1] - a[k0]) * f
        for (const sv of signViews) {
          drawCornerSigns(
            g,
            {
              x: lerp(nav.x),
              y: lerp(nav.y),
              alt: sampleChannel(telemetry, 'alt', t) ?? 0,
              rot: sv.rot,
              fov: sv.v.fov,
              rect: sv.pr
            },
            telemetry.corners,
            t,
            sv.l.signStyle ?? 'real',
            sv.l.signAhead ?? DEFAULT_SIGN_AHEAD,
            roadOf(telemetry)
          )
        }
      }
      // Language of the text that goes into the video (the UI language if omitted)
      const lang = project.export.textLang ?? getLang()
      if (incLabel) drawIncidentLabel(g, toPixels(incLabel.rider, w, h), incLabel.event!, incLabel.w, lang)
      const f = overlayFrame(t, real, w, h, lang)
      // Overlays are drawn in layer order (overlays placed behind a view layer also appear on top of the video)
      for (const l of project.layers) if (l.visible && l.type === 'overlay') drawOverlayLayer(g, l, toPixels(l.rect, w, h), f)
      gl.drawOverlay(this.ov, w, h)
    }
    return info
  }
}

/** Shows "disturbance" at the top left of the own-bike screen, along with the strongest indicator */
function drawIncidentLabel(g: OffscreenCanvasRenderingContext2D, r: PixelRect, e: IncidentEvent, w: number, lang: Lang): void {
  const fs = Math.max(10, Math.min(r.w, r.h) * 0.045)
  const pad = fs * 0.5
  const text = tr(lang, 'Disturbance') + '  ' + tr(lang, CAUSE_NAMES[e.cause])
  g.save()
  g.globalAlpha = w
  g.font = `700 ${fs.toFixed(1)}px 'Yu Gothic UI', 'Meiryo UI', sans-serif`
  const tw = g.measureText(text).width
  const x = r.x + fs * 0.8
  const y = r.y + fs * 0.8
  g.fillStyle = 'rgba(10, 10, 14, 0.62)'
  g.beginPath()
  g.roundRect(x, y, tw + pad * 2 + fs * 0.9, fs * 1.6, fs * 0.3)
  g.fill()
  // Warning triangle
  const cx = x + pad + fs * 0.4
  const cy = y + fs * 0.8
  g.fillStyle = '#ffb000'
  g.beginPath()
  g.moveTo(cx, cy - fs * 0.45)
  g.lineTo(cx + fs * 0.45, cy + fs * 0.38)
  g.lineTo(cx - fs * 0.45, cy + fs * 0.38)
  g.closePath()
  g.fill()
  g.fillStyle = '#ffffff'
  g.textBaseline = 'middle'
  g.fillText(text, x + pad + fs * 0.9, cy + fs * 0.03)
  g.restore()
}
