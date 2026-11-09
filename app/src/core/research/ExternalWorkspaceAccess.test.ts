import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: { researchFolderPath: "" }, acquire: vi.fn() }));
vi.mock("@/cli/ExternalAiWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/cli/ExternalAiWorkspace")>()),
  readAppSettings: () => mocks.settings,
}));
vi.mock("@/cli/OwnershipHelper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/cli/OwnershipHelper")>()),
  acquireProjectOwnership: mocks.acquire,
}));

import { createProjectGraphCliRuntime } from "@/cli/ProjectGraphCliRuntime";
import { runProjectGraphCli } from "@/cli/ProjectGraphCli";

let directory: string;
let root: string;
let outside: string;
const invokeClosed = vi.fn(async () => ({ ok: true as const, value: "invoked" }));
const runtime = createProjectGraphCliRuntime(invokeClosed);
const invoke = (projectPath: string) =>
  runtime.runPathRoutedInvocation({ toolName: "get_all_nodes", input: {}, projectPath, allowUpgrade: false });

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "tempopen-access-"));
  root = join(directory, "research");
  mkdirSync(root);
  mkdirSync(join(directory, "outside"));
  outside = join(directory, "outside", "a.prg");
  writeFileSync(outside, "untouched");
  writeFileSync(join(root, "a.prg"), "inside");
  mocks.settings.researchFolderPath = root;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("external workspace path access", () => {
  it.each(["", "1"])("refuses outside paths before ownership or tool execution (worker=%s)", async (worker) => {
    vi.stubEnv("PROJECT_GRAPH_CLI_OWNERSHIP_ACQUIRED", worker);
    expect(await invoke(outside)).toMatchObject({ ok: false, error: { code: "TEMPORARY_WORKSPACE_FORBIDDEN" } });
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(invokeClosed).not.toHaveBeenCalled();
  });

  it("refuses traversal and symlinks leading out of the folder", async () => {
    symlinkSync(join(directory, "outside"), join(root, "linked"), "junction");
    for (const path of [join(root, "..", "outside", "a.prg"), join(root, "linked", "a.prg")]) {
      expect(await invoke(path)).toMatchObject({ ok: false, error: { code: "TEMPORARY_WORKSPACE_FORBIDDEN" } });
    }
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("rechecks settings and preserves no-folder behavior", async () => {
    vi.stubEnv("PROJECT_GRAPH_CLI_OWNERSHIP_ACQUIRED", "1");
    expect(await invoke(join(root, "a.prg"))).toMatchObject({ ok: true });
    mocks.settings.researchFolderPath = join(directory, "missing");
    expect(await invoke(outside)).toMatchObject({ ok: false, error: { code: "RESEARCH_FOLDER_UNAVAILABLE" } });
    mocks.settings.researchFolderPath = "";
    expect(await invoke(outside)).toMatchObject({ ok: true });
    expect(invokeClosed).toHaveBeenCalledTimes(2);
  });

  it("returns the explicit rejection code from the CLI command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const status = await runProjectGraphCli(
      ["tool", "invoke", "get_all_nodes", "--project", outside, "--input", "{}"],
      {
        version: "test",
        loadRuntime: async () => runtime,
      },
    );
    expect(status).toBe(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({ code: "TEMPORARY_WORKSPACE_FORBIDDEN" });
    expect(invokeClosed).not.toHaveBeenCalled();
  });
});
