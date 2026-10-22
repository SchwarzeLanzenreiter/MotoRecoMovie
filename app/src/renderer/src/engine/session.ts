// Groups the state of one opened .insv (decoders, attitude, log).
import { keyframeBefore } from '../core/mp4'
import { withSeamFix, type SeamFitResult, type SeamFrame } from '../core/seamfit'
import { openLocal } from '../core/file'
import { InsvTrailer, type Imu, type InsvMeta } from '../core/insv'
import { makeRig, type LensModel } from '../core/lens'
import { gravityTrack, integrate, type Orientation } from '../core/motion'
import { estimateMountTrack, type MountTrack } from '../core/mount'
import type { ImuTelemetry } from '../core/imu-telemetry'
import { cameraRollRate, type LeanTrack, type SyncResult } from '../core/motoreco'
import { DAT_RECORD, datDurationFromTail, datStartFromName } from '../core/motoreco-dat'
import type { Telemetry } from '../core/telemetry'
import type { BodyTrack } from '../core/bodymap'
import type { BikeMaskTrack } from '../core/bikemask'
import type { OwnPlate, PlateCache, PlateMark } from '../core/plates'
import { ownPlatesOf } from './plates'
import type { FxAudio } from './audiofx'
import { analyzeLog, localizeError, scoreDatInWorker, seamFitInWorker, imuTelemetryInWorker } from './analysis'
import { demux, type FileReader, type Track } from '../core/mp4'
import type { Mat3 } from '../core/quat'
import { decodeFrames, decodeKeyframes, TrackDecoder } from './decoder'
import { MotionModel } from './motion-model'
import type { StabSettings } from './project'
import { t } from '../i18n'
import { GlReframer } from '../render/gl-reframe'
import { CLOSER_SPAN, CLOSER_STEP, findLaneCrossings, LANE_VIEW, laneSide, needsCloserLook, observeLanes, ownSide, type LaneCrossing, type LaneSample } from '../core/lanes'
import { findOvertakes, OVERTAKE, vehicleAround, type Overtake } from '../core/overtake'
import { DET_SIZE, sightingFromBox, type VehicleSighting } from '../core/vehicles'
import { segment } from './segmenter'
import { VEHICLE_CLASSES } from '../core/vehicles'

export interface LogInfo {
  path: string
  /** When .dat, the conversion rules (.ddf) used for decoding */
  ddfPath: string | null
  /** Built-in rules that were in the .ddf but could not be converted */
  unsupported: string[]
  sync: SyncResult
  lean: LeanTrack
  telemetry: Telemetry
  gpsDelay: { delay: number; corr: number }
}

/**
 * Lane crossings shorter than this [s] are quick overtakes: if a vehicle is seen around one at the keyframes, vehicles are also looked for
 * between the keyframes, every VEHICLE_STEP [s]
 */
const SHORT_CROSSING = 4
const VEHICLE_STEP = 0.25

export class Session {
  decoders!: [TrackDecoder, TrackDecoder] // [lens 0, lens 1]
  audioTrack: Track | null = null
  file!: FileReader
  meta!: InsvMeta
  /** Lens used for rendering (including seam fitting) */
  rig!: LensModel[]
  /** Lens as calibrated */
  baseRig!: LensModel[]
  private seamKey = ''
  imu!: Imu
  ori!: Orientation
  /** Camera mount attitude (may change over time. core/mount.ts) */
  mount!: MountTrack
  /** Mount attitude from the IMU alone (starting point when the log is re-read) */
  private imuMount!: MountTrack
  frameTimes!: Float64Array
  motion!: MotionModel
  log: LogInfo | null = null
  /** Seam template of the own bike (engine/bodymap.ts. null until built or when not used) */
  body: BodyTrack | null = null
  /** Where the own bike and rider are, to hide corner signs behind them (engine/bikemask.ts. null until built) */
  bikeMask: BikeMaskTrack | null = null
  /** License plates found so far (engine/plates.ts) and the own bike's (quads in bike coordinates), set by the app */
  plates: { cache: PlateCache; own: OwnPlate[] } | null = null
  /** The own bike's plate marked by hand (from the project, set by the app) */
  plateMarks: PlateMark[] = []
  /** Cleaned-up audio (engine/audiofx.ts. null until built or when unused = the video's original audio) */
  fxAudio: FxAudio | null = null

  /** Replaces the cleaned-up audio (the previous one is closed) */
  async setFxAudio(a: FxAudio | null): Promise<void> {
    const old = this.fxAudio
    this.fxAudio = a
    if (old && old !== a) await old.file.close().catch(() => undefined)
  }
  fps = 50
  /** Path of the opened .insv */
  path = ''
  /**
   * Offset [s] from the video time of the earlier version (recorded times as is). Adding it to the times of a project saved with the earlier version gives the current video time
   * (0 for a normal X6 video, 0.77 s etc. for the X5)
   */
  legacyTimeShiftSec = 0
  private closeFile: () => Promise<void> = async () => undefined

  static async open(path: string, stab: StabSettings, onProgress?: (msg: string) => void): Promise<Session> {
    try {
      return await Session.openInner(path, stab, onProgress)
    } catch (e) {
      // Errors from core (mp4, insv) are thrown as raw English templates, so convert them to the UI language
      if (e instanceof Error) throw new Error(localizeError(e.message), { cause: e })
      throw e
    }
  }

  private static async openInner(path: string, stab: StabSettings, onProgress?: (msg: string) => void): Promise<Session> {
    const s = new Session()
    s.path = path
    const step = (m: string): void => onProgress?.(m)
    step(t('Opening file'))
    const f = await openLocal(path)
    s.closeFile = f.close
    s.file = f
    const tracks = await demux(f)
    const videos = tracks.filter((t) => t.kind === 'video')
    if (videos.length !== 2) throw new Error(t('Found {n} video tracks (an X6 .insv has 2)', { n: videos.length }))
    s.audioTrack = tracks.find((t) => t.kind === 'audio') ?? null
    step(t('Reading metadata'))
    const tr = await InsvTrailer.open(f)
    s.meta = tr.meta
    s.fps = tr.meta.fps
    // stream_type 4 = tracks are in reverse lens order (X5/X6)
    const order = tr.meta.streamType === 4 ? [1, 0] : [0, 1]
    s.decoders = [new TrackDecoder(f, videos[order[0]]), new TrackDecoder(f, videos[order[1]])]
    s.baseRig = makeRig(tr.meta.calibration, videos[0].width)
    s.rig = s.baseRig
    step(t('Reading gyro data'))
    s.imu = await tr.imu()
    // Frame times (gyro time axis). For videos whose recorded times are offset from firstFrameUs (X5, second and later parts of a split recording), correct by that amount
    const rawTimes = await tr.frameTimes(0)
    s.frameTimes = await tr.gyroFrameTimes(0)
    s.legacyTimeShiftSec = rawTimes.length ? (s.frameTimes[0] - rawTimes[0]) / 1e6 : 0
    // Mount attitude: forward = direction of travel, up = body up when not leaning. If the camera direction changed while riding, per time
    s.mount = estimateMountTrack(s.imu)
    s.imuMount = s.mount
    console.log(
      `Mount attitude: ${s.mount.fixed ? 'one for the whole video' : 'per time'} (max change within the video ${s.mount.maxDeg.toFixed(0)}°), front/back direction from ${s.mount.by === 'lean' ? 'the leans-into-the-turn relationship' : 'the lens direction'}`
    )
    s.ori = integrate(s.imu)
    s.motion = new MotionModel(s.meta, s.ori, s.mount, s.frameTimes, null, stab)
    s.motion.setGravity(gravityTrack(s.imu, s.ori))
    return s
  }

  /** Applies the seam fitting from the stabilization settings. Returns true if the lens changed */
  applySeam(stab: StabSettings): boolean {
    const fix = stab.seamFix !== false ? (stab.seam ?? null) : null
    const key = fix ? [...fix.rot, fix.edge].join(',') : ''
    if (key === this.seamKey) return false
    this.seamKey = key
    this.rig = withSeamFix(this.baseRig, fix)
    return true
  }

  /**
   * For seam fitting, reads frames at several places in the video as shrunken gray images for both lenses
   * (the keyframe just before each of count equally spaced positions between 10 and 90% of the video; size square).
   * Uses a dedicated decoder so as not to interfere with the preview, and reads only keyframes, so it is fast
   */
  async seamFrames(count = 5, size = 960): Promise<SeamFrame[]> {
    const c = new OffscreenCanvas(size, size)
    const g = c.getContext('2d', { willReadFrequently: true })!
    const decs = this.decoders.map((d) => new TrackDecoder(this.file, d.track))
    const out: SeamFrame[] = []
    try {
    for (let k = 0; k < count; k++) {
      const i = keyframeBefore(this.decoders[0].track, Math.round(this.frameCount * (0.1 + (0.8 * k) / Math.max(1, count - 1))))
      const img: Float32Array[] = []
      for (const d of decs) {
        const vf = await d.get(i)
        g.drawImage(vf, 0, 0, size, size)
        vf.close()
        const px = g.getImageData(0, 0, size, size).data
        const a = new Float32Array(size * size)
        for (let p = 0; p < a.length; p++) a[p] = (0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2]) / 255
        img.push(a)
      }
      out.push({ size, img: [img[0], img[1]] })
    }
    } finally {
      for (const d of decs) d.close()
    }
    return out
  }

  /** Estimates the seam fitting (the lens 1 correction at which the overlap band matches best) */
  async estimateSeam(): Promise<SeamFitResult> {
    return seamFitInWorker(this.baseRig, await this.seamFrames())
  }

  /** Frame closest to video time t [s] (by actual frame times. Rounding time × fps can be off by one frame because of recording offsets) */
  frameOf(t: number): number {
    let lo = 0
    let hi = this.frameCount - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (this.motion.videoTime(m) < t) lo = m
      else hi = m
    }
    return Math.abs(this.motion.videoTime(lo) - t) <= Math.abs(this.motion.videoTime(hi) - t) ? lo : hi
  }

  get frameCount(): number {
    return this.frameTimes.length
  }

  /**
   * Loads the MotoReco log (MotoRecoViewer CSV, or a .dat decoded with the .ddf rules) and
   * performs synchronization, lean angle fusion, and telemetry construction on the analysis thread
   */
  async loadLog(path: string, ddfPath: string | null, onProgress?: (msg: string) => void): Promise<LogInfo> {
    onProgress?.(t('Loading log'))
    const isDat = isDatPath(path)
    if (isDat && !ddfPath) throw new Error(t('To read a .dat, choose the decoding rules (.ddf)'))
    const base = { imu: this.imu, mount: this.imuMount, firstFrameUs: this.meta.firstFrameUs, durationSec: this.frameCount / this.fps }
    const r = await analyzeLog(
      isDat ? { ...base, dat: { buf: await readBinary(path), ddfText: await window.api.readText(ddfPath!) } } : { ...base, csvText: await window.api.readText(path) },
      onProgress
    )
    console.log('Log analysis breakdown [ms]', JSON.stringify(r.timingMs))
    if (r.unsupported.length) console.log('Rules that could not be converted', r.unsupported.join(', '))
    this.log = { path, ddfPath: isDat ? ddfPath : null, unsupported: r.unsupported, sync: r.sync, lean: r.lean, telemetry: r.telemetry, gpsDelay: r.gpsDelay }
    // Replace with the mount attitude refined using the log (forward = direction of travel, up = body up when not leaning)
    this.mount = r.mount
    this.motion.setMount(r.mount)
    if (this.plates) this.plates.own = ownPlatesOf(this)
    console.log(`Mount attitude refined with the log: ${r.mount.fixed ? 'one for the whole video' : 'per time'} (max change ${r.mount.maxDeg.toFixed(0)}°)`)
    this.motion.setLean(r.lean)
    return this.log
  }

  /**
   * Telemetry used for display, auto camera, and signs. When there is no vehicle log (disabled), it is the one estimated from the video's IMU
   * (after loadImuTelemetry. source = 'imu'. Not used for meters)
   */
  telemetry(enabled: boolean): Telemetry | null {
    return enabled && this.log ? this.log.telemetry : (this.imuTel?.telemetry ?? null)
  }

  /** Estimate used when there is no vehicle log (from the video's IMU). Computed with loadImuTelemetry after opening */
  imuTel: ImuTelemetry | null = null

  /**
   * So that auto camera, floating signs, and horizon correction work without a vehicle log, estimates lean angle, vehicle speed, riding state, and corners from the video's IMU
   * (core/imu-telemetry.ts. 0.3-0.5 s on the analysis thread). If no log has been loaded, this lean angle is used for horizon correction
   */
  async loadImuTelemetry(): Promise<ImuTelemetry> {
    if (this.imuTel) return this.imuTel
    this.imuTel = await imuTelemetryInWorker({ imu: this.imu, mount: this.imuMount, firstFrameUs: this.meta.firstFrameUs, durationSec: this.frameCount / this.fps })
    if (!this.log || !this.logEnabled) this.motion.setLean(this.imuTel.lean)
    return this.imuTel
  }

  private logEnabled = true

  /** Discards the loaded vehicle log (when it could not be synchronized with the video) */
  clearLog(): void {
    this.log = null
    this.setLogEnabled(this.logEnabled)
  }

  setLogEnabled(on: boolean): void {
    this.logEnabled = on
    this.motion.setLean(on && this.log ? this.log.lean : (this.imuTel?.lean ?? null))
  }

  /** Finds a MotoReco CSV in the same folder */
  static async findLog(insvPath: string): Promise<string | null> {
    const dir = window.api.path.dirname(insvPath)
    const files = await window.api.listDir(dir)
    for (const name of files) {
      if (!name.toLowerCase().endsWith('.csv')) continue
      const p = window.api.path.join(dir, name)
      const { id } = await window.api.open(p, 'r')
      const head = new TextDecoder().decode(await window.api.read(id, 0, 64))
      await window.api.close(id)
      if (head.startsWith('TO Custom') || head.startsWith('time (ms)')) return p
    }
    return null
  }

  /**
   * Examines, for each keyframe of the video (about every 1 second), which side of the lane the bike is riding on (core/lanes.ts).
   * Draws a small image looking down at the road ahead and decides left/right of the center line. Lone samples in the opposite lane are looked at again between the keyframes (needsCloserLook). Takes about 2 minutes for a 20-minute video
   */
  async scanLanes(onProgress?: (frac: number) => void, signal?: AbortSignal): Promise<LaneSample[]> {
    const { width: w, height: h } = LANE_VIEW
    const keys = this.keyframeIndices()
    const gl = new GlReframer(new OffscreenCanvas(w, h))
    gl.setLenses(this.rig)
    gl.dynamicSeam = false
    const buf = new Uint8Array(w * h * 4)
    const img = new Uint8Array(w * h * 4)
    const out: LaneSample[] = []
    let done = 0
    const observe = (i: number, fs: VideoFrame[]): void => {
      gl.upload([fs[0], fs[1]])
      // Look down at the road ahead with the horizon and lean undone
      const fp = this.motion.frame(i, { yaw: 0, pitch: LANE_VIEW.pitch, fov: LANE_VIEW.fov, leanRatio: 0 })
      gl.draw({ view: fp.view, rs: fp.rs, hfovDeg: LANE_VIEW.fov }, w, h)
      gl.gl.readPixels(0, 0, w, h, gl.gl.RGBA, gl.gl.UNSIGNED_BYTE, buf)
      // GL rows run from the bottom, so reorder to run from the top
      for (let y = 0; y < h; y++) img.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
      out.push({ t: this.motion.videoTime(i), ...laneSide(observeLanes(img, w, h)) })
    }
    try {
      await decodeKeyframes(
        this.file,
        this.decoders.map((d) => d.track),
        keys,
        (i, fs) => {
          observe(i, fs)
          if (++done % 20 === 0) onProgress?.(done / keys.length)
        },
        signal
      )
      out.sort((p, q) => p.t - q.t)
      // A quick overtake shows up in one keyframe only: look again at the frames around it
      const have = new Set(keys)
      const more = new Set<number>()
      for (const tc of needsCloserLook(out)) {
        for (let d = -CLOSER_SPAN; d <= CLOSER_SPAN + 1e-6; d += CLOSER_STEP) {
          const i = this.frameOf(tc + d)
          if (!have.has(i)) more.add(i)
        }
      }
      if (more.size) await decodeFrames(this.file, this.decoders.map((d) => d.track), [...more], observe, signal)
      console.log(`Lanes: ${keys.length} keyframes, ${more.size} frames looked at again`)
    } finally {
      gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    out.sort((p, q) => p.t - q.t)
    return out
  }

  /**
   * Finds overtake scenes: examines which side of the lane the bike rides on across the whole video (scanLanes), searches for cars (scanVehicles) only around
   * the sections that crossed the center line, and selects the sections in which a car passed directly beside the overtaking side (core/overtake.ts)
   */
  async scanOvertakes(
    onProgress?: (msg: string) => void,
    signal?: AbortSignal,
    explain?: (c: LaneCrossing, s: VehicleSighting) => void
  ): Promise<{ crossings: LaneCrossing[]; overtakes: Overtake[] }> {
    const pct = (f: number): string => `${Math.round(f * 100)}%`
    const lanes = await this.scanLanes((f) => onProgress?.(t('Checking lanes {p}', { p: pct(f) })), signal)
    const crossings = findLaneCrossings(lanes)
    const own = ownSide(lanes)
    if (!crossings.length || !own) return { crossings, overtakes: [] }
    // Search for cars only around the crossing sections (scanning the whole video takes several minutes)
    const keys = this.keyframeIndices().filter((i) => {
      const tv = this.motion.videoTime(i)
      return crossings.some((c) => tv >= c.start - OVERTAKE.margin - 2 && tv <= c.end + OVERTAKE.margin + 2)
    })
    const sightings = await this.scanVehicles(keys, (f) => onProgress?.(t('Looking for vehicles {p}', { p: pct(0.8 * f) })), signal)
    // In a quick overtake the car is right beside for well under a second: where a vehicle was seen around a short crossing, look at the
    // frames between the keyframes too (only the overtaking side and the rear, where the overtaken car is right beside)
    const have = new Set(keys)
    const more: number[] = []
    for (const c of crossings) {
      if (c.end - c.start > SHORT_CROSSING || !vehicleAround(c, sightings, own)) continue
      for (let tv = c.start - OVERTAKE.margin; tv <= c.end + OVERTAKE.margin; tv += VEHICLE_STEP) {
        const i = this.frameOf(tv)
        if (!have.has(i)) {
          have.add(i)
          more.push(i)
        }
      }
    }
    console.log(`Vehicles: ${keys.length} keyframes around ${crossings.length} crossings, ${more.length} frames between them`)
    more.sort((a, b) => a - b)
    sightings.push(...(await this.scanVehicles(more, (f) => onProgress?.(t('Looking for vehicles {p}', { p: pct(0.8 + 0.2 * f) })), signal, [-90 * own, 180])))
    sightings.sort((p, q) => p.t - q.t)
    return { crossings, overtakes: findOvertakes(crossings, sightings, own, have.size, explain) }
  }

  /** Keyframe indices of the video (about every 1 second) */
  keyframeIndices(): number[] {
    const keys: number[] = []
    const kf = this.decoders[0].track.keyframes
    for (let i = 0; i < this.frameCount; i++) if (kf[i]) keys.push(i)
    return keys
  }

  /**
   * At the specified frames, renders front, right, back, and left (90° each), searches for cars, and returns the direction as seen from the body (core/vehicles.ts).
   * Frames between the keyframes are rendered only in the directions betweenYaws
   */
  async scanVehicles(indices: number[], onProgress?: (frac: number) => void, signal?: AbortSignal, betweenYaws = [0, 90, 180, -90]): Promise<VehicleSighting[]> {
    const S = DET_SIZE
    const FOV = 90
    const gl = new GlReframer(new OffscreenCanvas(S, S))
    gl.setLenses(this.rig)
    gl.dynamicSeam = false
    const buf = new Uint8Array(S * S * 4)
    const img = new Uint8Array(S * S * 4)
    const out: VehicleSighting[] = []
    let done = 0
    try {
      const kf = this.decoders[0].track.keyframes
      const decode = (idx: number[], cb: (i: number, fs: VideoFrame[]) => Promise<void>): Promise<void> =>
        idx.length ? (kf[idx[0]] ? decodeKeyframes : decodeFrames)(this.file, this.decoders.map((d) => d.track), idx, cb, signal) : Promise.resolve()
      const look = async (i: number, fs: VideoFrame[]): Promise<void> => {
          gl.upload([fs[0], fs[1]])
          const t = this.motion.videoTime(i)
          for (const yaw of kf[i] ? [0, 90, 180, -90] : betweenYaws) {
            const fp = this.motion.frame(i, { yaw, pitch: 0, fov: FOV, leanRatio: 0 })
            gl.draw({ view: fp.view, rs: fp.rs, hfovDeg: FOV }, S, S)
            gl.gl.readPixels(0, 0, S, S, gl.gl.RGBA, gl.gl.UNSIGNED_BYTE, buf)
            for (let y = 0; y < S; y++) img.set(buf.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4)
            const found = await segment(img.slice(), Object.keys(VEHICLE_CLASSES).map(Number), { scoreThr: 0.35 })
            for (const d of found) out.push(sightingFromBox({ x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2, w: d.x1 - d.x0, h: d.y1 - d.y0, score: d.score, cls: d.cls }, t, yaw, FOV))
          }
          if (++done % 5 === 0) onProgress?.(done / indices.length)
      }
      // Keyframes in one go, the frames between them one by one (each from the keyframe before it)
      await decode(indices.filter((i) => kf[i]), look)
      await decode(indices.filter((i) => !kf[i]), look)
    } finally {
      gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    return out.sort((p, q) => p.t - q.t)
  }

  /**
   * From the MotoReco .dat files in a folder (and the folders under it), selects the one from the same ride as this video.
   * Narrows to those close to the video time by the recording start time and length in the file name, then decides by the correlation between roll rate and the video's gyro
   */
  async findDat(folder: string, ddfPath: string | null, onProgress?: (msg: string) => void): Promise<{ path: string; peakRatio: number } | null> {
    onProgress?.(t('Looking for a matching bike log'))
    const files = await listDatFiles(folder)
    const durMs = (this.frameCount / this.fps) * 1000
    const vStart = datStartFromName(window.api.path.basename(this.path)) // VID_YYYYMMDD_HHMMSS (camera clock)
    const ddfText = ddfPath ? await window.api.readText(ddfPath).catch(() => null) : null
    const cam = cameraRollRate(this.imu, this.mount, this.meta.firstFrameUs)
    // Time difference from the video (the logger and camera clocks can be tens of minutes apart)
    const cands: { path: string; gap: number }[] = []
    for (const f of files) {
      const s = datStartFromName(window.api.path.basename(f.path))
      if (vStart === null || s === null) {
        cands.push({ path: f.path, gap: vStart === null ? 0 : Infinity })
        continue
      }
      if (Math.abs(s - vStart) > 2 * DAY_MS) continue
      const len = await datLengthMs(f.path, f.size)
      cands.push({ path: f.path, gap: Math.max(0, s - (vStart + durMs), vStart - (s + len)) })
    }
    cands.sort((a, b) => a.gap - b.gap)
    let best: { path: string; peakRatio: number } | null = null
    const tried = new Set<string>()
    // Check the closest first. If none is found among candidates close in time, widen the range
    const passes: [number, number][] = [
      [2 * HOUR_MS, 8],
      [DAY_MS, 12],
      [Infinity, 6]
    ]
    for (const [maxGap, maxCount] of passes) {
      const batch = cands.filter((c) => c.gap <= maxGap && !tried.has(c.path)).slice(0, maxCount)
      for (const c of batch) {
        tried.add(c.path)
        onProgress?.(t('Checking bike log: {file}', { file: window.api.path.basename(c.path) }))
        try {
          const s = await scoreDatInWorker({ buf: await readBinary(c.path), ddfText, cam })
          console.log('Matching', window.api.path.basename(c.path), s.peakRatio.toFixed(2))
          if (!best || s.peakRatio > best.peakRatio) best = { path: c.path, peakRatio: s.peakRatio }
          if (s.peakRatio >= 3) return best // almost certain
        } catch (e) {
          console.warn('Could not match .dat', c.path, e)
        }
      }
      if (best && best.peakRatio >= 1.5) return best
    }
    return null
  }

  async close(): Promise<void> {
    this.decoders?.forEach((d) => d.close())
    await this.setFxAudio(null)
    await this.closeFile()
  }
}

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

export const isDatPath = (p: string): boolean => p.toLowerCase().endsWith('.dat')

/** Reads the whole file */
async function readBinary(path: string): Promise<Uint8Array> {
  const { id, size } = await window.api.open(path, 'r')
  try {
    return await window.api.read(id, 0, size)
  } finally {
    await window.api.close(id)
  }
}

/** Length of the .dat recording [ms] (from the times of the last few records) */
async function datLengthMs(path: string, size: number): Promise<number> {
  const whole = size - (size % DAT_RECORD)
  const n = Math.min(whole, DAT_RECORD * 8)
  if (n < DAT_RECORD) return 0
  const { id } = await window.api.open(path, 'r')
  try {
    return datDurationFromTail(await window.api.read(id, whole - n, n)) * 1000
  } finally {
    await window.api.close(id)
  }
}

/** .dat files in the folder and folders up to 2 levels below */
async function listDatFiles(folder: string, depth = 2): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
  let ents: { name: string; dir: boolean; size: number }[]
  try {
    ents = await window.api.listDirEntries(folder)
  } catch {
    return out
  }
  for (const e of ents) {
    const p = window.api.path.join(folder, e.name)
    if (e.dir) {
      if (depth > 0) out.push(...(await listDatFiles(p, depth - 1)))
    } else if (isDatPath(e.name) && e.size >= DAT_RECORD * 100) out.push({ path: p, size: e.size })
  }
  return out
}
