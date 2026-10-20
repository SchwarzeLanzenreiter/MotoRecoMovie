// Template for the own-bike seam (the own-bike part refined with AI, stitched together per video segment).
//
// When the camera is mounted behind the top case, the top case, license plate and camera mount end up right on the seam.
// These are only 0.3-1 m away, and some of them (the camera mount) are visible to only one lens, so the images from the two lenses never match at any distance.
// Choosing the seam position or distance per frame makes parts of objects go missing or flicker while riding (docs/insv-x6-format.md).
//
// However, these move together with the camera, so they stay still in the lens images. So, once per segment (about 30 s), take the time to:
//   1. Turn the area near the seam into a band image (azimuth φ × angle θ from the optical axis) and take the median over the segment's keyframes. The road, which flows while riding, vanishes,
//      leaving only the own-bike part (the template). Where nothing changes over time = own-bike part (where MAD is small)
//   2. In the overlap that both lenses see (θ 79-101°), find where each pixel of the lens 0 template lands in the lens 1 template
//      with AI optical flow (NeuFlow v2). Use it only where forward and backward flow agree; elsewhere do not shift
//   3. For each column, put the seam row where the template images differ least (same idea as panorama seam finding. The farther from 90° the worse,
//      and smooth with neighboring columns). Both sides are drawn with their own lens (we do not decide which lens is correct)
//   4. Fill any holes (where neither lens can draw) with AI inpainting (LaMa / MI-GAN)
// In per-frame rendering, the own-bike part is drawn by pasting the current video using this correspondence (seam and offset) (brightness and shadows stay as in the current video).
// Everything else (road, scenery) is drawn as before, with per-frame distance estimation and seam handling.
//
// Band coordinates: column x → azimuth φ = (x + 0.5) / BAND_W · 360° (from seamBasis e1 toward e2),
//           row y → angle from the lens 0 optical axis θ = BAND_TH0 + (y + 0.5) · BAND_STEP (the seam is θ = 90°)

/** Band size [px] and the angle of one pixel [deg] */
export const BAND_STEP = 0.15
export const BAND_W = 2400
export const BAND_H = 288
/** Angle from the lens 0 optical axis at the start of the band [deg] (the band spans 68.4-111.6°) */
export const BAND_TH0 = 90 - (BAND_H * BAND_STEP) / 2

/** Band row y (fractional) → angle from the lens 0 optical axis [deg] */
export const bandTheta = (y: number): number => BAND_TH0 + (y + 0.5) * BAND_STEP
/** Angle from the lens 0 optical axis [deg] → band row (fractional) */
export const bandRow = (thetaDeg: number): number => (thetaDeg - BAND_TH0) / BAND_STEP - 0.5

/** Overlap rows for optical flow (θ 79-101°) and the model input size (NeuFlow v2: 432×768) */
export const OV_Y0 = Math.round((79 - BAND_TH0) / BAND_STEP)
export const OV_Y1 = Math.round((101 - BAND_TH0) / BAND_STEP)
export const FLOW_W = 768
export const FLOW_H = 432

/** Edge of the range each lens sees (lens 0 below this θ, lens 1 above). The seam is placed inside it */
const LENS0_MAX = 99.5
const LENS1_MIN = 80.5

/** Per-segment template (per lens) */
export interface BandStats {
  /** Median color (RGB, BAND_W×BAND_H×3) */
  med: Uint8Array
  /** Temporal spread of brightness (median of the differences from the median, 0-1) */
  mad: Float32Array
  /** Whether it is inside the range this lens sees */
  valid: Uint8Array
  /**
   * How unchanging over time it is (0-1). Where there is texture, the median of the local correlation (7×7, independent of brightness changes) between each frame and the template;
   * where there is none, the smallness of the brightness spread. With the brightness spread (mad) alone, an aluminum top case whose brightness changes with the sunlight
   * was judged as "changing", and a step was left at the seam around the reflector
   */
  stat: Float32Array
}

/** Mean over a (2r+1) square of a 1-channel band (azimuth wraps around, rows are clipped at the edges) */
function boxBand(a: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(a.length)
  const out = new Float32Array(a.length)
  const n = 2 * r + 1
  for (let y = 0; y < BAND_H; y++) {
    const o = y * BAND_W
    let s = 0
    for (let k = -r; k <= r; k++) s += a[o + ((k + BAND_W) % BAND_W)]
    for (let x = 0; x < BAND_W; x++) {
      tmp[o + x] = s / n
      s += a[o + ((x + r + 1) % BAND_W)] - a[o + ((x - r + BAND_W) % BAND_W)]
    }
  }
  for (let x = 0; x < BAND_W; x++) {
    for (let y = 0; y < BAND_H; y++) {
      let s = 0
      let c = 0
      for (let k = Math.max(0, y - r); k <= Math.min(BAND_H - 1, y + r); k++) {
        s += tmp[k * BAND_W + x]
        c++
      }
      out[y * BAND_W + x] = s / c
    }
  }
  return out
}

const STAT_R = 3 // window for the local correlation (7×7)
const STAT_TEX_LO = 0.01 // window brightness std at or below this = "no texture", +0.02 = "textured"
const STAT_NCC_LO = 0.5 // median correlation at or below this = "changing", +0.3 = "unchanging"
const STAT_FLAT_MAD = 0.015 // where there is no texture, a brightness spread smaller than this = "unchanging"

/** How unchanging over time it is (BandStats.stat). lums = brightness of each frame (0-1), med = its median */
function staticness(lums: Float32Array[], med: Float32Array, mad: Float32Array): Float32Array {
  const N = med.length
  const mm = boxBand(med, STAT_R)
  const sq = new Float32Array(N)
  for (let i = 0; i < N; i++) sq[i] = med[i] * med[i]
  const vm = boxBand(sq, STAT_R)
  for (let i = 0; i < N; i++) vm[i] = Math.max(0, vm[i] - mm[i] * mm[i])
  const nccs = lums.map((l) => {
    const ml = boxBand(l, STAT_R)
    const t = new Float32Array(N)
    for (let i = 0; i < N; i++) t[i] = l[i] * l[i]
    const vl = boxBand(t, STAT_R)
    for (let i = 0; i < N; i++) t[i] = l[i] * med[i]
    const c = boxBand(t, STAT_R)
    const out = new Float32Array(N)
    for (let i = 0; i < N; i++) out[i] = (c[i] - ml[i] * mm[i]) / Math.sqrt(Math.max((vl[i] - ml[i] * ml[i]) * vm[i], 1e-8))
    return out
  })
  const n = lums.length
  const v = new Float32Array(n)
  const stat = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < n; k++) v[k] = nccs[k][i]
    v.sort()
    const ncc = n % 2 ? v[(n - 1) >> 1] : 0.5 * (v[n / 2 - 1] + v[n / 2])
    const tex = Math.min(1, Math.max(0, (Math.sqrt(vm[i]) - STAT_TEX_LO) / 0.02))
    stat[i] = tex * Math.min(1, Math.max(0, (ncc - STAT_NCC_LO) / 0.3)) + (1 - tex) * (mad[i] < STAT_FLAT_MAD ? 1 : 0)
  }
  return stat
}

/** From several band images (RGBA, alpha = inside the visible range), compute the median color and the brightness spread */
export function bandStats(frames: ArrayLike<number>[]): BandStats {
  const n = frames.length
  const N = BAND_W * BAND_H
  const med = new Uint8Array(N * 3)
  const mad = new Float32Array(N)
  const valid = new Uint8Array(N)
  const v = new Float32Array(n)
  const lum = new Float32Array(n)
  const sortN = (a: Float32Array): void => {
    for (let i = 1; i < n; i++) {
      const x = a[i]
      let j = i - 1
      while (j >= 0 && a[j] > x) {
        a[j + 1] = a[j]
        j--
      }
      a[j + 1] = x
    }
  }
  const median = (a: Float32Array): number => (n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]))
  for (let p = 0; p < N; p++) {
    valid[p] = frames[0][p * 4 + 3] > 127 ? 1 : 0
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < n; k++) v[k] = frames[k][p * 4 + c]
      sortN(v)
      med[p * 3 + c] = Math.round(median(v))
    }
    for (let k = 0; k < n; k++) lum[k] = (frames[k][p * 4] + frames[k][p * 4 + 1] + frames[k][p * 4 + 2]) / (3 * 255)
    const lm = (() => {
      v.set(lum)
      sortN(v)
      return median(v)
    })()
    for (let k = 0; k < n; k++) v[k] = Math.abs(lum[k] - lm)
    sortN(v)
    mad[p] = median(v)
  }
  // How unchanging over time it is (blur the brightness slightly to tolerate the ~1 px shift caused by camera mount shake)
  const lums = frames.map((f) => {
    const l = new Float32Array(N)
    for (let p = 0; p < N; p++) l[p] = (f[p * 4] + f[p * 4 + 1] + f[p * 4 + 2]) / (3 * 255)
    return boxBand(l, 1)
  })
  const lmed = new Float32Array(N)
  for (let p = 0; p < N; p++) {
    for (let k = 0; k < n; k++) v[k] = lums[k][p]
    sortN(v)
    lmed[p] = median(v)
  }
  return { med, mad, valid, stat: staticness(lums, lmed, mad) }
}

/** Flow model input: take FLOW_W columns from column x0 of the template overlap rows (OV_Y0-OV_Y1) (wrapping around) and stretch only vertically to FLOW_H rows (1×3×H×W, 0-1) */
export function flowInput(med: Uint8Array, x0: number): Float32Array {
  const rows = OV_Y1 - OV_Y0
  const out = new Float32Array(3 * FLOW_H * FLOW_W)
  for (let y = 0; y < FLOW_H; y++) {
    const sy = Math.min(rows - 1.001, Math.max(0, ((y + 0.5) * rows) / FLOW_H - 0.5))
    const y0 = Math.floor(sy)
    const fy = sy - y0
    for (let x = 0; x < FLOW_W; x++) {
      const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
      const a = ((OV_Y0 + y0) * BAND_W + bx) * 3
      const b = a + BAND_W * 3
      for (let c = 0; c < 3; c++) out[c * FLOW_H * FLOW_W + y * FLOW_W + x] = (med[a + c] * (1 - fy) + med[b + c] * fy) / 255
    }
  }
  return out
}

/** Bilinearly read a band image (1 Float32 channel) at (x, y) (outside the range, the edge value) */
function bil(img: Float32Array, x: number, y: number): number {
  const xc = Math.min(BAND_W - 1.001, Math.max(0, x))
  const yc = Math.min(BAND_H - 1.001, Math.max(0, y))
  const x0 = Math.floor(xc)
  const y0 = Math.floor(yc)
  const ax = xc - x0
  const ay = yc - y0
  const i = y0 * BAND_W + x0
  return img[i] * (1 - ax) * (1 - ay) + img[i + 1] * ax * (1 - ay) + img[i + BAND_W] * (1 - ax) * ay + img[i + BAND_W + 1] * ax * ay
}

/** Gaussian-blur a 1-channel band (σ [px], both directions) */
export function blurBand(a: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 2.5)
  const w: number[] = []
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)))
  const tmp = new Float32Array(a.length)
  const out = new Float32Array(a.length)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let s = 0
      let sw = 0
      for (let k = -r; k <= r; k++) {
        const xx = (((x + k) % BAND_W) + BAND_W) % BAND_W
        s += a[y * BAND_W + xx] * w[k + r]
        sw += w[k + r]
      }
      tmp[y * BAND_W + x] = s / sw
    }
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let s = 0
      let sw = 0
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy < 0 || yy >= BAND_H) continue
        s += tmp[yy * BAND_W + x] * w[k + r]
        sw += w[k + r]
      }
      out[y * BAND_W + x] = s / sw
    }
  return out
}

/** Shrink (erode) / grow (dilate) a binary band with a square. r [px] */
function morph(a: Uint8Array, r: number, dilate: boolean): Uint8Array {
  const tmp = new Uint8Array(a.length)
  const out = new Uint8Array(a.length)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let v = dilate ? 0 : 1
      for (let k = -r; k <= r; k++) {
        const b = a[y * BAND_W + ((((x + k) % BAND_W) + BAND_W) % BAND_W)]
        v = dilate ? v | b : v & b
      }
      tmp[y * BAND_W + x] = v
    }
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      let v = dilate ? 0 : 1
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(BAND_H - 1, Math.max(0, y + k))
        const b = tmp[yy * BAND_W + x]
        v = dilate ? v | b : v & b
      }
      out[y * BAND_W + x] = v
    }
  return out
}

/** Map the flow model output (1×2×FLOW_H×FLOW_W, in model input pixels) back to the band overlap rows starting at column x0 and accumulate it */
export function flowToBand(flow: Float32Array, x0: number, fx: Float32Array, fy: Float32Array, wsum: Float32Array): void {
  const rows = OV_Y1 - OV_Y0
  const S = rows / FLOW_H
  for (let y = OV_Y0; y < OV_Y1; y++) {
    const sy = Math.min(FLOW_H - 1, Math.max(0, Math.round((y - OV_Y0 + 0.5) / S - 0.5)))
    for (let x = 0; x < FLOW_W; x++) {
      // Lighter toward the tile edges (where tiles overlap, prefer the one nearer the center)
      const w = 1e-3 + Math.min(x + 1, FLOW_W - x)
      const bx = (((x0 + x) % BAND_W) + BAND_W) % BAND_W
      const i = y * BAND_W + bx
      fx[i] += flow[sy * FLOW_W + x] * w
      fy[i] += flow[FLOW_H * FLOW_W + sy * FLOW_W + x] * S * w
      wsum[i] += w
    }
  }
}

/** The segment's own-bike seam (values passed to rendering. All are BAND_W×BAND_H) */
export interface BodyStitch {
  /** Degree of own-bike part (0-1. 1 = draw with this template, 0 = draw with the usual processing) */
  m: Float32Array
  /** Fraction drawn with lens 1 (0 = lens 0, 1 = lens 1. Switches over 0.6° at the seam) */
  w1: Float32Array
  /** Offset of the lens 1 read position [band pixels] (column, row). Goes to 0 away from the seam */
  dx: Float32Array
  dy: Float32Array
  /** Seam row (per column, for inspection) */
  cut: Float32Array
}

const FB_OK = 2 // trust the flow if the forward/backward flow mismatch is at or below this [px]
const CUT_RES = 3 // weight of the image difference for the seam row
const CUT_CENTER = 0.04 // weight penalizing distance from 90° (per 1°)
const CUT_SMOOTH = 0.2 // weight of the row difference from the neighboring column (per row)
const CUT_UNALIGNED = 0.01 // weight for own-bike parts drawn with lens 1 that cannot be aligned (per row)
const WARP_DECAY = 40 // outside the overlap, fade the lens 1 offset over this many rows (6°)
const BLEND_ROWS = 4 // width of the seam switch [rows] (0.6°)

/**
 * From the templates and flow, determine the segment's own-bike seam.
 * fwd = flow lens 0 → lens 1, bwd = flow lens 1 → lens 0 (both mapped back to the band with flowToBand and divided by the weight. 0 outside the overlap rows)
 */
export function buildStitch(s0: BandStats, s1: BandStats, fwd: { fx: Float32Array; fy: Float32Array }, bwd: { fx: Float32Array; fy: Float32Array }): BodyStitch {
  const N = BAND_W * BAND_H
  // Use only reliable flow: forward and backward flow agree within FB_OK, and inside the overlap rows. Otherwise 0 (no shift). Connect smoothly
  const conf = new Float32Array(N)
  for (let y = OV_Y0; y < OV_Y1; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      const ex = fwd.fx[i] + bil(bwd.fx, x + fwd.fx[i], y + fwd.fy[i])
      const ey = fwd.fy[i] + bil(bwd.fy, x + fwd.fx[i], y + fwd.fy[i])
      conf[i] = Math.hypot(ex, ey) < FB_OK ? 1 : 0
    }
  const cb = blurBand(conf, 4)
  const wx = new Float32Array(N)
  const wy = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    wx[i] = fwd.fx[i] * conf[i]
    wy[i] = fwd.fy[i] * conf[i]
  }
  const bx = blurBand(wx, 4)
  const by = blurBand(wy, 4)
  const fx = new Float32Array(N)
  const fy = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const k = Math.min(1, cb[i] * 2) / Math.max(cb[i], 1e-3)
    fx[i] = bx[i] * k
    fy[i] = by[i] * k
  }
  // Image difference of the templates (with lens 1 shifted and overlaid), and places that do not match
  const lum0 = new Float32Array(N)
  const lum1 = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    lum0[i] = (s0.med[i * 3] + s0.med[i * 3 + 1] + s0.med[i * 3 + 2]) / (3 * 255)
    lum1[i] = (s1.med[i * 3] + s1.med[i * 3 + 1] + s1.med[i * 3 + 2]) / (3 * 255)
  }
  const res = new Float32Array(N)
  for (let y = OV_Y0; y < OV_Y1; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      res[i] = Math.abs(lum0[i] - bil(lum1, x + fx[i], y + fy[i]))
    }
  // Cost of the seam row: mean image difference over 7 rows × 3 columns
  const rb = new Float32Array(N)
  for (let y = OV_Y0; y < OV_Y1; y++)
    for (let x = 0; x < BAND_W; x++) {
      let s = 0
      let c = 0
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy
          if (yy < OV_Y0 || yy >= OV_Y1) continue
          s += res[yy * BAND_W + ((x + dx + BAND_W) % BAND_W)]
          c++
        }
      rb[y * BAND_W + x] = s / c
    }
  // Own-bike part: places that do not change over time in either lens. Remove small dots, expand, and blur
  let st: Uint8Array = new Uint8Array(N)
  for (let i = 0; i < N; i++) st[i] = (s0.valid[i] && s0.stat[i] > 0.5) || (s1.valid[i] && s1.stat[i] > 0.5) ? 1 : 0
  // Remove small dots (e.g. road that happens to resemble the template), then fill gaps (object edges etc.) and expand slightly
  st = morph(morph(st, 2, false), 2, true)
  st = morph(morph(st, 3, true), 3, false)
  st = morph(st, 6, true)
  const stf = new Float32Array(N)
  for (let i = 0; i < N; i++) stf[i] = st[i]
  const m = blurBand(stf, 3)
  const c0 = Math.ceil(bandRow(LENS1_MIN))
  const c1 = Math.floor(bandRow(LENS0_MAX))
  const J = c1 - c0 + 1
  // Number of rows of the own-bike part drawn with lens 1 that cannot be aligned by flow (unreliable). Lens 0 is the unshifted reference,
  // so where alignment is impossible, draw with lens 0 as far as lens 0 can see (the nearby top case looks very different in the two lenses,
  // and placing the seam on the lens 1 side made straight lines like the reflector appear broken at the seam)
  const un = new Float32Array(N)
  for (let x = 0; x < BAND_W; x++) {
    let acc = 0
    for (let y = c1; y >= c0; y--) {
      const i = y * BAND_W + x
      acc += m[i] * (1 - Math.min(1, cb[i] * 2))
      un[i] = acc
    }
  }
  const cost = (x: number, j: number): number => CUT_RES * rb[(c0 + j) * BAND_W + x] + CUT_CENTER * Math.abs(bandTheta(c0 + j) - 90) + CUT_UNALIGNED * un[(c0 + j) * BAND_W + x]
  // Shortest path along the columns (row difference costs CUT_SMOOTH/row). For wrap-around, go around twice and use the second half
  const acc = new Float32Array(J)
  const from = new Int16Array(BAND_W * 2 * J)
  for (let j = 0; j < J; j++) acc[j] = cost(0, j)
  const best = new Float32Array(J)
  const arg = new Int16Array(J)
  for (let xx = 1; xx < BAND_W * 2; xx++) {
    const x = xx % BAND_W
    for (let j = 0; j < J; j++) {
      best[j] = acc[j]
      arg[j] = j
    }
    for (let j = 1; j < J; j++)
      if (best[j - 1] + CUT_SMOOTH < best[j]) {
        best[j] = best[j - 1] + CUT_SMOOTH
        arg[j] = arg[j - 1]
      }
    for (let j = J - 2; j >= 0; j--)
      if (best[j + 1] + CUT_SMOOTH < best[j]) {
        best[j] = best[j + 1] + CUT_SMOOTH
        arg[j] = arg[j + 1]
      }
    for (let j = 0; j < J; j++) {
      acc[j] = best[j] + cost(x, j)
      from[xx * J + j] = arg[j]
    }
  }
  let jb = 0
  for (let j = 1; j < J; j++) if (acc[j] < acc[jb]) jb = j
  const cutRaw = new Float32Array(BAND_W)
  for (let xx = BAND_W * 2 - 1; xx >= BAND_W; xx--) {
    cutRaw[xx % BAND_W] = c0 + jb
    jb = from[xx * J + jb]
  }
  // Smooth slightly along the columns (σ 3 columns)
  const cut = new Float32Array(BAND_W)
  for (let x = 0; x < BAND_W; x++) {
    let s = 0
    let sw = 0
    for (let k = -8; k <= 8; k++) {
      const w = Math.exp(-(k * k) / 18)
      s += cutRaw[(x + k + BAND_W) % BAND_W] * w
      sw += w
    }
    cut[x] = s / sw
  }
  const w1 = new Float32Array(N)
  const dx = new Float32Array(N)
  const dy = new Float32Array(N)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      w1[i] = Math.min(1, Math.max(0, (y - cut[x]) / BLEND_ROWS + 0.5))
      // Use the offset as is wherever the flow is reliable, not by distance from the seam (the whole object is aligned the same way, so straight lines do not break).
      // Weakening it with distance from the seam made straight lines like the reflector break just past the seam, and extending it far shifted unrelated areas so other objects showed through.
      // Outside the overlap (θ > 101°, seen only by lens 1), fade to 0 over WARP_DECAY rows from the edge value
      const yy = Math.min(y, OV_Y1 - 1)
      const k = Math.exp(-Math.max(0, y - cut[x]) / WARP_DECAY)
      dx[i] = fx[yy * BAND_W + x] * k
      dy[i] = fy[yy * BAND_W + x] * k
    }
  return { m, w1, dx, dy, cut }
}

// ---- Holes (places neither lens can draw) ----
//
// When the lens drawing this side of the seam is outside the range that sees the spot (where the seam cannot be moved into the other lens's range).
// Use the color from AI inpainting that filled the template.
// I also tried "treat dark, time-invariant, textureless places as an occluding object (the camera mount) and make them holes",
// but it turned even the black edges of the top case and the rider's black trousers into holes and erased them, so I dropped it. In my video (mount behind the top case),
// the lens 1 mount is always on the lens 0 side (θ < 90°) and drawn with lens 0, so no holes appear

/** Find holes from the template and seam (1 = hole). force is for inspection (makes the own-bike part in this rectangle [x0, y0, x1, y1] a hole) */
export function findHoles(s0: BandStats, s1: BandStats, st: BodyStitch, force: number[] | null = null): Uint8Array {
  const N = BAND_W * BAND_H
  const h = new Uint8Array(N)
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      if (st.m[i] < 0.5) continue
      if (force && x >= force[0] && x < force[2] && y >= force[1] && y < force[3]) h[i] = 1
      else if (!(st.w1[i] > 0.5 ? s1 : s0).valid[i] && !(st.w1[i] > 0.5 ? s0 : s1).valid[i]) h[i] = 1
    }
  return h.some((v) => v) ? morph(h, 2, true) : h
}

/** Template colors aligned at the seam (RGB, input for filling holes). Lens 1 is read shifted by the offset */
export function stitchedTemplate(s0: BandStats, s1: BandStats, st: BodyStitch): Uint8Array {
  const N = BAND_W * BAND_H
  const out = new Uint8Array(N * 3)
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(N)
    for (let i = 0; i < N; i++) a[i] = s1.med[i * 3 + c]
    return a
  })
  for (let y = 0; y < BAND_H; y++)
    for (let x = 0; x < BAND_W; x++) {
      const i = y * BAND_W + x
      for (let c = 0; c < 3; c++) {
        const v1 = bil(ch[c], x + st.dx[i], y + st.dy[i])
        out[i * 3 + c] = Math.round(s0.med[i * 3 + c] * (1 - st.w1[i]) + v1 * st.w1[i])
      }
    }
  return out
}

// ---- Per-video-segment templates ----

/** The segment's own-bike seam, cropped down to only the columns of the own-bike part (for saving and rendering) */
export interface BodyMapC {
  /** Start of the cropped columns (wraps around) and number of columns. All rows (BAND_H) */
  x0: number
  w: number
  /** Degree of own-bike part and lens 1 fraction (0-255), lens 1 offset (1/64 pixel) */
  m: Uint8Array
  w1: Uint8Array
  dx: Int16Array
  dy: Int16Array
  /** Hole-filled color (RGBA, alpha = degree of hole). Omitted if there is no hole */
  fill?: Uint8Array
}

/** Segment [t0, t1) [s] and its template (index into maps. -1 = no own-bike part / could not be made) */
export interface BodyWindow {
  t0: number
  t1: number
  map: number
}

export interface BodyTrack {
  windows: BodyWindow[]
  maps: BodyMapC[]
}

/** Crop out only the columns of the own-bike part (null if there is no own-bike part) */
export function compactStitch(st: BodyStitch, holes: Uint8Array | null, fill: Uint8Array | null): BodyMapC | null {
  const col = new Uint8Array(BAND_W)
  for (let y = 0; y < BAND_H; y++) for (let x = 0; x < BAND_W; x++) if (st.m[y * BAND_W + x] > 0.004) col[x] = 1
  // The remaining arc after excluding the longest run of columns with no own-bike part
  let bestLen = -1
  let bestStart = 0
  for (let x = 0; x < BAND_W; x++) {
    if (col[x] || !col[(x - 1 + BAND_W) % BAND_W]) continue
    let n = 0
    while (n < BAND_W && !col[(x + n) % BAND_W]) n++
    if (n > bestLen) {
      bestLen = n
      bestStart = x
    }
  }
  if (bestLen < 0) {
    if (!col.some((v) => v)) return null
    bestLen = 0
  }
  const x0 = (bestStart + bestLen) % BAND_W
  const w = BAND_W - bestLen
  const n = w * BAND_H
  const c: BodyMapC = { x0, w, m: new Uint8Array(n), w1: new Uint8Array(n), dx: new Int16Array(n), dy: new Int16Array(n) }
  const hasHoles = !!holes && !!fill && holes.some((v) => v)
  if (hasHoles) c.fill = new Uint8Array(n * 4)
  for (let y = 0; y < BAND_H; y++)
    for (let k = 0; k < w; k++) {
      const i = y * BAND_W + ((x0 + k) % BAND_W)
      const j = y * w + k
      c.m[j] = Math.round(st.m[i] * 255)
      c.w1[j] = Math.round(st.w1[i] * 255)
      c.dx[j] = Math.max(-32767, Math.min(32767, Math.round(st.dx[i] * 64)))
      c.dy[j] = Math.max(-32767, Math.min(32767, Math.round(st.dy[i] * 64)))
      if (c.fill) {
        c.fill[j * 4] = fill![i * 3]
        c.fill[j * 4 + 1] = fill![i * 3 + 1]
        c.fill[j * 4 + 2] = fill![i * 3 + 2]
        c.fill[j * 4 + 3] = holes![i] ? 255 : 0
      }
    }
  return c
}

/**
 * Contents of the rendering texture (BAND_W×BAND_H RGBA: degree of own-bike part, lens 1 fraction, offset x, offset y), and
 * the hole-filled color (RGBA8). All 0 if map is null
 */
export function bodyTexData(c: BodyMapC | null, out: Float32Array<ArrayBuffer> = new Float32Array(BAND_W * BAND_H * 4), fillOut: Uint8Array<ArrayBuffer> = new Uint8Array(BAND_W * BAND_H * 4)): { map: Float32Array<ArrayBuffer>; fill: Uint8Array<ArrayBuffer> } {
  out.fill(0)
  fillOut.fill(0)
  if (c) {
    for (let y = 0; y < BAND_H; y++)
      for (let k = 0; k < c.w; k++) {
        const i = (y * BAND_W + ((c.x0 + k) % BAND_W)) * 4
        const j = y * c.w + k
        out[i] = c.m[j] / 255
        out[i + 1] = c.w1[j] / 255
        out[i + 2] = c.dx[j] / 64
        out[i + 3] = c.dy[j] / 64
        if (c.fill) for (let q = 0; q < 4; q++) fillOut[i + q] = c.fill[j * 4 + q]
      }
  }
  return { map: out, fill: fillOut }
}

/**
 * The two templates to use at time t [s] and the blend fraction (linear between segment midpoints. So that in videos where the camera mount rotates slowly,
 * the seam and offset do not change abruptly at segment boundaries). -1 if there is no template
 */
export function bodyAt(track: BodyTrack, t: number): { a: number; b: number; mix: number } {
  const ws = track.windows
  if (!ws.length) return { a: -1, b: -1, mix: 0 }
  const mid = (w: BodyWindow): number => (w.t0 + w.t1) / 2
  if (t <= mid(ws[0])) return { a: ws[0].map, b: ws[0].map, mix: 0 }
  for (let k = 0; k + 1 < ws.length; k++) {
    const a = mid(ws[k])
    const b = mid(ws[k + 1])
    if (t < b) return { a: ws[k].map, b: ws[k + 1].map, mix: (t - a) / (b - a) }
  }
  const last = ws[ws.length - 1].map
  return { a: last, b: last, mix: 0 }
}

// ---- Saving (.motorecomovie-body.bin next to the video. gzipped JSON header + arrays) ----

export const BODY_FILE_VERSION = 1

/** Pack the contents to save into one byte array (before gzip) */
export function encodeBodyTrack(track: BodyTrack, key: string): Uint8Array {
  const parts: Uint8Array[] = []
  const metaMaps = track.maps.map((c) => {
    const arrs = [c.m, c.w1, new Uint8Array(c.dx.buffer, c.dx.byteOffset, c.dx.byteLength), new Uint8Array(c.dy.buffer, c.dy.byteOffset, c.dy.byteLength)]
    if (c.fill) arrs.push(c.fill)
    for (const a of arrs) parts.push(a)
    return { x0: c.x0, w: c.w, fill: !!c.fill }
  })
  const head = new TextEncoder().encode(JSON.stringify({ version: BODY_FILE_VERSION, key, band: [BAND_W, BAND_H, BAND_STEP], windows: track.windows, maps: metaMaps }))
  const total = 4 + head.length + parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, head.length, true)
  out.set(head, 4)
  let o = 4 + head.length
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Inverse of encodeBodyTrack (null if the version, band size, or video key differ) */
export function decodeBodyTrack(buf: Uint8Array, key: string): BodyTrack | null {
  const hl = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true)
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl)))
  if (head.version !== BODY_FILE_VERSION || head.key !== key || head.band[0] !== BAND_W || head.band[1] !== BAND_H || head.band[2] !== BAND_STEP) return null
  let o = 4 + hl
  const take = (n: number): Uint8Array => {
    const a = buf.slice(o, o + n)
    o += n
    return a
  }
  const maps: BodyMapC[] = head.maps.map((mm: { x0: number; w: number; fill: boolean }) => {
    const n = mm.w * BAND_H
    const c: BodyMapC = { x0: mm.x0, w: mm.w, m: take(n), w1: take(n), dx: new Int16Array(take(n * 2).buffer), dy: new Int16Array(take(n * 2).buffer) }
    if (mm.fill) c.fill = take(n * 4)
    return c
  })
  return { windows: head.windows, maps }
}
