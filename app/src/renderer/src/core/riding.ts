// Riding state detection: stop, deceleration, cornering, acceleration, cruise.
// Used both for the meter's appearance switching (overlay) and for auto camera.
//
//   1. Decide the raw state at each time with thresholds and hysteresis (different enter and exit values)
//   2. Absorb too-short sections (flicker) into the previous state
//   3. Change the per-state weights (0-1) smoothly over a fixed time after a switch (used for visual transitions)
import type { Telemetry } from './telemetry'

export const STATES = ['cruise', 'accel', 'brake', 'corner', 'stop'] as const
export type RidingState = (typeof STATES)[number]

export const STATE_NAMES: Record<RidingState, string> = {
  cruise: 'Cruise', // i18n-ignore
  accel: 'Accelerating', // i18n-ignore
  brake: 'Braking', // i18n-ignore
  corner: 'Cornering', // i18n-ignore
  stop: 'Stopped' // i18n-ignore
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
  brakeEnterBar: number // brake pressure
  brakeExitBar: number
  brakeEnterG: number // deceleration G (negative)
  brakeExitG: number
  cornerEnter: number // lean angle [deg]
  cornerExit: number
  accelEnterThrottle: number // %
  accelEnterG: number
  accelExitG: number
  minDuration: number // minimum section length [s]
  transition: number // time taken for visual switching [s]
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
  /** State at each time (index into STATES) */
  state: Uint8Array
  /** Per-state weights (switching smoothed, sum 1) */
  weights: Float32Array[]
  /** Maximum lean angle so far within a cornering section [deg] (signed, 0 outside sections) */
  peakLean: Float32Array
  /**
   * MAX hold of the lean angle [deg] (signed). Keeps the maximum while leaning to the same side,
   * and resets when the bike flicks to the other side (beyond LEAN_SIDE_DEG on the opposite side)
   */
  leanHold: Float32Array
  /** List of sections */
  segments: { state: RidingState; start: number; end: number }[]
}

const S = { cruise: 0, accel: 1, brake: 2, corner: 3, stop: 4 } as const

/** Leaning to the opposite side beyond this is regarded as a flick [deg] */
export const LEAN_SIDE_DEG = 3

/** Computes the MAX hold of the lean angle (reset at a flick) */
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
  // If there is no throttle record (estimated from the video's IMU), acceleration is judged from longitudinal G alone
  const hasThrottle = !!ch.throttle

  // ---- 1. Raw state with hysteresis ----
  const raw = new Uint8Array(n)
  let stop = speed[0] < p.stopEnter
  let brake = false
  let corner = false
  let accel = false
  for (let i = 0; i < n; i++) {
    // Sections without a log (NaN) cannot be judged, so regard them as cruise
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
    // Priority: stop > deceleration > cornering > acceleration > cruise (braking just before a corner is classified as deceleration)
    raw[i] = stop ? S.stop : brake ? S.brake : corner ? S.corner : accel ? S.accel : S.cruise
  }

  // ---- 2. Absorb short sections into the previous state ----
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
      // Fill with the previous section's state (the next section if it is the first)
      const fill = k > 0 ? state[rs[k - 1].a] : k + 1 < rs.length ? rs[k + 1].s : r.s
      if (fill === r.s) continue
      state.fill(fill, r.a, r.b)
      changed = true
    }
    if (!changed) break
  }

  // ---- 3. Per-state weights (approach the target at a constant rate) ----
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

  // ---- Maximum lean angle per corner ----
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

/** State weights at time t [s] (in STATES order) */
export function weightsAt(r: RidingTrack, t: number): number[] {
  const i = Math.max(0, Math.min(r.state.length - 1, Math.round(t * r.rate)))
  return r.weights.map((w) => w[i])
}

export function stateAt(r: RidingTrack, t: number): RidingState {
  const i = Math.max(0, Math.min(r.state.length - 1, Math.round(t * r.rate)))
  return STATES[r.state[i]]
}
