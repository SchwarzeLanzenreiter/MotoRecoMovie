// テレメトリーのメーター類（MotoGP のオンボード映像の表示を参考にしたもの）。
//
// 各メーターは「中心 (cx, cy)・大きさの単位 u（px）・不透明度 a・強調 hi（0〜1）」を受け取って描く。
// - 個別のウィジェット: 1つのメーターをレイヤーの矩形いっぱいに描く
// - メーター一式（dashboard）: 走行状態ごとに各メーターの位置・大きさ・強調を決めておき、
//   状態の重み（切り替わりで滑らかに変わる）で補間して描く。強調したいデータに合わせて見た目が移り変わる
import type { ChannelKey } from '../core/telemetry'
import { STATES, type RidingState } from '../core/riding'

export type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
export type Values = Partial<Record<ChannelKey, number>>

/** 数字用のフォント（Windows 標準の Bahnschrift。無ければ Segoe UI） */
const NUM = "Bahnschrift, 'Segoe UI', sans-serif"

export const COLORS = {
  panel: 'rgba(12, 14, 18, 0.62)',
  text: '#ffffff',
  sub: 'rgba(255,255,255,0.62)',
  accel: '#3ddc84',
  brake: '#ff4b4b',
  lean: '#36b4ff',
  rpm: '#ffcc33',
  red: '#ff3b30',
  temp: '#ffb347'
}

export interface MeterOpts {
  rpmMax: number // 回転計の最大
  rpmRed: number // レッドゾーンの開始
  gMax: number // 前後Gの表示範囲 ±
  leanMax: number // リーンの表示範囲 ±
}

export const DEFAULT_METER_OPTS: MeterOpts = { rpmMax: 9000, rpmRed: 8000, gMax: 0.6, leanMax: 60 }

export interface Pose {
  cx: number
  cy: number
  u: number // 大きさの単位 [px]
  a: number // 不透明度
  hi: number // 強調（0〜1）
}

// ---- 共通の描画部品 ----

function font(g: Ctx, px: number, weight = 700, italic = true, family = NUM): void {
  g.font = `${italic ? 'italic ' : ''}${weight} ${Math.max(1, px).toFixed(1)}px ${family}`
}

/** 右上がりに傾いた平行四辺形のパネル（MotoGP 風） */
function panel(g: Ctx, x: number, y: number, w: number, h: number, skew: number, fill = COLORS.panel): void {
  g.beginPath()
  g.moveTo(x + skew, y)
  g.lineTo(x + w + skew, y)
  g.lineTo(x + w - skew, y + h)
  g.lineTo(x - skew, y + h)
  g.closePath()
  g.fillStyle = fill
  g.fill()
}

function glow(g: Ctx, color: string, hi: number, u: number): void {
  g.shadowColor = color
  g.shadowBlur = hi * u * 1.6
}

function noGlow(g: Ctx): void {
  g.shadowBlur = 0
}

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))

// ---- 各メーター ----

/** 速度: 大きな数字と km/h */
export function drawSpeed(g: Ctx, v: Values, p: Pose): void {
  const s = v.speed
  if (s === undefined) return
  const { cx, cy, u } = p
  g.save()
  g.globalAlpha = p.a
  panel(g, cx - 9 * u, cy - 6 * u, 18 * u, 12 * u, 1.2 * u)
  glow(g, '#ffffff', p.hi * 0.6, u)
  g.fillStyle = COLORS.text
  font(g, 10 * u)
  g.textAlign = 'right'
  g.textBaseline = 'alphabetic'
  g.fillText(String(Math.round(Math.max(0, s))), cx + 4.6 * u, cy + 3.6 * u)
  noGlow(g)
  font(g, 2.6 * u, 600)
  g.fillStyle = COLORS.sub
  g.textAlign = 'left'
  g.fillText('km/h', cx + 5.2 * u, cy + 3.6 * u)
  g.restore()
}

/** ギア: 四角の中の数字（0 = N） */
export function drawGear(g: Ctx, v: Values, p: Pose): void {
  const gear = v.gear
  if (gear === undefined) return
  const { cx, cy, u } = p
  g.save()
  g.globalAlpha = p.a
  panel(g, cx - 3.6 * u, cy - 5 * u, 7.2 * u, 10 * u, 0.8 * u, p.hi > 0.01 ? `rgba(255, 204, 51, ${0.25 + 0.55 * p.hi})` : COLORS.panel)
  font(g, 1.9 * u, 600)
  g.fillStyle = COLORS.sub
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  g.fillText('GEAR', cx, cy - 2.6 * u)
  font(g, 7 * u)
  g.fillStyle = COLORS.text
  glow(g, COLORS.rpm, p.hi, u)
  g.fillText(gear <= 0 ? 'N' : String(Math.round(gear)), cx, cy + 4.2 * u)
  g.restore()
}

/** 回転計: 区切りのある横バー（レッドゾーンで赤、上限付近でシフトランプが光る） */
export function drawRpm(g: Ctx, v: Values, p: Pose, o: MeterOpts): void {
  const rpm = v.rpm
  if (rpm === undefined) return
  const { cx, cy, u } = p
  const W = 26 * u
  const H = 2.6 * u
  const x0 = cx - W / 2
  const segs = 36
  const lit = clamp(rpm / o.rpmMax, 0, 1) * segs
  g.save()
  g.globalAlpha = p.a
  panel(g, x0 - 1.4 * u, cy - H / 2 - 1 * u, W + 2.8 * u, H + 2 * u + 3 * u, 0.6 * u)
  const sw = W / segs
  for (let k = 0; k < segs; k++) {
    const frac = (k + 0.5) / segs
    const on = k < lit
    const col = frac * o.rpmMax >= o.rpmRed ? COLORS.red : frac > 0.6 ? COLORS.rpm : '#e8e8e8'
    g.fillStyle = on ? col : 'rgba(255,255,255,0.12)'
    if (on) glow(g, col, p.hi * 0.7, u * 0.5)
    // 右へ行くほど少し高くする（タコメーターらしく）
    const hh = H * (0.55 + 0.45 * frac)
    g.fillRect(x0 + k * sw + sw * 0.12, cy + H / 2 - hh, sw * 0.76, hh)
    noGlow(g)
  }
  // シフトランプ
  if (rpm >= o.rpmRed * 0.97) {
    g.fillStyle = COLORS.red
    glow(g, COLORS.red, 1, u)
    g.fillRect(x0 + W + 0.2 * u, cy - H / 2, 0.9 * u, H)
    noGlow(g)
  }
  font(g, 2.2 * u, 600)
  g.fillStyle = COLORS.sub
  g.textAlign = 'right'
  g.textBaseline = 'top'
  g.fillText(`${Math.round(rpm / 10) * 10} rpm`, x0 + W, cy + H / 2 + 0.6 * u)
  g.restore()
}

/** リーン: 傾く後ろ姿のバイクと目盛りの円弧、角度、コーナー中の最大値 */
export function drawLean(g: Ctx, v: Values, p: Pose, o: MeterOpts, peak: number | null): void {
  const lean = v.lean
  if (lean === undefined) return
  const { cx, cy, u } = p
  const R = 9 * u
  const ground = cy + 5.5 * u
  g.save()
  g.globalAlpha = p.a
  g.beginPath()
  g.ellipse(cx, cy + 1 * u, R + 2.6 * u, R + 1 * u, 0, 0, Math.PI * 2)
  g.fillStyle = COLORS.panel
  g.fill()
  // 目盛りの円弧（上半分）。0° が真上、左右へ ±leanMax
  const toAng = (deg: number): number => -Math.PI / 2 + (deg / o.leanMax) * (Math.PI / 2) * 0.9
  g.lineWidth = 0.7 * u
  g.strokeStyle = 'rgba(255,255,255,0.18)'
  g.beginPath()
  g.arc(cx, ground, R, toAng(-o.leanMax), toAng(o.leanMax))
  g.stroke()
  for (const d of [-45, -30, -15, 0, 15, 30, 45]) {
    const a = toAng(d)
    g.strokeStyle = 'rgba(255,255,255,0.4)'
    g.lineWidth = 0.25 * u
    g.beginPath()
    g.moveTo(cx + Math.cos(a) * (R - 0.8 * u), ground + Math.sin(a) * (R - 0.8 * u))
    g.lineTo(cx + Math.cos(a) * (R + 0.4 * u), ground + Math.sin(a) * (R + 0.4 * u))
    g.stroke()
  }
  // 現在の角度までの円弧
  g.strokeStyle = COLORS.lean
  g.lineWidth = 0.9 * u
  glow(g, COLORS.lean, p.hi, u)
  g.beginPath()
  g.arc(cx, ground, R, Math.min(toAng(0), toAng(lean)), Math.max(toAng(0), toAng(lean)))
  g.stroke()
  noGlow(g)
  // 最大リーンの印
  if (peak !== null && Math.abs(peak) > 1) {
    const a = toAng(peak)
    g.fillStyle = COLORS.temp
    g.beginPath()
    g.arc(cx + Math.cos(a) * R, ground + Math.sin(a) * R, 0.7 * u, 0, Math.PI * 2)
    g.fill()
  }
  // バイク（後ろ姿）を接地点まわりに傾ける。右リーンが正
  g.save()
  g.translate(cx, ground)
  g.rotate((lean * Math.PI) / 180)
  g.fillStyle = '#ffffff'
  g.beginPath()
  g.roundRect(-0.9 * u, -3.6 * u, 1.8 * u, 3.6 * u, 0.9 * u) // タイヤ
  g.fill()
  g.beginPath()
  g.moveTo(-2.4 * u, -4.2 * u) // 車体
  g.lineTo(2.4 * u, -4.2 * u)
  g.lineTo(1.4 * u, -2.6 * u)
  g.lineTo(-1.4 * u, -2.6 * u)
  g.closePath()
  g.fill()
  g.fillRect(-3.2 * u, -5 * u, 6.4 * u, 0.5 * u) // ハンドル
  g.beginPath()
  g.roundRect(-1.3 * u, -7.6 * u, 2.6 * u, 3.2 * u, 0.8 * u) // ライダーの胴
  g.fill()
  g.beginPath()
  g.arc(0, -8.6 * u, 1.25 * u, 0, Math.PI * 2) // ヘルメット
  g.fill()
  g.restore()
  // 数字
  font(g, 4.6 * u)
  g.fillStyle = COLORS.text
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  glow(g, COLORS.lean, p.hi * 0.8, u)
  g.fillText(`${Math.abs(lean).toFixed(0)}°`, cx + (lean >= 0 ? -1 : 1) * 6.2 * u, cy - 1.6 * u)
  noGlow(g)
  font(g, 1.8 * u, 600)
  g.fillStyle = COLORS.sub
  g.fillText(lean >= 0 ? 'RIGHT' : 'LEFT', cx + (lean >= 0 ? -1 : 1) * 6.2 * u, cy + 0.6 * u)
  if (peak !== null && Math.abs(peak) > 1) {
    g.fillStyle = COLORS.temp
    g.fillText(`MAX ${Math.abs(peak).toFixed(0)}°`, cx + (lean >= 0 ? 1 : -1) * 6.2 * u, cy - 3.8 * u)
  }
  g.restore()
}

/** 前後G: 0 を中心とした縦バー（上 = 加速・緑、下 = 減速・赤）とブレーキ圧 */
export function drawGForce(g: Ctx, v: Values, p: Pose, o: MeterOpts): void {
  const acc = v.accelG
  if (acc === undefined) return
  const { cx, cy, u } = p
  const H = 20 * u
  const W = 2.6 * u
  g.save()
  g.globalAlpha = p.a
  panel(g, cx - 4 * u, cy - H / 2 - 2 * u, 8.6 * u, H + 4.6 * u, 0.6 * u)
  g.fillStyle = 'rgba(255,255,255,0.12)'
  g.fillRect(cx - W / 2, cy - H / 2, W, H)
  const f = clamp(acc / o.gMax, -1, 1)
  const col = acc >= 0 ? COLORS.accel : COLORS.brake
  g.fillStyle = col
  glow(g, col, p.hi, u)
  if (f >= 0) g.fillRect(cx - W / 2, cy - (f * H) / 2, W, (f * H) / 2)
  else g.fillRect(cx - W / 2, cy, W, (-f * H) / 2)
  noGlow(g)
  g.fillStyle = '#ffffff'
  g.fillRect(cx - W, cy - 0.12 * u, W * 2, 0.24 * u)
  // ブレーキ圧（右の細いバー、0〜20bar）
  const bar = Math.max(v.brakeFront ?? 0, v.brakeRear ?? 0)
  if (bar > 0.5) {
    const bf = clamp(bar / 20, 0, 1)
    g.fillStyle = COLORS.brake
    g.fillRect(cx + W / 2 + 0.8 * u, cy + H / 2 - bf * H, 0.8 * u, bf * H)
  }
  font(g, 2.7 * u)
  g.fillStyle = COLORS.text
  g.textAlign = 'center'
  g.textBaseline = 'top'
  g.fillText(`${acc >= 0 ? '+' : '−'}${Math.abs(acc).toFixed(2)}`, cx, cy + H / 2 + 0.5 * u)
  font(g, 1.7 * u, 600)
  g.fillStyle = COLORS.sub
  g.textBaseline = 'bottom'
  g.fillText('G', cx, cy - H / 2 - 0.3 * u)
  g.restore()
}

/** 外気温 */
export function drawTemp(g: Ctx, v: Values, p: Pose): void {
  const t = v.airTemp
  if (t === undefined) return
  const { cx, cy, u } = p
  g.save()
  g.globalAlpha = p.a
  panel(g, cx - 6 * u, cy - 2.4 * u, 12 * u, 4.8 * u, 0.5 * u)
  // 温度計のアイコン
  g.strokeStyle = COLORS.temp
  g.fillStyle = COLORS.temp
  g.lineWidth = 0.4 * u
  g.beginPath()
  g.roundRect(cx - 4.4 * u, cy - 1.8 * u, 0.9 * u, 2.6 * u, 0.45 * u)
  g.stroke()
  g.beginPath()
  g.arc(cx - 3.95 * u, cy + 1.1 * u, 0.75 * u, 0, Math.PI * 2)
  g.fill()
  glow(g, COLORS.temp, p.hi, u)
  font(g, 3 * u)
  g.fillStyle = COLORS.text
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillText(`${t.toFixed(0)}°C`, cx - 2.4 * u, cy + 0.2 * u)
  g.restore()
}

// ---- 個別のウィジェット（レイヤーの矩形に1つのメーター） ----

export type MeterKind = 'speed' | 'gear' | 'rpm' | 'lean' | 'gforce' | 'temp'

/** 各メーターの、u=1 のときのおおよその大きさ（矩形に収めるため） */
const NATURAL: Record<MeterKind, [number, number]> = {
  speed: [20, 12.5],
  gear: [8.8, 10.5],
  rpm: [29, 8],
  lean: [24, 21],
  gforce: [9.8, 27],
  temp: [13, 5.2]
}

export function drawSingleMeter(g: Ctx, kind: MeterKind, r: { x: number; y: number; w: number; h: number }, v: Values, o: MeterOpts, peak: number | null, hi = 0): void {
  const [nw, nh] = NATURAL[kind]
  const u = Math.min(r.w / nw, r.h / nh)
  const p: Pose = { cx: r.x + r.w / 2, cy: r.y + r.h / 2, u, a: 1, hi }
  if (kind === 'lean') p.cy = r.y + r.h / 2 - 0.5 * u
  const draw: Record<MeterKind, () => void> = {
    speed: () => drawSpeed(g, v, p),
    gear: () => drawGear(g, v, p),
    rpm: () => drawRpm(g, v, p, o),
    lean: () => drawLean(g, v, p, o, peak),
    gforce: () => drawGForce(g, v, p, o),
    temp: () => drawTemp(g, v, p)
  }
  draw[kind]()
}

// ---- メーター一式（走行状態で見た目が移り変わる） ----

/** メーター一式の座標空間（幅 100 × 高さ 34。レイヤーの矩形に縦横比を保って収める） */
const DW = 100
const DH = 34

type Layout = Record<MeterKind, Pose>
const P = (cx: number, cy: number, s: number, a: number, hi = 0): Pose => ({ cx, cy, u: s, a, hi })

/**
 * 走行状態ごとの配置（cx, cy は座標空間、u は倍率）。
 * 巡航: 全体を控えめに / 加速: 回転・ギア・速度・加速Gを強調 / 減速: 減速Gとブレーキを大きく赤く /
 * コーナリング: リーンを大きく中央寄りに / 停止: 外気温を大きく、他は小さく
 */
export const LAYOUTS: Record<RidingState, Layout> = {
  cruise: {
    lean: P(15, 19, 0.75, 0.8),
    speed: P(48, 20, 1.0, 1),
    gear: P(63, 20, 0.95, 1),
    rpm: P(51, 6, 1.0, 0.85),
    gforce: P(81, 18, 0.95, 0.75),
    temp: P(93, 29, 0.8, 0.85)
  },
  accel: {
    lean: P(13, 21, 0.62, 0.55),
    speed: P(46, 21, 1.15, 1, 0.4),
    gear: P(63, 21, 1.2, 1, 1),
    rpm: P(51, 6, 1.28, 1, 1),
    gforce: P(81, 18, 1.0, 1, 0.9),
    temp: P(93, 30, 0.7, 0.6)
  },
  brake: {
    lean: P(13, 21, 0.62, 0.55),
    speed: P(44, 21, 1.15, 1, 0.5),
    gear: P(59, 21, 1.0, 1),
    rpm: P(48, 6, 0.9, 0.55),
    gforce: P(78, 17, 1.25, 1, 1),
    temp: P(93, 30, 0.7, 0.6)
  },
  corner: {
    lean: P(22, 17, 1.25, 1, 1),
    speed: P(52, 21, 0.95, 1),
    gear: P(66, 21, 0.9, 1),
    rpm: P(56, 6, 0.85, 0.7),
    gforce: P(85, 18, 0.8, 0.55),
    temp: P(94, 30, 0.7, 0.6)
  },
  stop: {
    lean: P(14, 20, 0.6, 0.35),
    speed: P(42, 20, 0.85, 0.9),
    gear: P(55, 20, 0.85, 0.9),
    rpm: P(45, 7, 0.8, 0.6),
    gforce: P(70, 18, 0.7, 0.35),
    temp: P(84, 18, 1.7, 1, 1)
  }
}

/** 状態の重みで配置を補間する */
export function blendLayout(weights: number[]): Layout {
  const out = {} as Layout
  for (const k of Object.keys(LAYOUTS.cruise) as MeterKind[]) {
    const q: Pose = { cx: 0, cy: 0, u: 0, a: 0, hi: 0 }
    STATES.forEach((s, i) => {
      const w = weights[i] ?? 0
      const L = LAYOUTS[s][k]
      q.cx += L.cx * w
      q.cy += L.cy * w
      q.u += L.u * w
      q.a += L.a * w
      q.hi += L.hi * w
    })
    out[k] = q
  }
  return out
}

export function drawDashboard(
  g: Ctx,
  r: { x: number; y: number; w: number; h: number },
  v: Values,
  o: MeterOpts,
  weights: number[],
  peak: number | null
): void {
  // 座標空間 DW×DH を矩形に縦横比を保って収め、下寄せにする
  const k = Math.min(r.w / DW, r.h / DH)
  const ox = r.x + (r.w - DW * k) / 2
  const oy = r.y + (r.h - DH * k)
  const L = blendLayout(weights)
  const pose = (m: MeterKind): Pose => ({ cx: ox + L[m].cx * k, cy: oy + L[m].cy * k, u: L[m].u * k, a: L[m].a, hi: L[m].hi })
  // 奥から: 気温 → 前後G → リーン → 回転 → ギア → 速度
  drawTemp(g, v, pose('temp'))
  drawGForce(g, v, pose('gforce'), o)
  drawLean(g, v, pose('lean'), o, peak)
  drawRpm(g, v, pose('rpm'), o)
  drawGear(g, v, pose('gear'))
  drawSpeed(g, v, pose('speed'))
}
