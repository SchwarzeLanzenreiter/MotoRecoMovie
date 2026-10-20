// 画面分割: レイアウトのテンプレートと、プレビュー上での移動・リサイズ（吸着つき）の計算。
import { t } from '../i18n'
import { newViewLayer, viewAt, type Keyframe, type Project, type Rect, type ViewLayer } from './project'

export interface LayoutTemplate {
  id: string
  name: string
  rects: Rect[]
}

/** テンプレート。座標は出力に対する割合なので、横長・縦長どちらの出力にも使える */
export const TEMPLATES: LayoutTemplate[] = [
  { id: 'full', name: '全画面', rects: [{ x: 0, y: 0, w: 1, h: 1 }] }, // i18n-ignore
  { id: 'pip', name: '小窓', rects: [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0.66, y: 0.04, w: 0.3, h: 0.3 }] }, // i18n-ignore
  {
    id: 'lr',
    name: '左右2分割', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 }
    ]
  },
  {
    id: 'tb',
    name: '上下2分割', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 }
    ]
  },
  {
    id: 'main2',
    name: '大1＋小2', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 2 / 3, h: 1 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 }
    ]
  },
  {
    id: 'tb3',
    name: '上下3分割', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 1, h: 1 / 3 },
      { x: 0, y: 1 / 3, w: 1, h: 1 / 3 },
      { x: 0, y: 2 / 3, w: 1, h: 1 / 3 }
    ]
  },
  {
    id: 'grid4',
    name: '4分割', // i18n-ignore
    rects: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
    ]
  }
]

/** テンプレートで視点を追加するときの初期の向き（2つ目以降: 後ろ・左・右） */
const SLOT_VIEWS: Partial<Omit<Keyframe, 't'>>[] = [{}, { yaw: 180, fov: 90 }, { yaw: -90, fov: 90 }, { yaw: 90, fov: 90 }]
const SLOT_NAMES = ['メイン', '後ろ', '左', '右'] // i18n-ignore

export const DEFAULT_BORDER = { width: 0.004, color: '#ffffff' }

/**
 * テンプレートを適用する。既存の視点レイヤーを順に割り当て、足りなければ追加し、
 * 余った視点はキーフレームを失わないよう非表示にする。重ね表示レイヤーはそのまま。
 */
export function applyTemplate(p: Project, templateId: string, time: number): Project {
  const tpl = TEMPLATES.find((x) => x.id === templateId)
  if (!tpl) return p
  const views = p.layers.filter((l): l is ViewLayer => l.type === 'view' && !l.role)
  const layers = [...p.layers]
  const split = tpl.rects.length > 1
  tpl.rects.forEach((rect, k) => {
    // 全画面を覆う画面には枠線を付けない（小窓や分割の画面にだけ付ける）
    const covers = rect.w >= 0.999 && rect.h >= 0.999
    const border = split && !covers ? { ...DEFAULT_BORDER } : undefined
    if (k < views.length) {
      const i = layers.findIndex((l) => l.id === views[k].id)
      layers[i] = { ...views[k], rect: { ...rect }, visible: true, border }
    } else {
      const base = views[0] ? viewAt(views[0].keyframes, time) : undefined
      const nl = newViewLayer(SLOT_NAMES[k] !== undefined ? t(SLOT_NAMES[k]) : t('視点 {n}', { n: k + 1 }), rect, base ? { ...base, ...SLOT_VIEWS[k] } : undefined)
      nl.border = border
      // 視点は重ね表示より奥に置く（最後の視点レイヤーの直後に挿入）
      const lastView = layers.reduce((acc, l, i) => (l.type === 'view' ? i : acc), -1)
      layers.splice(lastView + 1, 0, nl)
    }
  })
  for (const v of views.slice(tpl.rects.length)) {
    const i = layers.findIndex((l) => l.id === v.id)
    layers[i] = { ...v, visible: false }
  }
  return { ...p, layers }
}

// ---- 移動・リサイズ ----

/** ドラッグの種類: 移動、または辺・角（n/s/e/w の組み合わせ）でのリサイズ */
export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const MIN = 0.05 // 最小の幅・高さ（出力に対する割合）

/**
 * 吸着の候補: 画面の端・1/3・中央・2/3 と、他のレイヤーの辺。
 * tol は吸着する距離（割合）。x と y で別に指定する（縦横の画素数が違うため）。
 */
export function snapTargets(others: Rect[]): { xs: number[]; ys: number[] } {
  const base = [0, 1 / 3, 0.5, 2 / 3, 1]
  const xs = [...base]
  const ys = [...base]
  for (const r of others) {
    xs.push(r.x, r.x + r.w)
    ys.push(r.y, r.y + r.h)
  }
  return { xs, ys }
}

function snap1(v: number, cands: number[], tol: number): number {
  let best = v
  let d = tol
  for (const c of cands) {
    if (Math.abs(c - v) < d) {
      d = Math.abs(c - v)
      best = c
    }
  }
  return best
}

/**
 * 開始時の矩形 r0 を、ハンドル h でドラッグ量 (dx, dy)（割合）だけ動かした矩形を返す。
 * 移動は辺のどちらかが候補に近ければ吸着、リサイズは動かした辺だけ吸着する。
 */
export function dragRect(r0: Rect, h: Handle, dx: number, dy: number, targets: { xs: number[]; ys: number[] }, tolX: number, tolY: number): Rect {
  let { x, y, w, h: hh } = r0
  if (h === 'move') {
    x = r0.x + dx
    y = r0.y + dy
    // 左辺・右辺のうち近い方で吸着
    const sl = snap1(x, targets.xs, tolX)
    const sr = snap1(x + w, targets.xs, tolX)
    if (sl !== x && (sr === x + w || Math.abs(sl - x) <= Math.abs(sr - (x + w)))) x = sl
    else if (sr !== x + w) x = sr - w
    const st = snap1(y, targets.ys, tolY)
    const sb = snap1(y + hh, targets.ys, tolY)
    if (st !== y && (sb === y + hh || Math.abs(st - y) <= Math.abs(sb - (y + hh)))) y = st
    else if (sb !== y + hh) y = sb - hh
    x = Math.min(Math.max(x, -w + MIN), 1 - MIN)
    y = Math.min(Math.max(y, -hh + MIN), 1 - MIN)
    return { x, y, w, h: hh }
  }
  let left = r0.x
  let right = r0.x + r0.w
  let top = r0.y
  let bottom = r0.y + r0.h
  if (h.includes('w')) left = Math.min(snap1(r0.x + dx, targets.xs, tolX), right - MIN)
  if (h.includes('e')) right = Math.max(snap1(r0.x + r0.w + dx, targets.xs, tolX), left + MIN)
  if (h.includes('n')) top = Math.min(snap1(r0.y + dy, targets.ys, tolY), bottom - MIN)
  if (h.includes('s')) bottom = Math.max(snap1(r0.y + r0.h + dy, targets.ys, tolY), top + MIN)
  x = left
  y = top
  w = right - left
  hh = bottom - top
  return { x, y, w, h: hh }
}

export function isFull(r: Rect): boolean {
  return r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999
}
