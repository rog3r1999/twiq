import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DocState } from '../../src/main/document'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('U-14 撤销合并与保存点', () => {
  it('相同 coalesceKey 且间隔不超过 600ms 的提交合并为一项', () => {
    const doc = new DocState({ source: '<p>a</p><p>b</p>' })
    doc.commit([{ eid: 0, slot: 0, newText: 'a1' }], 1000)
    doc.commit([{ eid: 0, slot: 0, newText: 'a12' }], 1500)
    expect(doc.undo).toHaveLength(1)
    doc.commit([{ eid: 0, slot: 0, newText: 'a123' }], 2200) // 超过 600ms
    expect(doc.undo).toHaveLength(2)
    doc.commit([{ eid: 1, slot: 0, newText: 'b1' }], 2300) // 不同槽
    expect(doc.undo).toHaveLength(3)
    doc.undoOnce()
    doc.undoOnce()
    expect(doc.source).toBe('<p>a12</p><p>b</p>')
    expect(doc.undoOnce()).toEqual([{ eid: 0, slot: 0, newText: 'a' }])
    expect(doc.source).toBe('<p>a</p><p>b</p>')
  })
  it('撤销回保存点时 dirty 为 false，重做后为 true', () => {
    const doc = new DocState({ source: '<p>a</p>' })
    doc.commit([{ eid: 0, slot: 0, newText: 'b' }], 0)
    doc.markSaved()
    expect(doc.dirty).toBe(false)
    doc.commit([{ eid: 0, slot: 0, newText: 'c' }], 5000)
    expect(doc.dirty).toBe(true)
    doc.undoOnce()
    expect(doc.dirty).toBe(false)
    doc.redoOnce()
    expect(doc.dirty).toBe(true)
  })
  it('保存后不与保存前的项合并', () => {
    const doc = new DocState({ source: '<p>a</p>' })
    doc.commit([{ eid: 0, slot: 0, newText: 'b' }], 0)
    doc.markSaved()
    doc.commit([{ eid: 0, slot: 0, newText: 'c' }], 100)
    expect(doc.undo).toHaveLength(2)
  })
  it('保存点在重做栈里时，新提交使其不可达', () => {
    const doc = new DocState({ source: '<p>a</p>' })
    doc.commit([{ eid: 0, slot: 0, newText: 'b' }], 0)
    doc.markSaved()
    doc.undoOnce()
    doc.commit([{ eid: 0, slot: 0, newText: 'c' }], 5000)
    expect(doc.savedAt).toBe(-1)
    expect(doc.dirty).toBe(true)
  })
  it('无变化不产生撤销项', () => {
    const doc = new DocState({ source: '<p>a</p>' })
    expect(doc.commit([{ eid: 0, slot: 0, newText: 'a' }])).toBeNull()
    expect(doc.undo).toHaveLength(0)
  })
})

describe('AC-29 往返一致', () => {
  it('连续 50 次编辑后撤销 50 次与原文 SHA-256 相同；再重做 50 次与编辑后相同', () => {
    const src = '<!doctype html>\n<main>\n  <h1>标题 &amp; 副标题</h1>\n  <p>甲<b>乙</b>丙 😀</p>\n  <ul><li>一</li><li>二</li></ul>\n</main>\n'
    const doc = new DocState({ source: src })
    const hosts = doc.elements.filter((e) => e.isHost)
    for (let i = 0; i < 50; i++) {
      const h = hosts[i % hosts.length]
      const slot = h.slots.findIndex((s) => s.text.trim())
      const old = doc.elements[h.eid].slots[slot].text
      doc.commit([{ eid: h.eid, slot, newText: `${old.slice(0, 1)}${i}&<${old.slice(1)}` }], i * 1000)
    }
    const edited = doc.source
    expect(doc.undo).toHaveLength(50)
    for (let i = 0; i < 50; i++) doc.undoOnce()
    expect(sha(doc.source)).toBe(sha(src))
    for (let i = 0; i < 50; i++) doc.redoOnce()
    expect(doc.source).toBe(edited)
  })
})
