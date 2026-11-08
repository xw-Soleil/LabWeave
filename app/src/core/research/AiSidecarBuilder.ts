import type { FileKind } from "@/core/research/ResearchShell";
import { FILE_KIND_EXTENSIONS, fileKindOf } from "@/core/research/ResearchShell";

export const RESEARCH_SIDECAR_SCHEMA = "research-workbench.sidecar/1";

/** 世界坐标，左上角 + 宽高 */
export interface ResearchSidecarRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResearchSidecarCard {
  id: string;
  /** 序列化类名（`_` 字段），例如 TextNode、FileCardNode、UrlNode、ImageNode */
  type: string;
  title: string;
  text: string;
  /** 用户备注（details）摊平成的纯文本 */
  notes: string;
  /** 只有 FileCardNode 有；path 相对工作区 .prg 所在文件夹 */
  file?: { path: string; kind: FileKind; pages: number };
  url?: string;
  rect: ResearchSidecarRect;
  /** 直接所在的 Section */
  sectionId?: string;
  /** CSS 颜色字符串，透明时为 null */
  color: string | null;
}

export interface ResearchSidecarSection {
  id: string;
  title: string;
  /** 直接子对象的 id */
  children: string[];
  /** 用户备注（details）摊平成的纯文本 */
  notes: string;
  rect: ResearchSidecarRect;
  /** 直接所在的上级 Section */
  sectionId?: string;
  color: string | null;
}

export interface ResearchSidecarEdge {
  id: string;
  /** 序列化类名，例如 LineEdge、CubicCatmullRomSplineEdge */
  type: string;
  from: string;
  to: string;
  label: string;
  lineType?: string;
  arrowType?: string;
}

export interface ResearchSidecarHyperedge {
  id: string;
  members: string[];
  label: string;
}

export interface ResearchSidecarTag {
  /** 被打标签的对象 id */
  id: string;
  title: string;
}

export interface ResearchSidecar {
  schema: typeof RESEARCH_SIDECAR_SCHEMA;
  workspace: {
    /** 工作区文件名（不含目录） */
    file: string;
    /** 工作区 id，来自 .prg 元数据；旧文件没有时为 "" */
    id: string;
    /** ISO 8601 时间 */
    savedAt: string;
    prgVersion: string;
  };
  cards: ResearchSidecarCard[];
  sections: ResearchSidecarSection[];
  edges: ResearchSidecarEdge[];
  hyperedges: ResearchSidecarHyperedge[];
  tags: ResearchSidecarTag[];
}

type SerializedObject = Record<string, unknown> & { _: string };

const HYPEREDGE_TYPES = new Set(["MultiTargetUndirectedEdge"]);
/** 涂鸦没有文字；同步关联只是编辑辅助，不是用户画的关系 */
const SKIPPED_TYPES = new Set(["PenStroke", "SyncAssociation"]);

const TYPE_LABELS: Record<string, string> = {
  TextNode: "文本",
  FileCardNode: "文件",
  UrlNode: "链接",
  ImageNode: "图片",
  LatexNode: "公式",
  ReferenceBlockNode: "引用",
  MediaNode: "音视频",
  SvgNode: "SVG",
  ConnectPoint: "连接点",
  ExtensionEntity: "扩展",
  Section: "分组",
};

const FILE_KIND_LABELS: Record<FileKind, string> = {
  pdf: "PDF",
  image: "图片",
  markdown: "Markdown",
};

const TITLE_MAX_LENGTH = 120;
const MARKDOWN_SUMMARY_MAX_LENGTH = 200;
const MARKDOWN_NOTES_MAX_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedObject(value: unknown): value is SerializedObject {
  return isRecord(value) && typeof value._ === "string";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 和 @graphif/serializer 里没导出的 getByPath 用同一套路径规则（"/0/children/1"），找不到时返回 undefined */
function getByPath(root: unknown, path: string): unknown {
  let result = root;
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    if (typeof result !== "object" || result === null) return undefined;
    result = (result as Record<string, unknown>)[segment];
  }
  return result;
}

/**
 * 解开序列化器的 {$: path} 回指。
 * 序列化器的 replaceRef 会原地改写输入，这里只读：Project 保存时同一份数组还要编码进 .prg。
 */
function deref(root: unknown[], value: unknown): unknown {
  let current = value;
  // 回指指向对象第一次完整出现的位置，正常一跳就到；限制跳数，防止损坏的文件里有环
  for (let hops = 0; hops < 16 && isRecord(current) && typeof current.$ === "string"; hops++) {
    current = getByPath(root, current.$);
  }
  return current;
}

/** Plate 的 details：块之间换行，块内把 text 叶子拼起来 */
export function plateToPlainText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  const lines: string[] = [];
  const inlineText = (children: unknown[]): string =>
    children
      .map((child) => {
        if (!isRecord(child)) return "";
        if (typeof child.text === "string") return child.text;
        return Array.isArray(child.children) ? inlineText(child.children) : "";
      })
      .join("");
  const walkBlock = (node: unknown) => {
    if (!isRecord(node)) return;
    if (!Array.isArray(node.children)) {
      if (typeof node.text === "string") lines.push(node.text);
      return;
    }
    // Slate 约定：一个元素的子节点要么全是块，要么全是行内内容（文字叶子 + 链接等行内元素）
    const isInlineContent = node.children.some((child) => isRecord(child) && typeof child.text === "string");
    if (isInlineContent) lines.push(inlineText(node.children));
    else node.children.forEach(walkBlock);
  };
  value.forEach(walkBlock);
  return lines.join("\n").trim();
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function isAbsolutePath(posixPath: string): boolean {
  return posixPath.startsWith("/") || /^[a-zA-Z]:\//.test(posixPath);
}

function baseName(path: string): string {
  const posix = toPosix(path).replace(/\/+$/, "");
  return posix.slice(posix.lastIndexOf("/") + 1);
}

function dirName(path: string): string {
  const posix = toPosix(path);
  const index = posix.lastIndexOf("/");
  return index < 0 ? "" : posix.slice(0, index);
}

/** 绝对路径的比较基准：都是 POSIX + NFC、没有末尾 /；不是绝对路径时为 "" */
interface PathScope {
  /** 工作区 .prg 所在的文件夹 */
  workspaceDir: string;
  researchRoot: string;
}

function normalizedDir(dir: string): string {
  const posix = toPosix(dir).normalize("NFC").replace(/\/+$/, "");
  return isAbsolutePath(posix) ? posix : "";
}

function isUnder(path: string, dir: string): boolean {
  return dir !== "" && path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
}

function relativeTo(dir: string, path: string): string {
  const from = dir.split("/").filter(Boolean);
  const to = path.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common].toLowerCase() === to[common].toLowerCase()) {
    common++;
  }
  return [...Array<string>(from.length - common).fill(".."), ...to.slice(common)].join("/");
}

/**
 * 绝对路径改成相对工作区 .prg 所在文件夹的路径（同在研究文件夹里时可以带 ../）；
 * 研究文件夹外的绝对路径只留文件名，免得把用户的目录结构交给 AI
 */
function shareablePath(path: string, scope: PathScope): string {
  const posix = toPosix(path).normalize("NFC");
  if (!isAbsolutePath(posix)) return posix;
  if (isUnder(posix, scope.workspaceDir)) return posix.slice(scope.workspaceDir.length + 1);
  if (isUnder(posix, scope.researchRoot) && isUnder(scope.workspaceDir, scope.researchRoot)) {
    return relativeTo(scope.workspaceDir, posix);
  }
  return baseName(posix);
}

function shareableUrl(url: string, scope: PathScope): string {
  if (/^file:/i.test(url)) {
    let path = url.replace(/^file:(\/\/[^/]*)?/i, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      // 不是合法的百分号编码时按原样当路径用
    }
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    return shareablePath(path, scope);
  }
  return isAbsolutePath(toPosix(url)) ? shareablePath(url, scope) : url;
}

function colorToCss(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const alpha = typeof value.a === "number" ? value.a : 1;
  if (!(alpha > 0)) return null;
  const hex = (channel: number) =>
    Math.round(Math.min(255, Math.max(0, channel)))
      .toString(16)
      .padStart(2, "0");
  const rgb = `#${hex(asNumber(value.r))}${hex(asNumber(value.g))}${hex(asNumber(value.b))}`;
  return alpha >= 1 ? rgb : `${rgb}${hex(alpha * 255)}`;
}

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH)}…` : line;
}

function oneLine(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

function workspaceNameOf(file: string): string {
  return file.replace(/\.prg$/i, "");
}

function readWorkspaceId(metadata: unknown): string {
  if (!isRecord(metadata) || !isRecord(metadata.workbench)) return "";
  return asString(metadata.workbench.id);
}

function isFileKind(value: unknown): value is FileKind {
  return typeof value === "string" && value in FILE_KIND_EXTENSIONS;
}

/**
 * 把 serialize(project.stage) 的结果转成 AI 读的 JSON 和 Markdown。
 * 纯函数：不调 DetailsManager（命令行里是空壳），不读设置，不放附件内容，不放绝对路径，也不改输入。
 *
 * @param input.workspaceFile 工作区 .prg 的绝对路径（用来把文件夹里的绝对路径改成相对路径）；只给文件名也行
 * @param input.researchRoot 研究文件夹的绝对路径；文件卡片指向研究文件夹里别的子文件夹时，靠它写出带 ../ 的相对路径
 * @param input.readme Project.readme，工作区的研究问题，写在 Markdown 开头
 * @param input.savedAt 默认当前时间
 */
export function buildAiSidecar(input: {
  serializedStage: unknown[];
  tags?: unknown;
  metadata?: unknown;
  workspaceFile: string;
  researchRoot?: string;
  readme?: string;
  savedAt?: string;
}): { json: ResearchSidecar; markdown: string } {
  const root = input.serializedStage;
  const scope: PathScope = {
    workspaceDir: normalizedDir(dirName(input.workspaceFile)),
    researchRoot: normalizedDir(input.researchRoot ?? ""),
  };
  const workspaceFileName = baseName(input.workspaceFile);

  const objects = new Map<string, SerializedObject>();
  const collect = (value: unknown) => {
    const object = deref(root, value);
    if (!isSerializedObject(object)) return;
    const uuid = asString(object.uuid);
    if (!uuid || objects.has(uuid)) return;
    objects.set(uuid, object);
    // 实体一般都在顶层数组里有一格；这里再顺着引用走一遍，防止有只出现在框或连线里的对象
    if (Array.isArray(object.children)) object.children.forEach(collect);
    if (Array.isArray(object.associationList)) object.associationList.forEach(collect);
  };
  root.forEach(collect);

  const idOf = (value: unknown): string => {
    const object = deref(root, value);
    return isRecord(object) ? asString(object.uuid) : "";
  };

  const rectOf = (object: SerializedObject): ResearchSidecarRect => {
    const box = deref(root, object.collisionBox ?? object._collisionBoxNormal);
    const shapes = isRecord(box) && Array.isArray(box.shapes) ? box.shapes : [];
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const shape of shapes) {
      if (!isRecord(shape) || !isRecord(shape.location) || !isRecord(shape.size)) continue;
      const x = asNumber(shape.location.x);
      const y = asNumber(shape.location.y);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + asNumber(shape.size.x));
      bottom = Math.max(bottom, y + asNumber(shape.size.y));
    }
    if (left === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
  };

  const parentSectionOf = new Map<string, string>();
  for (const object of objects.values()) {
    if (object._ !== "Section" || !Array.isArray(object.children)) continue;
    for (const child of object.children) {
      const childId = idOf(child);
      if (childId && !parentSectionOf.has(childId)) parentSectionOf.set(childId, asString(object.uuid));
    }
  }

  const cards: ResearchSidecarCard[] = [];
  const sections: ResearchSidecarSection[] = [];
  const edges: ResearchSidecarEdge[] = [];
  const hyperedges: ResearchSidecarHyperedge[] = [];

  for (const [uuid, object] of objects) {
    const type = object._;
    if (SKIPPED_TYPES.has(type)) continue;
    const sectionId = parentSectionOf.get(uuid);

    if (Array.isArray(object.associationList)) {
      const members = object.associationList.map(idOf).filter((id) => id !== "");
      const label = asString(object.text);
      if (HYPEREDGE_TYPES.has(type)) {
        hyperedges.push({ id: uuid, members, label });
      } else if (members.length >= 2) {
        const edge: ResearchSidecarEdge = { id: uuid, type, from: members[0], to: members[1], label };
        if (typeof object.lineType === "string") edge.lineType = object.lineType;
        if (typeof object.arrowType === "string") edge.arrowType = object.arrowType;
        edges.push(edge);
      }
      continue;
    }

    if (type === "Section") {
      sections.push({
        id: uuid,
        title: asString(object.text),
        children: Array.isArray(object.children) ? object.children.map(idOf).filter((id) => id !== "") : [],
        notes: plateToPlainText(object.details),
        rect: rectOf(object),
        ...(sectionId ? { sectionId } : {}),
        color: colorToCss(object.color),
      });
      continue;
    }

    const card: ResearchSidecarCard = {
      id: uuid,
      type,
      title: "",
      text: "",
      notes: plateToPlainText(object.details),
      rect: rectOf(object),
      ...(sectionId ? { sectionId } : {}),
      color: colorToCss(object.color),
    };
    switch (type) {
      case "FileCardNode": {
        const path = shareablePath(asString(object.sourcePath), scope);
        const kind = isFileKind(object.fileKind) ? object.fileKind : (fileKindOf(path) ?? "pdf");
        // 用户给图片填的标题比文件名更能说明内容
        card.title = asString(object.caption) || asString(object.title) || baseName(path);
        card.text = asString(object.excerpt);
        card.file = { path, kind, pages: asNumber(object.pageCount) };
        break;
      }
      case "UrlNode":
        card.title = asString(object.title);
        card.url = shareableUrl(asString(object.url), scope);
        break;
      case "ImageNode":
        // 图片只留说明（备注），不放图片内容
        break;
      case "LatexNode":
        card.text = asString(object.latexSource);
        card.title = firstLine(card.text);
        break;
      case "ReferenceBlockNode":
        card.text = [baseName(asString(object.fileName)), asString(object.sectionName)].filter(Boolean).join(" / ");
        card.title = card.text;
        break;
      case "MediaNode":
        card.title = asString(object.title);
        break;
      case "ExtensionEntity":
        card.title = asString(object.typeName);
        break;
      default:
        card.text = asString(object.text) || asString(object.title);
        card.title = firstLine(card.text);
    }
    cards.push(card);
  }

  const tags: ResearchSidecarTag[] = [];
  if (Array.isArray(input.tags)) {
    for (const tagId of input.tags) {
      if (typeof tagId !== "string") continue;
      const card = cards.find((item) => item.id === tagId);
      const section = card ? undefined : sections.find((item) => item.id === tagId);
      if (card || section) tags.push({ id: tagId, title: card?.title || section?.title || "" });
    }
  }

  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const json: ResearchSidecar = {
    schema: RESEARCH_SIDECAR_SCHEMA,
    workspace: {
      file: workspaceFileName,
      id: readWorkspaceId(metadata),
      savedAt: input.savedAt ?? new Date().toISOString(),
      prgVersion: asString(metadata.version),
    },
    cards,
    sections,
    edges,
    hyperedges,
    tags,
  };
  return { json, markdown: buildSidecarMarkdown(json, input.readme) };
}

function cardLabel(card: ResearchSidecarCard): string {
  if (card.file) return FILE_KIND_LABELS[card.file.kind];
  return TYPE_LABELS[card.type] ?? card.type;
}

function buildSidecarMarkdown(json: ResearchSidecar, readme?: string): string {
  const cardById = new Map(json.cards.map((card) => [card.id, card]));
  const sectionById = new Map(json.sections.map((section) => [section.id, section]));
  const listedCards = (cards: (ResearchSidecarCard | undefined)[]) =>
    cards.filter((card): card is ResearchSidecarCard => card !== undefined && card.type !== "ConnectPoint");

  const nameOf = (id: string): string => {
    const card = cardById.get(id);
    if (card) return card.title || `[${cardLabel(card)}]`;
    const section = sectionById.get(id);
    if (section) return section.title || `[${TYPE_LABELS.Section}]`;
    return `[${id.slice(0, 8)}]`;
  };

  const cardLine = (card: ResearchSidecarCard): string => {
    const parts: string[] = [];
    if (card.file) parts.push(card.file.pages > 0 ? `${card.file.path}，${card.file.pages} 页` : card.file.path);
    if (card.url) parts.push(card.url);
    const summary = card.text && card.text.trim() !== card.title ? oneLine(card.text, MARKDOWN_SUMMARY_MAX_LENGTH) : "";
    if (summary) parts.push(`摘要：${summary}`);
    if (card.notes) parts.push(`备注：${oneLine(card.notes, MARKDOWN_NOTES_MAX_LENGTH)}`);
    const head = `- [${cardLabel(card)}] ${card.title || "（无标题）"}`;
    return parts.length > 0 ? `${head} — ${parts.join("；")}` : head;
  };

  const lines: string[] = [`# ${workspaceNameOf(json.workspace.file)}`, ""];
  const question = readme?.trim();
  if (question) lines.push("## 研究问题", "", question, "");

  const renderSection = (section: ResearchSidecarSection, level: number, visited: Set<string>) => {
    if (visited.has(section.id)) return;
    visited.add(section.id);
    lines.push(`${"#".repeat(Math.min(level, 6))} ${section.title || "（未命名分组）"}`, "");
    if (section.notes) lines.push(`> ${oneLine(section.notes, MARKDOWN_NOTES_MAX_LENGTH)}`, "");
    const childCards = listedCards(section.children.map((id) => cardById.get(id)));
    if (childCards.length > 0) lines.push(...childCards.map(cardLine), "");
    for (const childId of section.children) {
      const child = sectionById.get(childId);
      if (child) renderSection(child, level + 1, visited);
    }
  };
  const visited = new Set<string>();
  for (const section of json.sections) {
    if (!section.sectionId || !sectionById.has(section.sectionId)) renderSection(section, 2, visited);
  }

  const ungrouped = listedCards(json.cards.filter((card) => !card.sectionId || !sectionById.has(card.sectionId)));
  if (ungrouped.length > 0) {
    lines.push(json.sections.length > 0 ? "## 未分组" : "## 卡片", "", ...ungrouped.map(cardLine), "");
  }

  if (json.edges.length > 0) {
    lines.push("## 连线", "");
    for (const edge of json.edges) {
      const arrow = edge.label ? ` —${oneLine(edge.label, MARKDOWN_SUMMARY_MAX_LENGTH)}→ ` : " → ";
      lines.push(`- ${nameOf(edge.from)}${arrow}${nameOf(edge.to)}`);
    }
    lines.push("");
  }

  if (json.hyperedges.length > 0) {
    lines.push("## 多端连线", "");
    for (const hyperedge of json.hyperedges) {
      const members = hyperedge.members.map(nameOf).join("、");
      lines.push(
        hyperedge.label ? `- ${oneLine(hyperedge.label, MARKDOWN_SUMMARY_MAX_LENGTH)}：${members}` : `- ${members}`,
      );
    }
    lines.push("");
  }

  if (json.tags.length > 0) {
    lines.push("## 标签", "", ...json.tags.map((tag) => `- ${tag.title || nameOf(tag.id)}`), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
