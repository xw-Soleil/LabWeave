import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExternalAiMcpServer,
  runExternalAiMcpServer,
  type ExternalAiMcpDependencies,
} from "./ProjectGraphMcpServer";
import type { PathRoutedInvocationOptions } from "./ProjectGraphCliRuntime";

type InvokeResult = Awaited<ReturnType<ExternalAiMcpDependencies["invoke"]>>;

let root: string;
let settings: Record<string, unknown>;
let calls: PathRoutedInvocationOptions[];
let nextResult: InvokeResult;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "research-workbench-mcp-")));
  for (const file of ["a.prg", "sub/b.prg", "sub2/b.prg", ".hidden/x.prg", "a_backup.prg", "notes.md"]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  mkdirSync(join(root, ".workbench"));
  writeFileSync(join(root, ".workbench", "a.ai.md"), "# a 的文字版");
  settings = { researchFolderPath: root };
  calls = [];
  nextResult = { ok: true, value: { success: true, ref: "n1" } };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function connect(overrides: Partial<ExternalAiMcpDependencies> = {}) {
  const server = createExternalAiMcpServer({
    version: "test",
    readSettings: () => settings,
    invoke: async (options) => {
      calls.push(options);
      return nextResult;
    },
    isWorkspaceOpen: async (absPath) => absPath.endsWith("a.prg"),
    ...overrides,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const [content] = result.content as Array<{ type: string; text: string }>;
  return { isError: result.isError === true, value: JSON.parse(content.text) };
}

describe("external AI MCP server", () => {
  it("lists read-only PDF tools, forwards their parameters and returns structured read errors", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ["read_pdf_text", "search_pdf"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(client.getInstructions()).toContain(name);
    }
    nextResult = { ok: true, value: { pages: [{ page: 3, text: "paper text" }], truncated: false } };
    expect(
      parse(
        await client.callTool({
          name: "read_pdf_text",
          arguments: { workspace: "a", path: "/papers/a.pdf", pages: "3-5" },
        }),
      ).isError,
    ).toBe(false);
    expect(calls[0]).toMatchObject({ toolName: "read_pdf_text", input: { path: "/papers/a.pdf", pages: "3-5" } });
    nextResult = {
      ok: true,
      value: { success: false, error: { code: "pdf.pathNotAllowed", message: "pdf.pathNotAllowed" } },
    };
    expect(
      parse(
        await client.callTool({
          name: "search_pdf",
          arguments: { workspace: "a", path: "/secret.pdf", query: "word" },
        }),
      ),
    ).toMatchObject({ isError: true, value: { error: { code: "pdf.pathNotAllowed" } } });
  });
  it("forwards cached PDF text and paths for a closed workspace", async () => {
    const card = { title: "Paper", text: "Saved PDF excerpt", file: { path: "papers/a.pdf", kind: "pdf", pages: 10 } };
    nextResult = { ok: true, value: { cards: [card] } };
    const client = await connect({ isWorkspaceOpen: async () => false });
    const result = parse(await client.callTool({ name: "dump_workspace", arguments: { workspace: "sub/b.prg" } }));
    expect(result).toEqual({ isError: false, value: { cards: [card] } });
    expect(calls[0].projectPath).toBe(join(root, "sub", "b.prg"));
  });
  it("introduces itself and lists every tool with a required workspace parameter", async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: "research-workbench", version: "test" });
    expect(client.getInstructions()).toContain("list_workspaces");

    const { tools } = await client.listTools();
    expect(tools[0].name).toBe("list_workspaces");
    expect(tools).toHaveLength(37);
    const createEdges = tools.find(({ name }) => name === "create_edges")!;
    expect(createEdges.inputSchema.required).toEqual(["workspace", "edges"]);
    expect(Object.keys(createEdges.inputSchema.properties!)[0]).toBe("workspace");
    expect(tools.find(({ name }) => name === "dump_workspace")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find(({ name }) => name === "delete_all_nodes")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.find(({ name }) => name === "recognize_image")!.annotations).toMatchObject({ openWorldHint: true });
  });

  it("hides tool groups the user switched off in settings, and reads the switches on every request", async () => {
    const client = await connect();
    const names = async () => (await client.listTools()).tools.map(({ name }) => name);

    settings.mcpAllowDelete = false;
    expect(await names()).not.toContain("delete_node");
    expect(await names()).toContain("create_text_node_at");

    settings.mcpAllowNetwork = false;
    expect(await names()).not.toContain("search_and_add_image_node");
    expect(await names()).not.toContain("recognize_image");

    settings.mcpAllowEdits = false;
    const readOnly = await names();
    expect(readOnly).toEqual(expect.arrayContaining(["list_workspaces", "dump_workspace", "get_all_nodes"]));
    expect(readOnly).not.toContain("create_text_node_at");
    expect(readOnly).not.toContain("edit_text_node");
    expect(readOnly).not.toContain("auto_layout_dag");

    const refused = parse(await client.callTool({ name: "create_text_node_at", arguments: { workspace: "a" } }));
    expect(refused).toMatchObject({ isError: true, value: { code: "TOOL_DISABLED" } });
    expect(calls).toEqual([]);
  });

  it("lists the research folder's workspaces like the file panel, with which ones are open", async () => {
    const client = await connect();
    const { value } = parse(await client.callTool({ name: "list_workspaces", arguments: {} }));
    expect(value.researchFolder).toBe(root);
    expect(value.workspaces.map((w: { workspace: string; open: boolean }) => [w.workspace, w.open])).toEqual([
      ["a.prg", true],
      ["sub/b.prg", false],
      ["sub2/b.prg", false],
    ]);
  });

  it("resolves the workspace and hands the rest of the input to the tool runner", async () => {
    const client = await connect();
    const result = parse(
      await client.callTool({
        name: "create_text_node_at",
        arguments: { workspace: "a", text: "hello", x: 10, y: 20 },
      }),
    );
    expect(result).toEqual({ isError: false, value: { success: true, ref: "n1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolName: "create_text_node_at",
      input: { text: "hello", x: 10, y: 20 },
      projectPath: join(root, "a.prg"),
      allowUpgrade: false,
      output: "capture",
    });
    expect(calls[0].abortSignal).toBeInstanceOf(AbortSignal);

    await client.callTool({ name: "dump_workspace", arguments: { workspace: "sub/b.prg" } });
    expect(calls[1].projectPath).toBe(join(root, "sub", "b.prg"));
  });

  it("refuses ambiguous, unknown and outside workspaces before running anything", async () => {
    writeFileSync(join(root, "..", "outside-research-workbench-mcp.prg"), "");
    try {
      const client = await connect();
      const call = async (workspace: unknown) =>
        parse(await client.callTool({ name: "dump_workspace", arguments: { workspace } }));

      const ambiguous = await call("b");
      expect(ambiguous).toMatchObject({ isError: true, value: { code: "WORKSPACE_NOT_FOUND" } });
      expect(ambiguous.value.message).toContain("sub/b.prg");
      expect(ambiguous.value.message).toContain("sub2/b.prg");
      expect((await call("missing")).value.message).toContain("a.prg");
      expect((await call("../outside-research-workbench-mcp")).value.message).toBe("只能操作研究文件夹里的工作区");
      expect((await call("a_backup")).isError).toBe(false);
      expect((await call(undefined)).value.code).toBe("WORKSPACE_NOT_FOUND");
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(join(root, "..", "outside-research-workbench-mcp.prg"), { force: true });
    }
  });

  it("checks the tool input against the tool's schema and explains what is wrong", async () => {
    const client = await connect();
    const result = parse(
      await client.callTool({ name: "create_text_node_at", arguments: { workspace: "a", text: "x", x: "left", y: 0 } }),
    );
    expect(result).toMatchObject({ isError: true, value: { code: "TOOL_INPUT_INVALID" } });
    expect(result.value.message).toContain("x");
    expect(calls).toEqual([]);
  });

  it("marks runtime errors and unsuccessful tool results as errors, with a hint for common ones", async () => {
    const client = await connect();
    nextResult = {
      ok: false,
      error: { code: "PROJECT_MUST_BE_OPEN", message: "This tool requires a matching Open Project." },
    };
    const mustBeOpen = parse(await client.callTool({ name: "get_selected_refs", arguments: { workspace: "sub/b" } }));
    expect(mustBeOpen).toMatchObject({ isError: true, value: { code: "PROJECT_MUST_BE_OPEN" } });
    expect(mustBeOpen.value.hint).toContain("create_text_node_at");

    nextResult = { ok: true, value: { success: false, error: { code: "mixed_levels", message: "不在同一层级" } } };
    const failed = parse(
      await client.callTool({ name: "create_section", arguments: { workspace: "a", refs: ["n1"], title: "t" } }),
    );
    expect(failed).toMatchObject({ isError: true, value: { success: false } });
  });

  it("offers each workspace's saved text version as a resource", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map(({ name }) => name)).toEqual(["a.prg", "sub/b.prg", "sub2/b.prg"]);
    const [a] = resources;
    expect(a).toMatchObject({ mimeType: "text/markdown" });
    const { contents } = await client.readResource({ uri: a.uri });
    expect(contents).toEqual([{ uri: a.uri, mimeType: "text/markdown", text: "# a 的文字版" }]);
    await expect(client.readResource({ uri: resources[1].uri })).rejects.toThrow("还没有文字版");
  });

  it("asks the user to choose a research folder first", async () => {
    settings = {};
    const client = await connect();
    expect(parse(await client.callTool({ name: "list_workspaces", arguments: {} })).value.code).toBe(
      "NO_RESEARCH_FOLDER",
    );
    expect((await client.listResources()).resources).toEqual([]);
  });

  it("serves until the process is told to stop", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const abort = new AbortController();
    const running = runExternalAiMcpServer({
      version: "test",
      loadRuntime: async () => ({ runPathRoutedInvocation: async () => nextResult }),
      abortSignal: abort.signal,
      transport: serverTransport,
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(1);
    abort.abort();
    await expect(running).resolves.toBeUndefined();
  });
});
