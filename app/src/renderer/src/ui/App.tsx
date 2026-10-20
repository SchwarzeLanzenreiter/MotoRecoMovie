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
import { getLang, setLang, t, LANG_NAMES, type Lang } from '../i18n'

const projectPathFor = (insv: string): string => insv + '.motorecomovie.json'

/** Average vehicle speed [km/h] of the telemetry between times a and b [s] (undefined if there is no speed) */
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
/** Edits from the previous name (Insta360 Reframe). Read these if there are none under the new name (they are saved under the new name) */
const legacyProjectPathFor = (insv: string): string => insv + '.reframe.json'

const fmt = (s: number): string => {
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

/** Default position of a new layer (small window at the bottom right) */
const PIP: Rect = { x: 0.66, y: 0.04, w: 0.3, h: 0.3 }

/** Language choices (names written in each language) */
/** Mark added to hidden layers in the autotest state (not shown on screen) */
const HIDDEN_MARK = '(hidden)' // i18n-ignore

/** Timeline height [px] (default and minimum) */
const TIMELINE_DEFAULT = 150
const TIMELINE_MIN = 90

export function App(): React.JSX.Element {
  const lang = useLang()
  // make the main menu follow the UI language too
  useEffect(() => {
    void window.api.setMenuLang(lang)
  }, [lang])
  const [session, setSession] = useState<Session | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [log, setLog] = useState<LogInfo | null>(null)
  // conversion rules for .dat (.ddf) and the folder to search for .dat (remembered on this computer)
  const [logPrefs, setLogPrefsState] = useState<LogPrefs>(loadLogPrefs)
  // defaults of the auto-generated views (remembered on this computer) and the settings screen to change them (while it is open, the selected view is shown in the preview)
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
  // a discreet notification that disappears after a few seconds (does not interrupt the operation)
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

  // selected layer. View editing and the timeline keyframes target the "selected view layer"
  const selLayer: Layer | undefined = project ? (findLayer(project, selected) ?? viewLayers(project)[0]) : undefined
  const selView: ViewLayer | undefined = selLayer?.type === 'view' ? selLayer : project ? viewLayers(project)[0] : undefined
  const selViewRef = useRef<string | null>(null)
  selViewRef.current = selView?.id ?? null

  // ---- Open a file ----
  const openInsv = useCallback(
    async (path: string) => {
      try {
        setLoading(t('Loading'))
        await closeRef.current()
        let proj = newProject(path)
        let pp = projectPathFor(path)
        if (!(await window.api.exists(pp)) && (await window.api.exists(legacyProjectPathFor(path)))) pp = legacyProjectPathFor(path)
        if (await window.api.exists(pp)) {
          try {
            proj = migrateProject(JSON.parse(await window.api.readText(pp)), path)
          } catch {
            /* ignore a broken project and start a new one */
          }
        }
        const s = await Session.open(path, proj.stab, setLoading)
        // Convert the times of projects saved by an earlier version to the current video times (on the X5 and on second and later split videos, the recorded times were offset)
        if (proj.timeBase !== 1) {
          if (s.legacyTimeShiftSec) console.log(`Shifted the project times by ${s.legacyTimeShiftSec.toFixed(3)} s (time base of the earlier version)`)
          proj = { ...shiftProjectTimes(proj, s.legacyTimeShiftSec), timeBase: 1 }
        }
        // Lens seam alignment: if not estimated yet, estimate it in the background after opening, then apply and save it
        const needSeam = proj.stab.seam === undefined
        // Vehicle log: the one recorded in the project if any, otherwise the CSV in the same folder,
        // otherwise look for one matching the video in the .dat folder (if set)
        const prefs = loadLogPrefs()
        let logPath = proj.logPath && (await window.api.exists(proj.logPath)) ? proj.logPath : await Session.findLog(path)
        if (!logPath && prefs.datFolder && prefs.ddfPath && (await window.api.exists(prefs.datFolder))) {
          try {
            logPath = (await s.findDat(prefs.datFolder, prefs.ddfPath, setLoading))?.path ?? null
          } catch (e) {
            console.warn('Automatic .dat selection failed', e)
          }
        }
        let info: LogInfo | null = null
        if (logPath) {
          try {
            const ddf = isDatPath(logPath) ? (proj.ddfPath && (await window.api.exists(proj.ddfPath)) ? proj.ddfPath : prefs.ddfPath) : null
            info = await s.loadLog(logPath, ddf, setLoading)
            if (info.sync.peakRatio < 1.5) {
              setMessage(t('Could not sync vehicle log {file} with the video (it may be from a different ride).', { file: window.api.path.basename(logPath) }))
              info = null
              logPath = null
              s.clearLog()
            }
          } catch (e) {
            setMessage(t('Could not load the vehicle log: {msg}', { msg: e instanceof Error ? e.message : String(e) }))
            logPath = null
          }
        }
        // Estimate from the video IMU so that auto camera, floating signs and horizon correction work even without a vehicle log
        // (even when there is a log, it is used when the log is disabled; the accuracy is lower than the log)
        try {
          setLoading(t('Estimating riding state from the video motion'))
          await s.loadImuTelemetry()
        } catch (e) {
          console.warn('Estimation from the video IMU failed', e)
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

  // ---- History thumbnail (the preview is scaled down and saved) ----
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
  // take it when the first frame is shown after opening
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
  // also update it when closing, with the scene being worked on (as far as possible)
  useEffect(() => {
    const h = (): void => void saveThumb()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  })

  // ---- Close and return to the start screen (history) ----
  const closeVideo = async (): Promise<void> => {
    // if we are within the autosave wait time, save immediately and then close
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
    const r = await window.api.openDialog({ title: t('Open .insv'), filters: [{ name: t('Insta360 video'), extensions: ['insv'] }], properties: ['openFile'] })
    if (r?.[0]) await openInsv(r[0])
  }

  // ---- Settings file (the settings on the right, positions of meters, etc.; usable for other videos too) ----
  const saveSettings = async (outPath?: string): Promise<void> => {
    if (!project) return
    const base = window.api.path.basename(project.insvPath).replace(/\.insv$/i, '')
    const out = outPath ?? await window.api.saveDialog({
      title: t('Save settings'),
      defaultPath: window.api.path.join(window.api.path.dirname(project.insvPath), `${base}${SETTINGS_EXT}`),
      filters: [{ name: t('MotoRecoMovie settings'), extensions: ['json'] }]
    })
    if (!out) return
    try {
      await window.api.writeText(out, JSON.stringify(settingsFromProject(project), null, 2))
      setToast(t('Settings saved: {file}', { file: window.api.path.basename(out) }))
    } catch (e) {
      showError(e)
    }
  }
  const loadSettings = async (inPath?: string): Promise<void> => {
    if (!project) return
    const r = inPath ? [inPath] : await window.api.openDialog({
      title: t('Load settings'),
      defaultPath: window.api.path.dirname(project.insvPath),
      filters: [{ name: t('MotoRecoMovie settings'), extensions: ['json'] }],
      properties: ['openFile']
    })
    if (!r?.[0]) return
    try {
      const s = parseSettings(await window.api.readText(r[0]))
      const next = applySettings(project, s, (a, b) => layerName(a) === layerName(b))
      updateProject(next)
      // if the selected layer no longer exists, select the first view layer
      if (!next.layers.some((l) => l.id === selected)) setSelected(next.layers.find((l) => l.type === 'view')?.id ?? null)
      setToast(t('Settings loaded: {file} (Ctrl+Z to undo)', { file: window.api.path.basename(r[0]) }))
    } catch (e) {
      showError(e)
    }
  }

  /** Choose the conversion rules (.ddf). null if none is chosen */
  const pickDdf = async (): Promise<string | null> => {
    const logPrefs = loadLogPrefs()
    const r = await window.api.openDialog({
      title: t('Choose decoding rules (.ddf)'),
      defaultPath: logPrefs.ddfPath ? window.api.path.dirname(logPrefs.ddfPath) : logPrefs.datFolder ?? undefined,
      filters: [{ name: t('MotoRecoViewer decoding rules'), extensions: ['ddf'] }],
      properties: ['openFile']
    })
    if (!r?.[0]) return null
    setLogPrefs({ ddfPath: r[0] })
    return r[0]
  }

  /** Load a log and use it (a CSV, or a .dat decoded with the rules of a ddf) */
  const useLogFile = async (path: string, ddf: string | null): Promise<void> => {
    if (!session || !project) return
    try {
      setLoading(t('Loading log'))
      const info = await session.loadLog(path, ddf, setLoading)
      if (info.sync.peakRatio < 1.5) setMessage(t('This log did not sync well with the video. Please check the result.'))
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
      title: t('Open MotoReco log'),
      defaultPath: logPrefs.datFolder ?? window.api.path.dirname(project.insvPath),
      filters: [{ name: t('MotoReco logs (.dat, CSV)'), extensions: ['dat', 'csv'] }],
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

  /** Change the conversion rules. If the current log is a .dat, reload it with the new rules */
  const changeDdf = async (): Promise<void> => {
    const ddf = await pickDdf()
    if (ddf && log && isDatPath(log.path)) await useLogFile(log.path, ddf)
  }

  /** Look for a .dat matching the video in the .dat folder and load it */
  const findDatInFolder = async (pickFolder: boolean): Promise<void> => {
    if (!session || !project) return
    const logPrefs = loadLogPrefs()
    setLogPrefsState(logPrefs)
    let folder = logPrefs.datFolder
    if (pickFolder || !folder || !(await window.api.exists(folder))) {
      const r = await window.api.openDialog({ title: t('Choose the folder with MotoReco .dat files'), defaultPath: folder ?? undefined, properties: ['openDirectory'] })
      if (!r?.[0]) return
      folder = r[0]
      setLogPrefs({ datFolder: folder })
    }
    const ddf = logPrefs.ddfPath && (await window.api.exists(logPrefs.ddfPath)) ? logPrefs.ddfPath : await pickDdf()
    if (!ddf) return
    let found: { path: string; peakRatio: number } | null = null
    try {
      setLoading(t('Looking for a matching bike log'))
      found = await session.findDat(folder, ddf, setLoading)
    } catch (e) {
      showError(e)
    } finally {
      setLoading(null)
    }
    if (!found) {
      setMessage(t('No .dat matching this video was found in {folder}.', { folder: window.api.path.basename(folder) }))
      return
    }
    await useLogFile(found.path, ddf)
  }

  // ---- Project update, undo, autosave ----
  // on every change, push the previous state onto the history. Changes that follow within 0.5 s (drags, etc.) are merged into one
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
  /** Apply a change to the latest state (so that consecutive operations do not overwrite an older state) */
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

  // reflect enabling/disabling the log in the lean angle and the telemetry display
  useEffect(() => {
    if (!session || !project) return
    session.setLogEnabled(project.logEnabled)
    player.current?.setTelemetry(session.telemetry(project.logEnabled))
  }, [project?.logEnabled, session, log]) // eslint-disable-line react-hooks/exhaustive-deps

  const time = session ? session.motion.videoTime(Math.min(status.frame, session.frameCount - 1)) : 0
  // time difference treated as "a keyframe at this frame" (0.6 x the frame interval; auto-generated keyframes do not sit on frame boundaries)
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

  // ---- Layer operations ----
  // always add to the latest state (so that consecutive additions do not overwrite the previous one)
  const addView = (): void => {
    const now = currentTime()
    const fromId = selViewRef.current
    apply((p) => {
      const from = viewLayers(p).find((l) => l.id === fromId) ?? viewLayers(p)[0]
      const next = addViewLayer(p, t('View {n}', { n: viewLayers(p).length + 1 }), PIP, now, from)
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

  // ---- Markers and auto camera ----
  const addMarker = (): void => {
    const now = currentTime()
    apply((p) => ({ ...p, markers: [...p.markers, { id: newId(), t: now, yaw: 90, pitch: 0, fov: 90, hold: 4 }] }))
  }
  const updateMarker = (id: string, patch: Partial<Marker>): void => apply((p) => ({ ...p, markers: p.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))
  const removeMarker = (id: string): void => apply((p) => ({ ...p, markers: p.markers.filter((m) => m.id !== id) }))
  const updateDirector = (d: DirectorSettings): void => apply((p) => ({ ...p, director: d }))

  // ---- Lens seam alignment (estimated in the background and applied) ----
  const [seamBusy, setSeamBusy] = useState(false)
  async function estimateSeamFor(s: Session, manual: boolean): Promise<void> {
    setSeamBusy(true)
    try {
      const r = await s.estimateSeam()
      console.log(`Seam alignment rotation [${r.fix.rot.map((v) => v.toFixed(2)).join(', ')}]° edge ${r.fix.edge.toFixed(2)}°  overlap band difference ${r.before.toFixed(3)} -> ${r.after.toFixed(3)}`)
      if (sessionRef.current !== s) return // another video was opened while estimating
      apply((p) => ({ ...p, stab: { ...p.stab, seam: r.fix, ...(manual && { seamFix: true }) } }))
      setToast(
        t('Lens seam aligned (edge angle {edge}°, rotation {rot}°, overlap difference {before} → {after}).', {
          edge: r.fix.edge.toFixed(1),
          rot: Math.hypot(...r.fix.rot).toFixed(1),
          before: r.before.toFixed(3),
          after: r.after.toFixed(3)
        })
      )
    } catch (e) {
      console.warn('Could not estimate the seam alignment', e)
      if (sessionRef.current === s && !manual) apply((p) => ({ ...p, stab: { ...p.stab, seam: null } }))
      if (manual) showError(e)
    } finally {
      setSeamBusy(false)
    }
  }
  const reestimateSeam = (): void => {
    if (session) void estimateSeamFor(session, true)
  }

  // ---- Own-bike seam pattern (engine/bodymap.ts; built in the background with AI and saved next to the video) ----
  // The pattern changes with the lens correction (seam alignment), so build it after the alignment is decided
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
    setBodyStatus({ busy: true, frac: 0, msg: t('Building the body seam map') })
    try {
      // for checking (autotest bodyRange): limit the range to build
      const range = (globalThis as { __bodyRange?: [number, number] }).__bodyRange
      const tr = await buildBodyTrack(s, { inpaint: kind, signal: job.signal, from: range?.[0], to: range?.[1] }, (frac, msg) => {
        if (bodyJob.current === job) setBodyStatus({ busy: true, frac, msg })
      })
      if (bodyJob.current !== job) return
      s.body = tr
      await saveBodyTrack(s, tr)
      setBodyStatus(null)
      player.current?.redraw()
      setToast(t('Body seam map built (parts that move with the camera, such as the top case, are aligned by AI per section).'))
    } catch (e) {
      if (bodyJob.current !== job || job.signal.aborted) return
      console.warn('Could not build the own-bike seam pattern', e)
      setBodyStatus({ busy: false, frac: 0, msg: t('Could not build the body seam map: {msg}', { msg: e instanceof Error ? e.message : String(e) }) })
    }
  }
  useEffect(() => {
    if (!session || !project || seamBusy || project.stab.seam === undefined || project.stab.bodyStitch !== true) return
    void prepareBody(session, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, seamBusy, project?.stab.seam, project?.stab.seamFix, project?.stab.bodyStitch, project?.stab.bodyInpaint])
  // when the video is closed, stop the pattern that is being built
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

  // ---- Condition the audio while riding (engine/audiofx.ts; built in the background and placed in the app cache) ----
  // after changing the settings, keep playing the video's own audio until it is ready
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
    // wait a little so that it is not rebuilt many times when the settings are moved continuously
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (s.fxAudio) {
            await s.setFxAudio(null)
            player.current?.updateAudioSource()
          }
          const a = await buildFxAudio(s, fx, (frac, msg) => {
            if (audioJob.current === job) setAudioStatus({ busy: true, frac, msg })
          }, job.signal, () => !player.current?.isPlaying)
          if (audioJob.current !== job) {
            await a.file.close()
            return
          }
          await s.setFxAudio(a)
          player.current?.updateAudioSource()
          setAudioStatus(null)
        } catch (e) {
          if (audioJob.current !== job || job.signal.aborted) return
          console.warn('Could not condition the audio', e)
          setAudioStatus({ busy: false, frac: 0, msg: t('Could not clean up the sound: {msg}', { msg: e instanceof Error ? e.message : String(e) }) })
        } finally {
          if (audioJob.current === job) audioJob.current = null
        }
      })()
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, project?.audioFx])

  // ---- 2 screens when a bike disturbance occurs ----
  const disturb = project?.logEnabled ? log?.telemetry.disturb : undefined
  const durSec = session ? session.frameCount / session.fps : 0
  const inc = project?.incident
  /** Detected events (the list including excluded ones; exclusion is marked on the list) */
  const incidentList = useMemo(
    () => (disturb && inc ? incidentEvents(disturb, { ...inc, skip: [] }, durSec) : []),
    // do not rebuild on exclusion (skip) or display toggles
    [disturb, inc?.threshold, inc?.pre, inc?.post, inc?.minDur, inc?.transition, durSec] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const mainView = project?.layers.find((l) => l.type === 'view' && l.visible && !l.role)
  const updateIncident = (patch: Partial<IncidentSettings>): void =>
    apply((p) => {
      let layers = p.layers
      // the first time it is turned on, create the "own bike" screen (facing backward, wide angle, horizon locked)
      if (patch.on && !layers.some((l) => l.type === 'view' && l.role === 'incident')) {
        const nl = { ...newViewLayer(t('Own bike (disturbance)'), { x: 0.5, y: 0, w: 0.5, h: 1 }, RIDER_VIEW), role: 'incident' as const, border: { ...DEFAULT_BORDER } }
        const lastView = layers.reduce((acc, l, i) => (l.type === 'view' ? i : acc), -1)
        layers = [...layers.slice(0, lastView + 1), nl, ...layers.slice(lastView + 1)]
      }
      return { ...p, layers, incident: { ...p.incident, ...patch } }
    })

  const generate = async (range: 'export' | 'all'): Promise<void> => {
    if (!project || !selView || !session) return
    // Overtake effect: if not examined yet, look for overtakes in the video (first time only; the result is kept in the project)
    // re-examine if the detection method has changed (if the saved result has an older version)
    let overtakes = project.overtakesVersion === OVERTAKE_SCAN_VERSION ? project.overtakes : undefined
    if (project.director.overtake.on && !overtakes) {
      try {
        setLoading(t('Looking for overtakes'))
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
    // Riding state: from the vehicle log; if there is no log (disabled), the one estimated from the video IMU
    const riding = session.telemetry(project.logEnabled)?.riding ?? null
    // Views (front, corner entry, side, rear) are the defaults of "Auto-generated views" in the settings menu
    // average vehicle speed for each overtake span (because of the setting not to switch on low-speed overtakes)
    const tel = session.telemetry(project.logEnabled)
    const spans = (overtakes ?? []).map((o) => ({ ...o, speed: meanSpeed(tel, o.start, o.end) }))
    const g = generateKeyframes(selView.keyframes, riding, project.markers, project.director, t0, t1, project.director.overtake.on ? spans : [], shotViews)
    updateProject({ ...updateLayer(project, selView.id, { keyframes: g.keyframes }), overtakes, overtakesVersion: overtakes ? OVERTAKE_SCAN_VERSION : undefined })
    setToast(
      t('Set "{name}" to {n} keyframes ({shots} shots, {from}–{to}). Press Ctrl+Z to undo.', {
        name: layerName(selView.name),
        n: g.keyframes.length,
        shots: g.shots.length,
        from: fmt(t0),
        to: fmt(t1)
      })
    )
  }

  // ---- Export ----
  const doExport = async (outPath?: string): Promise<void> => {
    if (!session || !project) return
    const base = window.api.path.basename(project.insvPath).replace(/\.insv$/i, '')
    const out =
      outPath ??
      (await window.api.saveDialog({
        title: t('Export to'),
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
        t('Export finished ({min} min {sec} s, {codec}{audio})', {
          min: Math.floor(sec / 60),
          sec: Math.round(sec % 60),
          codec: r.codecUsed.startsWith('hvc') ? 'HEVC' : 'H.264',
          audio: r.audio ? t(', with audio') : ''
        }) +
          `\n${out}` +
          (r.log ? `\n\n${r.log}` : '')
      )
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setMessage(t('Export canceled.'))
      else showError(e)
    } finally {
      setExporting(null)
      abort.current = null
    }
  }

  // ---- Keyboard operation ----
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
        // move to the previous/next keyframe of the selected view layer
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

  // ---- Drag and drop ----
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

  // ---- Operations from the autotest (REFRAME_AUTOTEST=ui) ----
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
  // main menu "Open" and "Close"
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

  // while previewing in the settings screen, show the selected view layer with that view (the project is not changed)
  const shownProject = useMemo((): Project | null => {
    if (!project || !shotDlg?.preview || !selView) return null
    const v = shotPreviewView(shotViews, shotDlg.kind, 30, shotDlg.side)
    return { ...project, layers: project.layers.map((l) => (l.id === selView.id && l.type === 'view' ? { ...l, keyframes: [{ t: 0, ...v }] } : l)) }
  }, [project, shotDlg, shotViews, selView])

  const leanData = useMemo(() => (log && project?.logEnabled ? { t: log.lean.t, v: log.lean.lean } : null), [log, project?.logEnabled])
  // vehicle speed overlaid on the timeline (the 100 Hz telemetry speed, per column of video time)
  const speedData = useMemo(() => {
    const tel = log && project?.logEnabled ? log.telemetry : null
    const sp = tel?.channels.speed
    if (!tel || !sp) return null
    return { t: Float64Array.from(sp, (_, i) => tel.t0 + i / tel.rate), v: Float64Array.from(sp) }
  }, [log, project?.logEnabled])

  // ---- Timeline height (changed by dragging the boundary with the preview; remembered on this computer) ----
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
        /* it still works even if it cannot be remembered */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="app" style={{ gridTemplateRows: `44px minmax(0, 1fr) ${timelineH}px` }}>
      <div className="toolbar">
        <span className="title">MotoRecoMovie</span>
        <button onClick={openDialog}>{t('Open…')}</button>
        <button disabled={!project || !!exporting} onClick={() => void closeVideo()} title={t('Close and return to recent videos')}>{t('Close')}</button>
        <button className="icon" disabled={!project} onClick={undo} title={t('Undo (Ctrl+Z)')}>↶</button>
        <button className="icon" disabled={!project} onClick={redo} title={t('Redo (Ctrl+Y)')}>↷</button>
        <span className="file">
          {project ? window.api.path.basename(project.insvPath) : t('Drag and drop an .insv file, or choose one with "Open"')}
          {session && `\u2003${session.meta.model}\u2003${session.rig[0].pictureSize}×${session.rig[0].pictureSize}×2\u2003${session.fps}fps`}
        </span>
        {project && <span className="note">{saved ? t('Saved') : t('Saving…')}</span>}
        <select className="lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)} title={t('Display language')}>
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
          title={t('Drag to resize the timeline (double-click to reset)')}
        />
        <div className="transport">
          <button className="icon" disabled={!session} onClick={() => seek(0)} title={t('Go to start (Home)')}>⏮</button>
          <button className="icon" disabled={!session} onClick={() => seek(status.frame - 1)} title={t('Previous frame (←)')}>◀</button>
          <button className="icon" disabled={!session} onClick={togglePlay} title={t('Play / pause (Space)')}>{status.playing ? '⏸' : '▶'}</button>
          <button className="icon" disabled={!session} onClick={() => seek(status.frame + 1)} title={t('Next frame (→)')}>▶|</button>
          <button className="icon" disabled={!session || !session.audioTrack} onClick={toggleMute} title={t('Mute (M)')}>{muted ? '🔇' : '🔊'}</button>
          <span className="time">
            {session ? `${fmt(time)} / ${fmt(session.frameCount / session.fps)}\u2003#${status.frame}` : '--:--'}
          </span>
          {selView && <span className="note">{t('Keyframes: {name}', { name: layerName(selView.name) })}</span>}
          <span className="spacer" />
          <span className="note">{t('Space play · M mute · B marker · ←→ step frame (Shift: 1 s) · ↑↓ jump between keyframes · K add · Del delete · I/O export range')}</span>
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
              <button onClick={() => (setError(null), setMessage(null))}>{t('Close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
