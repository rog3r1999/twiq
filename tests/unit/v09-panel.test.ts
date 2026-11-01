// v0.9.1 性能专项：拖动属性面板时什么时候改用冻结画面。
// 阈值来自实测：100 个元素一次布局约 1.2ms，2.6 万个元素约 17ms；元素多到一次布局
// 超过一帧预算的几分之一时，逐帧缩放必然掉帧。
import { describe, expect, it } from 'vitest'
import { FREEZE_MIN_NODES, shouldFreeze } from '../../src/main/freeze'

describe('拖动面板时的冻结决策', () => {
  it('元素少的页面继续实时缩放', () => {
    expect(shouldFreeze(0)).toBe(false)
    expect(shouldFreeze(101)).toBe(false)
    expect(shouldFreeze(FREEZE_MIN_NODES - 1)).toBe(false)
  })

  it('元素多的页面冻结预览', () => {
    expect(shouldFreeze(FREEZE_MIN_NODES)).toBe(true)
    expect(shouldFreeze(26071)).toBe(true) // 1MB 测试页的元素数
  })

  it('取不到元素数时按实时处理（宁可慢，也不要冻住不动的画面）', () => {
    expect(shouldFreeze(Number.NaN)).toBe(false)
    expect(shouldFreeze(Number.POSITIVE_INFINITY)).toBe(false)
  })
})
