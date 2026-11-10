// 让外部 AI（Claude Code、Codex、Cursor 等）通过 MCP 操作科研工作台的白板。
// 工具就是命令行的那套内置工具，每个多一个 workspace 参数；调用时和命令行一样分流：
// 工作区开在程序里就交给程序执行（改动马上出现、能撤销），没开就直接改文件。

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getBuiltInToolCliEntries } from "../core/service/dataManageService/aiEngine/BuiltInToolCliAdapter";
import { getBuiltInToolDefinition } from "../core/service/dataManageService/aiEngine/BuiltInToolRegistry";
import {
  describeToolEffects,
  isToolAllowedForExternalAi,
  listWorkspaceFiles,
  probeWorkspaceOpen,
  readAppSettings,
  readExternalAiPermissions,
  researchFolderOf,
  resolveWorkspace,
  sidecarMarkdownPath,
} from "./ExternalAiWorkspace";
import type { PathRoutedInvocationOptions, ProjectGraphCliRuntime } from "./ProjectGraphCliRuntime";

export const MCP_SERVER_NAME = "research-workbench";

const INSTRUCTIONS = `这是「科研工作台」（一个白板程序）的接口。研究文件夹里的每个 .prg 文件是一个工作区，也就是一块白板。

- 先调用 list_workspaces，看有哪些工作区、哪些正开在程序里。
- 其他工具都要传 workspace：工作区名字（可以不带 .prg），或相对研究文件夹的路径。
- 看整块白板的内容用 dump_workspace；要改某张卡片，先用 get_all_nodes 或 search_text_nodes_by_regex 拿到它的引用（n1、e1 这种），引用只在同一个工作区里有效。
- 用户在阅读论文、需要核对原文时用 read_pdf_text（path 为 PDF 绝对路径，pages 如 3-5，最多 10 页）；找术语或引文先用 search_pdf（最多 50 条），再按命中页读取。文本有上限，注意 truncated 和 stoppedAt。只读当前打开的 PDF 或已登记项目中的 PDF（包括其中的文献库），需要 workspace 指向桌面端开着的白板；不支持 OCR。
- 工作区开在程序里时，改动马上出现在白板上，用户可以撤销；没开时直接改文件。
- 名字里带 selected、viewport 的工具，以及不带坐标的 create_text_node、create_file_card，要用到程序里的选中或视野，只能用于开着的工作区。要在没开的工作区里加卡片，用 create_text_node_at。
- 坐标是白板的世界坐标：x 向右、y 向下。get_all_nodes 会给出每张卡片的位置和尺寸，摆新卡片时避开已有的。
- 要调整位置用 move_nodes，不要删掉重建：删掉重建会换引用，连线也要重连。
- 资源里每个工作区的「文字版」是上次保存时写出的，最新内容以 dump_workspace 为准。`;

const WORKSPACE_PROPERTY = {
  type: "string",
  description:
    "工作区：研究文件夹里 .prg 文件的名字（可以不带 .prg），或相对研究文件夹的路径。用 list_workspaces 查看有哪些。",
};

const LIST_WORKSPACES_TOOL: Tool = {
  name: "list_workspaces",
  description:
    "列出研究文件夹里的所有工作区（.prg 文件）：相对路径、最后修改时间、是否正开在程序里。其他工具的 workspace 参数填这里的 workspace 字段。",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** 常见错误给 AI 一句能照着做的提示 */
const ERROR_HINTS: Record<string, string> = {
  PROJECT_MUST_BE_OPEN:
    "这个工具要用到程序里的选中或视野，只能用于开在程序里的工作区。可以改用不依赖选中、视野的工具（例如 create_text_node_at），或请用户先在科研工作台里打开这个工作区。",
  PROJECT_BUSY: "这个工作区正被另一个操作占用，稍后再试。",
  PROJECT_UPGRADE_REQUIRED: "这个工作区是旧版格式，请用户先在科研工作台里打开并保存一次。",
  PROJECT_VERSION_UNSUPPORTED: "这个工作区是更新版本的程序存的，当前版本读不了。",
  RUNTIME_HOST_UNAVAILABLE: "工作区开在程序里，但连不上程序。程序可能刚关掉或卡住了，稍后再试。",
  RUNTIME_HOST_UNAUTHORIZED:
    "连程序时口令不对。多半是 MCP 用的程序数据目录（--app-home）和正在运行的程序不一样，请用户按设置里给的命令重新配置。",
  PROJECT_NOT_FOUND: "工作区文件不见了，用 list_workspaces 重新看一下。",
  PROJECT_LOAD_FAILED: "工作区文件读不了，可能已损坏或正在被写入。",
  PROJECT_SAVE_FAILED: "改动没能写回工作区文件。",
  TOOL_EXECUTION_FAILED: "工具执行出错。检查引用是否还有效（可以重新 get_all_nodes），再试一次。",
  OWNERSHIP_HELPER_UNAVAILABLE: "找不到 project-graph-ownership-helper，开发版要先编译一次 Rust 部分。",
};

type Invoke = (options: PathRoutedInvocationOptions) => ReturnType<ProjectGraphCliRuntime["runPathRoutedInvocation"]>;

export type ExternalAiMcpDependencies = {
  version: string;
  /** 每次请求都重新读，用户在设置里改了开关马上生效 */
  readSettings: () => Record<string, unknown>;
  invoke: Invoke;
  isWorkspaceOpen: (absPath: string) => Promise<boolean | null>;
};

function textResult(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], ...(isError ? { isError: true } : {}) };
}

function errorResult(code: string, message: string): CallToolResult {
  const hint = ERROR_HINTS[code];
  return textResult({ code, message, ...(hint ? { hint } : {}) }, true);
}

function toMcpTool(entry: ReturnType<typeof getBuiltInToolCliEntries>[number]): Tool {
  const schema = { ...entry.inputSchema } as {
    $schema?: string;
    properties?: Record<string, object>;
    required?: string[];
  };
  // 有的 MCP 客户端不认 2020-12 的 $schema 声明，去掉不影响内容
  delete schema.$schema;
  const effects = describeToolEffects(getBuiltInToolDefinition(entry.name)!);
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: {
      ...schema,
      type: "object",
      properties: { workspace: WORKSPACE_PROPERTY, ...schema.properties },
      required: ["workspace", ...(schema.required ?? [])],
    },
    annotations: {
      readOnlyHint: !effects.modifies,
      destructiveHint: effects.deletes,
      openWorldHint: effects.network,
    },
  };
}

function allowedEntries(settings: Record<string, unknown>) {
  const permissions = readExternalAiPermissions(settings);
  return getBuiltInToolCliEntries().filter((entry) =>
    isToolAllowedForExternalAi(getBuiltInToolDefinition(entry.name)!, permissions),
  );
}

const RESOURCE_PREFIX = "workbench:///";

function workspaceResourceUri(relPath: string): string {
  return RESOURCE_PREFIX + relPath.split("/").map(encodeURIComponent).join("/");
}

function noFolderResult(): CallToolResult {
  return errorResult("NO_RESEARCH_FOLDER", "科研工作台还没有选研究文件夹，请用户先在程序里选一个。");
}

async function listWorkspaces(deps: ExternalAiMcpDependencies, root: string) {
  const { workspaces, truncated } = listWorkspaceFiles(root);
  const open = await Promise.all(workspaces.map((workspace) => deps.isWorkspaceOpen(workspace.absPath)));
  return {
    researchFolder: root,
    workspaces: workspaces.map((workspace, index) => ({
      workspace: workspace.relPath,
      modified: workspace.mtimeMs ? new Date(workspace.mtimeMs).toISOString() : null,
      open: open[index],
    })),
    ...(truncated ? { truncated: true } : {}),
  };
}

export function createExternalAiMcpServer(deps: ExternalAiMcpDependencies): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, title: "科研工作台", version: deps.version },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LIST_WORKSPACES_TOOL, ...allowedEntries(deps.readSettings()).map(toMcpTool)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = request.params;
    const settings = deps.readSettings();
    const root = researchFolderOf(settings);
    if (name === LIST_WORKSPACES_TOOL.name) {
      return root ? textResult(await listWorkspaces(deps, root)) : noFolderResult();
    }

    const definition = getBuiltInToolDefinition(name);
    if (!definition) return errorResult("UNKNOWN_TOOL", `没有这个工具：${name}`);
    if (!isToolAllowedForExternalAi(definition, readExternalAiPermissions(settings))) {
      return errorResult(
        "TOOL_DISABLED",
        `用户在科研工作台的设置里关掉了这一类工具（设置 → AI → 外部 AI），${name} 现在不能用。`,
      );
    }
    if (!root) return noFolderResult();
    const { workspace, ...input } = args;
    const resolved = resolveWorkspace(root, workspace);
    if (!resolved.ok) return errorResult("WORKSPACE_NOT_FOUND", resolved.message);
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(参数)"}：${issue.message}`);
      return errorResult("TOOL_INPUT_INVALID", `参数不对：${problems.join("；")}`);
    }

    const result = await deps.invoke({
      toolName: name,
      input,
      projectPath: resolved.absPath,
      allowUpgrade: false,
      abortSignal: extra.signal,
      output: "capture",
    });
    if ("forwarded" in result) return errorResult("TOOL_EXECUTION_FAILED", "工具结果没有返回");
    if (!result.ok) return errorResult(result.error.code, result.error.message);
    const value = result.value as { success?: unknown } | null | undefined;
    return textResult(value, !!value && typeof value === "object" && value.success === false);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const root = researchFolderOf(deps.readSettings());
    if (!root) return { resources: [] };
    return {
      resources: listWorkspaceFiles(root).workspaces.map(({ relPath }) => ({
        uri: workspaceResourceUri(relPath),
        name: relPath,
        title: `${relPath.replace(/\.prg$/i, "")}（文字版）`,
        description: "上次保存时写出的文字版：卡片、分组、连线和文件卡片里抽出的文字。最新内容以 dump_workspace 为准。",
        mimeType: "text/markdown",
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const root = researchFolderOf(deps.readSettings());
    if (!root) throw new Error("科研工作台还没有选研究文件夹");
    if (!uri.startsWith(RESOURCE_PREFIX)) throw new Error(`不认识的资源：${uri}`);
    const relPath = uri.slice(RESOURCE_PREFIX.length).split("/").map(decodeURIComponent).join("/");
    const resolved = resolveWorkspace(root, relPath);
    if (!resolved.ok) throw new Error(resolved.message);
    let text: string;
    try {
      text = readFileSync(sidecarMarkdownPath(resolved.absPath), "utf8");
    } catch {
      throw new Error(
        "这个工作区还没有文字版：在程序里保存一次就会写出（设置 → 保存里要开着「保存时写出 AI 文字版」）",
      );
    }
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  });

  return server;
}

/** 命令行 `mcp` 子命令：在标准输入输出上跑 MCP，直到对方断开或收到退出信号 */
export async function runExternalAiMcpServer(options: {
  version: string;
  loadRuntime: () => Promise<ProjectGraphCliRuntime>;
  abortSignal?: AbortSignal;
  transport?: Transport;
}): Promise<void> {
  // stdout 归 MCP 协议用，任何日志都改到 stderr，免得打乱通信
  const { log, info, debug } = console;
  const toStderr = (...values: unknown[]) => console.error(...values);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  let runtime: Promise<ProjectGraphCliRuntime> | undefined;
  const server = createExternalAiMcpServer({
    version: options.version,
    readSettings: readAppSettings,
    invoke: async (invocation) => {
      runtime ??= options.loadRuntime();
      return (await runtime).runPathRoutedInvocation(invocation);
    },
    isWorkspaceOpen: probeWorkspaceOpen,
  });
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  const stop = () => void server.close();
  options.abortSignal?.addEventListener("abort", stop, { once: true });
  // 对方关掉管道时 SDK 的 stdio 传输不会自己结束，这里接上
  if (!options.transport) process.stdin.once("end", stop);
  try {
    await server.connect(options.transport ?? new StdioServerTransport());
    if (options.abortSignal?.aborted) stop();
    await closed;
  } finally {
    options.abortSignal?.removeEventListener("abort", stop);
    if (!options.transport) process.stdin.off("end", stop);
    Object.assign(console, { log, info, debug });
  }
}
