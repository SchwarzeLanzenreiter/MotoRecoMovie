// Gallery of the design themes (autotest "themes"): every theme's meter, sign, caption, place label, title, map, elevation profile and
// compass with sample values over a sky-and-road background, one tile per theme, for checking the looks side by side.
import type { Telemetry } from './core/telemetry'
import { drawCompass, drawElevation, drawMap } from './render/gps'
import { hudCaption, hudLabel, hudTitle } from './render/hud'
import { drawMeter, DEFAULT_METER } from './render/meter'
import { drawSignFlat } from './render/signs'
import { greyPal } from './render/theme'
import { THEMES } from './render/themes'

const TW = 1000
const TH = 470

/** A loop of road with some climbs (100 Hz, 60 s) */
function sampleTelemetry(): Telemetry {
  const rate = 100
  const n = 60 * rate
  const ch = { gpsX: new Float32Array(n), gpsY: new Float32Array(n), distance: new Float32Array(n), alt: new Float32Array(n), heading: new Float32Array(n), grade: new Float32Array(n) }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    ch.gpsX[i] = Math.sin(a) * 400 + Math.sin(a * 3) * 80
    ch.gpsY[i] = Math.cos(a) * 300
    ch.distance[i] = (i / n) * 2.6
    ch.alt[i] = 300 + Math.sin(a * 2) * 40 + a * 10
    ch.heading[i] = ((90 - (a * 180) / Math.PI) % 360 + 360) % 360
    ch.grade[i] = Math.cos(a * 2) * 6
  }
  return { rate, n, t0: 0, channels: ch, gps: null }
}

function background(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const sky = g.createLinearGradient(0, y, 0, y + h)
  sky.addColorStop(0, '#6fa8dc')
  sky.addColorStop(0.45, '#cfe2f3')
  sky.addColorStop(0.46, '#5f7a3a')
  sky.addColorStop(0.6, '#7a7a7a')
  sky.addColorStop(1, '#3d3d3d')
  g.fillStyle = sky
  g.fillRect(x, y, w, h)
}

export function drawThemeGallery(c: HTMLCanvasElement, grey = false): void {
  const cols = 2
  c.width = TW * cols
  c.height = TH * Math.ceil(THEMES.length / cols)
  const g = c.getContext('2d')!
  const tel = sampleTelemetry()
  const t = 21
  THEMES.forEach((T0, k) => {
    const T = grey ? { ...T0, pal: greyPal(T0.pal, 1) } : T0
    const x = (k % cols) * TW
    const y = Math.floor(k / cols) * TH
    g.save()
    g.beginPath()
    g.rect(x, y, TW, TH)
    g.clip()
    background(g, x, y, TW, TH)
    drawMeter(g, { x: x + 10, y: y + 50, w: 410, h: 410 }, { rpm: 7300, throttle: 68, brakeFront: 6.5, lean: 38, gear: 4, airTemp: 22 }, DEFAULT_METER, 41, { rpm: 0.6, throttle: 0.6, brake: 0, lean: 1 }, T0, grey ? 0 : 1, null)
    drawSignFlat(g, x + 560, y + 140, 230, T, 45, 1, 85)
    drawSignFlat(g, x + 820, y + 140, 230, T, 140, -1, 160)
    hudCaption(g, 'Shiretoko Pass\n\u77e5\u5e8a\u5ce0', { x: x + 430, y: y + 210, w: 380, h: 100 }, 1, T)
    hudLabel(g, 'Mt. Rausu', x + 840, y + 290, 18, 1, { x, y, w: TW, h: TH }, T)
    drawMap(g, { x: x + 830, y: y + 300, w: 160, h: 160 }, tel, t, { mode: 'route' }, T, 'en')
    drawElevation(g, { x: x + 440, y: y + 315, w: 230, h: 80 }, tel, t, {}, T, 'en')
    drawCompass(g, { x: x + 440, y: y + 410, w: 370, h: 50 }, tel, t, {}, T, 'en')
    g.save()
    g.translate(x + 420, y - 62)
    hudTitle(g, T.name.toUpperCase(), 'DESIGN THEME', 580, 160, 2, 5, T)
    g.restore()
    g.restore()
  })
}
