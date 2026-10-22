// Kawasaki: lime green on black. A carbon-weave face inside a twelve-sided bezel with the earlier river-like mark in dark green in the
// middle, glowing lit blocks for the tachometer, slanted sub-dials and panels, italic type.
import { TAU, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { riverMark } from './emblems'

export const KAWASAKI: Theme = {
  id: 'kawasaki',
  name: 'Kawasaki', // i18n-ignore
  pal: {
    line: '#6fd12c',
    line2: '#c8ff3c',
    hot: '#ff2d2d',
    thr: '#6fd12c',
    lean: '#c8ff3c',
    bg0: 'rgba(22, 26, 22, 0.84)',
    bg1: 'rgba(3, 4, 3, 0.88)',
    dim: 'rgba(111,209,44,0.14)',
    text: '#ffffff',
    sub: 'rgba(200,240,170,0.75)',
    // bezel, weave, mark, mark edge
    brand: ['#16191a', 'rgba(255,255,255,0.045)', '#1d5a22', 'rgba(111,209,44,0.35)'],
    stripes: ['#6fd12c', '#ffffff', '#6fd12c']
  },
  look: { font: 'Bahnschrift', weight: 700, italic: true, glow: 0.9, scan: true, panel: 'slant', tach: 'blocks', sub: 'slant' },
  face(g, cx, cy, R, P, _look, grey) {
    const poly = (r: number): void => {
      g.beginPath()
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU + Math.PI / 12
        if (k) g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
        else g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      }
      g.closePath()
    }
    poly(R * 1.0)
    g.fillStyle = P.brand[0]
    g.fill()
    const face = g.createRadialGradient(cx, cy - R * 0.3, R * 0.05, cx, cy, R)
    face.addColorStop(0, P.bg0)
    face.addColorStop(1, P.bg1)
    g.beginPath()
    g.arc(cx, cy, R * 0.94, 0, TAU)
    g.fillStyle = face
    g.fill()
    // Carbon weave: small diagonal checks
    g.save()
    g.beginPath()
    g.arc(cx, cy, R * 0.94, 0, TAU)
    g.clip()
    g.fillStyle = P.brand[1]
    const s = Math.max(3, R * 0.045)
    for (let y = cy - R; y < cy + R; y += s) {
      for (let x = cx - R + (((y - cy) / s) % 2 ? s : 0); x < cx + R; x += s * 2) g.fillRect(x, y, s, s * 0.5)
    }
    g.restore()
    emblemOr(g, 'kawasaki', cx, cy, R * 0.44, grey, () => riverMark(g, cx, cy, R * 0.44, P.brand[2], P.brand[3], 0.9))
  }
}
