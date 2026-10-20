// Overtake detection: among the sections where the bike crossed the lane (core/lanes.ts), those during which a car passed directly beside the overtaking side (core/vehicles.ts).
//
//   - In left-hand traffic (center line on the right = own lane) you pull out into the right lane to overtake, so the overtaken car passes directly on the left.
//     In right-hand traffic it is the reverse. Oncoming cars pass on the opposite side, so they are not counted
//   - Exclude the own bike's body (seen in the rear-facing image): anything so close it is cut off by the bottom edge of the image, motorcycles in the rear half,
//     anything so close it looks too large, and anything seen many times in the same direction
//   - Avoiding a stopped car by crossing the center line is also counted as an overtake
import type { LaneCrossing } from './lanes'
import type { VehicleSighting } from './vehicles'

/** COCO class for motorcycle */
const MOTORCYCLE = 3

/**
 * Version of the detection. Bump it when the method changes (if a result saved in a project is from an older version, it is re-examined on the next auto-generation).
 * 2: for sections decided only by road-surface spread, require a clear bias (it was wrong on the pavement of a parking lot beside the road)
 */
export const OVERTAKE_SCAN_VERSION = 2

export interface Overtake {
  /** Last time [s] in the own lane (after this, it starts crossing the lane) */
  start: number
  /** Time [s] at which the return to the own lane was confirmed */
  end: number
}

export const OVERTAKE = {
  /** Range of bearings [deg] regarded as directly beside (the overtaking side; diagonally ahead is excluded because it also includes cars before they are overtaken) */
  sideMin: 60,
  sideMax: 150,
  /**
   * Anything that looks larger than this is regarded as the own bike's body [deg] (apparent height).
   * A car passing 2-3 m directly beside is about 35°. Parts of the own bike appear at 40-90° at a distance of 0.5-1 m
   */
  maxSize: 42,
  /**
   * A motorcycle seen in the rear half (bearing further back than this) is regarded as the own bike [deg].
   * Parts of the own bike look small when only partly visible and are not detected every time, so size and number of sightings cannot exclude them all
   */
  ownBikeAz: 100,
  /**
   * Anything whose box bottom is lower than this (cut off by the bottom edge of the image at 45°) is regarded as the own body right nearby [deg].
   * Parts of the own bike may be classified as a passenger car, so classes cannot exclude them all. The bottom edge of a car passing 2-3 m beside is at 10-20°
   */
  maxLow: 40,
  /** In directions where detections cut off by the bottom edge appeared 2 or more times (the own body's direction, per ownBin°), anything with a bottom edge at or beyond this is also excluded [deg] */
  ownBin: 10,
  ownLow: 25,
  /** Margin [s] before and after a lane-crossing section in which to search for cars */
  margin: 1,
  minScore: 0.5,
  /**
   * Anything seen many times in the same direction is regarded as the own body: at least this share of the examined times (and at least staticMin times). Bearing bin width [deg].
   * Large objects (median apparent height of staticBigSize° or more) are regarded as the own body even if the share is only staticShareBig
   * (an overtaking car appears directly beside only 1-2 times per overtake)
   */
  staticShare: 0.4,
  staticShareBig: 0.12,
  staticBigSize: 25,
  staticMin: 4,
  staticBin: 15
}

/** Bearing bin of what is always seen in the same direction relative to the number of examined times (the own body) */
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
 * Selects overtakes from the lane-crossing sections.
 * @param own Side of the center line in the own lane (left-hand traffic = +1). The overtaken car passes directly beside the opposite side (-own)
 * @param scannedTimes Number of times cars were searched for (used to identify the own body)
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
  // Direction of the own body: directions where detections cut off by the bottom edge (right nearby) appeared 2 or more times, plus both neighbors
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
