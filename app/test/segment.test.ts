// Instance segmentation post-processing (core/segment.ts):
//   1. synthetic outputs: one strong cell decodes to the right class and box, an overlapping weaker box of the same class is dropped,
//      one of another class is kept, and the mask head computes what a direct evaluation gives
//   2. optional, on real outputs saved by proto (raw tensors + the reference decoder's result as JSON):
//      the same instances, boxes and mask areas as the Python reference
// Run: npx tsx test/segment.test.ts [<outputs.raw> <reference.json>]
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeInstances, instanceMask, MASK_FEAT, SEG_SIZE, SEG_STRIDES, type SegOutputs } from '../src/renderer/src/core/segment'

const levels = SEG_STRIDES.map((s) => SEG_SIZE / s)
function empty(): SegOutputs {
  return {
    cls: levels.map((w) => new Float32Array(80 * w * w).fill(-10)),
    box: levels.map((w) => new Float32Array(4 * w * w)),
    kernel: levels.map((w) => new Float32Array(169 * w * w)),
    maskFeat: new Float32Array(8 * MASK_FEAT * MASK_FEAT)
  }
}
const put = (o: SegOutputs, li: number, x: number, y: number, cls: number, logit: number, ltrb: number[]): void => {
  const w = levels[li]
  const n = w * w
  const p = y * w + x
  o.cls[li][cls * n + p] = logit
  ltrb.forEach((v, k) => (o.box[li][k * n + p] = v))
}

// 1. Synthetic
{
  const o = empty()
  put(o, 1, 10, 12, 0, 3, [20, 30, 40, 50]) // person at (160, 192) on the stride-16 level
  put(o, 1, 11, 12, 0, 1, [24, 30, 36, 50]) // weaker, overlapping person: dropped
  put(o, 0, 21, 25, 3, 2, [20, 30, 40, 50]) // motorcycle at (168, 200) on the stride-8 level: other class, kept
  const d = decodeInstances(o, { scoreThr: 0.3 })
  assert.equal(d.length, 2)
  assert.equal(d[0].cls, 0)
  assert.deepEqual([d[0].x0, d[0].y0, d[0].x1, d[0].y1], [140, 162, 200, 242])
  assert.ok(Math.abs(d[0].score - 1 / (1 + Math.exp(-3))) < 1e-6)
  assert.equal(d[1].cls, 3)
  assert.equal(decodeInstances(o, { scoreThr: 0.3, classes: [3] }).length, 1, 'class filter')
  // Mask head: compare with a direct evaluation at a few pixels
  const k = new Float32Array(169).map((_, i) => Math.sin(i * 1.7) * 0.5)
  d[0].kernel = k
  for (let i = 0; i < o.maskFeat.length; i++) o.maskFeat[i] = Math.cos(i * 0.013)
  const m = instanceMask(d[0], o.maskFeat)
  const n = MASK_FEAT * MASK_FEAT
  for (const [gx, gy] of [[0, 0], [20, 24], [79, 79]]) {
    const p = gy * MASK_FEAT + gx
    const x = [(160 - gx * 8) / 128, (192 - gy * 8) / 128, ...Array.from({ length: 8 }, (_, c) => o.maskFeat[c * n + p])]
    const relu = (v: number): number => Math.max(0, v)
    const h1 = Array.from({ length: 8 }, (_, a) => relu(k[152 + a] + x.reduce((s, xi, i) => s + k[a * 10 + i] * xi, 0)))
    const h2 = Array.from({ length: 8 }, (_, a) => relu(k[160 + a] + h1.reduce((s, hi, i) => s + k[80 + a * 8 + i] * hi, 0)))
    const z = k[168] + h2.reduce((s, hi, i) => s + k[144 + i] * hi, 0)
    assert.ok(Math.abs(m[p] - 1 / (1 + Math.exp(-z))) < 1e-5, `mask at ${gx},${gy}`)
  }
}

// 2. Real outputs against the Python reference
const [rawPath, refPath] = process.argv.slice(2)
if (rawPath && refPath) {
  const buf = readFileSync(rawPath)
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  let off = 0
  const take = (len: number): Float32Array => {
    const a = all.subarray(off, off + len)
    off += len
    return a
  }
  const o: SegOutputs = { cls: levels.map((w) => take(80 * w * w)), box: levels.map((w) => take(4 * w * w)), kernel: levels.map((w) => take(169 * w * w)), maskFeat: take(8 * MASK_FEAT * MASK_FEAT) }
  assert.equal(off, all.length, 'all outputs read')
  const ref = JSON.parse(readFileSync(refPath, 'utf-8')) as { cls: number; score: number; box: number[]; maskSum: number }[]
  const d = decodeInstances(o, { scoreThr: 0.25 })
  assert.equal(d.length, ref.length, 'same number of instances')
  d.forEach((x, i) => {
    assert.equal(x.cls, ref[i].cls)
    assert.ok(Math.abs(x.score - ref[i].score) < 1e-4)
    ;[x.x0, x.y0, x.x1, x.y1].forEach((v, j) => assert.ok(Math.abs(v - ref[i].box[j]) < 1e-3, 'box'))
    const sum = instanceMask(x, o.maskFeat).reduce((s, v) => s + v, 0)
    assert.ok(Math.abs(sum - ref[i].maskSum) < 1e-2 * Math.max(1, ref[i].maskSum), `mask of instance ${i}: ${sum} vs ${ref[i].maskSum}`)
  })
  console.log(`real outputs: ${d.length} instances match the Python reference`)
}
console.log('segment.test: OK')
