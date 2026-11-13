import type { PdfPageGeometry, Rect } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import { formattedSelection, selectionRects } from "./PdfSelectionRects";

type Run = PdfPageGeometry["runs"][number];

/** size 是真实字号；above / below 是引擎给的松框在基线上下各多少；fontSize 是引擎报的字号 */
interface Font {
  size: number;
  above: number;
  below: number;
  fontSize?: number;
}
interface Row {
  baseline: number;
  parts: { text: string; font: Font; x?: number; drop?: number }[];
}

const TALL = /[bdfhkltA-Z0-9]/;
const DEEP = /[gjpqy]/;

/** 把几行字排成引擎给的样子：一个词一段，每个字有松框和贴着字形的紧框，都取整到 1pt */
function page(rows: Row[]): PdfPageGeometry {
  const runs: Run[] = [];
  let charStart = 0;
  for (const row of rows) {
    let left = 50;
    for (const part of row.parts) {
      const { font } = part;
      const baseline = row.baseline + (part.drop ?? 0);
      left = part.x ?? left;
      for (const word of part.text.match(/\S+\s*/g) ?? []) {
        const top = Math.round(baseline - font.above);
        const height = Math.round(baseline + font.below) - top;
        const glyphs = [...word].map((char) => {
          const x = Math.round(left);
          left += font.size / 2;
          const width = Math.round(left) - x;
          if (char === " ") return { x, y: top, width, height, flags: 1 };
          const inkTop = Math.round(baseline - font.size * (TALL.test(char) ? 0.7 : 0.45));
          const inkBottom = Math.round(baseline + (DEEP.test(char) ? font.size * 0.22 : 0));
          return {
            x,
            y: top,
            width,
            height,
            flags: 0,
            tightX: x,
            tightY: inkTop,
            tightWidth: width,
            tightHeight: inkBottom - inkTop,
          };
        });
        runs.push({
          rect: { x: glyphs[0].x, y: top, width: Math.round(left) - glyphs[0].x, height },
          charStart,
          glyphs,
          fontSize: font.fontSize ?? font.size,
        });
        charStart += glyphs.length;
      }
    }
  }
  return { runs };
}

const TEXT = [
  "Steel is the foundation of modern industry,",
  "playing a vital role in infrastructure and",
  "manufacturing. Blast furnace ironmaking, as",
  "a key process in steel production, is big",
  "zone.",
];
const paragraph = (font: Font, pitch: number, first = 100, text = TEXT): Row[] =>
  text.map((line, index) => ({ baseline: first + index * pitch, parts: [{ text: line, font }] }));
const size = (geo: PdfPageGeometry) => geo.runs.reduce((sum, run) => sum + run.glyphs.length, 0);
const all = (geo: PdfPageGeometry) => selectionRects(geo, 0, size(geo) - 1);
const top = (rect: Rect) => rect.origin.y;
const bottom = (rect: Rect) => rect.origin.y + rect.size.height;
/** 没被任何一个框完整盖住的字有几个 */
const cut = (geo: PdfPageGeometry, rects: Rect[]) =>
  geo.runs
    .flatMap((run) => run.glyphs)
    .filter(
      (glyph) =>
        glyph.flags === 0 &&
        !rects.some(
          (rect) =>
            glyph.x >= rect.origin.x &&
            glyph.x + glyph.width <= rect.origin.x + rect.size.width &&
            glyph.tightY! >= top(rect) &&
            glyph.tightY! + glyph.tightHeight! <= bottom(rect),
        ),
    ).length;

// Elsevier 用的 Charis SIL：字号 8、行距 10，引擎给的松框却有 30 高
const charis: Font = { size: 8, above: 22, below: 8 };
// 普通的 Times 类字体：字号 10、松框 12 高
const times: Font = { size: 10, above: 9, below: 3 };

describe("selection boxes drawn line by line", () => {
  it("hugs the text when the font declares a box several times taller than its size", () => {
    const geo = page(paragraph(charis, 10));
    const rects = all(geo);
    expect(rects).toHaveLength(5);
    // 原来整段是 78 到 148（松框），现在贴着字：第一行的 b、d 顶在 94，最后一行基线在 140
    expect(top(rects[0])).toBeGreaterThan(91);
    expect(top(rects[0])).toBeLessThan(94);
    expect(bottom(rects[4])).toBeGreaterThan(141);
    expect(bottom(rects[4])).toBeLessThan(144);
    // 行与行之间不重叠也不留缝，每行就是一个行距那么高；只有「zone.」这种矮字的短行也一样
    for (let i = 1; i < rects.length; i++) expect(top(rects[i])).toBeCloseTo(bottom(rects[i - 1]));
    for (const rect of rects.slice(1)) expect(rect.size.height).toBeCloseTo(10, 0);
    expect(cut(geo, rects)).toBe(0);
  });

  it("leaves an ordinary PDF looking the way it did", () => {
    const geo = page(paragraph(times, 12));
    const rects = all(geo);
    // 松框是 91 到 151
    expect(Math.abs(top(rects[0]) - 91)).toBeLessThan(1.5);
    expect(Math.abs(bottom(rects[4]) - 151)).toBeLessThan(1);
    for (let i = 1; i < rects.length; i++) expect(top(rects[i])).toBeCloseTo(bottom(rects[i - 1]));
    expect(cut(geo, rects)).toBe(0);
  });

  it("keeps widely spaced lines apart instead of stretching them", () => {
    const rects = all(page(paragraph(times, 24)));
    for (const rect of rects) expect(rect.size.height).toBeLessThan(13);
    for (let i = 1; i < rects.length; i++) expect(top(rects[i]) - bottom(rects[i - 1])).toBeGreaterThan(8);
    // 短行和别的行一样高：字高是整页一起统计的，不是只看这一行
    expect(rects[4].size.height).toBeCloseTo(rects[0].size.height);
  });

  it("gives part of a line the same height as the whole line", () => {
    const geo = page(paragraph(charis, 10));
    const whole = all(geo)[1];
    const start = geo.runs.find(
      (run) => run.glyphs[0].y === whole.origin.y || run.charStart >= TEXT[0].length,
    )!.charStart;
    const [part] = selectionRects(geo, start + 8, start + 20);
    expect(top(part)).toBeCloseTo(top(whole));
    expect(bottom(part)).toBeCloseTo(bottom(whole));
    expect(part.origin.x).toBeGreaterThan(whole.origin.x);
    expect(part.size.width).toBeLessThan(whole.size.width);
  });

  it("keeps subscripts in their line and still covers them", () => {
    const small: Font = { size: 6, above: 16, below: 6 };
    const rows = paragraph(charis, 10, 100, TEXT.slice(0, 2));
    rows.push({
      baseline: 120,
      parts: [
        { text: "the value of x", font: charis },
        { text: "max", font: small, drop: 2 },
        { text: " is large enough to matter here today", font: charis },
      ],
    });
    // 让小字在这一页上也够多（脚注）
    rows.push(...paragraph(small, 8, 300, TEXT.slice(0, 2)));
    const geo = page(rows);
    const rects = all(geo);
    expect(rects).toHaveLength(5);
    expect(top(rects[2])).toBeCloseTo(bottom(rects[1]));
    expect(cut(geo, rects)).toBe(0);
  });

  it("paints the cells of a table row separately but at one height", () => {
    const rows = paragraph(times, 12);
    rows.push({
      baseline: 200,
      parts: [
        { text: "Blast furnace", font: times },
        { text: "60% to 70%", font: times, x: 300 },
      ],
    });
    const rects = all(page(rows)).slice(-2);
    expect(rects[0].origin.x + rects[0].size.width).toBeLessThan(200);
    expect(rects[1].origin.x).toBe(300);
    expect(top(rects[1])).toBe(top(rects[0]));
    expect(bottom(rects[1])).toBe(bottom(rects[0]));
  });

  it("does not trust the reported font size, which some PDFs set to 1 for everything", () => {
    const body = { ...times, fontSize: 1 };
    const note: Font = { size: 7, above: 16, below: 6, fontSize: 1 };
    const geo = page([...paragraph(body, 12), ...paragraph(note, 8.5, 300)]);
    const rects = all(geo);
    for (const rect of rects.slice(1, 4)) expect(rect.size.height).toBeCloseTo(12, 0);
    for (const rect of rects.slice(6, 9)) expect(Math.abs(rect.size.height - 8.5)).toBeLessThan(1);
    // 小字的松框是 284 到 340，字只在 295 到 336 之间
    expect(top(rects[5])).toBeGreaterThan(292);
    expect(bottom(rects[9])).toBeLessThan(338);
    expect(cut(geo, rects)).toBe(0);
  });

  it("falls back to the engine's boxes for sideways text and when there are no tight boxes", () => {
    // 竖着排的一串字（arXiv 左边的水印）：每个字的松框上下边不在一条线上
    const sideways: PdfPageGeometry = {
      runs: [
        {
          rect: { x: 20, y: 200, width: 12, height: 70 },
          charStart: 0,
          fontSize: 20,
          glyphs: Array.from({ length: 14 }, (_, index) => ({
            x: 20,
            y: 200 + index * 5,
            width: 12,
            height: 5,
            flags: 0,
            tightX: 22,
            tightY: 200 + index * 5,
            tightWidth: 8,
            tightHeight: 4,
          })),
        },
      ],
    };
    expect(all(sideways)).toEqual([{ origin: { x: 20, y: 200 }, size: { width: 12, height: 70 } }]);

    const geo = page(paragraph(charis, 10));
    const loose: PdfPageGeometry = {
      runs: geo.runs.map((run) => ({
        ...run,
        glyphs: run.glyphs.map(({ x, y, width, height, flags }) => ({ x, y, width, height, flags })),
      })),
    };
    expect(all(loose).map((rect) => [top(rect), bottom(rect)])).toEqual([
      [78, 108],
      [88, 118],
      [98, 128],
      [108, 138],
      [118, 148],
    ]);
  });

  it("pads lone labels whose font is too rare on the page to learn from", () => {
    const geo = page([{ baseline: 100, parts: [{ text: "0.5", font: charis }] }]);
    // 字在 94 到 100 之间，松框是 78 到 108
    const [rect] = all(geo);
    expect(top(rect)).toBeCloseTo(92.8);
    expect(bottom(rect)).toBeCloseTo(101.2);
  });
});

describe("the selection as highlights and the menu use it", () => {
  it("lists every selected page with our boxes and their bounds", () => {
    const first = page(paragraph(charis, 10));
    const second = page(paragraph(times, 12));
    const state = {
      geometry: { 2: first, 3: second },
      slices: { 3: { start: 0, count: 10 }, 2: { start: size(first) - 5, count: 5 } },
      rects: {},
    };
    const formatted = formattedSelection(state);
    expect(formatted.map((entry) => entry.pageIndex)).toEqual([2, 3]);
    expect(formatted[0].segmentRects).toEqual(selectionRects(first, size(first) - 5, size(first) - 1));
    expect(formatted[1].segmentRects).toEqual(selectionRects(second, 0, 9));
    expect(formatted[0].rect).toEqual(formatted[0].segmentRects[0]);
    expect(formattedSelection({ geometry: {}, slices: {}, rects: {} })).toEqual([]);
  });

  it("uses the plugin's own boxes for a page whose text layout is not loaded", () => {
    const rects = [{ origin: { x: 1, y: 2 }, size: { width: 3, height: 4 } }];
    expect(formattedSelection({ geometry: {}, slices: { 0: { start: 0, count: 3 } }, rects: { 0: rects } })).toEqual([
      { pageIndex: 0, rect: rects[0], segmentRects: rects },
    ]);
  });
});
