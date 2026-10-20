// レイヤーの名前の表示。作ったときの言語のまま保存されている「既定の名前」（メイン・後ろ・サイバー風メーター・
// 視点 2 など）は、今の画面の言語で表示する（日本語・英語のどちらで作った名前でも）。自分で付けた名前はそのまま。
import { tr, t } from '../i18n'
import { WIDGET_NAMES } from '../render/overlay'

/** 既定の名前（日本語の原文） */
const DEFAULTS = ['メイン', '後ろ', '左', '右', '自車（挙動の乱れ）', ...Object.values(WIDGET_NAMES)] // i18n-ignore

const VIEW_N = /^(?:視点|View) (\d+)$/ // i18n-ignore

export function layerName(name: string): string {
  for (const ja of DEFAULTS) if (name === ja || name === tr('en', ja)) return t(ja)
  const m = VIEW_N.exec(name)
  if (m) return t('視点 {n}', { n: m[1] })
  return name
}
