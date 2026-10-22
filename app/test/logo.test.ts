// Meter logo (core/logo.ts): tolerant parsing of logos.json with clamping, the circle shown, and making the background
// transparent with a flood fill from the border (highlights inside the emblem must survive), with synthetic images.
// Run: npx tsx test/logo.test.ts
import assert from 'node:assert/strict'
import { circleRect, clampCircle, DEFAULT_LOGO, defaultCircle, keyBackground, MAX_R, MIN_R, parseLogos, stringifyLogos, type MeterLogo } from '../src/renderer/src/core/logo'

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps

// ---- Parsing: garbage gives nothing, a good entry is kept, numbers are clamped ----
{
  assert.deepEqual(parseLogos(''), {})
  assert.deepEqual(parseLogos('not json'), {})
  assert.deepEqual(parseLogos('null'), {})
  assert.deepEqual(parseLogos('[1,2]'), {})
  assert.deepEqual(parseLogos('{"version":1}'), {})
  assert.deepEqual(parseLogos('{"version":1,"logos":[]}'), {})
  const good: MeterLogo = { file: 'honda-1.png', circle: { x: 0.3, y: 0.7, r: 0.4 }, keyBg: false, keyAll: true, tolerance: 35, size: 1.2, opacity: 0.8 }
  assert.deepEqual(parseLogos(stringifyLogos({ honda: good })), { honda: good })
  // Entries that cannot be used are dropped, the others stay
  const r = parseLogos(JSON.stringify({ version: 1, logos: { a: 5, b: null, c: { file: 3 }, d: { file: '' }, e: { file: '../x.png' }, f: { file: 'a/b.png' }, ok: { file: 'ok.png' } } }))
  assert.deepEqual(Object.keys(r), ['ok'])
  assert.deepEqual(r.ok, { file: 'ok.png', ...DEFAULT_LOGO })
  // Clamped to the ranges
  const c = parseLogos(JSON.stringify({ logos: { x: { file: 'x.png', circle: { x: 1.7, y: -3, r: 9 }, keyBg: 'yes', tolerance: 500, size: 9, opacity: 0 } } })).x
  assert.ok(near(c.circle.x, 1) && near(c.circle.y, 0) && near(c.circle.r, MAX_R), 'circle clamped')
  assert.equal(c.keyBg, true)
  assert.equal(c.tolerance, 100)
  assert.equal(c.size, 1.5)
  assert.equal(c.opacity, 0.1)
  const d = parseLogos(JSON.stringify({ logos: { x: { file: 'x.png', tolerance: -4, size: 0.01, opacity: 7, circle: { x: 'a', r: 0 } } } })).x
  assert.equal(d.tolerance, 0)
  assert.equal(d.size, 0.3)
  assert.equal(d.opacity, 1)
  assert.deepEqual(d.circle, { x: 0.5, y: 0.5, r: MIN_R })
  // An old entry with a crop (not released) just gets the default circle
  assert.deepEqual(parseLogos('{"logos":{"x":{"file":"x.png","crop":{"x":0,"y":0,"w":0.5,"h":0.5}}}}').x.circle, DEFAULT_LOGO.circle)
  // A key that would set the prototype is ignored
  assert.deepEqual(parseLogos('{"logos":{"__proto__":{"file":"p.png"}}}'), {})
  assert.deepEqual(clampCircle({ x: 2, y: -1, r: 3 }), { x: 1, y: 0, r: MAX_R })
  assert.deepEqual(clampCircle({ x: NaN, y: 0.2, r: 0 }), { x: 0.5, y: 0.2, r: MIN_R })
}

// ---- The circle: default, and its square in image pixels ----
{
  assert.deepEqual(DEFAULT_LOGO.circle, { x: 0.5, y: 0.5, r: 0.5 })
  assert.deepEqual(defaultCircle(100, 100), { x: 0.5, y: 0.5, r: 0.5 })
  const w = defaultCircle(200, 100) // inscribed: radius 50 px = 0.25 of the long side
  assert.ok(near(w.r, 0.25) && w.x === 0.5 && w.y === 0.5)
  assert.ok(near(defaultCircle(100, 300).r, 1 / 6))
  assert.deepEqual(defaultCircle(0, 0), DEFAULT_LOGO.circle)
  // Square of the inscribed circle of a 200x100 image: 100 px side, centered
  const q = circleRect(w, 200, 100)
  assert.ok(near(q.side, 100) && near(q.sx, 50) && near(q.sy, 0))
  // A circle past the edge: radius 0.5 of the long side (100 px) centered at the top left corner
  const e = circleRect({ x: 0, y: 0, r: 0.5 }, 200, 100)
  assert.ok(near(e.side, 200) && near(e.sx, -100) && near(e.sy, -100))
  // Tall image: the radius counts in the long side (height)
  const t = circleRect({ x: 0.5, y: 0.25, r: 0.1 }, 100, 400)
  assert.ok(near(t.side, 80) && near(t.sx, 10) && near(t.sy, 60))
}

// ---- Background keying ----
const W = 12
const H = 12
const make = (f: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray => {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(f(x, y), (y * W + x) * 4)
  return d
}
const px = (d: Uint8ClampedArray, x: number, y: number): number[] => Array.from(d.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))
const inRed = (x: number, y: number): boolean => x >= 3 && x <= 8 && y >= 3 && y <= 8
{
  // White border and background, a red square, and a white pixel enclosed in the red
  const d = make((x, y) => (x === 5 && y === 5 ? [255, 255, 255, 255] : inRed(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255]))
  keyBackground(d, W, H, 20)
  assert.equal(px(d, 0, 0)[3], 0)
  assert.equal(px(d, 11, 11)[3], 0)
  assert.equal(px(d, 1, 6)[3], 0)
  assert.equal(px(d, 9, 9)[3], 0, 'background right next to the square')
  assert.deepEqual(px(d, 4, 4), [255, 0, 0, 255])
  assert.deepEqual(px(d, 5, 5), [255, 255, 255, 255], 'enclosed highlight stays opaque')
  assert.deepEqual(px(d, 3, 3), [255, 0, 0, 255])
  // everywhere: the enclosed white pixel becomes transparent too, the red stays
  const e = make((x, y) => (x === 5 && y === 5 ? [255, 255, 255, 255] : inRed(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255]))
  keyBackground(e, W, H, 20, true)
  assert.equal(px(e, 5, 5)[3], 0, 'enclosed highlight removed')
  assert.equal(px(e, 0, 0)[3], 0)
  assert.deepEqual(px(e, 4, 4), [255, 0, 0, 255])
  assert.deepEqual(px(e, 3, 3), [255, 0, 0, 255])
  // and with the default it stays
  const f = make((x, y) => (x === 5 && y === 5 ? [255, 255, 255, 255] : inRed(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255]))
  keyBackground(f, W, H, 20, false)
  assert.equal(px(f, 5, 5)[3], 255)
}
{
  // Tolerance 0: a near-white background is not removed, an exact one is
  const d = make((x, y) => (inRed(x, y) ? [255, 0, 0, 255] : [250, 250, 250, 255]))
  keyBackground(d, W, H, 0)
  assert.equal(px(d, 0, 0)[3], 0, 'exact match of the reference color')
  const e = make((x, y) => (inRed(x, y) ? [255, 0, 0, 255] : x === 0 && y === 0 ? [240, 240, 240, 255] : [250, 250, 250, 255]))
  keyBackground(e, W, H, 0)
  assert.equal(px(e, 0, 0)[3], 255, 'not an exact match')
  assert.equal(px(e, 1, 1)[3], 0)
}
{
  // Soft edge: a pixel between T and 1.6 T from the background next to the fill gets a partial alpha, one beyond 1.6 T stays
  // tolerance 20 -> T = 51; (215,215,215) is 69.3 away = alpha 255 * (69.3 - 51) / 30.6 = 152
  const d = make((x, y) => (x === 3 && y === 6 ? [215, 215, 215, 255] : x === 9 && y === 6 ? [150, 150, 150, 255] : inRed(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255]))
  keyBackground(d, W, H, 20)
  const a = px(d, 3, 6)[3]
  assert.ok(a > 120 && a < 180, `soft edge alpha ${a}`)
  assert.equal(px(d, 9, 6)[3], 255)
  // Inside T from the reference: background
  const e = make((x, y) => (x === 0 && y === 0 ? [235, 235, 235, 255] : inRed(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255]))
  keyBackground(e, W, H, 20)
  assert.equal(px(e, 0, 0)[3], 0)
}
{
  // The reference is the most common border color, not a corner
  const d = make((x, y) => (inRed(x, y) ? [255, 0, 0, 255] : x === 0 && y < 3 ? [0, 0, 255, 255] : [20, 30, 40, 255]))
  keyBackground(d, W, H, 10)
  assert.equal(px(d, 5, 0)[3], 0)
  assert.equal(px(d, 0, 1)[3], 255, 'a differently colored border pixel is kept')
  assert.deepEqual(px(d, 4, 4), [255, 0, 0, 255])
}
{
  // An already transparent border: nothing else is touched, dark pixels next to it included
  const d = make((x, y) => (inRed(x, y) ? ((x + y) % 2 ? [0, 0, 0, 255] : [255, 0, 0, 255]) : [0, 0, 0, 0]))
  const before = Uint8ClampedArray.from(d)
  keyBackground(d, W, H, 30)
  assert.deepEqual(d, before)
}
{
  // An emblem touching the border is not eaten, and a tiny image does not crash
  const d = make((x) => (x < 4 ? [255, 0, 0, 255] : [255, 255, 255, 255]))
  keyBackground(d, W, H, 20)
  assert.equal(px(d, 0, 5)[3], 255)
  assert.equal(px(d, 11, 5)[3], 0)
  const one = new Uint8ClampedArray([10, 20, 30, 255])
  keyBackground(one, 1, 1, 20)
  assert.equal(one[3], 0)
  keyBackground(new Uint8ClampedArray(0), 0, 0, 20)
}
console.log('logo.test: OK')
