// Emblems in the spirit of the makers' marks, drawn as simple vector shapes on the meter face (under the scales and numbers).
// Each one is drawn in a box of radius r around (cx, cy); unit coordinates run from -1 to 1 (x right, y down).
import type { Ctx } from '../meters'

const TAU = Math.PI * 2

/** Runs draw() in unit coordinates centered on (cx, cy) with radius r, at opacity alpha */
function unit(g: Ctx, cx: number, cy: number, r: number, alpha: number, draw: () => void): void {
  g.save()
  g.translate(cx, cy)
  g.scale(r, r)
  g.globalAlpha *= alpha
  draw()
  g.restore()
}

/** BMW: a disc quartered in blue and white (blue at top left and bottom right) inside a black ring with silver edges; no letters */
export function roundel(g: Ctx, cx: number, cy: number, r: number, blue: string, white: string, ring: string, silver: string): void {
  unit(g, cx, cy, r, 1, () => {
    g.beginPath()
    g.arc(0, 0, 1, 0, TAU)
    g.arc(0, 0, 0.78, 0, TAU, true)
    g.fillStyle = ring
    g.fill()
    for (let q = 0; q < 4; q++) {
      g.beginPath()
      g.moveTo(0, 0)
      g.arc(0, 0, 0.78, (q * Math.PI) / 2, ((q + 1) * Math.PI) / 2)
      g.closePath()
      // Quarter 2 (180°-270°) is the top left, quarter 0 the bottom right
      g.fillStyle = q % 2 === 0 ? blue : white
      g.fill()
    }
    g.strokeStyle = silver
    for (const [rr, w] of [
      [1, 0.035],
      [0.78, 0.025]
    ]) {
      g.lineWidth = w
      g.beginPath()
      g.arc(0, 0, rr, 0, TAU)
      g.stroke()
    }
  })
}

/**
 * Honda: the wing. One silhouette: a straight left edge, a rounded shoulder at the top left, a long upper edge sweeping up to the tip at
 * the upper right and a lower edge running back down to the bottom; thin horizontal slits split its lower part into feathers that end
 * in a slant toward the tip
 */
export function wing(g: Ctx, cx: number, cy: number, r: number, col: string, alpha: number): void {
  unit(g, cx, cy, r, alpha, () => {
    g.save()
    g.beginPath()
    g.moveTo(-0.92, 0.72)
    g.lineTo(-0.92, -0.2)
    g.bezierCurveTo(-0.92, -0.52, -0.7, -0.62, -0.42, -0.6)
    g.bezierCurveTo(0.1, -0.58, 0.6, -0.68, 1.0, -0.86)
    g.bezierCurveTo(0.7, -0.5, 0.3, -0.05, -0.12, 0.72)
    g.closePath()
    g.clip()
    // Feathers: the silhouette between the slits
    g.fillStyle = col
    const slits = [-0.14, 0.1, 0.33, 0.54]
    const gap = 0.065
    let top = -1
    for (const y of slits) {
      g.fillRect(-1, top, 2.1, y - top)
      top = y + gap
    }
    g.fillRect(-1, top, 2.1, 1 - top)
    g.restore()
  })
}

/**
 * Yamaha: three tuning forks in a ring. Each fork's two prongs run in from the ring and join in a U; its handle runs on from the U
 * through the middle, so the three handles cross between the heads
 */
export function tuningForks(g: Ctx, cx: number, cy: number, r: number, col: string, alpha: number): void {
  unit(g, cx, cy, r, alpha, () => {
    g.strokeStyle = col
    g.lineCap = 'butt'
    g.lineJoin = 'round'
    g.lineWidth = 0.09
    g.beginPath()
    g.arc(0, 0, 0.95, 0, TAU)
    g.stroke()
    g.lineWidth = 0.12
    for (let k = 0; k < 3; k++) {
      g.save()
      g.rotate((k * TAU) / 3)
      // Head toward the top: prongs from the ring down to the U, then the handle on through the middle
      g.beginPath()
      g.moveTo(-0.2, -0.9)
      g.lineTo(-0.2, -0.38)
      g.arc(0, -0.38, 0.2, Math.PI, 0, true)
      g.lineTo(0.2, -0.9)
      g.moveTo(0, -0.18)
      g.lineTo(0, 0.36)
      g.stroke()
      g.restore()
    }
  })
}

/**
 * Suzuki: the angular S. A top bar runs left into a sharp point, a steep diagonal runs down to the right into another sharp point, and
 * a bottom bar runs left; the two free ends are cut parallel to the diagonal
 */
export function angularS(g: Ctx, cx: number, cy: number, r: number, col: string, alpha: number): void {
  unit(g, cx, cy, r, alpha, () => {
    // Cuts parallel to the diagonal through the free ends
    const dx = 1.24
    const dy = 1.44
    g.beginPath()
    g.moveTo(0.72 - dx, -0.72 - dy)
    g.lineTo(0.72 + dx, -0.72 + dy)
    g.lineTo(-0.72 + dx, 0.72 + dy)
    g.lineTo(-0.72 - dx, 0.72 - dy)
    g.closePath()
    g.clip()
    g.strokeStyle = col
    g.lineWidth = 0.36
    g.lineJoin = 'miter'
    g.miterLimit = 20
    g.lineCap = 'square'
    g.beginPath()
    g.moveTo(0.9, -0.72)
    g.lineTo(-0.62, -0.72)
    g.lineTo(0.62, 0.72)
    g.lineTo(-0.9, 0.72)
    g.stroke()
  })
}

/**
 * Kawasaki (the earlier mark): a ring split by a vertical bar, each half bending in toward the bar at the middle with a short inner
 * step, like two mirrored S shapes
 */
export function riverMark(g: Ctx, cx: number, cy: number, r: number, col: string, edge: string, alpha: number): void {
  unit(g, cx, cy, r, alpha, () => {
    const w = 0.17
    const R = 0.9
    const path = (): void => {
      g.beginPath()
      // Central bar
      g.moveTo(0, -0.99)
      g.lineTo(0, 0.99)
      for (const s of [-1, 1]) {
        // Upper arc from beside the bar round to the side, then in, down and out, and the lower arc back to beside the bar
        const a0 = -Math.PI / 2 - s * 0.2
        const aU = s < 0 ? Math.PI + 0.2 : -0.2
        const aL = s < 0 ? Math.PI - 0.2 : 0.2
        const a1 = Math.PI / 2 + s * 0.2
        g.moveTo(Math.cos(a0) * R, Math.sin(a0) * R)
        g.arc(0, 0, R, a0, aU, s < 0)
        g.lineTo(s * 0.42, Math.sin(aU) * R)
        g.lineTo(s * 0.42, Math.sin(aL) * R)
        g.lineTo(Math.cos(aL) * R, Math.sin(aL) * R)
        g.arc(0, 0, R, aL, a1, s < 0)
      }
    }
    g.lineCap = 'butt'
    g.lineJoin = 'miter'
    // A thin lighter edge around the dark strokes keeps them visible on the dark face
    path()
    g.strokeStyle = edge
    g.lineWidth = w + 0.04
    g.stroke()
    path()
    g.strokeStyle = col
    g.lineWidth = w
    g.stroke()
  })
}

/**
 * Ducati: the shield. A gently arched top with rounded corners, near-straight sides narrowing to a rounded point, a white rim inside
 * the edge, and the name across the upper middle under a curved line
 */
export function shield(g: Ctx, cx: number, cy: number, r: number, fill: string, ink: string, alpha: number, font: string): void {
  unit(g, cx, cy, r, alpha, () => {
    const shape = (k: number): void => {
      g.beginPath()
      g.moveTo(-0.78 * k, -0.62 * k)
      g.quadraticCurveTo(0, -0.84 * k, 0.78 * k, -0.62 * k)
      g.quadraticCurveTo(0.88 * k, -0.59 * k, 0.86 * k, -0.48 * k)
      g.lineTo(0.78 * k, 0.12 * k)
      g.bezierCurveTo(0.7 * k, 0.55 * k, 0.3 * k, 0.8 * k, 0, 0.92 * k)
      g.bezierCurveTo(-0.3 * k, 0.8 * k, -0.7 * k, 0.55 * k, -0.78 * k, 0.12 * k)
      g.lineTo(-0.86 * k, -0.48 * k)
      g.quadraticCurveTo(-0.88 * k, -0.59 * k, -0.78 * k, -0.62 * k)
      g.closePath()
    }
    shape(1)
    g.fillStyle = fill
    g.fill()
    shape(0.9)
    g.strokeStyle = ink
    g.lineWidth = 0.04
    g.stroke()
    // Curved line over the name
    g.beginPath()
    g.moveTo(-0.66, -0.3)
    g.quadraticCurveTo(0, -0.58, 0.66, -0.3)
    g.lineWidth = 0.07
    g.stroke()
    // Text in units of 1/100 (fonts this small in unit coordinates would not render well)
    g.scale(0.01, 0.01)
    g.fillStyle = ink
    g.font = `800 36px ${font}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('DUCATI', 0, -2, 150)
  })
}

/** Union Jack in a disc of radius r: blue field, white saltire with red counterchanged, white cross with red cross */
export function unionJack(g: Ctx, cx: number, cy: number, r: number, alpha: number): void {
  unit(g, cx, cy, r, alpha, () => {
    g.save()
    g.beginPath()
    g.arc(0, 0, 1, 0, TAU)
    g.clip()
    g.fillStyle = '#012169'
    g.fillRect(-1, -1, 2, 2)
    // The saltire runs at the angle of the flag's diagonals (2:1)
    const diag = Math.atan2(1, 2)
    g.lineCap = 'butt'
    for (const s of [1, -1]) {
      g.save()
      g.rotate(s * diag)
      g.fillStyle = '#ffffff'
      g.fillRect(-2, -0.12, 4, 0.24)
      // Red stripe offset to one side on each half (counterchanged)
      g.fillStyle = '#c8102e'
      g.fillRect(-2, s > 0 ? -0.08 : 0, 2, 0.08)
      g.fillRect(0, s > 0 ? 0 : -0.08, 2, 0.08)
      g.restore()
    }
    g.fillStyle = '#ffffff'
    g.fillRect(-2, -0.2, 4, 0.4)
    g.fillRect(-0.2, -2, 0.4, 4)
    g.fillStyle = '#c8102e'
    g.fillRect(-2, -0.12, 4, 0.24)
    g.fillRect(-0.12, -2, 0.24, 4)
    g.restore()
  })
}

/** Moreu: an Ainu swirl, a spiral of `turns` turns from the outside in, starting toward angle a0, turning one way (dir 1 or -1) */
function moreu(g: Ctx, x: number, y: number, r: number, a0: number, dir: 1 | -1, turns = 1.4): void {
  const n = 40
  g.beginPath()
  for (let k = 0; k <= n; k++) {
    const f = k / n
    const a = a0 + dir * f * turns * TAU
    const rr = r * (1 - f * 0.85)
    const px = x + Math.cos(a) * rr
    const py = y + Math.sin(a) * rr
    if (k) g.lineTo(px, py)
    else g.moveTo(px, py)
  }
  g.stroke()
}

/** Aiushi: a thorn, a small pointed spike at (x, y) pointing toward angle a, length l */
function thorn(g: Ctx, x: number, y: number, a: number, l: number, w: number): void {
  const nx = Math.cos(a)
  const ny = Math.sin(a)
  g.beginPath()
  g.moveTo(x - ny * w, y + nx * w)
  g.lineTo(x + nx * l, y + ny * l)
  g.lineTo(x + ny * w, y - nx * w)
  g.closePath()
  g.fill()
}

/** Moreu that continues a line arriving at (x, y) heading toward angle `heading`: the spiral starts there tangentially */
function curlFrom(g: Ctx, x: number, y: number, heading: number, r: number, dir: 1 | -1, turns = 1.3): void {
  const a0 = heading - (dir * Math.PI) / 2
  moreu(g, x - Math.cos(a0) * r, y - Math.sin(a0) * r, r, a0, dir, turns)
}

/**
 * Ainu patterns for the center of a meter, symmetric four ways like embroidered cloth: a double diamond eye (sik) in the middle; up,
 * down, left and right a line runs out, ends in a thorn (aiushi) and splits into a pair of swirls (moreu) curling back; on the
 * diagonals larger swirls with thorns on their outer side; all inside a ring with thorns pointing in. White lines over red, like appliqué
 */
export function ainuCenter(g: Ctx, cx: number, cy: number, r: number, white: string, red: string, alpha: number): void {
  unit(g, cx, cy, r, alpha, () => {
    const draw = (col: string, w: number): void => {
      g.strokeStyle = col
      g.fillStyle = col
      g.lineWidth = w
      g.lineCap = 'round'
      g.lineJoin = 'round'
      // Sik: a double diamond
      for (const d of [0.17, 0.08]) {
        g.beginPath()
        g.moveTo(0, -d)
        g.lineTo(d, 0)
        g.lineTo(0, d)
        g.lineTo(-d, 0)
        g.closePath()
        g.stroke()
      }
      for (let k = 0; k < 4; k++) {
        g.save()
        g.rotate((k * Math.PI) / 2)
        // Axis: a line out from the diamond to a fork; a thorn beyond it, and a pair of swirls curling back
        g.beginPath()
        g.moveTo(0, -0.17)
        g.lineTo(0, -0.44)
        g.stroke()
        thorn(g, 0, -0.47, -Math.PI / 2, 0.14, 0.035)
        for (const sx of [-1, 1] as const) {
          g.beginPath()
          g.moveTo(0, -0.44)
          g.quadraticCurveTo(sx * 0.1, -0.56, sx * 0.22, -0.55)
          g.stroke()
          curlFrom(g, sx * 0.22, -0.55, sx > 0 ? 0.35 : Math.PI - 0.35, 0.09, sx > 0 ? 1 : -1)
          // A smaller pair nearer the diamond, curling the other way
          g.beginPath()
          g.moveTo(0, -0.27)
          g.quadraticCurveTo(sx * 0.08, -0.3, sx * 0.12, -0.36)
          g.stroke()
          curlFrom(g, sx * 0.12, -0.36, sx > 0 ? -1.1 : Math.PI + 1.1, 0.05, sx > 0 ? -1 : 1)
        }
        // Diagonal: an S-curve from beside the diamond out to a large swirl, with thorns on its outer side
        g.rotate(Math.PI / 4)
        g.beginPath()
        g.moveTo(0, -0.2)
        g.bezierCurveTo(0.12, -0.3, -0.12, -0.45, 0.02, -0.6)
        g.stroke()
        curlFrom(g, 0.02, -0.6, -0.9, 0.12, 1, 1.5)
        thorn(g, -0.13, -0.68, -Math.PI / 2 - 0.6, 0.11, 0.03)
        thorn(g, 0.06, -0.78, -Math.PI / 2 + 0.2, 0.11, 0.03)
        g.restore()
      }
      // Ring with thorns pointing in, between the arms
      g.beginPath()
      g.arc(0, 0, 0.92, 0, TAU)
      g.stroke()
      for (let k = 0; k < 8; k++) {
        const a = ((k + 0.5) / 8) * TAU - Math.PI / 2
        thorn(g, Math.cos(a) * 0.92, Math.sin(a) * 0.92, a + Math.PI, 0.13, 0.04)
      }
    }
    draw(red, 0.1)
    draw(white, 0.045)
  })
}

/**
 * Ainu patterns around a ring between radii r0 and r1: a band with a running line that rises into a thorn and falls into a swirl,
 * n times round, white over red
 */
export function ainuBand(g: Ctx, cx: number, cy: number, r0: number, r1: number, band: string, white: string, red: string, n = 16): void {
  g.save()
  g.beginPath()
  g.arc(cx, cy, r1, 0, TAU)
  g.arc(cx, cy, r0, 0, TAU, true)
  g.fillStyle = band
  g.fill()
  const rm = (r0 + r1) / 2
  const h = (r1 - r0) / 2
  const draw = (col: string, w: number): void => {
    g.strokeStyle = col
    g.fillStyle = col
    g.lineWidth = w
    g.lineCap = 'round'
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU
      const b = ((k + 0.5) / n) * TAU
      // A swirl on the middle line, and a thorn pointing out halfway to the next one
      moreu(g, cx + Math.cos(a) * rm, cy + Math.sin(a) * rm, h * 0.75, a + Math.PI / 2, 1, 1.2)
      thorn(g, cx + Math.cos(b) * (rm - h * 0.2), cy + Math.sin(b) * (rm - h * 0.2), b, h * 0.9, h * 0.22)
      thorn(g, cx + Math.cos(b) * (rm + h * 0.2), cy + Math.sin(b) * (rm + h * 0.2), b + Math.PI, h * 0.9, h * 0.22)
    }
    for (const rr of [r0 + w, r1 - w]) {
      g.beginPath()
      g.arc(cx, cy, rr, 0, TAU)
      g.stroke()
    }
  }
  draw(red, Math.max(1.5, h * 0.3))
  draw(white, Math.max(1, h * 0.13))
  g.restore()
}

/** One cherry blossom: five petals with a notch at each tip, a small center with stamens */
export function sakura(g: Ctx, cx: number, cy: number, r: number, petal: string, edge: string, alpha: number, rot = 0): void {
  unit(g, cx, cy, r, alpha, () => {
    g.rotate(rot)
    const petals = (): void => {
      g.beginPath()
      for (let k = 0; k < 5; k++) {
        const a = (k * TAU) / 5
        const c = Math.cos(a)
        const sn = Math.sin(a)
        // Petal pointing up, rotated: points (x, y) -> (x cos - y sin, x sin + y cos)
        const P = (x: number, y: number): [number, number] => [x * c - y * sn, x * sn + y * c]
        g.moveTo(...P(0, -0.1))
        g.bezierCurveTo(...P(-0.42, -0.3), ...P(-0.46, -0.84), ...P(-0.16, -0.98))
        g.lineTo(...P(0, -0.84))
        g.lineTo(...P(0.16, -0.98))
        g.bezierCurveTo(...P(0.46, -0.84), ...P(0.42, -0.3), ...P(0, -0.1))
        g.closePath()
      }
    }
    petals()
    g.fillStyle = petal
    g.fill()
    g.strokeStyle = edge
    g.lineWidth = 0.035
    g.stroke()
    // Stamens and the center
    g.lineWidth = 0.025
    g.fillStyle = edge
    for (let k = 0; k < 10; k++) {
      const a = (k * TAU) / 10 + 0.3
      const l = k % 2 ? 0.3 : 0.38
      g.beginPath()
      g.moveTo(Math.cos(a) * 0.1, Math.sin(a) * 0.1)
      g.lineTo(Math.cos(a) * l, Math.sin(a) * l)
      g.stroke()
      g.beginPath()
      g.arc(Math.cos(a) * l, Math.sin(a) * l, 0.035, 0, TAU)
      g.fill()
    }
    g.beginPath()
    g.arc(0, 0, 0.1, 0, TAU)
    g.fill()
  })
}

/** A single falling petal (an oval with a notch at its tip) */
function petal(g: Ctx, x: number, y: number, s: number, rot: number): void {
  g.save()
  g.translate(x, y)
  g.rotate(rot)
  g.scale(s, s)
  g.beginPath()
  g.moveTo(0, 1)
  g.bezierCurveTo(-0.9, 0.5, -0.7, -0.8, -0.25, -1)
  g.lineTo(0, -0.75)
  g.lineTo(0.25, -1)
  g.bezierCurveTo(0.7, -0.8, 0.9, 0.5, 0, 1)
  g.closePath()
  g.fill()
  g.restore()
}

/**
 * Cherry blossoms scattered over the disc of radius R: a few small blossoms near the rim and petals drifting across, at fixed places
 * (the same in every frame)
 */
export function sakuraScatter(g: Ctx, cx: number, cy: number, R: number, petalCol: string, edge: string): void {
  g.save()
  g.beginPath()
  g.arc(cx, cy, R, 0, TAU)
  g.clip()
  // Fixed pseudo-random places
  let seed = 7
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  g.fillStyle = petalCol
  for (let k = 0; k < 26; k++) {
    const a = rnd() * TAU
    const d = R * (0.55 + rnd() * 0.42)
    petal(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.025 + rnd() * 0.02), rnd() * TAU)
  }
  for (const [a, d, s] of [
    [-2.5, 0.78, 0.11],
    [-0.4, 0.8, 0.09],
    [2.6, 0.74, 0.1],
    [0.7, 0.76, 0.08],
    [1.75, 0.82, 0.07]
  ]) {
    sakura(g, cx + Math.cos(a) * R * d, cy + Math.sin(a) * R * d, R * s, petalCol, edge, 1, a)
  }
  g.restore()
}
