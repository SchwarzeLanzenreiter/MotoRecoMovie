import { useState, useSyncExternalStore } from 'react'
import { layerName } from './layerName'
import type { ExportProgress } from '../engine/exporter'
import { FADE_OUT, TITLE_DUR, viewAt, type Keyframe, type Layer, type OpeningTitle, type Project, type Rect, type ViewLayer, type WidgetKind } from '../engine/project'
import type { LogInfo } from '../engine/session'
import type { LogPrefs } from '../engine/logprefs'
import { OVERTAKE_SCAN_VERSION } from '../core/overtake'
import type { ViewPatch } from '../engine/edit'
import { WIDGET_NAMES, WIDGET_PROPS, type PropDef } from '../render/overlay'
import { DEFAULT_SIGN_AHEAD } from '../render/signs'
import { IncidentSection } from './IncidentPanel'
import { CaptionsSection, LabelsSection, type AnnotationProps } from './AnnotationsSection'
import type { IncidentEvent, IncidentSettings } from '../engine/incident'
import { Slider } from './Slider'
import { DEFAULT_BORDER, TEMPLATES } from '../engine/layout'
import { getTheme, THEMES } from '../render/themes'
import type { ThemeId } from '../render/theme'
import { t, getLang, LANG_NAMES } from '../i18n'
import type { DirectorSettings } from '../engine/director'
import { getMeterLogo, removeMeterLogo, subscribeLogos } from '../engine/meter-logos'

export const PRESETS: { label: string; w: number; h: number }[] = [
  { label: '1920×1080 (16:9)', w: 1920, h: 1080 }, // i18n-ignore
  { label: '2560×1440 (16:9)', w: 2560, h: 1440 }, // i18n-ignore
  { label: '3840×2160 (4K 16:9)', w: 3840, h: 2160 }, // i18n-ignore
  { label: '1080×1920 (portrait 9:16)', w: 1080, h: 1920 }, // i18n-ignore
  { label: '1080×1350 (4:5)', w: 1080, h: 1350 }, // i18n-ignore
  { label: '1080×1080 (1:1)', w: 1080, h: 1080 } // i18n-ignore
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
  /** Whether the riding state and corners were estimated from the video IMU rather than from the vehicle log */
  ridingFromImu: boolean
  /** Whether the lean angle is known (from the vehicle log, or estimated from the video IMU) */
  leanAvailable: boolean
  /** Captions and place labels */
  annotations: AnnotationProps
  onSeekTime: (t: number) => void
  onUpdateDirector: (d: DirectorSettings) => void
  /** Opens the settings menu "Auto-generated views" (defaults for the front, corner entry, side and rear views) */
  onOpenShotViews: () => void
  /** Choose an image for the logo in the middle of the theme's meter, and adjust it */
  onChooseLogo: (themeId: string) => void
  /** Adjust the logo the theme already has */
  onEditLogo: (themeId: string) => void
  onGenerate: (range: 'export' | 'all') => void
  incidentEvents: IncidentEvent[]
  incidentAvailable: boolean
  mainFull: boolean
  onUpdateIncident: (patch: Partial<IncidentSettings>) => void
  onEstimateSeam: () => void
  seamBusy: boolean
  /** Progress of building the own-bike seam pattern (null when it is not being built) */
  bodyStatus: { busy: boolean; frac: number; msg: string } | null
  bodyReady: boolean
  onRebuildBody: () => void
  /** Progress of conditioning the audio while riding (null when it is not being done) */
  audioStatus: { busy: boolean; frac: number; msg: string } | null
  /** Progress of finding the own bike in the video (to hide signs behind it; null when it is not being done) */
  maskStatus: { busy: boolean; frac: number; msg: string } | null
  /** Search for license plates (mosaic) */
  plateStatus: { busy: boolean; frac: number; msg: string } | null
  /** Boxes drawn by hand around the own license plate, and whether the next drag on the video draws one */
  plateMarks: number
  markingPlate: boolean
  onMarkPlate: () => void
  onClearPlateMarks: () => void
  /** The own bike has been found in the video (signs are hidden behind it) */
  maskReady: boolean
  /** For checking: show where signs are cut for the own bike in the preview */
  showBikeMask: boolean
  onShowBikeMask: (on: boolean) => void
  audioReady: boolean
  onLoadLog: () => void
  /** Save and load the settings file (the settings on the right, the positions of meters, etc.) */
  onSaveSettings: () => void
  onLoadSettings: () => void
  logPrefs: LogPrefs
  onChangeDdf: () => void
  /** Look for the .dat matching the video in a folder (if true, choose the folder again) */
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

/** Design theme of everything drawn over the video, switched at once */
function ThemeSection(p: Props): React.JSX.Element {
  const cur = getTheme(p.project.theme)
  // the logo is read from the store, which changes outside the project
  const logo = useSyncExternalStore(subscribeLogos, () => getMeterLogo(cur.id))
  return (
    <div className="section">
      <h3>
        {t('Design theme')}
        <span className="hint">{t('Everything over the video changes together')}</span>
      </h3>
      <div className="row">
        <select data-action="theme" value={cur.id} onChange={(e) => p.onChange({ ...p.project, theme: e.target.value as ThemeId })} style={{ flex: 1, minWidth: 0 }}>
          {THEMES.map((x) => (
            <option key={x.id} value={x.id}>
              {t(x.name)}
            </option>
          ))}
        </select>
        <span className="theme-swatch">
          {[cur.pal.line, cur.pal.line2, cur.pal.hot, ...(cur.pal.stripes ?? [])].map((c, k) => (
            <span key={k} style={{ background: c }} />
          ))}
        </span>
      </div>
      <div className="row">
        <label className="name">{t('Meter logo')}</label>
        <button data-action="logo-choose" onClick={() => p.onChooseLogo(cur.id)}>
          {t('Choose image…')}
        </button>
        {logo && (
          <>
            <button data-action="logo-adjust" onClick={() => p.onEditLogo(cur.id)}>
              {t('Adjust…')}
            </button>
            <button data-action="logo-remove" onClick={() => removeMeterLogo(cur.id)}>
              {t('Remove')}
            </button>
          </>
        )}
      </div>
      <div className="note">{t('Shown in the middle of the meter instead of the built-in emblem. Remembered on this PC for each theme.')}</div>
    </div>
  )
}

function LayoutSection(p: Props): React.JSX.Element {
  const aspect = p.project.export.width / p.project.export.height
  // the thumbnail follows the output aspect ratio (landscape for landscape, portrait for portrait)
  const W = aspect >= 1 ? 40 : Math.round(40 * aspect)
  const H = aspect >= 1 ? Math.round(40 / aspect) : 40
  return (
    <div className="section">
      <h3>
        {t('Screen layout')}<span className="hint">{t('Set the number and arrangement of views at once')}</span>
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
      <div className="note">{t('Extra views are hidden, not deleted (their keyframes are kept).')}</div>
    </div>
  )
}

/** Choose the kind of overlay and add it */
function AddOverlay({ onAdd }: { onAdd: (w: WidgetKind) => void }): React.JSX.Element {
  const [kind, setKind] = useState<WidgetKind>('meter')
  return (
    <>
      <select value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)} style={{ flex: 1, minWidth: 0 }}>
        {(Object.keys(WIDGET_NAMES) as WidgetKind[]).filter((w) => w !== 'captions').map((w) => (
          <option key={w} value={w}>
            {t(WIDGET_NAMES[w])}
          </option>
        ))}
      </select>
      <button onClick={() => onAdd(kind)}>{t('+ Add')}</button>
    </>
  )
}

function DirectorSection(p: Props): React.JSX.Element {
  const d = p.project.director
  const set = <K extends keyof DirectorSettings>(k: K, v: Partial<DirectorSettings[K]>): void =>
    p.onUpdateDirector({ ...d, [k]: typeof v === 'object' ? { ...(d[k] as object), ...v } : v })
  const [range, setRange] = useState<'export' | 'all'>('export')
  const Rule = ({ k, label }: { k: 'corner' | 'cruise' | 'stop'; label: string }): React.JSX.Element => (
    <label className="rule">
      <input type="checkbox" checked={d[k].on} disabled={!p.hasRiding} onChange={(e) => set(k, { on: e.target.checked })} /> {label}
    </label>
  )
  return (
    <div className="section">
      <h3>
        {t('Auto camera')}<span className="hint">{t('Creates keyframes for {name}', { name: layerName(p.selView.name) })}</span>
      </h3>
      {!p.hasRiding && <div className="note status">{t('Switching by riding state needs a vehicle log.')}</div>}
      {p.ridingFromImu && <div className="note status">{t('There is no vehicle log, so the riding state is estimated from the video motion (gyro and accelerometer). It is less accurate than with a log.')}</div>}
      <div className="rules">
        <Rule k="corner" label={t('Corner entry shots')} />
        <Rule k="cruise" label={t('Side scenery on long cruises')} />
        <Rule k="stop" label={t('Wide scenery when stopped')} />
      </div>
      <div className="note">{t('Corners: ① look slightly inside (default). Every few long corners, inserts in turn ② a shot of yourself (level, wide), ③ straight sideways, inside, and ④ straight sideways, outside (entry and exit in one frame).')}</div>
      <div className="row">
        <button data-action="open-shot-views" onClick={p.onOpenShotViews}>
          {t('Default views (front, corner entry, side, rear)…')}
        </button>
      </div>
      <div className="rules">
        <label className="rule">
          <input type="checkbox" checked={d.corner.special.rider} disabled={!p.hasRiding || !d.corner.on} onChange={(e) => set('corner', { special: { ...d.corner.special, rider: e.target.checked } })} /> {t('② Show yourself')}
        </label>
        <label className="rule">
          <input type="checkbox" checked={d.corner.special.side} disabled={!p.hasRiding || !d.corner.on} onChange={(e) => set('corner', { special: { ...d.corner.special, side: e.target.checked } })} /> {t('③ Sideways (inside)')}
        </label>
        <label className="rule">
          <input type="checkbox" checked={d.corner.special.sideOut} disabled={!p.hasRiding || !d.corner.on} onChange={(e) => set('corner', { special: { ...d.corner.special, sideOut: e.target.checked } })} /> {t('④ Sideways (outside)')}
        </label>
      </div>
      <Slider name={t('②–④ every N corners')} value={d.corner.special.every} min={1} max={8} step={1} unit={t('')} disabled={!d.corner.on} onChange={(x) => set('corner', { special: { ...d.corner.special, every: x } })} />
      <Slider name={t('②–④ min. corner length')} value={d.corner.special.minDur} min={1} max={8} step={0.5} unit="s" disabled={!d.corner.on} onChange={(x) => set('corner', { special: { ...d.corner.special, minDur: x } })} />
      <Slider name={t('Scenery interval')} value={d.cruise.interval} min={8} max={60} step={1} unit="s" disabled={!d.cruise.on} onChange={(x) => set('cruise', { interval: x })} />
      <div className="rules">
        <label className="rule">
          <input type="checkbox" data-action="overtake" checked={d.overtake.on} onChange={(e) => set('overtake', { on: e.target.checked })} /> {t('Hide the road while overtaking')}
        </label>
      </div>
      <div className="note">
        {t('While crossing the center line to overtake a vehicle, the view looks up (sky and scenery) so the road is not shown. Overtakes are found from the center line, the road surface and vehicle detection in the video (the first time takes about a minute).')}
      </div>
      {p.project.overtakes && p.project.overtakesVersion === OVERTAKE_SCAN_VERSION && (
        <div className="note status">
          {t('Overtakes found: {n}', { n: p.project.overtakes.length })}{' '}
          <button className="mini" onClick={() => p.onChange({ ...p.project, overtakes: undefined })} title={t('Scan the video again on the next generation')}>
            {t('Rescan')}
          </button>
        </div>
      )}
      <Slider name={t('Overtake: look up')} value={d.overtake.pitch} min={0} max={70} step={1} unit="°" disabled={!d.overtake.on} onChange={(x) => set('overtake', { pitch: x })} />
      <Slider name={t('Overtake: field of view')} value={d.overtake.fov} min={50} max={130} step={1} unit="°" disabled={!d.overtake.on} onChange={(x) => set('overtake', { fov: x })} />
      <Slider name={t('Min. speed to switch')} value={d.overtake.minSpeed} min={0} max={100} step={5} unit="km/h" disabled={!d.overtake.on} onChange={(x) => set('overtake', { minSpeed: x })} />
      <div className="note">{t('Overtakes slower than this (average speed while overtaking) do not switch the view. Set 0 to always switch. Speed comes from the vehicle log (or, without one, is estimated from the video motion).')}</div>
      <Slider name={t('Transition time')} value={d.transition} min={0.1} max={2} step={0.1} unit="s" onChange={(x) => p.onUpdateDirector({ ...d, transition: x })} />
      <Slider name={t('Shortest shot')} value={d.minShot} min={0.5} max={5} step={0.1} unit="s" onChange={(x) => p.onUpdateDirector({ ...d, minShot: x })} />
      <div className="row">
        <select value={range} onChange={(e) => setRange(e.target.value as 'export' | 'all')}>
          <option value="export">{t('Export range')}</option>
          <option value="all">{t('Whole video')}</option>
        </select>
        <button className="primary" onClick={() => p.onGenerate(range)}>
          {t('Generate keyframes')}
        </button>
      </div>
      <div className="note">{t('Keyframes in the range are replaced (Ctrl+Z to undo). Views use the defaults in Settings > Auto-generated views.')}</div>
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
        {t('Layers')}<span className="hint">{t('Top is drawn in front')}</span>
      </h3>
      <div className="layers">
        {[...project.layers].reverse().map((l) => (
          <div key={l.id} className={'layer-row' + (l.id === selLayer?.id ? ' sel' : '')} onClick={() => p.onSelectLayer(l.id)}>
            <input type="checkbox" checked={l.visible} onClick={(e) => e.stopPropagation()} onChange={(e) => p.onUpdateLayer(l.id, { visible: e.target.checked })} />
            <span className="lname">{layerName(l.name)}</span>
            <span className="kind">{l.type === 'view' ? t('View') : t('Overlay')}</span>
            <button title={t('Bring forward')} onClick={(e) => (e.stopPropagation(), p.onMoveLayer(l.id, 1))}>▲</button>
            <button title={t('Send backward')} onClick={(e) => (e.stopPropagation(), p.onMoveLayer(l.id, -1))}>▼</button>
            <button title={t('Delete')} disabled={l.type === 'view' && views <= 1} onClick={(e) => (e.stopPropagation(), p.onRemoveLayer(l.id))}>×</button>
          </div>
        ))}
      </div>
      <div className="row">
        <button onClick={p.onAddView}>{t('+ View')}</button>
        <AddOverlay onAdd={p.onAddOverlay} />
      </div>
      {selLayer && rect && (
        <>
          <div className="row">
            <label className="name">{t('Name')}</label>
            <input type="text" value={layerName(selLayer.name)} onChange={(e) => p.onUpdateLayer(selLayer.id, { name: e.target.value })} style={{ flex: 1 }} />
          </div>
          <div className="rect-edit">
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <div key={k}>
                <label>{{ x: t('Left %'), y: t('Top %'), w: t('Width %'), h: t('Height %') }[k]}</label>
                <input type="number" step={1} value={Math.round(rect[k] * 1000) / 10} onChange={(e) => setRect(k, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>
          {selLayer.type === 'view' && (
            <div className="row">
              <label className="name">{t('Border')}</label>
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
                <input type="checkbox" checked={!!selLayer.signs} disabled={!p.hasRiding} onChange={(e) => p.onUpdateLayer(selLayer.id, { signs: e.target.checked })} /> {t('Corner signs (show curve radius in the air)')}
              </label>
            </div>
          )}
          {selLayer.type === 'view' && selLayer.signs && (
            <Slider
              name={t('Sign position')}
              value={selLayer.signAhead ?? DEFAULT_SIGN_AHEAD}
              min={-100}
              max={50}
              step={5}
              unit="m"
              onChange={(x) => p.onUpdateLayer(selLayer.id, { signAhead: x })}
            />
          )}
          {selLayer.type === 'view' && selLayer.signs && p.ridingFromImu && (
            <div className="note status">{t('There is no vehicle log, so the curve radius and sign positions are estimated from the video motion (speed is unknown, so expect errors; without GPS altitude, signs beyond a crest are not hidden).')}</div>
          )}
          {selLayer.type === 'view' && selLayer.signs && <div className="note">{t('Distance along the route from the corner entry (minus = before the entry, plus = into the corner).')}</div>}
          {selLayer.type === 'view' && selLayer.signs && (
            <div className="row">
              <label>
                <input type="checkbox" checked={p.showBikeMask} onChange={(e) => p.onShowBikeMask(e.target.checked)} /> {t('Show where signs are hidden behind your bike (for checking)')}
              </label>
            </div>
          )}
          {selLayer.type === 'view' && selLayer.signs && (
            <div className="note">
              {t('Blue: the outline of your bike and body found by AI. Red: estimated from the still parts and colors of the video (until the AI result arrives, or if the AI cannot run). Shown in the preview only, never exported.')}
            </div>
          )}
          {selLayer.type === 'view' && selLayer.signs && !p.maskReady && !p.maskStatus && (
            <div className="note warn">{t('Press "Generate keyframes" to find your bike in the video, so that signs are hidden behind it (a few minutes, once per video).')}</div>
          )}
          {selLayer.type === 'view' && selLayer.signs && p.maskStatus && (
            <div className={p.maskStatus.busy ? 'note status' : 'note warn'}>
              {p.maskStatus.msg}
              {p.maskStatus.busy ? ` ${Math.round(p.maskStatus.frac * 100)}%` : ''}
            </div>
          )}
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
            {selLayer.type === 'view' ? t('In the preview: drag the frame handles to resize; drag the top grip or Shift+drag to move.') : t('In the preview: drag to move; drag the frame handles to resize.')}
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
  const setTitle = (patch: Partial<OpeningTitle>): void => setEx({ title: { text: '', sub: '', dur: TITLE_DUR, ...ex.title, ...patch } })
  const logOn = !!log && project.logEnabled
  const preset = PRESETS.findIndex((q) => q.w === ex.width && q.h === ex.height)

  return (
    <div className="side">
      <div className="section">
        <h3>{t('Settings file')}</h3>
        <div className="row">
          <button data-action="save-settings" onClick={p.onSaveSettings}>
            {t('Save settings…')}
          </button>
          <button data-action="load-settings" onClick={p.onLoadSettings}>
            {t('Load settings…')}
          </button>
        </div>
        <div className="note">
          {t('Saves the settings on the right and the position and size of meters and other layers to one file that you can use with other videos. The main view\'s motion (keyframes), captions, place labels, the opening title, export range and seam estimate are per video and are not included.')}
        </div>
      </div>
      <ThemeSection {...p} />
      <LayoutSection {...p} />
      <LayersSection {...p} />
      <div className="section">
        <h3>
          {t('View ({name})', { name: layerName(selView.name) })}
          <span className="hint">{selView.keyframes.length === 1 ? t('Applies to the whole video') : p.hasKeyHere ? t('Keyframe at this time') : t('Changes add a keyframe')}</span>
        </h3>
        <Slider name={t('Yaw')} value={v.yaw} min={-180} max={180} step={1} unit="°" onChange={(x) => p.onEditView({ yaw: x })} />
        <Slider name={t('Pitch')} value={v.pitch} min={-89} max={89} step={1} unit="°" onChange={(x) => p.onEditView({ pitch: x })} />
        <Slider name={t('FOV')} value={v.fov} min={30} max={180} step={1} unit="°" onChange={(x) => p.onEditView({ fov: x })} />
        <Slider name={t('Keep lean')} value={v.leanRatio * 100} min={0} max={100} step={5} unit="%" disabled={!p.leanAvailable} onChange={(x) => p.onEditView({ leanRatio: x / 100 })} />
        {!p.leanAvailable && <div className="note status">{t('"Keep lean" is available after loading a vehicle log (MotoReco).')}</div>}
        {p.leanAvailable && !logOn && <div className="note status">{t('There is no vehicle log, so the lean angle is estimated from the video motion.')}</div>}
        <div className="row">
          <button onClick={p.onAddKey} disabled={p.hasKeyHere}>{t('◆ Add keyframe')}</button>
          <button onClick={p.onRemoveKey} disabled={!p.hasKeyHere || selView.keyframes.length <= 1}>{t('Delete')}</button>
          <span className="note">{t('{n} total', { n: selView.keyframes.length })}</span>
        </div>
        <div className="note">{t('Drag the video to change direction; use the wheel to change the FOV.')}</div>
      </div>

      <DirectorSection {...p} />
      <CaptionsSection {...p.annotations} />
      <LabelsSection {...p.annotations} />
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
          {t('Stabilization')}
          <span className="hint">{t('No horizon lock')}</span>
        </h3>
        <Slider name={t('Pitch')} value={st.sigma[0]} min={0.05} max={1.5} step={0.05} unit="s" disabled={!st.enabled} onChange={(x) => setSigma(0, x)} />
        <Slider name={t('Yaw')} value={st.sigma[1]} min={0.05} max={1.5} step={0.05} unit="s" disabled={!st.enabled} onChange={(x) => setSigma(1, x)} />
        <Slider name={t('Roll')} value={st.sigma[2]} min={0.05} max={1.5} step={0.05} unit="s" disabled={!st.enabled} onChange={(x) => setSigma(2, x)} />
        <div className="note">{t('Higher is smoother. A high roll value makes lean tracking lag (corrected when a log is loaded).')}</div>
        <div className="row">
          <label>
            <input type="checkbox" checked={st.rollingShutter} onChange={(e) => setStab({ rollingShutter: e.target.checked })} /> {t('Rolling shutter correction')}
          </label>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={st.rollComp} disabled={!logOn || !st.enabled} onChange={(e) => setStab({ rollComp: e.target.checked })} /> {t('Correct roll lag with the log')}
          </label>
        </div>
        <div className="row">
          <label title={t('Adjusts lens 1\'s orientation so both images match in the band where the front and back lenses overlap (fixes seam offset when looking sideways)')}>
            <input type="checkbox" checked={st.seamFix !== false && !!st.seam} disabled={!st.seam} onChange={(e) => setStab({ seamFix: e.target.checked })} /> {t('Align the lens seam')}
            {st.seam && <span className="hint">{t('(edge {edge}°, rotation {rot}°)', { edge: st.seam.edge.toFixed(1), rot: Math.hypot(...st.seam.rot).toFixed(1) })}</span>}
          </label>
          <button onClick={p.onEstimateSeam} disabled={p.seamBusy} title={t('Re-estimate from frames at several points in the video')}>
            {p.seamBusy ? t('Estimating…') : t('Re-estimate')}
          </button>
        </div>
        <div className="row">
          <label title={t('Measures the distance to the scene near the seam every frame and corrects the parallax from the gap between the front and back lenses (about 3.3 cm). Aligns the seam on near objects such as the road, bike and rider')}>
            <input type="checkbox" checked={st.dynamicSeam !== false} onChange={(e) => setStab({ dynamicSeam: e.target.checked })} /> {t('Align the seam on near objects too (dynamic stitching)')}
          </label>
        </div>
        <Slider name={t('Seam blend width')} value={st.seamBlend ?? 12} min={4} max={20} step={1} unit="°" onChange={(x) => setStab({ seamBlend: x })} />
        <div className="note">{t('Wider hides the seam transition better, but near objects are more likely to look doubled.')}</div>
        <div className="row">
          <label title={t('Aligns the seam over parts that move with the camera (top case, license plate) with AI optical flow, every 30 seconds of video. The seam stops flickering while riding and parts are no longer cut away.')}>
            <input type="checkbox" checked={st.bodyStitch === true} onChange={(e) => setStab({ bodyStitch: e.target.checked })} /> {t('Align the body seam with AI (experimental)')}
          </label>
          <button onClick={p.onRebuildBody} disabled={st.bodyStitch !== true || !!p.bodyStatus?.busy || p.seamBusy} title={t('Rebuild for the whole video')}>
            {p.bodyStatus?.busy ? t('Building…') : t('Rebuild')}
          </button>
        </div>
        {p.bodyStatus && (
          <div className="note status">
            {p.bodyStatus.msg}
            {p.bodyStatus.busy ? ` ${Math.round(p.bodyStatus.frac * 100)}%` : ''}
          </div>
        )}
        {st.bodyStitch === true && !p.bodyStatus && p.bodyReady && <div className="note status">{t('Body seam map: ready (.motorecomovie-body.bin next to the video)')}</div>}
        <div className="row">
          <span className="name">{t('Inpainting AI')}</span>
          <select value={st.bodyInpaint ?? 'lama'} disabled={st.bodyStitch !== true} onChange={(e) => setStab({ bodyInpaint: e.target.value as 'lama' | 'migan' })}>
            <option value="lama">{t('LaMa (cleaner, slower)')}</option>
            <option value="migan">{t('MI-GAN (faster)')}</option>
          </select>
        </div>
        <div className="note">{t('Used only where neither lens sees the scene. With the camera behind the top case it is normally not needed.')}</div>
        <div className="note">{t('When on, the map is built in the background after opening a video (6 to 12 s per 30 s section on the GPU). Depending on the scene it fixes missing top-case parts and flicker, but may slightly distort the license plate or reflector ends.')}</div>
      </div>

      <AudioSection {...p} />
      <div className="section" data-section="log">
        <h3>
          {log && <input type="checkbox" checked={project.logEnabled} onChange={(e) => p.onChange({ ...project, logEnabled: e.target.checked })} />}
          {t('Vehicle log (MotoReco)')}
        </h3>
        {log ? (
          <>
            <div className="kv">
              <span className="k">{t('File')}</span>
              <span title={log.path}>{window.api.path.basename(log.path)}</span>
              {log.ddfPath && (
                <>
                  <span className="k">{t('Rules')}</span>
                  <span title={log.ddfPath}>{window.api.path.basename(log.ddfPath)}</span>
                </>
              )}
              <span className="k">{t('Time offset')}</span>
              <span>{t('{s} s', { s: log.sync.b.toFixed(3) })}</span>
              <span className="k">{t('Sync confidence')}</span>
              <span>
                <span className={'badge ' + (log.sync.peakRatio >= 2 ? 'ok' : 'warn')}>{log.sync.peakRatio >= 2 ? t('Good') : t('Check')}</span> {t('correlation {v}', { v: Math.max(...log.sync.windows.map((w) => w.corr), 0).toFixed(2) })}
              </span>
              <span className="k">{t('Scale correction')}</span>
              <span>{t('×{k} (log lean angle to actual angle)', { k: (1 / log.lean.k).toFixed(3) })}</span>
            </div>
          </>
        ) : (
          <div className="note">{t('Looks for a CSV next to the video, or a matching log in the .dat folder below. If none is found, you can load one manually.')}</div>
        )}
        {log && log.unsupported.length > 0 && (
          <div className="note status" title={log.unsupported.join('\n')}>
            {t('{n} rules cannot be decoded (those columns are skipped)', { n: log.unsupported.length })}
          </div>
        )}
        <div className="row">
          <button onClick={p.onLoadLog}>{log ? t('Load another log…') : t('Load log…')}</button>
          <button data-action="find-dat" onClick={() => p.onFindDat(false)} title={t('Chooses by the time in the file name and the correlation with the video gyro')}>
            {t('Find in folder')}
          </button>
        </div>
        <div className="kv">
          <span className="k">{t('.dat folder')}</span>
          <span className="path-cell">
            <span title={p.logPrefs.datFolder ?? ''}>{p.logPrefs.datFolder ? window.api.path.basename(p.logPrefs.datFolder) : t('Not set')}</span>
            <button className="mini" onClick={() => p.onFindDat(true)}>
              {t('Change…')}
            </button>
          </span>
          <span className="k">{t('Rules (.ddf)')}</span>
          <span className="path-cell">
            <span title={p.logPrefs.ddfPath ?? ''}>{p.logPrefs.ddfPath ? window.api.path.basename(p.logPrefs.ddfPath) : t('Not set')}</span>
            <button className="mini" onClick={p.onChangeDdf}>
              {t('Change…')}
            </button>
          </span>
        </div>
      </div>

      <div className="section">
        <h3>{t('Export')}</h3>
        <div className="row">
          <label className="name">{t('Size')}</label>
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
          <label className="name">{t('Codec')}</label>
          <select value={ex.codec} onChange={(e) => setEx({ codec: e.target.value as 'hevc' | 'avc' })}>
            <option value="hevc">H.265 / HEVC</option>
            <option value="avc">H.264 / AVC</option>
          </select>
        </div>
        <div className="row">
          <label className="name">{t('Text in video')}</label>
          <select
            value={ex.textLang ?? ''}
            onChange={(e) => {
              const v = e.target.value
              const textLang = v === 'ja' || v === 'en' ? v : undefined // "Same as app" is undefined
              p.onChange({ ...project, export: { ...project.export, textLang } })
            }}
          >
            <option value="">{t('Same as app')}</option>
            {LANG_NAMES.map(([v, name]) => (
              <option key={v} value={v}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="note">{t('Language of text drawn into the video, such as disturbance labels and caption headings')}</div>
        <Slider name={t('Bitrate')} value={ex.bitrateMbps} min={5} max={150} step={5} unit="M" onChange={(x) => setEx({ bitrateMbps: x })} />
        <div className="row">
          <label className="name">{t('Opening title')}</label>
          <input type="text" value={ex.title?.text ?? ''} placeholder={t('Title')} onChange={(e) => setTitle({ text: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
        </div>
        <div className="row">
          <label className="name">{t('Subtitle')}</label>
          <input type="text" value={ex.title?.sub ?? ''} placeholder={t('Subtitle')} onChange={(e) => setTitle({ sub: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
        </div>
        <div className="row">
          <label className="name">{t('Title shown')}</label>
          <input type="number" value={ex.title?.dur ?? TITLE_DUR} min={1} max={30} step={0.5} onChange={(e) => setTitle({ dur: Math.max(1, parseFloat(e.target.value) || TITLE_DUR) })} style={{ width: 56 }} />
          <span>{t('s')}</span>
        </div>
        <div className="note">{t('Shown in the middle of the frame from the start of the export range, in the design theme (the subtitle at 1/3 the size). Leave both empty for no title.')}</div>
        <div className="row">
          <label className="name">{t('Fade out at the end')}</label>
          <input type="number" value={ex.fadeOutSec ?? FADE_OUT} min={0} max={10} step={0.5} onChange={(e) => setEx({ fadeOutSec: Math.max(0, Math.min(10, parseFloat(e.target.value) || 0)) })} style={{ width: 56 }} />
          <span>{t('s')}</span>
        </div>
        <div className="note">{t('The picture fades to black and the sound fades out over the last seconds of the export range (0 = off).')}</div>
        <div className="row">
          <label>
            <input type="checkbox" data-action="plates" checked={ex.plates !== false} onChange={(e) => setEx({ plates: e.target.checked })} /> {t('Mosaic over license plates')}
          </label>
        </div>
        <div className="note">
          {t('Pixelates the license plates of your bike and of oncoming and overtaken vehicles, in the preview too. The plates are found by AI a few times a second, in the background while the video is not playing (about half the length of the video the first time; kept for next time); the export range is finished first if needed.')}
        </div>
        {ex.plates !== false && p.plateStatus && (
          <div className={p.plateStatus.busy ? 'note status' : 'note warn'}>
            {p.plateStatus.msg}
            {p.plateStatus.busy ? ` ${Math.round(p.plateStatus.frac * 100)}%` : ''}
          </div>
        )}
        {ex.plates !== false && (
          <>
            <div className="row">
              <button data-action="mark-plate" className={p.markingPlate ? 'on' : ''} onClick={p.onMarkPlate}>
                {t('Mark your plate')}
              </button>
              {p.plateMarks > 0 && (
                <button data-action="clear-plate-marks" onClick={p.onClearPlateMarks}>
                  {t('Clear marks ({n})', { n: String(p.plateMarks) })}
                </button>
              )}
            </div>
            <div className="note">
              {p.markingPlate
                ? t('Drag a box around your license plate in the video.')
                : t('If the mosaic misses your own plate, drag a box around it at that time. Where it is still off (the camera turned on its mount), mark it there again; in between it follows the marks.')}
            </div>
          </>
        )}
        <div className="row">
          <label className="name">{t('Range')}</label>
          <span>
            {fmtTime(ex.inSec)} - {ex.outSec < 0 ? t('End') : fmtTime(ex.outSec)}
          </span>
        </div>
        <div className="row">
          <button onClick={p.onSetIn}>{t('Set start to playhead')}</button>
          <button onClick={p.onSetOut}>{t('Set end to playhead')}</button>
        </div>
        {p.exporting ? (
          <>
            <div className="progress">
              <div style={{ width: `${(100 * p.exporting.done) / p.exporting.total}%` }} />
            </div>
            <div className="note status">
              {p.exporting.phase === 'plates'
                ? t('Looking for license plates in the export range… {p}%', { p: String(Math.round(p.exporting.done * 100)) })
                : p.exporting.phase === 'audio'
                ? t('Mixing audio…')
                : t('{done} / {total} frames ({fps} fps, about {min} min left)', {
                    done: String(p.exporting.done),
                    total: String(p.exporting.total),
                    fps: p.exporting.fps.toFixed(0),
                    min: String(Math.ceil(p.exporting.etaSec / 60))
                  })}
            </div>
            <button onClick={p.onCancelExport}>{t('Cancel')}</button>
          </>
        ) : (
          <button className="primary" onClick={p.onExport}>
            {t('Export…')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Condition the audio while riding (declip, suppress everything except the engine sound, reduce the level; core/audiofx.ts) */
function AudioSection(p: Props): React.JSX.Element {
  const fx = p.project.audioFx
  const set = (patch: Partial<typeof fx>): void => p.onChange({ ...p.project, audioFx: { ...fx, ...patch } })
  return (
    <div className="section" data-section="audio">
      <h3>
        <input type="checkbox" checked={fx.on} onChange={(e) => set({ on: e.target.checked })} />
        {t('Audio')}
        <span className="hint">{t('Clean up riding sound')}</span>
      </h3>
      <div className="note">{t('Cleans up the sound for preview and export. Cut high frequencies and Tame loud parts apply immediately while playing. Repair clipping and Reduce non-engine noise are rebuilt in the background (about 2 minutes for a 23-minute video); until then the sound plays without them.')}</div>
      <div className="row">
        <label>
          <input type="checkbox" checked={fx.declip} disabled={!fx.on} onChange={(e) => set({ declip: e.target.checked })} /> {t('Repair clipping')}
        </label>
      </div>
      <div className="note">{t('Reconstructs places where the microphone hit its limit (clipping) at full throttle or in wind, estimating them from the surrounding waveform.')}</div>
      <Slider name={t('Reduce non-engine noise')} value={fx.noiseDb} min={0} max={24} step={1} unit="dB" disabled={!fx.on} onChange={(x) => set({ noiseDb: x })} />
      <div className="note">{t('Keeps the engine sound (its harmonics) and lowers broadband hiss such as rain, spray and wind (a guide; the actual reduction is about 2/3 of it). 0 disables it. Too much can make the sound muffled or metallic.')}</div>
      <Slider name={t('Cut high frequencies')} value={fx.lowpassHz ?? 0} min={0} max={6000} step={100} unit="Hz" disabled={!fx.on} onChange={(x) => set({ lowpassHz: x })} />
      <div className="note">{t('A low-pass filter that passes only the exhaust sound. Cuts sound above this frequency (the hiss of wind and road noise). The exhaust harmonics reach about 1.5 to 2 kHz, so around 2000 Hz is recommended. 0 disables it.')}</div>
      <Slider name={t('Tame loud parts')} value={fx.compThresholdDb} min={-36} max={-6} step={1} unit="dBFS" disabled={!fx.on} onChange={(x) => set({ compThresholdDb: x })} />
      <div className="note">{t('Compresses parts louder than this (full throttle, etc.) at 3:1 and limits peaks to −1 dBFS. Lower values compress more.')}</div>
      {p.audioStatus && (
        <div className="note status">
          {p.audioStatus.msg}
          {p.audioStatus.busy ? ` ${Math.round(p.audioStatus.frac * 100)}%` : ''}
        </div>
      )}
      {fx.on && !p.audioStatus && p.audioReady && <div className="note status">{t('Playing the cleaned-up sound')}</div>}
    </div>
  )
}
