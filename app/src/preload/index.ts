import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 開いた動画の履歴の1件（main/index.ts の recent.json と同じ形） */
export interface RecentEntry {
  path: string
  name: string
  openedAt: number
  durationSec?: number
  model?: string
  hasLog?: boolean
  thumb?: string
}

// 開いているファイルハンドル（レンダラーには番号だけを渡す）
const handles = new Map<number, fsp.FileHandle>()
let nextId = 1

const api = {
  openDialog: (opts: Electron.OpenDialogOptions): Promise<string[] | null> => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts: Electron.SaveDialogOptions): Promise<string | null> => ipcRenderer.invoke('dialog:save', opts),
  runFfmpeg: (args: string[]): Promise<{ code: number; log: string }> => ipcRenderer.invoke('ffmpeg:run', args),
  /** アプリのキャッシュのフォルダ（整えた音声など） */
  cacheDir: (): Promise<string> => ipcRenderer.invoke('app:cacheDir'),

  async open(path: string, flags: 'r' | 'w' = 'r'): Promise<{ id: number; size: number }> {
    const h = await fsp.open(path, flags)
    const id = nextId++
    handles.set(id, h)
    const st = await h.stat()
    return { id, size: st.size }
  },
  /** offset から length バイトを読む（巨大ファイルのランダムアクセス用） */
  async read(id: number, offset: number, length: number): Promise<Uint8Array> {
    const h = handles.get(id)
    if (!h) throw new Error('ファイルが開かれていません')
    const buf = new Uint8Array(length)
    let done = 0
    while (done < length) {
      const { bytesRead } = await h.read(buf, done, length - done, offset + done)
      if (bytesRead === 0) break
      done += bytesRead
    }
    return done === length ? buf : buf.subarray(0, done)
  },
  async write(id: number, data: Uint8Array, position: number | null = null): Promise<void> {
    const h = handles.get(id)
    if (!h) throw new Error('ファイルが開かれていません')
    await h.write(data, 0, data.length, position)
  },
  async close(id: number): Promise<void> {
    await handles.get(id)?.close()
    handles.delete(id)
  },
  readText: (path: string): Promise<string> => fsp.readFile(path, 'utf-8'),
  // 自動テストでは、動画の横の編集内容（.motorecomovie.json、前の名前の .reframe.json）を書き換えない（実際の編集内容を守るため）
  writeText: async (path: string, text: string): Promise<void> => {
    if (process.env['REFRAME_AUTOTEST'] && (path.endsWith('.motorecomovie.json') || path.endsWith('.reframe.json'))) return
    await fsp.writeFile(path, text, 'utf-8')
  },
  // 自動テストでは、動画の横の自車の継ぎ目の型（.motorecomovie-body.bin）も書かない
  writeBinary: async (path: string, data: Uint8Array): Promise<void> => {
    if (process.env['REFRAME_AUTOTEST'] && path.endsWith('.motorecomovie-body.bin')) return
    await fsp.writeFile(path, data)
  },
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path)
      return true
    } catch {
      return false
    }
  },
  async listDir(path: string): Promise<string[]> {
    return await fsp.readdir(path)
  },
  /** フォルダの中身（名前・フォルダかどうか・大きさ） */
  async listDirEntries(path: string): Promise<{ name: string; dir: boolean; size: number }[]> {
    const ents = await fsp.readdir(path, { withFileTypes: true })
    const out: { name: string; dir: boolean; size: number }[] = []
    for (const e of ents) {
      if (e.isDirectory()) out.push({ name: e.name, dir: true, size: 0 })
      else if (e.isFile()) {
        try {
          out.push({ name: e.name, dir: false, size: (await fsp.stat(join(path, e.name))).size })
        } catch {
          /* 消えたファイルは飛ばす */
        }
      }
    }
    return out
  },
  unlink: (path: string): Promise<void> => fsp.unlink(path),
  path: { basename, dirname, join },
  recent: {
    list: (): Promise<(RecentEntry & { exists: boolean; edited: boolean })[]> => ipcRenderer.invoke('recent:list'),
    add: (e: RecentEntry): Promise<void> => ipcRenderer.invoke('recent:add', e),
    update: (path: string, patch: Partial<RecentEntry>): Promise<void> => ipcRenderer.invoke('recent:update', path, patch),
    remove: (path: string): Promise<void> => ipcRenderer.invoke('recent:remove', path)
  },
  /** メインメニューの言語を伝える */
  setMenuLang: (lang: 'ja' | 'en'): Promise<void> => ipcRenderer.invoke('menu:lang', lang),
  /** メインメニューの操作（'open' | 'close'）を受け取る。戻り値で解除 */
  onMenu: (cb: (action: string) => void): (() => void) => {
    const h = (_e: unknown, action: string): void => cb(action)
    ipcRenderer.on('menu', h)
    return () => ipcRenderer.removeListener('menu', h)
  },
  /** ドラッグ＆ドロップされた File の実パス */
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  test: {
    env: (): Promise<{ autotest: string | null; args: string | null }> => ipcRenderer.invoke('test:env'),
    capture: (path: string): Promise<void> => ipcRenderer.invoke('test:capture', path),
    mouse: (x: number, y: number): Promise<void> => ipcRenderer.invoke('test:mouse', x, y),
    quit: (): Promise<void> => ipcRenderer.invoke('test:quit')
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
