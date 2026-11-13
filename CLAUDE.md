# LabWeave（科研工作台）

基于 Project Graph（提交 `5524363`）改出来的独立软件，按 GPL-3.0-only 发布。不再合并原项目的新版本；原项目的修复要用时单独挑过来。

@AGENTS.md

`AGENTS.md` 是原项目留下的代码约定（目录结构、错误处理、文案、禁止 build），继续遵守；和本文件冲突时以本文件为准。

## 产品原则

- 这是我们自己的软件：不加「原版模式 / 科研模式」这类总开关，新功能直接就是唯一的行为。
- 只要一套结构：不要「我们的一层 + 原版的一层」叠着放（设置页、菜单都按这个原则定）。原版有用的并进来，没用的去掉。
- 能用合理的默认值解决的，就不加设置项。
- 我们自己的逻辑放进自己的文件（主要在 `app/src/core/research/`），不往原版文件里塞大段代码。
- 数据只留在本机：不加遥测、账号、在线服务。
  - 例外（2026-11-10 定）：划词翻译默认调 Google、Bing 的网页翻译，设置里可改成用户配好的 AI。除此以外不新增联网。
  - 例外（2026-11-13 定）：文献库导入 PDF、「按编号添加」或「联网补全信息」时，拿 DOI 查 Crossref、拿 arXiv 编号查 arXiv 取回标题和作者等信息；按 arXiv 编号添加时另从 arxiv.org 下载这篇的 PDF。只发编号，不上传 PDF 内容。

## 安全底线（已经删掉的不要加回来）

- 不恢复这些接口：执行任意系统命令、启动任意外部程序、绕开权限检查读写文件、全局快捷键、自动更新、加载扩展。
- 本机 AI 程序（ACP）只能启动程序目录里列出的程序，不能填自定义命令。
- 不把闭源的 AI 程序或转接器（Codex、Claude Code、`claude-agent-acp` 等）打进安装包，由用户自己安装。
- 判断「是不是白板工具」只认固定的工具名格式，不看 AI 程序填的命令参数。

## 检查（改完代码必须跑，不要 build）

都在仓库根目录跑：

- 类型检查：`pnpm --filter @graphif/project-graph type-check`
- 前端测试：
  `PROJECT_GRAPH_OWNERSHIP_HELPER_PATH=$PWD/app/src-tauri/target/debug/project-graph-ownership-helper pnpm exec vitest run --exclude app/src/cli/ProjectGraphCliProduction.test.ts`
  - 只能在根目录跑，在 `app/` 里跑会报假失败。
  - 还没有 helper 时先编译它：`cargo build --manifest-path app/src-tauri/Cargo.toml --no-default-features --bin project-graph-ownership-helper`
- Rust 测试：`cd app/src-tauri && cargo test --no-default-features --lib`
- 改动文件的格式和规范：`pnpm exec prettier --check <文件…>`、`pnpm exec eslint <文件…>`
- 根目录的 `pnpm test` 会多跑一个依赖打包产物的测试，不要用它。

## 文案

- 新文案写进 `app/src/locales/zh_CN.yml` 和 `en.yml`。`zh_TW.yml` 用 `pnpm --filter @graphif/project-graph sync-locales` 生成，不要手改。`zh_TWC.yml`、`id.yml` 目前不维护。
- 给用户看的文字都放进文案文件。核心逻辑里只抛错误代码，由界面翻译成中英文。

## 提交

- 用 Conventional Commits（`feat:`、`fix:`、`refactor:` 等），说明写清楚做了什么。
- 不加任何 AI 署名（不写 `Co-Authored-By: Claude …`、`Generated with …`），作者只用仓库里配好的 git 用户。
- 每次改动都在 `CHANGES-research-workbench.md` 里追加说明（GPL 第 5 条要求写明改了什么）。

## Windows

- 每次推送，CI（`.github/workflows/check.yml`）会在 Windows 和 macOS 上跑类型检查、测试和编译。
- 写和路径有关的代码时，两种系统的写法都要考虑：Windows 是 `C:\` 加反斜杠。
