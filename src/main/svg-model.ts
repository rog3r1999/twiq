// SVG 结构化编辑的数据（v0.7）：从源码里列出 svg 内可编辑的文字与形状，面板据此生成表单。
import type { ElementInfo, Eid } from '../shared/types'
import { SVG_ITEMS_MAX, SVG_KINDS, svgFields, type SvgItem, type SvgModel } from '../shared/svg'

/** 文字最多的槽（普通 <text>xx</text> 只有一个槽）；与 preload/svg-edit 的选择一致 */
export function mainSlot(texts: string[]): number {
  let best = 0
  for (let i = 1; i < texts.length; i++) if (texts[i].trim().length > texts[best].trim().length) best = i
  return best
}

/** 列出 svg 元素 eid 内部的可编辑元素（文档顺序）。文字排在前面，便于先改最常改的内容。 */
export function svgModel(elements: ElementInfo[], eid: Eid): SvgModel | null {
  const root = elements[eid]
  if (!root || root.tag !== 'svg') return null
  const out: SvgItem[] = []
  let total = 0
  const walk = (p: ElementInfo, depth: number): void => {
    for (const c of p.children) {
      const el = elements[c]
      if (!el) continue
      // defs、clipPath 等不直接显示的内容不列出
      if (/^(defs|clippath|mask|pattern|symbol|marker|lineargradient|radialgradient|filter|style|script|title|desc|metadata)$/i.test(el.tag)) continue
      if (SVG_KINDS[el.tag]) {
        total++
        if (out.length < SVG_ITEMS_MAX) out.push(item(el, depth))
      }
      // tspan 作为 text 的一部分在 text 里改；g 等分组继续往里找
      if (el.tag !== 'text') walk(el, el.tag === 'g' || el.tag === 'a' ? depth + 1 : depth)
    }
  }
  walk(root, 0)
  const rank = (i: SvgItem): number => (i.text ? 0 : 1)
  const items = out.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((a) => a.x)
  return { eid, more: total - out.length, items }
}

function item(el: ElementInfo, depth: number): SvgItem {
  const f = svgFields(el.tag)
  const attrs: Record<string, string> = {}
  // 源码里没有的属性给空串：面板照样显示输入框，填了就新增这个属性
  for (const n of [...f.geo, ...f.look]) attrs[n] = el.attrs[n.toLowerCase()]?.value ?? ''
  const it: SvgItem = { eid: el.eid, tag: el.tag, depth, id: el.attrs.id?.value ?? '', attrs }
  if (el.tag === 'text' || el.tag === 'tspan') {
    const texts = el.slots.map((s) => s.text)
    const slot = mainSlot(texts)
    it.text = { slot, value: texts[slot] }
  }
  return it
}
