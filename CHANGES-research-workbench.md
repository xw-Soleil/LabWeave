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
- **文字和公式混排，公式卡片并进文字卡片**（2026-11-09）：文字卡片里 `$…$`、`\(…\)` 是跟着文字排的行内公式，`$$…$$`、`\[…\]` 是单独一行、居中的块公式；钱数（`$5`）、转义的 `\$` 和写错的公式按原文显示。公式按 KaTeX 的排版盒和文字对齐，编辑时显示源码。原版单独的公式卡片（`LatexNode`）和它的编辑弹窗删除；整段都是公式的文字卡片不再被自动换成公式卡片，前后可以直接加字；旧文件里的公式卡片读入时变成无边框的文字卡片，内容是 `$$源码$$`，连线、分组、颜色、字号不变。同时修了原来公式卡片里公式偏上的问题，在 macOS 上公式按替代字体测量、右边被裁掉的问题，以及比一行字矮的公式（`\hat{x}`、`\frac{a}{b}` 等）比旁边文字低约四分之一字高的问题。细节见第 20～22 节。
- **临时打开研究文件夹外的白板**（2026-11-09）：原来研究文件夹外的白板一律拒绝打开。现在像 VS Code 打开单个文件那样，用户自己用选文件对话框、拖进窗口、粘贴从访达复制的白板文件、在访达里双击，都能临时打开它；`rwb://` 链接仍然只能打开研究文件夹里的白板。临时白板的标签名字是斜体、前面有一个小图标，悬停显示完整路径，状态条最前面写「研究文件夹外」。它照常编辑和保存（只写它自己），但不生成 AI 文字版、不进最近文件和启动恢复、文件改名时不跟着改，外部 AI（MCP、命令行）也改不了它；上面新放的文件卡片存完整路径。用「另存为」存进研究文件夹后就是普通工作区。命令行原来没有检查研究文件夹，这次补上。顺带修了提示里路径的 `/` 显示成 `&#x2F;` 的问题。细节见第 23 节。
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

### 20. 公式混排基础与公式卡片尺寸修复（2026-11-08，2026-11-09 修订）

- `app/src/core/research/InlineMath.ts`（新增）、`InlineMath.test.ts`（新增）：识别行内和块公式，保留源码，区分钱数、转义和未闭合定界符。
- `app/src/core/research/RichTextLayout.ts`（新增）、`RichTextLayout.test.ts`（新增）：独立计算混排换行、公式整块移动、块公式居中和基线；图片未就绪时按原文排版。
- `app/src/utils/textWrapping.ts`（新增）、`font.tsx`、`font.test.ts`：抽出原有文字卡片的按码点断行，供纯排版复用，原有调用结果不变。
- `app/src/core/research/MathImage.ts`（新增）、`MathImage.test.ts`（新增）、`MathImageDom.test.ts`（新增）：共用 KaTeX 出图、基线测量、有上限的异步缓存与通知；无 DOM 或生成失败时提供明确退路。
- `app/src/core/stage/stageObject/entity/LatexNode.tsx`、`LatexNode.test.ts`（新增）：改用共用出图，保留显示模式、颜色、编号留白及缩放；测量与 SVG 使用同一隔离样式，去掉块公式外边距并统一四周留白，碰撞箱随图片尺寸更新。本步不接入文字卡片的绘制或尺寸计算。
- `MathImage.ts`、`MathImageDom.test.ts`、`app/src/utils/katexEmbeddedCss.ts`、`katexEmbeddedCss.test.ts`：测量 iframe 全局复用、样式只装一次、出图串行；按文字的计算样式挑选 SVG 字体，保留正常行高并测量可见外伸、预留字形余量。旧公式卡片左上角不动，尺寸更新时同步重算祖先分组框。

### 21. 文字卡片公式混排接入（2026-11-09）

- `app/src/core/research/MathImage.ts`、`MathImageDom.test.ts`、`MathImage.test.ts`、`LatexNode.test.ts`：分开 KaTeX 排版盒与完整图片尺寸，提供排版盒在图片中的偏移；文字排版不计入图片安全留白，公式卡片仍使用整张图片定大小。
- `app/src/core/research/InlineMathService.ts`、`InlineMathService.test.ts`（新增）：按白板管理混排尺寸与绘制，按源码和模式共享公式尺寸，排版缓存与颜色无关；换色期间保留旧图，新图完成后替换，卡片不跳动。图片仍按源码、模式、颜色分别缓存；图片首次提供尺寸时只重算相关卡片，绘制不修改卡片或分组框。默认字体变更及字体加载完成时主动重算，关闭白板时退订图片、设置和字体事件。保留隐私遮罩、字体与缩放支持。
- `app/src/core/loadAllServices.tsx`、`app/src/core/stage/stageManager/StageManager.tsx`：注册白板服务，并在删除、撤销和舞台引用重建时维护公式使用索引。
- `app/src/core/stage/stageObject/entity/TextNode.tsx`、`app/src/core/render/canvas2d/entityRenderer/textNode/TextNodeRenderer.tsx`：文字卡片有公式时使用同一混排结果计算尺寸和绘制，无公式时沿用原路径。
- `app/src/core/service/controlService/controller/concrete/utilsControl.tsx`：先进入编辑并按源码重算卡片，再读取输入框初始矩形；编辑期间按源码定大小，退出后恢复混排尺寸。

### 22. 公式卡片并进文字卡片（2026-11-09）

- `app/src/core/research/LegacyMathCards.ts`、`LegacyMathCards.test.ts`（新增）：旧 `LatexNode` 在序列化数据中原地转为无边框的 `TextNode`，保持 UUID、位置、颜色、字号和引用路径；按解析结果选择可无损还原源码的块公式定界符，无法包裹时保留原文。
- `ProjectFile.ts`、`Project.tsx`、`ClosedProjectInvocation.ts`、`GlobalMenu.tsx`、`copyEngine.tsx`、`StageHistoryManager.tsx`、`CollaborationService.tsx`、扩展 RPC 的 `host.tsx`：读文件、粘贴、历史恢复和舞台替换共用反序列化前转换，不依赖文件版本。引用块、跨文件查询和打开备份文件沿用 `Project.init`。
- 删除 `LatexNode`、`LatexNodeRenderer`、`LatexEditWindow`、`convertLatexNodes` 及旧专用测试；清理注册、编辑、删除、改色、字号快捷键和类型声明中的专用分支。打开文件和编辑结束不再把文字卡片转换成公式卡片。实时编辑预览和 `extractLatexSource` 保留。
- `AiSidecarBuilder.ts`：公式沿文字卡片的规则输出类型与含定界符的源码。`ProjectSidecar.test.ts`、`ProjectGraphCli.test.ts`、`copyEngine.test.ts` 覆盖旧文件读写、连线分组引用、命令行修改和旧剪贴板粘贴。
- `InlineMathService.test.ts`、`MathImageDom.test.ts`：锁住整张卡片仅有一个块公式时排版盒的四周居中，以及公式文字卡片编辑后仍能添加前后文字；沿用已有对称行高留白和图片偏移计算。
- WebKit 右侧裁切修复：`MathImage.ts` 的共享测量 iframe 改为屏外 4096×4096 视口；初始化时显式等待所有内嵌字体的 `FontFace.load()` 并加入测量文档，避免仅靠 `fonts.ready` 测到后备字体。公式根元素按内容自然宽度测量，SVG 中保留实测宽高；`foreignObject` 覆盖整张图片，用内部留白定位内容，不再依赖溢出绘制。
- `katexEmbeddedCss.ts` 导出字体加载源，与 SVG 字体子集使用同一份资源；移除不再使用的全量字体 CSS 拼接。`MathImageDom.test.ts`、`katexEmbeddedCss.test.ts` 覆盖字体加载顺序、共享与重建、加载失败、非零视口、完整图片范围，以及矩阵、积分、求和、大号括号和根号的字体或 SVG 路径。
- 字体由测量 iframe 自己窗口的 `FontFace` 构造函数创建；加载失败时移除该 iframe 并清空测量缓存，让下一条公式重新初始化。测试锁住窗口归属，以及前一条失败、后一条成功且失败公式不自动重试的行为。
- 矮公式基线修复：测量 iframe 原是没有文档类型声明的空白文档，按怪异模式排版，不含文字的行内盒不撑行高；SVG 图片里的 XHTML 按标准模式排版，会给 `.katex` 留出一行文字的上半部分。比这个高度矮的公式在图里因此比量出的基线低约 0.2 个 KaTeX 字高。`MathImage.ts` 建好 iframe 后写入 `<!DOCTYPE html>`，两边同用标准模式；`MathImageDom.test.ts` 锁住测量文档为标准模式。

### 23. 临时打开研究文件夹外的白板（2026-11-09）

- `app/src/core/research/TemporaryWorkspace.ts`（新增）：`isTemporaryWorkspace(project)` 按当前路径和研究文件夹实时判断（本地文件、设了研究文件夹、文件不在里面）；`canOpenWorkspace(uri, origin)` 只给 `file-dialog`、`file-drop`、`file-paste`、`os-file` 四种用户来源放行。
- `app/src/core/service/GlobalMenu.tsx`：`onOpenFile` 新增 `origin` 参数，没声明来源时研究文件夹外的白板照旧拒绝（复用已打开的标签之前就检查）；临时白板不导入并清空旁边的同名 TXT。`main.tsx`（启动参数、访达打开事件、启动队列）、`ResearchDrop.ts`（拖入、粘贴）、`dragFileIntoStageEngine.tsx` 传各自的来源；`DeepLinkHandler.ts` 不传，链接仍只能打开研究文件夹里的白板。
- `app/src/core/Project.tsx`：临时白板保存时不写 `.workbench/` 里的 AI 文字版。`AutoSaveBackupService.tsx`：临时白板的自动备份只放应用缓存，不用自定义备份路径。
- `app/src/core/research/ResearchSession.ts`：启动会话不记录、不恢复临时白板，工作区列表不列它。`RecentFileManager.tsx`：不把临时白板加进最近文件（读取不过滤，换研究文件夹不会丢掉别的文件夹的记录）；`KeyboardRecentFilesWindow.tsx` 显示时过滤。`ResearchRename.ts`：文件改名时不改写临时白板。
- `app/src/core/research/FileCardFactory.ts`：临时白板上新放的文件卡片存完整路径；旧的相对路径照旧按白板所在文件夹解析。
- `app/src/core/research/ExternalWorkspaceAccess.ts`（新增）、`app/src/cli/ProjectGraphCliRuntime.ts`、`ProjectGraphCli.ts`：命令行按研究文件夹（解析符号链接后）检查路径，文件夹外的返回 `TEMPORARY_WORKSPACE_FORBIDDEN`，研究文件夹读不了时返回 `RESEARCH_FOLDER_UNAVAILABLE`。`app/src/core/OpenProjectRuntimeHost.ts`：外部 AI 通过已打开的白板调用工具时，临时白板一律拒绝。
- 带路径的提示（`ResearchFolder.ts`、`ResearchSession.ts`、`GlobalMenu.tsx`、`DeepLinkHandler.ts`）关闭 i18next 的 HTML 转义，`/`、`&` 不再显示成实体。
- `app/src/ProjectTabs.tsx`：临时白板的标签名字用斜体，前面加 `FolderOutput` 小图标，悬停提示「研究文件夹外，临时打开：<完整路径>」；换研究文件夹时跟着更新。`app/src/components/docked-area.tsx`：状态条最前面显示琥珀色的「研究文件夹外」，悬停说明它享受不到哪些功能、怎么变成正式工作区。新文案在 `zh_CN.yml`、`en.yml`（`research.tabs.outsideFolder`、`research.statusBar.outsideFolder`、`outsideFolderHint`），`zh_TW.yml` 重新生成。
- 测试：`TemporaryWorkspace.test.ts`、`TemporaryWorkspaceOpen.test.ts`、`ExternalWorkspaceAccess.test.ts`（新增），以及保存、会话、拖放、卡片、改名、自动备份、运行时、`ProjectTabs.test.tsx` 里的回归测试。

### 24. 项目占用测试的等待余量（2026-11-09）

- `app/src-tauri/src/project_ownership.rs`：原版的 4 条测试只给线程留 10～80 毫秒余量，GitHub 的 macOS 机器忙时超时失败。`connectable_owner_waits_for_in_flight_owner_inspection` 的重试间隔改为 500 毫秒；`ownership_and_owner_record_share_one_retry_budget` 的重试间隔改为 500 毫秒，另一把锁占 1.5 秒，上限改为 1.6 倍重试间隔，现在能分辨两把锁共用一次重试和各自重试，原来分辨不出；`contended_acquisition_does_not_block_unrelated_desktop_release` 的重试间隔改为 1 秒，上限 500 毫秒；`concurrent_same_project_acquisition_reuses_the_first_desktop_owner` 的重试间隔改为 1 秒。只改测试，程序逻辑不变。

### 25. 本机 AI 会话的模式、模型与权限请求（2026-11-09）

- `LocalAgent.ts`：优先读取 ACP `configOptions`，兼容旧模式和模型字段，提供切换方法和控制项回调。开会话时照两个 VS Code 插件的做法沿用程序自己配置里的默认模式和模型，不替用户切换，模式列表原样保留。处理模式、配置和斜杠命令（`available_commands_update`）通知，按会话保留控制项；停止读取三档权限，非白板请求统一等待界面选择，白板工具识别和自动允许规则保留。
- `LocalAgentTransport.ts`：提供控制项订阅、发送前准备会话和模式／模型切换方法（只改当前会话），关闭连接时清空控制项。
- `LocalAgent.test.ts`、`LocalAgentTransport.test.ts`：按 Codex、Claude 实测控制项和命令构造测试数据，覆盖沿用程序默认、协议调用、通知、加载、多会话、切换失败，以及权限卡片、白板识别和取消。

### 26. AI 面板改成插件式的输入框（2026-11-09）

- `app/src/sub/AIWindow.tsx`：输入框改成一个圆角框，从上到下是上下文小标签（当前白板；有选中时显示「已选 N 个」，点 × 这条消息不带选中内容，换了选中自动恢复）、打字区、底栏。底栏放斜杠命令按钮、权限模式、模型、上下文用量小圆圈和圆形发送/停止按钮；来源下拉仍在标题下面。上下文小圆圈：用接口时按原来的上下文窗口计算，用本机程序时取程序每轮报的已用量和上限。原来输入框上方的「已选中 N 个节点」、Token 数和「准备就绪」一行去掉，Token 数改到小圆圈旁（仍由「显示 Token 数」设置控制），上下文细节放在悬停提示里。用本机程序时，输入框里只打了「/开头的一个词」或点底栏的 / 按钮，会在输入框上方弹出程序报上来的命令（如 `/compact`），可用方向键、回车、Tab、Esc 操作；以 / 开头的消息不加选中内容的前缀，保证程序认得出是命令。你的消息改成浅底圆角块，AI 的回答不再套气泡、不显示头像，工具调用折成一行（状态圆点、工具名，跑着或失败时带一句状态）。打开面板或切换会话时提前启动本机程序，模型和模式下拉不必等第一条消息。新文案进 `zh_CN.yml`、`en.yml`（`ai.composer.*`）。
- `app/src/sub/AIWindowLocalAgent.tsx`：新增模型下拉、权限模式下拉（列程序自带的全部模式，名字和说明照程序给的原样显示；不受限制的几档用红色盾牌和红字标出）和订阅控制项的钩子。权限卡片改成插件样式：写明要做什么，跑命令时单独摆出命令，程序给的选项竖排，允许在前、拒绝在后。
- 删除设置项「本机 AI 程序的权限」（`aiLocalAgentPermission`）：`Settings.tsx` 的定义、设置页条目和中英文案，`zh_TW.yml` 重新生成。旧设置文件里残留的这个键读入时被跳过。`LocalAgentTransport.test.ts` 去掉对它的引用，并检查它已不在设置定义里。

### 27. AI 面板的斜杠命令、复制和白板挪卡片（2026-11-10）

- `LocalAgent.ts`：新增 `isLocalAgentCommand`（整段以 `/` 加非空白字符开头）。`mapSessionUpdate` 按 `messageId` 分段：同一轮里程序发来的不同消息各成一段；Claude Code 的本地命令（实测 `/context`）会换一个 `messageId` 把同一段结果再发一遍，内容一样的第二条不显示。
- `LocalAgentTransport.ts`：斜杠命令单独作为整段提示词发出，前面不再拼研究助手说明、工作区路径、白板文字版和历史，否则程序把命令当普通文字交给模型。第一条就是命令时，这些说明留到下一条普通消息。
- `app/src/sub/AIWindow.tsx`：全局样式给每个元素都设了不可选中，消息外框的 `select-text` 管不到里面的段落，改为连子元素一起放开，消息文字能选中、Cmd+C 复制；回答结束后，鼠标移上去出现复制按钮，复制这条回答的全部文字。新文案 `ai.composer.copy`、`ai.composer.copied`。
- `app/src/core/service/controlService/autoLayoutEngine/mainTick.tsx`：DAG 布局里同一列的卡片原来按「序号 × 100」摆，200 高的卡片会叠在一起；改为从上一张的底边再往下留 50。
- `BuiltInToolRegistry.ts`、`BuiltInToolExecutors.tsx`：新增白板工具 `move_nodes`，一次把一张或几张卡片挪到给定的世界坐标，引用不变；挪分组时里面的卡片一起走，先挪外层。工作区没打开时也能用（要用特效服务，因为分组里的卡片移动时会加残影）。`ProjectGraphMcpServer.ts` 的说明里加上：摆新卡片避开已有的，调位置用 `move_nodes`，不要删掉重建。
- 测试：`LocalAgent.test.ts`（按实测数据去重、分段）、`LocalAgentTransport.test.ts`（命令单独发、说明留到下一条）、`mainTick.test.ts`（高卡片不重叠）、`ProjectGraphCli.test.ts`（关着的工作区里挪卡片和分组、重复引用报错），以及工具数量相关的测试。

### 28. 上下文用量弹层（2026-11-10）

- `LocalAgent.ts`：新增 `LOCAL_AGENT_CONTEXT_COMMANDS`（Claude Code 用 `/context`、在副本里跑；Codex 用 `/status`、在原会话里跑）、`LocalAgentConnection.runQuietCommand`（回复交给收集器，不送进聊天界面；副本用 unstable 入口的 `session/fork` 复制，复制不了时用 `session/new` 新开，换成和原会话一样的模型，跑完 `session/delete`）和 `parseLocalAgentContext`（解析「**名字:** 值」行和 Markdown 表格）。实测依据：Claude Code 的 `/context` 每跑一次约 2.3k token 记进对话；Codex 的 `/status` 不进对话记录；删掉副本后它的程序进程会退出。
- `LocalAgentTransport.ts`：会话记下工作目录和 MCP 设置；新增 `inspectContext`，和发消息排在同一个队列里。
- `app/src/sub/AIWindowLocalAgent.tsx`：新增盖在 AI 面板上的「上下文用量」弹层：模型、总量、分色进度条、分类表（按需加载的几项灰色、不计入）、记忆文件和其他明细（可折叠）；Codex 显示总量和 `/status` 的逐项内容；格式读不出时显示程序原文。
- `app/src/sub/AIWindow.tsx`：点上下文小圆圈、在命令菜单里选、或发出 `/context`（Codex 是 `/status`）都打开弹层，不进对话。顺手修了复制按钮的提示文字取错了文案命名空间。文案 `ai.composer.contextOpen`、`ai.contextDialog.*`，`zh_TW.yml` 重新生成。
- `LocalAgent.test.ts`：副本、复制不了时新开、原会话直接跑三种情况，以及两种输出格式的解析。

### 29. Markdown 编辑与 PDF 阅读标签页（2026-11-10）

- 文件卡片、文件面板双击 Markdown / PDF 时，在编辑区打开可复用的文档标签；图片等其他文件保持系统打开。两个右键菜单增加「用系统程序打开」。
- Markdown 使用源码编辑和实时预览，复用 shadcn、remark、KaTeX：支持公式、表格和按文档目录解析的本地图片；图片走原有文件访问权限，不自动请求远程图片。不改原始 BOM、换行和未编辑的文本；保存前比较磁盘内容与修改时间，冲突时保留编辑、提示重新读取；标签标记未保存，Cmd+S 和菜单保存当前文档，关闭标签及退出应用时提示。
- PDF 复用 pdf.js 的 legacy 阅读器组件，支持按需页面渲染、文字选择、缩放和跳页。通过原有 scoped fs 文件句柄按范围读取，底层单次读取不超过 64 KiB；禁用自动预取和完整数据流。独立 worker、读取/打开期限及强制终止处理 WKWebView 卡住和释放不返回的问题。
- 新增路径、原文保真、保存冲突、并发读写、范围读取、worker 生命周期、标签去重/关闭、键盘路由、预览和菜单测试；六份示例笔记只在临时目录的副本上验证。新文案进中英文，繁体由同步命令生成。
- 同日审查修正：重读与保存互斥，重读不覆盖期间的新编辑；键盘焦点进入文档时同步保存目标。按文件当前身份判断别名，避免外部移动或原子替换后错切标签。Markdown 预览不交给 WebView 导航，不从正文链接启动其他本地程序，拒绝绝对路径和混合斜杠的图片地址。
- PDF 标签切换后恢复页码与缩放，适合宽度随容器变化；每个当前页的渲染都有期限。传入阅读器的生命周期信号，清除内部监听和观察器，关闭后的实际清理错误仍会提示。

### 30. PDF 封面卡片与按范围读取（2026-11-10）

- PDF 卡片从「小缩略图 + 摘录」改为「标题 + 按比例完整首页」，纸面保持白色，深色主题也清楚。新卡片为 240×340；旧卡片不挪位置、不改尺寸。文件名仍可悬停查看，缺失和外部文件标记保留。
- `FileCardFactory` 新建 PDF 时不再调用整文件 `readFile`，复用文档阅读器的 64 KiB 分段读取、按需加载和独立 worker。右键新增「刷新 PDF 卡片」，复用相同读取路径，刷新失败时保留旧卡片；解析期间关闭白板或删除卡片不会重新写回它。
- `FileCardContent` 先生成最长边 480 像素的首页，再按已有设置抽前几页、最多 4000 字。摘录仍保存到 `excerpt`，研究上下文、sidecar、`dump_workspace`、关闭工作区的 CLI/MCP 不需要重新读取 PDF。没有新增 OCR；扫描件没有文本层时保留提示。
- PDF 打开、单页渲染、文字流、整个卡片处理和释放都有期限；无结束信号的文字流会停止，无法读到首块文字时不再逐页空等。取消异常交给界面提示，释放超时后终止实际 worker，不继续累积后台解析器。
- 新增封面绘制、创建/刷新数据、文字限量/超时、CLI/MCP 离线摘录回归测试；以示例文件做真实 pdf.js 范围读取、首页栅格渲染和进程内存测量，测量不代表 WKWebView 的实际峰值。文案与自动生成繁体同步更新。
- 同日审查修正：PDF 打开与 stat 也受取消/期限约束，关闭句柄不再等待卡住的读取；超时终止会话，取消文字流与封面渲染，不接收关闭后的结果。刷新有部分解析错误时保留原卡片，关闭摘录后清空旧 AI 文本；卡片释放后才解码完成的位图立即关闭。补充这些路径及关闭白板/删除卡片的回归测试。

### 31. 工作区、项目与文件目录树（2026-11-10）

- 文件面板从按类型分组的平铺列表改为「工作区清单 → 项目文件夹 → 真实子目录与文件」。工作区可以命名，项目可以位于不同磁盘；目录展开才读一层，不设树深度上限，隐藏文件和符号链接不列。找不到或无法访问的项目在行内提示，可刷新或移除。
- 复用现有 shadcn 对话框、菜单、输入框和文件行样式，新增软件内文件夹浏览：主目录、macOS `/Volumes`、Windows 盘符和最近选过的项目；添加已有项目、新建文件夹并加入清单、确认后移除项目均不使用系统文件选择窗口，移除不删除磁盘文件。
- 新增 `ResearchWorkspace.ts`，持久化到应用数据目录的 `research-workspaces.json`：保存工作区名称、项目清单、最近项目和各项目的白板会话。第一次仅加入当前研究文件夹；结构包含工作区 ID 与工作区数组，不新增设置项。审查后桌面端改为固定文件的 Rust 读写命令，保持原 JSON 格式，区分缺失、损坏和读取失败，用文件锁、旧值校验及原子替换防止并发覆盖或半写文件。
- 侧栏通过事件交给 `ResearchSession` 切项目。先校验目标，再逐个处理白板和 Markdown 的保存、放弃或取消；保留旧标签，目标白板全部加载成功才显示目标标签并提交切换。取消、保存/加载失败、移除清单写盘失败会恢复原项目、标签内容、布局、焦点和会话。跨项目 `.prg` 打开、拖放都先切项目，不作为临时白板；其他项目的 Markdown/PDF 直接在软件内打开。重命名和删除其他项目文件时先切项目，再沿用原有引用更新及回收站逻辑。
- 保留文件右键菜单、系统打开、拖文件到画布、已打开标记和当前项目搜索；搜索使用原有深度及条数限制，并可搜索 Word、Excel 等其他文件，AI/卡片的原有扫描默认不变。中英文界面的 `.prg` 统一称「白板」，研究文件夹称「当前项目」，繁体由同步命令生成。
- Rust 新增只授权而不切换的 `authorize_research_project`，与 `set_research_root` 共用目录授权代码，仅登记用户选中的项目及其路径别名；移除当前项目时可清空研究根目录。未修改 capabilities，未增加依赖。
- 测试覆盖清单迁移与重载、失败重试、创建重名保护、隐藏文件、深层目录、Windows/UNC 路径、软件内浏览、只授权选中项目、跨项目打开与拖放、移除确认、保存取消/冲突及会话恢复。Rust 增加授权路径别名不扩展到父目录的回归测试。
- 同日严格审查修正：切项目与关窗口互斥；后台目录登记串行，回滚只能恢复本次进程已登记的根目录，磁盘临时失联也不会阻止恢复。确认后再次编辑会取消切换；第一次选择项目保留草稿供拖放继续使用。切换中的草稿保存使用软件内命名并拒绝覆盖同名文件，不再弹系统保存窗口。
- 系统拖放、粘贴及其他打开入口也识别清单中的项目；最近文件在切换成功后才更新。修正 `/` 与空路径混淆、POSIX 大小写项目去重，并验证授权路径别名确实指向选中的目录。
- 大目录每次显示 200 项，可继续显示；一个磁盘读取失败不再挡住其他浏览起点。浏览器增加完整路径输入，未映射盘符的 UNC 共享也可进入；浏览本身仍不授权，只有明确选择才加入项目。清单错误独立展示，不因搜索而被清除。

### 32. PDF 阅读缩放手势与快捷键（2026-11-10）

- PDF 阅读区接入 Ctrl/Cmd 滚轮和带小数增量的触控板捏合，按帧合并连续事件，保留不足 1% 的缩放余量。通过 pdf.js 的鼠标锚点缩放保持指向位置，修正嵌套阅读区的坐标偏移；150 毫秒内复用画面，停止手势后再精绘。
- Cmd/Ctrl 加 `+`、`=`、`-`、`0` 在当前 PDF 中缩放或恢复 100%；工具栏和手势统一限制在 25%～400%，比例与标签记忆同步。消费缩放事件，阻止 WebView 整体缩放、滚动及全局白板快捷键；普通滚动和其他输入保持原行为，关闭标签清除监听与待执行帧。
- 测试覆盖两种修饰键、三种滚轮单位、小数捏合、连续输入合帧、嵌套坐标、边界、键盘、全局事件隔离、关闭清理及工具栏同步。

### 33. PDF 打开时的范围读取开销（2026-11-10）

- 扩展 `PdfRangeSamples.test.ts`，用真实 pdf.js、已有 Node canvas 和五份只读样本分别测库/worker 初始化、文档解析、首页栅格化、限量文字提取；记录每次范围请求和底层 seek/read 的字节数及往返耗时，支持重复测量与显式标注的 IPC 延迟模拟。Node 使用同线程 fake worker，不能代表 WKWebView worker、文字层 DOM、IPC 或屏幕绘制耗时；当前阅读页没有启动缩略图、大纲或摘录任务。
- 单块从 64 KiB 调整为 256 KiB，保留禁止预取、范围读取、权限检查和生命周期。相邻读取直接沿用句柄位置，失败后强制重新 seek，短读、乱序请求、关闭与取消仍有保护。
- 五份样本首页底层调用数依次从 16/11/37/16/8 降为 8/6/21/10/4；三轮 Node 本地读中位数变化不大，主要时间在栅格化。每次 seek/read 人为加入 3 毫秒的对照中，首页中位数从 100/90/194/101/97 毫秒降为 65/67/143/73/77 毫秒。这是 IPC 敏感性模拟，不是应用实测。
- 取舍：更大的范围会多读邻近数据；`main.pdf` 首页由 1.32 MB 增至 3.29 MB，两份不足 1 MB 的论文会读完整份。也比较过 128 KiB，调用数下降较少。新增连续读取、失败后的游标恢复、小文件和合并大范围的测试。

### 34. 本机 AI 会话恢复与回退提示（2026-11-10）

- 检查本分支的项目目录、白板恢复与存储键改动：AI 仍按白板 `workbench.id` 查找聊天记录，再把同程序的 ACP 会话号交给 `session/load`；新增 POSIX/Windows 路径改名后保持绑定的测试。
- 用实际 `LocalAgentConnection` 和完整 `LocalAgentTransport` 连接真实 Claude 转接器，只允许 initialize/load，不允许创建或发送；原会话 `11ebbc7f…` 均可载入，完整准备改前约 577 毫秒、改后约 575 毫秒，原 JSONL 哈希不变。探针只在存储副本中指定原会话号，未覆盖开发版后来保存的新绑定。历史那次载入错误已被旧 catch 丢弃，无法反推出当时失败的触发条件。
- 修复可重现的关闭/热重载竞态：旧 transport 已被取消时，迟到的打开结果仍会覆盖磁盘绑定。现在在载入前、载入后、写队列真正落盘前检查取消；已关闭的连接也不再请求新会话。
- 普通载入失败和不支持载入仍可新开后备，但返回并持久化失败原因、原会话号及当时目录；输入框上方用现有 Alert 显示「没接上上次的对话、已新开」和实际原因。提示随聊天切换，重启载入后备时仍保留。登录/断连错误继续走原错误提示，不伪装为可恢复的失败。
- 新增重启后首条 `/compact` 指向原会话且不拼历史、取消后禁止覆盖、排队写入取消、失败提示跨切换/保存/重启、无效存储字段，以及中英文界面提示测试；繁体由同步命令生成。没有改写或删除已有 Claude 会话文件，也没有向真实模型发送消息。

### 35. PDF 与本机 AI 会话恢复复审（2026-11-10）

- PDF 缩放快捷键改在阅读区内监听；点击页面或用 Tab 聚焦后生效，不抢侧栏、弹窗和其他分屏的按键。保留普通滚动、鼠标锚点换算、按帧合并及 pdf.js 延迟精绘；切标签与关闭时释放监听和待执行帧。
- 保持 256 KiB 范围读取实现，补充块边界、文件末尾、短读、底层游标已移动后的失败重试，以及 seek/read 挂起时立即关闭且不继续排队读取的测试。
- 恢复失败提示使用本地化原因，不再展示或新存原始错误 JSON、路径等诊断数据；旧格式读取时过滤这些字段。提示按聊天、按程序保留，用户点「知道了」后持久清除，新的恢复失败仍会再次提示。清除失败有可见提示。
- 同一聊天分别保留 Codex、Claude Code 的外部会话绑定，兼容并迁移旧单程序格式，切换程序再返回不会丢失原会话。取消若发生在存储 IPC 已开始之后，写队列会恢复原记录，再允许后续读写继续。
- 载入期间隐藏上一聊天的恢复提示与控制项，禁止修改尚未载入的会话模式或模型；上下文弹层、斜杠命令继续排在载入之后。复制上下文失败只在本次连接中新建且尚未发消息的会话明确不存在时使用临时空会话，其他错误交给弹层显示，不再伪造已有会话的上下文用量。
- 增加上述竞态、格式迁移、按程序恢复、提示生命周期、中英文文案与命令顺序回归测试；未增加依赖，未修改 Rust、权限配置或真实 AI 对话记录。

### 36. EmbedPDF 离线阅读器（2026-11-10）

- PDF 阅读标签由 pdf.js legacy viewer 换为 EmbedPDF 2.15.1 headless；界面独立放在 `PdfView.tsx`，沿用原有文档标签、去重、关闭和系统打开入口。画布 PDF 卡片、AI 摘录及 `PdfDocument.ts` 的 pdf.js 范围读取保持不变。
- 新增可收起的缩略图、大纲和批注占位侧栏；工具栏提供页码、跳页、整页/宽度自适应、实际大小、25%～400% 缩放、文字复制及全文检索。搜索显示结果计数、页面高亮，支持 Enter/Shift+Enter、Esc；保留阅读区内鼠标锚点滚轮、键盘和 WebKit 捏合手势，深浅主题复用现有组件与配色。
- 页面使用虚拟滚动、低分辨率底图和可见区域瓦片精绘，保留 PDF 原有批注与表单的只读外观。文字选择与复制遵守文档权限；本轮没有批注编辑、撤销或 PDF 写回。
- PDFium 仅在本地 Vite worker 中运行，WASM 使用本地资源。核实 2.15.1 只能完整缓冲区打开，因此通过已有 scoped 文件句柄、256 KiB 底层读取拼成整份数据，再 transfer 给 worker；标签切换和关闭直接终止 worker，打开、渲染和异常有期限、提示与重试，恢复数值缩放时等待视口尺寸就绪。
- 禁用 EmbedPDF 的默认 CDN 字体配置。样本发现未嵌入 STSong 时会缺中文字，改为仅按需复用程序原有的 `NotoSansSC-Regular.otf`（8,331,336 字节），字体读取失败显式通知界面。没有新增字体资产或引入约 40 MB 的备用字体包，没有修改依赖、权限配置或 Rust。
- 新增 worker 生命周期、离线资产白名单、文件取消/关闭、导航、真实插件搜索高亮、跨行拖选与复制、手势和标签恢复测试。五份只读样本各测三轮首页、翻页、放大和内存，并比较旧 pdf.js 测量；Node 数据不代表 WebView 启动、IPC 和实际屏幕绘制。中英文文案已同步，繁体由脚本生成。

### 37. EmbedPDF 阅读器第 1 步审查修复（2026-11-10）

- 完整读取前校验文件大小，超过 128 MiB 时停止并提示使用系统程序打开，避免直接分配超大 PDF 缓冲区；打开取消后迟到的句柄清理错误仍会提示。
- 修复上游 worker 忽略取消请求、主线程保留已取消任务及消息发送异常被吞掉的问题。搜索和渲染的取消传到实际任务队列，读取器 worker 只接受阅读所需的方法，不接受 URL 打开、脚本或写入方法。
- 补正文链接和大纲外部链接：文内目标跳页，HTTP(S) 链接仅在点击时交给系统浏览器；文件、启动程序及脚本链接不可交互。读取和显示已有链接不启用批注编辑，不写 PDF。
- 通过父级捕获图片事件观察绘制，保留 EmbedPDF 自己的对象 URL 释放回调；瓦片及缩略图解码失败显示错误与重试。搜索快捷键限制在正文与搜索栏。
- 增加超限文件、取消队列、迟到回调、搜索竞态、链接安全、反复开关回收、缩放恢复、缩略图导航及 PDF 并发去重测试；同步中英文和自动生成繁体文案。保持本地 WASM、worker 与按需备用字体配置，没有改动依赖、Rust、权限或卡片的 pdf.js 实现。

### 38. Zotero 式 PDF 批注（2026-11-10）

- 阅读器新增高亮、下划线、便签、文字框、图片区域、手绘和局部橡皮擦，使用核对过的 Zotero 八色；选区旁提供颜色、标注类型、复制和加备注菜单。侧栏从占位改为批注卡片，支持跳转、备注、标签、颜色、删除及文字/颜色筛选，复用现有 shadcn 组件与深浅主题。
- 批注使用 Zotero 的字段、PDF 用户坐标、三位小数精度、对象标签、八字符 ID 和 `页|字符偏移|上边距` 排序键；跨相邻页使用 `nextPageRects`。原 PDF 的已有批注仍由 PDFium 渲染，侧栏标为外部只读批注，不混入新批注 JSON。只参考 Zotero 数据与行为，没有复制 AGPL 代码。
- 项目批注存入 `.workbench/annotations/<PDF 相对路径>.json`，项目外使用应用数据目录下的规范化路径 SHA-256；新增 Rust 命令只接受已授权项目键、受限相对 PDF 名、回收站条目键或外部路径哈希。写入使用同目录临时文件、锁、内容与时间修订检查及原子替换，拒绝目录逃逸、符号链接和目标覆盖，不扩大原有文件权限或 capabilities。
- 接入改名、回收站及恢复事务；批注移动失败时保留原 PDF、回退引用与批注路径，打开的 PDF 标签跟随新路径。支持 500 毫秒自动保存、显式保存、冲突提示、重新载入和关闭前保存/放弃；撤销重做保留在标签中，切标签后仍可用，文本输入框沿用系统撤销。
- 新增格式、坐标、排序、JSON 冲突、改名/回收站、真实 PDFium 旋转裁切页和组件交互测试；重测指定五份离线样本及 1000 条批注的模型耗时和内存。保持第 1 步 worker 的只读方法白名单、已有本地字体和卡片的 pdf.js 实现，没有新增或变更依赖，没有运行构建。

### 39. PDF 批注审查修复（2026-11-10）

- 目录访问改为持有目录句柄：Unix 使用相对句柄的文件操作，Windows 拒绝 reparse point 并在操作期间禁止目录改名，防止路径检查后的符号链接替换；补全设备名、路径长度和 Rust 端批注结构校验，损坏数组不覆盖，临时文件创建失败不清理他人的文件，Unix 原子发布后同步父目录。
- 回收站批注统一写入 `.workbench/annotations/.trash/<条目 ID>.json`，旧位置只读迁移并保留恢复副本；重新打开回收站 PDF 使用同一份批注。恢复 PDF 的清理失败可回退重试，批注回滚失败后阻止继续向错误位置保存；授权等待期间切换项目也保持原 PDF 的存储位置。
- 创建批注、选区摘录及擦除的异步操作跟随文档标签，切标签时延后释放引擎，保存和关闭等待操作完成。首次创建时通过已有 pdf.js 范围读取器只读取页标签元数据并释放，缓存罗马数字及自定义标签；阅读渲染仍用 EmbedPDF。
- 修正 CropBox 超出 MediaBox 时引擎的坐标原点，补充四种旋转和不同页框尺寸的真实引擎测试；统一手绘线宽、文字字号和擦除半径的 PDF 单位换算，避免大量导入矩形的边界计算触发参数栈溢出。
- 增加目录替换、损坏记录、旧回收站迁移、恢复失败、未完成批注切换/关闭、页标签和离线元数据测试。没有变更依赖或 capabilities；Zotero 字符偏移仍依赖 PDFium 字符顺序，不能承诺与 Zotero 逐值相等，具体影响写入仓库外审查报告。

### 40. PDF 高亮样子、选区颜色、文档时面板停靠（2026-11-10）

- `app/src/core/research/PdfAnnotationUI.tsx`：高亮改为整条批注一层统一上色，透明度加在整层上（行与行重叠处不再叠深），每行上下放宽一点连成一片，不描边；选中时只是颜色稍深（不再画外框），悬停稍加深。点页面空白处或按 Esc 取消选中（点批注本身、侧栏卡片、工具栏不取消）。下划线、便签等其他类型不变。
- `app/src/core/research/PdfView.tsx`：选中文字的底色改为半透明浅蓝（`rgba(0, 122, 255, 0.2)`），原来是 EmbedPDF 默认的深蓝。
- `app/src/components/docked-area.tsx`：编辑区某一组显示的不是白板（Markdown、PDF 等）时，这组内容给左边竖栏和固定住的左右面板让出位置，切换时 0.2 秒平滑滑开；白板组照旧铺满、面板浮在上面，画布尺寸不变。临时弹出的面板仍盖在上面。
- `app/vite.config.ts`：开发版启动时预先打包 EmbedPDF，第一次打开 PDF 时不再整页刷新（开发版专用）。

### 41. 本文件

- `CHANGES-research-workbench.md`（新增）

### 42. 文献阅读后台第 A 步（2026-11-10）

- 新增 `Translate.ts`：通过已有 Tauri HTTP 调用 Google/Bing 网页翻译，首选失败时自动互换；AI 模式复用现有模型配置、供应商适配和自定义请求头。按中文占比决定翻译方向，清理 PDF 断行，提供单词读音与词性释义、300 条内存缓存、取消和稳定错误代码。新增 `translateService` 设置，放在 AI 页的翻译分组；中英文文案及自动生成繁体同步。
- 新增 `ReadingContext.ts`：按当前文档标签提供路径、标题、PDF 页码与选中文字。Markdown 原文/预览和 PDF 翻页/选区接入，切回白板、取消选区和关闭时清理；AI 面板取得焦点时保留阅读目标。自带 AI 与 ACP 每轮发送时取上下文快照，界面用户气泡保持原文，斜杠命令仍原样发送。
- `askAiAboutSelection` 打开已有 AI 面板，将带标题/页码的引用追加到输入框末尾并定位光标，不自动发送。文档激活时 AI 面板沿用最近仍打开的白板会话，避免原来的“未打开白板”占位挡住阅读提问；不改界面样式。
- 新增只读工具 `read_pdf_text`、`search_pdf`，同时列给自带 AI 和 MCP。复用本地 EmbedPDF worker、文件读取上限及释放机制；一次读取最多 10 页、合计 20000 字符，返回截断位置；搜索返回最多 50 条页码与上下文。检查已打开 PDF 或已登记项目路径、拒绝项目内符号链接越界，遵守 PDF 复制权限，错误返回代码。MCP 仍使用现有 workspace 路由，PDF 工具需桌面端打开白板；没有放宽 capabilities 或文件访问范围。
- 增加翻译回退/词典/缓存/取消、阅读上下文切换、选区草稿、AI 消息不被上下文改写，以及 PDF 权限/页数/截断/搜索/释放测试；真实 PDFium 测试使用代码内生成的微型 PDF，不依赖仓库外文献。未做 B/C 步、文献库独立路径登记、阅读样式或 OCR；文献库 PDF 目前通过已打开文档或已登记项目访问。没有安装依赖、构建或修改只读参考库。

### 43. 文献库读写后台第 B 步（2026-11-10）

- 新增 `Library.ts` 和 `LibraryFormat.ts`，读取库目录中的 `.litlib` 及 `条目/<key>/<key>.md`，沿用插件的字段顺序、中文阅读状态、`deleted` 回收站标记、分类层级、附件命名和研究笔记模板。加载只消费开头的 YAML，最多并发读取 8 篇；坏条目在快照的 `errors` 中单独列出，其余条目继续加载。
- 更新只替换指定的 YAML 字段，未知字段的原始写法、注释、BOM、换行以及正文原始字节保持不变；同目录临时文件写完后改名，写入前复核磁盘内容，冲突或失败保留原文件。PDF 导入复制到临时条目目录，笔记和附件齐全后才发布；重名 key 追加字母，不覆盖已有条目。
- 提供搜索、分类及子分类筛选、多标签交集、阅读状态和回收站筛选，以及五种排序和计数接口。分类改名、删除同时处理子分类和回收站条目，不删除文献文件；存在坏条目时先拒绝批量改分类。多文件写入失败时尝试回退已完成的条目，回退也检查磁盘内容；遇到外部修改无法回退时明确返回部分完成错误。
- 新增默认空的 `literatureLibraryPath` 设置，沿用研究文件夹的目录授权命令，只操作设置所指向的库；校验 Windows/macOS 路径、危险文件名及库内符号链接，没有扩大 capabilities。设置放在现有文件夹页，中英文文案及自动生成繁体同步，没有调整阅读界面或样式。
- `useLibrary` 接入已有 `fs:allow-watch`，合并事件并只重读受影响的条目，支持手动刷新、错误状态和释放监听。当前 Rust 文件插件未开启 `watch`，离线检查确认缺少 `notify`，因此没有启用这个需要补依赖的功能；现有环境会返回 `library.watchUnavailable`，需手动刷新。遵守“不安装”约束，没有修改依赖清单或锁文件。
- 新增格式往返、正文与未知字段保真、坏 YAML 隔离、并发上限、保存冲突与失败、PDF 导入、回收站、分类、查询计数、路径边界和监听生命周期测试，夹具均在仓库内代码或测试临时目录生成。没有修改 A/C 步、联网功能或只读参考文献库。

### 44. 文献阅读后台第 C 步（2026-11-11）

- 新增 `ReadingTheme.ts`，提供 default、obsidian、notion 三套预设、用户覆盖合并和现有 `reading.css` 所需的 CSS 变量及单位；未指定的字体不输出变量，保留样式后备。`readingTheme` 接入现有设置校验、持久化和监听，变量挂在 Markdown 文档编辑与预览的共同容器，AI 对话不受阅读外观设置影响。
- 设置新增「阅读与文献」页，将划词翻译服务、文献库路径移到这里，并接入已有的阅读外观子页面。补齐中英文入口和错误提示，繁体通过现有 OpenCC 脚本生成；没有修改 `reading.css` 或 `ReadingThemePage.tsx` 的样式和布局。
- Markdown 预览增加 Obsidian 提示框、默认标题、对应 Lucide 图标及鼠标/键盘折叠。双链和嵌入仅在传入文档路径时启用；代码、数学公式、转义文字和已有 Markdown 链接保持原来的解析方式，折叠只保存在组件状态中，不写回笔记。
- 新增 `DocumentLinks.ts`，同目录优先，再按项目根目录路径或文件名查找；只查当前文档所属项目或设置中的文献库，沿用原有目录登记与路径检查，拒绝网络地址、目录逃逸、隐藏路径和符号链接。单次预览共享目录读取，点击时重新检查；未找到的链接标为 `is-unresolved` 并显示提示，读取失败另行提示。文献库只额外导出已有授权函数，没有扩大文件权限。
- 双链使用现有文档标签打开，支持新标签和已有标签的标题跳转，并可展开标题所在的折叠提示框。嵌入图片复用 `DocumentImage` 的本地读取与对象 URL 生命周期，支持宽度；嵌入 Markdown 只显示链接。新增主题保存/重载、提示框/图标/折叠、查找优先级、Windows/UNC/目录别名、路径边界、图片释放、标题跳转及 BOM/CRLF 原文保真回归测试；没有新增依赖、联网、构建或改动只读参考库。

### 45. 文献库、划词翻译和阅读外观的界面，以及三步后台的审查修改（2026-11-11）

- `app/src/sub/FileManagerWindow.tsx`：文件栏照 Obsidian 改样子。按扩展名和常见文件夹名（`assets`、`data`、`src`、文献、笔记等）自动配图标；子层级前加竖着的缩进线，文件和同层文件夹的图标对齐；选中改为浅灰圆角底；折叠箭头更轻；项目行的「更多」按钮鼠标停住时才出现。文件后缀照常显示。
- `app/src/core/research/DocumentView.tsx`、`app/src/css/reading.css`（新增）、`app/src/assets/fonts/`（新增 Inter、JetBrains Mono 及其 OFL 许可证）：
  - Markdown 页可切「编辑 / 对照 / 阅读」，选择记在本机；
  - 排版和提示框配色照用户 Obsidian 的 Minimal 主题和几个 CSS 片段：标题阶梯、表格、图注、代码块；
  - 预览里选中文字，弹出「翻译 / 问 AI / 复制」。
- `app/src/core/research/TranslateCard.tsx`（新增）、`PdfAnnotationUI.tsx`、`PdfView.tsx`：PDF 选区菜单加「翻译」「问 AI」。翻译卡片可以拖动，单词显示音标和释义，可复制译文，可「高亮并把译文写进批注」，带「选中即译」开关。PDF 不允许复制内容时不给这两个按钮。
- `app/src/core/research/LibraryTab.tsx`、`LibraryView.tsx`（新增）、`app/src/components/activity-rail.tsx`：左侧竖栏加「文献库」，打开一个文献库标签页，三栏照用户 Obsidian 文献库插件：
  - 左栏：分类树、未分类、回收站、标签筛选；
  - 中栏：搜索、可排序的列表、附件展开、右键菜单；
  - 右栏：可编辑的信息、阅读状态、分类和标签。
  - 选文件夹、导入 PDF 都用程序自带的浏览器，不弹系统窗口（`ResearchFolderBrowser.tsx` 加「只挑一个文件夹 / PDF」模式）。
- `app/src/sub/SettingsWindow/ReadingThemePage.tsx`（新增）：「阅读外观」页，三套预设带样张，可调字号、行高、阅读宽度、正文和代码字体，带实时预览。
- 审查修改：
  - `Translate.ts`：AI 翻译单词少给音标时照样返回译文，原来会判失败。
  - `Library.ts`：B 步写的文件监听改为「切回窗口、鼠标移进文献库时比对修改时间，只重读变了的条目」，另加「整个重读」，不需要开文件插件的 `watch` 功能，也不补依赖。新增 `createLibrary`，在没有 `.litlib` 的文件夹里新建空文献库。文献库错误文案统一放到 `library.errors` 下。
  - `components/ui/markdown.tsx`：双链组件只随文档路径重建，边打字边预览时不再反复去磁盘上找链接目标。
  - `DocumentLinks.ts`：按文件名全项目找笔记时最多翻 3000 个文件夹。
- `CLAUDE.md`：写明划词翻译默认调 Google、Bing 是用户定的例外。

### 46. 文献库页开错位置、路径显示乱码（2026-11-11）

- `app/src/core/research/LibraryTab.tsx`：文献库标签带上 `labweave:library` 这个 uri，算作资源标签。和白板、文档一样总是开在中间主区域，不会被塞进当时选中的侧栏。
- `app/src/core/research/LibraryView.tsx`：文案插值关掉 i18next 自己的转义（React 显示时已经转义），路径里的 `/` 不再显示成 `&#x2F;`。「不是文献库」提示里的长路径自动换行，按钮放不下时也换行。
