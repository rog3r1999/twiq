// v0.10 改动面板：看得见这次改了什么，点一条定位，撤回其中一处，保存提示说清其余字符原样保留。
import { expect, test } from '@playwright/test'
import path from 'node:path'
import type { ChangesView } from '../../src/shared/types'
import { clickAt, editing, launch, preview, read, shell, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await ctx?.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx?.app.close()
})

/** 在某个文字块末尾输入一段字并提交 */
async function typeAt(page: Awaited<ReturnType<typeof preview>>, selector: string, text: string): Promise<void> {
  await clickAt(page, selector, { end: true })
  await editing(ctx.app, true)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await editing(ctx.app, false)
}

test('CH-E1 改了两处：状态栏显示处数，点开是改动列表，统计与磁盘上的差异一致；保存提示带统计', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await expect(sh.locator('.changes-btn')).toHaveCount(0)

  await typeAt(page, 'h1', '甲')
  await typeAt(page, 'li', '乙')
  await waitFor(ctx.app, (s) => s.changeCount === 2)
  await sh.locator('.changes-btn').click()
  await expect(sh.locator('.changes-btn')).toHaveText('2 处改动')
  await expect(sh.getByRole('tab', { name: /改动/ })).toHaveAttribute('aria-selected', 'true')
  const items = sh.locator('.ch-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0).locator('ins')).toHaveText('甲')
  await expect(items.nth(0).locator('code')).toHaveText('h1')
  await expect(items.nth(1).locator('ins')).toHaveText('乙')
  await expect(items.nth(1).locator('code')).toHaveText('li')
  // 统计：原文字符数里，除了插入点之外全部原样保留
  await expect(sh.locator('.ch-summary')).toContainText(`${orig.length.toLocaleString('zh-CN')} 个字符里，${orig.length.toLocaleString('zh-CN')} 个原样保留`)
  await expect(sh.locator('.ch-summary')).toContainText('增 2 字')

  await ws(ctx.app, 'save')
  await waitFor(ctx.app, (s) => !s.tabs[0].dirty && s.changeCount === 0)
  expect(read(file)).toBe(orig.replace('基础标题', '基础标题甲').replace('列表一', '列表一乙'))
  // 保存提示（读屏区域里有完整文字）
  await expect(sh.locator('.sr-only[aria-live="polite"]').first()).toContainText(`basic.html · 改了 2 处，其余 ${orig.length.toLocaleString('zh-CN')} 个字符原样保留`)
  await expect(sh.locator('.ch-none')).toHaveText('还没有改动')
})

test('CH-E2 撤回其中一处：只退回这一处，其余保留；能再撤销；点一条在页面上选中它，停在改动页', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  const orig = read(file)
  ctx = await launch([file])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await typeAt(page, 'h1', '甲')
  await typeAt(page, 'li', '乙')
  await waitFor(ctx.app, (s) => s.changeCount === 2)
  await sh.getByRole('tab', { name: /改动/ }).click()
  const items = sh.locator('.ch-item')
  await expect(items).toHaveCount(2)

  // 点第二条：页面上选中 li，面板仍停在改动页
  await items.nth(1).locator('.ch-goto').click()
  await waitFor(ctx.app, (s) => s.selection?.tag === 'li')
  await sleep(200)
  await expect(sh.getByRole('tab', { name: /改动/ })).toHaveAttribute('aria-selected', 'true')

  // 撤回第一条（h1 上的「甲」）
  await items.nth(0).hover()
  await items.nth(0).locator('.ch-revert').click()
  await waitFor(ctx.app, (s) => s.changeCount === 1)
  await expect(items).toHaveCount(1)
  await expect(items.nth(0).locator('ins')).toHaveText('乙')
  expect(await page.evaluate(() => document.querySelector('h1')?.textContent)).toBe('基础标题')
  await ws(ctx.app, 'save')
  await waitFor(ctx.app, (s) => !s.tabs[0].dirty)
  expect(read(file)).toBe(orig.replace('列表一', '列表一乙'))

  // 撤回是一步普通的撤销
  await ws(ctx.app, 'undo')
  await waitFor(ctx.app, (s) => s.changeCount === 1 && s.tabs[0].dirty)
  expect(await page.evaluate(() => document.querySelector('h1')?.textContent)).toBe('基础标题甲')

  // 在页面上点别的元素：回到属性页
  const p = (await page.locator('p').first().boundingBox())!
  await page.mouse.click(p.x + 5, p.y + p.height / 2)
  await waitFor(ctx.app, (s) => s.selection?.tag === 'p')
  await expect(sh.getByRole('tab', { name: /属性|^p$/ }).first()).toHaveAttribute('aria-selected', 'true')
})

test('CH-E3 结构操作也列出来：复制一份是一处「加」，整块移动是一处「移动」', async () => {
  const dir = workdir('blocks.html')
  const file = path.join(dir, 'blocks.html')
  ctx = await launch([file])
  await preview(ctx.app)
  const s0 = await state(ctx.app)
  expect(s0.changeCount).toBe(0)
  // 两张卡片 #c1 #c2
  const eids = await ctx.app.evaluate(() => {
    const t = (globalThis as unknown as { __hw: { ws: { active: { doc: { elements: { eid: number; attrs: Record<string, { value: string }> }[] } } } } }).__hw.ws.active
    return ['c1', 'c2'].map((id) => t.doc.elements.find((e) => e.attrs.id?.value === id)!.eid)
  })
  await ws(ctx.app, 'applyOp', { type: 'duplicate', eid: eids[0] })
  await waitFor(ctx.app, (s) => s.changeCount === 1)
  const view = () => ws<ChangesView | null>(ctx.app, 'currentChanges')
  await expect.poll(async () => (await view())?.items.map((i) => i.kind)).toEqual(['insert'])
  await ws(ctx.app, 'undo')
  await waitFor(ctx.app, (s) => s.changeCount === 0)
  await ws(ctx.app, 'applyOp', { type: 'move', eid: eids[eids.length - 1], target: eids[0], where: 'before' })
  await expect.poll(async () => (await view())?.items.map((i) => i.kind)).toEqual(['move'])
  expect((await view())!.summary.moved).toBeGreaterThan(0)
})

test('CH-E4 面板关着、页面上选中了元素：点状态栏「N 处改动」打开的是改动页（审查发现）', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const page = await preview(ctx.app)
  const sh = await shell(ctx.app)
  await typeAt(page, 'h1', '甲')
  await waitFor(ctx.app, (s) => s.changeCount === 1 && s.selection?.tag === 'h1')
  await ws(ctx.app, 'togglePanel', false)
  await waitFor(ctx.app, (s) => !s.panelOpen)
  await sh.locator('.changes-btn').click()
  await waitFor(ctx.app, (s) => s.panelOpen)
  await sleep(300)
  await expect(sh.getByRole('tab', { name: /改动/ })).toHaveAttribute('aria-selected', 'true')
  await expect(sh.locator('.ch-item')).toHaveCount(1)
})

test('CH-E5 连点两下「撤回」：只撤回点的那一处，不会顺带撤掉下一处（审查发现）', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  const page = await preview(ctx.app)
  await typeAt(page, 'h1', '甲')
  await typeAt(page, 'li', '乙')
  await waitFor(ctx.app, (s) => s.changeCount === 2)
  await ws(ctx.app, 'command', { type: 'changesView', open: true })
  const v = await ws<ChangesView>(ctx.app, 'currentChanges')
  // 两条命令带着同一版列表的下标 0：第二条到达时列表已经变了，应当什么也不做
  await Promise.all([
    ws(ctx.app, 'command', { type: 'revertChange', index: 0, version: v.version }),
    ws(ctx.app, 'command', { type: 'revertChange', index: 0, version: v.version })
  ])
  await waitFor(ctx.app, (s) => s.changeCount === 1)
  await sleep(300)
  expect((await state(ctx.app)).changeCount).toBe(1)
  expect(await page.evaluate(() => [document.querySelector('h1')?.textContent, document.querySelector('li')?.textContent])).toEqual(['基础标题', '列表一乙'])
})
