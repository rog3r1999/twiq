// v0.6：拖动、缩放、层级、吸附、SVG（用户反馈的 10 项拆解）。
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { clickAt, launch, preview, quit, read, shell, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await quit(ctx)
})

async function setup(mode: 'select' | 'edit' = 'select') {
  const dir = workdir('v06')
  const file = path.join(dir, 'v06', 'index.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  if (mode === 'edit') {
    await ws(ctx.app, 'setMode', 'select')
    await waitFor(ctx.app, (s) => s.tabs[0].mode === 'edit')
  }
  await sleep(300)
  return { file, orig: read(file), page }
}

/** 预览整页载入的次数：结构操作走就地同步时不变。 */
function loads(): Promise<number> {
  return ctx.app.evaluate(() => {
    const w = (globalThis as unknown as { __hw: { ws: { active: { loads: number } } } }).__hw.ws
    return w.active.loads
  })
}

async function clickEl(page: Page, sel: string, dx = 3, dy = 3) {
  const b = (await page.locator(sel).boundingBox())!
  await page.mouse.move(b.x + dx, b.y + dy)
  await page.mouse.click(b.x + dx, b.y + dy)
}

/** 页面里一个标记：整页重载后会消失。 */
async function mark(page: Page) {
  await page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 1))
}
async function marked(page: Page) {
  return page.evaluate(() => (window as unknown as { __mark?: number }).__mark === 1)
}

test('V6-01 移动、删除、复制、撤销重做都就地同步：不重载、滚动位置不变、选中跟随', async () => {
  const { file, orig, page } = await setup()
  await mark(page)
  const n0 = await loads()
  await page.evaluate(() => window.scrollTo(0, 120))
  await clickEl(page, '#c1')
  await waitFor(ctx.app, (x) => x.selection?.id === 'c1')
  const c3 = (await state(ctx.app)).selection!.eid
  void c3
  // 移动：c1 放到 c3 之后
  const ids = async () => page.evaluate(() => Array.from(document.querySelectorAll('#row > .card')).map((e) => e.id))
  const eidOf = (id: string) => page.evaluate((i) => Number(document.getElementById(i)!.getAttribute('data-hw')), id)
  await ws(ctx.app, 'applyOp', { type: 'move', eid: await eidOf('c1'), target: await eidOf('c3'), where: 'after' })
  await expect.poll(ids).toEqual(['c2', 'c3', 'c1'])
  await waitFor(ctx.app, (x) => x.selection?.id === 'c1')
  // 删除、复制
  await ws(ctx.app, 'applyOp', { type: 'delete', eid: await eidOf('c2') })
  await expect.poll(ids).toEqual(['c3', 'c1'])
  await ws(ctx.app, 'applyOp', { type: 'duplicate', eid: await eidOf('c3') })
  await expect.poll(ids).toEqual(['c3', 'c3', 'c1'])
  // 撤销三次回到原样
  for (let i = 0; i < 3; i++) await ws(ctx.app, 'undo')
  await expect.poll(ids).toEqual(['c1', 'c2', 'c3'])
  await ws(ctx.app, 'redo')
  await expect.poll(ids).toEqual(['c2', 'c3', 'c1'])
  await ws(ctx.app, 'undo')
  expect(await loads()).toBe(n0)
  expect(await marked(page)).toBe(true)
  expect(await page.evaluate(() => window.scrollY)).toBe(120)
  // 就地同步后 data-hw 与主进程元素表一致：再编辑文字、保存，源码只改那一处
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig)
  await ws(ctx.app, 'setMode', 'edit')
  await clickAt(page, '#c2', { end: true })
  await waitFor(ctx.app, (x) => x.editing)
  await page.keyboard.press('End')
  await page.keyboard.type('X')
  await page.keyboard.press('Enter')
  await waitFor(ctx.app, (x) => !x.editing && x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('卡二</div>', '卡二X</div>'))
})

test('V6-02 省略 </li> 的列表项可以拖放换位，写回时补上结束标签', async () => {
  const { file, orig, page } = await setup()
  const a = (await page.locator('#loose li:nth-child(1)').boundingBox())!
  const c = (await page.locator('#loose li:nth-child(3)').boundingBox())!
  await page.mouse.move(a.x + 5, a.y + a.height / 2)
  // 预览就绪、悬停已识别到 li 再按下
  await waitFor(ctx.app, (x) => x.hover?.breadcrumb.at(-1) === 'li')
  await page.mouse.down()
  await page.mouse.move(a.x + 8, a.y + a.height / 2 + 6, { steps: 3 })
  await page.mouse.move(c.x + 8, c.y + c.height - 2, { steps: 8 })
  await sleep(100)
  await page.mouse.up()
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll('#loose li')).map((e) => e.textContent!.trim()))).toEqual(['乙', '丙', '甲'])
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('  <li>甲\n  <li>乙\n  <li>丙\n', '  <li>乙\n  <li>丙\n  <li>甲</li>\n'))
})

/** 拖动从 (x0,y0) 到 (x1,y1)，中间多步，模拟真实手势。 */
async function dragFrom(page: Page, x0: number, y0: number, x1: number, y1: number, mods: string[] = []) {
  for (const m of mods) await page.keyboard.down(m)
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x0 + 3, y0 + 3, { steps: 2 })
  await page.mouse.move(x1, y1, { steps: 10 })
  await sleep(80)
  await page.mouse.up()
  for (const m of mods) await page.keyboard.up(m)
}

test('V6-03 图片（行内替换元素）有缩放手柄，默认等比：只写 width，高度跟随', async () => {
  const { file, orig, page } = await setup()
  await clickEl(page, '#pic', 4, 4)
  await waitFor(ctx.app, (x) => x.selection?.id === 'pic')
  const b = (await page.locator('#pic').boundingBox())!
  const ratio = b.width / b.height
  // 右下角手柄
  await dragFrom(page, b.x + b.width, b.y + b.height, b.x + b.width + 41, b.y + b.height + 5)
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  const nb = (await page.locator('#pic').boundingBox())!
  expect(nb.width).toBeGreaterThan(b.width + 20)
  expect(Math.abs(nb.width / nb.height - ratio)).toBeLessThan(0.05)
  await ws(ctx.app, 'save')
  const m = /<img style="width: (\d+)px" id="pic"/.exec(read(file))
  expect(m).toBeTruthy()
  expect(read(file).replace(/<img style="width: \d+px" id="pic"/, '<img id="pic"')).toBe(orig)
})

test('V6-04 左上角手柄反向缩放；靠近兄弟宽度时吸附，按住 Cmd/Ctrl 关闭吸附', async () => {
  const { file, page } = await setup()
  await clickEl(page, '#c1')
  await waitFor(ctx.app, (x) => x.selection?.id === 'c1')
  const b = (await page.locator('#c1').boundingBox())!
  const c2 = (await page.locator('#c2').boundingBox())!
  // 左上角往左拖 → 变宽（反向锚定）
  await dragFrom(page, b.x, b.y, b.x - 30, b.y - 1)
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  const w1 = Number(/<div style="width: (\d+)px[^"]*" class="card" id="c1">/.exec(read(file))![1])
  expect(w1).toBeGreaterThan(120 + 20)
  // 右边多拖 4px：吸回兄弟的宽度，等于没改，不写源码
  await ws(ctx.app, 'undo')
  await ws(ctx.app, 'save')
  await clickEl(page, '#c1')
  const bb = (await page.locator('#c1').boundingBox())!
  expect(Math.round(bb.width)).toBe(Math.round(c2.width))
  await dragFrom(page, bb.x + bb.width, bb.y + bb.height / 2, bb.x + bb.width + 4, bb.y + bb.height / 2)
  await sleep(300)
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  // 按住 Cmd / Ctrl 关闭吸附：写入 +4
  await clickEl(page, '#c1')
  await dragFrom(page, bb.x + bb.width, bb.y + bb.height / 2, bb.x + bb.width + 4, bb.y + bb.height / 2, [process.platform === 'darwin' ? 'Meta' : 'Control'])
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  const w2 = Number(/<div style="width: (\d+)px[^"]*" class="card" id="c1">/.exec(read(file))![1])
  // c1 content-box：写入值 = 视觉宽度 - 内边距与边框（18px）
  expect(w2 + 18).toBe(Math.round(c2.width) + 4)
})

test('V6-05 选中后显示同级位置；Alt+→ 切到下一个同级', async () => {
  const { page } = await setup()
  await clickEl(page, '#c1')
  let s = await waitFor(ctx.app, (x) => x.selection?.id === 'c1')
  expect([s.selection!.index, s.selection!.siblings]).toEqual([1, 3])
  await page.keyboard.press('Alt+ArrowRight')
  s = await waitFor(ctx.app, (x) => x.selection?.id === 'c2')
  expect(s.selection!.index).toBe(2)
  const sh = await shell(ctx.app)
  await expect(sh.locator('.statusbar .level')).toHaveText(/第 2 \/ 3 项/)
})

test('V6-06 Shift 点击多选同级，跨层级拒绝；批量删除一步撤销；多选整体拖放', async () => {
  const { file, orig, page } = await setup()
  await clickEl(page, '#c1')
  await waitFor(ctx.app, (x) => x.selection?.id === 'c1')
  await page.keyboard.down('Shift')
  await clickEl(page, '#c2')
  await page.keyboard.up('Shift')
  await waitFor(ctx.app, (x) => (x.selection?.multi?.length ?? 0) === 2)
  // 跨层级：拒绝并提示
  await page.keyboard.down('Shift')
  await clickEl(page, '#title')
  await page.keyboard.up('Shift')
  await sleep(150)
  expect((await state(ctx.app)).selection!.multi!.length).toBe(2)
  // 整体拖到 c3 之后
  const a = (await page.locator('#c1').boundingBox())!
  const c = (await page.locator('#c3').boundingBox())!
  await dragFrom(page, a.x + 10, a.y + 10, c.x + c.width - 6, c.y + c.height / 2)
  const ids = () => page.evaluate(() => Array.from(document.querySelectorAll('#row > .card')).map((e) => e.id))
  await expect.poll(ids).toEqual(['c3', 'c1', 'c2'])
  await ws(ctx.app, 'undo')
  await expect.poll(ids).toEqual(['c1', 'c2', 'c3'])
  // 等换位动画结束再点
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  // 多选后 Delete 批量删除，一次撤销恢复
  await clickEl(page, '#c1')
  await page.keyboard.down('Shift')
  await clickEl(page, '#c3')
  await page.keyboard.up('Shift')
  await waitFor(ctx.app, (x) => (x.selection?.multi?.length ?? 0) === 2)
  await page.keyboard.press('Delete')
  await expect.poll(ids).toEqual(['c2'])
  await ws(ctx.app, 'undo')
  await expect.poll(ids).toEqual(['c1', 'c2', 'c3'])
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig)
})

test('V6-07 Alt 拖动自由移动：写入 position: relative 与 left / top', async () => {
  const { file, page } = await setup()
  await clickEl(page, '#title')
  await waitFor(ctx.app, (x) => x.selection?.id === 'title')
  const b = (await page.locator('#title').boundingBox())!
  await dragFrom(page, b.x + 10, b.y + 10, b.x + 47, b.y + 23, ['Alt'])
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  const m = /<h1 style="position: relative; left: (-?\d+)px; top: (-?\d+)px" id="title">/.exec(read(file))
  expect(m).toBeTruthy()
  expect(Math.abs(Number(m![1]) - 37)).toBeLessThanOrEqual(8)
})

test('V6-08 SVG：单击选中整个 svg，双击进入内部选中形状，Esc 退出', async () => {
  const { page } = await setup()
  const r = (await page.locator('#bar').boundingBox())!
  await page.mouse.click(r.x + 5, r.y + 5)
  await waitFor(ctx.app, (x) => x.selection?.id === 'chart')
  await page.mouse.dblclick(r.x + 5, r.y + 5)
  await waitFor(ctx.app, (x) => x.selection?.id === 'bar')
  const s = await state(ctx.app)
  expect(s.selection!.svg).toBe('child')
  expect(s.selection!.attrs.fill).toBe('#3D7BFD')
  expect(s.svgSource?.html.startsWith('<svg id="chart"')).toBe(true)
  // 隔离中单击别的形状直接选中
  const d = (await page.locator('#dot').boundingBox())!
  await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2)
  await waitFor(ctx.app, (x) => x.selection?.id === 'dot')
  await page.keyboard.press('Escape')
  await waitFor(ctx.app, (x) => x.selection?.id === 'chart')
  await page.keyboard.press('Escape')
  await waitFor(ctx.app, (x) => x.selection?.id === 'chart')
  // v0.8：svg 仍是选中的，再点一次就进入内部（与双击相同）
  await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2)
  await waitFor(ctx.app, (x) => x.selection?.id === 'dot')
  // 退出后点别处再点 svg：只选中整个 svg
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await waitFor(ctx.app, (x) => x.selection === null)
  await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2)
  await waitFor(ctx.app, (x) => x.selection?.id === 'chart')
})

test('V6-09 SVG 文字：隔离后双击 text 弹出输入框，回车写回源码；属性面板改 fill', async () => {
  const { file, orig, page } = await setup()
  const r = (await page.locator('#bar').boundingBox())!
  await page.mouse.dblclick(r.x + 5, r.y + 5)
  await waitFor(ctx.app, (x) => x.selection?.id === 'bar')
  await ws(ctx.app, 'applyOp', { type: 'setAttr', eid: (await state(ctx.app)).selection!.eid, name: 'fill', value: '#00AA55' })
  await expect.poll(() => page.locator('#bar').getAttribute('fill')).toBe('#00AA55')
  const t = (await page.locator('#label').boundingBox())!
  await page.mouse.dblclick(t.x + t.width / 2, t.y + t.height / 2)
  await sleep(150)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('收入')
  await expect.poll(() => page.locator('#label').textContent()).toBe('收入')
  await page.keyboard.press('Enter')
  await waitFor(ctx.app, (x) => x.selection?.id === 'label')
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('>销量</text>', '>收入</text>').replace('fill="#3D7BFD"', 'fill="#00AA55"'))
  // Esc 取消不写入
  await page.mouse.dblclick(t.x + t.width / 2, t.y + t.height / 2)
  await sleep(150)
  await page.keyboard.type('乱')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.locator('#label').textContent()).toBe('收入')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
})

test('V6-10 SVG 源码面板：输入实时预览，提交写回一次补丁，坏源码拒绝并恢复', async () => {
  const { file, orig, page } = await setup()
  const r = (await page.locator('#bar').boundingBox())!
  await page.mouse.click(r.x + 5, r.y + 5)
  const s = await waitFor(ctx.app, (x) => x.selection?.id === 'chart' && !!x.svgSource)
  const src = s.svgSource!
  const next = src.html.replace('r="20"', 'r="30"')
  await ws(ctx.app, 'command', { type: 'sourcePreview', eid: src.eid, html: next })
  await expect.poll(() => page.locator('#dot').getAttribute('r')).toBe('30')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  await ws(ctx.app, 'command', { type: 'sourceApply', eid: src.eid, html: next })
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await expect.poll(() => page.locator('[data-source-preview]').count()).toBe(0)
  await expect.poll(() => page.locator('#dot').getAttribute('r')).toBe('30')
  await ws(ctx.app, 'save')
  expect(read(file)).toBe(orig.replace('r="20"', 'r="30"'))
  // 坏源码：外层多出元素
  const cur = (await state(ctx.app)).svgSource!
  await ws(ctx.app, 'command', { type: 'sourcePreview', eid: cur.eid, html: cur.html + '<p>x</p>' })
  await ws(ctx.app, 'command', { type: 'sourceApply', eid: cur.eid, html: cur.html + '<p>x</p>' })
  await sleep(300)
  expect(read(file)).toBe(orig.replace('r="20"', 'r="30"'))
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  await expect.poll(() => page.locator('#dot').getAttribute('r')).toBe('30')
})
