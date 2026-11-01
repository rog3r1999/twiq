# 给改这个仓库的人和 AI

产品说明在 [README](README.zh-CN.md)，设计依据在 [docs/spec.md](docs/spec.md)，流程在 [CONTRIBUTING.md](CONTRIBUTING.md)。
这里只写读代码猜不到、改错了又不会立刻报错的约束。

## 先跑什么

```bash
pnpm install && pnpm hooks:install
pnpm check                         # 类型检查 + lint + 单元测试，约 10 秒
pnpm test:e2e                      # 动了行为就跑：Playwright 驱动真实应用，约 3 分钟
pnpm screens <目录>                 # 动了界面就截图看一遍；HW_LANG=en、HW_THEME=dark 各再截一遍
```

只看一张截图、或只看测试通过，不算验证过界面。

## 不能破坏的约定

- **保存只写补丁。** 任何路径都不能把 HTML 重新序列化（parse5 只用来读位置）。新功能要改源码，就产出 `Patch` 或走 `StructOp`，让 `DocState` 写撤销栈。
- **结构操作就地同步预览**（`src/main/dom-sync.ts`）。拿不准就返回 `null` 让预览整页重载，不要返回「空步骤」：页面会静默停在旧状态（v0.10 前整份替换改字就是这样）。
- **「正在改字」由预览页报告**（`preview:editing`）。主进程不要在 `edit:enter` 时提前置位，否则大文档上第一批按键会丢。
- **被预览的 HTML 永远不改色。** 外观只作用于外壳与叠加层；不要设 `nativeTheme.themeSource`，它会改掉页面自己的 `prefers-color-scheme`。
- **界面文字只写在文案表里，中英两份**：`src/shared/messages.ts`（共用）、`src/main/strings.ts`（主进程与菜单）、`src/renderer/src/strings.ts`（外壳）、`src/preload/strings.ts`（预览页）。`tests/unit/i18n.test.ts` 会拦住表外的中文字面量和缺失的译文。
- **依赖分两种。** 主进程、preload、shared 只能用 `dependencies`（安装包里没有 devDependencies）；外壳打包进去的库要加进 `scripts/gen-licenses.ts` 的 `BUNDLED`，再 `pnpm licenses`。`tests/unit/licenses.test.ts` 会检查。
- **两个 preload 都跑在 sandbox 里**，各自打成单文件，不能引用 Node 模块。
- 改了 `design/tokens.json` 要 `pnpm tokens`（单测比对 `tokens.css`）。

## 踩过的坑（都实测过）

- `BrowserWindow.capturePage` 不含子 `WebContentsView`：截图要把预览视图单独截下来合成（`scripts/screens.ts`）。
- 在 `pointerdown` 上 `preventDefault` 会让 Chromium 吞掉随后的 `mousemove`，拖不动；要在 `mousedown` 上做。
- 光标样式写在 `html *` 上，1MB 文档每次按下都要重算全部样式；写在 `html` 上靠继承。
- 改预览视图的 bounds / zoom 会让整页重排（2.6 万元素一帧 84–110ms）：拖面板时用冻结画面，松手才改一次。
- `contenteditable=plaintext-only` 会强制 `white-space: pre-wrap`，编辑时源码里的换行会显形，要覆盖空白样式。
- 带过 `srcset` 的 `<img>` 删掉 `srcset`、改了 `src` 后不会重新加载：先让 `srcset` 指向当前 `src` 再删。
- preload 只在主框架运行，iframe 里的事件拦不到。
- 给无引号属性值、`<br/>` 这类标签加属性时，`/` 前要补空格。
- 直接运行（`pnpm dev` / `start`）时 Dock 图标要手动 `app.dock.setIcon`，打包后才由 electron-builder 写入。
- macOS 上只能打 Windows 的 zip，NSIS 安装包要 Wine；发版在 Windows runner 上打。

## 写测试

- 端到端断言用户看得到的结果：磁盘上的文件内容、状态栏文字、页面文字。不断言内部实现。
- 端到端默认中文界面（`TWIQ_LANG=zh`）；测英文或语言切换的用例传 `TWIQ_LANG: ''` 走设置。
- 原生对话框用 `tests/e2e/helpers.ts` 的 `stubDialogs` 替换。
- `page.evaluate` 的回调里不要写具名函数：tsx 会注入页面里没有的 `__name`。
- `getByLabel` 默认按子串匹配：「重置 字重」也会被 `getByLabel('字重')` 选中，要加 `exact: true`。
- 修缺陷先写能复现它的测试，确认它因为正确的原因失败，再修。
- 性能用例 AC-41 在锁屏或高负载时会超时，先在空闲机器上重跑再下结论。

## 提交与发版

- 提交信息首行 `类型(范围): 说明`（feat / fix / perf / test / docs / build / ci / refactor / chore / release），72 字以内，正文写为什么。
- 一个功能或一个缺陷一个提交；`package.json` 的版本号只在单独的发版提交（`release: X.Y.Z`）里改，不夹在功能提交里。
- 发版：发版提交改版本号、`CHANGELOG.md` 写好这一节 → 验收后合入 `main` → 打带注释的标签 `vX.Y.Z` → 推送标签，`.github/workflows/release.yml` 校验、打包并生成 Release 草稿 → 人工确认后发布。
- 没有明确要求就不要 push，也不要打新的发版标签。
