// Vehicle log settings (remembered on this PC): the .dat conversion rules (.ddf) and the folder to search for .dat files
export interface LogPrefs {
  /** Same conversion rules file as MotoRecoViewer (.ddf) */
  ddfPath: string | null
  /** Folder holding the MotoReco .dat files (subfolders are searched too) */
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
    /* works even if it cannot be remembered */
  }
}
