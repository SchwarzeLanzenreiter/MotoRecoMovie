// Vehicles seen around the bike, for the overtake search (core/overtake.ts). They are found by the instance segmentation model
// (core/segment.ts, engine/segmenter.ts) in square images of the four directions around the body

/** Size of the square images the vehicles are searched in */
export const DET_SIZE = 640
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
