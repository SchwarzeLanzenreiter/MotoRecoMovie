import { useEffect, useState } from 'react'
import { getLang, onLangChange, type Lang } from '../i18n'

/** 画面の言語（切り替わると呼び出したコンポーネントを描き直す） */
export function useLang(): Lang {
  const [lang, setLang] = useState<Lang>(getLang())
  useEffect(() => onLangChange(setLang), [])
  return lang
}
