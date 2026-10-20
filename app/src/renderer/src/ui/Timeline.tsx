import { useEffect, useRef, useState } from 'react'
import type { Keyframe } from '../engine/project'
import { STATE_COLORS, STATE_NAMES, STATES, type RidingTrack } from '../core/riding'
import { t } from '../i18n'
import { useLang } from './useLang'
import { KEY_COLORS, KEY_TAG_NAMES, keyColor } from './keyColors'

interface Props {
  frameCount: number
  fps: number
  frame: number
  keyframes: Keyframe[]
  inSec: number
  outSec: number
  lean: { t: Float64Array; v: Float64Array } | null
  /** 車速 [km/h]（リーン角のグラフに重ねる） */
  speed: { t: Float64Array; v: Float64Array } | null
  riding: RidingTrack | null
  markers: { t: number }[]
  /** 車体挙動の乱れで 2 画面にする範囲 */
  incidents?: { start: number; end: number }[]
  onSeek: (frame: number) => void
  /** 時刻 [s] → いちばん近いコマ（実際のコマの時刻で。省略時は時刻 × fps を丸める） */
  frameOf?: (t: number) => number
}

const fmt = (s: number, step: number): string => {
  const m = Math.floor(s / 60)
  const ss = s - m * 60
  return step < 1 ? `${m}:${ss.toFixed(1).padStart(4, '0')}` : `${m}:${ss.toFixed(0).padStart(2, '0')}`
}

const PAD = 12 // 左右の余白 [px]
const BAND = 14 // 走行状態の帯の太さ [px]
const GRAPH_TOP = 44 // グラフの上端（目盛り・キーフレーム・乱れの帯の下）
const LEAN_COLOR = '#f5b84a'
const SPEED_COLOR = '#62d6e8'
/** 拡大の上限: 画面の幅で見せる最短の長さ [s] */
const MIN_SPAN = 2

/** 時刻 t0〜t1 の範囲の、列ごとの最小・最大（グラフを画素数ぶんに間引く） */
function columns(d: { t: Float64Array; v: Float64Array }, t0: number, t1: number, cols: number): { mn: Float32Array; mx: Float32Array } {
  const mn = new Float32Array(cols).fill(Infinity)
  const mx = new Float32Array(cols).fill(-Infinity)
  // 範囲の先頭を二分探索で探す
  let lo = 0
  let hi = d.t.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (d.t[m] < t0) lo = m + 1
    else hi = m
  }
  for (let i = Math.max(0, lo - 1); i < d.t.length && d.t[i] <= t1; i++) {
    const v = d.v[i]
    if (!Number.isFinite(v)) continue
    const c = Math.floor(((d.t[i] - t0) / (t1 - t0)) * cols)
    if (c < 0 || c >= cols) continue
    if (v < mn[c]) mn[c] = v
    if (v > mx[c]) mx[c] = v
  }
  return { mn, mx }
}

/** キーフレームを描く順（後ほど手前）: 手で置いたもの・前方の上に、コーナー入口・側方・後方、いちばん手前に追い越し */
const KEY_ORDER: (Keyframe['tag'] | undefined)[] = [undefined, 'front', 'corner', 'side', 'rear', 'overtake']

/**
 * 時間軸: 目盛り・リーン角と車速のグラフ・書き出し範囲・キーフレーム・再生位置・走行状態の帯。
 * ホイールで拡大縮小（マウスの位置を中心に）、Shift＋ホイール・横スクロール・下端のスクロールバーで左右に動かす
 */
export function Timeline({ frameCount, fps, frame, keyframes, inSec, outSec, lean, speed, riding, markers, incidents, onSeek, frameOf }: Props): React.JSX.Element {
  // 言語が変わったら描き直す（描画の effect は毎回の描画で走る）
  useLang()
  const ref = useRef<HTMLCanvasElement>(null)
  const dur = frameCount / fps
  // 見えている範囲 [s]
  const [view, setView] = useState<{ v0: number; v1: number }>({ v0: 0, v1: dur })
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  // 動画が変わったら全体を見せる
  useEffect(() => setView({ v0: 0, v1: dur }), [dur])
  const clampView = (v0: number, v1: number): { v0: number; v1: number } => {
    let span = Math.min(dur, Math.max(Math.min(MIN_SPAN, dur), v1 - v0))
    if (!(span > 0)) span = dur
    let a = Math.max(0, Math.min(dur - span, v0))
    if (!Number.isFinite(a)) a = 0
    return { v0: a, v1: a + span }
  }
  const zoomed = view.v1 - view.v0 < dur - 1e-6
  /** k 倍に拡大縮小する（k < 1 で拡大）。中心は at、無ければ再生位置（見えていれば）か表示の中央 */
  const zoomBy = (k: number, at?: number): void => {
    const { v0, v1 } = viewRef.current
    const now = tNowRef.current
    const c = at ?? (now >= v0 && now <= v1 ? now : (v0 + v1) / 2)
    const next = clampView(c - (c - v0) * k, c + (v1 - c) * k)
    viewRef.current = next // 続けて押したときに、描き直しを待たずに次の拡大へ使う
    setView(next)
  }

  // 再生位置が見えている範囲の外に出たら追いかける（拡大中のみ）
  const tNow = frame / fps
  const tNowRef = useRef(tNow)
  tNowRef.current = tNow
  useEffect(() => {
    const { v0, v1 } = viewRef.current
    if (v1 - v0 >= dur - 1e-6) return
    if (tNow < v0 || tNow > v1) {
      const span = v1 - v0
      setView(clampView(tNow - span * 0.1, tNow - span * 0.1 + span))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tNow, dur])

  // 時刻 → コマ（描き直すたびに作り直される関数なので、参照で持つ。依存に入れるとドラッグ中にマウスの扱いが作り直される）
  const frameOfRef = useRef(frameOf)
  frameOfRef.current = frameOf

  // キーフレームにマウスを乗せたときの説明（種類）
  const [tip, setTip] = useState<{ x: number; y: number; k: Keyframe } | null>(null)

  // 大きさが変わったら描き直す
  const [, setTick] = useState(0)
  useEffect(() => {
    const ro = new ResizeObserver(() => setTick((n) => n + 1))
    ro.observe(ref.current!)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    const W = c.clientWidth
    const H = c.clientHeight
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.fillStyle = '#1b1e24'
    g.fillRect(0, 0, W, H)
    const { v0, v1 } = view
    const span = v1 - v0
    const IW = W - 2 * PAD
    const x = (s: number): number => PAD + ((s - v0) / span) * IW
    // グラフの範囲（走行状態の帯の上）
    const gBottom = riding ? H - BAND - 4 : H - 4
    // 書き出し範囲
    const o = outSec < 0 ? dur : outSec
    g.fillStyle = 'rgba(79,156,249,0.12)'
    g.fillRect(x(inSec), 0, x(o) - x(inSec), H)
    // 目盛り
    g.fillStyle = '#9aa1ae'
    g.strokeStyle = '#343946'
    g.lineWidth = 1
    g.font = '11px Yu Gothic UI, sans-serif'
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]
    const step = steps.find((s) => (IW / span) * s > 70) ?? 600
    for (let s = Math.ceil(v0 / step - 1e-9) * step; s <= v1 + 1e-9; s += step) {
      g.beginPath()
      g.moveTo(x(s), 0)
      g.lineTo(x(s), 8)
      g.stroke()
      g.fillText(fmt(s, step), x(s) + 3, 11)
    }
    // リーン角（中央線 = 0°, 上下 ±45°）
    const mid = (GRAPH_TOP + gBottom) / 2
    const amp = (gBottom - GRAPH_TOP) / 2 / 45
    g.strokeStyle = '#343946'
    g.beginPath()
    g.moveTo(PAD, mid)
    g.lineTo(W - PAD, mid)
    g.stroke()
    const drawSeries = (d: { t: Float64Array; v: Float64Array }, color: string, yOf: (v: number) => number): void => {
      const cols = Math.max(1, Math.floor(IW))
      const { mn, mx } = columns(d, v0, v1, cols)
      g.strokeStyle = color
      g.lineWidth = 1
      g.beginPath()
      for (let k = 0; k < cols; k++) {
        if (!Number.isFinite(mn[k])) continue
        const px = PAD + k + 0.5
        g.moveTo(px, yOf(mx[k]))
        g.lineTo(px, yOf(mn[k]) + 0.5)
      }
      g.stroke()
    }
    // 車速（下端 = 0 km/h、上端 = その動画の最高速度）。リーン角より奥に描く
    const labels: [string, string][] = []
    if (speed && speed.v.length) {
      let vmax = 0
      for (const v of speed.v) if (Number.isFinite(v) && v > vmax) vmax = v
      const top = Math.max(40, Math.ceil(vmax / 20) * 20)
      drawSeries(speed, SPEED_COLOR, (v) => gBottom - (Math.max(0, v) / top) * (gBottom - GRAPH_TOP))
      g.fillStyle = SPEED_COLOR
      g.font = '10px Yu Gothic UI, sans-serif'
      g.fillText(`${top} km/h`, PAD + 2, GRAPH_TOP + 9)
      labels.push([t('車速'), SPEED_COLOR])
    }
    // キーフレームの色の凡例（グラフの左上。自動生成で付いた種類だけ）
    {
      const tags = KEY_ORDER.filter((tg): tg is NonNullable<typeof tg> => !!tg && keyframes.some((k) => k.tag === tg))
      g.font = '10px Yu Gothic UI, sans-serif'
      let lx = PAD + 2 + (speed && speed.v.length ? g.measureText('000 km/h').width + 14 : 0)
      for (const tg of tags) {
        g.fillStyle = KEY_COLORS[tg]
        g.beginPath()
        g.moveTo(lx + 4, GRAPH_TOP + 1)
        g.lineTo(lx + 8, GRAPH_TOP + 5)
        g.lineTo(lx + 4, GRAPH_TOP + 9)
        g.lineTo(lx, GRAPH_TOP + 5)
        g.closePath()
        g.fill()
        const name = t(KEY_TAG_NAMES[tg])
        g.fillText(name, lx + 11, GRAPH_TOP + 9)
        lx += 20 + g.measureText(name).width
      }
    }
    if (lean) {
      drawSeries(lean, LEAN_COLOR, (v) => mid - v * amp)
      labels.push([t('リーン角'), LEAN_COLOR])
    }
    // グラフの名前（右下）
    g.font = '11px Yu Gothic UI, sans-serif'
    let lxr = W - PAD - 4
    for (const [name, color] of labels.reverse()) {
      g.fillStyle = color
      const w = g.measureText(name).width
      g.fillText(name, lxr - w, gBottom - 4)
      lxr -= w + 12
    }
    // 走行状態の帯（下端）と凡例
    if (riding) {
      for (const sg of riding.segments) {
        if (sg.end < v0 || sg.start > v1) continue
        g.fillStyle = STATE_COLORS[sg.state]
        const a = Math.max(PAD, x(sg.start))
        g.fillRect(a, H - BAND, Math.max(1, Math.min(W - PAD, x(sg.end)) - a), BAND)
      }
      g.font = '10px Yu Gothic UI, sans-serif'
      let lx = PAD
      for (const st of STATES) {
        g.fillStyle = STATE_COLORS[st]
        g.fillRect(lx, gBottom - 12, 8, 8)
        g.fillStyle = '#9aa1ae'
        const name = t(STATE_NAMES[st])
        g.fillText(name, lx + 11, gBottom - 4)
        lx += 18 + g.measureText(name).width
      }
    }
    // キーフレーム: 自動生成のショットの種類で色分け（前方・コーナー入口・側方・後方・追い越し）。手で置いたものは青
    for (const k of KEY_ORDER.flatMap((tg) => keyframes.filter((k) => k.tag === tg))) {
      if (k.t < v0 - span * 0.02 || k.t > v1 + span * 0.02) continue
      const kx = x(k.t)
      g.fillStyle = keyColor(k.tag)
      g.beginPath()
      g.moveTo(kx, 16)
      g.lineTo(kx + 6, 22)
      g.lineTo(kx, 28)
      g.lineTo(kx - 6, 22)
      g.closePath()
      g.fill()
    }
    // 車体挙動の乱れで 2 画面にする範囲（赤）
    for (const c of incidents ?? []) {
      if (c.end < v0 || c.start > v1) continue
      g.fillStyle = '#ff4b4b'
      const a = x(c.start)
      g.fillRect(a, 37, Math.max(2, x(c.end) - a), 4)
    }
    // 注目ポイント（旗）
    for (const m of markers) {
      if (m.t < v0 || m.t > v1) continue
      const mx = x(m.t)
      g.strokeStyle = '#f5b84a'
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(mx, 14)
      g.lineTo(mx, H - BAND)
      g.stroke()
      g.fillStyle = '#f5b84a'
      g.beginPath()
      g.moveTo(mx, 14)
      g.lineTo(mx + 9, 18)
      g.lineTo(mx, 22)
      g.closePath()
      g.fill()
    }
    // 再生位置
    if (tNow >= v0 && tNow <= v1) {
      const px = x(tNow)
      g.strokeStyle = '#ffffff'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(px, 0)
      g.lineTo(px, H)
      g.stroke()
    }
  })

  // クリック・ドラッグでシーク、ホイールで拡大縮小・左右に移動
  useEffect(() => {
    const c = ref.current!
    let down = false
    const timeAt = (clientX: number): number => {
      const r = c.getBoundingClientRect()
      const { v0, v1 } = viewRef.current
      return v0 + ((clientX - r.left - PAD) / (r.width - 2 * PAD)) * (v1 - v0)
    }
    const seekAt = (e: PointerEvent): void => {
      const r = c.getBoundingClientRect()
      const { v0, v1 } = viewRef.current
      const s = Math.max(0, Math.min(dur, timeAt(e.clientX)))
      // キーフレームの近くをクリックしたらそこへ吸着する
      const near = [...keyframes, ...markers].find((k) => Math.abs(((k.t - s) / (v1 - v0)) * (r.width - 2 * PAD)) < 6)
      const ts = near ? near.t : s
      onSeek(frameOfRef.current ? frameOfRef.current(ts) : Math.round(ts * fps))
    }
    const pd = (e: PointerEvent): void => {
      down = true
      c.setPointerCapture(e.pointerId)
      seekAt(e)
    }
    const pm = (e: PointerEvent): void => {
      if (down) {
        seekAt(e)
        setTip(null)
        return
      }
      // キーフレームの段（◆の上下）にあれば、いちばん近いキーフレームの説明を出す
      const r = c.getBoundingClientRect()
      const y = e.clientY - r.top
      const { v0, v1 } = viewRef.current
      const IW = r.width - 2 * PAD
      let best: Keyframe | null = null
      let bd = 7
      if (y >= 12 && y <= 32)
        for (const k of keyframes) {
          const d = Math.abs(PAD + ((k.t - v0) / (v1 - v0)) * IW - (e.clientX - r.left))
          if (d < bd) {
            bd = d
            best = k
          }
        }
      // マウスカーソルの真上に出す
      setTip(best ? { x: e.clientX - r.left, y, k: best } : null)
    }
    const pl = (): void => setTip(null)
    const pu = (): void => {
      down = false
    }
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const { v0, v1 } = viewRef.current
      const span = v1 - v0
      const r = c.getBoundingClientRect()
      // 横スクロール（タッチパッド）・Shift＋ホイール: 左右に動かす
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
      if (dx) {
        const d = (dx / (r.width - 2 * PAD)) * span
        const next = clampView(v0 + d, v1 + d)
        viewRef.current = next
        setView(next)
        return
      }
      // ホイール: マウスの位置を中心に拡大縮小
      zoomBy(Math.exp(e.deltaY * 0.0015), timeAt(e.clientX))
    }
    c.addEventListener('pointerdown', pd)
    c.addEventListener('pointermove', pm)
    c.addEventListener('pointerup', pu)
    c.addEventListener('pointerleave', pl)
    c.addEventListener('wheel', wheel, { passive: false })
    return () => {
      c.removeEventListener('pointerdown', pd)
      c.removeEventListener('pointermove', pm)
      c.removeEventListener('pointerup', pu)
      c.removeEventListener('pointerleave', pl)
      c.removeEventListener('wheel', wheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dur, fps, keyframes, markers, onSeek])

  // ---- スクロールバー（下端）: つまみをドラッグして左右に動かす。つまみの外を押すとそこへ移り、そのままドラッグできる ----
  const barRef = useRef<HTMLDivElement>(null)
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const bar = barRef.current
    if (!bar || !zoomed) return
    e.preventDefault()
    const r = bar.getBoundingClientRect()
    const { v0, v1 } = viewRef.current
    const span = v1 - v0
    const at = ((e.clientX - r.left) / r.width) * dur
    // つまみの外を押したら、押した所がつまみの中央になるよう移る
    const onThumb = at >= v0 && at <= v1
    const start = onThumb ? v0 : at - span / 2
    const first = clampView(start, start + span)
    viewRef.current = first
    setView(first)
    const x0 = e.clientX
    const move = (ev: PointerEvent): void => {
      const d = ((ev.clientX - x0) / r.width) * dur
      const next = clampView(first.v0 + d, first.v0 + d + span)
      viewRef.current = next
      setView(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="track">
      <canvas ref={ref} />
      {tip && (
        <div className="tl-tip" data-tip="keyframe" style={{ left: Math.max(50, tip.x), top: tip.y - 10 }}>
          <span className="swatch" style={{ background: keyColor(tip.k.tag) }} />
          {tip.k.tag ? t(KEY_TAG_NAMES[tip.k.tag]) : t('手動・注目ポイント')}
        </div>
      )}
      <div ref={barRef} className={`tl-scroll${zoomed ? '' : ' full'}`} data-handle="tl-scroll" onPointerDown={onBarDown} title={zoomed ? t('ドラッグで左右に移動') : ''}>
        <div className="thumb" style={{ left: `${(view.v0 / dur) * 100}%`, width: `${((view.v1 - view.v0) / dur) * 100}%` }} />
      </div>
      <div className="tl-zoom">
        <button className="mini" data-action="tl-zoom-out" onClick={() => zoomBy(1.6)} title={t('縮小（ホイールでも拡大縮小。Shift＋ホイールで左右に移動）')}>
          −
        </button>
        <button className="mini" data-action="tl-zoom-in" onClick={() => zoomBy(1 / 1.6)} title={t('拡大（ホイールでも拡大縮小。Shift＋ホイールで左右に移動）')}>
          ＋
        </button>
        <button className="mini" data-action="tl-zoom-fit" onClick={() => setView({ v0: 0, v1: dur })} disabled={!zoomed} title={t('全体を表示')}>
          {t('全体')}
        </button>
      </div>
    </div>
  )
}
