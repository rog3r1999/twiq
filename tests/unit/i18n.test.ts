// v0.10 界面语言：解析规则、文案表的完整性，以及「文案表之外不写中文字面量」的守卫。
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLangPreference, lang, localized, resolveLang, setLang } from '../../src/shared/i18n'
import { BANNER, DIALOG, REASONS, TOAST, hintItems } from '../../src/shared/messages'
import { SVG_KINDS } from '../../src/shared/svg'
import { M, MENU } from '../../src/main/strings'
import { S } from '../../src/preload/strings'
import { ATTR_TEXT, SVG_FIELD_LABEL, U } from '../../src/renderer/src/strings'

afterEach(() => setLang('zh'))

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/

/** 把一张文案表在当前语言下展开成字符串列表：函数用占位参数调用一次，数组与对象逐项展开。 */
function flatten(v: unknown, at = ''): [string, string][] {
  if (typeof v === 'string') return [[at, v]]
  if (typeof v === 'function') return flatten((v as (...a: unknown[]) => unknown)('x', 2, 'y', 'z', 'w'), `${at}()`)
  if (Array.isArray(v)) return v.flatMap((x, i) => flatten(x, `${at}[${i}]`))
  if (v && typeof v === 'object') return Object.keys(v).flatMap((k) => flatten((v as Record<string, unknown>)[k], `${at}.${k}`))
  return []
}

/** 代理只转发取值；键名以中文那份为准，逐个在当前语言下取值。 */
function entries(table: object): [string, string][] {
  return Object.keys(table).flatMap((k) => flatten((table as Record<string, unknown>)[k], k))
}

const TABLES: Record<string, object> = { TOAST, DIALOG, REASONS, BANNER, SVG_KINDS, M, MENU, S, U, ATTR_TEXT, SVG_FIELD_LABEL }

describe('I18N-01 语言解析', () => {
  it('跟随系统：任何地区的中文都用简体中文，其余用英文', () => {
    expect(resolveLang('system', ['zh-Hans-CN', 'en-US'])).toBe('zh')
    expect(resolveLang('system', ['zh-TW'])).toBe('zh')
    expect(resolveLang('system', ['en-US', 'zh-CN'])).toBe('en')
    expect(resolveLang('system', ['ja-JP'])).toBe('en')
    expect(resolveLang('system', [])).toBe('en')
  })
  it('明确选择不受系统影响；TWIQ_LANG 覆盖一切，无效值忽略', () => {
    expect(resolveLang('zh', ['en-US'])).toBe('zh')
    expect(resolveLang('en', ['zh-CN'])).toBe('en')
    expect(resolveLang('zh', ['zh-CN'], 'en')).toBe('en')
    expect(resolveLang('en', ['zh-CN'], 'fr')).toBe('en')
  })
  it('设置值校验', () => {
    for (const v of ['system', 'zh', 'en']) expect(isLangPreference(v)).toBe(true)
    for (const v of ['zh-CN', '', null, undefined, 1]) expect(isLangPreference(v)).toBe(false)
  })
})

describe('I18N-02 文案表', () => {
  it('localized 按当前语言取值，切换立即生效', () => {
    const t = localized({ a: '甲', f: (n: number) => `${n} 个` }, { a: 'A', f: (n: number) => `${n} items` })
    setLang('zh')
    expect([t.a, t.f(3)]).toEqual(['甲', '3 个'])
    setLang('en')
    expect(lang()).toBe('en')
    expect([t.a, t.f(3)]).toEqual(['A', '3 items'])
  })

  it('英文界面里每一条都有译文，且不含中文字符', () => {
    setLang('en')
    const bad: string[] = []
    for (const [name, table] of Object.entries(TABLES)) {
      for (const [key, text] of entries(table)) {
        if (!text.trim() || CJK.test(text)) bad.push(`${name}.${key}: ${JSON.stringify(text)}`)
      }
    }
    for (const key of ['none', 'editing', 'preview', 'readonly', 'select', 'selected'] as const) {
      for (const h of hintItems(key, true, 'eol')) if (CJK.test(`${h.k ?? ''}${h.t}`)) bad.push(`hint.${key}: ${h.t}`)
    }
    expect(bad).toEqual([])
  })

  it('中文界面的每一条也都有文字（防止一份漏写成空串）', () => {
    setLang('zh')
    const empty: string[] = []
    for (const [name, table] of Object.entries(TABLES)) for (const [key, text] of entries(table)) if (!text.trim()) empty.push(`${name}.${key}`)
    expect(empty).toEqual([])
  })
})

/**
 * 守卫：界面文字只能写在文案表里。其他源码里出现中文字符串字面量（注释除外）就失败，
 * 提示应该放进哪个文件。开发用的覆盖率报告不面向用户，不在检查范围内。
 */
describe('I18N-03 文案表之外没有中文字面量', () => {
  const ROOT = path.resolve(__dirname, '../../src')
  const TABLE_FILES = new Set(['shared/messages.ts', 'shared/svg.ts', 'main/strings.ts', 'preload/strings.ts', 'renderer/src/strings.ts'])
  const DEV_ONLY = new Set(['main/coverage.ts', 'main/coverage-run.ts'])
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : []))

  /** 去掉注释后，找出引号、反引号或 JSX 文本里的中文 */
  function literals(code: string): string[] {
    const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    const hits: string[] = []
    for (const line of noComments.split('\n')) if (CJK.test(line)) hits.push(line.trim())
    return hits
  }

  it('只在文案表文件里出现', () => {
    const found: string[] = []
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      if (TABLE_FILES.has(rel) || DEV_ONLY.has(rel)) continue
      for (const line of literals(fs.readFileSync(file, 'utf8'))) found.push(`${rel}: ${line}`)
    }
    // 失败时：把文案移到 src/main/strings.ts（主进程）、src/renderer/src/strings.ts（外壳）、
    // src/preload/strings.ts（预览页）或 src/shared/messages.ts（共用），并补上英文
    expect(found).toEqual([])
  })
})
