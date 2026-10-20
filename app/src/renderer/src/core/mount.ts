// カメラの取り付け姿勢の時間変化（MountTrack）: 前方 = バイクの進行方向、上 = リーンしていないときの車体の上 になるよう、
// 取り付け姿勢を求める。走行中にカメラの向きがバイクに対して少しずつ変わる（台が回る・緩む）ときは時刻ごとに求める。
//
//   上(t)   = 走っている間の加速度の時間平均（ガウス窓 UP_SIGMA 秒）。バイクはリーン中も合力が車体の上下方向なので、車体の上
//   前後(t) = 上に垂直な面で、次の 3 つの手がかりを合わせた軸（ガウス窓 FWD_SIGMA 秒）
//     ・倒れる回転: 0.5 秒平均したジャイロの主成分。はっきりしていれば正確だが、台が揺れるとその揺れの軸を拾う
//     ・加減速: 水平な加速度の主成分（リーン中も横向きの力はほとんど出ないので、水平な加速度は前後方向）。直線でも分かる
//     ・ヨーとの関係: ヨー角速度を傾きで回帰した係数の向き。曲がる側へ倒れる軸だけが効くので、台の揺れに強い（粗い）
//   前と後ろ = 曲がる側へ倒れる関係（core/motion.ts の leanYawCoupling と同じ考え）で、動画全体で 1 つに決める
//   時刻ごとの推定を確からしさで重み付けしてならし（SMOOTH_SIGMA 秒）、止まっている間は前後の確かな推定で埋める
// 動画を通して向きがほとんど変わらなければ（FIXED_DEG 未満）、全体で 1 つの取り付け姿勢（estimateMount）を使う。
// 車両ログを読み込んだら refineMountWithLog で詰める（ログの車速・リーン角・ロール角速度を使う）。
// 確かめ方は test/mount.test.ts（合成データ）と test/mount-log.test.ts（実データとログ）
import type { Imu } from './insv'
import { eigSym3, estimateMount, FWD_MIN_CORR, IMU_TO_RIG } from './motion'
import { matToQ, qSlerp, qToMat, type Mat3, type Quat } from './quat'

export interface MountTrack {
  /** 最初の点の時刻 [us]（ジャイロの時間軸）と間隔 [us] */
  t0: number
  dt: number
  /** 取り付け姿勢（列 = 車体の右・下・前、リグ座標の行列）の四元数 [x,y,z,w]×N */
  q: Float64Array
  /** 動画を通して 1 つの姿勢か */
  fixed: boolean
  /** 前後の向きの決め方（lean = 曲がる側へ倒れる関係、lens = レンズの向き、log = 車両ログで詰めたもの） */
  by: 'lean' | 'lens' | 'log'
  /** 動画の中で前方・上が最も大きく変わった角度 [deg] */
  maxDeg: number
}

const UP_SIGMA = 15 // 上方向の時間平均 [s]
const FWD_SIGMA = 40 // 前後の軸の時間窓 [s]
const STEP = 1 // 出力の間隔 [s]
const SMOOTH_SIGMA = 30 // 時刻ごとの推定を確からしさで重み付けしてならす幅 [s]
const MOVING_DPS = 1.5 // 2 秒間のジャイロの二乗平均がこれ以上なら走っている [deg/s]
export const FIXED_DEG = 12 // これより変化が小さければ 1 つの姿勢にする [deg]

type V3 = [number, number, number]
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: ArrayLike<number>): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}
const angleDeg = (a: ArrayLike<number>, b: ArrayLike<number>): number => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI

/** 前・上（リグ座標）から取り付け姿勢の行列（列 = 右・下・前） */
function mountMat(fwd: ArrayLike<number>, up: ArrayLike<number>): Mat3 {
  const f = unit(fwd)
  const right = cross(f, up)
  const down = [-up[0], -up[1], -up[2]]
  return new Float64Array([right[0], down[0], f[0], right[1], down[1], f[1], right[2], down[2], f[2]])
}

/** 時刻 t [us] の取り付け姿勢 */
export function mountAt(m: MountTrack, t: number): Mat3 {
  return qToMat(mountQAt(m, t))
}
export function mountQAt(m: MountTrack, t: number): Quat {
  const n = m.q.length / 4
  const x = Math.max(0, Math.min(n - 1, (t - m.t0) / m.dt))
  const k = Math.min(n - 2, Math.floor(x))
  if (n < 2) return Array.from(m.q.subarray(0, 4)) as Quat
  return qSlerp(m.q.subarray(k * 4, k * 4 + 4), m.q.subarray(k * 4 + 4, k * 4 + 8), x - k)
}
/** 時刻 t [us] の前方（リグ座標） */
export function mountFwdAt(m: MountTrack, t: number): V3 {
  const R = mountAt(m, t)
  return [R[2], R[5], R[8]]
}
/** 時刻 t [us] の上（リグ座標） */
export function mountUpAt(m: MountTrack, t: number): V3 {
  const R = mountAt(m, t)
  return [-R[1], -R[4], -R[7]]
}

/** 1 つの姿勢の MountTrack */
export function fixedMount(R: Mat3, t0 = 0): MountTrack {
  return { t0, dt: 1e6, q: new Float64Array(matToQ(R)), fixed: true, by: 'lens', maxDeg: 0 }
}

/** IMU から取り付け姿勢の時間変化を求める */
export function estimateMountTrack(imu: Imu, M: Mat3 = IMU_TO_RIG): MountTrack {
  const whole = estimateMount(imu, M)
  const n = imu.ts.length
  const rate = (n - 1) / ((imu.ts[n - 1] - imu.ts[0]) / 1e6)
  // 10Hz にまとめた加速度・ジャイロ（リグ座標）
  const B = Math.max(1, Math.round(rate / 10))
  const m = Math.floor(n / B)
  const ts = new Float64Array(m)
  const acc = new Float64Array(m * 3)
  const gyr = new Float64Array(m * 3)
  for (let b = 0; b < m; b++) {
    let t = 0
    for (let i = b * B; i < (b + 1) * B; i++) {
      t += imu.ts[i]
      for (let r = 0; r < 3; r++) {
        acc[b * 3 + r] += M[r * 3] * imu.acc[i * 3] + M[r * 3 + 1] * imu.acc[i * 3 + 1] + M[r * 3 + 2] * imu.acc[i * 3 + 2]
        gyr[b * 3 + r] += M[r * 3] * imu.gyro[i * 3] + M[r * 3 + 1] * imu.gyro[i * 3 + 1] + M[r * 3 + 2] * imu.gyro[i * 3 + 2]
      }
    }
    ts[b] = t / B
    for (let r = 0; r < 3; r++) {
      acc[b * 3 + r] /= B
      gyr[b * 3 + r] /= B
    }
  }
  const dur = (ts[m - 1] - ts[0]) / 1e6
  const K = Math.max(2, Math.floor(dur / STEP) + 1)
  const tOut = (k: number): number => ts[0] + k * STEP * 1e6
  const dtb = (ts[m - 1] - ts[0]) / (m - 1)
  const idx = (t: number): number => Math.max(0, Math.min(m - 1, Math.round((t - ts[0]) / dtb)))
  // 走っているか: 2 秒間のジャイロの大きさの二乗平均（止まっている間は姿勢がほとんど変わらない）。
  // 止まっている間（出発前・休憩・サイドスタンド）は、上も前後も決まらないので使わない
  const moving = new Uint8Array(m)
  {
    const e = new Float64Array(m + 1)
    for (let b = 0; b < m; b++) e[b + 1] = e[b] + gyr[b * 3] ** 2 + gyr[b * 3 + 1] ** 2 + gyr[b * 3 + 2] ** 2
    for (let b = 0; b < m; b++) {
      const lo = Math.max(0, b - 10)
      const hi = Math.min(m, b + 11)
      moving[b] = Math.sqrt((e[hi] - e[lo]) / (hi - lo)) > MOVING_DPS ? 1 : 0
    }
  }
  // 0.5 秒平均したジャイロ（走っている間だけ）
  const H = 5
  const g5: V3[] = []
  const t5: number[] = []
  for (let b = 0; b + H <= m; b += H) {
    let mv = 0
    const s: V3 = [0, 0, 0]
    for (let j = b; j < b + H; j++) {
      mv += moving[j]
      for (let r = 0; r < 3; r++) s[r] += gyr[j * 3 + r] / H
    }
    if (mv < H) continue
    g5.push(s)
    t5.push(ts[b + (H >> 1)])
  }
  // 時刻ごとの推定と、その確からしさ（上 = 走っていた時間、前後 = 倒れる回転が他の回転よりどれだけ大きいか）
  // 1 秒平均した加速度
  const acc1 = new Float64Array(m * 3)
  {
    const cs = new Float64Array((m + 1) * 3)
    for (let b = 0; b < m; b++) for (let r = 0; r < 3; r++) cs[(b + 1) * 3 + r] = cs[b * 3 + r] + acc[b * 3 + r]
    for (let b = 0; b < m; b++) {
      const lo = Math.max(0, b - 5)
      const hi = Math.min(m, b + 6)
      for (let r = 0; r < 3; r++) acc1[b * 3 + r] = (cs[hi * 3 + r] - cs[lo * 3 + r]) / (hi - lo)
    }
  }
  const ups: V3[] = []
  const upW: number[] = []
  const fwds: V3[] = []
  const fW: number[] = []
  for (let k = 0; k < K; k++) {
    const tc = tOut(k)
    const a0 = idx(tc - 3 * UP_SIGMA * 1e6)
    const a1 = idx(tc + 3 * UP_SIGMA * 1e6)
    const u: V3 = [0, 0, 0]
    let wu = 0
    for (let b = a0; b <= a1; b++) {
      if (!moving[b]) continue
      const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / UP_SIGMA) ** 2)
      wu += w
      for (let r = 0; r < 3; r++) u[r] += w * acc[b * 3 + r]
    }
    ups.push(wu > 0 ? unit(u) : ([-whole.R[1], -whole.R[4], -whole.R[7]] as V3))
    upW.push(wu)
  }
  // 倒れ込みとヨーの関係: 10Hz の各点で、上（その時刻の推定）まわりのヨー角速度と、上に垂直な回転の積分（傾き。
  // 10 秒の移動平均を引いてドリフトを除く）。曲がる間は進行方向の軸まわりに曲がる側へ傾くので、
  // ヨー角速度を傾きで回帰した係数の向き（の逆）が前方になる。台の揺れ（前後に振れるなど）は曲がり方と関係しないので効かない
  const kOf = (b: number): number => Math.max(0, Math.min(K - 1, Math.round((ts[b] - ts[0]) / 1e6 / STEP)))
  const tilt = new Float64Array(m * 3)
  const yawR = new Float64Array(m)
  {
    const ang: V3 = [0, 0, 0]
    const raw = new Float64Array(m * 3)
    for (let b = 0; b < m; b++) {
      const up = ups[kOf(b)]
      const g = gyr.subarray(b * 3, b * 3 + 3)
      const kk = dot(g, up)
      yawR[b] = kk
      for (let r = 0; r < 3; r++) {
        ang[r] += (g[r] - kk * up[r]) / 10
        raw[b * 3 + r] = ang[r]
      }
    }
    const cs = new Float64Array((m + 1) * 3)
    for (let b = 0; b < m; b++) for (let r = 0; r < 3; r++) cs[(b + 1) * 3 + r] = cs[b * 3 + r] + raw[b * 3 + r]
    for (let b = 0; b < m; b++) {
      const lo = Math.max(0, b - 50)
      const hi = Math.min(m, b + 51)
      for (let r = 0; r < 3; r++) tilt[b * 3 + r] = raw[b * 3 + r] - (cs[hi * 3 + r] - cs[lo * 3 + r]) / (hi - lo)
    }
  }
  const fwdsC: V3[] = []
  const qC: number[] = []
  let j5 = 0
  for (let k = 0; k < K; k++) {
    const tc = tOut(k)
    const up = ups[k]
    const C = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]
    while (j5 < t5.length && t5[j5] < tc - 3 * FWD_SIGMA * 1e6) j5++
    for (let j = j5; j < t5.length && t5[j] <= tc + 3 * FWD_SIGMA * 1e6; j++) {
      const w = Math.exp(-0.5 * ((t5[j] - tc) / 1e6 / FWD_SIGMA) ** 2)
      const g = g5[j]
      const kk = dot(g, up)
      const p = [g[0] - kk * up[0], g[1] - kk * up[1], g[2] - kk * up[2]]
      for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) C[a][c] += w * p[a] * p[c]
    }
    const e = eigSym3(C)
    let f = e.vectors[2]
    let kk = dot(f, up)
    f = unit([f[0] - kk * up[0], f[1] - kk * up[1], f[2] - kk * up[2]])
    // 加減速: 上に垂直な加速度（1 秒平均）の、窓の平均からのばらつきの主成分。バイクはリーン中も横向きの力がほとんど
    // 出ないので、水平な加速度は前後方向（加速・減速）に出る。曲がりの少ない直線でも前後の軸が分かる
    const D = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]
    const mean: V3 = [0, 0, 0]
    let wsum = 0
    const lo = idx(tc - 3 * FWD_SIGMA * 1e6)
    const hi = idx(tc + 3 * FWD_SIGMA * 1e6)
    for (let pass = 0; pass < 2; pass++) {
      for (let b = lo; b <= hi; b++) {
        if (!moving[b]) continue
        const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / FWD_SIGMA) ** 2)
        // その時刻の上で重力を除く（カメラが回っていると、窓の端では上がずれているため）
        const a = acc1.subarray(b * 3, b * 3 + 3)
        const ub = ups[kOf(b)]
        const ka = dot(a, ub)
        const h = [a[0] - ka * ub[0] - mean[0], a[1] - ka * ub[1] - mean[1], a[2] - ka * ub[2] - mean[2]]
        if (pass === 0) {
          for (let r = 0; r < 3; r++) mean[r] += w * h[r]
          wsum += w
        } else for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) D[x][y] += w * h[x] * h[y]
      }
      if (pass === 0 && wsum > 0) for (let r = 0; r < 3; r++) mean[r] /= wsum
    }
    const ea = eigSym3(D)
    let fa = ea.vectors[2]
    kk = dot(fa, up)
    fa = unit([fa[0] - kk * up[0], fa[1] - kk * up[1], fa[2] - kk * up[2]])
    // ヨー角速度 ≈ β·傾き（上に垂直な面の 2 次元）の最小二乗。前方 = −β の向き
    {
      const e1 = f as V3
      const e2 = cross(up, e1)
      let s11 = 0
      let s12 = 0
      let s22 = 0
      let c1 = 0
      let c2 = 0
      let syy = 0
      for (let b = lo; b <= hi; b++) {
        if (!moving[b]) continue
        const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / FWD_SIGMA) ** 2)
        const tv = tilt.subarray(b * 3, b * 3 + 3)
        const x1 = dot(tv, e1)
        const x2 = dot(tv, e2)
        const y = yawR[b]
        s11 += w * x1 * x1
        s12 += w * x1 * x2
        s22 += w * x2 * x2
        c1 += w * x1 * y
        c2 += w * x2 * y
        syy += w * y * y
      }
      // 横の傾きがほとんど無いと回帰が不安定になるので、少しだけ抑える（リッジ回帰）
      const ridge = 0.05 * (s11 + s22)
      s11 += ridge
      s22 += ridge
      const det = s11 * s22 - s12 * s12
      if (det > 0 && syy > 0) {
        const b1 = (s22 * c1 - s12 * c2) / det
        const b2 = (s11 * c2 - s12 * c1) / det
        fwdsC.push(unit([-(b1 * e1[0] + b2 * e2[0]), -(b1 * e1[1] + b2 * e2[1]), -(b1 * e1[2] + b2 * e2[2])]))
        qC.push(Math.max(0, (b1 * c1 + b2 * c2) / syy)) // 決定係数
      } else {
        fwdsC.push(e1)
        qC.push(0)
      }
    }
    // 確からしさ: 主成分が 2 番目よりどれだけはっきりしているか（0〜1）
    const qg = e.values[2] > 0 ? (e.values[2] - e.values[1]) / (e.values[2] + e.values[1]) : 0
    // 加減速がほとんど無い（ばらつきが 0.01g 未満）ときは手がかりにしない
    const qa = wsum > 0 && ea.values[2] / wsum > 1e-4 ? (ea.values[2] - ea.values[1]) / (ea.values[2] + ea.values[1]) : 0
    // 2 つを合わせる: 倒れる回転は、はっきりしていれば正確（1〜3°）だが、曲がりの少ない所では外れる。
    // 加減速は直線でも分かるが、坂や振れで数度ずれる。はっきりしている方を重く
    // 倒れる回転の軸が、ヨーとの回帰の軸と大きく食い違うときは、台の揺れ（前後に振れるなど）を拾っているので使わない
    // 加減速の軸がはっきりしていて、倒れる回転の軸と大きく食い違うときも、加減速の方を採る
    // （手元の動画で、加減速の軸のずれは最大 26°、倒れる回転の軸は台の揺れで 60〜90° 外れることがあった）
    const c30 = Math.cos((30 * Math.PI) / 180)
    const cG = fwdsC[k] && qC[k] > 0.1 ? Math.abs(dot(f, fwdsC[k])) : 1
    const offA = qa > 0.5 && Math.abs(dot(f, fa)) < c30
    const wg = cG < c30 || offA ? 0 : Math.max(0, qg - 0.1) ** 2
    const wa = 0.4 * Math.max(0, qa - 0.3) ** 2
    const sa = dot(fa, f) < 0 ? -1 : 1
    const fused = wg + wa > 0 ? unit([wg * f[0] + wa * sa * fa[0], wg * f[1] + wa * sa * fa[1], wg * f[2] + wa * sa * fa[2]]) : (f as V3)
    fwds.push(fused)
    fW.push(wg + wa)
  }
  // 前後の向きをそろえる: 確かな点を順につないで、直前の確かな向きに合わせる
  const wMed = [...fW].sort((x, y) => x - y)[Math.floor(K / 2)]
  let ref: V3 = [whole.R[2], whole.R[5], whole.R[8]]
  for (let k = 0; k < K; k++) {
    if (dot(fwds[k], ref) < 0) fwds[k] = [-fwds[k][0], -fwds[k][1], -fwds[k][2]]
    if (fW[k] >= wMed) ref = fwds[k]
  }
  // 確からしさで重み付けして時間方向にならす（止まっている間や曲がりの少ない所は、前後の確かな推定で埋める）
  const smoothV = (v: V3[], w: number[], sigma: number): V3[] => {
    const out: V3[] = []
    for (let k = 0; k < K; k++) {
      let r = Math.ceil((3 * sigma) / STEP)
      for (;;) {
        const s: V3 = [0, 0, 0]
        let sw = 0
        for (let j = Math.max(0, k - r); j <= Math.min(K - 1, k + r); j++) {
          const g = w[j] * Math.exp(-0.5 * (((j - k) * STEP) / sigma) ** 2)
          sw += g
          for (let c = 0; c < 3; c++) s[c] += g * v[j][c]
        }
        if (sw > 1e-9 || r >= K) {
          out.push(sw > 1e-9 ? unit(s) : v[k])
          break
        }
        r *= 4 // 近くに確かな点が無ければ広げて探す
      }
    }
    return out
  }
  const upS = smoothV(ups, upW, SMOOTH_SIGMA)
  const fS = smoothV(fwds, fW, SMOOTH_SIGMA).map((f, k) => {
    const u = upS[k]
    const kk = dot(f, u)
    return unit([f[0] - kk * u[0], f[1] - kk * u[1], f[2] - kk * u[2]])
  })
  for (let k = 0; k < K; k++) {
    ups[k] = upS[k]
    fwds[k] = fS[k]
  }
  // 走っていた点（変化の大きさを測るのに使う）
  const movingK = upW.map((w) => w > 0)
  // 前と後ろ: 曲がる側へ倒れる関係（時刻ごとの前・上で、リーン角 = 前方まわりの回転の積分、ヨー = 上まわりの角速度）
  const roll = new Float64Array(m)
  const yaw = new Float64Array(m)
  for (let b = 0; b < m; b++) {
    const k = Math.max(0, Math.min(K - 1, Math.round((ts[b] - ts[0]) / 1e6 / STEP)))
    const g = gyr.subarray(b * 3, b * 3 + 3)
    roll[b] = dot(g, fwds[k])
    yaw[b] = dot(g, ups[k])
  }
  const coupling = correlateLeanYaw(roll, yaw, 10)
  const by: 'lean' | 'lens' = Math.abs(coupling) >= FWD_MIN_CORR ? 'lean' : 'lens'
  const wholeF = [whole.R[2], whole.R[5], whole.R[8]]
  let flip = by === 'lean' ? coupling > 0 : false
  if (by === 'lens') {
    // 曲がる関係が弱いときは、全体の推定（同じくレンズの向きで決めたもの）にそろえる
    let s = 0
    for (const f of fwds) s += dot(f, wholeF)
    flip = s < 0
  }
  if (flip) for (let k = 0; k < K; k++) fwds[k] = [-fwds[k][0], -fwds[k][1], -fwds[k][2]]
  // 変化の大きさ: 全体の推定との差の最大
  const wholeUp = [-whole.R[1], -whole.R[4], -whole.R[7]]
  let maxDeg = 0
  for (let k = 0; k < K; k++) {
    if (!movingK[k]) continue
    maxDeg = Math.max(maxDeg, angleDeg(ups[k], wholeUp), angleDeg(fwds[k], dot(fwds[k], wholeF) >= 0 ? wholeF : wholeF.map((v) => -v)))
  }
  const sameDir = by === whole.by || dot(fwds[0], wholeF) > 0
  if (maxDeg < FIXED_DEG && sameDir) return { ...fixedMount(whole.R, ts[0]), by: whole.by, maxDeg }
  if (maxDeg < FIXED_DEG) {
    // 変化は小さいが前後の決め方が違う: 全体の推定の前後を入れ替えたもの
    const f = wholeF.map((v) => (dot(fwds[0], wholeF) >= 0 ? v : -v))
    return { ...fixedMount(mountMat(f, wholeUp), ts[0]), by, maxDeg }
  }
  const q = new Float64Array(K * 4)
  let prev: Quat | null = null
  for (let k = 0; k < K; k++) {
    let qk = matToQ(mountMat(fwds[k], ups[k]))
    // 四元数の符号をそろえる（補間が遠回りしないように）
    if (prev && qk[0] * prev[0] + qk[1] * prev[1] + qk[2] * prev[2] + qk[3] * prev[3] < 0) qk = [-qk[0], -qk[1], -qk[2], -qk[3]]
    q.set(qk, k * 4)
    prev = qk
  }
  return { t0: ts[0], dt: STEP * 1e6, q, fixed: false, by, maxDeg }
}

/** ロール角速度（積分してリーン角に。drift 秒の移動平均を引く）とヨー角速度の相関。サンプルは 10Hz */
function correlateLeanYaw(roll: Float64Array, yaw: Float64Array, hz: number, drift = 10): number {
  const m = roll.length
  const ang = new Float64Array(m)
  for (let i = 1; i < m; i++) ang[i] = ang[i - 1] + roll[i] / hz
  const cs = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) cs[i + 1] = cs[i] + ang[i]
  const W = drift * hz
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - W / 2)
    const b = Math.min(m, i + W / 2)
    const lean = ang[i] - (cs[b] - cs[a]) / (b - a)
    sxy += lean * yaw[i]
    sxx += lean * lean
    syy += yaw[i] * yaw[i]
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
}

/**
 * 車両ログで取り付け姿勢を詰める（ログと映像の同期が取れたあと）。時刻ごとに、
 *   上   = 走っていて（20km/h 以上）リーンしていない（|リーン角| < 3°）間の加速度の平均
 *   前後 = 上に垂直な面で、カメラのジャイロのうち車体のロール角速度（ログ）に最も合う向き。前と後ろも決まる
 * をガウス窓（LOG_SIGMA 秒）で求める。ログの手がかりが少ない時刻（止まっている・直線が続く）は、IMU だけの推定のまま。
 * IMU だけの推定より正確（手元の動画で上 1〜2°、前方 2〜4°）
 */
const LOG_SIGMA = 30
/** ログで詰めたときは推定のばらつきが小さいので、これより変化が小さければ 1 つの姿勢にする [deg] */
const LOG_FIXED_DEG = 9
export function refineMountWithLog(
  base: MountTrack,
  imu: Imu,
  log: { t: Float64Array; speed: Float64Array; lean: Float64Array; rollRate: Float64Array },
  sync: { a: number; b: number; sign: number },
  firstFrameUs: number,
  M: Mat3 = IMU_TO_RIG
): MountTrack {
  const n = imu.ts.length
  const rate = (n - 1) / ((imu.ts[n - 1] - imu.ts[0]) / 1e6)
  const B = Math.max(1, Math.round(rate / 10))
  const m = Math.floor(n / B)
  // 10Hz のカメラの加速度・ジャイロと、その時刻のログ（車速・リーン角・ロール角速度）
  const ts = new Float64Array(m)
  const acc = new Float64Array(m * 3)
  const gyr = new Float64Array(m * 3)
  const sp = new Float64Array(m)
  const ln = new Float64Array(m)
  const rr = new Float64Array(m)
  let j = 0
  for (let b = 0; b < m; b++) {
    let t = 0
    for (let i = b * B; i < (b + 1) * B; i++) {
      t += imu.ts[i]
      for (let r = 0; r < 3; r++) {
        acc[b * 3 + r] += (M[r * 3] * imu.acc[i * 3] + M[r * 3 + 1] * imu.acc[i * 3 + 1] + M[r * 3 + 2] * imu.acc[i * 3 + 2]) / B
        gyr[b * 3 + r] += (M[r * 3] * imu.gyro[i * 3] + M[r * 3 + 1] * imu.gyro[i * 3 + 1] + M[r * 3 + 2] * imu.gyro[i * 3 + 2]) / B
      }
    }
    ts[b] = t / B
    const lt = sync.a * ((ts[b] - firstFrameUs) / 1e6) + sync.b
    while (j + 1 < log.t.length && log.t[j + 1] <= lt) j++
    const ok = lt >= log.t[0] && lt <= log.t[log.t.length - 1]
    sp[b] = ok ? log.speed[j] : NaN
    ln[b] = ok ? log.lean[j] : NaN
    rr[b] = ok ? log.rollRate[j] : NaN
  }
  // 時刻の並び: 元が 1 つの姿勢なら、動画全体を STEP 秒ごとに
  const T0 = base.fixed ? ts[0] : base.t0
  const DT = base.fixed ? STEP * 1e6 : base.dt
  const K = base.fixed ? Math.max(2, Math.floor((ts[m - 1] - ts[0]) / DT) + 1) : base.q.length / 4
  const ups: V3[] = []
  const upW: number[] = []
  const fwds: V3[] = []
  const fW: number[] = []
  const dtb = (ts[m - 1] - ts[0]) / (m - 1)
  const idx = (t: number): number => Math.max(0, Math.min(m - 1, Math.round((t - ts[0]) / dtb)))
  for (let k = 0; k < K; k++) {
    const tc = T0 + k * DT
    const lo = idx(tc - 3 * LOG_SIGMA * 1e6)
    const hi = idx(tc + 3 * LOG_SIGMA * 1e6)
    const u: V3 = [0, 0, 0]
    let wu = 0
    const c: V3 = [0, 0, 0]
    let wr = 0
    for (let b = lo; b <= hi; b++) {
      const w = Math.exp(-0.5 * ((ts[b] - tc) / 1e6 / LOG_SIGMA) ** 2)
      if (sp[b] > 20 && Math.abs(ln[b]) < 3) {
        wu += w
        for (let r = 0; r < 3; r++) u[r] += w * acc[b * 3 + r]
      }
      if (Number.isFinite(rr[b])) {
        // ログのロール角速度とカメラのロール角速度の符号の関係は同期で分かっている（sign）
        const x = sync.sign * rr[b]
        wr += w * x * x
        for (let r = 0; r < 3; r++) c[r] += w * gyr[b * 3 + r] * x
      }
    }
    const baseUp = mountUpAt(base, tc)
    const up = wu > 5 ? unit(u) : baseUp
    ups.push(up)
    upW.push(wu > 5 ? wu : 0)
    const kk = dot(c, up)
    const f = unit([c[0] - kk * up[0], c[1] - kk * up[1], c[2] - kk * up[2]])
    // 回帰の大きさ（ロール角速度 1°/s あたりのカメラの回転）が 1 に近いほど確か
    const gain = wr > 0 ? Math.hypot(c[0] - kk * up[0], c[1] - kk * up[1], c[2] - kk * up[2]) / wr : 0
    const okF = wr > 50 && gain > 0.5
    fwds.push(okF ? f : mountFwdAt(base, tc))
    fW.push(okF ? wr : 0)
  }
  // 確かでない時刻は IMU だけの推定で埋めつつ、時間方向にならす
  const blend = (v: V3[], w: number[], baseAt: (t: number) => V3): V3[] => {
    const out: V3[] = []
    const wMax = Math.max(1e-9, ...w)
    for (let k = 0; k < K; k++) {
      const s: V3 = [0, 0, 0]
      const r = Math.ceil((2 * LOG_SIGMA * 1e6) / DT)
      for (let i = Math.max(0, k - r); i <= Math.min(K - 1, k + r); i++) {
        const g = (w[i] / wMax) * Math.exp(-0.5 * (((i - k) * DT) / 1e6 / LOG_SIGMA) ** 2)
        for (let x = 0; x < 3; x++) s[x] += g * v[i][x]
      }
      // 手がかりの弱い所は IMU だけの推定へ寄せる
      const b0 = baseAt(T0 + k * DT)
      const wb = 0.05
      for (let x = 0; x < 3; x++) s[x] += wb * b0[x]
      out.push(unit(s))
    }
    return out
  }
  const upS = blend(ups, upW, (t) => mountUpAt(base, t))
  const fS = blend(fwds, fW, (t) => mountFwdAt(base, t))
  const q = new Float64Array(K * 4)
  let prev: Quat | null = null
  // 変化の大きさ: ログの手がかりがあった時刻の、平均の向きからの差の最大
  const meanOf = (v: V3[], w: number[]): V3 => {
    const s: V3 = [0, 0, 0]
    for (let k = 0; k < K; k++) for (let x = 0; x < 3; x++) s[x] += (w[k] > 0 ? 1 : 0) * v[k][x]
    return unit(s)
  }
  const f0 = meanOf(fS, fW)
  const u0 = meanOf(upS, upW)
  let maxDeg = 0
  for (let k = 0; k < K; k++) {
    const u = upS[k]
    const kk = dot(fS[k], u)
    const f = unit([fS[k][0] - kk * u[0], fS[k][1] - kk * u[1], fS[k][2] - kk * u[2]])
    if (fW[k] > 0) maxDeg = Math.max(maxDeg, angleDeg(f, f0))
    if (upW[k] > 0) maxDeg = Math.max(maxDeg, angleDeg(u, u0))
    let qk = matToQ(mountMat(f, u))
    if (prev && qk[0] * prev[0] + qk[1] * prev[1] + qk[2] * prev[2] + qk[3] * prev[3] < 0) qk = [-qk[0], -qk[1], -qk[2], -qk[3]]
    q.set(qk, k * 4)
    prev = qk
  }
  if (maxDeg < LOG_FIXED_DEG) {
    // 動画を通してほとんど変わらなければ 1 つの姿勢（時刻ごとの前・上の平均）
    const mu: V3 = [0, 0, 0]
    const mf: V3 = [0, 0, 0]
    for (let k = 0; k < K; k++)
      for (let x = 0; x < 3; x++) {
        mu[x] += upS[k][x]
        mf[x] += fS[k][x]
      }
    const u = unit(mu)
    const kk = dot(mf, u)
    return { ...fixedMount(mountMat(unit([mf[0] - kk * u[0], mf[1] - kk * u[1], mf[2] - kk * u[2]]), u), T0), by: 'log', maxDeg }
  }
  return { t0: T0, dt: DT, q, fixed: false, by: 'log', maxDeg }
}
