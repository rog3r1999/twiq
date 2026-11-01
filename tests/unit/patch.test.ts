import { describe, expect, it, vi } from 'vitest'
import { applyPatches, escapeText, setWarn, slotPatch, tokenize } from '../../src/main/patch'
import { parseSource } from '../../src/main/parse'
import { DocState, EditError } from '../../src/main/document'

/** 对第一个 tag 元素的某个槽写入新文字，返回新 source。 */
function edit(src: string, tag: string, slot: number, text: string, n = 0): string {
  const doc = new DocState({ source: src })
  const el = doc.elements.filter((e) => e.tag === tag)[n]
  doc.commit([{ eid: el.eid, slot, newText: text }])
  return doc.source
}

describe('U-05 实体 token 化', () => {
  it('命名、十进制、十六进制实体各为一个 token', () => {
    const t = tokenize('a&amp;&copy;&#20013;&#x4e2d;b', 'a&©中中b')
    expect(t.map((x) => x.decoded)).toEqual(['a', '&', '©', '中', '中', 'b'])
    expect(t[1]).toMatchObject({ rawStart: 1, rawEnd: 6 })
  })
  it('未知实体按普通字符处理', () => {
    const t = tokenize('&foo;', '&foo;')
    expect(t).toHaveLength(5)
  })
  it('无分号实体：自检失败，退化为整槽一个 token', () => {
    const warn = vi.fn()
    setWarn(warn)
    const t = tokenize('a &copy b', 'a © b')
    expect(t).toEqual([{ rawStart: 0, rawEnd: 9, decoded: 'a © b' }])
    expect(warn).toHaveBeenCalled()
    setWarn(() => {})
  })
  it('退化后写回时整槽替换并转义', () => {
    setWarn(() => {})
    expect(edit('<p>a &copy b</p>', 'p', 0, 'a © c')).toBe('<p>a © c</p>')
  })
})

describe('U-06 最小 diff', () => {
  const src = '<p>Hello world</p>'
  it('中间改', () => expect(edit(src, 'p', 0, 'Hello there world')).toBe('<p>Hello there world</p>'))
  it('头部改', () => expect(edit(src, 'p', 0, 'Jello world')).toBe('<p>Jello world</p>'))
  it('尾部改', () => expect(edit(src, 'p', 0, 'Hello world!')).toBe('<p>Hello world!</p>'))
  it('全替换', () => expect(edit(src, 'p', 0, '你好')).toBe('<p>你好</p>'))
  it('清空', () => expect(edit(src, 'p', 0, '')).toBe('<p></p>'))
  it('补丁只覆盖变化区间', () => {
    const slot = parseSource(src).elements[0].slots[0]
    expect(slotPatch(slot, 'Hello World')).toEqual({ start: 9, end: 10, text: 'W' })
  })
  it('emoji 边界：不把代理对切成两半', () => {
    // 😀 = D83D DE00，😁 = D83D DE01：公共前缀不能停在高位代理之后
    const slot = parseSource('<p>a😀b</p>').elements[0].slots[0]
    const pt = slotPatch(slot, 'a😁b')!
    expect(pt.text).toBe('😁')
    expect(edit('<p>a😀b</p>', 'p', 0, 'a😁b')).toBe('<p>a😁b</p>')
    expect(edit('<p>😀x😀</p>', 'p', 0, '😀y😀')).toBe('<p>😀y😀</p>')
  })
  it('AC-19 实体保留：A &amp; B &copy; 2026 → C', () => {
    expect(edit('<p>A &amp; B &copy; 2026</p>', 'p', 0, 'A & C © 2026')).toBe('<p>A &amp; C &copy; 2026</p>')
  })
  it('变化落在多字符实体内部时，把旧文字补回两端', () => {
    // &#x1F600; 解码为两个 UTF-16 单元，整体替换为新的 emoji
    expect(edit('<p>x&#x1F600;y</p>', 'p', 0, 'x😁y')).toBe('<p>x😁y</p>')
  })
  it('AC-21 缩进与换行保留', () => {
    const s = '<div>\n  <p>\n    第一行 文字\n  </p>\n</div>'
    expect(edit(s, 'p', 0, '\n    第一行 改了\n  ')).toBe('<div>\n  <p>\n    第一行 改了\n  </p>\n</div>')
  })
})

describe('U-08 转义', () => {
  it('&、<、> 与 U+00A0', () => {
    expect(escapeText('a&b<c>d\u00a0e"\'中😀')).toBe('a&amp;b&lt;c&gt;d&nbsp;e"\'中😀')
  })
  it('AC-20 写回脚本文字为转义后的文本', () => {
    expect(edit('<p>x</p>', 'p', 0, '<script>alert(1)</script> & 1<2')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; 1&lt;2</p>'
    )
  })
})

describe('U-09 逆补丁', () => {
  it('多个补丁：先 forward 再 inverse，与原文逐字节相同', () => {
    const src = '0123456789abcdef'
    const patches = [
      { start: 2, end: 4, text: 'XYZW' },
      { start: 8, end: 8, text: '+' },
      { start: 12, end: 16, text: '' }
    ]
    const { source, inverse } = applyPatches(src, patches)
    expect(source).toBe('01XYZW4567+89ab')
    expect(applyPatches(source, inverse).source).toBe(src)
  })
  it('重叠补丁报错', () => {
    expect(() => applyPatches('abcdef', [{ start: 1, end: 3, text: '' }, { start: 2, end: 4, text: '' }])).toThrow()
  })
  it('一次提交修改多个槽', () => {
    const doc = new DocState({ source: '<p>甲<b>乙</b>丙</p>' })
    doc.commit([
      { eid: 0, slot: 0, newText: '一' },
      { eid: 1, slot: 0, newText: '二二' },
      { eid: 0, slot: 1, newText: '三' }
    ])
    expect(doc.source).toBe('<p>一<b>二二</b>三</p>')
    doc.undoOnce()
    expect(doc.source).toBe('<p>甲<b>乙</b>丙</p>')
  })
})

describe('U-10 结构不变自检', () => {
  it('会改变结构的 source 替换被回滚', () => {
    const doc = new DocState({ source: '<p>a</p><p>b</p>' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const orig = doc.source
    // 正常的补丁不会改变结构；这里绕过补丁引擎，直接喂入多了一个元素的 source
    const replace = (doc as unknown as { replaceSource(n: string, p: string): void }).replaceSource.bind(doc)
    expect(() => replace('<p>a<i>x</i></p><p>b</p>', orig)).toThrow(EditError)
    expect(doc.source).toBe(orig)
    expect(doc.version).toBe(0)
    spy.mockRestore()
  })
})

describe('U-11 空槽插入', () => {
  it('锚点明确时可插入', () => {
    expect(edit('<p><b>x</b></p>', 'p', 1, '尾')).toBe('<p><b>x</b>尾</p>')
    expect(edit('<p></p>', 'p', 0, '新')).toBe('<p>新</p>')
  })
  it('前一个兄弟省略结束标签时拒绝', () => {
    // ul 的槽 1 位于两个 li 之间，前一个 li 省略了结束标签
    const doc = new DocState({ source: '<ul><li>a<li>b</ul>' })
    expect(() => doc.commit([{ eid: 0, slot: 1, newText: 'x' }])).toThrow(EditError)
    expect(doc.source).toBe('<ul><li>a<li>b</ul>')
  })
})
