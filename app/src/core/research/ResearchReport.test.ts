import { describe, expect, it } from "vitest";
import {
  collectReportMaterials,
  generateResearchReport,
  parseReportDraft,
  reportFolderName,
  reportImageDimensions,
  reportPrompt,
  retryResearchReportExport,
  type ReportOutputDependencies,
  type ReportRequest,
} from "./ResearchReport";

const root = "/research/课题";
const folder = `${root}/汇报/2026-11-21 组会`;
const meta = {
  title: "2026-11-21 组会",
  type: "组会",
  project: "课题",
  since: "2026-11-14T10:00:00+08:00",
  until: "2026-11-21T10:30:00+08:00",
  snapshot: "2026-11-21 1030",
};
const request: ReportRequest = { root, meta };

/** 只有文件头的 PNG：够认出宽高 */
function png(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const draft = (sections: { sourceIds: string[]; imageIds?: string[] }[]) =>
  JSON.stringify({
    title: "这周的进展",
    summary: "试了 B 方法。",
    sections: sections.map((section, index) => ({
      heading: `第 ${index + 1} 节`,
      paragraphs: ["这一节的话。"],
      imageIds: [],
      ...section,
    })),
  });

function fakeIo(replies: string[], failWrite?: (path: string) => boolean) {
  const files = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  const prompts: string[] = [];
  const io: ReportOutputDependencies = {
    async generate(prompt) {
      prompts.push(prompt);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("没有准备更多的回答");
      return reply;
    },
    async mkdir(path) {
      folders.add(path);
    },
    async write(path, bytes) {
      if (failWrite?.(path)) throw new Error("磁盘满了");
      if (files.has(path)) throw new Error(`不能覆盖：${path}`);
      files.set(path, bytes);
    },
    async read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`没有这个文件：${path}`);
      return bytes;
    },
    exists: async (path) => files.has(path) || folders.has(path),
  };
  const written = () => [...files.keys()].map((path) => path.slice(root.length + 1)).sort();
  const text = (path: string) => new TextDecoder().decode(files.get(path));
  return { io, files, prompts, written, text };
}

async function someMaterials() {
  const materials = collectReportMaterials();
  materials.add({ path: "节点：2026-11-21 组会", label: "这次想讲的", text: "这周主要试了 B 方法" });
  const card = materials.add({
    path: "白板.prg#c1",
    label: "【进展】B 方法的结果",
    text: "边界条件会炸",
    link: "rwb://open?project=课题&path=白板.prg&target=c1",
  })!;
  await materials.addImage(png(800, 600), card, "结果图");
  return materials.done();
}

describe("collecting materials", () => {
  it("numbers what is added in order and says what did not fit instead of dropping it silently", async () => {
    const materials = collectReportMaterials();
    expect(materials.add({ path: "a", label: "空的", text: "   " })).toBeUndefined();
    expect(materials.add({ path: "a", label: "第一条", text: "甲" })).toBe("S1");
    expect(materials.add({ path: "b", label: "很长的笔记", text: "字".repeat(12_000) })).toBe("S2");
    for (let index = 0; index < 8; index++)
      materials.add({ path: "c", label: `长文 ${index}`, text: "字".repeat(9_000) });
    await materials.addImage(png(10, 10), "S1", "小图");
    await materials.addImage(new Uint8Array(9 * 1024 * 1024), "S1", "太大的图");
    const { evidence, images, warnings } = materials.done();
    expect(evidence[1].text).toHaveLength(10_000);
    // 7 万字的额度用完以后，后面的不再放
    expect(evidence.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(70_000);
    expect(warnings).toContain("材料已截取前 10000 字：很长的笔记");
    expect(warnings.some((warning) => warning.startsWith("材料过多，未纳入：长文"))).toBe(true);
    expect(images.map(({ id, sourceId, filename, width }) => ({ id, sourceId, filename, width }))).toEqual([
      { id: "I1", sourceId: "S1", filename: "I1.png", width: 10 },
    ]);
    expect(warnings).toContain("图片未纳入导出（数量或大小限制）：太大的图");
  });

  it("refuses to go on with nothing to write about", () => {
    expect(() => collectReportMaterials().done()).toThrow("researchReport.noMaterials");
  });

  it("reads the size of PNG and JPEG images from their headers", () => {
    expect(reportImageDimensions(png(640, 480))).toEqual({ width: 640, height: 480, extension: "png" });
    expect(reportImageDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("checking what the AI wrote", () => {
  const evidence = [
    { id: "S1", path: "a", label: "甲", text: "甲" },
    { id: "S2", path: "b", label: "乙", text: "乙" },
  ];
  const images = [{ id: "I1", sourceId: "S2" }];

  it("accepts a draft whose references all exist, and credits the source of every image used", () => {
    // 前后多说的两句、代码块的外壳都不碍事
    const parsed = parseReportDraft(
      "好的，下面是汇报：\n```json\n" + draft([{ sourceIds: ["S1", "S1"], imageIds: ["I1"] }]) + "\n```\n希望有帮助。",
      evidence,
      images,
    );
    expect(parsed.sections[0].sourceIds).toEqual(["S1", "S2"]);
    expect(parsed.sections[0].imageIds).toEqual(["I1"]);
  });

  it("rejects made-up references and replies that are not the agreed JSON", () => {
    expect(() => parseReportDraft(draft([{ sourceIds: ["S9"] }]), evidence, images)).toThrow(
      "researchReport.invalidReferences",
    );
    expect(() => parseReportDraft(draft([{ sourceIds: ["S1"], imageIds: ["I7"] }]), evidence, images)).toThrow(
      "researchReport.invalidReferences",
    );
    expect(() => parseReportDraft("好的，下面是报告：……", evidence, images)).toThrow("researchReport.invalidResponse");
    expect(() => parseReportDraft(draft([{ sourceIds: [] }]), evidence, images)).toThrow(
      "researchReport.invalidResponse",
    );
  });
});

describe("what the AI is told", () => {
  it("gives the numbered materials, the rules and what the user took out — without links or paths", async () => {
    const prompt = reportPrompt(await someMaterials(), { meta, skip: ["随手试的废卡", "  "] });
    expect(prompt).toContain("组会汇报");
    expect(prompt).toContain("2026-11-14 到 2026-11-21");
    expect(prompt).toContain('{"id":"S1","label":"这次想讲的","text":"这周主要试了 B 方法"}');
    expect(prompt).toContain('可用图片：[{"id":"I1","sourceId":"S2"}]');
    expect(prompt).toContain("不要写进汇报：随手试的废卡");
    expect(prompt).toContain("不能写成已经完成");
    expect(prompt).not.toContain("rwb://");
    expect(prompt).not.toContain("白板.prg#c1");
  });
});

describe("generating a report", () => {
  it("saves the draft, then writes the report, the slides, the pictures and the list of sources", async () => {
    const { io, written, text, files } = fakeIo([draft([{ sourceIds: ["S2"], imageIds: ["I1"] }])]);
    const stages: string[] = [];
    const result = await generateResearchReport(
      { ...request, onProgress: ({ stage }) => stages.push(stage) },
      await someMaterials(),
      io,
    );
    expect(stages).toEqual(["analyzing", "exporting"]);
    expect(result).toMatchObject({
      directory: folder,
      markdownPath: `${folder}/报告.md`,
      pptxPath: `${folder}/汇报.pptx`,
      warnings: [],
    });
    expect(written()).toEqual(
      [
        `.workbench/report-jobs/${result.jobId}/I1.png`,
        `.workbench/report-jobs/${result.jobId}/draft.json`,
        "汇报/2026-11-21 组会/报告.md",
        "汇报/2026-11-21 组会/来源.json",
        "汇报/2026-11-21 组会/汇报.pptx",
        "汇报/2026-11-21 组会/素材/I1.png",
      ].sort(),
    );
    const report = text(`${folder}/报告.md`);
    expect(report).toContain("![第 1 节](素材/I1.png)");
    expect(report).toContain("[S2 【进展】B 方法的结果](rwb://open?project=课题&path=白板.prg&target=c1)");
    expect(JSON.parse(text(`${folder}/来源.json`))).toMatchObject({
      title: "2026-11-21 组会",
      snapshot: "2026-11-21 1030",
      used: [{ id: "S2", path: "白板.prg#c1", label: "【进展】B 方法的结果" }],
      unused: [{ id: "S1", path: "节点：2026-11-21 组会", label: "这次想讲的" }],
    });
    expect(files.get(`${folder}/汇报.pptx`)!.slice(0, 2)).toEqual(new Uint8Array([80, 75]));
  });

  it("puts a second report for the same node next to the first one instead of overwriting it", async () => {
    const { io, written } = fakeIo([draft([{ sourceIds: ["S1"] }]), draft([{ sourceIds: ["S2"], imageIds: ["I1"] }])]);
    await generateResearchReport(request, await someMaterials(), io);
    const again = await generateResearchReport(request, await someMaterials(), io);
    expect(again.markdownPath).toBe(`${folder}/报告-2.md`);
    expect(again.pptxPath).toBe(`${folder}/汇报-2.pptx`);
    expect(written().filter((path) => path.startsWith("汇报/"))).toEqual(
      [
        "汇报/2026-11-21 组会/报告.md",
        "汇报/2026-11-21 组会/报告-2.md",
        "汇报/2026-11-21 组会/来源.json",
        "汇报/2026-11-21 组会/来源-2.json",
        "汇报/2026-11-21 组会/汇报.pptx",
        "汇报/2026-11-21 组会/汇报-2.pptx",
        "汇报/2026-11-21 组会/素材/I1.png",
        "汇报/2026-11-21 组会/素材-2/I1.png",
      ].sort(),
    );
  });

  it("asks once more when the first reply fails the check, and gives up after the second", async () => {
    const retried = fakeIo([draft([{ sourceIds: ["S9"] }]), draft([{ sourceIds: ["S1"] }])]);
    await generateResearchReport(request, await someMaterials(), retried.io);
    expect(retried.prompts).toHaveLength(2);
    expect(retried.prompts[1]).toContain("上次输出未通过 JSON 或引用校验");

    const stubborn = fakeIo(["不是 JSON", draft([{ sourceIds: ["S9"] }])]);
    await expect(generateResearchReport(request, await someMaterials(), stubborn.io)).rejects.toThrow(
      "researchReport.invalidReferences",
    );
    expect(stubborn.written()).toEqual([]);
  });

  it("keeps the draft when exporting fails, so it can be exported again without calling the AI", async () => {
    let diskFull = true;
    const { io, prompts, written } = fakeIo(
      [draft([{ sourceIds: ["S2"], imageIds: ["I1"] }])],
      (path) => diskFull && path.endsWith(".pptx"),
    );
    const failed = await generateResearchReport(request, await someMaterials(), io).catch((error: unknown) => error);
    expect(failed).toMatchObject({ message: "researchReport.exportFailed" });
    const { jobId } = failed as { jobId: string };
    expect(written()).toContain(`.workbench/report-jobs/${jobId}/draft.json`);

    diskFull = false;
    const result = await retryResearchReportExport(root, jobId, undefined, io);
    // 上一次写到一半的那一套文件名已经占用了，这次用下一个序号
    expect(result.markdownPath).toBe(`${folder}/报告-2.md`);
    expect(written()).toContain("汇报/2026-11-21 组会/汇报-2.pptx");
    expect(prompts).toHaveLength(1);

    await expect(retryResearchReportExport(root, "../../别处", undefined, io)).rejects.toThrow(
      "researchReport.invalidDraft",
    );
    await expect(
      retryResearchReportExport(root, "00000000-0000-4000-8000-000000000000", undefined, io),
    ).rejects.toThrow("researchReport.invalidDraft");
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { io, prompts } = fakeIo([draft([{ sourceIds: ["S1"] }])]);
    await expect(
      generateResearchReport({ ...request, signal: controller.signal }, await someMaterials(), io),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(prompts).toEqual([]);
  });

  it("names the folder after the node, without characters a file name cannot have", () => {
    expect(reportFolderName("2026-11-21 组会")).toBe("2026-11-21 组会");
    expect(reportFolderName('2026/11/21: "组会"? ')).toBe("2026-11-21- -组会--");
    expect(reportFolderName(" .. ")).toBe("汇报");
  });
});
