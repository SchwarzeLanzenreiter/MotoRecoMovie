import { useEffect, useRef, useState } from 'react'
import { layerName } from './layerName'
import { Player, type PlayerStatus } from '../engine/player'
import type { Keyframe, Project, Rect } from '../engine/project'
import type { Session } from '../engine/session'
import type { ViewPatch } from '../engine/edit'
import { dragRect, isFull, snapTargets, type Handle } from '../engine/layout'
import { t } from '../i18n'
import { useLang } from './useLang'

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const SNAP_PX = 8

/** 配置の目印（十字線・対角線）。表示の設定はこのパソコンに覚えておく */
interface Guides {
  cross: boolean
  diagonal: boolean
}
const GUIDES_KEY = 'reframe.guides'
function loadGuides(): Guides {
  try {
    const g = JSON.parse(localStorage.getItem(GUIDES_KEY) ?? '{}')
    return { cross: !!g.cross, diagonal: !!g.diagonal }
  } catch {
    return { cross: false, diagonal: false }
  }
}
function saveGuides(g: Guides): void {
  try {
    localStorage.setItem(GUIDES_KEY, JSON.stringify(g))
  } catch {
    /* 保存できなくても表示はできる */
  }
}

interface Props {
  session: Session
  project: Project
  status: PlayerStatus
  selected: string | null
  onSelect: (id: string) => void
  onUpdateRect: (id: string, rect: Rect) => void
  onPlayer: (p: Player | null) => void
  onStatus: (s: PlayerStatus) => void
  onError: (e: unknown) => void
  /** layerId を指定するとそのレイヤーを編集する（省略時は選択中の視点レイヤー） */
  onEditView: (patch: (cur: Omit<Keyframe, 't'>) => ViewPatch, layerId?: string) => void
}

export function Viewer({ session, project, status, selected, onSelect, onUpdateRect, onPlayer, onStatus, onError, onEditView }: Props): React.JSX.Element {
  useLang()
  const wrap = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const player = useRef<Player | null>(null)
  const projRef = useRef(project)
  projRef.current = project

  // プレイヤーの作成（セッションごと）
  useEffect(() => {
    const p = new Player(canvas.current!, session, projRef.current)
    p.onStatus = onStatus
    p.onError = onError
    player.current = p
    onPlayer(p)
    p.seek(0)
    return () => {
      p.dispose()
      onPlayer(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  useEffect(() => {
    player.current?.setProject(project)
  }, [project])

  // 書き出しの縦横比に合わせてキャンバスを配置する
  const aspect = project.export.width / project.export.height
  useEffect(() => {
    const el = wrap.current!
    const fit = (): void => {
      const st = stage.current
      if (!st) return // 外された後に呼ばれた場合
      const W = el.clientWidth
      const H = el.clientHeight
      let w = W
      let h = W / aspect
      if (h > H) {
        h = H
        w = H * aspect
      }
      st.style.width = `${Math.floor(w)}px`
      st.style.height = `${Math.floor(h)}px`
      player.current?.redraw()
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    return () => ro.disconnect()
  }, [aspect])

  /** レイヤーの移動・リサイズを始める（ポインターを離すまでウィンドウ全体で追う） */
  const startRectDrag = (id: string, handle: Handle, e: { clientX: number; clientY: number }): void => {
    const l = projRef.current.layers.find((x) => x.id === id)
    const st = stage.current
    if (!l || !st) return
    const r0 = { ...l.rect }
    const sx = e.clientX
    const sy = e.clientY
    const W = st.clientWidth
    const H = st.clientHeight
    const others = projRef.current.layers.filter((x) => x.visible && x.id !== id && !(x.type === 'view' && x.role)).map((x) => x.rect)
    const targets = snapTargets(others)
    const move = (ev: PointerEvent): void => {
      onUpdateRectRef.current(id, dragRect(r0, handle, (ev.clientX - sx) / W, (ev.clientY - sy) / H, targets, SNAP_PX / W, SNAP_PX / H))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onUpdateRectRef = useRef(onUpdateRect)
  onUpdateRectRef.current = onUpdateRect
  const startRectDragRef = useRef(startRectDrag)
  startRectDragRef.current = startRectDrag

  // クリックでレイヤーを選択、ドラッグで視点（Shift＋ドラッグ・重ね表示は移動）、ホイールで画角
  useEffect(() => {
    const c = canvas.current!
    let drag: { x: number; y: number; layer: string | null } | null = null
    /** 画面上の点にある一番手前の表示中レイヤー */
    const hit = (e: { clientX: number; clientY: number }): { id: string; type: string } | null => {
      const r = c.getBoundingClientRect()
      const u = (e.clientX - r.left) / r.width
      const v = (e.clientY - r.top) / r.height
      const ls = projRef.current.layers
      for (let k = ls.length - 1; k >= 0; k--) {
        const l = ls[k]
        if (l.visible && !(l.type === 'view' && l.role) && u >= l.rect.x && u <= l.rect.x + l.rect.w && v >= l.rect.y && v <= l.rect.y + l.rect.h) return { id: l.id, type: l.type }
      }
      return null
    }
    const down = (e: PointerEvent): void => {
      const h = hit(e)
      if (h) onSelect(h.id)
      // 重ね表示、または Shift を押しながらのドラッグはレイヤーの移動
      if (h && (h.type === 'overlay' || e.shiftKey)) {
        startRectDragRef.current(h.id, 'move', e)
        drag = null
        return
      }
      drag = { x: e.clientX, y: e.clientY, layer: h?.type === 'view' ? h.id : null }
      try {
        c.setPointerCapture(e.pointerId)
      } catch {
        /* 合成イベントなど */
      }
    }
    const move = (e: PointerEvent): void => {
      if (!drag || !drag.layer) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      drag.x = e.clientX
      drag.y = e.clientY
      const l = projRef.current.layers.find((x) => x.id === drag!.layer)
      const w = c.clientWidth * (l?.rect.w ?? 1) // そのレイヤーの表示幅
      onEditView((cur) => {
        const k = cur.fov / w // 1px あたりの角度（おおよそ）
        let yaw = cur.yaw - dx * k
        yaw = ((((yaw + 180) % 360) + 360) % 360) - 180
        const pitch = Math.max(-89, Math.min(89, cur.pitch - dy * k))
        return { yaw, pitch }
      }, drag.layer)
    }
    const up = (): void => {
      drag = null
    }
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      const h = hit(e)
      onEditView((cur) => ({ fov: Math.max(30, Math.min(180, cur.fov * Math.exp(e.deltaY * 0.001))) }), h?.type === 'view' ? h.id : undefined)
    }
    c.addEventListener('pointerdown', down)
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
    c.addEventListener('wheel', wheel, { passive: false })
    return () => {
      c.removeEventListener('pointerdown', down)
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
      c.removeEventListener('wheel', wheel)
    }
  }, [onEditView, onSelect])

  // ---- 配置の目印（プレビューだけに出す。書き出しには入らない）----
  const [guides, setGuides] = useState<Guides>(loadGuides)
  const toggleGuide = (k: keyof Guides): void =>
    setGuides((g) => {
      const next = { ...g, [k]: !g[k] }
      saveGuides(next)
      return next
    })
  // G キー: 目印をまとめて出す・消す
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'g' && e.key !== 'G') return
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const tg = e.target as HTMLElement | null
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable)) return
      setGuides((g) => {
        const on = !(g.cross || g.diagonal)
        const next = { cross: on, diagonal: on }
        saveGuides(next)
        return next
      })
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const sel = project.layers.find((l) => l.id === selected)
  // 全画面の視点が1つだけのときは枠を出さない（今まで通りの見た目）
  const showFrame = !!sel && (project.layers.length > 1 || !isFull(sel.rect))

  return (
    <div className="viewer" ref={wrap}>
      <div className="stage" ref={stage}>
        <canvas ref={canvas} />
        {(guides.cross || guides.diagonal) && (
          <svg className="guides" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {[0, 1].map((pass) => (
              // 1 回目は暗い太線（明るい映像の上でも見えるように）、2 回目は明るい細線
              <g key={pass} className={pass ? 'fg' : 'bg'}>
                {guides.cross && (
                  <>
                    <line x1="50" y1="0" x2="50" y2="100" />
                    <line x1="0" y1="50" x2="100" y2="50" />
                  </>
                )}
                {guides.diagonal && (
                  <>
                    <line x1="0" y1="0" x2="100" y2="100" />
                    <line x1="100" y1="0" x2="0" y2="100" />
                  </>
                )}
              </g>
            ))}
          </svg>
        )}
        {sel && showFrame && (
          <div
            className="sel-outline"
            style={{ left: `${sel.rect.x * 100}%`, top: `${sel.rect.y * 100}%`, width: `${sel.rect.w * 100}%`, height: `${sel.rect.h * 100}%` }}
          >
            {HANDLES.map((hd) => (
              <div
                key={hd}
                className={`handle h-${hd}`}
                data-handle={hd}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  startRectDrag(sel.id, hd, e)
                }}
              />
            ))}
            <div
              className="move-grip"
              data-handle="move"
              title={t('ドラッグで移動（Shift＋ドラッグでも移動できます）')}
              onPointerDown={(e) => {
                e.stopPropagation()
                startRectDrag(sel.id, 'move', e)
              }}
            >
              ⠿ {layerName(sel.name)}
            </div>
          </div>
        )}
      </div>
      <div className="guide-buttons">
        <button data-guide="cross" className={guides.cross ? 'on' : ''} onClick={() => toggleGuide('cross')} title={t('十字線（画面の中央の縦横の線）。G キーで目印をまとめて出し入れ')}>
          ┼ {t('十字線')}
        </button>
        <button data-guide="diagonal" className={guides.diagonal ? 'on' : ''} onClick={() => toggleGuide('diagonal')} title={t('対角線（画面の四隅を結ぶ線）。G キーで目印をまとめて出し入れ')}>
          ╳ {t('対角線')}
        </button>
      </div>
      {status.playing && <div className="hud">{status.fps.toFixed(0)} fps</div>}
    </div>
  )
}
