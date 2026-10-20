// Display of layer names. Default names (Main, Back, Cyber meter, View 2, ...) are stored in whatever language
// was active when the layer was created; show them in the current UI language either way. Custom names stay as they are.
import { tr, t } from '../i18n'
import { WIDGET_NAMES } from '../render/overlay'

/** Default names (English source strings) */
const DEFAULTS = ['Main', 'Back', 'Left', 'Right', 'Own bike (disturbance)', ...Object.values(WIDGET_NAMES)] // i18n-ignore

/** "View 3" in either language */
const VIEW_N = new RegExp('^(?:View |' + tr('ja', 'View {n}').replace('{n}', '') + ')(\\d+)$')

export function layerName(name: string): string {
  for (const en of DEFAULTS) if (name === en || name === tr('ja', en)) return t(en)
  const m = VIEW_N.exec(name)
  if (m) return t('View {n}', { n: m[1] })
  return name
}
