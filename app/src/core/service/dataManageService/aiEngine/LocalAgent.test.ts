import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type AgentConnection,
  type AnyMessage,
  type RequestPermissionRequest,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
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
  startLocalAgent,
  stopLocalAgent,
  type LocalAgentEvent,
  type LocalAgentInfo,
  type LocalAgentPermissionPolicy,
  type LocalAgentPermissionRequest,
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

function fixture(configure?: (app: AgentApp) => void) {
  const initialize = vi.fn(() => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    authMethods: [{ id: "login", name: "Login" }],
  }));
  const newSession = vi.fn(() => ({ sessionId: "s1" }));
  const load = vi.fn(() => ({}));
  const prompt = vi.fn(() => ({ stopReason: "end_turn" as const }));
  const cancel = vi.fn();
  const app = agent();
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
  let policy: LocalAgentPermissionPolicy = "restricted";
  const start = async () => {
    const connection = await LocalAgentConnection.start(stream, {
      agent: info,
      getPermissionPolicy: () => policy,
      onStatus: (s) => statuses.push(s),
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
    setPolicy: (value: LocalAgentPermissionPolicy) => {
      policy = value;
    },
  };
}

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
    expect(await connection.openSession({ ...session, previousSessionId: "old" })).toEqual({
      sessionId: mode === "supported" ? "old" : "s1",
      loaded: mode === "supported",
    });
    expect(load).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
    expect(f.newSession).toHaveBeenCalledTimes(mode === "supported" ? 0 : 1);
    expect(f.updates).toEqual([]);
    await f.peer.client.notify(methods.client.session.update, {
      sessionId: mode === "supported" ? "old" : "s1",
      update: textUpdate("new"),
    });
    await vi.waitFor(() => expect(f.updates).toEqual([textUpdate("new")]));
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
] satisfies Partial<RequestPermissionRequest["toolCall"]>[];

describe("LocalAgent permissions", () => {
  it.each([
    { title: "mcp__research-workbench__add_nodes" },
    { _meta: { tool: "mcp__research-workbench__read_1" } },
    { _meta: { server: "research-workbench" } },
    { _meta: { serverName: "research-workbench" } },
    { _meta: { mcpServer: "research-workbench" } },
    { _meta: { nested: [{ tool: "mcp__research-workbench__x" }] } },
    { _meta: { nested: { serverName: "research-workbench" } } },
  ])("从完整工具名或 _meta 的结构化标识识别白板工具 %j", (tool) => {
    expect(isWhiteboardToolCall({ toolCallId: "t", ...tool })).toBe(true);
  });

  it.each(nonWhiteboardTools)("不把参数、普通命令或子串当作白板工具，受限档必须拒绝 %j", async (tool) => {
    const toolCall = { toolCallId: "t", ...tool };
    expect(isWhiteboardToolCall(toolCall)).toBe(false);
    const f = fixture();
    const connection = await f.start();
    await connection.openSession(session);
    await expect(
      f.peer.client.request(methods.client.session.requestPermission, request({ toolCall })),
    ).resolves.toEqual(outcome("reject"));
  });

  const cases = (["restricted", "ask", "auto"] as const).flatMap((policy) =>
    [false, true].flatMap((whiteboard) =>
      ["all", "always", "none"].map((available) => ({ policy, whiteboard, available })),
    ),
  );
  it.each(cases)("$policy / whiteboard=$whiteboard / options=$available", async ({ policy, whiteboard, available }) => {
    const f = fixture();
    f.setPolicy(policy);
    const connection = await f.start();
    await connection.openSession(session);
    const options =
      available === "all"
        ? permissionOptions
        : available === "always"
          ? permissionOptions.filter((o) => o.kind.endsWith("always"))
          : [];
    const result = f.peer.client.request(
      methods.client.session.requestPermission,
      request({ options, toolCall: { toolCallId: "t", title: whiteboard ? "mcp__research-workbench__x" : "shell" } }),
    );
    if (policy === "ask" && !whiteboard) {
      await vi.waitFor(() => expect(f.permissions).toHaveLength(1));
      expect(f.permissions[0]?.options).toEqual(options);
      connection.respondPermission(f.permissions[0]!.requestId, options[0]?.optionId ?? null);
      await expect(result).resolves.toEqual(outcome(options[0]?.optionId));
      expect(f.permissions.at(-1)).toBeNull();
    } else {
      const selected =
        whiteboard || policy === "auto"
          ? available === "all"
            ? "once"
            : available === "always"
              ? "always"
              : undefined
          : available === "all"
            ? "reject"
            : undefined;
      await expect(result).resolves.toEqual(outcome(selected));
      expect(f.permissions).toEqual([]);
    }
  });

  it("ask 保留参数并等待，拒绝伪造选项，排队处理并发请求，迟到回答无效，实时读取策略", async () => {
    const f = fixture();
    f.setPolicy("ask");
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
    f.setPolicy("auto");
    await expect(f.peer.client.request(methods.client.session.requestPermission, request())).resolves.toEqual(
      outcome("once"),
    );
    f.setPolicy("restricted");
    await expect(f.peer.client.request(methods.client.session.requestPermission, request())).resolves.toEqual(
      outcome("reject"),
    );
  });

  it.each(["cancel", "dispose", "disconnect"] as const)("%s 清除全部挂起权限请求", async (action) => {
    const f = fixture();
    f.setPolicy("ask");
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
