# 更新记录 / Changelog

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：1.0 之前，次版本号（0.x）可能包含不兼容的改动。
每个版本对应一个带注释的 git 标签 `vX.Y.Z`，与 `package.json` 的 `version` 一致；推送标签时 CI 打包并生成 Release 草稿（`.github/workflows/release.yml`）。

Versions follow [Semantic Versioning](https://semver.org/). Each release is an annotated git tag `vX.Y.Z` matching `package.json`; pushing the tag builds the installers and drafts a GitHub Release.

1.0.0 是首个公开发布的版本。下面的 0.x 是开源前的开发版本，留作功能演进的记录，没有对应的标签和安装包。
1.0.0 is the first public release. The 0.x entries below are pre-release development versions, kept as a record; they have no tags or installers.

## 1.0.0 — 2026-11-01

**AI 写的 HTML，点一下就改。Edit AI-written HTML with a click.**

首个公开版本，免费、开源（MIT）。打开本地 HTML 文件，在页面上直接改文字、调样式、换位置、删掉一块；保存时只改动被改的字符，其余一字节不变。功能与 0.10.0 相同，本版只改了打包与文档。

The first public release, free and open source (MIT). Same features as 0.10.0; this release changes packaging and documentation only.

### 下载 / Download

| 系统 / System | 文件 / File |
|---|---|
| macOS，Apple 芯片 / Apple silicon | `Twiq-1.0.0-arm64.dmg` |
| macOS，Intel | `Twiq-1.0.0.dmg` |
| Windows 10 / 11 x64 | `Twiq-Setup-1.0.0.exe` |

macOS 安装包未经 Apple 公证：第一次打开被拦下后，到「系统设置 › 隐私与安全性」点「仍要打开」。Windows 出现「Windows 已保护你的电脑」时点「更多信息 › 仍要运行」。详见 [README](https://github.com/rog3r1999/twiq#下载安装)。

The macOS app is not notarized: after the first launch is blocked, click **Open Anyway** in **System Settings › Privacy & Security**. On Windows, click **More info › Run anyway**. See the [README](https://github.com/rog3r1999/twiq/blob/main/README.en.md#download).

### 修复 / Fixes
- Windows：打开大文档时拖动属性面板的左边缘，面板拖一点就停下、不再跟着鼠标。冻结画面生效时系统收回了手柄的指针捕获，之后的移动落到别的元素上；现在拖动在整个窗口上跟踪。
- Windows: dragging the property panel's edge on a large document stopped following the mouse after a moment. Dragging is now tracked on the whole window.

### 打包 / Packaging
- macOS 安装包改为 ad-hoc 签名。此前跳过签名后，Electron 自带的签名被打包过程破坏，下载后在 Apple 芯片上会被报「已损坏」。
- Windows 安装包固定命名为 `Twiq-Setup-x.y.z.exe`。
- 端到端测试在 Windows 上也跑一遍；发版时每个系统先跑通端到端测试再打包。仓库关掉了换行符转换，Windows 上检出的文件和仓库里逐字节一致。

### 文档 / Docs
- README 以中文为首页（英文见 README.en.md），新增下载安装、首次打开步骤、截图与宣传片片段。
- 新增示例幻灯片 `docs/demo/q3-review.html`，可以下载后用 Twiq 打开试改。

## 0.10.0 — 2026-10-29

**Make the minimal diff visible, speak English, and hand off to AI cleanly.**

### 新增
- **改动面板**：属性面板新增「改动」页，逐处列出相对上次保存的改动（修改 / 新增 / 删除 / 移动、所在元素、行号、前后文），写明「多少字符里有多少原样保留」；点一条在页面上选中它，「撤回」只退回这一处。状态栏显示「N 处改动」，保存提示带上统计。
- **中英双语界面**：菜单、对话框、提示、面板、叠加层、新建模板与示例页全部有中英两份；默认跟随系统语言，「查看 › 语言」随时切换，不重新加载页面。从旧版本升级的用户保持中文。
- **任意元素编辑源码**：编辑器占满面板、带 HTML 着色，输入即预览，应用写成一步撤销，坏源码不写入。
- **复制给 AI**：选中元素的源码连同文件路径、行号、CSS 选择器，整理成「只改这一段」的说明，粘贴给 AI 助手。
- **替换图片**：选中图片 → 选文件 → 复制到 assets 并只改 `src`（有 `srcset` 一并去掉），一步撤销。
- 属性面板新增字重、内边距、圆角；对齐与重置改为图标。
- 产品更名为 **Twiq**（读音同 tweak），新图标「微调旋钮」，界面配色换成铝灰中性色 + 信号橙强调色。

### 修复
- 页面真正可输入后才报告「正在改字」：大文档上进入编辑后立刻输入的字不再丢失（AC-41 因此长期失败）。
- 只改了文字的整份替换（组件规范化、撤回一处）不再让预览留着旧文字。
- Chromium 中带过 `srcset` 的图片换了 `src` 后一直显示破图。
- 编辑工具条在页面顶部附近不再压住「文字」标签。
- 示例页面的操作说明按 v0.8 起的交互改写。
- 空状态副标题不再剩一个「字。」单独落在第二行。
- macOS 安装包补上 Electron 与 Chromium 的许可证文件。

### 工程
- 推送 `v*` 标签自动打包 macOS（dmg / zip，arm64 + x64）与 Windows（NSIS / zip）并生成 Release 草稿，先校验标签与版本号一致。
- `THIRD_PARTY_LICENSES.md`（`pnpm licenses` 生成）随安装包分发；单测保证清单最新，且主进程不会引用只在开发时安装的包。
- 守卫测试：文案表以外不许出现中文字面量；英文模式下每条文案都有译文。
- `AGENTS.md`：给改这个仓库的人和 AI 的约束与踩过的坑。
- `docs/compare-page-harness.md`：与 Tencent/page-harness 的逐项对比。

## 0.9.1 — 2026-10-25

开源发布：MIT 许可、中英 README、`docs/spec.md`。
- 拖动属性面板时冻结预览，1MB 文档拖动期间不再逐帧重排（0 次重排，外壳 16.7ms 一帧）。
- 悬停块左上角的把手，拖它整块移动；多选卡片整组拖动。
- 浅色 / 深色 / 跟随系统，设计 token 单一来源（`design/tokens.json`）。

## 0.8.0 — 2026-10-24

- 「文字」与「选择」合并为一个编辑模式：单击选中，再点一次改字。
- 整块拖动：按在已选中的块里拖动时保持选中。

## 0.7.0 — 2026-10-23

- 属性面板可拖动调宽，页面按比例缩小不重新排版。
- SVG 结构化编辑（文字、位置、颜色），源码默认收起；「插入到后面」菜单；复制源码。

## 0.6.0 — 2026-10-22

- 缩放手柄与吸附对齐、同级标识、多选、自由移动、SVG 隔离编辑。
- 结构操作就地同步预览，不再整页重载。

## 0.2.0 – 0.5.0 — 2026-10-22

- 选择模式与结构操作（删除、复制、拖放换位、包裹 / 解开）、样式面板、文字格式、插入媒体、元素剪贴板、导出 PDF / Markdown / 纯文本、外部修改三方合并、组件规范。

## 0.1.0 — 2026-10-20

首个可用版本：打开本地 HTML，在页面上直接改字，保存时只改动被改的字符（保留缩进、属性顺序、实体写法、BOM 与换行风格）；多标签页、外部修改检测、`hw://` 安全预览、键盘与读屏可达。
