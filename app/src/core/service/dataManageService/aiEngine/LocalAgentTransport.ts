import type { Project } from "@/core/Project";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import type { ExternalAiMcpLaunch } from "@/sub/SettingsWindow/externalAiCommands";
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { invoke } from "@tauri-apps/api/core";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { AIChatSessionStore, getAIChatProjectKey } from "./AIChatSessionStore";
import { RESEARCH_ASSISTANT_GUIDE, type AIMessageMetadata } from "./AIEngine";
import type { AIObjectReferenceRegistry } from "./AIObjectReferenceRegistry";
import { buildResearchContext } from "./ResearchContext";
import {
  buildLocalAgentMcpServers,
  createLocalAgentStream,
  createSessionUpdateState,
  finishSessionUpdate,
  getLocalAgentCatalog,
  isLocalAgentCommand,
  LocalAgentConnection,
  LocalAgentError,
  mapSessionUpdate,
  startLocalAgent,
  stopLocalAgent,
  type LocalAgentId,
  type LocalAgentPermissionRequest,
  type LocalAgentSession,
  type LocalAgentSessionControls,
  type LocalAgentStatus,
} from "./LocalAgent";

export type {
  LocalAgentChoice,
  LocalAgentPermissionRequest,
  LocalAgentSessionControls,
  LocalAgentStatus,
} from "./LocalAgent";

export type LocalAgentTransportOptions = {
  project: Project;
  references: AIObjectReferenceRegistry;
  agentId: LocalAgentId;
  pathOverride?: string;
};

export type LocalAgentPromptContext = {
  firstPrompt: boolean;
  workspace?: string;
  researchContext?: string;
  recentHistory?: string;
};

function messageText(message: UIMessage<AIMessageMetadata>): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function buildLocalAgentPrompt(
  message: UIMessage<AIMessageMetadata>,
  context: LocalAgentPromptContext,
): ContentBlock[] {
  const text = messageText(message);
  // 前面拼了工作区说明，程序就把命令当普通文字交给模型
  if (isLocalAgentCommand(text)) return [{ type: "text", text: text.trim() }];
  const workspace = context.workspace
    ? `当前工作区相对研究文件夹的路径：${JSON.stringify(context.workspace)}。调用白板工具时 workspace 填这个路径。`
    : "当前是未保存的草稿，白板工具用不了，只能根据下面的白板文字版回答。";
  return [
    {
      type: "text",
      text: [
        ...(context.firstPrompt
          ? [
              `${RESEARCH_ASSISTANT_GUIDE}\n需要更细的信息时可以调用工具查看白板对象；提到 n1、e1 这样的对象引用时用反引号包裹，方便用户点击定位。可以通过 research-workbench 的工具修改白板，改之前先说明要做什么。`,
            ]
          : []),
        workspace,
        ...(context.firstPrompt
          ? [
              context.researchContext,
              context.recentHistory ? `<recent-history>\n${context.recentHistory}\n</recent-history>` : "",
            ]
          : []),
        text,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

export function formatLocalAgentHistory(messages: UIMessage<AIMessageMetadata>[]): string {
  return messages
    .slice(-20)
    .flatMap((message) => {
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return text ? [`${message.role}: ${text}`] : [];
    })
    .join("\n")
    .slice(-6000);
}

type SendOptions = Parameters<ChatTransport<UIMessage<AIMessageMetadata>>["sendMessages"]>[0];
type ChatSession = LocalAgentSession & { firstPrompt: boolean };

export class LocalAgentTransport implements ChatTransport<UIMessage<AIMessageMetadata>> {
  private readonly lifetime = new AbortController();
  private readonly statusListeners = new Set<(status: LocalAgentStatus) => void>();
  private readonly permissionListeners = new Set<(request: LocalAgentPermissionRequest | null) => void>();
  private readonly controlsListeners = new Set<(controls: LocalAgentSessionControls) => void>();
  private controls: LocalAgentSessionControls = {
    modes: [],
    currentMode: null,
    models: [],
    currentModel: null,
    commands: [],
  };
  private status: LocalAgentStatus = { kind: "idle" };
  private permission: LocalAgentPermissionRequest | null = null;
  private connection?: LocalAgentConnection;
  private handle?: number;
  private readonly sessions = new Map<string, ChatSession>();
  private processExit?: LocalAgentError;
  private turn: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private update?: (update: SessionUpdate) => void;

  constructor(private readonly options: LocalAgentTransportOptions) {}

  prepareSession(chatId: string): Promise<void> {
    const ready = this.turn.then(async () => {
      this.lifetime.signal.throwIfAborted();
      const root = ResearchFolder.getRoot();
      if (!root) throw new LocalAgentError("no-research-folder");
      await this.ensureConnection(root, chatId);
    });
    this.turn = ready.catch((error) => {
      this.reportError(error);
    });
    return ready;
  }

  async sendMessages(options: SendOptions): Promise<ReadableStream<UIMessageChunk>> {
    const abort = new AbortController();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      abort.signal,
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    let cancelled = false;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.turn = this.turn.then(async () => {
          const emit = (chunk: UIMessageChunk) => {
            if (!cancelled) controller.enqueue(chunk);
          };
          try {
            await this.runTurn(options, signal, emit);
          } finally {
            if (!cancelled) controller.close();
          }
        });
      },
      cancel() {
        cancelled = true;
        abort.abort();
      },
    });
  }

  private async runTurn(
    options: SendOptions,
    signal: AbortSignal,
    emit: (chunk: UIMessageChunk) => void,
  ): Promise<void> {
    if (this.status.kind === "agent-error" || this.status.kind === "needs-login") this.setStatus({ kind: "idle" });
    let state = createSessionUpdateState(crypto.randomUUID());
    emit({ type: "start", messageId: state.messageId });
    try {
      signal.throwIfAborted();
      const root = ResearchFolder.getRoot();
      if (!root) throw new LocalAgentError("no-research-folder");
      const messageIndex = options.messages.findLastIndex((message) => message.role === "user");
      if (messageIndex < 0) throw new LocalAgentError("protocol");
      await this.options.project.aiEngine.prepareProjectReferences(this.options.project);
      const session = await this.ensureConnection(root, options.chatId);
      signal.throwIfAborted();
      const project = this.options.project;
      const message = options.messages[messageIndex];
      // 命令单独发，白板说明和历史留给下一条普通消息
      const command = isLocalAgentCommand(messageText(message));
      const firstPrompt = session.firstPrompt && !command;
      const blocks = buildLocalAgentPrompt(message, {
        firstPrompt,
        workspace: project.uri.scheme === "file" ? ResearchFolder.toRelative(project.uri.fsPath) : undefined,
        researchContext: firstPrompt ? await buildResearchContext(project) : undefined,
        recentHistory:
          firstPrompt && !session.loaded ? formatLocalAgentHistory(options.messages.slice(0, messageIndex)) : undefined,
      });
      signal.throwIfAborted();
      this.update = (update) => {
        const mapped = mapSessionUpdate(update, state);
        state = mapped.state;
        mapped.chunks.forEach(emit);
      };
      if (!command) session.firstPrompt = false;
      const response = await this.connection!.prompt(blocks, signal, session.sessionId);
      finishSessionUpdate(state, signal.aborted ? "cancelled" : response.stopReason).chunks.forEach(emit);
    } catch (error) {
      this.update = undefined;
      if (!signal.aborted) emit({ type: "error", errorText: `local-agent:${this.reportError(error)}` });
      try {
        await this.closeConnection();
      } catch (cleanupError) {
        this.setStatus({
          kind: "agent-error",
          agentId: this.options.agentId,
          reason: "protocol",
          detail: String(cleanupError),
          stderrTail: this.status.kind === "agent-error" ? this.status.stderrTail : [],
        });
        if (!signal.aborted) emit({ type: "error", errorText: "local-agent:protocol" });
      }
      finishSessionUpdate(state, signal.aborted ? "cancelled" : "end_turn").chunks.forEach(emit);
    } finally {
      this.update = undefined;
    }
  }

  private async ensureConnection(cwd: string, chatId: string): Promise<ChatSession> {
    if (!this.connection || this.status.kind !== "ready") await this.closeConnection();
    const existing = this.sessions.get(chatId);
    if (existing) {
      this.connection!.activateSession(existing.sessionId);
      return existing;
    }
    const launch = await invoke<ExternalAiMcpLaunch>("external_ai_mcp_launch");
    const mcpServers = buildLocalAgentMcpServers(launch);
    this.lifetime.signal.throwIfAborted();
    if (!this.connection) {
      this.setStatus({ kind: "starting" });
      const catalog = await getLocalAgentCatalog();
      const agent = catalog.find((agent) => agent.id === this.options.agentId);
      if (!agent || (!agent.resolvedPath && !this.options.pathOverride)) throw new LocalAgentError("not-found");
      this.lifetime.signal.throwIfAborted();
      let process;
      try {
        process = await startLocalAgent(this.options.agentId, this.options.pathOverride);
      } catch (error) {
        throw new LocalAgentError("spawn-failed", String(error));
      }
      this.handle = process.handle;
      if (this.lifetime.signal.aborted) {
        await process.events.cancel();
        this.lifetime.signal.throwIfAborted();
      }
      this.connection = await LocalAgentConnection.start(
        createLocalAgentStream(process.handle, process.events, (error) => {
          this.processExit = error;
          this.reportError(error);
        }),
        {
          agent,
          onStatus: (status) => {
            // SDK 的断连错误属于同一次进程退出，保留退出码和 stderr。
            if (status.kind === "agent-error" && status.reason === "exited" && this.processExit)
              this.reportError(this.processExit);
            else this.setStatus(status);
          },
          onPermissionRequest: (request) => this.setPermission(request),
          onControls: (controls) => this.setControls(controls),
          onSessionUpdate: (update) => this.update?.(update),
        },
        this.lifetime.signal,
      );
    }
    const projectKey = getAIChatProjectKey(this.options.project);
    const stored = await AIChatSessionStore.loadSession(projectKey, chatId);
    const session = await this.connection.openSession({
      cwd,
      mcpServers,
      previousSessionId: stored.localAgent?.agentId === this.options.agentId ? stored.localAgent.sessionId : undefined,
    });
    await AIChatSessionStore.setLocalAgentSession(getAIChatProjectKey(this.options.project), chatId, {
      agentId: this.options.agentId,
      sessionId: session.sessionId,
    });
    const chatSession = { ...session, firstPrompt: true };
    this.sessions.set(chatId, chatSession);
    this.setStatus({ kind: "ready", whiteboardTools: mcpServers.length > 0 });
    return chatSession;
  }

  private reportError(error: unknown): LocalAgentError["reason"] {
    let failure = error instanceof LocalAgentError ? error : new LocalAgentError("protocol", String(error));
    if (failure.reason === "exited" && this.processExit) failure = this.processExit;
    if (failure.reason !== "needs-login")
      this.setStatus({
        kind: "agent-error",
        agentId: this.options.agentId,
        reason: failure.reason,
        detail: failure.detail,
        stderrTail: failure.stderrTail,
      });
    return failure.reason;
  }

  async reconnectToStream(): Promise<null> {
    return null;
  }

  onStatus(listener: (status: LocalAgentStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onPermissionRequest(listener: (request: LocalAgentPermissionRequest | null) => void): () => void {
    this.permissionListeners.add(listener);
    listener(this.permission);
    return () => {
      this.permissionListeners.delete(listener);
    };
  }

  onControls(listener: (controls: LocalAgentSessionControls) => void): () => void {
    this.controlsListeners.add(listener);
    listener(this.controls);
    return () => {
      this.controlsListeners.delete(listener);
    };
  }

  private setControls(controls: LocalAgentSessionControls): void {
    this.controls = controls;
    this.controlsListeners.forEach((listener) => listener(controls));
  }

  // 只改当前这个会话；新会话照样从程序自己的默认配置开始
  async setMode(id: string): Promise<void> {
    if (!this.connection || this.lifetime.signal.aborted) throw new LocalAgentError("protocol");
    await this.connection.setMode(id);
  }

  async setModel(id: string): Promise<void> {
    if (!this.connection || this.lifetime.signal.aborted) throw new LocalAgentError("protocol");
    await this.connection.setModel(id);
  }

  private setStatus(status: LocalAgentStatus): void {
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status));
  }

  private setPermission(request: LocalAgentPermissionRequest | null): void {
    this.permission = request;
    this.permissionListeners.forEach((listener) => listener(request));
  }

  respondPermission(requestId: string, optionId: string | null): void {
    this.connection?.respondPermission(requestId, optionId);
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.sessions.clear();
    this.processExit = undefined;
    this.setControls({ modes: [], currentMode: null, models: [], currentModel: null, commands: [] });
    try {
      await connection?.dispose();
    } finally {
      if (this.handle !== undefined) {
        await stopLocalAgent(this.handle);
        this.handle = undefined;
      }
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.lifetime.abort();
      await this.turn;
      await this.closeConnection();
      this.setPermission(null);
      this.setStatus({ kind: "idle" });
    })();
    return this.disposal;
  }
}
