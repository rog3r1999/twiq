import type { SvgModel } from './svg'
// 共享类型，对应规格 13.1 与 12.3。

export type Eid = number

export type ReasonCode =
  | 'SCRIPT_GENERATED'
  | 'MISMATCH'
  | 'IN_PRE'
  | 'IN_SVG'
  | 'IN_FORM_CONTROL'
  | 'BLOCK_CHILDREN'
  | 'IMPLIED_ELEMENT'
  | 'COMMENT_IN_SLOT'
  | 'READONLY_FILE'

export interface Token {
  rawStart: number // 相对槽原文的偏移
  rawEnd: number
  decoded: string
}

export interface SlotInfo {
  start: number // 槽在 source 中的起点（UTF-16 偏移）
  end: number // 终点（不含）；空槽 start === end
  raw: string // 源码原文，可含实体
  text: string // 解码后的文字
  tokens: Token[] // 实体 token 化结果，见 13.7
  hasComment: boolean // 槽内是否夹有注释节点
  anchorOk: boolean // 空槽插入时锚点是否明确（13.7 第 9 条）
  broken?: boolean // 文本节点在源码中不连续，整槽不可编辑
}

export interface AttrInfo {
  start: number
  end: number
  value: string // 解码后的值
}

export interface ElementInfo {
  eid: Eid
  tag: string // 小写标签名
  parent: Eid | null // 父元素为隐含元素时为 null
  children: Eid[] // 直接子元素 eid（仅显式出现的）
  hasImpliedChild: boolean // 直接子节点中有没有 eid 的元素
  slots: SlotInfo[] // 长度 = children.length + 1
  startTagStart: number
  startTagEnd: number
  /** 元素在源码中的终点（不含）：结束标签之后；空元素为起始标签之后 */
  end: number
  /** 结束标签起点；没有结束标签时为 null */
  endTagStart: number | null
  /** 起止标签都显式存在（或为空元素、自闭合）：只有这样的元素才能删除、复制、移动（20.2） */
  rangeOk: boolean
  /** 结束标签被省略（li、p 等）：区间取到最后一个子节点为止 */
  impliedEnd?: boolean
  /** 起始标签里各属性在源码中的位置（属性名小写） */
  attrs: Record<string, AttrInfo>
  tagNameLength: number // 源码中标签名原文长度
  isHost: boolean
  hostId?: Eid // 若属于某 host，指向该 host
  uneditableReason?: ReasonCode
}

export interface SetSlotOp {
  eid: Eid
  slot: number
  newText: string
}

export interface Patch {
  start: number
  end: number
  text: string
}

export interface UndoEntry {
  forward: Patch[] // 已应用的补丁
  inverse: Patch[] // 撤销用补丁（坐标为应用后的 source）
  ops: SetSlotOp[] // 同次提交的 op
  inverseOps: SetSlotOp[] // 撤销时通知预览同步用
  coalesceKey?: string // 合并键，见 13.9
  at: number // 时间戳（毫秒）
  /** text：槽文字（预览按 op 同步）；attr：属性（预览按属性同步）；struct：结构变化（预览重新载入） */
  kind?: 'text' | 'attr' | 'struct'
  /** attr 类：涉及的元素与属性 */
  attrs?: { eid: Eid; name: string }[]
}

/** 撤销 / 重做 / 提交后，预览需要做的同步。 */
export type PreviewSync =
  | { kind: 'text'; ops: SetSlotOp[] }
  | { kind: 'attr'; attrs: { eid: Eid; name: string; value: string | null }[] }
  | { kind: 'struct'; select: Eid | null; dom?: DomSync | null }

/**
 * 结构变化的就地同步步骤（v0.6）：预览按此改 DOM，不整页重载。
 * map：旧 eid → 新 eid（-1 表示被删或被移走）；remove：要删的旧元素；detach：要移走、稍后插回的旧元素；
 * inserts：按顺序执行，from 为被移走的旧元素，html 为新片段（已带 data-hw）；
 *   parent 为 null 时父元素是隐含元素，按紧挨的兄弟 before / after 定位；
 * slots：受影响元素的新槽文字与子元素序列，同步后用来校验，不一致就整页重载。
 */
export interface DomSync {
  map: Eid[]
  remove: Eid[]
  detach: Eid[]
  inserts: { eid: Eid; parent: Eid | null; before: Eid | null; after?: Eid | null; from?: Eid; html?: string }[]
  slots: { eid: Eid; tag: string; slots: string[]; children: Eid[] }[]
}

/** edit：点击改文字；select：点击选中元素（v0.2）；preview：页面交互放行 */
// ---------- 结构与属性类 op（规格 20） ----------

export type Where = 'before' | 'after'
export type InsertWhere = Where | 'prepend' | 'append'

export type FormatTag = 'b' | 'i' | 'u' | 's' | 'sup' | 'sub'
/** 视为同一种格式的标签（取消格式时一并识别） */
export const FORMAT_ALIASES: Record<FormatTag, string[]> = {
  b: ['b', 'strong'],
  i: ['i', 'em'],
  u: ['u'],
  s: ['s', 'del', 'strike'],
  sup: ['sup'],
  sub: ['sub']
}

/** 槽内的一个位置：元素 eid 的第 slot 个槽、解码后文字的第 offset 个字符之前。 */
export interface SlotPoint {
  eid: Eid
  slot: number
  offset: number
}

export type StructOp =
  | { type: 'delete'; eid: Eid }
  | { type: 'duplicate'; eid: Eid }
  | { type: 'move'; eid: Eid; target: Eid; where: Where }
  | { type: 'insertHtml'; eid: Eid | null; where: InsertWhere; html: string }
  | { type: 'setAttr'; eid: Eid; name: string; value: string | null }
  | { type: 'setStyle'; eid: Eid; props: Record<string, string | null> }
  | { type: 'format'; start: SlotPoint; end: SlotPoint; tag: FormatTag }
  | { type: 'unwrap'; eid: Eid }
  | { type: 'replaceAll'; source: string }
  /** 多选（v0.6）：同一批删除、复制、改样式、改属性，一步撤销 */
  | { type: 'batch'; ops: StructOp[] }
  /** 多选拖放：按文档顺序整体移到 target 前后 */
  | { type: 'moveMany'; eids: Eid[]; target: Eid; where: Where }
  /** 用新原文替换整个元素（SVG 源码编辑，v0.6） */
  | { type: 'replaceElement'; eid: Eid; html: string }


/** v0.8：文字与选择合并为一个编辑模式；单击选中，再点一次已选中的文字进入改字 */
export type Mode = 'edit' | 'preview'

/** v0.9：用户选择的外观偏好；system 跟随操作系统实时变化 */
export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
/** 界面语言（v0.10）；system 跟随操作系统的首选语言 */
export type Lang = 'zh' | 'en'
export type LangPreference = 'system' | Lang

/** 发给预览 preload 的元素表摘要（每个有 eid 的元素一项）。 */
export interface PreviewElement {
  eid: Eid
  tag: string
  host: boolean
  hostId?: Eid
  reason?: ReasonCode
  /** 该元素自身是否有非空白的源码文字（用于不可编辑高亮的判定） */
  hasText: boolean
  /** 源码中各槽解码后的文字（仅 host 及其子孙，用于预览端的期望比对与统计） */
  slots?: string[]
  /** 位于 host 内的原子内联元素（img、svg、input）或其子孙 */
  atomic?: boolean
  /** 起止标签都显式存在，可以删除、复制、移动（20.2） */
  range?: boolean
}

/** 选中元素的信息（属性面板用，v0.3）。 */
export interface SelectionInfo {
  eid: Eid
  tag: string
  id: string
  cls: string
  /** 源码里的 style 属性值 */
  style: string
  /** 计算样式 */
  computed: Record<string, string>
  width: number
  height: number
  /** 可编辑的常用属性（源码值） */
  attrs: Record<string, string>
  range: boolean
  host: boolean
  /** 父元素是弹性或网格布局 */
  flexParent: boolean
  /** 组件规范（20.4）：data-c 与 data-slot */
  component?: string
  slot?: string
  /** 层级（v0.6）：在同级可见元素里的序号（从 1 起）与同级总数 */
  index?: number
  siblings?: number
  /** 多选时全部选中元素的 eid（含当前元素） */
  multi?: Eid[]
  /** SVG：root 为 svg 本身，child 为内部元素 */
  svg?: 'root' | 'child'
  /** 不能删除、复制、移动的原因 */
  reason?: 'RANGE'
}

export interface PageStats {
  visible: number
  editable: number
  reasons: Partial<Record<ReasonCode, number>>
  /** 页面里的 DOM 元素数（v0.9.1）：判断拖动面板时要不要冻结预览 */
  nodes?: number
}

export interface PreviewInit {
  tabId: string
  mode: Mode
  readOnly: ReasonCode | null
  elements: PreviewElement[]
  scrollY: number
  zoom: number
  isMac: boolean
  /** 载入后选中的元素（结构类操作之后） */
  select: Eid | null
  /** 载入后进入文字编辑的 host（文字格式之后） */
  editHost: Eid | null
  /** 进入文字编辑后的选区（host 文字内的字符偏移） */
  caret: { start: number; end: number } | null
  showBlank: boolean
  /** 叠加层使用的解析后外观；不改变被预览页面自身 */
  theme: ResolvedTheme
  lang: Lang
}

/** 快照：host 内每个带 data-hw 的元素 */
export interface SnapshotElement {
  eid: Eid
  children: Eid[]
  slots: string[]
  hasComment: boolean[]
}

export interface Snapshot {
  host: Eid
  elements: SnapshotElement[]
  /** host 内是否有不带 data-hw 的元素（脚本插入） */
  foreign: boolean
}

export interface TabSummary {
  id: string
  name: string
  path: string | null
  dirty: boolean
  readOnly: ReasonCode | null
  readOnlyKind: 'encoding' | 'eol' | null
  canUndo: boolean
  canRedo: boolean
  mode: Mode
  isSample: boolean
  missing: boolean
  editableCount: number
}

export interface HoverInfo {
  breadcrumb: string[]
  fullSelector: string
  selectors: string[] // 与 breadcrumb 逐段对应：从根到该段的选择器
  eids?: (Eid | null)[] // 与 breadcrumb 逐段对应：该段元素的 eid（可点击选中，v0.2）
  editable: boolean
  reason?: ReasonCode
}

export type HintKey = 'none' | 'editing' | 'preview' | 'readonly' | 'select' | 'selected'

export interface BannerInfo {
  tabId: string
  dirs: string[]
}

export interface RecentFile {
  path: string
  name: string
  dir: string
  exists: boolean
}

/** 改动面板里的一条（v0.10）：上次保存后的一处改动，文字已截短，供界面显示 */
export interface ChangeItem {
  kind: 'replace' | 'insert' | 'delete' | 'move'
  before: string
  after: string
  /** 改动前后各一小段原文（同一行内），帮助认出位置 */
  ctxBefore: string
  ctxAfter: string
  /** 当前源码里的行号（从 1 起） */
  line: number
  /** 包含这处改动的最内层元素，点击时在页面上选中它 */
  eid: Eid | null
  where: string
  canRevert: boolean
}

export interface ChangeSummary {
  count: number
  removed: number
  added: number
  moved: number
  untouched: number
  total: number
}

export interface ChangesView {
  /** 列表对应的文档版本：定位与撤回时带回来，版本变了就不按下标操作 */
  version: number
  summary: ChangeSummary
  items: ChangeItem[]
  /** 超出列表上限、没有列出的条数 */
  more: number
}

export interface AppState {
  tabs: TabSummary[]
  activeId: string | null
  zoom: number // 百分比
  /** 属性面板挤占预览区时的适应缩放（1 为未挤压，v0.7） */
  fit: number
  /** 属性面板宽度（px，v0.7） */
  panelWidth: number
  viewport: ViewportOption
  editing: boolean
  hover: HoverInfo | null
  banner: BannerInfo | null
  extFail: boolean
  assetsMissing: boolean // 另存到其他目录后，相对路径资源有缺失（13.8 第 7 条）
  recent: RecentFile[]
  statusNote: string | null // 状态栏轻提示（如「暂不支持换行」）
  isMac: boolean
  drag: DragState | null
  selection: SelectionInfo | null
  panelOpen: boolean
  showBlank: boolean
  /** v0.9：外观偏好与解析结果（system 按当前操作系统解析） */
  theme: ThemePreference
  resolvedTheme: ResolvedTheme
  /** v0.10：界面语言偏好与解析结果 */
  langPref: LangPreference
  lang: Lang
  /** v0.10：当前文档相对上次保存的改动处数（完整列表走 changes:view 单独推送） */
  changeCount: number
  /** 应用剪贴板里有元素（v0.3 粘贴） */
  clip: boolean
  /** 选中元素是 svg 或其内部元素时，外层 svg 的 eid 与源码原文（v0.6 源码面板；v0.7 起默认收起，用户点开才显示） */
  svgSource: { eid: Eid; html: string } | null
  /** 同上，外层 svg 内可编辑的文字与形状（v0.7 结构化编辑） */
  svgModel: SvgModel | null
}

export type ViewportOption = 'auto' | '1280' | '768' | '390'

/** info：普通反馈；warn：做不到或不建议这样做（不是用户做错了）；error：真的出错了（写入失败、无法打开等） */
export type ToastLevel = 'info' | 'warn' | 'error'

export interface ToastMsg {
  level: ToastLevel
  text: string
  sub?: string
  /** 毫秒；缺省时普通 2200、提醒 3200、错误 4000 */
  duration?: number
}

export interface PreviewRect {
  x: number
  y: number
  width: number
  height: number
  /** 页面应有的排版宽度（v0.7）：属性面板被拉宽、挤占预览区时，大于 width，页面按比例缩小而不重新排版 */
  full?: number
}

/**
 * 拖动属性面板时给外壳的冻结画面（v0.9.1 性能专项）：拖动期间页面不再逐帧重排，
 * 外壳按帧缩放这张图；松手后主进程按最终尺寸重排，画好第一帧再换回实时页面。
 */
export interface FreezeShot {
  /** 预览区当前画面的 PNG data URL（设备像素） */
  url: string
  /** 取景时预览视图的 CSS 宽高 */
  width: number
  height: number
  /** 页面背景色：冻结画面下方露出的部分填这个颜色 */
  bg: string
}

export interface DragState {
  active: boolean
  ok: boolean
}

/** 应用外壳发给主进程的指令。 */
export type ShellCommand =
  | { type: 'open' }
  | { type: 'openPaths'; paths: string[] }
  | { type: 'openRecent'; path: string }
  | { type: 'clearRecent' }
  | { type: 'new' }
  | { type: 'sample' }
  | { type: 'save' }
  | { type: 'saveAs' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'mode'; mode?: Mode }
  | { type: 'viewport'; value: ViewportOption }
  | { type: 'zoom'; dir: 1 | -1 | 0 }
  | { type: 'activate'; id: string }
  | { type: 'close'; id: string }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'grantRoot' }
  | { type: 'dismissBanner' }
  | { type: 'focusPreview' }
  | { type: 'drag'; active: boolean; ok: boolean }
  | { type: 'shortcuts' }
  | { type: 'selectEid'; eid: Eid }
  /** 在页面上临时标出一个元素（面板列表悬停，v0.7） */
  | { type: 'peekEid'; eid: Eid | null }
  | { type: 'op'; op: StructOp }
  | { type: 'panel'; open?: boolean }
  /** v0.9：切换外观偏好（跟随系统 / 浅色 / 深色） */
  | { type: 'theme'; value: ThemePreference }
  | { type: 'lang'; value: LangPreference }
  /** 改动面板（v0.10）：打开或关闭列表、定位到第几条、撤回第几条 */
  | { type: 'changesView'; open: boolean }
  | { type: 'gotoChange'; index: number; version: number }
  | { type: 'revertChange'; index: number; version: number }
  /** 拖动属性面板左边缘（v0.7） */
  | { type: 'panelWidth'; width: number }
  | { type: 'showBlank' }
  /** auto：按扩展名判断是图片、视频还是音频（v0.7 合并为一个入口） */
  | { type: 'insertMedia'; kind: 'image' | 'video' | 'audio' | 'auto' }
  | { type: 'copyElement' }
  | { type: 'pasteElement' }
  | { type: 'importFragment' }
  | { type: 'exportPdf' }
  | { type: 'exportText'; format: 'md' | 'txt' }
  | { type: 'normalizeComponents' }
  | { type: 'checkComponents' }
  /** SVG 源码面板（v0.6）：实时预览（html 为 null 时撤销预览）与提交 */
  /** 源码编辑（v0.6 起 SVG，v0.10 起任意元素）：输入时临时替换预览里的元素；提交写成一次补丁 */
  | { type: 'sourcePreview'; eid: Eid; html: string | null }
  | { type: 'sourceApply'; eid: Eid; html: string }
  /** SVG 面板输入中的实时预览（v0.7）：只改预览，不写源码；name 为属性名，或 slot 为文字槽 */
  | { type: 'svgLive'; eid: Eid; name?: string; slot?: number; value: string | null }
  /** SVG 面板提交文字（v0.7）：写回 text / tspan 的一个槽 */
  | { type: 'svgText'; eid: Eid; slot: number; value: string }
  /** 把选中元素的源码复制到系统剪贴板（v0.7） */
  | { type: 'copySource'; eid?: Eid }
  /** v0.10：复制给 AI（源码 + 文件位置）；替换图片 */
  | { type: 'copyForAi'; eid?: Eid }
  | { type: 'replaceImage'; eid?: Eid }
