// 本次改动（v0.10）：上次保存（或打开）时的源码与当前源码逐字比较，列出每一处改动。
// 让「保存时只改动被改的字符」这件事在界面上看得见。纯函数，不依赖 Electron。
//
// 做法：整份按行做 patience 差分（去掉首尾相同的行后，以两边都只出现一次的行为锚点，锚点之间再用 Myers），
// 得到行级的改动块，纯插入或纯删除的块再滑到元素边界上。HTML 里大量重复的行（</div>、<div class="card">）会让纯 Myers 把「挪动一张卡片」
// 报成几处标题互换；以唯一行为锚点就能认出整块的删除与插入；
// 每块再收缩到真正不同的字符（行数相同时逐行收缩，一行一处）；最后把内容相同的「删一块 + 插一块」认作移动。
import type { ChangeSummary } from '../shared/types'
import { tokenizeHtml } from '../shared/html-tokens'

export type ChangeKind = 'replace' | 'insert' | 'delete' | 'move'

export interface Change {
  kind: ChangeKind
  /** 在上次保存的源码里的位置（移动：原来的位置） */
  baseStart: number
  baseEnd: number
  /** 在当前源码里的位置（删除：被删处，长度为 0；移动：新位置） */
  curStart: number
  curEnd: number
  before: string
  after: string
}

/**
 * 统计：count 为改动处数（一次移动算一处）；removed 为原文中被删除或替换掉的字符数、added 为新写入的字符数（都不含移动）；
 * moved 为移动的字符数；untouched 为原文中位置与内容都没变的字符数；total 为原文总字符数。
 */
export type { ChangeSummary }

/** 行级差分的编辑距离上限：超过就把这一段当作一整块（极端情况下不卡住主进程） */
const MAX_D = 4000
/** Myers 每走一步都要留一份 V（长 n+m）供回溯：总共最多留这么多个格子（约 16MB），超过就当作一整块 */
const MYERS_CELLS = 4_000_000
/** 认作「移动」的最短长度：太短的相同片段（如一个标签名）多半是巧合 */
const MOVE_MIN = 16

/** 超过这个长度的行再在每个 > 之后切开：压缩成一行的 HTML 里，相隔很远的两处改动不会连成一整块 */
const LONG_LINE = 1000

function splitLines(s: string): string[] {
  const out: string[] = []
  const push = (line: string): void => {
    if (line.length <= LONG_LINE) return void out.push(line)
    let i = 0
    for (let j = line.indexOf('>'); j >= 0; j = line.indexOf('>', j + 1)) {
      out.push(line.slice(i, j + 1))
      i = j + 1
    }
    if (i < line.length) out.push(line.slice(i))
  }
  let i = 0
  while (i < s.length) {
    const j = s.indexOf('\n', i)
    if (j < 0) {
      push(s.slice(i))
      break
    }
    push(s.slice(i, j + 1))
    i = j + 1
  }
  return out
}

/** Myers O(ND) 差分，返回不相等的区段：[a 起, a 止, b 起, b 止)（行下标）。超过上限返回 null。 */
function myers(a: string[], b: string[]): Hunk[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  const limit = Math.min(max, MAX_D, Math.floor(MYERS_CELLS / v.length))
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) return null
  // 回溯出逐步的编辑，再合并成区段
  const ops: ('=' | '-' | '+')[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const vv = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1
    const prevX = vv[off + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('=')
      x--
      y--
    }
    if (x === prevX) {
      ops.push('+')
      y--
    } else {
      ops.push('-')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('=')
    x--
    y--
  }
  ops.reverse()
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let cur: Hunk | null = null
  for (const op of ops) {
    if (op === '=') {
      if (cur) hunks.push(cur)
      cur = null
      i++
      j++
      continue
    }
    if (!cur) cur = [i, i, j, j]
    if (op === '-') cur[1] = ++i
    else cur[3] = ++j
  }
  if (cur) hunks.push(cur)
  return hunks
}

type Hunk = [number, number, number, number]

/** patience 差分：在 a[a0,a1) 与 b[b0,b1) 之间找改动区段（行下标）。没有唯一行可做锚点时交给 Myers。 */
function patience(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, out: Hunk[]): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    a0++
    b0++
  }
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
    a1--
    b1--
  }
  if (a0 === a1 && b0 === b1) return
  if (a0 === a1 || b0 === b1) {
    out.push([a0, a1, b0, b1])
    return
  }
  // 两边都恰好出现一次的行
  const count = new Map<string, { a: number; b: number; ai: number; bi: number }>()
  for (let i = a0; i < a1; i++) {
    const c = count.get(a[i]) ?? { a: 0, b: 0, ai: i, bi: -1 }
    c.a++
    c.ai = i
    count.set(a[i], c)
  }
  for (let j = b0; j < b1; j++) {
    const c = count.get(b[j])
    if (!c) continue
    c.b++
    c.bi = j
  }
  const pairs: [number, number][] = []
  for (const c of count.values()) if (c.a === 1 && c.b === 1) pairs.push([c.ai, c.bi])
  if (!pairs.length) {
    const sub = myers(a.slice(a0, a1), b.slice(b0, b1)) ?? [[0, a1 - a0, 0, b1 - b0]]
    for (const [i0, i1, j0, j1] of sub) out.push([a0 + i0, a0 + i1, b0 + j0, b0 + j1])
    return
  }
  // 按 a 的顺序排好，取 b 下标的最长递增子序列作锚点
  pairs.sort((x, y) => x[0] - y[0])
  const tails: number[] = []
  const prev = new Int32Array(pairs.length).fill(-1)
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[k] = tails[lo - 1]
    tails[lo] = k
  }
  const anchors: [number, number][] = []
  for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) anchors.push(pairs[k])
  anchors.reverse()
  let pa = a0
  let pb = b0
  for (const [ai, bi] of anchors) {
    patience(a, b, pa, ai, pb, bi, out)
    pa = ai + 1
    pb = bi + 1
  }
  patience(a, b, pa, a1, pb, b1, out)
}

const indent = (l: string | undefined): number => (l === undefined || !l.trim() ? 0 : l.length - l.trimStart().length)

/**
 * 纯插入或纯删除的一块，在重复的行之间可以上下滑动而结果不变（「复制一张卡片」可以报成从任何一行开始）。
 * 像 git 的缩进启发一样，滑到首尾两行缩进最浅的位置：块的边界落在元素的开始与结束标签上，
 * 读起来是一个完整的元素，删除与插入的两块也才能对上认作移动。
 */
function slide(hunks: Hunk[], a: string[], b: string[]): void {
  hunks.sort((x, y) => x[0] - y[0] || x[2] - y[2])
  for (let h = 0; h < hunks.length; h++) {
    const k = hunks[h]
    const ins = k[0] === k[1]
    const del = k[2] === k[3]
    if (ins === del) continue
    const lines = ins ? b : a
    const [s0, s1] = ins ? [2, 3] : [0, 1]
    // 不能越过相邻的改动块
    const lo = h > 0 ? hunks[h - 1][s1] : 0
    const hi = h + 1 < hunks.length ? hunks[h + 1][s0] : lines.length
    const score = (st: number, en: number): number => indent(lines[st]) + indent(lines[en - 1])
    let best = 0
    let bestScore = score(k[s0], k[s1])
    for (let d = -1; k[s0] + d >= lo && lines[k[s0] + d] === lines[k[s1] + d]; d--) {
      const sc = score(k[s0] + d, k[s1] + d)
      if (sc < bestScore) [best, bestScore] = [d, sc]
    }
    for (let d = 1; k[s1] + d - 1 < hi && lines[k[s0] + d - 1] === lines[k[s1] + d - 1]; d++) {
      const sc = score(k[s0] + d, k[s1] + d)
      if (sc < bestScore) [best, bestScore] = [d, sc]
    }
    // 另一边是空的，跟着一起移动同样的行数
    for (let i = 0; i < 4; i++) k[i] += best
  }
}

/** 一段替换收缩到真正不同的字符；完全相同返回 null */
function shrink(base: string, cur: string, bs: number, be: number, cs: number, ce: number): Change | null {
  while (bs < be && cs < ce && base[bs] === cur[cs]) {
    bs++
    cs++
  }
  while (be > bs && ce > cs && base[be - 1] === cur[ce - 1]) {
    be--
    ce--
  }
  if (bs === be && cs === ce) return null
  const kind: ChangeKind = bs === be ? 'insert' : cs === ce ? 'delete' : 'replace'
  return { kind, baseStart: bs, baseEnd: be, curStart: cs, curEnd: ce, before: base.slice(bs, be), after: cur.slice(cs, ce) }
}

export function diffChanges(base: string, cur: string): Change[] {
  if (base === cur) return []
  // 整份按行比较（patience 先去掉首尾相同的行）；不先按字符截掉公共前后缀，
  // 否则改动块紧挨着的那几行不在比较范围里，下面的滑动就找不到元素的边界
  const aLines = splitLines(base)
  const bLines = splitLines(cur)
  const hunks: Hunk[] = []
  patience(aLines, bLines, 0, aLines.length, 0, bLines.length, hunks)
  slide(hunks, aLines, bLines)
  // 行下标 → 字符偏移
  const offsets = (lines: string[]): number[] => {
    const o = [0]
    for (const l of lines) o.push(o[o.length - 1] + l.length)
    return o
  }
  const ao = offsets(aLines)
  const bo = offsets(bLines)
  const out: Change[] = []
  for (const [i0, i1, j0, j1] of hunks) {
    // 行数相同：逐行收缩，一行一处（两行各改一个词时不会连成一大块）
    if (i1 - i0 === j1 - j0 && i1 - i0 <= 200) {
      for (let k = 0; k < i1 - i0; k++) {
        const c = shrink(base, cur, ao[i0 + k], ao[i0 + k + 1], bo[j0 + k], bo[j0 + k + 1])
        if (c) out.push(c)
      }
    } else {
      const c = shrink(base, cur, ao[i0], ao[i1], bo[j0], bo[j1])
      if (c) out.push(c)
    }
  }
  return pairMoves(out)
}

/** 删除的一块与插入的一块内容相同（忽略首尾空白）：合成一处「移动」 */
function pairMoves(list: Change[]): Change[] {
  const used = new Set<Change>()
  const result: Change[] = []
  for (const d of list) {
    if (used.has(d)) continue
    if (d.kind === 'delete' && d.before.trim().length >= MOVE_MIN) {
      const ins = list.find((c) => c.kind === 'insert' && !used.has(c) && c.after.trim() === d.before.trim())
      if (ins) {
        used.add(ins)
        result.push({ kind: 'move', baseStart: d.baseStart, baseEnd: d.baseEnd, curStart: ins.curStart, curEnd: ins.curEnd, before: d.before, after: ins.after })
        continue
      }
    }
    if (d.kind === 'insert' && d.after.trim().length >= MOVE_MIN) {
      const del = list.find((c) => c.kind === 'delete' && !used.has(c) && c.before.trim() === d.after.trim())
      if (del) {
        used.add(del)
        result.push({ kind: 'move', baseStart: del.baseStart, baseEnd: del.baseEnd, curStart: d.curStart, curEnd: d.curEnd, before: del.before, after: d.after })
        continue
      }
    }
    result.push(d)
  }
  return result.sort((x, y) => x.curStart - y.curStart)
}

export function summarize(base: string, changes: Change[]): ChangeSummary {
  let removed = 0
  let added = 0
  let moved = 0
  for (const c of changes) {
    if (c.kind === 'move') moved += c.baseEnd - c.baseStart
    else {
      removed += c.baseEnd - c.baseStart
      added += c.curEnd - c.curStart
    }
  }
  return { count: changes.length, removed, added, moved, untouched: base.length - removed - moved, total: base.length }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/**
 * 片段里的标签是否成对：每个开始标签（空元素、自闭合除外）都有对应的结束标签，结束标签不早于开始标签。
 * 纯文字、属性值、完整的元素都成对；只含 <div> 或只含 </div> 的不成对。
 */
export function balanced(s: string): boolean {
  if (!s.includes('<')) return true
  const toks = tokenizeHtml(s)
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.k !== 'punct' || (t.s !== '<' && t.s !== '</') || toks[i + 1]?.k !== 'tag') continue
    const name = toks[i + 1].s.toLowerCase()
    if (t.s === '</') {
      if (--depth < 0) return false
      continue
    }
    // 找到这个标签的 >：前面紧挨着 / 就是自闭合
    let j = i + 2
    while (j < toks.length && !(toks[j].k === 'punct' && toks[j].s === '>')) j++
    const selfClosing = /\/\s*$/.test(toks[j - 1]?.k === 'punct' ? toks[j - 1].s : '')
    if (!VOID.has(name) && !selfClosing) depth++
  }
  return depth === 0
}

/** 这一处能不能单独撤回：移动不行（原位置在当前源码里已经变了）；只换回半个标签对会让后面的元素被吞进去，也不行 */
export function canRevert(c: Change): boolean {
  return c.kind !== 'move' && balanced(c.before) && balanced(c.after)
}

/** 撤回其中一处：在当前源码上把这一处换回原文，其余改动保留；不能单独撤回时返回 null */
export function revertOne(cur: string, c: Change): string | null {
  if (!canRevert(c)) return null
  return cur.slice(0, c.curStart) + c.before + cur.slice(c.curEnd)
}
