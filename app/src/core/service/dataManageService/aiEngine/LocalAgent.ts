import type { Settings } from "@/core/service/Settings";
import type { ExternalAiMcpLaunch } from "@/sub/SettingsWindow/externalAiCommands";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  client,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AnyMessage,
  type ClientConnection,
  type ContentBlock,
  type McpServer,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
  type Stream,
  type ToolCall,
  type UsageUpdate,
} from "@agentclientprotocol/sdk";
import type { UIMessageChunk } from "ai";
import type { AIMessageMetadata } from "./AIEngine";

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

export type LocalAgentProcess = { handle: number; events: ReadableStream<LocalAgentEvent> };

export type LocalAgentStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready"; whiteboardTools: boolean }
  | { kind: "needs-login"; agentId: string; loginCommand: string | null }
  | {
      kind: "agent-error";
      agentId: string;
      reason: "not-found" | "spawn-failed" | "exited" | "protocol" | "no-research-folder";
      detail: string;
      stderrTail: string[];
    };

export type LocalAgentPermissionRequest = {
  requestId: string;
  agentId: string;
  title: string;
  toolKind?: string;
  rawInput?: unknown;
  options: RequestPermissionRequest["options"];
};

export class LocalAgentError extends Error {
  constructor(
    readonly reason: Extract<LocalAgentStatus, { kind: "agent-error" }>["reason"] | "needs-login",
    readonly detail = "",
    readonly stderrTail: string[] = [],
  ) {
    super(`local-agent:${reason}`);
  }
}

export function getLocalAgentCatalog(): Promise<LocalAgentInfo[]> {
  return invoke("local_agent_catalog");
}

export async function startLocalAgent(agentId: LocalAgentId, pathOverride?: string): Promise<LocalAgentProcess> {
  const channel = new Channel<LocalAgentEvent>();
  let accepting = true;
  const events = new ReadableStream<LocalAgentEvent>({
    start(controller) {
      // Rust 可以在 invoke 返回句柄前写 Channel，ReadableStream 队列保留这些事件。
      channel.onmessage = (event) => {
        if (!accepting) return;
        controller.enqueue(event);
        if (event.kind === "exited") {
          accepting = false;
          controller.close();
        }
      };
    },
    cancel() {
      accepting = false;
    },
  });
  try {
    const handle = await invoke<number>("local_agent_start", { agentId, pathOverride, onEvent: channel });
    return { handle, events };
  } catch (error) {
    await events.cancel();
    throw error;
  }
}

export function writeLocalAgent(handle: number, line: string): Promise<void> {
  return invoke("local_agent_write", { handle, line });
}

export function stopLocalAgent(handle: number): Promise<void> {
  return invoke("local_agent_stop", { handle });
}

export function openLocalAgentTerminal(agentId: LocalAgentId, action: LocalAgentTerminalAction): Promise<void> {
  return invoke("local_agent_open_terminal", { agentId, action });
}

export function createLocalAgentStream(
  handle: number,
  events: ReadableStream<LocalAgentEvent>,
  onExit?: (error: LocalAgentError) => void,
): Stream {
  const reader = events.getReader();
  const stderrTail: string[] = [];
  return {
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value.kind === "stderr") {
            stderrTail.push(value.line);
            if (stderrTail.length > 200) stderrTail.shift();
          } else if (value.kind === "exited") {
            const error = new LocalAgentError("exited", JSON.stringify({ code: value.code }), [...stderrTail]);
            onExit?.(error);
            if (value.code === 0) controller.close();
            else controller.error(error);
            return;
          } else {
            try {
              const message: unknown = JSON.parse(value.line);
              if (!message || typeof message !== "object" || Array.isArray(message)) {
                throw new LocalAgentError("protocol", "", [...stderrTail]);
              }
              // JSON-RPC 字段和 ACP 参数的校验由 SDK 处理。
              controller.enqueue(message as AnyMessage);
            } catch (error) {
              controller.error(
                error instanceof LocalAgentError
                  ? error
                  : new LocalAgentError("protocol", String(error), [...stderrTail]),
              );
              await reader.cancel();
            }
            return;
          }
        }
      },
      cancel() {
        return reader.cancel();
      },
    }),
    writable: new WritableStream<AnyMessage>({
      write(message) {
        return writeLocalAgent(handle, JSON.stringify(message));
      },
    }),
  };
}

export function buildLocalAgentMcpServers(launch: ExternalAiMcpLaunch): McpServer[] {
  if (!launch.script) return [];
  return [
    {
      name: RESEARCH_WORKBENCH_MCP_NAME,
      command: launch.node ?? "node",
      args: [launch.script, "mcp", ...(launch.appHome ? ["--app-home", launch.appHome] : [])],
      env: [],
    },
  ];
}

export type LocalAgentConnectionOptions = {
  agent: LocalAgentInfo;
  getPermissionPolicy: () => LocalAgentPermissionPolicy;
  onStatus: (status: LocalAgentStatus) => void;
  onPermissionRequest: (request: LocalAgentPermissionRequest | null) => void;
  onSessionUpdate: (update: SessionUpdate) => void;
};

export type LocalAgentSessionOptions = { cwd: string; mcpServers: McpServer[]; previousSessionId?: string };
export type LocalAgentSession = { sessionId: string; loaded: boolean };

export class LocalAgentConnection {
  private connection!: ClientConnection;
  private supportsLoad = false;
  private sessionId?: string;
  private loading = false;
  private cancelling = false;
  private disposed = false;
  private disposal?: Promise<void>;
  private failure?: LocalAgentError;
  private readonly permissions = new Map<
    string,
    {
      request: LocalAgentPermissionRequest;
      resolve: (response: RequestPermissionResponse) => void;
    }
  >();

  private constructor(private readonly options: LocalAgentConnectionOptions) {}

  static async start(
    stream: Stream,
    options: LocalAgentConnectionOptions,
    signal?: AbortSignal,
  ): Promise<LocalAgentConnection> {
    const instance = new LocalAgentConnection(options);
    instance.connection = client({ name: "research-workbench" })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (!instance.loading && params.sessionId === instance.sessionId) options.onSessionUpdate(params.update);
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        instance.requestPermission(params, signal),
      )
      .connect(stream);
    const abort = () => {
      void instance.dispose().catch((error) => instance.reportError(error));
    };
    signal?.addEventListener("abort", abort, { once: true });
    instance.connection.signal.addEventListener(
      "abort",
      () => {
        signal?.removeEventListener("abort", abort);
        instance.cancelPermissions();
        if (!instance.disposed) instance.reportError(instance.connection.signal.reason, "exited");
      },
      { once: true },
    );
    if (signal?.aborted) abort();
    try {
      const response = await instance.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "research-workbench", version: "1" },
      });
      if (response.protocolVersion !== PROTOCOL_VERSION) throw new LocalAgentError("protocol");
      instance.supportsLoad = response.agentCapabilities?.loadSession === true;
      return instance;
    } catch (error) {
      if (instance.disposed) throw error;
      const failure = instance.reportError(error);
      await instance.dispose();
      throw failure;
    }
  }

  async openSession({ cwd, mcpServers, previousSessionId }: LocalAgentSessionOptions): Promise<LocalAgentSession> {
    try {
      if (previousSessionId && this.supportsLoad) {
        this.loading = true;
        try {
          await this.connection.agent.request(methods.agent.session.load, {
            sessionId: previousSessionId,
            cwd,
            mcpServers,
          });
          this.sessionId = previousSessionId;
          return { sessionId: previousSessionId, loaded: true };
        } catch (error) {
          // load 失败允许重建，但认证或断连错误不能伪装成可恢复的历史丢失。
          if (this.connection.signal.aborted || isAuthRequired(error)) throw error;
        } finally {
          this.loading = false;
        }
      }
      const response = await this.connection.agent.request(methods.agent.session.new, { cwd, mcpServers });
      this.sessionId = response.sessionId;
      return { sessionId: response.sessionId, loaded: false };
    } catch (error) {
      throw this.reportError(error);
    }
  }

  async prompt(blocks: ContentBlock[], signal?: AbortSignal, sessionId = this.sessionId): Promise<PromptResponse> {
    if (signal?.aborted) return { stopReason: "cancelled" };
    if (!sessionId || this.disposed) throw new LocalAgentError("protocol");
    this.sessionId = sessionId;
    this.cancelling = false;
    const abort = () => {
      void this.cancel().catch((error) => {
        this.connection.close(this.reportError(error));
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: blocks,
      });
    } catch (error) {
      if (this.disposed) throw error;
      throw this.reportError(error);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.cancelPermissions();
    }
  }

  async cancel(): Promise<void> {
    this.cancelling = true;
    this.cancelPermissions();
    // 先让权限处理器交回 cancelled，再把 cancel 排入 SDK 的发送队列。
    await Promise.resolve();
    if (this.sessionId && !this.connection.signal.aborted) {
      await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
    }
  }

  private requestPermission(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const policy = this.options.getPermissionPolicy();
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (this.disposed || this.cancelling || signal.aborted || request.sessionId !== this.sessionId)
      return Promise.resolve(cancelled);
    if (isWhiteboardToolCall(request.toolCall) || policy !== "ask") {
      const kinds =
        isWhiteboardToolCall(request.toolCall) || policy === "auto" ? ["allow_once", "allow_always"] : ["reject_once"];
      const option = kinds.map((kind) => request.options.find((option) => option.kind === kind)).find(Boolean);
      return Promise.resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelled);
    }
    const requestId = crypto.randomUUID();
    return new Promise<RequestPermissionResponse>((resolve) => {
      const abort = () => this.respondPermission(requestId, null);
      this.permissions.set(requestId, {
        request: {
          requestId,
          agentId: this.options.agent.id,
          title: request.toolCall.title ?? "",
          toolKind: request.toolCall.kind ?? undefined,
          rawInput: request.toolCall.rawInput,
          options: request.options,
        },
        resolve: (response) => {
          signal.removeEventListener("abort", abort);
          resolve(response);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (this.permissions.size === 1) this.options.onPermissionRequest(this.permissions.get(requestId)!.request);
    });
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const pending = this.permissions.get(requestId);
    if (!pending || (optionId !== null && !pending.request.options.some((option) => option.optionId === optionId)))
      return;
    const visible = this.permissions.keys().next().value === requestId;
    this.permissions.delete(requestId);
    pending.resolve({ outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
    if (visible) {
      this.options.onPermissionRequest(null);
      const next = this.permissions.values().next().value;
      if (next) this.options.onPermissionRequest(next.request);
    }
  }

  private cancelPermissions(): void {
    const pending = [...this.permissions.values()];
    this.permissions.clear();
    for (const permission of pending) permission.resolve({ outcome: { outcome: "cancelled" } });
    if (pending.length) this.options.onPermissionRequest(null);
  }

  private reportError(error: unknown, reason: LocalAgentError["reason"] = "protocol"): LocalAgentError {
    if (this.failure && (error === this.failure || (this.connection.signal.aborted && reason !== "exited")))
      return this.failure;
    const failure =
      error instanceof LocalAgentError
        ? error
        : new LocalAgentError(isAuthRequired(error) ? "needs-login" : reason, String(error));
    this.failure = failure;
    this.options.onStatus(
      failure.reason === "needs-login"
        ? { kind: "needs-login", agentId: this.options.agent.id, loginCommand: this.options.agent.loginCommand }
        : {
            kind: "agent-error",
            agentId: this.options.agent.id,
            reason: failure.reason,
            detail: failure.detail,
            stderrTail: failure.stderrTail,
          },
    );
    return failure;
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.disposed = true;
      try {
        await this.cancel();
      } finally {
        this.connection.close();
        await this.connection.closed;
      }
    })();
    return this.disposal;
  }
}

function isAuthRequired(error: unknown): boolean {
  return (
    (error instanceof RequestError && error.code === -32000) ||
    /auth[_ -]required|authentication required/i.test(String(error))
  );
}

export function isWhiteboardToolCall(toolCall: RequestPermissionRequest["toolCall"]): boolean {
  const isToolName = (value: unknown) =>
    typeof value === "string" && /^mcp__research-workbench__[A-Za-z0-9_]+$/.exec(value)?.[0] === value;
  const isWhiteboardMetadata = (value: unknown): boolean => {
    if (isToolName(value)) return true;
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([key, entry]) =>
        (["server", "serverName", "mcpServer"].includes(key) && entry === RESEARCH_WORKBENCH_MCP_NAME) ||
        isWhiteboardMetadata(entry),
    );
  };
  return isToolName(toolCall.title) || isWhiteboardMetadata(toolCall._meta);
}

export type SessionUpdateState = {
  readonly messageId: string;
  readonly nextPartId: number;
  readonly activePart?: { readonly kind: "text" | "reasoning"; readonly id: string };
  readonly toolCalls: Readonly<Record<string, ToolCall>>;
  // ACP 的 used/size 是上下文占用量，不能冒充 API 的 inputTokens/outputTokens。
  readonly metadata: Readonly<AIMessageMetadata & { localAgentUsage?: UsageUpdate }>;
};
export type MappedSessionUpdate = { chunks: UIMessageChunk[]; state: SessionUpdateState };

export function createSessionUpdateState(messageId: string): SessionUpdateState {
  return { messageId, nextPartId: 0, toolCalls: {}, metadata: {} };
}

function endPart(state: SessionUpdateState): MappedSessionUpdate {
  return {
    chunks: state.activePart ? [{ type: `${state.activePart.kind}-end`, id: state.activePart.id }] : [],
    state: { ...state, activePart: undefined },
  };
}

export function mapSessionUpdate(update: SessionUpdate, state: SessionUpdateState): MappedSessionUpdate {
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    if (update.content.type !== "text") return { chunks: [], state };
    const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning";
    const result = state.activePart?.kind === kind ? { chunks: [] as UIMessageChunk[], state } : endPart(state);
    if (!result.state.activePart) {
      const id = `${state.messageId}:${state.nextPartId}`;
      result.chunks.push({ type: `${kind}-start`, id });
      result.state = { ...result.state, nextPartId: state.nextPartId + 1, activePart: { kind, id } };
    }
    result.chunks.push({ type: `${kind}-delta`, id: result.state.activePart!.id, delta: update.content.text });
    return result;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const result = endPart(state);
    const previous = state.toolCalls[update.toolCallId];
    const supplied = Object.fromEntries(Object.entries(update).filter(([, value]) => value != null));
    const tool = { ...(previous ?? { title: update.toolCallId }), ...supplied } as ToolCall;
    result.state = { ...result.state, toolCalls: { ...state.toolCalls, [tool.toolCallId]: tool } };
    if (!previous)
      result.chunks.push({
        type: "tool-input-available",
        toolCallId: tool.toolCallId,
        toolName: tool.title,
        input: tool.rawInput ?? {},
        dynamic: true,
      });
    if (tool.status !== previous?.status && tool.status === "completed") {
      result.chunks.push({
        type: "tool-output-available",
        toolCallId: tool.toolCallId,
        output: tool.rawOutput ?? tool.content ?? null,
        dynamic: true,
      });
    } else if (tool.status !== previous?.status && tool.status === "failed") {
      const output = tool.rawOutput ?? tool.content;
      result.chunks.push({
        type: "tool-output-error",
        toolCallId: tool.toolCallId,
        errorText: typeof output === "string" ? output : output ? JSON.stringify(output) : "local-agent:protocol",
        dynamic: true,
      });
    }
    return result;
  }
  if (update.sessionUpdate === "usage_update") {
    const usage: UsageUpdate = {
      used: update.used,
      size: update.size,
      ...(update.cost == null ? {} : { cost: update.cost }),
    };
    const metadata = { ...state.metadata, localAgentUsage: usage };
    return { chunks: [{ type: "message-metadata", messageMetadata: metadata }], state: { ...state, metadata } };
  }
  return { chunks: [], state };
}

export function finishSessionUpdate(state: SessionUpdateState, stopReason: StopReason): MappedSessionUpdate {
  const result = endPart(state);
  result.chunks.push(
    stopReason === "cancelled"
      ? { type: "abort" }
      : {
          type: "finish",
          finishReason: stopReason === "max_tokens" ? "length" : stopReason === "refusal" ? "content-filter" : "stop",
          messageMetadata: state.metadata,
        },
  );
  return result;
}
