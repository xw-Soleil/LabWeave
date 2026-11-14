import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "/research/课题",
  setting: "",
  disk: new Map<string, Uint8Array | string>(),
  noted: vi.fn(),
  flushed: vi.fn(async () => {}),
  taken: vi.fn(),
  snapshots: [] as { name: string; manifest: { at: string } }[],
  opened: vi.fn(),
}));
vi.mock("@/core/service/Settings", () => ({
  Settings: {
    get progressFolderPath() {
      return mocks.setting;
    },
  },
}));
vi.mock("@/state", async () => ({ store: (await import("jotai")).createStore() }));
vi.mock("@/sub/AIWindow", () => ({ default: { open: mocks.opened } }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (path: string) =>
    mocks.disk.has(path) || [...mocks.disk.keys()].some((file) => file.startsWith(`${path}/`)),
  mkdir: async () => {},
  readDir: async (path: string) =>
    [...mocks.disk.keys()]
      .filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/"))
      .map((file) => ({ name: file.slice(path.length + 1) })),
  readTextFile: async (path: string) => mocks.disk.get(path) as string,
  writeTextFile: async (path: string, text: string) => void mocks.disk.set(path, text),
  writeFile: async (path: string, bytes: Uint8Array) => void mocks.disk.set(path, bytes),
}));
vi.mock("./ActivityLog", () => ({ noteSummary: mocks.noted, flushActivityLog: mocks.flushed }));
vi.mock("./ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => mocks.root,
    ensureRootRegistered: async () => {},
    isInside: (path: string, root: string) => !!root && path.startsWith(`${root}/`),
  },
}));
vi.mock("./Snapshot", () => ({
  takeSnapshot: mocks.taken,
  listSnapshots: async () => mocks.snapshots,
  snapshotFiles: {},
}));

import { localTime } from "./ProjectRecord";
import {
  baselineSnapshot,
  defaultProgressFolder,
  exportSlides,
  loadSummaryStart,
  looksLikeReport,
  parseOutline,
  parseSlidesRequest,
  parseSummaryRequest,
  progressFolder,
  reportFileName,
  reportMarkdown,
  requestSlides,
  saveStageReport,
  slidesPrompt,
  startStageSummary,
  subscribeStageRequests,
  summaryPrompt,
  summaryStart,
} from "./StageSummary";

const at = (day: number, hour = 10) => localTime(new Date(2026, 10, day, hour));
const now = new Date(2026, 10, 15, 12);
const line = (time: string, kind: string, more?: object) =>
  JSON.stringify({ at: time, project: "课题", kind, where: {}, title: "", ...(more && { more }) });
const snapshot = (name: string, time: string) => ({ name, manifest: { at: time } }) as never;

const reply = [
  "好的，下面是这段时间的小结：",
  "",
  "# 2026-11-15 阶段小结",
  "",
  "> 依据：活动记录 5 条。",
  "",
  "## 课题",
  "",
  "### 做了什么",
  "- 读了 main.pdf。[批注：main.pdf 第 3 页](rwb://open?project=课题&path=main.pdf&page=3&annotation=A1)",
  "",
  "### 没写进来的",
  "记录从 2026-11-03 开始。",
].join("\n");

beforeEach(() => {
  mocks.root = "/research/课题";
  mocks.setting = "";
  mocks.disk.clear();
  mocks.snapshots = [];
  vi.clearAllMocks();
});

describe("从哪天写起", () => {
  it("接着上一次小结；没做过就从最早的记录；什么都没有是 7 天前", () => {
    const log = [
      line(at(5), "card.add"),
      "{半行",
      line(at(3), "annotation.add"),
      line(at(8), "summary", { since: at(3), until: at(8, 9) }),
      line(at(9), "card.add"),
      // 更早的那次小结写在后面也不要紧：以文件里最后一条为准
      line(at(12), "summary", { until: at(12, 18) }),
    ].join("\n");
    expect(summaryStart(log, now)).toEqual({ since: at(12, 18), lastSummary: at(12, 18), startedAt: at(3) });
    expect(summaryStart([line(at(5), "card.add"), line(at(3), "note.save")].join("\n"), now)).toEqual({
      since: at(3),
      startedAt: at(3),
    });
    // 老记录里的小结没带范围：用它记下的时刻
    expect(summaryStart(line(at(8), "summary"), now).since).toBe(at(8));
    expect(summaryStart(undefined, now)).toEqual({ since: localTime(new Date(2026, 10, 8, 12)) });
  });

  it("打开时先把攒着的活动写掉再读", async () => {
    mocks.disk.set("/research/课题/.workbench/活动记录.jsonl", line(at(8), "summary", { until: at(8, 9) }));
    expect(await loadSummaryStart(now)).toMatchObject({ since: at(8, 9) });
    expect(mocks.flushed).toHaveBeenCalledTimes(1);
    mocks.root = "";
    await expect(loadSummaryStart(now)).rejects.toThrow("stageSummary.noProject");
  });
});

describe("和哪份快照比", () => {
  const all = [snapshot("c", at(15)), snapshot("b", at(10)), snapshot("a", at(5))];
  it("范围开头之前最近的一份；没有就用范围里最早的；刚拍的那份不算", () => {
    expect(baselineSnapshot(all, at(12), "c")).toBe("b");
    expect(baselineSnapshot(all, at(10), "c")).toBe("b");
    expect(baselineSnapshot(all, at(2), "c")).toBe("a");
    expect(baselineSnapshot([snapshot("c", at(15))], at(2), "c")).toBeUndefined();
  });
});

describe("发给 AI 的话", () => {
  it("第一行带着记号和范围，读得回来", () => {
    const request = { since: at(8, 9), until: at(15, 12), from: "2026-11-08 0900", to: "2026-11-15 1200" };
    const prompt = summaryPrompt(request);
    expect(prompt.split("\n")[0]).toBe(`【阶段小结】${at(8, 9)} ~ ${at(15, 12)}`);
    expect(prompt).toContain("read_report_guide");
    expect(prompt).toContain("from 填「2026-11-08 0900」，to 填「2026-11-15 1200」");
    expect(parseSummaryRequest(prompt)).toEqual(request);
    // 白板上选着卡片时，消息前面会多一行
    expect(parseSummaryRequest(`[selected: n1]\n${prompt}`)).toEqual(request);
  });

  it("只有刚拍的一份快照、或者没有快照时，让 AI 跳过对比", () => {
    const only = summaryPrompt({ since: "2026-11-08", until: "2026-11-15", to: "2026-11-15 1200" });
    expect(only).toContain("跳过比快照这一步");
    expect(parseSummaryRequest(only)).toEqual({ since: "2026-11-08", until: "2026-11-15", to: "2026-11-15 1200" });
    const none = summaryPrompt({ since: "2026-11-08", until: "2026-11-15" });
    expect(parseSummaryRequest(none)).toEqual({ since: "2026-11-08", until: "2026-11-15" });
    expect(parseSummaryRequest("这周我做了什么")).toBeUndefined();
  });

  it("开始做小结：先写掉攒着的活动，拍一份快照，再把话交给 AI 面板", async () => {
    mocks.taken.mockResolvedValue({ name: "2026-11-15 1200" });
    mocks.snapshots = [snapshot("2026-11-15 1200", at(15, 12)), snapshot("2026-11-08 0900", at(8, 9))];
    const sent: string[] = [];
    const stop = subscribeStageRequests((text) => sent.push(text));
    await startStageSummary({ since: at(9), until: at(15, 12) });
    expect(mocks.flushed).toHaveBeenCalled();
    expect(mocks.taken).toHaveBeenCalledWith("summary");
    expect(sent).toHaveLength(1);
    expect(parseSummaryRequest(sent[0])).toEqual({
      since: at(9),
      until: at(15, 12),
      from: "2026-11-08 0900",
      to: "2026-11-15 1200",
    });
    await vi.waitFor(() => expect(mocks.opened).toHaveBeenCalled());
    stop();
    // 面板还没开着时先攒着，开了以后一次交给它，不重复
    requestSlides("/research/我的进展/2026-11-15 阶段小结.md");
    const later: string[] = [];
    subscribeStageRequests((text) => later.push(text))();
    subscribeStageRequests((text) => later.push(text))();
    expect(later).toEqual([slidesPrompt("/research/我的进展/2026-11-15 阶段小结.md")]);
  });
});

describe("存报告", () => {
  const request = { since: at(8, 9), until: at(15, 12), from: "2026-11-08 0900", to: "2026-11-15 1200" };

  it("认得出写完的报告", () => {
    expect(looksLikeReport(reply)).toBe(true);
    expect(looksLikeReport("# 2026-11-15 阶段小结\n\n我先读一下活动记录")).toBe(false);
  });

  it("去掉客套话和模型自己写的属性，换成程序填的", () => {
    const expected = [
      "---",
      "类型: 阶段小结",
      "日期: 2026-11-15",
      "范围: 2026-11-08 ~ 2026-11-15",
      "项目: [课题]",
      "快照: 2026-11-15 1200",
      "---",
      "",
      reply.slice(reply.indexOf("# 2026")),
      "",
    ].join("\n");
    expect(reportMarkdown(reply, { project: "课题", request, now })).toBe(expected);
    const body = reply.slice(reply.indexOf("# 2026"));
    expect(reportMarkdown(`---\n类型: 别的\n---\n\n${body}`, { project: "课题", request, now })).toBe(expected);
    expect(reportMarkdown(`\`\`\`markdown\n${body}\n\`\`\``, { project: "课题", request, now })).toBe(expected);
    // 没有快照时不写那一行；项目名里有 YAML 认的符号时加引号
    expect(
      reportMarkdown(body, { project: "a: b", request: { since: "2026-11-08", until: "2026-11-15" }, now }),
    ).toContain('范围: 2026-11-08 ~ 2026-11-15\n项目: ["a: b"]\n---');
  });

  it("文件名带日期，同一天的第二份加序号", () => {
    expect(reportFileName(now, () => false)).toBe("2026-11-15 阶段小结.md");
    const taken = new Set(["2026-11-15 阶段小结.md", "2026-11-15 阶段小结-2.md"]);
    expect(reportFileName(now, (name) => taken.has(name))).toBe("2026-11-15 阶段小结-3.md");
  });

  it("默认放在项目文件夹旁边的「我的进展」，设置里填了就用填的", () => {
    expect(defaultProgressFolder("/research/课题")).toBe("/research/我的进展");
    expect(defaultProgressFolder("C:\\Users\\x\\课题\\")).toBe("C:/Users/x/我的进展");
    expect(defaultProgressFolder("/课题")).toBe("/课题/我的进展");
    expect(progressFolder()).toBe("/research/我的进展");
    mocks.setting = "/elsewhere/进展";
    expect(progressFolder()).toBe("/elsewhere/进展");
    mocks.root = "";
    mocks.setting = "";
    expect(progressFolder()).toBe("");
  });

  it("存进「我的进展」，在活动记录里记一行；同一份再存一次不多出文件", async () => {
    const path = await saveStageReport(reply, request, now);
    expect(path).toBe("/research/我的进展/2026-11-15 阶段小结.md");
    expect(mocks.disk.get(path)).toBe(reportMarkdown(reply, { project: "课题", request, now }));
    expect(mocks.noted).toHaveBeenCalledWith("/research/课题", path, {
      since: at(8, 9),
      until: at(15, 12),
      snapshot: "2026-11-15 1200",
    });
    expect(mocks.flushed).toHaveBeenCalledTimes(1);

    expect(await saveStageReport(reply, request, new Date(2026, 10, 15, 18))).toBe(path);
    expect(mocks.noted).toHaveBeenCalledTimes(1);
    expect([...mocks.disk.keys()]).toEqual([path]);

    // 内容不一样的是另一份
    const second = await saveStageReport(reply.replace("读了 main.pdf", "又读了一遍"), request, now);
    expect(second).toBe("/research/我的进展/2026-11-15 阶段小结-2.md");
    expect(mocks.noted).toHaveBeenCalledTimes(2);
  });
});

describe("出 PPT", () => {
  const report = "/research/我的进展/2026-11-15 阶段小结.md";
  const outline = [
    { title: "2026-11-15 阶段小结", bullets: ["范围：11-08 ~ 11-15", "项目：课题"] },
    { title: "做了什么", bullets: ["读了 main.pdf", "", 3], card: "rwb://open?project=课题&path=白板.prg&target=c1" },
    { title: "  ", bullets: ["没有标题的不要"] },
    "不是一页",
  ];

  it("请求第一行带着报告的路径，读得回来", () => {
    expect(parseSlidesRequest(slidesPrompt(report))).toEqual({ report });
    expect(parseSlidesRequest(summaryPrompt({ since: "a", until: "b" }))).toBeUndefined();
  });

  it("从回答里取出提纲：认代码块外壳，丢掉不成样子的页，卡片只留编号", () => {
    const expected = [
      { title: "2026-11-15 阶段小结", bullets: ["范围：11-08 ~ 11-15", "项目：课题"] },
      { title: "做了什么", bullets: ["读了 main.pdf"], card: "c1" },
    ];
    expect(parseOutline(JSON.stringify(outline))).toEqual(expected);
    expect(parseOutline(`提纲如下：\n\`\`\`json\n${JSON.stringify(outline, null, 2)}\n\`\`\`\n共 2 页。`)).toEqual(
      expected,
    );
    for (const bad of ["我不会", "[1, 2]", '[{"title": ""}]', '[{"title": "a"']) {
      expect(() => parseOutline(bad)).toThrow("stageSummary.outlineInvalid");
    }
  });

  it("转成 .pptx 放在报告旁边，提纲里指定的卡片去要配图", async () => {
    mocks.disk.set(report, "报告");
    const asked: string[] = [];
    const path = await exportSlides(JSON.stringify(outline), report, async (card) => {
      asked.push(card);
      return undefined;
    });
    expect(path).toBe("/research/我的进展/2026-11-15 阶段小结.pptx");
    expect(asked).toEqual(["c1"]);
    const reader = new ZipReader(new Uint8ArrayReader(mocks.disk.get(path) as Uint8Array));
    const names = (await reader.getEntries()).map((entry) => entry.filename);
    await reader.close();
    expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
  });

  it("只认「我的进展」里现成的报告，免得往别处写文件", async () => {
    mocks.disk.set("/elsewhere/a.md", "别处的文件");
    for (const path of ["/elsewhere/a.md", "/research/我的进展/不存在.md", "/research/我的进展/2026.txt"]) {
      await expect(exportSlides("[]", path, async () => undefined)).rejects.toThrow("stageSummary.reportMissing");
    }
    expect([...mocks.disk.keys()]).toEqual(["/elsewhere/a.md"]);
  });
});
