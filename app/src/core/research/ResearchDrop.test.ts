import { Vector } from "@graphif/data-structures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { researchFolderPath: "/Users/me/Research", researchOutsideFileMode: "ask" },
  buttons: vi.fn(),
  createFileCards: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  release: vi.fn(),
  markFileCardsPending: vi.fn(),
  onOpenFile: vi.fn(async () => undefined),
  getDropTarget: vi.fn(),
  focus: vi.fn(),
  copyFile: vi.fn<(source: string, destination: string) => Promise<undefined>>(async () => undefined),
  exists: vi.fn(async (path: string) => path === ""),
  mkdir: vi.fn(async () => undefined),
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
  dispatchEvent: vi.fn(),
}));

vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: mocks.buttons } }));
vi.mock("@/core/Project", () => ({ Project: class Project {} }));
vi.mock("@/core/research/FileCardFactory", () => ({
  createFileCards: mocks.createFileCards,
  markFileCardsPending: mocks.markFileCardsPending,
}));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: mocks.onOpenFile }));
vi.mock("@/core/stage/stageObject/collisionBox/collisionBox", () => ({ CollisionBox: class CollisionBox {} }));
vi.mock("@/core/stage/stageObject/entity/TextNode", () => ({ TextNode: class TextNode {} }));
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: { getDropTarget: mocks.getDropTarget, focus: mocks.focus } }));
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
vi.mock("@tauri-apps/plugin-fs", () => ({ copyFile: mocks.copyFile, exists: mocks.exists, mkdir: mocks.mkdir }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options?: { names?: string }) =>
      key === "drop.separator" ? ", " : options?.names !== undefined ? `${key}:${options.names}` : key,
  },
}));

import { Project } from "@/core/Project";
import { RESEARCH_FILES_CHANGED_EVENT, ResearchFolder } from "@/core/research/ResearchFolder";
import { activeResourceTabAtom, activeTabAtom, store, tabGroupRootAtom, tabsAtom } from "@/state";
import {
  dropFilesAtClientPoint,
  findFreeFileName,
  numberedFileName,
  resolveDropTarget,
  screenToClientPoint,
  splitDroppedPaths,
  webviewDropPositionToClient,
} from "./ResearchDrop";

/** 画布在窗口里的位置是 (100,50)–(900,650)；世界坐标 = 画布坐标 + (1000, 0) */
function makeBoard(id: string): Project {
  return Object.assign(Object.create(Project.prototype), {
    id,
    layout: "docked",
    camera: { location: new Vector(5, 6) },
    canvas: {
      element: {
        getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }),
      },
      clientToView: (x: number, y: number) => new Vector(x - 100, y - 50),
    },
    renderer: { transformView2World: (view: Vector) => new Vector(view.x + 1000, view.y) },
  });
}

function showBoard(board: Project) {
  store.set(tabsAtom, [board]);
  store.set(tabGroupRootAtom, { id: "main", type: "group", tabIds: [board.id], activeTabId: board.id });
  store.set(activeTabAtom, board);
  store.set(activeResourceTabAtom, board);
  mocks.getDropTarget.mockReturnValue({ groupId: "main" });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 复制进 导入/ 后会发 research:files-changed 让文件面板刷新；node 环境没有 window
  vi.stubGlobal("window", { dispatchEvent: mocks.dispatchEvent });
  mocks.settings.researchFolderPath = "/Users/me/Research";
  mocks.settings.researchOutsideFileMode = "ask";
  // 研究文件夹本身在，导入/ 和里面的文件都还没有
  mocks.exists.mockImplementation(async (path: string) => path === mocks.settings.researchFolderPath);
  mocks.markFileCardsPending.mockImplementation(() => mocks.release);
  mocks.copyFile.mockImplementation(async () => undefined);
  mocks.createFileCards.mockImplementation(async () => []);
  vi.spyOn(ResearchFolder, "ensureRootRegistered").mockResolvedValue(undefined);
  store.set(tabsAtom, []);
  store.set(tabGroupRootAtom, null);
  store.set(activeTabAtom, undefined);
  store.set(activeResourceTabAtom, undefined);
  mocks.getDropTarget.mockReturnValue(null);
});

describe("pure helpers", () => {
  it("splits dropped paths into workspaces, cards and unsupported files", () => {
    expect(
      splitDroppedPaths([
        "/r/a.prg",
        "/r/B.PRG",
        "/r/paper.PDF",
        "/r/fig.png",
        "C:\\r\\note.md",
        "/r/report.docx",
        "/r/folder",
      ]),
    ).toEqual({
      workspaces: ["/r/a.prg", "/r/B.PRG"],
      cards: ["/r/paper.PDF", "/r/fig.png", "C:\\r\\note.md"],
      unsupported: ["/r/report.docx", "/r/folder"],
    });
  });

  it("numbers copy names before the extension", () => {
    expect(numberedFileName("paper.pdf", 1)).toBe("paper.pdf");
    expect(numberedFileName("paper.pdf", 2)).toBe("paper (2).pdf");
    expect(numberedFileName("v1.2 final.pdf", 3)).toBe("v1.2 final (3).pdf");
    expect(numberedFileName("README", 2)).toBe("README (2)");
    expect(numberedFileName(".hidden", 2)).toBe(".hidden (2)");
  });

  it("finds the first free copy name", async () => {
    const taken = new Set(["paper.pdf", "paper (2).pdf"]);
    expect(await findFreeFileName("paper.pdf", async (name) => taken.has(name))).toBe("paper (3).pdf");
    expect(await findFreeFileName("other.pdf", async (name) => taken.has(name))).toBe("other.pdf");
  });

  it("converts Windows screen pixels to client coordinates", () => {
    expect(screenToClientPoint({ x: 500, y: 300 }, { x: 100, y: 100, scaleFactor: 2 })).toEqual({ x: 200, y: 100 });
    expect(screenToClientPoint({ x: 50, y: 60 }, { x: 0, y: 0, scaleFactor: 0 })).toEqual({ x: 50, y: 60 });
  });

  it("only divides webview drop positions when they are really physical pixels", () => {
    expect(webviewDropPositionToClient({ x: 300, y: 200 }, false, 2)).toEqual({ x: 300, y: 200 });
    expect(webviewDropPositionToClient({ x: 300, y: 200 }, true, 2)).toEqual({ x: 150, y: 100 });
  });
});

describe("resolveDropTarget", () => {
  it("uses the board under the point and converts the point to world coordinates", () => {
    const board = makeBoard("b1");
    showBoard(board);
    const target = resolveDropTarget(300, 150);
    expect(target?.project).toBe(board);
    expect(target?.worldPos).toEqual(new Vector(1200, 100));
  });

  it("falls back to the active board's view centre when the point is not over a board", () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.getDropTarget.mockReturnValue(null);
    const target = resolveDropTarget(10, 10);
    expect(target?.project).toBe(board);
    expect(target?.worldPos).toEqual(new Vector(5, 6));
  });

  it("returns null when no board is open", () => {
    expect(resolveDropTarget(10, 10)).toBeNull();
  });
});

describe("dropFilesAtClientPoint", () => {
  const withRetarget = expect.objectContaining({ retarget: expect.any(Function) });

  it("places files inside the research folder without asking, then opens workspaces", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    await dropFilesAtClientPoint(
      ["/Users/me/Research/papers/a.pdf", "/Users/me/Research/w.prg", "/Users/me/Research/x.docx"],
      300,
      150,
    );
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Research/papers/a.pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
    expect(mocks.onOpenFile).toHaveBeenCalledTimes(1);
    expect(mocks.createFileCards.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.onOpenFile.mock.invocationCallOrder[0],
    );
    expect(mocks.toast.warning).toHaveBeenCalledWith("drop.unsupported:x.docx");
  });

  it("copies outside files into 导入/ with a free name after the user agrees", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.buttons.mockResolvedValueOnce("copy");
    mocks.exists.mockImplementation(async (path: string) =>
      ["/Users/me/Research", "/Users/me/Research/导入/a.pdf"].includes(path),
    );
    await dropFilesAtClientPoint(["/Users/me/Research/in.md", "/Users/me/Downloads/a.pdf"], 300, 150);
    // 只建 导入/ 这一层，不递归重建研究文件夹
    expect(mocks.mkdir).toHaveBeenCalledWith("/Users/me/Research/导入");
    expect(mocks.copyFile).toHaveBeenCalledWith("/Users/me/Downloads/a.pdf", "/Users/me/Research/导入/a (2).pdf");
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Research/in.md", "/Users/me/Research/导入/a (2).pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
    expect(mocks.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: RESEARCH_FILES_CHANGED_EVENT }));
  });

  it("links the original outside files without copying when the user picks 直接引用", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.buttons.mockResolvedValueOnce("reference");
    await dropFilesAtClientPoint(["/Users/me/Research/in.md", "/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Research/in.md", "/Users/me/Downloads/a.pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
  });

  it("follows the 'always link' setting without asking", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.settings.researchOutsideFileMode = "reference";
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Downloads/a.pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
  });

  it("follows the 'always copy' setting without asking", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.settings.researchOutsideFileMode = "copy";
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.copyFile).toHaveBeenCalledWith("/Users/me/Downloads/a.pdf", "/Users/me/Research/导入/a.pdf");
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Research/导入/a.pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
  });

  it("does nothing with the cards when the user cancels the copy", async () => {
    showBoard(makeBoard("b1"));
    mocks.buttons.mockResolvedValueOnce("cancel");
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.createFileCards).not.toHaveBeenCalled();
  });

  it("warns when there is no board to put cards on", async () => {
    await dropFilesAtClientPoint(["/Users/me/Research/a.pdf"], 300, 150);
    expect(mocks.toast.warning).toHaveBeenCalledWith("drop.noBoard");
    expect(mocks.buttons).not.toHaveBeenCalled();
    expect(mocks.createFileCards).not.toHaveBeenCalled();
  });

  it("can link the original files when no research folder is chosen", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.settings.researchFolderPath = "";
    mocks.buttons.mockResolvedValueOnce("original");
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Downloads/a.pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
  });

  it("lets the user choose a research folder and copies without asking twice", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.settings.researchFolderPath = "";
    mocks.buttons.mockResolvedValueOnce("choose");
    const chooseRoot = vi.spyOn(ResearchFolder, "chooseRoot").mockImplementation(async () => {
      mocks.settings.researchFolderPath = "/Users/me/New";
      return "/Users/me/New";
    });
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(chooseRoot).toHaveBeenCalledTimes(1);
    expect(mocks.buttons).toHaveBeenCalledTimes(1);
    expect(mocks.copyFile).toHaveBeenCalledWith("/Users/me/Downloads/a.pdf", "/Users/me/New/导入/a.pdf");
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/New/导入/a.pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
    chooseRoot.mockRestore();
  });

  it("does not recreate a research folder that was renamed or mistyped", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.settings.researchFolderPath = "/Users/me/Gone";
    mocks.exists.mockImplementation(async () => false);
    mocks.buttons.mockResolvedValueOnce("original");
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.buttons).toHaveBeenCalledWith(
      "drop.missingFolder.title",
      "drop.missingFolder.description",
      expect.any(Array),
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Downloads/a.pdf"],
      new Vector(1200, 100),
      withRetarget,
    );
  });

  it("offers to choose again when the research folder can't be registered", async () => {
    showBoard(makeBoard("b1"));
    vi.mocked(ResearchFolder.ensureRootRegistered).mockRejectedValueOnce(new Error("无法打开研究文件夹"));
    mocks.buttons.mockResolvedValueOnce("cancel");
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.buttons).toHaveBeenCalledWith(
      "drop.missingFolder.title",
      "drop.missingFolder.description",
      expect.any(Array),
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.createFileCards).not.toHaveBeenCalled();
  });

  it("places the files that were copied when another file in the batch fails", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.buttons.mockResolvedValueOnce("copy");
    mocks.copyFile.mockImplementation(async (source: string) => {
      if (source.endsWith("offline.pdf")) throw new Error("iCloud 文件没下载");
      return undefined;
    });
    await dropFilesAtClientPoint(
      ["/Users/me/Downloads/a.pdf", "/Users/me/Downloads/offline.pdf", "/Users/me/Downloads/c.md"],
      300,
      150,
    );
    expect(mocks.copyFile).toHaveBeenCalledTimes(3);
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      board,
      ["/Users/me/Research/导入/a.pdf", "/Users/me/Research/导入/c.md"],
      new Vector(1200, 100),
      withRetarget,
    );
    expect(mocks.toast.success).toHaveBeenCalledOnce();
    expect(mocks.toast.error).toHaveBeenCalledWith("drop.copyFailed");
    expect(mocks.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: RESEARCH_FILES_CHANGED_EVENT }));
  });

  it("still opens dropped workspaces when making the cards fails, then reports the error", async () => {
    showBoard(makeBoard("b1"));
    mocks.createFileCards.mockRejectedValueOnce(new Error("boom"));
    await expect(
      dropFilesAtClientPoint(["/Users/me/Research/a.pdf", "/Users/me/Research/w.prg"], 300, 150),
    ).rejects.toThrow("boom");
    expect(mocks.onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the target marked as pending until the cards are placed", async () => {
    const board = makeBoard("b1");
    showBoard(board);
    mocks.createFileCards.mockImplementationOnce(async () => {
      expect(mocks.release).not.toHaveBeenCalled();
      return [];
    });
    await dropFilesAtClientPoint(["/Users/me/Research/a.pdf"], 300, 150);
    expect(mocks.markFileCardsPending).toHaveBeenCalledWith(board);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("moves the cards to the active board when the target was closed during the copy prompt", async () => {
    const draft = makeBoard("draft");
    showBoard(draft);
    const other = makeBoard("other");
    mocks.buttons.mockImplementationOnce(async () => {
      // 用户还在看复制对话框时，空草稿被 closeEmptyDrafts 关掉，换成了别的工作区
      Object.assign(draft, { closing: true });
      store.set(tabsAtom, [other]);
      store.set(activeResourceTabAtom, other);
      return "copy";
    });
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.createFileCards).toHaveBeenCalledWith(
      other,
      ["/Users/me/Research/导入/a.pdf"],
      new Vector(5, 6),
      withRetarget,
    );
  });

  it("warns instead of placing cards when the target was closed and no board is left", async () => {
    const draft = makeBoard("draft");
    showBoard(draft);
    mocks.buttons.mockImplementationOnce(async () => {
      store.set(tabsAtom, []);
      store.set(activeResourceTabAtom, undefined);
      return "copy";
    });
    await dropFilesAtClientPoint(["/Users/me/Downloads/a.pdf"], 300, 150);
    expect(mocks.createFileCards).not.toHaveBeenCalled();
    expect(mocks.toast.warning).toHaveBeenCalledWith("card.targetClosed");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
