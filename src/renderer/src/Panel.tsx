// 属性面板（规格 20.3）：右侧默认 280px，可收起、可拖动左边缘调宽（v0.7）；改动即时写成补丁。作用域只有「仅此元素」。
import { useCallback, useLayoutEffect, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { AppState, FreezeShot, SelectionInfo, StructOp } from '../../shared/types'
import { getDecl } from '../../shared/style-attr'
import { isPlainNumber, SVG_KINDS, svgFields, type SvgItem, type SvgModel } from '../../shared/svg'
import { cmd, useStore } from './store'
import { ATTR_GROUP, ATTR_TEXT, SVG_FIELD_LABEL, U, type AttrGroup, type AttrMeta, type AttrText } from './strings'
import { tokenizeHtml } from '../../shared/html-tokens'
import { previewLayout, previewRect } from './preview-layout'
import { IconAlign, IconClose, IconReset } from './components/icons'

const op = (o: StructOp): void => cmd({ type: 'op', op: o })

/** rgb(a) → #rrggbb；透明返回空串。 */
export function toHex(c: string): string {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c)
  if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c : ''
  if (m[4] !== undefined && Number(m[4]) === 0) return ''
  return `#${[m[1], m[2], m[3]].map((x) => Math.round(Number(x)).toString(16).padStart(2, '0')).join('')}`
}

function Row({ label, children, reset, onReset }: { label: string; children: React.ReactNode; reset: boolean; onReset: () => void }) {
  return (
    <div className="row">
      <label>{label}</label>
      {children}
      <button className="reset" disabled={!reset} title={U.resetTip} aria-label={`${U.reset} ${label}`} onClick={onReset}>
        <IconReset />
      </button>
    </div>
  )
}

/** 失焦或回车时才提交的文本框（避免每个字符都产生一次补丁）。 */
function LazyInput({ value, onCommit, placeholder, label, type = 'text' }: { value: string; onCommit: (v: string) => void; placeholder?: string; label: string; type?: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => v !== value && onCommit(v)
  return (
    <input
      type={type}
      aria-label={label}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setV(value)
      }}
    />
  )
}

function StyleSection({ sel }: { sel: SelectionInfo }) {
  const inline = (p: string) => getDecl(sel.style, p)
  const set = (props: Record<string, string | null>) => op({ type: 'setStyle', eid: sel.eid, props })
  const color = inline('color') ?? toHex(sel.computed.color)
  const bg = inline('background-color') ?? toHex(sel.computed.backgroundColor)
  const fontSize = parseFloat(inline('font-size') ?? sel.computed.fontSize) || 16
  const lh = inline('line-height') ?? (sel.computed.lineHeight === 'normal' ? '' : (parseFloat(sel.computed.lineHeight) / (parseFloat(sel.computed.fontSize) || 16)).toFixed(2))
  const align = inline('text-align') ?? sel.computed.textAlign
  // 关键字也要认：bold 是 700、normal 是 400；列表里没有的数值（如 900）临时加一项，不显示成别的字重
  const rawWeight = inline('font-weight') ?? sel.computed.fontWeight
  const parsedWeight = rawWeight === 'bold' ? 700 : rawWeight === 'normal' ? 400 : Number(rawWeight)
  const weight = String(Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : Number(sel.computed.fontWeight) || 400)
  const weights = [...new Set(['300', '400', '500', '600', '700', '800', weight])].sort((a, b) => Number(a) - Number(b))
  const padding = inline('padding') ?? sel.computed.padding ?? ''
  const radius = inline('border-radius') ?? sel.computed.borderRadius ?? ''
  const offset = inline('left') !== null || inline('top') !== null
  const size = inline('width') !== null || inline('height') !== null
  return (
    <section>
      <h3>{U.style} <span className="scope">{U.onlyThis}</span></h3>
      <Row label={U.textColor} reset={inline('color') !== null} onReset={() => set({ color: null })}>
        <input type="color" aria-label={U.textColor} value={toHex(color) || '#000000'} onChange={(e) => set({ color: e.target.value })} />
      </Row>
      <Row label={U.bgColor} reset={inline('background-color') !== null} onReset={() => set({ 'background-color': null })}>
        <input type="color" aria-label={U.bgColor} value={toHex(bg) || '#ffffff'} onChange={(e) => set({ 'background-color': e.target.value })} />
      </Row>
      <Row label={U.fontSize} reset={inline('font-size') !== null} onReset={() => set({ 'font-size': null })}>
        <LazyInput type="number" label={U.fontSizePx} value={String(Math.round(fontSize))} onCommit={(v) => Number(v) > 0 && set({ 'font-size': `${Number(v)}px` })} />
      </Row>
      <Row label={U.fontWeight} reset={inline('font-weight') !== null} onReset={() => set({ 'font-weight': null })}>
        <select aria-label={U.fontWeight} value={weight} onChange={(e) => set({ 'font-weight': e.target.value })}>
          {weights.map((w) => (
            <option key={w} value={w}>
              {U.weightName(w)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={U.lineHeight} reset={inline('line-height') !== null} onReset={() => set({ 'line-height': null })}>
        <LazyInput type="number" label={U.lineHeightX} value={lh} placeholder={U.normal} onCommit={(v) => Number(v) > 0 && set({ 'line-height': String(Number(v)) })} />
      </Row>
      <Row label={U.align} reset={inline('text-align') !== null} onReset={() => set({ 'text-align': null })}>
        <span className="align" role="group" aria-label={U.align}>
          {(
            [
              ['left', U.alignLeft],
              ['center', U.alignCenter],
              ['right', U.alignRight],
              ['justify', U.alignJustify]
            ] as const
          ).map(([v, t]) => (
            <button key={v} aria-label={t} title={t} aria-pressed={align === v || (v === 'left' && align === 'start')} onClick={() => set({ 'text-align': v })}>
              <IconAlign kind={v} />
            </button>
          ))}
        </span>
      </Row>
      <Row label={U.padding} reset={inline('padding') !== null} onReset={() => set({ padding: null })}>
        <LazyInput label={U.padding} value={padding} placeholder="0" onCommit={(v) => set({ padding: v.trim() || null })} />
      </Row>
      <Row label={U.radius} reset={inline('border-radius') !== null} onReset={() => set({ 'border-radius': null })}>
        <LazyInput label={U.radius} value={radius} placeholder="0" onCommit={(v) => set({ 'border-radius': v.trim() || null })} />
      </Row>
      <div className="actions">
        <button disabled={!offset} title={U.resetPosTip} onClick={() => set({ position: null, left: null, top: null })}>
          {U.resetPos}
        </button>
        <button disabled={!size} title={U.resetSizeTip} onClick={() => set({ width: null, height: null, 'flex-grow': null, 'flex-shrink': null, 'flex-basis': null })}>
          {U.resetSize}
        </button>
        <button disabled={!sel.style} title={U.clearStyleTip} onClick={() => op({ type: 'setAttr', eid: sel.eid, name: 'style', value: null })}>
          {U.clearStyle}
        </button>
      </div>
    </section>
  )
}

/** 属性的显示名、说明与分组（文案在 strings.ts）；不认识的属性按原名放进「高级」 */
const attrMeta = (n: string): AttrMeta => ({ ...((ATTR_TEXT[n] as AttrText | undefined) ?? { label: n }), group: ATTR_GROUP[n] ?? 'adv' })
const GROUPS: { key: AttrGroup; title: () => string; open: boolean }[] = [
  { key: 'link', title: () => U.groupAttrs, open: true },
  { key: 'look', title: () => U.groupLook, open: true },
  { key: 'box', title: () => U.groupBox, open: true },
  { key: 'adv', title: () => U.groupAdv, open: false }
]

function Help({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="help" aria-label={U.help} aria-expanded={open} aria-controls={id} title={text} onClick={() => setOpen(!open)}>
        ?
      </button>
      {open && (
        <div className="help-text" id={id} role="note">
          {text}
        </div>
      )}
    </>
  )
}

function AttrRow({ sel, n }: { sel: SelectionInfo; n: string }) {
  const m = attrMeta(n)
  const set = (v: string) => op({ type: 'setAttr', eid: sel.eid, name: n, value: v === '' && n !== 'alt' ? null : v })
  const v = sel.attrs[n]
  const color = (n === 'fill' || n === 'stroke') && /^#[0-9a-f]{6}$/i.test(v || '#000000')
  return (
    <div className="attr">
      <div className="row">
        <label title={n}>{m.label}</label>
        {color ? (
          <span className="color-pair">
            <input type="color" aria-label={`${m.label}`} value={v || '#000000'} onChange={(e) => set(e.target.value)} />
            <LazyInput label={U.named(m.label, n)} value={v} placeholder={m.ph} onCommit={set} />
          </span>
        ) : (
          <LazyInput label={U.named(m.label, n)} value={v} placeholder={m.ph} onCommit={set} />
        )}
        {m.help ? <Help id={`help-${sel.eid}-${n}`} text={m.help} /> : <span />}
      </div>
    </div>
  )
}

function AttrSection({ sel, only }: { sel: SelectionInfo; only?: AttrGroup[] }) {
  const names = Object.keys(sel.attrs)
  if (!names.length) return null
  return (
    <>
      {GROUPS.filter((g) => !only || only.includes(g.key)).map((g) => {
        const list = names.filter((n) => attrMeta(n).group === g.key)
        if (!list.length) return null
        const title = g.key === 'link' && sel.svg ? U.groupAttrs : g.title()
        return (
          <section key={g.key} className="attrs">
            <details open={g.open}>
              <summary>
                <h3>
                  {title}
                  {g.key === 'box' && sel.svg && <span className="scope">{U.canvasCoords}</span>}
                </h3>
              </summary>
              {list.map((n) => (
                <AttrRow key={n} sel={sel} n={n} />
              ))}
            </details>
          </section>
        )
      })}
    </>
  )
}

/**
 * 输入时实时预览、失焦或回车才提交的输入框（v0.7 SVG 面板）。
 * onLive(v) 只改预览；onLive(null) 还原预览；onCommit(v) 写成一次补丁（一步撤销）。
 */
function LiveInput({
  value,
  label,
  placeholder,
  numeric,
  onLive,
  onCommit,
  className
}: {
  value: string
  label: string
  placeholder?: string
  numeric?: boolean
  onLive: (v: string | null) => void
  onCommit: (v: string) => void
  className?: string
}) {
  const [v, setV] = useState(value)
  const live = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!live.current) setV(value)
  }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  const change = (next: string) => {
    setV(next)
    live.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onLive(next), 40)
  }
  const commit = () => {
    clearTimeout(timer.current)
    if (!live.current) return
    live.current = false
    if (v === value) onLive(null)
    else onCommit(v)
  }
  const cancel = () => {
    clearTimeout(timer.current)
    live.current = false
    setV(value)
    onLive(null)
  }
  // 数字值：用数字框，方向键 ±1、Shift+方向键 ±10；带单位或百分比的值保持文本框
  const num = numeric && (v === '' || isPlainNumber(v))
  return (
    <input
      type={num ? 'number' : 'text'}
      className={className}
      aria-label={label}
      value={v}
      placeholder={placeholder}
      step="any"
      onChange={(e) => change(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (num && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)
          const n = Number(v || '0') + d
          change(String(Math.round(n * 1000) / 1000))
        }
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancel()
        }
      }}
    />
  )
}

/** 取色器：拖动中只预览（input 事件），松手才提交（原生 change 事件；React 的 onChange 在拖动中每次都会触发）。 */
function ColorInput({ value, label, onLive, onCommit }: { value: string; label: string; onLive: (v: string) => void; onCommit: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fn = () => commitRef.current(el.value)
    el.addEventListener('change', fn)
    return () => el.removeEventListener('change', fn)
  }, [])
  return <input ref={ref} type="color" aria-label={label} defaultValue={value} key={value} onInput={(e) => onLive((e.target as HTMLInputElement).value)} />
}

/** 一个 SVG 属性：颜色属性带取色器，数字属性用数字框；输入即预览，失焦写回。 */
function SvgField({ item, name }: { item: SvgItem; name: string }) {
  const v = item.attrs[name] ?? ''
  const label = SVG_FIELD_LABEL[name] ?? name
  const live = (value: string | null) => cmd({ type: 'svgLive', eid: item.eid, name, value })
  const commit = (value: string) => op({ type: 'setAttr', eid: item.eid, name, value: value === '' ? null : value })
  const color = (name === 'fill' || name === 'stroke') && /^#[0-9a-f]{6}$/i.test(v || '#000000')
  if (name === 'text-anchor') {
    return (
      <label className="svg-field">
        <span>{label}</span>
        <select aria-label={U.named(label, name)} value={v} onChange={(e) => commit(e.target.value)}>
          <option value="">{U.anchorDefault}</option>
          <option value="start">{U.anchorStart}</option>
          <option value="middle">{U.anchorMiddle}</option>
          <option value="end">{U.anchorEnd}</option>
        </select>
      </label>
    )
  }
  return (
    <label className="svg-field" title={name}>
      <span>{label}</span>
      {color ? (
        <span className="color-pair">
          <ColorInput label={label} value={v || '#000000'} onLive={live} onCommit={commit} />
          <LiveInput label={U.named(label, name)} value={v} placeholder={U.noneValue} onLive={live} onCommit={commit} />
        </span>
      ) : (
        <LiveInput label={U.named(label, name)} value={v} numeric={name !== 'fill' && name !== 'stroke'} placeholder="—" onLive={live} onCommit={commit} />
      )}
    </label>
  )
}

/** 一个 SVG 元素：标题行（种类、id、颜色或文字摘要），展开后是它的文字与属性表单。 */
function SvgRow({ item, open, onToggle }: { item: SvgItem; open: boolean; onToggle: () => void }) {
  const f = svgFields(item.tag)
  const kind = SVG_KINDS[item.tag] ?? item.tag
  const swatch = item.attrs.fill || item.attrs.stroke
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [open])
  return (
    <div className={`svg-row${open ? ' open' : ''}`} ref={ref} style={{ marginLeft: Math.min(item.depth, 4) * 10 }} onMouseEnter={() => cmd({ type: 'peekEid', eid: item.eid })} onMouseLeave={() => cmd({ type: 'peekEid', eid: null })}>
      <div className="svg-head">
        <button className="svg-pick" aria-expanded={open} title={U.svgPickTip} onClick={onToggle}>
          <span className="caret" aria-hidden="true">▸</span>
          <span className="kind">{kind}</span>
          {item.id && <span className="id">#{item.id}</span>}
          {!item.text && swatch && /^#|^rgb|^[a-z]+$/i.test(swatch) && swatch !== 'none' && <span className="swatch" style={{ background: swatch }} aria-hidden="true" />}
        </button>
      </div>
      {item.text && (
        <LiveInput
          className="svg-text"
          label={U.svgTextOf(`${kind}${item.id ? ` ${item.id}` : ''}`)}
          value={item.text.value}
          placeholder={U.empty}
          onLive={(value) => cmd({ type: 'svgLive', eid: item.eid, slot: item.text!.slot, value })}
          onCommit={(value) => cmd({ type: 'svgText', eid: item.eid, slot: item.text!.slot, value })}
        />
      )}
      {open && (
        <div className="svg-fields">
          {f.geo.map((n) => (
            <SvgField key={n} item={item} name={n} />
          ))}
          {f.look.map((n) => (
            <SvgField key={n} item={item} name={n} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * SVG 内容（v0.7）：把 svg 里的文字和形状列成表单，只露出文字、位置、大小、颜色这些改了不会弄坏图形的东西。
 * 输入即在页面上实时预览，失焦或回车写回源码（一步撤销），Esc 放弃。路径数据、变换等藏在「高级」与源码里。
 */
function SvgContent({ model, sel }: { model: SvgModel; sel: SelectionInfo }) {
  const [open, setOpen] = useState<number | null>(sel.svg === 'child' ? sel.eid : null)
  useEffect(() => {
    if (sel.svg === 'child') setOpen(sel.eid)
  }, [sel.eid, sel.svg])
  const texts = model.items.filter((i) => i.text)
  const shapes = model.items.filter((i) => !i.text)
  const toggle = (eid: number) => {
    if (open === eid) return setOpen(null)
    setOpen(eid)
    if (sel.eid !== eid) cmd({ type: 'selectEid', eid })
  }
  if (!model.items.length) return null
  return (
    <section className="svg-content" aria-label={U.svgContent}>
      <h3>
        {U.svgContent} <span className="scope">{U.svgContentHint}</span>
      </h3>
      {texts.length > 0 && (
        <div className="svg-group">
          <div className="svg-group-title">{U.svgTexts(texts.length)}</div>
          {texts.map((it) => (
            <SvgRow key={it.eid} item={it} open={open === it.eid} onToggle={() => toggle(it.eid)} />
          ))}
        </div>
      )}
      {shapes.length > 0 && (
        <div className="svg-group">
          <div className="svg-group-title">{U.svgShapes(shapes.length)}</div>
          {shapes.map((it) => (
            <SvgRow key={it.eid} item={it} open={open === it.eid} onToggle={() => toggle(it.eid)} />
          ))}
        </div>
      )}
      {model.more > 0 && <div className="hint-line">{U.svgMore(model.more)}</div>}
    </section>
  )
}

/**
 * SVG 源码（v0.6；v0.7 起默认收起）：直接改原文风险大，用户主动点开才显示。
 * 输入时实时渲染，失焦或 Cmd/Ctrl+Enter 写回，Esc 放弃；提交前校验外层仍是单个 svg。
 */
function SvgSource({ src, isMac }: { src: { eid: number; html: string }; isMac: boolean }) {
  const [shown, setShown] = useState(false)
  const [v, setV] = useState(src.html)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (!dirty.current) setV(src.html)
  }, [src.html])
  const preview = (html: string | null) => cmd({ type: 'sourcePreview', eid: src.eid, html })
  const apply = () => {
    clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    cmd({ type: 'sourceApply', eid: src.eid, html: v })
  }
  const cancel = () => {
    clearTimeout(timer.current)
    dirty.current = false
    setV(src.html)
    preview(null)
  }
  const mod = isMac ? 'Cmd' : 'Ctrl'
  if (!shown) {
    return (
      <section className="svg-source-closed">
        <div className="actions">
          <button title={U.editSvgSourceTip} onClick={() => setShown(true)}>
            {U.editSvgSource}
          </button>
          <button title={U.copySvgSourceTip} onClick={() => cmd({ type: 'copySource', eid: src.eid })}>
            {U.copySvgSource}
          </button>
        </div>
      </section>
    )
  }
  return (
    <section>
      <h3>
        {U.svgSource} <span className="scope">{U.advanced}</span>
        <button
          className="link"
          onClick={() => {
            if (dirty.current) cancel()
            setShown(false)
          }}
        >
          {U.collapse}
        </button>
      </h3>
      <div className="hint-line warn">{U.svgSourceWarn}</div>
      <textarea
        className="svg-src"
        aria-label={U.svgSource}
        spellCheck={false}
        autoFocus
        value={v}
        onChange={(e) => {
          dirty.current = true
          setV(e.target.value)
          const html = e.target.value
          clearTimeout(timer.current)
          timer.current = setTimeout(() => preview(html), 120)
        }}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault()
            apply()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
      />
      <div className="hint-line">{U.sourceKeys(mod)}</div>
    </section>
  )
}

/** 「插入…」菜单（v0.7）：点开才列出选项，每项说明会发生什么。插入位置都是选中元素之后。 */
function InsertMenu({ app, disabled }: { app: AppState; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open])
  const saved = !!app.tabs.find((t) => t.id === app.activeId)?.path
  const run = (c: Parameters<typeof cmd>[0]) => {
    setOpen(false)
    cmd(c)
  }
  const items: { label: string; sub: string; off?: boolean; run: () => void }[] = [
    {
      label: U.insertMedia,
      sub: saved ? U.insertMediaSub : U.insertMediaNeedSave,
      off: !saved,
      run: () => run({ type: 'insertMedia', kind: 'auto' })
    },
    {
      label: U.pasteEl,
      sub: app.clip ? U.pasteElSub : U.pasteElNone,
      off: !app.clip,
      run: () => run({ type: 'pasteElement' })
    },
    {
      label: U.importBody,
      sub: U.importBodySub,
      run: () => run({ type: 'importFragment' })
    }
  ]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
      ref.current?.querySelector<HTMLButtonElement>('.insert-btn')?.focus()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      const i = list.indexOf(document.activeElement as HTMLButtonElement)
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
    }
  }
  return (
    <div className="insert" ref={ref} onKeyDown={onKey}>
      <button className="insert-btn" disabled={disabled} aria-haspopup="menu" aria-expanded={open} title={U.insertAfterTip} onClick={() => setOpen(!open)}>
        {U.insertAfter}
      </button>
      {open && (
        <div className="menu" role="menu" aria-label={U.insertAfterMenu}>
          {items.map((it) => (
            <button key={it.label} role="menuitem" disabled={it.off} onClick={it.run}>
              <span className="mi-label">{it.label}</span>
              <span className="mi-sub">{it.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MultiSection({ sel }: { sel: SelectionInfo }) {
  const eids = sel.multi!
  const batch = (type: 'delete' | 'duplicate') => op({ type: 'batch', ops: eids.map((eid) => ({ type, eid })) })
  return (
    <section>
      <div className="meta">{U.multiSelected(eids.length)}</div>
      <div className="actions spaced">
        <button onClick={() => batch('duplicate')}>{U.duplicateEach}</button>
        <button className="danger" onClick={() => batch('delete')}>{U.deleteAll}</button>
      </div>
      <div className="hint-line">{U.multiHint}</div>
    </section>
  )
}

/**
 * 本次改动（v0.10）：相对上次保存，逐处列出改了什么。点一条在页面上选中那里；「撤回」只退回这一处。
 * 顶部的统计把「保存时只改动被改的字符」摆出来：多少字符里有多少原样保留。
 */
function ChangesSection({ selected }: { selected: number | null }) {
  const view = useStore((s) => s.changes)
  const markGoto = useStore((s) => s.markGoto)
  if (!view) return null
  const { summary: sum, items, more } = view
  if (!sum.count) {
    return (
      <section className="changes empty-changes">
        <div className="ch-none">{U.chNone}</div>
        <div className="hint-line">{U.chNoneSub}</div>
      </section>
    )
  }
  return (
    <section className="changes">
      <div className="ch-summary">
        <strong>{U.chCount(sum.count)}</strong>
        <div>{U.chUntouched(sum.untouched, sum.total)}</div>
        <div className="ch-detail">{U.chDetail(sum.removed, sum.added, sum.moved)}</div>
      </div>
      <ol className="ch-list" aria-label={U.chList}>
        {items.map((it, i) => (
          <li key={i} className={`ch-item k-${it.kind}`}>
            <button
              className="ch-goto"
              title={U.chGotoTip}
              disabled={it.eid === null}
              onClick={() => {
                if (it.eid !== null && it.eid !== selected) markGoto(it.eid)
                cmd({ type: 'gotoChange', index: i, version: view.version })
              }}
            >
              <span className="ch-meta">
                <span className="ch-kind">{U.chKind[it.kind]}</span>
                {it.where && <code>{it.where}</code>}
                <span>{U.chLine(it.line)}</span>
              </span>
              <span className="ch-text">
                {it.ctxBefore && <span className="ctx">{it.ctxBefore}</span>}
                {it.kind !== 'insert' && it.kind !== 'move' && <del>{it.before}</del>}
                {it.kind !== 'delete' && <ins>{it.after}</ins>}
                {it.ctxAfter && <span className="ctx">{it.ctxAfter}</span>}
              </span>
            </button>
            {it.canRevert && (
              <button className="ch-revert" title={U.chRevertTip} onClick={() => cmd({ type: 'revertChange', index: i, version: view.version })}>
                {U.chRevert}
              </button>
            )}
          </li>
        ))}
      </ol>
      {more > 0 && <div className="hint-line">{U.chMore(more)}</div>}
    </section>
  )
}

/**
 * 源码编辑（v0.10，任意元素）：编辑器占满整个面板；输入时在页面上实时预览，「应用」或 Cmd/Ctrl+Enter 写成一次补丁，
 * 「取消」或 Esc 还原预览。着色层与输入框逐字对齐（同字体同排版，滚动同步），输入框本身文字透明。
 */
function SourceEditor({ eid, label, initial, isMac, onClose }: { eid: number; label: string; initial: string; isMac: boolean; onClose: () => void }) {
  const [v, setV] = useState(initial)
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const pre = useRef<HTMLPreElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const changed = useRef(false)
  /** 已经写入或已经还原：卸载时不必再还原预览 */
  const settled = useRef(false)
  useEffect(() => {
    ta.current?.focus()
    // 没有「应用」也没有「取消」就被卸载（切到改动页、关掉面板、切到预览模式）：还原页面上的临时预览，
    // 否则页面停在没有 data-hw 标注的临时节点上，与源码对不上
    return () => {
      clearTimeout(timer.current)
      if (changed.current && !settled.current) cmd({ type: 'sourcePreview', eid, html: null })
    }
  }, [eid])
  const cancel = () => {
    clearTimeout(timer.current)
    if (changed.current) cmd({ type: 'sourcePreview', eid, html: null })
    settled.current = true
    onClose()
  }
  const apply = async () => {
    clearTimeout(timer.current)
    if (!changed.current || v === initial) return cancel()
    setBusy(true)
    const ok = await window.hw.sourceApply(eid, v)
    setBusy(false)
    // 失败时主进程已经还原预览并提示原因，编辑器留着让用户改
    if (ok) {
      settled.current = true
      onClose()
    }
  }
  const mod = isMac ? 'Cmd' : 'Ctrl'
  return (
    <section className="source-editor">
      <h3>
        {U.editSourceOf(label)} <span className="scope">{U.sourcePreviewHint}</span>
      </h3>
      <div className="code">
        <pre ref={pre} aria-hidden="true">
          {tokenizeHtml(v).map((t, i) => (t.k === 'text' ? t.s : <span key={i} className={`t-${t.k}`}>{t.s}</span>))}
          {/* 末尾换行在 pre 里不占行：补一个空格，让着色层与输入框一样高 */}
          {' '}
        </pre>
        <textarea
          ref={ta}
          aria-label={U.sourceOf(label)}
          spellCheck={false}
          value={v}
          onScroll={(e) => {
            if (pre.current) {
              pre.current.scrollTop = e.currentTarget.scrollTop
              pre.current.scrollLeft = e.currentTarget.scrollLeft
            }
          }}
          onChange={(e) => {
            changed.current = true
            const html = e.target.value
            setV(html)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => cmd({ type: 'sourcePreview', eid, html }), 150)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
              e.preventDefault()
              void apply()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
        />
      </div>
      <div className="actions spaced">
        <button className="primary" disabled={busy} onClick={() => void apply()}>
          {U.apply}
        </button>
        <button onClick={cancel}>{U.cancel}</button>
        <span className="hint-line">{U.sourceEditorKeys(mod)}</span>
      </div>
    </section>
  )
}

const PANEL_MIN = 240
const PANEL_MAX = 720

/** 正在拖动面板左边缘：冻结流程用它判断拖动还在不在（v0.9.1） */
let dragging = false
/** 第几次拖动：上一次拖动的收尾不能把这一次的画面清掉（松开后马上又按住手柄时会发生） */
let dragSeq = 0

const nextPaint = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

/**
 * 拖动开始：请主进程拍一张预览画面。页面够大时，拖动期间就显示这张图，
 * 由外壳按帧跟着面板缩放；页面很小则返回 null，继续走实时缩放。
 */
async function beginFreeze(): Promise<void> {
  const seq = dragSeq
  const alive = (): boolean => dragging && seq === dragSeq
  const shot: FreezeShot | null = await window.hw.freeze().catch(() => null)
  if (!shot) return
  if (!alive()) return void window.hw.thaw(previewRect() ?? undefined)
  // 先解码再上屏：隐藏实时视图的那一刻，屏幕上已经有这张图，不会闪一下空白
  try {
    const im = new Image()
    im.src = shot.url
    await im.decode()
  } catch {
    // 解码失败：不冻结，继续用实时页面（隐藏了视图却显示不出图，会是一片空白）
    return void window.hw.thaw(previewRect() ?? undefined)
  }
  if (!alive()) return void window.hw.thaw(previewRect() ?? undefined)
  flushSync(() => useStore.getState().setFreeze({ url: shot.url, bg: shot.bg }))
  await nextPaint()
  await nextPaint()
  if (!alive()) {
    useStore.getState().setFreeze(null)
    return void window.hw.thaw(previewRect() ?? undefined)
  }
  window.hw.freezeCommit()
}

/** 松手或拖动被打断：收起冻结画面，主进程按最终位置重排并换回实时页面。 */
function finishDrag(): void {
  if (!dragging) return
  dragging = false
  const seq = dragSeq
  const r = previewRect()
  void window.hw.thaw(r ?? undefined).finally(() => {
    // 收尾期间又开始了新的拖动：画面与比例归新一轮所有，不要清
    if (seq !== dragSeq) return
    useStore.getState().setFreeze(null)
    useStore.getState().setDragFit(null)
  })
}

/** 左边缘拖动调宽；拖动中只改本地宽度，松手才写设置。双击恢复默认宽度。键盘：← → 每次 16px。 */
function useResize(saved: number) {
  const [w, setW] = useState(saved)
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; w: number; live: number } | null>(null)
  useEffect(() => {
    if (!drag.current) setW(saved)
  }, [saved])
  // 拖动中若面板因别的状态更新重渲染（React 会用旧宽度盖回来），把实时宽度重新写上
  useLayoutEffect(() => {
    if (drag.current && host.current) host.current.style.width = `${drag.current.live}px`
  })
  useEffect(() => finishDrag, [])
  const clamp = (v: number) => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, v)))
  /** 拖动被打断（没收到 pointerup）：按当前拖动到的宽度落定，再把冻结收起来 */
  const stop = useCallback((): void => {
    const d = drag.current
    drag.current = null
    if (d) {
      setW(d.live)
      cmd({ type: 'panelWidth', width: d.live })
    }
    finishDrag()
  }, [])
  // 收不到松手的情况（指针捕获被系统拿走、窗口被最小化）也要收尾，否则预览一直停在冻结画面上。
  // 不在单纯的 blur 上收尾：指针还在面板上时窗口失焦是正常的，拖动应当继续。
  useEffect(() => {
    const end = (): void => stop()
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') stop()
    }
    // 放在冒泡阶段：手柄自己的 pointerup 先按精确位置落定，这里只是兜底
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [stop])
  /** 拖动中：直接改 DOM 宽度，只让工具栏那一行百分比跟着变，不重渲染整块面板（v0.9.1） */
  const live = (next: number) => {
    if (host.current) host.current.style.width = `${next}px`
    useStore.getState().setDragFit(previewLayout(next).fit)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w, live: w }
    dragging = true
    dragSeq++
    void beginFreeze()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    // 按键已经松开却没有收到 pointerup（窗口失焦、系统吞了事件）：按松手处理
    if (!dragging || e.buttons === 0) return stop()
    d.live = clamp(d.w + d.x - e.clientX)
    live(d.live)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const next = clamp(d.w + d.x - e.clientX)
    drag.current = null
    live(next)
    setW(next)
    cmd({ type: 'panelWidth', width: next })
    finishDrag()
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = clamp(w + (e.key === 'ArrowLeft' ? 16 : -16))
    setW(next)
    cmd({ type: 'panelWidth', width: next })
  }
  const onDoubleClick = () => {
    setW(280)
    cmd({ type: 'panelWidth', width: 280 })
  }
  return { w, host, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown, onDoubleClick } }
}

export function Panel({ app }: { app: AppState }) {
  const sel = app.selection
  const { w, host, handle } = useResize(app.panelWidth)
  const view = useStore((s) => s.panelView)
  const setView = useStore((s) => s.setPanelView)
  // 在页面上点选了别的元素：回到属性页（从改动列表点过去的不算，用户还在看列表）
  // 只看选中真的换了元素的时候：面板刚打开（比如从状态栏的「N 处改动」打开）不算；
  // 结构同步会先清掉选中再选回同一个元素（撤回一处之后就是这样），也不算——所以和上一个非空的选中比
  const eid = sel?.eid ?? null
  const lastEid = useRef(eid)
  useEffect(() => {
    if (eid === null) return
    const was = lastEid.current
    lastEid.current = eid
    if (eid === was) return
    if (useStore.getState().takeGoto(eid)) return
    if (useStore.getState().panelView === 'changes') setView('props')
  }, [eid, setView])
  // 主进程只在面板停在「改动」页时附带完整列表；面板关掉就不必再算
  useEffect(() => {
    cmd({ type: 'changesView', open: view === 'changes' })
  }, [view])
  useEffect(() => () => cmd({ type: 'changesView', open: false }), [])
  // 源码编辑器（v0.10）：打开时占满面板；在页面上选了别的元素就放弃并还原预览
  // 编辑器卸载时自己还原预览（见 SourceEditor）；这里只决定什么时候放弃：选了别的元素、切到改动页
  const [srcEdit, setSrcEdit] = useState<{ eid: number; html: string; label: string } | null>(null)
  useEffect(() => {
    if (srcEdit && (srcEdit.eid !== eid || view === 'changes')) setSrcEdit(null)
  }, [eid, srcEdit, view])
  const openSource = async () => {
    if (!sel) return
    const html = await window.hw.source(sel.eid)
    if (html !== null) setSrcEdit({ eid: sel.eid, html, label: `${sel.tag}${sel.id ? `#${sel.id}` : sel.cls ? `.${sel.cls.split(/\s+/)[0]}` : ''}` })
  }
  const saved = !!app.tabs.find((t) => t.id === app.activeId)?.path
  return (
    <div className="panel-host" ref={host} style={{ width: w }}>
      <div
        className="panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={U.resizePanel}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        aria-valuenow={w}
        tabIndex={0}
        title={U.resizePanelTip}
        {...handle}
      />
    <aside className="panel" aria-label={U.panelLabel}>
      <header>
        <div className="ptabs" role="tablist" aria-label={U.panelLabel}>
          <button role="tab" id="ptab-props" aria-controls="panel-body" aria-selected={view === 'props'} onClick={() => setView('props')}>
            {view === 'props' && sel ? <span className="tag">{`${sel.tag}${sel.id ? `#${sel.id}` : ''}`}</span> : U.tabProps}
          </button>
          <button role="tab" id="ptab-changes" aria-controls="panel-body" aria-selected={view === 'changes'} onClick={() => setView('changes')}>
            {U.tabChanges}
            {app.changeCount > 0 && <span className="count">{app.changeCount}</span>}
          </button>
        </div>
        <button aria-label={U.collapsePanel} title={U.collapseTip} onClick={() => cmd({ type: 'panel', open: false })}>
          <IconClose />
        </button>
      </header>
      <div role="tabpanel" id="panel-body" aria-labelledby={view === 'changes' ? 'ptab-changes' : 'ptab-props'}>
      {view === 'changes' ? (
        <ChangesSection selected={sel?.eid ?? null} />
      ) : srcEdit ? (
        <SourceEditor key={srcEdit.eid} eid={srcEdit.eid} label={srcEdit.label} initial={srcEdit.html} isMac={app.isMac} onClose={() => setSrcEdit(null)} />
      ) : !sel ? (
        <div className="empty-sel">{U.emptySel}</div>
      ) : sel.multi ? (
        <MultiSection sel={sel} />
      ) : (
        <>
          <section>
            <div className="meta">
              {sel.index && sel.siblings ? <span className="level" title={U.levelTip}>{U.nthShort(sel.index, sel.siblings)}</span> : null}
              {sel.width} × {sel.height}
              {sel.cls && <> · .{sel.cls.split(/\s+/).join(' .')}</>}
              {sel.component && U.component(sel.component)}
              {sel.slot && U.slot(sel.slot)}
            </div>
            {!sel.range && <div className="hint-line warn">{U.noEndTag}</div>}
            <div className="actions spaced">
              {sel.tag === 'img' && (
                <button className="primary" disabled={!saved} title={saved ? U.replaceImageTip : U.insertMediaNeedSave} onClick={() => cmd({ type: 'replaceImage', eid: sel.eid })}>
                  {U.replaceImage}
                </button>
              )}
              {!app.svgSource && (
                <button disabled={!sel.range} title={U.editSourceTip} onClick={() => void openSource()}>
                  {U.editSource}
                </button>
              )}
              <button disabled={!sel.range} title={U.copyForAiTip} onClick={() => cmd({ type: 'copyForAi', eid: sel.eid })}>
                {U.copyForAi}
              </button>
            </div>
            <div className="actions spaced">
              <button disabled={!sel.range} title={U.duplicateTip} onClick={() => op({ type: 'duplicate', eid: sel.eid })}>
                {U.duplicate}
              </button>
              <button disabled={!sel.range} title={U.copySourceTip} onClick={() => cmd({ type: 'copySource', eid: sel.eid })}>
                {U.copySource}
              </button>
              <InsertMenu app={app} disabled={!sel.range} />
              <button disabled={!sel.range} className="danger" onClick={() => op({ type: 'delete', eid: sel.eid })}>
                {U.delete}
              </button>
            </div>
          </section>
          {sel.svg !== 'child' && <StyleSection sel={sel} />}
          {app.svgModel && <SvgContent key={`svg-model-${app.svgModel.eid}`} model={app.svgModel} sel={sel} />}
          {/* SVG 内部元素的位置、颜色在上面的「SVG 内容」里改；这里只留不常用的高级属性 */}
          <AttrSection sel={sel} only={sel.svg === 'child' ? ['adv'] : undefined} />
          {app.svgSource && <SvgSource key={`svg-src-${app.svgSource.eid}`} src={app.svgSource} isMac={app.isMac} />}
        </>
      )}
      </div>
    </aside>
    </div>
  )
}
