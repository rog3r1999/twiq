import { describe, expect, it } from 'vitest'
import { DocState, EditError } from '../../src/main/document'
import { getDecl, parseDecls, setDecl } from '../../src/shared/style-attr'

const find = (doc: DocState, tag: string, n = 0) => doc.elements.filter((e) => e.tag === tag)[n].eid

const LIST = `<ul>
  <li>一</li>
  <li>二</li>
  <li>三</li>
</ul>
`

describe('删除（20.2）', () => {
  it('独占整行的元素连同缩进与换行一起删除', () => {
    const doc = new DocState({ source: LIST })
    doc.applyOp({ type: 'delete', eid: find(doc, 'li', 1) })
    expect(doc.source).toBe('<ul>\n  <li>一</li>\n  <li>三</li>\n</ul>\n')
    doc.undoSync()
    expect(doc.source).toBe(LIST)
    doc.redoSync()
    expect(doc.source).toBe('<ul>\n  <li>一</li>\n  <li>三</li>\n</ul>\n')
  })
  it('同一行内的元素只删范围本身', () => {
    const doc = new DocState({ source: '<p>甲<b>乙</b>丙</p>' })
    doc.applyOp({ type: 'delete', eid: find(doc, 'b') })
    expect(doc.source).toBe('<p>甲丙</p>')
  })
  it('省略结束标签的 li 可以删除（v0.6）', () => {
    const doc = new DocState({ source: '<ul><li>一<li>二</ul>' })
    doc.applyOp({ type: 'delete', eid: find(doc, 'li') })
    expect(doc.source).toBe('<ul><li>二</ul>')
  })

  it('区间不可靠的元素（div 缺结束标签）拒绝删除', () => {
    const doc = new DocState({ source: '<body><div>abc</body>' })
    expect(() => doc.applyOp({ type: 'delete', eid: find(doc, 'div') })).toThrow(EditError)
    expect(doc.source).toBe('<body><div>abc</body>')
  })
  it('删除后保存点与 dirty', () => {
    const doc = new DocState({ source: LIST })
    doc.applyOp({ type: 'delete', eid: find(doc, 'li') })
    expect(doc.dirty).toBe(true)
    doc.undoSync()
    expect(doc.dirty).toBe(false)
  })
})

describe('复制', () => {
  it('插到原范围之后并保持缩进，选中新元素', () => {
    const doc = new DocState({ source: LIST })
    const r = doc.applyOp({ type: 'duplicate', eid: find(doc, 'li', 0) })
    expect(doc.source).toBe('<ul>\n  <li>一</li>\n  <li>一</li>\n  <li>二</li>\n  <li>三</li>\n</ul>\n')
    expect(r).toMatchObject({ kind: 'struct', select: find(doc, 'li', 1) })
  })
  it('多行元素的缩进原样复制', () => {
    const src = '<div>\n  <section>\n    <h2>t</h2>\n  </section>\n</div>\n'
    const doc = new DocState({ source: src })
    doc.applyOp({ type: 'duplicate', eid: find(doc, 'section') })
    expect(doc.source).toBe('<div>\n  <section>\n    <h2>t</h2>\n  </section>\n  <section>\n    <h2>t</h2>\n  </section>\n</div>\n')
  })
})

describe('移动', () => {
  it('移到另一个兄弟之后', () => {
    const doc = new DocState({ source: LIST })
    const r = doc.applyOp({ type: 'move', eid: find(doc, 'li', 0), target: find(doc, 'li', 2), where: 'after' })
    expect(doc.source).toBe('<ul>\n  <li>二</li>\n  <li>三</li>\n  <li>一</li>\n</ul>\n')
    expect(r?.kind === 'struct' && doc.elements[r.select!].slots[0].text).toBe('一')
    doc.undoSync()
    expect(doc.source).toBe(LIST)
  })
  it('移到前面的兄弟之前', () => {
    const doc = new DocState({ source: LIST })
    const r = doc.applyOp({ type: 'move', eid: find(doc, 'li', 2), target: find(doc, 'li', 0), where: 'before' })
    expect(doc.source).toBe('<ul>\n  <li>三</li>\n  <li>一</li>\n  <li>二</li>\n</ul>\n')
    expect(r?.kind === 'struct' && doc.elements[r.select!].slots[0].text).toBe('三')
  })
  it('目标在被移动元素内部：拒绝', () => {
    const doc = new DocState({ source: '<div><section><p>a</p></section><p>b</p></div>' })
    expect(() => doc.applyOp({ type: 'move', eid: find(doc, 'section'), target: find(doc, 'p', 0), where: 'after' })).toThrow(EditError)
  })
  it('li 不能移出列表', () => {
    const doc = new DocState({ source: '<div><ul><li>a</li></ul><p>b</p></div>' })
    expect(() => doc.applyOp({ type: 'move', eid: find(doc, 'li'), target: find(doc, 'p'), where: 'after' })).toThrow(EditError)
  })
  it('tr 只能在同一表体内移动', () => {
    const src = '<table><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody><tbody><tr><td>3</td></tr></tbody></table>'
    const doc = new DocState({ source: src })
    doc.applyOp({ type: 'move', eid: find(doc, 'tr', 0), target: find(doc, 'tr', 1), where: 'after' })
    expect(doc.source).toBe('<table><tbody><tr><td>2</td></tr><tr><td>1</td></tr></tbody><tbody><tr><td>3</td></tr></tbody></table>')
    expect(() => doc.applyOp({ type: 'move', eid: find(doc, 'tr', 0), target: find(doc, 'tr', 2), where: 'after' })).toThrow(EditError)
  })
  it('原地移动报 NOOP', () => {
    const doc = new DocState({ source: LIST })
    try {
      doc.applyOp({ type: 'move', eid: find(doc, 'li', 0), target: find(doc, 'li', 1), where: 'before' })
      expect.unreachable()
    } catch (e) {
      expect((e as EditError).code).toBe('NOOP')
    }
  })
})

describe('属性与样式（20.3）', () => {
  it('没有 style 时插在标签名之后', () => {
    const doc = new DocState({ source: '<p class="x">a</p>' })
    const r = doc.applyOp({ type: 'setStyle', eid: 0, props: { color: '#ff0000' } })
    expect(doc.source).toBe('<p style="color: #ff0000" class="x">a</p>')
    expect(r).toEqual({ kind: 'attr', attrs: [{ eid: 0, name: 'style', value: 'color: #ff0000' }] })
  })
  it('只改目标声明，保持其他声明与顺序', () => {
    const doc = new DocState({ source: '<p style="margin:0;color:red;font-size:12px">a</p>' })
    doc.applyOp({ type: 'setStyle', eid: 0, props: { color: 'blue' } })
    expect(doc.source).toBe('<p style="margin:0;color:blue;font-size:12px">a</p>')
  })
  it('重置：删除声明；声明为空时删除整个 style 属性', () => {
    const doc = new DocState({ source: '<p id="a" style="color:red">a</p>' })
    doc.applyOp({ type: 'setStyle', eid: 0, props: { color: null } })
    expect(doc.source).toBe('<p id="a">a</p>')
    doc.undoSync()
    expect(doc.source).toBe('<p id="a" style="color:red">a</p>')
  })
  it('属性值转义', () => {
    const doc = new DocState({ source: '<img src="a.png">' })
    doc.applyOp({ type: 'setAttr', eid: 0, name: 'alt', value: 'say "hi" & <go>' })
    expect(doc.source).toBe('<img alt="say &quot;hi&quot; &amp; <go>" src="a.png">')
    expect(doc.elements[0].attrs.alt.value).toBe('say "hi" & <go>')
  })
  it('600ms 内对同一声明的连续修改合并为一步撤销（20.4）', () => {
    const doc = new DocState({ source: '<p>a</p>' })
    doc.applyOp({ type: 'setStyle', eid: 0, props: { position: 'relative', left: '1px', top: '0px' } }, 1000)
    doc.applyOp({ type: 'setStyle', eid: 0, props: { position: 'relative', left: '2px', top: '0px' } }, 1300)
    doc.applyOp({ type: 'setStyle', eid: 0, props: { position: 'relative', left: '3px', top: '0px' } }, 1600)
    expect(doc.undo).toHaveLength(1)
    doc.undoSync()
    expect(doc.source).toBe('<p>a</p>')
  })
  it('属性撤销返回撤销后的值', () => {
    const doc = new DocState({ source: '<p style="color:red">a</p>' })
    doc.applyOp({ type: 'setStyle', eid: 0, props: { color: 'blue' } })
    expect(doc.undoSync()).toEqual({ kind: 'attr', attrs: [{ eid: 0, name: 'style', value: 'color:red' }] })
  })
})

describe('文字格式（20.3）', () => {
  it('同一槽内包上 b', () => {
    const doc = new DocState({ source: '<p>甲乙丙</p>' })
    doc.applyOp({ type: 'format', start: { eid: 0, slot: 0, offset: 1 }, end: { eid: 0, slot: 0, offset: 2 }, tag: 'b' })
    expect(doc.source).toBe('<p>甲<b>乙</b>丙</p>')
  })
  it('跨过已有内联子元素', () => {
    const doc = new DocState({ source: '<p>甲<a href="#">乙</a>丙</p>' })
    doc.applyOp({ type: 'format', start: { eid: 0, slot: 0, offset: 0 }, end: { eid: 0, slot: 1, offset: 1 }, tag: 'i' })
    expect(doc.source).toBe('<p><i>甲<a href="#">乙</a>丙</i></p>')
  })
  it('实体按 token 对齐', () => {
    const doc = new DocState({ source: '<p>a&amp;b</p>' })
    doc.applyOp({ type: 'format', start: { eid: 0, slot: 0, offset: 1 }, end: { eid: 0, slot: 0, offset: 2 }, tag: 'u' })
    expect(doc.source).toBe('<p>a<u>&amp;</u>b</p>')
  })
  it('选区在已有格式内：取消格式（strong 视为加粗）', () => {
    const doc = new DocState({ source: '<p>甲<strong>乙</strong>丙</p>' })
    doc.applyOp({ type: 'format', start: { eid: 1, slot: 0, offset: 0 }, end: { eid: 1, slot: 0, offset: 1 }, tag: 'b' })
    expect(doc.source).toBe('<p>甲乙丙</p>')
  })
  it('选区跨元素边界：拒绝', () => {
    const doc = new DocState({ source: '<p>甲<b>乙</b>丙</p>' })
    expect(() => doc.applyOp({ type: 'format', start: { eid: 0, slot: 0, offset: 0 }, end: { eid: 1, slot: 0, offset: 1 }, tag: 'i' })).toThrow(EditError)
  })
})

describe('插入片段', () => {
  it('插到元素之后，按其缩进', () => {
    const doc = new DocState({ source: '<body>\n  <p>a</p>\n</body>' })
    const r = doc.applyOp({ type: 'insertHtml', eid: find(doc, 'p'), where: 'after', html: '<img src="assets/x.png">' })
    expect(doc.source).toBe('<body>\n  <p>a</p>\n  <img src="assets/x.png">\n</body>')
    expect(r?.kind === 'struct' && doc.elements[r.select!].tag).toBe('img')
  })
  it('没有参照元素时插到 body 末尾', () => {
    const doc = new DocState({ source: '<html><body>\n<p>a</p>\n</body></html>' })
    doc.applyOp({ type: 'insertHtml', eid: null, where: 'append', html: '<p>b</p>' })
    expect(doc.source).toBe('<html><body>\n<p>a</p>\n<p>b</p>\n</body></html>')
  })
})

describe('style 声明解析', () => {
  it('括号与引号内的分号不切分', () => {
    const css = 'background:url("a;b.png");content:";";color:red'
    expect(parseDecls(css).map((d) => d.prop)).toEqual(['background', 'content', 'color'])
    expect(getDecl(css, 'color')).toBe('red')
  })
  it('追加与删除', () => {
    expect(setDecl('color:red;', 'top', '1px')).toBe('color:red; top: 1px')
    expect(setDecl('color:red; top: 1px', 'color', null)).toBe('top: 1px')
    expect(setDecl('', 'top', '1px')).toBe('top: 1px')
  })
})
