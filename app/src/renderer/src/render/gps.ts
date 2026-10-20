// GPS の表示: 地図・標高プロファイル・方位帯。
// ルートの形（5Hz に間引いた点列と Path2D）はテレメトリーごとに1回だけ作ってキャッシュする。
import { sampleChannel, type Telemetry } from '../core/telemetry'
import { COLORS, type Ctx } from './meters'
import { getLang, tr, type Lang } from '../i18n'

const NUM = "Bahnschrift, 'Segoe UI', sans-serif"
const JP = "'Yu Gothic UI', 'Meiryo UI', sans-serif"

interface Route {
  t: Float32Array // 動画時刻 [s]
  x: Float32Array // 東 [m]
  y: Float32Array // 北 [m]
  d: Float32Array // 走行距離 [km]
  alt: Float32Array // 標高 [m]（無ければ NaN）
  n: number
  /** 地図の座標（x = 東、y = 北）のままの経路。NaN の区間で切れる */
  path: Path2D
  minX: number
  maxX: number
  minY: number
  maxY: number
  altMin: number
  altMax: number
  dMax: number
}

const cache = new WeakMap<Telemetry, Route | null>()
const STEP = 20 // 100Hz → 5Hz

export function getRoute(tel: Telemetry): Route | null {
  if (cache.has(tel)) return cache.get(tel)!
  const X = tel.channels.gpsX
  const Y = tel.channels.gpsY
  const D = tel.channels.distance
  const A = tel.channels.alt
  if (!X || !Y || !D) {
    cache.set(tel, null)
    return null
  }
  const m = Math.ceil(tel.n / STEP)
  const r: Route = {
    t: new Float32Array(m),
    x: new Float32Array(m),
    y: new Float32Array(m),
    d: new Float32Array(m),
    alt: new Float32Array(m),
    n: m,
    path: new Path2D(),
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    altMin: Infinity,
    altMax: -Infinity,
    dMax: 0
  }
  let pen = false
  for (let k = 0; k < m; k++) {
    const i = Math.min(tel.n - 1, k * STEP)
    r.t[k] = i / tel.rate
    r.x[k] = X[i]
    r.y[k] = Y[i]
    r.d[k] = D[i]
    r.alt[k] = A ? A[i] : NaN
    if (Number.isNaN(X[i])) {
      pen = false
      continue
    }
    if (pen) r.path.lineTo(X[i], Y[i])
    else r.path.moveTo(X[i], Y[i])
    pen = true
    r.minX = Math.min(r.minX, X[i])
    r.maxX = Math.max(r.maxX, X[i])
    r.minY = Math.min(r.minY, Y[i])
    r.maxY = Math.max(r.maxY, Y[i])
    if (!Number.isNaN(D[i])) r.dMax = Math.max(r.dMax, D[i])
    if (A && !Number.isNaN(A[i])) {
      r.altMin = Math.min(r.altMin, A[i])
      r.altMax = Math.max(r.altMax, A[i])
    }
  }
  if (!Number.isFinite(r.minX)) {
    cache.set(tel, null)
    return null
  }
  cache.set(tel, r)
  return r
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function message(g: Ctx, r: Box, text: string): void {
  g.fillStyle = COLORS.panel
  g.fillRect(r.x, r.y, r.w, r.h)
  g.fillStyle = '#ddd'
  g.font = `${Math.round(Math.min(r.h * 0.18, r.w * 0.07))}px ${JP}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, r.x + r.w / 2, r.y + r.h / 2)
  g.textAlign = 'left'
}

// ---- 地図 ----

export interface MapProps {
  mode: 'local' | 'route' // local = 現在地のまわりを進行方向を上に / route = ルート全体を北を上に
  rangeM: number // local のとき、中心から縁までの距離 [m]
  shape: 'circle' | 'rect'
}

export const DEFAULT_MAP: MapProps = { mode: 'local', rangeM: 600, shape: 'circle' }

export function drawMap(g: Ctx, r: Box, tel: Telemetry | null, t: number, props: Partial<MapProps>, lang: Lang = getLang()): void {
  const p = { ...DEFAULT_MAP, ...props }
  const route = tel ? getRoute(tel) : null
  if (!tel || !route) return message(g, r, tr(lang, 'GPS データなし'))
  const px = sampleChannel(tel, 'gpsX', t)
  const py = sampleChannel(tel, 'gpsY', t)
  const head = sampleChannel(tel, 'heading', t) ?? 0
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const R = Math.min(r.w, r.h) / 2
  g.save()
  // 背景と切り抜き
  g.beginPath()
  if (p.shape === 'circle') g.arc(cx, cy, R, 0, Math.PI * 2)
  else g.roundRect(r.x, r.y, r.w, r.h, R * 0.08)
  g.fillStyle = 'rgba(12, 14, 18, 0.6)'
  g.fill()
  g.clip()
  // ワールド（東・北 [m]）→ 画面 の変換
  let s: number
  let h: number
  let ox: number
  let oy: number
  if (p.mode === 'local' && px !== null && py !== null) {
    s = (R * 0.92) / p.rangeM
    h = (head * Math.PI) / 180 // 進行方向が上になるよう回す
    ox = px
    oy = py
  } else {
    const bw = Math.max(route.maxX - route.minX, 1)
    const bh = Math.max(route.maxY - route.minY, 1)
    // 円: ルートの外接矩形の対角線が円に収まる / 矩形: 縦横それぞれに収まる
    s = p.shape === 'circle' ? (R * 1.8) / Math.hypot(bw, bh) : Math.min((r.w * 0.88) / bw, (r.h * 0.88) / bh)
    h = 0
    ox = (route.minX + route.maxX) / 2
    oy = (route.minY + route.maxY) / 2
  }
  const cos = Math.cos(h)
  const sin = Math.sin(h)
  const toScreen = (x: number, y: number): [number, number] => {
    const dx = x - ox
    const dy = y - oy
    return [cx + s * (cos * dx - sin * dy), cy - s * (sin * dx + cos * dy)]
  }
  // ルート全体（暗め）: Path2D をそのまま変換して描く
  g.save()
  g.setTransform(
    ...((): [number, number, number, number, number, number] => {
      const base = g.getTransform()
      // base · M（M: ワールド → 画面）
      const a = s * cos
      const b = -s * sin
      const c = -s * sin
      const d = -s * cos
      const e = cx - s * (cos * ox - sin * oy)
      const f = cy + s * (sin * ox + cos * oy)
      return [base.a * a + base.c * b, base.b * a + base.d * b, base.a * c + base.c * d, base.b * c + base.d * d, base.a * e + base.c * f + base.e, base.b * e + base.d * f + base.f]
    })()
  )
  g.lineJoin = 'round'
  g.lineCap = 'round'
  g.strokeStyle = 'rgba(255,255,255,0.28)'
  g.lineWidth = (R * 0.035) / s
  g.stroke(route.path)
  g.restore()
  // 走った区間（明るく）
  const k1 = Math.min(route.n - 1, Math.floor(t * 5))
  g.strokeStyle = COLORS.lean
  g.lineWidth = R * 0.045
  g.lineJoin = 'round'
  g.lineCap = 'round'
  g.beginPath()
  let pen = false
  // 局所表示では画面の外の点は描かなくてよいが、点の数は数千なのでそのまま描く
  for (let k = 0; k <= k1; k++) {
    if (Number.isNaN(route.x[k])) {
      pen = false
      continue
    }
    const [sx, sy] = toScreen(route.x[k], route.y[k])
    if (pen) g.lineTo(sx, sy)
    else g.moveTo(sx, sy)
    pen = true
  }
  if (px !== null && py !== null && pen) g.lineTo(...toScreen(px, py))
  g.stroke()
  // 現在地の矢印（進行方向を向く）
  if (px !== null && py !== null) {
    const [sx, sy] = toScreen(px, py)
    const ang = (head * Math.PI) / 180 - h // 画面上での向き（上 = 0、時計回り）
    g.save()
    g.translate(sx, sy)
    g.rotate(ang)
    g.shadowColor = '#ffffff'
    g.shadowBlur = R * 0.12
    g.fillStyle = '#ffffff'
    g.beginPath()
    const a = R * 0.09
    g.moveTo(0, -a * 1.3)
    g.lineTo(a * 0.85, a)
    g.lineTo(0, a * 0.45)
    g.lineTo(-a * 0.85, a)
    g.closePath()
    g.fill()
    g.restore()
  }
  g.restore()
  // 縁取りと北の印
  g.save()
  g.beginPath()
  if (p.shape === 'circle') g.arc(cx, cy, R - 1, 0, Math.PI * 2)
  else g.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, R * 0.08)
  g.strokeStyle = 'rgba(255,255,255,0.35)'
  g.lineWidth = Math.max(1, R * 0.015)
  g.stroke()
  // 北の方向（画面上）= ワールドの (0, 1) を回したもの
  const nx = -Math.sin(h)
  const ny = -Math.cos(h)
  const nr = p.shape === 'circle' ? R * 0.84 : Math.min(r.w, r.h) * 0.42
  g.fillStyle = COLORS.brake
  g.font = `italic 700 ${(R * 0.16).toFixed(1)}px ${NUM}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('N', cx + nx * nr, cy + ny * nr)
  // 縮尺（local のとき）
  if (p.mode === 'local') {
    g.fillStyle = 'rgba(255,255,255,0.6)'
    g.font = `600 ${(R * 0.1).toFixed(1)}px ${NUM}`
    g.fillText(p.rangeM >= 1000 ? `${(p.rangeM / 1000).toFixed(1)} km` : `${p.rangeM} m`, cx, cy + R * 0.78)
  }
  g.restore()
}

// ---- 標高プロファイル ----

export interface ElevationProps {
  windowKm: number // 0 = ルート全体、それ以外は現在地を中心にこの幅
}

export const DEFAULT_ELEVATION: ElevationProps = { windowKm: 0 }

export function drawElevation(g: Ctx, r: Box, tel: Telemetry | null, t: number, props: Partial<ElevationProps>, lang: Lang = getLang()): void {
  const p = { ...DEFAULT_ELEVATION, ...props }
  const route = tel ? getRoute(tel) : null
  if (!tel || !route || !Number.isFinite(route.altMin)) return message(g, r, tr(lang, '標高データなし'))
  const curD = sampleChannel(tel, 'distance', t)
  const curA = sampleChannel(tel, 'alt', t)
  const grade = sampleChannel(tel, 'grade', t)
  let d0 = 0
  let d1 = Math.max(route.dMax, 0.1)
  if (p.windowKm > 0 && curD !== null) {
    d0 = curD - p.windowKm / 2
    d1 = curD + p.windowKm / 2
  }
  const pad = Math.min(r.w, r.h) * 0.08
  const head = r.h * 0.3 // 上部の数値の帯
  const gx = r.x + pad
  const gw = r.w - pad * 2
  const gy = r.y + head
  const gh = r.h - head - pad
  const aPad = Math.max(5, (route.altMax - route.altMin) * 0.12)
  const a0 = route.altMin - aPad
  const a1 = route.altMax + aPad
  const X = (d: number): number => gx + ((d - d0) / (d1 - d0)) * gw
  const Y = (a: number): number => gy + gh - ((a - a0) / (a1 - a0)) * gh
  g.save()
  g.beginPath()
  g.roundRect(r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.06)
  g.fillStyle = 'rgba(12, 14, 18, 0.6)'
  g.fill()
  g.beginPath()
  g.rect(gx, gy, gw, gh)
  g.clip()
  // 塗り（全体）と線（走った区間を明るく）
  const k1 = Math.min(route.n - 1, Math.floor(t * 5))
  const area = (from: number, to: number): Path2D => {
    const path = new Path2D()
    let started = false
    let firstX = 0
    let lastX = 0
    for (let k = from; k <= to; k++) {
      const a = route.alt[k]
      const d = route.d[k]
      if (Number.isNaN(a) || Number.isNaN(d) || d < d0 - 0.5 || d > d1 + 0.5) continue
      const sx = X(d)
      if (!started) {
        path.moveTo(sx, gy + gh)
        firstX = sx
        started = true
      }
      path.lineTo(sx, Y(a))
      lastX = sx
    }
    if (started) {
      path.lineTo(lastX, gy + gh)
      path.lineTo(firstX, gy + gh)
      path.closePath()
    }
    return path
  }
  g.fillStyle = 'rgba(255,255,255,0.14)'
  g.fill(area(0, route.n - 1))
  const grad = g.createLinearGradient(0, gy, 0, gy + gh)
  grad.addColorStop(0, 'rgba(54,180,255,0.75)')
  grad.addColorStop(1, 'rgba(54,180,255,0.12)')
  g.fillStyle = grad
  g.fill(area(0, k1))
  g.restore()
  // 現在地
  if (curD !== null && curA !== null) {
    const sx = X(curD)
    const sy = Y(curA)
    g.strokeStyle = 'rgba(255,255,255,0.5)'
    g.lineWidth = Math.max(1, r.h * 0.01)
    g.beginPath()
    g.moveTo(sx, gy)
    g.lineTo(sx, gy + gh)
    g.stroke()
    g.fillStyle = '#ffffff'
    g.shadowColor = '#ffffff'
    g.shadowBlur = r.h * 0.06
    g.beginPath()
    g.arc(sx, sy, Math.max(2, r.h * 0.035), 0, Math.PI * 2)
    g.fill()
    g.shadowBlur = 0
  }
  // 数値
  const fs = head * 0.62
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  g.fillStyle = '#ffffff'
  g.font = `italic 700 ${fs.toFixed(1)}px ${NUM}`
  const ty = r.y + head * 0.55
  const altText = curA !== null ? `${Math.round(curA)}` : '--'
  g.fillText(altText, r.x + pad, ty)
  const w1 = g.measureText(altText).width
  g.font = `600 ${(fs * 0.55).toFixed(1)}px ${NUM}`
  g.fillStyle = COLORS.sub
  g.fillText('m', r.x + pad + w1 + fs * 0.12, ty + fs * 0.12)
  if (grade !== null) {
    const up = grade >= 0
    g.textAlign = 'right'
    g.font = `italic 700 ${(fs * 0.8).toFixed(1)}px ${NUM}`
    g.fillStyle = Math.abs(grade) < 1 ? '#ffffff' : up ? COLORS.temp : COLORS.lean
    g.fillText(`${up ? '▲' : '▼'} ${Math.abs(grade).toFixed(1)}%`, r.x + r.w - pad, ty)
  }
  g.restore()
}

// ---- 方位帯 ----

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export function drawCompass(g: Ctx, r: Box, tel: Telemetry | null, t: number, props: { spanDeg?: number }, lang: Lang = getLang()): void {
  const head = tel ? sampleChannel(tel, 'heading', t) : null
  if (head === null) return message(g, r, tr(lang, '方位データなし'))
  const span = props.spanDeg ?? 120 // 帯に見える角度の幅
  const cx = r.x + r.w / 2
  const pxPerDeg = r.w / span
  g.save()
  // 両端を薄くしたパネル
  const grad = g.createLinearGradient(r.x, 0, r.x + r.w, 0)
  grad.addColorStop(0, 'rgba(12,14,18,0)')
  grad.addColorStop(0.15, 'rgba(12,14,18,0.6)')
  grad.addColorStop(0.85, 'rgba(12,14,18,0.6)')
  grad.addColorStop(1, 'rgba(12,14,18,0)')
  g.fillStyle = grad
  g.fillRect(r.x, r.y, r.w, r.h)
  g.beginPath()
  g.rect(r.x, r.y, r.w, r.h)
  g.clip()
  const base = r.y + r.h * 0.62
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  const first = Math.floor((head - span / 2) / 5) * 5
  for (let d = first; d <= head + span / 2 + 5; d += 5) {
    const sx = cx + (d - head) * pxPerDeg
    const dn = ((d % 360) + 360) % 360
    const major = dn % 45 === 0
    const mid = dn % 15 === 0
    const fade = 1 - Math.min(1, Math.abs(sx - cx) / (r.w / 2)) ** 2
    g.globalAlpha = 0.25 + 0.75 * fade
    g.strokeStyle = '#ffffff'
    g.lineWidth = Math.max(1, r.h * (major ? 0.05 : 0.025))
    g.beginPath()
    g.moveTo(sx, base)
    g.lineTo(sx, base - r.h * (major ? 0.22 : mid ? 0.14 : 0.08))
    g.stroke()
    if (major) {
      g.fillStyle = dn === 0 ? COLORS.brake : '#ffffff'
      g.font = `italic 700 ${(r.h * 0.34).toFixed(1)}px ${NUM}`
      g.fillText(DIRS[dn / 45], sx, base - r.h * 0.28)
    } else if (mid) {
      g.fillStyle = 'rgba(255,255,255,0.7)'
      g.font = `600 ${(r.h * 0.2).toFixed(1)}px ${NUM}`
      g.fillText(String(dn), sx, base - r.h * 0.2)
    }
  }
  g.globalAlpha = 1
  // 中央の印と数値
  g.fillStyle = COLORS.rpm
  g.beginPath()
  g.moveTo(cx, base + r.h * 0.02)
  g.lineTo(cx - r.h * 0.1, base + r.h * 0.16)
  g.lineTo(cx + r.h * 0.1, base + r.h * 0.16)
  g.closePath()
  g.fill()
  g.fillStyle = '#ffffff'
  g.font = `italic 700 ${(r.h * 0.24).toFixed(1)}px ${NUM}`
  g.textBaseline = 'top'
  const hn = Math.round(((head % 360) + 360) % 360)
  g.fillText(`${hn}° ${DIRS[Math.round(hn / 45) % 8]}`, cx, base + r.h * 0.17)
  g.restore()
}
