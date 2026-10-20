// 車の検出（YOLOX-Nano、COCO の 80 クラス）の前処理と後処理。推論そのものは engine/detector.ts（onnxruntime-web）。
//
// モデル: Megvii-BaseDetection/YOLOX の yolox_nano.onnx（Apache-2.0）。入力 1×3×416×416（BGR・0〜255 のまま）、
// 出力 1×3549×85（格子 8・16・32 画素ごとの候補: 中心のずれ 2・幅と高さの対数 2・物体らしさ 1・クラスの確からしさ 80）

export const DET_SIZE = 416
/** 車として扱う COCO のクラス（車・オートバイ・バス・トラック） */
export const VEHICLE_CLASSES: Record<number, string> = { 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck' }

export interface Detection {
  /** 枠の中心と大きさ [画素]（DET_SIZE × DET_SIZE の画像で） */
  x: number
  y: number
  w: number
  h: number
  score: number
  cls: number
}

/** RGBA（上の行から、DET_SIZE 四方）を、モデルの入力（BGR・チャンネルごと・0〜255）へ */
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

/** モデルの出力から車の枠を取り出す（格子を戻し、確からしさ scoreMin 以上、重なりを除く） */
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
  // 重なりの大きい枠は、確からしさの高い方だけ残す
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

/** 見えた車（車体から見た向き） */
export interface VehicleSighting {
  /** 動画時刻 [s] */
  t: number
  /** 方位 [deg]（車体の前方 = 0、右 = +90、後ろ = ±180） */
  az: number
  /** 見かけの高さ [deg]（近いほど大きい） */
  size: number
  score: number
  /** COCO のクラス（VEHICLE_CLASSES） */
  cls: number
  /** 枠の下端の見下ろす角 [deg]（水平 = 0、下が正）。画像の下の縁で切れていれば、すぐ近くの物（自分の車体） */
  low: number
}

/** 画角 fov（正方形）・向き yaw の画像の枠を、車体から見た方位へ */
export function sightingFromBox(d: Detection, t: number, yaw: number, fov: number, size = DET_SIZE): VehicleSighting {
  const f = size / 2 / Math.tan((fov * Math.PI) / 360)
  const c = size / 2 - 0.5
  let az = yaw + (Math.atan((d.x - c) / f) * 180) / Math.PI
  az = ((((az + 180) % 360) + 360) % 360) - 180
  const top = Math.atan((d.y - d.h / 2 - c) / f)
  const bottom = Math.atan((d.y + d.h / 2 - c) / f)
  return { t, az, size: ((bottom - top) * 180) / Math.PI, score: d.score, cls: d.cls, low: (bottom * 180) / Math.PI }
}
