// 导出 Markdown 与纯文本（规格 20.5）。基于 parse5 树，不依赖浏览器。
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'canvas', 'iframe', 'object', 'embed', 'select', 'textarea', 'button'])
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'body', 'html'
])

const isEl = (n: Node): n is Element => 'tagName' in n
const attr = (el: Element, name: string): string | null => el.attrs.find((a) => a.name === name)?.value ?? null
const squash = (s: string): string => s.replace(/[ \t\n\f\r]+/g, ' ')

function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]#|])/g, '\\$1').replace(/^(\d+)\. /, '$1\\. ').replace(/^([-+>]) /, '\\$1 ')
}

/** 行内内容（Markdown）。 */
function inlineMd(nodes: Node[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.nodeName === '#text') out += mdEscape(squash((n as DefaultTreeAdapterMap['textNode']).value))
    if (!isEl(n) || SKIP.has(n.tagName)) continue
    const inner = (): string => inlineMd(n.childNodes)
    switch (n.tagName) {
      case 'strong':
      case 'b':
        out += wrapMark(inner(), '**')
        break
      case 'em':
      case 'i':
        out += wrapMark(inner(), '*')
        break
      case 's':
      case 'del':
      case 'strike':
        out += wrapMark(inner(), '~~')
        break
      case 'code':
        out += `\`${textOf(n).replace(/`/g, '\\`')}\``
        break
      case 'br':
        out += '  \n'
        break
      case 'a': {
        const href = attr(n, 'href')
        const t = inner()
        out += href && !href.startsWith('javascript:') ? `[${t}](${href.replace(/\)/g, '%29').replace(/ /g, '%20')})` : t
        break
      }
      case 'img': {
        const src = attr(n, 'src')
        if (src) out += `![${mdEscape(attr(n, 'alt') ?? '')}](${src.replace(/ /g, '%20')})`
        break
      }
      default:
        out += BLOCK.has(n.tagName) ? ` ${inner()} ` : inner()
    }
  }
  return out
}

function wrapMark(s: string, m: string): string {
  const t = s.trim()
  if (!t) return s
  const lead = s.match(/^\s*/)![0]
  const tail = s.match(/\s*$/)![0]
  return `${lead}${m}${t}${m}${tail}`
}

function textOf(n: Node): string {
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value
  if (!isEl(n) || SKIP.has(n.tagName)) return ''
  return n.childNodes.map(textOf).join('')
}

/** 只含行内内容的子节点段：遇到块级子元素就切开。 */
function blocks(el: Element, md: boolean, depth: number, out: string[]): void {
  let run: Node[] = []
  const flush = (): void => {
    const t = (md ? inlineMd(run) : squash(run.map(textOf).join(''))).trim()
    if (t) out.push(t)
    run = []
  }
  for (const c of el.childNodes) {
    if (isEl(c) && SKIP.has(c.tagName)) continue
    if (isEl(c) && BLOCK.has(c.tagName)) {
      flush()
      block(c, md, depth, out)
    } else run.push(c)
  }
  flush()
}

function block(el: Element, md: boolean, depth: number, out: string[]): void {
  const tag = el.tagName
  const inline = (): string => (md ? inlineMd(el.childNodes) : squash(textOf(el))).trim()
  if (/^h[1-6]$/.test(tag)) {
    const t = inline()
    if (t) out.push(md ? `${'#'.repeat(Number(tag[1]))} ${t}` : t)
    return
  }
  if (tag === 'hr') {
    if (md) out.push('---')
    return
  }
  if (tag === 'pre') {
    const t = textOf(el).replace(/\n$/, '')
    out.push(md ? `\`\`\`\n${t}\n\`\`\`` : t)
    return
  }
  if (tag === 'ul' || tag === 'ol') {
    const items: string[] = []
    let i = 1
    for (const li of el.childNodes) {
      if (!isEl(li) || li.tagName !== 'li') continue
      const sub: string[] = []
      blocks(li, md, depth + 1, sub)
      const bullet = md ? (tag === 'ol' ? `${i++}. ` : '- ') : tag === 'ol' ? `${i++}. ` : '· '
      const pad = '  '.repeat(depth)
      const [first = '', ...rest] = sub
      items.push(`${pad}${bullet}${first}${rest.length ? `\n${rest.map((r) => (r.startsWith('  ') || /^(-|\d+\.|·) /.test(r) ? r : `${pad}  ${r}`)).join('\n')}` : ''}`)
    }
    if (items.length) out.push(items.join('\n'))
    return
  }
  if (tag === 'blockquote') {
    const sub: string[] = []
    blocks(el, md, depth, sub)
    if (sub.length) out.push(md ? sub.map((s) => s.split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n') : sub.join('\n'))
    return
  }
  if (tag === 'table') {
    const rows: string[][] = []
    const walk = (n: Element): void => {
      for (const c of n.childNodes) {
        if (!isEl(c)) continue
        if (c.tagName === 'tr') {
          rows.push(c.childNodes.filter((x): x is Element => isEl(x) && (x.tagName === 'td' || x.tagName === 'th')).map((x) => (md ? inlineMd(x.childNodes) : squash(textOf(x))).trim().replace(/\|/g, '\\|')))
        } else if (['thead', 'tbody', 'tfoot'].includes(c.tagName)) walk(c)
      }
    }
    walk(el)
    if (!rows.length) return
    if (!md) {
      out.push(rows.map((r) => r.join('\t')).join('\n'))
      return
    }
    const w = Math.max(...rows.map((r) => r.length))
    const line = (r: string[]): string => `| ${Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ')} |`
    out.push([line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n'))
    return
  }
  blocks(el, md, depth, out)
}

export function htmlToText(source: string, format: 'md' | 'txt'): string {
  const doc = parse(source)
  const html = doc.childNodes.find(isEl)
  const body = html?.childNodes.find((n): n is Element => isEl(n) && n.tagName === 'body')
  if (!body) return ''
  const out: string[] = []
  blocks(body, format === 'md', 0, out)
  return `${out.join('\n\n')}\n`
}
