// Timeline keyframe (◆) colors, per kind of auto-generated shot. Hand-placed keyframes are blue
import type { KeyTag } from '../engine/project'

export const MANUAL_KEY_COLOR = '#4f9cf9'

export const KEY_COLORS: Record<KeyTag, string> = {
  front: '#e6e9ef', // front: white
  corner: '#3ddc84', // corner entry: green
  side: '#c084fc', // side: purple
  rear: '#ff6fae', // rear: pink
  overtake: '#ffe14a' // overtake: yellow
}

export const KEY_TAG_NAMES: Record<KeyTag, string> = {
  front: 'Forward', // i18n-ignore
  corner: 'Corner entry', // i18n-ignore
  side: 'Side', // i18n-ignore
  rear: 'Rear', // i18n-ignore
  overtake: 'Overtake' // i18n-ignore
}

export const keyColor = (tag: KeyTag | undefined): string => (tag ? KEY_COLORS[tag] : MANUAL_KEY_COLOR)
