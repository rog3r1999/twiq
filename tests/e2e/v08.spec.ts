// v0.8.1：选中块（或多选）后在块内按下拖动，整块一起走，不再退回拖里层段落。
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { launch, preview, quit, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await quit(ctx)
})

async function setup() {
  const dir = workdir('v08')
  ctx = await launch([path.join(dir, 'v08', 'index.html')])
  const page = await preview(ctx.app)
  await sleep(300)
  return { dir, page }
}

/** 拖动从 (x0,y0) 到 (x1,y1)，中间多步，模拟真实手势。 */
async function dragFrom(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x0 + 3, y0 + 3, { steps: 2 })
  await page.mouse.move(x1, y1, { steps: 10 })
  await sleep(80)
  await page.mouse.up()
}

/** 块内段落的中心点。 */
async function pCenter(page: Page, id: string) {
  const b = (await page.locator(`#${id} p`).boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** 块自身的空白处（左下角内边距里），点这里不会命中里层元素。 */
async function blockPad(page: Page, id: string) {
  const b = (await page.locator(`#${id}`).boundingBox())!
  return { x: b.x + 5, y: b.y + b.height - 5 }
}

test('V8-01 选中块后从块内文字拖动：整块移动，段落不脱离块', async () => {
  const { page } = await setup()
  const p1 = await pCenter(page, 'b1')
  await page.mouse.click(p1.x, p1.y)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'p')
  await page.keyboard.press('Alt+ArrowUp')
  await waitFor(ctx.app, (x) => x.selection?.id === 'b1')
  // 从块里的段落按下拖动（改前这里会把 <p> 拖出块）
  const from = await pCenter(page, 'b1')
  // 拖到 b4 的右半边：网格同行时按左右决定落点在前后
  const b4 = (await page.locator('#b4').boundingBox())!
  await dragFrom(page, from.x, from.y, b4.x + b4.width - 6, b4.y + b4.height / 2)
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  const ids = () => page.evaluate(() => Array.from(document.querySelectorAll('#grid > .blk')).map((e) => e.id))
  await expect.poll(ids).toEqual(['b2', 'b3', 'b4', 'b1'])
  // 结构完整：每个块仍然只有一个直属段落
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('#grid > .blk')).every((b) => b.querySelectorAll(':scope > p').length === 1))).toBe(true)
  expect((await state(ctx.app)).statusNote).toContain('已移动')
  await ws(ctx.app, 'save')
})

test('V8-02 单击语义不变：选中块后单击块内文字，选中里层段落；再点一次改文字', async () => {
  const { page } = await setup()
  const p = await pCenter(page, 'b1')
  await page.mouse.click(p.x, p.y)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'p')
  await page.keyboard.press('Alt+ArrowUp')
  await waitFor(ctx.app, (x) => x.selection?.id === 'b1')
  // 单击（不拖）：还是选到里层段落
  await page.mouse.click(p.x, p.y)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'p' && !x.editing)
  // 再点一次：进入改文字
  await page.mouse.click(p.x, p.y)
  await waitFor(ctx.app, (x) => x.editing)
  await page.keyboard.press('Escape')
})

test('V8-03 多选后从其中一个块的文字拖动：两个块一起移动', async () => {
  const { page } = await setup()
  const p1 = await pCenter(page, 'b1')
  await page.mouse.click(p1.x, p1.y)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'p')
  await page.keyboard.press('Alt+ArrowUp')
  await waitFor(ctx.app, (x) => x.selection?.id === 'b1')
  const pad2 = await blockPad(page, 'b2')
  await page.keyboard.down('Shift')
  await page.mouse.click(pad2.x, pad2.y)
  await page.keyboard.up('Shift')
  await waitFor(ctx.app, (x) => (x.selection?.multi?.length ?? 0) === 2)
  // 从 b1 的文字上按下拖动：改前会丢掉多选、只拖走一个 <p>
  const b4 = (await page.locator('#b4').boundingBox())!
  await dragFrom(page, p1.x, p1.y, b4.x + b4.width - 6, b4.y + b4.height / 2)
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  const ids = () => page.evaluate(() => Array.from(document.querySelectorAll('#grid > .blk')).map((e) => e.id))
  await expect.poll(ids).toEqual(['b3', 'b4', 'b1', 'b2'])
  await ws(ctx.app, 'save')
})

test('V8-04 Cmd/Ctrl+A 全选同级；菜单「全选」不再占用加速键', async () => {
  const { page } = await setup()
  const p = await pCenter(page, 'b2')
  await page.mouse.click(p.x, p.y)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'p')
  await page.keyboard.press('Alt+ArrowUp')
  await waitFor(ctx.app, (x) => x.selection?.id === 'b2')
  await page.keyboard.press('ControlOrMeta+a')
  await waitFor(ctx.app, (x) => (x.selection?.multi?.length ?? 0) === 4)
  // 菜单项没有加速键，真实的 Cmd+A 才会落到页面里
  const acc = await ctx.app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => i.label === '编辑')
    return edit?.submenu?.items.find((i) => i.label === '全选')?.accelerator ?? null
  })
  expect(acc).toBeNull()
})

test('V8-05 抓取光标：文字块悬停是 text，块按下是 grab、拖起来是 grabbing', async () => {
  const { page } = await setup()
  const p1 = await pCenter(page, 'b1')
  await page.mouse.click(p1.x, p1.y)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'p')
  const cursor = (sel?: string) =>
    page.evaluate((s) => getComputedStyle(s ? document.querySelector(s)! : document.documentElement).cursor, sel)
  // 选中文字块：悬停仍是文字光标（点一下改字）
  await page.mouse.move(p1.x, p1.y)
  await sleep(80)
  expect(await cursor('#b1 p')).toBe('text')
  // 选中块容器：悬停是张开的手（提示整块可以拖）
  await page.keyboard.press('Alt+ArrowUp')
  await waitFor(ctx.app, (x) => x.selection?.id === 'b1')
  await page.mouse.move(p1.x, p1.y)
  await sleep(80)
  expect(await cursor('#b1')).toBe('grab')
  // 按下立刻抓住（还没过拖动阈值也是 grab），拖起来变 grabbing
  await page.mouse.down()
  await sleep(30)
  expect(await cursor()).toBe('grab')
  await page.mouse.move(p1.x + 40, p1.y + 20, { steps: 4 })
  await sleep(80)
  expect(await cursor()).toBe('grabbing')
  await page.mouse.up()
  await sleep(120)
  expect(await cursor('#b1')).toBe('grab')
  await ws(ctx.app, 'save')
})

test('V8-06 块左上角的拖动手柄：悬停文字块出现，按住拖动能整块换位', async () => {
  const { page } = await setup()
  const ids = () => page.evaluate(() => Array.from(document.querySelectorAll('#grid > .blk')).map((e) => e.id))
  const b1 = (await page.locator('#b1').boundingBox())!
  const b4 = (await page.locator('#b4').boundingBox())!
  // 手柄在块的左上角内侧（内缩 8px，14×24）
  const gx = b1.x + 8 + 7
  const gy = b1.y + 8 + 12
  const p1 = await pCenter(page, 'b1')
  await page.mouse.click(p1.x, p1.y)
  await waitFor(ctx.app, (x) => x.selection?.tag === 'p')
  await page.mouse.move(p1.x, p1.y)
  await sleep(120)
  // 悬停文字块本身仍是文字光标（不需要为了移动块换成手掌）
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#b1 p')!).cursor)).toBe('text')
  // 从文字里挪到手柄上：块不消失，按下即抓住（光标变成 grab）
  await page.mouse.move(gx, gy, { steps: 8 })
  await sleep(60)
  await page.mouse.down()
  await sleep(30)
  // 按在手柄上：光标是抓取，且块已被选中
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).cursor)).toBe('grab')
  await waitFor(ctx.app, (x) => x.selection?.id === 'b1')
  await page.mouse.move(gx + (b4.x + b4.width - 8 - gx) / 2, gy + (b4.y + b4.height / 2 - gy) / 2, { steps: 6 })
  await sleep(60)
  await page.mouse.move(b4.x + b4.width - 8, b4.y + b4.height / 2, { steps: 6 })
  await sleep(80)
  await page.mouse.up()
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await expect.poll(ids).toEqual(['b2', 'b3', 'b4', 'b1'])
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('#grid > .blk')).every((b) => b.querySelectorAll(':scope > p').length === 1))).toBe(true)
  await ws(ctx.app, 'save')
})
