import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { JSDOM } from "jsdom";
import { mkdir, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import {
  collectReportMaterials,
  generateResearchReport,
  generateWeeklyResearchReport,
  listResearchReportDrafts,
  parseReportDraft,
  retryResearchReportExport,
  type ReportDependencies,
  type WeeklyReportDependencies,
} from "./ResearchReport";
import { createReportPptx, type ReportDocument } from "./ResearchReportExport";
import type { ResearchSnapshot } from "./ResearchHistoryTypes";
import { parseWeeklyRecord, updateWeeklyMarkdownItem, type WeeklyRecord } from "./WeeklyProgress";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII="),
  (char) => char.charCodeAt(0),
);
const webp = Uint8Array.from(atob("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"), (char) =>
  char.charCodeAt(0),
);
afterEach(() => vi.unstubAllGlobals());

function browserImageDecoder(width = 1, height = 1) {
  const bitmap = { width, height, close: vi.fn() };
  const decode = vi.fn(async (blob: Blob) => {
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(webp);
    return bitmap;
  });
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: vi.fn((callback: (blob: Blob) => void, type: string) => {
      expect(type).toBe("image/png");
      callback(new Blob([png], { type: "image/png" }));
    }),
  };
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("document", { createElement: () => canvas });
  return { decode, drawImage, bitmap, canvas };
}
const draft = {
  title: "文献阅读进展",
  summary: "阅读文献并整理待验证假设，尚无实验结果。",
  sections: [
    {
      heading: "本周阅读",
      paragraphs: ["方法 A 的结论来自文献，下一步需要复现。"],
      sourceIds: ["S1"],
      imageIds: [] as string[],
    },
  ],
};
const snapshot: ResearchSnapshot = {
  version: 1,
  id: "snapshot-1",
  projectId: "project-1",
  createdAt: "2026-11-20T12:00:00Z",
  weekStart: "2026-11-16",
  reason: "report",
  files: [{ path: "笔记.md", hash: "hash", size: 30, kind: "markdown" }],
  warnings: [],
};

function fixture() {
  const files = new Map<string, Uint8Array>();
  const input = new Map([["笔记.md", encoder.encode("# 文献记录\n文献认为方法 A 有效，尚未复现。")]]);
  const io: ReportDependencies = {
    listSnapshots: vi.fn(async () => [snapshot]),
    readSnapshotFile: vi.fn(async (_root, id, path) => {
      expect(id).toBe(snapshot.id);
      const bytes = input.get(path);
      if (!bytes) throw new Error("missing fixture");
      return bytes;
    }),
    diffSnapshots: vi.fn(async (_root, beforeId, afterId) => ({ beforeId, afterId, changes: [], warnings: [] })),
    generate: vi.fn(async () => JSON.stringify(draft)),
    mkdir: vi.fn(async () => undefined),
    write: vi.fn(async (path, bytes) => {
      if (files.has(path)) throw new Error("file exists");
      files.set(path, bytes);
    }),
    read: vi.fn(async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("file not found");
      return bytes;
    }),
    listDirectories: vi.fn(async (path) => [
      ...new Set(
        [...files.keys()]
          .filter((file) => file.startsWith(path + "/"))
          .map((file) => file.slice(path.length + 1).split("/")[0]),
      ),
    ]),
  };
  return { io, files, input };
}

function weeklyFixture(links: WeeklyRecord["links"] = []) {
  const original = fixture();
  const record: WeeklyRecord = {
    weekStart: "2026-11-16",
    path: "进展记录/周进展/2026-11-16.md",
    markdown: "# 周进展\n## 本周完成\n- [x] 整理方法 A 的阅读记录\n## 下周方向\n- [ ] 复现方法 A，尚未开展实验",
    revision: "week-revision-1",
    items: [],
    links,
  };
  const io: WeeklyReportDependencies & ReportDependencies = {
    ...original.io,
    loadRecord: vi.fn(async () => record),
    readLinkedFile: vi.fn(async (_root, path) => {
      const bytes = original.input.get(path);
      if (!bytes) throw new Error("missing linked material");
      return bytes;
    }),
  };
  return { ...original, io, record };
}

async function unzip(bytes: Uint8Array) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const result = new Map<string, Uint8Array>();
    for (const entry of await reader.getEntries())
      if (!entry.directory) result.set(entry.filename, await entry.getData!(new Uint8ArrayWriter()));
    return result;
  } finally {
    await reader.close();
  }
}

describe("research reports", () => {
  it("collects updated item details and attachments after editing an existing weekly task", async () => {
    const { io, input, files, record } = weeklyFixture();
    const before = parseWeeklyRecord({
      ...record,
      markdown:
        "# 周进展\n\n## 待办事项\n- [ ] **核对实验条件** — 原先待补充的内容 [旧笔记](<../../旧笔记.md>)\n  ![旧图](<附件/2026-11-16/old.png>)\n\n## 下周方向\n- [ ] 与老师讨论验证方案\n",
    });
    const imagePath = "进展记录/周进展/附件/2026-11-16/new.png";
    const edited = parseWeeklyRecord({
      ...before,
      markdown: updateWeeklyMarkdownItem(before, before.items[0].id, {
        summary: "实验条件与原始观测核对",
        text: "已补充采样条件与原始观测，仍需验证结论。",
        links: [{ label: "实验条件", href: "../../实验条件.md" }],
        images: [{ label: "原始观测", href: "附件/2026-11-16/new.png" }],
      }),
      revision: "edited-week-revision",
    });
    io.loadRecord = vi.fn(async () => edited);
    input.set("实验条件.md", encoder.encode("# 实验条件\n采样条件尚待进一步确认。"));
    input.set(imagePath, png);
    input.set("旧笔记.md", encoder.encode("不应读取的已移除资料"));
    input.set("进展记录/周进展/附件/2026-11-16/old.png", png);
    io.generate = vi.fn(async () =>
      JSON.stringify({ ...draft, sections: [{ ...draft.sections[0], sourceIds: ["S1"], imageIds: ["I1"] }] }),
    );
    const result = await generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io);
    expect(edited.items[0].done).toBe(false);
    expect(edited.items[1].text).toBe("与老师讨论验证方案");
    expect(
      vi
        .mocked(io.readLinkedFile)
        .mock.calls.map((call) => call[1])
        .sort(),
    ).toEqual(["实验条件.md", imagePath].sort());
    const prompt = vi.mocked(io.generate).mock.calls[0][0];
    expect(prompt).toContain("已补充采样条件与原始观测，仍需验证结论");
    expect(prompt).toContain("采样条件尚待进一步确认");
    expect(prompt).not.toContain("原先待补充的内容");
    expect(prompt).not.toContain("旧笔记.md");
    const archive = await unzip(files.get(result.pptxPath)!);
    expect(archive.get("ppt/media/I1.png")).toEqual(png);
    expect(decoder.decode(files.get(result.markdownPath)!)).toContain("素材/I1.png");
  });

  it("exports explicitly embedded weekly images with original detail and their source links", async () => {
    const { io, input, files, record } = weeklyFixture();
    const imagePath = "进展记录/周进展/附件/2026-11-16/experiment.png";
    const parsed = parseWeeklyRecord({
      ...record,
      markdown:
        "# 周进展\n\n## 本周进展\n- [x] **实验记录整理** — 这张图记录原始观测，尚不能推断最终结论。\n  ![实验观察](<附件/2026-11-16/experiment.png>)\n",
    });
    io.loadRecord = vi.fn(async () => parsed);
    input.set(imagePath, png);
    input.set("unrelated.png", png);
    io.generate = vi.fn(async () =>
      JSON.stringify({ ...draft, sections: [{ ...draft.sections[0], sourceIds: ["S1", "S2"], imageIds: ["I1"] }] }),
    );
    const result = await generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io);
    expect(io.readLinkedFile).toHaveBeenCalledExactlyOnceWith("/project", imagePath);
    expect(vi.mocked(io.generate).mock.calls[0][0]).toContain("尚不能推断最终结论");
    const archive = await unzip(files.get(result.pptxPath)!);
    expect(archive.get("ppt/media/I1.png")).toEqual(png);
    const markdown = decoder.decode(files.get(result.markdownPath)!);
    expect(markdown).toContain("素材/I1.png");
    expect(io.readSnapshotFile).not.toHaveBeenCalled();
    expect(io.listSnapshots).not.toHaveBeenCalled();
  });

  it("generates from one weekly note and only its direct links without creating or reading snapshots", async () => {
    const { io, input, files, record } = weeklyFixture([{ label: "方法 A", href: "../../笔记.md#方法-A" }]);
    input.set(
      "笔记.md",
      encoder.encode(
        "# 文献记录\n## **方法 A**\n有效性来自文献，尚未复现。\n[其他材料](其他.md)\n## 旧项目\n不应纳入的旧材料",
      ),
    );
    input.set("其他.md", encoder.encode("不应递归读取的材料"));
    io.generate = vi.fn(async () => {
      expect(files.size).toBe(0);
      return JSON.stringify({ ...draft, sections: [{ ...draft.sections[0], sourceIds: ["S1", "S2"] }] });
    });
    const result = await generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io);
    expect(io.listSnapshots).not.toHaveBeenCalled();
    expect(io.readSnapshotFile).not.toHaveBeenCalled();
    expect(io.diffSnapshots).not.toHaveBeenCalled();
    expect(io.readLinkedFile).toHaveBeenCalledExactlyOnceWith("/project", "笔记.md");
    const prompt = vi.mocked(io.generate).mock.calls[0][0];
    expect(prompt).toContain("整理方法 A 的阅读记录");
    expect(prompt).toContain("有效性来自文献");
    expect(prompt).not.toContain("不应纳入的旧材料");
    expect(prompt).not.toContain("不应递归读取的材料");
    expect(prompt.indexOf(record.path)).toBeLessThan(prompt.indexOf("笔记.md#方法-A"));
    expect(result.snapshotId).toBe(`weekly:${record.weekStart}:${record.revision}`);
    expect(
      [...files.keys()].every(
        (path) => path.startsWith("/project/汇报/") || path.startsWith("/project/.workbench/report-jobs/"),
      ),
    ).toBe(true);
    const markdown = decoder.decode(files.get(result.markdownPath));
    expect(markdown).toContain(`../../${encodeURIComponent("笔记.md")}#${encodeURIComponent("方法-A")}`);
    expect(markdown).not.toContain("输入快照");
    const saved = await listResearchReportDrafts("/project", io);
    await retryResearchReportExport("/project", saved.entries[0].jobId, undefined, io);
    expect(io.generate).toHaveBeenCalledOnce();
  });

  it("uses saved annotations of an explicitly linked PDF page without reading or archiving the PDF", async () => {
    const { io, input, record } = weeklyFixture([{ label: "论文第 3 页", href: "../../论文.pdf#page=3" }]);
    input.set(
      ".workbench/annotations/论文.pdf.json",
      encoder.encode(
        JSON.stringify([
          { id: "a1", position: { pageIndex: 2 }, text: "所选第三页摘录", comment: "尚待验证" },
          { id: "a2", position: { pageIndex: 8 }, text: "其他页不应纳入" },
        ]),
      ),
    );
    const result = await generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io);
    expect(io.readLinkedFile).toHaveBeenCalledExactlyOnceWith("/project", ".workbench/annotations/论文.pdf.json");
    const prompt = vi.mocked(io.generate).mock.calls[0][0];
    expect(prompt).toContain("所选第三页摘录");
    expect(prompt).toContain("论文.pdf#page=3");
    expect(prompt).not.toContain("其他页不应纳入");
    expect(result.warnings.join("\n")).toContain("未读取全文或复制文件");
  });

  it("reads only the explicitly linked canvas node and tolerates a damaged linked canvas", async () => {
    const { io, input, record } = weeklyFixture([
      { label: "所选卡片", href: "../../board.prg#node=n1" },
      { label: "损坏画布", href: "../../broken.prg" },
    ]);
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      "stage.msgpack",
      new Uint8ArrayReader(
        encode([
          {
            _: "FileCardNode",
            uuid: "n1",
            title: "所选文献卡片",
            sourcePath: "paper.pdf",
            fileKind: "pdf",
            excerpt: "所选节点内容",
            pdfPage: 3,
          },
          {
            _: "FileCardNode",
            uuid: "n2",
            title: "其他卡片",
            sourcePath: "other.pdf",
            fileKind: "pdf",
            excerpt: "其他节点不应纳入",
            pdfPage: 1,
          },
        ]),
      ),
    );
    input.set("board.prg", await writer.close());
    input.set("broken.prg", encoder.encode("damaged archive"));
    const result = await generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io);
    const prompt = vi.mocked(io.generate).mock.calls[0][0];
    expect(prompt).toContain("所选节点内容");
    expect(prompt).toContain("board.prg#node=n1");
    expect(prompt).not.toContain("其他节点不应纳入");
    expect(result.warnings).toContain("关联材料无法解析，未纳入：broken.prg");
    expect(vi.mocked(io.readLinkedFile).mock.calls.map((call) => call[1])).toEqual(["board.prg", "broken.prg"]);
  });

  it("limits material reads to 20 direct links and keeps the weekly record first", async () => {
    const { io, input, record } = weeklyFixture(
      Array.from({ length: 22 }, (_, index) => ({ label: `材料 ${index}`, href: `../../note-${index}.md` })),
    );
    for (let index = 0; index < 22; index++) input.set(`note-${index}.md`, encoder.encode(`材料 ${index}`));
    const result = await generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io);
    expect(io.readLinkedFile).toHaveBeenCalledTimes(20);
    expect(result.warnings.join("\n")).toContain("仅纳入前 20 条直接链接");
    expect(vi.mocked(io.readLinkedFile).mock.calls.some((call) => call[1] === "note-20.md")).toBe(false);
    expect(vi.mocked(io.generate).mock.calls[0][0]).toContain(`"id":"S1","path":"${record.path}"`);
  });

  it("keeps the weekly note usable when a link is missing, unsafe, or has a missing heading", async () => {
    const { io, input, record } = weeklyFixture([
      { label: "缺失", href: "../../缺失.md" },
      { label: "标题", href: "../../笔记.md#没有这个标题" },
      { label: "越界", href: "../../../outside.md" },
      { label: "外部", href: "https://example.com/paper.md" },
      { label: "绝对路径", href: "C:/private.md" },
      { label: "文件夹", href: "../../目录/" },
    ]);
    input.set("笔记.md", encoder.encode("# 文献记录\n不应整篇退回读取"));
    const result = await generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io);
    expect(vi.mocked(io.readLinkedFile).mock.calls.map((call) => call[1])).toEqual(["缺失.md", "笔记.md"]);
    expect(result.warnings.join("\n")).toContain("关联标题未找到");
    expect(result.warnings.join("\n")).toContain("关联材料无法读取");
    expect(vi.mocked(io.generate).mock.calls[0][0]).not.toContain("不应整篇退回读取");
  });

  it("stops if the weekly record changed during collection, and cancels before model requests or writes", async () => {
    const changed = weeklyFixture([{ label: "笔记", href: "../../笔记.md" }]);
    vi.mocked(changed.io.loadRecord)
      .mockResolvedValueOnce(changed.record)
      .mockResolvedValueOnce({ ...changed.record, revision: "edited" });
    await expect(
      generateWeeklyResearchReport({ root: "/project", weekStart: changed.record.weekStart }, changed.io),
    ).rejects.toThrow("weekRecordChanged");
    expect(changed.io.generate).not.toHaveBeenCalled();
    expect(changed.files.size).toBe(0);
    const cancelled = weeklyFixture();
    await expect(
      generateWeeklyResearchReport(
        { root: "/project", weekStart: cancelled.record.weekStart, signal: AbortSignal.abort() },
        cancelled.io,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.io.loadRecord).not.toHaveBeenCalled();
    expect(cancelled.io.generate).not.toHaveBeenCalled();
    expect(cancelled.files.size).toBe(0);
  });

  it("rejects missing and empty weekly notes before model requests", async () => {
    const { io, record } = weeklyFixture();
    vi.mocked(io.loadRecord)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...record, markdown: "# 周进展\n\n## 本周完成\n\n## 下周方向\n" });
    await expect(generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io)).rejects.toThrow(
      "weeklyMissing",
    );
    await expect(generateWeeklyResearchReport({ root: "/project", weekStart: record.weekStart }, io)).rejects.toThrow(
      "noMaterials",
    );
    expect(io.generate).not.toHaveBeenCalled();
  });

  it("generates editable PPTX and Markdown from an immutable snapshot without overwriting earlier exports", async () => {
    const { io, files } = fixture();
    const first = await generateResearchReport({ root: "/project", snapshotId: snapshot.id }, io);
    const second = await generateResearchReport({ root: "/project", snapshotId: snapshot.id }, io);
    expect(first.directory).not.toBe(second.directory);
    expect(first.jobId).toBeTruthy();
    expect(decoder.decode(files.get(first.markdownPath))).toContain("方法 A 的结论来自文献");
    const archive = await unzip(files.get(first.pptxPath)!);
    expect(archive.has("ppt/presentation.xml")).toBe(true);
    expect(decoder.decode(archive.get("ppt/slides/slide2.xml"))).toContain("方法 A 的结论来自文献");
    expect(io.generate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(io.generate).mock.calls[0][0]).toContain("文献认为方法 A 有效");
    expect(
      [...files.keys()].every(
        (path) => path.startsWith("/project/汇报/") || path.startsWith("/project/.workbench/report-jobs/"),
      ),
    ).toBe(true);
  });

  it("rejects invented references and repairs malformed model output once", async () => {
    const { io } = fixture();
    const invalid = { ...draft, sections: [{ ...draft.sections[0], sourceIds: ["invented"] }] };
    vi.mocked(io.generate).mockResolvedValueOnce(JSON.stringify(invalid));
    await generateResearchReport({ root: "/project", snapshotId: snapshot.id }, io);
    expect(io.generate).toHaveBeenCalledTimes(2);
    expect(() =>
      parseReportDraft(JSON.stringify(invalid), [{ id: "S1", path: "note.md", label: "Note", text: "record" }], []),
    ).toThrow("invalidReferences");
  });

  it("retains a structured draft after export failure and retries without another model call", async () => {
    const { io, files } = fixture();
    const write = io.write;
    io.write = vi.fn(async (path, bytes) => {
      if (path.endsWith(".pptx")) throw new Error("disk full");
      await write(path, bytes);
    });
    let jobId = "";
    try {
      await generateResearchReport({ root: "/project", snapshotId: snapshot.id }, io);
    } catch (error) {
      expect((error as Error).message).toBe("researchReport.exportFailed");
      jobId = (error as { jobId: string }).jobId;
    }
    expect(jobId).toBeTruthy();
    expect(files.has(`/project/.workbench/report-jobs/${jobId}/draft.json`)).toBe(true);
    io.write = write;
    const reinitialized = {
      ...io,
      generate: vi.fn(async () => {
        throw new Error("must not call model");
      }),
    };
    const savedDrafts = await listResearchReportDrafts("/project", reinitialized);
    expect(savedDrafts.entries).toContainEqual(
      expect.objectContaining({ jobId, title: draft.title, snapshotId: snapshot.id }),
    );
    expect(savedDrafts.warnings).toEqual([]);
    const result = await retryResearchReportExport("/project", savedDrafts.entries[0].jobId, undefined, reinitialized);
    expect(files.has(result.pptxPath)).toBe(true);
    expect(io.generate).toHaveBeenCalledOnce();
    expect(reinitialized.generate).not.toHaveBeenCalled();
    await expect(retryResearchReportExport("/project", "../../escape", undefined, io)).rejects.toThrow("invalidDraft");
  });

  it("lists valid saved drafts even when another draft is damaged", async () => {
    const { io, files } = fixture();
    const result = await generateResearchReport({ root: "/project", snapshotId: snapshot.id }, io);
    const invalidJsonId = crypto.randomUUID();
    const invalidSchemaId = crypto.randomUUID();
    files.set(`/project/.workbench/report-jobs/${invalidJsonId}/draft.json`, encoder.encode("{unfinished"));
    files.set(`/project/.workbench/report-jobs/${invalidSchemaId}/draft.json`, encoder.encode("{}"));
    const saved = await listResearchReportDrafts("/project", io);
    expect(saved.entries).toEqual([expect.objectContaining({ jobId: result.jobId })]);
    expect(saved.warnings).toEqual([
      { jobId: invalidJsonId, code: "researchReport.invalidDraft" },
      { jobId: invalidSchemaId, code: "researchReport.invalidDraft" },
    ]);
  });

  it.each(["png", "webp"])(
    "reads embedded %s screenshots and frozen PDF annotations, preserving provenance",
    async (extension) => {
      const { io, input } = fixture();
      const browser = extension === "webp" ? browserImageDecoder() : undefined;
      const writer = new ZipWriter(new Uint8ArrayWriter());
      await writer.add(
        "stage.msgpack",
        new Uint8ArrayReader(
          encode([
            {
              _: "FileCardNode",
              uuid: "n1",
              title: "Paper A",
              sourcePath: "paper.pdf",
              fileKind: "pdf",
              excerpt: "图示方法",
              attachmentId: "image-1",
              pdfPage: 3,
              pageCount: 8,
            },
          ]),
        ),
      );
      await writer.add(`attachments/image-1.${extension}`, new Uint8ArrayReader(extension === "webp" ? webp : png));
      input.set("board.prg", await writer.close());
      input.set(
        ".workbench/annotations/paper.pdf.json",
        encoder.encode(
          JSON.stringify({
            annotations: [
              { id: "a1", pageLabel: "3", text: "论文原文", comment: "有待验证", position: { pageIndex: 2 } },
            ],
          }),
        ),
      );
      const version = {
        ...snapshot,
        files: [
          ...snapshot.files,
          { path: "board.prg", kind: "workspace" as const, hash: "board", size: 200 },
          {
            path: ".workbench/annotations/paper.pdf.json",
            kind: "annotations" as const,
            hash: "annotations",
            size: 300,
          },
        ],
      };
      const result = await collectReportMaterials(version, "/project", io);
      expect(result.images).toHaveLength(1);
      expect(result.images[0]).toMatchObject({ width: 1, height: 1 });
      expect(result.evidence.some((item) => item.label.includes("第 3 页") && item.text.includes("有待验证"))).toBe(
        true,
      );
      expect(result.evidence.some((item) => item.id === result.images[0].sourceId)).toBe(true);
      expect(result.images[0]).toMatchObject({ filename: "I1.png", bytes: png });
      if (browser) {
        expect(browser.decode).toHaveBeenCalledOnce();
        expect(browser.drawImage).toHaveBeenCalledWith(browser.bitmap, 0, 0);
        expect(browser.bitmap.close).toHaveBeenCalledOnce();
        expect(browser.canvas.width).toBe(0);
      }
      const imageSource = result.images[0].sourceId;
      const archive = await unzip(
        await createReportPptx({
          ...result,
          draft: { ...draft, sections: [{ ...draft.sections[0], sourceIds: [imageSource], imageIds: ["I1"] }] },
          snapshotId: snapshot.id,
          capturedAt: snapshot.createdAt,
        }),
      );
      expect(archive.get("ppt/media/I1.png")).toEqual(png);
    },
  );

  it("warns instead of allocating an oversized WebP conversion canvas", async () => {
    const browser = browserImageDecoder(6000, 6000);
    const { io, input } = fixture();
    input.set("screenshot.webp", webp);
    const result = await collectReportMaterials(
      {
        ...snapshot,
        files: [...snapshot.files, { path: "screenshot.webp", kind: "image", hash: "webp", size: webp.length }],
      },
      "/project",
      io,
    );
    expect(result.images).toEqual([]);
    expect(result.warnings).toContain("图片未纳入导出（无法解码或超过转换限制）：screenshot.webp");
    expect(browser.drawImage).not.toHaveBeenCalled();
    expect(browser.bitmap.close).toHaveBeenCalledOnce();
  });

  it("does not silently include generated reports or claim PDF-only sources have been read", async () => {
    const { io } = fixture();
    const version: ResearchSnapshot = {
      ...snapshot,
      files: [
        { path: "汇报/old.md", hash: "old", size: 100, kind: "markdown" },
        { path: "paper.pdf", hash: "pdf", size: 100, kind: "pdf" },
      ],
    };
    await expect(collectReportMaterials(version, "/project", io)).rejects.toThrow("noMaterials");
    expect(io.readSnapshotFile).not.toHaveBeenCalled();
  });

  it("cancels before any model or output write", async () => {
    const { io } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateResearchReport({ root: "/project", snapshotId: snapshot.id, signal: controller.signal }, io),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(io.generate).not.toHaveBeenCalled();
    expect(io.write).not.toHaveBeenCalled();
  });
});

describe("PPTX export", () => {
  it("emits well-formed XML, resolved relationships, images and paginated editable text", async () => {
    const paragraph = "用于检验分页是否保留全部段落内容。".repeat(45) + "最后一句必须保留";
    const document: ReportDocument = {
      draft: { ...draft, sections: [{ ...draft.sections[0], paragraphs: [paragraph], imageIds: ["I1"] }] },
      evidence: [{ id: "S1", path: "paper.pdf", label: "论文 & <图>", text: "原文" }],
      images: [{ id: "I1", sourceId: "S1", filename: "I1.png", bytes: png, width: 1, height: 1 }],
      snapshotId: "snapshot-1",
      capturedAt: snapshot.createdAt,
      warnings: [],
    };
    const pptx = await createReportPptx(document);
    await mkdir(resolve(".local"), { recursive: true });
    await writeFile(resolve(".local/research-report-sample.pptx"), pptx);
    const archive = await unzip(pptx);
    const parser = new new JSDOM("").window.DOMParser();
    for (const [path, bytes] of archive)
      if (/\.(xml|rels)$/.test(path)) {
        const xml = parser.parseFromString(decoder.decode(bytes), "application/xml");
        expect(xml.querySelector("parsererror"), path).toBeNull();
        if (path.endsWith(".rels")) {
          const owner = path.replace(/(^|\/)_rels\//, "$1").replace(/\.rels$/, "");
          const directory = path === "_rels/.rels" ? "" : posix.dirname(owner);
          for (const relationship of xml.getElementsByTagName("Relationship")) {
            const target = relationship.getAttribute("Target")!;
            expect(archive.has(posix.normalize(posix.join(directory, target))), `${path}: ${target}`).toBe(true);
          }
        }
      }
    const slides = [...archive].filter(([path]) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
    expect(slides.length).toBeGreaterThan(5);
    expect(slides.map(([, bytes]) => decoder.decode(bytes)).join("")).toContain("最后一句必须保留");
    expect(archive.get("ppt/media/I1.png")).toEqual(png);
    const imageSlide = slides.find(([, bytes]) => decoder.decode(bytes).includes("rIdImage"));
    expect(imageSlide).toBeDefined();
    const slideXml = decoder.decode(imageSlide![1]);
    expect(slideXml).toContain('noChangeAspect="1"');
  });
});
