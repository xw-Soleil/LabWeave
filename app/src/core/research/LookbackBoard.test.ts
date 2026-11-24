// @vitest-environment jsdom
import { Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const disk = new Map<string, Uint8Array | string>();
  const inside = (path: string) =>
    [...disk.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1));
  return {
    root: "/research/课题",
    disk,
    read: async (path: string) => {
      const content = disk.get(path);
      return typeof content === "string" ? new TextEncoder().encode(content) : content;
    },
    folders: async (path: string) => [
      ...new Set(
        inside(path)
          .filter((rest) => rest.includes("/"))
          .map((rest) => rest.split("/")[0]),
      ),
    ],
    exists: async (path: string) => disk.has(path),
    initOk: true,
    focused: vi.fn(),
    closed: vi.fn<(id: string) => Promise<void>>(async () => {}),
    opened: vi.fn(async () => undefined),
    shown: vi.fn(),
    info: vi.fn(),
    disposed: vi.fn(),
    visible: vi.fn<(id: string) => boolean>(),
    transition: vi.fn<(from: { id: string }, to: { id: string }) => void>(),
    transitionOver: vi.fn<(from: { id: string }) => Promise<void>>(),
  };
});
// 假的白板基类：只留这里要用到的——状态的读写、init 成功就标成已保存、镜头、读写方式的登记
vi.mock("@/core/Project", () => {
  const ProjectState = { Saved: 0, Stashed: 1, Unsaved: 2 };
  class Project {
    state = ProjectState.Unsaved;
    metadata: Record<string, unknown> = { workbench: { id: "真白板的编号" } };
    providers = new Map<string, unknown>();
    attachments = new Map<string, Blob>();
    /** 读白板文件、建卡片的那一刻，手边有哪些图片 */
    imagesAtInit: string[] = [];
    closing = false;
    layout: "docked" | "floating" = "docked";
    floatingRect = new Rectangle(Vector.getZero(), Vector.same(100));
    zIndex = 0;
    canDock = true;
    closable = true;
    closeOnEscape = true;
    closeWhenClickOutside = false;
    closeWhenClickInside = false;
    titleBarOverlay = false;
    id = crypto.randomUUID();
    camera = { location: { clone: () => "镜头位置" }, currentScale: 0.5, applySavedView: vi.fn() };
    loop = vi.fn();
    pause = vi.fn();
    constructor(readonly uri: { scheme: string; fsPath: string }) {}
    async dispose() {
      mocks.disposed(this.id);
    }
    get projectState() {
      return this.state;
    }
    set projectState(state: number) {
      this.state = state;
    }
    registerFileSystemProvider(scheme: string, provider: new (project: unknown) => unknown) {
      this.providers.set(scheme, new provider(this));
    }
    async init() {
      this.imagesAtInit = [...this.attachments.keys()];
      if (mocks.initOk) this.projectState = ProjectState.Saved;
    }
    async save() {
      throw new Error("不该走到真的保存");
    }
    async saveAs() {
      throw new Error("不该走到真的另存为");
    }
  }
  return { Project, ProjectState };
});
vi.mock("@/core/loadAllServices", () => ({
  loadAllServicesBeforeInit: (project: { registerFileSystemProvider: (scheme: string, provider: unknown) => void }) =>
    project.registerFileSystemProvider(
      "draft",
      class {
        async read() {
          return new Uint8Array();
        }
      },
    ),
  loadAllServicesAfterInit: () => {},
}));
vi.mock("@/core/TabWorkspace", async () => {
  const actual = await vi.importActual<typeof import("@/core/TabWorkspace")>("@/core/TabWorkspace");
  const realFocus = actual.TabWorkspace.focus.bind(actual.TabWorkspace);
  const realClose = actual.TabWorkspace.close.bind(actual.TabWorkspace);
  actual.TabWorkspace.focus = (id: string) => {
    mocks.focused(id);
    realFocus(id);
  };
  actual.TabWorkspace.close = async (id: string, options?: { confirmed?: boolean }) => {
    mocks.closed(id);
    vi.useFakeTimers();
    try {
      const closing = realClose(id, options);
      await vi.advanceTimersByTimeAsync(500);
      return await closing;
    } finally {
      vi.useRealTimers();
    }
  };
  return actual;
});
vi.mock("@/core/service/Settings", () => ({ Settings: { maxFps: 60, maxFpsUnfocused: 60 } }));
vi.mock("@/core/service/Telemetry", () => ({ Telemetry: { event: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: { buttons: vi.fn() } }));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: mocks.opened }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists }));
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options: Record<string, string> = {}) =>
      key === "lookback.tabName"
        ? `回看 · ${options.node} · ${options.board}`
        : ({ "stageNode.types.meeting": "组会", "stageSummary.title": "阶段小结" }[key] ?? key),
  },
}));
vi.mock("sonner", () => ({ toast: { info: mocks.info } }));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => mocks.root,
    ensureRootRegistered: async () => {},
    isInside: (path: string, root: string) => !!root && path.startsWith(`${root}/`),
    toRelative: (path: string, root: string) => path.slice(root.length + 1),
  },
}));
vi.mock("./ResearchReport", () => ({ reportFolderName: (title: string) => title }));
vi.mock("./ResearchSession", () => ({ isTabVisibleInWorkspace: mocks.visible }));
vi.mock("./LookbackTransition", () => ({
  startLookbackTransition: mocks.transition,
  lookbackTransitionOver: mocks.transitionOver,
}));
vi.mock("./Snapshot", () => ({
  snapshotFiles: { read: mocks.read, folders: mocks.folders },
}));
vi.mock("./SnapshotDiff", async (original) => ({
  ...(await original<typeof import("./SnapshotDiff")>()),
  showSnapshotDiff: mocks.shown,
}));

import { Project, ProjectState } from "@/core/Project";
import { findTabGroupByTabId, splitTabGroup, createTabGroup } from "@/core/TabGroup";
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
import { buildAiSidecar } from "./AiSidecarBuilder";
import { LookbackBoard, leaveLookback, nodeChip, nodeLabel, openLookback } from "./LookbackBoard";
import { contentHash } from "./SnapshotBoard";

const root = "/research/课题";
const text = (uuid: string, value: string) => ({
  _: "TextNode",
  uuid,
  text: value,
  collisionBox: {
    _: "CollisionBox",
    shapes: [{ _: "Rectangle", location: { _: "Vector", x: 0, y: 0 }, size: { _: "Vector", x: 100, y: 50 } }],
  },
});

/** 往假磁盘上放一份快照：清单、白板文件（内容用一个记号代替）、文字版 */
function putSnapshot(
  name: string,
  boards: Record<string, unknown[]>,
  node?: Record<string, unknown>,
  images: Record<string, string> = {},
) {
  const [day, time] = name.split(" ");
  const folder = `${root}/.workbench/快照/${name}`;
  mocks.disk.set(
    `${folder}/清单.json`,
    JSON.stringify({
      v: 1,
      at: `${day}T${time.slice(0, 2)}:${time.slice(2, 4)}:00+08:00`,
      reason: node ? "node" : "auto",
      project: "课题",
      ...(node && { node }),
      boards: Object.keys(boards).map((file) => ({
        file,
        cards: boards[file].length,
        sections: 0,
        edges: 0,
        images,
      })),
    }),
  );
  for (const [file, stage] of Object.entries(boards)) {
    mocks.disk.set(`${folder}/${file}`, new TextEncoder().encode(`${name} 的 ${file}`));
    mocks.disk.set(
      `${folder}/${file.replace(/\.prg$/, "")}.ai.json`,
      JSON.stringify(
        buildAiSidecar({ serializedStage: stage, workspaceFile: `${root}/${file}`, researchRoot: root }).json,
      ),
    );
  }
}
const meeting = (day: string, since?: string, note?: string) => ({
  type: "meeting",
  title: `${day} 组会`,
  ...(since && { since }),
  ...(note && { note }),
});
const liveBoard = (path = `${root}/白板.prg`) => new Project({ scheme: "file", fsPath: path } as never);

function threeNodes() {
  putSnapshot("2026-11-07 1000", { "白板.prg": [text("a", "最早的一张")] });
  putSnapshot(
    "2026-11-14 1000",
    { "白板.prg": [text("a", "最早的一张"), text("b", "第一周加的")] },
    meeting("2026-11-14", "2026-11-07 1000"),
  );
  putSnapshot(
    "2026-11-21 1000",
    { "白板.prg": [text("a", "改过了"), text("c", "第二周加的")], "另一块.prg": [text("x", "新白板")] },
    meeting("2026-11-21", "2026-11-14 1000", "这周主要试了 B 方法"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.visible.mockReset().mockReturnValue(false);
  mocks.transition.mockReset();
  mocks.transitionOver.mockReset().mockResolvedValue(undefined);
  mocks.root = root;
  mocks.initOk = true;
  mocks.disk.clear();
  store.set(tabsAtom, []);
  store.set(activeTabAtom, undefined);
  store.set(activeDockedTabAtom, undefined);
  store.set(activeResourceTabAtom, undefined);
  store.set(tabGroupRootAtom, null);
  store.set(activeGroupIdAtom, undefined);
});

describe("looking back at a node", () => {
  it("opens the board as it was at the last node, marked against the node before it", async () => {
    threeNodes();
    mocks.disk.set(`${root}/汇报/2026-11-21 组会/报告.md`, "报告");
    const live = liveBoard();
    const board = (await openLookback(live))!;

    expect(board).toBeInstanceOf(LookbackBoard);
    expect(board.lookback).toMatchObject({
      root,
      file: "白板.prg",
      node: { name: "2026-11-21 1000" },
      base: { name: "2026-11-14 1000" },
      // a 改了，c 是新的，b 没了
      counts: { added: 1, edited: 1, removed: 1 },
      report: `${root}/汇报/2026-11-21 组会/报告.md`,
    });
    expect(board.lookback.nodes.map(({ name }) => name)).toEqual(["2026-11-14 1000", "2026-11-21 1000"]);
    expect(new TextDecoder().decode(board.content.stripped)).toBe("2026-11-21 1000 的 白板.prg");
    // 画布上的标记是那两份快照的文字版比出来的
    const [shownBoard, name, before, after] = mocks.shown.mock.calls[0];
    expect(shownBoard).toBe(board);
    expect(name).toBe("2026-11-14 1000");
    expect(before.cards.map((card: { id: string }) => card.id)).toEqual(["a", "b"]);
    expect(after.cards.map((card: { id: string }) => card.id)).toEqual(["a", "c"]);
    // 镜头接着刚才看的地方；加进标签并切到前面
    expect(board.camera.applySavedView).toHaveBeenCalledWith("镜头位置", 0.5);
    expect(store.get(tabsAtom)).toEqual([board]);
    expect(store.get(activeTabAtom)).toBe(board);
    expect(mocks.focused).toHaveBeenCalledWith(board.id);
    expect(mocks.closed).not.toHaveBeenCalled();
  });

  it("is read-only in every way that matters: its own name, never unsaved, nothing to save", async () => {
    threeNodes();
    const board = (await openLookback(liveBoard()))!;
    expect(board.tabName).toBe("回看 · 11-21 组会 · 白板");
    expect(board.title).toBe(board.tabName);
    expect(board.uri.scheme).toBe("draft");
    // 读的是快照里拼回来的内容，不是空白草稿；写不进去
    const files = (
      board as unknown as { providers: Map<string, { read(): Promise<Uint8Array>; write(): Promise<void> }> }
    ).providers.get("draft")!;
    expect(await files.read()).toBe(board.content.stripped);
    await expect(files.write()).rejects.toThrow("lookback.readOnly");

    board.projectState = ProjectState.Unsaved;
    expect(board.projectState).toBe(ProjectState.Saved);
    await board.save();
    await board.saveAs();
    expect(mocks.info).toHaveBeenCalledTimes(2);
    // AI 对话记录按工作区编号存：不能和真的那块白板共用
    expect((board.metadata as { workbench: { id: string } }).workbench.id).not.toBe("真白板的编号");
  });

  it("steps to another node in place of the one being shown, and treats the first node's cards as all new", async () => {
    threeNodes();
    const live = liveBoard();
    const latest = (await openLookback(live))!;
    const earlier = (await openLookback(latest, "2026-11-14 1000"))!;
    expect(earlier.lookback).toMatchObject({
      node: { name: "2026-11-14 1000" },
      // 它当初比的是一份自动快照，不是节点：照样比
      base: { name: "2026-11-07 1000" },
      counts: { added: 1, edited: 0, removed: 0 },
    });
    expect(earlier.lookback.report).toBeUndefined();
    // 镜头是从上一个回看接过来的；旧的那个标签关掉
    expect(earlier.camera.applySavedView).toHaveBeenCalledWith("镜头位置", 0.5);
    expect(mocks.closed).toHaveBeenCalledWith(latest.id);

    mocks.disk.clear();
    putSnapshot("2026-11-14 1000", { "白板.prg": [text("a", "一"), text("b", "二")] }, meeting("2026-11-14"));
    const first = (await openLookback(live))!;
    expect(first.lookback.base).toBeUndefined();
    expect(first.lookback.counts).toEqual({ added: 2, edited: 0, removed: 0 });
    expect(mocks.shown.mock.calls.at(-1)!.slice(1, 3)).toEqual(["", undefined]);
  });

  it("has its pictures ready before the cards are built, and takes unchanged ones from the open board", async () => {
    const [kept, gone] = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const names = await Promise.all([kept, gone].map(async (bytes) => `${await contentHash(bytes)}.png`));
    const pictures = { 还在的: names[0], 删掉的: names[1] };
    putSnapshot("2026-11-21 1000", { "白板.prg": [text("a", "一")] }, meeting("2026-11-21"), pictures);
    // 还在的那张不放到磁盘上：要是去读文件就会报缺图
    mocks.disk.set(`${root}/.workbench/快照/图片/${names[1]}`, gone);
    const live = liveBoard();
    const picture = new Blob([kept]);
    live.attachments.set("还在的", picture);
    const board = (await openLookback(live))!;
    expect((board as unknown as { imagesAtInit: string[] }).imagesAtInit).toEqual(["还在的", "删掉的"]);
    expect(board.attachments.get("还在的")).toBe(picture);
    expect(new Uint8Array(await board.attachments.get("删掉的")!.arrayBuffer())).toEqual(gone);
  });

  it("says why it cannot open, and opens no tab", async () => {
    await expect(openLookback(liveBoard())).rejects.toThrow("lookback.noNode");
    threeNodes();
    // 那个节点定格时还没有这块白板
    await expect(openLookback(liveBoard(`${root}/另一块.prg`), "2026-11-14 1000")).rejects.toThrow("lookback.noBoard");
    await expect(openLookback(liveBoard("/别处/白板.prg"))).rejects.toThrow("stageReview.outside");
    await expect(openLookback(liveBoard(), "没有这个节点")).rejects.toThrow("lookback.noNode");
    // 白板文件被删了
    mocks.disk.delete(`${root}/.workbench/快照/2026-11-21 1000/白板.prg`);
    await expect(openLookback(liveBoard())).rejects.toThrow("snapshot.boardMissing");
    mocks.root = "";
    await expect(openLookback(liveBoard())).rejects.toThrow("stageSummary.noProject");
    expect(store.get(tabsAtom)).toEqual([]);
  });

  it("opens nothing when the old board file cannot be read", async () => {
    threeNodes();
    mocks.initOk = false;
    expect(await openLookback(liveBoard())).toBeUndefined();
    expect(store.get(tabsAtom)).toEqual([]);
    expect(mocks.shown).not.toHaveBeenCalled();
  });

  it("goes back to the board as it is now, opening it if it was closed meanwhile", async () => {
    threeNodes();
    const live = liveBoard();
    const board = (await openLookback(live))!;
    store.set(tabsAtom, [live, board]);
    await leaveLookback(board);
    expect(mocks.closed).toHaveBeenCalledWith(board.id);
    expect(mocks.focused).toHaveBeenLastCalledWith(live.id);
    expect(mocks.opened).not.toHaveBeenCalled();

    store.set(tabsAtom, [board]);
    mocks.disk.set(`${root}/白板.prg`, "还在");
    await leaveLookback(board);
    expect(mocks.opened).toHaveBeenCalledTimes(1);
  });

  it("plays the transition from the board on screen, ready before the new one is brought to the front", async () => {
    threeNodes();
    const live = liveBoard();
    TabWorkspace.open(live as never);
    // 开始过渡的那一刻：眼前还是旧的那块，新的那块镜头已经摆好、标记已经比出来
    const seen: unknown[] = [];
    mocks.transition.mockImplementation((from, to) => {
      seen.push([from.id, to.id, store.get(activeTabAtom)?.id]);
      expect((to as Project).camera.applySavedView).toHaveBeenCalledWith("镜头位置", 0.5);
    });
    const latest = (await openLookback(live))!;
    const earlier = (await openLookback(latest, "2026-11-14 1000"))!;
    await leaveLookback(earlier);
    expect(seen).toEqual([
      [live.id, latest.id, live.id],
      [latest.id, earlier.id, latest.id],
      [earlier.id, live.id, earlier.id],
    ]);
    expect(mocks.shown.mock.invocationCallOrder[0]).toBeLessThan(mocks.transition.mock.invocationCallOrder[0]);
  });

  it("leaves the camera of the real board alone, and plays nothing, when it is in view next to the lookback", async () => {
    threeNodes();
    const live = liveBoard();
    TabWorkspace.open(live as never);
    const board = (await openLookback(live))!;
    mocks.transition.mockReset();
    mocks.visible.mockImplementation((id) => id === live.id);
    await leaveLookback(board);
    expect(live.camera.applySavedView).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(store.get(activeTabAtom)).toBe(live);
  });

  it("is not taken apart while the transition away from it is still drawing it", async () => {
    threeNodes();
    const board = (await openLookback(liveBoard()))!;
    let over!: () => void;
    mocks.transitionOver.mockReturnValue(new Promise((resolve) => (over = resolve)));
    const disposing = board.dispose();
    await Promise.resolve();
    expect(mocks.transitionOver).toHaveBeenCalledWith(board);
    expect(mocks.disposed).not.toHaveBeenCalled();
    over();
    await disposing;
    expect(mocks.disposed).toHaveBeenCalledWith(board.id);
  });

  it("names nodes for the strip, including summaries made before nodes had names", () => {
    const named = {
      name: "2026-11-21 1000",
      manifest: { at: "2026-11-21T10:00:00+08:00", node: meeting("2026-11-21") },
    };
    const legacy = { name: "2026-11-15 0930", manifest: { at: "2026-11-15T09:30:00+08:00", reason: "summary" } };
    expect(nodeLabel(named as never)).toBe("2026-11-21 组会");
    expect(nodeChip(named as never)).toBe("11-21 组会");
    expect(nodeLabel(legacy as never)).toBe("11-15 09:30 阶段小结");
    expect(nodeChip(legacy as never)).toBe("11-15 阶段小结");
  });

  it("opens on the lookback board without activating or touching an open PDF tab in the same group or a split", async () => {
    threeNodes();
    // 情形一：白板和 PDF 开在同一个标签组里（包括从 PDF 发完摘录切回白板后点回看、切节点、退出回看）
    const live = liveBoard();
    const pdf = new Project({ scheme: "file", fsPath: `${root}/论文.pdf` } as never);
    TabWorkspace.open(live as never);
    TabWorkspace.open(pdf as never);
    TabWorkspace.focus(live.id);
    mocks.focused.mockClear();
    const seenActive: unknown[] = [];
    const seenGroupActive: (string | undefined)[] = [];
    const offActive = store.sub(activeTabAtom, () => seenActive.push(store.get(activeTabAtom)));
    const offGroup = store.sub(tabGroupRootAtom, () =>
      seenGroupActive.push(findTabGroupByTabId(store.get(tabGroupRootAtom), pdf.id)?.activeTabId),
    );

    try {
      const lookback = (await openLookback(live))!;
      expect(store.get(activeTabAtom)).toBe(lookback);
      expect(findTabGroupByTabId(store.get(tabGroupRootAtom), live.id)?.activeTabId).toBe(lookback.id);
      expect(mocks.focused).not.toHaveBeenCalledWith(pdf.id);

      const earlier = (await openLookback(lookback, "2026-11-14 1000"))!;
      expect(store.get(activeTabAtom)).toBe(earlier);
      expect(findTabGroupByTabId(store.get(tabGroupRootAtom), live.id)?.activeTabId).toBe(earlier.id);
      expect(mocks.focused).not.toHaveBeenCalledWith(pdf.id);

      await leaveLookback(earlier);
      expect(store.get(activeTabAtom)).toBe(live);
      expect(findTabGroupByTabId(store.get(tabGroupRootAtom), live.id)?.activeTabId).toBe(live.id);
      expect(store.get(tabsAtom)).toContain(pdf);
      expect(mocks.focused).not.toHaveBeenCalledWith(pdf.id);
      expect(seenActive).not.toContain(pdf);
      expect(seenGroupActive).not.toContain(pdf.id);
    } finally {
      offActive();
      offGroup();
    }

    // 情形二：左白板、右 PDF 分屏，发完摘录后 activeGroupIdAtom 还停在右边 PDF 组上，点左边白板的回看
    store.set(tabsAtom, []);
    store.set(tabGroupRootAtom, null);
    const leftBoard = liveBoard();
    const rightPdf = new Project({ scheme: "file", fsPath: `${root}/分屏论文.pdf` } as never);
    const leftGroup = createTabGroup([leftBoard.id], "left-board-group");
    const rightGroup = createTabGroup([rightPdf.id], "right-pdf-group");
    store.set(tabsAtom, [leftBoard as never, rightPdf as never]);
    store.set(tabGroupRootAtom, splitTabGroup(leftGroup, leftGroup.id, rightGroup, "right"));
    store.set(activeGroupIdAtom, rightGroup.id);
    store.set(activeTabAtom, rightPdf as never);
    mocks.focused.mockClear();

    const splitLookback = (await openLookback(leftBoard))!;
    expect(store.get(activeTabAtom)).toBe(splitLookback);
    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), splitLookback.id)?.id).toBe("left-board-group");
    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), leftBoard.id)?.activeTabId).toBe(splitLookback.id);
    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), rightPdf.id)?.id).toBe("right-pdf-group");
    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), rightPdf.id)?.activeTabId).toBe(rightPdf.id);
    expect(mocks.focused).not.toHaveBeenCalledWith(rightPdf.id);

    await leaveLookback(splitLookback);
    expect(store.get(activeTabAtom)).toBe(leftBoard);
    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), leftBoard.id)?.activeTabId).toBe(leftBoard.id);
    expect(findTabGroupByTabId(store.get(tabGroupRootAtom), rightPdf.id)?.activeTabId).toBe(rightPdf.id);
    expect(mocks.focused).not.toHaveBeenCalledWith(rightPdf.id);
  });
});
