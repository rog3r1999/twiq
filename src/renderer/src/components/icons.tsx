// 工具栏图标（线性，16px，跟随文字颜色）。
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const IconOpen = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...P} d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1Z" />
  </svg>
)
export const IconSave = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...P} d="M3 2.5h8l2.5 2.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z M5 2.5v3h5v-3 M5 13.5v-4h6v4" />
  </svg>
)
export const IconUndo = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...P} d="M5 3 2 6l3 3 M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />
  </svg>
)
export const IconRedo = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...P} d="m11 3 3 3-3 3 M13.5 6H6a3.5 3.5 0 0 0 0 7h4" />
  </svg>
)
export const IconPlus = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...P} d="M8 3v10 M3 8h10" />
  </svg>
)
export const IconMinus = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...P} d="M3 8h10" />
  </svg>
)
export const IconClose = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path {...P} strokeWidth={1.4} d="m2 2 6 6 M8 2 2 8" />
  </svg>
)
/** 属性面板（v0.10）：对齐方式与重置。按钮本身带文字说明（aria-label / title），图标只做视觉 */
export const IconAlign = ({ kind }: { kind: 'left' | 'center' | 'right' | 'justify' }) => {
  const rows: [number, number][] =
    kind === 'left' ? [[2, 14], [2, 10], [2, 12]] : kind === 'center' ? [[2, 14], [4, 12], [3, 13]] : kind === 'right' ? [[2, 14], [6, 14], [4, 14]] : [[2, 14], [2, 14], [2, 14]]
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path {...P} d={rows.map(([a, b], i) => `M${a} ${4 + i * 4}H${b}`).join(' ')} />
    </svg>
  )
}
export const IconReset = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path {...P} d="M3.5 6.5A5 5 0 1 1 3 9.5 M3.5 2.5v4h4" />
  </svg>
)
