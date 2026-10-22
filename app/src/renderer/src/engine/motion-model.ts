// Computes the per-frame virtual camera (orientation in rig coordinates) and the rotation for rolling shutter.
//
//   virtual camera in the world = body · Rz(-L) · Ry(yaw) · Rz(ratio·|cos(yaw)|·L) · Rx(pitch) (when the lean angle L is known)
//     The tilt kept on screen weakens as the view turns sideways and is level at exactly sideways (for a camera fixed to the body
//     looking sideways, the lean shows up as vertical motion rather than screen tilt). When looking back, tilt in the same direction as looking forward
//     (a camera fixed to the body would see it reversed, but we chose to keep the lean feel consistent)
//     body = qs · R(fore-aft axis, Δ) · R_mount(t). At yaw 0: qs · R(fore-aft axis, Δ) · R(fore-aft axis, -(1-ratio)·L) · R_mount · Rx(pitch)
//   when the lean angle is unknown = qs · R_mount · Ry(yaw) · Rx(pitch)
//     qs : the gyro attitude smoothed per body axis (with stabilization off this is q itself = fixed to the rig)
//     Δ  : L - G*L (the lean motion removed by smoothing; only when a log is present)
//     L  : the actual lean angle fused with the log
//     R_mount(t): mount orientation (core/mount.ts). Per time when the camera direction relative to the bike changes while riding
//   What is passed to the shader is the orientation in rig coordinates: q(tc)^-1 · virtual camera in the world.
//
// The floating signs project the same virtual camera orientation as the video (the "world" above = gyro coordinates) into map coordinates.
// The rotation M from gyro coordinates to map coordinates is essentially constant (it only drifts slowly with gyro drift). It is
//   M(t) = level body on the map (heading) · (level body in gyro coordinates)^-1
// heavily smoothed over time. Level in gyro coordinates comes from gravity (the acceleration averaged over a minute, gravityTrack): the
// grade from the GPS altitude was used before, but it was off by 2.7° RMS (up to 9°) from the true tilt, which made far signs float or sink.
// Without gravity: body on the map (fused heading and grade) · (body in gyro coordinates (lean undone))^-1. Fine jitter in the heading and grade estimates is removed from M, while
// the fine jitter of the video (residual stabilization) rides on the signs as well, so the signs look stuck to the scenery.
import { gaussianFilter, interp } from '../core/dsp'
import type { InsvMeta } from '../core/insv'
import { gravityAt, readoutRotations, sampleQ, smooth, type GravityTrack, type Orientation } from '../core/motion'
import { mountAt, mountQAt, type MountTrack } from '../core/mount'
import type { LeanTrack } from '../core/motoreco'
import { matMul, matToQ, qAxisAngle, qConj, qFromRotvec, qMul, qSlerp, qToMat, qYawPitch, type Mat3, type Quat } from '../core/quat'
import type { Keyframe, StabSettings } from './project'

const BLOCK = 250
const MAP_RATE = 10 // interval at which M is computed [Hz]
const MAP_SIGMA_S = 2 // Gaussian sigma for smoothing M [s]

/** Body orientation on the map (for projecting signs). Heading is north = 0, clockwise; grade in %; speed in km/h */
export interface NavAttitude {
  rate: number
  heading: ArrayLike<number>
  grade: ArrayLike<number> | null
  /** Takes the bike's own acceleration out of the gravity direction (gravityAt) */
  speed?: ArrayLike<number> | null
}

export class MotionModel {
  private qsCache = new Map<number, Float64Array>()
  private rsCache: { i: number; rs: Float32Array | null } = { i: -1, rs: null }
  private delta: Float64Array | null = null
  private mapQ: Float64Array | null = null // gyro coordinates -> map coordinates (per MAP_RATE, smoothed)
  private nav: NavAttitude | null = null
  private gravity: GravityTrack | null = null
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

  /** Replace the mount orientation (when refined with the log) */
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

  /** Set the map orientation used to project signs (null clears it) */
  setNav(nav: NavAttitude | null): void {
    if (nav?.heading === this.nav?.heading && nav?.grade === this.nav?.grade && nav?.speed === this.nav?.speed) return
    this.nav = nav
    this.updateMap()
  }

  /** Set the gravity direction that levels the sign camera (null: level from the grade instead) */
  setGravity(g: GravityTrack | null): void {
    if (g === this.gravity) return
    this.gravity = g
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
    const t0Us = this.meta.firstFrameUs + this.offsetUs
    const navIndex = (tv: number): number => Math.max(0, Math.min(nav.heading.length - 1, Math.round(tv * nav.rate)))
    // Velocity in gyro coordinates: the speed along the body forward
    const speed = nav.speed
    const vel = speed
      ? (tUs: number): [number, number, number] | null => {
          const sp = speed[navIndex((tUs - t0Us) / 1e6)]
          if (!Number.isFinite(sp)) return null
          const B = qToMat(qMul(sampleQ(this.ori, tUs), this.mountQAt(tUs)))
          const v = sp / 3.6
          return [B[2] * v, B[5] * v, B[8] * v]
        }
      : undefined
    for (let k = 0; k < n; k++) {
      const tv = k / MAP_RATE
      const j = navIndex(tv)
      const L = this.lean ? interp(tv, this.lean.t, this.lean.lean) * d2r : 0
      const tUs = tv * 1e6 + t0Us
      const qc = sampleQ(this.ori, tUs)
      const gyroBike = qMul(qMul(qc, this.mountQAt(tUs)), qFromRotvec(0, 0, -L))
      const hd = Number.isFinite(nav.heading[j]) ? nav.heading[j] * d2r : 0
      // Map coordinates are x east, y down, z north. A level body with heading h = Ry(h)
      const mapLevel = qFromRotvec(0, hd, 0)
      const g = this.gravity && gravityAt(this.gravity, tUs, vel)
      let m: Quat
      if (g) {
        // Level body in gyro coordinates: down = gravity, forward = the body forward made horizontal, right = down × forward
        const B = qToMat(gyroBike)
        const f = [B[2], B[5], B[8]]
        const fg = f[0] * g[0] + f[1] * g[1] + f[2] * g[2]
        const h = [f[0] - fg * g[0], f[1] - fg * g[1], f[2] - fg * g[2]]
        const hl = Math.hypot(h[0], h[1], h[2]) || 1
        for (let c = 0; c < 3; c++) h[c] /= hl
        const r = [g[1] * h[2] - g[2] * h[1], g[2] * h[0] - g[0] * h[2], g[0] * h[1] - g[1] * h[0]]
        // M = (level body on the map) · (level body in gyro coordinates)^T; the rows of the transpose are right, down, forward
        m = matToQ(matMul(qToMat(mapLevel), [r[0], r[1], r[2], g[0], g[1], g[2], h[0], h[1], h[2]]))
      } else {
        // Nose up on an uphill = Rx(grade)
        const gr = nav.grade ? nav.grade[j] : 0
        const th = Math.atan((Number.isFinite(gr) ? gr : 0) / 100)
        m = qMul(qMul(mapLevel, qFromRotvec(th, 0, 0)), qConj(gyroBike))
      }
      // Align signs so they can be averaged (q and -q are the same rotation)
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
   * Rotation expressing the orientation of the virtual camera (world in frame()) in map coordinates (x east, y down, z north) (columns = camera right, down, forward).
   * null if the map orientation is not set
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

  /** Mount orientation at time t [us] (gyro time axis) */
  private mountQAt(t: number): Quat {
    return mountQAt(this.mount, t)
  }

  /** Mount forward direction (rig coordinates) */
  private fwdOf(q: Quat): [number, number, number] {
    const R = qToMat(q)
    return [R[2], R[5], R[8]]
  }

  /** Center time of frame i (gyro time axis, us) */
  tc(i: number): number {
    return this.frameTimes[i] + this.offsetUs
  }

  /** Video time of frame i [s] */
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

  /** Lean angle (actual angle, deg). null if there is no log */
  leanAt(i: number): number | null {
    return this.lean ? interp(this.videoTime(i), this.lean.t, this.lean.lean) : null
  }

  /** Body attitude of frame i (rig coordinates; columns = body right, down, forward of the upright bike) */
  bodyInRig(i: number): Mat3 {
    return mountAt(this.mount, this.tc(i))
  }

  /**
   * Gravity down direction of frame i (rig coordinates): the "down" of the level orientation with the lean undone from the body attitude
   * (used by dynamic stitching to estimate the distance to the ground for directions below the horizon)
   */
  downInRig(i: number): [number, number, number] {
    const v = this.frame(i, { yaw: 0, pitch: 0, fov: 90, leanRatio: 0 }).view // columns = view right, down, forward (rig coordinates)
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
      // When the lean angle is known, the turn sideways is made relative to the "horizontal":
      //   body · Rz(-L) (undo lean) · Ry(yaw) (turn sideways about the vertical axis) · Rz(ratio·|cos(yaw)|·L) (tilt kept on screen) · Rx(pitch)
      // because turning about the tilted body up axis would make the line of sight drop toward the ground when turning to the inside during a lean.
      // At yaw 0 this equals the previous body · Rz(-(1-ratio)·L) · Rx(pitch) (Rz is the body fore-aft axis)
      // The tilt kept on screen follows cos(yaw): + at the front, 0 (level) at exactly sideways, - at the back. A view toward the rear is opposite to the body fore-aft axis,
      // so the same lean tilts the screen the opposite way from the front (looking back with the camera fixed to the body gives Ry(180°)·Rz(L) = Rz(-L)·Ry(180°)).
      // It used to be |cos(yaw)|, which tilted the same way as the front even when looking back
      const L = interp(tv, this.lean.t, this.lean.lean) * d2r
      const bike = qMul(w, mountQ)
      const rz = (a: number): Quat => qFromRotvec(0, 0, a)
      const keep = view.leanRatio * Math.cos(view.yaw * d2r)
      world = qMul(qMul(qMul(qMul(bike, rz(-L)), qFromRotvec(0, view.yaw * d2r, 0)), rz(keep * L)), qFromRotvec(view.pitch * d2r, 0, 0))
      w = qMul(w, qAxisAngle(fwd, -(1 - view.leanRatio) * L)) // for displaying the correction amount (attitude at yaw 0)
    } else {
      world = qMul(qMul(w, mountQ), qYawPitch(view.yaw, view.pitch))
    }
    const rel = qMul(qConj(qc), world)
    const corr = qMul(qConj(qc), w)
    const correctionDeg = (2 * Math.acos(Math.min(1, Math.abs(corr[3]))) * 180) / Math.PI
    // The rotation used for readout does not depend on the view, so reuse it for the same frame (when split screen has several views)
    let rs: Float32Array | null = null
    if (this.stab.rollingShutter) {
      if (this.rsCache.i !== i) this.rsCache = { i, rs: readoutRotations(this.ori, tc, this.readoutUs) }
      rs = this.rsCache.rs
    }
    return { view: qToMat(rel), world, rs, correctionDeg }
  }
}
