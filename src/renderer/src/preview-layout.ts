// 预览区的几何（v0.9.1）：拖动面板时外壳本地算出适应缩放与冻结画面的位置，
// 不必每动一像素就问一次主进程。
import { viewLayout, type ViewLayout } from '../../shared/layout'
import type { PreviewRect, ViewportOption } from '../../shared/types'
import { useStore } from './store'

/** 属性面板的默认宽度：面板不宽于它时页面照常排版；拉得更宽时页面按比例缩小，不重新排版（v0.7） */
export const PANEL_BASE = 280

/** 主区（预览 + 面板）的宽度。 */
function mainWidth(): number {
  return document.querySelector<HTMLElement>('.main')?.getBoundingClientRect().width ?? 0
}

function viewport(): ViewportOption {
  return useStore.getState().app?.viewport ?? 'auto'
}

/** 面板宽度为 panelW 时页面会怎么缩放（与主进程 viewLayout 同一套算法）。 */
export function previewLayout(panelW: number): ViewLayout {
  const mw = mainWidth()
  const width = Math.max(0, mw - panelW)
  const full = Math.max(width, mw - PANEL_BASE)
  return viewLayout({ x: 0, y: 0, width, height: 0, full }, viewport(), 1)
}

/** 预览区当前的位置（CSS 像素，相对窗口内容区），松手时交给主进程按最终布局重排。 */
export function previewRect(): PreviewRect | null {
  const el = document.querySelector<HTMLElement>('.preview')
  const main = el?.parentElement
  if (!el || !main) return null
  const r = el.getBoundingClientRect()
  const app = useStore.getState().app
  const active = app?.tabs.find((t) => t.id === app.activeId)
  const reserve = app?.panelOpen && active?.mode === 'edit' ? PANEL_BASE : 0
  const mw = main.getBoundingClientRect().width
  return { x: r.x, y: r.y, width: r.width, height: r.height, full: Math.max(r.width, mw - reserve) }
}
