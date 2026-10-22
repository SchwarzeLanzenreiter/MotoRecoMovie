// BMW: the cyber HUD look in M colors (translucent glass with scan lines, a glowing outer ring in four parts with fine ticks and
// brackets, segmented neon arcs, hexagon sub-dials), with a roundel motif in the middle of the face.
import { arcStroke, glassDisc, TAU, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { roundel } from './emblems'

export const BMW: Theme = {
  id: 'bmw',
  name: 'BMW', // i18n-ignore
  pal: {
    line: '#5cb8ff',
    line2: '#1c69d4',
    hot: '#e7222e',
    thr: '#5cb8ff',
    lean: '#8fd0ff',
    bg0: 'rgba(14, 30, 58, 0.72)',
    bg1: 'rgba(2, 6, 14, 0.78)',
    dim: 'rgba(92,184,255,0.13)',
    text: '#e8f4ff',
    sub: 'rgba(160,210,255,0.7)',
    // roundel: blue, white, ring, silver
    brand: ['rgba(0,102,177,0.5)', 'rgba(232,240,248,0.17)', 'rgba(4,6,10,0.6)', 'rgba(200,210,222,0.6)'],
    stripes: ['#5cb8ff', '#1c69d4', '#e7222e']
  },
  look: { font: "Bahnschrift, 'Cascadia Mono', Consolas", weight: 600, italic: false, glow: 1, scan: true, panel: 'chamfer', tach: 'blocks', sub: 'hex' },
  face(g, cx, cy, R, P, look, grey) {
    glassDisc(g, cx, cy, R * 0.96, P, look)
    emblemOr(g, 'bmw', cx, cy, R * 0.42, grey, () => roundel(g, cx, cy, R * 0.42, P.brand[0], P.brand[1], P.brand[2], P.brand[3]))
    // Outer ring: glowing ring split into 4 parts, with gaps at 3, 6, 9 and 12 o'clock
    g.save()
    g.globalAlpha *= 0.9
    g.shadowColor = P.line
    g.shadowBlur = Math.min(28, R * 0.05)
    for (let q = 0; q < 4; q++) arcStroke(g, cx, cy, R * 0.96, (q * Math.PI) / 2 + 0.07, ((q + 1) * Math.PI) / 2 - 0.07, R * 0.012, P.line)
    g.restore()
    // Fine ticks on the outer ring
    for (let k = 0; k < 120; k++) {
      const a = (k / 120) * TAU
      const major = k % 10 === 0
      g.strokeStyle = major ? P.sub : 'rgba(255,255,255,0.18)'
      g.lineWidth = R * (major ? 0.008 : 0.004)
      g.beginPath()
      g.moveTo(cx + Math.cos(a) * R * 0.915, cy + Math.sin(a) * R * 0.915)
      g.lineTo(cx + Math.cos(a) * R * (major ? 0.885 : 0.9), cy + Math.sin(a) * R * (major ? 0.885 : 0.9))
      g.stroke()
    }
    // Brackets in the 4 diagonal directions
    for (const a of [-Math.PI * 0.75, -Math.PI * 0.25, Math.PI * 0.25, Math.PI * 0.75]) arcStroke(g, cx, cy, R, a - 0.09, a + 0.09, R * 0.012, P.line)
  }
}
