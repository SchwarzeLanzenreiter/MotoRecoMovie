// Floating corner signs in the air (curve radius). Drawn as 3D objects fixed to points on the map,
// with perspective projection from the virtual camera. They grow as you approach, and pass by outside the curve and overhead.
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
  size: 5, // width of the diamond [m] (a large sign floating in the air)
  height: 6, // height above the road surface [m] (the camera is about 1.2m above the road)
  offset: 5, // amount to shift toward the outside of the curve [m]
  camHeight: 1.2,
  maxDist: 320, // signs farther than this are not shown [m]
  fadeDist: 80, // width over which signs fade in from a distance [m]
  passFade: 0.3 // time to fade out a sign before passing its point [s] (signs already passed are not shown)
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

/** Default sign position: how many m ahead along the route from the corner entry point (negative = before it) */
export const DEFAULT_SIGN_AHEAD = -25

/**
 * If road is passed, signs that cannot be seen from the current location (over a hill or beyond a pass summit) are not shown (core/sightline.ts)
 */
export function drawCornerSigns(
  g: Ctx,
  cam: SignCamera,
  corners: Corner[],
  t: number,
  style: SignStyle = 'real',
  ahead = DEFAULT_SIGN_AHEAD,
  road: RoadTrack | null = null
): void {
  const r = cam.rect
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const focal = focalFor(r.w, cam.fov)
  const k = wideK(cam.fov)
  const toScreen = (q: ArrayLike<number>): [number, number] | null => {
    const s = projectPoint(q, focal, k)
    return s ? [cx + s[0], cy + s[1]] : null
  }
  // Only signs still ahead (signs already passed are not shown even for views that look back or sideways). Draw from the far end
  const items: { z: number; u: number; v: number; s: number; rot: number; a: number; c: Corner; ground: [number, number][]; gu: number; gv: number }[] = []
  for (const c of corners) {
    const pl = signPlace(c, ahead)
    if (!pl || pl.t <= t || pl.t > t + 30) continue
    const h = (pl.heading * Math.PI) / 180
    // Shift toward the outside of the curve (the left side for a right curve). Right of the heading at the entry point = (cos h, −sin h)
    const side = -c.dir * SIGN.offset
    const ax = pl.x + Math.cos(h) * side
    const ay = pl.y - Math.sin(h) * side
    const up = pl.alt + SIGN.height - (cam.alt + SIGN.camHeight)
    const p = toCamera(cam, ax - cam.x, ay - cam.y, up)
    const dist = Math.hypot(ax - cam.x, ay - cam.y)
    const range = Math.hypot(p[0], p[1], p[2])
    if (range < 2 || dist > SIGN.maxDist) continue
    const sp = toScreen(p)
    // Which way the world "up" points on screen (tilt the sign to match the screen tilt). Measured from the difference with a point 0.2m higher
    const p2 = toCamera(cam, ax - cam.x, ay - cam.y, up + 0.2)
    const sp2 = toScreen(p2)
    if (!sp || !sp2) continue
    const [u, v] = sp
    const [u2, v2] = sp2
    const rot = Math.atan2(u2 - u, -(v2 - v))
    // Size: magnification at that position = screen distance to a point 0.2m higher ÷ the component of that offset perpendicular to the line of sight [m]
    const along = ((p2[0] - p[0]) * p[0] + (p2[1] - p[1]) * p[1] + (p2[2] - p[2]) * p[2]) / range
    const perp = Math.sqrt(Math.max(1e-4, 0.04 - along * along))
    const s = (Math.hypot(u2 - u, v2 - v) / perp) * SIGN.size
    // Appears from far away and disappears just before reaching the sign's point. Not shown where it cannot be seen
    let a = Math.min(1, Math.max(0, (SIGN.maxDist - dist) / SIGN.fadeDist), (pl.t - t) / SIGN.passFade)
    if (a > 0 && road) a *= sightVisibility(road, t, pl.t, { x: cam.x, y: cam.y, h: cam.alt + SIGN.camHeight }, { x: ax, y: ay, h: pl.alt + SIGN.height - SIGN.size * 0.3 })
    if (a <= 0.01) continue
    // Ground point (the road surface directly below the sign) and the circle around it (used by the AR-style display)
    const upG = pl.alt - (cam.alt + SIGN.camHeight)
    const proj = (e: number, n: number, uu: number): [number, number] | null => toScreen(toCamera(cam, e, n, uu))
    const gp = proj(ax - cam.x, ay - cam.y, upG)
    const ground: [number, number][] = []
    if (style === 'cyber') {
      for (let k = 0; k < 24; k++) {
        const th = (k / 24) * Math.PI * 2
        const q = proj(ax - cam.x + Math.cos(th) * 2.2, ay - cam.y + Math.sin(th) * 2.2, upG)
        if (q) ground.push(q)
      }
    }
    if (u + s < r.x || u - s > r.x + r.w || v + s * 1.5 < r.y || v - s > r.y + r.h) continue
    items.push({ z: range, u, v, s, rot, a, c, ground, gu: gp ? gp[0] : u, gv: gp ? gp[1] : v })
  }
  items.sort((p, q) => q.z - p.z)
  g.save()
  g.beginPath()
  g.rect(r.x, r.y, r.w, r.h)
  g.clip()
  for (const it of items) {
    g.save()
    g.globalAlpha = it.a
    if (style === 'cyber') {
      const col = cyberColor(it.c.radius)
      // Ground circle (a circle on the road surface, projected) and a line of light dropped from the sign to the ground
      if (it.ground.length > 8) {
        g.beginPath()
        it.ground.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)))
        g.closePath()
        g.strokeStyle = col
        g.lineWidth = Math.max(1, it.s * 0.012)
        g.shadowColor = col
        g.shadowBlur = Math.min(16, it.s * 0.04)
        g.stroke()
        g.globalAlpha = it.a * 0.15
        g.fillStyle = col
        g.fill()
        g.globalAlpha = it.a
        g.shadowBlur = 0
      }
      const bottomX = it.u - Math.sin(it.rot) * it.s * 0.28
      const bottomY = it.v + Math.cos(it.rot) * it.s * 0.28
      const grad = g.createLinearGradient(bottomX, bottomY, it.gu, it.gv)
      grad.addColorStop(0, col)
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.strokeStyle = grad
      g.lineWidth = Math.max(1, it.s * 0.015)
      g.setLineDash([Math.max(2, it.s * 0.03), Math.max(2, it.s * 0.02)])
      g.beginPath()
      g.moveTo(bottomX, bottomY)
      g.lineTo(it.gu, it.gv)
      g.stroke()
      g.setLineDash([])
      g.translate(it.u, it.v)
      g.rotate(it.rot)
      drawCyberSign(g, it.s, it.c.dir, it.c.radius, Math.hypot(it.c.ex - cam.x, it.c.ey - cam.y), col)
    } else {
      g.translate(it.u, it.v)
      g.rotate(it.rot)
      drawSign(g, it.s, it.c.dir, it.c.radius)
    }
    g.restore()
  }
  g.restore()
}
