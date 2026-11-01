// 结构与属性类 op 到补丁的换算（规格 20.1–20.4）。纯函数，只依赖 source 与元素表。
// 每种 op 都换算成对 source 的区间替换；逆补丁由 applyPatches 统一求出。
import type { ElementInfo, Eid, FormatTag, Patch, SlotPoint, StructOp, Where } from '../shared/types'
import { FORMAT_ALIASES } from '../shared/types'
export type { StructOp } from '../shared/types'
import { setDecls } from '../shared/style-attr'
import { parseFragment } from 'parse5'
import { VOID_TAGS } from './parse'

export class OpError extends Error {
  constructor(
    public code: 'RANGE' | 'TARGET' | 'NOOP' | 'SELECTION' | 'STRUCTURE',
    message: string
  ) {
    super(message)
  }
}

export interface OpPlan {
  patches: Patch[]
  /**
   * 结构变化的预期：元素数量的增量；0 表示结构必须完全不变；'any' 不检查（插入片段、整份替换）；
   * count：只检查数量（多处不连续的删除、复制）；replace：区间外的元素原样保留，区间内删 removed 个、加 added 个
   */
  countDelta: number | 'any' | 'permute' | { count: number } | { replace: { removed: number; added: number } }
  /** 操作后应被选中的元素在新 source 中的起点 */
  selectAt?: number
  /** 属性类 op：涉及的元素与属性名（撤销重做时同步预览用） */
  attrs?: { eid: Eid; name: string }[]
}

function lineStart(src: string, at: number): number {
  const i = src.lastIndexOf('\n', at - 1)
  return i + 1
}

/** 元素前面同一行只有空白时，返回该行的缩进；否则返回 null。 */
function ownLineIndent(src: string, at: number): string | null {
  const ls = lineStart(src, at)
  const before = src.slice(ls, at)
  return /^[ \t]*$/.test(before) ? before : null
}

/** 元素后面同一行只有空白时，返回到换行符之后的位置；否则返回 null。 */
function ownLineEnd(src: string, at: number): number | null {
  let i = at
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++
  if (i >= src.length) return i
  if (src[i] === '\n') return i + 1
  return null
}

function subtreeSize(elements: ElementInfo[], eid: Eid): number {
  let n = 0
  const stack = [eid]
  while (stack.length) {
    const cur = stack.pop()!
    n++
    stack.push(...elements[cur].children)
  }
  return n
}

function isInside(elements: ElementInfo[], eid: Eid, ancestor: Eid): boolean {
  for (let p: Eid | null = eid; p !== null; p = elements[p].parent) if (p === ancestor) return true
  return false
}

function need(elements: ElementInfo[], eid: Eid): ElementInfo {
  const el = elements[eid]
  if (!el) throw new OpError('TARGET', `no element ${eid}`)
  return el
}

function needRange(el: ElementInfo): void {
  if (!el.rangeOk) throw new OpError('RANGE', `element ${el.eid} has no explicit end tag`)
  if (el.tag === 'html' || el.tag === 'head' || el.tag === 'body') throw new OpError('RANGE', 'root element')
}

/** 元素的删除范围：独占整行时连同前导缩进与行尾换行（20.2）。 */
export function cutRange(src: string, el: ElementInfo): { start: number; end: number } {
  const indent = ownLineIndent(src, el.startTagStart)
  const end = indent !== null ? ownLineEnd(src, el.end) : null
  if (indent !== null && end !== null) {
    // 文件末尾没有换行、而元素前面有换行时，改为删掉前面那个换行
    if (end === src.length && src[end - 1] !== '\n') {
      const ls = lineStart(src, el.startTagStart)
      return { start: Math.max(0, ls - 1), end }
    }
    return { start: lineStart(src, el.startTagStart), end }
  }
  return { start: el.startTagStart, end: el.end }
}

/** 元素的源码原文；省略了结束标签的（li、p 等）补上结束标签，放到别处时不会吞掉后面的兄弟。 */
export function rawOf(src: string, el: ElementInfo): string {
  const raw = src.slice(el.startTagStart, el.end)
  return el.impliedEnd ? `${raw}</${el.tag}>` : raw
}

/** 把多行片段从一种缩进换到另一种：首行不动，其余行去掉旧缩进前缀、加上新缩进。 */
function reindent(raw: string, from: string, to: string): string {
  if (from === to || !raw.includes('\n')) return raw
  return raw
    .split('\n')
    .map((line, i) => (i === 0 ? line : (line.startsWith(from) ? to + line.slice(from.length) : line)))
    .join('\n')
}

/** 在元素 t 之前或之后插入一段原文，按 t 的缩进排版。 */
function insertNear(src: string, t: ElementInfo, where: Where, raw: string, rawIndent: string | null): { patch: Patch; selectAt: number } {
  const indent = ownLineIndent(src, t.startTagStart)
  const tailOwn = indent !== null && ownLineEnd(src, t.end) !== null
  const body = rawIndent !== null && indent !== null ? reindent(raw, rawIndent, indent) : raw
  if (where === 'before') {
    if (tailOwn) {
      // 独占一行：插在本行行首，新起一行
      const ls = lineStart(src, t.startTagStart)
      return { patch: { start: ls, end: ls, text: `${indent}${body}\n` }, selectAt: ls + indent!.length }
    }
    return { patch: { start: t.startTagStart, end: t.startTagStart, text: body }, selectAt: t.startTagStart }
  }
  if (tailOwn) {
    return { patch: { start: t.end, end: t.end, text: `\n${indent}${body}` }, selectAt: t.end + 1 + indent!.length }
  }
  return { patch: { start: t.end, end: t.end, text: body }, selectAt: t.end }
}

/** move 的位置约束（20.2）：li 只能在 ul / ol 内，tr 只能在同一表体内。 */
function checkMoveTarget(elements: ElementInfo[], el: ElementInfo, t: ElementInfo, pos: Where): void {
  if (t.eid === el.eid || isInside(elements, t.eid, el.eid)) throw new OpError('TARGET', 'target inside moved element')
  const parentTag = t.parent === null ? null : elements[t.parent].tag
  if (el.tag === 'li' && parentTag !== 'ul' && parentTag !== 'ol' && parentTag !== 'menu') throw new OpError('TARGET', 'li outside list')
  if (el.tag === 'tr' && t.parent !== el.parent) throw new OpError('TARGET', 'tr outside its table section')
  if ((el.tag === 'td' || el.tag === 'th') && t.parent !== el.parent) throw new OpError('TARGET', 'cell outside its row')
  if (t.tag === 'html' || t.tag === 'head' || t.tag === 'body') throw new OpError('TARGET', 'root target')
  if (t.parent !== null && elements[t.parent].tag === 'head') throw new OpError('TARGET', 'head target')
  // 移到原地：紧挨着的兄弟
  const sib = el.parent === null ? null : elements[el.parent].children
  if (sib && t.parent === el.parent) {
    const i = sib.indexOf(el.eid)
    if ((sib[i + 1] === t.eid && pos === 'before') || (sib[i - 1] === t.eid && pos === 'after')) {
      throw new OpError('NOOP', 'no movement')
    }
  }
}

/** 起始标签里写入、修改或删除一个属性。 */
export function attrPatch(src: string, el: ElementInfo, name: string, value: string | null): Patch | null {
  const key = name.toLowerCase()
  if (!/^[a-z_:][-a-z0-9_:.]*$/.test(key)) throw new OpError('TARGET', `bad attribute name ${name}`)
  const cur = el.attrs[key]
  if (value === null) {
    if (!cur) return null
    // 连同前面的空白一起删
    let s = cur.start
    while (s > el.startTagStart && /\s/.test(src[s - 1])) s--
    return { start: s, end: cur.end, text: '' }
  }
  const text = `${key}="${escapeAttr(value)}"`
  if (cur) {
    if (cur.value === value) return null
    return { start: cur.start, end: cur.end, text }
  }
  // 插在标签名之后
  const at = el.startTagStart + 1 + el.tagNameLength
  return { start: at, end: at, text: ` ${text}` }
}

export function escapeAttr(v: string): string {
  return v.replace(/[&"\u00a0]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&nbsp;'))
}

/** 多个元素整体移动（多选拖放）：按文档顺序剪下，拼成一段插到目标处。 */
function moveManyPlan(src: string, elements: ElementInfo[], eids: Eid[], target: Eid, where: Where): OpPlan {
  const els = [...new Set(eids)].map((e) => need(elements, e)).sort((a, b) => a.startTagStart - b.startTagStart)
  if (els.length === 0) throw new OpError('TARGET', 'nothing to move')
  // 祖先与子孙同时选中时只移祖先
  const roots = els.filter((el) => !els.some((o) => o !== el && isInside(elements, el.eid, o.eid)))
  const t = need(elements, target)
  if (!t.rangeOk && where === 'after') throw new OpError('RANGE', 'target has no end tag')
  if (roots.some((el) => el.eid === t.eid || isInside(elements, t.eid, el.eid))) throw new OpError('TARGET', 'target inside moved element')
  for (const el of roots) {
    needRange(el)
    if (roots.length === 1) checkMoveTarget(elements, el, t, where)
    else {
      const parentTag = t.parent === null ? null : elements[t.parent].tag
      if (el.tag === 'li' && parentTag !== 'ul' && parentTag !== 'ol' && parentTag !== 'menu') throw new OpError('TARGET', 'li outside list')
      if ((el.tag === 'tr' || el.tag === 'td' || el.tag === 'th') && t.parent !== el.parent) throw new OpError('TARGET', 'tr outside its table section')
      if (t.tag === 'html' || t.tag === 'head' || t.tag === 'body') throw new OpError('TARGET', 'root target')
    }
  }
  const indent = ownLineIndent(src, t.startTagStart)
  const tailOwn = indent !== null && ownLineEnd(src, t.end) !== null
  const raws = roots.map((el) => {
    const raw = rawOf(src, el)
    const from = ownLineIndent(src, el.startTagStart)
    return from !== null && indent !== null ? reindent(raw, from, indent) : raw
  })
  const joined = raws.join(tailOwn ? `\n${indent}` : '')
  const cuts = roots.map((el) => cutRange(src, el))
  const { patch } = insertNear(src, t, where, joined, null)
  for (const c of cuts) if (patch.start > c.start && patch.start < c.end) throw new OpError('TARGET', 'target overlaps cut range')
  // 插入点紧挨着某个剪切范围时，把插入并进那段剪切（补丁不能重叠）
  const patches: Patch[] = []
  let merged = false
  for (const c of cuts) {
    if (!merged && (patch.start === c.start || patch.start === c.end)) {
      patches.push({ start: c.start, end: c.end, text: patch.text })
      merged = true
    } else patches.push({ ...c, text: '' })
  }
  if (!merged) patches.push(patch)
  // 选中位置：插入点之前剪掉的长度
  const shift = cuts.filter((c) => c.end <= patch.start).reduce((n, c) => n + (c.end - c.start), 0)
  const lead = patch.text.length - patch.text.trimStart().length
  return { patches, countDelta: 'permute', selectAt: patch.start - shift + lead }
}

/** 批量操作（多选）：各自换算后合并成一组补丁，一步撤销。 */
function batchPlan(src: string, elements: ElementInfo[], ops: StructOp[]): OpPlan {
  if (ops.length === 0) throw new OpError('NOOP', 'empty batch')
  const plans = ops.map((o) => {
    if (o.type !== 'delete' && o.type !== 'duplicate' && o.type !== 'setStyle' && o.type !== 'setAttr') throw new OpError('TARGET', `op ${o.type} not batchable`)
    return planOp(src, elements, o)
  })
  const patches = plans.flatMap((p) => p.patches)
  const sorted = [...patches].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) throw new OpError('TARGET', 'overlapping elements')
  const allAttr = plans.every((p) => p.attrs)
  let count = 0
  for (const p of plans) count += typeof p.countDelta === 'number' ? p.countDelta : 0
  return {
    patches,
    countDelta: allAttr ? 0 : { count },
    selectAt: plans.find((p) => p.selectAt !== undefined)?.selectAt,
    attrs: allAttr ? plans.flatMap((p) => p.attrs!) : undefined
  }
}

/** 片段里源码中有显式起始标签的元素个数（递归；隐含元素本身不算，它的子元素照算） */
function countExplicit(node: { childNodes?: unknown[] }): number {
  let n = 0
  for (const c of (node.childNodes ?? []) as { tagName?: string; sourceCodeLocation?: { startTag?: unknown } | null; childNodes?: unknown[] }[]) {
    if (c.tagName === undefined) continue
    if (c.sourceCodeLocation?.startTag) n++
    n += countExplicit(c)
  }
  return n
}

/** 用新原文替换整个元素（v0.6 SVG 源码编辑，v0.10 起任意元素）。新原文必须恰好是一个元素，且标签相同。 */
function replacePlan(src: string, elements: ElementInfo[], eid: Eid, html: string): OpPlan {
  const el = need(elements, eid)
  needRange(el)
  const trimmed = html.trim()
  const m = /^<([A-Za-z][^\s/>]*)/.exec(trimmed)
  if (!m || m[1].toLowerCase() !== el.tag) throw new OpError('STRUCTURE', 'root tag changed')
  const raw = src.slice(el.startTagStart, el.end)
  if (raw === trimmed) throw new OpError('NOOP', 'no change')
  // 新原文必须恰好是一个元素：解析后顶层只有它自己（不算空白与注释），且结束于片段末尾
  const frag = parseFragment(trimmed, { sourceCodeLocationInfo: true })
  const tops = frag.childNodes.filter((n) => !(n.nodeName === '#text' && !('value' in n && n.value.trim())) && n.nodeName !== '#comment')
  if (tops.length !== 1 || tops[0].nodeName !== el.tag || tops[0].sourceCodeLocation?.endOffset !== trimmed.length) {
    throw new OpError('STRUCTURE', 'not a single element')
  }
  const removed = subtreeSize(elements, el.eid)
  // 新片段里的元素个数：与 parseSource 同一规则，只数源码里有显式起始标签的元素。
  // 不能按「<字母」数：脚本、样式、属性值里的 a<b 也会被算进去，合法的源码编辑被结构校验拒绝
  const added = countExplicit(frag)
  return { patches: [{ start: el.startTagStart, end: el.end, text: trimmed }], countDelta: { replace: { removed, added } }, selectAt: el.startTagStart }
}

/** 槽内位置换算到 source 偏移（对齐到 token 边界）。 */
function slotOffset(el: ElementInfo, slot: number, offset: number): number {
  const s = el.slots[slot]
  if (!s) throw new OpError('SELECTION', 'no slot')
  if (s.hasComment || s.broken) throw new OpError('SELECTION', 'slot not editable')
  if (offset <= 0) return s.start
  let acc = 0
  for (const t of s.tokens) {
    if (acc >= offset) return s.start + t.rawStart
    acc += t.decoded.length
  }
  return s.end
}

/** 文字格式：在同一父元素的两个槽位置之间包上一层内联标签（20.3）。 */
function formatPlan(src: string, elements: ElementInfo[], start: SlotPoint, end: SlotPoint, tag: FormatTag): OpPlan {
  if (start.eid !== end.eid) throw new OpError('SELECTION', 'selection crosses element boundary')
  const el = need(elements, start.eid)
  if (el.hostId === undefined && !el.isHost) throw new OpError('SELECTION', 'not in a host')
  let a = start
  let b = end
  if (a.slot > b.slot || (a.slot === b.slot && a.offset > b.offset)) [a, b] = [b, a]
  if (a.slot === b.slot && a.offset === b.offset) throw new OpError('SELECTION', 'empty selection')
  // 选区所在的元素已有同种格式：取消格式（解开那一层）
  const aliases = FORMAT_ALIASES[tag]
  for (let p: Eid | null = el.eid; p !== null; p = elements[p].parent) {
    const cur = elements[p]
    if (aliases.includes(cur.tag)) return unwrapPlan(src, elements, cur.eid)
    if (cur.isHost) break
  }
  // 选区恰好覆盖一个同种格式的子元素：同样取消
  if (b.slot === a.slot + 1) {
    const child = elements[el.children[a.slot]]
    const ta = el.slots[a.slot].text.length
    if (aliases.includes(child.tag) && a.offset === ta && b.offset === 0) return unwrapPlan(src, elements, child.eid)
  }
  const s = slotOffset(el, a.slot, a.offset)
  const e = slotOffset(el, b.slot, b.offset)
  // 两个槽之间的子元素都要完整包在里面，且必须是显式成对的标签
  for (let i = a.slot; i < b.slot; i++) {
    const c = elements[el.children[i]]
    if (!c.rangeOk) throw new OpError('SELECTION', 'child without end tag')
  }
  return {
    patches: [
      { start: s, end: s, text: `<${tag}>` },
      { start: e, end: e, text: `</${tag}>` }
    ],
    countDelta: 1,
    selectAt: s
  }
}

/** 去掉元素的起止标签，保留内容。 */
function unwrapPlan(src: string, elements: ElementInfo[], eid: Eid): OpPlan {
  const el = need(elements, eid)
  if (!el.rangeOk || el.endTagStart === null || VOID_TAGS.has(el.tag)) throw new OpError('RANGE', 'cannot unwrap')
  void src
  return {
    patches: [
      { start: el.startTagStart, end: el.startTagEnd, text: '' },
      { start: el.endTagStart, end: el.end, text: '' }
    ],
    countDelta: -1,
    selectAt: el.parent !== null ? elements[el.parent].startTagStart : undefined
  }
}

export function planOp(src: string, elements: ElementInfo[], op: StructOp): OpPlan {
  switch (op.type) {
    case 'delete': {
      const el = need(elements, op.eid)
      needRange(el)
      const r = cutRange(src, el)
      return { patches: [{ ...r, text: '' }], countDelta: -subtreeSize(elements, el.eid) }
    }
    case 'duplicate': {
      const el = need(elements, op.eid)
      needRange(el)
      const raw = rawOf(src, el)
      const ind = ownLineIndent(src, el.startTagStart)
      const { patch, selectAt } = insertNear(src, el, 'after', raw, ind)
      return { patches: [patch], countDelta: subtreeSize(elements, el.eid), selectAt }
    }
    case 'move': {
      const el = need(elements, op.eid)
      const t = need(elements, op.target)
      needRange(el)
      if (!t.rangeOk && op.where === 'after') throw new OpError('RANGE', 'target has no end tag')
      checkMoveTarget(elements, el, t, op.where)
      const cut = cutRange(src, el)
      const raw = rawOf(src, el)
      const { patch, selectAt } = insertNear(src, t, op.where, raw, ownLineIndent(src, el.startTagStart))
      // 插入点不能落在剪切范围内部
      if (patch.start > cut.start && patch.start < cut.end) throw new OpError('TARGET', 'target overlaps cut range')
      // 选中位置：插入点之前若有剪切，要减去剪切的长度
      const shift = cut.end <= patch.start ? cut.end - cut.start : 0
      return { patches: [{ ...cut, text: '' }, patch], countDelta: 0, selectAt: selectAt - shift }
    }
    case 'insertHtml': {
      if (op.eid === null) {
        // 没有参照元素：插到 body 末尾（找不到 body 时插到文件末尾）
        const body = elements.find((e) => e.tag === 'body' && e.endTagStart !== null)
        const at = body ? body.endTagStart! : src.length
        const text = `${src[at - 1] === '\n' ? '' : '\n'}${op.html}\n`
        return { patches: [{ start: at, end: at, text }], countDelta: 'any', selectAt: at + (text.startsWith('\n') ? 1 : 0) }
      }
      const el = need(elements, op.eid)
      if (op.where === 'before' || op.where === 'after') {
        if (!el.rangeOk && op.where === 'after') throw new OpError('RANGE', 'no end tag')
        const { patch, selectAt } = insertNear(src, el, op.where, op.html, '')
        return { patches: [patch], countDelta: 'any', selectAt }
      }
      if (VOID_TAGS.has(el.tag) || el.endTagStart === null) throw new OpError('RANGE', 'no content range')
      const at = op.where === 'prepend' ? el.startTagEnd : el.endTagStart
      return { patches: [{ start: at, end: at, text: op.html }], countDelta: 'any', selectAt: at }
    }
    case 'setAttr': {
      const el = need(elements, op.eid)
      const p = attrPatch(src, el, op.name, op.value)
      return { patches: p ? [p] : [], countDelta: 0, attrs: [{ eid: el.eid, name: op.name.toLowerCase() }] }
    }
    case 'setStyle': {
      const el = need(elements, op.eid)
      const cur = el.attrs.style?.value ?? ''
      const next = setDecls(cur, op.props)
      const p = attrPatch(src, el, 'style', next.trim() === '' ? null : next)
      return { patches: p ? [p] : [], countDelta: 0, attrs: [{ eid: el.eid, name: 'style' }] }
    }
    case 'format':
      return formatPlan(src, elements, op.start, op.end, op.tag)
    case 'unwrap':
      return unwrapPlan(src, elements, op.eid)
    case 'batch':
      return batchPlan(src, elements, op.ops)
    case 'moveMany':
      return moveManyPlan(src, elements, op.eids, op.target, op.where)
    case 'replaceElement':
      return replacePlan(src, elements, op.eid, op.html)
    case 'replaceAll': {
      if (op.source === src) return { patches: [], countDelta: 'any' }
      let p = 0
      while (p < src.length && p < op.source.length && src[p] === op.source[p]) p++
      let s = 0
      while (s < src.length - p && s < op.source.length - p && src[src.length - 1 - s] === op.source[op.source.length - 1 - s]) s++
      return { patches: [{ start: p, end: src.length - s, text: op.source.slice(p, op.source.length - s) }], countDelta: 'any' }
    }
  }
}
