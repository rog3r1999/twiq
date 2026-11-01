// 源码编辑器的语法着色（v0.10）：把 HTML 原文切成带种类的片段。
// 只为显示：切出的片段按顺序拼起来必须与原文一字不差（着色层与输入框逐字对齐，靠的就是这一点）。

export type TokenKind = 'text' | 'tag' | 'attr' | 'value' | 'comment' | 'punct'

export interface Token {
  k: TokenKind
  s: string
}

const NAME = /^[A-Za-z][^\s/>]*/

/** 标签内部：属性名、=、值、空白、/ 与 > */
function tagInner(src: string, i: number, out: Token[]): number {
  while (i < src.length) {
    const c = src[i]
    if (c === '>') {
      out.push({ k: 'punct', s: '>' })
      return i + 1
    }
    if (c === '/' || /\s/.test(c)) {
      let j = i + 1
      while (j < src.length && (src[j] === '/' || /\s/.test(src[j]))) j++
      out.push({ k: 'punct', s: src.slice(i, j) })
      i = j
      continue
    }
    if (c === '=') {
      out.push({ k: 'punct', s: '=' })
      i++
      const q = src[i]
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, i + 1)
        const j = end < 0 ? src.length : end + 1
        out.push({ k: 'value', s: src.slice(i, j) })
        i = j
      } else {
        let j = i
        while (j < src.length && !/[\s>]/.test(src[j])) j++
        if (j > i) out.push({ k: 'value', s: src.slice(i, j) })
        i = j
      }
      continue
    }
    let j = i
    while (j < src.length && !/[\s=>/]/.test(src[j])) j++
    if (j === i) j++
    out.push({ k: 'attr', s: src.slice(i, j) })
    i = j
  }
  return i
}

export function tokenizeHtml(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let text = 0
  const flush = (to: number): void => {
    if (to > text) out.push({ k: 'text', s: src.slice(text, to) })
  }
  while (i < src.length) {
    if (src[i] !== '<') {
      i++
      continue
    }
    if (src.startsWith('<!--', i)) {
      flush(i)
      const end = src.indexOf('-->', i + 4)
      const j = end < 0 ? src.length : end + 3
      out.push({ k: 'comment', s: src.slice(i, j) })
      i = text = j
      continue
    }
    const close = src[i + 1] === '/'
    const m = NAME.exec(src.slice(i + (close ? 2 : 1), i + (close ? 2 : 1) + 64))
    if (!m) {
      i++
      continue
    }
    flush(i)
    out.push({ k: 'punct', s: close ? '</' : '<' })
    out.push({ k: 'tag', s: m[0] })
    i = tagInner(src, i + (close ? 2 : 1) + m[0].length, out)
    text = i
  }
  flush(src.length)
  return out
}
