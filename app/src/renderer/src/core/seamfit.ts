// Seam fitting: in the overlap band that both lenses capture (86-94° from the lens 0 optical axis, all around),
// estimate a correction for lens 1 (a small rotation and an edge angle) so that the images match.
//
// With the stock X6 calibration, when facing sideways the lens 1 image is offset about 2° forward on both left and right
// (about 27 px at 1920 width and 100° FOV). The offset is the same whether stopped or moving, so it is not a difference in capture timing,
// and it is symmetric left to right, so it is not a rotation either. It is thought to be an error in the angle from the optical axis (about 2° at the edge) (docs/insv-x6-format.md).
// Using the Nelder–Mead method, search for the rotation (rotation vector in rig coordinates, degrees) and edge angle (correction at 90° from the optical axis, degrees)
// that minimize the brightness difference in the overlap band over several frames (absolute difference after matching mean and spread).
import { projectCam, type LensModel } from './lens'

/** Lens 1 correction: rotation (rotation vector in rig coordinates, degrees) and edge angle (correction at 90° from the optical axis, degrees) */
export interface SeamFix {
  rot: [number, number, number]
  edge: number
}
import { matMul, qFromRotvec, qToMat, type Mat3 } from './quat'

/** Images of both lenses for one frame (gray, 0-1, size×size) */
export interface SeamFrame {
  size: number
  img: [Float32Array, Float32Array]
}

const d2r = Math.PI / 180

/** Rotation matrix of a rotation vector [deg] (rig coordinates) */
export function rotDeg(r: ArrayLike<number>): Mat3 {
  return qToMat(qFromRotvec(r[0] * d2r, r[1] * d2r, r[2] * d2r))
}

/** Rig with the correction applied to lens 1 (unchanged if fix is null) */
export function withSeamFix(rig: LensModel[], fix: SeamFix | null): LensModel[] {
  if (!fix || rig.length < 2) return rig
  return rig.map((L, i) => (i === 1 ? { ...L, camFromRig: matMul(L.camFromRig, rotDeg(fix.rot)), edge: fix.edge * d2r } : L))
}

/** Seam coordinate system: lens 0 optical axis ax and e1, e2 orthogonal to it (reference for azimuth; the shader's uSeamAx etc.) */
export function seamBasis(rig: LensModel[]): { ax: number[]; e1: number[]; e2: number[] } {
  const M = rig[0].camFromRig // rows = camera axes (rig coordinates)
  const ax = [M[6], M[7], M[8]]
  const tmp = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const e1 = cross(ax, tmp)
  const n1 = Math.hypot(e1[0], e1[1], e1[2])
  for (let k = 0; k < 3; k++) e1[k] /= n1
  return { ax, e1, e2: cross(ax, e1) }
}

/** Rays in the overlap band (rig coordinates): angle thetas from the lens 0 optical axis, one per stepDeg of azimuth */
export function bandRays(rig: LensModel[], thetasDeg = [86, 87, 88, 89, 90, 91, 92, 93, 94], stepDeg = 0.25): Float64Array {
  const { ax, e1, e2 } = seamBasis(rig)
  const nPh = Math.round(360 / stepDeg)
  const out = new Float64Array(thetasDeg.length * nPh * 3)
  let o = 0
  for (const t of thetasDeg) {
    const ct = Math.cos(t * d2r)
    const st = Math.sin(t * d2r)
    for (let j = 0; j < nPh; j++) {
      const p = j * stepDeg * d2r
      for (let k = 0; k < 3; k++) out[o++] = ct * ax[k] + st * (Math.cos(p) * e1[k] + Math.sin(p) * e2[k])
    }
  }
  return out
}

/** Reads a pixel by bilinear interpolation (NaN outside the range) */
function sample(img: Float32Array, size: number, u: number, v: number): number {
  const x = u - 0.5
  const y = v - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 >= size - 1 || y0 >= size - 1) return NaN
  const fx = x - x0
  const fy = y - y0
  const i = y0 * size + x0
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + size] * (1 - fx) + img[i + size + 1] * fx) * fy
}

/** Ray → pixel of the image (shrunk to size×size) for lens L */
function sampleRays(L: LensModel, camFromRig: Mat3, rays: Float64Array, f: SeamFrame, which: 0 | 1, out: Float64Array): void {
  const k = f.size / L.pictureSize
  const M = camFromRig
  for (let r = 0; r < out.length; r++) {
    const x = rays[r * 3]
    const y = rays[r * 3 + 1]
    const z = rays[r * 3 + 2]
    const c: [number, number, number] = [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z]
    const [u, v] = projectCam(L, c)
    out[r] = sample(f.img[which], f.size, u * k, v * k)
  }
}

/** Mean absolute difference after matching mean and spread (only pixels captured by both) */
function diff(a: Float64Array, b: Float64Array): number {
  let n = 0
  let ma = 0
  let mb = 0
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue
    ma += a[i]
    mb += b[i]
    n++
  }
  if (n < 100) return 1
  ma /= n
  mb /= n
  let sa = 0
  let sb = 0
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue
    sa += (a[i] - ma) ** 2
    sb += (b[i] - mb) ** 2
  }
  sa = Math.sqrt(sa / n) || 1
  sb = Math.sqrt(sb / n) || 1
  let s = 0
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue
    s += Math.abs((a[i] - ma) / sa - (b[i] - mb) / sb)
  }
  return s / n
}

/** Nelder–Mead method (minimization) */
function nelderMead(f: (x: number[]) => number, x0: number[], step: number, tol: number, maxIter: number): { x: number[]; fx: number } {
  const n = x0.length
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))]
  let vals = pts.map(f)
  for (let it = 0; it < maxIter; it++) {
    const ord = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1])
    pts = ord.map((i) => pts[i])
    vals = ord.map((i) => vals[i])
    const size = Math.max(...pts.slice(1).map((p) => Math.max(...p.map((v, j) => Math.abs(v - pts[0][j])))))
    if (size < tol) break
    const c = x0.map((_, j) => pts.slice(0, n).reduce((s, p) => s + p[j], 0) / n)
    const at = (t: number): number[] => c.map((v, j) => v + t * (pts[n][j] - v))
    const xr = at(-1)
    const fr = f(xr)
    if (fr < vals[0]) {
      const xe = at(-2)
      const fe = f(xe)
      if (fe < fr) [pts[n], vals[n]] = [xe, fe]
      else [pts[n], vals[n]] = [xr, fr]
    } else if (fr < vals[n - 1]) [pts[n], vals[n]] = [xr, fr]
    else {
      const xc = at(fr < vals[n] ? -0.5 : 0.5)
      const fc = f(xc)
      if (fc < Math.min(fr, vals[n])) [pts[n], vals[n]] = [xc, fc]
      else {
        // contraction
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]))
          vals[i] = f(pts[i])
        }
      }
    }
  }
  const best = vals.indexOf(Math.min(...vals))
  return { x: pts[best], fx: vals[best] }
}

export interface SeamFitResult {
  fix: SeamFix
  /** Difference in the overlap band (before and after correction; 0 = perfect match) */
  before: number
  after: number
}

/** Estimates the lens 1 correction (rotation and edge angle) that minimizes the overlap band difference */
export function fitSeam(rig: LensModel[], frames: SeamFrame[]): SeamFitResult {
  const rays = bandRays(rig)
  const n = rays.length / 3
  const s0 = frames.map((f) => {
    const a = new Float64Array(n)
    sampleRays(rig[0], rig[0].camFromRig, rays, f, 0, a)
    return a
  })
  const b = new Float64Array(n)
  const cost = (p: number[]): number => {
    const L1 = { ...rig[1], edge: p[3] * d2r }
    const M = matMul(rig[1].camFromRig, rotDeg(p))
    let tot = 0
    frames.forEach((f, k) => {
      sampleRays(L1, M, rays, f, 1, b)
      tot += diff(s0[k], b)
    })
    return tot / frames.length
  }
  const before = cost([0, 0, 0, 0])
  // coarse → fine
  let r = nelderMead(cost, [0, 0, 0, 0], 1.0, 0.05, 120)
  r = nelderMead(cost, r.x, 0.2, 0.005, 160)
  return { fix: { rot: [r.x[0], r.x[1], r.x[2]], edge: r.x[3] }, before, after: r.fx }
}
