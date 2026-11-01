// 预览视图的位置与缩放（v0.7）：属性面板挤占预览区时，页面不重新排版，而是按原宽度整体缩小。
// v0.9.1 起主进程与外壳共用（外壳在拖动面板时本地算出适应缩放与冻结画面的位置）。
import type { PreviewRect, ViewportOption } from './types'

/** 适应缩放的下限：再小就看不清了，宁可出现横向滚动 */
export const FIT_MIN = 0.25

export interface ViewLayout {
  x: number
  y: number
  width: number
  height: number
  /** 实际设给 webContents 的缩放系数（用户缩放 × 适应缩放） */
  zoom: number
  /** 适应缩放（1 表示没有被挤压） */
  fit: number
}

/**
 * 页面的排版宽度：自适应时取预览区加面板的总宽（即没有面板时的宽度），固定视口时取视口宽度。
 * 预览区比排版宽度窄时，视图宽度取预览区宽度，缩放系数按比例缩小，页面的 CSS 视口宽度保持不变。
 */
export function viewLayout(r: PreviewRect, vp: ViewportOption, userZoom: number): ViewLayout {
  const layoutW = vp === 'auto' ? Math.max(r.width, r.full ?? r.width) : Number(vp)
  const width = Math.max(1, Math.round(Math.min(r.width, layoutW)))
  const fit = r.width >= layoutW || layoutW <= 0 ? 1 : Math.max(FIT_MIN, r.width / layoutW)
  return {
    x: Math.round(r.x + (r.width - width) / 2),
    y: Math.round(r.y),
    width,
    height: Math.max(1, Math.round(r.height)),
    zoom: userZoom * fit,
    fit
  }
}
