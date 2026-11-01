// v0.3–v0.5：媒体插入、元素剪贴板、导出、三方合并、组件规范（规格 20.3–20.5）。
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launch, preview, quit, read, sleep, stubDialogs, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await quit(ctx)
})

async function selectId(id: string) {
  const page = await preview(ctx.app)
  await ws(ctx.app, 'setMode', 'select')
  await sleep(200)
  const b = (await page.locator(`#${id}`).boundingBox())!
  await page.mouse.click(b.x + 3, b.y + 3)
  return waitFor(ctx.app, (x) => x.selection?.id === id)
}

test('V3-05 插入图片：复制到 assets 并在选中元素后插入相对路径 img；重名加序号', async () => {
  const dir = workdir('blocks.html')
  const file = path.join(dir, 'blocks.html')
  const img = path.join(dir, 'pic.png')
  fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'))
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'pic.png'), 'x')
  ctx = await launch([file])
  await selectId('p2')
  await stubDialogs(ctx.app, { openPaths: [img] })
  await ws(ctx.app, 'command', { type: 'insertMedia', kind: 'image' })
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  expect(read(file)).toContain('<p id="p2">第二段</p>\n<img src="assets/pic-2.png" alt="pic">\n')
  expect(fs.existsSync(path.join(dir, 'assets', 'pic-2.png'))).toBe(true)
})

test('V3-06 拷贝元素后粘贴到另一个标签', async () => {
  const dir = workdir('blocks.html', 'basic.html')
  const a = path.join(dir, 'blocks.html')
  const b = path.join(dir, 'basic.html')
  ctx = await launch([a])
  await selectId('list')
  await ws(ctx.app, 'command', { type: 'copyElement' })
  await waitFor(ctx.app, (x) => x.clip)
  await ws(ctx.app, 'openPath', b)
  await waitFor(ctx.app, (x) => x.tabs.length === 2)
  await preview(ctx.app)
  await ws(ctx.app, 'command', { type: 'pasteElement' })
  await waitFor(ctx.app, (x) => x.tabs[1].dirty)
  await ws(ctx.app, 'save')
  expect(read(b)).toContain('<ul id="list">\n  <li>一</li>\n  <li>二</li>\n  <li>三</li>\n</ul>')
})

test('V5-01 导出 Markdown 与 PDF', async () => {
  const dir = workdir('blocks.html')
  ctx = await launch([path.join(dir, 'blocks.html')])
  await preview(ctx.app)
  const md = path.join(dir, 'out.md')
  await stubDialogs(ctx.app, { savePath: md })
  await ws(ctx.app, 'command', { type: 'exportText', format: 'md' })
  expect(read(md)).toBe('# 标题\n\n第一段 **粗** 文字\n\n第二段\n\n- 一\n- 二\n- 三\n\n卡一\n\n卡二\n')
  const pdf = path.join(dir, 'out.pdf')
  await stubDialogs(ctx.app, { savePath: pdf })
  await ws(ctx.app, 'command', { type: 'exportPdf' })
  expect(fs.readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-')
})

test('V5-02 外部修改与未保存修改不冲突：自动合并', async () => {
  const dir = workdir('blocks.html')
  const file = path.join(dir, 'blocks.html')
  const orig = read(file)
  ctx = await launch([file])
  await selectId('title')
  const s = await waitFor(ctx.app, (x) => x.selection?.id === 'title')
  await ws(ctx.app, 'applyOp', { type: 'setStyle', eid: s.selection!.eid, props: { color: 'red' } })
  await stubDialogs(ctx.app, { responses: [3] }) // 合并…
  fs.writeFileSync(file, orig.replace('第二段', '第二段（外部）'))
  await expect.poll(async () => (await preview(ctx!.app)).locator('#p2').textContent(), { timeout: 8000 }).toBe('第二段（外部）')
  await ws(ctx.app, 'save')
  const out = read(file)
  expect(out).toContain('<h1 style="color: red" id="title">')
  expect(out).toContain('第二段（外部）')
})

test('V4-01 组件规范化补 data-id，检查通过', async () => {
  const dir = workdir('blocks.html')
  const file = path.join(dir, 'blocks.html')
  fs.writeFileSync(file, read(file).replace('<div class="card" id="c1">', '<div class="card" id="c1" data-c="card">').replace('<div class="card" id="c2">', '<div class="card" id="c2" data-c="card">'))
  ctx = await launch([file])
  await preview(ctx.app)
  await ws(ctx.app, 'command', { type: 'normalizeComponents' })
  await waitFor(ctx.app, (x) => x.tabs[0].dirty)
  await ws(ctx.app, 'save')
  const out = read(file)
  expect(out).toContain('<div data-id="c-1" class="card" id="c1" data-c="card">')
  expect(out).toContain('<div data-id="c-2" class="card" id="c2" data-c="card">')
})
