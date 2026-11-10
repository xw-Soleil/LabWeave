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

### 31. 本文件

- `CHANGES-research-workbench.md`（新增）
