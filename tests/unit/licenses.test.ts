// v0.10 第三方许可：THIRD_PARTY_LICENSES.md 与实际随安装包分发的依赖一致；
// 源码里用到的第三方包都在清单覆盖范围内（主进程只能用 dependencies，外壳只能用 dependencies 或 BUNDLED）。
import { builtinModules } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED, collect, LICENSES_MD, renderLicenses } from '../../scripts/gen-licenses'

const ROOT = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
const deps = new Set(Object.keys(pkg.dependencies))

/** 目录下源码 import / require 的第三方包名（去掉子路径，保留 scope） */
function imports(dir: string): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/(?:from\s+|import\s*\(|require\()\s*['"]([^'"./][^'"]*)['"]/g)) {
          const spec = m[1]
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
          if (!found.has(name)) found.set(name, path.relative(ROOT, p))
        }
      }
    }
  }
  walk(dir)
  return found
}

const builtin = (n: string) => n.startsWith('node:') || builtinModules.includes(n) || n === 'electron'

describe('LIC-01 第三方许可', () => {
  it('THIRD_PARTY_LICENSES.md 是最新的（改了依赖后运行 pnpm licenses）', () => {
    expect(fs.readFileSync(LICENSES_MD, 'utf8')).toBe(renderLicenses(collect()))
  })

  it('macOS 包显式带上 Electron 与 Chromium 的许可证（electron-builder 在 macOS 上不会自动放进应用包）', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
    const mac = yml.slice(yml.indexOf('\nmac:'), yml.indexOf('\ndmg:'))
    expect(mac).toContain('node_modules/electron/dist/LICENSE')
    expect(mac).toContain('LICENSES.chromium.html')
  })

  it('每个分发的包都带了许可证全文', () => {
    expect(collect().filter((p) => !p.text).map((p) => p.name)).toEqual([])
  })

  it('主进程与预览 preload 只用 dependencies 里的包（它们不打包，装好的应用里只有 dependencies）', () => {
    const bad: string[] = []
    for (const dir of ['src/main', 'src/preload', 'src/shared'])
      for (const [name, file] of imports(path.join(ROOT, dir))) if (!builtin(name) && !deps.has(name)) bad.push(`${name}（${file}）`)
    expect(bad).toEqual([])
  })

  it('外壳用到的第三方包都在许可清单里（新增时加进 scripts/gen-licenses.ts 的 BUNDLED）', () => {
    const bad: string[] = []
    for (const [name, file] of imports(path.join(ROOT, 'src/renderer'))) if (!builtin(name) && !deps.has(name) && !BUNDLED.includes(name)) bad.push(`${name}（${file}）`)
    expect(bad).toEqual([])
  })
})
