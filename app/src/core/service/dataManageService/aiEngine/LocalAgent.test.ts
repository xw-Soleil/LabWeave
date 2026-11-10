import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentConnection,
  type AnyMessage,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type SetSessionConfigOptionRequest,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import {
  agent as unstableAgent,
  methods as unstableMethods,
  type AgentApp as UnstableAgentApp,
} from "@agentclientprotocol/sdk/unstable";
import { invoke } from "@tauri-apps/api/core";
import {
  buildLocalAgentMcpServers,
  createLocalAgentStream,
  createSessionUpdateState,
  finishSessionUpdate,
  getLocalAgentCatalog,
  isWhiteboardToolCall,
  LocalAgentConnection,
  mapSessionUpdate,
  openLocalAgentTerminal,
  parseLocalAgentContext,
  startLocalAgent,
  stopLocalAgent,
  type LocalAgentEvent,
  type LocalAgentInfo,
  type LocalAgentId,
  type LocalAgentPermissionRequest,
  type LocalAgentSessionControls,
  type LocalAgentStatus,
} from "./LocalAgent";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage?: (event: LocalAgentEvent) => void;
  },
}));

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
const session = { cwd: "/research", mcpServers: [] };
const textUpdate = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function eventStream(events: LocalAgentEvent[]) {
  return new ReadableStream<LocalAgentEvent>({
    start(controller) {
      events.forEach((event) => controller.enqueue(event));
      controller.close();
    },
  });
}

function fixture(configure?: (app: AgentApp) => void, createApp: () => AgentApp = agent) {
  const initialize = vi.fn(() => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    authMethods: [{ id: "login", name: "Login" }],
  }));
  const newSession = vi.fn(() => ({ sessionId: "s1" }));
  const load = vi.fn(() => ({}));
  const prompt = vi.fn(() => ({ stopReason: "end_turn" as const }));
  const cancel = vi.fn();
  const app = createApp();
  configure?.(app);
  app
    .onRequest(methods.agent.initialize, initialize)
    .onRequest(methods.agent.session.new, newSession)
    .onRequest(methods.agent.session.load, load)
    .onRequest(methods.agent.session.prompt, prompt)
    .onNotification(methods.agent.session.cancel, cancel);
  const sent: AnyMessage[] = [];
  const outgoing = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      sent.push(message);
      controller.enqueue(message);
    },
  });
  const incoming = new TransformStream<AnyMessage, AnyMessage>();
  const peer = app.connect({ readable: outgoing.readable, writable: incoming.writable });
  cleanups.push(() => peer.close());
  const stream: Stream = { readable: incoming.readable, writable: outgoing.writable };
  const statuses: LocalAgentStatus[] = [];
  const permissions: (LocalAgentPermissionRequest | null)[] = [];
  const updates: SessionUpdate[] = [];
  const controls: LocalAgentSessionControls[] = [];
  const start = async (agentId: LocalAgentId = "codex") => {
    const connection = await LocalAgentConnection.start(stream, {
      agent: { ...info, id: agentId },
      onStatus: (s) => statuses.push(s),
      onControls: (c) => controls.push(c),
      onPermissionRequest: (r) => permissions.push(r),
      onSessionUpdate: (u) => updates.push(u),
    });
    cleanups.push(() => connection.dispose());
    return connection;
  };
  const disconnect = async () => {
    peer.close();
    await incoming.writable.getWriter().close();
  };
  return {
    peer,
    disconnect,
    sent,
    start,
    initialize,
    newSession,
    load,
    prompt,
    cancel,
    statuses,
    permissions,
    updates,
    controls,
  };
}

const codexModes = [
  { id: "read-only", name: "Read-only", description: "Requires approval to edit files and access the internet." },
  {
    id: "workspace-write",
    name: "Workspace access",
    description: "Edit workspace files; ask before writing outside the workspace or accessing the network.",
  },
  { id: "agent", name: "Auto review", description: "Only ask for actions detected as potentially unsafe" },
  {
    id: "agent-full-access",
    name: "Full access",
    description: "Unrestricted access to the internet and any file on your computer",
  },
];
const claudeModes = [
  { id: "default", name: "Manual", description: "Always ask before making changes" },
  { id: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
  { id: "plan", name: "Plan", description: "Create a plan before making changes" },
  { id: "auto", name: "Auto", description: "Claude handles permission decisions" },
  { id: "bypassPermissions", name: "Bypass permissions", description: "Accepts all permissions" },
];
const codexSession = {
  sessionId: "s1",
  modes: { availableModes: codexModes, currentModeId: "agent" },
  models: {
    currentModelId: "gpt-6-astra[xhigh]",
    availableModels: [
      {
        modelId: "gpt-6-astra[xhigh]",
        name: "6 Astra (xhigh)",
        description:
          "Frontier intelligence for the most demanding work. Extra high reasoning depth for complex problems",
      },
      {
        modelId: "gpt-6.1-sol[low]",
        name: "6.1 Sol (low)",
        description: "Latest workhorse model for coding and everyday work. Fast responses with lighter reasoning",
      },
    ],
  },
  configOptions: [
    {
      id: "mode",
      name: "Mode",
      description: "Approval and sandboxing preset for the session",
      category: "mode",
      type: "select",
      currentValue: "agent",
      options: codexModes.map(({ id, ...choice }) => ({ value: id, ...choice })),
    },
    {
      id: "model",
      name: "Model",
      description: "Model Codex uses for the session",
      category: "model",
      type: "select",
      currentValue: "gpt-6-astra",
      options: [
        { value: "gpt-6.1-sol", name: "6.1 Sol", description: "Latest workhorse model for coding and everyday work." },
        { value: "gpt-6-astra", name: "6 Astra", description: "Frontier intelligence for the most demanding work." },
        { value: "gpt-6.1-terra", name: "6.1 Terra", description: "GPT-6.1 Terra Codex model." },
        { value: "gpt-6-sol", name: "6 Sol", description: "Previous generation workhorse model." },
        { value: "gpt-6-luna", name: "6 Luna", description: "Fast and affordable model for easier tasks." },
        { value: "gpt-5.6-sol", name: "5.6 Sol", description: "Older generation workhorse model." },
        { value: "gpt-5.6-terra", name: "5.6 Terra", description: "Older balanced model for straightforward work." },
        { value: "gpt-5.6-luna", name: "5.6 Luna", description: "Older fast and efficient model." },
      ],
    },
  ],
} satisfies NewSessionResponse & { models: unknown };
const claudeSession: NewSessionResponse = {
  sessionId: "s1",
  modes: { availableModes: claudeModes, currentModeId: "default" },
  configOptions: [
    {
      id: "mode",
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: claudeModes.map(({ id, ...choice }) => ({ value: id, ...choice })),
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default (recommended)", description: "Opus" },
        {
          value: "opus",
          name: "Opus 5.5",
          description: "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok",
        },
        {
          value: "fable",
          name: "Fable 5.1",
          description: "Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok",
        },
        {
          value: "sonnet",
          name: "Sonnet 5.5",
          description: "Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok",
        },
        {
          value: "haiku",
          name: "Haiku 5.5",
          description:
            "Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)",
        },
      ],
    },
  ],
};

function controlFixture(initial: NewSessionResponse) {
  let response = structuredClone(initial);
  const newSession = vi.fn(() => structuredClone(response));
  const setConfig = vi.fn(({ params }: { params: SetSessionConfigOptionRequest }) => {
    if (typeof params.value !== "string") throw RequestError.invalidParams();
    const value = params.value;
    response = {
      ...response,
      configOptions: response.configOptions?.map((option) =>
        option.id === params.configId && option.type === "select" ? { ...option, currentValue: value } : option,
      ),
    };
    return { configOptions: response.configOptions ?? [] };
  });
  const setMode = vi.fn(() => ({}));
  const f = fixture((app) =>
    app
      .onRequest(methods.agent.session.new, newSession)
      .onRequest(methods.agent.session.setConfigOption, setConfig)
      .onRequest(methods.agent.session.setMode, setMode),
  );
  return { ...f, newSession, setConfig, setMode };
}

const noControls = { modes: [], currentMode: null, models: [], currentModel: null, commands: [] };

describe("LocalAgent session controls", () => {
  it("收下程序报的斜杠命令（真实 Claude 数据的格式），换会话不串", async () => {
    const f = controlFixture(claudeSession);
    const connection = await f.start("claude");
    await connection.openSession(session);
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: "s1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          {
            name: "compact",
            description: "Free up context by summarizing the conversation so far",
            input: { hint: "<optional custom summarization instructions>" },
          },
          { name: "context", description: "Show current context usage", input: null },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(f.controls.at(-1)?.commands).toEqual([
        {
          name: "compact",
          description: "Free up context by summarizing the conversation so far",
          hint: "<optional custom summarization instructions>",
        },
        { name: "context", description: "Show current context usage", hint: undefined },
      ]),
    );
    expect(f.controls.at(-1)?.currentMode).toBe("default");
    expect(f.updates).toEqual([]);
    await connection.openSession({ ...session, previousSessionId: "other" });
    expect(f.controls.at(-1)?.commands).toEqual([]);
  });

  it.each([
    {
      id: "codex" as const,
      response: codexSession,
      modes: codexModes,
      current: "agent",
      model: "gpt-6-astra",
      modelCount: 8,
    },
    {
      id: "claude" as const,
      response: claudeSession,
      modes: claudeModes,
      current: "default",
      model: "default",
      modelCount: 5,
    },
  ])(
    "读取实测 $id 的模式和模型，优先 configOptions，列表和默认值照程序原样",
    async ({ id, response, modes, current, model, modelCount }) => {
      const f = controlFixture(response);
      const connection = await f.start(id);
      await connection.openSession(session);
      expect(f.controls.at(-1)).toMatchObject({ modes, currentMode: current, currentModel: model });
      expect(f.controls.at(-1)?.models).toHaveLength(modelCount);
      expect(f.controls.at(-1)?.models[0]).toEqual(
        id === "codex"
          ? { id: "gpt-6.1-sol", name: "6.1 Sol", description: "Latest workhorse model for coding and everyday work." }
          : { id: "default", name: "Default (recommended)", description: "Opus" },
      );
      expect(f.setConfig).not.toHaveBeenCalled();
      expect(f.setMode).not.toHaveBeenCalled();
    },
  );

  it.each(["agent-full-access", "workspace-write"])("开会话不替用户切换：程序默认是 %s 就照实沿用", async (current) => {
    const f = controlFixture({ sessionId: "s1", modes: { currentModeId: current, availableModes: codexModes } });
    const connection = await f.start();
    await connection.openSession(session);
    expect(f.controls.at(-1)?.currentMode).toBe(current);
    expect(f.controls.at(-1)?.modes).toEqual(codexModes);
    expect(f.setMode).not.toHaveBeenCalled();
    expect(f.setConfig).not.toHaveBeenCalled();
  });

  it("切换使用 config option 的实际 id，响应更新模式与模型", async () => {
    const response = structuredClone(codexSession);
    response.configOptions![0].id = "permission-preset";
    response.configOptions![1].id = "model-picker";
    const f = controlFixture(response);
    const connection = await f.start();
    await connection.openSession(session);
    await connection.setMode("workspace-write");
    await connection.setModel("gpt-6.1-sol");
    expect(f.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session/set_config_option",
          params: { sessionId: "s1", configId: "permission-preset", value: "workspace-write" },
        }),
        expect.objectContaining({
          method: "session/set_config_option",
          params: { sessionId: "s1", configId: "model-picker", value: "gpt-6.1-sol" },
        }),
      ]),
    );
    expect(f.controls.at(-1)).toMatchObject({ currentMode: "workspace-write", currentModel: "gpt-6.1-sol" });
    expect(f.setMode).not.toHaveBeenCalled();
    await expect(connection.setMode("missing")).rejects.toMatchObject({ reason: "protocol" });
    await expect(connection.setModel("missing")).rejects.toMatchObject({ reason: "protocol" });
    f.setConfig.mockRejectedValueOnce(RequestError.internalError());
    await expect(connection.setMode("agent")).rejects.toMatchObject({ reason: "protocol" });
    expect(f.controls.at(-1)?.currentMode).toBe("workspace-write");
    // 切换失败只交给调用方提示，不把整个会话标成出错
    expect(f.statuses.some((status) => status.kind === "agent-error")).toBe(false);
  });

  it("旧 models 可以读，但没有 config option 不能切换模型", async () => {
    const f = controlFixture({ ...codexSession, configOptions: undefined });
    const connection = await f.start();
    await connection.openSession(session);
    expect(f.controls.at(-1)?.currentModel).toBe("gpt-6-astra[xhigh]");
    expect(f.controls.at(-1)?.models[0]).toMatchObject({ id: "gpt-6-astra[xhigh]", name: "6 Astra (xhigh)" });
    await expect(connection.setModel("gpt-6.1-sol[low]")).rejects.toMatchObject({ reason: "protocol" });
    expect(f.setConfig).not.toHaveBeenCalled();
  });

  it("控制项通知刷新完整列表、展平分组；程序自己切了模式照实报告，不回切", async () => {
    const f = controlFixture(codexSession);
    const connection = await f.start();
    await connection.openSession(session);
    const calls = f.setConfig.mock.calls.length;
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: "s1",
      update: { sessionUpdate: "current_mode_update", currentModeId: "agent-full-access" },
    });
    await vi.waitFor(() => expect(f.controls.at(-1)?.currentMode).toBe("agent-full-access"));
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "next-mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "agent-full-access",
            options: [
              { group: "all", name: "All", options: codexModes.map(({ id, ...mode }) => ({ value: id, ...mode })) },
            ],
          },
          {
            id: "next-model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "new-model",
            options: [{ value: "new-model", name: "New model" }],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(f.controls.at(-1)?.currentModel).toBe("new-model"));
    expect(f.controls.at(-1)?.modes).toEqual(codexModes);
    expect(f.controls.at(-1)?.currentMode).toBe("agent-full-access");
    expect(f.setConfig).toHaveBeenCalledTimes(calls);
    expect(f.updates).toEqual([]);
    await connection.setModel("new-model");
    expect(f.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { sessionId: "s1", configId: "next-model", value: "new-model" } }),
    );
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: "s1",
      update: { sessionUpdate: "config_option_update", configOptions: [] },
    });
    await vi.waitFor(() => expect(f.controls.at(-1)).toEqual(noControls));
  });

  it("load 没带控制项时保留该会话的列表和 config id；其他会话不继承它", async () => {
    const f = controlFixture(codexSession);
    const connection = await f.start();
    await connection.openSession(session);
    const previous = f.controls.at(-1);
    await connection.openSession({ ...session, previousSessionId: "s1" });
    expect(f.controls.at(-1)).toEqual(previous);
    await connection.setMode("workspace-write");
    expect(f.setConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { sessionId: "s1", configId: "mode", value: "workspace-write" } }),
    );
    await connection.openSession({ ...session, previousSessionId: "unknown" });
    expect(f.controls.at(-1)).toEqual(noControls);
    connection.activateSession("s1");
    expect(f.controls.at(-1)?.currentMode).toBe("workspace-write");
  });

  it("load 接收控制项与控制通知，继续忽略历史消息重放", async () => {
    const f = fixture((app) =>
      app.onRequest(methods.agent.session.load, async ({ client, params }) => {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: claudeSession.configOptions! },
        });
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: textUpdate("old") });
        return {};
      }),
    );
    const connection = await f.start("claude");
    await connection.openSession({ ...session, previousSessionId: "loaded" });
    expect(f.controls.at(-1)?.modes).toEqual(claudeModes);
    expect(f.controls.at(-1)?.currentModel).toBe("default");
    expect(f.updates).toEqual([]);
  });

  it("未提供控制项时返回空状态", async () => {
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    expect(f.controls.at(-1)).toEqual(noControls);
  });

  it.each(["config", "legacy"])("从 load 返回的 %s 读取控制项", async (format) => {
    const f = fixture((app) =>
      app.onRequest(methods.agent.session.load, () =>
        format === "config"
          ? { configOptions: claudeSession.configOptions }
          : { modes: claudeSession.modes, models: codexSession.models },
      ),
    );
    const connection = await f.start("claude");
    await connection.openSession({ ...session, previousSessionId: "old" });
    expect(f.controls.at(-1)?.modes).toEqual(claudeModes);
    expect(f.controls.at(-1)?.currentMode).toBe("default");
    expect(f.controls.at(-1)?.currentModel).toBe(format === "config" ? "default" : "gpt-6-astra[xhigh]");
  });

  it("Claude 自己配置成「自动」时照实沿用，不改回手动", async () => {
    const f = controlFixture({ sessionId: "s1", modes: { currentModeId: "auto", availableModes: claudeModes } });
    const connection = await f.start("claude");
    await connection.openSession(session);
    expect(f.controls.at(-1)?.currentMode).toBe("auto");
    expect(f.setMode).not.toHaveBeenCalled();
  });

  it("有 configOptions 但没有对应 category 时不退回旧字段", async () => {
    const f = controlFixture({ ...codexSession, configOptions: [] });
    const connection = await f.start();
    await connection.openSession(session);
    expect(f.controls.at(-1)).toEqual(noControls);
    expect(f.setMode).not.toHaveBeenCalled();
    expect(f.setConfig).not.toHaveBeenCalled();
  });

  it("旧 models 格式不对时当作没有，会话照常打开", async () => {
    const f = fixture((app) =>
      app.onRequest(methods.agent.session.new, () => ({
        sessionId: "s1",
        models: { currentModelId: 123, availableModels: [] },
      })),
    );
    const connection = await f.start();
    await expect(connection.openSession(session)).resolves.toEqual({ sessionId: "s1", loaded: false });
    expect(f.controls.at(-1)).toEqual(noControls);
    expect(f.statuses.some((status) => status.kind === "agent-error")).toBe(false);
  });

  it("load 成功但返回空结果时仍算恢复成功，不新建会话", async () => {
    const f = fixture((app) => app.onRequest(methods.agent.session.load, () => null as never));
    const connection = await f.start();
    await expect(connection.openSession({ ...session, previousSessionId: "old" })).resolves.toEqual({
      sessionId: "old",
      loaded: true,
    });
    expect(f.newSession).not.toHaveBeenCalled();
  });
});

describe("LocalAgent IPC stream", () => {
  it("使用 Rust 命令和 camelCase 参数，并在 start 返回前缓冲 Channel 输出", async () => {
    const line = '{"jsonrpc":"2.0","method":"early"}';
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "local_agent_start") {
        (args as { onEvent: { onmessage: (event: LocalAgentEvent) => void } }).onEvent.onmessage({
          kind: "stdout",
          line,
        });
        return 42;
      }
      return [];
    });
    await getLocalAgentCatalog();
    const process = await startLocalAgent("codex", "/custom/codex-acp");
    const reader = process.events.getReader();
    expect(await reader.read()).toEqual({ done: false, value: { kind: "stdout", line } });
    await reader.cancel();
    await openLocalAgentTerminal("codex", "login");
    await stopLocalAgent(process.handle);
    expect(invoke).toHaveBeenCalledWith("local_agent_catalog");
    expect(invoke).toHaveBeenCalledWith("local_agent_start", {
      agentId: "codex",
      pathOverride: "/custom/codex-acp",
      onEvent: expect.anything(),
    });
    expect(invoke).toHaveBeenCalledWith("local_agent_open_terminal", { agentId: "codex", action: "login" });
    expect(invoke).toHaveBeenCalledWith("local_agent_stop", { handle: 42 });
  });

  it("stdout 按顺序解析，写入单行 JSON，写入失败向上传播", async () => {
    const messages: AnyMessage[] = [1, 2].map((id) => ({ jsonrpc: "2.0", id, result: {} }));
    const stream = createLocalAgentStream(
      7,
      eventStream(messages.map((message) => ({ kind: "stdout", line: JSON.stringify(message) }))),
    );
    const reader = stream.readable.getReader();
    expect((await reader.read()).value).toEqual(messages[0]);
    expect((await reader.read()).value).toEqual(messages[1]);
    expect((await reader.read()).done).toBe(true);
    const writer = stream.writable.getWriter();
    await writer.write(messages[0]);
    expect(invoke).toHaveBeenCalledWith("local_agent_write", { handle: 7, line: JSON.stringify(messages[0]) });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("write failed"));
    await expect(writer.write(messages[1])).rejects.toThrow("write failed");
  });

  it.each(["{", "null", "[]", '"text"', "123"])("无效 JSON 或非对象 stdout：%s", async (line) => {
    const reader = createLocalAgentStream(1, eventStream([{ kind: "stdout", line }])).readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({ reason: "protocol" });
  });

  it.each([0, 1, null])("退出码 %s 保留最后 200 行 stderr；正常退出关闭挂起读取", async (code) => {
    let events!: ReadableStreamDefaultController<LocalAgentEvent>;
    const onExit = vi.fn();
    const stream = createLocalAgentStream(
      1,
      new ReadableStream({
        start(controller) {
          events = controller;
        },
      }),
      onExit,
    );
    const reader = stream.readable.getReader();
    const pending = reader.read();
    const expected =
      code === 0
        ? expect(pending).resolves.toEqual({ done: true, value: undefined })
        : expect(pending).rejects.toMatchObject({
            reason: "exited",
            detail: JSON.stringify({ code }),
            stderrTail: expect.any(Array),
          });
    for (let i = 0; i < 205; i++) events.enqueue({ kind: "stderr", line: `err${i}` });
    events.enqueue({ kind: "exited", code });
    events.close();
    await expected;
    expect(onExit.mock.calls[0][0].stderrTail).toEqual(Array.from({ length: 200 }, (_, i) => `err${i + 5}`));
  });
});

describe("LocalAgentConnection with SDK agent() and paired TransformStreams", () => {
  it("稳定 v1 初始化不声明 fs/terminal，authMethods 本身不代表未登录，多次 prompt 复用连接", async () => {
    const f = fixture();
    const connection = await f.start();
    const mcpServers = buildLocalAgentMcpServers({ node: null, script: "/cli.js", appHome: "/home" });
    expect(await connection.openSession({ ...session, mcpServers })).toEqual({ sessionId: "s1", loaded: false });
    expect(f.sent[0]).toMatchObject({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    expect((f.sent[0] as { params: { clientCapabilities: unknown } }).params.clientCapabilities).toEqual({});
    expect(f.newSession).toHaveBeenCalledWith(expect.objectContaining({ params: { cwd: "/research", mcpServers } }));
    const blocks = [{ type: "text" as const, text: "hello" }];
    await expect(connection.prompt(blocks)).resolves.toEqual({ stopReason: "end_turn" });
    await connection.prompt(blocks);
    expect(f.prompt).toHaveBeenCalledTimes(2);
    expect(f.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ params: { sessionId: "s1", prompt: blocks } }));
    expect(f.statuses).toEqual([]);
    await connection.dispose();
    await connection.dispose();
  });

  it.each(["supported", "unsupported", "failed"])("恢复会话 %s，load 重放丢弃，后续新消息恢复转发", async (mode) => {
    const load = vi.fn(async ({ client }: { client: AgentConnection["client"] }) => {
      await client.notify(methods.client.session.update, { sessionId: "old", update: textUpdate("replayed") });
      if (mode === "failed") throw RequestError.sessionNotFound("old");
      return {};
    });
    const f = fixture((app) =>
      app
        .onRequest(methods.agent.initialize, () => ({
          protocolVersion: 1,
          agentCapabilities: { loadSession: mode !== "unsupported" },
        }))
        .onRequest(methods.agent.session.load, load),
    );
    const connection = await f.start();
    const opened = await connection.openSession({ ...session, previousSessionId: "old" });
    expect(opened).toMatchObject({
      sessionId: mode === "supported" ? "old" : "s1",
      loaded: mode === "supported",
    });
    if (mode === "supported") expect(opened.recovery).toBeUndefined();
    else {
      expect(opened.recovery).toMatchObject({
        previousSessionId: "old",
        reason: mode === "unsupported" ? "unsupported" : "not-found",
      });
      expect(opened.recovery).not.toHaveProperty("detail");
    }
    expect(load).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
    expect(f.newSession).toHaveBeenCalledTimes(mode === "supported" ? 0 : 1);
    expect(f.updates).toEqual([]);
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: mode === "supported" ? "old" : "s1",
      update: textUpdate("new"),
    });
    await vi.waitFor(() => expect(f.updates).toEqual([textUpdate("new")]));
  });

  it("载入认证失败不创建后备，保留需要登录的状态", async () => {
    const f = fixture((app) =>
      app.onRequest(methods.agent.session.load, () => {
        throw RequestError.authRequired();
      }),
    );
    const connection = await f.start("claude");
    await expect(connection.openSession({ ...session, previousSessionId: "original" })).rejects.toThrow("needs-login");
    expect(f.newSession).not.toHaveBeenCalled();
    expect(f.statuses.at(-1)?.kind).toBe("needs-login");
  });

  it.each(["initialize", "new", "prompt"])("%s 的 auth_required 提供固定登录命令", async (method) => {
    const f = fixture((app) =>
      app.onRequest(
        method === "initialize"
          ? methods.agent.initialize
          : method === "new"
            ? methods.agent.session.new
            : methods.agent.session.prompt,
        () => {
          throw RequestError.authRequired();
        },
      ),
    );
    const operation = async () => {
      const c = await f.start();
      await c.openSession(session);
      await c.prompt([]);
    };
    await expect(operation()).rejects.toMatchObject({ reason: "needs-login" });
    expect(f.statuses).toContainEqual({ kind: "needs-login", agentId: "codex", loginCommand: "codex login" });
  });

  it("预先中止不发送 prompt；中止发送 session/cancel 后仍等待并处理 ACP 响应", async () => {
    let finish!: () => void;
    const entered = vi.fn();
    const cancelled = vi.fn();
    const f = fixture((app) =>
      app
        .onRequest(methods.agent.session.prompt, async () => {
          entered();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { stopReason: "cancelled" };
        })
        .onNotification(methods.agent.session.cancel, cancelled),
    );
    const connection = await f.start();
    await connection.openSession(session);
    await expect(connection.prompt([], AbortSignal.abort())).resolves.toEqual({ stopReason: "cancelled" });
    expect(entered).not.toHaveBeenCalled();
    const abort = new AbortController();
    const done = vi.fn();
    const result = connection.prompt([], abort.signal).then((response) => {
      done();
      return response;
    });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    abort.abort();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect(done).not.toHaveBeenCalled();
    finish();
    await expect(result).resolves.toEqual({ stopReason: "cancelled" });
  });

  it.each(["exit", "dispose"])("%s 释放连接并结束挂起 prompt", async (mode) => {
    const entered = vi.fn();
    const f = fixture((app) =>
      app.onRequest(methods.agent.session.prompt, async ({ signal }) => {
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { stopReason: "cancelled" };
      }),
    );
    const connection = await f.start();
    await connection.openSession(session);
    const result = expect(connection.prompt([])).rejects.toThrow();
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    if (mode === "exit") await f.disconnect();
    else await connection.dispose();
    await result;
    expect(f.statuses).toEqual(
      mode === "exit" ? [expect.objectContaining({ kind: "agent-error", reason: "exited" })] : [],
    );
  });

  it("连接仍在时后一次错误覆盖前一次，断连后的派生错误才保留退出原因", async () => {
    let needsLogin = true;
    const f = fixture((app) =>
      app.onRequest(methods.agent.session.prompt, () => {
        if (needsLogin) throw RequestError.authRequired();
        throw RequestError.internalError();
      }),
    );
    const connection = await f.start();
    await connection.openSession(session);
    await expect(connection.prompt([])).rejects.toMatchObject({ reason: "needs-login" });
    needsLogin = false;
    await expect(connection.prompt([])).rejects.toMatchObject({
      reason: "protocol",
      detail: "RequestError: Internal error",
    });
    await f.disconnect();
    await vi.waitFor(() => expect(f.statuses.at(-1)).toMatchObject({ reason: "exited" }));
    const exitStatus = f.statuses.at(-1);
    await expect(connection.prompt([])).rejects.toMatchObject({ reason: "exited" });
    expect(f.statuses.at(-1)).toBe(exitStatus);
  });
});

const permissionOptions: RequestPermissionRequest["options"] = [
  { optionId: "always", name: "Always", kind: "allow_always" },
  { optionId: "once", name: "Once", kind: "allow_once" },
  { optionId: "second", name: "Second", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "never", name: "Never", kind: "reject_always" },
];
const request = (overrides: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest => ({
  sessionId: "s1",
  toolCall: { toolCallId: "t1", title: "shell", kind: "execute", rawInput: { command: "echo" } },
  options: permissionOptions,
  ...overrides,
});
const outcome = (optionId?: string) => ({
  outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
});
const nonWhiteboardTools = [
  { title: "rm -rf ~/x/research-workbench" },
  { title: "research-workbench" },
  { title: "mcp__research-workbench-evil__x" },
  { title: "xmcp__research-workbench__y" },
  { title: "mcp__research-workbench__" },
  { title: "mcp__research-workbench__x\n" },
  { title: "shell", rawInput: { command: "rm -rf ~/x/research-workbench" } },
  { rawInput: { server: "research-workbench", tool: "mcp__research-workbench__x" } },
  { _meta: { source: "research-workbench" } },
  { _meta: { tool: "xmcp__research-workbench__y" } },
  { _meta: { tool: "mcp__research-workbench-evil__x" } },
  { _meta: { server: "research-workbench-evil" } },
  { _meta: { serverName: " research-workbench" } },
  { _meta: { mcpServer: "research-workbench\n" } },
  { _meta: { server: ["research-workbench"] } },
  { _meta: { "mcp__research-workbench__x": true } },
  { title: "shell", rawInput: { command: "ls" } },
  // 只有标题或旧规则认的 _meta 结构，不再算数
  { title: "mcp__research-workbench__add_nodes" },
  { title: "mcp.research-workbench.list_workspaces" },
  { _meta: { tool: "mcp__research-workbench__read_1" } },
  { _meta: { server: "research-workbench" } },
  { _meta: { serverName: "research-workbench" } },
  { _meta: { mcpServer: "research-workbench" } },
  { _meta: { nested: [{ tool: "mcp__research-workbench__x" }] } },
  { _meta: { nested: { claudeCode: { toolName: "mcp__research-workbench__x" } } } },
  // 真实 Codex：同名终端命令的标题和白板工具一字不差
  {
    title: "mcp.research-workbench.list_workspaces",
    kind: "execute",
    rawInput: { command: "mcp.research-workbench.list_workspaces", cwd: "/research" },
    _meta: { terminal_info: { cwd: "/research", terminal_id: "exec-1" } },
  },
  { title: "mcp.research-workbench.x", _meta: { is_mcp_tool_call: "true" } },
  { title: "mcp.research-workbench-evil.x", _meta: { is_mcp_tool_call: true } },
  { title: "mcp.research-workbench.x\n", _meta: { is_mcp_tool_call: true } },
  // Claude：普通工具的 toolName 是它自己的名字，标题再像也不算
  { title: "mcp__research-workbench__x", _meta: { claudeCode: { toolName: "Bash" } } },
  { title: "mcp.research-workbench.x", _meta: { claudeCode: { toolName: "Bash" }, is_mcp_tool_call: true } },
  { _meta: { claudeCode: { toolName: "mcp__research-workbench-evil__x" } } },
  { _meta: { claudeCode: { toolName: "mcp__research-workbench__x\n" } } },
  { _meta: { claudeCode: null } },
] satisfies Partial<RequestPermissionRequest["toolCall"]>[];

describe("LocalAgent permissions", () => {
  it.each([
    {
      title: "mcp__research-workbench__list_workspaces",
      kind: "other",
      _meta: {
        claudeCode: {
          toolName: "mcp__research-workbench__list_workspaces",
          mcpServer: { name: "research-workbench", source: "dynamic" },
        },
      },
    },
    { _meta: { claudeCode: { toolName: "mcp__research-workbench__add_nodes" } } },
    {
      title: "mcp.research-workbench.create_text_node_at",
      kind: "execute",
      rawInput: { server: "research-workbench", tool: "create_text_node_at", arguments: {} },
      _meta: { is_mcp_tool_call: true },
    },
  ] satisfies Partial<RequestPermissionRequest["toolCall"]>[])(
    "按转接器自己填的字段识别白板工具（真实 Claude、Codex 数据）%j",
    (tool) => {
      expect(isWhiteboardToolCall(tool)).toBe(true);
    },
  );

  it("Codex 的权限请求不带 _meta，按 toolCallId 找回开头的 tool_call 认白板工具", async () => {
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    const codexCall = (toolCallId: string, extra: Partial<RequestPermissionRequest["toolCall"]>) => ({
      sessionUpdate: "tool_call" as const,
      toolCallId,
      title: "mcp.research-workbench.list_workspaces",
      kind: "execute" as const,
      ...extra,
    });
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: "s1",
      update: codexCall("mcp", { _meta: { is_mcp_tool_call: true } }),
    });
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: "s1",
      update: codexCall("shell", {
        rawInput: { command: "mcp.research-workbench.list_workspaces" },
        _meta: { terminal_info: {} },
      }),
    });
    await vi.waitFor(() => expect(f.updates).toHaveLength(2));
    const ask = (toolCallId: string) =>
      f.peer.client.request(
        methods.client.session.requestPermission,
        request({ toolCall: { toolCallId, title: "Run command", kind: "execute" } }),
      );
    await expect(ask("mcp")).resolves.toEqual(outcome("once"));
    const shell = ask("shell");
    await vi.waitFor(() => expect(f.permissions).toHaveLength(1));
    connection.respondPermission(f.permissions[0]!.requestId, "reject");
    await expect(shell).resolves.toEqual(outcome("reject"));
  });

  it.each(nonWhiteboardTools)("不把参数、普通命令或子串当作白板工具，一律交给界面 %j", async (tool) => {
    const toolCall = { toolCallId: "t", ...tool };
    expect(isWhiteboardToolCall(toolCall)).toBe(false);
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    const result = f.peer.client.request(methods.client.session.requestPermission, request({ toolCall }));
    await vi.waitFor(() => expect(f.permissions).toHaveLength(1));
    connection.respondPermission(f.permissions[0]!.requestId, "reject");
    await expect(result).resolves.toEqual(outcome("reject"));
  });

  const cases = [false, true].flatMap((whiteboard) =>
    ["all", "always", "reject", "none"].map((available) => ({ whiteboard, available })),
  );
  it.each(cases)("whiteboard=$whiteboard / options=$available", async ({ whiteboard, available }) => {
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    const options =
      available === "all"
        ? permissionOptions
        : available === "always"
          ? permissionOptions.filter((o) => o.kind.endsWith("always"))
          : available === "reject"
            ? permissionOptions.filter((o) => o.kind.startsWith("reject"))
            : [];
    const result = f.peer.client.request(
      methods.client.session.requestPermission,
      request({
        options,
        toolCall: whiteboard
          ? { toolCallId: "t", _meta: { claudeCode: { toolName: "mcp__research-workbench__x" } } }
          : { toolCallId: "t", title: "shell" },
      }),
    );
    if (!whiteboard) {
      await vi.waitFor(() => expect(f.permissions).toHaveLength(1));
      expect(f.permissions[0]?.options).toEqual(options);
      connection.respondPermission(f.permissions[0]!.requestId, options[0]?.optionId ?? null);
      await expect(result).resolves.toEqual(outcome(options[0]?.optionId));
      expect(f.permissions.at(-1)).toBeNull();
    } else {
      const selected = available === "all" ? "once" : available === "always" ? "always" : undefined;
      await expect(result).resolves.toEqual(outcome(selected));
      expect(f.permissions).toEqual([]);
    }
  });

  it("保留参数并等待，拒绝伪造选项，排队处理并发请求，迟到回答无效", async () => {
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    const firstDone = vi.fn();
    const first = f.peer.client.request(methods.client.session.requestPermission, request()).then((value) => {
      firstDone();
      return value;
    });
    const second = f.peer.client.request(methods.client.session.requestPermission, request());
    await vi.waitFor(() => expect(f.permissions).toHaveLength(1));
    const firstId = f.permissions[0]!.requestId;
    expect(f.permissions[0]).toEqual({
      requestId: firstId,
      agentId: "codex",
      title: "shell",
      toolKind: "execute",
      rawInput: { command: "echo" },
      options: permissionOptions,
    });
    connection.respondPermission(firstId, "forged");
    expect(firstDone).not.toHaveBeenCalled();
    connection.respondPermission(firstId, "reject");
    await expect(first).resolves.toEqual(outcome("reject"));
    await vi.waitFor(() => expect(f.permissions).toHaveLength(3));
    const secondId = f.permissions[2]!.requestId;
    expect(secondId).not.toBe(firstId);
    connection.respondPermission(firstId, "once");
    connection.respondPermission(secondId, null);
    await expect(second).resolves.toEqual(outcome());
  });

  it("一轮结束时取消尚未选择的权限请求", async () => {
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    const pending = f.peer.client.request(methods.client.session.requestPermission, request());
    await vi.waitFor(() => expect(f.permissions).toHaveLength(1));
    await connection.prompt([]);
    await expect(pending).resolves.toEqual(outcome());
    expect(f.permissions.at(-1)).toBeNull();
  });

  it.each(["cancel", "dispose", "disconnect"] as const)("%s 清除全部挂起权限请求", async (action) => {
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    const results = [1, 2].map(() => f.peer.client.request(methods.client.session.requestPermission, request()));
    const checked = results.map((result) =>
      action === "disconnect" ? expect(result).rejects.toThrow() : expect(result).resolves.toEqual(outcome()),
    );
    await vi.waitFor(() => expect(f.permissions).toHaveLength(1));
    if (action === "disconnect") await f.disconnect();
    else await connection[action]();
    await Promise.all(checked);
    expect(f.permissions.at(-1)).toBeNull();
  });
});

describe("不进对话的看状态命令", () => {
  const chunk = (sessionId: string, text: string, messageId: string) => ({
    sessionId,
    update: { sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text }, messageId },
  });

  function quietFixture(fork: (sessionId: string) => { sessionId: string } | Promise<never>) {
    const forked = vi.fn((params: { sessionId: string }) => fork(params.sessionId));
    const deleted = vi.fn<(params: { sessionId: string }) => object>(() => ({}));
    const prompts: { sessionId: string; text: string }[] = [];
    // 复制会话只在 unstable 入口里有
    const f = fixture(
      (app) => {
        (app as unknown as UnstableAgentApp).onRequest(
          unstableMethods.agent.session.fork,
          ({ params }) => forked(params) as never,
        );
        app
          .onRequest(methods.agent.session.delete, ({ params }) => deleted(params))
          .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
            const text = params.prompt[0].type === "text" ? params.prompt[0].text : "";
            prompts.push({ sessionId: params.sessionId, text });
            // 照实测：Claude Code 换个 messageId 把同一段结果再发一遍
            await client.notify(methods.client.session.update, chunk(params.sessionId, "## Context", "a"));
            await client.notify(methods.client.session.update, chunk(params.sessionId, " Usage", "a"));
            await client.notify(methods.client.session.update, chunk(params.sessionId, "## Context Usage\n\n", "b"));
            return { stopReason: "end_turn" };
          });
      },
      () => unstableAgent() as unknown as AgentApp,
    );
    return { ...f, forked, deleted, prompts };
  }

  it("Claude Code 的 /context 在副本里跑，跑完删副本，原会话和聊天界面都收不到", async () => {
    const f = quietFixture(() => ({ sessionId: "fork-1" }));
    const connection = await f.start("claude");
    await connection.openSession(session);
    const text = await connection.runQuietCommand("context", { ...session, isolated: true });
    expect(text).toBe("## Context Usage");
    expect(f.forked).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", cwd: "/research" }));
    expect(f.prompts).toEqual([{ sessionId: "fork-1", text: "/context" }]);
    expect(f.deleted).toHaveBeenCalledWith({ sessionId: "fork-1" });
    expect(f.updates).toEqual([]);
  });

  it("还没发过消息、复制不了时，新开一个临时会话跑，用完同样删掉", async () => {
    const f = quietFixture(() => Promise.reject(new RequestError(-32002, "Resource not found")));
    f.newSession.mockReturnValueOnce({ sessionId: "s1" }).mockReturnValueOnce({ sessionId: "scratch" });
    const connection = await f.start("claude");
    await connection.openSession(session);
    expect(await connection.runQuietCommand("context", { ...session, isolated: true })).toBe("## Context Usage");
    expect(f.prompts).toEqual([{ sessionId: "scratch", text: "/context" }]);
    expect(f.deleted).toHaveBeenCalledWith({ sessionId: "scratch" });
  });

  it("Codex 的 /status 直接在原会话里跑，结果只交给调用方", async () => {
    const f = quietFixture(() => ({ sessionId: "unused" }));
    const connection = await f.start("codex");
    await connection.openSession(session);
    expect(await connection.runQuietCommand("status", { ...session, isolated: false })).toBe("## Context Usage");
    expect(f.prompts).toEqual([{ sessionId: "s1", text: "/status" }]);
    expect(f.forked).not.toHaveBeenCalled();
    expect(f.deleted).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]);
  });

  it.each(["failed", "loaded", "prompted"])("复制失败不能用空会话冒充已有上下文：%s", async (mode) => {
    const f = quietFixture(() =>
      Promise.reject(mode === "failed" ? RequestError.internalError() : new RequestError(-32002, "Resource not found")),
    );
    const connection = await f.start("claude");
    await connection.openSession({ ...session, previousSessionId: mode === "loaded" ? "old" : undefined });
    if (mode === "prompted") await connection.prompt([{ type: "text", text: "question" }]);
    const newCount = f.newSession.mock.calls.length;
    const promptCount = f.prompts.length;
    await expect(connection.runQuietCommand("context", { ...session, isolated: true })).rejects.toThrow();
    expect(f.newSession).toHaveBeenCalledTimes(newCount);
    expect(f.prompts).toHaveLength(promptCount);
  });

  it("解析 /context 的分类表和明细、/status 的逐项字段（2026-11-10 实测格式）", () => {
    const context = parseLocalAgentContext(
      [
        "## Context Usage",
        "",
        "**Model:** claude-opus-5-5  ",
        "**Tokens:** 13.9k / 1m (1%)",
        "",
        "### Estimated usage by category",
        "",
        "| Category | Tokens | Percentage |",
        "|----------|--------|------------|",
        "| System prompt | 2k | 0.2% |",
        "| MCP tools (deferred) | 10.3k | 1.0% |",
        "| Messages | 10 | 0.0% |",
        "| Free space | 953.1k | 95.3% |",
        "",
        "### Memory Files",
        "",
        "| Type | Path | Tokens |",
        "|------|------|--------|",
        "| Project | /a/CLAUDE.md | 2.6k |",
      ].join("\n"),
    );
    expect(context.fields).toEqual([
      { label: "Model", value: "claude-opus-5-5" },
      { label: "Tokens", value: "13.9k / 1m (1%)" },
    ]);
    expect(context.categories).toEqual([
      { name: "System prompt", tokens: "2k", percent: 0.2, deferred: false, free: false },
      { name: "MCP tools (deferred)", tokens: "10.3k", percent: 1, deferred: true, free: false },
      { name: "Messages", tokens: "10", percent: 0, deferred: false, free: false },
      { name: "Free space", tokens: "953.1k", percent: 95.3, deferred: false, free: true },
    ]);
    expect(context.tables).toEqual([
      { title: "Memory Files", columns: ["Type", "Path", "Tokens"], rows: [["Project", "/a/CLAUDE.md", "2.6k"]] },
    ]);
    const status = parseLocalAgentContext(
      "**Model:** gpt-6-astra[xhigh]  \n**Session:** `01a1`  \n  \n**Context window:** 8% used (19.9K used / 258.4K)",
    );
    expect(status).toEqual({
      fields: [
        { label: "Model", value: "gpt-6-astra[xhigh]" },
        { label: "Session", value: "01a1" },
        { label: "Context window", value: "8% used (19.9K used / 258.4K)" },
      ],
      categories: [],
      tables: [],
    });
  });
});

describe("mapSessionUpdate", () => {
  it.each(["text", "reasoning"] as const)("%s 逐字合并同一段，结束补齐 end，输入状态保持不变", (kind) => {
    const initial = createSessionUpdateState("m");
    const snapshot = structuredClone(initial);
    const update: SessionUpdate = {
      sessionUpdate: kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
      content: { type: "text", text: "a" },
    };
    const first = mapSessionUpdate(update, initial);
    const second = mapSessionUpdate(update, first.state);
    expect(first).toEqual(mapSessionUpdate(update, initial));
    expect(initial).toEqual(snapshot);
    expect([...first.chunks, ...second.chunks, ...finishSessionUpdate(second.state, "end_turn").chunks]).toEqual([
      { type: `${kind}-start`, id: "m:0" },
      { type: `${kind}-delta`, id: "m:0", delta: "a" },
      { type: `${kind}-delta`, id: "m:0", delta: "a" },
      { type: `${kind}-end`, id: "m:0" },
      { type: "finish", finishReason: "stop", messageMetadata: {} },
    ]);
    expect(finishSessionUpdate(second.state, "cancelled").chunks.at(-1)).toEqual({ type: "abort" });
  });

  it.each(["completed", "failed"] as const)("交替文本/思考/工具，工具增量保留输入并输出 %s", (status) => {
    let state = mapSessionUpdate(textUpdate("hello"), createSessionUpdateState("m")).state;
    const thought = mapSessionUpdate(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } },
      state,
    );
    expect(thought.chunks.map((c) => c.type)).toEqual(["text-end", "reasoning-start", "reasoning-delta"]);
    state = thought.state;
    const call = mapSessionUpdate(
      { sessionUpdate: "tool_call", toolCallId: "t", title: "search", rawInput: { query: "paper" } },
      state,
    );
    expect(call.chunks).toEqual([
      { type: "reasoning-end", id: "m:1" },
      { type: "tool-input-available", toolCallId: "t", toolName: "search", input: { query: "paper" }, dynamic: true },
    ]);
    const increment = mapSessionUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", title: null },
      call.state,
    );
    expect(increment.chunks).toEqual([]);
    expect(increment.state.toolCalls.t).toMatchObject({ title: "search", rawInput: { query: "paper" } });
    const result = mapSessionUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "t", status, rawOutput: "result" },
      increment.state,
    );
    expect(result.chunks).toEqual([
      status === "completed"
        ? { type: "tool-output-available", toolCallId: "t", output: "result", dynamic: true }
        : { type: "tool-output-error", toolCallId: "t", errorText: "result", dynamic: true },
    ]);
    expect(
      mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", status }, result.state).chunks,
    ).toEqual([]);
    expect(mapSessionUpdate(textUpdate("after"), result.state).chunks[0]).toEqual({ type: "text-start", id: "m:2" });
  });

  it("换了 messageId 另起一段；Claude Code 本地命令换个 messageId 重发的同一段结果只显示一次", () => {
    const chunk = (text: string, messageId: string): SessionUpdate => ({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId,
    });
    // 2026-11-09 实测 /context：两条内容一样，第二条末尾多两个换行
    const table = "## Context Usage\n\n| Category | Tokens |";
    let state = createSessionUpdateState("m");
    const chunks: unknown[] = [];
    for (const update of [
      chunk("## Context", "a"),
      chunk(" Usage\n\n| Category | Tokens |", "a"),
      chunk(`${table}\n\n`, "b"),
    ]) {
      const mapped = mapSessionUpdate(update, state);
      chunks.push(...mapped.chunks);
      state = mapped.state;
    }
    const next = mapSessionUpdate(chunk("另一条", "c"), state);
    chunks.push(...next.chunks, ...finishSessionUpdate(next.state, "end_turn").chunks.slice(0, -1));
    expect(chunks).toEqual([
      { type: "text-start", id: "m:0" },
      { type: "text-delta", id: "m:0", delta: "## Context" },
      { type: "text-delta", id: "m:0", delta: " Usage\n\n| Category | Tokens |" },
      { type: "text-end", id: "m:0" },
      { type: "text-start", id: "m:1" },
      { type: "text-delta", id: "m:1", delta: "另一条" },
      { type: "text-end", id: "m:1" },
    ]);
    expect(mapSessionUpdate(chunk("more", "b"), state).chunks).toEqual([]);
  });

  it("usage 保存上下文占用量到元数据，不伪造输入输出 token", () => {
    const usage = { used: 123, size: 200000 };
    const result = mapSessionUpdate({ sessionUpdate: "usage_update", ...usage }, createSessionUpdateState("m"));
    expect(result.state).not.toHaveProperty("usage");
    expect(result.state.metadata).toEqual({ localAgentUsage: usage });
    expect(result.chunks).toEqual([{ type: "message-metadata", messageMetadata: { localAgentUsage: usage } }]);
  });

  it.each([
    { sessionUpdate: "plan", entries: [] },
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "history" } },
    { sessionUpdate: "current_mode_update", currentModeId: "code" },
    { sessionUpdate: "config_option_update", configOptions: [] },
    { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "a", mimeType: "image/png" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "resource_link", uri: "file:///a", name: "a" } },
  ] satisfies SessionUpdate[])("忽略尚不显示的更新 %j", (update) => {
    const state = createSessionUpdateState("m");
    expect(mapSessionUpdate(update, state)).toEqual({ state, chunks: [] });
  });
});

describe("research-workbench MCP launch", () => {
  it.each([
    [
      { node: "/node", script: "/cli.js", appHome: "/home" },
      [{ name: "research-workbench", command: "/node", args: ["/cli.js", "mcp", "--app-home", "/home"], env: [] }],
    ],
    [
      { node: null, script: "/cli.js", appHome: "" },
      [{ name: "research-workbench", command: "node", args: ["/cli.js", "mcp"], env: [] }],
    ],
    [{ node: null, script: null, appHome: null }, []],
    [{ node: "/node", script: "", appHome: "/home" }, []],
  ])("启动参数 %j", (launch, expected) => {
    expect(buildLocalAgentMcpServers(launch)).toEqual(expected);
  });
});
