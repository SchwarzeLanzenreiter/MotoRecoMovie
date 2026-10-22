// The design themes (one per motorcycle maker). To add one: write a Theme in its own file and list it here
import type { Theme, ThemeId } from '../theme'
import { BMW } from './bmw'
import { DUCATI } from './ducati'
import { HONDA } from './honda'
import { KAWASAKI } from './kawasaki'
import { KTM } from './ktm'
import { SUZUKI } from './suzuki'
import { TRIUMPH } from './triumph'
import { YAMAHA } from './yamaha'
import { WAFU } from './wafu'
import { AINU } from './ainu'

/** In the order shown in the UI: the makers alphabetically, then the others */
export const THEMES: Theme[] = [BMW, DUCATI, HONDA, KAWASAKI, KTM, SUZUKI, TRIUMPH, YAMAHA, WAFU, AINU]

export const DEFAULT_THEME: ThemeId = 'bmw'

export function getTheme(id: ThemeId | string | undefined): Theme {
  return THEMES.find((x) => x.id === id) ?? BMW
}
