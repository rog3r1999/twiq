// 假设 A9：页面缩放（125%、150%）下，编辑框与元素对齐。
// 做法：进入编辑后截取预览视图，找出编辑色（--ov-edit，浅色页面为 #0E7A5C）像素的外接矩形，与元素矩形（换算成设备像素）比较。
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { clickAt, editing, launch, preview, quit, sleep, state, workdir, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await quit(ctx)
})

for (const zoom of [125, 150]) {
  // eslint-disable-next-line no-empty-pattern
  test(`A9 缩放 ${zoom}%：编辑框与元素对齐`, async ({}, info) => {
    const dir = workdir('basic.html')
    const settings = path.join(dir, 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ zoom }))
    ctx = await launch([path.join(dir, 'basic.html')], { settings })
    const page = await preview(ctx.app)
    await sleep(300)
    await page.evaluate(() => {
      const w = window as unknown as { __blurs: number }
      w.__blurs = 0
      window.addEventListener('blur', () => w.__blurs++)
    })
    // 第一次：一下选中、一下改字；被打断后 h1 还是选中的，再点一下就进入改字
    const enter = async (once = false): Promise<void> => {
      await clickAt(page, 'h1', { offset: 1, once })
      await editing(ctx.app, true)
      await sleep(200)
    }
    await enter()
    const css = await page.evaluate(() => {
      const r = document.querySelector('h1')!.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio }
    })
    // 框的上下边是横跨元素的整行编辑色；只在这样的行之间找左右边。
    // Windows 的 ClearType 会在黑字边缘留下零星彩色像素，有的落在编辑色的容差里，不能算进框里
    const minRun = 0.3 * css.w * css.dpr
    const capture = (): Promise<{ x0: number; y0: number; x1: number; y1: number; scale: number; png: string }> => ctx.app.evaluate(async (_e, minRun) => {
      const w = (globalThis as unknown as { __hw: { ws: { active: { view: Electron.WebContentsView } } } }).__hw.ws
      const img = await w.active.view.webContents.capturePage()
      const { width, height } = img.getSize()
      const bmp = img.toBitmap() // BGRA
      const sw = bmp.length / 4 / height
      const rows: { n: number; min: number; max: number }[] = []
      for (let y = 0; y < height; y++) {
        const row = { n: 0, min: Infinity, max: -1 }
        for (let x = 0; x < sw; x++) {
          const i = (y * sw + x) * 4
          const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]
          // 编辑色 #0E7A5C 的实线（不含 16% 光晕）
          if (Math.abs(r - 0x0e) < 20 && Math.abs(g - 0x7a) < 20 && Math.abs(b - 0x5c) < 20) {
            row.n++; row.min = Math.min(row.min, x); row.max = Math.max(row.max, x)
          }
        }
        rows.push(row)
      }
      const edges = rows.flatMap((r, y) => (r.n >= minRun * (sw / width) ? [y] : []))
      const y0 = edges.length ? edges[0] : -1
      const y1 = edges.length ? edges[edges.length - 1] : -1
      let x0 = Infinity, x1 = -1
      for (let y = Math.max(y0, 0); y <= y1; y++) {
        x0 = Math.min(x0, rows[y].min); x1 = Math.max(x1, rows[y].max)
      }
      return { x0, y0, x1, y1, scale: sw / width, png: img.toPNG().toString('base64') }
    }, minRun)
    // 窗口失去焦点会提交并退出编辑（preview.ts 的 blur）。macOS CI 上偶尔截到选中框而不是编辑框（疑似别的窗口抢走焦点，blurs 记录次数）：
    // 截图后确认仍在编辑，被打断就重新进入再截
    let box = await capture()
    let interrupted = 0
    while (!(await state(ctx.app)).editing && interrupted < 3) {
      interrupted++
      await enter(true)
      box = await capture()
    }
    const blurs = await page.evaluate(() => (window as unknown as { __blurs: number }).__blurs)
    // 设备像素 = CSS 像素（已含页面缩放）× devicePixelRatio
    const k = css.dpr * box.scale
    // 留下现场：失败时随 test-results 一起上传，对照截图看编辑色像素落在哪里
    fs.writeFileSync(info.outputPath('preview.png'), Buffer.from(box.png, 'base64'))
    fs.writeFileSync(info.outputPath('measure.json'), JSON.stringify({ css, box: { ...box, png: undefined }, k, interrupted, blurs }, null, 1))
    expect(box.x1).toBeGreaterThan(0)
    // 「文字」标签在框外左上方，所以只比较左、右、下三边；上边由标签决定
    const tol = 4 * k
    expect(Math.abs(box.x0 - css.x * k)).toBeLessThan(tol)
    expect(Math.abs(box.x1 - (css.x + css.w) * k)).toBeLessThan(tol)
    expect(Math.abs(box.y1 - (css.y + css.h) * k)).toBeLessThan(tol)
  })
}
