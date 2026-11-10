import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { URI } from "vscode-uri";

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  tabs: [] as unknown[],
  move: vi.fn(),
  close: vi.fn(),
  release: vi.fn(),
  confirm: vi.fn(),
  notify: vi.fn(),
  annotations: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { confirm: mocks.confirm } }));
vi.mock("@/core/Project", () => ({ Project: class {}, ProjectState: { Saved: "saved", Unsaved: "unsaved" } }));
vi.mock("./PdfAnnotationStore", () => ({
  moveDocumentAnnotations: mocks.annotations,
}));
vi.mock("./DocumentTab", () => ({ documentError: String }));
vi.mock("@/state", () => ({ tabsAtom: {}, store: { get: () => mocks.tabs } }));
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: { close: mocks.close } }));
vi.mock("@/core/ProjectOwnership", () => ({
  loadWithProjectOwnership: async (_path: string, action: (lease: unknown) => unknown) => ({
    status: "opened",
    value: await action({ dispose: mocks.release }),
  }),
}));
vi.mock("@/core/service/dataFileService/RecentFileManager", () => ({
  RecentFileManager: { removeRecentFileByUri: vi.fn() },
}));
vi.mock("./ResearchSession", () => ({ persistResearchSession: vi.fn() }));
vi.mock("./FileCardFactory", () => ({
  resolveSourcePath: (_project: unknown, source: string) => path.posix.resolve("/research", source),
}));
vi.mock("./ResearchFolder", () => ({
  notifyResearchFilesChanged: mocks.notify,
  ResearchFolder: {
    getRoot: () => "/research",
    ensureRootRegistered: vi.fn(),
    isInside: (p: string) => p.startsWith("/research/"),
    toRelative: (p: string) => path.posix.relative("/research", p),
    toAbsolute: (p: string) => path.posix.resolve("/research", p),
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (p: string) => mocks.files.has(p) || [...mocks.files.keys()].some((name) => name.startsWith(p + "/")),
  mkdir: vi.fn(),
  rename: mocks.move,
  readFile: async (p: string) => {
    if (!mocks.files.has(p)) throw new Error("missing");
    return mocks.files.get(p)!;
  },
  readTextFile: async (p: string) => new TextDecoder().decode(mocks.files.get(p)),
  writeFile: async (p: string, data: Uint8Array, options: { createNew?: boolean }) => {
    if (options.createNew && mocks.files.has(p)) throw new Error("exists");
    mocks.files.set(p, data);
  },
  remove: mocks.remove,
  readDir: async (root: string) =>
    [
      ...new Set(
        [...mocks.files.keys()]
          .filter((p) => p.startsWith(root + "/"))
          .map((p) => p.slice(root.length + 1).split("/")[0]),
      ),
    ].map((name) => ({ name, isDirectory: true, isSymlink: false })),
}));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { Project, ProjectState } from "@/core/Project";
import {
  trashResearchFile,
  restoreResearchFile,
  restoreLastResearchFile,
  promptTrashResearchFile,
} from "./ResearchTrash";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.tabs.length = 0;
  mocks.annotations.mockImplementation(async (_from: string, _to: string, operation: () => Promise<void>) =>
    operation(),
  );
  mocks.files.set("/research/paper.pdf", new Uint8Array([0, 255, 17]));
  mocks.remove.mockImplementation(async (p: string) => {
    mocks.files.delete(p);
  });
  mocks.close.mockImplementation(async (id: string) => {
    const index = mocks.tabs.findIndex((tab) => (tab as Project).id === id);
    if (index >= 0) mocks.tabs.splice(index, 1);
  });
  mocks.move.mockImplementation(async (from: string, to: string) => {
    if (!mocks.files.has(from)) throw new Error("missing");
    mocks.files.set(to, mocks.files.get(from)!);
    mocks.files.delete(from);
  });
});

describe("recoverable file deletion", () => {
  it("removes the restored PDF copy if deleting its trash payload fails, so restore can be retried", async () => {
    const record = await trashResearchFile("/research/paper.pdf");
    mocks.remove.mockRejectedValueOnce(new Error("payload is locked"));
    await expect(restoreResearchFile(record)).rejects.toThrow("payload is locked");
    expect(mocks.files.has("/research/paper.pdf")).toBe(false);
    expect(mocks.files.has(`${record.directory}/paper.pdf`)).toBe(true);
    await expect(restoreResearchFile(record)).resolves.toBe("/research/paper.pdf");
  });
  it("routes the same annotation entry through trash and restore, and refuses a conflicting sidecar", async () => {
    const record = await trashResearchFile("/research/paper.pdf");
    const entryId = record.directory.split("/").at(-1);
    expect(mocks.annotations).toHaveBeenLastCalledWith(
      "/research/paper.pdf",
      `${record.directory}/paper.pdf`,
      expect.any(Function),
      { entryId },
    );
    mocks.annotations.mockRejectedValueOnce(new Error("annotationDestinationExists"));
    await expect(restoreResearchFile(record)).rejects.toThrow("annotationDestinationExists");
    expect(mocks.files.has("/research/paper.pdf")).toBe(false);
    expect(mocks.files.get(`${record.directory}/paper.pdf`)).toEqual(new Uint8Array([0, 255, 17]));
    expect(mocks.annotations).toHaveBeenLastCalledWith(
      `${record.directory}/paper.pdf`,
      "/research/paper.pdf",
      expect.any(Function),
      { entryId, restoring: true },
    );
  });

  it("moves the source file and restores the exact bytes using the persisted recovery record", async () => {
    const original = mocks.files.get("/research/paper.pdf");
    await trashResearchFile("/research/paper.pdf");
    expect(mocks.files.has("/research/paper.pdf")).toBe(false);
    await expect(restoreLastResearchFile()).resolves.toBe("/research/paper.pdf");
    expect(mocks.files.get("/research/paper.pdf")).toEqual(original);
    await expect(restoreLastResearchFile()).rejects.toThrow("trashEmpty");
  });
  it("never overwrites a new file occupying the original path", async () => {
    const record = await trashResearchFile("/research/paper.pdf");
    mocks.files.set("/research/paper.pdf", new Uint8Array([99]));
    await expect(restoreResearchFile(record)).rejects.toThrow("restoreConflict");
    expect(mocks.files.get("/research/paper.pdf")).toEqual(new Uint8Array([99]));
    expect(mocks.files.get(`${record.directory}/paper.pdf`)).toEqual(new Uint8Array([0, 255, 17]));
  });
  it("keeps the original when the move fails", async () => {
    mocks.move.mockRejectedValueOnce(new Error("permission denied"));
    await expect(trashResearchFile("/research/paper.pdf")).rejects.toThrow("permission denied");
    expect(mocks.files.get("/research/paper.pdf")).toEqual(new Uint8Array([0, 255, 17]));
  });
  it("saves an open workspace before closing and deleting it", async () => {
    mocks.files.set("/research/a.prg", new Uint8Array([1]));
    const project = Object.assign(new Project(URI.file("/research/a.prg")), {
      uri: URI.file("/research/a.prg"),
      id: "a",
      projectState: ProjectState.Unsaved,
      save: vi.fn(async () => {
        mocks.files.set("/research/a.prg", new Uint8Array([2]));
        project.projectState = ProjectState.Saved;
      }),
    });
    mocks.tabs.push(project);
    const record = await trashResearchFile("/research/a.prg");
    expect(mocks.close).toHaveBeenCalledWith("a");
    expect(project.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
    expect(mocks.files.get(`${record.directory}/a.prg`)).toEqual(new Uint8Array([2]));
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("does not close or move a workspace if saving fails", async () => {
    const project = Object.assign(new Project(URI.file("/research/a.prg")), {
      uri: URI.file("/research/a.prg"),
      save: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    mocks.tabs.push(project);
    await expect(trashResearchFile("/research/a.prg")).rejects.toThrow("disk full");
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
  });
  it("does nothing when the deletion dialog is cancelled", async () => {
    mocks.confirm.mockResolvedValue(false);
    await promptTrashResearchFile("/research/paper.pdf");
    expect(mocks.move).not.toHaveBeenCalled();
  });
  it("updates cards in other open workspaces after deleting and restoring a referenced file", async () => {
    const card = { sourcePath: "paper.pdf", missing: false, missingCheckedAt: 123 };
    mocks.tabs.push(
      Object.assign(new Project(URI.file("/research/a.prg")), {
        uri: URI.file("/research/a.prg"),
        stageManager: { getFileCardNodes: () => [card] },
      }),
    );
    const record = await trashResearchFile("/research/paper.pdf");
    expect(card.missing).toBe(true);
    await restoreResearchFile(record);
    expect(card.missing).toBe(false);
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });
});
