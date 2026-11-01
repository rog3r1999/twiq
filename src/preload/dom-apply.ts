// 结构类操作的就地同步（v0.6）：按主进程给出的 DomSync 改 DOM，改完逐项校验；
// 任何一步对不上就返回 false，由主进程退回整页重载。移动时用 FLIP 动画平滑过渡。
import type { DomSync, Eid } from '../shared/types'
import { ATTR, childEids, eidOf, slotNodes } from './dom'

function allByEid(): Map<Eid, HTMLElement> {
  const m = new Map<Eid, HTMLElement>()
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${ATTR}]`))) {
    const e = eidOf(el)
    if (e === null || m.has(e)) continue
    m.set(e, el)
  }
  return m
}

/** 把元素的第 i 个槽改为 text（保留注释等非文字节点）。 */
function writeSlots(el: Element, texts: string[]): boolean {
  const slots = slotNodes(el)
  if (slots.length !== texts.length) return false
  const bounds = Array.from(el.children).filter((c) => eidOf(c) !== null)
  slots.forEach((nodes, i) => {
    const cur = nodes.filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => (n as Text).data).join('')
    if (cur === texts[i]) return
    for (const n of nodes) if (n.nodeType === Node.TEXT_NODE) n.parentNode?.removeChild(n)
    if (texts[i]) el.insertBefore(document.createTextNode(texts[i]), bounds[i] ?? null)
  })
  return true
}

function readSlotTexts(el: Element): string[] {
  return slotNodes(el).map((nodes) => nodes.filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => (n as Text).data).join(''))
}

/** 记录元素位置，改完 DOM 后从旧位置平滑过渡到新位置（FLIP）。 */
function flip(els: HTMLElement[], reduced: boolean): () => void {
  if (reduced) return () => {}
  const first = new Map<HTMLElement, DOMRect>()
  for (const el of els) if (el.isConnected) first.set(el, el.getBoundingClientRect())
  return () => {
    for (const [el, a] of first) {
      if (!el.isConnected || getComputedStyle(el).display === 'inline') continue
      const b = el.getBoundingClientRect()
      const dx = a.left - b.left
      const dy = a.top - b.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      try {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
      } catch {
        // 不支持时没有动画
      }
    }
  }
}

export function applyDomSync(dom: DomSync, expectedTotal: number, reduced: boolean): boolean {
  const old = allByEid()
  const countBefore = old.size
  // 动画对象：受影响父元素的子元素（移动时兄弟会让位）
  const animated: HTMLElement[] = []
  for (const s of dom.slots) {
    const o = dom.map.indexOf(s.eid)
    const el = o >= 0 ? old.get(o) : undefined
    if (el) for (const c of Array.from(el.children)) if (c instanceof HTMLElement || c instanceof SVGElement) animated.push(c as HTMLElement)
  }
  const play = flip(animated, reduced)
  // 1. 删除与暂时移走
  const detached = new Map<Eid, HTMLElement>()
  for (const o of dom.remove) {
    const el = old.get(o)
    if (!el) return false
    el.remove()
  }
  for (const o of dom.detach) {
    const el = old.get(o)
    if (!el) return false
    el.remove()
    detached.set(o, el)
  }
  // 2. 换号：先收集引用再统一改写，避免新旧编号相撞
  const byNew = new Map<Eid, HTMLElement>()
  for (const [o, el] of old) {
    const n = dom.map[o]
    if (n === undefined || n < 0) continue
    el.setAttribute(ATTR, String(n))
    byNew.set(n, el)
  }
  // 3. 插入
  for (const ins of dom.inserts) {
    let parent: Element | null
    let before: Element | null
    if (ins.parent === null) {
      // 隐含父元素：取紧挨的兄弟所在的父元素，前后兄弟都给出时必须是同一个
      const b = ins.before === null ? null : byNew.get(ins.before) ?? null
      const a = ins.after == null ? null : byNew.get(ins.after) ?? null
      if ((ins.before !== null && !b) || (ins.after != null && !a)) return false
      parent = (b ?? a)?.parentElement ?? null
      if (!parent || (a && b && a.parentElement !== b.parentElement)) return false
      before = b ?? a!.nextElementSibling
    } else {
      parent = byNew.get(ins.parent) ?? null
      if (!parent) return false
      before = ins.before === null ? null : byNew.get(ins.before) ?? null
      if (ins.before !== null && (!before || before.parentElement !== parent)) return false
    }
    let node: HTMLElement | null = null
    if (ins.from !== undefined) {
      node = detached.get(ins.from) ?? null
      if (!node) return false
      parent.insertBefore(node, before)
    } else if (ins.html !== undefined) {
      // 以父元素为上下文解析，SVG、表格里的片段也能得到正确的命名空间与结构
      if (before) before.insertAdjacentHTML('beforebegin', ins.html)
      else parent.insertAdjacentHTML('beforeend', ins.html)
      node = Array.from(parent.children).find((c) => eidOf(c) === ins.eid) as HTMLElement | undefined ?? null
      if (!node) return false
      for (const d of [node, ...Array.from(node.querySelectorAll<HTMLElement>(`[${ATTR}]`))]) byNew.set(eidOf(d)!, d)
    }
    if (node) byNew.set(ins.eid, node)
  }
  // 4. 受影响元素的槽文字与子元素序列
  for (const s of dom.slots) {
    const el = byNew.get(s.eid)
    if (!el || el.localName !== s.tag) return false
    const kids = childEids(el)
    if (kids.length !== s.children.length || kids.some((k, i) => k !== s.children[i])) return false
    if (!writeSlots(el, s.slots)) return false
    const now = readSlotTexts(el)
    if (now.some((t, i) => t !== s.slots[i])) return false
  }
  // 5. 总数：页面脚本可能改过 DOM，对不上就重载
  const after = document.querySelectorAll(`[${ATTR}]`).length
  if (after - countBefore !== expectedTotal - dom.map.length) return false
  play()
  return true
}
