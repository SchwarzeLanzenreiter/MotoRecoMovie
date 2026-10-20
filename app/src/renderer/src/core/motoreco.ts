// MotoReco の車両ログ（CSV "TO Custom v1"）の読み込み・映像との同期・リーン角の融合。
// proto/motoreco.py と proto/leanfusion.py の移植。仕組みは docs/motoreco-lean.md を参照。
import type { Imu } from './insv'
import { crossCorrelate, interpSorted, lowpassFiltfilt } from './dsp'
import { matVec, type Mat3 } from './quat'
import { IMU_TO_RIG } from './motion'
import { mountFwdAt, mountUpAt, type MountTrack } from './mount'

export interface BikeLog {
  t: Float64Array // 秒（ログ先頭から）
  lean: Float64Array // LeanAngle [deg]
  leanUpdated: Uint8Array // その行で値が更新されたか
  rollRate: Float64Array // 無効値は NaN
  speed: Float64Array
  lat: Float64Array
  lon: Float64Array
  /** すべての数値列（列名 → 値）。テレメトリー表示に使う */
  columns: Map<string, Float64Array>
}

const FS = 100

export function parseMotoReco(text: string): BikeLog {
  const lines = text.split(/\r?\n/)
  let h = 0
  while (h < lines.length && !lines[h].startsWith('time')) h++
  if (h >= lines.length) throw new Error('MotoReco の CSV ではありません（time 列が見つかりません）')
  const cols = lines[h].split(',').map((c) => c.trim())
  const it = cols.indexOf('time (ms)')
  if (it < 0) throw new Error('列 time (ms) がありません')
  const rows = lines.length - h - 1
  const all = cols.map(() => new Float64Array(rows))
  let n = 0
  for (let i = h + 1; i < lines.length; i++) {
    const s = lines[i]
    if (!s) continue
    const v = s.split(',')
    for (let c = 0; c < cols.length; c++) all[c][n] = parseFloat(v[c])
    n++
  }
  const t = all[it].slice(0, n).map((v) => v / 1000)
  return bikeLogFromColumns(t, new Map(cols.map((c, i) => [c, all[i].slice(0, n)])))
}

/** 列名 → 値の表（CSV または .dat をデコードしたもの）から BikeLog を作る。t は秒 */
export function bikeLogFromColumns(t: Float64Array, columns: Map<string, Float64Array>): BikeLog {
  const need = (name: string): Float64Array => {
    const v = columns.get(name)
    if (!v) throw new Error(`列 ${name} がありません`)
    return v
  }
  const n = t.length
  const lean = need('LeanAngle')
  const rr = need('RollRate').map((r) => (r <= -124.9 ? NaN : r)) // ロガーの無効値は -125
  const opt = (name: string): Float64Array => columns.get(name) ?? new Float64Array(n).fill(NaN)
  const upd = new Uint8Array(n)
  upd[0] = 1
  for (let i = 1; i < n; i++) upd[i] = lean[i] !== lean[i - 1] ? 1 : 0
  return { t, lean, leanUpdated: upd, rollRate: rr, speed: opt('Speed'), lat: opt('lat (deg)'), lon: opt('lon (deg)'), columns }
}

/** カメラのジャイロを車体ロール軸へ射影し、100Hz（動画時刻[s], deg/s）にする */
export function cameraRollRate(imu: Imu, mount: Mat3 | MountTrack, firstFrameUs: number, M: Mat3 = IMU_TO_RIG): { t: Float64Array; r: Float64Array } {
  if (!(mount instanceof Float64Array)) return cameraRate(imu, (t) => mountFwdAt(mount, t), firstFrameUs, M)
  return cameraRate(imu, [mount[2], mount[5], mount[8]], firstFrameUs, M) // R_mount の第3列 = 前方向
}

/** カメラのジャイロを車体のヨー軸（上方向）へ射影し、100Hz にする */
export function cameraYawRate(imu: Imu, mount: Mat3 | MountTrack, firstFrameUs: number, M: Mat3 = IMU_TO_RIG): { t: Float64Array; r: Float64Array } {
  if (!(mount instanceof Float64Array)) return cameraRate(imu, (t) => mountUpAt(mount, t), firstFrameUs, M)
  return cameraRate(imu, [-mount[1], -mount[4], -mount[7]], firstFrameUs, M) // R_mount の第2列（下）の逆
}

/** カメラのジャイロを指定した軸（リグ座標）へ射影し、100Hz（動画時刻[s], deg/s）にする */
export function cameraRate(imu: Imu, axis: number[] | ((tUs: number) => number[]), firstFrameUs: number, M: Mat3 = IMU_TO_RIG): { t: Float64Array; r: Float64Array } {
  // 動画時刻で 10ms ごとの区間に分けて平均する（t は等間隔）。以前は 10 サンプルずつまとめていたが、X5 の IMU は 1000Hz ではなく
  // 約 996Hz なので、等間隔とみなして使う所（粗同期の相互相関・リーン角の融合）で時間の尺度が 0.4% ずれ、13 分の動画で 2 秒ずれて同期できなかった
  const n = imu.ts.length
  if (!n) return { t: new Float64Array(0), r: new Float64Array(0) }
  const t0 = Math.ceil(((imu.ts[0] - firstFrameUs) / 1e6) * FS) / FS
  const m = Math.max(0, Math.floor(((imu.ts[n - 1] - firstFrameUs) / 1e6 - t0) * FS))
  const t = new Float64Array(m)
  const r = new Float64Array(m)
  const cnt = new Float64Array(m)
  let fb = -1
  let f: number[] = typeof axis === 'function' ? [0, 0, 1] : axis
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((imu.ts[i] - firstFrameUs) / 1e6 - t0) * FS + 0.5)
    if (b < 0 || b >= m) continue
    // 軸が時刻で変わるとき（取り付け姿勢の時間変化）は、区間ごとの軸
    if (typeof axis === 'function' && b !== fb) {
      f = axis(firstFrameUs + (t0 + b / FS) * 1e6)
      fb = b
    }
    const g = matVec(M, [imu.gyro[i * 3], imu.gyro[i * 3 + 1], imu.gyro[i * 3 + 2]])
    r[b] += g[0] * f[0] + g[1] * f[1] + g[2] * f[2]
    cnt[b]++
  }
  // 空の区間（サンプルの抜け）は前後から補う
  let last = -1
  for (let b = 0; b < m; b++) {
    t[b] = t0 + b / FS
    if (cnt[b]) {
      r[b] /= cnt[b]
      if (last >= 0 && b - last > 1) for (let k = last + 1; k < b; k++) r[k] = r[last] + ((r[b] - r[last]) * (k - last)) / (b - last)
      last = b
    }
  }
  for (let b = last + 1; b < m; b++) r[b] = last >= 0 ? r[last] : 0
  return { t, r }
}

export interface SyncResult {
  a: number // ログ時刻 = a·動画時刻 + b
  b: number
  sign: number
  peakRatio: number // 主ピーク / 第2ピーク（同期の信頼度。2以上なら概ね確実）
  windows: { t: number; offset: number; corr: number }[]
  residualMs: number
}

function corr(a: Float64Array, b: Float64Array, mask: Uint8Array): number {
  let n = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < a.length; i++)
    if (mask[i]) {
      n++
      sa += a[i]
      sb += b[i]
    }
  if (n < 10) return 0
  const ma = sa / n
  const mb = sb / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < a.length; i++)
    if (mask[i]) {
      const x = a[i] - ma
      const y = b[i] - mb
      sab += x * y
      saa += x * x
      sbb += y * y
    }
  return sab / Math.sqrt(saa * sbb + 1e-12)
}

/** 粗同期: ログのロールレートとカメラのロール角速度（平滑化済み）の全範囲の相互相関 */
function coarseSync(logT: Float64Array, rollRate: Float64Array, cr: Float64Array, camT0: number): { coarse: number; sign: number; peakRatio: number; peak: number } {
  const ng = Math.floor(logT[logT.length - 1] * FS)
  const grid = new Float64Array(ng).map((_, i) => i / FS)
  const rrClean = rollRate.map((v) => (Number.isNaN(v) ? 0 : v))
  const validF = rollRate.map((v) => (Number.isNaN(v) ? 0 : 1))
  const rr = interpSorted(grid, logT, rrClean)
  const valid = interpSorted(grid, logT, validF)
  for (let i = 0; i < ng; i++) if (valid[i] < 0.99) rr[i] = 0
  const norm = (x: Float64Array): Float64Array => {
    let m = 0
    for (const v of x) m += v
    m /= x.length
    let s = 0
    for (const v of x) s += (v - m) ** 2
    s = Math.sqrt(s / x.length) + 1e-12
    return x.map((v) => (v - m) / s)
  }
  const c = crossCorrelate(norm(rr), norm(cr))
  const L = cr.length - 1
  let j = 0
  for (let i = 1; i < c.length; i++) if (Math.abs(c[i]) > Math.abs(c[j])) j = i
  let second = 0
  for (let i = 0; i < c.length; i++) if (Math.abs(i - j) > 2 * FS) second = Math.max(second, Math.abs(c[i]))
  return { coarse: (j - L) / FS - camT0, sign: Math.sign(c[j]), peakRatio: Math.abs(c[j]) / (second + 1e-12), peak: Math.abs(c[j]) }
}

/**
 * ログが映像と同じ走行のものかの目安（粗同期の主ピーク / 第2ピーク。2 以上なら概ね確実）。
 * フォルダの中から映像に合う .dat を選ぶのに使う
 */
export function logMatchScore(logT: Float64Array, rollRate: Float64Array, cam: { t: Float64Array; r: Float64Array }): { peakRatio: number; peak: number; offset: number } {
  if (logT.length < FS * 10) return { peakRatio: 0, peak: 0, offset: 0 }
  const r = coarseSync(logT, rollRate, lowpassFiltfilt(cam.r, 3, FS), cam.t[0])
  return { peakRatio: r.peakRatio, peak: r.peak, offset: r.coarse }
}

// 窓ごとに探すずれの範囲 [s]（粗同期のずれから）。カメラの時計とログの時計の進み方が違うと、ずれが動画の中で変わっていく
// （X5 の 2026-08-13 の動画: 13 分で 2.9 秒、0.37%。X6 では 0）。25 分の動画で 0.5% までなら届くように
const SYNC_SEARCH_S = 4

export function syncLog(log: BikeLog, cam: { t: Float64Array; r: Float64Array }, windowS = 30): SyncResult {
  const cr = lowpassFiltfilt(cam.r, 3, FS) // スティックの振動を落とす
  const rrClean = log.rollRate.map((v) => (Number.isNaN(v) ? 0 : v))
  const validF = log.rollRate.map((v) => (Number.isNaN(v) ? 0 : 1))
  // ---- 1. 粗同期（全範囲のFFT相互相関）----
  const { coarse, sign, peakRatio } = coarseSync(log.t, log.rollRate, cr, cam.t[0])

  // ---- 2. 窓ごとに精密化 ----
  // まず粗同期のずれ ±SYNC_SEARCH_S を 50ms 刻み（間引いた点）で探し、窓のずれを直線に当てはめる（時計の進み方の違い）。
  // その直線の ±60ms を 10ms 刻み → 1ms 刻みで詰める。以前は粗同期のずれ ±0.3 秒だけを探していたので、
  // 時計の進み方が違うカメラ（X5）では、ほとんどの窓が見つからず同期できなかった（リーン角が ±120° になり、浮遊標識が傾いた）
  type Win = { t: number; tc: Float64Array; rc: Float64Array }
  const wins: Win[] = []
  for (let w0 = cam.t[0]; w0 + windowS < cam.t[cam.t.length - 1]; w0 += windowS / 2) {
    const i0 = Math.ceil((w0 - cam.t[0]) * FS)
    const i1 = i0 + Math.round(windowS * FS)
    const tc = cam.t.subarray(i0, i1)
    const rc = cr.subarray(i0, i1)
    let mean = 0
    for (const v of rc) mean += v
    mean /= rc.length
    let sd = 0
    for (const v of rc) sd += (v - mean) ** 2
    if (Math.sqrt(sd / rc.length) < 2) continue // 直線ばかりの区間は手がかりがない
    wins.push({ t: w0 + windowS / 2, tc, rc })
  }
  const evalOff = (w: Win, off: number, step = 1): number => {
    const tc = step > 1 ? w.tc.filter((_, i) => i % step === 0) : w.tc
    const rc = step > 1 ? w.rc.filter((_, i) => i % step === 0) : w.rc
    const tq = tc.map((v) => v + off)
    const lv = interpSorted(tq, log.t, rrClean)
    const ok = interpSorted(tq, log.t, validF)
    const mask = new Uint8Array(ok.length)
    let cnt = 0
    for (let i = 0; i < ok.length; i++) if (ok[i] > 0.99) (mask[i] = 1), cnt++
    if (cnt < 0.9 * ok.length) return -2
    return corr(lv, rc, mask) * sign
  }
  // 広く探す
  const rough: { t: number; off: number; c: number }[] = []
  for (const w of wins) {
    let best = { c: -2, off: coarse }
    for (let off = coarse - SYNC_SEARCH_S; off <= coarse + SYNC_SEARCH_S; off += 0.05) {
      const v = evalOff(w, off, 5)
      if (v > best.c) best = { c: v, off }
    }
    if (best.c > 0.5) rough.push({ t: w.t, off: best.off, c: best.c })
  }
  // 窓のずれ = 傾き·t + 切片 をロバストに（中央値の傾き）
  let predict = (_t: number): number => coarse
  if (rough.length >= 3) {
    const slopes: number[] = []
    for (let i = 0; i < rough.length; i++) for (let j = i + 1; j < rough.length; j++) if (rough[j].t - rough[i].t > windowS) slopes.push((rough[j].off - rough[i].off) / (rough[j].t - rough[i].t))
    slopes.sort((x, y) => x - y)
    const slope = slopes.length ? slopes[slopes.length >> 1] : 0
    const ics = rough.map((r) => r.off - slope * r.t).sort((x, y) => x - y)
    const ic = ics[ics.length >> 1]
    predict = (t) => slope * t + ic
  }
  // 詰める
  const windows: SyncResult['windows'] = []
  for (const w of wins) {
    const p0 = predict(w.t)
    let best = { c: -2, off: p0 }
    for (let off = p0 - 0.06; off <= p0 + 0.06; off += 0.01) {
      const v = evalOff(w, off)
      if (v > best.c) best = { c: v, off }
    }
    const base = best.off
    for (let off = base - 0.01; off <= base + 0.01; off += 0.001) {
      const v = evalOff(w, off)
      if (v > best.c) best = { c: v, off }
    }
    if (best.c > 0.5) windows.push({ t: w.t, offset: best.off, corr: best.c })
  }
  // t_log = t_v + off(t_v), off = (a-1)·t_v + b をロバストに当てはめ
  let a = 1
  let b = coarse
  let residualMs = NaN
  if (windows.length >= 3) {
    let use = windows.map(() => true)
    let coef = [0, coarse]
    for (let it = 0; it < 3; it++) {
      let sx = 0
      let sy = 0
      let sxx = 0
      let sxy = 0
      let n = 0
      windows.forEach((w, i) => {
        if (!use[i]) return
        sx += w.t
        sy += w.offset
        sxx += w.t * w.t
        sxy += w.t * w.offset
        n++
      })
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
      coef = [slope, (sy - slope * sx) / n]
      const res = windows.map((w) => Math.abs(w.offset - (coef[0] * w.t + coef[1])))
      const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)]
      use = res.map((r) => r < Math.max(3 * med, 0.002))
    }
    a = 1 + coef[0]
    b = coef[1]
    const res = windows.map((w) => w.offset - (coef[0] * w.t + coef[1]))
    residualMs = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length) * 1000
  }
  return { a, b, sign, peakRatio, windows, residualMs }
}

export interface LeanTrack {
  t: Float64Array // 動画時刻 [s]（100Hz）
  lean: Float64Array // 実際のリーン角 [deg]（ジャイロの尺度）
  sd: Float64Array
  k: number // d(LeanAngle)/dt = k·ω_roll（ログの尺度の補正）
  rateCorr: number
}

/** ジャイロとログのリーン角を融合（カルマンフィルタ + RTS平滑化） */
export function fuseLean(log: BikeLog, cam: { t: Float64Array; r: Float64Array }, sync: SyncResult): LeanTrack {
  const n = cam.t.length
  const logOnVideo = log.t.map((t) => (t - sync.b) / sync.a)
  // ---- 尺度 k: d(Lean)/dt ≈ k·ω_roll ----
  const L = interpSorted(cam.t, logOnVideo, log.lean)
  const Lf = lowpassFiltfilt(L, 1, FS)
  const wf = lowpassFiltfilt(cam.r, 1, FS)
  let swd = 0
  let sww = 0
  let sdd = 0
  for (let i = 1; i < n - 1; i++) {
    const dL = ((Lf[i + 1] - Lf[i - 1]) * FS) / 2
    if (Math.abs(wf[i]) > 200) continue
    swd += wf[i] * dL
    sww += wf[i] * wf[i]
    sdd += dL * dL
  }
  const k = swd / sww
  const rateCorr = swd / Math.sqrt(sww * sdd)

  // ---- 観測（ログの値が更新された時刻だけ、1/k 倍して実際の角度へ）----
  const z = new Float64Array(n).fill(NaN)
  for (let i = 0; i < log.t.length; i++) {
    if (!log.leanUpdated[i]) continue
    const gi = Math.round((logOnVideo[i] - cam.t[0]) * FS)
    if (gi >= 0 && gi < n) z[gi] = log.lean[i] / k
  }
  const u = lowpassFiltfilt(cam.r, 3, FS)
  const dt = 1 / FS
  const q0 = (3 * dt) ** 2
  const q1 = (0.05 * dt) ** 2
  const R = (0.6 / k) ** 2
  // 状態 [L, bias]、F = [[1,-dt],[0,1]]
  const xs = new Float64Array(n * 2)
  const Ps = new Float64Array(n * 4)
  const xp = new Float64Array(n * 2)
  const Pp = new Float64Array(n * 4)
  let first = 0
  while (first < n && Number.isNaN(z[first])) first++
  let x0 = Number.isNaN(z[first]) ? 0 : z[first]
  let x1 = 0
  let p00 = 25
  let p01 = 0
  let p11 = 1
  for (let i = 0; i < n; i++) {
    // 予測
    x0 = x0 - dt * x1 + u[i] * dt
    const n00 = p00 - 2 * dt * p01 + dt * dt * p11 + q0
    const n01 = p01 - dt * p11
    const n11 = p11 + q1
    p00 = n00
    p01 = n01
    p11 = n11
    xp[i * 2] = x0
    xp[i * 2 + 1] = x1
    Pp.set([p00, p01, p01, p11], i * 4)
    // 観測
    if (!Number.isNaN(z[i])) {
      const S = p00 + R
      const K0 = p00 / S
      const K1 = p01 / S
      const y = z[i] - x0
      x0 += K0 * y
      x1 += K1 * y
      const m00 = (1 - K0) * p00
      const m01 = (1 - K0) * p01
      const m11 = p11 - K1 * p01
      p00 = m00
      p01 = m01
      p11 = m11
    }
    xs[i * 2] = x0
    xs[i * 2 + 1] = x1
    Ps.set([p00, p01, p01, p11], i * 4)
  }
  // RTS 平滑化
  for (let i = n - 2; i >= 0; i--) {
    const P = Ps.subarray(i * 4, i * 4 + 4)
    const Pn = Pp.subarray((i + 1) * 4, (i + 1) * 4 + 4)
    // C = P F^T Pn^-1
    const pf00 = P[0] - dt * P[1]
    const pf01 = P[1]
    const pf10 = P[2] - dt * P[3]
    const pf11 = P[3]
    const det = Pn[0] * Pn[3] - Pn[1] * Pn[2]
    const i00 = Pn[3] / det
    const i01 = -Pn[1] / det
    const i10 = -Pn[2] / det
    const i11 = Pn[0] / det
    const c00 = pf00 * i00 + pf01 * i10
    const c01 = pf00 * i01 + pf01 * i11
    const c10 = pf10 * i00 + pf11 * i10
    const c11 = pf10 * i01 + pf11 * i11
    const d0 = xs[(i + 1) * 2] - xp[(i + 1) * 2]
    const d1 = xs[(i + 1) * 2 + 1] - xp[(i + 1) * 2 + 1]
    xs[i * 2] += c00 * d0 + c01 * d1
    xs[i * 2 + 1] += c10 * d0 + c11 * d1
    // P = P + C (Ps_next - Pn) C^T
    const Psn = Ps.subarray((i + 1) * 4, (i + 1) * 4 + 4)
    const e00 = Psn[0] - Pn[0]
    const e01 = Psn[1] - Pn[1]
    const e10 = Psn[2] - Pn[2]
    const e11 = Psn[3] - Pn[3]
    const t00 = c00 * e00 + c01 * e10
    const t01 = c00 * e01 + c01 * e11
    const t10 = c10 * e00 + c11 * e10
    const t11 = c10 * e01 + c11 * e11
    Ps[i * 4] = P[0] + t00 * c00 + t01 * c01
    Ps[i * 4 + 1] = P[1] + t00 * c10 + t01 * c11
    Ps[i * 4 + 2] = P[2] + t10 * c00 + t11 * c01
    Ps[i * 4 + 3] = P[3] + t10 * c10 + t11 * c11
  }
  const lean = new Float64Array(n)
  const sd = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lean[i] = xs[i * 2]
    sd[i] = Math.sqrt(Math.max(Ps[i * 4], 0))
  }
  return { t: cam.t, lean, sd, k, rateCorr }
}
