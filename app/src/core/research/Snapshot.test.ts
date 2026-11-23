import { parseProjectFile } from "@/core/ProjectFile";
import { createDefaultMetadata } from "@/types/metadata";
import { Decoder, encode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "/research",
  boards: [] as { uri: { fsPath: string }; getFileContent: () => Promise<Uint8Array> }[],
  files: [] as { kind: string; absPath: string }[],
  disk: new Map<string, Uint8Array>(),
  noted: vi.fn(),
  warn: vi.fn(),
  watchers: [] as (() => void)[],
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    watch: (_key: string, listener: () => void) => {
      mocks.watchers.push(listener);
      return () => mocks.watchers.splice(mocks.watchers.indexOf(listener), 1);
    },
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (path: string) =>
    mocks.disk.has(path) || [...mocks.disk.keys()].some((file) => file.startsWith(`${path}/`)),
  mkdir: async () => {},
  readDir: async (path: string) =>
    [
      ...new Set(
        [...mocks.disk.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1)),
      ),
    ].map((rest) => ({ name: rest.split("/")[0], isDirectory: rest.includes("/") })),
  readFile: async (path: string) => mocks.disk.get(path)!,
  writeFile: async (path: string, bytes: Uint8Array) => void mocks.disk.set(path, bytes),
}));
vi.mock("sonner", () => ({ toast: { warning: mocks.warn } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("./ActivityLog", async (original) => ({
  ...(await original<typeof import("./ActivityLog")>()),
  noteSnapshot: mocks.noted,
  trackedBoards: () => mocks.boards,
}));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => mocks.root,
    ensureRootRegistered: async () => {},
    listFiles: async () => mocks.files,
    isInside: (path: string, root: string = mocks.root) => path.startsWith(`${root}/`),
    toRelative: (path: string, root: string = mocks.root) => path.slice(root.length + 1),
    toAbsolute: (path: string, root: string = mocks.root) => (path.startsWith("/") ? path : `${root}/${path}`),
  },
}));

import { baselineOf, isNode, localTime, nodeSince, replacedNodes, sinceOf } from "./ProjectRecord";
import {
  currentBaseline,
  latestSnapshot,
  listSnapshots,
  nodeTitle,
  onSnapshotTaken,
  readSnapshotBoard,
  snapshotFiles,
  snapshotIfDue,
  startSnapshotSchedule,
  takeNode,
  takeSnapshot,
  writeSnapshot,
  type SnapshotIO,
} from "./Snapshot";
import { readSnapshotBoardContent } from "./SnapshotBoard";

const box = { _: "CollisionBox", shapes: [] };
const text = (uuid: string, value: string) => ({ _: "TextNode", uuid, text: value, collisionBox: box });
const png = (...bytes: number[]) => new Uint8Array([137, 80, 78, 71, ...bytes]);

/** 一个真的白板文件：卡片、信息、图片附件、缩略图 */
async function prg(cards: unknown[], attachments: Record<string, Uint8Array> = {}): Promise<Uint8Array> {
  const output = new Uint8ArrayWriter();
  const writer = new ZipWriter(output, { level: 0 });
  await writer.add("stage.msgpack", new Uint8ArrayReader(encode(cards)));
  await writer.add("tags.msgpack", new Uint8ArrayReader(encode([])));
  await writer.add("metadata.msgpack", new Uint8ArrayReader(encode(createDefaultMetadata())));
  for (const [name, bytes] of Object.entries(attachments)) {
    await writer.add(`attachments/${name}`, new Uint8ArrayReader(bytes));
  }
  await writer.add("thumbnail.png", new Uint8ArrayReader(png(9, 9, 9)));
  await writer.close();
  return output.getData();
}

async function entries(content: Uint8Array): Promise<Map<string, Uint8Array>> {
  const reader = new ZipReader(new Uint8ArrayReader(content));
  const files = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) files.set(entry.filename, await entry.getData!(new Uint8ArrayWriter()));
  }
  await reader.close();
  return files;
}

function memory() {
  const files = new Map<string, Uint8Array>();
  const io: SnapshotIO = {
    read: async (path) => files.get(path),
    write: async (path, bytes) => void files.set(path, bytes),
    exists: async (path) => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
    folders: async (path) => [
      ...new Set(
        [...files.keys()]
          .filter((file) => file.startsWith(`${path}/`) && file.slice(path.length + 1).includes("/"))
          .map((file) => file.slice(path.length + 1).split("/")[0]),
      ),
    ],
  };
  const under = (prefix: string) => [...files.keys()].filter((file) => file.startsWith(prefix)).sort();
  return { files, io, under };
}

const base = "/research/.workbench/快照";
const at = (day: number, hour = 10, minute = 30) => new Date(2026, 10, day, hour, minute, 12);

beforeEach(() => {
  mocks.root = "/research";
  mocks.boards = [];
  mocks.files = [];
  mocks.disk.clear();
  mocks.noted.mockClear();
  mocks.warn.mockClear();
});

describe("taking a snapshot", () => {
  it("keeps each board without its pictures, a text version beside it, and every picture once by content", async () => {
    const { io, under, files } = memory();
    const figure = png(1, 2, 3);
    const snapshot = await writeSnapshot(
      io,
      "/research",
      "manual",
      [
        // 同一张图粘贴了两次：附件编号不同，内容一样
        { file: "主画布.prg", content: await prg([text("a", "想法")], { "id-1.png": figure, "id-2.png": figure }) },
        { file: "sub/第二块.prg", content: await prg([], { "id-3.png": figure, "id-4.webp": png(7) }) },
      ],
      { now: at(21) },
    );
    expect(snapshot!.name).toBe("2026-11-21 1030");
    expect(under(`${base}/2026-11-21 1030/`).map((path) => path.slice(base.length + 17))).toEqual([
      "sub/第二块.ai.json",
      "sub/第二块.prg",
      "主画布.ai.json",
      "主画布.prg",
      "清单.json",
    ]);
    // 四个附件，两种内容，只有两个图片文件
    const images = under(`${base}/图片/`);
    expect(images).toHaveLength(2);
    expect(images.map((path) => path.split(".").pop()).sort()).toEqual(["png", "webp"]);
    expect([...(await entries(files.get(`${base}/2026-11-21 1030/主画布.prg`)!)).keys()].sort()).toEqual([
      "metadata.msgpack",
      "stage.msgpack",
      "tags.msgpack",
    ]);

    const { manifest } = snapshot!;
    expect(manifest).toMatchObject({ v: 1, reason: "manual", project: "research" });
    expect(manifest.at).toMatch(/^2026-11-21T10:30:12/);
    expect(manifest.boards[0]).toMatchObject({ file: "主画布.prg", cards: 1, sections: 0, edges: 0 });
    expect(manifest.boards[0].images["id-1"]).toBe(manifest.boards[0].images["id-2"]);
    expect(manifest.boards[1].images["id-3"]).toBe(manifest.boards[0].images["id-1"]);
    expect((await readSnapshotBoard(io, "/research", snapshot!.name, "主画布.prg"))!.cards[0]).toMatchObject({
      id: "a",
      text: "想法",
    });
    expect(await readSnapshotBoard(io, "/research", snapshot!.name, "没有这块.prg")).toBeUndefined();
  });

  it("does not write a picture again that an earlier snapshot already stored", async () => {
    const { io, under } = memory();
    const write = vi.spyOn(io, "write");
    const board = async () => [{ file: "a.prg", content: await prg([text("a", "一")], { "x.png": png(5, 5) }) }];
    await writeSnapshot(io, "/research", "manual", await board(), { now: at(14) });
    write.mockClear();
    await writeSnapshot(io, "/research", "manual", await board(), { now: at(21) });
    expect(write.mock.calls.map(([path]) => path).filter((path) => path.includes("/图片/"))).toEqual([]);
    expect(under(`${base}/图片/`)).toHaveLength(1);
  });

  it("gives back everything that was on the board, pictures included", async () => {
    const { io } = memory();
    const original = await prg([text("a", "一")], { "id-1.png": png(1), "id-2.webp": png(2, 2) });
    const snapshot = await writeSnapshot(io, "/research", "manual", [{ file: "a.prg", content: original }], {
      now: at(21),
    });
    const { stripped, images } = (await readSnapshotBoardContent(io, "/research", snapshot!, "a.prg"))!;
    const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
    const [before, after] = [new Map<string, Blob>(), new Map<string, Blob>()];
    const expected = await parseProjectFile(original, new Decoder(), before);
    expect(await parseProjectFile(stripped, new Decoder(), after)).toEqual(expected);
    expect(after.size).toBe(0);
    expect([...images.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, image] of before) {
      expect(await bytes(images.get(id)!), id).toEqual(await bytes(image));
      expect(images.get(id)!.type).toBe(image.type);
    }
  });

  it("lists snapshots newest first, numbers a second one in the same minute, and ignores a half-written one", async () => {
    const { io, files } = memory();
    const board = async (value: string) => [{ file: "a.prg", content: await prg([text("a", value)]) }];
    await writeSnapshot(io, "/research", "manual", await board("一"), { now: at(14) });
    await writeSnapshot(io, "/research", "auto", await board("二"), { now: at(21) });
    await writeSnapshot(io, "/research", "manual", await board("三"), { now: at(21) });
    // 拍到一半断电：有白板文件，没有清单；还有一份清单只写了半截
    files.set(`${base}/2026-11-22 0900/a.prg`, new Uint8Array([1]));
    files.set(`${base}/2026-11-23 0900/清单.json`, new TextEncoder().encode('{"v":1,"boards":['));
    const snapshots = await listSnapshots(io, "/research");
    expect(snapshots.map(({ name, manifest }) => [name, manifest.reason])).toEqual([
      ["2026-11-21 1030-2", "manual"],
      ["2026-11-21 1030", "auto"],
      ["2026-11-14 1030", "manual"],
    ]);
    expect(await listSnapshots(io, "/research", 1)).toHaveLength(1);
    expect(await listSnapshots(io, "/elsewhere")).toEqual([]);
  });

  it("skips an automatic snapshot when nothing changed, or when the project has no cards yet", async () => {
    const { io } = memory();
    const boards = async (value: string) => [
      { file: "a.prg", content: await prg([text("a", value)]) },
      { file: "b.prg", content: await prg([]) },
    ];
    expect(
      await writeSnapshot(io, "/research", "auto", [{ file: "a.prg", content: await prg([]) }], { unlessEmpty: true }),
    ).toBeUndefined();
    const first = await writeSnapshot(io, "/research", "auto", await boards("一"), { now: at(14), unlessEmpty: true });
    expect(first).toBeDefined();
    expect(
      await writeSnapshot(io, "/research", "auto", await boards("一"), { now: at(21), unlessSameAs: first }),
    ).toBeUndefined();
    // 改了一张卡片；或者多了一块白板
    expect(
      await writeSnapshot(io, "/research", "auto", await boards("改了"), { now: at(21), unlessSameAs: first }),
    ).toBeDefined();
    const more = [...(await boards("一")), { file: "c.prg", content: await prg([]) }];
    expect(await writeSnapshot(io, "/research", "auto", more, { now: at(22), unlessSameAs: first })).toBeDefined();
    expect(await writeSnapshot(io, "/research", "manual", [])).toBeUndefined();
  });
});

describe("nodes", () => {
  const board = async (value: string) => [{ file: "a.prg", content: await prg([text("a", value)]) }];
  const meeting = (title: string) => ({ type: "meeting" as const, title });

  it("compares a node with the node before it, never with an automatic or manual snapshot in between", async () => {
    const { io } = memory();
    await writeSnapshot(io, "/research", "auto", await board("一"), { now: at(1) });
    // 一个节点都没有：和最早的那份快照比
    const first = (await writeSnapshot(io, "/research", "node", await board("二"), {
      now: at(7),
      node: meeting("2026-11-07 组会"),
    }))!;
    expect(first.manifest.node).toEqual({ type: "meeting", title: "2026-11-07 组会", since: "2026-11-01 1030" });
    await writeSnapshot(io, "/research", "auto", await board("三"), { now: at(10) });
    await writeSnapshot(io, "/research", "manual", await board("四"), { now: at(12) });
    expect(baselineOf(await listSnapshots(io, "/research"))!.name).toBe(first.name);
    const second = (await writeSnapshot(io, "/research", "node", await board("五"), {
      now: at(14),
      node: { ...meeting("2026-11-14 组会"), note: "  试了 B 方法  ", picked: ["a"], dropped: [] },
    }))!;
    // 原话去掉两头的空白；空的勾选不写
    expect(second.manifest.node).toEqual({
      type: "meeting",
      title: "2026-11-14 组会",
      since: first.name,
      note: "试了 B 方法",
      picked: ["a"],
    });
    expect(baselineOf(await listSnapshots(io, "/research"))!.name).toBe(second.name);
  });

  it("treats a second freeze on the same day with the same type as the same node and keeps its baseline", async () => {
    const { io } = memory();
    const start = (await writeSnapshot(io, "/research", "node", await board("一"), {
      now: at(7),
      node: meeting("2026-11-07 组会"),
    }))!;
    // 前面一份快照都没有：没有可以比的
    expect(start.manifest.node).toEqual({ type: "meeting", title: "2026-11-07 组会" });
    const freeze = async (value: string, hour: number, type: "meeting" | "review" = "meeting") =>
      (await writeSnapshot(io, "/research", "node", await board(value), {
        now: at(14, hour),
        node: { type, title: "2026-11-14" },
      }))!;
    const morning = await freeze("二", 9);
    const evening = await freeze("三", 18);
    expect(morning.manifest.node!.since).toBe(start.name);
    expect(evening.manifest.node!.since).toBe(start.name);
    // 同一天换一种类型：是另一个节点，和上一个节点比
    const review = await freeze("四", 20, "review");
    expect(review.manifest.node!.since).toBe(evening.name);
    const all = await listSnapshots(io, "/research");
    expect([...replacedNodes(all)]).toEqual([[morning.name, evening.name]]);
    // 第二天再定格：和前一天最后那个节点比
    expect(nodeSince(all, "meeting", localTime(at(15)))).toBe(review.name);
    // 当天第一次定格就没有可比的，再定格一次也一样
    expect(nodeSince(all, "meeting", localTime(at(7, 20)))).toBeUndefined();
  });

  it("counts a summary snapshot taken before nodes existed as a node", async () => {
    const { io } = memory();
    await writeSnapshot(io, "/research", "manual", await board("一"), { now: at(1) });
    const old = (await writeSnapshot(io, "/research", "summary", await board("二"), { now: at(7) }))!;
    await writeSnapshot(io, "/research", "auto", await board("三"), { now: at(10) });
    const all = await listSnapshots(io, "/research");
    expect(old.manifest.node).toBeUndefined();
    expect(all.map(isNode)).toEqual([false, true, false]);
    expect(baselineOf(all)!.name).toBe(old.name);
    expect(sinceOf(all, old)).toBe("2026-11-01 1030");
    // 同一天再定格一次组会：接着用它的基准
    expect(nodeSince(all, "meeting", localTime(at(7, 20)))).toBe("2026-11-01 1030");
    expect(baselineOf([])).toBeUndefined();
  });
});

describe("snapshots of the current project", () => {
  const boardFile = (path: string) => ({ kind: "workspace", absPath: path });

  it("uses the current content of open boards, reads closed ones from disk, and tells whoever listens", async () => {
    mocks.files = [
      boardFile("/research/开着.prg"),
      boardFile("/research/没开.prg"),
      { kind: "pdf", absPath: "/research/a.pdf" },
    ];
    mocks.disk.set("/research/开着.prg", await prg([text("a", "盘上的旧内容")]));
    mocks.disk.set("/research/没开.prg", await prg([text("b", "没开的")]));
    const current = await prg([text("a", "还没存的新内容")]);
    mocks.boards = [{ uri: { fsPath: "/research/开着.prg" }, getFileContent: async () => current }];
    const heard = vi.fn();
    const off = onSnapshotTaken(heard);

    const snapshot = (await takeSnapshot("manual"))!;
    expect(snapshot.manifest.boards.map(({ file }) => file)).toEqual(["开着.prg", "没开.prg"]);
    expect((await readSnapshotBoard(snapshotFiles, "/research", snapshot.name, "开着.prg"))!.cards[0].text).toBe(
      "还没存的新内容",
    );
    expect(heard).toHaveBeenCalledWith(snapshot);
    expect(mocks.noted).toHaveBeenCalledWith("/research", snapshot.name, { reason: "manual", boards: 2, cards: 2 });
    expect((await latestSnapshot())!.name).toBe(snapshot.name);
    off();
  });

  it("refuses when there is no project or no board", async () => {
    await expect(takeSnapshot("manual")).rejects.toThrow("snapshot.noBoard");
    mocks.root = "";
    await expect(takeSnapshot("manual")).rejects.toThrow("snapshot.noProject");
    expect(await latestSnapshot()).toBeUndefined();
    expect(await currentBaseline()).toBeUndefined();
    expect(await snapshotIfDue()).toBeUndefined();
  });

  it("freezes a node, waiting for a snapshot already being taken instead of handing that one back", async () => {
    mocks.files = [boardFile("/research/a.prg")];
    mocks.disk.set("/research/a.prg", await prg([text("a", "一")]));
    const title = nodeTitle("weekly", at(21));
    expect(title).toBe("2026-11-21 stageNode.types.weekly");
    const plain = takeSnapshot("auto");
    const frozen = takeNode({ type: "weekly", title });
    const first = (await plain)!;
    const node = (await frozen)!;
    expect(first.manifest.node).toBeUndefined();
    expect(node.name).not.toBe(first.name);
    expect(node.manifest).toMatchObject({ reason: "node", node: { type: "weekly", title, since: first.name } });
    expect(mocks.noted).toHaveBeenLastCalledWith("/research", node.name, {
      reason: "node",
      boards: 1,
      cards: 1,
      node: title,
    });
    // 之后的对比和这个节点比；再拍一份留底的不换基准
    expect((await currentBaseline())!.name).toBe(node.name);
    await takeSnapshot("manual");
    expect((await currentBaseline())!.name).toBe(node.name);
  });

  it("takes one automatically when none exists or the last is over seven days old, and only if a board changed", async () => {
    mocks.files = [boardFile("/research/a.prg")];
    mocks.disk.set("/research/a.prg", await prg([]));
    // 一张卡片都没有：不拍第一份
    expect(await snapshotIfDue(at(1))).toBeUndefined();
    mocks.disk.set("/research/a.prg", await prg([text("a", "一")]));
    const first = (await snapshotIfDue(new Date()))!;
    expect(first.manifest.reason).toBe("auto");
    const taken = Date.parse(first.manifest.at);
    mocks.disk.set("/research/a.prg", await prg([text("a", "一"), text("b", "二")]));
    // 才过了六天：不拍
    expect(await snapshotIfDue(new Date(taken + 6 * 24 * 3600 * 1000))).toBeUndefined();
    const second = await snapshotIfDue(new Date(taken + 8 * 24 * 3600 * 1000));
    expect(second).toBeDefined();
    // 又过了很久，但白板没再动过：不拍
    expect(await snapshotIfDue(new Date(taken + 30 * 24 * 3600 * 1000))).toBeUndefined();
  });

  it("checks a little after start, again after switching project, and only warns when it fails", async () => {
    vi.useFakeTimers();
    try {
      mocks.files = [boardFile("/research/a.prg")];
      const stop = startSnapshotSchedule();
      // 白板文件读不出来
      mocks.disk.set("/research/a.prg", new Uint8Array([1, 2, 3]));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.warn).toHaveBeenCalledWith("snapshot.failed", { id: "research-snapshot-failed" });
      mocks.disk.set("/research/a.prg", await prg([text("a", "一")]));
      for (const changed of mocks.watchers) changed();
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await latestSnapshot())?.manifest.reason).toBe("auto");
      stop();
      expect(mocks.watchers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
