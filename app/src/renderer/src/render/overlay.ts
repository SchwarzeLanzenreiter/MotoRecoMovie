// 重ね表示（テレメトリーなど）を Canvas 2D で描く。ウィジェットは種類ごとに登録する。
import { CHANNELS, sampleAll, sampleChannel, type ChannelKey, type Telemetry } from '../core/telemetry'
import { STATES, weightsAt } from '../core/riding'
import type { OverlayLayer, Rect, WidgetKind } from '../engine/project'
import type { PixelRect } from './gl-reframe'
import { DEFAULT_METER_OPTS, drawDashboard, drawSingleMeter, type MeterKind, type MeterOpts } from './meters'
import { drawCompass, drawElevation, drawMap } from './gps'
import { DEFAULT_CHRONO, drawChrono, type ChronoOpts } from './chrono'
import { DEFAULT_CYBER, drawCyber, type CyberOpts } from './cyber'
import { getLang, tr, type Lang } from '../i18n'

export interface OverlayFrame {
  t: number // 動画時刻 [s]
  telemetry: Telemetry | null
  values: Partial<Record<ChannelKey, number>> // その時刻のテレメトリー（計算済み）
  /** 走行状態の重み（STATES の順）。ログがなければ巡航のみ */
  weights: number[]
  /** コーナリング中のそこまでの最大リーン角（コーナー外は null） */
  peakLean: number | null
  /** リーン角の MAX ホールド（切り返しでリセット） */
  leanHold: number | null
  outW: number
  outH: number
  /** 動画に入る文字の言語（project.export.textLang、省略時は画面の言語） */
  lang: Lang
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
type Widget = (g: Ctx, r: PixelRect, f: OverlayFrame, props: Record<string, unknown>) => void

export const FONT = "'Yu Gothic UI', 'Meiryo UI', 'Segoe UI', sans-serif"

function roundRect(g: Ctx, r: PixelRect, rad: number): void {
  g.beginPath()
  g.roundRect(r.x, r.y, r.w, r.h, rad)
}

/** 数値の一覧（重ね表示の経路の確認用。本番のメーター類は後で追加する） */
const readout: Widget = (g, r, f) => {
  roundRect(g, r, r.h * 0.05)
  g.fillStyle = 'rgba(10, 12, 16, 0.55)'
  g.fill()
  const keys: ChannelKey[] = ['speed', 'rpm', 'gear', 'lean', 'accelG', 'airTemp', 'alt', 'heading']
  const rows = f.telemetry ? keys.filter((k) => f.values[k] !== undefined) : []
  const pad = r.h * 0.06
  if (rows.length === 0) {
    g.fillStyle = '#ddd'
    g.font = `${Math.round(r.h * 0.1)}px ${FONT}`
    g.textBaseline = 'middle'
    g.fillText(tr(f.lang, '車両ログなし'), r.x + pad, r.y + r.h / 2)
    return
  }
  const lh = (r.h - pad * 2) / rows.length
  g.textBaseline = 'middle'
  rows.forEach((k, i) => {
    const y = r.y + pad + lh * (i + 0.5)
    const v = f.values[k]!
    const info = CHANNELS[k]
    const txt =
      k === 'gear' ? (v === 0 ? 'N' : String(Math.round(v))) : k === 'accelG' ? (v >= 0 ? '+' : '') + v.toFixed(2) : k === 'lean' ? v.toFixed(1) : String(Math.round(v))
    g.font = `${Math.round(lh * 0.55)}px ${FONT}`
    g.fillStyle = '#9aa1ae'
    g.fillText(tr(f.lang, info.label), r.x + pad, y)
    g.textAlign = 'right'
    g.fillStyle = '#ffffff'
    g.font = `bold ${Math.round(lh * 0.62)}px ${FONT}`
    g.fillText(`${txt} ${info.unit}`, r.x + r.w - pad, y)
    g.textAlign = 'left'
  })
}

const opts = (props: Record<string, unknown>): MeterOpts => ({ ...DEFAULT_METER_OPTS, ...(props as Partial<MeterOpts>) })

/** 走行状態の重みから、個別メーターの強調の強さを決める（例: コーナリング中はリーン計が光る） */
const W = Object.fromEntries(STATES.map((s, i) => [s, i])) as Record<(typeof STATES)[number], number>
const emphasis: Record<MeterKind, (w: number[]) => number> = {
  speed: (w) => 0.4 * (w[W.accel] + w[W.brake]),
  gear: (w) => w[W.accel],
  rpm: (w) => w[W.accel],
  lean: (w) => w[W.corner],
  gforce: (w) => w[W.accel] + w[W.brake],
  temp: (w) => w[W.stop]
}

const single =
  (kind: MeterKind): Widget =>
  (g, r, f, props) => {
    if (!f.telemetry) return noLog(g, r, f.lang)
    drawSingleMeter(g, kind, r, f.values, opts(props), f.peakLean, emphasis[kind](f.weights))
  }

function noLog(g: Ctx, r: PixelRect, lang: Lang): void {
  g.fillStyle = 'rgba(10, 12, 16, 0.55)'
  g.fillRect(r.x, r.y, r.w, r.h)
  g.fillStyle = '#ddd'
  g.font = `${Math.round(Math.min(r.h * 0.25, r.w * 0.08))}px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(tr(lang, '車両ログなし'), r.x + r.w / 2, r.y + r.h / 2)
  g.textAlign = 'left'
}

const dashboard: Widget = (g, r, f, props) => {
  if (!f.telemetry) return noLog(g, r, f.lang)
  drawDashboard(g, r, f.values, opts(props), f.weights, f.peakLean)
}

const chrono: Widget = (g, r, f, props) => {
  if (!f.telemetry) return noLog(g, r, f.lang)
  const w = f.weights
  drawChrono(g, r, f.values, { ...DEFAULT_CHRONO, ...(props as Partial<ChronoOpts>) }, f.leanHold, {
    rpm: w[W.accel],
    throttle: w[W.accel],
    brake: w[W.brake],
    lean: w[W.corner]
  })
}

/** エンジン停止とみなす回転数 [rpm] と、始動・停止のときに色を切り替える時間 [s] */
const ENGINE_ON_RPM = 300
const ENGINE_FADE = 0.5

/**
 * エンジンが掛かっている度合い（直前 ENGINE_FADE 秒のうち、回転数が ENGINE_ON_RPM を超えていた割合）。
 * 回転数のデータが無ければ 1（演出しない）
 */
export function enginePower(tel: Telemetry | null, t: number): number {
  if (!tel?.channels.rpm) return 1
  const N = 6
  let on = 0
  for (let k = 0; k < N; k++) {
    const r = sampleChannel(tel, 'rpm', t - (ENGINE_FADE * k) / (N - 1))
    if (r === null || r > ENGINE_ON_RPM) on++
  }
  return on / N
}

/**
 * 数字が切り替わるときの動き: ROLL 秒で縦に流れて入れ替わり（新しい数字は入ってくる間に少し大きくなる）、
 * 置き換わった瞬間から POP 秒で元の大きさに戻る
 */
export const ROLL_TIME = 0.3
export const POP_TIME = 0.35

/** 切り替わりの途中: 前の値と、切り替わってからの時間 [s]（0〜ROLL_TIME + POP_TIME） */
export interface Roll {
  prev: number
  e: number
}

/**
 * 100Hz の値の列 series で、時刻 t の直前 ROLL_TIME + POP_TIME 秒の間に値が変わっていれば、前の値と経過時間。
 * 変わっていなければ null。書き出しでも同じになるよう、前のフレームの状態ではなくテレメトリーから求める
 */
function lastChange(series: ArrayLike<number>, tel: Telemetry, t: number): Roll | null {
  const i = Math.min(series.length - 1, Math.floor((t - tel.t0) * tel.rate))
  if (i < 1) return null
  const back = Math.ceil((ROLL_TIME + POP_TIME) * tel.rate)
  for (let j = i; j > Math.max(0, i - back); j--) {
    const a = series[j - 1]
    const b = series[j]
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      const e = t - (tel.t0 + j / tel.rate)
      return e >= 0 && e < ROLL_TIME + POP_TIME ? { prev: a, e } : null
    }
  }
  return null
}

/** ギアの切り替わり（無ければ null） */
export function gearShift(tel: Telemetry | null, t: number): Roll | null {
  const gear = tel?.channels.gear
  return tel && gear ? lastChange(gear, tel, t) : null
}

/**
 * 表示する外気温（整数 [℃]）の列。外気温は 0.75℃ 刻みで、表示の境目（x.5℃）付近では 2 つの値を行ったり来たりするので、
 * 表示している整数から AIR_HYST℃ 以上離れたときだけ変える（0.75℃ 違いの 2 つの値を往復しても、一度変わった後は数字が流れ続けない）
 */
const AIR_HYST = 0.8
const shownAir = new WeakMap<Telemetry, Float32Array | null>()
export function airTempShown(tel: Telemetry): Float32Array | null {
  if (shownAir.has(tel)) return shownAir.get(tel)!
  const a = tel.channels.airTemp
  let out: Float32Array | null = null
  if (a) {
    out = new Float32Array(a.length).fill(NaN)
    let cur = NaN
    for (let i = 0; i < a.length; i++) {
      const v = a[i]
      if (!Number.isFinite(v)) {
        out[i] = cur
        continue
      }
      if (!Number.isFinite(cur) || Math.abs(v - cur) >= AIR_HYST) cur = Math.round(v)
      out[i] = cur
    }
  }
  shownAir.set(tel, out)
  return out
}

/** 外気温の表示の切り替わり（無ければ null） */
export function airShift(tel: Telemetry | null, t: number): Roll | null {
  const s = tel ? airTempShown(tel) : null
  return tel && s ? lastChange(s, tel, t) : null
}

/** 時刻 t に表示する外気温（ちらつき防止の後の整数）。無ければ null */
function sampleShown(tel: Telemetry, t: number): number | null {
  const s = airTempShown(tel)
  if (!s) return null
  const v = s[Math.max(0, Math.min(s.length - 1, Math.floor((t - tel.t0) * tel.rate)))]
  return Number.isFinite(v) ? v : null
}

const cyber: Widget = (g, r, f, props) => {
  if (!f.telemetry) return noLog(g, r, f.lang)
  const w = f.weights
  drawCyber(
    g,
    r,
    f.values,
    { ...DEFAULT_CYBER, ...(props as Partial<CyberOpts>) },
    f.leanHold,
    {
      rpm: w[W.accel],
      throttle: w[W.accel],
      brake: w[W.brake],
      lean: w[W.corner]
    },
    // エンジン停止中は灰色（車両ログの回転数から。回転数が無ければ普通の色）
    enginePower(f.telemetry, f.t),
    // ギアと外気温の数字の切り替わり（縦に流れて入れ替わり、置き換わった瞬間に少し大きく）
    {
      gear: gearShift(f.telemetry, f.t),
      air: airShift(f.telemetry, f.t),
      airShown: sampleShown(f.telemetry, f.t)
    }
  )
}

const WIDGETS: Record<WidgetKind, Widget> = {
  chrono,
  cyber,
  map: (g, r, f, props) => drawMap(g, r, f.telemetry, f.t, props, f.lang),
  elevation: (g, r, f, props) => drawElevation(g, r, f.telemetry, f.t, props, f.lang),
  compass: (g, r, f, props) => drawCompass(g, r, f.telemetry, f.t, props, f.lang),
  dashboard,
  speed: single('speed'),
  gear: single('gear'),
  rpm: single('rpm'),
  lean: single('lean'),
  gforce: single('gforce'),
  temp: single('temp'),
  readout
}

export const WIDGET_NAMES: Record<WidgetKind, string> = {
  chrono: 'クロノグラフ風メーター', // i18n-ignore
  cyber: 'サイバー風メーター', // i18n-ignore
  dashboard: 'メーター一式（走行状態で切り替え）', // i18n-ignore
  speed: '速度計', // i18n-ignore
  rpm: '回転計', // i18n-ignore
  gear: 'ギア', // i18n-ignore
  lean: 'リーンアングル', // i18n-ignore
  gforce: '前後G', // i18n-ignore
  temp: '外気温', // i18n-ignore
  map: '地図', // i18n-ignore
  elevation: '標高プロファイル', // i18n-ignore
  compass: '方位帯', // i18n-ignore
  readout: '数値一覧' // i18n-ignore
}

/** 重ね表示ごとの設定項目（サイドパネルで編集する） */
export type PropDef =
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; default: string }
  | { key: string; label: string; type: 'number'; min: number; max: number; step: number; unit?: string; default: number }

const RPM_PROPS: PropDef[] = [
  { key: 'rpmMax', label: '回転計の上限', type: 'number', min: 4000, max: 16000, step: 500, unit: 'rpm', default: DEFAULT_METER_OPTS.rpmMax }, // i18n-ignore
  { key: 'rpmRed', label: 'レッドゾーン', type: 'number', min: 3000, max: 16000, step: 250, unit: 'rpm', default: DEFAULT_METER_OPTS.rpmRed } // i18n-ignore
]

export const WIDGET_PROPS: Partial<Record<WidgetKind, PropDef[]>> = {
  chrono: [
    {
      key: 'theme',
      label: '配色', // i18n-ignore
      type: 'select',
      options: [
        { value: 'bmw', label: 'BMW（M カラー）' }, // i18n-ignore
        { value: 'standard', label: '標準' } // i18n-ignore
      ],
      default: 'bmw'
    },
    ...RPM_PROPS,
    { key: 'brakeMax', label: 'ブレーキ圧の上限', type: 'number', min: 5, max: 60, step: 1, unit: 'bar', default: DEFAULT_CHRONO.brakeMax }, // i18n-ignore
    { key: 'leanMax', label: 'リーンの目盛り', type: 'number', min: 30, max: 70, step: 5, unit: '°', default: DEFAULT_CHRONO.leanMax } // i18n-ignore
  ],
  cyber: [
    {
      key: 'theme',
      label: '配色', // i18n-ignore
      type: 'select',
      options: [
        { value: 'bmw', label: 'BMW（M カラー）' }, // i18n-ignore
        { value: 'neon', label: 'ネオン' } // i18n-ignore
      ],
      default: 'bmw'
    },
    ...RPM_PROPS,
    { key: 'brakeMax', label: 'ブレーキ圧の上限', type: 'number', min: 5, max: 60, step: 1, unit: 'bar', default: DEFAULT_CYBER.brakeMax }, // i18n-ignore
    { key: 'leanMax', label: 'リーンの目盛り', type: 'number', min: 30, max: 70, step: 5, unit: '°', default: DEFAULT_CYBER.leanMax } // i18n-ignore
  ],
  dashboard: RPM_PROPS,
  rpm: RPM_PROPS,
  map: [
    {
      key: 'mode',
      label: '表示', // i18n-ignore
      type: 'select',
      options: [
        { value: 'local', label: '周辺（進行方向が上）' }, // i18n-ignore
        { value: 'route', label: 'ルート全体（北が上）' } // i18n-ignore
      ],
      default: 'local'
    },
    { key: 'rangeM', label: '範囲（周辺）', type: 'number', min: 100, max: 5000, step: 100, unit: 'm', default: 600 }, // i18n-ignore
    {
      key: 'shape',
      label: '形', // i18n-ignore
      type: 'select',
      options: [
        { value: 'circle', label: '円' }, // i18n-ignore
        { value: 'rect', label: '角丸の四角' } // i18n-ignore
      ],
      default: 'circle'
    }
  ],
  elevation: [{ key: 'windowKm', label: '表示する幅（0 = 全体）', type: 'number', min: 0, max: 50, step: 1, unit: 'km', default: 0 }], // i18n-ignore
  compass: [{ key: 'spanDeg', label: '見える角度の幅', type: 'number', min: 45, max: 360, step: 15, unit: '°', default: 120 }], // i18n-ignore

}

/** 追加したときの初期の位置（出力の縦横比 aspect = 幅/高さ に合わせる） */
export function defaultWidgetRect(w: WidgetKind, aspect: number): Rect {
  const tall = aspect < 1
  const box = (cx: number, cy: number, ww: number, hh: number): Rect => {
    // ww, hh は「出力の短辺」に対する大きさ
    const sw = tall ? ww : ww / aspect
    const sh = tall ? hh * aspect : hh
    return { x: cx - sw / 2, y: cy - sh / 2, w: sw, h: sh }
  }
  switch (w) {
    case 'chrono':
    case 'cyber': // サイバー風もクロノグラフ風と同じ丸い配置
      return box(tall ? 0.5 : 0.84, tall ? 0.78 : 0.72, 0.42, 0.42)
    case 'dashboard': {
      // メーター一式の縦横比（100:34）を保ち、下端から少し離して置く
      const w = tall ? 0.94 : 0.6
      const h = (w * aspect * 34) / 100
      return { x: (1 - w) / 2, y: 1 - h - 0.02, w, h }
    }
    case 'speed':
      return box(0.5, 0.86, 0.3, 0.19)
    case 'gear':
      return box(0.68, 0.86, 0.12, 0.15)
    case 'rpm':
      return box(0.5, 0.7, 0.45, 0.12)
    case 'lean':
      return box(0.16, 0.8, 0.32, 0.28)
    case 'gforce':
      return box(0.9, 0.75, 0.1, 0.3)
    case 'temp':
      return box(0.9, 0.08, 0.16, 0.065)
    case 'map':
      return box(0.88, 0.2, 0.3, 0.3)
    case 'elevation':
      return box(0.16, 0.11, 0.42, 0.17)
    case 'compass':
      return box(0.5, 0.06, 0.5, 0.09)
    default:
      return box(0.14, 0.78, 0.26, 0.36)
  }
}

export function overlayFrame(t: number, telemetry: Telemetry | null, outW: number, outH: number, lang: Lang = getLang()): OverlayFrame {
  const r = telemetry?.riding
  let peakLean: number | null = null
  let leanHold: number | null = null
  if (r) {
    const i = Math.max(0, Math.min(r.peakLean.length - 1, Math.round(t * r.rate)))
    peakLean = r.peakLean[i] !== 0 ? r.peakLean[i] : null
    leanHold = r.leanHold ? r.leanHold[i] : null
  }
  return {
    t,
    telemetry,
    values: telemetry ? sampleAll(telemetry, t) : {},
    weights: r ? weightsAt(r, t) : STATES.map((s) => (s === 'cruise' ? 1 : 0)),
    peakLean,
    leanHold,
    outW,
    outH,
    lang
  }
}

export function drawOverlayLayer(g: Ctx, layer: OverlayLayer, r: PixelRect, f: OverlayFrame): void {
  const w = WIDGETS[layer.widget]
  if (!w) return
  g.save()
  g.beginPath()
  g.rect(r.x, r.y, r.w, r.h)
  g.clip()
  w(g, r, f, layer.props)
  g.restore()
}
