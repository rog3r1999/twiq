import { describe, expect, it } from 'vitest'
import { decodeFile, encodeFile, parseSource } from '../../src/main/parse'

const byTag = (src: string, tag: string, n = 0) => parseSource(src).elements.filter((e) => e.tag === tag)[n]

describe('U-02 parse：eid', () => {
  it('按文档顺序编号，隐含元素不分配 eid', () => {
    const { elements } = parseSource('<p>a<b>b</b></p><div><span>c</span></div>')
    expect(elements.map((e) => e.tag)).toEqual(['p', 'b', 'div', 'span'])
    expect(elements.map((e) => e.eid)).toEqual([0, 1, 2, 3])
    expect(elements[0].parent).toBeNull()
    expect(elements[1].parent).toBe(0)
  })
  it('显式写出的 html/body 分配 eid', () => {
    const { elements } = parseSource('<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>')
    expect(elements.map((e) => e.tag)).toEqual(['html', 'head', 'title', 'body', 'p'])
  })
  it('隐含 tbody：tr 的 parent 为 null，table 标记 hasImpliedChild', () => {
    const { elements } = parseSource('<table><tr><td>x</td></tr></table>')
    expect(elements.map((e) => e.tag)).toEqual(['table', 'tr', 'td'])
    expect(elements[1].parent).toBeNull()
    expect(elements[0].hasImpliedChild).toBe(true)
  })
  it('多次解析编号一致', () => {
    const src = '<main><h1>T</h1><ul><li>a<li>b</ul></main>'
    const a = parseSource(src).elements.map((e) => [e.eid, e.tag, e.children])
    const b = parseSource(src).elements.map((e) => [e.eid, e.tag, e.children])
    expect(a).toEqual(b)
  })
  it('记录标签名原文长度（大小写、自闭合）', () => {
    const { elements } = parseSource('<P>x<BR/>y</P>')
    expect(elements[0].tagNameLength).toBe(1)
    expect(elements[1].tag).toBe('br')
  })
})

describe('U-03 槽划分', () => {
  it('无子元素：只有槽 0', () => {
    const p = byTag('<p>hello</p>', 'p')
    expect(p.slots).toHaveLength(1)
    expect(p.slots[0]).toMatchObject({ start: 3, end: 8, text: 'hello' })
  })
  it('甲<b>乙</b>丙：p 两个槽，b 一个槽', () => {
    const src = '<p>甲<b>乙</b>丙</p>'
    const p = byTag(src, 'p')
    expect(p.slots.map((s) => s.text)).toEqual(['甲', '丙'])
    expect(byTag(src, 'b').slots.map((s) => s.text)).toEqual(['乙'])
  })
  it('空槽锚点：首槽取起始标签终点，其余取前一个兄弟的终点', () => {
    const src = '<p><b>x</b></p>'
    const p = byTag(src, 'p')
    expect(p.slots[0]).toMatchObject({ start: 3, end: 3, text: '', anchorOk: true })
    expect(p.slots[1]).toMatchObject({ start: 11, end: 11, anchorOk: true })
  })
  it('前一个兄弟省略结束标签时锚点不明确', () => {
    const src = '<ul><li>a<li>b</ul>'
    const ul = byTag(src, 'ul')
    expect(ul.slots[1].anchorOk).toBe(false)
  })
  it('void 元素之后的空槽锚点明确', () => {
    const p = byTag('<p>a<br></p>', 'p')
    expect(p.slots[1]).toMatchObject({ text: '', anchorOk: true })
  })
  it('槽原文保留实体', () => {
    const p = byTag('<p>A &amp; B</p>', 'p')
    expect(p.slots[0]).toMatchObject({ raw: 'A &amp; B', text: 'A & B' })
  })
})

describe('U-04 CRLF 与编码', () => {
  it('只有 CRLF：规范化为 LF，保存时还原', () => {
    const buf = Buffer.from('<p>a</p>\r\n<p>b</p>\r\n')
    const d = decodeFile(buf)
    expect(d).toMatchObject({ eol: 'CRLF', readOnly: null, hasBom: false })
    expect(d.source).toBe('<p>a</p>\n<p>b</p>\n')
    const p = parseSource(d.source).elements[1]
    expect(d.source.slice(p.slots[0].start, p.slots[0].end)).toBe('b')
    expect(encodeFile(d.source, d.eol, d.hasBom).equals(buf)).toBe(true)
  })
  it('换行混杂：只读', () => {
    expect(decodeFile(Buffer.from('a\r\nb\nc')).readOnly).toBe('eol')
  })
  it('BOM：去掉后解析，保存时加回', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>中</p>')])
    const d = decodeFile(buf)
    expect(d.hasBom).toBe(true)
    expect(d.source).toBe('<p>中</p>')
    expect(encodeFile(d.source, d.eol, d.hasBom).equals(buf)).toBe(true)
  })
  it('非 UTF-8：只读', () => {
    // 「中文」的 GBK 编码
    expect(decodeFile(Buffer.from([0x3c, 0x70, 0x3e, 0xd6, 0xd0, 0xce, 0xc4])).readOnly).toBe('encoding')
  })
})

describe('U-03 补充：不连续的文本节点', () => {
  it('</body> 之后的空白并入 body 时，该槽标记为 broken，不做 token 化', () => {
    const src = '<!doctype html><html><body><p>x</p>\n</body>\n</html>\n'
    const body = parseSource(src).elements.find((e) => e.tag === 'body')!
    const last = body.slots[body.slots.length - 1]
    expect(last.broken).toBe(true)
    expect(last.tokens).toEqual([])
  })
})
