// タイムラインのキーフレーム（◆）の色: 自動生成のショットの種類ごと。手で置いたもの・注目ポイントは青
import type { KeyTag } from '../engine/project'

export const MANUAL_KEY_COLOR = '#4f9cf9'

export const KEY_COLORS: Record<KeyTag, string> = {
  front: '#e6e9ef', // 前方: 白
  corner: '#3ddc84', // コーナー入口: 緑
  side: '#c084fc', // 側方: 紫
  rear: '#ff6fae', // 後方: ピンク
  overtake: '#ffe14a' // 追い越し: 黄色
}

export const KEY_TAG_NAMES: Record<KeyTag, string> = {
  front: '前方', // i18n-ignore
  corner: 'コーナー入口', // i18n-ignore
  side: '側方', // i18n-ignore
  rear: '後方', // i18n-ignore
  overtake: '追い越し' // i18n-ignore
}

export const keyColor = (tag: KeyTag | undefined): string => (tag ? KEY_COLORS[tag] : MANUAL_KEY_COLOR)
