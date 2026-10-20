// 走行状態の判定: 停止・減速・コーナリング・加速・巡航。
// メーターの見た目の切り替え（重ね表示）と、画角の自動切り替えの両方で使う。
//
//   1. 各時刻の生の状態を、しきい値とヒステリシス（入る値と出る値を変える）で決める
//   2. 短すぎる区間（ちらつき）を前の状態に吸収させる
//   3. 状態ごとの重み（0〜1）を、切り替わりから一定時間かけて滑らかに変える（見た目の遷移に使う）
import type { Telemetry } from './telemetry'

export const STATES = ['cruise', 'accel', 'brake', 'corner', 'stop'] as const
export type RidingState = (typeof STATES)[number]

export const STATE_NAMES: Record<RidingState, string> = {
  cruise: '巡航', // i18n-ignore
  accel: '加速', // i18n-ignore
  brake: '減速', // i18n-ignore
  corner: 'コーナリング', // i18n-ignore
  stop: '停止' // i18n-ignore
}

export const STATE_COLORS: Record<RidingState, string> = {
  cruise: '#6b7385',
  accel: '#5cc28a',
  brake: '#e5675f',
  corner: '#4f9cf9',
  stop: '#c9a24a'
}

export interface RidingParams {
  stopEnter: number // km/h
  stopExit: number
  brakeEnterBar: number // ブレーキ圧
  brakeExitBar: number
  brakeEnterG: number // 減速G（負）
  brakeExitG: number
  cornerEnter: number // リーン角 [deg]
  cornerExit: number
  accelEnterThrottle: number // %
  accelEnterG: number
  accelExitG: number
  minDuration: number // 区間の最短 [s]
  transition: number // 見た目の切り替えにかける時間 [s]
}

export const DEFAULT_RIDING: RidingParams = {
  stopEnter: 3,
  stopExit: 6,
  brakeEnterBar: 4,
  brakeExitBar: 1.5,
  brakeEnterG: -0.18,
  brakeExitG: -0.08,
  cornerEnter: 15,
  cornerExit: 10,
  accelEnterThrottle: 25,
  accelEnterG: 0.08,
  accelExitG: 0.03,
  minDuration: 0.6,
  transition: 0.4
}

export interface RidingTrack {
  rate: number
  /** 各時刻の状態（STATES のインデックス） */
  state: Uint8Array
  /** 状態ごとの重み（切り替えを滑らかにしたもの、合計 1） */
  weights: Float32Array[]
  /** コーナリング区間中のそこまでの最大リーン角 [deg]（符号つき、区間外は 0） */
  peakLean: Float32Array
  /**
   * リーン角の MAX ホールド [deg]（符号つき）。同じ側に傾いている間の最大値を保ち、
   * 車体が反対側へ切り返した（反対側に LEAN_SIDE_DEG を超えた）時点でリセットする
   */
  leanHold: Float32Array
  /** 区間の一覧 */
  segments: { state: RidingState; start: number; end: number }[]
}

const S = { cruise: 0, accel: 1, brake: 2, corner: 3, stop: 4 } as const

/** これを超えて反対側に傾いたら「切り返した」とみなす [deg] */
export const LEAN_SIDE_DEG = 3

/** リーン角の MAX ホールド（切り返しでリセット）を計算する */
export function leanHoldTrack(lean: ArrayLike<number>): Float32Array {
  const out = new Float32Array(lean.length)
  let side = 0
  let hold = 0
  for (let i = 0; i < lean.length; i++) {
    const l = lean[i]
    if (Number.isNaN(l)) {
      out[i] = hold
      continue
    }
    const s = Math.sign(l)
    if (Math.abs(l) > LEAN_SIDE_DEG && s !== side) {
      side = s
      hold = 0
    }
    if (s === side && Math.abs(l) > Math.abs(hold)) hold = l
    out[i] = hold
  }
  return out
}

export function detectRiding(tel: Telemetry, p: RidingParams = DEFAULT_RIDING): RidingTrack {
  const n = tel.n
  const rate = tel.rate
  const ch = tel.channels
  const zero = new Float32Array(n)
  const speed = ch.speed ?? zero
  const lean = ch.lean ?? zero
  const g = ch.accelG ?? zero
  const thr = ch.throttle ?? zero
  const bf = ch.brakeFront ?? zero
  const br = ch.brakeRear ?? zero
  // スロットルの記録が無い（動画の IMU から推定したもの）ときは、前後 G だけで加速を判定する
  const hasThrottle = !!ch.throttle

  // ---- 1. ヒステリシス付きの生の状態 ----
  const raw = new Uint8Array(n)
  let stop = speed[0] < p.stopEnter
  let brake = false
  let corner = false
  let accel = false
  for (let i = 0; i < n; i++) {
    // ログのない区間（NaN）は判定できないので巡航とみなす
    if (Number.isNaN(speed[i])) {
      raw[i] = S.cruise
      stop = brake = corner = accel = false
      continue
    }
    const bar = Math.max(bf[i] || 0, br[i] || 0)
    stop = stop ? speed[i] < p.stopExit : speed[i] < p.stopEnter
    const gi = g[i] || 0
    brake = brake ? bar > p.brakeExitBar || gi < p.brakeExitG : bar > p.brakeEnterBar || gi < p.brakeEnterG
    const al = Math.abs(lean[i])
    corner = corner ? al > p.cornerExit : al > p.cornerEnter
    const th = thr[i] || 0
    accel = hasThrottle
      ? accel
        ? gi > p.accelExitG && th > p.accelEnterThrottle * 0.6
        : gi > p.accelEnterG && th > p.accelEnterThrottle
      : accel
        ? gi > p.accelExitG
        : gi > p.accelEnterG
    // 優先順位: 停止 > 減速 > コーナリング > 加速 > 巡航（コーナー手前のブレーキは減速を優先）
    raw[i] = stop ? S.stop : brake ? S.brake : corner ? S.corner : accel ? S.accel : S.cruise
  }

  // ---- 2. 短い区間を前の状態に吸収 ----
  const minLen = Math.round(p.minDuration * rate)
  const state = raw.slice()
  const runs = (): { s: number; a: number; b: number }[] => {
    const r: { s: number; a: number; b: number }[] = []
    let a = 0
    for (let i = 1; i <= n; i++) {
      if (i === n || state[i] !== state[a]) {
        r.push({ s: state[a], a, b: i })
        a = i
      }
    }
    return r
  }
  for (let pass = 0; pass < 3; pass++) {
    const rs = runs()
    let changed = false
    for (let k = 0; k < rs.length; k++) {
      const r = rs[k]
      if (r.b - r.a >= minLen) continue
      // 前の区間の状態で埋める（先頭なら次の区間）
      const fill = k > 0 ? state[rs[k - 1].a] : k + 1 < rs.length ? rs[k + 1].s : r.s
      if (fill === r.s) continue
      state.fill(fill, r.a, r.b)
      changed = true
    }
    if (!changed) break
  }

  // ---- 3. 状態ごとの重み（一定の速さで目標へ近づける） ----
  const weights = STATES.map(() => new Float32Array(n))
  const step = 1 / Math.max(1, p.transition * rate)
  const w = new Float64Array(STATES.length)
  w[state[0]] = 1
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = 0; k < STATES.length; k++) {
      const target = state[i] === k ? 1 : 0
      w[k] += Math.max(-step, Math.min(step, target - w[k]))
      sum += w[k]
    }
    for (let k = 0; k < STATES.length; k++) weights[k][i] = w[k] / sum
  }

  // ---- コーナーごとの最大リーン角 ----
  const peakLean = new Float32Array(n)
  const segments: RidingTrack['segments'] = []
  for (const r of runs()) {
    segments.push({ state: STATES[r.s], start: r.a / rate, end: r.b / rate })
    if (r.s !== S.corner) continue
    let pk = 0
    for (let i = r.a; i < r.b; i++) {
      if (Math.abs(lean[i]) > Math.abs(pk)) pk = lean[i]
      peakLean[i] = pk
    }
  }
  return { rate, state, weights, peakLean, leanHold: leanHoldTrack(lean), segments }
}

/** 時刻 t [s] の状態の重み（STATES の順） */
export function weightsAt(r: RidingTrack, t: number): number[] {
  const i = Math.max(0, Math.min(r.state.length - 1, Math.round(t * r.rate)))
  return r.weights.map((w) => w[i])
}

export function stateAt(r: RidingTrack, t: number): RidingState {
  const i = Math.max(0, Math.min(r.state.length - 1, Math.round(t * r.rate)))
  return STATES[r.state[i]]
}
