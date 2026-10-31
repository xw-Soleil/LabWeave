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
import { persistResearchSession, setResearchSessionTracking, startResearchSession } from "./ResearchSession";

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
