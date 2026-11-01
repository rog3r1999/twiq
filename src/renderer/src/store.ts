// 外壳的全局状态：主进程推来的 AppState、提示条，以及拖动属性面板期间的临时状态（v0.9.1）。
import { create } from 'zustand'
import { setLang } from '../../shared/i18n'
import type { AppState, ChangesView, ShellCommand, ToastMsg } from '../../shared/types'

/** 拖动面板时盖在预览区上的冻结画面 */
export interface FreezeView {
  url: string
  /** 页面背景色：画面缩小后下方露出的部分填这个颜色 */
  bg: string
}

interface Store {
  app: AppState | null
  toast: (ToastMsg & { key: number }) | null
  /** 非空时预览区显示冻结画面，实时页面被隐藏 */
  freeze: FreezeView | null
  /** 拖动面板时外壳本地算出的适应缩放：只影响工具栏上那一行字，不牵动整棵树重渲染 */
  dragFit: number | null
  /** 属性面板显示哪一页（v0.10）：元素属性，或本次改动 */
  panelView: 'props' | 'changes'
  setPanelView(v: 'props' | 'changes'): void
  /** 改动列表（v0.10，主进程单独推送） */
  changes: ChangesView | null
  /** 从改动列表点去页面上的元素 eid：选中变成它时不切回属性页 */
  markGoto(eid: number): void
  /** 选中变成了 eid：是不是刚才从列表点过去的（取一次就清掉） */
  takeGoto(eid: number): boolean
  setApp(s: AppState): void
  showToast(t: ToastMsg): void
  hideToast(): void
  setFreeze(v: FreezeView | null): void
  setDragFit(v: number | null): void
}

let toastSeq = 0
let gotoEid: number | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined

export const useStore = create<Store>((set) => ({
  app: null,
  toast: null,
  freeze: null,
  dragFit: null,
  panelView: 'props',
  changes: null,
  markGoto: (eid) => {
    gotoEid = eid
  },
  takeGoto: (eid) => {
    const hit = gotoEid === eid
    gotoEid = null
    return hit
  },
  // 面板挂载、卸载与切页时由 Panel 告诉主进程要不要附带完整列表
  setPanelView: (panelView) => set({ panelView }),
  setApp: (app) => {
    // 先切语言再更新状态：这一轮渲染读到的文案就是新语言（v0.10）
    setLang(app.lang)
    document.documentElement.lang = app.lang === 'zh' ? 'zh-CN' : 'en'
    set({ app })
  },
  setFreeze: (freeze) => set({ freeze }),
  setDragFit: (dragFit) => set({ dragFit }),
  showToast: (t) => {
    // 无论外壳是否显示这条 toast，到时都从 store 清掉，避免关闭最后一个标签后旧 toast 重新出现
    clearTimeout(toastTimer)
    const key = ++toastSeq
    set({ toast: { ...t, key } })
    toastTimer = setTimeout(() => {
      if (useStore.getState().toast?.key === key) set({ toast: null })
    }, t.duration ?? (t.level === 'error' ? 4000 : t.level === 'warn' ? 3200 : 2200))
  },
  hideToast: () => {
    clearTimeout(toastTimer)
    set({ toast: null })
  }
}))

export const cmd = (c: ShellCommand): void => void window.hw.cmd(c)

/** 文件名最长 18 字符，超出中间省略（6.2）。 */
export function middleEllipsis(s: string, max = 18): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}
