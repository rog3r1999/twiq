import { describe, expect, it } from 'vitest'
import { isThemePreference, resolveTheme } from '../../src/shared/theme'

describe('外观偏好解析（v0.9）', () => {
  it('system 跟随操作系统当前明暗', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('显式浅色/深色不受系统变化影响', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('设置文件里的无效值被识别并回退', () => {
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('light')).toBe(true)
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('DARK')).toBe(false)
    expect(isThemePreference(undefined)).toBe(false)
    expect(isThemePreference(null)).toBe(false)
  })
})
