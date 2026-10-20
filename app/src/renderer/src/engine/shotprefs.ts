// 自動生成の視点の既定値（ShotViews。このパソコンに覚える）: 前方・コーナー入口・側方・後方
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
    /* 覚えられなくても使える */
  }
}
