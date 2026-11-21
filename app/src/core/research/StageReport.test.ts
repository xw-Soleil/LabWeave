import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  busy: false,
  aiReady: true,
  flushed: vi.fn(async () => {}),
  summaryNoted: vi.fn(),
  taken: vi.fn(),
  left: vi.fn(),
  started: vi.fn(),
  generated: vi.fn(),
  notes: new Map<string, string>(),
}));
vi.mock("@/state", async () => ({ store: (await import("jotai")).createStore() }));
vi.mock("@graphif/serializer", () => ({ serialize: (stage: unknown) => stage }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: async (path: string) => {
    const text = mocks.notes.get(path);
    if (text === undefined) throw new Error("没有这个文件");
    return text;
  },
}));
vi.mock("i18next", () => ({ default: { t: (key: string) => (key === "stageNode.types.meeting" ? "组会" : key) } }));
vi.mock("./ActivityLog", () => ({ flushActivityLog: mocks.flushed, noteSummary: mocks.summaryNoted }));
vi.mock("./AiSidecarBuilder", () => ({
  buildAiSidecar: ({ serializedStage }: { serializedStage: unknown }) => ({ json: serializedStage }),
}));
vi.mock("./ReportTask", () => ({ reportBusy: () => mocks.busy, startReportTask: mocks.started }));
vi.mock("./ReportTools", () => ({
  readAnnotations: async () => ({ success: false, error: "这里用不到" }),
  recordLink: (_root: string, where: Record<string, string>) =>
    `rwb://${where.board}${where.card ? `#${where.card}` : ""}`,
}));
vi.mock("./ResearchFolder", () => ({ ResearchFolder: { toAbsolute: (path: string) => path } }));
vi.mock("./ResearchReport", async (original) => ({
  ...(await original<typeof import("./ResearchReport")>()),
  assertReportAiConfigured: async () => {
    if (!mocks.aiReady) throw new Error("researchReport.aiNotConfigured");
  },
  generateResearchReport: mocks.generated,
}));
vi.mock("./StageReview", async () => ({
  stageReviewAtom: (await import("jotai")).atom(null),
  recordFiles: {},
  leaveStageReview: mocks.left,
  // 定格：拍节点快照，手填的记录跟着封存（那一半在 StageReview.test.ts 里测）
  freezeNode: async (state: { type: string; note: string }, cards: unknown) => ({
    node: { type: state.type, title: "2026-11-21 组会", note: state.note },
    snapshot: await mocks.taken(state.note, cards),
  }),
}));

import { store } from "@/state";
import type { ResearchSidecar } from "./AiSidecarBuilder";
import { collectStageMaterials, freezeAndReport, type StageReportInput, type StageReportIO } from "./StageReport";
import { stageReviewAtom, type ReviewItem } from "./StageReview";

const root = "/research/课题";
/** 只有文件头的 PNG：够认出宽高 */
function png() {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, 800);
  view.setUint32(20, 600);
  return bytes;
}

const sidecar = {
  cards: [
    { id: "c1", type: "TextNode", title: "B 方法的结果", text: "边界条件会炸", notes: "要换损失函数", sectionId: "s1" },
    { id: "c2", type: "TextNode", title: "对照实验", text: "A 方法没问题", notes: "", sectionId: "s1" },
    { id: "img", type: "ImageNode", title: "结果图", text: "", notes: "" },
    {
      id: "pdf",
      type: "FileCardNode",
      title: "摘录",
      text: "原文一段",
      notes: "",
      file: { path: "论文/main.pdf", page: 3 },
    },
    { id: "junk", type: "TextNode", title: "随手试的废卡", text: "不讲", notes: "" },
  ],
  sections: [
    { id: "s1", title: "实验", children: ["c1", "c2", "junk"], notes: "这一组是本周做的" },
    { id: "s2", title: "只有一张要讲", children: ["img", "junk"], notes: "" },
  ],
  edges: [
    { id: "e1", type: "LineEdge", from: "c2", to: "c1", label: "对比" },
    { id: "e2", type: "LineEdge", from: "c1", to: "junk", label: "" },
  ],
} as unknown as ResearchSidecar;

const card = (id: string, more: Partial<ReviewItem> = {}): ReviewItem => ({ id, kind: "card", title: id, ...more });

function fakeIo(more: Partial<StageReportIO> = {}) {
  const shots: string[] = [];
  const io: StageReportIO = {
    readNote: async (path) => {
      if (path !== "笔记/想法.md") throw new Error("没有这篇");
      return "---\ntags: [想法]\n---\n今天想到的事";
    },
    annotations: async (place) =>
      "file" in place && place.file === "论文/main.pdf"
        ? [
            { page: 1, text: "上个节点之前划的", modified: "2026-11-10T10:00:00+08:00", link: "rwb://old" },
            {
              page: 3,
              text: "这周划的一句",
              comment: "和我们的假设一致",
              modified: "2026-11-16T10:00:00+08:00",
              link: "rwb://a1",
            },
            { page: 4, modified: "2026-11-17T10:00:00+08:00" },
            { page: 5, pageLabel: "v", text: "没记时间的", link: "rwb://a3" },
          ]
        : undefined,
    cardImage: async (id) => (id === "img" ? png() : undefined),
    sectionImage: async (id) => {
      shots.push(id);
      return png();
    },
    ...more,
  };
  return { io, shots };
}

const input = (picked: ReviewItem[], more: Partial<StageReportInput> = {}): StageReportInput => ({
  root,
  board: "白板.prg",
  sidecar,
  title: "2026-11-21 组会",
  picked,
  note: " 这周主要试了 B 方法 ",
  boards: [],
  since: "2026-11-14T10:00:00+08:00",
  ...more,
});

describe("turning what was ticked into numbered materials", () => {
  it("puts the user's words first, then the cards with their notes, group and links", async () => {
    const { io } = fakeIo();
    const { evidence } = await collectStageMaterials(
      input([card("c1", { mark: "problem", change: "edited", link: "rwb://c1" }), card("c2"), card("pdf")]),
      io,
    );
    expect(evidence.map(({ id, label }) => [id, label])).toEqual([
      ["S1", "这次想讲的"],
      ["S2", "【问题】B 方法的结果"],
      ["S3", "对照实验"],
      ["S4", "摘录"],
      ["S5", "卡片之间的连线"],
      ["S6", "分组「实验」"],
    ]);
    expect(evidence[0]).toMatchObject({ text: "这周主要试了 B 方法", path: "节点：2026-11-21 组会" });
    expect(evidence[0].link).toBeUndefined();
    expect(evidence[1]).toMatchObject({
      path: "白板.prg#c1",
      link: "rwb://c1",
      text: "（上个节点以来改过的）\n边界条件会炸\n备注：要换损失函数\n所在分组：实验",
    });
    expect(evidence[2].link).toBe("rwb://白板.prg#c2");
    expect(evidence[3].text).toBe("原文一段\n来源文件：论文/main.pdf 第 3 页");
    // 连线只写两头都要讲的；连到没勾的那张不写
    expect(evidence[4].text).toBe("对照实验 → B 方法的结果：对比");
  });

  it("uses the original picture of image cards, and one screenshot per group with two or more ticked cards", async () => {
    const { io, shots } = fakeIo();
    const { evidence, images } = await collectStageMaterials(input([card("c1"), card("c2"), card("img")]), io);
    const group = evidence.find(({ label }) => label === "分组「实验」")!;
    expect(group).toMatchObject({
      path: "白板.prg#s1",
      link: "rwb://白板.prg#s1",
      text: "这个分组里这次要讲的：B 方法的结果、对照实验\n备注：这一组是本周做的",
    });
    const picture = evidence.find(({ label }) => label === "结果图")!;
    expect(images.map(({ id, sourceId }) => [id, sourceId])).toEqual([
      ["I1", picture.id],
      ["I2", group.id],
    ]);
    // 只有一张要讲的分组不截图
    expect(shots).toEqual(["s1"]);
  });

  it("goes on without a screenshot that failed, and says so in the things to check", async () => {
    const { io } = fakeIo({
      sectionImage: async () => {
        throw new Error("截不了");
      },
    });
    const { images, warnings } = await collectStageMaterials(input([card("c1"), card("c2")]), io);
    expect(images).toEqual([]);
    expect(warnings).toEqual(["分组的截图没有截成：分组「实验」"]);
  });

  it("adds other boards, the annotations made since the last node, and the notes that changed", async () => {
    const { io } = fakeIo();
    const { evidence, warnings } = await collectStageMaterials(
      input(
        [
          { id: "另一块.prg", kind: "board", title: "另一块", link: "rwb://另一块.prg" },
          { id: "论文/main.pdf", kind: "paper", title: "main.pdf", link: "rwb://paper" },
          { id: "library:作者2024/paper.pdf", kind: "paper", title: "paper.pdf" },
          { id: "笔记/想法.md", kind: "note", title: "想法.md" },
          { id: "笔记/已经 删掉(的).md", kind: "note", title: "已经 删掉(的).md" },
        ],
        {
          note: "",
          boards: [
            {
              board: "另一块.prg",
              counts: { added: 1, edited: 1, removed: 2 },
              added: [{ title: "新想法", text: "试试 C 方法", notes: "周四讨论" }],
              edited: [{ title: "", text: "" }],
              truncated: true,
            },
          ],
        },
      ),
      io,
    );
    expect(evidence.map(({ label, text, link }) => ({ label, text, link }))).toEqual([
      {
        label: "白板「另一块」",
        text: "上个节点以来：新加 1 张、改了 1 张、删了 2 张。\n新加的：\n- 新想法｜试试 C 方法｜备注：周四讨论\n改过的：\n- （没有文字）\n（卡片太多，只列了一部分）",
        link: "rwb://另一块.prg",
      },
      { label: "main.pdf · 第 3 页", text: "这周划的一句\n批注：和我们的假设一致", link: "rwb://a1" },
      { label: "main.pdf · 第 v 页", text: "没记时间的", link: "rwb://a3" },
      // 报告在 汇报/节点名/ 里，往上两级是项目文件夹；属性不当正文
      { label: "想法.md", text: "今天想到的事", link: "../../笔记/想法.md" },
    ]);
    expect(evidence[1].path).toBe("论文/main.pdf#page=3");
    expect(warnings).toEqual(["论文的批注读不出来，未纳入：paper.pdf", "笔记读不出来，未纳入：已经 删掉(的).md"]);
  });

  it("writes relative links that survive spaces and brackets in file names", async () => {
    const { io } = fakeIo({ readNote: async () => "正文" });
    const { evidence } = await collectStageMaterials(
      input([{ id: "笔记/第 1 周 (草稿).md", kind: "note", title: "第 1 周 (草稿).md" }], { note: "" }),
      io,
    );
    expect(evidence[0].link).toBe("../../笔记/第%201%20周%20%28草稿%29.md");
  });

  it("has nothing to write about when nothing ticked has any text", async () => {
    const { io } = fakeIo();
    await expect(collectStageMaterials(input([], { note: "  " }), io)).rejects.toThrow("researchReport.noMaterials");
  });
});

describe("freezing and starting the report", () => {
  const cards = [card("c1", { title: "B 方法的结果" }), card("junk", { title: "随手试的废卡" })];
  const board = {
    stage: sidecar,
    uri: { fsPath: `${root}/白板.prg` },
    attachments: new Map<string, Blob>(),
    stageManager: { getEntities: () => [] },
  };
  const reviewing = (more: Record<string, unknown> = {}) =>
    store.set(
      stageReviewAtom as never,
      {
        project: board,
        root,
        board: "白板.prg",
        type: "meeting",
        base: { name: "2026-11-14 1000", manifest: { at: "2026-11-14T10:00:00+08:00" } },
        note: "这周主要试了 B 方法",
        dropped: new Set(["junk"]),
        others: [],
        boards: [],
        marks: {},
        ...more,
      } as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.busy = false;
    mocks.aiReady = true;
    mocks.notes.clear();
    mocks.taken.mockResolvedValue({ name: "2026-11-21 1030" });
  });

  it("does not freeze anything when the report could not be written anyway", async () => {
    reviewing();
    mocks.busy = true;
    await expect(freezeAndReport(cards)).rejects.toThrow("researchReport.busy");
    mocks.busy = false;
    mocks.aiReady = false;
    await expect(freezeAndReport(cards)).rejects.toThrow("researchReport.aiNotConfigured");
    mocks.aiReady = true;
    reviewing({ note: " ", dropped: new Set(["c1", "junk"]) });
    await expect(freezeAndReport(cards)).rejects.toThrow("researchReport.nothingPicked");
    expect(mocks.taken).not.toHaveBeenCalled();
    expect(mocks.left).not.toHaveBeenCalled();
    expect(mocks.started).not.toHaveBeenCalled();
  });

  it("freezes the node, leaves the review, and writes the report in the background from what was ticked", async () => {
    reviewing();
    await freezeAndReport(cards);
    expect(mocks.flushed).toHaveBeenCalled();
    expect(mocks.taken).toHaveBeenCalledWith("这周主要试了 B 方法", cards);
    expect(mocks.left).toHaveBeenCalledOnce();
    const [task] = mocks.started.mock.calls[0];
    expect(task).toMatchObject({ root, title: "2026-11-21 组会" });

    const result = { markdownPath: `${root}/汇报/2026-11-21 组会/报告.md` };
    mocks.generated.mockResolvedValue(result);
    const stages: string[] = [];
    expect(await task.run(new AbortController().signal, ({ stage }: { stage: string }) => stages.push(stage))).toBe(
      result,
    );
    expect(stages).toEqual(["collecting"]);
    const [request, materials] = mocks.generated.mock.calls[0];
    expect(request).toMatchObject({
      root,
      skip: ["随手试的废卡"],
      meta: {
        title: "2026-11-21 组会",
        type: "组会",
        project: "课题",
        since: "2026-11-14T10:00:00+08:00",
        snapshot: "2026-11-21 1030",
      },
    });
    expect(materials.evidence.map(({ label }: { label: string }) => label)).toEqual(["这次想讲的", "B 方法的结果"]);

    // 生成好了：活动记录里记一行
    task.onDone(result);
    expect(mocks.summaryNoted).toHaveBeenCalledWith(
      root,
      result.markdownPath,
      expect.objectContaining({ since: "2026-11-14T10:00:00+08:00", snapshot: "2026-11-21 1030" }),
    );
  });
});
