// 预览端的 DOM 工具：槽读写、快照、命中测试、统计（规格 13.6、13.9 第 4 条、17.4）。
import type { Eid, PageStats, PreviewElement, ReasonCode, Snapshot, SnapshotElement } from '../shared/types'

export const ATTR = 'data-hw'
const ATOMIC = new Set(['img', 'svg', 'input'])
/** 可能被浏览器隐含补出的元素 */
const IMPLIED = new Set(['html', 'head', 'body', 'tbody', 'colgroup'])
const WS = /[^ \t\n\f\r]/
/** 整个容器不可编辑的原因：点击容器内任意位置都给出提示 */
const CONTAINER_REASONS = new Set<ReasonCode>(['IN_PRE', 'IN_SVG', 'IN_FORM_CONTROL'])

export type Table = Map<Eid, PreviewElement>

export function eidOf(el: Element): Eid | null {
  const v = el.getAttribute(ATTR)
  if (v === null || !/^\d+$/.test(v)) return null
  return Number(v)
}

export function findByEid(eid: Eid, scope: ParentNode = document): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[${ATTR}="${eid}"]`)
}

/** 按带 data-hw 的子元素切分 childNodes：slots[i] 是第 i 个槽里的节点。 */
export function slotNodes(el: Element): Node[][] {
  const slots: Node[][] = [[]]
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && eidOf(child as Element) !== null) slots.push([])
    else slots[slots.length - 1].push(child)
  }
  return slots
}

export function childEids(el: Element): Eid[] {
  const out: Eid[] = []
  for (const c of Array.from(el.children)) {
    const e = eidOf(c)
    if (e !== null) out.push(e)
  }
  return out
}

function readSlots(el: Element): { texts: string[]; comments: boolean[]; foreign: boolean } {
  const texts: string[] = []
  const comments: boolean[] = []
  let foreign = false
  for (const nodes of slotNodes(el)) {
    let t = ''
    let c = false
    for (const n of nodes) {
      if (n.nodeType === Node.TEXT_NODE) t += (n as Text).data
      else if (n.nodeType === Node.COMMENT_NODE) c = true
      else if (n.nodeType === Node.ELEMENT_NODE) foreign = true
    }
    texts.push(t)
    comments.push(c)
  }
  return { texts, comments, foreign }
}

function isAtomic(el: Element, table: Table): boolean {
  const e = eidOf(el)
  return ATOMIC.has(el.localName) || (e !== null && !!table.get(e)?.atomic)
}

/** 对 host 做快照：host 及其所有带 data-hw 的非原子后代。 */
export function snapshot(host: HTMLElement, table: Table): Snapshot {
  const elements: SnapshotElement[] = []
  let foreign = false
  const walk = (el: Element): void => {
    const eid = eidOf(el)
    if (eid === null) {
      foreign = true
      return
    }
    const s = readSlots(el)
    if (s.foreign) foreign = true
    elements.push({ eid, children: childEids(el), slots: s.texts, hasComment: s.comments })
    for (const c of Array.from(el.children)) {
      if (eidOf(c) === null) continue
      if (isAtomic(c, table)) continue
      walk(c)
    }
  }
  walk(host)
  return { host: eidOf(host) ?? -1, elements, foreign }
}

/** 预览同步：把元素 eid 的第 slot 个槽替换为 text（13.9 第 4 条）。 */
export function setSlotText(eid: Eid, slot: number, text: string): boolean {
  const el = findByEid(eid)
  if (!el) return false
  const slots = slotNodes(el)
  const nodes = slots[slot]
  if (!nodes) return false
  for (const n of nodes) if (n.nodeType === Node.TEXT_NODE) n.parentNode?.removeChild(n)
  if (text) {
    const boundary = Array.from(el.children).filter((c) => eidOf(c) !== null)[slot] ?? null
    el.insertBefore(document.createTextNode(text), boundary)
  }
  return true
}

export function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE && WS.test((n as Text).data)) return true
  return false
}

export type HitTarget = { kind: 'host'; el: HTMLElement; eid: Eid } | { kind: 'uneditable'; el: HTMLElement; reason: ReasonCode }

/** 命中测试（8.1）：从最深的元素向上，找到第一个属于某个 host、或不可编辑但含文字的元素。 */
export function hitTest(start: Element | null, table: Table, overlayHost: Element): HitTarget | null {
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    if (el === overlayHost) return null
    const eid = eidOf(el)
    if (eid !== null) {
      const info = table.get(eid)
      if (!info) continue
      if (info.host || info.hostId !== undefined) {
        const hostEl = (info.host ? el : el.closest(`[${ATTR}="${info.hostId}"]`)) as HTMLElement | null
        if (!hostEl) continue
        const hinfo = table.get(eidOf(hostEl)!)!
        if (hinfo.reason) return { kind: 'uneditable', el: hostEl, reason: hinfo.reason }
        return { kind: 'host', el: hostEl, eid: hinfo.eid }
      }
      if (info.reason && CONTAINER_REASONS.has(info.reason) && WS.test(el.textContent ?? '')) {
        return { kind: 'uneditable', el: el as HTMLElement, reason: info.reason }
      }
      if (hasOwnText(el)) {
        if (info.reason) return { kind: 'uneditable', el: el as HTMLElement, reason: info.reason }
        if (!info.hasText) return { kind: 'uneditable', el: el as HTMLElement, reason: 'SCRIPT_GENERATED' }
      }
      continue
    }
    if (hasOwnText(el)) {
      return { kind: 'uneditable', el: el as HTMLElement, reason: IMPLIED.has(el.localName) ? 'IMPLIED_ELEMENT' : 'SCRIPT_GENERATED' }
    }
  }
  return null
}

export function isVisible(el: Element): boolean {
  // 关闭的 details、content-visibility: hidden 内的元素仍有布局矩形，需要 checkVisibility 排除
  if (!el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: false })) return false
  const rects = el.getClientRects()
  if (rects.length === 0) return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  return getComputedStyle(el).visibility === 'visible'
}

/** 所有可编辑 host（文档顺序）。 */
export function editableHosts(table: Table): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${ATTR}]`)).filter((el) => {
    const info = table.get(eidOf(el)!)
    return !!info && info.host && !info.reason
  })
}

export function breadcrumb(el: Element): { parts: string[]; full: string; selectors: string[]; eids: (Eid | null)[] } {
  const chain: string[] = []
  const ids: (Eid | null)[] = []
  for (let cur: Element | null = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
    let s = cur.localName
    if (cur.id) s += `#${cur.id}`
    const cls = cur.classList[0]
    if (cls) s += `.${cls}`
    chain.unshift(s)
    ids.unshift(cur.localName === 'body' ? null : eidOf(cur))
  }
  const full = chain.join(' > ')
  // 每段悬停时显示从根到该段的完整选择器（8.7）
  const upTo = (i: number): string => chain.slice(0, i + 1).join(' > ')
  const all = chain.map((_, i) => upTo(i))
  const long = chain.length > 6
  const parts = long ? [...chain.slice(0, 2), '…', ...chain.slice(-3)] : chain
  const selectors = long ? [...all.slice(0, 2), full, ...all.slice(-3)] : all
  const eids = long ? [...ids.slice(0, 2), null, ...ids.slice(-3)] : ids
  return { parts, full, selectors, eids }
}

const nonWs = (s: string): number => s.replace(/[ \t\n\f\r]/g, '').length

/** 统计可见文字与可编辑文字（17.4 口径）。 */
export function computeStats(table: Table, overlayHost: Element): PageStats {
  const stats: PageStats = { visible: 0, editable: 0, reasons: {}, nodes: document.getElementsByTagName('*').length }
  if (!document.body) return stats
  const visCache = new Map<Element, boolean>()
  const visible = (el: Element): boolean => {
    let v = visCache.get(el)
    if (v === undefined) {
      v = el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length > 0
      visCache.set(el, v)
    }
    return v
  }
  const slotCache = new Map<Element, string[]>()
  const domSlots = (el: Element): string[] => {
    let s = slotCache.get(el)
    if (!s) {
      s = readSlots(el).texts
      slotCache.set(el, s)
    }
    return s
  }
  const add = (r: ReasonCode, n: number): void => {
    stats.reasons[r] = (stats.reasons[r] ?? 0) + n
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const n = nonWs(node.data)
    if (!n) continue
    const p = node.parentElement
    if (!p || overlayHost.contains(p) || !visible(p)) continue
    stats.visible += n
    const eid = eidOf(p)
    if (eid === null) {
      add(IMPLIED.has(p.localName) ? 'IMPLIED_ELEMENT' : 'SCRIPT_GENERATED', n)
      continue
    }
    const info = table.get(eid)
    if (!info) {
      add('SCRIPT_GENERATED', n)
      continue
    }
    if (info.host || info.hostId !== undefined) {
      const host = info.host ? info : table.get(info.hostId!)
      if (host?.reason) add(host.reason, n)
      else if (info.atomic) add('IN_SVG', n)
      else {
        const slots = domSlots(p)
        const idx = slotNodes(p).findIndex((nodes) => nodes.includes(node!))
        if (idx >= 0 && info.slots && slots[idx] === info.slots[idx]) stats.editable += n
        else add(info.hasText || (info.slots && info.slots[idx]) ? 'MISMATCH' : 'SCRIPT_GENERATED', n)
      }
      continue
    }
    add(info.reason ?? (info.hasText ? 'BLOCK_CHILDREN' : 'SCRIPT_GENERATED'), n)
  }
  return stats
}

const MEDIA = 'img, video, audio, svg, canvas, iframe, object, embed, input, select, textarea, button, picture, hr, br'
const NOT_BLANK = new Set(['html', 'head', 'body', 'script', 'style', 'template', 'noscript', 'link', 'meta', 'title', 'br', 'hr', 'img', 'input', 'video', 'audio', 'svg', 'canvas', 'iframe', 'object', 'embed', 'source', 'track', 'wbr', 'col', 'colgroup', 'area', 'param', 'picture', 'textarea', 'select', 'button', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'table'])

/** 「显示空白」：没有文字也没有媒体的可见容器（20.2）。 */
export function blankElements(table: Table, limit = 500): HTMLElement[] {
  const out: HTMLElement[] = []
  if (!document.body) return out
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>(`[${ATTR}]`))) {
    if (out.length >= limit) break
    const eid = eidOf(el)
    if (eid === null || !table.has(eid) || NOT_BLANK.has(el.localName)) continue
    if (WS.test(el.textContent ?? '')) continue
    if (el.querySelector(MEDIA)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    if (!el.checkVisibility({ visibilityProperty: true })) continue
    // 背景图也算内容
    if (getComputedStyle(el).backgroundImage !== 'none') continue
    out.push(el)
  }
  // 嵌套的空白容器只标最外层
  return out.filter((el) => !out.some((o) => o !== el && o.contains(el)))
}
