// Honda: racing tricolor (red, white, navy). A navy bezel with a red sweep and a white pinstripe along its lower left, like a racing
// livery, and a wing in the middle of the face; a solid bar tachometer and sporty italic type. Slanted panels with tricolor stripes.
import { glassDisc, sector, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { wing } from './emblems'

export const HONDA: Theme = {
  id: 'honda',
  name: 'Honda', // i18n-ignore
  pal: {
    line: '#ffffff',
    line2: '#ff3340',
    hot: '#ff1f2d',
    thr: '#3d7bff',
    lean: '#ff3340',
    bg0: 'rgba(16, 24, 48, 0.8)',
    bg1: 'rgba(3, 6, 16, 0.86)',
    dim: 'rgba(255,255,255,0.13)',
    text: '#ffffff',
    sub: 'rgba(214,224,255,0.75)',
    // navy bezel, red sweep, white pinstripe, wing
    brand: ['#0a2463', '#e60012', '#ffffff', '#e60012'],
    stripes: ['#ffffff', '#e60012', '#1d3f9e']
  },
  look: { font: "'Segoe UI'", weight: 700, italic: true, glow: 0.35, scan: false, panel: 'slant', tach: 'bar', sub: 'round' },
  face(g, cx, cy, R, P, look, grey) {
    glassDisc(g, cx, cy, R * 0.93, P, look)
    emblemOr(g, 'honda', cx, cy - R * 0.05, R * 0.4, grey, () => wing(g, cx, cy - R * 0.05, R * 0.4, P.brand[3], 0.42))
    // Bezel: navy all round, with a red sweep that thickens toward 7 o'clock and a white pinstripe inside it
    sector(g, cx, cy, R * 0.93, R * 0.99, 0, Math.PI * 2, P.brand[0])
    const a0 = Math.PI * 0.5
    const a1 = Math.PI * 1.15
    const n = 24
    g.beginPath()
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n
      const r = R * (0.99 - 0.075 * Math.sin((Math.PI * k) / n))
      if (k) g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      else g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    }
    g.arc(cx, cy, R * 0.99, a1, a0, true)
    g.closePath()
    g.fillStyle = P.brand[1]
    g.fill()
    g.strokeStyle = P.brand[2]
    g.lineWidth = R * 0.008
    g.beginPath()
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n
      const r = R * (0.985 - 0.09 * Math.sin((Math.PI * k) / n))
      if (k) g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      else g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    }
    g.stroke()
  }
}
