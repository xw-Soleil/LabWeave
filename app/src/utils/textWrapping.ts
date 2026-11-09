// 从 font.tsx 抽出原有按码点折行，避免纯排版和命令行导入 Canvas、设置等界面依赖。
export function wrapTextByCharacters(
  text: string,
  limitWidth: number,
  measure: (text: string) => number,
  firstLineWidth = limitWidth,
): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex];
    const characters = Array.from(paragraph);
    let start = 0;
    let isFirstWrappedLine = true;

    while (start < characters.length) {
      const widthLimit = lines.length === 0 ? firstLineWidth : limitWidth;
      const remaining = characters.slice(start);
      const remainingText = remaining.join("");
      if (measure(remainingText) <= widthLimit) {
        lines.push(remainingText);
        start = characters.length;
        break;
      }

      let low = 1;
      let high = remaining.length;
      let fittingLength = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const width = measure(remaining.slice(0, middle).join(""));
        if (width <= widthLimit) {
          fittingLength = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }

      if (fittingLength === 0) {
        if (isFirstWrappedLine) {
          lines.push("");
          // 混排的第一行可能被公式占满，换行后应重新按整行宽度量剩余文字。
          if (widthLimit !== limitWidth) {
            isFirstWrappedLine = false;
            continue;
          }
        }
        fittingLength = 1;
      }
      lines.push(remaining.slice(0, fittingLength).join(""));
      start += fittingLength;
      isFirstWrappedLine = false;
    }

    if (paragraphIndex < paragraphs.length - 1 && paragraph.length === 0) {
      lines.push("");
    } else if (paragraphIndex < paragraphs.length - 1 && start === 0) {
      lines.push(paragraph);
    }
  }

  return lines;
}
