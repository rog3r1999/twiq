// 假设 A9：页面缩放（125%、150%）下，编辑框与元素对齐。
// 做法：进入编辑后截取预览视图，找出编辑色（--ov-edit，浅色页面为 #0E7A5C）像素的外接矩形，与元素矩形（换算成设备像素）比较。
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { clickAt, editing, launch, preview, sleep, workdir, type Ctx } from './helpers'

let ctx: Ctx
test.afterEach(async () => {
  await ctx?.app.evaluate(() => {
    ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
  })
  await ctx?.app.close()
})

for (const zoom of [125, 150]) {
  test(`A9 缩放 ${zoom}%：编辑框与元素对齐`, async () => {
    const dir = workdir('basic.html')
    const settings = path.join(dir, 'settings.json')
    fs.writeFileSync(settings, JSON.stringify({ zoom }))
    ctx = await launch([path.join(dir, 'basic.html')], { settings })
    const page = await preview(ctx.app)
    await sleep(300)
    await clickAt(page, 'h1', { offset: 1 })
    await editing(ctx.app, true)
    await sleep(200)
    const css = await page.evaluate(() => {
      const r = document.querySelector('h1')!.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio }
    })
    const box = await ctx.app.evaluate(async () => {
      const w = (globalThis as unknown as { __hw: { ws: { active: { view: Electron.WebContentsView } } } }).__hw.ws
      const img = await w.active.view.webContents.capturePage()
      const { width, height } = img.getSize()
      const bmp = img.toBitmap() // BGRA
      const sw = bmp.length / 4 / height
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
      for (let y = 0; y < height; y++)
        for (let x = 0; x < sw; x++) {
          const i = (y * sw + x) * 4
          const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]
          // 编辑色 #0E7A5C 的实线（不含 16% 光晕）
          if (Math.abs(r - 0x0e) < 20 && Math.abs(g - 0x7a) < 20 && Math.abs(b - 0x5c) < 20) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
          }
        }
      return { x0, y0, x1, y1, scale: sw / width }
    })
    // 设备像素 = CSS 像素（已含页面缩放）× devicePixelRatio
    const k = css.dpr * box.scale
    expect(box.x1).toBeGreaterThan(0)
    // 「文字」标签在框外左上方，所以只比较左、右、下三边；上边由标签决定
    const tol = 4 * k
    expect(Math.abs(box.x0 - css.x * k)).toBeLessThan(tol)
    expect(Math.abs(box.x1 - (css.x + css.w) * k)).toBeLessThan(tol)
    expect(Math.abs(box.y1 - (css.y + css.h) * k)).toBeLessThan(tol)
  })
}
