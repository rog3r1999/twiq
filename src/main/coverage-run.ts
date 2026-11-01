// 覆盖率（渲染版，规格 17.4）：用与预览相同的渲染与 preload 统计可见文字与可编辑文字。
// 用法：pnpm coverage [--out 报告路径] [目录…]；不给 --out 时报告打印到终端。
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PageStats } from '../shared/types'
import { renderReport, type PageRow } from './coverage'
import { registerIpc } from './ipc'
import { loadSettings } from './settings'
import { Workspace } from './workspace'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export async function runCoverage(): Promise<void> {
  process.env.TWIQ_SETTINGS = path.join(os.tmpdir(), `twiq-coverage-${process.pid}.json`)
  loadSettings()
  const root = path.resolve(__dirname, '../../tests/fixtures')
  const out = argValue('--out')
  const explicit = process.argv.slice(process.argv.indexOf('--coverage') + 1).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--out')
  const dirs = explicit.length
    ? explicit.map((d) => ({ name: d, dir: path.resolve(d) }))
    : [
        { name: '原始样本集（tests/fixtures/real）', dir: path.join(root, 'real') },
        { name: '约束样本集（tests/fixtures/real-guided）', dir: path.join(root, 'real-guided') }
      ]

  const win = new BrowserWindow({ show: false, width: 1280, height: 800, paintWhenInitiallyHidden: true })
  const ws = new Workspace(win)
  ws.forceClose = true
  registerIpc(ws, process.platform === 'darwin')
  ws.setRect({ x: 0, y: 0, width: 1280, height: 800 })

  const sets: { name: string; rows: PageRow[] }[] = []
  for (const set of dirs) {
    if (!fs.existsSync(set.dir)) continue
    const files = fs.readdirSync(set.dir).filter((f) => /\.html?$/i.test(f)).sort()
    const rows: PageRow[] = []
    for (const f of files) {
      const stats = await measure(ws, path.join(set.dir, f))
      const stat = stats ?? { visible: 0, editable: 0, reasons: {} }
      const scriptGenerated = stat.reasons.SCRIPT_GENERATED ?? 0
      rows.push({ name: f, stat, scriptRendered: stat.visible > 0 && scriptGenerated / stat.visible > 0.5 })
      console.log(`${f}\t${stat.editable}/${stat.visible}`)
    }
    if (rows.length) sets.push({ name: set.name, rows })
  }
  const report = renderReport(
    '覆盖率终测（渲染）',
    sets,
    '口径（17.4）：页面在预览中渲染、加载完成 1 秒后统计。可见文字 = 渲染后可见的文本节点去掉空白后的字符数；可编辑 = 属于某个可编辑 host、且与源码一致的槽中的字符。SCRIPT_GENERATED 占可见文字 50% 以上的页面记为脚本渲染页，不计入门槛。门槛：原始样本集按字符加权 ≥ 80%。'
  )
  if (out) {
    fs.writeFileSync(out, report)
    console.log(`\n报告已写入 ${out}`)
  } else console.log(`\n${report}`)
  app.exit(0)
}

function measure(ws: Workspace, file: string): Promise<PageStats | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (s: PageStats | null): void => {
      if (done) return
      done = true
      ws.statsListener = null
      const t = ws.active
      if (t) void ws.closeTab(t.id).then(() => resolve(s))
      else resolve(s)
    }
    ws.statsListener = (tab) => finish(tab.stats)
    setTimeout(() => finish(null), 20000)
    void ws.openPath(file)
  })
}
