// 应用入口：单实例、窗口、菜单、打开方式（菜单、拖拽、命令行、最近文件、系统「打开方式」）。
import { app, BrowserWindow, nativeTheme, protocol, screen, type Input } from 'electron'
import path from 'node:path'
import { SCHEME } from './protocol'
import { flushSettings, loadSettings, settings, updateSettings } from './settings'
import { windowBackground } from './theme'
import { installFeatures } from './features'
import { registerIpc } from './ipc'
import { applyLang } from './lang'
import { buildMenu } from './menu'
import { Workspace } from './workspace'
import { unwatchAll } from './watcher'
import { runCoverage } from './coverage-run'

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

const isMac = process.platform === 'darwin'
const coverageMode = process.argv.includes('--coverage')
app.setName('Twiq')
app.setAboutPanelOptions({ applicationName: 'Twiq', applicationVersion: app.getVersion(), copyright: '© 2026 Roger Luo' })

/** 命令行里的 .html 参数 */
function htmlArgs(argv: string[], cwd = process.cwd()): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && /\.html?$/i.test(a))
    .map((a) => path.resolve(cwd, a))
}

const pending: string[] = []
let ws: Workspace | null = null

if (!coverageMode && !process.env.TWIQ_MULTI_INSTANCE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const files = htmlArgs(argv, cwd)
    if (ws) {
      if (ws.win.isMinimized()) ws.win.restore()
      ws.win.focus()
      void ws.serial(() => ws!.openPaths(files))
    } else pending.push(...files)
  })
  // macOS：拖到 Dock 图标、双击关联文件
  app.on('open-file', (e, file) => {
    e.preventDefault()
    if (ws) void ws.serial(() => ws!.openPaths([file]))
    else pending.push(file)
  })
  app.whenReady().then(coverageMode ? runCoverage : start)
}

function windowBounds(): Electron.Rectangle & { maximized: boolean } {
  const w = settings().window
  const width = Math.max(960, w.width)
  const height = Math.max(600, w.height)
  if (w.x !== undefined && w.y !== undefined) {
    // 记住的位置必须仍在某块屏幕内
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return w.x! + 100 < a.x + a.width && w.x! + width - 100 > a.x && w.y! >= a.y - 10 && w.y! < a.y + a.height - 50
    })
    if (visible) return { x: w.x, y: w.y, width, height, maximized: w.maximized }
  }
  return { x: undefined as unknown as number, y: undefined as unknown as number, width, height, maximized: w.maximized }
}

function start(): void {
  loadSettings()
  applyLang()
  // 打包后图标由 electron-builder 写进应用包；直接运行（pnpm dev / start）时手动设上，否则 Dock 显示 Electron 默认图标
  const devIcon = app.isPackaged ? undefined : path.join(__dirname, '../../build/icon.png')
  if (devIcon && isMac) app.dock?.setIcon(devIcon)
  const b = windowBounds()
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Twiq',
    icon: devIcon,
    autoHideMenuBar: true, // Windows：菜单栏默认隐藏，按 Alt 唤出（6.3）
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/shell.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  if (b.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  ws = new Workspace(win)
  const workspace = ws
  // 端到端测试钩子：仅在 TWIQ_TEST 时暴露给主进程的 evaluate
  if (process.env.TWIQ_TEST) (globalThis as unknown as { __hw: unknown }).__hw = { ws: workspace }
  registerIpc(workspace, isMac)
  installFeatures(workspace)
  buildMenu(workspace)
  workspace.onMenuChanged = () => buildMenu(workspace)

  // 外壳不允许导航
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // 标签页快捷键：Ctrl+Tab、Cmd/Ctrl+1–9、F6（在外壳与预览上都生效）
  const keys = (e: Electron.Event, input: Input): void => {
    if (input.type !== 'keyDown') return
    const mod = isMac ? input.meta : input.control
    if (input.control && input.key === 'Tab') {
      e.preventDefault()
      workspace.cycleTab(input.shift ? -1 : 1)
    } else if (mod && !input.alt && !input.shift && /^[1-9]$/.test(input.key)) {
      e.preventDefault()
      workspace.gotoTab(Number(input.key))
    } else if (input.key === 'F6' && !input.alt && !input.control && !input.meta) {
      e.preventDefault()
      const t = workspace.active
      if (t && !t.view.webContents.isFocused()) {
        t.view.webContents.focus()
        t.send('focus:enter')
      } else {
        win.webContents.focus()
        win.webContents.send('focus:shell')
      }
    }
  }
  win.webContents.on('before-input-event', keys)
  app.on('web-contents-created', (_e, wc) => {
    if (wc !== win.webContents) wc.on('before-input-event', keys)
  })

  const saveBounds = (): void => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const nb = maximized ? settings().window : { ...win.getNormalBounds(), maximized }
    updateSettings({ window: { x: nb.x, y: nb.y, width: nb.width, height: nb.height, maximized } })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('maximize', saveBounds)
  win.on('unmaximize', saveBounds)

  win.on('close', (e) => {
    if (workspace.forceClose) return
    e.preventDefault()
    void workspace.confirmAll().then((ok) => {
      if (!ok) return
      workspace.forceClose = true
      saveBounds()
      flushSettings()
      win.close()
    })
  })
  win.on('closed', () => {
    unwatchAll()
    ws = null
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  win.webContents.once('did-finish-load', () => {
    const files = [...htmlArgs(process.argv), ...pending.splice(0)]
    if (files.length) void workspace.serial(() => workspace.openPaths(files))
  })

  // macOS 外观实时变化：偏好为「跟随系统」时，重新广播解析结果并更新窗口底色。
  // 不设置 nativeTheme.themeSource，避免把应用选择写进用户文档的 prefers-color-scheme。
  nativeTheme.on('updated', () => workspace.refreshTheme())
}

app.on('before-quit', () => flushSettings())
app.on('window-all-closed', () => app.quit())
