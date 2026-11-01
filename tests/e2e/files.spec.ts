// A. 打开、标签页与窗口；D. 撤销、重做、保存；E. 外部变更；F. 安全
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { clickAt, dialogTitles, editing, launch, preview, quit, read, shell, sleep, state, stubDialogs, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx | null = null
test.afterEach(async () => {
  if (!ctx) return
  await quit(ctx)
  ctx = null
})

const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')

async function typeInto(c: Ctx, selector: string, text: string): Promise<void> {
  const page = await preview(c.app)
  await clickAt(page, selector, { end: true })
  await editing(c.app, true)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await editing(c.app, false)
}

test('AC-01 / AC-02 打开：菜单、命令行、最近文件、系统「打开方式」，重复打开切换到已有标签', async () => {
  const dir = workdir('basic.html', 'emoji.html', 'entities.html')
  ctx = await launch([path.join(dir, 'basic.html')]) // 命令行参数
  let s = await state(ctx.app)
  expect(s.tabs.map((t) => t.name)).toEqual(['basic.html'])
  const sh = await shell(ctx.app)
  await expect(sh.locator('.statusbar .left')).toContainText(path.join(dir, 'basic.html').slice(-30))
  await stubDialogs(ctx.app, { openPaths: [path.join(dir, 'emoji.html')] })
  await ws(ctx.app, 'openDialog') // 菜单「打开」
  s = await waitFor(ctx.app, (x) => x.tabs.length === 2)
  await ctx.app.evaluate(({ app }, p) => app.emit('open-file', { preventDefault() {} }, p), path.join(dir, 'entities.html')) // 系统「打开方式」
  s = await waitFor(ctx.app, (x) => x.tabs.length === 3)
  expect(s.recent.map((r) => r.name)).toEqual(['entities.html', 'emoji.html', 'basic.html'])
  await ws(ctx.app, 'openRecent', path.join(dir, 'basic.html')) // 最近文件；已打开则切换
  s = await state(ctx.app)
  expect(s.tabs).toHaveLength(3)
  expect(s.tabs.find((t) => t.id === s.activeId)!.name).toBe('basic.html')
  // 拖入（与外壳 drop 走同一条指令）：非 HTML 不打开
  await ws(ctx.app, 'command', { type: 'openPaths', paths: [path.join(dir, 'x.png')] })
  expect((await state(ctx.app)).tabs).toHaveLength(3)
})

test('AC-03 多标签：独立状态、Ctrl+Tab、Cmd/Ctrl+数字、重排、关闭', async () => {
  const dir = workdir('basic.html', 'emoji.html', 'entities.html')
  ctx = await launch(['basic.html', 'emoji.html', 'entities.html'].map((f) => path.join(dir, f)))
  let s = await state(ctx.app)
  expect(s.tabs.map((t) => t.name)).toEqual(['basic.html', 'emoji.html', 'entities.html'])
  await ws(ctx.app, 'gotoTab', 1)
  await typeInto(ctx, 'h1', '改')
  await ws(ctx.app, 'cycleTab', 1)
  s = await state(ctx.app)
  expect(s.tabs.find((t) => t.id === s.activeId)!.name).toBe('emoji.html')
  expect(s.tabs[0].dirty).toBe(true)
  expect(s.tabs[1].dirty).toBe(false)
  await ws(ctx.app, 'gotoTab', 9)
  s = await state(ctx.app)
  expect(s.tabs.find((t) => t.id === s.activeId)!.name).toBe('entities.html')
  await ws(ctx.app, 'reorder', 2, 0)
  s = await state(ctx.app)
  expect(s.tabs.map((t) => t.name)).toEqual(['entities.html', 'basic.html', 'emoji.html'])
  // 外壳：中键关闭
  const sh = await shell(ctx.app)
  await sh.locator('.tab', { hasText: 'emoji.html' }).click({ button: 'middle' })
  s = await waitFor(ctx.app, (x) => x.tabs.length === 2)
  // 切回第一个标签：未保存修改仍在
  await ws(ctx.app, 'gotoTab', 2)
  expect(await (await preview(ctx.app)).locator('h1').textContent()).toBe('基础标题改')
})

test('AC-04 外部资源加载失败：状态栏提示，页面不崩溃', async () => {
  const dir = workdir('tailwind-cdn.html')
  ctx = await launch([path.join(dir, 'tailwind-cdn.html')])
  await preview(ctx.app)
  await waitFor(ctx.app, (s) => s.extFail, 15000)
  const sh = await shell(ctx.app)
  await expect(sh.locator('.statusbar')).toContainText('部分外部资源加载失败')
})

test('AC-05 相对资源、上级目录授权、越界始终 404', async () => {
  const dir = workdir('relative-assets', 'parent-assets', 'escape-dir', 'escape-secret.css')
  ctx = await launch([path.join(dir, 'relative-assets/index.html')])
  let page = await preview(ctx.app)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).toBe('rgb(20, 185, 138)')
  expect(await page.evaluate(() => (document.querySelector('img') as HTMLImageElement).naturalWidth > 0)).toBe(true)
  // 上级目录：先不加载，出现提示条；授权后加载；再次打开沿用授权
  const pagePath = path.join(dir, 'parent-assets/pages/index.html')
  await ws(ctx.app, 'openPath', pagePath)
  page = await preview(ctx.app)
  await waitFor(ctx.app, (s) => !!s.banner)
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).not.toBe('rgb(20, 185, 138)')
  const sh = await shell(ctx.app)
  await expect(sh.locator('.banner')).toContainText('所在目录之外')
  await stubDialogs(ctx.app, { dir: path.join(dir, 'parent-assets') })
  await sh.locator('.banner button.primary').click()
  await waitFor(ctx.app, (s) => !s.banner)
  page = await preview(ctx.app)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).toBe('rgb(20, 185, 138)')
  const id = (await state(ctx.app)).activeId!
  await ws(ctx.app, 'closeTab', id)
  await ws(ctx.app, 'openPath', pagePath)
  page = await preview(ctx.app)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).toBe('rgb(20, 185, 138)')
  // 越界：目录内有同名文件也不能顶替
  await ws(ctx.app, 'openPath', path.join(dir, 'escape-dir/index.html'))
  page = await preview(ctx.app)
  await expect.poll(() => page.title()).toBe('fetch:404')
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).not.toBe('rgb(255, 0, 0)')
})

test('AC-06 只读文件：GBK 与换行混杂', async () => {
  const dir = workdir('gbk.html', 'mixed-eol.html')
  ctx = await launch([path.join(dir, 'gbk.html'), path.join(dir, 'mixed-eol.html')])
  const s = await state(ctx.app)
  expect(s.tabs.map((t) => [t.readOnly, t.readOnlyKind])).toEqual([
    ['READONLY_FILE', 'encoding'],
    ['READONLY_FILE', 'eol']
  ])
  const page = await preview(ctx.app)
  await clickAt(page, 'p', { end: true })
  await sleep(300)
  expect((await state(ctx.app)).editing).toBe(false)
  const sh = await shell(ctx.app)
  await expect(sh.locator('.statusbar .right')).toHaveText('只读')
  await expect(sh.locator('.statusbar .center')).toContainText('只读：换行风格混杂')
})

test('AC-07 窗口记忆：大小、位置、缩放、视口宽度', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const settingsFile = ctx.settings
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 60, y: 60, width: 1100, height: 700 }))
  await ws(ctx.app, 'zoom', 1)
  await ws(ctx.app, 'zoom', 1)
  await ws(ctx.app, 'setViewport', '768')
  await sleep(500)
  await ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx.app.close()
  ctx = await launch([], { settings: settingsFile })
  const s = await state(ctx.app)
  expect(s.zoom).toBe(125)
  expect(s.viewport).toBe('768')
  expect(s.tabs).toHaveLength(0) // 标签不恢复
  const b = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  expect([b.width, b.height]).toEqual([1100, 700])
})

test('AC-29 往返一致（经由预览提交）；AC-30 保存点', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  const h0 = sha(file)
  ctx = await launch([file])
  await preview(ctx.app)
  // 用主进程的提交入口驱动 50 次编辑（与预览 edit:commit 同一路径）
  await ctx.app.evaluate(() => {
    const w = (globalThis as unknown as { __hw: { ws: { active: { doc: { elements: { eid: number; isHost: boolean; slots: { text: string }[] }[] } }; commit(t: unknown, ops: unknown[]): unknown } } }).__hw.ws
    const t = w.active
    const hosts = t.doc.elements.filter((e) => e.isHost)
    for (let i = 0; i < 50; i++) {
      const h = hosts[i % hosts.length]
      const cur = t.doc.elements[h.eid].slots[0].text
      w.commit(t, [{ eid: h.eid, slot: 0, newText: cur + i }])
      ;(t.doc as unknown as { undo: { at: number }[] }).undo.at(-1)!.at -= 10_000 * (50 - i) // 避免 600ms 合并
    }
  })
  await ws(ctx.app, 'save')
  const h50 = sha(file)
  for (let i = 0; i < 50; i++) await ws(ctx.app, 'undo')
  await ws(ctx.app, 'save')
  expect(sha(file)).toBe(h0)
  for (let i = 0; i < 50; i++) await ws(ctx.app, 'redo')
  await ws(ctx.app, 'save')
  expect(sha(file)).toBe(h50)
  // 预览与源码同步
  const page = await preview(ctx.app)
  expect(await page.locator('h1').textContent()).toMatch(/^基础标题(\d+)+$/)
  // 保存点
  await typeInto(ctx, 'h1', '后')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(true)
  await ws(ctx.app, 'undo')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  await ws(ctx.app, 'redo')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(true)
})

test('AC-31 换行与 BOM 不变', async () => {
  const dir = workdir('crlf.html', 'bom.html')
  for (const f of ['crlf.html', 'bom.html']) {
    const file = path.join(dir, f)
    const orig = fs.readFileSync(file)
    ctx = await launch([file])
    await typeInto(ctx, '#p', '改')
    await ws(ctx.app, 'save')
    const saved = fs.readFileSync(file)
    const expected = Buffer.from(orig.toString('utf8').replace(/(<p id="p">[^<]*)/, '$1改'), 'utf8')
    expect(saved.equals(expected)).toBe(true)
    await ctx.app.evaluate(() => {
      ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
    })
    await ctx.app.close()
    ctx = null
  }
})

test('AC-32 退出确认：保存 / 不保存 / 取消', async () => {
  const dir = workdir('basic.html', 'emoji.html')
  ctx = await launch([path.join(dir, 'basic.html'), path.join(dir, 'emoji.html')])
  await ws(ctx.app, 'gotoTab', 1)
  await typeInto(ctx, 'h1', '甲')
  // 取消：标签保留
  await stubDialogs(ctx.app, { responses: [2] })
  const id = (await state(ctx.app)).activeId!
  expect(await ws(ctx.app, 'closeTab', id)).toBe(false)
  expect((await dialogTitles(ctx.app))[0]).toBe('要保存对 basic.html 的修改吗？')
  // 保存：写入后关闭
  await stubDialogs(ctx.app, { responses: [0] })
  expect(await ws(ctx.app, 'closeTab', id)).toBe(true)
  expect(read(path.join(dir, 'basic.html'))).toContain('<h1>基础标题甲</h1>')
  // 不保存：关闭窗口时不写入
  await typeInto(ctx, 'p', '乙')
  await stubDialogs(ctx.app, { responses: [1] })
  expect(await ws(ctx.app, 'confirmAll')).toBe(true)
  expect(read(path.join(dir, 'emoji.html'))).not.toContain('乙')
})

test('AC-33 保存失败：只读文件弹「无法保存」，修改不丢；另存为可用', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  await typeInto(ctx, 'h1', '丙')
  fs.chmodSync(file, 0o444)
  const target = path.join(dir, 'copy.html')
  await stubDialogs(ctx.app, { responses: [1], savePath: target }) // 第一个对话框选「另存为…」
  await ws(ctx.app, 'save')
  expect((await dialogTitles(ctx.app))[0]).toBe('无法保存')
  expect(read(file)).not.toContain('丙')
  expect(read(target)).toContain('<h1>基础标题丙</h1>')
  // 取消时保持未保存
  fs.chmodSync(file, 0o644)
  await ws(ctx.app, 'openPath', file)
  await typeInto(ctx, 'h1', '丁')
  fs.chmodSync(file, 0o444)
  await stubDialogs(ctx.app, { responses: [2] })
  expect(await ws(ctx.app, 'save')).toBe(false)
  const s = await state(ctx.app)
  expect(s.tabs.find((t) => t.id === s.activeId)!.dirty).toBe(true)
  fs.chmodSync(file, 0o644)
})

test('AC-35 静默重载；AC-37 不误报', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await page.evaluate(() => window.scrollTo(0, 0))
  await typeInto(ctx, 'h1', '戊')
  await ws(ctx.app, 'save')
  await sleep(1200)
  expect(await dialogTitles(ctx.app)).toEqual([])
  fs.writeFileSync(file, read(file).replace('第一段正文。', '外部修改的第一段。'))
  await expect.poll(async () => (await preview(ctx!.app)).locator('p').first().textContent(), { timeout: 8000 }).toBe('外部修改的第一段。')
  const s = await state(ctx.app)
  expect(s.tabs[0].dirty).toBe(false)
  expect(s.tabs[0].canUndo).toBe(false)
})

test('AC-36 冲突：三个选项；AC-38 后台标签切回时才处理', async () => {
  const dir = workdir('basic.html', 'emoji.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file, path.join(dir, 'emoji.html')])
  await ws(ctx.app, 'gotoTab', 1)
  await typeInto(ctx, 'h1', '己')
  // 保留我的修改
  await stubDialogs(ctx.app, { responses: [2] })
  fs.writeFileSync(file, read(file).replace('第二段', '外部第二段'))
  await expect.poll(() => dialogTitles(ctx!.app), { timeout: 8000 }).toEqual(['文件已被其他程序修改'])
  await ws(ctx.app, 'save')
  expect(read(file)).toContain('<h1>基础标题己</h1>')
  expect(read(file)).not.toContain('外部第二段') // 下次保存覆盖磁盘
  // 载入磁盘版本
  await typeInto(ctx, 'h1', '庚')
  await stubDialogs(ctx.app, { responses: [1] })
  fs.writeFileSync(file, read(file).replace('第一段正文', '磁盘第一段'))
  await expect.poll(async () => (await preview(ctx!.app)).locator('p').first().textContent(), { timeout: 8000 }).toBe('磁盘第一段。')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  // 后台标签：不弹对话框，切回时才处理
  await typeInto(ctx, 'h1', '辛')
  await ws(ctx.app, 'gotoTab', 2)
  await stubDialogs(ctx.app, { responses: [0], savePath: path.join(dir, 'mine.html') })
  fs.writeFileSync(file, read(file).replace('列表一', '后台修改'))
  await sleep(1500)
  expect(await dialogTitles(ctx.app)).toEqual([])
  await ws(ctx.app, 'gotoTab', 1)
  await expect.poll(() => dialogTitles(ctx!.app), { timeout: 8000 }).toEqual(['文件已被其他程序修改'])
  // 默认焦点「另存为…」：当前内容存到新路径，原路径不变
  await expect.poll(() => fs.existsSync(path.join(dir, 'mine.html'))).toBe(true)
  expect(read(path.join(dir, 'mine.html'))).toContain('<h1>基础标题己辛</h1>') // 己 已保存，庚 被「载入磁盘版本」丢弃
  expect(read(file)).toContain('后台修改')
})

test('AC-39 安全隔离', async () => {
  const dir = workdir('security.html')
  ctx = await launch([path.join(dir, 'security.html')])
  const page = await preview(ctx.app)
  await expect.poll(() => page.locator('#out').textContent(), { timeout: 10000 }).not.toBe('检测中')
  const r = JSON.parse((await page.locator('#out').textContent())!)
  expect(r).toEqual({ require: 'undefined', process: 'undefined', open: 'blocked', file: 'failed', camera: 'denied' })
  // 下载被取消
  const cancelled = await ctx.app.evaluate(async () => {
    const w = (globalThis as unknown as { __hw: { ws: { active: { session: Electron.Session; view: { webContents: Electron.WebContents } } } } }).__hw.ws
    return new Promise<boolean>((resolve) => {
      w.active.session.once('will-download', (e) => resolve(e.defaultPrevented))
      w.active.view.webContents.downloadURL('data:text/plain,hello')
      setTimeout(() => resolve(false), 3000)
    })
  })
  expect(cancelled).toBe(true)
})
