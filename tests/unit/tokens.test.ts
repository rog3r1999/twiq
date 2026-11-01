import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderTokensCss, TOKENS_CSS, TOKENS_JSON } from '../../scripts/gen-tokens'

describe('设计 token', () => {
  it('tokens.css 与 tokens.json 一致（改了 json 后运行 pnpm tokens）', () => {
    expect(readFileSync(TOKENS_CSS, 'utf8')).toBe(renderTokensCss(JSON.parse(readFileSync(TOKENS_JSON, 'utf8'))))
  })
})
