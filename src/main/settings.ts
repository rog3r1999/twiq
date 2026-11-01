// 设置与最近文件（规格 6.2、12.1、13.2 第 6 条、第 14 节资源根授权）。
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isLangPreference } from '../shared/i18n'
import { isThemePreference } from '../shared/theme'
import type { LangPreference, ThemePreference, ViewportOption } from '../shared/types'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface Settings {
  window: WindowState
  zoom: number
  viewport: ViewportOption
  recent: string[]
  /** 按文件路径记住的资源根授权 */
  roots: Record<string, string>
  /** 属性面板是否展开（v0.3） */
  panelOpen: boolean
  /** 属性面板宽度（v0.7，可拖动左边缘调整） */
  panelWidth: number
  /** 显示空白容器（v0.2） */
  showBlank: boolean
  /** 外观偏好（v0.9）：system 跟随 macOS 外观实时变化 */
  theme: ThemePreference
  /** 界面语言（v0.10）：system 跟随操作系统的首选语言 */
  lang: LangPreference
  /** 已经提示过的一次性说明（偏移、尺寸、弹性布局） */
  hinted: string[]
}

const DEFAULTS: Settings = {
  window: { width: 1280, height: 800, maximized: false },
  zoom: 100,
  viewport: 'auto',
  recent: [],
  roots: {},
  panelOpen: true,
  panelWidth: 280,
  showBlank: false,
  theme: 'system',
  lang: 'system',
  hinted: []
}

export const RECENT_MAX = 10

/** 属性面板宽度范围（v0.7） */
export const PANEL_MIN = 240
export const PANEL_MAX = 720

export function clampPanel(w: number): number {
  return Number.isFinite(w) ? Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w))) : 280
}

let file = ''
let current: Settings = structuredClone(DEFAULTS)
let timer: NodeJS.Timeout | null = null

export function loadSettings(): Settings {
  file = process.env.TWIQ_SETTINGS ?? path.join(app.getPath('userData'), 'settings.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>
    current = {
      ...structuredClone(DEFAULTS),
      ...raw,
      theme: isThemePreference(raw.theme) ? raw.theme : DEFAULTS.theme,
      // 升级上来的用户（设置里还没有 lang）一直用的是中文界面，保持不变；新装的跟随系统
      lang: isLangPreference(raw.lang) ? raw.lang : 'lang' in raw ? DEFAULTS.lang : 'zh',
      window: { ...DEFAULTS.window, ...(raw.window ?? {}) }
    }
  } catch {
    current = structuredClone(DEFAULTS)
  }
  return current
}

export function settings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
  scheduleSave()
}

function scheduleSave(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(flushSettings, 300)
}

export function flushSettings(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(current, null, 2))
  } catch (err) {
    console.error('[twiq] failed to save settings', err)
  }
}

export function addRecent(p: string): void {
  const recent = [p, ...current.recent.filter((x) => x !== p)].slice(0, RECENT_MAX)
  updateSettings({ recent })
  try {
    app.addRecentDocument(p)
  } catch {
    // 部分平台不支持
  }
}

export function removeRecent(p: string): void {
  updateSettings({ recent: current.recent.filter((x) => x !== p) })
}

export function clearRecent(): void {
  updateSettings({ recent: [] })
  try {
    app.clearRecentDocuments()
  } catch {
    // 部分平台不支持
  }
}

export function setRoot(filePath: string, root: string | null): void {
  const roots = { ...current.roots }
  if (root) roots[filePath] = root
  else delete roots[filePath]
  updateSettings({ roots })
}
