# PDF 阅读器第 1 步交付报告

2026-11-10；工作树 `research-whiteboard-acp`，分支 `pdf-reader`。实现提交：`d9ccb48c`（`feat: replace PDF reading tabs with offline EmbedPDF`）。本轮只实现阅读；批注侧栏保留占位，没有第 2 步的编辑或存储逻辑。

**原来 → 现在**

- PDF 阅读标签从 pdf.js legacy viewer 改为 EmbedPDF 2.15.1 headless。顶部左侧是侧栏开关和缩放，中间是页码，右侧是复制和搜索；侧栏有缩略图、大纲、批注占位。深浅主题使用已有 shadcn 组件和配色，PDF 纸面保持白色。
- 增加整页自适应、宽度自适应、实际大小、缩略图跳页、大纲导航、全文搜索计数和高亮；保留翻页、跳页、25%～400% 缩放及标签切换后的页码/缩放恢复。搜索支持 Cmd/Ctrl+F、Enter、Shift+Enter、Esc。
- 阅读区支持鼠标锚点缩放、Ctrl/Cmd+滚轮、WebKit 触控板捏合和 Cmd/Ctrl 加 `+`、`-`、`0`；可见页面使用底图加瓦片精绘。文字拖选及复制遵守 PDF 权限；剪贴板失败有提示。
- 独立 worker 运行 PDFium。读取、初始化和任务都有期限；失败显示重试，关闭和切标签会终止 worker、关闭文件句柄并清理插件。PDF 原有批注、表单外观只读渲染。
- 画布 PDF 卡片、AI 摘录和 `PdfDocument.ts` 的 pdf.js 范围读取未改。依赖、锁文件、Rust、文件权限和 capabilities 未改；没有写 PDF 原件，没有运行 build。

**读取与内存取舍**

官方 2.15.1 的 `openDocumentBuffer` 会把完整文件复制到 WASM，再调用 `FPDF_LoadMemDocument`；URL 打开同样先取完整 `ArrayBuffer`，没有可接入的范围读取接口。本轮沿用已有 scoped 文件句柄和 256 KiB 底层读取，最终拼成完整缓冲区；使用 transfer 交给 worker，避免主线程长期保留额外的文件副本。打开期间仍有 JS 文件缓冲区与 WASM 内副本，瓦片只限制栅格图片工作量，不改变完整文件占用。[PDFium 打开实现](https://github.com/embedpdf/embed-pdf-viewer/blob/4db40e21c91d7767fc0cce21802b83ccd68e48e2/packages/engines/src/lib/pdfium/engine.ts)，[URL 打开实现](https://github.com/embedpdf/embed-pdf-viewer/blob/4db40e21c91d7767fc0cce21802b83ccd68e48e2/packages/engines/src/lib/orchestrator/pdf-engine.ts)。

**离线与字体结论**

WASM 通过 Vite `?url` 引用本地 `@embedpdf/pdfium/pdfium.wasm`，实测文件为 **4,646,932 字节（4.43 MiB）**；worker 使用本地模块。没有引入外部引擎、worker 或字体 URL。

EmbedPDF 默认浏览器 worker 在遇到未嵌入字体时，会按字符集与字重向 jsDelivr 按需取字体；字体包入口只是文件名/字重元数据，安装字体依赖本身不等于把所有 OTF 放入应用。本轮完全替换这套默认配置，没有引用 `@embedpdf/fonts-sc` 的五份 OTF，没有新增字体资产。[默认字体配置](https://github.com/embedpdf/embed-pdf-viewer/blob/4db40e21c91d7767fc0cce21802b83ccd68e48e2/packages/engines/src/lib/pdfium/cdn-fonts.ts)，[字体加载实现](https://github.com/embedpdf/embed-pdf-viewer/blob/4db40e21c91d7767fc0cce21802b83ccd68e48e2/packages/engines/src/lib/pdfium/font-fallback.ts)。

测试确实发现补字需求：`数字集成电路回忆.pdf` 使用未嵌入的 STSong，禁用所有补字时，首页扫描图正常，但中文页眉、页脚消失。仓库原本已由 CSS 和画布 worker 引用 `app/src/assets/fonts/NotoSansSC-Regular.otf`，大小 **8,331,336 字节（7.95 MiB）**。复用这份现有本地字体后，页眉和页脚恢复可读。最终只为 GB2312 配置它，按需加载；本地字体读取失败会通知主线程并显示重试。

因此无需新增那套约 40 MB 的备用字体。额外候选 `@embedpdf/fonts-sc/NotoSansHans-Regular.otf` 为 8,364,644 字节，虽也能补字，但未采用。复用既有文件没有新增字体资产，仍会增加需要补字的 reader worker 的运行内存；替代字体的字形、字重与原 STSong 不完全相同。其他未嵌入的字符集没有额外配置补字，不会回退到联网下载。

源码及单元测试确认资源路径和字体白名单；真实样本测试把 `fetch`、`XMLHttpRequest` 的网络入口设为失败，WASM 从本地二进制初始化，字体通过受控本地文件读取。四份英文样本没有读取备用字体，中文样本每次读取 8,331,336 字节。没有 build，因此没有把“同一资产引用、无新增字体文件”冒充为最终安装包体积实测；WKWebView 的本地字体同步 XHR 仍需手测。

**性能实测**

环境：macOS 15.1、arm64、Node 26.8.1、EmbedPDF 2.15.1。使用指定目录中的五份只读 PDF，各三轮，下面为中位数，单位毫秒。旧实现已核对 `cefe81d3` 的阅读器代码，旧数据同时列出既有 `pdf-after-node.jsonl` 和本轮重新测量。

首页口径是读文件/初始化引擎到第一页 1024 像素宽位图完成，DPR=1。pdf.js 使用 Node fake worker；EmbedPDF 使用 Node direct engine，生产界面才是独立 Web Worker。库导入、WASM 文件本身的读取、真实 worker 启动、Tauri IPC、React/缩略图/文字层、图像解码、GPU 合成和屏幕绘制不在这一口径内；新探针包含每次 WASM 实例化及按需字体读取。因此这些是引擎探针数据，不能当作应用打开耗时。

| 文件                  | 页数 / 文件 MiB | 旧历史首页 | 本轮旧 pdf.js 首页 | 新 EmbedPDF 首页 |
| --------------------- | --------------: | ---------: | -----------------: | ---------------: |
| EfficientNet-2019.pdf |       11 / 0.89 |       33.0 |               32.9 |             24.5 |
| MobileNetV3-2019.pdf  |       11 / 0.51 |       43.0 |               40.9 |             27.9 |
| main.pdf              |       19 / 5.13 |       54.0 |               54.5 |             48.4 |
| ruhling-cachay26a.pdf |       22 / 5.37 |       33.6 |               34.6 |             28.0 |
| 数字集成电路回忆.pdf  |        5 / 1.97 |       52.9 |               67.8 |             42.7 |

翻页测第二页、同为 1024 像素宽。放大测两倍缩放：旧 pdf.js 重绘 2048 像素宽整页；新引擎绘制覆盖 1024×1024 可见区域的四个 512 像素瓦片。两列放大数字的工作量不同，不能据此计算“引擎快了几倍”。

| 文件                  | 翻页：旧 → 新 | 放大：旧整页 | 放大：新可见瓦片 |
| --------------------- | ------------: | -----------: | ---------------: |
| EfficientNet-2019.pdf |   23.7 → 12.7 |          9.4 |              5.1 |
| MobileNetV3-2019.pdf  |    13.7 → 8.0 |         13.6 |              4.7 |
| main.pdf              |   56.8 → 59.1 |         18.3 |             23.2 |
| ruhling-cachay26a.pdf |   14.4 → 12.3 |         10.0 |              4.5 |
| 数字集成电路回忆.pdf  |  172.7 → 92.0 |          5.3 |              5.7 |

本轮探针的首页耗时较低，但 `main.pdf` 翻页、放大没有优势；高 DPI、连续手势和多栏拖选的实际体验不能由这些数据推出。

**内存实测**

以下单位均为 MiB。WASM 列是该实例线性内存的已分配容量，不是全部活跃对象；后一列包含翻页和放大后的保留容量。ArrayBuffers、JS heap 为首页完成时相对该轮基线的进程增量中位数，与 WASM 不是可直接相加的独立内存账目。

| 文件                  | 新 WASM：首页 → 翻页/放大后 | ArrayBuffers 增量：旧 → 新 | JS heap 增量：旧 → 新 |
| --------------------- | --------------------------: | -------------------------: | --------------------: |
| EfficientNet-2019.pdf |               17.75 → 17.75 |               4.37 → 20.85 |          26.38 → 3.18 |
| MobileNetV3-2019.pdf  |               17.75 → 17.75 |               2.19 → 20.47 |           0.84 → 3.05 |
| main.pdf              |               17.75 → 25.63 |               6.34 → 25.56 |          -2.67 → 3.25 |
| ruhling-cachay26a.pdf |               17.75 → 21.31 |               7.05 → 25.33 |           0.90 → 3.22 |
| 数字集成电路回忆.pdf  |               36.94 → 92.94 |              31.91 → 31.32 |          22.93 → 3.10 |

负增量来自期间 GC 回收之前的对象，不代表文档“负占用”。整轮顺序测量进程在采样点的最高 RSS，旧为 **747.84 MiB**、新为 **682.11 MiB**；它们包含测试运行器、原生图像库、前序样本与 GC 时机，且不是连续采样峰值，也不是单文档或 WebView 的内存。不能据此宣称生产阅读器节省相同比例内存。中文样本的字体加载已经在最终测量的基线之后发生并计入，不能把复用已打包字体理解为运行时零成本。

五份样本都完整读取，新读取字节数与文件大小一致。它们最大只有 5.37 MiB；大 PDF 的完整文件缓冲区、扫描页解码和高 DPI 图片仍会增加占用，尚无真实 WebView 大文件峰值数据。

**检查结果**

- `pnpm --filter @graphif/project-graph type-check`：通过。
- 指定全量 Vitest 命令：**151 个文件通过、3 个条件跳过；1494 项通过、3 项跳过**。首次沙箱运行因本地 IPC 的 `listen EPERM` 等环境问题失败；允许本机 IPC 后重跑通过。既有 jsdom canvas 提示未导致失败，没有安装 canvas 或其他依赖。
- PDF 核心、worker、缩放和真实插件组件测试：**48 项通过**。覆盖 transfer、超时/取消/关闭、重复清理、密码错误、路径与页码校验、标签恢复、书签、搜索计数/高亮、跨行拖选、两种修饰键复制、按钮复制、剪贴板失败及手势。
- 真实样本两项探针：通过；两个引擎各五份、三轮。另做了禁用补字、候选字体和既有字体对照，并目视检查五份首页输出。
- 改动 TS/TSX 文件 ESLint、改动文件 Prettier、`git diff --check`：通过。CSS/YAML 不在仓库 ESLint 配置范围，locale YAML 按仓库 Prettier 配置忽略；`zh_TW.yml` 已运行指定 sync-locales 命令生成。
- Rust 未改，未运行条件要求中的 cargo test / rustfmt；未运行任何 build。依赖清单、锁文件、卡片/范围读取实现、capabilities 差异检查通过。
- 已按任务书另起独立 Codex 审查，随后复核本地字体处理，未发现阻断项。

**可复核数据与重跑**

本机临时目录 `/Volumes/soleilMacOS/codes/ai4Know/过程文件/tmp/` 中保留：

- `embedpdf-final-node.jsonl`、`pdfjs-final-node.jsonl`：最终原始测量，含每轮耗时、字节数、内存与 fontReadBytes。
- `pdf-after-node.jsonl`：任务书提供的旧历史记录。
- `pdfjs-*.pdf.png`、`embedpdf-fallback-*.pdf.png`：旧/最终首页图；`embedpdf-数字集成电路回忆.pdf.png` 为关闭补字的对照。
- `pdf-reader-all-tests-final.log`、`pdf-reader-focused.log`、`pdf-reader-typecheck.log`、`pdf-reader-eslint.log`、`pdf-reader-prettier.log`、`pdf-reader-samples-final.log`：检查日志。

在仓库根目录重跑探针（文件名可自行换成新的输出名）：

```sh
source /Volumes/soleilMacOS/devtools/env.sh
LABWEAVE_SAMPLE_PDFS='/Volumes/soleilMacOS/codes/ai4Know/示例研究文件夹/论文:/Volumes/soleilMacOS/codes/ai4Know/示例研究文件夹/导入' \
LABWEAVE_PDF_RUNS=3 \
LABWEAVE_EMBEDPDF_REPORT='/Volumes/soleilMacOS/codes/ai4Know/过程文件/tmp/embedpdf-final-node.jsonl' \
LABWEAVE_PDF_REPORT='/Volumes/soleilMacOS/codes/ai4Know/过程文件/tmp/pdfjs-final-node.jsonl' \
pnpm exec vitest run app/src/core/research/PdfReaderSamples.test.ts app/src/core/research/PdfRangeSamples.test.ts --maxWorkers=1
```

探针默认使用同一份既有字体，`LABWEAVE_EMBEDPDF_FALLBACK_FONT=none` 可做禁用补字对照；该环境变量只存在于测试，不是应用设置。

**协议与未验证项**

仓库没有统一的第三方声明文件；按任务书，本轮在报告说明，没有另建聚合声明。已核对官方 v2 源码：EmbedPDF core/engines 及 PDFium 的 JS 封装标为 MIT；PDFium 自带许可包含 BSD 与 Apache-2.0 文本。既有字体的 OFL 在 `app/src/assets/fonts/OFL.txt`。分发时须保留对应许可材料。[EmbedPDF MIT](https://github.com/embedpdf/embed-pdf-viewer/blob/4db40e21c91d7767fc0cce21802b83ccd68e48e2/LICENSE)，[PDFium 许可](https://github.com/embedpdf/embed-pdf-viewer/blob/4db40e21c91d7767fc0cce21802b83ccd68e48e2/packages/pdfium/LICENSE.pdfium)。没有拷贝 Zotero 代码。

2.15.1 上游 `EngineRunner` 忽略 AbortRequest：本页卸载、搜索取消会停止接收旧结果，但已进入 worker 的旧任务仍可能继续执行；关闭/切标签通过 terminate 释放整个 worker。持续缩放或长文档搜索可能因此延迟，需要实际体验验证。

本轮未能连接开发版 WebView：自动化浏览器宿主不可用，本地 1420 端口也无法访问；没有停止或重启用户的开发版。尚未验证真实 UI 截图、触控板手感、跨栏选择体验、WKWebView 本地同步 XHR、高 DPI 内存及最终打包路径。

**请按这些步骤手测**

1. 在文件面板双击 `论文/EfficientNet-2019.pdf`，再双击同一文件，应只保留一个标签。跳到第 5 页、选 150%，切到另一份 PDF 再回来，确认页码和缩放恢复。
2. 点左侧第 3 页缩略图，确认页码与高亮边框跟随；在 `导入/main.pdf` 点「大纲」及其中书签，确认跳转。无书签的文件应提示没有大纲；「批注」仅有占位。
3. 在缩放菜单依次选「适合整页」「适合宽度」「实际大小」，改变窗口宽度并收放侧栏，确认自适应更新。把鼠标放到正文一个字上，用 Ctrl/Cmd+滚轮、触控板捏合和 `+/-/0`，观察锚点、清晰度及普通滚动；回到白板后快捷键应正常。
4. 在论文左栏拖选两行，再尝试跨栏、拖动中滚动；Cmd/Ctrl+C 和工具栏复制后粘贴到临时文本，核对文字顺序。扫描图片不应被误认为可选择文字。
5. 在阅读区按 Cmd/Ctrl+F 搜索 `model`，观察计数和页面高亮；Enter/Shift+Enter、左右按钮应跳转，Esc 关闭并回到阅读区。连续改查询再关搜索，确认无旧结果覆盖。
6. 断网打开 `导入/数字集成电路回忆.pdf`，确认首页页眉「致谢…」和页脚「下面是选择题…」可见；对比原 PDF 允许替代字体字形不同。切深色主题检查工具栏、侧栏、选择/搜索高亮与白色纸面。
7. 连续放大、搜索、切换及关闭 PDF 标签，观察是否残留加载、错误或后台占用；若有大文件或旋转页面，再检查翻页、拖选和高亮位置。打开损坏/空 PDF 应有失败提示与重试，不应一直空白。

第 2 步批注、密码输入、其他未嵌入字符集的额外字体都未扩展；真实 WebView 与最终打包验证仍是本轮明确保留的检查边界。
