import { atom, getDefaultStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ main: vi.fn(), folder: vi.fn(), open: vi.fn() }));
vi.mock("@/state", () => ({
  store: getDefaultStore(),
  tabsAtom: atom<unknown[]>([]),
  tabGroupRootAtom: atom<unknown>(null),
}));
vi.mock("@/core/Project", () => ({
  Project: class Project {
    closing = false;
    isDraft = false;
    uri: { scheme: string; fsPath: string; path: string };
    constructor(
      public id: string,
      public title: string,
    ) {
      this.uri = { scheme: "file", fsPath: `/research/${title}`, path: `/research/${title}` };
    }
  },
}));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: mocks.open }));
vi.mock("./ResearchSession", () => ({ findMainProject: mocks.main, listResearchWorkspaces: mocks.folder }));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    isInside: (path: string) => path.startsWith("/research/"),
    toRelative: (path: string) => path.replace("/research/", ""),
  },
}));
vi.mock("./ResearchWorkspace", () => ({ projectPathKey: (path: string) => path.toLowerCase() }));
vi.mock("i18next", () => ({
  default: { t: (key: string, options?: { n?: string }) => (options?.n ? `${key}:${options.n}` : key) },
}));

import { Project } from "@/core/Project";
import { store, tabGroupRootAtom, tabsAtom } from "@/state";

const board = (id: string, title: string) =>
  new (Project as unknown as new (id: string, title: string) => Project)(id, title);
const group = (id: string, tabIds: string[], activeTabId: string) => ({ id, type: "group", tabIds, activeTabId });
let picker: typeof import("./BoardPicker");

beforeEach(async () => {
  // 「上次发到哪块」记在模块里，每条测试从头来
  vi.resetModules();
  vi.clearAllMocks();
  mocks.folder.mockResolvedValue([]);
  store.set(tabsAtom, []);
  store.set(tabGroupRootAtom, null as never);
  picker = await import("./BoardPicker");
});

describe("boards an excerpt can be sent to", () => {
  it("names a board the way its tab does", () => {
    expect(picker.boardName(board("a", "读书笔记.prg"))).toBe("读书笔记");
    const draft = Object.assign(board("b", "x"), { isDraft: true, uri: { scheme: "draft", path: "2" } });
    expect(picker.boardName(draft)).toBe("tabs.untitled:2");
  });

  it("lists open boards first with the one on screen leading, then unopened boards by latest change", async () => {
    const first = board("a", "一.prg");
    const second = Object.assign(board("b", "二.prg"), {
      uri: { scheme: "file", fsPath: "/research/sub/二.prg", path: "/research/sub/二.prg" },
    });
    const closing = Object.assign(board("c", "关.prg"), { closing: true });
    store.set(tabsAtom, [{ id: "pdf" }, first, second, closing] as never);
    mocks.main.mockReturnValue(second);
    mocks.folder.mockResolvedValue([
      { absPath: "/research/一.prg", relPath: "一.prg", name: "一", open: true },
      { absPath: "/research/旧.prg", relPath: "旧.prg", name: "旧", open: false, mtime: 1 },
      { absPath: "/research/notes/新.prg", relPath: "notes/新.prg", name: "新", open: false, mtime: 9 },
    ]);
    expect(await picker.listBoards()).toEqual([
      { key: "b", name: "二", folder: "sub", open: true },
      { key: "a", name: "一", folder: "", open: true },
      { key: "/research/notes/新.prg", name: "新", folder: "notes", open: false },
      { key: "/research/旧.prg", name: "旧", folder: "", open: false },
    ]);
  });

  it("resolves an open board, puts it first next time, and gives nothing once it is closed", async () => {
    const first = board("a", "一.prg");
    const second = board("b", "二.prg");
    store.set(tabsAtom, [first, second] as never);
    expect(await picker.resolveBoard({ key: "b", name: "二", folder: "", open: true })).toBe(second);
    expect(picker.openBoards().map((item) => item.id)).toEqual(["b", "a"]);
    second.closing = true;
    expect(await picker.resolveBoard({ key: "b", name: "二", folder: "", open: true })).toBeUndefined();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("opens an unopened board in the background without changing the tab on screen", async () => {
    const opened = board("new", "新.prg");
    mocks.open.mockResolvedValue(opened);
    store.set(tabsAtom, [{ id: "pdf" }] as never);
    store.set(tabGroupRootAtom, {
      id: "split",
      type: "split",
      direction: "horizontal",
      sizes: [30, 70],
      children: [group("pg-side-left", ["files"], "files"), group("main", ["pdf"], "pdf")],
    } as never);
    const choice = { key: "/research/新.prg", name: "新", folder: "", open: false };
    expect(await picker.resolveBoard(choice)).toBe(opened);
    expect(mocks.open.mock.calls[0][3]).toEqual({ projectSelected: true, deferActivation: true });
    expect(store.get(tabsAtom)).toEqual([{ id: "pdf" }, opened]);
    // 排进主编辑区那一组，但正显示的还是 PDF；左边的文件栏不动
    const [side, main] = (store.get(tabGroupRootAtom) as unknown as { children: ReturnType<typeof group>[] }).children;
    expect(main).toEqual(group("main", ["pdf", "new"], "pdf"));
    expect(side).toEqual(group("pg-side-left", ["files"], "files"));
    // 再选同一项：它已经开着了，不再打开第二次
    expect(await picker.resolveBoard(choice)).toBe(opened);
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it("gives nothing when the board cannot be opened", async () => {
    mocks.open.mockResolvedValue(undefined);
    expect(await picker.resolveBoard({ key: "/research/坏.prg", name: "坏", folder: "", open: false })).toBeUndefined();
    expect(store.get(tabsAtom)).toEqual([]);
  });
});
