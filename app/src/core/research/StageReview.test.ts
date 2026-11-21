import { createDefaultMetadata } from "@/types/metadata";
import { encode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const disk = new Map<string, Uint8Array | string>();
  const inside = (path: string) =>
    [...disk.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1));
  const names = (path: string) => [...new Set(inside(path).map((rest) => rest.split("/")[0]))];
  const isFolder = (path: string, name: string) => inside(path).some((rest) => rest.startsWith(`${name}/`));
  return {
    root: "/research/课题",
    disk,
    read: async (path: string) => {
      const content = disk.get(path);
      return typeof content === "string" ? new TextEncoder().encode(content) : content;
    },
    folders: async (path: string) => names(path).filter((name) => isFolder(path, name)),
    exists: async (path: string) => disk.has(path) || inside(path).length > 0,
    readDir: async (path: string) =>
      names(path).map((name) => ({ name, isFile: !isFolder(path, name), isDirectory: isFolder(path, name) })),
    flushed: vi.fn(async () => {}),
    taken: vi.fn(),
    shown: vi.fn(),
    hidden: vi.fn(),
    droppedSet: vi.fn(),
  };
});
vi.mock("@/state", async () => ({ store: (await import("jotai")).createStore() }));
vi.mock("@graphif/serializer", () => ({ serialize: (stage: unknown) => stage }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists, readDir: mocks.readDir }));
vi.mock("./ActivityLog", () => ({
  ACTIVITY_MARKS: ["progress", "problem", "idea"],
  flushActivityLog: mocks.flushed,
}));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => mocks.root,
    ensureRootRegistered: async () => {},
    isInside: (path: string, root: string) => !!root && path.startsWith(`${root}/`),
    toRelative: (path: string, root: string) => path.slice(root.length + 1),
  },
}));
vi.mock("./Snapshot", () => ({
  snapshotFiles: { read: mocks.read, folders: mocks.folders, exists: mocks.exists, write: async () => {} },
  takeNode: mocks.taken,
  nodeTitle: (type: string) => `今天 ${type}`,
}));
vi.mock("./SnapshotDiff", () => ({
  showSinceLast: mocks.shown,
  hideSinceLast: mocks.hidden,
  setSinceLastDropped: mocks.droppedSet,
}));

import { store } from "@/state";
import { buildAiSidecar } from "./AiSidecarBuilder";
import { localTime } from "./ProjectRecord";
import {
  boardItems,
  cardItems,
  dropSelected,
  enterStageReview,
  freezeStageReview,
  leaveStageReview,
  logItems,
  onlySelected,
  setReviewDropped,
  setReviewNote,
  stageReviewAtom,
} from "./StageReview";

const root = "/research/课题";
const text = (uuid: string, value: string) => ({
  _: "TextNode",
  uuid,
  text: value,
  collisionBox: { _: "CollisionBox", shapes: [] },
});
const sidecar = (stage: unknown[], file = "白板.prg") =>
  buildAiSidecar({ serializedStage: stage, workspaceFile: `${root}/${file}`, researchRoot: root }).json;

/** 一个真的白板文件 */
async function prg(cards: unknown[]): Promise<Uint8Array> {
  const output = new Uint8ArrayWriter();
  const writer = new ZipWriter(output, { level: 0 });
  await writer.add("stage.msgpack", new Uint8ArrayReader(encode(cards)));
  await writer.add("tags.msgpack", new Uint8ArrayReader(encode([])));
  await writer.add("metadata.msgpack", new Uint8ArrayReader(encode(createDefaultMetadata())));
  await writer.close();
  return output.getData();
}

/** 往盘上放一份快照。boards：白板文件 → 当时的卡片；more 是清单里另外要写的 */
function putSnapshot(name: string, at: string, boards: Record<string, unknown[]>, more: object = {}) {
  const folder = `${root}/.workbench/快照/${name}`;
  mocks.disk.set(
    `${folder}/清单.json`,
    JSON.stringify({
      v: 1,
      at,
      reason: "manual",
      project: "课题",
      boards: Object.keys(boards).map((file) => ({ file, cards: 0, sections: 0, edges: 0, images: {} })),
      ...more,
    }),
  );
  for (const [file, stage] of Object.entries(boards)) {
    mocks.disk.set(`${folder}/${file.replace(/\.prg$/, "")}.ai.json`, JSON.stringify(sidecar(stage, file)));
  }
}

const line = (at: string, kind: string, where: object, more?: object) =>
  JSON.stringify({ at, project: "课题", kind, where, title: "", ...(more && { more }) });
const day = (date: number, hour = 10) => localTime(new Date(2026, 10, date, hour));
const meeting = (title: string, more: object = {}) => ({ reason: "node", node: { type: "meeting", title, ...more } });

function fakeBoard(stage: unknown[], path = `${root}/白板.prg`) {
  return { uri: { scheme: "file", fsPath: path }, stage, loop: vi.fn() };
}

beforeEach(() => {
  mocks.root = root;
  mocks.disk.clear();
  store.set(stageReviewAtom, null);
  for (const mock of [mocks.flushed, mocks.taken, mocks.shown, mocks.hidden, mocks.droppedSet]) {
    mock.mockClear();
  }
});

describe("what gets listed", () => {
  it("lists new, edited and marked cards of this board, marked ones first", () => {
    const items = {
      old: { f: "1", title: "没动过", text: "" },
      fresh: { f: "2", title: "新想法", text: "试试 B 方法" },
      changed: { f: "3", title: "改过的结论", text: "" },
      flagged: { f: "4", title: "标成问题的旧卡片", text: "" },
      win: { f: "5", title: "标成进展的新卡片", text: "" },
    };
    const diff = { added: new Set(["fresh", "win"]), edited: new Set(["changed"]) };
    const listed = cardItems(root, "白板.prg", diff, items, { flagged: "problem", win: "progress", gone: "idea" });
    expect(listed.map(({ id, change, mark }) => [id, change, mark])).toEqual([
      ["win", "added", "progress"],
      // 只是标记过、内容没变的也列出来
      ["flagged", undefined, "problem"],
      ["fresh", "added", undefined],
      ["changed", "edited", undefined],
    ]);
    expect(listed[2]).toEqual({
      id: "fresh",
      kind: "card",
      title: "新想法",
      text: "试试 B 方法",
      change: "added",
      link: "rwb://open?project=课题&path=白板.prg&target=fresh",
    });
  });

  it("gives each other board with changes one line, and leaves out this board, deleted and unreadable ones", () => {
    const listed = boardItems(root, "白板.prg", [
      { board: "白板.prg", counts: { added: 3, edited: 0, removed: 0 } },
      { board: "子文件夹/第二块.prg", counts: { added: 1, edited: 2, removed: 0 } },
      { board: "没动.prg", counts: { added: 0, edited: 0, removed: 0 } },
      { board: "删了.prg", status: "gone", counts: { added: 0, edited: 0, removed: 4 } },
      { board: "坏的.prg", unreadable: true },
    ]);
    expect(listed).toEqual([
      {
        id: "子文件夹/第二块.prg",
        kind: "board",
        title: "第二块",
        counts: { added: 1, edited: 2, removed: 0 },
        link: "rwb://open?project=课题&path=子文件夹/第二块.prg",
      },
    ]);
  });

  it("merges the activity log into one line per paper and per note, and reads the marks", () => {
    const paper = { file: "论文/main.pdf" };
    const { papers, notes, marks } = logItems(root, [
      { kind: "annotation.add", where: { ...paper, page: 3, annotation: "A1" } },
      { kind: "annotation.add", where: { ...paper, page: 4, annotation: "A2" } },
      // 同一条批注又改了一次：还是一条
      { kind: "annotation.edit", where: { ...paper, page: 4, annotation: "A2" } },
      { kind: "excerpt.send", where: { board: "白板.prg", card: "c1", ...paper, page: 3, annotation: "A1" } },
      // 加了又删的不算；一条都没剩下的论文不列
      { kind: "annotation.add", where: { library: "Kim2025/paper.pdf", page: 1, annotation: "B1" } },
      { kind: "annotation.delete", where: { library: "Kim2025/paper.pdf", page: 1, annotation: "B1" } },
      { kind: "annotation.add", where: { library: "Bastek2024/paper.pdf", page: 5, annotation: "B7" } },
      { kind: "note.save", where: { file: "笔记/想法.md" } },
      { kind: "note.save", where: { file: "笔记/想法.md" } },
      // 程序生成的报告、项目外的笔记不算这段时间写的笔记
      { kind: "note.save", where: { file: "汇报/2026-11-21 组会/报告.md" } },
      { kind: "note.save", where: { file: "/Users/someone/我的进展/2026-11-14 阶段小结.md" } },
      // 后标的算数；认不出的标记不要
      { kind: "mark", where: { board: "白板.prg", card: "c1" }, more: { mark: "problem" } },
      { kind: "mark", where: { board: "白板.prg", card: "c1" }, more: { mark: "progress" } },
      { kind: "mark", where: { board: "白板.prg", card: "c2" }, more: { mark: "别的" } },
      { kind: "card.add", where: { board: "白板.prg", card: "c3" } },
    ]);
    expect(papers).toEqual([
      {
        id: "论文/main.pdf",
        kind: "paper",
        title: "main.pdf",
        counts: { annotations: 2, excerpts: 1 },
        link: "rwb://open?project=课题&path=论文/main.pdf",
      },
      {
        id: "library:Bastek2024/paper.pdf",
        kind: "paper",
        title: "paper.pdf",
        counts: { annotations: 1, excerpts: 0 },
        link: "rwb://open?library=1&path=Bastek2024/paper.pdf",
      },
    ]);
    expect(notes).toEqual([
      { id: "笔记/想法.md", kind: "note", title: "想法.md", link: "rwb://open?project=课题&path=笔记/想法.md" },
    ]);
    expect(marks).toEqual({ c1: "progress" });
  });

  it("keeps only the selected cards, or drops them, without touching the other lines", () => {
    const cards = ["a", "b", "c"].map((id) => ({ id, kind: "card" as const, title: id }));
    const dropped = new Set(["a", "笔记/想法.md"]);
    expect([...onlySelected(cards, new Set(["a", "b", "不在清单里的卡片"]), dropped)].sort()).toEqual([
      "c",
      "笔记/想法.md",
    ]);
    expect([...dropSelected(cards, new Set(["b", "不在清单里的卡片"]), dropped)].sort()).toEqual([
      "a",
      "b",
      "笔记/想法.md",
    ]);
  });
});

describe("reviewing a board", () => {
  const lastWeek = [text("old", "没动过"), text("c1", "原来的话")];
  const now = [text("old", "没动过"), text("c1", "改过的话"), text("junk", "随手试的废卡")];

  async function oneWeekOfWork() {
    putSnapshot("2026-11-07 1000", day(7), { "白板.prg": [] }, { reason: "auto" });
    putSnapshot(
      "2026-11-14 1000",
      day(14),
      { "白板.prg": lastWeek, "另一块.prg": [] },
      meeting("2026-11-14 组会", { since: "2026-11-07 1000" }),
    );
    mocks.disk.set(`${root}/白板.prg`, "盘上的旧文件，开着的白板不该去读它");
    mocks.disk.set(`${root}/另一块.prg`, await prg([text("t1", "另一块白板上新加的")]));
    mocks.disk.set(
      `${root}/.workbench/活动记录.jsonl`,
      [
        // 上个节点之前的事不算
        line(day(13), "annotation.add", { file: "论文/旧的.pdf", page: 1, annotation: "Z1" }),
        line(day(15), "annotation.add", { file: "论文/main.pdf", page: 3, annotation: "A1" }),
        line(day(16), "note.save", { file: "笔记/想法.md" }),
        line(day(17), "mark", { board: "白板.prg", card: "c1" }, { mark: "progress" }),
      ].join("\n") + "\n",
    );
  }

  it("compares with the last node and lists what happened elsewhere since then", async () => {
    await oneWeekOfWork();
    const board = fakeBoard(now);
    await enterStageReview(board as never);

    expect(mocks.flushed).toHaveBeenCalled();
    const state = store.get(stageReviewAtom)!;
    expect(state).toMatchObject({ board: "白板.prg", type: "meeting", note: "", marks: { c1: "progress" } });
    expect(state.base!.name).toBe("2026-11-14 1000");
    expect(state.others.map(({ id, kind, counts }) => ({ id, kind, counts }))).toEqual([
      { id: "另一块.prg", kind: "board", counts: { added: 1, edited: 0, removed: 0 } },
      { id: "论文/main.pdf", kind: "paper", counts: { annotations: 1, excerpts: 0 } },
      { id: "笔记/想法.md", kind: "note", counts: undefined },
    ]);
    // 画布换成题板的画法：和那个节点里这块白板的样子比，标记过的卡片亮着
    const [shownBoard, shownName, shownBase, marks] = mocks.shown.mock.calls[0];
    expect(shownBoard).toBe(board);
    expect(shownName).toBe("2026-11-14 1000");
    expect(shownBase.cards.map((card: { id: string; text: string }) => [card.id, card.text])).toEqual([
      ["old", "没动过"],
      ["c1", "原来的话"],
    ]);
    expect(marks).toEqual({ dropped: new Set(), lit: new Set(["c1"]) });
    expect(board.loop).toHaveBeenCalled();
  });

  it("freezes a node with what was kept, what was dropped and the user's words, then leaves", async () => {
    await oneWeekOfWork();
    const board = fakeBoard(now);
    await enterStageReview(board as never);
    setReviewNote("这周主要试了 B 方法");
    setReviewDropped(new Set(["junk", "笔记/想法.md"]));
    expect(mocks.droppedSet).toHaveBeenCalledWith(board, new Set(["junk", "笔记/想法.md"]));

    const cards = ["c1", "junk"].map((id) => ({ id, kind: "card" as const, title: id }));
    const frozen = { name: "2026-11-21 1000", manifest: { node: { title: "今天 meeting" } } };
    mocks.taken.mockResolvedValue(frozen);
    expect(await freezeStageReview(cards)).toBe(frozen);
    expect(mocks.taken).toHaveBeenCalledWith({
      type: "meeting",
      title: "今天 meeting",
      note: "这周主要试了 B 方法",
      picked: ["c1", "另一块.prg", "论文/main.pdf"],
      dropped: ["junk", "笔记/想法.md"],
    });
    expect(mocks.hidden).toHaveBeenCalledWith(board);
    expect(store.get(stageReviewAtom)).toBeNull();
    // 已经退出了：再定格、再退出都不做事
    expect(await freezeStageReview(cards)).toBeUndefined();
    leaveStageReview();
    expect(mocks.taken).toHaveBeenCalledOnce();
    expect(mocks.hidden).toHaveBeenCalledOnce();
  });

  it("keeps what the other boards' comparison found, for the report to use as material", async () => {
    await oneWeekOfWork();
    await enterStageReview(fakeBoard(now) as never);
    const other = store.get(stageReviewAtom)!.boards.find(({ board }) => board === "另一块.prg")!;
    expect(other.counts).toMatchObject({ added: 1, edited: 0, removed: 0 });
    expect(other.added!.map(({ text }) => text)).toEqual(["另一块白板上新加的"]);
  });

  it("picks up today's node again: same baseline, with what was dropped and written last time", async () => {
    await oneWeekOfWork();
    const today = localTime(new Date());
    const name = `${today.slice(0, 10)} 0900`;
    putSnapshot(
      name,
      today,
      { "白板.prg": now },
      meeting("今天 组会", { since: "2026-11-14 1000", note: "上午敲的话", dropped: ["junk"] }),
    );
    const board = fakeBoard(now);
    await enterStageReview(board as never);
    const state = store.get(stageReviewAtom)!;
    expect(state.base!.name).toBe("2026-11-14 1000");
    expect(state.note).toBe("上午敲的话");
    expect([...state.dropped]).toEqual(["junk"]);

    // 换成另一种类型：今天没定格过这一种，和上一个节点（今天上午那份）比；敲到一半的话带着
    await enterStageReview(board as never, "review", "敲到一半的话");
    expect(store.get(stageReviewAtom)).toMatchObject({ type: "review", note: "敲到一半的话", base: { name } });
    expect([...store.get(stageReviewAtom)!.dropped]).toEqual([]);

    // 上午那份记着的基准已经被删掉：退回再往前的那个节点
    for (const path of [...mocks.disk.keys()]) if (path.includes("/2026-11-14 1000/")) mocks.disk.delete(path);
    await enterStageReview(board as never);
    expect(store.get(stageReviewAtom)!.base!.name).toBe("2026-11-07 1000");
  });

  it("treats every card as new when the project has no snapshot yet, and says why it cannot start", async () => {
    mocks.disk.set(`${root}/.workbench/活动记录.jsonl`, line(day(2), "note.save", { file: "笔记/很早写的.md" }) + "\n");
    const board = fakeBoard(now);
    await enterStageReview(board as never);
    const state = store.get(stageReviewAtom)!;
    expect(state.base).toBeUndefined();
    expect(state.others.map(({ id }) => id)).toEqual(["笔记/很早写的.md"]);
    expect(state.boards).toEqual([]);
    expect(mocks.shown).toHaveBeenCalledWith(board, "", undefined, { dropped: new Set(), lit: new Set() });
    leaveStageReview();

    await expect(enterStageReview(fakeBoard(now, "/别处/白板.prg") as never)).rejects.toThrow("stageReview.outside");
    mocks.root = "";
    await expect(enterStageReview(board as never)).rejects.toThrow("stageSummary.noProject");
    expect(store.get(stageReviewAtom)).toBeNull();
  });
});
