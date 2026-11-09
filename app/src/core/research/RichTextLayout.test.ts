import { describe, expect, it } from "vitest";
import { wrapTextByCharacters } from "@/utils/textWrapping";
import { splitInlineMath } from "./InlineMath";
import { layoutRichText, type RichTextLayoutOptions } from "./RichTextLayout";

const measureText = (text: string) => Array.from(text).length * 10;
const layout = (text: string, options: Partial<RichTextLayoutOptions> = {}) =>
  layoutRichText({
    segments: splitInlineMath(text),
    fontSize: 10,
    lineHeight: 1.2,
    maxWidth: Infinity,
    measureText,
    getMathMetrics: () => ({ width: 25, height: 20, descent: 5 }),
    ...options,
  });
const contents = (result: ReturnType<typeof layout>) =>
  result.lines.map((line) => line.fragments.map((part) => (part.type === "text" ? part.text : part.raw)).join(""));

describe("layoutRichText", () => {
  it("runs without a document and keeps explicit and blank lines", () => {
    expect(typeof document).toBe("undefined");
    expect(contents(layout("a\n\nb\n"))).toEqual(["a", "", "b"]);
    expect(layout("").height).toBe(12);
  });

  it.each(["中文 English😀标点，", "a  b_c-d", "超级长的中文", "averylongword"])(
    "uses the existing TextNode character wrapping for %s",
    (text) => {
      expect(contents(layout(text, { maxWidth: 40 }))).toEqual(wrapTextByCharacters(text, 40, measureText));
    },
  );

  it("keeps auto-sized text unwrapped and measures complete text runs", () => {
    const measure = (text: string) => (text === "AV" ? 15 : measureText(text));
    const result = layout("AV$x$中文", { measureText: measure });
    expect(contents(result)).toEqual(["AV$x$中文"]);
    expect(result.lines[0].fragments.map(({ x, width }) => [x, width])).toEqual([
      [0, 15],
      [15, 25],
      [40, 20],
    ]);
    expect(result.width).toBe(60);
  });

  it("moves an inline formula as a whole and fills the remaining width with text", () => {
    const result = layout("abc$x$中文后", { maxWidth: 50 });
    expect(contents(result)).toEqual(["abc", "$x$中文", "后"]);
    expect(result.lines[1].fragments.map(({ x }) => x)).toEqual([0, 25]);
    expect(result.lines.map(({ y }) => y)).toEqual([0, 12, 32]);
    expect(result.height).toBe(44);
  });

  it("uses the full next line when no character fits after a formula", () => {
    expect(contents(layout("$x$abcd", { maxWidth: 30 }))).toEqual(["$x$", "abc", "d"]);
  });

  it("puts an over-wide formula alone without clipping or an extra blank line", () => {
    const result = layout("a$x$b", { maxWidth: 20 });
    expect(contents(result)).toEqual(["a", "$x$", "b"]);
    expect(result.width).toBe(25);
    expect(contents(layout("$x$", { maxWidth: 20 }))).toEqual(["$x$"]);
  });

  it("centres a display formula within manual width or the widest auto-sized line", () => {
    const manual = layout("a$$x$$b", { maxWidth: 100 });
    expect(contents(manual)).toEqual(["a", "$$x$$", "b"]);
    expect(manual.lines[1].fragments[0].x).toBe(37.5);
    expect(manual.width).toBe(100);
    const auto = layout("abcdef$$x$$b");
    expect(auto.lines[1].fragments[0].x).toBe(17.5);
    expect(auto.width).toBe(60);
    expect(contents(layout("a\n$$x$$\nb"))).toEqual(["a", "$$x$$", "b"]);
    expect(contents(layout("$$x$$$$y$$"))).toEqual(["$$x$$", "$$y$$"]);
    expect(contents(layout("$$x$$\n\nb"))).toEqual(["$$x$$", "", "b"]);
  });

  it("aligns text and math at one baseline and centres the baseline box in the line", () => {
    const line = layout("a$x$", { lineHeight: 3, textDescent: 3 }).lines[0];
    expect(line.height).toBe(30);
    expect(line.baseline).toBe(20);
    const top = (fragment: (typeof line.fragments)[number]) => line.baseline - fragment.height + fragment.descent;
    expect(top(line.fragments[0])).toBe(13);
    expect(top(line.fragments[1])).toBe(5);
    for (const fragment of line.fragments) {
      expect(top(fragment) + fragment.height - fragment.descent).toBe(line.baseline);
    }
  });

  it("contains the greatest ascent and descent even when they belong to different formulas", () => {
    const line = layout("$a$ $b$", {
      getMathMetrics: ({ source }) => ({ width: 20, height: 30, descent: source === "a" ? 2 : 20 }),
    }).lines[0];
    expect(line.height).toBe(48);
    expect(line.baseline).toBe(28);
    for (const fragment of line.fragments) {
      expect(line.baseline - fragment.height + fragment.descent).toBeGreaterThanOrEqual(0);
      expect(line.baseline + fragment.descent).toBeLessThanOrEqual(line.height);
    }
  });

  it("falls back to the complete source, including display delimiters, as one text run", () => {
    const text = "a$x$中$$y$$文";
    const result = layout(text, { maxWidth: 40, getMathMetrics: () => null });
    expect(contents(result)).toEqual(wrapTextByCharacters(text, 40, measureText));
    expect(result.lines.flatMap(({ fragments }) => fragments).every(({ type }) => type === "text")).toBe(true);
    expect(result.height).toBe(result.lines.length * 12);
  });

  it("keeps the extracted wrapper's old empty-paragraph and over-wide-character behavior", () => {
    expect(wrapTextByCharacters("", 40, measureText)).toEqual([]);
    expect(wrapTextByCharacters("a\n", 40, measureText)).toEqual(["a"]);
    expect(wrapTextByCharacters("\na\n\n", 40, measureText)).toEqual(["", "a", ""]);
    expect(wrapTextByCharacters("😀a", 1, measureText)).toEqual(["", "😀", "a"]);
  });
});
