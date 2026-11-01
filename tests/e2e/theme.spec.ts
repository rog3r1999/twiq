// v0.9：外观偏好（跟随系统 / 浅色 / 深色）、持久化、叠加层与页面隔离。
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launch, preview, quit, shell, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx | null = null

test.afterEach(async () => {
  if (!ctx) return
  await quit(ctx)
  ctx = null
})

function settingsFile(dir: string, theme: 'system' | 'light' | 'dark'): string {
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ theme }))
  return file
}

async function shellTheme(app: Ctx['app']): Promise<string | null> {
  return (await shell(app)).evaluate(() => document.documentElement.dataset.theme ?? null)
}

async function overlayAttr(app: Ctx['app'], name: 'data-theme' | 'data-page'): Promise<string | null> {
  const page = await preview(app)
  await page.locator('#hw-overlay-root').waitFor({ state: 'attached' })
  return page.locator('#hw-overlay-root').getAttribute(name)
}

test('V9-01 切换浅色/深色：data-theme、配色 token、叠加层同步，预览页自身配色不变', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')], { settings: settingsFile(dir, 'light') })
  const sh = await shell(ctx.app)
  const page = await preview(ctx.app)

  await waitFor(ctx.app, (s) => s.theme === 'light' && s.resolvedTheme === 'light')
  await expect.poll(() => shellTheme(ctx!.app)).toBe('light')
  expect(await sh.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim())).toBe('#F4F3F1')

  const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const pageColor = await page.evaluate(() => getComputedStyle(document.body).color)

  // 选中标题，让叠加层出现选中框与手柄
  const h1 = (await page.locator('h1').boundingBox())!
  await page.mouse.click(h1.x + 10, h1.y + h1.height / 2)
  await waitFor(ctx.app, (s) => s.selection?.tag === 'h1')
  await expect.poll(() => overlayAttr(ctx!.app, 'data-theme')).toBe('light')
  expect(await overlayAttr(ctx.app, 'data-page')).toBe('light')

  await sh.getByLabel('外观').selectOption('dark')
  await waitFor(ctx.app, (s) => s.theme === 'dark' && s.resolvedTheme === 'dark')
  await expect.poll(() => shellTheme(ctx!.app)).toBe('dark')
  expect(await sh.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim())).toBe('#131314')
  await expect.poll(() => overlayAttr(ctx!.app, 'data-theme')).toBe('dark')
  // 页面自身（fixture）颜色不变
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(pageBg)
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(pageColor)

  await sh.getByLabel('外观').selectOption('light')
  await waitFor(ctx.app, (s) => s.resolvedTheme === 'light')
  await expect.poll(() => shellTheme(ctx!.app)).toBe('light')
  await expect.poll(() => overlayAttr(ctx!.app, 'data-theme')).toBe('light')
})

test('V9-02 外观选择写入设置，重启后保留', async () => {
  const dir = workdir('basic.html')
  const settings = settingsFile(dir, 'light')
  ctx = await launch([path.join(dir, 'basic.html')], { settings })
  await ws(ctx.app, 'setTheme', 'dark')
  await waitFor(ctx.app, (s) => s.theme === 'dark' && s.resolvedTheme === 'dark')
  await expect.poll(() => JSON.parse(fs.readFileSync(settings, 'utf8')).theme, { timeout: 5000 }).toBe('dark')

  await ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx.app.close()
  ctx = await launch([path.join(dir, 'basic.html')], { settings })
  const s = await waitFor(ctx.app, (x) => x.theme === 'dark' && x.resolvedTheme === 'dark')
  expect(s.theme).toBe('dark')
  await expect.poll(() => shellTheme(ctx!.app)).toBe('dark')
})

test('V9-03 跟随系统：macOS 明暗变化实时生效；显式选择不跟随', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')], { settings: settingsFile(dir, 'system') })
  expect((await waitFor(ctx.app, (s) => s.theme === 'system')).theme).toBe('system')

  // nativeTheme.themeSource 在这里只用于模拟操作系统外观变化（应用自身不设置它）
  await ctx.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark'
  })
  await waitFor(ctx.app, (s) => s.resolvedTheme === 'dark')
  await expect.poll(() => shellTheme(ctx!.app)).toBe('dark')
  await expect.poll(() => overlayAttr(ctx!.app, 'data-theme')).toBe('dark')

  await ctx.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light'
  })
  await waitFor(ctx.app, (s) => s.resolvedTheme === 'light')
  await expect.poll(() => shellTheme(ctx!.app)).toBe('light')

  // 显式浅色后，把系统改成深色也不应跟随
  await ws(ctx.app, 'setTheme', 'light')
  await waitFor(ctx.app, (s) => s.theme === 'light' && s.resolvedTheme === 'light')
  await ctx.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark'
  })
  await sleep(400)
  expect((await state(ctx.app)).resolvedTheme).toBe('light')
  await expect.poll(() => shellTheme(ctx!.app)).toBe('light')
})

test('V9-04 深色文档 + 浅色应用：叠加层按页面明暗换线色，仍不修改页面', async () => {
  const dir = workdir()
  const file = path.join(dir, 'dark-page.html')
  fs.writeFileSync(
    file,
    '<!doctype html><html><head><meta charset="utf-8"><title>dark</title></head><body style="margin:0;background:#101216;color:#f5f5f5;font:16px sans-serif"><h1 id="t">深色页面</h1><p>正文</p></body></html>'
  )
  ctx = await launch([file], { settings: settingsFile(dir, 'light') })
  const page = await preview(ctx.app)
  await waitFor(ctx.app, (s) => s.resolvedTheme === 'light')
  await expect.poll(() => overlayAttr(ctx!.app, 'data-page')).toBe('dark')
  // page token 换成深色页面版本（选中框/手柄在深色页面上仍清楚）
  await expect.poll(() => overlayAttr(ctx!.app, 'data-theme')).toBe('light')
  const t = (await page.locator('#t').boundingBox())!
  await page.mouse.click(t.x + 10, t.y + t.height / 2)
  await waitFor(ctx.app, (s) => s.selection?.tag === 'h1')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(16, 18, 22)')
})
