// C. 不可编辑与模式（AC-25 至 AC-28、AC-44）；H. 体验（UX-01、UX-02）
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { clickAt, launch, preview, shell, sleep, state, stubDialogs, waitFor, workdir, ws, dialogTitles, type Ctx } from './helpers'

let ctx: Ctx | null = null
test.afterEach(async () => {
  if (!ctx) return
  await ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx.app.close().catch(() => {})
  ctx = null
})

async function clickReason(c: Ctx, selector: string): Promise<string | null> {
  const page = await preview(c.app)
  await clickAt(page, selector, { end: true })
  const s = await waitFor(c.app, (x) => !!x.statusNote, 3000).catch(() => null)
  await sleep(100)
  expect((await state(c.app)).editing).toBe(false)
  return s?.statusNote ?? null
}

test('AC-25 脚本生成的文字：单击立即出现原因，不进入编辑', async () => {
  const dir = workdir('js-render.html')
  ctx = await launch([path.join(dir, 'js-render.html')])
  expect(await clickReason(ctx, '#num')).toContain('页面脚本')
})

test('AC-26 脚本改写：点击被改写的段落被拒，其他文字正常', async () => {
  const dir = workdir('js-rewrite.html')
  ctx = await launch([path.join(dir, 'js-rewrite.html')])
  const page = await preview(ctx.app)
  await expect.poll(() => page.locator('#target').textContent()).toBe('被脚本改写后的文字')
  expect(await clickReason(ctx, '#target')).toContain('页面脚本')
  await clickAt(page, '#other', { end: true })
  await waitFor(ctx.app, (s) => s.editing)
})

test('AC-27 其他不可编辑：pre、svg、textarea、块级混排、注释', async () => {
  const dir = workdir('pre-svg-textarea.html', 'comment-in-text.html')
  ctx = await launch([path.join(dir, 'pre-svg-textarea.html')])
  expect(await clickReason(ctx, '#pre')).toContain('预格式化文本')
  await sleep(2400)
  // v0.8：SVG 里的文字点两下进入 SVG 内部（与双击相同），不再只给原因
  expect(await clickReason(ctx, '#svgtext')).toContain('已进入 SVG 内部')
  // 退出 SVG 内部并取消选中（选中框的工具条会盖住下面的内容）
  // 第一下 Esc 先关掉提示，之后逐层退出
  for (let i = 0; i < 6 && (await state(ctx.app)).selection; i++) {
    await (await preview(ctx.app)).keyboard.press('Escape')
    await sleep(80)
  }
  expect((await state(ctx.app)).selection).toBeNull()
  await sleep(2400)
  expect(await clickReason(ctx, '#block')).toContain('与块级元素混排')
  await ws(ctx.app, 'openPath', path.join(dir, 'comment-in-text.html'))
  expect(await clickReason(ctx, '#c')).toContain('HTML 注释')
})

test('AC-28 模式切换：编辑模式页面交互不触发；预览模式交互可用、外链确认、Esc 返回', async () => {
  const dir = workdir('basic.html', 'inline-controls.html')
  ctx = await launch([path.join(dir, 'inline-controls.html')])
  let page = await preview(ctx.app)
  // 编辑模式：按钮不触发
  await clickAt(page, '#btn button', { end: true })
  await sleep(200)
  expect(await page.title()).toBe('内联控件')
  await page.keyboard.press('Escape')
  // v0.8：Alt 拖动是自由移动，不再放行点击；要点页面上的按钮，切到预览模式
  await waitFor(ctx.app, (s) => !s.editing)
  await ws(ctx.app, 'setMode', 'preview')
  await page.locator('#btn button').click()
  await expect.poll(() => page.title()).toBe('clicked')
  await ws(ctx.app, 'setMode', 'edit')
  // 预览模式
  await ws(ctx.app, 'openPath', path.join(dir, 'basic.html'))
  page = await preview(ctx.app)
  await ws(ctx.app, 'setMode')
  expect((await state(ctx.app)).tabs.find((t) => t.name === 'basic.html')!.mode).toBe('preview')
  await stubDialogs(ctx.app, { responses: [1] })
  await page.click('a')
  await expect.poll(() => dialogTitles(ctx!.app)).toEqual(['在系统浏览器中打开 example.com？'])
  await page.keyboard.press('Escape')
  await waitFor(ctx.app, (s) => s.tabs.find((t) => t.name === 'basic.html')!.mode === 'edit')
})

test('AC-44 脚本渲染页：正文不可编辑，打开后提示一次', async () => {
  const dir = workdir('framework-render.html')
  ctx = await launch([path.join(dir, 'framework-render.html')])
  const page = await preview(ctx.app)
  await expect.poll(() => page.locator('h1').count(), { timeout: 15000 }).toBe(1)
  const stats = await ctx.app.evaluate(() => {
    const w = (globalThis as unknown as { __hw: { ws: { active: { stats: unknown } } } }).__hw.ws
    return w.active.stats
  })
  await expect
    .poll(() => ctx!.app.evaluate(() => (globalThis as unknown as { __hw: { ws: { active: { scriptRenderedNotified: boolean } } } }).__hw.ws.active.scriptRenderedNotified), { timeout: 8000 })
    .toBe(true)
  expect(stats === null || typeof stats === 'object').toBe(true)
  expect(await clickReason(ctx, 'p')).toContain('页面脚本')
})

test('UX-01 空状态；UX-02 示例文档', async () => {
  ctx = await launch([])
  const sh = await shell(ctx.app)
  await expect(sh.locator('.card h1')).toHaveText('用鼠标点一点，改好页面上的文字')
  await expect(sh.locator('.card .actions button')).toHaveText(['打开 HTML 文件', '新建空白文档', '载入示例页面'])
  await expect(sh.locator('.recent')).toHaveCount(0)
  await sh.locator('.card .actions button', { hasText: '载入示例页面' }).click()
  const page = await preview(ctx.app)
  await expect.poll(() => page.locator('#visitors').textContent()).toContain('位访客')
  expect(await clickReason(ctx, '#visitors')).toContain('页面脚本')
  await sleep(2400)
  expect(await clickReason(ctx, 'pre')).toContain('预格式化文本')
  await clickAt(page, 'p strong', { end: true })
  await waitFor(ctx.app, (s) => s.editing)
})

test('UX-03 拖拽提示：HTML 显示「松开，打开」遮罩；png 显示警示遮罩', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const page = await preview(ctx.app)
  const drag = (name: string, type: string) =>
    page.evaluate(
      ([n, t]) => {
        const dt = new DataTransfer()
        dt.items.add(new File(['x'], n, { type: t }))
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
      },
      [name, type]
    )
  const leave = () =>
    page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'a.html', { type: 'text/html' }))
      window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }))
    })
  await drag('a.html', 'text/html')
  expect((await waitFor(ctx.app, (s) => !!s.drag?.active)).drag).toEqual({ active: true, ok: true })
  await leave()
  await waitFor(ctx.app, (s) => !s.drag)
  await drag('a.png', 'image/png')
  expect((await waitFor(ctx.app, (s) => !!s.drag?.active)).drag).toEqual({ active: true, ok: false })
  await leave()
  await waitFor(ctx.app, (s) => !s.drag)
  // 外壳的遮罩随状态显示
  const sh = await shell(ctx.app)
  await drag('a.png', 'image/png')
  await expect(sh.locator('.dragmask.bad')).toHaveCount(1)
  await leave()
})
