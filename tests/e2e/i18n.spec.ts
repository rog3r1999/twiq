// v0.10 界面语言：英文界面、运行中切换、持久化、升级用户保持中文；页面本身不受影响。
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, preview, quit, shell, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx | null = null

test.afterEach(async () => {
  if (!ctx) return
  await quit(ctx)
  ctx = null
})

/** 不带 TWIQ_LANG：按设置文件里的语言偏好走 */
const real = { TWIQ_LANG: '' }

function settingsWith(obj: object | null): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hw-set-')), 'settings.json')
  if (obj) fs.writeFileSync(file, JSON.stringify(obj))
  return file
}

/** 顶层菜单与「查看 › 语言」子菜单的文字 */
function menuLabels(app: Ctx['app']): Promise<{ top: string[]; langs: { label: string; checked: boolean }[] }> {
  return app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu()!
    const view = m.items.find((i) => i.submenu?.items.some((x) => x.submenu?.items.some((y) => y.label === 'English')))
    const langs = view!.submenu!.items.find((x) => x.submenu?.items.some((y) => y.label === 'English'))!.submenu!.items
    return { top: m.items.map((i) => i.label), langs: langs.map((i) => ({ label: i.label, checked: i.checked })) }
  })
}

test('I18N-E1 英文界面：工具栏、空状态、菜单、状态栏、新建文档模板都是英文；叠加层标注语言', async () => {
  ctx = await launch([], { settings: settingsWith({ lang: 'en' }), env: real })
  const sh = await shell(ctx.app)
  await waitFor(ctx.app, (s) => s.lang === 'en' && s.langPref === 'en')
  await expect(sh.locator('.empty h1')).toHaveText('Point, click, and fix the text on the page')
  await expect(sh.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  expect(await sh.evaluate(() => document.documentElement.lang)).toBe('en')
  const menu = await menuLabels(ctx.app)
  expect(menu.top).toEqual(expect.arrayContaining(['File', 'Edit', 'View', 'Window', 'Help']))
  expect(menu.langs.find((l) => l.checked)?.label).toBe('English')

  await ws(ctx.app, 'newDoc')
  const page = await preview(ctx.app)
  expect(await page.evaluate(() => [document.documentElement.lang, document.querySelector('h1')?.textContent])).toEqual(['en', 'Heading'])
  await expect(sh.locator('.statusbar .hints')).toContainText('Click to select')
  await expect(page.locator('#hw-overlay-root')).toHaveAttribute('lang', 'en')
  const s = await state(ctx.app)
  expect(s.tabs[0].name).toBe('Untitled')
  // 示例页面也是英文的
  await ws(ctx.app, 'loadSample')
  await waitFor(ctx.app, (x) => x.tabs.length === 2)
  const sample = await preview(ctx.app)
  await expect(sample.locator('h1')).toHaveText('Welcome to Twiq')
  await expect.poll(() => sample.locator('#visitors').textContent()).toBe('12,345 visitors')
})

test('I18N-E2 运行中切换语言：外壳、菜单、叠加层即时更新，页面不重新加载，偏好写入设置', async () => {
  const dir = workdir('basic.html')
  const settings = settingsWith({ lang: 'en' })
  ctx = await launch([path.join(dir, 'basic.html')], { settings, env: real })
  const sh = await shell(ctx.app)
  const page = await preview(ctx.app)
  await expect(sh.getByRole('radio', { name: 'Edit' })).toBeVisible()
  // 页面上做个记号：切换语言后它还在，说明页面没有被重新加载
  await page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 42))

  await ws(ctx.app, 'command', { type: 'lang', value: 'zh' })
  await waitFor(ctx.app, (s) => s.lang === 'zh' && s.langPref === 'zh')
  await expect(sh.getByRole('radio', { name: '编辑' })).toBeVisible()
  await expect(sh.locator('.statusbar .hints')).toContainText('点击选中')
  expect((await menuLabels(ctx.app)).top).toEqual(expect.arrayContaining(['文件', '编辑', '查看']))
  await expect(page.locator('#hw-overlay-root')).toHaveAttribute('lang', 'zh-CN')
  expect(await page.evaluate(() => (window as unknown as { __mark?: number }).__mark)).toBe(42)
  // 被预览的文档语言与文字不变
  expect(await page.evaluate(() => document.querySelector('h1')?.textContent)).toBe('基础标题')
  await expect.poll(() => JSON.parse(fs.readFileSync(settings, 'utf8')).lang, { timeout: 5000 }).toBe('zh')
})

test('I18N-E3 升级上来的用户（设置里没有 lang）保持中文；全新安装按系统语言', async () => {
  ctx = await launch([], { settings: settingsWith({ theme: 'light' }), env: real })
  await waitFor(ctx.app, (s) => s.langPref === 'zh' && s.lang === 'zh')
  await ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx.app.close()

  ctx = await launch([], { settings: settingsWith(null), env: real })
  const sys = await ctx.app.evaluate(({ app }) => app.getPreferredSystemLanguages()[0] ?? '')
  const s = await waitFor(ctx.app, (x) => x.langPref === 'system')
  expect(s.lang).toBe(/^zh\b/i.test(sys) ? 'zh' : 'en')
})
