// 真实系统按键（经原生菜单快捷键）：AC-24 键盘撤销重做、AC-32 Cmd+Q 退出确认、7.3 第 12 条编辑中撤销。
// Playwright 的 keyboard.press 不经过原生菜单，所以这里用 macOS「系统事件」发送按键。
// 需要给运行测试的终端授予「辅助功能」权限；默认跳过，HW_OS_KEYS=1 时运行。
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { clickAt, dialogTitles, editing, launch, preview, quit, read, sleep, state, stubDialogs, waitFor, workdir, type Ctx } from './helpers'

test.skip(process.platform !== 'darwin' || !process.env.HW_OS_KEYS, '需要 macOS 与 HW_OS_KEYS=1')

let ctx: Ctx
test.afterEach(async () => {
  await quit(ctx)
})

function osKey(pid: number, key: string, mods: string[]): void {
  const using = mods.length ? ` using {${mods.map((m) => `${m} down`).join(', ')}}` : ''
  execFileSync('osascript', [
    '-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    '-e', 'delay 0.2',
    '-e', `tell application "System Events" to keystroke "${key}"${using}`
  ])
}

test('AC-24 Cmd+Z / Cmd+Shift+Z / Cmd+S 经原生菜单生效', async () => {
  const dir = workdir('basic.html')
  const file = path.join(dir, 'basic.html')
  ctx = await launch([file])
  const pid = ctx.app.process().pid!
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { offset: 1 })
  await editing(ctx.app, true)
  await page.keyboard.type('AB')
  // 7.3 第 12 条：编辑中且文字已偏离进入时，Cmd+Z 交给浏览器撤销输入，不退出编辑
  osKey(pid, 'z', ['command'])
  await sleep(400)
  expect((await state(ctx.app)).editing).toBe(true)
  expect(await page.locator('h1').textContent()).not.toBe('基AB础标题')
  await page.keyboard.press('Escape')
  await editing(ctx.app, false)
  // 全部撤销回原文
  for (let i = 0; i < 3 && (await state(ctx.app)).tabs[0].dirty; i++) {
    osKey(pid, 'z', ['command'])
    await sleep(400)
  }
  expect(await page.locator('h1').textContent()).toBe('基础标题')
  expect((await state(ctx.app)).tabs[0].dirty).toBe(false)
  // 再改一次，保存
  await clickAt(page, 'h1', { offset: 1 })
  await editing(ctx.app, true)
  await page.keyboard.type('C')
  await page.keyboard.press('Enter')
  await waitFor(ctx.app, (s) => !s.editing && s.tabs[0].dirty)
  osKey(pid, 'z', ['command'])
  await waitFor(ctx.app, (s) => !s.tabs[0].dirty)
  osKey(pid, 'z', ['command', 'shift'])
  await waitFor(ctx.app, (s) => s.tabs[0].dirty)
  osKey(pid, 's', ['command'])
  await waitFor(ctx.app, (s) => !s.tabs[0].dirty)
  expect(read(file)).toContain('<h1>基C础标题</h1>')
})

test('AC-32 Cmd+Q：有未保存修改时询问；选「取消」后应用不退出', async () => {
  const dir = workdir('basic.html')
  ctx = await launch([path.join(dir, 'basic.html')])
  const pid = ctx.app.process().pid!
  const page = await preview(ctx.app)
  await clickAt(page, 'h1', { offset: 1 })
  await editing(ctx.app, true)
  await page.keyboard.type('Q')
  await page.keyboard.press('Enter')
  await waitFor(ctx.app, (s) => !s.editing && s.tabs[0].dirty)
  await stubDialogs(ctx.app, { responses: [2] }) // 保存、不保存、取消
  osKey(pid, 'q', ['command'])
  await sleep(800)
  expect(await dialogTitles(ctx.app)).toEqual(['要保存对 basic.html 的修改吗？'])
  expect((await state(ctx.app)).tabs[0].dirty).toBe(true)
})
