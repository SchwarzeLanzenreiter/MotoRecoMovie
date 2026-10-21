// Right-hand menu: captions and place labels added by hand (core/annotations.ts)
import { labelEnd, type Caption, type PlaceLabel } from '../core/annotations'
import { t } from '../i18n'

export interface AnnotationProps {
  captions: Caption[]
  labels: PlaceLabel[]
  /** Label waiting for a click on the video: an id (placing it again), 'new', or null */
  placing: string | null
  /** Labels being followed: seconds followed so far */
  following: Record<string, number>
  layerName: (id: string) => string
  onSeekTime: (t: number) => void
  onAddCaption: () => void
  onUpdateCaption: (id: string, patch: Partial<Caption>) => void
  onRemoveCaption: (id: string) => void
  /** Wait for a click on the video for a new label (null) or to place a label again from the current time; again to cancel */
  onPlaceLabel: (id: string | null) => void
  onUpdateLabel: (id: string, patch: Partial<PlaceLabel>) => void
  onRemoveLabel: (id: string) => void
}

const fmtTime = (s: number): string => {
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

export function CaptionsSection(p: AnnotationProps): React.JSX.Element {
  const cs = [...p.captions].sort((a, b) => a.t - b.t)
  return (
    <div className="section">
      <h3>
        {t('Captions')}
        <span className="hint">{t('{n} total', { n: cs.length })}</span>
      </h3>
      <div className="row">
        <button onClick={p.onAddCaption}>{t('+ Add at playhead (T)')}</button>
      </div>
      {cs.map((c) => (
        <div key={c.id} className="marker-row caption-row">
          <button className="time-btn" onClick={() => p.onSeekTime(c.t)} title={t('Go to this time')}>
            {fmtTime(c.t)}
          </button>
          <input type="number" title={t('Seconds shown')} value={c.dur} step={0.5} min={0.5} onChange={(e) => p.onUpdateCaption(c.id, { dur: Math.max(0.5, parseFloat(e.target.value) || 0.5) })} style={{ width: 48 }} />
          <button title={t('Delete')} onClick={() => p.onRemoveCaption(c.id)}>
            ×
          </button>
          <textarea rows={Math.min(3, c.text.split('\n').length)} value={c.text} placeholder={t('Caption text')} onChange={(e) => p.onUpdateCaption(c.id, { text: e.target.value })} />
        </div>
      ))}
      {cs.length > 0 && (
        <div className="note">
          {t('Shown from that time for the given seconds. Enter starts a new line. All captions appear in the same place: move and size the "Captions" layer on the screen.')}
        </div>
      )}
    </div>
  )
}

export function LabelsSection(p: AnnotationProps): React.JSX.Element {
  const ls = [...p.labels].sort((a, b) => a.t - b.t)
  const status = (l: PlaceLabel): string => {
    const f = p.following[l.id]
    if (f !== undefined) return t('Following… {s} s', { s: Math.round(f) })
    if (!l.track) return t('Not followed')
    const end = fmtTime(labelEnd(l))
    return l.track.end === 'left' ? t('Until {time} (left the view)', { time: end }) : l.track.end === 'lost' ? t('Lost at {time}', { time: end }) : t('Until {time}', { time: end })
  }
  return (
    <div className="section">
      <h3>
        {t('Place labels')}
        <span className="hint">{t('{n} total', { n: ls.length })}</span>
      </h3>
      <div className="row">
        <button className={p.placing === 'new' ? 'on' : ''} onClick={() => p.onPlaceLabel(null)}>
          {p.placing === 'new' ? t('Click the place in the video… (Esc to cancel)') : t('+ Add, then click the place (L)')}
        </button>
      </div>
      {ls.map((l) => (
        <div key={l.id} className="marker-row label-row">
          <button className="time-btn" onClick={() => p.onSeekTime(l.t)} title={t('Go to this time')}>
            {fmtTime(l.t)}
          </button>
          <input type="text" value={l.text} placeholder={t('Place name')} onChange={(e) => p.onUpdateLabel(l.id, { text: e.target.value })} style={{ flex: 1, minWidth: 90 }} />
          <button className={p.placing === l.id ? 'on' : ''} title={t('Click the place in the video at the current time; it is followed again from there')} onClick={() => p.onPlaceLabel(l.id)}>
            {p.placing === l.id ? t('Click the place…') : t('Place again here')}
          </button>
          <button title={t('Delete')} onClick={() => p.onRemoveLabel(l.id)}>
            ×
          </button>
          <span className="note label-status">
            {p.layerName(l.layerId)} · {status(l)}
          </span>
        </div>
      ))}
      <div className="note">
        {t('Pause where the place shows, then click it in the video. The point is followed in the video until it leaves the view. If the label slips off, pause where it slipped and use "Place again here".')}
      </div>
    </div>
  )
}
