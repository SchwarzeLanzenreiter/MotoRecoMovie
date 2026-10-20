// 1本の .insv を開いた状態（デコーダー・姿勢・ログ）をまとめる。
import { keyframeBefore } from '../core/mp4'
import { withSeamFix, type SeamFitResult, type SeamFrame } from '../core/seamfit'
import { openLocal } from '../core/file'
import { InsvTrailer, type Imu, type InsvMeta } from '../core/insv'
import { makeRig, type LensModel } from '../core/lens'
import { integrate, type Orientation } from '../core/motion'
import { estimateMountTrack, type MountTrack } from '../core/mount'
import type { ImuTelemetry } from '../core/imu-telemetry'
import { cameraRollRate, type LeanTrack, type SyncResult } from '../core/motoreco'
import { DAT_RECORD, datDurationFromTail, datStartFromName } from '../core/motoreco-dat'
import type { Telemetry } from '../core/telemetry'
import type { BodyTrack } from '../core/bodymap'
import type { FxAudio } from './audiofx'
import { analyzeLog, localizeError, scoreDatInWorker, seamFitInWorker, imuTelemetryInWorker } from './analysis'
import { demux, type FileReader, type Track } from '../core/mp4'
import type { Mat3 } from '../core/quat'
import { decodeKeyframes, TrackDecoder } from './decoder'
import { MotionModel } from './motion-model'
import type { StabSettings } from './project'
import { t } from '../i18n'
import { GlReframer } from '../render/gl-reframe'
import { findLaneCrossings, LANE_VIEW, laneSide, observeLanes, ownSide, type LaneCrossing, type LaneSample } from '../core/lanes'
import { findOvertakes, OVERTAKE, type Overtake } from '../core/overtake'
import { DET_SIZE, sightingFromBox, type VehicleSighting } from '../core/vehicles'
import { detectVehicles } from './detector'

export interface LogInfo {
  path: string
  /** .dat のとき、デコードに使った変換規則（.ddf） */
  ddfPath: string | null
  /** .ddf にあったが変換できなかった組み込みの規則 */
  unsupported: string[]
  sync: SyncResult
  lean: LeanTrack
  telemetry: Telemetry
  gpsDelay: { delay: number; corr: number }
}

export class Session {
  decoders!: [TrackDecoder, TrackDecoder] // [レンズ0, レンズ1]
  audioTrack: Track | null = null
  file!: FileReader
  meta!: InsvMeta
  /** 描画に使うレンズ（継ぎ目の合わせ込みを含む） */
  rig!: LensModel[]
  /** キャリブレーションのままのレンズ */
  baseRig!: LensModel[]
  private seamKey = ''
  imu!: Imu
  ori!: Orientation
  /** カメラの取り付け姿勢（時刻で変わることがある。core/mount.ts） */
  mount!: MountTrack
  /** IMU だけで求めた取り付け姿勢（ログを読み直すときの出発点） */
  private imuMount!: MountTrack
  frameTimes!: Float64Array
  motion!: MotionModel
  log: LogInfo | null = null
  /** 自車の継ぎ目の型（engine/bodymap.ts。作るまで・使わないときは null） */
  body: BodyTrack | null = null
  /** 整えた音声（engine/audiofx.ts。作るまで・使わないときは null = 動画の音声のまま） */
  fxAudio: FxAudio | null = null

  /** 整えた音声を差し替える（前のものは閉じる） */
  async setFxAudio(a: FxAudio | null): Promise<void> {
    const old = this.fxAudio
    this.fxAudio = a
    if (old && old !== a) await old.file.close().catch(() => undefined)
  }
  fps = 50
  /** 開いている .insv のパス */
  path = ''
  /**
   * 以前の版（記録の時刻のまま）の動画時刻からのずれ [s]。以前の版で保存したプロジェクトの時刻に足すと、今の動画時刻になる
   * （X6 の普通の動画は 0、X5 は 0.77 秒など）
   */
  legacyTimeShiftSec = 0
  private closeFile: () => Promise<void> = async () => undefined

  static async open(path: string, stab: StabSettings, onProgress?: (msg: string) => void): Promise<Session> {
    try {
      return await Session.openInner(path, stab, onProgress)
    } catch (e) {
      // core（mp4・insv）のエラーは日本語のまま投げられるので、画面の言語に直す
      if (e instanceof Error) throw new Error(localizeError(e.message), { cause: e })
      throw e
    }
  }

  private static async openInner(path: string, stab: StabSettings, onProgress?: (msg: string) => void): Promise<Session> {
    const s = new Session()
    s.path = path
    const step = (m: string): void => onProgress?.(m)
    step(t('ファイルを開いています'))
    const f = await openLocal(path)
    s.closeFile = f.close
    s.file = f
    const tracks = await demux(f)
    const videos = tracks.filter((t) => t.kind === 'video')
    if (videos.length !== 2) throw new Error(t('映像トラックが {n} 本あります（X6 の .insv は2本）', { n: videos.length }))
    s.audioTrack = tracks.find((t) => t.kind === 'audio') ?? null
    step(t('メタデータを読み込んでいます'))
    const tr = await InsvTrailer.open(f)
    s.meta = tr.meta
    s.fps = tr.meta.fps
    // stream_type 4 = トラックがレンズの逆順（X5/X6）
    const order = tr.meta.streamType === 4 ? [1, 0] : [0, 1]
    s.decoders = [new TrackDecoder(f, videos[order[0]]), new TrackDecoder(f, videos[order[1]])]
    s.baseRig = makeRig(tr.meta.calibration, videos[0].width)
    s.rig = s.baseRig
    step(t('ジャイロを読み込んでいます'))
    s.imu = await tr.imu()
    // フレームの時刻（ジャイロの時間軸）。記録の時刻が firstFrameUs とずれている動画（X5・分割の 2 本目以降）は、その分を直す
    const rawTimes = await tr.frameTimes(0)
    s.frameTimes = await tr.gyroFrameTimes(0)
    s.legacyTimeShiftSec = rawTimes.length ? (s.frameTimes[0] - rawTimes[0]) / 1e6 : 0
    // 取り付け姿勢: 前方 = 進行方向、上 = リーンしていないときの車体の上。走行中にカメラの向きが変わっていれば時刻ごと
    s.mount = estimateMountTrack(s.imu)
    s.imuMount = s.mount
    console.log(
      `取り付け姿勢: ${s.mount.fixed ? '動画を通して 1 つ' : '時刻ごと'}（動画の中での変化 最大 ${s.mount.maxDeg.toFixed(0)}°）、前後の向きは${s.mount.by === 'lean' ? '曲がる側へ倒れる関係' : 'レンズの向き'}から`
    )
    s.ori = integrate(s.imu)
    s.motion = new MotionModel(s.meta, s.ori, s.mount, s.frameTimes, null, stab)
    return s
  }

  /** スタビライズの設定にある継ぎ目の合わせ込みを反映する。レンズが変わったら true */
  applySeam(stab: StabSettings): boolean {
    const fix = stab.seamFix !== false ? (stab.seam ?? null) : null
    const key = fix ? [...fix.rot, fix.edge].join(',') : ''
    if (key === this.seamKey) return false
    this.seamKey = key
    this.rig = withSeamFix(this.baseRig, fix)
    return true
  }

  /**
   * 継ぎ目の合わせ込み用に、動画の何か所かのフレームを両レンズとも縮めたグレーで読む
   * （動画の 10〜90% を count 等分した位置の直前のキーフレーム。size 四方）。
   * プレビューと干渉しないよう専用のデコーダーを使い、キーフレームだけを読むので速い
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

  /** 継ぎ目の合わせ込みを推定する（重なり帯が最も一致するレンズ1の補正） */
  async estimateSeam(): Promise<SeamFitResult> {
    return seamFitInWorker(this.baseRig, await this.seamFrames())
  }

  /** 動画時刻 t [s] にいちばん近いコマ（実際のコマの時刻で。時刻 × fps を丸めると、記録のずれで 1 コマずれることがある） */
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
   * MotoReco のログ（MotoRecoViewer の CSV、または .dat を .ddf の規則でデコード）を読み込み、
   * 同期・リーン角の融合・テレメトリーの構築を解析スレッドで行う
   */
  async loadLog(path: string, ddfPath: string | null, onProgress?: (msg: string) => void): Promise<LogInfo> {
    onProgress?.(t('ログを読み込んでいます'))
    const isDat = isDatPath(path)
    if (isDat && !ddfPath) throw new Error(t('.dat を読むには、変換規則（.ddf）を指定してください'))
    const base = { imu: this.imu, mount: this.imuMount, firstFrameUs: this.meta.firstFrameUs, durationSec: this.frameCount / this.fps }
    const r = await analyzeLog(
      isDat ? { ...base, dat: { buf: await readBinary(path), ddfText: await window.api.readText(ddfPath!) } } : { ...base, csvText: await window.api.readText(path) },
      onProgress
    )
    console.log('ログ解析の内訳[ms]', JSON.stringify(r.timingMs))
    if (r.unsupported.length) console.log('変換できない規則', r.unsupported.join(', '))
    this.log = { path, ddfPath: isDat ? ddfPath : null, unsupported: r.unsupported, sync: r.sync, lean: r.lean, telemetry: r.telemetry, gpsDelay: r.gpsDelay }
    // ログで詰めた取り付け姿勢に置き換える（前方 = 進行方向、上 = リーンしていないときの車体の上）
    this.mount = r.mount
    this.motion.setMount(r.mount)
    console.log(`取り付け姿勢をログで詰めた: ${r.mount.fixed ? '動画を通して 1 つ' : '時刻ごと'}（変化 最大 ${r.mount.maxDeg.toFixed(0)}°）`)
    this.motion.setLean(r.lean)
    return this.log
  }

  /**
   * 表示・画角の自動切り替え・標識に使うテレメトリー。車両ログが無い（無効にした）ときは、動画の IMU から推定したもの
   * （loadImuTelemetry の後。source = 'imu'。メーター類には使わない）
   */
  telemetry(enabled: boolean): Telemetry | null {
    return enabled && this.log ? this.log.telemetry : (this.imuTel?.telemetry ?? null)
  }

  /** 車両ログが無いときの推定（動画の IMU から）。開いた後に loadImuTelemetry で求める */
  imuTel: ImuTelemetry | null = null

  /**
   * 車両ログが無くても画角の自動切り替え・浮遊標識・水平の補正が動くよう、動画の IMU からリーン角・車速・走行状態・コーナーを推定する
   * （core/imu-telemetry.ts。解析スレッドで 0.3〜0.5 秒）。ログを読み込んでいなければ、水平の補正にこのリーン角を使う
   */
  async loadImuTelemetry(): Promise<ImuTelemetry> {
    if (this.imuTel) return this.imuTel
    this.imuTel = await imuTelemetryInWorker({ imu: this.imu, mount: this.imuMount, firstFrameUs: this.meta.firstFrameUs, durationSec: this.frameCount / this.fps })
    if (!this.log || !this.logEnabled) this.motion.setLean(this.imuTel.lean)
    return this.imuTel
  }

  private logEnabled = true

  /** 読み込んだ車両ログを捨てる（映像と同期できなかったとき） */
  clearLog(): void {
    this.log = null
    this.setLogEnabled(this.logEnabled)
  }

  setLogEnabled(on: boolean): void {
    this.logEnabled = on
    this.motion.setLean(on && this.log ? this.log.lean : (this.imuTel?.lean ?? null))
  }

  /** 同じフォルダにある MotoReco の CSV を探す */
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
   * 車線のどちら側を走っているかを、動画のキーフレーム（約 1 秒ごと）ごとに調べる（core/lanes.ts）。
   * 前方の路面を見下ろした小さな画像を描き、センターラインの左右を判定する。20 分の動画で 1 分ほどかかる
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
    try {
      await decodeKeyframes(
        this.file,
        this.decoders.map((d) => d.track),
        keys,
        (i, fs) => {
          gl.upload([fs[0], fs[1]])
          // 水平・リーンを戻した向きで、前方の路面を見下ろす
          const fp = this.motion.frame(i, { yaw: 0, pitch: LANE_VIEW.pitch, fov: LANE_VIEW.fov, leanRatio: 0 })
          gl.draw({ view: fp.view, rs: fp.rs, hfovDeg: LANE_VIEW.fov }, w, h)
          gl.gl.readPixels(0, 0, w, h, gl.gl.RGBA, gl.gl.UNSIGNED_BYTE, buf)
          // GL は下の行から並ぶので、上の行からに並べ替える
          for (let y = 0; y < h; y++) img.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
          out.push({ t: this.motion.videoTime(i), ...laneSide(observeLanes(img, w, h)) })
          if (++done % 20 === 0) onProgress?.(done / keys.length)
        },
        signal
      )
    } finally {
      gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    out.sort((p, q) => p.t - q.t)
    return out
  }

  /**
   * 追い越しの場面を探す: 車線のどちら側を走っているかを動画全体で調べ（scanLanes）、センターラインをまたいだ区間の前後だけ
   * 車を探して（scanVehicles）、追い越す側の真横を車が通った区間を選ぶ（core/overtake.ts）
   */
  async scanOvertakes(
    onProgress?: (msg: string) => void,
    signal?: AbortSignal,
    explain?: (c: LaneCrossing, s: VehicleSighting) => void
  ): Promise<{ crossings: LaneCrossing[]; overtakes: Overtake[] }> {
    const pct = (f: number): string => `${Math.round(f * 100)}%`
    const lanes = await this.scanLanes((f) => onProgress?.(t('車線を調べています {p}', { p: pct(f) })), signal)
    const crossings = findLaneCrossings(lanes)
    const own = ownSide(lanes)
    if (!crossings.length || !own) return { crossings, overtakes: [] }
    // 車を探すのは、またいだ区間の前後だけ（動画全体を調べると数分かかる）
    const keys = this.keyframeIndices().filter((i) => {
      const tv = this.motion.videoTime(i)
      return crossings.some((c) => tv >= c.start - OVERTAKE.margin - 2 && tv <= c.end + OVERTAKE.margin + 2)
    })
    const sightings = await this.scanVehicles(keys, (f) => onProgress?.(t('車を探しています {p}', { p: pct(f) })), signal)
    return { crossings, overtakes: findOvertakes(crossings, sightings, own, keys.length, explain) }
  }

  /** 動画のキーフレームの番号（約 1 秒ごと） */
  keyframeIndices(): number[] {
    const keys: number[] = []
    const kf = this.decoders[0].track.keyframes
    for (let i = 0; i < this.frameCount; i++) if (kf[i]) keys.push(i)
    return keys
  }

  /**
   * 指定したキーフレームで、前・右・後ろ・左（各 90°）を描いて車を探し、車体から見た向きを返す（core/vehicles.ts）
   */
  async scanVehicles(indices: number[], onProgress?: (frac: number) => void, signal?: AbortSignal): Promise<VehicleSighting[]> {
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
      await decodeKeyframes(
        this.file,
        this.decoders.map((d) => d.track),
        indices,
        async (i, fs) => {
          gl.upload([fs[0], fs[1]])
          const t = this.motion.videoTime(i)
          for (const yaw of [0, 90, 180, -90]) {
            const fp = this.motion.frame(i, { yaw, pitch: 0, fov: FOV, leanRatio: 0 })
            gl.draw({ view: fp.view, rs: fp.rs, hfovDeg: FOV }, S, S)
            gl.gl.readPixels(0, 0, S, S, gl.gl.RGBA, gl.gl.UNSIGNED_BYTE, buf)
            for (let y = 0; y < S; y++) img.set(buf.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4)
            for (const d of await detectVehicles(img)) out.push(sightingFromBox(d, t, yaw, FOV))
          }
          if (++done % 5 === 0) onProgress?.(done / indices.length)
        },
        signal
      )
    } finally {
      gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    return out.sort((p, q) => p.t - q.t)
  }

  /**
   * フォルダ（とその下のフォルダ）の MotoReco の .dat から、この映像と同じ走行のものを選ぶ。
   * ファイル名の記録開始時刻と長さで映像の時刻に近いものに絞り、ロールレートと映像のジャイロの相関で決める
   */
  async findDat(folder: string, ddfPath: string | null, onProgress?: (msg: string) => void): Promise<{ path: string; peakRatio: number } | null> {
    onProgress?.(t('映像に合う車両ログを探しています'))
    const files = await listDatFiles(folder)
    const durMs = (this.frameCount / this.fps) * 1000
    const vStart = datStartFromName(window.api.path.basename(this.path)) // VID_YYYYMMDD_HHMMSS（カメラの時計）
    const ddfText = ddfPath ? await window.api.readText(ddfPath).catch(() => null) : null
    const cam = cameraRollRate(this.imu, this.mount, this.meta.firstFrameUs)
    // 映像との時刻の差（ロガーとカメラの時計は数十分ずれることがある）
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
    // 近いものから調べる。時刻の近い候補で見つからなければ範囲を広げる
    const passes: [number, number][] = [
      [2 * HOUR_MS, 8],
      [DAY_MS, 12],
      [Infinity, 6]
    ]
    for (const [maxGap, maxCount] of passes) {
      const batch = cands.filter((c) => c.gap <= maxGap && !tried.has(c.path)).slice(0, maxCount)
      for (const c of batch) {
        tried.add(c.path)
        onProgress?.(t('車両ログを照合しています: {file}', { file: window.api.path.basename(c.path) }))
        try {
          const s = await scoreDatInWorker({ buf: await readBinary(c.path), ddfText, cam })
          console.log('照合', window.api.path.basename(c.path), s.peakRatio.toFixed(2))
          if (!best || s.peakRatio > best.peakRatio) best = { path: c.path, peakRatio: s.peakRatio }
          if (s.peakRatio >= 3) return best // ほぼ確実
        } catch (e) {
          console.warn('照合できない .dat', c.path, e)
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

/** ファイルをまるごと読む */
async function readBinary(path: string): Promise<Uint8Array> {
  const { id, size } = await window.api.open(path, 'r')
  try {
    return await window.api.read(id, 0, size)
  } finally {
    await window.api.close(id)
  }
}

/** .dat の記録の長さ [ms]（末尾の数レコードの時刻から） */
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

/** フォルダとその下 2 段までのフォルダにある .dat */
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
