// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
import { parseOutline } from "./NoteHeadings";

describe("note outline", () => {
  it("lists top-level headings with their source line, skipping properties, code and callouts", () => {
    const note = [
      "---",
      "title: x",
      "# not a heading",
      "---",
      "# 研究笔记",
      "",
      "> [!note] 提示",
      "> ## 提示框里的标题",
      "",
      "```python",
      "# 注释",
      "```",
      "## 1.1 **先补基础**：[[DDPM|扩散]] 和 `代码` ##",
      "",
      "Setext",
      "------",
    ].join("\n");
    expect(parseOutline(note)).toEqual([
      { level: 1, text: "研究笔记", line: 4 },
      { level: 2, text: "1.1 先补基础：扩散 和 代码", line: 12 },
      { level: 2, text: "Setext", line: 14 },
    ]);
  });
});
