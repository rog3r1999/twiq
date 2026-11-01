// 文案常量，对应规格 10.4、10.5、10.6。v0.10 起中英两份（见 i18n.ts）。
import { localized } from './i18n'
import type { HintKey, ReasonCode } from './types'

export type ReadOnlyKind = 'encoding' | 'eol'

/** 状态栏的一条提示：k 为按键（单独排版，与说明区分），t 为说明。按重要程度排序，空间不够时从后往前隐藏。 */
export interface HintItem {
  k?: string
  t: string
}

type Hints = Record<HintKey, (mod: string, readOnlyKind?: ReadOnlyKind | null) => HintItem[]>

const HINTS = localized<Hints>(
  {
    none: () => [{ t: '打开或拖入一个 HTML 文件开始' }],
    editing: (mod) => [{ k: 'Enter', t: '完成' }, { k: 'Esc', t: '保留并退出' }, { k: 'Tab', t: '下一处' }, { k: `${mod}+B / I / U`, t: '格式' }],
    preview: () => [{ t: '页面按自身逻辑运行' }, { k: 'Esc', t: '返回编辑' }],
    readonly: (_mod, kind) => [{ t: kind === 'eol' ? '只读：换行风格混杂' : '只读：非 UTF-8 编码' }],
    select: (mod) => [{ t: '点击选中' }, { t: '再点一次改文字' }, { t: '拖动换位' }, { k: 'Tab', t: '下一段文字' }, { k: `${mod}+S`, t: '保存' }],
    selected: (mod) => [
      { t: '再点一次改文字' },
      { k: 'Delete', t: '删除' },
      { k: `${mod}+D`, t: '复制' },
      { k: 'Esc', t: '取消' },
      { k: 'Alt+↑↓', t: '父 / 子' },
      { k: 'Alt+←→', t: '同级' },
      { k: 'Shift+点击', t: '多选' },
      { k: 'Alt+拖动', t: '自由移动' }
    ]
  },
  {
    none: () => [{ t: 'Open or drop an HTML file to start' }],
    editing: (mod) => [{ k: 'Enter', t: 'Done' }, { k: 'Esc', t: 'Keep and exit' }, { k: 'Tab', t: 'Next' }, { k: `${mod}+B / I / U`, t: 'Format' }],
    preview: () => [{ t: 'The page runs as it normally would' }, { k: 'Esc', t: 'Back to editing' }],
    readonly: (_mod, kind) => [{ t: kind === 'eol' ? 'Read-only: mixed line endings' : 'Read-only: not UTF-8' }],
    select: (mod) => [{ t: 'Click to select' }, { t: 'Click again to edit text' }, { t: 'Drag to move' }, { k: 'Tab', t: 'Next text' }, { k: `${mod}+S`, t: 'Save' }],
    selected: (mod) => [
      { t: 'Click again to edit text' },
      { k: 'Delete', t: 'Delete' },
      { k: `${mod}+D`, t: 'Duplicate' },
      { k: 'Esc', t: 'Deselect' },
      { k: 'Alt+↑↓', t: 'Parent / child' },
      { k: 'Alt+←→', t: 'Siblings' },
      { k: 'Shift+Click', t: 'Multi-select' },
      { k: 'Alt+Drag', t: 'Free move' }
    ]
  }
)

export function hintItems(key: HintKey, isMac: boolean, readOnlyKind?: ReadOnlyKind | null): HintItem[] {
  return HINTS[key](isMac ? 'Cmd' : 'Ctrl', readOnlyKind)
}

/** 纯文本形式（读屏、提示气泡）。 */
export function hintText(key: HintKey, isMac: boolean, readOnlyKind?: ReadOnlyKind | null): string {
  return hintItems(key, isMac, readOnlyKind)
    .map((h) => (h.k ? `${h.k} ${h.t}` : h.t))
    .join(' · ')
}

/** 脚本改写过的文字：说明为什么不能改，并明确页面本身没有问题（避免用户以为自己改坏了）。 */
const SCRIPT_TEXT_ZH: [string, string] = ['这段文字运行时被页面脚本改写过，和源码对不上。', '页面没有问题；为免覆盖脚本的效果，这里不直接修改。']
const SCRIPT_TEXT_EN: [string, string] = ['A script on the page rewrote this text, so it no longer matches the source.', 'The page is fine. Twiq leaves it alone so the script keeps working.']

/** 不可编辑原因：每条两行，原因 / 下一步。 */
export const REASONS = localized<Record<ReasonCode, [string, string]>>(
  {
    SCRIPT_GENERATED: ['这段文字是页面脚本显示出来的，源码里没有它。', '页面没有问题；要改它，请修改生成它的数据或脚本。'],
    MISMATCH: SCRIPT_TEXT_ZH,
    IN_PRE: ['预格式化文本（pre）暂不支持编辑。', '可先在源码里修改，后续版本支持。'],
    IN_SVG: ['SVG 内的文字要先进入 SVG 再改。', '双击 SVG 进入内部，再双击文字；也可以在右侧属性面板的「SVG 内容」里改。'],
    IN_FORM_CONTROL: ['表单控件内的内容不属于页面文字。', '无需修改文字时请忽略。'],
    BLOCK_CHILDREN: ['这段文字与块级元素混排，暂不支持编辑。', '后续版本支持。'],
    IMPLIED_ELEMENT: ['该元素在源码中没有显式标签，暂不支持编辑。', '可在源码里为它补上标签。'],
    COMMENT_IN_SLOT: ['这段文字中间夹有 HTML 注释，暂不支持编辑。', '删掉注释，或把它移到文字之外。'],
    READONLY_FILE: ['文件为非 UTF-8 编码或换行风格混杂，仅可浏览。', '用其他编辑器转换编码或统一换行后再打开。']
  },
  {
    SCRIPT_GENERATED: ['A script on the page displays this text; it is not in the source.', 'The page is fine. To change it, edit the data or script that produces it.'],
    MISMATCH: SCRIPT_TEXT_EN,
    IN_PRE: ['Preformatted text (pre) cannot be edited yet.', 'Edit it in the source for now; support is planned.'],
    IN_SVG: ['Enter the SVG before editing text inside it.', 'Double-click the SVG, then double-click the text. Or use "SVG content" in the panel.'],
    IN_FORM_CONTROL: ['Content inside a form control is not page text.', 'You can ignore this if you did not mean to edit it.'],
    BLOCK_CHILDREN: ['This text is mixed with block elements and cannot be edited yet.', 'Support is planned.'],
    IMPLIED_ELEMENT: ['This element has no explicit tag in the source, so it cannot be edited.', 'Add the tag in the source to make it editable.'],
    COMMENT_IN_SLOT: ['An HTML comment sits inside this text, so it cannot be edited.', 'Delete the comment or move it outside the text.'],
    READONLY_FILE: ['The file is not UTF-8 or mixes line endings, so it is read-only.', 'Convert the encoding or line endings in another editor, then reopen it.']
  }
)

export const TOAST = localized(
  {
    saved: '已保存',
    reloaded: '已从磁盘更新',
    structure: '这次修改改变了结构，暂不支持，已恢复',
    pasteTooLong: '粘贴内容过长，已截断为 5000 字',
    scriptRendered: '这个页面的正文由脚本渲染，大部分文字无法直接编辑',
    tooManyTabs: '请先关闭一些标签页',
    onlyHtml: '只支持 .html / .htm',
    missing: '文件已被移动或删除，保存时将另存为',
    recentMissing: '文件已移动或删除，已从最近文件中移除',
    commitFailed: '修改未能写入，已恢复',
    noLineBreak: '暂不支持换行',
    deleted: '已删除',
    duplicated: '已复制一份',
    moved: '已移动',
    rejectRange: '这个元素缺少结束标签，无法删除、复制或移动',
    rejectTarget: '不能放到这里',
    rejectLi: '列表项只能放在列表里',
    rejectTr: '表格行只能在同一个表体内移动',
    rejectSelection: '选区跨过了元素边界，无法设置格式',
    rejectStructure: '这次操作会改变其他元素的结构，已取消',
    noSelection: '请先选中一个元素',
    offsetHint: '视觉偏移，不改变文档流；可在属性面板里一键重置',
    sizeHint: '写入像素尺寸会降低响应式表现；可在属性面板里一键重置',
    flexHint: '父元素是弹性布局，已同时固定伸缩值',
    mediaTooBig: '文件超过 12MB，建议压缩后再插入',
    mediaInserted: '已插入，文件复制到 assets 文件夹',
    mediaNeedSave: '请先保存文档',
    mediaNeedSaveSub: '图片、视频、音频会复制到文档所在目录的 assets 文件夹，用相对路径引用',
    mediaUnknown: '不认识这种文件，没有插入',
    sourceCopied: '已复制源码到剪贴板',
    sourceNoRange: '这个元素缺少结束标签，无法准确取出源码',
    copied: '已复制元素',
    pasted: '已粘贴',
    styleConflict: '粘贴的片段使用了当前页面没有的样式类，外观可能不同',
    imported: '已导入片段',
    pdfSaved: '已导出 PDF',
    textSaved: '已导出',
    merged: '已自动合并磁盘上的修改',
    normalized: '已为组件补上 data-id',
    componentsOk: '组件结构检查通过',
    readOnlyOp: '只读文件不能修改',
    multiSibling: '多选只能选同一层级的元素',
    noDropTarget: '这里没有可以放置的位置',
    rejectNoop: '已经在这个位置',
    svgIsolated: '已进入 SVG 内部：单击选中形状，双击文字修改，Esc 退出',
    svgTextDone: '已修改 SVG 文字',
    svgSourceBad: 'SVG 源码有误或改变了外层标签，未写入',
    changeReverted: '已撤回这一处',
    sourceBad: '源码有误、不是单个元素，或改变了外层标签，未写入',
    notImage: '请先选中一张图片',
    imageReplaced: '已替换图片',
    imageInPicture: '这张图在 <picture> 里，浏览器可能仍按 <source> 显示原来的图',
    aiCopied: '已复制给 AI',
    aiCopiedSub: '带着文件路径、行号和这段源码；AI 改完文件后，Twiq 会自动载入（你有未保存的修改时帮你合并）',
    aiCopiedDirty: '还有未保存的修改：先保存，AI 看到的文件和行号才与这里一致'
  },
  {
    saved: 'Saved',
    reloaded: 'Updated from disk',
    structure: 'That change altered the page structure, which is not supported yet. It was undone',
    pasteTooLong: 'Pasted text was too long and was cut to 5000 characters',
    scriptRendered: 'A script renders most of this page, so most of its text cannot be edited directly',
    tooManyTabs: 'Close some tabs first',
    onlyHtml: 'Only .html / .htm files are supported',
    missing: 'The file was moved or deleted. Saving will ask for a new location',
    recentMissing: 'The file was moved or deleted and was removed from Recent',
    commitFailed: 'The change could not be written and was undone',
    noLineBreak: 'Line breaks are not supported yet',
    deleted: 'Deleted',
    duplicated: 'Duplicated',
    moved: 'Moved',
    rejectRange: 'This element has no end tag, so it cannot be deleted, duplicated or moved',
    rejectTarget: 'It cannot go here',
    rejectLi: 'List items can only go inside a list',
    rejectTr: 'Table rows can only move within the same table section',
    rejectSelection: 'The selection crosses element boundaries, so it cannot be formatted',
    rejectStructure: 'That would change the structure of other elements, so it was cancelled',
    noSelection: 'Select an element first',
    offsetHint: 'A visual offset that does not change the layout flow. Reset it in the panel',
    sizeHint: 'Fixed pixel sizes make the page less responsive. Reset them in the panel',
    flexHint: 'The parent is a flex container, so the flex values were fixed too',
    mediaTooBig: 'The file is over 12 MB. Consider compressing it first',
    mediaInserted: 'Inserted. The file was copied to the assets folder',
    mediaNeedSave: 'Save the document first',
    mediaNeedSaveSub: 'Images, video and audio are copied to an assets folder next to the document and linked by relative path',
    mediaUnknown: 'Unrecognized file type, nothing was inserted',
    sourceCopied: 'Source copied to the clipboard',
    sourceNoRange: 'This element has no end tag, so its source cannot be copied exactly',
    copied: 'Element copied',
    pasted: 'Pasted',
    styleConflict: 'The pasted fragment uses classes this page does not define, so it may look different',
    imported: 'Fragment imported',
    pdfSaved: 'PDF exported',
    textSaved: 'Exported',
    merged: 'Changes on disk were merged automatically',
    normalized: 'Added data-id to components',
    componentsOk: 'Component structure looks good',
    readOnlyOp: 'Read-only files cannot be changed',
    multiSibling: 'Multi-select only works on elements at the same level',
    noDropTarget: 'There is nowhere to drop it here',
    rejectNoop: 'It is already there',
    svgIsolated: 'Inside the SVG: click to select a shape, double-click text to edit, Esc to leave',
    svgTextDone: 'SVG text updated',
    svgSourceBad: 'The SVG source has an error or changes the outer tag, so it was not applied',
    changeReverted: 'Change reverted',
    sourceBad: 'The source has an error, is not a single element, or changes the outer tag, so it was not applied',
    notImage: 'Select an image first',
    imageReplaced: 'Image replaced',
    imageInPicture: 'This image is inside <picture>, so the browser may still show the image from <source>',
    aiCopied: 'Copied for AI',
    aiCopiedSub: 'Includes the file path, line numbers and this source. When the AI saves the file, Twiq reloads it (and merges if you have unsaved changes)',
    aiCopiedDirty: 'You have unsaved changes. Save first so the file and line numbers the AI sees match what you see here'
  }
)

export const BANNER = localized(
  {
    text: '这个页面引用了所在目录之外的文件（如 ../css/style.css），出于安全没有加载。',
    extFail: '部分外部资源加载失败',
    assetsMissing: '新位置缺少部分图片或样式文件'
  },
  {
    text: 'This page uses files outside its folder (such as ../css/style.css). They were not loaded, for safety.',
    extFail: 'Some external resources failed to load',
    assetsMissing: 'Some images or style files are missing at the new location'
  }
)

export const DIALOG = localized(
  {
    unsaved: (name: string) => ({
      title: `要保存对 ${name} 的修改吗？`,
      detail: '如果不保存，你的修改将会丢失。',
      buttons: ['保存', '不保存', '取消']
    }),
    conflict: {
      title: '文件已被其他程序修改',
      detail: '你有尚未保存的修改，请选择保留哪一份。',
      buttons: ['另存为…', '载入磁盘版本', '保留我的修改']
    },
    saveFailed: (reason: string) => ({
      title: '无法保存',
      detail: `${reason}。你的修改仍保留在窗口中。`,
      buttons: ['重试', '另存为…', '取消']
    }),
    bigFile: {
      title: '文件较大',
      detail: '打开可能比较慢。',
      buttons: ['仍然打开', '取消']
    },
    reloadConfirm: {
      title: '载入磁盘版本？',
      detail: '你有尚未保存的修改，载入磁盘版本会丢弃它们。',
      buttons: ['载入磁盘版本', '取消']
    },
    external: (host: string) => ({
      title: `在系统浏览器中打开 ${host}？`,
      detail: '链接将在系统默认浏览器中打开，Twiq 不会离开当前页面。',
      buttons: ['打开', '取消']
    }),
    conflictMerge: {
      title: '文件已被其他程序修改',
      detail: '你有尚未保存的修改。可以尝试自动合并：互不冲突的修改都会保留，冲突处逐项选择。',
      // 前三项与 v0.1 的冲突对话框顺序一致
      buttons: ['另存为…', '载入磁盘版本', '保留我的修改', '合并…']
    },
    mergeItem: (i: number, n: number, label: string, mine: string, theirs: string) => ({
      title: `冲突 ${i} / ${n}：${label}`,
      detail: `我的：${mine || '（空）'}\n\n磁盘：${theirs || '（空）'}`,
      buttons: ['保留我的', '用磁盘的', '取消合并']
    }),
    rootNotAncestor: {
      title: '无法使用这个目录',
      detail: '请选择这个文件所在目录本身，或它的上级目录。',
      buttons: ['好']
    }
  },
  {
    unsaved: (name: string) => ({
      title: `Save changes to ${name}?`,
      detail: 'Your changes will be lost if you do not save them.',
      buttons: ['Save', 'Don’t Save', 'Cancel']
    }),
    conflict: {
      title: 'The file was changed by another program',
      detail: 'You have unsaved changes. Choose which version to keep.',
      buttons: ['Save As…', 'Load Disk Version', 'Keep My Changes']
    },
    saveFailed: (reason: string) => ({
      title: 'Could not save',
      detail: `${reason}. Your changes are still in the window.`,
      buttons: ['Retry', 'Save As…', 'Cancel']
    }),
    bigFile: {
      title: 'Large file',
      detail: 'It may take a while to open.',
      buttons: ['Open Anyway', 'Cancel']
    },
    reloadConfirm: {
      title: 'Load the version on disk?',
      detail: 'You have unsaved changes. Loading the disk version discards them.',
      buttons: ['Load Disk Version', 'Cancel']
    },
    external: (host: string) => ({
      title: `Open ${host} in your browser?`,
      detail: 'The link opens in your default browser. Twiq stays on this page.',
      buttons: ['Open', 'Cancel']
    }),
    conflictMerge: {
      title: 'The file was changed by another program',
      detail: 'You have unsaved changes. Twiq can try to merge them: changes that do not overlap are all kept, and you choose for each conflict.',
      buttons: ['Save As…', 'Load Disk Version', 'Keep My Changes', 'Merge…']
    },
    mergeItem: (i: number, n: number, label: string, mine: string, theirs: string) => ({
      title: `Conflict ${i} of ${n}: ${label}`,
      detail: `Mine: ${mine || '(empty)'}\n\nOn disk: ${theirs || '(empty)'}`,
      buttons: ['Keep Mine', 'Use Disk', 'Cancel Merge']
    }),
    rootNotAncestor: {
      title: 'This folder cannot be used',
      detail: 'Choose the folder that contains this file, or one of its parent folders.',
      buttons: ['OK']
    }
  }
)
