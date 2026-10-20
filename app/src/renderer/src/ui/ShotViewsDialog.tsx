// Settings menu "Auto-generated views": defaults for the 4 views (front, corner entry, side, rear) that keyframe auto-generation switches between.
// The selected view is shown as-is in the preview (the selected view layer). One button restores the app defaults
import { DEFAULT_SHOT_VIEWS, SHOT_VIEW_KINDS, type ShotViewKind, type ShotViews } from '../engine/director'
import { t } from '../i18n'
import { KEY_COLORS, KEY_TAG_NAMES } from './keyColors'
import { Slider } from './Slider'
import { useLang } from './useLang'

interface Props {
  views: ShotViews
  onChange: (v: ShotViews) => void
  /** The view being edited (shown in the preview) */
  kind: ShotViewKind
  onKind: (k: ShotViewKind) => void
  /** Side preview: ③ inside / ④ outside */
  side: 'in' | 'out'
  onSide: (s: 'in' | 'out') => void
  /** Show in the preview (when a video is open) */
  preview: boolean
  canPreview: boolean
  onPreview: (on: boolean) => void
  onClose: () => void
}

const same = (a: object, b: object): boolean => JSON.stringify(a) === JSON.stringify(b)

export function ShotViewsDialog(p: Props): React.JSX.Element {
  useLang()
  const v = p.views
  const k = p.kind
  const set = (patch: Record<string, number>): void => p.onChange({ ...v, [k]: { ...v[k], ...patch } })
  const cur = v[k] as unknown as Record<string, number>
  const isDefault = same(v[k], DEFAULT_SHOT_VIEWS[k])
  const allDefault = same(v, DEFAULT_SHOT_VIEWS)
  return (
    <div className="dialog shot-views" data-dialog="shot-views">
      <div className="dialog-head">
        <h3>{t('Auto-generated views')}</h3>
        <button className="mini" data-action="shot-views-close" onClick={p.onClose} title={t('Close')}>
          ✕
        </button>
      </div>
      <div className="note">{t('Default views that "Generate keyframes" switches between. They are remembered on this PC and used from the next generation (existing keyframes do not change).')}</div>
      <div className="seg shot-kinds">
        {SHOT_VIEW_KINDS.map((x) => (
          <button key={x} data-kind={x} className={x === k ? 'on' : ''} onClick={() => p.onKind(x)}>
            <span className="swatch" style={{ background: KEY_COLORS[x] }} />
            {t(KEY_TAG_NAMES[x])}
          </button>
        ))}
      </div>
      <div className="note">
        {k === 'front' && t('The basic view. Stop and cruise scenery are small changes from it.')}
        {k === 'corner' && t('When entering a corner, the view turns inward from the front direction by lean angle × inward amount (up to the maximum angle).')}
        {k === 'side' && t('Side view inserted in long corners. It turns this far toward the inside (③) or outside (④) of the corner.')}
        {k === 'rear' && t('View of yourself inserted in long corners.')}
      </div>
      {k === 'corner' ? (
        <>
          <Slider name={t('Inward amount')} value={cur.gain * 100} min={0} max={150} step={5} unit="%" onChange={(x) => set({ gain: x / 100 })} />
          <Slider name={t('Maximum angle')} value={cur.max} min={0} max={90} step={1} unit="°" onChange={(x) => set({ max: x })} />
        </>
      ) : (
        <Slider
          name={k === 'side' ? t('Sideways angle') : t('Yaw')}
          value={cur.yaw}
          min={k === 'side' ? 0 : -180}
          max={180}
          step={1}
          unit="°"
          onChange={(x) => set({ yaw: x })}
        />
      )}
      <Slider name={t('Pitch')} value={cur.pitch} min={-60} max={60} step={1} unit="°" onChange={(x) => set({ pitch: x })} />
      <Slider name={t('FOV')} value={cur.fov} min={40} max={170} step={1} unit="°" onChange={(x) => set({ fov: x })} />
      <Slider name={t('Keep lean')} value={cur.leanRatio * 100} min={0} max={100} step={5} unit="%" onChange={(x) => set({ leanRatio: x / 100 })} />
      <div className="note">{t('Positive pitch looks down. Keep lean: 100% tilts with the bike, 0% stays level (the bike appears to lean).')}</div>
      <div className="row">
        <label className="rule">
          <input type="checkbox" data-action="shot-views-preview" checked={p.preview && p.canPreview} disabled={!p.canPreview} onChange={(e) => p.onPreview(e.target.checked)} /> {t('Preview')}
        </label>
        {k === 'side' && (
          <select value={p.side} onChange={(e) => p.onSide(e.target.value as 'in' | 'out')} disabled={!p.preview || !p.canPreview}>
            <option value="in">{t('③ Inside')}</option>
            <option value="out">{t('④ Outside')}</option>
          </select>
        )}
      </div>
      <div className="note">
        {p.canPreview
          ? t('Shows the current frame with this view in the selected view layer (it goes back when you close this).') + (k === 'corner' || k === 'side' ? ' ' + t('Shown for a right-hand corner at 30° lean as an example.') : '')
          : t('Open a video to preview.')}
      </div>
      <div className="row">
        <button data-action="shot-views-reset" disabled={isDefault} onClick={() => p.onChange({ ...v, [k]: structuredClone(DEFAULT_SHOT_VIEWS[k]) })}>
          {t('Reset this view')}
        </button>
        <button data-action="shot-views-reset-all" disabled={allDefault} onClick={() => p.onChange(structuredClone(DEFAULT_SHOT_VIEWS))}>
          {t('Reset all to app defaults')}
        </button>
      </div>
    </div>
  )
}
