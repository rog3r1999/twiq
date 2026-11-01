# Twiq 与 Tencent/page-harness 对比

对比对象：

- page-harness **0.1.13**（[Tencent/page-harness](https://github.com/Tencent/page-harness) 提交 `83a6aae`，2026-10-29 克隆阅读）。
- Twiq **0.9.1**（本仓库 `de8d028`）。

下面每条结论都来自两边的源码或文档，括号里是出处。page-harness 的文件路径相对它的仓库根目录。

## 一句话

| | page-harness | Twiq |
|---|---|---|
| 它是什么 | 把**正在运行的网页**变成编码 Agent 的工作台：页面上点选元素，交给本机的 Claude Code / Codex / Cursor 等 CLI 去改源码（`README.zh-CN.md`「概览」） | 打开**本地 HTML 文件**，在渲染好的页面上直接改；保存时只改动被改的字符（`README.zh-CN.md`） |
| 谁改源码 | Agent。page-harness 自己不写源码；没有源码时的「直接改」只是浮层上的临时补丁，存进 `.page-harness/review.json`，不写回站点（`client/shared/patcher.ts`、README「评审模式」） | Twiq 自己，按字节写最小补丁（`src/main/patch.ts`、`docs/spec.md` 13.7） |
| 用户 | 有 dev server 和 Agent CLI 的前端开发者，加上来评审的产品、设计、测试同事 | 不想（或不会）读源码的人：改 AI 生成的落地页、报告、HTML 幻灯片 |

两者只在「在页面上直接改」这一点重叠，其余是两类产品。对比的目的不是让 Twiq 变成 page-harness，而是找出 Twiq 在它自己的方向上还缺什么。

## 1 定位与形态

| 维度 | page-harness | Twiq |
|---|---|---|
| 形态 | `npx page-harness <地址>`：反向代理目标页面、往 HTML 注入 `overlay.js`；底栏在 Shadow DOM 里；另有控制端口给面板与 API（`src/server/proxy.ts`、`src/server/inject.ts`） | Electron 桌面应用：外壳（React）+ 每个标签一个 `WebContentsView` 预览，编辑层是预览页的 preload（`src/main/tabs.ts`、`src/preload/preview.ts`） |
| 安装门槛 | Node 20.11+，且至少一个登录好的 Agent CLI | 下载安装包（macOS / Windows，未签名） |
| 页面来源 | 任意 URL：localhost dev server、公网站点（自动进评审模式）、书签注入任意网站 | 本地 `.html` / `.htm` 文件；页面在 `hw://` 协议下加载 |
| 离线 | 页面要能访问；Agent 要联网 | 完全本地 |
| 许可 | MIT，打包的第三方代码列在 `THIRD_PARTY_LICENSES.md` | MIT；**没有第三方许可证清单** |

## 2 功能逐项

### 2.1 选取元素

| | page-harness | Twiq |
|---|---|---|
| 怎么选 | 「取点」模式下点任意元素（`client/overlay/index.ts`） | 编辑模式下单击选中，再点一次改字；Alt+↑↓ 父 / 子，Alt+←→ 同级，Shift 多选（`src/preload/select.ts`） |
| 元素身份 | CSS 选择器 + 指纹（标签、id、稳定 class、关键属性、文字及上下文）；页面改版后模糊重定位，阈值以下显示「找不到了」而不乱钉（`client/shared/anchor.ts`） | 源码偏移：parse5 位置信息 + 预览副本上的 `data-hw` 标注，一一对应源码区间，不需要猜（`src/main/parse.ts`、`src/main/annotate.ts`） |
| 选中后能做什么 | 引用到对话、留意见、直接改（仅评审模式）、开 Live 候选 | 改字、删除、复制、拖动换位、自由移动、缩放、改样式与属性、复制源码、插入 |

Twiq 的定位精度更高（源码偏移是精确的），page-harness 的指纹适合它「页面会被 dev server 重新渲染」的场景。这一项 Twiq 不需要借鉴。

### 2.2 直接编辑

| 可改项 | page-harness（评审模式「编辑」表单，`client/overlay/review.ts` `openEditor`） | Twiq（属性面板，`src/renderer/src/Panel.tsx`） |
|---|---|---|
| 文字 | 只限没有子元素的纯文字元素，在表单里改 | 页面上就地改，保留加粗等内联格式，Tab 跳下一段 |
| 颜色 / 背景 | ✓ | ✓ |
| 字号 | ✓ | ✓ |
| 字重 | ✓（300–800 下拉） | 只有 Cmd+B 加粗，**没有字重** |
| 内边距 | ✓ | **没有** |
| 圆角 | ✓ | **没有** |
| 行距 / 对齐 | – | ✓ |
| 图片 | 改 `src`（同时去掉 `srcset`） | 只能在属性里手打 `src` 路径，**不能从文件换图** |
| 结构 | 不支持（README「评审模式」） | 删除、复制、换位、自由移动、缩放、插入媒体、粘贴元素、导入片段 |
| 源码 | – | **只有 SVG** 能改源码；普通元素只能复制源码 |
| 改前改后 | 每条修改存「改前 / 改后」快照，可切换看原版（`client/shared/snapshot-image.ts`、`viewOriginal`） | 只有「未保存」三个字，**看不到这次改了什么** |

### 2.3 保存与写回

| | page-harness | Twiq |
|---|---|---|
| 写回源码 | 由 Agent 改文件；评审模式的修改从不写回 | 自己写，补丁只覆盖改动的字符；保留缩进、属性顺序、实体写法、BOM、换行风格 |
| 文件被别人改了 | 不涉及（dev server 热更新） | 外部修改检测 + 三方合并，冲突逐项选（`src/main/merge.ts`），适合与 AI Agent 同时改一份文件 |
| 撤销 | 意见与修改条目可删除 | 补丁级撤销重做，打字按 600ms 合并（`src/main/document.ts`） |

「只改动被改的字符」是 Twiq 最大的差异点，但界面上从头到尾没有把它展示出来：保存只提示「已保存」，用户无从确认「其余字节真的没动」。page-harness 的改前改后对比提示了一个方向。

### 2.4 与 AI 的关系

| | page-harness | Twiq |
|---|---|---|
| 集成方式 | 驱动 5 种 Agent CLI；MCP 工具（`page_state`、`write_artifact`、`ask_question`、`live_update`、`page_note` 等）；每轮发一个独立 Bearer token（README「MCP 工具」「安全模型」） | 不集成任何 AI。和 AI 的关系是「AI 先写，Twiq 来改」：外部修改合并、规格附录 A 给 AI 的写法约束 |
| 把元素交给 AI | 取点结果带选择器、标签、文字（截 120 字）、outerHTML（截 1024 字）进对话（`client/shared/dom.ts` `pickOf`、`src/server/prompt.ts`） | 只能「复制源码」，**不带文件位置、行号、选择器**，贴给 AI 还得自己说明是哪个文件哪一段 |
| 多方案 | Live 候选：Agent 在源码里写 2–4 版，页面上切换、调参、采纳 | – |

Twiq 不该变成 Agent 前端，那会把用户换成开发者。但「小改在 Twiq，大改交给 AI」是 AI 生成页面的真实工作流：一键把选中元素连同**文件路径、行号、选择器、源码**复制成一段给 AI 的说明，成本很低，衔接很顺。

### 2.5 评审与协作

page-harness 有完整的评审：意见图钉、楼中楼、解决 / 重新打开、按页审批、`--share` 局域网邀请（HMAC 签名的评审者 Cookie）、导出 `page-review.md`、复制 Prompt 让 Agent 逐条处理（README「意见、讨论与审批」「团队评审」）。

Twiq 是单人桌面工具，协作靠文件本身（外部修改合并）。**不建议**为 Twiq 加评审系统：要么引入服务端，要么把意见写进用户的 HTML，都违背「不动其他字节」。

### 2.6 多语言

| | page-harness | Twiq |
|---|---|---|
| 界面语言 | 中文 + 英文，`--lang zh|en`，不写时按浏览器语言并记住每个浏览器的选择；导出的 Markdown、复制的 Prompt 也跟着语言走（README「书签」、`client/shared/i18n-page.ts`、`docs/development.md`「约定」：用户能看见的文案同时有中英文） | **只有中文**。`src/shared/messages.ts` 集中了一部分文案（注释写着「便于以后做多语言」），菜单、面板、工具栏、对话框里还有约 430 行中文字面量（`src/main/menu.ts`、`src/renderer/src/Panel.tsx`、`App.tsx` 等） |

Twiq 的 README 首页是英文，安装后的界面却只有中文，这是开源后最明显的落差。

### 2.7 其他

| | page-harness | Twiq |
|---|---|---|
| 主题 | 明暗切换 | 跟随系统 / 浅色 / 深色，叠加层按页面明暗自适应 |
| 导出 | 意见导出 Markdown / JSON；产物导出 PNG / PDF | 导出 PDF / Markdown / 纯文本 |
| 键盘与读屏 | – | 全键盘可达（F6 在外壳与页面之间切换）、读屏播报、F1 快捷键表（`docs/spec.md` 11） |
| 大文档 | – | 1MB / 2.6 万元素：打开到可编辑 < 2s，拖面板时冻结预览不重排（`tests/e2e/perf.spec.ts`、`panel-perf.spec.ts`） |

## 3 安全模型

| | page-harness | Twiq |
|---|---|---|
| 威胁 | 被代理页面里的脚本、局域网里的其他机器、浏览器跨站请求 | 打开的 HTML 里的脚本 |
| 隔离 | 应用端口与控制端口分属两个源；面板 Cookie `HttpOnly`、`SameSite`；读请求校验 `Sec-Fetch-Site`，写请求要 `Origin` + 自定义头；Host 白名单防 DNS rebinding（421）；HTML 产物带 `sandbox` CSP（README「安全模型」、`src/server/auth.ts`） | 外壳与预览都 `sandbox` + `contextIsolation`，每个标签独立 session，权限请求一律拒绝，导航与 `window.open` 被拦，外链先确认再交给系统浏览器；`hw://` 只给文档所在目录，越出要用户授权（`src/main/tabs.ts`、`src/main/protocol.ts`） |
| Agent 权限 | Agent 以非交互权限在 `--project` 里跑（如 `bypassPermissions`），README 明确提示只对放心的项目用 | 不涉及 |

两边的威胁模型不同，各自都做得到位，这一项不需要互相借鉴。

## 4 工程与发布

| | page-harness | Twiq |
|---|---|---|
| 单元测试 | Vitest，需要 DOM 的用 happy-dom；服务端集成测试真的监听端口（`docs/development.md`） | Vitest，182 个用例，纯函数为主（解析、补丁、host 判定、结构操作、合并） |
| 端到端 | Playwright（Chromium，单 worker），fixture server 起示例应用 | Playwright 驱动真实 Electron 应用，94 个用例，断言磁盘文件与界面文字 |
| 视觉巡检 | `e2e/visual.spec.ts`：每个界面 × 明暗 × 中英各截一张 | `pnpm screens`：11 个关键状态，只截当前主题 |
| CI | Node 20 / 22 / 24 矩阵：lint、类型检查、单测、构建；e2e 失败上传报告；插件包单独一组（`.github/workflows/ci.yml`） | Ubuntu 上 `pnpm check`，macOS 上 e2e，失败上传结果（`.github/workflows/ci.yml`） |
| 发版 | 推 `v*` tag 触发：**校验 tag 与 package.json 版本一致** → lint、类型检查、测试 → npm 发布（OIDC trusted publishing）→ 自动生成 Release notes（`.github/workflows/release.yml`） | **没有发版流程**：tag 手打，安装包本机打，没有 GitHub Release，没有 CHANGELOG |
| 本地门禁 | – | `.githooks`：pre-commit 跑类型检查 + lint + 单测并拦临时文件与密钥，commit-msg 查格式，pre-push 跑 e2e |
| 给 Agent 的约束 | `AGENTS.md`：只写改代码时容易踩错的约束（端口、Cookie 规则、不要改的行为、发版规则） | 只有 `CONTRIBUTING.md`。踩过的坑（WebContentsView 截图、pointerdown 吞 mousemove、`html *` 重算样式等）只在开发者的笔记里，仓库里没有 |
| 第三方许可 | `prepublishOnly` 刷新 `THIRD_PARTY_LICENSES.md` | 安装包里打进了 React、zustand、parse5、entities、chokidar，**没有附它们的许可证** |

## 5 文档与开源运营

page-harness 的 README 有：演示视频、每个使用场景一张截图、命令一行起步、功能表、Agent 支持矩阵、全部命令行参数、原理图、安全模型、数据存在哪、常见问题。

Twiq 的 README 有：功能列表、环境依赖、构建与测试、目录结构、一张截图。缺：演示动图、常见问题（会不会改坏我的文件？支持哪些页面？数据存在哪？）、隐私说明（Twiq 不联网、设置文件位置）。

## 6 结论

### 不该学的

- **代理 / 书签 / 驱动 Agent CLI**：会把 Twiq 变成开发者工具，偏离「不写代码的人改 AI 写的页面」。
- **评审意见系统**：需要服务端或往用户文件里写东西，违背最小改动。
- **指纹重定位**：Twiq 的源码偏移更精确。

### 值得借鉴、按优先级

| # | 打磨项 | 来自 page-harness 的什么 | Twiq 现状 | 本轮 |
|---|---|---|---|---|
| 1 | **改动面板**：列出这次改了哪些地方（改前 → 改后），点一条跳到页面上；保存提示「改了 N 处，其余 X 个字符原样保留」 | 修改条目的改前改后对比 | 只有「未保存」 | 做 |
| 2 | **复制给 AI**：选中元素 → 复制带文件路径、行号、选择器、源码的一段说明 | 取点引用到对话 | 只能复制裸源码 | 做 |
| 3 | **替换图片**：选中图片 → 选文件 → 复制到 assets 并换掉 `src` | 编辑表单可改图片 | 只能手打路径 | 做 |
| 4 | **任意元素改源码**（2026-10-22 v0.8 计划里就有，一直没做） | – | 只有 SVG | 做 |
| 5 | **字重、圆角、内边距** | 编辑表单的这几项 | 没有 | 做 |
| 6 | **中英双语界面**，默认跟随系统 | 全部文案中英双份 | 只有中文 | 做（量最大，放最后） |
| 7 | **发版流程**：tag 校验版本 → 检查 → 三平台打包 → Release 草稿；CHANGELOG | `release.yml` | 无 | 做 |
| 8 | **第三方许可证清单**，打进安装包 | `THIRD_PARTY_LICENSES.md` | 无 | 做 |
| 9 | **AGENTS.md**：把踩过的坑写成约束 | `AGENTS.md` | 无 | 做 |
| 10 | README：演示动图、常见问题、隐私 | README 结构 | 部分 | 做 |
| 11 | 视觉巡检覆盖明暗 × 中英 | `visual.spec.ts` | 只截当前主题 | 做 |

本轮实际落地的内容和验收证据见 `CHANGELOG.md` 的 0.10.0 一节。
