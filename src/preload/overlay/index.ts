// 叠加层：悬停框、编辑框、气泡、浮动工具条、toast、拖拽遮罩（规格 8、9）。
// 挂载在 documentElement 末尾，closed 影子 DOM，宿主 fixed、inset 0、pointer-events none。
import { PAD, place } from '../../shared/position'
import type { Guide } from '../../shared/snap'
import type { ResolvedTheme, ToastLevel } from '../../shared/types'
import { lang } from '../../shared/i18n'
import { S } from '../strings'
import { OVERLAY_CSS } from './styles'

export interface ToolbarActions {
  done(): void
  undoInput(): void
  abandon(): void
  /** 文字格式（v0.3） */
  format(tag: 'b' | 'i' | 'u' | 's' | 'sup' | 'sub'): void
  /** 选中元素的操作（v0.2） */
  selectParent(): void
  duplicate(): void
  remove(): void
  /** 尺寸手柄按下（v0.3；v0.6 起四角四边） */
  resizeStart(edge: Edge, e: PointerEvent): void
  /** 块把手按下（v0.8.1）：整块拖动 */
  blockDrag(el: HTMLElement, e: PointerEvent): void
}

/** 尺寸手柄：四边 n e s w 与四角 ne se sw nw */
export type Edge = 'n' | 'e' | 's' | 'w' | 'ne' | 'se' | 'sw' | 'nw'
export const EDGES: Edge[] = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']
const EDGE_TITLE = (edge: Edge): string => (edge === 'n' || edge === 's' ? S.resizeH : edge === 'e' || edge === 'w' ? S.resizeW : S.resizeWH)

export type DropLine = { x: number; y: number; w: number; h: number } | null

function div(cls: string, parent: Node): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  parent.appendChild(d)
  return d
}

export class Overlay {
  readonly host: HTMLElement
  private root: HTMLDivElement
  private hoverBox: HTMLDivElement
  private focusBox: HTMLDivElement
  private editBox: HTMLDivElement
  private editLabel: HTMLDivElement
  private rejectBox: HTMLDivElement
  private recordedBox: HTMLDivElement
  private bubble: HTMLDivElement
  private toolbar: HTMLDivElement
  private menu: HTMLDivElement
  private toastEl: HTMLDivElement
  private mask: HTMLDivElement
  private selectBox: HTMLDivElement
  private selectLabel: HTMLDivElement
  private selToolbar: HTMLDivElement
  private dropLine: HTMLDivElement
  private blankLayer: HTMLDivElement
  private handles = new Map<Edge, HTMLDivElement>()
  private sizeTip: HTMLDivElement
  private guideLayer: HTMLDivElement
  private siblingLayer: HTMLDivElement
  private parentBox: HTMLDivElement
  private blockBox: HTMLDivElement
  private blockGrip: HTMLDivElement
  private blockTarget: Element | null = null
  private ghost: HTMLDivElement
  private multiLayer: HTMLDivElement
  private multiTargets: Element[] = []
  private siblingTargets: Element[] = []
  private parentTarget: Element | null = null
  private handleEdges: Edge[] = []
  private selectTarget: Element | null = null
  private blankTargets: Element[] = []
  private hoverTarget: Element | null = null
  private focusTarget: Element | null = null
  private editTarget: Element | null = null
  private bubbleTarget: Element | null = null
  private ro: ResizeObserver
  private toastTimer = 0
  private rejectTimer = 0
  private recordedTimer = 0
  private bubbleTimer = 0
  private theme: ResolvedTheme = 'light'
  /** 语言切换时重写文案（v0.10）：每个带文字的控件登记一个写文案的函数 */
  private labels: (() => void)[] = []
  reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(actions: ToolbarActions) {
    this.host = document.createElement('hw-overlay-root')
    this.host.id = 'hw-overlay-root'
    this.host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: 2147483647 !important; display: block !important;'
    const shadow = this.host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = OVERLAY_CSS
    shadow.appendChild(style)
    this.root = div('root', shadow)
    this.root.dataset.theme = this.theme
    this.host.dataset.theme = this.theme
    this.hoverBox = div('box hover fade', this.root)
    this.focusBox = div('box focus', this.root)
    this.recordedBox = div('box recorded fade-slow', this.root)
    this.editBox = div('box edit', this.root)
    this.editLabel = div('label', this.editBox)
    this.label(() => (this.editLabel.textContent = S.editLabel))
    this.rejectBox = div('box reject-box', this.root)
    this.blankLayer = div('blank-layer', this.root)
    this.parentBox = div('box parent-area', this.root)
    this.siblingLayer = div('sibling-layer', this.root)
    this.multiLayer = div('multi-layer', this.root)
    this.selectBox = div('box select', this.root)
    this.selectLabel = div('label', this.selectBox)
    // v0.8.1：悬停时标出所在「块」，左上角给一个把手；拖把手＝整块移动
    this.blockBox = div('box block', this.root)
    this.blockGrip = div('block-grip', this.root)
    this.label(() => {
      this.blockGrip.title = S.blockGrip
      this.blockGrip.setAttribute('aria-label', S.blockGrip)
    })
    this.blockGrip.addEventListener('pointerdown', (e) => {
      if (!this.blockTarget) return
      // 不在 pointerdown 上 preventDefault：Chromium 会连这次的 mousemove 一起吞掉，拖不动
      e.stopPropagation()
      actions.blockDrag(this.blockTarget as HTMLElement, e)
    })
    // 改在 mousedown 上阻止默认行为：只挡掉选字和聚焦，不影响后面的 mousemove
    this.blockGrip.addEventListener('mousedown', (e) => e.preventDefault())
    for (const edge of EDGES) {
      const h = div(`handle h-${edge}`, this.root)
      this.label(() => (h.title = EDGE_TITLE(edge)))
      h.dataset.edge = edge
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        actions.resizeStart(edge, e)
      })
      this.handles.set(edge, h)
    }
    this.guideLayer = div('guide-layer', this.root)
    this.ghost = div('ghost', this.root)
    this.sizeTip = div('size-tip', this.root)
    this.dropLine = div('drop-line', this.root)
    this.bubble = div('bubble', this.root)
    this.bubble.setAttribute('role', 'tooltip')
    this.toolbar = div('toolbar', this.root)
    this.toolbar.setAttribute('role', 'toolbar')
    this.label(() => this.toolbar.setAttribute('aria-label', S.editToolbar))
    const isMac = navigator.platform.toLowerCase().includes('mac')
    const mod = isMac ? 'Cmd' : 'Ctrl'
    const done = this.button(() => S.done, () => S.doneTip, actions.done, 'done')
    this.toolbar.appendChild(done)
    const wrap = div('more-wrap', this.toolbar)
    const more = this.button(() => '⋯', () => S.more, () => this.menu.classList.toggle('on'))
    more.setAttribute('aria-haspopup', 'menu')
    wrap.appendChild(more)
    this.menu = div('menu', wrap)
    this.menu.setAttribute('role', 'menu')
    this.menu.appendChild(this.button(() => S.undoInput, () => S.undoInputTip(mod), () => {
      this.menu.classList.remove('on')
      actions.undoInput()
    }))
    this.menu.appendChild(this.button(() => S.abandon, () => S.abandonTip, () => {
      this.menu.classList.remove('on')
      actions.abandon()
    }))
    // 文字格式按钮（v0.3）放在「更多」之后，「完成」与「更多」的位置与 v0.1 一致
    div('sep', this.toolbar)
    const fmt: [string, () => string, 'b' | 'i' | 'u' | 's' | 'sup' | 'sub', string][] = [
      ['B', () => S.bold(mod), 'b', 'f-b'],
      ['I', () => S.italic(mod), 'i', 'f-i'],
      ['U', () => S.underline(mod), 'u', 'f-u'],
      ['S', () => S.strike, 's', 'f-s'],
      ['x²', () => S.sup, 'sup', ''],
      ['x₂', () => S.sub, 'sub', '']
    ]
    for (const [t, title, tag, cls] of fmt) this.toolbar.appendChild(this.button(() => t, title, () => actions.format(tag), `fmt ${cls}`))
    this.selToolbar = div('toolbar', this.root)
    this.selToolbar.setAttribute('role', 'toolbar')
    this.label(() => this.selToolbar.setAttribute('aria-label', S.selToolbar))
    this.selToolbar.appendChild(this.button(() => S.parent, () => S.parentTip, actions.selectParent))
    this.selToolbar.appendChild(this.button(() => S.duplicate, () => S.duplicateTip(mod), actions.duplicate))
    this.selToolbar.appendChild(this.button(() => S.remove, () => S.removeTip, actions.remove, 'danger'))
    this.toastEl = div('toast', this.root)
    this.toastEl.addEventListener('click', () => this.hideToast())
    this.mask = div('mask', this.root)
    if (this.reduced) this.root.classList.add('reduced')
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.reduced = e.matches
      this.root.classList.toggle('reduced', e.matches)
    })

    this.ro = new ResizeObserver(() => this.reposition())
    const re = (): void => this.reposition()
    window.addEventListener('scroll', re, { capture: true, passive: true })
    window.addEventListener('resize', re, { passive: true })
  }

  /** 登记并立即执行一个写文案的函数；relabel() 时按当前语言重写 */
  private label(fn: () => void): void {
    this.labels.push(fn)
    fn()
  }

  /** 界面语言变了（v0.10）：重写所有静态文案。气泡、toast 等按需显示的文字在显示时取当前语言。
   *  宿主的 lang 让读屏按叠加层自己的语言朗读，与页面的 lang 无关 */
  relabel(): void {
    this.host.setAttribute('lang', lang() === 'zh' ? 'zh-CN' : 'en')
    for (const fn of this.labels) fn()
  }

  private button(text: () => string, title: () => string, fn: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button')
    this.label(() => {
      b.textContent = text()
      b.title = title()
      b.setAttribute('aria-label', title())
    })
    if (cls) b.className = cls
    // 点击工具条按钮不得让 host 失去焦点
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
      e.preventDefault()
      fn()
    })
    return b
  }

  mount(): void {
    if (!this.host.isConnected && document.documentElement) document.documentElement.appendChild(this.host)
    this.detectDark()
  }

  /** v0.9：应用外观（浅/深）只影响叠加层 chrome；页面自身的明暗另由 detectDark 决定。 */
  setTheme(theme: ResolvedTheme): void {
    this.theme = theme
    this.root.dataset.theme = theme
    this.host.dataset.theme = theme
    this.detectDark()
  }

  detectDark(): void {
    const bg = document.body ? getComputedStyle(document.body).backgroundColor : ''
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(bg)
    let dark = false
    if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
      dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.4
    }
    this.root.classList.toggle('dark-page', dark)
    this.host.dataset.page = dark ? 'dark' : 'light'
  }

  owns(node: EventTarget | null): boolean {
    return node === this.host
  }

  private observe(): void {
    this.ro.disconnect()
    for (const t of [this.hoverTarget, this.focusTarget, this.editTarget, this.bubbleTarget, this.selectTarget, this.parentTarget, this.blockTarget]) if (t) this.ro.observe(t)
  }

  /** 选中框（9.3）：accent 实线、光晕，标签显示标签名与 id；可调整尺寸时显示手柄。 */
  setSelected(target: Element | null, label = '', opts: { resizable?: boolean; edges?: Edge[]; actions?: boolean } = {}): void {
    this.selectTarget = target
    this.selectLabel.textContent = label
    this.handleEdges = target && opts.resizable ? (opts.edges ?? EDGES) : []
    for (const [edge, h] of this.handles) h.classList.toggle('on', this.handleEdges.includes(edge))
    this.root.classList.toggle('resizable', this.handleEdges.length > 0)
    this.selToolbar.classList.toggle('on', !!target && opts.actions !== false)
    if (target && !this.reduced) {
      this.selToolbar.classList.remove('pop')
      void this.selToolbar.offsetWidth
      this.selToolbar.classList.add('pop')
    }
    this.reposition()
    this.observe()
  }

  get selected(): Element | null {
    return this.selectTarget
  }

  /** 叠加层根节点（影子 DOM 内）：浮动输入框挂在这里，不受页面样式影响。 */
  get layer(): HTMLElement {
    return this.root
  }

  /** 层级（v0.6 拆解第 6 条）：同级兄弟淡色虚线框，父元素内容区浅底。 */
  setSiblings(siblings: Element[], parent: Element | null): void {
    this.siblingTargets = siblings
    this.parentTarget = parent
    this.siblingLayer.replaceChildren(...siblings.map((_, i) => {
      const d = document.createElement('div')
      d.className = 'box sibling on'
      const n = document.createElement('span')
      n.className = 'idx'
      n.textContent = String(i + 1)
      d.appendChild(n)
      return d
    }))
    this.placeSiblings()
  }

  /** 多选：其余被选中的元素（v0.6 拆解第 9 条）。 */
  setMulti(targets: Element[]): void {
    this.multiTargets = targets
    this.multiLayer.replaceChildren(...targets.map(() => {
      const d = document.createElement('div')
      d.className = 'box select multi on'
      return d
    }))
    this.placeList(this.multiLayer, this.multiTargets)
  }

  /** 吸附参考线。 */
  setGuides(guides: Guide[]): void {
    this.guideLayer.replaceChildren(...guides.map((g) => {
      const d = document.createElement('div')
      d.className = `guide guide-${g.axis}`
      if (g.axis === 'x') Object.assign(d.style, { left: `${g.at - 0.5}px`, top: `${g.from}px`, height: `${Math.max(1, g.to - g.from)}px` })
      else Object.assign(d.style, { top: `${g.at - 0.5}px`, left: `${g.from}px`, width: `${Math.max(1, g.to - g.from)}px` })
      return d
    }))
  }

  /** 拖动时跟随光标的影子：元素轮廓与标签名。 */
  setGhost(g: { x: number; y: number; w: number; h: number; label: string } | null): void {
    if (!g) {
      this.ghost.classList.remove('on')
      return
    }
    this.ghost.textContent = g.label
    Object.assign(this.ghost.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` })
    this.ghost.classList.add('on')
  }

  private placeList(layer: HTMLElement, targets: Element[]): void {
    const boxes = layer.children
    targets.forEach((t, i) => {
      const b = boxes[i] as HTMLElement | undefined
      if (!b) return
      if (!t.isConnected) return void (b.style.display = 'none')
      const r = t.getBoundingClientRect()
      Object.assign(b.style, { display: '', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    })
  }

  private placeSiblings(): void {
    this.placeList(this.siblingLayer, this.siblingTargets)
    this.placeBox(this.parentBox, this.parentTarget)
  }

  /** 拖放线：pop 色 3px（20.2）。 */
  setDropLine(line: DropLine): void {
    if (!line) {
      this.dropLine.classList.remove('on')
      return
    }
    Object.assign(this.dropLine.style, { left: `${line.x}px`, top: `${line.y}px`, width: `${line.w}px`, height: `${line.h}px` })
    this.dropLine.classList.add('on')
  }

  setSizeTip(text: string | null, x = 0, y = 0): void {
    if (!text) {
      this.sizeTip.classList.remove('on')
      return
    }
    this.sizeTip.textContent = text
    this.sizeTip.style.left = `${x + 12}px`
    this.sizeTip.style.top = `${y + 12}px`
    this.sizeTip.classList.add('on')
  }

  /** 显示空白：粉色虚线框标出没有文字也没有媒体的容器（20.2）。 */
  setBlank(targets: Element[]): void {
    this.blankTargets = targets
    this.blankLayer.replaceChildren(...targets.map(() => {
      const d = document.createElement('div')
      d.className = 'box blank on'
      return d
    }))
    this.placeBlank()
  }

  private placeBlank(): void {
    const boxes = this.blankLayer.children
    this.blankTargets.forEach((t, i) => {
      const b = boxes[i] as HTMLElement
      if (!t.isConnected) return void (b.style.display = 'none')
      const r = t.getBoundingClientRect()
      Object.assign(b.style, { display: '', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    })
  }

  private placeBlock(): void {
    const t = this.blockTarget as HTMLElement | null
    if (!t || !t.isConnected) {
      this.blockBox.classList.remove('on')
      this.blockGrip.classList.remove('on')
      return
    }
    const r = t.getBoundingClientRect()
    // 只给「块」大小的元素画范围虚线；整篇 section 这么大的容器只给把手，不然满屏都是虚线
    if (r.height <= 360) this.placeBox(this.blockBox, t)
    else this.blockBox.classList.remove('on')
    const W = window.innerWidth
    const gw = 14
    // 放在块内左上角：网格里相邻块挨得近，放到外面会看起来像上一个块的把手
    let x = r.left + 8
    const y = r.top + 8
    if (x + gw > W - 4) x = W - gw - 4
    this.blockGrip.style.left = `${x}px`
    this.blockGrip.style.top = `${y}px`
  }

  private placeBox(box: HTMLElement, target: Element | null): void {
    if (!target || !target.isConnected) {
      box.classList.remove('on')
      return
    }
    const r = target.getBoundingClientRect()
    box.style.left = `${r.left}px`
    box.style.top = `${r.top}px`
    box.style.width = `${r.width}px`
    box.style.height = `${r.height}px`
    box.classList.add('on')
  }

  /** 手柄周围一小圈也算块的地盘：鼠标贴着块边缘挪到手柄上时，块和手柄不能先消失。 */
  keepsBlock(x: number, y: number): boolean {
    if (!this.blockTarget || !this.blockGrip.classList.contains('on')) return false
    const g = this.blockGrip.getBoundingClientRect()
    if (!g.width) return false
    return x >= g.left - 6 && x <= g.right + 6 && y >= g.top - 6 && y <= g.bottom + 6
  }

  /** 悬停元素所在的「块」（v0.8.1）：淡虚线标出块的范围，左上角给一个拖动手柄。 */
  setBlock(target: Element | null): void {
    if (target === this.blockTarget && (!target || this.blockGrip.classList.contains('on'))) return
    this.blockTarget = target
    this.blockBox.classList.toggle('on', !!target && target !== this.hoverTarget)
    this.blockGrip.classList.toggle('on', !!target)
    this.reposition()
    this.observe()
  }

  setHover(target: Element | null, editable: boolean): void {
    this.hoverTarget = target
    this.hoverBox.classList.toggle('uneditable', !editable)
    this.placeBox(this.hoverBox, target)
    this.observe()
  }

  setFocus(target: Element | null): void {
    this.focusTarget = target
    this.placeBox(this.focusBox, target)
    this.observe()
  }

  setEditing(target: Element | null): void {
    this.editTarget = target
    this.editBox.classList.remove('reject')
    this.placeBox(this.editBox, target)
    this.menu.classList.remove('on')
    if (target) {
      this.toolbar.classList.add('on')
      if (!this.reduced) this.toolbar.classList.add('pop')
    } else {
      this.toolbar.classList.remove('on', 'pop')
    }
    this.reposition()
    this.observe()
  }

  /** 被拒：框闪一下 600ms（做不到为琥珀色，真的出错为红色）；减少动效时静态显示 1.2 秒。 */
  reject(target: Element, level: 'warn' | 'error' = 'warn'): void {
    clearTimeout(this.rejectTimer)
    this.rejectBox.classList.toggle('error', level === 'error')
    this.placeBox(this.rejectBox, target)
    this.rejectTimer = window.setTimeout(() => this.rejectBox.classList.remove('on'), this.reduced ? 1200 : 600)
  }

  /** 已记录反馈：浅绿底淡出 400ms。 */
  recorded(target: Element): void {
    clearTimeout(this.recordedTimer)
    this.placeBox(this.recordedBox, target)
    this.recordedBox.style.opacity = '1'
    if (this.reduced) {
      this.recordedTimer = window.setTimeout(() => this.recordedBox.classList.remove('on'), 400)
      return
    }
    requestAnimationFrame(() => {
      this.recordedBox.style.opacity = '0'
      this.recordedTimer = window.setTimeout(() => this.recordedBox.classList.remove('on'), 420)
    })
  }

  showBubble(target: Element, why: string, next: string, autoHideMs = 0): void {
    clearTimeout(this.bubbleTimer)
    this.bubbleTarget = target
    this.bubble.replaceChildren()
    div('why', this.bubble).textContent = why
    div('next', this.bubble).textContent = next
    this.bubble.classList.add('on')
    if (!this.reduced) {
      this.bubble.classList.remove('pop')
      void this.bubble.offsetWidth
      this.bubble.classList.add('pop')
    }
    this.reposition()
    this.observe()
    if (autoHideMs) this.bubbleTimer = window.setTimeout(() => this.hideBubble(), autoHideMs)
  }

  hideBubble(): void {
    clearTimeout(this.bubbleTimer)
    this.bubbleTarget = null
    this.bubble.classList.remove('on')
    this.observe()
  }

  get bubbleOn(): boolean {
    return this.bubble.classList.contains('on')
  }

  toast(text: string, sub: string | undefined, level: ToastLevel, ms: number): void {
    clearTimeout(this.toastTimer)
    this.toastEl.replaceChildren(document.createTextNode(text))
    if (sub) {
      const s = document.createElement('span')
      s.className = 'sub'
      s.textContent = sub
      this.toastEl.appendChild(s)
    }
    this.toastEl.classList.toggle('error', level === 'error')
    this.toastEl.classList.toggle('warn', level === 'warn')
    this.toastEl.setAttribute('role', level === 'error' ? 'alert' : 'status')
    this.toastEl.classList.add('on')
    if (!this.reduced) {
      this.toastEl.classList.remove('pop')
      void this.toastEl.offsetWidth
      this.toastEl.classList.add('pop')
    }
    this.toastTimer = window.setTimeout(() => this.hideToast(), ms)
  }

  hideToast(): boolean {
    const was = this.toastEl.classList.contains('on')
    clearTimeout(this.toastTimer)
    this.toastEl.classList.remove('on')
    return was
  }

  setMask(state: { active: boolean; ok: boolean } | null): void {
    if (!state?.active) {
      this.mask.classList.remove('on')
      return
    }
    this.mask.replaceChildren()
    this.mask.classList.toggle('bad', !state.ok)
    div('', this.mask).textContent = state.ok ? S.dropOk : S.dropBad
    if (state.ok) div('sub', this.mask).textContent = S.dropMany
    this.mask.classList.add('on')
  }

  clearAll(): void {
    this.setHover(null, true)
    this.setFocus(null)
    this.setEditing(null)
    this.setSelected(null)
    this.setSiblings([], null)
    this.setMulti([])
    this.setGuides([])
    this.setBlock(null)
    this.setGhost(null)
    this.setDropLine(null)
    this.setBlank([])
    this.hideBubble()
  }

  /** 滚动、窗口大小变化、元素大小变化时重新计算位置（9.4 第 8 条，不使用逐帧循环）。 */
  reposition(): void {
    this.placeBox(this.hoverBox, this.hoverTarget)
    this.placeBox(this.focusBox, this.focusTarget)
    this.placeBox(this.editBox, this.editTarget)
    this.placeBox(this.selectBox, this.selectTarget)
    this.placeBlock()
    if (this.blankTargets.length) this.placeBlank()
    if (this.siblingTargets.length || this.parentTarget) this.placeSiblings()
    if (this.multiTargets.length) this.placeList(this.multiLayer, this.multiTargets)
    const W = window.innerWidth
    const H = window.innerHeight
    if (this.selectTarget && this.selectTarget.isConnected) {
      const r = this.selectTarget.getBoundingClientRect()
      this.selectLabel.classList.toggle('inside', r.top < 24)
      // 手柄中心落在边与角上；小元素时边手柄隐藏，只留四角
      const small = r.width < 40 || r.height < 28
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const pos: Record<Edge, [number, number]> = {
        n: [cx, r.top], s: [cx, r.bottom], e: [r.right, cy], w: [r.left, cy],
        ne: [r.right, r.top], se: [r.right, r.bottom], sw: [r.left, r.bottom], nw: [r.left, r.top]
      }
      for (const [edge, h] of this.handles) {
        const [x, y] = pos[edge]
        h.style.left = `${x}px`
        h.style.top = `${y}px`
        h.classList.toggle('hidden-small', small && edge.length === 1)
      }
      if (this.selToolbar.classList.contains('on')) {
        const w = this.selToolbar.offsetWidth
        const h = this.selToolbar.offsetHeight
        const inside = r.top < 24
        let p = place('toolbar', inside ? r : { left: r.left, right: r.right, top: r.top - 24, bottom: r.bottom }, W, H, w, h)
        if (!inside && p.y > r.top - 24 - h) p = place('toolbar', r, W, H, w, h)
        // 工具条靠右对齐，避免挡住左上角的标签
        const x = Math.max(PAD, Math.min(W - w - PAD, r.right - w))
        let y = p.y
        // v0.8：选中后再点一次要进入改字，工具条不能盖住元素；上方放不下时优先放到下方
        if (y + h > r.top && y < r.bottom && r.bottom + 8 + h <= H - PAD) y = r.bottom + 8
        this.selToolbar.style.left = `${x}px`
        this.selToolbar.style.top = `${y}px`
      }
    }
    if (this.editTarget && this.editTarget.isConnected) {
      const r = this.editTarget.getBoundingClientRect()
      const inside = r.top < 24
      this.editLabel.classList.toggle('inside', inside)
      this.toolbar.style.maxWidth = ''
      // 标签在框外左上角时，把它的高度算进元素矩形，避免工具条压住标签
      const w = this.toolbar.offsetWidth
      const h = this.toolbar.offsetHeight
      let p = place('toolbar', inside ? r : { left: r.left, right: r.right, top: r.top - 24, bottom: r.bottom }, W, H, w, h)
      // 上方放不下、退到框内时，按元素本身的矩形计算（标签在框外，不会冲突）
      if (!inside && p.y > r.top - 24 - h) p = place('toolbar', r, W, H, w, h)
      // 上方放不下「标签 + 工具条」时，工具条会落在标签那一行：往右让出标签的宽度，不盖住它（v0.10）
      let x = p.x
      if (!inside && p.y < r.top && p.y + h > r.top - 24) x = Math.max(x, Math.min(W - w - PAD, r.left + this.editLabel.offsetWidth + 6))
      this.toolbar.style.left = `${x}px`
      this.toolbar.style.top = `${p.y}px`
      if (p.maxWidth) {
        this.toolbar.style.maxWidth = `${p.maxWidth}px`
        this.toolbar.style.whiteSpace = 'normal'
      }
    }
    if (this.bubbleTarget && this.bubble.classList.contains('on')) {
      if (!this.bubbleTarget.isConnected) return this.hideBubble()
      const r = this.bubbleTarget.getBoundingClientRect()
      this.bubble.style.maxWidth = ''
      const p = place('bubble', r, W, H, this.bubble.offsetWidth, this.bubble.offsetHeight)
      this.bubble.style.left = `${p.x}px`
      this.bubble.style.top = `${p.y}px`
      if (p.maxWidth) this.bubble.style.maxWidth = `${p.maxWidth}px`
    }
  }
}
