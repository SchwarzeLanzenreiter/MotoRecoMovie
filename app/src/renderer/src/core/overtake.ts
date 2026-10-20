// 追い越しの判定: 車線をまたいだ区間（core/lanes.ts）のうち、その間に追い越す側の真横を車が通ったもの（core/vehicles.ts）。
//
//   ・左側通行（センターラインが右 = 自分の車線）では右の車線へ出て追い越すので、追い越される車は左の真横を通る。
//     右側通行ではその逆。対向車は反対側を通るので数えない
//   ・自分のバイクの車体（後ろ向きの画像に映る）は除く: 画像の下の縁で切れるほど近いもの、後ろ半分のオートバイ、
//     近すぎて大きく見えるもの、同じ向きに何度も見えるもの
//   ・止まっている車を、センターラインをまたいで避けた場合も追い越しとみなす
import type { LaneCrossing } from './lanes'
import type { VehicleSighting } from './vehicles'

/** COCO のオートバイのクラス */
const MOTORCYCLE = 3

/**
 * 判定の版。判定の方法を変えたら上げる（プロジェクトに残した結果が古い版なら、次の自動生成のときに調べ直す）。
 * 2: 路面の広がりだけで決める区間に、はっきりした偏りを求めるようにした（道路脇の駐車場の舗装で誤っていた）
 */
export const OVERTAKE_SCAN_VERSION = 2

export interface Overtake {
  /** 自分の車線にいた最後の時刻 [s]（この後、車線をまたぎ始める） */
  start: number
  /** 自分の車線に戻ったのを確かめた時刻 [s] */
  end: number
}

export const OVERTAKE = {
  /** 真横とみなす方位の範囲 [deg]（追い越す側。斜め前は追い越す前の車も入るので除く） */
  sideMin: 60,
  sideMax: 150,
  /**
   * これより大きく見えるものは自分の車体とみなす [deg]（見かけの高さ）。
   * 真横 2〜3m を通る車は 35° ほど。自分のバイクの一部は 0.5〜1m の近さで 40〜90° に映る
   */
  maxSize: 42,
  /**
   * 後ろ半分（方位がこれより後ろ）に見えるオートバイは自分のバイクとみなす [deg]。
   * 自分のバイクは一部だけ映ると小さく見え、毎回は検出されないので、大きさや見える回数では除ききれない
   */
  ownBikeAz: 100,
  /**
   * 枠の下端がこれより下（画像の下の縁 45° で切れている）のものは、すぐ近くの自分の車体とみなす [deg]。
   * 自分のバイクの一部は乗用車と判定されることもあるので、クラスでは除ききれない。真横 2〜3m を通る車の下端は 10〜20°
   */
  maxLow: 40,
  /** 下の縁で切れた検出が 2 回以上出た向き（自分の車体の向き、ownBin° ごと）では、下端がこれ以上のものも除く [deg] */
  ownBin: 10,
  ownLow: 25,
  /** 車線をまたいだ区間の前後に、車を探す余裕 [s] */
  margin: 1,
  minScore: 0.5,
  /**
   * 同じ向きに何度も見える物は自分の車体とみなす: 調べた時刻のこの割合以上（かつ staticMin 回以上）。方位のまとめ幅 [deg]。
   * 大きく映るもの（見かけの高さの中央値が staticBigSize° 以上）は、この割合が staticShareBig でも自分の車体とみなす
   * （追い越す車は 1 回の追い越しで 1〜2 回しか真横に映らない）
   */
  staticShare: 0.4,
  staticShareBig: 0.12,
  staticBigSize: 25,
  staticMin: 4,
  staticBin: 15
}

/** 調べた時刻の数に対して、同じ向きにいつも見えるもの（自分の車体）の方位のビン */
function staticBins(sightings: VehicleSighting[], times: number): Set<number> {
  const seen = new Map<number, { ts: Set<number>; sizes: number[] }>()
  for (const s of sightings) {
    const b = Math.round(s.az / OVERTAKE.staticBin)
    if (!seen.has(b)) seen.set(b, { ts: new Set(), sizes: [] })
    seen.get(b)!.ts.add(s.t)
    seen.get(b)!.sizes.push(s.size)
  }
  const out = new Set<number>()
  for (const [b, { ts, sizes }] of seen) {
    const big = [...sizes].sort((p, q) => p - q)[sizes.length >> 1] >= OVERTAKE.staticBigSize
    const share = big ? OVERTAKE.staticShareBig : OVERTAKE.staticShare
    if (ts.size >= OVERTAKE.staticMin && ts.size >= share * times) out.add(b)
  }
  return out
}

/**
 * 車線をまたいだ区間から、追い越しを選ぶ。
 * @param own 自分の車線でのセンターラインの側（左側通行 = +1）。追い越される車は反対の側（-own）の真横を通る
 * @param scannedTimes 車を探した時刻の数（自分の車体を見分けるのに使う）
 */
export function findOvertakes(
  crossings: LaneCrossing[],
  sightings: VehicleSighting[],
  own: 1 | -1,
  scannedTimes: number,
  explain?: (c: LaneCrossing, s: VehicleSighting) => void
): Overtake[] {
  const fixed = staticBins(sightings, scannedTimes)
  const passSide = -own
  // 自分の車体の向き: 下の縁で切れた（すぐ近くの）検出が 2 回以上出た向きと、その両隣
  const cut = new Map<number, number>()
  for (const s of sightings) if (s.low >= OVERTAKE.maxLow) cut.set(Math.round(s.az / OVERTAKE.ownBin), (cut.get(Math.round(s.az / OVERTAKE.ownBin)) ?? 0) + 1)
  const ownBins = new Set<number>()
  for (const [b, n] of cut) if (n >= 2) [b - 1, b, b + 1].forEach((x) => ownBins.add(x))
  const ownBody = (s: VehicleSighting): boolean => s.low >= OVERTAKE.maxLow || (s.low >= OVERTAKE.ownLow && ownBins.has(Math.round(s.az / OVERTAKE.ownBin)))
  return crossings.filter((c) =>
    sightings.some(
      (s) =>
        s.t >= c.start - OVERTAKE.margin &&
        s.t <= c.end + OVERTAKE.margin &&
        s.score >= OVERTAKE.minScore &&
        Math.sign(s.az) === passSide &&
        Math.abs(s.az) >= OVERTAKE.sideMin &&
        Math.abs(s.az) <= OVERTAKE.sideMax &&
        s.size <= OVERTAKE.maxSize &&
        !(s.cls === MOTORCYCLE && Math.abs(s.az) >= OVERTAKE.ownBikeAz) &&
        !ownBody(s) &&
        !fixed.has(Math.round(s.az / OVERTAKE.staticBin)) &&
        (explain?.(c, s), true)
    )
  )
}
