// Data structure of a project (the edits). Saved as JSON.
import type { Caption, PlaceLabel } from '../core/annotations'
import type { SeamFix } from '../core/seamfit'
import { DEFAULT_AUDIO_FX, OLD_DEFAULT_LOWPASS_HZ, type AudioFx } from '../core/audiofx'
import { DEFAULT_INCIDENT, mergeIncident, OLD_RIDER_FOV, RIDER_VIEW, type IncidentSettings } from './incident'
import { t } from '../i18n'
import { DEFAULT_DIRECTOR, mergeDirector, type DirectorSettings, type OvertakeSpan } from './director'

/** Shot-kind marker (for auto-generated shots) */
export type KeyTag = 'front' | 'corner' | 'side' | 'rear' | 'overtake'

export interface Keyframe {
  t: number // video time [s]
  yaw: number // view in body coordinates [deg] (0 = front, positive = right)
  pitch: number // [deg] (positive = down)
  fov: number // horizontal FOV [deg]
  leanRatio: number // fraction of the lean kept on screen (1 = tilts with the bike, 0 = horizon locked). Only effective when a log is present
  /** Interpolate at constant speed up to the next keyframe (smoothly joins closely spaced keyframes, e.g. when following a landmark) */
  linear?: boolean
  /**
   * Shot kind when generated automatically (color-coded on the timeline): front, corner entry, side, rear, overtake (yellow).
   * Not set on manually placed keyframes
   */
  tag?: KeyTag
  /** Put in by auto generation where its range meets the keyframes outside it (so it is not taken for a hand-placed keyframe) */
  joint?: boolean
  /**
   * Way the view turns from the previous keyframe: 1 = to the right (yaw growing), -1 = to the left, even the long way round.
   * The short way round when omitted. Auto generation sets it to turn to the rear through the inside of the corner
   */
  turn?: 1 | -1
}

/**
 * Whether a keyframe was placed (or edited) by hand: auto generation keeps these. Generated ones carry a shot tag, follow a landmark
 * (linear) or join the generated range to the rest (joint)
 */
export const isHandPlaced = (k: Keyframe): boolean => !k.tag && !k.linear && !k.joint

export interface StabSettings {
  enabled: boolean
  sigma: [number, number, number] // smoothing of pitch, yaw and roll [s]
  rollingShutter: boolean
  rollComp: boolean // compensate the roll "lag" using the log lean angle
  /**
   * Lens seam fitting (core/seamfit.ts): correction for lens 1 (rotation and edge angle).
   * undefined = not estimated yet (estimated when opened), null = could not be estimated
   */
  seam?: SeamFix | null
  /** Use seam fitting (default true) */
  seamFix?: boolean
  /** Dynamic stitching: per frame, estimate the distance of the scenery near the seam and correct the parallax caused by the lens position difference (default true) */
  dynamicSeam?: boolean
  /** Seam blur width [deg] (default 12) */
  seamBlend?: number
  /**
   * Own-bike seam template (core/bodymap.ts): things that move with the camera, such as the top case and license plate, are drawn with a seam
   * built by AI per video section (default false: experimental; can help or hurt depending on the scene). The template is saved next to the video as .motorecomovie-body.bin
   */
  bodyStitch?: boolean
  /** AI model that fills the holes (default lama) */
  bodyInpaint?: 'lama' | 'migan'
}

export interface ExportSettings {
  width: number
  height: number
  codec: 'hevc' | 'avc'
  bitrateMbps: number
  inSec: number
  outSec: number // negative = to the end
  /** Language of the text burned into the video (disturbance display, subtitle headings, etc.). Defaults to the UI language when omitted */
  textLang?: 'ja' | 'en'
  /** Opening title at the start of the export range (shown when title or sub is set) */
  title?: OpeningTitle
  /** Picture and sound fade out over the last this many seconds of the export range (0 = no fade; FADE_OUT when omitted) */
  fadeOutSec?: number
}

export interface OpeningTitle {
  text: string
  /** Subtitle below the title, at 1/3 its size */
  sub: string
  /** Seconds shown from the start of the export range */
  dur: number
}

export const TITLE_DUR = 5
export const FADE_OUT = 2

/** Fractions of the output screen (0 to 1). The origin is the top left */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }

interface LayerBase {
  id: string
  name: string
  rect: Rect
  visible: boolean
}

/** Border. The thickness is a fraction of the output short side */
export interface Border {
  width: number
  color: string
}

/** A screen that shows a crop of the 360-degree video. Each one has its own keyframes (view) */
export interface ViewLayer extends LayerBase {
  type: 'view'
  keyframes: Keyframe[]
  border?: Border
  /** Draw the radius of the upcoming corner as a sign floating in the air (needs a vehicle log) */
  signs?: boolean
  /** Sign look: real = like a real road sign, cyber = AR style */
  signStyle?: 'real' | 'cyber'
  /** Sign position: how many meters ahead along the route from the corner entry point (negative = before it; default DEFAULT_SIGN_AHEAD in signs.ts) */
  signAhead?: number
  /** incident = a screen of the "own bike" shown on one side of a 2-screen layout only while a body disturbance occurs (engine/incident.ts) */
  role?: 'incident'
}

/** captions: where the captions are shown (one layer, made when the first caption is added; core/annotations.ts) */
export type WidgetKind = 'chrono' | 'cyber' | 'map' | 'elevation' | 'compass' | 'readout' | 'captions'

/** Removed overlays (meter set, speedometer, tachometer, gear, lean angle, front/rear G, outside temperature). Removed on load if found in a saved project */
export const REMOVED_WIDGETS = ['dashboard', 'speed', 'gear', 'rpm', 'lean', 'gforce', 'temp']

/** A layer that overlays telemetry and the like */
export interface OverlayLayer extends LayerBase {
  type: 'overlay'
  widget: WidgetKind
  props: Record<string, unknown>
}

export type Layer = ViewLayer | OverlayLayer

export interface Project {
  version: 2
  insvPath: string
  logPath: string | null
  /** When logPath is a MotoReco .dat, the conversion rules (.ddf) used for decoding */
  ddfPath?: string | null
  logEnabled: boolean
  stab: StabSettings
  /** Draw order (first is the bottom) */
  layers: Layer[]
  export: ExportSettings
  /** Captions added by hand (shown over the whole frame) */
  captions: Caption[]
  /** Place labels added by hand (a leader line and a name following a point in a view) */
  labels: PlaceLabel[]
  /** Auto camera settings */
  director: DirectorSettings
  /** Overtake sections (result of scanning the video; absent if not scanned yet) */
  overtakes?: OvertakeSpan[]
  /** Version of the detection that produced overtakes (rescan if it differs from OVERTAKE_SCAN_VERSION) */
  overtakesVersion?: number
  /** Settings for automatically switching to 2 screens when a body disturbance occurs */
  incident: IncidentSettings
  /** Tidy the audio while riding (declip, suppress non-engine sound, reduce loudness; core/audiofx.ts) */
  audioFx: AudioFx
  /**
   * Version of the time base. 1 = video time 0 is the first frame (firstFrameUs of the gyro time axis).
   * Projects without it (older versions) used the recorded frame times as-is, so for X5 videos the times are off by 0.77 s, and for the 2nd and later videos of a split recording by 7 to 18 s
   * (fixed on open by shiftProjectTimes; see gyroFrameTimes in core/insv.ts)
   */
  timeBase?: 1
}

export const DEFAULT_KEY: Omit<Keyframe, 't'> = { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }

export const newId = (): string => Math.random().toString(36).slice(2, 10)

export function newViewLayer(name: string, rect: Rect = FULL, view: Omit<Keyframe, 't'> = DEFAULT_KEY): ViewLayer {
  return { id: newId(), type: 'view', name, rect: { ...rect }, visible: true, keyframes: [{ t: 0, ...view }] }
}

export function newProject(insvPath: string): Project {
  return {
    version: 2,
    insvPath,
    logPath: null,
    logEnabled: true,
    stab: { enabled: true, sigma: [0.6, 0.3, 0.2], rollingShutter: true, rollComp: true },
    layers: [newViewLayer(t('Main'))],
    export: { width: 1920, height: 1080, codec: 'hevc', bitrateMbps: 40, inSec: 0, outSec: -1 },
    captions: [],
    labels: [],
    director: structuredClone(DEFAULT_DIRECTOR),
    incident: { ...DEFAULT_INCIDENT },
    audioFx: { ...DEFAULT_AUDIO_FX },
    timeBase: 1
  }
}

/** Shift all video times in the project (keyframes, captions, labels, export range, overtake sections, events excluded from 2-screen) by dt [s] */
export function shiftProjectTimes(p: Project, dt: number): Project {
  if (!dt) return p
  const sh = (x: number): number => Math.round((x + dt) * 1e6) / 1e6
  return {
    ...p,
    layers: p.layers.map((l) => (l.type === 'view' ? { ...l, keyframes: l.keyframes.map((k, i) => (i === 0 && k.t === 0 ? k : { ...k, t: Math.max(0, sh(k.t)) })) } : l)),
    captions: p.captions.map((c) => ({ ...c, t: Math.max(0, sh(c.t)) })),
    labels: p.labels.map((l) => ({ ...l, t: Math.max(0, sh(l.t)) })),
    export: { ...p.export, inSec: p.export.inSec > 0 ? sh(p.export.inSec) : p.export.inSec, outSec: p.export.outSec >= 0 ? sh(p.export.outSec) : p.export.outSec },
    overtakes: p.overtakes?.map((o) => ({ ...o, start: sh(o.start), end: sh(o.end) })),
    incident: { ...p.incident, skip: p.incident.skip.map(sh) }
  }
}

/** Bring a saved project to the latest format (v1: single-view format) */
export function migrateProject(raw: Record<string, unknown>, insvPath: string): Project {
  const base = newProject(insvPath)
  if (raw.version === 1 || (raw.keyframes && !raw.layers)) {
    const { keyframes, ...rest } = raw as { keyframes: Keyframe[] } & Record<string, unknown>
    const main = newViewLayer(t('Main'))
    main.keyframes = keyframes?.length ? keyframes : main.keyframes
    return { ...base, ...(rest as Partial<Project>), version: 2, insvPath, layers: [main] }
  }
  const p = { ...base, ...(raw as Partial<Project>), version: 2 as const, insvPath }
  // Time base: if absent in the saved project it is an older version (fixed to match the video when opened)
  if (raw.timeBase === undefined) delete p.timeBase
  // Fill settings added later with defaults
  p.director = mergeDirector(p.director)
  // Markers (a direction for auto camera to show at a time) were removed: hand-placed keyframes do that with any view
  delete (p as Record<string, unknown>).markers
  p.captions = p.captions ?? []
  p.labels = p.labels ?? []
  // Riding-location commentary (subtitles) is now added by a separate tool and was removed from this app. Contents of old projects are discarded
  delete (p as Record<string, unknown>).commentary
  delete (p as Record<string, unknown>).commentaryLang
  p.layers = p.layers.filter((l) => !(l.type === 'overlay' && (l.widget as string) === 'caption'))
  // Drop layers of the removed overlays (meter set, speedometer to outside temperature)
  p.layers = p.layers.filter((l) => !(l.type === 'overlay' && REMOVED_WIDGETS.includes(l.widget as string)))
  p.incident = mergeIncident(p.incident)
  p.audioFx = { ...DEFAULT_AUDIO_FX, ...p.audioFx }
  if (p.audioFx.lowpassHz === OLD_DEFAULT_LOWPASS_HZ) p.audioFx.lowpassHz = DEFAULT_AUDIO_FX.lowpassHz
  // The "own bike" screen FOV was widened from its old default (new FOV unless changed by hand)
  p.layers = p.layers.map((l) =>
    l.type === 'view' && l.role === 'incident' ? { ...l, keyframes: l.keyframes.map((k) => (k.fov === OLD_RIDER_FOV ? { ...k, fov: RIDER_VIEW.fov } : k)) } : l
  )
  return p
}

export function viewLayers(p: Project): ViewLayer[] {
  return p.layers.filter((l): l is ViewLayer => l.type === 'view')
}

export function findLayer(p: Project, id: string | null): Layer | undefined {
  return p.layers.find((l) => l.id === id)
}

const ease = (x: number): number => x * x * (3 - 2 * x)

/** Interpolate the view at time t from the keyframes (ease-in-out per section; yaw turns the short way) */
export function viewAt(keys: Keyframe[], t: number): Omit<Keyframe, 't'> {
  // Do not include time t in the return value (otherwise the time of keyframes built from it gets overwritten)
  const strip = ({ yaw, pitch, fov, leanRatio }: Keyframe): Omit<Keyframe, 't'> => ({ yaw, pitch, fov, leanRatio })
  if (keys.length === 0) return { ...DEFAULT_KEY }
  const k = [...keys].sort((a, b) => a.t - b.t)
  if (t <= k[0].t) return strip(k[0])
  if (t >= k[k.length - 1].t) return strip(k[k.length - 1])
  let i = 0
  while (k[i + 1].t < t) i++
  const a = k[i]
  const b = k[i + 1]
  const x = (t - a.t) / (b.t - a.t)
  const s = a.linear ? x : ease(x)
  let dy = (((b.yaw - a.yaw) % 360) + 540) % 360 - 180
  if (dy === -180 && b.yaw > a.yaw) dy = 180
  if (b.turn === 1 && dy < 0) dy += 360
  else if (b.turn === -1 && dy > 0) dy -= 360
  return {
    yaw: a.yaw + dy * s,
    pitch: a.pitch + (b.pitch - a.pitch) * s,
    fov: a.fov + (b.fov - a.fov) * s,
    leanRatio: a.leanRatio + (b.leanRatio - a.leanRatio) * s
  }
}
