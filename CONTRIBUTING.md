# 参与开发

设计依据是 `docs/spec.md`（代码注释和测试名里的「规格 x.y」、`AC-xx`、`UX-xx` 都指这份文档）。改代码时容易踩错的约束写在 [AGENTS.md](AGENTS.md)。

## 首次设置

```bash
pnpm install && pnpm hooks:install
```

`hooks:install` 让 git 使用仓库里的 `.githooks/`：

| 钩子 | 做什么 | 耗时 |
|---|---|---|
| pre-commit | 改到文档以外的文件时跑 `typecheck`、`lint`、单元测试；拦截临时文件、`.env`、证书 | 约 10 秒 |
| commit-msg | 检查首行格式（见下） | 即时 |
| pre-push | 端到端测试（`HW_SKIP_E2E=1` 可跳过，须在 PR 里说明） | 约 2 分钟 |

## 分支与版本

- `main` 始终可发布。每个版本打带注释的标签（如 `v0.10.0`），版本号与 `package.json` 一致，`CHANGELOG.md` 里有这一版的说明；推送标签后 `.github/workflows/release.yml` 打包并生成 Release 草稿。
- 在分支上开发，通过 PR 合入；一个功能或一个缺陷一个提交。
- 行为与 `docs/spec.md` 不一致时，在 PR 里说明，必要时一并修改规格。

## 提交信息

首行以类型开头，72 字符以内；细节写正文。

```
feat: 属性面板支持行高
fix: 缩放 150% 下工具条偏移
test: 补充 AC-24 键盘撤销
docs | chore | refactor | perf | build | ci | release
```

## 门禁

| 命令 | 内容 |
|---|---|
| `pnpm check` | 类型检查 + lint + 单元测试 |
| `pnpm check:all` | 上面全部 + 端到端测试 |
| `pnpm screens [目录]` | 用真实应用截关键界面状态（`HW_ZOOM=150` 缩放、`HW_LANG=en` 英文、`HW_THEME=dark` 深色），改动界面后对照规格第 9、10 节看一遍；`00-readme.png` 是 README 头图 |
| `pnpm tokens` | 改了 `design/tokens.json` 后重新生成 `tokens.css`（单元测试会检查两者一致） |
| `pnpm licenses` | 改了依赖后重新生成 `THIRD_PARTY_LICENSES.md`（单元测试会检查） |

界面文字只写在文案表里并同时给出中英两份（见 AGENTS.md），单元测试会拦住表外的中文字面量。

CI（`.github/workflows/ci.yml`）在推送到 `main` 与 PR 时运行同样的检查，端到端测试在 macOS 与 Windows 上各跑一遍；Windows 还会打一次安装包，作为构建产物上传（Actions 页面里的 `windows-installer`），可以下载到真机上装一遍。
发版时（`release.yml`）每个系统也是先跑通端到端测试再打包。

仓库的 `.gitattributes` 关掉了换行符转换：测试按字节比对文件，Windows 上默认的 `core.autocrlf=true` 会让它们因为错误的原因失败。

## 测试写法

- 修缺陷先写能复现它的测试（单元或端到端），再修。
- 端到端测试驱动真实应用，断言用户能看到的结果（磁盘文件内容、状态栏文字、页面文字），不断言内部实现。
- 原生对话框用 `tests/e2e/helpers.ts` 的 `stubDialogs` 替换，这部分需要人工确认。
- `perf.spec.ts` 的耗时门槛（AC-41）在高负载机器上可能超时，失败时先在空闲机器上重跑。
