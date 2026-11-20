import { invoke } from "@tauri-apps/api/core";

export type WeeklySection = "done" | "todo" | "notes" | "next";
export interface WeeklyLink {
  label: string;
  href: string;
}
export interface WeeklyItem {
  id: string;
  section: WeeklySection;
  text: string;
  summary?: string;
  done: boolean;
  links: WeeklyLink[];
  images?: WeeklyLink[];
}
export interface WeeklyItemOptions {
  summary?: string;
  images?: WeeklyLink[];
  links?: WeeklyLink[];
}
export interface WeeklyItemUpdate {
  summary: string;
  text: string;
  links: WeeklyLink[];
  images: WeeklyLink[];
}
export interface WeeklyRecord {
  weekStart: string;
  path: string;
  markdown: string;
  revision: string;
  items: WeeklyItem[];
  links: WeeklyLink[];
}

type StoredWeeklyRecord = Omit<WeeklyRecord, "items" | "links">;
export const WEEKLY_PROGRESS_CHANGED_EVENT = "research:weekly-progress-changed";
export const WEEKLY_PROGRESS_DIRECTORY = "进展记录/周进展";
const titles: Record<WeeklySection, string> = {
  done: "本周进展",
  todo: "待办事项",
  notes: "问题与决定",
  next: "下周方向",
};

export function weekStartDate(date = new Date()): string {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}

function validateWeek(week: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error("weekly.invalidWeek");
  const date = new Date(`${week}T12:00:00`);
  if (!Number.isFinite(date.getTime()) || weekStartDate(date) !== week) throw new Error("weekly.invalidWeek");
}

export function weeklyRecordTemplate(week: string): string {
  validateWeek(week);
  return `# 周进展 · ${week}\n\n${Object.values(titles)
    .map((title) => `## ${title}\n\n`)
    .join("")}## 详细记录\n`;
}

async function command<T>(name: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

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

function inlineLinks(text: string): WeeklyLink[] {
  const links: WeeklyLink[] = [];
  const source = maskInlineCode(text);
  for (const match of source.matchAll(/(?<!!)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g)) {
    links.push({ label: match[1], href: match[2] ?? match[3] });
  }
  for (const match of source.matchAll(/(?<!!)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
    links.push({ label: match[2] ?? match[1], href: match[1] });
  }
  return links;
}

function inlineImages(text: string): WeeklyLink[] {
  const links: WeeklyLink[] = [];
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
export function summarizeWeeklyItem(text: string, section: WeeklySection): string {
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

function imageLabel(image: WeeklyLink): string {
  let name = image.label || image.href.split("/").at(-1) || "";
  try {
    name = decodeURIComponent(name);
  } catch {
    return name;
  }
  return name;
}

function referenceKey(link: WeeklyLink): string {
  return JSON.stringify([link.href, link.label]);
}

function uniqueLinks(links: WeeklyLink[]): WeeklyLink[] {
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

function parseWeeklySource(record: StoredWeeklyRecord): { record: WeeklyRecord; sourceRows: Map<string, number[]> } {
  const { lines } = markdownLines(record.markdown);
  const items: WeeklyItem[] = [];
  const links: WeeklyLink[] = [];
  let section: WeeklySection | undefined;
  const sourceRows = new Map<string, number[]>();
  let previous: { item: WeeklyItem; indent: number; blankLines: number[] } | undefined;
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
      section = (Object.keys(titles) as WeeklySection[]).find((key) => titles[key] === heading[1]);
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
    const item: WeeklyItem = {
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
      summarizeWeeklyItem(item.text, item.section) || (item.images?.[0] ? imageLabel(item.images[0]) : "");
    item.links = uniqueLinks(item.links);
    item.images = uniqueLinks(item.images ?? []);
  });
  return { record: { ...record, items, links: uniqueLinks(links) }, sourceRows };
}

/** Unknown sections and prose remain in the original Markdown; the panel is only a concise view. */
export function parseWeeklyRecord(record: StoredWeeklyRecord): WeeklyRecord {
  return parseWeeklySource(record).record;
}

export async function listWeeklyRecords(root: string): Promise<WeeklyRecord[]> {
  return (await command<StoredWeeklyRecord[]>("list_weekly_progress", { root })).map(parseWeeklyRecord);
}

export async function loadWeeklyRecord(root: string, weekStart: string): Promise<WeeklyRecord | null> {
  validateWeek(weekStart);
  const record = await command<StoredWeeklyRecord | null>("load_weekly_progress", { root, weekStart });
  return record ? parseWeeklyRecord(record) : null;
}

export async function ensureWeeklyRecord(root: string, weekStart: string): Promise<WeeklyRecord> {
  const existing = await loadWeeklyRecord(root, weekStart);
  if (existing) return existing;
  try {
    return await saveWeeklyMarkdown(
      root,
      {
        weekStart,
        path: `${WEEKLY_PROGRESS_DIRECTORY}/${weekStart}.md`,
        markdown: "",
        revision: "",
        items: [],
        links: [],
      },
      weeklyRecordTemplate(weekStart),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "weekly.conflict") {
      const concurrent = await loadWeeklyRecord(root, weekStart);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}

export async function saveWeeklyMarkdown(root: string, record: WeeklyRecord, markdown: string): Promise<WeeklyRecord> {
  validateWeek(record.weekStart);
  if (record.path !== `${WEEKLY_PROGRESS_DIRECTORY}/${record.weekStart}.md`) throw new Error("weekly.invalidPath");
  const [{ DocumentTab }, { documentKey }, { store, tabsAtom }, { ResearchFolder, notifyResearchFilesChanged }] =
    await Promise.all([
      import("./DocumentTab"),
      import("./DocumentFile"),
      import("@/state"),
      import("./ResearchFolder"),
    ]);
  const key = documentKey(ResearchFolder.toAbsolute(record.path, root));
  const opened = store
    .get(tabsAtom)
    .filter(
      (tab): tab is InstanceType<typeof DocumentTab> => tab instanceof DocumentTab && documentKey(tab.path) === key,
    );
  if (opened.some((tab) => tab.hasUnsavedChanges || tab.saving || tab.loadingMarkdown || tab.closing)) {
    throw new Error("weekly.documentBusy");
  }
  // Reserve clean editors during the write so a simultaneous Ctrl+S cannot race it.
  opened.forEach((tab) => {
    tab.loadingMarkdown = true;
    tab.changed();
  });
  let saved: WeeklyRecord;
  try {
    saved = parseWeeklyRecord(
      await command<StoredWeeklyRecord>("save_weekly_progress", {
        root,
        weekStart: record.weekStart,
        markdown,
        expectedRevision: record.revision || null,
      }),
    );
  } finally {
    opened.forEach((tab) => {
      tab.loadingMarkdown = false;
      tab.changed();
    });
  }
  // loadMarkdown also checks for edits made while its asynchronous read is in flight.
  await Promise.all(opened.filter((tab) => !tab.hasUnsavedChanges).map((tab) => tab.loadMarkdown(true)));
  notifyResearchFilesChanged();
  window.dispatchEvent(
    new CustomEvent(WEEKLY_PROGRESS_CHANGED_EVENT, { detail: { root, weekStart: saved.weekStart } }),
  );
  return saved;
}

export function appendWeeklyMarkdown(
  markdown: string,
  section: WeeklySection,
  text: string,
  link?: WeeklyLink,
  options?: WeeklyItemOptions,
): string {
  const content = text.replace(/\r\n?/g, "\n");
  if (!content.trim() && !options?.summary?.trim() && !options?.images?.length && !link && !options?.links?.length)
    return markdown;
  const { lines, newline } = markdownLines(markdown);
  const visible = contentLines(lines);
  const heading = `## ${titles[section]}`;
  let start = lines.findIndex((line, index) => visible[index] && line.trim() === heading);
  if (start < 0) {
    if (lines.at(-1)?.trim()) lines.push("");
    lines.push(heading, "");
    start = lines.length - 2;
  }
  let end = lines.findIndex((line, index) => index > start && visible[index] && /^#{1,2}\s/.test(line));
  if (end < 0) end = lines.length;
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  const references = uniqueLinks([...(link ? [link] : []), ...(options?.links ?? [])]);
  const reference = references.length ? ` ${references.map(markdownReference).join(" ")}` : "";
  const checkbox = section === "done" ? "[x] " : section === "todo" || section === "next" ? "[ ] " : "";
  const summary =
    options?.summary?.trim() || (!content.trim() && options?.images?.[0] ? imageLabel(options.images[0]) : "");
  const detailLines = content.split("\n");
  const title = summary ? `**${titleMarkdown(summary)}** — ` : "";
  const itemLines = [
    `- ${checkbox}${title}${detailLines[0]}${reference}`,
    ...detailLines.slice(1).map((line) => `  ${line}`),
    ...(options?.images ?? []).map((image) => `  !${markdownReference(image)}`),
  ];
  lines.splice(end, 0, ...itemLines);
  return lines.join(newline);
}

function markdownReference(link: WeeklyLink): string {
  return `[${link.label.replace(/[[\]\\\r\n]/g, " ").trim()}](<${link.href.replace(/[<>\r\n]/g, encodeURIComponent)}>)`;
}

interface ReferenceToken {
  start: number;
  end: number;
  image: boolean;
  link: WeeklyLink;
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

function sameReferences(a: WeeklyLink[], b: WeeklyLink[]): boolean {
  const left = uniqueLinks(a);
  const right = uniqueLinks(b);
  return (
    left.length === right.length &&
    left.every((link) => right.some((other) => other.href === link.href && other.label === link.label))
  );
}

function validateUpdatedReferences(record: WeeklyRecord, item: WeeklyItem, update: WeeklyItemUpdate): void {
  for (const link of update.links) {
    if (!item.links.some((old) => old.href === link.href) && !resolveWeeklyLinkPath(record.path, link.href))
      throw new Error("weekly.unsafeLink");
  }
  for (const image of update.images) {
    if (item.images?.some((old) => old.href === image.href)) continue;
    const path = resolveWeeklyLinkPath(record.path, image.href)?.path;
    if (!path || !/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) throw new Error("weekly.unsafeLink");
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
  links: WeeklyLink[],
  images: WeeklyLink[],
  seenLinks: Set<string>,
  seenImages: Set<string>,
  original?: { links: WeeklyLink[]; images: WeeklyLink[] },
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

function patchWeeklyRows(
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
export function updateWeeklyMarkdownItem(record: WeeklyRecord, itemId: string, update: WeeklyItemUpdate): string {
  const parsed = parseWeeklySource(record);
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
    throw new Error("weekly.conflict");
  }
  const normalized: WeeklyItemUpdate = {
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
    throw new Error("weekly.emptyItem");
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
    const openCodeFence = !contentLines([...lines.slice(0, last + 1), "weekly-item-end"]).at(-1);
    return patchWeeklyRows(record.markdown, changes, { after: openCodeFence ? first : last, lines: additions() });
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
  const openCodeFence = !contentLines([...detailLines, "weekly-item-end"]).at(-1);
  const content = [
    `${prefix}${summary ? `**${titleMarkdown(summary)}** — ` : ""}${rewritten[0]}`,
    ...(openCodeFence ? attachmentLines : []),
    ...rewritten.slice(1).map((line) => `${continuation}${line}`),
    ...(openCodeFence ? [] : attachmentLines),
  ];
  changes.set(first, content.join(newline));
  owned.slice(1).forEach((row) => changes.set(row, null));
  return patchWeeklyRows(record.markdown, changes);
}

export async function updateWeeklyItem(
  root: string,
  record: WeeklyRecord,
  itemId: string,
  update: WeeklyItemUpdate,
): Promise<WeeklyRecord> {
  const markdown = updateWeeklyMarkdownItem(record, itemId, update);
  if (markdown === record.markdown) return record;
  return saveWeeklyMarkdown(root, record, markdown);
}

export function toggleWeeklyMarkdown(record: WeeklyRecord, itemId: string, done: boolean): string {
  const item = parseWeeklyRecord(record).items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("weekly.conflict");
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

export async function appendWeeklyItem(
  root: string,
  record: WeeklyRecord,
  section: WeeklySection,
  text: string,
  link?: WeeklyLink,
  options?: WeeklyItemOptions,
): Promise<WeeklyRecord> {
  for (const reference of [...(link ? [link] : []), ...(options?.links ?? [])]) {
    if (!resolveWeeklyLinkPath(record.path, reference.href)) throw new Error("weekly.unsafeLink");
  }
  for (const image of options?.images ?? []) {
    const resolved = resolveWeeklyLinkPath(record.path, image.href);
    if (!resolved || !/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(resolved.path)) throw new Error("weekly.unsafeLink");
  }
  return saveWeeklyMarkdown(root, record, appendWeeklyMarkdown(record.markdown, section, text, link, options));
}

export function updateWeeklyMarkdownSummary(record: WeeklyRecord, itemId: string, summary: string): string {
  const item = parseWeeklyRecord(record).items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("weekly.conflict");
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

export function updateWeeklyItemSummary(
  root: string,
  record: WeeklyRecord,
  itemId: string,
  summary: string,
): Promise<WeeklyRecord> {
  return saveWeeklyMarkdown(root, record, updateWeeklyMarkdownSummary(record, itemId, summary));
}

export function setWeeklyItemDone(
  root: string,
  record: WeeklyRecord,
  itemId: string,
  done: boolean,
): Promise<WeeklyRecord> {
  return saveWeeklyMarkdown(root, record, toggleWeeklyMarkdown(record, itemId, done));
}

/** Resolve only an exact, note-relative path; never scan the project for similarly named files. */
export function resolveWeeklyLinkPath(
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
export function displayWeeklyLink(recordPath: string, href: string): string {
  const resolved = resolveWeeklyLinkPath(recordPath, href);
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

export async function resolveWeeklyLink(
  root: string,
  record: WeeklyRecord,
  link: WeeklyLink,
): Promise<{ path: string; relativePath: string; fragment?: string }> {
  const resolved = resolveWeeklyLinkPath(record.path, link.href);
  if (!resolved) throw new Error("weekly.unsafeLink");
  const path = await command<string>("resolve_weekly_progress_link", { root, path: resolved.path });
  return { path, relativePath: resolved.path, fragment: resolved.fragment };
}

export async function openWeeklyLink(root: string, record: WeeklyRecord, link: WeeklyLink): Promise<void> {
  const { path, fragment } = await resolveWeeklyLink(root, record, link);
  if (/\.prg$/i.test(path)) {
    const [{ openResearchWorkspace }, { Project }, { documentKey }, { store, tabsAtom }] = await Promise.all([
      import("./ResearchSession"),
      import("@/core/Project"),
      import("./DocumentFile"),
      import("@/state"),
    ]);
    await openResearchWorkspace(path);
    if (fragment?.startsWith("node=")) {
      const project = store
        .get(tabsAtom)
        .find(
          (tab): tab is InstanceType<typeof Project> =>
            tab instanceof Project && documentKey(tab.uri.fsPath) === documentKey(path),
        );
      const node = project?.stageManager.getEntities().find((entity) => entity.uuid === fragment.slice(5));
      if (!node || !project) throw new Error("weekly.fileNotFound");
      project.camera.location = node.collisionBox.getRectangle().center;
      project.stageManager.getSelectedEntities().forEach((entity) => {
        entity.isSelected = false;
      });
      node.isSelected = true;
    }
    return;
  }
  if (!/\.(md|markdown|pdf|png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) throw new Error("weekly.unsafeLink");
  const { openDocumentFile } = await import("./DocumentTab");
  const page = /^page=(\d+)$/i.exec(fragment ?? "");
  await openDocumentFile(
    path,
    /\.pdf$/i.test(path) ? { pdf: { page: page ? Math.max(1, Number(page[1])) : 1 } } : { heading: fragment },
  );
}

export async function currentWeeklyContextLink(root: string, record: WeeklyRecord): Promise<WeeklyLink | undefined> {
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
    if (selected) fragment = `node=${selected.uuid}`;
  } else return undefined;
  if (!ResearchFolder.isInside(path, root)) return undefined;
  const directory = ResearchFolder.toAbsolute(record.path.split("/").slice(0, -1).join("/"), root);
  const href =
    ResearchFolder.toRelative(path, directory).split("/").map(encodeURIComponent).join("/") +
    (fragment ? `#${encodeURIComponent(fragment)}` : "");
  const link = { label, href };
  await resolveWeeklyLink(root, record, link);
  return link;
}
