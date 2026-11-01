// 吸附与对齐（v0.6 拆解第 8 条）：纯函数，预览端缩放与自由移动共用。
// 坐标一律是视口坐标（getBoundingClientRect）。

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export const SNAP_PX = 6
export const GRID = 8

/** 一条参考线：axis x 为竖线（位置为 x 坐标），y 为横线；from、to 为线段在另一轴上的范围。 */
export interface Guide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

export interface SnapResult {
  value: number
  /** 吸附到的目标值；没有吸附时为 null */
  hit: number | null
}

/** 在候选值中找离 value 最近、且在阈值内的一个。 */
export function snapValue(value: number, candidates: number[], threshold = SNAP_PX): SnapResult {
  let best: number | null = null
  let dist = threshold + 1e-9
  for (const c of candidates) {
    const d = Math.abs(c - value)
    if (d <= dist) {
      dist = d
      best = c
    }
  }
  return best === null ? { value, hit: null } : { value: best, hit: best }
}

/** 网格吸附：只有与网格线的距离在阈值内才吸附。 */
export function snapGrid(value: number, grid = GRID, threshold = SNAP_PX): SnapResult {
  const g = Math.round(value / grid) * grid
  return Math.abs(g - value) <= threshold ? { value: g, hit: g } : { value, hit: null }
}

const xs = (b: Box): number[] => [b.left, (b.left + b.right) / 2, b.right]
const ys = (b: Box): number[] => [b.top, (b.top + b.bottom) / 2, b.bottom]

/**
 * 缩放吸附：拖动的是右边（或左边）、下边（或上边），把移动的那条边吸到兄弟与父元素的边上；
 * 也把宽、高吸到兄弟的宽、高上。返回吸附后的宽高与参考线。
 */
export function snapResize(
  box: Box,
  edges: { x: 'left' | 'right' | null; y: 'top' | 'bottom' | null },
  others: Box[],
  parent: Box | null,
  threshold = SNAP_PX
): { width: number; height: number; guides: Guide[] } {
  const guides: Guide[] = []
  let { left, top, right, bottom } = box
  const targets = parent ? [...others, parent] : others
  if (edges.x) {
    const cur = edges.x === 'right' ? right : left
    const edgeHit = snapValue(cur, targets.flatMap((o) => [o.left, o.right]), threshold)
    const w = right - left
    const sizeHit = snapValue(w, others.map((o) => o.right - o.left), threshold)
    if (edgeHit.hit !== null) {
      if (edges.x === 'right') right = edgeHit.value
      else left = edgeHit.value
      guides.push({ axis: 'x', at: edgeHit.value, from: Math.min(top, ...targets.map((t) => t.top)), to: Math.max(bottom, ...targets.map((t) => t.bottom)) })
    } else if (sizeHit.hit !== null) {
      if (edges.x === 'right') right = left + sizeHit.value
      else left = right - sizeHit.value
    }
  }
  if (edges.y) {
    const cur = edges.y === 'bottom' ? bottom : top
    const edgeHit = snapValue(cur, targets.flatMap((o) => [o.top, o.bottom]), threshold)
    const h = bottom - top
    const sizeHit = snapValue(h, others.map((o) => o.bottom - o.top), threshold)
    if (edgeHit.hit !== null) {
      if (edges.y === 'bottom') bottom = edgeHit.value
      else top = edgeHit.value
      guides.push({ axis: 'y', at: edgeHit.value, from: Math.min(left, ...targets.map((t) => t.left)), to: Math.max(right, ...targets.map((t) => t.right)) })
    } else if (sizeHit.hit !== null) {
      if (edges.y === 'bottom') bottom = top + sizeHit.value
      else top = bottom - sizeHit.value
    }
  }
  return { width: right - left, height: bottom - top, guides }
}

/**
 * 自由移动吸附：把元素的左、中、右（上、中、下）吸到兄弟与父元素的左、中、右上。
 * dx、dy 为当前位移，返回吸附后的位移与参考线。
 */
export function snapMove(box: Box, dx: number, dy: number, others: Box[], parent: Box | null, threshold = SNAP_PX): { dx: number; dy: number; guides: Guide[] } {
  const moved: Box = { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy }
  const targets = parent ? [...others, parent] : others
  const guides: Guide[] = []
  let bestX: { d: number; shift: number; at: number } | null = null
  for (const a of xs(moved)) {
    for (const t of targets) {
      for (const b of xs(t)) {
        const d = Math.abs(b - a)
        if (d <= threshold && (!bestX || d < bestX.d)) bestX = { d, shift: b - a, at: b }
      }
    }
  }
  let bestY: { d: number; shift: number; at: number } | null = null
  for (const a of ys(moved)) {
    for (const t of targets) {
      for (const b of ys(t)) {
        const d = Math.abs(b - a)
        if (d <= threshold && (!bestY || d < bestY.d)) bestY = { d, shift: b - a, at: b }
      }
    }
  }
  const ndx = dx + (bestX?.shift ?? 0)
  const ndy = dy + (bestY?.shift ?? 0)
  const fin: Box = { left: box.left + ndx, right: box.right + ndx, top: box.top + ndy, bottom: box.bottom + ndy }
  if (bestX) guides.push({ axis: 'x', at: bestX.at, from: Math.min(fin.top, ...targets.map((t) => t.top)), to: Math.max(fin.bottom, ...targets.map((t) => t.bottom)) })
  if (bestY) guides.push({ axis: 'y', at: bestY.at, from: Math.min(fin.left, ...targets.map((t) => t.left)), to: Math.max(fin.right, ...targets.map((t) => t.right)) })
  return { dx: ndx, dy: ndy, guides }
}

/** 等比缩放：按拖动幅度更大的一边决定，另一边按原始比例跟随。 */
export function keepRatio(w0: number, h0: number, w: number, h: number): { width: number; height: number } {
  if (w0 <= 0 || h0 <= 0) return { width: w, height: h }
  const r = w0 / h0
  if (Math.abs(w - w0) / w0 >= Math.abs(h - h0) / h0) return { width: w, height: w / r }
  return { width: h * r, height: h }
}
