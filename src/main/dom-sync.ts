// 结构类操作的就地同步（v0.6 拆解第 1 条）：不重新载入预览，而是把补丁换算成 DOM 步骤。
// 纯函数：输入旧元素表、补丁（旧坐标）、新元素表与新 source，输出预览要执行的步骤；
// 无法保证正确时返回 null，由调用方退回整页重载。
import type { DomSync, ElementInfo, Eid, Patch } from '../shared/types'

/** 旧 source 偏移经补丁换算到新 source；落在被替换区间内部时返回 null。 */
function mapOffset(sorted: Patch[], at: number): number | null {
  let delta = 0
  for (const p of sorted) {
    if (at < p.start) break
    if (at < p.end) return null
    delta += p.text.length - (p.end - p.start)
  }
  return at + delta
}

/** 带 data-hw 的片段原文：给 [start, end) 内起始的元素注入新的 eid。 */
export function annotateRange(source: string, elements: ElementInfo[], root: ElementInfo): string {
  const start = root.startTagStart
  const end = root.end
  const parts: string[] = []
  let cursor = start
  for (let i = root.eid; i < elements.length && elements[i].startTagStart < end; i++) {
    const el = elements[i]
    if (el.startTagStart < start) continue
    const at = el.startTagStart + 1 + el.tagNameLength
    const sep = source.charCodeAt(at) === 0x2f ? ' ' : ''
    parts.push(source.slice(cursor, at), ` data-hw=${el.eid}${sep}`)
    cursor = at
  }
  parts.push(source.slice(cursor, end))
  return parts.join('')
}

/** 子树：按源码区间取（含隐含父元素下的后代，如表格里的行）。 */
function subtree(elements: ElementInfo[], eid: Eid): Eid[] {
  const root = elements[eid]
  const out: Eid[] = [eid]
  for (let i = eid + 1; i < elements.length && elements[i].startTagStart < root.end; i++) out.push(i)
  return out
}

/**
 * 补丁区间 [a, b) 去掉整棵增删的子树后，剩下的非空白片段。
 * 这些片段只能是某个元素内容区里的文字，否则返回 null（落在标签或属性里、跨过元素边界）。
 * 返回每段所在的最内层元素，调用方同步它的文字槽。
 */
function textOwners(src: string, els: ElementInfo[], a: number, b: number, covered: [number, number][]): Eid[] | null {
  const owners: Eid[] = []
  let i = a
  while (i < b) {
    const cut = covered.find(([s, e]) => s <= i && i < e)
    if (cut) {
      i = cut[1]
      continue
    }
    if (/\s/.test(src[i])) {
      i++
      continue
    }
    // 一段连续的、不在覆盖区间里的字符
    let j = i
    while (j < b && !covered.some(([s, e]) => s <= j && j < e)) j++
    let owner: ElementInfo | null = null
    for (const el of els) {
      if (el.startTagStart >= j) break
      if (el.end <= i) continue
      const contentEnd = el.endTagStart ?? el.end
      if (el.startTagEnd <= i && contentEnd >= j) owner = el
      else return null
    }
    if (!owner) return null
    owners.push(owner.eid)
    i = j
  }
  return owners
}

/** 去掉每行的前导空白：比较移动前后的原文（移动会重排缩进）。 */
const shape = (s: string): string => s.replace(/\n[ \t]*/g, '\n')

export function planDomSync(prev: ElementInfo[], prevSource: string, patches: Patch[], next: ElementInfo[], source: string): DomSync | null {
  const sorted = [...patches].sort((a, b) => a.start - b.start)
  const byStart = new Map<number, Eid>()
  for (const el of next) byStart.set(el.startTagStart, el.eid)
  const map: Eid[] = new Array(prev.length).fill(-1)
  const used = new Set<Eid>()
  for (const el of prev) {
    const at = mapOffset(sorted, el.startTagStart)
    if (at === null) continue
    const n = byStart.get(at)
    if (n === undefined || next[n].tag !== el.tag || used.has(n)) return null
    map[el.eid] = n
    used.add(n)
  }
  // 被删的元素必须整棵子树一起删（解开标签之类的操作退回重载）
  const removedRoots: Eid[] = []
  for (const el of prev) {
    if (map[el.eid] >= 0) continue
    if (el.parent === null || map[el.parent] >= 0) removedRoots.push(el.eid)
    if (el.children.some((c) => map[c] >= 0)) return null
  }
  const insertedRoots: Eid[] = []
  for (const el of next) {
    if (used.has(el.eid)) continue
    // 父元素是隐含元素（如表格里自动补的 tbody）：凭相邻兄弟定位
    if (el.parent === null || used.has(el.parent)) insertedRoots.push(el.eid)
    else if (!next[el.parent] || used.has(el.parent)) return null
  }
  // 原样换了位置的子树：直接移动 DOM 节点，保留图片、视频等的状态
  const moves = new Map<Eid, Eid>()
  const movedInside = new Set<Eid>()
  const freeRemoved = new Set(removedRoots)
  for (const r of insertedRoots) {
    if (movedInside.has(r)) continue
    const raw = shape(source.slice(next[r].startTagStart, next[r].end))
    for (const o of freeRemoved) {
      if (prev[o].tag !== next[r].tag || shape(prevSource.slice(prev[o].startTagStart, prev[o].end)) !== raw) continue
      const a = subtree(prev, o)
      const b = subtree(next, r)
      if (a.length !== b.length || a.some((x, i) => prev[x].tag !== next[b[i]].tag)) continue
      a.forEach((x, i) => (map[x] = b[i]))
      moves.set(r, o)
      freeRemoved.delete(o)
      // 子树里挂在隐含父元素下的根随整体一起移动
      for (const x of a) freeRemoved.delete(x)
      for (const y of b) if (y !== r) movedInside.add(y)
      break
    }
  }
  for (const y of movedInside) {
    const i = insertedRoots.indexOf(y)
    if (i >= 0) insertedRoots.splice(i, 1)
  }
  // 父子关系必须保持一致：新表里的父元素 = 旧父元素换算后的 eid（移动的子树根除外）
  for (let o = 0; o < prev.length; o++) {
    const n = map[o]
    if (n < 0 || moves.has(n)) continue
    const p = prev[o].parent
    if ((p === null ? null : map[p]) !== next[n].parent) return null
  }
  const affected = new Set<Eid>()
  for (const o of removedRoots) {
    const p = prev[o].parent
    if (p !== null && map[p] >= 0) affected.add(map[p])
  }
  const roots = next.filter((e) => e.parent === null).map((e) => e.eid)
  const inserts: DomSync['inserts'] = []
  for (const r of [...insertedRoots].reverse()) {
    const el = next[r]
    const from = moves.get(r)
    const body = from !== undefined ? { from } : { html: annotateRange(source, next, el) }
    if (el.parent === null) {
      // 只处理隐含父元素确定的情形（表格行落在自动补的 tbody 里）；其余如隐含 head / body 退回重载
      if (el.tag !== 'tr') return null
      // 前后兄弟必须与它紧挨（中间没有别的元素开始），保证在同一个隐含父元素里
      const i = roots.indexOf(r)
      const prevRoot = i > 0 ? roots[i - 1] : null
      const nextRoot = roots[i + 1] ?? null
      const firstAfter = (end: number): Eid | null => next.find((e) => e.startTagStart >= end)?.eid ?? null
      const before = nextRoot !== null && firstAfter(el.end) === nextRoot ? nextRoot : null
      const after = prevRoot !== null && firstAfter(next[prevRoot].end) === r ? prevRoot : null
      if (before === null && after === null) return null
      if ([before, after].some((n) => n !== null && next[n].tag !== 'tr')) return null
      inserts.push({ eid: r, ...body, parent: null, before, after })
      continue
    }
    const parent = next[el.parent]
    const i = parent.children.indexOf(r)
    const before = parent.children[i + 1] ?? null
    affected.add(parent.eid)
    inserts.push({ eid: r, ...body, parent: parent.eid, before })
  }
  // 移动的子树重排了缩进，子树内的槽也一并同步
  for (const r of moves.keys()) for (const e of subtree(next, r)) affected.add(e)
  // 补丁里不属于整棵增删子树的部分（改字类的整份替换：改动面板撤回一处、组件规范化）：
  // 只允许是仍在的元素里的文字，同步那个元素的文字槽；落在标签里（属性）就没有就地步骤可用，退回重载
  const removedRanges = removedRoots.map((o): [number, number] => [prev[o].startTagStart, prev[o].end])
  const insertedRanges = insertedRoots.map((r): [number, number] => [next[r].startTagStart, next[r].end])
  let delta = 0
  for (const p of sorted) {
    const ns = p.start + delta
    delta += p.text.length - (p.end - p.start)
    const before = textOwners(prevSource, prev, p.start, p.end, removedRanges)
    const after = textOwners(source, next, ns, ns + p.text.length, insertedRanges)
    if (!before || !after) return null
    for (const o of before) {
      if (map[o] < 0) return null
      affected.add(map[o])
    }
    for (const n of after) {
      if (!used.has(n)) return null
      affected.add(n)
    }
  }
  return {
    map,
    remove: [...freeRemoved],
    detach: [...moves.values()],
    inserts,
    slots: [...affected].sort((a, b) => a - b).map((eid) => ({ eid, tag: next[eid].tag, slots: next[eid].slots.map((s) => s.text), children: next[eid].children }))
  }
}
