import type { RecentEntry } from '../../../preload/index'
import { getLang, t } from '../i18n'
import { useLang } from './useLang'

export type RecentItem = RecentEntry & { exists: boolean; edited: boolean }

interface Props {
  items: RecentItem[]
  onOpen: (path: string) => void
  onRemove: (path: string) => void
  onOpenDialog: () => void
}

/** Read the recording date and time from the file name (VID_20260919_140847_...) */
function recordedAt(name: string): string | null {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name)
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : null
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return t('Just now')
  if (s < 3600) return t('{n} min ago', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} h ago', { n: Math.floor(s / 3600) })
  if (s < 86400 * 30) return t('{n} d ago', { n: Math.floor(s / 86400) })
  return new Date(ms).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ja-JP')
}

const dur = (sec?: number): string => {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.round(sec - m * 60)).padStart(2, '0')}`
}

/** Start screen: list of recently opened videos */
export function Recent({ items, onOpen, onRemove, onOpenDialog }: Props): React.JSX.Element {
  useLang()
  return (
    <div className="recent">
      <div className="recent-head">
        <h2>{t('Recent videos')}</h2>
        <button className="primary" onClick={onOpenDialog}>
          {t('Open…')}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="empty">
          {t('No history yet.')}
          <br />
          {t('Choose an Insta360 X6 .insv file with "Open…", or drag and drop it onto the window.')}
        </div>
      ) : (
        <div className="recent-grid">
          {items.map((it) => {
            const rec = recordedAt(it.name)
            return (
              <div
                key={it.path}
                className={'recent-card' + (it.exists ? '' : ' missing')}
                title={it.path}
                onClick={() => it.exists && onOpen(it.path)}
              >
                <div className="thumb">
                  {it.thumb ? <img src={it.thumb} alt="" /> : <span>360°</span>}
                  {it.durationSec ? <span className="dur">{dur(it.durationSec)}</span> : null}
                </div>
                <div className="meta">
                  <div className="name">{it.name}</div>
                  <div className="sub">{window.api.path.basename(window.api.path.dirname(it.path))}</div>
                  <div className="sub">
                    {rec ? t('Recorded {date}', { date: rec }) + '\u2003' : ''}
                    {it.model ?? ''}
                  </div>
                  <div className="badges">
                    {!it.exists && <span className="badge warn">{t('File not found')}</span>}
                    {it.exists && it.hasLog && <span className="badge ok">{t('Vehicle log')}</span>}
                    {it.exists && it.edited && <span className="badge">{t('Edited')}</span>}
                    <span className="when">{ago(it.openedAt)}</span>
                  </div>
                </div>
                <button
                  className="remove"
                  title={t('Remove from history (the video is not deleted)')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(it.path)
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
