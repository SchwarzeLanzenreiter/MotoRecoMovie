// 映像から、車線のどちら側を走っているか（センターラインの左右）を判定する。
// 画角の自動切り替えの「追い越し」（車線をまたいでいる間は路面を映さない視点にする）に使う。
//
//   1. 車体の前方の路面を見下ろした小さな画像（LANE_VIEW）を描く（水平・リーンを戻した向き）
//   2. 各行の画素を路面上の位置（横 L・前方 F [m]）に戻す（カメラの高さ LANE_CAM_HEIGHT の平面との交点）
//   3. 手がかりは 2 つ:
//      ・黄・オレンジのセンターライン: 細い帯（幅 0.45m 以下・色相 12〜48°）で両側が灰色の路面の点に、直線 L = a + b·F を当てはめる
//        （ハフ変換）。a = 車体の真下での線の横の位置。道路脇の草は黄緑で幅も広いので入らない
//      ・路面の広がり: 車体の真下から左右へ、灰色の路面がどこまで続くか。左側通行で自分の車線にいれば右が広い。
//        白いセンターラインは、自分の車線でも反対の車線でも「左右に 1 本ずつ」見えるだけで区別できないので、線ではなく路面の広がりで見る
// 黄色の線があればそれで決め、無ければ路面の広がりの偏りで決める。

/** 路面を見下ろす視点（水平から下へ 35°・水平画角 120° = 透視投影の上限）と画像の大きさ */
export const LANE_VIEW = { pitch: -35, fov: 120, width: 320, height: 180 }
/** カメラの路面からの高さ [m]（おおよそ。横の位置の尺度にだけ効き、左右の判定には効かない） */
export const LANE_CAM_HEIGHT = 1.5

const F_MIN = 2 // 線を探す前方の範囲 [m]
const F_MAX = 10
const F_ROAD_MIN = 4 // 路面の広がりを見る前方の範囲 [m]
const F_ROAD_MAX = 9
const MAX_WIDTH = 0.45 // 線の幅の上限 [m]
const EDGE = 0.25 // 線の両側で路面を確かめる幅 [m]
const ROAD_GAP = 0.6 // 路面でない画素がこれだけ続いたら路面の端 [m]
const ROAD_BIAS = 0.2 // 路面の広がりの偏りがこれ以上なら、その側と判定する
const SINGLE_MIN = 0.6 // 1 回だけ反対側に見えた黄色の線を、車線をまたいだとみなす線との距離 [m]
const SINGLE_MAX = 2
const YELLOW_FAR = 4.5 // これより遠い黄色は、センターラインではない（反対の車線の矢印など）とみなす [m]
const ROAD_CONTRADICT = 0.25 // 路面の広がりがこれ以上自分の車線側に偏っていれば、反対側に見えた黄色を使わない
const ROAD_RUN_BIAS = 0.3 // 路面の広がりだけで決めた区間で、偏りがこれ以上反対側に寄ったら車線をまたいだとみなす
const RUN_MIN_A = 1.1 // 黄色の線だけで決めた区間で、線が車体からこれ以上離れたら車線をまたいだとみなす [m]

export interface LaneLine {
  /** 車体の真下での横の位置 [m]（右が正） */
  a: number
  /** 前方 1m あたりの横の変化 */
  b: number
  /** 当てはまった点の数 */
  votes: number
}

export interface LaneObservation {
  yellow: LaneLine | null
  /** 路面の左右の広がり [m]（中央値）と、端が見えた行の割合 */
  road: { left: number; right: number; leftSeen: number; rightSeen: number } | null
}

/** 見下ろした画像（RGBA、上の行から）から、黄色の線と路面の広がりを求める */
export function observeLanes(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, camHeight = LANE_CAM_HEIGHT): LaneObservation {
  const pitch = (-LANE_VIEW.pitch * Math.PI) / 180
  const f = w / 2 / Math.tan((LANE_VIEW.fov * Math.PI) / 360)
  const cs = Math.cos(pitch)
  const sn = Math.sin(pitch)
  const cx = w / 2 - 0.5
  const pts: number[] = [] // 黄色の線の点（F, L の組）
  const hue = new Float32Array(w)
  const sat = new Float32Array(w)
  const val = new Float32Array(w)
  const road = new Uint8Array(w)
  const lefts: number[] = []
  const rights: number[] = []
  let leftSeen = 0
  let rightSeen = 0
  let rows = 0
  for (let yy = 0; yy < h; yy++) {
    const y = yy - (h / 2 - 0.5)
    const ly = y * cs + f * sn
    if (ly <= 0) continue
    const t = camHeight / ly // 1 画素あたりの横の長さ [m]
    const F = t * (-y * sn + f * cs)
    if (F < F_MIN || F > F_MAX) continue
    let nRoad = 0
    for (let x = 0; x < w; x++) {
      const o = (yy * w + x) * 4
      const r = rgba[o] / 255
      const g = rgba[o + 1] / 255
      const b = rgba[o + 2] / 255
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const d = Math.max(mx - mn, 1e-6)
      val[x] = mx
      sat[x] = mx > 0 ? (mx - mn) / mx : 0
      hue[x] = (mx === r ? (((g - b) / d) % 6 + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
      road[x] = sat[x] < 0.12 && mx > 0.12 ? 1 : 0
      nRoad += road[x]
    }
    const cand = (x: number): boolean => hue[x] >= 12 && hue[x] <= 48 && sat[x] >= 0.14 && val[x] >= 0.5
    // 路面の広がりでは、黄色の線（二重線は幅 0.5m ほど）や縁のにじんだ画素も路面として数える
    const roadish = (x: number): boolean => road[x] === 1 || sat[x] < 0.2 || cand(x)
    // 路面の広がり: 真下から左右へ、路面でない画素が ROAD_GAP 続くところまで（細い線は飛び越える）
    if (F >= F_ROAD_MIN && F <= F_ROAD_MAX) {
      const gap = Math.max(1, Math.round(ROAD_GAP / t))
      for (const dir of [-1, 1]) {
        let x = Math.round(cx)
        let miss = 0
        let last = x
        let seen = false
        for (; x >= 0 && x < w; x += dir) {
          if (roadish(x)) {
            miss = 0
            last = x
          } else if (++miss >= gap) {
            seen = true
            break
          }
        }
        const ext = Math.abs(last - cx) * t
        if (dir < 0) {
          lefts.push(ext)
          if (seen) leftSeen++
        } else {
          rights.push(ext)
          if (seen) rightSeen++
        }
      }
    }
    // 黄色の線の候補
    if (nRoad < w * 0.3) continue
    rows++
    const e = Math.max(1, Math.round(EDGE / t))
    let x = 0
    while (x < w) {
      if (!cand(x)) {
        x++
        continue
      }
      const x0 = x
      while (x < w && cand(x)) x++
      const x1 = x
      // 両側が路面か（線の縁のにじんだ 1 画素は飛ばす）
      if ((x1 - x0) * t > MAX_WIDTH || x0 - e - 1 < 0 || x1 + e + 1 > w) continue
      let l = 0
      let r = 0
      for (let k = x0 - e - 1; k < x0 - 1; k++) l += sat[k] < 0.18 ? 1 : 0
      for (let k = x1 + 1; k < x1 + e + 1; k++) r += sat[k] < 0.18 ? 1 : 0
      if (l < 0.6 * e || r < 0.6 * e) continue
      pts.push(F, t * ((x0 + x1 - 1) / 2 - cx))
    }
  }
  const yl = houghLine(pts)
  const median = (a: number[]): number => [...a].sort((p, q) => p - q)[a.length >> 1]
  return {
    yellow: yl && yl.votes >= Math.max(8, rows * 0.25) ? yl : null,
    road: lefts.length ? { left: median(lefts), right: median(rights), leftSeen: leftSeen / lefts.length, rightSeen: rightSeen / rights.length } : null
  }
}

/** 点 (F, L) の組に直線 L = a + b·F を当てはめる（ハフ変換）。いちばん票の多い直線 */
function houghLine(pts: number[]): LaneLine | null {
  const A0 = -7
  const DA = 0.15
  const NA = Math.round(14 / DA) + 1
  const B = 0.7
  const DB = 0.025
  const NB = Math.round((2 * B) / DB) + 1
  const acc = new Int32Array(NA * NB)
  for (let p = 0; p < pts.length; p += 2) {
    const F = pts[p]
    const L = pts[p + 1]
    for (let j = 0; j < NB; j++) {
      const ia = Math.round((L - (-B + j * DB) * F - A0) / DA)
      if (ia >= 0 && ia < NA) acc[ia * NB + j]++
    }
  }
  let best = 0
  for (let k = 1; k < acc.length; k++) if (acc[k] > acc[best]) best = k
  if (acc[best] < 3) return null
  return { a: A0 + Math.floor(best / NB) * DA, b: -B + (best % NB) * DB, votes: acc[best] }
}

export interface LaneSample {
  /** 動画時刻 [s] */
  t: number
  /** センターラインの側（右 = +1、左 = -1、分からない = 0）。左側通行なら +1 が自分の車線 */
  side: -1 | 0 | 1
  /** 黄色の線から決めたか（路面の広がりからの推定より確か） */
  yellow: boolean
  /** 確認用: 黄色の線の真下での位置 [m]・路面の広がりの偏り（右が広いと正） */
  a?: number
  bias?: number
}

/** 1 枚の観測から、センターラインの側を決める */
export function laneSide(o: LaneObservation): { side: -1 | 0 | 1; yellow: boolean; a?: number; bias?: number } {
  const r = o.road
  const bias = r ? (r.right - r.left) / Math.max(r.right + r.left, 1e-6) : undefined
  if (o.yellow) return { side: o.yellow.a >= 0 ? 1 : -1, yellow: true, a: o.yellow.a, bias }
  // 路面の広がり: 少なくとも片側の端が見えていて、偏りがはっきりしているとき
  if (!r || bias === undefined || (r.leftSeen < 0.5 && r.rightSeen < 0.5)) return { side: 0, yellow: false, bias }
  return { side: bias >= ROAD_BIAS ? 1 : bias <= -ROAD_BIAS ? -1 : 0, yellow: false, bias }
}

/**
 * 自分の車線でのセンターラインの側（左側通行 = +1、右側通行 = -1）。観測の多い方。黄色の線の観測が十分あればそれで決める。
 * 観測が少なすぎれば 0
 */
export function ownSide(samples: LaneSample[]): -1 | 0 | 1 {
  let pos = 0
  let neg = 0
  let yp = 0
  let yn = 0
  for (const s of samples) {
    if (s.side > 0) pos++
    else if (s.side < 0) neg++
    if (s.yellow) s.side > 0 ? yp++ : yn++
  }
  if (pos + neg < 5) return 0
  return yp + yn >= 10 ? (yp >= yn ? 1 : -1) : pos >= neg ? 1 : -1
}

export interface LaneCrossing {
  /** 自分の車線にいた最後の時刻 [s]（この後、次の観測までの間に車線をまたぎ始める） */
  start: number
  /** 自分の車線に戻ったのを確かめた時刻 [s] */
  end: number
}

/**
 * 観測の並びから、センターラインをまたいで反対の車線にいた区間を探す。
 * 自分の側（左側通行なら右にセンターライン）は、観測の多い方とする（左側通行・右側通行のどちらでも使える）。
 * 路面の広がりからの推定は誤りやすいので、反対側の判定は前後どちらかも反対側のときだけ使う
 */
export function findLaneCrossings(samples: LaneSample[], maxDur = 30): LaneCrossing[] {
  const own = ownSide(samples)
  if (!own) return []
  const st = samples.map((s, i) => {
    if (s.side === 0) return 0
    if (s.side === own) return s.side
    if (s.yellow) {
      const a = Math.abs(s.a ?? 0)
      // 遠すぎる黄色（反対の車線の矢印などの表示）や、路面の広がりがはっきり自分の車線を示すときは使わない
      if (a > YELLOW_FAR || (s.bias ?? 0) * own >= ROAD_CONTRADICT) return 0
      // 前後に黄色の線が無く 1 回だけ現れたもの（ほかの黄色い物）も使わない
      const tracked = [samples[i - 1], samples[i + 1]].some((x) => x && x.yellow)
      return tracked ? s.side : 0
    }
    const nb = [samples[i - 1], samples[i + 1]].some((x) => x && x.side === s.side)
    return nb ? s.side : 0
  })
  const out: LaneCrossing[] = []
  let lastOwn = -1
  for (let i = 0; i < samples.length; i++) {
    if (st[i] !== -own) {
      if (st[i] === own) lastOwn = i
      continue
    }
    // 反対の車線の区間: 次に自分の側と判定されるまで
    let k = i + 1
    let n = 1
    while (k < samples.length && st[k] !== own) {
      if (st[k] === -own) n++
      k++
    }
    // 1 回だけの反対側は、線が車体の真下（線の上を通っただけ）や遠く（ほかの黄色い表示）なら使わない
    const a = Math.abs(samples[i].a ?? NaN)
    const single = n === 1 && !(samples[i].yellow && a >= SINGLE_MIN && a <= SINGLE_MAX)
    // 黄色の線だけで決めた区間は、線が車体から十分離れたか、路面の広がりも反対側を示すときだけ
    let maxA = 0
    let minBias = Infinity
    let yellowOnly = true
    let anyYellow = false
    for (let q = i; q < k; q++) {
      if (st[q] !== -own) continue
      if (!samples[q].yellow) yellowOnly = false
      else anyYellow = true
      maxA = Math.max(maxA, Math.abs(samples[q].a ?? 0))
      minBias = Math.min(minBias, (samples[q].bias ?? 0) * own)
    }
    // 路面の広がりだけで決めた区間は、偏りがはっきりしているときだけ（道路脇の駐車場などの舗装で左右の広さが変わることがある）
    const weak = (yellowOnly && maxA < RUN_MIN_A && minBias > -0.1) || (!anyYellow && minBias > -ROAD_RUN_BIAS)
    if (!single && !weak && lastOwn >= 0 && k < samples.length && samples[k].t - samples[lastOwn].t <= maxDur) out.push({ start: samples[lastOwn].t, end: samples[k].t })
    i = k - 1
  }
  return out
}
