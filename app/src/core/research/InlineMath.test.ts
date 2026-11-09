import { describe, expect, it } from "vitest";
import { extractLatexSource } from "@/utils/latex";
import { hasInlineMath, splitInlineMath } from "./InlineMath";

describe("splitInlineMath", () => {
  it.each([
    "",
    "plain 中文",
    "$5 和 $10",
    "$5.00 and $10.00",
    String.raw`价格 \$5 和 \$10`,
    String.raw`\$x\$`,
    "$unclosed",
    "unopened$",
    "$$",
    "$$$$",
    "$ $",
    "$$ \n $$",
    String.raw`\(\)`,
    String.raw`\[ \]`,
    "$ x$",
    "$x $",
    "$x$2",
    "$\tx$",
    "$x\n$",
    String.raw`\\(x\\)`,
  ])("leaves literal text intact: %s", (text) => {
    expect(splitInlineMath(text)).toEqual(text ? [{ type: "text", text }] : []);
    expect(hasInlineMath(text)).toBe(false);
  });

  it("recognizes all delimiters, giving double dollars priority", () => {
    expect(splitInlineMath(String.raw`能量 $E=mc^2$ and $$x+y$$，\(a_b\) 与 \[\frac{1}{2}\]。`)).toEqual([
      { type: "text", text: "能量 " },
      { type: "inline", source: "E=mc^2", raw: "$E=mc^2$" },
      { type: "text", text: " and " },
      { type: "display", source: "x+y", raw: "$$x+y$$" },
      { type: "text", text: "，" },
      { type: "inline", source: "a_b", raw: String.raw`\(a_b\)` },
      { type: "text", text: " 与 " },
      { type: "display", source: String.raw`\frac{1}{2}`, raw: String.raw`\[\frac{1}{2}\]` },
      { type: "text", text: "。" },
    ]);
  });

  it("does not let unmatched prices consume a later formula", () => {
    expect(splitInlineMath("$5 和 $10，公式 $x$ 后面")).toEqual([
      { type: "text", text: "$5 和 $10，公式 " },
      { type: "inline", source: "x", raw: "$x$" },
      { type: "text", text: " 后面" },
    ]);
    expect(splitInlineMath("$a $$b$$ c$")).toEqual([
      { type: "text", text: "$a " },
      { type: "display", source: "b", raw: "$$b$$" },
      { type: "text", text: " c$" },
    ]);
  });

  it("counts escaping backslashes and permits escaped dollars inside formulas", () => {
    expect(splitInlineMath(String.raw`\\$x$ 和 $\$5$`)).toEqual([
      { type: "text", text: String.raw`\\` },
      { type: "inline", source: "x", raw: "$x$" },
      { type: "text", text: " 和 " },
      { type: "inline", source: String.raw`\$5`, raw: String.raw`$\$5$` },
    ]);
  });

  it("preserves whitespace and newlines inside display source", () => {
    expect(splitInlineMath("前$$\n x+y \n$$后")[1]).toEqual({
      type: "display",
      source: "\n x+y \n",
      raw: "$$\n x+y \n$$",
    });
  });

  it("handles adjacent inline formulas and inline/display formulas without inserted spaces", () => {
    expect(splitInlineMath("$a$$b$")).toEqual([
      { type: "inline", source: "a", raw: "$a$" },
      { type: "inline", source: "b", raw: "$b$" },
    ]);
    expect(splitInlineMath("$a$$$b$$")).toEqual([
      { type: "inline", source: "a", raw: "$a$" },
      { type: "display", source: "b", raw: "$$b$$" },
    ]);
  });

  it("recognizes whole-card delimiters also used by the edit preview", () => {
    for (const text of ["$x$", "$$x$$", String.raw`\(x\)`, String.raw`\[x\]`]) {
      expect(hasInlineMath(text)).toBe(true);
      expect(extractLatexSource(text)).toBe("x");
    }
    expect(hasInlineMath("说明 $x$")).toBe(true);
    expect(extractLatexSource("说明 $x$")).toBeNull();
    const environment = String.raw`\begin{equation}x\end{equation}`;
    expect(extractLatexSource(environment)).toBe(environment);
    expect(hasInlineMath(environment)).toBe(false);
  });
});
