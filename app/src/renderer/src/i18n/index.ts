// 表示の言語（日本語・英語）。
//
// 文字列はソースに日本語のまま書き、t('日本語') で包む。英語のときは辞書（en-*.ts）から引く。
//   ・差し込みは t('{n} 件', { n }) のように {名前} で書く（辞書の英語側も同じ名前を使う）
//   ・辞書に無いものは日本語のまま出す（test/i18n.test.ts で漏れを確かめる）
// 画面（UI）の言語はこのパソコンに覚えておく。動画に入る文字（挙動の乱れの表示・字幕の見出しなど）は
// プロジェクトごとに選べる（project.export.textLang。省略時は画面と同じ）。
import { EN_UI } from './en-ui'
import { EN_PANEL } from './en-panel'
import { EN_RENDER } from './en-render'
import { EN_ENGINE } from './en-engine'

export type Lang = 'ja' | 'en'

const EN: Record<string, string> = { ...EN_UI, ...EN_PANEL, ...EN_RENDER, ...EN_ENGINE }

const KEY = 'reframe.lang'

function initial(): Lang {
  try {
    const v = globalThis.localStorage?.getItem(KEY)
    if (v === 'ja' || v === 'en') return v
  } catch {
    /* 保存できない環境（テストなど） */
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
    /* 覚えられなくても切り替えはできる */
  }
  if (globalThis.document) document.documentElement.lang = l
  for (const f of listeners) f(l)
}

export function onLangChange(f: (l: Lang) => void): () => void {
  listeners.add(f)
  return () => listeners.delete(f)
}

const fill = (s: string, vars?: Record<string, string | number>): string => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s)

/** 言語を指定して訳す（動画に入る文字など、画面の言語と別にしたいとき） */
export function tr(lang: Lang, ja: string, vars?: Record<string, string | number>): string {
  return fill(lang === 'en' ? (EN[ja] ?? ja) : ja, vars)
}

/** 画面の言語で訳す */
export function t(ja: string, vars?: Record<string, string | number>): string {
  return tr(current, ja, vars)
}

/** 辞書（テスト用） */
export const EN_DICT: Readonly<Record<string, string>> = EN
