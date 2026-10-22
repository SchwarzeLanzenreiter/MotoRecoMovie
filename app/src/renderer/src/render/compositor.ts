// Compositing one frame: draw each view layer into its own rectangle, then composite the overlay layers last.
// Preview and export both use this, so what you see is what gets exported.
import { incidentEvents, incidentLayout, type IncidentEvent } from '../engine/incident'
import { bodyAt, type BodyTrack } from '../core/bodymap'
import { bikeCrop, bikeMaskAt, LUT_N, maskAt, MASK_H, MASK_W, type BikeMask, type BikeMaskTrack } from '../core/bikemask'
import { isFull } from '../engine/layout'
import { CAUSE_NAMES } from '../core/disturb'
import type { Telemetry } from '../core/telemetry'
import type { LensModel } from '../core/lens'
import type { MotionModel } from '../engine/motion-model'
import { viewAt, type Project, type Rect } from '../engine/project'
import { GlReframer, type PixelRect, type SignOcclusion, type SignSegmentation } from './gl-reframe'
import { segment } from '../engine/segmenter'
import { MASK_FEAT, SEG_SIZE } from '../core/segment'
import { cropCamera, OWN_CLASSES, OWN_INSIDE, OWN_IOU, OWN_SCORE, planeInCrop } from '../core/owncrop'
import { focalFor, wideK } from './projection'
import type { Mat3 } from '../core/quat'
import { drawOverlayLayer, overlayFrame } from './overlay'
import { DEFAULT_SIGN_AHEAD, drawCornerSigns, type SignBox } from './signs'
import { captionsAt, drawCaptions, drawPlaceLabels, labelsAt } from './annotations'
import { hudTitle, themeOf } from './hud'
import { defaultWidgetRect, enginePower } from './overlay'
import { greyPal } from './theme'
import { FADE_OUT, TITLE_DUR } from '../engine/project'
import { unprojectPoint } from './projection'
import { roadTrack, type RoadTrack } from '../core/sightline'
import { sampleChannel } from '../core/telemetry'
import { getLang, tr, type Lang } from '../i18n'
import { ownAt, platesAt, type OwnPlate, type PlateCache } from '../core/plates'
import { sampleQ } from '../core/motion'
import { qToMat } from '../core/quat'
import { mountAt } from '../core/mount'
import { projectPoint } from './projection'

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

/** Where a view layer was drawn in the last frame and how it looked (to turn a click on it into a direction) */
export interface DrawnView {
  layerId: string
  rect: PixelRect
  /** Output camera -> rig (row-major) and the horizontal field of view [deg] */
  view: Mat3
  fov: number
  /** Output frame size */
  w: number
  h: number
}

/** Direction (rig coordinates) seen at output pixel (x, y) in a drawn view */
export function directionIn(d: DrawnView, x: number, y: number): [number, number, number] {
  const k = wideK(d.fov)
  const c = unprojectPoint(x - (d.rect.x + d.rect.w / 2), y - (d.rect.y + d.rect.h / 2), focalFor(d.rect.w, d.fov), k)
  const V = d.view
  return [V[0] * c[0] + V[1] * c[1] + V[2] * c[2], V[3] * c[0] + V[4] * c[1] + V[5] * c[2], V[6] * c[0] + V[7] * c[1] + V[8] * c[2]]
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
  /** Where the own bike is (signs behind it are hidden). null = signs are drawn over everything */
  bikeMask: BikeMaskTrack | null = null
  /** License plates found in the video (engine/plates.ts) and the own bike's (bike coordinates); pixelated when the project asks */
  plates: { cache: PlateCache; own: OwnPlate[] } | null = null
  /** Plates of the frame last computed: rig directions of the corners (12 numbers each) */
  private platesFrame: { i: number; own: OwnPlate[]; scans: number; rig: number[][] } | null = null
  /** For checking (preview only): show where signs are cut, in blue (outline from the segmentation model) or red (the stretch's masks) */
  showBikeMask = false
  private ov: OffscreenCanvas
  private og: OffscreenCanvasRenderingContext2D
  /** Corner signs of all views, before the own bike is cut out of them on the GPU (GlReframer.drawSigns) */
  private sc = new OffscreenCanvas(2, 2)
  private scg = this.sc.getContext('2d')!
  /** Bike masks in the form drawSigns takes (kept per mask, so the textures are uploaded only when the stretch changes) */
  private occ = new WeakMap<BikeMask, SignOcclusion>()
  /** View layers of the last frame, frontmost last */
  lastViews: DrawnView[] = []

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = new GlReframer(canvas)
    this.ov = new OffscreenCanvas(2, 2)
    this.og = this.ov.getContext('2d')!
  }

  // ---- Outline of the own bike and rider by the segmentation model (engine/segmenter.ts) ----
  // The area where the bike and rider can be (BikeMask.env) is rendered as a square crop facing it, upright with the bike; persons, bicycles and
  // motorcycles found there that lie mostly inside that area are the own bike, rider and passenger (other riders and cars are elsewhere).
  // The model runs beside the drawing: playback uses the latest result up to SEG_STALE frames old; export waits for each frame's (segWait)

  /** Called when a new outline arrives (to redraw a paused frame) */
  onSegmentation: (() => void) | null = null
  private crops = new WeakMap<BikeMask, { dir: [number, number, number]; fov: number } | null>()
  private segResult: { frame: number; bike: BikeMask; seg: SignSegmentation } | null = null
  private segPending: { frame: number; done: Promise<void> } | null = null
  private segFailed = false

  /**
   * Export: wait for each frame's outline, but only for frames whose signs come near the bike (segWait); the model is not run for the others.
   * Playback runs the model all the time, so a recent outline is there when a sign comes near
   */
  exactSegmentation = false
  /** Name of the view whose signs came near the bike in the last frame (null if none; for the export log) */
  nearBikeView: string | null = null
  /** Frame that needs its own outline before it can be exported (set by render, taken by segWait) */
  private segNeed: { frame: number; bike: BikeMask; crop: { dir: [number, number, number]; fov: number }; motion: MotionModel } | null = null

  /** The plates at frame i as quads in the pixels of a view (view: output camera -> rig, drawn into rect r) with their block size */
  private plateQuads(i: number, t: number, motion: MotionModel, view: Mat3, fov: number, r: PixelRect): { pts: number[]; block: number }[] {
    const p = this.plates!
    // Worked out again when the frame changes, or when the scan running in the background found more (also while paused)
    const pf = this.platesFrame
    if (pf?.i !== i || pf.own !== p.own || pf.scans !== p.cache.scans.length) {
      // World -> rig at this frame (transpose of rig -> world)
      const W = qToMat(sampleQ(motion.ori, motion.tc(i)))
      const toRig = (q: number[]): number[] => {
        const out: number[] = []
        for (let k = 0; k < 4; k++) {
          const [x, y, z] = [q[k * 3], q[k * 3 + 1], q[k * 3 + 2]]
          out.push(W[0] * x + W[3] * y + W[6] * z, W[1] * x + W[4] * y + W[7] * z, W[2] * x + W[5] * y + W[8] * z)
        }
        return out
      }
      // Bike -> rig (the mount orientation at this frame)
      const M = mountAt(motion.mount, motion.tc(i))
      const fromBike = (q: number[]): number[] => {
        const out: number[] = []
        for (let k = 0; k < 4; k++) {
          const [x, y, z] = [q[k * 3], q[k * 3 + 1], q[k * 3 + 2]]
          out.push(M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z)
        }
        return out
      }
      this.platesFrame = { i, own: p.own, scans: p.cache.scans.length, rig: [...platesAt(p.cache.scans, t).map(toRig), ...p.own.map((o) => fromBike(ownAt(o, t)))] }
    }
    const focal = focalFor(r.w, fov)
    const k = wideK(fov)
    const out: { pts: number[]; block: number }[] = []
    for (const q of this.platesFrame!.rig) {
      const pts: number[] = []
      for (let j = 0; j < 4; j++) {
        const d = [q[j * 3], q[j * 3 + 1], q[j * 3 + 2]]
        // Camera coordinates = viewᵀ · d (the columns of view are the camera axes in rig coordinates)
        const c = [view[0] * d[0] + view[3] * d[1] + view[6] * d[2], view[1] * d[0] + view[4] * d[1] + view[7] * d[2], view[2] * d[0] + view[5] * d[1] + view[8] * d[2]]
        const s = projectPoint(c, focal, k)
        if (!s) break
        pts.push(r.x + r.w / 2 + s[0], r.y + r.h / 2 + s[1])
      }
      if (pts.length < 8) continue
      const xs = [pts[0], pts[2], pts[4], pts[6]]
      const ys = [pts[1], pts[3], pts[5], pts[7]]
      if (Math.max(...xs) < r.x || Math.min(...xs) > r.x + r.w || Math.max(...ys) < r.y || Math.min(...ys) > r.y + r.h) continue
      // About six blocks across the plate, so nothing on it can be read
      const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
      out.push({ pts, block: Math.max(4, size / 6) })
    }
    return out
  }

  private segmentation(i: number, bike: BikeMask, motion: MotionModel, nearBike: boolean): SignSegmentation | null {
    this.segNeed = null
    if (this.segFailed) return null
    if (!this.crops.has(bike)) this.crops.set(bike, bikeCrop(bike))
    const crop = this.crops.get(bike)
    if (!crop) return null
    const r = this.segResult
    const fresh = r && r.frame === i && r.bike === bike
    if (this.exactSegmentation) {
      // Only this frame's outline counts; signs away from the bike need none
      if (!nearBike) return null
      if (!fresh) this.segNeed = { frame: i, bike, crop, motion }
      return fresh ? r.seg : null
    }
    if (!this.segPending && !fresh) this.requestSegmentation(i, bike, crop, motion)
    return r && r.bike === bike && Math.abs(r.frame - i) <= SEG_STALE ? r.seg : null
  }

  private requestSegmentation(i: number, bike: BikeMask, crop: { dir: [number, number, number]; fov: number }, motion: MotionModel): void {
    const view = cropCamera(crop.dir, motion.bodyInRig(i))
    const rgba = this.gl.renderCrop(view, crop.fov, SEG_SIZE)
    const rgbaCopy = rgba.slice()
    const prior = planeInCrop(bike.env, view, crop.fov)
    // The sure part of the bike: what is kept has to connect to it (a pole or person in the distance is not the rider)
    const anchor = planeInCrop(bike.core, view, crop.fov)
    // The rider sits right behind (or in front of) the passenger, partly hidden: keep overlapping persons and weaker ones too, their outlines are joined
    const done = segment(rgba, OWN_CLASSES, { scoreThr: OWN_SCORE, iou: OWN_IOU, masks: true, prior, inside: OWN_INSIDE, anchor })
      .then((found) => {
        const mask = new Uint8Array(OUT * OUT)
        for (const f of found) if (f.mask) upsampleInto(f.mask, mask)
        // For checking (autotest segDump): the crop with the outline kept (blue), where the bike and rider can be (green) and where it surely is (red)
        {
          const dump = (globalThis as { __segDump?: string }).__segDump
          if (dump) {
            const cv = new OffscreenCanvas(SEG_SIZE, SEG_SIZE)
            const g2 = cv.getContext('2d')!
            const id = g2.createImageData(SEG_SIZE, SEG_SIZE)
            id.data.set(rgbaCopy)
            for (let y = 0; y < SEG_SIZE; y++) for (let x = 0; x < SEG_SIZE; x++) {
              const m = mask[((y * OUT) / SEG_SIZE | 0) * OUT + ((x * OUT) / SEG_SIZE | 0)]
              const pa = prior[((y * MASK_FEAT) / SEG_SIZE | 0) * MASK_FEAT + ((x * MASK_FEAT) / SEG_SIZE | 0)]
              const an = anchor[((y * MASK_FEAT) / SEG_SIZE | 0) * MASK_FEAT + ((x * MASK_FEAT) / SEG_SIZE | 0)]
              const o = (y * SEG_SIZE + x) * 4
              if (m >= 128) id.data[o + 2] = 255
              if (pa && (x + y) % 6 === 0) id.data[o + 1] = 255
              if (an && (x + y) % 6 === 3) id.data[o] = 255
            }
            g2.putImageData(id, 0, 0)
            void cv.convertToBlob({ type: 'image/png' }).then(async (b) => window.api.writeBinary(dump + '-' + i + '.png', new Uint8Array(await b.arrayBuffer())))
          }
        }
        this.segResult = { frame: i, bike, seg: { mask, size: OUT, view, fov: crop.fov } }
        this.onSegmentation?.()
      })
      .catch((e) => {
        // Without the model (not fetched) or a working runtime, signs are cut by the bike masks alone
        this.segFailed = true
        console.warn('Segmentation of the own bike is not available', e)
      })
      .finally(() => {
        if (this.segPending?.done === done) this.segPending = null
      })
    this.segPending = { frame: i, done }
  }

  private probe = new OffscreenCanvas(NEAR_GRID, NEAR_GRID)
  private probeG = this.probe.getContext('2d', { willReadFrequently: true })!

  /**
   * Whether a sign drawn in this view (on the signs canvas, within box) covers a place where the bike or rider can be (env).
   * The drawn pixels count, not the box: a sign's box reaches from its plate down to the foot of its post and often overlaps the bike
   * while the sign itself is well away from it (the plate high up, a thin post beside the bike). The box is shrunk to a small grid
   * (each cell averages its pixels, so a thin post still shows) and each cell holding sign is looked up in env
   */
  private signsNearBike(box: SignBox, pr: PixelRect, view: Mat3, fov: number, env: Uint8Array): boolean {
    const bw = box.x1 - box.x0
    const bh = box.y1 - box.y0
    const gw = Math.max(1, Math.min(NEAR_GRID, Math.ceil(bw)))
    const gh = Math.max(1, Math.min(NEAR_GRID, Math.ceil(bh)))
    const g = this.probeG
    g.clearRect(0, 0, NEAR_GRID, NEAR_GRID)
    g.drawImage(this.sc, box.x0, box.y0, bw, bh, 0, 0, gw, gh)
    const a = g.getImageData(0, 0, gw, gh).data
    const k = wideK(fov)
    const fk = focalFor(pr.w, fov) * (1 + k)
    const cx = pr.x + pr.w / 2
    const cy = pr.y + pr.h / 2
    const V = view
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        if (a[(j * gw + i) * 4 + 3] < 8) continue
        // Inverse of projectPoint (projection.ts): screen offset -> ray of the view camera
        const sx = box.x0 + ((i + 0.5) * bw) / gw - cx
        const sy = box.y0 + ((j + 0.5) * bh) / gh - cy
        const r = Math.hypot(sx, sy)
        const th = Math.atan(r / fk) * (1 + k)
        const s = r > 1e-9 ? Math.sin(th) / r : 0
        const x = sx * s
        const y = sy * s
        const z = Math.cos(th)
        if (maskAt(env, V[0] * x + V[1] * y + V[2] * z, V[3] * x + V[4] * y + V[5] * z, V[6] * x + V[7] * y + V[8] * z) > 0) return true
      }
    }
    return false
  }

  /** For export: when frame i has signs near the bike and its outline is not there yet, make it (then draw the frame again) */
  segWait(i: number): Promise<void> | null {
    const need = this.segNeed
    if (!need || need.frame !== i) return null
    this.segNeed = null
    return (async () => {
      // Already asked for this frame (prefetchSegmentation)
      if (this.segPending?.frame === i) return this.segPending.done
      if (this.segPending) await this.segPending.done
      const r = this.segResult
      if (this.segFailed || (r && r.frame === i && r.bike === need.bike)) return
      this.requestSegmentation(i, need.bike, need.crop, need.motion)
      await this.segPending?.done
    })()
  }

  /**
   * For export: start making frame i's outline right after its upload, before drawing it (when the frame before needed one, this one most
   * likely does too; the model then runs while the frame is drawn once instead of after it)
   */
  prefetchSegmentation(i: number, motion: MotionModel): void {
    if (this.segFailed || this.segPending || !this.bikeMask) return
    const bike = bikeMaskAt(this.bikeMask, motion.videoTime(i))
    if (!bike) return
    if (!this.crops.has(bike)) this.crops.set(bike, bikeCrop(bike))
    const crop = this.crops.get(bike)
    if (crop) this.requestSegmentation(i, bike, crop, motion)
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
    const drawn: DrawnView[] = []
    let hasOverlay = false
    const signViews: { l: (typeof project.layers)[number] & { type: 'view' }; v: ReturnType<typeof viewAt>; pr: PixelRect; rot: Mat3; view: Mat3; order: number }[] = []
    /** Rectangles of the view layers in drawing order (signs of a view are hidden where a later view covers it) */
    const viewRects: PixelRect[] = []
    // Signs are projected with the same camera direction as the video (the map heading is passed to MotionModel beforehand)
    const nav = telemetry?.nav
    motion.setNav(
      nav && telemetry
        ? { rate: telemetry.rate, heading: nav.heading, grade: telemetry.channels.grade ?? null, speed: telemetry.channels.speed ?? null }
        : null
    )
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
      // License plates pixelated in this view, before anything is drawn over it
      if (this.plates && project.export.plates !== false) gl.drawMosaic(w, h, pr, this.plateQuads(i, t, motion, fp.view, v.fov, pr))
      viewRects.push(pr)
      if (l.border && l.border.width > 0) gl.strokeRect(pr, w, h, l.border.width * Math.min(w, h), hexToRgb(l.border.color))
      if (l.signs && telemetry?.nav && telemetry.corners?.length) {
        const rot = motion.cameraInMap(i, fp.world)
        if (rot) signViews.push({ l, v, pr, rot, view: fp.view, order: viewRects.length - 1 })
      }
      info.push({ layerId: l.id, correctionDeg: fp.correctionDeg })
      drawn.push({ layerId: l.id, rect: pr, view: fp.view, fov: v.fov, w, h })
    }
    this.lastViews = drawn
    const incLabel = inc && inc.w > 0 && inc.event && project.incident.label ? inc : null
    const labels = drawn.some((d) => labelsAt(project.labels, d.layerId, t))
    // Captions are drawn by their overlay layer; without one (deleted), at its default place
    const captions = captionsAt(project.captions, t) && !project.layers.some((l) => l.type === 'overlay' && l.widget === 'captions')
    // Opening title from the start of the export range, and the fade to black over its end
    const ex = project.export
    const tIn = Math.max(0, ex.inSec)
    const title = ex.title && (ex.title.text.trim() || ex.title.sub.trim()) && t >= tIn && t <= tIn + (ex.title.dur || TITLE_DUR) ? ex.title : null
    const tEnd = ex.outSec < 0 ? motion.videoTime(motion.frameCount - 1) : ex.outSec
    const fadeSec = ex.fadeOutSec ?? FADE_OUT
    const fade = fadeSec > 0 && t > tEnd - fadeSec && t <= tEnd + 0.5 ? Math.min(1, (t - (tEnd - fadeSec)) / fadeSec) : 0
    if (hasOverlay || signViews.length || incLabel || labels || captions || title || fade > 0) {
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
        const bike = this.bikeMask ? bikeMaskAt(this.bikeMask, t) : null
        // With the bike masks, the signs are drawn aside and put over the video on the GPU with the own bike and rider cut out
        const sg = bike ? this.scg : g
        if (bike) {
          if (this.sc.width !== w || this.sc.height !== h) {
            this.sc.width = w
            this.sc.height = h
          }
          sg.clearRect(0, 0, w, h)
        }
        const drawnViews: { rect: PixelRect; view: Mat3; fov: number; above: PixelRect[] }[] = []
        // Whether a sign is drawn where the bike or rider can be (then export waits for this frame's outline)
        let nearBike = false
        this.nearBikeView = null
        const box: SignBox = { x0: 0, y0: 0, x1: 0, y1: 0 }
        for (const sv of signViews) {
          const drawn = drawCornerSigns(
            sg,
            { x: lerp(nav.x), y: lerp(nav.y), alt: sampleChannel(telemetry, 'alt', t) ?? 0, rot: sv.rot, fov: sv.v.fov, rect: sv.pr },
            telemetry.corners,
            t,
            themeOf(project),
            sv.l.signAhead ?? DEFAULT_SIGN_AHEAD,
            roadOf(telemetry),
            box
          )
          if (!drawn) continue
          // Signs are above all views: erase this view's signs where a view drawn later (picture in picture, split screen) covers it
          for (const r of viewRects.slice(sv.order + 1)) sg.clearRect(r.x, r.y, r.w, r.h)
          if (bike && !nearBike && box.x1 > box.x0 && box.y1 > box.y0) {
            nearBike = this.signsNearBike(box, sv.pr, sv.view, sv.v.fov, bike.env)
            if (nearBike) this.nearBikeView = sv.l.name
          }
          drawnViews.push({ rect: sv.pr, view: sv.view, fov: sv.v.fov, above: viewRects.slice(sv.order + 1) })
        }
        // For checking: the cut area on every view with signs
        const show = this.showBikeMask
        // The sphere of this frame, kept to see what flows by (every frame while there are signs, so it is ready when one comes near the bike)
        if (bike) gl.updateMotion(i)
        if (bike && (drawnViews.length || show)) {
          let o = this.occ.get(bike)
          if (!o) {
            o = { ...bike, width: MASK_W, height: MASK_H, lutN: LUT_N }
            this.occ.set(bike, o)
          }
          // Outline of the own bike and rider from the segmentation model (a recent result; a new one is asked for this frame)
          const seg = this.segmentation(i, bike, motion, nearBike)
          gl.drawSigns(this.sc, w, h, show ? signViews.map((sv) => ({ rect: sv.pr, view: sv.view, fov: sv.v.fov, above: viewRects.slice(sv.order + 1) })) : drawnViews, o, show, seg)
        }
      }
      // Everything over the video is drawn in the project's design theme
      const theme = themeOf(project)
      // Place labels of each view (hidden where a view drawn later covers it)
      if (labels) drawn.forEach((d, k) => drawPlaceLabels(g, project.labels, d.layerId, t, d.rect, d.view, d.fov, drawn.slice(k + 1).map((x) => x.rect), theme))
      // Language of the text that goes into the video (the UI language if omitted)
      const lang = project.export.textLang ?? getLang()
      if (incLabel) drawIncidentLabel(g, toPixels(incLabel.rider, w, h), incLabel.event!, incLabel.w, lang)
      const f = overlayFrame(t, real, w, h, lang, theme)
      f.captions = project.captions
      // Overlays are drawn in layer order (overlays placed behind a view layer also appear on top of the video)
      for (const l of project.layers) if (l.visible && l.type === 'overlay') drawOverlayLayer(g, l, toPixels(l.rect, w, h), f)
      if (captions) drawCaptions(g, project.captions, t, toPixels(defaultWidgetRect('captions', w / h), w, h), theme)
      if (title) {
        // Grey while the engine is stopped and back to color as it starts, like the meter (with a vehicle log that has rpm)
        const power = enginePower(real, t)
        hudTitle(g, title.text, title.sub, w, h, t - tIn, title.dur || TITLE_DUR, theme, power < 1 ? greyPal(theme.pal, 1 - Math.max(0, power)) : theme.pal)
      }
      // Fade to black over the end of the export range (the sound fades with it in the export)
      if (fade > 0) {
        g.fillStyle = `rgba(0, 0, 0, ${fade.toFixed(3)})`
        g.fillRect(0, 0, w, h)
      }
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

/**
 * How many frames old an outline may be during playback. The model takes a few frames per run, sometimes more; switching to the bike masks
 * in between would make the cut flicker, and the rider moves little in a second
 */
const SEG_STALE = 50
/** Grid the signs of a view are shrunk to when checking whether they cover the bike (Compositor.signsNearBike) */
const NEAR_GRID = 96

/** Size of the outline handed to the GPU: the model's mask grid upsampled twice */
const OUT = MASK_FEAT * 2

/**
 * Upsample an instance mask (MASK_FEAT square probabilities) twice into out (0..255, max with what is there). Interpolated as logits, as
 * mmdetection does before thresholding: the 0.5 contour follows the model better than interpolating the probabilities
 */
function upsampleInto(m: Float32Array, out: Uint8Array): void {
  const n = MASK_FEAT
  const logit = new Float32Array(n * n)
  for (let p = 0; p < n * n; p++) {
    const v = Math.min(1 - 1e-6, Math.max(1e-6, m[p]))
    logit[p] = Math.log(v / (1 - v))
  }
  for (let y = 0; y < OUT; y++) {
    const fy = Math.min(n - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
    const y0 = Math.min(n - 2, Math.floor(fy))
    const ty = fy - y0
    for (let x = 0; x < OUT; x++) {
      const fx = Math.min(n - 1, Math.max(0, (x + 0.5) / 2 - 0.5))
      const x0 = Math.min(n - 2, Math.floor(fx))
      const tx = fx - x0
      const a = logit[y0 * n + x0] * (1 - tx) + logit[y0 * n + x0 + 1] * tx
      const b = logit[(y0 + 1) * n + x0] * (1 - tx) + logit[(y0 + 1) * n + x0 + 1] * tx
      const z = a * (1 - ty) + b * ty
      const v = Math.round(255 / (1 + Math.exp(-z)))
      const o = y * OUT + x
      if (v > out[o]) out[o] = v
    }
  }
}

