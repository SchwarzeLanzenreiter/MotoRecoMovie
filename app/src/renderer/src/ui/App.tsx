import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { layerName } from './layerName'
import './styles.css'
import { isDatPath, Session, type LogInfo } from '../engine/session'
import { bodyKey, buildBodyTrack, loadBodyTrack, saveBodyTrack } from '../engine/bodymap'
import { buildFxAudio, fxAudioKey } from '../engine/audiofx'
import { OVERTAKE_SCAN_VERSION } from '../core/overtake'
import { applySettings, parseSettings, settingsFromProject, SETTINGS_EXT } from '../engine/settings-file'
import { loadLogPrefs, saveLogPrefs, type LogPrefs } from '../engine/logprefs'
import { findLayer, migrateProject, shiftProjectTimes, newProject, viewAt, viewLayers, type Keyframe, type Layer, type Project, type Rect, type ViewLayer, type WidgetKind } from '../engine/project'
import type { Player, PlayerStatus } from '../engine/player'
import type { Telemetry } from '../core/telemetry'
import { addKey, addOverlayLayer, addViewLayer, editView, keyIndex, keyTolerance, moveLayer, removeKey, removeLayer, updateLayer, type ViewPatch } from '../engine/edit'
import { exportVideo, type ExportProgress } from '../engine/exporter'
import { applyTemplate } from '../engine/layout'
import { newViewLayer } from '../engine/project'
import { generateKeyframes, shotPreviewView, type DirectorSettings, type Marker, type ShotViewKind, type ShotViews } from '../engine/director'
import { loadShotViews, saveShotViews } from '../engine/shotprefs'
import { ShotViewsDialog } from './ShotViewsDialog'
import { incidentEvents, RIDER_VIEW, type IncidentSettings } from '../engine/incident'
import { DEFAULT_BORDER, isFull } from '../engine/layout'
import { newId } from '../engine/project'
import { defaultWidgetRect, WIDGET_NAMES } from '../render/overlay'
import { Viewer } from './Viewer'
import { Timeline } from './Timeline'
import { SidePanel } from './SidePanel'
import { Recent, type RecentItem } from './Recent'
import { useLang } from './useLang'
import { getLang, setLang, t, type Lang } from '../i18n'

const projectPathFor = (insv: string): string => insv + '.motorecomovie.json'

/** テレメトリーの車速の、時刻 a〜b [s] の平均 [km/h]（車速が無ければ undefined） */
function meanSpeed(tel: Telemetry | null, a: number, b: number): number | undefined {
  const sp = tel?.channels.speed
  if (!tel || !sp) return undefined
  let s = 0
  let n = 0
  for (let i = Math.max(0, Math.floor(a * tel.rate)); i <= Math.min(sp.length - 1, Math.ceil(b * tel.rate)); i++) {
    if (!Number.isFinite(sp[i])) continue
    s += sp[i]
    n++
  }
  return n ? s / n : undefined
}
/** 前の名前（Insta360 Reframe）のときの編集内容。新しい名前のものが無ければこちらを読む（保存は新しい名前へ） */
const legacyProjectPathFor = (insv: string): string => insv + '.reframe.json'

const fmt = (s: number): string => {
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

/** 新しいレイヤーの既定の位置（右下の小窓） */
const PIP: Rect = { x: 0.66, y: 0.04, w: 0.3, h: 0.3 }

/** 言語の選択肢（それぞれの言語で書いた名前） */
const LANG_NAMES: [Lang, string][] = [['ja', '日本語'], ['en', 'English']] // i18n-ignore
/** 自動テスト用の状態で、非表示のレイヤーに付ける印（画面には出さない） */
const HIDDEN_MARK = '(非表示)' // i18n-ignore

/** タイムラインの高さ [px]（既定と最小） */
const TIMELINE_DEFAULT = 150
const TIMELINE_MIN = 90

export function App(): React.JSX.Element {
  const lang = useLang()
  // メインメニューも画面の言語にそろえる
  useEffect(() => {
    void window.api.setMenuLang(lang)
  }, [lang])
  const [session, setSession] = useState<Session | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [log, setLog] = useState<LogInfo | null>(null)
  // .dat の変換規則（.ddf）と .dat を探すフォルダ（このパソコンに覚えておく）
  const [logPrefs, setLogPrefsState] = useState<LogPrefs>(loadLogPrefs)
  // 自動生成の視点の既定値（このパソコンに覚える）と、それを変える設定の画面（開いている間は選んだ視点をプレビューに映す）
  const [shotViews, setShotViewsState] = useState<ShotViews>(loadShotViews)
  const setShotViews = (v: ShotViews): void => {
    setShotViewsState(v)
    saveShotViews(v)
  }
  const [shotDlg, setShotDlg] = useState<{ kind: ShotViewKind; side: 'in' | 'out'; preview: boolean } | null>(null)
  const setLogPrefs = (patch: Partial<LogPrefs>): LogPrefs => {
    const v = { ...loadLogPrefs(), ...patch }
    saveLogPrefs(v)
    setLogPrefsState(v)
    return v
  }
  const [status, setStatus] = useState<PlayerStatus>({ frame: 0, playing: false, fps: 0, correctionDeg: 0, leanDeg: null, views: [] })
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState<ExportProgress | null>(null)
  const [saved, setSaved] = useState(true)
  const [muted, setMuted] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentItem[]>([])
  const refreshRecent = useCallback(() => {
    window.api.recent.list().then(setRecent, () => setRecent([]))
  }, [])
  useEffect(refreshRecent, [refreshRecent])
  // 数秒で消える控えめな通知（操作を止めない）
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(id)
  }, [toast])
  const player = useRef<Player | null>(null)
  const abort = useRef<AbortController | null>(null)
  const sessionRef = useRef<Session | null>(null)

  const showError = useCallback((e: unknown) => {
    console.error(e)
    setError(e instanceof Error ? e.message : String(e))
  }, [])

  // 選択中のレイヤー。視点の編集とタイムラインのキーフレームは「選択中の視点レイヤー」が対象
  const selLayer: Layer | undefined = project ? (findLayer(project, selected) ?? viewLayers(project)[0]) : undefined
  const selView: ViewLayer | undefined = selLayer?.type === 'view' ? selLayer : project ? viewLayers(project)[0] : undefined
  const selViewRef = useRef<string | null>(null)
  selViewRef.current = selView?.id ?? null

  // ---- ファイルを開く ----
  const openInsv = useCallback(
    async (path: string) => {
      try {
        setLoading(t('読み込んでいます'))
        await closeRef.current()
        let proj = newProject(path)
        let pp = projectPathFor(path)
        if (!(await window.api.exists(pp)) && (await window.api.exists(legacyProjectPathFor(path)))) pp = legacyProjectPathFor(path)
        if (await window.api.exists(pp)) {
          try {
            proj = migrateProject(JSON.parse(await window.api.readText(pp)), path)
          } catch {
            /* 壊れたプロジェクトは無視して新規にする */
          }
        }
        const s = await Session.open(path, proj.stab, setLoading)
        // 以前の版で保存したプロジェクトの時刻を、今の動画時刻に直す（X5・分割の 2 本目以降の動画で、記録の時刻がずれていた）
        if (proj.timeBase !== 1) {
          if (s.legacyTimeShiftSec) console.log(`プロジェクトの時刻を ${s.legacyTimeShiftSec.toFixed(3)} 秒ずらしました（以前の版の時刻の基準）`)
          proj = { ...shiftProjectTimes(proj, s.legacyTimeShiftSec), timeBase: 1 }
        }
        // レンズの継ぎ目の合わせ込み: まだ推定していなければ、開いた後に裏で推定して反映・保存する
        const needSeam = proj.stab.seam === undefined
        // 車両ログ: プロジェクトに記録があればそれ、無ければ同じフォルダの CSV、
        // それも無ければ .dat のフォルダ（設定してあれば）から映像に合うものを探す
        const prefs = loadLogPrefs()
        let logPath = proj.logPath && (await window.api.exists(proj.logPath)) ? proj.logPath : await Session.findLog(path)
        if (!logPath && prefs.datFolder && prefs.ddfPath && (await window.api.exists(prefs.datFolder))) {
          try {
            logPath = (await s.findDat(prefs.datFolder, prefs.ddfPath, setLoading))?.path ?? null
          } catch (e) {
            console.warn('.dat の自動選択に失敗', e)
          }
        }
        let info: LogInfo | null = null
        if (logPath) {
          try {
            const ddf = isDatPath(logPath) ? (proj.ddfPath && (await window.api.exists(proj.ddfPath)) ? proj.ddfPath : prefs.ddfPath) : null
            info = await s.loadLog(logPath, ddf, setLoading)
            if (info.sync.peakRatio < 1.5) {
              setMessage(t('車両ログ {file} は映像と同期できませんでした（別の走行のログかもしれません）。', { file: window.api.path.basename(logPath) }))
              info = null
              logPath = null
              s.clearLog()
            }
          } catch (e) {
            setMessage(t('車両ログを読み込めませんでした: {msg}', { msg: e instanceof Error ? e.message : String(e) }))
            logPath = null
          }
        }
        // 車両ログが無くても画角の自動切り替え・浮遊標識・水平の補正が動くよう、動画の IMU から推定しておく
        //（ログがあっても、ログを無効にしたときに使う。精度はログより落ちる）
        try {
          setLoading(t('動画の動きから走行状態を推定しています'))
          await s.loadImuTelemetry()
        } catch (e) {
          console.warn('動画の IMU からの推定に失敗', e)
        }
        proj = { ...proj, logPath, ddfPath: info?.ddfPath ?? null }
        s.setLogEnabled(proj.logEnabled)
        sessionRef.current = s
        setSession(s)
        setLog(info)
        setProject(proj)
        await window.api.recent.add({
          path,
          name: window.api.path.basename(path),
          openedAt: Date.now(),
          durationSec: s.frameCount / s.fps,
          model: s.meta.model,
          hasLog: !!info
        })
        thumbPending.current = path
        hist.current = { past: [], future: [], last: 0 }
        setSelected(viewLayers(proj)[0]?.id ?? null)
        setSaved(true)
        if (needSeam) void estimateSeamFor(s, false)
      } catch (e) {
        showError(e)
      } finally {
        setLoading(null)
        refreshRecent()
      }
    },
    [showError, refreshRecent]
  )

  // ---- 履歴のサムネイル（プレビューを縮小して保存）----
  const thumbPending = useRef<string | null>(null)
  const saveThumb = async (): Promise<void> => {
    const path = sessionRef.current ? projectRef.current?.insvPath : null
    const c = document.querySelector('.viewer canvas') as HTMLCanvasElement | null
    if (!path || !c || !c.width) return
    const w = 320
    const h = Math.round((w * c.height) / c.width)
    const tc = document.createElement('canvas')
    tc.width = w
    tc.height = h
    tc.getContext('2d')!.drawImage(c, 0, 0, w, h)
    await window.api.recent.update(path, { thumb: tc.toDataURL('image/jpeg', 0.72) }).catch(() => undefined)
    refreshRecent()
  }
  // 開いて最初のフレームが表示されたら撮る
  useEffect(() => {
    if (!thumbPending.current || !session || status.playing) return
    const id = setTimeout(() => {
      if (thumbPending.current) {
        thumbPending.current = null
        void saveThumb()
      }
    }, 600)
    return () => clearTimeout(id)
  }, [status.frame, session]) // eslint-disable-line react-hooks/exhaustive-deps
  // 閉じるときも、作業していた場面で更新する（できる範囲で）
  useEffect(() => {
    const h = (): void => void saveThumb()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  })

  // ---- 閉じて起動画面（履歴）へ戻る ----
  const closeVideo = async (): Promise<void> => {
    // 自動保存の待ち時間中なら、すぐに保存してから閉じる
    if (project && !saved) {
      await window.api.writeText(projectPathFor(project.insvPath), JSON.stringify(project, null, 2)).catch(showError)
      setSaved(true)
    }
    await saveThumb()
    player.current?.pause()
    await sessionRef.current?.close()
    sessionRef.current = null
    setSession(null)
    setProject(null)
    setLog(null)
    setSelected(null)
    refreshRecent()
  }
  const closeRef = useRef(closeVideo)
  closeRef.current = closeVideo

  const openDialog = async (): Promise<void> => {
    const r = await window.api.openDialog({ title: t('.insv を開く'), filters: [{ name: t('Insta360 動画'), extensions: ['insv'] }], properties: ['openFile'] })
    if (r?.[0]) await openInsv(r[0])
  }

  // ---- 設定ファイル（右側の設定とメーターなどの位置。ほかの動画でも使える）----
  const saveSettings = async (outPath?: string): Promise<void> => {
    if (!project) return
    const base = window.api.path.basename(project.insvPath).replace(/\.insv$/i, '')
    const out = outPath ?? await window.api.saveDialog({
      title: t('設定を保存'),
      defaultPath: window.api.path.join(window.api.path.dirname(project.insvPath), `${base}${SETTINGS_EXT}`),
      filters: [{ name: t('MotoRecoMovie の設定'), extensions: ['json'] }]
    })
    if (!out) return
    try {
      await window.api.writeText(out, JSON.stringify(settingsFromProject(project), null, 2))
      setToast(t('設定を保存しました: {file}', { file: window.api.path.basename(out) }))
    } catch (e) {
      showError(e)
    }
  }
  const loadSettings = async (inPath?: string): Promise<void> => {
    if (!project) return
    const r = inPath ? [inPath] : await window.api.openDialog({
      title: t('設定を読み込む'),
      defaultPath: window.api.path.dirname(project.insvPath),
      filters: [{ name: t('MotoRecoMovie の設定'), extensions: ['json'] }],
      properties: ['openFile']
    })
    if (!r?.[0]) return
    try {
      const s = parseSettings(await window.api.readText(r[0]))
      const next = applySettings(project, s, (a, b) => layerName(a) === layerName(b))
      updateProject(next)
      // 選んでいたレイヤーが無くなっていれば、先頭の視点レイヤーを選ぶ
      if (!next.layers.some((l) => l.id === selected)) setSelected(next.layers.find((l) => l.type === 'view')?.id ?? null)
      setToast(t('設定を読み込みました: {file}（Ctrl+Z で元に戻せます）', { file: window.api.path.basename(r[0]) }))
    } catch (e) {
      showError(e)
    }
  }

  /** 変換規則（.ddf）を選ぶ。選ばなければ null */
  const pickDdf = async (): Promise<string | null> => {
    const logPrefs = loadLogPrefs()
    const r = await window.api.openDialog({
      title: t('変換規則（.ddf）を選ぶ'),
      defaultPath: logPrefs.ddfPath ? window.api.path.dirname(logPrefs.ddfPath) : logPrefs.datFolder ?? undefined,
      filters: [{ name: t('MotoRecoViewer の変換規則'), extensions: ['ddf'] }],
      properties: ['openFile']
    })
    if (!r?.[0]) return null
    setLogPrefs({ ddfPath: r[0] })
    return r[0]
  }

  /** ログを読み込んで使う（CSV、または .dat を ddf の規則でデコード） */
  const useLogFile = async (path: string, ddf: string | null): Promise<void> => {
    if (!session || !project) return
    try {
      setLoading(t('ログを読み込んでいます'))
      const info = await session.loadLog(path, ddf, setLoading)
      if (info.sync.peakRatio < 1.5) setMessage(t('このログは映像とうまく同期できませんでした。結果を確認してください。'))
      setLog(info)
      updateProject({ ...project, logPath: path, ddfPath: info.ddfPath, logEnabled: true })
      session.setLogEnabled(true)
      player.current?.redraw()
    } catch (e) {
      showError(e)
    } finally {
      setLoading(null)
    }
  }

  const loadLogDialog = async (): Promise<void> => {
    if (!session || !project) return
    const logPrefs = loadLogPrefs()
    const r = await window.api.openDialog({
      title: t('MotoReco のログを開く'),
      defaultPath: logPrefs.datFolder ?? window.api.path.dirname(project.insvPath),
      filters: [{ name: t('MotoReco のログ（.dat・CSV）'), extensions: ['dat', 'csv'] }],
      properties: ['openFile']
    })
    if (!r?.[0]) return
    let ddf: string | null = null
    if (isDatPath(r[0])) {
      ddf = logPrefs.ddfPath && (await window.api.exists(logPrefs.ddfPath)) ? logPrefs.ddfPath : await pickDdf()
      if (!ddf) return
    }
    await useLogFile(r[0], ddf)
  }

  /** 変換規則を変える。今のログが .dat なら、新しい規則で読み直す */
  const changeDdf = async (): Promise<void> => {
    const ddf = await pickDdf()
    if (ddf && log && isDatPath(log.path)) await useLogFile(log.path, ddf)
  }

  /** .dat のフォルダから、映像に合うものを探して読み込む */
  const findDatInFolder = async (pickFolder: boolean): Promise<void> => {
    if (!session || !project) return
    const logPrefs = loadLogPrefs()
    setLogPrefsState(logPrefs)
    let folder = logPrefs.datFolder
    if (pickFolder || !folder || !(await window.api.exists(folder))) {
      const r = await window.api.openDialog({ title: t('MotoReco の .dat のフォルダを選ぶ'), defaultPath: folder ?? undefined, properties: ['openDirectory'] })
      if (!r?.[0]) return
      folder = r[0]
      setLogPrefs({ datFolder: folder })
    }
    const ddf = logPrefs.ddfPath && (await window.api.exists(logPrefs.ddfPath)) ? logPrefs.ddfPath : await pickDdf()
    if (!ddf) return
    let found: { path: string; peakRatio: number } | null = null
    try {
      setLoading(t('映像に合う車両ログを探しています'))
      found = await session.findDat(folder, ddf, setLoading)
    } catch (e) {
      showError(e)
    } finally {
      setLoading(null)
    }
    if (!found) {
      setMessage(t('フォルダ {folder} に、この映像に合う .dat が見つかりませんでした。', { folder: window.api.path.basename(folder) }))
      return
    }
    await useLogFile(found.path, ddf)
  }

  // ---- プロジェクトの更新・元に戻す・自動保存 ----
  // 変更のたびに直前の状態を履歴に積む。0.5 秒以内に続いた変更（ドラッグなど）は1回分にまとめる
  const hist = useRef<{ past: Project[]; future: Project[]; last: number }>({ past: [], future: [], last: 0 })
  const record = (prev: Project): void => {
    const h = hist.current
    const now = performance.now()
    if (now - h.last > 500) {
      h.past.push(prev)
      if (h.past.length > 200) h.past.shift()
    }
    h.last = now
    h.future = []
  }
  const updateProject = useCallback((p: Project) => {
    setProject((prev) => {
      if (prev && prev !== p) record(prev)
      return p
    })
    setSaved(false)
  }, [])
  /** 最新の状態に対して変更を適用する（連続した操作で古い状態を上書きしないように） */
  const apply = useCallback((f: (p: Project) => Project) => {
    setProject((p) => {
      if (!p) return p
      const next = f(p)
      if (next !== p) record(p)
      return next
    })
    setSaved(false)
  }, [])
  const undo = useCallback(() => {
    setProject((cur) => {
      const h = hist.current
      const prev = h.past.pop()
      if (!prev || !cur) return cur
      h.future.push(cur)
      h.last = 0
      return prev
    })
    setSaved(false)
  }, [])
  const redo = useCallback(() => {
    setProject((cur) => {
      const h = hist.current
      const next = h.future.pop()
      if (!next || !cur) return cur
      h.past.push(cur)
      h.last = 0
      return next
    })
    setSaved(false)
  }, [])
  useEffect(() => {
    if (!project || saved) return
    const id = setTimeout(async () => {
      try {
        await window.api.writeText(projectPathFor(project.insvPath), JSON.stringify(project, null, 2))
        setSaved(true)
      } catch (e) {
        showError(e)
      }
    }, 800)
    return () => clearTimeout(id)
  }, [project, saved, showError])

  // ログの有効・無効をリーン角とテレメトリー表示に反映
  useEffect(() => {
    if (!session || !project) return
    session.setLogEnabled(project.logEnabled)
    player.current?.setTelemetry(session.telemetry(project.logEnabled))
  }, [project?.logEnabled, session, log]) // eslint-disable-line react-hooks/exhaustive-deps

  const time = session ? session.motion.videoTime(Math.min(status.frame, session.frameCount - 1)) : 0
  // 「このコマのキーフレーム」とみなす時間差（コマの間隔の 0.6 倍。自動生成のキーフレームはコマの区切りに乗っていないため）
  const keyTol = session ? keyTolerance(session.fps) : undefined
  const hasKeyHere = selView ? keyIndex(selView.keyframes, time, keyTol) >= 0 : false

  const currentTime = (): number => (sessionRef.current ? sessionRef.current.motion.videoTime(player.current?.status.frame ?? 0) : 0)

  const onEditView = useCallback(
    (patch: ViewPatch | ((cur: Omit<Keyframe, 't'>) => ViewPatch), layerId?: string) => {
      const id = layerId ?? selViewRef.current
      if (!id) return
      const s = sessionRef.current
      apply((p) => editView(p, id, currentTime(), patch, s ? keyTolerance(s.fps) : undefined))
    },
    [apply]
  )

  const seek = useCallback((f: number) => player.current?.seek(f), [])
  const toggleMute = (): void => {
    setMuted((m) => {
      player.current?.setMuted(!m)
      return !m
    })
  }
  const togglePlay = (): void => {
    const p = player.current
    if (!p) return
    if (p.isPlaying) p.pause()
    else p.play()
  }

  // ---- レイヤー操作 ----
  // 追加は常に最新の状態に対して行う（続けて追加しても前の追加を上書きしないように）
  const addView = (): void => {
    const now = currentTime()
    const fromId = selViewRef.current
    apply((p) => {
      const from = viewLayers(p).find((l) => l.id === fromId) ?? viewLayers(p)[0]
      const next = addViewLayer(p, t('視点 {n}', { n: viewLayers(p).length + 1 }), PIP, now, from)
      setSelected(next.layers[next.layers.length - 1].id)
      return next
    })
  }
  const addOverlay = (w: WidgetKind): void => {
    apply((p) => {
      const next = addOverlayLayer(p, w, t(WIDGET_NAMES[w]), defaultWidgetRect(w, p.export.width / p.export.height))
      setSelected(next.layers[next.layers.length - 1].id)
      return next
    })
  }

  // ---- 注目ポイントと画角の自動切り替え ----
  const addMarker = (): void => {
    const now = currentTime()
    apply((p) => ({ ...p, markers: [...p.markers, { id: newId(), t: now, yaw: 90, pitch: 0, fov: 90, hold: 4 }] }))
  }
  const updateMarker = (id: string, patch: Partial<Marker>): void => apply((p) => ({ ...p, markers: p.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))
  const removeMarker = (id: string): void => apply((p) => ({ ...p, markers: p.markers.filter((m) => m.id !== id) }))
  const updateDirector = (d: DirectorSettings): void => apply((p) => ({ ...p, director: d }))

  // ---- レンズの継ぎ目の合わせ込み（裏で推定して反映する）----
  const [seamBusy, setSeamBusy] = useState(false)
  async function estimateSeamFor(s: Session, manual: boolean): Promise<void> {
    setSeamBusy(true)
    try {
      const r = await s.estimateSeam()
      console.log(`継ぎ目の合わせ込み 回転 [${r.fix.rot.map((v) => v.toFixed(2)).join(', ')}]° 縁 ${r.fix.edge.toFixed(2)}°  重なり帯の差 ${r.before.toFixed(3)} → ${r.after.toFixed(3)}`)
      if (sessionRef.current !== s) return // 推定中に別の動画を開いた
      apply((p) => ({ ...p, stab: { ...p.stab, seam: r.fix, ...(manual && { seamFix: true }) } }))
      setToast(
        t('レンズの継ぎ目を合わせました（縁の角度 {edge}°・回転 {rot}°、重なり帯の差 {before} → {after}）。', {
          edge: r.fix.edge.toFixed(1),
          rot: Math.hypot(...r.fix.rot).toFixed(1),
          before: r.before.toFixed(3),
          after: r.after.toFixed(3)
        })
      )
    } catch (e) {
      console.warn('継ぎ目の合わせ込みを推定できませんでした', e)
      if (sessionRef.current === s && !manual) apply((p) => ({ ...p, stab: { ...p.stab, seam: null } }))
      if (manual) showError(e)
    } finally {
      setSeamBusy(false)
    }
  }
  const reestimateSeam = (): void => {
    if (session) void estimateSeamFor(session, true)
  }

  // ---- 自車の継ぎ目の型（engine/bodymap.ts。AI で裏で作り、動画の横に保存する）----
  // 型はレンズの補正（継ぎ目の合わせ込み）で変わるので、合わせ込みが決まってから作る
  const [bodyStatus, setBodyStatus] = useState<{ busy: boolean; frac: number; msg: string } | null>(null)
  const bodyJob = useRef<{ s: Session; key: string; signal: { aborted: boolean } } | null>(null)
  async function prepareBody(s: Session, rebuild: boolean): Promise<void> {
    const p = projectRef.current
    if (!p) return
    s.applySeam(p.stab)
    const kind = p.stab.bodyInpaint ?? 'lama'
    const key = bodyKey(s) + '|' + kind
    if (bodyJob.current && bodyJob.current.s === s && bodyJob.current.key === key && !rebuild) return
    if (bodyJob.current) bodyJob.current.signal.aborted = true
    const job = { s, key, signal: { aborted: false } }
    bodyJob.current = job
    s.body = null
    player.current?.redraw()
    if (!rebuild) {
      const tr = await loadBodyTrack(s)
      if (bodyJob.current !== job) return
      if (tr) {
        s.body = tr
        setBodyStatus(null)
        player.current?.redraw()
        return
      }
    }
    setBodyStatus({ busy: true, frac: 0, msg: t('自車の継ぎ目を作っています') })
    try {
      // 確認用（自動テストの bodyRange）: 作る範囲を限る
      const range = (globalThis as { __bodyRange?: [number, number] }).__bodyRange
      const tr = await buildBodyTrack(s, { inpaint: kind, signal: job.signal, from: range?.[0], to: range?.[1] }, (frac, msg) => {
        if (bodyJob.current === job) setBodyStatus({ busy: true, frac, msg })
      })
      if (bodyJob.current !== job) return
      s.body = tr
      await saveBodyTrack(s, tr)
      setBodyStatus(null)
      player.current?.redraw()
      setToast(t('自車の継ぎ目を作りました（トップケースなどカメラと一緒に動く物を、区間ごとに AI で合わせました）。'))
    } catch (e) {
      if (bodyJob.current !== job || job.signal.aborted) return
      console.warn('自車の継ぎ目を作れませんでした', e)
      setBodyStatus({ busy: false, frac: 0, msg: t('自車の継ぎ目を作れませんでした: {msg}', { msg: e instanceof Error ? e.message : String(e) }) })
    }
  }
  useEffect(() => {
    if (!session || !project || seamBusy || project.stab.seam === undefined || project.stab.bodyStitch !== true) return
    void prepareBody(session, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, seamBusy, project?.stab.seam, project?.stab.seamFix, project?.stab.bodyStitch, project?.stab.bodyInpaint])
  // 動画を閉じたら、作りかけの型を止める
  useEffect(() => {
    if (!session && bodyJob.current) {
      bodyJob.current.signal.aborted = true
      bodyJob.current = null
      setBodyStatus(null)
    }
  }, [session])
  const rebuildBody = (): void => {
    if (session) void prepareBody(session, true)
  }

  // ---- 走行中の音を整える（engine/audiofx.ts。裏で作り、アプリのキャッシュに置く）----
  // 設定を変えたら、できるまでは動画の音声のまま鳴らす
  const [audioStatus, setAudioStatus] = useState<{ busy: boolean; frac: number; msg: string } | null>(null)
  const audioJob = useRef<{ s: Session; key: string; signal: { aborted: boolean } } | null>(null)
  useEffect(() => {
    const s = session
    const fx = project?.audioFx
    if (!s || !fx) return
    if (!fx.on || !s.audioTrack) {
      if (audioJob.current) audioJob.current.signal.aborted = true
      audioJob.current = null
      setAudioStatus(null)
      if (s.fxAudio) void s.setFxAudio(null).then(() => player.current?.updateAudioSource())
      return
    }
    const key = fxAudioKey(s, fx)
    if (s.fxAudio?.key === key || (audioJob.current?.s === s && audioJob.current.key === key)) return
    if (audioJob.current) audioJob.current.signal.aborted = true
    const job = { s, key, signal: { aborted: false } }
    audioJob.current = job
    // 設定を続けて動かしたときに何度も作り直さないよう、少し待ってから
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (s.fxAudio) {
            await s.setFxAudio(null)
            player.current?.updateAudioSource()
          }
          const a = await buildFxAudio(s, fx, (frac, msg) => {
            if (audioJob.current === job) setAudioStatus({ busy: true, frac, msg })
          }, job.signal)
          if (audioJob.current !== job) {
            await a.file.close()
            return
          }
          await s.setFxAudio(a)
          player.current?.updateAudioSource()
          setAudioStatus(null)
        } catch (e) {
          if (audioJob.current !== job || job.signal.aborted) return
          console.warn('音を整えられませんでした', e)
          setAudioStatus({ busy: false, frac: 0, msg: t('音を整えられませんでした: {msg}', { msg: e instanceof Error ? e.message : String(e) }) })
        } finally {
          if (audioJob.current === job) audioJob.current = null
        }
      })()
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, project?.audioFx])

  // ---- 車体挙動の乱れがあった時の 2 画面 ----
  const disturb = project?.logEnabled ? log?.telemetry.disturb : undefined
  const durSec = session ? session.frameCount / session.fps : 0
  const inc = project?.incident
  /** 検出した事象（除外したものも含めた一覧。除外は一覧の上で印を付ける） */
  const incidentList = useMemo(
    () => (disturb && inc ? incidentEvents(disturb, { ...inc, skip: [] }, durSec) : []),
    // 除外（skip）と表示の切り替えでは作り直さない
    [disturb, inc?.threshold, inc?.pre, inc?.post, inc?.minDur, inc?.transition, durSec] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const mainView = project?.layers.find((l) => l.type === 'view' && l.visible && !l.role)
  const updateIncident = (patch: Partial<IncidentSettings>): void =>
    apply((p) => {
      let layers = p.layers
      // 初めてオンにしたときは「自車」の画面（後ろ向き・広角・水平固定）を作る
      if (patch.on && !layers.some((l) => l.type === 'view' && l.role === 'incident')) {
        const nl = { ...newViewLayer(t('自車（挙動の乱れ）'), { x: 0.5, y: 0, w: 0.5, h: 1 }, RIDER_VIEW), role: 'incident' as const, border: { ...DEFAULT_BORDER } }
        const lastView = layers.reduce((acc, l, i) => (l.type === 'view' ? i : acc), -1)
        layers = [...layers.slice(0, lastView + 1), nl, ...layers.slice(lastView + 1)]
      }
      return { ...p, layers, incident: { ...p.incident, ...patch } }
    })

  const generate = async (range: 'export' | 'all'): Promise<void> => {
    if (!project || !selView || !session) return
    // 追い越しの演出: まだ調べていなければ、動画から追い越しの場面を探す（初回だけ。結果はプロジェクトに残す）
    // 判定の方法が変わっていれば（保存した結果の版が古ければ）調べ直す
    let overtakes = project.overtakesVersion === OVERTAKE_SCAN_VERSION ? project.overtakes : undefined
    if (project.director.overtake.on && !overtakes) {
      try {
        setLoading(t('追い越しの場面を探しています'))
        overtakes = (await session.scanOvertakes(setLoading)).overtakes.map((o) => ({ start: o.start, end: o.end }))
      } catch (e) {
        showError(e)
        return
      } finally {
        setLoading(null)
      }
    }
    const dur = session.frameCount / session.fps
    const t0 = range === 'all' ? 0 : Math.max(0, project.export.inSec)
    const t1 = range === 'all' || project.export.outSec < 0 ? dur : Math.min(dur, project.export.outSec)
    // 走行状態: 車両ログから。ログが無い（無効にした）ときは動画の IMU から推定したもの
    const riding = session.telemetry(project.logEnabled)?.riding ?? null
    // 視点（前方・コーナー入口・側方・後方）は、設定メニューの「自動生成の視点」の既定値
    // 追い越しの区間ごとの平均の車速（低速の追い越しでは切り替えない設定のため）
    const tel = session.telemetry(project.logEnabled)
    const spans = (overtakes ?? []).map((o) => ({ ...o, speed: meanSpeed(tel, o.start, o.end) }))
    const g = generateKeyframes(selView.keyframes, riding, project.markers, project.director, t0, t1, project.director.overtake.on ? spans : [], shotViews)
    updateProject({ ...updateLayer(project, selView.id, { keyframes: g.keyframes }), overtakes, overtakesVersion: overtakes ? OVERTAKE_SCAN_VERSION : undefined })
    setToast(
      t('「{name}」のキーフレームを {n} 個にしました（ショット {shots} 個、{from}〜{to}）。Ctrl+Z で元に戻せます。', {
        name: layerName(selView.name),
        n: g.keyframes.length,
        shots: g.shots.length,
        from: fmt(t0),
        to: fmt(t1)
      })
    )
  }

  // ---- 書き出し ----
  const doExport = async (outPath?: string): Promise<void> => {
    if (!session || !project) return
    const base = window.api.path.basename(project.insvPath).replace(/\.insv$/i, '')
    const out =
      outPath ??
      (await window.api.saveDialog({
        title: t('書き出し先'),
        defaultPath: window.api.path.join(window.api.path.dirname(project.insvPath), `${base}_motorecomovie.mp4`),
        filters: [{ name: 'MP4', extensions: ['mp4'] }]
      }))
    if (!out) return
    player.current?.pause()
    const ac = new AbortController()
    abort.current = ac
    setExporting({ done: 0, total: 1, fps: 0, etaSec: 0, phase: 'encode' })
    try {
      const t0 = performance.now()
      const r = await exportVideo(session, project, out, setExporting, ac.signal)
      const sec = (performance.now() - t0) / 1000
      setMessage(
        t('書き出しが完了しました（{min}分{sec}秒、{codec}{audio}）', {
          min: Math.floor(sec / 60),
          sec: Math.round(sec % 60),
          codec: r.codecUsed.startsWith('hvc') ? 'HEVC' : 'H.264',
          audio: r.audio ? t('、音声あり') : ''
        }) +
          `\n${out}` +
          (r.log ? `\n\n${r.log}` : '')
      )
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setMessage(t('書き出しを中止しました。'))
      else showError(e)
    } finally {
      setExporting(null)
      abort.current = null
    }
  }

  // ---- キーボード操作 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!session || !project || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const f = player.current?.status.frame ?? 0
      const step = e.shiftKey ? session.fps : 1
      const vid = selView?.id
      if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }
      if (e.ctrlKey) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowRight') seek(f + step)
      else if (e.key === 'ArrowLeft') seek(f - step)
      else if (e.key === 'm' || e.key === 'M') toggleMute()
      else if (e.key === 'b' || e.key === 'B') addMarker()
      else if (e.key === 'Home') seek(0)
      else if (e.key === 'End') seek(session.frameCount - 1)
      else if ((e.key === 'k' || e.key === 'K') && vid) updateProject(addKey(project, vid, time, keyTol))
      else if (e.key === 'Delete' && vid) updateProject(removeKey(project, vid, time, keyTol))
      else if (e.key === 'i' || e.key === 'I') updateProject({ ...project, export: { ...project.export, inSec: time } })
      else if (e.key === 'o' || e.key === 'O') updateProject({ ...project, export: { ...project.export, outSec: time } })
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selView) {
        // 選択中の視点レイヤーの、前後のキーフレームへ移動
        const ks = selView.keyframes.map((k) => k.t)
        const tol = keyTolerance(session.fps)
        const tgt = e.key === 'ArrowUp' ? ks.filter((t) => t > time + tol).sort((a, b) => a - b)[0] : ks.filter((t) => t < time - tol).sort((a, b) => b - a)[0]
        if (tgt !== undefined) seek(session.frameOf(tgt))
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- ドラッグ＆ドロップ ----
  useEffect(() => {
    const over = (e: DragEvent): void => e.preventDefault()
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      const f = e.dataTransfer?.files[0]
      if (!f) return
      const p = window.api.pathForFile(f)
      if (p.toLowerCase().endsWith('.insv')) void openInsv(p)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [openInsv])

  // ---- 自動テストからの操作（REFRAME_AUTOTEST=ui）----
  useEffect(() => {
    ;(window as unknown as { __reframe: unknown }).__reframe = {
      loading,
      frame: status.frame,
      playing: status.playing,
      fps: status.fps,
      hasSession: !!session,
      error,
      message,
      exporting: !!exporting,
      layers: project?.layers.map((l) => `${l.type}:${l.name}${l.type === 'view' ? `(${l.keyframes.length})` : ''}`) ?? [],
      markers: project?.markers.length ?? 0,
      seamBusy,
      seam: project?.stab.seam ?? null,
      bodyBusy: !!bodyStatus?.busy,
      audioBusy: !!audioStatus?.busy,
      audioReady: !!session?.fxAudio,
      audioMsg: audioStatus?.msg ?? null,
      bodyMsg: bodyStatus?.msg ?? null,
      bodyReady: !!session?.body,
      recent: recent.map((r) => `${r.name}${r.thumb ? '(thumb)' : ''}`),
      selected: selLayer?.name ?? null,
      rects: project?.layers.map((l) => `${l.name}${l.visible ? '' : HIDDEN_MARK}:${[l.rect.x, l.rect.y, l.rect.w, l.rect.h].map((v) => v.toFixed(3)).join(',')}`) ?? [],
      saved,
      av: player.current?.avOffsetMs() ?? null,
      audio: player.current?.audioStats ?? null
    }
  })
  const doExportRef = useRef(doExport)
  doExportRef.current = doExport
  const projectRef = useRef(project)
  projectRef.current = project
  // メインメニューの「開く」「閉じる」
  const menuRef = useRef({ openDialog, closeVideo })
  menuRef.current = { openDialog, closeVideo }
  useEffect(
    () =>
      window.api.onMenu((a) => {
        if (a === 'open') void menuRef.current.openDialog()
        else if (a === 'close') void menuRef.current.closeVideo()
        else if (a === 'shotViews') setShotDlg((d) => d ?? { kind: 'front', side: 'in', preview: true })
      }),
    []
  )
  const testRef = useRef({ addView, addOverlay })
  testRef.current = { addView, addOverlay }
  const settingsRef = useRef({ save: saveSettings, load: loadSettings })
  settingsRef.current = { save: saveSettings, load: loadSettings }
  const testRef2 = useRef({ addMarker, generate })
  testRef2.current = { addMarker, generate }
  const testRef4 = useRef(updateIncident)
  testRef4.current = updateIncident
  useEffect(() => {
    const h = (e: Event): void => {
      const d = (e as CustomEvent).detail
      if (d.action === 'open') void openInsv(d.path)
      else if (d.action === 'seek') seek(d.frame)
      else if (d.action === 'play') player.current?.play()
      else if (d.action === 'pause') player.current?.pause()
      else if (d.action === 'edit') onEditView(d.patch)
      else if (d.action === 'project') apply((p) => ({ ...p, ...d.patch }))
      else if (d.action === 'addKey') {
        const id = selViewRef.current
        if (id) apply((p) => addKey(p, id, currentTime()))
      } else if (d.action === 'addView') testRef.current.addView()
      else if (d.action === 'addOverlay') testRef.current.addOverlay(d.widget)
      else if (d.action === 'layerRect') apply((p) => updateLayer(p, p.layers[d.index].id, { rect: d.rect }))
      else if (d.action === 'addMarker') testRef2.current.addMarker()
      else if (d.action === 'generate') testRef2.current.generate(d.range ?? 'all')
      else if (d.action === 'undo') undo()
      else if (d.action === 'refreshRecent') refreshRecent()
      else if (d.action === 'incident') testRef4.current(d.patch)
      else if (d.action === 'close') void closeRef.current()
      else if (d.action === 'layerPatch') apply((p) => updateLayer(p, p.layers[d.index].id, d.patch))
      else if (d.action === 'layerProps') apply((p) => updateLayer(p, p.layers[d.index].id, { props: d.props }))
      else if (d.action === 'select') setSelected((cur) => d.id ?? cur)
      else if (d.action === 'template') apply((p) => applyTemplate(p, d.id, currentTime()))
      else if (d.action === 'selectIndex') setSelected(projectRef.current?.layers[d.index]?.id ?? null)
      else if (d.action === 'export') void doExportRef.current(d.out)
      else if (d.action === 'saveSettings') void settingsRef.current.save(d.out)
      else if (d.action === 'loadSettings') void settingsRef.current.load(d.path)
      else if (d.action === 'shotViews') setShotDlg(d.open === false ? null : { kind: d.kind ?? 'front', side: d.side ?? 'in', preview: d.preview ?? true })
    }
    window.addEventListener('reframe:test', h)
    return () => window.removeEventListener('reframe:test', h)
  }, [openInsv, seek, onEditView, apply])

  // 設定の画面でプレビューしている間は、選んでいる視点レイヤーをその視点で映す（プロジェクトは変えない）
  const shownProject = useMemo((): Project | null => {
    if (!project || !shotDlg?.preview || !selView) return null
    const v = shotPreviewView(shotViews, shotDlg.kind, 30, shotDlg.side)
    return { ...project, layers: project.layers.map((l) => (l.id === selView.id && l.type === 'view' ? { ...l, keyframes: [{ t: 0, ...v }] } : l)) }
  }, [project, shotDlg, shotViews, selView])

  const leanData = useMemo(() => (log && project?.logEnabled ? { t: log.lean.t, v: log.lean.lean } : null), [log, project?.logEnabled])
  // タイムラインに重ねる車速（テレメトリーの 100Hz の車速を、動画時刻の列に）
  const speedData = useMemo(() => {
    const tel = log && project?.logEnabled ? log.telemetry : null
    const sp = tel?.channels.speed
    if (!tel || !sp) return null
    return { t: Float64Array.from(sp, (_, i) => tel.t0 + i / tel.rate), v: Float64Array.from(sp) }
  }, [log, project?.logEnabled])

  // ---- タイムラインの高さ（プレビューとの境界をドラッグして変える。このパソコンに覚えておく）----
  const [timelineH, setTimelineH] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('reframe.timelineH'))
      return v >= TIMELINE_MIN ? v : TIMELINE_DEFAULT
    } catch {
      return TIMELINE_DEFAULT
    }
  })
  const startTimelineResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const y0 = e.clientY
    const h0 = timelineH
    let h = h0
    const move = (ev: PointerEvent): void => {
      h = Math.round(Math.max(TIMELINE_MIN, Math.min(window.innerHeight * 0.7, h0 + (y0 - ev.clientY))))
      setTimelineH(h)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem('reframe.timelineH', String(h))
      } catch {
        /* 覚えられなくても使える */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="app" style={{ gridTemplateRows: `44px minmax(0, 1fr) ${timelineH}px` }}>
      <div className="toolbar">
        <span className="title">MotoRecoMovie</span>
        <button onClick={openDialog}>{t('開く…')}</button>
        <button disabled={!project || !!exporting} onClick={() => void closeVideo()} title={t('閉じて最近開いた動画の一覧へ戻る')}>{t('閉じる')}</button>
        <button className="icon" disabled={!project} onClick={undo} title={t('元に戻す（Ctrl+Z）')}>↶</button>
        <button className="icon" disabled={!project} onClick={redo} title={t('やり直し（Ctrl+Y）')}>↷</button>
        <span className="file">
          {project ? window.api.path.basename(project.insvPath) : t('.insv をドラッグ＆ドロップするか「開く」から選んでください')}
          {session && `　${session.meta.model}　${session.rig[0].pictureSize}×${session.rig[0].pictureSize}×2　${session.fps}fps`}
        </span>
        {project && <span className="note">{saved ? t('保存済み') : t('保存中…')}</span>}
        <select className="lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)} title={t('表示の言語')}>
          {LANG_NAMES.map(([v, name]) => (
            <option key={v} value={v}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {session && project ? (
        <Viewer
          session={session}
          project={shownProject ?? project}
          status={status}
          selected={selLayer?.id ?? null}
          onSelect={setSelected}
          onUpdateRect={(id, rect) => apply((p) => updateLayer(p, id, { rect }))}
          onPlayer={(p) => {
            player.current = p
            p?.setMuted(muted)
            p?.setTelemetry(session.telemetry(project.logEnabled))
          }}
          onStatus={setStatus}
          onError={showError}
          onEditView={onEditView}
        />
      ) : (
        <div className="viewer">
          <Recent
            items={recent}
            onOpen={(p) => void openInsv(p)}
            onRemove={(p) => void window.api.recent.remove(p).then(refreshRecent)}
            onOpenDialog={openDialog}
          />
        </div>
      )}

      {shotDlg && (
        <ShotViewsDialog
          views={shotViews}
          onChange={setShotViews}
          kind={shotDlg.kind}
          onKind={(kind) => setShotDlg({ ...shotDlg, kind })}
          side={shotDlg.side}
          onSide={(side) => setShotDlg({ ...shotDlg, side })}
          preview={shotDlg.preview}
          canPreview={!!(session && project && selView)}
          onPreview={(preview) => setShotDlg({ ...shotDlg, preview })}
          onClose={() => setShotDlg(null)}
        />
      )}

      {project && selView ? (
        <SidePanel
          project={project}
          time={time}
          selLayer={selLayer ?? null}
          selView={selView}
          hasKeyHere={hasKeyHere}
          log={log}
          exporting={exporting}
          onChange={updateProject}
          onEditView={(patch) => onEditView(patch)}
          onAddKey={() => updateProject(addKey(project, selView.id, time, keyTol))}
          onRemoveKey={() => updateProject(removeKey(project, selView.id, time, keyTol))}
          onSelectLayer={setSelected}
          onAddView={addView}
          onAddOverlay={addOverlay}
          onRemoveLayer={(id) => {
            const next = removeLayer(project, id)
            updateProject(next)
            if (next !== project) setSelected(viewLayers(next)[0]?.id ?? null)
          }}
          onMoveLayer={(id, dir) => updateProject(moveLayer(project, id, dir))}
          onUpdateLayer={(id, patch) => updateProject(updateLayer(project, id, patch))}
          onApplyTemplate={(id) => updateProject(applyTemplate(project, id, time))}
          hasRiding={!!session?.telemetry(project.logEnabled)?.riding}
          ridingFromImu={session?.telemetry(project.logEnabled)?.source === 'imu'}
          leanAvailable={!!(project.logEnabled && log) || !!session?.imuTel}
          onAddMarker={addMarker}
          onUpdateMarker={updateMarker}
          onRemoveMarker={removeMarker}
          onSeekTime={(sec) => seek(session!.frameOf(sec))}
          onUpdateDirector={updateDirector}
          onGenerate={generate}
          onOpenShotViews={() => setShotDlg((d) => d ?? { kind: 'front', side: 'in', preview: true })}
          incidentEvents={incidentList}
          incidentAvailable={!!disturb}
          mainFull={!!mainView && isFull(mainView.rect)}
          onUpdateIncident={updateIncident}
          onEstimateSeam={reestimateSeam}
          seamBusy={seamBusy}
          bodyStatus={bodyStatus}
          audioStatus={audioStatus}
          audioReady={!!session?.fxAudio}
          bodyReady={!!session?.body}
          onRebuildBody={rebuildBody}
          onLoadLog={loadLogDialog}
          onSaveSettings={() => void saveSettings()}
          onLoadSettings={() => void loadSettings()}
          logPrefs={logPrefs}
          onChangeDdf={() => void changeDdf()}
          onFindDat={(pick) => void findDatInFolder(pick)}
          onExport={() => void doExport()}
          onCancelExport={() => abort.current?.abort()}
          onSetIn={() => updateProject({ ...project, export: { ...project.export, inSec: time } })}
          onSetOut={() => updateProject({ ...project, export: { ...project.export, outSec: time } })}
        />
      ) : (
        <div className="side" />
      )}

      <div className="timeline">
        <div
          className="timeline-resizer"
          data-handle="timeline"
          onPointerDown={startTimelineResize}
          onDoubleClick={() => setTimelineH(TIMELINE_DEFAULT)}
          title={t('ドラッグでタイムラインの高さを変える（ダブルクリックで元の高さ）')}
        />
        <div className="transport">
          <button className="icon" disabled={!session} onClick={() => seek(0)} title={t('先頭（Home）')}>⏮</button>
          <button className="icon" disabled={!session} onClick={() => seek(status.frame - 1)} title={t('1フレーム戻る（←）')}>◀</button>
          <button className="icon" disabled={!session} onClick={togglePlay} title={t('再生／一時停止（Space）')}>{status.playing ? '⏸' : '▶'}</button>
          <button className="icon" disabled={!session} onClick={() => seek(status.frame + 1)} title={t('1フレーム進む（→）')}>▶|</button>
          <button className="icon" disabled={!session || !session.audioTrack} onClick={toggleMute} title={t('ミュート（M）')}>{muted ? '🔇' : '🔊'}</button>
          <span className="time">
            {session ? `${fmt(time)} / ${fmt(session.frameCount / session.fps)}　#${status.frame}` : '--:--'}
          </span>
          {selView && <span className="note">{t('キーフレーム: {name}', { name: layerName(selView.name) })}</span>}
          <span className="spacer" />
          <span className="note">{t('Space 再生　M ミュート　B 注目ポイント　←→ コマ送り（Shift で1秒）　↑↓ キーフレーム間を移動　K 追加　Del 削除　I/O 書き出し範囲')}</span>
        </div>
        {session && project && selView ? (
          <Timeline
            frameCount={session.frameCount}
            fps={session.fps}
            frame={status.frame}
            keyframes={selView.keyframes}
            inSec={project.export.inSec}
            outSec={project.export.outSec}
            lean={leanData}
            speed={speedData}
            riding={session.telemetry(project.logEnabled)?.riding ?? null}
            markers={project.markers}
            incidents={project.incident.on && disturb ? incidentList.filter((e) => !project.incident.skip.some((k) => Math.abs(k - e.peak) < 0.06)) : []}
            onSeek={seek}
            frameOf={(sec) => session.frameOf(sec)}
          />
        ) : (
          <div />
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {loading && (
        <div className="overlay">
          <div className="box">{t(loading)}…</div>
        </div>
      )}
      {(error || message) && (
        <div className="overlay" onClick={() => (setError(null), setMessage(null))}>
          <div className="box">
            {error && <div className="error">{error}</div>}
            {message && <div style={{ whiteSpace: 'pre-wrap' }}>{message}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={() => (setError(null), setMessage(null))}>{t('閉じる')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
