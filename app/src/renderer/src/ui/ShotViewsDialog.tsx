// 設定メニュー「自動生成の視点」: キーフレームの自動生成で切り替える 4 つの視点（前方・コーナー入口・側方・後方）の既定値。
// 選んでいる視点は、プレビューの画面（選んでいる視点レイヤー）にそのまま映す。アプリの既定値へはボタン 1 つで戻せる
import { DEFAULT_SHOT_VIEWS, SHOT_VIEW_KINDS, type ShotViewKind, type ShotViews } from '../engine/director'
import { t } from '../i18n'
import { KEY_COLORS, KEY_TAG_NAMES } from './keyColors'
import { Slider } from './Slider'
import { useLang } from './useLang'

interface Props {
  views: ShotViews
  onChange: (v: ShotViews) => void
  /** 設定している視点（プレビューに映す） */
  kind: ShotViewKind
  onKind: (k: ShotViewKind) => void
  /** 側方のプレビュー: ③ 内側 / ④ 外側 */
  side: 'in' | 'out'
  onSide: (s: 'in' | 'out') => void
  /** プレビューに映す（動画を開いているとき） */
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
        <h3>{t('自動生成の視点')}</h3>
        <button className="mini" data-action="shot-views-close" onClick={p.onClose} title={t('閉じる')}>
          ✕
        </button>
      </div>
      <div className="note">{t('「キーフレームを自動生成」で切り替える視点の既定値です。このパソコンに覚え、次の自動生成から使います（今あるキーフレームは変わりません）。')}</div>
      <div className="seg shot-kinds">
        {SHOT_VIEW_KINDS.map((x) => (
          <button key={x} data-kind={x} className={x === k ? 'on' : ''} onClick={() => p.onKind(x)}>
            <span className="swatch" style={{ background: KEY_COLORS[x] }} />
            {t(KEY_TAG_NAMES[x])}
          </button>
        ))}
      </div>
      <div className="note">
        {k === 'front' && t('基本の視点です。減速・加速・停止・巡航の景色は、これを元に少し変えます。')}
        {k === 'corner' && t('コーナーに入るとき、前方の向きからリーン角 × 内側への量だけ内側を向きます（最大の角度まで）。')}
        {k === 'side' && t('長いコーナーで挟む真横の視点です。コーナーの内側（③）と外側（④）へ、この角度だけ横を向きます。')}
        {k === 'rear' && t('長いコーナーで挟む、自分を映す視点です。')}
      </div>
      {k === 'corner' ? (
        <>
          <Slider name={t('内側への量')} value={cur.gain * 100} min={0} max={150} step={5} unit="%" onChange={(x) => set({ gain: x / 100 })} />
          <Slider name={t('最大の角度')} value={cur.max} min={0} max={90} step={1} unit="°" onChange={(x) => set({ max: x })} />
        </>
      ) : (
        <Slider
          name={k === 'side' ? t('横への向き') : t('ヨー')}
          value={cur.yaw}
          min={k === 'side' ? 0 : -180}
          max={180}
          step={1}
          unit="°"
          onChange={(x) => set({ yaw: x })}
        />
      )}
      <Slider name={t('ピッチ')} value={cur.pitch} min={-60} max={60} step={1} unit="°" onChange={(x) => set({ pitch: x })} />
      <Slider name={t('画角')} value={cur.fov} min={40} max={170} step={1} unit="°" onChange={(x) => set({ fov: x })} />
      <Slider name={t('傾きを残す')} value={cur.leanRatio * 100} min={0} max={100} step={5} unit="%" onChange={(x) => set({ leanRatio: x / 100 })} />
      <div className="note">{t('ピッチは＋で下向き。傾きを残す: 100% は車体と一緒に傾き、0% は水平のまま（バイクが倒れて見えます）。')}</div>
      <div className="row">
        <label className="rule">
          <input type="checkbox" data-action="shot-views-preview" checked={p.preview && p.canPreview} disabled={!p.canPreview} onChange={(e) => p.onPreview(e.target.checked)} /> {t('プレビュー')}
        </label>
        {k === 'side' && (
          <select value={p.side} onChange={(e) => p.onSide(e.target.value as 'in' | 'out')} disabled={!p.preview || !p.canPreview}>
            <option value="in">{t('③ 内側')}</option>
            <option value="out">{t('④ 外側')}</option>
          </select>
        )}
      </div>
      <div className="note">
        {p.canPreview
          ? t('選んでいる視点レイヤーに、今のコマをこの視点で映します（閉じると元に戻ります）。') + (k === 'corner' || k === 'side' ? ' ' + t('例として、リーン角 30° の右コーナーで見せます。') : '')
          : t('動画を開くとプレビューできます。')}
      </div>
      <div className="row">
        <button data-action="shot-views-reset" disabled={isDefault} onClick={() => p.onChange({ ...v, [k]: structuredClone(DEFAULT_SHOT_VIEWS[k]) })}>
          {t('この視点を既定値に戻す')}
        </button>
        <button data-action="shot-views-reset-all" disabled={allDefault} onClick={() => p.onChange(structuredClone(DEFAULT_SHOT_VIEWS))}>
          {t('すべてアプリの既定値に戻す')}
        </button>
      </div>
    </div>
  )
}
