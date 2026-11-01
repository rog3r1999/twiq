// SVG 文字编辑（v0.6 拆解第 10 条）：SVG 元素不支持 contenteditable，
// 在 <text> / <tspan> 的屏幕位置上盖一个输入框，输入时实时改预览，提交时写回文字槽。
import { ipcRenderer } from 'electron'
import type { Eid } from '../shared/types'
import { eidOf, slotNodes } from './dom'
import { REASONS, TOAST } from '../shared/messages'
import { S } from './strings'

export interface SvgTextCtx {
  tabId(): string
  root(): ShadowRoot | HTMLElement
  /** 槽文字与源码不一致（脚本改过）时给出提示；写入失败才是 error */
  refuse(el: Element, text: string, sub?: string, level?: 'warn' | 'error'): void
  done(el: SVGElement): void
  expected(eid: Eid): string[] | undefined
}

let active: { el: SVGElement; input: HTMLInputElement; before: string[]; slot: number; cleanup: () => void } | null = null

function texts(el: Element): string[] {
  return slotNodes(el).map((nodes) => nodes.filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => (n as Text).data).join(''))
}

/** 把元素第 slot 个槽的文字改成 t（就地改文本节点，保持 tspan 等子元素）。 */
function setSlot(el: Element, slot: number, t: string): void {
  const nodes = slotNodes(el)[slot]
  if (!nodes) return
  const textNodes = nodes.filter((n) => n.nodeType === Node.TEXT_NODE) as Text[]
  if (textNodes.length) {
    textNodes[0].data = t
    for (const n of textNodes.slice(1)) n.remove()
  } else if (t) {
    const bound = Array.from(el.children).filter((c) => eidOf(c) !== null)[slot] ?? null
    el.insertBefore(document.createTextNode(t), bound)
  }
}

/** 选一个要编辑的槽：文字最多的那个（普通 <text>xx</text> 只有一个槽）。 */
function mainSlot(t: string[]): number {
  let best = 0
  for (let i = 1; i < t.length; i++) if (t[i].trim().length > t[best].trim().length) best = i
  return best
}

export function editing(): boolean {
  return !!active
}

export function start(el: SVGElement, c: SvgTextCtx): void {
  void finish(c, true)
  const eid = eidOf(el)
  if (eid === null) return
  const before = texts(el)
  const expected = c.expected(eid)
  if (!expected || expected.length !== before.length || expected.some((t, i) => t !== before[i])) {
    c.refuse(el, REASONS.MISMATCH[0], REASONS.MISMATCH[1])
    return
  }
  const slot = mainSlot(before)
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const input = document.createElement('input')
  input.className = 'svg-text-input'
  input.setAttribute('aria-label', S.svgText)
  input.value = before[slot]
  // 字号按屏幕上的实际高度（viewBox 缩放后），最少 12px
  const fs = Math.max(12, Math.round(r.height * 0.8))
  Object.assign(input.style, {
    left: `${r.left - 4}px`,
    top: `${r.top + r.height / 2 - (fs + 10) / 2}px`,
    width: `${Math.max(80, r.width + 40)}px`,
    fontSize: `${fs}px`,
    fontFamily: cs.fontFamily
  })
  const onInput = (): void => setSlot(el, slot, input.value)
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation()
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void finish(c, true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void finish(c, false)
    }
  }
  const onBlur = (): void => void finish(c, true)
  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKey)
  input.addEventListener('blur', onBlur)
  c.root().appendChild(input)
  active = {
    el,
    input,
    before,
    slot,
    cleanup: () => {
      input.removeEventListener('input', onInput)
      input.removeEventListener('keydown', onKey)
      input.removeEventListener('blur', onBlur)
      input.remove()
    }
  }
  input.focus()
  input.select()
}

/** 结束编辑：keep 为 true 时提交（无变化则不提交），否则恢复原文。 */
export function finish(c: SvgTextCtx, keep: boolean): Promise<void> {
  const a = active
  if (!a) return Promise.resolve()
  active = null
  a.cleanup()
  const now = texts(a.el)
  const changed = now.some((t, i) => t !== a.before[i])
  if (!keep || !changed) {
    a.before.forEach((t, i) => setSlot(a.el, i, t))
    c.done(a.el)
    return Promise.resolve()
  }
  return (ipcRenderer.invoke('svg:text', { tabId: c.tabId(), eid: eidOf(a.el), slots: now }) as Promise<{ ok: boolean }>).then((r) => {
    if (!r?.ok) {
      a.before.forEach((t, i) => setSlot(a.el, i, t))
      c.refuse(a.el, TOAST.commitFailed, undefined, 'error')
    }
    c.done(a.el)
  })
}
