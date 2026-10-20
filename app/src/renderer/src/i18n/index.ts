// Display language (Japanese / English).
//
// Strings are written in English in the source and wrapped in t('English'). For Japanese they are looked up in the dictionaries (ja-*.ts).
//   - Interpolation uses {name}, as in t('{n} items', { n }) (the Japanese side uses the same names)
//   - Strings missing from the dictionary are shown in English (test/i18n.test.ts checks for gaps)
// The UI language is remembered on this PC. Text burned into the video (disturbance labels, subtitle headings, etc.)
// can be chosen per project (project.export.textLang; defaults to the UI language).
import { JA_UI } from './ja-ui'
import { JA_PANEL } from './ja-panel'
import { JA_RENDER } from './ja-render'
import { JA_ENGINE } from './ja-engine'
import { JA_MENU } from './ja-menu'

export type Lang = 'ja' | 'en'

const JA: Record<string, string> = { ...JA_UI, ...JA_PANEL, ...JA_RENDER, ...JA_ENGINE, ...JA_MENU }

const KEY = 'reframe.lang'

function initial(): Lang {
  try {
    const v = globalThis.localStorage?.getItem(KEY)
    if (v === 'ja' || v === 'en') return v
  } catch {
    /* storage unavailable (tests, etc.) */
  }
  const nav = (globalThis.navigator?.language ?? 'ja').toLowerCase()
  return nav.startsWith('ja') ? 'ja' : 'en'
}

let current: Lang = initial()
const listeners = new Set<(l: Lang) => void>()

export function getLang(): Lang {
  return current
}

export function setLang(l: Lang): void {
  if (l === current) return
  current = l
  try {
    globalThis.localStorage?.setItem(KEY, l)
  } catch {
    /* switching still works even if it cannot be remembered */
  }
  if (globalThis.document) document.documentElement.lang = l
  for (const f of listeners) f(l)
}

export function onLangChange(f: (l: Lang) => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

const fill = (s: string, vars?: Record<string, string | number>): string => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s)

/** Translate into a given language (for text burned into the video, which may differ from the UI language) */
export function tr(lang: Lang, en: string, vars?: Record<string, string | number>): string {
  return fill(lang === 'ja' ? (JA[en] ?? en) : en, vars)
}

/** Translate into the UI language */
export function t(en: string, vars?: Record<string, string | number>): string {
  return tr(current, en, vars)
}

/** Language names, each written in its own language */
export const LANG_NAMES: [Lang, string][] = [
  ['ja', tr('ja', 'Japanese')],
  ['en', 'English']
]

/** Dictionary (for tests) */
export const JA_DICT: Readonly<Record<string, string>> = JA
