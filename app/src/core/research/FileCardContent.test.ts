import { describe, expect, it } from "vitest";
import {
  extractFileCardContent,
  extractMarkdownContent,
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
    await expect(extractFileCardContent("markdown", bytes, "a.md", 3)).resolves.toEqual({
      title: "标题",
      excerpt: "# 标题\n正文",
      pageCount: 0,
      thumbnail: null,
      problem: "",
    });
  });
});
