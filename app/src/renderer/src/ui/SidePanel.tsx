import { useState } from 'react'
import { layerName } from './layerName'
import type { ExportProgress } from '../engine/exporter'
import { viewAt, type Keyframe, type Layer, type Project, type Rect, type ViewLayer, type WidgetKind } from '../engine/project'
import type { LogInfo } from '../engine/session'
import type { LogPrefs } from '../engine/logprefs'
import { OVERTAKE_SCAN_VERSION } from '../core/overtake'
import type { ViewPatch } from '../engine/edit'
import { WIDGET_NAMES, WIDGET_PROPS, type PropDef } from '../render/overlay'
import { DEFAULT_SIGN_AHEAD } from '../render/signs'
import { IncidentSection } from './IncidentPanel'
import type { IncidentEvent, IncidentSettings } from '../engine/incident'
import { Slider } from './Slider'
import { DEFAULT_BORDER, TEMPLATES } from '../engine/layout'
import { t, getLang } from '../i18n'
import type { DirectorSettings, Marker } from '../engine/director'

export const PRESETS: { label: string; w: number; h: number }[] = [
  { label: '1920×1080（16:9）', w: 1920, h: 1080 }, // i18n-ignore
  { label: '2560×1440（16:9）', w: 2560, h: 1440 }, // i18n-ignore
  { label: '3840×2160（4K 16:9）', w: 3840, h: 2160 }, // i18n-ignore
  { label: '1080×1920（縦 9:16）', w: 1080, h: 1920 }, // i18n-ignore
  { label: '1080×1350（4:5）', w: 1080, h: 1350 }, // i18n-ignore
  { label: '1080×1080（1:1）', w: 1080, h: 1080 } // i18n-ignore
]

interface Props {
  project: Project
  time: number
  selLayer: Layer | null
  selView: ViewLayer
  hasKeyHere: boolean
  log: LogInfo | null
  exporting: ExportProgress | null
  onChange: (p: Project) => void
  onEditView: (patch: ViewPatch) => void
  onAddKey: () => void
  onRemoveKey: () => void
  onSelectLayer: (id: string) => void
  onAddView: () => void
  onAddOverlay: (w: WidgetKind) => void
  onRemoveLayer: (id: string) => void
  onMoveLayer: (id: string, dir: 1 | -1) => void
  onUpdateLayer: (id: string, patch: Partial<Layer>) => void
  onApplyTemplate: (id: string) => void
  hasRiding: boolean
  /** 走行状態・コーナーが、車両ログではなく動画の IMU から推定したものか */
  ridingFromImu: boolean
  /** リーン角が分かるか（車両ログ、または動画の IMU からの推定） */
  leanAvailable: boolean
  onAddMarker: () => void
  onUpdateMarker: (id: string, patch: Partial<Marker>) => void
  onRemoveMarker: (id: string) => void
  onSeekTime: (t: number) => void
  onUpdateDirector: (d: DirectorSettings) => void
  /** 設定メニューの「自動生成の視点」（前方・コーナー入口・側方・後方の既定値）を開く */
  onOpenShotViews: () => void
  onGenerate: (range: 'export' | 'all') => void
  incidentEvents: IncidentEvent[]
  incidentAvailable: boolean
  mainFull: boolean
  onUpdateIncident: (patch: Partial<IncidentSettings>) => void
  onEstimateSeam: () => void
  seamBusy: boolean
  /** 自車の継ぎ目の型を作っている途中の進み具合（作っていなければ null） */
  bodyStatus: { busy: boolean; frac: number; msg: string } | null
  bodyReady: boolean
  onRebuildBody: () => void
  /** 走行中の音を整えている途中の進み具合（作っていなければ null） */
  audioStatus: { busy: boolean; frac: number; msg: string } | null
  audioReady: boolean
  onLoadLog: () => void
  /** 設定ファイル（右側の設定とメーターなどの位置）の保存・読み込み */
  onSaveSettings: () => void
  onLoadSettings: () => void
  logPrefs: LogPrefs
  onChangeDdf: () => void
  /** .dat のフォルダから映像に合うものを探す（true ならフォルダを選び直す） */
  onFindDat: (pickFolder: boolean) => void
  onExport: () => void
  onCancelExport: () => void
  onSetIn: () => void
  onSetOut: () => void
}

const fmtTime = (s: number): string => {
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

function LayoutSection(p: Props): React.JSX.Element {
  const aspect = p.project.export.width / p.project.export.height
  // 縮小図は出力の縦横比に合わせる（横長なら横長、縦長なら縦長）
  const W = aspect >= 1 ? 40 : Math.round(40 * aspect)
  const H = aspect >= 1 ? Math.round(40 / aspect) : 40
  return (
    <div className="section">
      <h3>
        {t('画面レイアウト')}<span className="hint">{t('視点の数と配置をまとめて決める')}</span>
      </h3>
      <div className="templates">
        {TEMPLATES.map((tp) => (
          <button key={tp.id} className="tpl" title={t(tp.name)} onClick={() => p.onApplyTemplate(tp.id)}>
            <span className="tpl-icon" style={{ width: W, height: H }}>
              {tp.rects.map((r, i) => (
                <span key={i} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
              ))}
            </span>
            <span className="tpl-name">{t(tp.name)}</span>
          </button>
        ))}
      </div>
      <div className="note">{t('余った視点は削除せず非表示にします（キーフレームは残ります）。')}</div>
    </div>
  )
}

/** 重ね表示の種類を選んで追加する */
function AddOverlay({ onAdd }: { onAdd: (w: WidgetKind) => void }): React.JSX.Element {
  const [kind, setKind] = useState<WidgetKind>('chrono')
  return (
    <>
      <select value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)} style={{ flex: 1, minWidth: 0 }}>
        {(Object.keys(WIDGET_NAMES) as WidgetKind[]).map((w) => (
          <option key={w} value={w}>
            {t(WIDGET_NAMES[w])}
          </option>
        ))}
      </select>
      <button onClick={() => onAdd(kind)}>{t('＋ 追加')}</button>
    </>
  )
}

function DirectorSection(p: Props): React.JSX.Element {
  const d = p.project.director
  const set = <K extends keyof DirectorSettings>(k: K, v: Partial<DirectorSettings[K]>): void =>
    p.onUpdateDirector({ ...d, [k]: typeof v === 'object' ? { ...(d[k] as object), ...v } : v })
  const [range, setRange] = useState<'export' | 'all'>('export')
  const Rule = ({ k, label }: { k: 'corner' | 'brake' | 'accel' | 'cruise' | 'stop'; label: string }): React.JSX.Element => (
    <label className="rule">
      <input type="checkbox" checked={d[k].on} disabled={!p.hasRiding} onChange={(e) => set(k, { on: e.target.checked })} /> {label}
    </label>
  )
  return (
    <div className="section">
      <h3>
        {t('画角の自動切り替え')}<span className="hint">{t('{name} のキーフレームを作る', { name: layerName(p.selView.name) })}</span>
      </h3>
      {!p.hasRiding && <div className="note status">{t('走行状態による切り替えは車両ログが必要です（注目ポイントだけでも生成できます）。')}</div>}
      {p.ridingFromImu && <div className="note status">{t('車両ログが無いので、動画の動き（ジャイロと加速度）から推定した走行状態を使います。ログがあるときより精度は落ちます。')}</div>}
      <div className="rules">
        <Rule k="corner" label={t('コーナー進入の演出')} />
        <Rule k="brake" label={t('減速で前方の下へ寄る')} />
        <Rule k="accel" label={t('加速で前方をズーム')} />
        <Rule k="cruise" label={t('長い巡航で左右の景色')} />
        <Rule k="stop" label={t('停止で広角の景色')} />
      </div>
      <div className="note">{t('コーナー: ①内側を少し向く（通常）。長いコーナーの何本かごとに ②自分を映す（水平固定・広角）、③真横・内側、④真横・外側（入口と通過後を1画面に）を順に挟みます。')}</div>
      <div className="row">
        <button data-action="open-shot-views" onClick={p.onOpenShotViews}>
          {t('視点の既定値（前方・コーナー入口・側方・後方）…')}
        </button>
      </div>
      <div className="rules">
        <label className="rule">
          <input type="checkbox" checked={d.corner.special.rider} disabled={!p.hasRiding || !d.corner.on} onChange={(e) => set('corner', { special: { ...d.corner.special, rider: e.target.checked } })} /> {t('②自分を映す')}
        </label>
        <label className="rule">
          <input type="checkbox" checked={d.corner.special.side} disabled={!p.hasRiding || !d.corner.on} onChange={(e) => set('corner', { special: { ...d.corner.special, side: e.target.checked } })} /> {t('③真横（内側）')}
        </label>
        <label className="rule">
          <input type="checkbox" checked={d.corner.special.sideOut} disabled={!p.hasRiding || !d.corner.on} onChange={(e) => set('corner', { special: { ...d.corner.special, sideOut: e.target.checked } })} /> {t('④真横（外側）')}
        </label>
      </div>
      <Slider name={t('②〜④の間隔')} value={d.corner.special.every} min={1} max={8} step={1} unit={t('本')} disabled={!d.corner.on} onChange={(x) => set('corner', { special: { ...d.corner.special, every: x } })} />
      <Slider name={t('②〜④の対象')} value={d.corner.special.minDur} min={1} max={8} step={0.5} unit="s" disabled={!d.corner.on} onChange={(x) => set('corner', { special: { ...d.corner.special, minDur: x } })} />
      <Slider name={t('ズームの量')} value={-d.accel.fovDelta} min={0} max={40} step={1} unit="°" disabled={!d.accel.on} onChange={(x) => set('accel', { fovDelta: -x })} />
      <Slider name={t('景色の間隔')} value={d.cruise.interval} min={8} max={60} step={1} unit="s" disabled={!d.cruise.on} onChange={(x) => set('cruise', { interval: x })} />
      <div className="rules">
        <label className="rule">
          <input type="checkbox" data-action="overtake" checked={d.overtake.on} onChange={(e) => set('overtake', { on: e.target.checked })} /> {t('追い越しの間は路面を映さない')}
        </label>
      </div>
      <div className="note">
        {t('センターラインをまたいで車を追い越す間、路面が映らないよう上（空と景色）を向きます。追い越しの場面は、映像のセンターライン・路面と車の検出から見つけます（初回は動画を調べるので 1 分ほどかかります）。')}
      </div>
      {p.project.overtakes && p.project.overtakesVersion === OVERTAKE_SCAN_VERSION && (
        <div className="note status">
          {t('見つかった追い越し: {n} か所', { n: p.project.overtakes.length })}{' '}
          <button className="mini" onClick={() => p.onChange({ ...p.project, overtakes: undefined })} title={t('次の自動生成のときに動画を調べ直します')}>
            {t('調べ直す')}
          </button>
        </div>
      )}
      <Slider name={t('追い越しの上向き')} value={d.overtake.pitch} min={0} max={70} step={1} unit="°" disabled={!d.overtake.on} onChange={(x) => set('overtake', { pitch: x })} />
      <Slider name={t('追い越しの画角')} value={d.overtake.fov} min={50} max={130} step={1} unit="°" disabled={!d.overtake.on} onChange={(x) => set('overtake', { fov: x })} />
      <Slider name={t('切り替える車速')} value={d.overtake.minSpeed} min={0} max={100} step={5} unit="km/h" disabled={!d.overtake.on} onChange={(x) => set('overtake', { minSpeed: x })} />
      <div className="note">{t('この車速より遅い追い越し（追い越す間の平均）では、画角を切り替えません。0 にすると、いつも切り替えます。車速は車両ログ（無いときは動画の動きからの推定）から求めます。')}</div>
      <Slider name={t('切り替え時間')} value={d.transition} min={0.1} max={2} step={0.1} unit="s" onChange={(x) => p.onUpdateDirector({ ...d, transition: x })} />
      <Slider name={t('最短ショット')} value={d.minShot} min={0.5} max={5} step={0.1} unit="s" onChange={(x) => p.onUpdateDirector({ ...d, minShot: x })} />
      <div className="row">
        <select value={range} onChange={(e) => setRange(e.target.value as 'export' | 'all')}>
          <option value="export">{t('書き出し範囲')}</option>
          <option value="all">{t('動画全体')}</option>
        </select>
        <button className="primary" onClick={() => p.onGenerate(range)}>
          {t('キーフレームを自動生成')}
        </button>
      </div>
      <div className="note">{t('範囲内のキーフレームは置き換わります（Ctrl+Z で元に戻せます）。視点は設定メニューの「自動生成の視点」の既定値を使います。')}</div>
    </div>
  )
}

const DIRS: { label: string; yaw: number; pitch: number }[] = [
  { label: '左', yaw: -90, pitch: 0 }, // i18n-ignore
  { label: '右', yaw: 90, pitch: 0 }, // i18n-ignore
  { label: '後ろ', yaw: 180, pitch: 0 }, // i18n-ignore
  { label: '空', yaw: 0, pitch: -45 } // i18n-ignore
]

function MarkersSection(p: Props): React.JSX.Element {
  const ms = [...p.project.markers].sort((a, b) => a.t - b.t)
  return (
    <div className="section">
      <h3>
        {t('注目ポイント')}<span className="hint">{t('{n} 個', { n: ms.length })}</span>
      </h3>
      <div className="row">
        <button onClick={p.onAddMarker}>{t('◎ 現在位置に追加（B）')}</button>
      </div>
      {ms.map((m) => (
        <div key={m.id} className="marker-row">
          <button className="time-btn" onClick={() => p.onSeekTime(m.t)} title={t('この時刻へ移動')}>
            {fmtTime(m.t)}
          </button>
          {DIRS.map((d) => (
            <button key={d.label} className={'dir' + (m.yaw === d.yaw && m.pitch === d.pitch ? ' on' : '')} onClick={() => p.onUpdateMarker(m.id, { yaw: d.yaw, pitch: d.pitch })}>
              {t(d.label)}
            </button>
          ))}
          <input type="number" title={t('ヨー（°）')} value={Math.round(m.yaw)} step={5} onChange={(e) => p.onUpdateMarker(m.id, { yaw: parseFloat(e.target.value) || 0 })} style={{ width: 48 }} />
          <input type="number" title={t('見せる長さ（秒）')} value={m.hold} step={0.5} min={1} onChange={(e) => p.onUpdateMarker(m.id, { hold: Math.max(1, parseFloat(e.target.value) || 1) })} style={{ width: 44 }} />
          <button title={t('削除')} onClick={() => p.onRemoveMarker(m.id)}>
            ×
          </button>
        </div>
      ))}
      {ms.length > 0 && <div className="note">{t('数値は 向き（ヨー°）と 見せる長さ（秒）。自動生成でこの時刻にこの向きを見せます。')}</div>}
    </div>
  )
}

function LayersSection(p: Props): React.JSX.Element {
  const { project, selLayer } = p
  const views = project.layers.filter((l) => l.type === 'view').length
  const rect = selLayer?.rect
  const setRect = (k: keyof Rect, pct: number): void => {
    if (!selLayer || !rect || !Number.isFinite(pct)) return
    p.onUpdateLayer(selLayer.id, { rect: { ...rect, [k]: Math.max(0, Math.min(1, pct / 100)) } })
  }
  return (
    <div className="section">
      <h3>
        {t('レイヤー')}<span className="hint">{t('上ほど手前に表示')}</span>
      </h3>
      <div className="layers">
        {[...project.layers].reverse().map((l) => (
          <div key={l.id} className={'layer-row' + (l.id === selLayer?.id ? ' sel' : '')} onClick={() => p.onSelectLayer(l.id)}>
            <input type="checkbox" checked={l.visible} onClick={(e) => e.stopPropagation()} onChange={(e) => p.onUpdateLayer(l.id, { visible: e.target.checked })} />
            <span className="lname">{layerName(l.name)}</span>
            <span className="kind">{l.type === 'view' ? t('視点') : t('重ね表示')}</span>
            <button title={t('手前へ')} onClick={(e) => (e.stopPropagation(), p.onMoveLayer(l.id, 1))}>▲</button>
            <button title={t('奥へ')} onClick={(e) => (e.stopPropagation(), p.onMoveLayer(l.id, -1))}>▼</button>
            <button title={t('削除')} disabled={l.type === 'view' && views <= 1} onClick={(e) => (e.stopPropagation(), p.onRemoveLayer(l.id))}>×</button>
          </div>
        ))}
      </div>
      <div className="row">
        <button onClick={p.onAddView}>{t('＋ 視点')}</button>
        <AddOverlay onAdd={p.onAddOverlay} />
      </div>
      {selLayer && rect && (
        <>
          <div className="row">
            <label className="name">{t('名前')}</label>
            <input type="text" value={layerName(selLayer.name)} onChange={(e) => p.onUpdateLayer(selLayer.id, { name: e.target.value })} style={{ flex: 1 }} />
          </div>
          <div className="rect-edit">
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <div key={k}>
                <label>{{ x: t('左 %'), y: t('上 %'), w: t('幅 %'), h: t('高さ %') }[k]}</label>
                <input type="number" step={1} value={Math.round(rect[k] * 1000) / 10} onChange={(e) => setRect(k, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>
          {selLayer.type === 'view' && (
            <div className="row">
              <label className="name">{t('枠線')}</label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={(selLayer.border?.width ?? 0) * 100}
                onChange={(e) => p.onUpdateLayer(selLayer.id, { border: { color: selLayer.border?.color ?? DEFAULT_BORDER.color, width: parseFloat(e.target.value) / 100 } })}
              />
              <span className="unit" style={{ width: 36 }}>{((selLayer.border?.width ?? 0) * 100).toFixed(1)}%</span>
              <input
                type="color"
                value={selLayer.border?.color ?? DEFAULT_BORDER.color}
                onChange={(e) => p.onUpdateLayer(selLayer.id, { border: { width: selLayer.border?.width || DEFAULT_BORDER.width, color: e.target.value } })}
              />
            </div>
          )}
          {selLayer.type === 'view' && (
            <div className="row">
              <label>
                <input type="checkbox" checked={!!selLayer.signs} disabled={!p.hasRiding} onChange={(e) => p.onUpdateLayer(selLayer.id, { signs: e.target.checked })} /> {t('コーナーの標識（曲線半径を空中に表示）')}
              </label>
              <select value={selLayer.signStyle ?? 'real'} disabled={!selLayer.signs} onChange={(e) => p.onUpdateLayer(selLayer.id, { signStyle: e.target.value as 'real' | 'cyber' })}>
                <option value="real">{t('道路標識風')}</option>
                <option value="cyber">{t('AR 風')}</option>
              </select>
            </div>
          )}
          {selLayer.type === 'view' && selLayer.signs && (
            <Slider
              name={t('標識の位置')}
              value={selLayer.signAhead ?? DEFAULT_SIGN_AHEAD}
              min={-100}
              max={50}
              step={5}
              unit="m"
              onChange={(x) => p.onUpdateLayer(selLayer.id, { signAhead: x })}
            />
          )}
          {selLayer.type === 'view' && selLayer.signs && p.ridingFromImu && (
            <div className="note status">{t('車両ログが無いので、曲線半径と標識の位置は動画の動きから推定したものです（車速が分からないので誤差があります。GPS の標高が無いので、峠の頂上の向こうを隠す判定はしません）。')}</div>
          )}
          {selLayer.type === 'view' && selLayer.signs && <div className="note">{t('コーナーの入口から経路に沿った距離（マイナス = 入口の手前、プラス = コーナーの奥）。')}</div>}
          {selLayer.type === 'overlay' &&
            (WIDGET_PROPS[selLayer.widget] ?? []).map((d: PropDef) => {
              const cur = selLayer.props[d.key] ?? d.default
              const set = (v: string | number): void => p.onUpdateLayer(selLayer.id, { props: { ...selLayer.props, [d.key]: v } })
              return d.type === 'select' ? (
                <div className="row" key={d.key}>
                  <label className="name">{t(d.label)}</label>
                  <select value={String(cur)} onChange={(e) => set(e.target.value)} style={{ flex: 1 }}>
                    {d.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(o.label)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <Slider key={d.key} name={t(d.label)} value={Number(cur)} min={d.min} max={d.max} step={d.step} unit={d.unit && t(d.unit)} onChange={set} />
              )
            })}
          <div className="note">
            {selLayer.type === 'view' ? t('プレビュー上: 枠のハンドルでリサイズ、上部のつまみか Shift＋ドラッグで移動。') : t('プレビュー上: ドラッグで移動、枠のハンドルでリサイズ。')}
          </div>
        </>
      )}
    </div>
  )
}

export function SidePanel(p: Props): React.JSX.Element {
  const { project, time, log, selView } = p
  const v: Omit<Keyframe, 't'> = viewAt(selView.keyframes, time)
  const st = project.stab
  const setStab = (patch: Partial<typeof st>): void => p.onChange({ ...project, stab: { ...st, ...patch } })
  const setSigma = (i: number, val: number): void => {
    const s = [...st.sigma] as [number, number, number]
    s[i] = val
    setStab({ sigma: s })
  }
  const ex = project.export
  const setEx = (patch: Partial<typeof ex>): void => p.onChange({ ...project, export: { ...ex, ...patch } })
  const logOn = !!log && project.logEnabled
  const preset = PRESETS.findIndex((q) => q.w === ex.width && q.h === ex.height)

  return (
    <div className="side">
      <div className="section">
        <h3>{t('設定ファイル')}</h3>
        <div className="row">
          <button data-action="save-settings" onClick={p.onSaveSettings}>
            {t('設定を保存…')}
          </button>
          <button data-action="load-settings" onClick={p.onLoadSettings}>
            {t('設定を読み込む…')}
          </button>
        </div>
        <div className="note">
          {t('右側の設定と、画面に置いたメーターなどの位置・大きさを 1 つのファイルにまとめ、ほかの動画でも使えます。メイン画面の向きの動き（キーフレーム）・注目ポイント・書き出し範囲・継ぎ目の推定値は動画ごとなので入りません。')}
        </div>
      </div>
      <LayoutSection {...p} />
      <LayersSection {...p} />
      <div className="section">
        <h3>
          {t('視点（{name}）', { name: layerName(selView.name) })}
          <span className="hint">{selView.keyframes.length === 1 ? t('全体に適用') : p.hasKeyHere ? t('この時刻のキーフレーム') : t('変更するとキーフレームを追加')}</span>
        </h3>
        <Slider name={t('ヨー')} value={v.yaw} min={-180} max={180} step={1} unit="°" onChange={(x) => p.onEditView({ yaw: x })} />
        <Slider name={t('ピッチ')} value={v.pitch} min={-89} max={89} step={1} unit="°" onChange={(x) => p.onEditView({ pitch: x })} />
        <Slider name={t('画角')} value={v.fov} min={30} max={180} step={1} unit="°" onChange={(x) => p.onEditView({ fov: x })} />
        <Slider name={t('傾きを残す')} value={v.leanRatio * 100} min={0} max={100} step={5} unit="%" disabled={!p.leanAvailable} onChange={(x) => p.onEditView({ leanRatio: x / 100 })} />
        {!p.leanAvailable && <div className="note status">{t('「傾きを残す」は車両ログ（MotoReco）を読み込むと使えます。')}</div>}
        {p.leanAvailable && !logOn && <div className="note status">{t('車両ログが無いので、リーン角は動画の動きから推定したものです。')}</div>}
        <div className="row">
          <button onClick={p.onAddKey} disabled={p.hasKeyHere}>{t('◆ キーフレーム追加')}</button>
          <button onClick={p.onRemoveKey} disabled={!p.hasKeyHere || selView.keyframes.length <= 1}>{t('削除')}</button>
          <span className="note">{t('{n} 個', { n: selView.keyframes.length })}</span>
        </div>
        <div className="note">{t('映像をドラッグで向き、ホイールで画角を変えられます。')}</div>
      </div>

      <DirectorSection {...p} />
      <MarkersSection {...p} />
      <IncidentSection
        settings={p.project.incident}
        events={p.incidentEvents}
        available={p.incidentAvailable}
        mainFull={p.mainFull}
        onChange={p.onUpdateIncident}
        onSeekTime={p.onSeekTime}
      />


      <div className="section">
        <h3>
          <input type="checkbox" checked={st.enabled} onChange={(e) => setStab({ enabled: e.target.checked })} />
          {t('スタビライズ')}
          <span className="hint">{t('ホライズンロックなし')}</span>
        </h3>
        <Slider name={t('ピッチ')} value={st.sigma[0]} min={0.05} max={1.5} step={0.05} unit="s" disabled={!st.enabled} onChange={(x) => setSigma(0, x)} />
        <Slider name={t('ヨー')} value={st.sigma[1]} min={0.05} max={1.5} step={0.05} unit="s" disabled={!st.enabled} onChange={(x) => setSigma(1, x)} />
        <Slider name={t('ロール')} value={st.sigma[2]} min={0.05} max={1.5} step={0.05} unit="s" disabled={!st.enabled} onChange={(x) => setSigma(2, x)} />
        <div className="note">{t('大きいほど滑らか。ロールを大きくするとリーンへの追従がなまります（ログがあれば補完されます）。')}</div>
        <div className="row">
          <label>
            <input type="checkbox" checked={st.rollingShutter} onChange={(e) => setStab({ rollingShutter: e.target.checked })} /> {t('ローリングシャッター補正')}
          </label>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={st.rollComp} disabled={!logOn || !st.enabled} onChange={(e) => setStab({ rollComp: e.target.checked })} /> {t('ログでロールのなまりを補完')}
          </label>
        </div>
        <div className="row">
          <label title={t('前後のレンズの映像が重なる帯で、両方の映像が一致するようにレンズ1の向きを補正します（横を向いたときの継ぎ目のずれ）')}>
            <input type="checkbox" checked={st.seamFix !== false && !!st.seam} disabled={!st.seam} onChange={(e) => setStab({ seamFix: e.target.checked })} /> {t('レンズの継ぎ目を合わせる')}
            {st.seam && <span className="hint">{t('（縁 {edge}°・回転 {rot}°）', { edge: st.seam.edge.toFixed(1), rot: Math.hypot(...st.seam.rot).toFixed(1) })}</span>}
          </label>
          <button onClick={p.onEstimateSeam} disabled={p.seamBusy} title={t('動画の何か所かのフレームから推定し直す')}>
            {p.seamBusy ? t('推定中…') : t('推定し直す')}
          </button>
        </div>
        <div className="row">
          <label title={t('継ぎ目の付近の景色までの距離をフレームごとに求め、前後のレンズの位置の差（約 3.3cm）による視差を補正します。路面・車体・ライダーなど近い物の継ぎ目が合います')}>
            <input type="checkbox" checked={st.dynamicSeam !== false} onChange={(e) => setStab({ dynamicSeam: e.target.checked })} /> {t('近い物の継ぎ目も合わせる（動的なつなぎ合わせ）')}
          </label>
        </div>
        <Slider name={t('継ぎ目のぼかし幅')} value={st.seamBlend ?? 12} min={4} max={20} step={1} unit="°" onChange={(x) => setStab({ seamBlend: x })} />
        <div className="note">{t('広いほど継ぎ目の切り替わりが目立たなくなりますが、近い物は二重に見えやすくなります。')}</div>
        <div className="row">
          <label title={t('トップケース・ナンバープレートなど、カメラと一緒に動く物の継ぎ目を、動画の 30 秒ごとに AI（オプティカルフロー）で合わせます。走行中に継ぎ目がパラパラ動かず、物の一部が欠けません')}>
            <input type="checkbox" checked={st.bodyStitch === true} onChange={(e) => setStab({ bodyStitch: e.target.checked })} /> {t('自車の継ぎ目を AI で合わせる（試験的）')}
          </label>
          <button onClick={p.onRebuildBody} disabled={st.bodyStitch !== true || !!p.bodyStatus?.busy || p.seamBusy} title={t('動画全体で作り直す')}>
            {p.bodyStatus?.busy ? t('作成中…') : t('作り直す')}
          </button>
        </div>
        {p.bodyStatus && (
          <div className="note status">
            {p.bodyStatus.msg}
            {p.bodyStatus.busy ? ` ${Math.round(p.bodyStatus.frac * 100)}%` : ''}
          </div>
        )}
        {st.bodyStitch === true && !p.bodyStatus && p.bodyReady && <div className="note status">{t('自車の継ぎ目: 作成済み（動画の横の .motorecomovie-body.bin）')}</div>}
        <div className="row">
          <span className="name">{t('穴を埋める AI')}</span>
          <select value={st.bodyInpaint ?? 'lama'} disabled={st.bodyStitch !== true} onChange={(e) => setStab({ bodyInpaint: e.target.value as 'lama' | 'migan' })}>
            <option value="lama">{t('LaMa（きれい・遅い）')}</option>
            <option value="migan">{t('MI-GAN（速い）')}</option>
          </select>
        </div>
        <div className="note">{t('どちらのレンズにも写らない所があるときだけ使います。トップケースの後ろに付けた動画では、ふつうは使いません。')}</div>
        <div className="note">{t('オンにすると、動画を開いたときに裏で作ります（GPU で 30 秒の区間ごとに 6〜12 秒）。場面によって、トップケースの欠けやパラパラが直る一方、ナンバープレートや反射板の端が少しゆがむことがあります。')}</div>
      </div>

      <AudioSection {...p} />
      <div className="section" data-section="log">
        <h3>
          {log && <input type="checkbox" checked={project.logEnabled} onChange={(e) => p.onChange({ ...project, logEnabled: e.target.checked })} />}
          {t('車両ログ（MotoReco）')}
        </h3>
        {log ? (
          <>
            <div className="kv">
              <span className="k">{t('ファイル')}</span>
              <span title={log.path}>{window.api.path.basename(log.path)}</span>
              {log.ddfPath && (
                <>
                  <span className="k">{t('変換規則')}</span>
                  <span title={log.ddfPath}>{window.api.path.basename(log.ddfPath)}</span>
                </>
              )}
              <span className="k">{t('時刻のずれ')}</span>
              <span>{t('{s} 秒', { s: log.sync.b.toFixed(3) })}</span>
              <span className="k">{t('同期の信頼度')}</span>
              <span>
                <span className={'badge ' + (log.sync.peakRatio >= 2 ? 'ok' : 'warn')}>{log.sync.peakRatio >= 2 ? t('良好') : t('要確認')}</span> {t('相関 {v}', { v: Math.max(...log.sync.windows.map((w) => w.corr), 0).toFixed(2) })}
              </span>
              <span className="k">{t('尺度の補正')}</span>
              <span>{t('×{k}（ログのリーン角を実際の角度へ）', { k: (1 / log.lean.k).toFixed(3) })}</span>
            </div>
          </>
        ) : (
          <div className="note">{t('動画と同じフォルダの CSV か、下の .dat のフォルダから映像に合うログを自動で探します。見つからない場合は手動で読み込めます。')}</div>
        )}
        {log && log.unsupported.length > 0 && (
          <div className="note status" title={log.unsupported.join('\n')}>
            {t('変換できない規則が {n} 個あります（その列は作りません）', { n: log.unsupported.length })}
          </div>
        )}
        <div className="row">
          <button onClick={p.onLoadLog}>{log ? t('別のログを読み込む…') : t('ログを読み込む…')}</button>
          <button data-action="find-dat" onClick={() => p.onFindDat(false)} title={t('ファイル名の時刻と、映像のジャイロとの相関で選びます')}>
            {t('フォルダから探す')}
          </button>
        </div>
        <div className="kv">
          <span className="k">{t('.dat のフォルダ')}</span>
          <span className="path-cell">
            <span title={p.logPrefs.datFolder ?? ''}>{p.logPrefs.datFolder ? window.api.path.basename(p.logPrefs.datFolder) : t('未設定')}</span>
            <button className="mini" onClick={() => p.onFindDat(true)}>
              {t('変更…')}
            </button>
          </span>
          <span className="k">{t('変換規則（.ddf）')}</span>
          <span className="path-cell">
            <span title={p.logPrefs.ddfPath ?? ''}>{p.logPrefs.ddfPath ? window.api.path.basename(p.logPrefs.ddfPath) : t('未設定')}</span>
            <button className="mini" onClick={p.onChangeDdf}>
              {t('変更…')}
            </button>
          </span>
        </div>
      </div>

      <div className="section">
        <h3>{t('書き出し')}</h3>
        <div className="row">
          <label className="name">{t('サイズ')}</label>
          <select value={preset} onChange={(e) => setEx({ width: PRESETS[+e.target.value].w, height: PRESETS[+e.target.value].h })}>
            {preset < 0 && <option value={-1}>{ex.width}×{ex.height}</option>}
            {PRESETS.map((q, i) => (
              <option key={i} value={i}>
                {t(q.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label className="name">{t('コーデック')}</label>
          <select value={ex.codec} onChange={(e) => setEx({ codec: e.target.value as 'hevc' | 'avc' })}>
            <option value="hevc">H.265 / HEVC</option>
            <option value="avc">H.264 / AVC</option>
          </select>
        </div>
        <div className="row">
          <label className="name">{t('動画に入る文字')}</label>
          <select
            value={ex.textLang ?? ''}
            onChange={(e) => {
              const v = e.target.value
              const textLang = v === 'ja' || v === 'en' ? v : undefined // 「画面と同じ」は undefined
              p.onChange({ ...project, export: { ...project.export, textLang } })
            }}
          >
            <option value="">{t('画面と同じ')}</option>
            <option value="ja">日本語{/* i18n-ignore: 言語名はその言語で書く */}</option>
            <option value="en">English</option>
          </select>
        </div>
        <div className="note">{t('挙動の乱れの表示や字幕の見出しなど、動画に描き込まれる文字の言語')}</div>
        <Slider name={t('ビットレート')} value={ex.bitrateMbps} min={5} max={150} step={5} unit="M" onChange={(x) => setEx({ bitrateMbps: x })} />
        <div className="row">
          <label className="name">{t('範囲')}</label>
          <span>
            {fmtTime(ex.inSec)} 〜 {ex.outSec < 0 ? t('最後') : fmtTime(ex.outSec)}
          </span>
        </div>
        <div className="row">
          <button onClick={p.onSetIn}>{t('現在位置を開始に')}</button>
          <button onClick={p.onSetOut}>{t('現在位置を終了に')}</button>
        </div>
        {p.exporting ? (
          <>
            <div className="progress">
              <div style={{ width: `${(100 * p.exporting.done) / p.exporting.total}%` }} />
            </div>
            <div className="note status">
              {p.exporting.phase === 'audio'
                ? t('音声を合成しています…')
                : t('{done} / {total} フレーム（{fps} fps、残り約 {min} 分）', {
                    done: String(p.exporting.done),
                    total: String(p.exporting.total),
                    fps: p.exporting.fps.toFixed(0),
                    min: String(Math.ceil(p.exporting.etaSec / 60))
                  })}
            </div>
            <button onClick={p.onCancelExport}>{t('中止')}</button>
          </>
        ) : (
          <button className="primary" onClick={p.onExport}>
            {t('書き出す…')}
          </button>
        )}
      </div>
    </div>
  )
}

/** 走行中の音を整える（音割れの補修・エンジン音以外を抑える・音圧を抑える。core/audiofx.ts） */
function AudioSection(p: Props): React.JSX.Element {
  const fx = p.project.audioFx
  const set = (patch: Partial<typeof fx>): void => p.onChange({ ...p.project, audioFx: { ...fx, ...patch } })
  return (
    <div className="section" data-section="audio">
      <h3>
        <input type="checkbox" checked={fx.on} onChange={(e) => set({ on: e.target.checked })} />
        {t('音声')}
        <span className="hint">{t('走行中の音を整える')}</span>
      </h3>
      <div className="note">{t('プレビューと書き出しの音を整えます。「高い音を切る」「音圧を抑える」は再生しながらすぐに効きます。「音割れを補修する」「エンジン音以外を抑える」は裏で作り直し（23 分の動画で 2 分ほど）、できるまでは補修・雑音の処理なしで鳴ります。')}</div>
      <div className="row">
        <label>
          <input type="checkbox" checked={fx.declip} disabled={!fx.on} onChange={(e) => set({ declip: e.target.checked })} /> {t('音割れを補修する')}
        </label>
      </div>
      <div className="note">{t('エンジン全開や風で、マイクの振幅が上限に張り付いた所（音割れ）を、前後の波形から推定して戻します。')}</div>
      <Slider name={t('エンジン音以外を抑える')} value={fx.noiseDb} min={0} max={24} step={1} unit="dB" disabled={!fx.on} onChange={(x) => set({ noiseDb: x })} />
      <div className="note">{t('エンジンの回転の音（倍音）は残し、雨・水しぶき・風切りなどの「サー」という広い帯域の雑音を下げます（目安。実際は 2/3 ほど）。0 で下げません。大きくしすぎると音がこもったり、金属的に聞こえたりします。')}</div>
      <Slider name={t('高い音を切る')} value={fx.lowpassHz ?? 0} min={0} max={6000} step={100} unit="Hz" disabled={!fx.on} onChange={(x) => set({ lowpassHz: x })} />
      <div className="note">{t('排気音だけを通すローパスです。この周波数より高い音（風切りやロードノイズの「サー」という音）を切ります。排気音の倍音は 1.5〜2kHz くらいまでなので、2000Hz 前後がおすすめ。0 で切りません。')}</div>
      <Slider name={t('音圧を抑える')} value={fx.compThresholdDb} min={-36} max={-6} step={1} unit="dBFS" disabled={!fx.on} onChange={(x) => set({ compThresholdDb: x })} />
      <div className="note">{t('この大きさを超える所（エンジン全開など）を 1/3 に圧縮し、ピークを −1dBFS に抑えます。小さい値ほど強く抑えます。')}</div>
      {p.audioStatus && (
        <div className="note status">
          {p.audioStatus.msg}
          {p.audioStatus.busy ? ` ${Math.round(p.audioStatus.frac * 100)}%` : ''}
        </div>
      )}
      {fx.on && !p.audioStatus && p.audioReady && <div className="note status">{t('整えた音で鳴らしています')}</div>}
    </div>
  )
}
