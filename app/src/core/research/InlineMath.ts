export type FormulaSegment = {
  type: "inline" | "display";
  source: string;
  raw: string;
};

export type MathSegment = { type: "text"; text: string } | FormulaSegment;

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && text[--index] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

export function splitInlineMath(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let textStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    if (isEscaped(text, cursor)) {
      cursor++;
      continue;
    }
    const open = text.startsWith("$$", cursor)
      ? "$$"
      : text.startsWith("\\[", cursor)
        ? "\\["
        : text.startsWith("\\(", cursor)
          ? "\\("
          : text[cursor] === "$"
            ? "$"
            : null;
    if (!open) {
      cursor++;
      continue;
    }
    const start = cursor + open.length;
    if (open === "$" && /\s/.test(text[start] ?? "")) {
      cursor = start;
      continue;
    }
    const close = open === "\\[" ? "\\]" : open === "\\(" ? "\\)" : open;
    let end = text.indexOf(close, start);
    while (end !== -1 && isEscaped(text, end)) {
      end = text.indexOf(close, end + close.length);
    }
    if (end === -1 || (open === "$" && (/\s/.test(text[end - 1] ?? "") || /[0-9]/.test(text[end + 1] ?? "")))) {
      cursor = start;
      continue;
    }
    const source = text.slice(start, end);
    cursor = end + close.length;
    if (!source.trim()) continue;
    if (textStart < start - open.length) {
      segments.push({ type: "text", text: text.slice(textStart, start - open.length) });
    }
    segments.push({
      type: open === "$$" || open === "\\[" ? "display" : "inline",
      source,
      raw: text.slice(start - open.length, cursor),
    });
    textStart = cursor;
  }
  if (textStart < text.length) segments.push({ type: "text", text: text.slice(textStart) });
  return segments;
}

export function hasInlineMath(text: string): boolean {
  return splitInlineMath(text).some((segment) => segment.type !== "text");
}
