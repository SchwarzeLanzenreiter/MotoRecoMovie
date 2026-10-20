// プレビューの再生制御。表示要求は最新のものだけを処理し、視点の変更だけならデコードせず描き直す。
import type { Telemetry } from '../core/telemetry'
import { Compositor, type ViewInfo } from '../render/compositor'
import { AudioPlayer } from './audio'
import { FX_BUILD_GAIN } from '../core/audiofx'
import type { Project } from './project'
import type { Session } from './session'

export interface PlayerStatus {
  frame: number
  playing: boolean
  fps: number // 再生中の実効フレームレート
  correctionDeg: number
  leanDeg: number | null
  views: ViewInfo[]
}

export class Player {
  private comp: Compositor
  private telemetry: Telemetry | null = null
  private uploaded = -1 // テクスチャに載っているフレーム
  private wanted = 0
  private busy = false
  private playing = false
  private playStart = { t: 0, frame: 0 }
  private fpsWin: number[] = []
  private disposed = false
  private audio: AudioPlayer | null
  status: PlayerStatus = { frame: 0, playing: false, fps: 0, correctionDeg: 0, leanDeg: null, views: [] }
  onStatus: (s: PlayerStatus) => void = () => undefined
  onError: (e: unknown) => void = () => undefined

  constructor(
    private canvas: HTMLCanvasElement,
    private session: Session,
    private project: Project
  ) {
    this.comp = new Compositor(canvas)
    session.applySeam(project.stab)
    this.comp.setLenses(session.rig)
    this.audio = this.makeAudio()
  }

  /** 音声の再生（整えた音声があればそれ。高い音を切る・音圧を抑えるは再生しながらかける） */
  private makeAudio(): AudioPlayer | null {
    const s = this.session
    const a = s.fxAudio ? new AudioPlayer(s.fxAudio.file, s.fxAudio.track, 1 / FX_BUILD_GAIN) : s.audioTrack ? new AudioPlayer(s.file, s.audioTrack) : null
    a?.setFx(this.project.audioFx.on ? this.project.audioFx : null)
    return a
  }

  /** 音声の元を差し替える（整えた音声ができたとき・設定を変えたとき）。再生中なら同じ位置から鳴らし直す */
  updateAudioSource(): void {
    const s = this.session
    const want = s.fxAudio ? s.fxAudio.track : s.audioTrack
    if (this.audio?.track === want) return
    const muted = this.muted
    this.audio?.dispose()
    this.audio = this.makeAudio()
    this.audio?.setMuted(muted)
    if (this.playing) void this.audio?.start(this.mediaTime(this.status.frame))
  }

  /** フレーム i の表示時刻 [s]（映像トラックの時刻。音声と同じ時間軸） */
  private mediaTime(i: number): number {
    const t = this.session.decoders[0].track
    return t.cts[i] / t.timescale
  }

  private frameAt(sec: number): number {
    const t = this.session.decoders[0].track
    const x = sec * t.timescale
    let lo = 0
    let hi = t.cts.length - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (t.cts[m] <= x) lo = m
      else hi = m
    }
    return lo
  }

  private muted = false
  setMuted(m: boolean): void {
    this.muted = m
    this.audio?.setMuted(m)
  }

  setProject(p: Project): void {
    this.project = p
    // 高い音を切る・音圧を抑えるは、すぐに（次にデコードする音から）
    this.audio?.setFx(p.audioFx.on ? p.audioFx : null)
    this.session.motion.setStab(p.stab)
    if (this.session.applySeam(p.stab)) this.comp.setLenses(this.session.rig)
    this.redraw()
  }

  setTelemetry(t: Telemetry | null): void {
    this.telemetry = t
    this.redraw()
  }

  /** 表示サイズ（キャンバスの画素数） */
  private size(): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    return [Math.max(2, Math.round(r.width * dpr)), Math.max(2, Math.round(r.height * dpr))]
  }

  seek(frame: number): void {
    this.wanted = Math.max(0, Math.min(this.session.frameCount - 1, Math.round(frame)))
    if (this.playing) {
      this.playStart = { t: performance.now(), frame: this.wanted }
      void this.audio?.start(this.mediaTime(this.wanted))
    }
    void this.pump()
  }

  play(): void {
    if (this.playing) return
    this.playing = true
    this.playStart = { t: performance.now(), frame: this.status.frame }
    this.fpsWin = []
    void this.audio?.start(this.mediaTime(this.status.frame))
    void this.pump()
  }

  pause(): void {
    this.playing = false
    this.audio?.stop()
    this.emit(this.status.frame)
  }

  get isPlaying(): boolean {
    return this.playing
  }

  redraw(): void {
    if (this.uploaded >= 0 && !this.busy) this.draw(this.uploaded)
  }

  private draw(i: number): void {
    const [w, h] = this.size()
    // 書き出しと同じ合成処理で描く（キャンバスは書き出しの縦横比に合わせてある）
    this.comp.body = this.session.body
    const views = this.comp.render(i, this.project, this.session.motion, this.telemetry, w, h)
    this.status = { ...this.status, frame: i, views, correctionDeg: views[0]?.correctionDeg ?? 0, leanDeg: this.session.motion.leanAt(i) }
  }

  private emit(i: number): void {
    this.status = { ...this.status, frame: i, playing: this.playing }
    this.onStatus(this.status)
  }

  private async pump(): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      for (;;) {
        let target = this.wanted
        if (this.playing) {
          const pos = this.audio?.position()
          if (pos !== null && pos !== undefined) {
            // 音声の時計に合わせる。遅れたフレームは飛ばす（デコーダーは間のフレームも順に処理するので連続性は保たれる）
            target = Math.min(this.session.frameCount - 1, Math.max(this.playStart.frame, this.frameAt(pos)))
          } else {
            const el = (performance.now() - this.playStart.t) / 1000
            target = Math.min(this.session.frameCount - 1, this.playStart.frame + Math.floor(el * this.session.fps))
            // 音声がない場合は、処理が追いつかなければ飛ばさず1枚ずつ進める
            if (target > this.uploaded + 1 && this.uploaded >= 0 && target - this.uploaded < 50) target = this.uploaded + 1
          }
          if (target === this.uploaded) {
            await new Promise((r) => requestAnimationFrame(() => r(null)))
            continue
          }
        } else if (target === this.uploaded) {
          break
        }
        const [a, b] = await Promise.all([this.session.decoders[0].get(target), this.session.decoders[1].get(target)])
        if (this.disposed) {
          a.close()
          b.close()
          return
        }
        this.comp.upload([a, b])
        a.close()
        b.close()
        this.uploaded = target
        this.draw(target)
        if (this.playing) {
          const now = performance.now()
          this.fpsWin.push(now)
          while (this.fpsWin.length > 25) this.fpsWin.shift()
          this.status.fps = this.fpsWin.length > 1 ? ((this.fpsWin.length - 1) * 1000) / (now - this.fpsWin[0]) : 0
          if (target >= this.session.frameCount - 1) {
            this.playing = false
            this.audio?.stop()
          }
          this.wanted = target
        }
        this.emit(target)
        if (!this.playing && this.wanted === this.uploaded) break
      }
    } catch (e) {
      this.playing = false
      this.onError(e)
    } finally {
      this.busy = false
    }
  }

  /** 再生中の映像と音声のずれ [ms]（正 = 映像が遅れている）。検証用 */
  avOffsetMs(): number | null {
    const pos = this.audio?.position()
    if (pos == null || this.uploaded < 0) return null
    return (pos - this.mediaTime(this.uploaded)) * 1000
  }

  get audioStats(): AudioPlayer['stats'] | null {
    return this.audio?.stats ?? null
  }

  dispose(): void {
    this.disposed = true
    this.playing = false
    this.audio?.dispose()
  }
}
