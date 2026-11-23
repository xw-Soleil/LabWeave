// @vitest-environment jsdom
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { URI } from "vscode-uri";

const mocks = vi.hoisted(() => ({
  settings: {
    maxFps: 60,
    maxFpsUnfocused: 60,
    autoSave: true,
    autoSaveWhenClose: false,
    researchFolderPath: "/research",
    researchSession: { openWorkspaces: [] as string[], active: "", panels: { files: false, ai: false } },
  },
  buttons: vi.fn(),
  toastError: vi.fn(),
  events: [] as string[],
  flushSettings: vi.fn(async () => {
    mocks.events.push("flushSettings");
  }),
  flushActivity: vi.fn(async () => {
    mocks.events.push("flushActivity");
  }),
  finishSnapshots: vi.fn(async () => {
    mocks.events.push("finishSnapshots");
  }),
  flushNodeRecords: vi.fn(async () => {
    mocks.events.push("flushNodeRecords");
  }),
  flushWorkspace: vi.fn(async () => {
    mocks.events.push("flushWorkspace");
  }),
}));

vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: mocks.buttons } }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings, flushSettings: mocks.flushSettings }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: mocks.toastError }) }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("./ActivityLog", () => ({ flushActivityLog: mocks.flushActivity }));
vi.mock("./Snapshot", () => ({ finishPendingSnapshots: mocks.finishSnapshots }));
vi.mock("./NodeRecord", () => ({ flushNodeRecordWrites: mocks.flushNodeRecords }));
vi.mock("./ResearchWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ResearchWorkspace")>()),
  flushResearchWorkspace: mocks.flushWorkspace,
}));
vi.mock("@/sub/FileManagerWindow", () => ({ default: { open: vi.fn() }, pickResearchProject: vi.fn() }));
vi.mock("@/sub/AIWindow", () => ({ default: { open: vi.fn(), toggle: vi.fn() } }));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: vi.fn(), closeEmptyDrafts: vi.fn() }));
vi.mock("@/core/Project", () => {
  const ProjectState = { Saved: "saved", Stashed: "stashed", Unsaved: "unsaved" };
  class Project {
    readonly id = crypto.randomUUID();
    layout: "docked" | "floating" = "docked";
    floatingRect = new Rectangle(Vector.getZero(), Vector.same(100));
    zIndex = 0;
    closing = false;
    canDock = true;
    closable = true;
    closeOnEscape = true;
    closeWhenClickOutside = false;
    closeWhenClickInside = false;
    titleBarOverlay = false;
    projectState = ProjectState.Saved;
    isSaving = false;
    fileMutationInProgress = false;
    editRevision = 0;
    title: string;
    autoSaveIdle = vi.fn(async () => {});
    save = vi.fn(async () => {
      this.projectState = ProjectState.Saved;
      mocks.events.push(`save:${this.title}`);
    });
    dispose = vi.fn(async () => {
      mocks.events.push(`dispose:${this.title}`);
    });
    pause = vi.fn();
    get isDraft() {
      return this.uri.scheme === "draft";
    }
    getService(id: string) {
      return id === "autoSaveBackup" ? { waitForIdle: this.autoSaveIdle } : undefined;
    }
    constructor(readonly uri: URI) {
      this.title = uri.path.split("/").pop() ?? uri.toString();
    }
  }
  return { Project, ProjectState };
});

import { Project, ProjectState } from "@/core/Project";
import { Tab } from "@/core/Tab";
import { TabWorkspace } from "@/core/TabWorkspace";
import {
  activeDockedTabAtom,
  activeGroupIdAtom,
  activeResourceTabAtom,
  activeTabAtom,
  store,
  tabGroupRootAtom,
  tabsAtom,
} from "@/state";
import { requestCloseResearchApp, resetAppShutdownForTest } from "./AppShutdown";
import { endResearchSessionChange, setResearchSessionTracking } from "./ResearchSession";

class FakeDocTab extends Tab {
  constructor(
    readonly name: string,
    beforeCloseResult = true,
  ) {
    super({});
    this.beforeClose = vi.fn(async () => beforeCloseResult);
  }
  getComponent() {
    return () => null;
  }
}

function makeDeps() {
  return {
    saveWindowState: vi.fn(async () => {
      mocks.events.push("saveWindowState");
    }),
    hideWindow: vi.fn(async () => {
      mocks.events.push("hideWindow");
    }),
    showWindow: vi.fn(async () => {
      mocks.events.push("showWindow");
    }),
    destroyWindow: vi.fn(async () => {
      mocks.events.push("destroyWindow");
    }),
    onAutoSaveError: vi.fn(),
    onSaveError: vi.fn(),
    onCloseCancelled: vi.fn(),
    onCloseConfirmed: vi.fn(),
  };
}

describe("requestCloseResearchApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    resetAppShutdownForTest();
    endResearchSessionChange();
    store.set(tabsAtom, []);
    store.set(activeTabAtom, undefined);
    store.set(activeDockedTabAtom, undefined);
    store.set(activeResourceTabAtom, undefined);
    store.set(tabGroupRootAtom, null);
    store.set(activeGroupIdAtom, undefined);
    mocks.settings.autoSave = true;
    mocks.settings.autoSaveWhenClose = false;
    mocks.settings.researchFolderPath = "/research";
    mocks.settings.researchSession = { openWorkspaces: [], active: "", panels: { files: false, ai: false } };
    setResearchSessionTracking(true);
  });

  it("auto-saves dirty file boards, records the pre-close session, hides the window immediately, then flushes writes and disposes 6 tabs together before exit", async () => {
    const board1 = TabWorkspace.open(new Project(URI.file("/research/a.prg")) as never) as unknown as Project;
    const board2 = TabWorkspace.open(new Project(URI.file("/research/sub/b.prg")) as never) as unknown as Project;
    const board3 = TabWorkspace.open(new Project(URI.file("/research/c.prg")) as never) as unknown as Project;
    board2.projectState = ProjectState.Unsaved;
    const doc1 = TabWorkspace.open(new FakeDocTab("paper.pdf"));
    const doc2 = TabWorkspace.open(new FakeDocTab("note.md"));
    const doc3 = TabWorkspace.open(new FakeDocTab("fig.png"));
    TabWorkspace.focus(board3.id);

    let finishSnapshot!: () => void;
    mocks.finishSnapshots.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSnapshot = () => {
            mocks.events.push("finishSnapshots");
            resolve();
          };
        }),
    );

    const deps = makeDeps();
    const closing = requestCloseResearchApp(deps);

    // 快照还在后台写时，自动保存、记会话、存窗口位置和藏起窗口都已经立刻完成了
    await vi.waitFor(() => expect(deps.hideWindow).toHaveBeenCalledOnce());
    expect(deps.destroyWindow).not.toHaveBeenCalled();
    expect(board2.save).toHaveBeenCalledOnce();
    expect(mocks.settings.researchSession).toEqual({
      openWorkspaces: ["a.prg", "sub/b.prg", "c.prg"],
      active: "c.prg",
      panels: { files: false, ai: false },
    });
    expect(mocks.events.slice(0, 3)).toEqual(["save:b.prg", "saveWindowState", "hideWindow"]);

    finishSnapshot();
    expect(await closing).toBe(true);

    expect(deps.destroyWindow).toHaveBeenCalledOnce();
    expect(mocks.events.at(-1)).toBe("destroyWindow");
    // 快照写完之后才销毁白板标签，保证快照读内存里的舞台时不会被清空
    expect(mocks.events.indexOf("finishSnapshots")).toBeLessThan(mocks.events.indexOf("dispose:a.prg"));
    expect(board1.dispose).toHaveBeenCalledOnce();
    expect(board2.dispose).toHaveBeenCalledOnce();
    expect(board3.dispose).toHaveBeenCalledOnce();
    expect(mocks.events).toContain("flushNodeRecords");
    expect(mocks.events).toContain("flushActivity");
    expect(mocks.events).toContain("flushSettings");
    expect(mocks.events).toContain("flushWorkspace");
    expect(store.get(tabsAtom)).toEqual([]);
    // 之后标签列表清空没有冲掉之前记下来的会话
    expect(mocks.settings.researchSession.openWorkspaces).toEqual(["a.prg", "sub/b.prg", "c.prg"]);
    expect(doc1.beforeClose).toHaveBeenCalledOnce();
    expect(doc2.beforeClose).toHaveBeenCalledOnce();
    expect(doc3.beforeClose).toHaveBeenCalledOnce();
  });

  it("keeps the window open and leaves every tab untouched when the user cancels on an unsaved draft or document", async () => {
    const cleanBoard = TabWorkspace.open(new Project(URI.file("/research/a.prg")) as never) as unknown as Project;
    const dirtyDraft = TabWorkspace.open(new Project(URI.parse("draft:1")) as never) as unknown as Project;
    dirtyDraft.projectState = ProjectState.Unsaved;
    const dirtyDoc = TabWorkspace.open(new FakeDocTab("note.md", false));

    const deps = makeDeps();
    // 第一次：在未保存草稿的对话框点取消
    mocks.buttons.mockResolvedValueOnce("continue").mockResolvedValueOnce("cancel");
    expect(await requestCloseResearchApp(deps)).toBe(false);
    expect(deps.hideWindow).not.toHaveBeenCalled();
    expect(deps.destroyWindow).not.toHaveBeenCalled();
    expect(cleanBoard.dispose).not.toHaveBeenCalled();
    expect(store.get(tabsAtom)).toEqual([cleanBoard, dirtyDraft, dirtyDoc]);

    // 第二次：草稿选「不保存」，但后面的笔记 beforeClose 返回 false（点取消），前面的白板和草稿也照样留着不关
    mocks.buttons.mockResolvedValueOnce("continue").mockResolvedValueOnce("discard");
    expect(await requestCloseResearchApp(deps)).toBe(false);
    expect(deps.hideWindow).not.toHaveBeenCalled();
    expect(deps.destroyWindow).not.toHaveBeenCalled();
    expect(cleanBoard.dispose).not.toHaveBeenCalled();
    expect(dirtyDraft.dispose).not.toHaveBeenCalled();
    expect(store.get(tabsAtom)).toEqual([cleanBoard, dirtyDraft, dirtyDoc]);
  });

  it("still exits when recording the window position or hiding the window fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const board = TabWorkspace.open(new Project(URI.file("/research/a.prg")) as never) as unknown as Project;
    const deps = makeDeps();
    deps.saveWindowState.mockRejectedValueOnce(new Error("window state"));
    deps.hideWindow.mockRejectedValueOnce(new Error("hide"));

    expect(await requestCloseResearchApp(deps)).toBe(true);
    expect(board.dispose).toHaveBeenCalledOnce();
    expect(deps.destroyWindow).toHaveBeenCalledOnce();
    expect(deps.showWindow).not.toHaveBeenCalled();
  });

  it("shows the window again when a write fails after hiding: Go back keeps every tab, Quit anyway still exits", async () => {
    const board = TabWorkspace.open(new Project(URI.file("/research/a.prg")) as never) as unknown as Project;
    const deps = makeDeps();

    // 第一次：活动记录写失败，后面的工作区列表和设置照样写；用户点「返回」
    mocks.flushActivity.mockRejectedValueOnce(new Error("disk gone"));
    mocks.buttons.mockResolvedValueOnce("back");
    expect(await requestCloseResearchApp(deps)).toBe(false);
    expect(mocks.events).toEqual(
      expect.arrayContaining(["hideWindow", "flushWorkspace", "flushSettings", "showWindow"]),
    );
    expect(mocks.buttons).toHaveBeenCalledWith(
      "shell.closePrompt.flushFailedTitle",
      "shell.closePrompt.flushFailed",
      expect.any(Array),
    );
    expect(board.dispose).not.toHaveBeenCalled();
    expect(deps.destroyWindow).not.toHaveBeenCalled();
    expect(store.get(tabsAtom)).toEqual([board]);

    // 第二次：还能再关；这回设置写失败，点「仍然退出」
    mocks.flushSettings.mockRejectedValueOnce(new Error("disk gone"));
    mocks.buttons.mockResolvedValueOnce("quit");
    expect(await requestCloseResearchApp(deps)).toBe(true);
    expect(board.dispose).toHaveBeenCalledOnce();
    expect(deps.destroyWindow).toHaveBeenCalledOnce();
  });

  it("shows the window again and lets the user retry when destroying the window fails", async () => {
    TabWorkspace.open(new Project(URI.file("/research/a.prg")) as never);
    const deps = makeDeps();
    deps.destroyWindow.mockRejectedValueOnce(new Error("destroy"));

    await expect(requestCloseResearchApp(deps)).rejects.toThrow("destroy");
    expect(deps.showWindow).toHaveBeenCalledOnce();
    expect(await requestCloseResearchApp(deps)).toBe(true);
    expect(deps.destroyWindow).toHaveBeenCalledTimes(2);
  });
});
