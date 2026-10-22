import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { constants, setPriority, tmpdir } from 'node:os'
import { JA_MENU } from '../renderer/src/i18n/ja-menu'

// In automated tests, use a temporary folder as the user data so the real history and settings are not polluted.
// Also stop the occlusion check so it keeps drawing even when hidden behind other windows (for screen capture)
if (process.env['REFRAME_AUTOTEST']) {
  process.stdout.write(`[main] user data (normal): ${app.getPath('userData')}\n`)
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'reframe-test-')))
  // REFRAME_TEST_MASKS: a cache folder whose own-bike masks are copied in (they take minutes to build; the originals are not touched)
  const masks = process.env['REFRAME_TEST_MASKS']
  if (masks && existsSync(masks)) {
    const dst = join(app.getPath('userData'), 'cache')
    mkdirSync(dst, { recursive: true })
    for (const f of readdirSync(masks)) if (/^bikemask-.*\.bin$/.test(f)) cpSync(join(masks, f), join(dst, f))
  }
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
} else {
  // The app was renamed from "Insta360 Reframe" to "MotoRecoMovie". The user data folder is also determined by the name,
  // so if the new folder does not exist yet, copy the folder of the previous name (recently opened videos, UI language, log settings, default views, etc.) to carry it over.
  // Rebuildable caches are not copied
  const cur = app.getPath('userData')
  const old = join(app.getPath('appData'), 'insta360-reframe')
  if (!existsSync(cur) && existsSync(old)) {
    const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage'])
    try {
      cpSync(old, cur, { recursive: true, filter: (src) => !SKIP.has(src.slice(old.length + 1).split(/[\\/]/)[0]) })
    } catch (e) {
      console.error('Could not carry over the user data of the previous name', e)
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#1b1d22',
    title: 'MotoRecoMovie',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      // So preview audio can start immediately (the app only handles local files)
      autoplayPolicy: 'no-user-gesture-required',
      // Because the preload uses fs to randomly access huge .insv files
      sandbox: false,
      // Do not throttle timers even when hidden behind other windows or minimized (so export does not slow down)
      backgroundThrottling: false
    }
  })
  // Print Screen saves a screenshot of the frame (renderer: engine/screenshot.ts). Windows may keep the key for itself (Snipping Tool),
  // so it is taken as a shortcut while the window has the focus only; if that fails, the renderer still gets the key release
  win.on('focus', () => {
    if (!globalShortcut.isRegistered('PrintScreen')) globalShortcut.register('PrintScreen', () => win.webContents.send('menu', 'screenshot'))
  })
  win.on('blur', () => globalShortcut.unregister('PrintScreen'))
  win.on('closed', () => globalShortcut.unregister('PrintScreen'))
  // Automated test mode: forward the renderer logs to stdout
  if (process.env['REFRAME_AUTOTEST']) {
    win.webContents.on('console-message', (e) => {
      process.stdout.write(`[renderer:${e.level}] ${e.message}\n`)
    })
  }
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('dialog:open', async (_e, opts: Electron.OpenDialogOptions) => {
  const r = await dialog.showOpenDialog(opts)
  return r.canceled ? null : r.filePaths
})

ipcMain.handle('dialog:save', async (_e, opts: Electron.SaveDialogOptions) => {
  const r = await dialog.showSaveDialog(opts)
  return r.canceled ? null : r.filePath
})

// Run ffmpeg and return the exit code and the tail of stderr (used for audio muxing, etc.)
/** License notices file (next to the app in a distribution; inside build during development) */
function noticesPath(): string {
  return app.isPackaged ? join(dirname(process.execPath), 'THIRD-PARTY-NOTICES.txt') : join(app.getAppPath(), 'build', 'THIRD-PARTY-NOTICES.txt')
}

// Bundled ffmpeg (LGPL build, resources/ffmpeg. Distributed as resources/ffmpeg for export). If absent, ffmpeg on PATH
let ffmpegCache: string | null = null
function ffmpegPath(): string {
  if (ffmpegCache) return ffmpegCache
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = app.isPackaged ? [join(process.resourcesPath, 'ffmpeg', exe)] : [join(app.getAppPath(), 'resources', 'ffmpeg', exe)]
  ffmpegCache = candidates.find((c) => existsSync(c)) ?? 'ffmpeg'
  if (process.env['REFRAME_AUTOTEST']) process.stdout.write(`[main] ffmpeg: ${ffmpegCache}
`)
  return ffmpegCache
}

// App cache (tidied audio, etc.; anything that can be rebuilt even if deleted)
ipcMain.handle('app:cacheDir', async () => {
  const dir = join(app.getPath('userData'), 'cache')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  return dir
})
// Logos the user chose for the meter (logos.json and the copied images; kept until the user removes them)
ipcMain.handle('app:logoDir', async () => {
  const dir = join(app.getPath('userData'), 'logos')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  return dir
})
// background: work built ahead of time (the tidied audio). It runs at idle priority so that playback keeps the CPU
ipcMain.handle('ffmpeg:run', async (_e, args: string[], opts?: { background?: boolean }) => {
  return await new Promise<{ code: number; log: string }>((resolve) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true })
    if (opts?.background && p.pid !== undefined) {
      try {
        setPriority(p.pid, constants.priority.PRIORITY_LOW)
      } catch {
        /* runs at normal priority */
      }
    }
    let log = ''
    p.stderr.on('data', (d) => {
      log = (log + d.toString()).slice(-8000)
    })
    p.on('error', (err) => resolve({ code: -1, log: String(err) }))
    p.on('close', (code) => resolve({ code: code ?? -1, log }))
  })
})

// ---- History of opened videos (recent.json in the user data) ----
export interface RecentEntry {
  path: string
  name: string
  openedAt: number // epoch ms
  durationSec?: number
  model?: string
  hasLog?: boolean
  thumb?: string // shrunken preview (JPEG data URL)
}
const RECENT_MAX = 12
const recentFile = (): string => join(app.getPath('userData'), 'recent.json')
function readRecent(): RecentEntry[] {
  try {
    const a = JSON.parse(readFileSync(recentFile(), 'utf-8'))
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}
const writeRecent = (a: RecentEntry[]): void => writeFileSync(recentFile(), JSON.stringify(a.slice(0, RECENT_MAX), null, 1), 'utf-8')
/** Windows paths are compared ignoring differences in separators and letter case */
const normPath = (p: string): string => p.split('\\').join('/').toLowerCase()
const samePath = (a: string, b: string): boolean => normPath(a) === normPath(b)

/** List (also adds whether the file still exists and whether the edits are saved) */
ipcMain.handle('recent:list', () =>
  readRecent().map((e) => ({ ...e, exists: existsSync(e.path), edited: existsSync(e.path + '.motorecomovie.json') || existsSync(e.path + '.reframe.json') }))
)
/** Add (move the same file to the top; carry over earlier values such as the thumbnail) */
ipcMain.handle('recent:add', (_e, entry: RecentEntry) => {
  const list = readRecent()
  const old = list.find((x) => samePath(x.path, entry.path))
  writeRecent([{ ...old, ...entry, thumb: entry.thumb ?? old?.thumb }, ...list.filter((x) => !samePath(x.path, entry.path))])
})
ipcMain.handle('recent:update', (_e, path: string, patch: Partial<RecentEntry>) => {
  writeRecent(readRecent().map((x) => (samePath(x.path, path) ? { ...x, ...patch } : x)))
})
ipcMain.handle('recent:remove', (_e, path: string) => {
  writeRecent(readRecent().filter((x) => !samePath(x.path, path)))
})

// ---- For automated tests ----
ipcMain.handle('test:env', () => ({
  autotest: process.env['REFRAME_AUTOTEST'] ?? null,
  args: process.env['REFRAME_TEST_ARGS'] ?? null
}))
ipcMain.handle('test:capture', async (e, path: string) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  // The previously drawn screen may be returned, so discard it once and capture again.
  // It also fails temporarily at times (UnknownVizError, etc.), so retry a few times
  await win.webContents.capturePage().catch(() => null)
  await new Promise((r) => setTimeout(r, 150))
  let img: Electron.NativeImage | null = null
  for (let k = 0; k < 3 && !img; k++) {
    try {
      img = await win.webContents.capturePage()
    } catch (err) {
      if (k === 2) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, img!.toPNG())
})
// Move the real mouse (to check CSS :hover)
ipcMain.handle('test:mouse', (e, x: number, y: number) => {
  e.sender.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
})
ipcMain.handle('test:quit', () => app.quit())

// ---- Main menu (rebuilt to match the UI language) ----
type MenuLang = 'ja' | 'en'
const MENU_EN: Record<string, string> = {
  file: 'File', open: 'Open…', close: 'Close', quit: 'Quit',
  edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all',
  view: 'View', reload: 'Reload', devTools: 'Developer tools', resetZoom: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fullscreen: 'Full screen',
  window: 'Window', minimize: 'Minimize', closeWindow: 'Close window',
  settings: 'Settings', shotViews: 'Auto-generated views…',
  help: 'Help', licenses: 'License information…', about: 'About MotoRecoMovie…',
  aboutTitle: 'About MotoRecoMovie', version: 'Version', mit: 'Free software under the MIT License', github: 'Open on GitHub'
}
const REPO_URL = 'https://github.com/SchwarzeLanzenreiter/MotoRecoMovie'

/** Text of the About dialog: the app's version (package.json) and the versions of the runtime it is built on */
function aboutText(lang: MenuLang): { title: string; message: string; detail: string } {
  const m = MENU_TEXT[lang]
  return {
    title: m.aboutTitle,
    message: `MotoRecoMovie ${m.version} ${app.getVersion()}`,
    detail: [
      `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node.js ${process.versions.node}`,
      '',
      m.mit,
      REPO_URL
    ].join('\n')
  }
}

async function showAbout(lang: MenuLang): Promise<void> {
  const m = MENU_TEXT[lang]
  const win = BrowserWindow.getFocusedWindow()
  const opts = { ...aboutText(lang), type: 'info' as const, buttons: ['OK', m.github], defaultId: 0, cancelId: 0, noLink: true }
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (r.response === 1) await shell.openExternal(REPO_URL)
}
const MENU_TEXT: Record<MenuLang, Record<string, string>> = {
  ja: Object.fromEntries(Object.entries(MENU_EN).map(([k, en]) => [k, JA_MENU[en] ?? en])),
  en: MENU_EN
}
/** The menu items "Open", "Close" and "Settings" are handled by the screen (renderer) */
const sendMenu = (action: string): void => BrowserWindow.getFocusedWindow()?.webContents.send('menu', action)
function buildMenu(lang: MenuLang): void {
  const m = MENU_TEXT[lang]
  const tpl: MenuItemConstructorOptions[] = [
    {
      label: m.file,
      submenu: [
        { label: m.open, accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: m.close, click: () => sendMenu('close') },
        { type: 'separator' },
        { label: m.quit, role: 'quit' }
      ]
    },
    {
      label: m.edit,
      submenu: [
        { label: m.undo, role: 'undo' },
        { label: m.redo, role: 'redo' },
        { type: 'separator' },
        { label: m.cut, role: 'cut' },
        { label: m.copy, role: 'copy' },
        { label: m.paste, role: 'paste' },
        { label: m.selectAll, role: 'selectAll' }
      ]
    },
    {
      label: m.view,
      submenu: [
        { label: m.reload, role: 'reload' },
        { label: m.devTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: m.resetZoom, role: 'resetZoom' },
        { label: m.zoomIn, role: 'zoomIn' },
        { label: m.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: m.fullscreen, role: 'togglefullscreen' }
      ]
    },
    {
      label: m.settings,
      submenu: [{ label: m.shotViews, click: () => sendMenu('shotViews') }]
    },
    {
      label: m.window,
      submenu: [
        { label: m.minimize, role: 'minimize' },
        { label: m.closeWindow, role: 'close' }
      ]
    },
    {
      label: m.help,
      submenu: [
        // License notices for software and data made by others (built by tools/notices.ts; placed next to the app in a distribution)
        { label: m.licenses, click: () => void shell.openPath(noticesPath()) },
        { type: 'separator' },
        { label: m.about, click: () => void showAbout(lang) }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl))
  // In automated tests, log the menu headings (the menu does not appear in screen captures)
  if (process.env['REFRAME_AUTOTEST']) {
    process.stdout.write(`[main] menu (${lang}): ${tpl.map((x) => `${x.label}[${(x.submenu as MenuItemConstructorOptions[]).map((y) => y.label ?? '-').join('/')}]`).join(' ')}
`)
    const a = aboutText(lang)
    process.stdout.write(`[main] about (${lang}): ${a.title} | ${a.message} | ${a.detail.replace(/\n/g, ' | ')}\n`)
  }
}
let menuLang: MenuLang | null = null
ipcMain.handle('menu:lang', (_e, lang: MenuLang) => {
  if (lang !== menuLang && (lang === 'ja' || lang === 'en')) {
    menuLang = lang
    buildMenu(lang)
  }
})

app.whenReady().then(() => {
  // Until the language arrives from the screen, build with the OS language
  buildMenu(app.getLocale().toLowerCase().startsWith('ja') ? 'ja' : 'en')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
