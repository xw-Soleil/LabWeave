import { wrapTextByCharacters } from "@/utils/textWrapping";
import type { FormulaSegment, MathSegment } from "./InlineMath";
import type { MathMetrics } from "./MathImage";

export type RichTextFragment = MathSegment & MathMetrics & { x: number };

export interface RichTextLine {
  fragments: RichTextFragment[];
  width: number;
  height: number;
  baseline: number;
  y: number;
}

export interface RichTextLayout {
  lines: RichTextLine[];
  width: number;
  height: number;
}

export interface RichTextLayoutOptions {
  segments: readonly MathSegment[];
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  measureText: (text: string) => number;
  getMathMetrics: (segment: FormulaSegment) => MathMetrics | null;
  // 只有量宽函数时使用 em 框；画布调用方可传入当前字体实测的下降部。
  textDescent?: number;
}

export function layoutRichText({
  segments,
  fontSize,
  lineHeight,
  maxWidth,
  measureText,
  getMathMetrics,
  textDescent = fontSize * 0.2,
}: RichTextLayoutOptions): RichTextLayout {
  const lines: RichTextLine[] = [];
  let fragments: RichTextFragment[] = [];
  let width = 0;
  let height = 0;
  let implicitBreak = false;

  const finishLine = () => {
    const hasText = fragments.length === 0 || fragments.some((fragment) => fragment.type === "text");
    let ascent = hasText ? fontSize - textDescent : 0;
    let descent = hasText ? textDescent : 0;
    for (const fragment of fragments) {
      ascent = Math.max(ascent, fragment.height - fragment.descent);
      descent = Math.max(descent, fragment.descent);
    }
    // 不同公式的最高点、最低点可能不在同一个公式上，必须容下整行的基线两侧。
    const rowHeight = Math.max(fontSize * lineHeight, ascent + descent);
    lines.push({
      fragments,
      width,
      height: rowHeight,
      baseline: (rowHeight - ascent - descent) / 2 + ascent,
      y: height,
    });
    height += rowHeight;
    fragments = [];
    width = 0;
  };

  const appendText = (text: string) => {
    const paragraphs = text.split("\n");
    paragraphs.forEach((paragraph, index) => {
      if (index > 0) {
        if (!implicitBreak) finishLine();
        implicitBreak = false;
      }
      if (!paragraph) return;
      const wrapped = wrapTextByCharacters(paragraph, maxWidth, measureText, maxWidth - width);
      wrapped.forEach((part, lineIndex) => {
        if (lineIndex > 0) finishLine();
        if (!part) return;
        const partWidth = measureText(part);
        fragments.push({
          type: "text",
          text: part,
          x: width,
          width: partWidth,
          height: fontSize,
          descent: textDescent,
        });
        width += partWidth;
      });
      implicitBreak = false;
    });
  };

  let pendingText = "";
  for (const segment of segments) {
    const metrics = segment.type === "text" ? null : getMathMetrics(segment);
    if (segment.type === "text" || !metrics) {
      pendingText += segment.type === "text" ? segment.text : segment.raw;
      continue;
    }
    if (pendingText) appendText(pendingText);
    pendingText = "";
    if (fragments.length > 0 && (segment.type === "display" || width + metrics.width > maxWidth)) finishLine();
    fragments.push({ ...segment, ...metrics, x: width });
    width += metrics.width;
    implicitBreak = false;
    if (segment.type === "display" || metrics.width > maxWidth) {
      finishLine();
      implicitBreak = true;
    }
  }
  if (pendingText) appendText(pendingText);
  if (fragments.length > 0 || lines.length === 0) finishLine();

  const naturalWidth = lines.reduce((maximum, line) => Math.max(maximum, line.width), 0);
  let totalWidth = naturalWidth;
  for (const line of lines) {
    if (line.fragments.length === 1 && line.fragments[0].type === "display") {
      const availableWidth = Number.isFinite(maxWidth) ? Math.max(maxWidth, line.width) : naturalWidth;
      line.fragments[0].x = (availableWidth - line.width) / 2;
      totalWidth = Math.max(totalWidth, availableWidth);
    }
  }
  return { lines, width: totalWidth, height };
}
