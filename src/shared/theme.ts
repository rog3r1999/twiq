// 外观偏好的纯解析逻辑。主进程与测试共用，不依赖 Electron。
import type { ResolvedTheme, ThemePreference } from './types'

/** system 跟随操作系统；light / dark 是用户明确选择，不受系统变化影响。 */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** 偏好是否有效；设置文件被手工改坏时回退到跟随系统。 */
export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'light' || v === 'dark'
}
