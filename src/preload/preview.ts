// 预览视图的 preload（隔离世界）：叠加层、编辑层、结构快照（规格 7、8、13.6）。
// 页面脚本读不到这里的变量，但两者共享 DOM。
import { ipcRenderer, webUtils } from 'electron'
import type { DomSync, Eid, HoverInfo, Lang, Mode, PreviewElement, PreviewInit, ReasonCode, ResolvedTheme, SetSlotOp, Snapshot, StructOp, ToastMsg } from '../shared/types'
import { setLang } from '../shared/i18n'
import { REASONS, TOAST } from '../shared/messages'
import { S } from './strings'
import { Overlay } from './overlay'
import * as sel from './select'
import { applyDomSync } from './dom-apply'
import * as svgText from './svg-edit'
import {
  blankElements,
  breadcrumb,
  computeStats,
  editableHosts,
  eidOf,
  hitTest,
  isVisible,
  setSlotText,
  snapshot,
  type HitTarget,
  type Table
} from './dom'

const PASTE_MAX = 5000

let tabId = ''
let mode: Mode = 'edit'
let isMac = false
let table: Table = new Map()
let ready = false

interface Session {
  host: HTMLElement
  eid: Eid
  baseline: Snapshot
  baselineText: string
  clones: Node[]
  prevContentEditable: string | null
  nativeUndos: number
  lastDirty: boolean
}
let session: Session | null = null
let committing: Promise<void> | null = null
let composing = false
let compositionWaiters: (() => void)[] = []
let hoverTarget: HitTarget | null = null
// Tab 切换期间（提交上一个、进入下一个）键入的字符，进入下一个 host 后补上
let tabbing = false
let pendingKeys = ''

const overlay = new Overlay({
  done: () => void commitAndExit(),
  undoInput: () => void toolbarUndo(),
  abandon: () => abandon(),
  format: (tag) => void formatSelection(tag),
  selectParent: () => sel.selectRelative('parent'),
  duplicate: () => sel.runOp('duplicate'),
  remove: () => sel.runOp('delete'),
  resizeStart: (edge, e) => sel.resizeStart(edge, e),
  blockDrag: (el, e) => sel.beginBlockDrag(el, e)
})

sel.init({
  overlay,
  table: () => table,
  tabId: () => tabId,
  isMac: () => isMac,
  enter: (host, point) => enter(host, point),
  enterSvgText: (el) => svgText.start(el, svgCtx),
  activate: (target, point) => activate(target, point),
  selected: () => updateCursor()
})

const svgCtx: svgText.SvgTextCtx = {
  tabId: () => tabId,
  root: () => overlay.layer,
  refuse: (el, text, sub, level = 'warn') => {
    overlay.reject(el, level)
    overlay.toast(text, sub, level, level === 'error' ? 4000 : 3600)
  },
  done: (el) => {
    if (mode === 'edit' && el.isConnected) sel.select(el as unknown as HTMLElement)
  },
  expected: (eid) => table.get(eid)?.slots
}

// ---------- 光标样式（不改页面 DOM，用 adoptedStyleSheets） ----------
let cursorSheet: CSSStyleSheet | null = null
function setCursorRule(css: string): void {
  try {
    if (!cursorSheet) {
      cursorSheet = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursorSheet]
    }
    // 编辑模式下 iframe 等嵌入内容不处理点击（15），点击落到外层页面，由这里统一拦截
    const frames = mode === 'edit' ? 'iframe, frame, object, embed { pointer-events: none !important; } ' : ''
    cursorSheet.replaceSync(`[data-hw][contenteditable]:focus { outline: none !important; } ${frames}${css}`)
  } catch {
    // 不支持时只是缺少光标提示
  }
}
// 编辑中 host 的空白样式：Chromium 对 plaintext-only 强制 white-space: pre-wrap，
// 会让源码里的换行与缩进显示出来、改变布局（8.2 要求不改变布局），这里按进入前的值覆盖回去。
let editSheet: CSSStyleSheet | null = null
function setEditRule(css: string): void {
  try {
    if (!editSheet) {
      editSheet = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, editSheet]
    }
    editSheet.replaceSync(css)
  } catch {
    // 忽略
  }
}
function keepWhitespace(host: HTMLElement, eid: Eid): void {
  const cs = getComputedStyle(host)
  setEditRule(
    `[data-hw="${eid}"][contenteditable] { white-space-collapse: ${cs.whiteSpaceCollapse} !important; text-wrap-mode: ${cs.textWrapMode} !important; overflow-wrap: ${cs.overflowWrap} !important; line-break: ${cs.lineBreak} !important; }`
  )
}

/** 选中的元素属于可编辑的文字块时，鼠标在它上面显示文字光标：提示「再点一次改文字」（v0.8）。
 *  选中图片、SVG、容器这类不能改字的元素时显示张开的手（grab）：提示整块可以拖（v0.8.1）。 */
function updateCursor(): void {
  if (mode !== 'edit' || session) return setCursorRule('')
  const cur = sel.current()
  const eid = cur ? eidOf(cur) : null
  const info = eid !== null ? table.get(eid) : undefined
  const host = info ? (info.host ? eid : info.hostId) : undefined
  if (host !== undefined && host !== null && !table.get(host)?.reason) {
    return setCursorRule(`[data-hw="${host}"], [data-hw="${host}"] * { cursor: text !important; }`)
  }
  if (eid !== null) return setCursorRule(`[data-hw="${eid}"], [data-hw="${eid}"] * { cursor: grab !important; }`)
  setCursorRule('')
}

// ---------- 与主进程通信 ----------
function send(channel: string, payload: Record<string, unknown> = {}): void {
  ipcRenderer.send(channel, { tabId, ...payload })
}

function setTable(elements: PreviewElement[]): void {
  table = new Map(elements.map((e) => [e.eid, e]))
}

function sendHover(el: Element | null, editable: boolean, reason?: ReasonCode): void {
  let info: HoverInfo | null = null
  if (el) {
    const b = breadcrumb(el)
    info = { breadcrumb: b.parts, fullSelector: b.full, selectors: b.selectors, eids: b.eids, editable, reason }
  }
  send('preview:hover', { info })
}

ipcRenderer.on('preview:table', (_e, elements: PreviewElement[]) => {
  svgLive.clear()
  setTable(elements)
})
ipcRenderer.on('edit:sync', (_e, msg: { ops: SetSlotOp[]; elements: PreviewElement[] }) => {
  svgLive.clear()
  for (const op of msg.ops) setSlotText(op.eid, op.slot, op.newText)
  setTable(msg.elements)
  overlay.reposition()
})
ipcRenderer.on('mode:set', (_e, m: Mode) => {
  void svgText.finish(svgCtx, true)
  setMode(m)
})
// v0.9：应用外观变化只切换叠加层 token；页面自身样式不受影响
ipcRenderer.on('theme:set', (_e, theme: ResolvedTheme) => overlay.setTheme(theme))
// v0.10：界面语言变化只重写叠加层文案；页面自身不受影响
ipcRenderer.on('lang:set', (_e, l: Lang) => {
  setLang(l)
  overlay.relabel()
})
ipcRenderer.on('attr:sync', (_e, msg: { attrs: { eid: Eid; name: string; value: string | null }[]; elements: PreviewElement[] }) => {
  svgLive.clear()
  for (const a of msg.attrs) {
    const el = document.querySelector(`[data-hw="${a.eid}"]`)
    if (!el) continue
    if (a.value === null) {
      // Chromium：带过 srcset 的图片删掉 srcset、改了 src 之后不会重新加载，一直显示破图（v0.10 替换图片时实测）。
      // 先让 srcset 指向当前的 src 触发一次加载，再删掉
      const src = el.getAttribute('src')
      if (a.name === 'srcset' && el.localName === 'img' && src) el.setAttribute('srcset', src)
      el.removeAttribute(a.name)
    } else el.setAttribute(a.name, a.value)
  }
  setTable(msg.elements)
  sel.refresh()
  overlay.reposition()
})
// 源码编辑（v0.6 SVG，v0.10 任意元素）：输入时临时替换预览里的元素，不写源码；提交或取消后由主进程同步
let sourcePreview: { eid: Eid; original: Element } | null = null
ipcRenderer.on('source:preview', (_e, msg: { eid: Eid; html: string | null }) => {
  if (msg.html === null) {
    if (sourcePreview) {
      const cur = document.querySelector(`[data-source-preview]`)
      if (cur) cur.replaceWith(sourcePreview.original)
      sourcePreview = null
      sel.refresh()
      overlay.reposition()
    }
    return
  }
  const cur = sourcePreview ? document.querySelector(`[data-source-preview]`) : document.querySelector(`[data-hw="${msg.eid}"]`)
  if (!cur) return
  const tpl = document.createElement('template')
  tpl.innerHTML = msg.html
  // template 能解析任何片段（tr、li 等也行）；svg 片段在 HTML 里解析成 SVG 命名空间
  const next = tpl.content.firstElementChild
  if (!next || next.localName !== cur.localName) return
  next.setAttribute('data-source-preview', '')
  if (!sourcePreview) sourcePreview = { eid: msg.eid, original: cur }
  cur.replaceWith(next)
  overlay.reposition()
})
ipcRenderer.on('source:previewEnd', () => {
  // 已提交：主进程的就地同步会替换元素，这里只丢掉保存的原节点
  const cur = document.querySelector(`[data-source-preview]`)
  if (cur && sourcePreview) cur.replaceWith(sourcePreview.original)
  sourcePreview = null
})
// SVG 面板输入中的实时预览（v0.7）：只改预览里的属性或文字；提交后由主进程按源码同步，放弃时按 value=null 还原
const svgLive = new Map<string, { el: Element; attr?: string; slot?: number; before: string | null }>()
/** 还原全部未提交的实时预览（提交被拒时）。 */
function restoreLive(): void {
  for (const [key, rec] of svgLive) {
    if (!rec.el.isConnected) continue
    if (rec.attr) {
      if (rec.before === null) rec.el.removeAttribute(rec.attr)
      else rec.el.setAttribute(rec.attr, rec.before)
    } else if (rec.slot !== undefined) setSlotText(Number(key.split(':')[0]), rec.slot, rec.before ?? '')
  }
  svgLive.clear()
}
ipcRenderer.on('svg:live', (_e, msg: { eid: Eid; name?: string; slot?: number; value: string | null }) => {
  const el = document.querySelector(`[data-hw="${msg.eid}"]`)
  if (!el || !(el instanceof SVGElement)) return
  const key = `${msg.eid}:${msg.name ?? `#${msg.slot}`}`
  let rec = svgLive.get(key)
  if (msg.value === null) {
    // 放弃：还原输入前的值
    if (rec && rec.el.isConnected) {
      if (rec.attr) {
        if (rec.before === null) rec.el.removeAttribute(rec.attr)
        else rec.el.setAttribute(rec.attr, rec.before)
      } else if (rec.slot !== undefined) setSlotText(msg.eid, rec.slot, rec.before ?? '')
    }
    svgLive.delete(key)
  } else {
    if (!rec || rec.el !== el) {
      rec = msg.name
        ? { el, attr: msg.name, before: el.getAttribute(msg.name) }
        : { el, slot: msg.slot, before: table.get(msg.eid)?.slots?.[msg.slot ?? 0] ?? null }
      svgLive.set(key, rec)
    }
    if (msg.name) {
      if (msg.value === '') el.removeAttribute(msg.name)
      else el.setAttribute(msg.name, msg.value)
    } else if (msg.slot !== undefined) setSlotText(msg.eid, msg.slot, msg.value)
  }
  overlay.reposition()
})
ipcRenderer.on('select:set', (_e, eid: Eid) => {
  const el = document.querySelector<HTMLElement>(`[data-hw="${eid}"]`)
  if (!el) return
  // SVG 内部元素（从面板列表点选）：先进入外层 svg 的隔离，与双击进入一致
  const svg = el.localName !== 'svg' ? el.closest('svg') : null
  if (svg && sel.isolatedSvg() !== svg) {
    let outer: SVGSVGElement = svg
    for (let p = svg.parentElement?.closest('svg'); p; p = p.parentElement?.closest('svg')) outer = p
    sel.enterIsolation(outer, true)
  }
  sel.select(el, true)
})
// 面板里悬停 SVG 列表项：在页面上标出对应元素（v0.7）
ipcRenderer.on('select:peek', (_e, eid: Eid | null) => {
  const el = eid === null ? null : document.querySelector(`[data-hw="${eid}"]`)
  overlay.setHover(el && el !== sel.current() ? el : null, true)
})
ipcRenderer.on('select:reject', () => {
  restoreLive()
  if (overlay.selected) overlay.reject(overlay.selected)
})
ipcRenderer.on('blank:set', (_e, on: boolean) => {
  showBlank = on
  refreshBlank()
})
ipcRenderer.on('overlay:toast', (_e, t: ToastMsg) => overlay.toast(t.text, t.sub, t.level, t.duration ?? (t.level === 'error' ? 4000 : t.level === 'warn' ? 3200 : 2200)))
ipcRenderer.on('overlay:drag', (_e, d: { active: boolean; ok: boolean } | null) => overlay.setMask(d))
ipcRenderer.on('focus:enter', () => {
  if (mode !== 'edit' || session) return
  moveFocus(1, true)
})
/** 结构变化的就地同步；失败返回 false，主进程会整页重载。 */
function domSync(p: { dom: DomSync; elements: PreviewElement[]; select: Eid | null; edit?: Eid | null; caret?: { start: number; end: number } | null }): boolean {
  if (session) return false
  const keep = sel.current()
  const iso = sel.isolatedSvg()
  const isoEid = iso ? eidOf(iso) : null
  sel.clear()
  overlay.setHover(null, true)
  hoverTarget = null
  overlay.setFocus(null)
  let ok = false
  try {
    ok = applyDomSync(p.dom, p.elements.length, overlay.reduced)
  } catch (err) {
    console.error('[twiq] dom sync failed', err)
  }
  if (!ok) return false
  setTable(p.elements)
  refreshBlank()
  // SVG 隔离保持：svg 自身的 eid 经换算后仍在，就重新进入
  if (isoEid !== null) {
    const n = p.dom.map[isoEid]
    const svg = n !== undefined && n >= 0 ? document.querySelector(`[data-hw="${n}"]`) : null
    if (svg instanceof SVGSVGElement) sel.enterIsolation(svg, true)
  }
  const target = p.select !== null ? document.querySelector<HTMLElement>(`[data-hw="${p.select}"]`) : keep?.isConnected ? keep : null
  if (mode === 'edit') sel.select(target, false)
  overlay.reposition()
  if (p.edit !== null && p.edit !== undefined) {
    const host = document.querySelector<HTMLElement>(`[data-hw="${p.edit}"]`)
    if (host) void enter(host, undefined, p.caret ?? undefined)
  }
  return true
}

ipcRenderer.on('main:request', async (_e, req: { id: number; type: string; payload?: unknown }) => {
  let value: unknown = null
  if (req.type === 'flush') {
    await svgText.finish(svgCtx, true)
    await commitAndExit()
    value = true
  } else if (req.type === 'undo') {
    value = { native: nativeUndo() }
  } else if (req.type === 'redo') {
    value = { native: nativeRedo() }
  } else if (req.type === 'domSync') {
    value = domSync(req.payload as Parameters<typeof domSync>[0])
  } else if (req.type === 'refreshSelection') {
    sel.refresh()
    value = true
  } else if (req.type === 'formFocus') {
    // 预览模式：焦点是否在页面自己的输入控件里（此时撤销交给该控件）
    const a = document.activeElement as HTMLElement | null
    value = !!a && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a.isContentEditable)
  }
  send('preview:response', { id: req.id, value })
})

function setMode(m: Mode): void {
  const prev = mode
  mode = m
  if (m !== prev) {
    overlay.setHover(null, true)
    overlay.setFocus(null)
    overlay.hideBubble()
    hoverTarget = null
      sel.clear()
    sendHover(null, false)
  }
  if (m === 'preview') overlay.clearAll()
  refreshBlank()
  updateCursor()
}

// ---------- 显示空白（20.2） ----------
let showBlank = false
function refreshBlank(): void {
  overlay.setBlank(showBlank && mode !== 'preview' ? blankElements(table) : [])
}

// ---------- 初始化 ----------
async function init(): Promise<void> {
  const data = (await ipcRenderer.invoke('preview:init')) as PreviewInit | null
  if (!data) return
  tabId = data.tabId
  mode = data.mode
  isMac = data.isMac
  showBlank = data.showBlank
  setLang(data.lang)
  overlay.relabel()
  overlay.setTheme(data.theme)
  setTable(data.elements)
  ready = true
  const mountWhenReady = (): void => {
    overlay.mount()
    updateCursor()
  }
  if (document.documentElement) mountWhenReady()
  document.addEventListener('DOMContentLoaded', mountWhenReady)
  // 页面若把叠加层宿主移除，重新挂回
  new MutationObserver(() => {
    if (!overlay.host.isConnected && document.documentElement) overlay.mount()
  }).observe(document, { childList: true, subtree: false })
  const onLoad = (): void => {
    overlay.mount()
    if (data.scrollY) window.scrollTo(0, data.scrollY)
    refreshBlank()
    if (data.select !== null && mode === 'edit') {
      const el = document.querySelector<HTMLElement>(`[data-hw="${data.select}"]`)
      if (el) sel.select(el, false)
    }
    if (data.editHost !== null && mode === 'edit') {
      const el = document.querySelector<HTMLElement>(`[data-hw="${data.editHost}"]`)
      if (el) void enter(el, undefined, data.caret ?? undefined)
    }
    window.setTimeout(() => {
      overlay.detectDark()
      send('preview:stats', { stats: computeStats(table, overlay.host) })
    }, 1000)
  }
  // init 要等主进程应答；页面可能在此之前已经触发 load
  if (document.readyState === 'complete') onLoad()
  else window.addEventListener('load', onLoad)
}
void init()

// ---------- 悬停（8.1） ----------
// v0.8：编辑模式里悬停只标出可以选中的元素（与原选择模式一致）；不能改的原因在再点一次时说明
function onMove(e: MouseEvent): void {
  if (!ready || mode !== 'edit') return
  if (!session) return sel.onMove(e)
  if (overlay.owns(e.target)) return
  const t = hitTest(e.target as Element, table, overlay.host)
  if (t?.el === hoverTarget?.el && t?.kind === hoverTarget?.kind) return
  hoverTarget = t
  overlay.setHover(!t || t.el === session.host ? null : t.el, t?.kind === 'host')
}
window.addEventListener('mousemove', onMove, { capture: true, passive: true })
document.addEventListener('mouseleave', () => {
  if (mode !== 'edit') return
  if (!session) return sel.onLeave()
  hoverTarget = null
  overlay.setHover(null, true)
})

function showReason(el: Element, reason: ReasonCode, autoHide: number): void {
  const [why, next] = REASONS[reason]
  overlay.showBubble(el, why, next, autoHide)
  // 读屏：同步写入外壳的 aria-live 区域
  send('preview:note', { text: S.sentences(why, next) })
}

// ---------- 进入、提交、放弃（13.6） ----------
function hostText(el: HTMLElement): string {
  return el.textContent ?? ''
}

async function enter(host: HTMLElement, point?: { x: number; y: number }, caretAt?: { start: number; end: number }): Promise<void> {
  if (session || mode !== 'edit') return
  const eid = eidOf(host)
  if (eid === null) return
  const snap = snapshot(host, table)
  const res = (await ipcRenderer.invoke('edit:enter', { tabId, snapshot: snap })) as { ok: boolean; reason?: ReasonCode }
  if (!res.ok) {
    overlay.reject(host)
    showReason(host, res.reason ?? 'MISMATCH', 4000)
    return
  }
  session = {
    host,
    eid,
    baseline: snap,
    baselineText: hostText(host),
    clones: Array.from(host.childNodes).map((n) => n.cloneNode(true)),
    prevContentEditable: host.getAttribute('contenteditable'),
    nativeUndos: 0,
    lastDirty: false
  }
  // 光标位置在开启编辑之前计算（此时布局与用户看到的一致）
  let caret: Range | null = null
  if (point) {
    caret = document.caretRangeFromPoint(point.x, point.y)
    if (caret && !host.contains(caret.startContainer)) caret = null
  }
  // 进入改字的文字块同时成为选中元素：退出后选中框留在它上面，面板也对应它
  if (sel.current() !== host) sel.select(host)
  keepWhitespace(host, eid)
  host.setAttribute('contenteditable', 'plaintext-only')
  host.addEventListener('beforeinput', onBeforeInput)
  host.addEventListener('input', onInput)
  host.addEventListener('paste', onPaste)
  host.focus({ preventScroll: true })
  placeCaret(host, caret)
  if (caretAt) setTextRange(host, caretAt.start, caretAt.end)
  sel.suspend(true)
  overlay.setFocus(null)
  overlay.setHover(null, true)
  overlay.hideBubble()
  overlay.setEditing(host)
  updateCursor()
  sendHover(host, true)
  send('preview:editing', { editing: true })
}

function placeCaret(host: HTMLElement, caret: Range | null): void {
  const sel = window.getSelection()
  if (!sel) return
  let range = caret
  if (!range) {
    // 点在文字之后的空白处、或键盘进入：落在末尾
    range = document.createRange()
    range.selectNodeContents(host)
    range.collapse(false)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

function waitComposition(): Promise<void> {
  if (!composing) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 500)
    compositionWaiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function restoreBaseline(s: Session): void {
  s.host.replaceChildren(...s.clones.map((n) => n.cloneNode(true)))
}

function finish(s: Session, recorded: boolean): void {
  const { host } = s
  host.removeEventListener('beforeinput', onBeforeInput)
  host.removeEventListener('input', onInput)
  host.removeEventListener('paste', onPaste)
  if (s.prevContentEditable === null) host.removeAttribute('contenteditable')
  else host.setAttribute('contenteditable', s.prevContentEditable)
  window.getSelection()?.removeAllRanges()
  host.blur()
  setEditRule('')
  session = null
  overlay.setEditing(null)
  sel.suspend(false)
  if (recorded) overlay.recorded(host)
  updateCursor()
  // 退出改字后回到选中这个文字块的状态（面板、层级跟着刷新）
  if (sel.current()?.isConnected) sel.refresh()
  else sendHover(null, false)
  send('preview:editing', { editing: false })
}

/** 提交并退出编辑；没有在编辑时直接返回。 */
function commitAndExit(): Promise<void> {
  if (committing) return committing
  if (!session) return Promise.resolve()
  committing = doCommit().finally(() => {
    committing = null
  })
  return committing
}

async function doCommit(): Promise<void> {
  if (composing && session) {
    // 组合期间要求提交（如点击别处、保存）：先让 host 失焦，由输入法结束组合并上屏，再提交
    session.host.blur()
  }
  await waitComposition()
  const s = session
  if (!s) return
  // 浏览器为空元素补的占位 br 不属于源码结构
  for (const br of Array.from(s.host.querySelectorAll('br:not([data-hw])'))) br.remove()
  const now = snapshot(s.host, table)
  const before = new Map(s.baseline.elements.map((e) => [e.eid, e]))
  // 结构校验：每个元素的子元素 eid 序列必须与进入时一致
  const structureOk =
    !now.foreign &&
    now.elements.length === s.baseline.elements.length &&
    now.elements.every((e) => {
      const b = before.get(e.eid)
      return !!b && b.children.length === e.children.length && b.children.every((c, i) => c === e.children[i])
    })
  if (!structureOk) {
    restoreBaseline(s)
    overlay.reject(s.host)
    finish(s, false)
    overlay.toast(TOAST.structure, undefined, 'warn', 4000)
    send('preview:toast', { level: 'warn', text: TOAST.structure })
    return
  }
  const ops: SetSlotOp[] = []
  for (const e of now.elements) {
    const b = before.get(e.eid)!
    e.slots.forEach((text, i) => {
      // 浏览器会在连续空格处自动插入 U+00A0；旧文字里没有时一律换成普通空格
      const nw = b.slots[i].includes('\u00a0') ? text : text.replace(/\u00a0/g, ' ')
      if (nw !== b.slots[i]) ops.push({ eid: e.eid, slot: i, newText: nw })
    })
  }
  if (ops.length === 0) {
    finish(s, false)
    return
  }
  const res = (await ipcRenderer.invoke('edit:commit', { tabId, ops })) as { ok: boolean; code?: string }
  if (!res.ok) {
    restoreBaseline(s)
    const level = res.code === 'STRUCTURE' || res.code === 'MISMATCH' ? 'warn' : 'error'
    overlay.reject(s.host, level)
    const text = res.code === 'STRUCTURE' ? TOAST.structure : TOAST.commitFailed
    finish(s, false)
    overlay.toast(text, undefined, level, 4000)
    if (res.code === 'MISMATCH') showReason(s.host, 'MISMATCH', 4000)
    return
  }
  // 预览中的文本节点规范为与源码一致（U+00A0 被替换时）
  for (const op of ops) {
    const cur = now.elements.find((e) => e.eid === op.eid)!.slots[op.slot]
    if (cur !== op.newText) setSlotText(op.eid, op.slot, op.newText)
  }
  finish(s, true)
}

// ---------- 文字格式（20.3） ----------

/** DOM 位置换算成槽位置：元素 eid、第几个槽、槽内解码后的字符偏移。 */
function slotPoint(node: Node, offset: number): { eid: Eid; slot: number; offset: number } | null {
  let el: Element | null
  let child: Node | null
  let inText = 0
  if (node.nodeType === Node.TEXT_NODE) {
    el = node.parentElement
    child = node
    inText = offset
  } else {
    el = node as Element
    child = node.childNodes[offset] ?? null
  }
  if (!el) return null
  const eid = eidOf(el)
  if (eid === null) return null
  let slot = 0
  let acc = 0
  for (const c of Array.from(el.childNodes)) {
    if (c === child) return { eid, slot, offset: acc + inText }
    if (c.nodeType === Node.ELEMENT_NODE && eidOf(c as Element) !== null) {
      slot++
      acc = 0
    } else if (c.nodeType === Node.TEXT_NODE) acc += (c as Text).data.length
  }
  return { eid, slot, offset: acc }
}

/** host 文字内的字符偏移（用于格式化后恢复选区）。 */
function textOffset(host: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange()
  r.setStart(host, 0)
  r.setEnd(node, offset)
  return r.toString().length
}

function setTextRange(host: HTMLElement, start: number, end: number): void {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let acc = 0
  let setStart = false
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length
    if (!setStart && start <= acc + len) {
      range.setStart(n, start - acc)
      setStart = true
    }
    if (setStart && end <= acc + len) {
      range.setEnd(n, end - acc)
      const s = window.getSelection()
      s?.removeAllRanges()
      s?.addRange(range)
      return
    }
    acc += len
  }
}

async function formatSelection(tag: 'b' | 'i' | 'u' | 's' | 'sup' | 'sub'): Promise<void> {
  const s = session
  if (!s) return
  const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null
  if (!range || range.collapsed || !s.host.contains(range.commonAncestorContainer)) {
    overlay.toast(S.formatFirst, undefined, 'warn', 3200)
    return
  }
  const a = slotPoint(range.startContainer, range.startOffset)
  const b = slotPoint(range.endContainer, range.endOffset)
  const caret = { start: textOffset(s.host, range.startContainer, range.startOffset), end: textOffset(s.host, range.endContainer, range.endOffset) }
  if (!a || !b) return
  const host = s.eid
  await commitAndExit()
  const op: StructOp = { type: 'format', start: a, end: b, tag }
  // 共同祖先不同时，选区跨过了元素边界：尝试把两端提升到共同的元素
  const ok = (await ipcRenderer.invoke('preview:op', { tabId, op, after: { edit: host, caret } })) as boolean
  if (!ok) {
    const el = document.querySelector<HTMLElement>(`[data-hw="${host}"]`)
    if (el) await enter(el, undefined, caret)
  }
}

function abandon(): void {
  const s = session
  if (!s) return
  restoreBaseline(s)
  finish(s, false)
  send('edit:abandon')
}

/** 编辑中撤销：文字偏离进入时的内容就按字词撤销；否则提交后交给应用级撤销。 */
function nativeUndo(): boolean {
  const s = session
  if (!s) return false
  if (hostText(s.host) !== s.baselineText) {
    const before = hostText(s.host)
    document.execCommand('undo')
    if (hostText(s.host) !== before) return true
  }
  void commitAndExit()
  return false
}

function nativeRedo(): boolean {
  const s = session
  if (!s) return false
  if (s.nativeUndos > 0) {
    const before = hostText(s.host)
    document.execCommand('redo')
    if (hostText(s.host) !== before) return true
  }
  void commitAndExit()
  return false
}

/** 工具条「撤销本次输入」：与编辑中按撤销相同；文字未偏离时提交后执行应用级撤销（8.6、7.3 第 12 条）。 */
async function toolbarUndo(): Promise<void> {
  if (nativeUndo()) return
  await commitAndExit()
  send('preview:undo')
}

// ---------- 输入（8.3） ----------
function onBeforeInput(e: InputEvent): void {
  const t = e.inputType
  // 提交中：快照已取，新的输入不再进入这个 host（7.2「提交中」）
  if (committing && !composing && e.cancelable) {
    e.preventDefault()
    return
  }
  if (t === 'insertParagraph' || t === 'insertLineBreak' || t === 'insertFromDrop' || t === 'deleteByDrag' || t.startsWith('format')) {
    e.preventDefault()
  }
}

function onInput(e: Event): void {
  const s = session
  if (!s) return
  const t = (e as InputEvent).inputType
  if (t === 'historyUndo') s.nativeUndos++
  else if (t === 'historyRedo') s.nativeUndos = Math.max(0, s.nativeUndos - 1)
  else s.nativeUndos = 0
  const dirty = hostText(s.host) !== s.baselineText
  if (dirty !== s.lastDirty) {
    s.lastDirty = dirty
    send('preview:typing', { dirty })
  }
  overlay.reposition()
}

function onPaste(e: ClipboardEvent): void {
  e.preventDefault()
  let text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n|\r|\n/g, ' ')
  if (text.length > PASTE_MAX) {
    text = text.slice(0, PASTE_MAX)
    overlay.toast(TOAST.pasteTooLong, undefined, 'info', 2200)
    send('preview:toast', { level: 'info', text: TOAST.pasteTooLong })
  }
  document.execCommand('insertText', false, text)
}

document.addEventListener('compositionstart', () => {
  composing = true
}, true)
document.addEventListener('compositionend', () => {
  composing = false
  const w = compositionWaiters
  compositionWaiters = []
  w.forEach((fn) => fn())
}, true)

// ---------- 键盘（7.3、8.3、11.2） ----------
function hostsInOrder(): HTMLElement[] {
  return editableHosts(table).filter(isVisible)
}

function moveFocus(dir: 1 | -1, fromStart = false): HTMLElement | null {
  const hosts = hostsInOrder()
  if (!hosts.length) return null
  const cur = session?.host ?? hostOf(sel.current())
  let i = cur && !fromStart ? hosts.indexOf(cur) : -1
  if (i < 0 && cur && !fromStart) {
    // 当前元素已不在列表里：按文档位置找下一个
    i = hosts.findIndex((h) => cur.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) - (dir === 1 ? 1 : 0)
  }
  const next = hosts[((i < 0 && dir === -1 ? 0 : i) + dir + hosts.length) % hosts.length]
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  // v0.8：键盘在文字块之间移动就是选中它；Enter 进入改字
  if (!session) sel.select(next)
  return next
}

async function tabTo(dir: 1 | -1): Promise<void> {
  const hosts = hostsInOrder()
  const cur = session?.host
  tabbing = true
  pendingKeys = ''
  try {
    await commitAndExit()
    if (!hosts.length) return
    let i = cur ? hosts.indexOf(cur) : -1
    if (i < 0) i = dir === 1 ? -1 : 0
    const next = hosts[(i + dir + hosts.length) % hosts.length]
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    await enter(next)
    if (session && pendingKeys) document.execCommand('insertText', false, pendingKeys)
  } finally {
    tabbing = false
    pendingKeys = ''
  }
}

/** 提交中、Tab 切换中的按键：不写进正在退出的 host（7.2「提交中」）。
 *  Tab 切换时把可打印字符记下，进入下一个 host 后补上；修饰键组合（保存、撤销等）交给菜单。 */
function holdKey(e: KeyboardEvent, mod: boolean): void {
  if (!mod) {
    e.preventDefault()
    if (tabbing && !e.altKey && !e.ctrlKey && e.key.length === 1) pendingKeys += e.key
  }
  e.stopPropagation()
}

function onKeyDown(e: KeyboardEvent): void {
  // SVG 文字输入框自己处理按键（Enter 提交、Esc 取消），页面与选择模式都不响应
  if (svgText.editing()) return
  if (mode === 'preview') {
    // Esc：有 toast 时先关闭 toast，否则切回编辑模式
    if (e.key === 'Escape' && !e.isComposing && !overlay.hideToast()) send('preview:mode', { mode: 'edit' })
    return
  }
  if (!ready) return
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (session) {
    // 输入法组合期间不提交、不拦截；Esc 只取消候选
    if (e.isComposing || composing) {
      e.stopPropagation()
      return
    }
    if (committing || tabbing) {
      holdKey(e, mod)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey && !mod) {
        send('preview:note', { text: TOAST.noLineBreak })
      } else {
        void commitAndExit()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      overlay.hideToast()
      void commitAndExit()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      void tabTo(e.shiftKey ? -1 : 1)
    } else if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault()
      void formatSelection(e.key.toLowerCase() as 'b' | 'i' | 'u')
    }
    e.stopPropagation()
    return
  }
  if (tabbing) {
    holdKey(e, mod)
    return
  }
  // 未在改字：Tab 在文字块之间移动并选中；其余按键交给选中元素的操作（删除、复制、微调、层级）
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault()
    moveFocus(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    // Esc 同时收起提示与气泡，并按选中层级后退一步（与原选择模式一致）
    overlay.hideToast()
    if (overlay.bubbleOn) overlay.hideBubble()
    sel.onKey(e)
    e.preventDefault()
  } else if (sel.onKey(e)) {
    e.preventDefault()
  }
  e.stopPropagation()
}
window.addEventListener('keydown', onKeyDown, true)
window.addEventListener('keyup', (e) => {
  if (mode === 'edit' && ready) e.stopPropagation()
}, true)
window.addEventListener('keypress', (e) => {
  if (mode === 'edit' && ready) e.stopPropagation()
}, true)

// ---------- 鼠标与页面交互的拦截（7.1、8.2、8.8） ----------
function linkOf(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target.closest('a[href]') : null
  return el as HTMLAnchorElement | null
}

/** 预览模式与临时放行时的链接处理：外链确认后交给系统浏览器，页内锚点放行，其他协议不处理。 */
function handleLink(e: MouseEvent): void {
  const a = linkOf(e.target)
  if (!a) return
  let url: URL
  try {
    url = new URL(a.href, location.href)
  } catch {
    return
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    e.preventDefault()
    send('preview:openExternal', { url: url.href })
  } else if (url.protocol === location.protocol && url.host === location.host && url.pathname === location.pathname && url.hash) {
    // 页内锚点
  } else {
    e.preventDefault()
  }
}

/** 包含 el 的可编辑文字块。 */
function hostOf(el: Element | null): HTMLElement | null {
  const eid = el ? eidOf(el) : null
  const info = eid !== null ? table.get(eid) : undefined
  if (!info || !el) return null
  if (info.host) return el as HTMLElement
  return info.hostId !== undefined ? el.closest<HTMLElement>(`[data-hw="${info.hostId}"]`) : null
}

/** 再点一次已选中的元素（v0.8）：是文字就进入改字，光标落在点的位置；不能改的文字说明原因。 */
function activate(target: Element, point: { x: number; y: number }): void {
  const hit = hitTest(target, table, overlay.host)
  if (hit?.kind === 'host') void enter(hit.el, point)
  else if (hit?.kind === 'uneditable') showReason(hit.el, hit.reason, 4000)
}

function onMouseDown(e: MouseEvent): void {
  if (!ready || mode !== 'edit') return
  if (overlay.owns(e.target)) return
  const target = e.target as Element
  if (session && session.host.contains(target)) {
    e.stopPropagation()
    return
  }
  e.preventDefault()
  e.stopPropagation()
  if (!session) return sel.onMouseDown(e)
  // 正在改字时点到另一段文字：一次点击完成提交与切换（AC-14）；点到别处则提交后按选中处理
  const hit = e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey ? hitTest(target, table, overlay.host) : null
  const point = { x: e.clientX, y: e.clientY }
  void commitAndExit().then(() => {
    if (hit?.kind === 'host') void enter(hit.el, point)
    else sel.onMouseDown(e)
  })
}
window.addEventListener('mousedown', onMouseDown, true)
window.addEventListener('mouseup', (e) => {
  if (mode === 'edit') sel.onMouseUp(e)
}, true)

for (const type of ['click', 'dblclick', 'auxclick', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'submit', 'dragstart']) {
  window.addEventListener(
    type,
    (e) => {
      if (!ready) return
      if (mode === 'preview') {
        if (type === 'click' || type === 'auxclick') handleLink(e as MouseEvent)
        return
      }
      if (overlay.owns(e.target)) return
      if (type === 'pointerdown' && (e as PointerEvent).altKey) return
      const inSession = session && e.target instanceof Node && session.host.contains(e.target)
      // 编辑中的 host 内：保留光标、选区等默认行为，只挡住链接、按钮、label 的默认动作
      if (inSession && type !== 'click' && type !== 'auxclick' && type !== 'submit' && type !== 'dragstart') {
        e.stopPropagation()
        return
      }
      if (type !== 'pointerdown' && type !== 'pointerup') e.preventDefault()
      e.stopPropagation()
    },
    true
  )
}

window.addEventListener('blur', () => {
  // 窗口失去焦点：提交并退出，回到应用后不自动恢复编辑
  if (session) void commitAndExit()
})

// ---------- 拖拽打开（10.3） ----------
let dragDepth = 0
function dragOk(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const items = Array.from(dt.items).filter((i) => i.kind === 'file')
  return items.length > 0 && items.every((i) => i.type === 'text/html')
}
function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files')
}
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e.dataTransfer)) return
  e.preventDefault()
  e.stopPropagation()
  if (dragDepth++ === 0) send('preview:drag', { active: true, ok: dragOk(e.dataTransfer) })
}, true)
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e.dataTransfer)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = dragOk(e.dataTransfer) ? 'copy' : 'none'
}, true)
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e.dataTransfer)) return
  e.stopPropagation()
  if (--dragDepth <= 0) {
    dragDepth = 0
    send('preview:drag', { active: false, ok: false })
  }
}, true)
window.addEventListener('drop', (e) => {
  if (!hasFiles(e.dataTransfer)) return
  e.preventDefault()
  e.stopPropagation()
  dragDepth = 0
  const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => webUtils.getPathForFile(f)).filter(Boolean)
  send('preview:drag', { active: false, ok: false })
  if (paths.length) send('preview:drop', { paths })
}, true)
