// AC-41 性能：1MB 的 HTML
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { clickAt, editing, launch, preview, quit, sleep, waitFor, workdir, ws, type Ctx } from './helpers'

// 慢机器上的宽限系数（见 ci.yml）：GitHub 的 Windows 虚拟机设为 3，同一份代码在那里的主进程提交从 150ms 到 520ms 不等；
// macOS 虚拟机设为 2，主进程提交从 78ms 到 160ms 不等。只用来拦住明显的退化，产品指标本身不变，本机按 1 检查
const slack = Number(process.env.HW_PERF_SLACK) || 1

let ctx: Ctx | null = null
test.afterEach(async () => {
  if (!ctx) return
  await quit(ctx)
})

test('AC-41 1MB：打开到可编辑 ≤ 2s，单次提交 ≤ 200ms，悬停反馈 ≤ 100ms', async () => {
  const dir = workdir('large-1mb.html', 'basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  await preview(ctx.app)
  const t0 = Date.now()
  await ws(ctx.app, 'openPath', path.join(dir, 'large-1mb.html'))
  const page = await preview(ctx.app)
  // 可编辑：点击第一个标题能进入编辑
  await clickAt(page, 'h2', { end: true })
  await editing(ctx.app, true)
  const openMs = Date.now() - t0
  await page.keyboard.type('改')
  const t1 = Date.now()
  await page.keyboard.press('Enter')
  await waitFor(ctx.app, (s) => !s.editing && s.tabs[1].canUndo, 5000)
  const commitMs = Date.now() - t1
  // v0.8 起，有选中元素时叠加层仍会画悬停框，但主进程不再收到悬停 IPC；
  // 先 Esc 清除选中，才能测到「鼠标移动 → 主进程 hover」这条链路。
  await page.keyboard.press('Escape')
  await waitFor(ctx.app, (s) => !s.selection, 3000)
  // 悬停：从移动鼠标到主进程收到悬停目标（含两次 IPC，比叠加层画框更晚）
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(300)
  const p = await page.locator('section.s3 p').boundingBox()
  const t2 = Date.now()
  await page.mouse.move(p!.x + 5, p!.y + 5)
  let hoverMs = -1
  while (Date.now() - t2 < 2000) {
    const st = await ctx.app.evaluate(() => (globalThis as unknown as { __hw: { ws: { hover: { fullSelector: string } | null } } }).__hw.ws.hover?.fullSelector ?? '')
    if (st.includes('section.s3 > p')) {
      hoverMs = Date.now() - t2
      break
    }
    await sleep(5)
  }
  // 主进程内单次提交（补丁、整份重新解析、结构自检、元素表推送）的耗时
  const mainCommitMs = await ctx.app.evaluate(() => {
    const w = (globalThis as unknown as { __hw: { ws: { active: { doc: { elements: { eid: number; isHost: boolean; slots: { text: string }[] }[] } }; commit(t: unknown, ops: unknown[]): unknown } } }).__hw.ws
    const t = w.active
    const h = t.doc.elements.filter((e) => e.isHost)[500]
    const t0 = performance.now()
    w.commit(t, [{ eid: h.eid, slot: 0, newText: t.doc.elements[h.eid].slots[0].text + '!' }])
    return performance.now() - t0
  })
  console.log(`main commit ${mainCommitMs.toFixed(0)}ms`)
  expect(mainCommitMs).toBeLessThan(200 * slack)
  console.log(`open→editable ${openMs}ms, commit ${commitMs}ms, hover ${hoverMs}ms`)
  expect(openMs).toBeLessThan(2000 * slack)
  expect(commitMs).toBeLessThan((200 + 150) * slack) // 含测试轮询间隔（100ms）与 IPC
  expect(hoverMs).toBeGreaterThanOrEqual(0)
  expect(hoverMs).toBeLessThan(100 * slack)
})
