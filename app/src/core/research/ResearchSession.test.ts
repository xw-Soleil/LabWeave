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
}));

vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn(), input: vi.fn() } }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/sub/FileManagerWindow", () => ({ default: { open: mocks.openFiles } }));
vi.mock("@/sub/AIWindow", () => ({ default: { open: mocks.openAI, toggle: vi.fn() } }));
vi.mock("@/core/research/ResearchFolder", () => ({
  RESEARCH_FILES_CHANGED_EVENT: "research:files-changed",
  ResearchFolder: {
    ensureRootRegistered: mocks.ensureRootRegistered,
    getRoot: () => mocks.settings.researchFolderPath,
    toRelative: (path: string) => path.slice(mocks.settings.researchFolderPath.length + 1),
    toAbsolute: (path: string) => (path.startsWith("/") ? path : `${mocks.settings.researchFolderPath}/${path}`),
    listFiles: vi.fn(async () => []),
  },
}));
vi.mock("@/core/Project", () => {
  class Project {
    readonly id = crypto.randomUUID();
    layout = "docked";
    closing = false;
    zIndex = 0;
    floatingRect = { clone: () => ({ width: 0, height: 0, left: 0, top: 0, location: { x: 0, y: 0 } }) };
    constructor(readonly uri: URI) {}
  }
  return { Project };
});
vi.mock("@/core/service/GlobalMenu", () => ({
  onOpenFile: mocks.onOpenFile,
  onNewDraft: mocks.onNewDraft,
  closeEmptyDrafts: vi.fn(),
}));

import { Project } from "@/core/Project";
import { TabWorkspace } from "@/core/TabWorkspace";
import {
  isTabVisibleInWorkspace,
  persistResearchSession,
  setResearchSessionTracking,
  startResearchSession,
} from "./ResearchSession";

function addProject(uri: URI) {
  const project = new (Project as unknown as new (uri: URI) => Project)(uri);
  TabWorkspace.open(project);
  return project;
}

describe("ResearchSession", () => {
  beforeEach(() => {
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
    expect(mocks.calls).toEqual(["draft", "panel:files"]);
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["a.prg", "notes/b.prg"]);
    expect(mocks.settings.researchSession.active).toBe("notes/b.prg");
  });

  it("keeps the saved workspaces when none of them can be found", async () => {
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

  it("keeps a draft and reports nothing restored for an empty session", async () => {
    const restored = await startResearchSession();

    expect(restored).toBe(false);
    expect(mocks.calls).toEqual(["draft", "panel:files"]);
  });

  it("tells the user when the research folder can't be granted", async () => {
    mocks.ensureRootRegistered.mockRejectedValue(new Error("unknown command"));

    await startResearchSession();

    expect(mocks.toastError).toHaveBeenCalledWith("shell.setRootFailed");
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
