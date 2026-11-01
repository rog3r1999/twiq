import { describe, expect, test } from 'vitest'
import { keepRatio, snapGrid, snapMove, snapResize, snapValue } from '../../src/shared/snap'

const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h })

describe('snapValue / snapGrid', () => {
  test('阈值内吸到最近的候选', () => {
    expect(snapValue(103, [100, 110])).toEqual({ value: 100, hit: 100 })
    expect(snapValue(108, [100, 110])).toEqual({ value: 110, hit: 110 })
    expect(snapValue(120, [100, 110])).toEqual({ value: 120, hit: null })
  })
  test('网格', () => {
    expect(snapGrid(30)).toEqual({ value: 32, hit: 32 })
    expect(snapGrid(30, 100)).toEqual({ value: 30, hit: null })
  })
})

describe('snapResize', () => {
  test('右边吸到兄弟的右边，出参考线', () => {
    const r = snapResize(box(0, 0, 97, 50), { x: 'right', y: null }, [box(0, 60, 100, 40)], null)
    expect(r.width).toBe(100)
    expect(r.guides).toHaveLength(1)
    expect(r.guides[0]).toMatchObject({ axis: 'x', at: 100 })
  })
  test('没有边可吸时吸宽度到兄弟的宽度', () => {
    const r = snapResize(box(300, 0, 118, 50), { x: 'right', y: null }, [box(0, 0, 120, 40)], null)
    expect(r.width).toBe(120)
  })
  test('下边吸到父元素的下边', () => {
    const r = snapResize(box(10, 10, 50, 86), { x: null, y: 'bottom' }, [], box(0, 0, 200, 100))
    expect(r.height).toBe(90)
  })
  test('超出阈值不吸', () => {
    const r = snapResize(box(0, 0, 80, 50), { x: 'right', y: 'bottom' }, [box(0, 200, 100, 40)], null)
    expect(r).toEqual({ width: 80, height: 50, guides: [] })
  })
})

describe('snapMove', () => {
  test('中线对齐兄弟的中线', () => {
    const r = snapMove(box(0, 0, 40, 40), 78, 0, [box(80, 100, 60, 20)], null)
    // 元素中线 98 → 兄弟中线 110；左边 78 → 兄弟左边 80 更近（差 2）
    expect(r.dx).toBe(80)
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 80)).toBe(true)
  })
  test('两轴同时吸附', () => {
    const r = snapMove(box(0, 0, 20, 20), 97, 203, [box(100, 205, 50, 50)], null)
    expect(r.dx).toBe(100)
    expect(r.dy).toBe(205)
  })
})

test('keepRatio：按变化大的一边等比', () => {
  expect(keepRatio(200, 100, 300, 110)).toEqual({ width: 300, height: 150 })
  expect(keepRatio(200, 100, 210, 200)).toEqual({ width: 400, height: 200 })
})
