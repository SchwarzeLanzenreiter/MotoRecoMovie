// 設定ファイル（*.motorecomovie-settings.json。前の名前のときは *.reframe-settings.json）: 右側の設定と、画面に置いたメーターなどの位置を、ほかの動画でも使えるように保存・読み込みする。
//
// 入れるもの（どの動画にも使えるもの）:
//   ・スタビライズの設定（継ぎ目の合わせ込みの推定値は動画ごとなので入れない）
//   ・レイヤー（描画順）: 位置・大きさ・表示・名前、視点レイヤーの枠線・標識・役割と向き（キーフレームが 1 つのものの視点）、
//     重ね表示のメーターの種類と設定
//   ・画角の自動切り替え・車体挙動の乱れ（事象ごとの「2 画面にしない」は動画ごとなので入れない）・書き出し（範囲は入れない）
// 入れないもの: キーフレームが 2 つ以上ある視点の動き、注目ポイント、追い越しの結果、車両ログ
import { mergeDirector, type DirectorSettings } from './director'
import { mergeIncident, type IncidentSettings } from './incident'
import { DEFAULT_AUDIO_FX, type AudioFx } from '../core/audiofx'
import { t } from '../i18n'
import { newId, newViewLayer, REMOVED_WIDGETS, viewAt, type Border, type ExportSettings, type Keyframe, type Layer, type OverlayLayer, type Project, type Rect, type StabSettings, type ViewLayer, type WidgetKind } from './project'

export const SETTINGS_EXT = '.motorecomovie-settings.json'
/** ファイルを作ったアプリ。前の名前（Insta360 Reframe）のときのファイルも読む */
const APP_ID = 'motorecomovie'
const LEGACY_APP_IDS = ['insta360-reframe']

type View = Omit<Keyframe, 't'>

interface ViewLayerSettings {
  type: 'view'
  name: string
  rect: Rect
  visible: boolean
  /** 向き（キーフレームが 1 つのレイヤーの視点。メインなど動きのあるレイヤーは、読み込む先のキーフレームを残す） */
  view: View
  /** 保存したときに向きが動いていた（キーフレームが 2 つ以上あった）か */
  animated: boolean
  border?: Border
  signs?: boolean
  signStyle?: 'real' | 'cyber'
  signAhead?: number
  role?: 'incident'
}

interface OverlayLayerSettings {
  type: 'overlay'
  name: string
  rect: Rect
  visible: boolean
  widget: WidgetKind
  props: Record<string, unknown>
}

export interface SettingsFile {
  app: string
  kind: 'settings'
  version: 1
  savedAt: string
  stab: Omit<StabSettings, 'seam'>
  layers: (ViewLayerSettings | OverlayLayerSettings)[]
  director: DirectorSettings
  incident: Omit<IncidentSettings, 'skip'>
  /** 走行中の音を整える（無いのは以前の版の設定ファイル） */
  audioFx?: AudioFx
  export: Omit<ExportSettings, 'inSec' | 'outSec'>
}

/** 今のプロジェクトから設定ファイルの中身を作る */
export function settingsFromProject(p: Project): SettingsFile {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seam: _seam, ...stab } = p.stab
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { skip: _skip, ...incident } = p.incident
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { inSec: _in, outSec: _out, ...ex } = p.export
  const layers = p.layers.map((l): ViewLayerSettings | OverlayLayerSettings =>
    l.type === 'view'
      ? {
          type: 'view',
          name: l.name,
          rect: { ...l.rect },
          visible: l.visible,
          view: viewAt(l.keyframes, 0),
          animated: l.keyframes.length > 1,
          ...(l.border && { border: { ...l.border } }),
          ...(l.signs !== undefined && { signs: l.signs }),
          ...(l.signStyle && { signStyle: l.signStyle }),
          ...(l.signAhead !== undefined && { signAhead: l.signAhead }),
          ...(l.role && { role: l.role })
        }
      : { type: 'overlay', name: l.name, rect: { ...l.rect }, visible: l.visible, widget: l.widget, props: structuredClone(l.props) }
  )
  return {
    app: APP_ID,
    kind: 'settings',
    version: 1,
    savedAt: new Date().toISOString(),
    stab,
    layers,
    director: structuredClone(p.director),
    incident,
    audioFx: { ...p.audioFx },
    export: ex
  }
}

/** ファイルの文字列を読む。設定ファイルでなければ例外 */
export function parseSettings(text: string): SettingsFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(t('設定ファイルではありません（JSON として読めません）'))
  }
  const s = raw as Partial<SettingsFile>
  if (!s || !(s.app === APP_ID || LEGACY_APP_IDS.includes(s.app ?? '')) || s.kind !== 'settings' || !Array.isArray(s.layers)) throw new Error(t('設定ファイルではありません'))
  if ((s.version ?? 1) > 1) throw new Error(t('新しい版のアプリで保存された設定ファイルです'))
  return s as SettingsFile
}

/**
 * 設定ファイルの中身をプロジェクトに当てる。
 * レイヤーはファイルの並びに置き換える。視点レイヤーは、読み込む先の同じレイヤー（自車の画面は役割で、ほかは名前で。
 * 見つからなければ先頭から順に）を引き継ぎ、向きが動いているもの（キーフレームが 2 つ以上）はキーフレームを残す
 * @param sameName 名前が同じか（既定の名前は言語が違っても同じとみなす比べ方を渡す）
 */
export function applySettings(p: Project, s: SettingsFile, sameName: (a: string, b: string) => boolean = (a, b) => a === b): Project {
  const oldViews = p.layers.filter((l): l is ViewLayer => l.type === 'view')
  const used = new Set<string>()
  const take = (pred: (l: ViewLayer) => boolean): ViewLayer | undefined => {
    const l = oldViews.find((x) => !used.has(x.id) && pred(x))
    if (l) used.add(l.id)
    return l
  }
  // 先に役割と名前で対応を決め、残りを順に当てる
  const match = new Map<number, ViewLayer | undefined>()
  s.layers.forEach((x, i) => {
    if (x.type !== 'view') return
    match.set(i, x.role ? take((l) => l.role === x.role) : take((l) => !l.role && sameName(l.name, x.name)))
  })
  s.layers.forEach((x, i) => {
    if (x.type === 'view' && !match.get(i) && !x.role) match.set(i, take((l) => !l.role))
  })
  const layers: Layer[] = s.layers.flatMap((x, i): Layer[] => {
    // 削除した重ね表示（メーター一式・速度計〜外気温）は入れない
    if (x.type === 'overlay' && REMOVED_WIDGETS.includes(x.widget as string)) return []
    if (x.type === 'overlay') {
      const o: OverlayLayer = { id: newId(), type: 'overlay', name: x.name, rect: { ...x.rect }, visible: x.visible, widget: x.widget, props: structuredClone(x.props ?? {}) }
      return [o]
    }
    const old = match.get(i)
    // 向きが動いている先のレイヤーはキーフレームを残す。そうでなければファイルの向きにする
    const keyframes = old && old.keyframes.length > 1 ? old.keyframes : [{ t: 0, ...x.view }]
    const base = old ?? newViewLayer(x.name)
    const v: ViewLayer = {
      id: base.id,
      type: 'view',
      name: x.name,
      rect: { ...x.rect },
      visible: x.visible,
      keyframes,
      ...(x.border && { border: { ...x.border } }),
      ...(x.signs !== undefined && { signs: x.signs }),
      ...(x.signStyle && { signStyle: x.signStyle }),
      ...(x.signAhead !== undefined && { signAhead: x.signAhead }),
      ...(x.role && { role: x.role })
    }
    return [v]
  })
  // 視点レイヤーが 1 つも無い設定ファイルなら、今の視点レイヤーを残す（映像が出なくならないように）
  const hasView = layers.some((l) => l.type === 'view')
  return {
    ...p,
    stab: { ...p.stab, ...s.stab, seam: p.stab.seam },
    layers: hasView ? layers : [...oldViews, ...layers],
    director: mergeDirector(s.director),
    incident: { ...mergeIncident(s.incident), skip: p.incident.skip },
    audioFx: s.audioFx ? { ...DEFAULT_AUDIO_FX, ...s.audioFx } : p.audioFx,
    export: { ...p.export, ...s.export, inSec: p.export.inSec, outSec: p.export.outSec }
  }
}
