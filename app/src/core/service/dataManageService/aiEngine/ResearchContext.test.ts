import type { ResearchFileEntry } from "@/core/research/ResearchFolder";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "",
  files: [] as ResearchFileEntry[],
  listError: null as Error | null,
  buildAiSidecar: vi.fn(),
}));

vi.mock("@/core/research/ResearchFolder", () => ({
  ResearchFolder: {
    getRoot: () => mocks.root,
    listFiles: async () => {
      if (mocks.listError) throw mocks.listError;
      return mocks.files;
    },
  },
}));
vi.mock("@/core/research/AiSidecarBuilder", () => ({ buildAiSidecar: mocks.buildAiSidecar }));
vi.mock("@graphif/serializer", () => ({ serialize: (value: unknown) => value }));

import {
  buildResearchContext,
  capWorkspaceDump,
  composeResearchContext,
  DEFAULT_RESEARCH_CONTEXT_CHARS,
  estimateResearchContextTokens,
  formatResearchFiles,
  getResearchContextCharBudget,
  truncateToBudget,
} from "./ResearchContext";

function entry(relPath: string, kind: ResearchFileEntry["kind"] = "pdf"): ResearchFileEntry {
  return { absPath: `/root/${relPath}`, relPath, name: relPath.split("/").pop()!, kind };
}

describe("research context budget", () => {
  it("defaults to 60k characters when the context window is unknown", () => {
    expect(getResearchContextCharBudget(undefined)).toBe(DEFAULT_RESEARCH_CONTEXT_CHARS);
    expect(getResearchContextCharBudget(0)).toBe(DEFAULT_RESEARCH_CONTEXT_CHARS);
  });

  it("uses a quarter of the window at one character per token, capped above but not floored", () => {
    expect(getResearchContextCharBudget(200_000)).toBe(50_000);
    expect(getResearchContextCharBudget(8_192)).toBe(2_048);
    expect(getResearchContextCharBudget(4_000)).toBe(1_000);
    expect(getResearchContextCharBudget(10_000_000)).toBe(400_000);
  });

  it("estimates CJK at about one token per character and ASCII at about three characters per token", () => {
    expect(estimateResearchContextTokens("研究".repeat(500))).toBe(1_000);
    expect(estimateResearchContextTokens("a".repeat(900))).toBe(300);
  });
});

describe("truncateToBudget", () => {
  it("keeps short text unchanged", () => {
    expect(truncateToBudget("abc", 3)).toBe("abc");
  });

  it("cuts long text and says how much was left out", () => {
    const result = truncateToBudget("a".repeat(100), 10);
    expect(result.startsWith("a".repeat(10))).toBe(true);
    expect(result).toContain("90");
    expect(result.slice(0, 11)).not.toBe("a".repeat(11));
  });
});

describe("composeResearchContext", () => {
  it("wraps the board and the file list in their own tags", () => {
    const context = composeResearchContext({ whiteboardMarkdown: "# Board", filesText: "- a.pdf (pdf)", budget: 1000 });
    expect(context).toBe("<whiteboard>\n# Board\n</whiteboard>\n\n<research-files>\n- a.pdf (pdf)\n</research-files>");
  });

  it("gives the board most of the budget when both parts are large", () => {
    const context = composeResearchContext({
      whiteboardMarkdown: "w".repeat(10_000),
      filesText: "f".repeat(10_000),
      budget: 1000,
    });
    const whiteboard = context.match(/<whiteboard>\n(w*)/)![1];
    const files = context.match(/<research-files>\n(f*)/)![1];
    expect(whiteboard.length).toBeGreaterThan(files.length);
    expect(whiteboard.length + files.length).toBeLessThanOrEqual(1000);
  });

  it("hands the unused file budget to the board", () => {
    const context = composeResearchContext({ whiteboardMarkdown: "w".repeat(10_000), filesText: "", budget: 1000 });
    expect(context.match(/<whiteboard>\n(w*)/)![1].length).toBe(1000);
  });
});

describe("formatResearchFiles", () => {
  it("lists relative paths with their kind and caps the list", () => {
    const text = formatResearchFiles(
      [entry("papers/a.pdf"), entry("figs/b.png", "image"), entry("c.md", "markdown")],
      2,
    );
    expect(text).toBe("- papers/a.pdf (pdf)\n- figs/b.png (image)\n…（还有 1 个文件没有列出）");
  });
});

describe("capWorkspaceDump", () => {
  function sidecar(cardCount: number, textLength: number) {
    return {
      schema: "x",
      workspace: { file: "a.prg", id: "w", savedAt: "", prgVersion: "2" },
      cards: Array.from({ length: cardCount }, (_, index) => ({
        id: `c${index}`,
        type: "FileCardNode",
        title: `card ${index}`,
        text: "字".repeat(textLength),
        notes: "",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        color: null,
      })),
      sections: [],
      edges: [{ id: "e", type: "LineEdge", from: "c0", to: "c1", label: "" }],
      hyperedges: [],
      tags: [],
    } as never;
  }

  it("returns small dumps unchanged", () => {
    const input = sidecar(2, 10);
    expect(capWorkspaceDump(input)).toEqual(input);
  });

  it("clips card text and caps the total size with a truncation notice", () => {
    const result = capWorkspaceDump(sidecar(200, 4000), 20_000) as Record<string, any>;
    expect(JSON.stringify(result).length).toBeLessThan(21_000);
    expect(result.truncated).toBe(true);
    expect(result.cards[0].text.length).toBe(501);
    expect(result.omittedCards).toBeGreaterThan(0);
    expect(result.cards.length + result.omittedCards).toBe(200);
    expect(result.truncatedNote).toContain("没有列出");
  });
});

describe("buildResearchContext", () => {
  beforeEach(() => {
    mocks.root = "";
    mocks.files = [];
    mocks.listError = null;
    mocks.buildAiSidecar.mockReset();
    mocks.buildAiSidecar.mockReturnValue({ json: {}, markdown: "# 工作区\n- 卡片 A" });
  });

  const project = {
    stage: [{ uuid: "1" }],
    tags: ["1"],
    metadata: { version: "2.0.0" },
    uri: { scheme: "file", path: "/root/综述.prg" },
  };

  it("reads the live stage and skips the folder listing when no research folder is set", async () => {
    const context = await buildResearchContext(project as never);

    expect(mocks.buildAiSidecar).toHaveBeenCalledWith({
      serializedStage: project.stage,
      tags: project.tags,
      metadata: project.metadata,
      workspaceFile: "综述.prg",
    });
    expect(context).toContain("- 卡片 A");
    expect(context).toContain("<research-files>\n（");
  });

  it("includes the research folder files when a folder is set", async () => {
    mocks.root = "/root";
    mocks.files = [entry("papers/a.pdf")];

    const context = await buildResearchContext(project as never, 100_000);

    expect(context).toContain("- papers/a.pdf (pdf)");
  });

  it("keeps the board context and adds a short note when the research folder cannot be read", async () => {
    mocks.root = "/Volumes/外接盘/研究";
    mocks.listError = new Error("无法打开研究文件夹");

    const context = await buildResearchContext(project as never);

    expect(context).toContain("- 卡片 A");
    expect(context).toContain("研究文件夹现在读不了");
    expect(context).toContain("无法打开研究文件夹");
    mocks.listError = null;
  });
});
