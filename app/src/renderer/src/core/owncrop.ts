// The square perspective crop around the own bike that the segmentation model looks at (core/segment.ts), and how its results map back to
// the sphere around the camera (rig coordinates). Shared by building the bike masks (engine/bikemask.ts) and drawing (render/compositor.ts)
import { maskAt, maskDir, MASK_H, MASK_W } from './bikemask'
import { COCO, MASK_FEAT, SEG_SIZE } from './segment'
import type { Mat3 } from './quat'

/** Classes that can be the own bike and its riders */
export const OWN_CLASSES = [COCO.person, COCO.bicycle, COCO.motorcycle]
/** Share of an instance's outline that has to lie where the bike and rider can be */
export const OWN_INSIDE = 0.5
/** Instances of the own bike and riders: lower score and looser overlap removal than for vehicles */
export const OWN_SCORE = 0.15
export const OWN_IOU = 0.9

/** Focal length of the crop [crop pixels] for a field of view [deg] (plain perspective) */
const cropFocal = (fov: number): number => SEG_SIZE / 2 / Math.tan((fov * Math.PI) / 360)

/** Camera looking along dir, upright with the bike (its down as close to the body's down as possible). Row-major, columns = right, down, forward */
export function cropCamera(dir: [number, number, number], body: Mat3): Mat3 {
  const f = dir
  // Body down (column 1), or body forward (column 2) when looking almost straight up or down
  let d = [body[1], body[4], body[7]]
  if (Math.abs(d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) > 0.95) d = [body[2], body[5], body[8]]
  const k = d[0] * f[0] + d[1] * f[1] + d[2] * f[2]
  d = [d[0] - k * f[0], d[1] - k * f[1], d[2] - k * f[2]]
  const l = Math.hypot(d[0], d[1], d[2])
  d = [d[0] / l, d[1] / l, d[2] / l]
  // right = down × forward
  const r = [d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]]
  return new Float64Array([r[0], d[0], f[0], r[1], d[1], f[1], r[2], d[2], f[2]])
}

/** A bike mask plane (env: where the bike and rider can be; core: where it surely is) on the crop's mask grid (MASK_FEAT square) */
export function planeInCrop(plane: Uint8Array, view: Mat3, fov: number): Uint8Array {
  const out = new Uint8Array(MASK_FEAT * MASK_FEAT)
  const fpx = cropFocal(fov)
  const step = SEG_SIZE / MASK_FEAT
  const V = view
  for (let gy = 0; gy < MASK_FEAT; gy++) {
    for (let gx = 0; gx < MASK_FEAT; gx++) {
      const x = ((gx + 0.5) * step - SEG_SIZE / 2) / fpx
      const y = ((gy + 0.5) * step - SEG_SIZE / 2) / fpx
      out[gy * MASK_FEAT + gx] = maskAt(plane, V[0] * x + V[1] * y + V[2], V[3] * x + V[4] * y + V[5], V[6] * x + V[7] * y + V[8]) >= 0.5 ? 1 : 0
    }
  }
  return out
}

/**
 * Count an outline in the crop (MASK_FEAT square probabilities, the instances joined) on the sphere: seen[p] += 1 where pixel p of the bike
 * mask grid lies inside the crop, hits[p] += 1 where the outline covers it
 */
export function outlineToSphere(outline: Float32Array, view: Mat3, fov: number, seen: Uint16Array, hits: Uint16Array): void {
  const fpx = cropFocal(fov)
  const V = view
  const n = MASK_FEAT
  const scale = n / SEG_SIZE
  for (let v = 0; v < MASK_H; v++) {
    for (let u = 0; u < MASK_W; u++) {
      const d = maskDir(u, v)
      // Into the crop camera: columns of V are its axes in rig coordinates
      const cx = V[0] * d[0] + V[3] * d[1] + V[6] * d[2]
      const cy = V[1] * d[0] + V[4] * d[1] + V[7] * d[2]
      const cz = V[2] * d[0] + V[5] * d[1] + V[8] * d[2]
      if (cz <= 0) continue
      const px = (cx / cz) * fpx + SEG_SIZE / 2
      const py = (cy / cz) * fpx + SEG_SIZE / 2
      if (px < 0 || py < 0 || px >= SEG_SIZE || py >= SEG_SIZE) continue
      const p = v * MASK_W + u
      seen[p]++
      // Bilinear on the outline grid
      const fx = Math.max(0, Math.min(n - 1.001, px * scale - 0.5))
      const fy = Math.max(0, Math.min(n - 1.001, py * scale - 0.5))
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      const a = outline[y0 * n + x0] * (1 - tx) + outline[y0 * n + x0 + 1] * tx
      const b = outline[(y0 + 1) * n + x0] * (1 - tx) + outline[(y0 + 1) * n + x0 + 1] * tx
      if (a * (1 - ty) + b * ty >= 0.5) hits[p]++
    }
  }
}
