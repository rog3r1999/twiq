// 选择模式（规格 20.2–20.4，v0.6 打磨）：选中、多选、悬停、拖放换位、自由移动、键盘操作、尺寸手柄、吸附。
// 所有修改都发给主进程换算成补丁；预览只做临时的视觉反馈。
import { ipcRenderer } from 'electron'
import type { Eid, SelectionInfo, StructOp } from '../shared/types'
import { getDecl } from '../shared/style-attr'
import { TOAST } from '../shared/messages'
import { S } from './strings'
import { svgAttrNames } from '../shared/svg'
import { keepRatio, snapMove, snapResize, type Box } from '../shared/snap'
import type { Edge, Overlay } from './overlay'
import { breadcrumb, eidOf, type Table } from './dom'

export interface SelectCtx {
  overlay: Overlay
  table(): Table
  tabId(): string
  isMac(): boolean
  /** 进入文字编辑（双击、Enter） */
  enter(host: HTMLElement, point?: { x: number; y: number }): Promise<void>
  /** 进入 SVG 文字编辑（双击 text / tspan） */
  enterSvgText(el: SVGElement): void
  /** 再点一次已选中的元素（v0.8）：文字进入改字，不能改的说明原因 */
  activate(target: Element, point: { x: number; y: number }): void
  /** 选中变化后（更新文字光标提示等） */
  selected(): void
}

interface DragState {
  el: HTMLElement
  /** 一起拖动的元素（多选时为全部选中的元素，文档顺序） */
  group: HTMLElement[]
  x: number
  y: number
  active: boolean
  /** Alt 按住：自由移动（写 position: relative 与 left / top）；否则在文档流里换位 */
  free: boolean
  target: HTMLElement | null
  where: 'before' | 'after'
  rect: DOMRect
  /** 自由移动：起点的 left / top 与当前位移 */
  left0: number
  top0: number
  dx: number
  dy: number
  prevStyle: string | null
  /** v0.8.1：按在已选中的块里、但点在更深层元素上；没有拖动就松手时改选它（保持单击原本的语义） */
  pending: HTMLElement | null
}

interface ResizeState {
  el: HTMLElement
  edge: Edge
  x: number
  y: number
  w: number
  h: number
  dw: number
  dh: number
  prevStyle: string | null
  ratio: boolean
  others: Box[]
  parent: Box | null
}

let ctx: SelectCtx
let selected: HTMLElement | null = null
/** 多选：除 selected 外一起选中的同级元素 */
let extra: HTMLElement[] = []
let hovered: HTMLElement | null = null
let suspended = false
let drag: DragState | null = null
let resize: ResizeState | null = null
/** svg 隔离：双击 svg 进入后，可以选中内部的形状 */
let isolated: SVGSVGElement | null = null
/** 按下时元素已经是选中的：松手时若没有拖动，就当作「再点一次」（v0.8 合并模式） */
let again: { target: Element; x: number; y: number } | null = null

const ROOTS = new Set(['html', 'head', 'body'])
const DRAG_THRESHOLD = 5
/** 替换元素：默认 display inline，但有自己的宽高，可以缩放（拆解第 3 条） */
const REPLACED = new Set(['img', 'video', 'canvas', 'iframe', 'svg', 'object', 'embed', 'picture', 'input', 'textarea', 'select', 'button', 'audio'])
/** 图片类默认等比缩放 */
const RATIO = new Set(['img', 'video', 'canvas', 'svg', 'picture', 'object', 'embed'])
const SVG_NS = 'http://www.w3.org/2000/svg'

export function init(c: SelectCtx): void {
  ctx = c
}

function send(channel: string, payload: Record<string, unknown> = {}): void {
  ipcRenderer.send(channel, { tabId: ctx.tabId(), ...payload })
}

function op(o: StructOp): Promise<boolean> {
  return ipcRenderer.invoke('preview:op', { tabId: ctx.tabId(), op: o }) as Promise<boolean>
}

function note(text: string): void {
  send('preview:note', { text })
}

/** 拒绝：琥珀色框闪一下，同时给出原因（toast 与读屏），拆解第 7 条。做不到不等于出错，所以用提醒级别。 */
function refuse(el: Element, text: string): void {
  ctx.overlay.reject(el)
  ctx.overlay.toast(text, undefined, 'warn', 3200)
  note(text)
}

const inSvg = (el: Element): boolean => el.namespaceURI === SVG_NS && el.localName !== 'svg'

/** 指针下可选中的元素：最近的带 data-hw 的元素；svg 内部默认选中 svg 本身，隔离后选中内部形状。 */
export function pick(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const svg = target.closest('svg')
  let start: Element = target
  if (svg && !(isolated && isolated.contains(target))) start = outerSvg(svg)
  const el = start.closest<HTMLElement>('[data-hw]')
  if (!el || ROOTS.has(el.localName)) return null
  return el
}

function outerSvg(svg: SVGSVGElement): SVGSVGElement {
  let s = svg
  for (let p = svg.parentElement?.closest('svg'); p; p = p.parentElement?.closest('svg')) s = p
  return s
}

function info(el: HTMLElement): SelectionInfo | null {
  const eid = eidOf(el)
  if (eid === null) return null
  const t = ctx.table().get(eid)
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null
  const attrs: Record<string, string> = {}
  const svgAttrs = inSvg(el) || el.localName === 'svg' ? svgAttrNames(el.localName) : []
  for (const name of ['href', 'src', 'alt', 'title', ...svgAttrs]) {
    const v = el.getAttribute(name)
    if (v !== null || (name === 'alt' && el.localName === 'img') || (name === 'href' && el.localName === 'a') || svgAttrs.includes(name)) attrs[name] = v ?? ''
  }
  const sibs = siblingsOf(el)
  return {
    eid,
    tag: el.localName,
    id: el.id,
    cls: el.getAttribute('class') ?? '',
    style: el.getAttribute('style') ?? '',
    computed: {
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      textAlign: cs.textAlign,
      lineHeight: cs.lineHeight,
      padding: cs.padding,
      borderRadius: cs.borderRadius,
      position: cs.position,
      display: cs.display
    },
    width: Math.round(r.width),
    height: Math.round(r.height),
    attrs,
    range: !!t?.range,
    host: !!t && (t.host || t.hostId !== undefined),
    flexParent: !!pcs && /flex|grid/.test(pcs.display),
    component: el.getAttribute('data-c') ?? undefined,
    slot: el.getAttribute('data-slot') ?? undefined,
    index: sibs.indexOf(el) + 1,
    siblings: sibs.length,
    multi: extra.length ? [eid, ...extra.map((x) => eidOf(x)!).filter((x) => x !== null)] : undefined,
    svg: el.localName === 'svg' ? 'root' : inSvg(el) ? 'child' : undefined,
    reason: t?.range ? undefined : 'RANGE'
  }
}

function label(el: HTMLElement): string {
  return `${el.localName}${el.id ? `#${el.id}` : ''}`
}

function sendHover(el: HTMLElement | null): void {
  if (!el) return send('preview:hover', { info: null })
  const b = breadcrumb(el)
  send('preview:hover', { info: { breadcrumb: b.parts, fullSelector: b.full, selectors: b.selectors, eids: b.eids, editable: true } })
}

/** 同一父元素下可见、带 data-hw 的兄弟（含自身，文档顺序）。 */
function siblingsOf(el: Element): HTMLElement[] {
  const p = el.parentElement
  if (!p) return [el as HTMLElement]
  return Array.from(p.children).filter((c): c is HTMLElement => eidOf(c) !== null && c.getClientRects().length > 0 && c.localName !== 'script' && c.localName !== 'style')
}

/** 可以缩放：块级元素、替换元素（img 等）、SVG 根；SVG 内部形状通过属性面板改尺寸。 */
function canResize(el: HTMLElement): boolean {
  if (eidOf(el) === null || inSvg(el)) return false
  if (REPLACED.has(el.localName)) return true
  return getComputedStyle(el).display !== 'inline'
}

function showSelected(el: HTMLElement | null): void {
  if (!el || suspended) {
    ctx.overlay.setSelected(null)
    ctx.overlay.setSiblings([], null)
    ctx.overlay.setMulti([])
    return
  }
  const multi = extra.length > 0
  const sibs = siblingsOf(el)
  ctx.overlay.setSelected(el, multi ? S.andMore(label(el), extra.length + 1) : label(el), { resizable: !multi && canResize(el), actions: true })
  ctx.overlay.setMulti(extra)
  // 同级兄弟淡框（拆解第 6 条）；兄弟过多时不画，避免满屏虚线
  const others = sibs.length > 1 && sibs.length <= 60 ? sibs : []
  const parent = el.parentElement && !ROOTS.has(el.parentElement.localName) ? el.parentElement : null
  ctx.overlay.setSiblings(others, parent)
}

export function select(el: HTMLElement | null, scroll = false, keepExtra = false): void {
  if (!keepExtra) extra = []
  selected = el
  if (el && isolated && !isolated.contains(el) && (el as Element) !== isolated) exitIsolation()
  if (!el) {
    showSelected(null)
    send('preview:selection', { sel: null })
    sendHover(null)
    ctx.selected()
    return
  }
  if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  ctx.overlay.setHover(null, true)
  showSelected(el)
  send('preview:selection', { sel: info(el) })
  sendHover(el)
  ctx.selected()
}

/** Shift / Cmd 点击：在同级元素里加选或减选（拆解第 9 条）。 */
function toggleMulti(el: HTMLElement): void {
  if (!selected) return select(el)
  if (el === selected) {
    if (!extra.length) return
    const [next, ...rest] = extra
    extra = rest
    selected = next
  } else if (el.parentElement !== selected.parentElement) {
      refuse(el, TOAST.multiSibling)
    return
  } else if (extra.includes(el)) {
    extra = extra.filter((x) => x !== el)
  } else {
    extra = [...extra, el]
  }
  select(selected, false, true)
}

/** 全部选中的元素（文档顺序）。 */
function group(): HTMLElement[] {
  if (!selected) return []
  const all = [selected, ...extra]
  return all.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

export function refresh(): void {
  if (!selected) return
  if (!selected.isConnected) return select(null)
  extra = extra.filter((x) => x.isConnected)
  showSelected(selected)
  send('preview:selection', { sel: info(selected) })
}

export function clear(): void {
  again = null
  selected = null
  extra = []
  hovered = null
  drag = null
  isolated = null
  ctx.overlay.setSelected(null)
  ctx.overlay.setSiblings([], null)
  ctx.overlay.setMulti([])
  ctx.overlay.setDropLine(null)
  ctx.overlay.setGhost(null)
  ctx.overlay.setGuides([])
  setDragStyle(null)
  setGrab(false)
  ctx.overlay.setBlock(null)
  setIsolationStyle(null)
}

/** 进入文字编辑期间隐藏选中框；退出后恢复。 */
export function suspend(on: boolean): void {
  suspended = on
  if (on) ctx.overlay.setBlock(null)
  showSelected(selected)
}

export function current(): HTMLElement | null {
  return selected
}

// ---------- SVG 隔离（拆解第 10 条） ----------

let isoSheet: CSSStyleSheet | null = null
function setIsolationStyle(eid: Eid | null): void {
  try {
    if (!isoSheet) {
      isoSheet = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, isoSheet]
    }
    // 隔离时其他内容压暗
    isoSheet.replaceSync(eid === null ? '' : `body > *:not(:has([data-hw="${eid}"])):not([data-hw="${eid}"]):not(hw-overlay-root) { opacity: 0.35 !important; transition: opacity 120ms; }`)
  } catch {
    // 忽略
  }
}

export function enterIsolation(svg: SVGSVGElement, quiet = false): void {
  isolated = svg
  setIsolationStyle(eidOf(svg))
  if (quiet) return
  note(TOAST.svgIsolated)
  send('preview:hint', { key: 'svg', text: TOAST.svgIsolated })
}

export function exitIsolation(): boolean {
  if (!isolated) return false
  isolated = null
  setIsolationStyle(null)
  return true
}

export function isolatedSvg(): SVGSVGElement | null {
  return isolated
}

// ---------- 鼠标 ----------

export function onMove(e: MouseEvent): void {
  if (drag) return onDragMove(e)
  if (ctx.overlay.owns(e.target)) return
  if (ctx.overlay.keepsBlock(e.clientX, e.clientY)) return
  const el = pick(e.target)
  const blk = blockOf(el)
  if (el === hovered) return
  hovered = el
  ctx.overlay.setHover(el && el !== selected ? el : null, true)
  ctx.overlay.setBlock(blk)
  if (!selected) sendHover(el)
}

export function onLeave(): void {
  hovered = null
  ctx.overlay.setHover(null, true)
  ctx.overlay.setBlock(null)
  if (!selected) sendHover(null)
}

/** 悬停元素所在的「块」（v0.8.1）：文字块的父容器（.blk 这一类），或容器 / 图片自身。
 *  块把手拖它；文字块本身仍按单击选中、再点改字。 */
function blockOf(el: HTMLElement | null): HTMLElement | null {
  if (!el || inSvg(el)) return null
  const t = ctx.table()
  const eid = eidOf(el)
  const info = eid !== null ? t.get(eid) : undefined
  // 不能改字的元素（pre、公式之类）没有「块」可拖：把手会盖住它，点心也点不到
  if (!info || info.reason) return null
  const hostId = info.host ? eid : info.hostId
  let block: HTMLElement | null
  if (hostId !== null && hostId !== undefined) {
    const host = eid === hostId ? el : (el.closest(`[data-hw="${hostId}"]`) as HTMLElement | null)
    const p = host?.parentElement ?? null
    // 宿主自己是弹性 / 网格布局的子项时（一行里的卡片），块就是它自己；
    // 只有文字块（p 外面套着 .blk 这类容器）才把外层容器当块
    if (host && p && !ROOTS.has(p.localName) && /flex|grid/.test(getComputedStyle(p).display)) block = host
    else block = p && !ROOTS.has(p.localName) ? p : null
  } else {
    let cur: HTMLElement | null = el
    while (cur && !ROOTS.has(cur.localName)) {
      if (!getComputedStyle(cur).display.startsWith('inline')) break
      cur = cur.parentElement
    }
    block = cur && !ROOTS.has(cur.localName) ? cur : null
  }
  if (!block) return null
  const be = eidOf(block)
  if (be === null || t.get(be)?.range === false) return null
  return block
}

/**
 * 块把手（v0.8.1）：按下即选中这个块并准备整块拖动；松手不动就只是选中。
 * 块已在多选里时（V6-06：Shift 选了两块再抓其中一块的把手）跟块内按下一样整组拖，
 * 不把多选悄悄丢掉。
 */
export function beginBlockDrag(el: HTMLElement, e: PointerEvent): void {
  if (!el || !el.isConnected) return
  const cur = group()
  const inGroup = !!selected && cur.some((g) => g === el || g.contains(el))
  if (!inGroup) select(el)
  const base = inGroup ? selected! : el
  drag = {
    el: base,
    group: inGroup && extra.length ? cur : [base],
    x: e.clientX,
    y: e.clientY,
    active: false,
    free: e.altKey,
    target: null,
    where: 'before',
    rect: base.getBoundingClientRect(),
    left0: 0,
    top0: 0,
    dx: 0,
    dy: 0,
    prevStyle: base.getAttribute('style'),
    pending: null
  }
  setGrab(true)
}

/**
 * 单击选中；再点一次已选中的文字进入改字（v0.8，同 Keynote / Figma）；Shift / Cmd 单击多选；
 * 双击直接进入改字或 SVG 隔离；按下后拖动超过 5px 开始拖放（Alt 自由移动）。
 */
export function onMouseDown(e: MouseEvent): void {
  const el = pick(e.target)
  const mod = ctx.isMac() ? e.metaKey : e.ctrlKey
  again = null
  if (e.detail >= 2 && el && e.button === 0 && !e.shiftKey && !mod) {
    if (el.localName === 'svg' && !isolated) {
      enterIsolation(el as unknown as SVGSVGElement)
      const inner = pick(e.target)
      select(inner ?? el)
      return
    }
    if (el.localName === 'text' || el.localName === 'tspan') {
      ctx.enterSvgText(el as unknown as SVGElement)
      return
    }
    if (!isolated || !isolated.contains(el)) {
      ctx.activate(e.target as Element, { x: e.clientX, y: e.clientY })
      return
    }
  }
  if (el && (e.shiftKey || mod) && selected) {
    toggleMulti(el)
    return
  }
  // v0.8.1：按在已选中的块里（哪怕点在它的文字上）→ 保持选中，整块 / 多选一起拖。
  // 没有拖动就松手时再改选里层元素，单击的原有语义不变；在同一元素上再点一次仍是改文字。
  const cur = group()
  if (el && cur.some((g) => g === el || g.contains(el))) {
    if (el === selected && !extra.length && e.button === 0 && !e.altKey && !e.shiftKey && !mod) again = { target: e.target as Element, x: e.clientX, y: e.clientY }
    if (e.button === 0) {
      drag = {
        el: selected!,
        group: extra.length ? cur : [selected!],
        x: e.clientX,
        y: e.clientY,
        active: false,
        free: e.altKey,
        target: null,
        where: 'before',
        rect: selected!.getBoundingClientRect(),
        left0: 0,
        top0: 0,
        dx: 0,
        dy: 0,
        prevStyle: selected!.getAttribute('style'),
        pending: el === selected ? null : el
      }
      setGrab(true)
    }
    return
  }
  // 按在选中之外：重选到指针下的元素，准备拖动
  const inGroup = !!el && (el === selected || extra.includes(el))
  if (!inGroup || !extra.length) select(el)
  if (!el && isolated) exitIsolation()
  if (el && e.button === 0) {
    const g = inGroup && extra.length ? group() : [el]
    drag = {
      el,
      group: g,
      x: e.clientX,
      y: e.clientY,
      active: false,
      free: e.altKey,
      target: null,
      where: 'before',
      rect: el.getBoundingClientRect(),
      left0: 0,
      top0: 0,
      dx: 0,
      dy: 0,
      prevStyle: el.getAttribute('style'),
      pending: null
    }
    setGrab(true)
  }
}

let dragSheet: CSSStyleSheet | null = null
function setDragStyle(eids: Eid[] | null): void {
  try {
    if (!dragSheet) {
      dragSheet = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, dragSheet]
    }
    dragSheet.replaceSync(!eids ? '' : `${eids.map((e) => `[data-hw="${e}"]`).join(', ')} { opacity: 0.35 !important; } html, html * { cursor: grabbing !important; user-select: none !important; }`)
  } catch {
    // 忽略
  }
}

// v0.8.1：按下的瞬间就换成张开的手（「抓住了，可以拖」），过了阈值再变成抓紧的 grabbing。
// 悬停时文字块仍是文字光标（点一下改字），所以手掌只在真的要拖的时候出现。
let grabSheet: CSSStyleSheet | null = null
function setGrab(on: boolean): void {
  try {
    if (!grabSheet) {
      grabSheet = new CSSStyleSheet()
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, grabSheet]
    }
    // 只写 html：cursor 会继承；用 `html *` 会让 1MB 的大文档每次按下都重算全部元素
    grabSheet.replaceSync(on ? 'html { cursor: grab !important; }' : '')
  } catch {
    // 忽略
  }
}

/**
 * 拖放的目标（拆解第 2 条）：从指针下的元素向上找候选，
 * 优先与被拖元素同父（同级换位）→ 同标签 → 任何有完整区间的元素（含行内）。
 * 指针还在被拖元素自身上时，取它的兄弟里离指针最近的那个，避免大块元素找不到落点。
 */
function dropTarget(e: MouseEvent, d: DragState): HTMLElement | null {
  const hit = document.elementFromPoint(e.clientX, e.clientY)
  if (!hit || ctx.overlay.owns(hit)) return null
  const dragged = d.el
  const moving = d.group
  const table = ctx.table()
  const cands: HTMLElement[] = []
  let onSelf = false
  for (let cur: Element | null = hit; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
    if (eidOf(cur) === null) continue
    if (moving.some((m) => m === cur || m.contains(cur))) {
      onSelf = true
      continue
    }
    // svg 内部只在 svg 内部换位
    if (inSvg(cur) !== inSvg(dragged)) continue
    cands.push(cur as HTMLElement)
  }
  if (onSelf || !cands.length) {
    // 在自身上：找最近的兄弟
    const sibs = siblingsOf(dragged).filter((s) => !moving.includes(s))
    let best: HTMLElement | null = null
    let dist = Infinity
    for (const s of sibs) {
      const r = s.getBoundingClientRect()
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right)
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom)
      const dd = Math.hypot(dx, dy)
      if (dd < dist) {
        dist = dd
        best = s
      }
    }
    if (onSelf) return dist < 4 ? best : null
    if (best) return best
  }
  const ok = (c: HTMLElement): boolean => !!table.get(eidOf(c)!)?.range || c.parentElement === dragged.parentElement
  return (
    cands.find((c) => c.parentElement === dragged.parentElement) ??
    cands.find((c) => c.localName === dragged.localName && ok(c)) ??
    cands.find((c) => ok(c)) ??
    null
  )
}

function horizontal(target: HTMLElement): boolean {
  const p = target.parentElement
  if (!p) return false
  const pcs = getComputedStyle(p)
  if (/flex/.test(pcs.display)) return !pcs.flexDirection.startsWith('column')
  if (/grid/.test(pcs.display)) {
    // 网格：同一行的兄弟多于一个时按横向
    const r = target.getBoundingClientRect()
    return siblingsOf(target).some((s) => s !== target && Math.abs(s.getBoundingClientRect().top - r.top) < 2)
  }
  const d = getComputedStyle(target).display
  return d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'table-cell'
}

/** 拖动前检查：所有被拖元素都要有完整源码区间。 */
function canDrag(d: DragState): boolean {
  const table = ctx.table()
  const bad = d.group.find((g) => !table.get(eidOf(g)!)?.range)
  if (bad) {
    refuse(bad, TOAST.rejectRange)
    return false
  }
  return true
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

function onDragMove(e: MouseEvent): void {
  const d = drag!
  if (!d.active) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return
    if (!canDrag(d)) {
      drag = null
      setGrab(false)
      return
    }
    d.active = true
    if (d.free) {
      if (d.group.length > 1 || inSvg(d.el)) {
        d.free = false
      } else {
        const cs = getComputedStyle(d.el)
        d.left0 = parseFloat(cs.left) || 0
        d.top0 = parseFloat(cs.top) || 0
      }
    }
    if (!d.free) setDragStyle(d.group.map((g) => eidOf(g)!))
    ctx.overlay.setBlock(null)
    ctx.overlay.setHover(null, true)
    ctx.overlay.setSelected(null)
    ctx.overlay.setMulti([])
  }
  if (d.free) return onFreeMove(e, d)
  // 跟随光标的影子（拆解第 4 条）
  const w = Math.min(d.rect.width, 320)
  const h = Math.min(d.rect.height, 160)
  const n = d.group.length
  ctx.overlay.setGhost({ x: e.clientX + 12, y: e.clientY + 12, w, h, label: n > 1 ? S.andMore(label(d.el), n) : label(d.el) })
  const target = dropTarget(e, d)
  d.target = target
  if (!target) {
    ctx.overlay.setSiblings([], null)
    return ctx.overlay.setDropLine(null)
  }
  // 落点所在的父元素与同级元素也标出来，看得出放进去之后的层级
  const parent = target.parentElement && !ROOTS.has(target.parentElement.localName) ? target.parentElement : null
  const sibs = siblingsOf(target).filter((s) => !d.group.includes(s))
  ctx.overlay.setSiblings(sibs.length <= 60 ? sibs : [], parent)
  const r = target.getBoundingClientRect()
  if (horizontal(target)) {
    d.where = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
    ctx.overlay.setDropLine({ x: (d.where === 'before' ? r.left : r.right) - 1.5, y: r.top, w: 3, h: r.height })
  } else {
    d.where = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
    ctx.overlay.setDropLine({ x: r.left, y: (d.where === 'before' ? r.top : r.bottom) - 1.5, w: r.width, h: 3 })
  }
}

/** 自由移动（Alt 拖动）：临时改 left / top 预览，吸附兄弟与父元素的边和中线。 */
function onFreeMove(e: MouseEvent, d: DragState): void {
  let dx = e.clientX - d.x
  let dy = e.clientY - d.y
  const mod = ctx.isMac() ? e.metaKey : e.ctrlKey
  let guides: ReturnType<typeof snapMove>['guides'] = []
  if (!mod) {
    // 吸附用的是元素移动前的矩形（d.rect）加位移
    const others = siblingsOf(d.el).filter((s) => s !== d.el).map(boxOf)
    const parent = d.el.parentElement ? boxOf(d.el.parentElement) : null
    const r = snapMove({ left: d.rect.left, top: d.rect.top, right: d.rect.right, bottom: d.rect.bottom }, dx, dy, others, parent)
    dx = r.dx
    dy = r.dy
    guides = r.guides
  }
  if (e.shiftKey) {
    // Shift：锁定一个方向
    if (Math.abs(dx) > Math.abs(dy)) dy = 0
    else dx = 0
  }
  d.dx = Math.round(dx)
  d.dy = Math.round(dy)
  const cs = getComputedStyle(d.el)
  if (cs.position === 'static') d.el.style.setProperty('position', 'relative', 'important')
  d.el.style.setProperty('left', `${d.left0 + d.dx}px`, 'important')
  d.el.style.setProperty('top', `${d.top0 + d.dy}px`, 'important')
  ctx.overlay.setGuides(guides)
  ctx.overlay.setSizeTip(S.offset(d.left0 + d.dx, d.top0 + d.dy), e.clientX, e.clientY)
}

export function onMouseUp(e?: MouseEvent): void {
  const d = drag
  drag = null
  setGrab(false)
  const a = again
  again = null
  if (a && !d?.active && e && Math.hypot(e.clientX - a.x, e.clientY - a.y) < DRAG_THRESHOLD) {
    // svg 未进入时，再点一次 svg 进入内部（与双击相同）
    if (selected?.localName === 'svg' && !isolated) {
      enterIsolation(selected as unknown as SVGSVGElement)
      const inner = pick(a.target)
      if (inner) select(inner)
      return
    }
    if (selected?.localName === 'text' || selected?.localName === 'tspan') return ctx.enterSvgText(selected as unknown as SVGElement)
    return ctx.activate(a.target, { x: a.x, y: a.y })
  }
  // 按在已选中的块里但没拖动：按单击语义改选里层元素（v0.8.1）
  if (d && !d.active && d.pending) return select(d.pending)
  // 按在多选的某一项上但没拖动：松手后只保留这一项（同 Figma）
  if (d && !d.active && d.group.length > 1) return select(d.el)
  if (!d?.active) return
  setDragStyle(null)
  ctx.overlay.setDropLine(null)
  ctx.overlay.setGhost(null)
  ctx.overlay.setGuides([])
  ctx.overlay.setSizeTip(null)
  if (d.free) {
    if (d.prevStyle === null) d.el.removeAttribute('style')
    else d.el.setAttribute('style', d.prevStyle)
    if (!d.dx && !d.dy) return select(d.el)
    const props: Record<string, string> = {}
    const pos = getDecl(d.prevStyle ?? '', 'position')
    if (pos !== null) props.position = pos
    else if (getComputedStyle(d.el).position === 'static') props.position = 'relative'
    props.left = `${d.left0 + d.dx}px`
    props.top = `${d.top0 + d.dy}px`
    send('preview:hint', { key: 'offset', text: TOAST.offsetHint })
    void op({ type: 'setStyle', eid: eidOf(d.el)!, props }).then(() => select(d.el))
    return
  }
  if (!d.target) {
    // 没有落点：说明原因
    note(TOAST.noDropTarget)
    showSelected(selected)
    if (selected) ctx.overlay.setMulti(extra)
    return
  }
  const target = eidOf(d.target)!
  const o: StructOp =
    d.group.length > 1 ? { type: 'moveMany', eids: d.group.map((g) => eidOf(g)!), target, where: d.where } : { type: 'move', eid: eidOf(d.el)!, target, where: d.where }
  void op(o).then((ok) => {
    if (!ok && d.el.isConnected) select(d.el)
  })
}

// ---------- 键盘 ----------

export function selectRelative(dir: 'parent' | 'child' | 'next' | 'prev'): void {
  if (!selected) return
  let next: Element | null
  if (dir === 'parent') {
    next = selected.parentElement?.closest('[data-hw]') ?? null
    if (next && ROOTS.has(next.localName)) next = null
  } else if (dir === 'child') {
    next = selected.querySelector('[data-hw]')
  } else {
    const all = Array.from(document.body.querySelectorAll<HTMLElement>('[data-hw]')).filter((x) => x.getClientRects().length > 0)
    const i = all.indexOf(selected)
    next = all[i + (dir === 'next' ? 1 : -1)] ?? null
  }
  if (next instanceof HTMLElement || next instanceof SVGElement) select(next as HTMLElement, true)
}

/** 同级之间切换（Alt+← →）。 */
function selectSibling(d: 1 | -1): void {
  if (!selected) return
  const sibs = siblingsOf(selected)
  const i = sibs.indexOf(selected)
  const next = sibs[i + d]
  if (next) select(next, true)
}

export function runOp(kind: 'delete' | 'duplicate'): void {
  if (!selected) return note(TOAST.noSelection)
  const g = group()
  const table = ctx.table()
  const bad = g.find((x) => !table.get(eidOf(x)!)?.range)
  if (bad) return refuse(bad, TOAST.rejectRange)
  if (g.length > 1) void op({ type: 'batch', ops: g.map((x) => ({ type: kind, eid: eidOf(x)! })) })
  else void op({ type: kind, eid: eidOf(selected)! })
}

/** 方向键微调：写入 position: relative 与 left、top（20.4）。多选时一起移动。 */
function nudge(dx: number, dy: number): void {
  if (!selected) return
  const ops: StructOp[] = group().map((el) => {
    const cs = getComputedStyle(el)
    const inline = el.getAttribute('style') ?? ''
    const props: Record<string, string> = {}
    const pos = getDecl(inline, 'position')
    if (pos !== null) props.position = pos
    else if (cs.position === 'static') props.position = 'relative'
    props.left = `${Math.round((parseFloat(cs.left) || 0) + dx)}px`
    props.top = `${Math.round((parseFloat(cs.top) || 0) + dy)}px`
    return { type: 'setStyle', eid: eidOf(el)!, props }
  })
  send('preview:hint', { key: 'offset', text: TOAST.offsetHint })
  void op(ops.length > 1 ? { type: 'batch', ops } : ops[0])
}

/** 选择模式的按键；返回 true 表示已处理。 */
export function onKey(e: KeyboardEvent): boolean {
  const mod = ctx.isMac() ? e.metaKey : e.ctrlKey
  if (e.key === 'Escape') {
    if (extra.length && selected) {
      select(selected)
      return true
    }
    if (selected) {
      // 隔离中：先回到 svg 本身，再按一次退出隔离
      if (isolated && selected !== (isolated as unknown as HTMLElement)) {
        select(isolated as unknown as HTMLElement)
        return true
      }
      if (exitIsolation()) {
        select(selected)
        return true
      }
      select(null)
      return true
    }
    return exitIsolation()
  }
  if (!selected) {
    if (e.key === 'Tab') {
      const first = document.body.querySelector<HTMLElement>('[data-hw]')
      if (first) select(first, true)
      return true
    }
    return false
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    runOp('delete')
    return true
  }
  if (mod && e.key.toLowerCase() === 'd') {
    runOp('duplicate')
    return true
  }
  if (mod && e.key.toLowerCase() === 'a') {
    // 全选同级（拆解第 9 条）
    const sibs = siblingsOf(selected)
    extra = sibs.filter((s) => s !== selected)
    select(selected, false, true)
    return true
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    selectRelative(e.key === 'ArrowUp' ? 'parent' : 'child')
    return true
  }
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    selectSibling(e.key === 'ArrowLeft' ? -1 : 1)
    return true
  }
  if (e.key === 'Tab') {
    selectRelative(e.shiftKey ? 'prev' : 'next')
    return true
  }
  if (e.key === 'Enter') {
    if (selected.localName === 'svg') {
      enterIsolation(selected as unknown as SVGSVGElement)
      const first = selected.querySelector<HTMLElement>('[data-hw]')
      if (first) select(first)
      return true
    }
    if (selected.localName === 'text' || selected.localName === 'tspan') {
      ctx.enterSvgText(selected as unknown as SVGElement)
      return true
    }
    const t = ctx.table().get(eidOf(selected)!)
    if (t?.host || t?.hostId !== undefined) {
      const r = selected.getBoundingClientRect()
      ctx.activate(selected, { x: r.right - 1, y: r.bottom - 1 })
    }
    return true
  }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const a = arrows[e.key]
  if (a && !mod && !e.altKey) {
    const step = e.shiftKey ? 10 : 1
    nudge(a[0] * step, a[1] * step)
    return true
  }
  return false
}

// ---------- 尺寸手柄（20.3；v0.6 四角四边、等比、吸附） ----------

export function resizeStart(edge: Edge, e: PointerEvent): void {
  if (!selected) return
  const el = selected
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  // content-box 时写入的宽高要减去内边距与边框，保持视觉尺寸一致
  const padW = cs.boxSizing === 'border-box' ? 0 : parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
  const padH = cs.boxSizing === 'border-box' ? 0 : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  const others = siblingsOf(el).filter((s) => s !== el).map(boxOf)
  const parent = el.parentElement && !ROOTS.has(el.parentElement.localName) ? contentBox(el.parentElement) : null
  resize = { el, edge, x: e.clientX, y: e.clientY, w: r.width, h: r.height, dw: padW, dh: padH, prevStyle: el.getAttribute('style'), ratio: RATIO.has(el.localName), others, parent }
  window.addEventListener('pointermove', onResizeMove, true)
  window.addEventListener('pointerup', onResizeEnd, true)
}

/** 父元素的内容区（去掉内边距与边框）。 */
function contentBox(el: Element): Box {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    left: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    right: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
    top: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
    bottom: r.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom)
  }
}

const hasX = (edge: Edge): 'left' | 'right' | null => (edge.includes('e') ? 'right' : edge.includes('w') ? 'left' : null)
const hasY = (edge: Edge): 'top' | 'bottom' | null => (edge.includes('s') ? 'bottom' : edge.includes('n') ? 'top' : null)

/** 指针位置换算成新的宽高。左边与上边的手柄反向：往左拖变宽。 */
function sizeOf(e: PointerEvent, s: ResizeState): { w: number; h: number; guides: ReturnType<typeof snapResize>['guides'] } {
  const x = hasX(s.edge)
  const y = hasY(s.edge)
  const ddx = e.clientX - s.x
  const ddy = e.clientY - s.y
  let w = x === 'right' ? s.w + ddx : x === 'left' ? s.w - ddx : s.w
  let h = y === 'bottom' ? s.h + ddy : y === 'top' ? s.h - ddy : s.h
  // 等比：图片默认等比，Shift 切换（图片按 Shift 自由，其他元素按 Shift 等比）
  const ratio = s.ratio !== e.shiftKey
  if (ratio && x && y) {
    const k = keepRatio(s.w, s.h, w, h)
    w = k.width
    h = k.height
  } else if (ratio && x && !y) h = (w * s.h) / s.w
  else if (ratio && y && !x) w = (h * s.w) / s.h
  w = Math.max(8, w)
  h = Math.max(8, h)
  let guides: ReturnType<typeof snapResize>['guides'] = []
  const mod = ctx.isMac() ? e.metaKey : e.ctrlKey
  if (!mod) {
    // 吸附（拆解第 8 条）：按住 Cmd / Ctrl 临时关闭
    const r = s.el.getBoundingClientRect()
    const left = x === 'left' ? r.right - w : r.left
    const top = y === 'top' ? r.bottom - h : r.top
    const snapped = snapResize({ left, top, right: left + w, bottom: top + h }, { x: ratio && x && y ? x : x, y: ratio && x && y ? null : y }, s.others, s.parent)
    if (ratio && x && y) {
      // 等比时只吸宽度，高度跟随
      h = (snapped.width * s.h) / s.w
      w = snapped.width
    } else {
      w = snapped.width
      h = snapped.height
    }
    guides = snapped.guides
  }
  return { w: Math.round(w), h: Math.round(h), guides }
}

function onResizeMove(e: PointerEvent): void {
  const s = resize
  if (!s) return
  e.preventDefault()
  e.stopPropagation()
  const { w, h, guides } = sizeOf(e, s)
  const x = hasX(s.edge)
  const y = hasY(s.edge)
  const ratio = s.ratio !== e.shiftKey
  // 临时预览：直接改元素的内联样式，松手后由主进程写回源码并同步
  if (x || ratio) s.el.style.setProperty('width', `${w - s.dw}px`, 'important')
  if (y || (ratio && !s.ratio)) s.el.style.setProperty('height', `${h - s.dh}px`, 'important')
  if (ratio && s.ratio && !y) s.el.style.setProperty('height', 'auto', 'important')
  if (ratio && s.ratio && y) s.el.style.setProperty('height', `${h - s.dh}px`, 'important')
  ctx.overlay.setGuides(guides)
  const pct = Math.round((w / s.w) * 100)
  ctx.overlay.setSizeTip(`${S.size(w, h)}${pct !== 100 ? ` · ${pct}%` : ''}`, e.clientX, e.clientY)
  ctx.overlay.reposition()
}

function onResizeEnd(e: PointerEvent): void {
  const s = resize
  window.removeEventListener('pointermove', onResizeMove, true)
  window.removeEventListener('pointerup', onResizeEnd, true)
  resize = null
  ctx.overlay.setSizeTip(null)
  ctx.overlay.setGuides([])
  if (!s) return
  e.preventDefault()
  e.stopPropagation()
  const { w, h } = sizeOf(e, s)
  // 先把临时样式恢复成源码的值，再由补丁写入
  if (s.prevStyle === null) s.el.removeAttribute('style')
  else s.el.setAttribute('style', s.prevStyle)
  if (Math.abs(w - s.w) < 1 && Math.abs(h - s.h) < 1) return
  const x = hasX(s.edge)
  const y = hasY(s.edge)
  const ratio = s.ratio !== e.shiftKey
  const props: Record<string, string | null> = {}
  if (s.ratio && ratio) {
    // 图片等比：只写宽度，高度 auto，保持响应式
    props.width = `${Math.round(w - s.dw)}px`
    props.height = getDecl(s.prevStyle ?? '', 'height') !== null ? 'auto' : null
  } else {
    if (x || ratio) props.width = `${Math.round(w - s.dw)}px`
    if (y || ratio) props.height = `${Math.round(h - s.dh)}px`
  }
  const pcs = s.el.parentElement ? getComputedStyle(s.el.parentElement) : null
  if (pcs && /flex/.test(pcs.display)) {
    props['flex-grow'] = '0'
    props['flex-shrink'] = '0'
    props['flex-basis'] = 'auto'
    send('preview:hint', { key: 'flex', text: TOAST.flexHint })
  } else {
    send('preview:hint', { key: 'size', text: TOAST.sizeHint })
  }
  void op({ type: 'setStyle', eid: eidOf(s.el)!, props })
}
