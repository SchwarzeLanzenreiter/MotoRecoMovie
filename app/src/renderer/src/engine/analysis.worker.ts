// Web Worker that does the heavy analysis on a thread separate from the UI.
// Load the vehicle log -> sync with the video -> fuse the lean angle -> estimate the GPS delay -> unified telemetry
import { disturbTrack } from '../core/disturb'
import type { Imu } from '../core/insv'
import { bikeLogFromColumns, cameraRollRate, cameraYawRate, fuseLean, logMatchScore, parseMotoReco, syncLog, type LeanTrack, type SyncResult } from '../core/motoreco'
import { datRollRate, decodeDat, parseDdf } from '../core/motoreco-dat'
import { buildTelemetry, estimateGpsDelay, type Telemetry } from '../core/telemetry'
import { detectRiding } from '../core/riding'
import { buildNav } from '../core/nav'
import { detectCorners } from '../core/corners'
import { refineMountWithLog, type MountTrack } from '../core/mount'
import { buildImuTelemetry, type ImuTelemetry } from '../core/imu-telemetry'
import type { LensModel } from '../core/lens'
import { fitSeam, type SeamFrame } from '../core/seamfit'

export interface AnalyzeLogRequest {
  /** A MotoRecoViewer CSV, or a MotoReco .dat with its conversion rules (.ddf) */
  csvText?: string
  dat?: { buf: Uint8Array; ddfText: string }
  imu: Imu
  mount: MountTrack
  firstFrameUs: number
  durationSec: number
}

export interface AnalyzeLogResult {
  sync: SyncResult
  lean: LeanTrack
  telemetry: Telemetry
  gpsDelay: { delay: number; corr: number }
  timingMs: Record<string, number>
  /** Built-in rules that were in the .ddf but could not be converted */
  unsupported: string[]
  /** Mount orientation refined with the log (refineMountWithLog in core/mount.ts) */
  mount: MountTrack
}

/** Estimate from the video IMU when there is no vehicle log (core/imu-telemetry.ts) */
export interface ImuTelemetryRequest {
  imu: Imu
  mount: MountTrack
  firstFrameUs: number
  durationSec: number
}

/** A measure of whether the .dat is from the same ride as the video (when choosing automatically from a folder) */
export interface ScoreDatRequest {
  buf: Uint8Array
  ddfText: string | null
  cam: { t: Float64Array; r: Float64Array }
}
export interface ScoreDatResult {
  peakRatio: number
  peak: number
  offset: number
}

type Msg =
  | { id: number; type: 'analyzeLog'; req: AnalyzeLogRequest }
  | { id: number; type: 'scoreDat'; req: ScoreDatRequest }
  | { id: number; type: 'seamFit'; req: { rig: LensModel[]; frames: SeamFrame[] } }
  | { id: number; type: 'imuTelemetry'; req: ImuTelemetryRequest }

self.onmessage = (e: MessageEvent<Msg>) => {
  const { id } = e.data
  try {
    if (e.data.type === 'seamFit') {
      // Lens seam fitting (a calculation that takes several seconds, so it runs on a thread separate from the UI)
      self.postMessage({ id, result: fitSeam(e.data.req.rig, e.data.req.frames) })
      return
    }
    if (e.data.type === 'imuTelemetry') {
      // With no vehicle log: estimate the lean angle, vehicle speed, front/rear G and the shape of the road traveled from the video IMU, and derive the riding state and corners
      const r = e.data.req
      const result: ImuTelemetry = buildImuTelemetry(r.imu, r.mount, r.firstFrameUs, r.durationSec)
      const tel = result.telemetry
      tel.riding = detectRiding(tel)
      tel.corners = tel.nav ? detectCorners(tel, tel.nav, tel.riding) : []
      self.postMessage({ id, result })
      return
    }
    if (e.data.type === 'scoreDat') {
      const { buf, ddfText, cam } = e.data.req
      const rr = datRollRate(buf, ddfText ? parseDdf(ddfText) : null)
      const result: ScoreDatResult = logMatchScore(rr.t, rr.rollRate, cam)
      self.postMessage({ id, result })
      return
    }
    const req = e.data.req
    if (e.data.type === 'analyzeLog') {
      const timing: Record<string, number> = {}
      let t = performance.now()
      const lap = (k: string): void => {
        const now = performance.now()
        timing[k] = Math.round(now - t)
        t = now
      }
      const progress = (msg: string): void => self.postMessage({ id, progress: msg })
      progress('Loading log')
      let unsupported: string[] = []
      let log
      if (req.dat) {
        const table = decodeDat(req.dat.buf, parseDdf(req.dat.ddfText))
        unsupported = table.unsupported
        log = bikeLogFromColumns(table.t, table.columns)
      } else log = parseMotoReco(req.csvText ?? '')
      lap('parse')
      progress('Syncing video and log')
      let cam = cameraRollRate(req.imu, req.mount, req.firstFrameUs)
      const sync = syncLog(log, cam)
      lap('sync')
      // Once synced, refine the mount orientation with the log (acceleration while riding upright, body roll rate) and recompute the camera roll rate
      const mount = log.rollRate.some(Number.isFinite) ? refineMountWithLog(req.mount, req.imu, log, sync, req.firstFrameUs) : req.mount
      cam = cameraRollRate(req.imu, mount, req.firstFrameUs)
      lap('mount')
      progress('Estimating lean angle')
      const lean = fuseLean(log, cam, sync)
      lap('lean')
      progress('Preparing telemetry')
      const yaw = cameraYawRate(req.imu, mount, req.firstFrameUs)
      const gpsDelay = estimateGpsDelay(buildTelemetry(log, sync, lean, req.durationSec, 0), yaw)
      const telemetry = buildTelemetry(log, sync, lean, req.durationSec, gpsDelay.delay)
      telemetry.riding = detectRiding(telemetry)
      lap('telemetry')
      const nav = buildNav(telemetry, yaw)
      if (nav) {
        telemetry.nav = nav
        telemetry.corners = detectCorners(telemetry, nav, telemetry.riding)
      }
      lap('corners')
      telemetry.disturb = disturbTrack(telemetry) ?? undefined
      lap('disturb')
      const result: AnalyzeLogResult = { sync, lean, telemetry, gpsDelay, timingMs: timing, unsupported, mount }
      // Transfer large arrays by ownership to avoid copies
      const transfer: Transferable[] = [lean.t.buffer, lean.lean.buffer, lean.sd.buffer]
      for (const v of Object.values(telemetry.channels)) if (v) transfer.push(v.buffer)
      if (telemetry.disturb) transfer.push(telemetry.disturb.score.buffer, telemetry.disturb.cause.buffer)
      if (telemetry.nav) transfer.push(telemetry.nav.x.buffer, telemetry.nav.y.buffer, telemetry.nav.heading.buffer, telemetry.nav.turnRate.buffer)
      if (telemetry.riding) transfer.push(telemetry.riding.state.buffer, telemetry.riding.peakLean.buffer, telemetry.riding.leanHold.buffer, ...telemetry.riding.weights.map((w) => w.buffer))
      self.postMessage({ id, result }, { transfer })
    }
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
