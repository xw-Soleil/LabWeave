import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentConnection,
  type AnyMessage,
  type PromptRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { Project } from "@/core/Project";
import { ResearchFolder } from "@/core/research/ResearchFolder";
import { formatReadingContext } from "@/core/research/ReadingContext";
import { Settings } from "@/core/service/Settings";
import { AIChatSessionStore, getAIChatProjectKey } from "./AIChatSessionStore";
import { buildResearchContext } from "./ResearchContext";
import { AIEngine, RESEARCH_SYSTEM_PROMPT, type AIMessageMetadata } from "./AIEngine";
import type { AIObjectReferenceRegistry } from "./AIObjectReferenceRegistry";
import { buildLocalAgentPrompt, formatLocalAgentHistory, LocalAgentTransport } from "./LocalAgentTransport";
import {
  LocalAgentConnection,
  type LocalAgentEvent,
  type LocalAgentInfo,
  type LocalAgentPermissionRequest,
  type LocalAgentSessionControls,
  type LocalAgentStatus,
} from "./LocalAgent";

const stores = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    private values: Map<string, unknown>;
    constructor(name: string) {
      this.values = stores.get(name) ?? new Map();
      stores.set(name, this.values);
    }
    async init() {}
    async entries() {
      return [...this.values.entries()];
    }
    async get(key: string) {
      return structuredClone(this.values.get(key));
    }
    async set(key: string, value: unknown) {
      this.values.set(key, structuredClone(value));
    }
    async delete(key: string) {
      this.values.delete(key);
    }
    async save() {}
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage?: (event: LocalAgentEvent) => void;
  },
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    aiBackend: "api",
    aiLocalAgent: "codex",
    aiLocalAgentPaths: {},
  },
}));
vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: { getRoot: vi.fn(() => "/research"), toRelative: vi.fn(() => "notes/board.prg") },
}));
vi.mock("./ResearchContext", () => ({ buildResearchContext: vi.fn(async () => "<whiteboard>n1 paper</whiteboard>") }));
vi.mock("@/core/research/ReadingContext", () => ({ formatReadingContext: vi.fn(() => "") }));
vi.mock("./AIChatSessionStore", async (original) => {
  const actual = await original<typeof import("./AIChatSessionStore")>();
  return {
    ...actual,
    AIChatSessionStore: {
      ...actual.AIChatSessionStore,
      loadSession: vi.fn(actual.AIChatSessionStore.loadSession),
      setLocalAgentSession: vi.fn(actual.AIChatSessionStore.setLocalAgentSession),
    },
  };
});
vi.mock("@/core/Project", () => ({ Project: class {}, service: () => (value: unknown) => value }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("@/utils/platform", () => ({ isMac: true }));
vi.mock("./AIAgentRuntime", () => ({ composeAgentSystemPrompt: vi.fn() }));
vi.mock("./BuiltInToolAgentAdapter", () => ({ createBuiltInToolAgentTools: vi.fn() }));
vi.mock("./AIProvider", () => ({ createChatModel: vi.fn(), mergeAIRequestHeaders: vi.fn() }));
vi.mock("./AIObjectReferenceRegistry", () => ({ AIObjectReferenceRegistry: class {} }));
vi.mock("./AIProjectReferenceStore", () => ({ AIProjectReferenceStore: { load: vi.fn() } }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const actualStore = await vi.importActual<typeof import("./AIChatSessionStore")>("./AIChatSessionStore");
const info: LocalAgentInfo = {
  id: "codex",
  name: "Codex",
  resolvedPath: "/bin/codex-acp",
  hostFound: true,
  loginCommand: "codex login",
  installCommand: null,
  homepage: "",
  tested: true,
};
const cleanups: (() => Promise<void>)[] = [];
const user = (text = "question", id = "u"): UIMessage<AIMessageMetadata> => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const assistant = (text: string): UIMessage<AIMessageMetadata> => ({
  id: `a-${text}`,
  role: "assistant",
  parts: [{ type: "text", text }],
});
const textUpdate = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
async function collect(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}
const promptText = (prompt: PromptRequest) =>
  prompt.prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(ResearchFolder.getRoot).mockReturnValue("/research");
  vi.mocked(ResearchFolder.toRelative).mockClear();
  vi.mocked(buildResearchContext).mockClear();
  vi.mocked(formatReadingContext).mockReturnValue("");
  vi.mocked(AIChatSessionStore.loadSession).mockReset().mockImplementation(actualStore.AIChatSessionStore.loadSession);
  vi.mocked(AIChatSessionStore.setLocalAgentSession)
    .mockReset()
    .mockImplementation(actualStore.AIChatSessionStore.setLocalAgentSession);
  Object.assign(Settings, {
    aiBackend: "api",
    aiLocalAgent: "codex",
    aiLocalAgentPaths: {},
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(configure?: (app: AgentApp) => void, draft = false) {
  const references = {} as AIObjectReferenceRegistry;
  const project = {
    uri: {
      scheme: draft ? "draft" : "file",
      fsPath: "/research/notes/board.prg",
      toString: () => `file:///research/${crypto.randomUUID()}`,
    },
    metadata: { workbench: { id: crypto.randomUUID() } },
    aiEngine: { prepareProjectReferences: vi.fn(async () => references) },
  } as unknown as Project;
  const key = getAIChatProjectKey(project);
  const { activeSession } = await actualStore.AIChatSessionStore.initializeProject(key);
  const prompts: PromptRequest[] = [];
  const newSession = vi.fn(() => ({ sessionId: "acp-new" }));
  const load = vi.fn(() => ({}));
  const processes = new Map<
    number,
    {
      peer: AgentConnection;
      writer: WritableStreamDefaultWriter<AnyMessage>;
      close: () => Promise<void>;
      event: (event: LocalAgentEvent) => void;
    }
  >();
  let nextHandle = 1;
  const launch = { node: "/node", script: "/cli.js", appHome: "/app-home" };
  const catalog = [info];
  let beforeStart: ((event: (event: LocalAgentEvent) => void) => Promise<void>) | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "local_agent_catalog") return catalog;
    if (command === "external_ai_mcp_launch") return launch;
    if (command === "local_agent_start") {
      const channel = (args as { onEvent: { onmessage: (event: LocalAgentEvent) => void } }).onEvent;
      await beforeStart?.((event) => channel.onmessage(event));
      const handle = nextHandle++;
      const app = agent();
      configure?.(app);
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
        .onRequest(methods.agent.session.new, newSession)
        .onRequest(methods.agent.session.load, load)
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          prompts.push(params);
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: textUpdate("answer"),
          });
          return { stopReason: "end_turn" };
        });
      const toAgent = new TransformStream<AnyMessage, AnyMessage>();
      const fromAgent = new TransformStream<AnyMessage, AnyMessage>();
      const peer = app.connect({ readable: toAgent.readable, writable: fromAgent.writable });
      const pump = fromAgent.readable.pipeTo(
        new WritableStream({
          write(message) {
            channel.onmessage({ kind: "stdout", line: JSON.stringify(message) });
          },
        }),
      );
      const writer = toAgent.writable.getWriter();
      processes.set(handle, {
        peer,
        writer,
        event: (event) => channel.onmessage(event),
        close: async () => {
          peer.close();
          await fromAgent.writable.getWriter().close();
          await pump;
        },
      });
      return handle;
    }
    if (command === "local_agent_write") {
      const { handle, line } = args as { handle: number; line: string };
      await processes.get(handle)!.writer.write(JSON.parse(line));
      return;
    }
    if (command === "local_agent_stop") {
      const { handle } = args as { handle: number };
      const process = processes.get(handle);
      if (process) {
        await process.close();
        processes.delete(handle);
      }
      return;
    }
    throw new Error(`unexpected:${command}`);
  });
  const transport = new LocalAgentTransport({
    project,
    references,
    agentId: "codex",
    pathOverride: "/custom/codex-acp",
  });
  cleanups.push(() => transport.dispose());
  const statuses: LocalAgentStatus[] = [];
  const permissions: (LocalAgentPermissionRequest | null)[] = [];
  const controls: LocalAgentSessionControls[] = [];
  transport.onStatus((status) => statuses.push(status));
  transport.onPermissionRequest((permission) => permissions.push(permission));
  transport.onControls((value) => controls.push(value));
  const send = (messages = [user()], signal?: AbortSignal, chatId = activeSession.id) =>
    transport.sendMessages({ trigger: "submit-message", chatId, messageId: undefined, messages, abortSignal: signal });
  return {
    project,
    references,
    key,
    chatId: activeSession.id,
    transport,
    statuses,
    permissions,
    controls,
    prompts,
    newSession,
    load,
    catalog,
    launch,
    processes,
    send,
    beforeStart: (hook: typeof beforeStart) => {
      beforeStart = hook;
    },
  };
}

describe("LocalAgentTransport with an in-memory SDK agent", () => {
  it("sends the current reading context on every ordinary turn without changing visible user messages", async () => {
    const f = await setup();
    const message = user("explain this");
    vi.mocked(formatReadingContext).mockReturnValue("<reading-context>paper.pdf page 2 quote</reading-context>");
    await collect(await f.send([message]));
    vi.mocked(formatReadingContext).mockReturnValue("<reading-context>paper.pdf page 5</reading-context>");
    await collect(await f.send([message]));
    expect(promptText(f.prompts[0])).toContain("page 2 quote");
    expect(promptText(f.prompts[1])).toContain("page 5");
    expect(promptText(f.prompts[1])).not.toContain("page 2");
    expect(message.parts).toEqual([{ type: "text", text: "explain this" }]);
    await collect(await f.send([user("/compact")]));
    expect(promptText(f.prompts[2])).toBe("/compact");
    vi.mocked(formatReadingContext).mockReturnValue("");
    await collect(await f.send([message]));
    expect(promptText(f.prompts[3])).not.toContain("reading-context");
  });
  it("上下文弹层和斜杠命令排在载入之后，重放不混入结果且仍使用原会话", async () => {
    let release!: () => void;
    const load = vi.fn(
      async ({ client, params }: { client: AgentConnection["client"]; params: { sessionId: string } }) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: textUpdate("old replay"),
        });
        return {};
      },
    );
    const f = await setup((app) => app.onRequest(methods.agent.session.load, load));
    await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, {
      agentId: "codex",
      sessionId: "original",
    });
    const preparing = f.transport.prepareSession(f.chatId);
    const inspecting = f.transport.inspectContext(f.chatId);
    const sending = collect(await f.send([user("old question"), assistant("old answer"), user("/compact")]));
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(f.statuses.at(-1)).toEqual({ kind: "starting" });
    expect(f.controls.at(-1)?.commands).toEqual([]);
    expect(f.prompts).toEqual([]);
    await expect(f.transport.setMode("old-mode")).rejects.toThrow();
    release();
    await preparing;
    expect(await inspecting).toEqual({ command: "status", text: "answer" });
    await sending;
    expect(f.prompts.map((prompt) => ({ sessionId: prompt.sessionId, text: promptText(prompt) }))).toEqual([
      { sessionId: "original", text: "/status" },
      { sessionId: "original", text: "/compact" },
    ]);
    expect(f.newSession).not.toHaveBeenCalled();
    await collect(await f.send([user("normal question")]));
    expect(promptText(f.prompts[2])).toContain("<whiteboard>");
    expect(promptText(f.prompts[2])).not.toContain("recent-history");
  });

  it("同一聊天切换 Codex、Claude Code 再切回时分别恢复各自的会话", async () => {
    const f = await setup();
    f.catalog.push({ ...info, id: "claude", name: "Claude Code" });
    f.newSession
      .mockReturnValueOnce({ sessionId: "codex-original" })
      .mockReturnValueOnce({ sessionId: "claude-original" });
    await f.transport.prepareSession(f.chatId);
    await f.transport.dispose();
    const claude = new LocalAgentTransport({ project: f.project, references: f.references, agentId: "claude" });
    cleanups.push(() => claude.dispose());
    await claude.prepareSession(f.chatId);
    await claude.dispose();
    const codex = new LocalAgentTransport({ project: f.project, references: f.references, agentId: "codex" });
    cleanups.push(() => codex.dispose());
    await codex.prepareSession(f.chatId);
    expect(f.load).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ sessionId: "codex-original" }) }),
    );
    expect(f.newSession).toHaveBeenCalledTimes(2);
  });
  it("控制项立即回放和退订；沿用程序默认，切换只改当前会话，失败不变", async () => {
    let configOptions = [
      {
        id: "permissions",
        name: "Mode",
        category: "mode",
        type: "select" as const,
        currentValue: "agent",
        options: [
          { value: "read-only", name: "Read-only" },
          { value: "agent", name: "Auto review" },
        ],
      },
      {
        id: "models",
        name: "Model",
        category: "model",
        type: "select" as const,
        currentValue: "model-1",
        options: [
          { value: "model-1", name: "One" },
          { value: "model-2", name: "Two" },
        ],
      },
    ];
    let fail = false;
    const f = await setup((app) =>
      app
        .onRequest(methods.agent.session.new, () => ({ sessionId: "acp-new", configOptions }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          if (fail) throw RequestError.internalError();
          if (typeof params.value !== "string") throw RequestError.invalidParams();
          const value = params.value;
          configOptions = configOptions.map((option) =>
            option.id === params.configId ? { ...option, currentValue: value } : option,
          );
          return { configOptions };
        }),
    );
    const listener = vi.fn();
    const unsubscribe = f.transport.onControls(listener);
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      modes: [],
      models: [],
      currentMode: null,
      currentModel: null,
      commands: [],
    });
    await expect(f.transport.setMode("read-only")).rejects.toMatchObject({ reason: "protocol" });
    await f.transport.prepareSession(f.chatId);
    expect(f.prompts).toHaveLength(0);
    // 照程序自己的默认配置，不替用户切换
    expect(f.controls.at(-1)).toMatchObject({ currentMode: "agent", currentModel: "model-1" });
    const late = vi.fn();
    f.transport.onControls(late)();
    expect(late).toHaveBeenCalledExactlyOnceWith(f.controls.at(-1));
    unsubscribe();
    const count = listener.mock.calls.length;
    await f.transport.setMode("read-only");
    await f.transport.setModel("model-2");
    expect(listener).toHaveBeenCalledTimes(count);
    expect(f.controls.at(-1)).toMatchObject({ currentMode: "read-only", currentModel: "model-2" });
    fail = true;
    await expect(f.transport.setMode("agent")).rejects.toMatchObject({ reason: "protocol" });
    await expect(f.transport.setModel("model-1")).rejects.toMatchObject({ reason: "protocol" });
    expect(f.controls.at(-1)).toMatchObject({ currentMode: "read-only", currentModel: "model-2" });
    expect(f.statuses.at(-1)).toMatchObject({ kind: "ready" });
    await f.transport.dispose();
    expect(f.controls.at(-1)).toEqual({ modes: [], models: [], currentMode: null, currentModel: null, commands: [] });
  });

  it("发送前准备与发送共用队列；切换会话时回放各自控制项", async () => {
    let index = 0;
    const f = await setup((app) =>
      app.onRequest(methods.agent.session.new, () => ({
        sessionId: `acp-${++index}`,
        modes: { currentModeId: `mode-${index}`, availableModes: [{ id: `mode-${index}`, name: `Mode ${index}` }] },
      })),
    );
    const { activeSession: second } = await actualStore.AIChatSessionStore.createSession(f.key);
    const firstReady = f.transport.prepareSession(f.chatId);
    const firstTurn = collect(await f.send());
    await firstReady;
    await firstTurn;
    expect(index).toBe(1);
    await f.transport.prepareSession(second.id);
    expect(f.controls.at(-1)?.currentMode).toBe("mode-2");
    await f.transport.prepareSession(f.chatId);
    expect(f.controls.at(-1)?.currentMode).toBe("mode-1");
    expect(index).toBe(2);
  });

  it("准备会话失败向调用者和状态订阅报告；重试仍可成功", async () => {
    const f = await setup();
    vi.mocked(ResearchFolder.getRoot).mockReturnValueOnce("");
    await expect(f.transport.prepareSession(f.chatId)).rejects.toMatchObject({ reason: "no-research-folder" });
    expect(f.statuses.at(-1)).toMatchObject({ kind: "agent-error", reason: "no-research-folder" });
    await f.transport.prepareSession(f.chatId);
    expect(f.statuses.at(-1)).toMatchObject({ kind: "ready" });
  });

  it.each([false, true])("切换两个会话再切回来只启动一次，每个会话只 open 一次；首个会话已保存=%s", async (saved) => {
    const f = await setup();
    const openSession = vi.spyOn(LocalAgentConnection.prototype, "openSession");
    const { activeSession: second } = await actualStore.AIChatSessionStore.createSession(f.key);
    if (saved)
      await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, {
        agentId: "codex",
        sessionId: "acp-old",
      });
    f.newSession.mockReturnValueOnce({ sessionId: "acp-1" }).mockReturnValueOnce({ sessionId: "acp-2" });
    const firstMessages = [user("first history"), assistant("first answer"), user("first current")];
    const secondMessages = [user("second history"), assistant("second answer"), user("second current")];
    for (const [chatId, messages] of [
      [f.chatId, firstMessages],
      [second.id, secondMessages],
      [f.chatId, [...firstMessages, user("back to first")]],
      [second.id, [...secondMessages, user("back to second")]],
    ] satisfies [string, UIMessage<AIMessageMetadata>[]][]) {
      const chunks = await collect(await f.send(messages, undefined, chatId));
      expect(chunks).toContainEqual({ type: "text-delta", id: expect.any(String), delta: "answer" });
    }
    expect(f.prompts.map((prompt) => prompt.sessionId)).toEqual(
      saved ? ["acp-old", "acp-1", "acp-old", "acp-1"] : ["acp-1", "acp-2", "acp-1", "acp-2"],
    );
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(openSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ previousSessionId: saved ? "acp-old" : undefined }),
    );
    expect(openSession).toHaveBeenNthCalledWith(2, expect.objectContaining({ previousSessionId: undefined }));
    expect(f.load).toHaveBeenCalledTimes(saved ? 1 : 0);
    expect(f.newSession).toHaveBeenCalledTimes(saved ? 1 : 2);
    expect(promptText(f.prompts[0]).includes("recent-history")).toBe(!saved);
    expect(promptText(f.prompts[1])).toContain("assistant: second answer");
    for (const prompt of f.prompts.slice(0, 2)) expect(promptText(prompt)).toContain("<whiteboard>");
    for (const prompt of f.prompts.slice(2)) {
      expect(promptText(prompt)).not.toContain("<whiteboard>");
      expect(promptText(prompt)).not.toContain("recent-history");
      expect(promptText(prompt)).not.toContain("研究助手");
    }
    expect(buildResearchContext).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "local_agent_start")).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "local_agent_stop")).toHaveLength(0);
  });

  it("首次发送启动，后续复用；首条携带说明、相对工作区、上下文；只取最后用户消息且不重复 selected", async () => {
    const f = await setup();
    expect(invoke).not.toHaveBeenCalled();
    expect(await f.transport.reconnectToStream()).toBeNull();
    const chunks = await collect(
      await f.send([user("old"), assistant("history"), user("[selected: n1] current", "last"), assistant("tail")]),
    );
    expect(chunks[0]).toEqual({ type: "start", messageId: expect.any(String) });
    expect(chunks.at(-1)?.type).toBe("finish");
    const prompt = promptText(f.prompts[0]);
    expect(prompt).toContain("可以通过 research-workbench 的工具修改白板，改之前先说明要做什么");
    expect(prompt).toContain('"notes/board.prg"');
    expect(prompt).toContain("<whiteboard>n1 paper</whiteboard>");
    expect(prompt.endsWith("[selected: n1] current")).toBe(true);
    expect(prompt).not.toContain("assistant: tail");
    expect(f.project.aiEngine.prepareProjectReferences).toHaveBeenCalledWith(f.project);
    expect(ResearchFolder.toRelative).toHaveBeenCalledWith("/research/notes/board.prg");
    expect(f.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          cwd: "/research",
          mcpServers: [
            {
              name: "research-workbench",
              command: "/node",
              args: ["/cli.js", "mcp", "--app-home", "/app-home"],
              env: [],
            },
          ],
        },
      }),
    );
    await collect(await f.send([user("[selected: n2] next")]));
    const next = promptText(f.prompts[1]);
    expect(next.match(/\[selected:/g)).toHaveLength(1);
    expect(next).toContain("workspace");
    expect(next.endsWith("[selected: n2] next")).toBe(true);
    expect(next).not.toContain("<whiteboard>");
    expect(next).not.toContain("研究助手");
    expect(next).not.toContain("recent-history");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "local_agent_start")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      "local_agent_start",
      expect.objectContaining({ agentId: "codex", pathOverride: "/custom/codex-acp" }),
    );
    expect(buildResearchContext).toHaveBeenCalledTimes(1);
    expect(AIChatSessionStore.setLocalAgentSession).toHaveBeenCalledWith(
      f.key,
      f.chatId,
      { agentId: "codex", sessionId: "acp-new" },
      expect.any(AbortSignal),
    );
  });

  it("第一条是斜杠命令时只发命令，白板说明留到下一条普通消息", async () => {
    const f = await setup();
    await collect(await f.send([user("/status")]));
    expect(promptText(f.prompts[0])).toBe("/status");
    expect(buildResearchContext).not.toHaveBeenCalled();
    await collect(await f.send([user("/status"), assistant("ok"), user("看看白板")]));
    const next = promptText(f.prompts[1]);
    expect(next).toContain("<whiteboard>n1 paper</whiteboard>");
    expect(next).toContain("可以通过 research-workbench 的工具修改白板");
    expect(next.endsWith("看看白板")).toBe(true);
  });

  it("逐字、思考、工具成功/失败和 usage 流可被 AI SDK readUIMessageStream 读取", async () => {
    const updates: SessionUpdate[] = [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } },
      textUpdate("a"),
      textUpdate("b"),
      { sessionUpdate: "tool_call", toolCallId: "ok", title: "read", rawInput: { path: "a" } },
      { sessionUpdate: "tool_call_update", toolCallId: "ok", status: "completed", rawOutput: "data" },
      { sessionUpdate: "tool_call", toolCallId: "bad", title: "write", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "bad", status: "failed", rawOutput: "denied" },
      { sessionUpdate: "usage_update", used: 12, size: 100 },
    ];
    const f = await setup((app) =>
      app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        for (const update of updates)
          await client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
        return { stopReason: "end_turn" };
      }),
    );
    const errors = vi.fn();
    const messages: UIMessage[] = [];
    for await (const message of readUIMessageStream({
      stream: await f.send(),
      onError: errors,
      terminateOnError: true,
    }))
      messages.push(structuredClone(message));
    expect(errors).not.toHaveBeenCalled();
    const last = messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "ab", state: "done" }),
        expect.objectContaining({ type: "reasoning", text: "think", state: "done" }),
        expect.objectContaining({ type: "dynamic-tool", toolCallId: "ok", state: "output-available", output: "data" }),
        expect.objectContaining({
          type: "dynamic-tool",
          toolCallId: "bad",
          state: "output-error",
          errorText: "denied",
        }),
      ]),
    );
    expect(last.metadata).toEqual({ localAgentUsage: { used: 12, size: 100 } });
  });

  it.each(["loaded", "unsupported", "load-failed", "other-agent"])(
    "保存/恢复会话 %s，重放丢弃，回退只在首条附历史",
    async (mode) => {
      const observed: PromptRequest[] = [];
      const load = vi.fn(async ({ client }: { client: AgentConnection["client"] }) => {
        await client.notify(methods.client.session.update, { sessionId: "old", update: textUpdate("replayed") });
        if (mode === "load-failed") throw RequestError.sessionNotFound("old");
        return {};
      });
      const f = await setup((app) =>
        app
          .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: mode !== "unsupported" },
          }))
          .onRequest(methods.agent.session.load, load)
          .onRequest(methods.agent.session.prompt, ({ params }) => {
            observed.push(params);
            return { stopReason: "end_turn" };
          }),
      );
      await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, {
        agentId: mode === "other-agent" ? "claude" : "codex",
        sessionId: "old",
      });
      const chunks = await collect(await f.send([user("previous"), assistant("past answer"), user("current")]));
      expect(chunks.some((chunk) => chunk.type === "text-delta")).toBe(false);
      expect(load).toHaveBeenCalledTimes(mode === "unsupported" || mode === "other-agent" ? 0 : 1);
      const first = promptText(observed[0]);
      expect(first.includes("recent-history")).toBe(mode !== "loaded");
      if (mode !== "loaded") expect(first).toContain("assistant: past answer");
      await collect(await f.send([user("next")]));
      expect(promptText(observed[1])).not.toContain("recent-history");
      const binding = (await actualStore.AIChatSessionStore.loadSession(f.key, f.chatId)).localAgents?.codex;
      expect(binding).toMatchObject({
        agentId: "codex",
        sessionId: mode === "loaded" ? "old" : "acp-new",
      });
      if (mode === "unsupported" || mode === "load-failed") {
        expect(binding?.recovery).toMatchObject({
          previousSessionId: "old",
          reason: mode === "load-failed" ? "not-found" : mode,
        });
        expect(f.statuses.at(-1)).toMatchObject({ kind: "ready", recovery: binding!.recovery });
      } else {
        expect(binding?.recovery).toBeUndefined();
        expect(f.statuses.at(-1)).not.toHaveProperty("recovery");
      }
    },
  );

  it.each(["no-mcp", "draft", "no-root"])("环境 %s 的提示和状态", async (mode) => {
    const f = await setup(undefined, mode === "draft");
    if (mode === "no-mcp") f.launch.script = "";
    if (mode === "no-root") vi.mocked(ResearchFolder.getRoot).mockReturnValue("");
    const chunks = await collect(await f.send());
    if (mode === "no-root") {
      expect(invoke).not.toHaveBeenCalled();
      expect(chunks).toContainEqual({ type: "error", errorText: "local-agent:no-research-folder" });
      expect(f.statuses.at(-1)).toMatchObject({ kind: "agent-error", reason: "no-research-folder" });
    } else {
      expect(f.statuses.at(-1)).toEqual({ kind: "ready", chatId: f.chatId, whiteboardTools: mode !== "no-mcp" });
      if (mode === "no-mcp")
        expect(f.newSession).toHaveBeenCalledWith(
          expect.objectContaining({ params: expect.objectContaining({ mcpServers: [] }) }),
        );
      if (mode === "draft") {
        expect(promptText(f.prompts[0])).toContain("当前是未保存的草稿，白板工具用不了，只能根据下面的白板文字版回答");
        expect(ResearchFolder.toRelative).not.toHaveBeenCalled();
      }
    }
  });

  it("订阅即回放当前状态，退订有效；旧三档都不影响权限事件/回答往返", async () => {
    const replies: unknown[] = [];
    const f = await setup((app) =>
      app.onRequest(methods.agent.session.prompt, async ({ client, params }) => {
        replies.push(
          await client.request(methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: { toolCallId: "t", title: "shell" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
        );
        return { stopReason: "end_turn" };
      }),
    );
    const unsubscribed = vi.fn();
    f.transport.onStatus(unsubscribed)();
    const permissionListener = vi.fn();
    const unsubscribe = f.transport.onPermissionRequest(permissionListener);
    const completed = collect(await f.send());
    await vi.waitFor(() => expect(f.permissions.at(-1)).not.toBeNull());
    const permission = f.permissions.at(-1)!;
    const late = vi.fn();
    f.transport.onPermissionRequest(late)();
    expect(late).toHaveBeenCalledWith(permission);
    f.transport.respondPermission(permission.requestId, "allow");
    await completed;
    expect(replies).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }]);
    expect(permissionListener).toHaveBeenLastCalledWith(null);
    unsubscribe();
    const count = permissionListener.mock.calls.length;
    const next = collect(await f.send());
    await vi.waitFor(() => expect(f.permissions.at(-1)).not.toBeNull());
    f.transport.respondPermission(f.permissions.at(-1)!.requestId, "deny");
    await next;
    expect(replies.at(-1)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(permissionListener).toHaveBeenCalledTimes(count);
    expect(unsubscribed).toHaveBeenCalledExactlyOnceWith({ kind: "idle" });
    expect(f.statuses.slice(0, 3)).toEqual([
      { kind: "idle" },
      { kind: "starting" },
      { kind: "ready", chatId: f.chatId, whiteboardTools: true },
    ]);
  });

  it.each(["abort", "dispose"])("%s 取消权限并以 abort 结束，用户中止后可复用", async (action) => {
    const replies: unknown[] = [];
    const cancelled = vi.fn();
    const f = await setup((app) =>
      app
        .onNotification(methods.agent.session.cancel, cancelled)
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          replies.push(
            await client.request(methods.client.session.requestPermission, {
              sessionId: params.sessionId,
              toolCall: { toolCallId: "t", title: "shell" },
              options: [],
            }),
          );
          return { stopReason: "cancelled" };
        }),
    );
    const abort = new AbortController();
    const completed = collect(await f.send([user()], abort.signal));
    await vi.waitFor(() => expect(f.permissions.at(-1)).not.toBeNull());
    if (action === "abort") abort.abort();
    else await f.transport.dispose();
    expect((await completed).at(-1)).toEqual({ type: "abort" });
    expect(replies).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(cancelled).toHaveBeenCalled();
    if (action === "abort") {
      const next = collect(await f.send());
      await vi.waitFor(() => expect(f.permissions.at(-1)).not.toBeNull());
      f.transport.respondPermission(f.permissions.at(-1)!.requestId, null);
      await next;
    } else expect(f.processes.size).toBe(0);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "local_agent_start")).toHaveLength(1);
  });

  it.each(["start", "initialize", "prompt", "ready"])(
    "在 %s 阶段 dispose，清理迟到句柄、挂起连接并可重复调用",
    async (phase) => {
      let release!: () => void;
      const entered = vi.fn();
      const f = await setup((app) => {
        if (phase === "initialize")
          app.onRequest(methods.agent.initialize, async ({ signal }) => {
            entered();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return { protocolVersion: 1 };
          });
        if (phase === "prompt")
          app.onRequest(methods.agent.session.prompt, async ({ signal }) => {
            entered();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return { stopReason: "cancelled" };
          });
      });
      if (phase === "start")
        f.beforeStart(async () => {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        });
      const completed = collect(await f.send());
      if (phase === "ready") await completed;
      else await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      const disposal = f.transport.dispose();
      if (phase === "start") release();
      await disposal;
      await f.transport.dispose();
      const chunks = await completed;
      expect(chunks.at(-1)?.type).toBe(phase === "ready" ? "finish" : "abort");
      expect(f.processes.size).toBe(0);
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "local_agent_stop")).toHaveLength(1);
    },
  );

  it.each(["not-found", "spawn-failed", "protocol", "needs-login", "exited"])(
    "%s 在状态与消息流报告，并清理已获取的句柄",
    async (reason) => {
      const f = await setup((app) => {
        if (reason === "protocol" || reason === "needs-login")
          app.onRequest(methods.agent.initialize, () => {
            throw reason === "needs-login" ? RequestError.authRequired() : RequestError.internalError("bad protocol");
          });
      });
      if (reason === "not-found") f.catalog.length = 0;
      if (reason === "spawn-failed")
        f.beforeStart(async () => {
          throw new Error("spawn failed");
        });
      if (reason === "exited")
        f.beforeStart(async (event) => {
          event({ kind: "stderr", line: "Node too old" });
          event({ kind: "exited", code: 1 });
        });
      const chunks = await collect(await f.send());
      expect(chunks).toContainEqual({ type: "error", errorText: `local-agent:${reason}` });
      expect(chunks.at(-1)?.type).toBe("finish");
      expect(f.statuses.at(-1)).toMatchObject(
        reason === "needs-login"
          ? { kind: "needs-login", loginCommand: "codex login" }
          : { kind: "agent-error", reason },
      );
      if (reason === "exited") expect(f.statuses.at(-1)).toMatchObject({ stderrTail: ["Node too old"] });
      expect(f.processes.size).toBe(0);
      expect(AIChatSessionStore.setLocalAgentSession).not.toHaveBeenCalled();
    },
  );

  it("意外退出后下一次发送重启，重新使用保存的会话号", async () => {
    const f = await setup();
    await collect(await f.send());
    f.processes.get(1)!.event({ kind: "stderr", line: "crash" });
    f.processes.get(1)!.event({ kind: "exited", code: 2 });
    await vi.waitFor(() => expect(f.statuses.at(-1)).toMatchObject({ reason: "exited" }));
    await collect(await f.send());
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "local_agent_start")).toHaveLength(2);
    expect(f.load).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ sessionId: "acp-new" }) }),
    );
    expect(f.statuses.at(-1)).toEqual({ kind: "ready", chatId: f.chatId, whiteboardTools: true });
  });

  it("关闭或热重载期间迟到的打开结果不能覆盖已保存的会话号", async () => {
    const f = await setup();
    await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, {
      agentId: "codex",
      sessionId: "original",
    });
    let finish!: (session: { sessionId: string; loaded: boolean }) => void;
    const openSession = vi.spyOn(LocalAgentConnection.prototype, "openSession").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const preparing = f.transport.prepareSession(f.chatId).then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(openSession).toHaveBeenCalledOnce());
    const closing = f.transport.dispose();
    finish({ sessionId: "late-fallback", loaded: false });
    await closing;
    expect((await actualStore.AIChatSessionStore.loadSession(f.key, f.chatId)).localAgents?.codex.sessionId).toBe(
      "original",
    );
    expect(await preparing).toBe("rejected");
    expect(AIChatSessionStore.setLocalAgentSession).not.toHaveBeenCalled();
  });

  it("重启 transport 后恢复原会话，第一条 compact 不新建也不附历史", async () => {
    const f = await setup();
    await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, {
      agentId: "codex",
      sessionId: "original",
    });
    await f.transport.prepareSession(f.chatId);
    await f.transport.dispose();
    const restarted = new LocalAgentTransport({ project: f.project, references: f.references, agentId: "codex" });
    cleanups.push(() => restarted.dispose());
    await restarted.prepareSession(f.chatId);
    await collect(
      await restarted.sendMessages({
        trigger: "submit-message",
        chatId: f.chatId,
        messageId: undefined,
        messages: [user("previous"), assistant("past"), user("/compact")],
        abortSignal: undefined,
      }),
    );
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.newSession).not.toHaveBeenCalled();
    expect(f.prompts[0]).toMatchObject({ sessionId: "original", prompt: [{ type: "text", text: "/compact" }] });
  });

  it("恢复提示按聊天保留，确认后跨重启清除，新一次失败重新提示", async () => {
    const f = await setup((app) =>
      app.onRequest(methods.agent.session.load, ({ params }) => {
        if (params.sessionId === "original") throw RequestError.internalError({ detail: "Cannot read transcript" });
        return {};
      }),
    );
    await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, {
      agentId: "codex",
      sessionId: "original",
    });
    await f.transport.prepareSession(f.chatId);
    const failure = (await actualStore.AIChatSessionStore.loadSession(f.key, f.chatId)).localAgents!.codex.recovery;
    expect(failure).toMatchObject({ previousSessionId: "original", reason: "load-failed" });
    expect(failure).not.toHaveProperty("detail");
    const { activeSession: other } = await actualStore.AIChatSessionStore.createSession(f.key);
    await f.transport.prepareSession(other.id);
    expect(f.statuses.at(-1)).not.toHaveProperty("recovery");
    await f.transport.prepareSession(f.chatId);
    expect(f.statuses.at(-1)).toMatchObject({ kind: "ready", recovery: failure });
    await actualStore.AIChatSessionStore.saveSession(f.key, f.chatId, [user("saved history")]);
    await f.transport.dispose();
    const restarted = new LocalAgentTransport({ project: f.project, references: f.references, agentId: "codex" });
    cleanups.push(() => restarted.dispose());
    const statuses: LocalAgentStatus[] = [];
    restarted.onStatus((status) => statuses.push(status));
    await restarted.prepareSession(f.chatId);
    expect(statuses.at(-1)).toMatchObject({ kind: "ready", recovery: failure });
    expect((await actualStore.AIChatSessionStore.loadSession(f.key, f.chatId)).localAgents!.codex.recovery).toEqual(
      failure,
    );
    await restarted.acknowledgeRecovery(f.chatId);
    expect(statuses.at(-1)).not.toMatchObject({ recovery: failure });
    await restarted.dispose();
    const acknowledged = new LocalAgentTransport({ project: f.project, references: f.references, agentId: "codex" });
    cleanups.push(() => acknowledged.dispose());
    acknowledged.onStatus((status) => statuses.push(status));
    await acknowledged.prepareSession(f.chatId);
    expect(statuses.at(-1)).not.toHaveProperty("recovery");
    await acknowledged.dispose();
    await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, {
      agentId: "codex",
      sessionId: "original",
    });
    const failedAgain = new LocalAgentTransport({ project: f.project, references: f.references, agentId: "codex" });
    cleanups.push(() => failedAgain.dispose());
    failedAgain.onStatus((status) => statuses.push(status));
    await failedAgain.prepareSession(f.chatId);
    expect(statuses.at(-1)).toMatchObject({ recovery: failure });
  });

  it.each(["exited", "needs-login"])("上一轮 %s 后缺少研究文件夹，先恢复 idle 并报告本轮原因", async (reason) => {
    const f = await setup((app) => {
      if (reason === "needs-login")
        app.onRequest(methods.agent.initialize, () => {
          throw RequestError.authRequired();
        });
    });
    if (reason === "exited")
      f.beforeStart(async (event) => {
        event({ kind: "stderr", line: "previous crash" });
        event({ kind: "exited", code: 1 });
      });
    expect(await collect(await f.send())).toContainEqual({ type: "error", errorText: `local-agent:${reason}` });
    const statusCount = f.statuses.length;
    vi.mocked(ResearchFolder.getRoot).mockReturnValue("");
    expect(await collect(await f.send())).toContainEqual({
      type: "error",
      errorText: "local-agent:no-research-folder",
    });
    expect(f.statuses.slice(statusCount)).toEqual([
      { kind: "idle" },
      { kind: "agent-error", agentId: "codex", reason: "no-research-folder", detail: "", stderrTail: [] },
    ]);
  });

  it.each([0, 2])("挂起 prompt 因进程退出（码 %s）断连，保留同一次失败的退出码和 stderr", async (code) => {
    const entered = vi.fn();
    const f = await setup((app) =>
      app.onRequest(methods.agent.session.prompt, async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { stopReason: "cancelled" };
      }),
    );
    const completed = collect(await f.send());
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    f.processes.get(1)!.event({ kind: "stderr", line: "current exit" });
    f.processes.get(1)!.event({ kind: "exited", code });
    expect((await completed).filter((chunk) => chunk.type === "error")).toEqual([
      { type: "error", errorText: "local-agent:exited" },
    ]);
    expect(f.statuses.at(-1)).toEqual({
      kind: "agent-error",
      agentId: "codex",
      reason: "exited",
      detail: JSON.stringify({ code }),
      stderrTail: ["current exit"],
    });
  });

  it("同一轮先收到退出事件，独立的上下文错误仍按新原因报告", async () => {
    const f = await setup();
    vi.mocked(buildResearchContext).mockImplementationOnce(async () => {
      f.processes.get(1)!.event({ kind: "exited", code: 1 });
      await vi.waitFor(() => expect(f.statuses.at(-1)).toMatchObject({ reason: "exited" }));
      throw new Error("context failed");
    });
    expect(await collect(await f.send())).toContainEqual({ type: "error", errorText: "local-agent:protocol" });
    expect(f.statuses.at(-1)).toMatchObject({ reason: "protocol", detail: "Error: context failed", stderrTail: [] });
  });

  it("新会话创建失败不覆盖原记录，store 失败也传到状态和流", async () => {
    let fail = true;
    const f = await setup((app) =>
      app.onRequest(methods.agent.session.new, () => {
        if (fail) throw RequestError.internalError();
        return { sessionId: "replacement" };
      }),
    );
    await actualStore.AIChatSessionStore.setLocalAgentSession(f.key, f.chatId, { agentId: "claude", sessionId: "old" });
    await collect(await f.send());
    expect((await actualStore.AIChatSessionStore.loadSession(f.key, f.chatId)).localAgents?.claude).toEqual({
      agentId: "claude",
      sessionId: "old",
    });
    fail = false;
    vi.mocked(AIChatSessionStore.setLocalAgentSession).mockRejectedValueOnce(new Error("disk failed"));
    expect(await collect(await f.send())).toContainEqual({ type: "error", errorText: "local-agent:protocol" });
    expect(f.statuses.at(-1)).toMatchObject({ detail: "Error: disk failed" });
  });
});

describe("prompt history limits", () => {
  it("仅最近 20 条文本，最多 6000 字符，排除工具/思考/文件", () => {
    const messages = Array.from({ length: 25 }, (_, i) => user(`text-${i}`, String(i)));
    messages[24].parts.push(
      { type: "reasoning", text: "secret-thought" },
      { type: "file", url: "secret-file", mediaType: "image/png" },
      {
        type: "dynamic-tool",
        toolCallId: "t",
        toolName: "shell",
        state: "output-available",
        input: "secret-input",
        output: "secret-output",
      },
    );
    const text = formatLocalAgentHistory(messages);
    expect(text.split("\n")).toHaveLength(20);
    expect(text.startsWith("user: text-5")).toBe(true);
    expect(text.endsWith("text-24")).toBe(true);
    expect(text).not.toContain("secret");
    expect(formatLocalAgentHistory([user("a".repeat(7000)), assistant("latest")])).toHaveLength(6000);
    expect(formatLocalAgentHistory([user("a".repeat(7000)), assistant("latest")])).toMatch(/assistant: latest$/);
    expect(
      buildLocalAgentPrompt(user("hello"), {
        firstPrompt: false,
        workspace: "board.prg",
        recentHistory: "omit",
        researchContext: "omit",
      }),
    ).toEqual([{ type: "text", text: expect.not.stringContaining("omit") }]);
  });

  it("斜杠命令单独发，前面不拼工作区说明、白板文字版和历史", () => {
    const context = { firstPrompt: true, workspace: "board.prg", recentHistory: "history", researchContext: "board" };
    expect(buildLocalAgentPrompt(user("  /compact  "), context)).toEqual([{ type: "text", text: "/compact" }]);
    expect(buildLocalAgentPrompt(user("/context"), { ...context, firstPrompt: false })).toEqual([
      { type: "text", text: "/context" },
    ]);
    expect(buildLocalAgentPrompt(user("/ 不是命令"), { ...context, firstPrompt: false })).toEqual([
      { type: "text", text: expect.stringContaining("board.prg") },
    ]);
  });
});

describe("local agent session persistence", () => {
  it("迁移旧单程序绑定时保留它，并清除旧版诊断字段", async () => {
    const store = actualStore.AIChatSessionStore;
    const key = crypto.randomUUID();
    const { activeSession } = await store.initializeProject(key);
    const legacy = {
      agentId: "claude",
      sessionId: "original",
      recovery: {
        previousSessionId: "older",
        reason: "load-failed",
        cwd: "/private/project",
        detail: "secret diagnostic",
      },
    };
    const storedKey = `project:${key}:session:${activeSession.id}`;
    stores.get("ai-chat-sessions.json")!.set(storedKey, { ...activeSession, localAgent: legacy });
    expect(actualStore.getStoredLocalAgentSession(await store.loadSession(key, activeSession.id), "claude")).toEqual({
      agentId: "claude",
      sessionId: "original",
      recovery: { previousSessionId: "older", reason: "load-failed" },
    });
    await store.setLocalAgentSession(key, activeSession.id, { agentId: "codex", sessionId: "second" });
    const saved = await store.loadSession(key, activeSession.id);
    expect(saved.localAgent).toBeUndefined();
    expect(saved.localAgents?.claude.sessionId).toBe("original");
    expect(saved.localAgents?.codex.sessionId).toBe("second");
    expect(JSON.stringify(saved)).not.toContain("secret diagnostic");
    expect(JSON.stringify(saved)).not.toContain("/private/project");
  });

  it.each([
    null,
    [],
    { codex: { agentId: "claude", sessionId: "s" } },
    { claude: { agentId: "claude", sessionId: "" } },
  ])("损坏的按程序绑定也报告错误：%j", async (localAgents) => {
    const store = actualStore.AIChatSessionStore;
    const key = crypto.randomUUID();
    const { activeSession } = await store.initializeProject(key);
    stores
      .get("ai-chat-sessions.json")!
      .set(`project:${key}:session:${activeSession.id}`, { ...activeSession, localAgents });
    await expect(store.loadSession(key, activeSession.id)).rejects.toThrow();
  });

  it.each(["set", "save"] as const)("%s 已开始时取消也不能留下迟到的会话号", async (method) => {
    const store = actualStore.AIChatSessionStore;
    const key = crypto.randomUUID();
    const { activeSession } = await store.initializeProject(key);
    const original = { agentId: "claude", sessionId: "original" };
    await store.setLocalAgentSession(key, activeSession.id, original);
    const controller = new AbortController();
    const operation = LazyStore.prototype[method];
    const spy = vi.spyOn(LazyStore.prototype, method).mockImplementationOnce(async function (
      this: LazyStore,
      ...args: unknown[]
    ) {
      await (operation as (...values: unknown[]) => Promise<void>).apply(this, args);
      controller.abort();
    });
    await expect(
      store.setLocalAgentSession(key, activeSession.id, { ...original, sessionId: "stale" }, controller.signal),
    ).rejects.toThrow();
    spy.mockRestore();
    expect((await store.loadSession(key, activeSession.id)).localAgents?.claude).toEqual(original);
  });
  it("持久化队列在落盘前检查取消，不写入旧 transport 的后备会话号", async () => {
    const store = actualStore.AIChatSessionStore;
    const key = crypto.randomUUID();
    const { activeSession } = await store.initializeProject(key);
    const original = { agentId: "claude", sessionId: "original" };
    await store.setLocalAgentSession(key, activeSession.id, original);
    const controller = new AbortController();
    const writing = store.setLocalAgentSession(
      key,
      activeSession.id,
      { ...original, sessionId: "stale" },
      controller.signal,
    );
    controller.abort();
    await expect(writing).rejects.toThrow();
    expect((await store.loadSession(key, activeSession.id)).localAgents?.claude).toEqual(original);
  });

  it("旧会话兼容，ACP 保存走队列且不改其他字段；保存消息/重命名/键迁移保留字段", async () => {
    const project = { uri: { scheme: "draft", toString: () => "draft:1" }, metadata: {} };
    const key = actualStore.getAIChatProjectKey(project);
    const store = actualStore.AIChatSessionStore;
    const { activeSession } = await store.initializeProject(key);
    expect((await store.loadSession(key, activeSession.id)).localAgent).toBeUndefined();
    const localAgent = { agentId: "codex", sessionId: "s1" };
    await store.setLocalAgentSession(key, activeSession.id, localAgent);
    expect(await store.loadSession(key, activeSession.id)).toEqual({
      ...activeSession,
      localAgents: { codex: localAgent },
    });
    const operations = [
      store.saveSession(key, activeSession.id, [user()]),
      store.setLocalAgentSession(key, activeSession.id, { ...localAgent, sessionId: "s2" }),
      store.renameSession(key, activeSession.id, "renamed"),
    ];
    await Promise.all(operations);
    expect(await store.loadSession(key, activeSession.id)).toMatchObject({
      localAgents: { codex: { agentId: "codex", sessionId: "s2" } },
      title: "renamed",
      messages: [user()],
    });
    project.metadata = { workbench: { id: crypto.randomUUID() } };
    project.uri = { scheme: "file", toString: () => "file:///saved.prg" };
    const migratedKey = actualStore.getAIChatProjectKey(project);
    expect((await store.loadSession(migratedKey, activeSession.id)).localAgents?.codex).toEqual({
      agentId: "codex",
      sessionId: "s2",
    });
    await store.setLocalAgentSession(migratedKey, activeSession.id, undefined);
    expect((await store.loadSession(migratedKey, activeSession.id)).localAgents).toBeUndefined();
  });

  it.each([
    null,
    {},
    { agentId: "codex" },
    { agentId: 7, sessionId: "s" },
    { agentId: "codex", sessionId: "" },
    { agentId: "claude", sessionId: "s", recovery: null },
    {
      agentId: "claude",
      sessionId: "s",
      recovery: { previousSessionId: "old", cwd: "/r", reason: "invalid", detail: "bad" },
    },
  ])("无效 localAgent %j 读写均报错，失败队列可继续写入", async (invalid) => {
    const store = actualStore.AIChatSessionStore;
    const key = crypto.randomUUID();
    const { activeSession } = await store.initializeProject(key);
    await expect(store.setLocalAgentSession(key, activeSession.id, invalid as never)).rejects.toThrow();
    const storeKey = `project:${key}:session:${activeSession.id}`;
    stores.get("ai-chat-sessions.json")!.set(storeKey, { ...activeSession, localAgent: invalid });
    await expect(store.loadSession(key, activeSession.id)).rejects.toThrow();
    stores.get("ai-chat-sessions.json")!.set(storeKey, activeSession);
    await store.setLocalAgentSession(key, activeSession.id, { agentId: "codex", sessionId: "valid" });
    expect((await store.loadSession(key, activeSession.id)).localAgents?.codex.sessionId).toBe("valid");
    await expect(store.setLocalAgentSession(key, "missing", { agentId: "codex", sessionId: "s" })).rejects.toThrow();
  });
});

describe("AIEngine backend selection and settings", () => {
  it("API 研究助手系统提示逐字保持原样（包括标点和换行）", () => {
    expect(RESEARCH_SYSTEM_PROMPT).toBe(
      [
        "你是「科研工作台」里的研究助手。用户把论文、图片和笔记做成卡片放在白板上，用连线和分组表达自己的思路。",
        "下面的 <whiteboard> 是当前白板的文字版（卡片、连线、分组、标签，以及文件卡片里抽出的文字摘要），<research-files> 是研究文件夹里的文件清单。用户消息开头的 [selected: n1 ...] 是用户当前选中的对象。",
        "回答时：",
        "1. 根据白板上的卡片、连线、分组和文件摘要，概括用户的思路；",
        "2. 指出缺的证据、没连上的论文、逻辑跳跃，以及下一步可以做什么；",
        "3. 提到具体内容时引用卡片标题和文件路径；",
        "4. 不编造没出现在材料里的内容，材料不够就直接说还缺什么；",
        "5. 用户问别的问题也照常回答。",
        "需要更细的信息时可以调用只读工具查看白板对象；提到 n1、e1 这样的对象引用时用反引号包裹，方便用户点击定位。你不能修改白板。",
      ].join("\n"),
    );
  });

  it("缺省值、来源/程序/路径 schema 校验与持久化；三档权限和模式记忆都已删除", async () => {
    const actual = await vi.importActual<typeof import("@/core/service/Settings")>("@/core/service/Settings");
    for (const removed of ["aiLocalAgentPermission", "aiLocalAgentModes", "aiLocalAgentModels"])
      expect(removed in actual.settingsSchema.shape).toBe(false);
    const schema = actual.settingsSchema.pick({
      aiBackend: true,
      aiLocalAgent: true,
      aiLocalAgentPaths: true,
    });
    expect(schema.parse({})).toEqual({
      aiBackend: "api",
      aiLocalAgent: "codex",
      aiLocalAgentPaths: {},
    });
    const valid = {
      aiBackend: ["api", "localAgent"],
      aiLocalAgent: ["codex", "claude", "gemini", "kimi", "cursor", "opencode", "qodercn"],
      aiLocalAgentPaths: [{ codex: "/bin/codex-acp" }],
    };
    for (const [key, values] of Object.entries(valid))
      for (const value of values) {
        expect(schema.safeParse({ [key]: value }).success).toBe(true);
        Reflect.set(actual.Settings, key, value);
        expect(stores.get("settings.json")!.get(key)).toEqual(value);
      }
    for (const [key, value] of Object.entries({
      aiBackend: "other",
      aiLocalAgent: "shell",
      aiLocalAgentPaths: { codex: 1 },
    }))
      expect(schema.safeParse({ [key]: value }).success).toBe(false);
  });

  it("API 分支保留 DefaultChatTransport、自定义 fetch 和上下文窗口 body；localAgent 暴露同一实例", async () => {
    const f = await setup();
    const engine = new AIEngine();
    const fetch = vi.fn(
      async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    const createFetch = vi.spyOn(engine, "createChatFetch").mockReturnValue(fetch);
    for (const limit of [undefined, 2000]) {
      const conversation = engine.createConversation(f.project, f.references, () => limit);
      expect(conversation.transport).toBeInstanceOf(DefaultChatTransport);
      expect(conversation.localAgent).toBeUndefined();
      await collect(
        await conversation.transport.sendMessages({
          trigger: "submit-message",
          chatId: f.chatId,
          messageId: undefined,
          messages: [user()],
          abortSignal: undefined,
        }),
      );
      expect(
        JSON.parse((fetch.mock.calls.at(-1) as unknown as [unknown, { body: string }])[1].body).contextWindowTokenLimit,
      ).toBe(limit);
    }
    expect(createFetch).toHaveBeenCalledWith(f.project, f.references);
    Settings.aiBackend = "localAgent";
    Settings.aiLocalAgent = "claude";
    Settings.aiLocalAgentPaths = { claude: "/custom/claude-agent-acp" };
    f.catalog[0] = { ...info, id: "claude" };
    const conversation = engine.createConversation(f.project, f.references);
    expect(conversation.localAgent).toBe(conversation.transport);
    expect(conversation.references).toBe(f.references);
    cleanups.push(() => conversation.localAgent!.dispose());
    await collect(
      await conversation.transport.sendMessages({
        trigger: "submit-message",
        chatId: f.chatId,
        messageId: undefined,
        messages: [user()],
        abortSignal: undefined,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "local_agent_start",
      expect.objectContaining({ agentId: "claude", pathOverride: "/custom/claude-agent-acp" }),
    );
  });
});
