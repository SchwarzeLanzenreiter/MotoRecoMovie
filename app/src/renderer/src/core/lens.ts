// Insta360 lens model (Mei unified sphere + 13-term RadtanPro distortion).
// Rig coordinates: +x right, +y down, +z forward (lens 0 optical axis). See docs/insv-x6-format.md for details.
import type { Calibration } from './insv'
import { matMul, matT, type Mat3 } from './quat'

const rx = (a: number): Mat3 => new Float64Array([1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)])
const ry = (a: number): Mat3 => new Float64Array([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)])
const rz = (a: number): Mat3 => new Float64Array([Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1])

/** Manufacturer-defined world→camera rotation */
function vendorRotation(yprDeg: [number, number, number], lensIndex: number, numLenses: number): Mat3 {
  const [yaw, pitch, roll] = yprDeg.map((v) => (v * Math.PI) / 180)
  let r = matMul(matMul(ry(pitch + Math.PI / 2), rz(yaw)), rx(roll))
  if (lensIndex === 0 && numLenses === 2) r = matMul(r, rz(Math.PI))
  return r
}

export interface LensModel {
  xi: number
  fx: number
  fy: number
  cx: number // principal point in image (picture) coordinates
  cy: number
  d: Float64Array
  /** Uniform scale from calibration space → image */
  scale: number
  /** Ray in rig coordinates → ray in camera coordinates */
  camFromRig: Mat3
  pictureSize: number
  /**
   * Edge angle correction [rad] (seam fitting, core/seamfit.ts). Projects the angle θ from the optical axis as
   * θ + edge·(θ/90°)³ (the center is nearly unchanged; the effect grows toward the edge)
   */
  edge?: number
  /** Lens position [m] (rig coordinates; the midpoint of the 2 lenses is the origin). Used for seam parallax correction */
  pos: [number, number, number]
}

/** Applies the edge angle correction to a ray in camera coordinates (same formula as the shader's projectLens) */
export function edgeCorrect(c: [number, number, number], edge: number): [number, number, number] {
  if (!edge) return c
  const n = Math.hypot(c[0], c[1], c[2])
  const z = c[2] / n
  const rxy = Math.hypot(c[0], c[1]) / n
  if (rxy < 1e-9) return c
  const t = Math.acos(Math.max(-1, Math.min(1, z)))
  const t2 = t + edge * (t / (Math.PI / 2)) ** 3
  const k = Math.sin(t2) / rxy / n
  return [c[0] * k, c[1] * k, Math.cos(t2)]
}

export function makeRig(cal: Calibration, pictureSize: number): LensModel[] {
  const n = cal.lenses.length
  const base = vendorRotation([0, 0, 90], 0, n)
  // Lens position: the calibration's tx, ty, tz is a translation expressed in lens 0 camera coordinates (z = optical axis),
  // and the projection center is treated as the position with that sign flipped (the lens 1 projection center is 32.8 mm forward along the lens 0 optical axis).
  // It looks opposite to the layout of the front elements, but the projection center of a fisheye is not necessarily at the front element. The sign was confirmed with real data:
  // the bridge railing at 3:22 matches only in this direction at a near distance, and gets worse at any distance in the opposite direction.
  // To rig coordinates: x_rig = (camFromRig0)ᵀ · x_cam0. The midpoint of the two lenses is the origin
  const cam0 = matMul(vendorRotation(cal.lenses[0].yprDeg, 0, n), matT(base))
  const posRig = cal.lenses.map((c) => {
    const t = c.tM ?? [0, 0, 0]
    return [0, 1, 2].map((r) => -(cam0[r] * t[0] + cam0[3 + r] * t[1] + cam0[6 + r] * t[2]))
  })
  const mid = [0, 1, 2].map((k) => posRig.reduce((s, p) => s + p[k], 0) / n)
  return cal.lenses.map((c, i) => {
    const frameW = c.width / n
    const scale = pictureSize / frameW
    return {
      xi: c.xi,
      fx: c.fx,
      fy: c.fy,
      cx: c.cx - frameW * i,
      cy: c.cy,
      d: new Float64Array(c.d),
      scale,
      camFromRig: matMul(vendorRotation(c.yprDeg, i, n), matT(base)),
      pictureSize,
      pos: [posRig[i][0] - mid[0], posRig[i][1] - mid[1], posRig[i][2] - mid[2]]
    }
  })
}

/** Ray in camera coordinates → image pixel (for validation. Rendering uses the same formula in the shader) */
export function projectCam(L: LensModel, c0: [number, number, number]): [number, number] {
  const c = L.edge ? edgeCorrect(c0, L.edge) : c0
  const n = Math.hypot(c[0], c[1], c[2])
  const x = c[0] / n
  const y = c[1] / n
  const z = c[2] / n
  const den = z + L.xi
  const mx = x / den
  const my = y / den
  const d = L.d
  const r2 = mx * mx + my * my
  const r4 = r2 * r2
  const R = 1 + d[0] * r2 + d[1] * r4 + d[2] * r4 * r2 + d[3] * r4 * r4 + d[4] * r4 * r4 * r2
  const a = d[5] + d[7] * r2
  const b = d[6] + d[8] * r2
  const xd = mx * R + (r2 + 2 * mx * mx) * a + 2 * mx * my * b + d[9] * r2 + d[11] * r4
  const yd = my * R + (r2 + 2 * my * my) * b + 2 * mx * my * a + d[10] * r2 + d[12] * r4
  return [(L.fx * xd + L.cx) * L.scale, (L.fy * yd + L.cy) * L.scale]
}
