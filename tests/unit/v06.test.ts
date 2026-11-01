// v0.6：省略结束标签与 SVG 自闭合元素的区间、移动与复制（拆解第 2 条）。
import { describe, expect, test } from 'vitest'
import { parseSource } from '../../src/main/parse'
import { DocState } from '../../src/main/document'

const byTag = (src: string, tag: string, i = 0) => parseSource(src).elements.filter((e) => e.tag === tag)[i]

describe('源码区间', () => {
  test('SVG 自闭合元素 <rect/> 有完整区间', () => {
    const src = '<body><svg><rect width="2"/><circle r="1"></circle></svg></body>'
    const r = byTag(src, 'rect')
    expect(r.rangeOk).toBe(true)
    expect(src.slice(r.startTagStart, r.end)).toBe('<rect width="2"/>')
  })

  test('省略 </li> 的列表项取到最后一个子节点，去掉尾部空白', () => {
    const src = '<body>\n<ul>\n  <li>一\n  <li>二 <b>粗</b>\n</ul>\n</body>'
    const a = byTag(src, 'li', 0)
    const b = byTag(src, 'li', 1)
    expect(a.rangeOk && b.rangeOk).toBe(true)
    expect(a.impliedEnd).toBe(true)
    expect(src.slice(a.startTagStart, a.end)).toBe('<li>一')
    expect(src.slice(b.startTagStart, b.end)).toBe('<li>二 <b>粗</b>')
  })

  test('省略 </p> 且后面紧跟 </body>：不把 </body> 算进区间', () => {
    const src = '<body><p>x\n<p>y\n</body>'
    const p = byTag(src, 'p', 1)
    expect(src.slice(p.startTagStart, p.end)).toBe('<p>y')
  })

  test('非可省略元素缺结束标签：区间不可靠', () => {
    const src = '<body><div>abc</body>'
    expect(byTag(src, 'div').rangeOk).toBe(false)
  })
})

describe('省略结束标签的元素可以移动、复制、删除', () => {
  const src = '<body>\n<ul>\n  <li>一\n  <li>二\n  <li>三\n</ul>\n</body>\n'
  const li = (d: DocState, i: number) => d.elements.filter((e) => e.tag === 'li')[i].eid

  test('移动：补上结束标签，原位只剪掉自身', () => {
    const d = new DocState({ source: src })
    d.applyOp({ type: 'move', eid: li(d, 0), target: li(d, 2), where: 'after' })
    const texts = d.elements.filter((e) => e.tag === 'li').map((e) => e.slots[0].text.trim())
    expect(texts).toEqual(['二', '三', '一'])
    d.undoSync()
    expect(d.source).toBe(src)
  })

  test('复制', () => {
    const d = new DocState({ source: src })
    d.applyOp({ type: 'duplicate', eid: li(d, 1) })
    expect(d.elements.filter((e) => e.tag === 'li').map((e) => e.slots[0].text.trim())).toEqual(['一', '二', '二', '三'])
  })

  test('删除', () => {
    const d = new DocState({ source: src })
    d.applyOp({ type: 'delete', eid: li(d, 1) })
    expect(d.elements.filter((e) => e.tag === 'li').map((e) => e.slots[0].text.trim())).toEqual(['一', '三'])
  })

  test('SVG 内的形状可以复制', () => {
    const s = '<body>\n<svg>\n  <rect width="2"/>\n</svg>\n</body>\n'
    const d = new DocState({ source: s })
    d.applyOp({ type: 'duplicate', eid: d.elements.find((e) => e.tag === 'rect')!.eid })
    expect(d.source).toBe('<body>\n<svg>\n  <rect width="2"/>\n  <rect width="2"/>\n</svg>\n</body>\n')
  })
})

describe('结构操作的就地同步（DomSync）', () => {
  const src = '<body>\n<ul id="l">\n  <li>一</li>\n  <li>二 <b>粗</b></li>\n  <li>三</li>\n</ul>\n<p id="p">段</p>\n</body>\n'
  const lis = (d: DocState) => d.elements.filter((e) => e.tag === 'li').map((e) => e.eid)
  const struct = (s: ReturnType<DocState['applyOp']>) => {
    if (!s || s.kind !== 'struct') throw new Error('not struct')
    return s
  }

  test('删除：只删一个子树，其余 eid 换算正确', () => {
    const d = new DocState({ source: src })
    const [, b] = lis(d)
    const s = struct(d.applyOp({ type: 'delete', eid: b }))
    expect(s.dom).toBeTruthy()
    expect(s.dom!.remove).toEqual([b])
    expect(s.dom!.inserts).toEqual([])
    expect(s.dom!.map[b]).toBe(-1)
    // 后面的元素 eid 前移两位（li 与 b）
    const p = d.elements.find((e) => e.tag === 'p')!
    expect(s.dom!.map[p.eid + 2]).toBe(p.eid)
  })

  test('复制：插入带 data-hw 的新片段', () => {
    const d = new DocState({ source: src })
    const [, b] = lis(d)
    const s = struct(d.applyOp({ type: 'duplicate', eid: b }))
    expect(s.dom!.inserts).toHaveLength(1)
    const ins = s.dom!.inserts[0]
    expect(ins.html).toMatch(/^<li data-hw=\d+>二 <b data-hw=\d+>粗<\/b><\/li>$/)
    expect(ins.from).toBeUndefined()
  })

  test('移动：用 from 指回原节点，不新建 DOM', () => {
    const d = new DocState({ source: src })
    const [a, , c] = lis(d)
    const s = struct(d.applyOp({ type: 'move', eid: a, target: c, where: 'after' }))
    expect(s.dom!.inserts).toHaveLength(1)
    expect(s.dom!.inserts[0].from).toBe(a)
    expect(s.dom!.remove).toEqual([])
    expect(s.dom!.detach).toEqual([a])
  })

  test('撤销与重做也给出就地同步步骤', () => {
    const d = new DocState({ source: src })
    const [a, , c] = lis(d)
    d.applyOp({ type: 'move', eid: a, target: c, where: 'after' })
    const u = d.undoSync()!
    expect(u.kind === 'struct' && u.dom).toBeTruthy()
    const r = d.redoSync()!
    expect(r.kind === 'struct' && r.dom).toBeTruthy()
  })

  test('解开没有子元素的标签：删掉它、父元素槽文字重写', () => {
    const d = new DocState({ source: src })
    const b = d.elements.find((e) => e.tag === 'b')!.eid
    const s = struct(d.applyOp({ type: 'unwrap', eid: b }))
    expect(s.dom!.remove).toEqual([b])
    expect(s.dom!.slots.find((x) => x.tag === 'li')!.slots).toEqual(['二 粗'])
  })

  test('v0.10 整份替换只改了文字：同步所在元素的文字槽，不重载', () => {
    const d = new DocState({ source: src })
    const s = struct(d.applyOp({ type: 'replaceAll', source: src.replace('<li>三</li>', '<li>三改</li>') }))
    expect(s.dom).toBeTruthy()
    expect(s.dom!.remove).toEqual([])
    expect(s.dom!.inserts).toEqual([])
    expect(s.dom!.slots.find((x) => x.tag === 'li' && x.slots[0] === '三改')).toBeTruthy()
  })

  test('v0.10 整份替换改到属性：没有就地步骤，返回 null 让预览重载（以前会留下旧值）', () => {
    const d = new DocState({ source: src })
    const s = struct(d.applyOp({ type: 'replaceAll', source: src.replace('id="p"', 'id="q"') }))
    expect(s.dom).toBeNull()
  })

  test('解开带子元素的标签：子元素换了父元素，无法就地同步，返回 null 让预览重载', () => {
    const d = new DocState({ source: '<body><p><b>a<i>b</i></b></p></body>' })
    const b = d.elements.find((e) => e.tag === 'b')!.eid
    const s = struct(d.applyOp({ type: 'unwrap', eid: b }))
    expect(s.dom).toBeNull()
  })

  test('文字格式（包一层 b）可以就地同步：受影响的父元素重建', () => {
    const d = new DocState({ source: src })
    const p = d.elements.find((e) => e.tag === 'p')!.eid
    const s = d.applyOp({ type: 'format', start: { eid: p, slot: 0, offset: 0 }, end: { eid: p, slot: 0, offset: 1 }, tag: 'b' })
    expect(s?.kind).toBe('struct')
  })

  test('表格行（父元素是隐含的 tbody）：移动、复制、删除都能就地同步', () => {
    const t = '<body>\n<table>\n  <tr><td>1</td></tr>\n  <tr><td>2</td></tr>\n  <tr><td>3</td></tr>\n</table>\n</body>\n'
    const trs = (d: DocState) => d.elements.filter((e) => e.tag === 'tr').map((e) => e.eid)
    let d = new DocState({ source: t })
    let [a, , c] = trs(d)
    let s = struct(d.applyOp({ type: 'move', eid: a, target: c, where: 'after' }))
    expect(s.dom!.inserts[0]).toMatchObject({ from: a, parent: null, before: null })
    expect(s.dom!.inserts[0].after).not.toBeNull()
    d = new DocState({ source: t })
    ;[a, , c] = trs(d)
    s = struct(d.applyOp({ type: 'move', eid: c, target: a, where: 'before' }))
    expect(s.dom!.inserts[0]).toMatchObject({ from: c, parent: null })
    expect(s.dom!.inserts[0].before).not.toBeNull()
    d = new DocState({ source: t })
    s = struct(d.applyOp({ type: 'duplicate', eid: trs(d)[1] }))
    expect(s.dom!.inserts[0].html).toMatch(/^<tr data-hw=\d+>/)
    d = new DocState({ source: t })
    expect(struct(d.applyOp({ type: 'delete', eid: trs(d)[1] })).dom).toBeTruthy()
  })
})

describe('多选批量操作（拆解第 9 条）', () => {
  const src = '<body>\n<div id="r">\n  <p>a</p>\n  <p>b</p>\n  <p>c</p>\n  <p>d</p>\n</div>\n</body>\n'
  const ps = (d: DocState) => d.elements.filter((e) => e.tag === 'p').map((e) => e.eid)
  const texts = (d: DocState) => d.elements.filter((e) => e.tag === 'p').map((e) => e.slots[0].text)

  test('批量删除一步撤销', () => {
    const d = new DocState({ source: src })
    const [a, , c] = ps(d)
    d.applyOp({ type: 'batch', ops: [{ type: 'delete', eid: a }, { type: 'delete', eid: c }] })
    expect(texts(d)).toEqual(['b', 'd'])
    d.undoSync()
    expect(d.source).toBe(src)
  })

  test('批量复制', () => {
    const d = new DocState({ source: src })
    const [a, b] = ps(d)
    d.applyOp({ type: 'batch', ops: [{ type: 'duplicate', eid: a }, { type: 'duplicate', eid: b }] })
    expect(texts(d)).toEqual(['a', 'a', 'b', 'b', 'c', 'd'])
  })

  test('批量改样式只走属性同步', () => {
    const d = new DocState({ source: src })
    const [a, b] = ps(d)
    d.applyOp({ type: 'batch', ops: [{ type: 'setStyle', eid: a, props: { color: 'red' } }, { type: 'setStyle', eid: b, props: { color: 'red' } }] })
    expect(d.source.match(/style="color: red;?"/g)).toHaveLength(2)
  })

  test('不允许批量插入类操作', () => {
    const d = new DocState({ source: src })
    const [a] = ps(d)
    expect(() => d.applyOp({ type: 'batch', ops: [{ type: 'move', eid: a, target: a, where: 'after' }] })).toThrow()
  })

  test('多个元素整体移到末尾，保持文档顺序', () => {
    const d = new DocState({ source: src })
    const [a, b, , dd] = ps(d)
    d.applyOp({ type: 'moveMany', eids: [b, a], target: dd, where: 'after' })
    expect(texts(d)).toEqual(['c', 'd', 'a', 'b'])
    expect(d.source).toBe('<body>\n<div id="r">\n  <p>c</p>\n  <p>d</p>\n  <p>a</p>\n  <p>b</p>\n</div>\n</body>\n')
    d.undoSync()
    expect(d.source).toBe(src)
  })

  test('目标紧挨着被移动元素也能合并补丁', () => {
    const d = new DocState({ source: src })
    const [a, b, c] = ps(d)
    d.applyOp({ type: 'moveMany', eids: [a, b], target: c, where: 'after' })
    expect(texts(d)).toEqual(['c', 'a', 'b', 'd'])
  })

  test('目标在被移动元素里面：拒绝', () => {
    const s = '<body>\n<div>\n  <section><p>x</p></section>\n  <p>y</p>\n</div>\n</body>\n'
    const d = new DocState({ source: s })
    const sec = d.elements.find((e) => e.tag === 'section')!.eid
    const y = d.elements.filter((e) => e.tag === 'p')[1].eid
    const x = d.elements.filter((e) => e.tag === 'p')[0].eid
    expect(() => d.applyOp({ type: 'moveMany', eids: [sec, y], target: x, where: 'after' })).toThrow()
  })
})

describe('SVG 源码替换与文字（拆解第 10 条）', () => {
  const src = '<body>\n<svg viewBox="0 0 10 10">\n  <rect width="2"/>\n  <text x="1">销量</text>\n</svg>\n</body>\n'

  test('整段替换，可撤销', () => {
    const d = new DocState({ source: src })
    const svg = d.elements.find((e) => e.tag === 'svg')!.eid
    const html = '<svg viewBox="0 0 10 10">\n  <circle r="3"/>\n  <text x="1">销量</text>\n</svg>'
    d.applyOp({ type: 'replaceElement', eid: svg, html })
    expect(d.source).toBe(`<body>\n${html}\n</body>\n`)
    expect(d.elements.some((e) => e.tag === 'circle')).toBe(true)
    d.undoSync()
    expect(d.source).toBe(src)
  })

  test('外层标签改了：拒绝', () => {
    const d = new DocState({ source: src })
    const svg = d.elements.find((e) => e.tag === 'svg')!.eid
    expect(() => d.applyOp({ type: 'replaceElement', eid: svg, html: '<div></div>' })).toThrow()
  })

  test('多出一个顶层元素：结构校验拒绝', () => {
    const d = new DocState({ source: src })
    const svg = d.elements.find((e) => e.tag === 'svg')!.eid
    expect(() => d.applyOp({ type: 'replaceElement', eid: svg, html: '<svg></svg><p>x</p>' })).toThrow()
    expect(d.source).toBe(src)
  })

  test('SVG 文字改写成槽补丁', () => {
    const d = new DocState({ source: src })
    const t = d.elements.find((e) => e.tag === 'text')!.eid
    d.commitSvgText(t, ['收入 & 成本'])
    expect(d.source).toContain('<text x="1">收入 &amp; 成本</text>')
    expect(d.previewTable()[t].slots).toEqual(['收入 & 成本'])
  })

  test('非 SVG 文字不能走这个入口', () => {
    const d = new DocState({ source: '<body><p>x</p></body>' })
    const p = d.elements.find((e) => e.tag === 'p')!.eid
    expect(() => d.commitSvgText(p, ['y'])).toThrow()
  })
})
