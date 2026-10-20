// How the seam distance is chosen (dynamic stitching).
//
// From the GPU-computed mismatch (0 = perfect match) for each "azimuth bin x distance candidate", choose the distance of each bin.
//   - Bins with little texture (sky, featureless road) have an unreliable match score, so they defer to their neighbors and the previous frame
//   - Distances should not change abruptly between neighbors (smooth along the seam)
//   - Distances should not change abruptly from the previous frame (flicker prevention). Over consecutive frames, approach the new value gradually
//   - If matches are about equally good, prefer the farther one (the one with less parallax correction)
//   - However, for azimuths that point below the horizon, nothing can be seen farther than the ground. The distance to the ground (camera height / sin of the downward angle)
//     is added to that azimuth's candidates as a guide (candidates farther than the ground are strongly disfavored, and nearer candidates are chosen only when the match is clearly better).
//     This prevents the distance from scattering from bin to bin on low-texture asphalt when the camera is mounted sideways and the seam crosses the road diagonally,
//     which would break the white lines into a zigzag
//   - For bins where the match is poor at every distance, the difference in match scores is trusted less accordingly (defer to neighbors and the previous frame).
//     Near a boundary with bright sky, or on weakly textured concrete, only the nearest candidate can happen to be a little better.
//     If only that bin gets a near distance, the scenery a little away from the seam (where only one lens sees it) is pulled by the width of that bin,
//     leaving a small triangular step on straight lines such as the edge of a wall (there, a distance blurred along the seam is used; blurSeamQ)

export interface SeamDepthState {
  /** Inverse of the previous frame's distance (per bin) */
  q: Float32Array
  frame: number
}

const LAMBDA = 0.025 // weight of the difference from neighboring bins (weak because the bins are fine, so that thin things like railing crossbars can still get a matching distance)
const MU = 0.04 // weight of the difference from the previous frame
const FAR_BIAS = 0.01 // weight that favors the far side (per candidate index)
const MIN_TEXTURE = 0.04 // bins with weaker texture than this do not use the match score
const FOLLOW = 0.15 // fraction by which the value approaches the new one over consecutive frames (the smaller, the slower it changes; about 0.3 s at 50fps)
/** Height from the road surface to the camera [m] (approximate; used as a guide for the distance to the ground) */
export const SEAM_CAM_HEIGHT = 1.5
const BEYOND_GROUND = 0.5 // weight of candidates farther than the ground (per difference in inverse distance; allows up to 0.8 times the ground distance to allow for slopes and height error)
const NEARER_THAN_GROUND = 0.15 // weight of candidates nearer than the ground (the own bike, rider and things right beside are chosen if the match is clearly good)
// In bins where the ground is visible, the match score is used only when the best candidate's mismatch is smaller than this.
// On the road surface (asphalt), fine texture blurs at the lens edge and the match is poor at every distance (0.3-0.6), so the differences are just scatter
const GROUND_TRUST = 0.2
/** Width of the blur along the seam used away from the seam (sigma, in bins. 1 bin = 1.4°) */
export const SEAM_BLUR_SIGMA = 3
// How much the match score is trusted: fully if the best candidate's mismatch is TRUST_LO or below, not at all at TRUST_HI or above (linear in between).
// In real data, clearly visible things are under 0.2 (railing in 0919 0.05-0.18, own bike 0.01-0.06),
// and accidental matches are 0.24-0.4 (the tunnel wall edge at 0830 3:04.66)
const TRUST_LO = 0.1
const TRUST_HI = 0.35

/**
 * Per azimuth bin, the inverse of the distance to the ground [1/m] (0 above the horizon).
 * e1 and e2 are the reference of the seam azimuth (rig coordinates), down is gravity pointing down (rig coordinates)
 */
export function groundPrior(e1: ArrayLike<number>, e2: ArrayLike<number>, down: ArrayLike<number>, bins: number, camHeight = SEAM_CAM_HEIGHT): Float32Array {
  const out = new Float32Array(bins)
  const c1 = e1[0] * down[0] + e1[1] * down[1] + e1[2] * down[2]
  const c2 = e2[0] * down[0] + e2[1] * down[1] + e2[2] * down[2]
  for (let b = 0; b < bins; b++) {
    const ph = ((b + 0.5) / bins) * Math.PI * 2 // same as the center of the shader bin
    out[b] = Math.max(0, Math.cos(ph) * c1 + Math.sin(ph) * c2) / camHeight
  }
  return out
}

/**
 * @param cost mismatch of bin b, candidate k (cost[k * bins + b], 0-1)
 * @param texture texture strength per bin (0-1)
 * @param cand inverse distance of the candidates [1/m] (in ascending order)
 * @param ground per-bin inverse distance to the ground (groundPrior; not used if null)
 */
export function chooseSeamDepth(
  cost: Float32Array,
  texture: Float32Array,
  cand: number[],
  bins: number,
  prev: SeamDepthState | null,
  frame: number,
  ground: Float32Array | null = null
): SeamDepthState {
  const K0 = cand.length
  // Candidates: the common K0 plus (for bins where the ground is visible) the distance to the ground
  const K = K0 + 1
  const candQ = (b: number, k: number): number => (k < K0 ? cand[k] : ground ? ground[b] : 0)
  const continuous = !!prev && Math.abs(frame - prev.frame) === 1
  const qPrev = continuous ? prev!.q : null
  // Per-bin evaluation (match score + preference for farther / ground + difference from the previous frame)
  const unary = new Float32Array(bins * K)
  for (let b = 0; b < bins; b++) {
    const g = ground ? ground[b] : 0
    let minCost = Infinity
    for (let k = 0; k < K0; k++) minCost = Math.min(minCost, cost[k * bins + b])
    const textured = texture[b] >= MIN_TEXTURE && !(g > 0 && minCost >= GROUND_TRUST)
    const trust = Math.max(0, Math.min(1, (TRUST_HI - minCost) / (TRUST_HI - TRUST_LO)))
    for (let k = 0; k < K; k++) {
      const q = candQ(b, k)
      if (k === K0 && !(g > 0)) {
        unary[b * K + k] = Infinity // above the horizon: there is no ground candidate
        continue
      }
      let c: number
      if (!textured || trust === 0) c = 0.5
      else if (k < K0) c = 0.5 + (cost[k * bins + b] - 0.5) * trust
      else {
        // The match score of the ground candidate is interpolated from the candidates before and after it
        let j = 0
        while (j < K0 - 2 && cand[j + 1] < q) j++
        const f = Math.max(0, Math.min(1, (q - cand[j]) / (cand[j + 1] - cand[j])))
        c = 0.5 + (cost[j * bins + b] * (1 - f) + cost[(j + 1) * bins + b] * f - 0.5) * trust
      }
      let u = c
      if (g > 0) u += BEYOND_GROUND * Math.max(0, 0.8 * g - q) + NEARER_THAN_GROUND * Math.max(0, q - g)
      else u += FAR_BIAS * k
      if (qPrev) u += MU * Math.abs(q - qPrev[b])
      unary[b * K + k] = u
    }
  }
  // First take the per-bin minimum, then review a few times with smoothness against neighbors (circular)
  const pick = new Int32Array(bins)
  for (let b = 0; b < bins; b++) {
    let best = 0
    for (let k = 1; k < K; k++) if (unary[b * K + k] < unary[b * K + best]) best = k
    pick[b] = best
  }
  for (let pass = 0; pass < 6; pass++) {
    for (let b = 0; b < bins; b++) {
      const bl = (b + bins - 1) % bins
      const br = (b + 1) % bins
      const l = candQ(bl, pick[bl])
      const r = candQ(br, pick[br])
      let best = pick[b]
      let bestV = Infinity
      for (let k = 0; k < K; k++) {
        const q = candQ(b, k)
        const v = unary[b * K + k] + LAMBDA * (Math.abs(q - l) + Math.abs(q - r))
        if (v < bestV) {
          bestV = v
          best = k
        }
      }
      pick[b] = best
    }
  }
  const q = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    const raw = candQ(b, pick[b])
    q[b] = qPrev ? qPrev[b] + (raw - qPrev[b]) * FOLLOW : raw
  }
  return { q, frame }
}

/**
 * Inverse distance blurred along the seam (circular; Gaussian weights, sigma in bins).
 * Used to correct areas a little away from the seam (where only one lens sees them). There, per-bin distance differences are not needed for alignment,
 * and using them as they are would fold a straight line into a triangle when one bin has a near distance (a thin near object, an accidental match)
 */
export function blurSeamQ(q: Float32Array, sigma = SEAM_BLUR_SIGMA): Float32Array {
  const n = q.length
  const r = Math.ceil(sigma * 2.5)
  const w: number[] = []
  let sw = 0
  for (let j = -r; j <= r; j++) {
    w.push(Math.exp((-0.5 * j * j) / (sigma * sigma)))
    sw += w[j + r]
  }
  const out = new Float32Array(n)
  for (let b = 0; b < n; b++) {
    let a = 0
    for (let j = -r; j <= r; j++) a += w[j + r] * q[(b + j + n) % n]
    out[b] = a / sw
  }
  return out
}

// ---- Seam position and blend width ----
//
// The images of the two lenses may not overlap no matter how the distance is adjusted for near things (license plate, top case, things right beside)
// (distances differ per object, and some things appear in only one lens). With a wide crossfade left as is, such things look doubled and see-through.
// So at azimuths where the images do not match,
//   - narrow the blend width (the doubling is visible only during the blend)
//   - shift the seam position within ±8° to where the difference between the two lenses is small (the road etc., where a switch is not noticeable)
// Azimuths where the images match well keep the geometric seam and the wide, smooth blend as before (so differences in brightness and detail are not noticeable)

/** Candidate seam positions [deg] (from the geometric seam toward lens 0) */
export const CUT_OFFS = [-8, -6, -4, -2, 0, 2, 4, 6, 8]

export interface SeamCutState {
  /** Seam position per bin [deg] */
  off: Float32Array
  /** Blend width multiplier per bin (1 = normal) */
  width: Float32Array
  /** Per-bin degree of "images do not match" (0-1; for checking) */
  ghost: Float32Array
  /** Image difference smoothed over time (avgDiff[j * bins + b]) and the unsmoothed mismatch degree (for smoothing in the next frame) */
  avgDiff?: Float32Array
  avgG0?: Float32Array
  frame: number
}

// Degree of mismatch: when both the mismatch at the chosen distance (from correlation, 0-1) and the image difference at the seam position (0-1) are large
const CUT_M_LO = 0.2
const CUT_M_HI = 0.4
const CUT_D_LO = 0.12
const CUT_D_HI = 0.3
const NARROW = 0.25 // width multiplier for non-matching areas (12° to 3°)
const CUT_CENTER = 0.06 // weight that dislikes shifting (per 8°)
const CUT_KEEP = 0.6 // weight that keeps well-matching azimuths on the geometric seam (per 8°)
const CUT_SMOOTH = 0.1 // weight of the position difference from neighboring bins (per 2°). If small, the seam zigzags and leaves steps on object edges
const CUT_FOLLOW = 0.25 // fraction by which the value approaches the new one over consecutive frames
// Fraction by which the image difference and the mismatch degree are smoothed over time (3% per frame, about 0.7 s at 50fps).
// Near things on the seam (top case, license plate, camera mount) move together with the camera, so the good seam position hardly changes.
// The per-frame image difference fluctuates on the road flowing backward and reselects between distant candidates (such as −8° and +6°).
// Even when only the output position was smoothed, on the way back and forth between candidates the seam crossed the edge of the case or the plate, and while riding parts of the case corners or the plate seemed to flicker in and out
const CUT_AVG = 0.03

const ramp = (x: number, lo: number, hi: number): number => Math.max(0, Math.min(1, (x - lo) / (hi - lo)))

/**
 * @param diff image difference of bin b, position candidate j (diff[j * bins + b], 0-1. 1 = outside the visible range)
 * @param cost mismatch per distance candidate (same as chooseSeamDepth)
 * @param q inverse distance chosen per bin
 */
export function chooseSeamCut(
  diff: Float32Array,
  cost: Float32Array,
  texture: Float32Array,
  cand: number[],
  q: Float32Array,
  bins: number,
  prev: SeamCutState | null,
  frame: number
): SeamCutState {
  const J = CUT_OFFS.length
  const j0 = CUT_OFFS.indexOf(0)
  const continuous = !!prev && Math.abs(frame - prev.frame) === 1
  // Smooth the image difference over time (outside the visible range = 1 is judged by this frame's value without smoothing)
  const raw = diff
  if (continuous && prev!.avgDiff && prev!.avgDiff.length === raw.length) {
    const a = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) a[i] = prev!.avgDiff[i] + (raw[i] - prev!.avgDiff[i]) * CUT_AVG
    diff = a
  }
  // Degree of image mismatch (per bin)
  const g0 = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    // Mismatch at the chosen distance (interpolated between candidates)
    let k = 0
    while (k < cand.length - 2 && cand[k + 1] < q[b]) k++
    const f = Math.max(0, Math.min(1, (q[b] - cand[k]) / (cand[k + 1] - cand[k])))
    const m = cost[k * bins + b] * (1 - f) + cost[(k + 1) * bins + b] * f
    g0[b] = texture[b] >= MIN_TEXTURE ? ramp(m, CUT_M_LO, CUT_M_HI) * ramp(diff[j0 * bins + b], CUT_D_LO, CUT_D_HI) : 0
    if (continuous && prev!.avgG0) g0[b] = prev!.avgG0[b] + (g0[b] - prev!.avgG0[b]) * CUT_AVG
  }
  // Spread to the 2 neighboring bins so that it narrows all the way to the object edge, then blur
  const gMax = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    let v = 0
    for (let d = -2; d <= 2; d++) v = Math.max(v, g0[(b + d + bins) % bins])
    gMax[b] = v
  }
  const ghost = blurSeamQ(gMax, 1.5)
  // Seam position: shortest path along the bins (image difference + shift amount + difference from neighbor)
  const unary = (b: number, j: number): number => {
    const o = Math.abs(CUT_OFFS[j]) / 8
    return ghost[b] * diff[j * bins + b] + (CUT_CENTER + CUT_KEEP * (1 - ghost[b])) * o + (raw[j * bins + b] >= 1 ? 10 : 0)
  }
  const acc = new Float32Array(bins * J)
  const from = new Int8Array(bins * J)
  for (let j = 0; j < J; j++) acc[j] = unary(0, j)
  for (let b = 1; b < bins; b++) {
    for (let j = 0; j < J; j++) {
      let best = Infinity
      let bj = 0
      for (let i = 0; i < J; i++) {
        // When the position changes to a neighboring bin, the seam line crosses the positions in between diagonally. Count the image difference at those positions too
        // (when the low-difference positions were split above and below an object, switching between them crossed the object (license plate) and made it look chipped)
        let cross = 0
        for (let k = Math.min(i, j) + 1; k < Math.max(i, j); k++) cross += 0.5 * (diff[k * bins + b - 1] + diff[k * bins + b])
        const v = acc[(b - 1) * J + i] + (CUT_SMOOTH * Math.abs(CUT_OFFS[j] - CUT_OFFS[i])) / 2 + 0.5 * (ghost[b - 1] + ghost[b]) * cross
        if (v < best) {
          best = v
          bj = i
        }
      }
      acc[b * J + j] = best + unary(b, j)
      from[b * J + j] = bj
    }
  }
  const pick = new Int8Array(bins)
  let last = 0
  for (let j = 1; j < J; j++) if (acc[(bins - 1) * J + j] < acc[(bins - 1) * J + last]) last = j
  pick[bins - 1] = last
  for (let b = bins - 1; b > 0; b--) pick[b - 1] = from[b * J + pick[b]]
  // Smooth the chosen position a little along the azimuth (so that the seam line curves smoothly)
  const picked = new Float32Array(bins)
  for (let b = 0; b < bins; b++) picked[b] = CUT_OFFS[pick[b]]
  const offS = blurSeamQ(picked, 1.5)
  const off = new Float32Array(bins)
  const width = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    const o = offS[b]
    const w = 1 - (1 - NARROW) * ghost[b]
    off[b] = continuous ? prev!.off[b] + (o - prev!.off[b]) * CUT_FOLLOW : o
    width[b] = continuous ? prev!.width[b] + (w - prev!.width[b]) * CUT_FOLLOW : w
  }
  return { off, width, ghost, avgDiff: diff, avgG0: g0, frame }
}
