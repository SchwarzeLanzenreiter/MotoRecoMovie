// Following a point in the 360° video (place labels, core/annotations.ts). Around the point, a small square perspective crop is rendered,
// level with the horizon (so the patch does not turn when the bike leans), and the patch seen at the previous step is searched for in it by
// normalized cross-correlation. The patch is renewed a little every step, so it keeps up as the point grows nearer.
import type { Mat3 } from './quat'

/** Crop size [px] and patch size [px] */
export const CROP = 96
export const PATCH = 24

type V3 = [number, number, number]
const norm = (v: number[]): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Camera looking along dir with its down as close to `down` as possible. Row-major, columns = right, down, forward (camera -> rig) */
export function lookAt(dir: V3, down: V3): Mat3 {
  const f = norm(dir)
  let d = down
  const k0 = d[0] * f[0] + d[1] * f[1] + d[2] * f[2]
  // Looking almost straight down or up: any down across the view will do
  if (Math.abs(k0) > 0.99) d = Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const k = d[0] * f[0] + d[1] * f[1] + d[2] * f[2]
  const dn = norm([d[0] - k * f[0], d[1] - k * f[1], d[2] - k * f[2]])
  // right = down × forward
  const r: V3 = [dn[1] * f[2] - dn[2] * f[1], dn[2] * f[0] - dn[0] * f[2], dn[0] * f[1] - dn[1] * f[0]]
  return new Float64Array([r[0], dn[0], f[0], r[1], dn[1], f[1], r[2], dn[2], f[2]])
}

/** Focal length [px] of a crop of `size` px with a field of view of fov [deg] */
export const cropFocal = (size: number, fov: number): number => size / 2 / Math.tan((fov * Math.PI) / 360)

/** Direction (rig) of pixel (x, y) of a crop (pixel centers at integer + 0.5 are not assumed: x, y are measured from the top-left corner) */
export function cropPixelDir(cam: Mat3, size: number, fov: number, x: number, y: number): V3 {
  const f = cropFocal(size, fov)
  const cx = (x - size / 2) / f
  const cy = (y - size / 2) / f
  return norm([cam[0] * cx + cam[1] * cy + cam[2], cam[3] * cx + cam[4] * cy + cam[5], cam[6] * cx + cam[7] * cy + cam[8]])
}

/** Gray levels of an RGBA image */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, n: number): Float32Array {
  const g = new Float32Array(n)
  for (let p = 0; p < n; p++) g[p] = 0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2]
  return g
}

/** The patch × patch square of a size-wide gray image with its top-left corner at (x0, y0) */
export function cutPatch(img: Float32Array, size: number, x0: number, y0: number, patch = PATCH): Float32Array {
  const out = new Float32Array(patch * patch)
  for (let y = 0; y < patch; y++) out.set(img.subarray((y0 + y) * size + x0, (y0 + y) * size + x0 + patch), y * patch)
  return out
}

/**
 * Where the patch best matches in a size-wide gray image: the top-left corner (with a sub-pixel refinement) and the normalized cross-correlation
 * there (-1..1). A patch with no texture (flat sky) matches anywhere: its score is 0
 */
export function matchPatch(img: Float32Array, size: number, patch: Float32Array, p = PATCH): { x: number; y: number; score: number } {
  const n = p * p
  let mean = 0
  for (let k = 0; k < n; k++) mean += patch[k]
  mean /= n
  const t = new Float32Array(n)
  let tv = 0
  for (let k = 0; k < n; k++) {
    t[k] = patch[k] - mean
    tv += t[k] * t[k]
  }
  const m = size - p + 1
  const score = new Float32Array(m * m)
  if (tv < n * 4) return { x: (size - p) / 2, y: (size - p) / 2, score: 0 }
  // Sums over the window from integral images (mean and variance of the image under the patch)
  const W = size + 1
  const s1 = new Float64Array(W * W)
  const s2 = new Float64Array(W * W)
  for (let y = 0; y < size; y++) {
    let r1 = 0
    let r2 = 0
    for (let x = 0; x < size; x++) {
      const v = img[y * size + x]
      r1 += v
      r2 += v * v
      s1[(y + 1) * W + x + 1] = s1[y * W + x + 1] + r1
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + r2
    }
  }
  let best = -2
  let bx = 0
  let by = 0
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const a = y * W + x
      const b = (y + p) * W + x + p
      const sum = s1[b] - s1[a + p] - s1[b - p] + s1[a]
      const sq = s2[b] - s2[a + p] - s2[b - p] + s2[a]
      const iv = sq - (sum * sum) / n
      if (iv < 1e-6) continue
      let c = 0
      for (let j = 0; j < p; j++) {
        const row = (y + j) * size + x
        const tr = j * p
        for (let i = 0; i < p; i++) c += t[tr + i] * img[row + i]
      }
      const s = c / Math.sqrt(tv * iv)
      score[y * m + x] = s
      if (s > best) {
        best = s
        bx = x
        by = y
      }
    }
  }
  // Sub-pixel: a parabola through the neighbours in each direction
  const sub = (l: number, c: number, r: number): number => {
    const d = l - 2 * c + r
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d)) : 0
  }
  const at = (x: number, y: number): number => score[y * m + x]
  const dx = bx > 0 && bx < m - 1 ? sub(at(bx - 1, by), best, at(bx + 1, by)) : 0
  const dy = by > 0 && by < m - 1 ? sub(at(bx, by - 1), best, at(bx, by + 1)) : 0
  return { x: bx + dx, y: by + dy, score: best }
}

/** Field of view [deg] of the crop for a label placed in a view of fov [deg]: the patch covers about 1/20 of that view */
export function trackFov(viewFov: number): number {
  const patchDeg = Math.max(1.5, Math.min(8, viewFov / 20))
  return (patchDeg * CROP) / PATCH
}

/** Rounds a direction for storing in the project (5 decimals: about 0.0006°) */
export const roundDir = (v: number): number => Math.round(v * 1e5) / 1e5
