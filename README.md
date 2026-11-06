# LabWeave

科研工作台：把论文、图片和笔记摆在白板上，用连线和分组理清思路，再请 AI 帮你看还缺什么。

## 能做什么

- **研究文件夹**：论文、图片、笔记和工作区都放在一个文件夹里，从文件面板拖到白板上。
- **AI 助手**：读当前白板（卡片、连线、分组、文件里抽出的文字），帮你概括思路、找缺口。可以用自己填的 AI 接口，也可以用这台电脑上装好的 Codex、Claude Code（在 `acp-local-agent` 分支，测试中）。
- **外部 AI**：Claude Code、Codex 等 AI 软件可以通过 MCP 读和改你的白板。

## 和 Project Graph 的关系

LabWeave 基于 [Project Graph](https://github.com/graphif/project-graph)（提交 `5524363`）修改而来，原项目的作者和贡献者见原仓库。改了什么见 [CHANGES-research-workbench.md](CHANGES-research-workbench.md)，原项目的介绍见 [app/README.md](app/README.md)。

## 许可证

程序按 GPL-3.0-only 发布，见 [LICENSE](LICENSE)；`packages/` 下的包保留各自的 MIT 许可证。

## 从源码运行（开发版）

需要 Node.js 26 以上、pnpm 11、Rust（stable），另外：

- macOS：Xcode 命令行工具（`xcode-select --install`）
- Windows：Visual Studio 2022 生成工具，安装时勾选「使用 C++ 的桌面开发」；WebView2（Windows 10/11 一般自带）

```bash
pnpm install
pnpm dev
```

每次推送，GitHub 会在 Windows 和 macOS 上自动检查一遍：类型检查、测试、编译（Actions 里的 Check）。本机 AI 程序（Codex、Claude Code）目前只在 macOS 上做过，Windows 还没适配。
