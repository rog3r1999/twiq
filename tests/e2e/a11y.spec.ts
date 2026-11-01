// 键盘与无障碍（UX-09 可自动化部分、规格 11.3 标注）
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { launch, preview, shell, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx | null = null
test.afterEach(async () => {
  if (!ctx) return
  await ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx.app.close().catch(() => {})
})

test('UX-09 键盘全流程：外壳 Tab 进入页面，Tab 到某处，Enter 编辑，改字，Enter 完成，保存', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  // 外壳焦点顺序：工具栏 → 标签栏 → 进入页面
  await sh.locator('.toolbar button').first().focus()
  const order: string[] = []
  for (let i = 0; i < 12; i++) {
    await sh.keyboard.press('Tab')
    const label = await sh.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return el ? el.getAttribute('aria-label') ?? el.getAttribute('role') ?? el.tagName : ''
    })
    order.push(label)
    if (label === '进入页面内容') break
  }
  expect(order).toContain('保存')
  expect(order).toContain('tab')
  expect(order.at(-1)).toBe('进入页面内容')
  await sleep(200)
  // 页面内：Tab 在可编辑 host 之间移动（第一下进入第一个 host）
  await page.keyboard.press('Tab')
  await waitFor(ctx.app, (s) => s.hover?.breadcrumb.join('>') === 'body>p')
  await page.keyboard.press('Enter')
  await waitFor(ctx.app, (s) => s.editing)
  await page.keyboard.type('键')
  await page.keyboard.press('Enter')
  await waitFor(ctx.app, (s) => !s.editing && s.tabs[0].dirty)
  await ws(ctx.app, 'save')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
})

test('11.3 读屏标注：工具栏、模式切换、标签栏、播报区域', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const sh = await shell(ctx.app)
  await expect(sh.locator('[role=toolbar] button[aria-label]')).not.toHaveCount(0)
  await expect(sh.locator('[role=radiogroup] [role=radio]')).toHaveCount(2) // v0.8：编辑、预览
  await expect(sh.getByRole('tablist', { name: '打开的文档' }).getByRole('tab')).toHaveCount(1)
  // v0.10 属性面板的两页（属性 / 改动）是另一组 tab，各自指向同一个 tabpanel
  const panelTabs = sh.getByRole('tablist', { name: '属性面板' }).getByRole('tab')
  await expect(panelTabs).toHaveCount(2)
  await expect(panelTabs.first()).toHaveAttribute('aria-controls', 'panel-body')
  await expect(sh.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'ptab-props')
  await expect(sh.locator('[aria-live=polite]')).not.toHaveCount(0)
  await expect(sh.locator('[aria-live=assertive]')).toHaveCount(1)
  // 焦点环：任何可聚焦元素都有可见焦点环
  await sh.locator('.toolbar button').first().focus()
  await sh.keyboard.press('Tab')
  const outline = await sh.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)
  expect(outline).not.toBe('none')
})
