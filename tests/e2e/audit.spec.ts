// 规格对照审查后补的行为：提交中的输入、iframe、工具条撤销、toast、预览模式撤销、另存为后资源缺失
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { clickAt, editing, launch, preview, read, shell, sleep, state, stubDialogs, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx | null = null
test.afterEach(async () => {
  if (!ctx) return
  await ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx.app.close().catch(() => {})
  ctx = null
})

/** 让主进程的提交慢 300ms，模拟提交往返期间用户继续打字。 */
async function slowCommit(c: Ctx): Promise<void> {
  await c.app.evaluate(() => {
    const w = (globalThis as unknown as { __hw: { ws: { commit: (...a: unknown[]) => unknown } } }).__hw.ws
    const orig = w.commit.bind(w)
    w.commit = async (...a: unknown[]) => {
      await new Promise((r) => setTimeout(r, 300))
      return orig(...a)
    }
  })
}

test('7.2 提交中：Tab 后立即打字，字进入下一个 host 并被保存，不留在上一个', async () => {
  const dir = workdir('frames-forms.html')
  const file = path.join(dir, 'frames-forms.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await slowCommit(ctx)
  await clickAt(page, '#a', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('一')
  await page.keyboard.press('Tab')
  await page.keyboard.type('xy') // 提交还在往返中
  await expect.poll(() => page.evaluate(() => document.querySelector('[contenteditable]')?.id)).toBe('b')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  expect(await page.locator('#a').textContent()).toBe('第一段。一')
  expect(await page.locator('#b').textContent()).toBe('第二段。xy')
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('第一段。</p>', '第一段。一</p>').replace('第二段。</p>', '第二段。xy</p>'))
})

test('7.2 提交中：Enter 后立即打字，字不写进已退出的 host', async () => {
  const dir = workdir('frames-forms.html')
  ctx = await launch([path.join(dir, 'frames-forms.html')])
  const page = await preview(ctx.app)
  await slowCommit(ctx)
  await clickAt(page, '#a', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('一')
  await page.keyboard.press('Enter')
  await page.keyboard.type('zz')
  await editing(ctx.app, false)
  expect(await page.locator('#a').textContent()).toBe('第一段。一')
  // 再次点击同一段可以正常进入（没有因文字不一致被拒）
  await clickAt(page, '#a', { end: true })
  await editing(ctx.app, true)
})

test('15 iframe：编辑模式点击不触发 iframe 内链接；预览模式 iframe 跳转被阻止', async () => {
  const dir = workdir('frames-forms.html')
  ctx = await launch([path.join(dir, 'frames-forms.html')])
  const page = await preview(ctx.app)
  const frameUrl = () => page.frames().find((f) => f !== page.mainFrame())?.url()
  await expect.poll(frameUrl).toBe('about:srcdoc')
  const box = await page.locator('#f').boundingBox()
  await page.mouse.click(box!.x + 30, box!.y + 25)
  await sleep(500)
  expect(frameUrl()).toBe('about:srcdoc')
  await ws(ctx.app, 'setMode', 'preview')
  await sleep(200)
  await page.mouse.click(box!.x + 30, box!.y + 25)
  await sleep(800)
  expect(frameUrl()).toBe('about:srcdoc')
})

test('8.6 工具条「撤销本次输入」：没有输入时提交并撤销上一步', async () => {
  const dir = workdir('frames-forms.html')
  ctx = await launch([path.join(dir, 'frames-forms.html')])
  const page = await preview(ctx.app)
  await clickAt(page, '#a', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('一')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await clickAt(page, '#b', { end: true })
  await editing(ctx.app, true)
  const tb = await page.evaluate(() => {
    const r = (document.querySelector('[contenteditable]') as HTMLElement).getBoundingClientRect()
    const top = r.top - 24 >= 6 + 38 + 8 ? r.top - 24 - 38 - 8 : r.top + 8
    return { moreX: r.left + 4 + 46 + 15, y: top + 19 }
  })
  await page.mouse.click(tb.moreX, tb.y)
  await sleep(100)
  await page.mouse.click(tb.moreX, tb.y + 36 + 14) // 菜单第一项「撤销本次输入」
  await editing(ctx.app, false)
  await expect.poll(() => page.locator('#a').textContent()).toBe('第一段。')
})

test('7.1 预览模式：焦点在页面输入框时 Cmd/Ctrl+Z 撤销输入框，不撤销文档', async () => {
  const dir = workdir('frames-forms.html')
  ctx = await launch([path.join(dir, 'frames-forms.html')])
  const page = await preview(ctx.app)
  await clickAt(page, '#a', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('一')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await ws(ctx.app, 'setMode', 'preview')
  await page.click('#q')
  await page.keyboard.type('abc')
  await ws(ctx.app, 'undo')
  await expect.poll(() => page.locator('#q').inputValue()).not.toBe('abc')
  expect(await page.locator('#a').textContent()).toBe('第一段。一')
  // 焦点离开输入框后，撤销作用于文档
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await ws(ctx.app, 'undo')
  await expect.poll(() => page.locator('#a').textContent()).toBe('第一段。')
})

test('10.6 toast：关闭最后一个标签后不再出现旧 toast；预览模式 Esc 先关 toast', async () => {
  const dir = workdir('frames-forms.html')
  ctx = await launch([path.join(dir, 'frames-forms.html')])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await ws(ctx.app, 'setMode', 'preview')
  await ws(ctx.app, 'toast', 'info', '测试提示')
  await page.keyboard.press('Escape')
  await sleep(200)
  expect((await state(ctx.app)).tabs[0].mode).toBe('preview')
  await page.keyboard.press('Escape')
  await waitFor(ctx.app, (s) => s.tabs[0].mode === 'edit')
  await ws(ctx.app, 'toast', 'info', '旧提示')
  await sleep(2600)
  await ws(ctx.app, 'closeTab', (await state(ctx.app)).activeId)
  await waitFor(ctx.app, (s) => s.tabs.length === 0)
  await sleep(200)
  expect(await sh.locator('.toast').count()).toBe(0)
})

test('13.8 另存到其他目录：相对资源缺失时状态栏提示；8.7 面包屑每段带选择器', async () => {
  const dir = workdir('relative-assets')
  const file = path.join(dir, 'relative-assets', 'index.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await sleep(500)
  const h1 = await page.locator('h1').boundingBox()
  await page.mouse.move(h1!.x + 10, h1!.y + 10)
  await sleep(100)
  await page.mouse.move(h1!.x + 14, h1!.y + 12)
  const s = await waitFor(ctx.app, (x) => !!x.hover)
  expect(s.hover!.selectors).toEqual(['body', 'body > h1.styled'])
  expect(s.assetsMissing).toBe(false)
  const target = path.join(dir, 'elsewhere', 'index.html')
  fs.mkdirSync(path.dirname(target))
  await stubDialogs(ctx.app, { savePath: target })
  await ws(ctx.app, 'saveAs')
  await waitFor(ctx.app, (x) => x.assetsMissing, 5000)
})
