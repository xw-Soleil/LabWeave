import { fingerprint, under } from "./ProjectRecord";

/*
 * 节点之间手填的记录：用户自己记的进展、待办、问题、下一步。和自动记的活动记录是两份，写汇报时都用。
 *
 *   项目文件夹/进展记录/进行中.md           上个节点以后记的
 *   项目文件夹/进展记录/2026-11-21 组会.md   定格时封存的那一段
 *
 * 都是普通的 Markdown，分四节（进展、待办、问题与决定、下一步），每条是一行列表项，
 * 后面缩进的几行是详细内容、关联的链接和图片。Obsidian 里能直接看和改；
 * 程序改的时候只动那一条占的几行，别的字、别的节、开头的属性都原样留着。
 *
 * 解析和改写 Markdown 的部分出自同伴 cleverfool-rnh 的 PR（xw-Soleil/LabWeave 第 1 号）里的 WeeklyProgress.ts。
 * 这里把「按周一份」换成了「按节点一份」，读写不再经过 Rust，另加了定格时封存、把没做完的带到下一段。
 */

export type RecordSection = "done" | "todo" | "notes" | "next";
export const RECORD_SECTIONS: readonly RecordSection[] = ["done", "todo", "notes", "next"];
export interface RecordLink {
  label: string;
  href: string;
}
export interface RecordItem {
  id: string;
  section: RecordSection;
  text: string;
  summary?: string;
  done: boolean;
  links: RecordLink[];
  images?: RecordLink[];
}
export interface RecordItemOptions {
  summary?: string;
  images?: RecordLink[];
  links?: RecordLink[];
}
export interface RecordItemUpdate {
  summary: string;
  text: string;
  links: RecordLink[];
  images: RecordLink[];
}
export interface NodeRecord {
  /** 哪一份：「进行中」，或者封存它的那个节点的名字（2026-11-21 组会） */
  name: string;
  /** 文件在哪，相对项目文件夹 */
  path: string;
  markdown: string;
  /** 读进来时内容的指纹；文件还没有时是空的。存的时候拿它对一下，这期间别处改过就不覆盖 */
  revision: string;
  items: RecordItem[];
  links: RecordLink[];
}

type StoredRecord = Omit<NodeRecord, "items" | "links">;
export const NODE_RECORD_CHANGED_EVENT = "research:node-record-changed";
export const RECORD_DIRECTORY = "进展记录";
/** 上个节点以后记的那一份 */
export const CURRENT_RECORD = "进行中";
const titles: Record<RecordSection, string> = {
  done: "进展",
  todo: "待办",
  notes: "问题与决定",
  next: "下一步",
};
/** 封存时零散的字（不属于哪一条事项的）归到这一节，免得丢 */
const LOOSE_TITLE = "其他";
const recordHeading = (name: string) => `# ${RECORD_DIRECTORY} · ${name}`;

/** 记录的文件名：节点的名字，去掉文件名里不能有的符号 */
export function recordFileName(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim();
  return safe || CURRENT_RECORD;
}

/** 相对项目文件夹的路径 */
export const recordPath = (name: string) => `${RECORD_DIRECTORY}/${recordFileName(name)}.md`;

export function recordTemplate(name: string): string {
  return `${recordHeading(name)}\n\n${Object.values(titles)
    .map((title) => `## ${title}\n`)
    .join("\n")}`;
}

const stored = (name: string, markdown: string, revision = fingerprint(markdown)): StoredRecord => ({
  name,
  path: recordPath(name),
  markdown,
  revision,
});

/** 读写记录文件用的接口，路径都是完整路径。默认是桌面端的文件接口，测试里换成假的 */
export interface RecordFiles {
  /** 文件不存在给 undefined */
  read(path: string): Promise<string | undefined>;
  /** 文件夹不存在会先建 */
  write(path: string, text: string): Promise<void>;
  /** 文件夹里的文件名；文件夹不存在给空 */
  names(folder: string): Promise<string[]>;
  /** 包在写的外面：桌面端用它照顾正开着这篇笔记的标签页。没有就直接写 */
  guard?(path: string, write: () => Promise<void>): Promise<void>;
}

const desktopFiles: RecordFiles = {
  async read(path) {
    const fs = await import("@tauri-apps/plugin-fs");
    return (await fs.exists(path)) ? fs.readTextFile(path) : undefined;
  },
  async write(path, text) {
    const fs = await import("@tauri-apps/plugin-fs");
    const folder = path.replace(/\\/g, "/").slice(0, path.replace(/\\/g, "/").lastIndexOf("/"));
    if (!(await fs.exists(folder))) await fs.mkdir(folder, { recursive: true });
    await fs.writeTextFile(path, text);
  },
  async names(folder) {
    const fs = await import("@tauri-apps/plugin-fs");
    return (await fs.exists(folder))
      ? (await fs.readDir(folder)).filter((entry) => entry.isFile).map((entry) => entry.name)
      : [];
  },
  async guard(path, write) {
    const [{ DocumentTab }, { documentKey }, { store, tabsAtom }, { notifyResearchFilesChanged }] = await Promise.all([
      import("./DocumentTab"),
      import("./DocumentFile"),
      import("@/state"),
      import("./ResearchFolder"),
    ]);
    const key = documentKey(path);
    const opened = store
      .get(tabsAtom)
      .filter(
        (tab): tab is InstanceType<typeof DocumentTab> => tab instanceof DocumentTab && documentKey(tab.path) === key,
      );
    if (opened.some((tab) => tab.hasUnsavedChanges || tab.saving || tab.loadingMarkdown || tab.closing)) {
      throw new Error("nodeRecord.documentBusy");
    }
    // Reserve clean editors during the write so a simultaneous Ctrl+S cannot race it.
    opened.forEach((tab) => {
      tab.loadingMarkdown = true;
      tab.changed();
    });
    try {
      await write();
    } finally {
      opened.forEach((tab) => {
        tab.loadingMarkdown = false;
        tab.changed();
      });
    }
    // loadMarkdown also checks for edits made while its asynchronous read is in flight.
    await Promise.all(opened.filter((tab) => !tab.hasUnsavedChanges).map((tab) => tab.loadMarkdown(true)));
    notifyResearchFilesChanged();
  },
};

function inlineCodeRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "`") continue;
    let slashes = 0;
    for (let index = start - 1; index >= 0 && text[index] === "\\"; index--) slashes++;
    if (slashes % 2) continue;
    let openingEnd = start + 1;
    while (text[openingEnd] === "`") openingEnd++;
    let next = text.indexOf("`", openingEnd);
    let closingEnd = -1;
    while (next >= 0) {
      let end = next + 1;
      while (text[end] === "`") end++;
      if (end - next === openingEnd - start) {
        closingEnd = end;
        break;
      }
      next = text.indexOf("`", end);
    }
    if (closingEnd >= 0) {
      ranges.push({ start, end: closingEnd });
      start = closingEnd - 1;
    } else start = openingEnd - 1;
  }
  return ranges;
}

function maskInlineCode(text: string): string {
  let masked = text;
  for (const range of inlineCodeRanges(text).reverse())
    masked = masked.slice(0, range.start) + " ".repeat(range.end - range.start) + masked.slice(range.end);
  return masked;
}

function inlineLinks(text: string): RecordLink[] {
  const links: RecordLink[] = [];
  const source = maskInlineCode(text);
  for (const match of source.matchAll(/(?<!!)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g)) {
    links.push({ label: match[1], href: match[2] ?? match[3] });
  }
  for (const match of source.matchAll(/(?<!!)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
    links.push({ label: match[2] ?? match[1], href: match[1] });
  }
  return links;
}

function inlineImages(text: string): RecordLink[] {
  const links: RecordLink[] = [];
  const source = maskInlineCode(text);
  for (const match of source.matchAll(/!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g)) {
    links.push({ label: match[1], href: match[2] ?? match[3] });
  }
  for (const match of source.matchAll(/!\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
    links.push({ label: match[2] ?? match[1].split("/").at(-1) ?? "", href: match[1] });
  }
  return links;
}

function visibleText(text: string, trim = true): string {
  const render = (value: string) =>
    value
      .replace(/!\[[^\]\n]*\]\(\s*(?:<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g, "")
      .replace(/!\[\[[^\]\n]+\]\]/g, "")
      .replace(/\[([^\]\n]*)\]\(\s*(?:<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g, "$1")
      .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, label?: string) => label ?? target);
  let visible = "";
  let from = 0;
  for (const code of inlineCodeRanges(text)) {
    visible += render(text.slice(from, code.start)) + text.slice(code.start, code.end);
    from = code.end;
  }
  visible += render(text.slice(from));
  return trim ? visible.trim() : visible;
}

const titledDetail = /^\*\*((?:\\.|[^*])+)\*\*[ \t]+(?:—|–|--)[ \t]?(.*)$/;
const itemLine = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?)(.*)$/;
function plainTitle(title: string): string {
  return title.replace(/\\([\\*])/g, "$1");
}
function titleMarkdown(title: string): string {
  return title
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*");
}

function shortPhrase(value: string, limit: number): string {
  const characters = [...value];
  if (characters.length <= limit) return value;
  if (limit < 3) return characters.slice(0, Math.max(0, limit)).join("");
  const uncertainty =
    /尚未|仍未|还没|未能|无法|不能|不支持|没有|是否|能否|何时|如何|为什么|\b(?:not|never|cannot|can't|whether|why|how)\b/i.exec(
      value,
    );
  if (uncertainty && uncertainty.index > limit / 2) {
    const suffix = value.slice(uncertainty.index);
    const suffixBudget = Math.min([...suffix].length, Math.floor(limit * 0.6));
    return `${shortPhrase(value.slice(0, uncertainty.index), limit - suffixBudget - 1)} ${shortPhrase(suffix, suffixBudget)}`;
  }
  const prefix = characters.slice(0, Math.max(1, limit - 1)).join("");
  const boundary = prefix.lastIndexOf(" ");
  return `${boundary >= limit / 2 ? prefix.slice(0, boundary) : prefix}${/[?？]$/.test(value) ? value.at(-1) : "…"}`;
}

function alternativeKeywords(value: string, limit: number): string {
  if ([...value].length <= limit || /不|未|没有|\b(?:not|without|never)\b/i.test(value))
    return shortPhrase(value, limit);
  const subject =
    value
      .split(/(?:的|用于|用来|针对|面向|进行|开展)|\s+(?:for|using|with)\s+/i)
      .filter(Boolean)
      .at(-1) ?? value;
  if ([...subject].length > limit && /(?:设计|开发|实现|验证|研究|分析|调研|方案|路线|方向)$/.test(subject)) {
    return `…${[...subject].slice(-(limit - 1)).join("")}`;
  }
  return shortPhrase(subject, limit);
}

/** A deterministic title suggestion, retaining uncertainty; the original detail is never rewritten. */
export function summarizeRecordItem(text: string, section: RecordSection): string {
  const details = markdownLines(text).lines;
  const prose = contentLines(details);
  const original = visibleText(details.filter((_, index) => prose[index]).join("\n"));
  let source = original
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/^[ \t]*(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!source) return "";
  const leadingFiller =
    /^(?:(?:本周|这周|目前|当前|现在|下周|未来|接下来|后续)(?:的)?|(?:我们|我)(?:这边)?|主要(?:是)?|具体来说[，,:：]?|关于|针对|打算|希望|需要|想要|先要)[，,：:\s]*/;
  while (leadingFiller.test(source)) source = source.replace(leadingFiller, "");
  const englishFiller =
    /^(?:this week|next week|currently|at present|we|i|mainly|have|has|already|completed(?: the)?|plan to|need to)\b[\s,:]*/i;
  while (englishFiller.test(source)) source = source.replace(englishFiller, "");
  source = source
    .replace(/^已经(?=完成)/, "")
    .replace(/^完成(?!不|得|率|度|量|状态|情况|标准|条件|时间|进度|与否|了吗|了么|吗|么|没有|没|否)了?/, "")
    .replace(/^确定好?/, "确定")
    .replace(/(?:的)?相关(?:的)?(?=实现|工作|调研|测试|验证|分析)/g, "")
    .replace(/(?:进行|开展)(?:了)?(?=调研|测试|验证|分析|整理|讨论|评估)/g, "")
    .replace(/(?:的)?(?:工作|事宜)[。！!]?$/, "")
    .replace(/的(?=初步|需求|实现|呈现|调研)/g, "")
    .replace(/以后/g, "后")
    .replace(/一下/g, "");
  if (section === "next") source = source.replace(/^计划(?:要)?/, "");
  const limit = /\p{Script=Han}/u.test(source) ? 24 : 56;
  const alternatives =
    /^(.{1,18}?)[，,:：]\s*(?:是|到底是)?(?:针对|选择|采用)?(.+?)还是(?:偏|选择|采用)?(.+?)(?:[，,。?？]|$)/.exec(
      source,
    );
  const directChoice =
    !alternatives && /[?？]$|是否|确定|选择/.test(source)
      ? /^(.+?)还是(?:偏|选择|采用)?(.+?)(?:[，,。?？]|$)/.exec(source)
      : null;
  if (alternatives || directChoice) {
    const topic = alternatives ? shortPhrase(alternatives[1].replace(/^确定/, ""), limit - 7) : "";
    const left = (alternatives?.[2] ?? directChoice![1].replace(/^确定(?:是)?/, "")).replace(/的/g, "");
    const right = (alternatives?.[3] ?? directChoice![2]).replace(/的/g, "");
    const available = Math.max(4, limit - [...topic].length - (topic ? 3 : 2));
    const firstBudget =
      [...left].length + [...right].length <= available
        ? [...left].length
        : Math.max(2, Math.min([...left].length, Math.floor(available / 2)));
    const secondBudget = available - firstBudget;
    return `${topic ? `${topic}：` : ""}${alternativeKeywords(left, firstBudget)}还是${alternativeKeywords(right, secondBudget)}`;
  }
  const clauses = source
    .split(/[\n。；;，,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  let result = clauses[0] ?? source;
  const constraint = clauses
    .slice(1)
    .find((part) =>
      /^(?:但(?:是)?|不过|然而)|尚未|仍未|不能|无法|是否|能否|还没|\b(?:but|not|never|whether|cannot|can't)\b/i.test(
        part,
      ),
    );
  if (constraint) {
    const key = constraint.replace(/^(?:但(?:是)?|不过|然而|but\s+)[，,\s]*/i, "");
    const keyBudget = Math.min([...key].length, Math.floor(limit * 0.6));
    result = `${shortPhrase(result, limit - keyBudget - 1)}；${shortPhrase(key, keyBudget)}`;
  }
  return shortPhrase(result.replace(/[。！!]$/, "") || original, limit);
}

function imageLabel(image: RecordLink): string {
  let name = image.label || image.href.split("/").at(-1) || "";
  try {
    name = decodeURIComponent(name);
  } catch {
    return name;
  }
  return name;
}

function referenceKey(link: RecordLink): string {
  return JSON.stringify([link.href, link.label]);
}

function uniqueLinks(links: RecordLink[]): RecordLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = referenceKey(link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function markdownLines(markdown: string): { lines: string[]; newline: string } {
  return { lines: markdown.split(/\r?\n/), newline: markdown.includes("\r\n") ? "\r\n" : "\n" };
}

function contentLines(lines: string[]): boolean[] {
  let fence: string | undefined;
  let frontmatter = false;
  return lines.map((line, index) => {
    if (index === 0 && line.replace(/^\uFEFF/, "") === "---") {
      frontmatter = true;
      return false;
    }
    if (frontmatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      return false;
    }
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim())
        fence = undefined;
      return false;
    }
    return !fence;
  });
}

/**
 * 提炼标题用的内容：第一行末尾挂着的那几个链接的名字不算（「关联当前内容」加的链接就挂在那里），
 * 不然标题会变成「对比了两种取法 演示白板.prg」。整行只有链接的不动。
 */
function withoutTrailingLinks(item: RecordItem): string {
  const [first, ...rest] = item.text.split("\n");
  let head = first.trimEnd();
  for (const link of item.links.toReversed()) {
    const label = link.label.trim();
    if (label && head.endsWith(label)) head = head.slice(0, -label.length).trimEnd();
  }
  return head ? [head, ...rest].join("\n") : item.text;
}

function parseRecordSource(record: StoredRecord): { record: NodeRecord; sourceRows: Map<string, number[]> } {
  const { lines } = markdownLines(record.markdown);
  const items: RecordItem[] = [];
  const links: RecordLink[] = [];
  let section: RecordSection | undefined;
  const sourceRows = new Map<string, number[]>();
  let previous: { item: RecordItem; indent: number; blankLines: number[] } | undefined;
  const visible = contentLines(lines);
  lines.forEach((line, index) => {
    const indentation = /^[ \t]*/.exec(line)![0].length;
    if (!visible[index]) {
      if (previous && indentation > previous.indent) {
        previous.item.text += `${"\n".repeat(previous.blankLines.length + 1)}${line.slice(Math.min(indentation, previous.indent + 2))}`;
        sourceRows.get(previous.item.id)!.push(...previous.blankLines, index);
        previous.blankLines = [];
      }
      return;
    }
    const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      section = (Object.keys(titles) as RecordSection[]).find((key) => titles[key] === heading[1]);
      previous = undefined;
      return;
    }
    const found = inlineLinks(line);
    const images = inlineImages(line);
    links.push(...found, ...images);
    if (!section) return;
    if (!line.trim()) {
      if (previous) previous.blankLines.push(index);
      return;
    }
    const bullet = itemLine.exec(line);
    const detail = bullet?.[3] ?? line;
    const explicit = titledDetail.exec(detail);
    const text = visibleText(explicit?.[2] ?? detail);
    const imageOnly = images.length > 0 && !text && !explicit;
    if (previous && (indentation > previous.indent || imageOnly)) {
      previous.item.links.push(...found);
      previous.item.images!.push(...images);
      if (!imageOnly) {
        const continuation = visibleText(line.slice(Math.min(indentation, previous.indent + 2)), false);
        previous.item.text += `${"\n".repeat(previous.blankLines.length + 1)}${continuation}`;
      }
      sourceRows.get(previous.item.id)!.push(...previous.blankLines, index);
      previous.blankLines = [];
      return;
    }
    if (/^\s*(?:>|#|<!--|\|)/.test(line)) return;
    if (!text && !images.length && !explicit) return;
    const item: RecordItem = {
      id: `line:${index}`,
      section,
      text,
      summary: explicit ? plainTitle(explicit[1]) : undefined,
      done: bullet?.[2] ? bullet[2].toLowerCase() === "x" : section === "done",
      links: found,
      images,
    };
    items.push(item);
    sourceRows.set(item.id, [index]);
    previous = { item, indent: indentation, blankLines: [] };
  });
  items.forEach((item) => {
    item.summary ??=
      summarizeRecordItem(withoutTrailingLinks(item), item.section) ||
      (item.images?.[0] ? imageLabel(item.images[0]) : "");
    item.links = uniqueLinks(item.links);
    item.images = uniqueLinks(item.images ?? []);
  });
  return { record: { ...record, items, links: uniqueLinks(links) }, sourceRows };
}

/** Unknown sections and prose remain in the original Markdown; the panel is only a concise view. */
export function parseNodeRecord(record: StoredRecord): NodeRecord {
  return parseRecordSource(record).record;
}

/** 读一份记录；文件还没有给 null。name 不给就是「进行中」 */
export async function loadNodeRecord(
  root: string,
  name = CURRENT_RECORD,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord | null> {
  const markdown = await io.read(under(root, recordPath(name)));
  return markdown === undefined ? null : parseNodeRecord(stored(name, markdown));
}

/** 封存过的那些节点的名字，最近的在前（名字以日期开头，按名字倒着排就是时间顺序） */
export async function listSealedRecords(root: string, io: RecordFiles = desktopFiles): Promise<string[]> {
  return (await io.names(under(root, RECORD_DIRECTORY)))
    .filter((file) => /\.md$/i.test(file))
    .map((file) => file.replace(/\.md$/i, ""))
    .filter((name) => name !== CURRENT_RECORD)
    .sort()
    .reverse();
}

/** 读一份记录，没有就照模板建一份 */
export async function ensureNodeRecord(
  root: string,
  name = CURRENT_RECORD,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord> {
  const existing = await loadNodeRecord(root, name, io);
  if (existing) return existing;
  try {
    return await saveRecordMarkdown(root, { ...stored(name, "", ""), items: [], links: [] }, recordTemplate(name), io);
  } catch (error) {
    if (error instanceof Error && error.message === "nodeRecord.conflict") {
      const concurrent = await loadNodeRecord(root, name, io);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}

/**
 * 把改好的 Markdown 存回去。record 是改之前读到的那一份：存之前再读一遍文件，
 * 内容和当时不一样了（别处改过、在 Obsidian 里改过）就抛 nodeRecord.conflict，不覆盖。
 */
export async function saveRecordMarkdown(
  root: string,
  record: NodeRecord,
  markdown: string,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord> {
  if (record.path !== recordPath(record.name)) throw new Error("nodeRecord.invalidPath");
  const path = under(root, record.path);
  const write = async () => {
    const current = await io.read(path);
    if ((current === undefined ? "" : fingerprint(current)) !== record.revision) {
      throw new Error("nodeRecord.conflict");
    }
    await io.write(path, markdown);
  };
  await (io.guard ? io.guard(path, write) : write());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(NODE_RECORD_CHANGED_EVENT, { detail: { root, name: record.name } }));
  }
  return parseNodeRecord(stored(record.name, markdown));
}

export function appendRecordMarkdown(
  markdown: string,
  section: RecordSection,
  text: string,
  link?: RecordLink,
  options?: RecordItemOptions,
): string {
  const content = text.replace(/\r\n?/g, "\n");
  if (!content.trim() && !options?.summary?.trim() && !options?.images?.length && !link && !options?.links?.length)
    return markdown;
  const references = uniqueLinks([...(link ? [link] : []), ...(options?.links ?? [])]);
  const reference = references.length ? ` ${references.map(markdownReference).join(" ")}` : "";
  // 问题也带勾选框：没解决的定格时带到下一段，解决了就勾掉
  const checkbox = section === "done" ? "[x] " : "[ ] ";
  const summary =
    options?.summary?.trim() || (!content.trim() && options?.images?.[0] ? imageLabel(options.images[0]) : "");
  const detailLines = content.split("\n");
  const title = summary ? `**${titleMarkdown(summary)}** — ` : "";
  return insertIntoSection(markdown, `## ${titles[section]}`, [
    `- ${checkbox}${title}${detailLines[0]}${reference}`,
    ...detailLines.slice(1).map((line) => `  ${line}`),
    ...(options?.images ?? []).map((image) => `  !${markdownReference(image)}`),
  ]);
}

/** 把几行加到某一节的末尾；这一节还没有就在文末新开 */
function insertIntoSection(markdown: string, heading: string, itemLines: string[]): string {
  const { lines, newline } = markdownLines(markdown);
  const visible = contentLines(lines);
  let start = lines.findIndex((line, index) => visible[index] && line.trim() === heading);
  if (start < 0) {
    while (lines.length > 0 && !lines.at(-1)!.trim()) lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(heading, "");
    start = lines.length - 2;
  }
  let end = lines.findIndex((line, index) => index > start && visible[index] && /^#{1,2}\s/.test(line));
  if (end < 0) end = lines.length;
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  // 标题和第一条之间、最后一条和下一节之间各空一行；文件以换行结尾
  const before = end === start + 1 ? [""] : [];
  const after = end === lines.length ? [""] : lines[end].trim() ? [""] : [];
  lines.splice(end, 0, ...before, ...itemLines, ...after);
  return lines.join(newline);
}

function markdownReference(link: RecordLink): string {
  return `[${link.label.replace(/[[\]\\\r\n]/g, " ").trim()}](<${link.href.replace(/[<>\r\n]/g, encodeURIComponent)}>)`;
}

interface ReferenceToken {
  start: number;
  end: number;
  image: boolean;
  link: RecordLink;
}

function referenceTokens(line: string): ReferenceToken[] {
  // Keep offsets aligned with the source while leaving inline code completely alone.
  const source = maskInlineCode(line);
  const tokens: ReferenceToken[] = [];
  for (const match of source.matchAll(/(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g)) {
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      image: !!match[1],
      link: { label: match[2], href: match[3] ?? match[4] },
    });
  }
  for (const match of source.matchAll(/(!?)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      image: !!match[1],
      link: { label: match[3] ?? (match[1] ? match[2].split("/").at(-1)! : match[2]), href: match[2] },
    });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

function sameReferences(a: RecordLink[], b: RecordLink[]): boolean {
  const left = uniqueLinks(a);
  const right = uniqueLinks(b);
  return (
    left.length === right.length &&
    left.every((link) => right.some((other) => other.href === link.href && other.label === link.label))
  );
}

function validateUpdatedReferences(record: NodeRecord, item: RecordItem, update: RecordItemUpdate): void {
  for (const link of update.links) {
    if (!item.links.some((old) => old.href === link.href) && !resolveRecordLinkPath(record.path, link.href))
      throw new Error("nodeRecord.unsafeLink");
  }
  for (const image of update.images) {
    if (item.images?.some((old) => old.href === image.href)) continue;
    const path = resolveRecordLinkPath(record.path, image.href)?.path;
    if (!path || !/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) throw new Error("nodeRecord.unsafeLink");
  }
}

function replaceSummaryLine(line: string, summary: string): string {
  const bullet = itemLine.exec(line);
  const prefix = bullet?.[1] ?? "";
  const body = bullet?.[3] ?? line;
  const explicit = titledDetail.exec(body);
  const title = titleMarkdown(summary);
  if (explicit && title) return `${prefix}**${title}**${body.slice(explicit[1].length + 4)}`;
  return `${prefix}${title ? `**${title}** — ` : ""}${explicit?.[2] ?? body}`;
}

function replaceReferences(
  line: string,
  links: RecordLink[],
  images: RecordLink[],
  seenLinks: Set<string>,
  seenImages: Set<string>,
  original?: { links: RecordLink[]; images: RecordLink[] },
): string {
  let result = line;
  for (const token of referenceTokens(line).reverse()) {
    const key = referenceKey(token.link);
    const oldReferences = original?.[token.image ? "images" : "links"] ?? [];
    const desired = token.image ? images : links;
    const previous = oldReferences.find((link) => referenceKey(link) === key);
    let retained = desired.find((link) => referenceKey(link) === key);
    if (previous && !retained) {
      // A single removed alias paired with a single new alias for the same file is
      // an unambiguous rename. Several unmatched aliases remain explicit remove/add operations.
      const removed = oldReferences.filter(
        (old) => old.href === token.link.href && !desired.some((next) => referenceKey(next) === referenceKey(old)),
      );
      const added = desired.filter(
        (next) =>
          next.href === token.link.href && !oldReferences.some((old) => referenceKey(old) === referenceKey(next)),
      );
      if (removed.length === 1 && added.length === 1) retained = added[0];
    }
    if (original && !previous) {
      if (retained) (token.image ? seenImages : seenLinks).add(referenceKey(retained));
      continue;
    }
    let replacement: string;
    if (retained) {
      (token.image ? seenImages : seenLinks).add(referenceKey(retained));
      replacement =
        referenceKey(retained) === key
          ? line.slice(token.start, token.end)
          : `${token.image ? "!" : ""}${markdownReference(retained)}`;
    } else {
      // Removing an inline link does not remove words from the user's sentence.
      replacement = token.image ? "" : token.link.label;
    }
    result = result.slice(0, token.start) + replacement + result.slice(token.end);
  }
  return result;
}

function patchRecordRows(
  markdown: string,
  replacements: Map<number, string | null>,
  insertion?: { after: number; lines: string[] },
): string {
  const { newline } = markdownLines(markdown);
  const rawLines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  return rawLines
    .map((raw, index) => {
      const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
      const replacement = replacements.get(index);
      let result = replacement === null ? "" : replacement === undefined ? raw : replacement + ending;
      if (insertion?.after === index && insertion.lines.length) {
        if (result && !result.endsWith("\n")) result += newline;
        result += insertion.lines.join(newline) + (ending || index < rawLines.length - 1 ? newline : "");
      }
      return result;
    })
    .join("");
}

/** Apply edits to the record captured when editing began, never to a later record with the same line number. */
export function updateRecordMarkdownItem(record: NodeRecord, itemId: string, update: RecordItemUpdate): string {
  const parsed = parseRecordSource(record);
  const item = parsed.record.items.find((candidate) => candidate.id === itemId);
  const baseItem = record.items.find((candidate) => candidate.id === itemId);
  const owned = parsed.sourceRows.get(itemId);
  if (
    !item ||
    !baseItem ||
    !owned ||
    item.text !== baseItem.text ||
    item.summary !== baseItem.summary ||
    item.done !== baseItem.done ||
    item.section !== baseItem.section ||
    !sameReferences(item.links, baseItem.links) ||
    !sameReferences(item.images ?? [], baseItem.images ?? [])
  ) {
    throw new Error("nodeRecord.conflict");
  }
  const normalized: RecordItemUpdate = {
    summary: update.summary.replace(/[\r\n]+/g, " ").trim(),
    text: update.text.replace(/\r\n?/g, "\n"),
    links: uniqueLinks(update.links),
    images: uniqueLinks(update.images),
  };
  if (
    normalized.text === item.text &&
    normalized.summary === (item.summary ?? "") &&
    sameReferences(normalized.links, item.links) &&
    sameReferences(normalized.images, item.images ?? [])
  )
    return record.markdown;
  if (!normalized.summary && !normalized.text.trim() && !normalized.links.length && !normalized.images.length)
    throw new Error("nodeRecord.emptyItem");
  const titleReferences = referenceTokens(normalized.summary);
  validateUpdatedReferences(record, item, {
    ...normalized,
    links: [...normalized.links, ...titleReferences.filter((token) => !token.image).map((token) => token.link)],
    images: [...normalized.images, ...titleReferences.filter((token) => token.image).map((token) => token.link)],
  });
  const { lines, newline } = markdownLines(record.markdown);
  const first = owned[0];
  const last = owned.at(-1)!;
  const indentation = /^[ \t]*/.exec(lines[first])![0];
  const continuation = `${indentation}  `;
  const changes = new Map<number, string | null>();
  const seenLinks = new Set<string>();
  const seenImages = new Set<string>();
  const additions = () => [
    ...normalized.links
      .filter((link) => !seenLinks.has(referenceKey(link)))
      .map((link) => `${continuation}${markdownReference(link)}`),
    ...normalized.images
      .filter((image) => !seenImages.has(referenceKey(image)))
      .map((image) => `${continuation}!${markdownReference(image)}`),
  ];
  if (normalized.text === item.text) {
    const visible = contentLines(lines);
    for (const row of owned) {
      if (!visible[row]) continue;
      let line = lines[row];
      if (row === first && (normalized.summary !== (item.summary ?? "") || !item.text))
        line = replaceSummaryLine(line, normalized.summary || item.summary || "");
      line = replaceReferences(line, normalized.links, normalized.images, seenLinks, seenImages, {
        links: item.links,
        images: item.images ?? [],
      });
      if (line !== lines[row]) changes.set(row, line);
    }
    const openCodeFence = !contentLines([...lines.slice(0, last + 1), "record-item-end"]).at(-1);
    return patchRecordRows(record.markdown, changes, { after: openCodeFence ? first : last, lines: additions() });
  }
  // A deliberate detail edit rewrites only this item's owned rows. Unowned comments,
  // front matter and adjacent entries keep their original bytes and line endings.
  const originalPrefix = itemLine.exec(lines[first])?.[1];
  const prefix = originalPrefix ?? `${indentation}- ${item.section === "notes" ? "" : `[${item.done ? "x" : " "}] `}`;
  const detailLines = normalized.text.split("\n");
  const visible = contentLines(detailLines);
  const typed = detailLines.flatMap((line, index) => (visible[index] ? referenceTokens(line) : []));
  validateUpdatedReferences(record, item, {
    ...normalized,
    links: [...normalized.links, ...typed.filter((token) => !token.image).map((token) => token.link)],
    images: [...normalized.images, ...typed.filter((token) => token.image).map((token) => token.link)],
  });
  const rewritten = detailLines.map((line, index) =>
    visible[index]
      ? replaceReferences(line, normalized.links, normalized.images, seenLinks, seenImages, {
          links: item.links,
          images: item.images ?? [],
        })
      : line,
  );
  const summary =
    normalized.summary ||
    (!normalized.text.trim() ? item.summary || imageLabel(normalized.images[0] ?? normalized.links[0]) : "");
  const attachmentLines = additions();
  const openCodeFence = !contentLines([...detailLines, "record-item-end"]).at(-1);
  const content = [
    `${prefix}${summary ? `**${titleMarkdown(summary)}** — ` : ""}${rewritten[0]}`,
    ...(openCodeFence ? attachmentLines : []),
    ...rewritten.slice(1).map((line) => `${continuation}${line}`),
    ...(openCodeFence ? [] : attachmentLines),
  ];
  changes.set(first, content.join(newline));
  owned.slice(1).forEach((row) => changes.set(row, null));
  return patchRecordRows(record.markdown, changes);
}

export async function updateRecordItem(
  root: string,
  record: NodeRecord,
  itemId: string,
  update: RecordItemUpdate,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord> {
  const markdown = updateRecordMarkdownItem(record, itemId, update);
  if (markdown === record.markdown) return record;
  return saveRecordMarkdown(root, record, markdown, io);
}

export function toggleRecordMarkdown(record: NodeRecord, itemId: string, done: boolean): string {
  const item = parseNodeRecord(record).items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("nodeRecord.conflict");
  const { lines, newline } = markdownLines(record.markdown);
  const index = Number(itemId.slice("line:".length));
  const line = lines[index];
  const checkbox = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/;
  if (checkbox.test(line)) lines[index] = line.replace(checkbox, `$1[${done ? "x" : " "}]`);
  else {
    const bullet = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)(.*)$/.exec(line);
    lines[index] = bullet ? `${bullet[1]}[${done ? "x" : " "}] ${bullet[2]}` : `- [${done ? "x" : " "}] ${line}`;
  }
  return lines.join(newline);
}

export async function appendRecordItem(
  root: string,
  record: NodeRecord,
  section: RecordSection,
  text: string,
  link?: RecordLink,
  options?: RecordItemOptions,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord> {
  for (const reference of [...(link ? [link] : []), ...(options?.links ?? [])]) {
    if (!resolveRecordLinkPath(record.path, reference.href)) throw new Error("nodeRecord.unsafeLink");
  }
  for (const image of options?.images ?? []) {
    const resolved = resolveRecordLinkPath(record.path, image.href);
    if (!resolved || !/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(resolved.path)) throw new Error("nodeRecord.unsafeLink");
  }
  return saveRecordMarkdown(root, record, appendRecordMarkdown(record.markdown, section, text, link, options), io);
}

export function updateRecordMarkdownSummary(record: NodeRecord, itemId: string, summary: string): string {
  const item = parseNodeRecord(record).items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("nodeRecord.conflict");
  const { lines, newline } = markdownLines(record.markdown);
  const index = Number(itemId.slice("line:".length));
  const bullet = itemLine.exec(lines[index]);
  const prefix = bullet?.[1] ?? "";
  const body = bullet?.[3] ?? lines[index];
  const explicit = titledDetail.exec(body);
  const originalDetail = explicit?.[2] ?? body;
  const title = titleMarkdown(summary);
  lines[index] =
    explicit && title
      ? `${prefix}**${title}**${body.slice(explicit[1].length + 4)}`
      : `${prefix}${title ? `**${title}** — ` : ""}${originalDetail}`;
  return lines.join(newline);
}

export function updateRecordItemSummary(
  root: string,
  record: NodeRecord,
  itemId: string,
  summary: string,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord> {
  return saveRecordMarkdown(root, record, updateRecordMarkdownSummary(record, itemId, summary), io);
}

export function setRecordItemDone(
  root: string,
  record: NodeRecord,
  itemId: string,
  done: boolean,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord> {
  return saveRecordMarkdown(root, record, toggleRecordMarkdown(record, itemId, done), io);
}

/** 一节里显示哪些：做完的待办、下一步算进「进展」，别的各归各 */
export function sectionItems(record: NodeRecord | null, section: RecordSection): RecordItem[] {
  return (record?.items ?? []).filter((item) => {
    const finished = (item.section === "todo" || item.section === "next") && item.done;
    if (section === "done") return item.section === "done" || finished;
    return item.section === section && !finished;
  });
}

// —— 定格时封存 ——

// 认「同一条」看内容；自动提炼出来的标题会跟着它在哪一节变，不能拿来认。只有标题、没有内容的才看标题
export const recordItemKey = (item: RecordItem) => {
  const text = item.text.replace(/\s+/g, " ").trim();
  return text || `标题：${(item.summary ?? "").trim()}`;
};

/** 第一行换成没勾的勾选框（「下一步」里的变成待办时用） */
function unchecked(line: string): string {
  const bullet = itemLine.exec(line);
  if (!bullet) return `- [ ] ${line.trim()}`;
  const marker = bullet[1].replace(/\[[ xX]\][ \t]+$/, "");
  return `${marker}[ ] ${bullet[3]}`;
}

/**
 * 定格一个节点时，手填的记录怎么分：
 *   sealed 是封存进这个节点的那一份——第一次定格就是「进行中」的全部内容；
 *          同一个节点再定格（before 是上一次封存的），按事项逐条补：原来有的更新勾没勾，新记的加进去，不丢不重复。
 *   next   是新的「进行中」——没勾的待办、没勾的问题带过去，「下一步」里的变成待办；做完的、没带勾选框的留在封存里。
 * 认「同一条」看的是标题和内容，不看它在哪一节（「下一步」带过去以后是在「待办」里）。
 */
export function sealMarkdown(
  current: string,
  before: string | undefined,
  title: string,
): { sealed: string; next: string } {
  const source = parseRecordSource(stored(CURRENT_RECORD, current));
  const { lines, newline } = markdownLines(current);
  const rowsOf = (item: RecordItem) => source.sourceRows.get(item.id)!;
  const blockOf = (item: RecordItem) => rowsOf(item).map((row) => lines[row]);
  const { items } = source.record;

  let sealed: string;
  if (before === undefined) {
    const heading = lines.findIndex((line) => line.trim() === recordHeading(CURRENT_RECORD));
    sealed = heading < 0 ? current : lines.with(heading, recordHeading(title)).join(newline);
  } else {
    sealed = before;
    for (const item of items) {
      const known = parseNodeRecord(stored(title, sealed));
      const same = known.items.find((candidate) => recordItemKey(candidate) === recordItemKey(item));
      if (!same) sealed = insertIntoSection(sealed, `## ${titles[item.section]}`, blockOf(item));
      else if (same.done !== item.done) sealed = toggleRecordMarkdown(known, same.id, item.done);
    }
    // 不属于哪一条事项的零散的字：归到「其他」一节，免得换新的一份时丢掉
    const owned = new Set(items.flatMap(rowsOf));
    const visible = contentLines(lines);
    const headings = new Set([recordHeading(CURRENT_RECORD), ...Object.values(titles).map((name) => `## ${name}`)]);
    const loose = lines.filter(
      (line, row) => visible[row] && !owned.has(row) && line.trim() !== "" && !headings.has(line.trim()),
    );
    const kept = new Set(markdownLines(sealed).lines.map((line) => line.trim()));
    const fresh = loose.filter((line) => !kept.has(line.trim()));
    // 自己带着小标题的照原样接在文末，没有的归到「其他」
    if (fresh.length > 0) {
      sealed = /^#{1,6}\s/.test(fresh[0])
        ? `${sealed.replace(/\s+$/, "")}${newline}${newline}${fresh.join(newline)}${newline}`
        : insertIntoSection(sealed, `## ${LOOSE_TITLE}`, fresh);
    }
  }

  let next = recordTemplate(CURRENT_RECORD);
  // 同一句话记了两遍的（比如「下一步」里写的和一条带过来的待办一样）：带过去一条就够
  const carried = new Set<string>();
  for (const item of items) {
    if (item.done) continue;
    const first = itemLine.exec(lines[rowsOf(item)[0]]);
    const open = first?.[2] === " ";
    if (item.section === "done" || (item.section === "notes" && !open)) continue;
    const key = recordItemKey(item);
    if (carried.has(key)) continue;
    carried.add(key);
    const block = blockOf(item);
    next =
      item.section === "next"
        ? insertIntoSection(next, `## ${titles.todo}`, [unchecked(block[0]), ...block.slice(1)])
        : insertIntoSection(next, `## ${titles[item.section]}`, block);
  }
  return { sealed, next };
}

/**
 * 这个节点现在定格的话，封存的那份里会有哪些事项。只算、不写文件，整理时列清单用。
 * current 是「进行中」，before 是这个节点今天已经封存过的那一份；两份都没有东西给 undefined。
 */
export function previewSealed(
  current: NodeRecord | null,
  before: NodeRecord | null,
  title: string,
): NodeRecord | undefined {
  if (!current || current.items.length === 0) return before ?? undefined;
  return parseNodeRecord(stored(title, sealMarkdown(current.markdown, before?.markdown, title).sealed));
}

/**
 * 定格一个节点以后调：把「进行中」封存成这个节点的那一份，换上新的「进行中」。
 * 「进行中」里一条事项都没有时什么都不做。返回封存的那份；没封存给 undefined。
 * 先写封存的、再换「进行中」：第二步没成的话东西都还在，下次定格会接着补，不会丢。
 */
export async function sealNodeRecord(
  root: string,
  title: string,
  io: RecordFiles = desktopFiles,
): Promise<NodeRecord | undefined> {
  const current = await loadNodeRecord(root, CURRENT_RECORD, io);
  if (!current || current.items.length === 0) return undefined;
  const before = await loadNodeRecord(root, title, io);
  const { sealed, next } = sealMarkdown(current.markdown, before?.markdown, title);
  const saved = await saveRecordMarkdown(
    root,
    before ?? { ...stored(title, "", ""), items: [], links: [] },
    sealed,
    io,
  );
  await saveRecordMarkdown(root, current, next, io);
  return saved;
}

/** Resolve only an exact, note-relative path; never scan the project for similarly named files. */
export function resolveRecordLinkPath(
  recordPath: string,
  href: string,
): { path: string; fragment?: string } | undefined {
  const source = href.trim();
  const hash = source.indexOf("#");
  let target: string;
  let fragment: string | undefined;
  try {
    target = decodeURIComponent(hash < 0 ? source : source.slice(0, hash));
    fragment = hash < 0 ? undefined : decodeURIComponent(source.slice(hash + 1));
  } catch {
    return undefined;
  }
  const hasControl = (value: string) =>
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (
    !source ||
    /^[\\/]/.test(target) ||
    /[\\:]/.test(target) ||
    hasControl(target) ||
    (fragment && hasControl(fragment))
  )
    return undefined;
  const parts = recordPath.split("/");
  if (target) {
    parts.pop();
    for (const part of target.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") {
        if (!parts.length) return undefined;
        parts.pop();
      } else {
        if (/[<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
          return undefined;
        parts.push(part);
      }
    }
  }
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return { path: parts.join("/"), ...(fragment ? { fragment } : {}) };
}

/** Display text only: use the original href, never this label, when navigating. */
export function displayRecordLink(recordPath: string, href: string): string {
  const resolved = resolveRecordLinkPath(recordPath, href);
  if (!resolved) {
    try {
      return decodeURIComponent(href);
    } catch {
      return href;
    }
  }
  if (!resolved.fragment) return resolved.path;
  const page = /^page=(\d+)$/i.exec(resolved.fragment);
  if (page) return `${resolved.path} · 第 ${Number(page[1])} 页`;
  const node = /^node=(.+)$/.exec(resolved.fragment);
  return `${resolved.path} · ${node ? `节点 ${node[1]}` : `#${resolved.fragment}`}`;
}

export async function resolveRecordLink(
  root: string,
  record: NodeRecord,
  link: RecordLink,
): Promise<{ path: string; relativePath: string; fragment?: string }> {
  const resolved = resolveRecordLinkPath(record.path, link.href);
  if (!resolved) throw new Error("nodeRecord.unsafeLink");
  const [{ ResearchFolder }, { exists }] = await Promise.all([
    import("./ResearchFolder"),
    import("@tauri-apps/plugin-fs"),
  ]);
  // 只认项目文件夹里面、真的在的文件
  const path = ResearchFolder.toAbsolute(resolved.path, root);
  if (!ResearchFolder.isInside(path, root) || !(await exists(path))) throw new Error("nodeRecord.fileNotFound");
  return { path, relativePath: resolved.path, fragment: resolved.fragment };
}

export async function openRecordLink(root: string, record: NodeRecord, link: RecordLink): Promise<void> {
  const { path, relativePath, fragment } = await resolveRecordLink(root, record, link);
  if (/\.prg$/i.test(path)) {
    // 白板和卡片走报告链接的那条路：打开白板、镜头对到卡片，卡片不在了会提示
    const [{ recordLink }, { followReportLink }] = await Promise.all([
      import("./ReportTools"),
      import("./ReportLinks"),
    ]);
    const card = fragment?.startsWith("node=") ? fragment.slice("node=".length) : undefined;
    await followReportLink(recordLink(root, { board: relativePath, ...(card && { card }) })!);
    return;
  }
  if (!/\.(md|markdown|pdf|png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) throw new Error("nodeRecord.unsafeLink");
  const { openDocumentFile } = await import("./DocumentTab");
  const page = /^page=(\d+)$/i.exec(fragment ?? "");
  await openDocumentFile(
    path,
    /\.pdf$/i.test(path) ? { pdf: { page: page ? Math.max(1, Number(page[1])) : 1 } } : { heading: fragment },
  );
}

export async function currentContextLink(root: string, record: NodeRecord): Promise<RecordLink | undefined> {
  const [{ store, activeResourceTabAtom }, { DocumentTab }, { Project }, { ResearchFolder }, { parseOutline }] =
    await Promise.all([
      import("@/state"),
      import("./DocumentTab"),
      import("@/core/Project"),
      import("./ResearchFolder"),
      import("./NoteHeadings"),
    ]);
  const active = store.get(activeResourceTabAtom);
  let path: string;
  let fragment = "";
  let label: string;
  if (active instanceof DocumentTab) {
    path = active.path;
    label = active.title;
    if (active.kind === "pdf") {
      fragment = `page=${active.pdfLocation.page}`;
      label += ` · p.${active.pdfLocation.page}`;
    } else if (active.markdown && active.outlinePosition) {
      const outline = parseOutline(active.markdown.text);
      const position = active.outlinePosition;
      const heading =
        "index" in position ? outline[position.index] : outline.filter((item) => item.line <= position.line).at(-1);
      if (heading) {
        fragment = heading.text;
        label += ` · ${heading.text}`;
      }
    }
  } else if (active instanceof Project && active.uri.scheme === "file") {
    path = active.uri.fsPath;
    label = active.title;
    const selected = active.stageManager.getSelectedEntities()[0];
    if (selected) {
      fragment = `node=${selected.uuid}`;
      // 选中了卡片：链接叫卡片上的字，比叫白板的文件名看得懂
      const words = "text" in selected && typeof selected.text === "string" ? selected.text.trim().split("\n")[0] : "";
      if (words) label = words.length > 30 ? `${words.slice(0, 30)}…` : words;
    }
  } else return undefined;
  if (!ResearchFolder.isInside(path, root)) return undefined;
  const directory = ResearchFolder.toAbsolute(record.path.split("/").slice(0, -1).join("/"), root);
  const href =
    ResearchFolder.toRelative(path, directory).split("/").map(encodeURIComponent).join("/") +
    (fragment ? `#${encodeURIComponent(fragment)}` : "");
  const link = { label, href };
  await resolveRecordLink(root, record, link);
  return link;
}
