// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";

const mocks = vi.hoisted(() => ({
  settings: { researchFolderPath: "/research", researchSession: { openWorkspaces: ["a.prg"], active: "a.prg" } },
  saved: undefined as unknown,
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  invoke: vi.fn(),
  readDir: vi.fn(),
  mkdir: vi.fn(),
  web: true,
}));
vi.mock("@/utils/platform", () => ({
  get isWeb() {
    return mocks.web;
  },
}));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@/state", () => ({ store: createStore() }));
vi.mock("@/utils/store", () => ({
  createStore: vi.fn(async () => ({ get: mocks.get, set: mocks.set, save: mocks.save })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readDir: mocks.readDir, mkdir: mocks.mkdir }));

import { store } from "@/state";
import { ResearchFolder } from "./ResearchFolder";
import {
  activeResearchWorkspace,
  addResearchProject,
  authorizeResearchProject,
  checkProjectName,
  createResearchProject,
  loadResearchWorkspace,
  projectPathKey,
  projectForFile,
  readResearchDirectory,
  rememberProjectSession,
  researchWorkspaceAtom,
  updateResearchWorkspace,
} from "./ResearchWorkspace";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.web = true;
  mocks.saved = undefined;
  mocks.settings.researchFolderPath = "/research";
  store.set(researchWorkspaceAtom, null);
  mocks.get.mockImplementation(async () => mocks.saved);
  mocks.set.mockImplementation(async (_key, value) => {
    mocks.saved = structuredClone(value);
  });
  mocks.save.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (_command, { path }) => path);
  mocks.mkdir.mockResolvedValue(undefined);
});

describe("workspace project list", () => {
  it("does not conflate an unset project, filesystem root or case-sensitive POSIX folders", () => {
    expect(projectPathKey("/")).not.toBe(projectPathKey(""));
    expect(projectPathKey("/Research")).not.toBe(projectPathKey("/research"));
  });

  it("finds the most specific listed project for external board entry points", async () => {
    await addResearchProject("/other");
    await addResearchProject("/other/nested");
    expect(await projectForFile("/other/nested/a.prg")).toBe("/other/nested");
    expect(await projectForFile("/research/a.prg")).toBeUndefined();
    expect(await projectForFile("/outside/a.prg")).toBeUndefined();
  });

  it("uses the native atomic store, propagates load errors and publishes only successful saves", async () => {
    mocks.web = false;
    let disk: unknown = null;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "load_research_workspace") return structuredClone(disk);
      expect(command).toBe("save_research_workspace");
      expect(args.expected).toEqual(disk);
      if (args.data.workspaces[0].name === "fail") throw new Error("disk full");
      disk = structuredClone(args.data);
    });
    const initial = await loadResearchWorkspace();
    await expect(
      updateResearchWorkspace((data) => {
        data.workspaces[0].name = "fail";
      }),
    ).rejects.toThrow("disk full");
    expect(store.get(researchWorkspaceAtom)).toEqual(initial);
    expect(disk).toEqual(initial);
    store.set(researchWorkspaceAtom, null);
    mocks.invoke.mockRejectedValueOnce(new Error("workspaceCorrupt"));
    await expect(loadResearchWorkspace()).rejects.toThrow("workspaceCorrupt");
    expect(disk).toEqual(initial);
    expect(await loadResearchWorkspace()).toEqual(initial);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("migrates the current research folder once, persists the name and keeps an empty list empty after restart", async () => {
    const first = await loadResearchWorkspace();
    expect(activeResearchWorkspace(first).projects).toEqual([{ path: "/research" }]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await updateResearchWorkspace((data) => {
      const workspace = activeResearchWorkspace(data);
      workspace.name = "论文";
      workspace.projects = [];
    });
    store.set(researchWorkspaceAtom, null);
    expect(activeResearchWorkspace(await loadResearchWorkspace())).toMatchObject({ name: "论文", projects: [] });
  });

  it("adds unrelated folders only after explicit authorization, deduplicates Windows paths and remembers removed projects", async () => {
    await addResearchProject("C:\\Users\\a\\Research");
    await addResearchProject("c:/Users/a/Research/");
    await addResearchProject("/Volumes/External/Project");
    expect(mocks.invoke).toHaveBeenCalledWith("authorize_research_project", { path: "/Volumes/External/Project" });
    expect(mocks.invoke.mock.calls.every(([command]) => command === "authorize_research_project")).toBe(true);
    await updateResearchWorkspace((data) => {
      activeResearchWorkspace(data).projects = [];
    });
    expect((await loadResearchWorkspace()).recentProjects).toEqual([
      "/Volumes/External/Project",
      "c:/Users/a/Research/",
      "/research",
    ]);
    await expect(authorizeResearchProject("/not-selected")).rejects.toThrow("projectNotInWorkspace");
  });

  it("leaves the list intact on authorization failure and reports corrupt saved data without overwriting it", async () => {
    await loadResearchWorkspace();
    mocks.invoke.mockRejectedValueOnce(new Error("unplugged"));
    await expect(addResearchProject("/missing")).rejects.toThrow("unplugged");
    expect(activeResearchWorkspace(await loadResearchWorkspace()).projects).toHaveLength(1);
    store.set(researchWorkspaceAtom, null);
    mocks.saved = { version: 500 };
    const writes = mocks.set.mock.calls.length;
    await expect(loadResearchWorkspace()).rejects.toThrow();
    expect(mocks.set).toHaveBeenCalledTimes(writes);
  });

  it("serializes writes, reports persistence failures and permits a retry", async () => {
    await loadResearchWorkspace();
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      updateResearchWorkspace((data) => {
        activeResearchWorkspace(data).name = "lost";
      }),
    ).rejects.toThrow("disk full");
    expect(activeResearchWorkspace(store.get(researchWorkspaceAtom)!).name).toBe("");
    await Promise.all([
      updateResearchWorkspace((data) => {
        activeResearchWorkspace(data).name = "kept";
      }),
      rememberProjectSession("/research"),
    ]);
    expect(activeResearchWorkspace(await loadResearchWorkspace())).toMatchObject({
      name: "kept",
      projects: [{ path: "/research", session: { openWorkspaces: ["a.prg"], active: "a.prg" } }],
    });
  });

  it("creates only the named folder and never merges with or overwrites an existing folder", async () => {
    expect(await createResearchProject("D:\\Projects", "试验")).toBe("D:/Projects/试验");
    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith("D:/Projects/试验");
    mocks.mkdir.mockRejectedValueOnce(new Error("already exists"));
    const grants = mocks.invoke.mock.calls.length;
    await expect(createResearchProject("D:/Projects", "试验")).rejects.toThrow("already exists");
    expect(mocks.invoke).toHaveBeenCalledTimes(grants);
    for (const name of ["", "..", ".hidden", "a/b", "a\\b", "a:", "NUL", "COM1.txt", "name.", "a\u0000"])
      expect(() => checkProjectName(name)).toThrow("invalidProjectName");
  });
});

describe("one-level folder reads", () => {
  it("reads only the requested level, includes other files and skips hidden entries and symlinks", async () => {
    mocks.readDir.mockResolvedValue([
      { name: "z.docx", isFile: true },
      { name: "a.md", isFile: true },
      { name: "board.prg", isFile: true },
      { name: "sub", isDirectory: true },
      { name: ".workbench", isDirectory: true },
      { name: ".DS_Store", isFile: true },
      { name: "linked", isDirectory: true, isSymlink: true },
    ]);
    expect((await readResearchDirectory("/r", "/r")).map((entry) => [entry.name, entry.kind])).toEqual([
      ["sub", "other"],
      ["a.md", "markdown"],
      ["board.prg", "workspace"],
      ["z.docx", "other"],
    ]);
    expect(mocks.readDir).toHaveBeenCalledExactlyOnceWith("/r");
    expect((await readResearchDirectory("/r", "/r", true)).map((entry) => entry.name)).toEqual(["sub"]);
    await expect(readResearchDirectory("/r", "/r/../outside")).rejects.toThrow("directoryOutsideProject");
  });

  it("handles deep paths, drive roots, UNC paths and traversal without imposing a tree depth limit", async () => {
    mocks.readDir.mockResolvedValue([{ name: "a.pdf", isFile: true }]);
    const path = "C:/" + "folder/".repeat(20);
    expect((await readResearchDirectory("C:/", path))[0].absPath).toBe(path + "a.pdf");
    expect(ResearchFolder.toAbsolute("..", "C:/")).toBe("C:/");
    expect(ResearchFolder.toAbsolute("..", "//server/share")).toBe("//server/share");
    expect(projectPathKey("C:\\a\\..\\b\\")).toBe(projectPathKey("c:/b"));
    expect((await readResearchDirectory("\\\\server\\share", "\\\\server\\share\\sub"))[0].relPath).toBe("sub/a.pdf");
    mocks.readDir.mockRejectedValueOnce(new Error("gone"));
    await expect(readResearchDirectory("/r", "/r")).rejects.toThrow("gone");
  });
});
