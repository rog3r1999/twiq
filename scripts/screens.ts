// UI 截屏巡检：用真实应用走一遍关键状态，每个状态存一张 PNG，供人工或代理对照规格第 9、10 节检查。
// 用法：pnpm screens [输出目录]（默认 screens/，已加入 .gitignore）。需要先 pnpm build。
// 截取的是整个窗口（BrowserWindow.capturePage），包含外壳与预览视图。
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const FIX = path.join(ROOT, 'tests/fixtures')
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'screens'))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Hw = {
  __hw: {
    ws: Record<string, (...a: unknown[]) => unknown> & {
      win: Electron.BrowserWindow
      active: { view: Electron.WebContentsView } | null
      state(): { activeId: string | null; editing: boolean }
    }
  }
}

// BrowserWindow.capturePage 只截外壳，不含预览页所在的 WebContentsView；
// 两张分别截下来，在外壳页面里用 canvas 按视图位置合成一张。
async function shot(app: ElectronApplication, name: string): Promise<void> {
  await sleep(250)
  const parts = await app.evaluate(async () => {
    const ws = (globalThis as unknown as Hw).__hw.ws
    const shell = await ws.win.capturePage()
    const view = ws.active?.view
    const visible = view && view.getVisible()
    return {
      shell: shell.toDataURL(),
      width: ws.win.getContentBounds().width,
      view: visible ? (await view.webContents.capturePage()).toDataURL() : null,
      bounds: visible ? view.getBounds() : null
    }
  })
  const shellPage = app.windows().find((w) => !w.url().startsWith('hw://'))!
  // 回调里不能有具名函数：tsx 会注入页面里不存在的 __name 辅助函数
  const b64 = await shellPage.evaluate(async (p) => {
    const [shell, view] = await Promise.all(
      [p.shell, p.view].map((src) =>
        src
          ? new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new Image()
              img.onload = () => resolve(img)
              img.onerror = reject
              img.src = src
            })
          : null
      )
    )
    const canvas = document.createElement('canvas')
    canvas.width = shell!.width
    canvas.height = shell!.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(shell!, 0, 0)
    if (view && p.bounds) {
      const k = shell!.width / p.width
      ctx.drawImage(view, p.bounds.x * k, p.bounds.y * k, p.bounds.width * k, p.bounds.height * k)
    }
    return canvas.toDataURL('image/png').split(',')[1]
  }, parts)
  const file = path.join(OUT, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  console.log(file)
}

function call(app: ElectronApplication, method: string, ...args: unknown[]): Promise<unknown> {
  return app.evaluate(async (_e, [m, a]) => (globalThis as unknown as Hw).__hw.ws[m as string](...(a as unknown[])), [method, args] as const)
}

async function preview(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const id = await app.evaluate(() => (globalThis as unknown as Hw).__hw.ws.state().activeId)
    const p = id ? app.windows().find((w) => w.url().startsWith(`hw://t-${id}/`)) : undefined
    if (p) {
      await p.waitForLoadState('load')
      await sleep(600)
      return p
    }
    await sleep(100)
  }
  throw new Error('preview not found')
}

async function hover(page: Page, selector: string): Promise<void> {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`no box: ${selector}`)
  await page.mouse.move(b.x + 8, b.y + b.height / 2)
  await sleep(60)
  await page.mouse.move(b.x + 12, b.y + b.height / 2)
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-screens-'))
  for (const f of ['basic.html', 'pre-svg-textarea.html']) fs.copyFileSync(path.join(FIX, f), path.join(tmp, f))
  fs.cpSync(path.join(FIX, 'parent-assets'), path.join(tmp, 'parent-assets'), { recursive: true })
  const zoom = Number(process.env.HW_ZOOM ?? 100)
  const settings = path.join(tmp, 'settings.json')
  // HW_LANG=en 截英文界面，HW_THEME=dark 截深色（v0.10）；默认中文、跟随系统
  const lang = process.env.HW_LANG === 'en' ? 'en' : 'zh'
  const theme = process.env.HW_THEME ?? 'system'
  fs.writeFileSync(settings, JSON.stringify({ zoom, lang, theme, recent: [path.join(tmp, 'basic.html'), path.join(tmp, 'gone.html')] }))
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, TWIQ_TEST: '1', TWIQ_MULTI_INSTANCE: '1', TWIQ_SETTINGS: settings, TWIQ_LANG: lang } as Record<string, string>
  })
  try {
    await sleep(1500)
    await shot(app, '01-empty')

    await call(app, 'loadSample')
    let page = await preview(app)
    await shot(app, '02-sample')
    await hover(page, 'p.lead')
    await shot(app, '03-hover-editable')
    // v0.8 起不能改的原因在「再点一次」时说明：选中后再点一下，气泡出现
    const vis = await page.locator('#visitors').boundingBox()
    await page.mouse.click(vis!.x + vis!.width / 2, vis!.y + vis!.height / 2)
    await sleep(200)
    await page.mouse.click(vis!.x + vis!.width / 2, vis!.y + vis!.height / 2)
    await sleep(500)
    await shot(app, '04-uneditable-bubble')
    await page.keyboard.press('Escape')
    const h1 = await page.locator('h1').boundingBox()
    // v0.8 起单击选中、再点一次改字
    await page.mouse.click(h1!.x + 40, h1!.y + h1!.height / 2)
    await sleep(200)
    await page.mouse.click(h1!.x + 40, h1!.y + h1!.height / 2)
    await sleep(300)
    await page.keyboard.type(lang === 'en' ? '!' : '！')
    await shot(app, '05-editing-toolbar')
    await page.keyboard.press('Enter')
    await sleep(120)
    await shot(app, '06-recorded')
    // v0.10 改动面板：再改一处，点状态栏的「N 处改动」
    const lead = await page.locator('p.lead').boundingBox()
    await page.mouse.click(lead!.x + 20, lead!.y + lead!.height / 2)
    await sleep(200)
    await page.mouse.click(lead!.x + 20, lead!.y + lead!.height / 2)
    await sleep(200)
    await page.keyboard.type(lang === 'en' ? ' Try it' : '试试')
    await page.keyboard.press('Enter')
    await sleep(200)
    const shellPage = app.windows().find((w) => !w.url().startsWith('hw://'))!
    await shellPage.locator('.changes-btn').click()
    await sleep(300)
    await shot(app, '06b-changes')
    await shellPage.locator('.ptabs [role="tab"]').first().click()
    // v0.10 任意元素编辑源码：选中第一张卡片，打开源码编辑器
    const card = await page.locator('.card').first().boundingBox()
    await page.mouse.click(card!.x + card!.width - 30, card!.y + 10)
    await sleep(300)
    await shot(app, '06c-props')
    await shellPage.locator('.panel .actions button', { hasText: lang === 'en' ? 'Edit Source…' : '编辑源码…' }).click()
    await sleep(300)
    await shot(app, '06d-source-editor')
    await shellPage.keyboard.press('Escape')
    await sleep(200)

    await call(app, 'openPath', path.join(tmp, 'pre-svg-textarea.html'))
    page = await preview(app)
    await shot(app, '07-second-tab')
    await call(app, 'setMode', 'preview')
    await shot(app, '08-preview-mode')
    await call(app, 'setMode', 'edit')

    await call(app, 'openPath', path.join(tmp, 'parent-assets/pages/index.html'))
    await preview(app)
    await shot(app, '09-banner')
    await call(app, 'toast', 'info', lang === 'en' ? 'Saved' : '已保存', 'basic.html')
    await shot(app, '10-toast')
    await call(app, 'setViewport', '390')
    await shot(app, '11-viewport-390')
    await call(app, 'setViewport', 'auto')

  } finally {
    await app.evaluate(() => {
      ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
    })
    await app.close()
  }
  await readmeShot(lang, theme, tmp)
  fs.rmSync(tmp, { recursive: true, force: true })
}

/** README 头图（v0.10）：新开一个窗口，干净的示例页改两处，打开「改动」页并定位到第一处。复制到 docs/ 用 */
async function readmeShot(lang: 'zh' | 'en', theme: string, tmp: string): Promise<void> {
  const settings = path.join(tmp, 'settings-readme.json')
  fs.writeFileSync(settings, JSON.stringify({ lang, theme }))
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, TWIQ_TEST: '1', TWIQ_MULTI_INSTANCE: '1', TWIQ_SETTINGS: settings, TWIQ_LANG: lang } as Record<string, string>
  })
  try {
    await sleep(1200)
    await call(app, 'loadSample')
    const page = await preview(app)
    const sh = app.windows().find((w) => !w.url().startsWith('hw://'))!
    const edit = async (selector: string, text: string): Promise<void> => {
      const r = await page.locator(selector).first().boundingBox()
      await page.mouse.click(r!.x + 8, r!.y + r!.height / 2)
      await sleep(200)
      await page.mouse.click(r!.x + 8, r!.y + r!.height / 2)
      await sleep(200)
      // 光标移到这段文字的最末尾（Cmd/Ctrl+↓），不是当前视觉行的行尾
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
      await sleep(250)
    }
    await edit('h1', lang === 'en' ? ' — edit right on the page' : '：直接在页面上改')
    await edit('.card p', lang === 'en' ? ' Nothing else in the file changes.' : '文件其余部分一个字节都不动。')
    await sh.locator('.changes-btn').click()
    await sleep(300)
    await sh.locator('.ch-goto').first().click()
    await sh.mouse.move(5, 5)
    await sleep(400)
    await shot(app, '00-readme')
  } finally {
    await app.evaluate(() => {
      ;(globalThis as unknown as { __hw: { ws: { forceClose: boolean } } }).__hw.ws.forceClose = true
    })
    await app.close()
  }
}

void main()
