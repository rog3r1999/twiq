// 工作区：标签页集合、文件打开与保存、外部变更、对话框、状态广播。
import { app, BrowserWindow, dialog, shell, type MessageBoxOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AppState,
  ChangeItem,
  ChangesView,
  Eid,
  ElementInfo,
  FreezeShot,
  SelectionInfo,
  StructOp,
  DragState,
  HoverInfo,
  Mode,
  PreviewRect,
  ShellCommand,
  TabSummary,
  LangPreference,
  ThemePreference,
  ToastMsg,
  ViewportOption
} from '../shared/types'
import type { SvgModel } from '../shared/svg'
import { DIALOG, TOAST } from '../shared/messages'
import { plan3 } from './merge'
import { applyPatches } from './patch'
import { DocState, EditError } from './document'
import { decodeFile, encodeFile } from './parse'
import { addRecent, clampPanel, clearRecent, removeRecent, setRoot, settings, updateSettings } from './settings'
import { effectiveTheme, windowBackground, PREVIEW_CANVAS } from './theme'
import { viewLayout } from '../shared/layout'
import { shouldFreeze } from './freeze'
import { svgModel } from './svg-model'
import { canRevert, diffChanges, revertOne, summarize, type Change } from './changes'
import { M } from './strings'
import { rawOf } from './ops'
import { applyLang } from './lang'
import { lang } from '../shared/i18n'
import { sha256, Tab, type TabHooks } from './tabs'
import { unwatchFile, watchFile, type WatchEvent } from './watcher'

export const MAX_TABS = 20
export const BIG_FILE = 10 * 1024 * 1024
const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300]

/** 新建空白文档的内容：语言、标题与占位文字随界面语言（v0.10） */
export function blankTemplate(): string {
  const t = M.blank
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title}</title>
<style>
  body { max-width: 720px; margin: 0 auto; padding: 56px 24px; font-family: -apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei UI", sans-serif; line-height: 1.7; color: #1f2937; }
</style>
</head>
<body>
<h1>${t.heading}</h1>
<p>${t.body}</p>
</body>
</html>
`
}

/** 改动面板最多列多少条；每条的原文截到多长；前后各带多少字的上下文 */
const CHANGES_MAX = 200
const CLIP = 160
const CTX = 24

function clip(s: string): string {
  if (s.length <= CLIP) return s
  const head = Math.ceil((CLIP - 1) / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - (CLIP - 1 - head))}`
}

/** 包含 [start, end) 的最内层元素（元素表按起始位置排序） */
function innermost(els: ElementInfo[], start: number, end: number): ElementInfo | null {
  let best: ElementInfo | null = null
  for (const el of els) {
    if (el.startTagStart > start) break
    if (el.end >= end && el.end > start) best = el
  }
  return best
}

export function resourcePath(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, '../../resources', name)
}

function isHtml(p: string): boolean {
  return /\.html?$/i.test(p)
}

function errorReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return M.errNoPermission
  if (code === 'ENOSPC') return M.errDiskFull
  if (code === 'EROFS') return M.errReadOnlyDisk
  if (code === 'ENOENT') return M.errNotFound
  return (err as Error)?.message ?? String(err)
}

/** 原子写入：同目录临时文件 → 刷盘 → 重命名；保持权限；符号链接写入其目标（13.8 第 3 条）。 */
export async function atomicWrite(target: string, data: Buffer): Promise<void> {
  let real = target
  try {
    real = await fs.promises.realpath(target)
  } catch {
    // 新文件
  }
  let mode: number | undefined
  try {
    const st = await fs.promises.stat(real)
    mode = st.mode & 0o7777
    // 尊重只读：即使目录可写、重命名能成功，也不覆盖只读文件
    await fs.promises.access(real, fs.constants.W_OK)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.${Date.now()}.hwtmp`)
  const fh = await fs.promises.open(tmp, 'w', mode ?? 0o644)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    if (mode !== undefined) await fs.promises.chmod(tmp, mode)
    await fs.promises.rename(tmp, real)
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {})
    if (process.platform !== 'win32') throw err
    // Windows 上重命名失败时，退回直接覆盖写入
    await fs.promises.writeFile(real, data)
  }
}

function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return path.parse(process.cwd()).root
  let parts = path.resolve(paths[0]).split(path.sep)
  for (const p of paths.slice(1)) {
    const q = path.resolve(p).split(path.sep)
    let i = 0
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++
    parts = parts.slice(0, i)
  }
  return parts.join(path.sep) || path.sep
}

function isAncestorOrSelf(dir: string, child: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export class Workspace {
  readonly tabs: Tab[] = []
  activeId: string | null = null
  rect: PreviewRect = { x: 0, y: 0, width: 0, height: 0 }
  hover: HoverInfo | null = null
  statusNote: string | null = null
  private noteTimer: NodeJS.Timeout | null = null
  private dragShell: DragState | null = null
  private dragPreview: DragState | null = null
  private dragTimer: NodeJS.Timeout | null = null
  private broadcastQueued = false
  private busy = Promise.resolve()
  /** 拖动面板时的预览冻结（v0.9.1）：已拍好、等外壳显示的画面 */
  private freezePending: { tabId: string; shot: FreezeShot } | null = null
  /** 冻结已生效：预览视图隐藏，外壳显示这张画面 */
  private freeze: { tabId: string; shot: FreezeShot } | null = null
  /** 取景作废令牌：拖动结束后到货的截图直接丢弃 */
  private freezeSeq = 0
  forceClose = false
  /** 最近文件或主题变化后重建原生菜单（勾选与最近列表） */
  onMenuChanged: () => void = () => {}
  /** 覆盖率模式用：页面统计到达时回调 */
  statsListener: ((tab: Tab) => void) | null = null

  constructor(readonly win: BrowserWindow) {}

  get active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId)
  }

  tabByWebContents(id: number): Tab | undefined {
    return this.tabs.find((t) => !t.view.webContents.isDestroyed() && t.view.webContents.id === id)
  }

  tabById(id: string): Tab | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  /** 串行执行会改动文档的操作，避免交错。 */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn)
    this.busy = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // ---------- 状态 ----------

  summary(t: Tab): TabSummary {
    return {
      id: t.id,
      name: t.name,
      path: t.path,
      dirty: t.dirty,
      readOnly: t.doc.readOnly,
      readOnlyKind: t.readOnlyKind,
      canUndo: t.doc.undo.length > 0,
      canRedo: t.doc.redo.length > 0,
      mode: t.mode,
      isSample: t.isSample,
      missing: t.missing,
      editableCount: t.doc.elements.filter((e) => e.isHost && !e.uneditableReason).length
    }
  }

  state(): AppState {
    const s = settings()
    const t = this.active
    const banner =
      t && t.loaded && t.outOfRoot.size > 0 && !t.bannerDismissed ? { tabId: t.id, dirs: [...t.outOfRoot] } : null
    const drag = this.dragShell?.active ? this.dragShell : this.dragPreview?.active ? this.dragPreview : null
    return {
      tabs: this.tabs.map((x) => this.summary(x)),
      activeId: this.activeId,
      zoom: s.zoom,
      fit: this.fit(),
      panelWidth: clampPanel(s.panelWidth),
      viewport: s.viewport,
      editing: !!t?.editing,
      hover: t ? this.hover : null,
      banner,
      extFail: !!t?.extFail,
      assetsMissing: !!t?.assetsMissing,
      recent: s.recent.slice(0, 10).map((p) => ({ path: p, name: path.basename(p), dir: path.dirname(p), exists: fs.existsSync(p) })),
      statusNote: this.statusNote,
      isMac: process.platform === 'darwin',
      drag,
      selection: t?.mode === 'edit' ? t.selection : null,
      panelOpen: s.panelOpen,
      showBlank: s.showBlank,
      theme: s.theme,
      resolvedTheme: effectiveTheme(),
      langPref: s.lang,
      lang: lang(),
      changeCount: t ? this.changeCountOf(t) : 0,
      clip: this.clip !== null,
      svgSource: t?.mode === 'edit' ? this.svgSourceOf(t) : null,
      svgModel: t?.mode === 'edit' ? this.svgModelOf(t) : null
    }
  }

  broadcast(): void {
    if (this.broadcastQueued) return
    this.broadcastQueued = true
    queueMicrotask(() => {
      this.broadcastQueued = false
      if (this.win.isDestroyed()) return
      const st = this.state()
      this.win.webContents.send('app:state', st)
      this.sendChangesView()
      const t = this.active
      this.win.setTitle(t ? `${t.dirty ? '● ' : ''}${t.name} — Twiq` : 'Twiq')
      if (process.platform === 'darwin') {
        this.win.setDocumentEdited(!!t?.dirty)
        this.win.setRepresentedFilename(t?.path ?? '')
      }
      // 预览端需要知道拖拽遮罩的状态
      for (const tab of this.tabs) tab.send('overlay:drag', st.drag)
    })
  }

  toast(level: ToastMsg['level'], text: string, sub?: string, duration?: number): void {
    const msg: ToastMsg = { level, text, sub, duration }
    if (!this.win.isDestroyed()) this.win.webContents.send('toast', msg)
    this.active?.send('overlay:toast', msg)
  }

  note(text: string): void {
    this.statusNote = text
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.noteTimer = setTimeout(() => {
      this.statusNote = null
      this.broadcast()
    }, 2200)
    this.broadcast()
  }

  setDrag(from: 'shell' | 'preview', d: DragState): void {
    if (from === 'shell') this.dragShell = d
    else this.dragPreview = d
    if (this.dragTimer) clearTimeout(this.dragTimer)
    if (!d.active) {
      // 在两个视图之间移动时，离开与进入的先后不固定，稍等再收起
      this.dragTimer = setTimeout(() => this.broadcast(), 120)
    } else {
      this.broadcast()
    }
  }

  clearDrag(): void {
    this.dragShell = null
    this.dragPreview = null
    this.broadcast()
  }

  async ask(opts: { title: string; detail: string; buttons: string[]; defaultId?: number; cancelId?: number; type?: MessageBoxOptions['type'] }): Promise<number> {
    const r = await dialog.showMessageBox(this.win, {
      type: opts.type ?? 'warning',
      message: opts.title,
      detail: opts.detail,
      buttons: opts.buttons,
      defaultId: opts.defaultId ?? 0,
      cancelId: opts.cancelId ?? opts.buttons.length - 1,
      noLink: true
    })
    return r.response
  }

  // ---------- 布局 ----------

  setRect(r: PreviewRect): void {
    // 冻结中：页面保持原样，位置由 thaw 在松手时统一应用（见 freezeForDrag）
    if (this.freeze) {
      this.rect = r
      return
    }
    const fit = this.fit()
    this.rect = r
    this.layout()
    if (Math.abs(this.fit() - fit) > 1e-3) this.broadcast()
  }

  layout(): void {
    for (const t of this.tabs) {
      // 冻结中的标签页：保持隐藏、不动页面，等 thaw 一起应用
      if (this.freeze?.tabId === t.id) continue
      const show = t.id === this.activeId && this.rect.width > 0
      t.view.setVisible(show)
      if (!show) continue
      this.applyView(t)
    }
  }

  /** 按当前 rect 设置某个标签页的视图尺寸与缩放，不改可见性。 */
  private applyView(t: Tab): void {
    if (t.view.webContents.isDestroyed()) return
    const l = viewLayout(this.rect, settings().viewport, settings().zoom / 100)
    t.view.setBounds({ x: l.x, y: l.y, width: l.width, height: l.height })
    this.applyZoom(t)
  }

  /** 当前的适应缩放（属性面板挤占预览区时小于 1）。 */
  fit(): number {
    return this.rect.width > 0 ? viewLayout(this.rect, settings().viewport, 1).fit : 1
  }

  private applyZoom(t: Tab): void {
    const z = viewLayout(this.rect, settings().viewport, settings().zoom / 100).zoom
    if (!t.view.webContents.isDestroyed() && Math.abs(t.view.webContents.getZoomFactor() - z) > 1e-4) t.view.webContents.setZoomFactor(z)
  }

  // ---------- 拖动属性面板时的预览冻结（v0.9.1） ----------
  // 流程：startFreeze 拍一张 → 外壳显示这张图 → freezeCommit 隐藏预览视图 →
  // 松手时 thaw 按最终尺寸重排、等页面画好第一帧再显示视图、通知外壳收起画面。

  get freezeState(): 'idle' | 'pending' | 'frozen' {
    return this.freeze ? 'frozen' : this.freezePending ? 'pending' : 'idle'
  }

  /** 拍下预览当前画面；页面不够重（元素少）时返回 null，拖动继续走实时缩放。 */
  async startFreeze(): Promise<FreezeShot | null> {
    const t = this.active
    if (!t || t.mode !== 'edit' || !t.loaded || this.rect.width <= 0) return null
    if (this.freeze || this.freezePending) return null
    const wc = t.view.webContents
    if (wc.isDestroyed()) return null
    // 元素数用页面载入时报上来的统计（没有就按解析出的元素数估算）：不在这时候进页面里数，
    // 拖动刚开始时渲染进程正忙着重排，一次 executeJavaScript 要等上百毫秒
    const nodes = t.stats?.nodes ?? t.doc.elements.length
    if (!shouldFreeze(nodes)) return null
    const seq = ++this.freezeSeq
    let img: Electron.NativeImage
    try {
      img = await wc.capturePage()
    } catch {
      return null
    }
    if (seq !== this.freezeSeq) return null
    const b = t.view.getBounds()
    const shot: FreezeShot = { url: img.toDataURL(), width: b.width, height: b.height, bg: this.cornerColor(img) }
    this.freezePending = { tabId: t.id, shot }
    return shot
  }

  /** 外壳已把画面显示出来：这时才隐藏预览视图，中间不会露出空白。 */
  freezeCommit(): void {
    const p = this.freezePending
    this.freezePending = null
    const t = p && this.tabById(p.tabId)
    if (!p || !t || this.activeId !== t.id || t.view.webContents.isDestroyed()) return
    this.freeze = p
    t.view.setVisible(false)
  }

  /** 松手：按最终位置重排页面，画好第一帧再换回实时视图；rect 缺省时沿用上一次的位置。 */
  async thaw(rect?: PreviewRect): Promise<void> {
    if (rect) this.rect = rect
    this.freezeSeq++
    const st = this.freeze
    // 只拍好、还没提交的也要通知外壳：那张图已经在外壳上显示了
    const had = !!(this.freeze || this.freezePending)
    const mine = this.freezeSeq
    this.freezePending = null
    this.freeze = null
    const t = (st && this.tabById(st.tabId)) ?? this.active
    if (st && t && !t.view.webContents.isDestroyed()) {
      try {
        this.applyView(t)
        await this.waitFirstFrames(t)
        // 等帧期间松手后又按住了手柄：让新的冻结流程接手，不要把视图放回来
        if (mine === this.freezeSeq && !this.freeze && !this.freezePending) t.view.setVisible(this.activeId === t.id && this.rect.width > 0)
      } catch {
        /* 页面没了：layout 会兜底 */
      }
    }
    this.layout()
    this.broadcast()
    // 有新的冻结在进行时，这张通知属于上一轮，不能让它把新画面收掉
    if (had && !this.freeze && !this.freezePending) this.win.webContents.send('preview:thawed')
  }

  /** 切标签、换模式等打断拖动的情况：静默把实时页面换回来。 */
  dropFreeze(): void {
    if (this.freeze || this.freezePending) void this.thaw()
  }

  /** 等页面把「改尺寸 + 改缩放」后的第一帧画出来（最多 600ms）。 */
  private waitFirstFrames(t: Tab): Promise<void> {
    if (t.view.webContents.isDestroyed()) return Promise.resolve()
    const frames = 2
    const script = `new Promise((r) => { let i = 0; const tick = () => (++i >= ${frames} ? r(0) : requestAnimationFrame(tick)); requestAnimationFrame(tick) })`
    return Promise.race([
      t.view.webContents.executeJavaScript(script).catch(() => undefined).then(() => undefined),
      new Promise<void>((r) => setTimeout(r, 600))
    ])
  }

  /** 冻结画面下方露出的部分用什么颜色：取画面左上角那一个像素（就是页面自己的底色）。 */
  private cornerColor(img: Electron.NativeImage): string {
    try {
      const px = img.crop({ x: 0, y: 0, width: 1, height: 1 }).toBitmap()
      return px.length >= 3 ? `rgb(${px[2]}, ${px[1]}, ${px[0]})` : PREVIEW_CANVAS
    } catch {
      return PREVIEW_CANVAS
    }
  }

  zoom(dir: 1 | -1 | 0): void {
    const cur = settings().zoom
    let next = 100
    if (dir === 1) next = ZOOM_STEPS.find((z) => z > cur) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
    if (dir === -1) next = [...ZOOM_STEPS].reverse().find((z) => z < cur) ?? ZOOM_STEPS[0]
    updateSettings({ zoom: next })
    for (const t of this.tabs) this.applyZoom(t)
    this.broadcast()
  }

  setViewport(v: ViewportOption): void {
    updateSettings({ viewport: v })
    this.layout()
    this.broadcast()
  }

  // ---------- 标签页 ----------

  private hooks: TabHooks = {
    onOutOfRoot: (tab, dir) => {
      tab.outOfRoot.add(dir)
      if (tab.loaded) this.broadcast()
    },
    onExtFail: (tab) => {
      if (!tab.extFail) {
        tab.extFail = true
        this.broadcast()
      }
    },
    onLocalMissing: (tab) => {
      // 另存到其他目录后重载：相对路径资源找不到时在状态栏提示一次（13.8 第 7 条）
      if (tab.watchMissingAssets && !tab.assetsMissing) {
        tab.assetsMissing = true
        this.broadcast()
      }
    },
    onLoaded: (tab) => {
      this.applyZoom(tab)
      this.broadcast()
    },
    onCrashed: (tab) => {
      tab.loaded = false
      tab.editing = false
      this.toast('error', M.crashed)
      tab.load()
    }
  }

  private addTab(tab: Tab): void {
    this.tabs.push(tab)
    this.win.contentView.addChildView(tab.view)
    tab.view.setVisible(false)
    tab.load()
    this.watch(tab)
    this.activate(tab.id)
  }

  private canAddTab(): boolean {
    if (this.tabs.length >= MAX_TABS) {
      this.toast('warn', TOAST.tooManyTabs)
      return false
    }
    return true
  }

  async activate(id: string): Promise<void> {
    if (this.activeId === id) return
    this.dropFreeze()
    const prev = this.active
    if (prev) await prev.flush()
    this.activeId = id
    this.hover = null
    this.layout()
    const t = this.active
    if (t) {
      t.view.webContents.focus()
      if (t.pendingExternal) void this.serial(() => this.handleExternal(t))
    }
    this.broadcast()
  }

  cycleTab(d: 1 | -1): void {
    if (this.tabs.length < 2) return
    const i = this.tabs.findIndex((t) => t.id === this.activeId)
    void this.activate(this.tabs[(i + d + this.tabs.length) % this.tabs.length].id)
  }

  gotoTab(n: number): void {
    const t = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1]
    if (t) void this.activate(t.id)
  }

  reorder(from: number, to: number): void {
    if (from < 0 || from >= this.tabs.length || to < 0 || to >= this.tabs.length) return
    const [t] = this.tabs.splice(from, 1)
    this.tabs.splice(to, 0, t)
    this.broadcast()
  }

  /** 关闭标签页；用户取消时返回 false。 */
  async closeTab(id: string): Promise<boolean> {
    const t = this.tabById(id)
    if (!t) return true
    this.dropFreeze()
    await t.flush()
    if (t.dirty) {
      if (this.activeId !== id) await this.activate(id)
      const d = DIALOG.unsaved(t.name)
      const r = await this.ask({ ...d, defaultId: 0, cancelId: 2 })
      if (r === 2) return false
      if (r === 0 && !(await this.save(t))) return false
    }
    const idx = this.tabs.indexOf(t)
    this.tabs.splice(idx, 1)
    unwatchFile(t.id)
    this.win.contentView.removeChildView(t.view)
    t.destroy()
    if (this.activeId === id) {
      this.activeId = null
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)]
      if (next) await this.activate(next.id)
    }
    this.layout()
    this.broadcast()
    return true
  }

  async closeActiveOrWindow(): Promise<void> {
    if (this.active) await this.closeTab(this.active.id)
    else this.win.close()
  }

  /** 关闭窗口或退出前：逐个确认未保存的标签页。 */
  async confirmAll(): Promise<boolean> {
    for (const t of [...this.tabs]) {
      await t.flush()
      if (!t.dirty) continue
      await this.activate(t.id)
      const r = await this.ask({ ...DIALOG.unsaved(t.name), defaultId: 0, cancelId: 2 })
      if (r === 2) return false
      if (r === 0 && !(await this.save(t))) return false
    }
    return true
  }

  // ---------- 打开 ----------

  async openDialog(): Promise<void> {
    const r = await dialog.showOpenDialog(this.win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
    })
    if (!r.canceled) await this.openPaths(r.filePaths)
  }

  async openPaths(paths: string[]): Promise<void> {
    const bad = paths.filter((p) => !isHtml(p))
    if (bad.length) this.toast('warn', TOAST.onlyHtml)
    for (const p of paths.filter(isHtml)) await this.openPath(p)
  }

  async openRecent(p: string): Promise<void> {
    if (!fs.existsSync(p)) {
      removeRecent(p)
      this.onMenuChanged()
      this.toast('warn', TOAST.recentMissing)
      this.broadcast()
      return
    }
    await this.openPath(p)
  }

  async openPath(input: string): Promise<void> {
    const p = path.resolve(input)
    const existing = this.tabs.find((t) => t.path && path.resolve(t.path) === p)
    if (existing) {
      await this.activate(existing.id)
      return
    }
    if (!this.canAddTab()) return
    let buf: Buffer
    try {
      const st = await fs.promises.stat(p)
      if (st.size > BIG_FILE) {
        const r = await this.ask({ ...DIALOG.bigFile, type: 'info', defaultId: 0, cancelId: 1 })
        if (r !== 0) return
      }
      buf = await fs.promises.readFile(p)
    } catch (err) {
      this.toast('error', M.cannotOpen(path.basename(p)), errorReason(err))
      return
    }
    const d = decodeFile(buf)
    const doc = new DocState({ source: d.source, eol: d.eol, hasBom: d.hasBom, readOnly: d.readOnly ? 'READONLY_FILE' : null })
    const saved = settings().roots[p]
    const root = saved && fs.existsSync(saved) && isAncestorOrSelf(saved, path.dirname(p)) ? saved : path.dirname(p)
    const tab = new Tab(
      { path: p, name: path.basename(p), doc, readOnlyKind: d.readOnly, diskHash: sha256(buf), resourceRoot: root },
      this.hooks
    )
    tab.baseSource = d.source
    this.addTab(tab)
    addRecent(p)
    this.onMenuChanged()
  }

  newDoc(): void {
    if (!this.canAddTab()) return
    const doc = new DocState({ source: blankTemplate() })
    this.addTab(new Tab({ path: null, name: M.untitled, doc, readOnlyKind: null, diskHash: '', resourceRoot: null }, this.hooks))
  }

  loadSample(): void {
    if (!this.canAddTab()) return
    // 示例页面跟着界面语言（v0.10）
    const file = resourcePath(lang() === 'en' ? 'sample-demo.en.html' : 'sample-demo.html')
    const buf = fs.readFileSync(file)
    const d = decodeFile(buf)
    const doc = new DocState({ source: d.source, eol: d.eol, hasBom: d.hasBom })
    this.addTab(
      new Tab(
        {
          path: null,
          name: M.sampleFile,
          doc,
          readOnlyKind: null,
          diskHash: '',
          isSample: true,
          virtualEntry: file,
          resourceRoot: path.dirname(file)
        },
        this.hooks
      )
    )
  }

  private watch(tab: Tab): void {
    if (!tab.path) return
    watchFile(tab.id, tab.path, (ev) => void this.serial(() => this.onFileEvent(tab, ev)))
  }

  // ---------- 保存 ----------

  /** 保存；成功返回 true。 */
  async save(tab: Tab | undefined = this.active): Promise<boolean> {
    if (!tab) return false
    await tab.flush()
    if (tab.doc.readOnly) {
      this.toast('warn', M.readOnlySave, M.readOnlySaveSub)
      return false
    }
    if (!tab.path || tab.missing) return this.saveAs(tab)
    const data = encodeFile(tab.doc.source, tab.doc.eol, tab.doc.hasBom)
    // 写入前比较磁盘内容的哈希（13.8 第 2 条）
    let disk: Buffer | null
    try {
      disk = await fs.promises.readFile(tab.path)
    } catch {
      disk = null
    }
    if (disk === null) {
      tab.missing = true
      return this.saveAs(tab)
    }
    if (sha256(disk) !== tab.diskHash) {
      const r = await this.conflictDialog(tab, disk)
      if (r !== 'keep') return r === 'saved'
    }
    return this.writeTo(tab, tab.path, data)
  }

  private async writeTo(tab: Tab, target: string, data: Buffer): Promise<boolean> {
    for (;;) {
      try {
        await atomicWrite(target, data)
        // 保存提示里说清这次写进去的是什么：改了几处，其余字符原样保留（v0.10）
        const sum = summarize(tab.baseSource, this.changesOf(tab))
        tab.diskHash = sha256(data)
        tab.baseSource = tab.doc.source
        tab.doc.markSaved()
        tab.typingDirty = false
        tab.missing = false
        this.toast('info', TOAST.saved, sum.count ? M.savedSummary(path.basename(target), sum.count, sum.untouched) : path.basename(target))
        this.broadcast()
        return true
      } catch (err) {
        const r = await this.ask({ ...DIALOG.saveFailed(errorReason(err)), type: 'error', defaultId: 0, cancelId: 2 })
        if (r === 0) continue
        if (r === 1) return this.saveAs(tab)
        return false
      }
    }
  }

  async saveAs(tab: Tab | undefined = this.active): Promise<boolean> {
    if (!tab) return false
    await tab.flush()
    if (tab.doc.readOnly) {
      this.toast('warn', M.readOnlySave, M.readOnlySaveSub)
      return false
    }
    const defaultName = tab.path ? path.basename(tab.path) : M.untitledFile
    const defaultDir = tab.path ? path.dirname(tab.path) : app.getPath('documents')
    const r = await dialog.showSaveDialog(this.win, {
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
    })
    if (r.canceled || !r.filePath) return false
    const target = r.filePath
    const data = encodeFile(tab.doc.source, tab.doc.eol, tab.doc.hasBom)
    const prevPath = tab.path
    const prevDir = prevPath ? path.dirname(prevPath) : null
    const ok = await this.writeTo(tab, target, data)
    if (!ok) return false
    // 另存为同一路径以外的文件：更新标签名、路径与监听
    const other = this.tabs.find((t) => t !== tab && t.path && path.resolve(t.path) === path.resolve(target))
    if (other) await this.closeTab(other.id)
    tab.path = target
    tab.name = path.basename(target)
    tab.isSample = false
    this.watch(tab)
    addRecent(target)
    this.onMenuChanged()
    if (prevDir !== path.dirname(target)) {
      // 相对路径资源的基准目录变了：资源根重置为新目录，原授权不沿用
      tab.resourceRoot = path.dirname(target)
      tab.outOfRoot.clear()
      tab.bannerDismissed = false
      tab.watchMissingAssets = true
      await tab.reload()
    } else if (prevPath === null) {
      await tab.reload()
    }
    this.broadcast()
    return true
  }

  // ---------- 外部变更（13.10） ----------

  private async onFileEvent(tab: Tab, ev: WatchEvent): Promise<void> {
    if (!this.tabs.includes(tab) || !tab.path) return
    if (ev === 'unlink') {
      await new Promise((r) => setTimeout(r, 300))
      if (fs.existsSync(tab.path)) return this.onFileEvent(tab, 'change')
      if (!tab.missing) {
        tab.missing = true
        this.toast('warn', TOAST.missing, tab.name, 4000)
        this.broadcast()
      }
      return
    }
    let buf: Buffer
    try {
      buf = await fs.promises.readFile(tab.path)
    } catch {
      return
    }
    tab.missing = false
    if (sha256(buf) === tab.diskHash) return // 本应用自己的写入
    if (tab.id !== this.activeId) {
      tab.pendingExternal = true
      return
    }
    await this.handleExternal(tab)
  }

  private async handleExternal(tab: Tab): Promise<void> {
    tab.pendingExternal = false
    if (!tab.path) return
    let buf: Buffer
    try {
      buf = await fs.promises.readFile(tab.path)
    } catch {
      return
    }
    if (sha256(buf) === tab.diskHash) return
    await tab.flush()
    if (!tab.dirty) {
      await this.reloadWith(tab, buf)
      this.toast('info', TOAST.reloaded, tab.name)
      return
    }
    await this.conflictDialog(tab, buf)
  }

  /**
   * 三方合并（20.5）：base = 上次与磁盘同步时的 source，mine = 内存版本，theirs = 磁盘版本。
   * 结构一致时，不冲突的修改自动合并，冲突逐项选择；返回 false 表示无法合并或用户取消。
   */
  async merge(tab: Tab, disk: Buffer): Promise<boolean> {
    const d = decodeFile(disk)
    if (d.readOnly) return false
    const plan = plan3(tab.baseSource, tab.doc.source, d.source)
    if (!plan) return false
    const chosen = [...plan.auto]
    for (let i = 0; i < plan.conflicts.length; i++) {
      const c = plan.conflicts[i]
      const r = await this.ask({ ...DIALOG.mergeItem(i + 1, plan.conflicts.length, c.label, c.mine, c.theirs), type: 'question', defaultId: 0, cancelId: 2 })
      if (r === 2) return false
      if (r === 0 && c.patch) chosen.push(c.patch)
    }
    const merged = applyPatches(d.source, chosen).source
    // 磁盘版本作为新的基准；合并结果作为一次可撤销的修改留在内存里
    tab.doc.reload({ source: d.source, eol: d.eol, hasBom: d.hasBom, readOnly: null })
    tab.baseSource = d.source
    tab.diskHash = sha256(disk)
    if (merged !== d.source) tab.doc.applyOp({ type: 'replaceAll', source: merged })
    tab.typingDirty = false
    await tab.reload()
    this.toast('info', TOAST.merged, plan.conflicts.length ? M.conflictsResolved(plan.conflicts.length) : undefined)
    this.broadcast()
    return true
  }

  /** 外部修改冲突对话框。返回 keep 表示保留内存版本（下次保存覆盖磁盘）。 */
  private async conflictDialog(tab: Tab, disk: Buffer): Promise<'keep' | 'reloaded' | 'saved' | 'cancel'> {
    const d = decodeFile(disk)
    const mergeable = !tab.doc.readOnly && !d.readOnly && plan3(tab.baseSource, tab.doc.source, d.source) !== null
    if (mergeable) {
      const r = await this.ask({ ...DIALOG.conflictMerge, defaultId: 3, cancelId: 2 })
      if (r === 3) {
        if (await this.merge(tab, disk)) return 'reloaded'
        return this.conflictDialog(tab, disk)
      }
      if (r === 1) {
        await this.reloadWith(tab, disk)
        return 'reloaded'
      }
      if (r === 0) return (await this.saveAs(tab)) ? 'saved' : 'cancel'
      tab.diskHash = sha256(disk)
      this.broadcast()
      return 'keep'
    }
    const r = await this.ask({ ...DIALOG.conflict, defaultId: 0, cancelId: 2 })
    if (r === 1) {
      await this.reloadWith(tab, disk)
      return 'reloaded'
    }
    if (r === 0) {
      // 另存为：当前内容存到新路径，原路径不变
      const ok = await this.saveAs(tab)
      return ok ? 'saved' : 'cancel'
    }
    tab.diskHash = sha256(disk)
    this.broadcast()
    return 'keep'
  }

  private async reloadWith(tab: Tab, buf: Buffer): Promise<void> {
    const d = decodeFile(buf)
    tab.doc.reload({ source: d.source, eol: d.eol, hasBom: d.hasBom, readOnly: d.readOnly ? 'READONLY_FILE' : null })
    tab.readOnlyKind = d.readOnly
    tab.diskHash = sha256(buf)
    tab.baseSource = d.source
    tab.typingDirty = false
    tab.missing = false
    tab.extFail = false
    tab.assetsMissing = false
    await tab.reload()
    this.broadcast()
  }

  /** F5：载入磁盘版本；有未保存修改时先确认。 */
  async reloadFromDisk(): Promise<void> {
    const tab = this.active
    if (!tab) return
    await tab.flush()
    if (!tab.path) return
    if (tab.dirty) {
      const r = await this.ask({ ...DIALOG.reloadConfirm, defaultId: 1, cancelId: 1 })
      if (r !== 0) return
    }
    try {
      await this.reloadWith(tab, await fs.promises.readFile(tab.path))
      this.toast('info', TOAST.reloaded, tab.name)
    } catch (err) {
      this.toast('error', M.reloadFailed, errorReason(err))
    }
  }

  // ---------- 编辑 ----------

  async undo(): Promise<void> {
    const tab = this.active
    if (!tab) return
    if (tab.editing) {
      const r = await tab.request<{ native: boolean }>('undo')
      if (r?.native) return
    } else if (tab.mode === 'preview' && (await tab.request<boolean>('formFocus'))) {
      // 预览模式下焦点在页面自己的输入框里：撤销交给它（7.1 页面交互全部放行）
      tab.view.webContents.undo()
      return
    }
    const sync = tab.doc.undoSync()
    if (sync) tab.applySync(sync)
    this.broadcast()
  }

  async redo(): Promise<void> {
    const tab = this.active
    if (!tab) return
    if (tab.editing) {
      const r = await tab.request<{ native: boolean }>('redo')
      if (r?.native) return
    } else if (tab.mode === 'preview' && (await tab.request<boolean>('formFocus'))) {
      tab.view.webContents.redo()
      return
    }
    const sync = tab.doc.redoSync()
    if (sync) tab.applySync(sync)
    this.broadcast()
  }

  /** 不带参数：在编辑与预览之间切换（Cmd/Ctrl+E）。v0.8 起只有这两个模式；'select' 是旧名，按编辑处理。 */
  async setMode(mode?: Mode | 'select'): Promise<void> {
    const tab = this.active
    if (!tab) return
    this.dropFreeze()
    await tab.flush()
    const next: Mode = mode === undefined ? (tab.mode === 'preview' ? 'edit' : 'preview') : mode === 'select' ? 'edit' : mode
    tab.mode = next
    if (next !== 'edit') tab.selection = null
    this.hover = null
    tab.send('mode:set', tab.mode)
    this.broadcast()
  }

  // ---------- 结构与属性类操作（第 20 节） ----------

  /** 应用剪贴板：复制的元素原文（v0.3），可粘贴到其他标签 */
  clip: { html: string; classes: string[] } | null = null

  async applyOp(op: StructOp, tab: Tab | undefined = this.active): Promise<boolean> {
    if (!tab) return false
    await tab.flush()
    if (tab.doc.readOnly) {
      this.toast('warn', TOAST.readOnlyOp)
      return false
    }
    try {
      const sync = tab.doc.applyOp(op)
      if (!sync) return true
      if (sync.kind === 'attr') {
        tab.applySync(sync)
        void tab.request('refreshSelection')
      } else {
        tab.applySync(sync)
        const done = op.type === 'delete' ? TOAST.deleted : op.type === 'duplicate' ? TOAST.duplicated : op.type === 'move' ? TOAST.moved : null
        if (done) this.note(done)
      }
      this.broadcast()
      return true
    } catch (err) {
      if (!(err instanceof EditError)) {
        console.error('[twiq] op failed', err)
        this.toast('error', TOAST.commitFailed)
        return false
      }
      if (err.code === 'NOOP') return false
      this.toast('warn', this.rejectText(op, err))
      tab.send('select:reject')
      return false
    }
  }

  private rejectText(op: StructOp, err: EditError): string {
    if (err.code === 'STRUCTURE') return TOAST.rejectStructure
    if (/no explicit end tag|no end tag|cannot unwrap/.test(err.message)) return TOAST.rejectRange
    if (/li outside/.test(err.message)) return TOAST.rejectLi
    if (/tr outside|cell outside/.test(err.message)) return TOAST.rejectTr
    if (op.type === 'format') return TOAST.rejectSelection
    return TOAST.rejectTarget
  }

  /** 元素源码原文（v0.10 源码编辑）：没有完整起止标签的元素返回 null */
  sourceOf(eid: Eid): string | null {
    const el = this.active?.doc.elements[eid]
    return el?.rangeOk ? rawOf(this.active!.doc.source, el) : null
  }

  /** 源码编辑提交（v0.6 起 SVG，v0.10 起任意元素）：整个元素原文替换为一次补丁；失败时撤回预览。 */
  async applySource(eid: Eid, html: string): Promise<boolean> {
    const tab = this.active
    if (!tab) return false
    const el = tab.doc.elements[eid]
    if (!el?.rangeOk) return false
    if (html.trim() === rawOf(tab.doc.source, el)) {
      tab.send('source:preview', { eid, html: null })
      return true
    }
    tab.send('source:previewEnd')
    const ok = await this.applyOp({ type: 'replaceElement', eid, html }, tab)
    if (!ok) {
      tab.send('source:preview', { eid, html: null })
      this.toast('warn', el.tag === 'svg' ? TOAST.svgSourceBad : TOAST.sourceBad)
    }
    return ok
  }

  /** 选中元素所在的最外层 svg。 */
  private outerSvg(tab: Tab): Eid | null {
    const sel = tab.selection
    if (!sel || sel.multi) return null
    let svg: Eid | null = null
    for (let p: Eid | null = sel.eid; p !== null; p = tab.doc.elements[p]?.parent ?? null) if (tab.doc.elements[p]?.tag === 'svg') svg = p
    return svg
  }

  /** 选中元素所在的最外层 svg 与源码原文。 */
  private svgSourceOf(tab: Tab): { eid: Eid; html: string } | null {
    const svg = this.outerSvg(tab)
    if (svg === null) return null
    const el = tab.doc.elements[svg]
    if (!el.rangeOk) return null
    return { eid: svg, html: tab.doc.source.slice(el.startTagStart, el.end) }
  }

  /** 选中元素所在的最外层 svg 里可编辑的文字与形状（v0.7）。按文档版本缓存。 */
  private svgModelCache: { doc: DocState; version: number; eid: Eid; model: SvgModel | null } | null = null
  private svgModelOf(tab: Tab): SvgModel | null {
    const svg = this.outerSvg(tab)
    if (svg === null) return null
    const c = this.svgModelCache
    if (c && c.doc === tab.doc && c.version === tab.doc.version && c.eid === svg) return c.model
    const model = svgModel(tab.doc.elements, svg)
    this.svgModelCache = { doc: tab.doc, version: tab.doc.version, eid: svg, model }
    return model
  }

  /** SVG 面板提交文字（v0.7）：与预览里双击改字走同一个入口（commitSvgText），一次一步撤销。 */
  async commitSvgSlot(eid: Eid, slot: number, value: string): Promise<boolean> {
    const tab = this.active
    if (!tab) return false
    await tab.flush()
    if (tab.doc.readOnly) {
      this.toast('warn', TOAST.readOnlyOp)
      return false
    }
    const el = tab.doc.elements[eid]
    if (!el || !el.slots[slot]) return false
    const slots = el.slots.map((x, i) => (i === slot ? value : x.text))
    try {
      const entry = tab.doc.commitSvgText(eid, slots)
      if (entry) {
        tab.syncPreview(entry.ops)
        void tab.request('refreshSelection')
        this.note(TOAST.svgTextDone)
      }
      this.broadcast()
      return true
    } catch (err) {
      if (!(err instanceof EditError)) console.error('[twiq] svg text failed', err)
      tab.syncPreview([{ eid, slot, newText: el.slots[slot].text }])
      this.toast('error', TOAST.commitFailed)
      return false
    }
  }

  selectEid(eid: Eid): void {
    const tab = this.active
    if (!tab) return
    if (tab.mode !== 'edit') void this.setMode('edit')
    tab.send('select:set', eid)
  }

  setSelection(tab: Tab, sel: SelectionInfo | null): void {
    tab.selection = sel
    if (tab.id === this.activeId) this.broadcast()
  }

  setPanelWidth(w: number): void {
    updateSettings({ panelWidth: clampPanel(w) })
    this.broadcast()
  }

  /** v0.9：切换外观偏好；持久化、重建菜单、通知外壳与所有预览叠加层。 */
  setTheme(theme: ThemePreference): void {
    if (settings().theme === theme) return
    updateSettings({ theme })
    this.applyTheme()
    this.onMenuChanged()
  }

  // ---------- 改动面板（v0.10） ----------

  /** 面板切到「改动」时才把完整列表放进状态（列表可能很长，悬停等高频推送不必每次带上） */
  private changesOpen = false
  private changesCache: { doc: DocState; version: number; base: string; list: Change[] } | null = null

  /**
   * 状态推送里的改动处数。缓存过期时不在这次推送里同步重算（大文档每次提交都要整份比较一遍，会拖慢提交），
   * 先用上一次的数，稍后算好再推一次。
   */
  private changesTimer: NodeJS.Timeout | null = null
  private changeCountOf(tab: Tab): number {
    const c = this.changesCache
    if (c && c.doc === tab.doc && c.version === tab.doc.version && c.base === tab.baseSource) return c.list.length
    if (!this.changesTimer) {
      this.changesTimer = setTimeout(() => {
        this.changesTimer = null
        const t = this.active
        if (t) this.changesOf(t)
        this.broadcast()
      }, 30)
    }
    return c && c.doc === tab.doc ? c.list.length : 0
  }

  /** 改动列表单独推送（v0.10）：只在面板停在「改动」页、且列表变了的时候发，悬停之类的高频推送不再带上它 */
  private lastChangesView: ChangesView | null = null
  private sendChangesView(): void {
    const t = this.active
    const view = t && this.changesOpen && t.mode === 'edit' && settings().panelOpen ? this.currentChanges() : null
    if (view === this.lastChangesView) return
    this.lastChangesView = view
    this.win.webContents.send('changes:view', view)
  }

  /** 当前标签页的改动列表（测试也用它） */
  currentChanges(): ChangesView | null {
    const t = this.active
    return t ? this.changesView(t) : null
  }

  /** 当前文档相对上次保存（或打开）的改动；按文档版本缓存 */
  changesOf(tab: Tab): Change[] {
    const c = this.changesCache
    if (c && c.doc === tab.doc && c.version === tab.doc.version && c.base === tab.baseSource) return c.list
    const list = diffChanges(tab.baseSource, tab.doc.source)
    this.changesCache = { doc: tab.doc, version: tab.doc.version, base: tab.baseSource, list }
    return list
  }

  private changesViewCache: { list: Change[]; view: ChangesView } | null = null
  private changesView(tab: Tab): ChangesView {
    const list = this.changesOf(tab)
    if (this.changesViewCache?.list === list) return this.changesViewCache.view
    const view = this.buildChangesView(tab, list)
    this.changesViewCache = { list, view }
    return view
  }

  private buildChangesView(tab: Tab, list: Change[]): ChangesView {
    const src = tab.doc.source
    const els = tab.doc.elements
    const items: ChangeItem[] = []
    let line = 1
    let at = 0
    for (const c of list.slice(0, CHANGES_MAX)) {
      for (; at < c.curStart; at++) if (src.charCodeAt(at) === 10) line++
      const el = innermost(els, c.curStart, c.curEnd)
      items.push({
        kind: c.kind,
        before: clip(c.before),
        after: clip(c.after),
        ctxBefore: src.slice(Math.max(0, c.curStart - CTX), c.curStart).split('\n').pop()!.trimStart(),
        ctxAfter: src.slice(c.curEnd, c.curEnd + CTX).split('\n')[0].trimEnd(),
        line,
        eid: el?.eid ?? null,
        where: el ? `${el.tag}${el.attrs.id ? `#${el.attrs.id.value}` : el.attrs.class ? `.${el.attrs.class.value.trim().split(/\s+/)[0]}` : ''}` : '',
        canRevert: canRevert(c)
      })
    }
    return { version: tab.doc.version, summary: summarize(tab.baseSource, list), items, more: Math.max(0, list.length - CHANGES_MAX) }
  }

  setChangesOpen(open: boolean): void {
    if (this.changesOpen === open) return
    this.changesOpen = open
    this.broadcast()
  }

  /**
   * 列表里的第 index 条，且列表还是界面上看到的那一版（version 对得上）。
   * 连点两下「撤回」、或先提交了正在输入的字，下标就指向别的改动了：这种时候什么也不做，界面会收到新列表
   */
  private changeAt(tab: Tab, index: number, version: number): Change | null {
    if (tab.doc.version !== version) {
      this.broadcast()
      return null
    }
    return this.changesOf(tab)[index] ?? null
  }

  /** 在页面上选中这处改动所在的元素并滚到可见 */
  gotoChange(index: number, version: number): void {
    const tab = this.active
    if (!tab) return
    const c = this.changeAt(tab, index, version)
    const el = c && innermost(tab.doc.elements, c.curStart, c.curEnd)
    if (el) this.selectEid(el.eid)
  }

  /** 撤回其中一处：其余改动保留；作为一步撤销 */
  async revertChange(index: number, version: number): Promise<void> {
    const tab = this.active
    if (!tab) return
    await tab.flush()
    const c = this.changeAt(tab, index, version)
    const next = c && revertOne(tab.doc.source, c)
    if (!next) return
    if (await this.applyOp({ type: 'replaceAll', source: next }, tab)) this.note(TOAST.changeReverted)
  }

  /** 界面语言（v0.10）：重建菜单，外壳随状态重渲染，各标签页的叠加层重写文案；页面本身不动 */
  setLang(pref: LangPreference): void {
    if (settings().lang === pref) return
    updateSettings({ lang: pref })
    const l = applyLang()
    for (const t of this.tabs) t.send('lang:set', l)
    this.onMenuChanged()
    this.broadcast()
  }

  /** 把当前解析后的外观应用到窗口底色与每个标签页的叠加层；不改页面自身。 */
  applyTheme(): void {
    if (!this.win.isDestroyed()) this.win.setBackgroundColor(windowBackground())
    const theme = effectiveTheme()
    for (const t of this.tabs) t.send('theme:set', theme)
    this.broadcast()
  }

  /** 系统外观变化：仅当偏好为「跟随系统」时生效。 */
  refreshTheme(): void {
    if (settings().theme === 'system') this.applyTheme()
  }

  togglePanel(open?: boolean): void {
    this.dropFreeze()
    updateSettings({ panelOpen: open ?? !settings().panelOpen })
    this.broadcast()
  }

  toggleBlank(): void {
    const on = !settings().showBlank
    updateSettings({ showBlank: on })
    for (const t of this.tabs) t.send('blank:set', on)
    // 菜单里的勾选状态跟着变
    this.onMenuChanged()
    this.broadcast()
  }

  /** 一次性提示：同一类说明只出现一次。 */
  hintOnce(key: string, text: string): void {
    const seen = settings().hinted
    if (seen.includes(key)) return
    updateSettings({ hinted: [...seen, key] })
    this.toast('info', text, undefined, 5000)
  }

  commit(tab: Tab, ops: Parameters<DocState['commit']>[0]): { ok: true } | { ok: false; code: string } {
    try {
      tab.doc.commit(ops)
      tab.typingDirty = false
      tab.pushTable()
      this.broadcast()
      return { ok: true }
    } catch (err) {
      const code = err instanceof EditError ? err.code : 'ERROR'
      if (!(err instanceof EditError)) console.error('[twiq] commit failed', err)
      return { ok: false, code }
    }
  }

  // ---------- 资源根（第 14 节） ----------

  async grantRoot(): Promise<void> {
    const tab = this.active
    if (!tab || !tab.path) return
    const fileDir = path.dirname(tab.path)
    const r = await dialog.showOpenDialog(this.win, {
      title: M.chooseRoot,
      properties: ['openDirectory'],
      defaultPath: commonAncestor([fileDir, ...tab.outOfRoot])
    })
    if (r.canceled || !r.filePaths[0]) return
    const dir = r.filePaths[0]
    if (!isAncestorOrSelf(dir, fileDir)) {
      await this.ask({ ...DIALOG.rootNotAncestor, type: 'info' })
      return
    }
    tab.resourceRoot = dir
    setRoot(tab.path, dir === fileDir ? null : dir)
    tab.outOfRoot.clear()
    await tab.reload()
    this.broadcast()
  }

  dismissBanner(): void {
    const tab = this.active
    if (tab) tab.bannerDismissed = true
    this.broadcast()
  }

  async openExternal(url: string): Promise<void> {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return
    }
    const r = await this.ask({ ...DIALOG.external(host), type: 'question', defaultId: 0, cancelId: 1 })
    if (r === 0) await shell.openExternal(url)
  }

  emitStats(tab: Tab): void {
    this.statsListener?.(tab)
  }

  revealInFolder(): void {
    const p = this.active?.path
    if (p) shell.showItemInFolder(p)
  }

  clearRecent(): void {
    clearRecent()
    this.onMenuChanged()
    this.broadcast()
  }

  async showShortcuts(): Promise<void> {
    const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl'
    const lines = M.shortcuts(mod, process.platform === 'win32')
    await this.ask({ title: M.shortcutsTitle, detail: lines.join('\n\n'), buttons: [M.ok], type: 'info' })
  }

  /** v0.3–v0.5 的指令，见 features.ts */
  extra: (cmd: ShellCommand) => Promise<void> | void = () => {}

  async command(cmd: ShellCommand): Promise<void> {
    switch (cmd.type) {
      case 'open':
        return this.openDialog()
      case 'openPaths':
        this.clearDrag()
        return this.serial(() => this.openPaths(cmd.paths))
      case 'openRecent':
        return this.serial(() => this.openRecent(cmd.path))
      case 'clearRecent':
        return this.clearRecent()
      case 'new':
        return this.newDoc()
      case 'sample':
        return this.loadSample()
      case 'save':
        return void (await this.serial(() => this.save()))
      case 'saveAs':
        return void (await this.serial(() => this.saveAs()))
      case 'undo':
        return this.serial(() => this.undo())
      case 'redo':
        return this.serial(() => this.redo())
      case 'mode':
        return this.setMode(cmd.mode)
      case 'viewport':
        return this.setViewport(cmd.value)
      case 'zoom':
        return this.zoom(cmd.dir)
      case 'activate':
        return this.activate(cmd.id)
      case 'close':
        return void (await this.closeTab(cmd.id))
      case 'reorder':
        return this.reorder(cmd.from, cmd.to)
      case 'grantRoot':
        return this.grantRoot()
      case 'dismissBanner':
        return this.dismissBanner()
      case 'focusPreview': {
        const t = this.active
        if (t) {
          t.view.webContents.focus()
          t.send('focus:enter')
        }
        return
      }
      case 'drag':
        return this.setDrag('shell', { active: cmd.active, ok: cmd.ok })
      case 'shortcuts':
        return this.showShortcuts()
      case 'selectEid':
        return this.selectEid(cmd.eid)
      case 'peekEid':
        this.active?.send('select:peek', cmd.eid)
        return
      case 'op':
        return void (await this.serial(() => this.applyOp(cmd.op)))
      case 'sourcePreview':
        this.active?.send('source:preview', { eid: cmd.eid, html: cmd.html })
        return
      case 'sourceApply':
        return void (await this.serial(() => this.applySource(cmd.eid, cmd.html)))
      case 'svgLive':
        this.active?.send('svg:live', { eid: cmd.eid, name: cmd.name, slot: cmd.slot, value: cmd.value })
        return
      case 'svgText':
        return void (await this.serial(() => this.commitSvgSlot(cmd.eid, cmd.slot, cmd.value)))
      case 'panel':
        return this.togglePanel(cmd.open)
      case 'panelWidth':
        return this.setPanelWidth(cmd.width)
      case 'theme':
        return this.setTheme(cmd.value)
      case 'lang':
        return this.setLang(cmd.value)
      case 'changesView':
        return this.setChangesOpen(cmd.open)
      case 'gotoChange':
        return this.gotoChange(cmd.index, cmd.version)
      case 'revertChange':
        return void (await this.serial(() => this.revertChange(cmd.index, cmd.version)))
      case 'showBlank':
        return this.toggleBlank()
      default:
        return this.extra(cmd)
    }
  }
}
