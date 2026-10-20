// 車体挙動の乱れがあった時に、自動で 2 画面に分割して自車を映す。
//
//   乱れの事象（core/disturb.ts）の前後に余白を付けた区間だけ、全画面の視点（メイン）を半分に縮め、
//   空いた半分に「自車」の視点レイヤー（role = 'incident'。後ろ向き・水平固定）を滑り込ませる。
//   切り替えは transition 秒かけてなめらかに動かす。書き出しとプレビューの両方で同じ計算を使う。
import { disturbEvents, type DisturbCause, type DisturbTrack } from '../core/disturb'
import type { Rect } from './project'

export interface IncidentSettings {
  on: boolean
  /** 乱れの強さのしきい値（1.0 = その走行の上位 0.5% 相当）。小さいほど敏感 */
  threshold: number
  /** lr = 左に前方・右に自車、rl = 左に自車・右に前方、tb = 上に前方・下に自車 */
  layout: 'lr' | 'rl' | 'tb'
  /** 乱れの前後に付ける余白 [s] */
  pre: number
  post: number
  /** 2 画面にする最短の長さ [s] */
  minDur: number
  /** 切り替えにかける時間 [s] */
  transition: number
  /** 2 画面にしない事象（いちばん強かった時刻を 0.1 秒に丸めたもの） */
  skip: number[]
  /** 自車の画面に「挙動の乱れ」の表示を出す */
  label: boolean
}

export const DEFAULT_INCIDENT: IncidentSettings = { on: false, threshold: 1.5, layout: 'lr', pre: 1.0, post: 2.5, minDur: 4, transition: 0.4, skip: [], label: true }

export function mergeIncident(saved: Partial<IncidentSettings> | undefined): IncidentSettings {
  return { ...DEFAULT_INCIDENT, ...saved, skip: saved?.skip ?? [] }
}

/** 自車の視点（後ろ向き・広角・水平固定: 車体の傾きや揺れがそのまま見える） */
export const RIDER_VIEW = { yaw: 180, pitch: 5, fov: 165, leanRatio: 0 }
/** 以前の自車の画角（この値のままのキーフレームは、開いたときに新しい画角にする） */
export const OLD_RIDER_FOV = 120

export interface IncidentEvent {
  /** 2 画面にする範囲 [s]（余白込み） */
  start: number
  end: number
  /** いちばん強かった時刻・強さ・指標 */
  peak: number
  score: number
  cause: DisturbCause
}

export const roundPeak = (t: number): number => Math.round(t * 10) / 10

/** 乱れの事象から、2 画面にする区間を作る（重なる・近いものはまとめる。除外したものは除く） */
export function incidentEvents(d: DisturbTrack, s: IncidentSettings, duration: number): IncidentEvent[] {
  const out: IncidentEvent[] = []
  const skip = new Set(s.skip.map(roundPeak))
  for (const e of disturbEvents(d, s.threshold)) {
    if (skip.has(roundPeak(e.peak))) continue
    let start = Math.max(0, e.start - s.pre)
    let end = Math.min(duration, e.end + s.post)
    if (end - start < s.minDur) {
      const c = (start + end) / 2
      start = Math.max(0, c - s.minDur / 2)
      end = Math.min(duration, start + s.minDur)
    }
    const prev = out[out.length - 1]
    // 切り替えが落ち着かないので、間が短いものはつなぐ
    if (prev && start - prev.end < s.transition * 2 + 1) {
      prev.end = Math.max(prev.end, end)
      if (e.score > prev.score) Object.assign(prev, { peak: e.peak, score: e.score, cause: e.cause })
    } else out.push({ start, end, peak: e.peak, score: e.score, cause: e.cause })
  }
  return out
}

const ease = (x: number): number => x * x * (3 - 2 * x)
const lerp = (a: Rect, b: Rect, w: number): Rect => ({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, w: a.w + (b.w - a.w) * w, h: a.h + (b.h - a.h) * w })

/**
 * 時刻 t の分割の度合い w（0 = 全画面、1 = 2 画面）と、メイン・自車の矩形。
 * 自車の画面は外から滑り込む
 */
export function incidentLayout(events: IncidentEvent[], s: IncidentSettings, t: number): { w: number; main: Rect; rider: Rect; event: IncidentEvent | null } {
  let w = 0
  let event: IncidentEvent | null = null
  for (const e of events) {
    if (t < e.start || t > e.end) continue
    const x = Math.min((t - e.start) / s.transition, (e.end - t) / s.transition, 1)
    if (x > w) {
      w = x
      event = e
    }
  }
  w = ease(Math.max(0, Math.min(1, w)))
  const full: Rect = { x: 0, y: 0, w: 1, h: 1 }
  let mainT: Rect
  let riderT: Rect
  let riderFrom: Rect
  if (s.layout === 'tb') {
    mainT = { x: 0, y: 0, w: 1, h: 0.5 }
    riderT = { x: 0, y: 0.5, w: 1, h: 0.5 }
    riderFrom = { x: 0, y: 1, w: 1, h: 0.5 }
  } else if (s.layout === 'rl') {
    mainT = { x: 0.5, y: 0, w: 0.5, h: 1 }
    riderT = { x: 0, y: 0, w: 0.5, h: 1 }
    riderFrom = { x: -0.5, y: 0, w: 0.5, h: 1 }
  } else {
    mainT = { x: 0, y: 0, w: 0.5, h: 1 }
    riderT = { x: 0.5, y: 0, w: 0.5, h: 1 }
    riderFrom = { x: 1, y: 0, w: 0.5, h: 1 }
  }
  return { w, main: w >= 1 ? mainT : lerp(full, mainT, w), rider: w >= 1 ? riderT : lerp(riderFrom, riderT, w), event }
}
