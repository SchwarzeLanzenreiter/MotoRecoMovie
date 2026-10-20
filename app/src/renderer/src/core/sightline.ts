// 空中の標識が今いる場所から見えるか（見通し）の判定。
//
// 地形のデータは持っていないので、走ってきた・これから走る道路（融合した位置と標高）だけで判断する:
//   1. 視線の通り道: 自分から標識への視線（地図の上の線分）が、その間の道路から大きく離れていれば、
//      視線は道路の外（峠なら山の斜面や森）を横切っている → 見えないとする（くねくねした峠で、山の向こうの標識が見えてしまうのを防ぐ）
//   2. 峠の頂上: 視線の下にある道路が視線より高ければ、道路の盛り上がりに隠れている → 見えないとする
// どちらも急に消えたり出たりしないよう、はみ出しの量に応じて 0〜1 で薄くする。
import type { Telemetry } from './telemetry'

/** 道路の点列（ROAD_STEP m ごと） */
export interface RoadTrack {
  t: Float64Array // 動画時刻 [s]
  x: Float64Array // 東 [m]
  y: Float64Array // 北 [m]
  alt: Float64Array // 標高 [m]（路面のおおよその高さ）
}

const ROAD_STEP = 2

export const SIGHT = {
  /** 視線が道路からこれだけ離れるまでは見える [m] */
  corridorNear: 10,
  /** これだけ離れると見えない [m]（その間は薄くする） */
  corridorFar: 25,
  /** 視線の下の道路が視線よりこれだけ高くなるまでは見える [m]（GPS の標高の誤差を見込む） */
  crestNear: 2,
  crestFar: 6,
  /** 視線の点の間隔 [m] */
  step: 5
}

/** 融合した位置（nav）と標高から、道路の点列を作る */
export function roadTrack(tel: Telemetry): RoadTrack | null {
  const nav = tel.nav
  if (!nav) return null
  const alt = tel.channels.alt
  const t: number[] = []
  const x: number[] = []
  const y: number[] = []
  const a: number[] = []
  let px = NaN
  let py = NaN
  for (let i = 0; i < tel.n; i++) {
    const nx = nav.x[i]
    const ny = nav.y[i]
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue
    if (t.length && Math.hypot(nx - px, ny - py) < ROAD_STEP && i < tel.n - 1) continue
    t.push(i / tel.rate)
    x.push(nx)
    y.push(ny)
    a.push(alt && Number.isFinite(alt[i]) ? alt[i] : NaN)
    px = nx
    py = ny
  }
  if (t.length < 2) return null
  return { t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), alt: Float64Array.from(a) }
}

/** 時刻 t 以下で最も新しい点の番号 */
function indexAt(road: RoadTrack, t: number): number {
  let lo = 0
  let hi = road.t.length - 1
  if (t <= road.t[0]) return 0
  if (t >= road.t[hi]) return hi
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (road.t[m] <= t) lo = m
    else hi = m
  }
  return lo
}

/**
 * 時刻 tNow の位置 eye（目の高さ）から、時刻 tSign に通る地点に立つ標識 target（見たい部分の高さ）が見えるか。
 * 1 = 見える、0 = 見えない（その間は薄く）
 */
export function sightVisibility(
  road: RoadTrack,
  tNow: number,
  tSign: number,
  eye: { x: number; y: number; h: number },
  target: { x: number; y: number; h: number }
): number {
  const dx = target.x - eye.x
  const dy = target.y - eye.y
  const L2 = dx * dx + dy * dy
  const L = Math.sqrt(L2)
  if (L < SIGHT.corridorNear * 1.5) return 1
  const i0 = indexAt(road, tNow)
  // 標識の少し先までの道路（標識は進入地点の手前に立つ。コーナーの中の道路も視線の近くにある）
  const i1 = Math.min(road.t.length - 1, indexAt(road, tSign) + Math.ceil(30 / ROAD_STEP))
  if (i1 - i0 < 2) return 1
  // 1. 視線の通り道: 視線の各点から、最も近い道路の点までの距離の最大
  let worst = 0
  const m = Math.max(2, Math.ceil(L / SIGHT.step))
  for (let k = 1; k < m; k++) {
    const u = k / m
    const px = eye.x + dx * u
    const py = eye.y + dy * u
    let best = Infinity
    for (let j = i0; j <= i1; j++) {
      const ex = road.x[j] - px
      const ey = road.y[j] - py
      const d2 = ex * ex + ey * ey
      if (d2 < best) best = d2
    }
    worst = Math.max(worst, Math.sqrt(best))
  }
  const aCorridor = clamp01((SIGHT.corridorFar - worst) / (SIGHT.corridorFar - SIGHT.corridorNear))
  if (aCorridor === 0) return 0
  // 2. 峠の頂上: 視線の真下付近の道路が、視線より高いか
  let excess = -Infinity
  for (let j = i0; j <= i1; j++) {
    const al = road.alt[j]
    if (!Number.isFinite(al)) continue
    const ex = road.x[j] - eye.x
    const ey = road.y[j] - eye.y
    const u = (ex * dx + ey * dy) / L2
    if (u < 0.05 || u > 0.95) continue
    const lat = Math.abs(ex * dy - ey * dx) / L
    if (lat > SIGHT.corridorNear) continue
    excess = Math.max(excess, al - (eye.h + (target.h - eye.h) * u))
  }
  const aCrest = clamp01((SIGHT.crestFar - excess) / (SIGHT.crestFar - SIGHT.crestNear))
  return aCorridor * aCrest
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
