import { useEffect, useState } from 'react'
import { getLang, onLangChange, type Lang } from '../i18n'

/** UI language (the calling component re-renders when it changes) */
export function useLang(): Lang {
  const [lang, setLang] = useState<Lang>(getLang())
  useEffect(() => onLangChange(setLang), [])
  return lang
}
