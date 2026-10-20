// Settings file (*.motorecomovie-settings.json; *.reframe-settings.json under the previous name): saves and loads the right-hand settings and the positions of on-screen meters and the like so they can be used for other videos.
//
// Included (usable for any video):
//   - Stabilization settings (the seam-fitting estimate is per video, so it is not included)
//   - Layers (draw order): position, size, visibility, name; for view layers, border, signs, role and direction (the view of a layer with a single keyframe),
//     and the type and settings of overlay meters
//   - Auto camera, body disturbance (per-event "no 2 screens" is per video, so it is not included), export (the range is not included)
// Not included: view motion of views with 2 or more keyframes, markers, overtake results, vehicle log
import { mergeDirector, type DirectorSettings } from './director'
import { mergeIncident, type IncidentSettings } from './incident'
import { DEFAULT_AUDIO_FX, type AudioFx } from '../core/audiofx'
import { t } from '../i18n'
import { newId, newViewLayer, REMOVED_WIDGETS, viewAt, type Border, type ExportSettings, type Keyframe, type Layer, type OverlayLayer, type Project, type Rect, type StabSettings, type ViewLayer, type WidgetKind } from './project'

export const SETTINGS_EXT = '.motorecomovie-settings.json'
/** The app that created the file. Files from the previous name (Insta360 Reframe) are also read */
const APP_ID = 'motorecomovie'
const LEGACY_APP_IDS = ['insta360-reframe']

type View = Omit<Keyframe, 't'>

interface ViewLayerSettings {
  type: 'view'
  name: string
  rect: Rect
  visible: boolean
  /** Direction (view of a layer with a single keyframe. For layers with motion such as main, the keyframes of the target are kept) */
  view: View
  /** Whether the direction was moving when saved (had 2 or more keyframes) */
  animated: boolean
  border?: Border
  signs?: boolean
  signStyle?: 'real' | 'cyber'
  signAhead?: number
  role?: 'incident'
}

interface OverlayLayerSettings {
  type: 'overlay'
  name: string
  rect: Rect
  visible: boolean
  widget: WidgetKind
  props: Record<string, unknown>
}

export interface SettingsFile {
  app: string
  kind: 'settings'
  version: 1
  savedAt: string
  stab: Omit<StabSettings, 'seam'>
  layers: (ViewLayerSettings | OverlayLayerSettings)[]
  director: DirectorSettings
  incident: Omit<IncidentSettings, 'skip'>
  /** Tidy the riding audio (absent in settings files from earlier versions) */
  audioFx?: AudioFx
  export: Omit<ExportSettings, 'inSec' | 'outSec'>
}

/** Build the contents of a settings file from the current project */
export function settingsFromProject(p: Project): SettingsFile {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seam: _seam, ...stab } = p.stab
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { skip: _skip, ...incident } = p.incident
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { inSec: _in, outSec: _out, ...ex } = p.export
  const layers = p.layers.map((l): ViewLayerSettings | OverlayLayerSettings =>
    l.type === 'view'
      ? {
          type: 'view',
          name: l.name,
          rect: { ...l.rect },
          visible: l.visible,
          view: viewAt(l.keyframes, 0),
          animated: l.keyframes.length > 1,
          ...(l.border && { border: { ...l.border } }),
          ...(l.signs !== undefined && { signs: l.signs }),
          ...(l.signStyle && { signStyle: l.signStyle }),
          ...(l.signAhead !== undefined && { signAhead: l.signAhead }),
          ...(l.role && { role: l.role })
        }
      : { type: 'overlay', name: l.name, rect: { ...l.rect }, visible: l.visible, widget: l.widget, props: structuredClone(l.props) }
  )
  return {
    app: APP_ID,
    kind: 'settings',
    version: 1,
    savedAt: new Date().toISOString(),
    stab,
    layers,
    director: structuredClone(p.director),
    incident,
    audioFx: { ...p.audioFx },
    export: ex
  }
}

/** Parse the file text. Throws if it is not a settings file */
export function parseSettings(text: string): SettingsFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(t('Not a settings file (not valid JSON)'))
  }
  const s = raw as Partial<SettingsFile>
  if (!s || !(s.app === APP_ID || LEGACY_APP_IDS.includes(s.app ?? '')) || s.kind !== 'settings' || !Array.isArray(s.layers)) throw new Error(t('Not a settings file'))
  if ((s.version ?? 1) > 1) throw new Error(t('This settings file was saved by a newer version of the app'))
  return s as SettingsFile
}

/**
 * Apply the contents of a settings file to the project.
 * Layers are replaced with the order in the file. A view layer takes over the matching layer in the target (own-bike screen by role, others by name;
 * if not found, in order from the top), and one whose direction is moving (2 or more keyframes) keeps its keyframes
 * @param sameName whether the names are the same (pass a comparison that treats default names as the same across languages)
 */
export function applySettings(p: Project, s: SettingsFile, sameName: (a: string, b: string) => boolean = (a, b) => a === b): Project {
  const oldViews = p.layers.filter((l): l is ViewLayer => l.type === 'view')
  const used = new Set<string>()
  const take = (pred: (l: ViewLayer) => boolean): ViewLayer | undefined => {
    const l = oldViews.find((x) => !used.has(x.id) && pred(x))
    if (l) used.add(l.id)
    return l
  }
  // First match by role and name, then assign the rest in order
  const match = new Map<number, ViewLayer | undefined>()
  s.layers.forEach((x, i) => {
    if (x.type !== 'view') return
    match.set(i, x.role ? take((l) => l.role === x.role) : take((l) => !l.role && sameName(l.name, x.name)))
  })
  s.layers.forEach((x, i) => {
    if (x.type === 'view' && !match.get(i) && !x.role) match.set(i, take((l) => !l.role))
  })
  const layers: Layer[] = s.layers.flatMap((x, i): Layer[] => {
    // Removed overlays (meter set, speedometer to outside temperature) are not included
    if (x.type === 'overlay' && REMOVED_WIDGETS.includes(x.widget as string)) return []
    if (x.type === 'overlay') {
      const o: OverlayLayer = { id: newId(), type: 'overlay', name: x.name, rect: { ...x.rect }, visible: x.visible, widget: x.widget, props: structuredClone(x.props ?? {}) }
      return [o]
    }
    const old = match.get(i)
    // A target layer whose direction is moving keeps its keyframes. Otherwise use the direction in the file
    const keyframes = old && old.keyframes.length > 1 ? old.keyframes : [{ t: 0, ...x.view }]
    const base = old ?? newViewLayer(x.name)
    const v: ViewLayer = {
      id: base.id,
      type: 'view',
      name: x.name,
      rect: { ...x.rect },
      visible: x.visible,
      keyframes,
      ...(x.border && { border: { ...x.border } }),
      ...(x.signs !== undefined && { signs: x.signs }),
      ...(x.signStyle && { signStyle: x.signStyle }),
      ...(x.signAhead !== undefined && { signAhead: x.signAhead }),
      ...(x.role && { role: x.role })
    }
    return [v]
  })
  // If the settings file has no view layer at all, keep the current view layers (so the video does not disappear)
  const hasView = layers.some((l) => l.type === 'view')
  return {
    ...p,
    stab: { ...p.stab, ...s.stab, seam: p.stab.seam },
    layers: hasView ? layers : [...oldViews, ...layers],
    director: mergeDirector(s.director),
    incident: { ...mergeIncident(s.incident), skip: p.incident.skip },
    audioFx: s.audioFx ? { ...DEFAULT_AUDIO_FX, ...s.audioFx } : p.audioFx,
    export: { ...p.export, ...s.export, inSec: p.export.inSec, outSec: p.export.outSec }
  }
}
