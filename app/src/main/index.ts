import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// 自動テストでは実際の履歴や設定を汚さないよう、一時フォルダをユーザーデータにする。
// また、ほかのウィンドウに隠れていても描き続けるよう、隠れているかどうかの判定を止める（画面キャプチャのため）
if (process.env['REFRAME_AUTOTEST']) {
  process.stdout.write(`[main] ユーザーデータ（普段）: ${app.getPath('userData')}\n`)
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'reframe-test-')))
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
} else {
  // アプリの名前を「Insta360 Reframe」から「MotoRecoMovie」に変えた。ユーザーデータのフォルダも名前で決まるので、
  // 新しいフォルダがまだ無ければ、前の名前のフォルダ（最近開いた動画・画面の言語・ログの設定・視点の既定値など）を写して引き継ぐ。
  // 作り直せるキャッシュは写さない
  const cur = app.getPath('userData')
  const old = join(app.getPath('appData'), 'insta360-reframe')
  if (!existsSync(cur) && existsSync(old)) {
    const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage'])
    try {
      cpSync(old, cur, { recursive: true, filter: (src) => !SKIP.has(src.slice(old.length + 1).split(/[\\/]/)[0]) })
    } catch (e) {
      console.error('前の名前のユーザーデータを引き継げませんでした', e)
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
      // プレビューの音声をすぐ鳴らせるように（ローカルファイルだけを扱うアプリなので）
      autoplayPolicy: 'no-user-gesture-required',
      // preload で fs を使って巨大な .insv をランダムアクセスするため
      sandbox: false,
      // ほかのウィンドウに隠れたり最小化したりしても、タイマーを間引かない（書き出しが遅くならないように）
      backgroundThrottling: false
    }
  })
  // 自動テストモード: レンダラーのログを標準出力へ流す
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

// ffmpeg を実行して終了コードと標準エラーの末尾を返す（音声の合成などに使う）
/** ライセンス表示のファイル（配布物ではアプリと同じフォルダ、開発中は build の中） */
function noticesPath(): string {
  return app.isPackaged ? join(dirname(process.execPath), 'THIRD-PARTY-NOTICES.txt') : join(app.getAppPath(), 'build', 'THIRD-PARTY-NOTICES.txt')
}

// 同梱の ffmpeg（LGPL 版、resources/ffmpeg。書き出しのときは resources/ffmpeg として配る）。無ければ PATH の ffmpeg
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

// アプリのキャッシュ（整えた音声など。消しても作り直せるもの）
ipcMain.handle('app:cacheDir', async () => {
  const dir = join(app.getPath('userData'), 'cache')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  return dir
})
ipcMain.handle('ffmpeg:run', async (_e, args: string[]) => {
  return await new Promise<{ code: number; log: string }>((resolve) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true })
    let log = ''
    p.stderr.on('data', (d) => {
      log = (log + d.toString()).slice(-8000)
    })
    p.on('error', (err) => resolve({ code: -1, log: String(err) }))
    p.on('close', (code) => resolve({ code: code ?? -1, log }))
  })
})

// ---- 開いた動画の履歴（ユーザーデータの recent.json）----
export interface RecentEntry {
  path: string
  name: string
  openedAt: number // epoch ms
  durationSec?: number
  model?: string
  hasLog?: boolean
  thumb?: string // 縮小したプレビュー（JPEG の data URL）
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
/** Windows のパスは区切り文字と大文字小文字の違いを無視して比べる */
const normPath = (p: string): string => p.split('\\').join('/').toLowerCase()
const samePath = (a: string, b: string): boolean => normPath(a) === normPath(b)

/** 一覧（ファイルがまだあるか、編集内容が保存されているかも付ける） */
ipcMain.handle('recent:list', () =>
  readRecent().map((e) => ({ ...e, exists: existsSync(e.path), edited: existsSync(e.path + '.motorecomovie.json') || existsSync(e.path + '.reframe.json') }))
)
/** 追加（同じファイルは先頭へ移す。サムネイルなどは前の値を引き継ぐ） */
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

// ---- 自動テスト用 ----
ipcMain.handle('test:env', () => ({
  autotest: process.env['REFRAME_AUTOTEST'] ?? null,
  args: process.env['REFRAME_TEST_ARGS'] ?? null
}))
ipcMain.handle('test:capture', async (e, path: string) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  // 直前に描かれた画面が返ることがあるので一度捨てて撮り直す。
  // また一時的に失敗することがある（UnknownVizError など）ので数回やり直す
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
// 本物のマウスを動かす（CSS の :hover を確かめるため）
ipcMain.handle('test:mouse', (e, x: number, y: number) => {
  e.sender.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
})
ipcMain.handle('test:quit', () => app.quit())

// ---- メインメニュー（画面の言語に合わせて作り直す）----
type MenuLang = 'ja' | 'en'
const MENU_TEXT: Record<MenuLang, Record<string, string>> = {
  ja: {
    file: 'ファイル', open: '開く…', close: '閉じる', quit: '終了',
    edit: '編集', undo: '元に戻す', redo: 'やり直し', cut: '切り取り', copy: 'コピー', paste: '貼り付け', selectAll: 'すべて選択',
    view: '表示', reload: '再読み込み', devTools: '開発者ツール', resetZoom: '実際のサイズ', zoomIn: '拡大', zoomOut: '縮小', fullscreen: '全画面表示',
    window: 'ウィンドウ', minimize: '最小化', closeWindow: 'ウィンドウを閉じる',
    settings: '設定', shotViews: '自動生成の視点…',
    help: 'ヘルプ', licenses: 'ライセンス情報…'
  },
  en: {
    file: 'File', open: 'Open…', close: 'Close', quit: 'Quit',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all',
    view: 'View', reload: 'Reload', devTools: 'Developer tools', resetZoom: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fullscreen: 'Full screen',
    window: 'Window', minimize: 'Minimize', closeWindow: 'Close window',
    settings: 'Settings', shotViews: 'Auto-generated views…',
    help: 'Help', licenses: 'Licenses…'
  }
}
/** メニューの「開く」「閉じる」「設定」は画面（レンダラー）で処理する */
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
        // ほかの人が作ったソフトウェアとデータのライセンス（tools/notices.ts で作り、配布物ではアプリと同じフォルダに置く）
        { label: m.licenses, click: () => void shell.openPath(noticesPath()) }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl))
  // 自動テストでは、メニューの見出しをログに出す（メニューは画面キャプチャに写らないため）
  if (process.env['REFRAME_AUTOTEST']) process.stdout.write(`[main] メニュー(${lang}): ${tpl.map((x) => `${x.label}[${(x.submenu as MenuItemConstructorOptions[]).map((y) => y.label ?? '-').join('/')}]`).join(' ')}
`)
}
let menuLang: MenuLang | null = null
ipcMain.handle('menu:lang', (_e, lang: MenuLang) => {
  if (lang !== menuLang && (lang === 'ja' || lang === 'en')) {
    menuLang = lang
    buildMenu(lang)
  }
})

app.whenReady().then(() => {
  // 画面から言語が届くまでは OS の言語で作っておく
  buildMenu(app.getLocale().toLowerCase().startsWith('ja') ? 'ja' : 'en')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
