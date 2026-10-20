import { CAUSE_NAMES } from '../core/disturb'
import { roundPeak, type IncidentEvent, type IncidentSettings } from '../engine/incident'
import { Slider } from './Slider'
import { t } from '../i18n'

interface Props {
  settings: IncidentSettings
  /** 検出した事象（除外したものも含む） */
  events: IncidentEvent[]
  /** 乱れの検出に使える車両ログがあるか */
  available: boolean
  /** メインの視点が全画面か（2 画面にできるか） */
  mainFull: boolean
  onChange: (patch: Partial<IncidentSettings>) => void
  onSeekTime: (t: number) => void
}

const fmt = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/** 車体挙動の乱れがあった時に自動で 2 画面にする設定と、検出した事象の一覧 */
export function IncidentSection(p: Props): React.JSX.Element {
  const s = p.settings
  const skip = new Set(s.skip.map(roundPeak))
  const used = p.events.filter((e) => !skip.has(roundPeak(e.peak)))
  return (
    <div className="section">
      <h3>
        {t('車体挙動の乱れ')}<span className="hint">{s.on && p.available ? t('{n} 回 2 画面に', { n: used.length }) : t('自動で 2 画面にする')}</span>
      </h3>
      <label className="rule">
        <input type="checkbox" checked={s.on} disabled={!p.available} onChange={(e) => p.onChange({ on: e.target.checked })} /> {t('乱れがあった時は 2 画面にして自車を映す')}
      </label>
      {!p.available && <div className="note status">{t('車両ログ（スリップ率・サスペンションのストローク・6 軸センサー）が必要です。')}</div>}
      {s.on && !p.mainFull && <div className="note warn">{t('メインの視点が全画面のときに働きます（今のレイアウトでは分割しません）。')}</div>}
      <div className="note">{t('スリップ率の急な変化・空転、角速度や加速度の細かい揺れ（ふらつき・振られ）、サスペンションの急な伸び縮み（突き上げ・底付き）を、その走行の中での強さで判定します。')}</div>
      <Slider name={t('しきい値')} value={s.threshold} min={1} max={3} step={0.1} unit={t('倍')} disabled={!s.on} onChange={(v) => p.onChange({ threshold: v })} />
      <div className="note">{t('1.0 倍 = その走行の上位 0.5% の強さ。小さいほど敏感になります。')}</div>
      <div className="row">
        <span className="name">{t('分け方')}</span>
        <select value={s.layout} disabled={!s.on} onChange={(e) => p.onChange({ layout: e.target.value as IncidentSettings['layout'] })}>
          <option value="lr">{t('左に前方・右に自車')}</option>
          <option value="rl">{t('左に自車・右に前方')}</option>
          <option value="tb">{t('上に前方・下に自車')}</option>
        </select>
      </div>
      <Slider name={t('前の余白')} value={s.pre} min={0} max={3} step={0.5} unit={t('秒')} disabled={!s.on} onChange={(v) => p.onChange({ pre: v })} />
      <Slider name={t('後の余白')} value={s.post} min={0} max={6} step={0.5} unit={t('秒')} disabled={!s.on} onChange={(v) => p.onChange({ post: v })} />
      <label className="rule">
        <input type="checkbox" checked={s.label} disabled={!s.on} onChange={(e) => p.onChange({ label: e.target.checked })} /> {t('自車の画面に「挙動の乱れ」を表示')}
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
                  title={t('この乱れで 2 画面にする')}
                  onChange={() => p.onChange({ skip: on ? [...s.skip, k] : s.skip.filter((x) => roundPeak(x) !== k) })}
                />
                <button className="time-btn" onClick={() => p.onSeekTime(e.start)} title={t('2 画面になる時刻へ移動')}>
                  {fmt(e.peak)}
                </button>
                <span className="kind incident">{t(CAUSE_NAMES[e.cause])}</span>
                <span className="title">{t('強さ {v} 倍', { v: e.score.toFixed(1) })}</span>
              </div>
            )
          })}
        </div>
      )}
      {s.on && <div className="note">{t('自車の画面の向き・画角は、レイヤー「自車（挙動の乱れ）」を選んで変えられます。')}</div>}
    </div>
  )
}
