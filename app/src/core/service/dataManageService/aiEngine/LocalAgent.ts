/* eslint-disable @typescript-eslint/no-unused-vars -- 第 0 步保留参数契约，函数体在第 2 步实现后移除此豁免。 */
import type { Settings } from "@/core/service/Settings";
import type { AIMessageMetadata } from "./AIEngine";
import type {
  ContentBlock,
  InitializeResponse,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  StopReason,
  Stream,
  ToolCall,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import type { UIMessageChunk } from "ai";

export type LocalAgentId = Settings["aiLocalAgent"];
export type LocalAgentPermissionPolicy = Settings["aiLocalAgentPermission"];
export type LocalAgentTerminalAction = "login" | "install";

export const RESEARCH_WORKBENCH_MCP_NAME = "research-workbench";

export type LocalAgentInfo = {
  id: LocalAgentId;
  name: string;
  resolvedPath: string | null;
  hostFound: boolean;
  loginCommand: string | null;
  installCommand: string | null;
  homepage: string;
  tested: boolean;
};

export type LocalAgentEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "exited"; code: number | null };

export type LocalAgentProcess = {
  handle: number;
  // Channel 必须在 start 返回句柄前接收事件，流在这段时间缓冲启动输出。
  events: ReadableStream<LocalAgentEvent>;
};

export type LocalAgentStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready"; whiteboardTools: boolean }
  | { kind: "needs-login"; agentId: string; loginCommand: string | null }
  | {
      kind: "agent-error";
      agentId: string;
      reason: "not-found" | "spawn-failed" | "exited" | "protocol";
      detail: string;
      stderrTail: string[];
    };

export type LocalAgentPermissionRequest = {
  requestId: string;
  agentId: string;
  title: string;
  toolKind?: string;
  rawInput?: unknown;
  options: {
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
};

export type ExternalAiMcpLaunch = {
  node: string | null;
  script: string | null;
  appHome: string | null;
};

export async function getLocalAgentCatalog(): Promise<LocalAgentInfo[]> {
  throw new Error("not implemented");
}

export async function startLocalAgent(_agentId: LocalAgentId, _pathOverride?: string): Promise<LocalAgentProcess> {
  throw new Error("not implemented");
}

export async function writeLocalAgent(_handle: number, _line: string): Promise<void> {
  throw new Error("not implemented");
}

export async function stopLocalAgent(_handle: number): Promise<void> {
  throw new Error("not implemented");
}

export async function openLocalAgentTerminal(_agentId: LocalAgentId, _action: LocalAgentTerminalAction): Promise<void> {
  throw new Error("not implemented");
}

export function createLocalAgentStream(_handle: number, _events: ReadableStream<LocalAgentEvent>): Stream {
  throw new Error("not implemented");
}

export function buildLocalAgentMcpServers(_launch: ExternalAiMcpLaunch): McpServer[] {
  throw new Error("not implemented");
}

export type LocalAgentConnectionOptions = {
  agent: LocalAgentInfo;
  getPermissionPolicy: () => LocalAgentPermissionPolicy;
  onStatus: (status: LocalAgentStatus) => void;
  onPermissionRequest: (request: LocalAgentPermissionRequest | null) => void;
  onSessionUpdate: (update: SessionUpdate) => void;
};

export type LocalAgentSessionOptions = {
  cwd: string;
  mcpServers: McpServer[];
  previousSessionId?: string;
};

export type LocalAgentSession = {
  sessionId: string;
  loaded: boolean;
};

export class LocalAgentConnection {
  constructor(_stream: Stream, _options: LocalAgentConnectionOptions) {
    throw new Error("not implemented");
  }

  async initialize(): Promise<InitializeResponse> {
    throw new Error("not implemented");
  }

  async newSession(_cwd: string, _mcpServers: McpServer[]): Promise<NewSessionResponse> {
    throw new Error("not implemented");
  }

  async loadSession(_sessionId: string, _cwd: string, _mcpServers: McpServer[]): Promise<LoadSessionResponse> {
    throw new Error("not implemented");
  }

  async openSession(_options: LocalAgentSessionOptions): Promise<LocalAgentSession> {
    throw new Error("not implemented");
  }

  async prompt(_blocks: ContentBlock[], _signal?: AbortSignal): Promise<PromptResponse> {
    throw new Error("not implemented");
  }

  async cancel(): Promise<void> {
    throw new Error("not implemented");
  }

  handleSessionUpdate(_notification: SessionNotification): void {
    throw new Error("not implemented");
  }

  async requestPermission(_request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error("not implemented");
  }

  respondPermission(_requestId: string, _optionId: string | null): void {
    throw new Error("not implemented");
  }

  async dispose(): Promise<void> {
    throw new Error("not implemented");
  }
}

export function isWhiteboardToolCall(_toolCall: RequestPermissionRequest["toolCall"]): boolean {
  throw new Error("not implemented");
}

export type SessionUpdateState = {
  readonly messageId: string;
  readonly nextPartId: number;
  readonly activePart?: { readonly kind: "text" | "reasoning"; readonly id: string };
  readonly toolCalls: Readonly<Record<string, ToolCall>>;
  readonly metadata: Readonly<AIMessageMetadata>;
  // ACP 的 used/size 是上下文占用量，不能冒充 API 的 inputTokens/outputTokens。
  readonly usage?: UsageUpdate;
};

export type MappedSessionUpdate = {
  chunks: UIMessageChunk[];
  state: SessionUpdateState;
};

export function createSessionUpdateState(_messageId: string): SessionUpdateState {
  throw new Error("not implemented");
}

// 显式返回新状态才能保持纯函数，同时记住文本段和工具调用的 id。
export function mapSessionUpdate(_update: SessionUpdate, _state: SessionUpdateState): MappedSessionUpdate {
  throw new Error("not implemented");
}

// ACP 文本块没有结束标记，最后一段要等 prompt 返回后才能发出 text-end/reasoning-end。
export function finishSessionUpdate(_state: SessionUpdateState, _stopReason: StopReason): MappedSessionUpdate {
  throw new Error("not implemented");
}
