// 拖动属性面板时的预览冻结（v0.9.1 性能专项）。
//
// 预览是独立的 WebContentsView：面板每宽一像素，视图就要改尺寸、改缩放，页面整篇重排。
// 实测 1MB / 2.6 万个元素的文档一次重排 84–110ms，拖动只能跑到约 20 fps，画面停在旧缩放上，
// 看着像 HTML 卡住、盖住了属性栏。元素多的文档在拖动期间改为显示一张冻结画面，外壳按帧
// 跟着面板缩放；松手后页面按最终尺寸重排，画好第一帧再换回实时页面。

/**
 * 冻结预览的阈值（DOM 元素数）。实测：100 个元素一次布局约 1.2ms，2.6 万个元素约 17ms；
 * 一次布局超过 3ms 时，一帧里做两次「改尺寸 + 改缩放」就吃满 16ms 的预算，实时缩放开始掉帧。
 */
export const FREEZE_MIN_NODES = 4000

export function shouldFreeze(nodes: number): boolean {
  return Number.isFinite(nodes) && nodes >= FREEZE_MIN_NODES
}
