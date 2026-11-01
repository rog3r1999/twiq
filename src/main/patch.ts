// op 到补丁、实体 token 化、最小 diff、逆补丁（规格 13.7）。
// 补丁引擎与 op 无关：只处理区间替换与逆补丁（20.6）。
import { decodeHTMLStrict } from 'entities'
import type { Patch, SlotInfo, Token } from '../shared/types'

const ENTITY = /&(?:#[0-9]+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)/y

export let warn: (msg: string) => void = (msg) => console.warn(msg)
export function setWarn(fn: (msg: string) => void): void {
  warn = fn
}

/**
 * 把槽原文切成顺序 token：普通字符每个 UTF-16 单元一个，字符实体整体一个。
 * 自检失败（例如无分号的旧式实体）时退化为整槽一个 token。
 */
export function tokenize(raw: string, expected: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < raw.length) {
    if (raw.charCodeAt(i) === 0x26 /* & */) {
      ENTITY.lastIndex = i
      const m = ENTITY.exec(raw)
      if (m) {
        const decoded = decodeHTMLStrict(m[0])
        if (decoded !== m[0]) {
          tokens.push({ rawStart: i, rawEnd: i + m[0].length, decoded })
          i += m[0].length
          continue
        }
      }
    }
    tokens.push({ rawStart: i, rawEnd: i + 1, decoded: raw[i] })
    i++
  }
  if (tokens.map((t) => t.decoded).join('') !== expected) {
    if (raw.length > 0 || expected.length > 0) {
      warn(`tokenize fallback: ${JSON.stringify(raw.slice(0, 40))}`)
    }
    return raw.length || expected.length ? [{ rawStart: 0, rawEnd: raw.length, decoded: expected }] : []
  }
  return tokens
}

export function escapeText(text: string): string {
  return text.replace(/[&<>\u00a0]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&nbsp;'))
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/** 公共前缀与后缀长度，切点对齐代理对边界，后缀不与前缀重叠。 */
export function commonAffix(a: string, b: string): { p: number; s: number } {
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++
  // 前缀停在高位代理之后，说明把一个字符切成了两半
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--
  let s = 0
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++
  // 后缀从低位代理开始，同理
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--
  return { p, s }
}

/** 把一个槽的新文字换算成对 source 的最小补丁；无变化返回 null。 */
export function slotPatch(slot: SlotInfo, nw: string): Patch | null {
  const old = slot.text
  if (old === nw) return null
  const { p, s } = commonAffix(old, nw)
  const e = old.length - s
  // token 的解码起点
  const decStarts: number[] = []
  let acc = 0
  for (const t of slot.tokens) {
    decStarts.push(acc)
    acc += t.decoded.length
  }
  // 起点向左对齐到 token 边界
  let ti = slot.tokens.length
  for (let i = 0; i < slot.tokens.length; i++) {
    if (decStarts[i] <= p && p < decStarts[i] + slot.tokens[i].decoded.length) {
      ti = i
      break
    }
  }
  const leftDec = ti < slot.tokens.length ? decStarts[ti] : old.length
  const leftRaw = ti < slot.tokens.length ? slot.tokens[ti].rawStart : slot.raw.length
  // 终点向右对齐到 token 边界
  let rightDec = 0
  let rightRaw = 0
  if (e > 0) {
    for (let i = 0; i < slot.tokens.length; i++) {
      const end = decStarts[i] + slot.tokens[i].decoded.length
      if (decStarts[i] < e && e <= end) {
        rightDec = end
        rightRaw = slot.tokens[i].rawEnd
        break
      }
    }
  }
  if (rightRaw < leftRaw) {
    // 纯插入且恰好落在 token 边界
    rightRaw = leftRaw
    rightDec = leftDec
  }
  const fragment = old.slice(leftDec, p) + nw.slice(p, nw.length - s) + old.slice(e, rightDec)
  return { start: slot.start + leftRaw, end: slot.start + rightRaw, text: escapeText(fragment) }
}

/**
 * 应用一组互不重叠的补丁，返回新 source 与逆补丁（坐标为应用后的 source）。
 */
export function applyPatches(source: string, patches: Patch[]): { source: string; inverse: Patch[] } {
  const sorted = [...patches].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new Error('overlapping patches')
  }
  const parts: string[] = []
  const inverse: Patch[] = []
  let cursor = 0
  let delta = 0
  for (const pt of sorted) {
    parts.push(source.slice(cursor, pt.start), pt.text)
    const start = pt.start + delta
    inverse.push({ start, end: start + pt.text.length, text: source.slice(pt.start, pt.end) })
    delta += pt.text.length - (pt.end - pt.start)
    cursor = pt.end
  }
  parts.push(source.slice(cursor))
  return { source: parts.join(''), inverse }
}

/** 两份 source 之间的单段最小补丁（用于合并撤销项）。 */
export function wholeDiff(a: string, b: string): { forward: Patch; inverse: Patch } {
  const { p, s } = commonAffix(a, b)
  return {
    forward: { start: p, end: a.length - s, text: b.slice(p, b.length - s) },
    inverse: { start: p, end: b.length - s, text: a.slice(p, a.length - s) }
  }
}
