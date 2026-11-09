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
  type NewSessionResponse,
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
import z from "zod";
import type { AIMessageMetadata } from "./AIEngine";

export type LocalAgentId = Settings["aiLocalAgent"];
export type LocalAgentTerminalAction = "login" | "install";
export const RESEARCH_WORKBENCH_MCP_NAME = "research-workbench";

export type LocalAgentChoice = { id: string; name: string; description?: string };
/** 程序报上来的斜杠命令（/compact 之类），提示词以「/名字」开头就会被程序当作命令执行 */
export type LocalAgentCommand = { name: string; description: string; hint?: string };
export type LocalAgentSessionControls = {
  modes: LocalAgentChoice[];
  currentMode: string | null;
  models: LocalAgentChoice[];
  currentModel: string | null;
  commands: LocalAgentCommand[];
};

// SDK 已移除旧 models 的类型和校验，但实测程序仍会返回，退回旧格式时需要自己校验。
const legacyModelsSchema = z
  .object({
    currentModelId: z.string(),
    availableModels: z.array(z.object({ modelId: z.string(), name: z.string(), description: z.string().nullish() })),
  })
  .nullish();
type SessionControlState = {
  controls: LocalAgentSessionControls;
  modeConfigId?: string;
  modelConfigId?: string;
};

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
  onStatus: (status: LocalAgentStatus) => void;
  onControls: (controls: LocalAgentSessionControls) => void;
  onPermissionRequest: (request: LocalAgentPermissionRequest | null) => void;
  onSessionUpdate: (update: SessionUpdate) => void;
};

export type LocalAgentSessionOptions = {
  cwd: string;
  mcpServers: McpServer[];
  previousSessionId?: string;
};
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
  private readonly sessionControls = new Map<string, SessionControlState>();
  private readonly whiteboardToolCalls = new Set<string>();
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
        if (params.sessionId !== instance.sessionId || instance.disposed) return;
        if (params.update.sessionUpdate === "config_option_update") {
          instance.readControls(params.update);
          return;
        }
        if (params.update.sessionUpdate === "current_mode_update") {
          const state = instance.sessionControls.get(params.sessionId)!;
          state.controls = { ...state.controls, currentMode: params.update.currentModeId };
          options.onControls(state.controls);
          return;
        }
        if (params.update.sessionUpdate === "available_commands_update") {
          const state = instance.sessionControls.get(params.sessionId)!;
          state.controls = {
            ...state.controls,
            commands: params.update.availableCommands.map((command) => ({
              name: command.name,
              description: command.description ?? "",
              hint: command.input && "hint" in command.input ? String(command.input.hint) : undefined,
            })),
          };
          options.onControls(state.controls);
          return;
        }
        if (instance.loading) return;
        instance.noteToolCall(params.update);
        options.onSessionUpdate(params.update);
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

  // 模式和模型照两个 VS Code 插件的做法，沿用程序自己配置里的默认值，开会话时不替用户切换。
  async openSession({ cwd, mcpServers, previousSessionId }: LocalAgentSessionOptions): Promise<LocalAgentSession> {
    try {
      let loaded = false;
      if (previousSessionId && this.supportsLoad) {
        this.activateSession(previousSessionId);
        this.loading = true;
        let response: Partial<NewSessionResponse> | null | undefined;
        try {
          response = await this.connection.agent.request(methods.agent.session.load, {
            sessionId: previousSessionId,
            cwd,
            mcpServers,
          });
          loaded = true;
        } catch (error) {
          // load 失败允许重建，但认证或断连错误不能伪装成可恢复的历史丢失。
          if (this.connection.signal.aborted || isAuthRequired(error)) throw error;
        } finally {
          this.loading = false;
        }
        if (loaded) this.readControls(response ?? {});
      }
      if (!loaded) {
        const response = await this.connection.agent.request(methods.agent.session.new, { cwd, mcpServers });
        this.activateSession(response.sessionId);
        this.readControls(response);
      }
      return { sessionId: this.sessionId!, loaded };
    } catch (error) {
      throw this.reportError(error);
    }
  }

  activateSession(sessionId: string): void {
    this.sessionId = sessionId;
    if (!this.sessionControls.has(sessionId))
      this.sessionControls.set(sessionId, {
        controls: { modes: [], currentMode: null, models: [], currentModel: null, commands: [] },
      });
    this.options.onControls(this.sessionControls.get(sessionId)!.controls);
  }

  private readControls(response: Partial<NewSessionResponse>, sessionId = this.sessionId!): void {
    const state = this.sessionControls.get(sessionId)!;
    if (response.configOptions != null) {
      const mode = response.configOptions.find((option) => option.category === "mode" && option.type === "select");
      const model = response.configOptions.find((option) => option.category === "model" && option.type === "select");
      const choices = (option: typeof mode): LocalAgentChoice[] =>
        option?.type === "select"
          ? option.options
              .flatMap((item) => ("group" in item ? item.options : [item]))
              .map((item) => ({ id: item.value, name: item.name, description: item.description ?? undefined }))
          : [];
      state.modeConfigId = mode?.id;
      state.modelConfigId = model?.id;
      state.controls = {
        modes: choices(mode),
        currentMode: mode?.type === "select" ? mode.currentValue : null,
        models: choices(model),
        currentModel: model?.type === "select" ? model.currentValue : null,
        commands: state.controls.commands,
      };
    } else {
      if (response.modes != null) {
        state.modeConfigId = undefined;
        state.controls = {
          ...state.controls,
          modes: response.modes.availableModes.map((mode) => ({
            id: mode.id,
            name: mode.name,
            description: mode.description ?? undefined,
          })),
          currentMode: response.modes.currentModeId,
        };
      }
      // 可选字段格式不对就当没有，不能因此让整个会话起不来。
      const models = legacyModelsSchema.safeParse("models" in response ? response.models : undefined).data;
      if (models != null) {
        state.modelConfigId = undefined;
        state.controls = {
          ...state.controls,
          models: models.availableModels.map((model) => ({
            id: model.modelId,
            name: model.name,
            description: model.description ?? undefined,
          })),
          currentModel: models.currentModelId,
        };
      }
    }
    if (sessionId === this.sessionId) this.options.onControls(state.controls);
  }

  async setMode(id: string): Promise<void> {
    await this.setControl("mode", id);
  }

  async setModel(id: string): Promise<void> {
    await this.setControl("model", id);
  }

  private async setControl(kind: "mode" | "model", id: string): Promise<void> {
    const sessionId = this.sessionId;
    const state = sessionId ? this.sessionControls.get(sessionId) : undefined;
    if (!sessionId || !state || this.disposed) throw new LocalAgentError("protocol");
    const configId = kind === "mode" ? state.modeConfigId : state.modelConfigId;
    const choices = kind === "mode" ? state.controls.modes : state.controls.models;
    if (!choices.some((choice) => choice.id === id) || (kind === "model" && !configId))
      throw new LocalAgentError("protocol");
    try {
      const response: Partial<NewSessionResponse> | null = configId
        ? await this.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value: id })
        : await this.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: id });
      if (response?.configOptions != null) {
        this.readControls(response, sessionId);
      } else {
        state.controls = { ...state.controls, [kind === "mode" ? "currentMode" : "currentModel"]: id };
        if (sessionId === this.sessionId) this.options.onControls(state.controls);
      }
    } catch (error) {
      // 切换失败不影响会话本身，交给调用方提示；打开会话时的失败由 openSession 统一报告。
      if (this.connection.signal.aborted || isAuthRequired(error)) throw this.reportError(error);
      throw error instanceof LocalAgentError ? error : new LocalAgentError("protocol", String(error));
    }
  }

  async prompt(blocks: ContentBlock[], signal?: AbortSignal, sessionId = this.sessionId): Promise<PromptResponse> {
    if (signal?.aborted) return { stopReason: "cancelled" };
    if (!sessionId || this.disposed) throw new LocalAgentError("protocol");
    this.activateSession(sessionId);
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
      this.whiteboardToolCalls.clear();
    }
  }

  // Codex 的权限请求不带 _meta，要按 toolCallId 找回这次调用开头的 tool_call 来认白板工具。
  private noteToolCall(update: SessionUpdate): void {
    if (
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      isWhiteboardToolCall(update)
    )
      this.whiteboardToolCalls.add(update.toolCallId);
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
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (this.disposed || this.cancelling || signal.aborted || request.sessionId !== this.sessionId)
      return Promise.resolve(cancelled);
    const whiteboard =
      isWhiteboardToolCall(request.toolCall) || this.whiteboardToolCalls.has(request.toolCall.toolCallId);
    if (whiteboard) {
      const kinds = ["allow_once", "allow_always"];
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

/** 程序只在整段提示词以 `/` 开头时才当命令执行（2026-11-09 用 /context、/status 实测），所以命令要单独发 */
export function isLocalAgentCommand(text: string): boolean {
  return /^\/\S/.test(text.trim());
}

const CLAUDE_WHITEBOARD_TOOL = /^mcp__research-workbench__[A-Za-z0-9_]+$/;
const CODEX_WHITEBOARD_TOOL = /^mcp\.research-workbench\.[A-Za-z0-9_]+$/;

// 只认转接器自己填的固定字段（2026-11-09 用真实 Codex、Claude Code 数据核对过）：
// Claude 是 _meta.claudeCode.toolName；Codex 是 _meta.is_mcp_tool_call 加点分隔的标题。
// 标题单独不能作数：Codex 跑一条同名终端命令，标题和白板工具一字不差。rawInput 由 AI 填，一律不看。
export function isWhiteboardToolCall(toolCall: { title?: string | null; _meta?: { [key: string]: unknown } | null }) {
  const meta = toolCall._meta;
  if (!meta) return false;
  if (meta.claudeCode !== undefined) {
    const claudeCode = meta.claudeCode as { toolName?: unknown } | null;
    return typeof claudeCode?.toolName === "string" && CLAUDE_WHITEBOARD_TOOL.test(claudeCode.toolName);
  }
  return (
    meta.is_mcp_tool_call === true && typeof toolCall.title === "string" && CODEX_WHITEBOARD_TOOL.test(toolCall.title)
  );
}

export type SessionUpdateState = {
  readonly messageId: string;
  readonly nextPartId: number;
  readonly activePart?: { readonly kind: "text" | "reasoning"; readonly id: string };
  // 同一轮里程序可能先后发好几条消息（messageId 不同），每条单独成段，不首尾粘在一起
  readonly lastMessage?: { readonly id: string; readonly text: string; readonly duplicate: boolean };
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
    let current = state;
    let startsMessage = false;
    if (kind === "text" && update.messageId) {
      const last = state.lastMessage;
      if (last?.id === update.messageId) {
        if (last.duplicate) return { chunks: [], state };
        current = { ...state, lastMessage: { ...last, text: last.text + update.content.text } };
      } else {
        // Claude Code 的本地命令（如 /context）会把同一段结果换个 messageId 再发一遍（2026-11-09 实测），一字不差的第二条不显示
        const duplicate =
          last !== undefined && last.text.trim() !== "" && last.text.trim() === update.content.text.trim();
        current = { ...state, lastMessage: { id: update.messageId, text: update.content.text, duplicate } };
        if (duplicate) return { chunks: [], state: current };
        startsMessage = last !== undefined;
      }
    }
    const result =
      current.activePart?.kind === kind && !startsMessage
        ? { chunks: [] as UIMessageChunk[], state: current }
        : endPart(current);
    if (!result.state.activePart) {
      const id = `${current.messageId}:${current.nextPartId}`;
      result.chunks.push({ type: `${kind}-start`, id });
      result.state = { ...result.state, nextPartId: current.nextPartId + 1, activePart: { kind, id } };
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
