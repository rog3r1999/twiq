// 主进程的外观解析：偏好存在 settings，系统明暗来自 nativeTheme。
// 刻意不设置 nativeTheme.themeSource：它会把应用偏好强加给预览页面自己的
// prefers-color-scheme，从而改变用户文档的配色。应用外观由外壳 data-theme
// 与叠加层 token 显式控制，被预览的 HTML 保持自身样式。
import { nativeTheme } from 'electron'
import tokens from '../../design/tokens.json'
import { resolveTheme } from '../shared/theme'
import type { ResolvedTheme } from '../shared/types'
import { settings } from './settings'

/** 被预览页面的画布底色：文档自己的颜色决定外观，这里只给透明页面兜底。始终取浅色 surface 的白，不随应用主题变化。 */
export const PREVIEW_CANVAS = tokens.color.surface.light

export function effectiveTheme(): ResolvedTheme {
  return resolveTheme(settings().theme, nativeTheme.shouldUseDarkColors)
}

/** 原生窗口底色与 tokens.json 的 bg 保持同源。 */
export function windowBackground(): string {
  return tokens.color.bg[effectiveTheme()]
}
