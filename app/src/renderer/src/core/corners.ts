// これから進入するコーナーの検出と、曲線半径の推定（空中に浮かぶ標識の内容と位置）。
//
// コーナー = 走行状態のコーナリング区間（リーン角 > 15°）。曲線半径は
//   R = 速度 ÷ 鉛直軸まわりの旋回の角速度（ジャイロ）
// を、旋回がいちばん強い部分（最大の 8 割以上）の中央値で求める。
// 検証用に、GPS の軌跡の曲率からの推定と、R = v² / (g·tan L) の推定も持つ（test/corners.test.ts で比べる）。
import type { NavTrack } from './nav'
import type { RidingTrack } from './riding'
import type { Telemetry } from './telemetry'

export interface Corner {
  /** 進入の時刻 [s]（コーナリング区間の開始） */
  start: number
  end: number
  /** 旋回がいちばん強い時刻 [s] */
  apex: number
  /** 右 = +1、左 = -1 */
  dir: 1 | -1
  /** 曲線半径 [m]（5m 単位に丸めたもの） */
  radius: number
  /** 検証用: GPS の軌跡の曲率から / リーン角から（丸める前） */
  radiusGps: number
  radiusLean: number
  /**
   * 進入地点の前後の走行経路（PATH_STEP m ごと）。s = 進入地点からの経路に沿った距離 [m]（手前が負）。
   * 標識をどこに置くか（signPlace）に使う
   */
  path: { s: number[]; x: number[]; y: number[]; alt: number[]; heading: number[]; t: number[] }
  /** 進入地点（融合した位置, m）。残り距離の表示に使う */
  ex: number
  ey: number
}

const G = 9.80665

/** 経路を持っておく範囲（進入地点の手前・先 [m]）と間隔 */
export const PATH_BEFORE = 120
export const PATH_AFTER = 60
const PATH_STEP = 2

/** 標識を置く地点: 進入地点から経路に沿って ahead m 先（負なら手前）。経路の範囲外なら端 */
export function signPlace(c: Corner, ahead: number): { x: number; y: number; alt: number; heading: number; t: number } | null {
  const p = c.path
  const n = p.s.length
  if (!n) return null
  if (n === 1) return { x: p.x[0], y: p.y[0], alt: p.alt[0], heading: p.heading[0], t: p.t[0] }
  let k = 0
  while (k < n - 2 && p.s[k + 1] < ahead) k++
  const f = Math.max(0, Math.min(1, (ahead - p.s[k]) / (p.s[k + 1] - p.s[k] || 1)))
  const lerp = (a: number[]): number => a[k] + (a[k + 1] - a[k]) * f
  const dh = ((((p.heading[k + 1] - p.heading[k]) % 360) + 540) % 360) - 180
  return { x: lerp(p.x), y: lerp(p.y), alt: lerp(p.alt), heading: p.heading[k] + dh * f, t: lerp(p.t) }
}

function median(a: number[]): number {
  if (!a.length) return NaN
  const s = [...a].sort((p, q) => p - q)
  return s[s.length >> 1]
}

export function detectCorners(tel: Telemetry, nav: NavTrack, riding: RidingTrack, minRadius = 10, maxRadius = 600): Corner[] {
  const ch = tel.channels
  const rate = tel.rate
  const out: Corner[] = []
  if (!ch.speed) return out
  // 走行経路に沿った距離 [m]（前輪速の積分）。標識を進入地点の前後に置くのに使う
  const along = new Float64Array(tel.n)
  for (let i = 1; i < tel.n; i++) along[i] = along[i - 1] + (Number.isNaN(ch.speed[i]) ? 0 : ch.speed[i] / 3.6 / rate)
  const d2r = Math.PI / 180
  for (const sg of riding.segments) {
    if (sg.state !== 'corner') continue
    const a = Math.max(1, Math.round(sg.start * rate))
    const b = Math.min(tel.n - 2, Math.round(sg.end * rate))
    if (b - a < rate * 0.8) continue
    // 旋回の角速度の最大と、その 8 割以上の区間
    let wMax = 0
    let iMax = a
    for (let i = a; i <= b; i++) {
      const w = Math.abs(nav.turnRate[i])
      if (w > wMax) {
        wMax = w
        iMax = i
      }
    }
    if (wMax < 2) continue
    const rW: number[] = []
    const rL: number[] = []
    const rG: number[] = []
    let dirSum = 0
    for (let i = a; i <= b; i++) {
      const w = nav.turnRate[i]
      dirSum += w
      if (Math.abs(w) < 0.8 * wMax) continue
      const v = ch.speed[i] / 3.6
      if (!(v > 3)) continue
      rW.push(v / (Math.abs(w) * d2r))
      const L = ch.lean ? Math.abs(ch.lean[i]) : 0
      if (L > 3) rL.push((v * v) / (G * Math.tan(L * d2r)))
      // GPS の軌跡の曲率: 方位（GPS）の変化率から
      const h0 = ch.heading?.[i - 1]
      const h1 = ch.heading?.[i + 1]
      if (h0 !== undefined && h1 !== undefined && !Number.isNaN(h0) && !Number.isNaN(h1)) {
        const dh = Math.abs(((((h1 - h0) % 360) + 540) % 360) - 180) * (rate / 2)
        if (dh > 1) rG.push(v / (dh * d2r))
      }
    }
    const R = median(rW)
    if (!(R >= minRadius && R <= maxRadius)) continue
    // 進入地点の前後の経路（PATH_STEP m ごと）
    let k0 = a
    while (k0 > 0 && along[a] - along[k0] < PATH_BEFORE) k0--
    const path: Corner['path'] = { s: [], x: [], y: [], alt: [], heading: [], t: [] }
    let next = -Infinity
    for (let k = k0; k < tel.n && along[k] - along[a] <= PATH_AFTER; k++) {
      const s = along[k] - along[a]
      if (s < next) continue
      next = s + PATH_STEP
      path.s.push(s)
      path.x.push(nav.x[k])
      path.y.push(nav.y[k])
      path.alt.push(ch.alt && !Number.isNaN(ch.alt[k]) ? ch.alt[k] : 0)
      path.heading.push(nav.heading[k])
      path.t.push(k / rate)
    }
    out.push({
      start: sg.start,
      end: sg.end,
      apex: iMax / rate,
      dir: dirSum >= 0 ? 1 : -1,
      radius: Math.round(R / 5) * 5,
      radiusGps: median(rG),
      radiusLean: median(rL),
      path,
      ex: nav.x[a],
      ey: nav.y[a]
    })
  }
  return out
}
