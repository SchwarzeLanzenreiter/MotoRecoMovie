// テレメトリーの統一: 車両ログの各列と融合済みのリーン角を、動画の時刻にそろえた等間隔（100Hz）の
// チャンネルにまとめる。メーター表示（重ね表示）と走行状態の判定（画角の自動切り替え）の両方で使う。
//
// 列の選び方は docs/telemetry.md を参照（例: 速度は1秒更新の Speed ではなく 10ms 更新の前輪速 FrSpeed1）。
import type { DisturbTrack } from './disturb'
import { gaussianFilter, interpSorted, lowpassFiltfilt } from './dsp'
import type { BikeLog, LeanTrack, SyncResult } from './motoreco'
import type { RidingTrack } from './riding'
import type { NavTrack } from './nav'
import type { Corner } from './corners'

export const TELEMETRY_RATE = 100 // Hz

export type ChannelKey =
  | 'speed'
  | 'rpm'
  | 'gear'
  | 'lean'
  | 'airTemp'
  | 'accelG'
  | 'latG'
  | 'throttle'
  | 'brakeFront'
  | 'brakeRear'
  | 'lat'
  | 'lon'
  | 'alt'
  | 'heading'
  | 'grade'
  | 'distance'
  | 'gpsX'
  | 'gpsY'
  | 'slip'
  | 'frStroke'
  | 'rrStroke'
  | 'rollRate'
  | 'yawRate'
  | 'xG'
  | 'zG'

export interface ChannelInfo {
  label: string
  unit: string
  /** 'step' = 段階値（ギアなど）。補間せず直前の値を使う */
  interp: 'linear' | 'step' | 'angle'
}

export const CHANNELS: Record<ChannelKey, ChannelInfo> = {
  speed: { label: '速度', unit: 'km/h', interp: 'linear' }, // i18n-ignore
  rpm: { label: 'エンジン回転数', unit: 'rpm', interp: 'linear' }, // i18n-ignore
  gear: { label: 'ギア', unit: '', interp: 'step' }, // i18n-ignore
  lean: { label: 'リーン角', unit: '°', interp: 'linear' }, // i18n-ignore
  airTemp: { label: '外気温', unit: '℃', interp: 'linear' }, // i18n-ignore
  accelG: { label: '前後加速度', unit: 'G', interp: 'linear' }, // i18n-ignore
  latG: { label: '横加速度', unit: 'G', interp: 'linear' }, // i18n-ignore
  throttle: { label: 'スロットル', unit: '%', interp: 'linear' }, // i18n-ignore
  brakeFront: { label: 'フロントブレーキ', unit: 'bar', interp: 'linear' }, // i18n-ignore
  brakeRear: { label: 'リアブレーキ', unit: 'bar', interp: 'linear' }, // i18n-ignore
  lat: { label: '緯度', unit: '°', interp: 'linear' }, // i18n-ignore
  lon: { label: '経度', unit: '°', interp: 'linear' }, // i18n-ignore
  alt: { label: '標高', unit: 'm', interp: 'linear' }, // i18n-ignore
  heading: { label: '方位', unit: '°', interp: 'angle' }, // i18n-ignore
  grade: { label: '勾配', unit: '%', interp: 'linear' }, // i18n-ignore
  distance: { label: '走行距離', unit: 'km', interp: 'linear' }, // i18n-ignore
  gpsX: { label: '東西の位置', unit: 'm', interp: 'linear' }, // i18n-ignore
  gpsY: { label: '南北の位置', unit: 'm', interp: 'linear' }, // i18n-ignore
  slip: { label: 'スリップ率', unit: '%', interp: 'linear' }, // i18n-ignore
  frStroke: { label: 'フロントのストローク', unit: 'mm', interp: 'linear' }, // i18n-ignore
  rrStroke: { label: 'リアのストローク', unit: 'mm', interp: 'linear' }, // i18n-ignore
  rollRate: { label: 'ロール角速度（車両）', unit: '°/s', interp: 'linear' }, // i18n-ignore
  yawRate: { label: 'ヨー角速度（車両）', unit: '°/s', interp: 'linear' }, // i18n-ignore
  xG: { label: '前後G（車両のセンサー）', unit: 'G', interp: 'linear' }, // i18n-ignore
  zG: { label: '上下G（車両のセンサー）', unit: 'G', interp: 'linear' } // i18n-ignore
}

export interface GpsTrack {
  /** 原点（最初の有効な測位点） */
  lat0: number
  lon0: number
  /** 平面座標 [m]（東, 北）。1Hz の測位点を滑らかにつないだ軌跡（地図の描画用に 1 秒ごと） */
  x: Float32Array
  y: Float32Array
  t: Float32Array // 動画時刻 [s]
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
}

export interface Telemetry {
  rate: number
  n: number
  /** グリッドの先頭の動画時刻 [s]（= 0） */
  t0: number
  channels: Partial<Record<ChannelKey, Float32Array>>
  gps: GpsTrack | null
  /** 走行状態（加速・減速など）。メーターの見た目の切り替えに使う */
  riding?: RidingTrack
  /** 融合した方位と位置（ジャイロ + 前輪速 + GPS）。標識を地点に固定して描くのに使う */
  nav?: NavTrack
  /** コーナーの一覧と曲線半径 */
  corners?: Corner[]
  /** 車体挙動の乱れの強さ（時刻ごと） */
  disturb?: DisturbTrack
  /**
   * どこから作ったか。'imu' = 車両ログが無いので動画の IMU から推定したもの（core/imu-telemetry.ts。リーン角・車速・前後 G・走った道の形だけ）。
   * メーター類には使わない（推定の車速などを実測のように見せないため）
   */
  source?: 'log' | 'imu'
}

const R_EARTH = 6378137

/** 外れ値（単発のスパイク）を除くメディアンフィルタ */
function median(x: Float64Array, half: number): Float64Array {
  const out = new Float64Array(x.length)
  const w: number[] = []
  for (let i = 0; i < x.length; i++) {
    w.length = 0
    for (let k = Math.max(0, i - half); k <= Math.min(x.length - 1, i + half); k++) w.push(x[k])
    w.sort((a, b) => a - b)
    out[i] = w[w.length >> 1]
  }
  return out
}

/** 値が実際に変わった行だけを取り出す（1秒更新の GPS などの重複を除く） */
function changes(t: Float64Array, ...cols: Float64Array[]): { t: Float64Array; v: Float64Array[] } {
  const idx: number[] = []
  for (let i = 0; i < t.length; i++) {
    if (cols.some((c) => !Number.isFinite(c[i]))) continue
    if (idx.length === 0 || cols.some((c) => c[i] !== c[idx[idx.length - 1]])) idx.push(i)
  }
  return { t: Float64Array.from(idx, (i) => t[i]), v: cols.map((c) => Float64Array.from(idx, (i) => c[i])) }
}

/** 3次エルミート（Catmull-Rom）補間。1Hz の GPS を滑らかにつなぐ */
function catmullRom(xs: Float64Array, ys: Float64Array, xq: Float64Array): Float64Array {
  const n = xs.length
  const out = new Float64Array(xq.length)
  if (n < 2) return out.fill(n ? ys[0] : NaN)
  const slope = (i: number): number => {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    return (ys[b] - ys[a]) / (xs[b] - xs[a])
  }
  let j = 0
  for (let q = 0; q < xq.length; q++) {
    const x = xq[q]
    if (x <= xs[0]) {
      out[q] = ys[0]
      continue
    }
    if (x >= xs[n - 1]) {
      out[q] = ys[n - 1]
      continue
    }
    while (j < n - 2 && xs[j + 1] < x) j++
    const h = xs[j + 1] - xs[j]
    const s = (x - xs[j]) / h
    const s2 = s * s
    const s3 = s2 * s
    out[q] = (2 * s3 - 3 * s2 + 1) * ys[j] + (s3 - 2 * s2 + s) * h * slope(j) + (-2 * s3 + 3 * s2) * ys[j + 1] + (s3 - s2) * h * slope(j + 1)
  }
  return out
}

/**
 * 変速の途中の短い 0（ニュートラル）を、前の段のままにする。ギアの信号は変速の間 0.1〜0.2 秒だけ 0 を送るので、
 * そのままだと「1 → N → 2」とちらつく。段と段の間の SHIFT_GAP 秒未満の 0 だけを埋める（止まってニュートラルに入れた長い 0 は残す）
 */
const SHIFT_GAP = 0.5
export function holdThroughShift(gear: Float32Array, rate: number): Float32Array {
  const out = gear.slice()
  const maxLen = Math.round(SHIFT_GAP * rate)
  let i = 0
  while (i < out.length) {
    if (out[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < out.length && out[j] === 0) j++
    if (i > 0 && j < out.length && out[i - 1] > 0 && out[j] > 0 && j - i < maxLen) out.fill(out[i - 1], i, j)
    i = j
  }
  return out
}

/**
 * 車両ログと融合済みリーン角から、動画時刻 0〜durationSec の統一テレメトリーを作る。
 * lean が null（ログなし）の場合はリーン角チャンネルを作らない。
 */
export function buildTelemetry(log: BikeLog, sync: SyncResult, lean: LeanTrack | null, durationSec: number, gpsDelaySec = 0): Telemetry {
  const rate = TELEMETRY_RATE
  const n = Math.floor(durationSec * rate) + 1
  const grid = new Float64Array(n).map((_, i) => i / rate)
  // ログ時刻 → 動画時刻
  const tv = log.t.map((t) => (t - sync.b) / sync.a)
  const col = (name: string): Float64Array | null => log.columns.get(name) ?? null
  const ch: Telemetry['channels'] = {}
  const linear = (v: Float64Array): Float32Array => Float32Array.from(interpSorted(grid, tv, v))
  const stepOf = (v: Float64Array): Float32Array => {
    const out = new Float32Array(n)
    let j = 0
    for (let i = 0; i < n; i++) {
      while (j < tv.length - 1 && tv[j + 1] <= grid[i]) j++
      out[i] = v[j]
    }
    return out
  }

  // 速度: 前輪速（10ms更新）。単発のスパイク（最大 469 km/h など）をメディアンで除く
  const fr = col('FrSpeed1') ?? col('Speed')
  if (fr) {
    ch.speed = linear(median(fr, 4))
    // 前後加速度 [G]: 速度の変化率から求める。ログの X_Axis_G は坂の重力成分を含み（勾配との回帰 0.94）、
    // さらに -0.45G で頭打ちになる（強いブレーキ中の平均 -0.455）ので使わない
    const sm = gaussianFilter(Float64Array.from(ch.speed), 0.15 * rate)
    const acc = new Float64Array(n)
    for (let i = 1; i < n - 1; i++) acc[i] = ((sm[i + 1] - sm[i - 1]) * rate) / 2 / 3.6 / 9.80665
    acc[0] = acc[1]
    acc[n - 1] = acc[n - 2]
    ch.accelG = Float32Array.from(gaussianFilter(acc, 0.1 * rate))
  }
  const rpm = col('RPM')
  if (rpm) ch.rpm = linear(rpm)
  const gear = col('Gear')
  if (gear) ch.gear = holdThroughShift(stepOf(gear), rate)
  const air = col('AirTemp')
  if (air) ch.airTemp = linear(air)
  // 横加速度: 先頭の無効値（-3.7 付近）を除く
  const fixG = (v: Float64Array): Float64Array => v.map((x) => (x < -3 ? 0 : x))
  const yg = col('Y_Axis_G')
  if (yg) ch.latG = Float32Array.from(gaussianFilter(interpSorted(grid, tv, fixG(yg)), 5))
  const thr = col('ThrottelPosition')
  if (thr) ch.throttle = linear(thr)
  const bfu = col('FrBrakeUp')
  const bfd = col('FrBrakeDown')
  if (bfu || bfd) {
    const a = bfu ?? bfd!
    const b = bfd ?? bfu!
    ch.brakeFront = linear(a.map((v, i) => Math.max(v, b[i])))
  }
  const br = col('RrBrake1')
  if (br) ch.brakeRear = linear(br)
  // 車体挙動の乱れの検出用（core/disturb.ts）: スリップ率・サスのストローク・車両の 6 軸センサー（そのままの値）
  const raw: [ChannelKey, string, boolean][] = [
    ['slip', 'SlipRate', false],
    ['frStroke', 'FrStroke', false],
    ['rrStroke', 'RrStroke', false],
    ['rollRate', 'RollRate', false],
    ['yawRate', 'YawRate', false],
    ['xG', 'X_Axis_G', true],
    ['zG', 'Z_Axis_G', true]
  ]
  for (const [k, name, isG] of raw) {
    const v = col(name)
    if (v) ch[k] = linear(isG ? fixG(v) : v)
  }
  if (lean) ch.lean = Float32Array.from(interpSorted(grid, lean.t, lean.lean))

  // ---- GPS（1Hz）----
  let gps: GpsTrack | null = null
  const la = col('lat (deg)')
  const lo = col('lon (deg)')
  if (la && lo) {
    const valid = (i: number): boolean => Number.isFinite(la[i]) && Number.isFinite(lo[i]) && (la[i] !== 0 || lo[i] !== 0)
    const okIdx = tv.map((_, i) => (valid(i) ? 1 : 0))
    const tOk = Float64Array.from(tv.filter((_, i) => okIdx[i]))
    const laOk = Float64Array.from(la.filter((_, i) => okIdx[i]))
    const loOk = Float64Array.from(lo.filter((_, i) => okIdx[i]))
    const c = changes(tOk, laOk, loOk)
    if (c.t.length >= 2) {
      const lat0 = c.v[0][0]
      const lon0 = c.v[1][0]
      const kx = ((Math.PI / 180) * R_EARTH * Math.cos((lat0 * Math.PI) / 180))
      const ky = (Math.PI / 180) * R_EARTH
      const ex = c.v[1].map((v) => (v - lon0) * kx)
      const ny = c.v[0].map((v) => (v - lat0) * ky)
      // 測位時刻 = ログ上で値が変わった時刻 − gpsDelay（測位からログに載るまでの遅れ）
      const tFix = c.t.map((t) => t - gpsDelaySec)
      const gx = catmullRom(tFix, ex, grid)
      const gy = catmullRom(tFix, ny, grid)
      ch.lat = Float32Array.from(gy, (y) => lat0 + y / ky)
      ch.lon = Float32Array.from(gx, (x) => lon0 + x / kx)
      // 地図の描画用の平面座標 [m]（原点 = 最初の測位点、東 = +x、北 = +y）
      ch.gpsX = Float32Array.from(gx)
      ch.gpsY = Float32Array.from(gy)
      // 方位: 0.5秒先との差から（北 = 0°, 東 = 90°）。止まっているときは直前の値を保つ
      const head = new Float32Array(n)
      const L = Math.round(0.5 * rate)
      let last = 0
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - L)
        const b = Math.min(n - 1, i + L)
        const dx = gx[b] - gx[a]
        const dy = gy[b] - gy[a]
        if (Math.hypot(dx, dy) > 1.0) last = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
        head[i] = last
      }
      ch.heading = head
      // 走行距離 [km]
      const dist = new Float32Array(n)
      for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(gx[i] - gx[i - 1], gy[i] - gy[i - 1]) / 1000
      ch.distance = dist
      // 地図用の軌跡（1秒ごと）
      const m = Math.floor(durationSec) + 1
      const tx = new Float32Array(m)
      const ty = new Float32Array(m)
      const tt = new Float32Array(m)
      let b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
      for (let i = 0; i < m; i++) {
        const gi = Math.min(n - 1, i * rate)
        tx[i] = gx[gi]
        ty[i] = gy[gi]
        tt[i] = i
        b = { minX: Math.min(b.minX, tx[i]), maxX: Math.max(b.maxX, tx[i]), minY: Math.min(b.minY, ty[i]), maxY: Math.max(b.maxY, ty[i]) }
      }
      gps = { lat0, lon0, x: tx, y: ty, t: tt, bounds: b }
    }
    // 標高と勾配
    const alt = col('alt (m)')
    if (alt) {
      const altOk = Float64Array.from(alt.filter((_, i) => okIdx[i]))
      const ca = changes(tOk, altOk)
      if (ca.t.length >= 2) {
        const g = gaussianFilter(catmullRom(ca.t.map((t) => t - gpsDelaySec), ca.v[0], grid), 1.0 * rate)
        ch.alt = Float32Array.from(g)
        if (ch.distance) {
          // 勾配 [%] = 標高差 / 走行距離（前後 3 秒の差から。遅いときは不安定なので 0 とみなす）
          const grade = new Float32Array(n)
          const W = 3 * rate
          for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - W)
            const bb = Math.min(n - 1, i + W)
            const dd = (ch.distance[bb] - ch.distance[a]) * 1000
            grade[i] = dd > 20 ? ((g[bb] - g[a]) / dd) * 100 : 0
          }
          ch.grade = grade
        }
      }
    }
  }
  // ログが存在しない時間帯（録画がログより先に始まった部分など）と、ログの起動直後 0.5 秒
  // （不正な値が入る。例: 前輪速 469 km/h）は「データなし」（NaN）にする。リーン角はジャイロで全区間ある
  const tStart = tv[0] + 0.5
  const tEnd = tv[tv.length - 1]
  for (const [k, d] of Object.entries(ch) as [ChannelKey, Float32Array][]) {
    if (k === 'lean') continue
    const margin = k === 'accelG' ? 0.5 : 0 // 微分した値は端の影響が残るので少し広めに
    for (let i = 0; i < n; i++) if (grid[i] < tStart + margin || grid[i] > tEnd - margin) d[i] = NaN
  }
  return { rate, n, t0: 0, channels: ch, gps }
}

/** 動画時刻 t [s] のチャンネルの値（無い・データなしの区間なら null） */
export function sampleChannel(tel: Telemetry, key: ChannelKey, t: number): number | null {
  const d = tel.channels[key]
  if (!d) return null
  const x = (t - tel.t0) * tel.rate
  const ok = (v: number): number | null => (Number.isNaN(v) ? null : v)
  if (x <= 0) return ok(d[0])
  if (x >= tel.n - 1) return ok(d[tel.n - 1])
  const i = Math.floor(x)
  const f = x - i
  if (Number.isNaN(d[i]) || Number.isNaN(d[i + 1])) return null
  const info = CHANNELS[key]
  if (info.interp === 'step') return d[i]
  if (info.interp === 'angle') {
    const dd = ((((d[i + 1] - d[i]) % 360) + 540) % 360) - 180
    return (d[i] + dd * f + 360) % 360
  }
  return d[i] + (d[i + 1] - d[i]) * f
}

/** 指定時刻の全チャンネルの値 */
export function sampleAll(tel: Telemetry, t: number): Partial<Record<ChannelKey, number>> {
  const out: Partial<Record<ChannelKey, number>> = {}
  for (const k of Object.keys(tel.channels) as ChannelKey[]) {
    const v = sampleChannel(tel, k, t)
    if (v !== null) out[k] = v
  }
  return out
}

/**
 * GPS の遅れ（測位からログに載るまで）[s] を推定する。
 * GPS の方位の変化率と、ジャイロのヨーレート（車体の上軸まわり）が最もよく一致するずれを探す。
 * このサンプルでは約 1.0 秒（相関 0.93）。tel は遅れ 0 で作ったもの。
 */
export function estimateGpsDelay(tel: Telemetry, yaw: { t: Float64Array; r: Float64Array }): { delay: number; corr: number } {
  const h = tel.channels.heading
  const sp = tel.channels.speed
  if (!h || !sp) return { delay: 0, corr: 0 }
  const rate = tel.rate
  const n = tel.n
  // 方位の変化率 [deg/s]（1秒幅の差、±180 の折り返しを考慮）
  const hr = new Float64Array(n)
  const H = Math.round(rate / 2)
  for (let i = H; i < n - H; i++) hr[i] = ((((h[i + H] - h[i - H]) % 360) + 540) % 360) - 180
  const yawLp = lowpassFiltfilt(yaw.r, 0.5, 100)
  const y = interpSorted(new Float64Array(n).map((_, i) => i / rate), yaw.t, yawLp)
  let best = { delay: 0, corr: 0 }
  for (let d = -0.5; d <= 3.0001; d += 0.05) {
    // 遅れ d を補正した方位変化率 hr(t + d) と、ヨーレート y(t) の相関
    const k = Math.round(d * rate)
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let i = rate; i < n - rate; i += 5) {
      const j = i + k
      // ログのない区間（NaN）は除く。混ざると相関が NaN になり、推定が常に 0 になる
      if (j < H || j >= n - H || !(sp[i] >= 20) || Number.isNaN(hr[j]) || Number.isNaN(y[i])) continue
      sxy += hr[j] * y[i]
      sxx += hr[j] * hr[j]
      syy += y[i] * y[i]
    }
    const c = sxy / Math.sqrt(sxx * syy + 1e-12)
    if (Math.abs(c) > Math.abs(best.corr)) best = { delay: Math.round(d * 100) / 100, corr: c }
  }
  return best
}
