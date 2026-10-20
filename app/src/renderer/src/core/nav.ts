// 方位と位置の融合（標識を地図上の地点に固定して描くため）。
//
// GPS は 1Hz で遅れもあるので、そのままだと位置と方位がカクつき、標識が画面上で泳ぐ。
//   方位: ジャイロのヨーレート（車体の上軸まわり ÷ cos(リーン) で鉛直軸まわりに直す）を積分した方位を、
//         GPS の方位で低い周波数だけ補正する（相補フィルタ）
//   位置: 前輪速と上の方位で積み上げた位置（推測航法）を、GPS の位置で低い周波数だけ補正する
// どちらも動画を書き出す時点で全体が分かっているので、前後対称のガウスで平滑化する（遅れなし）。
import { fastGaussian as gaussianFilter, interpSorted } from './dsp'
import type { Telemetry } from './telemetry'

export interface NavTrack {
  x: Float32Array // 東 [m]（GPS の平面座標と同じ原点）
  y: Float32Array // 北 [m]
  heading: Float32Array // 方位 [deg]（北 = 0、東 = 90、時計回り）
  /** 鉛直軸まわりの旋回の角速度 [deg/s]（右旋回が正。振動を除くため σ=0.3秒で平滑化済み） */
  turnRate: Float32Array
}

const CORRECT_SIGMA_S = 3 // GPS で補正する低い周波数の範囲（ガウスの σ, 秒）

/** NaN の区間を前後の値の線形補間で埋める（端は最寄りの値） */
function fillNaN(a: Float64Array): Float64Array {
  const out = a.slice()
  const n = a.length
  let last = -1
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(out[i])) continue
    if (last < 0) for (let k = 0; k < i; k++) out[k] = out[i]
    else if (i - last > 1) for (let k = last + 1; k < i; k++) out[k] = out[last] + ((out[i] - out[last]) * (k - last)) / (i - last)
    last = i
  }
  if (last >= 0) for (let k = last + 1; k < n; k++) out[k] = out[last]
  else out.fill(0)
  return out
}

/**
 * @param yaw カメラのジャイロを車体の上軸へ射影したもの（100Hz, deg/s。正 = 上から見て反時計回り = 左旋回）
 */
export function buildNav(tel: Telemetry, yaw: { t: Float64Array; r: Float64Array }): NavTrack | null {
  const ch = tel.channels
  if (!ch.heading || !ch.gpsX || !ch.gpsY || !ch.speed) return null
  const n = tel.n
  const rate = tel.rate
  const dt = 1 / rate
  const grid = new Float64Array(n).map((_, i) => i / rate)
  const d2r = Math.PI / 180
  // 鉛直軸まわりの旋回速度（右旋回 = 方位が増える向きを正）
  const yr = interpSorted(grid, yaw.t, yaw.r)
  const turn = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const L = ch.lean ? ch.lean[i] : 0
    const c = Math.cos(Math.min(Math.abs(L), 60) * d2r)
    turn[i] = -yr[i] / c
  }
  // ---- 方位 ----
  const hg = new Float64Array(n)
  for (let i = 1; i < n; i++) hg[i] = hg[i - 1] + turn[i] * dt
  // GPS の方位とのずれ（折り返しを解いて連続にする）。遅いときの GPS 方位は当てにならないので除く
  const diff = new Float64Array(n).fill(NaN)
  let prev = NaN
  for (let i = 0; i < n; i++) {
    const h = ch.heading[i]
    const v = ch.speed[i]
    if (Number.isNaN(h) || !(v > 15)) continue
    let d = h - hg[i]
    if (!Number.isNaN(prev)) d = prev + ((((d - prev) % 360) + 540) % 360) - 180
    diff[i] = d
    prev = d
  }
  const off = gaussianFilter(fillNaN(diff), CORRECT_SIGMA_S * rate)
  const heading = new Float32Array(n)
  for (let i = 0; i < n; i++) heading[i] = (((hg[i] + off[i]) % 360) + 360) % 360
  // ---- 位置（推測航法 + GPS 補正） ----
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const v = Number.isNaN(ch.speed[i]) ? 0 : ch.speed[i] / 3.6
    const h = (hg[i] + off[i]) * d2r
    px[i] = px[i - 1] + v * Math.sin(h) * dt
    py[i] = py[i - 1] + v * Math.cos(h) * dt
  }
  const ex = new Float64Array(n)
  const ey = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    ex[i] = Number.isNaN(ch.gpsX[i]) ? NaN : ch.gpsX[i] - px[i]
    ey[i] = Number.isNaN(ch.gpsY[i]) ? NaN : ch.gpsY[i] - py[i]
  }
  const cx = gaussianFilter(fillNaN(ex), CORRECT_SIGMA_S * rate)
  const cy = gaussianFilter(fillNaN(ey), CORRECT_SIGMA_S * rate)
  const x = new Float32Array(n)
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = px[i] + cx[i]
    y[i] = py[i] + cy[i]
  }
  // 旋回の角速度はスティックの振動（±20°/s 程度）を含むので、曲線半径などに使う前に平滑化する
  return { x, y, heading, turnRate: Float32Array.from(gaussianFilter(turn, 0.3 * rate)) }
}
