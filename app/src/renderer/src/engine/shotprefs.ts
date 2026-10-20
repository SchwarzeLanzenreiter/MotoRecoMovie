// Default values of auto-generated views (ShotViews; remembered on this PC): front, corner entry, side, rear
import { DEFAULT_SHOT_VIEWS, mergeShotViews, type ShotViews } from './director'

const KEY = 'reframe.shotViews'

export function loadShotViews(): ShotViews {
  try {
    return mergeShotViews(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return structuredClone(DEFAULT_SHOT_VIEWS)
  }
}

export function saveShotViews(v: ShotViews): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    /* works even if it cannot be remembered */
  }
}
