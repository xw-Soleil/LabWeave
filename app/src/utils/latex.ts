/** 编辑浮层只把完整公式交给 KaTeX，避免把普通说明文字当成公式。 */
export function extractLatexSource(value: string): string | null {
  const text = value.trim();
  for (const [open, close] of [
    ["$$", "$$"],
    ["\\[", "\\]"],
    ["\\(", "\\)"],
    ["$", "$"],
  ]) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      const source = text.slice(open.length, -close.length).trim();
      return source && !/(?<!\\)\$/.test(source) ? source : null;
    }
  }
  const environment = /^\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|aligned|gathered)\}/.exec(text);
  if (environment && text.endsWith(`\\end{${environment[1]}}`)) return text;
  return null;
}
