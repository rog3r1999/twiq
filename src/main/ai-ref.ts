// 复制给 AI（v0.10）：把选中元素连同它在文件里的位置（行号、选择器）整理成一段说明，
// 粘贴给 AI 助手，让它只改这一段。纯函数，不依赖 Electron。
import type { ElementInfo, Eid } from '../shared/types'

/** 源码偏移所在的行号（从 1 起） */
export function lineOf(source: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) n++
  return n
}

const SIMPLE = /^[A-Za-z_][\w-]*$/

/**
 * 能在浏览器里唯一定位它的 CSS 选择器：遇到可用的 id 就从 id 开始；否则从 body 往下，
 * 每层写标签名（加第一个 class 便于认），同级有同名标签时加 :nth-of-type。
 */
export function selectorOf(els: ElementInfo[], eid: Eid): string {
  const parts: string[] = []
  for (let cur: ElementInfo | undefined = els[eid]; cur; cur = cur.parent === null ? undefined : els[cur.parent]) {
    if (cur.tag === 'html' || cur.tag === 'head') break
    const id = cur.attrs.id?.value
    if (id && SIMPLE.test(id)) {
      parts.unshift(`#${id}`)
      break
    }
    if (cur.tag === 'body') {
      parts.unshift('body')
      break
    }
    let part = cur.tag
    const cls = cur.attrs.class?.value.trim().split(/\s+/)[0]
    if (cls && SIMPLE.test(cls)) part += `.${cls}`
    const tag = cur.tag
    const same = cur.parent === null ? [] : els[cur.parent].children.filter((c) => els[c].tag === tag)
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur.eid) + 1})`
    parts.unshift(part)
  }
  return parts.join(' > ')
}

export interface AiRef {
  from: number
  to: number
  selector: string
  html: string
}

/**
 * 元素在当前源码里的行号范围、选择器与原文；没有完整起止标签的元素返回 null。
 * 原文一字不改地取（省略的结束标签也不补）：AI 要在文件里按原文找到这一段
 */
export function aiRef(source: string, els: ElementInfo[], eid: Eid): AiRef | null {
  const el = els[eid]
  if (!el?.rangeOk) return null
  return {
    from: lineOf(source, el.startTagStart),
    to: lineOf(source, Math.max(el.startTagStart, el.end - 1)),
    selector: selectorOf(els, eid),
    html: source.slice(el.startTagStart, el.end)
  }
}
