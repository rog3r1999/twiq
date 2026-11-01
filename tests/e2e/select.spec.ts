// v0.2–v0.4：选择模式、结构操作、样式、文字格式（规格 20.2–20.4）。
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { clickAt, editing, launch, preview, quit, read, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await quit(ctx)
})

async function setup() {
  const dir = workdir('blocks.html')
  const file = path.join(dir, 'blocks.html')
  ctx = await launch([file])
  let page = await preview(ctx.app)
  await ws(ctx.app, 'setMode', 'select')
  await waitFor(ctx.app, (s) => s.tabs[0].mode === 'edit')
  await sleep(300)
  return { file, orig: read(file), page: async () => (page = await preview(ctx.app)), first: page }
}

async function clickEl(page: import('@playwright/test').Page, sel: string) {
  const b = (await page.locator(sel).boundingBox())!
  await page.mouse.move(b.x + 3, b.y + 3)
  await page.mouse.click(b.x + 3, b.y + 3)
}

test('V2-01 单击选中、Delete 删除、撤销恢复，源码独占行整行删除', async () => {
  const { file, orig, first } = await setup()
  await clickEl(first, '#p2')
  const s = await waitFor(ctx.app, (x) => x.selection?.id === 'p2')
  expect(s.selection).toMatchObject({ tag: 'p', range: true })
  await first.keyboard.press('Delete')
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  const page = await preview(ctx.app)
  await expect(page.locator('#p2')).toHaveCount(0)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('<p id="p2">第二段</p>\n', ''))
  await ws(ctx.app, 'undo')
  const p3 = await preview(ctx.app)
  await expect(p3.locator('#p2')).toHaveCount(1)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig)
})

test('V2-02 Cmd/Ctrl+D 复制并选中新元素；Alt+↑ 选父元素', async () => {
  const { file, orig, first } = await setup()
  await clickEl(first, '#list li:nth-child(2)')
  await waitFor(ctx.app, (x) => x.selection?.tag === 'li')
  await first.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d')
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  const page = await preview(ctx.app)
  await expect(page.locator('#list li')).toHaveCount(4)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'li')
  await page.keyboard.press('Alt+ArrowUp')
  await waitFor(ctx.app, (x) => x.selection?.id === 'list')
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('  <li>二</li>\n', '  <li>二</li>\n  <li>二</li>\n'))
})

test('V2-03 拖放换位：li 拖到第三项之后', async () => {
  const { file, orig, first } = await setup()
  const a = (await first.locator('#list li:nth-child(1)').boundingBox())!
  const c = (await first.locator('#list li:nth-child(3)').boundingBox())!
  await first.mouse.move(a.x + 5, a.y + a.height / 2)
  await first.mouse.down()
  await first.mouse.move(a.x + 8, a.y + a.height / 2 + 6, { steps: 3 })
  await first.mouse.move(c.x + 8, c.y + c.height - 2, { steps: 8 })
  await sleep(100)
  await first.mouse.up()
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('  <li>一</li>\n  <li>二</li>\n  <li>三</li>\n', '  <li>二</li>\n  <li>三</li>\n  <li>一</li>\n'))
})

test('V2-04 li 拖出列表被拒绝，源码不变', async () => {
  const { first } = await setup()
  const a = (await first.locator('#list li:nth-child(1)').boundingBox())!
  const t = (await first.locator('#title').boundingBox())!
  await first.mouse.move(a.x + 5, a.y + a.height / 2)
  await first.mouse.down()
  await first.mouse.move(a.x + 10, a.y + 10, { steps: 3 })
  await first.mouse.move(t.x + 10, t.y + 4, { steps: 8 })
  await first.mouse.up()
  await sleep(500)
  const s = await state(ctx.app)
  expect(s.tabs[0].dirty).toBe(false)
})

test('V3-01 属性面板改颜色写入 style 属性；重置删除整个属性', async () => {
  const { file, orig, first } = await setup()
  await clickEl(first, '#title')
  const s = await waitFor(ctx.app, (x) => x.selection?.id === 'title')
  await ws(ctx.app, 'applyOp', { type: 'setStyle', eid: s.selection!.eid, props: { color: '#ff0000' } })
  await expect(first.locator('#title')).toHaveAttribute('style', 'color: #ff0000')
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('<h1 id="title">', '<h1 style="color: #ff0000" id="title">'))
  await ws(ctx.app, 'applyOp', { type: 'setStyle', eid: s.selection!.eid, props: { color: null } })
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig)
})

test('V3-02 方向键微调写入 position 与 left/top，连续按键合并为一步撤销', async () => {
  const { file, orig, first } = await setup()
  await clickEl(first, '#p1')
  await waitFor(ctx.app, (x) => x.selection?.id === 'p1')
  await first.keyboard.press('ArrowRight')
  await first.keyboard.press('ArrowRight')
  await first.keyboard.press('Shift+ArrowDown')
  await waitFor(ctx.app, (x) => (x.selection?.style ?? '').includes('top: 10px'))
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('<p id="p1">', '<p style="position: relative; left: 2px; top: 10px" id="p1">'))
  await ws(ctx.app, 'undo')
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig)
})

test('V3-03 文字格式：选中文字后 Cmd/Ctrl+B 包上 b，并回到编辑', async () => {
  const { file, orig, first } = await setup()
  await ws(ctx.app, 'setMode', 'edit')
  await clickAt(first, '#p2', { offset: 1 })
  await editing(ctx.app, true)
  await first.evaluate(() => {
    const t = document.querySelector('#p2')!.firstChild!
    const r = document.createRange()
    r.setStart(t, 1)
    r.setEnd(t, 2)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
  })
  await first.keyboard.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b')
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await editing(ctx.app, true)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('<p id="p2">第二段</p>', '<p id="p2">第<b>二</b>段</p>'))
})

test('V3-04 尺寸手柄：拖动右下角写入 width 与 height；弹性布局同时固定伸缩值', async () => {
  const { file, first } = await setup()
  await clickEl(first, '#c1')
  await waitFor(ctx.app, (x) => x.selection?.id === 'c1')
  const b = (await first.locator('#c1').boundingBox())!
  await first.mouse.move(b.x + b.width, b.y + b.height)
  await first.mouse.down()
  await first.mouse.move(b.x + b.width + 30, b.y + b.height + 20, { steps: 5 })
  await first.mouse.up()
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  const src = read(file)
  expect(src).toMatch(/<div style="width: \d+px; height: \d+px; flex-grow: 0; flex-shrink: 0; flex-basis: auto" class="card" id="c1">/)
})

test('V2-05 面包屑可点击选中祖先', async () => {
  const { first } = await setup()
  await clickEl(first, '#c2')
  const s = await waitFor(ctx.app, (x) => x.selection?.id === 'c2')
  const row = s.hover!.eids![s.hover!.eids!.length - 2]!
  await ws(ctx.app, 'selectEid', row)
  await waitFor(ctx.app, (x) => x.selection?.cls === 'row')
})
