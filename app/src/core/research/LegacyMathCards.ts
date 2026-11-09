import { deserialize } from "@graphif/serializer";
import { splitInlineMath } from "./InlineMath";

export function legacyMathText(source: string): string {
  for (const text of [`$$${source}$$`, `\\[${source}\\]`]) {
    const segments = splitInlineMath(text);
    if (segments.length === 1 && segments[0].type === "display" && segments[0].source === source) return text;
  }
  // 无法无损包成块公式时保留源码，不猜测或删改旧内容。
  return source;
}

export function migrateLegacyMathCards<T>(data: T): T {
  const visited = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const object = value as Record<string, unknown>;
    if (object._ === "LatexNode") {
      Object.assign(object, {
        _: "TextNode",
        text: legacyMathText(typeof object.latexSource === "string" ? object.latexSource : ""),
        sizeAdjust: "auto",
        fontFamily: "",
        fontWeight: "",
        borderStyle: "none",
      });
      delete object.latexSource;
    }
    // 保留对象和数组下标，连线、分组的 $ 路径引用无需改写。
    for (const child of Object.values(object)) visit(child);
  };
  visit(data);
  return data;
}

export function deserializeStageObjects(data: unknown, project?: unknown): any {
  return deserialize(migrateLegacyMathCards(data), project);
}
