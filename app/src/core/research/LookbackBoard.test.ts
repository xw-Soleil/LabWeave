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
    closed: vi.fn(async () => {}),
    opened: vi.fn(async () => undefined),
    shown: vi.fn(),
    info: vi.fn(),
  };
});
// 假的白板基类：只留这里要用到的——状态的读写、init 成功就标成已保存、镜头、读写方式的登记
vi.mock("@/core/Project", () => {
  const ProjectState = { Saved: 0, Stashed: 1, Unsaved: 2 };
  class Project {
    state = ProjectState.Unsaved;
    metadata: Record<string, unknown> = { workbench: { id: "真白板的编号" } };
    providers = new Map<string, unknown>();
    closing = false;
    id = crypto.randomUUID();
    camera = { location: { clone: () => "镜头位置" }, currentScale: 0.5, applySavedView: vi.fn() };
    loop = vi.fn();
    dispose = vi.fn(async () => {});
    constructor(readonly uri: { scheme: string; fsPath: string }) {}
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
vi.mock("@/core/TabWorkspace", () => ({ TabWorkspace: { focus: mocks.focused, close: mocks.closed } }));
vi.mock("@/core/service/Settings", () => ({ Settings: {} }));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: mocks.opened }));
vi.mock("@/state", async () => {
  const { atom, createStore } = await import("jotai");
  return {
    store: createStore(),
    tabsAtom: atom<unknown[]>([]),
    activeTabAtom: atom<unknown>(undefined),
    activeResourceTabAtom: atom<unknown>(undefined),
  };
});
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
vi.mock("./Snapshot", () => ({
  snapshotFiles: { read: mocks.read, folders: mocks.folders },
  joinBoard: async (stripped: Uint8Array) => stripped,
}));
vi.mock("./SnapshotDiff", async (original) => ({
  ...(await original<typeof import("./SnapshotDiff")>()),
  showSnapshotDiff: mocks.shown,
}));

import { Project, ProjectState } from "@/core/Project";
import { activeTabAtom, store, tabsAtom } from "@/state";
import { buildAiSidecar } from "./AiSidecarBuilder";
import { LookbackBoard, leaveLookback, nodeChip, nodeLabel, openLookback } from "./LookbackBoard";

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
function putSnapshot(name: string, boards: Record<string, unknown[]>, node?: Record<string, unknown>) {
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
        images: {},
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
  mocks.root = root;
  mocks.initOk = true;
  mocks.disk.clear();
  store.set(tabsAtom, []);
  store.set(activeTabAtom, undefined);
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
    expect(new TextDecoder().decode(board.content)).toBe("2026-11-21 1000 的 白板.prg");
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
    expect(await files.read()).toBe(board.content);
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
});
