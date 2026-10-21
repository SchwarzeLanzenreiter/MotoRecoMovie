// Pre- and post-processing for instance segmentation (RTMDet-Ins tiny, 80 COCO classes). Inference itself is in engine/segmenter.ts.
//
// Model: rtmdet_ins_tiny.onnx, exported from mmdetection's RTMDet-Ins tiny (Apache-2.0) by proto/export_rtmdet_ins.py.
// The graph holds the network only. Input 1×3×640×640 (BGR, mmdet mean/std). Outputs per level (stride 8, 16, 32):
//   cls  [1,80,h,w]  class logits
//   box  [1,4,h,w]   distances from the point to the left, top, right, bottom edges [pixels]
//   kernel [1,169,h,w] parameters of the instance's mask head (3 dynamic 1×1 convolutions: 10→8, 8→8, 8→1, weights then biases)
// and mask_feat [1,8,80,80] (stride 8). Decoding below follows mmdetection's RTMDetInsSepBNHead.predict_by_feat
// (checked against it on the same outputs in proto/export_rtmdet_ins.py --check).

export const SEG_SIZE = 640
export const SEG_STRIDES = [8, 16, 32]
/** Size of the mask feature (and of the instance masks) */
export const MASK_FEAT = SEG_SIZE / 8
const NUM_CLASSES = 80
const KERNEL = 169

/** COCO classes used by the app */
export const COCO = { person: 0, bicycle: 1, car: 2, motorcycle: 3, bus: 5, truck: 7 } as const

const MEAN = [103.53, 116.28, 123.675] // B, G, R
const STD = [57.375, 57.12, 58.395]

/** RGBA (from the top row, SEG_SIZE square) → model input (BGR planes, normalized) */
export function toSegInput(rgba: Uint8Array | Uint8ClampedArray): Float32Array {
  const n = SEG_SIZE * SEG_SIZE
  const out = new Float32Array(3 * n)
  for (let p = 0; p < n; p++) {
    out[p] = (rgba[p * 4 + 2] - MEAN[0]) / STD[0]
    out[n + p] = (rgba[p * 4 + 1] - MEAN[1]) / STD[1]
    out[2 * n + p] = (rgba[p * 4] - MEAN[2]) / STD[2]
  }
  return out
}

/** Raw outputs of the network (data of the tensors, in the order of the levels) */
export interface SegOutputs {
  cls: Float32Array[]
  box: Float32Array[]
  kernel: Float32Array[]
  maskFeat: Float32Array
}

export interface SegInstance {
  /** Box [pixels of the 640 input] */
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
  cls: number
  /** Parameters of the mask head and the point the instance was found at (for instanceMask) */
  kernel: Float32Array
  px: number
  py: number
  stride: number
}

/**
 * Instances of the given classes (all if omitted) with a score of at least scoreThr, overlaps of the same class removed (IoU above iou),
 * at most maxDet, highest score first
 */
export function decodeInstances(o: SegOutputs, opts: { scoreThr?: number; iou?: number; maxDet?: number; classes?: number[] } = {}): SegInstance[] {
  const thr = opts.scoreThr ?? 0.3
  const logit = Math.log(thr / (1 - thr))
  const classes = opts.classes ?? Array.from({ length: NUM_CLASSES }, (_, c) => c)
  const cand: SegInstance[] = []
  SEG_STRIDES.forEach((st, li) => {
    const w = SEG_SIZE / st
    const n = w * w
    const cls = o.cls[li]
    const box = o.box[li]
    const ker = o.kernel[li]
    for (const c of classes) {
      for (let p = 0; p < n; p++) {
        const z = cls[c * n + p]
        if (z < logit) continue
        const y = (p / w) | 0
        const x = p - y * w
        const px = x * st
        const py = y * st
        const k = new Float32Array(KERNEL)
        for (let j = 0; j < KERNEL; j++) k[j] = ker[j * n + p]
        cand.push({ x0: px - box[p], y0: py - box[n + p], x1: px + box[2 * n + p], y1: py + box[3 * n + p], score: 1 / (1 + Math.exp(-z)), cls: c, kernel: k, px, py, stride: st })
      }
    }
  })
  cand.sort((a, b) => b.score - a.score)
  const iouMax = opts.iou ?? 0.6
  const maxDet = opts.maxDet ?? 100
  const keep: SegInstance[] = []
  for (const d of cand) {
    if (keep.every((e) => e.cls !== d.cls || iou(d, e) <= iouMax)) keep.push(d)
    if (keep.length >= maxDet) break
  }
  return keep
}

function iou(a: SegInstance, b: SegInstance): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const inter = ix * iy
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter + 1e-9)
}

/** Cells of the mask grid [gx0, gx1) × [gy0, gy1) */
export interface MaskRegion {
  gx0: number
  gy0: number
  gx1: number
  gy1: number
}

/** The mask cells around an instance's box, with a margin (the outline rarely leaves its box by much). Most of the mask is never computed */
export function boxRegion(inst: SegInstance, marginCells = 3): MaskRegion {
  const c = (v: number): number => Math.max(0, Math.min(MASK_FEAT, v))
  const mx = (inst.x1 - inst.x0) * 0.1
  const my = (inst.y1 - inst.y0) * 0.1
  return {
    gx0: c(Math.floor((inst.x0 - mx) / 8) - marginCells),
    gy0: c(Math.floor((inst.y0 - my) / 8) - marginCells),
    gx1: c(Math.ceil((inst.x1 + mx) / 8) + marginCells),
    gy1: c(Math.ceil((inst.y1 + my) / 8) + marginCells)
  }
}

/**
 * Mask of an instance (MASK_FEAT × MASK_FEAT probabilities, stride 8 over the 640 input): the mask feature plus the coordinates relative to the
 * instance's point (in units of 8 × its stride) through the instance's three 1×1 convolutions. With region, only those cells (0 elsewhere)
 */
export function instanceMask(inst: SegInstance, maskFeat: Float32Array, region?: MaskRegion): Float32Array {
  const n = MASK_FEAT * MASK_FEAT
  const k = inst.kernel
  const out = new Float32Array(n)
  const x = new Float32Array(10)
  const h1 = new Float32Array(8)
  const s = inst.stride * 8
  const r = region ?? { gx0: 0, gy0: 0, gx1: MASK_FEAT, gy1: MASK_FEAT }
  for (let gy = r.gy0; gy < r.gy1; gy++) for (let gx = r.gx0; gx < r.gx1; gx++) {
    const p = gy * MASK_FEAT + gx
    x[0] = (inst.px - gx * 8) / s
    x[1] = (inst.py - gy * 8) / s
    for (let c = 0; c < 8; c++) x[2 + c] = maskFeat[c * n + p]
    // Layer 1: 10 → 8 (weights k[0..80), biases k[152..160))
    for (let o = 0; o < 8; o++) {
      let v = k[152 + o]
      for (let i = 0; i < 10; i++) v += k[o * 10 + i] * x[i]
      h1[o] = v > 0 ? v : 0
    }
    // Layer 2: 8 → 8 (weights k[80..144), biases k[160..168)), then layer 3: 8 → 1 (weights k[144..152), bias k[168])
    let z = k[168]
    for (let o = 0; o < 8; o++) {
      let v = k[160 + o]
      for (let i = 0; i < 8; i++) v += k[80 + o * 8 + i] * h1[i]
      if (v > 0) z += k[144 + o] * v
    }
    out[p] = 1 / (1 + Math.exp(-z))
  }
  return out
}
