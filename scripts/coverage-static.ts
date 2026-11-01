// 覆盖率（静态版）：只依赖 parse 与 host-rules，不启动浏览器。
// 用法：pnpm coverage:static [输出文件]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodeFile } from '../src/main/parse'
import { renderReport, staticCoverage, type PageRow } from '../src/main/coverage'
import { setWarn } from '../src/main/patch'

setWarn(() => {})
const root = resolve(__dirname, '../tests/fixtures')
const sets = [
  { name: '原始样本集（tests/fixtures/real）', dir: join(root, 'real') },
  { name: '约束样本集（tests/fixtures/real-guided）', dir: join(root, 'real-guided') }
]
  .filter((s) => existsSync(s.dir))
  .map((s) => ({
    name: s.name,
    rows: readdirSync(s.dir)
      .filter((f) => /\.html?$/i.test(f))
      .sort()
      .map((f): PageRow => {
        const { source } = decodeFile(readFileSync(join(s.dir, f)))
        return { name: f, stat: staticCoverage(source), scriptRendered: false }
      })
  }))
  .filter((s) => s.rows.length > 0)

const report = renderReport(
  '覆盖率初测（静态）',
  sets,
  '口径：只分析源码，分母为源码中可见文字（去掉空白，不含 script、style、title 等不可见内容）。脚本在运行时生成或改写的文字无法静态识别：生成的文字不在分母里，被改写的文字仍按源码计入。渲染版见 pnpm coverage。'
)
const out = process.argv[2]
if (out) writeFileSync(out, report)
console.log(report)
