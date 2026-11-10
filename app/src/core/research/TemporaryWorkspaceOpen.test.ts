import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";
import YAML from "yaml";
import i18next from "i18next";
import { Vector } from "@graphif/data-structures";

const mocks = vi.hoisted(() => ({
  settings: { researchFolderPath: "/research", autoImportTxtFileWhenOpenPrg: true },
  open: vi.fn(),
  invoke: vi.fn(),
  create: vi.fn(),
  exists: vi.fn(async () => true),
  read: vi.fn(),
  write: vi.fn(),
  error: vi.fn(),
  recent: new Map<string, unknown>(),
  projectForFile: vi.fn(),
  switchProject: vi.fn(),
}));
vi.mock("./ResearchWorkspace", () => ({ projectForFile: mocks.projectForFile }));
vi.mock("./ResearchSession", () => ({ switchResearchProject: mocks.switchProject }));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: {} }));
vi.mock("@/components/global-menu-content", () => ({ default: () => null }));
vi.mock("@/sub/CollaborationWindow", () => ({ default: {} }));
vi.mock("@/core/extension/Extension", () => ({ Extension: class {} }));
vi.mock("@/core/loadAllServices", () => ({ loadAllServicesBeforeInit: vi.fn(), loadAllServicesAfterInit: vi.fn() }));
vi.mock("@/core/research/FileCardFactory", () => ({
  createFileCards: vi.fn(),
  listFailureLines: vi.fn(),
  listFileNames: vi.fn(),
  markFileCardsPending: vi.fn(),
}));
vi.mock("@/core/Project", () => ({
  ProjectState: { Saved: "saved" },
  Project: class {
    projectState = "saved";
    stage = [];
    attachments = new Map();
    fs = {};
    init = vi.fn();
    dispose = vi.fn();
    loop = vi.fn();
    activateOpenRuntimeHost = vi.fn();
    constructor(public uri: URI) {}
  },
}));
vi.mock("@/core/ProjectOwnership", () => ({
  ProjectOwnershipError: class extends Error {},
  loadWithProjectOwnership: async (_path: string, load: () => Promise<unknown>) => ({
    status: "opened",
    value: await load(),
  }),
}));
vi.mock("@/core/TabFactory", () => ({ TabFactory: { create: mocks.create } }));
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: { focus: vi.fn() } }));
vi.mock("@/core/fileSystemProvider/FileSystemProviderFile", () => ({ FileSystemProviderFile: class {} }));
vi.mock("@/core/fileSystemProvider/FileSystemProviderDraft", () => ({ FileSystemProviderDraft: class {} }));
vi.mock("@/core/stage/ProjectUpgrader", () => ({ ProjectUpgrader: {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class {} }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/core/service/FeatureFlags", () => ({ FeatureFlags: {} }));
vi.mock("@/utils/readPrgThumbnail", () => ({ ensurePrgThumbnailCached: vi.fn() }));
vi.mock("@/utils/platform", () => ({ isMac: false, family: () => "unix" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists, readFile: mocks.read, writeFile: mocks.write }));
vi.mock("@/utils/store", () => ({
  createStore: async () => ({
    get: (key: string) => mocks.recent.get(key),
    set: (key: string, value: unknown) => mocks.recent.set(key, value),
    save: vi.fn(),
  }),
}));
vi.mock("@/state", async () => {
  const { atom, createStore } = await import("jotai");
  return {
    store: createStore(),
    tabsAtom: atom([]),
    activeTabAtom: atom(undefined),
    activeResourceTabAtom: atom(undefined),
    tabGroupRootAtom: atom(null),
  };
});
vi.mock("sonner", () => ({
  toast: {
    error: mocks.error,
    promise: (run: () => Promise<unknown>, options: { success: () => Promise<unknown> }) => ({
      unwrap: async () => {
        await run();
        await options.success();
      },
    }),
  },
}));

import { Project } from "@/core/Project";
import { store, tabsAtom } from "@/state";
import { ResearchFolder } from "./ResearchFolder";
import { pasteClipboardFiles } from "./ResearchDrop";
import { isRecentFileVisible } from "./ResearchMenu";
import { onOpenFile, onUpgradeOldJson } from "@/core/service/GlobalMenu";
import { handleDeepLink } from "@/core/service/dataFileService/DeepLinkHandler";
import { RecentFileManager } from "@/core/service/dataFileService/RecentFileManager";

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.settings.researchFolderPath = "/research";
  store.set(tabsAtom, []);
  mocks.recent.clear();
  mocks.projectForFile.mockResolvedValue(undefined);
  mocks.create.mockImplementation(async (uri: URI) => new Project(uri));
  vi.spyOn(ResearchFolder, "ensureRootRegistered").mockResolvedValue();
  await RecentFileManager.init();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("workspace open entry points", () => {
  it("preloads a destination without exposing a tab, recent-file writes or deferred TXT imports", async () => {
    expect(
      await onOpenFile(URI.file("/research/target.prg"), "switch", undefined, {
        recordRecent: false,
        deferActivation: true,
      }),
    ).toBeInstanceOf(Project);
    expect(store.get(tabsAtom)).toEqual([]);
    await vi.runAllTimersAsync();
    expect(await RecentFileManager.getRecentFiles()).toEqual([]);
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("removes a failed opening from the tab list before disposing it", async () => {
    const project = new Project(URI.file("/research/target.prg"));
    mocks.create.mockResolvedValueOnce(project);
    vi.spyOn(RecentFileManager, "addRecentFileByUri").mockRejectedValueOnce(new Error("disk full"));
    await expect(onOpenFile(project.uri)).rejects.toThrow("disk full");
    expect(store.get(tabsAtom)).not.toContain(project);
    expect(project.dispose).toHaveBeenCalledOnce();
  });

  it.each([undefined, "file-drop", "file-paste", "os-file"] as const)(
    "switches before opening another listed project's board from %s",
    async (origin) => {
      const uri = URI.file("/other/a.prg");
      mocks.projectForFile.mockResolvedValue("/other");
      mocks.switchProject.mockImplementation(async () => {
        mocks.settings.researchFolderPath = "/other";
        const board = new Project(uri);
        store.set(tabsAtom, [board]);
        return true;
      });
      expect((await onOpenFile(uri, "test", origin))?.uri).toEqual(uri);
      expect(mocks.switchProject).toHaveBeenCalledWith("/other", "/other/a.prg");
      expect(mocks.create).not.toHaveBeenCalled();
      mocks.switchProject.mockResolvedValueOnce(false);
      mocks.settings.researchFolderPath = "/research";
      expect(await onOpenFile(uri, "test", origin)).toBeUndefined();
    },
  );
  it("opens an outside file selected in the dialog without importing or clearing its sibling TXT", async () => {
    mocks.open.mockResolvedValueOnce("/outside/a.prg");
    const project = await onOpenFile();
    expect(project?.uri.fsPath).toBe("/outside/a.prg");
    expect(mocks.create).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await RecentFileManager.getRecentFiles()).toEqual([]);
  });

  it.each(["file-drop", "os-file"] as const)("opens outside files with the explicit %s origin", async (origin) => {
    expect(await onOpenFile(URI.file("/outside/a.prg"), "test", origin)).toBeInstanceOf(Project);
  });

  it("opens an outside workspace copied in Finder through the real paste and open entry points", async () => {
    const outside = URI.file("/outside/pasted.prg");
    mocks.invoke.mockResolvedValueOnce([outside.fsPath]);
    const target = new Project(URI.file("/research/target.prg"));

    expect(await pasteClipboardFiles(target, Vector.getZero())).toBe(true);

    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("read_clipboard_file_paths");
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(store.get(tabsAtom).map((tab) => (tab as Project).uri.fsPath)).toEqual([outside.fsPath]);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(await RecentFileManager.getRecentFiles()).toEqual([]);
  });

  it("refuses unspecified origins, including requests to reuse an already open temporary tab", async () => {
    const uri = URI.file("/outside/a.prg");
    expect(await onOpenFile(uri)).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
    const project = await onOpenFile(uri, "test", "os-file");
    expect(store.get(tabsAtom)).toContain(project);
    expect(await onOpenFile(uri, "DeepLink")).toBeUndefined();
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it.each(["zh_CN", "en"])("rejects deep links and old JSON upgrades with unescaped paths in %s", async (language) => {
    const locale = YAML.parse(readFileSync(new URL(`../../locales/${language}.yml`, import.meta.url), "utf8"));
    await i18next.init({ lng: language, resources: { [language]: { research: locale.research } } });
    const path = `/outside/${language}/A&B <paper>.prg`;
    await handleDeepLink([`rwb://open?path=${encodeURIComponent(path)}`]);
    expect(mocks.error.mock.calls.at(-1)?.[0]).toContain(path);
    expect(mocks.error.mock.calls.at(-1)?.[0]).not.toContain("&#");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.exists).not.toHaveBeenCalled();

    mocks.open.mockResolvedValueOnce(path.replace(".prg", ".json"));
    await onUpgradeOldJson();
    expect(mocks.error.mock.calls.at(-1)?.[0]).toContain(path.replace(".prg", ".json"));
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("skips new temporary recent files on writes while returning all existing records", async () => {
    const outside = URI.file("/outside/a.prg");
    const existing = URI.file("/previous-folder/old.prg");
    const inside = URI.file("/research/a.prg");
    const previous = { uri: existing.toString(), time: 1 };
    mocks.recent.set("recentFiles", [previous]);
    expect((await RecentFileManager.getRecentFiles()).map((file) => file.uri.toString())).toEqual([
      existing.toString(),
    ]);
    await RecentFileManager.addRecentFileByUri(outside);
    expect(mocks.recent.get("recentFiles")).toEqual([previous]);
    await RecentFileManager.addRecentFilesByUris([outside, inside]);
    expect(mocks.recent.get("recentFiles")).toEqual([previous, { uri: inside.toString(), time: expect.any(Number) }]);
    mocks.settings.researchFolderPath = "";
    await RecentFileManager.addRecentFileByUri(outside);
    expect((await RecentFileManager.getRecentFiles()).map((file) => file.uri.toString())).toContain(outside.toString());
  });

  it.each(["single", "bulk"])("preserves folder A history when adding folder B files via %s writes", async (method) => {
    const a = URI.file("/folder-a/a.prg");
    const b = URI.file("/folder-b/b.prg");
    mocks.settings.researchFolderPath = "/folder-a";
    await RecentFileManager.addRecentFile({ uri: a, time: 1 });

    mocks.settings.researchFolderPath = "/folder-b";
    if (method === "single") await RecentFileManager.addRecentFileByUri(b);
    else await RecentFileManager.addRecentFilesByUris([b]);
    await RecentFileManager.sortTimeRecentFiles();

    expect(mocks.recent.get("recentFiles")).toEqual([
      { uri: b.toString(), time: expect.any(Number) },
      { uri: a.toString(), time: 1 },
    ]);
    const records = await RecentFileManager.getRecentFiles();
    expect(records).toHaveLength(2);
    expect(records.filter((file) => isRecentFileVisible(file.uri)).map((file) => file.uri.toString())).toEqual([
      b.toString(),
    ]);
    mocks.settings.researchFolderPath = "/folder-a";
    expect(records.filter((file) => isRecentFileVisible(file.uri)).map((file) => file.uri.toString())).toEqual([
      a.toString(),
    ]);
  });
});
