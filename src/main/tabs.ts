// 标签页：一份 DocState + 一个预览视图（规格 12.2、13.11、第 14 节）。
import { Menu, WebContentsView, session as electronSession, type Session } from 'electron'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Eid, Lang, Mode, PageStats, PreviewInit, PreviewSync, ResolvedTheme, SelectionInfo, SetSlotOp } from '../shared/types'

export type ReadOnlyKindLike = 'encoding' | 'eol' | null
import { DocState } from './document'
import { annotate } from './annotate'
import { entryUrl, handleRequest, SCHEME } from './protocol'
import { PREVIEW_CANVAS } from './theme'
import { M } from './strings'

export const PRELOAD = path.join(__dirname, '../preload/preview.js')

let nextId = 1

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface TabHooks {
  onOutOfRoot(tab: Tab, dir: string): void
  onExtFail(tab: Tab): void
  onLocalMissing(tab: Tab): void
  onLoaded(tab: Tab): void
  onCrashed(tab: Tab): void
}

export interface TabInit {
  path: string | null
  name: string
  doc: DocState
  readOnlyKind: ReadOnlyKindLike
  diskHash: string
  isSample?: boolean
  /** 无路径文档的虚拟入口（如示例文档的位置） */
  virtualEntry?: string
  resourceRoot: string | null
}

export class Tab {
  readonly id: string
  path: string | null
  name: string
  doc: DocState
  readOnlyKind: ReadOnlyKindLike
  diskHash: string
  isSample: boolean
  virtualEntry: string
  resourceRoot: string | null
  readonly view: WebContentsView
  readonly session: Session
  mode: Mode = 'edit'
  editing = false
  selection: SelectionInfo | null = null
  /** 下次载入后选中的元素 / 进入文字编辑的 host */
  pendingSelect: Eid | null = null
  pendingEdit: Eid | null = null
  pendingCaret: { start: number; end: number } | null = null
  /** 打开或最近一次与磁盘同步时的 source：三方合并的基准（20.5） */
  baseSource = ''
  typingDirty = false
  missing = false
  pendingExternal = false
  extFail = false
  outOfRoot = new Set<string>()
  bannerDismissed = false
  watchMissingAssets = false // 另存到其他目录后的这次重载期间，记录本地资源缺失
  assetsMissing = false
  scriptRenderedNotified = false
  stats: PageStats | null = null
  scrollY = 0
  loaded = false
  /** 预览整页载入的次数（测试用：结构操作应就地同步，不增加这个数） */
  loads = 0
  private annotatedCache: { version: number; html: string } | null = null
  private reqSeq = 0
  private pending = new Map<number, (v: unknown) => void>()

  constructor(init: TabInit, hooks: TabHooks) {
    this.id = String(nextId++)
    this.path = init.path
    this.name = init.name
    this.doc = init.doc
    this.readOnlyKind = init.readOnlyKind
    this.diskHash = init.diskHash
    this.isSample = init.isSample ?? false
    this.virtualEntry = init.virtualEntry ?? path.join(path.sep === '\\' ? 'C:\\' : '/', `untitled-${this.id}`, M.untitledFile)
    this.resourceRoot = init.resourceRoot
    // 改动面板与三方合并的基准：打开文件时由调用方换成磁盘内容；新建与示例就是初始内容（v0.10）
    this.baseSource = init.doc.source

    // 专用的内存会话分区：关闭后 cookie 与 localStorage 随之清除
    this.session = electronSession.fromPartition(`hw-tab-${this.id}`, { cache: false })
    this.secureSession(hooks)
    this.view = new WebContentsView({
      webPreferences: {
        preload: PRELOAD,
        partition: `hw-tab-${this.id}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        navigateOnDragDrop: false
      }
    })
    this.view.setBackgroundColor(PREVIEW_CANVAS)
    const wc = this.view.webContents
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.on('will-redirect', (e) => e.preventDefault())
    // iframe 内的跳转同样阻止（14）；页面加载时 iframe 的初始载入不经过这里
    wc.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame) e.preventDefault()
    })
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('did-finish-load', () => {
      this.loaded = true
      hooks.onLoaded(this)
    })
    wc.on('render-process-gone', () => hooks.onCrashed(this))
    // 编辑中的右键：系统原生的文字菜单（8.3）
    wc.on('context-menu', (_e, params) => {
      if (!params.isEditable) return
      Menu.buildFromTemplate([
        { role: 'cut', label: M.cut },
        { role: 'copy', label: M.copy },
        { role: 'paste', label: M.paste },
        { type: 'separator' },
        { role: 'selectAll', label: M.selectAll }
      ]).popup()
    })
  }

  private secureSession(hooks: TabHooks): void {
    const s = this.session
    s.protocol.handle(SCHEME, (req) =>
      handleRequest(req, {
        entryPath: () => this.entryPath,
        resourceRoot: () => this.resourceRoot,
        annotated: () => this.annotated(),
        onOutOfRoot: (dir) => hooks.onOutOfRoot(this, dir)
      })
    )
    // 权限请求与检查一律拒绝
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    s.setPermissionCheckHandler(() => false)
    s.setDevicePermissionHandler(() => false)
    // 下载一律取消
    s.on('will-download', (e) => e.preventDefault())
    // 只允许 hw、http、https、data、blob
    s.webRequest.onBeforeRequest((details, cb) => {
      const proto = details.url.slice(0, details.url.indexOf(':') + 1).toLowerCase()
      const ok = proto === 'hw:' || proto === 'http:' || proto === 'https:' || proto === 'data:' || proto === 'blob:' || proto === 'devtools:'
      cb({ cancel: !ok })
    })
    const fail = (url: string): void => {
      if (/^https?:/i.test(url)) hooks.onExtFail(this)
      else if (/^hw:/i.test(url) && !/\/favicon\.ico$/i.test(url)) hooks.onLocalMissing(this)
    }
    s.webRequest.onErrorOccurred((d) => {
      if (d.error !== 'net::ERR_ABORTED' && d.error !== 'net::ERR_BLOCKED_BY_CLIENT') fail(d.url)
    })
    s.webRequest.onCompleted((d) => {
      if (d.statusCode >= 400) fail(d.url)
    })
  }

  get entryPath(): string {
    return this.path ?? this.virtualEntry
  }

  get dirty(): boolean {
    return this.doc.dirty || this.typingDirty
  }

  annotated(): string {
    if (!this.annotatedCache || this.annotatedCache.version !== this.doc.version) {
      this.annotatedCache = { version: this.doc.version, html: annotate(this.doc.source, this.doc.elements) }
    }
    return this.annotatedCache.html
  }

  load(): void {
    this.loads++
    this.loaded = false
    this.editing = false
    this.typingDirty = false
    this.assetsMissing = false
    this.stats = null
    void this.view.webContents.loadURL(entryUrl(this.id, this.entryPath))
  }

  /** 重新加载预览并保留滚动位置。 */
  async reload(): Promise<void> {
    this.scrollY = await this.readScroll()
    this.load()
  }

  async readScroll(): Promise<number> {
    if (!this.loaded) return this.scrollY
    try {
      const y = await this.view.webContents.executeJavaScript('window.scrollY', true)
      return typeof y === 'number' ? y : 0
    } catch {
      return 0
    }
  }

  init(zoom: number, isMac: boolean, showBlank: boolean, theme: ResolvedTheme, lang: Lang): PreviewInit {
    const select = this.pendingSelect
    const editHost = this.pendingEdit
    const caret = this.pendingCaret
    this.pendingSelect = null
    this.pendingEdit = null
    this.pendingCaret = null
    return {
      caret,
      select,
      editHost,
      showBlank,
      theme,
      lang,
      tabId: this.id,
      mode: this.mode,
      readOnly: this.doc.readOnly,
      elements: this.doc.previewTable(),
      scrollY: this.scrollY,
      zoom,
      isMac
    }
  }

  send(channel: string, payload?: unknown): void {
    if (this.view.webContents.isDestroyed()) return
    this.view.webContents.send(channel, payload)
  }

  /** 向预览发请求并等待回复；预览无响应时按超时返回 null。 */
  request<T>(type: string, payload?: unknown, timeout = 1500): Promise<T | null> {
    if (!this.loaded || this.view.webContents.isDestroyed()) return Promise.resolve(null)
    const id = ++this.reqSeq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeout)
      this.pending.set(id, (v) => {
        clearTimeout(timer)
        resolve(v as T)
      })
      this.send('main:request', { id, type, payload })
    })
  }

  resolveRequest(id: number, value: unknown): void {
    const fn = this.pending.get(id)
    if (fn) {
      this.pending.delete(id)
      fn(value)
    }
  }

  /** 若在编辑中，先提交（7.4）。 */
  async flush(): Promise<void> {
    if (!this.editing) return
    await this.request('flush')
  }

  syncPreview(ops: SetSlotOp[]): void {
    this.send('edit:sync', { ops, elements: this.doc.previewTable() })
  }

  /** 撤销、重做与结构类操作之后的预览同步。 */
  applySync(sync: PreviewSync): void {
    if (sync.kind === 'text') this.syncPreview(sync.ops)
    else if (sync.kind === 'attr') this.send('attr:sync', { attrs: sync.attrs, elements: this.doc.previewTable() })
    else {
      this.selection = null
      // 结构变化：优先就地改 DOM（不闪、不跳滚动）；没有可靠步骤或预览校验失败时整页重载
      if (sync.dom && this.loaded && !this.view.webContents.isDestroyed()) {
        const edit = this.pendingEdit
        const caret = this.pendingCaret
        this.pendingEdit = null
        this.pendingCaret = null
        void this.request<boolean>('domSync', { dom: sync.dom, elements: this.doc.previewTable(), select: sync.select, edit, caret }, 3000).then((ok) => {
          if (ok === true) return
          this.pendingEdit = edit
          this.pendingCaret = caret
          this.reloadSelecting(sync.select)
        })
        return
      }
      this.reloadSelecting(sync.select)
    }
  }

  private reloadSelecting(select: Eid | null): void {
    this.pendingSelect = select
    void this.reload()
  }

  pushTable(): void {
    this.send('preview:table', this.doc.previewTable())
  }

  destroy(): void {
    for (const fn of this.pending.values()) fn(null)
    this.pending.clear()
    try {
      this.view.webContents.close()
    } catch {
      // 已销毁
    }
    void this.session.clearStorageData().catch(() => {})
  }
}
