import { createDefaultMetadata } from "@/types/metadata";
import { encode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import type { ResearchSidecar } from "./AiSidecarBuilder";
import { localTime } from "./ProjectRecord";
import { REPORT_GUIDE, REPORT_GUIDE_HINT } from "./ReportGuide";
import {
  compareSnapshots,
  readActivityLog,
  readAnnotations,
  recordLink,
  snapshotList,
  type ReportSource,
} from "./ReportTools";

const root = "/research/课题";
const encoder = new TextEncoder();

/** 一个项目文件夹：路径相对项目文件夹 */
function project(files: Record<string, string | Uint8Array> = {}): ReportSource {
  const disk = new Map(
    Object.entries(files).map(([path, content]) => [
      `${root}/${path}`,
      typeof content === "string" ? encoder.encode(content) : content,
    ]),
  );
  const inside = (path: string) =>
    [...disk.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1));
  return {
    root,
    reader: {
      read: async (path) => disk.get(path),
      folders: async (path) => [
        ...new Set(
          inside(path)
            .filter((rest) => rest.includes("/"))
            .map((rest) => rest.split("/")[0]),
        ),
      ],
      files: async (path) => inside(path).filter((rest) => !rest.includes("/")),
    },
  };
}

// 时间都按本机时区造，测试在哪个时区跑都一样
const at = (day: number, hour = 10) => localTime(new Date(2026, 10, day, hour));
const now = new Date(2026, 10, 15, 12);
const line = (time: string, kind: string, where: object, title: string, extra: object = {}) =>
  JSON.stringify({ at: time, project: "课题", kind, where, title, ...extra });

const log =
  [
    line(at(3), "card.add", { board: "白板.prg", card: "c0" }, "很早的卡片"),
    line(at(9, 9), "card.add", { board: "白板.prg", card: "c1" }, "边界条件", { text: "狄利克雷" }),
    line(
      at(10),
      "excerpt.send",
      { board: "子文件夹/第二块.prg", card: "c2", file: "论文/main (v2).pdf", page: 3, annotation: "A1" },
      "main (v2).pdf · 第 3 页",
      { text: "We propose" },
    ),
    '{"at":"2026-11-1',
    line(at(12), "annotation.delete", { file: "论文/main (v2).pdf", page: 2, annotation: "A0" }, "main (v2).pdf"),
    // 批注用它自己记的时间，写进文件时可能排在更晚的几行后面
    line(at(11), "annotation.add", { library: "Bastek2024/paper.pdf", page: 5, annotation: "B7" }, "paper.pdf", {
      text: "ill-posed",
      more: { type: "highlight", color: "#ffd400" },
    }),
    line(at(13), "card.delete", { board: "白板.prg", card: "c9" }, "删掉的"),
    line(at(14), "note.save", { file: "笔记/想法.md" }, "想法.md", { more: { chars: 120, delta: 30 } }),
    line(at(15, 9), "mark", { board: "白板.prg", card: "c1" }, "边界条件", { more: { mark: "problem" } }),
    line(at(15, 10), "snapshot", { snapshot: "2026-11-15 1000" }, "2026-11-15 1000"),
    line(at(15, 11), "library.add", { library: "Kim2025" }, "A paper"),
  ].join("\n") + "\n";

describe("recordLink", () => {
  it("写出四种链接，中文不转，会截断 Markdown 链接的字符转掉", () => {
    expect(recordLink(root, { board: "白板.prg", card: "c1" })).toBe("rwb://open?project=课题&path=白板.prg&target=c1");
    expect(recordLink(root, { file: "论文/main (v2).pdf", page: 3, annotation: "A1" })).toBe(
      "rwb://open?project=课题&path=论文/main%20%28v2%29.pdf&page=3&annotation=A1",
    );
    expect(recordLink(root, { library: "作者2024/a&b.pdf", page: 1 })).toBe(
      "rwb://open?library=1&path=作者2024/a%26b.pdf&page=1",
    );
    expect(recordLink(root, { file: "笔记/想法.md" })).toBe("rwb://open?project=课题&path=笔记/想法.md");
    // 项目外的文件记的是完整路径，不带项目名
    expect(recordLink(root, { file: "/elsewhere/x.pdf" })).toBe("rwb://open?path=/elsewhere/x.pdf");
    expect(recordLink(root, { snapshot: "2026-11-15 1000" })).toBeUndefined();
  });
});

describe("readActivityLog", () => {
  const source = project({ ".workbench/活动记录.jsonl": log });

  it("默认读最近 7 天，按时间排好，带上各种活动的条数和能点回去的链接", async () => {
    const result = await readActivityLog(source, {}, now);
    expect(result).toMatchObject({
      success: true,
      project: "课题",
      now: localTime(now),
      range: { since: localTime(new Date(2026, 10, 9)), until: localTime(now) },
      startedAt: at(3),
      total: 9,
      offset: 0,
      unreadable: 1,
      counts: {
        "card.add": 1,
        "excerpt.send": 1,
        "annotation.add": 1,
        "annotation.delete": 1,
        "card.delete": 1,
        "note.save": 1,
        mark: 1,
        snapshot: 1,
        "library.add": 1,
      },
    });
    if (!result.success) throw new Error("unreachable");
    expect(result).not.toHaveProperty("truncated");
    expect(result.entries.map(({ kind, link, source }) => ({ kind, link, source }))).toEqual([
      { kind: "card.add", link: "rwb://open?project=课题&path=白板.prg&target=c1", source: undefined },
      {
        kind: "excerpt.send",
        link: "rwb://open?project=课题&path=子文件夹/第二块.prg&target=c2",
        source: "rwb://open?project=课题&path=论文/main%20%28v2%29.pdf&page=3&annotation=A1",
      },
      {
        kind: "annotation.add",
        link: "rwb://open?library=1&path=Bastek2024/paper.pdf&page=5&annotation=B7",
        source: undefined,
      },
      // 删掉的批注指到它原来那一页，删掉的卡片不给链接
      {
        kind: "annotation.delete",
        link: "rwb://open?project=课题&path=论文/main%20%28v2%29.pdf&page=2",
        source: undefined,
      },
      { kind: "card.delete", link: undefined, source: undefined },
      { kind: "note.save", link: "rwb://open?project=课题&path=笔记/想法.md", source: undefined },
      { kind: "mark", link: "rwb://open?project=课题&path=白板.prg&target=c1", source: undefined },
      { kind: "snapshot", link: undefined, source: undefined },
      { kind: "library.add", link: undefined, source: undefined },
    ]);
    expect(result.entries[2]).toEqual({
      at: at(11),
      kind: "annotation.add",
      title: "paper.pdf",
      text: "ill-posed",
      where: { library: "Bastek2024/paper.pdf", page: 5, annotation: "B7" },
      more: { type: "highlight", color: "#ffd400" },
      link: "rwb://open?library=1&path=Bastek2024/paper.pdf&page=5&annotation=B7",
    });
  });

  it("按日期范围、种类筛，日期写到哪天就包含那一整天", async () => {
    const ranged = await readActivityLog(source, { since: "2026-11-10", until: "2026-11-12" }, now);
    expect(ranged).toMatchObject({ total: 3, range: { until: "2026-11-12" } });
    expect(ranged.success && ranged.entries.map(({ kind }) => kind)).toEqual([
      "excerpt.send",
      "annotation.add",
      "annotation.delete",
    ]);
    expect(await readActivityLog(source, { since: "2026-11-01", kinds: ["card.add"] }, now)).toMatchObject({
      total: 2,
      counts: { "card.add": 2 },
    });
    expect(await readActivityLog(source, { days: 1 }, now)).toMatchObject({ total: 3 });
    // 只给结尾：从最早的记录算起
    expect(await readActivityLog(source, { until: "2026-11-09" }, now)).toMatchObject({
      total: 2,
      range: { since: at(3) },
    });
    expect(await readActivityLog(source, { since: "上周" }, now)).toMatchObject({ success: false });
  });

  it("一次读不完时告诉调用方从哪接着读", async () => {
    const first = await readActivityLog(source, { since: "2026-11-01", limit: 4 }, now);
    expect(first).toMatchObject({ total: 10, truncated: true, next: 4 });
    const rest = await readActivityLog(source, { since: "2026-11-01", limit: 300, offset: 4 }, now);
    expect(rest).toMatchObject({ total: 10, offset: 4 });
    expect(rest).not.toHaveProperty("truncated");
    expect(first.success && rest.success && [...first.entries, ...rest.entries].map(({ at }) => at)).toEqual([
      at(3),
      at(9, 9),
      at(10),
      at(11),
      at(12),
      at(13),
      at(14),
      at(15, 9),
      at(15, 10),
      at(15, 11),
    ]);
  });

  it("做过的阶段小结也是一行记录，链接指到报告文件", async () => {
    const report = "/research/我的进展/2026-11-14 阶段小结.md";
    const result = await readActivityLog(
      project({
        ".workbench/活动记录.jsonl": `${line(at(14), "summary", { file: report }, "2026-11-14 阶段小结.md")}\n`,
      }),
      { kinds: ["summary"] },
      now,
    );
    expect(result).toMatchObject({ total: 1, counts: { summary: 1 } });
    expect(result.success && result.entries[0].link).toBe(
      "rwb://open?path=/research/我的进展/2026-11-14%20阶段小结.md",
    );
  });

  it("还没有记录时照实说", async () => {
    const result = await readActivityLog(project(), {}, now);
    expect(result).toMatchObject({ success: true, total: 0, entries: [], counts: {} });
    expect(result.success && result.note).toContain("还没有活动记录");
  });
});

const card = (id: string, title: string, text = "", more: object = {}) => ({
  id,
  type: "TextNode",
  title,
  text,
  notes: "",
  rect: { x: 0, y: 0, w: 100, h: 50 },
  color: null,
  ...more,
});
const edge = (from: string, to: string, label = "") => ({ id: `${from}-${to}`, type: "LineEdge", from, to, label });
const board = (cards: object[], edges: object[] = []): ResearchSidecar =>
  ({
    schema: "research-workbench.sidecar/1",
    workspace: { file: "", id: "", savedAt: "", prgVersion: "" },
    cards,
    sections: [],
    edges,
    hyperedges: [],
    tags: [],
  }) as ResearchSidecar;

/** 一份快照在盘上的几个文件 */
function snapshot(name: string, boards: Record<string, ResearchSidecar>): Record<string, string> {
  const manifest = {
    v: 1,
    at: `${name.slice(0, 10)}T${name.slice(11, 13)}:${name.slice(13, 15)}:00+08:00`,
    reason: "manual",
    project: "课题",
    boards: Object.entries(boards).map(([file, sidecar]) => ({
      file,
      cards: sidecar.cards.length,
      sections: 0,
      edges: sidecar.edges.length,
      images: {},
    })),
  };
  return {
    [`.workbench/快照/${name}/清单.json`]: JSON.stringify(manifest),
    ...Object.fromEntries(
      Object.entries(boards).map(([file, sidecar]) => [
        `.workbench/快照/${name}/${file.replace(/\.prg$/, "")}.ai.json`,
        JSON.stringify(sidecar),
      ]),
    ),
  };
}

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
const textNode = (uuid: string, text: string) => ({
  _: "TextNode",
  uuid,
  text,
  collisionBox: { _: "CollisionBox", shapes: [] },
});

describe("snapshotList", () => {
  it("最新的在前，拍到一半的和图片文件夹不算", async () => {
    const result = await snapshotList(
      project({
        ...snapshot("2026-11-08 1030", { "白板.prg": board([card("a", "A")]) }),
        ...snapshot("2026-11-15 1000", { "白板.prg": board([card("a", "A"), card("b", "B")], [edge("a", "b")]) }),
        ".workbench/快照/图片/abc.png": "png",
        ".workbench/快照/2026-11-16 0900/白板.prg": "拍到一半，没有清单",
      }),
    );
    expect(result).toEqual({
      success: true,
      project: "课题",
      total: 2,
      snapshots: [
        {
          name: "2026-11-15 1000",
          at: "2026-11-15T10:00:00+08:00",
          reason: "manual",
          boards: [{ board: "白板.prg", cards: 2, sections: 0, edges: 1 }],
        },
        {
          name: "2026-11-08 1030",
          at: "2026-11-08T10:30:00+08:00",
          reason: "manual",
          boards: [{ board: "白板.prg", cards: 1, sections: 0, edges: 0 }],
        },
      ],
    });
  });

  it("一份都没有时照实说", async () => {
    const result = await snapshotList(project());
    expect(result).toMatchObject({ success: true, total: 0, snapshots: [] });
    expect(result.note).toContain("还没有快照");
  });
});

describe("compareSnapshots", () => {
  const earlier = snapshot("2026-11-08 1030", {
    "白板.prg": board(
      [card("a", "标题 A", "原来的话"), card("b", "B"), card("c", "C"), card("x", "剪切前", "同一段话")],
      [edge("a", "b")],
    ),
    "旧名.prg": board([card("m1", "一"), card("m2", "二"), card("m3", "三")]),
    "不变.prg": board([card("s", "没动过")]),
    "删了.prg": board([card("z", "跟着白板一起没了")]),
  });
  const later = snapshot("2026-11-15 1000", {
    "白板.prg": board(
      [
        card("a", "标题 A", "改之后的话"),
        // 只挪了位置、换了颜色，不算改
        card("c", "C", "", { rect: { x: 500, y: 500, w: 100, h: 50 }, color: "red" }),
        card("d", "D", "新加的"),
        // 剪切再粘贴换了编号，内容一样：不算删一张加一张
        card("y", "剪切前", "同一段话"),
      ],
      [edge("a", "d", "支持")],
    ),
    "新名.prg": board([card("m1", "一"), card("m2", "二"), card("m3", "三"), card("m4", "四")]),
    "不变.prg": board([card("s", "没动过")]),
    "新开.prg": board([card("n", "新白板上的卡片")]),
  });

  it("比两份快照：新加、改过、删掉、连线，改名的白板认得出来", async () => {
    const result = await compareSnapshots(project({ ...earlier, ...later }), { to: "2026-11-15 1000" });
    expect(result).toEqual({
      success: true,
      project: "课题",
      from: { name: "2026-11-08 1030", at: "2026-11-08T10:30:00+08:00" },
      to: { name: "2026-11-15 1000", at: "2026-11-15T10:00:00+08:00" },
      totals: { added: 3, edited: 1, removed: 2 },
      unchanged: 1,
      boards: [
        {
          board: "删了.prg",
          status: "gone",
          counts: { added: 0, edited: 0, removed: 1, edgesAdded: 0, edgesRemoved: 0 },
          added: [],
          edited: [],
          removed: [{ card: "z", type: "TextNode", title: "跟着白板一起没了" }],
        },
        {
          board: "新名.prg",
          renamedFrom: "旧名.prg",
          counts: { added: 1, edited: 0, removed: 0, edgesAdded: 0, edgesRemoved: 0 },
          added: [
            { card: "m4", type: "TextNode", title: "四", link: "rwb://open?project=课题&path=新名.prg&target=m4" },
          ],
          edited: [],
          removed: [],
        },
        {
          board: "新开.prg",
          status: "new",
          counts: { added: 1, edited: 0, removed: 0, edgesAdded: 0, edgesRemoved: 0 },
          added: [
            {
              card: "n",
              type: "TextNode",
              title: "新白板上的卡片",
              link: "rwb://open?project=课题&path=新开.prg&target=n",
            },
          ],
          edited: [],
          removed: [],
        },
        {
          board: "白板.prg",
          counts: { added: 1, edited: 1, removed: 1, edgesAdded: 1, edgesRemoved: 1 },
          added: [
            {
              card: "d",
              type: "TextNode",
              title: "D",
              text: "新加的",
              link: "rwb://open?project=课题&path=白板.prg&target=d",
            },
          ],
          edited: [
            {
              card: "a",
              type: "TextNode",
              title: "标题 A",
              text: "改之后的话",
              link: "rwb://open?project=课题&path=白板.prg&target=a",
              was: { text: "原来的话" },
            },
          ],
          removed: [{ card: "b", type: "TextNode", title: "B" }],
          edgesAdded: ["标题 A → D（支持）"],
          edgesRemoved: ["标题 A → B"],
        },
      ],
    });
  });

  it("和现在比：手里开着的白板用当前内容，别的读文件，读不了的单独标出来", async () => {
    const source = project({
      ...snapshot("2026-11-08 1030", { "白板.prg": board([card("a", "A", "旧")]), "子文件夹/另一块.prg": board([]) }),
      "白板.prg": "盘上的旧文件，不该去读它",
      "子文件夹/另一块.prg": await prg([textNode("t1", "盘上新加的")]),
      "坏的.prg": "不是白板文件",
      "白板_backup.prg": "备份不算",
    });
    const asked: string[] = [];
    const result = await compareSnapshots(
      source,
      {},
      {
        path: "/Research/课题/白板.prg",
        sidecar: (workspaceFile) => {
          asked.push(workspaceFile);
          return board([card("a", "A", "新")]);
        },
      },
      now,
    );
    expect(asked).toEqual([`${root}/白板.prg`]);
    expect(result).toMatchObject({
      success: true,
      from: { name: "2026-11-08 1030" },
      to: { now: localTime(now) },
      totals: { added: 1, edited: 1, removed: 0 },
      unchanged: 0,
      boards: [
        { board: "坏的.prg", unreadable: true },
        {
          board: "子文件夹/另一块.prg",
          counts: { added: 1 },
          added: [
            {
              card: "t1",
              title: "盘上新加的",
              link: "rwb://open?project=课题&path=子文件夹/另一块.prg&target=t1",
            },
          ],
        },
        { board: "白板.prg", edited: [{ card: "a", text: "新", was: { text: "旧" } }] },
      ],
    });
  });

  it("没有快照、名字不对、顺序反了时说清楚", async () => {
    expect(await compareSnapshots(project())).toMatchObject({ success: false });
    const source = project({ ...earlier, ...later });
    const unknown = await compareSnapshots(source, { from: "2026-11-01 0000" });
    expect(unknown).toMatchObject({ success: false });
    expect(!unknown.success && unknown.error).toContain("2026-11-15 1000、2026-11-08 1030");
    expect(await compareSnapshots(source, { to: "2026-11-08 1030" })).toMatchObject({ success: false });
    expect(await compareSnapshots(source, { from: "2026-11-15 1000", to: "2026-11-08 1030" })).toMatchObject({
      success: false,
    });
  });
});

describe("readAnnotations", () => {
  const annotation = (id: string, page: number, offset: number, more: object = {}) => ({
    id,
    type: "highlight",
    color: "#ffd400",
    sortIndex: `${String(page - 1).padStart(5, "0")}|${String(offset).padStart(6, "0")}|00000`,
    pageLabel: String(page),
    position: { pageIndex: page - 1, rects: [[0, 0, 10, 10]] },
    comment: "",
    tags: [],
    dateModified: "2026-11-11T02:00:00.000Z",
    ...more,
  });
  const files = {
    ".workbench/annotations/论文/main.pdf.json": JSON.stringify([
      annotation("A3", 3, 40, { text: "后一条", comment: "为什么成立？", tags: [{ name: "存疑" }] }),
      annotation("A0", 1, 0, { text: "PDF 自带的", readOnly: true }),
      annotation("A1", 2, 10, { text: "前一条", pageLabel: "ii", dateCreated: "2026-11-10T01:00:00.000Z" }),
    ]),
    ".workbench/annotations/论文/main.pdf.json.lock": "",
    ".workbench/annotations/空的.pdf.json": "[]",
    ".workbench/annotations/坏的.pdf.json": "{",
    ".workbench/annotations/.trash/12345678-1234-1234-1234-123456789012.json": JSON.stringify([annotation("T", 1, 0)]),
    ".workbench/活动记录.状态.json": JSON.stringify({
      v: 1,
      boards: {},
      notes: {},
      annotations: {
        [JSON.stringify({ file: "论文/main.pdf" })]: { A1: { f: "x", title: "", text: "前一条" } },
        [JSON.stringify({ library: "Bastek2024/paper.pdf" })]: {
          B9: { f: "x", title: "", text: "第二条", more: { type: "underline", color: "#ff6666" }, page: 7 },
          B7: {
            f: "x",
            title: "",
            text: "ill-posed",
            more: { type: "highlight", color: "#ffd400", comment: "只有开头", tags: ["存疑"] },
            page: 5,
            created: "2026-11-11T02:00:00.000Z",
            modified: "2026-11-11T02:00:00.000Z",
          },
        },
      },
    }),
  };

  it("不指定 PDF 时列出哪些有批注、各几条", async () => {
    const result = await readAnnotations(project(files));
    expect(result).toMatchObject({
      success: true,
      project: "课题",
      files: [
        { file: "坏的.pdf", unreadable: true },
        { file: "论文/main.pdf", count: 2 },
        { library: "Bastek2024/paper.pdf", count: 2 },
      ],
    });
  });

  it("读项目里的一篇：只要自己划的，按文中的先后排", async () => {
    expect(await readAnnotations(project(files), { file: "论文/main.pdf" })).toEqual({
      success: true,
      project: "课题",
      file: "论文/main.pdf",
      count: 2,
      annotations: [
        {
          id: "A1",
          type: "highlight",
          page: 2,
          pageLabel: "ii",
          color: "#ffd400",
          text: "前一条",
          created: localTime(new Date("2026-11-10T01:00:00.000Z")),
          modified: localTime(new Date("2026-11-11T02:00:00.000Z")),
          link: "rwb://open?project=课题&path=论文/main.pdf&page=2&annotation=A1",
        },
        {
          id: "A3",
          type: "highlight",
          page: 3,
          color: "#ffd400",
          text: "后一条",
          comment: "为什么成立？",
          tags: ["存疑"],
          modified: localTime(new Date("2026-11-11T02:00:00.000Z")),
          link: "rwb://open?project=课题&path=论文/main.pdf&page=3&annotation=A3",
        },
      ],
    });
    expect(await readAnnotations(project(files), { file: "没划过.pdf" })).toMatchObject({ count: 0, annotations: [] });
    expect(await readAnnotations(project(files), { file: "坏的.pdf" })).toMatchObject({ success: false });
  });

  it("文献库里的一篇：桌面端读得到全文，读不到时退到活动记录里记下的那部分", async () => {
    const asked: string[] = [];
    const full = await readAnnotations(
      project(files),
      { library: "Bastek2024/paper.pdf" },
      {
        library: async (path) => {
          asked.push(path);
          return [annotation("B7", 5, 0, { text: "ill-posed 的全文" })];
        },
      },
    );
    expect(asked).toEqual(["Bastek2024/paper.pdf"]);
    expect(full).toMatchObject({
      success: true,
      library: "Bastek2024/paper.pdf",
      count: 1,
      annotations: [
        {
          id: "B7",
          text: "ill-posed 的全文",
          link: "rwb://open?library=1&path=Bastek2024/paper.pdf&page=5&annotation=B7",
        },
      ],
    });
    expect(full).not.toHaveProperty("partial");

    const partial = await readAnnotations(project(files), { library: "Bastek2024/paper.pdf" });
    expect(partial).toMatchObject({
      success: true,
      library: "Bastek2024/paper.pdf",
      count: 2,
      partial: true,
      annotations: [
        {
          id: "B7",
          type: "highlight",
          page: 5,
          color: "#ffd400",
          text: "ill-posed",
          comment: "只有开头",
          tags: ["存疑"],
          link: "rwb://open?library=1&path=Bastek2024/paper.pdf&page=5&annotation=B7",
        },
        { id: "B9", type: "underline", page: 7, text: "第二条" },
      ],
    });
  });

  it("只认项目和文献库里的相对路径", async () => {
    for (const query of [
      { file: "/etc/secret.pdf" },
      { file: "../外面.pdf" },
      { library: "C:\\Users\\x\\a.pdf" },
      { file: "笔记/想法.md" },
      { file: "a.pdf", library: "b.pdf" },
    ]) {
      expect(await readAnnotations(project(files), query)).toMatchObject({ success: false });
    }
  });
});

describe("怎么做汇报的说明", () => {
  it("提到的工具和字段都是真有的", () => {
    for (const name of [
      "read_activity_log",
      "list_snapshots",
      "compare_snapshots",
      "read_annotations",
      "dump_workspace",
      "read_pdf_text",
      "startedAt",
      "truncated",
      "counts",
      "rwb://open?",
    ]) {
      expect(REPORT_GUIDE).toContain(name);
    }
    expect(REPORT_GUIDE_HINT).toContain("read_report_guide");
  });
});
