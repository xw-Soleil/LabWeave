// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { researchFolderPath: "/research" },
  invoke: vi.fn(),
  exists: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  onOpenFile: vi.fn(),
  closeEmptyDrafts: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: mocks.exists,
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
  readDir: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/core/service/GlobalMenu", () => ({
  onOpenFile: mocks.onOpenFile,
  closeEmptyDrafts: mocks.closeEmptyDrafts,
}));

import { URI } from "vscode-uri";
import { RESEARCH_FILES_CHANGED_EVENT, ResearchFolder } from "./ResearchFolder";

describe("ResearchFolder.createWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.researchFolderPath = "/research";
    mocks.invoke.mockImplementation(async (_command: string, args: { path: string }) => args.path);
    mocks.exists.mockResolvedValue(false);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.onOpenFile.mockImplementation(async (uri: URI) => ({ uri }));
  });

  it("writes an empty project without overwriting, opens it and closes empty drafts", async () => {
    const changed = vi.fn();
    window.addEventListener(RESEARCH_FILES_CHANGED_EVENT, changed);

    const path = await ResearchFolder.createWorkspace("  文献综述.prg ");

    window.removeEventListener(RESEARCH_FILES_CHANGED_EVENT, changed);
    expect(path).toBe("/research/文献综述.prg");
    expect(mocks.writeFile).toHaveBeenCalledWith("/research/文献综述.prg", expect.any(Uint8Array), {
      createNew: true,
    });
    expect(mocks.onOpenFile).toHaveBeenCalledWith(URI.file("/research/文献综述.prg"), expect.any(String));
    expect(mocks.closeEmptyDrafts).toHaveBeenCalledWith({ uri: URI.file("/research/文献综述.prg") });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("refuses existing files, bad names and a missing research folder", async () => {
    mocks.exists.mockResolvedValue(true);
    expect(await ResearchFolder.createWorkspace("已有")).toBe("");
    expect(mocks.toastError).toHaveBeenLastCalledWith("files.workspaceName.exists");

    expect(await ResearchFolder.createWorkspace("a:b")).toBe("");
    expect(mocks.toastError).toHaveBeenLastCalledWith("files.workspaceName.invalidChars");

    mocks.settings.researchFolderPath = "";
    expect(await ResearchFolder.createWorkspace("新的")).toBe("");
    expect(mocks.toastError).toHaveBeenLastCalledWith("files.noRoot");

    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.onOpenFile).not.toHaveBeenCalled();
  });
});

describe("ResearchFolder.ensureRootRegistered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers each root once and stores the canonical path Rust returns", async () => {
    mocks.settings.researchFolderPath = "/var/research";
    mocks.invoke.mockResolvedValue("/private/var/research");

    await ResearchFolder.ensureRootRegistered();
    expect(mocks.invoke).toHaveBeenCalledWith("set_research_root", { path: "/var/research", restore: false });
    expect(mocks.settings.researchFolderPath).toBe("/private/var/research");

    await ResearchFolder.ensureRootRegistered();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("throws on failure and tries again next time", async () => {
    mocks.settings.researchFolderPath = "/elsewhere";
    mocks.invoke.mockRejectedValueOnce("folder is gone").mockResolvedValueOnce("/elsewhere");

    await expect(ResearchFolder.ensureRootRegistered()).rejects.toBe("folder is gone");
    await ResearchFolder.ensureRootRegistered();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("serializes an old registration with switching and does not let background scans re-register the old root", async () => {
    mocks.settings.researchFolderPath = "/old";
    let finishOld!: (path: string) => void;
    mocks.invoke
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementation(async (_command, args) => args.path);
    const old = ResearchFolder.ensureRootRegistered();
    await vi.waitFor(() => expect(finishOld).toBeDefined());
    const switching = ResearchFolder.setRoot("/new");
    const scan = ResearchFolder.ensureRootRegistered();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    finishOld("/canonical-old");
    await Promise.all([old, switching, scan]);
    expect(mocks.invoke.mock.calls.map(([, args]) => args.path)).toEqual(["/old", "/new"]);
    expect(mocks.settings.researchFolderPath).toBe("/new");
  });
});

describe("ResearchFolder.createEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.researchFolderPath = "/research";
    mocks.invoke.mockImplementation(async (_command: string, args: { path: string }) => args.path);
    mocks.exists.mockResolvedValue(false);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.onOpenFile.mockImplementation(async (uri: URI) => ({ uri }));
  });

  it("creates an empty note, a folder and a board inside a subfolder without overwriting", async () => {
    expect(await ResearchFolder.createEntry("note", " 组会记录.md ", "/research/笔记")).toBe(
      "/research/笔记/组会记录.md",
    );
    expect(mocks.writeFile).toHaveBeenCalledWith("/research/笔记/组会记录.md", new Uint8Array(), { createNew: true });

    expect(await ResearchFolder.createEntry("folder", "实验", "/research/笔记")).toBe("/research/笔记/实验");
    expect(mocks.mkdir).toHaveBeenCalledWith("/research/笔记/实验");

    expect(await ResearchFolder.createWorkspace("草图", "/research/笔记")).toBe("/research/笔记/草图.prg");
  });

  it("refuses names that exist, bad names and folders outside the research folder", async () => {
    mocks.exists.mockResolvedValue(true);
    expect(await ResearchFolder.createEntry("note", "已有")).toBe("");
    expect(mocks.toastError).toHaveBeenLastCalledWith("files.entryName.exists");

    expect(await ResearchFolder.createEntry("folder", "  ")).toBe("");
    expect(mocks.toastError).toHaveBeenLastCalledWith("files.entryName.empty");

    mocks.exists.mockResolvedValue(false);
    expect(await ResearchFolder.createEntry("note", "别处", "/elsewhere")).toBe("");
    expect(await ResearchFolder.createWorkspace("别处", "/elsewhere")).toBe("");
    expect(mocks.toastError).toHaveBeenLastCalledWith("files.noRoot");

    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
  });
});
