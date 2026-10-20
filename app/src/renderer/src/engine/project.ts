// プロジェクト（編集内容）のデータ構造。JSON で保存する。
import type { SeamFix } from '../core/seamfit'
import { DEFAULT_AUDIO_FX, OLD_DEFAULT_LOWPASS_HZ, type AudioFx } from '../core/audiofx'
import { DEFAULT_INCIDENT, mergeIncident, OLD_RIDER_FOV, RIDER_VIEW, type IncidentSettings } from './incident'
import { t } from '../i18n'
import { DEFAULT_DIRECTOR, mergeDirector, type DirectorSettings, type Marker, type OvertakeSpan } from './director'

/** キーフレームの印（自動生成のショットの種類） */
export type KeyTag = 'front' | 'corner' | 'side' | 'rear' | 'overtake'

export interface Keyframe {
  t: number // 動画時刻 [s]
  yaw: number // 車体座標の視点 [deg]（0 = 前、正 = 右）
  pitch: number // [deg]（正 = 下）
  fov: number // 水平画角 [deg]
  leanRatio: number // 画面に残すリーンの割合（1 = 車体と一緒に傾く, 0 = 水平固定）。ログがあるときのみ有効
  /** 次のキーフレームまでを等速で補間する（名所を追いかけるときなど、細かく置いたキーフレームを滑らかにつなぐ） */
  linear?: boolean
  /**
   * 自動生成で作ったときのショットの種類（タイムラインで色分けする）: 前方・コーナー入口・側方・後方・追い越し（黄色）。
   * 手で置いたもの・注目ポイントには付けない
   */
  tag?: KeyTag
}

export interface StabSettings {
  enabled: boolean
  sigma: [number, number, number] // ピッチ・ヨー・ロールの平滑化 [s]
  rollingShutter: boolean
  rollComp: boolean // ログのリーン角でロールの「なまり」を補完
  /**
   * レンズの継ぎ目の合わせ込み（core/seamfit.ts）: レンズ1の補正（回転と縁の角度）。
   * undefined = まだ推定していない（開いたときに推定する）、null = 推定できなかった
   */
  seam?: SeamFix | null
  /** 継ぎ目の合わせ込みを使う（既定 true） */
  seamFix?: boolean
  /** 動的なつなぎ合わせ: 継ぎ目の付近の景色の距離をフレームごとに求め、レンズの位置の差による視差を補正する（既定 true） */
  dynamicSeam?: boolean
  /** 継ぎ目のぼかし幅 [deg]（既定 12） */
  seamBlend?: number
  /**
   * 自車の継ぎ目の型（core/bodymap.ts）: トップケース・ナンバープレートなどカメラと一緒に動く物を、動画の区間ごとに AI で作り込んだ
   * つなぎ目で描く（既定 false: 試験的。場面によって良くも悪くもなる）。型は動画の横の .motorecomovie-body.bin に保存する
   */
  bodyStitch?: boolean
  /** 穴を埋める AI のモデル（既定 lama） */
  bodyInpaint?: 'lama' | 'migan'
}

export interface ExportSettings {
  width: number
  height: number
  codec: 'hevc' | 'avc'
  bitrateMbps: number
  inSec: number
  outSec: number // 負なら最後まで
  /** 動画に入る文字（挙動の乱れの表示・字幕の見出しなど）の言語。省略時は画面の言語と同じ */
  textLang?: 'ja' | 'en'
}

/** 出力画面に対する割合（0〜1）。左上が原点 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }

interface LayerBase {
  id: string
  name: string
  rect: Rect
  visible: boolean
}

/** 枠線。太さは出力の短辺に対する割合 */
export interface Border {
  width: number
  color: string
}

/** 360°映像を切り出して表示する画面。それぞれが自分のキーフレーム（視点）を持つ */
export interface ViewLayer extends LayerBase {
  type: 'view'
  keyframes: Keyframe[]
  border?: Border
  /** これから進入するコーナーの曲線半径を、空中に浮かぶ標識として描く（車両ログが必要） */
  signs?: boolean
  /** 標識の見た目: real = 現実の道路標識風、cyber = AR 風 */
  signStyle?: 'real' | 'cyber'
  /** 標識の位置: コーナーの進入地点から経路に沿って何 m 先か（負 = 手前。既定 signs.ts の DEFAULT_SIGN_AHEAD） */
  signAhead?: number
  /** incident = 車体挙動の乱れがあった時だけ、2 画面の片側に出る「自車」の画面（engine/incident.ts） */
  role?: 'incident'
}

export type WidgetKind = 'chrono' | 'cyber' | 'dashboard' | 'speed' | 'gear' | 'rpm' | 'lean' | 'gforce' | 'temp' | 'map' | 'elevation' | 'compass' | 'readout'

/** テレメトリーなどを重ねて表示するレイヤー */
export interface OverlayLayer extends LayerBase {
  type: 'overlay'
  widget: WidgetKind
  props: Record<string, unknown>
}

export type Layer = ViewLayer | OverlayLayer

export interface Project {
  version: 2
  insvPath: string
  logPath: string | null
  /** logPath が MotoReco の .dat のとき、デコードに使った変換規則（.ddf） */
  ddfPath?: string | null
  logEnabled: boolean
  stab: StabSettings
  /** 描画順（先頭が一番下） */
  layers: Layer[]
  export: ExportSettings
  /** 注目ポイント（画角の自動切り替えで、その時刻にその方向を見せる） */
  markers: Marker[]
  /** 画角の自動切り替えの設定 */
  director: DirectorSettings
  /** 追い越しの区間（動画を調べた結果。まだ調べていなければ無し） */
  overtakes?: OvertakeSpan[]
  /** overtakes を求めた判定の版（OVERTAKE_SCAN_VERSION と違えば調べ直す） */
  overtakesVersion?: number
  /** 車体挙動の乱れがあった時に自動で 2 画面にする設定 */
  incident: IncidentSettings
  /** 走行中の音を整える（音割れの補修・エンジン音以外を抑える・音圧を抑える。core/audiofx.ts） */
  audioFx: AudioFx
  /**
   * 時刻の基準の版。1 = 動画時刻の 0 が最初のフレーム（ジャイロの時間軸の firstFrameUs）。
   * 無い（以前の版）ものは、フレームの時刻の記録をそのまま使っていたので、X5 の動画では 0.77 秒、分割された 2 本目以降の動画では 7〜18 秒、
   * 時刻がずれている（開いたときに shiftProjectTimes で直す。core/insv.ts の gyroFrameTimes）
   */
  timeBase?: 1
}

export const DEFAULT_KEY: Omit<Keyframe, 't'> = { yaw: 0, pitch: 0, fov: 110, leanRatio: 1 }

export const newId = (): string => Math.random().toString(36).slice(2, 10)

export function newViewLayer(name: string, rect: Rect = FULL, view: Omit<Keyframe, 't'> = DEFAULT_KEY): ViewLayer {
  return { id: newId(), type: 'view', name, rect: { ...rect }, visible: true, keyframes: [{ t: 0, ...view }] }
}

export function newProject(insvPath: string): Project {
  return {
    version: 2,
    insvPath,
    logPath: null,
    logEnabled: true,
    stab: { enabled: true, sigma: [0.6, 0.3, 0.2], rollingShutter: true, rollComp: true },
    layers: [newViewLayer(t('メイン'))],
    export: { width: 1920, height: 1080, codec: 'hevc', bitrateMbps: 40, inSec: 0, outSec: -1 },
    markers: [],
    director: structuredClone(DEFAULT_DIRECTOR),
    incident: { ...DEFAULT_INCIDENT },
    audioFx: { ...DEFAULT_AUDIO_FX },
    timeBase: 1
  }
}

/** プロジェクトの中の動画時刻（キーフレーム・注目ポイント・書き出し範囲・追い越しの区間・2 画面にしない事象）をすべて dt [s] ずらす */
export function shiftProjectTimes(p: Project, dt: number): Project {
  if (!dt) return p
  const sh = (x: number): number => Math.round((x + dt) * 1e6) / 1e6
  return {
    ...p,
    layers: p.layers.map((l) => (l.type === 'view' ? { ...l, keyframes: l.keyframes.map((k, i) => (i === 0 && k.t === 0 ? k : { ...k, t: Math.max(0, sh(k.t)) })) } : l)),
    markers: p.markers.map((m) => ({ ...m, t: Math.max(0, sh(m.t)) })),
    export: { ...p.export, inSec: p.export.inSec > 0 ? sh(p.export.inSec) : p.export.inSec, outSec: p.export.outSec >= 0 ? sh(p.export.outSec) : p.export.outSec },
    overtakes: p.overtakes?.map((o) => ({ ...o, start: sh(o.start), end: sh(o.end) })),
    incident: { ...p.incident, skip: p.incident.skip.map(sh) }
  }
}

/** 保存されたプロジェクトを最新の形式にする（v1: 視点が1つだけの形式） */
export function migrateProject(raw: Record<string, unknown>, insvPath: string): Project {
  const base = newProject(insvPath)
  if (raw.version === 1 || (raw.keyframes && !raw.layers)) {
    const { keyframes, ...rest } = raw as { keyframes: Keyframe[] } & Record<string, unknown>
    const main = newViewLayer(t('メイン'))
    main.keyframes = keyframes?.length ? keyframes : main.keyframes
    return { ...base, ...(rest as Partial<Project>), version: 2, insvPath, layers: [main] }
  }
  const p = { ...base, ...(raw as Partial<Project>), version: 2 as const, insvPath }
  // 時刻の基準: 保存されたものに無ければ以前の版（開いたときに動画に合わせて直す）
  if (raw.timeBase === undefined) delete p.timeBase
  // 後から増えた設定項目は既定値で補う
  p.director = mergeDirector(p.director)
  p.markers = p.markers ?? []
  // 走行地点の解説（字幕）は別のツールで入れることになり、このアプリから外した。古いプロジェクトの内容は読み捨てる
  delete (p as Record<string, unknown>).commentary
  delete (p as Record<string, unknown>).commentaryLang
  p.layers = p.layers.filter((l) => !(l.type === 'overlay' && (l.widget as string) === 'caption'))
  p.incident = mergeIncident(p.incident)
  p.audioFx = { ...DEFAULT_AUDIO_FX, ...p.audioFx }
  if (p.audioFx.lowpassHz === OLD_DEFAULT_LOWPASS_HZ) p.audioFx.lowpassHz = DEFAULT_AUDIO_FX.lowpassHz
  // 「自車」の画面の画角を以前の既定値から広げた（手で変えていなければ新しい画角に）
  p.layers = p.layers.map((l) =>
    l.type === 'view' && l.role === 'incident' ? { ...l, keyframes: l.keyframes.map((k) => (k.fov === OLD_RIDER_FOV ? { ...k, fov: RIDER_VIEW.fov } : k)) } : l
  )
  return p
}

export function viewLayers(p: Project): ViewLayer[] {
  return p.layers.filter((l): l is ViewLayer => l.type === 'view')
}

export function findLayer(p: Project, id: string | null): Layer | undefined {
  return p.layers.find((l) => l.id === id)
}

const ease = (x: number): number => x * x * (3 - 2 * x)

/** 時刻 t の視点をキーフレームから補間する（区間ごとに ease-in-out、ヨーは近い向きへ回る） */
export function viewAt(keys: Keyframe[], t: number): Omit<Keyframe, 't'> {
  // 戻り値に時刻 t を含めない（含めると、これを元に作ったキーフレームの時刻が上書きされる）
  const strip = ({ yaw, pitch, fov, leanRatio }: Keyframe): Omit<Keyframe, 't'> => ({ yaw, pitch, fov, leanRatio })
  if (keys.length === 0) return { ...DEFAULT_KEY }
  const k = [...keys].sort((a, b) => a.t - b.t)
  if (t <= k[0].t) return strip(k[0])
  if (t >= k[k.length - 1].t) return strip(k[k.length - 1])
  let i = 0
  while (k[i + 1].t < t) i++
  const a = k[i]
  const b = k[i + 1]
  const x = (t - a.t) / (b.t - a.t)
  const s = a.linear ? x : ease(x)
  let dy = (((b.yaw - a.yaw) % 360) + 540) % 360 - 180
  if (dy === -180 && b.yaw > a.yaw) dy = 180
  return {
    yaw: a.yaw + dy * s,
    pitch: a.pitch + (b.pitch - a.pitch) * s,
    fov: a.fov + (b.fov - a.fov) * s,
    leanRatio: a.leanRatio + (b.leanRatio - a.leanRatio) * s
  }
}
