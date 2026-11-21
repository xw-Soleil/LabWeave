import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { createReportMarkdown, createReportPptx, wrapReportText, type ReportDocument } from "./ResearchReportExport";

const document: ReportDocument = {
  meta: {
    title: "2026-11-21 组会",
    type: "组会",
    project: "课题: A/B",
    since: "2026-11-14T10:00:00+08:00",
    until: "2026-11-21T10:30:00+08:00",
    snapshot: "2026-11-21 1030",
  },
  draft: {
    title: "这周的进展",
    summary: "试了 B 方法，边界条件有问题。",
    sections: [
      {
        heading: "做了什么",
        paragraphs: ["跑通了 B 方法。", "读了一篇论文。"],
        sourceIds: ["S2", "S3"],
        imageIds: ["I1"],
      },
      { heading: "下一步", paragraphs: ["换损失函数。"], sourceIds: ["S1"], imageIds: [] },
    ],
  },
  evidence: [
    { id: "S1", path: "节点：2026-11-21 组会", label: "这次想讲的", text: "下周换损失函数" },
    {
      id: "S2",
      path: "白板.prg#c1",
      label: "【进展】B 方法的结果 [第一版]",
      text: "跑通了",
      link: "rwb://open?project=课题&path=白板.prg&target=c1",
    },
    { id: "S3", path: "笔记/想法.md", label: "想法.md", text: "论文说……", link: "../../笔记/想法.md" },
    { id: "S4", path: "白板.prg#c9", label: "没用上的卡片", text: "……", link: "rwb://open?path=x" },
  ],
  images: [{ id: "I1", filename: "I1.png", bytes: new Uint8Array([1, 2, 3]), width: 800, height: 600, sourceId: "S2" }],
  warnings: ["论文的批注比较多，只放了前 40 条：main.pdf"],
};

describe("the report as Markdown", () => {
  const report = createReportMarkdown(document, "素材-2");

  it("opens with properties that say which node this is", () => {
    expect(report.split("\n").slice(0, 7)).toEqual([
      "---",
      "类型: 组会",
      "日期: 2026-11-21",
      "范围: 2026-11-14 ~ 2026-11-21",
      '项目: ["课题: A/B"]',
      "快照: 2026-11-21 1030",
      "---",
    ]);
    const first = createReportMarkdown({ ...document, meta: { ...document.meta, since: undefined } });
    expect(first).toContain("范围: 到 2026-11-21");
  });

  it("follows every section with sources you can click back to", () => {
    expect(report).toContain(
      "出处：[S2 【进展】B 方法的结果 \\[第一版\\]](rwb://open?project=课题&path=白板.prg&target=c1) · [S3 想法.md](../../笔记/想法.md)",
    );
    // 没有地方可回的（用户敲的原话）只写名字
    expect(report).toContain("出处：S1 这次想讲的\n");
    expect(report).toContain("![做了什么](素材-2/I1.png)");
  });

  it("lists only the materials that were used, then what the reader should double-check", () => {
    const tail = report.slice(report.indexOf("## 材料来源"));
    expect(tail).toContain("- S1 这次想讲的");
    expect(tail).toContain("- [S3 想法.md](../../笔记/想法.md)");
    expect(tail).not.toContain("没用上的卡片");
    expect(tail).toContain("## 材料范围与待核对项\n\n- 论文的批注比较多，只放了前 40 条：main.pdf");
  });
});

describe("the report as slides", () => {
  it("builds a .pptx that unzips, with one slide per page of text and one per picture", async () => {
    const reader = new ZipReader(new Uint8ArrayReader(await createReportPptx(document)));
    const entries = await reader.getEntries();
    const names = entries.map((entry) => entry.filename);
    // 封面、两节、一张图、材料来源、待核对项
    expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(6);
    expect(names).toContain("ppt/media/I1.png");
    expect(names).toContain("[Content_Types].xml");
    const slide = async (index: number) => {
      const entry = entries.find((candidate) => candidate.filename === `ppt/slides/slide${index}.xml`)!;
      if (entry.directory) throw new Error("不该是文件夹");
      return entry.getData(new TextWriter());
    };
    expect(await slide(1)).toContain("2026-11-21 组会 · 课题: A/B · 2026-11-14 ~ 2026-11-21");
    expect(await slide(2)).toContain("[S2] 【进展】B 方法的结果 [第一版]；[S3] 想法.md");
    expect(await slide(5)).toContain("节点快照 2026-11-21 1030");
    await reader.close();
  });

  it("wraps Chinese at full width so long paragraphs turn into more lines, not smaller type", () => {
    expect(wrapReportText("字".repeat(80))).toHaveLength(3);
    expect(wrapReportText("a".repeat(60))).toHaveLength(1);
    expect(wrapReportText("第一段\n第二段")).toEqual(["第一段", "第二段"]);
  });
});
