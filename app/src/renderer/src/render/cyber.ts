// サイバー風メーター（HUD）。配置はクロノグラフ風（chrono.ts）とまったく同じで、見た目だけを変える（速度は出さない）。
//
//   一番外側・上半分: タコメーター（区切りのあるネオンの弧。レッドゾーンつき）
//   一番外側・下半分: 6時から外向きに伸びる区切りの弧。右 = アクセル開度、左 = ブレーキ圧
//   内側・上半分    : リーンメーター（真上が 0°）。MAX ホールドは切り返しでリセット
//   中央            : 現在のリーン角（大きく）と MAX
//   内側・下半分    : ギア段と外気温（六角形のサブダイヤル）
// 文字盤は半透明の暗いガラスに走査線、線はネオンで発光。配色は BMW（M カラー）とネオン（シアン・マゼンタ）。
import type { ChronoEmphasis } from './chrono'
import { airTempColor, M_COLORS } from './chrono'
import { POP_TIME, ROLL_TIME, type Roll } from './overlay'
import type { Ctx, Values } from './meters'

const MONO = "Bahnschrift, 'Cascadia Mono', Consolas, monospace"

export type CyberTheme = 'bmw' | 'neon'

export interface CyberOpts {
  rpmMax: number
  rpmRed: number
  brakeMax: number
  leanMax: number
  theme: CyberTheme
}

export const DEFAULT_CYBER: CyberOpts = { rpmMax: 9000, rpmRed: 8000, brakeMax: 20, leanMax: 60, theme: 'bmw' }

interface Pal {
  line: string // 主な線の色
  line2: string // 補助の色（高回転側）
  hot: string // レッドゾーン・ブレーキ・MAX
  thr: string
  lean: string
  bg0: string // 文字盤（中心）
  bg1: string // 文字盤（外周）
  dim: string // 消えている区切り
  text: string
  sub: string
  stripes: string[] | null
}

const PALS: Record<CyberTheme, Pal> = {
  bmw: {
    line: M_COLORS.light,
    line2: M_COLORS.dark,
    hot: M_COLORS.red,
    thr: M_COLORS.light,
    lean: '#8fd0ff',
    bg0: 'rgba(14, 30, 58, 0.72)',
    bg1: 'rgba(2, 6, 14, 0.78)',
    dim: 'rgba(92,184,255,0.13)',
    text: '#e8f4ff',
    sub: 'rgba(160,210,255,0.7)',
    stripes: [M_COLORS.light, M_COLORS.dark, M_COLORS.red]
  },
  neon: {
    line: '#00f0ff',
    line2: '#7a5cff',
    hot: '#ff2bd6',
    thr: '#00ff9c',
    lean: '#00f0ff',
    bg0: 'rgba(10, 20, 40, 0.7)',
    bg1: 'rgba(2, 4, 10, 0.78)',
    dim: 'rgba(0,240,255,0.12)',
    text: '#eaffff',
    sub: 'rgba(0,240,255,0.65)',
    stripes: null
  }
}

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x))
const TAU = Math.PI * 2
/** 文字の大きさの倍率（以前の 1.5 倍。小さくて読みにくかったため） */
const TEXT_SCALE = 1.5
/** 数字が置き換わった瞬間の拡大の量（1 + この値 倍） */
const POP_SCALE = 0.4

// ---- エンジン停止中の灰色（配色を、明るさを保った灰色へ混ぜる）----
function parseColor(c: string): [number, number, number, number] | null {
  const h = /^#([0-9a-f]{6})$/i.exec(c)
  if (h) {
    const n = parseInt(h[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(c)
  if (!m) return null
  const p = m[1].split(',').map((x) => parseFloat(x))
  return [p[0], p[1], p[2], p[3] ?? 1]
}

/** 色 c を灰色へ k（0〜1）だけ近づける。灰色は明るさ（輝度）を保ち、少し暗くする */
function toGrey(c: string, k: number): string {
  const p = parseColor(c)
  if (!p) return c
  const l = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) * 0.85
  const mix = (v: number): number => Math.round(v + (l - v) * k)
  return `rgba(${mix(p[0])},${mix(p[1])},${mix(p[2])},${p[3]})`
}

/** 配色を灰色へ k だけ近づけたもの */
function greyPal(P: Pal, k: number): Pal {
  const out = { ...P } as Record<string, unknown>
  for (const [key, v] of Object.entries(P)) {
    if (typeof v === 'string') out[key] = toGrey(v, k)
    else if (Array.isArray(v)) out[key] = v.map((c: string) => toGrey(c, k))
  }
  return out as unknown as Pal
}

/**
 * power: エンジンが掛かっている度合い（1 = 掛かっている、0 = 止まっている）。止まっている間は配色を灰色にする
 */
export function drawCyber(
  g: Ctx,
  rect: { x: number; y: number; w: number; h: number },
  v: Values,
  o: CyberOpts,
  hold: number | null,
  em: ChronoEmphasis,
  power = 1,
  /**
   * ギアと外気温の数字の切り替わり（overlay.ts の gearShift・airShift）と、表示する外気温（ちらつき防止の後の整数）。
   * 数字が増えるときは前の数字が上へ出て下から新しい数字が入り、減るときは逆。置き換わった瞬間に少し大きく見せる
   */
  rolls: { gear: Roll | null; air: Roll | null; airShown: number | null } | null = null
): void {
  const base = PALS[o.theme] ?? PALS.bmw
  const P = power >= 1 ? base : greyPal(base, 1 - clamp(power, 0, 1))
  const R = Math.min(rect.w, rect.h) / 2
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  g.save()

  const glow = (col: string, amt: number): void => {
    g.shadowColor = col
    g.shadowBlur = Math.min(28, R * 0.05 * amt)
  }
  const noGlow = (): void => {
    g.shadowBlur = 0
  }
  const text = (s: string, x: number, y: number, px0: number, col: string, weight = 600, spacing = 0.12): void => {
    const px = px0 * TEXT_SCALE
    g.font = `${weight} ${Math.max(1, px).toFixed(1)}px ${MONO}`
    ;(g as CanvasRenderingContext2D).letterSpacing = `${(px * spacing).toFixed(1)}px`
    g.fillStyle = col
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(s, x, y)
    ;(g as CanvasRenderingContext2D).letterSpacing = '0px'
  }
  const ring = (r: number, a0: number, a1: number, w: number, col: string): void => {
    if (Math.abs(a1 - a0) < 1e-4) return
    g.strokeStyle = col
    g.lineWidth = w
    g.beginPath()
    g.arc(cx, cy, r, Math.min(a0, a1), Math.max(a0, a1))
    g.stroke()
  }
  const tick = (r0: number, r1: number, a: number, w: number, col: string): void => {
    g.strokeStyle = col
    g.lineWidth = w
    g.beginPath()
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
    g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
    g.stroke()
  }
  /** 区切りのある弧。from から to へ n 個に分け、先頭から lit 個を点ける */
  const segArc = (r: number, from: number, to: number, n: number, lit: number, w: number, color: (frac: number) => string, amt: number): void => {
    const step = (to - from) / n
    const gap = Math.abs(step) * 0.22
    g.lineCap = 'butt'
    for (let s = 0; s < n; s++) {
      const a0 = from + s * step
      const a1 = a0 + step
      const on = s < lit
      const col = on ? color((s + 0.5) / n) : P.dim
      if (on && amt > 0.02) glow(col, amt)
      g.strokeStyle = col
      g.lineWidth = w
      g.beginPath()
      g.arc(cx, cy, r, Math.min(a0, a1) + gap / 2, Math.max(a0, a1) - gap / 2)
      g.stroke()
      noGlow()
    }
  }

  // ---- 文字盤: 半透明のガラスと走査線、発光する外周 ----
  const face = g.createRadialGradient(cx, cy - R * 0.25, R * 0.05, cx, cy, R)
  face.addColorStop(0, P.bg0)
  face.addColorStop(1, P.bg1)
  g.beginPath()
  g.arc(cx, cy, R * 0.96, 0, TAU)
  g.fillStyle = face
  g.fill()
  g.save()
  g.beginPath()
  g.arc(cx, cy, R * 0.96, 0, TAU)
  g.clip()
  g.fillStyle = 'rgba(255,255,255,0.03)'
  const sl = Math.max(2, R * 0.025)
  for (let y = cy - R; y < cy + R; y += sl) g.fillRect(cx - R, y, R * 2, sl * 0.3)
  g.restore()
  // 外周: 発光リングを 4 つに分け、3時・6時・9時・12時に切れ目
  g.globalAlpha = 0.9
  glow(P.line, 1)
  for (let q = 0; q < 4; q++) ring(R * 0.96, (q * Math.PI) / 2 + 0.07, ((q + 1) * Math.PI) / 2 - 0.07, R * 0.012, P.line)
  noGlow()
  g.globalAlpha = 1
  // 外周の細かい目盛り（飾り）
  for (let k = 0; k < 120; k++) {
    const a = (k / 120) * TAU
    tick(R * 0.915, R * (k % 10 === 0 ? 0.885 : 0.9), a, R * (k % 10 === 0 ? 0.008 : 0.004), k % 10 === 0 ? P.sub : 'rgba(255,255,255,0.18)')
  }
  // 斜め 4 方向の括弧（HUD らしさ）
  for (const a of [-Math.PI * 0.75, -Math.PI * 0.25, Math.PI * 0.25, Math.PI * 0.75]) ring(R, a - 0.09, a + 0.09, R * 0.012, P.line)

  // ---- 一番外側・上半分: タコメーター ----
  const rO = R * 0.81
  const wO = R * 0.085
  const red = clamp(o.rpmRed / o.rpmMax, 0, 1)
  const rpm = v.rpm
  const nT = 45
  const litT = rpm === undefined ? 0 : clamp(rpm / o.rpmMax, 0, 1) * nT
  const overRed = rpm !== undefined && rpm >= o.rpmRed
  segArc(rO, Math.PI, TAU, nT, litT, wO, (f) => (f >= red ? P.hot : f > 0.6 ? P.line2 : P.line), overRed ? 1.6 : em.rpm * 1.4)
  // レッドゾーンの内側に細い赤線
  ring(rO - wO * 0.75, Math.PI + red * Math.PI, TAU, R * 0.01, P.hot)
  for (let r = 0; r <= o.rpmMax + 1; r += 1000) {
    const a = Math.PI + (r / o.rpmMax) * Math.PI
    const hot = r >= o.rpmRed
    tick(rO - wO * 0.6, rO - wO * 0.6 - R * 0.05, a, R * 0.01, hot ? P.hot : P.line)
    text(String(r / 1000), cx + Math.cos(a) * R * 0.66, cy + Math.sin(a) * R * 0.66, R * 0.07, hot ? P.hot : P.text, 700, 0)
  }
  text('RPM x1000', cx, cy - R * 0.6, R * 0.036, P.sub, 600, 0.25)

  // ---- 一番外側・下半分: アクセル開度（右）とブレーキ圧（左）。6時から外向きに伸びる ----
  const bottom = Math.PI / 2
  const quarter = Math.PI / 2 - 0.08
  const nB = 16
  const thr = v.throttle
  const brk = Math.max(v.brakeFront ?? 0, v.brakeRear ?? 0)
  const hasBrk = v.brakeFront !== undefined || v.brakeRear !== undefined
  segArc(rO, bottom, bottom - quarter, nB, thr === undefined ? 0 : clamp(thr / 100, 0, 1) * nB, wO, () => P.thr, Math.max(em.throttle * 1.4, 0.3))
  segArc(rO, bottom, bottom + quarter, nB, hasBrk ? clamp(brk / o.brakeMax, 0, 1) * nB : 0, wO, () => P.hot, Math.max(em.brake * 1.4, 0.3))
  const vx = R * 0.47
  const vy = R * 0.47
  text('THR', cx + vx, cy + vy - R * 0.08, R * 0.042, P.thr, 700, 0.3)
  text(thr !== undefined ? `${Math.round(thr)}%` : '--', cx + vx, cy + vy, R * 0.085, P.text, 700, 0.02)
  text('BRK', cx - vx, cy + vy - R * 0.08, R * 0.042, P.hot, 700, 0.3)
  text(hasBrk ? brk.toFixed(1) : '--', cx - vx, cy + vy, R * 0.085, P.text, 700, 0.02)
  text('bar', cx - vx, cy + vy + R * 0.075, R * 0.034, P.sub, 600, 0.2)

  // ---- 内側・上半分: リーンメーター ----
  const rI = R * 0.5
  const wI = R * 0.03
  const top = -Math.PI / 2
  const leanAng = (d: number): number => top + clamp(d / o.leanMax, -1, 1) * (Math.PI / 2)
  ring(rI, Math.PI, TAU, wI, P.dim)
  for (let d = -o.leanMax; d <= o.leanMax + 0.1; d += 5) {
    const major = d % 30 === 0
    const mid = d % 15 === 0
    tick(rI + wI, rI + wI + R * (major ? 0.055 : mid ? 0.035 : 0.018), leanAng(d), R * (major ? 0.01 : 0.005), major ? P.line : 'rgba(255,255,255,0.35)')
    // 端（±leanMax）の数字は L・R の文字と重なるので出さない
    if (major && d !== 0 && Math.abs(d) < o.leanMax - 0.1) text(String(Math.abs(d)), cx + Math.cos(leanAng(d)) * R * 0.4, cy + Math.sin(leanAng(d)) * R * 0.4, R * 0.042, P.sub, 600, 0)
  }
  text('L', cx - rI, cy + R * 0.075, R * 0.05, P.sub, 700, 0)
  text('R', cx + rI, cy + R * 0.075, R * 0.05, P.sub, 700, 0)
  const lean = v.lean
  if (lean !== undefined) {
    const a = leanAng(lean)
    glow(P.lean, 1 + em.lean * 2)
    ring(rI, top, a, wI * 2.2, P.lean)
    noGlow()
    // 指標: リングに乗る三角（外向き）
    g.save()
    g.translate(cx + Math.cos(a) * rI, cy + Math.sin(a) * rI)
    g.rotate(a + Math.PI / 2)
    glow(P.lean, 1.2)
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.moveTo(0, -R * 0.075)
    g.lineTo(-R * 0.035, R * 0.01)
    g.lineTo(R * 0.035, R * 0.01)
    g.closePath()
    g.fill()
    noGlow()
    g.restore()
  }
  // MAX ホールドの印（山形）
  if (hold !== null && Math.abs(hold) > 1) {
    const a = leanAng(hold)
    g.save()
    g.translate(cx + Math.cos(a) * (rI + R * 0.085), cy + Math.sin(a) * (rI + R * 0.085))
    g.rotate(a + Math.PI / 2)
    g.strokeStyle = P.hot
    g.lineWidth = R * 0.012
    glow(P.hot, 0.8)
    g.beginPath()
    g.moveTo(-R * 0.03, -R * 0.02)
    g.lineTo(0, R * 0.015)
    g.lineTo(R * 0.03, -R * 0.02)
    g.stroke()
    noGlow()
    g.restore()
  }

  // ---- 中央: 現在のリーン角と MAX ----
  if (lean !== undefined) {
    text('LEAN', cx, cy - R * 0.315, R * 0.04, P.sub, 600, 0.35)
    glow(P.lean, 0.8 + em.lean * 1.6)
    text(`${Math.abs(lean).toFixed(0)}°`, cx, cy - R * 0.13, R * 0.2, P.text, 700, 0)
    noGlow()
    if (hold !== null && Math.abs(hold) > 1) text(`MAX ${Math.abs(hold).toFixed(0)}° ${hold > 0 ? 'R' : 'L'}`, cx, cy + R * 0.02, R * 0.05, P.hot, 700, 0.12)
  }

  // ---- 内側・下半分: ギア段と外気温（六角形） ----
  const hex = (sx: number, title: string, val: string, col: string, amt: number, roll: { prev: string; e: number; dir: number; col?: string } | null = null): void => {
    const sy = cy + R * 0.36
    const sr = R * 0.14
    const hexPath = (r: number): void => {
      g.beginPath()
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i
        const x = sx + Math.cos(a) * r
        const y = sy + Math.sin(a) * r
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.closePath()
    }
    hexPath(sr)
    g.fillStyle = 'rgba(255,255,255,0.04)'
    g.fill()
    g.strokeStyle = P.line
    g.lineWidth = R * 0.008
    glow(P.line, 0.5 + amt)
    g.stroke()
    noGlow()
    text(title, sx, sy - sr * 0.55, R * 0.034, P.sub, 600, 0.3)
    glow(col, 0.4 + amt)
    const big = (s: string, y = 0, scale = 1, c = col): void => {
      const px = R * (s.length > 3 ? 0.07 : 0.11)
      if (scale === 1) return text(s, sx, sy + sr * 0.15 + y, px, c, 700, 0)
      // 大きくするときは、文字の中心を保ったまま拡大する
      g.save()
      g.translate(sx, sy + sr * 0.15 + y)
      g.scale(scale, scale)
      text(s, 0, 0, px, c, 700, 0)
      g.restore()
    }
    if (roll && roll.prev !== val) {
      if (roll.e < ROLL_TIME) {
        // 縦に流れて入れ替わる（枠の内側だけに描く）。新しい数字は入ってくる間に大きくなる
        const k0 = roll.e / ROLL_TIME
        const k = k0 * k0 * (3 - 2 * k0)
        const d = sr * 1.5 // 流れる距離（枠の高さより少し長く、外へ出きる）
        g.save()
        hexPath(sr * 0.93)
        g.clip()
        big(roll.prev, -roll.dir * d * k, 1, roll.col ?? col)
        big(val, roll.dir * d * (1 - k), 1 + POP_SCALE * k)
        g.restore()
      } else {
        // 置き換わった瞬間に大きく、POP_TIME 秒で元の大きさへ（枠から少しはみ出してよい）
        const p = Math.min(1, (roll.e - ROLL_TIME) / POP_TIME)
        big(val, 0, 1 + POP_SCALE * (1 - p) * (1 - p))
      }
    } else big(val)
    noGlow()
  }
  const gearText = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? '--' : x <= 0 ? 'N' : String(Math.round(x)))
  const gear = v.gear
  // 数字が増えるとき（シフトアップ・気温が上がる）は前の数字が上へ出て下から入り、減るときは逆
  const gr = rolls?.gear
  hex(cx - R * 0.17, 'GEAR', gearText(gear), P.text, em.rpm, gr && gear !== undefined ? { prev: gearText(gr.prev), e: gr.e, dir: gear >= gr.prev ? 1 : -1 } : null)
  // 外気温: ちらつき防止の後の整数（無ければ測った値を丸めたもの）
  const temp = rolls?.airShown ?? (v.airTemp === undefined ? undefined : Math.round(v.airTemp))
  // 単位（℃）は六角形に入りきらないので省く
  const tempText = (x: number | undefined): string => (x === undefined || !Number.isFinite(x) ? '--' : x.toFixed(0))
  // 色は温度で変える（5℃ 以下は水色、30℃ 以上は黄色、35℃ 以上はオレンジ、40℃ 以上は赤、それ以外は白）。エンジン停止中は灰色へ
  const tCol = (x: number | undefined): string => (power >= 1 ? airTempColor(x) : toGrey(airTempColor(x), 1 - clamp(power, 0, 1)))
  const ar = rolls?.air
  hex(cx + R * 0.17, 'AIR', tempText(temp), tCol(temp), 0, ar && temp !== undefined ? { prev: tempText(ar.prev), e: ar.e, dir: temp >= ar.prev ? 1 : -1, col: tCol(ar.prev) } : null)

  // M カラーの細いライン（BMW テーマ）
  if (P.stripes) {
    const sw = R * 0.06
    P.stripes.forEach((col, k) => {
      g.fillStyle = col
      g.fillRect(cx + (k - 1.5) * sw * 1.1, cy + R * 0.6, sw, R * 0.012)
    })
  }
  g.restore()
}
