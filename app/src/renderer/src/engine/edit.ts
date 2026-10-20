// プロジェクトの編集操作（キーフレームは視点レイヤーごと）
import { newId, newViewLayer, viewAt, type Keyframe, type Layer, type OverlayLayer, type Project, type Rect, type ViewLayer, type WidgetKind } from './project'

export type ViewPatch = Partial<Omit<Keyframe, 't'>>

/** 2つのキーフレームを同じとみなす時間差 [s]（1フレーム未満） */
const SAME = 0.01

/**
 * 時刻 t（いま表示しているコマの時刻）にあるキーフレームの番号（無ければ −1）。tol 以内でいちばん近いもの。
 * 画面で使うときは tol をコマの間隔の 0.6 倍にする（keyTolerance）。自動生成したキーフレームの時刻はコマの区切りに乗っていない
 * （例: 50fps で 32.55 秒 = 1627.5 コマ目）ので、0.01 秒だと、そのキーフレームのコマにいても見つからず、削除も編集もできなかった
 */
export function keyIndex(keys: Keyframe[], t: number, tol = SAME): number {
  let best = -1
  let bd = tol
  keys.forEach((k, i) => {
    const d = Math.abs(k.t - t)
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best
}

/** 画面の操作で「このコマのキーフレーム」とみなす時間差 [s]: コマの間隔の 0.6 倍（隣のコマのキーフレームとは重ならない） */
export function keyTolerance(fps: number): number {
  return 0.6 / fps
}

function mapView(p: Project, layerId: string, f: (l: ViewLayer) => ViewLayer): Project {
  return { ...p, layers: p.layers.map((l) => (l.id === layerId && l.type === 'view' ? f(l) : l)) }
}

/**
 * 視点レイヤーの視点を変更する。キーフレームが1つだけならそれ（=そのレイヤー全体の視点）を直接変え、
 * 2つ以上あるときは現在時刻のキーフレームを変更（無ければ補間値から作って追加）する。
 */
export function editView(p: Project, layerId: string, t: number, patch: ViewPatch | ((cur: Omit<Keyframe, 't'>) => ViewPatch), tol = SAME): Project {
  return mapView(p, layerId, (l) => {
    const keys = l.keyframes.map((k) => ({ ...k }))
    let idx = keys.length === 1 ? 0 : keyIndex(keys, t, tol)
    if (idx < 0) {
      keys.push({ t, ...viewAt(l.keyframes, t) })
      idx = keys.length - 1
    }
    const cur = keys[idx]
    const d = typeof patch === 'function' ? patch(cur) : patch
    keys[idx] = { ...cur, ...d, t: cur.t }
    keys.sort((a, b) => a.t - b.t)
    return { ...l, keyframes: keys }
  })
}

export function addKey(p: Project, layerId: string, t: number, tol = SAME): Project {
  return mapView(p, layerId, (l) => {
    if (keyIndex(l.keyframes, t, tol) >= 0) return l
    return { ...l, keyframes: [...l.keyframes, { t, ...viewAt(l.keyframes, t) }].sort((a, b) => a.t - b.t) }
  })
}

export function removeKey(p: Project, layerId: string, t: number, tol = SAME): Project {
  return mapView(p, layerId, (l) => {
    const i = keyIndex(l.keyframes, t, tol)
    if (i < 0 || l.keyframes.length <= 1) return l
    return { ...l, keyframes: l.keyframes.filter((_, k) => k !== i) }
  })
}

// ---- レイヤー ----

export function updateLayer(p: Project, id: string, patch: Partial<Layer>): Project {
  return { ...p, layers: p.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) }
}

export function addViewLayer(p: Project, name: string, rect: Rect, t: number, from?: ViewLayer): Project {
  const l = newViewLayer(name, rect, from ? viewAt(from.keyframes, t) : undefined)
  return { ...p, layers: [...p.layers, l] }
}

export function addOverlayLayer(p: Project, widget: WidgetKind, name: string, rect: Rect, props: Record<string, unknown> = {}): Project {
  const l: OverlayLayer = { id: newId(), type: 'overlay', name, rect: { ...rect }, visible: true, widget, props }
  return { ...p, layers: [...p.layers, l] }
}

export function removeLayer(p: Project, id: string): Project {
  // 視点レイヤーは最低1つ残す
  const target = p.layers.find((l) => l.id === id)
  if (!target) return p
  if (target.type === 'view' && p.layers.filter((l) => l.type === 'view').length <= 1) return p
  return { ...p, layers: p.layers.filter((l) => l.id !== id) }
}

/** 描画順を入れ替える（dir = +1 で手前へ） */
export function moveLayer(p: Project, id: string, dir: 1 | -1): Project {
  const i = p.layers.findIndex((l) => l.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= p.layers.length) return p
  const layers = [...p.layers]
  ;[layers[i], layers[j]] = [layers[j], layers[i]]
  return { ...p, layers }
}
