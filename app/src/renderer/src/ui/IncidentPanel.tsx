import { CAUSE_NAMES } from '../core/disturb'
import { roundPeak, type IncidentEvent, type IncidentSettings } from '../engine/incident'
import { Slider } from './Slider'
import { t } from '../i18n'

interface Props {
  settings: IncidentSettings
  /** Detected events (including excluded ones) */
  events: IncidentEvent[]
  /** Whether a vehicle log usable for disturbance detection is loaded */
  available: boolean
  /** Whether the main view is full screen (i.e. can be split into 2 screens) */
  mainFull: boolean
  onChange: (patch: Partial<IncidentSettings>) => void
  onSeekTime: (t: number) => void
}

const fmt = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/** Setting to split into 2 screens automatically when a bike disturbance occurs, and the list of detected events */
export function IncidentSection(p: Props): React.JSX.Element {
  const s = p.settings
  const skip = new Set(s.skip.map(roundPeak))
  const used = p.events.filter((e) => !skip.has(roundPeak(e.peak)))
  return (
    <div className="section">
      <h3>
        {t('Chassis disturbance')}<span className="hint">{s.on && p.available ? t('Split screen {n} times', { n: used.length }) : t('Auto split screen')}</span>
      </h3>
      <label className="rule">
        <input type="checkbox" checked={s.on} disabled={!p.available} onChange={(e) => p.onChange({ on: e.target.checked })} /> {t('On a disturbance, split the screen and show own bike')}
      </label>
      {!p.available && <div className="note status">{t('Requires a vehicle log (slip ratio, suspension stroke, 6-axis sensor).')}</div>}
      {s.on && !p.mainFull && <div className="note warn">{t('Works only when the main view is full screen (the current layout will not split).')}</div>}
      <div className="note">{t('Detects sudden slip ratio changes and wheelspin, fine shakes in angular velocity and acceleration (wobble, weave), and sudden suspension movement (kicks, bottoming out), judged by their strength within this ride.')}</div>
      <Slider name={t('Threshold')} value={s.threshold} min={1} max={3} step={0.1} unit={t('×')} disabled={!s.on} onChange={(v) => p.onChange({ threshold: v })} />
      <div className="note">{t('1.0× = the top 0.5% strength in this ride. Lower is more sensitive.')}</div>
      <div className="row">
        <span className="name">{t('Split')}</span>
        <select value={s.layout} disabled={!s.on} onChange={(e) => p.onChange({ layout: e.target.value as IncidentSettings['layout'] })}>
          <option value="lr">{t('Ahead left, own bike right')}</option>
          <option value="rl">{t('Own bike left, ahead right')}</option>
          <option value="tb">{t('Ahead top, own bike bottom')}</option>
        </select>
      </div>
      <Slider name={t('Lead-in')} value={s.pre} min={0} max={3} step={0.5} unit={t('s')} disabled={!s.on} onChange={(v) => p.onChange({ pre: v })} />
      <Slider name={t('Lead-out')} value={s.post} min={0} max={6} step={0.5} unit={t('s')} disabled={!s.on} onChange={(v) => p.onChange({ post: v })} />
      <label className="rule">
        <input type="checkbox" checked={s.label} disabled={!s.on} onChange={(e) => p.onChange({ label: e.target.checked })} /> {t('Show "Disturbance" on the own bike view')}
      </label>
      {s.on && p.available && (
        <div className="event-list">
          {p.events.map((e) => {
            const k = roundPeak(e.peak)
            const on = !skip.has(k)
            return (
              <div key={k} className={'event-row' + (on ? '' : ' off')}>
                <input
                  type="checkbox"
                  checked={on}
                  title={t('Split screen for this disturbance')}
                  onChange={() => p.onChange({ skip: on ? [...s.skip, k] : s.skip.filter((x) => roundPeak(x) !== k) })}
                />
                <button className="time-btn" onClick={() => p.onSeekTime(e.start)} title={t('Go to the split-screen start')}>
                  {fmt(e.peak)}
                </button>
                <span className="kind incident">{t(CAUSE_NAMES[e.cause])}</span>
                <span className="title">{t('Strength {v}×', { v: e.score.toFixed(1) })}</span>
              </div>
            )
          })}
        </div>
      )}
      {s.on && <div className="note">{t('To change the own bike view\'s direction and FOV, select the layer "Own bike (disturbance)".')}</div>}
    </div>
  )
}
