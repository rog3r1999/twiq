// host 判定规则（规格 13.4）。纯函数，只依赖元素表。
import type { ElementInfo, Eid, ReasonCode } from '../shared/types'

export const BLACKLIST = new Set([
  'script', 'style', 'noscript', 'template', 'textarea', 'select', 'option', 'iframe', 'object', 'embed',
  'canvas', 'video', 'audio', 'svg', 'math', 'pre', 'head', 'title'
])

export const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins', 'kbd',
  'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr'
])

/** 原子内联：可以出现在 host 里，但内部不扫描、不可编辑。 */
export const ATOMIC = new Set(['img', 'svg', 'input'])

/** 这些容器内的文字不会被渲染为页面文字，不参与高亮与统计。 */
const INVISIBLE = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio'])

const HAS_TEXT = /[^ \t\n\f\r]/

export function slotHasText(text: string): boolean {
  return HAS_TEXT.test(text)
}

/** 元素所处的黑名单上下文：自身或最近的黑名单祖先。 */
function blackContext(el: ElementInfo, blackAncestor: Map<Eid, string>): string | null {
  if (BLACKLIST.has(el.tag)) return blackAncestor.get(el.eid) ?? el.tag
  return blackAncestor.get(el.eid) ?? null
}

/** 黑名单上下文对应的原因；返回 null 表示文字不可见，不做提示。 */
export function reasonForBlack(tag: string): ReasonCode | null {
  if (tag === 'pre') return 'IN_PRE'
  if (tag === 'svg' || tag === 'math') return 'IN_SVG'
  if (tag === 'textarea' || tag === 'select' || tag === 'option') return 'IN_FORM_CONTROL'
  if (INVISIBLE.has(tag)) return null
  return null
}

/** 规则 3：E 的子孙全部在内联白名单内（原子内联不展开），且子树里有非空白文字。 */
function isCandidate(elements: ElementInfo[], el: ElementInfo): boolean {
  if (ATOMIC.has(el.tag)) return false
  let text = false
  const stack: ElementInfo[] = [el]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur.hasImpliedChild) return false
    if (cur.slots.some((s) => slotHasText(s.text))) text = true
    for (const c of cur.children) {
      const child = elements[c]
      if (ATOMIC.has(child.tag)) continue
      if (!INLINE.has(child.tag)) return false
      stack.push(child)
    }
  }
  return text
}

function markHost(elements: ElementInfo[], host: ElementInfo): void {
  host.isHost = true
  const stack = [...host.children]
  let comment = host.slots.some((s) => s.hasComment)
  let broken = host.slots.some((s) => s.broken)
  while (stack.length) {
    const cur = elements[stack.pop()!]
    cur.hostId = host.eid
    if (ATOMIC.has(cur.tag)) {
      // 原子内联的子孙同样归属该 host，但不参与编辑
      const inner = [...cur.children]
      while (inner.length) {
        const x = elements[inner.pop()!]
        x.hostId = host.eid
        inner.push(...x.children)
      }
      continue
    }
    if (cur.slots.some((s) => s.hasComment)) comment = true
    if (cur.slots.some((s) => s.broken)) broken = true
    stack.push(...cur.children)
  }
  if (comment) host.uneditableReason = 'COMMENT_IN_SLOT'
  else if (broken) host.uneditableReason = 'MISMATCH'
}

/**
 * 给元素表填写 isHost、hostId、uneditableReason。
 * 自外向内，最外层的候选成为 host（规则 4）。
 */
export function assignHosts(elements: ElementInfo[], roots: Eid[], blackAncestor: Map<Eid, string>): void {
  for (const el of elements) {
    el.isHost = false
    el.hostId = undefined
    el.uneditableReason = undefined
  }
  const visit = (eid: Eid): void => {
    const el = elements[eid]
    const black = blackContext(el, blackAncestor)
    if (black) {
      // 规则 1：黑名单及其整棵子树不可编辑
      const reason = reasonForBlack(black)
      const stack = [eid]
      let any = false
      while (stack.length) {
        const cur = elements[stack.pop()!]
        if (reason && cur.slots.some((s) => slotHasText(s.text))) {
          cur.uneditableReason = reason
          any = true
        }
        stack.push(...cur.children)
      }
      // 容器本身（如 <pre><code>…</code></pre> 的 pre）也带上原因，点击其空白处同样有提示
      if (reason && any) el.uneditableReason = reason
      return
    }
    if (isCandidate(elements, el)) {
      markHost(elements, el)
      return
    }
    // 规则 5：含文字但不满足规则 3
    if (el.slots.some((s) => slotHasText(s.text))) el.uneditableReason = 'BLOCK_CHILDREN'
    for (const c of el.children) visit(c)
  }
  // 父元素为隐含元素的元素也作为根参与判定；其祖先关系仍由 blackAncestor 记录
  const seen = new Set<Eid>()
  for (const r of roots) {
    seen.add(r)
    visit(r)
  }
  // 位于隐含元素之下、但其显式祖先已存在的元素（如 table > 隐含 tbody > tr）
  for (const el of elements) {
    if (el.parent === null && !seen.has(el.eid)) visit(el.eid)
  }
}
