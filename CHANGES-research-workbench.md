# 科研工作台 / Research Workbench：修改说明

## 声明（GPL-3.0 第 5 条 a 款）

本程序是 **Project Graph**（<https://github.com/graphif/project-graph>，桌面应用按 GPL-3.0-only 发布）的**修改版本**。

- 修改日期：2026-11-01（之后的修改在下方按日期追加）
- 修改方：ai4Know 项目组
- 本修改版同样按 **GPL-3.0-only** 发布，完整许可证见 `app/LICENSE`。上游各个 `LICENSE` 文件和版权声明原样保留，没有改动。
- `packages/` 下各包沿用各自的许可证（例如 `packages/data-structures`、`serializer`、`shapes` 为 MIT）。
- 分发二进制时，须同时提供对应的完整源代码。

This program is a **modified version** of Project Graph (graphif/project-graph, desktop app licensed GPL-3.0-only), modified on 2026-11-01. The modified version is distributed under GPL-3.0-only as well. Upstream LICENSE files and copyright notices are kept unchanged.

## 改了什么（概要）

- **不再有「原版模式」**：最初新功能都挂在一个开关 `isResearchShell()` 后面，关掉时行为与上游一致；Rust 端对应 cargo feature `research-shell`。2026-11-05 去掉了这个开关和这个 feature：现在的行为是唯一行为，只在关掉开关时才用到的上游代码已删除，Rust 端原先被 feature 排除的命令（`run_command`、`mcp_stdio_*`、几条不受 fs 权限范围约束的原始文件命令）和全局快捷键、自动更新插件的代码也一并删除。本程序不再跟进上游的新版本。
- **产品身份**：identifier 改为 `com.ai4know.researchworkbench`，产品名 Research Workbench，主窗口标题「科研工作台」，深链接协议从 `prg` 改为 `rwb`，文件扩展名仍是 `.prg`。设置、快捷键等数据目录因此和已安装的 Project Graph 分开，不会互相读取。
- **数据只留在本机**：关闭遥测、账号、支持者名单、素材下载、多人协作、扩展加载；不再注册自动更新和系统全局快捷键插件，不再打包更新文件；`run_command`、`mcp_stdio_*` 和不受 fs 权限范围约束的原始文件命令不再暴露给前端；AI 对话不加载 MCP 和 Skills，回答里的远程图片不自动加载。
- **研究文件夹**：新增 Rust 命令 `set_research_root`，把用户选的文件夹加入文件访问范围；新增左侧文件面板（按工作区 / 论文 / 图片 / 笔记分组）；只允许打开研究文件夹里的工作区。
- **外壳界面**：左侧竖栏（工作区 / AI 对话 / 文件 / 设置）、精简的菜单和 macOS 原生菜单（含编辑菜单）、新快捷键 Cmd+1/2/3/N、没打开工作区时编辑区显示欢迎页（侧栏照常停靠、能拖，AI 对话收起）、启动时恢复上次的工作区和面板、命令面板白名单；设置弹窗改为「设置 / 快捷键 / 菜单 / 关于」四页，设置按用途分 10 页，原版的「个性化」拆进「外观」和「菜单」。
- **文件卡片**：新实体 `FileCardNode`，用 pdf.js 抽 PDF 的标题、页数、首页缩略图和前几页文字，也支持图片和 Markdown；双击用系统默认程序打开原文件，原文件不见了会标红。
- **拖放**：从文件面板或 Finder 把文件拖到白板生成卡片；研究文件夹外的文件经用户同意后复制到 `导入/` 子文件夹。
- **保存**：保存时在 `.workbench/` 下写给 AI 读的 `<名字>.ai.json` / `.ai.md`；`.prg` 元数据记录工作区 id 和视野；科研模式下原子写入（临时文件 + 改名），编辑后约 5 秒自动保存，备份不再写进研究文件夹。
- **AI 对话**：支持 OpenAI 兼容和 Anthropic 两种接口格式；系统提示改为中文研究助手，并附上当前白板和研究文件夹的文件清单；应用内对话只开放只读工具；新增 `dump_workspace`、`create_file_card` 两个工具（命令行也能用）。
- **macOS**：在访达里双击 `.prg` 会转给前端打开（包括程序还没启动的情况）；补充了外置磁盘和网络磁盘的访问说明文字。
- **依赖**：新增 `pdfjs-dist`（Apache-2.0，可与 GPL-3.0 一起分发）和 `@ai-sdk/anthropic`（Apache-2.0）。

对上游通用代码的修正（去掉开关之前就对两种模式都生效，属于修 bug 或兼容性需要）：

- 原版欢迎页的「MIT和GPL-3.0双许可协议」改为「采用 GPL-3.0 许可协议」，与 `package.json` 一致。
- 固定侧栏是当前标签组时，新打开的工作区改插进主编辑组（`TabWorkspace.tsx`）；不可关闭的标签页不显示关闭按钮、中键也关不掉（`ProjectTabs.tsx`）。
- AI 输入框用输入法选词时按回车不再发送；API Key 输入框打码；设置页 AI 接口分组多了「AI 接口格式」。
- 「保存」「在 Finder 中显示」快捷键改用触发时传入的工程，不再读当前标签页。
- 打开含文件卡片的 `.prg` 时，卡片的渲染、删除、双击、搜索、复制粘贴、改颜色、标签照常工作（否则关掉开关打开这类文件，卡片会消失）。
- Rust：`read_folder_recursive` 遇到非 UTF-8 路径不再崩溃；`take_pending_open_files` 锁中毒时不再崩溃。

## 修改和新增的文件

依据 2026-11-01 的 `git status` 和本分支提交 `18e45ee`，按功能区域列出。标「新增」的是新文件，其余是在上游文件上修改。上游的 `app/src/locales/zh_TW.yml` 没有改动（它由 `zh_CN.yml` 自动生成）。

### 1. 程序身份、Rust 端和权限（2026-11-01）

- `app/src-tauri/Cargo.toml`
- `app/src-tauri/build.rs`
- `app/src-tauri/tauri.conf.json`
- `app/src-tauri/tauri.macos.conf.json`
- `app/src-tauri/Info.plist`
- `app/src-tauri/capabilities/default.json`
- `app/src-tauri/capabilities/desktop.json`
- `app/src-tauri/capabilities/upstream/upstream-only.json`（新增；2026-11-05 随开关一起删除）
- `app/src-tauri/src/lib.rs`
- `app/src-tauri/src/cmd/mod.rs`
- `app/src-tauri/src/cmd/fs.rs`
- `app/src-tauri/src/cmd/research.rs`（新增）
- `app/src-tauri/src/project_ownership.rs`
- `app/src-tauri/src/project_reference_store.rs`

### 2. 命令行和扩展工具链里写死的程序身份（2026-11-01）

- `app/src/cli/ProjectGraphAppDataPath.ts`
- `app/src/cli/ProjectGraphAppDataPath.test.ts`
- `app/src/cli/ProjectGraphCli.test.ts`
- `packages/extprg/src/constants.ts`

### 3. 科研模式开关、设置项（2026-11-01）

- `app/src/core/research/ResearchShell.ts`（新增）
- `app/src/core/research/ResearchShell.test.ts`（新增）
- `app/src/vite-env.d.ts`
- `app/src/core/service/Settings.tsx`
- `app/src/core/service/ProjectToolSettingsSchema.ts`
- `app/src/core/service/ProjectToolSettingsSchema.test.ts`

### 4. 外壳界面：竖栏、菜单、快捷键、欢迎页、会话恢复、标签页、设置页（2026-11-01）

- `app/src/components/activity-rail.tsx`（新增）
- `app/src/core/research/ResearchSession.ts`（新增）
- `app/src/core/research/ResearchSession.test.ts`（新增）
- `app/src/core/research/ResearchMenu.ts`（新增）
- `app/src/core/research/ResearchMenu.test.ts`（新增）
- `app/src/App.tsx`
- `app/src/main.tsx`
- `app/src/components/docked-area.tsx`
- `app/src/ProjectTabs.tsx`
- `app/src/core/TabWorkspace.tsx`
- `app/src/core/TabGroup.ts`
- `app/src/core/TabGroup.test.ts`
- `app/src/core/TabWorkspace.test.tsx`
- `app/src/components/research-welcome.tsx`（新增，2026-11-05 取代上游的 `sub/WelcomeWindow.tsx`，后者已删除）
- `app/src/components/global-menu-content.tsx`
- `app/src/components/native-macos-menu.tsx`
- `app/src/components/native-macos-menu.test.ts`
- `app/src/CommandPalette.tsx`
- `app/src/core/service/controlService/shortcutKeysEngine/shortcutKeysRegister.tsx`
- `app/src/core/service/controlService/shortcutKeysEngine/KeyBindsUI.tsx`
- `app/src/core/service/controlService/shortcutKeysEngine/GlobalShortcutManager.tsx`
- `app/src/core/subWindowOpenModes.ts`
- `app/src/sub/SettingsWindow/index.tsx`
- `app/src/sub/SettingsWindow/keybinds.tsx`
- `app/src/sub/SettingsWindow/settings.tsx`
- `app/src/sub/SettingsWindow/settings.test.ts`
- `app/src/sub/SettingsWindow/customization/index.tsx`
- 2026-11-05 删除：`app/src/sub/WelcomeWindow.tsx`、`app/src/components/welcome-page.tsx`、`app/src/sub/SettingsWindow/customization/global-menu.tsx`、`quick-settings.tsx`、`window-open-modes.tsx`

### 5. 研究文件夹和文件面板（2026-11-01）

- `app/src/core/research/ResearchFolder.ts`（新增）
- `app/src/core/research/ResearchFolder.test.ts`（新增）
- `app/src/core/research/ResearchFolderScan.test.ts`（新增）
- `app/src/core/research/ResearchFolderWorkspace.test.ts`（新增）
- `app/src/sub/FileManagerWindow.tsx`（新增）
- `app/src/core/service/GlobalMenu.tsx`
- `app/src/core/service/dataFileService/DeepLinkHandler.ts`
- `app/src/sub/RecentFilesWindow.tsx`

### 6. 文件卡片（2026-11-01）

- `app/src/core/stage/stageObject/entity/FileCardNode.tsx`（新增）
- `app/src/core/stage/stageObject/entity/FileCardNode.test.ts`（新增）
- `app/src/core/research/FileCardContent.ts`（新增）
- `app/src/core/research/FileCardContent.test.ts`（新增）
- `app/src/core/research/FileCardFactory.ts`（新增）
- `app/src/core/research/FileCardFactory.test.ts`（新增）
- `app/src/core/render/canvas2d/entityRenderer/FileCardRenderer.tsx`（新增）
- `app/src/core/render/canvas2d/entityRenderer/EntityRenderer.tsx`
- `app/src/core/stage/stageManager/StageManager.tsx`
- `app/src/core/stage/stageManager/concreteMethods/StageDeleteManager.tsx`
- `app/src/core/stage/stageManager/concreteMethods/StageObjectColorManager.tsx`
- `app/src/core/stage/stageManager/concreteMethods/StageTagManager.tsx`
- `app/src/core/service/controlService/controller/concrete/ControllerNodeEdit.tsx`
- `app/src/core/service/dataManageService/copyEngine/copyEngine.tsx`
- `app/src/core/service/dataManageService/copyEngine/copyEngineUtils.tsx`
- `app/src/core/service/dataManageService/contentSearchEngine/contentSearchEngine.tsx`
- `app/vite.config.ts`（接入 pdf.js 数据文件）
- `app/vite-plugins/pdfjs-assets.ts`（新增，提供和打包 pdf.js 的 CMap、标准字体、wasm、ICC 数据）

### 7. 拖放（2026-11-01）

- `app/src/core/research/ResearchDrop.ts`（新增）
- `app/src/core/research/ResearchDrop.test.ts`（新增）
- `app/src/DropWindowCover.tsx`

### 8. 保存：AI 文字版、工作区元数据、视野、原子写入、自动保存（2026-11-01）

- `app/src/core/research/AiSidecarBuilder.ts`（新增）
- `app/src/core/research/AiSidecarBuilder.test.ts`（新增）
- `app/src/core/Project.tsx`
- `app/src/core/ProjectSidecar.test.ts`（新增）
- `app/src/types/metadata.tsx`
- `app/src/core/stage/Camera.tsx`
- `app/src/core/stage/Camera.test.ts`
- `app/src/core/stage/stageObject/entity/ReferenceBlockNode.tsx`（跳转定位改用 `Camera.applySavedView`）
- `app/src/core/fileSystemProvider/FileSystemProviderFile.tsx`
- `app/src/core/fileSystemProvider/FileSystemProviderFile.test.ts`（新增）
- `app/src/core/service/dataFileService/AutoSaveBackupService.tsx`
- `app/src/core/service/dataFileService/AutoSaveBackupService.test.ts`

### 9. AI 对话（2026-11-01）

- `app/src/core/service/dataManageService/aiEngine/AIProvider.ts`（新增）
- `app/src/core/service/dataManageService/aiEngine/AIProvider.test.ts`（新增）
- `app/src/core/service/dataManageService/aiEngine/ResearchContext.ts`（新增）
- `app/src/core/service/dataManageService/aiEngine/ResearchContext.test.ts`（新增）
- `app/src/core/service/dataManageService/aiEngine/AIChatSessionStore.ts`
- `app/src/core/service/dataManageService/aiEngine/AIChatSessionStore.key.test.ts`（新增）
- `app/src/core/service/dataManageService/aiEngine/AIEngine.tsx`
- `app/src/core/service/dataManageService/aiEngine/BuiltInToolAgentAdapter.tsx`
- `app/src/core/service/dataManageService/aiEngine/BuiltInToolExecutors.tsx`
- `app/src/core/service/dataManageService/aiEngine/BuiltInToolRegistry.ts`
- `app/src/core/service/dataManageService/aiEngine/BuiltInToolRegistry.test.ts`
- `app/src/core/service/dataManageService/aiEngine/AITools.test.ts`
- `app/src/core/service/dataManageService/aiEngine/AIToolsAdapter.test.ts`
- `app/src/core/service/dataManageService/aiEngine/BuiltInToolConsumerAdapters.test.ts`
- `app/src/sub/AIWindow.tsx`
- `app/src/components/ui/field.tsx`（API Key 输入框打码）

### 10. 只在本机工作：关掉联网服务、协作和扩展（2026-11-01）

- `app/src/core/service/AuthClient.tsx`
- `app/src/core/service/AuthClient.test.ts`
- `app/src/core/service/FeatureFlags.tsx`
- `app/src/core/service/Telemetry.tsx`
- `app/src/core/service/Telemetry.test.ts`（新增）
- `app/src/core/service/Donations.ts`
- `app/src/core/service/Donations.test.ts`
- `app/src/core/service/AssetsRepository.tsx`
- `app/src/core/service/AssetsRepository.test.ts`（新增）
- `app/src/core/service/collaboration/CollabTransport.ts`
- `app/src/core/service/collaboration/CollabTransport.test.ts`（新增）
- `app/src/core/service/collaboration/CollabApi.ts`
- `app/src/core/service/collaboration/CollaborationService.tsx`
- `app/src/core/extension/ExtensionManager.tsx`
- `app/src/core/extension/Extension.tsx`（科研模式下不显示「安装扩展」按钮）

### 11. 界面文案（2026-11-01）

- `app/src/locales/en.yml`
- `app/src/locales/zh_CN.yml`
- `app/src/locales/zh_TWC.yml`
- `app/src/locales/id.yml`

### 12. 依赖（2026-11-01，提交 `18e45ee`）

- `app/package.json`：新增 `pdfjs-dist`（Apache-2.0）和 `@ai-sdk/anthropic`（Apache-2.0）
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`：`@ai-sdk/anthropic@3.0.137` 加进 `minimumReleaseAgeExclude`

### 13. 本文件

- `CHANGES-research-workbench.md`（新增）
