// Projection of the output screen (shared by the shader and the floating signs).
//
// Up to a 135° FOV this is an ordinary perspective projection (straight lines stay straight). Beyond that it blends continuously into a stereographic projection toward 180°.
// Perspective stretches the screen edges more the wider the FOV gets; stereographic keeps shapes intact up to nearly 180°, but straight lines away from the screen center bend into arcs.
//   Angle θ from the optical axis and distance r from the screen center:  r = f·(1+k)·tan(θ / (1+k))
//   k = 0 gives perspective (r = f·tanθ), k = 1 gives stereographic (r = 2f·tan(θ/2))
// The blend used to run over 120°-170°, but at the commonly used 140° (auto-generated front view) k came out as 0.35, and the line of the top case reflector at the lower left of the screen
// was offset by 57px between left and right, looking like a step (at 1920 width). With 135°-180°, k = 0.03 at 140° (line offset about 7px; edge stretch 2.6x at the side edges),
// and k = 0.74 at 165° (auto-generated side and rear views; it used to be 0.97)
export const WIDE_FROM = 135
export const WIDE_TO = 180

/** Projection blend k from the FOV [deg] (0 = perspective ... 1 = stereographic) */
export function wideK(fovDeg: number): number {
  const x = Math.max(0, Math.min(1, (fovDeg - WIDE_FROM) / (WIDE_TO - WIDE_FROM)))
  return x * x * (3 - 2 * x)
}

/** Focal length [px] that gives a horizontal FOV of fovDeg on a screen of width widthPx */
export function focalFor(widthPx: number, fovDeg: number, kOverride?: number): number {
  const k = kOverride ?? wideK(fovDeg)
  return widthPx / 2 / ((1 + k) * Math.tan((fovDeg * Math.PI) / 360 / (1 + k)))
}

/** Maps a point in camera coordinates (x right, y down, z forward) to an offset from the screen center [px]. null if it is out of view */
export function projectPoint(p: ArrayLike<number>, focal: number, k: number): [number, number] | null {
  const rxy = Math.hypot(p[0], p[1])
  const th = Math.atan2(rxy, p[2])
  const a = th / (1 + k)
  if (a > Math.PI / 2 - 0.02) return null
  if (rxy < 1e-9) return [0, 0]
  const r = focal * (1 + k) * Math.tan(a)
  return [(p[0] / rxy) * r, (p[1] / rxy) * r]
}
