// v0.10：复制给 AI、替换图片、任意元素的源码编辑、字重 / 内边距 / 圆角。
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launch, preview, read, shell, sleep, state, stubDialogs, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await ctx?.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx?.app.close()
})

/** 元素表里第一个满足条件的元素的 eid（按标签与文字找） */
function eidOf(app: Ctx['app'], tag: string, text?: string): Promise<number> {
  return app.evaluate(
    (_e, [t, x]) => {
      const tab = (globalThis as unknown as { __hw: { ws: { active: { doc: { source: string; elements: { eid: number; tag: string; startTagStart: number; end: number }[] } } } } }).__hw.ws.active
      const el = tab.doc.elements.find((e) => e.tag === t && (!x || tab.doc.source.slice(e.startTagStart, e.end).includes(x)))
      return el!.eid
    },
    [tag, text ?? ''] as const
  )
}

async function select(app: Ctx['app'], eid: number): Promise<void> {
  await ws(app, 'selectEid', eid)
  await waitFor(app, (s) => s.selection?.eid === eid)
}

const clipboardText = () => ctx.app.evaluate(({ clipboard }) => clipboard.readText())

test('V10-01 复制给 AI：带文件路径、行号、选择器与源码；选择器在页面上只选中它自己', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await select(ctx.app, await eidOf(ctx.app, 'li', '列表二'))
  await sh.getByRole('button', { name: '复制给 AI' }).click()
  await expect.poll(clipboardText).toContain('<li>列表二</li>')
  const text = await clipboardText()
  expect(text).toContain(`文件：${file}`)
  expect(text).toContain('位置：第 13–13 行')
  expect(text).toMatch(/请只修改下面这一段 HTML/)
  const selector = /选择器：(.+)/.exec(text)![1]
  expect(selector).toBe('body > ul > li:nth-of-type(2)')
  const hits = await page.evaluate((s) => Array.from(document.querySelectorAll(s)).map((e) => e.textContent), selector)
  expect(hits).toEqual(['列表二'])

  // 有未保存的修改：说明里写明行号按 Twiq 里的内容算（审查发现：以前照样写磁盘路径，AI 会改错行）
  await ws(ctx.app, 'applyOp', { type: 'duplicate', eid: await eidOf(ctx.app, 'li', '列表一') })
  await waitFor(ctx.app, (s) => s.tabs[0].dirty)
  await select(ctx.app, await eidOf(ctx.app, 'li', '列表二'))
  await sh.getByRole('button', { name: '复制给 AI' }).click()
  await expect.poll(clipboardText).toContain('Twiq 里还有未保存的修改')
  expect(await clipboardText()).toContain('位置：第 14–14 行')
})

test('V10-02 替换图片：复制到 assets、只改 src 并去掉 srcset，一步撤销；未保存的文档不能替换', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'page.html')
  const orig = '<!doctype html>\n<html><body>\n<p>前</p>\n<img src="old.png" srcset="old@2x.png 2x" alt="旧图">\n</body></html>\n'
  fs.writeFileSync(file, orig)
  // 1×1 透明 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  const pick = path.join(dir, '新 图.png')
  fs.writeFileSync(pick, png)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await select(ctx.app, await eidOf(ctx.app, 'img'))
  await stubDialogs(ctx.app, { openPaths: [pick] })
  await sh.getByRole('button', { name: '替换图片…' }).click()
  await waitFor(ctx.app, (s) => s.tabs[0].dirty)
  await expect.poll(() => page.locator('img').getAttribute('src')).toBe('assets/%E6%96%B0-%E5%9B%BE.png')
  expect(await page.locator('img').getAttribute('srcset')).toBeNull()
  // 新图真的加载出来了（hw:// 能取到 assets 里的文件）
  await expect.poll(() => page.evaluate(() => (document.querySelector('img') as HTMLImageElement).naturalWidth)).toBe(1)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('src="old.png" srcset="old@2x.png 2x"', 'src="assets/%E6%96%B0-%E5%9B%BE.png"'))
  // 文件名里的空格换成 -（与插入媒体同一套命名），内容就是选的那张图
  expect(fs.readFileSync(path.join(dir, 'assets', '新-图.png'))).toEqual(png)
  // 一步撤销：src 与 srcset 一起回来
  await ws(ctx.app, 'undo')
  await expect.poll(() => page.locator('img').getAttribute('srcset')).toBe('old@2x.png 2x')
  expect(await page.locator('img').getAttribute('src')).toBe('old.png')

  // 新建的文档还没有目录：按钮不可用
  await ws(ctx.app, 'newDoc')
  await preview(ctx.app)
  await ws(ctx.app, 'applyOp', { type: 'insertHtml', eid: null, where: 'append', html: '<img src="x.png" alt="">' })
  await select(ctx.app, await eidOf(ctx.app, 'img'))
  await expect(sh.getByRole('button', { name: '替换图片…' })).toBeDisabled()
})

test('V10-03 任意元素编辑源码：占满面板、带着色、输入即预览不写盘；应用写成一步；坏源码留在编辑器；Esc 还原', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await select(ctx.app, await eidOf(ctx.app, 'p', '第二段'))
  await sh.getByRole('button', { name: '编辑源码…' }).click()
  const ta = sh.getByRole('textbox', { name: /的源码/ })
  await expect(ta).toHaveValue('<p>第二段正文，含<b>加粗</b>文字。</p>')
  // 占满面板：样式区不再显示；着色层里有标签名
  await expect(sh.locator('.panel h3', { hasText: '样式' })).toHaveCount(0)
  await expect(sh.locator('.source-editor .t-tag').first()).toHaveText('p')

  await ta.fill('<p>第二段正文，含<em>强调</em>文字。</p>')
  await expect.poll(() => page.locator('p em').count()).toBe(1)
  expect(read(file)).toBe(orig)
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  await ta.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await waitFor(ctx.app, (s) => s.tabs[0].dirty)
  await expect(ta).toHaveCount(0)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('<p>第二段正文，含<b>加粗</b>文字。</p>', '<p>第二段正文，含<em>强调</em>文字。</p>'))
  const undoDepth = (await state(ctx.app)).tabs[0].canUndo

  // 坏源码（多出一个元素）：不写入，编辑器还在，可以继续改或取消
  await select(ctx.app, await eidOf(ctx.app, 'h1'))
  await sh.getByRole('button', { name: '编辑源码…' }).click()
  await ta.fill('<h1>基础标题</h1><p>多出来的</p>')
  await sh.getByRole('button', { name: '应用' }).click()
  await sleep(400)
  await expect(ta).toBeVisible()
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  // Esc：放弃，预览还原
  await ta.fill('<h1>预览里的临时标题</h1>')
  await expect.poll(() => page.locator('h1').textContent()).toBe('预览里的临时标题')
  await ta.press('Escape')
  await expect(ta).toHaveCount(0)
  await expect.poll(() => page.locator('h1').textContent()).toBe('基础标题')
  expect((await state(ctx.app)).tabs[0].canUndo).toBe(undoDepth)

  // 没有应用也没有取消就切走（切到改动页）：页面上的临时预览要还原（审查发现）
  await sh.getByRole('button', { name: '编辑源码…' }).click()
  await ta.fill('<h1>还没应用的标题</h1>')
  await expect.poll(() => page.locator('h1').textContent()).toBe('还没应用的标题')
  await sh.getByRole('tab', { name: /改动/ }).click()
  await expect.poll(() => page.locator('h1').textContent()).toBe('基础标题')
  await expect.poll(() => page.locator('h1').getAttribute('data-hw')).not.toBeNull()
  await sh.getByRole('tab', { name: /属性|h1/ }).first().click()
  await expect(ta).toHaveCount(0)
})

test('V10-04 字重、内边距、圆角：写成内联样式，重置删除；与已有样式合并', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await select(ctx.app, await eidOf(ctx.app, 'h1'))
  await sh.getByLabel('字重', { exact: true }).selectOption('300')
  await expect.poll(() => page.locator('h1').getAttribute('style')).toBe('font-weight: 300')
  const pad = sh.getByLabel('内边距', { exact: true })
  await pad.fill('4px 8px')
  await pad.press('Enter')
  await expect.poll(() => page.locator('h1').getAttribute('style')).toBe('font-weight: 300; padding: 4px 8px')
  const r = sh.getByLabel('圆角', { exact: true })
  await r.fill('6px')
  await r.press('Enter')
  await expect.poll(() => page.locator('h1').evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe('6px')
  await sh.getByRole('button', { name: '重置 字重' }).click()
  await expect.poll(() => page.locator('h1').getAttribute('style')).toBe('padding: 4px 8px; border-radius: 6px')
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('<h1>基础标题</h1>', '<h1 style="padding: 4px 8px; border-radius: 6px">基础标题</h1>'))

  // 关键字与列表外的字重照实显示（审查发现：bold 曾显示成 400、900 显示成 300）
  await ws(ctx.app, 'applyOp', { type: 'setStyle', eid: await eidOf(ctx.app, 'h1'), props: { 'font-weight': 'bold' } })
  await expect(sh.getByLabel('字重', { exact: true })).toHaveValue('700')
  await ws(ctx.app, 'applyOp', { type: 'setStyle', eid: await eidOf(ctx.app, 'h1'), props: { 'font-weight': '900' } })
  await expect(sh.getByLabel('字重', { exact: true })).toHaveValue('900')
})
