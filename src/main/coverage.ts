// 覆盖率统计（规格 17.4）。静态版只看源码，无法识别脚本生成的文字。
import type { ElementInfo, ReasonCode } from '../shared/types'
import { ATOMIC, BLACKLIST, reasonForBlack } from './host-rules'
import { nonWsLength, parseSource } from './parse'

export interface CoverageStat {
  visible: number
  editable: number
  reasons: Partial<Record<ReasonCode, number>>
}

/** 静态覆盖率：可编辑字符 ÷ 源码中可见的文字字符（去掉空白）。 */
export function staticCoverage(source: string): CoverageStat {
  const parsed = parseSource(source)
  const { elements } = parsed
  const stat: CoverageStat = { visible: 0, editable: 0, reasons: {} }
  const add = (reason: ReasonCode, n: number): void => {
    stat.reasons[reason] = (stat.reasons[reason] ?? 0) + n
  }
  if (parsed.impliedTextChars) {
    stat.visible += parsed.impliedTextChars
    add('IMPLIED_ELEMENT', parsed.impliedTextChars)
  }
  const inAtomic = atomicMembers(elements)
  for (const el of elements) {
    const chars = el.slots.reduce((n, s) => n + nonWsLength(s.text), 0)
    if (!chars) continue
    const black = BLACKLIST.has(el.tag) ? (parsed.blackAncestor.get(el.eid) ?? el.tag) : parsed.blackAncestor.get(el.eid)
    if (black && !reasonForBlack(black)) continue // 不可见
    stat.visible += chars
    if (el.hostId !== undefined || el.isHost) {
      const host = el.isHost ? el : elements[el.hostId!]
      if (inAtomic.has(el.eid)) add('IN_SVG', chars)
      else if (host.uneditableReason) add(host.uneditableReason, chars)
      else stat.editable += chars
    } else {
      add(el.uneditableReason ?? 'BLOCK_CHILDREN', chars)
    }
  }
  return stat
}

/** host 内原子内联元素（及其子孙）的集合。 */
function atomicMembers(elements: ElementInfo[]): Set<number> {
  const out = new Set<number>()
  for (const el of elements) {
    if (el.hostId === undefined || !ATOMIC.has(el.tag)) continue
    const stack = [el.eid]
    while (stack.length) {
      const cur = stack.pop()!
      out.add(cur)
      stack.push(...elements[cur].children)
    }
  }
  return out
}

export interface PageRow {
  name: string
  stat: CoverageStat
  scriptRendered: boolean
}

export function summarize(rows: PageRow[]): { weighted: number; average: number; reasons: Partial<Record<ReasonCode, number>> } {
  const gated = rows.filter((r) => !r.scriptRendered && r.stat.visible > 0)
  const vis = gated.reduce((n, r) => n + r.stat.visible, 0)
  const ed = gated.reduce((n, r) => n + r.stat.editable, 0)
  const avg = gated.length ? gated.reduce((n, r) => n + r.stat.editable / r.stat.visible, 0) / gated.length : 0
  const reasons: Partial<Record<ReasonCode, number>> = {}
  for (const r of gated) {
    for (const [k, v] of Object.entries(r.stat.reasons)) reasons[k as ReasonCode] = (reasons[k as ReasonCode] ?? 0) + (v ?? 0)
  }
  return { weighted: vis ? ed / vis : 0, average: avg, reasons }
}

export function renderReport(title: string, sets: { name: string; rows: PageRow[] }[], note: string): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
  const lines: string[] = [`# ${title}`, '', note, '']
  for (const set of sets) {
    const s = summarize(set.rows)
    lines.push(`## ${set.name}`, '')
    lines.push(`- 页数：${set.rows.length}（其中脚本渲染页 ${set.rows.filter((r) => r.scriptRendered).length}，不计入门槛）`)
    lines.push(`- **按字符加权覆盖率（门槛口径）：${pct(s.weighted)}**`)
    lines.push(`- 按页面平均覆盖率（参考）：${pct(s.average)}`, '')
    lines.push('| 页面 | 可见字符 | 可编辑字符 | 覆盖率 | 主要不可编辑原因 |', '|---|---:|---:|---:|---|')
    for (const r of set.rows) {
      const top = Object.entries(r.stat.reasons).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      const why = top.map(([k, v]) => `${k} ${v}`).join('，') || '—'
      const cov = r.stat.visible ? pct(r.stat.editable / r.stat.visible) : '—'
      lines.push(`| ${r.name}${r.scriptRendered ? '（脚本渲染页）' : ''} | ${r.stat.visible} | ${r.stat.editable} | ${cov} | ${why} |`)
    }
    const total = Object.values(s.reasons).reduce((n, v) => n + (v ?? 0), 0)
    lines.push('', '不可编辑原因分布（按字符，不含脚本渲染页）：', '')
    lines.push('| 原因 | 字符数 | 占不可编辑 |', '|---|---:|---:|')
    for (const [k, v] of Object.entries(s.reasons).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
      lines.push(`| ${k} | ${v} | ${total ? pct((v ?? 0) / total) : '—'} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
