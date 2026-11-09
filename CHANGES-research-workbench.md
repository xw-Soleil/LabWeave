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
- **研究文件夹**：新增 Rust 命令 `set_research_root`，把用户选的文件夹加入文件访问范围；新增左侧文件面板（按工作区 / 论文 / 图片 / 笔记分组）；只允许打开研究文件夹里的工作区（2026-11-09 起，研究文件夹外的白板可以临时打开，见下）。
- **外壳界面**：左侧竖栏（工作区 / AI 对话 / 文件 / 设置）、精简的菜单和 macOS 原生菜单（含编辑菜单）、新快捷键 Cmd+1/2/3/N、没打开工作区时编辑区显示欢迎页（侧栏照常停靠、能拖，AI 对话收起）、启动时恢复上次的工作区和面板、命令面板白名单；设置弹窗改为「设置 / 快捷键 / 菜单 / 关于」四页，设置按用途分 10 页，原版的「个性化」拆进「外观」和「菜单」。
- **滚轮**：鼠标和触控板分开判断（只认 `wheelDelta` 这类确定的证据），默认滚轮移动、Ctrl / Cmd + 滚轮和双指捏合缩放。触控板按像素立刻移动；鼠标滚轮按格数走固定距离、每格固定缩放倍数，分几帧平滑走完（2026-11-05），每格多远、缩放多少可以在设置里调。
- **文件卡片**：新实体 `FileCardNode`，用 pdf.js 抽 PDF 的标题、页数、首页缩略图和前几页文字，也支持图片和 Markdown；双击用系统默认程序打开原文件，原文件不见了会标红。
- **拖放**：从文件面板或 Finder 把文件拖到白板生成卡片；研究文件夹外的文件经用户同意后复制到 `导入/` 子文件夹。
- **保存**：保存时在 `.workbench/` 下写给 AI 读的 `<名字>.ai.json` / `.ai.md`；`.prg` 元数据记录工作区 id 和视野；科研模式下原子写入（临时文件 + 改名），编辑后约 5 秒自动保存，备份不再写进研究文件夹。
- **AI 对话**：支持 OpenAI 兼容和 Anthropic 两种接口格式；系统提示改为中文研究助手，并附上当前白板和研究文件夹的文件清单；应用内对话只开放只读工具；新增 `dump_workspace`、`create_file_card` 两个工具（命令行也能用）。
- **macOS**：在访达里双击 `.prg` 会转给前端打开（包括程序还没启动的情况）；补充了外置磁盘和网络磁盘的访问说明文字。
- **外部 AI（MCP）**（2026-11-05）：命令行新增 `mcp` 子命令，在标准输入输出上提供 MCP 服务，Claude Code、Codex 等外部 AI 可以列出研究文件夹里的工作区、读和改白板。工具就是命令行那套内置工具，每个多一个 `workspace` 参数；新增 `list_workspaces`，以及 `create_text_node_at`（按坐标放文本卡片）、`create_section`（把卡片放进新分组）两个工具，工作区没打开时也能用。设置 → AI →「外部 AI」里有三个开关（允许修改、允许删除、允许联网），默认都开，MCP 每次调用都重新读；同一页给出能直接复制的配置命令。命令行和程序之间的本机通道（TCP）加了口令：程序启动时随机生成，随地址写进只有本账户能读的归属记录，不带口令的请求一律拒绝。
- **去掉原项目自己的文档和发版流程**（2026-11-08）：删除 `PRD.md`、`TODO.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`docs-pg/`、`docs/superpowers/`、`.trae/documents/`；删除 `.github/` 下的赞助按钮配置、禁止提 issue 的模板、发版用的脚本和工作流（nightly、publish、release、render-docs-svg），只留 LabWeave 自己的 `check.yml`。`app/README.md` 和 `stageObject/README.md` 里指向这些文件的链接改指原项目仓库（提交 `5524363`）。许可证文件和版权声明都没动。
- **画布铺满窗口，其他都浮在上面**（2026-11-08）：去掉 36px 的标题栏，窗口最上面留一条看不见的拖动区；竖栏缩成左边一根浮着的圆角小条；标签改成左上角的圆角小药丸（macOS 上让开红绿灯）；状态栏缩成左下角一小块；浅/深色切换（Windows 上加窗口按钮）放在右上角。左右固定侧栏不再和画布并排挤占宽度，改成浮在画布上的圆角卡片：固定时一直显示，取消固定后平时收起，鼠标停在竖栏「文件」按钮上或贴住窗口左右边缘约 0.3 秒就弹出、离开约 0.5 秒收回（正在面板里打字、鼠标在面板弹出的菜单上时不收回；从弹出的文件面板往画布拖文件时先收起）。卡片外侧有图钉按钮，右侧栏收起后在右下角留一个圆按钮。文件面板默认收起、AI 对话默认固定，各侧固定与否记在本机。竖栏按钮和快捷键对侧栏里的面板只切换固定/收起，不再关掉它。白板标签不能再拖进侧栏。镜头移到某个对象、适应视野时，把目标放在没被面板挡住的区域正中。
- **新的点阵背景**（2026-11-08）：点阵分粗细两层，细的一层间距是粗的一半，缩放时按屏幕上的间距淡入淡出，不再到某个缩放比例一下子变疏或变密；坐标轴上的点不再加粗。启动时把以前打开过的横线、竖线、坐标轴背景关掉一次（设置项 `researchCanvasBackgroundV1` 记下已做过），想要的话还能在设置里再打开。
- **图片卡片整张显示图片**（2026-11-08）：图片卡片不再画类型标签和标题，整张卡片就是图片（比例不一致时居中、不裁切），只描一圈很淡的边。新建的图片卡片按图片比例定大小（长边 300，短边至少 60），图片预览图最长边从 480 提到 1024 像素；以前建的 280×200 图片卡片在原来的框里按图片比例收小、居中。文件名只在鼠标移上去时显示在卡片上方。新增可选的图片标题（`FileCardNode.caption`，旧文件没有这个字段时为空）：右键「加图片标题…」填写，显示在图片左下角的小块里，清空就不显示，不改文件名；给 AI 的白板文字版里优先用它当标题。外部文件、文件不见了改成图片右上角的小块。
- **粘贴不再弹「Paste」确认**（2026-11-08）：原版在 macOS 上从系统剪贴板粘贴时用网页剪贴板接口，WebKit 读别的程序复制的内容前会先弹一个「Paste」按钮，要再点一下才贴上。现在各系统都走原生剪贴板读取（先读文字，没有文字再读图片），Cmd+V 直接贴上。删掉了设置页里本来就不显示的 `clipboardPasteMode` 设置项和网页读取代码；剪贴板里没有能贴的东西时，提示一句翻译过的话，原生报错放在下面一行。
- **粘贴在访达里复制的文件**（2026-11-08）：原来在访达 / 资源管理器里复制一个文件再 Cmd+V，只会贴出一个写着文件名的文本节点。现在粘贴时先看剪贴板里有没有复制的文件，有就和把文件拖进来一样处理：PDF、图片、Markdown 做成文件卡片（放在鼠标处），研究文件夹外的文件照样先问复制还是直接引用，.prg 作为工作区打开，其他类型提示暂不支持。Rust 端只读出路径，不碰文件本身。
- **图片上的连线端点可以拖**（2026-11-08）：原版从图片节点上拉线时，端点落在鼠标按下 / 松手的那一点，按在哪儿往往是随手的，线常常从图片中间出来。现在新拉的线在图片上也停在边框上（引用块照旧）。选中一条连线时，连在图片（粘贴的图片节点、图片文件卡片）上的那头画一个小圆点，拖它可以让箭头指着图里任意一处；离边框近会贴到边框上，拖回默认位置附近就恢复默认。端点只能在它连着的那张图里和边框上移动，不会换到别的卡片上；拖完可以撤销。停在边框上时圆点是空心的，指着图里时是实心的。文字、PDF 卡片的端点照旧。
- **临时打开研究文件夹外的白板**（2026-11-09）：原来研究文件夹外的白板一律拒绝打开。现在像 VS Code 打开单个文件那样，用户自己用选文件对话框、拖进窗口、粘贴从访达复制的白板文件、在访达里双击，都能临时打开它；`rwb://` 链接仍然只能打开研究文件夹里的白板。临时白板的标签名字是斜体、前面有一个小图标，悬停显示完整路径，状态条最前面写「研究文件夹外」。它照常编辑和保存（只写它自己），但不生成 AI 文字版、不进最近文件和启动恢复、文件改名时不跟着改，外部 AI（MCP、命令行）也改不了它；上面新放的文件卡片存完整路径。用「另存为」存进研究文件夹后就是普通工作区。命令行原来没有检查研究文件夹，这次补上。顺带修了提示里路径的 `/` 显示成 `&#x2F;` 的问题。
- **依赖**：新增 `pdfjs-dist`（Apache-2.0，可与 GPL-3.0 一起分发）、`@ai-sdk/anthropic`（Apache-2.0）、`@modelcontextprotocol/sdk`（MIT）；Rust 端新增 `getrandom`（MIT / Apache-2.0，生成本机通道口令），并直接依赖 `arboard`（MIT / Apache-2.0，原来就随剪贴板插件带进来，用来读剪贴板里的文件列表）。

对上游通用代码的修正（去掉开关之前就对两种模式都生效，属于修 bug 或兼容性需要）：

- 原版欢迎页的「MIT和GPL-3.0双许可协议」改为「采用 GPL-3.0 许可协议」，与 `package.json` 一致。
- 固定侧栏是当前标签组时，新打开的工作区改插进主编辑组（`TabWorkspace.tsx`）；不可关闭的标签页不显示关闭按钮、中键也关不掉（`ProjectTabs.tsx`）。
- AI 输入框用输入法选词时按回车不再发送；API Key 输入框打码；设置页 AI 接口分组多了「AI 接口格式」。
- 「保存」「在 Finder 中显示」快捷键改用触发时传入的工程，不再读当前标签页。
- 打开含文件卡片的 `.prg` 时，卡片的渲染、删除、双击、搜索、复制粘贴、改颜色、标签照常工作（否则关掉开关打开这类文件，卡片会消失）。
- Rust：`read_folder_recursive` 遇到非 UTF-8 路径不再崩溃；`take_pending_open_files` 锁中毒时不再崩溃。
- 命令行处理没打开的工作区时，先加载 StageManager 再读舞台（和桌面端同一顺序）。原来顺序反了，工作区里只要有分组，命令行就读不了它（2026-11-05）。

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
- `app/src/core/research/WheelGesture.ts`（新增）
- `app/src/core/research/WheelGesture.test.ts`（新增）
- `app/src/core/service/controlService/controller/concrete/ControllerCamera.tsx`
- `app/src/core/service/controlService/controller/concrete/ControllerCamera.test.ts`
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

### 13. 外部 AI（MCP）和本机通道口令（2026-11-05）

- `app/src/cli/ProjectGraphMcpServer.ts`（新增）：MCP 服务
- `app/src/cli/ProjectGraphMcpServer.test.ts`（新增）
- `app/src/cli/ExternalAiWorkspace.ts`（新增）：读程序设置、权限开关、列出和定位工作区
- `app/src/cli/ProjectGraphCli.ts`：`mcp [--app-home <dir>]` 子命令
- `app/src/cli/ProjectGraphCliRuntime.ts`：请求带上本机通道口令；结果可以收回来返回（MCP 占着标准输出）
- `app/src/cli/ClosedProjectInvocation.ts`：加载顺序修正；`create_section` 需要的分组服务
- `app/src/cli/ProjectGraphCli.test.ts`
- `packages/project-graph-cli/src/cli.mjs`：开发时默认用仓库里编译出的归属助手
- `app/src-tauri/src/project_runtime_bridge.rs`：口令生成和校验
- `app/src-tauri/src/project_ownership.rs`：归属记录文件权限 0600
- `app/src-tauri/src/cmd/research.rs`、`app/src-tauri/src/lib.rs`：`external_ai_mcp_launch` 命令（设置页拼配置命令用）
- `app/src-tauri/Cargo.toml`、`app/src-tauri/Cargo.lock`：`getrandom`
- `app/src/core/service/dataManageService/aiEngine/BuiltInToolRegistry.ts`、`BuiltInToolExecutors.tsx`、`BuiltInToolRuntimeProfiles.ts`：`create_text_node_at`、`create_section`，能力 `section`
- `app/src/core/service/dataManageService/aiEngine/BuiltInToolRegistry.test.ts`、`AIToolsAdapter.test.ts`
- `app/src/core/service/ProjectToolSettingsSchema.ts`、`app/src/core/service/Settings.tsx`：`mcpAllowEdits` / `mcpAllowDelete` / `mcpAllowNetwork`；`sectionInitBorderStyle` 移到命令行也能读的设置里
- `app/src/core/research/ResearchShell.ts`、`ResearchFolder.ts`：`isHiddenResearchName` 移到不依赖界面的模块，命令行也用
- `app/src/sub/SettingsWindow/ExternalAiPage.tsx`（新增）、`externalAiCommands.ts`（新增）、`externalAiCommands.test.ts`（新增）、`settings.tsx`
- `app/src/locales/{zh_CN,en,zh_TW}.yml`
- `app/package.json`、`pnpm-lock.yaml`：`@modelcontextprotocol/sdk`

### 14. 画布铺满窗口、侧栏浮在画布上（2026-11-08）

- `app/src/App.tsx`：去掉标题栏，加顶部拖动区和左上、右上两块浮动按钮区（宽度写进 CSS 变量给标签让位）
- `app/src/components/docked-area.tsx`：编辑区铺满；标签、状态条浮在白板上；左右侧栏改成浮动卡片（弹出/收起、图钉、拖宽、右下角圆按钮、贴边感应区）
- `app/src/components/activity-rail.tsx`：浮动圆角小条；「文件」按钮悬停弹出文件面板
- `app/src/ProjectTabs.tsx`：圆角小药丸样式
- `app/src/core/research/SidePanels.ts`（新增）、`SidePanels.test.ts`（新增）：侧栏固定/弹出状态、悬停计时、焦点切到收着的侧栏时自动固定、被挡住区域的计算
- `app/src/core/research/ViewInsets.ts`（新增）：镜头查询「画布左右被挡住多少」的接口
- `app/src/core/stage/Camera.tsx`、`Camera.test.ts`：移到对象、适应视野时避开被挡住的区域；翻页不避让
- `app/src/core/TabGroup.ts`、`TabGroup.test.ts`：`separateFixedSideGroups` 取代 `welcomeLayout` 和 `findFixedSideChild`
- `app/src/core/research/ResearchSession.ts`：面板开关改为固定/收起；恢复会话时不自动固定；注册侧栏状态跟踪
- `app/src/sub/FileManagerWindow.tsx`：开关监听挪到 `ResearchSession`；开始拖文件时收起弹出的面板
- `app/src/locales/{zh_CN,en,zh_TW}.yml`

### 15. 点阵背景（2026-11-08）

- `app/src/core/research/CanvasBackground.ts`（新增）、`CanvasBackground.test.ts`（新增）：两层点阵的间距和淡入淡出
- `app/src/core/render/canvas2d/utilsRenderer/backgroundRenderer.tsx`：`renderDotBackground` 改用两层点阵，去掉坐标轴加粗
- `app/src/core/service/Settings.tsx`：启动时关掉一次横线、竖线、坐标轴背景

### 16. 图片卡片整张显示图片（2026-11-08）

- `app/src/core/render/canvas2d/entityRenderer/FileCardRenderer.tsx`：图片卡片单独的画法（整张图、右上角和左下角的小块、淡边框）
- `app/src/core/stage/stageObject/entity/FileCardNode.tsx`、`FileCardNode.test.ts`：`caption` 字段；按图片比例算卡片大小；旧的 280×200 图片卡片解码出预览图后按比例收小
- `app/src/core/research/FileCardContent.ts`：图片预览图最长边 1024，返回图片原始宽高
- `app/src/core/research/FileCardFactory.ts`：图片卡片按比例建，一批卡片按最大的那张排格子；`promptImageCaption`
- `app/src/components/context-menu-content.tsx`：只选中一张图片卡片时多一项「加图片标题…/改图片标题…」
- `app/src/core/research/AiSidecarBuilder.ts`：有图片标题时用它当卡片标题
- `app/src/locales/{zh_CN,en,zh_TW}.yml`

### 17. 粘贴走原生剪贴板（2026-11-08）

- `app/src/core/service/dataManageService/copyEngine/copyEngine.tsx`、`copyEngine.test.ts`：三种粘贴模式合成一个 `pasteFromSystemClipboard`（原生读取，先文字后图片）；去掉写死的中文提示
- `app/src/core/service/dataManageService/copyEngine/copyEngineImage.tsx`：去掉网页剪贴板读图片；`pasteImageFromTauriClipboard` 改名 `pasteImageFromSystemClipboard`
- `app/src/core/service/Settings.tsx`、`SettingsIcons.tsx`：删掉 `clipboardPasteMode`（旧设置文件里留着的这一项读取时会被忽略）
- `app/src/locales/{zh_CN,en,zh_TW,zh_TWC,id}.yml`：删掉 `clipboardPasteMode`；新增 `research.clipboard.nothingToPaste`

### 18. 粘贴复制的文件（2026-11-08）

- `app/src-tauri/src/cmd/research.rs`、`lib.rs`：新命令 `read_clipboard_file_paths`，读出剪贴板里复制的文件路径，没有时返回空列表
- `app/src-tauri/Cargo.toml`、`Cargo.lock`：直接依赖 `arboard`（剪贴板插件不提供读文件列表）
- `app/src/core/research/ResearchDrop.ts`、`ResearchDrop.test.ts`：拖入的处理抽成 `placeFiles`；新增 `pasteClipboardFiles`，粘贴的文件走同一套流程
- `app/src/core/service/dataManageService/copyEngine/copyEngine.tsx`、`copyEngine.test.ts`：粘贴时先看有没有复制的文件，再读文字、图片

### 19. 图片上的连线端点（2026-11-08）

- `app/src/core/research/ImageEdgeEndpoints.ts`（新增）、`ImageEdgeEndpoints.test.ts`（新增）：哪些端点能拖、点中圆点、拖到哪里存什么比例（吸回默认、贴边框、夹在图里）、画圆点
- `app/src/core/service/controlService/controller/concrete/ControllerImageEdgeEndpoint.tsx`（新增）：拖端点，松手时记一步撤销
- `app/src/core/service/controlService/controller/Controller.tsx`：登记新控制器
- `ControllerAssociationReshape.tsx`、`ControllerEntityClickSelectAndMove.tsx`、`ControllerRectangleSelect.tsx`：按在端点圆点上时让开；拖端点时不拖整条线
- `ControllerNodeConnection.tsx`：只有引用块还记鼠标按下 / 松手的位置，图片上的新线停在边框上
- `app/src/core/render/canvas2d/entityRenderer/edge/EdgeRenderer.tsx`：选中连线时，连在图片上的那头画端点圆点

### 20. 临时打开研究文件夹外的白板（2026-11-09）

- `app/src/core/research/TemporaryWorkspace.ts`（新增）：`isTemporaryWorkspace(project)` 按当前路径和研究文件夹实时判断（本地文件、设了研究文件夹、文件不在里面）；`canOpenWorkspace(uri, origin)` 只给 `file-dialog`、`file-drop`、`file-paste`、`os-file` 四种用户来源放行。
- `app/src/core/service/GlobalMenu.tsx`：`onOpenFile` 新增 `origin` 参数，没声明来源时研究文件夹外的白板照旧拒绝（复用已打开的标签之前就检查）；临时白板不导入并清空旁边的同名 TXT。`main.tsx`（启动参数、访达打开事件、启动队列）、`ResearchDrop.ts`（拖入、粘贴）、`dragFileIntoStageEngine.tsx` 传各自的来源；`DeepLinkHandler.ts` 不传，链接仍只能打开研究文件夹里的白板。
- `app/src/core/Project.tsx`：临时白板保存时不写 `.workbench/` 里的 AI 文字版。`AutoSaveBackupService.tsx`：临时白板的自动备份只放应用缓存，不用自定义备份路径。
- `app/src/core/research/ResearchSession.ts`：启动会话不记录、不恢复临时白板，工作区列表不列它。`RecentFileManager.tsx`：不把临时白板加进最近文件（读取不过滤，换研究文件夹不会丢掉别的文件夹的记录）；`KeyboardRecentFilesWindow.tsx` 显示时过滤。`ResearchRename.ts`：文件改名时不改写临时白板。
- `app/src/core/research/FileCardFactory.ts`：临时白板上新放的文件卡片存完整路径；旧的相对路径照旧按白板所在文件夹解析。
- `app/src/core/research/ExternalWorkspaceAccess.ts`（新增）、`app/src/cli/ProjectGraphCliRuntime.ts`、`ProjectGraphCli.ts`：命令行按研究文件夹（解析符号链接后）检查路径，文件夹外的返回 `TEMPORARY_WORKSPACE_FORBIDDEN`，研究文件夹读不了时返回 `RESEARCH_FOLDER_UNAVAILABLE`。`app/src/core/OpenProjectRuntimeHost.ts`：外部 AI 通过已打开的白板调用工具时，临时白板一律拒绝。
- 带路径的提示（`ResearchFolder.ts`、`ResearchSession.ts`、`GlobalMenu.tsx`、`DeepLinkHandler.ts`）关闭 i18next 的 HTML 转义，`/`、`&` 不再显示成实体。
- `app/src/ProjectTabs.tsx`：临时白板的标签名字用斜体，前面加 `FolderOutput` 小图标，悬停提示「研究文件夹外，临时打开：<完整路径>」；换研究文件夹时跟着更新。`app/src/components/docked-area.tsx`：状态条最前面显示琥珀色的「研究文件夹外」，悬停说明它享受不到哪些功能、怎么变成正式工作区。新文案在 `zh_CN.yml`、`en.yml`（`research.tabs.outsideFolder`、`research.statusBar.outsideFolder`、`outsideFolderHint`），`zh_TW.yml` 重新生成。
- 测试：`TemporaryWorkspace.test.ts`、`TemporaryWorkspaceOpen.test.ts`、`ExternalWorkspaceAccess.test.ts`（新增），以及保存、会话、拖放、卡片、改名、自动备份、运行时、`ProjectTabs.test.tsx` 里的回归测试。

### 21. 本文件

- `CHANGES-research-workbench.md`（新增）
