// v0.7：属性面板拉宽与预览缩放、SVG 结构化编辑与源码保护、插入菜单、复制源码。
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { launch, preview, read, shell, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await ctx?.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx?.app.close()
})

async function setup() {
  const dir = workdir('v06')
  const file = path.join(dir, 'v06', 'index.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await ws(ctx.app, 'setMode', 'select')
  await waitFor(ctx.app, (s) => s.tabs[0].mode === 'edit')
  await sleep(300)
  const sh = await shell(ctx.app)
  return { file, orig: read(file), page, sh }
}

const clipboardText = () => ctx.app.evaluate(({ clipboard }) => clipboard.readText())

test('V7-01 拖动面板左边缘调宽：页面不重新排版，按比例缩小；双击恢复', async () => {
  const { page, sh } = await setup()
  const vw0 = await page.evaluate(() => window.innerWidth)
  const panel = sh.locator('.panel-host')
  const w0 = (await panel.boundingBox())!.width
  const h = (await sh.locator('.panel-resize').boundingBox())!
  await sh.mouse.move(h.x + 3, h.y + 200)
  await sh.mouse.down()
  await sh.mouse.move(h.x - 100, h.y + 200, { steps: 6 })
  await sh.mouse.move(h.x - 200, h.y + 200, { steps: 6 })
  await sh.mouse.up()
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(w0 + 180)
  await waitFor(ctx.app, (x) => x.fit < 1 && x.panelWidth > 440)
  // 页面的 CSS 视口宽度不变（只缩放，不重排）
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(vw0)
  // 拖动结束后面板宽度可能再落定一次；同时取当前 state 与当前文案，避免拿旧快照比新渲染
  await expect.poll(async () => {
    const s = await state(ctx.app)
    return (await sh.locator('.zoom .fit').textContent()) === `显示 ${Math.round(100 * s.fit)}%`
  }).toBe(true)
  // 双击恢复默认宽度
  await sh.locator('.panel-resize').dblclick()
  await waitFor(ctx.app, (x) => x.fit === 1 && x.panelWidth === 280)
  await expect(sh.locator('.zoom .fit')).toHaveCount(0)
  // 键盘也能调
  await sh.locator('.panel-resize').focus()
  await sh.keyboard.press('ArrowLeft')
  await waitFor(ctx.app, (x) => x.panelWidth === 296)
})

test('V7-02 SVG 源码默认收起，点开才显示；收起后不再出现源码框', async () => {
  const { page, sh } = await setup()
  const r = (await page.locator('#bar').boundingBox())!
  await page.mouse.click(r.x + 5, r.y + 5)
  await waitFor(ctx.app, (x) => x.selection?.id === 'chart' && !!x.svgModel)
  await expect(sh.locator('.svg-content')).toBeVisible()
  await expect(sh.locator('textarea.svg-src')).toHaveCount(0)
  await sh.locator('button', { hasText: '编辑 SVG 源码…' }).click()
  await expect(sh.locator('textarea.svg-src')).toBeVisible()
  await expect(sh.locator('.hint-line.warn', { hasText: '直接改源码' })).toBeVisible()
  await sh.locator('.panel h3 .link', { hasText: '收起' }).click()
  await expect(sh.locator('textarea.svg-src')).toHaveCount(0)
})

test('V7-03 SVG 内容表单：改文字实时预览，回车写回一次补丁；Esc 放弃', async () => {
  const { file, orig, page, sh } = await setup()
  const r = (await page.locator('#bar').boundingBox())!
  await page.mouse.click(r.x + 5, r.y + 5)
  await waitFor(ctx.app, (x) => !!x.svgModel)
  const input = sh.getByLabel('文字 label 的内容')
  await expect(input).toHaveValue('销量')
  await input.fill('收入')
  // 输入中：页面已变，源码未写
  await expect.poll(() => page.locator('#label').textContent()).toBe('收入')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  await input.press('Enter')
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('>销量</text>', '>收入</text>'))
  // Esc：页面恢复，不写入
  await input.fill('乱码')
  await expect.poll(() => page.locator('#label').textContent()).toBe('乱码')
  await input.press('Escape')
  await expect.poll(() => page.locator('#label').textContent()).toBe('收入')
  await sleep(200)
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  // 一步撤销
  await ws(ctx.app, 'undo')
  await expect.poll(() => page.locator('#label').textContent()).toBe('销量')
})

test('V7-04 SVG 内容表单：展开形状，改坐标实时预览、失焦写回；新增源码里没有的属性', async () => {
  const { file, orig, page, sh } = await setup()
  const r = (await page.locator('#bar').boundingBox())!
  await page.mouse.click(r.x + 5, r.y + 5)
  await waitFor(ctx.app, (x) => !!x.svgModel)
  await sh.locator('.svg-pick', { hasText: '#dot' }).click()
  // 点列表项会进入 SVG 并选中该形状
  await waitFor(ctx.app, (x) => x.selection?.id === 'dot')
  const cx = sh.getByLabel('圆心 X（cx）')
  await expect(cx).toHaveValue('180')
  await cx.fill('150')
  await expect.poll(() => page.locator('#dot').getAttribute('cx')).toBe('150')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  // 方向键微调
  await cx.press('ArrowUp')
  await expect.poll(() => page.locator('#dot').getAttribute('cx')).toBe('151')
  await sh.getByLabel('描边粗细（stroke-width）').fill('3')
  await expect.poll(() => page.locator('#dot').getAttribute('stroke-width')).toBe('3')
  await sh.getByLabel('描边粗细（stroke-width）').press('Enter')
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('<circle id="dot" cx="180"', '<circle stroke-width="3" id="dot" cx="151"'))
})

test('V7-05 「插入到后面」：点开才出现选项；未保存的文档不能插媒体并说明原因', async () => {
  const { sh, page } = await setup()
  await page.locator('#c1').click({ position: { x: 3, y: 3 } })
  await waitFor(ctx.app, (x) => x.selection?.id === 'c1')
  await expect(sh.locator('.insert .menu')).toHaveCount(0)
  await sh.locator('.insert-btn').click()
  const items = sh.locator('.insert .menu [role="menuitem"]')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('图片、视频或音频')
  await expect(items.nth(1)).toBeDisabled()
  await sh.keyboard.press('Escape')
  await expect(sh.locator('.insert .menu')).toHaveCount(0)
  // 新建未保存的文档：媒体项禁用并写明原因
  await ws(ctx.app, 'newDoc')
  await waitFor(ctx.app, (x) => x.tabs.length === 2)
  const p2 = await preview(ctx.app)
  await ws(ctx.app, 'setMode', 'select')
  await sleep(300)
  await p2.locator('body *').first().click({ position: { x: 2, y: 2 } })
  await waitFor(ctx.app, (x) => !!x.selection)
  await sh.locator('.insert-btn').click()
  await expect(items.nth(0)).toBeDisabled()
  await expect(items.nth(0)).toContainText('需要先保存文档')
})

test('V7-06 复制源码：面板按钮与状态栏按钮都写入系统剪贴板，可再粘贴到后面', async () => {
  const { file, orig, page, sh } = await setup()
  await page.locator('#c2').click({ position: { x: 3, y: 3 } })
  await waitFor(ctx.app, (x) => x.selection?.id === 'c2')
  await sh.locator('.panel .actions button', { hasText: '复制源码' }).click()
  await expect.poll(clipboardText).toBe('<div class="card" id="c2">卡二</div>')
  // 省略结束标签的列表项：补上 </li>
  await page.locator('#loose li').first().click({ position: { x: 3, y: 3 } })
  await waitFor(ctx.app, (x) => x.selection?.tag === 'li')
  await sh.locator('.statusbar .copy-src').click()
  await expect.poll(clipboardText).toBe('<li>甲</li>')
  // 粘贴到后面
  await sh.locator('.insert-btn').click()
  await sh.locator('.insert .menu [role="menuitem"]', { hasText: '粘贴复制的元素' }).click()
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('  <li>甲\n', '  <li>甲\n  <li>甲</li>\n'))
})
