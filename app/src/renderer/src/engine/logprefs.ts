// 車両ログの設定（このパソコンに覚えておく）: .dat の変換規則（.ddf）と、.dat を探すフォルダ
export interface LogPrefs {
  /** MotoRecoViewer と同じ変換規則のファイル（.ddf） */
  ddfPath: string | null
  /** MotoReco の .dat を置いているフォルダ（その下のフォルダも探す） */
  datFolder: string | null
}

const KEY = 'reframe.logPrefs'

export function loadLogPrefs(): LogPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LogPrefs>
    return { ddfPath: v.ddfPath ?? null, datFolder: v.datFolder ?? null }
  } catch {
    return { ddfPath: null, datFolder: null }
  }
}

export function saveLogPrefs(p: LogPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* 覚えられなくても使える */
  }
}
