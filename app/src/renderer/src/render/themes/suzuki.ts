// Suzuki: champion yellow with racing blue. A yellow metallic bezel around a dark blue face with a red angular S in the middle, a
// yellow bar tachometer and lean bar, blue throttle; plain upright type and rounded panels.
import { glassDisc, TAU, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { angularS } from './emblems'

export const SUZUKI: Theme = {
  id: 'suzuki',
  name: 'Suzuki', // i18n-ignore
  pal: {
    line: '#ffd200',
    line2: '#ffb300',
    hot: '#ff2a2a',
    thr: '#3d8bff',
    lean: '#ffd200',
    bg0: 'rgba(10, 36, 92, 0.8)',
    bg1: 'rgba(2, 10, 30, 0.86)',
    dim: 'rgba(255,210,0,0.15)',
    text: '#ffffff',
    sub: 'rgba(255,232,140,0.82)',
    // bezel (light, dark), inner rule, S
    brand: ['#ffe45c', '#b58a00', 'rgba(255,210,0,0.5)', '#e60012'],
    stripes: ['#ffd200', '#0a4fc0', '#ffd200']
  },
  look: { font: 'Bahnschrift', weight: 600, italic: false, glow: 0.35, scan: false, panel: 'round', tach: 'bar', sub: 'circle' },
  face(g, cx, cy, R, P, look, grey) {
    // Yellow metallic bezel
    const gr = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
    gr.addColorStop(0, P.brand[0])
    gr.addColorStop(0.4, P.brand[1])
    gr.addColorStop(0.65, P.brand[0])
    gr.addColorStop(1, P.brand[1])
    g.beginPath()
    g.arc(cx, cy, R * 0.99, 0, TAU)
    g.arc(cx, cy, R * 0.92, 0, TAU, true)
    g.fillStyle = gr
    g.fill()
    glassDisc(g, cx, cy, R * 0.92, P, look)
    emblemOr(g, 'suzuki', cx, cy - R * 0.05, R * 0.36, grey, () => angularS(g, cx, cy - R * 0.05, R * 0.36, P.brand[3], 0.62))
    g.strokeStyle = P.brand[2]
    g.lineWidth = R * 0.006
    g.beginPath()
    g.arc(cx, cy, R * 0.6, 0, TAU)
    g.stroke()
  }
}
