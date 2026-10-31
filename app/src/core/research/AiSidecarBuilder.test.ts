import { describe, expect, it } from "vitest";
import { buildAiSidecar, plateToPlainText, RESEARCH_SIDECAR_SCHEMA } from "./AiSidecarBuilder";

const vector = (x: number, y: number) => ({ _: "Vector", x, y });
const box = (x: number, y: number, w: number, h: number) => ({
  _: "CollisionBox",
  shapes: [{ _: "Rectangle", location: vector(x, y), size: vector(w, h) }],
});
const color = (r: number, g: number, b: number, a: number) => ({ _: "Color", r, g, b, a });
const transparent = color(0, 0, 0, 0);

/**
 * 手写的 serialize(project.stage) 结果：
 * Section 在顶层第 0 格，它的子节点第一次出现在 children 里，所以顶层第 1 格是 {$:"/0/children/0"}；
 * 连线的两端也是回指。
 */
function makeFixture(): unknown[] {
  return [
    {
      _: "Section",
      uuid: "section-1",
      _collisionBoxNormal: box(0, 0, 600, 400),
      color: transparent,
      text: "研究方法",
      children: [
        {
          _: "TextNode",
          uuid: "text-1",
          text: "用注意力替代循环",
          collisionBox: box(20, 40, 200, 60),
          color: color(255, 0, 0, 1),
          details: [
            { type: "p", children: [{ text: "第一段 " }, { text: "加粗", bold: true }] },
            {
              type: "ul",
              children: [
                { type: "li", children: [{ type: "lic", children: [{ text: "要点一" }] }] },
                {
                  type: "li",
                  children: [
                    {
                      type: "lic",
                      children: [
                        { text: "见 " },
                        { type: "a", url: "https://example.com", children: [{ text: "链接" }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      details: [],
      isCollapsed: false,
    },
    { $: "/0/children/0" },
    {
      _: "FileCardNode",
      uuid: "file-1",
      title: "Attention Is All You Need",
      sourcePath: "papers/attention.pdf",
      fileKind: "pdf",
      attachmentId: "attachment-thumbnail-1",
      excerpt: "The dominant sequence transduction models are based on complex recurrent networks.",
      pageCount: 15,
      color: transparent,
      collisionBox: box(700, 40, 260, 180),
      details: [{ type: "p", children: [{ text: "重点看第 3 节" }] }],
    },
    {
      _: "FileCardNode",
      uuid: "file-2",
      title: "",
      sourcePath: "/Users/me/research/notes/读书笔记.md",
      fileKind: "markdown",
      attachmentId: "",
      excerpt: "",
      pageCount: 0,
      color: color(0, 128, 255, 0.5),
      collisionBox: box(700, 300, 260, 180),
      details: [],
    },
    {
      _: "FileCardNode",
      uuid: "file-3",
      title: "外部论文",
      sourcePath: "C:\\Users\\me\\Downloads\\secret\\other.pdf",
      fileKind: "pdf",
      attachmentId: "",
      excerpt: "",
      pageCount: 3,
      color: transparent,
      collisionBox: box(1000, 300, 260, 180),
      details: [],
    },
    {
      _: "LineEdge",
      uuid: "edge-1",
      text: "支持",
      color: transparent,
      lineType: "solid",
      arrowType: "default",
      associationList: [{ $: "/0/children/0" }, { $: "/2" }],
      targetRectangleRate: vector(0.5, 0.5),
      sourceRectangleRate: vector(0.5, 0.5),
    },
    {
      _: "MultiTargetUndirectedEdge",
      uuid: "hyper-1",
      text: "同一批实验",
      associationList: [{ $: "/2" }, { $: "/3" }, { $: "/4" }],
    },
    {
      _: "UrlNode",
      uuid: "url-1",
      title: "arXiv 页面",
      url: "https://arxiv.org/abs/1706.03762",
      color: transparent,
      collisionBox: box(-300, 0, 200, 80),
      details: [],
    },
    {
      _: "ImageNode",
      uuid: "image-1",
      attachmentId: "attachment-image-1",
      scale: 1,
      collisionBox: box(-300, 200, 100, 100),
      details: [{ type: "p", children: [{ text: "图 1：模型结构" }] }],
    },
    { _: "PenStroke", uuid: "pen-1", segments: [], color: transparent },
  ];
}

describe("plateToPlainText", () => {
  it("joins blocks with newlines and inline leaves without separators", () => {
    expect(
      plateToPlainText([
        { type: "h1", children: [{ text: "标题" }] },
        { type: "p", children: [{ text: "a" }, { text: "b", italic: true }] },
      ]),
    ).toBe("标题\nab");
  });

  it("accepts empty and legacy values", () => {
    expect(plateToPlainText([])).toBe("");
    expect(plateToPlainText(undefined)).toBe("");
    expect(plateToPlainText("  旧格式  ")).toBe("旧格式");
  });
});

describe("buildAiSidecar", () => {
  const build = () =>
    buildAiSidecar({
      serializedStage: makeFixture(),
      tags: ["file-1", "missing"],
      metadata: { version: "2.7.0", workbench: { id: "workspace-1" } },
      workspaceFile: "/Users/me/research/Transformer 综述.prg",
      readme: "注意力机制为什么有效？",
      savedAt: "2026-11-01T00:00:00.000Z",
    });

  it("fills the workspace header from metadata", () => {
    expect(build().json.schema).toBe(RESEARCH_SIDECAR_SCHEMA);
    expect(build().json.workspace).toEqual({
      file: "Transformer 综述.prg",
      id: "workspace-1",
      savedAt: "2026-11-01T00:00:00.000Z",
      prgVersion: "2.7.0",
    });
  });

  it("resolves a section child that the top level only references", () => {
    const { json } = build();
    const textCards = json.cards.filter((card) => card.id === "text-1");
    expect(textCards).toHaveLength(1);
    expect(textCards[0]).toEqual({
      id: "text-1",
      type: "TextNode",
      title: "用注意力替代循环",
      text: "用注意力替代循环",
      notes: "第一段 加粗\n要点一\n见 链接",
      rect: { x: 20, y: 40, w: 200, h: 60 },
      sectionId: "section-1",
      color: "#ff0000",
    });
    expect(json.sections).toEqual([
      {
        id: "section-1",
        title: "研究方法",
        children: ["text-1"],
        notes: "",
        rect: { x: 0, y: 0, w: 600, h: 400 },
        color: null,
      },
    ]);
  });

  it("resolves edge endpoints given as references", () => {
    const { json } = build();
    expect(json.edges).toEqual([
      {
        id: "edge-1",
        type: "LineEdge",
        from: "text-1",
        to: "file-1",
        label: "支持",
        lineType: "solid",
        arrowType: "default",
      },
    ]);
    expect(json.hyperedges).toEqual([{ id: "hyper-1", members: ["file-1", "file-2", "file-3"], label: "同一批实验" }]);
  });

  it("describes file cards with relative paths and without attachments", () => {
    const { json } = build();
    const fileCard = json.cards.find((card) => card.id === "file-1");
    expect(fileCard).toMatchObject({
      type: "FileCardNode",
      title: "Attention Is All You Need",
      text: "The dominant sequence transduction models are based on complex recurrent networks.",
      notes: "重点看第 3 节",
      file: { path: "papers/attention.pdf", kind: "pdf", pages: 15 },
      color: null,
    });
    expect(json.cards.find((card) => card.id === "file-2")).toMatchObject({
      title: "读书笔记.md",
      file: { path: "notes/读书笔记.md", kind: "markdown", pages: 0 },
      color: "#0080ff80",
    });
    expect(json.cards.find((card) => card.id === "file-3")?.file?.path).toBe("other.pdf");

    const serialized = JSON.stringify(build());
    expect(serialized).not.toContain("/Users/me");
    expect(serialized).not.toContain("Downloads");
    expect(serialized).not.toContain("attachment-");
  });

  it("keeps url, image caption and tags, and skips pen strokes", () => {
    const { json } = build();
    expect(json.cards.find((card) => card.id === "url-1")).toMatchObject({
      title: "arXiv 页面",
      url: "https://arxiv.org/abs/1706.03762",
    });
    expect(json.cards.find((card) => card.id === "image-1")).toMatchObject({
      type: "ImageNode",
      title: "",
      notes: "图 1：模型结构",
    });
    expect(json.cards.some((card) => card.id === "pen-1")).toBe(false);
    expect(json.tags).toEqual([{ id: "file-1", title: "Attention Is All You Need" }]);
  });

  it("writes a markdown outline by section with an edge list", () => {
    const { markdown } = build();
    expect(markdown.startsWith("# Transformer 综述\n\n## 研究问题\n\n注意力机制为什么有效？\n")).toBe(true);
    expect(markdown).toContain("## 研究方法\n\n- [文本] 用注意力替代循环 — 备注：第一段 加粗 要点一 见 链接\n");
    expect(markdown).toContain(
      "- [PDF] Attention Is All You Need — papers/attention.pdf，15 页；摘要：The dominant sequence transduction models are based on complex recurrent networks.；备注：重点看第 3 节",
    );
    expect(markdown).toContain("## 未分组");
    expect(markdown).toContain("- [图片] （无标题） — 备注：图 1：模型结构");
    expect(markdown).toContain("## 连线\n\n- 用注意力替代循环 —支持→ Attention Is All You Need\n");
    expect(markdown).toContain("- 同一批实验：Attention Is All You Need、读书笔记.md、外部论文");
    expect(markdown).not.toContain("/Users/me");
  });

  it("walks up with ../ to files elsewhere in the research folder, but never outside it", () => {
    const fileCard = (uuid: string, sourcePath: string) => ({
      _: "FileCardNode",
      uuid,
      title: uuid,
      sourcePath,
      fileKind: "pdf",
      attachmentId: "",
      excerpt: "",
      pageCount: 0,
      collisionBox: box(0, 0, 10, 10),
      details: [],
    });
    const { json } = buildAiSidecar({
      serializedStage: [
        fileCard("sibling", "/Users/me/Research/papers/a.pdf"),
        fileCard("inside", "/users/me/research/workspaces/notes/b.pdf"),
        fileCard("outside", "/Users/me/Desktop/c.pdf"),
        fileCard("relative", "../papers/d.pdf"),
      ],
      workspaceFile: "/Users/me/Research/workspaces/综述.prg",
      researchRoot: "/Users/me/Research/",
    });
    expect(json.cards.map((card) => card.file?.path)).toEqual([
      "../papers/a.pdf",
      "notes/b.pdf",
      "c.pdf",
      "../papers/d.pdf",
    ]);
  });

  it("does not modify the serialized stage it reads", () => {
    const fixture = makeFixture();
    const before = JSON.stringify(fixture);
    buildAiSidecar({ serializedStage: fixture, workspaceFile: "a.prg" });
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it("handles an empty board and old files without workbench metadata", () => {
    const { json, markdown } = buildAiSidecar({
      serializedStage: [],
      metadata: { version: "2.0.0" },
      workspaceFile: "空白.prg",
      savedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(json.workspace.id).toBe("");
    expect(json.cards).toEqual([]);
    expect(markdown).toBe("# 空白\n");
  });
});
