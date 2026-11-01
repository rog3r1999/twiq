// 端到端测试工具：启动应用、定位预览页、调用主进程、替换原生对话框。
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppState } from '../../src/shared/types'

export const FIX = path.resolve(__dirname, '../fixtures')
export const ROOT = path.resolve(__dirname, '../..')

/** 把 fixtures 复制到临时目录，返回其中的路径。 */
export function workdir(...items: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-e2e-'))
  for (const it of items) fs.cpSync(path.join(FIX, it), path.join(dir, it), { recursive: true })
  return fs.realpathSync(dir)
}

export interface Ctx {
  app: ElectronApplication
  settings: string
}

export async function launch(files: string[] = [], opts: { settings?: string; env?: Record<string, string> } = {}): Promise<Ctx> {
  const settings = opts.settings ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hw-set-')), 'settings.json')
  const app = await electron.launch({
    args: [ROOT, ...files],
    // 断言按中文界面写；英文界面的用例自己传 TWIQ_LANG（v0.10）
    env: { ...process.env, TWIQ_TEST: '1', TWIQ_MULTI_INSTANCE: '1', TWIQ_SETTINGS: settings, TWIQ_LANG: 'zh', ...opts.env } as Record<string, string>
  })
  await shell(app)
  if (files.length) await waitFor(app, (s) => s.tabs.length >= files.length && !!s.activeId)
  return { app, settings }
}

export async function shell(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find((w) => w.url().includes('/renderer/') || w.url().startsWith('http://localhost'))
    if (p) return p
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('shell not found')
}

export function state(app: ElectronApplication): Promise<AppState> {
  return app.evaluate(() => (globalThis as unknown as { __hw: { ws: { state(): AppState } } }).__hw.ws.state())
}

export async function waitFor(app: ElectronApplication, pred: (s: AppState) => boolean, timeout = 10_000): Promise<AppState> {
  const t0 = Date.now()
  for (;;) {
    const s = await state(app)
    if (pred(s)) return s
    if (Date.now() - t0 > timeout) throw new Error(`waitFor timeout: editing=${s.editing} note=${s.statusNote} hover=${JSON.stringify(s.hover)} tabs=${JSON.stringify(s.tabs.map((t) => [t.name, t.dirty]))}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 调用主进程 workspace 上的方法。 */
export function ws<T = unknown>(app: ElectronApplication, method: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    async (_e, [m, a]) => {
      const w = (globalThis as unknown as { __hw: { ws: Record<string, (...x: unknown[]) => unknown> } }).__hw.ws
      return (await w[m as string](...(a as unknown[]))) as never
    },
    [method, args] as const
  ) as Promise<T>
}

/** 当前标签页的预览页面（等待加载完成）。 */
export async function preview(app: ElectronApplication): Promise<Page> {
  const s = await waitFor(app, (x) => !!x.activeId)
  const id = s.activeId!
  for (let i = 0; i < 100; i++) {
    const loaded = await app.evaluate((_e, tid) => {
      const w = (globalThis as unknown as { __hw: { ws: { tabById(id: string): { loaded: boolean } | undefined } } }).__hw.ws
      return !!w.tabById(tid)?.loaded
    }, id)
    const p = app.windows().find((w) => w.url().startsWith(`hw://t-${id}/`))
    if (p && loaded) {
      await p.waitForLoadState('load')
      return p
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('preview not found')
}

/** 替换原生对话框：依次返回给定的按钮下标；保存与打开对话框返回给定路径。 */
export async function stubDialogs(app: ElectronApplication, opts: { responses?: number[]; savePath?: string; openPaths?: string[]; dir?: string }): Promise<void> {
  await app.evaluate(({ dialog }, o) => {
    const g = globalThis as unknown as { __dlg: { titles: string[]; responses: number[] } }
    g.__dlg = { titles: [], responses: [...(o.responses ?? [])] }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string; defaultId?: number }
      g.__dlg.titles.push(options.message)
      return { response: g.__dlg.responses.length ? g.__dlg.responses.shift()! : (options.defaultId ?? 0), checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    dialog.showSaveDialog = (async () => (o.savePath ? { canceled: false, filePath: o.savePath } : { canceled: true, filePath: '' })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { properties?: string[] }
      if (options.properties?.includes('openDirectory')) return o.dir ? { canceled: false, filePaths: [o.dir] } : { canceled: true, filePaths: [] }
      return o.openPaths ? { canceled: false, filePaths: o.openPaths } : { canceled: true, filePaths: [] }
    }) as typeof dialog.showOpenDialog
  }, opts)
}

export function dialogTitles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __dlg?: { titles: string[] } }).__dlg?.titles ?? [])
}

/** 点击元素内某个字符之后的位置（按文字偏移计算坐标）。 */
export async function clickAt(page: Page, selector: string, opts: { offset?: number; end?: boolean; once?: boolean } = {}): Promise<void> {
  // 换位动画期间测到的矩形是插值中的位置，点下去会落空：先滚到中间并等动画结束
  await page.evaluate(async (sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'center' })
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
  }, selector)
  await sleep(50)
  const pt = await page.evaluate(
    ([sel, o]) => {
      const el = document.querySelector(sel) as HTMLElement
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode() as Text | null
      // end：落在元素最后一个字符上（不贴元素右边缘：选中后那里是尺寸手柄）；
      // 优先取元素自己的文字，避免点进块级子元素
      if (o.end) {
        const own = Array.from(el.childNodes).filter((n): n is Text => n.nodeType === Node.TEXT_NODE && (n as Text).data.trim() !== '')
        const all: Text[] = []
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) if (n.data.trim()) all.push(n)
        const last = own.at(-1) ?? all.at(-1)
        if (!last) {
          const r = el.getBoundingClientRect()
          return { x: r.left + Math.min(8, r.width / 2), y: r.top + r.height / 2 }
        }
        const len = last.data.trimEnd().length
        const range = document.createRange()
        range.setStart(last, len - 1)
        range.setEnd(last, len)
        const r = range.getBoundingClientRect()
        return { x: r.right - 0.5, y: r.top + r.height / 2 }
      }
      let left = o.offset ?? 0
      while (node && left > node.data.length) {
        left -= node.data.length
        node = walker.nextNode() as Text | null
      }
      if (!node) {
        const r = el.getBoundingClientRect()
        return { x: r.left + 4, y: r.top + r.height / 2 }
      }
      const range = document.createRange()
      range.setStart(node, Math.max(0, left - 1))
      range.setEnd(node, left)
      const r = range.getBoundingClientRect()
      return { x: r.right - 0.5, y: r.top + r.height / 2 }
    },
    [selector, opts] as const
  )
  await page.mouse.move(pt.x, pt.y)
  // v0.8 合并模式：第一下选中，再点一次进入改字（正在改字时点到别处，一下就切换过去，第二下落在新的文字块里）
  await page.mouse.click(pt.x, pt.y)
  if (opts.once) return
  await sleep(60)
  await page.mouse.click(pt.x, pt.y)
}

export async function editing(app: ElectronApplication, on: boolean): Promise<void> {
  await waitFor(app, (s) => s.editing === on)
}

export const read = (p: string): string => fs.readFileSync(p, 'utf8')
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
