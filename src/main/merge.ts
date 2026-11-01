// 文件变更三方合并（规格 20.5）：以 eid 加槽（以及属性）为单位，
// 对比「打开时版本 base、内存版本 mine、磁盘版本 theirs」。
// 三份的元素结构必须一致；不一致时返回 null，交给原有的冲突对话框。
import type { Patch } from '../shared/types'
import { attrPatch } from './ops'
import { slotPatch } from './patch'
import { parseSource, type ParsedDoc } from './parse'
import { sameStructure } from './document'
import { M as Msg } from './strings'

export interface MergeConflict {
  label: string
  mine: string
  theirs: string
  /** 选择「保留我的」时应用到 theirs 上的补丁 */
  patch: Patch | null
}

export interface MergePlan {
  /** 无冲突、自动应用到 theirs 上的补丁（mine 改了而 theirs 没改的部分） */
  auto: Patch[]
  conflicts: MergeConflict[]
}

function snippet(s: string, n = 40): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

export function plan3(base: string, mine: string, theirs: string): MergePlan | null {
  const B = parseSource(base)
  const M = parseSource(mine)
  const T = parseSource(theirs)
  if (!sameStructure(B, M) || !sameStructure(B, T)) return null
  return planParsed(B, M, T, theirs)
}

function planParsed(B: ParsedDoc, M: ParsedDoc, T: ParsedDoc, theirs: string): MergePlan {
  const auto: Patch[] = []
  const conflicts: MergeConflict[] = []
  for (let i = 0; i < B.elements.length; i++) {
    const b = B.elements[i]
    const m = M.elements[i]
    const t = T.elements[i]
    // 文字槽
    for (let k = 0; k < b.slots.length; k++) {
      const bt = b.slots[k].text
      const mt = m.slots[k].text
      const tt = t.slots[k].text
      if (mt === bt || mt === tt) continue
      const ts = t.slots[k]
      const patch = ts.hasComment || ts.broken ? null : slotPatch(ts, mt)
      if (tt === bt) {
        if (patch) auto.push(patch)
        else conflicts.push({ label: Msg.mergeText(t.tag), mine: snippet(mt), theirs: snippet(tt), patch: null })
      } else {
        conflicts.push({ label: Msg.mergeText(t.tag), mine: snippet(mt), theirs: snippet(tt), patch })
      }
    }
    // 属性
    const names = new Set([...Object.keys(b.attrs), ...Object.keys(m.attrs), ...Object.keys(t.attrs)])
    for (const name of names) {
      const bv = b.attrs[name]?.value ?? null
      const mv = m.attrs[name]?.value ?? null
      const tv = t.attrs[name]?.value ?? null
      if (mv === bv || mv === tv) continue
      const patch = attrPatch(theirs, t, name, mv)
      if (tv === bv) {
        if (patch) auto.push(patch)
      } else {
        conflicts.push({ label: Msg.mergeAttr(t.tag, name), mine: snippet(mv ?? Msg.none), theirs: snippet(tv ?? Msg.none), patch })
      }
    }
  }
  return { auto, conflicts }
}
