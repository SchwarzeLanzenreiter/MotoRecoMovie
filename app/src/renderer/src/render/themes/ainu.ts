// Ainu patterns: indigo cloth with white and red appliqué. A band of swirls (moreu) and thorns (aiushi) round the bezel, a
// composition of a diamond eye (sik) with swirls and thorns in the middle, a solid bar tachometer, no glow; rounded panels edged with
// thorns and swirls.
import { glassDisc, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { ainuBand, ainuCenter } from './emblems'

export const AINU: Theme = {
  id: 'ainu',
  name: 'Ainu patterns', // i18n-ignore
  pal: {
    line: '#f2ede2',
    line2: '#e9d8b8',
    hot: '#d23a32',
    thr: '#8fb8e8',
    lean: '#f2ede2',
    bg0: 'rgba(28, 42, 78, 0.84)',
    bg1: 'rgba(8, 12, 26, 0.9)',
    dim: 'rgba(242,237,226,0.15)',
    text: '#f8f4ec',
    sub: 'rgba(242,237,226,0.78)',
    // band, white, red
    brand: ['#141f3d', '#f2ede2', '#b3262e'],
    stripes: ['#f2ede2', '#b3262e', '#f2ede2']
  },
  look: { font: 'Bahnschrift', weight: 600, italic: false, glow: 0, scan: false, panel: 'ainu', tach: 'bar', sub: 'circle' },
  face(g, cx, cy, R, P, look, grey) {
    ainuBand(g, cx, cy, R * 0.9, R * 0.995, P.brand[0], P.brand[1], P.brand[2])
    glassDisc(g, cx, cy, R * 0.9, P, look)
    emblemOr(g, 'ainu', cx, cy - R * 0.04, R * 0.44, grey, () => ainuCenter(g, cx, cy - R * 0.04, R * 0.44, P.brand[1], P.brand[2], 0.32))
  }
}
