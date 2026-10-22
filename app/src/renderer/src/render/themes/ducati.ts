// Ducati: racing red, gloss black and white, with an Italian tricolor accent. A red bezel around a gloss black face with a soft
// highlight and the red shield in the middle, a solid bar tachometer in white, clean upright type and rounded panels.
import { glassDisc, sector, TAU, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { shield } from './emblems'

export const DUCATI: Theme = {
  id: 'ducati',
  name: 'Ducati', // i18n-ignore
  pal: {
    line: '#ffffff',
    line2: '#ff4a4a',
    hot: '#ff1a1a',
    thr: '#ffffff',
    lean: '#e3101d',
    bg0: 'rgba(30, 30, 32, 0.84)',
    bg1: 'rgba(5, 5, 6, 0.88)',
    dim: 'rgba(255,255,255,0.13)',
    text: '#ffffff',
    sub: 'rgba(235,235,235,0.72)',
    // bezel red (light, dark), highlight, shield, shield ink
    brand: ['#e3101d', '#8c0008', 'rgba(255,255,255,0.07)', '#c8101d', '#ffffff'],
    stripes: ['#009246', '#ffffff', '#ce2b37']
  },
  look: { font: "'Segoe UI'", weight: 600, italic: false, glow: 0.25, scan: false, panel: 'round', tach: 'bar', sub: 'round' },
  face(g, cx, cy, R, P, look, grey) {
    const bz = g.createLinearGradient(cx, cy - R, cx, cy + R)
    bz.addColorStop(0, P.brand[0])
    bz.addColorStop(1, P.brand[1])
    sector(g, cx, cy, R * 0.92, R * 0.99, 0, TAU, bz)
    glassDisc(g, cx, cy, R * 0.92, P, look)
    emblemOr(g, 'ducati', cx, cy + R * 0.13, R * 0.42, grey, () => shield(g, cx, cy + R * 0.13, R * 0.42, P.brand[3], P.brand[4], 0.5, look.font))
    // Gloss: a soft highlight over the top of the face
    const hl = g.createLinearGradient(cx, cy - R * 0.92, cx, cy)
    hl.addColorStop(0, P.brand[2])
    hl.addColorStop(1, 'rgba(255,255,255,0)')
    g.beginPath()
    g.ellipse(cx, cy - R * 0.45, R * 0.8, R * 0.47, 0, 0, TAU)
    g.fillStyle = hl
    g.fill()
  }
}
