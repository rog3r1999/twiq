// 浮动工具条与气泡的定位算法（规格 9.4，必须按此实现）。

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Placement {
  x: number
  y: number
  /** 浮层宽度超过视口时的最大宽度（允许换行） */
  maxWidth?: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export const PAD = 6
const GAP = 8

/**
 * @param kind toolbar 优先放元素上方；bubble 优先放元素下方
 */
export function place(kind: 'toolbar' | 'bubble', r: Rect, W: number, H: number, w: number, h: number): Placement {
  const pad = PAD
  let maxWidth: number | undefined
  if (w > W - 2 * pad) {
    // 第 7 条：浮层宽度超过视口
    maxWidth = W - 2 * pad
    w = maxWidth
  }
  // 第 1 条
  let x = maxWidth !== undefined ? pad : clamp(r.left, pad, W - w - pad)
  // 第 2 条
  const visTop = clamp(r.top, 0, H)
  const visBottom = clamp(r.bottom, 0, H)
  let y: number
  if (kind === 'toolbar') {
    // 第 3 条：上方
    y = visTop - h - GAP
    if (y < pad) {
      // 第 4 条：可见顶边内侧
      y = visTop + GAP
      if (y + h > H - pad) {
        // 第 5 条
        const lowerVisible = r.bottom > 0 && r.bottom <= H
        y = lowerVisible ? visBottom - h - GAP : pad
      }
    }
  } else {
    // 气泡：下方
    y = visBottom + GAP
    if (y + h > H - pad) {
      // 第 4 条：元素上方
      y = visTop - h - GAP
      if (y < pad) {
        const lowerVisible = r.bottom > 0 && r.bottom <= H
        y = lowerVisible ? visBottom - h - GAP : pad
      }
    }
  }
  // 第 6 条
  x = clamp(x, pad, Math.max(pad, W - w - pad))
  y = clamp(y, pad, Math.max(pad, H - h - pad))
  return maxWidth !== undefined ? { x, y, maxWidth } : { x, y }
}
