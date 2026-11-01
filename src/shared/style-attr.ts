// style 属性的声明级编辑（规格 20.3）：只改目标声明，保持其他声明与顺序。
// 纯字符串处理，与 DOM 无关。

interface Decl {
  /** 声明在字符串中的起止（含末尾分号，不含其后的空白） */
  start: number
  end: number
  prop: string // 小写属性名
  valueStart: number
  valueEnd: number
}

/** 按顶层分号切分声明；括号与引号内的分号不算。 */
export function parseDecls(css: string): Decl[] {
  const out: Decl[] = []
  let i = 0
  const n = css.length
  while (i < n) {
    while (i < n && /[\s;]/.test(css[i])) i++
    if (i >= n) break
    const start = i
    let depth = 0
    let quote: string | null = null
    let colon = -1
    while (i < n) {
      const c = css[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (c === ':' && colon < 0 && depth === 0) colon = i
      else if (c === ';' && depth === 0) break
      i++
    }
    const semi = i < n
    const bodyEnd = i
    if (semi) i++
    if (colon < 0) continue
    let vs = colon + 1
    while (vs < bodyEnd && /\s/.test(css[vs])) vs++
    let ve = bodyEnd
    while (ve > vs && /\s/.test(css[ve - 1])) ve--
    out.push({
      start,
      end: semi ? i : bodyEnd,
      prop: css.slice(start, colon).trim().toLowerCase(),
      valueStart: vs,
      valueEnd: ve
    })
  }
  return out
}

export function getDecl(css: string, prop: string): string | null {
  const d = parseDecls(css).filter((x) => x.prop === prop).pop()
  return d ? css.slice(d.valueStart, d.valueEnd) : null
}

/** 设置或删除一条声明；value 为 null 表示删除（同名声明全部删除）。 */
export function setDecl(css: string, prop: string, value: string | null): string {
  prop = prop.toLowerCase()
  const decls = parseDecls(css)
  const same = decls.filter((d) => d.prop === prop)
  if (value === null) {
    let out = css
    for (const d of [...same].reverse()) {
      // 连同其后的空白一起删
      let e = d.end
      while (e < out.length && /\s/.test(out[e])) e++
      out = out.slice(0, d.start) + out.slice(e)
    }
    return out.trim() === '' ? '' : out.replace(/\s+$/, (m) => (css.endsWith(m) ? m : ''))
  }
  const last = same[same.length - 1]
  if (last) return css.slice(0, last.valueStart) + value + css.slice(last.valueEnd)
  const body = css.replace(/\s+$/, '')
  if (body === '') return `${prop}: ${value}`
  const sep = body.endsWith(';') ? ' ' : '; '
  return `${body}${sep}${prop}: ${value}${css.slice(body.length)}`
}

export function setDecls(css: string, props: Record<string, string | null>): string {
  let out = css
  for (const [k, v] of Object.entries(props)) out = setDecl(out, k, v)
  return out
}
