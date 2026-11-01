// 界面语言（v0.10）：简体中文与英文。每个进程（主进程、外壳、预览页）各自持有当前语言，
// 由主进程按设置解析后下发。文案表用 localized(zh, en) 定义：两份同形（英文漏一项编译不过），
// 取值时按当前语言返回，所以调用处照旧写 TOAST.saved、DIALOG.unsaved(name)。
import type { Lang, LangPreference } from './types'

let current: Lang = 'zh'

export function setLang(l: Lang): void {
  current = l
}

export function lang(): Lang {
  return current
}

/** 两种语言的同一张文案表。只代理第一层：取到的子对象、函数已经是当前语言的那一份。 */
export function localized<T extends object>(zh: T, en: NoInfer<T>): T {
  return new Proxy(zh, {
    get: (_t, k) => (current === 'en' ? en : zh)[k as keyof T]
  })
}

/** 设置里的语言偏好是否有效；设置文件被手工改坏时回退到跟随系统。 */
export function isLangPreference(v: unknown): v is LangPreference {
  return v === 'system' || v === 'zh' || v === 'en'
}

/**
 * 解析实际使用的语言。system 按操作系统的首选语言：中文（任何地区）用简体中文，其余用英文。
 * override 来自环境变量 TWIQ_LANG（测试与截图用），优先于设置。
 */
export function resolveLang(pref: LangPreference, systemLanguages: readonly string[], override?: string): Lang {
  if (override === 'zh' || override === 'en') return override
  if (pref !== 'system') return pref
  return /^zh\b/i.test(systemLanguages[0] ?? '') ? 'zh' : 'en'
}
