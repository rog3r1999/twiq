// parse5 解析、元素表、槽表（规格 13.2、13.3）。
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import type { AttrInfo, ElementInfo, Eid, SlotInfo } from '../shared/types'
import { tokenize } from './patch'
import { BLACKLIST, assignHosts } from './host-rules'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type TextNode = DefaultTreeAdapterMap['textNode']

export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
])

/** 结束标签可以省略的元素：没有结束标签时，区间取到最后一个子节点为止（20.2） */
export const IMPLIED_END = new Set(['li', 'dt', 'dd', 'p', 'option', 'tr', 'td', 'th'])

/** SVG / MathML 里以 /> 结尾的自闭合元素（如 <rect/>）。 */
function selfClosing(source: string, el: Element): boolean {
  const loc = el.sourceCodeLocation
  if (!loc?.startTag || loc.endTag || (el.namespaceURI as string) === 'http://www.w3.org/1999/xhtml') return false
  return /\/\s*>$/.test(source.slice(loc.startTag.startOffset, loc.startTag.endOffset))
}

/**
 * 元素在源码中的终点：有结束标签取其后；省略结束标签（IMPLIED_END）时取最后一个子节点之后、去掉尾部空白。
 * 返回 null 表示无法可靠确定（子孙里有既无结束标签、又不能省略的元素）。
 */
function elementEnd(source: string, el: Element, tag: string): number | null {
  const loc = el.sourceCodeLocation!
  if (loc.endTag) return loc.endTag.endOffset
  const st = loc.startTag!.endOffset
  if (VOID_TAGS.has(tag) || selfClosing(source, el)) return st
  if (!IMPLIED_END.has(tag)) return null
  let end = st
  for (const c of el.childNodes) {
    const l = c.sourceCodeLocation
    if (!l) continue
    const e = isElement(c) && c.sourceCodeLocation?.startTag ? elementEnd(source, c, c.tagName.toLowerCase()) : l.endOffset
    if (e === null) return null
    if (e > end) end = e
  }
  // 父元素的结束标签可能被并进最后一个文本节点的位置（如 </body> 前的空白），截到它之前
  const cut = source.slice(st, end).search(/<\/(?:body|html)\b/i)
  if (cut >= 0) end = st + cut
  while (end > st && /\s/.test(source[end - 1])) end--
  return end
}

export interface ParsedDoc {
  elements: ElementInfo[] // 下标即 eid
  roots: Eid[] // 父元素为隐含元素（或文档）的显式元素
  /** 直接位于隐含元素（如被隐含的 body）下的非空白文字字符数 */
  impliedTextChars: number
  /** 每个元素最近的黑名单祖先（含隐含祖先），没有则不出现 */
  blackAncestor: Map<Eid, string>
}

export interface DecodedFile {
  source: string
  eol: 'LF' | 'CRLF'
  hasBom: boolean
  readOnly: null | 'encoding' | 'eol'
}

/** 打开文件：BOM、严格 UTF-8、换行风格（13.2 第 1–3 条）。 */
export function decodeFile(buf: Uint8Array): DecodedFile {
  let bytes = buf
  let hasBom = false
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    hasBom = true
    bytes = bytes.subarray(3)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // 只读浏览：尽量显示，不保证正确
    return { source: new TextDecoder('utf-8').decode(bytes), eol: 'LF', hasBom, readOnly: 'encoding' }
  }
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  if (crlf > 0 && lf > 0) return { source: text, eol: 'LF', hasBom, readOnly: 'eol' }
  if (crlf > 0) return { source: text.replace(/\r\n/g, '\n'), eol: 'CRLF', hasBom, readOnly: null }
  return { source: text, eol: 'LF', hasBom, readOnly: null }
}

/** 保存：把 source 还原为磁盘字节（13.8 第 1 条）。 */
export function encodeFile(source: string, eol: 'LF' | 'CRLF', hasBom: boolean): Buffer {
  const text = eol === 'CRLF' ? source.replace(/\n/g, '\r\n') : source
  const body = Buffer.from(text, 'utf8')
  return hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
}

function isElement(n: Node): n is Element {
  return 'tagName' in n
}
function isText(n: Node): n is TextNode {
  return n.nodeName === '#text'
}

const WS = /[^ \t\n\f\r]/

export function parseSource(source: string): ParsedDoc {
  const doc = parse(source, { sourceCodeLocationInfo: true })
  const elements: ElementInfo[] = []
  const roots: Eid[] = []
  const blackAncestor = new Map<Eid, string>()
  let impliedTextChars = 0

  // 先按文档顺序分配 eid（先序遍历），再划分槽
  const nodeOf: Element[] = []
  const visit = (node: Node, parentEid: Eid | null, black: string | null): void => {
    const kids = 'childNodes' in node ? node.childNodes : []
    for (const child of kids) {
      if (!isElement(child)) {
        if (isText(child) && parentEid === null && !black && WS.test(child.value) && isElement(node)) {
          impliedTextChars += child.value.replace(/[ \t\n\f\r]/g, '').length
        }
        continue
      }
      const loc = child.sourceCodeLocation
      const tag = child.tagName.toLowerCase()
      const childBlack = black ?? null
      const ownBlack = BLACKLIST.has(tag) ? (black ?? tag) : black
      if (loc && loc.startTag) {
        const eid = elements.length
        const st = loc.startTag
        const end = elementEnd(source, child, tag)
        const nameMatch = /^<([^\s/>]+)/.exec(source.slice(st.startOffset, st.startOffset + 64))
        elements.push({
          eid,
          tag,
          parent: parentEid,
          children: [],
          hasImpliedChild: false,
          slots: [],
          startTagStart: st.startOffset,
          startTagEnd: st.endOffset,
          end: end ?? st.endOffset,
          endTagStart: loc.endTag ? loc.endTag.startOffset : null,
          rangeOk: end !== null,
          ...(!loc.endTag && end !== null && IMPLIED_END.has(tag) ? { impliedEnd: true } : {}),
          attrs: attrLocations(loc, child.attrs),
          tagNameLength: nameMatch ? nameMatch[1].length : tag.length,
          isHost: false
        })
        nodeOf.push(child)
        if (childBlack) blackAncestor.set(eid, childBlack)
        if (parentEid === null) roots.push(eid)
        else elements[parentEid].children.push(eid)
        visit(child, eid, ownBlack)
      } else {
        if (parentEid !== null) elements[parentEid].hasImpliedChild = true
        visit(child, null, ownBlack)
      }
    }
  }
  visit(doc, null, null)

  for (const info of elements) info.slots = buildSlots(source, nodeOf[info.eid], info)
  assignHosts(elements, roots, blackAncestor)
  return { elements, roots, impliedTextChars, blackAncestor }
}

function attrLocations(
  loc: { attrs?: Record<string, { startOffset: number; endOffset: number }> },
  list: { name: string; value: string }[]
): Record<string, AttrInfo> {
  const out: Record<string, AttrInfo> = {}
  for (const a of list) {
    const v = loc.attrs?.[a.name]
    if (v) out[a.name.toLowerCase()] = { start: v.startOffset, end: v.endOffset, value: a.value }
  }
  return out
}

function buildSlots(source: string, node: Element, info: ElementInfo): SlotInfo[] {
  const slots: SlotInfo[] = []
  let texts: TextNode[] = []
  let comment = false
  let prev: Element | null = null
  const flush = (): void => {
    let start: number
    let end: number
    let anchorOk = true
    if (texts.length > 0) {
      start = texts[0].sourceCodeLocation!.startOffset
      end = texts[texts.length - 1].sourceCodeLocation!.endOffset
    } else if (prev) {
      start = end = prev.sourceCodeLocation!.endOffset
      const pl = prev.sourceCodeLocation!
      anchorOk = !!pl.endTag || VOID_TAGS.has(prev.tagName) || pl.endOffset === pl.startTag?.endOffset
    } else {
      start = end = info.startTagEnd
    }
    const raw = source.slice(start, end)
    const text = texts.map((t) => t.value).join('')
    // 原文里出现标签或注释的开头，说明文本节点的位置跨过了别的内容
    //（如 </body> 之后的空白被并入 body）。这样的槽整体不可编辑，否则写回会吞掉标签。
    const broken = !comment && /<[A-Za-z/!?]/.test(raw)
    slots.push({
      start,
      end,
      raw,
      text,
      tokens: comment || broken ? [] : tokenize(raw, text),
      hasComment: comment,
      anchorOk,
      ...(broken ? { broken } : {})
    })
    texts = []
    comment = false
  }
  for (const child of node.childNodes) {
    if (isElement(child)) {
      if (child.sourceCodeLocation?.startTag) {
        flush()
        prev = child
      }
    } else if (isText(child)) {
      if (child.sourceCodeLocation) texts.push(child)
    } else if (child.nodeName === '#comment') {
      comment = true
    }
  }
  flush()
  return slots
}

export function nonWsLength(text: string): number {
  return text.replace(/[ \t\n\f\r]/g, '').length
}
