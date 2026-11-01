import { describe, expect, it } from 'vitest'
import { htmlToText } from '../../src/main/export-text'
import { plan3 } from '../../src/main/merge'
import { applyPatches } from '../../src/main/patch'
import { checkComponents, normalizePatches } from '../../src/main/components'

describe('导出 Markdown 与纯文本（20.5）', () => {
  const src = `<!doctype html><html><head><title>t</title><style>p{}</style></head><body>
<h1>标题</h1>
<p>正文 <strong>加粗</strong> 与 <a href="https://x.com/a b">链接</a>。</p>
<ul><li>一</li><li>二<ul><li>二.1</li></ul></li></ul>
<ol><li>甲</li><li>乙</li></ol>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<pre>code
  line</pre>
<script>var x = "不导出"</script>
</body></html>`
  it('Markdown', () => {
    expect(htmlToText(src, 'md')).toBe(
      '# 标题\n\n正文 **加粗** 与 [链接](https://x.com/a%20b)。\n\n- 一\n- 二\n  - 二.1\n\n1. 甲\n2. 乙\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n  line\n```\n'
    )
  })
  it('纯文本', () => {
    const t = htmlToText(src, 'txt')
    expect(t).toContain('标题\n\n正文 加粗 与 链接。')
    expect(t).not.toContain('不导出')
    expect(t).toContain('A\tB')
  })
  it('Markdown 特殊字符转义', () => {
    expect(htmlToText('<p>a*b_c</p>', 'md')).toBe('a\\*b\\_c\n')
  })
})

describe('三方合并（20.5）', () => {
  const base = '<h1>标题</h1>\n<p>甲</p>\n<p>乙</p>\n'
  it('互不冲突的修改自动合并', () => {
    const mine = '<h1>新标题</h1>\n<p>甲</p>\n<p>乙</p>\n'
    const theirs = '<h1>标题</h1>\n<p>甲</p>\n<p>乙乙</p>\n'
    const plan = plan3(base, mine, theirs)!
    expect(plan.conflicts).toHaveLength(0)
    expect(applyPatches(theirs, plan.auto).source).toBe('<h1>新标题</h1>\n<p>甲</p>\n<p>乙乙</p>\n')
  })
  it('同一槽两边都改了：冲突', () => {
    const plan = plan3(base, base.replace('甲', '甲1'), base.replace('甲', '甲2'))!
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toMatchObject({ mine: '甲1', theirs: '甲2' })
    expect(applyPatches(base.replace('甲', '甲2'), [plan.conflicts[0].patch!]).source).toBe(base.replace('甲', '甲1'))
  })
  it('两边改成一样：不算冲突', () => {
    const plan = plan3(base, base.replace('甲', 'X'), base.replace('甲', 'X'))!
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.auto).toHaveLength(0)
  })
  it('属性的修改同样合并', () => {
    const b = '<p style="color:red">a</p><p>b</p>'
    const plan = plan3(b, '<p style="color:blue">a</p><p>b</p>', '<p style="color:red">a</p><p>bb</p>')!
    expect(applyPatches('<p style="color:red">a</p><p>bb</p>', plan.auto).source).toBe('<p style="color:blue">a</p><p>bb</p>')
  })
  it('结构不同：无法合并', () => {
    expect(plan3(base, base, base + '<p>新</p>')).toBeNull()
  })
})

describe('组件规范（20.4）', () => {
  it('规范化：补上唯一的 data-id，跳过已用的', () => {
    const src = '<div data-c="card" data-id="c-1"><h3 data-slot="title">a</h3></div><div data-c="card"><h3 data-slot="title">b</h3></div>'
    const out = applyPatches(src, normalizePatches(src)).source
    expect(out).toBe('<div data-c="card" data-id="c-1"><h3 data-slot="title">a</h3></div><div data-id="c-2" data-c="card"><h3 data-slot="title">b</h3></div>')
    expect(checkComponents(out)).toEqual([])
  })
  it('校验：重复 id、孤立槽位、缺少 id', () => {
    const issues = checkComponents('<div data-c="a" data-id="x"></div><div data-c="b" data-id="x"></div><p data-slot="t">t</p><div data-c="c"></div>')
    expect(issues.map((i) => i.message)).toEqual(['data-id「x」重复', '槽位「t」不在任何组件之内', '组件「c」缺少 data-id（可运行规范化补上）'])
  })
})
