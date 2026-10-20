// Pre- and post-processing for car detection (YOLOX-Nano, 80 COCO classes). Inference itself is in engine/detector.ts (onnxruntime-web).
//
// Model: yolox_nano.onnx from Megvii-BaseDetection/YOLOX (Apache-2.0). Input 1×3×416×416 (BGR, kept at 0-255),
// output 1×3549×85 (candidates per grid of 8, 16, 32 px: center offset 2, log of width and height 2, objectness 1, class confidence 80)

export const DET_SIZE = 416
/** COCO classes treated as vehicles (car, motorcycle, bus, truck) */
export const VEHICLE_CLASSES: Record<number, string> = { 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck' }

export interface Detection {
  /** Box center and size [pixels] (in a DET_SIZE × DET_SIZE image) */
  x: number
  y: number
  w: number
  h: number
  score: number
  cls: number
}

/** RGBA (from the top row, DET_SIZE square) → model input (BGR, per channel, 0-255) */
export function toModelInput(rgba: Uint8Array | Uint8ClampedArray, size = DET_SIZE): Float32Array {
  const n = size * size
  const out = new Float32Array(3 * n)
  for (let p = 0; p < n; p++) {
    out[p] = rgba[p * 4 + 2] // B
    out[n + p] = rgba[p * 4 + 1] // G
    out[2 * n + p] = rgba[p * 4] // R
  }
  return out
}

/** Extracts vehicle boxes from the model output (undoes the grid, confidence scoreMin or higher, removes overlaps) */
export function decodeVehicles(out: Float32Array, size = DET_SIZE, scoreMin = 0.35, iouMax = 0.45): Detection[] {
  const cand: Detection[] = []
  let k = 0
  for (const s of [8, 16, 32]) {
    const g = size / s
    for (let gy = 0; gy < g; gy++) {
      for (let gx = 0; gx < g; gx++, k++) {
        const o = k * 85
        const obj = out[o + 4]
        if (obj < scoreMin) continue
        let best = -1
        let bestP = 0
        for (const c of Object.keys(VEHICLE_CLASSES).map(Number)) {
          if (out[o + 5 + c] > bestP) {
            bestP = out[o + 5 + c]
            best = c
          }
        }
        const score = obj * bestP
        if (best < 0 || score < scoreMin) continue
        cand.push({ x: (out[o] + gx) * s, y: (out[o + 1] + gy) * s, w: Math.exp(out[o + 2]) * s, h: Math.exp(out[o + 3]) * s, score, cls: best })
      }
    }
  }
  // Of heavily overlapping boxes, keep only the one with higher confidence
  cand.sort((a, b) => b.score - a.score)
  const keep: Detection[] = []
  for (const d of cand) if (keep.every((e) => iou(d, e) < iouMax)) keep.push(d)
  return keep
}

function iou(a: Detection, b: Detection): number {
  const x0 = Math.max(a.x - a.w / 2, b.x - b.w / 2)
  const x1 = Math.min(a.x + a.w / 2, b.x + b.w / 2)
  const y0 = Math.max(a.y - a.h / 2, b.y - b.h / 2)
  const y1 = Math.min(a.y + a.h / 2, b.y + b.h / 2)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-9)
}

/** A vehicle that was seen (direction as seen from the bike body) */
export interface VehicleSighting {
  /** Video time [s] */
  t: number
  /** Bearing [deg] (body front = 0, right = +90, rear = ±180) */
  az: number
  /** Apparent height [deg] (larger when closer) */
  size: number
  score: number
  /** COCO class (VEHICLE_CLASSES) */
  cls: number
  /** Depression angle of the bottom edge of the box [deg] (horizon = 0, down positive). If cut off by the bottom edge of the image, it is something right nearby (the own body) */
  low: number
}

/** Converts the box of an image with FOV fov (square) and direction yaw into a bearing as seen from the body */
export function sightingFromBox(d: Detection, t: number, yaw: number, fov: number, size = DET_SIZE): VehicleSighting {
  const f = size / 2 / Math.tan((fov * Math.PI) / 360)
  const c = size / 2 - 0.5
  let az = yaw + (Math.atan((d.x - c) / f) * 180) / Math.PI
  az = ((((az + 180) % 360) + 360) % 360) - 180
  const top = Math.atan((d.y - d.h / 2 - c) / f)
  const bottom = Math.atan((d.y + d.h / 2 - c) / f)
  return { t, az, size: ((bottom - top) * 180) / Math.PI, score: d.score, cls: d.cls, low: (bottom * 180) / Math.PI }
}
