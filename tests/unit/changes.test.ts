// v0.10 本次改动：差分要准（每处改动收缩到真正不同的字符）、能认出移动、统计与撤回一处正确。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffChanges, revertOne, summarize, type Change } from '../../src/main/changes'

/** 按改动把原文重建成当前文本，验证 base/cur 的偏移都对得上 */
function replay(base: string, changes: Change[], cur: string): void {
  for (const c of changes) {
    expect(base.slice(c.baseStart, c.baseEnd)).toBe(c.before)
    expect(cur.slice(c.curStart, c.curEnd)).toBe(c.after)
  }
}

describe('CH-01 差分', () => {
  it('没有改动', () => {
    expect(diffChanges('<p>a</p>', '<p>a</p>')).toEqual([])
  })

  it('同一行里改一个词：只报这个词', () => {
    const base = '<h1>Q3 季度复盘</h1>\n<p>增长 38%</p>\n'
    const cur = '<h1>Q3 经营复盘</h1>\n<p>增长 38%</p>\n'
    const ch = diffChanges(base, cur)
    expect(ch).toEqual([{ kind: 'replace', baseStart: 7, baseEnd: 9, curStart: 7, curEnd: 9, before: '季度', after: '经营' }])
  })

  it('相隔很远的几处各报一处，按位置排序；插入与删除分得清', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `<p id="p${i}">第 ${i} 段</p>\n`)
    const base = lines.join('')
    const next = [...lines]
    next[10] = '<p id="p10">第 10 段改</p>\n'
    next[150] = '<p id="p150" style="color: red">第 150 段</p>\n'
    next.splice(290, 1)
    const cur = next.join('')
    const ch = diffChanges(base, cur)
    expect(ch.map((c) => [c.kind, c.before, c.after])).toEqual([
      ['insert', '', '改'],
      ['insert', '', ' style="color: red"'],
      ['delete', '<p id="p290">第 290 段</p>\n', '']
    ])
    replay(base, ch, cur)
  })

  it('相邻两行各改一处：逐行收缩成两处，不连成一大块', () => {
    const base = '<li>苹果</li>\n<li>香蕉</li>\n'
    const cur = '<li>青苹果</li>\n<li>香蕉片</li>\n'
    const ch = diffChanges(base, cur)
    expect(ch.map((c) => c.after)).toEqual(['青', '片'])
    replay(base, ch, cur)
  })

  it('压缩成一行的 HTML：相隔很远的两处仍是两处', () => {
    const items = Array.from({ length: 200 }, (_, i) => `<li class="item">项目 ${i}</li>`).join('')
    const base = `<ul>${items}</ul>`
    const cur = base.replace('项目 3<', '项目三<').replace('项目 190<', '项目一九〇<')
    const ch = diffChanges(base, cur)
    expect(ch.map((c) => [c.before, c.after])).toEqual([
      [' 3', '三'],
      [' 190', '一九〇']
    ])
    replay(base, ch, cur)
  })

  it('整块挪到前面：认作一处移动', () => {
    const card = (n: string) => `  <div class="card">\n    <h3>${n}</h3>\n    <p>说明文字说明文字</p>\n  </div>\n`
    const base = `<main>\n${card('甲')}${card('乙')}${card('丙')}</main>\n`
    const cur = `<main>\n${card('丙')}${card('甲')}${card('乙')}</main>\n`
    const ch = diffChanges(base, cur)
    expect(ch).toHaveLength(1)
    expect(ch[0].kind).toBe('move')
    expect(ch[0].after).toContain('丙')
    replay(base, ch, cur)
  })

  it('真实样本：大文件里改几处，结果能还原、统计对得上', () => {
    const base = fs.readFileSync(path.join(__dirname, '../fixtures/large-1mb.html'), 'utf8')
    const cur = base.replace('第 7 节标题', '第七节标题').replace('<section class="s900">', '<section class="s900" style="padding: 4px">')
    const t0 = performance.now()
    const ch = diffChanges(base, cur)
    const ms = performance.now() - t0
    expect(ch.map((c) => c.kind)).toEqual(['replace', 'insert'])
    replay(base, ch, cur)
    const s = summarize(base, ch)
    expect(s.count).toBe(2)
    expect(s.untouched).toBe(base.length - s.removed)
    expect(s.untouched + s.removed + s.moved).toBe(s.total)
    // 1MB 文档上算一次要够快，状态推送时才不卡（宽松门槛，防止退化成平方级）
    expect(ms).toBeLessThan(250)
  })
})

describe('CH-02 统计', () => {
  it('删除、替换、插入、移动分别计数；未动字符 = 原文 − 删除 − 移动', () => {
    const base = 'abcdefghij'
    const ch: Change[] = [
      { kind: 'replace', baseStart: 0, baseEnd: 2, curStart: 0, curEnd: 3, before: 'ab', after: 'xyz' },
      { kind: 'move', baseStart: 5, baseEnd: 7, curStart: 8, curEnd: 10, before: 'fg', after: 'fg' }
    ]
    expect(summarize(base, ch)).toEqual({ count: 2, removed: 2, added: 3, moved: 2, untouched: 6, total: 10 })
  })
})

describe('CH-03 撤回一处', () => {
  it('只换回这一处，其余改动保留', () => {
    const base = '<h1>甲</h1>\n<p>乙</p>\n'
    const cur = '<h1>甲一</h1>\n<p>乙二</p>\n'
    const ch = diffChanges(base, cur)
    expect(ch).toHaveLength(2)
    expect(revertOne(cur, ch[0])).toBe('<h1>甲</h1>\n<p>乙二</p>\n')
    expect(revertOne(cur, ch[1])).toBe('<h1>甲一</h1>\n<p>乙</p>\n')
  })
  it('移动不能单独撤回', () => {
    expect(revertOne('x', { kind: 'move', baseStart: 0, baseEnd: 1, curStart: 0, curEnd: 1, before: 'x', after: 'x' })).toBeNull()
  })
})
