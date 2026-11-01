import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/main/parse'

function hosts(src: string): string[] {
  return parseSource(src).elements.filter((e) => e.isHost).map((e) => e.tag)
}
function reasons(src: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const e of parseSource(src).elements) if (e.uneditableReason) out[e.tag] = e.uneditableReason
  return out
}

describe('U-01 host-rules', () => {
  it('最外层 host 优先，子孙归属该 host', () => {
    const { elements } = parseSource('<div><p>a<b>b<i>c</i></b></p></div>')
    const p = elements.find((e) => e.tag === 'p')!
    expect(p.isHost).toBe(true)
    expect(elements.find((e) => e.tag === 'b')!.hostId).toBe(p.eid)
    expect(elements.find((e) => e.tag === 'i')!.hostId).toBe(p.eid)
    expect(elements.find((e) => e.tag === 'div')!.isHost).toBe(false)
  })
  it('任意非黑名单标签都可以成为 host', () => {
    expect(hosts('<ul><li>a</li></ul><h1>t</h1><table><tr><td>x</td></tr></table>')).toEqual(['li', 'h1', 'td'])
  })
  it('子树有文字即可成为候选', () => {
    expect(hosts('<p><b>粗</b></p>')).toEqual(['p'])
  })
  it('只含空白不算文字', () => {
    expect(hosts('<div>  \n </div><p> </p>')).toEqual([])
  })
  it('块级混排：BLOCK_CHILDREN，子块单独成为 host', () => {
    const src = '<div>标题<p>正文</p></div>'
    expect(hosts(src)).toEqual(['p'])
    expect(reasons(src)).toEqual({ div: 'BLOCK_CHILDREN' })
  })
  it('黑名单：pre、svg、textarea 及其子树', () => {
    const src = '<pre><code>x</code></pre><svg><text>s</text></svg><textarea>t</textarea><select><option>o</option></select>'
    expect(hosts(src)).toEqual([])
    expect(reasons(src)).toEqual({ code: 'IN_PRE', pre: 'IN_PRE', svg: 'IN_SVG', text: 'IN_SVG', textarea: 'IN_FORM_CONTROL', select: 'IN_FORM_CONTROL', option: 'IN_FORM_CONTROL' })
  })
  it('pre 自身的文字为 IN_PRE', () => {
    expect(reasons('<pre>a</pre>')).toEqual({ pre: 'IN_PRE' })
  })
  it('script、style、title 不可见，不标原因', () => {
    expect(reasons('<title>t</title><script>var a</script><style>p{}</style>')).toEqual({})
  })
  it('被隐含的 head 中的 title 同样在黑名单内', () => {
    expect(hosts('<title>t</title><p>x</p>')).toEqual(['p'])
  })
  it('扩充的白名单：button、label、del、ins', () => {
    expect(hosts('<p>点击<button>这里</button>继续</p>')).toEqual(['p'])
    expect(hosts('<p><del>旧价</del><ins>新价</ins></p>')).toEqual(['p'])
  })
  it('原子内联 img、svg、input 可以出现在 host 里', () => {
    const src = '<label><input type="checkbox"> 我已阅读</label><p><img src="a.png">图<svg><path/></svg></p>'
    expect(hosts(src)).toEqual(['label', 'p'])
    const { elements } = parseSource(src)
    const path = elements.find((e) => e.tag === 'path')!
    expect(path.hostId).toBe(elements.find((e) => e.tag === 'p')!.eid)
  })
  it('含非白名单元素（如 select）时不是 host', () => {
    expect(hosts('<p>选择<select><option>1</option></select></p>')).toEqual([])
  })
  it('含隐含子元素时不是 host', () => {
    expect(hosts('<table>x<tr><td>y</td></tr></table>')).toContain('td')
    expect(hosts('<table>x<tr><td>y</td></tr></table>')).not.toContain('table')
  })
})

describe('U-07 注释槽', () => {
  it('槽内有注释：hasComment，host 标记 COMMENT_IN_SLOT', () => {
    const { elements } = parseSource('<p>甲<!-- c -->乙</p>')
    expect(elements[0].slots[0].hasComment).toBe(true)
    expect(elements[0].isHost).toBe(true)
    expect(elements[0].uneditableReason).toBe('COMMENT_IN_SLOT')
  })
  it('子孙槽里的注释同样使 host 不可编辑', () => {
    const { elements } = parseSource('<p>甲<b>乙<!--x--></b></p>')
    expect(elements[0].uneditableReason).toBe('COMMENT_IN_SLOT')
  })
})
