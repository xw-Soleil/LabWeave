// @vitest-environment jsdom

import { activeResourceTabAtom, activeTabAtom, store, tabGroupRootAtom, tabsAtom } from "@/state";
import { URI } from "vscode-uri";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {
    maxFps: 60,
    maxFpsUnfocused: 60,
    researchFolderPath: "/research",
    researchSession: { openWorkspaces: [] as string[], active: "", panels: { files: true, ai: false } },
  },
  ensureRootRegistered: vi.fn(),
  exists: vi.fn(),
  onOpenFile: vi.fn(),
  onNewDraft: vi.fn(),
  openFiles: vi.fn(),
  openAI: vi.fn(),
  toastError: vi.fn(),
  calls: [] as string[],
  authorize: vi.fn(),
  setRoot: vi.fn(),
  remember: vi.fn(),
  buttons: vi.fn(),
  browse: vi.fn(),
}));

vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: mocks.buttons, input: vi.fn() } }));
vi.mock("./ResearchFolderBrowser", () => ({ browseResearchProject: mocks.browse }));
vi.mock("./ResearchWorkspace", () => ({
  authorizeResearchProject: mocks.authorize,
  projectPathKey: (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(),
  rememberProjectSession: mocks.remember,
  loadResearchWorkspace: vi.fn(async () => ({})),
  activeResearchWorkspace: () => ({
    projects: [{ path: "/next", session: { openWorkspaces: ["restored.prg"], active: "restored.prg" } }],
  }),
}));
vi.mock("./DocumentTab", () => ({
  DocumentTab: class DocumentTab {
    id = crypto.randomUUID();
    closing = false;
    beforeClose = vi.fn(async () => true);
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/sub/FileManagerWindow", () => ({ default: { open: mocks.openFiles } }));
vi.mock("@/sub/AIWindow", () => ({ default: { open: mocks.openAI, toggle: vi.fn() } }));
vi.mock("@/core/research/ResearchFolder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ResearchFolder")>();
  return {
    ...actual,
    ResearchFolder: {
      ...actual.ResearchFolder,
      ensureRootRegistered: mocks.ensureRootRegistered,
      setRoot: mocks.setRoot,
      listFiles: vi.fn(async () => []),
    },
  };
});
vi.mock("@/core/Project", () => {
  class Project {
    readonly id = crypto.randomUUID();
    layout = "docked";
    closing = false;
    zIndex = 0;
    projectState = "saved";
    isSaving = false;
    fileMutationInProgress = false;
    title = "board";
    save = vi.fn(async () => {
      this.projectState = "saved";
    });
    floatingRect = { clone: () => ({ width: 0, height: 0, left: 0, top: 0, location: { x: 0, y: 0 } }) };
    constructor(readonly uri: URI) {}
  }
  return { Project, ProjectState: { Unsaved: "unsaved", Saved: "saved", Stashed: "stashed" } };
});
vi.mock("@/core/service/GlobalMenu", () => ({
  onOpenFile: mocks.onOpenFile,
  onNewDraft: mocks.onNewDraft,
  closeEmptyDrafts: vi.fn(),
}));

import { Project, ProjectState } from "@/core/Project";
import { DocumentTab } from "./DocumentTab";
import { TabWorkspace } from "@/core/TabWorkspace";
import {
  isTabVisibleInWorkspace,
  listResearchWorkspaces,
  persistResearchSession,
  setResearchSessionTracking,
  startResearchSession,
  switchResearchProject,
  chooseResearchFolder,
} from "./ResearchSession";

function addProject(uri: URI) {
  const project = new (Project as unknown as new (uri: URI) => Project)(uri);
  TabWorkspace.open(project);
  return project;
}

describe("ResearchSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.calls.length = 0;
    store.set(tabsAtom, []);
    store.set(activeTabAtom, undefined);
    store.set(activeResourceTabAtom, undefined);
    store.set(tabGroupRootAtom, null);
    setResearchSessionTracking(false);
    mocks.settings.researchFolderPath = "/research";
    mocks.settings.researchSession = { openWorkspaces: [], active: "", panels: { files: true, ai: false } };
    mocks.ensureRootRegistered.mockResolvedValue(undefined);
    mocks.exists.mockImplementation(async (path: string) => !path.includes("missing"));
    mocks.onOpenFile.mockImplementation(async (uri: URI) => {
      mocks.calls.push(`open:${uri.fsPath}`);
      return addProject(uri);
    });
    mocks.onNewDraft.mockImplementation(async () => {
      mocks.calls.push("draft");
      addProject(URI.parse("draft:1"));
    });
    mocks.openFiles.mockImplementation(() => mocks.calls.push("panel:files"));
    mocks.openAI.mockImplementation(() => mocks.calls.push("panel:ai"));
    mocks.authorize.mockImplementation(async (path) => path);
    mocks.remember.mockResolvedValue(undefined);
    mocks.setRoot.mockImplementation(async (path) => {
      mocks.settings.researchFolderPath = path;
      return path;
    });
  });

  it("does not overwrite the saved session before tracking starts", () => {
    addProject(URI.file("/research/a.prg"));
    persistResearchSession();
    expect(mocks.settings.researchSession.openWorkspaces).toEqual([]);
  });

  it("records open file workspaces relative to the research folder", () => {
    setResearchSessionTracking(true);
    addProject(URI.parse("draft:1"));
    addProject(URI.file("/research/notes/a.prg"));
    const active = addProject(URI.file("/research/b.prg"));
    TabWorkspace.focus(active.id);

    persistResearchSession();

    expect(mocks.settings.researchSession).toEqual({
      openWorkspaces: ["notes/a.prg", "b.prg"],
      active: "b.prg",
      panels: { files: false, ai: false },
    });
  });

  it("omits temporary boards from session records and workspace lists, including the active board", async () => {
    setResearchSessionTracking(true);
    addProject(URI.file("/research/a.prg"));
    const temporary = addProject(URI.file("/outside/b.prg"));
    TabWorkspace.focus(temporary.id);
    persistResearchSession();
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["a.prg"]);
    expect(mocks.settings.researchSession.active).toBe("");
    expect((await listResearchWorkspaces()).map((item) => item.absPath)).toEqual(["/research/a.prg"]);

    mocks.settings.researchFolderPath = "/outside";
    persistResearchSession();
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["b.prg"]);
    expect(mocks.settings.researchSession.active).toBe("b.prg");
  });

  it("discards old outside-session paths before touching disk, even when the root is unavailable", async () => {
    mocks.ensureRootRegistered.mockRejectedValue(new Error("unplugged"));
    mocks.exists.mockResolvedValue(false);
    mocks.settings.researchSession = {
      openWorkspaces: ["/outside/a.prg", "../outside/b.prg", "inside.prg"],
      active: "/outside/a.prg",
      panels: { files: false, ai: false },
    };
    await startResearchSession();
    expect(mocks.exists).toHaveBeenCalledExactlyOnceWith("/research/inside.prg");
    expect(mocks.onOpenFile).not.toHaveBeenCalled();
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["inside.prg"]);
    expect(mocks.settings.researchSession.active).toBe("");
  });

  it("keeps an OS-preopened temporary board active without recording it for next startup", async () => {
    const temporary = addProject(URI.file("/outside/a.prg"));
    expect(await startResearchSession()).toBe(true);
    expect(store.get(activeResourceTabAtom)).toBe(temporary);
    expect(mocks.settings.researchSession.openWorkspaces).toEqual([]);
    expect(mocks.settings.researchSession.active).toBe("");
  });

  it("reopens existing workspaces before opening panels and focuses the active one", async () => {
    mocks.settings.researchSession = {
      openWorkspaces: ["a.prg", "missing.prg", "b.prg"],
      active: "a.prg",
      panels: { files: true, ai: true },
    };

    const restored = await startResearchSession();

    expect(restored).toBe(true);
    expect(mocks.ensureRootRegistered).toHaveBeenCalledOnce();
    expect(mocks.calls).toEqual(["open:/research/a.prg", "open:/research/b.prg", "panel:files", "panel:ai"]);
    expect((store.get(activeTabAtom) as Project | undefined)?.uri.fsPath).toBe("/research/a.prg");
    // 别的都在、只缺一个，说明它真被删了，从会话里去掉
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["a.prg", "b.prg"]);
  });

  it("keeps the saved workspaces when the research folder can't be reached at startup", async () => {
    mocks.ensureRootRegistered.mockRejectedValue(new Error("No such file or directory"));
    mocks.exists.mockResolvedValue(false);
    mocks.settings.researchSession = {
      openWorkspaces: ["a.prg", "notes/b.prg"],
      active: "notes/b.prg",
      panels: { files: true, ai: false },
    };

    const restored = await startResearchSession();

    expect(restored).toBe(false);
    expect(mocks.calls).toEqual(["panel:files"]);
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["a.prg", "notes/b.prg"]);
    expect(mocks.settings.researchSession.active).toBe("notes/b.prg");
  });

  it("keeps the saved workspaces when none of them can be found", async () => {
    mocks.settings.researchFolderPath = "";
    mocks.exists.mockResolvedValue(false);
    mocks.settings.researchSession = {
      openWorkspaces: ["/Volumes/usb/a.prg"],
      active: "/Volumes/usb/a.prg",
      panels: { files: true, ai: false },
    };

    await startResearchSession();

    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["/Volumes/usb/a.prg"]);
    expect(mocks.settings.researchSession.active).toBe("/Volumes/usb/a.prg");
  });

  it("drops a kept workspace once it has been opened and closed again", async () => {
    mocks.ensureRootRegistered.mockRejectedValue(new Error("No such file or directory"));
    mocks.exists.mockResolvedValue(false);
    mocks.settings.researchSession = {
      openWorkspaces: ["a.prg", "b.prg"],
      active: "a.prg",
      panels: { files: true, ai: false },
    };
    await startResearchSession();

    const reopened = addProject(URI.file("/research/a.prg"));
    persistResearchSession();
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["a.prg", "b.prg"]);
    expect(mocks.settings.researchSession.active).toBe("a.prg");

    reopened.closing = true;
    persistResearchSession();
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["b.prg"]);
    expect(mocks.settings.researchSession.active).toBe("");
  });

  it("does not manufacture a draft for an empty session", async () => {
    const restored = await startResearchSession();

    expect(restored).toBe(false);
    expect(mocks.calls).toEqual(["panel:files"]);
    expect(mocks.onNewDraft).not.toHaveBeenCalled();
  });

  it("tells the user when the research folder can't be granted", async () => {
    mocks.ensureRootRegistered.mockRejectedValue(new Error("unknown command"));

    await startResearchSession();

    expect(mocks.toastError).toHaveBeenCalledWith("shell.setRootFailed");
  });

  it("switches before opening another project's board, remembers the old session and restores the destination", async () => {
    setResearchSessionTracking(true);
    const board = addProject(URI.file("/research/old.prg"));
    board.projectState = ProjectState.Unsaved;
    mocks.buttons.mockResolvedValue("save");
    const close = vi.spyOn(TabWorkspace, "close").mockImplementation(async (id) => {
      store.set(
        tabsAtom,
        store.get(tabsAtom).filter((tab) => tab.id !== id),
      );
    });
    mocks.onOpenFile.mockImplementation(async (uri: URI) => {
      expect(mocks.settings.researchFolderPath).toBe("/next");
      return addProject(uri);
    });
    expect(await switchResearchProject("/next", "/next/deep/new.prg")).toBe(true);
    expect(board.save).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(board.id);
    expect(mocks.remember).toHaveBeenCalledWith("/research");
    expect(mocks.onOpenFile.mock.calls.map(([uri]) => uri.fsPath)).toEqual([
      "/next/restored.prg",
      "/next/deep/new.prg",
    ]);
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["restored.prg", "deep/new.prg"]);
  });

  it("keeps the current root and stops opening when a board prompt is cancelled or saving leaves edits", async () => {
    const board = addProject(URI.file("/research/a.prg"));
    board.projectState = ProjectState.Unsaved;
    mocks.buttons.mockResolvedValueOnce("cancel").mockResolvedValueOnce("save");
    vi.mocked(board.save).mockResolvedValue(undefined);
    expect(await switchResearchProject("/next", "/next/a.prg")).toBe(false);
    expect(await switchResearchProject("/next")).toBe(false);
    expect(mocks.setRoot).not.toHaveBeenCalled();
    expect(mocks.onOpenFile).not.toHaveBeenCalled();
    expect(board.closing).toBe(false);
  });

  it("remembers the file path assigned to a draft by the switch-time save prompt", async () => {
    const board = addProject(URI.parse("draft:new"));
    board.projectState = ProjectState.Unsaved;
    mocks.buttons.mockResolvedValue("save");
    vi.mocked(board.save).mockImplementation(async () => {
      Object.defineProperty(board, "uri", { value: URI.file("/research/new.prg") });
      board.projectState = ProjectState.Saved;
    });
    vi.spyOn(TabWorkspace, "close").mockImplementation(async (id) => {
      store.set(
        tabsAtom,
        store.get(tabsAtom).filter((tab) => tab.id !== id),
      );
    });
    expect(await switchResearchProject("/next")).toBe(true);
    expect(mocks.remember).toHaveBeenLastCalledWith("/research", { openWorkspaces: ["new.prg"], active: "new.prg" });
  });

  it("honors Markdown close cancellation and stops on save or close errors", async () => {
    const document = new DocumentTab("/research/a.md", "markdown");
    store.set(tabsAtom, [document]);
    vi.spyOn(TabWorkspace, "close").mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("save conflict"));
    expect(await switchResearchProject("/next")).toBe(false);
    await expect(switchResearchProject("/next")).rejects.toThrow("save conflict");
    expect(mocks.setRoot).not.toHaveBeenCalled();
  });

  it("checks missing and unselected projects before closing anything, and rejects an escaped board path", async () => {
    const close = vi.spyOn(TabWorkspace, "close");
    addProject(URI.file("/research/a.prg"));
    await expect(switchResearchProject("/missing")).rejects.toThrow("projectTree.missing");
    mocks.authorize.mockRejectedValueOnce(new Error("unselected"));
    await expect(switchResearchProject("/unselected")).rejects.toThrow("unselected");
    await expect(switchResearchProject("/next", "/next/../escape.prg")).rejects.toThrow("files.outsideFolder");
    expect(close).not.toHaveBeenCalled();
    expect(mocks.setRoot).not.toHaveBeenCalled();
  });

  it("serializes switching and uses the in-app browser for the existing choose-folder entry", async () => {
    let finish!: (path: string) => void;
    mocks.browse.mockResolvedValue("/next");
    mocks.authorize.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const choosing = chooseResearchFolder();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(switchResearchProject("/other")).rejects.toThrow("projectTree.switchBusy");
    finish("/next");
    expect(await choosing).toBe("/next");
    expect(mocks.browse).toHaveBeenCalledOnce();
  });
});

describe("isTabVisibleInWorkspace", () => {
  beforeEach(() => {
    store.set(tabsAtom, []);
    store.set(activeTabAtom, undefined);
    store.set(activeResourceTabAtom, undefined);
    store.set(tabGroupRootAtom, null);
  });

  it("treats the shown tab of its group as visible even when keyboard focus is elsewhere", () => {
    const hidden = addProject(URI.file("/research/a.prg"));
    const shown = addProject(URI.file("/research/b.prg"));
    TabWorkspace.focus(shown.id);
    store.set(activeTabAtom, undefined);

    expect(isTabVisibleInWorkspace(shown.id)).toBe(true);
    expect(isTabVisibleInWorkspace(hidden.id)).toBe(false);

    TabWorkspace.focus(hidden.id);
    expect(isTabVisibleInWorkspace(hidden.id)).toBe(true);
    expect(isTabVisibleInWorkspace(shown.id)).toBe(false);
  });

  it("treats floating tabs as visible and closing or unknown tabs as hidden", () => {
    const floating = new (Project as unknown as new (uri: URI) => Project)(URI.file("/research/f.prg"));
    floating.layout = "floating";
    TabWorkspace.open(floating);

    expect(isTabVisibleInWorkspace(floating.id)).toBe(true);
    floating.closing = true;
    expect(isTabVisibleInWorkspace(floating.id)).toBe(false);
    expect(isTabVisibleInWorkspace("missing")).toBe(false);
  });
});
