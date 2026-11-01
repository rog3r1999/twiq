// 主进程的界面语言：偏好存在 settings，system 按操作系统的首选语言解析（v0.10）。
import { app } from 'electron'
import { resolveLang, setLang } from '../shared/i18n'
import type { Lang } from '../shared/types'
import { settings } from './settings'

export function effectiveLang(): Lang {
  return resolveLang(settings().lang, app.getPreferredSystemLanguages(), process.env.TWIQ_LANG)
}

/** 解析并设为主进程的当前语言；返回解析结果。 */
export function applyLang(): Lang {
  const l = effectiveLang()
  setLang(l)
  return l
}
