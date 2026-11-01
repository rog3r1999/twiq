// 应用外壳的 preload：只通过 IPC 发指令、收状态，不接触文档内容（12.2）。
// 不得引入其他模块：sandbox 下 preload 必须是单文件。
import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Listener = (payload: unknown) => void

const on = (channel: string, fn: Listener): (() => void) => {
  const h = (_e: unknown, payload: unknown): void => fn(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

contextBridge.exposeInMainWorld('hw', {
  cmd: (cmd: unknown) => ipcRenderer.invoke('shell:cmd', cmd),
  getState: () => ipcRenderer.invoke('shell:state'),
  source: (eid: number) => ipcRenderer.invoke('shell:source', eid),
  sourceApply: (eid: number, html: string) => ipcRenderer.invoke('shell:sourceApply', { eid, html }),
  setRect: (rect: unknown) => ipcRenderer.send('shell:rect', rect),
  // 拖动属性面板时的预览冻结（v0.9.1）
  freeze: () => ipcRenderer.invoke('shell:freeze'),
  freezeCommit: () => ipcRenderer.send('shell:freeze-commit'),
  thaw: (rect: unknown) => ipcRenderer.invoke('shell:thaw', rect),
  onThawed: (fn: Listener) => on('preview:thawed', fn),
  onState: (fn: Listener) => on('app:state', fn),
  onChanges: (fn: Listener) => on('changes:view', fn),
  onToast: (fn: Listener) => on('toast', fn),
  onFocusShell: (fn: Listener) => on('focus:shell', fn),
  pathForFile: (file: File) => webUtils.getPathForFile(file)
})
