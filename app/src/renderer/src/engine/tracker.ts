// Following the point of a place label through the video (core/track.ts for the matching). Runs beside the preview with its own decoders
// and its own small GL canvas, from the frame the point was placed (or corrected) at, every TRACK_STEP frames, until the point leaves the view
// it was placed in, cannot be found any more, or TRACK_LIMIT seconds have passed.
import type { Session } from './session'
import { TrackDecoder } from './decoder'
import { GlReframer } from '../render/gl-reframe'
import { focalFor, projectPoint, wideK } from '../render/projection'
import { viewAt, type Keyframe } from './project'
import { CROP, cropPixelDir, cutPatch, lookAt, matchPatch, PATCH, roundDir, toGray, trackFov } from '../core/track'
import type { PlaceLabel } from '../core/annotations'
import type { Mat3 } from '../core/quat'
import { t } from '../i18n'

/** Frames between samples */
export const TRACK_STEP = 2
/** Longest a label is followed [s] */
const TRACK_LIMIT = 120
/** Below this match score the point is lost; below RENEW_MIN the patch is not renewed (a poor match would carry the error on) */
const LOST = 0.4
const RENEW_MIN = 0.6
/** Share of the newly seen patch mixed into the patch every step */
const RENEW = 0.3
/**
 * The crop is rendered this many times larger and averaged down: the video holds about 20 px per degree and the crop about 4, and picking
 * single pixels from it flickers from frame to frame (the match score jumped between 0.5 and 0.9 on a car ahead)
 */
const SUPER = 4

export interface FollowRequest {
  /** First frame and the point's direction there (rig coordinates) */
  frame: number
  dir: [number, number, number]
  /** The view the label belongs to: its keyframes and its size on the output frame [px] (the point is followed until it leaves it) */
  keyframes: Keyframe[]
  viewW: number
  viewH: number
}

/** Follows the point; returns the directions every TRACK_STEP frames from req.frame (rounded for the project) and why it stopped */
export async function followPoint(
  s: Session,
  req: FollowRequest,
  onProgress?: (seconds: number) => void,
  signal?: { aborted: boolean }
): Promise<{ dirs: number[]; end: NonNullable<PlaceLabel['track']>['end'] }> {
  const decs = s.decoders.map((d) => new TrackDecoder(s.file, d.track))
  const gl = new GlReframer(new OffscreenCanvas(CROP * SUPER, CROP * SUPER))
  gl.setLenses(s.rig)
  gl.dynamicSeam = false
  const fov0 = viewAt(req.keyframes, s.motion.videoTime(req.frame)).fov
  const fov = trackFov(fov0)
  const center = (CROP - PATCH) / 2
  const dirs: number[] = []
  let end: 'left' | 'lost' | 'limit' = 'limit'
  try {
    let dir = req.dir
    let prev = req.dir
    let patch: Float32Array | null = null
    const last = Math.min(s.frameCount - 1, req.frame + Math.round(TRACK_LIMIT * s.fps))
    for (let i = req.frame; i <= last; i += TRACK_STEP) {
      if (signal?.aborted) throw new Error(t('Cancelled'))
      const fs = await Promise.all(decs.map((d) => d.get(i)))
      try {
        gl.upload([fs[0], fs[1]])
      } finally {
        fs.forEach((f) => f.close())
      }
      const down = s.motion.downInRig(i)
      if (!patch) {
        // The patch around the point as placed
        const img = renderGray(gl, lookAt(dir, down), fov)
        patch = cutPatch(img, CROP, center, center)
      } else {
        // Look where the point is expected (moving on as in the last step, damped: the camera shakes on its mount from frame to frame)
        const pred = [1.5 * dir[0] - 0.5 * prev[0], 1.5 * dir[1] - 0.5 * prev[1], 1.5 * dir[2] - 0.5 * prev[2]] as [number, number, number]
        const cam = lookAt(pred, down)
        const img = renderGray(gl, cam, fov)
        const m = matchPatch(img, CROP, patch)
        if (m.score < LOST) {
          end = 'lost'
          break
        }
        prev = dir
        dir = cropPixelDir(cam, CROP, fov, m.x + PATCH / 2, m.y + PATCH / 2)
        if (m.score >= RENEW_MIN) {
          const seen = cutPatch(img, CROP, Math.round(m.x), Math.round(m.y))
          for (let k = 0; k < patch.length; k++) patch[k] = patch[k] * (1 - RENEW) + seen[k] * RENEW
        }
      }
      dirs.push(roundDir(dir[0]), roundDir(dir[1]), roundDir(dir[2]))
      if (!inView(s, req, i, dir)) {
        end = 'left'
        break
      }
      if ((dirs.length / 3) % 25 === 0) onProgress?.((i - req.frame) / s.fps)
    }
  } finally {
    decs.forEach((d) => d.close())
    gl.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  return { dirs, end }
}

/** The crop seen by camera cam (gray, CROP square), rendered SUPER times larger and averaged down */
function renderGray(gl: GlReframer, cam: Mat3, fov: number): Float32Array {
  const S = CROP * SUPER
  const big = toGray(gl.renderCrop(cam, fov, S), S * S)
  const out = new Float32Array(CROP * CROP)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[((y / SUPER) | 0) * CROP + ((x / SUPER) | 0)] += big[y * S + x]
  for (let k = 0; k < out.length; k++) out[k] /= SUPER * SUPER
  return out
}

/** Whether the direction is on the view's picture at frame i */
function inView(s: Session, req: FollowRequest, i: number, dir: [number, number, number]): boolean {
  const v = viewAt(req.keyframes, s.motion.videoTime(i))
  const V = s.motion.frame(i, v).view
  // Rig -> output camera: the transpose of the view matrix (camera -> rig, row-major)
  const c = [V[0] * dir[0] + V[3] * dir[1] + V[6] * dir[2], V[1] * dir[0] + V[4] * dir[1] + V[7] * dir[2], V[2] * dir[0] + V[5] * dir[1] + V[8] * dir[2]]
  const p = projectPoint(c, focalFor(req.viewW, v.fov), wideK(v.fov))
  return !!p && Math.abs(p[0]) <= req.viewW / 2 && Math.abs(p[1]) <= req.viewH / 2
}
