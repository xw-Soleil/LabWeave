import { describe, expect, it } from "vitest";
import {
  extractFileCardContent,
  extractMarkdownContent,
  joinPdfLines,
  MAX_EXCERPT_LENGTH,
  normalizeExcerpt,
  pickPdfTitle,
} from "./FileCardContent";

const BOM = String.fromCodePoint(0xfeff);
const FULL_WIDTH_SPACE = String.fromCodePoint(0x3000);

describe("extractMarkdownContent", () => {
  it("uses the first level-one heading as the title", () => {
    const { title, excerpt } = extractMarkdownContent("前言\n\n## 小节\n\n# 实验记录 #\n\n正文", "notes.md");
    expect(title).toBe("实验记录");
    expect(excerpt).toBe("前言\n\n## 小节\n\n# 实验记录 #\n\n正文");
  });

  it("falls back to the file name without extension", () => {
    expect(extractMarkdownContent("## 只有二级标题\n内容", "读书笔记.v2.md").title).toBe("读书笔记.v2");
    expect(extractMarkdownContent("#没有空格不算标题", "a.markdown").title).toBe("a");
  });

  it("skips YAML front matter and a byte order mark", () => {
    const { title, excerpt } = extractMarkdownContent(
      `${BOM}---\ntitle: 不用这个\ntags: [a]\n---\n# 真正的标题\n第一段`,
      "x.md",
    );
    expect(title).toBe("真正的标题");
    expect(excerpt).toBe("# 真正的标题\n第一段");
  });

  it("normalizes whitespace and limits the excerpt length", () => {
    const { excerpt } = extractMarkdownContent(
      `# T\r\n\r\n\r\n\r\na  \t b${FULL_WIDTH_SPACE} c\n${"字".repeat(5000)}`,
      "t.md",
    );
    expect(excerpt.startsWith("# T\n\na b c\n")).toBe(true);
    expect(excerpt).toHaveLength(MAX_EXCERPT_LENGTH);
  });
});

describe("normalizeExcerpt", () => {
  it("keeps paragraph breaks but trims spaces around line breaks", () => {
    expect(normalizeExcerpt("  第一行  \n   第二行\n\n\n\n第三段  ")).toBe("第一行\n第二行\n\n第三段");
  });
});

describe("joinPdfLines", () => {
  it("joins the lines of a passage into one paragraph", () => {
    expect(
      joinPdfLines(
        "Solving ill-posed inverse heat conduction:\r\nReconstruction of blast furnace \n inner wall temperature fields",
      ),
    ).toBe("Solving ill-posed inverse heat conduction: Reconstruction of blast furnace inner wall temperature fields");
  });
  it("keeps a hyphen at a line end and joins straight on, since it may belong to the word", () => {
    expect(joinPdfLines("using a physics-\ninformed diffusion model")).toBe("using a physics-informed diffusion model");
    // 行尾的减号后面不是小写字母（公式、列表），当普通换行
    expect(joinPdfLines("x -\nY")).toBe("x - Y");
    // 软连字符是排版自己标的拆词处，接回一个词
    expect(joinPdfLines(`recon${String.fromCodePoint(0xad)}\nstruction`)).toBe("reconstruction");
  });
  it("adds no space between two lines of Chinese, but does between Chinese and Latin text", () => {
    expect(joinPdfLines("高炉内壁温度场的重\n建是一个不适定问题，\n本文提出")).toBe(
      "高炉内壁温度场的重建是一个不适定问题，本文提出",
    );
    expect(joinPdfLines("我们使用\nPINN 方法")).toBe("我们使用 PINN 方法");
  });
});

describe("pickPdfTitle", () => {
  it("prefers a meaningful metadata title", () => {
    expect(pickPdfTitle("  Attention Is All\nYou Need ", "1706.03762.pdf")).toBe("Attention Is All You Need");
  });

  it("falls back to the file name for empty or tool-generated titles", () => {
    expect(pickPdfTitle(undefined, "paper.pdf")).toBe("paper");
    expect(pickPdfTitle("", "paper.pdf")).toBe("paper");
    expect(pickPdfTitle("Microsoft Word - draft.docx", "paper.pdf")).toBe("paper");
    expect(pickPdfTitle("main.tex", "paper.pdf")).toBe("paper");
    expect(pickPdfTitle("untitled", "paper.pdf")).toBe("paper");
  });
});

describe("extractFileCardContent", () => {
  it("reads markdown without a thumbnail or page count", async () => {
    const bytes = new TextEncoder().encode("# 标题\n正文") as Uint8Array<ArrayBuffer>;
    await expect(extractFileCardContent("markdown", bytes, "a.md")).resolves.toEqual({
      title: "标题",
      excerpt: "# 标题\n正文",
      pageCount: 0,
      thumbnail: null,
      problem: "",
    });
  });
});
