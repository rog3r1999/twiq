// 组件规范（规格 20.4）：data-c 标组件类型，data-slot 标槽位，data-id 由规范化步骤注入。
// 本版实现：规范化（补 data-id）与校验器；分级编辑（Level 1）只做到「槽位之外的文字只读」的检查提示。
import type { ElementInfo, Patch } from '../shared/types'
import { attrPatch } from './ops'
import { parseSource } from './parse'
import { M } from './strings'

export interface ComponentIssue {
  eid: number
  tag: string
  message: string
}

/** 为每个带 data-c 但缺少 data-id 的元素注入唯一 data-id（c-1、c-2…，跳过已用的）。 */
export function normalizePatches(source: string, elements: ElementInfo[] = parseSource(source).elements): Patch[] {
  const used = new Set(elements.map((e) => e.attrs['data-id']?.value).filter((v): v is string => !!v))
  let n = 1
  const next = (): string => {
    while (used.has(`c-${n}`)) n++
    used.add(`c-${n}`)
    return `c-${n}`
  }
  const out: Patch[] = []
  for (const el of elements) {
    if (!el.attrs['data-c'] || el.attrs['data-id']) continue
    const p = attrPatch(source, el, 'data-id', next())
    if (p) out.push(p)
  }
  return out
}

/** 校验：data-id 唯一；data-slot 必须位于某个 data-c 之内；data-c 不能为空值。 */
export function checkComponents(source: string): ComponentIssue[] {
  const { elements } = parseSource(source)
  const issues: ComponentIssue[] = []
  const ids = new Map<string, number>()
  for (const el of elements) {
    const id = el.attrs['data-id']?.value
    if (id !== undefined) {
      if (ids.has(id)) issues.push({ eid: el.eid, tag: el.tag, message: M.dupId(id) })
      else ids.set(id, el.eid)
    }
    const c = el.attrs['data-c']
    if (c && !c.value.trim()) issues.push({ eid: el.eid, tag: el.tag, message: M.emptyC })
    if (c && !el.attrs['data-id']) issues.push({ eid: el.eid, tag: el.tag, message: M.noId(c.value) })
    if (el.attrs['data-slot']) {
      let inside = false
      for (let p = el.parent; p !== null; p = elements[p].parent) {
        if (elements[p].attrs['data-c']) {
          inside = true
          break
        }
      }
      if (!inside && !c) issues.push({ eid: el.eid, tag: el.tag, message: M.orphanSlot(el.attrs['data-slot'].value) })
    }
  }
  return issues
}
