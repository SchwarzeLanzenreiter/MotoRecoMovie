// Corner signs (curve radius). Drawn as 3D objects fixed to points on the map, with perspective projection
// from the virtual camera: a flat plate facing the oncoming rider, standing on a post that grows from the road surface
// outside the curve. Signs already passed stay where they are and show their back (grey plate and brackets) when seen from behind.
//
// The face (or back) is drawn into a small canvas in sign coordinates (meters) and mapped onto the screen with a mesh of
// triangles, so it foreshortens, turns edge-on while passing and follows the curved wide-angle projection.
//
// Coordinate flow:
//   sign position (east/north [m] and elevation) - camera position (fused position and elevation)
//   -> map coordinates (x east, y down, z north)
//   -> inverse of the virtual camera orientation (the rotation used to draw the video, moved into map coordinates; cameraInMap in motion-model.ts)
//   -> projection onto the screen (same projection as the video; projection.ts)
// Because the same rotation and projection as the video are used, the signs move together with the fine shake left in the video and look stuck to the scenery.
import { signPlace, type Corner } from '../core/corners'
import { sightVisibility, type RoadTrack } from '../core/sightline'
import type { Mat3 } from '../core/quat'
import type { Ctx } from './meters'
import { M_COLORS } from './chrono'
import { focalFor, projectPoint, wideK } from './projection'

export type SignStyle = 'real' | 'cyber'

export interface SignCamera {
  x: number
  y: number
  alt: number
  /** Orientation of the virtual camera (columns = the camera's right, down and forward expressed in map coordinates x east, y down, z north) */
  rot: Mat3
  fov: number // horizontal FOV [deg]
  rect: { x: number; y: number; w: number; h: number }
}

export const SIGN = {
  size: 5, // width of the diamond [m] (a large sign)
  height: 6, // height of the sign center above the road surface [m] (the camera is about 1.2m above the road)
  offset: 5, // amount to shift toward the outside of the curve [m]
  camHeight: 1.2,
  maxDist: 320, // signs farther than this are not shown [m]
  fadeDist: 80, // width over which signs fade in from a distance [m]
  pole: 0.2, // diameter of the post [m]
  keepBehind: 60 // signs passed less than this many seconds ago are still drawn (seen from behind)
}

/** Extent of the face in sign coordinates [m] (x right, y down from the sign center as seen from the front), with room for the shadow / glow */
const EXTENT = {
  real: { x0: -2.9, x1: 2.9, y0: -2.9, y1: 4.7 },
  cyber: { x0: -3.0, x1: 3.0, y0: -1.9, y1: 1.9 }
}

const NUM = "Bahnschrift, 'Segoe UI', sans-serif"

/** Reference point of a sign in camera coordinates (z = forward distance) */
function toCamera(cam: SignCamera, e: number, n: number, up: number): [number, number, number] {
  const M = cam.rot // row-major. Columns are the camera axes -> camera coordinates = Mᵀ · p (p = east, down, north)
  const d = -up
  return [M[0] * e + M[3] * d + M[6] * n, M[1] * e + M[4] * d + M[7] * n, M[2] * e + M[5] * d + M[8] * n]
}

/** Sign (Japanese warning sign style: a yellow diamond with a curve arrow, and a "R=nn" sub-plate below) */
function drawSign(g: Ctx, s: number, dir: 1 | -1, radius: number): void {
  const d = s / 2
  // Shadow that gives a floating feel (blurred toward the bottom)
  g.save()
  g.shadowColor = 'rgba(0,0,0,0.55)'
  // Blur gets heavier the larger it is, so cap it (the sign fills the screen just before passing)
  g.shadowBlur = Math.min(30, s * 0.12)
  g.shadowOffsetY = Math.min(15, s * 0.06)
  g.beginPath()
  g.moveTo(0, -d)
  g.lineTo(d, 0)
  g.lineTo(0, d)
  g.lineTo(-d, 0)
  g.closePath()
  g.fillStyle = '#ffd200'
  g.fill()
  g.restore()
  // Black outline
  g.lineJoin = 'round'
  g.strokeStyle = '#111'
  g.lineWidth = s * 0.035
  const di = d * 0.88
  g.beginPath()
  g.moveTo(0, -di)
  g.lineTo(di, 0)
  g.lineTo(0, di)
  g.lineTo(-di, 0)
  g.closePath()
  g.stroke()
  // Curve arrow (goes from bottom to top, turning right or left)
  g.save()
  g.scale(dir, 1)
  g.strokeStyle = '#111'
  g.lineWidth = s * 0.075
  g.lineCap = 'butt'
  g.beginPath()
  g.moveTo(-s * 0.06, s * 0.3)
  g.lineTo(-s * 0.06, s * 0.02)
  g.quadraticCurveTo(-s * 0.06, -s * 0.16, s * 0.12, -s * 0.16)
  g.stroke()
  g.fillStyle = '#111'
  g.beginPath()
  g.moveTo(s * 0.26, -s * 0.16)
  g.lineTo(s * 0.1, -s * 0.28)
  g.lineTo(s * 0.1, -s * 0.04)
  g.closePath()
  g.fill()
  g.restore()
  // Sub-plate "R=nn"
  const pw = s * 0.82
  const ph = s * 0.3
  const py = d + s * 0.06
  g.save()
  g.shadowColor = 'rgba(0,0,0,0.5)'
  g.shadowBlur = Math.min(20, s * 0.08)
  g.shadowOffsetY = Math.min(10, s * 0.04)
  g.fillStyle = '#ffffff'
  g.beginPath()
  g.roundRect(-pw / 2, py, pw, ph, s * 0.03)
  g.fill()
  g.restore()
  g.strokeStyle = '#111'
  g.lineWidth = s * 0.02
  g.beginPath()
  g.roundRect(-pw / 2 + s * 0.02, py + s * 0.02, pw - s * 0.04, ph - s * 0.04, s * 0.02)
  g.stroke()
  g.fillStyle = '#111'
  g.font = `700 ${(ph * 0.66).toFixed(1)}px ${NUM}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(`R=${radius}`, 0, py + ph * 0.54)
}

/** Color by curve radius (AR style): tight = red, medium = orange, gentle = blue */
function cyberColor(radius: number): string {
  return radius < 60 ? M_COLORS.red : radius < 120 ? '#ffb000' : M_COLORS.light
}

/** AR-style sign: a translucent hologram-like panel with a neon frame, curve arrow, "R165" and the remaining distance */
function drawCyberSign(g: Ctx, s: number, dir: 1 | -1, radius: number, distM: number, col: string): void {
  const w = s
  const h = s * 0.56
  const ch = h * 0.18 // corner cut size
  const lw = Math.max(1, s * 0.012)
  const shape = (): void => {
    g.beginPath()
    g.moveTo(-w / 2 + ch, -h / 2)
    g.lineTo(w / 2, -h / 2)
    g.lineTo(w / 2, h / 2 - ch)
    g.lineTo(w / 2 - ch, h / 2)
    g.lineTo(-w / 2, h / 2)
    g.lineTo(-w / 2, -h / 2 + ch)
    g.closePath()
  }
  // Panel (translucent) and scan lines
  shape()
  g.fillStyle = 'rgba(4, 16, 34, 0.42)'
  g.fill()
  g.save()
  shape()
  g.clip()
  g.fillStyle = 'rgba(255,255,255,0.05)'
  const step = Math.max(2, h / 22)
  for (let y = -h / 2; y < h / 2; y += step) g.fillRect(-w / 2, y, w, step * 0.3)
  g.restore()
  // Frame (glowing)
  shape()
  g.strokeStyle = col
  g.lineWidth = lw * 1.4
  g.shadowColor = col
  g.shadowBlur = Math.min(24, s * 0.06)
  g.stroke()
  g.shadowBlur = 0
  // Left: curve arrow (neon line)
  g.save()
  g.translate(-w * 0.28, h * 0.02)
  g.scale(dir, 1)
  g.strokeStyle = col
  g.lineWidth = s * 0.05
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.shadowColor = col
  g.shadowBlur = Math.min(20, s * 0.05)
  g.beginPath()
  g.moveTo(-s * 0.05, h * 0.32)
  g.lineTo(-s * 0.05, h * 0.02)
  g.quadraticCurveTo(-s * 0.05, -h * 0.22, s * 0.1, -h * 0.22)
  g.stroke()
  g.beginPath()
  g.moveTo(s * 0.06, -h * 0.34)
  g.lineTo(s * 0.17, -h * 0.22)
  g.lineTo(s * 0.06, -h * 0.1)
  g.stroke()
  g.restore()
  g.shadowBlur = 0
  // Divider line
  g.save()
  g.strokeStyle = col
  g.globalAlpha *= 0.6
  g.lineWidth = lw
  g.beginPath()
  g.moveTo(-w * 0.1, -h * 0.34)
  g.lineTo(-w * 0.1, h * 0.34)
  g.stroke()
  g.restore()
  // Right: radius and remaining distance
  const tx = w * 0.2
  const cg = g as CanvasRenderingContext2D
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = col
  g.font = `600 ${(h * 0.13).toFixed(1)}px ${NUM}`
  cg.letterSpacing = `${(h * 0.03).toFixed(1)}px`
  g.fillText(`CURVE ${dir > 0 ? 'RIGHT' : 'LEFT'}`, tx, -h * 0.32)
  cg.letterSpacing = '0px'
  g.fillStyle = '#ffffff'
  g.shadowColor = col
  g.shadowBlur = Math.min(18, s * 0.04)
  g.font = `700 ${(h * 0.36).toFixed(1)}px ${NUM}`
  g.fillText(`R${radius}`, tx, -h * 0.02)
  g.shadowBlur = 0
  g.font = `600 ${(h * 0.13).toFixed(1)}px ${NUM}`
  g.fillStyle = col
  g.fillText(`\u25B8 ${Math.max(0, Math.round(distM / 5) * 5)} m`, tx, h * 0.28)
  // Remaining distance bar (shorter the closer you get; full at 100m)
  const bw = w * 0.5
  const frac = Math.max(0, Math.min(1, distM / 100))
  g.fillStyle = 'rgba(255,255,255,0.15)'
  g.fillRect(tx - bw / 2, h * 0.38, bw, h * 0.04)
  g.fillStyle = col
  g.fillRect(tx - bw / 2, h * 0.38, bw * frac, h * 0.04)
}

/** Back of the real-style sign: plain galvanized plates and the brackets that hold them on the post (the post itself is drawn in 3D) */
function drawSignBack(g: Ctx, s: number): void {
  const d = s / 2
  const metal = (x0: number, y0: number, x1: number, y1: number): CanvasGradient => {
    const gr = g.createLinearGradient(x0, y0, x1, y1)
    gr.addColorStop(0, '#b9bec3')
    gr.addColorStop(0.5, '#9ea4aa')
    gr.addColorStop(1, '#868c92')
    return gr
  }
  g.lineJoin = 'round'
  g.beginPath()
  g.moveTo(0, -d)
  g.lineTo(d, 0)
  g.lineTo(0, d)
  g.lineTo(-d, 0)
  g.closePath()
  g.fillStyle = metal(-d, -d, d, d)
  g.fill()
  g.strokeStyle = '#5f656b'
  g.lineWidth = s * 0.02
  g.stroke()
  // Folded rim just inside the edge
  const di = d * 0.93
  g.beginPath()
  g.moveTo(0, -di)
  g.lineTo(di, 0)
  g.lineTo(0, di)
  g.lineTo(-di, 0)
  g.closePath()
  g.strokeStyle = 'rgba(255,255,255,0.25)'
  g.lineWidth = s * 0.012
  g.stroke()
  // Sub-plate
  const pw = s * 0.82
  const ph = s * 0.3
  const py = d + s * 0.06
  g.beginPath()
  g.roundRect(-pw / 2, py, pw, ph, s * 0.03)
  g.fillStyle = metal(-pw / 2, py, pw / 2, py + ph)
  g.fill()
  g.strokeStyle = '#5f656b'
  g.lineWidth = s * 0.015
  g.stroke()
  // Brackets: horizontal channels across the plates, with bolts at both ends
  const bar = (y: number, w: number): void => {
    const bh = s * 0.045
    g.fillStyle = '#6d7379'
    g.fillRect(-w / 2, y - bh / 2, w, bh)
    g.fillStyle = 'rgba(255,255,255,0.18)'
    g.fillRect(-w / 2, y - bh / 2, w, bh * 0.3)
    g.fillStyle = '#3f4448'
    for (const x of [-w / 2 + bh * 0.6, w / 2 - bh * 0.6]) {
      g.beginPath()
      g.arc(x, y, bh * 0.28, 0, Math.PI * 2)
      g.fill()
    }
  }
  bar(-d * 0.45, d * 0.9)
  bar(d * 0.45, d * 0.9)
  bar(py + ph / 2, pw * 0.5)
}

/** Default sign position: how many m ahead along the route from the corner entry point (negative = before it) */
export const DEFAULT_SIGN_AHEAD = -25

/** Face textures (the real style does not change, so it is kept; least recently used ones are dropped) */
const faceCache = new Map<string, OffscreenCanvas>()
const FACE_CACHE_MAX = 48

function faceTexture(style: SignStyle, back: boolean, ppm: number, c: Corner, distM: number): OffscreenCanvas {
  const ex = EXTENT[style]
  const key = style === 'real' ? `real|${back}|${ppm}|${c.dir}|${c.radius}` : `cyber|${back}|${ppm}|${c.dir}|${c.radius}|${Math.max(0, Math.round(distM / 5) * 5)}`
  const hit = faceCache.get(key)
  if (hit) {
    faceCache.delete(key)
    faceCache.set(key, hit)
    return hit
  }
  const cv = new OffscreenCanvas(Math.ceil((ex.x1 - ex.x0) * ppm), Math.ceil((ex.y1 - ex.y0) * ppm))
  const g = cv.getContext('2d')!
  g.translate(-ex.x0 * ppm, -ex.y0 * ppm)
  const s = SIGN.size * ppm
  if (style === 'cyber') {
    // A hologram: from behind it is the same panel seen through, a little fainter
    if (back) g.globalAlpha = 0.7
    drawCyberSign(g, s, c.dir, c.radius, distM, cyberColor(c.radius))
  } else if (back) drawSignBack(g, s)
  else drawSign(g, s, c.dir, c.radius)
  faceCache.set(key, cv)
  if (faceCache.size > FACE_CACHE_MAX) faceCache.delete(faceCache.keys().next().value!)
  return cv
}

/** Draw the image triangle (u, v) onto the screen triangle (x, y) with an affine map (slightly enlarged so neighbouring triangles leave no seams) */
function drawTriangle(g: Ctx, img: OffscreenCanvas, x: number[], y: number[], u: number[], v: number[]): void {
  const den = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0])
  if (Math.abs(den) < 1e-9) return
  const area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0])
  if (Math.abs(area) < 0.05) return // edge-on
  const a = ((x[1] - x[0]) * (v[2] - v[0]) - (x[2] - x[0]) * (v[1] - v[0])) / den
  const c = ((x[2] - x[0]) * (u[1] - u[0]) - (x[1] - x[0]) * (u[2] - u[0])) / den
  const b = ((y[1] - y[0]) * (v[2] - v[0]) - (y[2] - y[0]) * (v[1] - v[0])) / den
  const d = ((y[2] - y[0]) * (u[1] - u[0]) - (y[1] - y[0]) * (u[2] - u[0])) / den
  const e = x[0] - a * u[0] - c * v[0]
  const f = y[0] - b * u[0] - d * v[0]
  const mx = (x[0] + x[1] + x[2]) / 3
  const my = (y[0] + y[1] + y[2]) / 3
  g.save()
  g.beginPath()
  for (let k = 0; k < 3; k++) {
    const dx = x[k] - mx
    const dy = y[k] - my
    const l = Math.hypot(dx, dy) || 1
    const px = x[k] + (dx / l) * 0.7
    const py = y[k] + (dy / l) * 0.7
    if (k) g.lineTo(px, py)
    else g.moveTo(px, py)
  }
  g.closePath()
  g.clip()
  g.transform(a, b, c, d, e, f)
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, 0, 0)
  g.restore()
}

/** Mesh resolution of the face (columns x rows) for a large sign on screen; small ones use fewer cells (seams between tiny triangles shimmer) */
const MESH_X = 6
const MESH_Y = 8

interface SignItem {
  z: number
  a: number
  c: Corner
  back: boolean
  /** sign center relative to the camera (east, north, up) [m] */
  e: number
  n: number
  up: number
  /** unit vector of the sign's x axis (to the right as seen from the front) in (east, north) */
  rx: number
  ry: number
  /** direction the riders travel (the face looks the other way) */
  fx: number
  fy: number
  /** road surface under the sign, relative to the camera [m] */
  ground: number
  ppm: number
  /** on-screen size of 1 m at the sign [px] */
  px: number
  distM: number
}

/** Screen area the signs were drawn in (pixels) */
export interface SignBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * If road is passed, signs that cannot be seen from the current location (over a hill or beyond a pass summit) are not shown (core/sightline.ts).
 * Returns the number of signs drawn; box (if given) receives the screen area they cover, within the view
 */
export function drawCornerSigns(
  g: Ctx,
  cam: SignCamera,
  corners: Corner[],
  t: number,
  style: SignStyle = 'real',
  ahead = DEFAULT_SIGN_AHEAD,
  road: RoadTrack | null = null,
  box?: SignBox
): number {
  const r = cam.rect
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const focal = focalFor(r.w, cam.fov)
  const k = wideK(cam.fov)
  const proj = (e: number, n: number, up: number): [number, number] | null => {
    const s = projectPoint(toCamera(cam, e, n, up), focal, k)
    return s ? [cx + s[0], cy + s[1]] : null
  }
  const eyeUp = cam.alt + SIGN.camHeight
  const items: SignItem[] = []
  for (const c of corners) {
    const pl = signPlace(c, ahead)
    if (!pl || pl.t > t + 30 || pl.t < t - SIGN.keepBehind) continue
    const h = (pl.heading * Math.PI) / 180
    // Direction of travel at the sign (east, north), and to its right
    const fx = Math.sin(h)
    const fy = Math.cos(h)
    const rx = Math.cos(h)
    const ry = -Math.sin(h)
    // Shift toward the outside of the curve (the left side for a right curve)
    const side = -c.dir * SIGN.offset
    const ax = pl.x + rx * side
    const ay = pl.y + ry * side
    const e = ax - cam.x
    const n = ay - cam.y
    const dist = Math.hypot(e, n)
    if (dist > SIGN.maxDist) continue
    const up = pl.alt + SIGN.height - eyeUp
    // The face looks back along the road, toward the riders coming to it. Seen from beyond it, the back shows
    const back = e * fx + n * fy < 0
    let a = Math.min(1, Math.max(0, (SIGN.maxDist - dist) / SIGN.fadeDist))
    if (a > 0 && road) {
      const eye = { x: cam.x, y: cam.y, h: eyeUp }
      const target = { x: ax, y: ay, h: pl.alt + SIGN.height - SIGN.size * 0.3 }
      a *= pl.t >= t ? sightVisibility(road, t, pl.t, eye, target) : sightVisibility(road, pl.t, t, target, eye)
    }
    if (a <= 0.01) continue
    // Texture resolution from the on-screen size of 1 m at the sign: the next power of two (so the cache is reused while approaching), so the
    // texture is shrunk by less than half when drawn. A texture much finer than the screen makes small text and the AR scan lines shimmer
    const p0 = proj(e, n, up)
    const p1 = proj(e, n, up + 1)
    const pxPerM = p0 && p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) : 0
    const ppm = 2 ** Math.ceil(Math.log2(Math.max(4, Math.min(160, pxPerM))))
    items.push({ z: Math.hypot(e, n, up), a, c, back, e, n, up, rx, ry, fx, fy, ground: pl.alt - eyeUp, ppm, px: pxPerM, distM: Math.hypot(c.ex - cam.x, c.ey - cam.y) })
  }
  items.sort((p, q) => q.z - p.z)
  // Points projected while drawing give the area covered
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  const track: Proj = (e, n, up) => {
    const q = proj(e, n, up)
    if (q) {
      b.x0 = Math.min(b.x0, q[0])
      b.y0 = Math.min(b.y0, q[1])
      b.x1 = Math.max(b.x1, q[0])
      b.y1 = Math.max(b.y1, q[1])
    }
    return q
  }
  g.save()
  g.beginPath()
  g.rect(r.x, r.y, r.w, r.h)
  g.clip()
  for (const it of items) {
    g.save()
    g.globalAlpha = it.a
    if (style === 'cyber') drawCyberExtras(g, it, track)
    else if (!it.back) drawPole(g, it, track)
    drawFace(g, it, style, track, r)
    if (style === 'real' && it.back) drawPole(g, it, track)
    g.restore()
  }
  g.restore()
  if (box) {
    box.x0 = Math.max(r.x, b.x0)
    box.y0 = Math.max(r.y, b.y0)
    box.x1 = Math.min(r.x + r.w, b.x1)
    box.y1 = Math.min(r.y + r.h, b.y1)
  }
  return items.length
}

type Proj = (e: number, n: number, up: number) => [number, number] | null

/** The face (or back) as a mesh: sign coordinates (x right, y down, meters) -> world -> screen */
function drawFace(g: Ctx, it: SignItem, style: SignStyle, proj: Proj, r: SignCamera['rect']): void {
  const ex = EXTENT[style]
  const onScreen = it.px * SIGN.size
  const MX = onScreen < 120 ? 1 : onScreen < 400 ? 3 : MESH_X
  const MY = onScreen < 120 ? 1 : onScreen < 400 ? 4 : MESH_Y
  const pts: ([number, number] | null)[] = []
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (let j = 0; j <= MY; j++) {
    const sy = ex.y0 + ((ex.y1 - ex.y0) * j) / MY
    for (let i = 0; i <= MX; i++) {
      const sx = ex.x0 + ((ex.x1 - ex.x0) * i) / MX
      const p = proj(it.e + it.rx * sx, it.n + it.ry * sx, it.up - sy)
      pts.push(p)
      if (p) {
        x0 = Math.min(x0, p[0])
        x1 = Math.max(x1, p[0])
        y0 = Math.min(y0, p[1])
        y1 = Math.max(y1, p[1])
      }
    }
  }
  if (x1 < r.x || x0 > r.x + r.w || y1 < r.y || y0 > r.y + r.h) return
  const img = faceTexture(style, it.back, it.ppm, it.c, it.distM)
  const du = img.width / MX
  const dv = img.height / MY
  const W = MX + 1
  for (let j = 0; j < MY; j++) {
    for (let i = 0; i < MX; i++) {
      const p00 = pts[j * W + i]
      const p10 = pts[j * W + i + 1]
      const p01 = pts[(j + 1) * W + i]
      const p11 = pts[(j + 1) * W + i + 1]
      if (!p00 || !p10 || !p01 || !p11) continue
      const u0 = i * du
      const u1 = (i + 1) * du
      const v0 = j * dv
      const v1 = (j + 1) * dv
      drawTriangle(g, img, [p00[0], p10[0], p11[0]], [p00[1], p10[1], p11[1]], [u0, u1, u1], [v0, v0, v1])
      drawTriangle(g, img, [p00[0], p11[0], p01[0]], [p00[1], p11[1], p01[1]], [u0, u1, u0], [v0, v1, v1])
    }
  }
}

/** Post from the road surface up behind the plate (a round steel pipe, drawn as a strip facing the camera) */
function drawPole(g: Ctx, it: SignItem, proj: Proj): void {
  // Just behind the plate (the face looks against the direction of travel)
  const pe = it.e + it.fx * 0.15
  const pn = it.n + it.fy * 0.15
  const l = Math.hypot(pe, pn) || 1
  // Half the diameter, across the line of sight
  const we = (-pn / l) * SIGN.pole * 0.5
  const wn = (pe / l) * SIGN.pole * 0.5
  const top = it.up + SIGN.size * 0.3
  const N = 12
  const left: [number, number][] = []
  const right: [number, number][] = []
  for (let k = 0; k <= N; k++) {
    const up = it.ground + ((top - it.ground) * k) / N
    const a = proj(pe - we, pn - wn, up)
    const b = proj(pe + we, pn + wn, up)
    if (!a || !b) continue
    left.push(a)
    right.push(b)
  }
  if (left.length < 2) return
  // At least a hairline when far away
  const lb = left[0]
  const rb = right[0]
  const wPx = Math.hypot(rb[0] - lb[0], rb[1] - lb[1])
  const grow = wPx < 1.2 ? (1.2 - wPx) / 2 : 0
  const ux = wPx > 1e-6 ? (rb[0] - lb[0]) / wPx : 1
  const uy = wPx > 1e-6 ? (rb[1] - lb[1]) / wPx : 0
  g.beginPath()
  left.forEach(([x, y], k) => (k ? g.lineTo(x - ux * grow, y - uy * grow) : g.moveTo(x - ux * grow, y - uy * grow)))
  for (let k = right.length - 1; k >= 0; k--) g.lineTo(right[k][0] + ux * grow, right[k][1] + uy * grow)
  g.closePath()
  const mid = Math.floor(left.length / 2)
  const gr = g.createLinearGradient(left[mid][0], left[mid][1], right[mid][0], right[mid][1])
  gr.addColorStop(0, '#6a7076')
  gr.addColorStop(0.35, '#c4c9ce')
  gr.addColorStop(1, '#7c8288')
  g.fillStyle = gr
  g.fill()
}

/** AR style: a circle on the road surface under the panel and a line of light down to it */
function drawCyberExtras(g: Ctx, it: SignItem, proj: Proj): void {
  const col = cyberColor(it.c.radius)
  const s = it.px * SIGN.size
  const ring: [number, number][] = []
  for (let k = 0; k < 24; k++) {
    const th = (k / 24) * Math.PI * 2
    const q = proj(it.e + Math.cos(th) * 2.2, it.n + Math.sin(th) * 2.2, it.ground)
    if (q) ring.push(q)
  }
  if (ring.length > 8) {
    g.save()
    g.beginPath()
    ring.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)))
    g.closePath()
    g.strokeStyle = col
    g.lineWidth = Math.max(1, s * 0.012)
    g.shadowColor = col
    g.shadowBlur = Math.min(16, s * 0.04)
    g.stroke()
    g.globalAlpha *= 0.15
    g.fillStyle = col
    g.fill()
    g.restore()
  }
  const b = proj(it.e, it.n, it.up - SIGN.size * 0.28)
  const gp = proj(it.e, it.n, it.ground)
  if (!b || !gp) return
  const grad = g.createLinearGradient(b[0], b[1], gp[0], gp[1])
  grad.addColorStop(0, col)
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.save()
  g.strokeStyle = grad
  g.lineWidth = Math.max(1, s * 0.015)
  g.setLineDash([Math.max(2, s * 0.03), Math.max(2, s * 0.02)])
  g.beginPath()
  g.moveTo(b[0], b[1])
  g.lineTo(gp[0], gp[1])
  g.stroke()
  g.restore()
}
