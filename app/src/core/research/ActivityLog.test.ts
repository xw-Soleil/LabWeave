import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "/research",
  settings: { literatureLibraryPath: "/library" },
  warn: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({ Settings: mocks.settings }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { warning: mocks.warn } }));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@graphif/serializer", () => ({ serialize: (stage: unknown) => stage }));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => mocks.root,
    isInside: (path: string, root: string = mocks.root) => path.startsWith(`${root}/`),
    toRelative: (path: string, root: string = mocks.root) => path.slice(root.length + 1),
    // 和真的一样：完整路径原样用，相对路径接在 root 后面，并把 .. 消掉
    toAbsolute: (path: string, root: string = mocks.root) => {
      const parts: string[] = [];
      for (const part of (path.startsWith("/") ? path : `${root}/${path}`).split("/").filter(Boolean)) {
        if (part === "..") parts.pop();
        else parts.push(part);
      }
      return `/${parts.join("/")}`;
    },
  },
}));

/** 当天某个钟点的时间，写成批注里存的那种格式。用本地时间拼，换个时区跑顺序也不变 */
const clock = (hour: number, minute: number) => new Date(2026, 10, 15, hour, minute).toISOString();

import {
  ACTIVITY_LOG_FILE,
  ACTIVITY_STATE_FILE,
  ActivityRecorder,
  annotationItems,
  boardItems,
  diffItems,
  flushActivityLog,
  localTime,
  noteCardMarks,
  noteDocument,
  noteLibraryItem,
  startActivityLog,
  trackActivityBoards,
  type ActivityEntry,
  type ActivityIO,
} from "./ActivityLog";

const box = { _: "CollisionBox", shapes: [] };
const text = (uuid: string, value: string, extra: object = {}) => ({
  _: "TextNode",
  uuid,
  text: value,
  collisionBox: box,
  ...extra,
});
const quote = (uuid: string, sourcePath: string, excerpt: string) => ({
  _: "FileCardNode",
  uuid,
  title: "main",
  sourcePath,
  fileKind: "pdf",
  excerpt,
  caption: "main · 第 3 页",
  pdfPage: 3,
  pdfAnnotation: "ANNO1",
  collisionBox: box,
});
const board = { path: "/research/boards/主画布.prg", root: "/research", library: "/library" };
const items = (stage: unknown[]) => boardItems(stage, board);

function memory() {
  const files = new Map<string, string>();
  const io: ActivityIO & { fail?: "append" | "write" } = {
    read: async (path) => files.get(path),
    append: async (path, value) => {
      if (io.fail === "append") throw new Error("disk full");
      files.set(path, (files.get(path) ?? "") + value);
    },
    write: async (path, value) => {
      if (io.fail === "write") throw new Error("disk full");
      files.set(path, value);
    },
  };
  const log = (root = "/research"): ActivityEntry[] =>
    (files.get(`${root}/${ACTIVITY_LOG_FILE}`) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { files, io, log };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 15, 10, 30, 0));
  mocks.root = "/research";
  mocks.warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what counts as a change", () => {
  it("fingerprints a card by its content, not by where it sits or what it looks like", () => {
    const before = items([text("a", "扩散模型\n第二行", { collisionBox: { ...box, shapes: [1] }, color: "red" })]);
    const moved = items([text("a", "扩散模型\n第二行", { collisionBox: { ...box, shapes: [2] }, color: "blue" })]);
    expect(moved.a.f).toBe(before.a.f);
    expect(before.a).toMatchObject({ title: "扩散模型", text: "扩散模型\n第二行", more: { type: "TextNode" } });
    expect(items([text("a", "扩散模型\n改了第二行")]).a.f).not.toBe(before.a.f);
  });

  it("treats a cut-and-paste (same content under a new id) as the same card", () => {
    const before = items([text("a", "留着"), text("b", "被剪切"), text("c", "真删了")]);
    const after = items([text("a", "留着，改了"), text("b2", "被剪切"), text("d", "新加的")]);
    expect(diffItems(before, after)).toEqual({ added: ["d"], edited: ["a"], removed: ["c"] });
  });

  it("knows where an excerpt card came from, also inside a group and for a paper in the library", () => {
    const stage = [
      {
        _: "Section",
        uuid: "s",
        text: "方法",
        _collisionBoxNormal: box,
        children: [quote("q1", "../论文/main.pdf", "原文")],
      },
      { $: "/0/children/0" },
      quote("q2", "/library/Bastek2024/paper.pdf", "另一段"),
    ];
    const result = items(stage);
    expect(result.q1.source).toEqual({ file: "论文/main.pdf", page: 3, annotation: "ANNO1" });
    expect(result.q2.source).toEqual({ library: "Bastek2024/paper.pdf", page: 3, annotation: "ANNO1" });
    expect(result.s).toMatchObject({ title: "方法", more: { type: "Section" } });
  });

  it("lists the user's own annotations with their page, colour and note", () => {
    const annotation = (id: string, extra: object = {}) =>
      ({
        id,
        type: "highlight",
        color: "#ffd400",
        text: "We propose…",
        comment: "",
        tags: [],
        pageLabel: "3",
        position: { pageIndex: 2 },
        dateCreated: "2026-11-15T01:00:00.000Z",
        dateModified: "2026-11-15T01:00:00.000Z",
        ...extra,
      }) as never;
    const result = annotationItems([
      annotation("a"),
      annotation("b", { comment: "这里没看懂", pageLabel: "iii" }),
      annotation("embedded", { readOnly: true }),
    ]);
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(result.a).toMatchObject({ page: 3, text: "We propose…", more: { type: "highlight", color: "#ffd400" } });
    expect(result.b.more).toMatchObject({ comment: "这里没看懂", pageLabel: "iii" });
    expect(result.b.f).not.toBe(result.a.f);
  });

  it("writes times with the local offset", () => {
    expect(localTime(new Date(2026, 10, 15, 9, 5, 7))).toMatch(/^2026-11-15T09:05:07[+-]\d\d:\d\d$/);
  });
});

describe("recording", () => {
  it("only notes the present state the first time it sees a board, then records what changed", async () => {
    const { io, log, files } = memory();
    const recorder = new ActivityRecorder(io);
    recorder.observeBoard("/research", "boards/主画布.prg", () =>
      items([text("a", "已有的"), text("b", "也是已有的")]),
    );
    await recorder.flush();
    expect(log()).toEqual([]);
    expect(JSON.parse(files.get(`/research/${ACTIVITY_STATE_FILE}`)!).boards["boards/主画布.prg"]).toHaveProperty("a");

    recorder.observeBoard("/research", "boards/主画布.prg", () =>
      items([text("a", "已有的，改了"), text("c", "新想法"), quote("q", "../论文/main.pdf", "摘的一段")]),
    );
    await recorder.flush();
    expect(log().map(({ kind, where, title }) => ({ kind, where, title }))).toEqual([
      { kind: "card.add", where: { board: "boards/主画布.prg", card: "c" }, title: "新想法" },
      {
        kind: "excerpt.send",
        where: { board: "boards/主画布.prg", card: "q", file: "论文/main.pdf", page: 3, annotation: "ANNO1" },
        title: "main · 第 3 页",
      },
      { kind: "card.edit", where: { board: "boards/主画布.prg", card: "a" }, title: "已有的，改了" },
      { kind: "card.delete", where: { board: "boards/主画布.prg", card: "b" }, title: "也是已有的" },
    ]);
    expect(log()[0]).toMatchObject({ project: "research", text: "新想法", more: { type: "TextNode" } });
    expect(log()[0].at).toMatch(/^2026-11-15T10:30:00/);
  });

  it("writes one line for a card that was saved many times, two minutes after the last save", async () => {
    const { io, log } = memory();
    const recorder = new ActivityRecorder(io);
    recorder.observeBoard("/research", "a.prg", () => items([]));
    for (const typed of ["扩", "扩散", "扩散模型的边界条件"]) {
      vi.advanceTimersByTime(10_000);
      recorder.observeBoard("/research", "a.prg", () => items([text("a", typed)]));
    }
    await vi.advanceTimersByTimeAsync(119_000);
    expect(log()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log().map(({ kind, title }) => [kind, title])).toEqual([["card.add", "扩散模型的边界条件"]]);
  });

  it("does not wait longer than ten minutes while the saves keep coming", async () => {
    const { io, log } = memory();
    const recorder = new ActivityRecorder(io);
    recorder.observeBoard("/research", "a.prg", () => items([]));
    for (let minute = 1; minute <= 9; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      recorder.observeBoard("/research", "a.prg", () => items([text("a", `第 ${minute} 分钟`)]));
    }
    expect(log()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log().map(({ title }) => title)).toEqual(["第 9 分钟"]);
  });

  it("leaves nothing behind for a card that was added and removed again before the batch was written", async () => {
    const { io, log } = memory();
    const recorder = new ActivityRecorder(io);
    recorder.observeBoard("/research", "a.prg", () => items([text("a", "原有")]));
    recorder.observeBoard("/research", "a.prg", () => items([text("a", "原有"), text("b", "手滑")]));
    recorder.observeBoard("/research", "a.prg", () => items([text("a", "原有")]));
    await recorder.flush();
    expect(log()).toEqual([]);
  });

  it("catches up after a crash or an edit made elsewhere: the state on disk is the starting point", async () => {
    const { io, log } = memory();
    const first = new ActivityRecorder(io);
    first.observeBoard("/research", "a.prg", () => items([text("a", "一")]));
    await first.flush();
    // 程序重开（或者外面的 AI 直接改了文件）：新的记录器从磁盘上的「记到哪」接着比
    const second = new ActivityRecorder(io);
    second.observeBoard("/research", "a.prg", () => items([text("a", "一"), text("b", "别处加的")]));
    await second.flush();
    expect(log().map(({ kind, title }) => [kind, title])).toEqual([["card.add", "别处加的"]]);
  });

  it("records annotations with their own times, notes with their size, and skips a save that changed nothing", async () => {
    const { io, log } = memory();
    const recorder = new ActivityRecorder(io);
    const where = { file: "论文/main.pdf" };
    const item = (f: string, extra: object = {}) => ({ f, title: "", text: "原文", page: 3, ...extra });
    recorder.observeAnnotations("/research", "main", where, "main.pdf", { old: item("1") });
    recorder.observeAnnotations("/research", "main", where, "main.pdf", {
      old: item("2", { modified: clock(9, 10), more: { comment: "补了一句" } }),
      fresh: item("3", { created: clock(9, 5), modified: clock(9, 6) }),
    });
    recorder.observeNote("/research", "n", { file: "笔记/想法.md" }, "想法.md", "第一版");
    await recorder.flush();
    recorder.observeAnnotations("/research", "main", where, "main.pdf", {});
    recorder.observeNote("/research", "n", { file: "笔记/想法.md" }, "想法.md", "第一版");
    await recorder.flush();
    recorder.observeNote("/research", "n", { file: "笔记/想法.md" }, "想法.md", "第一版，又写了几句");
    await recorder.flush();

    const lines = log();
    expect(lines.map(({ kind }) => kind)).toEqual([
      "annotation.add",
      "annotation.edit",
      "note.save",
      "annotation.delete",
      "annotation.delete",
      "note.save",
    ]);
    // 批注用它自己记的时间（9:05 划的、9:10 改的），不是程序看到它的时间（10:30）
    expect(lines[0]).toMatchObject({
      where: { file: "论文/main.pdf", page: 3, annotation: "fresh" },
      title: "main.pdf",
      text: "原文",
    });
    expect(lines[0].at).toMatch(/^2026-11-15T09:05:00/);
    expect(lines[1]).toMatchObject({ more: { comment: "补了一句" } });
    expect(lines[1].at).toMatch(/^2026-11-15T09:10:00/);
    expect(lines[2].at).toMatch(/^2026-11-15T10:30:00/);
    expect(lines[2].more).toEqual({ chars: 3 });
    expect(lines[5].more).toEqual({ chars: 9, delta: 6 });
  });

  it("keeps what could not be written and writes it once the disk works again, without duplicates", async () => {
    const { io, log } = memory();
    const onError = vi.fn();
    const recorder = new ActivityRecorder(io, { onError });
    recorder.observeBoard("/research", "a.prg", () => items([]));
    await recorder.flush();
    io.fail = "append";
    recorder.observeBoard("/research", "a.prg", () => items([text("a", "写不进去的")]));
    recorder.add("/research", { kind: "library.add", where: { library: "Paper2024" }, title: "一篇论文" });
    await recorder.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(log()).toEqual([]);
    // 记录写进去了、「记到哪」没存上：这次运行里不能再记一遍
    io.fail = "write";
    await recorder.flush();
    expect(log().map(({ kind }) => kind)).toEqual(["library.add", "card.add"]);
    io.fail = undefined;
    await recorder.flush();
    recorder.observeBoard("/research", "a.prg", () => items([text("a", "写不进去的")]));
    await recorder.flush();
    expect(log()).toHaveLength(2);
  });

  it("starts over from the present state when the state file is damaged, and says so", async () => {
    const { io, log, files } = memory();
    files.set(`/research/${ACTIVITY_STATE_FILE}`, '{"v":1,"boards":{"a.prg":');
    const onError = vi.fn();
    const recorder = new ActivityRecorder(io, { onError });
    recorder.observeBoard("/research", "a.prg", () => items([text("a", "一")]));
    await recorder.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(log()).toEqual([]);
  });

  it("keeps each project's record in its own folder", async () => {
    const { io, log } = memory();
    const recorder = new ActivityRecorder(io);
    for (const root of ["/research", "/other"]) recorder.observeBoard(root, "a.prg", () => items([]));
    await recorder.flush();
    recorder.observeBoard("/other", "a.prg", () => boardItems([text("x", "另一个项目")], { ...board, root: "/other" }));
    await recorder.flush();
    expect(log("/research")).toEqual([]);
    expect(log("/other")).toMatchObject([{ project: "other", kind: "card.add" }]);
  });
});

describe("hooks in the program", () => {
  const fakeBoard = (path: string, stage: unknown[]) => {
    const listeners = new Set<(event: unknown) => void>();
    return {
      uri: { scheme: "file", fsPath: path },
      stage,
      on: (_name: string, listener: (event: unknown) => void) => listeners.add(listener),
      off: (_name: string, listener: (event: unknown) => void) => listeners.delete(listener),
      save(next: unknown[]) {
        for (const listener of listeners) listener({ uri: this.uri, serializedStage: next });
      },
      listeners,
    };
  };

  it("does nothing until it is started, so other modules and the command line are unaffected", async () => {
    const opened = fakeBoard("/research/a.prg", []);
    trackActivityBoards([opened as never]);
    noteDocument({ path: "/research/a.md", kind: "markdown", markdown: { text: "x", dirty: false } } as never);
    noteLibraryItem({ dir: "/library/P", title: "P" } as never, "/library");
    await flushActivityLog();
    expect(opened.listeners.size).toBe(0);
  });

  it("follows open boards, documents and the library once started, and writes on close", async () => {
    const { io, log } = memory();
    const stop = startActivityLog(io);
    const inside = fakeBoard("/research/a.prg", [text("a", "已有")]);
    const outside = fakeBoard("/elsewhere/tmp.prg", []);
    const draft = { ...fakeBoard("draft", []), uri: { scheme: "draft", fsPath: "1" } };
    trackActivityBoards([inside, outside, draft] as never);
    inside.save([text("a", "已有"), text("b", "保存后多出来的")]);
    outside.save([text("z", "不属于这个项目")]);

    const annotation = { id: "h", type: "highlight", color: "#ffd400", text: "原文", comment: "", tags: [] };
    const pdf = {
      path: "/library/Bastek2024/paper.pdf",
      kind: "pdf",
      annotations: { annotations: [] as unknown[] },
    };
    noteDocument(pdf as never);
    pdf.annotations.annotations = [
      { ...annotation, pageLabel: "1", position: { pageIndex: 0 }, dateModified: clock(9, 0) },
    ];
    noteDocument(pdf as never);
    noteDocument({
      path: "/research/笔记/想法.md",
      kind: "markdown",
      markdown: { text: "写了", dirty: false },
    } as never);
    // 还没存的笔记不记
    noteDocument({
      path: "/research/笔记/草稿.md",
      kind: "markdown",
      markdown: { text: "半截", dirty: true },
    } as never);
    noteLibraryItem(
      {
        dir: "/library/Bastek2024",
        title: "Physics-informed diffusion",
        authors: ["Bastek"],
        year: "2024",
        pdfPath: "p",
      } as never,
      "/library",
    );

    // 关掉这块白板：攒着的立刻写
    trackActivityBoards([outside, draft] as never);
    await flushActivityLog();
    expect(inside.listeners.size).toBe(0);
    // 按时间排：那条高亮是 9:00 划的，排在最前
    expect(log().map(({ kind, where }) => [kind, where])).toEqual([
      ["annotation.add", { library: "Bastek2024/paper.pdf", page: 1, annotation: "h" }],
      ["library.add", { library: "Bastek2024" }],
      ["card.add", { board: "a.prg", card: "b" }],
      ["note.save", { file: "笔记/想法.md" }],
    ]);
    expect(log()[1]).toMatchObject({
      title: "Physics-informed diffusion",
      more: { authors: ["Bastek"], year: "2024", pdf: true },
    });
    stop();
    expect(outside.listeners.size).toBe(0);
  });

  it("writes one line per card marked from the right-click menu, and refuses a board outside the project", async () => {
    const { io, log } = memory();
    const stop = startActivityLog(io);
    const opened = fakeBoard("/research/a.prg", [text("a", "边界条件处理不了"), text("b", "换成软约束")]);
    expect(noteCardMarks(opened as never, [{ uuid: "a" }, { uuid: "gone" }], "problem")).toBe(true);
    expect(noteCardMarks(fakeBoard("/elsewhere/tmp.prg", [text("z", "x")]) as never, [{ uuid: "z" }], "idea")).toBe(
      false,
    );
    await flushActivityLog();
    expect(log()).toMatchObject([
      {
        kind: "mark",
        where: { board: "a.prg", card: "a" },
        title: "边界条件处理不了",
        more: { mark: "problem", type: "TextNode" },
      },
    ]);
    stop();
  });

  it("tells the user once when the record cannot be written", async () => {
    const { io } = memory();
    io.fail = "append";
    const stop = startActivityLog(io);
    const opened = fakeBoard("/research/a.prg", []);
    trackActivityBoards([opened as never]);
    opened.save([text("a", "写不进去")]);
    await flushActivityLog();
    expect(mocks.warn).toHaveBeenCalledWith("activityLog.failed", { id: "research-activity-log-failed" });
    stop();
  });
});
