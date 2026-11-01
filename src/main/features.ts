// v0.2–v0.5 的工作区级功能：媒体插入、元素剪贴板、片段导入、导出 PDF 与文本、组件规范（规格 20.2–20.5）。
import { app, clipboard, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import type { Eid, ShellCommand, StructOp } from '../shared/types'
import { TOAST } from '../shared/messages'
import { checkComponents, normalizePatches } from './components'
import { htmlToText } from './export-text'
import { escapeAttr, rawOf } from './ops'
import { atomicWrite, type Workspace } from './workspace'
import { decodeFile } from './parse'
import { applyPatches } from './patch'
import { aiRef } from './ai-ref'
import { M } from './strings'

export const MEDIA_MAX = 12 * 1024 * 1024

export const MEDIA_EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
}

export type MediaKind = keyof typeof MEDIA_EXT

/** 按扩展名判断媒体种类；不认识的返回 null */
export function mediaKindOf(file: string): MediaKind | null {
  const ext = path.extname(file).slice(1).toLowerCase()
  for (const k of Object.keys(MEDIA_EXT) as MediaKind[]) if (MEDIA_EXT[k].includes(ext)) return k
  return null
}

/** assets 下不重名的文件名：重名时加序号（photo.png → photo-2.png）。 */
export function uniqueName(dir: string, name: string): string {
  const ext = path.extname(name)
  const stem = path.basename(name, ext).replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'file'
  let candidate = `${stem}${ext.toLowerCase()}`
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem}-${i}${ext.toLowerCase()}`
  return candidate
}

/** src 为已编码的相对路径（assetSrc） */
export function mediaHtml(kind: 'image' | 'video' | 'audio', src: string, alt: string): string {
  src = escapeAttr(src)
  if (kind === 'image') return `<img src="${src}" alt="${escapeAttr(alt)}">`
  if (kind === 'video') return `<video src="${src}" controls></video>`
  return `<audio src="${src}" controls></audio>`
}

type El = DefaultTreeAdapterMap['element']
const isEl = (n: DefaultTreeAdapterMap['node']): n is El => 'tagName' in n

/** 从一份 HTML 里取出 body 的内容原文（导入片段，20.3）。 */
export function bodyFragment(source: string): string | null {
  const doc = parse(source, { sourceCodeLocationInfo: true })
  const html = doc.childNodes.find(isEl)
  const body = html?.childNodes.find((n): n is El => isEl(n) && n.tagName === 'body')
  const loc = body?.sourceCodeLocation
  if (!body || !loc?.startTag) return null
  const kids = body.childNodes.filter((n) => n.sourceCodeLocation)
  if (!kids.length) return null
  const start = kids[0].sourceCodeLocation!.startOffset
  const end = kids[kids.length - 1].sourceCodeLocation!.endOffset
  // 去掉 script：导入的是正文片段
  return source
    .slice(start, end)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .trim()
}

/** 片段里出现、但当前文档里找不到的 class（粗略判断样式冲突）。 */
export function missingClasses(fragment: string, target: string): string[] {
  const used = new Set<string>()
  for (const m of fragment.matchAll(/\bclass\s*=\s*["']([^"']*)["']/gi)) for (const c of m[1].split(/\s+/)) if (c) used.add(c)
  return [...used].filter((c) => !new RegExp(`(^|[^-\\w])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^-\\w])`).test(target.replace(fragment, '')))
}

export function installFeatures(ws: Workspace): void {
  ws.extra = (cmd: ShellCommand) => {
    switch (cmd.type) {
      case 'insertMedia':
        return ws.serial(() => insertMedia(ws, cmd.kind))
      case 'copyElement':
        return copyElement(ws)
      case 'copySource':
        return copySource(ws, cmd.eid)
      case 'copyForAi':
        return copyForAi(ws, cmd.eid)
      case 'replaceImage':
        return ws.serial(() => replaceImage(ws, cmd.eid))
      case 'pasteElement':
        return ws.serial(() => pasteElement(ws))
      case 'importFragment':
        return ws.serial(() => importFragment(ws))
      case 'exportPdf':
        return exportPdf(ws)
      case 'exportText':
        return exportText(ws, cmd.format)
      case 'normalizeComponents':
        return ws.serial(() => normalizeComponents(ws))
      case 'checkComponents':
        return checkComps(ws)
    }
  }
}

/** 插入位置：选中元素之后；没有选中时插到 body 末尾。 */
function anchor(ws: Workspace): number | null {
  const t = ws.active
  return t?.mode === 'edit' && t.selection ? t.selection.eid : null
}

/**
 * 选一个媒体文件，复制到文档旁的 assets 文件夹（重名加序号）；返回页面里用的相对路径。
 * 文档还没保存过（没有目录可放）、取消、不认识的类型或用户放弃大文件时返回 null。
 */
async function pickAsset(ws: Workspace, want: MediaKind | 'auto'): Promise<{ kind: MediaKind; src: string; name: string; stem: string } | null> {
  const tab = ws.active
  if (!tab) return null
  if (!tab.path) {
    ws.toast('warn', TOAST.mediaNeedSave, TOAST.mediaNeedSaveSub)
    return null
  }
  const all = [...MEDIA_EXT.image, ...MEDIA_EXT.video, ...MEDIA_EXT.audio]
  const r = await dialog.showOpenDialog(ws.win, {
    title: want === 'image' ? M.insertImage : want === 'video' ? M.insertVideo : want === 'audio' ? M.insertAudio : M.insertMedia,
    properties: ['openFile'],
    filters:
      want === 'auto'
        ? [
            { name: M.filterMedia, extensions: all },
            { name: M.filterImage, extensions: MEDIA_EXT.image },
            { name: M.filterVideo, extensions: MEDIA_EXT.video },
            { name: M.filterAudio, extensions: MEDIA_EXT.audio }
          ]
        : [{ name: want === 'image' ? M.filterImage : want === 'video' ? M.filterVideo : M.filterAudio, extensions: MEDIA_EXT[want] }]
  })
  const file = r.filePaths[0]
  if (r.canceled || !file) return null
  const kind = mediaKindOf(file)
  if (!kind || (want !== 'auto' && kind !== want)) {
    ws.toast('warn', TOAST.mediaUnknown, path.extname(file) || path.basename(file))
    return null
  }
  const st = await fs.promises.stat(file)
  if (st.size > MEDIA_MAX) {
    const ok = await ws.ask({ title: TOAST.mediaTooBig, detail: M.mediaSize(path.basename(file), (st.size / 1024 / 1024).toFixed(1)), buttons: [M.insertAnyway, M.cancel], type: 'info', defaultId: 1, cancelId: 1 })
    if (ok !== 0) return null
  }
  const dir = path.join(path.dirname(tab.path), 'assets')
  await fs.promises.mkdir(dir, { recursive: true })
  const name = uniqueName(dir, path.basename(file))
  await fs.promises.copyFile(file, path.join(dir, name))
  return { kind, src: assetSrc(path.join('assets', name)), name, stem: path.basename(file, path.extname(file)) }
}

/** 相对路径写进属性：每段百分号编码（中文、空格文件名也能加载） */
export function assetSrc(rel: string): string {
  return rel.split(path.sep).map(encodeURIComponent).join('/')
}

async function insertMedia(ws: Workspace, want: MediaKind | 'auto'): Promise<void> {
  const a = await pickAsset(ws, want)
  if (!a) return
  const html = mediaHtml(a.kind, a.src, a.stem)
  const eid = anchor(ws)
  if (await ws.applyOp({ type: 'insertHtml', eid, where: eid === null ? 'append' : 'after', html })) ws.toast('info', TOAST.mediaInserted, a.name)
}

/**
 * 替换图片（v0.10）：选一张图复制到 assets，换掉 src；有 srcset 时一并去掉（否则浏览器照旧显示 srcset 里的图）。
 * 一步撤销。图片在 <picture> 里、前面有 <source> 时，浏览器可能仍用 <source>：替换后提示一句。
 */
async function replaceImage(ws: Workspace, eid?: Eid): Promise<void> {
  const tab = ws.active
  const target = eid ?? anchor(ws)
  const el = tab && target !== null && target !== undefined ? tab.doc.elements[target] : undefined
  if (!tab || !el || el.tag !== 'img') return ws.toast('info', TOAST.notImage)
  const a = await pickAsset(ws, 'image')
  if (!a) return
  const ops: StructOp[] = [{ type: 'setAttr', eid: el.eid, name: 'src', value: a.src }]
  if (el.attrs.srcset) ops.push({ type: 'setAttr', eid: el.eid, name: 'srcset', value: null })
  if (!(await ws.applyOp(ops.length === 1 ? ops[0] : { type: 'batch', ops }))) return
  const parent = el.parent === null ? null : tab.doc.elements[el.parent]
  const sources = parent?.tag === 'picture' && parent.children.some((c) => tab.doc.elements[c].tag === 'source')
  if (sources) ws.toast('warn', TOAST.imageReplaced, TOAST.imageInPicture, 5000)
  else ws.toast('info', TOAST.imageReplaced, a.name)
}

/** 复制给 AI（v0.10）：元素源码 + 文件路径、行号、选择器，整理成一段可以直接粘贴给 AI 助手的说明 */
function copyForAi(ws: Workspace, eid?: Eid): void {
  const tab = ws.active
  const target = eid ?? anchor(ws)
  if (!tab || target === null || target === undefined) return ws.toast('info', TOAST.noSelection)
  const ref = aiRef(tab.doc.source, tab.doc.elements, target)
  if (!ref) return ws.toast('warn', TOAST.sourceNoRange)
  // 有未保存的修改时，行号与原文按 Twiq 里的内容算，和磁盘上的文件对不上：说明里写明，并提示先保存
  const file = tab.path ? (tab.dirty ? M.unsavedChanges(tab.path) : tab.path) : M.unsavedDoc
  clipboard.writeText(M.aiPrompt({ file, ...ref }))
  if (tab.dirty && tab.path) ws.toast('warn', TOAST.aiCopied, TOAST.aiCopiedDirty, 5000)
  else ws.toast('info', TOAST.aiCopied, TOAST.aiCopiedSub, 4000)
}

/** 把元素源码原文复制到系统剪贴板（v0.7）：省略的结束标签补上，可直接粘贴到别的编辑器。 */
function copySource(ws: Workspace, eid?: number): void {
  const tab = ws.active
  const target = eid ?? anchor(ws)
  if (!tab || target === null || target === undefined) return ws.toast('info', TOAST.noSelection)
  const el = tab.doc.elements[target]
  if (!el) return
  if (!el.rangeOk) return ws.toast('warn', TOAST.sourceNoRange)
  const html = rawOf(tab.doc.source, el)
  clipboard.writeText(html)
  // 同时作为应用内的拷贝：可以用「插入 › 粘贴拷贝的元素」放到页面别处
  ws.clip = { html, classes: [] }
  ws.note(TOAST.sourceCopied)
  ws.broadcast()
}

function copyElement(ws: Workspace): void {
  const tab = ws.active
  const eid = anchor(ws)
  if (!tab || eid === null) return ws.toast('info', TOAST.noSelection)
  const el = tab.doc.elements[eid]
  if (!el?.rangeOk) return ws.toast('warn', TOAST.rejectRange)
  const html = rawOf(tab.doc.source, el)
  ws.clip = { html, classes: [] }
  // 同时放进系统剪贴板：可以直接粘贴到别的编辑器
  clipboard.writeText(html)
  ws.note(TOAST.copied)
  ws.broadcast()
}

async function pasteElement(ws: Workspace): Promise<void> {
  const tab = ws.active
  if (!tab || !ws.clip) return
  const eid = anchor(ws)
  const missing = missingClasses(ws.clip.html, tab.doc.source)
  if (await ws.applyOp({ type: 'insertHtml', eid, where: eid === null ? 'append' : 'after', html: ws.clip.html })) {
    if (missing.length) ws.toast('info', TOAST.styleConflict, missing.slice(0, 3).map((c) => `.${c}`).join(' '), 5000)
    else ws.note(TOAST.pasted)
  }
}

async function importFragment(ws: Workspace): Promise<void> {
  const tab = ws.active
  if (!tab) return
  const r = await dialog.showOpenDialog(ws.win, { title: M.importTitle, properties: ['openFile'], filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] })
  const file = r.filePaths[0]
  if (r.canceled || !file) return
  const d = decodeFile(await fs.promises.readFile(file))
  const frag = bodyFragment(d.source)
  if (!frag) return ws.toast('warn', M.importEmpty)
  const eid = anchor(ws)
  const missing = missingClasses(frag, tab.doc.source)
  if (await ws.applyOp({ type: 'insertHtml', eid, where: eid === null ? 'append' : 'after', html: frag })) {
    if (missing.length) ws.toast('info', TOAST.styleConflict, missing.slice(0, 3).map((c) => `.${c}`).join(' '), 5000)
    else ws.toast('info', TOAST.imported, path.basename(file))
  }
}

function defaultOut(ws: Workspace, ext: string): string {
  const t = ws.active!
  const base = t.path ? t.path.replace(/\.html?$/i, '') : path.join(app.getPath('documents'), t.name.replace(/\.html?$/i, ''))
  return `${base}.${ext}`
}

async function exportPdf(ws: Workspace): Promise<void> {
  const tab = ws.active
  if (!tab) return
  await tab.flush()
  const r = await dialog.showSaveDialog(ws.win, { title: M.exportPdf, defaultPath: defaultOut(ws, 'pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  if (r.canceled || !r.filePath) return
  // 叠加层在打印媒体下隐藏（styles.ts 的 @media print）
  const data = await tab.view.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
  await atomicWrite(r.filePath, Buffer.from(data))
  ws.toast('info', TOAST.pdfSaved, path.basename(r.filePath))
}

async function exportText(ws: Workspace, format: 'md' | 'txt'): Promise<void> {
  const tab = ws.active
  if (!tab) return
  await tab.flush()
  const r = await dialog.showSaveDialog(ws.win, {
    title: format === 'md' ? M.exportMd : M.exportTxt,
    defaultPath: defaultOut(ws, format),
    filters: [{ name: format === 'md' ? 'Markdown' : M.filterTxt, extensions: [format] }]
  })
  if (r.canceled || !r.filePath) return
  await atomicWrite(r.filePath, Buffer.from(htmlToText(tab.doc.source, format), 'utf8'))
  ws.toast('info', TOAST.textSaved, path.basename(r.filePath))
}

async function normalizeComponents(ws: Workspace): Promise<void> {
  const tab = ws.active
  if (!tab) return
  const patches = normalizePatches(tab.doc.source, tab.doc.elements)
  if (!patches.length) return ws.toast('info', M.noComponentsToFix)
  // 多个属性补丁合成一次整份替换，作为一步撤销
  const next = applyPatches(tab.doc.source, patches).source
  if (await ws.applyOp({ type: 'replaceAll', source: next })) ws.toast('info', TOAST.normalized, M.componentsFixed(patches.length))
}

async function checkComps(ws: Workspace): Promise<void> {
  const tab = ws.active
  if (!tab) return
  const issues = checkComponents(tab.doc.source)
  if (!issues.length) return ws.toast('info', TOAST.componentsOk)
  await ws.ask({
    title: M.componentIssues(issues.length),
    detail: issues.slice(0, 12).map((i) => M.issueLine(i.tag, i.message)).join('\n') + (issues.length > 12 ? M.andMoreIssues(issues.length - 12) : ''),
    buttons: [M.ok],
    type: 'info'
  })
}
