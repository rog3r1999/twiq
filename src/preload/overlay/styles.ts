// 叠加层样式（规格 9.1、9.3、9.5）。写在 closed shadow DOM 内，页面样式无法影响。
//
// v0.9 配色分两层：
// 1) .root 上的 chrome token 跟随应用外观（浅/深），用于工具条、气泡、toast、手柄底色；
// 2) page token 跟随被预览页面的明暗（.dark-page 由 Overlay.detectDark 探测），
//    用于直接画在页面上的选中框、标签、落点线与参考线。
// 这样「深色应用 + 浅色文档」「浅色应用 + 深色文档」两种组合都有足够对比度，
// 同时不改变文档自身的任何样式。所有颜色只在本文件的 token 块里出现一次。

export const OVERLAY_CSS = `
:host { all: initial; }
.root {
  /* ---- chrome token：浅色应用 ---- */
  --ov-surface: #FFFFFF;
  --ov-ink: #1C1B19;
  --ov-ink-muted: #5E5B55;
  --ov-line: #E2DFDA;
  --ov-hover: #EEECE8;
  --ov-accent-chrome: #C2410C;
  --ov-edit-chrome: #0E7A5C;
  --ov-danger-chrome: #B4233F;
  --ov-focus: #C2410C;
  --ov-toast-bg: #1C1B19;
  --ov-toast-ink: #FFFFFF;
  --ov-toast-muted: #C9C6C0;
  --ov-warning-bg: #FFF4DC;
  --ov-warning: #8A5A00;
  --ov-warning-line: #E8CF97;
  --ov-warning-solid: #8A5A00;
  --ov-on-warning-solid: #FFFFFF;
  --ov-on-danger: #FFFFFF;
  --ov-scrim: rgba(15, 16, 22, 0.55);
  --ov-on-scrim: #FFFFFF;
  --ov-on-scrim-muted: #D7D9E2;
  --ov-scrim-shadow: rgba(0, 0, 0, 0.5);
  --ov-shadow-sm: 0 1px 2px rgba(15, 16, 22, 0.10);
  --ov-shadow-md: 0 4px 12px rgba(15, 16, 22, 0.12);
  --ov-shadow-lg: 0 10px 30px rgba(15, 16, 22, 0.18);

  /* ---- page token：浅色文档（默认） ---- */
  --ov-accent: #C2410C;
  --ov-on-accent: #FFFFFF;
  --ov-edit: #0E7A5C;
  --ov-on-edit: #FFFFFF;
  --ov-danger-line: #B4233F;
  --ov-danger-on-scrim: #FF8FA3;
  --ov-pop: #1D5FD6;
  --ov-warning-line-page: #8A5A00;
  --ov-uneditable: #6B6862;
  --ov-halo: rgba(15, 16, 22, 0.42);
  --ov-halo-soft: rgba(15, 16, 22, 0.24);
  --ov-halo-strong: rgba(15, 16, 22, 0.62);
  --ov-accent-65: rgba(194, 65, 12, 0.65);
  --ov-accent-45: rgba(194, 65, 12, 0.45);
  --ov-accent-35: rgba(194, 65, 12, 0.35);
  --ov-accent-16: rgba(194, 65, 12, 0.16);
  --ov-accent-12: rgba(194, 65, 12, 0.12);
  --ov-accent-08: rgba(194, 65, 12, 0.08);
  --ov-accent-05: rgba(194, 65, 12, 0.05);
  --ov-edit-16: rgba(14, 122, 92, 0.16);
  --ov-edit-14: rgba(14, 122, 92, 0.14);
  --ov-danger-16: rgba(180, 35, 63, 0.16);
  --ov-danger-12: rgba(180, 35, 63, 0.12);
  --ov-warn-18: rgba(138, 90, 0, 0.18);
  --ov-pop-06: rgba(29, 95, 214, 0.06);

  --ov-font-ui: 12.5px;
  --ov-font-mono: 10.5px;
  --ov-font-tiny: 10px;
  --ov-font-small: 11px;
  --ov-font-sub: 13px;
  --ov-font-title: 18px;
  --ov-radius-2xs: 2px;
  --ov-radius-xs: 3px;
  --ov-radius-sm: 4px;
  --ov-radius-md: 6px;
  --ov-radius-lg: 8px;
  --ov-radius-xl: 10px;
  --ov-radius-2xl: 12px;
  --ov-space-1: 1px;
  --ov-space-2: 2px;
  --ov-space-4: 4px;
  --ov-space-5: 5px;
  --ov-space-6: 6px;
  --ov-space-8: 8px;
  --ov-space-10: 10px;
  --ov-space-12: 12px;
  --ov-space-14: 14px;
  --ov-space-16: 16px;
  --box-alpha: 0.65;
  position: fixed; inset: 0; pointer-events: none;
  font: var(--ov-font-ui)/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei UI", sans-serif;
  color: var(--ov-ink);
}
.root[data-theme="dark"] {
  /* ---- chrome token：深色应用 ---- */
  --ov-surface: #1C1C1E;
  --ov-ink: #F2F1EF;
  --ov-ink-muted: #ADABA6;
  --ov-line: #2E2E31;
  --ov-hover: #262628;
  --ov-accent-chrome: #FF7A3D;
  --ov-edit-chrome: #34D3A5;
  --ov-danger-chrome: #FF8FA3;
  --ov-focus: #FF7A3D;
  --ov-toast-bg: #262628;
  --ov-toast-ink: #F2F1EF;
  --ov-toast-muted: #ADABA6;
  --ov-warning-bg: #3A2C10;
  --ov-warning: #F3C26B;
  --ov-warning-line: #6B4F14;
  --ov-warning-solid: #E89A12;
  --ov-on-warning-solid: #1C1B19;
  --ov-on-danger: #2B0A12;
  --ov-scrim: rgba(0, 0, 0, 0.65);
  --ov-on-scrim: #F2F1EF;
  --ov-on-scrim-muted: #B9BCC8;
  --ov-scrim-shadow: rgba(0, 0, 0, 0.7);
  --ov-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.40);
  --ov-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.45);
  --ov-shadow-lg: 0 10px 30px rgba(0, 0, 0, 0.55);
}
.dark-page {
  /* ---- page token：深色文档；无论应用是浅色还是深色，直接画在页面上的线都换成深色页面版本 ---- */
  --ov-accent: #FF7A3D;
  --ov-on-accent: #1A0E06;
  --ov-edit: #34D3A5;
  --ov-on-edit: #131314;
  --ov-danger-line: #FF8FA3;
  --ov-danger-on-scrim: #FF8FA3;
  --ov-pop: #7FB0FF;
  --ov-warning-line-page: #F3C26B;
  --ov-uneditable: #93918C;
  --ov-halo: rgba(241, 242, 246, 0.42);
  --ov-halo-soft: rgba(241, 242, 246, 0.24);
  --ov-halo-strong: rgba(241, 242, 246, 0.62);
  --ov-accent-65: rgba(255, 122, 61, 0.65);
  --ov-accent-45: rgba(255, 122, 61, 0.45);
  --ov-accent-35: rgba(255, 122, 61, 0.35);
  --ov-accent-16: rgba(255, 122, 61, 0.16);
  --ov-accent-12: rgba(255, 122, 61, 0.12);
  --ov-accent-08: rgba(255, 122, 61, 0.08);
  --ov-accent-05: rgba(255, 122, 61, 0.05);
  --ov-edit-16: rgba(52, 211, 165, 0.16);
  --ov-edit-14: rgba(52, 211, 165, 0.14);
  --ov-danger-16: rgba(255, 143, 163, 0.16);
  --ov-danger-12: rgba(255, 143, 163, 0.12);
  --ov-warn-18: rgba(243, 194, 107, 0.18);
  --ov-pop-06: rgba(127, 176, 255, 0.06);
}
.root.dark-page { --box-alpha: 0.85; }

.box { position: absolute; box-sizing: border-box; border-radius: var(--ov-radius-2xs); display: none; }
.box.on { display: block; }
.hover { border: 1px dashed var(--ov-accent-65); box-shadow: 0 0 0 1px var(--ov-halo-soft); z-index: 1; }
.hover.uneditable { border-color: var(--ov-uneditable); }
.focus { border: 1px dashed var(--ov-accent-65); box-shadow: 0 0 0 1px var(--ov-halo-soft); z-index: 1; outline: 2px solid var(--ov-accent); outline-offset: 2px; }
.edit { border: 1.5px solid var(--ov-edit); box-shadow: 0 0 0 1px var(--ov-halo-soft), 0 0 0 4px var(--ov-edit-16); z-index: 2; }
.edit.reject { border-color: var(--ov-danger-line); box-shadow: 0 0 0 1px var(--ov-halo-soft), 0 0 0 4px var(--ov-danger-16); }
.reject-box { border: 1.5px solid var(--ov-warning-line-page); box-shadow: 0 0 0 1px var(--ov-halo-soft), 0 0 0 4px var(--ov-warn-18); z-index: 2; }
.reject-box.error { border-color: var(--ov-danger-line); box-shadow: 0 0 0 1px var(--ov-halo-soft), 0 0 0 4px var(--ov-danger-16); }
.label {
  position: absolute; left: -1.5px; top: -19px; padding: var(--ov-space-1) var(--ov-space-6); border-radius: var(--ov-radius-xs);
  background: var(--ov-edit); color: var(--ov-on-edit); white-space: nowrap;
  font: var(--ov-font-mono)/16px ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  box-shadow: 0 1px 2px var(--ov-halo);
}
.label.inside { top: 2px; left: 2px; }
.select { border: 1.5px solid var(--ov-accent); box-shadow: 0 0 0 1px var(--ov-halo-soft), 0 0 0 4px var(--ov-accent-16); z-index: 2; }
.select .label { background: var(--ov-accent); color: var(--ov-on-accent); }
.blank { border: 1px dashed var(--ov-pop); background: var(--ov-pop-06); z-index: 1; }
.drop-line { position: absolute; display: none; background: var(--ov-pop); border-radius: var(--ov-radius-2xs); z-index: 5; box-shadow: 0 0 0 1px var(--ov-halo-strong); }
.drop-line.on { display: block; }
.handle {
  position: absolute; display: none; z-index: 4; box-sizing: border-box; pointer-events: auto;
  background: var(--ov-surface); border: 1.5px solid var(--ov-accent); border-radius: var(--ov-radius-xs);
  box-shadow: var(--ov-shadow-sm), 0 0 0 1px var(--ov-halo-soft);
}
.handle.on { display: block; }
.handle.hidden-small { display: none; }
.handle { width: 10px; height: 10px; transform: translate(-50%, -50%); }
.h-n, .h-s { width: 16px; height: 8px; cursor: ns-resize; }
.h-e, .h-w { width: 8px; height: 16px; cursor: ew-resize; }
.h-ne, .h-sw { cursor: nesw-resize; }
.h-nw, .h-se { cursor: nwse-resize; }
/* 手柄的可点击范围比看到的大一圈 */
.handle::after { content: ""; position: absolute; inset: -5px; }
.block { border: 1px dashed var(--ov-accent-45); z-index: 1; }
.block-grip {
  position: absolute; display: none; z-index: 4; box-sizing: border-box; pointer-events: auto;
  width: 14px; height: 24px; border-radius: 7px; cursor: grab;
  background: var(--ov-surface); border: 1px solid var(--ov-accent);
  box-shadow: var(--ov-shadow-sm), 0 0 0 1px var(--ov-halo-soft);
}
.block-grip.on { display: block; }
/* 六个点：两列三行，够看见但与尺寸手柄区分 */
.block-grip::before {
  content: ""; position: absolute; left: 50%; top: 50%; width: 10px; height: 14px;
  transform: translate(-50%, -50%);
  background-image: radial-gradient(circle, var(--ov-accent) 1px, transparent 1.2px);
  background-size: 5px 4.7px;
}
/* 可点击范围比看到的大一圈 */
.block-grip::after { content: ""; position: absolute; inset: -5px; }

.sibling { border: 1px dashed var(--ov-accent-45); z-index: 1; }
.sibling .idx {
  position: absolute; right: 2px; top: 2px; padding: 0 var(--ov-space-4); border-radius: var(--ov-radius-xs);
  background: var(--ov-accent-12); color: var(--ov-accent); font: var(--ov-font-tiny)/14px ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.parent-area { background: var(--ov-accent-05); outline: 1px dotted var(--ov-accent-35); z-index: 0; }
.multi { box-shadow: none; }
.guide { position: absolute; background: var(--ov-pop); z-index: 5; box-shadow: 0 0 0 1px var(--ov-halo-strong); }
.guide-x { width: 1px; }
.guide-y { height: 1px; }
.ghost {
  position: absolute; display: none; z-index: 6; box-sizing: border-box; pointer-events: none;
  border: 1.5px dashed var(--ov-accent); background: var(--ov-surface); border-radius: var(--ov-radius-sm);
  color: var(--ov-ink); font: var(--ov-font-mono)/16px ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: var(--ov-space-2) var(--ov-space-6);
  box-shadow: var(--ov-shadow-lg), 0 0 0 1px var(--ov-halo-soft);
}
.ghost.on { display: block; }
.svg-text-input {
  position: absolute; z-index: 6; box-sizing: border-box; pointer-events: auto; padding: var(--ov-space-4) var(--ov-space-6);
  border: 1.5px solid var(--ov-edit-chrome); border-radius: var(--ov-radius-sm); background: var(--ov-surface); color: var(--ov-ink);
  box-shadow: 0 0 0 3px var(--ov-edit-16), var(--ov-shadow-lg); outline: none; line-height: 1.2;
}
.size-tip {
  position: absolute; display: none; z-index: 6; padding: var(--ov-space-2) var(--ov-space-8); border-radius: var(--ov-radius-md);
  background: var(--ov-toast-bg); color: var(--ov-toast-ink); font: var(--ov-font-small)/18px ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.size-tip.on { display: block; }
.recorded { background: var(--ov-edit-14); z-index: 1; }
.bubble {
  position: absolute; display: none; z-index: 3; box-sizing: border-box; max-width: 320px;
  background: var(--ov-surface); border: 1px solid var(--ov-line); border-radius: var(--ov-radius-lg);
  box-shadow: var(--ov-shadow-lg); padding: var(--ov-space-8) var(--ov-space-12);
  /* 气泡不接收鼠标：否则会挡住下方内容的点击 */
  pointer-events: none;
}
.bubble.on { display: block; }
.bubble .why { color: var(--ov-ink); }
.bubble .next { color: var(--ov-ink-muted); }
.toolbar {
  position: absolute; display: none; z-index: 4; box-sizing: border-box; align-items: center; gap: var(--ov-space-2);
  background: var(--ov-surface); border: 1px solid var(--ov-line); border-radius: var(--ov-radius-2xl); padding: var(--ov-space-4);
  box-shadow: var(--ov-shadow-lg); pointer-events: auto; white-space: nowrap;
}
.toolbar.on { display: flex; }
.toolbar button, .menu button {
  all: unset; box-sizing: border-box; padding: var(--ov-space-5) var(--ov-space-8); border-radius: var(--ov-radius-md); cursor: pointer;
  font: var(--ov-font-ui)/18px inherit; color: var(--ov-ink); min-height: 28px; display: inline-flex; align-items: center;
}
.toolbar button:hover, .menu button:hover { background: var(--ov-hover); }
.toolbar button:focus-visible, .menu button:focus-visible { outline: 2px solid var(--ov-focus); outline-offset: 2px; }
.toolbar .done { color: var(--ov-edit-chrome); font-weight: 600; }
.toolbar .danger { color: var(--ov-danger-chrome); }
.toolbar .sep { width: 1px; align-self: stretch; margin: var(--ov-space-4) var(--ov-space-2); background: var(--ov-line); }
.toolbar .fmt { min-width: 28px; justify-content: center; font-family: Georgia, "Times New Roman", serif; }
.toolbar .f-b { font-weight: 700; }
.toolbar .f-i { font-style: italic; }
.toolbar .f-u { text-decoration: underline; }
.toolbar .f-s { text-decoration: line-through; }
.menu {
  position: absolute; top: calc(100% + 4px); right: 0; display: none; flex-direction: column; min-width: 140px;
  background: var(--ov-surface); border: 1px solid var(--ov-line); border-radius: var(--ov-radius-xl); padding: var(--ov-space-4);
  box-shadow: var(--ov-shadow-lg);
}
.menu.on { display: flex; }
.more-wrap { position: relative; }
.toast {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); display: none; z-index: 6;
  background: var(--ov-toast-bg); color: var(--ov-toast-ink); border-radius: var(--ov-radius-xl); padding: var(--ov-space-8) var(--ov-space-14); max-width: 70%;
  box-shadow: var(--ov-shadow-lg); text-align: center; pointer-events: auto;
}
.toast.on { display: block; }
.toast.error { background: var(--ov-danger-chrome); color: var(--ov-on-danger); }
.toast.warn { background: var(--ov-warning-bg); color: var(--ov-warning); border: 1px solid var(--ov-warning-line); box-shadow: var(--ov-shadow-lg); }
.toast.warn::before { content: "!"; display: inline-block; width: 16px; height: 16px; margin-right: var(--ov-space-8); border-radius: 50%; background: var(--ov-warning-solid); color: var(--ov-on-warning-solid); font-weight: 700; font-size: var(--ov-font-small); line-height: 16px; text-align: center; vertical-align: 1px; }
.toast .sub { color: var(--ov-toast-muted); margin-left: var(--ov-space-8); }
.mask {
  position: absolute; inset: 0; display: none; z-index: 7; align-items: center; justify-content: center; flex-direction: column;
  background: var(--ov-scrim); border: 2px dashed var(--ov-accent); box-sizing: border-box;
  font-size: var(--ov-font-title); color: var(--ov-on-scrim); gap: var(--ov-space-6); text-shadow: 0 1px 2px var(--ov-scrim-shadow);
}
.mask.on { display: flex; }
.mask.bad { border-color: var(--ov-danger-line); color: var(--ov-danger-on-scrim); }
.mask .sub { font-size: var(--ov-font-sub); color: var(--ov-on-scrim-muted); }
.fade { transition: opacity 80ms ease-out; }
.fade-slow { transition: opacity 400ms ease-out; }
.pop { animation: pop-in 120ms ease-out; }
@keyframes pop-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.toast.pop { animation: toast-in 160ms ease-out; }
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translateX(-50%); } }
.root.reduced .fade, .root.reduced .fade-slow { transition: none; }
.root.reduced .pop, .root.reduced .toast.pop { animation: none; }
@media print { .root { display: none !important; } }
@media (forced-colors: active) {
  .select { border-color: Highlight; }
  .hover, .edit, .focus, .reject-box, .sibling { border-color: Highlight; }
  .guide { background: Highlight; }
  .label { background: Highlight; color: HighlightText; }
}
`
