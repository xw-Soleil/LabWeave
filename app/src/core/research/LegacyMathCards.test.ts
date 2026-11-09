import { describe, expect, it } from "vitest";
import { splitInlineMath } from "./InlineMath";
import { legacyMathText, migrateLegacyMathCards } from "./LegacyMathCards";

describe("legacy formula cards", () => {
  it.each([String.raw`\TeX`, String.raw`\frac{a}{b}`, " x\n+y ", String.raw`\$x`, String.raw`x\\`])(
    "wraps %s without trimming or changing its source",
    (source) => {
      const text = legacyMathText(source);
      expect(text).toBe(`$$${source}$$`);
      expect(splitInlineMath(text)).toEqual([{ type: "display", raw: text, source }]);
    },
  );

  it.each(["a$$b", "$$x$$", "x$", String.raw`\text{$$}`])("uses brackets when dollars split %s", (source) => {
    const text = legacyMathText(source);
    expect(text).toBe(`\\[${source}\\]`);
    expect(splitInlineMath(text)).toEqual([{ type: "display", raw: text, source }]);
  });

  it.each(["", " \n ", "x\\", String.raw`a$$b\]c`])("keeps unwrappable source verbatim: %s", (source) => {
    expect(legacyMathText(source)).toBe(source);
    expect(splitInlineMath(legacyMathText(source)).every((part) => part.type === "text")).toBe(true);
  });

  it("migrates nested objects in place without changing paths, metadata or transparent colors", () => {
    const node = { _: "LatexNode", uuid: "math", latexSource: "x", details: [{ text: "note" }], color: { a: 0 } };
    const stage = [
      { _: "Section", children: [node] },
      { _: "LineEdge", associationList: [{ $: "/0/children/0" }] },
    ];
    const before = structuredClone(node);
    expect(migrateLegacyMathCards(stage)).toBe(stage);
    expect(stage[0].children![0]).toBe(node);
    expect(node).toMatchObject({
      _: "TextNode",
      uuid: "math",
      text: "$$x$$",
      borderStyle: "none",
      sizeAdjust: "auto",
      fontFamily: "",
      fontWeight: "",
      color: before.color,
      details: before.details,
    });
    expect(node).not.toHaveProperty("latexSource");
    expect(stage[1].associationList).toEqual([{ $: "/0/children/0" }]);
    const migrated = structuredClone(stage);
    migrateLegacyMathCards(stage);
    expect(stage).toEqual(migrated);
  });

  it("never converts formula-only text cards", () => {
    const stage = [String.raw`$\TeX$`, String.raw`$$\frac{a}{b}$$`].map((text) => ({ _: "TextNode", text }));
    const before = structuredClone(stage);
    expect(migrateLegacyMathCards(stage)).toEqual(before);
  });
});
