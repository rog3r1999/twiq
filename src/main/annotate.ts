// 生成带标注副本（规格 13.5）：只用于预览，不写回磁盘。
import type { ElementInfo } from '../shared/types'

export function annotate(source: string, elements: ElementInfo[]): string {
  // 插入点 = startTag 起点 + 1 + 标签名原文长度；必须从后往前插入
  const points = elements.map((el) => ({ at: el.startTagStart + 1 + el.tagNameLength, eid: el.eid }))
  points.sort((a, b) => a.at - b.at)
  const parts: string[] = []
  let cursor = 0
  for (const p of points) {
    // 不带引号的属性值会一直延续到空白或 >，紧跟 / 时（如 <br/>）补一个空格隔开
    const sep = source.charCodeAt(p.at) === 0x2f ? ' ' : ''
    parts.push(source.slice(cursor, p.at), ` data-hw=${p.eid}${sep}`)
    cursor = p.at
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

/** 去掉本应用插入的所有 data-hw 属性（测试用）。 */
export function stripAnnotations(annotated: string): string {
  return annotated.replace(/ data-hw=\d+(?: (?=\/))?/g, '')
}
