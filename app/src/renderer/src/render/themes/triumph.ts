// Triumph: corporate blue with the Union Jack. A polished chrome bezel around a face printed with a muted Union Jack under dark blue
// glass, white numerals, a pointer on a fine scale for the tachometer, round sub-dials, serif type and no glow; enamel-like panels with
// a double rule; red, white and blue stripes.
import { glassDisc, metalRing, TAU, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { unionJack } from './emblems'

export const TRIUMPH: Theme = {
  id: 'triumph',
  name: 'Triumph', // i18n-ignore
  pal: {
    line: '#ffffff',
    line2: '#9cc3ff',
    hot: '#e8112d',
    thr: '#9cc3ff',
    lean: '#ffffff',
    bg0: 'rgba(16, 40, 96, 0.55)',
    bg1: 'rgba(4, 12, 36, 0.86)',
    dim: 'rgba(255,255,255,0.16)',
    text: '#ffffff',
    sub: 'rgba(210,225,255,0.78)',
    // inner rules
    brand: ['rgba(255,255,255,0.4)'],
    stripes: ['#c8102e', '#ffffff', '#3a6fd8']
  },
  look: { font: "'Palatino Linotype', 'Book Antiqua', Georgia", weight: 700, italic: false, glow: 0, scan: false, panel: 'classic', tach: 'needle', sub: 'circle' },
  face(g, cx, cy, R, P, look, grey) {
    metalRing(g, cx, cy, R * 0.9, R * 0.995, '#f4f5f7', '#6b7079')
    unionJack(g, cx, cy, R * 0.9, 1)
    // Dark blue glass over the flag keeps the scales readable
    glassDisc(g, cx, cy, R * 0.9, P, look)
    g.strokeStyle = P.brand[0]
    g.lineWidth = R * 0.005
    for (const r of [0.885, 0.595]) {
      g.beginPath()
      g.arc(cx, cy, R * r, 0, TAU)
      g.stroke()
    }
    // The flag is the background; only a logo of the user's goes on top
    emblemOr(g, 'triumph', cx, cy - R * 0.05, R * 0.4, grey, () => {})
  }
}
