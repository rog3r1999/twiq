// v0.9.1 性能专项：拖动属性面板时，大文档不再逐帧重排预览页——外壳显示冻结画面、按帧跟手，
// 松手后主进程按最终尺寸重排，画好第一帧再换回实时页面。
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launch, preview, quit, shell, sleep, state, waitFor, workdir, ws, type Ctx } from './helpers'

let ctx: Ctx
// 失败时留下现场：外壳截图、状态、拖动期间外壳收到的指针事件（Windows 上排查拖动中断用）
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (ctx && info.status !== info.expectedStatus) {
    const sh = await shell(ctx.app)
    await sh.screenshot({ path: info.outputPath('shell.png') }).catch(() => {})
    const log = await sh.evaluate(() => (window as unknown as { __ptr?: unknown[] }).__ptr ?? []).catch((e) => [String(e)])
    const st = await state(ctx.app).catch((e) => String(e))
    const fz = await freezeState(ctx.app).catch((e) => String(e))
    fs.writeFileSync(info.outputPath('pointer.json'), JSON.stringify({ freezeState: fz, state: st, events: log }, null, 1))
  }
  await quit(ctx)
})

async function setup(fixture: string) {
  const dir = workdir(fixture)
  ctx = await launch([path.join(dir, fixture)])
  const page = await preview(ctx.app)
  await ws(ctx.app, 'setMode', 'select')
  await waitFor(ctx.app, (s) => s.tabs[0].mode === 'edit')
  await sleep(400)
  const sh = await shell(ctx.app)
  // 记下外壳收到的指针事件（捕获阶段，先于应用自己的处理），失败时写进 pointer.json
  await sh.evaluate(() => {
    const log: unknown[] = []
    ;(window as unknown as { __ptr: unknown[] }).__ptr = log
    const t0 = performance.now()
    let moves = 0
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'blur', 'visibilitychange']) {
      window.addEventListener(
        type,
        (e) => {
          const p = e as PointerEvent
          if (type === 'pointermove' && ++moves % 4 !== 1) return
          const el = e.target instanceof Element ? e.target.className : String(e.target)
          log.push({ t: Math.round(performance.now() - t0), type, x: p.clientX, buttons: p.buttons, target: el, moves })
        },
        true
      )
    }
  })
  return { page, sh }
}

interface Counters {
  zoom: number
  layout: number
  bounds: number
}
interface WsLike {
  applyZoom(...a: unknown[]): unknown
  layout(...a: unknown[]): unknown
  freezeState: string
  active: { view: { setBounds(...a: unknown[]): void; getVisible(): boolean } }
}

/** 包住主进程的布局/缩放/视图尺寸，数一数拖动期间页面被改了几次。 */
async function instrument(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const w = (globalThis as unknown as { __hw: { ws: WsLike } }).__hw.ws
    const g: Counters = { zoom: 0, layout: 0, bounds: 0 }
    ;(globalThis as unknown as { __pp: Counters }).__pp = g
    const wrap = (name: 'applyZoom' | 'layout', key: 'zoom' | 'layout') => {
      const o = w[name].bind(w)
      w[name] = (...a: unknown[]) => {
        g[key]++
        return o(...a)
      }
    }
    wrap('applyZoom', 'zoom')
    wrap('layout', 'layout')
    const v = w.active.view
    const sb = v.setBounds.bind(v)
    v.setBounds = (...a: unknown[]) => {
      g.bounds++
      return sb(...a)
    }
  })
}

const counters = (app: ElectronApplication): Promise<Counters> =>
  app.evaluate(() => (globalThis as unknown as { __pp: Counters }).__pp)
const resetCounters = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => {
    const g = (globalThis as unknown as { __pp: Counters }).__pp
    g.zoom = 0
    g.layout = 0
    g.bounds = 0
  })
const freezeState = (app: ElectronApplication): Promise<string> =>
  app.evaluate(() => (globalThis as unknown as { __hw: { ws: WsLike } }).__hw.ws.freezeState)
const viewVisible = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(() => (globalThis as unknown as { __hw: { ws: WsLike } }).__hw.ws.active.view.getVisible())

/** 拖住面板左边缘：按下 → 分几步移动。返回手柄位置，便于后续继续拖。 */
async function holdHandle(sh: Page, dy = 300) {
  const h = (await sh.locator('.panel-resize').boundingBox())!
  await sh.mouse.move(h.x + 3, h.y + dy)
  await sh.mouse.down()
  return h
}

test('PP-01 大文档：拖动时显示冻结画面、预览视图隐藏，页面一次都不重排', async () => {
  const { page, sh } = await setup('large-1mb.html')
  await instrument(ctx.app)
  const vw0 = await page.evaluate(() => window.innerWidth)
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 120, h.y + 300, { steps: 8 })
  // 冻结已生效：画面在屏幕上，实时预览视图被隐藏（外壳不再被 HTML 盖住）
  await expect(sh.locator('.freeze img')).toBeVisible()
  await expect.poll(() => freezeState(ctx.app)).toBe('frozen')
  expect(await viewVisible(ctx.app)).toBe(false)
  // 冻结画面与预览区同宽（自动视口），并且随面板继续收宽
  const widths = () =>
    sh.evaluate(() => [
      (document.querySelector('.freeze-view') as HTMLElement).getBoundingClientRect().width,
      (document.querySelector('.preview') as HTMLElement).getBoundingClientRect().width
    ])
  await expect.poll(async () => Math.abs((await widths())[0] - (await widths())[1])).toBeLessThan(1.5)
  await resetCounters(ctx.app)
  await sh.mouse.move(h.x - 340, h.y + 300, { steps: 24 })
  const mid = await counters(ctx.app)
  // 拖动期间没有任何「改页面尺寸 / 改缩放」——这正是以前每次 84–110ms 重排的来源
  expect(mid.zoom).toBe(0)
  expect(mid.bounds).toBe(0)
  await expect.poll(async () => Math.abs((await widths())[0] - (await widths())[1])).toBeLessThan(1.5)
  // 工具栏的显示比例跟着拖动实时变化，而不是等松手
  const fit = await sh.locator('.zoom .fit').textContent()
  expect(fit).toMatch(/^显示 \d+%$/)
  await sh.mouse.up()
  // 松手：画面收起、实时页面回来、最终宽度落定
  await expect(sh.locator('.freeze')).toHaveCount(0)
  expect(await viewVisible(ctx.app)).toBe(true)
  await waitFor(ctx.app, (s) => s.panelWidth > 560)
  // 页面仍按原宽度排版（只缩小，不重排）
  expect(await page.evaluate(() => window.innerWidth)).toBe(vw0)
  const end = await counters(ctx.app)
  expect(end.zoom).toBeGreaterThan(0)
  // 松手只重排一次，不是每帧一次
  expect(end.zoom).toBeLessThanOrEqual(2)
})

test('PP-02 小文档：不冻结，拖动仍然实时缩放', async () => {
  const { page, sh } = await setup('basic.html')
  const vw0 = await page.evaluate(() => window.innerWidth)
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 160, h.y + 300, { steps: 10 })
  await sleep(250)
  expect(await freezeState(ctx.app)).toBe('idle')
  expect(await sh.locator('.freeze').count()).toBe(0)
  expect(await viewVisible(ctx.app)).toBe(true)
  // 预览区跟着面板收窄，页面按比例缩小
  const before = await sh.locator('.panel-host').boundingBox()
  await sh.mouse.up()
  await waitFor(ctx.app, (s) => s.panelWidth > 420)
  expect((await sh.locator('.panel-host').boundingBox())!.width).toBeGreaterThan(before!.width - 1)
  expect(await page.evaluate(() => window.innerWidth)).toBe(vw0)
})

test('PP-03 固定视口：冻结画面按视口宽度居中，不铺满预览区', async () => {
  const { sh } = await setup('large-1mb.html')
  await ws(ctx.app, 'setViewport', '390')
  await sleep(400)
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 240, h.y + 300, { steps: 12 })
  await expect(sh.locator('.freeze img')).toBeVisible()
  const box = await sh.evaluate(() => {
    const f = (document.querySelector('.freeze-view') as HTMLElement).getBoundingClientRect()
    const p = (document.querySelector('.preview') as HTMLElement).getBoundingClientRect()
    return { w: f.width, left: f.left - p.left, right: p.right - f.right, pw: p.width }
  })
  expect(box.w).toBeLessThanOrEqual(390.5)
  expect(Math.abs(box.left - box.right)).toBeLessThan(1.5)
  await sh.mouse.up()
  await expect(sh.locator('.freeze')).toHaveCount(0)
})

test('PP-04 快速点一下手柄再松手：不留下冻结画面，宽度照常落定', async () => {
  const { page, sh } = await setup('large-1mb.html')
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 60, h.y + 300, { steps: 2 })
  await sh.mouse.up()
  await waitFor(ctx.app, (s) => s.panelWidth > 300)
  await expect(sh.locator('.freeze')).toHaveCount(0)
  await expect.poll(() => freezeState(ctx.app)).toBe('idle')
  expect(await viewVisible(ctx.app)).toBe(true)
  await sleep(200)
  await expect(sh.locator('.freeze')).toHaveCount(0)
  expect(await page.evaluate(() => window.innerWidth)).toBeGreaterThan(0)
})

test('PP-05 拖动途中切到别的标签：冻结画面收起，实时页面回来，不残留', async () => {  const { sh } = await setup('large-1mb.html')
  const big = (await state(ctx.app)).activeId!
  await ws(ctx.app, 'newDoc')
  await waitFor(ctx.app, (s) => s.tabs.length === 2 && s.activeId !== big)
  await ws(ctx.app, 'activate', big)
  await waitFor(ctx.app, (s) => s.activeId === big)
  await sleep(300)
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 160, h.y + 300, { steps: 8 })
  await expect(sh.locator('.freeze img')).toBeVisible()
  const other = (await state(ctx.app)).tabs.find((t) => t.id !== big)!.id
  await ws(ctx.app, 'activate', other)
  await expect(sh.locator('.freeze')).toHaveCount(0)
  await expect.poll(() => freezeState(ctx.app)).toBe('idle')
  expect(await viewVisible(ctx.app)).toBe(true)
  // 拖动的手还按着（指针捕获在手柄上）：松手不应留下异常状态
  await sh.mouse.up()
  await sleep(200)
  await expect(sh.locator('.freeze')).toHaveCount(0)
  await expect.poll(() => freezeState(ctx.app)).toBe('idle')
})

test('PP-06 把面板拉窄、预览区变宽：冻结画面跟着铺开，不停在取景时的大小', async () => {
  const { sh } = await setup('large-1mb.html')
  await ws(ctx.app, 'setPanelWidth', 620)
  await waitFor(ctx.app, (s) => s.panelWidth === 620)
  await sleep(400)
  const before = (await sh.locator('.preview').boundingBox())!
  const h = await holdHandle(sh)
  // 往右拖：面板变窄，预览区比取景时更宽
  await sh.mouse.move(h.x + 260, h.y + 300, { steps: 12 })
  await expect(sh.locator('.freeze img')).toBeVisible()
  const box = await sh.evaluate(() => {
    const f = (document.querySelector('.freeze-view') as HTMLElement).getBoundingClientRect()
    const p = (document.querySelector('.preview') as HTMLElement).getBoundingClientRect()
    return { fw: f.width, pw: p.width }
  })
  expect(box.pw).toBeGreaterThan(before.width + 100)
  expect(Math.abs(box.fw - box.pw)).toBeLessThan(1.5)
  await sh.mouse.up()
  await expect(sh.locator('.freeze')).toHaveCount(0)
})

test('PP-07 松手事件丢了（指针捕获被抢走）：下一次移动就收尾，不留冻结画面', async () => {
  const { sh } = await setup('large-1mb.html')
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 150, h.y + 300, { steps: 10 })
  await expect(sh.locator('.freeze img')).toBeVisible()
  // 系统吞掉了 pointerup：按键已经是松开状态（buttons=0），只能从 mousemove 上看出来
  await sh.locator('.panel-resize').dispatchEvent('pointermove', { clientX: h.x - 160, clientY: h.y + 300, buttons: 0, pointerId: 1 })
  await expect(sh.locator('.freeze')).toHaveCount(0)
  await expect.poll(() => freezeState(ctx.app)).toBe('idle')
  expect(await viewVisible(ctx.app)).toBe(true)
  // 拖动到的宽度照常落定，不是被丢掉
  await waitFor(ctx.app, (s) => s.panelWidth > 380)
  // 迟到的松手：不再改状态
  await sh.mouse.up()
  await sleep(200)
  await expect(sh.locator('.freeze')).toHaveCount(0)
  await expect.poll(() => freezeState(ctx.app)).toBe('idle')
})

test('PP-08 拖动中手柄丢了指针捕获：面板照样跟手，松手按最终位置落定', async () => {
  const { sh } = await setup('large-1mb.html')
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 60, h.y + 300, { steps: 4 })
  await expect(sh.locator('.freeze img')).toBeVisible()
  // 系统把手柄的指针捕获拿走：之后的移动落到预览区、面板这些别的元素上，按键仍按着
  const lost = await sh.locator('.panel-resize').evaluate((el) => {
    el.releasePointerCapture(1)
    return !el.hasPointerCapture(1)
  })
  expect(lost).toBe(true)
  await sh.mouse.move(h.x - 340, h.y + 300, { steps: 16 })
  await sh.mouse.up()
  await expect(sh.locator('.freeze')).toHaveCount(0)
  // 默认宽度 280，往左拖了 340：面板约 620，不是停在丢掉捕获时的三百多
  await waitFor(ctx.app, (s) => s.panelWidth > 560)
})

test('PP-09 拖动中别处收到一次「没按键」的移动（Windows 按真实光标补发的那种）：不当作松手，拖动继续', async () => {
  const { sh } = await setup('large-1mb.html')
  const h = await holdHandle(sh)
  await sh.mouse.move(h.x - 60, h.y + 300, { steps: 4 })
  await expect(sh.locator('.freeze img')).toBeVisible()
  await sh.locator('.preview').dispatchEvent('pointermove', { clientX: 300, clientY: 300, buttons: 0, pointerId: 1 })
  await sh.mouse.move(h.x - 340, h.y + 300, { steps: 16 })
  await sh.mouse.up()
  await expect(sh.locator('.freeze')).toHaveCount(0)
  await waitFor(ctx.app, (s) => s.panelWidth > 560)
})
