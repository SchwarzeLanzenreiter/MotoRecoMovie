// Where the own bike and rider are on the sphere around the camera (rig coordinates), so that things drawn into the
// scenery (corner signs) can be hidden behind them. If the camera does not see the bike in some direction, nothing is hidden there.
//
// The camera is fixed to the bike, so the bike stays at about the same place in rig coordinates while the scenery moves.
// It is not exact: the fork steers, the suspension and the mount flex, so the bike wanders by a degree or so between frames.
// From keyframes spread over a stretch of the video (equirectangular luminance of the whole sphere, 0.7 degrees per pixel, slightly blurred):
//   1. median image M of the frames
//   2. per frame, local normalized cross-correlation (9x9) with M, the best within +-2 pixels. A textured pixel that matches M
//      in most frames is part of the bike; one that rarely matches is scenery
//   3. flat pixels (sky, smooth fairing) say nothing by themselves: scenery is flood-filled from the moving pixels through everything
//      that is not near bike texture, and what the flood cannot reach (flat parts enclosed by the bike's outline) is bike too
//   4. small parts are dropped; flat unchanging pixels next to the bike are added, gaps in the outline closed and holes filled;
//      with several stretches, parts not seen in a neighbouring stretch too are dropped (lens flare, a cloud
//      bank that stayed in the same direction for a while)
// Frames taken while stopped are left out by the caller (the scenery would look still).

/** Size of the equirectangular mask (0.7 degrees per pixel) */
export const MASK_W = 512
export const MASK_H = 256
/** Size of one cube face rendered to build the mask */
export const FACE = 384
/** Length of the stretch of video one mask is built from [s] (the camera mount can turn slowly, a few degrees in 10 minutes) */
export const MASK_WINDOW_SEC = 300

const R = 4 // NCC window radius
const SHIFT = 2 // tolerated wander of the bike [pixels]
const NCC_MATCH = 0.8
const STATIC_FRAC = 0.7
const MOVING_FRAC = 0.4
const TEX_STD = 5 // gray levels: below this the median image is flat (no texture to match)
const WALL = 3 // radius around bike texture that the scenery flood does not enter [pixels]
const MIN_PART = 150 // bike parts smaller than this [pixels] are dropped
const NEIGHBOUR = 4 // how far a part may move between neighbouring stretches [pixels]
const MAX_HOLE = 2000 // holes inside the bike up to this size [pixels] are filled
const MAX_ENCLOSED = 6000 // flat areas enclosed by bike texture up to this size [pixels] are bike (about 3000 square degrees)
const SIDEWAYS = 48 // texture that matches itself shifted this far to either side [pixels, about 34 degrees] is not taken as bike (longer than any bike edge)
const CLOSE = 3 // gaps in the outline up to about twice this [pixels] are closed
const NEAR_STABLE = 8 // how far from the bike a flat, unchanging pixel is still taken as bike [pixels]
const STABLE_DIFF = 10 // gray levels
const STABLE_FRAC = 0.85

/** Rig direction of a mask pixel center (x right, y down, z forward of the rig; unit vector) */
export function maskDir(u: number, v: number, w = MASK_W, h = MASK_H): [number, number, number] {
  const lon = ((u + 0.5) / w - 0.5) * 2 * Math.PI
  const lat = (0.5 - (v + 0.5) / h) * Math.PI
  const c = Math.cos(lat)
  return [c * Math.sin(lon), -Math.sin(lat), c * Math.cos(lon)]
}

/** Mask value (0 = scenery, 1 = bike) in a rig direction, bilinear (soft edge) */
export function maskAt(mask: Uint8Array, x: number, y: number, z: number): number {
  const lon = Math.atan2(x, z)
  const lat = Math.atan2(-y, Math.hypot(x, z))
  const fu = (lon / (2 * Math.PI) + 0.5) * MASK_W - 0.5
  const fv = (0.5 - lat / Math.PI) * MASK_H - 0.5
  const u0 = Math.floor(fu)
  const v0 = Math.max(0, Math.min(MASK_H - 2, Math.floor(fv)))
  const a = fu - u0
  const b = Math.max(0, Math.min(1, fv - v0))
  const ua = ((u0 % MASK_W) + MASK_W) % MASK_W
  const ub = (ua + 1) % MASK_W
  const r0 = v0 * MASK_W
  const r1 = r0 + MASK_W
  return ((mask[r0 + ua] * (1 - a) + mask[r0 + ub] * a) * (1 - b) + (mask[r1 + ua] * (1 - a) + mask[r1 + ub] * a) * b) / 255
}

/**
 * Cube faces as cameras (row-major; columns = the camera's right, down and forward in rig coordinates), 90 degrees each.
 * Order: forward, right, back, left, up, down
 */
export const CUBE_FACES: number[][] = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 1, 0, 1, 0, -1, 0, 0],
  [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  [0, 0, -1, 0, 1, 0, 1, 0, 0],
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [1, 0, 0, 0, 0, 1, 0, -1, 0]
]

/** The faces are sampled at twice the mask resolution and averaged 2x2 */
const SW = MASK_W * 2
const SH = MASK_H * 2
let lut: Uint32Array | null = null
/** For each sample, the index of the matching pixel in the 6 stacked faces (face k occupies rows k*FACE..; rows top-down) */
function cubeLut(): Uint32Array {
  if (lut) return lut
  lut = new Uint32Array(SW * SH)
  const f = FACE / 2
  for (let v = 0; v < SH; v++) {
    for (let u = 0; u < SW; u++) {
      const d = maskDir(u, v, SW, SH)
      let best = 0
      let bz = -Infinity
      for (let k = 0; k < 6; k++) {
        const M = CUBE_FACES[k]
        const z = M[2] * d[0] + M[5] * d[1] + M[8] * d[2]
        if (z > bz) {
          bz = z
          best = k
        }
      }
      const M = CUBE_FACES[best]
      const x = M[0] * d[0] + M[3] * d[1] + M[6] * d[2]
      const y = M[1] * d[0] + M[4] * d[1] + M[7] * d[2]
      const px = Math.max(0, Math.min(FACE - 1, Math.floor(f + (f * x) / bz)))
      const py = Math.max(0, Math.min(FACE - 1, Math.floor(f + (f * y) / bz)))
      lut[v * SW + u] = (best * FACE + py) * FACE + px
    }
  }
  return lut
}

/** Equirectangular color image (MASK_W x MASK_H, RGB) from the 6 stacked RGBA faces (FACE x 6*FACE, rows top-down) */
export function facesToEquirectRgb(faces: Uint8Array): Uint8Array {
  const L = cubeLut()
  const out = new Uint8Array(MASK_W * MASK_H * 3)
  for (let v = 0; v < MASK_H; v++) {
    for (let u = 0; u < MASK_W; u++) {
      let r = 0
      let g = 0
      let b = 0
      for (let k = 0; k < 4; k++) {
        const q = L[(2 * v + (k >> 1)) * SW + 2 * u + (k & 1)] * 4
        r += faces[q]
        g += faces[q + 1]
        b += faces[q + 2]
      }
      const o = (v * MASK_W + u) * 3
      out[o] = r >> 2
      out[o + 1] = g >> 2
      out[o + 2] = b >> 2
    }
  }
  return out
}


/**
 * Mean absolute difference (green) of two equirectangular color images on a coarse grid, above about 20 degrees of elevation (to leave out
 * frames taken while stopped: the trees and sky overhead change while riding; below, the rider walking around the parked bike would change the picture)
 */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
  let s = 0
  let n = 0
  for (let v = 2; v < MASK_H * 0.38; v += 4) {
    for (let u = 2; u < MASK_W; u += 4) {
      const o = (v * MASK_W + u) * 3 + 1
      s += Math.abs(a[o] - b[o])
      n++
    }
  }
  return s / n
}

const W = MASK_W
const H = MASK_H
const wrapU = (u: number): number => ((u % W) + W) % W
const clampV = (v: number): number => Math.max(0, Math.min(H - 1, v))

/** Box sum over (2r+1)^2 with wrap-around in longitude and clamping at the poles */
function boxSum(src: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(W * H)
  for (let v = 0; v < H; v++) {
    const row = v * W
    let s = 0
    for (let k = -r; k <= r; k++) s += src[row + wrapU(k)]
    for (let u = 0; u < W; u++) {
      tmp[row + u] = s
      s += src[row + wrapU(u + r + 1)] - src[row + wrapU(u - r)]
    }
  }
  const out = new Float32Array(W * H)
  for (let u = 0; u < W; u++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += tmp[clampV(k) * W + u]
    for (let v = 0; v < H; v++) {
      out[v * W + u] = s
      s += tmp[clampV(v + r + 1) * W + u] - tmp[clampV(v - r) * W + u]
    }
  }
  return out
}

/** Light blur (1 4 6 4 1) / 16 in both directions */
function blur(src: Uint8Array): Float32Array {
  const k = [1, 4, 6, 4, 1]
  const tmp = new Float32Array(W * H)
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    let s = 0
    for (let j = -2; j <= 2; j++) s += k[j + 2] * src[v * W + wrapU(u + j)]
    tmp[v * W + u] = s / 16
  }
  const out = new Float32Array(W * H)
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    let s = 0
    for (let j = -2; j <= 2; j++) s += k[j + 2] * tmp[clampV(v + j) * W + u]
    out[v * W + u] = s / 16
  }
  return out
}

/** a shifted by (du, dv): out[v][u] = a[v - dv][u - du] (wrap in longitude, clamp at the poles) */
function shifted(a: Float32Array, du: number, dv: number, out: Float32Array): Float32Array {
  for (let v = 0; v < H; v++) {
    const sv = clampV(v - dv) * W
    for (let u = 0; u < W; u++) out[v * W + u] = a[sv + wrapU(u - du)]
  }
  return out
}

/** Disk-shaped dilation */
function dilate(m: Uint8Array, r: number): Uint8Array {
  const out = new Uint8Array(W * H)
  const offs: [number, number][] = []
  for (let dv = -r; dv <= r; dv++) for (let du = -r; du <= r; du++) if (du * du + dv * dv <= r * r) offs.push([du, dv])
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      if (!m[v * W + u]) continue
      for (const [du, dv] of offs) {
        const vv = v + dv
        if (vv >= 0 && vv < H) out[vv * W + wrapU(u + du)] = 1
      }
    }
  }
  return out
}

/** Half width of the band along the lens seam whose still texture is not taken as the bike (sin of about 4 degrees) */
const SEAM_BAND = 0.07

/**
 * Whether mask pixel p lies on the seam between the two lenses (the great circle 90 degrees from seamAx, the lens 0 axis). The blend of
 * the two lenses leaves marks there that stay put in rig coordinates like the bike does (with the camera held behind the rider, the seam
 * runs over the rider's head)
 */
function onSeam(p: number, ax: ArrayLike<number>): boolean {
  const v = (p / W) | 0
  const d = maskDir(p - v * W, v)
  return Math.abs(d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) < SEAM_BAND
}

/** Disk-shaped erosion */
function erode(m: Uint8Array, r: number): Uint8Array {
  const inv = new Uint8Array(W * H)
  for (let p = 0; p < W * H; p++) inv[p] = m[p] ? 0 : 1
  const d = dilate(inv, r)
  for (let p = 0; p < W * H; p++) d[p] = d[p] ? 0 : 1
  return d
}

/** Connected parts (4-neighbour, wrap in longitude) of the set pixels; calls keep(pixels) for each and clears those it rejects */
function filterParts(m: Uint8Array, keep: (part: number[]) => boolean): void {
  const seen = new Uint8Array(W * H)
  const stack: number[] = []
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!m[p0] || seen[p0]) continue
    const part: number[] = []
    seen[p0] = 1
    stack.push(p0)
    while (stack.length) {
      const p = stack.pop()!
      part.push(p)
      const v = (p / W) | 0
      const u = p - v * W
      for (const q of [v * W + wrapU(u + 1), v * W + wrapU(u - 1), v > 0 ? p - W : -1, v < H - 1 ? p + W : -1]) {
        if (q < 0 || !m[q] || seen[q]) continue
        seen[q] = 1
        stack.push(q)
      }
    }
    if (!keep(part)) for (const p of part) m[p] = 0
  }
}

/**
 * The part that is surely the bike (0 or 255 per pixel, MASK_W x MASK_H) from equirectangular luminance images of keyframes (taken while moving).
 * Returns null if there are too few frames to tell the bike from the scenery
 */
function buildCore(frames: Uint8Array[], seamAx?: ArrayLike<number>, stage?: Stage): { core: Uint8Array; texture: Uint8Array } | null {
  const K = frames.length
  if (K < 8) return null
  const N = W * H
  const n = (2 * R + 1) ** 2
  const F = frames.map(blur)
  // 1. Median image
  const med = new Float32Array(N)
  const col = new Float32Array(K)
  for (let p = 0; p < N; p++) {
    for (let k = 0; k < K; k++) col[k] = F[k][p]
    col.sort()
    med[p] = col[K >> 1]
  }
  const mS = boxSum(med, R)
  const mQ = boxSum(med.map((x) => x * x), R)
  const mVar = new Float32Array(N)
  for (let p = 0; p < N; p++) mVar[p] = Math.max(0, mQ[p] / n - (mS[p] / n) ** 2)
  // 2. In how many frames each pixel matches the median image (best within the tolerated wander)
  const hits = new Uint16Array(N)
  const best = new Float32Array(N)
  const g = new Float32Array(N)
  const gm = new Float32Array(N)
  for (const f of F) {
    // Box sums of the shifted frame are the shifted box sums of the frame
    const fS = boxSum(f, R)
    const fQ = boxSum(f.map((x) => x * x), R)
    const fVar = new Float32Array(N)
    for (let p = 0; p < N; p++) fVar[p] = Math.max(0, fQ[p] / n - (fS[p] / n) ** 2)
    const sS = new Float32Array(N)
    const sVar = new Float32Array(N)
    best.fill(-1)
    for (let dv = -SHIFT; dv <= SHIFT; dv++) {
      for (let du = -SHIFT; du <= SHIFT; du++) {
        shifted(f, du, dv, g)
        shifted(fS, du, dv, sS)
        shifted(fVar, du, dv, sVar)
        for (let p = 0; p < N; p++) gm[p] = g[p] * med[p]
        const c = boxSum(gm, R)
        for (let p = 0; p < N; p++) {
          const cov = c[p] / n - (sS[p] / n) * (mS[p] / n)
          const ncc = cov / Math.sqrt(Math.max(1e-6, sVar[p] * mVar[p]))
          if (ncc > best[p]) best[p] = ncc
        }
      }
    }
    for (let p = 0; p < N; p++) if (best[p] > NCC_MATCH) hits[p]++
  }
  // 3. Bike texture and moving scenery texture; scenery = flood from the moving pixels outside the wall around the bike texture
  // Texture that looks the same shifted far sideways (a level horizon on a straight road over flat land stays put in every frame)
  // tells nothing about the bike
  const sideways = new Uint8Array(N)
  {
    const g = new Float32Array(N)
    const sS = new Float32Array(N)
    const sVar = new Float32Array(N)
    for (const du of [-SIDEWAYS, SIDEWAYS]) {
      shifted(med, du, 0, g)
      shifted(mS, du, 0, sS)
      shifted(mVar, du, 0, sVar)
      for (let p = 0; p < N; p++) gm[p] = g[p] * med[p]
      const c = boxSum(gm, R)
      for (let p = 0; p < N; p++) {
        const cov = c[p] / n - (sS[p] / n) * (mS[p] / n)
        if (cov / Math.sqrt(Math.max(1e-6, sVar[p] * mVar[p])) > NCC_MATCH) sideways[p] = 1
      }
    }
  }
  const tex2 = TEX_STD * TEX_STD
  const bike = new Uint8Array(N)
  const moving = new Uint8Array(N)
  for (let p = 0; p < N; p++) {
    if (mVar[p] < tex2) continue
    const fr = hits[p] / K
    if (fr >= STATIC_FRAC) {
      if (!sideways[p] && !(seamAx && onSeam(p, seamAx))) bike[p] = 1
    } else if (fr < MOVING_FRAC) moving[p] = 1
  }
  const wall = dilate(bike, WALL)
  const scenery = new Uint8Array(N)
  const stack: number[] = []
  for (let p = 0; p < N; p++) {
    if (moving[p] && !wall[p]) {
      scenery[p] = 1
      stack.push(p)
    }
  }
  while (stack.length) {
    const p = stack.pop()!
    const v = (p / W) | 0
    const u = p - v * W
    for (const q of [v * W + wrapU(u + 1), v * W + wrapU(u - 1), v > 0 ? p - W : -1, v < H - 1 ? p + W : -1]) {
      if (q < 0 || scenery[q] || wall[q]) continue
      scenery[q] = 1
      stack.push(q)
    }
  }
  // Not reached by the scenery, minus the wall where it borders the scenery (the wall reaches past the bike's outline).
  // Only enclosed areas of bike size count: a large one (the sky above a horizon taken for the bike) is not the bike
  const near = dilate(scenery, WALL)
  const enclosed = new Uint8Array(N)
  for (let p = 0; p < N; p++) if (!bike[p] && !scenery[p] && !near[p]) enclosed[p] = 1
  filterParts(enclosed, (part) => part.length <= MAX_ENCLOSED)
  const mask = new Uint8Array(N)
  for (let p = 0; p < N; p++) if (bike[p] || enclosed[p]) mask[p] = 1
  stage?.('1 texture that stays put', bike)
  stage?.('2 + flat areas enclosed by it', mask)
  // 4. Small parts. Small holes inside the bike (headlight reflections and the like flicker, so they look like scenery) are filled,
  // and the outline is widened by a pixel so the edge of a sign does not show along it
  filterParts(mask, (part) => part.length >= MIN_PART)
  // Flat parts of the bike that the flood reached through a gap in the outline: next to the bike, a pixel that keeps the same
  // brightness in nearly every frame is bike (flat scenery such as the sky or the road changes with the heading)
  stage?.('3 small parts dropped', mask)
  const around = dilate(mask, NEAR_STABLE)
  for (let p = 0; p < N; p++) {
    if (mask[p] || !around[p]) continue
    let c = 0
    for (let k = 0; k < K; k++) if (Math.abs(F[k][p] - med[p]) < STABLE_DIFF) c++
    if (c >= STABLE_FRAC * K) mask[p] = 1
  }
  // Close small gaps in the outline, then fill the holes inside
  stage?.('4 + unchanging flat pixels next to it', mask)
  const closed = erode(dilate(mask, CLOSE), CLOSE)
  const holes = new Uint8Array(N)
  for (let p = 0; p < N; p++) holes[p] = closed[p] ? 0 : 1
  filterParts(holes, (part) => part.length > MAX_HOLE)
  const filled = new Uint8Array(N)
  for (let p = 0; p < N; p++) filled[p] = mask[p] || closed[p] || !holes[p] ? 1 : 0
  stage?.('5 gaps closed, holes filled', filled)
  const out = dilate(filled, 1)
  for (let p = 0; p < N; p++) out[p] *= 255
  // texture: the bike texture away from its outline (the colors of the bike for the color table: the matching window reaches R pixels
  // past the outline, and the core also takes in still flat pixels next to it, such as the sky)
  return { core: out, texture: erode(bike, R) }
}

/** For checking: receives the intermediate planes of buildBikeMask (MASK_W x MASK_H, nonzero = set) */
export type Stage = (name: string, plane: Uint8Array) => void

/** Own bike of one stretch of video */
export interface BikeMask {
  /** Surely the bike (0 / 255, MASK_W x MASK_H): what stays in place */
  core: Uint8Array
  /** Where the bike and rider can be (0 / 255): around the core, where the frames often show bike colors. Inside it, each frame's
   * own colors decide (the rider moves, so the core covers only part of them) */
  env: Uint8Array
  /** Likelihood that a color is the bike or rider (0..255), LUT_N^3 bins, index lutIndex(r, g, b) */
  lut: Uint8Array
}

/** Bins per channel of the color table */
export const LUT_N = 16
/** Bin of a color (red changes fastest, then green, then blue: the layout of a 3D texture with s = red, t = green, r = blue) */
export const lutIndex = (r: number, g: number, b: number): number => ((b >> 4) << 8) | ((g >> 4) << 4) | (r >> 4)

const SCENERY_FROM = 30 // pixels this far from the core are scenery samples for the color table
// Colors seen on both count as scenery unless clearly more common on the bike (an aluminum case and an overcast sky, dark trees and a black
// jacket): the sure part of the bike is cut out by the core anyway, the colors only have to find the dark rider
const SCENERY_WEIGHT = 4
const ENV_REACH = 30 // how far from the core the bike and rider can reach [pixels]
const ENV_OFTEN = 0.3 // a pixel shows bike colors in at least this share of the frames (the rider's head moves; the sky is blue most of the time)
const ENV_MARGIN = 10 // margin around them (the rider moves) [pixels]
const SEED_ROWS = 0.85 // the core below this fraction of the height (the camera mount at the nadir) does not start the envelope
const CORE_SHRINK = 4 // the edge of the core this wide [pixels] is kept only where its median color is a bike color
const EDGE_COLOR = 64 // color table value above which the median color counts as a bike color

/** City-block distance (capped at 255) from the set pixels, with wrap-around in longitude */
function distanceFrom(m: Uint8Array): Uint8Array {
  const d = new Uint8Array(W * H).fill(255)
  const q: number[] = []
  for (let p = 0; p < W * H; p++) {
    if (m[p]) {
      d[p] = 0
      q.push(p)
    }
  }
  for (let i = 0; i < q.length; i++) {
    const p = q[i]
    if (d[p] >= 254) continue
    const v = (p / W) | 0
    const u = p - v * W
    for (const nb of [v * W + wrapU(u + 1), v * W + wrapU(u - 1), v > 0 ? p - W : -1, v < H - 1 ? p + W : -1]) {
      if (nb < 0 || d[nb] <= d[p] + 1) continue
      d[nb] = d[p] + 1
      q.push(nb)
    }
  }
  return d
}

/**
 * Own bike of a stretch from equirectangular color images (RGB, MASK_W x MASK_H) of keyframes taken while moving.
 * seamAx: the lens 0 optical axis in rig coordinates (seamBasis in core/seamfit.ts), to ignore the marks along the lens seam.
 * Returns null if there are too few frames
 */
export function buildBikeMask(frames: Uint8Array[], seamAx?: ArrayLike<number>, stage?: Stage): BikeMask | null {
  const N = W * H
  const lum = frames.map((f) => {
    const y = new Uint8Array(N)
    for (let p = 0; p < N; p++) y[p] = (f[p * 3] * 77 + f[p * 3 + 1] * 150 + f[p * 3 + 2] * 29) >> 8
    return y
  })
  const built = buildCore(lum, seamAx, stage)
  if (!built) return null
  const { core, texture } = built
  // Color table: colors seen on the bike texture against colors seen well away from the core
  stage?.("6 core (handed out, before trimming its edge)", core)
  const dist = distanceFrom(core)
  const hb = new Float64Array(LUT_N ** 3)
  const hs = new Float64Array(LUT_N ** 3)
  for (const f of frames) {
    for (let p = 0; p < N; p++) {
      const i = lutIndex(f[p * 3], f[p * 3 + 1], f[p * 3 + 2])
      if (texture[p] && core[p]) hb[i]++
      else if (dist[p] > SCENERY_FROM) hs[i]++
    }
  }
  const nb = hb.reduce((a, x) => a + x, 0) || 1
  const ns = hs.reduce((a, x) => a + x, 0) || 1
  const lut = new Uint8Array(LUT_N ** 3)
  for (let i = 0; i < lut.length; i++) {
    const b = hb[i] / nb
    const s = hs[i] / ns
    lut[i] = b + s > 0 ? Math.round((255 * b) / (b + SCENERY_WEIGHT * s)) : 0
  }
  // Envelope: from the core (not the camera mount at the nadir), through pixels that show bike colors in enough of the frames, then a margin
  const often = new Uint8Array(N)
  for (const f of frames) for (let p = 0; p < N; p++) if (lut[lutIndex(f[p * 3], f[p * 3 + 1], f[p * 3 + 2])] >= 128) often[p]++
  const minOften = Math.ceil(ENV_OFTEN * frames.length)
  const seed = new Uint8Array(N)
  for (let p = 0; p < N * SEED_ROWS; p++) seed[p] = core[p] ? 1 : 0
  const reach = distanceFrom(seed)
  const env = new Uint8Array(N)
  const stack: number[] = []
  for (let p = 0; p < N; p++) {
    if (seed[p]) {
      env[p] = 1
      stack.push(p)
    }
  }
  while (stack.length) {
    const p = stack.pop()!
    const v = (p / W) | 0
    const u = p - v * W
    for (const q of [v * W + wrapU(u + 1), v * W + wrapU(u - 1), v > 0 ? p - W : -1, v < H - 1 ? p + W : -1]) {
      if (q < 0 || env[q] || reach[q] >= ENV_REACH || often[q] < minOften) continue
      env[q] = 1
      stack.push(q)
    }
  }
  stage?.('7 env: grown through frequent bike colors', env)
  const envOut = dilate(env, ENV_MARGIN)
  for (let p = 0; p < N; p++) envOut[p] = envOut[p] || core[p] ? 255 : 0
  // The core reaches past the bike's outline by the matching window, the tolerated wander and the blur: around thin parts (mirrors,
  // handlebars) it would stick out into the sky by several degrees. Near its edge, keep only pixels whose usual (median) color is a bike
  // color; the envelope and each frame's colors cover the rest of the outline
  stage?.('8 env: + margin', envOut)
  const inner = erode(core, CORE_SHRINK)
  const K = frames.length
  const col = new Uint8Array(K)
  const med = (p: number, c: number): number => {
    for (let k = 0; k < K; k++) col[k] = frames[k][p * 3 + c]
    col.sort()
    return col[K >> 1]
  }
  const sure = new Uint8Array(N)
  for (let p = 0; p < N; p++) {
    if (inner[p]) sure[p] = 255
    else if (core[p] && lut[lutIndex(med(p, 0), med(p, 1), med(p, 2))] >= EDGE_COLOR) sure[p] = 255
  }
  return { core: sure, env: envOut, lut }
}

/**
 * Keep only the parts of each stretch's core that a neighbouring stretch also has (the bike is there all the time; a lens flare or a cloud
 * that stayed put is not), and the parts of the envelope that still hold some core. Modified in place; with one stretch nothing changes
 */
export function keepConsistent(masks: (BikeMask | null)[]): void {
  const near = masks.map((m) => (m ? dilate(m.core, NEIGHBOUR) : null))
  const out = masks.map((m) => (m ? m.core.slice() : null))
  masks.forEach((m, i) => {
    if (!m) return
    const nb = [near[i - 1], near[i + 1]].filter((x): x is Uint8Array => !!x)
    if (!nb.length) return
    const o = out[i]!
    // A part survives if at least a third of it is covered by a neighbour
    filterParts(o, (part) => {
      let c = 0
      for (const p of part) if (nb.some((x) => x[p])) c++
      return c * 3 >= part.length
    })
  })
  masks.forEach((m, i) => {
    if (!m) return
    m.core.set(out[i]!)
    filterParts(m.env, (part) => part.some((p) => m.core[p]))
  })
}

/** Masks for stretches of the video */
export interface BikeMaskTrack {
  windows: { t0: number; t1: number; mask: number }[]
  masks: BikeMask[]
}

/** Mask for time t (that of the nearest stretch that has one) */
export function bikeMaskAt(tr: BikeMaskTrack, t: number): BikeMask | null {
  let best: BikeMask | null = null
  let bd = Infinity
  for (const w of tr.windows) {
    if (w.mask < 0) continue
    const d = t < w.t0 ? w.t0 - t : t > w.t1 ? t - w.t1 : 0
    if (d < bd) {
      bd = d
      best = tr.masks[w.mask]
    }
  }
  return best
}

const MAGIC = 0x4d4b4232 // "MKB2"
const BITS = (MASK_W * MASK_H) / 8
const MASK_BYTES = 2 * BITS + LUT_N ** 3

/** Binary form (header + windows + per mask: core and envelope as one bit per pixel, then the color table) */
export function encodeBikeMasks(tr: BikeMaskTrack, key: string): Uint8Array {
  const keyBytes = new TextEncoder().encode(key)
  const head = 12 + keyBytes.length + tr.windows.length * 12
  const out = new Uint8Array(head + tr.masks.length * MASK_BYTES)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC)
  dv.setUint16(4, keyBytes.length)
  dv.setUint16(6, tr.windows.length)
  dv.setUint16(8, tr.masks.length)
  out.set(keyBytes, 12)
  let o = 12 + keyBytes.length
  for (const w of tr.windows) {
    dv.setFloat32(o, w.t0)
    dv.setFloat32(o + 4, w.t1)
    dv.setInt32(o + 8, w.mask)
    o += 12
  }
  for (const m of tr.masks) {
    for (const plane of [m.core, m.env]) {
      for (let p = 0; p < plane.length; p++) if (plane[p]) out[o + (p >> 3)] |= 1 << (p & 7)
      o += BITS
    }
    out.set(m.lut, o)
    o += m.lut.length
  }
  return out
}

/** Read back encodeBikeMasks (null if it is for another video or another version) */
export function decodeBikeMasks(b: Uint8Array, key: string): BikeMaskTrack | null {
  if (b.length < 12) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(0) !== MAGIC) return null
  const kl = dv.getUint16(4)
  const nw = dv.getUint16(6)
  const nm = dv.getUint16(8)
  if (new TextDecoder().decode(b.subarray(12, 12 + kl)) !== key) return null
  let o = 12 + kl
  const windows: BikeMaskTrack['windows'] = []
  for (let i = 0; i < nw; i++) {
    windows.push({ t0: dv.getFloat32(o), t1: dv.getFloat32(o + 4), mask: dv.getInt32(o + 8) })
    o += 12
  }
  if (b.length < o + nm * MASK_BYTES) return null
  const masks: BikeMask[] = []
  for (let i = 0; i < nm; i++) {
    const planes = [0, 1].map(() => {
      const m = new Uint8Array(MASK_W * MASK_H)
      for (let p = 0; p < m.length; p++) if (b[o + (p >> 3)] & (1 << (p & 7))) m[p] = 255
      o += BITS
      return m
    })
    const lut = b.slice(o, o + LUT_N ** 3)
    o += LUT_N ** 3
    masks.push({ core: planes[0], env: planes[1], lut })
  }
  return { windows, masks }
}

/**
 * Where to look for the own bike and rider with the segmentation model: the main part of the envelope (the largest connected part above the
 * camera mount at the nadir; stray small parts elsewhere would widen the crop and coarsen the outline), its mean direction (rig coordinates,
 * unit vector) and the field of view that holds it with a margin [deg]. null when the camera does not see the bike
 */
export function bikeCrop(m: BikeMask): { dir: [number, number, number]; fov: number } | null {
  const main = new Uint8Array(W * H)
  for (let p = 0; p < W * H * SEED_ROWS; p++) main[p] = m.env[p] ? 1 : 0
  // Solid angle of a pixel (rows near the poles are short)
  const weight = (p: number): number => Math.cos(((((p / W) | 0) + 0.5) / H - 0.5) * Math.PI)
  let best = 0
  filterParts(main, (part) => {
    best = Math.max(best, part.reduce((a, p) => a + weight(p), 0))
    return true
  })
  filterParts(main, (part) => part.reduce((a, p) => a + weight(p), 0) >= best)
  let sx = 0
  let sy = 0
  let sz = 0
  let n = 0
  for (let p = 0; p < W * H; p++) {
    if (!main[p]) continue
    const v = (p / W) | 0
    const d = maskDir(p - v * W, v)
    const w = weight(p)
    sx += d[0] * w
    sy += d[1] * w
    sz += d[2] * w
    n++
  }
  if (n < MIN_PART) return null
  const l = Math.hypot(sx, sy, sz)
  if (l < 1e-6) return null
  const dir: [number, number, number] = [sx / l, sy / l, sz / l]
  // Angle from the center that holds most of the part (thin arms of the envelope reaching far out are left outside the crop)
  const ang: [number, number][] = []
  let total = 0
  for (let p = 0; p < W * H; p++) {
    if (!main[p]) continue
    const v = (p / W) | 0
    const d = maskDir(p - v * W, v)
    const w = weight(p)
    ang.push([Math.acos(Math.max(-1, Math.min(1, d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]))), w])
    total += w
  }
  ang.sort((x, y) => x[0] - y[0])
  let acc = 0
  let maxA = 0
  for (const [a, w] of ang) {
    acc += w
    maxA = a
    if (acc >= CROP_SHARE * total) break
  }
  // The crop is a square perspective view: the half angle to its corner is larger than to the edge, so the edge has to reach maxA
  const fov = Math.min(CROP_FOV_MAX, Math.max(CROP_FOV_MIN, (2 * maxA * 180) / Math.PI + CROP_MARGIN))
  return { dir, fov }
}

const CROP_FOV_MIN = 40
const CROP_FOV_MAX = 140
const CROP_MARGIN = 10
const CROP_SHARE = 0.92

/** Share of the frames in which the segmentation model's outline of the own bike covers a pixel: sure part, and where it can be */
const AI_CORE_SHARE = 0.6
const AI_ENV_SHARE = 0.15
/** Margin added around where the bike and rider can be (the rider moves a little more than the frames show) [pixels] */
const AI_ENV_MARGIN = 2

/**
 * The bike masks from the segmentation model's outlines counted over the frames of a stretch (owncrop.ts outlineToSphere): seen = frames in
 * which a pixel was inside the crop, hits = frames in which the outline covered it. null if there is too little to go by
 */
export function masksFromCounts(seen: Uint16Array, hits: Uint16Array, runs: number): { core: Uint8Array; env: Uint8Array } | null {
  const N = W * H
  const core = new Uint8Array(N)
  const env = new Uint8Array(N)
  for (let p = 0; p < N; p++) {
    if (seen[p] < runs * 0.5) continue
    if (hits[p] >= AI_CORE_SHARE * seen[p]) core[p] = 1
    if (hits[p] >= Math.max(1, AI_ENV_SHARE * seen[p])) env[p] = 1
  }
  filterParts(core, (part) => part.length >= MIN_PART / 4)
  if (!core.some((v) => v)) return null
  const grown = dilate(env, AI_ENV_MARGIN)
  for (let p = 0; p < N; p++) if (core[p]) grown[p] = 1
  // Only what connects to the sure part
  filterParts(grown, (part) => part.some((p) => core[p]))
  for (let p = 0; p < N; p++) {
    core[p] = core[p] ? 255 : 0
    grown[p] = grown[p] ? 255 : 0
  }
  return { core, env: grown }
}
