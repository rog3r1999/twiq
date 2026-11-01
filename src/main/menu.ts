// 原生菜单（规格 6.3）。
import { app, Menu, webContents, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { settings } from './settings'
import type { Workspace } from './workspace'
import { LANG_NAMES, MENU as L } from './strings'

export function buildMenu(ws: Workspace): void {
  const isMac = process.platform === 'darwin'
  const dev = !app.isPackaged
  const recent = settings().recent
  const run = (fn: () => unknown) => () => void fn()

  const recentMenu: MenuItemConstructorOptions[] = [
    ...recent.map((p) => ({ label: `${path.basename(p)} — ${path.dirname(p)}`, click: run(() => ws.serial(() => ws.openRecent(p))) })),
    ...(recent.length ? [{ type: 'separator' as const }] : []),
    { label: L.clearRecent, enabled: recent.length > 0, click: run(() => ws.clearRecent()) }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Twiq',
            submenu: [
              { role: 'about' as const, label: L.about },
              { type: 'separator' as const },
              { role: 'hide' as const, label: L.hide },
              { role: 'hideOthers' as const, label: L.hideOthers },
              { role: 'unhide' as const, label: L.unhide },
              { type: 'separator' as const },
              { role: 'quit' as const, label: L.quitMac }
            ]
          }
        ]
      : []),
    {
      label: L.file,
      submenu: [
        { label: L.newDoc, accelerator: 'CmdOrCtrl+N', click: run(() => ws.newDoc()) },
        { label: L.open, accelerator: 'CmdOrCtrl+O', click: run(() => ws.openDialog()) },
        { label: L.openRecent, submenu: recentMenu },
        { type: 'separator' },
        { label: L.save, accelerator: 'CmdOrCtrl+S', click: run(() => ws.serial(() => ws.save())) },
        { label: L.saveAs, accelerator: 'CmdOrCtrl+Shift+S', click: run(() => ws.serial(() => ws.saveAs())) },
        { type: 'separator' },
        {
          label: L.export,
          submenu: [
            { label: L.pdf, accelerator: 'CmdOrCtrl+P', click: run(() => ws.command({ type: 'exportPdf' })) },
            { label: L.markdown, click: run(() => ws.command({ type: 'exportText', format: 'md' })) },
            { label: L.plainText, click: run(() => ws.command({ type: 'exportText', format: 'txt' })) }
          ]
        },
        { label: L.importBody, click: run(() => ws.command({ type: 'importFragment' })) },
        { type: 'separator' },
        { label: isMac ? L.revealMac : L.revealWin, click: run(() => ws.revealInFolder()) },
        { type: 'separator' },
        { label: L.closeTab, accelerator: 'CmdOrCtrl+W', click: run(() => ws.closeActiveOrWindow()) },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: L.quit }])
      ]
    },
    {
      label: L.edit,
      submenu: [
        // 撤销与重做不用 role：编辑文字时交给预览按字词撤销，否则作用于应用级撤销栈（7.3 第 12 条）
        { label: L.undo, accelerator: 'CmdOrCtrl+Z', click: run(() => ws.serial(() => ws.undo())) },
        { label: L.redo, accelerator: 'CmdOrCtrl+Shift+Z', click: run(() => ws.serial(() => ws.redo())) },
        ...(isMac ? [] : [{ label: L.redo, accelerator: 'Ctrl+Y', visible: false, acceleratorWorksWhenHidden: true, click: run(() => ws.serial(() => ws.redo())) }]),
        { type: 'separator' },
        { role: 'cut', label: L.cut },
        { role: 'copy', label: L.copy },
        { role: 'paste', label: L.paste },
        // 不用 role selectAll：它会占用 Cmd/Ctrl+A 加速键，页面里收不到「全选同级」；点菜单仍可用
        { label: L.selectAll, click: () => webContents.getFocusedWebContents()?.selectAll() },
        { type: 'separator' },
        { label: L.copyElement, click: run(() => ws.command({ type: 'copyElement' })) },
        // v0.10：把选中元素连同文件位置交给 AI，大改让 AI 做、小改在这里做
        { label: L.copyForAi, click: run(() => ws.command({ type: 'copyForAi' })) },
        { label: L.pasteElement, click: run(() => ws.command({ type: 'pasteElement' })) },
        {
          label: L.insert,
          submenu: [
            { label: L.image, click: run(() => ws.command({ type: 'insertMedia', kind: 'image' })) },
            { label: L.video, click: run(() => ws.command({ type: 'insertMedia', kind: 'video' })) },
            { label: L.audio, click: run(() => ws.command({ type: 'insertMedia', kind: 'audio' })) }
          ]
        },
        { label: L.replaceImage, click: run(() => ws.command({ type: 'replaceImage' })) },
        { type: 'separator' },
        {
          label: L.components,
          submenu: [
            { label: L.normalize, click: run(() => ws.command({ type: 'normalizeComponents' })) },
            { label: L.checkComponents, click: run(() => ws.command({ type: 'checkComponents' })) }
          ]
        }
      ]
    },
    {
      label: L.view,
      submenu: [
        { label: L.editPreview, accelerator: 'CmdOrCtrl+E', click: run(() => ws.setMode()) },
        {
          label: L.aids,
          submenu: [
            // v0.8：原「显示空白」。不常用，从工具栏挪到这里；名字说清是「看不见的空框」，不是空格
            { label: L.showBlank, type: 'checkbox', checked: settings().showBlank, click: run(() => ws.toggleBlank()) }
          ]
        },
        {
          label: L.appearance,
          submenu: [
            // v0.9：跟随系统时不写死系统外观，macOS 切换明暗后由 nativeTheme 的 updated 事件实时同步
            { label: L.system, type: 'radio', checked: settings().theme === 'system', click: run(() => ws.setTheme('system')) },
            { label: L.light, type: 'radio', checked: settings().theme === 'light', click: run(() => ws.setTheme('light')) },
            { label: L.dark, type: 'radio', checked: settings().theme === 'dark', click: run(() => ws.setTheme('dark')) }
          ]
        },
        {
          label: L.language,
          submenu: [
            // v0.10：语言名用各自的文字写，切到看不懂的语言时也能找回来
            { label: L.system, type: 'radio', checked: settings().lang === 'system', click: run(() => ws.setLang('system')) },
            { label: LANG_NAMES.zh, type: 'radio', checked: settings().lang === 'zh', click: run(() => ws.setLang('zh')) },
            { label: LANG_NAMES.en, type: 'radio', checked: settings().lang === 'en', click: run(() => ws.setLang('en')) }
          ]
        },
        { label: L.panel, accelerator: 'CmdOrCtrl+Alt+P', click: run(() => ws.togglePanel()) },
        { type: 'separator' },
        { label: L.zoomIn, accelerator: 'CmdOrCtrl+=', click: run(() => ws.zoom(1)) },
        { label: L.zoomIn, accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: run(() => ws.zoom(1)) },
        { label: L.zoomOut, accelerator: 'CmdOrCtrl+-', click: run(() => ws.zoom(-1)) },
        { label: L.actualSize, accelerator: 'CmdOrCtrl+0', click: run(() => ws.zoom(0)) },
        { type: 'separator' },
        { label: L.reload, accelerator: 'F5', click: run(() => ws.serial(() => ws.reloadFromDisk())) },
        ...(dev
          ? [
              {
                label: L.devTools,
                accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
                click: () => {
                  const t = ws.active
                  if (t) t.view.webContents.toggleDevTools()
                  else ws.win.webContents.toggleDevTools()
                }
              },
              { label: L.shellDevTools, click: () => ws.win.webContents.toggleDevTools() }
            ]
          : [])
      ]
    },
    {
      label: L.window,
      submenu: [
        { role: 'minimize', label: L.minimize },
        { role: 'zoom', label: L.zoom },
        { type: 'separator' },
        // Ctrl+Tab 与 Cmd/Ctrl+数字由 before-input-event 统一处理，这里只做展示
        { label: L.nextTab, accelerator: 'Ctrl+Tab', registerAccelerator: false, click: () => ws.cycleTab(1) },
        { label: L.prevTab, accelerator: 'Ctrl+Shift+Tab', registerAccelerator: false, click: () => ws.cycleTab(-1) }
      ]
    },
    {
      role: 'help',
      label: L.help,
      submenu: [
        { label: L.shortcuts, accelerator: 'F1', click: run(() => ws.showShortcuts()) },
        { label: L.sample, click: run(() => ws.loadSample()) },
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: L.about, click: () => app.showAboutPanel() }])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
