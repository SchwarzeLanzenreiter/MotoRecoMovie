import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** One entry of the history of opened videos (same shape as recent.json in main/index.ts) */
export interface RecentEntry {
  path: string
  name: string
  openedAt: number
  durationSec?: number
  model?: string
  hasLog?: boolean
  thumb?: string
}

// Open file handles (only the number is passed to the renderer)
const handles = new Map<number, fsp.FileHandle>()
let nextId = 1

const api = {
  openDialog: (opts: Electron.OpenDialogOptions): Promise<string[] | null> => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts: Electron.SaveDialogOptions): Promise<string | null> => ipcRenderer.invoke('dialog:save', opts),
  runFfmpeg: (args: string[], opts?: { background?: boolean }): Promise<{ code: number; log: string }> => ipcRenderer.invoke('ffmpeg:run', args, opts),
  /** App cache folder (tidied audio, etc.) */
  cacheDir: (): Promise<string> => ipcRenderer.invoke('app:cacheDir'),
  /** Folder of the logos the user chose for the meter (logos.json and the copied images) */
  logoDir: (): Promise<string> => ipcRenderer.invoke('app:logoDir'),

  async open(path: string, flags: 'r' | 'w' = 'r'): Promise<{ id: number; size: number }> {
    const h = await fsp.open(path, flags)
    const id = nextId++
    handles.set(id, h)
    const st = await h.stat()
    return { id, size: st.size }
  },
  /** Read length bytes from offset (for random access into huge files) */
  async read(id: number, offset: number, length: number): Promise<Uint8Array> {
    const h = handles.get(id)
    if (!h) throw new Error('File is not open')
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
    if (!h) throw new Error('File is not open')
    await h.write(data, 0, data.length, position)
  },
  async close(id: number): Promise<void> {
    await handles.get(id)?.close()
    handles.delete(id)
  },
  readText: (path: string): Promise<string> => fsp.readFile(path, 'utf-8'),
  readBinary: async (path: string): Promise<Uint8Array> => new Uint8Array(await fsp.readFile(path)),
  copyFile: (src: string, dst: string): Promise<void> => fsp.copyFile(src, dst),
  // In automated tests, do not overwrite the edits next to the video (.motorecomovie.json, or .reframe.json under the previous name) (to protect the real edits)
  writeText: async (path: string, text: string): Promise<void> => {
    if (process.env['REFRAME_AUTOTEST'] && (path.endsWith('.motorecomovie.json') || path.endsWith('.reframe.json'))) return
    await fsp.writeFile(path, text, 'utf-8')
  },
  // In automated tests, also do not write the own-bike seam template next to the video (.motorecomovie-body.bin)
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
  /** Contents of a folder (name, whether it is a folder, size) */
  async listDirEntries(path: string): Promise<{ name: string; dir: boolean; size: number }[]> {
    const ents = await fsp.readdir(path, { withFileTypes: true })
    const out: { name: string; dir: boolean; size: number }[] = []
    for (const e of ents) {
      if (e.isDirectory()) out.push({ name: e.name, dir: true, size: 0 })
      else if (e.isFile()) {
        try {
          out.push({ name: e.name, dir: false, size: (await fsp.stat(join(path, e.name))).size })
        } catch {
          /* skip files that have disappeared */
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
  /** Tell the main menu the language */
  setMenuLang: (lang: 'ja' | 'en'): Promise<void> => ipcRenderer.invoke('menu:lang', lang),
  /** Receive main menu actions ('open' | 'close'). The return value unsubscribes */
  onMenu: (cb: (action: string) => void): (() => void) => {
    const h = (_e: unknown, action: string): void => cb(action)
    ipcRenderer.on('menu', h)
    return () => ipcRenderer.removeListener('menu', h)
  },
  /** Real path of a dropped File (drag and drop) */
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
