// 車両ログが無いときの「動画の IMU から推定したテレメトリー」。
// 画角の自動切り替え（走行状態）と浮遊標識（コーナーの曲線半径・走った道の形）を、精度は落ちるがログ無しでも動かすため。
//
//   リーン角: 前方の軸まわりの回転（ジャイロ）を積分する。積分はずれていくので、まっすぐ走っている所
//            （旋回していない = リーンは 0 のはず）でずれを求めて引く
//   旋回:     上まわりの回転 ÷ cos(リーン) = 鉛直軸まわりの旋回の角速度
//   車速:     コーナーでは、リーン角と旋回の速さから v = g·tan(リーン) / 旋回の角速度（バイクは曲がる力と重力の合力の向きに倒れる）。
//            その間は前後の加速度で積み上げ、止まっている間は 0 にする（前後対称のカルマン平滑化）
//   前後 G:   カメラの加速度の前方成分（坂の重力の分を除くため、ゆっくりした変化を引く）
//   停止:     ジャイロがほとんど動いていない間
//   方位・位置: 旋回を積分した方位（最初の向き = 北）と、車速で積み上げた位置（GPS が無いので地図とは合わない）
// 取り付け姿勢は core/mount.ts の推定（時刻ごと）を使う
import { fastGaussian as gaussianFilter } from './dsp'
import { IMU_TO_RIG } from './motion'
import { mountAt, type MountTrack } from './mount'
import type { Imu } from './insv'
import type { LeanTrack } from './motoreco'
import type { NavTrack } from './nav'
import type { Telemetry } from './telemetry'
import type { Mat3 } from './quat'

const RATE = 100
const G = 9.80665
// 走っているか: 2 秒間のジャイロ（振動を含む）の二乗平均がこれより大きいか、ゆっくりした揺れ（0.3 秒平均）が大きいか、旋回している [deg/s]。
// 止まっている間もエンジンの振動で 8〜15°/s 揺れるが、走っている間は路面の振動で 20°/s 以上になる。
// ゆっくり（20km/h 未満）走っている間は振動が小さいが、車体が細かく左右に揺れる（止まっている間 2〜3°/s、ゆっくり走っている間 7〜11°/s。手元の動画）
const MOVING_DPS = 16
const MOVING_SWAY_DPS = 4.5
const MOVING_TURN_DPS = 3
const STRAIGHT_DPS = 2 // 旋回がこれより遅ければまっすぐ（リーン 0）とみなす [deg/s]
const LEAN_ANCHOR_SIGMA = 4 // リーン角のずれをならす幅 [s]
const SPEED_MIN_LEAN = 12 // 車速を求めるのに使うリーン角の下限 [deg]
const SPEED_MIN_TURN = 4 // 同じく旋回の角速度の下限 [deg/s]
const ACC_DETREND = 20 // 前後 G から引くゆっくりした変化（坂・カメラの傾きのずれ）の幅 [s]
// 車体のリーン角のうち、曲がる力と重力の合力の向きに当たる割合（tan の比）。タイヤに幅があるので、車体は理屈より少し深く倒れる。
// v = g·tan(リーン)/旋回 のままだと、コーナーでの車速が 15〜17% 大きく出た（車両ログの前輪速と比べて）
const LEAN_EFFECTIVE = 0.86
// カメラの加速度の前方成分は、車両の前後 G（前輪速の変化）より 1.1〜1.2 倍大きく出た（カメラの台の揺れ）ので合わせる
const ACC_SCALE = 0.87

export interface ImuTelemetry {
  telemetry: Telemetry
  /** リーン角（MotionModel の水平の補正に使う） */
  lean: LeanTrack
}

/**
 * @param durationSec 動画の長さ [s]（出力の時間軸 = 動画時刻、100Hz）
 */
export function buildImuTelemetry(imu: Imu, mount: MountTrack, firstFrameUs: number, durationSec: number, M: Mat3 = IMU_TO_RIG): ImuTelemetry {
  const n = Math.floor(durationSec * RATE) + 1
  const d2r = Math.PI / 180
  // ---- 1. 100Hz の動画時刻へ: 前方まわりのロール・上まわりのヨー・前方の加速度・ジャイロの大きさ ----
  const roll = new Float64Array(n)
  const yawUp = new Float64Array(n)
  const accF = new Float64Array(n)
  const gyr2 = new Float64Array(n)
  const gx = new Float64Array(n)
  const gy = new Float64Array(n)
  const gz = new Float64Array(n)
  const cnt = new Float64Array(n)
  let R = mountAt(mount, imu.ts[0])
  let lastK = -1
  for (let i = 0; i < imu.ts.length; i++) {
    const k = Math.round(((imu.ts[i] - firstFrameUs) / 1e6) * RATE)
    if (k < 0 || k >= n) continue
    if (k !== lastK && (k & 7) === 0) R = mountAt(mount, imu.ts[i]) // 取り付け姿勢は 80ms ごとに更新すれば十分
    lastK = k
    const g = [0, 1, 2].map((r) => M[r * 3] * imu.gyro[i * 3] + M[r * 3 + 1] * imu.gyro[i * 3 + 1] + M[r * 3 + 2] * imu.gyro[i * 3 + 2])
    const a = [0, 1, 2].map((r) => M[r * 3] * imu.acc[i * 3] + M[r * 3 + 1] * imu.acc[i * 3 + 1] + M[r * 3 + 2] * imu.acc[i * 3 + 2])
    // R の列 = 右・下・前（リグ座標）
    roll[k] += g[0] * R[2] + g[1] * R[5] + g[2] * R[8]
    yawUp[k] -= g[0] * R[1] + g[1] * R[4] + g[2] * R[7]
    accF[k] += a[0] * R[2] + a[1] * R[5] + a[2] * R[8]
    gyr2[k] += g[0] * g[0] + g[1] * g[1] + g[2] * g[2]
    gx[k] += g[0]
    gy[k] += g[1]
    gz[k] += g[2]
    cnt[k]++
  }
  fillAverage(roll, cnt)
  fillAverage(yawUp, cnt)
  fillAverage(accF, cnt)
  fillAverage(gyr2, cnt)
  fillAverage(gx, cnt)
  fillAverage(gy, cnt)
  fillAverage(gz, cnt)
  // ---- 2. 走っているか ----
  const moving = new Uint8Array(n)
  {
    const cs = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + gyr2[i]
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - RATE)
      const hi = Math.min(n, i + RATE + 1)
      moving[i] = Math.sqrt((cs[hi] - cs[lo]) / (hi - lo)) > MOVING_DPS ? 1 : 0
    }
  }
  const yawS = gaussianFilter(yawUp, 0.5 * RATE)
  {
    // ゆっくりした揺れ: 0.3 秒平均したジャイロの大きさの、2 秒間の二乗平均
    const sm = [gx, gy, gz].map((a) => gaussianFilter(a, 0.15 * RATE))
    const cs = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + sm[0][i] ** 2 + sm[1][i] ** 2 + sm[2][i] ** 2
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - RATE)
      const hi = Math.min(n, i + RATE + 1)
      if (Math.sqrt((cs[hi] - cs[lo]) / (hi - lo)) > MOVING_SWAY_DPS || Math.abs(yawS[i]) > MOVING_TURN_DPS) moving[i] = 1
    }
  }
  // ---- 3. リーン角: ロールの積分から、まっすぐ走っている所でのずれを引く ----
  const ang = new Float64Array(n)
  for (let i = 1; i < n; i++) ang[i] = ang[i - 1] + roll[i] / RATE
  const anchorW = new Float64Array(n)
  const anchorV = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    // まっすぐ（旋回していない）か止まっている所では、リーン（車体の傾き）は 0 のはず
    const straight = Math.abs(yawS[i]) < STRAIGHT_DPS
    anchorW[i] = straight ? 1 : 0
    anchorV[i] = straight ? ang[i] : 0
  }
  const drift = weightedSmooth(anchorV, anchorW, LEAN_ANCHOR_SIGMA * RATE)
  const lean = new Float64Array(n)
  for (let i = 0; i < n; i++) lean[i] = ang[i] - drift[i]
  const leanS = gaussianFilter(lean, 0.05 * RATE)
  // ---- 4. 旋回（鉛直軸まわり、右旋回が正）と方位 ----
  const turn = new Float64Array(n)
  for (let i = 0; i < n; i++) turn[i] = -yawS[i] / Math.cos(Math.min(Math.abs(leanS[i]), 60) * d2r)
  // ---- 5. 前後 G（ゆっくりした変化を引く）----
  const accS = gaussianFilter(accF, 0.3 * RATE)
  const accTrend = gaussianFilter(accF, ACC_DETREND * RATE)
  const accelG = new Float32Array(n)
  for (let i = 0; i < n; i++) accelG[i] = moving[i] ? (accS[i] - accTrend[i]) * ACC_SCALE : 0
  // ---- 6. 車速: コーナーでの推定（v = g·tan L / ω）と、止まっている間の 0 を、前後の加速度でつなぐ ----
  const meas = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    if (!moving[i]) {
      meas[i] = 0
      continue
    }
    const L = leanS[i]
    const w = turn[i]
    // リーンと旋回の向きがそろっている（右に倒れて右へ曲がる）ときだけ
    if (Math.abs(L) >= SPEED_MIN_LEAN && Math.abs(w) >= SPEED_MIN_TURN && Math.sign(L) === Math.sign(w)) {
      const v = (G * LEAN_EFFECTIVE * Math.tan(Math.abs(L) * d2r)) / (Math.abs(w) * d2r)
      if (v > 2 && v < 70) meas[i] = v
    }
  }
  const speedMs = kalmanSpeed(meas, accelG, moving)
  const speed = new Float32Array(n)
  for (let i = 0; i < n; i++) speed[i] = Math.max(0, speedMs[i]) * 3.6
  // ---- 7. 方位と位置（推測航法） ----
  const heading = new Float32Array(n)
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  let h = 0
  for (let i = 1; i < n; i++) {
    h += turn[i] / RATE
    heading[i] = ((h % 360) + 360) % 360
    const v = speed[i] / 3.6
    x[i] = x[i - 1] + (v * Math.sin(h * d2r)) / RATE
    y[i] = y[i - 1] + (v * Math.cos(h * d2r)) / RATE
  }
  const nav: NavTrack = { x, y, heading, turnRate: Float32Array.from(gaussianFilter(turn, 0.3 * RATE)) }
  const telemetry: Telemetry = {
    rate: RATE,
    n,
    t0: 0,
    channels: { lean: Float32Array.from(leanS), speed, accelG },
    gps: null,
    nav,
    source: 'imu'
  }
  const t = new Float64Array(n).map((_, i) => i / RATE)
  return { telemetry, lean: { t, lean: leanS, sd: new Float64Array(n).fill(3), k: 1, rateCorr: 0 } }
}

/** 積み上げた合計を、サンプル数で割る（サンプルの無い所は前の値） */
function fillAverage(a: Float64Array, cnt: Float64Array): void {
  let last = 0
  for (let i = 0; i < a.length; i++) {
    if (cnt[i] > 0) last = a[i] / cnt[i]
    a[i] = last
  }
}

/** 重み付きのガウス平均（重みの無い所は、近くの重みのある所の値で埋める） */
function weightedSmooth(v: Float64Array, w: Float64Array, sigma: number): Float64Array {
  const num = gaussianFilter(Float64Array.from(v, (x, i) => x * w[i]), sigma)
  const den = gaussianFilter(w, sigma)
  const wide = gaussianFilter(Float64Array.from(v, (x, i) => x * w[i]), sigma * 8)
  const wideD = gaussianFilter(w, sigma * 8)
  const out = new Float64Array(v.length)
  let last = 0
  for (let i = 0; i < v.length; i++) {
    if (den[i] > 0.05) out[i] = num[i] / den[i]
    else if (wideD[i] > 1e-3) out[i] = wide[i] / wideD[i]
    else out[i] = last
    last = out[i]
  }
  return out
}

/**
 * 車速 [m/s]: 状態 = 速度、予測 = 前後の加速度、観測 = コーナーでの推定と停止中の 0。前後対称（RTS 平滑化）
 * @param meas 観測（NaN = なし）
 * @param acc 前後の加速度 [G]
 */
function kalmanSpeed(meas: Float64Array, acc: Float32Array, moving: Uint8Array): Float64Array {
  const n = meas.length
  const dt = 1 / RATE
  const Q = 0.04 // 加速度の誤差（坂・ずれ）による 1 サンプルあたりの分散の増え方 [(m/s)²]
  const Rm = 9 // コーナーでの推定の誤差 [(m/s)²]
  const R0 = 0.01 // 停止中の 0
  const xf = new Float64Array(n)
  const pf = new Float64Array(n)
  const xp = new Float64Array(n)
  const pp = new Float64Array(n)
  let x = 15
  let p = 400
  for (let i = 0; i < n; i++) {
    // 予測
    x = x + acc[i] * G * dt
    p = p + Q
    if (!moving[i]) x = Math.min(x, 3)
    xp[i] = x
    pp[i] = p
    // 観測
    const z = meas[i]
    if (!Number.isNaN(z)) {
      const r = z === 0 ? R0 : Rm
      const k = p / (p + r)
      x = x + k * (z - x)
      p = (1 - k) * p
    }
    xf[i] = x
    pf[i] = p
  }
  // 後ろから平滑化
  const xs = new Float64Array(n)
  xs[n - 1] = xf[n - 1]
  for (let i = n - 2; i >= 0; i--) {
    const c = pf[i] / pp[i + 1]
    xs[i] = xf[i] + c * (xs[i + 1] - xp[i + 1])
  }
  return xs
}
