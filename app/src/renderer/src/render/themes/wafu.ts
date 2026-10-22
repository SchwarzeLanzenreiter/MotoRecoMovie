// Japanese: lacquer black with vermilion and gold, and cherry blossoms. A vermilion lacquer bezel with a gold rim around a black face
// with blossoms and petals scattered near the rim and a large blossom in the middle, a vermilion bar tachometer, Mincho type, no glow;
// panels with notched corners and a gold rule.
import { glassDisc, metalRing, sector, TAU, type Theme } from '../theme'
import { emblemOr } from '../logo'
import { sakura, sakuraScatter } from './emblems'

export const WAFU: Theme = {
  id: 'wafu',
  name: 'Japanese', // i18n-ignore
  pal: {
    line: '#d9b25f',
    line2: '#f0d48a',
    hot: '#e0452b',
    thr: '#7fb7a0',
    lean: '#e0452b',
    bg0: 'rgba(34, 24, 20, 0.86)',
    bg1: 'rgba(10, 6, 5, 0.9)',
    dim: 'rgba(217,178,95,0.16)',
    text: '#f5ecd9',
    sub: 'rgba(217,178,95,0.88)',
    // vermilion bezel (light, dark), scattered petals, blossom petals, blossom edge
    brand: ['#c8402a', '#7a1d10', 'rgba(244,182,194,0.32)', 'rgba(244,182,194,0.55)', 'rgba(217,178,95,0.85)'],
    stripes: ['#e0452b', '#d9b25f', '#e0452b']
  },
  look: { font: "'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'MS PMincho', serif", weight: 600, italic: false, glow: 0, scan: false, panel: 'wafu', tach: 'bar', sub: 'circle' },
  face(g, cx, cy, R, P, look, grey) {
    const bz = g.createLinearGradient(cx, cy - R, cx, cy + R)
    bz.addColorStop(0, P.brand[0])
    bz.addColorStop(1, P.brand[1])
    sector(g, cx, cy, R * 0.9, R * 0.985, 0, TAU, bz)
    metalRing(g, cx, cy, R * 0.985, R, '#f3dc9a', '#8a6a24')
    glassDisc(g, cx, cy, R * 0.9, P, look)
    sakuraScatter(g, cx, cy, R * 0.9, P.brand[2], P.brand[4])
    emblemOr(g, 'wafu', cx, cy - R * 0.04, R * 0.4, grey, () => sakura(g, cx, cy - R * 0.04, R * 0.4, P.brand[3], P.brand[4], 0.45, -Math.PI / 10))
    metalRing(g, cx, cy, R * 0.895, R * 0.905, '#f3dc9a', '#8a6a24')
  }
}
