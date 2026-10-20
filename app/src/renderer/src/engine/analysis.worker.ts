// 重い解析を UI と別のスレッドで行う Web Worker。
// 車両ログの読み込み → 映像との同期 → リーン角の融合 → GPS の遅れ推定 → 統一テレメトリー
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
  /** MotoRecoViewer の CSV、または MotoReco の .dat とその変換規則（.ddf） */
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
  /** .ddf にあったが変換できなかった組み込みの規則 */
  unsupported: string[]
  /** ログで詰めた取り付け姿勢（core/mount.ts の refineMountWithLog） */
  mount: MountTrack
}

/** 車両ログが無いときの、動画の IMU からの推定（core/imu-telemetry.ts） */
export interface ImuTelemetryRequest {
  imu: Imu
  mount: MountTrack
  firstFrameUs: number
  durationSec: number
}

/** .dat が映像と同じ走行のものかの目安（フォルダから自動で選ぶとき） */
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
      // レンズの継ぎ目の合わせ込み（数秒かかる計算なので UI と別のスレッドで）
      self.postMessage({ id, result: fitSeam(e.data.req.rig, e.data.req.frames) })
      return
    }
    if (e.data.type === 'imuTelemetry') {
      // 車両ログが無いとき: 動画の IMU からリーン角・車速・前後 G・走った道の形を推定し、走行状態とコーナーを求める
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
      progress('ログを読み込んでいます')
      let unsupported: string[] = []
      let log
      if (req.dat) {
        const table = decodeDat(req.dat.buf, parseDdf(req.dat.ddfText))
        unsupported = table.unsupported
        log = bikeLogFromColumns(table.t, table.columns)
      } else log = parseMotoReco(req.csvText ?? '')
      lap('parse')
      progress('映像とログを同期しています')
      let cam = cameraRollRate(req.imu, req.mount, req.firstFrameUs)
      const sync = syncLog(log, cam)
      lap('sync')
      // 同期が取れたら、ログ（直立して走っている間の加速度・車体のロール角速度）で取り付け姿勢を詰め、カメラのロール角速度を求め直す
      const mount = log.rollRate.some(Number.isFinite) ? refineMountWithLog(req.mount, req.imu, log, sync, req.firstFrameUs) : req.mount
      cam = cameraRollRate(req.imu, mount, req.firstFrameUs)
      lap('mount')
      progress('リーン角を推定しています')
      const lean = fuseLean(log, cam, sync)
      lap('lean')
      progress('テレメトリーを整えています')
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
      // 大きな配列は所有権ごと渡してコピーを避ける
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
