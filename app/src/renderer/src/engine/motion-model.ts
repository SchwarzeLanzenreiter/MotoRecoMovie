// フレームごとの仮想カメラ（リグ座標での向き）とローリングシャッター用の回転を計算する。
//
//   世界での仮想カメラ = 車体 · Rz(−L) · Ry(ヨー) · Rz(割合·|cos(ヨー)|·L) · Rx(ピッチ)（リーン角 L が分かるとき）
//     画面に残す傾きは横を向くほど弱め、真横で水平にする（車体に固定したカメラが横を向いていれば、
//     リーンは画面の傾きではなく上下の動きとして見えるため）。後ろ向きでは前向きと同じ向きに傾ける
//     （車体に固定したカメラなら逆向きに見えるが、リーン感をそろえる方を選んだ）
//     車体 = qs · R(前後軸, Δ) · R_mount(t)。ヨー 0 なら qs · R(前後軸, Δ) · R(前後軸, −(1−割合)·L) · R_mount · Rx(ピッチ)
//   リーン角が分からないとき = qs · R_mount · Ry(ヨー) · Rx(ピッチ)
//     qs : ジャイロを車体の軸ごとに平滑化した姿勢（スタビ無効なら q そのもの = リグ固定）
//     Δ  : L − G*L（平滑化で削れたリーンの動き。ログがあるときだけ）
//     L  : ログと融合した実際のリーン角
//     R_mount(t): 取り付け姿勢（core/mount.ts）。走行中にカメラの向きがバイクに対して変わるときは時刻ごと
//   シェーダーに渡すのはリグ座標での向き q(tc)⁻¹ · 世界での仮想カメラ。
//
// 空中の標識は、映像と同じ仮想カメラの向き（上の「世界」= ジャイロの座標）を地図の座標へ移して投影する。
// ジャイロの座標 → 地図の座標の回転 M は本来ほぼ一定（ジャイロのドリフトでゆっくり変わるだけ）なので、
//   M(t) = 地図での車体（融合した方位・勾配）· (ジャイロでの車体（リーンを戻したもの）)⁻¹
// を時間方向に強く平滑化して使う。方位や勾配の推定に含まれる細かい揺れは M から除かれ、
// 映像の細かい揺れ（スタビライズの残り）はそのまま標識にも乗るので、標識が景色に貼り付いて見える。
import { gaussianFilter, interp } from '../core/dsp'
import type { InsvMeta } from '../core/insv'
import { readoutRotations, sampleQ, smooth, type Orientation } from '../core/motion'
import { mountAt, mountQAt, type MountTrack } from '../core/mount'
import type { LeanTrack } from '../core/motoreco'
import { qAxisAngle, qConj, qFromRotvec, qMul, qSlerp, qToMat, qYawPitch, type Mat3, type Quat } from '../core/quat'
import type { Keyframe, StabSettings } from './project'

const BLOCK = 250
const MAP_RATE = 10 // M を計算する間隔 [Hz]
const MAP_SIGMA_S = 2 // M を平滑化するガウスの σ [s]

/** 地図での車体の向き（標識の投影用）。方位は北 = 0・時計回り、勾配は % */
export interface NavAttitude {
  rate: number
  heading: ArrayLike<number>
  grade: ArrayLike<number> | null
}

export class MotionModel {
  private qsCache = new Map<number, Float64Array>()
  private rsCache: { i: number; rs: Float32Array | null } = { i: -1, rs: null }
  private delta: Float64Array | null = null
  private mapQ: Float64Array | null = null // ジャイロの座標 → 地図の座標（MAP_RATE ごと, 平滑化済み）
  private nav: NavAttitude | null = null
  readonly offsetUs: number
  readonly readoutUs: number
  stab: StabSettings

  constructor(
    readonly meta: InsvMeta,
    readonly ori: Orientation,
    public mount: MountTrack,
    readonly frameTimes: Float64Array,
    public lean: LeanTrack | null,
    stab: StabSettings
  ) {
    this.offsetUs = meta.gyroOffsetMs * 1000
    this.readoutUs = meta.readoutMs * 1000
    this.stab = stab
    this.setStab(stab)
  }

  get frameCount(): number {
    return this.frameTimes.length
  }

  setStab(s: StabSettings): void {
    const sigmaChanged = s.sigma.some((v, i) => v !== this.stab.sigma[i]) || s.enabled !== this.stab.enabled
    this.stab = s
    if (sigmaChanged) this.qsCache.clear()
    this.updateDelta()
  }

  /** 取り付け姿勢を置き換える（ログで詰めたとき） */
  setMount(m: MountTrack): void {
    this.mount = m
    this.qsCache.clear()
    this.updateMap()
  }

  setLean(lean: LeanTrack | null): void {
    this.lean = lean
    this.updateDelta()
    this.updateMap()
  }

  /** 標識の投影に使う地図での向きを設定する（null で解除） */
  setNav(nav: NavAttitude | null): void {
    if (nav?.heading === this.nav?.heading && nav?.grade === this.nav?.grade) return
    this.nav = nav
    this.updateMap()
  }

  private updateMap(): void {
    const nav = this.nav
    if (!nav) {
      this.mapQ = null
      return
    }
    const d2r = Math.PI / 180
    const dur = this.videoTime(this.frameCount - 1)
    const n = Math.max(1, Math.floor(dur * MAP_RATE) + 1)
    const comp = [0, 1, 2, 3].map(() => new Float64Array(n))
    let prev: Quat | null = null
    for (let k = 0; k < n; k++) {
      const tv = k / MAP_RATE
      const j = Math.max(0, Math.min(nav.heading.length - 1, Math.round(tv * nav.rate)))
      const L = this.lean ? interp(tv, this.lean.t, this.lean.lean) * d2r : 0
      const qc = sampleQ(this.ori, tv * 1e6 + this.meta.firstFrameUs + this.offsetUs)
      const gyroBike = qMul(qMul(qc, this.mountQAt(tv * 1e6 + this.meta.firstFrameUs + this.offsetUs)), qFromRotvec(0, 0, -L))
      const gr = nav.grade ? nav.grade[j] : 0
      const th = Math.atan((Number.isFinite(gr) ? gr : 0) / 100)
      const hd = Number.isFinite(nav.heading[j]) ? nav.heading[j] * d2r : 0
      // 地図の座標は x 東・y 下・z 北。方位 h の水平な車体 = Ry(h)、上り坂で前上がり = Rx(勾配)
      const mapBike = qMul(qFromRotvec(0, hd, 0), qFromRotvec(th, 0, 0))
      let m = qMul(mapBike, qConj(gyroBike))
      // 平均できるように符号をそろえる（q と −q は同じ回転）
      if (prev && m[0] * prev[0] + m[1] * prev[1] + m[2] * prev[2] + m[3] * prev[3] < 0) m = m.map((x) => -x) as Quat
      prev = m
      for (let c = 0; c < 4; c++) comp[c][k] = m[c]
    }
    const sm = comp.map((a) => gaussianFilter(a, MAP_SIGMA_S * MAP_RATE))
    const out = new Float64Array(n * 4)
    for (let k = 0; k < n; k++) {
      const len = Math.hypot(sm[0][k], sm[1][k], sm[2][k], sm[3][k]) || 1
      for (let c = 0; c < 4; c++) out[k * 4 + c] = sm[c][k] / len
    }
    this.mapQ = out
  }

  /**
   * 仮想カメラ（frame() の world）の向きを地図の座標（x 東・y 下・z 北）で表した回転（列 = カメラの右・下・前）。
   * 地図での向きが設定されていなければ null
   */
  cameraInMap(i: number, world: Quat): Mat3 | null {
    const m = this.mapQ
    if (!m) return null
    const n = m.length / 4
    const x = Math.max(0, Math.min(n - 1, this.videoTime(i) * MAP_RATE))
    const k0 = Math.min(n - 2, Math.floor(x))
    const q = k0 < 0 ? (Array.from(m.subarray(0, 4)) as Quat) : qSlerp(m.subarray(k0 * 4, k0 * 4 + 4), m.subarray(k0 * 4 + 4, k0 * 4 + 8), x - k0)
    return qToMat(qMul(q, world))
  }

  private updateDelta(): void {
    if (!this.lean) {
      this.delta = null
      return
    }
    const L = this.lean.lean
    const G = gaussianFilter(L, this.stab.sigma[2] * 100)
    this.delta = L.map((v, i) => v - G[i])
  }

  /** 時刻 t [us]（ジャイロの時間軸）の取り付け姿勢 */
  private mountQAt(t: number): Quat {
    return mountQAt(this.mount, t)
  }

  /** 取り付け姿勢の前方（リグ座標） */
  private fwdOf(q: Quat): [number, number, number] {
    const R = qToMat(q)
    return [R[2], R[5], R[8]]
  }

  /** フレーム i の中央時刻（ジャイロの時間軸, us） */
  tc(i: number): number {
    return this.frameTimes[i] + this.offsetUs
  }

  /** フレーム i の動画時刻 [s] */
  videoTime(i: number): number {
    return (this.frameTimes[i] - this.meta.firstFrameUs) / 1e6
  }

  private qs(i: number): Quat {
    const b = Math.floor(i / BLOCK)
    let blk = this.qsCache.get(b)
    if (!blk) {
      const n = Math.min(BLOCK, this.frameCount - b * BLOCK)
      const times = new Float64Array(n)
      for (let k = 0; k < n; k++) times[k] = this.tc(b * BLOCK + k)
      const mt = this.mount
      blk = smooth(this.ori, times, this.stab.sigma, mt.fixed ? mountAt(mt, 0) : (t) => mountAt(mt, t))
      this.qsCache.set(b, blk)
      if (this.qsCache.size > 64) this.qsCache.delete(this.qsCache.keys().next().value!)
    }
    const k = i - b * BLOCK
    return Array.from(blk.subarray(k * 4, k * 4 + 4)) as Quat
  }

  /** リーン角（実際の角度, deg）。ログがなければ null */
  leanAt(i: number): number | null {
    return this.lean ? interp(this.videoTime(i), this.lean.t, this.lean.lean) : null
  }

  /**
   * フレーム i の重力の下向き（リグ座標）。車体の姿勢からリーンを戻した水平な向きの「下」
   * （動的なつなぎ合わせで、水平より下の方位に地面までの距離を目安にするのに使う）
   */
  downInRig(i: number): [number, number, number] {
    const v = this.frame(i, { yaw: 0, pitch: 0, fov: 90, leanRatio: 0 }).view // 列 = 視点の右・下・前（リグ座標）
    return [v[1], v[4], v[7]]
  }

  frame(i: number, view: Omit<Keyframe, 't'>): { view: Mat3; world: Quat; rs: Float32Array | null; correctionDeg: number } {
    const tc = this.tc(i)
    const mountQ = this.mountQAt(tc)
    const fwd = this.fwdOf(mountQ)
    const qc = sampleQ(this.ori, tc)
    let w: Quat = this.stab.enabled ? this.qs(i) : qc
    const d2r = Math.PI / 180
    let world: Quat
    if (this.lean) {
      const tv = this.videoTime(i)
      if (this.stab.enabled && this.stab.rollComp && this.delta) {
        w = qMul(w, qAxisAngle(fwd, interp(tv, this.lean.t, this.delta) * d2r))
      }
      // リーン角が分かるときは、横を向く回転を「水平」を基準にする:
      //   車体 · Rz(−L)（リーンを戻す）· Ry(ヨー)（鉛直軸まわりに横を向く）· Rz(割合·|cos(ヨー)|·L)（画面に残す傾き）· Rx(ピッチ)
      // 傾いた車体の上下軸まわりに横を向くと、リーン中は内側を向くほど視線が地面側へ下がってしまうため。
      // ヨー 0 のときは従来の 車体 · Rz(−(1−割合)·L) · Rx(ピッチ) と同じになる（Rz は車体の前後軸）
      // 画面に残す傾きは cos(ヨー) で、前で +・真横で 0（水平）・後ろで −。後ろを向いた視線は車体の前後軸と逆向きなので、
      // 同じリーンでも画面の傾きは前と逆になる（カメラを車体に固定したまま後ろを向くと Ry(180°)·Rz(L) = Rz(−L)·Ry(180°)）。
      // 以前は |cos(ヨー)| で、後ろを向いても前と同じ向きに傾けていた
      const L = interp(tv, this.lean.t, this.lean.lean) * d2r
      const bike = qMul(w, mountQ)
      const rz = (a: number): Quat => qFromRotvec(0, 0, a)
      const keep = view.leanRatio * Math.cos(view.yaw * d2r)
      world = qMul(qMul(qMul(qMul(bike, rz(-L)), qFromRotvec(0, view.yaw * d2r, 0)), rz(keep * L)), qFromRotvec(view.pitch * d2r, 0, 0))
      w = qMul(w, qAxisAngle(fwd, -(1 - view.leanRatio) * L)) // 補正量の表示用（ヨー 0 のときの姿勢）
    } else {
      world = qMul(qMul(w, mountQ), qYawPitch(view.yaw, view.pitch))
    }
    const rel = qMul(qConj(qc), world)
    const corr = qMul(qConj(qc), w)
    const correctionDeg = (2 * Math.acos(Math.min(1, Math.abs(corr[3]))) * 180) / Math.PI
    // 読み出し中の回転は視点によらないので、同じフレームなら使い回す（画面分割で視点が複数あるとき）
    let rs: Float32Array | null = null
    if (this.stab.rollingShutter) {
      if (this.rsCache.i !== i) this.rsCache = { i, rs: readoutRotations(this.ori, tc, this.readoutUs) }
      rs = this.rsCache.rs
    }
    return { view: qToMat(rel), world, rs, correctionDeg }
  }
}
