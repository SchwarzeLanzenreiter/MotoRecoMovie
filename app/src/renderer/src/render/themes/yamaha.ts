// Yamaha: racing blue and cyan with white. A deep blue face with fine speed lines across the lower half, three tuning forks in the
// middle, a white rim and a cyan inner ring; an analog pointer on a fine scale for the tachometer, italic racing type. Panels with a blue
// bar down the left.
import { glassDisc, TAU, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { tuningForks } from './emblems'

export const YAMAHA: Theme = {
  id: 'yamaha',
  name: 'Yamaha', // i18n-ignore
  pal: {
    line: '#ffffff',
    line2: '#19b5f0',
    hot: '#ff3048',
    thr: '#19b5f0',
    lean: '#19b5f0',
    bg0: 'rgba(14, 52, 140, 0.78)',
    bg1: 'rgba(2, 10, 34, 0.86)',
    dim: 'rgba(160,215,255,0.15)',
    text: '#ffffff',
    sub: 'rgba(190,225,255,0.78)',
    // speed lines, rim, inner ring, tuning forks
    brand: ['rgba(255,255,255,0.09)', '#ffffff', '#19b5f0', '#ffffff'],
    stripes: ['#ffffff', '#19b5f0', '#1446b8']
  },
  look: { font: 'Bahnschrift', weight: 700, italic: true, glow: 0.7, scan: false, panel: 'tab', tach: 'needle', sub: 'circle' },
  face(g, cx, cy, R, P, look, grey) {
    glassDisc(g, cx, cy, R * 0.96, P, look)
    // Speed lines: slanted thin lines across the lower half
    g.save()
    g.beginPath()
    g.arc(cx, cy, R * 0.96, 0, TAU)
    g.clip()
    g.strokeStyle = P.brand[0]
    g.lineWidth = R * 0.012
    for (let k = -6; k <= 6; k++) {
      const x = cx + k * R * 0.13
      g.beginPath()
      g.moveTo(x - R * 0.3, cy + R)
      g.lineTo(x + R * 0.15, cy + R * 0.12)
      g.stroke()
    }
    g.restore()
    emblemOr(g, 'yamaha', cx, cy - R * 0.04, R * 0.42, grey, () => tuningForks(g, cx, cy - R * 0.04, R * 0.42, P.brand[3], 0.32))
    g.strokeStyle = P.brand[1]
    g.lineWidth = R * 0.018
    g.beginPath()
    g.arc(cx, cy, R * 0.97, 0, TAU)
    g.stroke()
    g.strokeStyle = P.brand[2]
    g.lineWidth = R * 0.006
    g.beginPath()
    g.arc(cx, cy, R * 0.915, 0, TAU)
    g.stroke()
  }
}
