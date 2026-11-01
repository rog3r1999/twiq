// IPC 通道定义与路由（规格 12.3）。预览端的每条消息都核对发送方确实是该标签页的预览视图。
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { HoverInfo, PageStats, PreviewRect, SelectionInfo, SetSlotOp, ShellCommand, Snapshot, StructOp, ToastMsg } from '../shared/types'
import { lang } from '../shared/i18n'
import { TOAST } from '../shared/messages'
import { settings } from './settings'
import { effectiveTheme } from './theme'
import type { Tab } from './tabs'
import type { Workspace } from './workspace'

interface Tagged {
  tabId: string
}

export function registerIpc(ws: Workspace, isMac: boolean): void {
  const fromShell = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => e.sender === ws.win.webContents
  const fromPreview = (e: IpcMainEvent | IpcMainInvokeEvent, msg: Partial<Tagged> | undefined): Tab | null => {
    const tab = ws.tabByWebContents(e.sender.id)
    if (!tab || !msg || msg.tabId !== tab.id) return null
    return tab
  }

  // ---------- 外壳 ----------
  ipcMain.handle('shell:cmd', async (e, cmd: ShellCommand) => {
    if (!fromShell(e)) return
    await ws.command(cmd)
  })
  ipcMain.handle('shell:state', (e) => (fromShell(e) ? ws.state() : null))
  // 源码编辑（v0.10）：打开编辑器时取原文；提交时要知道成没成功（成功才关掉编辑器）
  ipcMain.handle('shell:source', (e, eid: number) => (fromShell(e) ? ws.sourceOf(eid) : null))
  ipcMain.handle('shell:sourceApply', (e, msg: { eid: number; html: string }) => (fromShell(e) ? ws.serial(() => ws.applySource(msg.eid, msg.html)) : false))
  ipcMain.on('shell:rect', (e, rect: PreviewRect) => {
    if (fromShell(e)) ws.setRect(rect)
  })
  // 拖动属性面板时的预览冻结（v0.9.1）
  ipcMain.handle('shell:freeze', (e) => (fromShell(e) ? ws.startFreeze() : null))
  ipcMain.on('shell:freeze-commit', (e) => {
    if (fromShell(e)) ws.freezeCommit()
  })
  ipcMain.handle('shell:thaw', async (e, rect: PreviewRect) => {
    if (fromShell(e)) await ws.thaw(rect)
  })

  // ---------- 预览 ----------
  ipcMain.handle('preview:init', (e) => {
    const tab = ws.tabByWebContents(e.sender.id)
    if (!tab) return null
    return tab.init(settings().zoom / 100, isMac, settings().showBlank, effectiveTheme(), lang())
  })

  ipcMain.handle('edit:enter', (e, msg: Tagged & { snapshot: Snapshot }) => {
    const tab = fromPreview(e, msg)
    if (!tab) return { ok: false, reason: 'MISMATCH' }
    // 这里只做校验；「正在改字」等页面真的切成可编辑后由 preview:editing 报告。
    // 提前置位会让外壳和测试在页面还收不到按键时就以为可以输入了（AC-41 在 1MB 文档上丢字）
    const reason = tab.doc.validate(msg.snapshot)
    return reason ? { ok: false, reason } : { ok: true }
  })

  ipcMain.handle('edit:commit', (e, msg: Tagged & { ops: SetSlotOp[] }) => {
    const tab = fromPreview(e, msg)
    if (!tab) return { ok: false, code: 'MISMATCH' }
    return ws.commit(tab, msg.ops)
  })

  // SVG 文字（v0.6）
  ipcMain.handle('svg:text', (e, msg: Tagged & { eid: number; slots: string[] }) => {
    const tab = fromPreview(e, msg)
    if (!tab) return { ok: false, code: 'MISMATCH' }
    if (tab.doc.readOnly) return { ok: false, code: 'READONLY' }
    try {
      const entry = tab.doc.commitSvgText(msg.eid, msg.slots)
      if (entry) {
        tab.pushTable()
        ws.note(TOAST.svgTextDone)
      }
      ws.broadcast()
      return { ok: true }
    } catch (err) {
      return { ok: false, code: (err as { code?: string }).code ?? 'ERROR' }
    }
  })

  ipcMain.on('edit:abandon', (e, msg: Tagged) => {
    const tab = fromPreview(e, msg)
    if (!tab) return
    tab.typingDirty = false
    ws.broadcast()
  })

  ipcMain.on('preview:editing', (e, msg: Tagged & { editing: boolean }) => {
    const tab = fromPreview(e, msg)
    if (!tab) return
    tab.editing = msg.editing
    if (!msg.editing) tab.typingDirty = false
    ws.broadcast()
  })

  ipcMain.on('preview:typing', (e, msg: Tagged & { dirty: boolean }) => {
    const tab = fromPreview(e, msg)
    if (!tab || tab.typingDirty === msg.dirty) return
    tab.typingDirty = msg.dirty
    ws.broadcast()
  })

  ipcMain.on('preview:hover', (e, msg: Tagged & { info: HoverInfo | null }) => {
    const tab = fromPreview(e, msg)
    if (!tab || tab.id !== ws.activeId) return
    ws.hover = msg.info
    ws.broadcast()
  })

  ipcMain.on('preview:note', (e, msg: Tagged & { text: string }) => {
    if (fromPreview(e, msg)) ws.note(msg.text)
  })

  ipcMain.on('preview:toast', (e, msg: Tagged & { level: ToastMsg['level']; text: string }) => {
    if (fromPreview(e, msg)) ws.toast(msg.level, msg.text)
  })

  ipcMain.on('preview:stats', (e, msg: Tagged & { stats: PageStats }) => {
    const tab = fromPreview(e, msg)
    if (!tab) return
    tab.stats = msg.stats
    const { visible, editable } = msg.stats
    if (visible > 0 && editable / visible < 0.2 && !tab.scriptRenderedNotified && !tab.doc.readOnly) {
      tab.scriptRenderedNotified = true
      ws.toast('info', TOAST.scriptRendered, undefined, 4000)
    }
    ws.emitStats(tab)
  })

  ipcMain.on('preview:openExternal', (e, msg: Tagged & { url: string }) => {
    if (fromPreview(e, msg)) void ws.openExternal(msg.url)
  })

  ipcMain.on('preview:mode', (e, msg: Tagged & { mode: 'edit' | 'preview' }) => {
    if (fromPreview(e, msg)) void ws.setMode(msg.mode)
  })

  ipcMain.on('preview:drag', (e, msg: Tagged & { active: boolean; ok: boolean }) => {
    if (fromPreview(e, msg)) ws.setDrag('preview', { active: msg.active, ok: msg.ok })
  })

  ipcMain.on('preview:drop', (e, msg: Tagged & { paths: string[] }) => {
    if (!fromPreview(e, msg)) return
    ws.clearDrag()
    void ws.serial(() => ws.openPaths(msg.paths))
  })

  ipcMain.on('preview:focusShell', (e, msg: Tagged) => {
    if (!fromPreview(e, msg)) return
    ws.win.webContents.focus()
    ws.win.webContents.send('focus:shell')
  })

  // 工具条「撤销本次输入」在文字未偏离时：提交后执行应用级撤销
  ipcMain.on('preview:undo', (e, msg: Tagged) => {
    if (fromPreview(e, msg)) void ws.serial(() => ws.undo())
  })

  // ---------- 选择模式与结构操作（v0.2 起） ----------
  ipcMain.on('preview:selection', (e, msg: Tagged & { sel: SelectionInfo | null }) => {
    const tab = fromPreview(e, msg)
    if (tab) ws.setSelection(tab, msg.sel)
  })

  ipcMain.handle('preview:op', async (e, msg: Tagged & { op: StructOp; after?: { edit: number; caret: { start: number; end: number } } }) => {
    const tab = fromPreview(e, msg)
    if (!tab) return false
    return ws.serial(async () => {
      if (msg.after) {
        tab.pendingEdit = msg.after.edit
        tab.pendingCaret = msg.after.caret
      }
      const ok = await ws.applyOp(msg.op, tab)
      if (!ok) {
        tab.pendingEdit = null
        tab.pendingCaret = null
      }
      return ok
    })
  })

  ipcMain.on('preview:hint', (e, msg: Tagged & { key: string; text: string }) => {
    if (fromPreview(e, msg)) ws.hintOnce(msg.key, msg.text)
  })

  ipcMain.on('preview:cmd', (e, msg: Tagged & { cmd: ShellCommand }) => {
    const tab = fromPreview(e, msg)
    if (tab && tab.id === ws.activeId) void ws.command(msg.cmd)
  })

  ipcMain.on('preview:response', (e, msg: Tagged & { id: number; value: unknown }) => {
    const tab = fromPreview(e, msg)
    if (tab) tab.resolveRequest(msg.id, msg.value)
  })
}
