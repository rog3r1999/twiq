// v0.7：属性面板拉宽时的预览缩放、SVG 结构化编辑的数据、媒体种类判断。
import { describe, expect, test } from 'vitest'
import { FIT_MIN, viewLayout } from '../../src/shared/layout'
import { svgModel } from '../../src/main/svg-model'
import { mediaKindOf } from '../../src/main/features'
import { DocState } from '../../src/main/document'
import { isPlainNumber, svgAttrNames, svgFields } from '../../src/shared/svg'

describe('预览区布局（面板挤压时整体缩放）', () => {
  const rect = { x: 0, y: 80, width: 900, height: 600 }

  test('没有挤压：视图铺满，缩放等于用户缩放', () => {
    const l = viewLayout({ ...rect, full: 900 }, 'auto', 1.25)
    expect(l).toMatchObject({ x: 0, width: 900, fit: 1, zoom: 1.25 })
  })

  test('面板拉宽：排版宽度保持，按比例缩小', () => {
    const l = viewLayout({ ...rect, width: 600, full: 900 }, 'auto', 1)
    expect(l.width).toBe(600)
    expect(l.fit).toBeCloseTo(600 / 900)
    expect(l.zoom).toBeCloseTo(600 / 900)
  })

  test('与用户缩放相乘', () => {
    expect(viewLayout({ ...rect, width: 450, full: 900 }, 'auto', 1.5).zoom).toBeCloseTo(0.75)
  })

  test('固定视口：预览区够宽时居中、不缩放', () => {
    const l = viewLayout(rect, '768', 1)
    expect(l).toMatchObject({ width: 768, x: 66, fit: 1 })
  })

  test('固定视口：预览区比视口窄时缩小显示整个视口宽度', () => {
    const l = viewLayout({ ...rect, width: 384 }, '768', 1)
    expect(l.width).toBe(384)
    expect(l.fit).toBeCloseTo(0.5)
  })

  test('缩放有下限', () => {
    expect(viewLayout({ ...rect, width: 50, full: 2000 }, 'auto', 1).fit).toBe(FIT_MIN)
  })

  test('没有 full 时按预览区宽度（旧调用方式）', () => {
    expect(viewLayout(rect, 'auto', 1).fit).toBe(1)
  })
})

describe('SVG 内容列表', () => {
  const src =
    '<body>\n<svg id="s" viewBox="0 0 10 10">\n  <defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>\n  <rect id="bar" x="1" y="2" width="3" height="4" fill="#3D7BFD"/>\n  <g>\n    <text x="1" y="9">销量 <tspan>（万）</tspan></text>\n    <circle cx="5" cy="5" r="2"></circle>\n  </g>\n  <path d="M0 0L1 1"/>\n</svg>\n</body>\n'
  const d = new DocState({ source: src })
  const svg = d.elements.find((e) => e.tag === 'svg')!.eid
  const m = svgModel(d.elements, svg)!

  test('文字排前面，其余按文档顺序；defs 里的内容不列出', () => {
    expect(m.items.map((i) => i.tag)).toEqual(['text', 'rect', 'circle', 'path'])
    expect(m.more).toBe(0)
  })

  test('文字取最长的槽；tspan 不单独列出', () => {
    const t = m.items[0]
    expect(t.text).toEqual({ slot: 0, value: '销量 ' })
  })

  test('属性：源码里有的给原值，没有的给空串', () => {
    const rect = m.items.find((i) => i.tag === 'rect')!
    expect(rect.id).toBe('bar')
    expect(rect.attrs).toMatchObject({ x: '1', y: '2', width: '3', height: '4', fill: '#3D7BFD', rx: '', stroke: '' })
    // 路径数据不进表单
    expect(m.items.find((i) => i.tag === 'path')!.attrs.d).toBeUndefined()
  })

  test('分组里的元素记录深度', () => {
    expect(m.items.find((i) => i.tag === 'circle')!.depth).toBe(1)
    expect(m.items.find((i) => i.tag === 'rect')!.depth).toBe(0)
  })

  test('不是 svg 返回 null', () => {
    expect(svgModel(d.elements, d.elements.find((e) => e.tag === 'rect')!.eid)).toBeNull()
  })

  test('元素过多时截断并给出省略数', () => {
    const many = `<body><svg>${'<rect x="1"/>'.repeat(130)}</svg></body>`
    const dd = new DocState({ source: many })
    const mm = svgModel(dd.elements, dd.elements.find((e) => e.tag === 'svg')!.eid)!
    expect(mm.items).toHaveLength(120)
    expect(mm.more).toBe(10)
  })

  test('通过面板改文字与属性：各是一步撤销，源码只改那几个字符', () => {
    const dd = new DocState({ source: src })
    const t = svgModel(dd.elements, svg)!.items[0]
    dd.commitSvgText(t.eid, dd.elements[t.eid].slots.map((s, i) => (i === t.text!.slot ? '收入 ' : s.text)))
    const rect = dd.elements.find((e) => e.tag === 'rect')!.eid
    dd.applyOp({ type: 'setAttr', eid: rect, name: 'x', value: '7' })
    dd.applyOp({ type: 'setAttr', eid: rect, name: 'rx', value: '2' })
    expect(dd.source).toBe(src.replace('>销量 <', '>收入 <').replace('x="1" y="2"', 'x="7" y="2"').replace('<rect id="bar"', '<rect rx="2" id="bar"'))
    dd.undoSync()
    dd.undoSync()
    dd.undoSync()
    expect(dd.source).toBe(src)
  })
})

describe('SVG 属性表', () => {
  test('高级属性与表单属性分开', () => {
    expect(svgFields('rect').geo).toEqual(['x', 'y', 'width', 'height', 'rx'])
    expect(svgAttrNames('path')).toEqual(['fill', 'stroke', 'stroke-width', 'opacity', 'transform', 'd'])
    expect(svgAttrNames('svg')).toEqual(['width', 'height', 'viewBox'])
  })

  test('纯数字判断', () => {
    expect(['12', '-3.5', '.5', ' 4 '].every(isPlainNumber)).toBe(true)
    expect(['12px', '50%', '', 'auto'].some(isPlainNumber)).toBe(false)
  })
})

describe('插入媒体：按扩展名判断种类', () => {
  test.each([
    ['a.PNG', 'image'],
    ['b.svg', 'image'],
    ['c.mov', 'video'],
    ['d.m4a', 'audio'],
    ['e.txt', null],
    ['noext', null]
  ])('%s → %s', (f, k) => expect(mediaKindOf(f)).toBe(k))
})
