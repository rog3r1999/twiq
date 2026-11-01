import type { AppState, ChangesView, FreezeShot, PreviewRect, ShellCommand, ToastMsg } from '../../shared/types'

declare global {
  interface Window {
    hw: {
      cmd(cmd: ShellCommand): Promise<void>
      getState(): Promise<AppState | null>
      /** 元素源码原文（v0.10 源码编辑）；没有完整起止标签时为 null */
      source(eid: number): Promise<string | null>
      /** 提交源码；返回是否写入成功 */
      sourceApply(eid: number, html: string): Promise<boolean>
      setRect(rect: PreviewRect): void
      /** 拖动面板时请求一张冻结画面；页面不够重时返回 null（v0.9.1） */
      freeze(): Promise<FreezeShot | null>
      /** 画面已在屏幕上了，这时再隐藏预览视图 */
      freezeCommit(): void
      /** 松手：按最终位置重排页面，画好第一帧后换回实时视图 */
      thaw(rect?: PreviewRect): Promise<void>
      onThawed(fn: () => void): () => void
      onState(fn: (s: AppState) => void): () => void
      /** 改动列表（v0.10）：面板停在「改动」页时推送，列表变了才发 */
      onChanges(fn: (v: ChangesView | null) => void): () => void
      onToast(fn: (t: ToastMsg) => void): () => void
      onFocusShell(fn: () => void): () => void
      pathForFile(file: File): string
    }
  }
}

export {}
