// TabState：source、版本号、撤销栈、保存点（规格 13.1、13.7 第 7–9 条、13.9）。
import type { ElementInfo, Eid, Patch, PreviewElement, PreviewSync, ReasonCode, SetSlotOp, Snapshot, UndoEntry } from '../shared/types'
import { ATOMIC, slotHasText } from './host-rules'
import { applyPatches, slotPatch, wholeDiff } from './patch'
import { parseSource, type ParsedDoc } from './parse'
import { OpError, planOp, type OpPlan, type StructOp } from './ops'
import { planDomSync } from './dom-sync'

export const COALESCE_MS = 600

export class EditError extends Error {
  constructor(
    public code: 'MISMATCH' | 'STRUCTURE' | 'READONLY' | 'REJECTED' | 'NOOP',
    message: string
  ) {
    super(message)
  }
}

export interface DocOptions {
  source: string
  eol?: 'LF' | 'CRLF'
  hasBom?: boolean
  readOnly?: ReasonCode | null
}

/** 一份文档的内存状态。与 Electron 无关，便于单元测试。 */
export class DocState {
  source: string
  version = 0
  eol: 'LF' | 'CRLF'
  hasBom: boolean
  readOnly: ReasonCode | null
  undo: UndoEntry[] = []
  redo: UndoEntry[] = []
  /** 保存点在 undo 栈中的位置；-1 表示保存点已不可达 */
  savedAt = 0
  parsed: ParsedDoc

  constructor(opts: DocOptions) {
    this.source = opts.source
    this.eol = opts.eol ?? 'LF'
    this.hasBom = opts.hasBom ?? false
    this.readOnly = opts.readOnly ?? null
    this.parsed = parseSource(this.source)
  }

  get elements(): ElementInfo[] {
    return this.parsed.elements
  }

  get dirty(): boolean {
    return this.undo.length !== this.savedAt
  }

  /** 应用一次提交的 op。返回压入（或合并进）撤销栈的那一项。 */
  commit(ops: SetSlotOp[], now = Date.now()): UndoEntry | null {
    if (this.readOnly) throw new EditError('READONLY', 'read only')
    const patches: Patch[] = []
    const inverseOps: SetSlotOp[] = []
    const realOps: SetSlotOp[] = []
    for (const op of ops) {
      const el = this.elements[op.eid]
      const slot = el?.slots[op.slot]
      if (!slot) throw new EditError('MISMATCH', `no slot ${op.eid}:${op.slot}`)
      if (slot.hasComment || slot.broken) throw new EditError('MISMATCH', 'comment in slot')
      if (slot.start === slot.end && op.newText !== '' && !slot.anchorOk) {
        throw new EditError('MISMATCH', 'empty slot without explicit anchor')
      }
      const pt = slotPatch(slot, op.newText)
      if (!pt) continue
      patches.push(pt)
      realOps.push(op)
      inverseOps.push({ eid: op.eid, slot: op.slot, newText: slot.text })
    }
    if (patches.length === 0) return null
    const before = this.source
    const { source, inverse } = applyPatches(before, patches)
    this.replaceSource(source, before)

    const key = realOps.length === 1 ? `${realOps[0].eid}:${realOps[0].slot}` : undefined
    const top = this.undo[this.undo.length - 1]
    if (key && top && top.coalesceKey === key && now - top.at <= COALESCE_MS && this.savedAt !== this.undo.length) {
      // 合并：以合并前的 source 为基准，重新求一段最小补丁
      const base = applyPatches(before, top.inverse).source
      const { forward, inverse: inv } = wholeDiff(base, source)
      const merged: UndoEntry = {
        forward: [forward],
        inverse: [inv],
        ops: realOps,
        inverseOps: top.inverseOps,
        coalesceKey: key,
        at: now
      }
      this.undo[this.undo.length - 1] = merged
      this.dropRedo(this.undo.length)
      return merged
    }
    const entry: UndoEntry = { forward: patches, inverse, ops: realOps, inverseOps, coalesceKey: key, at: now }
    this.dropRedo(this.undo.length)
    this.undo.push(entry)
    return entry
  }

  /** 新提交清空重做栈；保存点若在重做栈里，就再也回不去了。 */
  private dropRedo(prevLen: number): void {
    if (this.savedAt > prevLen) this.savedAt = -1
    this.redo = []
  }

  /** 撤销：返回需要同步到预览的 op（仅文字类；其他类见 undoSync）。 */
  undoOnce(): SetSlotOp[] | null {
    const r = this.undoSync()
    return r ? (r.kind === 'text' ? r.ops : []) : null
  }

  redoOnce(): SetSlotOp[] | null {
    const r = this.redoSync()
    return r ? (r.kind === 'text' ? r.ops : []) : null
  }

  undoSync(): PreviewSync | null {
    const entry = this.undo.pop()
    if (!entry) return null
    const before = this.source
    const prev = this.elements
    const { source } = applyPatches(this.source, entry.inverse)
    if (entry.kind === 'struct') this.replaceAny(source)
    else this.replaceSource(source, before)
    this.redo.push(entry)
    return this.syncFor(entry, entry.inverseOps, entry.inverse, { prev, prevSource: before, patches: entry.inverse })
  }

  redoSync(): PreviewSync | null {
    const entry = this.redo.pop()
    if (!entry) return null
    const before = this.source
    const prev = this.elements
    // forward 的坐标是撤销后（即应用前）的 source
    const { source, inverse } = applyPatches(this.source, entry.forward)
    if (entry.kind === 'struct') this.replaceAny(source)
    else this.replaceSource(source, before)
    this.undo.push(entry)
    return this.syncFor(entry, entry.ops, inverse, { prev, prevSource: before, patches: entry.forward })
  }

  private syncFor(entry: UndoEntry, ops: SetSlotOp[], applied: Patch[], from?: { prev: ElementInfo[]; prevSource: string; patches: Patch[] }): PreviewSync {
    if (entry.kind === 'struct') {
      return { kind: 'struct', select: this.elementAt(applied[0]?.start ?? -1), dom: from ? this.domSync(from.prev, from.prevSource, from.patches) : null }
    }
    if (entry.kind === 'attr') {
      return { kind: 'attr', attrs: (entry.attrs ?? []).map((a) => ({ ...a, value: this.elements[a.eid]?.attrs[a.name]?.value ?? null })) }
    }
    return { kind: 'text', ops }
  }

  /** 起始标签起点（或其后最近的空白之后）位于 at 的元素。 */
  elementAt(at: number): Eid | null {
    if (at < 0) return null
    let i = at
    while (i < this.source.length && /\s/.test(this.source[i])) i++
    const el = this.elements.find((e) => e.startTagStart === i)
    return el ? el.eid : null
  }

  /**
   * 结构与属性类操作（20.1）：换算为补丁、应用、校验结构变化是否符合预期、压入撤销栈。
   * 返回预览需要做的同步；无变化返回 null。
   */
  applyOp(op: StructOp, now = Date.now()): PreviewSync | null {
    if (this.readOnly) throw new EditError('READONLY', 'read only')
    let plan
    try {
      plan = planOp(this.source, this.elements, op)
    } catch (err) {
      if (err instanceof OpError) throw new EditError(err.code === 'NOOP' ? 'NOOP' : 'REJECTED', err.message)
      throw err
    }
    if (plan.patches.length === 0) return null
    const before = this.source
    const prevParsed = this.parsed
    const { source, inverse } = applyPatches(before, plan.patches)
    const kind: UndoEntry['kind'] = plan.attrs ? 'attr' : 'struct'
    const parsed = parseSource(source)
    if (!structureAsExpected(prevParsed, parsed, op.type === 'move' ? 'permute' : plan.countDelta)) {
      console.error('[twiq] unexpected structure change; rolled back', op.type)
      throw new EditError('STRUCTURE', 'structure changed')
    }
    this.source = source
    this.parsed = parsed
    this.version++
    // selectAt 已是新 source 中的坐标
    const select = plan.selectAt !== undefined ? this.elementAt(plan.selectAt) : null
    const key =
      op.type === 'setStyle'
        ? `style:${op.eid}:${Object.keys(op.props).sort().join(',')}`
        : op.type === 'setAttr'
          ? `attr:${op.eid}:${op.name}`
          : undefined
    const top = this.undo[this.undo.length - 1]
    if (key && top && top.coalesceKey === key && now - top.at <= COALESCE_MS && this.savedAt !== this.undo.length) {
      const base = applyPatches(before, top.inverse).source
      const { forward, inverse: inv } = wholeDiff(base, source)
      this.undo[this.undo.length - 1] = { ...top, forward: [forward], inverse: [inv], at: now }
      this.dropRedo(this.undo.length)
    } else {
      this.dropRedo(this.undo.length)
      this.undo.push({ forward: plan.patches, inverse, ops: [], inverseOps: [], coalesceKey: key, at: now, kind, attrs: plan.attrs })
    }
    if (kind === 'attr') return this.syncFor(this.undo[this.undo.length - 1], [], [])
    return { kind: 'struct', select, dom: this.domSync(prevParsed.elements, before, plan.patches) }
  }

  /** 结构变化的就地同步步骤；换算不可靠时返回 null（预览整页重载）。 */
  private domSync(prev: ElementInfo[], prevSource: string, patches: Patch[]): ReturnType<typeof planDomSync> {
    try {
      return planDomSync(prev, prevSource, patches, this.elements, this.source)
    } catch (err) {
      console.error('[twiq] dom sync plan failed', err)
      return null
    }
  }

  /** 结构类撤销重做：不做结构比较（结构本来就会变）。 */
  private replaceAny(next: string): void {
    this.source = next
    this.parsed = parseSource(next)
    this.version++
  }

  /**
   * 进入编辑时的期望校验（13.6）：host 内每个元素都带 data-hw，子元素序列与槽文字与源码一致，
   * 且没有夹注释的槽。返回 null 表示通过，否则返回原因代码。
   */
  validate(snap: Snapshot): ReasonCode | null {
    if (this.readOnly) return 'READONLY_FILE'
    const host = this.elements[snap.host]
    if (!host || !host.isHost) return 'MISMATCH'
    if (host.uneditableReason) return host.uneditableReason
    if (snap.foreign) return 'MISMATCH'
    const expected = this.hostMembers(host.eid)
    if (expected.length !== snap.elements.length) return 'MISMATCH'
    const byEid = new Map(snap.elements.map((e) => [e.eid, e]))
    for (const eid of expected) {
      const el = this.elements[eid]
      const got = byEid.get(eid)
      if (!got) return 'MISMATCH'
      if (got.children.length !== el.children.length || got.children.some((c, i) => c !== el.children[i])) return 'MISMATCH'
      if (got.hasComment.some(Boolean) || el.slots.some((x) => x.hasComment)) return 'COMMENT_IN_SLOT'
      if (got.slots.length !== el.slots.length || got.slots.some((t, i) => t !== el.slots[i].text)) return 'MISMATCH'
    }
    return null
  }

  /** host 及其非原子子孙的 eid（文档顺序）。 */
  hostMembers(hostEid: Eid): Eid[] {
    const out: Eid[] = []
    const walk = (eid: Eid): void => {
      out.push(eid)
      for (const c of this.elements[eid].children) if (!ATOMIC.has(this.elements[c].tag)) walk(c)
    }
    walk(hostEid)
    return out
  }

  /** 发给预览 preload 的元素表摘要。 */
  previewTable(): PreviewElement[] {
    const atomic = new Set<Eid>()
    for (const el of this.elements) {
      if (el.hostId === undefined || !ATOMIC.has(el.tag)) continue
      const stack = [el.eid]
      while (stack.length) {
        const cur = stack.pop()!
        atomic.add(cur)
        stack.push(...this.elements[cur].children)
      }
    }
    return this.elements.map((el) => {
      const inHost = el.isHost || el.hostId !== undefined
      const pe: PreviewElement = {
        eid: el.eid,
        tag: el.tag,
        host: el.isHost,
        hasText: el.slots.some((x) => slotHasText(x.text))
      }
      if (el.hostId !== undefined) pe.hostId = el.hostId
      const reason = this.readOnly ? (inHost || el.uneditableReason ? 'READONLY_FILE' : undefined) : el.uneditableReason
      if (reason) pe.reason = reason
      if (inHost && !atomic.has(el.eid)) pe.slots = el.slots.map((x) => x.text)
      // SVG 文字（v0.6）：选择模式里双击编辑，预览端用这份槽文字核对
      if ((el.tag === 'text' || el.tag === 'tspan') && this.inSvg(el)) pe.slots = el.slots.map((x) => x.text)
      if (atomic.has(el.eid)) pe.atomic = true
      if (el.rangeOk && el.tag !== 'html' && el.tag !== 'head' && el.tag !== 'body') pe.range = true
      return pe
    })
  }

  inSvg(el: ElementInfo): boolean {
    for (let p = el.parent; p !== null; p = this.elements[p].parent) if (this.elements[p].tag === 'svg') return true
    return false
  }

  /** SVG 文字（text、tspan）的槽改写（v0.6）：只允许 svg 内的这两种元素，其余同 commit。 */
  commitSvgText(eid: Eid, slots: string[]): UndoEntry | null {
    const el = this.elements[eid]
    if (!el || (el.tag !== 'text' && el.tag !== 'tspan') || !this.inSvg(el)) throw new EditError('MISMATCH', 'not svg text')
    if (slots.length !== el.slots.length) throw new EditError('STRUCTURE', 'slot count')
    return this.commit(slots.map((t, i) => ({ eid, slot: i, newText: t })).filter((o, i) => o.newText !== el.slots[i].text))
  }

  markSaved(): void {
    this.savedAt = this.undo.length
  }

  /** 重新载入磁盘版本：清空两个栈，保存点归零（13.9 第 6 条）。 */
  reload(opts: DocOptions): void {
    this.source = opts.source
    this.eol = opts.eol ?? 'LF'
    this.hasBom = opts.hasBom ?? false
    this.readOnly = opts.readOnly ?? null
    this.parsed = parseSource(this.source)
    this.version++
    this.undo = []
    this.redo = []
    this.savedAt = 0
  }

  /** 更新 source 并整份重新解析；结构变化时回滚（保险丝，13.7 第 8 条）。 */
  private replaceSource(next: string, prev: string): void {
    const parsed = parseSource(next)
    if (!sameStructure(this.parsed, parsed)) {
      this.source = prev
      console.error('[twiq] structure changed by text patch; rolled back')
      throw new EditError('STRUCTURE', 'structure changed')
    }
    this.source = next
    this.parsed = parsed
    this.version++
  }
}

/** 标签序列的公共前后缀长度。 */
function tagAffix(a: ElementInfo[], b: ElementInfo[]): number {
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a[p].tag === b[p].tag) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s].tag === b[b.length - 1 - s].tag) s++
  return p + s
}

/**
 * 结构变化是否符合预期：
 * 数字 0 → 结构完全不变；正数 → 恰好插入一段连续元素；负数 → 恰好删去一段连续元素；
 * permute → 元素数量与标签集合不变（移动）；any → 只要求能解析。
 */
export function structureAsExpected(a: ParsedDoc, b: ParsedDoc, delta: OpPlan['countDelta']): boolean {
  const x = a.elements
  const y = b.elements
  if (delta === 'any') return true
  if (typeof delta === 'object') {
    if ('count' in delta) return y.length === x.length + delta.count
    const { removed, added } = delta.replace
    if (y.length !== x.length - removed + added) return false
    // 区间外的元素原样保留：标签序列的公共前后缀覆盖区间外的全部元素
    return tagAffix(x, y) >= x.length - removed
  }
  if (delta === 0) return sameStructure(a, b)
  if (delta === 'permute') {
    if (x.length !== y.length) return false
    const count = (els: ElementInfo[]): string => els.map((e) => e.tag).sort().join(',')
    return count(x) === count(y)
  }
  if (y.length !== x.length + delta) return false
  return tagAffix(x, y) >= Math.min(x.length, y.length)
}

export function sameStructure(a: ParsedDoc, b: ParsedDoc): boolean {
  if (a.elements.length !== b.elements.length) return false
  for (let i = 0; i < a.elements.length; i++) {
    const x = a.elements[i]
    const y = b.elements[i]
    if (x.tag !== y.tag || x.children.length !== y.children.length) return false
    for (let j = 0; j < x.children.length; j++) if (x.children[j] !== y.children[j]) return false
  }
  return true
}
