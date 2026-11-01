// v0.10：复制给 AI 的元素定位（行号、选择器），源码编辑器的着色切分。
import { describe, expect, it } from 'vitest'
import { aiRef, lineOf, selectorOf } from '../../src/main/ai-ref'
import { parseSource } from '../../src/main/parse'
import { tokenizeHtml } from '../../src/shared/html-tokens'
import { DocState } from '../../src/main/document'
import { balanced, canRevert, diffChanges } from '../../src/main/changes'

const SRC = `<!doctype html>
<html>
<body>
<main class="page wide">
  <section class="hero">
    <h1>标题</h1>
  </section>
  <section class="cards">
    <div class="card">一</div>
    <div class="card">二</div>
    <div id="special" class="card">三</div>
  </section>
</main>
<ul><li>甲<li>乙</ul>
</body>
</html>
`

describe('AI-01 复制给 AI：位置与选择器', () => {
  const { elements } = parseSource(SRC)
  const find = (pred: (e: (typeof elements)[number]) => boolean) => elements.find(pred)!

  it('行号从 1 起，按换行计数', () => {
    expect(lineOf('a\nb\nc', 0)).toBe(1)
    expect(lineOf('a\nb\nc', 2)).toBe(2)
    expect(lineOf('a\nb\nc', 4)).toBe(3)
  })

  it('选择器：标签 + 第一个 class，同级同名时加 nth-of-type；遇到 id 就从 id 开始', () => {
    const cards = elements.filter((e) => e.attrs.class?.value === 'card')
    expect(selectorOf(elements, cards[1].eid)).toBe('body > main.page > section.cards:nth-of-type(2) > div.card:nth-of-type(2)')
    expect(selectorOf(elements, find((e) => e.attrs.id?.value === 'special').eid)).toBe('#special')
    expect(selectorOf(elements, find((e) => e.tag === 'h1').eid)).toBe('body > main.page > section.hero:nth-of-type(1) > h1')
  })

  it('aiRef：行号范围与原文；原文一字不改（省略结束标签的 li 也不补，AI 要按原文找到它）', () => {
    const sec = find((e) => e.attrs.class?.value === 'cards')
    const r = aiRef(SRC, elements, sec.eid)!
    expect([r.from, r.to]).toEqual([8, 12])
    expect(r.html.startsWith('<section class="cards">')).toBe(true)
    expect(r.html.endsWith('</section>')).toBe(true)
    const li = find((e) => e.tag === 'li')
    expect(aiRef(SRC, elements, li.eid)?.html).toBe('<li>甲')
  })

  it('同类元素各自的选择器互不相同（在真实页面里只选中自己由端到端 V10-01 验证）', () => {
    for (const el of elements.filter((e) => e.tag === 'div')) {
      const sel = selectorOf(elements, el.eid)
      const hits = elements.filter((e) => e.tag === 'div' && selectorOf(elements, e.eid) === sel)
      expect(hits.map((e) => e.eid)).toEqual([el.eid])
    }
  })
})

describe('HL-01 源码着色切分', () => {
  const join = (s: string) => tokenizeHtml(s).map((t) => t.s).join('')
  it('切出的片段拼起来与原文一字不差（着色层与输入框逐字对齐的前提）', () => {
    for (const s of [SRC, '<a href=x title="a > b">t</a>', '<!-- c --> <br/><img src=\'1.png\' alt>', 'x < y && a<b', '<p class="unterminated', '<', '']) expect(join(s)).toBe(s)
  })
  it('认出标签名、属性名、值与注释', () => {
    const t = tokenizeHtml('<a href="x" hidden>链接</a><!-- 注 -->')
    expect(t.filter((x) => x.k === 'tag').map((x) => x.s)).toEqual(['a', 'a'])
    expect(t.filter((x) => x.k === 'attr').map((x) => x.s)).toEqual(['href', 'hidden'])
    expect(t.filter((x) => x.k === 'value').map((x) => x.s)).toEqual(['"x"'])
    expect(t.filter((x) => x.k === 'comment').map((x) => x.s)).toEqual(['<!-- 注 -->'])
    expect(t.filter((x) => x.k === 'text').map((x) => x.s)).toEqual(['链接'])
  })
})

describe('SRC-01 源码替换的元素计数（审查发现）', () => {
  it('脚本、样式、属性值里的「<字母」不算元素：合法的编辑不被结构校验拒绝', () => {
    const src = '<body>\n<section id="s"><h2>标题</h2><script>if (a<b) go()</script><p title="x<y">段</p></section>\n</body>\n'
    const d = new DocState({ source: src })
    const eid = d.elements.find((e) => e.attrs.id?.value === 's')!.eid
    const html = '<section id="s"><h2>新标题</h2><script>if (a<b) go()</script><p title="x<y">段</p></section>'
    expect(() => d.applyOp({ type: 'replaceElement', eid, html })).not.toThrow()
    expect(d.source).toContain('<h2>新标题</h2>')
  })
  it('真的多出元素时仍然拒绝', () => {
    const d = new DocState({ source: '<body><div id="d"><p>一</p></div></body>' })
    const eid = d.elements.find((e) => e.attrs.id?.value === 'd')!.eid
    expect(() => d.applyOp({ type: 'replaceElement', eid, html: '<div id="d"><p>一</p></div><p>多</p>' })).toThrow()
  })
})

describe('CH-04 撤回的安全性与大块改动（审查发现）', () => {
  it('标签成对才能单独撤回：只撤回半个标签对会吞掉后面的元素', () => {
    expect(balanced('纯文字')).toBe(true)
    expect(balanced(' style="color: red"')).toBe(true)
    expect(balanced('<div class="x"><img src="a.png"><br/><svg><rect/></svg></div>')).toBe(true)
    expect(balanced('<div>')).toBe(false)
    expect(balanced('</div>')).toBe(false)
    expect(balanced('</p><p>')).toBe(false)
    const base = '<main>\n<p>一</p>\n<p>二</p>\n</main>\n'
    const cur = '<main>\n<div class="wrap">\n<p>一</p>\n<p>二</p>\n</div>\n</main>\n'
    const ch = diffChanges(base, cur)
    expect(ch.length).toBe(2)
    expect(ch.map(canRevert)).toEqual([false, false])
  })
  it('大段整体替换、没有唯一行可做锚点：很快给出一整块，不按编辑距离分配大量内存', () => {
    const base = 'a\nb\n'.repeat(10000)
    const cur = 'c\nd\n'.repeat(10000)
    const t0 = performance.now()
    const ch = diffChanges(base, cur)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(ch).toHaveLength(1)
    expect(ch[0].before.length).toBe(base.length - 1) // 末尾共同的换行不算改动
  })
})
