import { beforeEach, describe, expect, it, vi } from "vitest";
import { decode, encode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import path from "node:path";
import { URI } from "vscode-uri";

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  tabs: [] as unknown[],
  write: vi.fn(),
  remove: vi.fn(),
  release: vi.fn(),
  scan: vi.fn(),
  recent: vi.fn(),
  session: vi.fn(),
  annotations: vi.fn(),
}));
vi.mock("@/core/Project", () => ({ Project: class {}, ProjectState: { Unsaved: "unsaved" } }));
vi.mock("./PdfAnnotationStore", () => ({
  moveDocumentAnnotations: mocks.annotations,
}));
vi.mock("./DocumentTab", () => ({ documentError: String }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { input: vi.fn() } }));
vi.mock("@/state", () => ({ tabsAtom: {}, store: { get: () => mocks.tabs, set: vi.fn() } }));
vi.mock("@/core/service/Settings", () => ({ Settings: { writeAiSidecarOnSave: false } }));
vi.mock("@/core/stage/stageObject/tools/entityDetailsManager", () => ({ DetailsManager: class {} }));
vi.mock("@/utils/platform", () => ({ family: () => "unix" }));
vi.mock("@/core/research/ResearchSession", () => ({
  persistResearchSession: vi.fn(),
  renameSessionWorkspace: mocks.session,
}));
vi.mock("@/core/service/dataFileService/RecentFileManager", () => ({
  RecentFileManager: { removeRecentFileByUri: vi.fn(), addRecentFileByUri: mocks.recent },
}));
vi.mock("@/core/ProjectOwnership", () => ({
  loadWithProjectOwnership: async (_path: string, load: (lease: unknown) => unknown) => ({
    status: "opened",
    value: await load({ dispose: mocks.release }),
  }),
}));
vi.mock("@/core/research/ResearchFolder", () => ({
  notifyResearchFilesChanged: vi.fn(),
  ResearchFolder: {
    ensureRootRegistered: vi.fn(),
    getRoot: () => "/research",
    isInside: (p: string) => p.startsWith("/research/"),
    toRelative: (p: string, base = "/research") => path.posix.relative(base, p),
    toAbsolute: (p: string, base = "/research") => path.posix.resolve(base, p),
    scan: mocks.scan,
  },
}));
vi.mock("@/core/fileSystemProvider/FileSystemProviderFile", () => ({
  FileSystemProviderFile: class {
    write(uri: URI, bytes: Uint8Array) {
      return mocks.write(uri.fsPath, bytes);
    }
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (p: string) => mocks.files.has(p),
  readFile: async (p: string) => {
    if (!mocks.files.has(p)) throw new Error("missing");
    return mocks.files.get(p)!;
  },
  stat: async () => ({ mode: 0o644 }),
  mkdir: vi.fn(),
  remove: mocks.remove,
  writeFile: async (p: string, bytes: Uint8Array, options: { createNew?: boolean }) => {
    if (options.createNew && mocks.files.has(p)) throw new Error("exists");
    mocks.files.set(p, bytes);
  },
}));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { Project } from "@/core/Project";
import { createDefaultMetadata } from "@/types/metadata";
import { renamedPath, renameResearchFile } from "./ResearchRename";

async function archive(source = "old.pdf") {
  const output = new Uint8ArrayWriter();
  const zip = new ZipWriter(output);
  await zip.add("stage.msgpack", new Uint8ArrayReader(encode([{ _: "FileCardNode", sourcePath: source }])));
  await zip.add(
    "metadata.msgpack",
    new Uint8ArrayReader(
      encode({
        ...createDefaultMetadata(),
        workbench: {
          id: "keep-chat-id",
          createdAt: 123,
          workspacePath: "a.prg",
        },
      }),
    ),
  );
  await zip.close();
  return output.getData();
}
async function entry(bytes: Uint8Array, name: string) {
  const zip = new ZipReader(new Uint8ArrayReader(bytes));
  const file = (await zip.getEntries()).find((file) => file.filename === name)!;
  if (file.directory) throw new Error("Expected a file entry");
  const result = decode(await file.getData!(new Uint8ArrayWriter()));
  await zip.close();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.tabs.length = 0;
  mocks.annotations.mockImplementation(async (_from: string, _to: string, operation: () => Promise<void>) =>
    operation(),
  );
  mocks.write.mockImplementation(async (p: string, bytes: Uint8Array) => {
    mocks.files.set(p, bytes);
  });
  mocks.remove.mockImplementation(async (p: string) => {
    mocks.files.delete(p);
  });
  mocks.scan.mockImplementation(async () => ({
    truncated: false,
    unreadableDirs: [],
    entries: [...mocks.files.keys()]
      .filter((p) => p.endsWith(".prg"))
      .map((absPath) => ({ kind: "workspace", absPath })),
  }));
});

describe("research rename transaction", () => {
  it("keeps both PDF copies for recovery when rolling annotations back fails", async () => {
    const pdf = new Uint8Array([1, 2, 3]);
    mocks.files.set("/research/old.pdf", pdf);
    mocks.annotations.mockRejectedValueOnce(new Error("annotationRollbackFailed"));
    await expect(renameResearchFile("/research/old.pdf", "new")).rejects.toThrow("annotationRollbackFailed");
    expect(mocks.files.get("/research/old.pdf")).toEqual(pdf);
    expect(mocks.files.get("/research/new.pdf")).toEqual(pdf);
  });

  it("rolls back reference rewrites and keeps the PDF when its annotation file conflicts", async () => {
    const board = await archive();
    mocks.files.set("/research/old.pdf", new Uint8Array([1, 2, 3]));
    mocks.files.set("/research/a.prg", board);
    mocks.annotations.mockRejectedValueOnce(new Error("annotationDestinationExists"));
    await expect(renameResearchFile("/research/old.pdf", "new")).rejects.toThrow("annotationDestinationExists");
    expect(mocks.annotations).toHaveBeenCalledWith("/research/old.pdf", "/research/new.pdf", expect.any(Function));
    expect(mocks.files.get("/research/old.pdf")).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.files.has("/research/new.pdf")).toBe(false);
    expect(mocks.files.get("/research/a.prg")).toEqual(board);
  });

  it("does not lock, rewrite or save open temporary workspaces when a referenced file is renamed", async () => {
    mocks.files.set("/research/old.pdf", new Uint8Array([1]));
    const card = { sourcePath: "/research/old.pdf" };
    const project = Object.assign(new Project(URI.file("/outside/a.prg")), {
      uri: URI.file("/outside/a.prg"),
      isSaving: true,
      stageManager: { getFileCardNodes: vi.fn(() => [card]) },
      historyManager: { rewriteSnapshots: vi.fn() },
      getFileContent: vi.fn(),
    });
    mocks.tabs.push(project);
    await renameResearchFile("/research/old.pdf", "new");
    expect(card.sourcePath).toBe("/research/old.pdf");
    expect(project.isSaving).toBe(true);
    expect(project.stageManager.getFileCardNodes).not.toHaveBeenCalled();
    expect(project.historyManager.rewriteSnapshots).not.toHaveBeenCalled();
    expect(project.getFileContent).not.toHaveBeenCalled();
  });
  it("preserves extensions and rejects path traversal", () => {
    expect(renamedPath("/research/a.pdf", "新名称")).toBe("/research/新名称.pdf");
    expect(() => renamedPath("/research/a.pdf", "../oops")).toThrow();
  });
  it("updates references in closed workspaces before removing the original PDF", async () => {
    const pdf = new Uint8Array([1, 2, 3]);
    mocks.files.set("/research/old.pdf", pdf);
    mocks.files.set("/research/a.prg", await archive());
    mocks.files.set("/research/notes/b.prg", await archive("../old.pdf"));
    await renameResearchFile("/research/old.pdf", "新文献");
    expect(mocks.files.has("/research/old.pdf")).toBe(false);
    expect(mocks.files.get("/research/新文献.pdf")).toEqual(pdf);
    expect(await entry(mocks.files.get("/research/a.prg")!, "stage.msgpack")).toEqual([
      { _: "FileCardNode", sourcePath: "新文献.pdf" },
    ]);
    expect(await entry(mocks.files.get("/research/notes/b.prg")!, "stage.msgpack")).toEqual([
      { _: "FileCardNode", sourcePath: "../新文献.pdf" },
    ]);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
  it("rejects an existing target without changing either file", async () => {
    mocks.files.set("/research/old.pdf", new Uint8Array([1]));
    mocks.files.set("/research/new.pdf", new Uint8Array([2]));
    await expect(renameResearchFile("/research/old.pdf", "new")).rejects.toThrow("exists");
    expect(mocks.files.get("/research/new.pdf")).toEqual(new Uint8Array([2]));
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rolls back every reference and keeps the original after a failed workspace write", async () => {
    const before = await archive();
    mocks.files.set("/research/old.pdf", new Uint8Array([1]));
    mocks.files.set("/research/a.prg", before);
    mocks.write.mockImplementationOnce(async (p: string) => {
      mocks.files.set(p, new Uint8Array([0]));
      throw new Error("disk full");
    });
    await expect(renameResearchFile("/research/old.pdf", "new")).rejects.toThrow("disk full");
    expect(mocks.files.has("/research/old.pdf")).toBe(true);
    expect(mocks.files.has("/research/new.pdf")).toBe(false);
    expect(mocks.files.get("/research/a.prg")).toEqual(before);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("preserves the open workspace chat identity and changes its URI and session", async () => {
    const before = await archive();
    mocks.files.set("/research/a.prg", before);
    const project = Object.assign(new Project(URI.file("/research/a.prg")), {
      uri: URI.file("/research/a.prg"),
      editRevision: 1,
      closing: false,
      isSaving: false,
      metadata: { workbench: { id: "keep-chat-id", workspacePath: "a.prg" } },
      getFileContent: async () => before,
      rebindRenamedFile: async (uri: URI, write: () => Promise<void>) => {
        await write();
        project.uri = uri;
      },
    });
    mocks.tabs.push(project);
    await renameResearchFile("/research/a.prg", "新的工作区");
    expect(project.uri.fsPath).toBe("/research/新的工作区.prg");
    expect(project.metadata.workbench.id).toBe("keep-chat-id");
    expect(project.isSaving).toBe(false);
    expect(await entry(mocks.files.get(project.uri.fsPath)!, "metadata.msgpack")).toMatchObject({
      workbench: { id: "keep-chat-id", workspacePath: "新的工作区.prg" },
    });
    expect(mocks.session).toHaveBeenCalledWith("/research/a.prg", project.uri.fsPath);
  });
  it("stops before creating files when scanning the research folder was incomplete", async () => {
    mocks.files.set("/research/old.pdf", new Uint8Array([1]));
    mocks.scan.mockResolvedValueOnce({ truncated: true, unreadableDirs: [], entries: [] });
    await expect(renameResearchFile("/research/old.pdf", "new")).rejects.toThrow("incompleteScan");
    expect(mocks.files.size).toBe(1);
  });
});
