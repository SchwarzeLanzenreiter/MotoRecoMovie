// KTM: orange on black. A black face with orange hatching low on both sides and angular orange brackets on the bezel, lit blocks for
// the tachometer, hexagon sub-dials, bold upright type and panels with cut corners.
import { emblemOr } from '../logo'
import { glassDisc, TAU, type Theme } from '../theme'

export const KTM: Theme = {
  id: 'ktm',
  name: 'KTM', // i18n-ignore
  pal: {
    line: '#ff6a00',
    line2: '#ffb066',
    hot: '#ff1f1f',
    thr: '#ff6a00',
    lean: '#ffffff',
    bg0: 'rgba(28, 28, 28, 0.84)',
    bg1: 'rgba(4, 4, 4, 0.88)',
    dim: 'rgba(255,106,0,0.15)',
    text: '#ffffff',
    sub: 'rgba(255,214,184,0.78)',
    // hatch, brackets
    brand: ['rgba(255,106,0,0.12)', '#ff6a00'],
    stripes: ['#ff6a00', '#ff6a00', '#ffffff']
  },
  look: { font: 'Bahnschrift', weight: 700, italic: false, glow: 0.5, scan: false, panel: 'chamfer', tach: 'blocks', sub: 'hex' },
  face(g, cx, cy, R, P, look, grey) {
    glassDisc(g, cx, cy, R * 0.96, P, look)
    // Hatching in the lower left and lower right
    g.save()
    g.beginPath()
    g.arc(cx, cy, R * 0.96, 0, TAU)
    g.clip()
    g.strokeStyle = P.brand[0]
    g.lineWidth = R * 0.014
    for (const side of [-1, 1]) {
      for (let k = 0; k < 9; k++) {
        const x = cx + side * (R * 0.55 + k * R * 0.06)
        g.beginPath()
        g.moveTo(x, cy + R)
        g.lineTo(x + side * R * 0.4, cy + R * 0.2)
        g.stroke()
      }
    }
    g.restore()
    // Thin outline, and angular brackets at the four diagonals
    g.strokeStyle = 'rgba(255,255,255,0.25)'
    g.lineWidth = R * 0.008
    g.beginPath()
    g.arc(cx, cy, R * 0.96, 0, TAU)
    g.stroke()
    g.fillStyle = P.brand[1]
    for (const a of [-Math.PI * 0.75, -Math.PI * 0.25, Math.PI * 0.25, Math.PI * 0.75]) {
      g.save()
      g.translate(cx + Math.cos(a) * R * 0.975, cy + Math.sin(a) * R * 0.975)
      g.rotate(a + Math.PI / 2)
      g.beginPath()
      g.moveTo(-R * 0.2, -R * 0.02)
      g.lineTo(R * 0.2, -R * 0.02)
      g.lineTo(R * 0.15, R * 0.035)
      g.lineTo(-R * 0.15, R * 0.035)
      g.closePath()
      g.fill()
      g.restore()
    }
    // No emblem of its own; only a logo of the user's
    emblemOr(g, 'ktm', cx, cy - R * 0.05, R * 0.4, grey, () => {})
  }
}
