// 由 design/tokens.json 生成 src/renderer/src/tokens.css。
// 用法：pnpm tokens（改了 tokens.json 后运行；单元测试会检查两者一致）。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Tokens {
  color: Record<string, { light: string; dark: string }>
  font: Record<string, string>
  type: Record<string, { family: string; size: string; line: number; weight: number }>
  space: Record<string, string>
  radius: Record<string, string>
  shadow: Record<string, string>
  motion: Record<string, string>
}

const ROOT = resolve(__dirname, '..')
export const TOKENS_JSON = resolve(ROOT, 'design/tokens.json')
export const TOKENS_CSS = resolve(ROOT, 'src/renderer/src/tokens.css')

export function renderTokensCss(t: Tokens): string {
  const colors = (theme: 'light' | 'dark', indent: string): string[] =>
    Object.entries(t.color).map(([k, v]) => `${indent}--color-${k}: ${v[theme]};`)
  const plain = (prefix: string, rec: Record<string, string>): string[] => Object.entries(rec).map(([k, v]) => `  --${prefix}-${k}: ${v};`)
  return [
    '/* Twiq - generated from tokens.json. Do not edit by hand. */',
    ':root {',
    '  color-scheme: light dark;',
    ...colors('light', '  '),
    ...plain('font', t.font),
    ...Object.entries(t.type).flatMap(([k, v]) => [
      `  --text-${k}-size: ${v.size};`,
      `  --text-${k}-line: ${v.line};`,
      `  --text-${k}-weight: ${v.weight};`,
      `  --text-${k}-family: var(--font-${v.family});`
    ]),
    ...plain('space', t.space),
    ...plain('radius', t.radius),
    ...plain('shadow', t.shadow),
    ...plain('motion', t.motion),
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    ...colors('dark', '    '),
    '  }',
    '}',
    ':root[data-theme="dark"] {',
    '  color-scheme: dark;',
    ...colors('dark', '  '),
    '}',
    ':root[data-theme="light"] { color-scheme: light; }',
    ''
  ].join('\n')
}

if (require.main === module) {
  writeFileSync(TOKENS_CSS, renderTokensCss(JSON.parse(readFileSync(TOKENS_JSON, 'utf8'))))
  console.log(`已写入 ${TOKENS_CSS}`)
}
