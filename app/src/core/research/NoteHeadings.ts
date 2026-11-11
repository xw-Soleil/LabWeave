import { GFM, parser as markdownParser } from "@lezer/markdown";
import { frontmatterSyntax } from "./MarkdownLivePreview";

export interface OutlineHeading {
  level: number;
  text: string;
  /** 在原文里是第几行（从 0 数） */
  line: number;
}

/** 笔记正文里读到哪了：阅读模式按第几个标题，编辑模式按原文第几行 */
export type OutlinePosition = { index: number } | { line: number };

const outlineParser = markdownParser.configure([GFM, frontmatterSyntax]);

/** 标题里的 Markdown 记号去掉，只留看得见的字，和 Obsidian 的大纲一样 */
function headingText(source: string) {
  return source
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|==|~~)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** 正文最外层的标题（不算引用、提示框、列表里的），和阅读模式里排出来的标题一一对应 */
export function parseOutline(text: string): OutlineHeading[] {
  const tree = outlineParser.parse(text);
  const headings: OutlineHeading[] = [];
  let line = 0;
  let counted = 0;
  const lineOf = (position: number) => {
    for (; counted < position; counted++) if (text.charCodeAt(counted) === 10) line++;
    return line;
  };
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const atx = /^ATXHeading(\d)$/.exec(node.name);
    const setext = /^SetextHeading(\d)$/.exec(node.name);
    if (!atx && !setext) continue;
    const source = text.slice(node.from, node.to);
    const title = atx ? source.replace(/^\s*#{1,6}/, "").replace(/\s#+\s*$/, "") : source.split("\n", 1)[0];
    headings.push({ level: Number((atx ?? setext)![1]), text: headingText(title), line: lineOf(node.from) });
  }
  return headings;
}
