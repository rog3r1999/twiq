// 应用外壳：工具栏、标签栏、提示条、预览区、状态栏（规格 6、10、11）。
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { AppState, HintKey, TabSummary, ThemePreference, ViewportOption } from '../../shared/types'
import { BANNER, hintItems, hintText } from '../../shared/messages'
import { U } from './strings'
import { cmd, middleEllipsis, useStore } from './store'
import { PANEL_BASE, previewRect } from './preview-layout'
import { IconClose, IconMinus, IconOpen, IconPlus, IconRedo, IconSave, IconUndo } from './components/icons'
import { Panel } from './Panel'

export function App() {
  const app = useStore((s) => s.app)
  const setApp = useStore((s) => s.setApp)
  const showToast = useStore((s) => s.showToast)
  const firstFocus = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void window.hw.getState().then((s) => s && setApp(s))
    const offs = [
      window.hw.onState(setApp),
      window.hw.onChanges((changes) => useStore.setState({ changes })),
      window.hw.onToast(showToast),
      window.hw.onFocusShell(() => firstFocus.current?.focus()),
      // 松手后主进程画好第一帧，收起冻结画面（v0.9.1）
      window.hw.onThawed(() => useStore.setState({ freeze: null, dragFit: null }))
    ]
    return () => offs.forEach((f) => f())
  }, [setApp, showToast])

  // v0.9：主进程解析后的外观写到根上，tokens.css 的 [data-theme] 生效。
  // 「跟随系统」时主进程会在 macOS 外观变化后推送新的 resolvedTheme。
  const resolvedTheme = app?.resolvedTheme
  useEffect(() => {
    if (resolvedTheme) document.documentElement.dataset.theme = resolvedTheme
  }, [resolvedTheme])

  const drag = useShellDrag()

  if (!app) return null
  const active = app.tabs.find((t) => t.id === app.activeId) ?? null
  return (
    <div className="app" {...drag}>
      <Toolbar app={app} active={active} firstRef={firstFocus} />
      <TabBar app={app} />
      {app.banner && active && app.banner.tabId === active.id && <Banner />}
      <div className="main">
        <Preview app={app} active={active} />
        {active && active.mode === 'edit' && app.panelOpen && <Panel app={app} />}
      </div>
      <StatusBar app={app} active={active} />
      {app.drag?.active && (
        <div className={`dragmask${app.drag.ok ? '' : ' bad'}`} aria-hidden="true">
          {!active && (
            <div className="label">
              {app.drag.ok ? U.dropOk : U.dropBad}
              {app.drag.ok && <div className="sub">{U.dropMany}</div>}
            </div>
          )}
        </div>
      )}
      <LiveRegion />
    </div>
  )
}

/** 外壳区域内的拖拽（工具栏、标签栏、空状态）。 */
function useShellDrag() {
  const depth = useRef(0)
  const ok = (e: DragEvent): boolean => {
    const items = Array.from(e.dataTransfer.items).filter((i) => i.kind === 'file')
    return items.length > 0 && items.every((i) => i.type === 'text/html')
  }
  const files = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  return {
    onDragEnter: (e: DragEvent) => {
      if (!files(e)) return
      e.preventDefault()
      if (depth.current++ === 0) cmd({ type: 'drag', active: true, ok: ok(e) })
    },
    onDragOver: (e: DragEvent) => {
      if (!files(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = ok(e) ? 'copy' : 'none'
    },
    onDragLeave: (e: DragEvent) => {
      if (!files(e)) return
      if (--depth.current <= 0) {
        depth.current = 0
        cmd({ type: 'drag', active: false, ok: false })
      }
    },
    onDrop: (e: DragEvent) => {
      if (!files(e)) return
      e.preventDefault()
      depth.current = 0
      const paths = Array.from(e.dataTransfer.files).map((f) => window.hw.pathForFile(f)).filter(Boolean)
      cmd({ type: 'drag', active: false, ok: false })
      if (paths.length) cmd({ type: 'openPaths', paths })
    }
  }
}

function Toolbar({ app, active, firstRef }: { app: AppState; active: TabSummary | null; firstRef: React.RefObject<HTMLButtonElement | null> }) {
  const mod = app.isMac ? 'Cmd' : 'Ctrl'
  const noDoc = !active
  const modes = ['edit', 'preview'] as const
  const onModeKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const i = modes.indexOf(active?.mode ?? 'edit')
      const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length
      cmd({ type: 'mode', mode: modes[j] })
    }
  }
  const modeLabel = { edit: U.modeEdit, preview: U.modePreview }
  const modeTip = { edit: U.modeEditTip(mod), preview: U.modePreviewTip(mod) }
  return (
    <div className="toolbar" role="toolbar" aria-label={U.toolbar}>
      <button ref={firstRef} className="tb-btn" title={U.openTip(mod)} aria-label={U.open} onClick={() => cmd({ type: 'open' })}>
        <IconOpen />
        <span className="txt">{U.open}</span>
      </button>
      <button className="tb-btn" title={U.saveTip(mod)} aria-label={U.save} disabled={noDoc || !!active?.readOnly} onClick={() => cmd({ type: 'save' })}>
        <IconSave />
        <span className="txt">{U.save}</span>
      </button>
      <span className="tb-sep" />
      <button className="tb-btn" title={U.undoTip(mod)} aria-label={U.undo} disabled={noDoc || (!active?.canUndo && !app.editing)} onClick={() => cmd({ type: 'undo' })}>
        <IconUndo />
        <span className="txt">{U.undo}</span>
      </button>
      <button className="tb-btn" title={U.redoTip(mod)} aria-label={U.redo} disabled={noDoc || (!active?.canRedo && !app.editing)} onClick={() => cmd({ type: 'redo' })}>
        <IconRedo />
        <span className="txt">{U.redo}</span>
      </button>
      <span className="tb-sep" />
      <div className="seg" role="radiogroup" aria-label={U.mode} onKeyDown={onModeKey}>
        {modes.map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={active?.mode === m}
            tabIndex={active?.mode === m || (noDoc && m === 'edit') ? 0 : -1}
            disabled={noDoc}
            title={modeTip[m]}
            onClick={() => cmd({ type: 'mode', mode: m })}
          >
            {modeLabel[m]}
          </button>
        ))}
      </div>
      {active?.mode === 'edit' && (
        <>
          <button className={`tb-btn${app.panelOpen ? ' on' : ''}`} aria-pressed={app.panelOpen} title={U.panelTip} onClick={() => cmd({ type: 'panel' })}>
            <span className="txt-always">{U.panel}</span>
          </button>
        </>
      )}
      <span className="tb-flex" />
      <select
        className="tb-select tb-theme"
        aria-label={U.appearance}
        title={U.appearanceTip}
        value={app.theme}
        onChange={(e) => cmd({ type: 'theme', value: e.target.value as ThemePreference })}
      >
        <option value="system">{U.themeSystem}</option>
        <option value="light">{U.themeLight}</option>
        <option value="dark">{U.themeDark}</option>
      </select>
      <select
        className="tb-select"
        aria-label={U.viewport}
        title={U.viewport}
        value={app.viewport}
        onChange={(e) => cmd({ type: 'viewport', value: e.target.value as ViewportOption })}
      >
        <option value="auto">{U.vpAuto}</option>
        <option value="1280">{U.vpDesktop}</option>
        <option value="768">{U.vpTablet}</option>
        <option value="390">{U.vpPhone}</option>
      </select>
      <div className="zoom" role="group" aria-label={U.zoom}>
        <button className="tb-btn" title={U.zoomOutTip(mod)} aria-label={U.zoomOut} onClick={() => cmd({ type: 'zoom', dir: -1 })}>
          <IconMinus />
        </button>
        <button className="pct" title={U.zoomResetTip(mod)} aria-label={U.zoomPct(app.zoom)} onClick={() => cmd({ type: 'zoom', dir: 0 })}>
          {app.zoom}%
        </button>
        <FitLabel zoom={app.zoom} fit={app.fit} />
        <button className="tb-btn" title={U.zoomInTip(mod)} aria-label={U.zoomIn} onClick={() => cmd({ type: 'zoom', dir: 1 })}>
          <IconPlus />
        </button>
      </div>
    </div>
  )
}

/**
 * 「显示 N%」：面板挤压预览区时的实际显示比例（v0.7）。
 * 拖动面板时用外壳本地算出的值（v0.9.1），只有这一小块重渲染，松手后再以主进程状态为准。
 */
function FitLabel({ zoom, fit }: { zoom: number; fit: number }) {
  const dragFit = useStore((s) => s.dragFit)
  const shown = dragFit ?? fit
  if (shown >= 0.995) return null
  return (
    <span className="fit" title={U.fitTip}>
      {U.fit(Math.round(zoom * shown))}
    </span>
  )
}

function TabBar({ app }: { app: AppState }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 当前标签滚动到可见
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [app.activeId])

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = app.tabs.length
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n
      cmd({ type: 'activate', id: app.tabs[j].id })
      ;(listRef.current?.children[j] as HTMLElement | undefined)?.focus()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      cmd({ type: 'close', id: app.tabs[i].id })
    }
  }

  return (
    <div className="tabbar">
      <div className="tabs" role="tablist" aria-label={U.tabs} ref={listRef}>
        {app.tabs.map((t, i) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === app.activeId}
            tabIndex={t.id === app.activeId ? 0 : -1}
            className={`tab${over === i && dragFrom !== null && dragFrom !== i ? ' drop-before' : ''}`}
            title={t.path ?? t.name}
            draggable
            onDragStart={(e) => {
              setDragFrom(i)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('application/x-hw-tab', String(i))
            }}
            onDragOver={(e) => {
              if (dragFrom === null) return
              e.preventDefault()
              setOver(i)
            }}
            onDrop={(e) => {
              if (dragFrom === null) return
              e.preventDefault()
              e.stopPropagation()
              cmd({ type: 'reorder', from: dragFrom, to: i })
              setDragFrom(null)
              setOver(null)
            }}
            onDragEnd={() => {
              setDragFrom(null)
              setOver(null)
            }}
            onMouseDown={(e) => {
              if (e.button === 0) cmd({ type: 'activate', id: t.id })
            }}
            onAuxClick={(e) => {
              if (e.button === 1) cmd({ type: 'close', id: t.id })
            }}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.dirty && <span className="dot" aria-label={U.unsaved} />}
            <span className="name">{middleEllipsis(t.name)}</span>
            {t.readOnly && <span className="badge">{U.readOnly}</span>}
            <button
              className="close"
              tabIndex={-1}
              aria-label={U.closeTabOf(t.name)}
              title={U.closeTab}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => cmd({ type: 'close', id: t.id })}
            >
              <IconClose />
            </button>
          </div>
        ))}
      </div>
      <button className="newtab" aria-label={U.newDoc} title={U.newDocTip(app.isMac ? 'Cmd' : 'Ctrl')} onClick={() => cmd({ type: 'new' })}>
        <IconPlus />
      </button>
      {/* 焦点顺序：工具栏 → 标签栏 → 预览区（11.2） */}
      <div className="skip" tabIndex={app.activeId ? 0 : -1} aria-label={U.skipToPage} onFocus={() => cmd({ type: 'focusPreview' })} />
    </div>
  )
}

function Banner() {
  return (
    <div className="banner" role="status">
      <span className="msg">{BANNER.text}</span>
      <button className="primary" onClick={() => cmd({ type: 'grantRoot' })}>
        {U.chooseFolder}
      </button>
      <button onClick={() => cmd({ type: 'dismissBanner' })}>{U.ignore}</button>
      <button className="x" aria-label={U.closeBanner} onClick={() => cmd({ type: 'dismissBanner' })}>
        <IconClose />
      </button>
    </div>
  )
}

/** 属性面板的默认宽度：面板不宽于它时页面照常排版；拉得更宽时页面按比例缩小，不重新排版（v0.7） */
export { PANEL_BASE } from './preview-layout'

function Preview({ app, active }: { app: AppState; active: TabSummary | null }) {
  const ref = useRef<HTMLDivElement>(null)
  // 面板开着时，页面的排版宽度按「主区宽度 − 默认面板宽度」算；面板拉宽只缩放，不挤乱页面
  const reserve = active && active.mode === 'edit' && app.panelOpen ? PANEL_BASE : 0
  const reportRef = useRef<() => void>(() => {})
  const freeze = useStore((s) => s.freeze)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => {
      // 冻结拖动中：实时页面被隐藏了，位置由松手时的 thaw 统一应用
      if (useStore.getState().freeze) return
      const r = previewRect()
      if (r) window.hw.setRect(r)
    }
    reportRef.current = report
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])
  useLayoutEffect(() => reportRef.current(), [reserve])
  const toast = useStore((s) => s.toast)
  return (
    <div className="preview" ref={ref}>
      {!active && <EmptyState app={app} />}
      {!active && toast && <ShellToast />}
      {/* 拖动面板时的冻结画面（v0.9.1）：宽度跟着预览区走，缩放由 CSS 完成，外壳一帧一行 */}
      {freeze && (
        <div className="freeze" style={{ background: freeze.bg }} aria-hidden="true">
          <div className="freeze-view" style={app.viewport === 'auto' ? undefined : { width: `min(100%, ${app.viewport}px)` }}>
            <img src={freeze.url} alt="" draggable={false} />
          </div>
        </div>
      )}
    </div>
  )
}

function ShellToast() {
  const toast = useStore((s) => s.toast)!
  const hide = useStore((s) => s.hideToast)
  // 到时消失由 store 负责；这里只处理 Esc
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [hide])
  return (
    <div className={`toast${toast.level === 'info' ? '' : ` ${toast.level}`}`} onClick={hide}>
      {toast.text}
      {toast.sub && <span className="sub">{toast.sub}</span>}
    </div>
  )
}

function EmptyState({ app }: { app: AppState }) {
  const recent = app.recent.slice(0, 5)
  return (
    <div className="empty">
      <div className="card">
        <h1>{U.emptyTitle}</h1>
        <p className="sub">{U.emptySub}</p>
        <div className="actions">
          <button className="btn primary" autoFocus onClick={() => cmd({ type: 'open' })}>
            {U.openFile}
          </button>
          <button className="btn" onClick={() => cmd({ type: 'new' })}>
            {U.newDoc}
          </button>
          <button className="btn" onClick={() => cmd({ type: 'sample' })}>
            {U.loadSample}
          </button>
        </div>
        <div className="hint">{U.dropHint}</div>
        {recent.length > 0 && (
          <div className="recent">
            <h2>{U.recent}</h2>
            {recent.map((r) => (
              <button key={r.path} className={r.exists ? '' : 'gone'} title={r.path} onClick={() => cmd({ type: 'openRecent', path: r.path })}>
                <span className="fn">{r.name}</span>
                <span className="dir">{r.dir}</span>
                {!r.exists && <span className="tag">{U.recentGone}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function shortenPath(p: string, max = 80): string {
  if (p.length <= max) return p
  const head = Math.ceil((max - 1) / 3)
  return `${p.slice(0, head)}…${p.slice(p.length - (max - 1 - head))}`
}

/** 层级很深时只显示开头与最后几层，中间折叠成「…」（悬停看完整路径）。 */
const CRUMB_TAIL = 4

function StatusBar({ app, active }: { app: AppState; active: TabSummary | null }) {
  const key: HintKey = !active
    ? 'none'
    : active.readOnly
      ? 'readonly'
      : active.mode === 'preview'
        ? 'preview'
        : app.editing
          ? 'editing'
          : app.selection
            ? 'selected'
            : 'select'
  const hints = hintItems(key, app.isMac, active?.readOnlyKind)
  const crumb = active && app.hover ? app.hover : null
  const pathText = active ? (active.path ?? (active.isSample ? U.samplePath : U.newPath)) : ''
  const save = !active ? '' : active.readOnly ? U.readOnly : active.dirty ? U.unsaved : U.saved
  const segs = crumb ? crumb.breadcrumb.map((seg, i) => ({ seg, i })) : []
  const shown = segs.length > CRUMB_TAIL + 1 ? [segs[0], null, ...segs.slice(-CRUMB_TAIL)] : segs
  return (
    <div className="statusbar" role="status">
      <div className="left">
        {crumb ? (
          <span className="crumb" title={crumb.fullSelector}>
            {shown.map((s, j) => {
              if (!s) {
                return (
                  <span key="more" className="more" title={crumb.breadcrumb.join(' › ')}>
                    <span className="sep">›</span>…
                  </span>
                )
              }
              const eid = crumb.eids?.[s.i]
              return (
                <span key={s.i} title={crumb.selectors[s.i] ?? crumb.fullSelector}>
                  {j > 0 && <span className="sep">›</span>}
                  {eid !== null && eid !== undefined ? (
                    <button className="seg-link" onClick={() => cmd({ type: 'selectEid', eid })}>
                      {s.seg}
                    </button>
                  ) : (
                    s.seg
                  )}
                </span>
              )
            })}
            {app.selection?.index && app.selection.siblings && app.selection.eid === crumb.eids?.[crumb.eids.length - 1] ? (
              <span className="level">{U.nth(app.selection.index, app.selection.siblings)}</span>
            ) : null}
          </span>
        ) : (
          <span title={pathText}>{shortenPath(pathText)}</span>
        )}
      </div>
      {active && app.selection && !app.selection.multi && app.selection.range && (
        <button className="copy-src" title={U.copySourceTip} onClick={() => cmd({ type: 'copySource', eid: app.selection!.eid })}>
          {U.copySource}
        </button>
      )}
      <div className="center">
        {app.statusNote ? (
          <span className="note">{app.statusNote}</span>
        ) : (
          // 一行放不下的提示整条换到第二行并被裁掉，不会出现半截；完整列表按 F1
          <span className="hints" aria-label={hintText(key, app.isMac, active?.readOnlyKind)}>
            {hints.map((h, i) => (
              <span key={i} className="hint">
                {h.k && <kbd>{h.k}</kbd>}
                {h.t}
              </span>
            ))}
          </span>
        )}
        {active && app.extFail && <span className="warn">{BANNER.extFail}</span>}
        {active && app.assetsMissing && <span className="warn">{BANNER.assetsMissing}</span>}
      </div>
      {active && !active.readOnly && app.changeCount > 0 && (
        <button className="changes-btn" title={U.changesBtnTip} onClick={() => openChanges(app, active)}>
          {U.changesBtn(app.changeCount)}
        </button>
      )}
      <div className="right">
        <span className={active?.dirty ? 'dirty' : ''}>{save}</span>
      </div>
      <button className="keys" title={U.shortcutsTip} aria-label={U.shortcuts} onClick={() => cmd({ type: 'shortcuts' })}>
        ⌨
      </button>
    </div>
  )
}

/** 状态栏「N 处改动」：切到编辑模式、打开属性面板并停在「改动」页（v0.10） */
function openChanges(app: AppState, active: TabSummary): void {
  if (active.mode !== 'edit') cmd({ type: 'mode', mode: 'edit' })
  if (!app.panelOpen) cmd({ type: 'panel', open: true })
  useStore.getState().setPanelView('changes')
}

/** toast 与气泡文字的读屏播报（11.3）。 */
function LiveRegion() {
  const toast = useStore((s) => s.toast)
  const note = useStore((s) => s.app?.statusNote)
  return (
    <>
      <div className="sr-only" aria-live="polite">
        {/* key 随每条 toast 变化：相同文字再次出现时也会重新播报 */}
        {toast && toast.level !== 'error' && <span key={toast.key}>{`${toast.text}${toast.sub ? `${U.listSep}${toast.sub}` : ''}`}</span>}
      </div>
      <div className="sr-only" aria-live="assertive">
        {toast && toast.level === 'error' && <span key={toast.key}>{toast.text}</span>}
      </div>
      <div className="sr-only" aria-live="polite">
        {note ?? ''}
      </div>
    </>
  )
}
