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

/** ファイル名（VID_20260919_140847_...）から撮影日時を読み取る */
function recordedAt(name: string): string | null {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name)
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : null
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return t('たった今')
  if (s < 3600) return t('{n} 分前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 時間前', { n: Math.floor(s / 3600) })
  if (s < 86400 * 30) return t('{n} 日前', { n: Math.floor(s / 86400) })
  return new Date(ms).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ja-JP')
}

const dur = (sec?: number): string => {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.round(sec - m * 60)).padStart(2, '0')}`
}

/** 起動画面: 最近開いた動画の一覧 */
export function Recent({ items, onOpen, onRemove, onOpenDialog }: Props): React.JSX.Element {
  useLang()
  return (
    <div className="recent">
      <div className="recent-head">
        <h2>{t('最近開いた動画')}</h2>
        <button className="primary" onClick={onOpenDialog}>
          {t('開く…')}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="empty">
          {t('まだ履歴はありません。')}
          <br />
          {t('Insta360 X6 の .insv を「開く…」から選ぶか、ウィンドウへドラッグ＆ドロップしてください。')}
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
                    {rec ? t('撮影 {date}', { date: rec }) + '　' : ''}
                    {it.model ?? ''}
                  </div>
                  <div className="badges">
                    {!it.exists && <span className="badge warn">{t('ファイルが見つかりません')}</span>}
                    {it.exists && it.hasLog && <span className="badge ok">{t('車両ログ')}</span>}
                    {it.exists && it.edited && <span className="badge">{t('編集あり')}</span>}
                    <span className="when">{ago(it.openedAt)}</span>
                  </div>
                </div>
                <button
                  className="remove"
                  title={t('履歴から消す（動画は消えません）')}
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
