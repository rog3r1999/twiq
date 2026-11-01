// B. 编辑与保存（AC-08 至 AC-23、AC-43）
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { clickAt, editing, launch, preview, quit, read, sleep, state, stubDialogs, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await quit(ctx)
})

test('AC-08 悬停：蓝框与面包屑；不可编辑的文字再点一次说明原因（v0.8 合并模式）', async () => {
  const dir = workdir('basic.html', 'pre-svg-textarea.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const page = await preview(ctx.app)
  await sleep(500) // 视图刚显示时会收到一次合成的鼠标离开事件
  const h1 = await page.locator('h1').boundingBox()
  await page.mouse.move(h1!.x + 10, h1!.y + 10)
  await sleep(100)
  await page.mouse.move(h1!.x + 14, h1!.y + 12)
  const s = await waitFor(ctx.app, (x) => !!x.hover)
  expect(s.hover).toMatchObject({ editable: true, breadcrumb: ['body', 'h1'] })
  await ws(ctx.app, 'openPath', path.join(dir, 'pre-svg-textarea.html'))
  const p2 = await preview(ctx.app)
  await sleep(500) // 视图刚显示时会收到一次合成的鼠标离开事件
  const pre = await p2.locator('#pre').boundingBox()
  await p2.mouse.move(pre!.x + 5, pre!.y + 5)
  await sleep(100)
  await p2.mouse.move(pre!.x + 9, pre!.y + 6)
  await waitFor(ctx.app, (x) => x.hover?.breadcrumb.at(-1) === 'pre#pre')
  // 悬停不再弹原因；选中后再点一次，原因同步写入外壳的读屏区域（statusNote）
  await p2.mouse.click(pre!.x + 9, pre!.y + 6)
  await sleep(60)
  await p2.mouse.click(pre!.x + 9, pre!.y + 6)
  await waitFor(ctx.app, (x) => (x.statusNote ?? '').includes('预格式化文本'), 3000)
  expect((await state(ctx.app)).editing).toBe(false)
})

test('AC-09 / AC-10 基本编辑与最小改动', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { offset: 2 }) // 「基础」之后
  await editing(ctx.app, true)
  await page.keyboard.type('X')
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await page.keyboard.press('Enter')
  let s = await waitFor(ctx.app, (x) => !x.editing)
  expect(s.tabs[0].dirty).toBe(true)
  expect(await page.locator('h1').textContent()).toBe('基础X标题')
  const title = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  expect(title.startsWith('● ')).toBe(true)
  await ws(ctx.app, 'save')
  s = await state(ctx.app)
  expect(s.tabs[0].dirty).toBe(false)
  expect(read(file)).toBe(orig.replace('<h1>基础标题</h1>', '<h1>基础X标题</h1>'))
})

test('AC-11 Esc 保留修改；AC-12 放弃本次修改', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('一')
  await page.keyboard.press('Escape')
  await editing(ctx.app, false)
  expect(await page.locator('h1').textContent()).toBe('基础标题一')
  // 放弃本次修改：通过工具条菜单（影子 DOM 内，用 preload 暴露的动作触发）
  await clickAt(page, 'p', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('二')
  const undoLen = (await state(ctx.app)).tabs[0].canUndo
  // 「更多」菜单位于 closed 影子 DOM 内：用键盘无法进入，这里按坐标点击工具条
  const tb = await toolbarRect(page)
  await page.mouse.click(tb.moreX, tb.y)
  await sleep(100)
  await page.mouse.click(tb.moreX, tb.y + 36 + 28 + 14) // 菜单第二项「放弃本次修改」
  await editing(ctx.app, false)
  expect(await page.locator('p').first().textContent()).toBe('第一段正文。')
  const s = await state(ctx.app)
  expect(s.tabs[0].canUndo).toBe(undoLen)
  expect(s.tabs[0].dirty).toBe(true) // 仍有 h1 的修改
})

/** 浮动工具条的位置：贴在编辑框上方（9.4）。用编辑中 host 的位置推算。 */
async function toolbarRect(page: import('@playwright/test').Page): Promise<{ moreX: number; y: number }> {
  return page.evaluate(() => {
    const host = document.querySelector('[contenteditable]') as HTMLElement
    const r = host.getBoundingClientRect()
    // 工具条：x = r.left，y = r.top − 24（标签）− h − 8；高度约 38，「完成」宽约 46，「⋯」宽约 30
    const top = r.top - 24 >= 6 + 38 + 8 ? r.top - 24 - 38 - 8 : r.top + 8
    return { moreX: r.left + 4 + 46 + 15, y: top + 19 }
  })
}

test('AC-13 Tab 移动：提交并进入下一个，循环，跳过隐藏的 host', async () => {
  const dir = workdir('hidden-content.html')
  ctx = await launch([path.join(dir, 'hidden-content.html')])
  const page = await preview(ctx.app)
  await clickAt(page, '#h', { end: true })
  await editing(ctx.app, true)
  const order: string[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    await sleep(150)
    order.push(await page.evaluate(() => document.querySelector('[contenteditable]')?.id ?? ''))
  }
  // summary 与最后一段可见；折叠面板与隐藏 div 里的段落被跳过；到末尾循环到第一个
  expect(order).toEqual(['s', 'last', 'h', 's'])
  await page.keyboard.press('Shift+Tab')
  await sleep(150)
  expect(await page.evaluate(() => document.querySelector('[contenteditable]')?.id)).toBe('h')
  await page.keyboard.press('Escape')
  // 预览模式展开折叠面板后切回编辑模式，可以 Tab 到其中的文字
  await ws(ctx.app, 'setMode', 'preview')
  await page.click('#s')
  await ws(ctx.app, 'setMode', 'edit')
  await clickAt(page, '#s', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.press('Tab')
  await sleep(150)
  expect(await page.evaluate(() => document.querySelector('[contenteditable]')?.id)).toBe('inner')
})

test('AC-14 点击切换：一次点击完成提交与切换', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('A')
  await clickAt(page, 'li', { end: true })
  await sleep(300)
  expect(await page.evaluate(() => document.querySelector('[contenteditable]')?.textContent)).toBe('列表一')
  expect(await page.locator('h1').textContent()).toBe('基础标题A')
  expect((await state(ctx.app)).tabs[0].canUndo).toBe(true)
})

test('AC-15 禁用项：Shift+Enter、粘贴换行、Cmd/Ctrl+B', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.press('Shift+Enter')
  await waitFor(ctx.app, (s) => s.statusNote === '暂不支持换行')
  expect(await page.locator('h1').innerHTML()).toBe('基础标题')
  await ctx.app.evaluate(({ clipboard }) => clipboard.writeText('第一行\n第二行\r\n第三行'))
  await ctx.app.evaluate(() => {
    const w = (globalThis as unknown as { __hw: { ws: { active: { view: { webContents: { paste(): void } } } } } }).__hw.ws
    w.active.view.webContents.paste()
  })
  await sleep(200)
  expect(await page.locator('h1').textContent()).toBe('基础标题第一行 第二行 第三行')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+B')
  expect(await page.locator('h1 b, h1 strong').count()).toBe(0)
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
})

test('AC-17 内联标签；AC-18 结构保护', async () => {
  const dir = workdir('inline-mixed.html')
  const file = path.join(dir, 'inline-mixed.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await clickAt(page, '#mix', { offset: 1 }) // 甲之后
  await editing(ctx.app, true)
  await page.keyboard.type('1')
  await page.keyboard.press('ArrowRight') // 进入 b
  await page.keyboard.type('2')
  await page.keyboard.press('End')
  await page.keyboard.type('3')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await ws(ctx.app, 'save')
  const saved = read(file)
  // 方向键进入 b 后光标可能落在「乙」之前或之后，两种都是正确结果；其余字节必须不变
  expect(saved).toMatch(/<p id="mix">甲1<b>(乙2|2乙)<\/b>丙3<\/p>/)
  expect(saved.replace(/<p id="mix">.*<\/p>/, '')).toBe(orig.replace(/<p id="mix">.*<\/p>/, ''))
  // 结构保护：全选后删除会跨过 b 的边界
  await clickAt(page, '#mix', { offset: 1 })
  await editing(ctx.app, true)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  expect(await page.locator('#mix b').count()).toBe(1)
  expect(await page.locator('#mix').textContent()).toMatch(/甲1(乙2|2乙)丙3/)
  expect(read(file)).toBe(saved)
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
})

test('AC-19 实体保留；AC-20 转义；AC-22 emoji', async () => {
  const dir = workdir('entities.html', 'emoji.html')
  const file = path.join(dir, 'entities.html')
  ctx = await launch([file])
  let page = await preview(ctx.app)
  // 把 B 改为 C
  await clickAt(page, 'p', { offset: 5 })
  await editing(ctx.app, true)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('C')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  // 第二段末尾输入需要转义的文字
  await clickAt(page, 'p:nth-of-type(2)', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('<script>alert(1)</script> & 1<2')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await ws(ctx.app, 'save')
  const saved = read(file)
  expect(saved).toContain('<p>A &amp; C &copy; 2026</p>')
  expect(saved).toContain('<p>中&#x6587;与&#25991;字&lt;script&gt;alert(1)&lt;/script&gt; &amp; 1&lt;2</p>')
  expect(saved).toContain('<p>a&nbsp;b</p>')
  // emoji 前后
  await ws(ctx.app, 'openPath', path.join(dir, 'emoji.html'))
  page = await preview(ctx.app)
  await clickAt(page, 'p', { offset: 3 }) // 「前面的」之后
  await editing(ctx.app, true)
  await page.keyboard.type('甲')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('乙')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await ws(ctx.app, 'save')
  expect(read(path.join(dir, 'emoji.html'))).toContain('<p>前面的甲字😀乙后面的字</p>')
})

test('AC-21 缩进保留', async () => {
  const dir = workdir('multiline.html')
  const file = path.join(dir, 'multiline.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await clickAt(page, 'p', { offset: 20 })
  await editing(ctx.app, true)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('改了')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await ws(ctx.app, 'save')
  const saved = read(file)
  const a = orig.split('\n')
  const b = saved.split('\n')
  expect(b.length).toBe(a.length)
  const changed = a.filter((l, i) => l !== b[i])
  expect(changed).toHaveLength(1)
  expect(b[a.indexOf(changed[0])]).toMatch(/^ {12}\S/) // 缩进不变
})

test('AC-23 编辑中保存：先提交再保存，退出编辑', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('存')
  await ws(ctx.app, 'save')
  const s = await state(ctx.app)
  expect(s.editing).toBe(false)
  expect(s.tabs[0].dirty).toBe(false)
  expect(read(file)).toContain('<h1>基础标题存</h1>')
})

test('AC-24 编辑中撤销：先按字词撤销，回到进入时的内容后撤销上一步已提交的编辑', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('一')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('二')
  await ws(ctx.app, 'undo')
  expect(await page.locator('h1').textContent()).toBe('基础标题一')
  expect((await state(ctx.app)).editing).toBe(true)
  await ws(ctx.app, 'undo')
  await editing(ctx.app, false)
  expect(await page.locator('h1').textContent()).toBe('基础标题')
})

test('AC-43 内联控件：button、label、del/ins 可编辑，按钮不触发，复选框不切换', async () => {
  const dir = workdir('inline-controls.html')
  const file = path.join(dir, 'inline-controls.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await clickAt(page, '#btn button', { offset: 1 })
  await editing(ctx.app, true)
  await page.keyboard.type('里')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  expect(await page.title()).toBe('内联控件')
  await clickAt(page, '#lbl', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('并同意')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  expect(await page.locator('#cb').isChecked()).toBe(false)
  await clickAt(page, '#price del', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('8')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  await ws(ctx.app, 'save')
  const saved = read(file)
  expect(saved).toBe(
    orig
      .replace('<button onclick="document.title=\'clicked\'">这里</button>', '<button onclick="document.title=\'clicked\'">这里里</button>')
      .replace('我已阅读</label>', '我已阅读并同意</label>')
      .replace('<del>¥99</del>', '<del>¥98</del>')
  )
  expect(fs.existsSync(file)).toBe(true)
})

test('AC-34 另存为：新建空白文档保存走另存为，标签改名', async () => {
  const dir = workdir()
  ctx = await launch([])
  await ws(ctx.app, 'newDoc')
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type('新')
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
  const target = path.join(dir, 'new.html')
  await stubDialogs(ctx.app, { savePath: target })
  await ws(ctx.app, 'save')
  const s = await waitFor(ctx.app, (x) => x.tabs[0]?.name === 'new.html')
  expect(s.tabs[0].path).toBe(target)
  expect(s.tabs[0].dirty).toBe(false)
  expect(read(target)).toContain('<h1>标题新</h1>')
  // 示例文档：保存同样走另存为
  await ws(ctx.app, 'loadSample')
  await preview(ctx.app)
  const t2 = path.join(dir, 'sub', 'sample.html')
  fs.mkdirSync(path.dirname(t2))
  await stubDialogs(ctx.app, { savePath: t2 })
  await ws(ctx.app, 'save')
  await waitFor(ctx.app, (x) => x.tabs.some((t) => t.path === t2))
  expect(read(t2)).toContain('欢迎使用 Twiq')
})

test('AC-16 输入法（模拟）：组合期间点击别处，结束组合后提交，不含 U+00A0', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { end: true })
  await editing(ctx.app, true)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'ni hao', selectionStart: 6, selectionEnd: 6 })
  await sleep(100)
  // 组合期间 Esc 只取消候选，不退出编辑
  await page.keyboard.press('Escape')
  expect((await state(ctx.app)).editing).toBe(true)
  await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
  await clickAt(page, 'li', { end: true })
  await waitFor(ctx.app, (s) => s.editing && s.tabs[0].canUndo, 5000)
  await page.keyboard.press('Escape')
  await editing(ctx.app, false)
  await ws(ctx.app, 'save')
  const saved = read(file)
  expect(saved).toContain("<h1>基础标题你好</h1>") // 失焦时 Chromium 把组合中的文字上屏
  expect(saved).not.toMatch(/ni ?hao/)
  expect(saved).not.toContain(' ')
})
